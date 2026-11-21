//! Polling opentransportdata.swiss.
//!
//! Both feeds are plain `GET`s with `Authorization: Bearer <key>`; the key is
//! personal (one per subscribed API in the API manager) and must be supplied
//! by the operator of the server. Limits of the free plan (2026-11):
//!
//! | Feed | Path | Limit | Default here |
//! |---|---|---|---|
//! | SIRI-ET | `/la/siri-et` | 2 requests/minute, 3,000/day; data up to 90 s old | every 60 s |
//! | GTFS-RT | `/la/gtfs-rt` | 2/minute (cookbook) or 5/minute (limits page); cached 30 s | every 32 s |
//!
//! [`Poller`] keeps to these limits and backs off on errors; it is a small
//! state machine with an injected clock so that the server can drive it from a
//! background thread (`Poller::run`) and tests can drive it without sleeping.

use crate::model::FeedKind;
use std::collections::VecDeque;
use std::fmt;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub const DEFAULT_BASE_URL: &str = "https://api.opentransportdata.swiss";
pub const USER_AGENT: &str = "kante-prototype/0.1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// No key configured; no request was sent.
    MissingKey,
    /// The key contains characters that cannot go into a header; no request was sent.
    InvalidKey,
    /// HTTP 401: the key is missing, mistyped or expired.
    Unauthorized,
    /// HTTP 403: the key is valid but not subscribed to this API.
    Forbidden,
    /// HTTP 429: quota exceeded. `retry_after` is the server's `Retry-After`, if sent.
    RateLimited { retry_after: Option<Duration> },
    /// Any other non-2xx status.
    Status(u16),
    /// DNS, TLS, connection, timeout or body errors.
    Transport(String),
}

impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FetchError::MissingKey => write!(f, "no API key configured for opentransportdata.swiss; real-time data is off"),
            FetchError::InvalidKey => write!(f, "the API key contains characters that are not allowed in an HTTP header"),
            FetchError::Unauthorized => {
                write!(f, "HTTP 401 Unauthorized: the API key was rejected (missing, mistyped or expired)")
            }
            FetchError::Forbidden => write!(
                f,
                "HTTP 403 Forbidden: the API key is not subscribed to this API (each API needs its own subscription in the API manager)"
            ),
            FetchError::RateLimited { retry_after: Some(d) } => {
                write!(f, "HTTP 429 Too Many Requests: quota exceeded, retry after {} s", d.as_secs())
            }
            FetchError::RateLimited { retry_after: None } => write!(f, "HTTP 429 Too Many Requests: quota exceeded"),
            FetchError::Status(code) => write!(f, "unexpected HTTP status {code}"),
            FetchError::Transport(e) => write!(f, "transport error: {e}"),
        }
    }
}

impl std::error::Error for FetchError {}

impl FetchError {
    /// The key itself is the problem; retrying soon cannot help.
    pub fn is_auth(&self) -> bool {
        matches!(self, FetchError::MissingKey | FetchError::InvalidKey | FetchError::Unauthorized | FetchError::Forbidden)
    }
}

/// HTTP client for the two feeds. Cheap to clone (shares the connection pool).
#[derive(Clone)]
pub struct Fetcher {
    agent: ureq::Agent,
    base_url: String,
    max_body: u64,
}

impl Default for Fetcher {
    fn default() -> Self {
        Self::new()
    }
}

impl Fetcher {
    pub fn new() -> Self {
        Self::with_base_url(DEFAULT_BASE_URL)
    }

