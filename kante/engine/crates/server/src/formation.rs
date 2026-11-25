//! `GET /api/formation?evu=SBBP&date=2026-11-24&train=1083`: a train's formation (its coaches in order, the sectors
//! each one stands in at every stop, 1st and 2nd class, wheelchair and bike spaces, closed coaches), from the Train
//! Formation Service of opentransportdata.swiss (`formation/v2/formations_full`), passed on as it comes.
//!
//! The key stays on the server: `KANTE_OTD_FORMATION_KEY`, or `"formation"` in `data/secrets/otd.json`. It is a
//! subscription of its own in the API manager (the SIRI-ET key does not open it). Without one the endpoint answers
//! 503 and the app shows the train from the timetable's sectors alone.
//!
//! The service has today and up to three days ahead. Its plan allows 50 calls a minute and 20,000 a day: answers
//! are kept for three minutes (ten when there is none), requests for the same train at once share one call, and no
//! more than `PER_MINUTE` calls go out in a minute and `PER_DAY` in a day.

use crate::state::App;
use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use parking_lot::Mutex;
use serde::Deserialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

const URL: &str = "https://api.opentransportdata.swiss/formation/v2/formations_full";
const KEEP: Duration = Duration::from_secs(180);
const KEEP_NONE: Duration = Duration::from_secs(600);
const PER_MINUTE: usize = 30;
/// Below the plan's 20,000 a day, with room for the odd retry.
const PER_DAY: usize = 18_000;
const MAX_KEPT: usize = 4000;
/// The railways the service has (`evu` in its OpenAPI description; SZU since 9 November 2026).
const EVUS: &[&str] = &["BLSP", "SBBP", "MBC", "OeBB", "RhB", "SOB", "THURBO", "TPF", "TRN", "VDBB", "ZB", "SZU"];

#[derive(Deserialize)]
pub struct FormationParams {
    evu: String,
    date: String,
    train: String,
}

#[derive(Clone)]
struct Kept {
    at: Instant,
    status: StatusCode,
    body: Arc<Vec<u8>>,
}

/// What one call to the service came to: an answer to keep (a formation, or that there is none), or a failure.
#[derive(Clone)]
enum Outcome {
    Kept(Kept),
    Failed(StatusCode, &'static str),
}

#[derive(Default)]
struct Cache {
    kept: HashMap<String, Kept>,
    /// Trains being asked for now: who asks for the same one meanwhile waits for that answer.
    asking: HashMap<String, Arc<tokio::sync::OnceCell<Outcome>>>,
    sent: VecDeque<Instant>,
    /// When the day's count began, and the calls since.
    day: Option<(Instant, usize)>,
}

fn cache() -> &'static Mutex<Cache> {
    static C: OnceLock<Mutex<Cache>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Cache::default()))
}

fn agent() -> &'static ureq::Agent {
    static A: OnceLock<ureq::Agent> = OnceLock::new();
    A.get_or_init(|| {
        let config = ureq::Agent::config_builder()
            .user_agent(kante_rt::fetch::USER_AGENT)
            .http_status_as_error(false)
            .redirect_auth_headers(ureq::config::RedirectAuthHeaders::SameHost)
            .timeout_connect(Some(Duration::from_secs(8)))
            .timeout_global(Some(Duration::from_secs(20)))
            .build();
        ureq::Agent::new_with_config(config)
    })
}

fn error(status: StatusCode, msg: &str) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], axum::Json(serde_json::json!({ "error": msg }))).into_response()
}

fn answer(k: &Kept) -> Response {
    let keep = if k.status == StatusCode::OK { KEEP } else { KEEP_NONE };
    let age = keep.saturating_sub(k.at.elapsed()).as_secs().max(1);
    (
        k.status,
        [(header::CONTENT_TYPE, "application/json".to_string()), (header::CACHE_CONTROL, format!("public, max-age={age}"))],
        k.body.as_ref().clone(),
    )
        .into_response()
}

/// "2026-11-24".
fn is_date(s: &str) -> bool {
    day_number(s).is_some()
}

/// "2026-11-24" → days since 1970-01-01, for a date that exists; None otherwise.
fn day_number(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if !(b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())) {
        return None;
    }
    let (y, m, d): (i64, i64, i64) = (s[0..4].parse().ok()?, s[5..7].parse().ok()?, s[8..10].parse().ok()?);
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days_in = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !(1..=12).contains(&m) || d < 1 || d > days_in[(m - 1) as usize] {
        return None;
    }
    // days from civil (Howard Hinnant's algorithm)
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// The service has the operating day of today and up to three days ahead; a day either side is let through for
/// trains after midnight and the time zone (the service answers those with nothing, which is kept).
fn in_window(day: i64) -> bool {
    let today = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64 / 86_400).unwrap_or(0);
    (today - 1..=today + 4).contains(&day)
}

