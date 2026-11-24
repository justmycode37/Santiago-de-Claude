//! Data-quality report for the walking network: map gaps that make walks wrong.
//!
//! ```text
//! walk-quality <data dir> [--bbox south,west,north,east] [--out DIR]
//! ```
//! `<data dir>` holds `walkgraph.bin` and `walkattr.bin` (or has them in `built/`). Counts go to stdout;
//! with `--out` every class is also written as a GeoJSON FeatureCollection (WGS84 lon/lat, properties `way`
//! = OSM way id, `name`, `length_m`, ...) next to a `summary.json`. With `--bbox` only items inside it count
//! (chains are cut at its border, so a chain end there may read as a gap end).
//!
//! Classes:
//! 1. **Separate sidewalks that join nothing** (`sidewalk_loose_both`, `sidewalk_loose_one`). A run is a
//!    maximal chain of `Sidewalk` edges through nodes where nothing else meets. A run end with graph degree
//!    1 is loose: no other way touches it. Runs under 10 m are ignored. Also `sidewalk_small_component`: a
//!    piece of the whole graph (any edge kind) with under 2 km of ways that contains sidewalks (one Point per piece).
//! 2. **Sidewalks tagged on the road but none drawn.** `road_tagged_sidewalk` is informational (summary only):
//!    road edges with `EF_HAS_SIDEWALK`, by road size. `sidewalk_not_drawn`: carriageways with
//!    `EA_SIDEWALK_SEPARATE` ("sidewalks are drawn apart") where no `Sidewalk`/`Footway`/`Path`/`Pedestrian`
//!    edge runs alongside: sample points every 10 m along chains of such carriageways; a point is covered
//!    by an edge within 20 m whose direction is within 30 degrees. Uncovered stretches over 50 m are reported.
//! 3. **Busy roads with no crossing for a long stretch** (`busy_road_no_crossing`). Chains of `Road`/`RoadBusy`
//!    edges of size tertiary or more (not on bridges or in tunnels), followed through nodes where exactly two
//!    such edges meet (same or missing name, or nothing else there). Crossing places: a crossing node
//!    (`NF_CROSSING*`, not `crossing=no`), a `Crossing` edge, or a ground-level footway, sidewalk, path or
//!    pedestrian edge meeting the road. Chain ends count as places (they are junctions with other big roads).
//!    Gaps over 300 m are reported when at least half of the gap has sidewalks (`EF_HAS_SIDEWALK` or
//!    `EA_SIDEWALK_SEPARATE`).

use anyhow::{bail, Context, Result};
use kante_core::geo::{BBox, LatLon};
use kante_core::io;
use kante_core::walk::*;
use rayon::prelude::*;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::Instant;

const MIN_RUN_M: f64 = 10.0;
const SMALL_COMPONENT_M: f64 = 2000.0;
const SAMPLE_M: f32 = 10.0;
const COVER_M: f32 = 20.0;
const COVER_ANGLE_COS: f32 = 0.866_025_4; // cos 30 degrees
const MIN_UNDRAWN_M: f64 = 50.0;
const MIN_CROSSING_GAP_M: f64 = 300.0;

// ------------------------------------------------------------------ items and output

#[derive(Clone, Debug)]
pub struct Item {
    pub pts: Vec<LatLon>, // one point = Point feature
    pub len_m: f64,
    pub name: String,
    pub way: i64,
    pub extra: Vec<(&'static str, f64)>,
}

impl Item {
    fn mid(&self) -> LatLon {
        self.pts[self.pts.len() / 2]
    }
}

#[derive(Default, Debug)]
pub struct Report {
    pub loose_both: Vec<Item>,
    pub loose_one: Vec<Item>,
    pub small_components: Vec<Item>,
    /// (edges, metres) per road size 0..=6.
    pub tagged_sidewalk: [(u64, f64); 7],
    pub not_drawn: Vec<Item>,
    pub no_crossing: Vec<Item>,
}

fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(o, "\\u{:04x}", c as u32);
            }
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn coord(p: &LatLon) -> String {
    format!("[{:.7},{:.7}]", p.lon_deg(), p.lat_deg())
}

fn geojson(items: &[Item]) -> String {
    let mut o = String::from("{\"type\":\"FeatureCollection\",\"features\":[\n");
    for (i, it) in items.iter().enumerate() {
        if i > 0 {
            o.push_str(",\n");
        }
        let geom = if it.pts.len() == 1 {
            format!("{{\"type\":\"Point\",\"coordinates\":{}}}", coord(&it.pts[0]))
        } else {
            format!("{{\"type\":\"LineString\",\"coordinates\":[{}]}}", it.pts.iter().map(coord).collect::<Vec<_>>().join(","))
        };
        let mut props = format!("\"way\":{},\"name\":{},\"length_m\":{:.1}", it.way, json_str(&it.name), it.len_m);
        for (k, v) in &it.extra {
            let _ = write!(props, ",\"{}\":{:.1}", k, v);
        }
        let _ = write!(o, "{{\"type\":\"Feature\",\"properties\":{{{}}},\"geometry\":{}}}", props, geom);
    }
    o.push_str("\n]}\n");
    o
}

