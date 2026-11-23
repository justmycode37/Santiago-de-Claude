//! Turns the classified ways and nodes into a compact `WalkGraph` and the
//! `OsmExtract` (platforms, carriageways).

use crate::area::{self, Frame, P};
use crate::read::*;
use crate::tags::*;
use kante_core::geo::{BBox, LatLon};
use kante_core::walk::*;
use rayon::prelude::*;
use rustc_hash::{FxHashMap, FxHashSet};
use std::ops::Range;

/// Counters describing one import; printed by the `osm-import` binary.
#[derive(Clone, Debug, Default)]
pub struct BuildStats {
    pub relations_read: u64,
    pub ways_read: u64,
    pub nodes_read: u64,
    /// Ways that produced walk edges.
    pub walk_ways: u64,
    /// Kept ways referencing nodes that are not in the file (cut there).
    pub ways_missing_nodes: u64,
    pub area_polygons: u64,
    pub area_edges: u64,
    pub lift_nodes: u64,
    pub lift_ways: u64,
    pub lift_edges: u64,
    /// Lifts that touch fewer than two floors of the network (no Lift edge made).
    pub lifts_unconnected: u64,
    pub lifts_private: u64,
    /// Lift nodes whose ways carry no level/layer difference: every way was
    /// treated as its own floor.
    pub lifts_split_per_way: u64,
    pub multi_level_ways: u64,
    pub oriented_by_incline: u64,
    pub oriented_by_neighbours: u64,
    /// Multi-level ways whose direction is only a guess from the tag order.
    pub unoriented: u64,
    pub blocked_nodes: u64,
    pub closed_loops_split: u64,
    /// Platform fragments joined to the network by a connector edge.
    pub stitched_components: u64,
    pub stitch_edges: u64,
    /// Small disconnected fragments removed (edges).
    pub pruned_edges: u64,
    pub pruned_components: u64,
    pub secs_relations: f32,
    pub secs_ways: f32,
    pub secs_nodes: f32,
    pub secs_build: f32,
    /// Lift outlines drawn one per floor that were joined into the lift below or above them.
    pub lifts_stacked: u64,
    /// Straight lines from a path's end inside a platform or square to the area's outline.
    pub inside_joins: u64,
}

pub struct Built {
    pub graph: WalkGraph,
    pub extract: OsmExtract,
    pub stats: BuildStats,
}

/// CSR incidence lists.
pub struct Csr {
    pub off: Vec<u32>,
    pub adj: Vec<u32>,
}

impl Csr {
    pub fn new(n_nodes: usize, edges: &[WalkEdge]) -> Csr {
        let mut off = vec![0u32; n_nodes + 1];
        for e in edges {
            off[e.a as usize + 1] += 1;
            off[e.b as usize + 1] += 1;
        }
        for i in 0..n_nodes {
            off[i + 1] += off[i];
        }
        let mut pos = off.clone();
        let mut adj = vec![0u32; edges.len() * 2];
        for (i, e) in edges.iter().enumerate() {
            adj[pos[e.a as usize] as usize] = i as u32;
            pos[e.a as usize] += 1;
            adj[pos[e.b as usize] as usize] = i as u32;
            pos[e.b as usize] += 1;
        }
        Csr { off, adj }
    }
    #[inline]
    pub fn incident(&self, n: u32) -> &[u32] {
        &self.adj[self.off[n as usize] as usize..self.off[n as usize + 1] as usize]
    }
}

/// Building outlines that straight lines across an area may not cross (a kiosk standing in a square).
pub struct Obstacles {
    rings: Vec<Vec<LatLon>>,
    grid: FxHashMap<(i32, i32), Vec<u32>>,
}

impl Obstacles {
    const CELL: i32 = 5000; // 1e-7 degrees: about 55 × 38 m
    pub fn new(b: &crate::buildings::BuildingsRaw) -> Self {
        let rings: Vec<Vec<LatLon>> = (0..b.len() as u32).map(|i| b.ring_of(i).to_vec()).collect();
        let mut grid: FxHashMap<(i32, i32), Vec<u32>> = FxHashMap::default();
        for (i, r) in rings.iter().enumerate() {
            let mut bb = BBox::empty();
            r.iter().for_each(|p| bb.extend(p));
            let (y0, y1, x0, x1) = (bb.min.lat.div_euclid(Self::CELL), bb.max.lat.div_euclid(Self::CELL), bb.min.lon.div_euclid(Self::CELL), bb.max.lon.div_euclid(Self::CELL));
            if (y1 - y0 + 1) * (x1 - x0 + 1) > 400 {
                continue;
            }
            for y in y0..=y1 {
                for x in x0..=x1 {
                    grid.entry((y, x)).or_default().push(i as u32);
                }
            }
        }
        Obstacles { rings, grid }
    }
    /// The buildings that stand in an area (given as rings in `frame`): not one the whole area lies in (a station hall).
    fn within(&self, bb: &BBox, frame: &Frame, area: &[Vec<P>]) -> Vec<Vec<P>> {
        let mut ids: Vec<u32> = Vec::new();
        for y in bb.min.lat.div_euclid(Self::CELL)..=bb.max.lat.div_euclid(Self::CELL) {
            for x in bb.min.lon.div_euclid(Self::CELL)..=bb.max.lon.div_euclid(Self::CELL) {
                if let Some(v) = self.grid.get(&(y, x)) {
                    ids.extend_from_slice(v);
                }
            }
        }
        ids.sort_unstable();
        ids.dedup();
        let outer = &area[0];
        ids.into_iter()
            .filter_map(|i| {
                let r: Vec<P> = self.rings[i as usize].iter().map(|p| frame.to_xy(*p)).collect();
                let hall = outer.iter().filter(|p| area::point_in_rings(**p, std::slice::from_ref(&r)) || area::near(**p, &r, 1.0)).count() * 10 >= outer.len() * 8;
                (!hall).then_some(r)
            })
            .collect()
    }
}

/// An outdoor square on the street (not a platform, not indoors, below or above ground): buildings standing in it block it.
fn open_square(c: &WayClass) -> bool {
    c.kind != EdgeKind::Platform && c.flags & (EF_INDOOR | EF_TUNNEL | EF_BRIDGE | EF_COVERED) == 0 && matches!(c.level.first, LEVEL_NONE | 0)
}

struct AreaDef {
    id: i64,
    class: WayClass,
    name: String,
    rings: Vec<Vec<u32>>,
    /// Record index of the way, or `NO_IDX` for a relation.
    way: u32,
    rel: u32,
}

/// Candidate points of an area and the straight edges between them, as pairs
/// of needed-node indices.
fn area_pairs(a: &AreaDef, coords: &[LatLon], cnt: &[u8], obstacles: Option<&Obstacles>) -> Vec<(u32, u32)> {
    let rings_idx: Vec<Vec<u32>> = a
        .rings
        .iter()
        .map(|r| r.iter().copied().filter(|&i| !coords[i as usize].is_none()).collect::<Vec<u32>>())
        .filter(|r| r.len() >= 3)
        .collect();
    let total: usize = rings_idx.iter().map(|r| r.len()).sum();
    if rings_idx.is_empty() || total > 6000 {
        return Vec::new();
    }
    let frame = Frame::new(coords[rings_idx[0][0] as usize]);
    let rings: Vec<Vec<P>> = rings_idx.iter().map(|r| r.iter().map(|&i| frame.to_xy(coords[i as usize])).collect()).collect();
    if rings.iter().map(|r| area::signed_area(r).abs()).fold(0.0, f64::max) < 1.0 {
        return Vec::new();
    }
    let walk = a.class.roles & R_WALK != 0;
    let platform = a.class.kind == EdgeKind::Platform;
    // A node of the outline is a connection when another walkable way uses it
    // (the outline itself accounts for one use when it is walkable).
    let need = if walk { 2 } else { 1 };
    let mut seen: FxHashSet<u32> = FxHashSet::default();
    let mut cands: Vec<(u32, u32)> = Vec::new();
    for (ri, r) in rings_idx.iter().enumerate() {
        for (vi, &i) in r.iter().enumerate() {
            if cnt[i as usize] >= need && seen.insert(i) {
                cands.push((ri as u32, vi as u32));
            }
        }
    }
    if cands.is_empty() && !platform {
        return Vec::new();
    }
    if cands.len() > 120 {
        let step = cands.len().div_ceil(120);
        cands = cands.into_iter().step_by(step).collect();
    }
    for (r, v, _) in area::corner_vertices(&rings, 30.0).into_iter().take(12) {
        if seen.insert(rings_idx[r as usize][v as usize]) {
            cands.push((r, v));
        }
    }
    if platform {
        if total <= 10 {
            for (ri, r) in rings_idx.iter().enumerate() {
                for (vi, &i) in r.iter().enumerate() {
                    if seen.insert(i) {
                        cands.push((ri as u32, vi as u32));
                    }
                }
            }
        } else {
            // the two ends of the platform
            let ring = &rings[0];
            let far = |from: P| -> usize {
                let mut best = (0usize, -1.0f64);
                for (i, p) in ring.iter().enumerate() {
                    let d = (p.0 - from.0).powi(2) + (p.1 - from.1).powi(2);
                    if d > best.1 {
                        best = (i, d);
                    }
                }
                best.0
            };
            let e1 = far(area::centroid(ring));
            let e2 = far(ring[e1]);
            for v in [e1, e2] {
                if seen.insert(rings_idx[0][v]) {
                    cands.push((0, v as u32));
                }
            }
        }
    }
    if cands.len() < 2 {
        return Vec::new();
    }
    // buildings standing in a square block its straight lines (a platform's roof does not)
    let blocked = match obstacles {
        Some(o) if open_square(&a.class) => {
            let mut bb = BBox::empty();
            rings_idx.iter().flatten().for_each(|&i| bb.extend(&coords[i as usize]));
            o.within(&bb, &frame, &rings)
        }
        _ => Vec::new(),
    };
    area::visibility_edges_around(&rings, &blocked, &cands, walk, 1.04)
        .into_iter()
        .map(|(i, j)| {
            let (a, b) = (cands[i as usize], cands[j as usize]);
            (rings_idx[a.0 as usize][a.1 as usize], rings_idx[b.0 as usize][b.1 as usize])
        })
        .filter(|(x, y)| x != y)
        .collect()
}

