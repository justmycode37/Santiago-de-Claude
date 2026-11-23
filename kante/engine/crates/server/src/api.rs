//! HTTP handlers. Thin: parse, call into `App`, serialise.

use crate::json;
use crate::liveapi;
use crate::state::App;
use axum::extract::{Query as Q, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use kante_core::geo::{BBox, LatLon};
use kante_core::time;
use kante_core::*;
use serde::Deserialize;
use std::sync::Arc;

type S = State<Arc<App>>;

pub struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({ "error": self.1 }))).into_response()
    }
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}

/// A latitude the grid and the metric approximations can work with.
fn valid_lat(lat: f64) -> bool {
    lat.is_finite() && (-85.0..=85.0).contains(&lat)
}

/// A moment asked about must be within about a year of now: further out there is
/// no timetable, and the date arithmetic must not overflow.
fn check_t(t: i64) -> Result<i64, ApiError> {
    if (t - now_unix()).abs() > 400 * 86_400 {
        return Err(bad("time out of range"));
    }
    Ok(t)
}

fn now_unix() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn routes(app: Arc<App>) -> Router {
    Router::new()
        .route("/api/meta", get(meta))
        .route("/api/search", get(search))
        .route("/api/reverse", get(reverse))
        .route("/api/departures", get(departures))
        .route("/api/trip", get(trip))
        .route("/api/vehicles", get(vehicles))
        .route("/api/due", get(due))
        .route("/api/identify", get(identify))
        .route("/api/match", get(match_trip))
        .route("/api/stream", get(stream))
        .route("/api/plan", post(plan))
        .route("/api/walk", post(walk))
        .with_state(app)
}

// ------------------------------------------------------------------ meta

async fn meta(State(app): S) -> Json<json::MetaResponse> {
    let tt = &app.tt;
    let b = &app.walk_bbox;
    Json(json::MetaResponse {
        feed_version: tt.feed_version.clone(),
        valid_from: time::fmt_date(tt.start_date),
        valid_to: time::fmt_date(tt.end_date()),
        walk_bbox: [b.min.lon_deg(), b.min.lat_deg(), b.max.lon_deg(), b.max.lat_deg()],
        realtime: app.live.read().meta.clone(),
        features: vec!["match", "due", "stream", "extras", "gtfs-rt", "identify", "quay-sloid"],
        counts: json::Counts {
            stations: tt.stations.len(),
            quays: tt.stops.len(),
            trips: tt.trips.len(),
            walk_edges: app.walk.as_ref().map(|w| w.graph().edges.len()).unwrap_or(0),
        },
        attribution: vec!["Timetable and real-time data: opentransportdata.swiss", "Walking network: © OpenStreetMap contributors (ODbL)", "Base map: © swisstopo"],
    })
}

// ------------------------------------------------------------------ search

#[derive(Deserialize)]
struct SearchParams {
    #[serde(default)]
    q: String,
    lat: Option<f64>,
    lon: Option<f64>,
    limit: Option<usize>,
}

async fn search(State(app): S, Q(p): Q<SearchParams>) -> Json<json::SearchResponse> {
    let near = match (p.lat, p.lon) {
        (Some(a), Some(b)) => Some(LatLon::from_deg(a, b)),
        _ => None,
    };
    let limit = p.limit.unwrap_or(10).clamp(1, 30);
    let results = match &app.search {
        Some(idx) => idx.search(&p.q, near, limit).iter().map(|h| app.hit_place(h, near)).collect(),
        None => fallback_station_search(&app, &p.q, near, limit),
    };
    Json(json::SearchResponse { results })
}

