//! Live endpoints: where vehicles are and how sure that is (`liveInfo`,
//! `position`), what is due at a stop (`/api/due`), which trip a ride planned
//! elsewhere is (`/api/match`) and vehicles as server-sent events (`/api/stream`). The contract is in
//! `docs/LIVE-API.md`.
//!
//! A timetable trip with its live overlay and an extra journey of the feed are
//! both turned into a [`Run`]: a list of calls with live times and the boarding
//! point in use, so every endpoint treats them the same way.

use crate::json;
use crate::state::{lonlat, App};
use kante_core::geo::{BBox, LatLon};
use kante_core::time::{self, Date};
use kante_core::*;
use std::sync::Arc;

/// Live data older than this (by the newest feed document) is `stale`.
pub const STALE_S: i64 = 300;

pub struct RunCall {
    pub stop: StopIdx,
    /// Live arrival / departure, unix seconds (scheduled where there is no live data).
    pub arr: Option<i64>,
    pub dep: Option<i64>,
    pub skipped: bool,
    /// The planned boarding point when the live one differs.
    pub planned: Option<StopIdx>,
    /// The times come from a live feed, not the timetable.
    pub live: bool,
}

/// The facts behind `liveInfo`, for timetable trips and extra journeys alike.
#[derive(Clone, Copy, Default)]
pub struct LiveFacts {
    pub live: bool,
    pub observed_pos: i16,
    pub observed_kind: u8,
    pub updated_at: i64,
    pub sources: u8,
    pub inaccurate: bool,
    pub congestion: bool,
}

impl LiveFacts {
    pub fn of(tl: Option<&TripLive>) -> Self {
        match tl {
            Some(l) => LiveFacts {
                live: true,
                observed_pos: l.observed_pos,
                observed_kind: l.observed_kind,
                updated_at: l.updated_at,
                sources: l.sources,
                inaccurate: l.inaccurate,
                congestion: l.congestion,
            },
            None => LiveFacts { observed_pos: -1, ..Default::default() },
        }
    }
    pub fn of_extra(e: &ExtraTrip) -> Self {
        LiveFacts {
            live: true,
            observed_pos: e.observed_pos,
            observed_kind: e.observed_kind,
            updated_at: e.updated_at,
            sources: SOURCE_SIRI_ET,
            inaccurate: e.inaccurate,
            congestion: e.congestion,
        }
    }
}

pub struct Run {
    pub mode: Option<Mode>,
    pub id: String,
    pub date: Date,
    pub calls: Vec<RunCall>,
    pub facts: LiveFacts,
    pub cancelled: bool,
    pub extra: bool,
}

impl Run {
    pub fn of_trip(app: &App, trip: TripIdx, date: Date, tl: Option<&TripLive>) -> Run {
        let tt = &app.tt;
        let stops = tt.pattern_stops(tt.trips[trip as usize].pattern);
        let n = stops.len();
        let calls = (0..n)
            .map(|p| {
                let changed = tl.and_then(|l| l.quay.get(p).copied()).filter(|&q| q != NONE && q != stops[p]);
                RunCall {
                    stop: changed.unwrap_or(stops[p]),
                    arr: (p > 0).then(|| time::to_unix(date, tt.arr(trip, p) + tl.map(|l| l.arr_delay_at(p)).unwrap_or(0))),
                    dep: (p + 1 < n).then(|| time::to_unix(date, tt.dep(trip, p) + tl.map(|l| l.dep_delay_at(p)).unwrap_or(0))),
                    skipped: tl.map(|l| l.is_skipped(p)).unwrap_or(false),
                    planned: changed.map(|_| stops[p]),
                    live: tl.is_some_and(|l| l.is_live_at(p)),
                }
            })
            .collect();
        Run {
            mode: Some(tt.trip_line(trip).mode),
            id: tt.trip_gtfs_id(trip).to_string(),
            date,
            calls,
            facts: LiveFacts::of(tl),
            cancelled: tl.map(|l| l.cancelled).unwrap_or(false),
            extra: false,
        }
    }

    pub fn of_extra(e: &ExtraTrip) -> Run {
        let n = e.calls.len();
        let calls = e
            .calls
            .iter()
            .enumerate()
            .map(|(i, c)| RunCall {
                stop: c.stop,
                arr: if i > 0 { c.arr.or(c.dep) } else { None },
                dep: if i + 1 < n { c.dep.or(c.arr) } else { None },
                skipped: c.skipped,
                planned: None,
                live: true,
            })
            .collect();
        Run { mode: e.mode, id: e.id.clone(), date: e.date, calls, facts: LiveFacts::of_extra(e), cancelled: e.cancelled, extra: true }
    }

