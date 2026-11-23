//! Journey search: range RAPTOR with per-round labels.
//!
//! # Labels
//!
//! Per stop and round `k` (= number of rides used) there are two times:
//! `ride` — earliest arrival at the stop *in a vehicle* after exactly `k`
//! rides, and `ready` — earliest time a traveller can board the next vehicle
//! there (`ride` + change time, or the access time in round 0). Egress is taken
//! from `ride`, boarding from `ready`.
//!
//! Labels of one stop for all rounds share a cache line. A candidate is
//! accepted only if it beats the stop's label in the same *and every lower*
//! round; that makes labels of earlier range iterations (later departures)
//! prune later iterations correctly without copying labels between rounds.
//! The minimum over those rounds is cached per stop for the running phase
//! (`Star`), so the common case — the candidate loses — reads 8 bytes.
//!
//! # Iterations
//!
//! Round 1 is seeded explicitly: every departure from an access stop inside
//! the window is a *seed*. Seeds are processed latest first, one iteration per
//! distinct origin departure time; an iteration rides its seed trips (round 1)
//! and then runs ordinary rounds from the stops that improved. From round 2 on
//! a pattern is boarded only at stops whose `ready` label improved in the
//! previous round, and only on trips leaving before the label's previous value
//! (`bound`): later trips were already ridden from there by an earlier
//! iteration or a lower round. When that interval is short, the patterns to
//! scan are read off the stop's departure list instead of scanning every
//! pattern through the stop.
//!
//! Journeys are read off the parent pointers at the end of every iteration.
//! A parent chain stays valid when labels improve later: every label only
//! ever gets earlier, so whatever boarded from it still can.
//!
//! # Trip lookup
//!
//! "First trip of a pattern leaving position `i` at or after `t`" is a binary
//! search in the day's column of scheduled departures (`DayData`), per
//! service date (`date - 1`, `date`, `date + 1`, shifted by ±24 h). With live
//! data the search starts `max_delay` earlier and compares live times.

use crate::days::{Boardable, DaySet, PatDays, ENT_BITS};
use crate::{Journey, Leg, Onboard, Query, Router, EARLY_SLACK, MAX_RIDES};
use kante_core::time::{Date, Secs, DAY};
use kante_core::{walk_secs, Footpaths, LiveView, PatternIdx, StopIdx, Timetable, TripIdx, TripLive, FLAG_NO_DROPOFF, FLAG_NO_PICKUP, NONE};
use rustc_hash::FxHashMap;
use std::cell::RefCell;

/// Developer counters and phase timers (feature `stats`), per thread.
#[cfg(feature = "stats")]
pub mod stats {
    use std::cell::Cell;
    pub const NAMES: [&str; 24] = [
        "iterations", "seeds", "queue_pairs", "pattern_scans", "scan_steps", "lookups", "boardings", "ride_steps", "arrivals", "fp_relax", "ready_set", "marked",
        "us_seeds", "us_seed_rides", "us_queue", "us_scan", "us_transfers", "us_collect", "us_reset", "lb_pruned", "lb_settled", "us_bounds", "lb_classify", "lb_l_settled",
    ];
    thread_local! {
        pub static C: [Cell<u64>; 24] = const { [const { Cell::new(0) }; 24] };
    }
    #[inline]
    pub fn add(i: usize, n: u64) {
        C.with(|c| c[i].set(c[i].get() + n));
    }
    /// Counters since the last call; timers in microseconds.
    pub fn take() -> Vec<(&'static str, u64)> {
        C.with(|c| NAMES.iter().zip(c).map(|(n, c)| (*n, if n.starts_with("us_") { c.replace(0) / 1000 } else { c.replace(0) })).collect())
    }
}
macro_rules! count {
    ($i:expr) => {
        count!($i, 1)
    };
    ($i:expr, $n:expr) => {
        #[cfg(feature = "stats")]
        stats::add($i, $n as u64);
    };
}
/// Run a block, adding its wall time to timer `$i` when `stats` is on.
macro_rules! timed {
    ($i:expr, $e:expr) => {{
        #[cfg(feature = "stats")]
        let t0 = std::time::Instant::now();
        let r = $e;
        #[cfg(feature = "stats")]
        stats::add($i, t0.elapsed().as_nanos() as u64);
        r
    }};
}

const INF: Secs = Secs::MAX;
/// Label slots per stop: rounds `0 ..= MAX_RIDES`.
const R: usize = MAX_RIDES + 1;
/// A continuation must leave its first stop within this time after the
/// previous trip reached it (scheduled times).
pub(crate) const MAX_CONT_GAP: Secs = 3 * 3600;

const F_TOUCHED: u8 = 1;
const F_IMPROVED: u8 = 2;
const F_MARKED: u8 = 4;
const F_EGRESS: u8 = 8;
const F_ACCESS: u8 = 16;

#[derive(Clone, Copy)]
#[repr(C)]
struct Label {
    ride: Secs,
    ready: Secs,
}

const NO_LABEL: Label = Label { ride: INF, ready: INF };

#[derive(Clone, Copy, Default)]
struct Star {
    v: Secs,
    /// Valid when equal to the engine's stamp of the running phase.
    stamp: u32,
}

/// How a vehicle was boarded; ride labels point here.
#[derive(Clone, Copy)]
struct Board {
    trip: TripIdx,
    /// Record of the trip this one continues in-seat, or `NONE`.
    prev: u32,
    pos: u16,
    /// Service date relative to the query date.
    day: i8,
    onboard: bool,
}

