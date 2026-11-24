//! Shortest-path searches on the routing network: a bounded Dijkstra for
//! one-to-many and A* for point-to-point, both starting from a point inside
//! an edge. Per-thread scratch with generation stamps, so a query touches
//! only the nodes it reaches.

use crate::net::{Arc, CostTable, Net, NO_NODE};
use crate::WalkCost;
use kante_core::geo::M_PER_DEG_LAT;
use kante_core::*;
use std::cell::RefCell;

/// 4-ary min-heap of (f32 key, node) packed into one u64. Keys are
/// non-negative, so their bit patterns order like the numbers.
pub(crate) struct Heap {
    v: Vec<u64>,
}

impl Heap {
    #[inline]
    fn push(&mut self, key: f32, node: u32) {
        let x = (key.to_bits() as u64) << 32 | node as u64;
        let mut i = self.v.len();
        self.v.push(x);
        while i > 0 {
            let p = (i - 1) / 4;
            if self.v[p] <= x {
                break;
            }
            self.v[i] = self.v[p];
            i = p;
        }
        self.v[i] = x;
    }
    #[inline]
    fn pop(&mut self) -> Option<(f32, u32)> {
        let top = *self.v.first()?;
        let x = self.v.pop().unwrap();
        let n = self.v.len();
        if n > 0 {
            let mut i = 0;
            loop {
                let c0 = 4 * i + 1;
                if c0 >= n {
                    break;
                }
                let end = (c0 + 4).min(n);
                let mut m = c0;
                for c in c0 + 1..end {
                    if self.v[c] < self.v[m] {
                        m = c;
                    }
                }
                if self.v[m] >= x {
                    break;
                }
                self.v[i] = self.v[m];
                i = m;
            }
            self.v[i] = x;
        }
        Some((f32::from_bits((top >> 32) as u32), top as u32))
    }
}
// Search state slots. A search state is a routing node, or at a junction with transition costs one arc into it
// (`Net::jun`); `st` has one block per state.
const S_STAMP: usize = 0;
const S_DIST: usize = 1;
const S_VAR: usize = 2;
const S_FIX: usize = 3;
/// The arc the state was reached along (or a seed tag).
const S_PARC: usize = 4;
/// The state that arc left from (or `SEED_FWD` / `SEED_BACK`).
const S_PNODE: usize = 5;
/// On a node's own block: stamp of a target end node that is not settled yet. On a junction's state: the
/// junction's node.
const S_MARK: usize = 6;
/// route: cached heuristic; many-to-many: which source the label comes from.
const S_H: usize = 7;

/// `S_PNODE` of a seed state: reached along the source edge towards `b` / `a`.
const SEED_FWD: u32 = u32::MAX;
const SEED_BACK: u32 = u32::MAX - 1;

struct Scratch {
    gen: u32,
    /// One zero-initialised (lazily mapped) block per search state.
    st: Vec<[u32; 8]>,
    heap: Heap,
    table: CostTable,
    /// The profile the table is for (its time left out: hours are set apart), and whether it is the walked-time
    /// one ([`CostTable::fill_walked`]).
    table_for: Option<(WalkProfile, bool)>,
    targets: Vec<TargetEnds>,
    /// Per junction reached: the best label settled at it (generalised seconds) and the stamp it is for.
    best: Vec<(u32, f32)>,
}

#[derive(Clone, Copy)]
struct TargetEnds {
    ia: u32,
    ib: u32,
    /// Arc indices or `NO_NODE`.
    fwd: u32,
    back: u32,
}

impl Scratch {
    fn begin(&mut self, net: &Net, profile: &WalkProfile, walked: bool) {
        let states = net.ns as usize;
        if self.st.len() < states {
            self.st = vec![[0u32; 8]; states];
            self.gen = 0;
        }
        if self.best.len() < net.jun.node.len() {
            self.best = vec![(0, 0.0); net.jun.node.len()];
            self.gen = 0;
        }
        if self.gen >= u32::MAX - 2 {
            self.st.iter_mut().for_each(|s| *s = [0; 8]);
            self.best.iter_mut().for_each(|b| *b = (0, 0.0));
            self.gen = 0;
        }
        self.gen += 1;
        self.heap.v.clear();
        let key = WalkProfile { at: None, ..*profile };
        if self.table_for != Some((key, walked)) {
            if walked {
                self.table.fill_walked(profile);
            } else {
                self.table.fill(profile);
            }
            self.table_for = Some((key, walked));
        }
        self.table.set_time(net, profile.at);
    }
}

