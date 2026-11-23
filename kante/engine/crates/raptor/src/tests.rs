use crate::testutil::*;
use crate::*;
use kante_core::geo::{BBox, LatLon};
use kante_core::time::{Date, Secs, DAY};
use kante_core::*;
use std::sync::Arc;

/// Query date: three days into the test calendar.
const QD: Date = D0 + 3;

struct World {
    rt: Router,
    trips: Vec<TripIdx>,
    none: Footpaths,
}

impl World {
    fn new(b: Builder) -> Self {
        let built = b.build();
        let none = footpaths(built.tt.stops.len(), &[]);
        World { rt: Router::new(Arc::new(built.tt)), trips: built.trips, none }
    }
    fn tt(&self) -> &Timetable {
        self.rt.timetable()
    }
    fn t(&self, id: usize) -> TripIdx {
        self.trips[id]
    }
    /// Plan and validate every journey.
    fn plan(&self, q: &Query) -> Vec<Journey> {
        let js = self.rt.plan(q);
        for j in &js {
            if let Err(e) = check_journey(self.tt(), q, j) {
                panic!("invalid journey: {e}\n{j:#?}");
            }
        }
        for w in js.windows(2) {
            assert!(w[0].dep <= w[1].dep, "not sorted by departure");
        }
        js
    }
}

fn query<'a>(from: Secs, access: &'a [(StopIdx, Secs)], egress: &'a [(StopIdx, Secs)], fp: &'a Footpaths) -> Query<'a> {
    Query::new(QD, from, access, egress, fp)
}

/// Rides of a journey as (trip, from_pos, to_pos).
fn rides(j: &Journey) -> Vec<(TripIdx, u16, u16)> {
    j.legs
        .iter()
        .filter_map(|l| match *l {
            Leg::Ride { trip, from_pos, to_pos, .. } => Some((trip, from_pos, to_pos)),
            _ => None,
        })
        .collect()
}

fn live_times(tt: &Timetable, q: &Query, trip: TripIdx, date: Date, pos: usize) -> (Secs, Secs, bool) {
    let shift = (date - q.date) * DAY;
    let l = q.live.and_then(|l| l.trip(date, trip));
    (
        tt.arr(trip, pos) + shift + l.map_or(0, |l| l.arr_delay_at(pos)),
        tt.dep(trip, pos) + shift + l.map_or(0, |l| l.dep_delay_at(pos)),
        l.is_some_and(|l| l.is_skipped(pos)),
    )
}

/// Independent feasibility check of one journey against the contract.
fn check_journey(tt: &Timetable, q: &Query, j: &Journey) -> Result<(), String> {
    macro_rules! ensure {
        ($c:expr, $($m:tt)*) => { if !$c { return Err(format!($($m)*)); } };
    }
    let acc = |s: StopIdx| q.access.iter().filter(|a| a.0 == s).map(|a| a.1).min();
    let egr = |s: StopIdx| q.egress.iter().filter(|a| a.0 == s).map(|a| a.1).min();
    ensure!(j.legs.len() >= 2, "too few legs");
    let mut at: Option<StopIdx> = None;
    let mut ready = Secs::MIN; // earliest boarding time at `at`
    let mut last_arr = Secs::MIN;
    let mut prev_ride: Option<(TripIdx, Date, u16)> = None;
    let mut prev_was_ride = false;
    let mut n_rides = 0;
    let n = j.legs.len();
    for (li, leg) in j.legs.iter().enumerate() {
        match *leg {
            Leg::Access { to, dep, arr } => {
                ensure!(li == 0 && q.onboard.is_none(), "access leg misplaced");
                let a = acc(to).ok_or("access stop not in query")?;
                ensure!(arr - dep == a, "access duration");
                ensure!(dep == j.dep && dep >= q.from, "access departure {dep} vs journey {} / from {}", j.dep, q.from);
                ensure!(q.window == 0 || dep <= q.from + q.window, "departure outside window");
                at = Some(to);
                ready = arr;
                prev_was_ride = false;
            }
            Leg::Ride { trip, date, from_pos, to_pos, dep, arr, stay_seated, onboard } => {
                let p = tt.trips[trip as usize].pattern;
                let (stops, flags) = (tt.pattern_stops(p), tt.pattern_flags(p));
                ensure!(tt.trip_active(trip, date), "trip not running on its date");
                ensure!(q.modes & tt.trip_line(trip).mode.bit() != 0 || onboard, "mode not allowed");
                ensure!(from_pos <= to_pos && (to_pos as usize) < stops.len(), "positions");
                let (_, ldep, skip_from) = live_times(tt, q, trip, date, from_pos as usize);
                let (larr, _, skip_to) = live_times(tt, q, trip, date, to_pos as usize);
                if onboard {
                    let ob = q.onboard.ok_or("onboard ride without onboard query")?;
                    ensure!(li == 0 && ob.trip == trip && ob.date == date && ob.next_pos == from_pos, "onboard ride mismatch");
                    ensure!(dep == q.from && j.dep == q.from, "onboard departure");
                    ensure!(arr == larr.max(q.from), "onboard arrival");
                } else if stay_seated {
                    let (pt, pd, ppos) = prev_ride.filter(|_| prev_was_ride).ok_or("stay_seated without previous ride")?;
                    let pn = tt.pattern_stops(tt.trips[pt as usize].pattern).len();
                    ensure!(ppos as usize == pn - 1 && from_pos == 0, "continuation must join last stop to first");
                    ensure!(
                        tt.continuations_from(pt).iter().any(|c| c.to == trip && (c.service == NONE || tt.service_active(c.service, pd))),
                        "no such continuation"
                    );
                    ensure!(dep == ldep && arr == larr, "ride times");
                    ensure!(to_pos > from_pos, "empty continuation ride");
                } else {
                    ensure!(!prev_was_ride, "two rides without transfer");
                    ensure!(Some(stops[from_pos as usize]) == at, "ride starts at another stop");
                    ensure!(flags[from_pos as usize] & FLAG_NO_PICKUP == 0, "boarding where pickup is not allowed");
                    ensure!(!skip_from, "boarding at a skipped stop / cancelled trip");
                    ensure!(dep == ldep && arr == larr, "ride times {dep}-{arr} vs {ldep}-{larr}");
                    ensure!(dep >= ready, "boards at {dep} before ready {ready}");
                    ensure!(to_pos > from_pos, "empty ride");
                }
                ensure!(flags[to_pos as usize] & FLAG_NO_DROPOFF == 0, "alighting where drop-off is not allowed");
                ensure!(!skip_to || onboard, "alighting at a skipped stop / cancelled trip");
                ensure!(arr >= dep, "ride goes back in time");
                if !stay_seated {
                    n_rides += 1;
                }
                at = Some(stops[to_pos as usize]);
                last_arr = arr;
                prev_ride = Some((trip, date, to_pos));
                prev_was_ride = true;
            }
            Leg::Transfer { from, to, dep, arr, var_m, fix_s } => {
                ensure!(prev_was_ride && Some(from) == at, "transfer misplaced");
                ensure!(dep == last_arr, "transfer starts at {dep}, ride arrived {last_arr}");
                if from == to {
                    ensure!(var_m == 0 && fix_s == 0 && arr == dep, "same-stop transfer must be empty");
                } else {
                    ensure!(q.footpaths.get(from, to) == Some((var_m, fix_s)), "no such footpath");
                    let w = walk_secs(var_m as f32, fix_s as f32, q.walk_speed).ceil() as Secs;
                    ensure!(arr - dep == w && w <= q.max_walk, "walk time");
                }
                at = Some(to);
                ready = arr + q.transfer_margin;
                prev_was_ride = false;
                ensure!(matches!(j.legs.get(li + 1), Some(Leg::Ride { stay_seated: false, .. })), "transfer not followed by a ride");
            }
            Leg::Egress { from, dep, arr } => {
                ensure!(li == n - 1 && prev_was_ride && Some(from) == at, "egress misplaced");
                let e = egr(from).ok_or("egress stop not in query")?;
                ensure!(dep == last_arr && arr - dep == e && arr == j.arr, "egress times");
            }
        }
    }
    ensure!(matches!(j.legs[n - 1], Leg::Egress { .. }), "no egress leg");
    ensure!(n_rides >= 1 && j.transfers as usize == n_rides - 1, "transfer count");
    ensure!(j.transfers <= q.max_transfers, "too many transfers");
    Ok(())
}

// ───────────────────────── basic scenarios ─────────────────────────

#[test]
fn direct_trip() {
    let mut b = Builder::new();
    let (a, m, z) = (b.stop("A"), b.stop("M"), b.stop("Z"));
    let l = b.line("1", Mode::Bus);
    let p = b.pattern(l, &[a, m, z]);
    let t0 = b.trip(p, &[hm(8, 0), hm(8, 10), hm(8, 20)]);
    let t1 = b.trip(p, &[hm(8, 30), hm(8, 40), hm(8, 50)]);
    let w = World::new(b);
    let js = w.plan(&query(hm(8, 5), &[(a, 120)], &[(z, 60)], &w.none));
    assert_eq!(js.len(), 1);
    assert_eq!(rides(&js[0]), vec![(w.t(t1), 0, 2)]);
    assert_eq!((js[0].dep, js[0].arr, js[0].transfers), (hm(8, 28), hm(8, 51), 0));
    assert_eq!(js[0].legs[0], Leg::Access { to: a, dep: hm(8, 28), arr: hm(8, 30) });
    assert_eq!(js[0].legs[2], Leg::Egress { from: z, dep: hm(8, 50), arr: hm(8, 51) });
    // Exactly catchable.
    let js = w.plan(&query(hm(7, 58), &[(a, 120)], &[(z, 60)], &w.none));
    assert_eq!(rides(&js[0]), vec![(w.t(t0), 0, 2)]);
    // Nothing after the last trip today; tomorrow's first trip is found.
    let js = w.plan(&query(hm(9, 0), &[(a, 0)], &[(z, 0)], &w.none));
    assert_eq!(js.len(), 1);
    assert!(matches!(js[0].legs[1], Leg::Ride { date, dep, .. } if date == QD + 1 && dep == DAY + hm(8, 0)));
    // Unknown stops and empty inputs do not panic.
    assert!(w.plan(&query(0, &[(999, 0)], &[(z, 0)], &w.none)).is_empty());
    assert!(w.plan(&query(0, &[], &[(z, 0)], &w.none)).is_empty());
    assert!(w.plan(&query(0, &[(a, 0)], &[], &w.none)).is_empty());
    // Outside the calendar there is no service.
    let (acc_, egr_) = ([(a, 0)], [(z, 0)]);
    let mut q = query(hm(8, 0), &acc_, &egr_, &w.none);
    q.date = D0 + 400;
    assert!(w.plan(&q).is_empty());
}

