//! Repairs applied after the graph is cut: platform polygons that OSM draws
//! next to a sidewalk without a shared node are joined to the network by short
//! connector edges, and fragments too small to matter are removed so nothing
//! snaps onto an island it cannot leave.

use crate::build::Builder;
use crate::read::{Ways, NO_IDX};
use crate::tags::{R_CARR_RAIL, R_CARR_ROAD, R_CARR_TRAM};
use kante_core::geo::{project_on_segment, LatLon};
use kante_core::walk::*;
use rayon::prelude::*;
use rustc_hash::{FxHashMap, FxHashSet};

/// Longest connector made between a platform fragment and the network.
pub const STITCH_MAX_M: f32 = 25.0;
/// Components at least this long are never treated as fragments.
pub const ANCHOR_M: f64 = 2000.0;
// (the length of a component's ways, see `components_with`)
/// Components shorter than this are removed after stitching.
pub const PRUNE_BELOW_M: f64 = 150.0;

const CELL: f32 = 32.0;

#[inline]
fn cell(p: LatLon) -> (i32, i32) {
    let (x, y) = p.xy();
    ((x / CELL).floor() as i32, (y / CELL).floor() as i32)
}

fn cells_of(a: LatLon, b: LatLon, pad: f32) -> impl Iterator<Item = (i32, i32)> {
    let (ax, ay) = a.xy();
    let (bx, by) = b.xy();
    let x0 = ((ax.min(bx) - pad) / CELL).floor() as i32;
    let x1 = ((ax.max(bx) + pad) / CELL).floor() as i32;
    let y0 = ((ay.min(by) - pad) / CELL).floor() as i32;
    let y1 = ((ay.max(by) + pad) / CELL).floor() as i32;
    (x0..=x1).flat_map(move |x| (y0..=y1).map(move |y| (x, y)))
}

/// Component id per node (edges marked dead are ignored), with length and
/// "contains a platform" per component. The length for telling a platform
/// fragment from the network ([`ANCHOR_M`]) is [`fragment_len`].
pub(crate) fn components(b: &Builder) -> (Vec<u32>, Vec<f64>, Vec<bool>) {
    let (comp, len, plat, _) = components_with(b);
    (comp, len, plat)
}

/// [`components`] with each component's length of ways: without the straight
/// lines across platform polygons (made by `join_inside` every 20 m along a
/// long platform, and the polygon's own diagonals), which would make a long
/// island platform look like a piece of the network and leave it unstitched.
fn components_with(b: &Builder) -> (Vec<u32>, Vec<f64>, Vec<bool>, Vec<f64>) {
    let n = b.gpos.len();
    let mut parent: Vec<u32> = (0..n as u32).collect();
    fn find(p: &mut [u32], mut x: u32) -> u32 {
        while p[x as usize] != x {
            p[x as usize] = p[p[x as usize] as usize];
            x = p[x as usize];
        }
        x
    }
    for (i, e) in b.edges.iter().enumerate() {
        if b.dead[i] {
            continue;
        }
        let (x, y) = (find(&mut parent, e.a), find(&mut parent, e.b));
        if x != y {
            parent[x.max(y) as usize] = x.min(y);
        }
    }
    let mut id = vec![NO_IDX; n];
    let mut comp = vec![0u32; n];
    let mut k = 0u32;
    for i in 0..n as u32 {
        let r = find(&mut parent, i);
        if id[r as usize] == NO_IDX {
            id[r as usize] = k;
            k += 1;
        }
        comp[i as usize] = id[r as usize];
    }
    let mut len = vec![0f64; k as usize];
    let mut ways = vec![0f64; k as usize];
    let mut plat = vec![false; k as usize];
    for (i, e) in b.edges.iter().enumerate() {
        if b.dead[i] {
            continue;
        }
        let c = comp[e.a as usize] as usize;
        len[c] += e.len_dm as f64 * 0.1;
        if !(e.kind == EdgeKind::Platform && e.flags & EF_AREA != 0) {
            ways[c] += e.len_dm as f64 * 0.1;
        }
        if e.kind == EdgeKind::Platform {
            plat[c] = true;
        }
    }
    (comp, len, plat, ways)
}

#[inline]
fn ground(l: Level2) -> Level2 {
    if l == LEVEL_NONE {
        0
    } else {
        l
    }
}

#[derive(Clone, Copy)]
struct Cand {
    comp: u32,
    node: u32,
    edge: u32,
    seg: u32,
    t: f32,
    d: f32,
    cost: f32,
}

