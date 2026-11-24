//! Through the functions a request goes through: [`End::place`] (with [`point_candidates`]), [`reach_costs`], [`walk`] / [`walk_within`]
//! and [`draw`].

use super::*;
use crate::test_world::*;

fn place(r: &WalkRouter, ix: &DoorIndex, x: f32, y: f32, p: &WalkProfile) -> End {
    End::place(r, Some(ix), pt(x, y), p)
}
fn stop(r: &WalkRouter, x: f32, y: f32, p: &WalkProfile) -> End {
    End::stop(r, None, pt(x, y), Some(snap(r, x, y, p)), false)
}
/// Reach the stop's time, and the walk drawn to it: they must agree.
fn reach_and_walk(r: &WalkRouter, ix: &DoorIndex, from: &End, to: &End, p: &WalkProfile, max_s: f32) -> (Option<f32>, Walk, Drawn) {
    let c = reach_costs(r, from, &[to.joins[0].snap], p, max_s, max_s)[0].map(|c| c.0.secs(p.speed_mps));
    let w = walk_within(r, from, to, p, c).expect("a walk");
    if let Some(c) = c {
        assert!((c - w.secs).abs() < 0.5, "stop search {c} s, drawn walk {} s", w.secs);
    }
    let d = draw(Some(ix), from, to, &w);
    (c, w, d)
}
fn kind(ix: &DoorIndex, j: &Join) -> Option<DoorKind> {
    j.door.map(|d| ix.doors.doors[d as usize].kind)
}

#[test]
fn a_back_door_joined_through_the_house_to_a_covered_sidewalk_is_a_guess_and_not_step_free() {
    // finding 1: a 16 m deep house, its only door at the back, nothing behind it, a covered sidewalk in front
    let mut w = World::new();
    w.way((-100.0, -2.0), (100.0, -2.0), 10, EdgeKind::Sidewalk, EF_COVERED);
    let b = w.building(0.0, 0.0, 20.0, 16.0);
    w.door(b, 10.0, 16.0, DoorKind::Main, DOOR_WC_UNKNOWN);
    // an arcade: a walkway under the front 3 m of the next house, its door at the back of the arcade
    w.way((150.0, 2.0), (250.0, 2.0), 10, EdgeKind::Footway, EF_COVERED);
    w.way((100.0, -2.0), (150.0, 2.0), 1, EdgeKind::Footway, 0);
    let c = w.building(200.0, 0.0, 220.0, 16.0);
    w.door(c, 210.0, 3.0, DoorKind::Main, DOOR_WC_YES);
    let (r, ix) = w.finish();
    assert!(ix.doors.attach_of(0).iter().all(|a| a.through()), "through the house, arcade or not");
    for p in [NORMAL, STEP_FREE] {
        let home = place(&r, &ix, 10.0, 12.0, &p);
        let (c, _, d) = reach_and_walk(&r, &ix, &home, &stop(&r, 50.0, -2.0, &p), &p, 600.0);
        assert!(c.is_some());
        assert!(d.wall && !d.step_free && d.approx_start.is_some(), "{d:?}");
    }
    // the door under the arcade: a real way out
    assert!(ix.doors.attach_of(1).iter().any(|a| !a.through()));
    let shop = place(&r, &ix, 210.0, 10.0, &STEP_FREE);
    let (_, w2, d2) = reach_and_walk(&r, &ix, &shop, &stop(&r, 50.0, -2.0, &STEP_FREE), &STEP_FREE, 600.0);
    assert!(w2.from.door.is_some() && !d2.wall && d2.step_free, "{:?} {d2:?}", w2.from);
}

#[test]
fn a_step_free_main_door_beats_a_back_door_through_the_house() {
    // finding 2: the back door is right behind the point, but joined to the street only through the house
    let mut w = World::new();
    w.way((-100.0, -3.0), (100.0, -3.0), 20, EdgeKind::Sidewalk, 0);
    let b = w.building(0.0, 0.0, 30.0, 16.0);
    w.door(b, 25.0, 16.0, DoorKind::Yes, DOOR_WC_UNKNOWN);
    w.door(b, 5.0, 0.0, DoorKind::Main, DOOR_WC_YES);
    let (r, ix) = w.finish();
    for p in [NORMAL, STEP_FREE] {
        let home = place(&r, &ix, 25.0, 14.0, &p);
        let (c, w, d) = reach_and_walk(&r, &ix, &home, &stop(&r, 25.0, -3.0, &p), &p, 600.0);
        assert!(c.is_some());
        assert_eq!(kind(&ix, &w.from), Some(DoorKind::Main), "{:?}", w.from);
        assert!(!d.wall && d.step_free && d.approx_start.is_none());
    }
}

#[test]
fn a_stop_reached_only_from_the_point_is_reached_even_when_the_doors_reach_others() {
    // finding 3: the door opens onto the street in front (stop A); behind the deep house, more than 80 m from
    // the door, a path not joined to that street (stop B), 4 m from the point
    let mut w = World::new();
    w.way((-100.0, -3.0), (100.0, -3.0), 20, EdgeKind::Sidewalk, 0);
    w.way((-100.0, 103.0), (100.0, 103.0), 20, EdgeKind::Footway, 0);
    let b = w.building(0.0, 0.0, 20.0, 100.0);
    w.door(b, 10.0, 0.0, DoorKind::Main, DOOR_WC_UNKNOWN);
    let (r, ix) = w.finish();
    let home = place(&r, &ix, 10.0, 99.0, &NORMAL);
    assert!(home.joins.iter().any(|j| j.door.is_some()) && home.joins.iter().any(|j| j.door.is_none()));
    let (a, b2) = (stop(&r, 50.0, -3.0, &NORMAL), stop(&r, 50.0, 103.0, &NORMAL));
    let c = reach_costs(&r, &home, &[a.joins[0].snap, b2.joins[0].snap], &NORMAL, 900.0, 900.0);
    assert!(c[0].is_some() && c[1].is_some(), "{c:?}");
    let (_, wb, db) = reach_and_walk(&r, &ix, &home, &b2, &NORMAL, 900.0);
    assert!(wb.from.door.is_none() && db.wall && db.approx_start.is_some(), "out through the wall: a guess");
    let (_, wa, _) = reach_and_walk(&r, &ix, &home, &a, &NORMAL, 900.0);
    assert!(wa.from.door.is_some());
}

