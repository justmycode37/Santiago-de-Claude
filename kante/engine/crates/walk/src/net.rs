//! Routing network derived from a [`WalkGraph`]: a compact directed arc array
//! with one cost class per arc, lifts expanded into "inside the lift" twin
//! nodes, and waits/penalties that belong to a whole crossing or stair flight
//! spread over the fragments it was split into.

use kante_core::*;
use rayon::prelude::*;
use rustc_hash::FxHashMap;

/// `Arc::edge_dir >> 1` of the virtual arcs that enter / leave a lift.
pub(crate) const NO_EDGE: u32 = u32::MAX >> 1;
pub(crate) const NO_NODE: u32 = u32::MAX;

// Cost class byte: low nibble = kind, high nibble = modifiers.
pub(crate) const C_KIND: u8 = 0x0f;
/// Wheelchairs cannot use it (`wheelchair=no` on the way, or a lift at a barrier node).
pub(crate) const C_WC_BLOCK: u8 = 1 << 4;
pub(crate) const C_ROUGH: u8 = 1 << 5;
/// Steps: has a ramp. Crossing: signals. Road/RoadBusy: sidewalk tagged on the road.
pub(crate) const C_X: u8 = 1 << 6;
/// Crossing: marked (zebra).
pub(crate) const C_Y: u8 = 1 << 7;

pub(crate) const K_FOOTWAY: u8 = EdgeKind::Footway as u8;
pub(crate) const K_SIDEWALK: u8 = EdgeKind::Sidewalk as u8;
pub(crate) const K_CROSSING: u8 = EdgeKind::Crossing as u8;
pub(crate) const K_PATH: u8 = EdgeKind::Path as u8;
pub(crate) const K_PEDESTRIAN: u8 = EdgeKind::Pedestrian as u8;
pub(crate) const K_STEPS: u8 = EdgeKind::Steps as u8;
pub(crate) const K_ESCALATOR: u8 = EdgeKind::Escalator as u8;
pub(crate) const K_LIFT: u8 = EdgeKind::Lift as u8;
pub(crate) const K_CORRIDOR: u8 = EdgeKind::Corridor as u8;
pub(crate) const K_PLATFORM: u8 = EdgeKind::Platform as u8;
pub(crate) const K_ROAD: u8 = EdgeKind::Road as u8;
pub(crate) const K_ROADBUSY: u8 = EdgeKind::RoadBusy as u8;
/// Virtual arc: step into a lift (charges [`LIFT_S`]).
pub(crate) const K_BOARD: u8 = 12;
/// Virtual arc: step out of a lift (free).
pub(crate) const K_ALIGHT: u8 = 13;
/// Virtual arc: change floor at a node where OSM joins flat ways of different
/// levels without stairs, ramp or lift (see [`floors_at`]).
pub(crate) const K_JUMP: u8 = 14;

/// Horizontal metres an unmapped level change is assumed to take per half
/// level, walked as stairs (one floor ≈ 20 steps ≈ 6 m ≈ 10 s at 1.3 m/s).
pub(crate) const JUMP_M_PER_HALF_LEVEL: f32 = 3.0;
/// Route choice: an unmapped level change feels this many seconds longer than
/// it takes, so a mapped staircase or lift a few metres away is preferred.
pub(crate) const JUMP_PENALTY_S: f32 = 20.0;

/// Walking a ramp that runs beside stairs: metres counted per horizontal metre.
pub(crate) const RAMP_FACTOR: f32 = 1.5;
/// `StairsPref::Avoid`: stairs feel this many times longer than they take …
pub(crate) const AVOID_STAIRS_MULT: f32 = 3.0;
/// … plus this many seconds per flight.
pub(crate) const AVOID_STAIRS_FLIGHT_S: f32 = 25.0;

#[derive(Clone, Copy, Debug)]
#[repr(C)]
pub(crate) struct Arc {
    pub head: u32,
    /// `edge << 1 | rev`; `rev` = travelling from node `b` to node `a`.
    pub edge_dir: u32,
    pub len_m: f32,
    pub cls: u8,
    /// [`ARC_BARRIER`] if the head node is a barrier wheelchairs cannot pass
    /// (`NF_NO_WHEELCHAIR`): the arc cannot be walked *to its end* by them,
    /// though a walk may end part-way along it. On a one-way edge (an
    /// escalator) also [`ARC_NO_FWD`] or [`ARC_NO_BACK`]: both its arcs exist,
    /// one for searches in the direction of travel, the other for searches
    /// against it (`WalkProfile::backwards`).
    pub head_block: u8,
    /// Share (×65535) of the class's per-crossing / per-flight constant that
    /// this arc carries. 65535 unless the crossing or flight is split into
    /// several edges.
    pub share: u16,
    /// The slopes ([`kante_core::EdgeSlope::dir`]) of walking the arc (`[0]`) and of walking it the other
    /// way (`[1]`, for searches against the direction of travel), decimetres: extra metres of walking time,
    /// route-choice effort for a walker who minds hills, steepness for a wheelchair.
    pub slope: [[u16; 3]; 2],
}

/// `Arc::head_block`: the head is a barrier for wheelchairs.
pub(crate) const ARC_BARRIER: u8 = 1;
/// `Arc::head_block`: walking the arc is against its one-way edge (only a search against the direction of travel
/// takes it, as the walk the other way).
pub(crate) const ARC_NO_FWD: u8 = 2;
/// `Arc::head_block`: walking the arc the other way is against its one-way edge (a search against the direction of
/// travel does not take it).
pub(crate) const ARC_NO_BACK: u8 = 4;

