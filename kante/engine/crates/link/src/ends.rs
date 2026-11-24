//! The ends of a walk: where a walk leaves a point and joins the walking network, for the stop search
//! ([`reach_costs`]) and for the walk drawn ([`walk`], [`walk_within`], [`draw`]) alike. Both take their starting
//! points from [`End::sources`]. Rules: `kante/docs/WALK-ENDS.md`.
//!
//! - **The point itself is always a candidate**, by several straight lines onto the network
//!   ([`point_candidates`]): onto the way `main`'s engine snapped it to ([`snap_main`]), onto the nearest way on the
//!   ground ([`snap_point`]), and onto the nearest few other ways; a line onto a way in a tunnel or on a bridge
//!   that the point is not right on counts 40 m more.
//! - **A building's doors** are candidates next to them when the point is in a building.
//! - **Whether a stop is reached, and in what time, is decided on walked time over all candidates**: route-choice
//!   penalties (back doors, lines through buildings, main roads, off-ground ways) only choose among the candidates
//!   that are within the limit. So the doors and the other lines can only add stops to what the point's own line
//!   reaches.
//! - **Through a building** ([`crate::doors::through_building`]): such a line counts four times its length plus
//!   200 m in route choice, and a walk that takes it is drawn as a guess and is not step-free.

use crate::doors::{line_weight_m, DoorIndex, NO_STEP};
use kante_core::geo::LatLon;
use kante_core::walk::*;
use kante_walk::{SnapOptions, WalkCost, WalkPath, WalkRouter};

/// A line onto a way in a tunnel or on a bridge that the point is not right on (3 m) counts this much more (metres).
pub const OFF_GROUND_M: f32 = 40.0;

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
    /// Through a building, onto a way in a tunnel or on a bridge the point is not right on (a change of floor
    /// nobody mapped), or longer than [`GUESS_M`] (across ground with no mapped way): used only where no other way
    /// onto the network will do ([`reach_costs`], [`walk_within`]), drawn as a guess and never step-free.
    pub unsure: bool,
    /// How much of a guess the line is, for the order lines are tried in: 0 a short line onto a way at hand, 1 a
    /// line across ground with no mapped way (longer than [`GUESS_M`]), 2 through a building or onto another floor.
    pub doubt: u8,
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

fn on_ground(g: &WalkGraph, s: &Snap) -> bool {
    let e = &g.edges[s.edge as usize];
    e.flags & EF_BRIDGE == 0 && (e.flags & EF_TUNNEL == 0 || e.flags & EF_COVERED != 0)
}

/// A straight line onto a way in a tunnel or on a bridge that the point is not right on (3 m): it changes floor
/// where nobody mapped how.
/// [`Join::doubt`] of a line: through a building or onto another floor, else as long as it is.
fn doubt_of(wall_or_floor: bool, dist_m: f32) -> u8 {
    if wall_or_floor {
        2
    } else if dist_m > GUESS_M {
        1
    } else {
        0
    }
}

fn off_floor(g: &WalkGraph, s: &Snap) -> bool {
    !on_ground(g, s) && s.dist_m > 3.0
}

/// The same for a point on a floor of its own: one right on a bridge or in a tunnel with no way on the ground near
/// it ([`snap_point`] puts it there) is on that way, and any line from it longer than 3 m leaves it sideways.
fn off_floor_from(g: &WalkGraph, s: &Snap, up: bool) -> bool {
    if up { s.dist_m > 3.0 } else { off_floor(g, s) }
}

/// Snap a free position (an address, a pin, the user) onto the walking network, on the ground: not in an
/// underpass or the corridor below it, nor on a bridge (covered or not) above, unless the point is right on such a
/// way (3 m) and no way on the ground is within 10 m. Main roads only when nothing else is within 60 m.
pub fn snap_point(router: &WalkRouter, pos: LatLon, profile: &WalkProfile) -> Option<Snap> {
    let base = SnapOptions { max_dist_m: 60.0, level: Some(0), profile: Some(*profile), exclude_kinds: NO_STEP | (1 << EdgeKind::RoadBusy as u8) };
    let g = router.graph();
    let street = |o: &SnapOptions| router.snap_candidates(pos, o, 8).into_iter().find(|s| on_ground(g, s));
    street(&SnapOptions { max_dist_m: 10.0, ..base })
        .or_else(|| router.snap(pos, &SnapOptions { max_dist_m: 3.0, level: None, ..base }))
        .or_else(|| street(&base))
        .or_else(|| street(&SnapOptions { max_dist_m: 250.0, exclude_kinds: NO_STEP, ..base }))
        .or_else(|| router.snap(pos, &SnapOptions { level: None, ..base }))
        .or_else(|| router.snap(pos, &SnapOptions { max_dist_m: 250.0, level: None, exclude_kinds: NO_STEP, ..base }))
}

