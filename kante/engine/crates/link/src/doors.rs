//! Doors: where a walk that starts in or ends at a building leaves or enters it.
//!
//! [`build`] makes [`Doors`] from the buildings and mapped entrances of
//! OpenStreetMap ([`kante_osm::buildings`]) and the official building address
//! register ([`crate::register`]). At query time [`DoorIndex::choice`] says
//! which doors a walker may use at a point, [`reach_costs`] times walks from
//! them to many targets and [`best_walk`] routes one walk through the best of
//! them. The rules are the ones the browser's walking network used
//! (`docs/walking-routes.md`):
//!
//! - A building's doors are its mapped entrances. A building with none gets a
//!   door at each register address that belongs to it: the address point is
//!   in it, or its outline is the nearest within 8 m. The point is put on the
//!   nearest stretch of outline (within 12 m) that faces the open — 1 m out
//!   from that wall is neither this building nor another one, so never a wall
//!   shared with the house next door. Two addresses within 2 m are one door
//!   ("Bahnhofstrasse 12, 12a"). A courtyard is not part of its building.
//! - A door is joined to the walking network by straight lines of up to 80 m
//!   to the nearest walkable edges (no stairs, escalators, lifts or
//!   underpasses). A line may not cut through a building — the door's own one
//!   included, so a back door is not joined through the house to the street
//!   in front — except one whose arcade the edge runs under, nor cross a
//!   railway track on the ground (one in a tunnel or on a bridge does not
//!   count). A door that can be joined in no other way (a house whose address
//!   point faces a garden, the road behind it, no path between) is joined
//!   through its own house, marked so: the walk round the house to it is a
//!   guess, and a door with a real way out is preferred. The three cheapest are kept (a road whose sidewalks are not mapped
//!   counts 4 × its distance), so a walker who may not use the first (a step-free
//!   one on a `wheelchair=no` path) has others. A building whose doors cannot
//!   be joined at all stays in the index: a walk into it is then a guess.

use crate::register::Address;
use kante_core::geo::LatLon;
use kante_core::walk::*;
use kante_osm::buildings::BuildingsRaw;
use kante_walk::{SnapOptions, WalkCost, WalkPath, WalkRouter};
use rayon::prelude::*;
use rustc_hash::FxHashMap;

const CELL: f32 = 50.0;
const ATTACH_MAX_M: f32 = 80.0;
const MAX_ATTACH: usize = 3;
/// A connector's ends: a touch this close to the door or the network is not a crossing.
const TOUCH_M: f32 = 0.3;

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

type P = (f32, f32);

