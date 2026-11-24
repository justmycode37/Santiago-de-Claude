//! Buildings and their doors: built once ([`build`] → [`Doors`]) and looked up
//! at query time ([`DoorIndex`]); how a walk uses them is in [`crate::ends`].
//!
//! - **Buildings.** Every building of OpenStreetMap, with its courtyards (a
//!   point in a courtyard is not in the building), whether it has a door or not:
//!   a straight line into any of them is known to cross a wall.
//! - **Doors.** A building's mapped entrances. A building with none gets a
//!   door at each address of the official building address register that
//!   belongs to it: the address point is in it, or its outline is the nearest
//!   within 8 m. The point is put on the nearest stretch of outline (within
//!   12 m) that faces the open — 1 m out from that wall is neither this
//!   building nor another one — and has a way out that does not run through
//!   a building (of the nearest four such stretches; else on the nearest).
//!   Two addresses within 2 m are one door ("Bahnhofstrasse 12, 12a").
//! - **Ways out.** A door is joined to the network by straight lines of up to
//!   80 m to walkable edges (no stairs, escalators, lifts, underpasses), never
//!   across a railway track on the ground (one in a tunnel or on a bridge does
//!   not count). Each line is tested by [`through_building`]: one that runs
//!   through a building (a back door joined through its own house to the street
//!   in front) is kept but marked, and counts four times its length plus 200 m
//!   (as an emergency exit); a line onto a main road walked on the carriageway
//!   counts four times ([`line_weight_m`]). The three cheapest, each onto
//!   another way, are kept, so a walker who may not use the first (a step-free
//!   one on a `wheelchair=no` path) has others.

use crate::register::Address;
use kante_core::geo::LatLon;
use kante_core::walk::*;
use kante_osm::buildings::BuildingsRaw;
use kante_walk::{SnapOptions, WalkRouter};
use rayon::prelude::*;
use rustc_hash::FxHashMap;

const CELL: f32 = 50.0;
const ATTACH_MAX_M: f32 = 80.0;
const MAX_ATTACH: usize = 3;
/// How much more a metre through a building, or onto a main road's carriageway, counts in route choice.
pub const DETOUR_FACTOR: f32 = 4.0;
/// What a line through a building costs on top, in metres of route choice: as much as an emergency exit, so it is
/// taken only when no door has a real way out.
pub const WALL_M: f32 = 200.0;

/// What a straight line `dist_m` long onto the network counts in route choice: four times onto a main road walked
/// on the carriageway, four times plus [`WALL_M`] through a building.
pub fn line_weight_m(dist_m: f32, busy_road: bool, wall: bool) -> f32 {
    let f = if busy_road { DETOUR_FACTOR } else { 1.0 } * if wall { DETOUR_FACTOR } else { 1.0 };
    dist_m * f + if wall { WALL_M } else { 0.0 }
}

#[inline]
fn key(cx: i64, cy: i64) -> u64 {
    (((cx + (1 << 30)) as u64) << 32) | (cy + (1 << 30)) as u64
}

/// Items with a planar box, by 50 m cell of the national frame.
#[derive(Default)]
struct BoxGrid {
    map: FxHashMap<u64, Vec<u32>>,
}

impl BoxGrid {
    fn insert(&mut self, i: u32, x0: f32, y0: f32, x1: f32, y1: f32) {
        let (a, b) = ((x0 / CELL).floor() as i64, (x1 / CELL).floor() as i64);
        let (c, d) = ((y0 / CELL).floor() as i64, (y1 / CELL).floor() as i64);
        if (b - a + 1) * (d - c + 1) > 2500 {
            return; // a polygon kilometres across: not a building
        }
        for cx in a..=b {
            for cy in c..=d {
                self.map.entry(key(cx, cy)).or_default().push(i);
            }
        }
    }
    fn around(&self, x: f32, y: f32, r: f32, out: &mut Vec<u32>) {
        out.clear();
        let (a, b) = (((x - r) / CELL).floor() as i64, ((x + r) / CELL).floor() as i64);
        let (c, d) = (((y - r) / CELL).floor() as i64, ((y + r) / CELL).floor() as i64);
        for cx in a..=b {
            for cy in c..=d {
                if let Some(v) = self.map.get(&key(cx, cy)) {
                    out.extend_from_slice(v);
                }
            }
        }
        out.sort_unstable();
        out.dedup();
    }
}

pub(crate) type P = (f32, f32);

/// Even-odd over all rings: outline and courtyards.
pub(crate) fn inside(p: P, rings: &[Vec<P>]) -> bool {
    let mut c = false;
    for ring in rings {
        let n = ring.len();
        let mut j = n - 1;
        for i in 0..n {
            let ((x1, y1), (x2, y2)) = (ring[i], ring[j]);
            if (y1 > p.1) != (y2 > p.1) && p.0 < (x2 - x1) * (p.1 - y1) / (y2 - y1) + x1 {
                c = !c;
            }
            j = i;
        }
    }
    c
}

