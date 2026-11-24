# Kante — architecture and contracts

Kante is a mobile-first web app (PWA) for door-to-door public transport in
Switzerland. Its point of difference: it routes to the **individual boarding
point** (bus bay, tram edge, track + sector, pier — Swiss German "Kante"), walks
you there on a real multi-level pedestrian network at **your** walking speed,
and can start a journey from **inside a running vehicle**.

Pilot area for detailed walking is Bern; timetable routing is national. Nothing
in the design is Bern-specific: the walking area is a bounding box option.

```
 opentransportdata.swiss            OpenStreetMap (Geofabrik CH extract)
 ┌───────────────────────┐          ┌──────────────────────────────┐
 │ GTFS static (national)│          │ switzerland-latest.osm.pbf   │
 │ atlas boarding points │          └──────┬───────────────┬───────┘
 │ SIRI-ET / GTFS-RT     │                 │               │
 └───┬────────────┬──────┘                 ▼               ▼
     │            │                  kante-osm        kante-search
     ▼            │                  WalkGraph +      addresses, POIs
 kante-gtfs       │                  OsmExtract       + stations
 Timetable        │                        │               │
     │            │        kante-link ◄────┤               │
     │            │        StopLink + Footpaths            │
     ▼            ▼              │         ▼               │
 kante-raptor  kante-rt          │    kante-walk           │
 journeys      live updates      │    snap/route/steps     │
     └────────────┴──────────────┴─────────┴───────────────┘
                              │
                        kante-server  (axum; JSON API in app/src/api/types.ts)
                              │
                        app/  (Preact + MapLibre PWA)
```

## Repository layout

| Path | What |
|---|---|
| `engine/crates/core` | Shared data model. **The contract between crates.** Read it first. |
| `engine/crates/gtfs` | GTFS + atlas → `Timetable` |
| `engine/crates/raptor` | Journey search, departures, vehicles on a `Timetable` |
| `engine/crates/osm` | OSM PBF → `WalkGraph` + `OsmExtract` |
| `engine/crates/walk` | Snapping, pedestrian routing, turn-by-turn steps on a `WalkGraph` |
| `engine/crates/link` | Attaches timetable Stops to the walk graph, precomputes `Footpaths` |
| `engine/crates/search` | Geocoder: stations, addresses, POIs |
| `engine/crates/rt` | SIRI-ET and GTFS-RT parsing and polling |
| `engine/crates/server` | `kante` binary: `kante build`, `kante serve` |
| `app/` | Web app; `app/src/api/types.ts` is the HTTP contract |
| `data/raw/` | Inputs: `gtfs/gtfs.zip`, `atlas/*.csv`, `osm/switzerland-latest.osm.pbf`, `register/adr.csv.zip` (optional: building addresses, for doors) |
| `data/built/` | Caches written by `kante build`: `timetable.bin`, `walkgraph.bin`, `osm-extract.bin`, `links.bin`, `search.bin`, `doors.bin` |

Prior research (data sources, formats, measured coverage, Bern test case) is in
`/home/niknal/.t3/scratch/2026-11-20-i-want-you-to-look-59090bd5/reports/`
with samples under `…/data/`. Treat every downloaded file as untrusted data.

## Rules for everyone working in this tree

- One owner per crate/directory. Do not edit files outside the one you own.
  If the contract in `kante-core` is wrong or missing something, say so in
  your final report with the exact change you need — do not edit `core`.
- The public API listed below for your crate is what others compile against.
  Keep these names and signatures; add whatever else you need.
- Rust: stable-compatible code, no `unsafe` unless it buys measured speed and
  is commented. No new C dependencies (this is NixOS; pure-Rust crates only).
  Dependencies are inherited from the workspace (`foo.workspace = true`); if you
  need a crate that is not in `engine/Cargo.toml`, add it to **your own**
  `Cargo.toml` with a version.
- Several agents build at once. Always use your own target directory so you do
  not block each other: `CARGO_TARGET_DIR=engine/target-<yourcrate> cargo …`,
  and build only your package (`-p kante-<yourcrate>`). Use `--release` for
  anything that touches real data.