    /// Calls the vehicle actually stops at, with (index, arrival, departure); a
    /// missing time takes the other one.
    fn served(&self) -> Vec<(usize, i64, i64)> {
        self.calls
            .iter()
            .enumerate()
            .filter(|(_, c)| !c.skipped)
            .filter_map(|(i, c)| {
                let a = c.arr.or(c.dep)?;
                Some((i, a, c.dep.unwrap_or(a).max(a)))
            })
            .collect()
    }
}

fn wall_clock() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// How long ago (wall clock) each feed was last fetched and parsed successfully.
#[derive(Clone, Copy, Default)]
pub struct FeedAges {
    pub siri: Option<i64>,
    pub gtfs: Option<i64>,
}

pub fn feed_age(app: &App) -> FeedAges {
    let now = wall_clock();
    let live = app.live.read();
    let age = |name: &str| live.meta.feeds.iter().find(|f| f.name == name).and_then(|f| f.polled_at).map(|t| now - t);
    FeedAges { siri: age("siri-et"), gtfs: age("gtfs-rt") }
}

/// `now` is the moment asked about; staleness is judged by the wall clock: a
/// trip is current only while a feed that contributed to it is being fetched.
pub fn live_info(f: &LiveFacts, ages: FeedAges, now: i64) -> json::LiveInfo {
    let fresh = |a: Option<i64>| a.is_some_and(|a| a <= STALE_S);
    let stale = f.live && !((f.sources & SOURCE_SIRI_ET != 0 && fresh(ages.siri)) || (f.sources & SOURCE_GTFS_RT != 0 && fresh(ages.gtfs)));
    let state = if !f.live {
        "timetable"
    } else if stale {
        "stale"
    } else if f.observed_pos >= 0 {
        "observed"
    } else {
        "predicted"
    };
    json::LiveInfo {
        state,
        source: f.live.then_some(match f.sources {
            s if s & SOURCE_SIRI_ET != 0 && s & SOURCE_GTFS_RT != 0 => "siri-et+gtfs-rt",
            s if s & SOURCE_GTFS_RT != 0 => "gtfs-rt",
            _ => "siri-et",
        }),
        observed_seq: (f.observed_pos >= 0).then_some(f.observed_pos as u16),
        observed_kind: (f.observed_pos >= 0).then_some(match f.observed_kind {
            k if k & OBSERVED_ARR != 0 && k & OBSERVED_DEP != 0 => "arr+dep",
            k if k & OBSERVED_DEP != 0 => "dep",
            _ => "arr",
        }),
        updated_at: (f.live && f.updated_at > 0).then_some(f.updated_at),
        age_s: (f.live && f.updated_at > 0).then(|| (now - f.updated_at).max(0)),
        inaccurate: f.inaccurate,
        congestion: f.congestion,
    }
}

/// The served calls with times, where the last measured stop's departure and
/// the next arrival come from the learned profiles instead of the forecast:
/// after a measured departure, the hop usually takes its learned time; after a
/// measured arrival of a bus or tram, it usually stands for its learned dwell.
fn served_with_profiles(app: &App, run: &Run) -> Vec<(usize, i64, i64)> {
    let mut served = run.served();
    let f = &run.facts;
    if f.observed_pos < 0 {
        return served;
    }
    let Some(k) = served.iter().position(|s| s.0 == f.observed_pos as usize) else { return served };
    if k + 1 >= served.len() {
        return served;
    }
    let tt = &app.tt;
    let st = |i: usize| tt.stops[run.calls[i].stop as usize].station;
    let (a, b) = (st(served[k].0), st(served[k + 1].0));
    let prof = app.profiles.read();
    let mut left_measured = f.observed_kind & OBSERVED_DEP != 0;
    if !left_measured && f.observed_kind & OBSERVED_ARR != 0 && !matches!(run.mode, Some(Mode::Rail | Mode::RackRail)) {
        if let Some(d) = prof.dwell(a, b) {
            // Not before the forecast departure: a bus that waits for its time at a
            // timing point keeps waiting.
            served[k].2 = (served[k].1 + d).max(served[k].2);
            left_measured = true;
        }
    }
    if left_measured {
        if let Some(h) = prof.hop(a, b) {
            let left = served[k].2;
            let next = &mut served[k + 1];
            next.1 = left + h;
            next.2 = next.2.max(next.1);
        }
    }
    // Keep every later stop in order after a change.
    for m in k + 1..served.len() {
        let before = served[m - 1].2;
        let s = &mut served[m];
        s.1 = s.1.max(before);
        s.2 = s.2.max(s.1);
    }
    served
}