#[test]
fn change_needs_margin() {
    let mut b = Builder::new();
    let (a, x, z) = (b.stop("A"), b.stop("X"), b.stop("Z"));
    let l = b.line("1", Mode::Bus);
    let p1 = b.pattern(l, &[a, x]);
    let p2 = b.pattern(l, &[x, z]);
    let t1 = b.trip(p1, &[hm(8, 0), hm(8, 10)]);
    let c_early = b.trip(p2, &[hm(8, 11), hm(8, 30)]);
    let c_ok = b.trip(p2, &[hm(8, 12), hm(8, 31)]);
    let w = World::new(b);
    // 120 s margin at the same stop: the 08:11 is missed, the 08:12 is caught.
    let (acc_, egr_) = ([(a, 0)], [(z, 0)]);
    let q = query(hm(7, 50), &acc_, &egr_, &w.none);
    let js = w.plan(&q);
    assert_eq!(js.len(), 1);
    assert_eq!(rides(&js[0]), vec![(w.t(t1), 0, 1), (w.t(c_ok), 0, 1)]);
    assert_eq!(js[0].legs[2], Leg::Transfer { from: x, to: x, dep: hm(8, 10), arr: hm(8, 10), var_m: 0, fix_s: 0 });
    assert_eq!(js[0].transfers, 1);
    // With a 60 s margin the 08:11 works.
    let mut q2 = q;
    q2.transfer_margin = 60;
    assert_eq!(rides0(&w.plan(&q2))[1], (w.t(c_early), 0, 1));
    // No transfers allowed: no journey.
    let mut q3 = q;
    q3.max_transfers = 0;
    assert!(w.plan(&q3).is_empty());
}

#[test]
fn footpath_change_and_walking_speed() {
    let mut b = Builder::new();
    let (a, x, y, z) = (b.stop("A"), b.stop("X"), b.stop("Y"), b.stop("Z"));
    let l = b.line("1", Mode::Bus);
    let p1 = b.pattern(l, &[a, x]);
    let p2 = b.pattern(l, &[y, z]);
    b.trip(p1, &[hm(8, 0), hm(8, 10)]);
    let c1 = b.trip(p2, &[hm(8, 15), hm(8, 30)]);
    let c2 = b.trip(p2, &[hm(8, 25), hm(8, 40)]);
    let w = World::new(b);
    // 260 m plus a 20 s crossing: 220 s at 1.3 m/s, 150 s at 2 m/s, 345 s at 0.8 m/s.
    let fp = footpaths(w.tt().stops.len(), &[(x, y, 260, 20)]);
    let (acc_, egr_) = ([(a, 0)], [(z, 0)]);
    let mut q = query(hm(7, 50), &acc_, &egr_, &fp);
    q.transfer_margin = 60;
    // 1.3 m/s: at Y 08:13:40 + 60 s margin → the 08:15 is caught.
    let js = w.plan(&q);
    assert_eq!(rides(&js[0])[1].0, w.t(c1));
    assert_eq!(js[0].legs[2], Leg::Transfer { from: x, to: y, dep: hm(8, 10), arr: hm(8, 10) + 220, var_m: 260, fix_s: 20 });
    // 0.8 m/s: 345 s walk → only the 08:25.
    q.walk_speed = 0.8;
    let js = w.plan(&q);
    assert_eq!(rides(&js[0])[1].0, w.t(c2));
    // …and with a 5 minute walking limit the footpath is not usable at all.
    q.max_walk = 300;
    assert!(w.plan(&q).is_empty());
    // Fast walker again, without any footpaths: no connection.
    let (acc_, egr_) = ([(a, 0)], [(z, 0)]);
    let mut q = query(hm(7, 50), &acc_, &egr_, &w.none);
    q.walk_speed = 2.0;
    assert!(w.plan(&q).is_empty());
    // Footpaths with the wrong shape are ignored instead of panicking.
    let empty = Footpaths::default();
    assert!(w.plan(&query(hm(7, 50), &[(a, 0)], &[(z, 0)], &empty)).is_empty());
}

#[test]
fn footpaths_are_not_chained() {
    let mut b = Builder::new();
    let (a, x, y, y2, z) = (b.stop("A"), b.stop("X"), b.stop("Y"), b.stop("Y2"), b.stop("Z"));
    let l = b.line("1", Mode::Bus);
    let p1 = b.pattern(l, &[a, x]);
    let p2 = b.pattern(l, &[y2, z]);
    b.trip(p1, &[hm(8, 0), hm(8, 10)]);
    b.trip(p2, &[hm(9, 0), hm(9, 30)]);
    let w = World::new(b);
    let fp = footpaths(w.tt().stops.len(), &[(x, y, 100, 0), (y, y2, 100, 0)]);
    assert!(w.plan(&query(hm(7, 50), &[(a, 0)], &[(z, 0)], &fp)).is_empty());
    // A self-entry in the footpaths does not replace the same-stop rule.
    let fp = footpaths(w.tt().stops.len(), &[(x, x, 500, 0), (x, y2, 100, 0)]);
    assert_eq!(w.plan(&query(hm(7, 50), &[(a, 0)], &[(z, 0)], &fp)).len(), 1);
}

#[test]
fn overnight_trip_of_previous_service_day() {
    let mut b = Builder::new();
    let (a, z) = (b.stop("A"), b.stop("Z"));
    let l = b.line("N1", Mode::Bus);
    let p = b.pattern(l, &[a, z]);
    // Runs only on the service date before the query date, at 24:40 → 25:10.
    let only_prev = b.service(&[2]);
    let night = b.trip_on(p, only_prev, &[(hm(24, 40), hm(24, 40)), (hm(25, 10), hm(25, 10))]);
    let day = b.trip(p, &[hm(6, 0), hm(6, 30)]);
    let w = World::new(b);
    let js = w.plan(&query(hm(0, 30), &[(a, 0)], &[(z, 0)], &w.none));
    assert_eq!(js.len(), 1);
    assert_eq!(js[0].legs[1], Leg::Ride { trip: w.t(night), date: QD - 1, from_pos: 0, to_pos: 1, dep: hm(0, 40), arr: hm(1, 10), stay_seated: false, onboard: false });
    // After it has left, the first daytime trip.
    let js = w.plan(&query(hm(0, 45), &[(a, 0)], &[(z, 0)], &w.none));
    assert_eq!(rides(&js[0]), vec![(w.t(day), 0, 1)]);
    // A range over midnight sees both.
    let (acc_, egr_) = ([(a, 0)], [(z, 0)]);
    let mut q = query(hm(0, 0), &acc_, &egr_, &w.none);
    q.window = hm(7, 0);
    let js = w.plan(&q);
    assert_eq!(js.iter().map(|j| j.dep).collect::<Vec<_>>(), vec![hm(0, 40), hm(6, 0)]);
    // Late in the evening of the day before: the same trip as a >24 h time.
    let (acc_, egr_) = ([(a, 0)], [(z, 0)]);
    let mut q = query(hm(23, 50), &acc_, &egr_, &w.none);
    q.date = QD - 1;
    let js = w.plan(&q);
    assert!(matches!(js[0].legs[1], Leg::Ride { date, dep, .. } if date == QD - 1 && dep == hm(24, 40)));
}

#[test]
fn round_the_clock_pattern() {
    // Trips from 05:00 to 29:30: yesterday's late trips run between today's early ones.
    let mut b = Builder::new();
    let (a, m, z) = (b.stop("A"), b.stop("M"), b.stop("Z"));
    let l = b.line("24h", Mode::Bus);
    let p = b.pattern(l, &[a, m, z]);
    let ids = b.trips_every(p, hm(5, 0), 3600, 25, &[0, 600, 1200]); // 05:00, 06:00, … 29:00
    let half = b.trip(p, &[hm(29, 30), hm(29, 40), hm(29, 50)]);
    let w = World::new(b);
    let (acc, egr) = ([(m, 0)], [(z, 0)]);
    // 05:20 at M: yesterday's 29:30 trip passes at 05:40, before today's 06:10.
    let js = w.plan(&query(hm(5, 20), &acc, &egr, &w.none));
    assert!(matches!(js[0].legs[1], Leg::Ride { trip, date, dep, .. } if trip == w.t(half) && date == QD - 1 && dep == hm(5, 40)));
    // 05:05 at M: today's 05:00 trip passes at 05:10 (yesterday's 29:00 at the same minute is as good).
    let js = w.plan(&query(hm(5, 5), &acc, &egr, &w.none));
    assert_eq!(js[0].arr, hm(5, 20));
    // Every departure of the first hours, in order, from both service dates.
    let mut q = query(hm(3, 0), &acc, &egr, &w.none);
    q.window = hm(3, 30);
    let js = w.plan(&q);
    assert_eq!(js.iter().map(|j| j.dep).collect::<Vec<_>>(), vec![hm(3, 10), hm(4, 10), hm(5, 10), hm(5, 40), hm(6, 10)]);
    assert_eq!(rides(&js[1])[0].0, w.t(ids[23]));
    // Board the same pattern after a feeder: the earlier of the two dates' trips is taken.
    let ev = w.rt.departures(&[m], QD, hm(5, 0), 4, None);
    assert_eq!(ev.iter().map(|e| (e.dep, e.date)).collect::<Vec<_>>(), vec![(hm(5, 10), QD), (hm(5, 10), QD - 1), (hm(5, 40), QD - 1), (hm(6, 10), QD)]);
}

#[test]
fn pickup_and_dropoff_flags() {
    let mut b = Builder::new();
    let (a, m, z) = (b.stop("A"), b.stop("M"), b.stop("Z"));
    let l = b.line("1", Mode::Bus);
    // Fast line: no boarding at M, no alighting at M either way round.
    let fast = b.pattern_flags(l, &[a, m, z], &[0, FLAG_NO_PICKUP | FLAG_NO_DROPOFF, 0]);
    let slow = b.pattern(l, &[a, m, z]);
    let f = b.trip(fast, &[hm(8, 0), hm(8, 5), hm(8, 10)]);
    let s = b.trip(slow, &[hm(8, 20), hm(8, 30), hm(8, 40)]);
    let w = World::new(b);
    // From M the fast trip (08:05) cannot be boarded.
    let js = w.plan(&query(hm(7, 0), &[(m, 0)], &[(z, 0)], &w.none));
    assert_eq!(rides(&js[0]), vec![(w.t(s), 1, 2)]);
    // To M the fast trip cannot be left.
    let js = w.plan(&query(hm(7, 0), &[(a, 0)], &[(m, 0)], &w.none));
    assert_eq!(rides(&js[0]), vec![(w.t(s), 0, 1)]);
    // End to end the fast trip is fine.
    let js = w.plan(&query(hm(7, 0), &[(a, 0)], &[(z, 0)], &w.none));
    assert_eq!(rides(&js[0]), vec![(w.t(f), 0, 2)]);
}

