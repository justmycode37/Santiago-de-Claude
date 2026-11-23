//! Polygon helpers for walkable areas (squares, platforms): ring assembly for
//! multipolygons, point/segment-in-polygon tests and the choice of straight
//! "visibility" edges across an area.
//!
//! All geometry is done in local planar metres (`P`), rings are stored open
//! (the closing vertex is not repeated).

use kante_core::geo::{LatLon, M_PER_DEG_LAT};
use rustc_hash::FxHashMap;

pub type P = (f64, f64);

/// Local planar frame around `origin`.
#[derive(Clone, Copy)]
pub struct Frame {
    lat0: i32,
    lon0: i32,
    kx: f64,
}

impl Frame {
    pub fn new(origin: LatLon) -> Self {
        Frame { lat0: origin.lat, lon0: origin.lon, kx: origin.lat_deg().to_radians().cos() * M_PER_DEG_LAT * 1e-7 }
    }
    #[inline]
    pub fn to_xy(&self, p: LatLon) -> P {
        ((p.lon - self.lon0) as f64 * self.kx, (p.lat - self.lat0) as f64 * M_PER_DEG_LAT * 1e-7)
    }
    #[inline]
    pub fn to_ll(&self, p: P) -> LatLon {
        LatLon { lat: self.lat0 + (p.1 / (M_PER_DEG_LAT * 1e-7)).round() as i32, lon: self.lon0 + (p.0 / self.kx).round() as i32 }
    }
}

#[inline]
fn orient(a: P, b: P, c: P) -> f64 {
    (b.0 - a.0) * (c.1 - a.1) - (b.1 - a.1) * (c.0 - a.0)
}
#[inline]
fn dist(a: P, b: P) -> f64 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

/// Signed area (positive = counter-clockwise).
pub fn signed_area(ring: &[P]) -> f64 {
    let n = ring.len();
    let mut s = 0.0;
    for i in 0..n {
        let (a, b) = (ring[i], ring[(i + 1) % n]);
        s += a.0 * b.1 - b.0 * a.1;
    }
    s * 0.5
}

/// Area centroid of a ring; vertex mean for degenerate rings.
pub fn centroid(ring: &[P]) -> P {
    let n = ring.len();
    let a = signed_area(ring);
    if n < 3 || a.abs() < 1e-6 {
        let k = n.max(1) as f64;
        return (ring.iter().map(|p| p.0).sum::<f64>() / k, ring.iter().map(|p| p.1).sum::<f64>() / k);
    }
    let (mut cx, mut cy) = (0.0, 0.0);
    for i in 0..n {
        let (p, q) = (ring[i], ring[(i + 1) % n]);
        let w = p.0 * q.1 - q.0 * p.1;
        cx += (p.0 + q.0) * w;
        cy += (p.1 + q.1) * w;
    }
    (cx / (6.0 * a), cy / (6.0 * a))
}

/// Even-odd test over all rings (outer and holes alike).
pub fn point_in_rings(p: P, rings: &[Vec<P>]) -> bool {
    let mut inside = false;
    for ring in rings {
        let n = ring.len();
        let mut j = n - 1;
        for i in 0..n {
            let (a, b) = (ring[i], ring[j]);
            if (a.1 > p.1) != (b.1 > p.1) && p.0 < (b.0 - a.0) * (p.1 - a.1) / (b.1 - a.1) + a.0 {
                inside = !inside;
            }
            j = i;
        }
    }
    inside
}

fn dist_point_seg(p: P, a: P, b: P) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let l2 = dx * dx + dy * dy;
    let t = if l2 < 1e-12 { 0.0 } else { (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / l2).clamp(0.0, 1.0) };
    dist(p, (a.0 + t * dx, a.1 + t * dy))
}

/// Is `p` within `tol` metres of the ring's outline?
pub fn near(p: P, ring: &[P], tol: f64) -> bool {
    near_boundary(p, std::slice::from_ref(&ring.to_vec()), tol)
}

fn near_boundary(p: P, rings: &[Vec<P>], tol: f64) -> bool {
    for ring in rings {
        let n = ring.len();
        for i in 0..n {
            if dist_point_seg(p, ring[i], ring[(i + 1) % n]) < tol {
                return true;
            }
        }
    }
    false
}