impl Arc {
    #[inline]
    pub fn edge(&self) -> u32 {
        self.edge_dir >> 1
    }
    #[inline]
    pub fn rev(&self) -> bool {
        self.edge_dir & 1 != 0
    }
}

/// Real time components and route-choice penalty of one cost class.
pub(crate) struct ClassCost {
    /// Speed-dependent metres per metre of edge.
    pub var_m: f32,
    /// Speed-independent seconds per metre of edge.
    pub fix_m: f32,
    /// Speed-independent seconds per whole crossing / lift ride.
    pub fix_c: f32,
    /// Route-choice multiplier on the time (never reported).
    pub pen_mult: f32,
    /// Route-choice seconds per whole flight (never reported).
    pub pen_c: f32,
}

/// Steps with a ramp are walked on the ramp by everyone who avoids stairs.
#[inline]
pub(crate) fn steps_as_ramp(p: &WalkProfile, has_ramp: bool) -> bool {
    has_ramp && (p.stairs != StairsPref::Ok || p.wheelchair)
}

/// `None` = this walker cannot use arcs of class `c`.
pub(crate) fn class_cost(c: u8, p: &WalkProfile) -> Option<ClassCost> {
    if p.wheelchair && c & C_WC_BLOCK != 0 {
        return None;
    }
    let (x, y) = (c & C_X != 0, c & C_Y != 0);
    let mut cc = ClassCost { var_m: 1.0, fix_m: 0.0, fix_c: 0.0, pen_mult: 1.0, pen_c: 0.0 };
    match c & C_KIND {
        K_FOOTWAY | K_SIDEWALK | K_PEDESTRIAN | K_CORRIDOR | K_PLATFORM => {}
        K_PATH => {
            if p.wheelchair {
                cc.pen_mult = 1.3;
            }
        }
        K_CROSSING => {
            cc.fix_c = if x {
                CROSSING_SIGNAL_S
            } else if y {
                CROSSING_MARKED_S
            } else {
                CROSSING_UNMARKED_S
            };
        }
        K_STEPS => {
            if steps_as_ramp(p, x) {
                cc.var_m = RAMP_FACTOR;
                if p.wheelchair {
                    cc.pen_mult = 1.5;
                }
            } else {
                if p.wheelchair {
                    return None;
                }
                cc.var_m = STAIRS_FACTOR;
                match p.stairs {
                    StairsPref::Ok => {}
                    StairsPref::Avoid => {
                        cc.pen_mult = AVOID_STAIRS_MULT;
                        cc.pen_c = AVOID_STAIRS_FLIGHT_S;
                    }
                    StairsPref::Never => return None,
                }
            }
        }
        K_ESCALATOR => {
            if !p.escalators {
                return None;
            }
            cc.var_m = 0.0;
            cc.fix_m = 1.0 / ESCALATOR_MPS;
        }
        K_LIFT => {
            if !p.lifts {
                return None;
            }
            cc.var_m = 0.0;
        }
        K_ROAD => {
            cc.pen_mult = match (x, p.wheelchair) {
                (true, _) => 1.0,
                (false, false) => 1.05,
                (false, true) => 1.15,
            };
        }
        K_ROADBUSY => {
            cc.pen_mult = match (x, p.wheelchair) {
                (true, false) => 1.05,
                (true, true) => 1.1,
                (false, false) => 1.3,
                (false, true) => 2.0,
            };
        }
        K_BOARD => {
            if !p.lifts {
                return None;
            }
            cc.var_m = 0.0;
            cc.fix_c = LIFT_S;
        }
        K_ALIGHT => cc.var_m = 0.0,
        K_JUMP => {
            // Nobody knows what is there: most likely stairs. Never for a
            // walker who must not meet a step.
            if p.wheelchair || p.stairs == StairsPref::Never {
                return None;
            }
            cc.var_m = STAIRS_FACTOR;
            cc.pen_c = JUMP_PENALTY_S;
            if p.stairs == StairsPref::Avoid {
                cc.pen_mult = AVOID_STAIRS_MULT;
                cc.pen_c += AVOID_STAIRS_FLIGHT_S;
            }
        }
        _ => return None,
    }
    // Rough ground in a wheelchair; not stacked on the kind's own penalty, so
    // no multiplier exceeds 2 (the headroom of the bounded search).
    if c & C_ROUGH != 0 && p.wheelchair {
        cc.pen_mult = cc.pen_mult.max(1.8);
    }
    Some(cc)
}

/// Per-profile lookup: generalised cost and time components per class.
pub(crate) struct CostTable {
    /// Generalised seconds per metre; `INFINITY` when unusable.
    pub gen_m: [f32; 256],
    /// Generalised seconds per unit of `Arc::share`.
    pub gen_c: [f32; 256],
    pub var_m: [f32; 256],
    pub fix_m: [f32; 256],
    /// Real seconds per unit of `Arc::share`.
    pub fix_c: [f32; 256],
    pub usable: [bool; 256],
    /// The bits of `Arc::head_block` that keep this search from walking an arc to its end: [`ARC_BARRIER`] for a
    /// walker who cannot pass barrier nodes, and always [`CostTable::dir_mask`].
    pub head_mask: u8,
    /// Generalised seconds per decimetre of `Arc::slope` (time, effort, steepness).
    pub k_slope: [f32; 3],
    /// Which of `Arc::slope` a walk along the arc costs: 1 in a search against the direction of travel.
    pub slope_dir: usize,
    /// The one-way bit of `Arc::head_block` this search may not take ([`ARC_NO_FWD`] or [`ARC_NO_BACK`]).
    pub dir_mask: u8,
}

