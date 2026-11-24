//! Journey planning: endpoints → access/egress walks → RAPTOR → API journeys
//! with boarding points and walking geometry.

use crate::json::{self, Leg as JLeg};
use crate::state::{level_f, lonlat, App, Endpoint, Reach};
use kante_link::ends::{self, End};
use kante_core::time::{self, Date, Secs};
use kante_core::*;
use kante_raptor::{Journey, Leg, Onboard, Query};
use kante_walk::StepKind;
use std::time::Instant;

pub fn profile_from(o: &json::PlanOptions) -> WalkProfile {
    let stairs = match o.stairs.as_str() {
        "never" => StairsPref::Never,
        "avoid" => StairsPref::Avoid,
        _ => StairsPref::Ok,
    };
    WalkProfile {
        speed_mps: if o.walk_speed.is_finite() { o.walk_speed.clamp(0.4, 3.0) } else { DEFAULT_SPEED_MPS },
        stairs,
        escalators: o.escalators && !o.wheelchair,
        lifts: true,
        wheelchair: o.wheelchair,
        hills: match o.hills.as_str() {
            "ignore" => HillsPref::Ignore,
            "avoid" => HillsPref::Avoid,
            _ => HillsPref::Normal,
        },
        backwards: false,
    }
}

/// How a line is named in a sentence: "IC 8", "S3", "Bus 10", "Tram 9".
/// The feed's line name often already contains the category ("IC8").
pub fn line_title(l: &json::LineBadge) -> String {
    if l.name.is_empty() {
        return match l.mode {
            "cableway" => "Cableway".into(),
            "funicular" => "Funicular".into(),
            "boat" => "Boat".into(),
            "lift" => "Lift".into(),
            _ => l.category.clone(),
        };
    }
    let word = match l.mode {
        "bus" | "ondemand" => "Bus",
        "tram" => "Tram",
        "boat" => "Boat",
        "metro" => "Metro",
        _ => "",
    };
    let starts_alpha = l.name.chars().next().is_some_and(|c| c.is_alphabetic());
    if word.is_empty() || (starts_alpha && l.mode != "boat") {
        l.name.clone()
    } else {
        format!("{word} {}", l.name)
    }
}

/// The word travellers see on signs for a boarding point.
pub fn noun_word(noun: &str) -> &'static str {
    match noun {
        "track" => "platform",
        "bay" => "bay",
        "pier" => "pier",
        _ => "stop",
    }
}

fn mode_mask(o: &json::PlanOptions) -> u16 {
    match &o.modes {
        None => u16::MAX,
        Some(list) if list.is_empty() => u16::MAX,
        Some(list) => Mode::ALL.iter().filter(|m| list.iter().any(|s| s == m.as_str())).fold(0, |a, m| a | m.bit()),
    }
}

fn step_kind(k: StepKind) -> &'static str {
    match k {
        StepKind::Depart => "depart",
        StepKind::Walk => "walk",
        StepKind::Cross => "cross",
        StepKind::StairsUp => "stairs-up",
        StepKind::StairsDown => "stairs-down",
        StepKind::EscalatorUp => "escalator-up",
        StepKind::EscalatorDown => "escalator-down",
        StepKind::Lift => "lift",
        StepKind::RampUp => "ramp-up",
        StepKind::RampDown => "ramp-down",
        StepKind::Enter => "enter",
        StepKind::Exit => "exit",
        StepKind::Platform => "platform",
        StepKind::Arrive => "arrive",
    }
}

/// One end of a walk.
pub struct WalkEnd {
    pub name: String,
    pub pos: LatLon,
    pub stop: Option<StopIdx>,
    /// Its ways onto the walking network (the point itself, the doors of the building it is in).
    pub end: End,
}

impl App {
    fn stop_end(&self, s: StopIdx) -> WalkEnd {
        let stop = &self.tt.stops[s as usize];
        let station = &self.tt.stations[stop.station as usize];
        // A railway platform's registry point often lies on the track itself: a walk to it ends on the platform.
        let railish = Mode::Rail.bit() | Mode::Metro.bit() | Mode::RackRail.bit() | Mode::Funicular.bit();
        let end = match self.walk.as_ref() {
            Some(w) => End::stop(w, self.doors.as_ref(), stop.pos, self.link(s).map(|l| l.snap), stop.modes & railish != 0),
            None => End::exact(stop.pos, self.link(s).map(|l| l.snap)),
        };
        WalkEnd { name: station.name.clone(), pos: stop.pos, stop: Some(s), end }
    }

    fn door_json(&self, door: u32) -> Option<json::WalkDoor> {
        let ix = self.doors.as_ref()?;
        let d = &ix.doors.doors[door as usize];
        let addr = ix.doors.addr_of(door);
        Some(json::WalkDoor {
            lat: d.pos.lat_deg(),
            lon: d.pos.lon_deg(),
            kind: d.kind.as_str(),
            addr: (!addr.is_empty()).then(|| addr.to_string()),
            wheelchair: match d.wheelchair {
                DOOR_WC_YES => Some("yes"),
                DOOR_WC_NO => Some("no"),
                DOOR_WC_LIMITED => Some("limited"),
                _ => None,
            },
        })
    }

    fn walk_point(&self, e: &WalkEnd) -> json::WalkPoint {
        json::WalkPoint { name: e.name.clone(), lat: e.pos.lat_deg(), lon: e.pos.lon_deg(), quay: e.stop.map(|s| self.quay(s)) }
    }

    /// Build a walk leg between two points. `dep`/`arr` are the times the
    /// router planned with; the path is recomputed here for its geometry.
    pub fn walk_leg(&self, kind: &'static str, a: &WalkEnd, b: &WalkEnd, dep: i64, arr: i64, profile: &WalkProfile) -> json::WalkLeg {
        // a walk a journey has timed (to its first stop, from its last): the candidate the stop search took for that
        // time, the cheapest of those within it (ends::reach_costs)
        let limit = matches!(kind, "access" | "egress").then_some((arr - dep).max(0) as f32);
        self.walk_leg_within(kind, a, b, dep, arr, profile, limit)
    }