fn total(items: &[Item]) -> f64 {
    items.iter().map(|i| i.len_m).fold(0.0, |a, b| a + b)
}

// ------------------------------------------------------------------ helpers

fn in_bbox(bb: &Option<BBox>, p: LatLon) -> bool {
    match bb {
        None => true,
        Some(b) => p.lat >= b.min.lat && p.lat <= b.max.lat && p.lon >= b.min.lon && p.lon <= b.max.lon,
    }
}

fn edge_mid(g: &WalkGraph, e: u32) -> LatLon {
    let geo = g.edge_geom(e);
    if geo.is_empty() {
        g.nodes[g.edges[e as usize].a as usize]
    } else {
        geo[geo.len() / 2]
    }
}

fn is_carriageway(k: EdgeKind) -> bool {
    matches!(k, EdgeKind::Road | EdgeKind::RoadBusy)
}

const OFF_GROUND: u16 = EF_TUNNEL | EF_BRIDGE | EF_INDOOR;

struct Dsu(Vec<u32>);
impl Dsu {
    fn new(n: usize) -> Self {
        Dsu((0..n as u32).collect())
    }
    fn find(&mut self, mut x: u32) -> u32 {
        while self.0[x as usize] != x {
            let p = self.0[x as usize];
            self.0[x as usize] = self.0[p as usize];
            x = p;
        }
        x
    }
    fn union(&mut self, a: u32, b: u32) {
        let (a, b) = (self.find(a), self.find(b));
        if a != b {
            self.0[a as usize] = b;
        }
    }
}

/// A path of set edges: `nodes.len() == edges.len() + 1`, `poly` is the oriented geometry,
/// `node_pt[i]` the index in `poly` of `nodes[i]`, `seg_edge[k]` the edge of `poly[k]..poly[k+1]`.
struct Chain {
    nodes: Vec<u32>,
    edges: Vec<u32>,
    poly: Vec<LatLon>,
    node_pt: Vec<usize>,
    seg_edge: Vec<u32>,
}

/// Chains of the edges with `in_set`, continued through nodes where exactly two set edges meet and
/// `allow(node, e1, e2)` holds.
fn build_chains(g: &WalkGraph, in_set: &[bool], allow: &(dyn Fn(u32, u32, u32) -> bool + Sync)) -> Vec<Chain> {
    let cont = |n: u32, e: u32| -> Option<u32> {
        let (mut cnt, mut other) = (0, None);
        for &x in g.incident(n) {
            if in_set[x as usize] {
                cnt += 1;
                if x != e {
                    other = Some(x);
                }
            }
        }
        match other {
            Some(o) if cnt == 2 && allow(n, e, o) => Some(o),
            _ => None,
        }
    };
    let mut seen = vec![false; g.edges.len()];
    let mut raw: Vec<(Vec<u32>, Vec<u32>)> = Vec::new();
    for s in 0..g.edges.len() as u32 {
        if !in_set[s as usize] || seen[s as usize] {
            continue;
        }
        seen[s as usize] = true;
        let se = g.edges[s as usize];
        let (mut fnodes, mut fedges) = (vec![se.b], Vec::new());
        let (mut cur, mut node) = (s, se.b);
        while let Some(o) = cont(node, cur) {
            if seen[o as usize] {
                break;
            }
            seen[o as usize] = true;
            node = g.edges[o as usize].other(node);
            fedges.push(o);
            fnodes.push(node);
            cur = o;
        }
        let (mut bnodes, mut bedges) = (vec![se.a], Vec::new());
        let (mut cur, mut node) = (s, se.a);
        while let Some(o) = cont(node, cur) {
            if seen[o as usize] {
                break;
            }
            seen[o as usize] = true;
            node = g.edges[o as usize].other(node);
            bedges.push(o);
            bnodes.push(node);
            cur = o;
        }
        bnodes.reverse();
        bedges.reverse();
        let mut nodes = bnodes;
        nodes.extend(fnodes);
        let mut edges = bedges;
        edges.push(s);
        edges.extend(fedges);
        raw.push((nodes, edges));
    }
    raw.into_par_iter()
        .map(|(nodes, edges)| {
            let mut poly: Vec<LatLon> = vec![g.nodes[nodes[0] as usize]];
            let mut node_pt = vec![0usize];
            let mut seg_edge = Vec::new();
            for (i, &e) in edges.iter().enumerate() {
                let ed = &g.edges[e as usize];
                let geo = g.edge_geom(e);
                let pts: Vec<LatLon> = if geo.len() < 2 {
                    vec![g.nodes[nodes[i] as usize], g.nodes[nodes[i + 1] as usize]]
                } else if ed.a == nodes[i] {
                    geo.to_vec()
                } else {
                    geo.iter().rev().copied().collect()
                };
                for p in pts.iter().skip(1) {
                    poly.push(*p);
                    seg_edge.push(e);
                }
                node_pt.push(poly.len() - 1);
            }
            Chain { nodes, edges, poly, node_pt, seg_edge }
        })
        .collect()
}

