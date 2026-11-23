//! kante-osm — OpenStreetMap PBF → [`WalkGraph`] + [`OsmExtract`].
//!
//! ```no_run
//! # use kante_osm::*;
//! let (graph, extract) = import(&OsmOptions { pbf: "switzerland-latest.osm.pbf".into(), bbox: None })?;
//! # anyhow::Ok(())
//! ```
//!
//! Three parallel passes over the file (relations → ways → nodes, see
//! [`read`]), then [`build`] cuts the walkable ways into a compact graph.
//! The whole of Switzerland takes about 6 s on 32 cores and peaks around
//! 1.8 GB of memory; the resulting graph is about 360 MB.
//!
//! The rest of this page is the contract for crates that *use* the output
//! (`kante-walk`, `kante-link`): what exactly the edges, nodes and flags mean.
//!
//! # Which ways are in the graph
//!
//! `highway=` footway, path, pedestrian, steps, corridor, living_street,
//! residential, service, unclassified, road, track, cycleway, tertiary /
//! secondary / primary (+ `_link`), bridleway only with `foot=yes`, trunk only
//! with `foot=yes` or a `sidewalk` tag; platforms (`highway=platform`,
//! `railway=platform`, `public_transport=platform`, lines and areas). Left
//! out: motorways, `motorroad=yes`, construction / proposed, `foot=no|private`,
//! `access=no|private|military` unless `foot=yes|designated|permissive`.
//! `foot=use_sidepath` roads stay in (as `RoadBusy` or `Road`), so the network
//! does not break where the separate sidewalk is not connected.
//!
//! [`EdgeKind`] by tag: `footway=sidewalk` → `Sidewalk`; `footway=crossing` or
//! `crossing=*` on a footway/path/cycleway → `Crossing`; `conveying=*` on
//! steps/footway/path → `Escalator`; steps → `Steps`; `highway=corridor`, or a
//! footway/path with `indoor=*` → `Corridor`; platforms → `Platform`;
//! `highway=pedestrian` → `Pedestrian`; path → `Path` (`Footway` if the surface
//! is paved); track → `Path` (`Road` if `tracktype=grade1` or paved);
//! cycleway → `Footway` if `foot=yes|designated` or `segregated=*`, else
//! `Road`; residential, living_street, service, unclassified, road → `Road`;
//! tertiary and bigger → `RoadBusy`, or `Road` + `EF_HAS_SIDEWALK` with
//! `sidewalk=both|left|right|yes`.
//!
//! # Graph shape
//!
//! - Nodes are way ends, nodes used by two walkable ways (or twice by one),
//!   and tagged nodes that matter (lift, entrance, door, crossing, barrier,
//!   raised kerb). Everything between two such nodes is one edge whose
//!   polyline is in `geom` (first point = node `a`, last = node `b`).
//! - **No edge has `a == b`.** A closed way without any junction is cut in two.
//!   Parallel edges (two edges between the same pair of nodes) do occur.
//! - `len_dm` is the polyline length. It can be 0: lift edges at a lift
//!   mapped as a node, and the odd pair of nodes with identical coordinates.
//! - Nodes and edges are numbered along a Z-order curve, so things close in
//!   space are close in memory.
//! - Several nodes can share one coordinate: the floors of a lift (below) and
//!   the two sides of a barrier nobody may pass (`barrier=wall|fence|hedge…`,
//!   or any barrier with `access=no|private` / `locked=yes`): ways are *not*
//!   connected through such a barrier.
//! - `edge_way` is the OSM way the edge was cut from. Synthetic edges: area
//!   edges (`EF_AREA`) carry the id of the area's way **or multipolygon
//!   relation**; lift edges the id of the lift's way, or 0 for a lift mapped
//!   as a node; connector edges (below) 0.
//! - Fragments of the network shorter than 150 m in total that are connected
//!   to nothing else are dropped. Larger disconnected pieces remain (about
//!   0.4 % of all edges nationally: gated estates, mapping gaps, islands). A
//!   router should label components once at load time and snap both ends of a
//!   walk into the same component.
//!
//! # Levels
//!
//! `level_a` / `level_b` are OSM `level` × 2 ([`Level2`]) at node `a` / `b`.
//! `LEVEL_NONE` on both ends means the way has no `level` tag — the normal
//! case outdoors; for snapping treat it as ground (0). `layer`, `tunnel` and
//! `bridge` are never turned into a level.
//!
//! A way tagged with several levels (`level=-1;0`: stairs, ramps, escalators)
//! gets its lowest level at one end and its highest at the other. Which end is
//! which comes from `incline=up|down`; without it, from the levels of the
//! other ways meeting at each end (an untagged outdoor way counts as ground);
//! failing both, from the order written in the tag (48 of 1 920 such ways
//! nationally, 1 of 86 around Bern — counted in `BuildStats::unoriented`).
//! Where such a way is cut at an intermediate junction, the level there is
//! taken from the ways joining at that point, else interpolated by distance
//! and rounded to half a level.
//!
//! So: an edge with `level_a != level_b` changes floor. If its kind is `Steps`
//! or `Escalator` that is stairs; if it is `Footway` / `Corridor` / … it is a
//! ramp. Edges on different floors only ever meet at such an edge or at a
//! lift — except where OSM itself joins flat ways of different levels in one
//! node (326 places nationally, 9 around Bern station; nothing can be done
//! about those here, the walker changes floor for free).
//!
//! # Stairs and escalators
//!
//! - `Steps`: `steps` = `step_count` (shared out by length if the way was
//!   cut), else length / 0.3 m, 1..=255. `EF_RAMP` if `ramp=yes` or
//!   `ramp:wheelchair=yes`.
//! - `EF_UP_AB`: node `b` is the upper end; `EF_UP_BA`: node `a` is. Set from
//!   the end levels when they differ, else from `incline`. Neither bit =
//!   direction unknown (about half of all outdoor steps).
//! - `Escalator`: `EF_ONEWAY_AB` — usable only from `a` to `b`
//!   (`conveying=forward`); `EF_ONEWAY_BA` — only from `b` to `a`
//!   (`conveying=backward`); neither bit — usable both ways
//!   (`conveying=yes|reversible`: direction unknown or switched by time of
//!   day). The one-way bits appear on `Escalator` edges only. A moving walkway
//!   is an `Escalator` with equal end levels and no `EF_UP_*`.
//!
//! # Lifts — how to recognise one ride
//!
//! **One ride = one traversal of an edge of kind `Lift`.** Charge `LIFT_S`
//! once per `Lift` edge on the path and nothing else for it.
//!
//! How that is arranged: a lift is a set of *ports*, one graph node per floor
//! it serves, each flagged `NF_ELEVATOR`. Every way reaching the lift is
//! attached to the port of its own floor, and every two ports on different
//! floors are joined directly by a `Lift` edge (`level_a` / `level_b` = the
//! two floors, `a` the lower one). Consequences a router can rely on:
//!
//! - There is no way to change floor at a lift without traversing a `Lift`
//!   edge, and no reason to traverse two in a row: going from floor −1 to
//!   floor 2 is the single edge (−1, 2), not (−1, 0) + (0, 2). A router
//!   needs no state for lifts; plain per-edge cost is exact.
//! - A lift mapped as a node (`highway=elevator` on a node): all its ports
//!   have the node's coordinate and its `Lift` edges have `len_dm == 0` and a
//!   two-point geometry of that same coordinate.
//! - A lift mapped as a way or area (`highway=elevator`, `building:part` /
//!   `indoor` / `room=elevator`): its outline is not walkable; the ports are
//!   the outline nodes where other ways touch it, and a `Lift` edge is the
//!   straight line between two of them (a few metres; ignore the length).
//!   Ports on the same floor are not joined.
//! - Floors are told apart by the `level` of the ways arriving; ways without
//!   `level` by their `layer`; and if nothing differs, each way arriving at a
//!   lift node is taken to be its own floor (112 lifts nationally). The
//!   `Lift` edge's level at such a port is the level from the lift's own
//!   `level` tag if that is unambiguous, else `LEVEL_NONE` (the only edges
//!   that can have a level at one end only).
//! - `EF_WHEELCHAIR_NO` / `EF_WHEELCHAIR_YES` come from the lift's
//!   `wheelchair` tag. Lifts tagged `access=no|private` have ports but no
//!   `Lift` edges. A lift touching the network on one floor only has none
//!   either.
//! - Never snap a position onto a `Lift` edge.
//!
//! # Squares, platforms and other areas (`EF_AREA`)
//!
//! `highway=pedestrian|footway` with `area=yes` (closed ways and
//! multipolygons) and platform polygons are kept twice: their outline as
//! ordinary edges (kind `Pedestrian` / `Platform`, no `EF_AREA`), plus
//! straight two-point edges with `EF_AREA` across the inside. These join the
//! outline nodes where other ways attach, the corners a path has to bend
//! round (including corners of holes), and for platforms the two far ends
//! (all corners for small ones). An area edge never leaves the polygon. Not
//! every visible pair is linked: a greedy spanner keeps any walk across the
//! area within 4 % of the straight line. Indoor corridor polygons
//! (`indoor=corridor|area` without `highway`) get area edges of kind
//! `Corridor` between the points where ways touch them, and no outline.
//!
//! For instructions, merge consecutive `EF_AREA` edges with the same
//! `edge_way` into one "cross ‹name›" step. Area edges are fine to snap to.
//!
//! # Connector edges
//!
//! Many bus and tram platforms are drawn as a polygon beside the sidewalk
//! without sharing a node with it. Such platform fragments are joined to the
//! network by up to three straight edges of at most 25 m from a platform
//! corner to the nearest point of a walkable edge on the same level (that
//! edge is split there): kind `Footway`, `edge_way == 0`, two points,
//! unnamed. Connectors never cross a railway line; crossing a road or tram
//! track is avoided when there is an alternative. They are not mapped paths —
//! do not announce them as a path of their own.
//!
//! # Crossings
//!
//! A `Crossing` edge has `EF_SIGNALS`, `EF_MARKED` or neither (unmarked).
//! OSM usually cuts one crossing into several edges (at the kerbs and at the
//! `highway=crossing` node in the middle of the road), so **charge the wait
//! once per run of consecutive `Crossing` edges**, not per edge. Nodes carry
//! `NF_CROSSING_SIGNALS` / `NF_CROSSING` too; they matter only where a
//! footway crosses a road at such a node without a `Crossing` edge.
//!
//! # Wheelchairs
//!
//! `EF_WHEELCHAIR_NO` edges and passing *through* an `NF_NO_WHEELCHAIR` node
//! (stile, turnstile, kissing gate, step, narrow cycle barrier, raised kerb)
//! are out for the step-free profile; `Steps` are usable only with `EF_RAMP`.
//! `EF_ROUGH`: unpaved or cobbled surface, bad smoothness, track grade 3–5 or
//! an alpine `sac_scale`.
//!
//! # `OsmExtract`
//!
//! `platforms`, sorted by (`osm_type`, `osm_id`):
//!
//! - `PlatformWay`: platform ways, areas and multipolygons. `edges` lists the
//!   walk edges made from it (outline and area edges; not connectors), empty
//!   if it is closed to pedestrians or was pruned as an unreachable crumb.
//!   `pos` is the area centroid, or the midpoint of a platform drawn as a
//!   line. Also `railway=platform_edge` lines — the edge of a platform beside
//!   one track, carrying that single track number in `refs` — always with
//!   empty `edges`.
//! - `PlatformNode`: `public_transport=platform` nodes, `highway=bus_stop`,
//!   plus `amenity=ferry_terminal` and `aerialway=station` nodes.
//! - `StopPosition`: `public_transport=stop_position` and
//!   `railway=tram_stop|stop|halt` nodes (on the carriageway or track).
//!
//! `level` is the first value of the `level` tag. `refs` = `ref` then
//! `local_ref`. `sloid` = `ref:sloid` (or `ref:IFOPT` when it holds a SLOID) —
//! rare: about 900 objects nationally. `uic_ref` is on roughly 85 % of the
//! objects; where absent it is copied from the enclosing `stop_area` relation,
//! as is an empty `name`. `modes` come from the object's own tags and from the
//! route relations it is a stop/platform member of; objects still without a
//! mode take the modes of the other members of their `stop_area`.
//!
//! `carriageways`: one polyline per OSM way — roads from motorway down to
//! service roads that vehicles may use (parking aisles and driveways left
//! out; pedestrian streets included when buses run through them),
//! `railway=tram`, and `rail|light_rail|narrow_gauge|subway`. Tunnels and
//! bridges are included and not marked.