/// Station-only search used until the full index has been built.
fn fallback_station_search(app: &App, q: &str, near: Option<LatLon>, limit: usize) -> Vec<json::Place> {
    let q = text::normalize(q);
    if q.is_empty() {
        return vec![];
    }
    let tokens: Vec<&str> = q.split(' ').collect();
    let mut hits: Vec<(f32, u32)> = Vec::new();
    for (i, name) in app.station_norm.iter().enumerate() {
        let all = tokens.iter().all(|t| name.split(' ').any(|w| w.starts_with(t)));
        if !all {
            continue;
        }
        let st = &app.tt.stations[i];
        let mut score = (st.weight as f32 + 1.0).ln();
        if name == &q {
            score += 6.0;
        } else if name.starts_with(&q) {
            score += 3.0;
        }
        if let Some(n) = near {
            score += 3.0 / (1.0 + st.pos.dist_m(&n) / 3000.0);
        }
        hits.push((score, i as u32));
    }
    hits.sort_by(|a, b| b.0.total_cmp(&a.0));
    hits.truncate(limit);
    hits.into_iter()
        .map(|(_, i)| {
            let mut p = app.station_place(i);
            p.dist_m = near.map(|n| n.dist_m(&app.tt.stations[i as usize].pos) as u32);
            p
        })
        .collect()
}

/// GET /api/reverse?lat=&lon= → the place a dropped pin should be called.
async fn reverse(State(app): S, Q(p): Q<LatLonParams>) -> Result<Json<json::Place>, ApiError> {
    let r = json::PlaceRef { id: None, lat: Some(p.lat), lon: Some(p.lon), name: None, quay: None };
    app.resolve(&r).map(|e| Json(e.place)).map_err(bad)
}

#[derive(Deserialize)]
struct LatLonParams {
    lat: f64,
    lon: f64,
}

// ------------------------------------------------------------------ bounding boxes

fn parse_bbox(s: &str) -> Result<BBox, ApiError> {
    let v: Vec<f64> = s.split(',').filter_map(|x| x.trim().parse().ok()).collect();
    if v.len() != 4 || v[0] > v[2] || v[1] > v[3] || !v.iter().all(|x| x.is_finite()) || !valid_lat(v[1]) || !valid_lat(v[3]) || v[0] < -180.0 || v[2] > 180.0 {
        return Err(bad("bbox must be west,south,east,north"));
    }
    Ok(BBox::from_deg(v[1], v[0], v[3], v[2]))
}

#[derive(Deserialize)]
struct BboxParams {
    bbox: String,
    t: Option<i64>,
}

// ------------------------------------------------------------------ departures / trip

#[derive(Deserialize)]
struct DepParams {
    station: Option<String>,
    quay: Option<String>,
    time: Option<i64>,
    limit: Option<usize>,
}

async fn departures(State(app): S, Q(p): Q<DepParams>) -> Result<Json<json::DeparturesResponse>, ApiError> {
    let tt = &app.tt;
    let (station, stops): (StationIdx, Vec<StopIdx>) = if let Some(q) = &p.quay {
        let stops = app.quays_of(q);
        let first = *stops.first().ok_or_else(|| bad("unknown quay"))?;
        (tt.stops[first as usize].station, stops)
    } else if let Some(id) = &p.station {
        let st = app.station_ids.get(id.as_str()).copied().or_else(|| liveapi::station_of(&app, id)).ok_or_else(|| bad("unknown station"))?;
        (st, tt.stations[st as usize].stops.clone())
    } else {
        return Err(bad("station or quay is required"));
    };
    let (date, secs) = time::from_unix(p.time.unwrap_or_else(now_unix));
    let live_arc = app.live_view();
    let live = live_arc.as_deref();
    let limit = p.limit.unwrap_or(40).clamp(1, 200);
    let evs = app.router.departures(&stops, date, secs, limit, live);
    let departures = evs
        .iter()
        .map(|e| {
            let t = &tt.trips[e.trip as usize];
            let pstops = tt.pattern_stops(t.pattern);
            let tl = live.and_then(|l| l.trip(e.date, e.trip));
            let actual = tl.and_then(|l| l.quay.get(e.pos as usize).copied()).filter(|&q| q != NONE && q != e.stop);
            let number = tt.str(t.short_name);
            json::Departure {
                line: app.line_badge(e.trip),
                headsign: tt.str(t.headsign).to_string(),
                number: (!number.is_empty()).then(|| number.to_string()),
                trip_id: tt.trip_gtfs_id(e.trip).to_string(),
                service_date: time::fmt_date(e.date),
                seq: e.pos,
                dep: time::to_unix(date, e.dep),
                live: tl.is_some(),
                delay_s: tl.map(|_| e.live_dep - e.dep),
                cancelled: e.cancelled,
                quay_id: tt.stops[actual.unwrap_or(e.stop) as usize].gtfs_id.clone(),
                planned_label: actual.map(|_| tt.stops[e.stop as usize].label.clone()),
                towards: pstops.get(e.pos as usize + 1).map(|&n| tt.stations[tt.stops[n as usize].station as usize].name.clone()),
                bearing: pstops.get(e.pos as usize + 1).map(|&n| tt.stops[e.stop as usize].pos.bearing_deg(&tt.stops[n as usize].pos).round()),
                headway_s: (t.flags & TRIP_FREQUENCY != 0).then_some(t.headway_s),
            }
        })
        .collect::<Vec<_>>();
    let mut departures = departures;
    if let Some(l) = live.filter(|l| !l.extras().is_empty()) {
        // Extra journeys leaving here before the last departure listed (or within two hours).
        let from = time::to_unix(date, secs);
        let until = if departures.len() >= limit { departures.last().map(|d| d.dep + d.delay_s.unwrap_or(0) as i64).unwrap_or(from) } else { from + 7200 };
        departures.extend(liveapi::extra_departures(&app, l, &stops, from, until));
        departures.sort_by_key(|d| d.dep + d.delay_s.unwrap_or(0) as i64);
    }
    Ok(Json(json::DeparturesResponse {
        station: app.station_place(station),
        quays: tt.stations[station as usize].stops.iter().map(|&s| app.quay(s)).collect(),
        departures,
        realtime: live.is_some(),
    }))
}