/// Where p–q meets u–v, as the fraction along p–q; both ends of both segments count (a crossing at a vertex is a
/// crossing). None when they are parallel or apart.
pub(crate) fn hit(p: P, q: P, u: P, v: P) -> Option<f32> {
    let (rx, ry) = (q.0 - p.0, q.1 - p.1);
    let (dx, dy) = (v.0 - u.0, v.1 - u.1);
    let den = rx * dy - ry * dx;
    if den.abs() < 1e-9 {
        return None;
    }
    let (wx, wy) = (u.0 - p.0, u.1 - p.1);
    let t = (wx * dy - wy * dx) / den;
    let s = (wx * ry - wy * rx) / den;
    const E: f32 = 1e-5;
    ((-E..=1.0 + E).contains(&t) && (-E..=1.0 + E).contains(&s)).then_some(t)
}

/// Nearest point of segment a–b to p: (distance, point, t).
fn project(p: P, a: P, b: P) -> (f32, P, f32) {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 1e-9 { (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    let q = (a.0 + dx * t, a.1 + dy * t);
    (((p.0 - q.0).powi(2) + (p.1 - q.1).powi(2)).sqrt(), q, t)
}

/// (for the comparison tool)
pub fn inside_pub(p: P, rings: &[Vec<P>]) -> bool {
    inside(p, rings)
}
/// (for the comparison tool)
pub fn outline_dist_pub(p: P, rings: &[Vec<P>]) -> f32 {
    outline_dist(p, rings)
}

pub(crate) fn outline_dist(p: P, rings: &[Vec<P>]) -> f32 {
    rings.iter().flat_map(|r| (0..r.len()).map(move |i| project(p, r[i], r[(i + 1) % r.len()]).0)).fold(f32::INFINITY, f32::min)
}

/// Does the straight line p → q run through the inside of one of these buildings (rings: outline, courtyards)?
/// The line is cut where it meets each outline; a piece inside the building that somewhere (at points every 25 cm)
/// is more than 0.2 m from its outline is inside. Not counted: a building the line stays in (both ends in it or on
/// its outline, not both on it, and no piece outside it: from a door to the building's own corridor, from a point
/// inside to its door; across the open side of a U-shaped building it does count), and,
/// for a line to a way under an arcade (`arcade_m` > 0), the last `arcade_m` metres before q (the walkway under the
/// building's front).
pub fn through_building<'a>(p: P, q: P, arcade_m: f32, buildings: impl Iterator<Item = &'a [Vec<P>]>) -> bool {
    let len = ((q.0 - p.0).powi(2) + (q.1 - p.1).powi(2)).sqrt();
    if len < 0.4 {
        return false;
    }
    let on = |x: P, rings: &[Vec<P>]| outline_dist(x, rings) < 0.3;
    let limit = (1.0 - arcade_m / len).max(0.0);
    for rings in buildings {
        let mut ts: Vec<f32> = vec![0.0, 1.0];
        for r in rings {
            for i in 0..r.len() {
                if let Some(t) = hit(p, q, r[i], r[(i + 1) % r.len()]) {
                    ts.push(t.clamp(0.0, 1.0));
                }
            }
        }
        ts.sort_by(f32::total_cmp);
        let (pin, qin, pon, qon) = (inside(p, rings), inside(q, rings), on(p, rings), on(q, rings));
        // the pieces between the outline's crossings: (inside the building, clearly outside it), judged at points
        // every 25 cm along each (its deepest point counts: a line that skims along a wall a little inside it, or
        // leaves the building from a point inside, is inside), leaving out the half metre next to an end on the
        // outline (a door a few centimetres off it)
        let mut pieces: Vec<(bool, bool)> = Vec::new();
        for w in ts.windows(2) {
            let (a, b) = (w[0], w[1].min(limit));
            if (b - a) * len < 0.05 {
                continue;
            }
            let m = (a + b) / 2.0;
            let mid = (p.0 + (q.0 - p.0) * m, p.1 + (q.1 - p.1) * m);
            let inn = inside(mid, rings);
            // the middle more than 20 cm from the outline (and not next to a door): that decides it
            let near_door = (pon && m * len < 0.5) || (qon && (1.0 - m) * len < 0.5);
            if !near_door && outline_dist(mid, rings) > 0.2 {
                pieces.push((inn, !inn));
                continue;
            }
            // else points every 25 cm, every 5 cm within 60 cm of an end on the outline (a door)
            let mut ts: Vec<f32> = Vec::new();
            let steps = (((b - a) * len) / 0.25).ceil().max(1.0) as usize;
            ts.extend((0..=steps).map(|k| a + (b - a) * k as f32 / steps as f32));
            for end in [(0.0f32, pon), (1.0, qon)].into_iter().filter(|e| e.1).map(|e| e.0) {
                for k in 0..=12 {
                    let t = if end == 0.0 { k as f32 * 0.05 / len } else { 1.0 - k as f32 * 0.05 / len };
                    if t >= a && t <= b {
                        ts.push(t);
                    }
                }
            }
            let mut deep = 0f32;
            for t in ts {
                let x = (p.0 + (q.0 - p.0) * t, p.1 + (q.1 - p.1) * t);
                if inside(x, rings) != inn {
                    continue;
                }
                let d = outline_dist(x, rings);
                // next to an end on the outline (a door a few centimetres off it), only as deep as that end may be
                if d <= 0.25 && ((pon && t * len < 0.5) || (qon && (1.0 - t) * len < 0.5)) {
                    continue;
                }
                deep = deep.max(d);
            }
            pieces.push((inn && deep > 0.2, !inn && deep > 0.2));
        }
        // a line that stays in the building (both ends in it or on its outline, not both on it, and never out of
        // it): not through it. Out of it and back in (across the open side of a U, a courtyard) it is.
        if (pin || pon) && (qin || qon) && !(pon && qon) && !pieces.iter().any(|x| x.1) {
            continue;
        }
        if pieces.iter().any(|x| x.0) {
            return true;
        }
    }
    false
}

/// Planar rings of all buildings (outline first, then courtyards), with a grid for lookups.
struct Plan {
    rings: Vec<Vec<Vec<P>>>,
    grid: BoxGrid,
}

impl Plan {
    fn new(raw: &BuildingsRaw) -> Self {
        // the outlines as `Doors` stores them (1e-6° from the first point), so that what is found through a building
        // here is what the server finds
        let rings: Vec<Vec<Vec<P>>> = raw
            .buildings
            .par_iter()
            .map(|b| {
                let o = b.outer[0];
                let q = |p: &LatLon| LatLon { lat: o.lat + ((p.lat - o.lat) as f64 / 10.0).round() as i32 * 10, lon: o.lon + ((p.lon - o.lon) as f64 / 10.0).round() as i32 * 10 }.xy();
                std::iter::once(&b.outer).chain(b.holes.iter()).map(|r| r.iter().map(q).collect()).collect()
            })
            .collect();
        let mut grid = BoxGrid::default();
        for (i, r) in rings.iter().enumerate() {
            let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
            for &(x, y) in &r[0] {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
            grid.insert(i as u32, x0, y0, x1, y1);
        }
        Plan { rings, grid }
    }
    fn in_any_but(&self, p: P, own: u32, scratch: &mut Vec<u32>) -> bool {
        self.grid.around(p.0, p.1, 0.0, scratch);
        scratch.iter().any(|&b| b != own && inside(p, &self.rings[b as usize]))
    }
    fn through(&self, p: P, q: P, arcade_m: f32, scratch: &mut Vec<u32>) -> bool {
        let (mx, my) = ((p.0 + q.0) / 2.0, (p.1 + q.1) / 2.0);
        let half = ((p.0 - q.0).powi(2) + (p.1 - q.1).powi(2)).sqrt() / 2.0;
        self.grid.around(mx, my, half + 1.0, scratch);
        through_building(p, q, arcade_m, scratch.iter().map(|&b| self.rings[b as usize].as_slice()))
    }
}

/// Railway tracks on the ground, segment by segment, for the "never across the tracks" rule.
struct Rails {
    segs: Vec<(P, P)>,
    grid: BoxGrid,
}

impl Rails {
    fn new(x: &OsmExtract) -> Self {
        let mut segs = Vec::new();
        for c in x.carriageways.iter().filter(|c| c.kind == CarriagewayKind::RailTrack && !c.off_ground) {
            let g = &x.carriageway_geom[c.geom_off as usize..c.geom_off as usize + c.geom_len as usize];
            for w in g.windows(2) {
                segs.push((w[0].xy(), w[1].xy()));
            }
        }
        let mut grid = BoxGrid::default();
        for (i, (a, b)) in segs.iter().enumerate() {
            grid.insert(i as u32, a.0.min(b.0), a.1.min(b.1), a.0.max(b.0), a.1.max(b.1));
        }
        Rails { segs, grid }
    }
    /// Does p–q touch or cross a track on the ground, however short it is?
    fn cuts(&self, p: P, q: P, scratch: &mut Vec<u32>) -> bool {
        let (mx, my) = ((p.0 + q.0) / 2.0, (p.1 + q.1) / 2.0);
        let half = ((p.0 - q.0).powi(2) + (p.1 - q.1).powi(2)).sqrt() / 2.0;
        self.grid.around(mx, my, half + 1.0, scratch);
        scratch.iter().any(|&s| {
            let (u, v) = self.segs[s as usize];
            hit(p, q, u, v).is_some()
        })
    }
}

/// Points on the building's outline facing the open, nearest to `q` first (within 12 m, at most four, 3 m apart).
fn facade_points(plan: &Plan, b: u32, q: P, scratch: &mut Vec<u32>) -> Vec<P> {
    let rings = &plan.rings[b as usize];
    let ring = &rings[0];
    let n = ring.len();
    let mut opts: Vec<(f32, P, P, P)> = Vec::new();
    for i in 0..n {
        let (a, c) = (ring[i], ring[(i + 1) % n]);
        let (dx, dy) = (c.0 - a.0, c.1 - a.1);
        let l = (dx * dx + dy * dy).sqrt();
        if l < 0.5 {
            continue;
        }
        let (d, _, t) = project(q, a, c);
        // put, and judged, a little in from a corner (where both sides of the wall may be outside the building, and
        // a line out of the door may cut the corner back through it)
        let m = (0.5f32).min(l / 2.0) / l;
        let tp = t.clamp(m, 1.0 - m);
        let at = (a.0 + dx * tp, a.1 + dy * tp);
        opts.push((d, at, at, (-dy / l, dx / l)));
    }
    opts.sort_by(|x, y| x.0.total_cmp(&y.0));
    let mut out: Vec<P> = Vec::new();
    for (d, at, probe, (nx, ny)) in opts {
        if d > 12.0 || out.len() == 4 {
            break;
        }
        let sides: Vec<P> = [(probe.0 + nx, probe.1 + ny), (probe.0 - nx, probe.1 - ny)].into_iter().filter(|o| !inside(*o, rings)).collect();
        if sides.len() == 1 && !plan.in_any_but(sides[0], b, scratch) && out.iter().all(|o| ((o.0 - at.0).powi(2) + (o.1 - at.1).powi(2)).sqrt() >= 3.0) {
            out.push(at);
        }
    }
    out
}

/// "Bahnhofstrasse 12" + "Bahnhofstrasse 12a" → "Bahnhofstrasse 12, 12a".
pub fn merge_addr(a: &str, b: &str) -> String {
    match b.rsplit_once(' ') {
        Some((street, nb)) if !street.is_empty() && a.starts_with(&format!("{street} ")) => format!("{a}, {nb}"),
        _ => format!("{a}, {b}"),
    }
}

struct DoorTmp {
    building: u32,
    pos: LatLon,
    kind: DoorKind,
    wheelchair: u8,
    addr: String,
}

#[derive(Default, Debug, Clone, Copy)]
pub struct DoorStats {
    pub buildings: usize,
    pub osm_doors: usize,
    pub register_doors: usize,
    pub unattached: usize,
    /// Doors whose every way out runs through a building.
    pub through_only: usize,
}

pub(crate) const NO_STEP: u32 = (1 << EdgeKind::Steps as u8) | (1 << EdgeKind::Escalator as u8) | (1 << EdgeKind::Lift as u8);

/// The ways from a door at `pos` onto the network, cheapest first.
fn attach_door(router: &WalkRouter, plan: &Plan, rails: &Rails, pos: LatLon, scratch: &mut Vec<u32>) -> Vec<DoorAttach> {
    let g = router.graph();
    let opts = SnapOptions { max_dist_m: ATTACH_MAX_M, level: Some(0), profile: None, exclude_kinds: NO_STEP };
    let p = pos.xy();
    let mut out: Vec<(f32, DoorAttach)> = Vec::new();
    for s in router.snap_candidates(pos, &opts, 32) {
        // nothing further away can be cheaper than three found already
        if out.iter().filter(|(w, _)| *w <= s.dist_m).count() >= MAX_ATTACH {
            break;
        }
        let ed = &g.edges[s.edge as usize];
        // never straight into an underpass below the door
        if ed.flags & EF_TUNNEL != 0 && ed.flags & EF_COVERED == 0 {
            continue;
        }
        // one way out onto each way (the others are alternatives for a walker who may not use it)
        let way = g.edge_way.get(s.edge as usize).copied();
        if out.iter().any(|(_, a)| a.edge == s.edge || g.edge_way.get(a.edge as usize).copied() == way || router.snap_at(a.edge, a.frac()).pos.dist_m(&s.pos) < 1.0) {
            continue;
        }
        let q = s.pos.xy();
        if rails.cuts(p, q, scratch) {
            continue;
        }
        let wall = plan.through(p, q, if ed.flags & EF_COVERED != 0 { 5.0 } else { 0.0 }, scratch);
        out.push((line_weight_m(s.dist_m, ed.kind == EdgeKind::RoadBusy, wall), DoorAttach::new(s.edge, s.frac, s.dist_m, wall)));
    }
    out.sort_by(|a, b| a.0.total_cmp(&b.0));
    out.truncate(MAX_ATTACH);
    out.into_iter().map(|x| x.1).collect()
}

pub fn build(raw: &BuildingsRaw, register: &[Address], router: &WalkRouter, extract: &OsmExtract) -> (Doors, DoorStats) {
    let plan = Plan::new(raw);
    let rails = Rails::new(extract);
    let mut st = DoorStats { buildings: raw.len(), osm_doors: raw.entrances.len(), ..Default::default() };
    let mut doors: Vec<DoorTmp> =
        raw.entrances.iter().map(|e| DoorTmp { building: e.building, pos: e.pos, kind: e.kind, wheelchair: e.wheelchair, addr: e.addr.clone() }).collect();
    let mut has_door = vec![false; raw.len()];
    for e in &raw.entrances {
        has_door[e.building as usize] = true;
    }

    // ---- join the mapped doors to the network
    let mut attach: Vec<Vec<DoorAttach>> = doors.par_iter().map_init(Vec::new, |scratch, d| attach_door(router, &plan, &rails, d.pos, scratch)).collect();

    // ---- register points of buildings without a mapped door: on the nearest wall facing the open that has a way
    // out not through a building (of the nearest four), else on the nearest
    let placed: Vec<Option<(u32, P, &str, Vec<DoorAttach>)>> = register
        .par_iter()
        .map_init(Vec::new, |scratch, a| {
            let q = a.pos.xy();
            plan.grid.around(q.0, q.1, 8.0, scratch);
            let mut owner: Option<(u8, f32, u32)> = None;
            for &b in scratch.iter() {
                let r = &plan.rings[b as usize];
                let c = if inside(q, r) { (0u8, 0.0, b) } else { (1u8, outline_dist(q, r), b) };
                if owner.is_none_or(|o| (c.0, c.1) < (o.0, o.1)) {
                    owner = Some(c);
                }
            }
            let (out, d, b) = owner?;
            if (out == 1 && d > 8.0) || has_door[b as usize] {
                return None;
            }
            let mut s2 = Vec::new();
            let mut first: Option<(P, Vec<DoorAttach>)> = None;
            for at in facade_points(&plan, b, q, &mut s2) {
                let ways = attach_door(router, &plan, &rails, LatLon::from_xy(at.0, at.1), &mut s2);
                if ways.iter().any(|w| !w.through()) {
                    return Some((b, at, a.label.as_str(), ways));
                }
                first.get_or_insert((at, ways));
            }
            first.map(|(at, ways)| (b, at, a.label.as_str(), ways))
        })
        .collect();
    let mut per_bld: FxHashMap<u32, Vec<usize>> = FxHashMap::default();
    for (b, at, label, ways) in placed.into_iter().flatten() {
        let list = per_bld.entry(b).or_default();
        if let Some(&i) = list.iter().find(|&&i| {
            let p = doors[i].pos.xy();
            ((p.0 - at.0).powi(2) + (p.1 - at.1).powi(2)).sqrt() < 2.0
        }) {
            doors[i].addr = merge_addr(&doors[i].addr, label);
            continue;
        }
        list.push(doors.len());
        doors.push(DoorTmp { building: b, pos: LatLon::from_xy(at.0, at.1), kind: DoorKind::Address, wheelchair: DOOR_WC_UNKNOWN, addr: label.to_string() });
        attach.push(ways);
        st.register_doors += 1;
    }
    st.unattached = attach.iter().filter(|a| a.is_empty()).count();
    st.through_only = attach.iter().filter(|a| !a.is_empty() && a.iter().all(|x| x.through())).count();

    // ---- every building, with its doors (if any)
    let mut by_bld: Vec<Vec<usize>> = vec![Vec::new(); raw.len()];
    for (i, d) in doors.iter().enumerate() {
        by_bld[d.building as usize].push(i);
    }
    let mut out = Doors::default();
    for (b, bl) in raw.buildings.iter().enumerate() {
        let ds = &by_bld[b];
        let rings: Vec<&[LatLon]> = std::iter::once(bl.outer.as_slice()).chain(bl.holes.iter().map(|h| h.as_slice())).collect();
        let Some(packed) = Doors::pack_rings(bl.outer[0], &rings).filter(|r| r.len() <= u16::MAX as usize && ds.len() <= u16::MAX as usize) else { continue };
        out.buildings.push(DoorBuilding { origin: bl.outer[0], ring_off: out.ring.len() as u32, ring_len: packed.len() as u16, door_off: out.doors.len() as u32, door_len: ds.len() as u16 });
        out.ring.extend_from_slice(&packed);
        for &i in ds {
            let (d, a) = (&doors[i], &attach[i]);
            let addr = &d.addr[..d.addr.floor_char_boundary(u16::MAX as usize)];
            out.doors.push(Door {
                pos: d.pos,
                kind: d.kind,
                wheelchair: d.wheelchair,
                addr_off: out.addr.len() as u32,
                addr_len: addr.len() as u16,
                attach_off: out.attach.len() as u32,
                attach_len: a.len() as u8,
            });
            out.addr.push_str(addr);
            out.attach.extend_from_slice(a);
        }
    }
    out.graph = graph_fingerprint(router.graph());
    for c in extract.carriageways.iter().filter(|c| c.kind == CarriagewayKind::RailTrack && !c.off_ground) {
        let g = &extract.carriageway_geom[c.geom_off as usize..c.geom_off as usize + c.geom_len as usize];
        out.rails.extend(g.windows(2).map(|w| [w[0], w[1]]));
    }
    (out, st)
}

// ---------------------------------------------------------------- the index

/// [`BoxGrid`] frozen into sorted arrays: cell keys, and the items of cell `i` at `items[off[i] .. off[i + 1]]`.
struct FrozenGrid {
    keys: Vec<u64>,
    off: Vec<u32>,
    items: Vec<u32>,
}

impl FrozenGrid {
    fn new(g: BoxGrid) -> Self {
        let mut cells: Vec<(u64, Vec<u32>)> = g.map.into_iter().collect();
        cells.sort_unstable_by_key(|c| c.0);
        let mut out = FrozenGrid { keys: Vec::with_capacity(cells.len()), off: Vec::with_capacity(cells.len() + 1), items: Vec::new() };
        out.off.push(0);
        for (k, v) in cells {
            out.keys.push(k);
            out.items.extend_from_slice(&v);
            out.off.push(out.items.len() as u32);
        }
        out
    }
    fn cell(&self, cx: i64, cy: i64) -> &[u32] {
        match self.keys.binary_search(&key(cx, cy)) {
            Ok(i) => &self.items[self.off[i] as usize..self.off[i + 1] as usize],
            Err(_) => &[],
        }
    }
    /// The items of every cell the box (x0, y0)–(x1, y1) touches.
    fn in_box(&self, x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<u32> {
        let mut out = Vec::new();
        for cx in (x0 / CELL).floor() as i64..=(x1 / CELL).floor() as i64 {
            for cy in (y0 / CELL).floor() as i64..=(y1 / CELL).floor() as i64 {
                out.extend_from_slice(self.cell(cx, cy));
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }
    fn heap_bytes(&self) -> usize {
        self.keys.len() * 8 + self.off.len() * 4 + self.items.len() * 4
    }
}

/// All buildings and their doors by place, for queries.
pub struct DoorIndex {
    pub doors: Doors,
    grid: FrozenGrid,
    /// The tracks on the ground, as planar segments, and a grid of them.
    rails: Vec<(P, P)>,
    rail_grid: FrozenGrid,
    /// Doors placed from the address register.
    pub register_doors: usize,
}

impl DoorIndex {
    pub fn new(doors: Doors) -> Self {
        let mut grid = BoxGrid::default();
        for b in 0..doors.buildings.len() as u32 {
            let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
            for p in &doors.rings_of(b)[0] {
                let (x, y) = p.xy();
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
            grid.insert(b, x0, y0, x1, y1);
        }
        let register_doors = doors.doors.iter().filter(|d| d.kind == DoorKind::Address).count();
        let rails: Vec<(P, P)> = doors.rails.iter().map(|r| (r[0].xy(), r[1].xy())).collect();
        let mut rg = BoxGrid::default();
        for (i, (a, b)) in rails.iter().enumerate() {
            rg.insert(i as u32, a.0.min(b.0), a.1.min(b.1), a.0.max(b.0), a.1.max(b.1));
        }
        DoorIndex { doors, grid: FrozenGrid::new(grid), rails, rail_grid: FrozenGrid::new(rg), register_doors }
    }
    /// Does the straight line a → b touch or cross a railway track on the ground, however short it is?
    pub fn crosses_track(&self, a: LatLon, b: LatLon) -> bool {
        let (p, q) = (a.xy(), b.xy());
        self.rail_grid
            .in_box(p.0.min(q.0) - 1.0, p.1.min(q.1) - 1.0, p.0.max(q.0) + 1.0, p.1.max(q.1) + 1.0)
            .into_iter()
            .any(|s| {
                let (u, v) = self.rails[s as usize];
                hit(p, q, u, v).is_some()
            })
    }
    /// Was this index made for this graph?
    pub fn fits(&self, g: &WalkGraph) -> bool {
        self.doors.graph == graph_fingerprint(g)
    }
    pub fn rings_of(&self, b: u32) -> Vec<Vec<(f32, f32)>> {
        self.rings_xy(b)
    }
    pub(crate) fn rings_xy(&self, b: u32) -> Vec<Vec<P>> {
        self.doors.rings_of(b).iter().map(|r| r.iter().map(|x| x.xy()).collect()).collect()
    }
    /// The buildings `p` is inside (not in a courtyard of).
    pub fn buildings_at(&self, p: LatLon) -> Vec<u32> {
        let q = p.xy();
        let mut cand = self.grid.in_box(q.0, q.1, q.0, q.1);
        cand.retain(|&b| inside(q, &self.rings_xy(b)));
        cand
    }
    /// The buildings whose box is near the straight line a → b.
    pub fn buildings_near(&self, a: LatLon, b: LatLon) -> Vec<u32> {
        let (p, q) = (a.xy(), b.xy());
        self.grid.in_box(p.0.min(q.0) - 1.0, p.1.min(q.1) - 1.0, p.0.max(q.0) + 1.0, p.1.max(q.1) + 1.0)
    }
    /// Does the straight line a → b run through a building ([`through_building`])?
    pub fn through(&self, a: LatLon, b: LatLon, arcade_m: f32) -> bool {
        self.through_except(a, b, arcade_m, u32::MAX)
    }
    /// Does the straight line a → q from inside building `b` to a door on its outline leave the building on the way
    /// (at a point every 5 cm, one more than 0.3 m outside it: across a U's open side, round a corner, or through a
    /// jog in its wall)?
    pub fn leaves(&self, a: LatLon, q: LatLon, b: u32) -> bool {
        let (p, q) = (a.xy(), q.xy());
        let len = ((q.0 - p.0).powi(2) + (q.1 - p.1).powi(2)).sqrt().max(1e-3);
        let rings = self.rings_xy(b);
        let steps = (len / 0.05).ceil() as usize;
        (0..=steps).map(|k| (k as f32 * 0.05).min(len) / len).any(|t| {
            let x = (p.0 + (q.0 - p.0) * t, p.1 + (q.1 - p.1) * t);
            !inside(x, &rings) && outline_dist(x, &rings) > 0.3
        })
    }
    /// [`DoorIndex::through`], leaving building `skip` out.
    pub fn through_except(&self, a: LatLon, b: LatLon, arcade_m: f32, skip: u32) -> bool {
        let (p, q) = (a.xy(), b.xy());
        let mut near = self.grid.in_box(p.0.min(q.0) - 1.0, p.1.min(q.1) - 1.0, p.0.max(q.0) + 1.0, p.1.max(q.1) + 1.0);
        near.retain(|&x| x != skip);
        let rings: Vec<Vec<Vec<P>>> = near.iter().map(|&b| self.rings_xy(b)).collect();
        through_building(p, q, arcade_m, rings.iter().map(|r| r.as_slice()))
    }
    /// Megabytes held: (outlines, doors, ways out, addresses, grid).
    pub fn breakdown_mb(&self) -> [f32; 5] {
        use std::mem::size_of;
        let d = &self.doors;
        let mb = |b: usize| b as f32 / 1048576.0;
        [
            mb(d.buildings.len() * size_of::<DoorBuilding>() + d.ring.len() * size_of::<[i16; 2]>()),
            mb(d.doors.len() * size_of::<Door>()),
            mb(d.attach.len() * size_of::<DoorAttach>()),
            mb(d.addr.len()),
            mb(self.grid.heap_bytes()),
        ]
    }
    pub fn heap_bytes(&self) -> usize {
        (self.breakdown_mb().iter().sum::<f32>() * 1048576.0) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_merge() {
        assert_eq!(merge_addr("Bahnhofstrasse 12", "Bahnhofstrasse 12a"), "Bahnhofstrasse 12, 12a");
        assert_eq!(merge_addr("Bahnhofstrasse 12, 12a", "Bahnhofstrasse 14"), "Bahnhofstrasse 12, 12a, 14");
        assert_eq!(merge_addr("Bahnhofstrasse 12", "Gartenweg 1"), "Bahnhofstrasse 12, Gartenweg 1");
    }

    #[test]
    fn lines_through_buildings() {
        let house = vec![vec![(0.0, 0.0), (20.0, 0.0), (20.0, 16.0), (0.0, 16.0)]];
        let b = || std::iter::once(house.as_slice());
        // a chord from wall to wall through a 20 m house: through it, however the ends lie on the walls
        assert!(through_building((0.0, 8.0), (20.0, 8.0), 0.0, b()));
        // from a door on the front wall out to the street, and along the wall: not
        assert!(!through_building((10.0, 0.0), (10.0, -6.0), 0.0, b()));
        assert!(!through_building((1.0, -0.1), (19.0, -0.1), 0.0, b()));
        // from the back door through the house to a covered sidewalk 2 m in front: through it, arcade or not
        assert!(through_building((10.0, 16.0), (10.0, -2.0), 0.0, b()));
        assert!(through_building((10.0, 16.0), (10.0, -2.0), 5.0, b()));
        // to a walkway under the arcade inside the front 3 m of the building: not
        assert!(!through_building((10.0, 0.0), (10.0, 3.0), 5.0, b()));
        // a line that stays in the building (to its own corridor, from a point inside to its door): not
        assert!(!through_building((10.0, 0.0), (10.0, 8.0), 0.0, b()));
        assert!(!through_building((10.0, 8.0), (10.0, 0.0), 0.0, b()));
        // out of a building from a point inside it: through its wall
        assert!(through_building((10.0, 8.0), (10.0, -5.0), 0.0, b()));
        // to a door on the front wall from inside the house, the last half metre more than 30 cm in: through
        assert!(through_building((10.0, -8.0), (10.0, 0.0), 0.0, b()) == false);
        assert!(through_building((4.0, 6.0), (10.0, 0.0), 0.0, b()) == false, "from inside to its own door: stays in");
        assert!(through_building((30.0, 1.0), (10.0, 0.0), 0.0, b()));
        // in through the side wall 23 cm from the corner and along inside the front wall to a door on it: through
        assert!(through_building((-3.0, 0.3), (10.0, 0.0), 0.0, b()));
        // a door 25 cm inside the outline (as mapped) out to the street: not; a point 31 cm inside it: through the wall
        assert!(!through_building((10.0, 0.25), (10.0, -6.0), 0.0, b()));
        assert!(through_building((10.0, 0.31), (10.0, -6.0), 0.0, b()));
        // across the open side of a U, from one wing into the other: out through one wall and in through another
        let u = vec![vec![(0.0, 0.0), (30.0, 0.0), (30.0, 20.0), (20.0, 20.0), (20.0, 8.0), (10.0, 8.0), (10.0, 20.0), (0.0, 20.0)]];
        assert!(through_building((5.0, 15.0), (23.0, 15.0), 0.0, std::iter::once(u.as_slice())));
        assert!(!through_building((5.0, 4.0), (25.0, 4.0), 0.0, std::iter::once(u.as_slice())), "along the base of the U it stays inside");
        // a courtyard is not the building
        let court = vec![house[0].clone(), vec![(5.0, 4.0), (15.0, 4.0), (15.0, 12.0), (5.0, 12.0)]];
        assert!(!through_building((10.0, 8.0), (14.0, 8.0), 0.0, std::iter::once(court.as_slice())));
        // a line through a rail's vertex crosses it, whether the rail has a node there or not
        assert!(hit((0.0, -5.0), (0.0, 5.0), (-10.0, 0.0), (0.0, 0.0)).is_some());
        assert!(hit((0.0, -5.0), (0.0, 5.0), (0.0, 0.0), (10.0, 0.0)).is_some());
    }

    use crate::register::Address;
    use crate::test_world::*;

    #[test]
    fn doors_are_joined_by_the_cheapest_way_and_never_across_a_track_on_the_ground() {
        let mut w = World::new();
        // in front (y < 0): main roads 4 and 5 m from the door, a sidewalk 6 m
        w.way((-100.0, -4.0), (100.0, -4.0), 4, EdgeKind::RoadBusy, 0);
        w.way((-100.0, -5.0), (100.0, -5.0), 4, EdgeKind::RoadBusy, 0);
        w.way((-100.0, -6.0), (100.0, -6.0), 4, EdgeKind::Sidewalk, 0);
        let b = w.building(-10.0, 0.0, 10.0, 20.0);
        w.door(b, 0.0, 0.0, DoorKind::Main, DOOR_WC_UNKNOWN);
        // a back door with nothing behind the house
        w.door(b, 0.0, 20.0, DoorKind::Yes, DOOR_WC_UNKNOWN);
        // a second house whose only way out is across a railway with a node right where the line would cross it
        let c = w.building(200.0, 10.0, 220.0, 30.0);
        w.door(c, 210.0, 10.0, DoorKind::Main, DOOR_WC_UNKNOWN);
        w.way((150.0, 0.0), (250.0, 0.0), 4, EdgeKind::Sidewalk, 0);
        w.rail(&[(150.0, 5.0), (210.0, 5.0), (250.0, 5.0)], false);
        // a third whose way out passes over a railway in a tunnel
        let d = w.building(400.0, 10.0, 420.0, 30.0);
        w.door(d, 410.0, 10.0, DoorKind::Main, DOOR_WC_UNKNOWN);
        w.way((350.0, 0.0), (450.0, 0.0), 4, EdgeKind::Sidewalk, 0);
        w.rail(&[(350.0, 5.0), (410.0, 5.0), (450.0, 5.0)], true);
        // a fourth right next to a track, the sidewalk 20 cm from the door on the other side of it
        let e = w.building(600.0, 0.0, 620.0, 20.0);
        w.door(e, 610.0, 0.0, DoorKind::Main, DOOR_WC_UNKNOWN);
        w.way((550.0, -0.2), (650.0, -0.2), 4, EdgeKind::Sidewalk, 0);
        w.rail(&[(550.0, -0.1), (650.0, -0.1)], false);
        // a house with no door at all
        w.building(800.0, 0.0, 820.0, 20.0);
        let (r, ix, st) = w.finish_with_stats();
        let g = r.graph();
        let front = ix.doors.attach_of(0);
        assert_eq!(g.edges[front[0].edge as usize].kind, EdgeKind::Sidewalk, "the sidewalk before the main roads");
        assert!(front.iter().all(|a| !a.through()));
        let back = ix.doors.attach_of(1);
        assert!(!back.is_empty() && back.iter().all(|a| a.through()), "the back door is joined through the house only, marked");
        assert_eq!(st.through_only, 1);
        assert!(ix.doors.attach_of(2).is_empty(), "not across the track, even at its node");
        assert!(!ix.doors.attach_of(3).is_empty(), "a track in a tunnel does not block the door");
        assert!(ix.doors.attach_of(4).is_empty(), "nor across a track however short the line");
        // every building is known, with doors or not
        assert_eq!(ix.doors.buildings.len(), 5);
        assert_eq!(ix.buildings_at(pt(810.0, 10.0)).len(), 1);
    }

    #[test]
    fn a_register_point_goes_on_the_wall_with_a_way_out() {
        // the address point is 2 m from the back wall; behind the house its garden shed and the neighbours' houses,
        // in front the street
        let mut w = World::new();
        w.way((-100.0, -3.0), (100.0, -3.0), 10, EdgeKind::Sidewalk, 0);
        w.building(0.0, 0.0, 20.0, 12.0);
        w.building(5.0, 12.0, 15.0, 18.0);
        w.building(-30.0, 12.0, 5.0, 30.0);
        w.building(15.0, 12.0, 40.0, 30.0);
        w.building(5.0, 21.0, 15.0, 40.0);
        let (r, x, b) = w.router();
        let reg = vec![
            Address { pos: pt(10.0, 10.0), label: "Gartenweg 5".into() },
            // the shed (5.1): its only wall facing the open is on the gap behind it
            Address { pos: pt(10.0, 17.0), label: "Gartenweg 5.1".into() },
        ];
        let (d, st) = build(&b, &reg, &r, &x);
        assert_eq!(st.register_doors, 2);
        let house = d.doors.iter().position(|x| x.pos.dist_m(&pt(10.0, 10.0)) < 10.5 && x.pos.xy().1 < 11.0).expect("on a wall with a way out");
        assert!(!d.attach_of(house as u32).is_empty() && d.attach_of(house as u32).iter().all(|a| !a.through()));
        let shed = d.doors.iter().position(|x| x.pos.dist_m(&pt(10.0, 18.0)) < 0.5).expect("the shed's door on its back wall");
        assert!(!d.attach_of(shed as u32).is_empty() && d.attach_of(shed as u32).iter().all(|a| a.through()), "no way out but through a house: marked");
    }

    #[test]
    fn an_index_belongs_to_its_graph() {
        let mut w = World::new();
        w.way((0.0, 0.0), (100.0, 0.0), 2, EdgeKind::Sidewalk, 0);
        let mut v = World::new();
        v.way((0.0, 0.0), (100.0, 10.0), 2, EdgeKind::Sidewalk, 0);
        let mut u = World::new();
        u.way((0.0, 0.0), (100.0, 0.0), 2, EdgeKind::Sidewalk, EF_WHEELCHAIR_NO);
        let (rw, iw) = w.finish();
        let (rv, _) = v.finish();
        let (ru, _) = u.finish();
        assert_eq!(rw.graph().edges.len(), rv.graph().edges.len());
        assert!(iw.fits(rw.graph()) && !iw.fits(rv.graph()), "the same size, other geometry: not this index's graph");
        assert!(!iw.fits(ru.graph()), "the same geometry, other flags: not this index's graph");
    }
}