/// Where the vehicle of `run` is at `now`.
pub fn position(app: &App, run: &Run, now: i64) -> Option<json::Position> {
    let tt = &app.tt;
    let served = served_with_profiles(app, run);
    let pos = |i: usize| lonlat(&tt.stops[run.calls[i].stop as usize].pos);
    let first = *served.first()?;
    let last = *served.last()?;
    let f = &run.facts;
    let measured = |i: usize, kind: u8| f.observed_pos >= 0 && ((f.observed_pos as usize) > i || (f.observed_pos as usize == i && f.observed_kind & kind != 0));
    let at = |k: usize, basis: &'static str| {
        let (i, a, d) = served[k];
        json::Position { state: "at", seq: i as u16, from: pos(i), to: pos(i), frac: 0.0, basis, t: now, next_seq: None, dep: Some(d), arr: Some(a) }
    };
    let basis_at = |i: usize| if !f.live { "timetable" } else if measured(i, OBSERVED_ARR) { "observed-stop" } else { "forecast" };
    let n = served.len();
    if now < first.2 {
        let state = if now < first.1 { "before-start" } else { "at" };
        return Some(json::Position { state, ..at(0, basis_at(first.0)) });
    }
    if now >= last.1 {
        return Some(json::Position { state: "ended", ..at(n - 1, basis_at(last.0)) });
    }
    for (k, w) in served.windows(2).enumerate() {
        let ((i, a_i, d_i), (j, a_j, _)) = (w[0], w[1]);
        if now >= a_i && now < d_i {
            return Some(at(k, basis_at(i)));
        }
        if now >= d_i && now < a_j {
            let span = (a_j - d_i).max(1);
            let est = ((now - d_i) as f32 / span as f32).clamp(0.0, 1.0);
            let basis = if !f.live { "timetable" } else if measured(i, OBSERVED_DEP) { "observed-stop" } else { "forecast" };
            return Some(json::Position {
                state: "between",
                seq: i as u16,
                from: pos(i),
                to: pos(j),
                frac: est,
                basis,
                t: now,
                next_seq: Some(j as u16),
                dep: Some(d_i),
                arr: Some(a_j),
            });
        }
    }
    Some(at(n - 1, basis_at(last.0)))
}

/// Line badge of an extra journey ("EV", "S 1", "IC 8").
pub fn extra_badge(e: &ExtraTrip) -> json::LineBadge {
    let category: String = e.line.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
    json::LineBadge { name: e.line.clone(), category, mode: e.mode.map(|m| m.as_str()).unwrap_or("other"), operator: String::new() }
}

/// Station names after call `i` (each station once), for what a display shows.
fn vias(app: &App, stops: impl Iterator<Item = StopIdx>, own: StationIdx, n: usize) -> Vec<String> {
    let tt = &app.tt;
    let mut out: Vec<String> = Vec::new();
    for s in stops {
        let st = tt.stops[s as usize].station;
        let name = &tt.stations[st as usize].name;
        if st != own && out.last() != Some(name) {
            out.push(name.clone());
        }
        if out.len() >= n {
            break;
        }
    }
    out
}

// ------------------------------------------------------------------ /api/due

pub struct DueQuery {
    pub stops: Vec<StopIdx>,
    pub t: i64,
    pub before: i64,
    pub after: i64,
    pub limit: usize,
}

