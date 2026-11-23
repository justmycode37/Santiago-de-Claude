//! Lower bounds on the time still needed to reach the destination, for
//! target pruning in the journey search (`plan.rs`): a label at stop `s` at
//! time `t` is dropped when `t + lb(s) ≥ best`, `best` being the best
//! arrival found so far with that many rides.
//!
//! # The bound
//!
//! `lb(s)` is the distance from the station of `s` to the destination in a
//! *minimum travel time* graph over stations, with the egress times as
//! sources. Its edges, each a lower bound on what the search can spend
//! between two stops of those stations:
//!
//! - **hops**: for every consecutive pair of a pattern, the minimum over its
//!   trips of `arr[i+1] − max(arr[i], dep[i])`. Riding from `i` to `j`
//!   telescopes to at most `arr[j] − dep[i]` (boarded at `i`) and at most
//!   `arr[j] − arr[i]` (seated through `i`), so a path of hops never costs
//!   more than the ride. Built once in [`Graph::new`].
//! - **in-seat continuations**: last stop of a trip → first stop of the trip
//!   it continues as, weight 0 (the search follows a continuation only when
//!   its scheduled departure is not before the scheduled arrival).
//! - **footpaths** between stations: `ceil(walk_secs(min var_m, min fix_s))`
//!   over the footpaths between their stops, at the query's speed, left out
//!   above `max_walk` (as the search does). Cached per footpath set.
//! - **live hops**: per snapshot, every live trip's hop with its live times
//!   where that is shorter than the scheduled minimum ([`LiveFold`]), so a
//!   trip that makes up time is covered.
//!
//! Moving between stops of one station costs 0. Transfer margins, waiting,
//! mode filters and the walk profile only add time. Being *at* a stop covers
//! both label kinds: a `ride` label leaves it by egress, a change or a
//! footpath, a `ready` label by boarding; either way the rest of the journey
//! is a path of the graph.
//!
//! # Times that run backwards
//!
//! A few transitions take *negative* time: a continuation whose live
//! departure is before the live arrival of the trip feeding it (the feeder is
//! late, its continuation is not), or a hop whose live times decrease. The
//! search follows them as they are, so no non-negative graph bounds a journey
//! that uses one. They are kept out of the graph as *negative transitions*
//! `(u, tau) → (v, s)`: whoever takes one is at `u` no later than `tau` and
//! carries on from `v` at `s < tau`.
//!
//! Up to its first negative transition a journey is a path of the graph, and
//! after its last one too. So a journey that arrives before `best` has a
//! last transition with `s + dist(v) < best`, or reaches such a transition
//! after another one: call all of those *harmful* (a fixpoint, see
//! `classify`). A label at `s` at `t` can only take a harmful transition
//! first if `t + dist(s, u) ≤ tau`, i.e. `t ≤ L(s) = max (tau − dist(s, u))`
//! over the harmful ones. A label is pruned only if `t + lb(s) ≥ best` *and*
//! `t > L(s)`.
//!
//! # Cost
//!
//! Both searches are backward Dijkstras over incoming edges and run lazily:
//! a check settles nodes only until it is decided (the frontier of an
//! unfinished search is itself a valid bound). Nothing is done before the
//! first journey is found, the distance search is limited to a share of the
//! work the journey search has done, and with negative transitions the
//! checks start only once the journey search has done enough work for them
//! to pay off.

use crate::plan::MAX_CONT_GAP;
use crate::{Query, Router};
use kante_core::time::{Date, Secs, DAY};
use kante_core::{walk_secs, Footpaths, LiveView, StopIdx, Timetable, TripIdx, TripLive};
use rayon::prelude::*;
use std::borrow::Cow;
use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};

const INF: Secs = Secs::MAX;
/// Graph nodes are stations.
type Node = u32;

/// Distinguishes routers, so data derived from a snapshot or a footpath set
/// is only used with the graph it was computed against.
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Static minimum-travel-time graph over stations, as incoming edges.
pub(crate) struct Graph {
    id: u64,
    /// Station of every stop.
    st: Vec<Node>,
    off: Vec<u32>,
    from: Vec<Node>,
    w: Vec<Secs>,
    /// Scheduled hops with negative time: (trip, position, `max(arr, dep)`
    /// there, arrival at the next position).
    neg: Vec<(TripIdx, u16, Secs, Secs)>,
    /// Indices into `Timetable::continuations`, sorted by the continuing trip.
    cont_by_to: Vec<u32>,
}

/// CSR of incoming edges `(from, weight)` per node, from `(to, from, weight)`.
fn csr<W: Copy>(n: usize, edges: &[(Node, Node, W)]) -> (Vec<u32>, Vec<Node>, Vec<W>) {
    let mut off = vec![0u32; n + 1];
    for &(v, _, _) in edges {
        off[v as usize + 1] += 1;
    }
    for i in 0..n {
        off[i + 1] += off[i];
    }
    (off, edges.iter().map(|e| e.1).collect(), edges.iter().map(|e| e.2).collect())
}

