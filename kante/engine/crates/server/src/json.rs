//! Wire types of the HTTP API. Mirrors `app/src/api/types.ts` field for field.

use serde::{Deserialize, Serialize};

fn is_zero(v: &u8) -> bool {
    *v == 0
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LineBadge {
    pub name: String,
    pub category: String,
    pub mode: &'static str,
    pub operator: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub lat: f64,
    pub lon: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<Vec<&'static str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dist_m: Option<u32>,
    /// `/api/search`: what to draw for it ("station", "address", or for a place "restaurant", "museum" …;
    /// the keys are listed in kante/docs/SEARCH.md).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// `/api/search`, places: their category ("Restaurant"), also the first part of `detail`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// `/api/search`, places: cuisine, opening hours, website, phone, photo, Wikidata items, when mapped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub info: Option<kante_search::PoiInfo>,
}

#[derive(Serialize)]
pub struct SearchResponse {
    pub results: Vec<Place>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QuaySide {
    pub street: String,
    pub side: &'static str,
    pub of: &'static str,
    pub text: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Quay {
    pub id: String,
    pub sloid: String,
    pub station_id: String,
    pub station_name: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sectors: Option<String>,
    pub noun: &'static str,
    pub lat: f64,
    pub lon: f64,
    pub precision: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<QuaySide>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access: Option<&'static str>,
    pub modes: Vec<&'static str>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct PlanOptions {
    pub walk_speed: f32,
    pub stairs: String,
    pub escalators: bool,
    pub wheelchair: bool,
    /// How much hills matter for the way taken: "ignore" (the quickest way, hills or not), "normal" (a flatter way
    /// when it is little longer), "avoid" (a flatter way even when it is a few minutes longer). Walking times count
    /// hills whatever this says.
    pub hills: String,
    /// At a change with time to spare, walk a flatter way (as "avoid" would) when it still leaves a minute in
    /// hand. Not with `hills: "ignore"` or `"avoid"` (that walks the flatter way anyway).
    pub flatter_changes: bool,
    /// Seconds added to every change, on top of the walk between the two boarding points (0: a change takes that
    /// walk and no more).
    pub transfer_margin_s: i32,
    /// The longest walk to the first stop and from the last. A journey with a longer one (up to twice as long) is
    /// offered beside the others where it has half an hour on them, and where nothing can be reached within it
    /// (`App::plan`); it carries a `long-walk` alert.
    pub max_walk_min: f32,
    pub modes: Option<Vec<String>>,
    /// The most changes a journey may have; left out: as many as the planner can follow (`kante_raptor::MAX_RIDES`
    /// rides).
    pub max_transfers: Option<u8>,
}

impl Default for PlanOptions {
    fn default() -> Self {
        PlanOptions {
            walk_speed: 1.3,
            stairs: "ok".into(),
            escalators: true,
            wheelchair: false,
            hills: "normal".into(),
            flatter_changes: true,
            transfer_margin_s: 0,
            max_walk_min: 20.0,
            modes: None,
            max_transfers: None,
        }
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PlaceRef {
    pub id: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub name: Option<String>,
    /// `/api/walk` only: a boarding point (quay id or SLOID). The walk then starts or ends on that
    /// platform or bay, on its floor, as a change in a journey does; `lat`/`lon` are ignored.
    pub quay: Option<String>,
    /// `/api/walk` only: the point as it is (where a station model's own paths begin), not the door of the
    /// building it lies in.
    pub exact: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OnboardRef {
    pub trip_id: String,
    pub service_date: String,
    #[serde(default)]
    pub next_seq: Option<u16>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlanRequest {
    #[serde(default)]
    pub from: Option<PlaceRef>,
    pub to: PlaceRef,
    #[serde(default)]
    pub time: Option<i64>,
    #[serde(default)]
    pub arrive_by: bool,
    #[serde(default)]
    pub onboard: Option<OnboardRef>,
    #[serde(default)]
    pub options: PlanOptions,
    #[serde(default)]
    pub page: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WalkRequest {
    pub from: PlaceRef,
    pub to: PlaceRef,
    #[serde(default)]
    pub options: PlanOptions,
    /// The walk this walker prefers when it takes at most this many seconds, else the quickest (a change asked
    /// again: what there is time for).
    #[serde(default)]
    pub limit_s: Option<f32>,
    /// When the walk sets out (Unix seconds): ways closed then (opening hours) are avoided. Without it every way is
    /// open, and the walk is timed from now.
    #[serde(default)]
    pub time: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanResponse {
    pub from: Place,
    pub to: Place,
    pub journeys: Vec<Journey>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub walk_only: Option<Journey>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub earlier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub later: Option<String>,
    pub took_ms: f64,
    pub realtime: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Journey {
    pub id: String,
    pub dep: i64,
    pub arr: i64,
    pub duration_s: i64,
    pub transfers: u8,
    pub walk_s: i64,
    pub walk_m: u32,
    pub legs: Vec<Leg>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub alerts: Vec<JourneyAlert>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JourneyAlert {
    pub severity: &'static str,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leg: Option<usize>,
    pub text: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Leg {
    Ride(RideLeg),
    Walk(WalkLeg),
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RideLeg {
    pub line: LineBadge,
    pub headsign: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    pub trip_id: String,
    pub service_date: String,
    pub from: StopCall,
    pub to: StopCall,
    pub intermediate: Vec<StopCall>,
    pub geometry: Vec<[f64; 2]>,
    /// The way the vehicle takes, on the rails and roads (`geometry` is the straight line through the stops): from
    /// where it stands at the first call (beside the boarding point) to where it stands at the last. Empty where not
    /// known.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub path: Vec<[f64; 2]>,
    /// Per call: its vertex in `path`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub path_at: Vec<u32>,
    /// The hops (by the index of the call they start at) where `path` is a straight line: a stop off the map.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub straight_hops: Vec<u16>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub stay_on_board: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub onboard: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headway_s: Option<u16>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cancelled: bool,
    pub live: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub towards: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bearing: Option<f32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StopCall {
    pub seq: u16,
    pub quay: Quay,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arr: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dep: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arr_delay_s: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dep_delay_s: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub planned_label: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub skipped: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub on_request: bool,
    /// The times here come from a live feed (reported, or carried on from an
    /// earlier report), not from the timetable. Delays are only live where this is set.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub live: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WalkPoint {
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quay: Option<Quay>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WalkLeg {
    pub kind: &'static str,
    pub from: WalkPoint,
    pub to: WalkPoint,
    pub dep: i64,
    pub arr: i64,
    pub duration_s: i64,
    pub distance_m: u32,
    /// Metres climbed and descended (from the terrain model; 0 without one).
    #[serde(skip_serializing_if = "is_zero_u32")]
    pub climb_m: u32,
    #[serde(skip_serializing_if = "is_zero_u32")]
    pub descent_m: u32,
    /// A change walked a flatter way than the quickest, because there is time for it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flatter: Option<FlatterWay>,
    pub stairs_up: u16,
    pub stairs_down: u16,
    pub lifts: u8,
    pub escalators: u8,
    pub step_free: bool,
    #[serde(skip_serializing_if = "is_zero")]
    pub unmapped_level_changes: u8,
    /// Metres on ways closed at the walk's time (opening hours), taken because no open way would do.
    #[serde(skip_serializing_if = "is_zero_u32")]
    pub closed_m: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slack_s: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub official_min_s: Option<u16>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub approximate: bool,
    pub geometry: Vec<[f64; 2]>,
    pub levels: Vec<Option<f32>>,
    pub steps: Vec<WalkStep>,
    /// The door of the destination building the walk ends at (its last vertex).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub door: Option<WalkDoor>,
    /// The door of the building the walk starts in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_door: Option<WalkDoor>,
    /// Vertex ranges under a roof: arcades, passages through buildings, underpasses, indoors.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub covered: Vec<WalkCovered>,
    /// Vertices `0 ..= approxStart` are a guess (a straight line across open ground, or out of a building
    /// through no known door); likewise `approxEnd ..` at the end.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approx_start: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approx_end: Option<u32>,
    /// Vertices `network[0] ..= network[1]` are on the walking network; the others are the straight lines from the
    /// point (into its building's door and out of it) and to the door or point at the end.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<[u32; 2]>,
    /// Step-free: the destination building has doors, but none is step-free.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub no_step_free_door: bool,
    /// It starts or ends with a line through a building or onto another floor (not sent: a journey's alert says so).
    #[serde(skip)]
    pub unsure_end: bool,
    /// The seconds of the walk drawn (not sent): a journey's first and last walks are timed by it.
    #[serde(skip)]
    pub drawn_s: Option<i64>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FlatterWay {
    /// Seconds longer than the quickest way.
    pub extra_s: i64,
    /// Metres less climbed than on the quickest way.
    pub less_climb_m: u32,
}

fn is_zero_u32(v: &u32) -> bool {
    *v == 0
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WalkDoor {
    pub lat: f64,
    pub lon: f64,
    /// OSM `entrance=*` (main, yes, shop, service, …), or `addr` for a point of the building address register.
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub addr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wheelchair: Option<&'static str>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WalkCovered {
    pub kind: &'static str,
    pub from: u32,
    pub to: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WalkStep {
    pub kind: &'static str,
    pub text: String,
    pub dist_m: u32,
    pub dur_s: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_level: Option<f32>,
    pub from: u32,
    pub to: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeparturesResponse {
    pub station: Place,
    pub quays: Vec<Quay>,
    pub departures: Vec<Departure>,
    pub realtime: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Departure {
    pub line: LineBadge,
    pub headsign: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    pub trip_id: String,
    pub service_date: String,
    pub seq: u16,
    pub dep: i64,
    pub live: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delay_s: Option<i32>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cancelled: bool,
    pub quay_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub planned_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub towards: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bearing: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headway_s: Option<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TripResponse {
    pub trip_id: String,
    pub service_date: String,
    pub line: LineBadge,
    pub headsign: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    pub calls: Vec<StopCall>,
    pub geometry: Vec<[f64; 2]>,
    /// The way the vehicle takes, on the rails and roads (`geometry` is the straight line through the stops): from
    /// where it stands at the first call (beside the boarding point) to where it stands at the last. Empty where not
    /// known.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub path: Vec<[f64; 2]>,
    /// Per call: its vertex in `path`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub path_at: Vec<u32>,
    /// The hops (by the index of the call they start at) where `path` is a straight line: a stop off the map.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub straight_hops: Vec<u16>,
    pub live: &'static str,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headway_s: Option<u16>,
    pub live_info: LiveInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<Position>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub extra: bool,
}

#[derive(Serialize)]
pub struct VehiclesResponse {
    pub t: i64,
    pub vehicles: Vec<Vehicle>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vehicle {
    pub trip_id: String,
    pub service_date: String,
    pub line: LineBadge,
    pub headsign: String,
    pub from: [f64; 2],
    pub to: [f64; 2],
    pub dep: i64,
    pub arr: i64,
    pub next_stop: String,
    pub next_seq: u16,
    pub live: &'static str,
    pub frac: f32,
    pub basis: &'static str,
    pub live_info: LiveInfo,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub extra: bool,
    /// As on `Position`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_path: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub hop_straight: bool,
    /// As on `Position`: `/api/vehicles` sends only the part of a long hop's way near the window asked about.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_span: Option<[f32; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point: Option<[f64; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading: Option<f32>,
    /// How it moves on the hop: [accel, brake, cruise] (m/s², m/s², m/s): from `dep`, speeding up at `accel` to
    /// `cruise`, running at it, braking at `brake` into the stop at `arr`. Absent: at an even pace.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motion: Option<[f32; 3]>,
    /// The hop's length on its way, metres (with `motion`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_len: Option<f32>,
    /// The hop after this one: from the stop it stands at (or is heading for, `nextSeq`) on to the next it serves.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onward: Option<Onward>,
    /// The hop before: the way it came along into the stop it stands at (or has left, `seq`), so a page can draw its
    /// whole length on its way.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<Behind>,
}

/// The way of the hop a vehicle came along (`Vehicle::behind`): as `hopPath` / `hopSpan` are for the hop it is on.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Behind {
    pub hop_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_span: Option<[f32; 2]>,
}

/// The hop a vehicle drives after the one it is on (`Vehicle::onward`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Onward {
    /// The stop it is heading for then, and its boarding point.
    pub next_seq: u16,
    pub to: [f64; 2],
    /// When it leaves the stop it stands at or is heading for, and reaches `nextSeq` (as `dep`/`arr` are timed).
    pub dep: i64,
    pub arr: i64,
    /// Its way, as `hopPath` / `hopStraight` / `hopSpan` are for the hop it is on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_path: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub hop_straight: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_span: Option<[f32; 2]>,
    /// How it moves on the hop: [accel, brake, cruise] (m/s², m/s², m/s): from `dep`, speeding up at `accel` to
    /// `cruise`, running at it, braking at `brake` into the stop at `arr`. Absent: at an even pace.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motion: Option<[f32; 3]>,
    /// The hop's length on its way, metres (with `motion`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_len: Option<f32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaResponse {
    pub feed_version: String,
    pub valid_from: String,
    pub valid_to: String,
    pub walk_bbox: [f64; 4],
    pub realtime: RealtimeMeta,
    /// Optional parts this engine has (see docs/LIVE-API.md).
    pub features: Vec<&'static str>,
    pub counts: Counts,
    pub attribution: Vec<&'static str>,
    /// The commit this engine was built from: `KANTE_COMMIT` at `cargo build`; null for a build without it (a plain
    /// `cargo build`).
    pub commit: Option<&'static str>,
    /// The release this process runs from: the name of the folder its executable is in (`deploy/` builds each
    /// release into a folder of its own, also the same commit again when the data is refreshed); null if the
    /// executable's path cannot be read.
    pub release: Option<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeMeta {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trips: Option<usize>,
    /// Journeys that are not in the timetable (replacement buses, extra trains).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extras: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub feeds: Vec<FeedStatus>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FeedStatus {
    pub name: &'static str,
    /// The feed's own timestamp of its last document.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    /// When that document was fetched and parsed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub polled_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub journeys: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub stations: usize,
    pub quays: usize,
    pub trips: usize,
    pub walk_edges: usize,
    /// Doors of buildings the walks may start or end at (0 without `doors.bin`).
    pub doors: usize,
    /// ... of which placed from the official building address register (0 when it was not there at build time).
    pub register_doors: usize,
    /// Walk edges with a slope from the terrain model (0 without `slopes.bin`: walks timed as if flat).
    pub sloped_edges: usize,
}

// ------------------------------------------------------------------ live data (see docs/LIVE-API.md)

/// How sure a trip's live times are.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LiveInfo {
    /// `observed`, `predicted`, `timetable` or `stale`.
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_seq: Option<u16>,
    /// `arr`, `dep` or `arr+dep`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub age_s: Option<i64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub inaccurate: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub congestion: bool,
}

/// Where a vehicle is at `t`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    /// `before-start`, `at`, `between` or `ended`.
    pub state: &'static str,
    pub seq: u16,
    pub from: [f64; 2],
    pub to: [f64; 2],
    pub frac: f32,
    /// `observed-stop`, `forecast` or `timetable`.
    pub basis: &'static str,
    pub t: i64,
    /// `between`: the stop it is heading for (`seq` + 1, or later when stops are skipped).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_seq: Option<u16>,
    /// The times the position is timed by: `between` → leaving `seq` and reaching
    /// `nextSeq` (so a page can move the vehicle on from `frac` at `t`); `at` → its
    /// arrival and departure at `seq`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dep: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arr: Option<i64>,
    /// `between`: the way from `from` to `to` on the rails and roads (Google encoded polyline, precision 5),
    /// from where the vehicle stands at `seq` to where it stands at `nextSeq`. Absent where only the straight line
    /// is known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_path: Option<String>,
    /// Some of `hopPath` is a straight line (a stop off the map).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub hop_straight: bool,
    /// When `hopPath` is only part of the hop's way: the shares of the whole way's length (0..1) it starts and ends
    /// at. The vehicle is at `frac` of the whole way: on the part at (`frac` − start) / (end − start).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_span: Option<[f32; 2]>,
    /// Where the vehicle is at `t` on its track or road: `between`, as far along `hopPath` as `motion` takes it in
    /// `frac` of the hop's time; otherwise
    /// where it stands at `seq` (beside its boarding point). Absent where not known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point: Option<[f64; 2]>,
    /// `between`: the direction it drives in at `point`, degrees from north.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading: Option<f32>,
    /// How it moves on the hop: [accel, brake, cruise] (m/s², m/s², m/s): from `dep`, speeding up at `accel` to
    /// `cruise`, running at it, braking at `brake` into the stop at `arr`. Absent: at an even pace.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motion: Option<[f32; 3]>,
    /// The hop's length on its way, metres (with `motion`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_len: Option<f32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchRef {
    pub trip_id: String,
    pub service_date: String,
    pub from_seq: u16,
    /// Where the ride ends on this trip; absent when it ends on a trip this one
    /// continues as (`then`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_seq: Option<u16>,
    /// Trips this one continues as, in order, when the ride stays seated into
    /// them (e.g. a train that changes its number on the way). The last one has `toSeq`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub then: Vec<MatchNext>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MatchNext {
    pub trip_id: String,
    pub service_date: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_seq: Option<u16>,
}

#[derive(Serialize)]
pub struct MatchResponse {
    #[serde(rename = "match")]
    pub matched: Option<MatchRef>,
    pub candidates: usize,
    /// `unique`, `ambiguous` or `none`.
    pub reason: &'static str,
}

#[derive(Serialize)]
pub struct DueResponse {
    pub t: i64,
    /// Nothing is missing: not cut at `limit`, and every live feed answered within the last 5 minutes.
    pub complete: bool,
    /// More trips were due than `limit`.
    pub truncated: bool,
    pub due: Vec<Due>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Due {
    pub trip_id: String,
    pub service_date: String,
    pub seq: u16,
    pub line: LineBadge,
    pub headsign: String,
    pub number: Option<String>,
    pub vias: Vec<String>,
    pub quay_id: String,
    pub quay_label: String,
    pub planned_label: Option<String>,
    pub arr: Option<i64>,
    pub dep: Option<i64>,
    pub delay_s: Option<i32>,
    pub cancelled: bool,
    pub approach_bearing: Option<f32>,
    pub depart_bearing: Option<f32>,
    /// `approaching`, `at-stop` or `departed`.
    pub state: &'static str,
    pub eta_s: i64,
    pub live_info: LiveInfo,
    pub extra: bool,
    /// `arr`/`dep` come from the learned hop and dwell profiles after a measured stop, not the forecast.
    pub profiled: bool,
    /// Where `profiled`: the forecast's own times, before the profiles (to compare the two later).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forecast_arr: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forecast_dep: Option<i64>,
    /// As timetabled.
    pub aimed_arr: Option<i64>,
    pub aimed_dep: Option<i64>,
    /// Riders may board here (false: it only sets down, or is skipped today).
    pub pickup: bool,
    /// With `to=`: whether it calls at that station after this stop and lets riders off there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serves_to: Option<bool>,
    /// The boarding points of the stop before and after this one (where it comes from and goes to); null at an end.
    pub prev_stop: Option<[f64; 2]>,
    pub next_stop: Option<[f64; 2]>,
}

// ------------------------------------------------------------------ /api/identify

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentifyResponse {
    pub t: i64,
    /// `match`, `ambiguous` or `none`.
    pub result: &'static str,
    /// The winner's score, only for `match` (a ranking, not a probability).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    /// Best first, at most five; for `match` the first is the match.
    pub candidates: Vec<IdentifyCandidate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentifyCandidate {
    pub trip_id: String,
    pub service_date: String,
    pub score: f32,
    pub line: LineBadge,
    pub headsign: String,
    /// The call the vehicle is at or heading for.
    pub seq: u16,
    /// The boarding point when the vehicle was found at a stop.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quay_id: Option<String>,
    /// That call and the ones after it (skipped stops left out).
    pub downstream: Vec<DownstreamStop>,
    pub evidence: IdentifyEvidence,
    pub live_info: LiveInfo,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub extra: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownstreamStop {
    pub seq: u16,
    pub station: String,
    pub quay_id: String,
    /// Live arrival, unix seconds (scheduled where there is no live data).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arr: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentifyEvidence {
    /// `exact`, `confusable`, `unseen` (`contradicted` candidates are left out).
    pub line: &'static str,
    /// How well the destination text read fits the headsign or a via, 0…1; absent when none was read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<f32>,
    pub distance_m: u32,
    pub time_off_s: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bearing_diff: Option<f32>,
}