pub fn due(app: &App, q: &DueQuery) -> json::DueResponse {
    let tt = &app.tt;
    let live_arc = app.live_view();
    let live = live_arc.as_deref();
    let ages = feed_age(app);
    let (date, secs) = time::from_unix(q.t - q.before);
    let mut out: Vec<json::Due> = Vec::new();
    let mut seen: std::collections::HashSet<(String, Date, usize)> = Default::default();
    let in_set = |s: StopIdx| q.stops.contains(&s);
    let trip_item = |run: &Run, trip: TripIdx, pos: usize, delay: Option<i32>| {
        let t = &tt.trips[trip as usize];
        let number = tt.str(t.short_name);
        due_item(app, run, pos, app.line_badge(trip), tt.str(t.headsign).to_string(), (!number.is_empty()).then(|| number.to_string()), ages, q.t, delay)
    };
    // Departures from every boarding point of these stations: a changed platform
    // can bring a train to one of the asked ones (and take it away from another).
    let mut all: Vec<StopIdx> = q.stops.iter().flat_map(|&s| tt.stations[tt.stops[s as usize].station as usize].stops.iter().copied()).collect();
    all.sort_unstable();
    all.dedup();
    for e in app.router.departures(&all, date, secs, 600, live) {
        let dep = time::to_unix(date, e.live_dep);
        if dep > q.t + q.after {
            break;
        }
        let tl = live.and_then(|l| l.trip(e.date, e.trip));
        let run = Run::of_trip(app, e.trip, e.date, tl);
        let pos = e.pos as usize;
        if !in_set(run.calls[pos].stop) || !seen.insert((run.id.clone(), e.date, pos)) {
            continue;
        }
        out.push(trip_item(&run, e.trip, pos, Some(e.live_dep - e.dep)));
    }
    // Vehicles under way that will stop here only to set down (e.g. at the end of their
    // run): they are not departures. Those not yet under way are not listed.
    let mut area = BBox::empty();
    for &s in &q.stops {
        area.extend(&tt.stops[s as usize].pos);
    }
    if !q.stops.is_empty() {
        let c = area.min.lerp(&area.max, 0.5);
        let (now_date, now_secs) = time::from_unix(q.t);
        for v in app.router.vehicles(&BBox::around(c, 4000.0), now_date, now_secs, live) {
            let tl = live.and_then(|l| l.trip(v.date, v.trip));
            let run = Run::of_trip(app, v.trip, v.date, tl);
            for k in v.pos as usize..run.calls.len() {
                let c = &run.calls[k];
                let Some(a) = c.arr else { continue };
                if a > q.t + q.after {
                    break;
                }
                if in_set(c.stop) && a >= q.t - q.before && seen.insert((run.id.clone(), v.date, k)) {
                    out.push(trip_item(&run, v.trip, k, None));
                }
            }
        }
    }
    if let Some(l) = live {
        for x in l.extras() {
            if x.cancelled {
                continue;
            }
            for (i, c) in x.calls.iter().enumerate() {
                let (Some(at), Some(leaves)) = (c.at(), c.leaves()) else { continue };
                if in_set(c.stop) && leaves >= q.t - q.before && at <= q.t + q.after {
                    let run = Run::of_extra(x);
                    let delay = c.dep.zip(c.aimed_dep).or(c.arr.zip(c.aimed_arr)).map(|(t, a)| (t - a) as i32);
                    out.push(due_item(app, &run, i, extra_badge(x), x.headsign.clone(), None, ages, q.t, delay));
                }
            }
        }
    }
    out.sort_by_key(|d| d.arr.or(d.dep).unwrap_or(i64::MAX));
    out.truncate(q.limit);
    json::DueResponse { t: q.t, due: out }
}

#[allow(clippy::too_many_arguments)]
fn due_item(app: &App, run: &Run, i: usize, line: json::LineBadge, headsign: String, number: Option<String>, ages: FeedAges, now: i64, delay: Option<i32>) -> json::Due {
    let tt = &app.tt;
    let c = &run.calls[i];
    let here = &tt.stops[c.stop as usize];
    let arr = c.arr.or(c.dep);
    let dep = c.dep;
    let state = match (arr, dep) {
        (Some(a), _) if now < a => "approaching",
        (_, Some(d)) if now <= d => "at-stop",
        (Some(a), None) if now <= a + 60 => "at-stop",
        _ => "departed",
    };
    let bearing = |a: usize, b: usize| {
        let (pa, pb) = (&tt.stops[run.calls[a].stop as usize].pos, &tt.stops[run.calls[b].stop as usize].pos);
        (pa.dist_m(pb) > 5.0).then(|| pa.bearing_deg(pb).round())
    };
    json::Due {
        trip_id: run.id.clone(),
        service_date: time::fmt_date(run.date),
        seq: i as u16,
        line,
        headsign,
        number,
        vias: vias(app, run.calls[i + 1..].iter().filter(|c| !c.skipped).map(|c| c.stop), here.station, 3),
        quay_id: here.gtfs_id.clone(),
        quay_label: here.label.clone(),
        planned_label: c.planned.map(|p| tt.stops[p as usize].label.clone()),
        arr,
        dep,
        delay_s: delay.filter(|_| run.calls[i].live),
        cancelled: run.cancelled || c.skipped,
        approach_bearing: (i > 0).then(|| bearing(i - 1, i)).flatten(),
        depart_bearing: (i + 1 < run.calls.len()).then(|| bearing(i, i + 1)).flatten(),
        state,
        eta_s: arr.map(|a| a - now).unwrap_or(0),
        live_info: live_info(&run.facts, ages, now),
        extra: run.extra,
    }
}