    /// [`App::walk_leg`], drawn as the walk this walker prefers when it takes at most `limit` seconds, else as the
    /// quickest ([`ends::walk_within`]).
    #[allow(clippy::too_many_arguments)]
    fn walk_leg_within(&self, kind: &'static str, a: &WalkEnd, b: &WalkEnd, dep: i64, arr: i64, profile: &WalkProfile, limit: Option<f32>) -> json::WalkLeg {
        let speed = profile.speed_mps;
        let mut leg = json::WalkLeg {
            kind,
            from: self.walk_point(a),
            to: self.walk_point(b),
            dep,
            arr,
            duration_s: (arr - dep).max(0),
            distance_m: 0,
            climb_m: 0,
            descent_m: 0,
            flatter: None,
            stairs_up: 0,
            stairs_down: 0,
            lifts: 0,
            escalators: 0,
            step_free: true,
            unmapped_level_changes: 0,
            slack_s: None,
            official_min_s: None,
            approximate: false,
            geometry: vec![],
            levels: vec![],
            steps: vec![],
            door: None,
            start_door: None,
            covered: vec![],
            approx_start: None,
            approx_end: None,
            network: None,
            no_step_free_door: false,
            unsure_end: false,
            drawn_s: None,
        };
        if a.stop.is_some() && a.stop == b.stop {
            leg.geometry = vec![lonlat(&a.pos), lonlat(&a.pos)];
            leg.levels = vec![None, None];
            return leg;
        }
        let walk = self.walk.as_ref().and_then(|w| ends::walk_within(w, &a.end, &b.end, profile, limit));
        match walk {
            Some(w) => {
                // from the point into the building's door and out of it, or straight onto the network; the path; on
                // to the door or the point at the other end (see kante_link::ends)
                let d = ends::draw(self.doors.as_ref(), &a.end, &b.end, &w);
                let p = &w.path;
                let shift = d.head;
                leg.geometry = d.geometry.iter().map(lonlat).collect();
                leg.levels = d.levels.iter().map(|l| level_f(*l)).collect();
                leg.approx_start = d.approx_start;
                leg.approx_end = d.approx_end;
                leg.network = Some([d.head, d.path_end]);
                leg.door = w.to.door.and_then(|o| self.door_json(o));
                leg.start_door = w.from.door.and_then(|o| self.door_json(o));
                leg.no_step_free_door = b.end.no_step_free_door;
                leg.unsure_end = w.from.unsure || w.to.unsure;
                leg.drawn_s = Some(w.secs.ceil() as i64);
                leg.covered = p.covered.iter().map(|&(v0, v1, c)| json::WalkCovered { kind: c.as_str(), from: v0 + shift, to: v1 + shift }).collect();
                let last_vertex = leg.geometry.len().saturating_sub(1) as u32;
                let n_steps = p.steps.len();
                leg.steps = p
                    .steps
                    .iter()
                    .enumerate()
                    .map(|(i, s)| json::WalkStep {
                        kind: step_kind(s.kind),
                        text: s.text.clone(),
                        dist_m: s.dist_m.round() as u32,
                        dur_s: walk_secs(s.cost.var_m, s.cost.fix_s, speed).round() as u32,
                        name: (!s.name.is_empty()).then(|| s.name.clone()),
                        level: level_f(s.level),
                        to_level: level_f(s.to_level).filter(|_| s.to_level != s.level),
                        from: if i == 0 { 0 } else { s.from + shift },
                        to: if i + 1 == n_steps { last_vertex } else { s.to + shift },
                    })
                    .collect();
                // Say where the walk ends in the traveller's terms.
                if let (Some(last), Some(q)) = (leg.steps.last_mut(), leg.to.quay.as_ref()) {
                    if last.kind == "arrive" {
                        let mut text = match (q.noun, q.label.is_empty()) {
                            (_, true) | ("stop", _) | ("edge", _) => format!("Arrive at the stop {}", q.station_name),
                            (noun, false) => format!("Arrive at {} {}", noun_word(noun), q.label),
                        };
                        if let Some(sec) = q.sectors.as_ref().filter(|_| !q.label.is_empty()) {
                            text.push_str(&format!(", sector {sec}"));
                        }
                        if let Some(side) = &q.side {
                            text.push_str(&format!(" — {}", side.text));
                        }
                        if let Some(l) = q.level.filter(|l| *l != 0.0) {
                            text.push_str(&format!(" (level {})", if l.fract() == 0.0 { format!("{}", l as i32) } else { format!("{l}") }).replace('-', "−"));
                        }
                        last.text = text;
                    }
                }
                if let (Some(last), Some(d)) = (leg.steps.last_mut(), leg.door.as_ref()) {
                    if last.kind == "arrive" {
                        last.text = match (&d.addr, d.kind) {
                            (Some(a), _) => format!("Arrive at the entrance, {a}"),
                            (None, "main") => "Arrive at the main entrance".to_string(),
                            _ => "Arrive at the entrance".to_string(),
                        };
                    }
                }
                leg.distance_m = w.dist_m.round() as u32;
                leg.climb_m = p.climb_m.round() as u32;
                leg.descent_m = p.descent_m.round() as u32;
                leg.stairs_up = p.stairs_up;
                leg.stairs_down = p.stairs_down;
                leg.lifts = p.lifts;
                leg.escalators = p.escalators;
                leg.unmapped_level_changes = p.unmapped_level_changes;
                leg.step_free = d.step_free;
                if kind == "direct" {
                    let secs = w.secs.ceil() as i64;
                    leg.duration_s = secs;
                    leg.arr = dep + secs;
                }
            }
            None => {
                let d = a.pos.dist_m(&b.pos);
                leg.approximate = true;
                leg.step_free = false;
                leg.distance_m = (d * 1.35).round() as u32;
                leg.geometry = vec![lonlat(&a.pos), lonlat(&b.pos)];
                leg.levels = vec![None, None];
                if kind == "direct" {
                    let secs = (d * 1.35 / speed).ceil() as i64;
                    leg.duration_s = secs;
                    leg.arr = dep + secs;
                }
                leg.steps = vec![json::WalkStep {
                    kind: "walk",
                    text: format!("Walk about {} m to {}", leg.distance_m, b.name),
                    dist_m: leg.distance_m,
                    dur_s: leg.duration_s as u32,
                    name: None,
                    level: None,
                    to_level: None,
                    from: 0,
                    to: 1,
                }];
            }
        }
        // Where a walk leg is finished for output (journeys of every kind, the walk-only answer, /api/walk): a leg
        // with a guessed end, or no path at all, is never step-free, and a step-free walker's journey says so
        // (unsure_alert)
        if leg.approx_start.is_some() || leg.approx_end.is_some() || leg.approximate {
            leg.step_free = false;
            leg.unsure_end = true;
        }
        leg
    }

    pub fn stop_call(&self, trip: TripIdx, date: Date, pos: usize, live: Option<&TripLive>) -> json::StopCall {
        let tt = &self.tt;
        let pat = tt.trips[trip as usize].pattern;
        let stops = tt.pattern_stops(pat);
        let flags = tt.pattern_flags(pat)[pos];
        let planned = stops[pos];
        let actual = live.and_then(|l| l.quay.get(pos).copied()).filter(|&q| q != NONE && q != planned);
        let n = stops.len();
        json::StopCall {
            seq: pos as u16,
            quay: self.quay(actual.unwrap_or(planned)),
            arr: (pos > 0).then(|| time::to_unix(date, tt.arr(trip, pos))),
            dep: (pos + 1 < n).then(|| time::to_unix(date, tt.dep(trip, pos))),
            // only where the time is live: before the feed's first report it is the timetable's
            arr_delay_s: live.filter(|l| pos > 0 && l.is_live_at(pos)).map(|l| l.arr_delay_at(pos)),
            dep_delay_s: live.filter(|l| pos + 1 < n && l.is_live_at(pos)).map(|l| l.dep_delay_at(pos)),
            planned_label: actual.map(|_| tt.stops[planned as usize].label.clone()),
            skipped: live.map(|l| l.is_skipped(pos)).unwrap_or(false),
            on_request: flags & (FLAG_PICKUP_ON_REQUEST | FLAG_DROPOFF_ON_REQUEST) != 0,
            live: live.is_some_and(|l| l.is_live_at(pos)),
        }
    }

