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

/// How far beyond the asked window `/api/vehicles` keeps a vehicle's way (metres): what it drives through between
/// two answers, and more.
pub const VEHICLE_WAY_PAD_M: f32 = 1500.0;

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
    /// Riders may board / get off here (the timetable's pickup and drop-off flags; never at the run's ends where
    /// there is nothing to board or leave).
    pub pickup: bool,
    pub dropoff: bool,
    /// As timetabled (for matching what was said with what was measured later, `livemap/measure/due_compare.py`).
    pub aimed_arr: Option<i64>,
    pub aimed_dep: Option<i64>,
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
    /// The timetable pattern (its shape is the way the vehicle takes); None for an extra journey.
    pub pattern: Option<PatternIdx>,
    /// The line's name as shown ("10", "S3"): hops borrowed from other patterns are its own line's first.
    pub line: String,
    /// The line's category ("T", "S", "IC"): how fast its vehicles speed up, brake and run (`motion`).
    pub category: String,
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
        let flags = tt.pattern_flags(tt.trips[trip as usize].pattern);
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
                    aimed_arr: (p > 0).then(|| time::to_unix(date, tt.arr(trip, p))),
                    aimed_dep: (p + 1 < n).then(|| time::to_unix(date, tt.dep(trip, p))),
                    pickup: p + 1 < n && flags.get(p).is_none_or(|f| f & FLAG_NO_PICKUP == 0),
                    dropoff: p > 0 && flags.get(p).is_none_or(|f| f & FLAG_NO_DROPOFF == 0),
                }
            })
            .collect();
        Run {
            mode: Some(tt.trip_line(trip).mode),
            pattern: Some(tt.trips[trip as usize].pattern),
            line: tt.trip_line(trip).name.clone(),
            category: tt.trip_line(trip).category.clone(),
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
                pickup: i + 1 < n,
                dropoff: i > 0,
                aimed_arr: if i > 0 { c.aimed_arr.or(c.aimed_dep) } else { None },
                aimed_dep: if i + 1 < n { c.aimed_dep.or(c.aimed_arr) } else { None },
            })
            .collect();
        Run { mode: e.mode, pattern: None, line: e.line.clone(), category: e.line.chars().take_while(|c| c.is_ascii_alphabetic()).collect(), id: e.id.clone(), date: e.date, calls, facts: LiveFacts::of_extra(e), cancelled: e.cancelled, extra: true }
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
    served_with_profiles_applied(app, run).0
}

/// [`served_with_profiles`], and whether a learned hop or dwell was used (the order clamp alone is not a profile).
fn served_with_profiles_applied(app: &App, run: &Run) -> (Vec<(usize, i64, i64)>, bool) {
    let mut served = run.served();
    let f = &run.facts;
    if f.observed_pos < 0 {
        return (served, false);
    }
    let Some(k) = served.iter().position(|s| s.0 == f.observed_pos as usize) else { return (served, false) };
    if k + 1 >= served.len() {
        return (served, false);
    }
    let mut applied = false;
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
            applied = true;
        }
    }
    if left_measured {
        if let Some(h) = prof.hop(a, b) {
            let left = served[k].2;
            let next = &mut served[k + 1];
            next.1 = left + h;
            next.2 = next.2.max(next.1);
            applied = true;
        }
    }
    // Keep every later stop in order after a change.
    for m in k + 1..served.len() {
        let before = served[m - 1].2;
        let s = &mut served[m];
        s.1 = s.1.max(before);
        s.2 = s.2.max(s.1);
    }
    (served, applied)
}

/// The way the vehicle of `run` takes from call `i` to call `j` (`i < j`) on the rails and roads, and whether some of
/// it is a straight line (a stop off the map); None where only the straight line is known. The pattern's own shape
/// where the run keeps to its boarding points; where one changed, or for an extra journey, the hops some pattern
/// makes between the same boarding points, of the same mode and the run's own line first (the pattern's shape when
/// there is none: the right line, a track off).
pub fn hop_way(app: &App, run: &Run, i: usize, j: usize) -> Option<(Vec<LatLon>, bool)> {
    let sh = app.shapes.as_ref()?;
    if i >= j || j >= run.calls.len() {
        return None;
    }
    let changed = run.calls[i..=j].iter().any(|c| c.planned.is_some());
    let own = || run.pattern.and_then(|p| sh.piece(p, i, j)).map(|w| (w.pts, w.straight));
    if !changed {
        if let Some(w) = own() {
            return Some(w);
        }
    }
    let mut pts: Vec<LatLon> = Vec::new();
    for k in i..j {
        let found = sh.borrow(&app.tt, run.mode, &run.line, run.calls[k].stop, run.calls[k + 1].stop).and_then(|(p, pos)| sh.piece(p, pos, pos + 1));
        let Some(w) = found else { return own() };
        let skip = usize::from(pts.last() == w.pts.first());
        pts.extend_from_slice(&w.pts[skip..]);
    }
    // borrowed hops are on the network (`borrow` takes only those)
    Some((pts, false))
}

