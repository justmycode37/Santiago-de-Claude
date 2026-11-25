//! A walk along a carriageway drawn at the road's edge, not down its middle.
//!
//! Where OpenStreetMap has no sidewalk drawn beside a road, the walk follows the road's own line: its centre. The
//! walk's line is moved to the side a walker is on, by half the carriageway's width (`width`, else `lanes`, else by
//! the road's size), a metre more where a sidewalk is tagged on that side, half a metre less where the road says it
//! has none. Only the drawing changes: route choice, metres and times are the path's. No vertex of the path is added
//! or removed, so the steps, covered stretches, levels and guessed ends keep their indices.
//!
//! Which side: one side for each stretch of road between mapped crossings (`highway=crossing` nodes; the line
//! crosses back over the road at one, on the road's line, when that saves a crossing elsewhere and the segments
//! either side of it are no longer than [`SWITCH_SEG_M`]), chosen to cost the least of:
//!
//! - **the sidewalk**: on a road tagged with a sidewalk on one side only, the other side counts each metre;
//! - **getting there and away**: a stretch that starts (ends) where the walk comes onto the road from one side, more
//!   than [`SIDE_M`] from its line (a stop, a door, a footway), counts [`CROSS_M`] on the other side; so does
//!   crossing back at a crossing;
//! - **the length of the line drawn**: the inner side of the bends is shorter (a tie-break, in metres).
//!
//! It stays on the road's line: on a roundabout, a one-way main road (perhaps one half of a divided road) or a
//! living street, unless a sidewalk is tagged on one side only (which side is the outer one, or where to walk in
//! shared space, is not known otherwise); in tunnels and under roofs; on a stretch shorter than [`MIN_RUN_M`]; on
//! roads that are not minor, tertiary or bigger (service roads, tracks). The point where a stretch on the line meets
//! one drawn at the edge stays on the line too. The line is never moved further than the stop, door or place it
//! joins at the walk's ends (on that side); a corner is mitred no further than twice the distance; a short segment
//! that moving would turn round is drawn as a point. Vertices that must stay where they are (the walk's ends, a door
//! the network is joined at) are passed as pinned; `kante_link::ends::draw` puts back on the line any point that
//! would put the line through a building.
//!
//! `KANTE_WALK_RULES_OFF=kerb` switches it off (every walk's line on the graph's edges, as `compare metrics`
//! needs to match it).

use crate::net::rules;
use kante_core::*;

/// What a crossing counts, in metres of the line: getting onto the road from the side not drawn, or crossing back.
pub const CROSS_M: f32 = 30.0;
/// A stretch of road shorter than this stays on its line.
pub const MIN_RUN_M: f32 = 8.0;
/// A point beside the road further than this from its line is on that side of it.
pub const SIDE_M: f64 = 1.5;
/// The line crosses back over the road at a crossing only where the segments either side of it are no longer.
pub const SWITCH_SEG_M: f64 = 20.0;

/// One stretch of a walk along one carriageway edge (see the module docs).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KerbPiece {
    /// Its first and last vertex in the path's geometry.
    pub v0: u32,
    pub v1: u32,
    /// How far from the road's line a walker is on its left and on its right (in the direction walked), metres.
    pub left_m: f32,
    pub right_m: f32,
    /// The side with the road's only sidewalk: 1 left, -1 right, 0 both, none or not known.
    pub pref: i8,
    /// Stays on the road's line.
    pub fixed: bool,
    /// Ends at a mapped crossing.
    pub cross_end: bool,
    pub len_m: f32,
}

/// The carriageway's width by road size when the road does not say.
fn default_width(class: u8) -> Option<f32> {
    match class {
        RC_MINOR => Some(5.0),
        RC_TERTIARY => Some(6.5),
        RC_SECONDARY => Some(7.0),
        RC_PRIMARY => Some(7.5),
        RC_TRUNK => Some(8.0),
        _ => None,
    }
}