#[derive(Clone, Copy)]
struct Seed {
    /// Departure from the origin that just catches this trip.
    tau: Secs,
    trip: TripIdx,
    pos: u16,
    day: i8,
}

/// Per-thread working memory, reused across queries. Everything is reset by
/// walking the lists of touched entries.
#[derive(Default)]
struct Scratch {
    n_stops: usize,
    n_patterns: usize,
    lab: Vec<Label>,
    par_board: Vec<u32>,
    par_pos: Vec<u16>,
    par_from: Vec<StopIdx>,
    sflags: Vec<u8>,
    /// Valid while a stop is marked: trips leaving at or after this were
    /// already tried from the stop.
    bound: Vec<Secs>,
    /// Per stop, the best `ride` (`ready`) label over rounds `0..=k` for the
    /// phase that is running, filled on first use in that phase. Most
    /// candidates fail against it, and it is eight times denser than `lab`.
    star_ride: Vec<Star>,
    star_ready: Vec<Star>,
    /// Phase counter for the `Star` caches.
    stamp: u32,
    access: Vec<Secs>,
    egress: Vec<Secs>,
    queue_pos: Vec<u16>,
    touched: Vec<StopIdx>,
    marked: Vec<StopIdx>,
    improved: Vec<StopIdx>,
    queue: Vec<PatternIdx>,
    acc_stops: Vec<StopIdx>,
    boards: Vec<Board>,
    seeds: Vec<Seed>,
    /// (trip, day) of continuation trips already ridden → lowest round.
    cont_done: FxHashMap<(TripIdx, i8), u8>,
}

impl Scratch {
    fn ensure(&mut self, n_stops: usize, n_patterns: usize) {
        if self.n_stops == n_stops && self.n_patterns == n_patterns {
            return;
        }
        *self = Scratch {
            n_stops,
            n_patterns,
            lab: vec![NO_LABEL; n_stops * R],
            par_board: vec![NONE; n_stops * R],
            par_pos: vec![0; n_stops * R],
            par_from: vec![NONE; n_stops * R],
            sflags: vec![0; n_stops],
            bound: vec![INF; n_stops],
            star_ride: vec![Star::default(); n_stops],
            star_ready: vec![Star::default(); n_stops],
            stamp: 0,
            access: vec![INF; n_stops],
            egress: vec![INF; n_stops],
            queue_pos: vec![u16::MAX; n_patterns],
            ..Default::default()
        };
    }
}

thread_local! {
    static SCRATCH: RefCell<Scratch> = RefCell::new(Scratch::default());
}

/// A trip on a service date, with everything needed to read its live times.
#[derive(Clone, Copy)]
struct Cur<'a> {
    /// Index of `arr₀` in `Timetable::times`.
    base: usize,
    /// Seconds to add to get times relative to the query date.
    shift: Secs,
    live: Option<&'a TripLive>,
    trip: TripIdx,
    /// `Board` record, created when the first label needs it.
    rec: u32,
    prev: u32,
    /// Index of the trip among its pattern's trips of its service date, if known.
    slot: u32,
    pos: u16,
    day: i8,
    onboard: bool,
}

impl Cur<'_> {
    #[inline]
    fn arr(&self, times: &[Secs], i: usize) -> Secs {
        let t = times[self.base + 2 * i] + self.shift;
        match self.live {
            Some(l) => t + l.arr_delay_at(i),
            None => t,
        }
    }
    #[inline]
    fn dep(&self, times: &[Secs], i: usize) -> Secs {
        let t = times[self.base + 2 * i + 1] + self.shift;
        match self.live {
            Some(l) => t + l.dep_delay_at(i),
            None => t,
        }
    }
    #[inline]
    fn skipped(&self, i: usize) -> bool {
        match self.live {
            // The traveller sits in the on-board trip: a cancellation flag cannot apply to it.
            Some(l) if self.onboard => l.skipped.get(i).copied().unwrap_or(false),
            Some(l) => l.is_skipped(i),
            None => false,
        }
    }
}

struct Engine<'a> {
    rt: &'a Router,
    tt: &'a Timetable,
    days: &'a DaySet,
    q: &'a Query<'a>,
    live: Option<&'a dyn LiveView>,
    max_delay: Secs,
    fp: Option<&'a Footpaths>,
    s: &'a mut Scratch,
    /// Highest round = maximum number of rides.
    rounds: usize,
    speed: f32,
    margin: Secs,
    min_egress: Secs,
    lb: crate::bounds::Bounds<'a>,
    /// Best arrival at the destination with at most `k` rides, over all iterations so far.
    target_best: [Secs; R],
    /// Egress stop through which `target_best[k]` improved in the current iteration.
    hits: [StopIdx; R],
    /// Stamps of the running ride phase and transfer phase (see `Star`).
    ride_stamp: u32,
    ready_stamp: u32,
}

pub(crate) fn plan(rt: &Router, q: &Query) -> Vec<Journey> {
    if q.egress.is_empty() || (q.onboard.is_none() && q.access.is_empty()) {
        return Vec::new();
    }
    let days = rt.days.set(&rt.tt, &rt.pat_span, q.date);
    SCRATCH.with(|cell| match cell.try_borrow_mut() {
        Ok(mut s) => run(rt, &days, q, &mut s),
        Err(_) => run(rt, &days, q, &mut Scratch::default()),
    })
}