// ------------------------------------------------------------------ /api/match

pub struct MatchQuery<'a> {
    pub from: StationIdx,
    pub dep: i64,
    pub to: Option<StationIdx>,
    pub arr: Option<i64>,
    pub line: &'a str,
    pub number: &'a str,
}

fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(|c| c.to_lowercase()).collect()
}

/// The timetable trip that leaves `from` at `dep` (scheduled) and, if given,
/// reaches `to` at `arr`; only a unique answer is a match.
pub fn match_trip(app: &App, q: &MatchQuery) -> json::MatchResponse {
    const TOL: i64 = 60;
    let tt = &app.tt;
    let stops = &tt.stations[q.from as usize].stops;
    let (date, secs) = time::from_unix(q.dep - TOL);
    let line = norm(q.line);
    let number = norm(q.number);
    // Long-distance trains often come as category + train number ("IC000905").
    let digits: String = line.chars().filter(|c| c.is_ascii_digit()).collect::<String>().trim_start_matches('0').to_string();
    // (trip, date, from_pos, to_pos, line fits, number fits, then)
    let mut found: Vec<Found> = Vec::new();
    for e in app.router.departures(stops, date, secs, 200, None) {
        let dep = time::to_unix(date, e.dep);
        if dep > q.dep + TOL {
            break;
        }
        if (dep - q.dep).abs() > TOL || found.iter().any(|f| f.trip == e.trip && f.date == e.date) {
            continue;
        }
        // Where the ride ends: on this trip, or on a trip it continues as (stay seated).
        let (to_pos, then) = match q.to {
            Some(to) => match reach(app, e.trip, e.date, e.pos as usize + 1, to, q.arr, TOL) {
                Some(r) => r,
                None => continue,
            },
            None => (None, Vec::new()),
        };
        let l = tt.trip_line(e.trip);
        let line_fits = line.is_empty() || norm(&l.name) == line || norm(&format!("{}{}", l.category, l.name)) == line || norm(&l.category) == line;
        let t = &tt.trips[e.trip as usize];
        let short = norm(tt.str(t.short_name));
        let number_fits = (!number.is_empty() && short.trim_start_matches('0') == number.trim_start_matches('0')) || (!digits.is_empty() && short.trim_start_matches('0') == digits);
        found.push(Found { trip: e.trip, date: e.date, from: e.pos, to: to_pos, line_fits, number_fits, then });
    }
    // Narrow by the train number, then by the line, while that leaves something.
    let mut pool: Vec<&Found> = found.iter().collect();
    for keep in [|f: &&Found| f.number_fits, |f: &&Found| f.line_fits] {
        let narrowed: Vec<&Found> = pool.iter().copied().filter(keep).collect();
        if !narrowed.is_empty() {
            pool = narrowed;
        }
    }
    if !line.is_empty() && !pool.iter().any(|f| f.line_fits || f.number_fits) {
        pool.clear(); // a line was given and none of the trips is it
    }
    match pool.as_slice() {
        [f] => json::MatchResponse {
            matched: Some(json::MatchRef {
                trip_id: tt.trip_gtfs_id(f.trip).to_string(),
                service_date: time::fmt_date(f.date),
                from_seq: f.from,
                to_seq: f.to,
                then: f.then.clone(),
            }),
            candidates: 1,
            reason: "unique",
        },
        [] => json::MatchResponse { matched: None, candidates: 0, reason: "none" },
        many => json::MatchResponse { matched: None, candidates: many.len(), reason: "ambiguous" },
    }
}

