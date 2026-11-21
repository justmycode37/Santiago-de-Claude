//! Uniform grid over edge geometry: nearest-edge snapping and box queries.
//!
//! Each cell lists the edges whose polyline passes through it (exact
//! rasterisation, so a ring search may stop as soon as the best hit is closer
//! than the next ring). Cell coordinates are planar metres in the national
//! frame of [`LatLon::xy`], measured from the south-west corner of the data.

use crate::net::{class_cost, lvl0, C_ROUGH, C_WC_BLOCK, C_X};
use crate::SnapOptions;
use kante_core::geo::{M_PER_DEG_LAT, REF_LAT};
use kante_core::*;
use rayon::prelude::*;

const MIN_CELL_M: f64 = 25.0;
const MAX_CELLS: f64 = 8_000_000.0;
/// The national frame is up to 2 % off east–west; ring pruning allows for it.
const FRAME_SLACK: f32 = 1.03;

pub(crate) struct Grid {
    lat0: i32,
    lon0: i32,
    /// Metres per 1e-7 degree in the grid frame.
    kx: f64,
    ky: f64,
    cell: f32,
    inv: f32,
    nx: i32,
    ny: i32,
    off: Vec<u32>,
    items: Vec<u32>,
}

/// Class of an edge irrespective of direction, for "can this walker use it".
fn edge_class(ed: &WalkEdge) -> u8 {
    let mut c = ed.kind as u8;
    if ed.flags & EF_WHEELCHAIR_NO != 0 {
        c |= C_WC_BLOCK;
    }
    if ed.flags & EF_ROUGH != 0 {
        c |= C_ROUGH;
    }
    if (ed.kind == EdgeKind::Steps && ed.flags & EF_RAMP != 0) || (matches!(ed.kind, EdgeKind::Road | EdgeKind::RoadBusy) && ed.flags & EF_HAS_SIDEWALK != 0) {
        c |= C_X;
    }
    c
}

/// Edges on a crumb of the step-free network: usable in themselves, but cut
/// off from everything else by stairs (a landing between two flights, the
/// few metres of path between two staircases). One bit per edge.
#[derive(Default)]
pub(crate) struct Crumbs {
    bits: Vec<u64>,
}

impl Crumbs {
    pub fn from_flags(flags: impl Iterator<Item = bool>) -> Crumbs {
        let mut bits = Vec::new();
        for (i, f) in flags.enumerate() {
            if i % 64 == 0 {
                bits.push(0u64);
            }
            if f {
                *bits.last_mut().unwrap() |= 1 << (i % 64);
            }
        }
        Crumbs { bits }
    }
    #[inline]
    pub fn contains(&self, e: u32) -> bool {
        self.bits.get(e as usize / 64).map_or(false, |w| w >> (e % 64) & 1 != 0)
    }
    pub fn heap_bytes(&self) -> usize {
        self.bits.len() * 8
    }
}

#[inline]
pub(crate) fn edge_allowed(e: u32, ed: &WalkEdge, opts: &SnapOptions, crumbs: &Crumbs) -> bool {
    if opts.exclude_kinds & (1u32 << ed.kind as u8) != 0 {
        return false;
    }
    if let Some(l) = opts.level {
        let (la, lb) = (lvl0(ed.level_a), lvl0(ed.level_b));
        if l < la.min(lb) || l > la.max(lb) {
            return false;
        }
    }
    if let Some(p) = &opts.profile {
        if class_cost(edge_class(ed), p).is_none() {
            return false;
        }
        if (p.wheelchair || p.stairs == StairsPref::Never) && crumbs.contains(e) {
            return false;
        }
    }
    true
}

impl Grid {
    pub fn build(g: &WalkGraph) -> Grid {
        let fold = |pts: &[LatLon]| {
            let mut b = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
            for p in pts {
                b.0 = b.0.min(p.lat);
                b.1 = b.1.min(p.lon);
                b.2 = b.2.max(p.lat);
                b.3 = b.3.max(p.lon);
            }
            b
        };
        let merge = |a: (i32, i32, i32, i32), b: (i32, i32, i32, i32)| (a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3));
        let none = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        let mut bb = g.geom.par_chunks(1 << 16).map(fold).reduce(|| none, merge);
        if bb.0 > bb.2 {
            bb = (0, 0, 0, 0);
        }
        let kx = 1e-7 * M_PER_DEG_LAT * REF_LAT.to_radians().cos();
        let ky = 1e-7 * M_PER_DEG_LAT;
        let w = (bb.3 as f64 - bb.1 as f64) * kx;
        let h = (bb.2 as f64 - bb.0 as f64) * ky;
        let cell = ((w * h) / MAX_CELLS).sqrt().max(MIN_CELL_M);
        let nx = (w / cell).floor() as i32 + 1;
        let ny = (h / cell).floor() as i32 + 1;
        let mut grid = Grid { lat0: bb.0, lon0: bb.1, kx, ky, cell: cell as f32, inv: (1.0 / cell) as f32, nx, ny, off: Vec::new(), items: Vec::new() };