    pub fn live_state(live: Option<&TripLive>) -> &'static str {
        match live {
            Some(l) if l.observed_pos >= 0 => "observed",
            Some(_) => "predicted",
            None => "timetable",
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn ride_leg(&self, trip: TripIdx, date: Date, from_pos: usize, to_pos: usize, stay: bool, onboard: bool, live: Option<&dyn LiveView>) -> json::RideLeg {
        let tt = &self.tt;
        let t = &tt.trips[trip as usize];
        let tl = live.and_then(|l| l.trip(date, trip));
        let stops = tt.pattern_stops(t.pattern);
        let calls: Vec<json::StopCall> = (from_pos..=to_pos).map(|p| self.stop_call(trip, date, p, tl)).collect();
        let geometry = calls.iter().map(|c| [c.quay.lon, c.quay.lat]).collect();
        let (towards, bearing) = if from_pos + 1 < stops.len() {
            let a = &tt.stops[stops[from_pos] as usize];
            let b = &tt.stops[stops[from_pos + 1] as usize];
            (Some(tt.stations[b.station as usize].name.clone()), Some(a.pos.bearing_deg(&b.pos).round()))
        } else {
            (None, None)
        };
        let number = tt.str(t.short_name);
        let mut it = calls.into_iter();
        let first = it.next().expect("ride has a first call");
        let mut rest: Vec<json::StopCall> = it.collect();
        let last = rest.pop().unwrap_or_else(|| first.clone());
        json::RideLeg {
            line: self.line_badge(trip),
            headsign: tt.str(t.headsign).to_string(),
            number: (!number.is_empty()).then(|| number.to_string()),
            trip_id: tt.trip_gtfs_id(trip).to_string(),
            service_date: time::fmt_date(date),
            from: first,
            to: last,
            intermediate: rest,
            geometry,
            stay_on_board: stay,
            onboard,
            headway_s: (t.flags & TRIP_FREQUENCY != 0).then_some(t.headway_s),
            cancelled: tl.map(|l| l.cancelled).unwrap_or(false),
            live: Self::live_state(tl),
            towards,
            bearing,
        }
    }

    /// Convert one router journey into the API shape.
    #[allow(clippy::too_many_arguments)]
    fn journey(
        &self,
        j: &Journey,
        date: Date,
        from: &WalkEnd,
        to: &WalkEnd,
        from_is_station: Option<StationIdx>,
        to_is_station: Option<StationIdx>,
        profile: &WalkProfile,
        margin: Secs,
        flatter: bool,
        live: Option<&dyn LiveView>,
    ) -> json::Journey {
        let tt = &self.tt;
        let ux = |s: Secs| time::to_unix(date, s);
        let mut legs: Vec<JLeg> = Vec::with_capacity(j.legs.len());
        // the stops of each change (by its index in `legs`), to walk it another way below
        let mut changes: Vec<(usize, StopIdx, StopIdx)> = Vec::new();
        let mut alerts: Vec<json::JourneyAlert> = Vec::new();
        let mut key: u64 = 1469598103934665603;
        let mut mix = |v: u64| {
            key = (key ^ v).wrapping_mul(1099511628211);
        };

        for leg in &j.legs {
            match *leg {
                Leg::Access { to: s, dep, arr } => {
                    let at_station = from_is_station == Some(tt.stops[s as usize].station);
                    if at_station && arr - dep <= 0 {
                        continue; // already at the station: nothing to walk
                    }
                    // The buffer is waiting at the stop, not walking.
                    let buf = (crate::state::ACCESS_BUFFER_S as i64).min((arr - dep) as i64);
                    let mut w = self.walk_leg("access", from, &self.stop_end(s), ux(dep), ux(arr) - buf, profile);
                    // timed by the walk drawn (the stop search timed the cheapest way of all the candidates, the walk
                    // drawn may take another): a longer one takes the wait at the stop, and starts earlier only beyond it
                    if let Some(s) = w.drawn_s {
                        let board = ux(arr);
                        w.duration_s = s;
                        w.arr = (w.dep + s).min(board);
                        w.dep = w.arr - s;
                    }
                    legs.push(JLeg::Walk(w));
                }
                Leg::Egress { from: s, dep, arr } => {
                    let at_station = to_is_station == Some(tt.stops[s as usize].station);
                    if at_station && arr - dep <= 0 {
                        continue;
                    }
                    let buf = (crate::state::ACCESS_BUFFER_S as i64).min((arr - dep) as i64);
                    let mut w = self.walk_leg("egress", &self.stop_end(s), to, ux(dep), ux(arr) - buf, profile);
                    // timed by the walk drawn, in travel order (the stop search ran from the destination)
                    if let Some(s) = w.drawn_s {
                        w.duration_s = s;
                        w.arr = w.dep + s;
                    }
                    legs.push(JLeg::Walk(w));
                }
                Leg::Transfer { from: a, to: b, dep, arr, .. } => {
                    let mut w = self.walk_leg("transfer", &self.stop_end(a), &self.stop_end(b), ux(dep), ux(arr), profile);
                    w.official_min_s = tt.official_transfer(a, b);
                    changes.push((legs.len(), a, b));
                    legs.push(JLeg::Walk(w));
                }
                Leg::Ride { trip, date: d, from_pos, to_pos, stay_seated, onboard, .. } => {
                    mix(trip as u64);
                    mix(((d as u64) << 32) | ((from_pos as u64) << 16) | to_pos as u64);
                    legs.push(JLeg::Ride(self.ride_leg(trip, d, from_pos as usize, to_pos as usize, stay_seated, onboard, live)));
                }
            }
        }

        // Slack on walks that lead to a departure, and alerts.
        let live_dep = |r: &json::RideLeg| r.from.dep.unwrap_or(0) + r.from.dep_delay_s.unwrap_or(0) as i64;
        let live_arr = |r: &json::RideLeg| r.to.arr.unwrap_or(0) + r.to.arr_delay_s.unwrap_or(0) as i64;
        for i in 0..legs.len() {
            let next_dep = match legs.get(i + 1) {
                Some(JLeg::Ride(r)) => Some(live_dep(r)),
                _ => None,
            };
            let prev_arr = match i.checked_sub(1).and_then(|p| legs.get(p)) {
                Some(JLeg::Ride(r)) => Some(live_arr(r)),
                _ => None,
            };
            if let (Some(nd), Some(&(_, a, b))) = (next_dep, changes.iter().find(|c| c.0 == i)) {
                if let JLeg::Walk(w) = &mut legs[i] {
                    let room = nd - prev_arr.unwrap_or(w.dep) - margin as i64;
                    if let Some(other) = self.change_walk(w, a, b, room, margin as i64, profile, flatter, false) {
                        *w = other;
                    }
                }
            }
            if let JLeg::Walk(w) = &mut legs[i] {
                // a step-free walker's walk (any of them) with a guessed end: said here
                alerts.extend(unsure_alert(w, Some(i), profile));
                if let Some(nd) = next_dep {
                    let start = prev_arr.unwrap_or(w.dep);
                    let m = if w.kind == "transfer" { margin as i64 } else { 0 };
                    let slack = nd - start - w.duration_s - m;
                    w.slack_s = Some(slack);
                    if w.kind == "transfer" {
                        let spare = nd - start - w.duration_s;
                        if spare < 0 {
                            alerts.push(json::JourneyAlert { severity: "severe", kind: "missed-connection", leg: Some(i), text: format!("You will miss this change at {} with the current delays", w.to.name) });
                        } else if spare < TIGHT_S {
                            alerts.push(json::JourneyAlert { severity: "warning", kind: "tight-change", leg: Some(i), text: format!("Tight change at {}: {} s to spare after walking", w.to.name, spare) });
                        } else if let Some(off) = w.official_min_s {
                            if nd - start < off as i64 {
                                alerts.push(json::JourneyAlert {
                                    severity: "info",
                                    kind: "tight-change",
                                    leg: Some(i),
                                    text: format!("Change at {} is shorter than the official minimum ({} min)", w.to.name, (off as f32 / 60.0).ceil() as u32),
                                });
                            }
                        }
                        if w.approximate {
                            alerts.push(json::JourneyAlert { severity: "info", kind: "other", leg: Some(i), text: format!("Walking time for the change at {} is estimated (path not mapped)", w.to.name) });
                        }
                    }
                }
            }
            if let JLeg::Ride(r) = &legs[i] {
                if r.cancelled {
                    alerts.push(json::JourneyAlert { severity: "severe", kind: "cancelled", leg: Some(i), text: format!("{} to {} is cancelled", line_title(&r.line), r.headsign) });
                } else if r.from.dep_delay_s.unwrap_or(0) >= 180 {
                    alerts.push(json::JourneyAlert {
                        severity: "info",
                        kind: "delay",
                        leg: Some(i),
                        text: format!("{} is about {} min late", line_title(&r.line), (r.from.dep_delay_s.unwrap_or(0) as f32 / 60.0).round() as i32),
                    });
                }
                if r.from.planned_label.is_some() {
                    alerts.push(json::JourneyAlert {
                        severity: "warning",
                        kind: "platform-change",
                        leg: Some(i),
                        text: {
                            let word = noun_word(r.from.quay.noun);
                            let mut cap = word.to_string();
                            cap[..1].make_ascii_uppercase();
                            match r.from.planned_label.as_deref().filter(|p| !p.is_empty()) {
                                Some(was) => format!("{cap} changed at {}: now {} {} (was {})", r.from.quay.station_name, word, r.from.quay.label, was),
                                None => format!("{cap} at {}: now {} {}", r.from.quay.station_name, word, r.from.quay.label),
                            }
                        },
                    });
                }
            }
        }

        let (mut walk_s, mut walk_m) = (0i64, 0u32);
        for l in &legs {
            if let JLeg::Walk(w) = l {
                walk_s += w.duration_s;
                walk_m += w.distance_m;
            }
        }
        // Journey bounds follow the legs that are actually shown.
        let dep = match legs.first() {
            Some(JLeg::Walk(w)) => w.dep,
            Some(JLeg::Ride(r)) if r.onboard => ux(j.dep),
            Some(JLeg::Ride(r)) => live_dep(r),
            None => ux(j.dep),
        };
        let arr = match legs.last() {
            Some(JLeg::Walk(w)) => w.arr,
            Some(JLeg::Ride(r)) => live_arr(r),
            None => ux(j.arr),
        };
        json::Journey { id: format!("{dep}-{arr}-{key:x}"), dep, arr, duration_s: arr - dep, transfers: j.transfers, walk_s, walk_m, legs, alerts }
    }

    /// A change walked another way than the router timed it with, given `room` seconds for the walk (the time from
    /// arriving to leaving, less the walker's margin). The footpaths time a change as a walker who minds hills a
    /// little walks it (`HillsPref::Normal`); a flatter way is timed as that plus the seconds it takes longer
    /// (so a change the timetable's minimum change time caps stays capped):
    ///
    /// - a walker who avoids hills (`w`, the way such a walker routes) walks it when it fits in the room, and
    ///   otherwise the quicker way the footpaths timed;
    /// - one who minds them a little, with `flatter` on, walks the way a walker who avoids them takes when it climbs
    ///   at least 5 m less and still leaves a minute in hand.
    ///
    /// Neither leaves a change tight (under [`TIGHT_S`] to spare, `margin` included) for a flatter way. Every walk of
    /// a change is drawn within `room` (as the walker prefers when that fits, else the quickest): the footpaths time
    /// the quickest walk when the preferred one is over their bound, and the walk drawn must be one that makes it.
    /// [`json::WalkLeg::flatter`] says by how much the walk is longer and climbs less. `own_time`: there is no
    /// footpath's time (`/api/walk` asked for a change again): every walk is timed as drawn. `None`: walk it as it is.
    #[allow(clippy::too_many_arguments)]
    fn change_walk(&self, w: &json::WalkLeg, a: StopIdx, b: StopIdx, room: i64, margin: i64, profile: &WalkProfile, flatter: bool, own_time: bool) -> Option<json::WalkLeg> {
        if w.approximate || w.drawn_s.is_none() || self.walk.is_none() {
            return None;
        }
        let walk = |hills: HillsPref, limit: Option<f32>| {
            let mut o = self.walk_leg_within("transfer", &self.stop_end(a), &self.stop_end(b), w.dep, w.arr, &WalkProfile { hills, ..*profile }, limit);
            o.official_min_s = w.official_min_s;
            // no footpath's time (a change asked again): each walk timed as drawn
            if let (true, Some(d)) = (own_time, o.drawn_s) {
                o.duration_s = d;
                o.arr = o.dep + d;
            }
            o
        };
        let routed = |o: &json::WalkLeg| !o.approximate && o.drawn_s.is_some();
        // within the time there is: the way asked for when it fits, else the quickest (ends::walk_within)
        let limit = Some(room.max(0) as f32);
        // a walk drawn longer than the time there is, and than the footpath's time (which times the quickest walk when
        // the preferred one is over its bound): drawn again within the time. Even the quickest longer than the time
        // there is: timed as drawn, so that the change says it is missed; not where the timetable gives a minimum
        // change time (the walk is drawn between the platforms' registry points, which can lie far apart, and that
        // time is what people walk)
        let fit = |hills: HillsPref| Some(walk(hills, limit)).filter(routed).map(|o| as_drawn(o, room));
        // too long: timed longer than the room (a quicker way may still make it), or drawn longer than it and than
        // it is timed (with no footpath's time, drawn longer than the room)
        let too_long = |o: &json::WalkLeg| o.duration_s > room || o.drawn_s.is_some_and(|d| d > room && (own_time || d > o.duration_s));
        // seconds the flatter way must leave beyond the margin, so that the change is not tight
        let untight = (TIGHT_S - margin).max(0);
        match profile.hills {
            HillsPref::Avoid => {
                // `w` is the flatter way; the quicker one is the way a walker minding hills a little takes, within
                // the time there is (the quickest when even that is too long)
                let quick = walk(HillsPref::Normal, limit);
                if !routed(&quick) {
                    return if too_long(w) { fit(HillsPref::Avoid) } else { None };
                }
                match avoid_choice(&quick, w, room, untight) {
                    AvoidChoice::Flatter(f) => Some(retimed(w.clone(), quick.duration_s, f)),
                    AvoidChoice::AsItIs => None,
                    AvoidChoice::Quicker => Some(as_drawn(quick, room)),
                }
            }
            hills => {
                let fitted = if too_long(w) { fit(hills) } else { None };
                let base = fitted.as_ref().unwrap_or(w);
                if hills == HillsPref::Normal && flatter && base.climb_m >= 5 {
                    // the way a walker avoiding hills takes, as it is (not the quickest in its place): flatter_way
                    // says whether it fits
                    let flat = walk(HillsPref::Avoid, None);
                    if let Some(f) = flatter_way(base, &flat, room, untight.max(60), 5) {
                        return Some(retimed(flat, base.duration_s, f));
                    }
                }
                fitted
            }
        }
    }

    /// Range search over `[from, from + total]`, split into `chunks` windows
    /// that run in parallel. Each window's answer is Pareto-optimal only
    /// within itself, so the union is filtered again: an option is dropped
    /// when another leaves no earlier, arrives no later and needs no more
    /// changes.
    fn range(&self, base: &Query, from: Secs, total: Secs, chunks: i32) -> Vec<Journey> {
        use rayon::prelude::*;
        let step = total / chunks;
        let mut all: Vec<Journey> = (0..chunks)
            .into_par_iter()
            .flat_map_iter(|k| {
                // Windows are closed on both ends; start each one a second
                // after the previous one ended.
                let start = from + k * step + (k > 0) as i32;
                let q = Query { from: start, window: step - (k > 0) as i32, ..*base };
                self.router.plan(&q)
            })
            .collect();
        all.sort_by_key(|j| (j.dep, j.arr, j.transfers));
        let dominated = |a: &Journey| all.iter().any(|b| b.dep >= a.dep && b.arr <= a.arr && b.transfers <= a.transfers && (b.dep > a.dep || b.arr < a.arr || b.transfers < a.transfers));
        let keep: Vec<bool> = all.iter().map(|j| !dominated(j)).collect();
        let mut it = keep.into_iter();
        all.retain(|_| it.next().unwrap_or(true));
        all.dedup_by(|a, b| a.dep == b.dep && a.arr == b.arr && a.transfers == b.transfers);
        all
    }

    fn direct_walk(&self, from: &WalkEnd, to: &WalkEnd, start: i64, profile: &WalkProfile) -> Option<json::Journey> {
        let crow = from.pos.dist_m(&to.pos);
        if crow > 3500.0 || crow < 1.0 {
            return None;
        }
        let w = self.walk_leg("direct", from, to, start, start, profile);
        if w.duration_s > 50 * 60 {
            return None;
        }
        Some(json::Journey {
            id: format!("walk-{}-{}", w.dep, w.arr),
            dep: w.dep,
            arr: w.arr,
            duration_s: w.duration_s,
            transfers: 0,
            walk_s: w.duration_s,
            walk_m: w.distance_m,
            alerts: unsure_alert(&w, Some(0), profile).into_iter().collect(),
            legs: vec![JLeg::Walk(w)],
        })
    }

    pub fn plan(&self, req: &json::PlanRequest) -> Result<json::PlanResponse, String> {
        let t0 = Instant::now();
        let tt = &self.tt;
        let opt = &req.options;
        let profile = profile_from(opt);
        let margin = opt.transfer_margin_s.clamp(0, 1800);
        let max_walk = (opt.max_walk_min.clamp(1.0, 90.0) * 60.0) as Secs;
        let live_arc = self.live_view();
        let live: Option<&dyn LiveView> = live_arc.as_deref();
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);

        let to_ep = self.resolve(&req.to)?;
        let egress = self.reach(&to_ep, &profile, max_walk, true);
        if egress.stops.is_empty() {
            return Err("no public transport stop within walking distance of the destination".into());
        }
        let to_end = WalkEnd { name: to_ep.place.name.clone(), pos: to_ep.pos, stop: None, end: egress.end.clone() };

        let mut query = Query {
            date: 0,
            from: 0,
            window: 0,
            max_arr: None,
            access: &[],
            egress: &egress.stops,
            onboard: None,
            footpaths: self.footpaths_for(&profile),
            walk_speed: profile.speed_mps,
            transfer_margin: margin,
            max_walk: max_walk.min(1500),
            max_transfers: opt.max_transfers.unwrap_or(6).min(8),
            modes: mode_mask(opt),
            live,
        };

        // ---- on-board plan: one search from inside the vehicle
        if let Some(ob) = &req.onboard {
            let trip = self.router.find_trip(&ob.trip_id).ok_or("unknown trip")?;
            let tdate = time::parse_date(&ob.service_date).ok_or("bad serviceDate")?;
            let t = req.time.unwrap_or(now);
            let n = tt.pattern_stops(tt.trips[trip as usize].pattern).len();
            let tl = live.and_then(|l| l.trip(tdate, trip));
            let arr_live = |p: usize| time::to_unix(tdate, tt.arr(trip, p)) + tl.map(|l| l.arr_delay_at(p) as i64).unwrap_or(0);
            let next = match ob.next_seq {
                Some(s) if (s as usize) < n => s as usize,
                _ => (1..n).find(|&p| arr_live(p) >= t).ok_or("that trip has already finished")?,
            };
            let (qdate, qsecs) = time::from_unix(t.min(arr_live(next)));
            query.date = qdate;
            query.from = qsecs;
            query.onboard = Some(Onboard { trip, date: tdate, next_pos: next as u16 });
            let journeys = self.router.plan(&query);
            let stops = tt.pattern_stops(tt.trips[trip as usize].pattern);
            let here = &tt.stops[stops[next] as usize];
            let badge = self.line_badge(trip);
            let from_place = json::Place {
                id: format!("coord:{:.6},{:.6}", here.pos.lat_deg(), here.pos.lon_deg()),
                kind: "coord",
                name: format!("On board {} to {}", line_title(&badge), tt.str(tt.trips[trip as usize].headsign)),
                detail: None,
                lat: here.pos.lat_deg(),
                lon: here.pos.lon_deg(),
                modes: None,
                dist_m: None,
            };
            let from_end = WalkEnd { name: from_place.name.clone(), pos: here.pos, stop: None, end: End::exact(here.pos, None) };
            let out: Vec<json::Journey> =
                journeys.iter().take(6).map(|j| self.journey(j, qdate, &from_end, &to_end, None, to_ep.station, &profile, margin, opt.flatter_changes, live)).collect();
            return Ok(json::PlanResponse {
                from: from_place,
                to: to_ep.place,
                journeys: out,
                walk_only: None,
                earlier: None,
                later: None,
                took_ms: t0.elapsed().as_secs_f64() * 1e3,
                realtime: live.is_some(),
            });
        }

        // ---- door-to-door plan
        let from_ep: Endpoint = self.resolve(req.from.as_ref().ok_or("from is required")?)?;
        let access: Reach = self.reach(&from_ep, &profile, max_walk, false);
        let from_end = WalkEnd { name: from_ep.place.name.clone(), pos: from_ep.pos, stop: None, end: access.end.clone() };
        query.access = &access.stops;

        // What to search: forward from a time, or backward from a deadline.
        enum Dir {
            After(i64),
            Before(i64),
            ArriveBy(i64),
        }
        let dir = match req.page.as_deref() {
            Some(p) if p.starts_with("l:") => Dir::After(p[2..].parse().map_err(|_| "bad page")?),
            Some(p) if p.starts_with("e:") => Dir::Before(p[2..].parse().map_err(|_| "bad page")?),
            Some(_) => return Err("bad page".into()),
            None if req.arrive_by => Dir::ArriveBy(req.time.unwrap_or(now)),
            None => Dir::After(req.time.unwrap_or(now)),
        };
        const WANT: usize = 6;
        let mut picked: Vec<Journey> = Vec::new();
        let mut qdate = 0;
        if !access.stops.is_empty() {
            match dir {
                Dir::After(t) => {
                    let (d, s) = time::from_unix(t);
                    qdate = d;
                    query.date = d;
                    // Look four hours ahead first; only a thin timetable
                    // (night, mountain lines) needs the long look.
                    for (total, tail) in [(4 * 3600, 1800), (16 * 3600, 0)] {
                        picked = self.range(&query, s, total, 4);
                        // Options leaving in the last stretch may still be
                        // beaten by something just outside the search.
                        let safe = picked.iter().filter(|j| j.dep <= s + total - tail).count();
                        if safe >= 3 || tail == 0 {
                            picked.truncate(safe.max(1).min(picked.len()));
                            break;
                        }
                    }
                    picked.truncate(WANT);
                }
                Dir::Before(t) | Dir::ArriveBy(t) => {
                    let by_arrival = matches!(dir, Dir::ArriveBy(_));
                    for total in [4 * 3600, 14 * 3600] {
                        let (d, s) = time::from_unix(t - total as i64);
                        qdate = d;
                        query.date = d;
                        let limit = s + total;
                        // "Earlier" pages end at a departure time: search two
                        // hours past it so that journeys leaving later can
                        // still rule out slower ones that leave before it.
                        let tail = if by_arrival { 0 } else { 2 * 3600 };
                        // Journeys must arrive by `limit`: the engine need not explore later ones.
                        query.max_arr = by_arrival.then_some(limit);
                        picked = self.range(&query, s, total + tail, if tail > 0 { 6 } else { 4 }).into_iter().filter(|j| if by_arrival { j.arr <= limit } else { j.dep <= limit }).collect();
                        if picked.len() >= 3 {
                            break;
                        }
                    }
                    let n = picked.len();
                    if n > WANT {
                        picked.drain(..n - WANT);
                    }
                }
            }
        }

        // the journey arriving first is added back for searches that leave at a time (and their pages), not for
        // "arrive by", where it is not what was asked for
        let (picked, pages) = page(picked, !matches!(dir, Dir::ArriveBy(_)));
        let mut journeys: Vec<json::Journey> =
            picked.iter().map(|j| self.journey(j, qdate, &from_end, &to_end, from_ep.station, to_ep.station, &profile, margin, opt.flatter_changes, live)).collect();
        // a journey's last walk is timed by the walk drawn, in travel order (the stop search ran the other way): one
        // that then arrives after the time asked to arrive by is not one to take
        if let Dir::ArriveBy(t) = dir {
            journeys.retain(|j| j.arr <= t);
        }

        let start = match dir {
            Dir::After(t) => t,
            Dir::Before(t) | Dir::ArriveBy(t) => journeys.last().map(|j| j.dep).unwrap_or(t),
        };
        let walk_only = if req.page.is_none() { self.direct_walk(&from_end, &to_end, start, &profile) } else { None };

        let earlier = pages.map(|(first, _)| format!("e:{}", time::to_unix(qdate, first) - 60));
        let later = pages.map(|(_, last)| format!("l:{}", time::to_unix(qdate, last) + 60));
        Ok(json::PlanResponse {
            from: from_ep.place,
            to: to_ep.place,
            journeys,
            walk_only,
            earlier,
            later,
            took_ms: t0.elapsed().as_secs_f64() * 1e3,
            realtime: live.is_some(),
        })
    }

