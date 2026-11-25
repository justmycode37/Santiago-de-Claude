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
//!
//! Hills add to `var_m`: the extra metres their slopes cost ([`crate::slope`]), which depend on the
//! direction walked, so a footpath up a hill takes longer than the same one down.

use crate::geo::LatLon;
use crate::timetable::StopIdx;
use serde::{Deserialize, Serialize};

pub const WALKGRAPH_SCHEMA: &str = "walkgraph-v1";
pub const LINKS_SCHEMA: &str = "links-v4";
pub const EXTRACT_SCHEMA: &str = "osm-extract-v2";

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
    /// One per edge, or empty when no terrain model is loaded (every edge flat). Not part of
    /// `walkgraph.bin`: `kante build` writes them to `slopes.bin` ([`crate::Slopes`]) and the server
    /// puts them here before it builds the router.
    #[serde(skip)]
    pub slopes: Vec<crate::slope::EdgeSlope>,
    /// What OpenStreetMap says about the edges and nodes beyond their kind and flags (sidewalks drawn apart, the
    /// size of a road, car-only service roads, opening hours, `crossing=no`), for route choice only. Not part of
    /// `walkgraph.bin`: `kante build` writes it to `walkattr.bin` ([`WalkAttrs`]); empty when there is none (every
    /// edge as before these were read).
    #[serde(skip)]
    pub attrs: WalkAttrs,
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

// ---------------------------------------------------------------- attributes (walkattr.bin)

pub const WALKATTR_SCHEMA: &str = "walkattr-v2";

/// [`WalkAttrs::edge`]: the size of the road a carriageway edge (`Road`, `RoadBusy`) belongs to.
pub const EA_ROAD: u8 = 0x07;
/// Not a road for cars (footways, paths, platforms … and cycleways, tracks).
pub const RC_NONE: u8 = 0;
/// residential, unclassified, living_street, road.
pub const RC_MINOR: u8 = 1;
pub const RC_SERVICE: u8 = 2;
pub const RC_TERTIARY: u8 = 3;
pub const RC_SECONDARY: u8 = 4;
pub const RC_PRIMARY: u8 = 5;
pub const RC_TRUNK: u8 = 6;
/// The road's sidewalks are drawn as ways of their own (`sidewalk[:both|:left|:right]=separate` with none tagged on
/// the road itself, or `foot=use_sidepath`): walking on the carriageway is a last resort.
pub const EA_SIDEWALK_SEPARATE: u8 = 1 << 3;
/// A space for cars: `service=parking_aisle|driveway|drive-through`, or a service road whose access is limited
/// (`destination`, `customers`, `delivery`, …).
pub const EA_CAR_ONLY: u8 = 1 << 4;
/// A way for walking away from traffic: a pedestrian street or square, a footway or path that is not a sidewalk,
/// or any footway or path in a park.
pub const EA_FAVOURED: u8 = 1 << 5;
/// Has opening hours or a closing condition ([`WalkAttrs::edge_hours`]).
pub const EA_HOURS: u8 = 1 << 6;

/// [`WalkAttrs::node`]: `crossing=no`: walkers may not cross the road here.
pub const NA_CROSSING_NO: u8 = 1 << 0;

/// [`WalkAttrs::kerb`]: a sidewalk on the left of the edge, looking from node `a` to node `b` (the way's own
/// direction: edges keep it).
pub const KB_LEFT: u8 = 1 << 0;
/// A sidewalk on the right of the edge, looking from `a` to `b`.
pub const KB_RIGHT: u8 = 1 << 1;
/// The road says where its sidewalks are (`sidewalk*=*`, `no` included): without it, [`KB_LEFT`] and [`KB_RIGHT`]
/// are unknown, not absent.
pub const KB_TAGGED: u8 = 1 << 2;
/// A roundabout, or a one-way main road (likely one half of a divided road): which edge is the outer one cannot be
/// told from the way alone, so without [`KB_TAGGED`] a walk along it stays on its line.
pub const KB_NO_GUESS: u8 = 1 << 3;
/// The carriageway's width in metres (`width`, else `lanes`), 0 when the road does not say.
pub const KB_WIDTH_SHIFT: u8 = 4;
pub const KB_WIDTH: u8 = 0x0f << KB_WIDTH_SHIFT;