#[test]
fn every_door_is_tried_and_the_whole_time_allowed_counts() {
    // finding 4: nine doors at the back open onto a path joined to nothing; the garage door at the front leads
    // to the stop
    let mut w = World::new();
    w.way((-20.0, 23.0), (120.0, 23.0), 10, EdgeKind::Footway, 0);
    w.way((-20.0, -3.0), (120.0, -3.0), 10, EdgeKind::Sidewalk, 0);
    let b = w.building(0.0, 0.0, 100.0, 20.0);
    for i in 0..9 {
        w.door(b, 5.0 + 10.0 * i as f32, 20.0, DoorKind::Main, DOOR_WC_UNKNOWN);
    }
    w.door(b, 50.0, 0.0, DoorKind::Garage, DOOR_WC_UNKNOWN);
    // stairs on the way to a second stop
    w.way((120.0, -3.0), (130.0, -3.0), 1, EdgeKind::Steps, 0);
    w.way((130.0, -3.0), (190.0, -3.0), 4, EdgeKind::Sidewalk, 0);
    let (r, ix) = w.finish();
    let home = place(&r, &ix, 50.0, 15.0, &NORMAL);
    let (c, w1, _) = reach_and_walk(&r, &ix, &home, &stop(&r, 80.0, -3.0, &NORMAL), &NORMAL, 600.0);
    assert!(c.is_some());
    assert_eq!(kind(&ix, &w1.from), Some(DoorKind::Garage));
    // a walker who avoids stairs: the stop past them, with the limit just above its walking time
    let avoid = WalkProfile { stairs: StairsPref::Avoid, ..NORMAL };
    let far = stop(&r, 180.0, -3.0, &avoid);
    let from = place(&r, &ix, 50.0, 15.0, &avoid);
    // the quickest of the candidates on its own
    let t = (0..from.joins.len())
        .filter_map(|k| reach_costs(&r, &End { joins: vec![from.joins[k]], ..from.clone() }, &[far.joins[0].snap], &avoid, 3600.0, 3600.0)[0])
        .map(|c| c.0.secs(1.3))
        .fold(f32::INFINITY, f32::min);
    assert!(reach_costs(&r, &from, &[far.joins[0].snap], &avoid, t + 1.0, t + 1.0)[0].is_some(), "reached at {t} s within {} s", t + 1.0);
    assert!(reach_costs(&r, &from, &[far.joins[0].snap], &avoid, t - 2.0, t - 2.0)[0].is_none());
}

#[test]
fn a_point_in_a_building_without_doors_walks_out_through_its_wall_as_a_guess() {
    // finding 5: neither a mapped entrance nor a register address
    let mut w = World::new();
    w.way((-100.0, -3.0), (100.0, -3.0), 20, EdgeKind::Sidewalk, 0);
    w.building(0.0, 0.0, 20.0, 16.0);
    let (r, ix) = w.finish();
    let home = place(&r, &ix, 10.0, 8.0, &STEP_FREE);
    assert!(home.in_building && home.joins.len() == 1 && home.joins[0].wall);
    let (c, _, d) = reach_and_walk(&r, &ix, &home, &stop(&r, 50.0, -3.0, &STEP_FREE), &STEP_FREE, 600.0);
    assert!(c.is_some() && d.wall && !d.step_free && d.approx_start == Some(1), "{d:?}");
    // the other way round: to the building
    let (_, _, d2) = reach_and_walk(&r, &ix, &stop(&r, 50.0, -3.0, &STEP_FREE), &home, &STEP_FREE, 600.0);
    assert!(d2.wall && !d2.step_free && d2.approx_end.is_some(), "{d2:?}");
}

#[test]
fn every_way_out_of_a_door_onto_a_main_road_counts_four_times() {
    // finding 6: the door's nearest way is a sidewalk a wheelchair may not take; next a main road 3 m away, then
    // a footway 12 m away. The stop is on the main road.
    let mut w = World::new();
    w.way((-100.0, -3.0), (100.0, -3.0), 20, EdgeKind::RoadBusy, 0);
    w.way((-100.0, -1.0), (100.0, -1.0), 20, EdgeKind::Sidewalk, EF_WHEELCHAIR_NO);
    w.way((-100.0, -12.0), (100.0, -12.0), 20, EdgeKind::Footway, 0);
    w.way((20.0, -12.0), (30.0, -3.0), 1, EdgeKind::Footway, 0);
    let b = w.building(-10.0, 0.0, 10.0, 20.0);
    w.door(b, 0.0, 0.0, DoorKind::Main, DOOR_WC_UNKNOWN);
    let (r, ix) = w.finish();
    let home = place(&r, &ix, 0.0, 2.0, &STEP_FREE);
    let g = r.graph();
    let road: Vec<&Join> = home.joins.iter().filter(|j| j.door.is_some() && g.edges[j.snap.edge as usize].kind == EdgeKind::RoadBusy).collect();
    assert!(!road.is_empty() && road.iter().all(|j| j.pen_s > 3.0 * j.line_m() / 1.3 - 0.1), "{road:?}");
    let (_, w1, _) = reach_and_walk(&r, &ix, &home, &stop(&r, 28.0, -3.0, &STEP_FREE), &STEP_FREE, 600.0);
    assert_eq!(g.edges[w1.from.snap.edge as usize].kind, EdgeKind::Footway, "{:?}", w1.from);
}