fn seg_cross(p: LatLon, q: LatLon, u: LatLon, v: LatLon) -> bool {
    // planar orientation test in a frame local to p
    let k = (p.lat as f64 * 1e-7).to_radians().cos();
    let xy = |a: LatLon| ((a.lon - p.lon) as f64 * k, (a.lat - p.lat) as f64);
    let (p2, q2, u2, v2) = ((0.0, 0.0), xy(q), xy(u), xy(v));
    let o = |a: (f64, f64), b: (f64, f64), c: (f64, f64)| (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0);
    let (d1, d2, d3, d4) = (o(p2, q2, u2), o(p2, q2, v2), o(u2, v2, p2), o(u2, v2, q2));
    ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0)) && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0))
}

/// Join platform fragments to the network. One round; returns the number of
/// fragments joined.
pub(crate) fn stitch_round(b: &mut Builder, ways: &Ways, keep: &[bool]) -> u64 {
    let (comp, _, cplat, clen) = components_with(b);
    // fragment nodes with the level they stand on
    let mut frag_level: FxHashMap<u32, Level2> = FxHashMap::default();
    for (i, e) in b.edges.iter().enumerate() {
        if b.dead[i] {
            continue;
        }
        let c = comp[e.a as usize] as usize;
        if cplat[c] && clen[c] < ANCHOR_M {
            frag_level.entry(e.a).or_insert(ground(e.level_a));
            frag_level.entry(e.b).or_insert(ground(e.level_b));
        }
    }
    if frag_level.is_empty() {
        return 0;
    }
    let mut grid: FxHashMap<(i32, i32), Vec<u32>> = FxHashMap::default();
    for &n in frag_level.keys() {
        grid.entry(cell(b.gpos[n as usize])).or_default().push(n);
    }
    for v in grid.values_mut() {
        v.sort_unstable();
    }

    // every (fragment node, network edge) pair within reach
    let edges = &b.edges;
    let (gpos, geom, dead) = (&b.gpos, &b.geom, &b.dead);
    let mut cands: Vec<Cand> = (0..edges.len() as u32)
        .into_par_iter()
        .flat_map_iter(|ei| {
            let e = &edges[ei as usize];
            let mut out: Vec<Cand> = Vec::new();
            let ec = comp[e.a as usize];
            if dead[ei as usize]
                || clen[ec as usize] < ANCHOR_M
                || e.level_a != e.level_b
                || matches!(e.kind, EdgeKind::Lift | EdgeKind::Steps | EdgeKind::Escalator)
            {
                return out;
            }
            let lv = ground(e.level_a);
            let pen = match e.kind {
                EdgeKind::Road => 3.0,
                EdgeKind::RoadBusy => 6.0,
                _ => 0.0,
            };
            let g = &geom[e.geom_off as usize..e.geom_off as usize + e.geom_len as usize];
            for (si, w) in g.windows(2).enumerate() {
                for c in cells_of(w[0], w[1], STITCH_MAX_M + 2.0) {
                    let Some(ns) = grid.get(&c) else { continue };
                    for &n in ns {
                        if frag_level[&n] != lv {
                            continue;
                        }
                        let (t, d) = project_on_segment(&gpos[n as usize], &w[0], &w[1]);
                        if d <= STITCH_MAX_M {
                            match out.iter_mut().find(|x| x.node == n) {
                                Some(x) if x.d <= d => {}
                                Some(x) => *x = Cand { comp: comp[n as usize], node: n, edge: ei, seg: si as u32, t, d, cost: d + pen },
                                None => out.push(Cand { comp: comp[n as usize], node: n, edge: ei, seg: si as u32, t, d, cost: d + pen }),
                            }
                        }
                    }
                }
            }
            out
        })
        .collect();
    if cands.is_empty() {
        return 0;
    }
    cands.sort_by(|x, y| x.comp.cmp(&y.comp).then(x.cost.partial_cmp(&y.cost).unwrap()).then(x.node.cmp(&y.node)).then(x.edge.cmp(&y.edge)));

    // carriageway segments near fragments, to avoid connectors across roads and tracks
    let marked: FxHashSet<(i32, i32)> = grid.keys().flat_map(|&(x, y)| (-1..=1).flat_map(move |dx| (-1..=1).map(move |dy| (x + dx, y + dy)))).collect();
    let mut cgrid: FxHashMap<(i32, i32), Vec<(LatLon, LatLon, u8)>> = FxHashMap::default();
    for (i, w) in ways.recs.iter().enumerate() {
        let roles = w.class.roles & (R_CARR_ROAD | R_CARR_TRAM | R_CARR_RAIL);
        if !keep[i] || roles == 0 {
            continue;
        }
        let kind = if roles & R_CARR_RAIL != 0 {
            2u8
        } else if roles & R_CARR_TRAM != 0 {
            1
        } else {
            0
        };
        let refs = ways.refs_of(w);
        for s in refs.windows(2) {
            let (p, q) = (b.nodes.coords[s[0] as usize], b.nodes.coords[s[1] as usize]);
            if p.is_none() || q.is_none() {
                continue;
            }
            for c in cells_of(p, q, 0.0) {
                if marked.contains(&c) {
                    cgrid.entry(c).or_default().push((p, q, kind));
                }
            }
        }
    }
    let crossing = |p: LatLon, q: LatLon| -> (bool, bool, bool) {
        let mut r = (false, false, false);
        for c in cells_of(p, q, 0.0) {
            if let Some(v) = cgrid.get(&c) {
                for &(u, w, kind) in v {
                    if seg_cross(p, q, u, w) {
                        match kind {
                            0 => r.0 = true,
                            1 => r.1 = true,
                            _ => r.2 = true,
                        }
                    }
                }
            }
        }
        r
    };
    let landing = |b: &Builder, c: &Cand| -> LatLon {
        let e = &b.edges[c.edge as usize];
        let g = &b.geom[e.geom_off as usize..e.geom_off as usize + e.geom_len as usize];
        g[c.seg as usize].lerp(&g[c.seg as usize + 1], c.t)
    };

    // choose up to three connectors per fragment
    let mut chosen: Vec<Cand> = Vec::new();
    let mut joined = 0u64;
    let mut i = 0;
    while i < cands.len() {
        let mut j = i;
        while j < cands.len() && cands[j].comp == cands[i].comp {
            j += 1;
        }
        let mut top: Vec<(Cand, LatLon)> = Vec::new();
        for c in &cands[i..j.min(i + 40)] {
            let land = landing(b, c);
            let (road, tram, rail) = crossing(b.gpos[c.node as usize], land);
            if rail {
                continue;
            }
            let mut c = *c;
            c.cost += if road { 20.0 } else { 0.0 } + if tram { 12.0 } else { 0.0 };
            top.push((c, land));
        }
        top.sort_by(|x, y| x.0.cost.partial_cmp(&y.0.cost).unwrap());
        let mut picked: Vec<(Cand, LatLon)> = Vec::new();
        for (c, land) in top {
            if picked.len() >= 3 {
                break;
            }
            if let Some(first) = picked.first() {
                if c.cost > first.0.cost + 10.0 {
                    break;
                }
            }
            let far = picked.iter().all(|(pc, pl)| b.gpos[pc.node as usize].dist_m(&b.gpos[c.node as usize]) >= 15.0 && pl.dist_m(&land) >= 8.0);
            if far {
                picked.push((c, land));
            }
        }
        if !picked.is_empty() {
            joined += 1;
        }
        chosen.extend(picked.into_iter().map(|x| x.0));
        i = j;
    }

    // apply: split target edges from their far end backwards so earlier
    // segment indices stay valid
    chosen.sort_by(|x, y| x.edge.cmp(&y.edge).then(y.seg.cmp(&x.seg)).then(y.t.partial_cmp(&x.t).unwrap()));
    for c in chosen {
        let land = landing(b, &c);
        let e = b.edges[c.edge as usize];
        let to = if land.dist_m(&b.gpos[e.a as usize]) < 1.5 {
            e.a
        } else if land.dist_m(&b.gpos[e.b as usize]) < 1.5 {
            e.b
        } else {
            b.split_edge(c.edge, c.seg, land)
        };
        let from = c.node;
        if from == to {
            continue;
        }
        let (pa, pb) = (b.gpos[from as usize], b.gpos[to as usize]);
        let geom_off = b.geom.len() as u32;
        b.geom.push(pa);
        b.geom.push(pb);
        b.edges.push(WalkEdge {
            a: from,
            b: to,
            geom_off,
            geom_len: 2,
            kind: EdgeKind::Footway,
            level_a: e.level_a,
            level_b: e.level_a,
            steps: 0,
            flags: e.flags & (EF_INDOOR | EF_TUNNEL | EF_COVERED),
            len_dm: (pa.dist_m(&pb) * 10.0).round() as u32,
            name: 0,
        });
        b.push_meta(0, NO_IDX, (0.0, 1.0), 0);
        b.stats.stitch_edges += 1;
    }
    joined
}

/// Remove components shorter than [`PRUNE_BELOW_M`].
pub(crate) fn prune(b: &mut Builder) {
    let (comp, clen, _) = components(b);
    let mut gone: FxHashSet<u32> = FxHashSet::default();
    for i in 0..b.edges.len() {
        if b.dead[i] {
            continue;
        }
        let c = comp[b.edges[i].a as usize];
        if clen[c as usize] < PRUNE_BELOW_M {
            b.dead[i] = true;
            b.stats.pruned_edges += 1;
            gone.insert(c);
        }
    }
    b.stats.pruned_components = gone.len() as u64;
}