/// Where `main`'s engine snaps a free position: the nearest way within 60 m that is not a main road, stairs,
/// escalator or lift, on any floor; else the nearest within 250 m, main roads included.
pub fn snap_main(router: &WalkRouter, pos: LatLon, profile: &WalkProfile) -> Option<Snap> {
    let base = SnapOptions { max_dist_m: 60.0, level: None, profile: Some(*profile), exclude_kinds: NO_STEP | (1 << EdgeKind::RoadBusy as u8) };
    router.snap(pos, &base).or_else(|| router.snap(pos, &SnapOptions { max_dist_m: 250.0, exclude_kinds: NO_STEP, ..base }))
}

/// The straight lines from a point onto the network, each a candidate: onto the way `main` snaps it to, onto the
/// nearest way on the ground, and onto the nearest other ways (up to six more, each another way, within 40 m or
/// 20 m beyond the nearest). A snap from which the other end cannot be reached is then simply not taken.
pub fn point_candidates(router: &WalkRouter, pos: LatLon, profile: &WalkProfile) -> Vec<Snap> {
    let g = router.graph();
    let mut out: Vec<Snap> = Vec::new();
    let add = |s: Snap, out: &mut Vec<Snap>| {
        let way = g.edge_way.get(s.edge as usize).copied();
        if !out.iter().any(|o| o.edge == s.edge || (o.pos.dist_m(&s.pos) < 1.0 && g.edge_way.get(o.edge as usize).copied() == way)) {
            out.push(s);
        }
    };
    for s in [snap_main(router, pos, profile), snap_point(router, pos, profile)].into_iter().flatten() {
        add(s, &mut out);
    }
    let near = out.iter().map(|s| s.dist_m).fold(f32::INFINITY, f32::min);
    let reach = if near.is_finite() { (near + 20.0).max(40.0) } else { 40.0 };
    let opts = SnapOptions { max_dist_m: reach, level: None, profile: Some(*profile), exclude_kinds: NO_STEP };
    let mut ways: Vec<i64> = out.iter().filter_map(|s| g.edge_way.get(s.edge as usize).copied()).collect();
    let mut more = 0;
    for s in router.snap_candidates(pos, &opts, 32) {
        if more == 6 {
            break;
        }
        let way = g.edge_way.get(s.edge as usize).copied().unwrap_or(0);
        if way != 0 && ways.contains(&way) {
            continue;
        }
        ways.push(way);
        let before = out.len();
        add(s, &mut out);
        more += (out.len() > before) as usize;
    }
    out
}

/// A station entered at street level, as candidates: the nearest ways on the ground floor within 120 m that are not
/// platforms, stairs, escalators or lifts (up to five, each another way, the first the one `main` takes), else where
/// `main` puts a free point ([`snap_main`]).
pub fn station_candidates(router: &WalkRouter, pos: LatLon, profile: &WalkProfile) -> Vec<Snap> {
    let g = router.graph();
    let opts = SnapOptions { max_dist_m: 120.0, level: Some(0), profile: Some(*profile), exclude_kinds: NO_STEP | (1 << EdgeKind::Platform as u8) };
    let mut out: Vec<Snap> = Vec::new();
    let mut ways: Vec<i64> = Vec::new();
    for s in router.snap_candidates(pos, &opts, 32) {
        let way = g.edge_way.get(s.edge as usize).copied().unwrap_or(0);
        if way != 0 && ways.contains(&way) {
            continue;
        }
        ways.push(way);
        out.push(s);
        if out.len() == 5 {
            break;
        }
    }
    if out.is_empty() {
        out.extend(snap_main(router, pos, profile));
    }
    out
}

