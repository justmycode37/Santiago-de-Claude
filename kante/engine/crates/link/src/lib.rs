//! Joins the timetable to the walking network.
//!
//! For every timetable Stop (boarding point) this crate decides
//!
//! 1. **where on the pedestrian network it is** ([`StopLink::snap`], `level`),
//! 2. **which side of the road or track it is on** ([`SideInfo`]),
//! 3. **which other Stops can be walked to** ([`Footpaths`]), once for an
//!    unrestricted walker and once step-free, as speed-independent
//!    `var_m`/`fix_s` pairs.
//!
//! The registry SLOID stays the identity of a boarding point; OSM only
//! contributes geometry. Labels are never invented or changed here.
//!
//! # 1. Where a stop stands
//!
//! **Which OSM object** ([`LinkMatch`]): the platform object with the same
//! `ref:sloid` within 150 m (`Sloid`); else an object of a compatible mode
//! whose `ref` equals the stop's sign label — a combined label such as
//! "41/42" matches either part — within 80 m (rail) / 60 m (others), 15 m if
//! its `uic_ref` names another station (`Label`); else an unsigned platform
//! object within 20 m. Platform ways beat platform nodes beat stop positions,
//! then the nearer one wins.
//!
//! **Where on the network**:
//!
//! - A platform way or area that is part of the network: the nearest point of
//!   *its own* edges. This is what puts track 7 on platform 7/8, the RBS
//!   tracks on level −2 and the PostAuto bays on the deck.
//! - Otherwise (platform node, stop position, `railway=platform_edge` line,
//!   no object at all) the best *standing place* near the pole — the registry
//!   coordinate, or the matched OSM platform node where that gives the better
//!   place (it is handicapped by 0.3 × its distance from the registry point,
//!   since a `highway=bus_stop` node may sit on the lane) — on the object's
//!   level (untagged = ground: a street stop is never dropped into
//!   the underpass below it). Candidates are the nearest edges within 30 m,
//!   then 80 m, as a last resort 200 m; stairs, escalators and lifts are
//!   never used. The best candidate has the lowest
//!
//!   ```text
//!   distance + ½·(distance beyond 10 m) + kind + crossing
//!   ```
//!
//!   `kind`: platform −6 m for rail/tram stops and −2 m otherwise (+8 m if
//!   the platform belongs to another mode — a bus stop does not wait on the
//!   railway platform next to it); sidewalk,
//!   footway, pedestrian area, corridor 0; path +4; road +9 (+5 with a
//!   tagged sidewalk); main road +14 (+8); crossing +12. So a pavement a few
//!   metres away beats the carriageway the registry point may lie on, but a
//!   stop on a road without any mapped pavement stays on that road instead of
//!   moving to a path 30 m away (the old rule did that for about 1 600 stops).
//!   `crossing`: +25 m if the straight line from the pole to the candidate
//!   crosses a road centre line, +30 m for a tram track, +60 m for a railway —
//!   a stop does not hop to the pavement across the street or the platform
//!   across the tracks while there is anything on its own side. (Lines within
//!   1.5 m of the pole are ignored: a registry point on the centre line has
//!   no side. A tram stop whose point lies on the track is boarded from the
//!   street; for it road lanes do not count.)
//! - Edges of the main network are preferred over isolated fragments.
//!
//! # 2. Side of the road
//!
//! The reference line is the nearest line of the stop's own kind: railway
//! (25 m) for trains, tram track (15 m) then road (30 m) for trams, road
//! (30 m) for buses; road tunnels are skipped when a surface road is in
//! reach. The side is the *perpendicular* one — the line's bearing ± 90°,
//! named with eight compass words; a street running north-east has a
//! north-west and a south-east side, which four words could not say. It is
//! judged from the registry point when that is at least 2 m off the line.
//! The standing point is used instead when the stop was matched to an OSM
//! platform by id or label, and as a fallback when a boarding point with its
//! own coordinate stands by an OSM platform object within 12 m. Otherwise a
//! registry point on the centre line has no side: the nearest pavement to it
//! is a coin flip.
//!
//! `street` is only filled when the statement is true for the whole street:
//! the stop lies on that same side of every carriageway carrying the name
//! within 40 m (a dual carriageway has two). For a tram stop the line is the
//! track and the name that of the road within 25 m, under the same test;
//! railway stops never get a street. A stop between two tracks (island
//! platform) has no side.
//!
//! # 3. Footpaths
//!
//! For each stop, a bounded search to every linked stop within reach, plus
//! the registry-to-network distances at both ends. Where no walk is found, a
//! pair in the same station (≤ 450 m apart) or with an unlinked end (≤ 250 m)
//! gets an estimate of 1.5 × beeline + 10 m, so a change inside a station is
//! never lost. In the step-free set such an estimate is never better than the
//! unrestricted walk and, where the unrestricted walk exists (the map shows
//! only stairs), carries two lift rides. These estimates are *not verified*
//! step-free; the walk router finds no path for them.
//!
//! # 4. Buildings, doors and the ends of a walk
//!
//! [`doors`] builds every building and its doors (mapped entrances, else points
//! of the official building address register from [`register`]); [`ends`]
//! decides where a walk from or to a place joins the network, for the stop
//! search and the walk drawn alike. Rules: `kante/docs/WALK-ENDS.md`.

pub mod doors;
pub mod ends;
pub mod register;
#[cfg(test)]
mod test_world;

use kante_core::geo::{self, project_on_segment, BBox, LatLon};
use kante_core::*;
use kante_walk::{SnapOptions, WalkRouter};
use rayon::prelude::*;
use rustc_hash::{FxHashMap, FxHashSet};

pub struct LinkOptions {
    /// Footpaths are computed up to this walking time at `DEFAULT_SPEED_MPS`.
    pub max_transfer_s: f32,
}

impl Default for LinkOptions {
    fn default() -> Self {
        LinkOptions { max_transfer_s: 720.0 }
    }
}

const fn kind_bit(k: EdgeKind) -> u32 {
    1 << k as u8
}
const VERTICAL: u32 = kind_bit(EdgeKind::Steps) | kind_bit(EdgeKind::Escalator) | kind_bit(EdgeKind::Lift);

/// Cell key for a planar grid.
fn cell_key(x: f32, y: f32, cell: f32) -> u64 {
    let cx = (x / cell).floor() as i64 + (1 << 30);
    let cy = (y / cell).floor() as i64 + (1 << 30);
    ((cx as u64) << 32) | cy as u64
}

struct Grid {
    cell: f32,
    map: FxHashMap<u64, Vec<u32>>,
}

impl Grid {
    fn new(points: impl Iterator<Item = (u32, LatLon)>, cell: f32) -> Grid {
        let mut map: FxHashMap<u64, Vec<u32>> = FxHashMap::default();
        for (i, p) in points {
            if p.is_none() {
                continue;
            }
            let (x, y) = p.xy();
            map.entry(cell_key(x, y, cell)).or_default().push(i);
        }
        Grid { cell, map }
    }
    fn around(&self, p: &LatLon, radius: f32, mut f: impl FnMut(u32)) {
        let (x, y) = p.xy();
        let r = radius * 1.03 + 1.0; // planar frame is up to 2 % off
        let (x0, x1) = (((x - r) / self.cell).floor() as i64, ((x + r) / self.cell).floor() as i64);
        let (y0, y1) = (((y - r) / self.cell).floor() as i64, ((y + r) / self.cell).floor() as i64);
        for cx in x0..=x1 {
            for cy in y0..=y1 {
                let key = (((cx + (1 << 30)) as u64) << 32) | (cy + (1 << 30)) as u64;
                if let Some(v) = self.map.get(&key) {
                    v.iter().for_each(|&i| f(i));
                }
            }
        }
    }
}

