//! Pedestrian network model (built from OpenStreetMap), walking profiles and
//! the precomputed stop-to-stop footpaths.
//!
//! # Walking time model (shared contract)
//!
//! Every walk is summarised by two numbers so that one precomputed path serves
//! any walking speed:
//!
//! ```text
//! time_s = var_m / speed_mps + fix_s
//! ```
//!
//! - `var_m`: metres that scale with the walker's speed. Flat ground counts
//!   1:1, stairs count [`STAIRS_FACTOR`] × their horizontal length.
//! - `fix_s`: seconds that do not depend on the walker: lift rides
//!   ([`LIFT_S`] each), escalators (length / [`ESCALATOR_MPS`]), expected waits
//!   at crossings ([`CROSSING_SIGNAL_S`], [`CROSSING_MARKED_S`],
//!   [`CROSSING_UNMARKED_S`]).

use crate::geo::LatLon;
use crate::timetable::StopIdx;
use serde::{Deserialize, Serialize};

pub const WALKGRAPH_SCHEMA: &str = "walkgraph-v1";
pub const LINKS_SCHEMA: &str = "links-v2";

pub const STAIRS_FACTOR: f32 = 2.2;
pub const LIFT_S: f32 = 50.0;
pub const ESCALATOR_MPS: f32 = 0.55;
pub const CROSSING_SIGNAL_S: f32 = 18.0;
pub const CROSSING_MARKED_S: f32 = 3.0;
pub const CROSSING_UNMARKED_S: f32 = 6.0;
/// Reference speed used when a cost must be compared without a user profile.
pub const DEFAULT_SPEED_MPS: f32 = 1.3;

#[inline]
pub fn walk_secs(var_m: f32, fix_s: f32, speed_mps: f32) -> f32 {
    var_m / speed_mps + fix_s
}

/// Levels are stored ×2 so half levels (mezzanines, "0.5") fit in an integer:
/// OSM `level=-1` → -2, `level=0` → 0, `level=1.5` → 3.
pub type Level2 = i8;
pub const LEVEL_NONE: Level2 = i8::MIN;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum EdgeKind {
    /// Dedicated footway or path not tagged as anything more specific.
    Footway = 0,
    /// Footway mapped as a sidewalk (`footway=sidewalk`).
    Sidewalk = 1,
    /// Street crossing (`footway=crossing` / `highway=crossing` way).
    Crossing = 2,
    /// Unpaved path / track / hiking trail.
    Path = 3,
    /// Pedestrian street or square edge (`highway=pedestrian`), including
    /// synthetic edges across an open square (see `EF_AREA`).
    Pedestrian = 4,
    Steps = 5,
    /// Escalator or moving walkway (`conveying=*`).
    Escalator = 6,
    /// Lift: an edge through an elevator node or across an elevator area.
    Lift = 7,
    /// Indoor corridor (`highway=corridor`, `indoor=corridor`).
    Corridor = 8,
    /// Public-transport platform (way or area edge).
    Platform = 9,
    /// Low-traffic road shared with cars: residential, living street, service,
    /// unclassified, track, cycleway open to pedestrians.
    Road = 10,
    /// Tertiary or bigger road walked along the carriageway because no
    /// separate sidewalk way is mapped.
    RoadBusy = 11,
}

// Edge flag bits (`WalkEdge::flags`).
pub const EF_INDOOR: u16 = 1 << 0;
pub const EF_TUNNEL: u16 = 1 << 1;
pub const EF_BRIDGE: u16 = 1 << 2;
pub const EF_COVERED: u16 = 1 << 3;
/// `wheelchair=no` on the way.
pub const EF_WHEELCHAIR_NO: u16 = 1 << 4;
/// `wheelchair=yes|designated`.
pub const EF_WHEELCHAIR_YES: u16 = 1 << 5;
/// Usable only from node `a` to node `b` (escalator direction).
pub const EF_ONEWAY_AB: u16 = 1 << 6;
/// Usable only from node `b` to node `a`.
pub const EF_ONEWAY_BA: u16 = 1 << 7;
/// Steps with a usable ramp (`ramp=yes`, `ramp:wheelchair=yes`).
pub const EF_RAMP: u16 = 1 << 8;
/// Crossing with traffic signals.
pub const EF_SIGNALS: u16 = 1 << 9;
/// Marked crossing (zebra) without signals.
pub const EF_MARKED: u16 = 1 << 10;
/// Synthetic straight edge across a pedestrian area / platform polygon.
pub const EF_AREA: u16 = 1 << 11;
/// Rough or unpaved surface (gravel, ground, cobblestone …).
pub const EF_ROUGH: u16 = 1 << 12;
/// For Steps/Escalator: node `b` is the upper end. If neither `EF_UP_AB` nor
/// `EF_UP_BA` is set the direction is unknown.
pub const EF_UP_AB: u16 = 1 << 13;
pub const EF_UP_BA: u16 = 1 << 14;
/// Road with a sidewalk tagged on the road itself (`sidewalk=both|left|right`).
pub const EF_HAS_SIDEWALK: u16 = 1 << 15;