impl Graph {
    pub(crate) fn new(tt: &Timetable) -> Graph {
        let st: Vec<Node> = tt.stops.iter().map(|s| s.station).collect();
        let n = tt.stations.len();
        type Part = (Vec<(Node, Node, Secs)>, Vec<(TripIdx, u16, Secs, Secs)>);
        let parts: Vec<Part> = (0..tt.patterns.len())
            .into_par_iter()
            .map(|p| {
                let pat = &tt.patterns[p];
                let n = pat.n_stops as usize;
                if n < 2 || pat.n_trips == 0 {
                    return Default::default();
                }
                let stops = &tt.pattern_stops[pat.stops_off as usize..pat.stops_off as usize + n];
                let mut w = vec![INF; n - 1];
                let mut neg = Vec::new();
                for t in 0..pat.n_trips as usize {
                    let row = &tt.times[pat.times_off as usize + t * 2 * n..][..2 * n];
                    for i in 0..n - 1 {
                        let at = row[2 * i].max(row[2 * i + 1]);
                        let h = row[2 * i + 2] - at;
                        if h < 0 {
                            neg.push((pat.trips_off + t as TripIdx, i as u16, at, row[2 * i + 2]));
                        }
                        w[i] = w[i].min(h.max(0));
                    }
                }
                let (a, b) = (|i: usize| st[stops[i] as usize], |i: usize| st[stops[i + 1] as usize]);
                let edges = (0..n - 1).filter(|&i| a(i) != b(i)).map(|i| (b(i), a(i), w[i])).collect();
                (edges, neg)
            })
            .collect();
        let mut edges: Vec<(Node, Node, Secs)> = Vec::with_capacity(parts.iter().map(|p| p.0.len()).sum());
        let mut neg = Vec::new();
        for (e, n) in parts {
            edges.extend(e);
            neg.extend(n);
        }
        for c in &tt.continuations {
            let (pa, pb) = (&tt.patterns[tt.trips[c.from as usize].pattern as usize], &tt.patterns[tt.trips[c.to as usize].pattern as usize]);
            if pa.n_stops == 0 || pb.n_stops < 2 {
                continue;
            }
            let u = st[tt.pattern_stops[pa.stops_off as usize + pa.n_stops as usize - 1] as usize];
            let v = st[tt.pattern_stops[pb.stops_off as usize] as usize];
            if u != v {
                edges.push((v, u, 0));
            }
        }
        edges.par_sort_unstable();
        edges.dedup_by(|b, a| a.0 == b.0 && a.1 == b.1);
        let (off, from, w) = csr(n, &edges);
        let mut cont_by_to: Vec<u32> = (0..tt.continuations.len() as u32).collect();
        cont_by_to.sort_by_key(|&i| tt.continuations[i as usize].to);
        Graph { id: NEXT_ID.fetch_add(1, Ordering::Relaxed), st, off, from, w, neg, cont_by_to }
    }

    /// Bytes held (reported by `raptor-query stats`).
    pub(crate) fn heap_bytes(&self) -> usize {
        4 * (self.st.len() + self.off.len() + self.from.len() + self.w.len() + self.cont_by_to.len()) + 16 * self.neg.len()
    }

    fn weight(&self, u: Node, v: Node) -> Secs {
        let r = self.off[v as usize] as usize..self.off[v as usize + 1] as usize;
        match self.from[r.clone()].binary_search(&u) {
            Ok(i) => self.w[r.start + i],
            Err(_) => INF,
        }
    }
}

/// Footpaths between stations, as incoming edges with the least `var_m` and
/// the least `fix_s` over the footpaths between their stops.
struct Walks {
    id: u64,
    /// `Footpaths::to.len()` / `off.len()` when built.
    shape: (usize, usize),
    off: Vec<u32>,
    from: Vec<Node>,
    w: Vec<(u16, u16)>,
}

impl Walks {
    fn new(g: &Graph, fp: &Footpaths) -> Walks {
        let n_stops = g.st.len();
        let mut edges: Vec<(Node, Node, (u16, u16))> = Vec::new();
        for s in 0..fp.off.len().saturating_sub(1).min(n_stops) {
            for e in fp.off[s] as usize..fp.off[s + 1] as usize {
                let t = fp.to[e] as usize;
                if t < n_stops && g.st[s] != g.st[t] {
                    edges.push((g.st[t], g.st[s], (fp.var_m[e], fp.fix_s[e])));
                }
            }
        }
        edges.par_sort_unstable();
        edges.dedup_by(|b, a| {
            if a.0 == b.0 && a.1 == b.1 {
                a.2 = (a.2 .0.min(b.2 .0), a.2 .1.min(b.2 .1));
                true
            } else {
                false
            }
        });
        let (off, from, w) = csr(g.off.len() - 1, &edges);
        Walks { id: g.id, shape: (fp.to.len(), fp.off.len()), off, from, w }
    }

    /// Cached in the footpath set when it is the one the router plans with.
    fn get<'f>(g: &Graph, fp: &'f Footpaths) -> Cow<'f, Walks> {
        let fresh = |w: &Walks| w.id == g.id && w.shape == (fp.to.len(), fp.off.len());
        if let Some(w) = fp.derived.get_or_init(|| Box::new(Walks::new(g, fp))).downcast_ref::<Walks>() {
            if fresh(w) {
                return Cow::Borrowed(w);
            }
        }
        Cow::Owned(Walks::new(g, fp))
    }
}

impl Clone for Walks {
    fn clone(&self) -> Self {
        Walks { id: self.id, shape: self.shape, off: self.off.clone(), from: self.from.clone(), w: self.w.clone() }
    }
}

/// A negative transition: whoever takes it is at `u` no later than `tau`
/// and continues from `v` at `s < tau`.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Neg {
    u: Node,
    tau: Secs,
    v: Node,
    s: Secs,
}

/// What one live snapshot changes in the graph: hops that run faster than
/// scheduled (as extra incoming edges) and its negative transitions.
#[derive(Clone)]
pub(crate) struct LiveFold {
    id: u64,
    off: Vec<u32>,
    from: Vec<Node>,
    w: Vec<Secs>,
    /// Negative transitions, times relative to the service date `.0`.
    neg: Vec<(Date, Neg)>,
}

