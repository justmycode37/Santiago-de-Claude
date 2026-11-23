//! Through the functions a request goes through: [`End::place`] (with [`point_candidates`]), [`reach_costs`], [`walk`] / [`walk_within`]
//! and [`draw`].

use super::*;
use crate::test_world::*;

fn place(r: &WalkRouter, ix: &DoorIndex, x: f32, y: f32, p: &WalkProfile) -> End {
    End::place(r, Some(ix), pt(x, y), p)
}
fn stop(r: &WalkRouter, x: f32, y: f32, p: &WalkProfile) -> End {
    End::stop(pt(x, y), Some(snap(r, x, y, p)), false)
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
    let station = End::station(&r, pt(-5.0, 0.0), &STEP_FREE);
    assert!(station.joins.len() >= 2, "{:?}", station.joins);
    let to = stop(&r, 30.0, 1.4, &STEP_FREE);
    let (c, w1, _) = reach_and_walk(&r, &ix, &station, &to, &STEP_FREE, 600.0);
    assert!(c.is_some() && w1.path.stairs_up == 0 && w1.path.stairs_down == 0, "{c:?}");
}