#[test]
fn a_point_is_put_on_the_ground_not_on_a_bridge_above_it() {
    // finding 8: an unlevelled bridge 4 m away, a path on the ground 8 m away
    let mut w = World::new();
    w.way((-100.0, 4.0), (100.0, 4.0), 4, EdgeKind::Footway, EF_BRIDGE);
    w.way((-100.0, 8.0), (100.0, 8.0), 4, EdgeKind::Footway, 0);
    w.way((-100.0, 30.0), (100.0, 30.0), 4, EdgeKind::Footway, EF_BRIDGE);
    let (r, _) = w.finish();
    let s = snap_point(&r, pt(0.0, 0.0), &NORMAL).unwrap();
    assert!((s.dist_m - 8.0).abs() < 0.5, "{s:?}");
    // standing on a bridge with no ground within 10 m: on the bridge
    let s = snap_point(&r, pt(0.0, 31.0), &NORMAL).unwrap();
    assert!((s.dist_m - 1.0).abs() < 0.5, "{s:?}");
    // a covered bridge is a bridge too
    let mut w = World::new();
    w.way((-100.0, 4.0), (100.0, 4.0), 4, EdgeKind::Footway, EF_BRIDGE | EF_COVERED);
    w.way((-100.0, 8.0), (100.0, 8.0), 4, EdgeKind::Footway, 0);
    let (r, _) = w.finish();
    let s = snap_point(&r, pt(0.0, 0.0), &NORMAL).unwrap();
    assert!((s.dist_m - 8.0).abs() < 0.5, "{s:?}");
}

#[test]
fn the_stop_search_and_the_drawn_walk_agree() {
    // a block of houses with doors of every kind on two streets joined at both ends
    let mut w = World::new();
    w.way((-50.0, -3.0), (250.0, -3.0), 30, EdgeKind::Sidewalk, 0);
    w.way((-50.0, 43.0), (250.0, 43.0), 30, EdgeKind::Footway, 0);
    w.way((-50.0, -3.0), (-50.0, 43.0), 4, EdgeKind::Steps, 0);
    w.way((250.0, -3.0), (250.0, 43.0), 4, EdgeKind::Footway, EF_WHEELCHAIR_NO);
    let kinds = [DoorKind::Main, DoorKind::Garage, DoorKind::Service, DoorKind::Yes, DoorKind::Emergency];
    for i in 0..5 {
        let x = 40.0 * i as f32;
        let b = w.building(x, 0.0, x + 30.0, 40.0);
        w.door(b, x + 5.0, 0.0, kinds[i], if i % 2 == 0 { DOOR_WC_YES } else { DOOR_WC_NO });
        w.door(b, x + 25.0, 40.0, kinds[(i + 2) % 5], DOOR_WC_UNKNOWN);
    }
    let (r, ix) = w.finish();
    let mut n = 0;
    for p in [NORMAL, STEP_FREE, WalkProfile { stairs: StairsPref::Avoid, ..NORMAL }] {
        for k in 0..20 {
            let (x, y) = (3.0 + 9.7 * k as f32, 5.0 + (k * 7 % 30) as f32);
            let home = place(&r, &ix, x, y, &p);
            for (sx, sy) in [(-20.0, -3.0), (120.0, 43.0), (230.0, -3.0)] {
                let to = stop(&r, sx, sy, &p);
                if walk(&r, &home, &to, &p).is_some() {
                    let (c, _, _) = reach_and_walk(&r, &ix, &home, &to, &p, 3600.0);
                    assert!(c.is_some());
                    n += 1;
                }
            }
        }
    }
    assert!(n > 100, "{n}");
}


#[test]
fn a_walk_out_of_a_building_passes_its_door() {
    // the door's way out is 30 cm: the line from inside still goes through the door, not through the wall beside it
    let mut w = World::new();
    w.way((-100.0, -0.3), (100.0, -0.3), 20, EdgeKind::Sidewalk, 0);
    let b = w.building(0.0, 0.0, 20.0, 16.0);
    w.door(b, 10.0, 0.0, DoorKind::Main, DOOR_WC_YES);
    let (r, ix) = w.finish();
    let home = place(&r, &ix, 3.0, 8.0, &STEP_FREE);
    let (_, w1, d) = reach_and_walk(&r, &ix, &home, &stop(&r, 50.0, -0.3, &STEP_FREE), &STEP_FREE, 600.0);
    assert!(w1.from.door.is_some() && !d.wall && d.step_free);
    assert!(d.geometry.iter().any(|p| p.dist_m(&pt(10.0, 0.0)) < 0.05), "{:?}", d.geometry.iter().map(|p| p.xy()).collect::<Vec<_>>());
    assert!(d.geometry.windows(2).all(|s| !ix.through(s[0], s[1], 0.0)), "no straight line through a building");
}

#[test]
fn inside_to_the_door_through_another_building_is_a_guess() {
    // the point is in two overlapping buildings; the door of the one is behind the wall of the other
    let mut w = World::new();
    w.way((-100.0, -3.0), (100.0, -3.0), 20, EdgeKind::Sidewalk, 0);
    let a = w.building(0.0, 0.0, 20.0, 16.0);
    w.door(a, 10.0, 0.0, DoorKind::Main, DOOR_WC_YES);
    w.building(12.0, 4.0, 30.0, 12.0);
    let (r, ix) = w.finish();
    let home = place(&r, &ix, 15.0, 8.0, &STEP_FREE);
    let (_, w1, d) = reach_and_walk(&r, &ix, &home, &stop(&r, 50.0, -3.0, &STEP_FREE), &STEP_FREE, 600.0);
    assert!(w1.from.wall && d.wall && !d.step_free && d.approx_start.is_some(), "{:?} {d:?}", w1.from);
}

