//! The ends of a walk: where a walk leaves a point and joins the walking network, for the stop search
//! ([`reach_costs`]) and for the walk drawn ([`walk`], [`draw`]) alike. Both take their starting points from
//! [`End::sources`], so the stop search and the drawn walk cannot choose differently.
//!
//! - **The point itself is always a candidate**: the straight line from the point to the nearest way
//!   ([`snap_point`]), as the engine has always walked it.
//! - **A building's doors** are candidates next to it when the point is in a building: inside to the door, then
//!   out of it along one of its ways out ([`crate::doors`]). Every door is tried; a step-free walker may not use
//!   a `wheelchair=no` one and prefers one known to be step-free. Back doors, garages and register points carry
//!   the penalties of [`DoorKind::penalty_m`].
//! - **Through a building**: a straight line from the point (or from a door) that runs through a building
//!   ([`crate::doors::through_building`]) counts four times its length plus 200 m in route choice (as an emergency
//!   exit: only when no door has a real way out), and a walk that takes it is drawn as a guess and is not
//!   step-free. A line onto a main road walked on the carriageway counts four times
//!   ([`crate::doors::line_weight_m`]). Penalties are for route choice only: the time of a walk is the time walked.

use crate::doors::{line_weight_m, DoorIndex, NO_STEP};
use kante_core::geo::LatLon;
use kante_core::walk::*;
use kante_walk::{SnapOptions, WalkCost, WalkPath, WalkRouter};

/// A straight line onto the network longer than this is a guess across open ground.
pub const GUESS_M: f32 = 20.0;
/// At most this many ways onto the network at one end (the cheapest).
const MAX_JOINS: usize = 256;

/// One way from an end of a walk onto the network.
#[derive(Clone, Copy, Debug)]
pub struct Join {
    pub snap: Snap,
    /// Metres walked from the point to `snap`: to the door and out of it, or the straight line.
    pub extra_m: f32,
    /// Route choice only, in seconds.
    pub pen_s: f32,
    /// Through this door ([`Doors::doors`]).
    pub door: Option<u32>,
    /// From the point to the door (0 without one).
    pub inside_m: f32,
    /// The straight bit runs through a building: a guess, not step-free.
    pub wall: bool,
}

impl Join {
    /// The straight line onto the network: from the door, or from the point.
    pub fn line_m(&self) -> f32 {
        self.snap.dist_m
    }
}

/// One end of a walk.
#[derive(Clone, Debug, Default)]
pub struct End {
    pub pos: LatLon,
    pub joins: Vec<Join>,
    /// The point is inside a building.
    pub in_building: bool,
    /// ... which has doors, but none open to this (step-free) walker.
    pub no_step_free_door: bool,
    /// A railway platform's registry point, often on the track itself: the walk ends on the platform, not there.
    pub on_track: bool,
}

/// The extra route-choice seconds of a straight line `dist_m` long onto `edge` ([`line_weight_m`]).
fn line_pen(g: &WalkGraph, edge: u32, dist_m: f32, wall: bool, speed: f32) -> f32 {
    let busy = g.edges[edge as usize].kind == EdgeKind::RoadBusy;
    (line_weight_m(dist_m, busy, wall) - dist_m) / speed
}

/// Snap a free position (an address, a pin, the user) onto the walking network, on the ground: not in an
/// underpass or the corridor below it, nor on a bridge above, unless the point is right on such a way (3 m) and
/// no way on the ground is within 10 m. Main roads only when nothing else is within 60 m.
pub fn snap_point(router: &WalkRouter, pos: LatLon, profile: &WalkProfile) -> Option<Snap> {
    let base = SnapOptions { max_dist_m: 60.0, level: Some(0), profile: Some(*profile), exclude_kinds: NO_STEP | (1 << EdgeKind::RoadBusy as u8) };
    let g = router.graph();
    let ground = |s: &Snap| {
        let e = &g.edges[s.edge as usize];
        e.flags & (EF_TUNNEL | EF_BRIDGE) == 0 || e.flags & EF_COVERED != 0
    };
    let street = |o: &SnapOptions| router.snap_candidates(pos, o, 6).into_iter().find(ground);
    street(&SnapOptions { max_dist_m: 10.0, ..base })
        .or_else(|| router.snap(pos, &SnapOptions { max_dist_m: 3.0, level: None, ..base }))
        .or_else(|| street(&base))
        .or_else(|| street(&SnapOptions { max_dist_m: 250.0, exclude_kinds: NO_STEP, ..base }))
        .or_else(|| router.snap(pos, &SnapOptions { level: None, ..base }))
        .or_else(|| router.snap(pos, &SnapOptions { max_dist_m: 250.0, level: None, exclude_kinds: NO_STEP, ..base }))
}