/// Do `p–q` and `u–v` cross at a point interior to both (2 cm tolerance, so
/// touching at a vertex or running along an edge does not count)?
fn proper_cross(p: P, q: P, u: P, v: P) -> bool {
    const TOL: f64 = 0.02;
    let lpq = dist(p, q).max(1e-9);
    let luv = dist(u, v).max(1e-9);
    let d1 = orient(p, q, u) / lpq;
    let d2 = orient(p, q, v) / lpq;
    if !((d1 > TOL && d2 < -TOL) || (d1 < -TOL && d2 > TOL)) {
        return false;
    }
    let d3 = orient(u, v, p) / luv;
    let d4 = orient(u, v, q) / luv;
    (d3 > TOL && d4 < -TOL) || (d3 < -TOL && d4 > TOL)
}

/// Does the straight segment `p–q` (both on the boundary or inside) stay
/// inside the polygon formed by `rings`?
pub fn segment_inside(p: P, q: P, rings: &[Vec<P>]) -> bool {
    let (minx, maxx) = (p.0.min(q.0) - 0.05, p.0.max(q.0) + 0.05);
    let (miny, maxy) = (p.1.min(q.1) - 0.05, p.1.max(q.1) + 0.05);
    for ring in rings {
        let n = ring.len();
        for i in 0..n {
            let (u, v) = (ring[i], ring[(i + 1) % n]);
            if u.0.max(v.0) < minx || u.0.min(v.0) > maxx || u.1.max(v.1) < miny || u.1.min(v.1) > maxy {
                continue;
            }
            if proper_cross(p, q, u, v) {
                return false;
            }
        }
    }
    let len = dist(p, q);
    let k = ((len / 2.0).ceil() as usize).clamp(3, 24);
    for i in 0..k {
        let t = (i as f64 + 0.5) / k as f64;
        let s = (p.0 + (q.0 - p.0) * t, p.1 + (q.1 - p.1) * t);
        if !point_in_rings(s, rings) && !near_boundary(s, rings, 0.05) {
            return false;
        }
    }
    true
}

/// Join ways (as node sequences) end to end into closed rings. Ways that do
/// not close are dropped. Rings are returned open.
pub fn assemble_rings(ways: &[&[u32]]) -> Vec<Vec<u32>> {
    let mut rings = Vec::new();
    let mut used = vec![false; ways.len()];
    let mut ends: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    for (i, w) in ways.iter().enumerate() {
        if w.len() < 2 {
            used[i] = true;
            continue;
        }
        if w[0] == w[w.len() - 1] {
            used[i] = true;
            if w.len() >= 4 {
                rings.push(w[..w.len() - 1].to_vec());
            }
            continue;
        }
        ends.entry(w[0]).or_default().push(i as u32);
        ends.entry(w[w.len() - 1]).or_default().push(i as u32);
    }
    for start in 0..ways.len() {
        if used[start] {
            continue;
        }
        used[start] = true;
        let mut ring: Vec<u32> = ways[start].to_vec();
        loop {
            let head = ring[0];
            let tail = *ring.last().unwrap();
            if head == tail {
                ring.pop();
                if ring.len() >= 3 {
                    rings.push(ring);
                }
                break;
            }
            let next = ends.get(&tail).and_then(|c| c.iter().copied().find(|&j| !used[j as usize]));
            let Some(j) = next else { break };
            used[j as usize] = true;
            let w = ways[j as usize];
            if w[0] == tail {
                ring.extend_from_slice(&w[1..]);
            } else {
                ring.extend(w[..w.len() - 1].iter().rev());
            }
        }
    }
    rings
}

