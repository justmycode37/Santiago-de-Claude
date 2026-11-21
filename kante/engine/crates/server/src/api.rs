//! HTTP handlers. Thin: parse, call into `App`, serialise.

use crate::json;
use crate::liveapi;
use crate::state::{level_f, lonlat, App};
use axum::extract::{Query as Q, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use kante_core::geo::{project_on_segment, BBox, LatLon};
use kante_core::time::{self, Date, Secs};
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
        .route("/api/nearby", get(nearby))
        .route("/api/reverse", get(reverse))
        .route("/api/quays", get(quays))
        .route("/api/departures", get(departures))
        .route("/api/trip", get(trip))
        .route("/api/vehicles", get(vehicles))
        .route("/api/onboard", get(onboard))
        .route("/api/due", get(due))
        .route("/api/match", get(match_trip))
        .route("/api/stream", get(stream))
        .route("/api/indoor", get(indoor))
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
        features: vec!["match", "due", "stream", "extras", "gtfs-rt"],
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
async fn reverse(State(app): S, Q(p): Q<NearbyParams>) -> Result<Json<json::Place>, ApiError> {
    let r = json::PlaceRef { id: None, lat: Some(p.lat), lon: Some(p.lon), name: None };
    app.resolve(&r).map(|e| Json(e.place)).map_err(bad)
}

// ------------------------------------------------------------------ nearby

#[derive(Deserialize)]
struct NearbyParams {
    lat: f64,
    lon: f64,
    radius: Option<f32>,
    limit: Option<usize>,
    time: Option<i64>,
}

async fn nearby(State(app): S, Q(p): Q<NearbyParams>) -> Json<json::NearbyResponse> {
    let pos = LatLon::from_deg(p.lat, p.lon);
    let radius = p.radius.unwrap_or(600.0).clamp(50.0, 3000.0);
    let limit = p.limit.unwrap_or(8).clamp(1, 20);
    let (date, secs) = time::from_unix(p.time.unwrap_or_else(now_unix));
    let live_arc = app.live_view();
    let live = live_arc.as_deref();
    let tt = &app.tt;

    // A station is as near as its nearest boarding point.
    let mut near: rustc_hash::FxHashMap<StationIdx, f32> = Default::default();
    app.stop_grid.around(pos, radius, |s| {
        let stop = &tt.stops[s as usize];
        let d = stop.pos.dist_m(&pos);
        if d <= radius {
            let e = near.entry(stop.station).or_insert(f32::MAX);
            *e = e.min(d);
        }
    });
    let mut list: Vec<(f32, StationIdx)> = near.into_iter().map(|(s, d)| (d, s)).collect();
    list.sort_by(|a, b| a.0.total_cmp(&b.0));

    let mut stations = Vec::new();
    for (d, st) in list {
        if stations.len() >= limit {
            break;
        }
        let station = &tt.stations[st as usize];
        let evs = app.router.departures(&station.stops, date, secs, 60, live);
        let mut lines: Vec<json::NearbyLine> = Vec::new();
        for e in evs.iter().filter(|e| !e.cancelled) {
            let t = &tt.trips[e.trip as usize];
            let badge = app.line_badge(e.trip);
            let headsign = tt.str(t.headsign);
            let when = time::to_unix(date, e.live_dep);
            if when > time::to_unix(date, secs) + 3 * 3600 {
                break;
            }
            if let Some(l) = lines.iter_mut().find(|l| l.line.name == badge.name && l.line.category == badge.category && l.headsign == headsign) {
                if l.next.len() < 3 {
                    l.next.push(when);
                }
                continue;
            }
            if lines.len() >= 8 {
                continue;
            }
            lines.push(json::NearbyLine {
                line: badge,
                headsign: headsign.to_string(),
                quay: app.quay(e.stop),
                next: vec![when],
                live: live.and_then(|l| l.trip(e.date, e.trip)).is_some(),
                delay_s: live.and_then(|l| l.trip(e.date, e.trip)).map(|_| e.live_dep - e.dep),
                trip_id: tt.trip_gtfs_id(e.trip).to_string(),
                service_date: time::fmt_date(e.date),
                seq: e.pos,
            });
        }
        if lines.is_empty() {
            continue;
        }
        let mut place = app.station_place(st);
        place.dist_m = Some(d as u32);
        stations.push(json::NearbyStation { place, dist_m: d as u32, lines });
    }
    Json(json::NearbyResponse { stations })
}

// ------------------------------------------------------------------ quays / indoor

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

async fn quays(State(app): S, Q(p): Q<BboxParams>) -> Result<Json<json::QuaysResponse>, ApiError> {
    let bbox = parse_bbox(&p.bbox)?;
    let mut out = Vec::new();
    app.stop_grid.for_bbox(&bbox, |s| {
        if out.len() < 600 && bbox.contains(&app.tt.stops[s as usize].pos) {
            out.push(app.quay(s));
        }
    });
    Ok(Json(json::QuaysResponse { quays: out }))
}

fn kind_str(k: EdgeKind) -> &'static str {
    match k {
        EdgeKind::Footway => "footway",
        EdgeKind::Sidewalk => "sidewalk",
        EdgeKind::Crossing => "crossing",
        EdgeKind::Path => "path",
        EdgeKind::Pedestrian => "pedestrian",
        EdgeKind::Steps => "steps",
        EdgeKind::Escalator => "escalator",
        EdgeKind::Lift => "lift",
        EdgeKind::Corridor => "corridor",
        EdgeKind::Platform => "platform",
        EdgeKind::Road | EdgeKind::RoadBusy => "road",
    }
}