pub mod area;
pub mod build;
pub mod buildings;
pub mod read;
pub mod stats;
mod stitch;
pub mod tags;

use anyhow::Result;
use kante_core::geo::BBox;
use kante_core::walk::{OsmExtract, WalkGraph};
#[allow(unused_imports)] // for the docs above
use kante_core::walk::{EdgeKind, Level2};
use std::path::PathBuf;
use std::time::Instant;

pub use build::BuildStats;

pub struct OsmOptions {
    pub pbf: PathBuf,
    /// Only import this area (None = whole file).
    pub bbox: Option<BBox>,
}

pub fn import(opts: &OsmOptions) -> Result<(WalkGraph, OsmExtract)> {
    let (g, x, _) = import_with_stats(opts)?;
    Ok((g, x))
}

/// Like [`import`], also returning counters and timings.
pub fn import_with_stats(opts: &OsmOptions) -> Result<(WalkGraph, OsmExtract, BuildStats)> {
    import_full(opts, None)
}

/// Like [`import_with_stats`]; straight lines across squares and platforms do not
/// cross these buildings (see [`buildings::import_buildings`]).
pub fn import_full(opts: &OsmOptions, buildings: Option<&buildings::BuildingsRaw>) -> Result<(WalkGraph, OsmExtract, BuildStats)> {
    let obstacles = buildings.map(build::Obstacles::new);
    let mut stats = BuildStats::default();
    let t = Instant::now();
    let rels = read::read_relations(&opts.pbf)?;
    stats.relations_read = rels.n_relations;
    stats.secs_relations = t.elapsed().as_secs_f32();
    rss("relations");
    let t = Instant::now();
    let ways = read::read_ways(&opts.pbf, &rels)?;
    stats.ways_read = ways.n_ways;
    stats.secs_ways = t.elapsed().as_secs_f32();
    rss("ways");
    let t = Instant::now();
    let nodes = read::read_nodes(&opts.pbf, &ways.node_ids, opts.bbox.as_ref())?;
    stats.nodes_read = nodes.n_nodes;
    stats.secs_nodes = t.elapsed().as_secs_f32();
    rss("nodes");
    let t = Instant::now();
    // the id table was only needed to resolve way → node references
    let mut ways = ways;
    ways.node_ids = Vec::new();
    let mut built = build::build(&rels, &ways, &nodes, opts.bbox.as_ref(), obstacles.as_ref(), stats);
    built.stats.secs_build = t.elapsed().as_secs_f32();
    rss("build");
    Ok((built.graph, built.extract, built.stats))
}

/// With `KANTE_OSM_DEBUG` set: resident memory after a phase, on stderr.
fn rss(phase: &str) {
    if std::env::var_os("KANTE_OSM_DEBUG").is_none() {
        return;
    }
    if let Ok(s) = std::fs::read_to_string("/proc/self/status") {
        let get = |k: &str| s.lines().find(|l| l.starts_with(k)).and_then(|l| l.split_whitespace().nth(1)).and_then(|x| x.parse::<u64>().ok()).unwrap_or(0) / 1024;
        eprintln!("after {phase}: RSS {} MB, peak {} MB", get("VmRSS:"), get("VmHWM:"));
    }
}
