//! Doors: where a walk that starts in or ends at a building leaves or enters it.
//!
//! [`build`] makes [`Doors`] from the buildings and mapped entrances of
//! OpenStreetMap ([`kante_osm::buildings`]) and the official building address
//! register ([`crate::register`]); [`DoorIndex`] answers "which buildings is
//! this point in" at query time. The rules are the ones the browser's walking
//! network used (`docs/walking-routes.md`):
//!
//! - A building's doors are its mapped entrances. A building with none gets a
//!   door at each register address that belongs to it: the address point is
//!   in it, or its outline is the nearest within 8 m. The point is put on the
//!   nearest stretch of outline (within 12 m) that faces the open — 1 m out
//!   from that wall is neither this building nor another one, so never a wall
//!   shared with the house next door. Two addresses within 2 m are one door
//!   ("Bahnhofstrasse 12, 12a").
//! - A door is joined to the walking network by straight lines of up to 80 m
//!   to the nearest walkable edges (no stairs, escalators, lifts or
//!   underpasses). A line may not cut through another building (except one
//!   whose arcade the edge runs under) nor cross a railway track. Up to two
//!   are kept, cheapest first (a road whose sidewalks are not mapped counts
//!   4 × its distance); a door already on the network keeps just that one.

use crate::register::Address;
use kante_core::geo::LatLon;
use kante_core::walk::*;
use kante_osm::buildings::BuildingsRaw;
use kante_walk::{SnapOptions, WalkRouter};
use rayon::prelude::*;
use rustc_hash::FxHashMap;

const CELL: f32 = 50.0;
const ATTACH_MAX_M: f32 = 80.0;
const MAX_ATTACH: usize = 2;

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

fn inside(p: P, ring: &[P]) -> bool {
    let mut c = false;
    let n = ring.len();
    let mut j = n - 1;
    for i in 0..n {
        let ((x1, y1), (x2, y2)) = (ring[i], ring[j]);
        if (y1 > p.1) != (y2 > p.1) && p.0 < (x2 - x1) * (p.1 - y1) / (y2 - y1) + x1 {
            c = !c;
        }
        j = i;
    }
    c
}

fn orient(o: P, a: P, b: P) -> f32 {
    (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0)
}

/// Proper crossing of p–q and u–v (touching does not count).
fn crosses(p: P, q: P, u: P, v: P) -> bool {
    let (d1, d2, d3, d4) = (orient(u, v, p), orient(u, v, q), orient(p, q, u), orient(p, q, v));
    ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0)) && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0))
}