fn run(rt: &Router, days: &DaySet, q: &Query, s: &mut Scratch) -> Vec<Journey> {
    let tt: &Timetable = &rt.tt;
    s.ensure(tt.stops.len(), tt.patterns.len());
    let fp = (q.footpaths.off.len() == tt.stops.len() + 1).then_some(q.footpaths);
    let speed = if q.walk_speed.is_finite() && q.walk_speed > 0.05 { q.walk_speed } else { kante_core::DEFAULT_SPEED_MPS };
    let mut e = Engine {
        rt,
        tt,
        days,
        q,
        live: q.live,
        max_delay: q.live.map_or(0, |l| l.max_delay().max(0)),
        fp,
        s,
        // The ride the traveller is already on is round 0 and counts as a ride.
        rounds: (q.max_transfers as usize + q.onboard.is_none() as usize).min(MAX_RIDES),
        speed,
        margin: q.transfer_margin.max(0),
        min_egress: INF,
        lb: crate::bounds::Bounds::new(rt, q, fp, speed),
        target_best: [INF; R],
        hits: [NONE; R],
        ride_stamp: 0,
        ready_stamp: 0,
    };
    let mut out = Vec::new();
    if e.set_egress() {
        match q.onboard {
            Some(ob) => e.run_onboard(ob, &mut out),
            None => e.run_access(&mut out),
        }
    }
    timed!(18, e.reset());
    finalize(out)
}

impl<'a> Engine<'a> {
    /// A new phase for the `Star` caches: everything cached before is stale.
    fn next_stamp(&mut self) -> u32 {
        let s = &mut *self.s;
        s.stamp = s.stamp.wrapping_add(1);
        if s.stamp == 0 {
            // Wrapped after 4 billion phases: forget all stamps.
            s.star_ride.fill(Star::default());
            s.star_ready.fill(Star::default());
            s.stamp = 1;
        }
        s.stamp
    }

    #[inline]
    fn touch(&mut self, s: StopIdx) {
        let f = &mut self.s.sflags[s as usize];
        if *f & F_TOUCHED == 0 {
            *f |= F_TOUCHED;
            self.s.touched.push(s);
        }
    }

    fn set_egress(&mut self) -> bool {
        let n = self.s.n_stops;
        for &(s, secs) in self.q.egress {
            if (s as usize) < n && secs >= 0 {
                self.touch(s);
                self.s.sflags[s as usize] |= F_EGRESS;
                let e = &mut self.s.egress[s as usize];
                *e = (*e).min(secs);
                self.min_egress = self.min_egress.min(secs);
            }
        }
        self.min_egress != INF
    }

    fn reset(&mut self) {
        let s = &mut *self.s;
        for &st in &s.touched {
            let b = st as usize * R;
            s.lab[b..b + R].fill(NO_LABEL);
            s.sflags[st as usize] = 0;
        }
        s.touched.clear();
        for &(st, _) in self.q.egress {
            if (st as usize) < s.n_stops {
                s.egress[st as usize] = INF;
            }
        }
        for &st in &s.acc_stops {
            s.access[st as usize] = INF;
        }
        s.acc_stops.clear();
        s.marked.clear();
        s.improved.clear();
        s.boards.clear();
        s.seeds.clear();
        s.cont_done.clear();
    }