#[test]
fn in_seat_continuation() {
    let mut b = Builder::new();
    let (a, x, y, z) = (b.stop("A"), b.stop("X"), b.stop("Y"), b.stop("Z"));
    let l = b.line("1", Mode::Rail);
    let p1 = b.pattern(l, &[a, x]);
    let p2 = b.pattern(l, &[x, y, z]);
    let t1 = b.trip(p1, &[hm(8, 0), hm(8, 30)]);
    // Leaves X one minute after t1 arrives: impossible as a change (2 min margin).
    let t2 = b.trip(p2, &[hm(8, 31), hm(8, 45), hm(9, 0)]);
    let later = b.trip(p2, &[hm(9, 31), hm(9, 45), hm(10, 0)]);
    b.continuation(t1, t2, NONE);
    // A continuation that only applies on another day must not be used.
    let other_day = b.service(&[0]);
    let t3 = b.trip(p1, &[hm(8, 50), hm(9, 30)]);
    b.continuation(t3, later, other_day);
    let w = World::new(b);
    let (acc_, egr_) = ([(a, 0)], [(z, 0)]);
    let q = query(hm(7, 0), &acc_, &egr_, &w.none);
    let js = w.plan(&q);
    assert_eq!(js.len(), 1);
    assert_eq!(js[0].transfers, 0);
    assert_eq!(
        js[0].legs[1..3],
        [
            Leg::Ride { trip: w.t(t1), date: QD, from_pos: 0, to_pos: 1, dep: hm(8, 0), arr: hm(8, 30), stay_seated: false, onboard: false },
            Leg::Ride { trip: w.t(t2), date: QD, from_pos: 0, to_pos: 2, dep: hm(8, 31), arr: hm(9, 0), stay_seated: true, onboard: false },
        ]
    );
    // Even with no transfers allowed.
    let mut q0 = q;
    q0.max_transfers = 0;
    assert_eq!(w.plan(&q0).len(), 1);
    // After t1 has gone, t3 does not continue today → the change at X misses the 09:31.
    let js = w.plan(&query(hm(8, 10), &[(a, 0)], &[(z, 0)], &w.none));
    assert!(js.iter().all(|j| j.legs.iter().all(|l| !matches!(l, Leg::Ride { stay_seated: true, .. }))));
    assert!(js.is_empty() || js[0].arr > hm(10, 0));
    // Intermediate stop on the continuation, and a range query.
    let (acc_, egr_) = ([(a, 0)], [(y, 30)]);
    let mut q = query(hm(7, 0), &acc_, &egr_, &w.none);
    q.window = hm(2, 0);
    let js = w.plan(&q);
    assert_eq!(js[0].arr, hm(8, 45) + 30);
    // Cancelled continuation trip: cannot stay seated.
    let mut live = TestLive::default();
    live.cancel(QD, w.t(t2));
    let (acc_, egr_) = ([(a, 0)], [(z, 0)]);
    let mut q = query(hm(7, 0), &acc_, &egr_, &w.none);
    q.live = Some(&live);
    let js = w.plan(&q);
    assert_eq!(rides(&js[0]), vec![(w.t(t1), 0, 1), (w.t(later), 0, 2)]);
}

#[test]
fn live_delay_breaks_and_makes_connections() {
    let mut b = Builder::new();
    let (a, x, z) = (b.stop("A"), b.stop("X"), b.stop("Z"));
    let l = b.line("1", Mode::Rail);
    let p1 = b.pattern(l, &[a, x]);
    let p2 = b.pattern(l, &[x, z]);
    let feeder = b.trip(p1, &[hm(8, 0), hm(8, 10)]);
    let c1 = b.trip(p2, &[hm(8, 9), hm(8, 30)]); // leaves before the feeder arrives
    let c2 = b.trip(p2, &[hm(8, 15), hm(8, 36)]);
    let c3 = b.trip(p2, &[hm(8, 45), hm(9, 6)]);
    let w = World::new(b);
    let (acc, egr) = ([(a, 0)], [(z, 0)]);
    let q = query(hm(7, 50), &acc, &egr, &w.none);
    assert_eq!(rides0(&w.plan(&q))[1].0, w.t(c2));

    // Feeder 6 min late: c2 is missed, c3 it is.
    let mut live = TestLive::default();
    live.delay(QD, w.t(feeder), 2, 0, 360);
    let mut ql = q;
    ql.live = Some(&live);
    let js = w.plan(&ql);
    assert_eq!(rides(&js[0])[1].0, w.t(c3));
    assert!(matches!(js[0].legs[1], Leg::Ride { dep, arr, .. } if dep == hm(8, 6) && arr == hm(8, 16)));
    assert_eq!(js[0].dep, hm(8, 6));

    // c1 5 min late: now it is catchable and the best option.
    let mut live = TestLive::default();
    live.delay(QD, w.t(c1), 2, 0, 300);
    ql.live = Some(&live);
    let js = w.plan(&ql);
    assert_eq!(rides(&js[0])[1].0, w.t(c1));
    assert_eq!(js[0].arr, hm(8, 35));

    // The delay belongs to one service date only.
    let mut live = TestLive::default();
    live.delay(QD + 1, w.t(feeder), 2, 0, 360);
    ql.live = Some(&live);
    assert_eq!(rides0(&w.plan(&ql))[1].0, w.t(c2));
}

/// Rides of the first journey.
fn rides0(js: &[Journey]) -> Vec<(TripIdx, u16, u16)> {
    rides(&js[0])
}

#[test]
fn cancelled_and_skipped() {
    let mut b = Builder::new();
    let (a, m, z) = (b.stop("A"), b.stop("M"), b.stop("Z"));
    let l = b.line("1", Mode::Tram);
    let p = b.pattern(l, &[a, m, z]);
    let t0 = b.trip(p, &[hm(8, 0), hm(8, 10), hm(8, 20)]);
    let t1 = b.trip(p, &[hm(8, 30), hm(8, 40), hm(8, 50)]);
    let w = World::new(b);
    let (acc, egr) = ([(a, 0)], [(z, 0)]);
    let mut q = query(hm(7, 50), &acc, &egr, &w.none);

    let mut live = TestLive::default();
    live.cancel(QD, w.t(t0));
    q.live = Some(&live);
    assert_eq!(rides0(&w.plan(&q)), vec![(w.t(t1), 0, 2)]);

    // t0 does not call at Z today: cannot alight there → next trip.
    let mut live = TestLive::default();
    live.skip(QD, w.t(t0), 3, 2);
    q.live = Some(&live);
    assert_eq!(rides0(&w.plan(&q)), vec![(w.t(t1), 0, 2)]);
    // …but it still serves M.
    let egr_m = [(m, 0)];
    let mut qm = query(hm(7, 50), &acc, &egr_m, &w.none);
    qm.live = Some(&live);
    assert_eq!(rides0(&w.plan(&qm)), vec![(w.t(t0), 0, 1)]);

    // t0 does not call at M today: cannot board there.
    let mut live = TestLive::default();
    live.skip(QD, w.t(t0), 3, 1);
    let acc_m = [(m, 0)];
    let mut qs = query(hm(7, 50), &acc_m, &egr, &w.none);
    qs.live = Some(&live);
    assert_eq!(rides0(&w.plan(&qs)), vec![(w.t(t1), 1, 2)]);
    // Range query: the skipped call is not a departure either.
    qs.window = hm(1, 0);
    let js = w.plan(&qs);
    assert_eq!(js.len(), 1);
    assert_eq!(rides(&js[0]), vec![(w.t(t1), 1, 2)]);
}

#[test]
fn delayed_trip_overtaken_inside_pattern() {
    let mut b = Builder::new();
    let (a, z) = (b.stop("A"), b.stop("Z"));
    let l = b.line("1", Mode::Bus);
    let p = b.pattern(l, &[a, z]);
    let ids = b.trips_every(p, hm(8, 0), 600, 6, &[0, 900]);
    let w = World::new(b);
    let (acc, egr) = ([(a, 0)], [(z, 0)]);
    // The 08:00 runs 25 min late (leaves 08:25), i.e. after the 08:10 and 08:20.
    let mut live = TestLive::default();
    live.delay(QD, w.t(ids[0]), 2, 0, 1500);
    let mut q = query(hm(8, 5), &acc, &egr, &w.none);
    q.live = Some(&live);
    // At 08:05 the scheduled-earlier trip has not left, but the 08:10 leaves first.
    let js = w.plan(&q);
    assert_eq!(rides(&js[0]), vec![(w.t(ids[1]), 0, 1)]);
    // At 08:22 the late 08:00 (08:25) is the next to leave — a binary search on
    // scheduled times alone would miss it.
    q.from = hm(8, 22);
    let js = w.plan(&q);
    assert_eq!(rides(&js[0]), vec![(w.t(ids[0]), 0, 1)]);
    assert_eq!((js[0].dep, js[0].arr), (hm(8, 25), hm(8, 40)));
    // Range: every departure once, in live order.
    q.from = hm(8, 0);
    q.window = hm(0, 31);
    let js = w.plan(&q);
    assert_eq!(js.iter().map(|j| j.dep).collect::<Vec<_>>(), vec![hm(8, 10), hm(8, 20), hm(8, 25), hm(8, 30)]);
    assert_eq!(rides(&js[2]), vec![(w.t(ids[0]), 0, 1)]);

    // The same inside a later round: feeder arrives 08:21.
    let mut b = Builder::new();
    let (o, a, z) = (b.stop("O"), b.stop("A"), b.stop("Z"));
    let l = b.line("1", Mode::Bus);
    let pf = b.pattern(l, &[o, a]);
    let p = b.pattern(l, &[a, z]);
    b.trip(pf, &[hm(8, 0), hm(8, 21)]);
    let ids = b.trips_every(p, hm(8, 0), 600, 6, &[0, 900]);
    let w = World::new(b);
    let mut live = TestLive::default();
    live.delay(QD, w.t(ids[0]), 2, 0, 1500);
    let (acc, egr) = ([(o, 0)], [(z, 0)]);
    let mut q = query(hm(7, 55), &acc, &egr, &w.none);
    q.live = Some(&live);
    let js = w.plan(&q);
    assert_eq!(rides(&js[0])[1], (w.t(ids[0]), 0, 1));
    assert_eq!(js[0].arr, hm(8, 40));
}

#[test]
fn onboard_start() {
    let mut b = Builder::new();
    let (a, m, x, z, y) = (b.stop("A"), b.stop("M"), b.stop("X"), b.stop("Z"), b.stop("Y"));
    let l = b.line("IC", Mode::Rail);
    let p = b.pattern(l, &[a, m, x, z]);
    let p2 = b.pattern(l, &[x, y]);
    let ic = b.trip(p, &[hm(8, 0), hm(8, 20), hm(8, 40), hm(9, 0)]);
    let c1 = b.trip(p2, &[hm(8, 41), hm(9, 0)]);
    let c2 = b.trip(p2, &[hm(8, 50), hm(9, 9)]);
    let w = World::new(b);
    let ob = Some(Onboard { trip: w.t(ic), date: QD, next_pos: 1 });

    // Destination on the same trip; access is ignored.
    let egr = [(z, 45)];
    let acc_y = [(y, 0)];
    let mut q = query(hm(8, 12), &acc_y, &egr, &w.none);
    q.onboard = ob;
    let js = w.plan(&q);
    assert_eq!(js.len(), 1);
    assert_eq!(js[0].legs.len(), 2);
    assert_eq!(js[0].legs[0], Leg::Ride { trip: w.t(ic), date: QD, from_pos: 1, to_pos: 3, dep: hm(8, 12), arr: hm(9, 0), stay_seated: false, onboard: true });
    assert_eq!((js[0].dep, js[0].arr, js[0].transfers), (hm(8, 12), hm(9, 0) + 45, 0));

    // Destination is the very next stop.
    let egr = [(m, 0)];
    let mut q = query(hm(8, 12), &[], &egr, &w.none);
    q.onboard = ob;
    let js = w.plan(&q);
    assert_eq!(rides(&js[0]), vec![(w.t(ic), 1, 1)]);
    assert_eq!(js[0].arr, hm(8, 20));

    // A stop already passed is not reachable on board.
    let egr = [(a, 0)];
    let mut q = query(hm(8, 12), &[], &egr, &w.none);
    q.onboard = ob;
    assert!(w.plan(&q).is_empty());

    // Change at X: 08:41 is too tight (2 min), 08:50 works.
    let egr = [(y, 0)];
    let mut q = query(hm(8, 12), &[], &egr, &w.none);
    q.onboard = ob;
    let js = w.plan(&q);
    assert_eq!(rides(&js[0]), vec![(w.t(ic), 1, 2), (w.t(c2), 0, 1)]);
    assert_eq!(js[0].transfers, 1);
    assert!(matches!(js[0].legs[1], Leg::Transfer { from, to, .. } if from == x && to == x));
    // No change allowed → unreachable.
    q.max_transfers = 0;
    assert!(w.plan(&q).is_empty());

    // The IC runs 9 min late from M on: c2 is missed too, tomorrow's 08:50 is not it — c2 is
    // gone, so the connection is the next day's first.
    let mut live = TestLive::default();
    live.delay(QD, w.t(ic), 4, 1, 540);
    let mut q = query(hm(8, 12), &[], &egr, &w.none);
    q.onboard = ob;
    q.live = Some(&live);
    let js = w.plan(&q);
    assert!(matches!(js[0].legs[0], Leg::Ride { arr, onboard: true, .. } if arr == hm(8, 49)));
    assert!(matches!(js[0].legs[2], Leg::Ride { trip, date, .. } if trip == w.t(c1) && date == QD + 1));

    // Trip of the previous service date (after midnight), query relative to today.
    let (acc_, egr_) = ([], [(z, 0)]);
    let mut q = query(hm(8, 12) - DAY, &acc_, &egr_, &w.none);
    q.date = QD + 1;
    q.onboard = ob;
    let js = w.plan(&q);
    assert_eq!(js[0].arr, hm(9, 0) - DAY);
    assert!(matches!(js[0].legs[0], Leg::Ride { date, .. } if date == QD));

    // Stale position: `from` later than the timetable says → times never run backwards.
    let (acc_, egr_) = ([], [(m, 0)]);
    let mut q = query(hm(8, 30), &acc_, &egr_, &w.none);
    q.onboard = ob;
    let js = w.plan(&q);
    assert_eq!((js[0].dep, js[0].arr), (hm(8, 30), hm(8, 30)));

    // Nonsense input.
    let (acc_, egr_) = ([], [(z, 0)]);
    let mut q = query(hm(8, 12), &acc_, &egr_, &w.none);
    q.onboard = Some(Onboard { trip: w.t(ic), date: QD, next_pos: 9 });
    assert!(w.plan(&q).is_empty());
    q.onboard = Some(Onboard { trip: 999, date: QD, next_pos: 0 });
    assert!(w.plan(&q).is_empty());
}