impl LiveFold {
    /// `None` if the view cannot list its trips.
    fn new(tt: &Timetable, rt: &Router, g: &Graph, live: &dyn LiveView) -> Option<LiveFold> {
        let mut edges: Vec<(Node, Node, Secs)> = Vec::new();
        let mut neg = Vec::new();
        let times = &tt.times;
        let st = |s: StopIdx| g.st[s as usize];
        let row = |t: TripIdx| {
            let pat = &tt.patterns[tt.trips[t as usize].pattern as usize];
            let n = pat.n_stops as usize;
            (pat.times_off as usize + (t - pat.trips_off) as usize * 2 * n, n, pat.stops_off as usize)
        };
        // A seated passage from feeder `a` (date `da`) into `b`: negative when
        // `b` leaves (live) before `a` arrives (live). Every pairing of service
        // dates that `Engine::follow` could make is considered.
        let pair = |a: TripIdx, da: Date, la: Option<&TripLive>, b: TripIdx, neg: &mut Vec<(Date, Neg)>| {
            let (ra, na, sa) = row(a);
            let (rb, nb, sb) = row(b);
            if na == 0 || nb < 2 {
                return;
            }
            let arr_a = times[ra + 2 * (na - 1)];
            let live_arr = arr_a + la.map_or(0, |l| l.arr_delay_at(na - 1));
            for dd in [-1, 0, 1] {
                let gap = times[rb + 1] + dd * DAY - arr_a;
                if !(0..=MAX_CONT_GAP).contains(&gap) {
                    continue;
                }
                let lb = live.trip(da + dd, b);
                let start = (times[rb] + lb.map_or(0, |l| l.arr_delay_at(0))).max(times[rb + 1] + lb.map_or(0, |l| l.dep_delay_at(0)));
                if start + dd * DAY < live_arr {
                    neg.push((da, Neg { u: st(tt.pattern_stops[sa + na - 1]), tau: live_arr, v: st(tt.pattern_stops[sb]), s: start + dd * DAY }));
                }
            }
        };
        let listed = live.for_each_trip(&mut |d, t, l| {
            if t as usize >= tt.trips.len() {
                return;
            }
            let (r, n, so) = row(t);
            let stops = &tt.pattern_stops[so..so + n];
            for i in 0..n.saturating_sub(1) {
                let at = (times[r + 2 * i] + l.arr_delay_at(i)).max(times[r + 2 * i + 1] + l.dep_delay_at(i));
                let next = times[r + 2 * i + 2] + l.arr_delay_at(i + 1);
                let (a, b) = (st(stops[i]), st(stops[i + 1]));
                if next < at {
                    neg.push((d, Neg { u: a, tau: at, v: b, s: next }));
                } else if a != b && next - at < g.weight(a, b) {
                    edges.push((b, a, next - at));
                }
            }
            if rt.trip_has_cont(t) {
                for c in tt.continuations_from(t) {
                    pair(t, d, Some(l), c.to, &mut neg);
                }
            }
            let lo = g.cont_by_to.partition_point(|&i| tt.continuations[i as usize].to < t);
            for &ci in g.cont_by_to[lo..].iter().take_while(|&&i| tt.continuations[i as usize].to == t) {
                let a = tt.continuations[ci as usize].from;
                for dd in [-1, 0, 1] {
                    pair(a, d - dd, live.trip(d - dd, a), t, &mut neg);
                }
            }
        });
        if !listed {
            return None;
        }
        edges.sort_unstable();
        edges.dedup_by(|b, a| a.0 == b.0 && a.1 == b.1);
        neg.sort_unstable();
        neg.dedup();
        let (off, from, w) = csr(g.off.len() - 1, &edges);
        Some(LiveFold { id: g.id, off, from, w, neg })
    }

    /// Cached in the snapshot when it has a slot for it.
    fn get<'l>(tt: &Timetable, rt: &Router, g: &Graph, lv: &'l dyn LiveView) -> Option<Cow<'l, LiveFold>> {
        if let Some(slot) = lv.derived() {
            match slot.get_or_init(|| Box::new(LiveFold::new(tt, rt, g, lv))).downcast_ref::<Option<LiveFold>>() {
                Some(Some(f)) if f.id == g.id => return Some(Cow::Borrowed(f)),
                Some(None) => return None,
                _ => {}
            }
        }
        LiveFold::new(tt, rt, g, lv).map(Cow::Owned)
    }
}

/// Monotone priority queue (radix heap): a pushed key is never below the
/// last key returned by `peek`.
struct Radix {
    last: u32,
    len: usize,
    b: [Vec<(u32, Node)>; 33],
}

impl Default for Radix {
    fn default() -> Self {
        Radix { last: 0, len: 0, b: std::array::from_fn(|_| Vec::new()) }
    }
}

impl Radix {
    fn clear(&mut self) {
        self.last = 0;
        self.len = 0;
        for b in &mut self.b {
            b.clear();
        }
    }
    #[inline]
    fn bucket(&self, k: u32) -> usize {
        32 - (k ^ self.last).leading_zeros() as usize
    }
    #[inline]
    fn push(&mut self, k: u32, v: Node) {
        debug_assert!(k >= self.last);
        let i = self.bucket(k);
        self.b[i].push((k, v));
        self.len += 1;
    }
    /// The smallest key.
    fn peek(&mut self) -> Option<u32> {
        if self.len == 0 {
            return None;
        }
        if self.b[0].is_empty() {
            let i = (1..33).find(|&i| !self.b[i].is_empty()).unwrap();
            let mut items = std::mem::take(&mut self.b[i]);
            self.last = items.iter().map(|x| x.0).min().unwrap();
            for &(k, v) in &items {
                let j = self.bucket(k);
                self.b[j].push((k, v));
            }
            items.clear();
            self.b[i] = items;
        }
        Some(self.last)
    }
    fn pop(&mut self) -> Option<(u32, Node)> {
        self.peek()?;
        self.len -= 1;
        self.b[0].pop()
    }
}

/// Largest-first queue for the `L` search: a radix heap for the values that
/// arrive in order, a binary heap for the few that a fired transition puts
/// above the frontier.
#[derive(Default)]
struct MaxQ {
    radix: Radix,
    extra: std::collections::BinaryHeap<(Secs, Node)>,
}

const L_OFF: Secs = 1 << 30;

impl MaxQ {
    fn clear(&mut self) {
        self.radix.clear();
        self.extra.clear();
    }
    #[inline]
    fn push(&mut self, l: Secs, v: Node) {
        let k = (L_OFF - l) as u32;
        if k >= self.radix.last {
            self.radix.push(k, v);
        } else {
            self.extra.push((l, v));
        }
    }
    fn peek(&mut self) -> Option<Secs> {
        let r = self.radix.peek().map(|k| L_OFF - k as Secs);
        match (r, self.extra.peek()) {
            (Some(a), Some(&(b, _))) => Some(a.max(b)),
            (a, b) => a.or(b.map(|x| x.0)),
        }
    }
    fn pop(&mut self) -> Option<(Secs, Node)> {
        let top = self.peek()?;
        if self.extra.peek().is_some_and(|x| x.0 == top) {
            return self.extra.pop();
        }
        self.radix.pop().map(|(k, v)| (L_OFF - k as Secs, v))
    }
}

/// `L` values below this are dropped (no label is that early).
const L_MIN: Secs = -40 * DAY;
/// The distance search may settle `BUDGET_BASE` nodes, and `BUDGET_PER_CALL`
/// more per bound check (a proxy for the work of the journey search): a
/// query whose labels cannot be pruned does not pay for a search of the
/// whole network. A check beyond the budget answers with the frontier,
/// which is still a valid bound.
const BUDGET_BASE: f64 = 2000.0;
const BUDGET_PER_CALL: f64 = 0.25;
/// With negative transitions, bound checks start after this many calls.
const NEG_GATE: u32 = 16_384;
/// Classify again once the latest target has moved this much earlier.
const RECLASSIFY: Secs = 3600;
/// The `L` search may settle this many times the number of nodes in all.
const L_BUDGET: f64 = 2.0;