impl End {
    /// A station entered at street level ([`station_candidates`]): each line tested and weighed like a place's
    /// (through a building: a guess, four times its length plus 200 m; onto a main road: four times).
    pub fn station(router: &WalkRouter, doors: Option<&DoorIndex>, pos: LatLon, profile: &WalkProfile) -> End {
        let g = router.graph();
        let speed = profile.speed_mps.max(0.05);
        let joins = station_candidates(router, pos, profile)
            .into_iter()
            .map(|s| {
                let covered = g.edges[s.edge as usize].flags & EF_COVERED != 0;
                let wall = doors.is_some_and(|ix| ix.through(pos, s.pos, if covered { 5.0 } else { 0.0 }));
                let track = doors.is_some_and(|ix| ix.crosses_track(pos, s.pos));
                let doubt = doubt_of(wall || track || off_floor(g, &s), s.dist_m);
                Join { snap: s, extra_m: s.dist_m, pen_s: line_pen(g, s.edge, s.dist_m, wall || track, speed), door: None, inside_m: 0.0, wall, unsure: doubt > 0, doubt }
            })
            .collect();
        End { pos, joins, ..Default::default() }
    }

    /// A point taken as it is (a station's centre, where a station model's own paths begin): straight onto `snap`.
    pub fn exact(pos: LatLon, snap: Option<Snap>) -> End {
        End { pos, joins: snap.map(|s| Join { snap: s, extra_m: s.dist_m, pen_s: 0.0, door: None, inside_m: 0.0, wall: false, unsure: false, doubt: 0 }).into_iter().collect(), ..Default::default() }
    }

    /// A boarding point, joined to the network at its link (`main`'s linker's). The straight line from the point to
    /// the link is a guess, never step-free, when it runs through a building or across a railway track on the
    /// ground, or is longer than [`GUESS_M`] (not for a railway platform's point, which often lies on the track
    /// itself: the walk ends on the platform).
    pub fn stop(router: &WalkRouter, doors: Option<&DoorIndex>, pos: LatLon, snap: Option<Snap>, on_track: bool) -> End {
        let mut end = End { on_track, ..End::exact(pos, snap) };
        if let (Some(j), false) = (end.joins.first_mut(), on_track) {
            let covered = router.graph().edges[j.snap.edge as usize].flags & EF_COVERED != 0;
            let wall = doors.is_some_and(|ix| ix.through(pos, j.snap.pos, if covered { 5.0 } else { 0.0 }));
            let track = doors.is_some_and(|ix| ix.crosses_track(pos, j.snap.pos));
            j.wall = wall;
            j.doubt = doubt_of(wall || track, j.snap.dist_m);
            j.unsure = j.doubt > 0;
        }
        end
    }

