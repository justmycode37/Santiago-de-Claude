//! Turn-by-turn instructions: merges the traversed edges into the steps a
//! person hurrying through a station perceives, and words them.
//!
//! 1. Indoor/outdoor transitions become Enter/Exit events (at doors, or
//!    between two walked stretches that are not a tunnel).
//! 2. Consecutive pieces of the same kind form a group; walks additionally
//!    split where the name changes or the route turns at a real junction.
//! 3. Unnamed walk fragments under 8 m are folded into a neighbour, then
//!    neighbours that now fit together are merged.
//! 4. Each group is worded; a turn word is added where the geometry around
//!    the step boundary turns by more than 35°.

use crate::net::{C_X, C_Y, NO_EDGE, NO_NODE};
use crate::path::{Cat, Dir, Piece};
use crate::{PathStep, StepKind, WalkCost};
use kante_core::geo::compass8;
use kante_core::*;

/// Unnamed walk groups shorter than this disappear into a neighbour.
const FOLD_M: f32 = 8.0;
/// The first and the last walk of a route disappear into their neighbour
/// below this length whatever they are called: "walk 2 m along the platform"
/// before the destination is noise.
const END_FOLD_M: f32 = 5.0;
/// An unnamed walk this short is absorbed by a named one it runs straight into.
const ABSORB_M: f32 = 25.0;
/// A walk is split at a junction where the route turns at least this much.
const SPLIT_TURN_DEG: f32 = 45.0;
/// Turn words appear from this angle.
const SAY_TURN_DEG: f32 = 35.0;
/// Bearings are taken over this distance before and after a vertex.
const LOOK_M: f32 = 10.0;
/// An Exit and an Enter this close together are both dropped.
const FLICKER_M: f32 = 12.0;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Ev {
    None,
    Enter { door: bool, tunnel: bool },
    Exit { tunnel: bool },
}

#[derive(Clone, Copy, Debug)]
struct Group {
    cat: Cat,
    p0: usize,
    /// Exclusive.
    p1: usize,
}

struct Ctx<'a> {
    g: &'a WalkGraph,
    geom: &'a [LatLon],
    pieces: &'a [Piece],
    /// Distance along the path at each vertex.
    cum: Vec<f32>,
    ev: Vec<Ev>,
}

fn inside(p: &Piece) -> bool {
    p.flags & EF_INDOOR != 0 || p.kind == EdgeKind::Corridor
}

pub(crate) fn fmt_level(l: Level2) -> String {
    let a = (l as i32).abs();
    let s = if a % 2 == 0 { format!("{}", a / 2) } else { format!("{}.5", a / 2) };
    if l < 0 {
        format!("\u{2212}{s}")
    } else {
        s
    }
}

/// "ground level" for 0, else "level −1" / "level 2".
pub(crate) fn level_name(l: Level2) -> String {
    if l == 0 {
        "ground level".to_string()
    } else {
        format!("level {}", fmt_level(l))
    }
}

pub(crate) fn fmt_dist(d: f32) -> String {
    let m = if d < 20.0 {
        d.round().max(1.0)
    } else if d < 100.0 {
        (d / 5.0).round() * 5.0
    } else {
        (d / 10.0).round() * 10.0
    };
    format!("{} m", m as i32)
}

fn turn_phrase(angle: f32) -> Option<&'static str> {
    let a = angle.abs();
    if a < SAY_TURN_DEG {
        return None;
    }
    let right = angle > 0.0;
    Some(match (a < 60.0, a <= 135.0, right) {
        (true, _, true) => "Bear right",
        (true, _, false) => "Bear left",
        (false, true, true) => "Turn right",
        (false, true, false) => "Turn left",
        (false, false, true) => "Turn sharp right",
        (false, false, false) => "Turn sharp left",
    })
}

fn with_turn(turn: Option<&'static str>, base: String) -> String {
    match turn {
        None => base,
        Some(t) => {
            let mut c = base.chars();
            match c.next() {
                Some(f) => format!("{t} and {}{}", f.to_lowercase(), c.as_str()),
                None => t.to_string(),
            }
        }
    }
}