/// Reused per-thread arrays of the two searches.
#[derive(Default)]
struct Work {
    stamp: u32,
    /// Distance search: (tentative distance, stamp), settled stamp.
    d: Vec<(Secs, u32)>,
    d_done: Vec<u32>,
    heap: Radix,
    /// Latest-time search for `L`, restarted with its own stamp. `L` can
    /// rise above the frontier when a negative transition fires, so this
    /// one re-opens nodes (`l_done` is cleared when a value rises).
    lst: u32,
    l: Vec<(Secs, u32)>,
    l_done: Vec<u32>,
    l_heap: MaxQ,
    /// `lst` where a node is the head of a negative transition.
    head: Vec<u32>,
}

thread_local! {
    static WORK: RefCell<Option<Box<Work>>> = const { RefCell::new(None) };
}

#[derive(PartialEq, Eq)]
enum State {
    Off,
    Idle,
    Running,
}

/// The bounds of one query, computed on demand.
pub(crate) struct Bounds<'a> {
    state: State,
    rt: &'a Router,
    q: &'a Query<'a>,
    fp: Option<&'a Footpaths>,
    walks: Option<Cow<'a, Walks>>,
    live: Option<Cow<'a, LiveFold>>,
    speed: f32,
    has_neg: bool,
    /// Negative transitions relative to `q.date`, sorted by head `v`, and
    /// which of them are harmful.
    negs: Vec<Neg>,
    harm: Vec<bool>,
    /// By `tau`: `(tau, m, b)` with `m` the least `s` of the transitions
    /// with this `tau` or later and `b` the threshold `after_neg` settles
    /// down to when it starts at `m` (see there).
    by_tau: Vec<(Secs, Secs, Secs)>,
    /// Target time the classification was made for; checks so far.
    cls_best: Secs,
    calls: u32,
    /// Nodes the distance search, and the `L` search, may still settle.
    budget: f64,
    l_budget: i64,
    w: Box<Work>,
}

impl<'a> Bounds<'a> {
    pub(crate) fn new(rt: &'a Router, q: &'a Query<'a>, fp: Option<&'a Footpaths>, speed: f32) -> Self {
        Bounds {
            state: if rt.target_bounds.load(Ordering::Relaxed) { State::Idle } else { State::Off },
            rt,
            q,
            fp,
            walks: None,
            live: None,
            speed,
            has_neg: false,
            negs: Vec::new(),
            harm: Vec::new(),
            by_tau: Vec::new(),
            cls_best: Secs::MIN,
            calls: 0,
            budget: BUDGET_BASE,
            l_budget: (L_BUDGET * rt.tt.stations.len() as f64) as i64,
            w: Box::default(),
        }
    }

    fn start(&mut self) {
        let (rt, q) = (self.rt, self.q);
        let tt: &Timetable = &rt.tt;
        let g = &rt.lbg;
        if let Some(lv) = q.live {
            let Some(fold) = LiveFold::get(tt, rt, g, lv) else {
                self.state = State::Off;
                return;
            };
            self.live = Some(fold);
        }
        self.walks = self.fp.map(|f| Walks::get(g, f));
        let n = g.off.len() - 1;
        let mut w = WORK.with(|c| c.borrow_mut().take()).unwrap_or_default();
        if w.d.len() != n {
            *w = Work { d: vec![(INF, 0); n], d_done: vec![0; n], l: vec![(INF, 0); n], l_done: vec![0; n], head: vec![0; n], ..Default::default() };
        }
        w.stamp = w.stamp.wrapping_add(1);
        if w.stamp == 0 {
            w.d.fill((INF, 0));
            w.d_done.fill(0);
            w.stamp = 1;
        }
        w.heap.clear();
        let st = w.stamp;
        for &(s, secs) in q.egress {
            if (s as usize) < g.st.len() && secs >= 0 {
                let v = g.st[s as usize];
                let e = &mut w.d[v as usize];
                if e.1 != st || secs < e.0 {
                    *e = (secs, st);
                    w.heap.push(secs as u32, v);
                }
            }
        }
        // Negative transitions of the query's service dates, relative to `q.date`.
        let mut negs = std::mem::take(&mut self.negs);
        for &(trip, pos, tau, next) in &g.neg {
            let at = tt.patterns[tt.trips[trip as usize].pattern as usize].stops_off as usize + pos as usize;
            let (u, v) = (g.st[tt.pattern_stops[at] as usize], g.st[tt.pattern_stops[at + 1] as usize]);
            for day in -3..=3 {
                if tt.trip_active(trip, q.date + day) {
                    negs.push(Neg { u, tau: tau + day * DAY, v, s: next + day * DAY });
                }
            }
        }
        if let Some(f) = &self.live {
            for &(d, k) in &f.neg {
                if (d - q.date).abs() <= 5 {
                    let shift = (d - q.date) * DAY;
                    negs.push(Neg { tau: k.tau + shift, s: k.s + shift, ..k });
                }
            }
        }
        self.has_neg = !negs.is_empty();
        negs.sort_unstable_by_key(|k| (k.v, k.s));
        let mut by_tau: Vec<(Secs, Secs, Secs)> = negs.iter().map(|k| (k.tau, k.s, 0)).collect();
        by_tau.sort_unstable();
        for i in (0..by_tau.len().saturating_sub(1)).rev() {
            by_tau[i].1 = by_tau[i].1.min(by_tau[i + 1].1);
        }
        // `m` grows with the index and `m[i] < tau[i]`, so the start `m[i]`
        // lands at an index `j < i`, already done.
        for i in 0..by_tau.len() {
            let m = by_tau[i].1;
            let j = by_tau.partition_point(|x| x.0 < m);
            by_tau[i].2 = if j == by_tau.len() || by_tau[j].1 >= m { m } else { by_tau[j].2 };
        }
        self.by_tau = by_tau;
        self.negs = negs;
        #[cfg(test)]
        WITH_NEG.fetch_add(self.has_neg as u64, Ordering::Relaxed);
        self.w = w;
        self.state = State::Running;
    }