/// Nearest point of an edge polyline to `p`: (fraction of the edge length from node a, point, distance).
fn project_on_edge(g: &WalkGraph, e: u32, p: &LatLon) -> (f32, LatLon, f32) {
    let geom = g.edge_geom(e);
    let mut best = (0.0f32, geom[0], f32::MAX);
    let mut walked = 0.0f32;
    let mut total = 0.0f32;
    for w in geom.windows(2) {
        let seg = w[0].dist_m(&w[1]);
        let (t, d) = project_on_segment(p, &w[0], &w[1]);
        if d < best.2 {
            best = (walked + t * seg, w[0].lerp(&w[1], t), d);
        }
        walked += seg;
        total += seg;
    }
    if best.2 == f32::MAX {
        best.2 = geom[0].dist_m(p);
    }
    (if total > 0.0 { (best.0 / total).clamp(0.0, 1.0) } else { 0.0 }, best.1, best.2)
}

fn modes_compatible(stop_modes: u16, osm_modes: u8) -> bool {
    if osm_modes == 0 || stop_modes == 0 {
        return true;
    }
    let mut want = 0u8;
    if stop_modes & (Mode::Bus.bit() | Mode::OnDemand.bit()) != 0 {
        want |= 1;
    }
    if stop_modes & Mode::Tram.bit() != 0 {
        want |= 2 | 8;
    }
    if stop_modes & (Mode::Rail.bit() | Mode::RackRail.bit()) != 0 {
        want |= 4 | 8;
    }
    if stop_modes & Mode::Metro.bit() != 0 {
        want |= 8 | 4 | 2;
    }
    if stop_modes & Mode::Boat.bit() != 0 {
        want |= 16;
    }
    if stop_modes & (Mode::Funicular.bit() | Mode::Cableway.bit() | Mode::Lift.bit()) != 0 {
        want |= 32 | 4;
    }
    want == 0 || want & osm_modes != 0
}

/// Does a sign label match one of an OSM object's refs? A combined label
/// ("41/42", "A/B") matches if any of its parts does.
fn label_matches(label: &str, refs: &[String]) -> bool {
    !label.is_empty() && label.split('/').map(str::trim).filter(|p| !p.is_empty()).any(|part| refs.iter().any(|r| r.eq_ignore_ascii_case(part)))
}

fn kind_rank(k: PlatformKind) -> u8 {
    match k {
        PlatformKind::PlatformWay => 0,
        PlatformKind::PlatformNode => 1,
        PlatformKind::StopPosition => 2,
    }
}

struct PlatformIndex<'a> {
    extract: &'a OsmExtract,
    graph: &'a WalkGraph,
    by_sloid: FxHashMap<&'a str, Vec<u32>>,
    /// Walk edge → the platform way it belongs to.
    by_edge: FxHashMap<u32, u32>,
    grid: Grid,
}

impl<'a> PlatformIndex<'a> {
    fn new(extract: &'a OsmExtract, graph: &'a WalkGraph) -> Self {
        let mut by_sloid: FxHashMap<&str, Vec<u32>> = FxHashMap::default();
        for (i, p) in extract.platforms.iter().enumerate() {
            if !p.sloid.is_empty() {
                by_sloid.entry(p.sloid.as_str()).or_default().push(i as u32);
            }
        }
        let mut by_edge: FxHashMap<u32, u32> = FxHashMap::default();
        for (i, p) in extract.platforms.iter().enumerate() {
            for &e in &p.edges {
                by_edge.insert(e, i as u32);
            }
        }
        let grid = Grid::new(extract.platforms.iter().enumerate().map(|(i, p)| (i as u32, p.pos)), 200.0);
        PlatformIndex { extract, graph, by_sloid, by_edge, grid }
    }

    /// Distance from `p` to the platform: to its outline for mapped ways, to the point otherwise.
    fn distance(&self, pi: u32, p: &LatLon) -> f32 {
        let pl = &self.extract.platforms[pi as usize];
        if pl.kind == PlatformKind::PlatformWay && !pl.edges.is_empty() {
            pl.edges.iter().map(|&e| project_on_edge(self.graph, e, p).2).fold(f32::MAX, f32::min)
        } else {
            pl.pos.dist_m(p)
        }
    }

    /// Pick the OSM object that represents `stop`, if any.
    fn find(&self, stop: &Stop, didok: u32) -> Option<(u32, LinkMatch)> {
        let better = |a: (u8, f32), b: (u8, f32)| a.0 < b.0 || (a.0 == b.0 && a.1 < b.1);

        // 1. Same registry id.
        if let Some(list) = self.by_sloid.get(stop.sloid.as_str()) {
            let mut best: Option<(u32, (u8, f32))> = None;
            for &pi in list {
                let d = self.distance(pi, &stop.pos);
                if d > 150.0 {
                    continue; // a mistagged object far away is worse than no match
                }
                let key = (kind_rank(self.extract.platforms[pi as usize].kind), d);
                if best.map_or(true, |b| better(key, b.1)) {
                    best = Some((pi, key));
                }
            }
            if let Some((pi, _)) = best {
                return Some((pi, LinkMatch::Sloid));
            }
        }

        let railish = stop.modes & (Mode::Rail.bit() | Mode::RackRail.bit() | Mode::Metro.bit()) != 0;
        let mut by_label: Option<(u32, (u8, f32))> = None;
        let mut nearest: Option<(u32, (u8, f32))> = None;
        // Long rail platforms have their centroid far from any one point on them.
        let search = if railish { 420.0 } else { 90.0 };
        self.grid.around(&stop.pos, search, |pi| {
            let pl = &self.extract.platforms[pi as usize];
            if !modes_compatible(stop.modes, pl.modes) {
                return;
            }
            if pl.pos.dist_m(&stop.pos) > search {
                return;
            }
            let d = self.distance(pi, &stop.pos);
            let foreign = pl.uic_ref != 0 && didok != 0 && pl.uic_ref != didok;
            let key = (kind_rank(pl.kind), d);
            if label_matches(&stop.label, &pl.refs) {
                let limit = if foreign { 15.0 } else if railish { 80.0 } else { 60.0 };
                if d <= limit && by_label.map_or(true, |b| better(key, b.1)) {
                    by_label = Some((pi, key));
                }
            } else if pl.kind != PlatformKind::StopPosition && !foreign && d <= 20.0 {
                // Only trust plain proximity when the object does not claim to be a different sign.
                let unsigned = pl.refs.is_empty() || stop.label.is_empty();
                if unsigned && nearest.map_or(true, |b| better(key, b.1)) {
                    nearest = Some((pi, key));
                }
            }
        });
        by_label.map(|b| (b.0, LinkMatch::Label)).or(nearest.map(|b| (b.0, LinkMatch::Nearest)))
    }
}