// Node flag bits (`WalkGraph::node_flags`).
pub const NF_ELEVATOR: u8 = 1 << 0;
pub const NF_ENTRANCE: u8 = 1 << 1;
/// A barrier a wheelchair cannot pass (`barrier=stile|turnstile|kissing_gate|…`,
/// `kerb=raised`).
pub const NF_NO_WHEELCHAIR: u8 = 1 << 2;
/// `highway=crossing` node with `crossing=traffic_signals`.
pub const NF_CROSSING_SIGNALS: u8 = 1 << 3;
/// Any other `highway=crossing` node.
pub const NF_CROSSING: u8 = 1 << 4;
/// Door (`door=*` or `entrance=*` on a building outline).
pub const NF_DOOR: u8 = 1 << 5;

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct WalkEdge {
    pub a: u32,
    pub b: u32,
    /// Polyline `geom[geom_off .. geom_off + geom_len]`, including both end
    /// nodes, ordered a → b.
    pub geom_off: u32,
    pub geom_len: u16,
    pub kind: EdgeKind,
    /// Level ×2 at node `a` / node `b` (they differ on stairs, ramps, lifts);
    /// `LEVEL_NONE` when OSM gives no level (ordinary outdoor ways).
    pub level_a: Level2,
    pub level_b: Level2,
    /// Number of steps for `Steps` (from `step_count`, else estimated), else 0.
    pub steps: u8,
    pub flags: u16,
    /// Horizontal length in decimetres.
    pub len_dm: u32,
    /// Index into `WalkGraph::names`; 0 = unnamed.
    pub name: u32,
}