#[test]
fn a_stop_the_point_reaches_within_the_limit_is_reached_whatever_a_door_costs() {
    // finding 1: the point (inside the house) is 4 m from the sidewalk through the front wall, 19 m to the stop
    // (15 s); the only door is at the back, 85 s round the block. Route choice prefers the door (the line through the
    // wall counts 4 × + 200 m); the limit, 45 s, only the point's own line keeps.
    let mut w = World::new();
    w.way((-100.0, -2.0), (100.0, -2.0), 20, EdgeKind::Sidewalk, 0);
    w.way((10.0, 13.0), (60.0, 13.0), 5, EdgeKind::Footway, 0);
    w.way((60.0, 13.0), (60.0, -2.0), 1, EdgeKind::Footway, 0);
    let b = w.building(0.0, 0.0, 20.0, 10.0);
    w.door(b, 10.0, 10.0, DoorKind::Main, DOOR_WC_UNKNOWN);
    let (r, ix) = w.finish();
    let home = place(&r, &ix, 10.0, 2.0, &NORMAL);
    let to = stop(&r, 25.0, -2.0, &NORMAL);
    // without a limit that matters: through the door
    let free = walk(&r, &home, &to, &NORMAL).unwrap();
    assert!(free.from.door.is_some() && free.secs > 60.0, "{:?} {}", free.from, free.secs);
    // within 45 s: reached, through the wall, in the point's own time; the walk drawn for it is that one
    let c = reach_costs(&r, &home, &[to.joins[0].snap], &NORMAL, 45.0, 45.0)[0].expect("reached within 45 s");
    let secs = c.0.secs(1.3);
    assert!(secs < 20.0 && home.joins[c.1].door.is_none(), "{secs} via {:?}", home.joins[c.1]);
    let drawn = walk_within(&r, &home, &to, &NORMAL, Some(secs)).unwrap();
    assert!((drawn.secs - secs).abs() < 0.5 && drawn.from.door.is_none());
    let d = draw(Some(&ix), &home, &to, &drawn);
    assert!(d.wall && d.approx_start.is_some() && !d.step_free, "through the wall: a guess");
    // the point alone reaches it in the same time: the doors only add
    let alone = End { joins: home.joins.iter().filter(|j| j.door.is_none()).copied().collect(), ..home.clone() };
    let a = reach_costs(&r, &alone, &[to.joins[0].snap], &NORMAL, 45.0, 45.0)[0].unwrap();
    assert!((a.0.secs(1.3) - secs).abs() < 0.01);
}

#[test]
fn a_snap_that_leads_nowhere_is_not_taken() {
    // finding 5: a road stub 1.82 m to one side that leads nowhere, a footbridge 1.64 m to the other that does
    let mut w = World::new();
    w.way((-30.0, -1.82), (30.0, -1.82), 3, EdgeKind::Road, 0);
    w.way((-50.0, 1.64), (50.0, 1.64), 5, EdgeKind::Footway, EF_BRIDGE);
    w.way((50.0, 1.64), (300.0, 1.64), 10, EdgeKind::Footway, 0);
    let (r, ix) = w.finish();
    for p in [NORMAL, STEP_FREE] {
        let here = place(&r, &ix, 0.0, 0.0, &p);
        let to = stop(&r, 250.0, 1.64, &p);
        let (c, w1, d) = reach_and_walk(&r, &ix, &here, &to, &p, 600.0);
        assert!(c.is_some() && !d.wall && d.approx_start.is_none(), "{c:?} {d:?}");
        assert!(r.graph().edges[w1.from.snap.edge as usize].flags & EF_BRIDGE != 0, "over the footbridge");
    }
}

#[test]
fn a_line_across_the_open_side_of_a_u_is_through_a_building() {
    // finding 2: the point in the left wing, a corridor in the right wing 18 m away across the open side
    let mut w = World::new();
    w.way((25.0, 0.0), (25.0, 30.0), 3, EdgeKind::Corridor, EF_INDOOR);
    w.way((25.0, 30.0), (100.0, 30.0), 3, EdgeKind::Footway, 0);
    w.b.buildings.push(kante_osm::buildings::BuildingRaw {
        outer: [(0.0, 0.0), (30.0, 0.0), (30.0, 20.0), (20.0, 20.0), (20.0, 8.0), (10.0, 8.0), (10.0, 20.0), (0.0, 20.0)].iter().map(|&(x, y)| pt(x, y)).collect(),
        holes: vec![],
    });
    let (r, ix) = w.finish();
    let here = place(&r, &ix, 5.0, 15.0, &STEP_FREE);
    let (_, w1, d) = reach_and_walk(&r, &ix, &here, &stop(&r, 90.0, 30.0, &STEP_FREE), &STEP_FREE, 600.0);
    assert!(w1.from.wall && d.wall && d.approx_start.is_some() && !d.step_free, "{:?} {d:?}", w1.from);
}

#[test]
fn a_station_is_entered_from_a_way_that_leads_on() {
    // the way nearest to the station's point (1.4 m) leads only to stairs; 12 m away a footway goes on step-free to
    // the stop
    let mut w = World::new();
    w.way((-20.0, 1.4), (0.0, 1.4), 2, EdgeKind::Footway, 0);
    w.way((0.0, 1.4), (10.0, 1.4), 1, EdgeKind::Steps, 0);
    w.way((10.0, 1.4), (60.0, 1.4), 5, EdgeKind::Footway, 0);
    w.way((-50.0, -12.0), (60.0, -12.0), 11, EdgeKind::Footway, 0);
    w.way((60.0, -12.0), (60.0, 1.4), 1, EdgeKind::Footway, 0);
    let (r, ix) = w.finish();
    let station = End::station(&r, Some(&ix), pt(-5.0, 0.0), &STEP_FREE);
    assert!(station.joins.len() >= 2, "{:?}", station.joins);
    let to = stop(&r, 30.0, 1.4, &STEP_FREE);
    let (c, w1, _) = reach_and_walk(&r, &ix, &station, &to, &STEP_FREE, 600.0);
    assert!(c.is_some() && w1.path.stairs_up == 0 && w1.path.stairs_down == 0, "{c:?}");
}