    pub fn walk_direct(&self, req: &json::WalkRequest) -> Result<json::WalkLeg, String> {
        let profile = profile_from(&req.options);
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        let end = |r: &json::PlaceRef| -> Result<WalkEnd, String> {
            // a boarding point: on its own platform and floor, as in a journey's change
            if let Some(q) = r.quay.as_deref().filter(|q| !q.is_empty()) {
                let s = *self.quays_of(q).first().ok_or_else(|| format!("unknown quay {q}"))?;
                return Ok(self.stop_end(s));
            }
            let p = self.resolve(r)?;
            // a place: from the point or its building's doors, as the stop search takes it; a station or a point
            // given exactly (where a station model's own paths begin): straight from it
            let end = match (p.station, r.exact, self.walk.as_ref()) {
                (_, true, _) | (_, _, None) => End::exact(p.pos, self.snap_free(p.pos, &profile)),
                (Some(_), false, Some(w)) => End::station(w, self.doors.as_ref(), p.pos, &profile),
                (None, false, Some(_)) => self.place_end(p.pos, &profile),
            };
            Ok(WalkEnd { name: p.place.name.clone(), pos: p.pos, stop: None, end })
        };
        let (ea, eb) = (end(&req.from)?, end(&req.to)?);
        let limit = req.limit_s.filter(|l| l.is_finite() && *l >= 0.0);
        // a change asked again (after a live platform change or a delay), with the time there is for it: walked and
        // timed as a journey's change is (change_walk): by its footpath and the timetable's minimum change time when
        // there is a footpath between the two, else each walk as drawn
        if let (Some(room), Some(sa), Some(sb)) = (limit, ea.stop, eb.stop) {
            // timed as drawn, or with no path as the straight line is
            let mut w = self.walk_leg("direct", &ea, &eb, now, now, &profile);
            // (a footpath with no path mapped is the planner's estimate: its time, as planned)
            let footpath = self.footpaths_for(&profile).get(sa, sb);
            if let Some((v, f)) = footpath {
                let secs = walk_secs(v as f32, f as f32, profile.speed_mps).ceil() as i64;
                w.duration_s = secs;
                w.arr = now + secs;
                w.official_min_s = self.tt.official_transfer(sa, sb);
                if w.approximate {
                    // its one direction ("Walk about …") has the walk's time
                    if let Some(st) = w.steps.first_mut() {
                        st.dur_s = secs as u32;
                    }
                }
            }
            let margin = req.options.transfer_margin_s.clamp(0, 1800) as i64;
            let mut out = self.change_walk(&w, sa, sb, room as i64, margin, &profile, req.options.flatter_changes, footpath.is_none()).unwrap_or(w);
            out.kind = "direct";
            return Ok(out);
        }
        Ok(self.walk_leg_within("direct", &ea, &eb, now, now, &profile, limit))
    }
}