#[test]
fn onboard_with_continuation() {
    let mut b = Builder::new();
    let (a, x, z) = (b.stop("A"), b.stop("X"), b.stop("Z"));
    let l = b.line("S1", Mode::Rail);
    let p1 = b.pattern(l, &[a, x]);
    let p2 = b.pattern(l, &[x, z]);
    let t1 = b.trip(p1, &[hm(8, 0), hm(8, 30)]);
    let t2 = b.trip(p2, &[hm(8, 31), hm(9, 0)]);
    b.continuation(t1, t2, NONE);
    let w = World::new(b);
    let (acc_, egr_) = ([], [(z, 0)]);
    let mut q = query(hm(8, 5), &acc_, &egr_, &w.none);
    q.onboard = Some(Onboard { trip: w.t(t1), date: QD, next_pos: 1 });
    q.max_transfers = 0;
    let js = w.plan(&q);
    assert_eq!(js.len(), 1);
    assert_eq!(
        js[0].legs[..2],
        [
            Leg::Ride { trip: w.t(t1), date: QD, from_pos: 1, to_pos: 1, dep: hm(8, 5), arr: hm(8, 30), stay_seated: false, onboard: true },
            Leg::Ride { trip: w.t(t2), date: QD, from_pos: 0, to_pos: 1, dep: hm(8, 31), arr: hm(9, 0), stay_seated: true, onboard: false },
        ]
    );
}

#[test]
fn mode_mask() {
    let mut b = Builder::new();
    let (a, z) = (b.stop("A"), b.stop("Z"));
    let rail = b.line("S1", Mode::Rail);
    let bus = b.line("10", Mode::Bus);
    let pr = b.pattern(rail, &[a, z]);
    let pb = b.pattern(bus, &[a, z]);
    let tr = b.trip(pr, &[hm(8, 0), hm(8, 10)]);
    let tb = b.trip(pb, &[hm(8, 5), hm(8, 40)]);
    let w = World::new(b);
    let (acc, egr) = ([(a, 0)], [(z, 0)]);
    let mut q = query(hm(7, 50), &acc, &egr, &w.none);
    assert_eq!(rides0(&w.plan(&q)), vec![(w.t(tr), 0, 1)]);
    q.modes = Mode::Bus.bit() | Mode::Tram.bit();
    assert_eq!(rides0(&w.plan(&q)), vec![(w.t(tb), 0, 1)]);
    q.window = 3600;
    assert_eq!(w.plan(&q).len(), 1);
    q.modes = Mode::Boat.bit();
    assert!(w.plan(&q).is_empty());
}

#[test]
fn range_query_latest_departure() {
    let mut b = Builder::new();
    let (a, x, z) = (b.stop("A"), b.stop("X"), b.stop("Z"));
    let l = b.line("1", Mode::Bus);
    let p1 = b.pattern(l, &[a, x]);
    let p2 = b.pattern(l, &[x, z]);
    // Feeder every 10 min (10 min ride), onward train every 30 min.
    let f = b.trips_every(p1, hm(8, 0), 600, 13, &[0, 600]);
    let c = b.trips_every(p2, hm(8, 30), 1800, 4, &[0, 1200]);
    let w = World::new(b);
    let (acc, egr) = ([(a, 180)], [(z, 0)]);
    let mut q = query(hm(7, 50), &acc, &egr, &w.none);
    q.window = hm(2, 0);
    let js = w.plan(&q);
    // One journey per onward train, each with the last feeder that makes it
    // (arrive X ≤ train − 2 min): 08:10→08:30, 08:40→09:00, 09:10→09:30, 09:40→10:00.
    let got: Vec<_> = js.iter().map(|j| (j.dep, j.arr, rides(j)[0].0, rides(j)[1].0)).collect();
    assert_eq!(
        got,
        vec![
            (hm(8, 7), hm(8, 50), w.t(f[1]), w.t(c[0])),
            (hm(8, 37), hm(9, 20), w.t(f[4]), w.t(c[1])),
            (hm(9, 7), hm(9, 50), w.t(f[7]), w.t(c[2])),
            (hm(9, 37), hm(10, 20), w.t(f[10]), w.t(c[3])),
            // Last feeder inside the window: nothing onward until tomorrow's 08:30.
            (hm(9, 47), DAY + hm(8, 50), w.t(f[11]), w.t(c[0])),
        ]
    );
    // The window bounds the departure from the origin; inside a shorter
    // window an earlier feeder is the latest one for the same train.
    q.window = hm(0, 46); // until 08:36
    let js = w.plan(&q);
    assert_eq!(js.iter().map(|j| (j.dep, j.arr)).collect::<Vec<_>>(), vec![(hm(8, 7), hm(8, 50)), (hm(8, 27), hm(9, 20))]);
    q.window = hm(0, 16); // until 08:06: the 08:07 is out
    let js = w.plan(&q);
    assert_eq!(js.iter().map(|j| (j.dep, j.arr)).collect::<Vec<_>>(), vec![(hm(7, 57), hm(8, 50))]);
    // window = 0: one earliest-arrival search; the feeder is the first one, not the latest.
    q.window = 0;
    let js = w.plan(&q);
    assert_eq!(js.len(), 1);
    assert_eq!((js[0].dep, js[0].arr, rides(&js[0])[0].0), (hm(7, 57), hm(8, 50), w.t(f[0])));
}

#[test]
fn pareto_direct_vs_faster_with_change() {
    let mut b = Builder::new();
    let (a, x, z) = (b.stop("A"), b.stop("X"), b.stop("Z"));
    let bus = b.line("B", Mode::Bus);
    let rail = b.line("R", Mode::Rail);
    let direct = b.pattern(bus, &[a, z]);
    let p1 = b.pattern(rail, &[a, x]);
    let p2 = b.pattern(rail, &[x, z]);
    let d = b.trips_every(direct, hm(8, 0), 3600, 3, &[0, 3600]); // slow direct, hourly
    let r1 = b.trips_every(p1, hm(8, 5), 3600, 3, &[0, 900]);
    let r2 = b.trips_every(p2, hm(8, 25), 3600, 3, &[0, 900]); // arrives 08:40
    let w = World::new(b);
    let (acc, egr) = ([(a, 0)], [(z, 0)]);
    let mut q = query(hm(7, 55), &acc, &egr, &w.none);
    let js = w.plan(&q);
    assert_eq!(js.len(), 2);
    assert_eq!((js[0].dep, js[0].arr, js[0].transfers), (hm(8, 0), hm(9, 0), 0));
    assert_eq!(rides(&js[0]), vec![(w.t(d[0]), 0, 1)]);
    assert_eq!((js[1].dep, js[1].arr, js[1].transfers), (hm(8, 5), hm(8, 40), 1));
    assert_eq!(rides(&js[1]), vec![(w.t(r1[0]), 0, 1), (w.t(r2[0]), 0, 1)]);
    // Range over two hours: the direct bus is only Pareto-optimal where no
    // later departure arrives earlier with as few rides — here 08:05 via X
    // beats the 08:00 bus on arrival, but the bus has fewer rides, so both stay.
    q.window = hm(2, 0);
    let js = w.plan(&q);
    let got: Vec<_> = js.iter().map(|j| (j.dep, j.arr, j.transfers)).collect();
    assert_eq!(
        got,
        vec![
            (hm(8, 0), hm(9, 0), 0),
            (hm(8, 5), hm(8, 40), 1),
            (hm(9, 0), hm(10, 0), 0),
            (hm(9, 5), hm(9, 40), 1),
        ]
    );
    q.max_transfers = 0;
    assert_eq!(w.plan(&q).len(), 2);
}

#[test]
fn latest_arrival_bound() {
    let mut b = Builder::new();
    let (a, m, z) = (b.stop("A"), b.stop("M"), b.stop("Z"));
    let l = b.line("1", Mode::Bus);
    let p = b.pattern(l, &[a, m, z]);
    let t0 = b.trip(p, &[hm(8, 0), hm(8, 10), hm(8, 20)]);
    b.trip(p, &[hm(8, 30), hm(8, 40), hm(8, 50)]);
    let w = World::new(b);
    let (acc, egr) = ([(a, 120)], [(z, 60)]);
    // Earliest arrival 08:51 after the egress walk: a bound exactly there still admits it.
    let mut q = query(hm(8, 5), &acc, &egr, &w.none);
    q.max_arr = Some(hm(8, 51));
    assert_eq!(w.plan(&q).iter().map(|j| j.arr).collect::<Vec<_>>(), vec![hm(8, 51)]);
    q.max_arr = Some(hm(8, 51) - 1);
    assert!(w.plan(&q).is_empty());
    // In a range only the journeys arriving in time remain.
    let mut q = query(hm(7, 50), &acc, &egr, &w.none);
    q.window = hm(1, 0);
    assert_eq!(w.plan(&q).len(), 2);
    q.max_arr = Some(hm(8, 50));
    let js = w.plan(&q);
    assert_eq!(js.len(), 1);
    assert_eq!((rides(&js[0]), js[0].arr), (vec![(w.t(t0), 0, 2)], hm(8, 21)));
    // Saturating: the largest bound is the same as none.
    q.max_arr = Some(Secs::MAX);
    assert_eq!(w.plan(&q).len(), 2);
    q.max_arr = Some(Secs::MIN);
    assert!(w.plan(&q).is_empty());
}