/// The [`KerbPiece`] of a walk over edge `e` (from `b` to `a` when `rev`), if it is a carriageway.
pub(crate) fn piece(g: &WalkGraph, e: u32, rev: bool, v0: u32, v1: u32, len_m: f32, cross_end: bool) -> Option<KerbPiece> {
    let ed = &g.edges[e as usize];
    if !matches!(ed.kind, EdgeKind::Road | EdgeKind::RoadBusy) || ed.flags & (EF_INDOOR | EF_AREA) != 0 {
        return None;
    }
    let k = g.attrs.kerb(e);
    let by_size = default_width(g.attrs.road(e))?;
    let tagged_w = ((k & KB_WIDTH) >> KB_WIDTH_SHIFT) as f32;
    let width = if tagged_w > 0.0 { tagged_w } else { by_size };
    let half = width / 2.0;
    let tagged = k & KB_TAGGED != 0;
    let (mut l, mut r) = (k & KB_LEFT != 0, k & KB_RIGHT != 0);
    if rev {
        std::mem::swap(&mut l, &mut r);
    }
    // on a sidewalk: about its middle; at the edge of a road that has none: just inside it; not known: at the edge
    let at = |has: bool| (if has { half + 1.0 } else if tagged { half - 0.5 } else { half }).clamp(1.5, 8.0);
    Some(KerbPiece {
        v0,
        v1,
        left_m: at(l),
        right_m: at(r),
        pref: match (l, r) {
            (true, false) => 1,
            (false, true) => -1,
            _ => 0,
        },
        // a roundabout's or a divided road's outer side, or where to walk in a living street, is told only by a
        // sidewalk on one side
        fixed: (k & KB_NO_GUESS != 0 && l == r) || ed.flags & (EF_TUNNEL | EF_COVERED) != 0,
        cross_end,
        len_m,
    })
}

type Xy = (f64, f64);

fn sub(a: Xy, b: Xy) -> Xy {
    (a.0 - b.0, a.1 - b.1)
}
fn len(a: Xy) -> f64 {
    a.0.hypot(a.1)
}
fn dot(a: Xy, b: Xy) -> f64 {
    a.0 * b.0 + a.1 * b.1
}
fn cross(a: Xy, b: Xy) -> f64 {
    a.0 * b.1 - a.1 * b.0
}
/// The unit normal to the left of direction `d`.
fn left_normal(d: Xy) -> Xy {
    let l = len(d);
    (-d.1 / l, d.0 / l)
}