fn chain_cum(c: &Chain) -> Vec<f64> {
    let mut cum = vec![0.0f64; c.poly.len()];
    for k in 1..c.poly.len() {
        cum[k] = cum[k - 1] + c.poly[k - 1].dist_m(&c.poly[k]) as f64;
    }
    cum
}

fn way_of(g: &WalkGraph, e: u32) -> i64 {
    g.edge_way.get(e as usize).copied().unwrap_or(0)
}

// ------------------------------------------------------------------ class 1

fn class1(g: &WalkGraph, bb: &Option<BBox>, rep: &mut Report) {
    let is_sw: Vec<bool> = g.edges.iter().map(|e| e.kind == EdgeKind::Sidewalk && e.a != e.b).collect();
    let chains = build_chains(g, &is_sw, &|n, _, _| g.incident(n).len() == 2);
    for c in &chains {
        let (first, last) = (c.nodes[0], *c.nodes.last().unwrap());
        if first == last {
            continue;
        }
        let loose = [first, last].iter().filter(|&&n| g.incident(n).len() == 1).count();
        if loose == 0 {
            continue;
        }
        let len: f64 = c.edges.iter().map(|&e| g.edges[e as usize].len_m() as f64).sum();
        if len < MIN_RUN_M {
            continue;
        }
        let best = *c.edges.iter().max_by_key(|&&e| g.edges[e as usize].len_dm).unwrap();
        if !in_bbox(bb, edge_mid(g, best)) {
            continue;
        }
        let item = Item { pts: c.poly.clone(), len_m: len, name: g.edge_name(best).to_string(), way: way_of(g, best), extra: vec![("edges", c.edges.len() as f64)] };
        if loose == 2 {
            rep.loose_both.push(item);
        } else {
            rep.loose_one.push(item);
        }
    }
    // small components holding sidewalks
    let mut dsu = Dsu::new(g.nodes.len());
    for e in &g.edges {
        dsu.union(e.a, e.b);
    }
    let n = g.nodes.len();
    let mut len = vec![0f64; n];
    let mut sw = vec![0u32; n];
    let mut best: Vec<u32> = vec![u32::MAX; n];
    for (i, e) in g.edges.iter().enumerate() {
        let r = dsu.find(e.a) as usize;
        len[r] += e.len_m() as f64;
        if e.kind == EdgeKind::Sidewalk {
            sw[r] += 1;
            if best[r] == u32::MAX || g.edges[best[r] as usize].len_dm < e.len_dm {
                best[r] = i as u32;
            }
        }
    }
    for r in 0..n {
        if sw[r] > 0 && len[r] < SMALL_COMPONENT_M {
            let e = best[r];
            let p = edge_mid(g, e);
            if in_bbox(bb, p) {
                rep.small_components.push(Item { pts: vec![p], len_m: len[r], name: g.edge_name(e).to_string(), way: way_of(g, e), extra: vec![("sidewalk_edges", sw[r] as f64)] });
            }
        }
    }
}

// ------------------------------------------------------------------ class 2

struct Seg {
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
}

const CELL_M: f32 = 30.0;

fn cell_key(x: f32, y: f32) -> u64 {
    let cx = (x / CELL_M).floor() as i64 + (1 << 20);
    let cy = (y / CELL_M).floor() as i64 + (1 << 20);
    ((cx as u64) << 32) | cy as u64
}

struct Index {
    segs: Vec<Seg>,
    cells: Vec<(u64, u32)>,
}

