//! Journey planning: endpoints → access/egress walks → RAPTOR → API journeys
//! with boarding points and walking geometry.

use crate::json::{self, Leg as JLeg};
use crate::state::{level_f, lonlat, App, DoorChoice, DoorOpt, Endpoint, Ends, Reach};
use kante_core::time::{self, Date, Secs};
use kante_core::*;
use kante_raptor::{Journey, Leg, Onboard, Query};
use kante_walk::{StepKind, WalkPath};
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
    pub snap: Option<Snap>,
    /// The doors of the building the end is in (the walk then leaves or enters it through one).
    pub doors: DoorChoice,
}

/// Is a walk step-free? No stairs, escalators or floors joined without a ramp or lift on its path, and not into
/// a building through no known door (`wall`) or one whose doors are all `wheelchair=no` (`no_step_free_door`).
fn step_free(p: &WalkPath, wall: bool, no_step_free_door: bool) -> bool {
    p.stairs_up == 0 && p.stairs_down == 0 && p.escalators == 0 && p.unmapped_level_changes == 0 && !wall && !no_step_free_door
}

/// A straight line onto the network longer than this is a guess across open ground.
const GUESS_M: f32 = 20.0;

impl App {
    fn stop_end(&self, s: StopIdx) -> WalkEnd {
        let stop = &self.tt.stops[s as usize];
        let station = &self.tt.stations[stop.station as usize];
        WalkEnd { name: station.name.clone(), pos: stop.pos, stop: Some(s), snap: self.link(s).map(|l| l.snap), doors: DoorChoice::default() }
    }

    /// A railway platform's registry point often lies on the track itself: a walk to it ends on the platform.
    fn on_track(&self, e: &WalkEnd) -> bool {
        let railish = Mode::Rail.bit() | Mode::Metro.bit() | Mode::RackRail.bit() | Mode::Funicular.bit();
        e.stop.is_some_and(|s| self.tt.stops[s as usize].modes & railish != 0)
    }