#[test]
fn a_stop_some_walk_reaches_within_the_limit_is_reached_whatever_the_preferred_route_takes() {
    // last review, finding 1: from one candidate, the route the penalties prefer (a quiet detour, 100.8 s) is over the
    // limit, the quicker one along a busy road (85.4 s) within it
    let mut w = World::new();
    w.way((-10.0, 0.0), (0.0, 0.0), 2, EdgeKind::Footway, 0);
    w.way((0.0, 0.0), (100.0, 0.0), 4, EdgeKind::RoadBusy, 0);
    w.way((0.0, 0.0), (0.0, 10.0), 1, EdgeKind::Footway, 0);
    w.way((0.0, 10.0), (100.0, 10.0), 4, EdgeKind::Footway, 0);
    w.way((100.0, 10.0), (100.0, 0.0), 1, EdgeKind::Footway, 0);
    w.way((100.0, 0.0), (110.0, 0.0), 2, EdgeKind::Footway, 0);
    let (r, ix) = w.finish();
    let here = place(&r, &ix, -5.0, 1.0, &NORMAL);
    let to = stop(&r, 105.0, 0.0, &NORMAL);
    let preferred = walk(&r, &here, &to, &NORMAL).unwrap();
    assert!(preferred.secs > 95.0, "the penalties prefer the detour: {} s", preferred.secs);
    let (c, w1, _) = reach_and_walk(&r, &ix, &here, &to, &NORMAL, 95.0);
    let c = c.expect("reached: a walk within the limit exists");
    assert!(c <= 95.0 && (c - w1.secs).abs() < 0.5, "{c} s, drawn {} s", w1.secs);
}

#[test]
fn many_doors_never_crowd_out_the_points_own_lines() {
    // last review, finding 1: a building with 300 doors; the point's own line (main's snap, through the wall) stays
    let mut w = World::new();
    w.way((-20.0, -3.0), (320.0, -3.0), 20, EdgeKind::Sidewalk, 0);
    let b = w.building(0.0, 0.0, 300.0, 20.0);
    for i in 0..300 {
        w.door(b, 0.5 + i as f32, 0.0, DoorKind::Yes, DOOR_WC_UNKNOWN);
    }
    let (r, ix) = w.finish();
    let here = place(&r, &ix, 150.0, 10.0, &NORMAL);
    let main = snap_main(&r, pt(150.0, 10.0), &NORMAL).unwrap();
    assert!(here.joins.len() <= MAX_JOINS + 8, "{}", here.joins.len());
    assert!(here.joins.iter().any(|j| j.door.is_none() && j.snap.edge == main.edge), "main's snap is still a candidate");
}

#[test]
fn a_line_through_a_building_is_taken_only_where_no_other_will_do() {
    // last review, walk #2366: a clear 38 m line north to a way that goes 676 m round, a 57 m line south through a
    // house to a way that goes straight to the end; the second is cheaper even with the line's weight
    let mut w = World::new();
    w.way((-300.0, 38.0), (200.0, 38.0), 8, EdgeKind::Footway, 0);
    w.way((-300.0, 38.0), (-300.0, -57.0), 4, EdgeKind::Footway, 0);
    w.way((-300.0, -57.0), (200.0, -57.0), 8, EdgeKind::Footway, 0);
    w.way((200.0, -57.0), (900.0, -57.0), 10, EdgeKind::Footway, 0);
    w.building(-10.0, -40.0, 10.0, -20.0);
    let (r, ix) = w.finish();
    for p in [NORMAL, STEP_FREE] {
        let here = place(&r, &ix, 0.0, 0.0, &p);
        // both over 20 m (guesses across the open), the second through the house as well
        assert!(here.joins.iter().any(|j| j.doubt == 1 && !j.wall) && here.joins.iter().any(|j| j.doubt == 2 && j.wall), "{:?}", here.joins);
        let to = stop(&r, 850.0, -57.0, &p);
        let all = End { joins: here.joins.clone(), ..here.clone() };
        let (_, _, _, gen_wall) = r.route_between(&all.sources(), &to.sources(), &p).unwrap();
        let w1 = walk(&r, &here, &to, &p).unwrap();
        let d = draw(Some(&ix), &here, &to, &w1);
        assert!(!w1.from.wall && !d.wall && d.approx_start.is_some() && !d.step_free, "the clear line, a guess across the open: {:?}", w1.from);
        assert!(w1.secs > gen_wall, "the walk through the house was the cheaper one: {} s against {gen_wall}", w1.secs);
        // the stop search takes the same, and so does the walk drawn for it
        let (c, w2, _) = reach_and_walk(&r, &ix, &here, &to, &p, 3600.0);
        assert!(c.is_some() && !w2.from.wall, "{:?}", w2.from);
    }
    // with nothing clear that leads anywhere, the line through the house is still a way out (a guess)
    let mut w = World::new();
    w.way((-200.0, -57.0), (900.0, -57.0), 10, EdgeKind::Footway, 0);
    w.building(-10.0, -40.0, 10.0, -20.0);
    let (r, ix) = w.finish();
    let here = place(&r, &ix, 0.0, 0.0, &NORMAL);
    let to = stop(&r, 850.0, -57.0, &NORMAL);
    let (c, w1, d) = reach_and_walk(&r, &ix, &here, &to, &NORMAL, 3600.0);
    assert!(c.is_some() && w1.from.unsure && d.approx_start.is_some() && !d.step_free);
}