/// The way of `run` from call `from` to call `to`, hop by hop ([`hop_way`]; a hop without one is the straight line
/// between where the vehicle stands at its ends): (points as [lon, lat], each call's vertex, the hops that are
/// straight lines, by the call they start at). None where no hop has a way.
pub fn run_path(app: &App, run: &Run, from: usize, to: usize) -> Option<(Vec<[f64; 2]>, Vec<u32>, Vec<u16>)> {
    app.shapes.as_ref()?;
    let mut pts: Vec<LatLon> = Vec::new();
    let mut at = Vec::with_capacity(to + 1 - from);
    let mut straight = Vec::new();
    let mut any = false;
    let stand = |i: usize| anchor(app, run, i).unwrap_or(app.tt.stops[run.calls[i].stop as usize].pos);
    for k in from..to {
        let (w, flat) = match hop_way(app, run, k, k + 1) {
            Some((w, s)) => {
                any = true;
                (w, s)
            }
            None => (vec![stand(k), stand(k + 1)], true),
        };
        if flat {
            straight.push((k - from) as u16);
        }
        if pts.is_empty() {
            at.push(0);
        }
        let skip = usize::from(!pts.is_empty() && pts.last() == w.first());
        pts.extend_from_slice(&w[skip..]);
        at.push(pts.len() as u32 - 1);
    }
    if !any {
        return None;
    }
    Some((pts.iter().map(lonlat).collect(), at, straight))
}

/// Where the vehicle of `run` stands at call `i`, on its track or road (None where not known).
pub fn anchor(app: &App, run: &Run, i: usize) -> Option<LatLon> {
    let sh = app.shapes.as_ref()?;
    let c = run.calls.get(i)?;
    if c.planned.is_none() {
        if let Some(a) = run.pattern.and_then(|p| sh.anchor(p, i)) {
            return Some(a);
        }
    }
    let borrow = |a: StopIdx, b: StopIdx| sh.borrow(&app.tt, run.mode, &run.line, a, b);
    let next = (i + 1 < run.calls.len()).then(|| borrow(c.stop, run.calls[i + 1].stop)).flatten();
    let prev = (i > 0).then(|| borrow(run.calls[i - 1].stop, c.stop)).flatten().map(|(p, pos)| (p, pos + 1));
    next.or(prev).and_then(|(p, pos)| sh.anchor(p, pos))
}

/// The point a share `f` (0..=1) of the way along `pts`, and the bearing of travel there (None on a way of no length).
pub fn along(pts: &[LatLon], f: f32) -> (LatLon, Option<f32>) {
    let lens: Vec<f32> = pts.windows(2).map(|w| w[0].dist_m(&w[1])).collect();
    let total: f32 = lens.iter().sum();
    if pts.len() < 2 || total <= 0.0 {
        return (pts.first().copied().unwrap_or(LatLon::NONE), None);
    }
    let goal = total * f.clamp(0.0, 1.0);
    let mut acc = 0.0;
    for (k, &l) in lens.iter().enumerate() {
        if l > 0.0 && (acc + l >= goal || k + 1 == lens.len()) {
            let t = ((goal - acc) / l).clamp(0.0, 1.0);
            return (pts[k].lerp(&pts[k + 1], t), Some(pts[k].bearing_deg(&pts[k + 1]).round()));
        }
        acc += l;
    }
    (pts[pts.len() - 1], None)
}

/// Where the vehicle of `run` is at `now`.
pub fn position(app: &App, run: &Run, now: i64) -> Option<json::Position> {
    position_way(app, run, now).map(|(mut p, way)| {
        p.hop_path = way.map(kante_shapes::encode);
        p
    })
}

/// The part of `pts` near `bbox` (within `pad` metres; with the point before and after, so the vehicle runs on
/// into and out of the window), and the share of the whole way's length it starts and ends at. None for the span
/// when it is the whole way.
pub fn clip_way(pts: &[LatLon], bbox: &BBox, pad: f32) -> (Vec<LatLon>, Option<[f32; 2]>) {
    let n = pts.len();
    if n < 3 {
        return (pts.to_vec(), None);
    }
    let mut grown = *bbox;
    let corner_a = BBox::around(bbox.min, pad);
    let corner_b = BBox::around(bbox.max, pad);
    grown.extend(&corner_a.min);
    grown.extend(&corner_b.max);
    let inside: Vec<bool> = pts.iter().map(|q| grown.contains(q)).collect();
    // segments crossing the box with both ends outside: keep both ends
    let hit = |k: usize| inside[k] || inside[k + 1] || {
        let mut s = BBox::empty();
        s.extend(&pts[k]);
        s.extend(&pts[k + 1]);
        s.intersects(&grown)
    };
    let (Some(first), Some(last)) = ((0..n - 1).find(|&k| hit(k)), (0..n - 1).rev().find(|&k| hit(k))) else {
        return (pts.to_vec(), None);
    };
    let (a, b) = (first, last + 1);
    if a == 0 && b == n - 1 {
        return (pts.to_vec(), None);
    }
    let mut cum = vec![0.0f32; n];
    for k in 1..n {
        cum[k] = cum[k - 1] + pts[k - 1].dist_m(&pts[k]);
    }
    let total = cum[n - 1].max(0.01);
    (pts[a..=b].to_vec(), Some([cum[a] / total, cum[b] / total]))
}