impl Index {
    fn build(g: &WalkGraph, keep: impl Fn(u32) -> bool + Sync) -> Index {
        let ids: Vec<u32> = (0..g.edges.len() as u32).into_par_iter().filter(|&e| keep(e)).collect();
        let segs: Vec<Seg> = ids
            .par_iter()
            .flat_map_iter(|&e| {
                let geo = g.edge_geom(e);
                (1..geo.len()).filter_map(move |k| {
                    let (a, b) = (geo[k - 1].xy(), geo[k].xy());
                    (a != b).then_some(Seg { x1: a.0, y1: a.1, x2: b.0, y2: b.1 })
                })
            })
            .collect();
        let mut cells: Vec<(u64, u32)> = segs
            .par_iter()
            .enumerate()
            .flat_map_iter(|(i, s)| {
                let len = ((s.x2 - s.x1).powi(2) + (s.y2 - s.y1).powi(2)).sqrt();
                let n = (len / 8.0).ceil().max(1.0) as usize;
                let mut v: Vec<(u64, u32)> = Vec::with_capacity(n + 1);
                for k in 0..=n {
                    let t = k as f32 / n as f32;
                    let key = cell_key(s.x1 + (s.x2 - s.x1) * t, s.y1 + (s.y2 - s.y1) * t);
                    if v.last().map(|l| l.0) != Some(key) {
                        v.push((key, i as u32));
                    }
                }
                v
            })
            .collect();
        cells.par_sort_unstable();
        cells.dedup();
        Index { segs, cells }
    }

    /// Is some segment within `COVER_M` of (x, y) and within 30 degrees of direction (dx, dy) (unit)?
    fn covered(&self, x: f32, y: f32, dx: f32, dy: f32) -> bool {
        let (cx, cy) = ((x / CELL_M).floor() as i64, (y / CELL_M).floor() as i64);
        for ix in cx - 1..=cx + 1 {
            for iy in cy - 1..=cy + 1 {
                let key = (((ix + (1 << 20)) as u64) << 32) | (iy + (1 << 20)) as u64;
                let lo = self.cells.partition_point(|c| c.0 < key);
                for c in self.cells[lo..].iter().take_while(|c| c.0 == key) {
                    let s = &self.segs[c.1 as usize];
                    let (vx, vy) = (s.x2 - s.x1, s.y2 - s.y1);
                    let l2 = vx * vx + vy * vy;
                    let l = l2.sqrt();
                    if ((vx * dx + vy * dy) / l).abs() < COVER_ANGLE_COS {
                        continue;
                    }
                    let t = (((x - s.x1) * vx + (y - s.y1) * vy) / l2).clamp(0.0, 1.0);
                    let (px, py) = (s.x1 + vx * t - x, s.y1 + vy * t - y);
                    if px * px + py * py <= COVER_M * COVER_M {
                        return true;
                    }
                }
            }
        }
        false
    }
}

/// Points every `SAMPLE_M` along the polyline with the unit direction there: (x, y, dx, dy, index of its segment).
fn sample_poly(poly: &[LatLon]) -> Vec<(f32, f32, f32, f32, usize)> {
    let xy: Vec<(f32, f32)> = poly.iter().map(|p| p.xy()).collect();
    let mut out = Vec::new();
    let mut next = 0.0f32;
    let mut base = 0.0f32;
    for k in 0..xy.len().saturating_sub(1) {
        let (vx, vy) = (xy[k + 1].0 - xy[k].0, xy[k + 1].1 - xy[k].1);
        let l = (vx * vx + vy * vy).sqrt();
        if l < 1e-3 {
            continue;
        }
        while next <= base + l {
            let t = (next - base) / l;
            out.push((xy[k].0 + vx * t, xy[k].1 + vy * t, vx / l, vy / l, k));
            next += SAMPLE_M;
        }
        base += l;
    }
    out
}