#[test]
fn a_line_through_a_building_serves_only_the_stops_no_other_line_reaches_and_more_time_never_loses_a_stop() {
    // review 5, #846 and #4460: a clear line north (15 m) to a way that does not lead south; a line south through a
    // house (30 m) to a way with a stop just beyond. For every walker the stop only the house's line reaches is
    // reached by it (a guess, not step-free), the stop the clear way reaches by the clear way, and a longer limit
    // never loses a stop a shorter one reaches.
    let mut w = World::new();
    w.way((-300.0, 15.0), (300.0, 15.0), 12, EdgeKind::Footway, 0);
    w.way((-300.0, -30.0), (300.0, -30.0), 12, EdgeKind::Footway, 0);
    w.building(-10.0, -25.0, 10.0, -5.0);
    let (r, ix) = w.finish();
    for p in [NORMAL, STEP_FREE] {
        let here = place(&r, &ix, 0.0, 0.0, &p);
        let targets = [snap(&r, 250.0, 15.0, &p), snap(&r, 20.0, -30.0, &p)];
        let mut before: Vec<bool> = vec![false; 2];
        for limit in [30.0, 60.0, 120.0, 300.0, 600.0, 1200.0] {
            let c = reach_costs(&r, &here, &targets, &p, limit, limit);
            for (i, x) in c.iter().enumerate() {
                assert!(x.is_some() || !before[i], "stop {i} reached with less time, not with {limit} s");
                before[i] = x.is_some();
            }
            if let Some((_, k)) = c[0] {
                assert!(!here.joins[k].unsure, "the clear way for the stop it reaches");
            }
            if let Some((_, k)) = c[1] {
                assert!(here.joins[k].unsure && here.joins[k].wall, "only the line through the house reaches it");
            }
        }
        assert!(before[0] && before[1], "both reached with 20 minutes");
        let (_, w1, d) = reach_and_walk(&r, &ix, &here, &stop(&r, 20.0, -30.0, &p), &p, 1200.0);
        assert!(w1.from.unsure && d.approx_start.is_some() && !d.step_free, "a guess, not step-free");
    }
}

#[test]
fn a_point_on_a_footbridge_starts_on_it() {
    // last review, walk #16572: the point 1.64 m from a footbridge, nothing on the ground within 10 m; a way on the
    // ground 26 m away would make the walk shorter, but the line to it leaves the bridge sideways
    let mut w = World::new();
    w.way((-60.0, 1.64), (60.0, 1.64), 6, EdgeKind::Footway, EF_BRIDGE);
    w.way((60.0, 1.64), (400.0, 1.64), 10, EdgeKind::Footway, 0);
    w.way((400.0, 1.64), (400.0, -26.0), 1, EdgeKind::Footway, 0);
    w.way((-100.0, -26.0), (400.0, -26.0), 10, EdgeKind::Footway, 0);
    let (r, ix) = w.finish();
    for p in [NORMAL, STEP_FREE] {
        let here = place(&r, &ix, 0.0, 0.0, &p);
        let to = stop(&r, 300.0, -26.0, &p);
        let w1 = walk(&r, &here, &to, &p).unwrap();
        let d = draw(Some(&ix), &here, &to, &w1);
        assert!(r.graph().edges[w1.from.snap.edge as usize].flags & EF_BRIDGE != 0 && d.approx_start.is_none(), "on the footbridge: {:?}", w1.from);
        let (c, w2, _) = reach_and_walk(&r, &ix, &here, &to, &p, 3600.0);
        assert!(c.is_some() && r.graph().edges[w2.from.snap.edge as usize].flags & EF_BRIDGE != 0);
    }
}

#[test]
fn a_point_on_the_ground_does_not_start_on_a_bridge_further_off() {
    // last review, finding 3: the ground 8 m away goes round; a bridge 25 m away goes straight to the stop. snap_point
    // chose the ground, and now so does the walk
    let mut w = World::new();
    w.way((-300.0, 8.0), (300.0, 8.0), 12, EdgeKind::Footway, 0);
    w.way((300.0, 8.0), (300.0, 25.0), 1, EdgeKind::Footway, 0);
    w.way((-300.0, 25.0), (300.0, 25.0), 12, EdgeKind::Footway, EF_BRIDGE);
    w.way((-300.0, 25.0), (-300.0, 200.0), 4, EdgeKind::Footway, 0);
    let (r, ix) = w.finish();
    assert!((snap_point(&r, pt(0.0, 0.0), &NORMAL).unwrap().dist_m - 8.0).abs() < 0.5);
    for p in [NORMAL, STEP_FREE] {
        let here = place(&r, &ix, 0.0, 0.0, &p);
        let to = stop(&r, -300.0, 150.0, &p);
        let w1 = walk(&r, &here, &to, &p).unwrap();
        assert!(r.graph().edges[w1.from.snap.edge as usize].flags & EF_BRIDGE == 0 && !w1.from.unsure, "on the ground: {:?}", w1.from);
    }
}

#[test]
fn a_point_between_a_footbridge_and_a_service_road_starts_on_one_of_them() {
    // review 5, walk #16572 (47.546155, 7.758926): a footbridge 1.64 m to one side, a service road on the ground
    // 1.82 m to the other (so the point is on the ground), and a way 26 m off that would make the walk shorter. The
    // 26 m line is a guess across the open: taken only where the short lines do not lead.
    let mut w = World::new();
    w.way((-60.0, 1.64), (60.0, 1.64), 6, EdgeKind::Footway, EF_BRIDGE);
    w.way((60.0, 1.64), (300.0, 1.64), 10, EdgeKind::Footway, 0);
    w.way((-40.0, -1.82), (40.0, -1.82), 4, EdgeKind::Road, 0);
    w.way((40.0, -1.82), (60.0, 1.64), 1, EdgeKind::Footway, 0);
    w.way((-100.0, -26.0), (500.0, -26.0), 12, EdgeKind::Footway, 0);
    w.way((300.0, 1.64), (300.0, -26.0), 1, EdgeKind::Footway, 0);
    let (r, ix) = w.finish();
    for p in [NORMAL, STEP_FREE] {
        let here = place(&r, &ix, 0.0, 0.0, &p);
        assert!(here.joins.iter().any(|j| j.snap.dist_m > 20.0 && j.doubt == 1), "the 26 m line is a candidate: {:?}", here.joins);
        let to = stop(&r, -80.0, -26.0, &p);
        let w1 = walk(&r, &here, &to, &p).unwrap();
        let d = draw(Some(&ix), &here, &to, &w1);
        assert!(w1.from.snap.dist_m < 2.0 && d.approx_start.is_none(), "a short line at hand, not the guess: {:?}", w1.from);
        let (c, w2, _) = reach_and_walk(&r, &ix, &here, &to, &p, 3600.0);
        assert!(c.is_some() && w2.from.snap.dist_m < 2.0);
    }
}