/// Nearest point of segment a–b to p: (distance, point, t).
fn project(p: P, a: P, b: P) -> (f32, P, f32) {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 1e-9 { (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    let q = (a.0 + dx * t, a.1 + dy * t);
    (((p.0 - q.0).powi(2) + (p.1 - q.1).powi(2)).sqrt(), q, t)
}

fn outline_dist(p: P, ring: &[P]) -> f32 {
    (0..ring.len()).map(|i| project(p, ring[i], ring[(i + 1) % ring.len()]).0).fold(f32::INFINITY, f32::min)
}

/// Planar rings of all buildings, with a grid for lookups.
struct Plan {
    rings: Vec<Vec<P>>,
    grid: BoxGrid,
}

impl Plan {
    fn new(raw: &BuildingsRaw) -> Self {
        let rings: Vec<Vec<P>> = (0..raw.len() as u32).into_par_iter().map(|b| raw.ring_of(b).iter().map(|p| p.xy()).collect()).collect();
        let mut grid = BoxGrid::default();
        for (i, r) in rings.iter().enumerate() {
            let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
            for &(x, y) in r {
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
    /// Does p–q cut the outline of a building not in `allow`?
    fn cuts(&self, p: P, q: P, allow: &[u32], scratch: &mut Vec<u32>) -> bool {
        let (mx, my) = ((p.0 + q.0) / 2.0, (p.1 + q.1) / 2.0);
        let half = ((p.0 - q.0).powi(2) + (p.1 - q.1).powi(2)).sqrt() / 2.0;
        self.grid.around(mx, my, half + 1.0, scratch);
        scratch.iter().any(|&b| {
            if allow.contains(&b) {
                return false;
            }
            let r = &self.rings[b as usize];
            (0..r.len()).any(|i| crosses(p, q, r[i], r[(i + 1) % r.len()]))
        })
    }
    fn buildings_at(&self, p: P, scratch: &mut Vec<u32>) -> Vec<u32> {
        self.grid.around(p.0, p.1, 0.0, scratch);
        scratch.iter().copied().filter(|&b| inside(p, &self.rings[b as usize])).collect()
    }
}

/// Ground-level railway tracks, segment by segment, for the "never across the tracks" rule.
struct Rails {
    segs: Vec<(P, P)>,
    grid: BoxGrid,
}

impl Rails {
    fn new(x: &OsmExtract) -> Self {
        let mut segs = Vec::new();
        for c in x.carriageways.iter().filter(|c| c.kind == CarriagewayKind::RailTrack) {
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
            crosses(p, q, u, v)
        })
    }
}

/// The point on the building's outline facing the open nearest to `q` (within 12 m).
fn facade_point(plan: &Plan, b: u32, q: P, scratch: &mut Vec<u32>) -> Option<P> {
    let ring = &plan.rings[b as usize];
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
        let sides: Vec<P> = [(probe.0 + nx, probe.1 + ny), (probe.0 - nx, probe.1 - ny)].into_iter().filter(|o| !inside(*o, ring)).collect();
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
    let g = router.graph();
    let attach: Vec<Vec<DoorAttach>> = doors
        .par_iter()
        .map_init(Vec::new, |scratch, d| {
            let opts = SnapOptions { max_dist_m: ATTACH_MAX_M, level: Some(0), profile: None, exclude_kinds: NO_STEP };
            let p = d.pos.xy();
            let mut allow = plan.buildings_at(p, scratch);
            allow.push(d.building);
            let mut out: Vec<(f32, DoorAttach)> = Vec::new();
            for s in router.snap_candidates(d.pos, &opts, 32) {
                let ed = &g.edges[s.edge as usize];
                // never straight into an underpass below the door
                if ed.flags & EF_TUNNEL != 0 && ed.flags & EF_COVERED == 0 {
                    continue;
                }
                if out.iter().any(|(_, a)| a.edge == s.edge) {
                    continue;
                }
                let q = s.pos.xy();
                if s.dist_m > 0.5 {
                    let mut ok_bld = allow.clone();
                    if ed.flags & EF_COVERED != 0 {
                        // an arcade is open to the street: the building it runs under does not block the line
                        let mut s2 = Vec::new();
                        ok_bld.extend(plan.buildings_at(q, &mut s2));
                        plan.grid.around(q.0, q.1, 5.0, &mut s2);
                        ok_bld.extend(s2.iter().copied().filter(|&b| outline_dist(q, &plan.rings[b as usize]) < 5.0));
                    }
                    if plan.cuts(p, q, &ok_bld, scratch) || rails.cuts(p, q, scratch) {
                        continue;
                    }
                }
                let f = if ed.kind == EdgeKind::RoadBusy { 4.0 } else { 1.0 };
                out.push((s.dist_m * f, DoorAttach { edge: s.edge, frac: s.frac, dist_m: s.dist_m }));
                if s.dist_m <= 0.5 || out.len() >= MAX_ATTACH {
                    break;
                }
            }
            out.sort_by(|a, b| a.0.total_cmp(&b.0));
            out.into_iter().map(|x| x.1).collect()
        })
        .collect();

    // ---- only buildings with a door that can be reached
    let mut order: Vec<usize> = (0..doors.len()).filter(|&i| !attach[i].is_empty()).collect();
    st.unattached = doors.len() - order.len();
    order.sort_by_key(|&i| doors[i].building);
    let mut out = Doors::default();
    let mut k = 0;
    while k < order.len() {
        let b = doors[order[k]].building;
        let mut end = k;
        while end < order.len() && doors[order[end]].building == b {
            end += 1;
        }
        let ring = raw.ring_of(b);
        let packed = Doors::pack_ring(ring[0], ring).filter(|r| r.len() <= u16::MAX as usize && end - k <= u16::MAX as usize);
        let Some(packed) = packed else {
            k = end;
            continue;
        };
        out.buildings.push(DoorBuilding { origin: ring[0], ring_off: out.ring.len() as u32, ring_len: packed.len() as u16, door_off: out.doors.len() as u32, door_len: (end - k) as u16 });
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
    out.graph_edges = g.edges.len() as u32;
    st.buildings_with_doors = out.buildings.len();
    (out, st)
}

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
            for p in doors.ring_of(b) {
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
    /// The buildings (with doors) that `p` is inside.
    pub fn buildings_at(&self, p: LatLon) -> Vec<u32> {
        let q = p.xy();
        let mut cand = self.grid.at(q.0, q.1).to_vec();
        cand.retain(|&b| {
            let ring: Vec<P> = self.doors.ring_of(b).map(|x| x.xy()).collect();
            inside(q, &ring)
        });
        cand
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
    fn geometry() {
        let sq = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        assert!(inside((5.0, 5.0), &sq));
        assert!(!inside((15.0, 5.0), &sq));
        assert!(crosses((5.0, 5.0), (15.0, 5.0), (10.0, 0.0), (10.0, 10.0)));
        assert!(!crosses((11.0, 5.0), (15.0, 5.0), (10.0, 0.0), (10.0, 10.0)));
        assert!((outline_dist((5.0, 5.0), &sq) - 5.0).abs() < 1e-4);
    }
}
