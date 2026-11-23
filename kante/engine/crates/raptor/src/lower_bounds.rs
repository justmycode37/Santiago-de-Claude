//! Lower bounds on the time still needed to reach the destination, for
//! target pruning in the journey search (`plan.rs`): a label at stop `s` at
//! time `t` is dropped when `t + lb(s) ≥ best`, `best` being the best
//! arrival found so far with that many rides. Without them the search only
//! knows `min_egress` and explores everything it reaches before `best`.
//!
//! # The bound
//!
//! `lb(s)` is the distance from the station of `s` to the destination in a
//! *minimum travel time* graph over stations, with the egress times as
//! sources. Its edges, each a lower bound on what the search can spend
//! between stops of the two stations:
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
//!   over the footpaths between their stops at the query's speed, left out
//!   above `max_walk` as the search does. Cached per footpath set.
//! - **live hops**: per snapshot, every live trip's hop with its live times
//!   where that is shorter than the scheduled minimum ([`LiveFold`]): a trip
//!   that left late and makes up time is covered.
//!
//! Moving between stops of one station costs 0. Transfer margins, waiting,
//! mode filters and the walk profile only add time. Being *at* a stop covers
//! both label kinds: a `ride` label leaves it by egress, a change or a
//! footpath, a `ready` label by boarding; either way the rest of the journey
//! is a path of the graph, so `t + lb(s)` never exceeds its arrival.
//!
//! **Times that run backwards.** With live data the search can step back in
//! time: it stays seated into a continuation the feed has no delay for, at
//! its scheduled times, which can be before the late feeder arrived; or a
//! trip's live times decrease from one stop to the next. Such a step has
//! negative length, so no bound of this kind covers a journey that takes
//! one: those count as 0 here, and a journey that relies on one may be
//! pruned. Every other journey is unaffected.
//!
//! # Cost
//!
//! The distance search is a backward Dijkstra over incoming edges (radix
//! heap) and runs lazily: a check settles nodes only until it is decided,
//! the frontier of the unfinished search being itself a valid bound. Nothing
//! is done before the first journey is found, and the search may settle only
//! `BUDGET_BASE + BUDGET_PER_CALL` × (checks so far) nodes, so a query
//! whose labels cannot be pruned does not pay for a search of the whole
//! network.

use crate::{Query, Router};
use kante_core::time::Secs;
use kante_core::{walk_secs, Footpaths, LiveView, StopIdx, Timetable, TripIdx};
use rayon::prelude::*;
use std::borrow::Cow;
use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};

const INF: Secs = Secs::MAX;
/// Graph nodes are stations.
type Node = u32;

/// The distance search may settle `BUDGET_BASE` nodes, and `BUDGET_PER_CALL`
/// more per bound check (a proxy for the work of the journey search).
const BUDGET_BASE: f64 = 2000.0;
const BUDGET_PER_CALL: f64 = 1.0;

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
}

/// CSR of incoming edges `(from, weight)` per node, from sorted `(to, from, weight)`.
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
        let mut edges: Vec<(Node, Node, Secs)> = (0..tt.patterns.len())
            .into_par_iter()
            .flat_map_iter(|p| {
                let pat = &tt.patterns[p];
                let n = pat.n_stops as usize;
                let stops = &tt.pattern_stops[pat.stops_off as usize..pat.stops_off as usize + n];
                let mut w = vec![INF; n.saturating_sub(1)];
                for t in 0..pat.n_trips as usize {
                    let row = &tt.times[pat.times_off as usize + t * 2 * n..][..2 * n];
                    for i in 0..n.saturating_sub(1) {
                        w[i] = w[i].min((row[2 * i + 2] - row[2 * i].max(row[2 * i + 1])).max(0));
                    }
                }
                let st = &st;
                (0..n.saturating_sub(1)).filter(move |&i| pat.n_trips > 0 && st[stops[i] as usize] != st[stops[i + 1] as usize]).map(move |i| (st[stops[i + 1] as usize], st[stops[i] as usize], w[i]))
            })
            .collect();
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
        let (off, from, w) = csr(tt.stations.len(), &edges);
        Graph { id: NEXT_ID.fetch_add(1, Ordering::Relaxed), st, off, from, w }
    }

    fn nodes(&self) -> usize {
        self.off.len() - 1
    }

    /// Bytes held (reported by `raptor-query stats`).
    pub(crate) fn heap_bytes(&self) -> usize {
        4 * (self.st.len() + self.off.len() + self.from.len() + self.w.len())
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
#[derive(Clone)]
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
            let same = a.0 == b.0 && a.1 == b.1;
            if same {
                a.2 = (a.2 .0.min(b.2 .0), a.2 .1.min(b.2 .1));
            }
            same
        });
        let (off, from, w) = csr(g.nodes(), &edges);
        Walks { id: g.id, shape: (fp.to.len(), fp.off.len()), off, from, w }
    }

    /// Cached in the footpath set (built by the first query that uses it).
    fn get<'f>(g: &Graph, fp: &'f Footpaths) -> Cow<'f, Walks> {
        let fresh = |w: &Walks| w.id == g.id && w.shape == (fp.to.len(), fp.off.len());
        match fp.derived.get_or_init(|| Box::new(Walks::new(g, fp))).downcast_ref::<Walks>() {
            Some(w) if fresh(w) => Cow::Borrowed(w),
            _ => Cow::Owned(Walks::new(g, fp)),
        }
    }
}