#[test]
fn a_stop_is_reached_when_the_walk_rounded_up_to_the_second_is_within_the_limit() {
    // review 5, Geneva #13520: a preferred walk 0.7 ms over the limit was taken under a 1 ms tolerance, and then
    // rounded up past it, so the stop was dropped although a quicker walk was well within. The same as the API counts:
    // whole seconds, rounded up.
    let mut w = World::new();
    w.way((-10.0, 0.0), (0.0, 0.0), 2, EdgeKind::Footway, 0);
    w.way((0.0, 0.0), (100.0, 0.0), 4, EdgeKind::RoadBusy, 0);
    w.way((0.0, 0.0), (0.0, 10.0), 1, EdgeKind::Footway, 0);
    w.way((0.0, 10.0), (100.0, 10.0), 4, EdgeKind::Footway, 0);
    w.way((100.0, 10.0), (100.0, 0.0), 1, EdgeKind::Footway, 0);
    w.way((100.0, 0.0), (110.0, 0.0), 2, EdgeKind::Footway, 0);
    let (r, ix) = w.finish();
    let here = place(&r, &ix, -5.0, 1.0, &NORMAL);
    let to = stop(&r, 105.0, 0.0, &NORMAL);
    // a walking pace that makes the preferred walk take 0.5 ms over a whole second, as at Geneva (570.0007 s)
    let p0 = walk(&r, &here, &to, &NORMAL).unwrap().secs;
    let limit = p0.floor();
    let p = WalkProfile { speed_mps: NORMAL.speed_mps * p0 / (limit + 0.0005), ..NORMAL };
    let here = place(&r, &ix, -5.0, 1.0, &p);
    let preferred = walk(&r, &here, &to, &p).unwrap().secs;
    assert!(preferred > limit && preferred < limit + 0.001, "{preferred} against {limit}");
    let quickest = r.quickest_between(&here.sources(), &to.sources(), &p).map(|(i, j, q, _)| walk_of(&here, &to, i, j, q, &p).secs).unwrap();
    assert!(quickest < limit - 5.0, "{quickest}");
    // the stop search with that whole-second limit: the quickest walk, which rounded up is within it (the
    // preferred one, rounded up, is a second over: the API would drop the stop)
    let c = reach_costs(&r, &here, &[to.joins[0].snap], &p, limit, limit)[0].map(|c| c.0.secs(p.speed_mps)).expect("reached");
    assert!(c.ceil() <= limit, "{c} s reported for a limit of {limit} s");
    let c = reach_costs(&r, &here, &[to.joins[0].snap], &p, quickest.ceil() - 1.0, quickest.ceil() - 1.0)[0];
    assert!(c.is_none(), "no walk within a second less");
}

#[test]
fn a_boarding_points_line_to_its_link_through_a_building_is_a_guess() {
    // review 6, Gänsbrunnen: the stop's point on one side of a house, its link (main's) on the way behind it; the
    // straight line from the point to the link runs through the house. The link stays, the line is a guess.
    let mut w = World::new();
    w.way((-100.0, 20.0), (100.0, 20.0), 8, EdgeKind::Footway, 0);
    w.building(-10.0, 5.0, 10.0, 15.0);
    let (r, ix) = w.finish();
    // the link as the linker makes it: snapped from the stop's point
    let link = snap(&r, 0.0, 0.0, &STEP_FREE);
    let at = End::stop(&r, Some(&ix), pt(0.0, 0.0), Some(link), false);
    assert!(at.joins[0].wall && at.joins[0].unsure, "{:?}", at.joins[0]);
    let to = End::stop(&r, Some(&ix), pt(80.0, 21.0), Some(snap(&r, 80.0, 20.0, &STEP_FREE)), false);
    let w1 = walk(&r, &at, &to, &STEP_FREE).unwrap();
    let d = draw(Some(&ix), &at, &to, &w1);
    assert!(d.approx_start.is_some() && !d.step_free, "a guess, not step-free: {d:?}");
    // a railway platform's point (on the track) keeps its line as before
    let plat = End::stop(&r, Some(&ix), pt(0.0, 0.0), Some(link), true);
    assert!(!plat.joins[0].unsure);
}

#[test]
fn a_line_across_a_railway_track_is_taken_only_where_nothing_else_reaches() {
    // review 6: two paths 12 m apart with a track on the ground between them, a crossing 150 m along; the point
    // beside the near path. The stop on the far path is reached over the crossing, not straight over the track.
    let mut w = World::new();
    w.way((-200.0, -2.0), (200.0, -2.0), 8, EdgeKind::Footway, 0);
    w.way((-200.0, 10.0), (200.0, 10.0), 8, EdgeKind::Footway, 0);
    w.way((150.0, -2.0), (150.0, 10.0), 1, EdgeKind::Crossing, 0);
    w.rail(&[(-300.0, 4.0), (300.0, 4.0)], false);
    let (r, ix) = w.finish();
    for p in [NORMAL, STEP_FREE] {
        let here = place(&r, &ix, 0.0, 0.0, &p);
        assert!(here.joins.iter().any(|j| j.snap.dist_m > 9.0 && j.doubt == 2), "the line over the track is a candidate, and a guess: {:?}", here.joins);
        let to = stop(&r, 0.0, 10.0, &p);
        let (c, w1, d) = reach_and_walk(&r, &ix, &here, &to, &p, 3600.0);
        assert!(c.is_some() && w1.from.doubt == 0 && d.approx_start.is_none(), "over the crossing: {:?}", w1.from);
        assert!(w1.secs > 200.0, "the long way round: {} s", w1.secs);
        // with only a minute, the line over the track is the only walk in time: taken, as a guess, not step-free
        let (c, w2, d) = reach_and_walk(&r, &ix, &here, &to, &p, 60.0);
        assert!(c.is_some() && w2.from.doubt == 2 && d.approx_start.is_some() && !d.step_free, "{:?} {d:?}", w2.from);
    }
}