/// Moves the vertices of the drawn walk `geometry` on its carriageway stretches `pieces` to the side of the road a
/// walker is on (see the module docs). The path's vertex `v` is `geometry[v + shift]` (`shift` points are drawn
/// before the path: a door, the place the walk starts); `path_end` is the path's last vertex (drawn index: the
/// points after it lead to where the walk ends). `pinned` (drawn indices), the first and the last vertex stay where
/// they are. Returns whether anything moved.
pub fn apply(geometry: &mut [LatLon], pieces: &[KerbPiece], shift: u32, path_end: u32, pinned: &[u32]) -> bool {
    let n = geometry.len();
    if n < 3 || pieces.is_empty() || rules::on() & rules::KERB == 0 {
        return false;
    }
    let o = geometry[0];
    let kx = 1e-7 * kante_core::geo::M_PER_DEG_LAT * (o.lat as f64 * 1e-7).to_radians().cos();
    let ky = 1e-7 * kante_core::geo::M_PER_DEG_LAT;
    let xy: Vec<Xy> = geometry.iter().map(|p| ((p.lon - o.lon) as f64 * kx, (p.lat - o.lat) as f64 * ky)).collect();
    // the ends of a stretch that stays on the road's line stay with it
    let fixed_ends: Vec<usize> = pieces.iter().filter(|p| p.fixed).flat_map(|p| [(p.v0 + shift) as usize, (p.v1 + shift) as usize]).collect();
    let fixed_at = |v: usize| v == 0 || v + 1 == n || pinned.contains(&(v as u32)) || fixed_ends.contains(&v);

    // runs of consecutive pieces drawn at the edge
    let mut runs: Vec<&[KerbPiece]> = Vec::new();
    let mut i = 0;
    while i < pieces.len() {
        if pieces[i].fixed {
            i += 1;
            continue;
        }
        let mut j = i;
        while j + 1 < pieces.len() && !pieces[j + 1].fixed && pieces[j + 1].v0 == pieces[j].v1 {
            j += 1;
        }
        runs.push(&pieces[i..=j]);
        i = j + 1;
    }

    let mut moved: Vec<(usize, Xy)> = Vec::new();
    for run in runs {
        if run.iter().map(|p| p.len_m).sum::<f32>() < MIN_RUN_M {
            continue;
        }
        let first = (run[0].v0 + shift) as usize;
        let last = (run[run.len() - 1].v1 + shift) as usize;
        if last >= n || first >= last {
            continue;
        }
        // the direction of segment `k → k+1`, else of the nearest segment of the run with a length: after it, else
        // before it (`dir`), or before it, else after it (`dir_back`: the way into a vertex)
        let seg = |s: usize| sub(xy[s + 1], xy[s]);
        let dir = |k: usize| -> Option<Xy> { (k..last).chain((first..k).rev()).map(seg).find(|d| len(*d) > 0.01) };
        let dir_back = |k: usize| -> Option<Xy> { (first..=k).rev().chain(k + 1..last).map(seg).find(|d| len(*d) > 0.01) };
        // how far a point next to the run is from its line at vertex `at`: left positive
        let beside = |p: Xy, at: usize, seg: usize| -> f64 {
            match dir(seg) {
                Some(d) => cross(d, sub(p, xy[at])) / len(d),
                None => 0.0,
            }
        };
        let side = |off: f64| -> i8 {
            if off > SIDE_M {
                1
            } else if off < -SIDE_M {
                -1
            } else {
                0
            }
        };
        let entry_off = if first > 0 && !fixed_at(first) { beside(xy[first - 1], first, first) } else { 0.0 };
        let exit_off = if last + 1 < n && !fixed_at(last) { beside(xy[last + 1], last, last.saturating_sub(1).max(first)) } else { 0.0 };

        // stretches between crossings: (first piece, last piece). The line crosses back over the road on the road's
        // line at the crossing, so only where the segments either side of it are short: else it would cross over
        // their whole length.
        let crossable = |v: usize| v > first && v < last && len(sub(xy[v], xy[v - 1])) <= SWITCH_SEG_M && len(sub(xy[v + 1], xy[v])) <= SWITCH_SEG_M;
        let mut subs: Vec<(usize, usize)> = Vec::new();
        let mut s0 = 0;
        for (k, p) in run.iter().enumerate() {
            if (p.cross_end && crossable((p.v1 + shift) as usize)) || k + 1 == run.len() {
                subs.push((s0, k));
                s0 = k + 1;
            }
        }
        // what each side costs on each stretch: [left, right]
        let cost: Vec<[f64; 2]> = subs
            .iter()
            .enumerate()
            .map(|(si, &(a, b))| {
                let mut c = [0f64; 2];
                for p in &run[a..=b] {
                    match p.pref {
                        1 => c[1] += p.len_m as f64,
                        -1 => c[0] += p.len_m as f64,
                        _ => {}
                    }
                    // the bends: a line moved by `o` to the inside of a turn of `t` radians is `o·t` shorter
                    let (p0, p1) = ((p.v0 + shift) as usize, (p.v1 + shift) as usize);
                    for k in p0 + 1..=p1 {
                        if k >= last || (k == p1 && p.cross_end && crossable(k)) {
                            continue;
                        }
                        let (din, dout) = (sub(xy[k], xy[k - 1]), sub(xy[k + 1], xy[k]));
                        if len(din) < 0.01 || len(dout) < 0.01 {
                            continue;
                        }
                        let t = cross(din, dout).atan2(dot(din, dout));
                        c[0] -= p.left_m as f64 * t;
                        c[1] += p.right_m as f64 * t;
                    }
                }
                let ends = |s: i8, c: &mut [f64; 2]| match s {
                    1 => c[1] += CROSS_M as f64,
                    -1 => c[0] += CROSS_M as f64,
                    _ => {}
                };
                if si == 0 {
                    ends(side(entry_off), &mut c);
                }
                if si + 1 == subs.len() {
                    ends(side(exit_off), &mut c);
                }
                c
            })
            .collect();
        // the cheapest sides, crossing back at a crossing for CROSS_M
        let m = subs.len();
        let mut best = vec![[0f64; 2]; m];
        let mut from = vec![[0usize; 2]; m];
        best[0] = cost[0];
        for si in 1..m {
            for s in 0..2 {
                let (stay, swap) = (best[si - 1][s], best[si - 1][1 - s] + CROSS_M as f64);
                (best[si][s], from[si][s]) = if stay <= swap { (stay, s) } else { (swap, 1 - s) };
                best[si][s] += cost[si][s];
            }
        }
        let mut chosen = vec![0usize; m];
        chosen[m - 1] = if best[m - 1][0] <= best[m - 1][1] { 0 } else { 1 };
        for si in (1..m).rev() {
            chosen[si - 1] = from[si][chosen[si]];
        }
        // the signed distance (left positive) each piece is drawn at
        let mut sign = vec![0f64; run.len()];
        for (si, &(a, b)) in subs.iter().enumerate() {
            for k in a..=b {
                sign[k] = if chosen[si] == 0 { run[k].left_m as f64 } else { -(run[k].right_m as f64) };
            }
        }

        // move the vertices: along both segments' normals, mitred at a bend
        let piece_of_seg = |s: usize| run.iter().position(|p| s >= (p.v0 + shift) as usize && s < (p.v1 + shift) as usize);
        let mut run_moved: Vec<(usize, Xy)> = Vec::new();
        // where the line crosses back over the road
        let mut on_line: Vec<usize> = Vec::new();
        for k in first..=last {
            if fixed_at(k) {
                continue;
            }
            let oin = if k > first { piece_of_seg(k - 1).map(|i| sign[i]) } else { None };
            let oout = if k < last { piece_of_seg(k).map(|i| sign[i]) } else { None };
            let mut o = match (oin, oout) {
                // crossing back over the road at a crossing: the crossing itself is on the road's line
                (Some(a), Some(b)) if a.signum() != b.signum() => {
                    on_line.push(k);
                    continue;
                }
                (Some(a), Some(b)) => (a + b) / 2.0,
                (Some(a), None) | (None, Some(a)) => a,
                (None, None) => continue,
            };
            // never past the stop, door or place the walk comes from or goes to, when it is on this side (one on the
            // line itself is on neither)
            for (end, off, walk_end) in [(first, entry_off, first <= shift as usize), (last, exit_off, last >= path_end as usize)] {
                if k == end && walk_end && off.abs() > 0.05 && off.signum() == o.signum() && off.abs() < o.abs() {
                    o = off;
                }
            }
            let din = if k > first { dir_back(k - 1) } else { None };
            let dout = if k < last { dir(k) } else { None };
            let d = match (din, dout) {
                (Some(a), Some(b)) => {
                    let (na, nb) = (left_normal(a), left_normal(b));
                    let mid = (na.0 + nb.0, na.1 + nb.1);
                    let cos = if len(mid) > 1e-6 { dot(mid, na) / len(mid) } else { 0.0 };
                    if cos < 0.25 {
                        // nearly turning back: beside the way on
                        (nb.0 * o, nb.1 * o)
                    } else {
                        // a mitre, no longer than twice the distance, nor than the shorter segment beside it lets it be
                        let reach = (o.abs() / cos).min(2.0 * o.abs()).min(o.abs().max(len(a).min(len(b))));
                        let u = (mid.0 / len(mid), mid.1 / len(mid));
                        (u.0 * reach * o.signum(), u.1 * reach * o.signum())
                    }
                }
                (Some(a), None) | (None, Some(a)) => {
                    let na = left_normal(a);
                    (na.0 * o, na.1 * o)
                }
                (None, None) => continue,
            };
            run_moved.push((k, (xy[k].0 + d.0, xy[k].1 + d.1)));
        }
        // a short segment that moving turned round (the inside of a tight bend) is drawn as a point
        let mut at: Vec<Xy> = xy[first..=last].to_vec();
        for &(k, p) in &run_moved {
            at[k - first] = p;
        }
        // (again until none is: drawing one as a point can turn the one before round)
        for _ in 0..=last - first {
            let mut again = false;
            for k in first..last {
                let (a, b) = (k - first, k + 1 - first);
                let keep = |v: usize| fixed_at(v) || on_line.contains(&v);
                if dot(sub(at[b], at[a]), sub(xy[k + 1], xy[k])) < -1e-9 && !keep(k) && !keep(k + 1) {
                    let mid = ((at[a].0 + at[b].0) / 2.0, (at[a].1 + at[b].1) / 2.0);
                    (at[a], at[b]) = (mid, mid);
                    again = true;
                }
            }
            if !again {
                break;
            }
        }
        moved.extend((first..=last).filter(|&k| at[k - first] != xy[k]).map(|k| (k, at[k - first])));
    }
    for &(k, p) in &moved {
        geometry[k] = LatLon { lat: o.lat + (p.1 / ky).round() as i32, lon: o.lon + (p.0 / kx).round() as i32 };
    }
    !moved.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAT0: f64 = 47.2;
    const LON0: f64 = 8.72;
    fn pt(x: f64, y: f64) -> LatLon {
        LatLon::from_deg(LAT0 + y / geo::M_PER_DEG_LAT, LON0 + x / (geo::M_PER_DEG_LAT * LAT0.to_radians().cos()))
    }
    fn xy(p: LatLon) -> (f64, f64) {
        ((p.lon_deg() - LON0) * geo::M_PER_DEG_LAT * LAT0.to_radians().cos(), (p.lat_deg() - LAT0) * geo::M_PER_DEG_LAT)
    }
    fn road(v0: u32, v1: u32, len_m: f32) -> KerbPiece {
        KerbPiece { v0, v1, left_m: 2.5, right_m: 2.5, pref: 0, fixed: false, cross_end: false, len_m }
    }
    /// [`apply`] with one point drawn after the path.
    fn apply_t(g: &mut [LatLon], pieces: &[KerbPiece], shift: u32, pinned: &[u32]) -> bool {
        let path_end = g.len() as u32 - 2;
        apply(g, pieces, shift, path_end, pinned)
    }
    fn near(a: (f64, f64), b: (f64, f64)) -> bool {
        (a.0 - b.0).hypot(a.1 - b.1) < 0.05
    }

    #[test]
    fn a_road_is_drawn_on_the_side_the_walk_comes_from_and_its_ends_stay() {
        // from a stop 4 m south of the road, 100 m east along it, then to a door 4 m south
        let mut g = vec![pt(0.0, -4.0), pt(0.0, 0.0), pt(50.0, 0.0), pt(100.0, 0.0), pt(100.0, -4.0)];
        assert!(apply_t(&mut g, &[road(0, 2, 100.0)], 1, &[]));
        assert!(near(xy(g[0]), (0.0, -4.0)) && near(xy(g[4]), (100.0, -4.0)), "the ends stay");
        for (k, x) in [(1, 0.0), (2, 50.0), (3, 100.0)] {
            assert!(near(xy(g[k]), (x, -2.5)), "{k}: {:?}", xy(g[k]));
        }
    }

    #[test]
    fn the_only_sidewalk_wins_over_getting_there_and_a_crossing_is_where_the_line_crosses() {
        // a 200 m road with its sidewalk on the north (left, walking east) only, entered from the south
        let mut g = vec![pt(0.0, -4.0), pt(0.0, 0.0), pt(100.0, 0.0), pt(200.0, 0.0), pt(200.0, 4.0)];
        let mut p = road(0, 2, 200.0);
        p.pref = 1;
        p.left_m = 3.5;
        assert!(apply_t(&mut g, &[p], 1, &[]));
        assert!(near(xy(g[2]), (100.0, 3.5)), "{:?}", xy(g[2]));
        // two stretches split at a crossing (the vertex at 100 m): south first, then north: crossed there
        let mut g = vec![pt(0.0, -4.0), pt(0.0, 0.0), pt(90.0, 0.0), pt(100.0, 0.0), pt(110.0, 0.0), pt(200.0, 0.0), pt(200.0, 4.0)];
        let (mut a, mut b) = (road(0, 2, 100.0), road(2, 4, 100.0));
        a.cross_end = true;
        a.pref = -1;
        b.pref = 1;
        assert!(apply_t(&mut g, &[a, b], 1, &[]));
        assert!(near(xy(g[2]), (90.0, -2.5)) && near(xy(g[3]), (100.0, 0.0)) && near(xy(g[4]), (110.0, 2.5)), "{:?}", g.iter().map(|p| xy(*p)).collect::<Vec<_>>());
        // the same with no vertex near the crossing: crossing there would cross over 100 m; one side throughout
        let mut g = vec![pt(0.0, -4.0), pt(0.0, 0.0), pt(100.0, 0.0), pt(200.0, 0.0), pt(200.0, 4.0)];
        let (a, b) = (KerbPiece { v1: 1, ..a }, KerbPiece { v0: 1, v1: 2, ..b });
        assert!(apply_t(&mut g, &[a, b], 1, &[]));
        let ys: Vec<f64> = g[1..4].iter().map(|p| xy(*p).1).collect();
        assert!(ys.iter().all(|y| y.abs() > 2.0) && ys.iter().all(|y| y.signum() == ys[0].signum()), "{ys:?}");
    }

    #[test]
    fn a_walk_on_the_roads_line_at_both_ends_moves_to_its_only_sidewalk_on_either_side() {
        // the ends drawn twice (ends::draw): once on the line, once moved
        for pref in [1i8, -1] {
            let mut g = vec![pt(0.0, 0.0), pt(0.0, 0.0), pt(100.0, 0.0), pt(100.0, 0.0)];
            let p = KerbPiece { pref, ..road(0, 1, 100.0) };
            assert!(apply_t(&mut g, &[p], 1, &[]));
            let want = 2.5 * pref as f64;
            assert!(near(xy(g[1]), (0.0, want)) && near(xy(g[2]), (100.0, want)), "{pref}: {:?} {:?}", xy(g[1]), xy(g[2]));
        }
    }

    #[test]
    fn a_sharp_bend_is_mitred_no_further_than_twice_the_distance_and_a_point_twice_on_it_moves_once() {
        // east 50 m, then turning 145° to the left for 50 m: the inside corner, no further than 5 m
        let back = (50.0 - 50.0 * 35f64.to_radians().cos(), 50.0 * 35f64.to_radians().sin());
        let mut g = vec![pt(0.0, 0.0), pt(0.0, 0.0), pt(50.0, 0.0), pt(back.0, back.1), pt(back.0, back.1)];
        assert!(apply_t(&mut g, &[road(0, 2, 100.0)], 1, &[]));
        let c = xy(g[2]);
        assert!(((c.0 - 50.0).hypot(c.1) - 5.0).abs() < 0.05, "{c:?}");
        // a bend whose corner is two points at one place (a zero-length edge): both mitred alike
        let mut g = vec![pt(0.0, 0.0), pt(0.0, 0.0), pt(50.0, 0.0), pt(50.0, 0.0), pt(50.0, 50.0), pt(50.0, 50.0)];
        assert!(apply_t(&mut g, &[road(0, 3, 100.0)], 1, &[]));
        assert!(near(xy(g[2]), xy(g[3])) && near(xy(g[2]), (47.5, 2.5)), "{:?} {:?}", xy(g[2]), xy(g[3]));
    }

    #[test]
    fn where_a_stretch_on_the_line_begins_stays_on_the_line() {
        // a road, then a tunnel straight on: the tunnel's mouth stays where it is
        let mut g = vec![pt(0.0, -4.0), pt(0.0, 0.0), pt(100.0, 0.0), pt(200.0, 0.0), pt(200.0, -4.0)];
        let t = KerbPiece { fixed: true, ..road(1, 2, 100.0) };
        assert!(apply_t(&mut g, &[road(0, 1, 100.0), t], 1, &[]));
        assert!(near(xy(g[1]), (0.0, -2.5)) && near(xy(g[2]), (100.0, 0.0)) && near(xy(g[3]), (200.0, 0.0)), "{:?}", g.iter().map(|p| xy(*p)).collect::<Vec<_>>());
    }

    #[test]
    fn the_inner_side_of_a_bend_without_anything_else_to_go_by() {
        // east 50 m, then north 50 m: a left turn, nothing beside the ends
        let mut g = vec![pt(0.0, 0.0), pt(0.0, 0.0), pt(50.0, 0.0), pt(50.0, 50.0), pt(50.0, 50.0)];
        assert!(apply_t(&mut g, &[road(0, 2, 100.0)], 1, &[]));
        // the corner moves inwards (north-west) along the mitre
        let c = xy(g[2]);
        assert!(near(c, (47.5, 2.5)), "{c:?}");
    }

    #[test]
    fn never_past_the_stop_and_short_or_fixed_stretches_stay() {
        // the stop is 1.8 m from the road's line, on its south: the end goes no further than the stop
        let mut g = vec![pt(0.0, -1.8), pt(0.0, 0.0), pt(100.0, 0.0), pt(100.0, -5.0)];
        let mut p = road(0, 1, 100.0);
        p.right_m = 3.5;
        assert!(apply_t(&mut g, &[p], 1, &[]));
        assert!(near(xy(g[1]), (0.0, -1.8)) && near(xy(g[2]), (100.0, -3.5)), "{:?} {:?}", xy(g[1]), xy(g[2]));
        let mut g = vec![pt(0.0, -4.0), pt(0.0, 0.0), pt(6.0, 0.0), pt(6.0, -4.0)];
        assert!(!apply_t(&mut g, &[road(0, 1, 6.0)], 1, &[]), "shorter than MIN_RUN_M");
        let mut g = vec![pt(0.0, -4.0), pt(0.0, 0.0), pt(60.0, 0.0), pt(60.0, -4.0)];
        let mut f = road(0, 1, 60.0);
        f.fixed = true;
        assert!(!apply_t(&mut g, &[f], 1, &[]), "a roundabout");
        assert!(!apply_t(&mut g, &[road(0, 1, 60.0)], 1, &[1, 2]), "pinned");
    }

    #[test]
    fn a_segment_turned_round_inside_a_tight_bend_is_a_point() {
        // a 2 m jog between two long legs, drawn 2.5 m to its inside (the shorter side)
        let mut g = vec![pt(0.0, 0.0), pt(0.0, 0.0), pt(40.0, 0.0), pt(40.0, 2.0), pt(0.0, 2.0), pt(0.0, 2.0)];
        assert!(apply_t(&mut g, &[road(0, 3, 82.0)], 1, &[]));
        let (a, b) = (xy(g[2]), xy(g[3]));
        assert!(a.0 < 40.0 && near(a, b), "drawn as a point inside the bend: {a:?} {b:?}");
        // two short segments in a row: drawing one as a point must not turn the one before round
        let pts = [(0.0, 0.0), (0.0, 0.0), (20.0, 0.0), (20.0, 1.0), (19.0, 1.0), (19.0, -19.0), (19.0, -19.0)];
        let mut g: Vec<LatLon> = pts.iter().map(|&(x, y)| pt(x, y)).collect();
        apply_t(&mut g, &[road(0, 4, 42.0)], 1, &[]);
        for k in 1..5 {
            let (a, b) = (xy(g[k]), xy(g[k + 1]));
            let (o0, o1) = (pts[k], pts[k + 1]);
            assert!((b.0 - a.0) * (o1.0 - o0.0) + (b.1 - a.1) * (o1.1 - o0.1) >= -1e-6, "segment {k} turned round: {a:?} {b:?}");
        }
    }
}