/// Connected components of the walk graph. Mapped platforms are often small
/// islands that share no node with the surrounding footways (ten of the
/// lettered bays at Bern station, for one); a stop snapped onto such an
/// island could not be walked to, so linking prefers the main network.
struct Components {
    /// Component id per node.
    of_node: Vec<u32>,
    /// Number of edges per component.
    edges: Vec<u32>,
}

impl Components {
    fn new(g: &WalkGraph) -> Self {
        let n = g.nodes.len();
        let mut parent: Vec<u32> = (0..n as u32).collect();
        fn find(p: &mut [u32], mut x: u32) -> u32 {
            while p[x as usize] != x {
                p[x as usize] = p[p[x as usize] as usize];
                x = p[x as usize];
            }
            x
        }
        for e in &g.edges {
            let (a, b) = (find(&mut parent, e.a), find(&mut parent, e.b));
            if a != b {
                parent[a.max(b) as usize] = a.min(b);
            }
        }
        let of_node: Vec<u32> = (0..n as u32).map(|i| find(&mut parent, i)).collect();
        let mut edges = vec![0u32; n];
        for e in &g.edges {
            edges[of_node[e.a as usize] as usize] += 1;
        }
        Components { of_node, edges }
    }
    /// Is this edge part of a network big enough to get anywhere?
    fn is_main(&self, g: &WalkGraph, edge: u32) -> bool {
        self.edges[self.of_node[g.edges[edge as usize].a as usize] as usize] >= 150
    }
}

/// Planar metres around `o` (x east, y north); exact enough over a few hundred metres.
#[derive(Clone, Copy)]
struct Local {
    o: LatLon,
    kx: f32,
}

impl Local {
    fn new(o: LatLon) -> Local {
        Local { o, kx: (o.lat_deg().to_radians().cos() * geo::M_PER_DEG_LAT * 1e-7) as f32 }
    }
    #[inline]
    fn xy(&self, p: &LatLon) -> (f32, f32) {
        ((p.lon - self.o.lon) as f32 * self.kx, (p.lat - self.o.lat) as f32 * (geo::M_PER_DEG_LAT * 1e-7) as f32)
    }
}

/// One carriageway segment near a stop, in the stop's local frame.
#[derive(Clone, Copy)]
struct Seg {
    /// Index into `OsmExtract::carriageways`.
    cw: u32,
    kind: CarriagewayKind,
    name: u32,
    a: (f32, f32),
    b: (f32, f32),
}

/// A point projected onto a line.
#[derive(Clone, Copy)]
struct Proj {
    cw: u32,
    name: u32,
    dist: f32,
    /// Bearing of the segment a → b, degrees clockwise from north.
    bearing: f32,
    /// The point is to the left of a → b.
    left: bool,
    /// The foot of the perpendicular lies inside the segment (not at an end).
    inside: bool,
    /// Nearest point on the line.
    at: (f32, f32),
}

impl Proj {
    /// Bearing from the line towards the point, perpendicular to the line.
    fn side_bearing(&self) -> f32 {
        (self.bearing + if self.left { 270.0 } else { 90.0 }).rem_euclid(360.0)
    }
}

fn project(p: (f32, f32), s: &Seg) -> Proj {
    let (dx, dy) = (s.b.0 - s.a.0, s.b.1 - s.a.1);
    let l2 = dx * dx + dy * dy;
    let raw = if l2 <= 1e-6 { 0.0 } else { ((p.0 - s.a.0) * dx + (p.1 - s.a.1) * dy) / l2 };
    let t = raw.clamp(0.0, 1.0);
    let at = (s.a.0 + t * dx, s.a.1 + t * dy);
    let dist = ((p.0 - at.0).powi(2) + (p.1 - at.1).powi(2)).sqrt();
    let cross = dx * (p.1 - s.a.1) - dy * (p.0 - s.a.0);
    Proj { cw: s.cw, name: s.name, dist, bearing: dx.atan2(dy).to_degrees().rem_euclid(360.0), left: cross > 0.0, inside: raw > 0.0 && raw < 1.0, at }
}

fn angle_between(a: f32, b: f32) -> f32 {
    let d = (a - b).rem_euclid(360.0);
    d.min(360.0 - d)
}

/// Carriageway segments (roads, tram tracks, railways) near stops: used to
/// keep a stop on its own side when snapping, and to describe that side.
struct Lines<'a> {
    extract: &'a OsmExtract,
    cell: f32,
    /// cell → (carriageway index, segment index)
    map: FxHashMap<u64, Vec<(u32, u16)>>,
}

impl<'a> Lines<'a> {
    /// Cells indexed around each stop, in each direction.
    const MARGIN: i32 = 2;

    fn new(extract: &'a OsmExtract, stops: &[Stop]) -> Self {
        let cell = 64.0f32;
        let mut wanted: FxHashSet<u64> = FxHashSet::default();
        for s in stops {
            if s.pos.is_none() {
                continue;
            }
            let (x, y) = s.pos.xy();
            for dx in -Self::MARGIN..=Self::MARGIN {
                for dy in -Self::MARGIN..=Self::MARGIN {
                    wanted.insert(cell_key(x + dx as f32 * cell, y + dy as f32 * cell, cell));
                }
            }
        }
        let chunks: Vec<Vec<(u64, (u32, u16))>> = extract
            .carriageways
            .par_iter()
            .enumerate()
            .map(|(ci, cw)| {
                let geom = &extract.carriageway_geom[cw.geom_off as usize..cw.geom_off as usize + cw.geom_len as usize];
                let mut out = Vec::new();
                for (si, w) in geom.windows(2).enumerate() {
                    let (ax, ay) = w[0].xy();
                    let (bx, by) = w[1].xy();
                    let (x0, x1) = ((ax.min(bx) / cell).floor() as i64, (ax.max(bx) / cell).floor() as i64);
                    let (y0, y1) = ((ay.min(by) / cell).floor() as i64, (ay.max(by) / cell).floor() as i64);
                    if (x1 - x0) * (y1 - y0) > 400 {
                        continue; // absurdly long segment; not a street next to a stop
                    }
                    for cx in x0..=x1 {
                        for cy in y0..=y1 {
                            let key = (((cx + (1 << 30)) as u64) << 32) | (cy + (1 << 30)) as u64;
                            if wanted.contains(&key) {
                                out.push((key, (ci as u32, si as u16)));
                            }
                        }
                    }
                }
                out
            })
            .collect();
        let mut map: FxHashMap<u64, Vec<(u32, u16)>> = FxHashMap::default();
        for c in chunks {
            for (k, v) in c {
                map.entry(k).or_default().push(v);
            }
        }
        Lines { extract, cell, map }
    }