#[test]
fn latest_arrival_bound_over_rounds() {
    let mut b = Builder::new();
    let (a, x, z) = (b.stop("A"), b.stop("X"), b.stop("Z"));
    let bus = b.line("B", Mode::Bus);
    let rail = b.line("R", Mode::Rail);
    let direct = b.pattern(bus, &[a, z]);
    let p1 = b.pattern(rail, &[a, x]);
    let p2 = b.pattern(rail, &[x, z]);
    b.trips_every(direct, hm(8, 0), 3600, 3, &[0, 3600]); // arrives on the hour
    b.trips_every(p1, hm(8, 5), 3600, 3, &[0, 900]);
    b.trips_every(p2, hm(8, 25), 3600, 3, &[0, 900]); // arrives xx:40
    let w = World::new(b);
    let (acc, egr) = ([(a, 0)], [(z, 0)]);
    let mut q = query(hm(7, 55), &acc, &egr, &w.none);
    let key = |js: Vec<Journey>| js.iter().map(|j| (j.dep, j.arr, j.transfers)).collect::<Vec<_>>();
    // The one-ride option arrives after the bound; the two-ride one exactly at it.
    q.max_arr = Some(hm(8, 40));
    assert_eq!(key(w.plan(&q)), vec![(hm(8, 5), hm(8, 40), 1)]);
    q.max_transfers = 0;
    assert!(w.plan(&q).is_empty());
    q.max_arr = Some(hm(9, 0));
    assert_eq!(key(w.plan(&q)), vec![(hm(8, 0), hm(9, 0), 0)]);
    q.max_transfers = 5;
    assert_eq!(key(w.plan(&q)), vec![(hm(8, 0), hm(9, 0), 0), (hm(8, 5), hm(8, 40), 1)]);
    // Range: the later hour is cut between its two options.
    q.window = hm(2, 0);
    q.max_arr = Some(hm(9, 40));
    assert_eq!(key(w.plan(&q)), vec![(hm(8, 0), hm(9, 0), 0), (hm(8, 5), hm(8, 40), 1), (hm(9, 5), hm(9, 40), 1)]);
}

#[test]
fn latest_arrival_bound_onboard() {
    let mut b = Builder::new();
    let (a, m, x, z, y) = (b.stop("A"), b.stop("M"), b.stop("X"), b.stop("Z"), b.stop("Y"));
    let l = b.line("IC", Mode::Rail);
    let p = b.pattern(l, &[a, m, x, z]);
    let p2 = b.pattern(l, &[x, y]);
    let ic = b.trip(p, &[hm(8, 0), hm(8, 20), hm(8, 40), hm(9, 0)]);
    b.trip(p2, &[hm(8, 50), hm(9, 9)]);
    let w = World::new(b);
    // Round 0 (still seated) and round 1 (after a change).
    for (dest, arr) in [(z, hm(9, 0) + 45), (y, hm(9, 9))] {
        let egr = [(dest, if dest == z { 45 } else { 0 })];
        let mut q = query(hm(8, 12), &[], &egr, &w.none);
        q.onboard = Some(Onboard { trip: w.t(ic), date: QD, next_pos: 1 });
        q.max_arr = Some(arr);
        assert_eq!(w.plan(&q).iter().map(|j| j.arr).collect::<Vec<_>>(), vec![arr]);
        q.max_arr = Some(arr - 1);
        assert!(w.plan(&q).is_empty());
    }
}

#[test]
fn several_access_and_egress_stops() {
    let mut b = Builder::new();
    let (a1, a2, z1, z2) = (b.stop("A1"), b.stop("A2"), b.stop("Z1"), b.stop("Z2"));
    let l = b.line("1", Mode::Bus);
    let p = b.pattern(l, &[a1, a2, z1, z2]);
    let t = b.trips_every(p, hm(8, 0), 1200, 4, &[0, 300, 900, 1200]);
    let w = World::new(b);
    // Reaching A2 takes 2 min longer than A1 but the bus needs 5 min → board at A2, leave later.
    // Z1 + 10 min walk beats Z2 + 1 min.
    let (acc, egr) = ([(a1, 60), (a2, 180), (a2, 500)], [(z1, 600), (z2, 60)]);
    let mut q = query(hm(7, 0), &acc, &egr, &w.none);
    q.window = hm(1, 30);
    let js = w.plan(&q);
    assert_eq!(js.len(), 2);
    assert_eq!(rides(&js[0]), vec![(w.t(t[0]), 1, 3)]);
    assert_eq!((js[0].dep, js[0].arr), (hm(8, 2), hm(8, 21)));
    assert_eq!(js[1].dep, hm(8, 22));
}

#[test]
fn no_detour_to_catch_a_trip_that_passes_the_origin() {
    let mut b = Builder::new();
    let (h, o, z) = (b.stop("H"), b.stop("O"), b.stop("Z"));
    let l = b.line("10", Mode::Bus);
    let l17 = b.line("17", Mode::Bus);
    let p = b.pattern(l, &[h, o, z]);
    let back = b.pattern(l17, &[o, h]);
    // Line 10 comes from H through the origin stop O; line 17 runs O → H.
    b.trips_every(p, hm(8, 3), 600, 3, &[0, 120, 1200]); // at O 08:05, 08:15, 08:25
    b.trip(back, &[hm(8, 17), hm(8, 18)]);
    let w = World::new(b);
    let (acc, egr) = ([(o, 0)], [(z, 0)]);
    let mut q = query(hm(8, 0), &acc, &egr, &w.none);
    q.transfer_margin = 60;
    q.window = hm(0, 20);
    // Riding the 17 back to H to board the 10 that leaves O at 08:25 is not a
    // journey of this window: it is the 08:25 departure with a pointless detour.
    let js = w.plan(&q);
    assert_eq!(js.iter().map(|j| (j.dep, j.transfers)).collect::<Vec<_>>(), vec![(hm(8, 5), 0), (hm(8, 15), 0)]);
    q.window = hm(0, 25);
    assert_eq!(w.plan(&q).len(), 3);
}

// ───────────────────────── departures, vehicles, ids, footpaths ─────────────────────────

#[test]
fn departure_board() {
    let mut b = Builder::new();
    let (a, a2, z) = (b.stop("A"), b.stop("A2"), b.stop("Z"));
    let l = b.line("1", Mode::Bus);
    let p = b.pattern(l, &[a, z]);
    let p2 = b.pattern_flags(l, &[z, a2, a], &[0, FLAG_NO_PICKUP, 0]);
    let p3 = b.pattern(l, &[a2, z]);
    let t = b.trips_every(p, hm(8, 0), 600, 4, &[0, 600]);
    b.trip(p2, &[hm(8, 1), hm(8, 2), hm(8, 3)]); // no pickup at A2, terminates at A
    let other = b.trip(p3, &[hm(8, 15), hm(8, 30)]);
    let prev_only = b.service(&[2]);
    let night = b.trip_on(p, prev_only, &[(hm(31, 55), hm(31, 55)), (hm(32, 30), hm(32, 30))]);
    let w = World::new(b);
    let ev = w.rt.departures(&[a, a2, a], QD, hm(7, 50), 4, None);
    let got: Vec<_> = ev.iter().map(|e| (e.trip, e.stop, e.dep, e.date)).collect();
    assert_eq!(
        got,
        vec![(w.t(night), a, hm(7, 55), QD - 1), (w.t(t[0]), a, hm(8, 0), QD), (w.t(t[1]), a, hm(8, 10), QD), (w.t(other), a2, hm(8, 15), QD)]
    );
    assert!(ev.iter().all(|e| e.pos == 0 && e.live_dep == e.dep && !e.cancelled));
    // Runs on into the next service date.
    let ev = w.rt.departures(&[a], QD, hm(8, 25), 5, None);
    assert_eq!(ev.iter().map(|e| (e.dep, e.date)).collect::<Vec<_>>(), vec![(hm(8, 30), QD), (DAY + hm(8, 0), QD + 1), (DAY + hm(8, 10), QD + 1), (DAY + hm(8, 20), QD + 1), (DAY + hm(8, 30), QD + 1)]);
    assert!(w.rt.departures(&[a], QD, hm(8, 0), 0, None).is_empty());
    assert!(w.rt.departures(&[z], QD, hm(8, 0), 3, None).iter().all(|e| e.stop == z));

    // Live: the 08:00 is 12 min late (after the 08:10), the 08:20 is cancelled.
    let mut live = TestLive::default();
    live.delay(QD, w.t(t[0]), 2, 0, 720);
    live.cancel(QD, w.t(t[2]));
    let ev = w.rt.departures(&[a], QD, hm(8, 5), 4, Some(&live));
    let got: Vec<_> = ev.iter().map(|e| (e.trip, e.dep, e.live_dep, e.cancelled)).collect();
    assert_eq!(
        got,
        vec![
            (w.t(t[1]), hm(8, 10), hm(8, 10), false),
            (w.t(t[0]), hm(8, 0), hm(8, 12), false),
            (w.t(t[2]), hm(8, 20), hm(8, 20), true),
            (w.t(t[3]), hm(8, 30), hm(8, 30), false),
        ]
    );
}

#[test]
fn vehicles_under_way() {
    let mut b = Builder::new();
    let a = b.stop_at("A", 0.0, 0.0);
    let m = b.stop_at("M", 10_000.0, 0.0);
    let z = b.stop_at("Z", 20_000.0, 0.0);
    let l = b.line("1", Mode::Rail);
    let p = b.pattern(l, &[a, m, z]);
    let t0 = b.trip_on(p, 0, &[(hm(8, 0), hm(8, 0)), (hm(8, 10), hm(8, 14)), (hm(8, 30), hm(8, 30))]);
    let t1 = b.trip_on(p, 0, &[(hm(8, 20), hm(8, 20)), (hm(8, 30), hm(8, 34)), (hm(8, 50), hm(8, 50))]);
    let prev_only = b.service(&[2]);
    let night = b.trip_on(p, prev_only, &[(hm(32, 0), hm(32, 0)), (hm(32, 10), hm(32, 14)), (hm(32, 40), hm(32, 40))]);
    let w = World::new(b);
    let all = BBox { min: LatLon::from_xy(-1000.0, -1000.0), max: LatLon::from_xy(21_000.0, 1000.0) };
    let seg = |trip, date, pos, dwell, dep, arr| VehicleSeg { trip, date, pos, dwell, dep, arr };
    let sorted = |mut v: Vec<VehicleSeg>| {
        v.sort_by_key(|s| s.trip);
        v
    };
    // 08:05: t0 between A and M, yesterday's late-night trip too (32:05 = 08:05).
    assert_eq!(
        sorted(w.rt.vehicles(&all, QD, hm(8, 5), None)),
        sorted(vec![seg(w.t(t0), QD, 0, false, hm(8, 0), hm(8, 10)), seg(w.t(night), QD - 1, 0, false, hm(8, 0), hm(8, 10))])
    );
    // 08:12: both dwelling at M.
    let v = w.rt.vehicles(&all, QD, hm(8, 12), None);
    assert!(v.len() == 2 && v.iter().all(|s| s.dwell && s.pos == 1 && s.dep == hm(8, 14)));
    // 08:25: t0 M→Z, t1 A→M.
    assert_eq!(
        sorted(w.rt.vehicles(&all, QD, hm(8, 25), None)).iter().map(|s| (s.trip, s.pos, s.dwell)).collect::<Vec<_>>(),
        sorted(vec![seg(w.t(t0), QD, 1, false, 0, 0), seg(w.t(t1), QD, 0, false, 0, 0), seg(w.t(night), QD - 1, 1, false, 0, 0)]).iter().map(|s| (s.trip, s.pos, s.dwell)).collect::<Vec<_>>()
    );
    // A box in the middle of the second segment that contains no stop: only vehicles on that segment.
    let mid = BBox { min: LatLon::from_xy(14_000.0, -50.0), max: LatLon::from_xy(15_000.0, 50.0) };
    let v = w.rt.vehicles(&mid, QD, hm(8, 25), None);
    assert_eq!(sorted(v).iter().map(|s| s.trip).collect::<Vec<_>>(), sorted(vec![seg(w.t(t0), QD, 0, false, 0, 0), seg(w.t(night), QD, 0, false, 0, 0)]).iter().map(|s| s.trip).collect::<Vec<_>>());
    // A box beside the line: nothing. Dwelling counts only with the stop inside.
    let off = BBox { min: LatLon::from_xy(14_000.0, 500.0), max: LatLon::from_xy(15_000.0, 900.0) };
    assert!(w.rt.vehicles(&off, QD, hm(8, 25), None).is_empty());
    assert!(w.rt.vehicles(&mid, QD, hm(8, 12), None).is_empty());
    // Finished / not started.
    assert!(w.rt.vehicles(&all, QD, hm(7, 0), None).is_empty());
    assert!(w.rt.vehicles(&all, QD, hm(9, 30), None).is_empty());
    // Live: t0 20 min late → at 08:25 it is A→M (dep 08:20); cancelled t1 disappears.
    let mut live = TestLive::default();
    live.delay(QD, w.t(t0), 3, 0, 1200);
    live.cancel(QD, w.t(t1));
    let v = sorted(w.rt.vehicles(&all, QD, hm(8, 25), Some(&live)));
    assert_eq!(v, sorted(vec![seg(w.t(t0), QD, 0, false, hm(8, 20), hm(8, 30)), seg(w.t(night), QD - 1, 1, false, hm(8, 14), hm(8, 40))]));
    // Late past its scheduled end.
    let v = w.rt.vehicles(&all, QD, hm(8, 45), Some(&live));
    assert_eq!(v, vec![seg(w.t(t0), QD, 1, false, hm(8, 34), hm(8, 50))]);
}