struct Found {
    trip: TripIdx,
    date: Date,
    from: u16,
    to: Option<u16>,
    line_fits: bool,
    number_fits: bool,
    then: Vec<json::MatchNext>,
}

/// The position of station `to` on `trip` from `start` on, arriving at `arr`
/// (± `tol`) if given; else on the trips it continues as (at most three). →
/// (position on `trip`, or None when the ride ends on a continuation; the
/// continuations ridden, the last one with the position).
fn reach(app: &App, trip: TripIdx, date: Date, start: usize, to: StationIdx, arr: Option<i64>, tol: i64) -> Option<(Option<u16>, Vec<json::MatchNext>)> {
    let tt = &app.tt;
    let find = |t: TripIdx, d: Date, from: usize| {
        let pat = tt.pattern_stops(tt.trips[t as usize].pattern);
        (from..pat.len()).find(|&p| tt.stops[pat[p] as usize].station == to && arr.is_none_or(|a| (time::to_unix(d, tt.arr(t, p)) - a).abs() <= tol))
    };
    if let Some(p) = find(trip, date, start) {
        return Some((Some(p as u16), Vec::new()));
    }
    let mut chain = Vec::new();
    let (mut cur, mut d) = (trip, date);
    for _ in 0..3 {
        let next = tt.continuations_from(cur).iter().find_map(|c| {
            [d, d + 1, d - 1].into_iter().find(|&dd| (c.service == NONE || tt.service_active(c.service, d)) && tt.trip_active(c.to, dd)).map(|dd| (c.to, dd))
        });
        let (t, dd) = next?;
        let hit = find(t, dd, 1);
        chain.push(json::MatchNext { trip_id: tt.trip_gtfs_id(t).to_string(), service_date: time::fmt_date(dd), to_seq: hit.map(|p| p as u16) });
        if hit.is_some() {
            return Some((None, chain));
        }
        (cur, d) = (t, dd);
    }
    None
}

/// A station from a UIC/DiDok number (`8507000`) or an engine id (`st:…`).
pub fn station_of(app: &App, id: &str) -> Option<StationIdx> {
    if let Some(s) = id.strip_prefix("st:") {
        return app.station_ids.get(s).copied();
    }
    let n: u32 = id.trim().parse().ok()?;
    let mut keys = vec![n.to_string(), format!("Parent{n}")];
    if (8_500_000..8_600_000).contains(&n) {
        keys.insert(0, format!("Parentch:1:sloid:{}", n - 8_500_000));
        keys.insert(1, format!("ch:1:sloid:{}", n - 8_500_000));
    }
    keys.iter().find_map(|k| app.station_ids.get(k.as_str()).copied())
}

// ------------------------------------------------------------------ /api/vehicles, /api/stream

/// A vehicle as `/api/vehicles` lists it, everything taken from its position
/// (the same served hop), so geometry, fraction and times always agree.
#[allow(clippy::too_many_arguments)]
fn vehicle_of(app: &App, run: &Run, line: json::LineBadge, headsign: String, live: &'static str, ages: FeedAges, t: i64) -> Option<json::Vehicle> {
    let tt = &app.tt;
    let p = position(app, run, t)?;
    if p.state == "before-start" || p.state == "ended" {
        return None;
    }
    let next = p.next_seq.unwrap_or(p.seq) as usize;
    Some(json::Vehicle {
        trip_id: run.id.clone(),
        service_date: time::fmt_date(run.date),
        line,
        headsign,
        from: p.from,
        to: p.to,
        dep: p.dep.unwrap_or(t),
        arr: p.arr.unwrap_or(t),
        next_stop: tt.stations[tt.stops[run.calls[next].stop as usize].station as usize].name.clone(),
        next_seq: next as u16,
        live,
        frac: p.frac,
        basis: p.basis,
        live_info: live_info(&run.facts, ages, t),
        extra: run.extra,
    })
}