async fn indoor(State(app): S, Q(p): Q<BboxParams>) -> Result<Response, ApiError> {
    let bbox = parse_bbox(&p.bbox)?;
    let mut features: Vec<serde_json::Value> = Vec::new();
    if let Some(walk) = &app.walk {
        if bbox.min.dist_m(&bbox.max) <= 4000.0 {
            let g = walk.graph();
            for e in walk.edges_in(&bbox) {
                let ed = &g.edges[e as usize];
                // Plain roads add nothing to a station close-up; the base map shows them.
                if matches!(ed.kind, EdgeKind::Road | EdgeKind::RoadBusy) && ed.level_a == LEVEL_NONE {
                    continue;
                }
                // Synthetic straight edges across squares and platforms are for
                // routing; drawn, they turn every open space into a cobweb.
                if ed.flags & EF_AREA != 0 {
                    continue;
                }
                let coords: Vec<[f64; 2]> = g.edge_geom(e).iter().map(lonlat).collect();
                let mut props = serde_json::json!({
                    "kind": kind_str(ed.kind),
                    "level": level_f(ed.level_a),
                    "indoor": ed.flags & (EF_INDOOR | EF_TUNNEL) != 0,
                });
                if ed.level_b != ed.level_a {
                    props["toLevel"] = serde_json::json!(level_f(ed.level_b));
                }
                let name = g.edge_name(e);
                if !name.is_empty() {
                    props["name"] = serde_json::json!(name);
                }
                features.push(serde_json::json!({
                    "type": "Feature",
                    "geometry": { "type": "LineString", "coordinates": coords },
                    "properties": props,
                }));
                if features.len() >= 25_000 {
                    break;
                }
            }
        }
    }
    let body = serde_json::json!({ "type": "FeatureCollection", "features": features });
    Ok(([(header::CACHE_CONTROL, "public, max-age=3600")], Json(body)).into_response())
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
        let s = *app.stop_ids.get(q.as_str()).ok_or_else(|| bad("unknown quay"))?;
        (tt.stops[s as usize].station, vec![s])
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

// ------------------------------------------------------------------ vehicles / on board

/// A vehicle segment resolved to coordinates.
struct Seg {
    trip: TripIdx,
    date: Date,
    pos: u16,
    a: LatLon,
    b: LatLon,
    dep: Secs,
    arr: Secs,
}

fn segments(app: &App, bbox: &BBox, date: Date, now: Secs, live: Option<&dyn LiveView>) -> Vec<Seg> {
    let tt = &app.tt;
    app.router
        .vehicles(bbox, date, now, live)
        .into_iter()
        .filter_map(|v| {
            let stops = tt.pattern_stops(tt.trips[v.trip as usize].pattern);
            // The boarding point in use (a changed platform), else the planned one.
            let tl = live.and_then(|l| l.trip(v.date, v.trip));
            let at = |p: usize| -> Option<LatLon> {
                let planned = *stops.get(p)?;
                let q = tl.and_then(|l| l.quay.get(p).copied()).filter(|&q| q != NONE).unwrap_or(planned);
                Some(tt.stops[q as usize].pos)
            };
            let a = at(v.pos as usize)?;
            let next = if v.dwell { v.pos as usize } else { v.pos as usize + 1 };
            let b = at(next)?;
            Some(Seg { trip: v.trip, date: v.date, pos: v.pos, a, b, dep: v.dep, arr: v.arr })
        })
        .collect()
}

async fn vehicles(State(app): S, Q(p): Q<BboxParams>) -> Result<Json<json::VehiclesResponse>, ApiError> {
    let bbox = parse_bbox(&p.bbox)?;
    if bbox.min.dist_m(&bbox.max) > 120_000.0 {
        return Err(bad("bbox too large"));
    }
    let t = check_t(p.t.unwrap_or_else(now_unix))?;
    let _permit = app.heavy.acquire().await.map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "shutting down".into()))?;
    let a = app.clone();
    let body = tokio::task::spawn_blocking(move || liveapi::vehicles(&a, &bbox, t)).await.map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "failed".into()))?;
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
        vec![*app.stop_ids.get(q.as_str()).ok_or_else(|| bad("unknown quay"))?]
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

