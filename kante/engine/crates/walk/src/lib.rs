//! kante-walk — snapping, pedestrian routing and turn-by-turn steps on a
//! [`WalkGraph`]. See `docs/ARCHITECTURE.md` for the contract.
//!
//! # Cost model
//!
//! Reported time is always `var_m / speed + fix_s` ([`WalkCost`], the shared
//! model of `kante_core::walk`):
//!
//! | edge | `var_m` | `fix_s` |
//! |---|---|---|
//! | footway, sidewalk, path, pedestrian, corridor, platform, road | length | – |
//! | steps | length × `STAIRS_FACTOR` | – |
//! | steps walked on their ramp (`EF_RAMP`, by walkers who avoid stairs) | length × 1.5 | – |
//! | escalator / moving walkway | – | length / `ESCALATOR_MPS` |
//! | crossing | length | `CROSSING_*_S`, once per crossing |
//! | lift | – | `LIFT_S`, once per ride |
//!
//! Routes are chosen on a *generalised* cost = that time plus preferences that
//! are never reported: `StairsPref::Avoid` makes stairs feel 3× as long plus
//! 25 s per flight; walking on a road carriageway costs +5 % (`Road`) or
//! +30 % (`RoadBusy`) unless the road has a sidewalk tagged on it; in
//! wheelchair mode rough surfaces count ×1.8, unpaved paths ×1.3 and busy
//! roads ×2 (the largest of these, not their product).
//!
//! With the graph's attributes (`WalkGraph::attrs`, `walkattr.bin`; see
//! `docs/walking-routes.md`, "Which way"): a carriageway whose sidewalks are
//! drawn apart counts ×2.5 instead of its own multiplier, a car-only service
//! road at least ×1.3, a way away from traffic ×0.95 (the A* bound allows for
//! it), a way closed at `WalkProfile::at` ×20 on top. And at a junction of
//! three or more ways (`net::Junctions`) passing from one way to another
//! costs a turn (2 s from 35°, 4 s back) and, from a footway or sidewalk, each
//! tertiary / secondary / primary carriageway walked over where no crossing is
//! mapped (15 / 30 / 45 s); `crossing=no` there is not crossed at all. The
//! search keeps one label per arc into such a junction, so these are exact,
//! and against the direction of travel the same (the costs are symmetric).
//! A search by the time walked alone ([`WalkRouter::quickest_many`],
//! [`WalkRouter::quickest_between`]) leaves all of them out, `crossing=no`
//! excepted. `KANTE_WALK_RULES_OFF` switches each off ([`rules`]).
//!
//! Hills (when the graph has slopes, `WalkGraph::slopes`, from `kante-elevation`; the model is
//! `kante_core::slope`): every arc carries its direction's extra metres of walking time, which add to
//! `var_m` (so up a hill takes longer than down it), its route-choice effort, weighted by the walker's
//! `HillsPref` (×0 ignore, ×1 normal, ×3 avoid), and for wheelchairs (unless hills are ignored) its grades
//! over 6 %. `WalkPath::climb_m` / `descent_m` count the metres climbed and descended. No slope makes an
//! arc quicker than the flat, so the A* bound holds; the bounded searches allow for the effort
//! (`search::bound_slack`). A search with `WalkProfile::backwards` (from a destination back to the stops)
//! costs each arc's slopes as walked the other way, so it times the walk as it is walked.
//!
//! Unusable: steps for `StairsPref::Never` and for wheelchairs (unless
//! `EF_RAMP`), escalators without `escalators`, lifts without `lifts`, an
//! edge against `EF_ONEWAY_*`, and for wheelchairs `EF_WHEELCHAIR_NO` edges
//! and passing *through* an `NF_NO_WHEELCHAIR` node. A walk may start or end
//! on an edge beside such a barrier; it is reached and left from its open
//! end only, so the walk there costs the same as the walk back.
//!
//! # Unmapped level changes
//!
//! OSM joins ways in a node wherever they were drawn through the same point;
//! nothing says they are at the same height. Where the ways meeting at a
//! node are on different floors and no stairs, ramp or lift is mapped there,
//! the router keeps the floors apart (one routing node per floor):
//!
//! * **flat ways with different `level` tags** — typically an underpass or
//!   concourse polygon sharing outline nodes with the platform above it
//!   (301 nodes nationally; 7 around Bern station). Carriageways of different
//!   levels stay joined: vehicles drive there, so it is a slope (25 nodes,
//!   among them all five half-level cases — car park ramps);
//! * **a pedestrian tunnel or indoor way below ground and an untagged
//!   street-level way that both run through the node** — the crossing on
//!   Bahnhofplatz in Bern glued to Christoffelunterführung beneath it, a
//!   platform glued to the underpass under it (48 nodes; the mirror case with
//!   a levelled footbridge does not occur).
//!
//! A levelled way that simply *continues* as an untagged one (bridges and
//! tunnels tagged `level=±1`, building exits; about 1 900 nodes) is a
//! continuous surface or a plausible ramp and stays joined. Tunnels without
//! any level crossing a street node are not decidable (most are arcades or
//! covered passages with a real crossing) and stay joined too.
//!
//! Between the floors of such a node there is a virtual connection:
//!
//! * **never usable** by a walker with `StairsPref::Never` or `wheelchair` —
//!   a step-free route changes floor only by a mapped ramp or lift;
//! * for everyone else it is taken to be a flight of stairs
//!   (3 m × `STAIRS_FACTOR` of walking per half level) and, for route choice
//!   only, 20 s worse than that (plus the usual penalties when avoiding
//!   stairs), so mapped stairs or a lift nearby win;
//! * it is reported: a step "Go down to level −1 (connection not mapped in
//!   detail)" of kind `Walk` with `level != to_level`, drawn as a point (the
//!   geometry repeats the position once per floor, as at a lift), and counted
//!   in [`WalkPath::unmapped_level_changes`].
//!
//! [`WalkRouter::level_joins`] lists the nodes; `walk-route check` prints them.
//!
//! Stairs, escalators and ramps whose two end levels are the wrong way round
//! in the graph — at both ends the flat ways are on the level given to the
//! other end; 43 edges nationally, 7 of them at Zürich HB — are read the
//! other way round ([`WalkRouter::upside_down_edges`]).
//!
//! # Snapping for step-free walkers
//!
//! With a step-free or wheelchair profile in [`SnapOptions`], edges on a
//! crumb of the step-free network are skipped: pieces with less than
//! [`SNAP_MIN_PIECE_M`] of ways that only stairs, escalators, barriers or an
//! unmapped level change connect to anything else (landings between flights).
//! [`WalkRouter::components`] gives the pieces for any profile.
//!
//! # Conventions assumed about the graph
//!
//! * **Lifts** may be modelled in two ways:
//!   - `EdgeKind::Lift` edges between the floors of a lift — what `kante-osm`
//!     produces: one "port" node per floor (flagged `NF_ELEVATOR`), joined
//!     pairwise by lift edges whose `level_a` / `level_b` are the two floors.
//!     Entering a chain of lift edges from any other edge is one ride however
//!     many lift edges follow; the edges themselves cost nothing, but their
//!     length counts into `dist_m`. The ways meeting at a port are one floor.
//!   - an `NF_ELEVATOR` node *without* lift edges at which ways of different
//!     levels meet. Passing through it between two ways whose level at that
//!     node differs is one ride; between ways of the same level it is free
//!     (`LEVEL_NONE` counts as level 0).
//!   Internally every lift gets an "inside" twin node; stepping in costs
//!   `LIFT_S`, stepping out is free. A snap onto a lift edge starts inside
//!   the lift (no charge) — exclude `EdgeKind::Lift` when snapping.
//! * **Crossings and stair flights split into several edges** are recognised
//!   by equal non-zero `edge_way` on adjoining edges of the same kind; the
//!   wait (and the avoid-stairs flight penalty) is shared out by length, so
//!   half a crossing costs half the wait. A crossing has signals if any of
//!   its fragments has `EF_SIGNALS` or ends at an `NF_CROSSING_SIGNALS` node.
//!   Crossing nodes on ways that are not `EdgeKind::Crossing` cost nothing.
//! * `WalkEdge::len_dm` is the length of the edge polyline; `Snap::frac` is
//!   a fraction of that length. (Internally an edge is never taken to be
//!   shorter than the beeline between its end nodes, so distances can exceed
//!   the sum of `len_dm` by the decimetre rounding.)
//! * Stairs / escalator direction comes from `EF_UP_AB` / `EF_UP_BA`, else
//!   from the two levels; an escalator with neither is a moving walkway.
//!   Stairs of unknown direction count as "up" in the totals.
//! * A way is "inside" if it has `EF_INDOOR` or is a `Corridor`.