#[test]
fn a_walk_with_a_guessed_end_is_never_step_free() {
    // review 6, A: a boarding point 30 m from its link across open ground (a guess by its length), on a step-free path
    let mut w = World::new();
    w.way((-100.0, 30.0), (100.0, 30.0), 8, EdgeKind::Footway, 0);
    let (r, ix) = w.finish();
    let at = End::stop(&r, Some(&ix), pt(0.0, 0.0), Some(snap(&r, 0.0, 0.0, &STEP_FREE)), false);
    let to = End::stop(&r, Some(&ix), pt(80.0, 30.0), Some(snap(&r, 80.0, 30.0, &STEP_FREE)), false);
    let w1 = walk(&r, &at, &to, &STEP_FREE).unwrap();
    let d = draw(Some(&ix), &at, &to, &w1);
    assert!(d.approx_start.is_some() && !d.step_free, "{d:?}");
}

#[test]
fn a_point_next_to_its_buildings_wall_leaves_by_its_own_door() {
    // review 6 (Neon): a rowhouse with neighbours on both sides, the street in front, a step-free main door; the point
    // 20 cm inside the party wall. The line inside to the door is not through a wall.
    let mut w = World::new();
    w.way((-100.0, -3.0), (100.0, -3.0), 8, EdgeKind::Sidewalk, 0);
    let b = w.building(0.0, 0.0, 20.0, 16.0);
    w.building(-20.0, 0.0, 0.0, 16.0);
    w.building(20.0, 0.0, 40.0, 16.0);
    w.door(b, 10.0, 0.0, DoorKind::Main, DOOR_WC_YES);
    let (r, ix) = w.finish();
    let here = place(&r, &ix, 0.2, 8.0, &STEP_FREE);
    let door = here.joins.iter().find(|j| j.door.is_some()).expect("its door");
    assert!(!door.wall && door.doubt == 0, "{door:?}");
    let to = stop(&r, 60.0, -3.0, &STEP_FREE);
    let w1 = walk(&r, &here, &to, &STEP_FREE).unwrap();
    let d = draw(Some(&ix), &here, &to, &w1);
    assert!(w1.from.door.is_some() && d.step_free && d.approx_start.is_none(), "{:?} {d:?}", w1.from);
}

#[test]
fn a_walk_through_a_door_that_is_not_step_free_is_not_step_free_for_anyone() {
    // review 6 (Neon): a normal walker may use a wheelchair=no door; the walk then is not step-free
    let mut w = World::new();
    w.way((-100.0, -3.0), (100.0, -3.0), 8, EdgeKind::Sidewalk, 0);
    let b = w.building(0.0, 0.0, 20.0, 16.0);
    w.door(b, 10.0, 0.0, DoorKind::Main, DOOR_WC_NO);
    let (r, ix) = w.finish();
    let here = place(&r, &ix, 10.0, 8.0, &NORMAL);
    let to = stop(&r, 60.0, -3.0, &NORMAL);
    let w1 = walk(&r, &here, &to, &NORMAL).unwrap();
    let d = draw(Some(&ix), &here, &to, &w1);
    assert!(w1.from.door.is_some() && !d.step_free, "{:?} {d:?}", w1.from);
}

#[test]
fn a_line_inside_to_the_door_that_leaves_the_building_on_the_way_is_through_a_wall() {
    // the national comparison: a point in a U's left wing, the only door on the right wing, the line inside to it
    // across the open side
    let mut w = World::new();
    w.way((-10.0, 25.0), (100.0, 25.0), 8, EdgeKind::Sidewalk, 0);
    w.b.buildings.push(kante_osm::buildings::BuildingRaw {
        outer: [(0.0, 0.0), (30.0, 0.0), (30.0, 20.0), (20.0, 20.0), (20.0, 8.0), (10.0, 8.0), (10.0, 20.0), (0.0, 20.0)].iter().map(|&(x, y)| pt(x, y)).collect(),
        holes: vec![],
    });
    w.door(0, 25.0, 20.0, DoorKind::Main, DOOR_WC_YES);
    let (r, ix) = w.finish();
    let here = place(&r, &ix, 5.0, 15.0, &STEP_FREE);
    let door = here.joins.iter().find(|j| j.door.is_some()).expect("its door");
    assert!(door.wall && door.doubt == 2, "{door:?}");
}

#[test]
fn a_line_inside_to_the_door_through_a_jog_in_its_wall_is_through_a_wall() {
    // the audit (seed 2, St. Gallen): the line from the point to its building's door crosses a notch in the wall,
    // half a metre outside it at most
    let mut w = World::new();
    w.way((-10.0, -5.0), (40.0, -5.0), 5, EdgeKind::Sidewalk, 0);
    w.b.buildings.push(kante_osm::buildings::BuildingRaw {
        outer: [(0.0, 0.0), (8.0, 0.0), (8.0, 2.0), (9.0, 2.0), (9.0, 0.0), (20.0, 0.0), (20.0, 16.0), (0.0, 16.0)].iter().map(|&(x, y)| pt(x, y)).collect(),
        holes: vec![],
    });
    w.door(0, 10.0, 0.0, DoorKind::Main, DOOR_WC_YES);
    let (r, ix) = w.finish();
    let here = place(&r, &ix, 6.0, 3.0, &NORMAL);
    let door = here.joins.iter().find(|j| j.door.is_some()).expect("its door");
    assert!(door.wall && door.doubt == 2, "{door:?}");
}