#[derive(Deserialize)]
struct TripParams {
    id: String,
    date: String,
}

#[derive(Deserialize)]
struct TripTime {
    t: Option<i64>,
}

async fn trip(State(app): S, Q(p): Q<TripParams>, Q(at): Q<TripTime>) -> Result<Json<json::TripResponse>, ApiError> {
    let tt = &app.tt;
    let now = check_t(at.t.unwrap_or_else(now_unix))?;
    let live_arc = app.live_view();
    let date = time::parse_date(&p.date).ok_or_else(|| bad("date must be YYYY-MM-DD"))?;
    if p.id.starts_with("extra:") {
        let x = live_arc
            .as_deref()
            .and_then(|l| l.extra(&p.id))
            .filter(|x| x.date == date)
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "unknown or expired extra journey".into()))?;
        return Ok(Json(extra_trip(&app, x, now)));
    }
    let trip = app.router.find_trip(&p.id).ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "unknown trip".into()))?;
    if !tt.trip_active(trip, date) {
        return Err(ApiError(StatusCode::NOT_FOUND, "the trip does not run on that date".into()));
    }
    let tl = live_arc.as_deref().and_then(|l| l.trip(date, trip));
    let run = liveapi::Run::of_trip(&app, trip, date, tl);
    let t = &tt.trips[trip as usize];
    let n = tt.pattern_stops(t.pattern).len();
    let calls: Vec<json::StopCall> = (0..n).map(|pos| app.stop_call(trip, date, pos, tl)).collect();
    let number = tt.str(t.short_name);
    Ok(Json(json::TripResponse {
        trip_id: p.id,
        service_date: time::fmt_date(date),
        line: app.line_badge(trip),
        headsign: tt.str(t.headsign).to_string(),
        number: (!number.is_empty()).then(|| number.to_string()),
        geometry: calls.iter().map(|c| [c.quay.lon, c.quay.lat]).collect(),
        calls,
        live: App::live_state(tl),
        cancelled: tl.map(|l| l.cancelled).unwrap_or(false),
        headway_s: (t.flags & TRIP_FREQUENCY != 0).then_some(t.headway_s),
        live_info: liveapi::live_info(&run.facts, liveapi::feed_age(&app), now),
        position: liveapi::position(&app, &run, now),
        extra: false,
    }))
}