impl End {
    /// A point taken as it is (a station's centre, where a station model's own paths begin): straight onto `snap`.
    pub fn exact(pos: LatLon, snap: Option<Snap>) -> End {
        End { pos, joins: snap.map(|s| Join { snap: s, extra_m: s.dist_m, pen_s: 0.0, door: None, inside_m: 0.0, wall: false }).into_iter().collect(), ..Default::default() }
    }

    /// A boarding point, joined to the network at its link.
    pub fn stop(pos: LatLon, snap: Option<Snap>, on_track: bool) -> End {
        End { on_track, ..End::exact(pos, snap) }
    }

    /// A place (an address, a pin, the user): the point itself, joined at `snap` (see [`snap_point`]), and the
    /// doors of the building it is in.
    pub fn place(router: &WalkRouter, doors: Option<&DoorIndex>, pos: LatLon, snap: Option<Snap>, profile: &WalkProfile) -> End {
        let g = router.graph();
        let speed = profile.speed_mps.max(0.05);
        let mut end = End { pos, ..Default::default() };
        if let Some(s) = snap {
            let covered = g.edges[s.edge as usize].flags & EF_COVERED != 0;
            let wall = doors.is_some_and(|ix| ix.through(pos, s.pos, if covered { 5.0 } else { 0.0 }));
            end.joins.push(Join { snap: s, extra_m: s.dist_m, pen_s: line_pen(g, s.edge, s.dist_m, wall, speed), door: None, inside_m: 0.0, wall });
        }
        let Some(ix) = doors else { return end };
        let d = &ix.doors;
        let strict = profile.wheelchair || profile.is_step_free();
        let (mut barred, mut open) = (0, 0);
        for b in ix.buildings_at(pos) {
            end.in_building = true;
            for di in d.doors_of(b) {
                let door = &d.doors[di as usize];
                if strict && door.wheelchair == DOOR_WC_NO {
                    barred += 1;
                    continue;
                }
                open += 1;
                // a step-free walker prefers a door known to be step-free
                let kind_m = door.kind.penalty_m() + if strict && door.wheelchair != DOOR_WC_YES { 5.0 } else { 0.0 };
                let inside_m = pos.dist_m(&door.pos);
                for a in d.attach_of(di).iter().filter(|a| router.usable(a.edge, profile)) {
                    let snap = Snap { dist_m: a.dist_m(), ..router.snap_at(a.edge, a.frac()) };
                    let pen_s = kind_m / speed + line_pen(g, a.edge, a.dist_m(), a.through(), speed);
                    end.joins.push(Join { snap, extra_m: inside_m + a.dist_m(), pen_s, door: Some(di), inside_m, wall: a.through() });
                }
            }
        }
        end.no_step_free_door = barred > 0 && open == 0;
        if end.joins.len() > MAX_JOINS {
            let cost = |j: &Join| j.extra_m / speed + j.pen_s;
            end.joins.sort_by(|x, y| cost(x).total_cmp(&cost(y)));
            end.joins.truncate(MAX_JOINS);
        }
        end
    }

    /// The starting (or end) points of a search from this end: (where on the network, metres walked to it,
    /// route-choice seconds). The one function both the stop search and the drawn walk take them from.
    pub fn sources(&self) -> Vec<(Snap, f32, f32)> {
        self.joins.iter().map(|j| (j.snap, j.extra_m, j.pen_s)).collect()
    }
}

/// Walking costs from one end of a walk to many boarding points (joined to the network at `targets`), the metres
/// from the point to the network and from the network to each boarding point (`dist_m` of its snap) included;
/// `None` beyond `max_s` of walking on the network: from the best of its ways onto the network for each target, as
/// [`walk`] to [`End::stop`] takes it.
pub fn reach_costs(router: &WalkRouter, end: &End, targets: &[Snap], profile: &WalkProfile, max_s: f32) -> Vec<Option<WalkCost>> {
    let mut out = router.many_to_many(&end.sources(), targets, profile, max_s);
    for (c, t) in out.iter_mut().zip(targets) {
        if let Some(c) = c {
            c.var_m += t.dist_m;
        }
    }
    out
}