impl CostTable {
    pub fn new() -> Self {
        CostTable { gen_m: [f32::INFINITY; 256], gen_c: [0.0; 256], var_m: [0.0; 256], fix_m: [0.0; 256], fix_c: [0.0; 256], usable: [false; 256], head_mask: ARC_NO_FWD, k_slope: [0.0; 3], slope_dir: 0, dir_mask: ARC_NO_FWD }
    }
    pub fn fill(&mut self, p: &WalkProfile) {
        let speed = p.speed_mps.max(0.05);
        self.dir_mask = if p.backwards { ARC_NO_BACK } else { ARC_NO_FWD };
        self.head_mask = if p.wheelchair { ARC_BARRIER } else { 0 } | self.dir_mask;
        // a slope's time counts for everyone; its effort as much as the walker minds hills, and a wheelchair
        // minds steep grades on top (unless hills do not matter at all)
        let steep = if p.wheelchair && p.hills != HillsPref::Ignore { 1.0 } else { 0.0 };
        self.k_slope = [0.1 / speed, 0.1 * p.hills.effort_weight() / speed, 0.1 * steep / speed];
        self.slope_dir = p.backwards as usize;
        for c in 0..256usize {
            match class_cost(c as u8, p) {
                Some(cc) => {
                    self.gen_m[c] = (cc.var_m / speed + cc.fix_m) * cc.pen_mult;
                    self.gen_c[c] = (cc.fix_c + cc.pen_c) / 65535.0;
                    self.var_m[c] = cc.var_m;
                    self.fix_m[c] = cc.fix_m;
                    self.fix_c[c] = cc.fix_c / 65535.0;
                    self.usable[c] = true;
                }
                None => {
                    self.gen_m[c] = f32::INFINITY;
                    self.gen_c[c] = 0.0;
                    self.var_m[c] = 0.0;
                    self.fix_m[c] = 0.0;
                    self.fix_c[c] = 0.0;
                    self.usable[c] = false;
                }
            }
        }
    }
    /// As [`CostTable::fill`], but the generalised cost is the time walked: no preferences, only what the walker
    /// cannot use at all stays out (a search that finds the quickest walk).
    pub fn fill_walked(&mut self, p: &WalkProfile) {
        self.fill(p);
        let speed = p.speed_mps.max(0.05);
        self.k_slope = [0.1 / speed, 0.0, 0.0];
        for c in 0..256usize {
            if self.usable[c] {
                self.gen_m[c] = self.var_m[c] / speed + self.fix_m[c];
                self.gen_c[c] = self.fix_c[c];
            }
        }
    }
    /// Can this walker walk the arc to its end (class usable, no barrier at the head)?
    #[inline]
    pub fn through(&self, a: &Arc) -> bool {
        self.usable[a.cls as usize] && a.head_block & self.head_mask == 0
    }
    /// (generalised s, var m, fix s) of `scale` (0..=1) of an arc. Generalised
    /// cost is infinite for an unusable arc. A barrier at the head node is
    /// not considered: use [`CostTable::through`] where the walk goes on past it.
    #[inline]
    pub fn arc(&self, a: &Arc, scale: f32) -> (f32, f32, f32) {
        let c = a.cls as usize;
        if !self.usable[c] || a.head_block & self.dir_mask != 0 {
            return (f32::INFINITY, 0.0, 0.0);
        }
        let l = a.len_m * scale;
        let sh = a.share as f32 * scale;
        (l * self.gen_m[c] + sh * self.gen_c[c] + scale * self.slope_gen(a), l * self.var_m[c] + scale * self.slope_var(a), l * self.fix_m[c] + sh * self.fix_c[c])
    }
    /// Generalised seconds of a whole arc's slopes.
    #[inline]
    pub fn slope_gen(&self, a: &Arc) -> f32 {
        let s = &a.slope[self.slope_dir];
        s[0] as f32 * self.k_slope[0] + s[1] as f32 * self.k_slope[1] + s[2] as f32 * self.k_slope[2]
    }
    /// Metres of walking time a whole arc's slopes add (`var_m`).
    #[inline]
    pub fn slope_var(&self, a: &Arc) -> f32 {
        a.slope[self.slope_dir][0] as f32 * 0.1
    }
}

/// The two arcs of an edge and its end nodes in the routing network.
#[derive(Clone, Copy, Debug)]
pub(crate) struct EdgeArcs {
    pub ia: u32,
    pub ib: u32,
    /// Arc a → b (index into `Net::arcs`; `NO_NODE` only for an edge the network leaves out). On a one-way edge
    /// both arcs exist: `Arc::head_block` says which direction of search may take each.
    pub fwd: u32,
    pub back: u32,
}

pub(crate) struct Net {
    /// Number of nodes of the graph; routing nodes `>= n0` are virtual.
    pub n0: u32,
    /// Number of routing nodes.
    pub n: u32,
    /// Graph node of virtual node `n0 + i`.
    pub orig: Vec<u32>,
    pub arc_off: Vec<u32>,
    pub arcs: Vec<Arc>,
    /// Routing end nodes of the edges that touch a lift.
    pub remap: FxHashMap<u32, [u32; 2]>,
    /// Longest `EdgeKind::Lift` edge: slack for the A* bound inside lifts.
    pub lift_slack_m: f32,
    pub n_lift_nodes: u32,
    /// Routing nodes `>= lift_from` belong to a lift (floors and "inside"
    /// twins); virtual nodes below it are floors of a [`LevelJoin`].
    pub lift_from: u32,
    /// Nodes where ways of different floors meet without a connector.
    pub joins: Vec<LevelJoin>,
    /// Stairs, escalators and ramps whose two end levels are the wrong way
    /// round in the graph (see [`upside_down`]), ascending.
    pub flipped: Vec<u32>,
}