    /// Every indexed segment around `p` (about 130 m each way), in `p`'s local frame.
    fn around(&self, p: &LatLon) -> (Local, Vec<Seg>) {
        let frame = Local::new(*p);
        let mut out: Vec<Seg> = Vec::new();
        if p.is_none() {
            return (frame, out);
        }
        let (x, y) = p.xy();
        let mut seen: FxHashSet<(u32, u16)> = FxHashSet::default();
        for dx in -Self::MARGIN..=Self::MARGIN {
            for dy in -Self::MARGIN..=Self::MARGIN {
                let Some(list) = self.map.get(&cell_key(x + dx as f32 * self.cell, y + dy as f32 * self.cell, self.cell)) else { continue };
                for &(ci, si) in list {
                    if !seen.insert((ci, si)) {
                        continue;
                    }
                    let cw = &self.extract.carriageways[ci as usize];
                    let a = self.extract.carriageway_geom[cw.geom_off as usize + si as usize];
                    let b = self.extract.carriageway_geom[cw.geom_off as usize + si as usize + 1];
                    out.push(Seg { cw: ci, kind: cw.kind, name: cw.name, a: frame.xy(&a), b: frame.xy(&b) });
                }
            }
        }
        (frame, out)
    }
}

/// Metres added to a snap candidate that lies across a carriageway from the pole.
/// `in_street`: the pole itself stands in the roadway, so road lanes do not count.
fn crossing_penalty(segs: &[Seg], p: (f32, f32), q: (f32, f32), in_street: bool) -> f32 {
    let (rx, ry) = (q.0 - p.0, q.1 - p.1);
    let len = (rx * rx + ry * ry).sqrt();
    if len < 2.0 {
        return 0.0;
    }
    let mut worst = 0f32;
    for s in segs {
        let (sx, sy) = (s.b.0 - s.a.0, s.b.1 - s.a.1);
        let den = rx * sy - ry * sx;
        if den.abs() < 1e-6 {
            continue;
        }
        let (wx, wy) = (s.a.0 - p.0, s.a.1 - p.1);
        let t = (wx * sy - wy * sx) / den; // along p → q
        let u = (wx * ry - wy * rx) / den; // along the carriageway segment
        // Not the line the pole itself stands on, and not the line the candidate is on.
        if !(0.0..=1.0).contains(&u) || t * len <= 1.5 || (1.0 - t) * len <= 0.5 {
            continue;
        }
        worst = worst.max(match s.kind {
            CarriagewayKind::Road if in_street => 0.0,
            CarriagewayKind::Road => 25.0,
            CarriagewayKind::TramTrack => 30.0,
            CarriagewayKind::RailTrack => 60.0,
        });
    }
    worst
}

/// How good a place to wait an edge is, in metres of extra distance.
fn standing_penalty(ed: &WalkEdge, on_rails: bool) -> f32 {
    let sidewalk = ed.flags & EF_HAS_SIDEWALK != 0;
    match ed.kind {
        EdgeKind::Platform => {
            if on_rails {
                -6.0
            } else {
                -2.0
            }
        }
        EdgeKind::Sidewalk | EdgeKind::Footway | EdgeKind::Pedestrian | EdgeKind::Corridor => 0.0,
        EdgeKind::Path => 4.0,
        EdgeKind::Road => {
            if sidewalk {
                5.0
            } else {
                9.0
            }
        }
        EdgeKind::RoadBusy => {
            if sidewalk {
                8.0
            } else {
                14.0
            }
        }
        EdgeKind::Crossing => 12.0,
        EdgeKind::Steps | EdgeKind::Escalator | EdgeKind::Lift => 1e6,
    }
}

fn no_side() -> SideInfo {
    SideInfo { side: 255, ref_kind: 255, line_bearing: -1, ..Default::default() }
}

fn link_stop(stop: &Stop, didok: u32, idx: &PlatformIndex, comps: &Components, router: &WalkRouter, segs: &(Local, Vec<Seg>)) -> StopLink {
    let none = StopLink { matched: LinkMatch::None, snap: Snap { edge: NONE, frac: 0.0, pos: stop.pos, dist_m: 0.0 }, level: LEVEL_NONE, osm_id: 0, osm_type: 0, side: no_side() };
    if stop.pos.is_none() {
        return none;
    }
    let g = router.graph();
    let found = idx.find(stop, didok);
    let platform = found.map(|(pi, _)| &idx.extract.platforms[pi as usize]);

    // Stand on the mapped platform itself when it is part of the network.
    if let Some(pl) = platform {
        if pl.kind == PlatformKind::PlatformWay && !pl.edges.is_empty() {
            let mut best: Option<(u32, f32, LatLon, f32)> = None;
            for &e in &pl.edges {
                let (frac, pos, d) = project_on_edge(g, e, &stop.pos);
                if best.map_or(true, |b| d < b.3) {
                    best = Some((e, frac, pos, d));
                }
            }
            if let Some((edge, frac, pos, dist_m)) = best.filter(|b| comps.is_main(g, b.0)) {
                let ed = &g.edges[edge as usize];
                let level = if pl.level != LEVEL_NONE { pl.level } else { ed.level_a };
                return StopLink { matched: found.unwrap().1, snap: Snap { edge, frac, pos, dist_m }, level, osm_id: pl.osm_id, osm_type: pl.osm_type, side: no_side() };
            }
        }
    }

    // Otherwise the best place a person can stand near the pole. The pole is
    // the registry coordinate, or the matched platform node when that gives
    // the better place (the registry point of a stop often lies on the lane,
    // an OSM `highway=bus_stop` node sometimes does too).
    let level = platform.map_or(LEVEL_NONE, |pl| pl.level);
    let node_pole = platform.filter(|pl| pl.kind == PlatformKind::PlatformNode).map(|pl| pl.pos);
    // Unknown level means ground level: never drop a street stop into the
    // underpass below it.
    let lvl = Some(if level == LEVEL_NONE { 0 } else { level });
    let on_rails = stop.modes & (Mode::Rail.bit() | Mode::RackRail.bit() | Mode::Metro.bit() | Mode::Tram.bit() | Mode::Funicular.bit()) != 0;
    let (frame, segs) = segs;
    let stages: [(f32, Option<Level2>); 5] = [(30.0, lvl), (30.0, None), (80.0, lvl), (80.0, None), (200.0, None)];
    for (max_dist_m, level_filter) in stages {
        let opts = SnapOptions { max_dist_m, level: level_filter, profile: None, exclude_kinds: VERTICAL };
        let mut best: Option<(f32, Snap)> = None;
        for (pole, handicap) in std::iter::once((stop.pos, 0.0)).chain(node_pole.map(|p| (p, 0.3 * p.dist_m(&stop.pos)))) {
            let at = frame.xy(&pole);
            // A tram stop whose point lies on the track is boarded from the
            // street: the pavement beyond the traffic lane is its waiting place.
            let in_street = segs.iter().any(|s| s.kind == CarriagewayKind::TramTrack && project(at, s).dist <= 2.0);
            for snap in router.snap_candidates(pole, &opts, 24) {
                let ed = &g.edges[snap.edge as usize];
                let d = snap.dist_m;
                // A platform of another mode (the railway platform beside a
                // bus stop) is not this stop's waiting place.
                let foreign = ed.kind == EdgeKind::Platform && idx.by_edge.get(&snap.edge).map_or(false, |&pi| !modes_compatible(stop.modes, idx.extract.platforms[pi as usize].modes));
                let score = handicap + d + 0.5 * (d - 10.0).max(0.0)
                    + if foreign { 8.0 } else { standing_penalty(ed, on_rails) }
                    + crossing_penalty(segs, at, frame.xy(&snap.pos), in_street)
                    // an isolated fragment only when nothing else is in reach
                    + if comps.is_main(g, snap.edge) { 0.0 } else { 1000.0 };
                if best.map_or(true, |b| score < b.0) {
                    best = Some((score, snap));
                }
            }
        }
        if let Some((_, mut snap)) = best {
            snap.dist_m = snap.pos.dist_m(&stop.pos);
            let ed = &g.edges[snap.edge as usize];
            return StopLink {
                matched: found.map(|f| f.1).unwrap_or(LinkMatch::Nearest),
                snap,
                level: if level != LEVEL_NONE { level } else { ed.level_a },
                osm_id: platform.map(|p| p.osm_id).unwrap_or(0),
                osm_type: platform.map(|p| p.osm_type).unwrap_or(0),
                side: no_side(),
            };
        }
    }
    none
}