/// A walk between two ends: through which way onto the network at each, and the path between.
#[derive(Clone, Debug)]
pub struct Walk {
    pub from: Join,
    pub to: Join,
    pub path: WalkPath,
    /// Seconds walked, the metres to and from the network included.
    pub secs: f32,
    pub dist_m: f32,
}

/// The best walk between two ends, from the best of the ways onto the network at one to the best at the other.
pub fn walk(router: &WalkRouter, a: &End, b: &End, profile: &WalkProfile) -> Option<Walk> {
    let (i, j, path, _) = router.route_between(&a.sources(), &b.sources(), profile)?;
    let (from, to) = (a.joins[i], b.joins[j]);
    let speed = profile.speed_mps.max(0.05);
    let extra = from.extra_m + to.extra_m;
    let secs = walk_secs(path.cost.var_m + extra, path.cost.fix_s, speed);
    let dist_m = path.dist_m + extra;
    Some(Walk { from, to, path, secs, dist_m })
}

/// A walk as drawn: from the point (into the building to its door and out, or straight onto the network), the
/// path, and on to the door or the point at the other end.
#[derive(Clone, Debug)]
pub struct Drawn {
    pub geometry: Vec<LatLon>,
    pub levels: Vec<Level2>,
    /// Vertices before the path.
    pub head: u32,
    /// The path's last vertex.
    pub path_end: u32,
    /// Vertices `0 ..= approx_start` are a guess (a straight line over 20 m, or through a building); likewise
    /// `approx_end ..`.
    pub approx_start: Option<u32>,
    pub approx_end: Option<u32>,
    /// A straight bit runs through a building.
    pub wall: bool,
    /// No stairs, escalators or unmapped floor changes on the path, not through a building, not into a building
    /// whose doors are all closed to a step-free walker.
    pub step_free: bool,
}

pub fn draw(doors: Option<&DoorIndex>, a: &End, b: &End, w: &Walk) -> Drawn {
    let p = &w.path;
    let lv0 = p.levels.first().copied().unwrap_or(LEVEL_NONE);
    let lv1 = p.levels.last().copied().unwrap_or(LEVEL_NONE);
    let door_pos = |d: u32| doors.map(|ix| ix.doors.doors[d as usize].pos);
    // (straight points before the path, straight points after it)
    let mut head: Vec<LatLon> = Vec::new();
    match w.from.door.and_then(|d| door_pos(d)) {
        Some(dp) => {
            if w.from.inside_m > 1.5 {
                head.push(a.pos);
            }
            if w.from.snap.dist_m > 0.5 {
                head.push(dp);
            }
        }
        None if w.from.snap.dist_m > 1.5 && !a.on_track => head.push(a.pos),
        None => {}
    }
    let mut tail: Vec<LatLon> = Vec::new();
    match w.to.door.and_then(|d| door_pos(d)) {
        // the walk ends at the door
        Some(dp) => {
            if w.to.snap.dist_m > 0.5 {
                tail.push(dp);
            }
        }
        None if w.to.snap.dist_m > 1.5 && !b.on_track => tail.push(b.pos),
        None => {}
    }
    let n_head = head.len() as u32;
    let mut geometry = head;
    let mut levels = vec![lv0; geometry.len()];
    geometry.extend_from_slice(&p.geometry);
    levels.extend_from_slice(&p.levels);
    let path_end = geometry.len() as u32 - 1;
    let n_tail = tail.len();
    geometry.extend(tail);
    levels.extend(std::iter::repeat_n(lv1, n_tail));
    let guess = |j: &Join, e: &End| j.wall || (j.snap.dist_m > GUESS_M && !e.on_track);
    let approx_start = (n_head > 0 && guess(&w.from, a)).then_some(n_head);
    let approx_end = (n_tail > 0 && guess(&w.to, b)).then_some(path_end);
    let wall = w.from.wall || w.to.wall;
    let step_free = p.stairs_up == 0 && p.stairs_down == 0 && p.escalators == 0 && p.unmapped_level_changes == 0 && !wall && !a.no_step_free_door && !b.no_step_free_door;
    Drawn { geometry, levels, head: n_head, path_end, approx_start, approx_end, wall, step_free }
}

#[cfg(test)]
mod tests;