    fn door_json(&self, o: &DoorOpt) -> Option<json::WalkDoor> {
        let ix = self.doors.as_ref()?;
        let d = &ix.doors.doors[o.door as usize];
        let addr = ix.doors.addr_of(o.door);
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
        let speed = profile.speed_mps;
        let mut leg = json::WalkLeg {
            kind,
            from: self.walk_point(a),
            to: self.walk_point(b),
            dep,
            arr,
            duration_s: (arr - dep).max(0),
            distance_m: 0,
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
            no_step_free_door: false,
        };
        if a.stop.is_some() && a.stop == b.stop {
            leg.geometry = vec![lonlat(&a.pos), lonlat(&a.pos)];
            leg.levels = vec![None, None];
            return leg;
        }
        // a walk timed by a journey (to the first stop, from the last) keeps to that time: the best door within it
        let budget = matches!(kind, "access" | "egress").then_some(leg.duration_s as f32);
        let walk = self.walk.as_ref().and_then(|w| kante_link::doors::best_walk(w, &Ends::new(&a.doors, a.snap), &Ends::new(&b.doors, b.snap), profile, budget));
        match walk.map(|w| (w.from, w.to, w.path)) {
            Some((ja, jb, p)) => {
                let lv0 = p.levels.first().and_then(|l| level_f(*l));
                let lv1 = p.levels.last().and_then(|l| level_f(*l));
                // From the point to the network: inside to the door and out of it, or straight onto the nearest way
                // (a railway platform is left from the platform itself, not from its point on the track)
                let mut head: Vec<LatLon> = Vec::new();
                match ja.door {
                    Some(o) => {
                        let dp = self.doors.as_ref().map(|ix| ix.doors.doors[o.door as usize].pos).unwrap_or(a.pos);
                        if o.inside_m > 1.5 {
                            head.push(a.pos);
                        }
                        if o.snap.dist_m > 0.5 {
                            head.push(dp);
                        }
                    }
                    None if ja.snap.dist_m > 1.5 && !self.on_track(a) => head.push(a.pos),
                    None => {}
                }
                let shift = head.len() as u32;
                for q in &head {
                    leg.geometry.push(lonlat(q));
                    leg.levels.push(lv0);
                }
                leg.geometry.extend(p.geometry.iter().map(lonlat));
                leg.levels.extend(p.levels.iter().map(|l| level_f(*l)));
                let path_end = leg.geometry.len() as u32 - 1;
                // ... and from the network to the door (the walk ends there), or to the point
                match jb.door {
                    Some(o) if o.snap.dist_m > 0.5 => {
                        let dp = self.doors.as_ref().map(|ix| ix.doors.doors[o.door as usize].pos).unwrap_or(b.pos);
                        leg.geometry.push(lonlat(&dp));
                        leg.levels.push(lv1);
                    }
                    Some(_) => {}
                    None if jb.snap.dist_m > 1.5 && !self.on_track(b) => {
                        leg.geometry.push(lonlat(&b.pos));
                        leg.levels.push(lv1);
                    }
                    None => {}
                }
                // Guesses: a straight line over 20 m across open ground, or through the wall of a building where no
                // door could be used (whether that is step-free is not known either)
                // (a door joined only through its own house: the way round the house is not mapped either)
                let wall_a = (ja.door.is_none() && a.doors.in_building && shift > 0) || ja.door.is_some_and(|o| o.through);
                let wall_b = (jb.door.is_none() && b.doors.in_building && leg.geometry.len() as u32 - 1 > path_end) || jb.door.is_some_and(|o| o.through);
                let guess_a = match ja.door {
                    Some(o) => o.snap.dist_m > GUESS_M || o.through,
                    None => (ja.snap.dist_m > GUESS_M && !self.on_track(a)) || wall_a,
                };
                let guess_b = match jb.door {
                    Some(o) => o.snap.dist_m > GUESS_M || o.through,
                    None => (jb.snap.dist_m > GUESS_M && !self.on_track(b)) || wall_b,
                };
                if guess_a && shift > 0 {
                    leg.approx_start = Some(shift);
                }
                if guess_b && leg.geometry.len() as u32 - 1 > path_end {
                    leg.approx_end = Some(path_end);
                }
                leg.door = jb.door.as_ref().and_then(|o| self.door_json(o));
                leg.start_door = ja.door.as_ref().and_then(|o| self.door_json(o));
                leg.no_step_free_door = b.doors.no_step_free_door;
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
                let extra = ja.extra_m + jb.extra_m;
                leg.distance_m = (p.dist_m + extra).round() as u32;
                leg.stairs_up = p.stairs_up;
                leg.stairs_down = p.stairs_down;
                leg.lifts = p.lifts;
                leg.escalators = p.escalators;
                leg.unmapped_level_changes = p.unmapped_level_changes;
                leg.step_free = step_free(&p, wall_a || wall_b, a.doors.no_step_free_door || b.doors.no_step_free_door);
                if kind == "direct" {
                    let secs = walk_secs(p.cost.var_m + extra, p.cost.fix_s, speed).ceil() as i64;
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
        live: Option<&dyn LiveView>,
    ) -> json::Journey {
        let tt = &self.tt;
        let ux = |s: Secs| time::to_unix(date, s);
        let mut legs: Vec<JLeg> = Vec::with_capacity(j.legs.len());
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
                    legs.push(JLeg::Walk(self.walk_leg("access", from, &self.stop_end(s), ux(dep), ux(arr) - buf, profile)));
                }
                Leg::Egress { from: s, dep, arr } => {
                    let at_station = to_is_station == Some(tt.stops[s as usize].station);
                    if at_station && arr - dep <= 0 {
                        continue;
                    }
                    let buf = (crate::state::ACCESS_BUFFER_S as i64).min((arr - dep) as i64);
                    legs.push(JLeg::Walk(self.walk_leg("egress", &self.stop_end(s), to, ux(dep), ux(arr) - buf, profile)));
                }
                Leg::Transfer { from: a, to: b, dep, arr, .. } => {
                    let mut w = self.walk_leg("transfer", &self.stop_end(a), &self.stop_end(b), ux(dep), ux(arr), profile);
                    w.official_min_s = tt.official_transfer(a, b);
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
            if let JLeg::Walk(w) = &mut legs[i] {
                if let Some(nd) = next_dep {
                    let start = prev_arr.unwrap_or(w.dep);
                    let m = if w.kind == "transfer" { margin as i64 } else { 0 };
                    let slack = nd - start - w.duration_s - m;
                    w.slack_s = Some(slack);
                    if w.kind == "transfer" {
                        let spare = nd - start - w.duration_s;
                        if spare < 0 {
                            alerts.push(json::JourneyAlert { severity: "severe", kind: "missed-connection", leg: Some(i), text: format!("You will miss this change at {} with the current delays", w.to.name) });
                        } else if spare < 90 {
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
            legs: vec![JLeg::Walk(w)],
            alerts: vec![],
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
        let egress = self.reach(&to_ep, &profile, max_walk);
        if egress.stops.is_empty() {
            return Err("no public transport stop within walking distance of the destination".into());
        }
        let to_end = WalkEnd { name: to_ep.place.name.clone(), pos: to_ep.pos, stop: None, snap: egress.snap, doors: egress.doors };

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
            let from_end = WalkEnd { name: from_place.name.clone(), pos: here.pos, stop: None, snap: None, doors: DoorChoice::default() };
            let out: Vec<json::Journey> =
                journeys.iter().take(6).map(|j| self.journey(j, qdate, &from_end, &to_end, None, to_ep.station, &profile, margin, live)).collect();
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
        let access: Reach = self.reach(&from_ep, &profile, max_walk);
        let from_end = WalkEnd { name: from_ep.place.name.clone(), pos: from_ep.pos, stop: None, snap: access.snap, doors: access.doors.clone() };
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

        // A departure window is Pareto-optimal only within itself: a slow
        // many-change option can survive because the faster one that beats
        // it leaves just after the window. Drop options that are far slower
        // than the best while also needing more changes.
        if let Some(best) = picked.iter().min_by_key(|j| (j.arr - j.dep, j.transfers)).map(|j| (j.arr - j.dep, j.transfers)) {
            picked.retain(|j| j.transfers <= best.1 || (j.arr - j.dep) as f32 <= best.0 as f32 * 1.5 + 600.0);
        }
        let journeys: Vec<json::Journey> =
            picked.iter().map(|j| self.journey(j, qdate, &from_end, &to_end, from_ep.station, to_ep.station, &profile, margin, live)).collect();

        let start = match dir {
            Dir::After(t) => t,
            Dir::Before(t) | Dir::ArriveBy(t) => journeys.last().map(|j| j.dep).unwrap_or(t),
        };
        let walk_only = if req.page.is_none() { self.direct_walk(&from_end, &to_end, start, &profile) } else { None };

        let later = picked.last().map(|j| format!("l:{}", time::to_unix(qdate, j.dep) + 60));
        let earlier = picked.first().map(|j| format!("e:{}", time::to_unix(qdate, j.dep) - 60));
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
            let doors = if p.station.is_none() && !r.exact { self.door_choice(p.pos, &profile) } else { DoorChoice::default() };
            Ok(WalkEnd { name: p.place.name.clone(), pos: p.pos, stop: None, snap: self.snap_free(p.pos, &profile), doors })
        };
        let (ea, eb) = (end(&req.from)?, end(&req.to)?);
        Ok(self.walk_leg("direct", &ea, &eb, now, now, &profile))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kante_walk::WalkCost;
    #[test]
    fn a_walk_through_a_wall_or_to_a_building_without_a_step_free_door_is_not_step_free() {
        let p = WalkPath { cost: WalkCost::default(), dist_m: 10.0, stairs_up: 0, stairs_down: 0, lifts: 0, escalators: 0, unmapped_level_changes: 0, geometry: vec![], levels: vec![], steps: vec![], covered: vec![] };
        assert!(step_free(&p, false, false));
        assert!(!step_free(&p, true, false), "into a building through no known door");
        assert!(!step_free(&p, false, true), "the building's doors are all wheelchair=no");
        assert!(!step_free(&WalkPath { stairs_up: 12, ..p.clone() }, false, false));
    }
}