#[test]
fn id_lookup() {
    let mut b = Builder::new();
    let (a, z) = (b.stop("A"), b.stop("Z"));
    let l = b.line("1", Mode::Bus);
    let p = b.pattern(l, &[a, z]);
    let ids = b.trips_every(p, hm(8, 0), 600, 7, &[0, 600]);
    let w = World::new(b);
    for (i, &id) in ids.iter().enumerate() {
        assert_eq!(w.rt.find_trip(&format!("trip{i}")), Some(w.t(id)));
    }
    assert_eq!(w.rt.find_trip("trip7"), None);
    assert_eq!(w.rt.find_trip(""), None);
    // The builder gives trips 2k and 2k+1 the same journey id.
    let mut got = w.rt.find_sjyid("ch:1:sjyid:1").to_vec();
    got.sort();
    assert_eq!(got, vec![w.t(ids[2]), w.t(ids[3])]);
    assert_eq!(w.rt.find_sjyid("ch:1:sjyid:3"), &[w.t(ids[6])]);
    assert!(w.rt.find_sjyid("ch:1:sjyid:9").is_empty());
    assert!(w.rt.find_sjyid("").is_empty());
}

#[test]
fn crowfly() {
    let mut b = Builder::new();
    let s: Vec<_> = [(0.0, 0.0), (100.0, 0.0), (0.0, 290.0), (310.0, 0.0), (5000.0, 5000.0), (-299.0, 0.0)].iter().enumerate().map(|(i, &(x, y))| b.stop_at(&format!("S{i}"), x, y)).collect();
    let tt = b.build().tt;
    let fp = crowfly_footpaths(&tt, 300.0, 1.5);
    assert_eq!(fp.off.len(), tt.stops.len() + 1);
    let to = |i: usize| fp.from(s[i]).map(|(t, _, _)| t).collect::<Vec<_>>();
    assert_eq!(to(0), vec![s[1], s[2], s[5]]);
    assert_eq!(to(1), vec![s[0], s[3]]);
    assert!(to(4).is_empty());
    let (v, f) = fp.get(s[0], s[1]).unwrap();
    assert!((v as i32 - 150).abs() <= 2 && f == 0, "{v}");
    assert_eq!(fp.get(s[1], s[0]), Some((v, f)));
    // Brute force comparison on a random cloud.
    let mut b = Builder::new();
    let mut rng = Rng(7);
    for i in 0..400 {
        b.stop_at(&format!("R{i}"), rng.below(4000) as f32, rng.below(4000) as f32);
    }
    let tt = b.build().tt;
    let fp = crowfly_footpaths(&tt, 250.0, 1.0);
    for i in 0..400u32 {
        let expect: Vec<u32> = (0..400u32).filter(|&j| j != i && tt.stops[i as usize].pos.dist_m(&tt.stops[j as usize].pos) < 250.0).collect();
        assert_eq!(fp.from(i).map(|(t, _, _)| t).collect::<Vec<_>>(), expect);
    }
}

// ───────────────────────── randomised comparison with a brute-force search ─────────────────────────

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn range(&mut self, lo: i32, hi: i32) -> i32 {
        lo + self.below((hi - lo + 1) as u64) as i32
    }
}

fn random_world(seed: u64) -> (World, Footpaths) {
    random_world_conts(seed, false)
}

/// [`random_world`], with some in-seat continuations if `conts`.
fn random_world_conts(seed: u64, conts: bool) -> (World, Footpaths) {
    let mut rng = Rng(seed * 2654435761 + 1);
    // (declaration id, first departure, last arrival, line) of every trip.
    let mut runs: Vec<(usize, Secs, Secs, LineIdx)> = Vec::new();
    let mut b = Builder::new();
    let n_stops = rng.range(8, 14) as usize;
    let stops: Vec<_> = (0..n_stops).map(|i| b.stop_at(&format!("S{i}"), rng.below(3000) as f32, rng.below(3000) as f32)).collect();
    let lines = [b.line("bus", Mode::Bus), b.line("rail", Mode::Rail), b.line("tram", Mode::Tram)];
    let alt = [b.service(&[0, 1, 2, 4, 5, 6, 7]), b.service(&[3, 4, 5]), b.service(&[2, 3])];
    for _ in 0..rng.range(6, 14) {
        let len = rng.range(2, 6) as usize;
        let mut seq = Vec::new();
        while seq.len() < len {
            let s = stops[rng.below(n_stops as u64) as usize];
            if !seq.contains(&s) {
                seq.push(s);
            }
        }
        let flags: Vec<u8> = (0..len)
            .map(|_| match rng.below(12) {
                0 => FLAG_NO_PICKUP,
                1 => FLAG_NO_DROPOFF,
                _ => 0,
            })
            .collect();
        let line = lines[rng.below(3) as usize];
        let p = b.pattern_flags(line, &seq, &flags);
        // Same running and dwell times for all trips of a pattern → no overtaking.
        let mut offs = vec![(0, 0)];
        for i in 1..len {
            let arr = offs[i - 1].1 + rng.range(2, 12) * 60;
            offs.push((arr, arr + rng.range(0, 2) * 30));
        }
        let mut t = rng.range(4 * 60, 9 * 60) * 60;
        let headway = rng.range(4, 50) * 60;
        // Some patterns run round the clock (trips of two service dates interleave).
        let until = if rng.below(4) == 0 { rng.range(28, 34) } else { rng.range(20, 27) } * 3600;
        while t < until {
            let service = if rng.below(4) == 0 { alt[rng.below(3) as usize] } else { 0 };
            let times: Vec<_> = offs.iter().map(|&(a, d)| (t + a, t + d)).collect();
            let id = b.trip_on(p, service, &times);
            runs.push((id, times[0].1, times[len - 1].0, line));
            t += headway;
        }
    }
    if conts {
        for _ in 0..rng.range(4, 12) {
            let a = runs[rng.below(runs.len() as u64) as usize];
            let next: Vec<_> = runs.iter().filter(|r| r.0 != a.0 && r.3 == a.3 && (0..=3 * 3600).contains(&(r.1 - a.2))).collect();
            if !next.is_empty() {
                b.continuation(a.0, next[rng.below(next.len() as u64) as usize].0, NONE);
            }
        }
    }
    let built = b.build();
    let fp = crowfly_footpaths(&built.tt, 500.0, 1.3);
    let none = footpaths(built.tt.stops.len(), &[]);
    (World { rt: Router::new(Arc::new(built.tt)), trips: built.trips, none }, fp)
}

const INF: Secs = Secs::MAX;

/// Brute-force round-based search with the engine's documented semantics for
/// one origin departure `tau`: Pareto front as (rides, arrival).
/// `seed_until`: latest origin departure whose first ride may be used.
fn oracle(tt: &Timetable, q: &Query, tau: Secs, seed_until: Secs) -> Vec<(usize, Secs)> {
    let n = tt.stops.len();
    let k_max = (q.max_transfers as usize + 1).min(MAX_RIDES);
    let mut acc = vec![INF; n];
    for &(s, a) in q.access {
        acc[s as usize] = acc[s as usize].min(a);
    }
    let mut ready = vec![vec![INF; n]; k_max + 1];
    let mut ride = vec![vec![INF; n]; k_max + 1];
    for s in 0..n {
        if acc[s] != INF {
            ready[0][s] = tau + acc[s];
        }
    }
    let mut front = Vec::new();
    let mut best = INF;
    for k in 1..=k_max {
        for d in -1..=1 {
            let date = q.date + d;
            for t in 0..tt.trips.len() as TripIdx {
                if !tt.trip_active(t, date) || q.modes & tt.trip_line(t).mode.bit() == 0 {
                    continue;
                }
                let p = tt.trips[t as usize].pattern;
                let (stops, flags) = (tt.pattern_stops(p), tt.pattern_flags(p));
                for i in 0..stops.len() - 1 {
                    let s = stops[i] as usize;
                    let (_, dep, skip) = live_times(tt, q, t, date, i);
                    if flags[i] & FLAG_NO_PICKUP != 0 || skip {
                        continue;
                    }
                    let ok = if k == 1 {
                        acc[s] != INF && dep >= tau + acc[s] && dep <= seed_until.saturating_add(acc[s])
                    } else {
                        // Dominated labels (not better than every lower round) are not
                        // expanded; from an access stop only trips leaving before
                        // one could have walked there are boarded in later rounds.
                        let r = ready[k - 1][s];
                        r != INF && (0..k - 1).all(|j| ready[j][s] > r) && dep >= r && dep < ready[0][s]
                    };
                    if !ok {
                        continue;
                    }
                    for j in i + 1..stops.len() {
                        let (arr, dep, skip) = live_times(tt, q, t, date, j);
                        if flags[j] & FLAG_NO_DROPOFF == 0 && !skip {
                            let r = &mut ride[k][stops[j] as usize];
                            *r = (*r).min(arr);
                        }
                        // Passing an access stop where one could have walked to
                        // and boarded this trip: the rest is the shorter journey's.
                        if k >= 2 && j + 1 < stops.len() && flags[j] & FLAG_NO_PICKUP == 0 && !skip && dep >= ready[0][stops[j] as usize] {
                            break;
                        }
                    }
                }
            }
        }
        for s in 0..n {
            let a = ride[k][s];
            if a == INF {
                continue;
            }
            ready[k][s] = ready[k][s].min(a + q.transfer_margin);
            for (to, v, f) in q.footpaths.from(s as StopIdx) {
                let w = walk_secs(v as f32, f as f32, q.walk_speed).ceil() as Secs;
                if w <= q.max_walk && to as usize != s {
                    let r = &mut ready[k][to as usize];
                    *r = (*r).min(a + w + q.transfer_margin);
                }
            }
        }
        let arr = q.egress.iter().filter(|e| ride[k][e.0 as usize] != INF).map(|e| ride[k][e.0 as usize] + e.1).min().unwrap_or(INF);
        if arr < best {
            best = arr;
            front.push((k, arr));
        }
    }
    front
}