impl Net {
    /// The edge as the router reads it: end levels and the up-direction
    /// exchanged if the graph has them the wrong way round.
    pub fn edge_view(&self, g: &WalkGraph, e: u32) -> WalkEdge {
        let mut ed = g.edges[e as usize];
        if self.flipped.binary_search(&e).is_ok() {
            std::mem::swap(&mut ed.level_a, &mut ed.level_b);
            let up = ed.flags & (EF_UP_AB | EF_UP_BA);
            ed.flags &= !(EF_UP_AB | EF_UP_BA);
            if up & EF_UP_AB != 0 {
                ed.flags |= EF_UP_BA;
            }
            if up & EF_UP_BA != 0 {
                ed.flags |= EF_UP_AB;
            }
        }
        ed
    }
}

/// Multi-level edges (stairs, escalators, ramps with `level_a != level_b`)
/// that are upside down: at *both* ends the flat ways meeting there are on
/// the level the graph gives to the other end. The importer orients a way
/// tagged `level=-1;0` from `incline` or from its surroundings; where that
/// went wrong, instructions would say "stairs down to level −1" for the
/// stairs up into the hall. Costs do not depend on the direction, so only
/// levels, wording and the up/down step counts are corrected.
fn upside_down(g: &WalkGraph) -> Vec<u32> {
    let has = |n: u32, l: Level2| g.incident(n).iter().any(|&f| {
        let fd = &g.edges[f as usize];
        fd.level_a == fd.level_b && fd.level_a == l && !matches!(fd.kind, EdgeKind::Steps | EdgeKind::Escalator | EdgeKind::Lift)
    });
    (0..g.edges.len() as u32)
        .into_par_iter()
        .filter(|&e| {
            let ed = &g.edges[e as usize];
            if ed.kind == EdgeKind::Lift || ed.level_a == ed.level_b || ed.level_a == LEVEL_NONE || ed.level_b == LEVEL_NONE {
                return false;
            }
            has(ed.a, ed.level_b) && !has(ed.a, ed.level_a) && has(ed.b, ed.level_a) && !has(ed.b, ed.level_b)
        })
        .collect()
}

/// Why the ways meeting at a node are taken to be on different floors.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LevelJoinKind {
    /// Flat ways tagged with different `level`s share the node.
    Levels,
    /// A pedestrian tunnel or indoor way below ground and an untagged
    /// street-level way both run through the node.
    StreetOverTunnel,
    /// A footbridge with a level above ground and an untagged street-level
    /// way both run through the node.
    StreetUnderBridge,
}

/// A node at which the router does not let a walker change floor for free.
#[derive(Clone, Debug)]
pub struct LevelJoin {
    pub node: u32,
    pub kind: LevelJoinKind,
    /// The floors that meet here; `LEVEL_NONE` = untagged street level.
    pub levels: Vec<Level2>,
}

/// One end of an edge at a node, as [`floors_at`] sees it.
#[derive(Clone, Copy)]
struct End {
    level: Level2,
    /// Stays on one floor (not stairs, escalator, lift or a multi-level ramp).
    flat: bool,
    kind: EdgeKind,
    flags: u16,
}