impl WalkEdge {
    #[inline]
    pub fn len_m(&self) -> f32 {
        self.len_dm as f32 * 0.1
    }
    #[inline]
    pub fn other(&self, node: u32) -> u32 {
        if node == self.a {
            self.b
        } else {
            self.a
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct WalkGraph {
    /// Junction nodes (way ends, intersections, tagged nodes).
    pub nodes: Vec<LatLon>,
    pub node_flags: Vec<u8>,
    /// CSR adjacency: edges incident to node `n` are
    /// `adj[adj_off[n] .. adj_off[n+1]]` (edge indices; direction follows from
    /// comparing `n` with the edge's `a`/`b`).
    pub adj_off: Vec<u32>,
    pub adj: Vec<u32>,
    pub edges: Vec<WalkEdge>,
    /// OSM way id per edge (0 for synthetic edges); for debugging and for
    /// linking back to the map.
    pub edge_way: Vec<i64>,
    pub geom: Vec<LatLon>,
    /// `names[0]` is the empty string.
    pub names: Vec<String>,
}

impl WalkGraph {
    #[inline]
    pub fn edge_geom(&self, e: u32) -> &[LatLon] {
        let ed = &self.edges[e as usize];
        &self.geom[ed.geom_off as usize..ed.geom_off as usize + ed.geom_len as usize]
    }
    #[inline]
    pub fn incident(&self, n: u32) -> &[u32] {
        &self.adj[self.adj_off[n as usize] as usize..self.adj_off[n as usize + 1] as usize]
    }
    #[inline]
    pub fn edge_name(&self, e: u32) -> &str {
        &self.names[self.edges[e as usize].name as usize]
    }
}

/// What kind of OSM object a [`OsmPlatform`] came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum PlatformKind {
    /// `public_transport=platform` / `railway=platform` / `highway=platform`
    /// mapped as a way or area: passengers stand on it.
    PlatformWay = 0,
    /// Platform mapped as a single node (typical bus stop pole), incl. `highway=bus_stop`.
    PlatformNode = 1,
    /// `public_transport=stop_position`: where the vehicle stops, on the road or track.
    StopPosition = 2,
}

/// A public-transport platform or stop object from OSM, used to attach
/// registry boarding points to the walking network on the right level.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OsmPlatform {
    pub kind: PlatformKind,
    /// 0 = node, 1 = way, 2 = relation
    pub osm_type: u8,
    pub osm_id: i64,
    /// Centroid.
    pub pos: LatLon,
    pub level: Level2,
    /// `ref` and `local_ref` split on `;` `/` `,` and trimmed: `["7", "8"]`, `["K1"]`.
    pub refs: Vec<String>,
    pub name: String,
    /// `ref:sloid` if tagged, else empty.
    pub sloid: String,
    /// `uic_ref` (DiDok number of the stop), 0 if absent.
    pub uic_ref: u32,
    /// Mode hints from tags: bit 0 bus, 1 tram, 2 train, 3 subway/light rail, 4 ferry, 5 aerialway/funicular.
    pub modes: u8,
    /// For `PlatformWay`: indices of the walk edges that make up the platform
    /// (its outline and synthetic area edges). Empty otherwise.
    pub edges: Vec<u32>,
}

/// Reference line used to say which side of the road / track a stop is on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum CarriagewayKind {
    Road = 0,
    TramTrack = 1,
    RailTrack = 2,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Carriageway {
    pub kind: CarriagewayKind,
    /// Polyline in `OsmExtract::carriageway_geom`.
    pub geom_off: u32,
    pub geom_len: u16,
    /// Index into `OsmExtract::carriageway_names`; 0 = unnamed.
    pub name: u32,
}

/// Everything the OSM import hands to the linker besides the graph itself.
/// Saved next to the graph; not needed by the server at query time.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct OsmExtract {
    pub platforms: Vec<OsmPlatform>,
    pub carriageways: Vec<Carriageway>,
    pub carriageway_geom: Vec<LatLon>,
    pub carriageway_names: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum StairsPref {
    /// Stairs are fine.
    Ok,
    /// Prefer routes without stairs when the detour is moderate.
    Avoid,
    /// Never use stairs (ramps on stairs are fine).
    Never,
}

/// A walker. `time = var_m / speed_mps + fix_s`; the other fields decide which
/// edges are usable and how unpleasant they are for route choice.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct WalkProfile {
    pub speed_mps: f32,
    pub stairs: StairsPref,
    /// May use escalators.
    pub escalators: bool,
    /// May use lifts.
    pub lifts: bool,
    /// Wheelchair / pushchair mode: additionally refuses `wheelchair=no` ways
    /// and impassable barriers, and penalises rough surfaces.
    pub wheelchair: bool,
}

impl WalkProfile {
    pub const fn normal(speed_mps: f32) -> Self {
        WalkProfile { speed_mps, stairs: StairsPref::Ok, escalators: true, lifts: true, wheelchair: false }
    }
    /// Strict step-free: no stairs, no escalators, wheelchair rules.
    pub const fn step_free(speed_mps: f32) -> Self {
        WalkProfile { speed_mps, stairs: StairsPref::Never, escalators: false, lifts: true, wheelchair: true }
    }
    pub fn is_step_free(&self) -> bool {
        self.stairs == StairsPref::Never
    }
}

/// A position on the walking network.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Snap {
    pub edge: u32,
    /// Fraction of the edge length from node `a` (0..=1).
    pub frac: f32,
    /// The snapped point on the edge.
    pub pos: LatLon,
    /// Distance from the requested point to `pos` in metres.
    pub dist_m: f32,
}

/// How a Stop was attached to an OSM object.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum LinkMatch {
    /// Not attached to the network (no walkable edge nearby).
    None = 0,
    /// OSM platform with the same `ref:sloid`.
    Sloid = 1,
    /// OSM platform of the same stop (`uic_ref` or proximity) with the same label.
    Label = 2,
    /// Nearest suitable walkable edge to the registry coordinate.
    Nearest = 3,
}