    /// Use another host (tests, a caching proxy). No trailing slash needed.
    pub fn with_base_url(base_url: &str) -> Self {
        let config = ureq::Agent::config_builder()
            .user_agent(USER_AGENT)
            // We map statuses ourselves to keep `Retry-After`.
            .http_status_as_error(false)
            .max_redirects(5)
            // The platform asks clients to follow redirects; keep the bearer
            // token only when the redirect stays on the same host.
            .redirect_auth_headers(ureq::config::RedirectAuthHeaders::SameHost)
            .timeout_connect(Some(Duration::from_secs(15)))
            .timeout_global(Some(Duration::from_secs(180)))
            .build();
        Fetcher { agent: ureq::Agent::new_with_config(config), base_url: base_url.trim_end_matches('/').to_string(), max_body: 1 << 30 }
    }

    pub fn url(&self, kind: FeedKind) -> String {
        format!("{}{}", self.base_url, kind.path())
    }

    fn request(&self, kind: FeedKind, api_key: &str) -> Result<ureq::Body, FetchError> {
        let key = api_key.trim();
        if key.is_empty() {
            return Err(FetchError::MissingKey);
        }
        if !key.bytes().all(|b| (0x21..0x7f).contains(&b)) {
            return Err(FetchError::InvalidKey);
        }
        // `Accept-Encoding: gzip` is added by ureq, which also unpacks the body.
        let resp = self
            .agent
            .get(self.url(kind))
            .header("Authorization", format!("Bearer {key}"))
            .header("Accept", match kind {
                FeedKind::SiriEt => "application/xml",
                FeedKind::GtfsRt => "application/octet-stream",
            })
            .call()
            .map_err(|e| FetchError::Transport(e.to_string()))?;
        let status = resp.status().as_u16();
        match status {
            200..=299 => Ok(resp.into_body()),
            401 => Err(FetchError::Unauthorized),
            403 => Err(FetchError::Forbidden),
            429 => {
                let retry_after = resp
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.trim().parse::<u64>().ok())
                    .map(Duration::from_secs);
                Err(FetchError::RateLimited { retry_after })
            }
            code => Err(FetchError::Status(code)),
        }
    }

    /// Download one feed document completely (already un-gzipped).
    pub fn fetch(&self, kind: FeedKind, api_key: &str) -> Result<Vec<u8>, FetchError> {
        let body = self.request(kind, api_key)?;
        body.into_with_config().limit(self.max_body).read_to_vec().map_err(|e| FetchError::Transport(e.to_string()))
    }

    /// Open one feed document as a stream (already un-gzipped), so that the
    /// 60–150 MB of SIRI-ET can be parsed while they arrive:
    /// `parse_siri_et(BufReader::new(fetcher.open(..)?), sink)`.
    pub fn open(&self, kind: FeedKind, api_key: &str) -> Result<Box<dyn Read + Send + Sync>, FetchError> {
        let body = self.request(kind, api_key)?;
        Ok(Box::new(body.into_with_config().limit(self.max_body).reader()))
    }
}

fn default_fetcher() -> &'static Fetcher {
    static F: OnceLock<Fetcher> = OnceLock::new();
    F.get_or_init(Fetcher::new)
}

/// Blocking fetch with gzip; `kind` selects the endpoint. The error is a
/// [`FetchError`] (downcast to tell 401/403/429 apart).
pub fn fetch(kind: FeedKind, api_key: &str) -> anyhow::Result<Vec<u8>> {
    Ok(default_fetcher().fetch(kind, api_key)?)
}

/// How often a feed may be polled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PollPolicy {
    /// Time between the starts of two successful polls.
    pub interval: Duration,
    /// Hard floor between any two requests (the per-minute limit).
    pub min_interval: Duration,
    /// Requests allowed in any 24 h window.
    pub max_per_day: u32,
    /// Ceiling for the error backoff, also used when the key is rejected.
    pub max_backoff: Duration,
}