fn compass_word(bearing: f32) -> &'static str {
    match compass8(bearing) {
        "N" => "north",
        "NE" => "north-east",
        "E" => "east",
        "SE" => "south-east",
        "S" => "south",
        "SW" => "south-west",
        "W" => "west",
        _ => "north-west",
    }
}

impl<'a> Ctx<'a> {
    fn point_at(&self, d: f32) -> LatLon {
        let n = self.geom.len();
        if n == 1 || d <= 0.0 {
            return self.geom[0];
        }
        let j = self.cum.partition_point(|&c| c <= d).clamp(1, n - 1);
        let seg = self.cum[j] - self.cum[j - 1];
        let t = if seg > 0.0 { ((d - self.cum[j - 1]) / seg).clamp(0.0, 1.0) } else { 1.0 };
        self.geom[j - 1].lerp(&self.geom[j], t)
    }

    /// Signed turn at vertex `v` in degrees (positive = right), measured over
    /// [`LOOK_M`] on both sides so that small jogs do not register.
    fn turn_at(&self, v: usize) -> Option<f32> {
        let here = self.cum[v];
        let total = *self.cum.last()?;
        let back = (here - LOOK_M).max(0.0);
        let fwd = (here + LOOK_M).min(total);
        if here - back < 2.0 || fwd - here < 2.0 {
            return None;
        }
        let (a, b, c) = (self.point_at(back), self.geom[v], self.point_at(fwd));
        let mut d = b.bearing_deg(&c) - a.bearing_deg(&b);
        while d > 180.0 {
            d -= 360.0;
        }
        while d <= -180.0 {
            d += 360.0;
        }
        Some(d)
    }

    fn way(&self, p: &Piece) -> i64 {
        self.g.edge_way.get(p.edge as usize).copied().unwrap_or(0)
    }

    /// Both pieces cross the same open area (square, concourse, platform):
    /// direction changes inside it are not junctions.
    fn same_area(&self, a: &Piece, b: &Piece) -> bool {
        if a.flags & b.flags & EF_AREA != 0 {
            return true;
        }
        let open = |p: &Piece| matches!(p.kind, EdgeKind::Pedestrian | EdgeKind::Platform);
        open(a) && open(b) && self.way(a) != 0 && self.way(a) == self.way(b)
    }

    /// The level changes between two pieces although neither is a stair, ramp or lift.
    fn level_jump(&self, i: usize) -> bool {
        let (a, b) = (&self.pieces[i], &self.pieces[i + 1]);
        a.l1 != LEVEL_NONE && b.l0 != LEVEL_NONE && a.l1 != b.l0
    }

    /// Does the route turn at the junction after piece `i`?
    fn junction_turn(&self, i: usize) -> bool {
        let (a, b) = (&self.pieces[i], &self.pieces[i + 1]);
        if a.end_node == NO_NODE || self.same_area(a, b) {
            return false;
        }
        if self.g.incident(a.end_node).len() < 3 {
            return false; // a bend, not a decision
        }
        matches!(self.turn_at(a.v1 as usize), Some(t) if t.abs() >= SPLIT_TURN_DEG)
    }

    fn split(&self, i: usize) -> bool {
        if self.ev[i] != Ev::None {
            return true;
        }
        let (a, b) = (&self.pieces[i], &self.pieces[i + 1]);
        if a.cat != b.cat {
            return true;
        }
        if a.cat != Cat::Walk {
            return false;
        }
        const SCENE: u16 = EF_TUNNEL | EF_BRIDGE;
        a.name != b.name || inside(a) != inside(b) || (a.flags & SCENE) != (b.flags & SCENE) || self.level_jump(i) || self.junction_turn(i)
    }

    fn dist(&self, gr: &Group) -> f32 {
        self.pieces[gr.p0..gr.p1].iter().map(|p| p.dist).sum()
    }

    /// Share of the group's length for which `f` holds is at least a half.
    fn mostly(&self, gr: &Group, f: impl Fn(&Piece) -> bool) -> bool {
        let (mut yes, mut all) = (0f32, 0f32);
        for p in &self.pieces[gr.p0..gr.p1] {
            all += p.dist;
            if f(p) {
                yes += p.dist;
            }
        }
        all > 0.0 && yes * 2.0 >= all
    }