/// Per edge and per node of a [`WalkGraph`], what route choice reads beyond kinds and flags. Built by `kante-osm`
/// with the graph (see its crate docs); [`WalkAttrs::fits`] says whether it belongs to a graph.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct WalkAttrs {
    /// [`graph_fingerprint`] of the graph it was made for.
    pub graph: u64,
    /// `EA_*`, one per edge.
    pub edge: Vec<u8>,
    /// `NA_*`, one per node.
    pub node: Vec<u8>,
    /// The hours read: `oh:<opening_hours>` (open while it holds) or `no:<condition>` (closed while it holds).
    pub hours: Vec<String>,
    /// (edge, index into `hours`), ascending by edge, for the edges with `EA_HOURS`.
    pub edge_hours: Vec<(u32, u32)>,
    /// `KB_*`, one per edge: where a carriageway's sidewalks are and how wide it is, for drawing a walk along the
    /// road at its edge rather than down its middle. Not read by route choice.
    pub kerb: Vec<u8>,
}

impl WalkAttrs {
    pub fn fits(&self, g: &WalkGraph) -> bool {
        self.edge.len() == g.edges.len() && self.node.len() == g.nodes.len() && (self.kerb.is_empty() || self.kerb.len() == g.edges.len())
    }
    #[inline]
    pub fn kerb(&self, e: u32) -> u8 {
        self.kerb.get(e as usize).copied().unwrap_or(0)
    }
    #[inline]
    pub fn edge(&self, e: u32) -> u8 {
        self.edge.get(e as usize).copied().unwrap_or(0)
    }
    #[inline]
    pub fn node(&self, n: u32) -> u8 {
        self.node.get(n as usize).copied().unwrap_or(0)
    }
    /// The road size of a carriageway edge ([`RC_NONE`] … [`RC_TRUNK`]).
    #[inline]
    pub fn road(&self, e: u32) -> u8 {
        self.edge(e) & EA_ROAD
    }
    /// The hours of an edge, parsed: `None` when it has none or they cannot be read (open).
    pub fn hours_of(&self, e: u32) -> Option<crate::Hours> {
        let i = self.edge_hours.binary_search_by_key(&e, |x| x.0).ok()?;
        parse_hours_entry(&self.hours[self.edge_hours[i].1 as usize])
    }
}

/// An entry of [`WalkAttrs::hours`], parsed.
pub fn parse_hours_entry(s: &str) -> Option<crate::Hours> {
    if let Some(v) = s.strip_prefix("oh:") {
        crate::parse_opening_hours(v)
    } else if let Some(v) = s.strip_prefix("no:") {
        crate::parse_closing_condition(v)
    } else {
        None
    }
}

/// Changes whenever the attributes do.
pub fn attrs_fingerprint(a: &WalkAttrs) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325 ^ a.graph;
    let mut mix = |v: u64| {
        h = (h ^ v).wrapping_mul(0x0000_0100_0000_01b3);
    };
    mix(a.edge.len() as u64);
    for c in a.edge.chunks(8).chain(a.node.chunks(8)).chain(a.kerb.chunks(8)) {
        mix(c.iter().fold(0u64, |x, &b| x << 8 | b as u64));
    }
    for &(e, i) in &a.edge_hours {
        mix((e as u64) << 32 | i as u64);
    }
    for s in &a.hours {
        for c in s.as_bytes().chunks(8) {
            mix(c.iter().fold(0u64, |x, &b| x << 8 | b as u64));
        }
    }
    h
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
    /// In a tunnel, on a bridge, or on another floor (`tunnel`, `bridge`, `layer`, `level`): not on the ground.
    pub off_ground: bool,
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
    /// and impassable barriers, and penalises rough surfaces (and grades over 6 %).
    pub wheelchair: bool,
    /// How much hills matter for route choice ([`crate::slope`]); the time always counts them.
    pub hills: crate::slope::HillsPref,
    /// The search runs against the direction of travel: from where the walk ends back to where it starts (an
    /// egress search, from the destination to the stops), so every arc costs what walking it the other way does
    /// (its slopes: up a hill is not down it).
    pub backwards: bool,
    /// When the walk is walked (local time), for ways with opening hours ([`WalkAttrs::edge_hours`]): one closed
    /// then is avoided. `None`: not known, every way open.
    pub at: Option<crate::WalkTime>,
}