fn class2(g: &WalkGraph, bb: &Option<BBox>, rep: &mut Report) {
    let a = &g.attrs;
    for (i, e) in g.edges.iter().enumerate() {
        if is_carriageway(e.kind) && e.flags & EF_HAS_SIDEWALK != 0 && in_bbox(bb, edge_mid(g, i as u32)) {
            let r = a.road(i as u32).min(6) as usize;
            rep.tagged_sidewalk[r].0 += 1;
            rep.tagged_sidewalk[r].1 += e.len_m() as f64;
        }
    }
    let in_set: Vec<bool> = g
        .edges
        .iter()
        .enumerate()
        .map(|(i, e)| {
            let at = a.edge(i as u32);
            is_carriageway(e.kind) && e.a != e.b && at & EA_SIDEWALK_SEPARATE != 0 && at & EA_CAR_ONLY == 0 && e.flags & OFF_GROUND == 0 && in_bbox(bb, edge_mid(g, i as u32))
        })
        .collect();
    if !in_set.iter().any(|&b| b) {
        return;
    }
    // sidewalks near the region of interest
    let wide = bb.map(|b| {
        let d = 3000i32; // 0.0003 degrees: about 33 m
        BBox { min: LatLon { lat: b.min.lat - d, lon: b.min.lon - d }, max: LatLon { lat: b.max.lat + d, lon: b.max.lon + d } }
    });
    let idx = Index::build(g, |e| {
        let ed = &g.edges[e as usize];
        matches!(ed.kind, EdgeKind::Sidewalk | EdgeKind::Footway | EdgeKind::Path | EdgeKind::Pedestrian) && ed.flags & (OFF_GROUND | EF_AREA) == 0 && in_bbox(&wide, edge_mid(g, e))
    });
    let chains = build_chains(g, &in_set, &|n, e1, e2| {
        let (n1, n2) = (g.edges[e1 as usize].name, g.edges[e2 as usize].name);
        n1 == n2 || n1 == 0 || n2 == 0 || g.incident(n).len() == 2
    });
    let found: Vec<Item> = chains
        .par_iter()
        .flat_map_iter(|c| {
            let samples = sample_poly(&c.poly);
            let covered: Vec<bool> = samples.iter().map(|s| idx.covered(s.0, s.1, s.2, s.3)).collect();
            let mut out = Vec::new();
            let mut i = 0;
            while i < samples.len() {
                if covered[i] {
                    i += 1;
                    continue;
                }
                let j = (i..samples.len()).find(|&j| covered[j]).unwrap_or(samples.len());
                let len = (j - i) as f64 * SAMPLE_M as f64;
                if len > MIN_UNDRAWN_M {
                    let mid = c.seg_edge[samples[(i + j) / 2].4];
                    let ed = &g.edges[mid as usize];
                    let mut pts: Vec<LatLon> = samples[i..j].iter().map(|s| LatLon::from_xy(s.0, s.1)).collect();
                    if pts.len() < 2 {
                        pts.push(pts[0]);
                    }
                    out.push(Item {
                        pts,
                        len_m: len,
                        name: g.edge_name(mid).to_string(),
                        way: way_of(g, mid),
                        extra: vec![("road", g.attrs.road(mid) as f64), ("has_sidewalk_tag", (ed.flags & EF_HAS_SIDEWALK != 0) as u8 as f64)],
                    });
                }
                i = j;
            }
            out
        })
        .collect();
    rep.not_drawn = found;
}

// ------------------------------------------------------------------ class 3

fn is_crossing_place(g: &WalkGraph, n: u32) -> bool {
    if g.attrs.node(n) & NA_CROSSING_NO != 0 {
        return false;
    }
    if g.node_flags[n as usize] & (NF_CROSSING | NF_CROSSING_SIGNALS) != 0 {
        return true;
    }
    g.incident(n).iter().any(|&x| {
        let e = &g.edges[x as usize];
        match e.kind {
            EdgeKind::Crossing => true,
            EdgeKind::Footway | EdgeKind::Sidewalk | EdgeKind::Path | EdgeKind::Pedestrian => e.flags & OFF_GROUND == 0,
            _ => false,
        }
    })
}

fn class3(g: &WalkGraph, bb: &Option<BBox>, rep: &mut Report) {
    let a = &g.attrs;
    let in_set: Vec<bool> = g
        .edges
        .iter()
        .enumerate()
        .map(|(i, e)| is_carriageway(e.kind) && e.a != e.b && a.road(i as u32) >= RC_TERTIARY && e.flags & OFF_GROUND == 0 && in_bbox(bb, edge_mid(g, i as u32)))
        .collect();
    let chains = build_chains(g, &in_set, &|n, e1, e2| {
        let (n1, n2) = (g.edges[e1 as usize].name, g.edges[e2 as usize].name);
        n1 == n2 || n1 == 0 || n2 == 0 || g.incident(n).len() == 2
    });
    rep.no_crossing = chains
        .par_iter()
        .flat_map_iter(|c| {
            let cum = chain_cum(c);
            let last = c.nodes.len() - 1;
            let places: Vec<usize> = (0..=last).filter(|&i| i == 0 || i == last || is_crossing_place(g, c.nodes[i])).collect();
            let mut out = Vec::new();
            for w in places.windows(2) {
                let (i, j) = (w[0], w[1]);
                let gap = cum[c.node_pt[j]] - cum[c.node_pt[i]];
                if gap <= MIN_CROSSING_GAP_M {
                    continue;
                }
                let es = &c.edges[i..j];
                let total: f64 = es.iter().map(|&e| g.edges[e as usize].len_m() as f64).sum();
                let with: f64 = es
                    .iter()
                    .filter(|&&e| g.edges[e as usize].flags & EF_HAS_SIDEWALK != 0 || g.attrs.edge(e) & EA_SIDEWALK_SEPARATE != 0)
                    .map(|&e| g.edges[e as usize].len_m() as f64)
                    .sum();
                if with * 2.0 < total {
                    continue;
                }
                let mid = es[es.len() / 2];
                out.push(Item {
                    pts: c.poly[c.node_pt[i]..=c.node_pt[j]].to_vec(),
                    len_m: gap,
                    name: g.edge_name(mid).to_string(),
                    way: way_of(g, mid),
                    extra: vec![("road", g.attrs.road(mid) as f64), ("sidewalk_share", with / total.max(0.1))],
                });
            }
            out
        })
        .collect();
}