/// Paths that end inside a platform or square polygon on its floor — the head
/// of the stairs or escalator up to a platform, a footway that stops in a
/// square — are joined to the area by straight lines to the nearest points of
/// up to six of its outline edges (within 60 m, never out of the polygon or
/// across a hole). A path in a tunnel or on a bridge only meets an area that
/// is one too, so the passage under a platform is not glued to it.
///
/// A platform polygon is also crossed every 20 m along its outline: a straight
/// line from the outline to the nearest point of each other outline edge
/// within 40 m, so two points across a long island platform (the two tracks
/// of it) are joined straight, not round its far end.
fn join_inside(b: &mut Builder, areas: &[AreaDef], outline: &[Vec<u32>], area_edges: &[Range<u32>], coords: &[LatLon], obstacles: Option<&Obstacles>) -> u64 {
    const OFF_GROUND: u16 = EF_TUNNEL | EF_BRIDGE;
    const RUNG_M: f64 = 20.0;
    let ground = |l: Level2| if l == LEVEL_NONE { 0 } else { l };
    // per node: (floor, tunnel/bridge bits) of each non-area way ending or passing there
    let mut at: FxHashMap<u32, Vec<(Level2, u16)>> = FxHashMap::default();
    for e in &b.edges {
        if e.kind == EdgeKind::Lift || e.flags & EF_AREA != 0 {
            continue;
        }
        at.entry(e.a).or_default().push((ground(e.level_a), e.flags & OFF_GROUND));
        at.entry(e.b).or_default().push((ground(e.level_b), e.flags & OFF_GROUND));
    }
    let cell = |p: LatLon| ((p.lat as i64) / 3000, (p.lon as i64) / 4000); // about 33 × 30 m
    let mut grid: FxHashMap<(i64, i64), Vec<u32>> = FxHashMap::default();
    for &n in at.keys() {
        grid.entry(cell(b.gpos[n as usize])).or_default().push(n);
    }
    /// A point where an outline edge is cut: (edge, segment, t along it, position).
    type Cut = (u32, u32, f64, LatLon);
    /// One end of a new straight line: a graph node, or a cut (index into this area's cuts).
    #[derive(Clone, Copy)]
    enum End {
        Node(u32),
        Cut(usize),
    }
    let (edges, geom, gpos) = (&b.edges, &b.geom, &b.gpos);
    let plans: Vec<(u32, Vec<Cut>, Vec<(End, End)>)> = (0..areas.len())
        .into_par_iter()
        .filter_map(|ai| {
            let a = &areas[ai];
            if outline[ai].is_empty() || a.class.kind == EdgeKind::Lift || a.rings.iter().map(|r| r.len()).sum::<usize>() > 6000 {
                return None;
            }
            let pts: Vec<Vec<LatLon>> = a.rings.iter().map(|r| r.iter().map(|&i| coords[i as usize]).filter(|p| !p.is_none()).collect()).filter(|r: &Vec<LatLon>| r.len() >= 3).collect();
            if pts.is_empty() {
                return None;
            }
            let mut bb = BBox::empty();
            pts.iter().flatten().for_each(|p| bb.extend(p));
            if bb.max.dist_m(&bb.min) > 1000.0 {
                return None;
            }
            let frame = Frame::new(pts[0][0]);
            let rings: Vec<Vec<P>> = pts.iter().map(|r| r.iter().map(|p| frame.to_xy(*p)).collect()).collect();
            let blocked = match obstacles {
                Some(o) if open_square(&a.class) => o.within(&bb, &frame, &rings),
                _ => Vec::new(),
            };
            let clear = |p: P, q: P| area::segment_inside(p, q, &rings) && !area::hits_obstacle(p, q, &blocked);
            // outline edges in the local frame
            let lines: Vec<(u32, Vec<P>)> = outline[ai]
                .iter()
                .map(|&e| {
                    let ed = &edges[e as usize];
                    (e, geom[ed.geom_off as usize..ed.geom_off as usize + ed.geom_len as usize].iter().map(|p| frame.to_xy(*p)).collect())
                })
                .collect();
            // the nearest point of an outline edge to p: (distance, segment, t, point)
            let foot = |p: P, line: &[P]| -> (f64, u32, f64, P) {
                let mut best = (f64::INFINITY, 0u32, 0.0, p);
                for (si, w) in line.windows(2).enumerate() {
                    let (u, v) = (w[0], w[1]);
                    let (dx, dy) = (v.0 - u.0, v.1 - u.1);
                    let l2 = dx * dx + dy * dy;
                    let t = if l2 < 1e-9 { 0.0 } else { (((p.0 - u.0) * dx + (p.1 - u.1) * dy) / l2).clamp(0.0, 1.0) };
                    let q = (u.0 + dx * t, u.1 + dy * t);
                    let d = ((p.0 - q.0).powi(2) + (p.1 - q.1).powi(2)).sqrt();
                    if d < best.0 {
                        best = (d, si as u32, t, q);
                    }
                }
                best
            };
            let mut cuts: Vec<Cut> = Vec::new();
            let mut lines_out: Vec<(End, End)> = Vec::new();

            // paths ending inside
            let level = ground(a.class.level.first);
            let off = a.class.flags & OFF_GROUND;
            let mut own: FxHashSet<u32> = FxHashSet::default();
            for e in outline[ai].iter().copied().chain(area_edges[ai].clone()) {
                own.insert(edges[e as usize].a);
                own.insert(edges[e as usize].b);
            }
            let (c0, c1) = (cell(bb.min), cell(bb.max));
            for cy in c0.0..=c1.0 {
                for cx in c0.1..=c1.1 {
                    for &n in grid.get(&(cy, cx)).map(|v| v.as_slice()).unwrap_or(&[]) {
                        if own.contains(&n) || !at[&n].iter().any(|&(l, f)| l == level && f == off) {
                            continue;
                        }
                        let p = frame.to_xy(gpos[n as usize]);
                        if !area::point_in_rings(p, &rings) {
                            continue;
                        }
                        let mut feet: Vec<(f64, u32, u32, f64, P)> =
                            lines.iter().map(|(e, l)| (*e, foot(p, l))).filter(|(_, f)| f.0 <= 60.0 && f.0 > 0.01).map(|(e, f)| (f.0, e, f.1, f.2, f.3)).collect();
                        feet.sort_by(|x, y| x.0.total_cmp(&y.0));
                        let mut kept = 0;
                        for (_, e, si, t, q) in feet {
                            if kept >= 6 {
                                break;
                            }
                            if clear(p, q) {
                                cuts.push((e, si, t, frame.to_ll(q)));
                                lines_out.push((End::Node(n), End::Cut(cuts.len() - 1)));
                                kept += 1;
                            }
                        }
                    }
                }
            }

            // rungs across a platform
            if a.class.kind == EdgeKind::Platform {
                for (li, (e, line)) in lines.iter().enumerate() {
                    let mut walked = 0.0;
                    let mut next = RUNG_M / 2.0;
                    for (si, w) in line.windows(2).enumerate() {
                        let l = ((w[1].0 - w[0].0).powi(2) + (w[1].1 - w[0].1).powi(2)).sqrt();
                        while next < walked + l && l > 1e-6 {
                            let t = (next - walked) / l;
                            let p = (w[0].0 + (w[1].0 - w[0].0) * t, w[0].1 + (w[1].1 - w[0].1) * t);
                            next += RUNG_M;
                            let mut here: Option<usize> = None;
                            for (lj, (f, other)) in lines.iter().enumerate() {
                                if lj == li {
                                    continue;
                                }
                                let (d, sj, tj, q) = foot(p, other);
                                if !(d > 1.0 && d <= 40.0) || !clear(p, q) {
                                    continue;
                                }
                                let k = *here.get_or_insert_with(|| {
                                    cuts.push((*e, si as u32, t, frame.to_ll(p)));
                                    cuts.len() - 1
                                });
                                cuts.push((*f, sj, tj, frame.to_ll(q)));
                                lines_out.push((End::Cut(k), End::Cut(cuts.len() - 1)));
                            }
                        }
                        walked += l;
                    }
                }
            }
            (!lines_out.is_empty()).then_some((ai as u32, cuts, lines_out))
        })
        .collect();
    // cut each outline edge from its far end backwards, so the positions still to come stay on the same edge
    let mut all: Vec<(Cut, usize, usize)> = Vec::new(); // (cut, plan, index in plan)
    for (pi, (_, cuts, _)) in plans.iter().enumerate() {
        for (k, c) in cuts.iter().enumerate() {
            all.push((*c, pi, k));
        }
    }
    all.sort_by(|x, y| x.0 .0.cmp(&y.0 .0).then(y.0 .1.cmp(&x.0 .1)).then(y.0 .2.total_cmp(&x.0 .2)));
    let mut node_of: Vec<Vec<u32>> = plans.iter().map(|p| vec![u32::MAX; p.1.len()]).collect();
    let mut last: Option<(u32, u32, f64, u32)> = None; // the cut just made: (edge, seg, t, node)
    for ((e, seg, t, pos), pi, k) in all {
        if let Some((le, ls, lt, ln)) = last {
            if le == e && ls == seg && (lt - t).abs() < 1e-4 {
                node_of[pi][k] = ln;
                continue;
            }
        }
        let ed = b.edges[e as usize];
        let last_seg = ed.geom_len as u32 - 2;
        let n = if seg == 0 && t < 1e-6 {
            ed.a
        } else if seg == last_seg && t > 1.0 - 1e-6 {
            ed.b
        } else if t < 1e-6 {
            b.split_edge(e, seg - 1, pos)
        } else {
            b.split_edge(e, seg, pos)
        };
        node_of[pi][k] = n;
        last = Some((e, seg, t, n));
    }
    let mut made = 0;
    for (pi, (ai, _, lines)) in plans.iter().enumerate() {
        let a = &areas[*ai as usize];
        let name = b.name(&a.name);
        for &(x, y) in lines {
            let node = |e: End| match e {
                End::Node(n) => n,
                End::Cut(k) => node_of[pi][k],
            };
            let (na, nb) = (node(x), node(y));
            if na == nb || na == u32::MAX || nb == u32::MAX {
                continue;
            }
            let (pa, pb) = (b.gpos[na as usize], b.gpos[nb as usize]);
            let geom_off = b.geom.len() as u32;
            b.geom.push(pa);
            b.geom.push(pb);
            b.edges.push(WalkEdge {
                a: na,
                b: nb,
                geom_off,
                geom_len: 2,
                kind: a.class.kind,
                level_a: a.class.level.first,
                level_b: a.class.level.first,
                steps: 0,
                flags: (a.class.flags & (EF_INDOOR | EF_TUNNEL | EF_BRIDGE | EF_COVERED | EF_WHEELCHAIR_NO | EF_WHEELCHAIR_YES | EF_ROUGH)) | EF_AREA,
                len_dm: (pa.dist_m(&pb) * 10.0).round() as u32,
                name,
            });
            b.push_meta(a.id, NO_IDX, (0.0, 1.0), a.class.layer);
            made += 1;
        }
    }
    made
}

pub(crate) struct Builder<'a> {
    pub(crate) ways: &'a Ways,
    pub(crate) nodes: &'a Nodes,
    /// needed-node index → graph node
    node_of: Vec<u32>,
    pub(crate) gpos: Vec<LatLon>,
    pub(crate) gflags: Vec<u8>,
    pub(crate) gextra: Vec<u8>,
    pub(crate) edges: Vec<WalkEdge>,
    pub(crate) edge_way: Vec<i64>,
    /// Way record that produced the edge (`NO_IDX` for synthetic edges).
    pub(crate) e_rec: Vec<u32>,
    /// Position of the edge's ends along its way, 0..1.
    pub(crate) e_t: Vec<(f32, f32)>,
    /// Edges removed by pruning.
    pub(crate) dead: Vec<bool>,
    /// (edge, piece split off it): the piece belongs to the same way / platform.
    pub(crate) split_children: Vec<(u32, u32)>,
    pub(crate) e_layer: Vec<i8>,
    pub(crate) geom: Vec<LatLon>,
    names: Vec<String>,
    name_ix: FxHashMap<String, u32>,
    pub(crate) stats: BuildStats,
}

impl<'a> Builder<'a> {
    fn node(&mut self, idx: u32) -> u32 {
        let n = self.node_of[idx as usize];
        if n != NO_IDX {
            return n;
        }
        let n = self.gpos.len() as u32;
        self.node_of[idx as usize] = n;
        self.gpos.push(self.nodes.coords[idx as usize]);
        let (f, x) = match self.nodes.tags.binary_search_by_key(&idx, |t| t.idx) {
            Ok(i) => (self.nodes.tags[i].class.nf, self.nodes.tags[i].class.extra),
            Err(_) => (0, 0),
        };
        self.gflags.push(f);
        self.gextra.push(x);
        n
    }

    fn copy_node(&mut self, n: u32) -> u32 {
        let m = self.gpos.len() as u32;
        self.gpos.push(self.gpos[n as usize]);
        self.gflags.push(self.gflags[n as usize]);
        self.gextra.push(self.gextra[n as usize]);
        m
    }

    /// Per-edge side tables for an edge just pushed to `edges`.
    pub(crate) fn push_meta(&mut self, way: i64, rec: u32, t: (f32, f32), layer: i8) {
        self.edge_way.push(way);
        self.e_rec.push(rec);
        self.e_t.push(t);
        self.e_layer.push(layer);
        self.dead.push(false);
    }