/// Every vehicle under way in `bbox` at `t`, timetable trips and extra journeys.
pub fn vehicles(app: &App, bbox: &BBox, t: i64) -> json::VehiclesResponse {
    const MAX: usize = 1500;
    let (date, secs) = time::from_unix(t);
    let live_arc = app.live_view();
    let live = live_arc.as_deref();
    let tt = &app.tt;
    let ages = feed_age(app);
    let mut out = Vec::new();
    for v in app.router.vehicles(bbox, date, secs, live) {
        if out.len() >= MAX {
            break;
        }
        let tl = live.and_then(|l| l.trip(v.date, v.trip));
        if tl.is_some_and(|l| l.cancelled) {
            continue;
        }
        let run = Run::of_trip(app, v.trip, v.date, tl);
        let tr = &tt.trips[v.trip as usize];
        out.extend(vehicle_of(app, &run, app.line_badge(v.trip), tt.str(tr.headsign).to_string(), App::live_state(tl), ages, t));
    }
    if let Some(l) = live {
        for x in l.extras() {
            if x.cancelled || out.len() >= MAX {
                continue;
            }
            let run = Run::of_extra(x);
            let Some(v) = vehicle_of(app, &run, extra_badge(x), x.headsign.clone(), if run.facts.observed_pos >= 0 { "observed" } else { "predicted" }, ages, t) else {
                continue;
            };
            let (a, b) = (LatLon::from_deg(v.from[1], v.from[0]), LatLon::from_deg(v.to[1], v.to[0]));
            if bbox.contains(&a) || bbox.contains(&b) {
                out.push(v);
            }
        }
    }
    json::VehiclesResponse { t, vehicles: out }
}

/// Departures of extra journeys from `stops` between `from` and `until` (unix).
pub fn extra_departures(app: &App, live: &dyn LiveView, stops: &[StopIdx], from: i64, until: i64) -> Vec<json::Departure> {
    let tt = &app.tt;
    let mut out = Vec::new();
    for x in live.extras() {
        let n = x.calls.len();
        for (i, c) in x.calls.iter().enumerate() {
            let Some(dep) = c.dep.filter(|_| i + 1 < n) else { continue };
            if !stops.contains(&c.stop) || dep < from || dep > until {
                continue;
            }
            let next = x.calls.get(i + 1);
            let here = &tt.stops[c.stop as usize];
            out.push(json::Departure {
                line: extra_badge(x),
                headsign: x.headsign.clone(),
                number: None,
                trip_id: x.id.clone(),
                service_date: time::fmt_date(x.date),
                seq: i as u16,
                dep: c.aimed_dep.unwrap_or(dep),
                live: true,
                delay_s: c.aimed_dep.map(|a| (dep - a) as i32),
                cancelled: x.cancelled || c.skipped,
                quay_id: here.gtfs_id.clone(),
                planned_label: None,
                towards: next.map(|n| tt.stations[n.station as usize].name.clone()),
                bearing: next.map(|n| here.pos.bearing_deg(&tt.stops[n.stop as usize].pos).round()),
                headway_s: None,
            });
        }
    }
    out
}

/// At most this many `/api/stream` connections are open at once.
pub const MAX_STREAMS: usize = 200;

/// One open stream; frees its place when dropped.
pub struct StreamSlot(Arc<App>);

impl StreamSlot {
    pub fn take(app: &Arc<App>) -> Option<StreamSlot> {
        use std::sync::atomic::Ordering;
        let n = app.streams.fetch_add(1, Ordering::SeqCst);
        if n >= MAX_STREAMS {
            app.streams.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(StreamSlot(app.clone()))
    }
}

impl Drop for StreamSlot {
    fn drop(&mut self) {
        self.0.streams.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Vehicles in `bbox` as server-sent events: at once, on every live update,
/// and at least every 15 s. The lists are computed off the request threads,
/// a few at a time.
pub fn stream(app: Arc<App>, bbox: BBox, slot: StreamSlot) -> impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>> {
    use axum::response::sse::Event;
    let rx = app.live_tx.subscribe();
    let stop = app.shutdown.subscribe();
    futures_util::stream::unfold((app, rx, stop, true, slot), move |(app, mut rx, mut stop, first, slot)| async move {
        if *stop.borrow() {
            return None;
        }
        if !first {
            let tick = tokio::time::sleep(std::time::Duration::from_secs(15));
            tokio::select! {
                r = rx.changed() => { r.ok()?; }
                _ = stop.changed() => return None,
                _ = tick => {}
            }
        }
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        let permit = app.heavy.acquire().await.ok()?;
        let a = app.clone();
        let body = tokio::task::spawn_blocking(move || vehicles(&a, &bbox, now)).await.ok()?;
        drop(permit);
        let ev = Event::default().event("vehicles").json_data(&body).unwrap_or_else(|_| Event::default().comment("error"));
        Some((Ok(ev), (app, rx, stop, false, slot)))
    })
}