/// Expected result of a range query: Pareto set of (dep, rides, arr) over all seeds.
fn oracle_range(tt: &Timetable, q: &Query) -> Vec<(Secs, usize, Secs)> {
    let mut taus = Vec::new();
    for &(s, a) in q.access {
        for &(p, pos) in tt.stop_patterns(s) {
            let pat = &tt.patterns[p as usize];
            for t in pat.trips_off..pat.trips_off + pat.n_trips {
                for d in -1..=1 {
                    if tt.trip_active(t, q.date + d) {
                        let (_, dep, _) = live_times(tt, q, t, q.date + d, pos as usize);
                        if dep - a >= q.from && dep - a <= q.from + q.window {
                            taus.push(dep - a);
                        }
                    }
                }
            }
        }
    }
    taus.sort();
    taus.dedup();
    let mut all = Vec::new();
    for &tau in &taus {
        for (k, arr) in oracle(tt, q, tau, q.from + q.window) {
            all.push((tau, k, arr));
        }
    }
    let dominated = |a: &(Secs, usize, Secs)| all.iter().any(|b| b != a && b.0 >= a.0 && b.1 <= a.1 && b.2 <= a.2);
    let mut out: Vec<_> = all.iter().filter(|a| !dominated(a)).copied().collect();
    out.sort();
    out.dedup();
    out
}

#[derive(Clone)]
struct Case {
    acc: Vec<(StopIdx, Secs)>,
    egr: Vec<(StopIdx, Secs)>,
    date: Date,
    from: Secs,
    window: Secs,
    max_transfers: u8,
    margin: Secs,
    speed: f32,
    max_walk: Secs,
    modes: u16,
}

impl Case {
    fn q<'a>(&'a self, fp: &'a Footpaths) -> Query<'a> {
        let mut q = Query::new(self.date, self.from, &self.acc, &self.egr, fp);
        q.window = self.window;
        q.max_transfers = self.max_transfers;
        q.transfer_margin = self.margin;
        q.walk_speed = self.speed;
        q.max_walk = self.max_walk;
        q.modes = self.modes;
        q
    }
}

fn random_case(rng: &mut Rng, n_stops: usize) -> Case {
    let (mut acc, mut egr) = (Vec::new(), Vec::new());
    for _ in 0..rng.range(1, 3) {
        acc.push((rng.below(n_stops as u64) as StopIdx, rng.range(0, 8) * 45));
    }
    let n_egr = rng.range(1, 3) as usize;
    while egr.len() < n_egr {
        let s = rng.below(n_stops as u64) as StopIdx;
        if acc.iter().all(|a| a.0 != s) {
            egr.push((s, rng.range(0, 8) * 45));
        }
    }
    let from = match rng.below(4) {
        0 => rng.range(0, 3 * 3600),          // after midnight: yesterday's late trips
        1 => rng.range(22 * 3600, 25 * 3600), // late: runs into tomorrow
        _ => rng.range(5 * 3600, 21 * 3600),
    };
    Case {
        acc,
        egr,
        // Mostly mid-calendar; sometimes at or just beyond its edges, where a
        // neighbouring service date has no trips at all.
        date: if rng.below(5) == 0 { D0 + [-1, 0, N_DAYS as i32 - 1, N_DAYS as i32][rng.below(4) as usize] } else { D0 + rng.range(2, 6) },
        from,
        window: 0,
        max_transfers: rng.range(0, 4) as u8,
        margin: rng.range(0, 4) * 60,
        speed: [0.8, 1.3, 1.8][rng.below(3) as usize],
        max_walk: [200, 600, 900][rng.below(3) as usize],
        modes: if rng.below(5) == 0 { Mode::Bus.bit() | Mode::Rail.bit() } else { ALL_MODES },
    }
}

#[test]
fn random_earliest_arrival_matches_brute_force() {
    let mut found = 0;
    for seed in 1..=60 {
        let (w, fp) = random_world(seed);
        let mut rng = Rng(seed * 977 + 5);
        for _ in 0..25 {
            let case = random_case(&mut rng, w.tt().stops.len());
            let q = case.q(&fp);
            let js = w.plan(&q);
            let mut got: Vec<_> = js.iter().map(|j| (j.transfers as usize + 1, j.arr)).collect();
            got.sort();
            let want = oracle(w.tt(), &q, q.from, INF - 100_000);
            assert_eq!(got, want, "seed {seed} from {} date {}", q.from, q.date);
            found += js.len();
        }
    }
    assert!(found > 1000, "too few journeys to mean anything: {found}");
}

#[test]
fn random_range_matches_brute_force() {
    let mut found = 0;
    for seed in 1..=40 {
        let (w, fp) = random_world(seed + 100);
        let mut rng = Rng(seed * 31 + 3);
        for _ in 0..12 {
            let mut case = random_case(&mut rng, w.tt().stops.len());
            case.window = rng.range(1, 16) * 900;
            let q = case.q(&fp);
            let js = w.plan(&q);
            let got: Vec<_> = {
                let mut v: Vec<_> = js.iter().map(|j| (j.dep, j.transfers as usize + 1, j.arr)).collect();
                v.sort();
                v
            };
            let want = oracle_range(w.tt(), &q);
            assert_eq!(got, want, "seed {seed} from {} window {} date {}", q.from, q.window, q.date);
            found += js.len();
        }
    }
    assert!(found > 2000, "too few journeys to mean anything: {found}");
}

/// With random delays, cancellations and skipped stops every journey must
/// still be feasible, and (delays can make trips overtake, which the pattern
/// scan handles heuristically) never better than the exhaustive search.
#[test]
fn random_live_journeys_are_feasible() {
    let mut exact = 0;
    let mut total = 0;
    for seed in 1..=40 {
        let (w, fp) = random_world(seed + 500);
        let tt = w.tt();
        let mut rng = Rng(seed * 131 + 9);
        let mut live = TestLive::default();
        for t in 0..tt.trips.len() as TripIdx {
            let n = tt.pattern_stops(tt.trips[t as usize].pattern).len();
            for date in D0 + 1..D0 + 8 {
                match rng.below(10) {
                    0 => {
                        live.delay(date, t, n, rng.below(n as u64) as usize, rng.range(1, 30) * 60);
                    }
                    1 => {
                        live.delay(date, t, n, 0, rng.range(-2, 5) * 30);
                    }
                    2 => {
                        live.cancel(date, t);
                    }
                    3 => {
                        live.skip(date, t, n, rng.below(n as u64) as usize);
                    }
                    _ => {}
                }
            }
        }
        for _ in 0..15 {
            let case = random_case(&mut rng, tt.stops.len());
            let mut q = case.q(&fp);
            q.live = Some(&live);
            let js = w.plan(&q);
            let want = oracle(tt, &q, q.from, INF - 100_000);
            let mut got: Vec<_> = js.iter().map(|j| (j.transfers as usize + 1, j.arr)).collect();
            got.sort();
            for &(k, arr) in &got {
                let best = want.iter().filter(|o| o.0 <= k).map(|o| o.1).min();
                assert!(best.is_some_and(|b| b <= arr), "seed {seed}: journey better than exhaustive search");
            }
            total += 1;
            exact += (got == want) as usize;
            // Range queries: validity only (checked inside `plan`).
            q.window = 3600;
            w.plan(&q);
        }
    }
    // Overtaking makes the scan heuristic; it should still be optimal almost always.
    println!("live: {exact} of {total} queries match the exhaustive search");
    assert!(exact * 100 >= total * 90, "only {exact} of {total} live queries optimal");
}

#[test]
fn scratch_is_clean_between_queries_and_threads() {
    let (w, fp) = random_world(4242);
    let n = w.tt().stops.len();
    let mut rng = Rng(99);
    let mut cases = Vec::new();
    for _ in 0..40 {
        let mut c = random_case(&mut rng, n);
        c.window = if rng.below(2) == 0 { 0 } else { 5400 };
        cases.push(c);
    }
    let run = |c: &Case| w.rt.plan(&c.q(&fp));
    // Reference: each query on a fresh thread (fresh scratch).
    let reference: Vec<_> = cases.iter().map(|c| std::thread::scope(|s| s.spawn(|| run(c)).join().unwrap())).collect();
    // Same thread, interleaved order.
    for i in (0..cases.len()).rev().chain(0..cases.len()) {
        assert_eq!(run(&cases[i]), reference[i]);
    }
    // Many threads at once.
    std::thread::scope(|s| {
        for t in 0..8 {
            let (cases, reference, run) = (&cases, &reference, &run);
            s.spawn(move || {
                for r in 0..5 {
                    for i in 0..cases.len() {
                        let i = (i * 7 + t + r) % cases.len();
                        assert_eq!(run(&cases[i]), reference[i]);
                    }
                }
            });
        }
    });
    // A router for another timetable on the same thread re-sizes the scratch.
    let (w2, fp2) = random_world(4243);
    let (acc, egr) = ([(0, 0)], [(3, 0)]);
    w2.plan(&Query::new(QD, hm(8, 0), &acc, &egr, &fp2));
    assert_eq!(run(&cases[0]), reference[0]);
}

/// The bound is on the arrival at the destination, with each egress stop's own walk.
#[test]
fn latest_arrival_bound_two_egress_stops() {
    let mut b = Builder::new();
    let (a, m, z) = (b.stop("A"), b.stop("M"), b.stop("Z"));
    let l = b.line("1", Mode::Bus);
    let p = b.pattern(l, &[a, m, z]);
    b.trip(p, &[hm(8, 0), hm(8, 10), hm(8, 20)]);
    let w = World::new(b);
    // From M it is a 15 min walk (there at 08:25), from Z one minute (08:21).
    let (acc, egr) = ([(a, 0)], [(m, 900), (z, 60)]);
    let mut q = query(hm(7, 55), &acc, &egr, &w.none);
    let arrs = |q: &Query| w.plan(q).iter().map(|j| j.arr).collect::<Vec<_>>();
    assert_eq!(arrs(&q), vec![hm(8, 21)]);
    q.max_arr = Some(hm(8, 21));
    assert_eq!(arrs(&q), vec![hm(8, 21)]);
    // M is reached well before the bound, but the walk from it ends after it.
    q.max_arr = Some(hm(8, 21) - 1);
    assert!(arrs(&q).is_empty());
}