/// Even-odd over all rings: outline and courtyards.
fn inside(p: P, rings: &[Vec<P>]) -> bool {
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

/// Where p–q meets u–v, as the fraction along p–q; both ends of both segments count (a crossing at a vertex
/// is a crossing). None when they are parallel or apart.
fn hit(p: P, q: P, u: P, v: P) -> Option<f32> {
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

/// Does p–q cross u–v away from its own two ends (more than `TOUCH_M` from them)?
fn cuts_segment(p: P, q: P, u: P, v: P) -> bool {
    let len = ((q.0 - p.0).powi(2) + (q.1 - p.1).powi(2)).sqrt();
    hit(p, q, u, v).is_some_and(|t| t * len > TOUCH_M && t * len < len - TOUCH_M)
}

/// Nearest point of segment a–b to p: (distance, point, t).
fn project(p: P, a: P, b: P) -> (f32, P, f32) {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 1e-9 { (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    let q = (a.0 + dx * t, a.1 + dy * t);
    (((p.0 - q.0).powi(2) + (p.1 - q.1).powi(2)).sqrt(), q, t)
}

fn outline_dist(p: P, rings: &[Vec<P>]) -> f32 {
    rings.iter().flat_map(|r| (0..r.len()).map(move |i| project(p, r[i], r[(i + 1) % r.len()]).0)).fold(f32::INFINITY, f32::min)
}

/// Planar rings of all buildings (outline first, then courtyards), with a grid for lookups.
struct Plan {
    rings: Vec<Vec<Vec<P>>>,
    grid: BoxGrid,
}

impl Plan {
    fn new(raw: &BuildingsRaw) -> Self {
        let rings: Vec<Vec<Vec<P>>> = raw
            .buildings
            .par_iter()
            .map(|b| std::iter::once(&b.outer).chain(b.holes.iter()).map(|r| r.iter().map(|p| p.xy()).collect()).collect())
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
    /// Does p–q cut a wall of a building not in `allow` (away from its ends)?
    fn cuts(&self, p: P, q: P, allow: &[u32], scratch: &mut Vec<u32>) -> bool {
        let (mx, my) = ((p.0 + q.0) / 2.0, (p.1 + q.1) / 2.0);
        let half = ((p.0 - q.0).powi(2) + (p.1 - q.1).powi(2)).sqrt() / 2.0;
        self.grid.around(mx, my, half + 1.0, scratch);
        scratch.iter().any(|&b| {
            !allow.contains(&b) && self.rings[b as usize].iter().any(|r| (0..r.len()).any(|i| cuts_segment(p, q, r[i], r[(i + 1) % r.len()])))
        })
    }
    fn buildings_at(&self, p: P, scratch: &mut Vec<u32>) -> Vec<u32> {
        self.grid.around(p.0, p.1, 0.0, scratch);
        scratch.iter().copied().filter(|&b| inside(p, &self.rings[b as usize])).collect()
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

/// The point on the building's outline facing the open nearest to `q` (within 12 m).
fn facade_point(plan: &Plan, b: u32, q: P, scratch: &mut Vec<u32>) -> Option<P> {
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
        let (d, at, t) = project(q, a, c);
        // judged a little in from a corner, where both sides of the wall may be outside the building
        let m = (0.5f32).min(l / 2.0) / l;
        let tp = t.clamp(m, 1.0 - m);
        opts.push((d, at, (a.0 + dx * tp, a.1 + dy * tp), (-dy / l, dx / l)));
    }
    opts.sort_by(|x, y| x.0.total_cmp(&y.0));
    for (d, at, probe, (nx, ny)) in opts {
        if d > 12.0 {
            break;
        }
        let sides: Vec<P> = [(probe.0 + nx, probe.1 + ny), (probe.0 - nx, probe.1 - ny)].into_iter().filter(|o| !inside(*o, rings)).collect();
        if sides.len() == 1 && !plan.in_any_but(sides[0], b, scratch) {
            return Some(at);
        }
    }
    None
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
    pub buildings_with_doors: usize,
}

const NO_STEP: u32 = (1 << EdgeKind::Steps as u8) | (1 << EdgeKind::Escalator as u8) | (1 << EdgeKind::Lift as u8);

/// The ways from a door at `pos` (of building `own`) onto the network, best first; when there is none, through
/// its own building (marked).
fn attach_door(router: &WalkRouter, plan: &Plan, rails: &Rails, own: u32, pos: LatLon, scratch: &mut Vec<u32>) -> Vec<DoorAttach> {
    let out = attach_door_by(router, plan, rails, own, pos, false, scratch);
    if out.is_empty() {
        attach_door_by(router, plan, rails, own, pos, true, scratch)
    } else {
        out
    }
}

fn attach_door_by(router: &WalkRouter, plan: &Plan, rails: &Rails, own: u32, pos: LatLon, through: bool, scratch: &mut Vec<u32>) -> Vec<DoorAttach> {
    let g = router.graph();
    let opts = SnapOptions { max_dist_m: ATTACH_MAX_M, level: Some(0), profile: None, exclude_kinds: NO_STEP };
    let p = pos.xy();
    // a door of a building that stands inside another one (a complex drawn around it) may leave through that one
    let mut around: Vec<u32> = plan.buildings_at(p, scratch).into_iter().filter(|&b| b != own).collect();
    if through {
        around.push(own);
    }
    let mut out: Vec<(f32, DoorAttach)> = Vec::new();
    for s in router.snap_candidates(pos, &opts, 32) {
        let ed = &g.edges[s.edge as usize];
        // never straight into an underpass below the door
        if ed.flags & EF_TUNNEL != 0 && ed.flags & EF_COVERED == 0 {
            continue;
        }
        if out.iter().any(|(_, a)| a.edge == s.edge) {
            continue;
        }
        let q = s.pos.xy();
        let mut allow = around.clone();
        if ed.flags & EF_COVERED != 0 {
            // an arcade is open to the street: the building it runs under does not block the line
            let mut s2 = Vec::new();
            allow.extend(plan.buildings_at(q, &mut s2));
            plan.grid.around(q.0, q.1, 5.0, &mut s2);
            allow.extend(s2.iter().copied().filter(|&b| outline_dist(q, &plan.rings[b as usize]) < 5.0));
        }
        if s.dist_m > TOUCH_M && (plan.cuts(p, q, &allow, scratch) || rails.cuts(p, q, scratch)) {
            continue;
        }
        let f = if ed.kind == EdgeKind::RoadBusy { 4.0 } else { 1.0 };
        out.push((s.dist_m * f, DoorAttach::new(s.edge, s.frac, s.dist_m, through)));
    }
    // the cheapest, not the nearest: a sidewalk 6 m away before a main road 4 m away
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

    // ---- register points of buildings without a mapped door
    let placed: Vec<Option<(u32, P, &str)>> = register
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
            facade_point(&plan, b, q, &mut s2).map(|at| (b, at, a.label.as_str()))
        })
        .collect();
    let mut per_bld: FxHashMap<u32, Vec<usize>> = FxHashMap::default();
    for (b, at, label) in placed.into_iter().flatten() {
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
        st.register_doors += 1;
    }

    // ---- join each door to the network
    let attach: Vec<Vec<DoorAttach>> = doors.par_iter().map_init(Vec::new, |scratch, d| attach_door(router, &plan, &rails, d.building, d.pos, scratch)).collect();
    st.unattached = attach.iter().filter(|a| a.is_empty()).count();

    // ---- every building with a door, joined or not
    let mut order: Vec<usize> = (0..doors.len()).collect();
    order.sort_by_key(|&i| doors[i].building);
    let mut out = Doors::default();
    let mut k = 0;
    while k < order.len() {
        let b = doors[order[k]].building;
        let mut end = k;
        while end < order.len() && doors[order[end]].building == b {
            end += 1;
        }
        let bl = &raw.buildings[b as usize];
        let rings: Vec<&[LatLon]> = std::iter::once(bl.outer.as_slice()).chain(bl.holes.iter().map(|h| h.as_slice())).collect();
        let packed = Doors::pack_rings(bl.outer[0], &rings).filter(|r| r.len() <= u16::MAX as usize && end - k <= u16::MAX as usize);
        let Some(packed) = packed else {
            k = end;
            continue;
        };
        out.buildings.push(DoorBuilding { origin: bl.outer[0], ring_off: out.ring.len() as u32, ring_len: packed.len() as u16, door_off: out.doors.len() as u32, door_len: (end - k) as u16 });
        out.ring.extend_from_slice(&packed);
        for &i in &order[k..end] {
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
        k = end;
    }
    out.graph = graph_fingerprint(router.graph());
    st.buildings_with_doors = out.buildings.len();
    (out, st)
}

// ---------------------------------------------------------------- queries

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
    fn at(&self, x: f32, y: f32) -> &[u32] {
        match self.keys.binary_search(&key((x / CELL).floor() as i64, (y / CELL).floor() as i64)) {
            Ok(i) => &self.items[self.off[i] as usize..self.off[i + 1] as usize],
            Err(_) => &[],
        }
    }
    fn heap_bytes(&self) -> usize {
        self.keys.len() * 8 + self.off.len() * 4 + self.items.len() * 4
    }
}

/// A way into or out of a building at one end of a walk: a door, and where
/// the straight line from it meets the walking network.
#[derive(Clone, Copy, Debug)]
pub struct DoorOpt {
    pub door: u32,
    /// On the network; `snap.dist_m` is the line from the door to it.
    pub snap: Snap,
    /// From the point (inside the building) to the door.
    pub inside_m: f32,
    /// Route choice only: back doors, garages, register points ([`DoorKind::penalty_m`]), and 50 m for a door
    /// joined only through its own house.
    pub penalty_m: f32,
    /// The line from the door goes through its own building: the way round it is a guess.
    pub through: bool,
}

impl DoorOpt {
    /// Metres walked from the point to the network through this door.
    pub fn extra_m(&self) -> f32 {
        self.inside_m + self.snap.dist_m
    }
}

/// The doors one end of a walk may use.
#[derive(Clone, Debug, Default)]
pub struct DoorChoice {
    pub opts: Vec<DoorOpt>,
    /// The point is inside a building that has doors (usable or not).
    pub in_building: bool,
    /// ... but none of them is open to this (step-free) walker.
    pub no_step_free_door: bool,
}

/// The buildings of [`Doors`] by place, for queries.
pub struct DoorIndex {
    pub doors: Doors,
    grid: FrozenGrid,
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
        DoorIndex { doors, grid: FrozenGrid::new(grid) }
    }
    /// Was this index made for this graph?
    pub fn fits(&self, g: &WalkGraph) -> bool {
        self.doors.graph == graph_fingerprint(g)
    }
    /// The buildings (with doors) that `p` is inside (not in a courtyard of).
    pub fn buildings_at(&self, p: LatLon) -> Vec<u32> {
        let q = p.xy();
        let mut cand = self.grid.at(q.0, q.1).to_vec();
        cand.retain(|&b| {
            let rings: Vec<Vec<P>> = self.doors.rings_of(b).iter().map(|r| r.iter().map(|x| x.xy()).collect()).collect();
            inside(q, &rings)
        });
        cand
    }
    /// The doors through which a walk may leave (or enter) the building `pos` is in, best first: only those this
    /// walker may use (not `wheelchair=no` for a step-free one), joined to ways the walker may use.
    pub fn choice(&self, router: &WalkRouter, pos: LatLon, profile: &WalkProfile) -> DoorChoice {
        let d = &self.doors;
        let strict = profile.wheelchair || profile.is_step_free();
        let mut out = DoorChoice::default();
        let mut more: Vec<DoorOpt> = Vec::new(); // each door's further ways onto the network
        let mut barred = 0;
        for b in self.buildings_at(pos) {
            out.in_building = true;
            for di in d.doors_of(b) {
                let door = &d.doors[di as usize];
                if strict && door.wheelchair == DOOR_WC_NO {
                    barred += 1;
                    continue;
                }
                // a step-free walker prefers a door known to be step-free
                let penalty_m = door.kind.penalty_m() + if strict && door.wheelchair != DOOR_WC_YES { 5.0 } else { 0.0 };
                let inside_m = pos.dist_m(&door.pos);
                for (k, a) in d.attach_of(di).iter().filter(|a| router.usable(a.edge, profile)).enumerate() {
                    let snap = Snap { dist_m: a.dist_m(), ..router.snap_at(a.edge, a.frac()) };
                    let penalty_m = penalty_m + if a.through() { 50.0 } else { 0.0 };
                    if k == 0 { &mut out.opts } else { &mut more }.push(DoorOpt { door: di, snap, inside_m, penalty_m, through: a.through() });
                }
            }
        }
        // the eight best doors, each by its best way; further ways of a door only where there is room
        let cost = |x: &DoorOpt| x.extra_m() + x.penalty_m;
        out.opts.sort_by(|x, y| cost(x).total_cmp(&cost(y)));
        out.opts.truncate(8);
        more.retain(|m| out.opts.iter().any(|o| o.door == m.door));
        more.sort_by(|x, y| cost(x).total_cmp(&cost(y)));
        out.opts.extend(more.into_iter().take(8 - out.opts.len()));
        out.no_step_free_door = barred > 0 && out.opts.is_empty();
        out
    }
    /// Megabytes held: (outlines, doors, ways onto the network, addresses, grid).
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
        use std::mem::size_of;
        let d = &self.doors;
        d.buildings.len() * size_of::<DoorBuilding>()
            + d.ring.len() * size_of::<[i16; 2]>()
            + d.doors.len() * size_of::<Door>()
            + d.attach.len() * size_of::<DoorAttach>()
            + d.addr.len()
            + self.grid.heap_bytes()
    }
}

/// How one end of a walk joins the network: at `snap`, after `extra_m` metres (to a door and from it onto the
/// network, or the straight line to the network), through `door` if any.
#[derive(Clone, Copy, Debug)]
pub struct Join {
    pub snap: Snap,
    pub extra_m: f32,
    pub penalty_m: f32,
    pub door: Option<DoorOpt>,
}

/// The ways onto the network at one end of a walk: through its building's doors, or, when there are none (or
/// none leads anywhere), straight to the nearest way.
#[derive(Clone, Debug, Default)]
pub struct Ends {
    pub doors: Vec<Join>,
    pub fallback: Option<Join>,
}

impl Ends {
    pub fn new(choice: &DoorChoice, snap: Option<Snap>) -> Ends {
        Ends {
            doors: choice.opts.iter().map(|o| Join { snap: o.snap, extra_m: o.extra_m(), penalty_m: o.penalty_m, door: Some(*o) }).collect(),
            fallback: snap.map(|s| Join { snap: s, extra_m: s.dist_m, penalty_m: 0.0, door: None }),
        }
    }
    fn first(&self) -> Vec<Join> {
        if self.doors.is_empty() {
            self.fallback.into_iter().collect()
        } else {
            self.doors.clone()
        }
    }
}

/// Walking costs from one end of a walk to many targets, the metres to the network included, `None` beyond
/// `max_s`. Through the doors (preferring the better kind of door); a target that the preferred door would reach
/// only beyond `max_s` is reached through any door that is within it; and when no door leads to any target
/// (all on a piece of path cut off by steps, say), straight from the point.
pub fn reach_costs(router: &WalkRouter, ends: &Ends, targets: &[Snap], profile: &WalkProfile, max_s: f32) -> Vec<Option<WalkCost>> {
    let speed = profile.speed_mps.max(0.05);
    let srcs = |js: &[Join], pen: bool| -> Vec<(Snap, f32, f32)> { js.iter().map(|j| (j.snap, j.extra_m, if pen { j.penalty_m / speed } else { 0.0 })).collect() };
    let mut out: Vec<Option<WalkCost>> = vec![None; targets.len()];
    if !ends.doors.is_empty() {
        out = router.many_to_many(&srcs(&ends.doors, true), targets, profile, max_s);
        let missed: Vec<usize> = (0..targets.len()).filter(|&i| out[i].is_none()).collect();
        if !missed.is_empty() && ends.doors.iter().any(|j| j.penalty_m > 0.0) {
            let sub: Vec<Snap> = missed.iter().map(|&i| targets[i]).collect();
            for (k, c) in router.many_to_many(&srcs(&ends.doors, false), &sub, profile, max_s).into_iter().enumerate() {
                out[missed[k]] = c;
            }
        }
        if out.iter().any(|c| c.is_some()) || ends.fallback.is_none() {
            return out;
        }
    }
    if let Some(f) = &ends.fallback {
        out = router.many_to_many(&srcs(std::slice::from_ref(f), false), targets, profile, max_s);
    }
    out
}

/// A walk between two ends: through which way onto the network at each, and the path between.
pub struct Walk {
    pub from: Join,
    pub to: Join,
    pub path: WalkPath,
    /// Seconds, the metres to the network included.
    pub secs: f32,
}

/// The best walk between two ends: every door at one end against every door at the other (the eight best of
/// each), by walking time plus the doors' penalties. With `budget_s` (the time a journey planned the walk with),
/// the best one within that time, else the quickest. When no door at an end leads anywhere, straight from the
/// point there.
pub fn best_walk(router: &WalkRouter, a: &Ends, b: &Ends, profile: &WalkProfile, budget_s: Option<f32>) -> Option<Walk> {
    let speed = profile.speed_mps.max(0.05);
    let run = |xs: &[Join], ys: &[Join]| -> Vec<(f32, Walk)> {
        let mut found = Vec::new();
        for x in xs {
            for y in ys {
                if let Some(path) = router.route(&x.snap, &y.snap, profile) {
                    let secs = path.cost.secs(speed) + (x.extra_m + y.extra_m) / speed;
                    found.push((secs + (x.penalty_m + y.penalty_m) / speed, Walk { from: *x, to: *y, path, secs }));
                }
            }
        }
        found
    };
    let (fa, fb) = (a.first(), b.first());
    let mut found = run(&fa, &fb);
    if found.is_empty() {
        // no door leads anywhere: straight from the point where there is one
        let alt = |e: &Ends, f: &Vec<Join>| if e.doors.is_empty() { f.clone() } else { e.fallback.into_iter().collect() };
        let (ga, gb) = (alt(a, &fa), alt(b, &fb));
        found = run(&ga, &fb);
        if found.is_empty() {
            found = run(&fa, &gb);
        }
        if found.is_empty() {
            found = run(&ga, &gb);
        }
    }
    let within = |w: &Walk| budget_s.is_none_or(|t| w.secs <= t + 1.0);
    if found.iter().any(|f| within(&f.1)) {
        found.retain(|f| within(&f.1));
        found.into_iter().min_by(|x, y| x.0.total_cmp(&y.0)).map(|f| f.1)
    } else {
        found.into_iter().min_by(|x, y| x.1.secs.total_cmp(&y.1.secs)).map(|f| f.1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kante_osm::buildings::{BuildingRaw, EntranceRaw};
    use std::sync::Arc;

    #[test]
    fn addresses_merge() {
        assert_eq!(merge_addr("Bahnhofstrasse 12", "Bahnhofstrasse 12a"), "Bahnhofstrasse 12, 12a");
        assert_eq!(merge_addr("Bahnhofstrasse 12, 12a", "Bahnhofstrasse 14"), "Bahnhofstrasse 12, 12a, 14");
        assert_eq!(merge_addr("Bahnhofstrasse 12", "Gartenweg 1"), "Bahnhofstrasse 12, Gartenweg 1");
    }

    #[test]
    fn geometry() {
        let sq = vec![vec![(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]];
        assert!(inside((5.0, 5.0), &sq));
        assert!(!inside((15.0, 5.0), &sq));
        let court = vec![sq[0].clone(), vec![(4.0, 4.0), (6.0, 4.0), (6.0, 6.0), (4.0, 6.0)]];
        assert!(!inside((5.0, 5.0), &court), "a courtyard is not the building");
        assert!(cuts_segment((5.0, 5.0), (15.0, 5.0), (10.0, 0.0), (10.0, 10.0)));
        assert!(!cuts_segment((11.0, 5.0), (15.0, 5.0), (10.0, 0.0), (10.0, 10.0)));
        assert!((outline_dist((5.0, 5.0), &sq) - 5.0).abs() < 1e-4);
        // a line through a rail's vertex crosses it, whether the rail has a node there or not
        assert!(hit((0.0, -5.0), (0.0, 5.0), (-10.0, 0.0), (10.0, 0.0)).is_some());
        assert!(hit((0.0, -5.0), (0.0, 5.0), (-10.0, 0.0), (0.0, 0.0)).is_some());
        assert!(hit((0.0, -5.0), (0.0, 5.0), (0.0, 0.0), (10.0, 0.0)).is_some());
    }

    // ---- a small world in metres
    fn pt(x: f32, y: f32) -> LatLon {
        LatLon::from_xy(x, y)
    }
    #[derive(Default)]
    struct World {
        g: WalkGraph,
        x: OsmExtract,
        b: BuildingsRaw,
    }
    impl World {
        fn new() -> World {
            let mut w = World::default();
            w.g.names.push(String::new());
            w.x.carriageway_names.push(String::new());
            w
        }
        fn node(&mut self, x: f32, y: f32) -> u32 {
            self.g.nodes.push(pt(x, y));
            self.g.node_flags.push(0);
            self.g.nodes.len() as u32 - 1
        }
        fn edge(&mut self, a: u32, b: u32, kind: EdgeKind, flags: u16) -> u32 {
            let off = self.g.geom.len() as u32;
            let (pa, pb) = (self.g.nodes[a as usize], self.g.nodes[b as usize]);
            self.g.geom.extend([pa, pb]);
            self.g.edges.push(WalkEdge { a, b, geom_off: off, geom_len: 2, kind, level_a: LEVEL_NONE, level_b: LEVEL_NONE, steps: 0, flags, len_dm: (pa.dist_m(&pb) * 10.0).round() as u32, name: 0 });
            self.g.edge_way.push(self.g.edges.len() as i64);
            self.g.edges.len() as u32 - 1
        }
        /// A way from a to b in `n` edges; returns its nodes.
        fn way(&mut self, a: (f32, f32), b: (f32, f32), n: usize, kind: EdgeKind, flags: u16) -> Vec<u32> {
            let ns: Vec<u32> = (0..=n).map(|i| self.node(a.0 + (b.0 - a.0) * i as f32 / n as f32, a.1 + (b.1 - a.1) * i as f32 / n as f32)).collect();
            for w in ns.windows(2) {
                self.edge(w[0], w[1], kind, flags);
            }
            ns
        }
        fn building(&mut self, x0: f32, y0: f32, x1: f32, y1: f32) -> u32 {
            self.b.buildings.push(BuildingRaw { outer: vec![pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)], holes: vec![] });
            self.b.buildings.len() as u32 - 1
        }
        fn door(&mut self, b: u32, x: f32, y: f32, kind: DoorKind, wheelchair: u8) {
            self.b.entrances.push(EntranceRaw { pos: pt(x, y), building: b, kind, wheelchair, addr: format!("Door {}", self.b.entrances.len()) });
        }
        fn rail(&mut self, pts: &[(f32, f32)], off_ground: bool) {
            let off = self.x.carriageway_geom.len() as u32;
            self.x.carriageway_geom.extend(pts.iter().map(|&(x, y)| pt(x, y)));
            self.x.carriageways.push(Carriageway { kind: CarriagewayKind::RailTrack, geom_off: off, geom_len: pts.len() as u16, name: 0, off_ground });
        }
        fn finish(mut self) -> (WalkRouter, DoorIndex) {
            let n = self.g.nodes.len();
            let mut off = vec![0u32; n + 1];
            for ed in &self.g.edges {
                off[ed.a as usize + 1] += 1;
                off[ed.b as usize + 1] += 1;
            }
            for i in 1..=n {
                off[i] += off[i - 1];
            }
            let mut adj = vec![0u32; off[n] as usize];
            let mut cur = off.clone();
            for (e, ed) in self.g.edges.iter().enumerate() {
                for node in [ed.a, ed.b] {
                    adj[cur[node as usize] as usize] = e as u32;
                    cur[node as usize] += 1;
                }
            }
            self.g.adj_off = off;
            self.g.adj = adj;
            let router = WalkRouter::new(Arc::new(self.g));
            let (doors, _) = build(&self.b, &[], &router, &self.x);
            (router, DoorIndex::new(doors))
        }
    }
    const NORMAL: WalkProfile = WalkProfile::normal(1.3);
    const STEP_FREE: WalkProfile = WalkProfile::step_free(1.3);
    fn snap(r: &WalkRouter, x: f32, y: f32, p: &WalkProfile) -> Snap {
        r.snap(pt(x, y), &SnapOptions { max_dist_m: 100.0, level: None, profile: Some(*p), exclude_kinds: NO_STEP }).unwrap()
    }
    fn at_stop(s: Snap) -> Ends {
        Ends { doors: vec![], fallback: Some(Join { snap: s, extra_m: 0.0, penalty_m: 0.0, door: None }) }
    }

    #[test]
    fn a_door_on_a_path_a_wheelchair_cannot_take_is_not_offered_and_the_walk_still_reaches_the_stop() {
        // a house (0..20 × 10..30) behind another one (-50..25 × 1..9): its only door's way out is a wheelchair=no
        // path round the front house to the street at y = 0, where the stop is
        let mut w = World::new();
        w.way((-200.0, 0.0), (200.0, 0.0), 20, EdgeKind::Sidewalk, 0);
        w.way((10.0, 10.0), (30.0, 9.5), 1, EdgeKind::Footway, EF_WHEELCHAIR_NO);
        w.way((30.0, 9.5), (30.0, 0.0), 1, EdgeKind::Footway, EF_WHEELCHAIR_NO);
        let b = w.building(0.0, 10.0, 20.0, 30.0);
        w.door(b, 10.0, 10.0, DoorKind::Main, DOOR_WC_UNKNOWN);
        w.building(-50.0, 1.0, 25.0, 9.0);
        let (r, ix) = w.finish();
        let home = pt(10.0, 20.0);
        assert!(!ix.choice(&r, home, &NORMAL).opts.is_empty());
        let c = ix.choice(&r, home, &STEP_FREE);
        assert!(c.opts.is_empty() && c.in_building, "the door's only way is closed to a wheelchair");
        let ends = Ends::new(&c, Some(snap(&r, 10.0, 20.0, &STEP_FREE)));
        let stop = snap(&r, 50.0, 0.0, &STEP_FREE);
        assert!(reach_costs(&r, &ends, &[stop], &STEP_FREE, 600.0)[0].is_some(), "the stop 50 m away is still reached");
        assert!(best_walk(&r, &ends, &at_stop(stop), &STEP_FREE, None).is_some());
    }

    #[test]
    fn a_door_penalty_does_not_use_up_the_time_allowed() {
        // the only door is an emergency exit (200 m penalty); the stop is 40 m away and 60 s are allowed
        let mut w = World::new();
        w.way((-200.0, 0.0), (200.0, 0.0), 20, EdgeKind::Sidewalk, 0);
        let b = w.building(0.0, 1.0, 20.0, 20.0);
        w.door(b, 10.0, 1.0, DoorKind::Emergency, DOOR_WC_UNKNOWN);
        let (r, ix) = w.finish();
        let ends = Ends::new(&ix.choice(&r, pt(10.0, 5.0), &NORMAL), None);
        assert!(!ends.doors.is_empty());
        let stop = snap(&r, 50.0, 0.0, &NORMAL);
        let c = reach_costs(&r, &ends, &[stop], &NORMAL, 60.0)[0].expect("reached");
        assert!(c.secs(1.3) < 60.0, "{c:?}");
    }

    #[test]
    fn the_door_within_the_time_allowed_counts_even_when_another_is_preferred() {
        // from (-160, 10) the main door at -182 leads to the stop at 0 in ~207 m (159 s), the garage door at -140
        // in ~163 m (125 s) but carries a 120 m (92 s) penalty, so the main door is preferred. 130 s allowed.
        let mut w = World::new();
        w.way((-300.0, 0.0), (300.0, 0.0), 30, EdgeKind::Sidewalk, 0);
        let b = w.building(-200.0, 1.0, 200.0, 20.0);
        w.door(b, -182.0, 1.0, DoorKind::Main, DOOR_WC_UNKNOWN);
        w.door(b, -140.0, 1.0, DoorKind::Garage, DOOR_WC_UNKNOWN);
        let (r, ix) = w.finish();
        let ends = Ends::new(&ix.choice(&r, pt(-160.0, 10.0), &NORMAL), None);
        let stop = snap(&r, 0.0, 0.0, &NORMAL);
        let c = reach_costs(&r, &ends, &[stop], &NORMAL, 130.0)[0];
        assert!(c.is_some_and(|c| c.secs(1.3) <= 130.0), "reached through the garage door: {c:?}");
        // and the walk planned with that time goes through the door that fits it
        let walk = best_walk(&r, &ends, &at_stop(stop), &NORMAL, Some(c.unwrap().secs(1.3))).unwrap();
        assert_eq!(walk.from.door.map(|d| ix.doors.doors[d.door as usize].kind), Some(DoorKind::Garage));
        // without a time to keep to, the main door
        let free = best_walk(&r, &ends, &at_stop(stop), &NORMAL, None).unwrap();
        assert_eq!(free.from.door.map(|d| ix.doors.doors[d.door as usize].kind), Some(DoorKind::Main));
    }

    #[test]
    fn every_pair_of_doors_is_tried() {
        // five doors at each end; at the far end the first four open onto a path joined to nothing
        let mut w = World::new();
        w.way((-100.0, 0.0), (300.0, 0.0), 20, EdgeKind::Sidewalk, 0);
        w.way((180.0, 45.0), (280.0, 45.0), 10, EdgeKind::Footway, 0);
        let a = w.building(0.0, 1.0, 50.0, 20.0);
        for i in 0..5 {
            w.door(a, 5.0 + 10.0 * i as f32, 1.0, DoorKind::Yes, DOOR_WC_UNKNOWN);
        }
        let b = w.building(180.0, 2.0, 280.0, 44.0);
        for i in 0..4 {
            w.door(b, 190.0 + 20.0 * i as f32, 44.0, DoorKind::Main, DOOR_WC_UNKNOWN);
        }
        w.door(b, 270.0, 2.0, DoorKind::Yes, DOOR_WC_UNKNOWN);
        let (r, ix) = w.finish();
        let ea = Ends::new(&ix.choice(&r, pt(25.0, 10.0), &NORMAL), None);
        let eb = Ends::new(&ix.choice(&r, pt(230.0, 23.0), &NORMAL), None);
        assert!(ea.doors.len() >= 5 && eb.doors.len() >= 5, "{} {}", ea.doors.len(), eb.doors.len());
        let walk = best_walk(&r, &ea, &eb, &NORMAL, None).expect("a route through the fifth door");
        assert_eq!(walk.to.door.map(|d| ix.doors.doors[d.door as usize].kind), Some(DoorKind::Yes));
    }

    #[test]
    fn doors_are_joined_by_the_cheapest_way_never_through_their_own_house_or_across_a_track_on_the_ground() {
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
        let (r, ix) = w.finish();
        let g = r.graph();
        let front = ix.doors.attach_of(0);
        assert_eq!(g.edges[front[0].edge as usize].kind, EdgeKind::Sidewalk, "the sidewalk before the main roads");
        let back = ix.doors.attach_of(1);
        assert!(back.iter().all(|a| a.through()) && !back.is_empty(), "the back door is joined through the house only as a marked guess");
        assert!(front.iter().all(|a| !a.through()));
        let c = ix.choice(&r, pt(0.0, 10.0), &NORMAL);
        assert!(!c.opts[0].through, "the door with a real way out comes first");
        assert!(ix.doors.attach_of(2).is_empty(), "not across the track, even at its node (nor through the house to it)");
        assert!(!ix.doors.attach_of(3).is_empty(), "a track in a tunnel does not block the door");
        // a building whose doors cannot be joined is still known: a walk into it is a guess
        assert!(ix.choice(&r, pt(210.0, 20.0), &NORMAL).in_building);
    }

    #[test]
    fn an_index_belongs_to_its_graph() {
        let mut w = World::new();
        w.way((0.0, 0.0), (100.0, 0.0), 2, EdgeKind::Sidewalk, 0);
        let mut v = World::new();
        v.way((0.0, 0.0), (100.0, 10.0), 2, EdgeKind::Sidewalk, 0);
        let (rw, iw) = w.finish();
        let (rv, _) = v.finish();
        assert_eq!(rw.graph().edges.len(), rv.graph().edges.len());
        assert!(iw.fits(rw.graph()) && !iw.fits(rv.graph()), "the same size, other edges: not this index's graph");
    }
}