#[derive(Deserialize)]
struct OnboardParams {
    lat: f64,
    lon: f64,
    t: Option<i64>,
    #[serde(default)]
    q: String,
}

async fn onboard(State(app): S, Q(p): Q<OnboardParams>) -> Json<json::OnboardResponse> {
    let pos = LatLon::from_deg(p.lat, p.lon);
    let t = p.t.unwrap_or_else(now_unix);
    let (date, secs) = time::from_unix(t);
    let live_arc = app.live_view();
    let live = live_arc.as_deref();
    let tt = &app.tt;
    let filter = text::normalize(&p.q).replace(' ', "");

    // Timetable positions are estimates and stop-to-stop lines are straight,
    // so judge mainly by "is the traveller on this vehicle's segment" and only
    // then by how far along it the vehicle should be. Trains get a wide
    // corridor because the track can curve far away from the straight line.
    let mut cands: Vec<(f32, json::OnboardCandidate)> = Vec::new();
    for s in segments(&app, &BBox::around(pos, 6000.0), date, secs, live) {
        let tr = &tt.trips[s.trip as usize];
        let line = tt.trip_line(s.trip);
        if !filter.is_empty() {
            let name = text::normalize(&format!("{}{}", line.category, line.name)).replace(' ', "");
            let plain = text::normalize(&line.name).replace(' ', "");
            if !(plain.starts_with(&filter) || name.starts_with(&filter)) {
                continue;
            }
        }
        let (corridor, reach) = match line.mode {
            Mode::Rail | Mode::RackRail => (1500.0, 6000.0),
            Mode::Boat => (800.0, 3000.0),
            Mode::Metro | Mode::Funicular | Mode::Cableway => (300.0, 1500.0),
            _ => (150.0, 1200.0),
        };
        let (frac, off) = project_on_segment(&pos, &s.a, &s.b);
        if off > corridor {
            continue;
        }
        let span = (s.arr - s.dep).max(1) as f32;
        let progress = ((secs - s.dep) as f32 / span).clamp(0.0, 1.0);
        let est = s.a.lerp(&s.b, progress);
        let along = est.dist_m(&pos);
        if along > reach {
            continue;
        }
        let _ = frac;
        let stops = tt.pattern_stops(tr.pattern);
        let next = (s.pos as usize + 1).min(stops.len() - 1);
        let tl = live.and_then(|l| l.trip(s.date, s.trip));
        let number = tt.str(tr.short_name);
        let name_of = |i: usize| tt.stations[tt.stops[stops[i] as usize].station as usize].name.clone();
        cands.push((
            off + 0.35 * along,
            json::OnboardCandidate {
                trip_id: tt.trip_gtfs_id(s.trip).to_string(),
                service_date: time::fmt_date(s.date),
                line: app.line_badge(s.trip),
                headsign: tt.str(tr.headsign).to_string(),
                number: (!number.is_empty()).then(|| number.to_string()),
                dist_m: along as u32,
                next_seq: next as u16,
                next_stop: name_of(next),
                next_arr: time::to_unix(date, s.arr),
                prev_stop: Some(name_of(s.pos as usize)),
                delay_s: tl.map(|l| l.arr_delay_at(next)),
            },
        ));
    }
    cands.sort_by(|a, b| a.0.total_cmp(&b.0));
    cands.truncate(12);
    Json(json::OnboardResponse { candidates: cands.into_iter().map(|c| c.1).collect() })
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