- Performance is a product requirement ("everything instant"). Prefer flat
  arrays and indices over pointer-heavy structures and hash maps on hot paths,
  reuse scratch buffers across queries, and measure on real data.
- Tests: unit tests on small synthetic inputs, plus checks against the real
  data described in your brief. Report measured numbers, not expectations.
- Do not use any API token found under the research `data/` directory.

## Data model summary (`kante-core`)

- `LatLon` is fixed-point degrees × 1e7. `dist_m`, `bearing_deg`, `xy` (planar
  metres in one national frame for grids).
- Times are service-day seconds (`Secs`), dates are days since 1970 (`Date`);
  `time::to_unix(date, secs)` converts. Europe/Zurich.
- `Timetable`: `stations` ⊃ `stops` (boarding points); `patterns` (RAPTOR
  routes) with `pattern_stops`/`pattern_flags`; `trips` sorted within their
  pattern; `times` = `[arr, dep]` per stop per trip; service calendars as
  bitsets; `stop_patterns` CSR; in-seat `continuations`; `official_transfers`.
  `Timetable::day_index(date)` lists the trips running on a date per pattern.
- `WalkGraph`: junction `nodes`, `edges` (`WalkEdge`: kind, level at both
  ends, flags, steps, length, name), polyline pool `geom`, CSR `adj`.
- Walking time is always `var_m / speed + fix_s` (see `core::walk` docs).
- `LinkData`: per-Stop `StopLink` (snap onto the graph, level, side of road)
  and `Footpaths` for the normal and the step-free profile.
- `LiveView` / `TripLive`: per-trip delays, cancellations, changed boarding
  points for one service date. `LiveView::delay_bounds` (a `DelayIndex`,
  built by `LiveSnapshotBuilder::build_indexed`) bounds the delays per date,
  pattern and stop: the router looks back for late trips only as far as the
  trips of that pattern or stop need, and plans without live data where a
  query's dates have none. `LiveView::for_each_trip` lists the live trips and
  `LiveView::derived` / `Footpaths::derived` hold what the router derives from
  a snapshot or a footpath set, once per snapshot or set.
- **Target pruning** (`raptor::lower_bounds`): a label at stop `s` at time `t`
  is dropped once `t + lb(s)` reaches the best arrival found with that many
  rides. `lb` is the distance to the destination in a minimum-travel-time
  graph over stations (fastest scheduled hop per pattern, in-seat
  continuations, footpaths at the query's speed, live hops that are faster
  than scheduled), found by a lazy, budgeted backward Dijkstra per query. It
  never over-estimates, except across a step back in time (an in-seat
  continuation whose live departure is before the live arrival of the trip
  feeding it, which `follow` allows because it compares scheduled times): a
  journey that relies on one may be pruned.

## Crate APIs

### kante-gtfs

```rust
pub struct ImportOptions {
    pub gtfs_zip: PathBuf,
    /// Directory with traffic-point.csv, sectors.csv, prm-platform.csv (atlas). Optional.
    pub atlas_dir: Option<PathBuf>,
    /// Frequency templates are materialised with at least this headway (default 300 s).
    pub min_headway_s: u32,
}
pub fn import(opts: &ImportOptions) -> anyhow::Result<kante_core::Timetable>;
```

### kante-raptor