impl PollPolicy {
    pub fn for_kind(kind: FeedKind) -> Self {
        match kind {
            // 2 requests/minute and 3,000/day → never closer than 30 s; one
            // poll a minute (1,440/day) leaves room for restarts and retries.
            FeedKind::SiriEt => PollPolicy {
                interval: Duration::from_secs(60),
                min_interval: Duration::from_secs(30),
                max_per_day: 3000,
                max_backoff: Duration::from_secs(900),
            },
            // The feed is regenerated every 30 s; 32 s respects both documented limits.
            FeedKind::GtfsRt => PollPolicy {
                interval: Duration::from_secs(32),
                min_interval: Duration::from_secs(30),
                max_per_day: 2800,
                max_backoff: Duration::from_secs(900),
            },
        }
    }
}

const DAY: Duration = Duration::from_secs(86_400);

/// Rate limiter and backoff for one feed.
///
/// ```no_run
/// # use kante_rt::{FeedKind, Fetcher, Poller};
/// # let stop = std::sync::atomic::AtomicBool::new(false);
/// let mut poller = Poller::new(FeedKind::SiriEt);
/// poller.run(&Fetcher::new(), "key", &stop, |bytes| { /* parse, match, swap snapshot */ }, |err| eprintln!("{err}"));
/// ```
#[derive(Debug)]
pub struct Poller {
    kind: FeedKind,
    policy: PollPolicy,
    /// Start times of the requests of the last 24 h.
    sent: VecDeque<Instant>,
    /// Earliest time for the next request as decided by the last outcome.
    next_at: Option<Instant>,
    failures: u32,
    last_error: Option<FetchError>,
}

impl Poller {
    pub fn new(kind: FeedKind) -> Self {
        Self::with_policy(kind, PollPolicy::for_kind(kind))
    }

    pub fn with_policy(kind: FeedKind, mut policy: PollPolicy) -> Self {
        policy.interval = policy.interval.max(policy.min_interval);
        policy.max_backoff = policy.max_backoff.max(policy.interval);
        Poller { kind, policy, sent: VecDeque::new(), next_at: None, failures: 0, last_error: None }
    }

    pub fn kind(&self) -> FeedKind {
        self.kind
    }
    pub fn policy(&self) -> &PollPolicy {
        &self.policy
    }
    /// Consecutive failed polls.
    pub fn failures(&self) -> u32 {
        self.failures
    }
    pub fn last_error(&self) -> Option<&FetchError> {
        self.last_error.as_ref()
    }
    /// The last poll failed because of the key (401/403/missing).
    pub fn auth_failed(&self) -> bool {
        self.last_error.as_ref().is_some_and(FetchError::is_auth)
    }

    /// How long to wait at `now` before the next request may be sent.
    pub fn wait(&self, now: Instant) -> Duration {
        let mut at = self.next_at.unwrap_or(now);
        if let Some(&last) = self.sent.back() {
            at = at.max(last + self.policy.min_interval);
        }
        // Daily budget: with `max_per_day` requests inside the last 24 h, the
        // next one has to wait until the oldest of them leaves the window.
        let in_window = self.sent.iter().filter(|&&t| now.saturating_duration_since(t) < DAY).count();
        if in_window >= self.policy.max_per_day as usize && self.policy.max_per_day > 0 {
            let oldest = self.sent[self.sent.len() - self.policy.max_per_day as usize];
            at = at.max(oldest + DAY);
        }
        at.saturating_duration_since(now)
    }

    /// Record that a request is being sent at `now`.
    pub fn on_request(&mut self, now: Instant) {
        while self.sent.front().is_some_and(|&t| now.saturating_duration_since(t) >= DAY) {
            self.sent.pop_front();
        }
        self.sent.push_back(now);
    }