/// Live hops shorter than the scheduled minimum, as extra incoming edges.
#[derive(Clone)]
pub(crate) struct LiveFold {
    id: u64,
    off: Vec<u32>,
    from: Vec<Node>,
    w: Vec<Secs>,
}

impl LiveFold {
    /// `None` if the view cannot list its trips.
    fn new(tt: &Timetable, g: &Graph, live: &dyn LiveView) -> Option<LiveFold> {
        let mut edges: Vec<(Node, Node, Secs)> = Vec::new();
        let listed = live.for_each_trip(&mut |_, t: TripIdx, l| {
            let Some(trip) = tt.trips.get(t as usize) else { return };
            let pat = &tt.patterns[trip.pattern as usize];
            let n = pat.n_stops as usize;
            let row = &tt.times[pat.times_off as usize + (t - pat.trips_off) as usize * 2 * n..][..2 * n];
            let stops = &tt.pattern_stops[pat.stops_off as usize..][..n];
            for i in 0..n.saturating_sub(1) {
                let at = (row[2 * i] + l.arr_delay_at(i)).max(row[2 * i + 1] + l.dep_delay_at(i));
                let h = (row[2 * i + 2] + l.arr_delay_at(i + 1) - at).max(0);
                let (a, b) = (g.st[stops[i] as usize], g.st[stops[i + 1] as usize]);
                if a != b && h < g.weight(a, b) {
                    edges.push((b, a, h));
                }
            }
        });
        if !listed {
            return None;
        }
        edges.sort_unstable();
        edges.dedup_by(|b, a| a.0 == b.0 && a.1 == b.1);
        let (off, from, w) = csr(g.nodes(), &edges);
        Some(LiveFold { id: g.id, off, from, w })
    }

    /// Cached in the snapshot when it has a slot for it.
    fn get<'l>(tt: &Timetable, g: &Graph, lv: &'l dyn LiveView) -> Option<Cow<'l, LiveFold>> {
        if let Some(slot) = lv.derived() {
            match slot.get_or_init(|| Box::new(LiveFold::new(tt, g, lv))).downcast_ref::<Option<LiveFold>>() {
                Some(Some(f)) if f.id == g.id => return Some(Cow::Borrowed(f)),
                Some(None) => return None,
                _ => {}
            }
        }
        LiveFold::new(tt, g, lv).map(Cow::Owned)
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

/// Per-thread arrays of the distance search, reused across queries.
#[derive(Default)]
struct Work {
    stamp: u32,
    /// (tentative distance, stamp) and settled stamp per node.
    d: Vec<(Secs, u32)>,
    done: Vec<u32>,
    heap: Radix,
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

/// The lower bounds of one query, computed on demand.
pub(crate) struct TargetBounds<'a> {
    state: State,
    rt: &'a Router,
    q: &'a Query<'a>,
    live: Option<&'a dyn LiveView>,
    fp: Option<&'a Footpaths>,
    walks: Option<Cow<'a, Walks>>,
    fold: Option<Cow<'a, LiveFold>>,
    speed: f32,
    /// Nodes the distance search may still settle.
    budget: f64,
    w: Option<Box<Work>>,
}