/// A change with less to spare after walking is tight (an alert says so).
const TIGHT_S: i64 = 90;

/// Whether the flatter walk `flat` of a change may replace the quicker `quick`, with `room` seconds for the walk: it
/// is timed as `quick` plus the seconds the walks drawn differ (never less), and both that and the flatter walk as
/// drawn must leave `in_hand` seconds (a change the minimum change time caps is drawn longer than it is timed: the
/// flatter way must fit as drawn, not only as timed); it climbs at least `less` metres less. The flatter way's extra
/// seconds and metres less climbed.
fn flatter_way(quick: &json::WalkLeg, flat: &json::WalkLeg, room: i64, in_hand: i64, less: u32) -> Option<json::FlatterWay> {
    if flat.approximate {
        return None;
    }
    let drawn = flat.drawn_s?;
    let extra = (drawn - quick.drawn_s?).max(0);
    if flat.climb_m + less > quick.climb_m && less > 0 {
        return None;
    }
    if (quick.duration_s + extra).max(drawn) + in_hand > room {
        return None;
    }
    Some(json::FlatterWay { extra_s: extra, less_climb_m: quick.climb_m.saturating_sub(flat.climb_m) })
}

/// How a walker avoiding hills walks a change (their own way `w`, the way a walker minding hills a little takes
/// `quick`, both drawn within the time there is).
#[derive(Debug, PartialEq)]
enum AvoidChoice {
    /// Their way, timed as the quicker one and the seconds more it takes.
    Flatter(json::FlatterWay),
    /// Their way as it is: no longer, and no flatter, than the quicker one.
    AsItIs,
    /// There is no room for their way: the quicker one.
    Quicker,
}