    /// Can a label at `s` at time `t` be dropped because it cannot lead to an
    /// arrival before `best`? `all`: the targets of every round.
    #[inline]
    pub(crate) fn prune(&mut self, s: StopIdx, t: Secs, best: Secs, all: &[Secs]) -> bool {
        if self.state == State::Off {
            return false;
        }
        self.budget += BUDGET_PER_CALL;
        self.calls = self.calls.saturating_add(1);
        if best == INF {
            return false;
        }
        self.prune_slow(s, t, best, all)
    }

    fn prune_slow(&mut self, s: StopIdx, t: Secs, best: Secs, all: &[Secs]) -> bool {
        if self.state == State::Idle {
            self.start();
            if self.state == State::Off {
                return false;
            }
        }
        let v = self.rt.lbg.st[s as usize];
        if self.has_neg {
            // Classifying costs about two searches of the whole network:
            // not worth it for a short query, which runs without bounds.
            if self.calls < NEG_GATE {
                return false;
            }
            // Classified for the latest target of any round; again once
            // that has moved well (fewer transitions are harmful).
            let top = all.iter().copied().filter(|&x| x != INF).max().unwrap_or(best);
            if top > self.cls_best.saturating_add(RECLASSIFY) || top.saturating_add(RECLASSIFY) < self.cls_best {
                self.classify(top);
            }
            if best > self.cls_best {
                return false;
            }
        }
        let need = best.saturating_sub(t);
        if self.lb(v, need) < need {
            return false;
        }
        if self.has_neg && !self.after_neg(v, t) {
            return false;
        }
        #[cfg(feature = "stats")]
        crate::plan::stats::add(19, 1);
        #[cfg(test)]
        PRUNED.fetch_add(1, Ordering::Relaxed);
        true
    }

    /// A lower bound on the distance from `v`: exact, or at least `need`,
    /// or the frontier once the budget is spent. (`v == Node::MAX`: just
    /// search up to `need`.)
    #[inline]
    fn lb(&mut self, v: Node, need: Secs) -> Secs {
        if (v as usize) < self.w.d.len() && self.w.d_done[v as usize] == self.w.stamp {
            return self.w.d[v as usize].0;
        }
        self.lb_slow(v, need)
    }

    fn lb_slow(&mut self, v: Node, need: Secs) -> Secs {
        let st = self.w.stamp;
        #[cfg(feature = "stats")]
        let t0 = std::time::Instant::now();
        let r = loop {
            if (v as usize) < self.w.d.len() && self.w.d_done[v as usize] == st {
                break self.w.d[v as usize].0;
            }
            let Some(k) = self.w.heap.peek() else { break INF };
            let k = k as Secs;
            if k >= need || self.budget < 0.0 {
                break k;
            }
            self.budget -= 1.0;
            let x = self.w.heap.pop().unwrap().1;
            if self.w.d_done[x as usize] == st || self.w.d[x as usize].0 != k {
                continue;
            }
            self.w.d_done[x as usize] = st;
            #[cfg(feature = "stats")]
            crate::plan::stats::add(20, 1);
            let w = &mut *self.w;
            for_each_in(self.rt, self.live.as_deref(), self.walks.as_deref(), self.speed, self.q.max_walk, x, |u, c| {
                let nd = k.saturating_add(c);
                let e = &mut w.d[u as usize];
                if nd != INF && (e.1 != st || nd < e.0) {
                    *e = (nd, st);
                    w.heap.push(nd as u32, u);
                }
            });
        };
        #[cfg(feature = "stats")]
        crate::plan::stats::add(21, t0.elapsed().as_nanos() as u64);
        r
    }

    /// Which negative transitions can still lead to an arrival before
    /// `best` (*harmful*): those with `s + dist(v) < best`, and those from
    /// which a harmful one can be reached (`s ≤ L(v)`). The `L` search from
    /// the first kind finds the second as it goes: a transition fires
    /// (becomes a source at `u` with `tau`) once its head has `L(v) ≥ s`.
    fn classify(&mut self, best: Secs) {
        #[cfg(feature = "stats")]
        crate::plan::stats::add(22, 1);
        self.cls_best = best;
        // Labels before `q.from` exist only after a negative transition;
        // transitions that early count as harmful without looking further.
        let cutoff = self.q.from.saturating_sub(1800);
        // Distances exact wherever `s + dist(v) < best` is possible (within budget).
        self.lb(Node::MAX, best.saturating_sub(cutoff));
        let (st, front) = (self.w.stamp, self.w.heap.peek().map_or(INF, |k| k as Secs));
        let mut harm = std::mem::take(&mut self.harm);
        harm.clear();
        {
            let w = &*self.w;
            harm.extend(self.negs.iter().map(|k| {
                let d = if w.d_done[k.v as usize] == st { w.d[k.v as usize].0 } else { front };
                k.s < cutoff || k.s.saturating_add(d) < best
            }));
        }
        let w = &mut *self.w;
        w.lst = w.lst.wrapping_add(1);
        if w.lst == 0 {
            w.l.fill((INF, 0));
            w.l_done.fill(0);
            w.head.fill(0);
            w.lst = 1;
        }
        w.l_heap.clear();
        let lst = w.lst;
        for (k, &h) in self.negs.iter().zip(&harm) {
            w.head[k.v as usize] = lst;
            if h {
                raise(w, k.u, k.tau);
            }
        }
        self.harm = harm;
    }