/// Vertices where the walkable space turns around a corner (reflex vertices
/// of the outer ring, convex vertices of holes). Shortest paths inside a
/// polygon bend only at such vertices. Returns (ring, vertex, turn angle in
/// degrees), sharpest first, for turns of at least `min_deg`.
pub fn corner_vertices(rings: &[Vec<P>], min_deg: f64) -> Vec<(u32, u32, f64)> {
    let mut out = Vec::new();
    for (ri, ring) in rings.iter().enumerate() {
        let n = ring.len();
        if n < 3 {
            continue;
        }
        let others: Vec<Vec<P>> = rings.iter().enumerate().filter(|(j, _)| *j != ri).map(|(_, r)| r.clone()).collect();
        let hole = !others.is_empty() && point_in_rings(ring[0], &others);
        let s = signed_area(ring).signum() * if hole { -1.0 } else { 1.0 };
        for i in 0..n {
            let (a, b, c) = (ring[(i + n - 1) % n], ring[i], ring[(i + 1) % n]);
            let cross = (b.0 - a.0) * (c.1 - b.1) - (b.1 - a.1) * (c.0 - b.0);
            let dot = (b.0 - a.0) * (c.0 - b.0) + (b.1 - a.1) * (c.1 - b.1);
            if s * cross < 0.0 {
                let ang = cross.abs().atan2(dot).to_degrees();
                if ang >= min_deg {
                    out.push((ri as u32, i as u32, ang));
                }
            }
        }
    }
    out.sort_by(|x, y| y.2.partial_cmp(&x.2).unwrap().then(x.0.cmp(&y.0)).then(x.1.cmp(&y.1)));
    out
}

/// Straight edges between candidate points of an area that stay inside it.
///
/// `cands`: (ring, vertex) positions. Of all mutually visible pairs only a
/// *greedy spanner* is kept: pairs are taken shortest first and a pair gets an
/// edge only if the edges chosen so far (plus, with `outline`, walking along
/// the rings between neighbouring candidates) do not already connect it within
/// `stretch` × its straight distance. So any walk across the area is at most
/// `stretch` times longer than with every visible pair linked, with far fewer
/// edges. Returns index pairs into `cands`, each once, `i < j`.
pub fn visibility_edges(rings: &[Vec<P>], cands: &[(u32, u32)], outline: bool, stretch: f64) -> Vec<(u32, u32)> {
    visibility_edges_around(rings, &[], cands, outline, stretch)
}

/// Does p–q cut through one of these buildings (cross a wall, or run inside one)?
pub fn hits_obstacle(p: P, q: P, obstacles: &[Vec<P>]) -> bool {
    obstacles.iter().any(|r| {
        let n = r.len();
        if (0..n).any(|i| proper_cross(p, q, r[i], r[(i + 1) % n])) {
            return true;
        }
        let one = std::slice::from_ref(r);
        let k = ((dist(p, q) / 2.0).ceil() as usize).clamp(3, 24);
        (0..k).any(|i| {
            let t = (i as f64 + 0.5) / k as f64;
            let s = (p.0 + (q.0 - p.0) * t, p.1 + (q.1 - p.1) * t);
            point_in_rings(s, one) && !near_boundary(s, one, 0.3)
        })
    })
}