/// `/api/trip` for a journey that is not in the timetable.
fn extra_trip(app: &App, x: &ExtraTrip, now: i64) -> json::TripResponse {
    let run = liveapi::Run::of_extra(x);
    let calls: Vec<json::StopCall> = run
        .calls
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let x = &x.calls[i];
            json::StopCall {
                seq: i as u16,
                quay: app.quay(c.stop),
                arr: c.arr.map(|a| x.aimed_arr.unwrap_or(a)),
                dep: c.dep.map(|d| x.aimed_dep.unwrap_or(d)),
                arr_delay_s: c.arr.zip(x.aimed_arr).map(|(a, s)| (a - s) as i32),
                dep_delay_s: c.dep.zip(x.aimed_dep).map(|(d, s)| (d - s) as i32),
                planned_label: None,
                skipped: c.skipped,
                on_request: false,
                live: true,
            }
        })
        .collect();
    json::TripResponse {
        trip_id: x.id.clone(),
        service_date: time::fmt_date(x.date),
        line: liveapi::extra_badge(x),
        headsign: x.headsign.clone(),
        number: None,
        geometry: calls.iter().map(|c| [c.quay.lon, c.quay.lat]).collect(),
        calls,
        live: if x.observed_pos >= 0 { "observed" } else { "predicted" },
        cancelled: x.cancelled,
        headway_s: None,
        live_info: liveapi::live_info(&run.facts, liveapi::feed_age(app), now),
        position: liveapi::position(app, &run, now),
        extra: true,
    }
}

// ------------------------------------------------------------------ vehicles

async fn vehicles(State(app): S, Q(p): Q<BboxParams>) -> Result<Json<json::VehiclesResponse>, ApiError> {
    let bbox = parse_bbox(&p.bbox)?;
    if bbox.min.dist_m(&bbox.max) > 120_000.0 {
        return Err(bad("bbox too large"));
    }
    let t = check_t(p.t.unwrap_or_else(now_unix))?;
    let a = app.clone();
    let body = liveapi::run_heavy(&app.heavy, move || liveapi::vehicles(&a, &bbox, t)).await.ok_or_else(|| ApiError(StatusCode::SERVICE_UNAVAILABLE, "try again".into()))?;
    Ok(Json(body))
}

async fn stream(State(app): S, Q(p): Q<BboxParams>) -> Result<Response, ApiError> {
    use axum::response::sse::{KeepAlive, Sse};
    let bbox = parse_bbox(&p.bbox)?;
    if bbox.min.dist_m(&bbox.max) > 120_000.0 {
        return Err(bad("bbox too large"));
    }
    let Some(slot) = liveapi::StreamSlot::take(&app) else {
        return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "too many open streams; poll /api/vehicles".into()));
    };
    let sse = Sse::new(liveapi::stream(app, bbox, slot)).keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15)).text("ping"));
    Ok(([(header::CACHE_CONTROL, "no-cache"), (header::HeaderName::from_static("x-accel-buffering"), "no")], sse).into_response())
}

#[derive(Deserialize)]
struct DueParams {
    quay: Option<String>,
    station: Option<String>,
    lat: Option<f64>,
    lon: Option<f64>,
    radius: Option<f32>,
    t: Option<i64>,
    before: Option<i64>,
    after: Option<i64>,
    limit: Option<usize>,
}