/// Metres from call `i` to call `j` on the way the vehicle takes (the straight line, a little longer, where not known).
fn hop_len(app: &App, run: &Run, i: usize, j: usize) -> f32 {
    // the pattern's own way, measured once (no points to put together)
    if let (Some(sh), Some(p)) = (app.shapes.as_ref(), run.pattern) {
        if !run.calls[i..=j].iter().any(|c| c.planned.is_some()) {
            if let Some(m) = sh.piece_len(p, i, j) {
                return m;
            }
        }
    }
    let len = |pts: &[LatLon]| pts.windows(2).map(|w| w[0].dist_m(&w[1])).sum::<f32>();
    match hop_way(app, run, i, j) {
        Some((pts, false)) => len(&pts),
        _ => {
            let pos = |k: usize| app.tt.stops[run.calls[k].stop as usize].pos;
            pos(i).dist_m(&pos(j)) * 1.2
        }
    }
}

/// The stops `run` serves with their times, made physically possible (`motion::feasible`: a hop gets the time its
/// vehicle needs to speed up, run and brake, borrowed from the stops beside it; measured times stay). Over the whole
/// run, so the times of a hop are the same whenever it is asked about (worked out only around `now`, a hop leaving
/// that window took the time it had pushed on later stops with it: the vehicle jumped).
fn served_at(app: &App, run: &Run, _now: i64) -> Vec<(usize, i64, i64)> {
    let mut served = served_with_profiles(app, run);
    if let Some(m) = crate::motion::of(run.mode, &run.category) {
        let f = &run.facts;
        let measured = |i: usize, kind: u8| f.observed_pos >= 0 && ((f.observed_pos as usize) > i || (f.observed_pos as usize == i && f.observed_kind & kind != 0));
        let idx: Vec<usize> = served.iter().map(|s| s.0).collect();
        crate::motion::feasible(
            &mut served,
            &m,
            i64::MIN,
            i64::MAX,
            |k| Some(hop_len(app, run, idx[k], idx[k + 1])),
            |k| measured(idx[k], OBSERVED_DEP),
            |k| measured(idx[k], OBSERVED_ARR),
        );
    }
    served
}

/// How vehicle of `run` moves on the hop from `i` to `j`, `t` seconds long, of `len` metres: [accel, brake, cruise]
/// (m/s², m/s², m/s) and the share of the way it has gone `tau` seconds in (a share of the time without a motion).
fn hop_motion(run: &Run, len: f32, t: f32, tau: f32) -> (Option<[f32; 3]>, f32) {
    let uniform = if t > 0.0 { (tau / t).clamp(0.0, 1.0) } else { 1.0 };
    match crate::motion::of(run.mode, &run.category).and_then(|m| m.cruise(len, t).map(|v| (m, v))) {
        Some((m, v)) if v > 0.0 => (Some([m.accel, m.brake, v]), crate::motion::share_at(m.accel, m.brake, v, len, t, tau.clamp(0.0, t))),
        _ => (None, uniform),
    }
}

fn position_way(app: &App, run: &Run, now: i64) -> Option<(json::Position, Option<Vec<LatLon>>)> {
    position_on(app, run, now, &served_at(app, run, now))
}