/// [`visibility_edges`], where a pair is also not visible through a building standing in the area.
pub fn visibility_edges_around(rings: &[Vec<P>], obstacles: &[Vec<P>], cands: &[(u32, u32)], outline: bool, stretch: f64) -> Vec<(u32, u32)> {
    let c = cands.len();
    let pts: Vec<P> = cands.iter().map(|&(r, v)| rings[r as usize][v as usize]).collect();
    let mut d = vec![f64::INFINITY; c * c];
    for i in 0..c {
        d[i * c + i] = 0.0;
    }
    if outline {
        // distance along each ring between consecutive candidates
        for (ri, ring) in rings.iter().enumerate() {
            let n = ring.len();
            let mut on: Vec<(u32, usize)> = cands.iter().enumerate().filter(|(_, x)| x.0 as usize == ri).map(|(i, x)| (x.1, i)).collect();
            if on.len() < 2 {
                continue;
            }
            on.sort_unstable();
            for k in 0..on.len() {
                let (va, ia) = on[k];
                let (vb, ib) = on[(k + 1) % on.len()];
                if ia == ib {
                    continue;
                }
                let mut len = 0.0;
                let mut v = va as usize;
                while v != vb as usize {
                    let w = (v + 1) % n;
                    len += dist(ring[v], ring[w]);
                    v = w;
                }
                if len < d[ia * c + ib] {
                    d[ia * c + ib] = len;
                    d[ib * c + ia] = len;
                }
            }
        }
        for k in 0..c {
            for i in 0..c {
                let dik = d[i * c + k];
                if !dik.is_finite() {
                    continue;
                }
                for j in 0..c {
                    let x = dik + d[k * c + j];
                    if x < d[i * c + j] {
                        d[i * c + j] = x;
                    }
                }
            }
        }
    }
    let mut pairs: Vec<(f64, u32, u32)> = Vec::with_capacity(c * (c - 1) / 2);
    for i in 0..c {
        for j in i + 1..c {
            let l = dist(pts[i], pts[j]);
            if l > 0.3 {
                pairs.push((l, i as u32, j as u32));
            }
        }
    }
    pairs.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap().then(x.1.cmp(&y.1)).then(x.2.cmp(&y.2)));
    let mut out: Vec<(u32, u32)> = Vec::new();
    for (l, i, j) in pairs {
        let (i, j) = (i as usize, j as usize);
        if d[i * c + j] <= stretch * l || !segment_inside(pts[i], pts[j], rings) || hits_obstacle(pts[i], pts[j], obstacles) {
            continue;
        }
        out.push((i as u32, j as u32));
        // all-pairs distances with the new edge
        let di: Vec<f64> = (0..c).map(|x| d[x * c + i]).collect();
        let dj: Vec<f64> = (0..c).map(|x| d[x * c + j]).collect();
        for x in 0..c {
            let via_i = di[x] + l;
            let via_j = dj[x] + l;
            if !via_i.is_finite() && !via_j.is_finite() {
                continue;
            }
            for y in 0..c {
                let n = (via_i + dj[y]).min(via_j + di[y]);
                if n < d[x * c + y] {
                    d[x * c + y] = n;
                }
            }
        }
    }
    out.sort_unstable();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x0: f64, y0: f64, s: f64) -> Vec<P> {
        vec![(x0, y0), (x0 + s, y0), (x0 + s, y0 + s), (x0, y0 + s)]
    }

    #[test]
    fn area_and_centroid() {
        let sq = square(0.0, 0.0, 10.0);
        assert!((signed_area(&sq) - 100.0).abs() < 1e-9);
        let c = centroid(&sq);
        assert!((c.0 - 5.0).abs() < 1e-9 && (c.1 - 5.0).abs() < 1e-9);
    }

    #[test]
    fn inside_square_with_hole() {
        let rings = vec![square(0.0, 0.0, 20.0), square(8.0, 8.0, 4.0)];
        assert!(point_in_rings((2.0, 2.0), &rings));
        assert!(!point_in_rings((10.0, 10.0), &rings));
        assert!(!point_in_rings((30.0, 2.0), &rings));
        // diagonal passes through the hole
        assert!(!segment_inside((0.0, 0.0), (20.0, 20.0), &rings));
        // the other corner pair too
        assert!(!segment_inside((20.0, 0.0), (0.0, 20.0), &rings));
        // along an outer edge, and corner to hole corner
        assert!(segment_inside((0.0, 0.0), (20.0, 0.0), &rings));
        assert!(segment_inside((0.0, 0.0), (8.0, 8.0), &rings));
        // side to side below the hole
        assert!(segment_inside((0.0, 0.0), (20.0, 5.0), &rings));
    }

    #[test]
    fn l_shape() {
        // L: the notch is the top-right quadrant
        let l = vec![(0.0, 0.0), (20.0, 0.0), (20.0, 10.0), (10.0, 10.0), (10.0, 20.0), (0.0, 20.0)];
        let rings = vec![l];
        assert!(!segment_inside((20.0, 10.0), (10.0, 20.0), &rings));
        assert!(segment_inside((20.0, 0.0), (0.0, 20.0), &rings));
        assert!(segment_inside((0.0, 0.0), (10.0, 10.0), &rings));
        let corners = corner_vertices(&rings, 20.0);
        assert_eq!(corners.len(), 1);
        assert_eq!((corners[0].0, corners[0].1), (0, 3));
        // all six vertices as candidates
        let cands: Vec<(u32, u32)> = (0..6).map(|i| (0, i)).collect();
        // without the outline every visible pair that is not replaceable is kept
        let e = visibility_edges(&rings, &cands, false, 1.0);
        assert!(!e.contains(&(2, 4)));
        assert!(e.contains(&(0, 3)) && e.contains(&(0, 2)) && e.contains(&(0, 1)));
        // 1 → 5 runs exactly through the inner corner 3, so 1–3 and 3–5 replace it
        assert!(e.contains(&(1, 3)) && e.contains(&(3, 5)) && !e.contains(&(1, 5)));
        // with the outline, ring neighbours need no extra edge
        let o = visibility_edges(&rings, &cands, true, 1.04);
        assert!(!o.contains(&(0, 1)) && !o.contains(&(2, 4)));
        assert!(o.contains(&(0, 3)) && o.contains(&(1, 3)) && !o.contains(&(1, 5)));
        // 2 → 4 has to go round the inner corner 3: both legs are outline edges
        assert!(!o.contains(&(2, 3)) && !o.contains(&(3, 4)));
    }

    #[test]
    fn spanner_bounds_detour() {
        // 12 points on a circle (convex, everything visible): the kept edges
        // must connect every pair within the stretch factor.
        let n = 12;
        let ring: Vec<P> = (0..n).map(|i| { let a = i as f64 / n as f64 * std::f64::consts::TAU; (30.0 * a.cos(), 30.0 * a.sin()) }).collect();
        let rings = vec![ring.clone()];
        let cands: Vec<(u32, u32)> = (0..n as u32).map(|i| (0, i)).collect();
        let e = visibility_edges(&rings, &cands, true, 1.04);
        assert!(e.len() < n * (n - 1) / 2 - n, "{} edges", e.len());
        let mut d = vec![vec![f64::INFINITY; n]; n];
        for i in 0..n {
            d[i][i] = 0.0;
            let j = (i + 1) % n;
            let l = dist(ring[i], ring[j]);
            d[i][j] = l;
            d[j][i] = l;
        }
        for &(i, j) in &e {
            let l = dist(ring[i as usize], ring[j as usize]);
            d[i as usize][j as usize] = l;
            d[j as usize][i as usize] = l;
        }
        for k in 0..n {
            for i in 0..n {
                for j in 0..n {
                    d[i][j] = d[i][j].min(d[i][k] + d[k][j]);
                }
            }
        }
        for i in 0..n {
            for j in 0..n {
                assert!(d[i][j] <= 1.04 * dist(ring[i], ring[j]) + 1e-9, "{i} {j}");
            }
        }
    }

    #[test]
    fn hole_corners_are_corner_vertices() {
        let rings = vec![square(0.0, 0.0, 20.0), square(8.0, 8.0, 4.0)];
        let c = corner_vertices(&rings, 20.0);
        assert_eq!(c.len(), 4);
        assert!(c.iter().all(|x| x.0 == 1));
    }

    #[test]
    fn rings_from_pieces() {
        let a = [1u32, 2, 3];
        let b = [5u32, 4, 3];
        let c = [5u32, 6, 1];
        let d = [10u32, 11, 12, 10];
        let open = [20u32, 21];
        let rings = assemble_rings(&[&a, &b, &c, &d, &open]);
        assert_eq!(rings.len(), 2);
        assert!(rings.contains(&vec![10, 11, 12]));
        assert!(rings.contains(&vec![1, 2, 3, 4, 5, 6]));
    }

    #[test]
    fn frame_round_trip() {
        let o = LatLon::from_deg(46.948, 7.439);
        let f = Frame::new(o);
        let p = LatLon::from_deg(46.9491, 7.4402);
        let xy = f.to_xy(p);
        assert!((((xy.0 * xy.0 + xy.1 * xy.1).sqrt()) as f32 - o.dist_m(&p)).abs() < 0.2);
        assert!(f.to_ll(xy).dist_m(&p) < 0.02);
    }
}