/// Decides whether the edge ends meeting at a node are on one floor.
///
/// OSM joins ways in a node wherever a mapper drew them through the same
/// point; nothing says the ways are at the same height. Two patterns are
/// read as "different floors, connection unknown":
///
/// 1. **Different known levels**: flat ways (not stairs, escalators, lifts or
///    multi-level ramps) with different `level` tags. Nationally 326 nodes,
///    321 of them a whole level or more apart — mostly an underpass or
///    concourse polygon sharing outline nodes with the platform above it.
///    Exception: if all the levelled ways are carriageways (`Road`,
///    `RoadBusy`), vehicles drive through, so it is a slope and stays joined
///    (all five half-level cases nationally are of this kind: car park ramps).
/// 2. **Street over tunnel / under bridge**: a pedestrian way below ground
///    (level < 0, a real tunnel or indoors) continues through the node, and so
///    does an untagged open-air way that is certainly at street level (the
///    group contains a crossing, sidewalk, carriageway or platform). The
///    mirror case is a footbridge with level > 0.
///
/// Deliberately *not* split: a levelled way that simply continues as an
/// untagged one (about 1 900 nodes: bridges and tunnels tagged `level=±1`
/// running into their approach, building exits onto a slope) — these are
/// continuous surfaces or plausible ramps; and tunnels without any level tag
/// crossing a street node (arcades tagged `tunnel=building_passage`, covered
/// passages with a real crossing) — not decidable from the graph.
///
/// On a split, `group[i]` receives the floor index of `ends[i]` and the
/// floors' levels are returned. Ends that fit no floor exactly join the
/// nearest one (untagged counts as ground).
fn floors_at(ends: &[End], group: &mut Vec<u8>) -> Option<(LevelJoinKind, Vec<Level2>)> {
    group.clear();
    let carriageway = |k: EdgeKind| matches!(k, EdgeKind::Road | EdgeKind::RoadBusy);
    let mut known: Vec<Level2> = ends.iter().filter(|e| e.flat && e.level != LEVEL_NONE).map(|e| e.level).collect();
    known.sort_unstable();
    known.dedup();
    if known.is_empty() || known.len() > 250 {
        return None;
    }
    let nearest = |floors: &[Level2], l: Level2| -> u8 {
        let l = lvl0(l) as i32;
        let mut best = (i32::MAX, 0u8);
        for (i, &f) in floors.iter().enumerate() {
            let d = (lvl0(f) as i32 - l).abs();
            if d < best.0 {
                best = (d, i as u8);
            }
        }
        best.1
    };
    if known.len() >= 2 {
        if ends.iter().filter(|e| e.flat && e.level != LEVEL_NONE).all(|e| carriageway(e.kind)) {
            return None;
        }
        group.extend(ends.iter().map(|e| nearest(&known, e.level)));
        return Some((LevelJoinKind::Levels, known));
    }
    let l = known[0];
    if l == 0 {
        return None;
    }
    // Stairs without a level arriving here could belong to either side.
    if ends.iter().any(|e| !e.flat && e.level == LEVEL_NONE) {
        return None;
    }
    let (off_ground, kind) = if l < 0 { (EF_TUNNEL | EF_INDOOR, LevelJoinKind::StreetOverTunnel) } else { (EF_BRIDGE, LevelJoinKind::StreetUnderBridge) };
    let buried = |e: &End| {
        if l < 0 {
            e.flags & EF_INDOOR != 0 || e.flags & (EF_TUNNEL | EF_COVERED) == EF_TUNNEL
        } else {
            e.flags & EF_BRIDGE != 0
        }
    };
    let (mut n_lev, mut n_street, mut street_kind) = (0, 0, false);
    for e in ends.iter().filter(|e| e.flat) {
        if e.level == l {
            if carriageway(e.kind) || !buried(e) {
                return None;
            }
            n_lev += 1;
        } else if e.flags & (off_ground | EF_TUNNEL | EF_INDOOR) == 0 {
            n_street += 1;
            street_kind |= matches!(e.kind, EdgeKind::Crossing | EdgeKind::Sidewalk | EdgeKind::Road | EdgeKind::RoadBusy | EdgeKind::Platform);
        }
    }
    if n_lev < 2 || n_street < 2 || !street_kind {
        return None;
    }
    // Floor 0 = the levelled way, floor 1 = the street.
    group.extend(ends.iter().map(|e| {
        if e.level == LEVEL_NONE {
            (e.flags & (off_ground | EF_TUNNEL | EF_INDOOR) == 0) as u8
        } else {
            ((e.level as i32 - l as i32).abs() > (e.level as i32).abs()) as u8
        }
    }));
    Some((kind, vec![l, LEVEL_NONE]))
}


#[inline]
pub(crate) fn lvl0(l: Level2) -> Level2 {
    if l == LEVEL_NONE {
        0
    } else {
        l
    }
}

struct Dsu(Vec<u32>);
impl Dsu {
    fn find(&mut self, mut x: u32) -> u32 {
        while self.0[x as usize] != x {
            let p = self.0[x as usize];
            self.0[x as usize] = self.0[p as usize];
            x = p;
        }
        x
    }
    fn union(&mut self, a: u32, b: u32) {
        let (a, b) = (self.find(a), self.find(b));
        if a != b {
            self.0[a as usize] = b;
        }
    }
}