mod index;
mod net;
mod path;
pub use net::{rules, LevelJoin, LevelJoinKind};
mod search;
mod steps;
#[cfg(test)]
mod tests;

use kante_core::*;
use serde::Serialize;
use std::sync::Arc;

pub struct WalkRouter {
    graph: Arc<WalkGraph>,
    grid: index::Grid,
    net: net::Net,
    /// Step-free crumbs (see [`SNAP_MIN_PIECE_M`]).
    crumbs: index::Crumbs,
}

/// A piece of the step-free network with less than this many metres of ways
/// in total, cut off from more network around it by stairs, escalators,
/// barriers or an unmapped floor change (a landing between two flights, the
/// path between two staircases), is not a place a step-free walker can be:
/// snapping with a step-free or wheelchair profile skips it and takes the
/// nearest edge of a bigger piece instead. Around Bern station this was the
/// cause of every "no step-free route" among random pairs of points. (Same
/// size as the crumbs the importer drops from the whole network. A small
/// piece that is simply not connected to anything else stays snappable.)
pub const SNAP_MIN_PIECE_M: f32 = 150.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SnapOptions {
    pub max_dist_m: f32,
    /// Only edges on this level (edges without a level count as level 0; an
    /// edge that spans levels matches every level in its range).
    pub level: Option<Level2>,
    /// Only edges this walker may use. For a step-free or wheelchair profile
    /// that also leaves out crumbs of the step-free network cut off by stairs
    /// (see [`SNAP_MIN_PIECE_M`]).
    pub profile: Option<WalkProfile>,
    /// Bitmask of `1 << EdgeKind as u8` to exclude (e.g. Steps, Lift, RoadBusy).
    pub exclude_kinds: u32,
}