    /// Is `t > L(v)`: can a label at `v` at `t` not reach any harmful
    /// negative transition? Settles the `L` search below a time `b ≤ t`
    /// such that every transition with `tau ≥ b` has `s ≥ b`: those are
    /// then decided, and whatever fires later only raises values below `b`
    /// (and so fires nothing with `tau ≥ b`).
    fn after_neg(&mut self, v: Node, t: Secs) -> bool {
        let st = self.w.lst;
        let i = self.by_tau.partition_point(|x| x.0 < t);
        let below = match self.by_tau.get(i) {
            Some(&(_, m, b)) if m < t => b,
            _ => t,
        };
        loop {
            let e = self.w.l[v as usize];
            if e.1 == st && e.0 >= t {
                return false;
            }
            match self.w.l_heap.peek() {
                Some(k) if k >= below => {}
                _ => return true,
            }
            let (k, x) = self.w.l_heap.pop().unwrap();
            if self.w.l_done[x as usize] == st || self.w.l[x as usize] != (k, st) {
                continue;
            }
            self.w.l_done[x as usize] = st;
            #[cfg(feature = "stats")]
            crate::plan::stats::add(23, 1);
            self.l_budget -= 1;
            if self.l_budget < 0 {
                // Too many transitions run backwards for the bounds to pay off.
                self.state = State::Off;
                return false;
            }
            let w = &mut *self.w;
            if w.head[x as usize] == st {
                // Transitions from `x` that can be taken in time fire.
                let lo = self.negs.partition_point(|n| n.v < x);
                for i in lo..self.negs.len() {
                    let n = self.negs[i];
                    if n.v != x || n.s > k {
                        break;
                    }
                    if !self.harm[i] {
                        self.harm[i] = true;
                        raise(w, n.u, n.tau);
                    }
                }
            }
            for_each_in(self.rt, self.live.as_deref(), self.walks.as_deref(), self.speed, self.q.max_walk, x, |u, c| {
                let nl = k.saturating_sub(c);
                if nl > L_MIN {
                    raise(w, u, nl);
                }
            });
        }
    }
}

/// `L(u) ≥ l`: raise it (re-opening `u`) if that is more.
#[inline]
fn raise(w: &mut Work, u: Node, l: Secs) {
    let st = w.lst;
    let e = &mut w.l[u as usize];
    if e.1 != st || l > e.0 {
        *e = (l, st);
        w.l_done[u as usize] = 0;
        w.l_heap.push(l, u);
    }
}

impl Drop for Bounds<'_> {
    fn drop(&mut self) {
        if self.state != State::Idle {
            let w = std::mem::take(&mut self.w);
            if !w.d.is_empty() {
                WORK.with(|c| *c.borrow_mut() = Some(w));
            }
        }
    }
}

/// Every edge `u → v` of the graph with its weight.
#[inline]
fn for_each_in(rt: &Router, live: Option<&LiveFold>, walks: Option<&Walks>, speed: f32, max_walk: Secs, v: Node, mut f: impl FnMut(Node, Secs)) {
    let g = &rt.lbg;
    let vi = v as usize;
    for e in g.off[vi] as usize..g.off[vi + 1] as usize {
        f(g.from[e], g.w[e]);
    }
    if let Some(l) = live {
        for e in l.off[vi] as usize..l.off[vi + 1] as usize {
            f(l.from[e], l.w[e]);
        }
    }
    if let Some(wk) = walks {
        for e in wk.off[vi] as usize..wk.off[vi + 1] as usize {
            let (var, fix) = wk.w[e];
            let w = walk_secs(var as f32, fix as f32, speed).ceil() as Secs;
            if w <= max_walk {
                f(wk.from[e], w);
            }
        }
    }
}

/// Test hooks: how often a label was pruned, and how many queries saw negative transitions.
#[cfg(test)]
pub(crate) static PRUNED: AtomicU64 = AtomicU64::new(0);
#[cfg(test)]
pub(crate) static WITH_NEG: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
mod tests {
    //! Differential test: the journeys must not depend on the bounds.
    use super::{PRUNED, WITH_NEG};
    use crate::testutil::*;
    use crate::*;
    use kante_core::time::{Date, Secs};
    use kante_core::*;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

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

    /// A random network with some long lines, round-the-clock patterns and
    /// in-seat continuations (to the same and to other stops).
    fn world(seed: u64) -> (Router, Vec<Footpaths>) {
        let mut rng = Rng(seed * 6364136223846793005 + 11);
        let mut b = Builder::new();
        let n_stops = rng.range(15, 70) as usize;
        let stops: Vec<_> = (0..n_stops).map(|i| b.stop_at(&format!("S{i}"), rng.below(6000) as f32, rng.below(6000) as f32)).collect();
        let lines = [b.line("bus", Mode::Bus), b.line("rail", Mode::Rail), b.line("tram", Mode::Tram)];
        let alt = [b.service(&[0, 1, 2, 4, 5, 6, 7]), b.service(&[3, 4, 5]), b.service(&[2, 3])];
        // (declaration id, pattern stops, times) of every trip, for continuations.
        let mut decl: Vec<(usize, Vec<StopIdx>, Vec<(Secs, Secs)>)> = Vec::new();
        for _ in 0..rng.range(10, 40) {
            let len = rng.range(2, 10) as usize;
            let mut seq = Vec::new();
            while seq.len() < len {
                let s = stops[rng.below(n_stops as u64) as usize];
                if !seq.contains(&s) {
                    seq.push(s);
                }
            }
            let flags: Vec<u8> = (0..len)
                .map(|_| match rng.below(14) {
                    0 => FLAG_NO_PICKUP,
                    1 => FLAG_NO_DROPOFF,
                    _ => 0,
                })
                .collect();
            let p = b.pattern_flags(lines[rng.below(3) as usize], &seq, &flags);
            let mut offs = vec![(0, rng.range(0, 1) * 60)];
            for i in 1..len {
                let arr = offs[i - 1].1 + rng.range(1, 25) * 60;
                offs.push((arr, arr + rng.range(0, 3) * 30));
            }
            let mut t = rng.range(3 * 60, 9 * 60) * 60;
            let headway = rng.range(5, 70) * 60;
            let until = if rng.below(4) == 0 { rng.range(28, 34) } else { rng.range(18, 27) } * 3600;
            // Express variants: some trips of the pattern run faster.
            let fast = rng.below(3) == 0;
            while t < until {
                let service = if rng.below(4) == 0 { alt[rng.below(3) as usize] } else { 0 };
                let f = if fast && rng.below(3) == 0 { 0.7 } else { 1.0 };
                let times: Vec<_> = offs.iter().map(|&(a, d)| (t + (a as f32 * f) as Secs, t + (d as f32 * f) as Secs)).collect();
                let id = b.trip_on(p, service, &times);
                decl.push((id, seq.clone(), times));
                t += headway;
            }
        }
        // Continuations: trip A → a trip B leaving within 0..3 h of A's arrival.
        for _ in 0..decl.len() / 4 {
            let a = rng.below(decl.len() as u64) as usize;
            let arr = decl[a].2.last().unwrap().0;
            let cands: Vec<usize> = (0..decl.len()).filter(|&j| j != a && (0..=3 * 3600).contains(&(decl[j].2[0].1 - arr))).collect();
            if cands.is_empty() {
                continue;
            }
            // Prefer B starting where A ends (a real through-running vehicle).
            let same: Vec<usize> = cands.iter().copied().filter(|&j| decl[j].1[0] == *decl[a].1.last().unwrap()).collect();
            let pick = if !same.is_empty() && rng.below(3) > 0 { same[rng.below(same.len() as u64) as usize] } else { cands[rng.below(cands.len() as u64) as usize] };
            let service = if rng.below(5) == 0 { alt[rng.below(3) as usize] } else { NONE };
            b.continuation(decl[a].0, decl[pick].0, service);
        }
        let built = b.build();
        let tt = built.tt;
        let n = tt.stops.len();
        // Footpath sets: symmetric crow-fly ones, and a one-way list with stairs-like fixed costs.
        let crow = crowfly_footpaths(&tt, rng.range(300, 1500) as f32, 1.3);
        let mut list = Vec::new();
        for _ in 0..n * 2 {
            let (x, y) = (rng.below(n as u64) as StopIdx, rng.below(n as u64) as StopIdx);
            if x != y && !list.iter().any(|&(a, b, _, _)| a == x && b == y) {
                list.push((x, y, rng.range(0, 900) as u16, rng.range(0, 120) as u16));
            }
        }
        let oneway = footpaths(n, &list);
        (Router::new(Arc::new(tt)), vec![crow, oneway, footpaths(n, &[])])
    }

