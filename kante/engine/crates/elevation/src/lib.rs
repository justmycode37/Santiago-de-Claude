//! kante-elevation — the slopes of the walking network ([`kante_core::Slopes`]) from a terrain
//! model. The model of what a slope costs is in `kante_core::slope`.
//!
//! # Which edges have a slope
//!
//! - **Out of doors on the ground** (footways, sidewalks, crossings, paths, pedestrian streets and
//!   squares, roads; not indoors, not on another floor, not on a bridge or in a tunnel): heights evenly
//!   along the edge, at most [`SAMPLE_M`] apart, their ends the heights of its two nodes, smoothed once ([1 2 1]) so
//!   that a way drawn a metre beside its real place on a hillside does not climb and fall; grades are
//!   clamped to ±[`MAX_GRADE`].
//! - **Bridges and tunnels**: the terrain under a bridge (the river) and above a tunnel (the hill) is
//!   not the way's height. Their nodes that touch no edge on the ground get heights interpolated
//!   between the nodes that do (inverse distance along the bridge, so linear along a chain), and each
//!   such edge climbs evenly between its two ends.
//! - **Stairs out of doors**: the height between their two ends is climbed (at most their length, and
//!   0.2 m a step when the steps are counted), in the direction the map says is up when it says so. Their
//!   time is `STAIRS_FACTOR`'s; climbing them is route-choice effort (`STAIRS_EFFORT_PER_M`).
//! - Everything else (corridors, platforms, lifts, escalators, ways inside or on other floors) is flat.

pub mod dem;

use dem::{wgs84_to_lv95, Terrain};
use kante_core::*;
use rayon::prelude::*;

/// Spacing of the height samples along an edge (the terrain model's cell size).
pub const SAMPLE_M: f32 = 10.0;
/// Steeper is taken as a fault of the terrain model under the way, not the way.
pub const MAX_GRADE: f32 = 0.35;