pub async fn formation(State(app): State<Arc<App>>, Query(p): Query<FormationParams>) -> Response {
    let Some(evu) = EVUS.iter().find(|e| e.eq_ignore_ascii_case(p.evu.trim())) else {
        return error(StatusCode::BAD_REQUEST, "unknown evu");
    };
    let train = p.train.trim().trim_start_matches('0');
    if train.is_empty() || train.len() > 6 || !train.bytes().all(|c| c.is_ascii_digit()) {
        return error(StatusCode::BAD_REQUEST, "train: a train number");
    }
    let Some(day) = day_number(p.date.trim()) else {
        return error(StatusCode::BAD_REQUEST, "date: YYYY-MM-DD");
    };
    if !in_window(day) {
        // not asked for: the service has only these days, and the call would count against its quota
        return (StatusCode::NOT_FOUND, [(header::CACHE_CONTROL, "public, max-age=600")], axum::Json(serde_json::json!({ "error": "no formation for this day" }))).into_response();
    }
    let date = p.date.trim().to_string();
    let id = format!("{evu}/{date}/{train}");
    // kept, or already being asked for (one call to the service for all who ask at once)
    let cell = {
        let mut c = cache().lock();
        if let Some(k) = c.kept.get(&id) {
            let keep = if k.status == StatusCode::OK { KEEP } else { KEEP_NONE };
            if k.at.elapsed() < keep {
                return answer(k);
            }
        }
        c.asking.entry(id.clone()).or_insert_with(|| Arc::new(tokio::sync::OnceCell::new())).clone()
    };
    let (evu, train) = (evu.to_string(), train.to_string());
    let got = cell.get_or_init(|| ask(app, evu, date, train)).await.clone();
    let mut c = cache().lock();
    if c.asking.get(&id).is_some_and(|x| Arc::ptr_eq(x, &cell)) {
        c.asking.remove(&id);
        if let Outcome::Kept(k) = &got {
            if c.kept.len() >= MAX_KEPT {
                c.kept.retain(|_, k| k.at.elapsed() < KEEP_NONE);
            }
            c.kept.insert(id, k.clone());
        }
    }
    match got {
        Outcome::Kept(k) => answer(&k),
        Outcome::Failed(status, msg) => error(status, msg),
    }
}

/// One call to the service, within the minute's and the day's budget.
async fn ask(app: Arc<App>, evu: String, date: String, train: String) -> Outcome {
    let Some(key) = crate::live::secret(&app, "KANTE_OTD_FORMATION_KEY", "formation") else {
        return Outcome::Failed(StatusCode::SERVICE_UNAVAILABLE, "no key for the Train Formation Service on this server");
    };
    {
        let mut c = cache().lock();
        let now = Instant::now();
        while c.sent.front().is_some_and(|t| now.duration_since(*t) > Duration::from_secs(60)) {
            c.sent.pop_front();
        }
        if c.day.is_none_or(|(start, _)| now.duration_since(start) > Duration::from_secs(86_400)) {
            c.day = Some((now, 0));
        }
        if c.sent.len() >= PER_MINUTE {
            return Outcome::Failed(StatusCode::TOO_MANY_REQUESTS, "too many formation requests this minute");
        }
        if c.day.is_some_and(|(_, n)| n >= PER_DAY) {
            return Outcome::Failed(StatusCode::TOO_MANY_REQUESTS, "the formation requests of the day are used up");
        }
        c.sent.push_back(now);
        if let Some((_, n)) = c.day.as_mut() {
            *n += 1;
        }
    }
    let got = tokio::task::spawn_blocking(move || -> Result<(u16, Vec<u8>), String> {
        let resp = agent()
            .get(URL)
            .query("evu", &evu)
            .query("operationDate", &date)
            .query("trainNumber", &train)
            .header("Authorization", format!("Bearer {}", key.trim()))
            .header("Accept", "application/json")
            .call()
            .map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let body = resp.into_body().into_with_config().limit(16 << 20).read_to_vec().map_err(|e| e.to_string())?;
        Ok((status, body))
    })
    .await;
    let (status, body) = match got {
        Ok(Ok(x)) => x,
        Ok(Err(e)) => {
            eprintln!("formation: {e}");
            return Outcome::Failed(StatusCode::BAD_GATEWAY, "the Train Formation Service could not be reached");
        }
        Err(_) => return Outcome::Failed(StatusCode::INTERNAL_SERVER_ERROR, "the formation request failed"),
    };
    match status {
        200 if !body.is_empty() => Outcome::Kept(Kept { at: Instant::now(), status: StatusCode::OK, body: Arc::new(body) }),
        // no formation for this train (not one of the railway's, not in the days the service has, or not planned yet)
        200 | 204 | 400 | 404 => Outcome::Kept(Kept { at: Instant::now(), status: StatusCode::NOT_FOUND, body: Arc::new(br#"{"error":"no formation for this train"}"#.to_vec()) }),
        401 | 403 => {
            eprintln!("formation: HTTP {status}: the key was refused (is it subscribed to the Train Formation Service?)");
            Outcome::Failed(StatusCode::SERVICE_UNAVAILABLE, "the server's key for the Train Formation Service was refused")
        }
        429 => Outcome::Failed(StatusCode::TOO_MANY_REQUESTS, "the Train Formation Service's quota is used up"),
        s => {
            eprintln!("formation: HTTP {s}");
            Outcome::Failed(StatusCode::BAD_GATEWAY, "the Train Formation Service answered with an error")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert!(is_date("2026-11-24"));
        assert!(!is_date("2026-1-24"));
        assert!(!is_date("2026/11/24"));
        assert!(!is_date("today"));
        assert!(!is_date("2026-99-99"));
        assert!(!is_date("2026-02-29"));
        assert!(is_date("2028-02-29"));
    }

    #[test]
    fn day_numbers() {
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(day_number("2026-11-24"), Some(20_781));
        assert!(!in_window(day_number("2020-01-01").unwrap()));
    }
}