thread_local! {
    static SCRATCH: RefCell<Scratch> = RefCell::new(Scratch {
        gen: 0,
        st: Vec::new(),
        heap: Heap { v: Vec::new() },
        table: CostTable::new(),
        table_for: None,
        targets: Vec::new(),
        best: Vec::new(),
    });
}

/// How far beyond `max_time_s` the generalised cost may go, so that a walk
/// which takes 14 minutes but "feels" like 18 because it follows a main road
/// is still found. Covers a walk entirely on `RoadBusy` (×1.3), entirely on
/// rough ground in a wheelchair (×1.8), and a few avoided stair flights; and
/// hills: a walk climbing all the way at 10 % feels about 1.3 × as long to a
/// walker who minds them a little, 2 × to one who avoids them, more in a wheelchair.
/// Not a carriageway whose sidewalks are drawn apart (×4), a way closed at the time (×5) or a long walk of many
/// turns: a walk the bound misses is found by the search by time walked ([`crate::WalkRouter::quickest_many`]),
/// which decides whether a stop is reached.
fn bound_slack(p: &WalkProfile) -> f32 {
    let base = if p.wheelchair {
        2.0
    } else if p.stairs == StairsPref::Avoid {
        1.5
    } else {
        1.3
    };
    base + match (p.hills, p.wheelchair) {
        (HillsPref::Ignore, _) => 0.0,
        (HillsPref::Normal, false) => 0.3,
        (HillsPref::Normal, true) | (HillsPref::Avoid, _) => 1.0,
    }
}

/// Writes a label into a state's block if it is better; `node` is the state's routing node (kept on a junction's
/// state).
#[inline]
#[allow(clippy::too_many_arguments)]
fn relax(st: &mut [[u32; 8]], n: u32, state: u32, node: u32, gen: u32, nd: f32, var: f32, fix: f32, parc: u32, pnode: u32) -> bool {
    let s = &mut st[state as usize];
    if s[S_STAMP] != gen || nd < f32::from_bits(s[S_DIST]) {
        s[S_STAMP] = gen;
        s[S_DIST] = nd.to_bits();
        s[S_VAR] = var.to_bits();
        s[S_FIX] = fix.to_bits();
        s[S_PARC] = parc;
        s[S_PNODE] = pnode;
        if state >= n {
            s[S_MARK] = node;
        }
        true
    } else {
        false
    }
}

/// The routing node of a state that has a label (read from its block on a junction's state).
#[inline]
fn node_of(st: &[[u32; 8]], n: u32, state: u32) -> u32 {
    if state < n {
        state
    } else {
        st[state as usize][S_MARK]
    }
}

/// The generalised seconds of leaving a state along out-arc `i` of its node (0 off a junction), `None` if not
/// allowed.
#[inline]
fn leave(net: &Net, t: &CostTable, state: u32, node: u32, i: usize) -> Option<f32> {
    if state < net.n {
        return Some(0.0);
    }
    let j = net.jun.of(node)?;
    let k = (state - net.jun.base[j]) as usize;
    t.trans(net.jun.units(j, k, i))
}

/// Seeds the two ends of the source edge, reached at a cost already (`gen0` generalised seconds, `var0` metres),
/// tagged `tag` as the parent arc. Returns false if the snap is invalid.
#[allow(clippy::too_many_arguments)]
fn seed_with(g: &WalkGraph, net: &Net, s: &mut Scratch, from: &Snap, h: impl Fn(u32) -> f32, gen0: f32, var0: f32, tag: u32) -> bool {
    if from.edge as usize >= g.edges.len() {
        return false;
    }
    let f = from.frac.clamp(0.0, 1.0);
    let ea = net.edge_arcs(g, from.edge);
    let gen = s.gen;
    for (arc, scale, mark) in [(ea.fwd, 1.0 - f, SEED_FWD), (ea.back, f, SEED_BACK)] {
        if arc == NO_NODE {
            continue;
        }
        let a = &net.arcs[arc as usize];
        // Leaving the edge means passing its end node.
        if !s.table.through(a) {
            continue;
        }
        let (gc, var, fix) = s.table.arc(net, a, scale);
        if !gc.is_finite() {
            continue;
        }
        let (gc, var) = (gc + gen0, var + var0);
        if relax(&mut s.st, net.n, a.state, a.head, gen, gc, var, fix, tag, mark) {
            s.heap.push(gc + h(a.head), a.state);
        }
    }
    true
}