impl<'a> TargetBounds<'a> {
    /// `live` and `fp`: what the search uses (`None` when it plans without).
    pub(crate) fn new(rt: &'a Router, q: &'a Query<'a>, live: Option<&'a dyn LiveView>, fp: Option<&'a Footpaths>, speed: f32) -> Self {
        let on = rt.target_bounds.load(Ordering::Relaxed);
        TargetBounds { state: if on { State::Idle } else { State::Off }, rt, q, live, fp, walks: None, fold: None, speed, budget: BUDGET_BASE, w: None }
    }

    fn start(&mut self) {
        let g = &self.rt.lb_graph;
        if let Some(lv) = self.live {
            let Some(fold) = LiveFold::get(&self.rt.tt, g, lv) else {
                self.state = State::Off;
                return;
            };
            self.fold = Some(fold);
        }
        self.walks = self.fp.map(|f| Walks::get(g, f));
        let n = g.nodes();
        let mut w = WORK.with(|c| c.borrow_mut().take()).unwrap_or_default();
        if w.d.len() != n {
            *w = Work { d: vec![(INF, 0); n], done: vec![0; n], ..Default::default() };
        }
        w.stamp = w.stamp.wrapping_add(1);
        if w.stamp == 0 {
            w.d.fill((INF, 0));
            w.done.fill(0);
            w.stamp = 1;
        }
        w.heap.clear();
        let st = w.stamp;
        for &(s, secs) in self.q.egress {
            if (s as usize) < g.st.len() && secs >= 0 {
                let v = g.st[s as usize];
                let e = &mut w.d[v as usize];
                if e.1 != st || secs < e.0 {
                    *e = (secs, st);
                    w.heap.push(secs as u32, v);
                }
            }
        }
        self.w = Some(w);
        self.state = State::Running;
    }

    /// Can a label at `s` at time `t` be dropped because it cannot lead to an
    /// arrival before `best`?
    #[inline]
    pub(crate) fn prune(&mut self, s: StopIdx, t: Secs, best: Secs) -> bool {
        if self.state == State::Off {
            return false;
        }
        self.budget += BUDGET_PER_CALL;
        best != INF && self.prune_slow(s, t, best)
    }

    fn prune_slow(&mut self, s: StopIdx, t: Secs, best: Secs) -> bool {
        if self.state == State::Idle {
            self.start();
            if self.state == State::Off {
                return false;
            }
        }
        let need = best.saturating_sub(t);
        if self.lb(self.rt.lb_graph.st[s as usize], need) < need {
            return false;
        }
        #[cfg(feature = "stats")]
        crate::plan::stats::add(19, 1);
        #[cfg(test)]
        PRUNED.fetch_add(1, Ordering::Relaxed);
        true
    }

    /// A lower bound on the distance from `v`: exact, or at least `need`, or
    /// the frontier once the budget is spent.
    fn lb(&mut self, v: Node, need: Secs) -> Secs {
        let (rt, walks, fold, speed, max_walk) = (self.rt, self.walks.as_deref(), self.fold.as_deref(), self.speed, self.q.max_walk);
        let w = self.w.as_deref_mut().unwrap();
        let st = w.stamp;
        if w.done[v as usize] == st {
            return w.d[v as usize].0;
        }
        #[cfg(feature = "stats")]
        let t0 = std::time::Instant::now();
        let r = loop {
            if w.done[v as usize] == st {
                break w.d[v as usize].0;
            }
            let Some(k) = w.heap.peek() else { break INF };
            let k = k as Secs;
            if k >= need || self.budget < 0.0 {
                break k;
            }
            self.budget -= 1.0;
            let x = w.heap.pop().unwrap().1;
            if w.done[x as usize] == st || w.d[x as usize].0 != k {
                continue;
            }
            w.done[x as usize] = st;
            #[cfg(feature = "stats")]
            crate::plan::stats::add(20, 1);
            let (d, heap) = (&mut w.d, &mut w.heap);
            for_each_in(rt, fold, walks, speed, max_walk, x, |u, c| {
                let nd = k.saturating_add(c);
                let e = &mut d[u as usize];
                if nd != INF && (e.1 != st || nd < e.0) {
                    *e = (nd, st);
                    heap.push(nd as u32, u);
                }
            });
        };
        #[cfg(feature = "stats")]
        crate::plan::stats::add(21, t0.elapsed().as_nanos() as u64);
        r
    }
}

impl Drop for TargetBounds<'_> {
    fn drop(&mut self) {
        if let Some(w) = self.w.take() {
            WORK.with(|c| *c.borrow_mut() = Some(w));
        }
    }
}