impl WalkProfile {
    pub const fn normal(speed_mps: f32) -> Self {
        WalkProfile { speed_mps, stairs: StairsPref::Ok, escalators: true, lifts: true, wheelchair: false, hills: crate::slope::HillsPref::Normal, backwards: false, at: None }
    }
    /// Strict step-free: no stairs, no escalators, wheelchair rules.
    pub const fn step_free(speed_mps: f32) -> Self {
        WalkProfile { speed_mps, stairs: StairsPref::Never, escalators: false, lifts: true, wheelchair: true, hills: crate::slope::HillsPref::Normal, backwards: false, at: None }
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
    /// What a router derives from these footpaths (see [`crate::DerivedSlot`]);
    /// not part of the data, and empty in a clone. It is filled by the first
    /// query that uses the set and not checked against later changes: after
    /// changing `to`, `var_m` or `fix_s` in place, replace it with
    /// `Default::default()`.
    #[doc(hidden)]
    #[serde(skip)]
    pub derived: crate::live::DerivedSlot,
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
    /// What the links were made from: [`graph_fingerprint`] of the walk graph and
    /// [`crate::Timetable::stops_fingerprint`] of the timetable (stops are linked by index, edges by number).
    pub graph: u64,
    pub timetable: u64,
    /// [`crate::slopes_fingerprint`] of the slopes the footpaths were timed with (0: none, all flat).
    pub slopes: u64,
}

// ---------------------------------------------------------------- doors

pub const DOORS_SCHEMA: &str = "doors-v6";

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
/// door to `edge` at `frac`, `dist_m` long. It crosses no railway track on the
/// ground; one that runs through a building is marked (`through`), one that walks over a carriageway on the ground
/// to reach another way (the sidewalk across the street) too (`crosses`, `crosses_busy`). Stored in 8 bytes.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct DoorAttach {
    pub edge: u32,
    /// Fraction of the edge × 65 535.
    pub frac_q: u16,
    /// Decimetres (at most 819.1 m); the top bit: the line runs through a building (the way round it is not mapped:
    /// a guess); the next two: it walks over a carriageway ([`DoorAttach::crosses`]), a busy one.
    pub dist_dm: u16,
}

impl DoorAttach {
    const THROUGH: u16 = 1 << 15;
    const CROSSES: u16 = 1 << 14;
    const BUSY: u16 = 1 << 13;
    const DM: u16 = (1 << 13) - 1;
    /// `crosses`: the line walks over a carriageway on the ground to reach the way (`Some(true)`: a busy one).
    pub fn new(edge: u32, frac: f32, dist_m: f32, through: bool, crosses: Option<bool>) -> Self {
        let dm = (dist_m * 10.0).round().min(Self::DM as f32) as u16;
        let bits = if through { Self::THROUGH } else { 0 }
            | match crosses {
                Some(true) => Self::CROSSES | Self::BUSY,
                Some(false) => Self::CROSSES,
                None => 0,
            };
        DoorAttach { edge, frac_q: (frac.clamp(0.0, 1.0) * 65535.0).round() as u16, dist_dm: dm | bits }
    }
    /// The line runs through a building: the walk round it is not mapped.
    #[inline]
    pub fn through(&self) -> bool {
        self.dist_dm & Self::THROUGH != 0
    }
    /// The line walks over a carriageway on the ground to reach its way: `Some(true)` a busy one (tertiary and up, or
    /// one whose sidewalks are drawn apart).
    #[inline]
    pub fn crosses(&self) -> Option<bool> {
        (self.dist_dm & Self::CROSSES != 0).then_some(self.dist_dm & Self::BUSY != 0)
    }
    #[inline]
    pub fn frac(&self) -> f32 {
        self.frac_q as f32 / 65535.0
    }
    #[inline]
    pub fn dist_m(&self) -> f32 {
        (self.dist_dm & Self::DM) as f32 * 0.1
    }
}

/// [`Door::faces`]: not known (no address, or no named street near).
pub const DOOR_FACES_UNKNOWN: u8 = 0;
/// The nearest named street the door looks onto is its address's.
pub const DOOR_FACES_OWN: u8 = 1;
/// The nearest named street the door looks onto is another one (a side or back door of its address).
pub const DOOR_FACES_OTHER: u8 = 2;

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Door {
    pub pos: LatLon,
    pub kind: DoorKind,
    /// `DOOR_WC_*`.
    pub wheelchair: u8,
    /// `DOOR_FACES_*`: whether the street the door looks onto is its address's.
    pub faces: u8,
    /// The door's address ("Bundesgasse 3", "Bahnhofstrasse 12, 12a"):
    /// `Doors::addr[addr_off .. addr_off + addr_len]`, empty if none.
    pub addr_off: u32,
    pub addr_len: u16,
    /// `Doors::attach[attach_off .. attach_off + attach_len]`, best first;
    /// empty when no walkable way is within reach (the door is then not used,
    /// but its building still counts as one: a walk into it is a guess).
    pub attach_off: u32,
    pub attach_len: u8,
}