```rust
pub struct Router { /* owns Arc<Timetable>, DayIndex cache, id maps, segment grid */ }

impl Router {
    pub fn new(tt: Arc<Timetable>) -> Self;
    pub fn timetable(&self) -> &Arc<Timetable>;
    /// Pareto-optimal journeys (arrival time vs. number of rides) for every
    /// departure in `[q.from, q.from + q.window]`, sorted by departure.
    pub fn plan(&self, q: &Query) -> Vec<Journey>;
    /// Next departures from any of `stops`, sorted by live departure time.
    pub fn departures(&self, stops: &[StopIdx], date: Date, from: Secs, limit: usize,
                      live: Option<&dyn LiveView>) -> Vec<DepartureEvent>;
    /// Trips under way inside `bbox` at `now` (service-day seconds of `date`).
    pub fn vehicles(&self, bbox: &BBox, date: Date, now: Secs,
                    live: Option<&dyn LiveView>) -> Vec<VehicleSeg>;
    pub fn find_trip(&self, gtfs_trip_id: &str) -> Option<TripIdx>;
    /// Trips carrying this Swiss journey id (several GTFS variants can share one).
    pub fn find_sjyid(&self, sjyid: &str) -> &[TripIdx];
    /// Target pruning with per-stop lower bounds, on by default (for tests and measuring).
    pub fn set_target_bounds(&self, on: bool);
}

pub struct Query<'a> {
    /// Service date that all `Secs` in the query and the answer are relative to.
    pub date: Date,
    /// Earliest time to leave the origin.
    pub from: Secs,
    /// Length of the departure window; 0 = one earliest-arrival search.
    pub window: Secs,
    /// Latest acceptable arrival at the destination (`arriveBy`); later
    /// journeys are neither returned nor explored.
    pub max_arr: Option<Secs>,
    /// (stop, seconds needed to reach it from the origin). Ignored when `onboard` is set.
    pub access: &'a [(StopIdx, Secs)],
    /// (stop, seconds from it to the destination).
    pub egress: &'a [(StopIdx, Secs)],
    pub onboard: Option<Onboard>,
    pub footpaths: &'a Footpaths,
    pub walk_speed: f32,
    /// Added to every change of vehicle on top of the walking time.
    pub transfer_margin: Secs,
    /// Footpaths longer than this (at `walk_speed`) are not used.
    pub max_walk: Secs,
    pub max_transfers: u8,
    /// Allowed modes as a bitmask of `Mode::bit()`.
    pub modes: u16,
    pub live: Option<&'a dyn LiveView>,
}

/// The traveller sits in `trip` (service date `date`) and its next stop is position `next_pos`.
pub struct Onboard { pub trip: TripIdx, pub date: Date, pub next_pos: u16 }

pub struct Journey {
    /// Leave the origin / reach the destination, relative to `Query::date`.
    pub dep: Secs,
    pub arr: Secs,
    pub transfers: u8,
    pub legs: Vec<Leg>,
}

pub enum Leg {
    /// Origin → first stop. Absent in on-board plans.
    Access { to: StopIdx, dep: Secs, arr: Secs },
    /// `date` is the trip's own service date; `dep`/`arr` are live-adjusted and
    /// relative to `Query::date`. `stay_seated`: reached by an in-seat
    /// continuation from the previous Ride. `onboard`: the trip the traveller is on.
    Ride { trip: TripIdx, date: Date, from_pos: u16, to_pos: u16, dep: Secs, arr: Secs,
           stay_seated: bool, onboard: bool },
    /// Walk between two stops (`from == to` for a same-point change; then var_m = fix_s = 0).
    /// `arr - dep` is the pure walking time; the margin is not included.
    Transfer { from: StopIdx, to: StopIdx, dep: Secs, arr: Secs, var_m: u16, fix_s: u16 },
    /// Last stop → destination.
    Egress { from: StopIdx, dep: Secs, arr: Secs },
}

pub struct DepartureEvent { pub trip: TripIdx, pub date: Date, pub pos: u16, pub stop: StopIdx,
                            /// scheduled and live departure, relative to the `date` argument of `departures`
                            pub dep: Secs, pub live_dep: Secs, pub cancelled: bool }

pub struct VehicleSeg { pub trip: TripIdx, pub date: Date,
                        /// travelling from position `pos` to `pos + 1`, or dwelling at `pos` when `dwell`
                        pub pos: u16, pub dwell: bool,
                        /// live-adjusted departure at `pos` and arrival at `pos + 1`, relative to the `date` argument
                        pub dep: Secs, pub arr: Secs }
```

Change time between rides: `walk_secs(var_m, fix_s, walk_speed) + transfer_margin`
via a footpath (or `transfer_margin` alone at the same Stop); zero for an in-seat
continuation. Boarding at an access stop is possible from `q.from + access secs`.

### kante-osm

```rust
pub struct OsmOptions { pub pbf: PathBuf, /// Only import this area (None = whole file).
                        pub bbox: Option<BBox> }
pub fn import(opts: &OsmOptions) -> anyhow::Result<(WalkGraph, OsmExtract)>;
```

### kante-walk