/// Is the carriageway at this point a road tunnel? Judged from the walk
/// graph (the extract does not say); `false` when no walkable road lies there.
fn in_tunnel(router: &WalkRouter, at: LatLon) -> bool {
    let only_roads = !(kind_bit(EdgeKind::Road) | kind_bit(EdgeKind::RoadBusy));
    let c = router.snap_candidates(at, &SnapOptions { max_dist_m: 1.0, level: None, profile: None, exclude_kinds: only_roads }, 4);
    let g = router.graph();
    !c.is_empty() && c.iter().all(|s| g.edges[s.edge as usize].flags & EF_TUNNEL != 0)
}

/// Which side of its road or track a stop is on (see the crate docs, §2).
fn side_of(stop: &Stop, link: &StopLink, lines: &Lines, router: &WalkRouter, segs: &(Local, Vec<Seg>)) -> SideInfo {
    if stop.pos.is_none() {
        return no_side();
    }
    let tram = stop.modes & Mode::Tram.bit() != 0;
    let rail = stop.modes & (Mode::Rail.bit() | Mode::RackRail.bit() | Mode::Metro.bit() | Mode::Funicular.bit()) != 0;
    let road = stop.modes & (Mode::Bus.bit() | Mode::OnDemand.bit()) != 0;
    if !(tram || rail || road) {
        return no_side();
    }
    let (frame, segs) = segs;
    let g = router.graph();
    let reg = frame.xy(&stop.pos);
    // The standing point is evidence of the side only when something other
    // than our own snapping put it there: an OSM platform matched by id or
    // label, or — for a boarding point with its own coordinate — an OSM
    // platform object within 12 m. The nearest pavement to a registry point
    // that lies on the centre line is a coin flip, not a side.
    let identified = matches!(link.matched, LinkMatch::Sloid | LinkMatch::Label);
    let beside_object = link.matched == LinkMatch::Nearest && link.osm_id != 0 && stop.precision == Precision::Edge && link.snap.dist_m <= 12.0;
    let on_foot = link.matched != LinkMatch::None && !matches!(g.edges[link.snap.edge as usize].kind, EdgeKind::Road | EdgeKind::RoadBusy | EdgeKind::Crossing);
    let stand = (on_foot && link.snap.dist_m <= 30.0 && (identified || beside_object)).then(|| frame.xy(&link.snap.pos));
    let trust_stand = identified;

    // Nearest point of each carriageway of kind `k` to `p`, nearest first.
    let nearest = |k: CarriagewayKind, p: (f32, f32)| -> Vec<Proj> {
        let mut per: FxHashMap<u32, Proj> = FxHashMap::default();
        for s in segs.iter().filter(|s| s.kind == k) {
            let pr = project(p, s);
            let e = per.entry(s.cw).or_insert(pr);
            if pr.dist < e.dist {
                *e = pr;
            }
        }
        let mut v: Vec<Proj> = per.into_values().collect();
        v.sort_by(|a, b| a.dist.partial_cmp(&b.dist).unwrap());
        v
    };
    let on = |cw: u32, p: (f32, f32)| -> Option<Proj> { segs.iter().filter(|s| s.cw == cw).map(|s| project(p, s)).min_by(|a, b| a.dist.partial_cmp(&b.dist).unwrap()) };
    // The point the side is judged from, projected on carriageway `cw`.
    let reference = |cw: u32| -> Option<((f32, f32), Proj)> {
        let pr = on(cw, reg).filter(|p| p.dist >= 2.0).map(|p| (reg, p));
        let ps = stand.and_then(|s| on(cw, s).filter(|p| p.dist >= 1.0 && p.dist <= 30.0).map(|p| (s, p)));
        if trust_stand {
            ps.or(pr)
        } else {
            pr.or(ps)
        }
    };
    // True if `point` is on side `bearing` of every carriageway named `name` within 40 m.
    let whole_street = |name: u32, point: (f32, f32), bearing: f32| -> bool {
        nearest(CarriagewayKind::Road, point).iter().filter(|p| p.name == name && p.dist <= 40.0).all(|p| p.dist >= 1.0 && angle_between(p.side_bearing(), bearing) <= 60.0)
    };
    let name_of = |i: u32| lines.extract.carriageway_names[i as usize].clone();
    let compass = |b: f32| (((b + 22.5) / 45.0) as usize % 8) as u8;

    let order: &[(CarriagewayKind, f32)] = if rail {
        &[(CarriagewayKind::RailTrack, 25.0), (CarriagewayKind::TramTrack, 15.0)]
    } else if tram && !road {
        &[(CarriagewayKind::TramTrack, 15.0), (CarriagewayKind::Road, 30.0)]
    } else if tram {
        &[(CarriagewayKind::TramTrack, 12.0), (CarriagewayKind::Road, 30.0)]
    } else {
        &[(CarriagewayKind::Road, 30.0)]
    };
    for &(k, limit) in order {
        let mut cands = nearest(k, reg);
        cands.retain(|p| p.dist <= limit);
        if cands.is_empty() {
            continue;
        }
        let mut line = cands[0];
        if k == CarriagewayKind::Road {
            // A road tunnel under the stop is not the stop's road.
            let to_ll = |at: (f32, f32)| LatLon { lat: frame.o.lat + (at.1 / (geo::M_PER_DEG_LAT * 1e-7) as f32).round() as i32, lon: frame.o.lon + (at.0 / frame.kx).round() as i32 };
            if let Some(surface) = cands.iter().take(4).find(|p| !in_tunnel(router, to_ll(p.at))) {
                line = *surface;
            }
        }
        let mut info = SideInfo { street: String::new(), place: String::new(), side: 255, ref_kind: k as u8, dist_m: line.dist, line_bearing: (line.bearing % 180.0) as i16 };
        // The named street or square the stop is at, even when no side can be stated for it.
        if let Some(named) = nearest(CarriagewayKind::Road, reg).into_iter().find(|p| p.name != 0 && p.dist <= 25.0) {
            info.place = name_of(named.name);
        }
        let Some((point, mut pr)) = reference(line.cw) else {
            // On the centre line: no side, but the street is still the stop's street.
            if k == CarriagewayKind::Road && line.name != 0 {
                info.street = name_of(line.name);
            }
            return info;
        };
        match k {
            CarriagewayKind::Road => {
                if pr.name == 0 {
                    // An unnamed lane (bus station, slip road): describe the named street beside it, if any.
                    if let Some(named) = nearest(k, point).into_iter().find(|p| p.name != 0 && p.dist <= 25.0 && p.dist >= 1.0) {
                        pr = named;
                    }
                }
                if pr.name != 0 && whole_street(pr.name, point, pr.side_bearing()) {
                    info.street = name_of(pr.name);
                }
            }
            CarriagewayKind::TramTrack | CarriagewayKind::RailTrack => {
                // Between two tracks (island platform): neither side.
                let reach = if k == CarriagewayKind::TramTrack { 12.0 } else { 20.0 };
                let island = nearest(k, point).iter().any(|o| o.cw != pr.cw && o.inside && o.dist >= 1.0 && o.dist <= reach && angle_between(o.side_bearing(), pr.side_bearing()) > 120.0);
                if island {
                    info.dist_m = pr.dist;
                    return info;
                }
                if k == CarriagewayKind::TramTrack {
                    if let Some(named) = nearest(CarriagewayKind::Road, point).into_iter().find(|p| p.name != 0 && p.dist <= 25.0) {
                        if whole_street(named.name, point, pr.side_bearing()) {
                            info.street = name_of(named.name);
                        }
                    }
                }
            }
        }
        info.side = compass(pr.side_bearing());
        info.dist_m = pr.dist;
        info.line_bearing = (pr.bearing % 180.0) as i16;
        return info;
    }
    no_side()
}