impl Net {
    pub fn build(g: &WalkGraph) -> Net {
        let n0 = g.nodes.len() as u32;
        let flipped = upside_down(g);
        let is_flipped = |e: u32| flipped.binary_search(&e).is_ok();
        let nflag = |n: u32| g.node_flags.get(n as usize).copied().unwrap_or(0);
        let way = |e: u32| g.edge_way.get(e as usize).copied().unwrap_or(0);

        // ---- lifts: split elevator nodes by level, add an "inside" twin
        let mut special: Vec<u32> = Vec::new();
        for (n, &f) in g.node_flags.iter().enumerate() {
            if f & NF_ELEVATOR != 0 {
                special.push(n as u32);
            }
        }
        let mut lift_slack_m = 0f32;
        for ed in &g.edges {
            if ed.kind == EdgeKind::Lift {
                special.push(ed.a);
                special.push(ed.b);
                lift_slack_m = lift_slack_m.max(ed.len_m());
            }
        }
        special.sort_unstable();
        special.dedup();

        let mut orig: Vec<u32> = Vec::new();
        let mut remap: FxHashMap<u32, [u32; 2]> = FxHashMap::default();
        // (tail, head, class, metres)
        let mut virt: Vec<(u32, u32, u8, f32)> = Vec::new();
        let mut ends: Vec<(u32, usize)> = Vec::new();
        let mut groups: Vec<(Level2, u32)> = Vec::new();

        // ---- ways of different floors joined in one node: one routing node
        // per floor, joined by "unmapped level change" arcs
        let is_special = |n: u32| special.binary_search(&n).is_ok();
        let end_of = |e: u32, end: usize| -> End {
            let ed = &g.edges[e as usize];
            End {
                level: if (end == 0) != is_flipped(e) { ed.level_a } else { ed.level_b },
                flat: ed.level_a == ed.level_b && !matches!(ed.kind, EdgeKind::Steps | EdgeKind::Escalator | EdgeKind::Lift),
                kind: ed.kind,
                flags: ed.flags,
            }
        };
        let candidates: Vec<u32> = (0..n0)
            .into_par_iter()
            .filter(|&n| {
                // cheap test: two different levels among the incident edges
                let inc = g.incident(n);
                let Some(&first) = inc.first() else { return false };
                let l = g.edges[first as usize].level_a;
                inc.iter().any(|&e| g.edges[e as usize].level_a != l || g.edges[e as usize].level_b != l)
            })
            .collect();
        let mut joins: Vec<LevelJoin> = Vec::new();
        let mut floor_of: Vec<u8> = Vec::new();
        let mut end_info: Vec<End> = Vec::new();
        let mut ids: Vec<u32> = Vec::new();
        for &n in &candidates {
            if is_special(n) {
                continue;
            }
            ends.clear();
            for &e in g.incident(n) {
                let ed = &g.edges[e as usize];
                for (end, node) in [ed.a, ed.b].into_iter().enumerate() {
                    if node == n && !ends.contains(&(e, end)) {
                        ends.push((e, end));
                    }
                }
            }
            end_info.clear();
            end_info.extend(ends.iter().map(|&(e, end)| end_of(e, end)));
            let Some((kind, levels)) = floors_at(&end_info, &mut floor_of) else { continue };
            ids.clear();
            for f in 0..levels.len() {
                // An empty floor cannot happen (every floor has a flat end), but stay safe.
                ids.push(if f == 0 {
                    n
                } else {
                    orig.push(n);
                    n0 + orig.len() as u32 - 1
                });
            }
            for (i, &(e, end)) in ends.iter().enumerate() {
                let id = ids[floor_of[i] as usize];
                if id != n {
                    let ed = &g.edges[e as usize];
                    remap.entry(e).or_insert([ed.a, ed.b])[end] = id;
                }
            }
            let wc = if nflag(n) & NF_NO_WHEELCHAIR != 0 { C_WC_BLOCK } else { 0 };
            for i in 0..levels.len() {
                for j in 0..levels.len() {
                    if i != j {
                        let rise = (lvl0(levels[i]) as i32 - lvl0(levels[j]) as i32).abs().max(1) as f32;
                        virt.push((ids[i], ids[j], K_JUMP | wc, rise * JUMP_M_PER_HALF_LEVEL));
                    }
                }
            }
            joins.push(LevelJoin { node: n, kind, levels });
        }
        let lift_from = n0 + orig.len() as u32;

        for &n in &special {
            ends.clear();
            for &e in g.incident(n) {
                let ed = &g.edges[e as usize];
                for (end, node) in [ed.a, ed.b].into_iter().enumerate() {
                    if node == n && !ends.contains(&(e, end)) {
                        ends.push((e, end));
                    }
                }
            }
            let is_lift = |e: u32| g.edges[e as usize].kind == EdgeKind::Lift;
            let level_at = |e: u32, end: usize| {
                let ed = &g.edges[e as usize];
                if (end == 0) != is_flipped(e) {
                    ed.level_a
                } else {
                    ed.level_b
                }
            };
            let n_lift = ends.iter().filter(|&&(e, _)| is_lift(e)).count();
            let elevator = nflag(n) & NF_ELEVATOR != 0;
            groups.clear();
            let mut twin = NO_NODE;
            let new_node = |orig: &mut Vec<u32>| {
                orig.push(n);
                n0 + orig.len() as u32 - 1
            };
            // Non-lift ways, grouped by floor.
            let mut assigned: Vec<(u32, usize, u32)> = Vec::with_capacity(ends.len());
            for &(e, end) in ends.iter().filter(|&&(e, _)| !is_lift(e)) {
                // A node that already has lift edges is one floor of that lift
                // (the importer's "port"): its ways are not split again.
                let key = if !elevator || n_lift > 0 { 0 } else { lvl0(level_at(e, end)) };
                let found = groups.iter().find(|g| g.0 == key).map(|g| g.1);
                let id = match found {
                    Some(id) => id,
                    None => {
                        let id = if groups.is_empty() { n } else { new_node(&mut orig) };
                        groups.push((key, id));
                        id
                    }
                };
                assigned.push((e, end, id));
            }
            if n_lift > 0 || groups.len() >= 2 {
                twin = new_node(&mut orig);
            }
            for &(e, end) in ends.iter().filter(|&&(e, _)| is_lift(e)) {
                assigned.push((e, end, twin));
            }
            for &(e, end, id) in &assigned {
                if id != n {
                    let ed = &g.edges[e as usize];
                    remap.entry(e).or_insert([ed.a, ed.b])[end] = id;
                }
            }
            if twin != NO_NODE {
                let wc = if nflag(n) & NF_NO_WHEELCHAIR != 0 { C_WC_BLOCK } else { 0 };
                for &(_, id) in &groups {
                    virt.push((id, twin, K_BOARD | wc, 0.0));
                    virt.push((twin, id, K_ALIGHT, 0.0));
                }
            }
        }
        let n = n0 + orig.len() as u32;

        // ---- crossings and stair flights split into several edges: the wait /
        // per-flight penalty is shared out by length so it is charged once.
        let mut chain_idx: FxHashMap<u32, u32> = FxHashMap::default();
        let mut chain_edges: Vec<u32> = Vec::new();
        for (e, ed) in g.edges.iter().enumerate() {
            if matches!(ed.kind, EdgeKind::Crossing | EdgeKind::Steps) {
                chain_idx.insert(e as u32, chain_edges.len() as u32);
                chain_edges.push(e as u32);
            }
        }
        let mut dsu = Dsu((0..chain_edges.len() as u32).collect());
        for (i, &e) in chain_edges.iter().enumerate() {
            let ed = &g.edges[e as usize];
            let w = way(e);
            if w == 0 {
                continue;
            }
            for node in [ed.a, ed.b] {
                for &f in g.incident(node) {
                    if f > e && way(f) == w && g.edges[f as usize].kind == ed.kind {
                        if let Some(&j) = chain_idx.get(&f) {
                            dsu.union(i as u32, j);
                        }
                    }
                }
            }
        }
        let mut chain_len = vec![0f32; chain_edges.len()];
        let mut chain_flags = vec![0u16; chain_edges.len()];
        for (i, &e) in chain_edges.iter().enumerate() {
            let r = dsu.find(i as u32) as usize;
            let ed = &g.edges[e as usize];
            chain_len[r] += ed.len_m();
            let mut f = ed.flags & (EF_SIGNALS | EF_MARKED);
            if ed.kind == EdgeKind::Crossing && (nflag(ed.a) | nflag(ed.b)) & NF_CROSSING_SIGNALS != 0 {
                f |= EF_SIGNALS;
            }
            chain_flags[r] |= f;
        }

        // ---- arcs
        let ends_of = |e: u32, ed: &WalkEdge| -> (u32, u32) {
            if remap.is_empty() {
                return (ed.a, ed.b);
            }
            match remap.get(&e) {
                Some(r) => (r[0], r[1]),
                None => (ed.a, ed.b),
            }
        };
        let mut arc_off = vec![0u32; n as usize + 2];
        // both arcs of every edge: those against a one-way edge for searches against the direction of travel
        for (e, ed) in g.edges.iter().enumerate() {
            let (ia, ib) = ends_of(e as u32, ed);
            arc_off[ia as usize + 2] += 1;
            arc_off[ib as usize + 2] += 1;
        }
        for &(t, _, _, _) in &virt {
            arc_off[t as usize + 2] += 1;
        }
        for i in 2..arc_off.len() {
            arc_off[i] += arc_off[i - 1];
        }
        let total = arc_off[n as usize + 1] as usize;
        let blank = Arc { head: 0, edge_dir: 0, len_m: 0.0, cls: 0, head_block: 0, share: 0, slope: [[0; 3]; 2] };
        let mut arcs = vec![blank; total];
        // the slopes of each direction, when a terrain model gave the graph some
        let has_slopes = g.slopes.len() == g.edges.len();
        let slope_of = |e: u32, rev: bool| -> [[u16; 3]; 2] {
            if has_slopes {
                let ((t, f, s), (t2, f2, s2)) = (g.slopes[e as usize].dir(rev), g.slopes[e as usize].dir(!rev));
                [[t, f, s], [t2, f2, s2]]
            } else {
                [[0; 3]; 2]
            }
        };
        // arc_off[i + 1] is the fill cursor of node i; after filling it is the
        // end of node i = start of node i + 1.
        for (e, ed) in g.edges.iter().enumerate() {
            let e = e as u32;
            let (ia, ib) = ends_of(e, ed);
            let mut flags = ed.flags;
            let mut share = 65535u16;
            if let Some(&ci) = chain_idx.get(&e) {
                let r = dsu.find(ci) as usize;
                flags |= chain_flags[r];
                if chain_len[r] > ed.len_m() + 0.05 {
                    share = ((ed.len_m() / chain_len[r]) * 65535.0).round().clamp(1.0, 65535.0) as u16;
                }
            }
            let mut base = ed.kind as u8;
            if flags & EF_WHEELCHAIR_NO != 0 {
                base |= C_WC_BLOCK;
            }
            if flags & EF_ROUGH != 0 {
                base |= C_ROUGH;
            }
            match ed.kind {
                EdgeKind::Steps => {
                    if flags & EF_RAMP != 0 {
                        base |= C_X;
                    }
                }
                EdgeKind::Crossing => {
                    if flags & EF_SIGNALS != 0 {
                        base |= C_X;
                    } else if flags & EF_MARKED != 0 {
                        base |= C_Y;
                    }
                }
                EdgeKind::Road | EdgeKind::RoadBusy => {
                    if flags & EF_HAS_SIDEWALK != 0 {
                        base |= C_X;
                    }
                }
                _ => {}
            }
            // Never shorter than the beeline between its ends: `len_dm` is
            // rounded to decimetres, and A* needs cost >= distance covered.
            let len_m = ed.len_m().max(g.nodes[ed.a as usize].dist_m(&g.nodes[ed.b as usize]));
            let (ab, ba) = (ed.flags & EF_ONEWAY_BA == 0, ed.flags & EF_ONEWAY_AB == 0);
            let dir_bits = |fwd: bool, back: bool| if fwd { 0 } else { ARC_NO_FWD } | if back { 0 } else { ARC_NO_BACK };
            {
                let head_block = if nflag(ed.b) & NF_NO_WHEELCHAIR != 0 { ARC_BARRIER } else { 0 } | dir_bits(ab, ba);
                let slot = &mut arc_off[ia as usize + 1];
                arcs[*slot as usize] = Arc { head: ib, edge_dir: e << 1, len_m, cls: base, head_block, share, slope: slope_of(e, false) };
                *slot += 1;
            }
            {
                let head_block = if nflag(ed.a) & NF_NO_WHEELCHAIR != 0 { ARC_BARRIER } else { 0 } | dir_bits(ba, ab);
                let slot = &mut arc_off[ib as usize + 1];
                arcs[*slot as usize] = Arc { head: ia, edge_dir: e << 1 | 1, len_m, cls: base, head_block, share, slope: slope_of(e, true) };
                *slot += 1;
            }
        }
        for &(t, h, cls, len_m) in &virt {
            let slot = &mut arc_off[t as usize + 1];
            arcs[*slot as usize] = Arc { head: h, edge_dir: NO_EDGE << 1, len_m, cls, head_block: 0, share: 65535, slope: [[0; 3]; 2] };
            *slot += 1;
        }
        arc_off.truncate(n as usize + 1);
        debug_assert_eq!(arc_off[n as usize] as usize, total);

        Net { n0, n, orig, arc_off, arcs, remap, lift_slack_m, n_lift_nodes: special.len() as u32, lift_from, joins, flipped }
    }