/// [`position_way`] on the stops and times `served` ([`served_at`]).
fn position_on(app: &App, run: &Run, now: i64, served: &[(usize, i64, i64)]) -> Option<(json::Position, Option<Vec<LatLon>>)> {
    let tt = &app.tt;
    let pos = |i: usize| lonlat(&tt.stops[run.calls[i].stop as usize].pos);
    let first = *served.first()?;
    let last = *served.last()?;
    let f = &run.facts;
    let measured = |i: usize, kind: u8| f.observed_pos >= 0 && ((f.observed_pos as usize) > i || (f.observed_pos as usize == i && f.observed_kind & kind != 0));
    let at = |k: usize, basis: &'static str| {
        let (i, a, d) = served[k];
        let point = anchor(app, run, i).map(|p| lonlat(&p));
        json::Position {
            motion: None,
            hop_len: None,
            state: "at",
            seq: i as u16,
            from: pos(i),
            to: pos(i),
            frac: 0.0,
            basis,
            t: now,
            next_seq: None,
            dep: Some(d),
            arr: Some(a),
            hop_path: None,
            hop_straight: false,
            hop_span: None,
            point,
            heading: None,
        }
    };
    let basis_at = |i: usize| if !f.live { "timetable" } else if measured(i, OBSERVED_ARR) { "observed-stop" } else { "forecast" };
    let n = served.len();
    if now < first.2 {
        let state = if now < first.1 { "before-start" } else { "at" };
        return Some((json::Position { state, ..at(0, basis_at(first.0)) }, None));
    }
    if now >= last.1 {
        return Some((json::Position { state: "ended", ..at(n - 1, basis_at(last.0)) }, None));
    }
    for (k, w) in served.windows(2).enumerate() {
        let ((i, a_i, d_i), (j, a_j, _)) = (w[0], w[1]);
        if now >= a_i && now < d_i {
            return Some((at(k, basis_at(i)), None));
        }
        if now >= d_i && now < a_j {
            let span = (a_j - d_i).max(1);
            let est = ((now - d_i) as f32 / span as f32).clamp(0.0, 1.0);
            let basis = if !f.live { "timetable" } else if measured(i, OBSERVED_DEP) { "observed-stop" } else { "forecast" };
            // on the way the vehicle takes: away from the stop speeding up, braking into the next (motion.rs)
            let way = hop_way(app, run, i, j);
            let len = match &way {
                Some((pts, false)) => pts.windows(2).map(|w| w[0].dist_m(&w[1])).sum::<f32>(),
                _ => hop_len(app, run, i, j),
            };
            let (motion, share) = hop_motion(run, len, span as f32, (now - d_i) as f32);
            let (point, heading) = match &way {
                Some((pts, _)) => {
                    let (p, h) = along(pts, share);
                    (Some(lonlat(&p)), h)
                }
                None => (None, None),
            };
            return Some((
                json::Position {
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
                    hop_straight: way.as_ref().is_some_and(|w| w.1),
                    hop_path: None,
                    hop_span: None,
                    point,
                    heading,
                    motion,
                    hop_len: motion.map(|_| len.round()),
                },
                way.map(|w| w.0),
            ));
        }
    }
    Some((at(n - 1, basis_at(last.0)), None))
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
    /// The rider's stop: each entry then says whether it calls there after this stop (`servesTo`).
    pub to: Option<StationIdx>,
}

/// Every live feed the engine reads answered within [`STALE_S`], with a document of its own no older than that (a
/// source can keep serving a frozen one), and there is at least one.
fn feeds_fresh(app: &App) -> bool {
    let now = wall_clock();
    let live = app.live.read();
    all_fresh(live.meta.feeds.iter().map(|f| (f.polled_at, f.updated_at)), now)
}

fn all_fresh(feeds: impl Iterator<Item = (Option<i64>, Option<i64>)>, now: i64) -> bool {
    let mut any = false;
    for (polled, updated) in feeds {
        any = true;
        let recent = |t: Option<i64>| t.is_some_and(|t| now - t <= STALE_S);
        if !recent(polled) || !recent(updated) {
            return false;
        }
    }
    any
}

/// How many departures are looked at; reaching it before the end of the window makes the board incomplete.
const DEPARTURE_SCAN: usize = 600;

/// Whether a run lets riders off at station `to` later: it stops there (not skipped today) and allows getting off.
/// `calls`: (station, skipped, drop-off allowed) of each call after this one.
fn calls_after(calls: impl Iterator<Item = (StationIdx, bool, bool)>, to: StationIdx) -> bool {
    calls.into_iter().any(|(st, skipped, dropoff)| st == to && !skipped && dropoff)
}

/// How far past the window a forecast is still looked at: the profiles can bring a call forward into it.
const PROFILE_MARGIN_S: i64 = 600;

/// The moments the vehicles under way are looked at for a window: every 120 s from `from`, and `to` itself.
fn snapshot_moments(from: i64, to: i64) -> Vec<i64> {
    let mut m: Vec<i64> = (0..).map(|k| from + 120 * k).take_while(|&t| t < to).collect();
    m.push(to);
    m
}

/// The time at call `i` from [`served_with_profiles`] where the profiles changed it (compared with the same calls
/// without them): `(arr, dep)`, `dep` kept absent where the run has none there (it ends here).
fn profiled_times(profiled: &[(usize, i64, i64)], plain: &[(usize, i64, i64)], i: usize, dep: Option<i64>) -> Option<(Option<i64>, Option<i64>)> {
    let &(_, a, d) = profiled.iter().find(|s| s.0 == i)?;
    let &(_, pa, pd) = plain.iter().find(|s| s.0 == i)?;
    ((a, d) != (pa, pd)).then_some((Some(a), dep.map(|_| d)))
}

pub fn due(app: &App, q: &DueQuery) -> json::DueResponse {
    let live_arc = app.live_view();
    due_in(app, live_arc.as_deref(), q)
}