    /// Insert a node at `at` on segment `seg` of edge `e`; `e` keeps the part
    /// from `a`, a new edge takes the rest. Returns the new node.
    pub(crate) fn split_edge(&mut self, e: u32, seg: u32, at: LatLon) -> u32 {
        let ed = self.edges[e as usize];
        let off = ed.geom_off as usize;
        let n = ed.geom_len as usize;
        let m = self.gpos.len() as u32;
        self.gpos.push(at);
        self.gflags.push(0);
        self.gextra.push(0);
        // tail: at, then the old points after `seg`
        let tail_off = self.geom.len() as u32;
        self.geom.push(at);
        for i in seg as usize + 1..n {
            let p = self.geom[off + i];
            self.geom.push(p);
        }
        let tail_len = (n - seg as usize) as u16;
        let plen = |g: &[LatLon]| -> f32 { g.windows(2).map(|w| w[0].dist_m(&w[1])).sum() };
        self.geom[off + seg as usize + 1] = at;
        let head_len = seg as u16 + 2;
        let head_m = plen(&self.geom[off..off + head_len as usize]);
        let tail_m = plen(&self.geom[tail_off as usize..tail_off as usize + tail_len as usize]);
        let (t0, t1) = self.e_t[e as usize];
        let tm = t0 + (t1 - t0) * if head_m + tail_m > 0.0 { head_m / (head_m + tail_m) } else { 0.5 };
        let mut tail = ed;
        tail.a = m;
        tail.geom_off = tail_off;
        tail.geom_len = tail_len;
        tail.len_dm = (tail_m * 10.0).round() as u32;
        let head = &mut self.edges[e as usize];
        head.b = m;
        head.geom_len = head_len;
        head.len_dm = (head_m * 10.0).round() as u32;
        self.e_t[e as usize] = (t0, tm);
        let child = self.edges.len() as u32;
        self.edges.push(tail);
        let (way, rec, layer) = (self.edge_way[e as usize], self.e_rec[e as usize], self.e_layer[e as usize]);
        self.push_meta(way, rec, (tm, t1), layer);
        self.split_children.push((e, child));
        m
    }

    fn name(&mut self, s: &str) -> u32 {
        if s.is_empty() {
            return 0;
        }
        if let Some(&i) = self.name_ix.get(s) {
            return i;
        }
        let i = self.names.len() as u32;
        self.names.push(s.to_string());
        self.name_ix.insert(s.to_string(), i);
        i
    }

    /// One edge of way record `wi` along `pts` (needed-node index, position),
    /// with `cum` the distance of each point from the start of the way.
    fn emit(&mut self, wi: usize, pts: &[(u32, LatLon)], cum: &[f32], total: f32) {
        let n = pts.len();
        if n < 2 {
            return;
        }
        if pts[0].0 == pts[n - 1].0 {
            // A loop without any junction on it: cut it in the middle so no
            // edge starts and ends at the same node.
            if n >= 4 {
                self.stats.closed_loops_split += 1;
                let m = n / 2;
                self.emit(wi, &pts[..=m], &cum[..=m], total);
                self.emit(wi, &pts[m..], &cum[m..], total);
            } else if n == 3 {
                self.emit(wi, &pts[..2], &cum[..2], total);
            }
            return;
        }
        let ways: &'a Ways = self.ways;
        let w = &ways.recs[wi];
        let c = w.class;
        let len_m = cum[n - 1] - cum[0];
        let a = self.node(pts[0].0);
        let b = self.node(pts[n - 1].0);
        let geom_off = self.geom.len() as u32;
        self.geom.extend(pts.iter().map(|p| p.1));
        let single = !c.level.is_multi() || w.closed || c.roles & R_AREA != 0;
        let lv = if single { c.level.first } else { LEVEL_NONE };
        let mut flags = c.flags;
        let mut steps = 0u8;
        let t0 = if total > 0.0 { cum[0] / total } else { 0.0 };
        let t1 = if total > 0.0 { cum[n - 1] / total } else { 1.0 };
        if matches!(c.kind, EdgeKind::Steps | EdgeKind::Escalator) {
            if c.incline > 0 {
                flags |= EF_UP_AB;
            } else if c.incline < 0 {
                flags |= EF_UP_BA;
            }
            if c.kind == EdgeKind::Steps {
                steps = if c.step_count > 0 {
                    ((c.step_count as f32 * (t1 - t0)).round() as u32).clamp(1, 255) as u8
                } else {
                    ((len_m / 0.3).round() as u32).clamp(1, 255) as u8
                };
            }
        }
        let name = self.name(&ways.names[w.name as usize]);
        self.edges.push(WalkEdge {
            a,
            b,
            geom_off,
            geom_len: n as u16,
            kind: c.kind,
            level_a: lv,
            level_b: lv,
            steps,
            flags,
            len_dm: (len_m * 10.0).round() as u32,
            name,
        });
        self.push_meta(w.id, wi as u32, (t0, t1), c.layer);
    }

    /// Cut way record `wi` at junction nodes.
    fn cut_way(&mut self, wi: usize, junction: &[bool], pts: &mut Vec<(u32, LatLon)>, cum: &mut Vec<f32>) -> Range<u32> {
        let start = self.edges.len() as u32;
        let ways: &'a Ways = self.ways;
        let nodes: &'a Nodes = self.nodes;
        let w = &ways.recs[wi];
        let refs = ways.refs_of(w);
        // total length over the nodes that exist
        let mut total = 0f32;
        let mut prev: Option<LatLon> = None;
        let mut missing = false;
        for &r in refs {
            let c = nodes.coords[r as usize];
            if c.is_none() {
                prev = None;
                missing = true;
                continue;
            }
            if let Some(p) = prev {
                total += p.dist_m(&c);
            }
            prev = Some(c);
        }
        if missing {
            self.stats.ways_missing_nodes += 1;
        }
        let mut done = 0f32;
        let mut i = 0;
        while i < refs.len() {
            // one run of consecutive existing nodes
            pts.clear();
            cum.clear();
            while i < refs.len() {
                let c = nodes.coords[refs[i] as usize];
                if c.is_none() {
                    i += 1;
                    break;
                }
                if let Some(last) = pts.last() {
                    done += last.1.dist_m(&c);
                }
                pts.push((refs[i], c));
                cum.push(done);
                i += 1;
            }
            let n = pts.len();
            if n < 2 {
                continue;
            }
            let mut s = 0;
            for k in 1..n {
                if k == n - 1 || junction[pts[k].0 as usize] {
                    // split borrow: emit needs &mut self, the scratch buffers are separate
                    let (p, c) = (&pts[s..=k], &cum[s..=k]);
                    self.emit(wi, p, c, total);
                    s = k;
                }
            }
        }
        start..self.edges.len() as u32
    }

    fn end_level(&self, e: u32, node: u32) -> Level2 {
        let ed = &self.edges[e as usize];
        if ed.a == node {
            ed.level_a
        } else {
            ed.level_b
        }
    }

    /// Levels of the other, already levelled edges meeting at `node`.
    fn evidence(&self, adj: &Csr, node: u32, skip: &Range<u32>, pending: &[bool]) -> (Vec<Level2>, bool) {
        let mut lv = Vec::new();
        let mut untagged = false;
        for &e in adj.incident(node) {
            if skip.contains(&e) || pending[e as usize] {
                continue;
            }
            let l = self.end_level(e, node);
            if l == LEVEL_NONE {
                untagged = true;
            } else {
                lv.push(l);
            }
        }
        (lv, untagged)
    }

    fn assign_levels(&mut self, adj: &Csr, range: &Range<u32>, la: Level2, lb: Level2, pending: &mut [bool]) {
        let (lo, hi) = (la.min(lb), la.max(lb));
        for e in range.clone() {
            let (t0, t1) = self.e_t[e as usize];
            let ed = &mut self.edges[e as usize];
            ed.level_a = (la as f32 + (lb as f32 - la as f32) * t0).round() as Level2;
            ed.level_b = (la as f32 + (lb as f32 - la as f32) * t1).round() as Level2;
            pending[e as usize] = false;
        }
        // A landing in the middle takes the level of what joins there.
        for e in range.start..range.end.saturating_sub(1) {
            let node = self.edges[e as usize].b;
            if self.edges[e as usize + 1].a != node {
                continue;
            }
            let (lv, _) = self.evidence(adj, node, range, pending);
            let inside: Vec<Level2> = lv.into_iter().filter(|l| *l >= lo && *l <= hi).collect();
            if let Some(&f) = inside.first() {
                if inside.iter().all(|l| *l == f) {
                    self.edges[e as usize].level_b = f;
                    self.edges[e as usize + 1].level_a = f;
                }
            }
        }
        for e in range.clone() {
            let ed = &mut self.edges[e as usize];
            if matches!(ed.kind, EdgeKind::Steps | EdgeKind::Escalator) && ed.level_a != ed.level_b {
                ed.flags &= !(EF_UP_AB | EF_UP_BA);
                ed.flags |= if ed.level_b > ed.level_a { EF_UP_AB } else { EF_UP_BA };
            }
        }
    }

    /// Give every edge of a multi-level way its end levels.
    fn orient_levels(&mut self, adj: &Csr, way_edges: &[Range<u32>]) {
        let mut pending = vec![false; self.edges.len()];
        let mut todo: Vec<usize> = Vec::new();
        for (wi, r) in way_edges.iter().enumerate() {
            let w = &self.ways.recs[wi];
            if r.is_empty() || !w.class.level.is_multi() || w.closed || w.class.roles & R_AREA != 0 {
                continue;
            }
            for e in r.clone() {
                pending[e as usize] = true;
            }
            todo.push(wi);
        }
        self.stats.multi_level_ways = todo.len() as u64;
        for round in 0..4 {
            let mut left = Vec::new();
            for &wi in &todo {
                let r = way_edges[wi].clone();
                let lv = self.ways.recs[wi].class.level;
                let inc = self.ways.recs[wi].class.incline;
                let up: Option<bool> = if inc != 0 {
                    if round == 0 {
                        self.stats.oriented_by_incline += 1;
                    }
                    Some(inc > 0)
                } else {
                    let na = self.edges[r.start as usize].a;
                    let nb = self.edges[r.end as usize - 1].b;
                    let (sa, ua) = self.evidence(adj, na, &r, &pending);
                    let (sb, ub) = self.evidence(adj, nb, &r, &pending);
                    let has = |s: &Vec<Level2>, l: Level2| s.contains(&l);
                    let up_score = (has(&sa, lv.min) && !has(&sa, lv.max)) as i32 + (has(&sb, lv.max) && !has(&sb, lv.min)) as i32;
                    let dn_score = (has(&sa, lv.max) && !has(&sa, lv.min)) as i32 + (has(&sb, lv.min) && !has(&sb, lv.max)) as i32;
                    let mean = |s: &Vec<Level2>, untagged: bool| -> Option<f32> {
                        if !s.is_empty() {
                            Some(s.iter().map(|l| *l as f32).sum::<f32>() / s.len() as f32)
                        } else if untagged {
                            // an ordinary untagged outdoor way is taken as ground level
                            Some(0.0)
                        } else {
                            None
                        }
                    };
                    let d = if up_score != dn_score {
                        Some(up_score > dn_score)
                    } else {
                        match (mean(&sa, ua), mean(&sb, ub)) {
                            (Some(x), Some(y)) if (x - y).abs() > 0.01 => Some(x < y),
                            (Some(x), None) if x <= lv.min as f32 => Some(true),
                            (Some(x), None) if x >= lv.max as f32 => Some(false),
                            (None, Some(y)) if y >= lv.max as f32 => Some(true),
                            (None, Some(y)) if y <= lv.min as f32 => Some(false),
                            _ => None,
                        }
                    };
                    if d.is_some() {
                        self.stats.oriented_by_neighbours += 1;
                    }
                    d
                };
                match up {
                    Some(true) => self.assign_levels(adj, &r, lv.min, lv.max, &mut pending),
                    Some(false) => self.assign_levels(adj, &r, lv.max, lv.min, &mut pending),
                    None => left.push(wi),
                }
            }
            if left.len() == todo.len() {
                todo = left;
                break;
            }
            todo = left;
            if todo.is_empty() {
                break;
            }
        }
        self.stats.unoriented = todo.len() as u64;
        for wi in todo {
            let r = way_edges[wi].clone();
            let lv = self.ways.recs[wi].class.level;
            let (la, lb) = if lv.first != lv.last { (lv.first, lv.last) } else { (lv.min, lv.max) };
            self.assign_levels(adj, &r, la, lb, &mut pending);
        }
    }