    #[inline]
    pub fn out(&self, node: u32) -> std::ops::Range<usize> {
        self.arc_off[node as usize] as usize..self.arc_off[node as usize + 1] as usize
    }

    /// Graph node behind a routing node.
    #[inline]
    pub fn orig_node(&self, node: u32) -> u32 {
        if node < self.n0 {
            node
        } else {
            self.orig[(node - self.n0) as usize]
        }
    }

    pub fn edge_arcs(&self, g: &WalkGraph, e: u32) -> EdgeArcs {
        let ed = &g.edges[e as usize];
        let (ia, ib) = match self.remap.get(&e) {
            Some(r) if !self.remap.is_empty() => (r[0], r[1]),
            _ => (ed.a, ed.b),
        };
        let find = |tail: u32, key: u32| -> u32 {
            let r = self.out(tail);
            let base = r.start;
            self.arcs[r].iter().position(|a| a.edge_dir == key).map(|i| (base + i) as u32).unwrap_or(NO_NODE)
        };
        EdgeArcs { ia, ib, fwd: find(ia, e << 1), back: find(ib, e << 1 | 1) }
    }

    /// Connected pieces of the network as `p` can walk it: one id per graph
    /// edge, `u32::MAX` for an edge the profile cannot use. An edge joins its
    /// two ends only if it can be walked in both directions (or is one-way
    /// by nature), so a barrier node separates what lies on either side.
    pub fn components(&self, g: &WalkGraph, p: &WalkProfile) -> Vec<u32> {
        let mut table = CostTable::new();
        table.fill(p);
        let ok = |arc: u32| arc != NO_NODE && table.through(&self.arcs[arc as usize]);
        let mut dsu = Dsu((0..self.n).collect());
        let mut usable = vec![false; g.edges.len()];
        for (e, ed) in g.edges.iter().enumerate() {
            let ea = self.edge_arcs(g, e as u32);
            let oneway = ed.flags & (EF_ONEWAY_AB | EF_ONEWAY_BA) != 0;
            let (f, b) = (ok(ea.fwd), ok(ea.back));
            if (f && b) || (oneway && (f || b)) {
                dsu.union(ea.ia, ea.ib);
            }
            // Standing on it is possible whenever its class is (a walk may end part-way).
            usable[e] = [ea.fwd, ea.back].into_iter().any(|a| a != NO_NODE && table.usable[self.arcs[a as usize].cls as usize]);
        }
        for u in self.n0.min(self.n)..self.n {
            for a in &self.arcs[self.out(u)] {
                if a.edge() == NO_EDGE && table.usable[a.cls as usize] {
                    dsu.union(u, a.head);
                }
            }
        }
        for u in 0..self.n0 {
            for a in &self.arcs[self.out(u)] {
                if a.edge() == NO_EDGE && table.usable[a.cls as usize] {
                    dsu.union(u, a.head);
                }
            }
        }
        (0..g.edges.len())
            .map(|e| {
                if !usable[e] {
                    return u32::MAX;
                }
                // The end the edge can be reached from: walking a → b needs no
                // passage through b, only through a (and the other way round).
                // With a barrier at both ends it is a piece of its own.
                let ea = self.edge_arcs(g, e as u32);
                let open = |n: u32| g.node_flags.get(self.orig_node(n) as usize).copied().unwrap_or(0) & NF_NO_WHEELCHAIR == 0 || table.head_mask & ARC_BARRIER == 0;
                if open(ea.ia) {
                    dsu.find(ea.ia)
                } else if open(ea.ib) {
                    dsu.find(ea.ib)
                } else {
                    u32::MAX - 1 - e as u32
                }
            })
            .collect()
    }