    /// Record the outcome of the request started at `started` and schedule the next one.
    pub fn on_result(&mut self, started: Instant, now: Instant, result: Result<(), &FetchError>) {
        let p = &self.policy;
        match result {
            Ok(()) => {
                self.failures = 0;
                self.last_error = None;
                // Fixed cadence measured from the start of the request, so a
                // slow download does not stretch the period.
                self.next_at = Some(started + p.interval);
            }
            Err(e) => {
                self.failures += 1;
                let exp = p.interval.saturating_mul(1u32 << self.failures.min(8)).min(p.max_backoff);
                let delay = match e {
                    // A rejected key stays rejected: slowest pace.
                    e if e.is_auth() => p.max_backoff,
                    // Over quota: at least a full minute so the sliding window clears.
                    FetchError::RateLimited { retry_after } => {
                        retry_after.unwrap_or(Duration::ZERO).max(exp).max(Duration::from_secs(60)).min(DAY)
                    }
                    _ => exp,
                };
                self.next_at = Some(now + delay);
                self.last_error = Some(e.clone());
            }
        }
    }

    /// Wait until a request is allowed (checking `stop` four times a second),
    /// fetch once and record the outcome. `None` when stopped while waiting.
    pub fn poll_once(&mut self, fetcher: &Fetcher, api_key: &str, stop: &AtomicBool) -> Option<Result<Vec<u8>, FetchError>> {
        loop {
            if stop.load(Ordering::Relaxed) {
                return None;
            }
            let wait = self.wait(Instant::now());
            if wait.is_zero() {
                break;
            }
            std::thread::sleep(wait.min(Duration::from_millis(250)));
        }
        let started = Instant::now();
        self.on_request(started);
        let res = fetcher.fetch(self.kind, api_key);
        self.on_result(started, Instant::now(), res.as_ref().map(|_| ()));
        Some(res)
    }

    /// Poll until `stop` is set. Meant to be the body of a background thread.
    pub fn run(
        &mut self,
        fetcher: &Fetcher,
        api_key: &str,
        stop: &AtomicBool,
        mut on_data: impl FnMut(Vec<u8>),
        mut on_error: impl FnMut(&FetchError),
    ) {
        while let Some(res) = self.poll_once(fetcher, api_key, stop) {
            match res {
                Ok(bytes) => on_data(bytes),
                Err(e) => on_error(&e),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    /// A throwaway HTTP/1.1 server on localhost: answers each connection with
    /// the next canned response and reports the request head it received.
    fn serve(responses: Vec<Vec<u8>>) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for resp in responses {
                let Ok((mut sock, _)) = listener.accept() else { return };
                let mut head = String::new();
                let mut r = BufReader::new(sock.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    if r.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    head.push_str(&line);
                }
                let _ = tx.send(head);
                let _ = sock.write_all(&resp);
                let _ = sock.flush();
            }
        });
        (format!("http://{addr}"), rx)
    }

    fn response(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut out = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n", body.len()).into_bytes();
        for (k, v) in headers {
            out.extend_from_slice(format!("{k}: {v}\r\n").as_bytes());
        }
        out.extend_from_slice(b"\r\n");
        out.extend_from_slice(body);
        out
    }

    fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
        head.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case(name).then_some(v.trim())
        })
    }

    #[test]
    fn request_shape_and_gzip() {
        let xml = b"<Siri><ServiceDelivery/></Siri>".repeat(100);
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(&xml).unwrap();
        let gz = enc.finish().unwrap();
        let (base, rx) = serve(vec![
            response("200 OK", &[("Content-Encoding", "gzip"), ("Content-Type", "application/xml")], &gz),
            response("200 OK", &[], b"\x0a\x00"),
        ]);
        let f = Fetcher::with_base_url(&format!("{base}/"));
        assert_eq!(f.url(FeedKind::SiriEt), format!("{base}/la/siri-et"));

        let body = f.fetch(FeedKind::SiriEt, " secret-key-123\n").unwrap();
        assert_eq!(body, xml, "gzip body is unpacked");
        let head = rx.recv().unwrap();
        assert!(head.starts_with("GET /la/siri-et HTTP/1.1\r\n"), "{head}");
        assert_eq!(header(&head, "authorization"), Some("Bearer secret-key-123"));
        assert_eq!(header(&head, "user-agent"), Some(USER_AGENT));
        assert!(header(&head, "accept-encoding").unwrap().contains("gzip"));

        let mut body = Vec::new();
        f.open(FeedKind::GtfsRt, "k").unwrap().read_to_end(&mut body).unwrap();
        assert_eq!(body, b"\x0a\x00");
        assert!(rx.recv().unwrap().starts_with("GET /la/gtfs-rt HTTP/1.1\r\n"));
    }

    #[test]
    fn status_mapping() {
        let (base, _rx) = serve(vec![
            response("401 Unauthorized", &[], b"no"),
            response("403 Forbidden", &[], b"no"),
            response("429 Too Many Requests", &[("Retry-After", "17")], b"slow down"),
            response("429 Too Many Requests", &[], b""),
            response("503 Service Unavailable", &[], b""),
        ]);
        let f = Fetcher::with_base_url(&base);
        let get = || f.fetch(FeedKind::SiriEt, "k").unwrap_err();
        assert_eq!(get(), FetchError::Unauthorized);
        assert_eq!(get(), FetchError::Forbidden);
        assert_eq!(get(), FetchError::RateLimited { retry_after: Some(Duration::from_secs(17)) });
        assert_eq!(get(), FetchError::RateLimited { retry_after: None });
        assert_eq!(get(), FetchError::Status(503));
        // Server gone: a transport error, not a panic.
        assert!(matches!(get(), FetchError::Transport(_)));
        assert!(FetchError::Unauthorized.to_string().contains("401"));
        assert!(FetchError::Forbidden.to_string().contains("403"));
        assert!(FetchError::RateLimited { retry_after: Some(Duration::from_secs(17)) }.to_string().contains("17 s"));
    }

    #[test]
    fn redirect_keeps_the_token_on_the_same_host() {
        let (base, rx) = serve(vec![response("302 Found", &[("Location", "/v2/siri-et")], b""), response("200 OK", &[], b"ok")]);
        let f = Fetcher::with_base_url(&base);
        assert_eq!(f.fetch(FeedKind::SiriEt, "k").unwrap(), b"ok");
        assert!(rx.recv().unwrap().starts_with("GET /la/siri-et "));
        let second = rx.recv().unwrap();
        assert!(second.starts_with("GET /v2/siri-et "), "{second}");
        assert_eq!(header(&second, "authorization"), Some("Bearer k"));
    }

    #[test]
    fn no_request_without_a_usable_key() {
        // Port 9 on localhost is closed: a request would give Transport.
        let f = Fetcher::with_base_url("http://127.0.0.1:9");
        assert_eq!(f.fetch(FeedKind::SiriEt, "  ").unwrap_err(), FetchError::MissingKey);
        assert_eq!(f.fetch(FeedKind::SiriEt, "a b").unwrap_err(), FetchError::InvalidKey);
        assert_eq!(f.fetch(FeedKind::SiriEt, "a\r\nX-Evil: 1").unwrap_err(), FetchError::InvalidKey);
        let err = fetch_with(&f, FeedKind::GtfsRt, "").unwrap_err();
        assert_eq!(err.downcast_ref::<FetchError>(), Some(&FetchError::MissingKey));
    }

    fn fetch_with(f: &Fetcher, kind: FeedKind, key: &str) -> anyhow::Result<Vec<u8>> {
        Ok(f.fetch(kind, key)?)
    }

    const S: Duration = Duration::from_secs(1);

    #[test]
    fn poller_cadence_and_backoff() {
        let t0 = Instant::now();
        let mut p = Poller::new(FeedKind::SiriEt);
        assert_eq!(p.wait(t0), Duration::ZERO, "first poll is immediate");
        p.on_request(t0);
        // The download took 8 s; the period still counts from the start.
        p.on_result(t0, t0 + 8 * S, Ok(()));
        assert_eq!(p.wait(t0 + 8 * S), 52 * S);
        assert_eq!(p.wait(t0 + 61 * S), Duration::ZERO);

        // Transient errors: 120 s, 240 s, … capped at 15 min.
        let t1 = t0 + 60 * S;
        p.on_request(t1);
        p.on_result(t1, t1 + S, Err(&FetchError::Status(503)));
        assert_eq!(p.wait(t1 + S), 120 * S);
        let t2 = t1 + 121 * S;
        p.on_request(t2);
        p.on_result(t2, t2, Err(&FetchError::Transport("x".into())));
        assert_eq!(p.wait(t2), 240 * S);
        assert_eq!(p.failures(), 2);
        for _ in 0..10 {
            p.on_result(t2, t2, Err(&FetchError::Status(500)));
        }
        assert_eq!(p.wait(t2), 900 * S);

        // Success resets the backoff.
        let t3 = t2 + 1000 * S;
        p.on_request(t3);
        p.on_result(t3, t3 + S, Ok(()));
        assert_eq!((p.failures(), p.wait(t3 + S)), (0, 59 * S));
        assert!(p.last_error().is_none());
    }

    #[test]
    fn poller_rate_limit_and_auth() {
        let t0 = Instant::now();
        let mut p = Poller::new(FeedKind::GtfsRt);
        p.on_request(t0);
        p.on_result(t0, t0, Err(&FetchError::RateLimited { retry_after: Some(300 * S) }));
        assert_eq!(p.wait(t0), 300 * S, "Retry-After is honoured");
        p.on_result(t0, t0, Ok(()));
        p.on_result(t0, t0, Err(&FetchError::RateLimited { retry_after: None }));
        assert_eq!(p.wait(t0), 64 * S, "at least a minute, here 2 × 32 s");
        assert!(!p.auth_failed());

        p.on_result(t0, t0, Err(&FetchError::Unauthorized));
        assert!(p.auth_failed());
        assert_eq!(p.wait(t0), 900 * S, "a rejected key is retried at the slowest pace");
    }

    #[test]
    fn poller_never_exceeds_the_limits() {
        // A policy that asks for far too much is clamped by the per-minute
        // floor and the daily budget.
        let policy =
            PollPolicy { interval: S, min_interval: 30 * S, max_per_day: 3, max_backoff: 900 * S };
        let mut p = Poller::with_policy(FeedKind::SiriEt, policy);
        assert_eq!(p.policy().interval, 30 * S);
        let t0 = Instant::now();
        let mut now = t0;
        let mut times = Vec::new();
        for _ in 0..5 {
            now += p.wait(now);
            p.on_request(now);
            p.on_result(now, now, Ok(()));
            times.push(now.duration_since(t0).as_secs());
        }
        assert_eq!(times, vec![0, 30, 60, 86_400, 86_430]);

        // The defaults: never two requests within 30 s, at most 3,000 a day.
        for kind in [FeedKind::SiriEt, FeedKind::GtfsRt] {
            let mut p = Poller::new(kind);
            let (mut now, mut n) = (t0, 0u32);
            let mut last: Option<Instant> = None;
            while now.duration_since(t0) < DAY {
                now += p.wait(now);
                if let Some(l) = last {
                    assert!(now.duration_since(l) >= 30 * S);
                }
                last = Some(now);
                p.on_request(now);
                p.on_result(now, now, Ok(()));
                n += 1;
            }
            assert!(n <= 3000, "{kind:?}: {n} requests in a day");
        }
    }

    #[test]
    fn poller_run_stops() {
        let (base, _rx) = serve(vec![response("200 OK", &[], b"one")]);
        let f = Fetcher::with_base_url(&base);
        let stop = AtomicBool::new(false);
        let mut p = Poller::new(FeedKind::SiriEt);
        let mut got = Vec::new();
        p.run(
            &f,
            "k",
            &stop,
            |b| {
                got.push(b);
                stop.store(true, Ordering::Relaxed);
            },
            |_| {},
        );
        assert_eq!(got, vec![b"one".to_vec()]);
    }
}