/// A building of OpenStreetMap, with its doors if it has any. Its outline (an
/// outer ring of a multipolygon building is a building of its own) and its
/// courtyards, each stored open, are `Doors::ring[ring_off .. ring_off +
/// ring_len]` as offsets from `origin` in 1e-6 degrees (about 10 cm; a
/// building is never 3 km across), the rings separated by [`RING_BREAK`].
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct DoorBuilding {
    pub origin: LatLon,
    pub ring_off: u32,
    pub ring_len: u16,
    pub door_len: u16,
    pub door_off: u32,
}

/// Every building and its doors, for walks that start in or end at a building
/// and for telling a straight line through a building (`kante-link::doors`).
/// Built from OSM and the official building address register; see
/// `kante/docs/WALK-ENDS.md`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Doors {
    pub buildings: Vec<DoorBuilding>,
    pub ring: Vec<[i16; 2]>,
    pub doors: Vec<Door>,
    pub attach: Vec<DoorAttach>,
    pub addr: String,
    /// [`graph_fingerprint`] of the graph the attachments refer to.
    pub graph: u64,
    /// Railway tracks on the ground, segment by segment: a straight line onto the network across one is a guess.
    pub rails: Vec<[LatLon; 2]>,
}

/// Between two rings of a building in `Doors::ring`.
pub const RING_BREAK: [i16; 2] = [i16::MIN, i16::MIN];

/// Changes whenever the graph does: nodes, edges (ends, kind, levels, flags, length) and every point of their
/// geometry. Ties caches that refer to edges by number to the graph they were made for.
pub fn graph_fingerprint(g: &WalkGraph) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut mix = |v: u64| {
        h = (h ^ v).wrapping_mul(0x0000_0100_0000_01b3);
    };
    mix(g.nodes.len() as u64);
    mix(g.edges.len() as u64);
    for e in &g.edges {
        mix(((e.a as u64) << 32) | e.b as u64);
        mix(((e.len_dm as u64) << 32) | ((e.flags as u64) << 16) | ((e.kind as u64) << 8) | e.steps as u64);
        mix(((e.level_a as u8 as u64) << 48) | ((e.level_b as u8 as u64) << 40) | ((e.geom_len as u64) << 32) | e.geom_off as u64);
    }
    for n in &g.nodes {
        mix(((n.lat as u32 as u64) << 32) | n.lon as u32 as u64);
    }
    for p in &g.geom {
        mix(((p.lat as u32 as u64) << 32) | p.lon as u32 as u64);
    }
    h
}

impl Doors {
    /// The rings of building `b`: its outline, then its courtyards.
    pub fn rings_of(&self, b: u32) -> Vec<Vec<LatLon>> {
        let r = &self.buildings[b as usize];
        let o = r.origin;
        self.ring[r.ring_off as usize..r.ring_off as usize + r.ring_len as usize]
            .split(|d| *d == RING_BREAK)
            .map(|ring| ring.iter().map(|d| LatLon { lat: o.lat + d[0] as i32 * 10, lon: o.lon + d[1] as i32 * 10 }).collect())
            .collect()
    }
    /// Rings as stored: offsets from `origin`, [`RING_BREAK`] between them; None if a ring is too big for them.
    pub fn pack_rings(origin: LatLon, rings: &[&[LatLon]]) -> Option<Vec<[i16; 2]>> {
        let mut out = Vec::new();
        for (i, ring) in rings.iter().enumerate() {
            if i > 0 {
                out.push(RING_BREAK);
            }
            for p in ring.iter() {
                let (dl, dn) = ((p.lat - origin.lat) as f64 / 10.0, (p.lon - origin.lon) as f64 / 10.0);
                if !(dl.abs() < 32000.0 && dn.abs() < 32000.0) {
                    return None;
                }
                out.push([dl.round() as i16, dn.round() as i16]);
            }
        }
        Some(out)
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