    /// Per edge: is it on a crumb of the step-free network — a piece with
    /// less than [`crate::SNAP_MIN_PIECE_M`] of ways which a walker without
    /// restrictions could leave (so stairs or a barrier are what cuts it off)?
    pub fn step_free_crumbs(&self, g: &WalkGraph) -> Vec<bool> {
        let comp = self.components(g, &WalkProfile::step_free(DEFAULT_SPEED_MPS));
        // Plain connectivity of the graph, whatever the edges are.
        let mut all = Dsu((0..g.nodes.len() as u32).collect());
        for ed in &g.edges {
            all.union(ed.a, ed.b);
        }
        let mut len: FxHashMap<u32, f32> = FxHashMap::default();
        let mut len_all: FxHashMap<u32, f32> = FxHashMap::default();
        for (e, ed) in g.edges.iter().enumerate() {
            if comp[e] != u32::MAX {
                *len.entry(comp[e]).or_default() += ed.len_m();
            }
            *len_all.entry(all.find(ed.a)).or_default() += ed.len_m();
        }
        (0..g.edges.len())
            .map(|e| {
                let c = comp[e];
                c != u32::MAX && len[&c] < crate::SNAP_MIN_PIECE_M && len_all[&all.find(g.edges[e].a)] > len[&c] + 0.5
            })
            .collect()
    }

    pub fn heap_bytes(&self) -> usize {
        self.arcs.len() * std::mem::size_of::<Arc>() + self.arc_off.len() * 4 + self.orig.len() * 4 + self.remap.len() * 16
    }
}