/// Where a Stop sits relative to the street: "north side of Bubenbergplatz".
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SideInfo {
    /// Name of the road / square the reference line belongs to ("" if unnamed,
    /// or if the side would not hold for every carriageway of that name —
    /// a stop on an island in the middle of a square).
    pub street: String,
    /// The named street or square the stop is on or beside, whether or not
    /// `side` can be stated relative to it ("" if none nearby). Lets the app
    /// say "on Bubenbergplatz, south side of the road".
    pub place: String,
    /// Compass side of the reference line the stop is on, as an index into
    /// N, NE, E, SE, S, SW, W, NW; 255 = unknown.
    pub side: u8,
    /// 0 road, 1 tram track, 2 rail track (see [`CarriagewayKind`]); 255 = none found.
    pub ref_kind: u8,
    /// Distance from the stop to the reference line in metres.
    pub dist_m: f32,
    /// Bearing of the reference line (0..180) in degrees, -1 unknown.
    pub line_bearing: i16,
}

/// Attachment of one timetable Stop to the walking network.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StopLink {
    pub matched: LinkMatch,
    /// Valid unless `matched == LinkMatch::None`.
    pub snap: Snap,
    pub level: Level2,
    /// OSM object the stop was matched to (0 if none) and its type (0 node, 1 way, 2 relation).
    pub osm_id: i64,
    pub osm_type: u8,
    pub side: SideInfo,
}

/// Stop-to-stop walking connections, CSR by origin stop.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Footpaths {
    /// `to/var_m/fix_s[off[s] .. off[s+1]]` are the footpaths leaving stop `s`.
    pub off: Vec<u32>,
    pub to: Vec<StopIdx>,
    /// Speed-dependent metres (see module docs), saturating at 65 535.
    pub var_m: Vec<u16>,
    /// Speed-independent seconds.
    pub fix_s: Vec<u16>,
}

impl Footpaths {
    #[inline]
    pub fn from(&self, s: StopIdx) -> impl Iterator<Item = (StopIdx, u16, u16)> + '_ {
        let (lo, hi) = (self.off[s as usize] as usize, self.off[s as usize + 1] as usize);
        (lo..hi).map(move |i| (self.to[i], self.var_m[i], self.fix_s[i]))
    }
    pub fn get(&self, from: StopIdx, to: StopIdx) -> Option<(u16, u16)> {
        self.from(from).find(|&(t, _, _)| t == to).map(|(_, v, f)| (v, f))
    }
    pub fn len(&self) -> usize {
        self.to.len()
    }
    pub fn is_empty(&self) -> bool {
        self.to.is_empty()
    }
}

/// Output of the linker: one [`StopLink`] per timetable Stop plus the
/// precomputed footpaths for the two base profiles.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LinkData {
    pub links: Vec<StopLink>,
    /// Shortest walks for an unrestricted walker.
    pub normal: Footpaths,
    /// Shortest walks without stairs or escalators (wheelchair rules).
    pub step_free: Footpaths,
}

// ---------------------------------------------------------------- doors

pub const DOORS_SCHEMA: &str = "doors-v2";

/// What kind of way into a building a [`Door`] is: OSM `entrance=*` (or a bare
/// `door=*`), or a point of the official building address register.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum DoorKind {
    Main = 0,
    /// `entrance=yes`, a bare `door=*`, or an entrance value not listed here.
    Yes = 1,
    Shop = 2,
    Home = 3,
    Staircase = 4,
    Service = 5,
    Exit = 6,
    Emergency = 7,
    Garage = 8,
    /// `access=private|no` on an entrance that is not the main one.
    Private = 9,
    /// No door is mapped for the building: a point of the official building
    /// address register, put on the stretch of outline facing the open.
    Address = 10,
}

impl DoorKind {
    /// How much worse than the best door this kind is, in metres of walking
    /// (route choice only): back doors, garages and emergency exits only when
    /// there is nothing else; a register point when no mapped door is near.
    pub fn penalty_m(self) -> f32 {
        match self {
            DoorKind::Main | DoorKind::Yes | DoorKind::Shop | DoorKind::Home => 0.0,
            DoorKind::Staircase => 2.0,
            DoorKind::Address => 10.0,
            DoorKind::Service => 40.0,
            DoorKind::Exit => 60.0,
            DoorKind::Garage => 120.0,
            DoorKind::Emergency | DoorKind::Private => 200.0,
        }
    }
    /// OSM-style word for the API (`entrance=*`), `addr` for a register point.
    pub fn as_str(self) -> &'static str {
        match self {
            DoorKind::Main => "main",
            DoorKind::Yes => "yes",
            DoorKind::Shop => "shop",
            DoorKind::Home => "home",
            DoorKind::Staircase => "staircase",
            DoorKind::Service => "service",
            DoorKind::Exit => "exit",
            DoorKind::Emergency => "emergency",
            DoorKind::Garage => "garage",
            DoorKind::Private => "private",
            DoorKind::Address => "addr",
        }
    }
}