#[derive(Clone, Copy, Debug, Default)]
pub struct SlopeStats {
    /// Edges on the ground, sampled along the terrain.
    pub ground: usize,
    /// Bridge and tunnel edges, interpolated between their ends.
    pub spans: usize,
    /// Of those, edges in a bridge or tunnel with no end on the ground (flat).
    pub spans_unanchored: usize,
    pub stairs: usize,
    /// Nodes the terrain model has no height for (outside it).
    pub no_height: usize,
    /// Segments steeper than [`MAX_GRADE`], clamped.
    pub clamped: usize,
    /// Metres climbed over all ground edges, one way (a → b).
    pub climb_m: f64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Class {
    Flat,
    Ground,
    Span,
    Stairs,
}

fn class_of(ed: &WalkEdge) -> Class {
    let on_ground_level = ed.level_a == ed.level_b && (ed.level_a == LEVEL_NONE || ed.level_a == 0);
    let outdoor = ed.flags & EF_INDOOR == 0;
    match ed.kind {
        EdgeKind::Footway | EdgeKind::Sidewalk | EdgeKind::Crossing | EdgeKind::Path | EdgeKind::Pedestrian | EdgeKind::Road | EdgeKind::RoadBusy
            if outdoor && on_ground_level =>
        {
            if ed.flags & (EF_BRIDGE | EF_TUNNEL) != 0 {
                Class::Span
            } else {
                Class::Ground
            }
        }
        EdgeKind::Steps if outdoor && ed.flags & (EF_BRIDGE | EF_TUNNEL) == 0 && ed.level_a == LEVEL_NONE && ed.level_b == LEVEL_NONE => Class::Stairs,
        _ => Class::Flat,
    }
}

/// Sums of one direction of an edge, in metres.
#[derive(Default, Clone, Copy)]
struct Acc {
    time: f32,
    effort: f32,
    steep: f32,
}

impl Acc {
    fn add(&mut self, run: f32, g: f32) {
        self.time += run * (slope_time_factor(g) - 1.0);
        self.effort += run * slope_effort(g);
        self.steep += run * slope_steep(g);
    }
}

#[inline]
fn dm(x: f32) -> u16 {
    (x * 10.0).round().clamp(0.0, 65_535.0) as u16
}

fn finish(fwd: Acc, back: Acc, up: f32, down: f32) -> EdgeSlope {
    EdgeSlope {
        up_dm: dm(up),
        down_dm: dm(down),
        time_dm: [dm(fwd.time), dm(back.time)],
        effort_dm: [dm(fwd.effort), dm(back.effort)],
        steep_dm: [dm(fwd.steep), dm(back.steep)],
    }
}

/// Slopes along a height profile: `h[i]` every `run` metres.
fn profile(h: &[f32], run: f32, clamped: &mut usize) -> EdgeSlope {
    let (mut fwd, mut back, mut up, mut down) = (Acc::default(), Acc::default(), 0f32, 0f32);
    let n = h.len();
    if run < 0.05 {
        return EdgeSlope::default();
    }
    for i in 0..n.saturating_sub(1) {
        let mut g = (h[i + 1] - h[i]) / run;
        if g.abs() > MAX_GRADE {
            *clamped += 1;
            g = g.clamp(-MAX_GRADE, MAX_GRADE);
        }
        let dh = g * run;
        if dh > 0.0 {
            up += dh;
        } else {
            down -= dh;
        }
        fwd.add(run, g);
        back.add(run, -g);
    }
    finish(fwd, back, up, down)
}

/// Point at `d` metres along a polyline with cumulative lengths `cum`.
fn along(pts: &[LatLon], cum: &[f32], d: f32) -> LatLon {
    let i = cum.partition_point(|&c| c < d).clamp(1, pts.len() - 1);
    let (a, b) = (pts[i - 1], pts[i]);
    let seg = cum[i] - cum[i - 1];
    let f = if seg > 0.0 { ((d - cum[i - 1]) / seg).clamp(0.0, 1.0) } else { 0.0 };
    LatLon { lat: a.lat + ((b.lat - a.lat) as f32 * f).round() as i32, lon: a.lon + ((b.lon - a.lon) as f32 * f).round() as i32 }
}

/// The slopes of every edge of `g`.
pub fn build(g: &WalkGraph, terrain: &dyn Terrain) -> (Vec<EdgeSlope>, SlopeStats) {
    let mut st = SlopeStats::default();
    let classes: Vec<Class> = g.edges.iter().map(class_of).collect();
    let n = g.nodes.len();

    // ---- node heights: from the terrain where a node touches the ground, interpolated on bridges and in tunnels
    let pts: Vec<(f64, f64)> = g.nodes.par_iter().map(wgs84_to_lv95).collect();
    let mut hn = terrain.heights(&pts);
    drop(pts);
    st.no_height = hn.iter().filter(|h| !h.is_finite()).count();
    let mut anchor = vec![false; n];
    for (e, ed) in g.edges.iter().enumerate() {
        if matches!(classes[e], Class::Ground | Class::Stairs) {
            anchor[ed.a as usize] = true;
            anchor[ed.b as usize] = true;
        }
    }
    let span_ok = interpolate_spans(g, &classes, &anchor, &mut hn);

    // ---- edges on the ground: sampled along their geometry
    let ground: Vec<u32> = (0..g.edges.len() as u32).filter(|&e| classes[e as usize] == Class::Ground).collect();
    st.ground = ground.len();
    let mut out = vec![EdgeSlope::default(); g.edges.len()];
    let mut clamped = 0usize;
    // in batches, so the sample points of the whole country are never held at once
    for chunk in ground.chunks(400_000) {
        // per edge: (length, number of steps, offset of its interior samples)
        let mut plan: Vec<(f32, usize, usize)> = Vec::with_capacity(chunk.len());
        let mut sample_pts: Vec<(f64, f64)> = Vec::new();
        for &e in chunk {
            let pts = g.edge_geom(e);
            let mut cum = Vec::with_capacity(pts.len());
            cum.push(0f32);
            for w in pts.windows(2) {
                cum.push(cum.last().unwrap() + w[0].dist_m(&w[1]));
            }
            let len = *cum.last().unwrap();
            // evenly spaced, so that smoothing keeps an even grade even
            let steps = ((len / SAMPLE_M).ceil() as usize).max(1);
            plan.push((len, steps, sample_pts.len()));
            for k in 1..steps {
                sample_pts.push(wgs84_to_lv95(&along(pts, &cum, len * k as f32 / steps as f32)));
            }
        }
        let hs = terrain.heights(&sample_pts);
        let res: Vec<(EdgeSlope, usize)> = chunk
            .par_iter()
            .zip(&plan)
            .map(|(&e, &(len, steps, off))| {
                let ed = &g.edges[e as usize];
                let (ha, hb) = (hn[ed.a as usize], hn[ed.b as usize]);
                if !(ha.is_finite() && hb.is_finite()) || len < 0.05 {
                    return (EdgeSlope::default(), 0);
                }
                let mut h = Vec::with_capacity(steps + 1);
                h.push(ha);
                for k in 1..steps {
                    let v = hs[off + k - 1];
                    // a sample with no height: on the straight line between the ends
                    h.push(if v.is_finite() { v } else { ha + (hb - ha) * (k as f32 / steps as f32) });
                }
                h.push(hb);
                // smooth the inside once; the ends stay the nodes' heights, so edges meet
                if h.len() > 2 {
                    let raw = h.clone();
                    for k in 1..h.len() - 1 {
                        h[k] = 0.25 * raw[k - 1] + 0.5 * raw[k] + 0.25 * raw[k + 1];
                    }
                }
                let mut c = 0usize;
                let s = profile(&h, len / steps as f32, &mut c);
                (s, c)
            })
            .collect();
        for (&e, (s, c)) in chunk.iter().zip(res) {
            out[e as usize] = s;
            clamped += c;
        }
    }
    st.clamped = clamped;

    // ---- bridges and tunnels: evenly between their ends; stairs: the height between their ends
    for (e, ed) in g.edges.iter().enumerate() {
        let (ha, hb) = (hn[ed.a as usize], hn[ed.b as usize]);
        let len = ed.len_m();
        match classes[e] {
            Class::Span => {
                st.spans += 1;
                if !span_ok[e] {
                    st.spans_unanchored += 1;
                    continue;
                }
                if ha.is_finite() && hb.is_finite() && len >= 0.05 {
                    let mut c = 0usize;
                    out[e] = profile(&[ha, hb], len, &mut c);
                    st.clamped += c;
                }
            }
            Class::Stairs => {
                st.stairs += 1;
                if !(ha.is_finite() && hb.is_finite()) {
                    continue;
                }
                let mut rise = (hb - ha).abs().min(len.max(0.5));
                if ed.steps > 0 {
                    rise = rise.min(ed.steps as f32 * 0.2);
                }
                let up_ab = if ed.flags & EF_UP_AB != 0 {
                    true
                } else if ed.flags & EF_UP_BA != 0 {
                    false
                } else {
                    hb >= ha
                };
                let effort = rise * STAIRS_EFFORT_PER_M;
                // the ramp beside them, for those who take it: a wheelchair minds its grade
                let steep = if len >= 0.5 { len * slope_steep(rise / len) } else { 0.0 };
                let (fwd, back) = if up_ab {
                    (Acc { time: 0.0, effort, steep }, Acc { time: 0.0, effort: 0.0, steep })
                } else {
                    (Acc { time: 0.0, effort: 0.0, steep }, Acc { time: 0.0, effort, steep })
                };
                out[e] = if up_ab { finish(fwd, back, rise, 0.0) } else { finish(fwd, back, 0.0, rise) };
            }
            _ => {}
        }
    }
    st.climb_m = out.iter().zip(&classes).filter(|(_, c)| **c == Class::Ground).map(|(s, _)| s.up_dm as f64 * 0.1).sum();
    (out, st)
}

/// Heights of the nodes of bridges and tunnels that touch no edge on the ground, from those that do; returns,
/// per edge, whether its bridge or tunnel has any such end (one with none stays flat).
fn interpolate_spans(g: &WalkGraph, classes: &[Class], anchor: &[bool], hn: &mut [f32]) -> Vec<bool> {
    let n = g.nodes.len();
    // components of the span edges (union-find over their nodes)
    let mut parent: Vec<u32> = (0..n as u32).collect();
    let spans: Vec<u32> = (0..g.edges.len() as u32).filter(|&e| classes[e as usize] == Class::Span).collect();
    for &e in &spans {
        let ed = &g.edges[e as usize];
        let (ra, rb) = (find(&mut parent, ed.a), find(&mut parent, ed.b));
        if ra != rb {
            parent[ra as usize] = rb;
        }
    }
    // nodes of each component
    let mut comp: rustc_hash::FxHashMap<u32, Vec<u32>> = rustc_hash::FxHashMap::default();
    for &e in &spans {
        let ed = &g.edges[e as usize];
        for v in [ed.a, ed.b] {
            let r = find(&mut parent, v);
            comp.entry(r).or_default().push(v);
        }
    }
    let mut anchored_root: rustc_hash::FxHashSet<u32> = rustc_hash::FxHashSet::default();
    let mut new_h: Vec<(u32, f32)> = Vec::new();
    for (root, mut nodes) in comp {
        nodes.sort_unstable();
        nodes.dedup();
        let anchors: Vec<u32> = nodes.iter().copied().filter(|&v| anchor[v as usize] && hn[v as usize].is_finite()).collect();
        if anchors.is_empty() {
            for &v in &nodes {
                if !anchor[v as usize] {
                    hn[v as usize] = f32::NAN;
                }
            }
            continue;
        }
        anchored_root.insert(root);
        let inner: Vec<u32> = nodes.iter().copied().filter(|&v| !anchor[v as usize]).collect();
        if inner.is_empty() {
            continue;
        }
        if anchors.len() > 16 || nodes.len() > 20_000 {
            // a large network of tunnels: the mean of its ends
            let m = anchors.iter().map(|&v| hn[v as usize]).sum::<f32>() / anchors.len() as f32;
            new_h.extend(inner.iter().map(|&v| (v, m)));
            continue;
        }
        // distance along the component's span edges from each anchor to each inner node
        let local: rustc_hash::FxHashMap<u32, usize> = nodes.iter().enumerate().map(|(i, &v)| (v, i)).collect();
        let mut sum_w = vec![0f64; nodes.len()];
        let mut sum_wh = vec![0f64; nodes.len()];
        for &a in &anchors {
            let dist = span_dijkstra(g, classes, &local, &nodes, a);
            let ha = hn[a as usize] as f64;
            for (i, d) in dist.iter().enumerate() {
                if d.is_finite() {
                    // (a span of no length from the anchor: its height)
                    let w = 1.0 / d.max(0.01) as f64;
                    sum_w[i] += w;
                    sum_wh[i] += w * ha;
                }
            }
        }
        for &v in &inner {
            let i = local[&v];
            new_h.push((v, if sum_w[i] > 0.0 { (sum_wh[i] / sum_w[i]) as f32 } else { f32::NAN }));
        }
    }
    for (v, h) in new_h {
        hn[v as usize] = h;
    }
    g.edges
        .iter()
        .enumerate()
        .map(|(e, ed)| classes[e] == Class::Span && anchored_root.contains(&find(&mut parent, ed.a)))
        .collect()
}

/// Union-find root, halving the path.
fn find(p: &mut [u32], mut x: u32) -> u32 {
    while p[x as usize] != x {
        p[x as usize] = p[p[x as usize] as usize];
        x = p[x as usize];
    }
    x
}

/// Shortest distances (metres) along span edges from `src` to each of `nodes` (indexed by `local`).
fn span_dijkstra(g: &WalkGraph, classes: &[Class], local: &rustc_hash::FxHashMap<u32, usize>, nodes: &[u32], src: u32) -> Vec<f32> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    let mut dist = vec![f32::INFINITY; nodes.len()];
    let mut heap = BinaryHeap::new();
    dist[local[&src]] = 0.0;
    heap.push(Reverse((0u32, src)));
    while let Some(Reverse((dcm, u))) = heap.pop() {
        let d = dcm as f32 * 0.01;
        if d > dist[local[&u]] + 1e-3 {
            continue;
        }
        for &e in g.incident(u) {
            if classes[e as usize] != Class::Span {
                continue;
            }
            let ed = &g.edges[e as usize];
            let v = ed.other(u);
            let Some(&iv) = local.get(&v) else { continue };
            let nd = d + ed.len_m();
            if nd + 1e-3 < dist[iv] {
                dist[iv] = nd;
                heap.push(Reverse(((nd * 100.0) as u32, v)));
            }
        }
    }
    dist
}

#[cfg(test)]
mod tests;