        const CHUNK: usize = 4096;
        let gr = &grid;
        let chunks: Vec<Vec<u64>> = g
            .edges
            .par_chunks(CHUNK)
            .enumerate()
            .map(|(ci, es)| {
                let mut out: Vec<u64> = Vec::with_capacity(es.len() * 2);
                let mut tmp: Vec<u32> = Vec::new();
                for (j, ed) in es.iter().enumerate() {
                    let e = (ci * CHUNK + j) as u64;
                    let pts = &g.geom[ed.geom_off as usize..ed.geom_off as usize + ed.geom_len as usize];
                    tmp.clear();
                    gr.raster(pts, &mut tmp);
                    tmp.sort_unstable();
                    tmp.dedup();
                    out.extend(tmp.iter().map(|&c| (c as u64) << 32 | e));
                }
                out
            })
            .collect();
        let ncells = nx as usize * ny as usize;
        let mut off = vec![0u32; ncells + 1];
        for ch in &chunks {
            for &p in ch {
                off[(p >> 32) as usize + 1] += 1;
            }
        }
        for i in 1..off.len() {
            off[i] += off[i - 1];
        }
        let mut items = vec![0u32; off[ncells] as usize];
        let mut cur = off.clone();
        for ch in &chunks {
            for &p in ch {
                let c = (p >> 32) as usize;
                items[cur[c] as usize] = p as u32;
                cur[c] += 1;
            }
        }
        grid.off = off;
        grid.items = items;
        grid
    }

    pub fn heap_bytes(&self) -> usize {
        (self.off.len() + self.items.len()) * 4
    }
    pub fn cell_m(&self) -> f32 {
        self.cell
    }
    pub fn cells(&self) -> usize {
        self.nx as usize * self.ny as usize
    }
    pub fn entries(&self) -> usize {
        self.items.len()
    }

    /// Grid-frame metres of a coordinate.
    #[inline]
    fn gxy(&self, p: &LatLon) -> (f32, f32) {
        (((p.lon as f64 - self.lon0 as f64) * self.kx) as f32, ((p.lat as f64 - self.lat0 as f64) * self.ky) as f32)
    }
    #[inline]
    fn cx(&self, x: f32) -> i32 {
        ((x * self.inv).floor() as i32).clamp(0, self.nx - 1)
    }
    #[inline]
    fn cy(&self, y: f32) -> i32 {
        ((y * self.inv).floor() as i32).clamp(0, self.ny - 1)
    }
    #[inline]
    fn cell_items(&self, cx: i32, cy: i32) -> &[u32] {
        let c = cy as usize * self.nx as usize + cx as usize;
        &self.items[self.off[c] as usize..self.off[c + 1] as usize]
    }

    /// Cells touched by a polyline (may contain duplicates).
    fn raster(&self, pts: &[LatLon], out: &mut Vec<u32>) {
        let Some(first) = pts.first() else { return };
        let (mut ax, mut ay) = self.gxy(first);
        if pts.len() == 1 {
            out.push((self.cy(ay) * self.nx + self.cx(ax)) as u32);
            return;
        }
        let eps = self.cell * 1e-3;
        for p in &pts[1..] {
            let (bx, by) = self.gxy(p);
            let (cx0, cx1) = (self.cx(ax.min(bx) - eps), self.cx(ax.max(bx) + eps));
            let (cy0, cy1) = (self.cy(ay.min(by) - eps), self.cy(ay.max(by) + eps));
            if cx0 == cx1 || cy0 == cy1 {
                for cy in cy0..=cy1 {
                    for cx in cx0..=cx1 {
                        out.push((cy * self.nx + cx) as u32);
                    }
                }
            } else {
                // Row by row: the x-extent of the segment inside the row's slab.
                let (ymin, ymax) = (ay.min(by), ay.max(by));
                let slope = (bx - ax) / (by - ay);
                for cy in cy0..=cy1 {
                    let ylo = (cy as f32 * self.cell - eps).max(ymin);
                    let yhi = ((cy + 1) as f32 * self.cell + eps).min(ymax);
                    let xa = ax + (ylo - ay) * slope;
                    let xb = ax + (yhi - ay) * slope;
                    let (lo, hi) = (self.cx(xa.min(xb) - eps).max(cx0), self.cx(xa.max(xb) + eps).min(cx1));
                    for cx in lo..=hi {
                        out.push((cy * self.nx + cx) as u32);
                    }
                }
            }
            ax = bx;
            ay = by;
        }
    }

    /// Up to `k` nearest distinct allowed edges, nearest first, into `out`.
    pub fn nearest(&self, g: &WalkGraph, crumbs: &Crumbs, p: LatLon, opts: &SnapOptions, k: usize, out: &mut Vec<Snap>) {
        out.clear();
        if k == 0 || self.items.is_empty() || !(opts.max_dist_m >= 0.0) {
            return;
        }
        let (px, py) = self.gxy(&p);
        let (fx, fy) = (px * self.inv, py * self.inv);
        let (pcx, pcy) = (fx.floor() as i32, fy.floor() as i32);
        // Distance from p to the border of its own lattice cell.
        let (rx, ry) = (fx - pcx as f32, fy - pcy as f32);
        let border = rx.min(1.0 - rx).min(ry).min(1.0 - ry).max(0.0) * self.cell;
        // Local metric around p: metres per 1e-7 degree.
        let kx = (1e-7 * M_PER_DEG_LAT * (p.lat as f64 * 1e-7).to_radians().cos()) as f32;
        let ky = (1e-7 * M_PER_DEG_LAT) as f32;

        let mut bound = opts.max_dist_m;
        let mut seen = [u32::MAX; 64];
        let max_ring = (opts.max_dist_m * FRAME_SLACK * self.inv).ceil() as i32 + 1;
        for r in 0..=max_ring {
            if r > 0 && ((r - 1) as f32 * self.cell + border) > bound * FRAME_SLACK {
                break;
            }
            let (x0, x1, y0, y1) = (pcx - r, pcx + r, pcy - r, pcy + r);
            if x0 < 0 && y0 < 0 && x1 >= self.nx && y1 >= self.ny {
                break; // the ring encloses the whole grid
            }
            if x1 < 0 || y1 < 0 || x0 >= self.nx || y0 >= self.ny {
                continue; // p lies outside the grid; a later ring may reach it
            }
            let mut cy = y0.max(0);
            while cy <= y1.min(self.ny - 1) {
                let edge_row = cy == y0 || cy == y1;
                let mut cx = x0.max(0);
                let step = if edge_row { 1 } else { (2 * r).max(1) };
                // On interior rows only the two end cells belong to the ring.
                if !edge_row && cx != x0 {
                    cx = x1;
                }
                while cx <= x1.min(self.nx - 1) {
                    // Exact distance from p to this cell's rectangle.
                    let dx = (cx as f32 * self.cell - px).max(px - (cx + 1) as f32 * self.cell).max(0.0);
                    let dy = (cy as f32 * self.cell - py).max(py - (cy + 1) as f32 * self.cell).max(0.0);
                    if dx * dx + dy * dy <= (bound * FRAME_SLACK) * (bound * FRAME_SLACK) {
                        for &e in self.cell_items(cx, cy) {
                            let h = (e.wrapping_mul(0x9E37_79B1) >> 26) as usize;
                            if seen[h] == e {
                                continue;
                            }
                            seen[h] = e;
                            let ed = &g.edges[e as usize];
                            if !edge_allowed(e, ed, opts, crumbs) {
                                continue;
                            }
                            if let Some(s) = project(g, e, ed, &p, kx, ky, bound) {
                                if out.iter().any(|o| o.edge == e) {
                                    continue;
                                }
                                let at = out.partition_point(|o| o.dist_m <= s.dist_m);
                                out.insert(at, s);
                                out.truncate(k);
                                if out.len() == k {
                                    bound = out[k - 1].dist_m;
                                }
                            }
                        }
                    }
                    cx += step;
                }
                cy += 1;
            }
        }
    }

    /// Edges whose geometry intersects `bbox`, ascending.
    pub fn edges_in(&self, g: &WalkGraph, bbox: &BBox) -> Vec<u32> {
        let mut out = Vec::new();
        if self.items.is_empty() || bbox.min.lat > bbox.max.lat || bbox.min.lon > bbox.max.lon {
            return out;
        }
        let (x0, y0) = self.gxy(&bbox.min);
        let (x1, y1) = self.gxy(&bbox.max);
        if x1 < -self.cell || y1 < -self.cell || x0 > (self.nx + 1) as f32 * self.cell || y0 > (self.ny + 1) as f32 * self.cell {
            return out;
        }
        let (cx0, cx1, cy0, cy1) = (self.cx(x0), self.cx(x1), self.cy(y0), self.cy(y1));
        for cy in cy0..=cy1 {
            let inner_row = cy > cy0 && cy < cy1;
            for cx in cx0..=cx1 {
                let items = self.cell_items(cx, cy);
                if inner_row && cx > cx0 && cx < cx1 {
                    // Cell entirely inside the box: everything in it intersects.
                    out.extend_from_slice(items);
                } else {
                    out.extend(items.iter().copied().filter(|&e| geom_hits_box(g.edge_geom(e), bbox)));
                }
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }
}

/// Project `p` onto edge `e`; `None` if farther than `bound` metres.
#[inline]
fn project(g: &WalkGraph, e: u32, ed: &WalkEdge, p: &LatLon, kx: f32, ky: f32, bound: f32) -> Option<Snap> {
    let pts = &g.geom[ed.geom_off as usize..ed.geom_off as usize + ed.geom_len as usize];
    let first = pts.first()?;
    let rel = |q: &LatLon| ((q.lon - p.lon) as f32 * kx, (q.lat - p.lat) as f32 * ky);
    let (mut ax, mut ay) = rel(first);
    let mut best = (ax * ax + ay * ay, 0usize, 0f32);
    for (i, q) in pts[1..].iter().enumerate() {
        let (bx, by) = rel(q);
        let (dx, dy) = (bx - ax, by - ay);
        let l2 = dx * dx + dy * dy;
        let t = if l2 <= 1e-12 { 0.0 } else { (-(ax * dx + ay * dy) / l2).clamp(0.0, 1.0) };
        let (qx, qy) = (ax + t * dx, ay + t * dy);
        let d2 = qx * qx + qy * qy;
        if d2 < best.0 {
            best = (d2, i, t);
        }
        ax = bx;
        ay = by;
    }
    if !(best.0 <= bound * bound) {
        return None;
    }
    // Fraction of the polyline length up to the projected point.
    let (seg, t) = (best.1, best.2);
    let (mut before, mut total) = (0f32, 0f32);
    let (mut ax, mut ay) = rel(first);
    for (i, q) in pts[1..].iter().enumerate() {
        let (bx, by) = rel(q);
        let l = ((bx - ax) * (bx - ax) + (by - ay) * (by - ay)).sqrt();
        if i < seg {
            before += l;
        } else if i == seg {
            before += l * t;
        }
        total += l;
        ax = bx;
        ay = by;
    }
    let frac = if total > 0.0 { (before / total).clamp(0.0, 1.0) } else { 0.0 };
    let pos = if pts.len() > 1 { pts[seg].lerp(&pts[seg + 1], t) } else { *first };
    Some(Snap { edge: e, frac, pos, dist_m: best.0.sqrt() })
}

fn geom_hits_box(pts: &[LatLon], b: &BBox) -> bool {
    if pts.iter().any(|p| b.contains(p)) {
        return true;
    }
    pts.windows(2).any(|w| seg_hits_box(&w[0], &w[1], b))
}

/// Liang–Barsky: does segment a–b pass through the box (neither end inside)?
fn seg_hits_box(a: &LatLon, b: &LatLon, bx: &BBox) -> bool {
    let (x0, y0) = (a.lon as f64, a.lat as f64);
    let (dx, dy) = (b.lon as f64 - x0, b.lat as f64 - y0);
    let (mut t0, mut t1) = (0f64, 1f64);
    for (p, q) in [
        (-dx, x0 - bx.min.lon as f64),
        (dx, bx.max.lon as f64 - x0),
        (-dy, y0 - bx.min.lat as f64),
        (dy, bx.max.lat as f64 - y0),
    ] {
        if p == 0.0 {
            if q < 0.0 {
                return false;
            }
        } else {
            let r = q / p;
            if p < 0.0 {
                t0 = t0.max(r);
            } else {
                t1 = t1.min(r);
            }
            if t0 > t1 {
                return false;
            }
        }
    }
    true
}