    fn rewire(&mut self, e: u32, from: u32, to: u32) {
        let ed = &mut self.edges[e as usize];
        if ed.a == from {
            ed.a = to;
        } else if ed.b == from {
            ed.b = to;
        }
    }

    /// Split a lift node into one graph node per floor ("port").
    fn lift_ports(&mut self, adj: &Csr, p: u32, node_lift: bool) -> Vec<(u32, Level2, i8)> {
        let inc: Vec<u32> = adj.incident(p).to_vec();
        let mut groups: Vec<((u8, i8), Vec<u32>)> = Vec::new();
        for &e in &inc {
            let lv = self.end_level(e, p);
            let key = if lv != LEVEL_NONE { (0u8, lv) } else { (1u8, self.e_layer[e as usize]) };
            match groups.iter_mut().find(|g| g.0 == key) {
                Some(g) => g.1.push(e),
                None => groups.push((key, vec![e])),
            }
        }
        groups.sort_by_key(|g| g.0);
        if node_lift && groups.len() == 1 && groups[0].0 .0 == 1 && inc.len() >= 2 && inc.len() <= 6 {
            // Nothing tells the floors apart: each way is its own floor.
            self.stats.lifts_split_per_way += 1;
            let key = groups[0].0;
            groups = inc.iter().map(|&e| (key, vec![e])).collect();
        }
        let mut ports = Vec::new();
        for (gi, (key, es)) in groups.iter().enumerate() {
            let node = if gi == 0 { p } else { self.copy_node(p) };
            if node != p {
                for &e in es {
                    self.rewire(e, p, node);
                }
            }
            self.gflags[node as usize] |= NF_ELEVATOR;
            ports.push(if key.0 == 0 { (node, key.1, i8::MIN) } else { (node, LEVEL_NONE, key.1) });
        }
        ports
    }
}

struct LiftDef {
    nodes: Vec<u32>,
    /// Outline and its centre in the national planar frame (a lift drawn as a way).
    ring: Vec<(f64, f64)>,
    centre: (f64, f64),
    levels: Vec<Level2>,
    flags: u16,
    private: bool,
    way_id: i64,
    node_lift: bool,
}

#[inline]
fn spread(v: u32) -> u64 {
    let mut x = v as u64;
    x = (x | (x << 16)) & 0x0000_FFFF_0000_FFFF;
    x = (x | (x << 8)) & 0x00FF_00FF_00FF_00FF;
    x = (x | (x << 4)) & 0x0F0F_0F0F_0F0F_0F0F;
    x = (x | (x << 2)) & 0x3333_3333_3333_3333;
    x = (x | (x << 1)) & 0x5555_5555_5555_5555;
    x
}

#[inline]
fn morton(p: LatLon) -> u64 {
    // ~1.1 m cells keep neighbours together without separating a node from
    // its level copies.
    let y = (p.lat.wrapping_add(900_000_000) as u32) >> 7;
    let x = (p.lon.wrapping_add(1_800_000_000) as u32) >> 7;
    spread(x) | (spread(y) << 1)
}