    /// Delays of every kind: late, early, catching up, falling behind,
    /// skipped stops, cancellations, and times that run backwards.
    fn overlay(tt: &Timetable, rng: &mut Rng, date: Date) -> TestLive {
        let mut live = TestLive::default();
        for t in 0..tt.trips.len() as TripIdx {
            let n = tt.pattern_stops(tt.trips[t as usize].pattern).len();
            for d in date - 1..=date + 1 {
                let r = rng.below(12);
                if r >= 6 {
                    continue;
                }
                let l = live.map.entry((d, t)).or_default();
                l.observed_pos = -1;
                match r {
                    0 => l.cancelled = true,
                    1 => {
                        l.skipped = vec![false; n];
                        l.skipped[rng.below(n as u64) as usize] = true;
                    }
                    _ => {
                        // A random walk of delays, sometimes negative, sometimes
                        // shrinking fast enough that arrivals precede departures.
                        let mut x = rng.range(-5, 25) * 60;
                        for _ in 0..n {
                            let a = x;
                            x += rng.range(-8, 6) * 60;
                            l.arr_delay.push(a);
                            l.dep_delay.push(if rng.below(6) == 0 { a - 300 } else { a.max(x) });
                        }
                    }
                }
            }
        }
        live
    }

    fn query<'a>(rng: &mut Rng, tt: &Timetable, fp: &'a Footpaths, acc: &'a mut Vec<(StopIdx, Secs)>, egr: &'a mut Vec<(StopIdx, Secs)>, date: Date) -> Query<'a> {
        let n = tt.stops.len() as u64;
        for _ in 0..rng.range(1, 3) {
            acc.push((rng.below(n) as StopIdx, rng.range(0, 8) * 45));
        }
        for _ in 0..rng.range(1, 3) {
            egr.push((rng.below(n) as StopIdx, rng.range(0, 10) * 45));
        }
        let from = match rng.below(4) {
            0 => rng.range(0, 3 * 3600),
            1 => rng.range(21 * 3600, 25 * 3600),
            _ => rng.range(5 * 3600, 21 * 3600),
        };
        let mut q = Query::new(date, from, acc, egr, fp);
        q.window = [0, 0, 1800, 3600, 7200][rng.below(5) as usize];
        q.max_transfers = rng.range(0, 6) as u8;
        q.transfer_margin = rng.range(0, 4) * 60;
        q.walk_speed = [0.8, 1.3, 1.8][rng.below(3) as usize];
        q.max_walk = [200, 600, 900, 3000][rng.below(4) as usize];
        if rng.below(6) == 0 {
            q.modes = Mode::Bus.bit() | Mode::Rail.bit();
        }
        q
    }

    fn same(rt: &Router, q: &Query, what: &str) -> usize {
        rt.set_target_bounds(false);
        let off = rt.plan(q);
        rt.set_target_bounds(true);
        let on = rt.plan(q);
        assert_eq!(on, off, "{what}: bounds change the result");
        on.len()
    }

    /// Two ways from O to D: an early departure at 07:30 by C (O → W) and A
    /// (W → …), and a later direct bus at 07:45 that arrives at `bus_arr`.
    /// The bus sets the target first; the 07:30 journey is only found if the
    /// bound at W does not over-estimate. Returns (router, trips by name).
    fn two_ways(bus_arr: Secs, build: impl FnOnce(&mut Builder, StopIdx, StopIdx) -> Vec<usize>) -> (Router, Vec<TripIdx>, StopIdx, StopIdx) {
        let mut b = Builder::new();
        let (o, w, d) = (b.stop("O"), b.stop("W"), b.stop("D"));
        let bus = b.line("bus", Mode::Bus);
        let pc = b.pattern(bus, &[o, w]);
        b.trip(pc, &[hm(7, 30), hm(7, 40)]);
        let pb = b.pattern(bus, &[o, d]);
        b.trip(pb, &[hm(7, 45), bus_arr]);
        let ids = build(&mut b, w, d);
        let built = b.build();
        let trips = ids.iter().map(|&i| built.trips[i]).collect();
        (Router::new(Arc::new(built.tt)), trips, o, d)
    }

    /// Plan O → D leaving 07:25–07:55 with and without bounds; the 07:30
    /// departure must arrive at `arr`.
    fn check_two_ways(rt: &Router, o: StopIdx, d: StopIdx, live: Option<&dyn LiveView>, arr: Secs) {
        let fp = footpaths(rt.timetable().stops.len(), &[]);
        let (acc, egr) = ([(o, 0)], [(d, 0)]);
        let mut q = Query::new(D0 + 3, hm(7, 25), &acc, &egr, &fp);
        q.window = 1800;
        q.live = live;
        same(rt, &q, "two ways");
        let js = rt.plan(&q);
        assert!(js.iter().any(|j| j.dep == hm(7, 30) && j.arr == arr), "07:30 journey missing: {js:#?}");
    }

    #[test]
    fn continuation_to_another_stop() {
        // A: W 07:45 → Y 07:50, continues as B: Z 07:50 → D 07:55. Y and Z are far apart.
        let (rt, _, o, d) = two_ways(hm(7, 58), |b, w, d| {
            let (y, z) = (b.stop("Y"), b.stop("Z"));
            let rail = b.line("rail", Mode::Rail);
            let pa = b.pattern(rail, &[w, y]);
            let a = b.trip(pa, &[hm(7, 45), hm(7, 50)]);
            let pb = b.pattern(rail, &[z, d]);
            let c = b.trip(pb, &[hm(7, 50), hm(7, 55)]);
            b.continuation(a, c, NONE);
            vec![a, c]
        });
        check_two_ways(&rt, o, d, None, hm(7, 55));
    }

    #[test]
    fn dwell_before_departure() {
        // A: P 07:30 → W arr 07:40 dep 07:50 → D 08:00: boarding at W costs 10 min, not 20.
        let (rt, _, o, d) = two_ways(hm(8, 1), |b, w, d| {
            let p = b.stop("P");
            let rail = b.line("rail", Mode::Rail);
            let pa = b.pattern(rail, &[p, w, d]);
            vec![b.trip_on(pa, 0, &[(hm(7, 30), hm(7, 30)), (hm(7, 40), hm(7, 50)), (hm(8, 0), hm(8, 0))])]
        });
        check_two_ways(&rt, o, d, None, hm(8, 0));
    }

    #[test]
    fn live_hop_faster_than_scheduled() {
        // A: W 07:40 → D 08:00 scheduled, live 07:45 → 07:55 (left late, arrives early).
        let (rt, trips, o, d) = two_ways(hm(8, 0), |b, w, d| {
            let rail = b.line("rail", Mode::Rail);
            let pa = b.pattern(rail, &[w, d]);
            vec![b.trip(pa, &[hm(7, 40), hm(8, 0)])]
        });
        let mut live = TestLive::default();
        let l = live.map.entry((D0 + 3, trips[0])).or_default();
        (l.arr_delay, l.dep_delay, l.observed_pos) = (vec![300, -300], vec![300, -300], -1);
        check_two_ways(&rt, o, d, Some(&live), hm(7, 55));
        // A view that cannot list its trips: no bounds, same result.
        struct Opaque<'a>(&'a TestLive);
        impl LiveView for Opaque<'_> {
            fn trip(&self, date: Date, trip: TripIdx) -> Option<&TripLive> {
                self.0.trip(date, trip)
            }
            fn max_delay(&self) -> Secs {
                self.0.max_delay()
            }
        }
        check_two_ways(&rt, o, d, Some(&Opaque(&live)), hm(7, 55));
    }

    #[test]
    fn live_continuation_running_backwards() {
        // A: W 07:30 → Y 07:40, continues as B: Y 07:45 → D 07:53. A runs 20 min
        // late (W 07:50, Y 08:00), B on time: the search stays seated and
        // "arrives" at 07:53, earlier than A reached Y.
        let (rt, trips, o, d) = two_ways(hm(7, 58), |b, w, d| {
            let y = b.stop("Y");
            let rail = b.line("rail", Mode::Rail);
            let pa = b.pattern(rail, &[w, y]);
            let a = b.trip(pa, &[hm(7, 30), hm(7, 40)]);
            let pb = b.pattern(rail, &[y, d]);
            let c = b.trip(pb, &[hm(7, 45), hm(7, 53)]);
            b.continuation(a, c, NONE);
            vec![a, c]
        });
        let mut live = TestLive::default();
        live.delay(D0 + 3, trips[0], 2, 0, 1200);
        check_two_ways(&rt, o, d, Some(&live), hm(7, 53));
    }

    #[test]
    fn live_hop_running_backwards() {
        // A: W 07:30 → D 07:40 scheduled; live it leaves at 07:50 and "arrives" at 07:45.
        let (rt, trips, o, d) = two_ways(hm(7, 48), |b, w, d| {
            let rail = b.line("rail", Mode::Rail);
            let pa = b.pattern(rail, &[w, d]);
            vec![b.trip(pa, &[hm(7, 30), hm(7, 40)])]
        });
        let mut live = TestLive::default();
        let l = live.map.entry((D0 + 3, trips[0])).or_default();
        (l.arr_delay, l.dep_delay, l.observed_pos) = (vec![1200, 300], vec![1200, 300], -1);
        check_two_ways(&rt, o, d, Some(&live), hm(7, 45));
    }

    #[test]
    fn bounds_do_not_change_results() {
        let before = PRUNED.load(Ordering::Relaxed);
        let (mut journeys, mut queries) = (0, 0);
        for seed in 1..=200 {
            let (rt, fps) = world(seed);
            let tt = rt.timetable().clone();
            let mut rng = Rng(seed * 7919 + 1);
            let date = D0 + rng.range(2, 6);
            let live = overlay(&tt, &mut rng, date);
            for i in 0..30 {
                let fp = &fps[rng.below(fps.len() as u64) as usize];
                let (mut acc, mut egr) = (Vec::new(), Vec::new());
                let mut q = query(&mut rng, &tt, fp, &mut acc, &mut egr, date);
                let what = format!("seed {seed} query {i}");
                if rng.below(2) == 0 {
                    q.live = Some(&live);
                }
                if rng.below(5) == 0 {
                    // On board a trip of the query date or a neighbouring one.
                    let trip = rng.below(tt.trips.len() as u64) as TripIdx;
                    let n = tt.pattern_stops(tt.trips[trip as usize].pattern).len();
                    q.onboard = Some(Onboard { trip, date: date + rng.range(-1, 1), next_pos: rng.range(1, n as i32 - 1) as u16 });
                    q.from = tt.arr(trip, 0) + (q.onboard.unwrap().date - date) * time::DAY + rng.range(0, 30) * 60;
                }
                journeys += same(&rt, &q, &what);
                queries += 1;
            }
        }
        let pruned = PRUNED.load(Ordering::Relaxed) - before;
        println!("{queries} queries, {journeys} journeys, {pruned} labels pruned by the bounds, {} queries with negative transitions", WITH_NEG.load(Ordering::Relaxed));
        assert!(journeys > 3000, "too few journeys to mean anything: {journeys}");
        assert!(pruned > 10_000, "the bounds hardly prune: {pruned}");
        assert!(WITH_NEG.load(Ordering::Relaxed) > 100, "no live data with times running backwards");
    }
}