    /// The street / passage name that covers the most distance (0 if none).
    /// Only walked pieces count: a platform's name is the stop's name.
    fn name(&self, gr: &Group) -> u32 {
        let mut best = (0u32, 0f32);
        let ps = &self.pieces[gr.p0..gr.p1];
        for p in ps {
            if p.name == 0 || p.name == best.0 || p.cat != Cat::Walk {
                continue;
            }
            let d: f32 = ps.iter().filter(|q| q.name == p.name && q.cat == Cat::Walk).map(|q| q.dist).sum();
            if d > best.1 {
                best = (p.name, d);
            }
        }
        best.0
    }

    fn walk_compatible(&self, a: &Group, b: &Group) -> bool {
        if self.mostly(a, inside) != self.mostly(b, inside) || self.junction_turn(a.p1 - 1) || self.level_jump(a.p1 - 1) {
            return false;
        }
        let (na, nb) = (self.name(a), self.name(b));
        na == nb || (na == 0 && self.dist(a) < ABSORB_M) || (nb == 0 && self.dist(b) < ABSORB_M)
    }

    /// Name of the street a crossing group crosses, "" if unknown.
    fn crossed_street(&self, gr: &Group) -> &'a str {
        let ps = &self.pieces[gr.p0..gr.p1];
        if let Some(p) = ps.iter().find(|p| p.cat == Cat::Cross && p.name != 0) {
            return &self.g.names[p.name as usize];
        }
        // A road that meets the crossing between its two kerbs; failing that, a
        // road at either end (a crossing drawn from the carriageway).
        let road_at = |node: u32| -> Option<&'a str> {
            if node == NO_NODE {
                return None;
            }
            self.g.incident(node).iter().map(|&e| &self.g.edges[e as usize]).find(|ed| matches!(ed.kind, EdgeKind::Road | EdgeKind::RoadBusy) && ed.name != 0).map(|ed| self.g.names[ed.name as usize].as_str())
        };
        let cross: Vec<usize> = (gr.p0..gr.p1).filter(|&i| self.pieces[i].cat == Cat::Cross).collect();
        let (Some(&first), Some(&last)) = (cross.first(), cross.last()) else { return "" };
        for &i in &cross[..cross.len() - 1] {
            if let Some(n) = road_at(self.pieces[i].end_node) {
                return n;
            }
        }
        let before = if first > 0 { self.pieces[first - 1].end_node } else { NO_NODE };
        if let Some(n) = road_at(before).or_else(|| road_at(self.pieces[last].end_node)) {
            return n;
        }
        ""
    }
}