pub(crate) fn one_to_many(g: &WalkGraph, net: &Net, from: &Snap, targets: &[Snap], profile: &WalkProfile, max_time_s: f32) -> Vec<Option<WalkCost>> {
    many_to_many(g, net, &[(*from, 0.0, 0.0)], targets, profile, max_time_s)
}

/// [`one_to_many`] from whichever of several sources is best: each comes with
/// metres already walked to it (`var_m`, counted in the result) and a penalty
/// in generalised seconds for route choice only.
pub(crate) fn many_to_many(g: &WalkGraph, net: &Net, froms: &[(Snap, f32, f32)], targets: &[Snap], profile: &WalkProfile, max_time_s: f32) -> Vec<Option<WalkCost>> {
    let speed = profile.speed_mps.max(0.05);
    many_to_many_raw(g, net, froms, targets, profile, max_time_s)
        .into_iter()
        .map(|r| r.filter(|r| walk_secs(r.1.var_m, r.1.fix_s, speed) <= max_time_s + 1e-3).map(|r| r.1))
        .collect()
}

/// The search of [`many_to_many`] without its limit: for each target, the source the cheapest way (penalties
/// included) comes from, that way's walking cost (the source's metres included) and its generalised seconds
/// (the source's offset included), for every target within the search's bound (`max_time_s` × the profile's slack
/// plus the largest penalty).
pub(crate) fn many_to_many_raw(g: &WalkGraph, net: &Net, froms: &[(Snap, f32, f32)], targets: &[Snap], profile: &WalkProfile, max_time_s: f32) -> Vec<Option<(usize, WalkCost, f32)>> {
    many_to_many_mode(g, net, froms, targets, profile, max_time_s, false)
}

/// Is a popped state worth expanding? At a junction, not when another of its states settled so much cheaper that
/// no transition could make this one's way on better (the junction's largest transition cost).
#[inline]
fn dominated(net: &Net, best: &mut [(u32, f32)], gen: u32, node: u32, d: f32) -> bool {
    let Some(j) = net.jun.of(node) else { return false };
    let b = &mut best[j];
    if b.0 != gen {
        *b = (gen, d);
        return false;
    }
    let max = net.jun.max[j];
    max != crate::net::TRANS_BLOCKED && d > b.1 + max as f32 * crate::net::TRANS_UNIT_S
}