/// [`due`] on a given live snapshot (so a caller can use one snapshot throughout).
pub fn due_in(app: &App, live: Option<&dyn LiveView>, q: &DueQuery) -> json::DueResponse {
    let tt = &app.tt;
    let ages = feed_age(app);
    let (date, secs) = time::from_unix(q.t - q.before);
    let mut out: Vec<json::Due> = Vec::new();
    let mut seen: std::collections::HashSet<(String, Date, usize)> = Default::default();
    let in_set = |s: StopIdx| q.stops.contains(&s);
    let trip_item = |run: &Run, trip: TripIdx, pos: usize, delay: Option<i32>| {
        let t = &tt.trips[trip as usize];
        let number = tt.str(t.short_name);
        due_item(app, run, pos, app.line_badge(trip), tt.str(t.headsign).to_string(), (!number.is_empty()).then(|| number.to_string()), ages, q.t, delay, q.to)
    };
    // Departures from every boarding point of these stations: a changed platform
    // can bring a train to one of the asked ones (and take it away from another).
    let mut all: Vec<StopIdx> = q.stops.iter().flat_map(|&s| tt.stations[tt.stops[s as usize].station as usize].stops.iter().copied()).collect();
    all.sort_unstable();
    all.dedup();
    let events = app.router.departures(&all, date, secs, DEPARTURE_SCAN, live);
    // the scan stopped at its count before the end of the window: later departures are missing
    let mut capped = events.len() >= DEPARTURE_SCAN;
    for e in events {
        let dep = time::to_unix(date, e.live_dep);
        if dep > q.t + q.after + PROFILE_MARGIN_S {
            capped = false;
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
    // Vehicles that stop here only to set down (e.g. at the end of their run): they are not
    // departures. Found among the vehicles under way at the start of the window and now, so one
    // that has just ended its run here is still listed. Those not yet under way are not.
    let mut area = BBox::empty();
    for &s in &q.stops {
        area.extend(&tt.stops[s as usize].pos);
    }
    if !q.stops.is_empty() {
        let c = area.min.lerp(&area.max, 0.5);
        let mut under_way = Vec::new();
        // Every two minutes across the whole window: a short run that starts and ends inside it, or one coming from
        // further than the 4 km around, is under way within 4 km at one of them (a board without it would wrongly be
        // complete: a vehicle that only sets down here may show the rider's display).
        for moment in snapshot_moments(q.t - q.before, q.t + q.after) {
            let (d, s) = time::from_unix(moment);
            under_way.extend(app.router.vehicles(&BBox::around(c, 4000.0), d, s, live));
        }
        under_way.sort_unstable_by_key(|v| (v.trip, v.date, v.pos));
        under_way.dedup_by_key(|v| (v.trip, v.date));
        for v in under_way {
            let tl = live.and_then(|l| l.trip(v.date, v.trip));
            let run = Run::of_trip(app, v.trip, v.date, tl);
            for k in v.pos as usize..run.calls.len() {
                let c = &run.calls[k];
                let Some(a) = c.arr else { continue };
                if a > q.t + q.after + PROFILE_MARGIN_S {
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
                if in_set(c.stop) && leaves >= q.t - q.before && at <= q.t + q.after + PROFILE_MARGIN_S {
                    let run = Run::of_extra(x);
                    let delay = c.dep.zip(c.aimed_dep).or(c.arr.zip(c.aimed_arr)).map(|(t, a)| (t - a) as i32);
                    out.push(due_item(app, &run, i, extra_badge(x), x.headsign.clone(), None, ages, q.t, delay, q.to));
                }
            }
        }
    }
    // what is due in the window by its final (possibly profiled) time
    out.retain(|d| d.arr.or(d.dep).is_none_or(|a| a <= q.t + q.after));
    out.sort_by_key(|d| d.arr.or(d.dep).unwrap_or(i64::MAX));
    // A board cut at `limit` or built on a stale feed can be missing the vehicle in front of the camera: the
    // camera then never says "yours" (docs/ar-recognition-plan.md).
    let truncated = out.len() > q.limit || capped;
    out.truncate(q.limit);
    // complete only when this board was built on live data (the snapshot it used), and the feeds are fresh
    json::DueResponse { t: q.t, complete: !truncated && live.is_some() && feeds_fresh(app), truncated, due: out }
}

#[allow(clippy::too_many_arguments)]
fn due_item(app: &App, run: &Run, i: usize, line: json::LineBadge, headsign: String, number: Option<String>, ages: FeedAges, now: i64, delay: Option<i32>, to: Option<StationIdx>) -> json::Due {
    let tt = &app.tt;
    let c = &run.calls[i];
    let here = &tt.stops[c.stop as usize];
    // After a measured stop, the next calls are timed by the learned hop and dwell profiles (as `position`).
    let (mut arr, mut dep) = (c.arr.or(c.dep), c.dep);
    let forecast = (arr, dep);
    let mut profiled = false;
    if run.facts.observed_pos >= 0 && !c.skipped {
        let (with, applied) = served_with_profiles_applied(app, run);
        if let Some((a, d)) = profiled_times(&with, &run.served(), i, dep).filter(|_| applied) {
            (arr, dep, profiled) = (a, d, true);
        }
    }
    let station = |k: usize| tt.stops[run.calls[k].stop as usize].station;
    let serves_to = to.map(|to| calls_after((i + 1..run.calls.len()).map(|k| (station(k), run.calls[k].skipped, run.calls[k].dropoff)), to));
    let at = |k: usize| lonlat(&tt.stops[run.calls[k].stop as usize].pos);
    let served = |k: &usize| !run.calls[*k].skipped;
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
        profiled,
        forecast_arr: if profiled { forecast.0 } else { None },
        forecast_dep: if profiled { forecast.1 } else { None },
        aimed_arr: c.aimed_arr.or(c.aimed_dep),
        aimed_dep: c.aimed_dep,
        pickup: c.pickup && !c.skipped,
        serves_to,
        prev_stop: (0..i).rev().find(served).map(at),
        next_stop: (i + 1..run.calls.len()).find(served).map(at),
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
    // Ride on: the trips this one continues as (linked in the timetable), else (a train that
    // divides, which the timetable does not link) a trip leaving the same platform within ten
    // minutes. A step is only taken when it leads to `to`, and among unlinked trips only when
    // exactly one does — at the arrival time asked for.
    let mut chain = Vec::new();
    let (mut cur, mut d) = (trip, date);
    for _ in 0..3 {
        let pat = tt.pattern_stops(tt.trips[cur as usize].pattern);
        let last = pat.len() - 1;
        let end = time::to_unix(d, tt.arr(cur, last));
        // the service day on which a trip leaves at most 3 h after `end`
        let day_of = |t: TripIdx| {
            [d, d + 1, d - 1].into_iter().find(|&dd| {
                let dep = time::to_unix(dd, tt.dep(t, 0));
                tt.trip_active(t, dd) && dep >= end - 120 && dep <= end + 3 * 3600
            })
        };
        let linked: Vec<(TripIdx, Date)> = tt
            .continuations_from(cur)
            .iter()
            .filter(|c| c.service == NONE || tt.service_active(c.service, d))
            .filter_map(|c| day_of(c.to).map(|dd| (c.to, dd)))
            .collect();
        let pick = |cands: &[(TripIdx, Date)]| -> Option<(TripIdx, Date, Option<usize>)> {
            let hits: Vec<_> = cands.iter().filter_map(|&(t, dd)| find(t, dd, 1).map(|p| (t, dd, Some(p)))).collect();
            if hits.len() == 1 {
                return hits.into_iter().next();
            }
            None
        };
        let step = pick(&linked).or_else(|| {
            // A train that divides (RhB RE13 "St. Moritz | Davos Platz" at Klosters): the timetable
            // ends it and starts its parts as new trips without a link. Only for a train whose own
            // destination names several parts, only with the arrival time to check, and only a trip
            // that leaves the same platform (whatever the sectors) 0–10 min later towards one of them.
            let me = &tt.trips[cur as usize];
            if arr.is_none() || !matches!(tt.trip_line(cur).mode, Mode::Rail | Mode::RackRail) || divided_parts(tt.str(me.headsign)).len() < 2 {
                return None;
            }
            let parts = divided_parts(tt.str(me.headsign));
            let here = &tt.stops[pat[last] as usize];
            let track = |s: &kante_core::Stop| s.label.trim_end_matches(|c: char| c.is_ascii_alphabetic() || c == '-').to_string();
            let mine = track(here);
            if mine.is_empty() {
                return None;
            }
            let stops = &tt.stations[here.station as usize].stops;
            let (qd, qs) = time::from_unix(end);
            let onward: Vec<(TripIdx, Date)> = app
                .router
                .departures(stops, qd, qs, 400, None)
                .into_iter()
                .filter(|e| e.pos == 0 && e.trip != cur)
                .filter(|e| (0..=600).contains(&(time::to_unix(qd, e.dep) - end)))
                .filter(|e| track(&tt.stops[e.stop as usize]) == mine)
                .filter(|e| is_part(&parts, tt.str(tt.trips[e.trip as usize].headsign)))
                .map(|e| (e.trip, e.date))
                .collect();
            pick(&onward)
        });
        match step {
            Some((t, dd, hit)) => {
                chain.push(json::MatchNext { trip_id: tt.trip_gtfs_id(t).to_string(), service_date: time::fmt_date(dd), to_seq: hit.map(|p| p as u16) });
                return Some((None, chain));
            }
            None => {
                // no single onward trip reaches `to`: follow a lone linked continuation further
                let [(t, dd)] = linked.as_slice() else { return None };
                chain.push(json::MatchNext { trip_id: tt.trip_gtfs_id(*t).to_string(), service_date: time::fmt_date(*dd), to_seq: None });
                (cur, d) = (*t, *dd);
            }
        }
    }
    None
}

/// The destinations a dividing train names, one per part ("St. Moritz | Davos Platz").
pub fn divided_parts(headsign: &str) -> Vec<String> {
    headsign.split('|').map(norm).filter(|p| !p.is_empty()).collect()
}

/// Whether a trip headed for `headsign` is one of those parts.
pub fn is_part(parts: &[String], headsign: &str) -> bool {
    let h = norm(headsign);
    !h.is_empty() && parts.iter().any(|p| *p == h)
}

/// Run CPU-heavy work off the request threads, at most as many at once as `heavy` has
/// permits. The permit goes with the work: a request that is given up (the client went
/// away) does not free it while the work still runs. `None` when shutting down or the work failed.
pub async fn run_heavy<T: Send + 'static>(heavy: &Arc<tokio::sync::Semaphore>, work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let permit = heavy.clone().acquire_owned().await.ok()?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    })
    .await
    .ok()
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
fn vehicle_of(app: &App, run: &Run, line: json::LineBadge, headsign: String, live: &'static str, ages: FeedAges, t: i64, bbox: &BBox, near: bool) -> Option<json::Vehicle> {
    let tt = &app.tt;
    let served = served_at(app, run, t);
    let (p, way) = position_on(app, run, t, &served)?;
    // `near`: only where it is within reach of the box (a long hop's train can be 30 km off yet); before its ways are
    // cut and written
    if p.state == "before-start" || p.state == "ended" || (near && !point_near(p.point, bbox)) {
        return None;
    }
    // only the part of a long hop (an express train's 60 km) near the window asked about
    let (hop_path, hop_span) = match way {
        Some(w) => {
            let (part, span) = clip_way(&w, bbox, VEHICLE_WAY_PAD_M);
            (Some(kante_shapes::encode(part)), span)
        }
        None => (None, None),
    };
    let next = p.next_seq.unwrap_or(p.seq) as usize;
    // the hop after: from the stop it stands at (or is heading for) to the next one it serves, so a page can drive it
    // on through that stop until the next answer comes
    let onward = served.iter().position(|s| s.0 == next).and_then(|k| {
        let (&(_, _, dep), &(nj, arr, _)) = (served.get(k)?, served.get(k + 1)?);
        let way = hop_way(app, run, next, nj);
        let (hop_path, hop_span) = match &way {
            Some((w, _)) => {
                let (part, span) = clip_way(w, bbox, VEHICLE_WAY_PAD_M);
                (Some(kante_shapes::encode(part)), span)
            }
            None => (None, None),
        };
        let len = match &way {
            Some((w, false)) => w.windows(2).map(|x| x[0].dist_m(&x[1])).sum::<f32>(),
            _ => hop_len(app, run, next, nj),
        };
        let (motion, _) = hop_motion(run, len, (arr - dep) as f32, 0.0);
        Some(json::Onward {
            motion,
            hop_len: motion.map(|_| len.round()),
            next_seq: nj as u16,
            to: lonlat(&tt.stops[run.calls[nj].stop as usize].pos),
            dep,
            arr,
            hop_path,
            hop_straight: way.is_some_and(|w| w.1),
            hop_span,
        })
    });
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
        hop_path,
        hop_straight: p.hop_straight,
        hop_span,
        point: p.point,
        heading: p.heading,
        motion: p.motion,
        hop_len: p.hop_len,
        onward,
    })
}

/// The vehicle is within reach of `bbox` (`VEHICLE_WAY_PAD_M`: what it drives between two answers) where its place on
/// its way is known; otherwise as the straight hop found it.
fn point_near(point: Option<[f64; 2]>, bbox: &BBox) -> bool {
    let Some(p) = point else { return true };
    let mut grown = *bbox;
    grown.extend(&BBox::around(bbox.min, VEHICLE_WAY_PAD_M).min);
    grown.extend(&BBox::around(bbox.max, VEHICLE_WAY_PAD_M).max);
    grown.contains(&LatLon::from_deg(p[1], p[0]))
}

/// Every vehicle under way in `bbox` at `t`, timetable trips and extra journeys.
pub fn vehicles(app: &App, bbox: &BBox, t: i64) -> json::VehiclesResponse {
    let live_arc = app.live_view();
    vehicles_in(app, live_arc.as_deref(), bbox, t)
}

/// [`vehicles`] on a given live snapshot.
pub fn vehicles_in(app: &App, live: Option<&dyn LiveView>, bbox: &BBox, t: i64) -> json::VehiclesResponse {
    const MAX: usize = 1500;
    let (date, secs) = time::from_unix(t);
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
        // the router finds the hops whose way passes the box; the vehicle itself must be near it (a long hop's train
        // can be 30 km off yet)
        out.extend(vehicle_of(app, &run, app.line_badge(v.trip), tt.str(tr.headsign).to_string(), App::live_state(tl), ages, t, bbox, true));
    }
    if let Some(l) = live {
        for x in l.extras() {
            if x.cancelled || out.len() >= MAX {
                continue;
            }
            let run = Run::of_extra(x);
            let Some(v) = vehicle_of(app, &run, extra_badge(x), x.headsign.clone(), if run.facts.observed_pos >= 0 { "observed" } else { "predicted" }, ages, t, bbox, false) else {
                continue;
            };
            let (a, b) = (LatLon::from_deg(v.from[1], v.from[0]), LatLon::from_deg(v.to[1], v.to[0]));
            let on_way = v.point.is_some_and(|p| bbox.contains(&LatLon::from_deg(p[1], p[0])));
            if bbox.contains(&a) || bbox.contains(&b) || on_way {
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
        let a = app.clone();
        let body = run_heavy(&app.heavy, move || vehicles(&a, &bbox, now)).await?;
        let ev = Event::default().event("vehicles").json_data(&body).unwrap_or_else(|_| Event::default().comment("error"));
        Some((Ok(ev), (app, rx, stop, false, slot)))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_board_is_complete_only_while_every_feed_answers() {
        let ok = (Some(1000), Some(995));
        assert!(all_fresh([ok, (Some(990), Some(980))].into_iter(), 1000 + STALE_S - 25));
        assert!(!all_fresh([ok, (Some(500), Some(500))].into_iter(), 1000), "one feed stale");
        assert!(!all_fresh([ok, (None, None)].into_iter(), 1000), "one feed never answered");
        assert!(!all_fresh([ok, (Some(1000), Some(100))].into_iter(), 1000), "fetched, but the document is old (a frozen source)");
        assert!(!all_fresh(std::iter::empty(), 1000), "no live feed at all: timetable only");
    }

    #[test]
    fn vehicles_are_looked_for_across_the_whole_window() {
        assert_eq!(snapshot_moments(1000, 1300), vec![1000, 1120, 1240, 1300]);
        assert_eq!(snapshot_moments(1000, 1000), vec![1000]);
        assert!(snapshot_moments(0, 1200).windows(2).all(|w| w[1] - w[0] <= 120), "no gap longer than two minutes");
    }

    #[test]
    fn serves_the_stop_only_when_it_calls_there_later() {
        let calls = [(3, false, true), (7, true, true), (9, false, true), (11, false, false)];
        assert!(calls_after(calls.into_iter(), 9));
        assert!(!calls_after(calls.into_iter(), 7), "skipped there today");
        assert!(!calls_after(calls.into_iter(), 4), "not on its way");
        assert!(!calls_after(calls.into_iter(), 11), "no getting off there");
        assert!(calls_after([(11, false, false), (11, false, true)].into_iter(), 11), "a station it calls at twice: the call that lets riders off counts");
    }

    #[test]
    fn profiled_times_only_where_the_profile_changed_them() {
        let profiled = [(2, 100, 120), (3, 190, 200), (4, 260, 260)];
        let plain = [(2, 100, 120), (3, 210, 220), (4, 300, 300)];
        assert_eq!(profiled_times(&profiled, &plain, 3, Some(220)), Some((Some(190), Some(200))));
        assert_eq!(profiled_times(&profiled, &profiled, 3, Some(200)), None, "unchanged");
        assert_eq!(profiled_times(&profiled, &plain, 4, None), Some((Some(260), None)), "the end of the run has no departure");
        assert_eq!(profiled_times(&profiled, &plain, 5, None), None, "not served");
        assert_eq!(profiled_times(&profiled, &profiled, 2, Some(110)), None, "the served times' own clamping is not a profile");
    }

    #[test]
    fn only_a_train_that_names_its_parts_divides() {
        let parts = divided_parts("St. Moritz | Davos Platz");
        assert_eq!(parts.len(), 2);
        assert!(is_part(&parts, "St. Moritz"));
        assert!(is_part(&parts, "Davos Platz"));
        assert!(!is_part(&parts, "Landquart"), "another train leaving the same platform is not a part");
        assert_eq!(divided_parts("Bern").len(), 1, "a train with one destination does not divide");
        assert!(divided_parts("").is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_cancelled_request_keeps_its_permit_until_the_work_ends() {
        let heavy = Arc::new(tokio::sync::Semaphore::new(1));
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let h = heavy.clone();
        let req = tokio::spawn(async move {
            run_heavy(&h, move || {
                wait.recv().ok();
                done_tx.send(()).ok();
            })
            .await
        });
        // the work has started and holds the only permit
        while heavy.available_permits() > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        req.abort(); // the client went away
        let _ = req.await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(heavy.available_permits(), 0, "still running: the permit is not free");
        release.send(()).unwrap();
        done_rx.recv().unwrap();
        for _ in 0..100 {
            if heavy.available_permits() == 1 {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("the permit was not given back after the work ended");
    }
}