pub(crate) fn build(g: &WalkGraph, geom: &[LatLon], levels: &[Level2], pieces: &[Piece]) -> Vec<PathStep> {
    let mut cum = Vec::with_capacity(geom.len());
    cum.push(0f32);
    for w in geom.windows(2) {
        let l = cum[cum.len() - 1] + w[0].dist_m(&w[1]);
        cum.push(l);
    }
    let n = pieces.len();
    let mut cx = Ctx { g, geom, pieces, cum, ev: vec![Ev::None; n.max(1)] };
    let zero = WalkCost { var_m: 0.0, fix_s: 0.0 };
    let last_v = geom.len() as u32 - 1;
    let mut out: Vec<PathStep> = Vec::new();

    // ---- Depart
    let total = *cx.cum.last().unwrap();
    let start_level = levels[0];
    let heading = if total >= 2.0 && pieces.first().map(|p| p.cat) != Some(Cat::Lift) { Some(compass_word(geom[0].bearing_deg(&cx.point_at(total.min(15.0))))) } else { None };
    let text = match (start_level != LEVEL_NONE && start_level != 0, heading) {
        (true, Some(h)) => format!("Start on level {}, heading {h}", fmt_level(start_level)),
        (true, None) => format!("Start on level {}", fmt_level(start_level)),
        (false, Some(h)) => format!("Head {h}"),
        (false, None) => "Start".to_string(),
    };
    out.push(PathStep { kind: StepKind::Depart, text, dist_m: 0.0, cost: zero, name: String::new(), level: start_level, to_level: start_level, from: 0, to: 0 });

    // ---- 1. indoor / outdoor events
    for i in 0..n.saturating_sub(1) {
        let (a, b) = (&pieces[i], &pieces[i + 1]);
        if a.edge == NO_EDGE || b.edge == NO_EDGE || a.cat == Cat::Lift || b.cat == Cat::Lift {
            continue;
        }
        let (ia, ib) = (inside(a), inside(b));
        if ia == ib {
            continue;
        }
        let nf = if a.end_node != NO_NODE { g.node_flags.get(a.end_node as usize).copied().unwrap_or(0) } else { 0 };
        let door = nf & (NF_ENTRANCE | NF_DOOR) != 0;
        let walkish = |c: Cat| matches!(c, Cat::Walk | Cat::Platform | Cat::Cross);
        let inner = if ib { b } else { a };
        let tunnel = inner.flags & EF_TUNNEL != 0;
        if door || (walkish(a.cat) && walkish(b.cat) && !tunnel) {
            cx.ev[i] = if ib { Ev::Enter { door, tunnel } } else { Ev::Exit { tunnel } };
        }
    }
    let mut prev: Option<usize> = None;
    for i in 0..n.saturating_sub(1) {
        if cx.ev[i] == Ev::None {
            continue;
        }
        if let Some(j) = prev {
            let opposite = matches!(cx.ev[j], Ev::Enter { .. }) != matches!(cx.ev[i], Ev::Enter { .. });
            if opposite && cx.cum[pieces[i].v1 as usize] - cx.cum[pieces[j].v1 as usize] < FLICKER_M {
                cx.ev[j] = Ev::None;
                cx.ev[i] = Ev::None;
                prev = None;
                continue;
            }
        }
        prev = Some(i);
    }

    // ---- 2. groups
    let mut groups: Vec<Group> = Vec::new();
    for i in 0..n {
        if i > 0 && !cx.split(i - 1) {
            groups.last_mut().unwrap().p1 = i + 1;
        } else {
            groups.push(Group { cat: pieces[i].cat, p0: i, p1: i + 1 });
        }
    }

    // ---- 3. fold short unnamed walks, merge what now fits
    let mut i = 0;
    while i < groups.len() {
        let gr = groups[i];
        // A platform's name is the stop's name, not a street to follow.
        let nm = if gr.cat == Cat::Platform { 0 } else { cx.name(&gr) };
        let same_name = |j: usize| groups[j].cat == Cat::Walk && cx.name(&groups[j]) == nm;
        let tiny = cx.dist(&gr) < FOLD_M && groups.len() > 1;
        let at_end = (i == 0 || i + 1 == groups.len()) && cx.dist(&gr) < END_FOLD_M && groups.len() > 1 && matches!(gr.cat, Cat::Walk | Cat::Platform);
        let short = at_end
            || tiny
                && match gr.cat {
                    // unnamed bits, and named ones next to more of the same street
                    Cat::Walk => nm == 0 || (i > 0 && same_name(i - 1)) || (i + 1 < groups.len() && same_name(i + 1)),
                    // a few metres of platform on the way (not where the walk ends)
                    Cat::Platform => i + 1 < groups.len(),
                    _ => false,
                };
        if !short {
            i += 1;
            continue;
        }
        let can_prev = i > 0 && cx.ev[gr.p0 - 1] == Ev::None;
        let can_next = i + 1 < groups.len() && cx.ev[gr.p1 - 1] == Ev::None;
        let prev_cat = if can_prev { Some(groups[i - 1].cat) } else { None };
        let next_cat = if can_next { Some(groups[i + 1].cat) } else { None };
        // A lift ride or level change has no length to fold a walk into.
        let pointlike = |c: Option<Cat>| matches!(c, Some(Cat::Lift | Cat::Jump));
        // 0 keep, 1 into previous, 2 into next, 3 bridge previous and next
        let how = if prev_cat == Some(Cat::Walk) && (nm == 0 || same_name(i - 1)) {
            1
        } else if next_cat == Some(Cat::Walk) && (nm == 0 || same_name(i + 1)) {
            2
        } else if nm != 0 && !at_end {
            0
        } else if prev_cat.is_some() && prev_cat == next_cat && !pointlike(prev_cat) {
            3
        } else if prev_cat.is_some() && !pointlike(prev_cat) {
            1
        } else if next_cat.is_some() && !pointlike(next_cat) {
            2
        } else if prev_cat.is_some() {
            1
        } else if next_cat.is_some() {
            2
        } else {
            0
        };
        match how {
            1 => {
                groups[i - 1].p1 = gr.p1;
                groups.remove(i);
            }
            2 => {
                groups[i + 1].p0 = gr.p0;
                groups.remove(i);
            }
            3 => {
                groups[i - 1].p1 = groups[i + 1].p1;
                groups.drain(i..=i + 1);
            }
            _ => i += 1,
        }
    }
    let mut i = 0;
    while i + 1 < groups.len() {
        let (a, b) = (groups[i], groups[i + 1]);
        if cx.ev[a.p1 - 1] == Ev::None && a.cat == b.cat && (a.cat != Cat::Walk || cx.walk_compatible(&a, &b)) {
            groups[i].p1 = b.p1;
            groups.remove(i + 1);
        } else {
            i += 1;
        }
    }

    // ---- 4. wording
    // (index in `out`, wording after the distance) of the latest walk step
    let mut last_walk: Option<(usize, String)> = None;
    // (first vertex, metres, cost) of a last stretch too short to mention
    let mut arrive_from: Option<(u32, f32, WalkCost)> = None;
    // Door or building edge right after a group.
    let push_event = |cx: &Ctx, gr: &Group, v1: u32, out: &mut Vec<PathStep>| {
        let ev = if gr.p1 < n { cx.ev[gr.p1 - 1] } else { Ev::None };
        if ev == Ev::None {
            return;
        }
        let turn = cx.turn_at(v1 as usize).and_then(turn_phrase);
        let (kind, base) = match ev {
            Ev::Enter { door, tunnel } => {
                let place = if tunnel { "underpass" } else { "building" };
                (StepKind::Enter, if door { format!("Go through the entrance into the {place}") } else { format!("Enter the {place}") })
            }
            Ev::Exit { tunnel } => (StepKind::Exit, if tunnel { "Leave the underpass".to_string() } else { "Exit the building".to_string() }),
            Ev::None => unreachable!(),
        };
        let l = levels[v1 as usize];
        out.push(PathStep { kind, text: with_turn(turn, base), dist_m: 0.0, cost: zero, name: String::new(), level: l, to_level: l, from: v1, to: v1 });
    };
    for (gi, gr) in groups.iter().enumerate() {
        let ps = &pieces[gr.p0..gr.p1];
        let (v0, v1) = (ps[0].v0, ps[ps.len() - 1].v1);
        let dist: f32 = ps.iter().map(|p| p.dist).sum();
        if dist < 0.01 && groups.len() == 1 && matches!(gr.cat, Cat::Walk | Cat::Platform) {
            break; // start and destination are the same spot
        }
        let cost = ps.iter().fold(zero, |c, p| WalkCost { var_m: c.var_m + p.cost.var_m, fix_s: c.fix_s + p.cost.fix_s });
        // A couple of metres at the very start or end that could not be
        // folded into a neighbour (a door in between): part of setting off /
        // arriving, not a step of its own.
        if groups.len() > 1 && dist < END_FOLD_M && matches!(gr.cat, Cat::Walk | Cat::Platform) && (gi == 0 || gi + 1 == groups.len()) {
            if gi == 0 {
                out[0].dist_m = dist;
                out[0].cost = cost;
                out[0].to = v1;
            } else {
                arrive_from = Some((v0, dist, cost));
            }
            if gi == 0 {
                push_event(&cx, gr, v1, &mut out);
            }
            continue;
        }
        let known = |l: Level2| l != LEVEL_NONE;
        let level = if known(ps[0].l0) { ps[0].l0 } else { levels[v0 as usize] };
        // Where a vertical move ends: the last piece of that kind, else what follows.
        let mut to_level = ps.iter().rev().find(|p| p.cat == gr.cat).map(|p| p.l1).unwrap_or(LEVEL_NONE);
        if !known(to_level) {
            to_level = if known(ps[ps.len() - 1].l1) { ps[ps.len() - 1].l1 } else { levels[v1 as usize] };
        }
        let vertical = matches!(gr.cat, Cat::Stairs(_) | Cat::Ramp(_) | Cat::Escalator(_));
        // Stairs tagged with a single level do not say where they lead.
        let mut say_level = if vertical && to_level == level { LEVEL_NONE } else { to_level };
        if !known(say_level) && gr.cat != Cat::Walk && gr.p1 < n && known(pieces[gr.p1].l0) && pieces[gr.p1].l0 != level {
            say_level = pieces[gr.p1].l0;
        }
        if !known(to_level) {
            to_level = say_level;
        }
        // Arrived on another floor without stairs, ramp or lift in the data
        // (an untagged slope): at least say which floor this is.
        let jumped = gr.cat == Cat::Walk && gr.p0 > 0 && cx.level_jump(gr.p0 - 1) && !matches!(groups[gi - 1].cat, Cat::Stairs(_) | Cat::Ramp(_) | Cat::Escalator(_) | Cat::Lift | Cat::Jump);
        // A turn word, unless a lift is involved (no telling which way one faces).
        let after_event = gr.p0 > 0 && cx.ev[gr.p0 - 1] != Ev::None;
        let turn = if gi == 0 || after_event || matches!(gr.cat, Cat::Lift | Cat::Jump) || matches!(groups[gi - 1].cat, Cat::Lift | Cat::Jump) { None } else { cx.turn_at(v0 as usize).and_then(turn_phrase) };
        let to_txt = |l: Level2| if known(l) { format!(" to {}", level_name(l)) } else { String::new() };
        let dir_txt = |d: Dir| match d {
            Dir::Up => " up",
            Dir::Down => " down",
            Dir::Unknown => "",
        };
        let mut name = String::new();
        let (kind, base) = match gr.cat {
            Cat::Walk => {
                let ni = cx.name(gr);
                let named = ni != 0;
                if named {
                    name = g.names[ni as usize].clone();
                }
                let tunnel = cx.mostly(gr, |p| p.flags & EF_TUNNEL != 0);
                // under the arcades along a street (covered, not through a building)
                let arcade = !tunnel && cx.mostly(gr, |p| p.flags & EF_COVERED != 0 && p.flags & (EF_TUNNEL | EF_INDOOR) == 0 && p.kind != EdgeKind::Corridor);
                let passage = tunnel && cx.mostly(gr, |p| p.flags & EF_COVERED != 0);
                let bridge = cx.mostly(gr, |p| p.flags & EF_BRIDGE != 0);
                // Any stretch over open ground makes it a square to cross, not a street to follow.
                let area = ps.iter().any(|p| p.flags & EF_AREA != 0 && p.dist >= FOLD_M);
                let road = cx.mostly(gr, |p| matches!(p.kind, EdgeKind::Road | EdgeKind::RoadBusy));
                let indoor = cx.mostly(gr, inside);
                let mut tail = if named {
                    let prep = if tunnel || indoor {
                        "through"
                    } else if area {
                        "across"
                    } else if arcade {
                        "under the arcades along"
                    } else {
                        "along"
                    };
                    format!(" {prep} {name}")
                } else if indoor && !tunnel {
                    String::new()
                } else if passage {
                    " through the passage".to_string()
                } else if tunnel {
                    if road { " through the tunnel" } else { " through the underpass" }.to_string()
                } else if arcade && !area {
                    " under the arcades".to_string()
                } else if bridge {
                    if road { " across the bridge" } else { " across the footbridge" }.to_string()
                } else if area {
                    // an open area under a roof is a station hall, not a square
                    if cx.mostly(gr, |p| p.flags & (EF_COVERED | EF_INDOOR) != 0) { " across the hall" } else { " across the square" }.to_string()
                } else if road {
                    " along the road".to_string()
                } else {
                    String::new()
                };
                if jumped && known(level) {
                    tail.push_str(&format!(" on level {}", fmt_level(level)));
                }
                // More of the same street or passage after a turn: say so
                // instead of repeating its name.
                let same_as_before = turn.is_some() && !tail.is_empty() && last_walk.as_ref().map_or(false, |(at, t)| *at + 1 == out.len() && *t == tail);
                last_walk = Some((out.len(), tail.clone()));
                if same_as_before {
                    (StepKind::Walk, format!("Continue for {}", fmt_dist(dist)))
                } else {
                    (StepKind::Walk, format!("Walk {}{tail}", fmt_dist(dist)))
                }
            }
            Cat::Platform => (StepKind::Platform, format!("Walk {} along the platform", fmt_dist(dist))),
            Cat::Cross => {
                let street = cx.crossed_street(gr);
                name = street.to_string();
                let what = if street.is_empty() { "the street" } else { street };
                let how = if ps.iter().any(|p| p.cat == Cat::Cross && p.cls & C_X != 0) {
                    " at the traffic lights"
                } else if ps.iter().any(|p| p.cat == Cat::Cross && p.cls & C_Y != 0) {
                    " at the zebra crossing"
                } else {
                    ""
                };
                (StepKind::Cross, format!("Cross {what}{how}"))
            }
            Cat::Stairs(d) => {
                let count: f32 = ps.iter().map(|p| p.steps).sum();
                let count = count.round() as i32;
                let c = if count == 1 {
                    " (1 step)".to_string()
                } else if count > 1 {
                    format!(" ({count} steps)")
                } else {
                    String::new()
                };
                let kind = if d == Dir::Down { StepKind::StairsDown } else { StepKind::StairsUp };
                (kind, format!("Take the stairs{}{}{c}", dir_txt(d), to_txt(say_level)))
            }
            Cat::Ramp(d) => {
                let kind = if d == Dir::Down { StepKind::RampDown } else { StepKind::RampUp };
                let beside = if ps.iter().any(|p| p.kind == EdgeKind::Steps) { " beside the stairs" } else { "" };
                let len = if dist >= 10.0 { format!(" ({})", fmt_dist(dist)) } else { String::new() };
                (kind, format!("Take the ramp{beside}{}{}{len}", dir_txt(d), to_txt(say_level)))
            }
            Cat::Escalator(d) => {
                let kind = if d == Dir::Down { StepKind::EscalatorDown } else { StepKind::EscalatorUp };
                (kind, format!("Take the escalator{}{}", dir_txt(d), to_txt(say_level)))
            }
            Cat::Walkway => (StepKind::Walk, format!("Take the moving walkway ({})", fmt_dist(dist))),
            Cat::Lift => {
                // An untagged way beside the lift is at street level; with no
                // level on either side, name the place the lift leads to.
                let (a, b) = (crate::net::lvl0(level), crate::net::lvl0(to_level));
                let d = if b > a {
                    " up"
                } else if b < a {
                    " down"
                } else {
                    ""
                };
                let target = if known(to_level) {
                    to_txt(to_level)
                } else if known(level) {
                    " to ground level".to_string()
                } else {
                    let next = groups.get(gi + 1).filter(|g| g.cat == Cat::Walk).map(|g| cx.name(g)).unwrap_or(0);
                    if next != 0 { format!(" to {}", g.names[next as usize]) } else { String::new() }
                };
                (StepKind::Lift, format!("Take the lift{d}{target}"))
            }
            Cat::Jump => {
                // Untagged ways are at street level.
                let (a, b) = (crate::net::lvl0(level), crate::net::lvl0(to_level));
                let target = if known(to_level) { level_name(to_level) } else { "ground level".to_string() };
                let text = if b > a {
                    format!("Go up to {target} (stairs or lift not mapped)")
                } else if b < a {
                    format!("Go down to {target} (stairs or lift not mapped)")
                } else {
                    "Change floor here (stairs or lift not mapped)".to_string()
                };
                (StepKind::Walk, text)
            }
        };
        out.push(PathStep { kind, text: with_turn(turn, base), dist_m: dist, cost, name, level, to_level, from: v0, to: v1 });

        push_event(&cx, gr, v1, &mut out);
    }

    // ---- Arrive
    let end_level = levels[last_v as usize];
    let text = if end_level != LEVEL_NONE && end_level != 0 { format!("Arrive at your destination on level {}", fmt_level(end_level)) } else { "Arrive at your destination".to_string() };
    let (from, dist_m, cost) = arrive_from.unwrap_or((last_v, 0.0, zero));
    out.push(PathStep { kind: StepKind::Arrive, text, dist_m, cost, name: String::new(), level: end_level, to_level: end_level, from, to: last_v });
    out
}