    /// Trip instance `trip` on `q.date + day`, boarded at `pos`.
    fn inst(&self, trip: TripIdx, day: i8, pos: u16) -> Cur<'a> {
        let tt = self.tt;
        let pat = &tt.patterns[tt.trips[trip as usize].pattern as usize];
        let live: Option<&'a dyn LiveView> = self.live;
        Cur {
            base: pat.times_off as usize + (trip - pat.trips_off) as usize * 2 * pat.n_stops as usize,
            shift: day as Secs * DAY,
            live: live.and_then(|l| l.trip(self.q.date + day as Date, trip)),
            trip,
            rec: NONE,
            prev: NONE,
            slot: NONE,
            pos,
            day,
            onboard: false,
        }
    }

    #[inline]
    fn rec(&mut self, cur: &mut Cur<'a>) -> u32 {
        if cur.rec == NONE {
            cur.rec = self.s.boards.len() as u32;
            self.s.boards.push(Board { trip: cur.trip, prev: cur.prev, pos: cur.pos, day: cur.day, onboard: cur.onboard });
        }
        cur.rec
    }

    /// The trip of pattern `p` with the earliest (live) departure at position
    /// `i` in `[t, before)`, over the three service dates.
    fn earliest(&self, h: &PatDays, p: PatternIdx, i: usize, t: Secs, before: Secs) -> Option<Cur<'a>> {
        count!(5);
        let (pmin, pmax) = (h.min, h.max);
        let live: Option<&'a dyn LiveView> = self.live;
        let mut best_dep = before;
        let mut best: Option<(TripIdx, usize, usize, Option<&'a TripLive>)> = None;
        match live {
            None => {
                // Plain binary search in the day's departure column. Service
                // dates follow each other in time unless the pattern runs
                // round the clock, so the first hit is normally the answer.
                let wraps = h.wraps();
                for d in 0..3usize {
                    let shift = (d as Secs - 1) * DAY;
                    if pmax + shift < t {
                        continue;
                    }
                    if pmin + shift >= best_dep {
                        break;
                    }
                    let (col, trips) = self.days.column(h, d, i);
                    let j = col.partition_point(|&x| x + shift < t);
                    if j < col.len() {
                        let dep = col[j] + shift;
                        if dep < best_dep {
                            best_dep = dep;
                            best = Some((trips[j], d, j, None));
                        }
                        if !wraps {
                            break;
                        }
                    }
                }
            }
            Some(lv) => {
                // Delays can reorder trips: start `max_delay` earlier and
                // compare live times until no later-scheduled trip can win.
                let lo = t.saturating_sub(self.max_delay);
                for d in 0..3usize {
                    let shift = (d as Secs - 1) * DAY;
                    if pmax + shift < lo {
                        continue;
                    }
                    if pmin + shift >= best_dep.saturating_add(EARLY_SLACK) {
                        break;
                    }
                    let (col, trips) = self.days.column(h, d, i);
                    let date = self.q.date + d as Date - 1;
                    for j in col.partition_point(|&x| x + shift < lo)..col.len() {
                        let sd = col[j] + shift;
                        if sd >= best_dep.saturating_add(EARLY_SLACK) {
                            break;
                        }
                        let l = lv.trip(date, trips[j]);
                        let ld = match l {
                            Some(l) => {
                                if l.is_skipped(i) {
                                    continue;
                                }
                                sd + l.dep_delay_at(i)
                            }
                            None => sd,
                        };
                        if ld >= t && ld < best_dep {
                            best_dep = ld;
                            best = Some((trips[j], d, j, l));
                        }
                    }
                }
            }
        }
        best.map(|(trip, d, j, live)| {
            let pat = &self.tt.patterns[p as usize];
            Cur {
                base: pat.times_off as usize + (trip - pat.trips_off) as usize * 2 * pat.n_stops as usize,
                shift: (d as Secs - 1) * DAY,
                live,
                trip,
                rec: NONE,
                prev: NONE,
                slot: j as u32,
                pos: i as u16,
                day: d as i8 - 1,
                onboard: false,
            }
        })
    }

    /// Scheduled departure at position `i` of the trip before `c` in its
    /// pattern (same service date, else the last trip of an earlier one).
    /// Only meaningful without live data and for patterns that do not wrap.
    #[inline]
    fn prev_dep(&self, h: &PatDays, i: usize, c: &Cur<'a>) -> Option<Secs> {
        let d = (c.day + 1) as usize;
        if c.slot > 0 {
            let (col, _) = self.days.column(h, d, i);
            return Some(col[c.slot as usize - 1] + c.shift);
        }
        (0..d).rev().find_map(|dd| {
            let (col, _) = self.days.column(h, dd, i);
            col.last().map(|&x| x + (dd as Secs - 1) * DAY)
        })
    }

    /// Every trip of pattern `p` with a (live) departure at position `i` in `[lo, hi]`.
    fn trips_in(&self, h: &PatDays, i: usize, lo: Secs, hi: Secs, mut f: impl FnMut(TripIdx, i8, Secs)) {
        let (pmin, pmax) = (h.min, h.max);
        let (back, ahead) = if self.live.is_some() { (self.max_delay, EARLY_SLACK) } else { (0, 0) };
        let (slo, shi) = (lo.saturating_sub(back), hi.saturating_add(ahead));
        for d in 0..3usize {
            let shift = (d as Secs - 1) * DAY;
            if pmax + shift < slo || pmin + shift > shi {
                continue;
            }
            let (col, trips) = self.days.column(h, d, i);
            let date = self.q.date + d as Date - 1;
            for j in col.partition_point(|&x| x + shift < slo)..col.len() {
                let sd = col[j] + shift;
                if sd > shi {
                    break;
                }
                let ld = match self.live.and_then(|l| l.trip(date, trips[j])) {
                    Some(l) => {
                        if l.is_skipped(i) {
                            continue;
                        }
                        sd + l.dep_delay_at(i)
                    }
                    None => sd,
                };
                if ld >= lo && ld <= hi {
                    f(trips[j], d as i8 - 1, ld);
                }
            }
        }
    }

    /// A vehicle boarded as `cur` reaches `stop` (position `pos`) at `a` in round `k`.
    #[inline]
    fn arrive(&mut self, k: usize, stop: StopIdx, a: Secs, cur: &mut Cur<'a>, pos: usize) {
        if a.saturating_add(self.min_egress) >= self.target_best[k] {
            return;
        }
        let b = stop as usize * R;
        {
            let s = &mut *self.s;
            let st = &mut s.star_ride[stop as usize];
            if st.stamp != self.ride_stamp {
                *st = Star { v: s.lab[b..=b + k].iter().map(|l| l.ride).min().unwrap(), stamp: self.ride_stamp };
            }
            if a >= st.v {
                return;
            }
        }
        if self.lb.prune(stop, a, self.target_best[k], &self.target_best) {
            return;
        }
        self.s.star_ride[stop as usize].v = a;
        count!(8);
        let rec = self.rec(cur);
        let s = &mut *self.s;
        s.lab[b + k].ride = a;
        s.par_board[b + k] = rec;
        s.par_pos[b + k] = pos as u16;
        let f = &mut s.sflags[stop as usize];
        let fl = *f;
        if fl & F_IMPROVED == 0 {
            *f = fl | F_IMPROVED | F_TOUCHED;
            s.improved.push(stop);
            if fl & F_TOUCHED == 0 {
                s.touched.push(stop);
            }
        }
        if fl & F_EGRESS != 0 {
            let at = a + s.egress[stop as usize];
            if at < self.target_best[k] {
                for t in &mut self.target_best[k..] {
                    *t = (*t).min(at);
                }
                self.hits[k] = stop;
            }
        }
    }

    /// Best `ready` label of `to` over rounds `0..=k` in the running transfer phase.
    #[inline]
    fn ready_star(&mut self, k: usize, to: StopIdx) -> Secs {
        let s = &mut *self.s;
        let st = &mut s.star_ready[to as usize];
        if st.stamp != self.ready_stamp {
            let b = to as usize * R;
            *st = Star { v: s.lab[b..=b + k].iter().map(|l| l.ready).min().unwrap(), stamp: self.ready_stamp };
        }
        st.v
    }

    /// Boarding at `to` becomes possible at `cand` after `k` rides, coming
    /// from `from`. `best` is `ready_star(k, to)`.
    #[inline]
    fn set_ready(&mut self, k: usize, to: StopIdx, cand: Secs, from: StopIdx, best: Secs) {
        if cand >= best || cand.saturating_add(self.min_egress) >= self.target_best[k + 1] || self.lb.prune(to, cand, self.target_best[k + 1], &self.target_best) {
            return;
        }
        count!(10);
        let b = to as usize * R;
        let s = &mut *self.s;
        s.star_ready[to as usize].v = cand;
        s.lab[b + k].ready = cand;
        s.par_from[b + k] = from;
        let f = &mut s.sflags[to as usize];
        let fl = *f;
        if fl & F_MARKED == 0 {
            *f = fl | F_MARKED | F_TOUCHED;
            s.marked.push(to);
            // First improvement in this phase: `best` is still the value from
            // before it, i.e. what earlier iterations and lower rounds had.
            s.bound[to as usize] = best;
            if fl & F_TOUCHED == 0 {
                s.touched.push(to);
            }
        }
    }

    /// Ride `cur` from position `from` to the end of the trip and on into its continuations.
    fn ride(&mut self, k: usize, cur: &mut Cur<'a>, from: usize) {
        let tt = self.tt;
        let pat = &tt.patterns[tt.trips[cur.trip as usize].pattern as usize];
        let (off, n) = (pat.stops_off as usize, pat.n_stops as usize);
        let stops = &tt.pattern_stops[off..off + n];
        let flags = &tt.pattern_flags[off..off + n];
        count!(7, n - from - 1);
        for i in from + 1..n {
            if flags[i] & FLAG_NO_DROPOFF == 0 && !cur.skipped(i) {
                let a = cur.arr(&tt.times, i);
                self.arrive(k, stops[i], a, cur, i);
            }
            if k >= 2 && self.walkable(stops[i], flags[i], cur, i, n) {
                return;
            }
        }
        self.follow(k, cur);
    }

    /// Riding on from here is pointless: the traveller could have walked from
    /// the origin to this access stop and boarded the same vehicle with fewer
    /// rides and a later departure. (Inside the window that journey is found
    /// by its own seed; this also drops the detour when it lies outside.)
    #[inline]
    fn walkable(&self, stop: StopIdx, flag: u8, cur: &Cur<'a>, i: usize, n: usize) -> bool {
        self.s.sflags[stop as usize] & F_ACCESS != 0
            && i + 1 < n
            && flag & FLAG_NO_PICKUP == 0
            && !cur.skipped(i)
            && cur.dep(&self.tt.times, i) >= self.s.lab[stop as usize * R].ready
    }

    /// Stay seated: at the last stop of `cur` keep riding the trips it continues as.
    fn follow(&mut self, k: usize, cur: &mut Cur<'a>) {
        if !self.rt.trip_has_cont(cur.trip) {
            return;
        }
        let tt = self.tt;
        let n = tt.patterns[tt.trips[cur.trip as usize].pattern as usize].n_stops as usize;
        if cur.skipped(n - 1) {
            return;
        }
        let date_a = self.q.date + cur.day as Date;
        let sched_arr = tt.times[cur.base + 2 * (n - 1)] + cur.shift;
        for c in tt.continuations_from(cur.trip) {
            if c.service != NONE && !tt.service_active(c.service, date_a) {
                continue;
            }
            let b = c.to;
            let pb = &tt.patterns[tt.trips[b as usize].pattern as usize];
            if pb.n_stops < 2 {
                continue;
            }
            let base = pb.times_off as usize + (b - pb.trips_off) as usize * 2 * pb.n_stops as usize;
            let dep0 = tt.times[base + 1];
            // The continuation normally runs on the same service date; around
            // midnight the feed may attach it to a neighbouring one.
            let mut found = None;
            for dd in [0, 1, -1] {
                let day = cur.day as i32 + dd;
                if day.abs() > 3 || !tt.trip_active(b, date_a + dd) {
                    continue;
                }
                let gap = dep0 + day * DAY - sched_arr;
                if (0..=MAX_CONT_GAP).contains(&gap) {
                    found = Some(day as i8);
                    break;
                }
            }
            let Some(day) = found else { continue };
            let live: Option<&'a dyn LiveView> = self.live;
            let live_b = live.and_then(|l| l.trip(self.q.date + day as Date, b));
            if live_b.is_some_and(|l| l.is_skipped(0)) {
                continue;
            }
            // A continuation trip is ridden from its first stop whoever feeds
            // it, so once per trip instance and round is enough.
            match self.s.cont_done.get(&(b, day)) {
                Some(&done) if done as usize <= k => continue,
                _ => {}
            }
            self.s.cont_done.insert((b, day), k as u8);
            let prev = self.rec(cur);
            let mut child = Cur { base, shift: day as Secs * DAY, live: live_b, trip: b, rec: NONE, prev, slot: NONE, pos: 0, day, onboard: false };
            self.ride(k, &mut child, 0);
        }
    }

    /// Does this trip leave out a stop after position `i` today?
    #[inline]
    fn skips_after(c: &Cur<'a>, i: usize) -> bool {
        c.live.is_some_and(|l| l.skipped.iter().skip(i + 1).any(|&x| x))
    }

    /// The earliest trip normally stands for all later trips of its pattern.
    /// Not when it leaves out stops further on: then the following trips are
    /// ridden from position `i` as well, until one serves every stop.
    fn ride_alternatives(&mut self, k: usize, h: &PatDays, p: PatternIdx, i: usize, first: &Cur<'a>, before: Secs) {
        let mut c = *first;
        for _ in 0..4 {
            if !Self::skips_after(&c, i) {
                return;
            }
            let Some(mut alt) = self.earliest(h, p, i, c.dep(&self.tt.times, i) + 1, before) else { return };
            self.ride(k, &mut alt, i);
            c = alt;
        }
    }

    /// Round `k >= 1`: scan pattern `p` from position `start`, boarding at marked stops.
    fn scan_pattern(&mut self, k: usize, p: PatternIdx, start: usize) {
        let tt = self.tt;
        let pat = &tt.patterns[p as usize];
        let (off, n) = (pat.stops_off as usize, pat.n_stops as usize);
        let stops = &tt.pattern_stops[off..off + n];
        let flags = &tt.pattern_flags[off..off + n];
        let times = &tt.times[..];
        let days: &'a DaySet = self.days;
        let h = days.pat(p);
        if h.mode & self.q.modes == 0 {
            return;
        }
        let plain = self.live.is_none() && !h.wraps();
        let mut cur: Option<Cur<'a>> = None;
        count!(3);
        count!(4, n - start);
        for i in start..n {
            let s = stops[i];
            let f = flags[i];
            if let Some(c) = cur.as_mut() {
                if f & FLAG_NO_DROPOFF == 0 && !c.skipped(i) {
                    let a = c.arr(times, i);
                    self.arrive(k, s, a, c, i);
                }
                if k >= 2 && self.walkable(s, f, c, i, n) {
                    cur = None;
                }
            }
            if i + 1 < n && self.s.sflags[s as usize] & F_MARKED != 0 && f & FLAG_NO_PICKUP == 0 {
                let r = self.s.lab[s as usize * R + k - 1].ready;
                let mut upper = self.s.bound[s as usize];
                if let Some(c) = &cur {
                    upper = upper.min(c.dep(times, i));
                }
                // With a vehicle already boarded, an earlier one can only be
                // caught here if its predecessor leaves at or after `r`.
                let worth = match &cur {
                    Some(c) if plain && c.slot != NONE => self.prev_dep(h, i, c).is_some_and(|d| d >= r),
                    _ => true,
                };
                if r < upper && worth {
                    if let Some(nc) = self.earliest(h, p, i, r, upper) {
                        // The trip we leave may still continue somewhere useful.
                        if let Some(mut old) = cur.take() {
                            self.follow(k, &mut old);
                        }
                        count!(6);
                        self.ride_alternatives(k, h, p, i, &nc, self.s.bound[s as usize]);
                        cur = Some(nc);
                    }
                }
            }
        }
        if let Some(mut c) = cur {
            self.follow(k, &mut c);
        }
    }

    fn scan_round(&mut self, k: usize) {
        self.ride_stamp = self.next_stamp();
        let marked = std::mem::take(&mut self.s.marked);
        let mut queue = std::mem::take(&mut self.s.queue);
        let modes = self.q.modes;
        count!(11, marked.len());
        let (back, ahead) = if self.live.is_some() { (self.max_delay, EARLY_SLACK) } else { (0, 0) };
        let days: &'a DaySet = self.days;
        let tt = self.tt;
        timed!(14, for &s in &marked {
            let all = days.boardable(s);
            // Only trips leaving in [ready, bound) can be boarded here. When
            // that interval is bounded and holds few departures, queue just
            // their patterns (read off the stop's departure list) instead of
            // every pattern that calls at the stop.
            let bound = self.s.bound[s as usize];
            let mut listed = bound != INF && all.len() > 1;
            if listed {
                let lo_t = self.s.lab[s as usize * R + k - 1].ready.saturating_sub(back);
                let hi_t = bound.saturating_add(ahead);
                let mut budget = 2 * all.len() + 8;
                let list = tt.stop_patterns(s);
                'days: for d in 0..3usize {
                    let day = &days.days[d];
                    let shift = (d as Secs - 1) * DAY;
                    if !day.sd_ok {
                        listed = false;
                        break;
                    }
                    // (A date without service has t_min = MAX, t_max = MIN.)
                    if day.t_max.saturating_add(shift) < lo_t || day.t_min.saturating_add(shift) >= hi_t {
                        continue;
                    }
                    let deps = day.stop_departures(s);
                    let from = ((lo_t - shift).max(0) as u32) << ENT_BITS;
                    for &x in &deps[deps.partition_point(|&x| x < from)..] {
                        if (x >> ENT_BITS) as Secs + shift >= hi_t {
                            break;
                        }
                        if budget == 0 {
                            listed = false;
                            break 'days;
                        }
                        budget -= 1;
                        count!(2);
                        let (p, pos) = list[(x & ((1 << ENT_BITS) - 1)) as usize];
                        let qp = &mut self.s.queue_pos[p as usize];
                        if *qp == u16::MAX {
                            queue.push(p);
                            *qp = pos;
                        } else if pos < *qp {
                            *qp = pos;
                        }
                    }
                }
            }
            if listed {
                continue;
            }
            count!(2, all.len());
            for &Boardable { pattern: p, pos, mode } in all {
                if mode & modes == 0 {
                    continue;
                }
                let qp = &mut self.s.queue_pos[p as usize];
                if *qp == u16::MAX {
                    queue.push(p);
                    *qp = pos;
                } else if pos < *qp {
                    *qp = pos;
                }
            }
        });
        timed!(15, for &p in &queue {
            let start = std::mem::replace(&mut self.s.queue_pos[p as usize], u16::MAX);
            self.scan_pattern(k, p, start as usize);
        });
        for &s in &marked {
            self.s.sflags[s as usize] &= !F_MARKED;
        }
        queue.clear();
        self.s.queue = queue;
        debug_assert!(self.s.marked.is_empty());
        let mut marked = marked;
        marked.clear();
        self.s.marked = marked;
    }

    /// After the rides of round `k`: change times and footpaths from every
    /// stop whose `ride` label improved; marks the stops for round `k + 1`.
    fn transfers(&mut self, k: usize) {
        let improved = std::mem::take(&mut self.s.improved);
        let onward = k < self.rounds;
        let n_stops = self.s.n_stops;
        self.ready_stamp = self.next_stamp();
        for &s in &improved {
            self.s.sflags[s as usize] &= !F_IMPROVED;
            if !onward {
                continue;
            }
            let a = self.s.lab[s as usize * R + k].ride + self.margin;
            if a.saturating_add(self.min_egress) >= self.target_best[k + 1] || self.lb.prune(s, a, self.target_best[k + 1], &self.target_best) {
                continue;
            }
            let best = self.ready_star(k, s);
            self.set_ready(k, s, a, s, best);
            if let Some(fp) = self.fp {
                for e in fp.off[s as usize] as usize..fp.off[s as usize + 1] as usize {
                    let to = fp.to[e];
                    if to == s || to as usize >= n_stops {
                        continue;
                    }
                    count!(9);
                    // Cannot improve even with a zero-length walk: skip the division.
                    let best = self.ready_star(k, to);
                    if a >= best {
                        continue;
                    }
                    let w = walk_secs(fp.var_m[e] as f32, fp.fix_s[e] as f32, self.speed).ceil() as Secs;
                    if w > self.q.max_walk {
                        continue;
                    }
                    self.set_ready(k, to, a + w, s, best);
                }
            }
        }
        let mut improved = improved;
        improved.clear();
        self.s.improved = improved;
    }

    fn rounds_from(&mut self, first: usize) {
        let mut k = first;
        while k <= self.rounds && !self.s.marked.is_empty() {
            self.scan_round(k);
            timed!(16, self.transfers(k));
            k += 1;
        }
    }

    fn collect(&mut self, out: &mut Vec<Journey>) {
        for k in 0..=self.rounds {
            let s = std::mem::replace(&mut self.hits[k], NONE);
            if s != NONE {
                if let Some(j) = self.build(k, s) {
                    out.push(j);
                }
            }
        }
    }

    fn run_access(&mut self, out: &mut Vec<Journey>) {
        let tt = self.tt;
        let q = self.q;
        let window = q.window.max(0);
        let n_stops = self.s.n_stops;
        let mut acc = std::mem::take(&mut self.s.acc_stops);
        for &(s, secs) in q.access {
            if (s as usize) < n_stops && secs >= 0 {
                let a = &mut self.s.access[s as usize];
                if *a == INF {
                    acc.push(s);
                }
                *a = (*a).min(secs);
                self.touch(s);
                self.s.sflags[s as usize] |= F_ACCESS;
            }
        }

        // Seeds: the departures from access stops that a journey can start with.
        let mut seeds = std::mem::take(&mut self.s.seeds);
        #[cfg(feature = "stats")]
        let t_seeds = std::time::Instant::now();
        for &s in &acc {
            let a = self.s.access[s as usize];
            let r0 = q.from.saturating_add(a);
            for &Boardable { pattern: p, pos, mode } in self.days.boardable(s) {
                if mode & q.modes == 0 {
                    continue;
                }
                let i = pos as usize;
                let h = self.days.pat(p);
                if window == 0 {
                    let mut next = self.earliest(h, p, i, r0, INF);
                    let mut tries = 0;
                    while let Some(c) = next {
                        let dep = c.dep(&tt.times, i);
                        seeds.push(Seed { tau: dep - a, trip: c.trip, pos, day: c.day });
                        // See `ride_alternatives`.
                        tries += 1;
                        next = if tries < 5 && Self::skips_after(&c, i) { self.earliest(h, p, i, dep + 1, INF) } else { None };
                    }
                } else {
                    self.trips_in(h, i, r0, r0.saturating_add(window), |trip, day, dep| seeds.push(Seed { tau: dep - a, trip, pos, day }));
                }
            }
        }

        #[cfg(feature = "stats")]
        stats::add(12, t_seeds.elapsed().as_nanos() as u64);
        if window == 0 {
            for &s in &acc {
                self.s.lab[s as usize * R].ready = q.from + self.s.access[s as usize];
                self.touch(s);
            }
            count!(0);
            count!(1, seeds.len());
            self.ride_stamp = self.next_stamp();
            for sd in &seeds {
                let mut cur = self.inst(sd.trip, sd.day, sd.pos);
                self.ride(1, &mut cur, sd.pos as usize);
            }
            self.transfers(1);
            self.rounds_from(2);
            self.collect(out);
        } else {
            // Latest departure first; labels persist, so every later iteration
            // only explores what leaving earlier improves.
            seeds.sort_unstable_by(|a, b| b.tau.cmp(&a.tau).then(a.trip.cmp(&b.trip)).then(a.pos.cmp(&b.pos)));
            let mut i = 0;
            count!(1, seeds.len());
            while i < seeds.len() {
                count!(0);
                let tau = seeds[i].tau;
                for &s in &acc {
                    self.s.lab[s as usize * R].ready = tau + self.s.access[s as usize];
                    self.touch(s);
                }
                self.ride_stamp = self.next_stamp();
                timed!(13, while i < seeds.len() && seeds[i].tau == tau {
                    let sd = seeds[i];
                    let mut cur = self.inst(sd.trip, sd.day, sd.pos);
                    self.ride(1, &mut cur, sd.pos as usize);
                    i += 1;
                });
                timed!(16, self.transfers(1));
                self.rounds_from(2);
                timed!(17, self.collect(out));
            }
        }
        seeds.clear();
        self.s.seeds = seeds;
        self.s.acc_stops = acc;
    }

    fn run_onboard(&mut self, ob: Onboard, out: &mut Vec<Journey>) {
        let tt = self.tt;
        let day = ob.date - self.q.date;
        if ob.trip as usize >= tt.trips.len() || day.abs() > 3 {
            return;
        }
        let pat = &tt.patterns[tt.trips[ob.trip as usize].pattern as usize];
        let (off, n) = (pat.stops_off as usize, pat.n_stops as usize);
        if ob.next_pos as usize >= n {
            return;
        }
        let mut cur = self.inst(ob.trip, day as i8, ob.next_pos);
        cur.onboard = true;
        self.ride_stamp = self.next_stamp();
        for i in ob.next_pos as usize..n {
            if tt.pattern_flags[off + i] & FLAG_NO_DROPOFF == 0 && !cur.skipped(i) {
                let a = cur.arr(&tt.times, i).max(self.q.from);
                self.arrive(0, tt.pattern_stops[off + i], a, &mut cur, i);
            }
        }
        self.follow(0, &mut cur);
        self.transfers(0);
        self.rounds_from(1);
        self.collect(out);
    }

    /// Follow the parent pointers back from the `k`-ride arrival at egress stop `stop`.
    fn build(&self, k: usize, stop: StopIdx) -> Option<Journey> {
        let tt = self.tt;
        let s = &*self.s;
        let q = self.q;
        let onboard_mode = q.onboard.is_some();
        let mut legs: Vec<Leg> = Vec::with_capacity(2 * k + 3);
        let a = s.lab[stop as usize * R + k].ride;
        let arr = a + s.egress[stop as usize];
        legs.push(Leg::Egress { from: stop, dep: a, arr });
        let (mut k, mut stop) = (k, stop);
        let dep;
        loop {
            let li = stop as usize * R + k;
            let mut rec = *s.boards.get(s.par_board[li] as usize)?;
            let mut to_pos = s.par_pos[li] as usize;
            let (first_dep, board_stop);
            loop {
                let c = self.inst(rec.trip, rec.day, rec.pos);
                let pat = &tt.patterns[tt.trips[rec.trip as usize].pattern as usize];
                let (r_dep, r_arr) = if rec.onboard {
                    (q.from, c.arr(&tt.times, to_pos).max(q.from))
                } else {
                    (c.dep(&tt.times, rec.pos as usize), c.arr(&tt.times, to_pos))
                };
                legs.push(Leg::Ride {
                    trip: rec.trip,
                    date: q.date + rec.day as Date,
                    from_pos: rec.pos,
                    to_pos: to_pos as u16,
                    dep: r_dep,
                    arr: r_arr,
                    stay_seated: rec.prev != NONE,
                    onboard: rec.onboard,
                });
                if rec.prev == NONE {
                    first_dep = r_dep;
                    board_stop = tt.pattern_stops[pat.stops_off as usize + rec.pos as usize];
                    break;
                }
                rec = *s.boards.get(rec.prev as usize)?;
                to_pos = tt.patterns[tt.trips[rec.trip as usize].pattern as usize].n_stops as usize - 1;
            }
            if rec.onboard {
                dep = q.from;
                break;
            }
            if k == 0 {
                return None;
            }
            if k == 1 && !onboard_mode {
                let acc = s.access[board_stop as usize];
                if acc == INF {
                    return None;
                }
                dep = first_dep - acc;
                legs.push(Leg::Access { to: board_stop, dep, arr: first_dep });
                break;
            }
            k -= 1;
            let from = s.par_from[board_stop as usize * R + k];
            if from == NONE {
                return None;
            }
            let t_dep = s.lab[from as usize * R + k].ride;
            let (var_m, fix_s, walk) = if from == board_stop {
                (0, 0, 0)
            } else {
                let (v, f) = self.fp?.get(from, board_stop)?;
                (v, f, walk_secs(v as f32, f as f32, self.speed).ceil() as Secs)
            };
            legs.push(Leg::Transfer { from, to: board_stop, dep: t_dep, arr: t_dep + walk, var_m, fix_s });
            stop = from;
        }
        legs.reverse();
        let rides = legs.iter().filter(|l| matches!(l, Leg::Ride { stay_seated: false, .. })).count();
        Some(Journey { dep, arr, transfers: rides.saturating_sub(1) as u8, legs })
    }
}

/// Sort by departure and drop journeys dominated in (departure, arrival, transfers).
fn finalize(mut v: Vec<Journey>) -> Vec<Journey> {
    v.sort_by(|a, b| a.dep.cmp(&b.dep).then(a.arr.cmp(&b.arr)).then(a.transfers.cmp(&b.transfers)));
    let n = v.len();
    let mut keep = vec![true; n];
    for i in 0..n {
        for j in 0..n {
            if i == j || !keep[j] {
                continue;
            }
            let (a, b) = (&v[i], &v[j]);
            let no_worse = b.dep >= a.dep && b.arr <= a.arr && b.transfers <= a.transfers;
            let better = b.dep > a.dep || b.arr < a.arr || b.transfers < a.transfers;
            if no_worse && (better || j < i) {
                keep[i] = false;
                break;
            }
        }
    }
    let mut it = keep.into_iter();
    v.retain(|_| it.next().unwrap());
    v
}