/// A latest-arrival bound only removes journeys: the answer has the
/// departures, arrivals and changes of the unbounded one without the journeys
/// that arrive late. (Which of two options that tie on all three is named
/// can differ: labels the bound suppresses change the order patterns are
/// scanned in. An earliest-arrival search fixes no departure, so there the
/// tie is on arrival and changes only.)
#[test]
fn random_bound_equals_filtered_plan() {
    let mut cut = 0;
    for seed in 1..=40 {
        let (w, fp) = random_world(seed + 900);
        let tt = w.tt();
        let mut rng = Rng(seed * 53 + 7);
        let mut live = TestLive::default();
        if seed % 2 == 0 {
            for t in 0..tt.trips.len() as TripIdx {
                let n = tt.pattern_stops(tt.trips[t as usize].pattern).len();
                for date in D0 + 1..D0 + 8 {
                    match rng.below(12) {
                        0 => {
                            live.delay(date, t, n, rng.below(n as u64) as usize, rng.range(1, 30) * 60);
                        }
                        1 => {
                            live.cancel(date, t);
                        }
                        _ => {}
                    }
                }
            }
        }
        for _ in 0..15 {
            let mut case = random_case(&mut rng, tt.stops.len());
            case.window = [0, 1800, 3 * 3600, 6 * 3600][rng.below(4) as usize];
            let mut q = case.q(&fp);
            if seed % 2 == 0 {
                q.live = Some(&live);
            }
            let all = w.plan(&q);
            let mut bounds: Vec<Secs> = all.iter().flat_map(|j| [j.arr, j.arr - 1]).collect();
            bounds.push(q.from + rng.range(0, 4 * 3600));
            for _ in 0..3 {
                let m = bounds[rng.below(bounds.len() as u64) as usize];
                let want: Vec<_> = all.iter().filter(|j| j.arr <= m).cloned().collect();
                q.max_arr = Some(m);
                let fixed_dep = q.window > 0;
                let key = |js: &[Journey]| js.iter().map(|j| (if fixed_dep { j.dep } else { 0 }, j.arr, j.transfers)).collect::<Vec<_>>();
                assert_eq!(key(&w.plan(&q)), key(&want), "seed {seed} from {} window {} bound {m}", q.from, q.window);
                cut += (want.len() < all.len()) as usize;
            }
            q.max_arr = None;
        }
    }
    assert!(cut > 300, "too few bounds that cut anything: {cut}");
}

// ───────────────────────── per-pattern delay bounds = global look-back ─────────────────────────

/// Random live data on `dates`: delays that differ by position, early
/// running, cancellations, skipped stops, and a few trips ~3 h late.
fn random_live(rng: &mut Rng, tt: &Timetable, dates: &[Date]) -> TestLive {
    let mut live = TestLive::default();
    for t in 0..tt.trips.len() as TripIdx {
        let n = tt.pattern_stops(tt.trips[t as usize].pattern).len();
        for &date in dates {
            match rng.below(14) {
                0 => {
                    live.delay(date, t, n, rng.below(n as u64) as usize, rng.range(1, 14) * 60);
                }
                1 => {
                    // Early, within what the router assumes.
                    live.delay(date, t, n, 0, -rng.range(1, (EARLY_SLACK / 30) as i32) * 30);
                }
                2 => {
                    live.cancel(date, t);
                }
                3 => {
                    live.skip(date, t, n, rng.below(n as u64) as usize);
                }
                4 | 5 => {
                    // Different at every position, sometimes catching up.
                    let l = live.map.entry((date, t)).or_default();
                    // Runs take at least 2 min: catching up by 2 min a stop keeps times in order.
                    let mut d = rng.range(-EARLY_SLACK / 60, 10) * 60;
                    for _ in 0..n {
                        l.arr_delay.push(d);
                        l.dep_delay.push(d + rng.range(0, 1) * 60);
                        d = (d + rng.range(-2, 4) * 60).max(-EARLY_SLACK);
                    }
                    l.observed_pos = -1;
                    if rng.below(3) == 0 {
                        l.skipped = (0..n).map(|_| rng.below(4) == 0).collect();
                    }
                }
                _ => {}
            }
        }
    }
    // The outliers that dictate `max_delay`, as on the real feed (2 h 55 min).
    for _ in 0..rng.range(1, 3) {
        let t = rng.below(tt.trips.len() as u64) as TripIdx;
        let n = tt.pattern_stops(tt.trips[t as usize].pattern).len();
        let date = dates[rng.below(dates.len() as u64) as usize];
        live.delay(date, t, n, rng.below(n as u64) as usize, 10_478 - rng.range(0, 60) * 60);
    }
    live.index(tt);
    live
}

/// The router with per-date, per-pattern and per-stop delay bounds returns
/// exactly what it returns when it looks back by the global `max_delay`
/// everywhere (`GlobalOnly`, the `LiveView` defaults).
#[test]
fn live_bounds_match_global_lookback() {
    const SEEDS: u64 = 200;
    let (mut queries, mut journeys, mut live_rides, mut identical) = (0, 0, 0, 0);
    for seed in 1..=SEEDS {
        let (w, fp) = random_world_conts(seed + 900, true);
        let tt = w.tt();
        let mut rng = Rng(seed * 7919 + 1);
        // Live data on a few dates only: queries see dates with and without it.
        let first = D0 + rng.range(1, 5);
        let dates: Vec<Date> = (first..first + rng.range(1, 3)).collect();
        let live = random_live(&mut rng, tt, &dates);
        let global = GlobalOnly(&live);
        assert!(live.max_delay() > 6000);
        for _ in 0..30 {
            let mut case = random_case(&mut rng, tt.stops.len());
            case.window = [0, 0, 1800, 7200][rng.below(4) as usize];
            let mut q = case.q(&fp);
            if rng.below(6) == 0 {
                let t = rng.below(tt.trips.len() as u64) as TripIdx;
                let n = tt.pattern_stops(tt.trips[t as usize].pattern).len();
                let date = q.date + rng.range(-1, 1);
                if tt.trip_active(t, date) {
                    q.onboard = Some(Onboard { trip: t, date, next_pos: rng.below(n as u64) as u16 });
                }
            }
            q.live = Some(&live);
            let got = w.rt.plan(&q);
            q.live = Some(&global);
            let want = w.rt.plan(&q);
            // An earliest-arrival search (window 0) rides the first trip of
            // every line in one pass: of two options that tie on arrival and
            // changes it keeps whichever is found first, so its departure
            // depends on the scan order like the legs do. A range search has
            // one departure per pass, the later one first.
            let fixed_dep = q.window > 0 || q.onboard.is_some();
            let key = |js: &[Journey]| js.iter().map(|j| (if fixed_dep { j.dep } else { 0 }, j.arr, j.transfers)).collect::<Vec<_>>();
            assert_eq!(key(&got), key(&want), "seed {seed} date {} from {} window {} onboard {:?}", q.date, q.from, q.window, q.onboard.map(|o| (o.trip, o.date)));
            // Leg for leg too, except where two vehicles reach a stop at the
            // same time: which one a label keeps depends on the order patterns
            // are scanned in, which depends on the stop windows.
            identical += (got == want) as usize;
            queries += 1;
            journeys += got.len();
            for j in &got {
                live_rides += j.legs.iter().filter(|l| matches!(l, Leg::Ride { trip, date, .. } if live.map.contains_key(&(*date, *trip)))).count();
            }
            // Departure boards: same events in the same order.
            let stops: Vec<StopIdx> = (0..rng.range(1, 3)).map(|_| rng.below(tt.stops.len() as u64) as StopIdx).collect();
            let limit = rng.range(1, 12) as usize;
            assert_eq!(w.rt.departures(&stops, q.date, q.from, limit, Some(&live)), w.rt.departures(&stops, q.date, q.from, limit, Some(&global)), "seed {seed}: departures");
        }
    }
    println!("{queries} queries, {journeys} journeys, {live_rides} rides on trips with live data; {identical} queries identical leg for leg");
    assert!(journeys > 1500 && live_rides > 300, "too little to mean anything: {journeys} journeys, {live_rides} live rides");
}

/// A stop that a pattern calls at twice gets the larger of the two delays,
/// and only the dates with most live trips get per-pattern and per-stop bounds.
#[test]
fn delay_index_repeated_stops_and_many_dates() {
    let mut b = Builder::new();
    let (a, x, c, d) = (b.stop("A"), b.stop("X"), b.stop("C"), b.stop("D"));
    let line = b.line("loop", Mode::Bus);
    let lp = b.pattern(line, &[a, x, c, x, d]);
    let ts = b.trips_every(lp, hm(8, 0), 3600, 3, &[0, 300, 600, 900, 1200]);
    let back = b.pattern(line, &[d, a]);
    let bs = b.trips_every(back, hm(8, 0), 3600, 3, &[0, 300]);
    let w = World::new(b);
    let tt = w.tt();
    let pat = |id: usize| tt.trips[w.t(id) as usize].pattern;
    let mut live = TestLive::default();
    // Late only from the second call at X on; another trip a minute late throughout.
    live.delay(QD, w.t(ts[0]), 5, 3, 700);
    live.delay(QD, w.t(ts[1]), 5, 0, 60);
    // One live trip on each of ten more dates: more dates than are indexed in full.
    let sparse: Vec<Date> = (1..=10).map(|i| QD + i).collect();
    for &date in &sparse {
        live.delay(date, w.t(ts[2]), 5, 0, 30);
    }
    live.index(tt);
    let bd = live.delay_bounds(QD);
    assert_eq!((bd.stop(a), bd.stop(x), bd.stop(c), bd.stop(d)), (Some(60), Some(700), Some(60), Some(700)));
    assert_eq!((bd.pattern(pat(ts[0])), bd.pattern(pat(bs[0]))), (Some(700), None));
    let full = sparse.iter().filter(|&&date| !live.delay_bounds(date).pattern.is_empty()).count();
    assert_eq!(full, kante_core::DelayIndex::MAX_DATES - 1);
    for &date in &sparse {
        let bd = live.delay_bounds(date);
        // Without the per-pattern bounds every pattern looks back by the date's maximum.
        let want = if bd.pattern.is_empty() { Some(30) } else { None };
        assert_eq!((bd.max, bd.pattern(pat(ts[0])), bd.pattern(pat(bs[0]))), (30, Some(30), want), "date {date}");
    }
}

/// A train almost 3 h late is still caught, and lines without live data
/// around it are planned as without live data.
#[test]
fn very_late_train_is_still_caught() {
    let mut b = Builder::new();
    let (a, x, c) = (b.stop("A"), b.stop("X"), b.stop("C"));
    let rail = b.line("IC", Mode::Rail);
    let bus = b.line("bus", Mode::Bus);
    let ic = b.pattern(rail, &[a, x]);
    let ics = b.trips_every(ic, hm(6, 0), 3600, 16, &[0, 1800]);
    let feeder = b.pattern(bus, &[x, c]);
    b.trips_every(feeder, hm(6, 10), 1200, 50, &[0, 600]);
    let w = World::new(b);
    let mut live = TestLive::default();
    // The 06:00 runs 2 h 54 min late: it leaves A at 08:54, after the 08:00, before the 09:00.
    live.delay(QD, w.t(ics[0]), 2, 0, 10_478);
    live.index(w.tt());
    let (acc, egr) = ([(a, 0)], [(c, 0)]);
    let mut q = query(hm(8, 30), &acc, &egr, &w.none);
    q.live = Some(&live);
    let js = w.plan(&q);
    assert_eq!(rides(&js[0])[0], (w.t(ics[0]), 0, 1));
    assert_eq!(js[0].legs.iter().find_map(|l| if let Leg::Ride { dep, .. } = l { Some(*dep) } else { None }), Some(hm(6, 0) + 10_478));
    let global = GlobalOnly(&live);
    q.live = Some(&global);
    assert_eq!(w.plan(&q), js);
    // Next week nothing is live: the same as without live data.
    let mut q = Query::new(QD + 7, hm(8, 30), &acc, &egr, &w.none);
    let plain = w.plan(&q);
    q.live = Some(&live);
    assert_eq!(w.plan(&q), plain);
    assert_eq!(rides(&plain[0])[0], (w.t(ics[3]), 0, 1));
}