/// `Door::wheelchair`: OSM `wheelchair=*` on the entrance.
pub const DOOR_WC_UNKNOWN: u8 = 0;
pub const DOOR_WC_YES: u8 = 1;
pub const DOOR_WC_NO: u8 = 2;
pub const DOOR_WC_LIMITED: u8 = 3;

/// A way from a door onto the walking network: the straight line from the
/// door to `edge` at `frac`, `dist_m` long. It crosses no other building and
/// no railway track.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct DoorAttach {
    pub edge: u32,
    pub frac: f32,
    pub dist_m: f32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Door {
    pub pos: LatLon,
    pub kind: DoorKind,
    /// `DOOR_WC_*`.
    pub wheelchair: u8,
    /// The door's address ("Bundesgasse 3", "Bahnhofstrasse 12, 12a"):
    /// `Doors::addr[addr_off .. addr_off + addr_len]`, empty if none.
    pub addr_off: u32,
    pub addr_len: u16,
    /// `Doors::attach[attach_off .. attach_off + attach_len]`, nearest first;
    /// empty when no walkable way is within reach (the door is then not used).
    pub attach_off: u32,
    pub attach_len: u8,
}

/// A building with at least one door. Its outline (an outer ring of a
/// multipolygon building is a building of its own), stored open, is
/// `Doors::ring[ring_off .. ring_off + ring_len]` as offsets from `origin` in
/// 1e-6 degrees (about 10 cm; a building is never 3 km across).
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct DoorBuilding {
    pub origin: LatLon,
    pub ring_off: u32,
    pub ring_len: u16,
    pub door_len: u16,
    pub door_off: u32,
}

/// The buildings that have doors, and their doors, for walks that start in or
/// end at a building (`kante-link::doors`). Built from OSM and the official
/// building address register; see `docs/walking-routes.md`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Doors {
    pub buildings: Vec<DoorBuilding>,
    pub ring: Vec<[i16; 2]>,
    pub doors: Vec<Door>,
    pub attach: Vec<DoorAttach>,
    pub addr: String,
    /// `WalkGraph::edges.len()` of the graph the attachments refer to.
    pub graph_edges: u32,
}

impl Doors {
    /// The outline of building `b`.
    pub fn ring_of(&self, b: u32) -> impl Iterator<Item = LatLon> + '_ {
        let r = &self.buildings[b as usize];
        let o = r.origin;
        self.ring[r.ring_off as usize..r.ring_off as usize + r.ring_len as usize].iter().map(move |d| LatLon { lat: o.lat + d[0] as i32 * 10, lon: o.lon + d[1] as i32 * 10 })
    }
    /// Offsets of `ring` from `origin` as stored, or None if the outline is too big for them.
    pub fn pack_ring(origin: LatLon, ring: &[LatLon]) -> Option<Vec<[i16; 2]>> {
        ring.iter()
            .map(|p| {
                let (dl, dn) = ((p.lat - origin.lat) as f64 / 10.0, (p.lon - origin.lon) as f64 / 10.0);
                (dl.abs() < 32000.0 && dn.abs() < 32000.0).then(|| [dl.round() as i16, dn.round() as i16])
            })
            .collect()
    }
    #[inline]
    pub fn doors_of(&self, b: u32) -> std::ops::Range<u32> {
        let r = &self.buildings[b as usize];
        r.door_off..r.door_off + r.door_len as u32
    }
    #[inline]
    pub fn addr_of(&self, d: u32) -> &str {
        let d = &self.doors[d as usize];
        &self.addr[d.addr_off as usize..d.addr_off as usize + d.addr_len as usize]
    }
    #[inline]
    pub fn attach_of(&self, d: u32) -> &[DoorAttach] {
        let d = &self.doors[d as usize];
        &self.attach[d.attach_off as usize..d.attach_off as usize + d.attach_len as usize]
    }
}