/// [`many_to_many_raw`], or with `walked` by the time walked alone (no preferences, no slack): the quickest walk to
/// each target within `max_time_s` (plus the largest offset), and which source it comes from.
pub(crate) fn many_to_many_mode(g: &WalkGraph, net: &Net, froms: &[(Snap, f32, f32)], targets: &[Snap], profile: &WalkProfile, max_time_s: f32, walked: bool) -> Vec<Option<(usize, WalkCost, f32)>> {
    let mut out: Vec<Option<(usize, WalkCost, f32)>> = vec![None; targets.len()];
    if targets.is_empty() || froms.is_empty() || !(max_time_s >= 0.0) || froms.len() >= MAX_SOURCES {
        return out;
    }
    SCRATCH.with(|cell| {
        let s = &mut *cell.borrow_mut();
        s.begin(net, profile, walked);
        let speed = profile.speed_mps.max(0.05);
        let gen = s.gen;
        let n = net.n;
        let mut any = false;
        for (i, (f, var0, pen)) in froms.iter().enumerate() {
            any |= seed_with(g, net, s, f, |_| 0.0, var0 / speed + pen, *var0, seed_tag(i));
            // which source a state's label comes from (S_H)
            if (f.edge as usize) < g.edges.len() {
                let src = net.edge_arcs(g, f.edge);
                for arc in [src.fwd, src.back] {
                    if arc == NO_NODE {
                        continue;
                    }
                    let st = net.arcs[arc as usize].state as usize;
                    if s.st[st][S_STAMP] == gen && s.st[st][S_PARC] == seed_tag(i) {
                        s.st[st][S_H] = i as u32;
                    }
                }
            }
        }
        if !any {
            return;
        }
        // a source's offset (its metres to the network, and its route-choice penalty) may not eat into the bound: the
        // walk from it is bounded as one from a source without them (as one_to_many adds those metres only after)
        let slack = if walked { 1.0 } else { bound_slack(profile) };
        let extra = if walked || net.jun.node.is_empty() { 0.0 } else { crate::net::TRANS_SLACK_S };
        let bound = max_time_s * slack + extra + froms.iter().map(|f| f.1 / speed + f.2).fold(0.0, f32::max);

        // Mark the nodes from which a target can be finished (on the node's own block).
        let mut tends = std::mem::take(&mut s.targets);
        tends.clear();
        let mut remaining = 0u32;
        for t in targets {
            if t.edge as usize >= g.edges.len() {
                tends.push(TargetEnds { ia: NO_NODE, ib: NO_NODE, fwd: NO_NODE, back: NO_NODE });
                continue;
            }
            let ea = net.edge_arcs(g, t.edge);
            let mut te = TargetEnds { ia: ea.ia, ib: ea.ib, fwd: ea.fwd, back: ea.back };
            for (arc, node) in [(&mut te.fwd, ea.ia), (&mut te.back, ea.ib)] {
                if *arc != NO_NODE && (!s.table.usable[net.arcs[*arc as usize].cls as usize] || net.arcs[*arc as usize].head_block & s.table.dir_mask != 0) {
                    *arc = NO_NODE;
                }
                if *arc != NO_NODE && s.st[node as usize][S_MARK] != gen {
                    s.st[node as usize][S_MARK] = gen;
                    remaining += 1;
                }
            }
            tends.push(te);
        }

        let t = &s.table;
        let st = &mut s.st;
        let heap = &mut s.heap;
        let best = &mut s.best;
        // once every target's end node is settled, the search goes on while a junction's other arrivals could
        // still finish it more cheaply (its largest transition cost)
        let mut deadline = f32::NEG_INFINITY;
        loop {
            let Some((d, u)) = heap.pop() else { break };
            let su = st[u as usize];
            if d > f32::from_bits(su[S_DIST]) {
                continue; // stale
            }
            if d > bound || (remaining == 0 && d > deadline) {
                break;
            }
            let v = node_of(st, n, u);
            if st[v as usize][S_MARK] == gen && (u >= n || u == v) {
                st[v as usize][S_MARK] = 0;
                remaining -= 1;
                // (at a junction with a way blocked, another arrival may be the only one allowed on: to the bound)
                let slack = net.jun.of(v).map_or(0.0, |j| if net.jun.max[j] == crate::net::TRANS_BLOCKED { f32::INFINITY } else { net.jun.max[j] as f32 * crate::net::TRANS_UNIT_S });
                deadline = deadline.max(d + slack);
            }
            if dominated(net, best, gen, v, d) {
                continue;
            }
            let (var, fix) = (f32::from_bits(su[S_VAR]), f32::from_bits(su[S_FIX]));
            let r = net.out(v);
            for (i, a) in net.arcs[r].iter().enumerate() {
                if a.head_block & t.head_mask != 0 {
                    continue;
                }
                let Some(tc) = leave(net, t, u, v, i) else { continue };
                let c = a.cls as usize;
                let sh = a.share as f32;
                let nd = d + tc + a.len_m * t.gen_per_m(net, a) + sh * t.gen_c[c] + t.slope_gen(a);
                if !(nd <= bound) {
                    continue;
                }
                let sv = &mut st[a.state as usize];
                if sv[S_STAMP] != gen || nd < f32::from_bits(sv[S_DIST]) {
                    sv[S_STAMP] = gen;
                    sv[S_DIST] = nd.to_bits();
                    sv[S_VAR] = (var + a.len_m * t.var_m[c] + t.slope_var(a)).to_bits();
                    sv[S_FIX] = (fix + a.len_m * t.fix_m[c] + sh * t.fix_c[c]).to_bits();
                    sv[S_H] = su[S_H];
                    if a.state >= n {
                        sv[S_MARK] = a.head;
                    }
                    heap.push(nd, a.state);
                }
            }
        }

        // Finish each target inside its edge, from every arrival at its end nodes.
        for (i, (tg, te)) in targets.iter().zip(&tends).enumerate() {
            if te.ia == NO_NODE {
                continue;
            }
            let ft = tg.frac.clamp(0.0, 1.0);
            // (generalised, var, fix, source)
            let mut best = (f32::INFINITY, 0f32, 0f32, 0usize);
            for (arc, node, scale) in [(te.fwd, te.ia, ft), (te.back, te.ib, 1.0 - ft)] {
                if arc == NO_NODE {
                    continue;
                }
                let a = &net.arcs[arc as usize];
                let (gc, var, fix) = t.arc(net, a, scale);
                if !gc.is_finite() {
                    continue;
                }
                let slot = arc as usize - net.out(node).start;
                for state in net.states_of(node) {
                    let sn = &st[state as usize];
                    if sn[S_STAMP] != gen {
                        continue;
                    }
                    let d = f32::from_bits(sn[S_DIST]);
                    if d > bound {
                        continue;
                    }
                    let Some(tc) = leave(net, t, state, node, slot) else { continue };
                    if d + tc + gc < best.0 {
                        best = (d + tc + gc, f32::from_bits(sn[S_VAR]) + var, f32::from_bits(sn[S_FIX]) + fix, sn[S_H] as usize);
                    }
                }
            }
            for (k, (from, var0, pen)) in froms.iter().enumerate().filter(|(_, f)| f.0.edge == tg.edge) {
                let fs = from.frac.clamp(0.0, 1.0);
                let src = net.edge_arcs(g, from.edge);
                let (arc, scale) = if ft >= fs { (src.fwd, ft - fs) } else { (src.back, fs - ft) };
                if arc != NO_NODE {
                    let (gc, var, fix) = t.arc(net, &net.arcs[arc as usize], scale);
                    let gc = gc + var0 / speed + pen;
                    if gc < best.0 {
                        best = (gc, var + var0, fix, k);
                    }
                }
            }
            if best.0.is_finite() {
                out[i] = Some((best.3, WalkCost { var_m: best.1, fix_s: best.2 }, best.0));
            }
        }
        s.targets = tends;
    });
    out
}