pub fn build(rels: &Relations, ways: &Ways, nodes: &Nodes, bbox: Option<&BBox>, obstacles: Option<&Obstacles>, mut stats: BuildStats) -> Built {
    let nn = nodes.coords.len();
    let coords = &nodes.coords;
    let recs = &ways.recs;
    let rec_of = |id: i64| -> Option<usize> { recs.binary_search_by_key(&id, |r| r.id).ok() };

    // ------------------------------------------------ 0. what is inside the box
    let mut keep: Vec<bool> = recs
        .par_iter()
        .map(|w| match bbox {
            None => true,
            Some(b) => ways.refs_of(w).iter().any(|&i| {
                let c = coords[i as usize];
                !c.is_none() && b.contains(&c)
            }),
        })
        .collect();
    let mut rel_keep = vec![bbox.is_none(); rels.areas.len()];
    if bbox.is_some() {
        for (ri, r) in rels.areas.iter().enumerate() {
            rel_keep[ri] = r.outers.iter().chain(r.inners.iter()).any(|id| rec_of(*id).map(|i| keep[i]).unwrap_or(false));
            if rel_keep[ri] {
                for id in r.outers.iter().chain(r.inners.iter()) {
                    if let Some(i) = rec_of(*id) {
                        keep[i] = true;
                    }
                }
            }
        }
    }

    // ------------------------------------------------ 1. node usage and junctions
    let mut cnt = vec![0u8; nn];
    for (i, w) in recs.iter().enumerate() {
        if keep[i] && w.class.roles & R_WALK != 0 {
            let refs = ways.refs_of(w);
            let m = if w.closed { refs.len() - 1 } else { refs.len() };
            for &r in &refs[..m] {
                cnt[r as usize] = cnt[r as usize].saturating_add(1);
            }
        }
    }
    let mut junction: Vec<bool> = cnt.iter().map(|c| *c >= 2).collect();
    for t in &nodes.tags {
        if cnt[t.idx as usize] >= 1 && (t.class.nf != 0 || t.class.extra & X_BLOCK != 0) {
            junction[t.idx as usize] = true;
        }
    }
    for (i, w) in recs.iter().enumerate() {
        if keep[i] && w.class.roles & R_LIFT != 0 {
            for &r in ways.refs_of(w) {
                if cnt[r as usize] >= 1 {
                    junction[r as usize] = true;
                }
            }
        }
    }

    // ------------------------------------------------ 2. areas
    let mut areas: Vec<AreaDef> = Vec::new();
    for (i, w) in recs.iter().enumerate() {
        if keep[i] && w.closed && w.class.roles & R_AREA != 0 && w.class.roles & R_INHERITED == 0 {
            let refs = ways.refs_of(w);
            areas.push(AreaDef {
                id: w.id,
                class: w.class,
                name: ways.names[w.name as usize].clone(),
                rings: vec![refs[..refs.len() - 1].to_vec()],
                way: i as u32,
                rel: NO_IDX,
            });
        }
    }
    for (ri, r) in rels.areas.iter().enumerate() {
        if !rel_keep[ri] {
            continue;
        }
        let collect = |ids: &Vec<i64>| -> Vec<Vec<u32>> {
            let parts: Vec<&[u32]> = ids.iter().filter_map(|id| rec_of(*id)).map(|i| ways.refs_of(&recs[i])).collect();
            area::assemble_rings(&parts)
        };
        let mut rings = collect(&r.outers);
        if rings.is_empty() {
            continue;
        }
        rings.extend(collect(&r.inners));
        areas.push(AreaDef { id: r.id, class: r.class, name: r.name.clone(), rings, way: NO_IDX, rel: ri as u32 });
    }
    let pairs: Vec<Vec<(u32, u32)>> = areas.par_iter().map(|a| area_pairs(a, coords, &cnt, obstacles)).collect();
    for ps in &pairs {
        for &(x, y) in ps {
            junction[x as usize] = true;
            junction[y as usize] = true;
        }
    }
    stats.area_polygons = areas.len() as u64;

    // ------------------------------------------------ 3. cut ways into edges
    let mut b = Builder {
        ways,
        nodes,
        node_of: vec![NO_IDX; nn],
        gpos: Vec::new(),
        gflags: Vec::new(),
        gextra: Vec::new(),
        edges: Vec::new(),
        edge_way: Vec::new(),
        e_rec: Vec::new(),
        e_t: Vec::new(),
        e_layer: Vec::new(),
        dead: Vec::new(),
        split_children: Vec::new(),
        geom: Vec::new(),
        names: vec![String::new()],
        name_ix: FxHashMap::default(),
        stats,
    };
    let mut way_edges: Vec<Range<u32>> = vec![0..0; recs.len()];
    {
        let mut pts = Vec::new();
        let mut cum = Vec::new();
        for (i, w) in recs.iter().enumerate() {
            if keep[i] && w.class.roles & R_WALK != 0 {
                way_edges[i] = b.cut_way(i, &junction, &mut pts, &mut cum);
                if !way_edges[i].is_empty() {
                    b.stats.walk_ways += 1;
                }
            }
        }
    }
    drop(junction);
    drop(cnt);

    // ------------------------------------------------ 4. synthetic edges across areas
    let mut area_edges: Vec<Range<u32>> = Vec::with_capacity(areas.len());
    for (ai, a) in areas.iter().enumerate() {
        let start = b.edges.len() as u32;
        let name = b.name(&a.name);
        for &(x, y) in &pairs[ai] {
            let (pa, pb) = (coords[x as usize], coords[y as usize]);
            let (na, nb) = (b.node(x), b.node(y));
            if na == nb {
                continue;
            }
            let geom_off = b.geom.len() as u32;
            b.geom.push(pa);
            b.geom.push(pb);
            b.edges.push(WalkEdge {
                a: na,
                b: nb,
                geom_off,
                geom_len: 2,
                kind: a.class.kind,
                level_a: a.class.level.first,
                level_b: a.class.level.first,
                steps: 0,
                flags: (a.class.flags & (EF_INDOOR | EF_TUNNEL | EF_BRIDGE | EF_COVERED | EF_WHEELCHAIR_NO | EF_WHEELCHAIR_YES | EF_ROUGH)) | EF_AREA,
                len_dm: (pa.dist_m(&pb) * 10.0).round() as u32,
                name,
            });
            b.push_meta(a.id, NO_IDX, (0.0, 1.0), a.class.layer);
        }
        area_edges.push(start..b.edges.len() as u32);
        b.stats.area_edges += (b.edges.len() as u32 - start) as u64;
    }

    // ------------------------------------------------ 5. levels of multi-level ways
    let adj = Csr::new(b.gpos.len(), &b.edges);
    b.orient_levels(&adj, &way_edges);
    drop(adj);

    // ------------------------------------------------ 5a. paths that end inside a platform or square
    {
        let outline: Vec<Vec<u32>> = areas
            .iter()
            .map(|a| {
                let recs_of: Vec<u32> = if a.way != NO_IDX {
                    vec![a.way]
                } else {
                    let r = &rels.areas[a.rel as usize];
                    r.outers.iter().chain(r.inners.iter()).filter_map(|id| rec_of(*id).map(|i| i as u32)).collect()
                };
                recs_of.iter().flat_map(|&w| way_edges[w as usize].clone()).collect()
            })
            .collect();
        let joined = join_inside(&mut b, &areas, &outline, &area_edges, coords, obstacles);
        b.stats.inside_joins += joined;
    }
    let adj = Csr::new(b.gpos.len(), &b.edges);

    // crossings described on the node rather than on the way
    for e in b.edges.iter_mut() {
        if e.kind == EdgeKind::Crossing && e.flags & (EF_SIGNALS | EF_MARKED) == 0 {
            let (fa, fb) = (b.gflags[e.a as usize], b.gflags[e.b as usize]);
            if (fa | fb) & NF_CROSSING_SIGNALS != 0 {
                e.flags |= EF_SIGNALS;
            } else if (b.gextra[e.a as usize] | b.gextra[e.b as usize]) & X_MARKED != 0 {
                e.flags |= EF_MARKED;
            }
        }
    }

    // ------------------------------------------------ 6. lifts and blocking barriers
    let mut lifts: Vec<LiftDef> = Vec::new();
    let mut on_lift_way: FxHashSet<u32> = FxHashSet::default();
    for (i, w) in recs.iter().enumerate() {
        if keep[i] && w.class.roles & R_LIFT != 0 {
            let mut ns: Vec<u32> = Vec::new();
            for &r in ways.refs_of(w) {
                let n = b.node_of[r as usize];
                if n != NO_IDX && !ns.contains(&n) {
                    ns.push(n);
                }
            }
            b.stats.lift_ways += 1;
            on_lift_way.extend(ns.iter().copied());
            let ring: Vec<(f64, f64)> = ways.refs_of(w).iter().map(|&r| coords[r as usize]).filter(|p| !p.is_none()).map(|p| p.xy()).map(|(x, y)| (x as f64, y as f64)).collect();
            let k = ring.len().max(1) as f64;
            let centre = (ring.iter().map(|p| p.0).sum::<f64>() / k, ring.iter().map(|p| p.1).sum::<f64>() / k);
            lifts.push(LiftDef {
                nodes: ns,
                ring,
                centre,
                levels: if w.lift != NO_IDX { ways.lift_levels[w.lift as usize].clone() } else { Vec::new() },
                flags: w.class.flags & (EF_WHEELCHAIR_NO | EF_WHEELCHAIR_YES),
                private: w.class.roles & R_LIFT_PRIVATE != 0,
                way_id: w.id,
                node_lift: false,
            });
        }
    }
    // A lift drawn as one outline per floor (Zürich HB): outlines of one floor each, on different floors, that
    // overlap or touch with their centres within 4 m (mappers draw the floors a few metres apart) are one lift, with
    // a port on each floor. Two shafts side by side, or lifts drawn for several floors each, are never joined.
    {
        let cs: Vec<(f64, f64)> = lifts.iter().map(|l| l.centre).collect();
        let mut cell: FxHashMap<(i64, i64), Vec<usize>> = FxHashMap::default();
        for (i, c) in cs.iter().enumerate() {
            if !lifts[i].nodes.is_empty() {
                cell.entry(((c.0 / 5.0).floor() as i64, (c.1 / 5.0).floor() as i64)).or_default().push(i);
            }
        }
        let mut into: Vec<usize> = (0..lifts.len()).collect();
        fn root(p: &mut [usize], mut x: usize) -> usize {
            while p[x] != x {
                p[x] = p[p[x]];
                x = p[x];
            }
            x
        }
        for i in 0..lifts.len() {
            let (cx, cy) = ((cs[i].0 / 5.0).floor() as i64, (cs[i].1 / 5.0).floor() as i64);
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for &j in cell.get(&(cx + dx, cy + dy)).map(|v| v.as_slice()).unwrap_or(&[]) {
                        if j <= i || lifts[i].levels.len() != 1 || lifts[j].levels.len() != 1 || lifts[i].levels == lifts[j].levels {
                            continue;
                        }
                        let bb = |a: &LiftDef| a.ring.iter().fold((f64::MAX, f64::MAX, f64::MIN, f64::MIN), |b, p| (b.0.min(p.0), b.1.min(p.1), b.2.max(p.0), b.3.max(p.1)));
                        let (x, y) = (bb(&lifts[i]), bb(&lifts[j]));
                        let touch = x.0 <= y.2 + 0.2 && y.0 <= x.2 + 0.2 && x.1 <= y.3 + 0.2 && y.1 <= x.3 + 0.2;
                        let near = ((cs[i].0 - cs[j].0).powi(2) + (cs[i].1 - cs[j].1).powi(2)).sqrt() < 4.0;
                        if lifts[i].ring.len() >= 3 && lifts[j].ring.len() >= 3 && touch && near {
                            let (a, c) = (root(&mut into, i), root(&mut into, j));
                            if a != c {
                                into[a.max(c)] = a.min(c);
                            }
                        }
                    }
                }
            }
        }
        let mut merged = 0;
        for i in 0..lifts.len() {
            let r = root(&mut into, i);
            if r == i {
                continue;
            }
            let other = std::mem::replace(&mut lifts[i], LiftDef { nodes: Vec::new(), ring: Vec::new(), centre: (0.0, 0.0), levels: Vec::new(), flags: 0, private: true, way_id: 0, node_lift: false });
            let keep = &mut lifts[r];
            for n in other.nodes {
                if !keep.nodes.contains(&n) {
                    keep.nodes.push(n);
                }
            }
            for l in other.levels {
                if !keep.levels.contains(&l) {
                    keep.levels.push(l);
                }
            }
            keep.flags |= other.flags;
            if keep.flags & EF_WHEELCHAIR_NO != 0 && keep.flags & EF_WHEELCHAIR_YES != 0 {
                keep.flags &= !EF_WHEELCHAIR_YES;
            }
            keep.private &= other.private;
            merged += 1;
        }
        lifts.retain(|l| !l.nodes.is_empty());
        b.stats.lifts_stacked += merged;
    }
    let mut lift_node_set: FxHashSet<u32> = on_lift_way.clone();
    for t in &nodes.tags {
        if t.class.nf & NF_ELEVATOR == 0 {
            continue;
        }
        let n = b.node_of[t.idx as usize];
        if n == NO_IDX {
            continue;
        }
        b.stats.lift_nodes += 1;
        if on_lift_way.contains(&n) {
            // the door of a lift that is also drawn as an area: one lift
            continue;
        }
        lift_node_set.insert(n);
        let mut flags = 0;
        if t.class.extra & X_WC_NO != 0 {
            flags |= EF_WHEELCHAIR_NO;
        } else if t.class.extra & X_WC_YES != 0 {
            flags |= EF_WHEELCHAIR_YES;
        }
        lifts.push(LiftDef { nodes: vec![n], ring: Vec::new(), centre: (0.0, 0.0), levels: t.levels.clone(), flags, private: t.class.extra & X_LIFT_PRIVATE != 0, way_id: 0, node_lift: true });
    }

    // barriers nobody passes: every way ends at its own copy of the node
    let n_before = b.gpos.len() as u32;
    for n in 0..n_before {
        if b.gextra[n as usize] & X_BLOCK == 0 || lift_node_set.contains(&n) {
            continue;
        }
        let inc: Vec<u32> = adj.incident(n).to_vec();
        if inc.len() < 2 {
            continue;
        }
        b.stats.blocked_nodes += 1;
        for &e in &inc[1..] {
            let m = b.copy_node(n);
            b.rewire(e, n, m);
        }
    }

    let debug = std::env::var_os("KANTE_OSM_DEBUG").is_some();
    let mut port_cache: FxHashMap<u32, Vec<(u32, Level2, i8)>> = FxHashMap::default();
    for lift in &lifts {
        let mut ports: Vec<(u32, Level2, i8)> = Vec::new();
        for &p in &lift.nodes {
            if !port_cache.contains_key(&p) {
                let v = b.lift_ports(&adj, p, lift.node_lift);
                port_cache.insert(p, v);
            }
            ports.extend(port_cache[&p].iter().copied());
        }
        if lift.private {
            b.stats.lifts_private += 1;
            continue;
        }
        if debug {
            let at = lift.nodes.first().map(|n| b.gpos[*n as usize]).unwrap_or(LatLon::NONE);
            eprintln!(
                "lift way {} node_lift {} at {:.6},{:.6} tag levels {:?} nodes {} ports {:?}",
                lift.way_id,
                lift.node_lift,
                at.lat_deg(),
                at.lon_deg(),
                lift.levels,
                lift.nodes.len(),
                ports.iter().map(|p| p.1).collect::<Vec<_>>()
            );
        }
        if ports.len() < 2 {
            b.stats.lifts_unconnected += 1;
            continue;
        }
        ports.truncate(16);
        // name the floor of ports whose ways have no level, where the lift's own tag allows it
        let known: Vec<Level2> = ports.iter().map(|p| p.1).filter(|l| *l != LEVEL_NONE).collect();
        let none_ports: Vec<usize> = (0..ports.len()).filter(|&i| ports[i].1 == LEVEL_NONE).collect();
        if none_ports.len() == 1 {
            let missing: Vec<Level2> = lift.levels.iter().copied().filter(|l| !known.contains(l)).collect();
            if missing.len() == 1 {
                ports[none_ports[0]].1 = missing[0];
            } else if missing.contains(&0) {
                ports[none_ports[0]].1 = 0;
            }
        } else if none_ports.len() >= 2 {
            // several unlevelled floors told apart by `layer`: match them to
            // the lift's remaining levels in ascending order
            let mut missing: Vec<Level2> = lift.levels.iter().copied().filter(|l| !known.contains(l)).collect();
            missing.sort_unstable();
            missing.dedup();
            let mut by_layer: Vec<usize> = none_ports.clone();
            by_layer.sort_by_key(|&i| ports[i].2);
            let distinct = by_layer.windows(2).all(|w| ports[w[0]].2 != ports[w[1]].2);
            if distinct && missing.len() == by_layer.len() {
                for (k, &i) in by_layer.iter().enumerate() {
                    ports[i].1 = missing[k];
                }
            } else if missing.len() == 1 {
                // the lift serves one floor more than its ports name: that is where the others are
                for &i in &none_ports {
                    ports[i].1 = missing[0];
                }
            }
        }
        let mut made = 0;
        for i in 0..ports.len() {
            for j in i + 1..ports.len() {
                let (mut x, mut y) = (ports[i], ports[j]);
                if x.0 == y.0 || (x.1 != LEVEL_NONE && x.1 == y.1) {
                    continue;
                }
                if y.1 != LEVEL_NONE && (x.1 == LEVEL_NONE || y.1 < x.1) {
                    std::mem::swap(&mut x, &mut y);
                }
                let (pa, pb) = (b.gpos[x.0 as usize], b.gpos[y.0 as usize]);
                let geom_off = b.geom.len() as u32;
                b.geom.push(pa);
                b.geom.push(pb);
                b.edges.push(WalkEdge {
                    a: x.0,
                    b: y.0,
                    geom_off,
                    geom_len: 2,
                    kind: EdgeKind::Lift,
                    level_a: x.1,
                    level_b: y.1,
                    steps: 0,
                    flags: lift.flags | EF_INDOOR,
                    len_dm: (pa.dist_m(&pb) * 10.0).round() as u32,
                    name: 0,
                });
                b.push_meta(lift.way_id, NO_IDX, (0.0, 1.0), 0);
                made += 1;
            }
        }
        if made == 0 {
            b.stats.lifts_unconnected += 1;
        }
        b.stats.lift_edges += made;
    }
    drop(adj);

    // ------------------------------------------------ 6b. join platform islands, drop crumbs
    for _ in 0..2 {
        let joined = crate::stitch::stitch_round(&mut b, ways, &keep);
        b.stats.stitched_components += joined;
        if joined == 0 {
            break;
        }
    }
    crate::stitch::prune(&mut b);
    // pieces split off an edge belong to the same way and platform
    let mut children: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    for &(parent, child) in &b.split_children {
        children.entry(parent).or_default().push(child);
    }
    let with_children = |r: Range<u32>, out: &mut Vec<u32>| {
        for e in r {
            let mut stack = vec![e];
            while let Some(x) = stack.pop() {
                out.push(x);
                if let Some(c) = children.get(&x) {
                    stack.extend(c.iter().copied());
                }
            }
        }
    };

    // ------------------------------------------------ 7. platforms and carriageways
    let mut plats: Vec<OsmPlatform> = Vec::new();
    let way_centre = |w: &WayRec| -> LatLon {
        let pts: Vec<LatLon> = ways.refs_of(w).iter().map(|&i| coords[i as usize]).filter(|c| !c.is_none()).collect();
        if pts.is_empty() {
            return LatLon::NONE;
        }
        let f = Frame::new(pts[0]);
        if w.closed && pts.len() >= 4 {
            let ring: Vec<P> = pts[..pts.len() - 1].iter().map(|p| f.to_xy(*p)).collect();
            f.to_ll(area::centroid(&ring))
        } else {
            let total: f32 = pts.windows(2).map(|s| s[0].dist_m(&s[1])).sum();
            let mut left = total * 0.5;
            for s in pts.windows(2) {
                let d = s[0].dist_m(&s[1]);
                if d >= left && d > 0.0 {
                    return s[0].lerp(&s[1], left / d);
                }
                left -= d;
            }
            pts[pts.len() / 2]
        }
    };
    let area_of_way: FxHashMap<u32, usize> = areas.iter().enumerate().filter(|(_, a)| a.way != NO_IDX).map(|(i, a)| (a.way, i)).collect();
    for (i, w) in recs.iter().enumerate() {
        if !keep[i] || w.class.roles & (R_PLATFORM | R_PLATFORM_EDGE) == 0 || w.plat == NO_IDX {
            continue;
        }
        let pos = way_centre(w);
        if pos.is_none() {
            continue;
        }
        let info = &ways.plats[w.plat as usize];
        let mut edges: Vec<u32> = Vec::new();
        if w.class.roles & R_PLATFORM != 0 {
            with_children(way_edges[i].clone(), &mut edges);
            if let Some(&ai) = area_of_way.get(&(i as u32)) {
                with_children(area_edges[ai].clone(), &mut edges);
            }
        }
        plats.push(OsmPlatform {
            kind: PlatformKind::PlatformWay,
            osm_type: 1,
            osm_id: w.id,
            pos,
            level: info.level,
            refs: info.refs.clone(),
            name: info.name.clone(),
            sloid: info.sloid.clone(),
            uic_ref: info.uic_ref,
            modes: info.modes,
            edges,
        });
    }
    for (ai, a) in areas.iter().enumerate() {
        if a.rel == NO_IDX {
            continue;
        }
        let r = &rels.areas[a.rel as usize];
        let Some(info) = &r.plat else { continue };
        // centroid of the largest ring
        let mut best: Option<(f64, LatLon)> = None;
        for ring in &a.rings {
            let pts: Vec<LatLon> = ring.iter().map(|&i| coords[i as usize]).filter(|c| !c.is_none()).collect();
            if pts.len() < 3 {
                continue;
            }
            let f = Frame::new(pts[0]);
            let xy: Vec<P> = pts.iter().map(|p| f.to_xy(*p)).collect();
            let ar = area::signed_area(&xy).abs();
            if best.map(|b| ar > b.0).unwrap_or(true) {
                best = Some((ar, f.to_ll(area::centroid(&xy))));
            }
        }
        let Some((_, pos)) = best else { continue };
        let mut edges: Vec<u32> = Vec::new();
        for id in r.outers.iter().chain(r.inners.iter()) {
            if let Some(i) = rec_of(*id) {
                with_children(way_edges[i].clone(), &mut edges);
            }
        }
        with_children(area_edges[ai].clone(), &mut edges);
        plats.push(OsmPlatform {
            kind: PlatformKind::PlatformWay,
            osm_type: 2,
            osm_id: r.id,
            pos,
            level: info.level,
            refs: info.refs.clone(),
            name: info.name.clone(),
            sloid: info.sloid.clone(),
            uic_ref: info.uic_ref,
            modes: info.modes,
            edges,
        });
    }
    for s in &nodes.stops {
        plats.push(OsmPlatform {
            kind: s.kind,
            osm_type: 0,
            osm_id: s.id,
            pos: s.pos,
            level: s.info.level,
            refs: s.info.refs.clone(),
            name: s.info.name.clone(),
            sloid: s.info.sloid.clone(),
            uic_ref: s.info.uic_ref,
            modes: s.info.modes,
            edges: Vec::new(),
        });
    }
    plats.sort_by_key(|p| (p.osm_type, p.osm_id));
    // mode hints from route relations, then gaps filled from the stop_area
    for p in plats.iter_mut() {
        if let Some(m) = rels.route_modes.get(&(p.osm_type, p.osm_id)) {
            p.modes |= *m;
        }
    }
    {
        let ix: FxHashMap<(u8, i64), usize> = plats.iter().enumerate().map(|(i, p)| ((p.osm_type, p.osm_id), i)).collect();
        for sa in &rels.stop_areas {
            let members: Vec<usize> = sa.members.iter().filter_map(|m| ix.get(m).copied()).collect();
            if members.is_empty() {
                continue;
            }
            let union = members.iter().fold(sa.modes, |m, &i| m | plats[i].modes);
            for &i in &members {
                let p = &mut plats[i];
                if p.modes == 0 {
                    p.modes = union;
                }
                if p.uic_ref == 0 {
                    p.uic_ref = sa.uic_ref;
                }
                if p.name.is_empty() {
                    p.name = sa.name.clone();
                }
            }
        }
    }

    let mut extract = OsmExtract { platforms: plats, carriageways: Vec::new(), carriageway_geom: Vec::new(), carriageway_names: vec![String::new()] };
    {
        let mut name_ix: FxHashMap<&str, u32> = FxHashMap::default();
        for (i, w) in recs.iter().enumerate() {
            let roles = w.class.roles & (R_CARR_ROAD | R_CARR_TRAM | R_CARR_RAIL);
            if !keep[i] || roles == 0 {
                continue;
            }
            let off = extract.carriageway_geom.len();
            extract.carriageway_geom.extend(ways.refs_of(w).iter().map(|&r| coords[r as usize]).filter(|c| !c.is_none()));
            let len = extract.carriageway_geom.len() - off;
            if len < 2 || len > u16::MAX as usize {
                extract.carriageway_geom.truncate(off);
                continue;
            }
            let s = ways.names[w.name as usize].as_str();
            let name = if s.is_empty() {
                0
            } else {
                *name_ix.entry(s).or_insert_with(|| {
                    extract.carriageway_names.push(s.to_string());
                    extract.carriageway_names.len() as u32 - 1
                })
            };
            // a tunnel or bridge (an untagged one counts as layer -1 / +1), or another floor
            let off_ground = w.class.layer != 0 || (!w.class.level.is_none() && w.class.level.first != 0);
            for (bit, kind) in [(R_CARR_ROAD, CarriagewayKind::Road), (R_CARR_TRAM, CarriagewayKind::TramTrack), (R_CARR_RAIL, CarriagewayKind::RailTrack)] {
                if roles & bit != 0 {
                    extract.carriageways.push(Carriageway { kind, geom_off: off as u32, geom_len: len as u16, name, off_ground });
                }
            }
        }
    }

    // ------------------------------------------------ 8. final numbering
    let Builder { gpos, gflags, edges, edge_way, geom, names, stats, dead, .. } = b;
    let (graph, edge_map) = finalize(gpos, gflags, edges, edge_way, geom, names, &dead);
    for p in extract.platforms.iter_mut() {
        for e in p.edges.iter_mut() {
            *e = edge_map[*e as usize];
        }
        p.edges.retain(|e| *e != NO_IDX);
        p.edges.sort_unstable();
        p.edges.dedup();
    }
    Built { graph, extract, stats }
}