/// `better`: the unrestricted footpaths when computing the step-free ones.
fn footpaths(tt: &Timetable, router: &WalkRouter, links: &[StopLink], profile: &WalkProfile, max_s: f32, better: Option<&Footpaths>) -> Footpaths {
    let n = tt.stops.len();
    let grid = Grid::new(tt.stops.iter().enumerate().map(|(i, s)| (i as u32, s.pos)), 300.0);
    let radius = max_s * profile.speed_mps;
    let rows: Vec<Vec<(StopIdx, u16, u16)>> = (0..n as u32)
        .into_par_iter()
        .map(|s| {
            let stop = &tt.stops[s as usize];
            if stop.pos.is_none() {
                return Vec::new();
            }
            let mut near: Vec<StopIdx> = Vec::new();
            grid.around(&stop.pos, radius, |t| {
                if t != s && tt.stops[t as usize].pos.dist_m(&stop.pos) <= radius {
                    near.push(t);
                }
            });
            near.sort_unstable();
            let mut out: Vec<(StopIdx, u16, u16)> = Vec::new();
            let mut reached: FxHashSet<StopIdx> = FxHashSet::default();
            let from = &links[s as usize];
            if from.matched != LinkMatch::None {
                let targets: Vec<StopIdx> = near.iter().copied().filter(|&t| links[t as usize].matched != LinkMatch::None).collect();
                let snaps: Vec<Snap> = targets.iter().map(|&t| links[t as usize].snap).collect();
                let costs = router.one_to_many(&from.snap, &snaps, profile, max_s);
                for (k, c) in costs.into_iter().enumerate() {
                    let Some(c) = c else { continue };
                    let var = c.var_m + from.snap.dist_m + snaps[k].dist_m;
                    if walk_secs(var, c.fix_s, profile.speed_mps) > max_s {
                        continue;
                    }
                    reached.insert(targets[k]);
                    out.push((targets[k], var.ceil().min(65535.0) as u16, c.fix_s.ceil().min(65535.0) as u16));
                }
            }
            // Never lose a change inside one station, or around a stop that has
            // no mapped paths: estimate from the straight line instead.
            for &t in &near {
                if reached.contains(&t) {
                    continue;
                }
                let other = &tt.stops[t as usize];
                let d = other.pos.dist_m(&stop.pos);
                let same_station = other.station == stop.station;
                let unlinked = from.matched == LinkMatch::None || links[t as usize].matched == LinkMatch::None;
                if (same_station && d <= 450.0) || (unlinked && d <= 250.0) {
                    let (mut var, mut fix) = (d * 1.5 + 10.0, 0.0f32);
                    // Step-free, but the map only knows a way with stairs: not
                    // faster than that way, plus a lift down and a lift up.
                    if let Some((v, f)) = better.and_then(|b| b.get(s, t)) {
                        var = var.max(v as f32);
                        fix = f as f32 + 2.0 * LIFT_S;
                    }
                    // A pair inside one station is kept even when the estimate
                    // exceeds the bound; the journey planner applies its own limit.
                    if same_station || walk_secs(var, fix, profile.speed_mps) <= max_s {
                        out.push((t, var.ceil().min(65535.0) as u16, fix.ceil().min(65535.0) as u16));
                    }
                }
            }
            out.sort_unstable();
            out
        })
        .collect();
    let mut fp = Footpaths { off: Vec::with_capacity(n + 1), ..Default::default() };
    for row in rows {
        fp.off.push(fp.to.len() as u32);
        for (t, v, f) in row {
            fp.to.push(t);
            fp.var_m.push(v);
            fp.fix_s.push(f);
        }
    }
    fp.off.push(fp.to.len() as u32);
    fp
}

pub fn link(tt: &Timetable, router: &WalkRouter, extract: &OsmExtract, opts: &LinkOptions) -> LinkData {
    let graph = router.graph();
    // Only link stops inside the area the graph covers (plus a margin).
    let mut area = BBox::empty();
    for p in graph.nodes.iter().step_by(16) {
        area.extend(p);
    }
    let area = BBox { min: LatLon { lat: area.min.lat - 20_000, lon: area.min.lon - 30_000 }, max: LatLon { lat: area.max.lat + 20_000, lon: area.max.lon + 30_000 } };

    let idx = PlatformIndex::new(extract, graph);
    let comps = Components::new(graph);
    let lines = Lines::new(extract, &tt.stops);
    let links: Vec<StopLink> = tt
        .stops
        .par_iter()
        .map(|stop| {
            let didok = tt.stations[stop.station as usize].didok;
            if !area.contains(&stop.pos) {
                return link_stop(&Stop { pos: LatLon::NONE, ..stop.clone() }, didok, &idx, &comps, router, &(Local::new(stop.pos), Vec::new()));
            }
            let segs = lines.around(&stop.pos);
            let mut l = link_stop(stop, didok, &idx, &comps, router, &segs);
            l.side = side_of(stop, &l, &lines, router, &segs);
            l
        })
        .collect();

    let normal = footpaths(tt, router, &links, &WalkProfile::normal(DEFAULT_SPEED_MPS), opts.max_transfer_s, None);
    let step_free = footpaths(tt, router, &links, &WalkProfile::step_free(DEFAULT_SPEED_MPS), opts.max_transfer_s, Some(&normal));
    LinkData { links, normal, step_free }
}