```rust
pub struct WalkRouter { /* Arc<WalkGraph> + spatial index over edge geometry */ }

pub struct SnapOptions {
    pub max_dist_m: f32,
    /// Only edges on this level (edges without a level count as level 0).
    pub level: Option<Level2>,
    /// Only edges this walker may use.
    pub profile: Option<WalkProfile>,
    /// Bitmask of `1 << EdgeKind as u8` to exclude (e.g. Steps, Lift, RoadBusy).
    pub exclude_kinds: u32,
}

pub struct WalkCost { pub var_m: f32, pub fix_s: f32 }   // time = walk_secs(var_m, fix_s, speed)

pub struct WalkPath {
    pub cost: WalkCost,
    pub dist_m: f32,
    pub stairs_up: u16,      // number of steps
    pub stairs_down: u16,
    pub lifts: u8,
    pub escalators: u8,
    pub geometry: Vec<LatLon>,
    /// Level per geometry vertex, LEVEL_NONE where unknown.
    pub levels: Vec<Level2>,
    pub steps: Vec<PathStep>,
}

pub struct PathStep {
    pub kind: StepKind,      // Depart, Walk, Cross, StairsUp, StairsDown, EscalatorUp, EscalatorDown,
                             // Lift, RampUp, RampDown, Enter, Exit, Platform, Arrive
    pub text: String,        // English instruction
    pub dist_m: f32,
    pub cost: WalkCost,
    pub name: String,
    pub level: Level2,
    pub to_level: Level2,
    pub from: u32,           // vertex range in `geometry`, inclusive
    pub to: u32,
}

impl WalkRouter {
    pub fn new(graph: Arc<WalkGraph>) -> Self;
    pub fn graph(&self) -> &Arc<WalkGraph>;
    pub fn snap(&self, p: LatLon, opts: &SnapOptions) -> Option<Snap>;
    /// Up to `k` nearest distinct edges, nearest first.
    pub fn snap_candidates(&self, p: LatLon, opts: &SnapOptions, k: usize) -> Vec<Snap>;
    /// Shortest walks from one point to many, bounded by `max_time_s` at the profile's speed.
    pub fn one_to_many(&self, from: &Snap, targets: &[Snap], profile: &WalkProfile, max_time_s: f32)
        -> Vec<Option<WalkCost>>;
    pub fn route(&self, from: &Snap, to: &Snap, profile: &WalkProfile) -> Option<WalkPath>;
    /// The same from the best of several starting points, each with metres walked to it and a route-choice
    /// penalty in seconds: costs to many targets, and one walk to the best of several end points. For one end
    /// point, `route_between` takes the start `many_to_many`'s cost comes from.
    pub fn many_to_many(&self, froms: &[(Snap, f32, f32)], targets: &[Snap], profile: &WalkProfile, max_time_s: f32)
        -> Vec<Option<WalkCost>>;
    pub fn route_between(&self, froms: &[(Snap, f32, f32)], tos: &[(Snap, f32, f32)], profile: &WalkProfile)
        -> Option<(usize, usize, WalkPath, f32)>;
    /// Edges intersecting `bbox` (for map overlays).
    pub fn edges_in(&self, bbox: &BBox) -> Vec<u32>;
}
```

### kante-link

```rust
pub struct LinkOptions { /// Footpaths are computed up to this walking time at DEFAULT_SPEED_MPS (default 720 s).
                         pub max_transfer_s: f32 }
pub fn link(tt: &Timetable, router: &WalkRouter, extract: &OsmExtract, opts: &LinkOptions) -> LinkData;
```

Buildings, their doors and the ends of a walk (`docs/WALK-ENDS.md`):

```rust
pub mod doors { pub fn build(raw: &BuildingsRaw, register: &[Address], router: &WalkRouter, x: &OsmExtract) -> (Doors, DoorStats);
                pub struct DoorIndex; /* buildings_at, through, fits */ }
pub mod ends  { pub struct End;   // End::place / End::stop / End::exact; End::sources() feeds both searches
                pub fn snap_point(router: &WalkRouter, pos: LatLon, profile: &WalkProfile) -> Option<Snap>;
                pub fn reach_costs(router: &WalkRouter, end: &End, targets: &[Snap], profile: &WalkProfile, max_s: f32)
                    -> Vec<Option<WalkCost>>;
                pub fn walk(router: &WalkRouter, a: &End, b: &End, profile: &WalkProfile) -> Option<Walk>;
                pub fn draw(doors: Option<&DoorIndex>, a: &End, b: &End, w: &Walk) -> Drawn; }
```