/// One traversed stretch of a route: (part of) an edge, or a step into / out of a lift.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Leg {
    /// `NO_EDGE` for the virtual lift arcs.
    pub edge: u32,
    /// Fractions of the edge (from node `a`) where the leg starts and ends.
    pub f0: f32,
    pub f1: f32,
    pub cls: u8,
    /// Metres of the edge covered by this leg.
    pub len_m: f32,
    pub var_m: f32,
    pub fix_s: f32,
    /// Graph node at the end of the leg, `NO_NODE` when it ends inside an edge.
    pub end_node: u32,
    /// Metres of it on a way closed at the walk's time ([`crate::WalkPath::closed_m`]).
    pub closed_m: f32,
}

/// A* from `from` to `to`. Returns the legs in travel order.
pub(crate) fn route(g: &WalkGraph, net: &Net, from: &Snap, to: &Snap, profile: &WalkProfile) -> Option<Vec<Leg>> {
    route_between(g, net, &[(*from, 0.0, 0.0)], &[(*to, 0.0, 0.0)], profile, false).map(|r| r.2)
}

/// `S_PARC` of a state reached straight from source `i` of a search (not along an arc).
#[inline]
fn seed_tag(i: usize) -> u32 {
    NO_NODE - i as u32
}
const MAX_SOURCES: usize = 1 << 16;