async fn due(State(app): S, Q(p): Q<DueParams>) -> Result<Json<json::DueResponse>, ApiError> {
    let tt = &app.tt;
    let stops: Vec<StopIdx> = if let Some(q) = &p.quay {
        let stops = app.quays_of(q);
        if stops.is_empty() {
            return Err(bad("unknown quay"));
        }
        stops
    } else if let Some(id) = &p.station {
        let st = liveapi::station_of(&app, id).ok_or_else(|| bad("unknown station"))?;
        tt.stations[st as usize].stops.clone()
    } else if let (Some(lat), Some(lon)) = (p.lat, p.lon) {
        if !valid_lat(lat) || !lon.is_finite() || lon.abs() > 180.0 {
            return Err(bad("lat/lon out of range"));
        }
        let here = LatLon::from_deg(lat, lon);
        let r = p.radius.filter(|r| r.is_finite()).unwrap_or(150.0).clamp(10.0, 400.0);
        let mut v = Vec::new();
        app.stop_grid.around(here, r, |s| {
            if tt.stops[s as usize].pos.dist_m(&here) <= r {
                v.push(s);
            }
        });
        v
    } else {
        return Err(bad("quay, station or lat+lon is required"));
    };
    let q = liveapi::DueQuery {
        stops,
        t: check_t(p.t.unwrap_or_else(now_unix))?,
        before: p.before.unwrap_or(120).clamp(0, 3600),
        after: p.after.unwrap_or(900).clamp(0, 7200),
        limit: p.limit.unwrap_or(30).clamp(1, 200),
    };
    Ok(Json(liveapi::due(&app, &q)))
}

#[derive(Deserialize)]
struct IdentifyParams {
    lat: f64,
    lon: f64,
    t: Option<i64>,
    #[serde(default)]
    line: String,
    #[serde(default)]
    headsign: String,
    bearing: Option<f32>,
    radius: Option<f32>,
    quay: Option<String>,
}

async fn identify(State(app): S, Q(p): Q<IdentifyParams>) -> Result<Json<json::IdentifyResponse>, ApiError> {
    if !valid_lat(p.lat) || !p.lon.is_finite() || p.lon.abs() > 180.0 {
        return Err(bad("lat/lon out of range"));
    }
    if p.line.len() > 40 || p.headsign.len() > 200 {
        return Err(bad("line or headsign too long"));
    }
    let stops = match &p.quay {
        Some(q) => {
            let s = app.quays_of(q);
            if s.is_empty() {
                return Err(bad("unknown quay"));
            }
            Some(s)
        }
        None => None,
    };
    let q = crate::identify::IdentifyQuery {
        pos: LatLon::from_deg(p.lat, p.lon),
        t: check_t(p.t.unwrap_or_else(now_unix))?,
        line: p.line,
        headsign: p.headsign,
        bearing: p.bearing.filter(|b| b.is_finite()).map(|b| b.rem_euclid(360.0)),
        radius: p.radius.filter(|r| r.is_finite()).unwrap_or(120.0).clamp(20.0, 400.0),
        stops,
    };
    let a = app.clone();
    let body = liveapi::run_heavy(&app.heavy, move || crate::identify::identify(&a, &q)).await.ok_or_else(|| ApiError(StatusCode::SERVICE_UNAVAILABLE, "try again".into()))?;
    Ok(Json(body))
}

#[derive(Deserialize)]
struct MatchParams {
    from: String,
    dep: i64,
    to: Option<String>,
    arr: Option<i64>,
    #[serde(default)]
    line: String,
    #[serde(default)]
    number: String,
}

async fn match_trip(State(app): S, Q(p): Q<MatchParams>) -> Result<Json<json::MatchResponse>, ApiError> {
    let from = liveapi::station_of(&app, &p.from).ok_or_else(|| bad("unknown station"))?;
    let to = match &p.to {
        Some(t) => Some(liveapi::station_of(&app, t).ok_or_else(|| bad("unknown station"))?),
        None => None,
    };
    let dep = check_t(p.dep)?;
    let arr = p.arr.map(check_t).transpose()?;
    Ok(Json(liveapi::match_trip(&app, &liveapi::MatchQuery { from, dep, to, arr, line: &p.line, number: &p.number })))
}

// ------------------------------------------------------------------ planning

async fn plan(State(app): S, Json(req): Json<json::PlanRequest>) -> Result<Json<json::PlanResponse>, ApiError> {
    let res = tokio::task::spawn_blocking(move || app.plan(&req)).await.map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    res.map(Json).map_err(bad)
}

async fn walk(State(app): S, Json(req): Json<json::WalkRequest>) -> Result<Json<json::WalkLeg>, ApiError> {
    let res = tokio::task::spawn_blocking(move || app.walk_direct(&req)).await.map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    res.map(Json).map_err(bad)
}