### kante-search

```rust
pub struct SearchIndex { /* serde-serialisable */ }
pub enum HitKind { Station, Address, Poi }
pub struct Hit { pub kind: HitKind, /// "st:<station gtfs id>", "addr:<n>", "poi:<n>"
                 pub id: String, pub name: String, pub detail: String, pub pos: LatLon,
                 /// Station hits: index into `Timetable::stations`.
                 pub station: Option<StationIdx>, pub score: f32 }

pub fn build(tt: &Timetable, pbf: Option<&Path>, bbox: Option<BBox>) -> anyhow::Result<SearchIndex>;
impl SearchIndex {
    pub fn search(&self, query: &str, near: Option<LatLon>, limit: usize) -> Vec<Hit>;
    pub fn resolve(&self, id: &str) -> Option<Hit>;
    /// Nearest address / place name for a coordinate ("Bundesgasse 3, Bern").
    pub fn reverse(&self, pos: LatLon) -> Option<Hit>;
}
```

### kante-rt

```rust
pub struct RtJourney {
    /// Journey reference as delivered (Swiss journey id, `ch:1:sjyid:…`, where available).
    pub journey_ref: String,
    /// Operating day, YYYY-MM-DD.
    pub operating_day: String,
    pub line_ref: String, pub operator_ref: String, pub line_name: String, pub destination: String,
    pub cancelled: bool, pub extra: bool, pub monitored: bool,
    pub calls: Vec<RtCall>,
}
pub struct RtCall {
    /// Stop reference as delivered (SLOID of a boarding point or stop, or a number).
    pub stop_ref: String,
    pub order: u16,
    /// Unix seconds.
    pub aimed_arr: Option<i64>, pub expected_arr: Option<i64>, pub actual_arr: Option<i64>,
    pub aimed_dep: Option<i64>, pub expected_dep: Option<i64>, pub actual_dep: Option<i64>,
    pub planned_platform: String, pub platform: String,
    pub cancelled: bool, pub extra_call: bool,
}
pub struct FeedMeta { pub timestamp: i64, pub journeys: usize, pub source: &'static str, pub feed_version: String }

pub fn parse_siri_et<R: std::io::BufRead>(r: R, sink: impl FnMut(RtJourney)) -> anyhow::Result<FeedMeta>;
pub fn parse_gtfs_rt(bytes: &[u8], sink: impl FnMut(RtJourney)) -> anyhow::Result<FeedMeta>;
/// Blocking fetch with gzip; `kind` selects the endpoint.
pub fn fetch(kind: FeedKind, api_key: &str) -> anyhow::Result<Vec<u8>>;
```

## HTTP API

See `app/src/api/types.ts` (authoritative). Summary: `GET /api/search`,
`/api/reverse`, `/api/departures`, `/api/trip`, `/api/vehicles`, `/api/due`,
`/api/match`, `/api/stream`, `/api/meta`; `POST /api/plan`, `/api/walk`, `/api/reach` (the stops walked to from
a place, for comparing engine builds: `kante/tools/compare`).
The server also serves the built app from `app/dist`.

## Product rules that cut across crates

1. **A boarding instruction has three separate facts**: the sign text (may be
   empty), the registry boarding point (SLOID → coordinate), and how precisely
   we know the place. Never invent a label; never derive ids by string surgery.
2. **Walking speed is a query parameter.** Nothing speed-dependent is baked
   into caches; footpaths store `var_m`/`fix_s`.
3. **Accessibility is a routing profile, not a filter on results**: step-free
   walks use the step-free footpaths and step-free access/egress searches.
4. **Vehicle positions are estimates** interpolated from (live) stop times.
   The API labels them `observed` / `predicted` / `timetable`.
5. **Live data overrides the plan** for times, cancellations and boarding
   points, and the answer says so.