/// Every edge `u → v` of the graph with its weight.
#[inline]
fn for_each_in(rt: &Router, fold: Option<&LiveFold>, walks: Option<&Walks>, speed: f32, max_walk: Secs, v: Node, mut f: impl FnMut(Node, Secs)) {
    let g = &rt.lb_graph;
    let vi = v as usize;
    for e in g.off[vi] as usize..g.off[vi + 1] as usize {
        f(g.from[e], g.w[e]);
    }
    if let Some(l) = fold {
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

/// Test hook: how often a label was pruned.
#[cfg(test)]
pub(crate) static PRUNED: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
mod tests {
    //! Differential tests: the journeys must not depend on the bounds.
    use super::PRUNED;
    use crate::testutil::*;
    use crate::*;
    use kante_core::time::{Date, Secs, DAY};
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

    /// A random network with express variants, round-the-clock patterns and
    /// in-seat continuations (to the same and to other stops), plus three
    /// footpath sets: crow-fly, one-way with fixed costs, none.
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
        for _ in 0..decl.len() / 4 {
            let a = rng.below(decl.len() as u64) as usize;
            let arr = decl[a].2.last().unwrap().0;
            let cands: Vec<usize> = (0..decl.len()).filter(|&j| j != a && (0..=3 * 3600).contains(&(decl[j].2[0].1 - arr))).collect();
            if cands.is_empty() {
                continue;
            }
            // Mostly where A ends (a through-running vehicle), sometimes elsewhere.
            let same: Vec<usize> = cands.iter().copied().filter(|&j| decl[j].1[0] == *decl[a].1.last().unwrap()).collect();
            let pick = if !same.is_empty() && rng.below(3) > 0 { same[rng.below(same.len() as u64) as usize] } else { cands[rng.below(cands.len() as u64) as usize] };
            let service = if rng.below(5) == 0 { alt[rng.below(3) as usize] } else { NONE };
            b.continuation(decl[a].0, decl[pick].0, service);
        }
        let tt = b.build().tt;
        let n = tt.stops.len();
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

    /// Live times of `trip` on `date` at position `i`: (arrival, departure).
    fn live_at(tt: &Timetable, live: &TestLive, date: Date, trip: TripIdx, i: usize) -> (Secs, Secs) {
        let l = live.map.get(&(date, trip));
        (tt.arr(trip, i) + l.map_or(0, |l| l.arr_delay_at(i)), tt.dep(trip, i) + l.map_or(0, |l| l.dep_delay_at(i)))
    }

    /// Delays of every kind (late, early, catching up, falling behind,
    /// skipped stops, cancellations) but no time running backwards: live
    /// hops are not negative and a continuation does not leave before the
    /// trip feeding it arrives (it is delayed instead).
    fn overlay(tt: &Timetable, rng: &mut Rng, date: Date) -> TestLive {
        let mut live = TestLive::default();
        for t in 0..tt.trips.len() as TripIdx {
            let n = tt.pattern_stops(tt.trips[t as usize].pattern).len();
            for d in date - 1..=date + 1 {
                let r = rng.below(12);
                if r >= 6 {
                    continue;
                }
                let mut l = TripLive { observed_pos: -1, ..Default::default() };
                match r {
                    0 => l.cancelled = true,
                    1 => {
                        l.skipped = vec![false; n];
                        l.skipped[rng.below(n as u64) as usize] = true;
                    }
                    _ => {
                        // A random walk, kept so that the vehicle never arrives before it left.
                        let mut x = rng.range(-5, 25) * 60;
                        let mut last = Secs::MIN;
                        for i in 0..n {
                            let a = (tt.arr(t, i) + x).max(last) - tt.arr(t, i);
                            let dep = (a + rng.range(-1, 3) * 60).max(a.min(0));
                            l.arr_delay.push(a);
                            l.dep_delay.push(dep);
                            last = (tt.arr(t, i) + a).max(tt.dep(t, i) + dep);
                            x = a + rng.range(-8, 6) * 60;
                        }
                    }
                }
                live.map.insert((d, t), l);
            }
        }
        for _ in 0..20 {
            let mut changed = false;
            for c in tt.continuations.clone() {
                let (na, nb) = (tt.pattern_stops(tt.trips[c.from as usize].pattern).len(), tt.pattern_stops(tt.trips[c.to as usize].pattern).len());
                for d in date - 4..=date + 4 {
                    for dd in [-1, 0, 1] {
                        if !(0..=3 * 3600).contains(&(tt.dep(c.to, 0) + dd * DAY - tt.arr(c.from, na - 1))) {
                            continue;
                        }
                        let arr = live_at(tt, &live, d, c.from, na - 1).0;
                        let (a0, d0) = live_at(tt, &live, d + dd, c.to, 0);
                        let deficit = arr - (a0.max(d0) + dd * DAY);
                        if deficit > 0 {
                            let l = live.map.entry((d + dd, c.to)).or_insert_with(|| TripLive { observed_pos: -1, ..Default::default() });
                            l.arr_delay.resize(nb, 0);
                            l.dep_delay.resize(nb, 0);
                            for i in 0..nb {
                                l.arr_delay[i] += deficit;
                                l.dep_delay[i] += deficit;
                            }
                            changed = true;
                        }
                    }
                }
            }
            if !changed {
                return live;
            }
        }
        // Continuations in a loop kept pushing each other: no live data then.
        TestLive::default()
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
        q.transfer_margin = rng.range(-3, 3).max(0) * 60;
        q.walk_speed = [0.8, 1.3, 1.8][rng.below(3) as usize];
        q.max_walk = [200, 600, 900, 3000][rng.below(4) as usize];
        if rng.below(6) == 0 {
            q.modes = Mode::Bus.bit() | Mode::Rail.bit();
        }
        q
    }

    /// What the engine guarantees not to depend on the order of the search:
    /// of two options that tie, either may be named, and an earliest-arrival
    /// search may report another departure for the same arrival.
    fn key(q: &Query, js: &[Journey]) -> Vec<(Secs, Secs, u8)> {
        let plain = q.window == 0 && q.onboard.is_none();
        js.iter().map(|j| (if plain { 0 } else { j.dep }, j.arr, j.transfers)).collect()
    }

    /// Plans with and without bounds; returns (journeys, whether they are identical leg by leg).
    fn same(rt: &Router, q: &Query, what: &str) -> (usize, bool) {
        rt.set_target_bounds(false);
        let off = rt.plan(q);
        rt.set_target_bounds(true);
        let on = rt.plan(q);
        assert_eq!(key(q, &on), key(q, &off), "{what}: bounds change the result\n{on:#?}\n{off:#?}");
        (on.len(), on == off)
    }

    #[test]
    fn bounds_do_not_change_results() {
        let before = PRUNED.load(Ordering::Relaxed);
        let (mut journeys, mut queries, mut identical) = (0, 0, 0);
        for seed in 1..=200 {
            let (rt, fps) = world(seed);
            let tt = rt.timetable().clone();
            let mut rng = Rng(seed * 7919 + 1);
            let date = D0 + rng.range(2, 6);
            let mut live = overlay(&tt, &mut rng, date);
            if rng.below(2) == 0 {
                live.index(&tt);
            }
            for i in 0..30 {
                let fp = &fps[rng.below(fps.len() as u64) as usize];
                let (mut acc, mut egr) = (Vec::new(), Vec::new());
                let mut q = query(&mut rng, &tt, fp, &mut acc, &mut egr, date);
                if rng.below(2) == 0 {
                    q.live = Some(&live);
                }
                if rng.below(5) == 0 {
                    let trip = rng.below(tt.trips.len() as u64) as TripIdx;
                    let n = tt.pattern_stops(tt.trips[trip as usize].pattern).len();
                    let ob = Onboard { trip, date: date + rng.range(-1, 1), next_pos: rng.range(1, n as i32 - 1) as u16 };
                    q.onboard = Some(ob);
                    q.from = tt.arr(trip, 0) + (ob.date - date) * DAY + rng.range(0, 30) * 60;
                }
                let (n, ident) = same(&rt, &q, &format!("seed {seed} query {i}"));
                journeys += n;
                identical += ident as usize;
                queries += 1;
            }
        }
        let pruned = PRUNED.load(Ordering::Relaxed) - before;
        println!("{queries} queries, {journeys} journeys, {identical} identical leg by leg, {pruned} labels pruned by the bounds");
        assert!(journeys > 3000, "too few journeys to mean anything: {journeys}");
        assert!(pruned > 10_000, "the bounds hardly prune: {pruned}");
    }

    /// Two ways from O to D: 07:30 by C (O → W) and then A (W → …), and a
    /// later direct bus at 07:45 that arrives at `bus_arr`. The bus sets the
    /// target first; the 07:30 journey is only found if the bound at W does
    /// not over-estimate.
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
        // A: W 07:40 → D 08:00 scheduled; live it arrives at W on time, leaves
        // at 07:45 and reaches D at 07:55: 10 min from its live departure.
        let (rt, trips, o, d) = two_ways(hm(7, 56), |b, w, d| {
            let rail = b.line("rail", Mode::Rail);
            let pa = b.pattern(rail, &[w, d]);
            vec![b.trip(pa, &[hm(7, 40), hm(8, 0)])]
        });
        let mut live = TestLive::default();
        let l = live.map.entry((D0 + 3, trips[0])).or_default();
        (l.arr_delay, l.dep_delay, l.observed_pos) = (vec![0, -300], vec![300, -300], -1);
        check_two_ways(&rt, o, d, Some(&live), hm(7, 55));
        // A view that cannot list its trips: planned without bounds, same result.
        check_two_ways(&rt, o, d, Some(&GlobalOnly(&live)), hm(7, 55));
    }

    #[test]
    fn footpaths_of_one_station_pair() {
        // A: W 07:45 → Y2 07:50; walk Y2 → Z2 (1 min); B: Z2 07:52 → D 07:56.
        // Y and Y2 form one station, Z and Z2 another; Y → Z takes 10 min.
        let mut b = Builder::new();
        let (o, w, d, y, y2, z, z2) = (b.stop("O"), b.stop("W"), b.stop("D"), b.stop("Y"), b.stop("Y2"), b.stop("Z"), b.stop("Z2"));
        let bus = b.line("bus", Mode::Bus);
        let pc = b.pattern(bus, &[o, w]);
        b.trip(pc, &[hm(7, 30), hm(7, 40)]);
        let pd = b.pattern(bus, &[o, d]);
        b.trip(pd, &[hm(7, 45), hm(7, 58)]);
        let pa = b.pattern(bus, &[w, y2]);
        b.trip(pa, &[hm(7, 45), hm(7, 50)]);
        let pb = b.pattern(bus, &[z2, d]);
        b.trip(pb, &[hm(7, 52), hm(7, 56)]);
        let mut tt = b.build().tt;
        tt.stops[y2 as usize].station = y;
        tt.stops[z2 as usize].station = z;
        let rt = Router::new(Arc::new(tt));
        let fp = footpaths(rt.timetable().stops.len(), &[(y, z, 0, 600), (y2, z2, 0, 60)]);
        let (acc, egr) = ([(o, 0)], [(d, 0)]);
        let mut q = Query::new(D0 + 3, hm(7, 25), &acc, &egr, &fp);
        q.window = 1800;
        q.transfer_margin = 0;
        same(&rt, &q, "station pair");
        assert!(rt.plan(&q).iter().any(|j| j.dep == hm(7, 30) && j.arr == hm(7, 56)), "{:#?}", rt.plan(&q));
    }

    #[test]
    fn footpath_between_stations() {
        // A: W 07:40 → Y 07:45; walk Y → Z (one way, 2 min); B: Z 07:47 → D
        // 07:51. With no margin the bound at W is exact: the bus at 07:52 must
        // not make it prune.
        let (rt, _, o, d) = two_ways(hm(7, 52), |b, w, d| {
            let y = b.stop("Y");
            let z = b.stop_at("Z", 50_000.0, 0.0);
            let rail = b.line("rail", Mode::Rail);
            let pa = b.pattern(rail, &[w, y]);
            let a = b.trip(pa, &[hm(7, 40), hm(7, 45)]);
            let pb = b.pattern(rail, &[z, d]);
            vec![a, b.trip(pb, &[hm(7, 47), hm(7, 51)])]
        });
        let n = rt.timetable().stops.len();
        let fp = footpaths(n, &[(3, 4, 0, 120)]);
        let (acc, egr) = ([(o, 0)], [(d, 0)]);
        let mut q = Query::new(D0 + 3, hm(7, 25), &acc, &egr, &fp);
        q.window = 1800;
        q.transfer_margin = 0;
        same(&rt, &q, "footpath");
        assert!(rt.plan(&q).iter().any(|j| j.dep == hm(7, 30) && j.arr == hm(7, 51)));
    }
}