fn avoid_choice(quick: &json::WalkLeg, w: &json::WalkLeg, room: i64, untight: i64) -> AvoidChoice {
    match flatter_way(quick, w, room, untight, 0) {
        Some(f) if f.extra_s > 0 || f.less_climb_m > 0 => AvoidChoice::Flatter(f),
        Some(_) => AvoidChoice::AsItIs,
        None => AvoidChoice::Quicker,
    }
}

/// A change's walk longer as drawn than the time there is (`room`) and than it is timed: timed as drawn, so that the
/// change says it is missed. Not where the timetable gives a minimum change time: the walk is drawn between the
/// platforms' registry points, which can lie far apart, and that time is what people walk.
fn as_drawn(mut o: json::WalkLeg, room: i64) -> json::WalkLeg {
    let d = o.drawn_s.unwrap_or(o.duration_s);
    // longer as drawn than the room: missed, as drawn; timed longer than the room but drawn (the quickest way) within
    // it: made, as drawn
    if o.official_min_s.is_none() && ((d > room && d > o.duration_s) || (o.duration_s > room && d < o.duration_s)) {
        o.duration_s = d;
        o.arr = o.dep + d;
    }
    o
}

/// The flatter walk of a change, timed as the quicker one (`quick_s`) and the seconds more it takes; it says so when
/// it climbs at least 5 m less.
fn retimed(mut w: json::WalkLeg, quick_s: i64, f: json::FlatterWay) -> json::WalkLeg {
    w.duration_s = quick_s + f.extra_s;
    w.arr = w.dep + w.duration_s;
    w.flatter = (f.less_climb_m >= 5).then_some(f);
    w
}