// ------------------------------------------------------------------ driver

pub fn analyse(g: &WalkGraph, bb: &Option<BBox>) -> Report {
    let mut rep = Report::default();
    class1(g, bb, &mut rep);
    class2(g, bb, &mut rep);
    class3(g, bb, &mut rep);
    for v in [&mut rep.loose_both, &mut rep.loose_one, &mut rep.small_components, &mut rep.not_drawn, &mut rep.no_crossing] {
        v.sort_by(|x, y| y.len_m.total_cmp(&x.len_m));
    }
    rep
}

fn parse_bbox(s: &str) -> Result<BBox> {
    let v: Vec<f64> = s.split(',').map(|x| x.trim().parse::<f64>()).collect::<std::result::Result<_, _>>().context("--bbox south,west,north,east")?;
    if v.len() != 4 {
        bail!("--bbox needs south,west,north,east");
    }
    Ok(BBox::from_deg(v[0], v[1], v[2], v[3]))
}

fn find(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if p.exists() {
        p
    } else {
        dir.join("built").join(name)
    }
}

fn main() -> Result<()> {
    let t0 = Instant::now();
    let mut dir: Option<PathBuf> = None;
    let mut bbox = None;
    let mut out: Option<PathBuf> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--bbox" => bbox = Some(parse_bbox(&args.next().context("--bbox value")?)?),
            "--out" => out = Some(PathBuf::from(args.next().context("--out value")?)),
            "-h" | "--help" => {
                println!("walk-quality <data dir> [--bbox south,west,north,east] [--out DIR]");
                return Ok(());
            }
            _ if dir.is_none() => dir = Some(PathBuf::from(a)),
            _ => bail!("unexpected argument {a}"),
        }
    }
    let dir = dir.context("usage: walk-quality <data dir> [--bbox south,west,north,east] [--out DIR]")?;
    let mut g: WalkGraph = io::load(&find(&dir, "walkgraph.bin"), WALKGRAPH_SCHEMA)?;
    let attrs: WalkAttrs = io::load(&find(&dir, "walkattr.bin"), WALKATTR_SCHEMA)?;
    if attrs.graph != graph_fingerprint(&g) || !attrs.fits(&g) {
        bail!("walkattr.bin does not belong to walkgraph.bin; rebuild the data");
    }
    g.attrs = attrs;
    eprintln!("loaded {} nodes, {} edges in {:.1}s", g.nodes.len(), g.edges.len(), t0.elapsed().as_secs_f64());
    let t1 = Instant::now();
    let rep = analyse(&g, &bbox);
    let secs = t1.elapsed().as_secs_f64();

    let classes: [(&str, &str, &Vec<Item>); 5] = [
        ("sidewalk_loose_both", "sidewalk runs, both ends loose", &rep.loose_both),
        ("sidewalk_loose_one", "sidewalk runs, one end loose", &rep.loose_one),
        ("sidewalk_small_component", "sidewalk pieces < 2 km of ways", &rep.small_components),
        ("sidewalk_not_drawn", "separate sidewalks tagged, none drawn", &rep.not_drawn),
        ("busy_road_no_crossing", "busy road, > 300 m without crossing", &rep.no_crossing),
    ];
    println!("{:<26} {:<40} {:>8} {:>10}", "class", "meaning", "items", "km");
    for (k, d, v) in &classes {
        println!("{:<26} {:<40} {:>8} {:>10.1}", k, d, v.len(), total(v) / 1000.0);
    }
    let names = ["none", "minor", "service", "tertiary", "secondary", "primary", "trunk"];
    println!("road_tagged_sidewalk (info, no sidewalk way drawn; side unknown):");
    for (i, n) in names.iter().enumerate() {
        let (c, m) = rep.tagged_sidewalk[i];
        if c > 0 {
            println!("  {:<10} {:>8} edges {:>10.1} km", n, c, m / 1000.0);
        }
    }
    for (k, _, v) in &classes {
        println!("top 5 {k}:");
        for it in v.iter().take(5) {
            let m = it.mid();
            println!("  {:>8.0} m  {:<32} way {:<12} {:.5},{:.5}", it.len_m, if it.name.is_empty() { "(unnamed)" } else { &it.name }, it.way, m.lat_deg(), m.lon_deg());
        }
    }
    println!("analysis {:.1}s, total {:.1}s", secs, t0.elapsed().as_secs_f64());

    if let Some(o) = out {
        std::fs::create_dir_all(&o)?;
        let mut sum = String::from("{\n");
        if let Some(b) = &bbox {
            let _ = writeln!(sum, "  \"bbox\": [{},{},{},{}],", b.min.lat_deg(), b.min.lon_deg(), b.max.lat_deg(), b.max.lon_deg());
        }
        let _ = writeln!(sum, "  \"nodes\": {}, \"edges\": {}, \"analysis_seconds\": {:.1},", g.nodes.len(), g.edges.len(), secs);
        sum.push_str("  \"classes\": {\n");
        for (k, d, v) in classes.iter() {
            std::fs::write(o.join(format!("{k}.geojson")), geojson(v))?;
            let _ = writeln!(sum, "    \"{k}\": {{\"description\": {}, \"items\": {}, \"length_m\": {:.0}}},", json_str(d), v.len(), total(v));
        }
        sum.push_str("    \"road_tagged_sidewalk\": {");
        let parts: Vec<String> = names.iter().enumerate().map(|(i, n)| format!("\"{}\": {{\"edges\": {}, \"length_m\": {:.0}}}", n, rep.tagged_sidewalk[i].0, rep.tagged_sidewalk[i].1)).collect();
        sum.push_str(&parts.join(", "));
        sum.push_str("}\n  }\n}\n");
        std::fs::write(o.join("summary.json"), sum)?;
        println!("wrote {}", o.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kante_osm::build::Csr;

    /// nodes in planar metres (x east, y north); edges (a, b, kind, flags, name, EA_*).
    fn mk(nodes: &[(f32, f32)], es: &[(u32, u32, EdgeKind, u16, u32, u8)]) -> WalkGraph {
        let pos: Vec<LatLon> = nodes.iter().map(|&(x, y)| LatLon::from_xy(x, y)).collect();
        let mut geom = Vec::new();
        let mut edges = Vec::new();
        for &(a, b, kind, flags, name, _) in es {
            let off = geom.len() as u32;
            geom.push(pos[a as usize]);
            geom.push(pos[b as usize]);
            let len = pos[a as usize].dist_m(&pos[b as usize]);
            edges.push(WalkEdge { a, b, geom_off: off, geom_len: 2, kind, level_a: LEVEL_NONE, level_b: LEVEL_NONE, steps: 0, flags, len_dm: (len * 10.0) as u32, name });
        }
        let csr = Csr::new(nodes.len(), &edges);
        let mut g = WalkGraph {
            node_flags: vec![0; nodes.len()],
            nodes: pos,
            adj_off: csr.off,
            adj: csr.adj,
            edge_way: (0..edges.len() as i64).map(|i| 100 + i).collect(),
            edges,
            geom,
            names: vec![String::new(), "Teststrasse".into()],
            ..Default::default()
        };
        g.attrs = WalkAttrs { graph: 0, edge: es.iter().map(|e| e.5).collect(), node: vec![0; nodes.len()], hours: vec![], edge_hours: vec![] };
        g
    }

    const SW: EdgeKind = EdgeKind::Sidewalk;

    #[test]
    fn loose_sidewalk_runs() {
        // 0-1-2-3 sidewalk run (both ends loose); 4-5-6 run whose end 6 meets a footway loop.
        let nodes = [(0., 0.), (50., 0.), (100., 0.), (150., 0.), (0., 100.), (50., 100.), (100., 100.), (150., 100.), (150., 150.), (100., 150.)];
        let es = [
            (0, 1, SW, 0, 0, 0),
            (1, 2, SW, 0, 0, 0),
            (2, 3, SW, 0, 0, 0),
            (4, 5, SW, 0, 0, 0),
            (5, 6, SW, 0, 0, 0),
            (6, 7, EdgeKind::Footway, 0, 0, 0),
            (7, 8, EdgeKind::Footway, 0, 0, 0),
            (8, 9, EdgeKind::Footway, 0, 0, 0),
            (9, 6, EdgeKind::Footway, 0, 0, 0),
        ];
        let g = mk(&nodes, &es);
        let rep = analyse(&g, &None);
        assert_eq!(rep.loose_both.len(), 1);
        assert!((rep.loose_both[0].len_m - 150.0).abs() < 1.0);
        assert_eq!(rep.loose_one.len(), 1);
        assert!((rep.loose_one[0].len_m - 100.0).abs() < 1.0);
    }

    #[test]
    fn short_runs_and_small_components() {
        let g = mk(&[(0., 0.), (6., 0.), (0., 300.), (3000., 300.)], &[(0, 1, SW, 0, 0, 0), (2, 3, SW, 0, 0, 0)]);
        let rep = analyse(&g, &None);
        assert_eq!(rep.loose_both.len(), 1); // the 6 m run is ignored
        assert_eq!(rep.small_components.len(), 1); // the 3 km one is not small
        assert!((rep.small_components[0].len_m - 6.0).abs() < 0.5);
    }

    /// 300 m road along x with separate sidewalks tagged; a parallel sidewalk at offset `dy`, or a perpendicular
    /// footway at x = `dx`.
    fn road_with_sidewalk_at(dx: f32, dy: f32, flags: u16) -> WalkGraph {
        let mut nodes = vec![(0., 0.), (150., 0.), (300., 0.)];
        let sep = EA_SIDEWALK_SEPARATE | RC_SECONDARY;
        let mut es = vec![(0, 1, EdgeKind::RoadBusy, 0, 1, sep), (1, 2, EdgeKind::RoadBusy, 0, 1, sep)];
        if dy != 0.0 {
            nodes.extend([(0., dy), (300., dy)]);
            es.push((3, 4, SW, flags, 0, 0));
        }
        if dx != 0.0 {
            nodes.extend([(dx, 5.), (dx, 100.)]);
            es.push((3, 4, EdgeKind::Footway, flags, 0, 0));
        }
        mk(&nodes, &es)
    }

    #[test]
    fn sidewalk_not_drawn() {
        let rep = analyse(&road_with_sidewalk_at(0.0, 0.0, 0), &None);
        assert_eq!(rep.not_drawn.len(), 1, "{:?}", rep.not_drawn);
        assert!(rep.not_drawn[0].len_m >= 290.0);
        assert_eq!(rep.not_drawn[0].name, "Teststrasse");
        // parallel sidewalk 8 m away covers it
        assert!(analyse(&road_with_sidewalk_at(0.0, 8.0, 0), &None).not_drawn.is_empty());
        // too far (30 m) does not
        assert_eq!(analyse(&road_with_sidewalk_at(0.0, 30.0, 0), &None).not_drawn.len(), 1);
        // a perpendicular footway is not alongside: nothing is covered
        assert_eq!(analyse(&road_with_sidewalk_at(150.0, 0.0, 0), &None).not_drawn.len(), 1);
        // a sidewalk in a tunnel does not count
        assert_eq!(analyse(&road_with_sidewalk_at(0.0, 8.0, EF_TUNNEL), &None).not_drawn.len(), 1);
    }

    fn busy_road(crossing_at: &[usize], sidewalk: bool) -> WalkGraph {
        let nodes: Vec<(f32, f32)> = (0..5).map(|i| (i as f32 * 200.0, 0.0)).collect();
        let fl = if sidewalk { EF_HAS_SIDEWALK } else { 0 };
        let es: Vec<_> = (0..4).map(|i| (i, i + 1, EdgeKind::RoadBusy, fl, 1, RC_PRIMARY)).collect();
        let mut g = mk(&nodes, &es);
        for &i in crossing_at {
            g.node_flags[i] = NF_CROSSING;
        }
        g
    }

    #[test]
    fn busy_road_gaps() {
        let rep = analyse(&busy_road(&[], true), &None);
        assert_eq!(rep.no_crossing.len(), 1);
        assert!((rep.no_crossing[0].len_m - 800.0).abs() < 2.0);
        // crossing in the middle: two 400 m gaps
        assert_eq!(analyse(&busy_road(&[2], true), &None).no_crossing.len(), 2);
        // crossings every 200 m: none
        assert!(analyse(&busy_road(&[1, 2, 3], true), &None).no_crossing.is_empty());
        // outside built-up area (no sidewalks): not reported
        assert!(analyse(&busy_road(&[], false), &None).no_crossing.is_empty());
        // a crossing=no node does not count
        let mut g = busy_road(&[], true);
        g.node_flags[2] = NF_CROSSING;
        g.attrs.node[2] = NA_CROSSING_NO;
        assert_eq!(analyse(&g, &None).no_crossing.len(), 1);
    }

    #[test]
    fn bbox_filters() {
        let g = busy_road(&[], true);
        let far = Some(BBox::from_deg(10.0, 10.0, 11.0, 11.0));
        assert!(analyse(&g, &far).no_crossing.is_empty());
    }
}