impl Default for SnapOptions {
    fn default() -> Self {
        SnapOptions { max_dist_m: 50.0, level: None, profile: None, exclude_kinds: 0 }
    }
}

/// Real walking effort; never contains route-choice penalties.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct WalkCost {
    pub var_m: f32,
    pub fix_s: f32,
}

impl WalkCost {
    #[inline]
    pub fn secs(&self, speed_mps: f32) -> f32 {
        walk_secs(self.var_m, self.fix_s, speed_mps)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct WalkPath {
    pub cost: WalkCost,
    pub dist_m: f32,
    /// Metres climbed and descended on the way (0 without a terrain model; stairs out of doors included).
    pub climb_m: f32,
    pub descent_m: f32,
    /// Number of steps climbed / descended.
    pub stairs_up: u16,
    pub stairs_down: u16,
    pub lifts: u8,
    pub escalators: u8,
    /// Floor changes at places where the map joins two floors without stairs,
    /// ramp or lift (see "Unmapped level changes" in the crate docs). Always 0
    /// for step-free and wheelchair profiles. A walk with any of these is not
    /// known to be step-free even if `stairs_up + stairs_down == 0`.
    pub unmapped_level_changes: u8,
    /// Metres on ways whose opening hours or closing condition exclude the walk's time (`WalkProfile::at`): taken
    /// only when no open way would do.
    pub closed_m: f32,
    /// Snapped start → edges → snapped end. At a lift the same position
    /// appears twice, once per level.
    pub geometry: Vec<LatLon>,
    /// Level per geometry vertex, LEVEL_NONE where unknown.
    pub levels: Vec<Level2>,
    pub steps: Vec<PathStep>,
    /// Stretches under a roof: (first vertex, last vertex, what covers them), in order.
    pub covered: Vec<(u32, u32, Cover)>,
}

/// What a covered stretch of a walk runs under.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Cover {
    /// `covered=*` along a street (arcades, colonnades, roofs).
    Arcade,
    /// `tunnel=building_passage`: through a building.
    Passage,
    /// `tunnel=*`: an underpass.
    Underpass,
    /// Corridors and `indoor=*` ways.
    Indoors,
}

impl Cover {
    pub fn of(kind: EdgeKind, flags: u16) -> Option<Cover> {
        if flags & EF_INDOOR != 0 || kind == EdgeKind::Corridor {
            Some(Cover::Indoors)
        } else if flags & EF_TUNNEL != 0 && flags & EF_COVERED != 0 {
            Some(Cover::Passage)
        } else if flags & EF_COVERED != 0 {
            Some(Cover::Arcade)
        } else if flags & EF_TUNNEL != 0 {
            Some(Cover::Underpass)
        } else {
            None
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Cover::Arcade => "arcade",
            Cover::Passage => "passage",
            Cover::Underpass => "underpass",
            Cover::Indoors => "indoors",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
pub enum StepKind {
    Depart,
    Walk,
    Cross,
    StairsUp,
    StairsDown,
    EscalatorUp,
    EscalatorDown,
    Lift,
    RampUp,
    RampDown,
    Enter,
    Exit,
    Platform,
    Arrive,
}

#[derive(Clone, Debug, Serialize)]
pub struct PathStep {
    pub kind: StepKind,
    /// English instruction.
    pub text: String,
    pub dist_m: f32,
    pub cost: WalkCost,
    /// Street / passage walked along, or the street crossed ("" if unnamed).
    pub name: String,
    /// Level at the start / end of the step, LEVEL_NONE where unknown.
    pub level: Level2,
    pub to_level: Level2,
    /// Vertex range in `geometry`, inclusive. Consecutive steps share a vertex.
    pub from: u32,
    pub to: u32,
}

/// Sizes of the structures built by [`WalkRouter::new`].
#[derive(Clone, Copy, Debug)]
pub struct IndexStats {
    pub grid_cell_m: f32,
    pub grid_cells: usize,
    pub grid_entries: usize,
    pub grid_bytes: usize,
    pub routing_nodes: usize,
    pub arcs: usize,
    pub net_bytes: usize,
    /// Graph nodes that are lifts or touch a lift edge.
    pub lift_nodes: usize,
    /// Junctions with transition costs, and the search states (routing nodes and one per arc into a junction).
    pub junctions: usize,
    pub search_states: usize,
}

impl WalkRouter {
    pub fn new(graph: Arc<WalkGraph>) -> Self {
        let (grid, (net, crumbs)) = rayon::join(
            || index::Grid::build(&graph),
            || {
                let net = net::Net::build(&graph);
                let crumbs = index::Crumbs::from_flags(net.step_free_crumbs(&graph).into_iter());
                (net, crumbs)
            },
        );
        WalkRouter { graph, grid, net, crumbs }
    }

    pub fn graph(&self) -> &Arc<WalkGraph> {
        &self.graph
    }

    /// Nearest point on an allowed edge within `opts.max_dist_m`.
    pub fn snap(&self, p: LatLon, opts: &SnapOptions) -> Option<Snap> {
        let mut out = Vec::with_capacity(1);
        self.grid.nearest(&self.graph, &self.crumbs, p, opts, 1, &mut out);
        out.pop()
    }

    /// Up to `k` nearest distinct edges, nearest first.
    pub fn snap_candidates(&self, p: LatLon, opts: &SnapOptions, k: usize) -> Vec<Snap> {
        let mut out = Vec::with_capacity(k.min(64) + 1);
        self.grid.nearest(&self.graph, &self.crumbs, p, opts, k, &mut out);
        out
    }

    /// May this walker start or end a walk on `edge`? (Its kind and tags allow it, and for a step-free walker it
    /// is not on a crumb cut off by stairs; see [`SNAP_MIN_PIECE_M`].)
    pub fn usable(&self, edge: u32, profile: &WalkProfile) -> bool {
        let Some(ed) = self.graph.edges.get(edge as usize) else { return false };
        index::edge_allowed(edge, ed, &SnapOptions { max_dist_m: 0.0, level: None, profile: Some(*profile), exclude_kinds: 0 }, &self.crumbs)
    }

    /// The point at fraction `frac` of edge `edge` as a [`Snap`] (`dist_m` = 0).
    pub fn snap_at(&self, edge: u32, frac: f32) -> Snap {
        let frac = frac.clamp(0.0, 1.0);
        Snap { edge, frac, pos: path::point_on_edge(&self.graph, edge, frac), dist_m: 0.0 }
    }

    /// Shortest walks from one point to many, bounded by `max_time_s` at the
    /// profile's speed. One result per target, in input order; `None` if the
    /// walk this profile would choose takes longer than `max_time_s` (or does
    /// not exist). The search runs on the generalised cost up to 1.3 ×
    /// `max_time_s` (1.5 × when avoiding stairs, 2 × in wheelchair mode; 0.3
    /// more when minding hills, 1.0 more avoiding them or in a wheelchair: see
    /// `search::bound_slack`), which covers every multiplicative penalty; a
    /// walk close to the bound with several avoided stair flights, or one up a
    /// steep hill all the way, can be missed ([`WalkRouter::quickest_many`]
    /// finds the quickest walk within the time).
    pub fn one_to_many(&self, from: &Snap, targets: &[Snap], profile: &WalkProfile, max_time_s: f32) -> Vec<Option<WalkCost>> {
        search::one_to_many(&self.graph, &self.net, from, targets, profile, max_time_s)
    }

    /// [`WalkRouter::one_to_many`] from the best of several starting points,
    /// each given with the metres already walked to reach it (counted in the
    /// result) and a route-choice penalty in seconds (not counted): the doors
    /// of a building, say.
    pub fn many_to_many(&self, froms: &[(Snap, f32, f32)], targets: &[Snap], profile: &WalkProfile, max_time_s: f32) -> Vec<Option<WalkCost>> {
        search::many_to_many(&self.graph, &self.net, froms, targets, profile, max_time_s)
    }

    /// The search of [`WalkRouter::many_to_many`] without its limit: per target, (the source the cheapest way comes
    /// from, its walking cost with the source's metres, its generalised seconds with the source's offset), for
    /// every target within the search's bound. For choosing among sources by more than the cheapest way.
    pub fn many_to_many_raw(&self, froms: &[(Snap, f32, f32)], targets: &[Snap], profile: &WalkProfile, max_time_s: f32) -> Vec<Option<(usize, WalkCost, f32)>> {
        search::many_to_many_raw(&self.graph, &self.net, froms, targets, profile, max_time_s)
    }

    /// The search network's arcs out of every routing node of graph node `node` (for tools that compare builds):
    /// (routing node, head's graph node, edge or `u32::MAX` for a virtual arc, class, metres, head blocked).
    pub fn arcs_at(&self, node: u32) -> Vec<(u32, u32, u32, u8, f32, u8)> {
        let mut out = Vec::new();
        for r in 0..self.net.n {
            if self.net.orig_node(r) != node {
                continue;
            }
            for a in &self.net.arcs[self.net.out(r)] {
                out.push((r, self.net.orig_node(a.head), a.edge(), a.cls, a.len_m, a.head_block & 7));
            }
        }
        out
    }

    /// [`WalkRouter::route`] from the best of several starting points to the best of several end points, each
    /// with metres already walked to or from it and a route-choice penalty in seconds, as
    /// [`WalkRouter::many_to_many`] takes them: for one end point, the start taken is the one that search's cost
    /// for it comes from. Returns (start index, end index, walk between them, generalised seconds with both offsets).
    pub fn route_between(&self, froms: &[(Snap, f32, f32)], tos: &[(Snap, f32, f32)], profile: &WalkProfile) -> Option<(usize, usize, WalkPath, f32)> {
        let (i, j, legs, gen) = search::route_between(&self.graph, &self.net, froms, tos, profile, false)?;
        Some((i, j, path::build(self, &froms[i].0, &tos[j].0, profile, &legs), gen))
    }

    /// [`WalkRouter::route_between`] by the time walked alone: the quickest walk this walker can take (what it
    /// cannot use stays out, its preferences do not count; the sources' and targets' penalties are ignored). The
    /// last value is its seconds walked, the offsets' metres included.
    pub fn quickest_between(&self, froms: &[(Snap, f32, f32)], tos: &[(Snap, f32, f32)], profile: &WalkProfile) -> Option<(usize, usize, WalkPath, f32)> {
        let plain = |v: &[(Snap, f32, f32)]| v.iter().map(|&(s, m, _)| (s, m, 0.0)).collect::<Vec<_>>();
        let (f, t) = (plain(froms), plain(tos));
        let (i, j, legs, secs) = search::route_between(&self.graph, &self.net, &f, &t, profile, true)?;
        Some((i, j, path::build(self, &f[i].0, &t[j].0, profile, &legs), secs))
    }

    /// [`WalkRouter::many_to_many_raw`] by the time walked alone, as [`WalkRouter::quickest_between`]: per target
    /// within `max_time_s`, the source the quickest walk comes from and its cost. Whether a target can be walked to
    /// within a time does not depend on preferences.
    pub fn quickest_many(&self, froms: &[(Snap, f32, f32)], targets: &[Snap], profile: &WalkProfile, max_time_s: f32) -> Vec<Option<(usize, WalkCost)>> {
        let f: Vec<(Snap, f32, f32)> = froms.iter().map(|&(s, m, _)| (s, m, 0.0)).collect();
        let speed = profile.speed_mps.max(0.05);
        search::many_to_many_mode(&self.graph, &self.net, &f, targets, profile, max_time_s, true)
            .into_iter()
            .map(|r| r.filter(|r| walk_secs(r.1.var_m, r.1.fix_s, speed) <= max_time_s + 0.5).map(|r| (r.0, r.1)))
            .collect()
    }

    /// Best walk between two snapped points with geometry and instructions.
    /// Only `edge` and `frac` of the snaps decide the route. Gives up beyond
    /// roughly an hour more than four times the beeline.
    pub fn route(&self, from: &Snap, to: &Snap, profile: &WalkProfile) -> Option<WalkPath> {
        let legs = search::route(&self.graph, &self.net, from, to, profile)?;
        Some(path::build(self, from, to, profile, &legs))
    }

    /// The edges of the walk [`WalkRouter::route`] would return, in travel
    /// order: (edge, fraction where it is entered, fraction where it is left).
    /// Lift rides through an elevator node have no edge and are left out.
    pub fn route_edges(&self, from: &Snap, to: &Snap, profile: &WalkProfile) -> Option<Vec<(u32, f32, f32)>> {
        let legs = search::route(&self.graph, &self.net, from, to, profile)?;
        Some(legs.iter().filter(|l| l.edge != net::NO_EDGE).map(|l| (l.edge, l.f0, l.f1)).collect())
    }

    /// Passing graph node `node` from edge `e_in` to edge `e_out`: the route-choice seconds of the turn and of
    /// walking over busy roads where no crossing is mapped, and whether it is not allowed (`crossing=no`), as the
    /// rules on now count them (for tools that measure walks).
    pub fn transition(&self, node: u32, e_in: u32, e_out: u32) -> (f32, f32, bool) {
        self.net.transition(&self.graph, node, e_in, e_out)
    }

    /// Edges intersecting `bbox` (for map overlays), ascending.
    pub fn edges_in(&self, bbox: &BBox) -> Vec<u32> {
        self.grid.edges_in(&self.graph, bbox)
    }

    /// Nodes where ways of different floors meet without stairs, ramp or
    /// lift; the router changes floor there only for walkers who may use
    /// stairs, and reports it (for map overlays and data quality reports).
    pub fn level_joins(&self) -> &[LevelJoin] {
        &self.net.joins
    }

    /// Diagnostics: the connected pieces of the network for `profile`. One
    /// id per graph edge (`u32::MAX` = unusable); two points can be joined
    /// by a walk only if their edges carry the same id. Linear in the graph
    /// size — not for use per query.
    pub fn components(&self, profile: &WalkProfile) -> Vec<u32> {
        self.net.components(&self.graph, profile)
    }

    /// Stairs, escalators and ramps whose end levels are the wrong way round
    /// in the graph and are read the other way by this router (diagnostics).
    pub fn upside_down_edges(&self) -> &[u32] {
        &self.net.flipped
    }

    pub fn index_stats(&self) -> IndexStats {
        IndexStats {
            grid_cell_m: self.grid.cell_m(),
            grid_cells: self.grid.cells(),
            grid_entries: self.grid.entries(),
            grid_bytes: self.grid.heap_bytes() + self.crumbs.heap_bytes(),
            routing_nodes: self.net.n as usize,
            arcs: self.net.arcs.len(),
            net_bytes: self.net.heap_bytes(),
            lift_nodes: self.net.n_lift_nodes as usize,
            junctions: self.net.jun.node.len(),
            search_states: self.net.ns as usize,
        }
    }
}