/// A step-free walker's walk that starts or ends with a guess (through a building, onto another floor, or across
/// ground with no mapped way): taken only where nothing else reaches (kante_link::ends::reach_costs), and said.
fn unsure_alert(w: &json::WalkLeg, leg: Option<usize>, profile: &WalkProfile) -> Option<json::JourneyAlert> {
    (w.unsure_end && (profile.wheelchair || profile.is_step_free())).then(|| {
        // the end that is guessed: the start, the end, or both (a walk with no path at all: both)
        let (start, end) = match (w.approx_start.is_some(), w.approx_end.is_some()) {
            (false, false) => (true, true),
            ends => ends,
        };
        let at = match (w.kind, start, end) {
            ("transfer", _, _) => format!("for the change at {}", w.to.name),
            (_, true, true) if w.from.name != w.to.name => format!("at {} and at {}", w.from.name, w.to.name),
            (_, true, _) => format!("at {}", w.from.name),
            _ => format!("at {}", w.to.name),
        };
        json::JourneyAlert {
            severity: "warning",
            kind: "other",
            leg,
            text: format!("No step-free way is known {at}: this walk is guessed there (through a building, onto another floor, across a track, or across ground with no mapped way)"),
        }
    })
}

/// A departure window is Pareto-optimal only within itself: a slow many-change option can survive because the faster
/// one that beats it leaves just after the window. Drop options that are far slower than the best while also needing
/// more changes. The options shown are those, and the one that arrives first if the filter dropped it (an overnight
/// journey that leaves in the evening and waits on the way can be the only one that arrives before the first morning
/// one). The pages before and after are taken from the options the filter keeps, as they were before that journey
/// was added back: they ask for what they always asked for, and a page that returns it again returns it with the
/// same id. `rescue` false (asked to arrive by a time): `main`'s options only. Returns the options to show (by
/// departure) and the departures the pages start from.
fn page(mut picked: Vec<Journey>, rescue: bool) -> (Vec<Journey>, Option<(Secs, Secs)>) {
    let Some(best) = picked.iter().min_by_key(|j| (j.arr - j.dep, j.transfers)).map(|j| (j.arr - j.dep, j.transfers)) else { return (picked, None) };
    let keep = |j: &Journey| j.transfers <= best.1 || (j.arr - j.dep) as f32 <= best.0 as f32 * 1.5 + 600.0;
    let first_arr = picked.iter().map(|j| j.arr).min().unwrap_or(0);
    // the one arriving first that the filter drops (if it keeps none that does): the fewest changes, then the latest
    let rescued = if !rescue || picked.iter().any(|j| keep(j) && j.arr == first_arr) {
        None
    } else {
        picked.iter().filter(|j| j.arr == first_arr).min_by_key(|j| (j.transfers, -j.dep)).cloned()
    };
    picked.retain(|j| keep(j));
    let pages = picked.first().map(|f| (f.dep, picked.last().map_or(f.dep, |l| l.dep)));
    if let Some(r) = rescued {
        let at = picked.partition_point(|j| (j.dep, j.arr) <= (r.dep, r.arr));
        picked.insert(at, r);
    }
    (picked, pages)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_step_free_alert_names_the_place_whose_end_is_guessed() {
        // review 7 (Neon): an access walk guessed only at the stop names the stop, not the address
        let pt = |name: &str| json::WalkPoint { name: name.into(), lat: 0.0, lon: 0.0, quay: None };
        let leg = |kind, s: Option<u32>, e: Option<u32>| json::WalkLeg {
            kind, from: pt("Home"), to: pt("Bern, Zytglogge"), dep: 0, arr: 0, duration_s: 0, distance_m: 0, climb_m: 0, descent_m: 0, flatter: None, stairs_up: 0,
            stairs_down: 0, lifts: 0, escalators: 0, step_free: false, unmapped_level_changes: 0, slack_s: None,
            official_min_s: None, approximate: s.is_none() && e.is_none(), geometry: vec![], levels: vec![], steps: vec![],
            door: None, start_door: None, covered: vec![], approx_start: s, approx_end: e, network: None,
            no_step_free_door: false, unsure_end: true, drawn_s: None,
        };
        let wc = WalkProfile::step_free(1.0);
        let text = |l: json::WalkLeg| unsure_alert(&l, Some(0), &wc).unwrap().text;
        assert!(text(leg("access", None, Some(3))).contains("known at Bern, Zytglogge:"));
        assert!(text(leg("access", Some(1), None)).contains("known at Home:"));
        assert!(text(leg("egress", Some(1), None)).contains("known at Home:"));
        assert!(text(leg("direct", Some(1), Some(3))).contains("known at Home and at Bern, Zytglogge:"));
        assert!(text(leg("access", None, None)).contains("known at Home and at Bern, Zytglogge:"));
        assert!(unsure_alert(&leg("access", None, Some(3)), Some(0), &WalkProfile::normal(1.0)).is_none());
    }

    fn j(dep: Secs, arr: Secs, transfers: u8) -> Journey {
        Journey { dep, arr, transfers, legs: vec![] }
    }
    const H: Secs = 3600;
    const M: Secs = 60;
    /// What `main`'s filter keeps and the pages it starts (picked sorted by departure).
    fn main_page(picked: &[Journey]) -> (Vec<Journey>, Option<(Secs, Secs)>) {
        let best = picked.iter().min_by_key(|j| (j.arr - j.dep, j.transfers)).map(|j| (j.arr - j.dep, j.transfers)).unwrap();
        let kept: Vec<Journey> = picked.iter().filter(|j| j.transfers <= best.1 || (j.arr - j.dep) as f32 <= best.0 as f32 * 1.5 + 600.0).cloned().collect();
        let pages = kept.first().map(|f| (f.dep, kept.last().unwrap().dep));
        (kept, pages)
    }
    /// The options of a page before `first` (departing at most `first`; `main`'s Before page) or after `last`.
    fn before(all: &[Journey], t: Secs) -> Vec<Journey> {
        page(all.iter().filter(|j| j.dep <= t).cloned().collect(), true).0
    }

    #[test]
    fn the_journey_that_arrives_first_is_added_back() {
        // asked at 21:40: an overnight journey (22:12 → 06:35, three changes) and the first morning ones, quicker
        // with fewer changes. main's filter drops the overnight one as far slower with more changes.
        let all = vec![j(22 * H + 12 * M, 30 * H + 35 * M, 3), j(30 * H + 38 * M, 34 * H + 19 * M, 1), j(31 * H, 34 * H + 50 * M, 1)];
        let (shown, pages) = page(all.clone(), true);
        assert_eq!(shown, all);
        assert_eq!(pages, main_page(&all).1, "the pages are main's");
    }

    #[test]
    fn nothing_else_main_drops_is_kept() {
        // a slow one with more changes that does not arrive first: dropped, as on main
        let all = vec![j(7 * H + 50 * M, 11 * H, 2), j(8 * H, 9 * H, 0), j(8 * H + 10 * M, 12 * H, 2), j(9 * H, 10 * H, 0)];
        let (shown, pages) = page(all.clone(), true);
        assert_eq!((shown, pages), main_page(&all));
        // several arrive first and main keeps one of them: nothing is added
        let all = vec![j(3 * H, 6 * H + 21 * M, 2), j(5 * H, 6 * H + 21 * M, 1)];
        assert_eq!(page(all.clone(), true), main_page(&all));
        // several arrive first, main keeps none: one is added back, the one with the fewest changes
        let all = vec![j(1 * H, 6 * H, 3), j(2 * H, 6 * H, 2), j(6 * H + 30 * M, 7 * H, 0)];
        assert_eq!(page(all.clone(), true).0, vec![j(2 * H, 6 * H, 2), j(6 * H + 30 * M, 7 * H, 0)]);
    }

    #[test]
    fn the_pages_are_mains_and_the_earlier_page_has_what_main_shows_there() {
        // leaving at 07:50: 08:00–11:00 with two changes (arrives first), 08:00:30–11:30 with one, 10:30–11:45 direct.
        // main shows the direct one and offers both others through `earlier`. Here: the direct one and the one
        // arriving first; the pages start where main's do, and the earlier page has both others.
        let x = j(8 * H, 11 * H, 2);
        let y = j(8 * H + 30, 11 * H + 30 * M, 1);
        let z = j(10 * H + 30 * M, 11 * H + 45 * M, 0);
        let all = vec![x.clone(), y.clone(), z.clone()];
        let (main_shown, main_pages) = main_page(&all);
        assert_eq!(main_shown, vec![z.clone()]);
        let (shown, pages) = page(all.clone(), true);
        assert_eq!(shown, vec![x.clone(), z.clone()]);
        assert_eq!(pages, main_pages);
        // main's earlier page: what leaves by a minute before the first it showed
        let earlier = before(&all, pages.unwrap().0 - 60);
        assert!(earlier.contains(&x) && earlier.contains(&y), "{earlier:?}");
    }

    #[test]
    fn asked_to_arrive_by_a_time_the_options_are_mains() {
        // arrive by 11:45, the same three journeys: main's direct one only, nothing added back
        let all = vec![j(8 * H, 11 * H, 2), j(8 * H + 30, 11 * H + 30 * M, 1), j(10 * H + 30 * M, 11 * H + 45 * M, 0)];
        assert_eq!(page(all.clone(), false), main_page(&all));
        assert_eq!(page(all.clone(), false).0, vec![j(10 * H + 30 * M, 11 * H + 45 * M, 0)]);
    }

    /// A change's walk: `secs` as the footpaths timed it, `drawn` as drawn, climbing `climb` metres.
    fn change(secs: i64, drawn: i64, climb: u32) -> json::WalkLeg {
        let pt = |name: &str| json::WalkPoint { name: name.into(), lat: 0.0, lon: 0.0, quay: None };
        json::WalkLeg {
            kind: "transfer", from: pt("A"), to: pt("B"), dep: 1000, arr: 1000 + secs, duration_s: secs, distance_m: 300, climb_m: climb,
            descent_m: 0, flatter: None, stairs_up: 0, stairs_down: 0, lifts: 0, escalators: 0, step_free: true, unmapped_level_changes: 0,
            slack_s: None, official_min_s: None, approximate: false, geometry: vec![], levels: vec![], steps: vec![], door: None,
            start_door: None, covered: vec![], approx_start: None, approx_end: None, network: None, no_step_free_door: false,
            unsure_end: false, drawn_s: Some(drawn),
        }
    }

    #[test]
    fn a_change_walks_round_the_hill_when_there_is_time() {
        // the quick way: 4 min, 20 m up; the flat way: 1 min 30 s longer, 4 m up
        let (quick, flat) = (change(240, 240, 20), change(240, 330, 4));
        // 7 min for walking: room for it, and a minute in hand
        let f = flatter_way(&quick, &flat, 420, 60, 5).unwrap();
        assert_eq!((f.extra_s, f.less_climb_m), (90, 16));
        let w = retimed(flat.clone(), quick.duration_s, f);
        assert_eq!((w.duration_s, w.arr), (330, 1330));
        assert!(w.flatter.is_some());
        // 6 min 29 s: not a minute in hand
        assert!(flatter_way(&quick, &flat, 389, 60, 5).is_none());
        // a walker who avoids hills needs no minute in hand
        assert!(flatter_way(&quick, &flat, 330, 0, 0).is_some());
        // only 3 m less uphill: not worth it
        assert!(flatter_way(&quick, &change(240, 300, 17), 900, 60, 5).is_none());
        // no path for the flat way
        let mut none = flat.clone();
        none.approximate = true;
        assert!(flatter_way(&quick, &none, 900, 60, 5).is_none());
    }

    #[test]
    fn a_walker_avoiding_hills_falls_back_to_the_normal_way() {
        // the normal way: 3 min 5 s, 20 m up; the flat way: 5 min 50 s, 2 m up
        let (quick, flat) = (change(185, 185, 20), change(185, 350, 2));
        // 6 min 30 s for walking: the flat way
        assert!(matches!(avoid_choice(&quick, &flat, 390, 30), AvoidChoice::Flatter(f) if f.extra_s == 165 && f.less_climb_m == 18));
        // 5 min: no room for it, the normal way
        assert_eq!(avoid_choice(&quick, &flat, 300, 30), AvoidChoice::Quicker);
        // the same way: as it is
        assert_eq!(avoid_choice(&quick, &change(185, 185, 20), 300, 30), AvoidChoice::AsItIs);
    }

    #[test]
    fn a_change_too_long_for_its_time_is_timed_as_drawn_unless_the_timetable_caps_it() {
        // footpath 2 min, the quickest walk drawn 4 min, 3 min 30 s between the rides: missed, as drawn
        let o = as_drawn(change(120, 240, 0), 210);
        assert_eq!((o.duration_s, o.arr), (240, 1240));
        // it fits: as timed
        assert_eq!(as_drawn(change(120, 200, 0), 210).duration_s, 120);
        // timed 9 min 54 s, the quickest drawn 9 min 14 s, 9 min 15 s between the rides: made, as drawn
        assert_eq!(as_drawn(change(594, 554, 0), 555).duration_s, 554);
        // a minimum change time: as the timetable says
        let mut capped = change(120, 240, 0);
        capped.official_min_s = Some(120);
        assert_eq!(as_drawn(capped, 210).duration_s, 120);
    }

    #[test]
    fn a_change_capped_by_its_minimum_time_keeps_the_cap() {
        // the timetable's minimum change time (2 min) caps a walk drawn at 9 min; the flat way is a minute longer
        let (quick, flat) = (change(120, 540, 15), change(120, 600, 2));
        let f = flatter_way(&quick, &flat, 700, 60, 5).unwrap();
        assert_eq!(retimed(flat.clone(), quick.duration_s, f).duration_s, 180);
        // 5 min for walking: the flat way fits as timed (3 min) but not as drawn (10 min): the quick way
        assert!(flatter_way(&quick, &flat, 300, 60, 5).is_none());
        // a flatter way drawn quicker than the quick one is not timed quicker than it
        let f = flatter_way(&quick, &change(120, 500, 2), 700, 60, 5).unwrap();
        assert_eq!(f.extra_s, 0);
    }
}