/// A* from the best of several sources to the best of several targets: each comes with metres already walked to
/// or from it (`var_m`) and a route-choice penalty in generalised seconds, as in [`many_to_many`], which this agrees
/// with: for one target, the source it takes is the one that search's cost for the target comes from. Returns
/// (source, target, legs, generalised cost including both offsets).
pub(crate) fn route_between(g: &WalkGraph, net: &Net, froms: &[(Snap, f32, f32)], tos: &[(Snap, f32, f32)], profile: &WalkProfile, walked: bool) -> Option<(usize, usize, Vec<Leg>, f32)> {
    // a route is drawn in the direction of travel (only the searches to many targets run against it)
    debug_assert!(!profile.backwards, "routes run in the direction of travel");
    let profile = &WalkProfile { backwards: false, ..*profile };
    let froms: Vec<(usize, &(Snap, f32, f32))> = froms.iter().enumerate().filter(|(_, f)| (f.0.edge as usize) < g.edges.len()).take(MAX_SOURCES).collect();
    let tos: Vec<(usize, &(Snap, f32, f32))> = tos.iter().enumerate().filter(|(_, t)| (t.0.edge as usize) < g.edges.len()).collect();
    if tos.is_empty() || froms.is_empty() {
        return None;
    }
    SCRATCH.with(|cell| {
        let s = &mut *cell.borrow_mut();
        s.begin(net, profile, walked);
        let gen = s.gen;
        let n = net.n;
        let speed = profile.speed_mps.max(0.05);
        let off = |f: &(Snap, f32, f32)| f.1 / speed + f.2;

        // Admissible bound: nothing covers ground faster than walking (or an
        // escalator, for a very slow walker) on the way this walker likes best
        // (the smallest route-choice multiplier); 0.5 % for the planar metric.
        // The nearest target, offsets left out.
        let plain = (1.0 / speed).min(1.0 / ESCALATOR_MPS) * 0.995;
        let rate = if walked || !crate::net::rules::is_on(crate::net::rules::FAVOURED) { plain } else { plain * crate::net::rules::favoured_mult() };
        let kx = (1e-7 * M_PER_DEG_LAT * (g.nodes[g.edges[tos[0].1 .0.edge as usize].a as usize].lat as f64 * 1e-7).to_radians().cos()) as f32;
        let ky = (1e-7 * M_PER_DEG_LAT) as f32;
        // The bound must aim at the real end points, whatever `pos` says.
        let tpos: Vec<(i32, i32)> = tos
            .iter()
            .map(|(_, t)| {
                let p = crate::path::point_on_edge(g, t.0.edge, t.0.frac);
                (p.lat, p.lon)
            })
            .collect();
        let (n0, slack) = (net.lift_from, net.lift_slack_m * 2.0 + 1.0);
        let h = |node: u32| -> f32 {
            let p = &g.nodes[net.orig_node(node) as usize];
            let mut d2 = f32::INFINITY;
            for &(tlat, tlon) in &tpos {
                let (dx, dy) = ((p.lon - tlon) as f32 * kx, (p.lat - tlat) as f32 * ky);
                d2 = d2.min(dx * dx + dy * dy);
            }
            let d = d2.sqrt();
            // Inside a lift the horizontal movement is free.
            rate * if node >= n0 { (d - slack).max(0.0) } else { d }
        };

        // Cost of finishing each target from each end of its edge: (node, slot of the arc there, target k,
        // generalised cost of the arc's part with the target's offset, fwd?)
        let mut fins: Vec<(u32, usize, usize, f32, bool)> = Vec::new();
        for (k, (_, t)) in tos.iter().enumerate() {
            let ft = t.0.frac.clamp(0.0, 1.0);
            let dst = net.edge_arcs(g, t.0.edge);
            if dst.fwd != NO_NODE {
                fins.push((dst.ia, dst.fwd as usize - net.out(dst.ia).start, k, s.table.arc(net, &net.arcs[dst.fwd as usize], ft).0 + off(t), true));
            }
            if dst.back != NO_NODE {
                fins.push((dst.ib, dst.back as usize - net.out(dst.ib).start, k, s.table.arc(net, &net.arcs[dst.back as usize], 1.0 - ft).0 + off(t), false));
            }
        }
        fins.retain(|f| f.3.is_finite());
        for f in &fins {
            s.st[f.0 as usize][S_MARK] = gen;
        }

        // best = (generalised total, how: 0 direct from a source on the target's edge, 1 via its a, 2 via its b,
        // that source, that target, the state finished from)
        let mut best = (f32::INFINITY, 0u8, 0usize, 0usize, NO_NODE);
        for &(i, f) in &froms {
            for (k, (_, t)) in tos.iter().enumerate() {
                if f.0.edge != t.0.edge {
                    continue;
                }
                let (fs, ft) = (f.0.frac.clamp(0.0, 1.0), t.0.frac.clamp(0.0, 1.0));
                let src = net.edge_arcs(g, f.0.edge);
                let (arc, scale) = if ft >= fs { (src.fwd, ft - fs) } else { (src.back, fs - ft) };
                if arc != NO_NODE {
                    let (gc, _, _) = s.table.arc(net, &net.arcs[arc as usize], scale);
                    let c = gc + off(f) + off(t);
                    if gc.is_finite() && c < best.0 {
                        best = (c, 0, i, k, NO_NODE);
                    }
                }
            }
        }
        // Give up beyond four times the beeline plus half an hour, the beeline to the farthest end point (so that
        // more end points never cut a walk to one of them short). At the plain walking rate, whatever the A* bound.
        let h_far = |node: u32| -> f32 {
            let p = &g.nodes[net.orig_node(node) as usize];
            let mut d2 = 0f32;
            for &(tlat, tlon) in &tpos {
                let (dx, dy) = ((p.lon - tlon) as f32 * kx, (p.lat - tlat) as f32 * ky);
                d2 = d2.max(dx * dx + dy * dy);
            }
            plain * d2.sqrt()
        };
        let mut any = false;
        let mut cap = 0f32;
        for &(i, f) in &froms {
            if seed_with(g, net, s, &f.0, &h, off(f), f.1, seed_tag(i)) {
                any = true;
            }
            let src = net.edge_arcs(g, f.0.edge);
            for arc in [src.fwd, src.back] {
                if arc == NO_NODE {
                    continue;
                }
                let a = &net.arcs[arc as usize];
                if s.st[a.state as usize][S_STAMP] == gen {
                    s.st[a.state as usize][S_H] = h(a.head).to_bits();
                }
            }
            cap = cap.max(h_far(src.ia).max(h_far(src.ib)) * 4.0 + 1800.0 + off(f));
        }
        if !any && !best.0.is_finite() {
            return None;
        }

        let t = &s.table;
        let st = &mut s.st;
        let heap = &mut s.heap;
        let bests = &mut s.best;
        while let Some((key, u)) = heap.pop() {
            if key >= best.0 || key > cap {
                break;
            }
            let su = st[u as usize];
            let d = f32::from_bits(su[S_DIST]);
            if key > d + f32::from_bits(su[S_H]) {
                continue; // stale
            }
            let v = node_of(st, n, u);
            if st[v as usize][S_MARK] == gen {
                for &(node, slot, k, c, fwd) in &fins {
                    if node == v {
                        if let Some(tc) = leave(net, t, u, v, slot) {
                            if d + tc + c < best.0 {
                                best = (d + tc + c, if fwd { 1 } else { 2 }, 0, k, u);
                            }
                        }
                    }
                }
            }
            if dominated(net, bests, gen, v, d) {
                continue;
            }
            let (var, fix) = (f32::from_bits(su[S_VAR]), f32::from_bits(su[S_FIX]));
            let r = net.out(v);
            let base = r.start;
            for (i, a) in net.arcs[r].iter().enumerate() {
                if a.head_block & t.head_mask != 0 {
                    continue;
                }
                let Some(tc) = leave(net, t, u, v, i) else { continue };
                let c = a.cls as usize;
                let sh = a.share as f32;
                let nd = d + tc + a.len_m * t.gen_per_m(net, a) + sh * t.gen_c[c] + t.slope_gen(a);
                if !(nd < best.0) {
                    continue;
                }
                let sv = &mut st[a.state as usize];
                let fresh = sv[S_STAMP] != gen;
                if fresh || nd < f32::from_bits(sv[S_DIST]) {
                    if fresh {
                        sv[S_STAMP] = gen;
                        sv[S_H] = h(a.head).to_bits();
                    }
                    sv[S_DIST] = nd.to_bits();
                    sv[S_VAR] = (var + a.len_m * t.var_m[c] + t.slope_var(a)).to_bits();
                    sv[S_FIX] = (fix + a.len_m * t.fix_m[c] + sh * t.fix_c[c]).to_bits();
                    sv[S_PARC] = (base + i) as u32;
                    sv[S_PNODE] = u;
                    if a.state >= n {
                        sv[S_MARK] = a.head;
                    }
                    heap.push(nd + f32::from_bits(sv[S_H]), a.state);
                }
            }
        }
        if !best.0.is_finite() {
            return None;
        }

        // ---- unpack
        let leg_of = |arc: &Arc, f0: f32, f1: f32, end_node: u32| -> Leg {
            let (_, var_m, fix_s) = t.arc(net, arc, (f1 - f0).abs());
            let len_m = arc.len_m * (f1 - f0).abs();
            let closed_m = if t.is_closed(net, arc) { len_m } else { 0.0 };
            Leg { edge: arc.edge(), f0, f1, cls: arc.cls, len_m, var_m, fix_s, end_node, closed_m }
        };
        let (target, to) = (tos[best.3].0, &tos[best.3].1 .0);
        let ft = to.frac.clamp(0.0, 1.0);
        let dst = net.edge_arcs(g, to.edge);
        let mut legs: Vec<Leg> = Vec::new();
        if best.1 == 0 {
            let f = &froms.iter().find(|(i, _)| *i == best.2).unwrap().1 .0;
            let (fs, src) = (f.frac.clamp(0.0, 1.0), net.edge_arcs(g, f.edge));
            let arc = if ft >= fs { src.fwd } else { src.back };
            legs.push(leg_of(&net.arcs[arc as usize], fs, ft, NO_NODE));
            return Some((best.2, target, legs, best.0));
        }
        // Last leg first, then back along the parents.
        if best.1 == 1 {
            legs.push(leg_of(&net.arcs[dst.fwd as usize], 0.0, ft, NO_NODE));
        } else {
            legs.push(leg_of(&net.arcs[dst.back as usize], 1.0, ft, NO_NODE));
        }
        let mut state = best.4;
        let mut guard = 0usize;
        let source;
        loop {
            let sn = &st[state as usize];
            let (parc, pnode) = (sn[S_PARC], sn[S_PNODE]);
            if parc > NO_NODE - MAX_SOURCES as u32 {
                // reached straight from a source, along its edge
                let i = (NO_NODE - parc) as usize;
                let f = &froms.iter().find(|(k, _)| *k == i).unwrap().1 .0;
                let (fs, src) = (f.frac.clamp(0.0, 1.0), net.edge_arcs(g, f.edge));
                let ed = &g.edges[f.edge as usize];
                if pnode == SEED_FWD {
                    legs.push(leg_of(&net.arcs[src.fwd as usize], fs, 1.0, ed.b));
                } else {
                    legs.push(leg_of(&net.arcs[src.back as usize], fs, 0.0, ed.a));
                }
                source = i;
                break;
            }
            let arc = &net.arcs[parc as usize];
            let (f0, f1) = if arc.rev() { (1.0, 0.0) } else { (0.0, 1.0) };
            legs.push(leg_of(arc, f0, f1, net.orig_node(arc.head)));
            state = pnode;
            guard += 1;
            if guard > net.ns as usize {
                return None; // corrupted parents; cannot happen
            }
        }
        legs.reverse();
        // Drop empty first / last legs (snap exactly on a node).
        if legs.len() > 1 {
            let keep_first = (legs[0].f0 - legs[0].f1).abs() > 1e-6;
            let last = legs.len() - 1;
            let keep_last = (legs[last].f0 - legs[last].f1).abs() > 1e-6;
            if !keep_last && legs.len() > 1 {
                legs.pop();
            }
            if !keep_first && legs.len() > 1 {
                legs.remove(0);
            }
        }
        Some((source, target, legs, best.0))
    })
}