/// Renumber nodes and edges along a Z-order curve (neighbours in space are
/// neighbours in memory), drop unused nodes, build the adjacency lists.
/// Returns the graph and the map old edge index → new edge index.
pub fn finalize(
    gpos: Vec<LatLon>,
    gflags: Vec<u8>,
    edges: Vec<WalkEdge>,
    edge_way: Vec<i64>,
    geom: Vec<LatLon>,
    names: Vec<String>,
    dead: &[bool],
) -> (WalkGraph, Vec<u32>) {
    let mut used = vec![false; gpos.len()];
    for (i, e) in edges.iter().enumerate() {
        if !dead[i] {
            used[e.a as usize] = true;
            used[e.b as usize] = true;
        }
    }
    let mut order: Vec<u32> = (0..gpos.len() as u32).filter(|&i| used[i as usize]).collect();
    order.par_sort_by_key(|&i| (morton(gpos[i as usize]), i));
    let mut new_of = vec![NO_IDX; gpos.len()];
    for (new, &old) in order.iter().enumerate() {
        new_of[old as usize] = new as u32;
    }
    let nodes: Vec<LatLon> = order.iter().map(|&i| gpos[i as usize]).collect();
    let node_flags: Vec<u8> = order.iter().map(|&i| gflags[i as usize]).collect();

    let mut eorder: Vec<u32> = (0..edges.len() as u32).filter(|&i| !dead[i as usize]).collect();
    eorder.par_sort_by_key(|&i| {
        let e = &edges[i as usize];
        (new_of[e.a as usize].min(new_of[e.b as usize]), i)
    });
    let mut edge_map = vec![NO_IDX; edges.len()];
    let mut out_edges: Vec<WalkEdge> = Vec::with_capacity(edges.len());
    let mut out_way: Vec<i64> = Vec::with_capacity(edges.len());
    let mut out_geom: Vec<LatLon> = Vec::with_capacity(geom.len());
    for (new, &old) in eorder.iter().enumerate() {
        edge_map[old as usize] = new as u32;
        let mut e = edges[old as usize];
        let g = &geom[e.geom_off as usize..e.geom_off as usize + e.geom_len as usize];
        e.geom_off = out_geom.len() as u32;
        out_geom.extend_from_slice(g);
        e.a = new_of[e.a as usize];
        e.b = new_of[e.b as usize];
        out_edges.push(e);
        out_way.push(edge_way[old as usize]);
    }
    let csr = Csr::new(nodes.len(), &out_edges);
    (WalkGraph { nodes, node_flags, adj_off: csr.off, adj: csr.adj, edges: out_edges, edge_way: out_way, geom: out_geom, names }, edge_map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stats;

    type Kv<'a> = &'a [(&'a str, &'a str)];

    /// Build a graph from literal nodes (id, east m, north m, tags) and ways
    /// (id, node ids, tags) around Bern.
    fn world(nodes_in: &[(i64, f64, f64, Kv)], ways_in: &[(i64, &[i64], Kv)]) -> Built {
        let origin = LatLon::from_deg(46.95, 7.44);
        let f = Frame::new(origin);
        let mut sorted: Vec<&(i64, f64, f64, Kv)> = nodes_in.iter().collect();
        sorted.sort_by_key(|n| n.0);
        let node_ids: Vec<i64> = sorted.iter().map(|n| n.0).collect();
        let coords: Vec<LatLon> = sorted.iter().map(|n| f.to_ll((n.1, n.2))).collect();
        let mut tags = Vec::new();
        let mut stops = Vec::new();
        for (i, n) in sorted.iter().enumerate() {
            let t = Tags::collect(n.3.iter().copied());
            let class = classify_node(&t);
            if class != NodeClass::default() {
                tags.push(NodeTag { idx: i as u32, class, levels: parse_levels(t.level) });
            }
            if let Some(kind) = node_platform_kind(&t) {
                stops.push(StopNode { id: n.0, pos: coords[i], kind, info: plat_info(&t) });
            }
        }
        let mut ways = Ways::default();
        ways.names.push(String::new());
        ways.node_ids = node_ids.clone();
        let mut ws: Vec<&(i64, &[i64], Kv)> = ways_in.iter().collect();
        ws.sort_by_key(|w| w.0);
        for w in ws {
            let t = Tags::collect(w.2.iter().copied());
            let closed = w.1.len() >= 4 && w.1[0] == w.1[w.1.len() - 1];
            let class = classify_way(&t, closed, false);
            assert!(class.roles != 0, "way {} is not used", w.0);
            let refs_off = ways.refs.len() as u32;
            ways.refs.extend(w.1.iter().map(|id| node_ids.binary_search(id).unwrap() as u32));
            let name = if t.name.is_empty() {
                0
            } else {
                ways.names.push(t.name.to_string());
                ways.names.len() as u32 - 1
            };
            let plat = if class.roles & (R_PLATFORM | R_PLATFORM_EDGE) != 0 {
                ways.plats.push(plat_info(&t));
                ways.plats.len() as u32 - 1
            } else {
                NO_IDX
            };
            let lift = if class.roles & R_LIFT != 0 {
                ways.lift_levels.push(parse_levels(t.level));
                ways.lift_levels.len() as u32 - 1
            } else {
                NO_IDX
            };
            ways.recs.push(WayRec { id: w.0, class, name, refs_off, refs_len: w.1.len() as u32, plat, rel: NO_IDX, lift, closed });
        }
        let nodes = Nodes { coords, tags, stops, n_nodes: node_ids.len() as u64 };
        let built = build(&Relations::default(), &ways, &nodes, None, None, BuildStats::default());
        let problems = stats::check(&built.graph, &built.extract);
        assert!(problems.is_empty(), "{problems:?}");
        built
    }

    fn at(g: &WalkGraph, x: f64, y: f64) -> Vec<u32> {
        let p = Frame::new(LatLon::from_deg(46.95, 7.44)).to_ll((x, y));
        (0..g.nodes.len() as u32).filter(|&n| g.nodes[n as usize].dist_m(&p) < 0.05).collect()
    }

    fn walk(g: &WalkGraph, from: (f64, f64), to: (f64, f64), step_free: bool) -> Option<stats::TestRoute> {
        let f = Frame::new(LatLon::from_deg(46.95, 7.44));
        let a = stats::snap(g, f.to_ll(from), None, step_free, None)?;
        let b = stats::snap(g, f.to_ll(to), None, step_free, None)?;
        stats::route(g, a, b, step_free)
    }

    const FOOT: Kv = &[("highway", "footway")];

    #[test]
    fn cuts_at_shared_nodes_only() {
        // 1 --- 2 --- 3 --- 4   and 5 | 3 | 6 crossing at 3; node 2 is a plain bend
        let b = world(
            &[(1, 0.0, 0.0, &[]), (2, 100.0, 10.0, &[]), (3, 200.0, 0.0, &[]), (4, 300.0, 0.0, &[]), (5, 200.0, -100.0, &[]), (6, 200.0, 100.0, &[])],
            &[(10, &[1, 2, 3, 4], &[("highway", "footway"), ("name", "Weg")]), (11, &[5, 3, 6], &[("highway", "path"), ("surface", "gravel")])],
        );
        let g = &b.graph;
        assert_eq!(g.nodes.len(), 5);
        assert_eq!(g.edges.len(), 4);
        let long = g.edges.iter().position(|e| e.geom_len == 3).unwrap();
        assert!((g.edges[long].len_m() - 201.0).abs() < 0.5);
        assert_eq!(g.edge_name(long as u32), "Weg");
        assert_eq!(g.edge_way[long], 10);
        assert_eq!(g.incident(at(g, 200.0, 0.0)[0]).len(), 4);
        let path = g.edges.iter().find(|e| e.kind == EdgeKind::Path).unwrap();
        assert!(path.flags & EF_ROUGH != 0);
        assert!(g.edges.iter().all(|e| e.level_a == LEVEL_NONE && e.level_b == LEVEL_NONE));
    }

    #[test]
    fn closed_loop_without_junction_is_cut_in_two() {
        let b = world(&[(1, 0.0, 0.0, &[]), (2, 100.0, 0.0, &[]), (3, 100.0, 100.0, &[]), (4, 0.0, 100.0, &[])], &[(10, &[1, 2, 3, 4, 1], FOOT)]);
        assert_eq!(b.graph.edges.len(), 2);
        assert!(b.graph.edges.iter().all(|e| e.a != e.b));
        assert_eq!(b.graph.nodes.len(), 2);
    }

    #[test]
    fn stairs_take_their_direction_from_the_neighbours() {
        // corridor at -1 from 1 to 2, stairs 3←2 drawn top-down without incline, street 3–4 untagged
        let b = world(
            &[(1, 0.0, 0.0, &[]), (2, 200.0, 0.0, &[]), (3, 212.0, 0.0, &[]), (4, 400.0, 0.0, &[])],
            &[
                (10, &[1, 2], &[("highway", "footway"), ("indoor", "yes"), ("level", "-1")]),
                (11, &[3, 2], &[("highway", "steps"), ("level", "-1;0")]),
                (12, &[3, 4], FOOT),
            ],
        );
        let g = &b.graph;
        let st = g.edges.iter().find(|e| e.kind == EdgeKind::Steps).unwrap();
        let top = at(g, 212.0, 0.0)[0];
        let (l_top, l_bottom) = if st.a == top { (st.level_a, st.level_b) } else { (st.level_b, st.level_a) };
        assert_eq!((l_top, l_bottom), (0, -2));
        // drawn from the top (a) to the bottom (b): up is b→a
        assert!(st.flags & EF_UP_BA != 0 && st.flags & EF_UP_AB == 0);
        assert_eq!(st.steps, 40);
        assert_eq!(b.stats.oriented_by_neighbours, 1);
        assert_eq!(b.stats.unoriented, 0);
        let c = g.edges.iter().find(|e| e.kind == EdgeKind::Corridor).unwrap();
        assert!(c.level_a == -2 && c.level_b == -2 && c.flags & EF_INDOOR != 0);
        // step-free there is no way through
        assert!(walk(g, (0.0, 0.0), (400.0, 0.0), false).is_some());
        assert!(walk(g, (0.0, 0.0), (400.0, 0.0), true).is_none());
    }

    #[test]
    fn escalator_direction_and_step_share() {
        // escalator drawn 1→2→3 going down against the drawing direction (conveying=backward means 3→1)
        let b = world(
            &[(1, 0.0, 0.0, &[]), (2, 10.0, 0.0, &[]), (3, 20.0, 0.0, &[]), (4, 300.0, 0.0, &[]), (5, 10.0, 200.0, &[]), (0, -300.0, 0.0, &[])],
            &[
                (10, &[1, 2, 3], &[("highway", "steps"), ("conveying", "backward"), ("incline", "down"), ("level", "0;1")]),
                (11, &[3, 4], &[("highway", "footway"), ("level", "0")]),
                (12, &[2, 5], &[("highway", "footway"), ("level", "0.5")]),
                (13, &[0, 1], &[("highway", "footway"), ("level", "1")]),
            ],
        );
        let g = &b.graph;
        let esc: Vec<&WalkEdge> = g.edges.iter().filter(|e| e.kind == EdgeKind::Escalator).collect();
        assert_eq!(esc.len(), 2);
        for e in &esc {
            assert!(e.flags & EF_ONEWAY_BA != 0 && e.flags & EF_ONEWAY_AB == 0);
            assert!(e.flags & EF_UP_BA != 0, "incline=down: a is the upper end");
            assert_eq!(e.steps, 0);
        }
        // the landing in the middle is at level 0.5 (×2 = 1)
        let mid = at(g, 10.0, 0.0)[0];
        for e in &esc {
            assert_eq!(if e.a == mid { e.level_a } else { e.level_b }, 1);
        }
        // usable upwards only: from the level-0 end to the level-1 end
        assert!(walk(g, (300.0, 0.0), (-300.0, 0.0), false).is_some());
        assert!(walk(g, (-300.0, 0.0), (300.0, 0.0), false).is_none());
    }

    #[test]
    fn lift_node_becomes_one_port_per_floor() {
        // three corridors on levels 0, 1, 2 end at lift node 5
        let b = world(
            &[(1, -200.0, 0.0, &[]), (2, 0.0, 200.0, &[]), (3, 200.0, 0.0, &[]), (5, 0.0, 0.0, &[("highway", "elevator"), ("wheelchair", "yes"), ("level", "0;1;2")])],
            &[
                (10, &[1, 5], &[("highway", "footway"), ("level", "0")]),
                (11, &[2, 5], &[("highway", "footway"), ("level", "1")]),
                (12, &[3, 5], &[("highway", "footway"), ("level", "2")]),
            ],
        );
        let g = &b.graph;
        let ports = at(g, 0.0, 0.0);
        assert_eq!(ports.len(), 3);
        assert!(ports.iter().all(|&n| g.node_flags[n as usize] & NF_ELEVATOR != 0));
        let lifts: Vec<&WalkEdge> = g.edges.iter().filter(|e| e.kind == EdgeKind::Lift).collect();
        assert_eq!(lifts.len(), 3);
        assert!(lifts.iter().all(|e| e.len_dm == 0 && e.level_a < e.level_b && e.flags & EF_WHEELCHAIR_YES != 0));
        // every port carries exactly one corridor and two lift edges
        for &n in &ports {
            let kinds: Vec<EdgeKind> = g.incident(n).iter().map(|&e| g.edges[e as usize].kind).collect();
            assert_eq!(kinds.iter().filter(|k| **k == EdgeKind::Lift).count(), 2);
            assert_eq!(kinds.len(), 3);
        }
        let r = walk(g, (-200.0, 0.0), (200.0, 0.0), true).unwrap();
        assert_eq!(r.lifts, 1, "one ride = one Lift edge");
        assert!((r.dist_m - 400.0).abs() < 1.0);
    }

    #[test]
    fn lift_drawn_as_area_links_its_doors() {
        // lift shaft 20,21,22,23; a level-0 corridor reaches corner 20, a level-1 corridor corner 22
        let b = world(
            &[(1, -200.0, 0.0, &[]), (2, 202.0, 2.0, &[]), (20, 0.0, 0.0, &[]), (21, 2.0, 0.0, &[]), (22, 2.0, 2.0, &[]), (23, 0.0, 2.0, &[])],
            &[
                (10, &[1, 20], &[("highway", "footway"), ("level", "0")]),
                (11, &[2, 22], &[("highway", "footway"), ("level", "1")]),
                (12, &[20, 21, 22, 23, 20], &[("highway", "elevator"), ("level", "0;1")]),
            ],
        );
        let g = &b.graph;
        assert_eq!(g.edges.len(), 3);
        let lift = g.edges.iter().position(|e| e.kind == EdgeKind::Lift).unwrap();
        assert_eq!((g.edges[lift].level_a, g.edges[lift].level_b), (0, 2));
        assert!((g.edges[lift].len_m() - 2.8).abs() < 0.2);
        assert_eq!(g.edge_way[lift], 12);
        assert_eq!(walk(g, (-200.0, 0.0), (202.0, 2.0), true).unwrap().lifts, 1);
    }

    #[test]
    fn lift_drawn_once_per_floor_is_one_lift() {
        // the same shaft drawn on level 0 (20..23) and on level 1 (30..33), each reached by its floor's corridor
        let b = world(
            &[
                (1, -200.0, 0.0, &[]),
                (2, 202.0, 2.0, &[]),
                (20, 0.0, 0.0, &[]),
                (21, 2.0, 0.0, &[]),
                (22, 2.0, 2.0, &[]),
                (23, 0.0, 2.0, &[]),
                (30, 0.0, 0.1, &[]),
                (31, 2.0, 0.1, &[]),
                (32, 2.0, 2.1, &[]),
                (33, 0.0, 2.1, &[]),
            ],
            &[
                (10, &[1, 20], &[("highway", "footway"), ("level", "0")]),
                (11, &[2, 32], &[("highway", "footway"), ("level", "1")]),
                (12, &[20, 21, 22, 23, 20], &[("highway", "elevator"), ("level", "0")]),
                (13, &[30, 31, 32, 33, 30], &[("highway", "elevator"), ("level", "1")]),
            ],
        );
        let g = &b.graph;
        assert_eq!(b.stats.lifts_stacked, 1);
        let lift = g.edges.iter().position(|e| e.kind == EdgeKind::Lift).expect("a lift edge between the floors");
        assert_eq!((g.edges[lift].level_a, g.edges[lift].level_b), (0, 2));
        assert_eq!(walk(g, (-200.0, 0.0), (202.0, 2.0), true).unwrap().lifts, 1);
    }

    #[test]
    fn two_shafts_side_by_side_are_two_lifts() {
        // shafts 2.3 m apart, one serving floors 0 and 1, the other 2 and 3: no ride from 0 to 3
        let b = world(
            &[
                (1, -200.0, 0.0, &[]),
                (2, -200.0, 1.0, &[]),
                (3, 202.0, 2.0, &[]),
                (4, 202.0, 3.0, &[]),
                (20, 0.0, 0.0, &[]),
                (21, 2.0, 0.0, &[]),
                (22, 2.0, 2.0, &[]),
                (23, 0.0, 2.0, &[]),
                (30, 2.3, 0.0, &[]),
                (31, 4.3, 0.0, &[]),
                (32, 4.3, 2.0, &[]),
                (33, 2.3, 2.0, &[]),
            ],
            &[
                (10, &[1, 20], &[("highway", "footway"), ("level", "0")]),
                (11, &[2, 23], &[("highway", "footway"), ("level", "1")]),
                (12, &[3, 32], &[("highway", "footway"), ("level", "3")]),
                (13, &[4, 31], &[("highway", "footway"), ("level", "2")]),
                (14, &[20, 21, 22, 23, 20], &[("highway", "elevator"), ("level", "0;1")]),
                (15, &[30, 31, 32, 33, 30], &[("highway", "elevator"), ("level", "2;3")]),
            ],
        );
        let g = &b.graph;
        assert_eq!(b.stats.lifts_stacked, 0);
        assert!(g.edges.iter().filter(|e| e.kind == EdgeKind::Lift).all(|e| (e.level_a, e.level_b) == (0, 2) || (e.level_a, e.level_b) == (4, 6)), "only 0↔1 and 2↔3");
        assert!(walk(g, (-200.0, 0.0), (202.0, 2.0), true).is_none(), "no ride from floor 0 to floor 3");
    }

    #[test]
    fn one_floor_outlines_side_by_side_are_not_stacked() {
        // two shafts 2.3 m apart (centres), each drawn for one floor (0 and 1): they do not touch
        let b = world(
            &[(1, -200.0, 0.0, &[]), (3, 202.0, 2.0, &[]), (20, 0.0, 0.0, &[]), (21, 2.0, 0.0, &[]), (22, 2.0, 2.0, &[]), (23, 0.0, 2.0, &[]),
              (30, 2.3, 0.0, &[]), (31, 4.3, 0.0, &[]), (32, 4.3, 2.0, &[]), (33, 2.3, 2.0, &[])],
            &[
                (10, &[1, 20], &[("highway", "footway"), ("level", "0")]),
                (12, &[3, 32], &[("highway", "footway"), ("level", "1")]),
                (14, &[20, 21, 22, 23, 20], &[("highway", "elevator"), ("level", "0")]),
                (15, &[30, 31, 32, 33, 30], &[("highway", "elevator"), ("level", "1")]),
            ],
        );
        assert_eq!(b.stats.lifts_stacked, 0);
        assert!(!b.graph.edges.iter().any(|e| e.kind == EdgeKind::Lift));
    }

    #[test]
    fn a_path_ending_just_inside_a_platform_is_joined() {
        // a footway ends 0.2 m inside a platform polygon, sharing no node with it
        let b = world(
            &[(1, 0.0, 0.0, &[]), (2, 100.0, 0.0, &[]), (3, 100.0, 8.0, &[]), (4, 0.0, 8.0, &[]), (5, -100.0, 0.0, &[]), (6, 50.0, 30.0, &[]), (7, 50.0, 7.8, &[])],
            &[(10, &[1, 2, 3, 4, 1], &[("railway", "platform"), ("area", "yes")]), (11, &[5, 1], FOOT), (12, &[6, 7], FOOT)],
        );
        let g = &b.graph;
        let end = at(g, 50.0, 7.8);
        assert!(end.iter().any(|&n| g.incident(n).iter().any(|&e| g.edges[e as usize].flags & EF_AREA != 0 && g.edges[e as usize].len_m() < 0.5)), "joined to the outline 0.2 m away");
    }

    #[test]
    fn stairs_up_into_a_platform_are_joined_to_it_not_the_passage_below() {
        // a 200 m × 10 m platform; stairs come up inside it from a passage on level -1 that runs under it
        const FOOT0: Kv = &[("highway", "footway"), ("level", "0")];
        let b = world(
            &[
                (1, 0.0, 0.0, &[]),
                (2, 200.0, 0.0, &[]),
                (3, 200.0, 10.0, &[]),
                (4, 0.0, 10.0, &[]),
                (5, -100.0, 0.0, &[]),
                (6, 100.0, 5.0, &[]),
                (7, 110.0, 5.0, &[]),
                (8, 110.0, 100.0, &[]),
            ],
            &[
                (10, &[1, 2, 3, 4, 1], &[("railway", "platform"), ("area", "yes"), ("level", "0")]),
                (11, &[5, 1], FOOT0),
                (12, &[6, 7], &[("highway", "steps"), ("level", "-1;0")]),
                (13, &[7, 8], &[("highway", "footway"), ("level", "-1"), ("tunnel", "yes")]),
            ],
        );
        let g = &b.graph;
        assert!(b.stats.inside_joins > 0);
        let joined = |x: f64, y: f64| at(g, x, y).iter().any(|&n| g.incident(n).iter().any(|&e| g.edges[e as usize].flags & EF_AREA != 0 && g.edge_way[e as usize] == 10));
        assert!(joined(100.0, 5.0), "the head of the stairs is on the platform");
        assert!(!joined(110.0, 5.0), "the foot of the stairs is under it");
        // from the platform's far end to the passage: down the stairs in the middle, not round anything
        let r = walk(g, (200.0, 5.0), (110.0, 100.0), false).unwrap();
        assert!(r.dist_m < 230.0, "{}", r.dist_m);
    }

    #[test]
    fn a_long_island_platform_is_crossed_where_you_stand() {
        // 300 m × 8 m, reached only at one corner: its two sides meet at the ends only
        let b = world(
            &[(1, 0.0, 0.0, &[]), (2, 300.0, 0.0, &[]), (3, 300.0, 8.0, &[]), (4, 0.0, 8.0, &[]), (5, -100.0, 0.0, &[])],
            &[(10, &[1, 2, 3, 4, 1], &[("railway", "platform"), ("area", "yes")]), (11, &[5, 1], FOOT)],
        );
        let g = &b.graph;
        let r = walk(g, (150.0, 0.0), (150.0, 8.0), false).unwrap();
        assert!(r.dist_m < 25.0, "across, not round the end: {}", r.dist_m);
    }

    #[test]
    fn unlevelled_ways_at_a_lift_are_separate_floors() {
        let b = world(
            &[(1, -200.0, 0.0, &[]), (2, 200.0, 0.0, &[]), (5, 0.0, 0.0, &[("highway", "elevator")])],
            &[(10, &[1, 5], FOOT), (11, &[5, 2], &[("highway", "footway"), ("bridge", "yes")])],
        );
        let g = &b.graph;
        assert_eq!(at(g, 0.0, 0.0).len(), 2);
        assert_eq!(g.edges.iter().filter(|e| e.kind == EdgeKind::Lift).count(), 1);
        assert_eq!(walk(g, (-200.0, 0.0), (200.0, 0.0), true).unwrap().lifts, 1);
    }

    #[test]
    fn private_gate_cuts_the_path_and_stile_only_flags() {
        let b = world(
            &[(1, 0.0, 0.0, &[]), (2, 200.0, 0.0, &[("barrier", "gate"), ("access", "private")]), (3, 400.0, 0.0, &[]), (4, 600.0, 0.0, &[("barrier", "stile")]), (5, 800.0, 0.0, &[])],
            &[(10, &[1, 2, 3, 4, 5], FOOT)],
        );
        let g = &b.graph;
        assert_eq!(at(g, 200.0, 0.0).len(), 2, "the gate is two unconnected nodes");
        assert!(walk(g, (0.0, 0.0), (400.0, 0.0), false).is_none());
        let stile = at(g, 600.0, 0.0);
        assert_eq!(stile.len(), 1);
        assert!(g.node_flags[stile[0] as usize] & NF_NO_WHEELCHAIR != 0);
        assert!(walk(g, (400.0, 0.0), (800.0, 0.0), false).is_some());
        assert!(walk(g, (400.0, 0.0), (800.0, 0.0), true).is_none());
        assert_eq!(b.stats.blocked_nodes, 1);
    }

    #[test]
    fn square_is_crossed_diagonally() {
        // 100 m square, footways leave from two opposite corners
        let b = world(
            &[(1, 0.0, 0.0, &[]), (2, 100.0, 0.0, &[]), (3, 100.0, 100.0, &[]), (4, 0.0, 100.0, &[]), (5, -200.0, 0.0, &[]), (6, 300.0, 100.0, &[])],
            &[(10, &[1, 2, 3, 4, 1], &[("highway", "pedestrian"), ("area", "yes"), ("name", "Platz"), ("level", "0")]), (11, &[5, 1], FOOT), (12, &[3, 6], FOOT)],
        );
        let g = &b.graph;
        let diag: Vec<usize> = (0..g.edges.len()).filter(|&e| g.edges[e].flags & EF_AREA != 0).collect();
        assert_eq!(diag.len(), 1);
        let e = &g.edges[diag[0]];
        assert!(e.kind == EdgeKind::Pedestrian && (e.len_m() - 141.4).abs() < 0.3 && e.geom_len == 2 && e.level_a == 0);
        assert_eq!(g.edge_way[diag[0]], 10);
        assert_eq!(g.edge_name(diag[0] as u32), "Platz");
        let r = walk(g, (-200.0, 0.0), (300.0, 100.0), false).unwrap();
        assert!((r.dist_m - 541.4).abs() < 1.0, "{}", r.dist_m);
    }

    #[test]
    fn platform_island_is_joined_and_listed() {
        // a 2.4 km sidewalk and a bus platform polygon 2 m beside it without a shared node
        let b = world(
            &[
                (1, -1200.0, 0.0, &[]),
                (2, 1200.0, 0.0, &[]),
                (10, 0.0, 2.0, &[]),
                (11, 20.0, 2.0, &[]),
                (12, 20.0, 5.0, &[]),
                (13, 0.0, 5.0, &[]),
                (20, 10.0, 6.0, &[("highway", "bus_stop"), ("name", "Dorf"), ("local_ref", "B"), ("uic_ref", "8500001")]),
            ],
            &[
                (100, &[1, 2], &[("highway", "footway"), ("footway", "sidewalk")]),
                (101, &[10, 11, 12, 13, 10], &[("public_transport", "platform"), ("bus", "yes"), ("ref", "A"), ("name", "Dorf"), ("ref:sloid", "ch:1:sloid:1:0:1")]),
            ],
        );
        let g = &b.graph;
        assert_eq!(b.stats.stitched_components, 1);
        assert_eq!(b.stats.stitch_edges, 2, "one connector near each end of the platform");
        let c = stats::components(g);
        assert_eq!(c.edges.len(), 1);
        let p = b.extract.platforms.iter().find(|p| p.osm_type == 1).unwrap();
        assert_eq!((p.kind, p.osm_id, p.refs.clone(), p.name.as_str(), p.sloid.as_str(), p.modes), (PlatformKind::PlatformWay, 101, vec!["A".to_string()], "Dorf", "ch:1:sloid:1:0:1", M_BUS));
        assert!(!p.edges.is_empty() && p.edges.iter().all(|&e| g.edges[e as usize].kind == EdgeKind::Platform));
        // outline (4 nodes: cut into pieces at the stitch corners) plus the two diagonals
        assert!(p.edges.iter().filter(|&&e| g.edges[e as usize].flags & EF_AREA != 0).count() == 2);
        let n = b.extract.platforms.iter().find(|p| p.osm_type == 0).unwrap();
        assert_eq!((n.kind, n.osm_id, n.refs.clone(), n.uic_ref, n.modes), (PlatformKind::PlatformNode, 20, vec!["B".to_string()], 8500001, M_BUS));
        // the sidewalk was split where the connectors land and still measures 2.4 km
        let side: f32 = g.edges.iter().filter(|e| e.kind == EdgeKind::Sidewalk).map(|e| e.len_m()).sum();
        assert!((side - 2400.0).abs() < 1.0);
        let r = walk(g, (-1200.0, 0.0), (10.0, 5.0), false).unwrap();
        // sidewalk 1200 m, connector 2 m, then round the platform edge to the middle of its far side
        assert!((r.dist_m - 1210.0).abs() < 8.0, "{}", r.dist_m);
    }

    #[test]
    fn crumbs_are_pruned_and_roads_become_carriageways() {
        let b = world(
            &[(1, 0.0, 0.0, &[]), (2, 500.0, 0.0, &[]), (3, 0.0, 300.0, &[]), (4, 40.0, 300.0, &[]), (5, 0.0, -50.0, &[]), (6, 500.0, -50.0, &[])],
            &[
                (10, &[1, 2], &[("highway", "secondary"), ("name", "Hauptstrasse")]),
                (11, &[3, 4], FOOT),
                (12, &[5, 6], &[("railway", "tram")]),
            ],
        );
        assert_eq!(b.graph.edges.len(), 1);
        assert_eq!(b.graph.edges[0].kind, EdgeKind::RoadBusy);
        assert_eq!((b.stats.pruned_edges, b.stats.pruned_components), (1, 1));
        let kinds: Vec<CarriagewayKind> = b.extract.carriageways.iter().map(|c| c.kind).collect();
        assert_eq!(kinds, vec![CarriagewayKind::Road, CarriagewayKind::TramTrack]);
        assert_eq!(b.extract.carriageway_names[b.extract.carriageways[0].name as usize], "Hauptstrasse");
    }
}