    /// A place (an address, a pin, the user): the point itself, by each of its straight lines onto the network
    /// ([`point_candidates`]), and the doors of the building it is in.
    pub fn place(router: &WalkRouter, doors: Option<&DoorIndex>, pos: LatLon, profile: &WalkProfile) -> End {
        let g = router.graph();
        let speed = profile.speed_mps.max(0.05);
        let mut end = End { pos, ..Default::default() };
        // on a bridge or in a tunnel, with nothing on the ground near (snap_point's rule): on that floor
        let up = snap_point(router, pos, profile).is_some_and(|f| !on_ground(g, &f) && f.dist_m <= 3.0);
        for s in point_candidates(router, pos, profile) {
            let covered = g.edges[s.edge as usize].flags & EF_COVERED != 0;
            let wall = doors.is_some_and(|ix| ix.through(pos, s.pos, if covered { 5.0 } else { 0.0 }));
            // across a railway track on the ground: a guess like one through a building (a door's ways out never do)
            let track = doors.is_some_and(|ix| ix.crosses_track(pos, s.pos));
            let floor = off_floor_from(g, &s, up);
            let off = if floor { OFF_GROUND_M / speed } else { 0.0 };
            let doubt = doubt_of(wall || track || floor, s.dist_m);
            end.joins.push(Join { snap: s, extra_m: s.dist_m, pen_s: line_pen(g, s.edge, s.dist_m, wall || track, speed) + off, door: None, inside_m: 0.0, wall, unsure: doubt > 0, doubt });
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
                // inside to the door: through another building that overlaps this one, a wall too
                let inside_wall = inside_m > 0.4 && ix.through(pos, door.pos, 0.0);
                for a in d.attach_of(di).iter().filter(|a| router.usable(a.edge, profile)) {
                    let snap = Snap { dist_m: a.dist_m(), ..router.snap_at(a.edge, a.frac()) };
                    let wall = a.through() || inside_wall;
                    let inside_pen = if inside_wall { (line_weight_m(inside_m, false, true) - inside_m) / speed } else { 0.0 };
                    let pen_s = kind_m / speed + line_pen(g, a.edge, a.dist_m(), a.through(), speed) + inside_pen;
                    end.joins.push(Join { snap, extra_m: inside_m + a.dist_m(), pen_s, door: Some(di), inside_m, wall, unsure: doubt_of(wall || off_floor(g, &snap), a.dist_m()) > 0, doubt: doubt_of(wall || off_floor(g, &snap), a.dist_m()) });
                }
            }
        }
        end.no_step_free_door = barred > 0 && open == 0;
        // a building with very many doors: its cheapest, but never at the cost of the point's own lines (`main`'s
        // snap among them), which come first and always stay
        if end.joins.len() > MAX_JOINS {
            let cost = |j: &Join| j.extra_m / speed + j.pen_s;
            let own = end.joins.iter().take_while(|j| j.door.is_none()).count();
            end.joins[own..].sort_by(|x, y| cost(x).total_cmp(&cost(y)));
            end.joins.truncate(MAX_JOINS.max(own));
        }
        end
    }

    /// This end with only its sure ways onto the network (not through a building or onto another floor), when it
    /// has both sure and unsure ones.
    pub fn sure(&self) -> Option<End> {
        let n = self.joins.iter().filter(|j| !j.unsure).count();
        (n > 0 && n < self.joins.len()).then(|| End { joins: self.joins.iter().filter(|j| !j.unsure).copied().collect(), ..self.clone() })
    }

    /// The levels of [`Join::doubt`] this end has, from the least.
    fn doubts(&self) -> Vec<u8> {
        let mut v: Vec<u8> = self.joins.iter().map(|j| j.doubt).collect();
        v.sort_unstable();
        v.dedup();
        v
    }

    /// This end with only its ways onto the network of at most this doubt.
    fn up_to(&self, doubt: u8) -> End {
        End { joins: self.joins.iter().filter(|j| j.doubt <= doubt).copied().collect(), ..self.clone() }
    }

    /// The starting (or end) points of a search from this end: (where on the network, metres walked to it,
    /// route-choice seconds). The one function both the stop search and the drawn walk take them from.
    pub fn sources(&self) -> Vec<(Snap, f32, f32)> {
        self.joins.iter().map(|j| (j.snap, j.extra_m, j.pen_s)).collect()
    }
}

/// Walking costs from one end of a walk to many boarding points (joined to the network at `targets`), the metres
/// from the point to the network and from the network to each boarding point (`dist_m` of its snap) included, with
/// the candidate (index into `end.joins`) each comes from.
///
/// A target is reached when some walk to it, from some candidate, takes at most `limit_s`: preferences (route
/// choice penalties on the way and of the candidates) only choose among those walks. In turn: the way the router
/// finds best from all candidates, if it is within the limit; else the best from each candidate alone, the cheapest
/// with its penalties of those within it; else the quickest walk ([`WalkRouter::quickest_many`]), if it is within.
/// `max_s` bounds the searches with penalties as it bounds [`WalkRouter::one_to_many`].
///
/// The ways onto the network are tried by [`Join::doubt`]: a line across unmapped ground only for the targets no
/// short line reaches within the limit, one through a building or onto another floor only for those neither
/// reaches. So more time never loses a target, for any walker.
pub fn reach_costs(router: &WalkRouter, end: &End, targets: &[Snap], profile: &WalkProfile, max_s: f32, limit_s: f32) -> Vec<Option<(WalkCost, usize)>> {
    let mut out: Vec<Option<(WalkCost, usize)>> = vec![None; targets.len()];
    // the short lines at hand first, then lines across unmapped ground, then through a building or onto another floor:
    // each only for the targets the ones before do not reach in time
    for lv in end.doubts() {
        let index: Vec<usize> = (0..end.joins.len()).filter(|&k| end.joins[k].doubt <= lv).collect();
        let left: Vec<usize> = (0..targets.len()).filter(|&i| out[i].is_none()).collect();
        if left.is_empty() {
            break;
        }
        let sub: Vec<Snap> = left.iter().map(|&i| targets[i]).collect();
        for (j, r) in reach_from(router, &end.up_to(lv).sources(), &sub, profile, max_s, limit_s).into_iter().enumerate() {
            out[left[j]] = r.map(|(c, k)| (c, index[k]));
        }
    }
    out
}