/// Human-readable summary of how well the linking went, for the build log.
/// The first line is the overall count; the rest breaks it down by mode and
/// lists the stops of the 30 busiest stations that stand more than 25 m from
/// their registry coordinate, so a regression in the matching rules shows up
/// as a diff of this text.
pub fn report(tt: &Timetable, data: &LinkData) -> String {
    use std::fmt::Write;
    let mut by = [0usize; 4];
    let mut far = 0;
    let mut side = 0;
    // per mode: [sloid, label, nearest, unlinked, far, with side]
    let mut modes: Vec<(Mode, [usize; 6])> = Mode::ALL.iter().map(|m| (*m, [0; 6])).collect();
    let mut none_mode = [0usize; 6];
    for (stop, l) in tt.stops.iter().zip(&data.links) {
        by[l.matched as usize] += 1;
        let is_far = l.matched != LinkMatch::None && l.snap.dist_m > 25.0;
        far += is_far as usize;
        side += (l.side.side <= 7) as usize;
        // A stop counts under its first mode (rail before tram before bus …).
        let row = match modes.iter_mut().find(|(m, _)| stop.modes & m.bit() != 0) {
            Some((_, row)) => row,
            None => &mut none_mode,
        };
        let col = match l.matched {
            LinkMatch::Sloid => 0,
            LinkMatch::Label => 1,
            LinkMatch::Nearest => 2,
            LinkMatch::None => 3,
        };
        row[col] += 1;
        row[4] += is_far as usize;
        row[5] += (l.side.side <= 7) as usize;
    }
    let mut out = format!(
        "{} stops: {} by sloid, {} by label, {} by nearest edge, {} unlinked; {} snapped more than 25 m away; {} with a side of road; footpaths {} normal / {} step-free",
        tt.stops.len(),
        by[LinkMatch::Sloid as usize],
        by[LinkMatch::Label as usize],
        by[LinkMatch::Nearest as usize],
        by[LinkMatch::None as usize],
        far,
        side,
        data.normal.len(),
        data.step_free.len()
    );
    let _ = write!(out, "\n  {:<10} {:>7} {:>7} {:>8} {:>9} {:>6} {:>7}", "mode", "sloid", "label", "nearest", "unlinked", ">25 m", "side");
    for (name, row) in modes.iter().map(|(m, r)| (m.as_str(), r)).chain(std::iter::once(("(no line)", &none_mode))) {
        if row.iter().sum::<usize>() > 0 {
            let _ = write!(out, "\n  {:<10} {:>7} {:>7} {:>8} {:>9} {:>6} {:>7}", name, row[0], row[1], row[2], row[3], row[4], row[5]);
        }
    }
    let mut busiest: Vec<usize> = (0..tt.stations.len()).collect();
    busiest.sort_by_key(|&i| std::cmp::Reverse(tt.stations[i].weight));
    let mut lines: Vec<String> = Vec::new();
    for &i in busiest.iter().take(30) {
        let st = &tt.stations[i];
        for &s in &st.stops {
            let (stop, l) = (&tt.stops[s as usize], &data.links[s as usize]);
            if l.matched == LinkMatch::None {
                lines.push(format!("{} [{}]: unlinked", st.name, stop.label));
            } else if l.snap.dist_m > 25.0 {
                lines.push(format!("{} [{}]: {:.0} m ({:?})", st.name, stop.label, l.snap.dist_m, l.matched));
            }
        }
    }
    let _ = write!(out, "\n  30 busiest stations: {} stops unlinked or more than 25 m from their registry point{}", lines.len(), if lines.is_empty() { "" } else { ":" });
    for l in lines {
        let _ = write!(out, "\n    {l}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const LAT0: f64 = 46.948;
    const LON0: f64 = 7.44;
    fn pt(x: f32, y: f32) -> LatLon {
        LatLon::from_deg(LAT0 + y as f64 / geo::M_PER_DEG_LAT, LON0 + x as f64 / (geo::M_PER_DEG_LAT * LAT0.to_radians().cos()))
    }

    /// A small world: nodes, walk edges and carriageways given in metres.
    #[derive(Default)]
    struct World {
        g: WalkGraph,
        x: OsmExtract,
        tt: Timetable,
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
        fn edge(&mut self, a: u32, b: u32, kind: EdgeKind, level: Level2) -> u32 {
            let off = self.g.geom.len() as u32;
            let (pa, pb) = (self.g.nodes[a as usize], self.g.nodes[b as usize]);
            self.g.geom.extend([pa, pb]);
            self.g.edges.push(WalkEdge { a, b, geom_off: off, geom_len: 2, kind, level_a: level, level_b: level, steps: 0, flags: 0, len_dm: (pa.dist_m(&pb) * 10.0).round() as u32, name: 0 });
            self.g.edge_way.push(self.g.edges.len() as i64);
            self.g.edges.len() as u32 - 1
        }
        /// A straight way of `n` edges from (x0, y) to (x1, y); returns its edges.
        fn way(&mut self, x0: f32, x1: f32, y: f32, n: usize, kind: EdgeKind, level: Level2) -> Vec<u32> {
            let nodes: Vec<u32> = (0..=n).map(|i| self.node(x0 + (x1 - x0) * i as f32 / n as f32, y)).collect();
            nodes.windows(2).map(|w| self.edge(w[0], w[1], kind, level)).collect()
        }
        fn line(&mut self, kind: CarriagewayKind, name: &str, pts: &[(f32, f32)]) {
            let name = if name.is_empty() {
                0
            } else {
                self.x.carriageway_names.push(name.to_string());
                self.x.carriageway_names.len() as u32 - 1
            };
            let off = self.x.carriageway_geom.len() as u32;
            self.x.carriageway_geom.extend(pts.iter().map(|&(x, y)| pt(x, y)));
            self.x.carriageways.push(Carriageway { kind, geom_off: off, geom_len: pts.len() as u16, name, off_ground: false });
        }
        fn stop(&mut self, x: f32, y: f32, label: &str, mode: Mode) -> usize {
            if self.tt.stations.is_empty() {
                self.tt.stations.push(Station { gtfs_id: "st".into(), name: "Test".into(), pos: pt(0.0, 0.0), didok: 8500001, stops: vec![], weight: 1, modes: 0 });
            }
            let i = self.tt.stops.len();
            self.tt.stations[0].stops.push(i as u32);
            self.tt.stops.push(Stop { gtfs_id: format!("s{i}"), sloid: format!("ch:1:sloid:1:0:{i}"), station: 0, pos: pt(x, y), label: label.into(), sectors: String::new(), precision: Precision::Edge, compass: -1, access: QuayAccess::Unknown, modes: mode.bit() });
            i
        }
        fn link(mut self) -> (LinkData, WalkGraph) {
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
            let router = WalkRouter::new(Arc::new(self.g.clone()));
            (link(&self.tt, &router, &self.x, &LinkOptions::default()), self.g)
        }
    }

    /// Joins the west ends of several ways so that they form one network
    /// (and makes it big enough to count as the main one).
    fn join(w: &mut World, firsts: &[u32]) {
        for pair in firsts.windows(2) {
            let (a, b) = (w.g.edges[pair[0] as usize].a, w.g.edges[pair[1] as usize].a);
            w.edge(a, b, EdgeKind::Footway, LEVEL_NONE);
        }
    }

    #[test]
    fn labels() {
        let refs = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(label_matches("7", &refs(&["7", "8"])));
        assert!(label_matches("k1", &refs(&["K1"])));
        assert!(label_matches("41/42", &refs(&["41", "42"])) && label_matches("41/42", &refs(&["42"])));
        assert!(!label_matches("4", &refs(&["41", "42"])) && !label_matches("", &refs(&[""])) && !label_matches("/", &refs(&["1"])));
    }

    #[test]
    fn stays_on_its_own_side_of_the_road() {
        // A main road W–E without pavement on the south side: a pavement 5 m
        // north of the centre line, a field path 28 m south of it.
        let mut w = World::new();
        let road = w.way(0.0, 400.0, 0.0, 80, EdgeKind::RoadBusy, LEVEL_NONE);
        let pavement = w.way(0.0, 400.0, 5.0, 80, EdgeKind::Sidewalk, LEVEL_NONE);
        let path = w.way(0.0, 400.0, -28.0, 80, EdgeKind::Path, LEVEL_NONE);
        join(&mut w, &[road[0], pavement[0], path[0]]);
        w.line(CarriagewayKind::Road, "Hauptstrasse", &[(0.0, 0.0), (400.0, 0.0)]);
        let south = w.stop(200.0, -4.0, "", Mode::Bus);
        let north = w.stop(210.0, 4.0, "", Mode::Bus);
        let centre = w.stop(120.0, 0.3, "", Mode::Bus);
        let (data, g) = w.link();
        let kind = |i: usize| g.edges[data.links[i].snap.edge as usize].kind;
        // The south stop stays on its road: not across it, not on the path.
        assert_eq!(kind(south), EdgeKind::RoadBusy);
        assert!((data.links[south].snap.dist_m - 4.0).abs() < 0.3);
        assert_eq!((data.links[south].side.side, data.links[south].side.street.as_str(), data.links[south].side.ref_kind), (4, "Hauptstrasse", 0));
        assert_eq!(kind(north), EdgeKind::Sidewalk);
        assert_eq!((data.links[north].side.side, data.links[north].side.street.as_str()), (0, "Hauptstrasse"));
        // On the centre line: stands on the pavement, but claims no side.
        assert_eq!(kind(centre), EdgeKind::Sidewalk);
        assert_eq!((data.links[centre].side.side, data.links[centre].side.street.as_str()), (255, "Hauptstrasse"));
        // All three reach each other, there and back alike.
        for a in 0..3u32 {
            for b in 0..3u32 {
                if a != b {
                    assert_eq!(data.normal.get(a, b), data.normal.get(b, a));
                    assert!(data.normal.get(a, b).is_some() && data.step_free.get(a, b).is_some());
                }
            }
        }
    }

    #[test]
    fn platforms_levels_and_tracks() {
        // Two side platforms either side of a double track, an underpass
        // footway on level −1 right below the northern one, and a bus stop
        // beside the southern platform.
        let mut w = World::new();
        let p1 = w.way(0.0, 300.0, 6.0, 60, EdgeKind::Platform, LEVEL_NONE);
        let p2 = w.way(0.0, 300.0, -6.0, 60, EdgeKind::Platform, LEVEL_NONE);
        let under = w.way(0.0, 300.0, 6.5, 60, EdgeKind::Footway, -2);
        let street = w.way(0.0, 300.0, -16.0, 60, EdgeKind::Sidewalk, LEVEL_NONE);
        join(&mut w, &[p1[0], p2[0], under[0], street[0]]);
        for (y, name) in [(2.0, ""), (-2.0, "")] {
            w.line(CarriagewayKind::RailTrack, name, &[(0.0, y), (300.0, y)]);
        }
        w.line(CarriagewayKind::Road, "Bahnhofstrasse", &[(0.0, -20.0), (300.0, -20.0)]);
        for (edges, r, modes) in [(&p1, "1", 4u8), (&p2, "2", 4u8)] {
            w.x.platforms.push(OsmPlatform { kind: PlatformKind::PlatformWay, osm_type: 1, osm_id: 100 + modes as i64 + r.parse::<i64>().unwrap(), pos: pt(150.0, if r == "1" { 6.0 } else { -6.0 }), level: LEVEL_NONE, refs: vec![r.to_string()], name: String::new(), sloid: String::new(), uic_ref: 0, modes, edges: edges.to_vec() });
        }
        w.x.platforms.sort_by_key(|p| (p.osm_type, p.osm_id));
        // Registry points on the platform edges, 3.5 m from the platform lines.
        let t1 = w.stop(100.0, 2.6, "1", Mode::Rail);
        let t2 = w.stop(100.0, -2.6, "2", Mode::Rail);
        // An unsigned rail stop on the southern edge: nearest platform, not across the tracks.
        let t0 = w.stop(180.0, -1.0, "", Mode::Rail);
        let bus = w.stop(60.0, -11.0, "", Mode::Bus);
        let (data, g) = w.link();
        let edge = |i: usize| data.links[i].snap.edge;
        assert!(p1.contains(&edge(t1)) && data.links[t1].matched == LinkMatch::Label);
        assert!(p2.contains(&edge(t2)) && data.links[t2].matched == LinkMatch::Label);
        // Never the underpass 0.5 m beside the platform line.
        assert!(g.edges[edge(t1) as usize].level_a == LEVEL_NONE);
        assert!(p2.contains(&edge(t0)), "{:?}", g.edges[edge(t0) as usize].kind);
        // The bus stop waits on the pavement, not on the railway platform 5 m away.
        assert!(street.contains(&edge(bus)), "{:?}", g.edges[edge(bus) as usize].kind);
        // Side platforms: track 1 is north of the tracks, track 2 south; no street for trains.
        assert_eq!((data.links[t1].side.side, data.links[t1].side.ref_kind, data.links[t1].side.street.as_str()), (0, 2, ""));
        assert_eq!(data.links[t2].side.side, 4);
        assert_eq!((data.links[bus].side.side, data.links[bus].side.street.as_str()), (0, "Bahnhofstrasse"));
    }

    #[test]
    fn geometry_helpers() {
        let seg = |kind, a, b| Seg { cw: 0, kind, name: 0, a, b };
        let road = [seg(CarriagewayKind::Road, (-50.0, 0.0), (50.0, 0.0))];
        // across the road / on the same side / onto the road itself / pole on the line
        assert_eq!(crossing_penalty(&road, (0.0, -4.0), (3.0, 6.0), false), 25.0);
        assert_eq!(crossing_penalty(&road, (0.0, -4.0), (10.0, -9.0), false), 0.0);
        assert_eq!(crossing_penalty(&road, (0.0, -4.0), (0.0, 0.0), false), 0.0);
        assert_eq!(crossing_penalty(&road, (0.0, -0.5), (0.0, 6.0), false), 0.0);
        assert_eq!(crossing_penalty(&road, (0.0, -4.0), (3.0, 6.0), true), 0.0);
        let rail = [seg(CarriagewayKind::RailTrack, (-50.0, 0.0), (50.0, 0.0))];
        assert_eq!(crossing_penalty(&rail, (0.0, -3.0), (0.0, 8.0), true), 60.0);
        // West → east line: a point to the north is on its left, side bearing north.
        let p = project((10.0, 5.0), &road[0]);
        assert!(p.left && p.inside && (p.dist - 5.0).abs() < 1e-3 && angle_between(p.side_bearing(), 0.0) < 0.1 && (p.bearing - 90.0).abs() < 0.1);
        let q = project((60.0, -5.0), &road[0]);
        assert!(!q.left && !q.inside && angle_between(q.side_bearing(), 180.0) < 0.1);
        assert!((angle_between(350.0, 10.0) - 20.0).abs() < 1e-3);
    }
}