/// [`reach_costs`] from these sources, all alike.
fn reach_from(router: &WalkRouter, src: &[(Snap, f32, f32)], targets: &[Snap], profile: &WalkProfile, max_s: f32, limit_s: f32) -> Vec<Option<(WalkCost, usize)>> {
    let speed = profile.speed_mps.max(0.05);
    let with_target = |c: WalkCost, t: &Snap| WalkCost { var_m: c.var_m + t.dist_m, fix_s: c.fix_s };
    // within the limit as the stop search reports the walk: in whole seconds, rounded up (App::reach)
    let within = |c: WalkCost| walk_secs(c.var_m, c.fix_s, speed).ceil() <= limit_s;
    let mut out: Vec<Option<(WalkCost, usize)>> = vec![None; targets.len()];
    let mut found = vec![false; targets.len()];
    for (i, r) in router.many_to_many_raw(src, targets, profile, max_s).into_iter().enumerate() {
        if let Some((k, c, _)) = r {
            found[i] = true;
            let c = with_target(c, &targets[i]);
            if within(c) {
                out[i] = Some((c, k));
            }
        }
    }
    // the quickest walk, one search for all the rest: a target some walk reaches within the limit is reached,
    // whatever the preferred one takes; one no walk reaches in time is out of reach, and costs nothing more
    let left: Vec<usize> = (0..targets.len()).filter(|&i| out[i].is_none()).collect();
    if left.is_empty() {
        return out;
    }
    let sub: Vec<Snap> = left.iter().map(|&i| targets[i]).collect();
    let mut quick: Vec<(usize, WalkCost, usize)> = Vec::new(); // (target, cost, candidate)
    for (j, r) in router.quickest_many(src, &sub, profile, limit_s).into_iter().enumerate() {
        if let Some((k, c)) = r {
            let c = with_target(c, &sub[j]);
            if within(c) {
                quick.push((left[j], c, k));
            }
        }
    }
    // of those, the ones the preferred search found (over the limit): the cheapest (with penalties) of each
    // candidate's preferred walk that is within it, if one is; else the quickest
    let pref: Vec<usize> = quick.iter().map(|q| q.0).filter(|&i| found[i]).collect();
    let mut best: Vec<Option<(f32, WalkCost, usize)>> = vec![None; pref.len()];
    if !pref.is_empty() && src.len() > 1 {
        let sub: Vec<Snap> = pref.iter().map(|&i| targets[i]).collect();
        for (k, s) in src.iter().enumerate() {
            for (j, r) in router.many_to_many_raw(std::slice::from_ref(s), &sub, profile, max_s).into_iter().enumerate() {
                if let Some((_, c, gen)) = r {
                    let c = with_target(c, &sub[j]);
                    if within(c) && best[j].is_none_or(|b| gen < b.0) {
                        best[j] = Some((gen, c, k));
                    }
                }
            }
        }
    }
    for (i, c, k) in quick {
        let chosen = pref.iter().position(|&p| p == i).and_then(|j| best[j]).map(|b| (b.1, b.2));
        out[i] = Some(chosen.unwrap_or((c, k)));
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
    walk_within(router, a, b, profile, None)
}

fn walk_of(a: &End, b: &End, i: usize, j: usize, path: WalkPath, profile: &WalkProfile) -> Walk {
    let (from, to) = (a.joins[i], b.joins[j]);
    let speed = profile.speed_mps.max(0.05);
    let extra = from.extra_m + to.extra_m;
    let secs = walk_secs(path.cost.var_m + extra, path.cost.fix_s, speed);
    let dist_m = path.dist_m + extra;
    Walk { from, to, path, secs, dist_m }
}

/// [`walk`] within a time (a journey's walk to its first stop or from its last, timed by [`reach_costs`]): as
/// there, the best walk if it takes at most `limit_s`; else the cheapest (with penalties) of the best walks between
/// a candidate at each end that take at most `limit_s`; else the quickest walk. So the walk drawn is the one timed.
/// As there, the ends' sure ways onto the network first: a line through a building or onto another floor only when
/// no walk without one will do (within `limit_s`, or at all without a limit).
pub fn walk_within(router: &WalkRouter, a: &End, b: &End, profile: &WalkProfile, limit_s: Option<f32>) -> Option<Walk> {
    // as reach_costs: the least doubtful ways onto the network that give a walk (within the limit), each end on its
    // own: the pairs of levels from the least doubtful (the worse of the two, then both)
    let (da, db) = (a.doubts(), b.doubts());
    let mut pairs: Vec<(u8, u8)> = da.iter().flat_map(|&x| db.iter().map(move |&y| (x, y))).collect();
    pairs.sort_by_key(|&(x, y)| (x.max(y), x + y, x));
    pairs.pop(); // the last pair is all of both ends: the walk below
    for (x, y) in pairs {
        if let Some(w) = walk_ends(router, &a.up_to(x), &b.up_to(y), profile, limit_s).filter(|w| limit_s.is_none_or(|l| w.secs <= l + 0.5)) {
            return Some(w);
        }
    }
    walk_ends(router, a, b, profile, limit_s)
}

fn walk_ends(router: &WalkRouter, a: &End, b: &End, profile: &WalkProfile, limit_s: Option<f32>) -> Option<Walk> {
    let (sa, sb) = (a.sources(), b.sources());
    let best = router.route_between(&sa, &sb, profile).map(|(i, j, path, _)| walk_of(a, b, i, j, path, profile));
    let Some(limit) = limit_s else { return best };
    if best.as_ref().is_some_and(|w| w.secs <= limit + 0.5) {
        return best;
    }
    let mut pick: Option<(f32, Walk)> = None;
    if sa.len() * sb.len() > 1 {
        for i in 0..sa.len() {
            for j in 0..sb.len() {
                if let Some((_, _, path, gen)) = router.route_between(&sa[i..=i], &sb[j..=j], profile) {
                    let w = walk_of(a, b, i, j, path, profile);
                    if w.secs <= limit + 0.5 && pick.as_ref().is_none_or(|p| gen < p.0) {
                        pick = Some((gen, w));
                    }
                }
            }
        }
    }
    if let Some((_, w)) = pick {
        return Some(w);
    }
    router.quickest_between(&sa, &sb, profile).map(|(i, j, path, _)| walk_of(a, b, i, j, path, profile)).or(best)
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
    // (through the door itself: the line out of the building passes where the door is)
    match w.from.door.and_then(|d| door_pos(d)) {
        Some(dp) => {
            if w.from.inside_m > 1.5 {
                head.push(a.pos);
            }
            if dp.dist_m(&w.from.snap.pos) > 0.05 {
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
            if dp.dist_m(&w.to.snap.pos) > 0.05 {
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
    let guess = |j: &Join, e: &End| j.unsure || (j.snap.dist_m > GUESS_M && !e.on_track);
    let approx_start = (n_head > 0 && guess(&w.from, a)).then_some(n_head);
    let approx_end = (n_tail > 0 && guess(&w.to, b)).then_some(path_end);
    let wall = w.from.wall || w.to.wall;
    let unsure = w.from.unsure || w.to.unsure;
    // a walk with a guessed end is never step-free, whatever the guess
    let guessed = approx_start.is_some() || approx_end.is_some();
    let step_free = p.stairs_up == 0 && p.stairs_down == 0 && p.escalators == 0 && p.unmapped_level_changes == 0 && !unsure && !guessed && !a.no_step_free_door && !b.no_step_free_door;
    Drawn { geometry, levels, head: n_head, path_end, approx_start, approx_end, wall, step_free }
}

#[cfg(test)]
mod tests;
