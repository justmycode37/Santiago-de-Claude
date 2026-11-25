use crate::matcher::*;
use crate::net::*;
use kante_core::geo::LatLon;
use kante_core::{Mode, Precision};

fn stop(x: f32, y: f32, label: &'static str) -> (LatLon, &'static str) {
    (LatLon::from_xy(x, y), label)
}

fn run(net: &Net, mode: Mode, line: &str, stops: &[(LatLon, &'static str)]) -> Matched {
    let p = profile(mode).unwrap();
    let st: Vec<StopIn> = stops.iter().map(|(pos, l)| StopIn { pos: *pos, label: l, precision: Precision::Edge }).collect();
    let rel = pick_relation(net, &p, &norm_ref(line), &st).map(|r| r.0);
    let mut s = Scratch::new(net);
    match_pattern(net, &p, &mut s, &st, rel)
}

/// Largest distance of the path's points from the line y = `y` between x0 and x1.
fn off_line(m: &Matched, y: f32) -> f32 {
    m.pts.iter().map(|q| (q[1] - y).abs()).fold(0.0, f32::max)
}

const BOTH: u8 = F_FWD | F_BWD;

/// Two parallel tracks 4.5 m apart joined by crossovers; the line's relation runs on the lower one. A stop in
/// the middle that is a little nearer the upper track does not move the train there.
#[test]
fn stays_on_its_own_track_when_one_stop_is_nearer_another() {
    let (ox, oy) = (1000.0, 1000.0);
    let pts = vec![
        [ox, oy],
        [ox + 1000.0, oy],
        [ox + 2000.0, oy],
        [ox + 3000.0, oy],
        [ox, oy + 4.5],
        [ox + 1000.0, oy + 4.5],
        [ox + 2000.0, oy + 4.5],
        [ox + 3000.0, oy + 4.5],
    ];
    let ways = vec![
        (RAIL, BOTH, "", vec![0, 1, 2, 3]),
        (RAIL, BOTH, "", vec![4, 5, 6, 7]),
        (RAIL, BOTH, "", vec![1, 6]), // a crossover
        (RAIL, BOTH, "", vec![5, 2]),
    ];
    let net = from_parts(&pts, &ways, &[(RK_TRAIN, "S1", vec![0])]);
    let m = run(&net, Mode::Rail, "S1", &[stop(ox + 100.0, oy - 3.0, ""), stop(ox + 1500.0, oy + 2.6, ""), stop(ox + 2900.0, oy - 3.0, "")]);
    assert_eq!(m.hops, vec![HOP_LINE, HOP_LINE], "{:?} {:?} rel {}", m.pts, m.at, m.relation);
    assert!(off_line(&m, oy) < 0.01, "{:?}", m.pts);
}

/// A train cannot take a switch from one branch into the other: from branch A to branch B it has to go on past
/// the switch and turn back at a stop (there is one on the stem); without that stop there is no way.
#[test]
fn no_kink_through_a_switch() {
    let (ox, oy) = (1000.0, 1000.0);
    // stem from (0,0) to (1000,0); branch A to (2000, 100), branch B to (2000, -100)
    let pts = vec![[ox, oy], [ox + 1000.0, oy], [ox + 2000.0, oy + 100.0], [ox + 2000.0, oy - 100.0]];
    let ways = vec![(RAIL, BOTH, "", vec![0, 1]), (RAIL, BOTH, "", vec![1, 2]), (RAIL, BOTH, "", vec![1, 3])];
    let net = from_parts(&pts, &ways, &[]);
    let a = stop(ox + 1900.0, oy + 95.0, "");
    let b = stop(ox + 1900.0, oy - 95.0, "");
    let m = run(&net, Mode::Rail, "", &[a, b]);
    assert_eq!(m.hops, vec![HOP_STRAIGHT], "no way from branch to branch: a straight line, not a kink");
    let m = run(&net, Mode::Rail, "", &[a, stop(ox + 300.0, oy + 3.0, ""), b]);
    assert_eq!(m.hops, vec![HOP_NET, HOP_NET], "turning back at the stop on the stem");
    assert!(m.pts.iter().any(|q| q[0] < ox + 400.0));
}

/// A one-way street pair: the bus drives each street its own way and stays on the one its stops are on.
#[test]
fn buses_keep_to_one_way_streets() {
    let (ox, oy) = (1000.0, 1000.0);
    // eastbound street y = 0, westbound street y = 30, joined at both ends
    let pts = vec![[ox, oy], [ox + 500.0, oy], [ox + 1000.0, oy], [ox, oy + 30.0], [ox + 500.0, oy + 30.0], [ox + 1000.0, oy + 30.0]];
    // one-way as the importer reads `oneway=yes` (against it allowed, at a cost: contraflow lanes are not always mapped)
    let fwd_only = classify([("highway", "secondary"), ("oneway", "yes")].into_iter(), 0).0[0].1;
    assert_eq!(fwd_only, F_FWD | F_BWD | F_BWD_WRONG);
    let ways = vec![
        (SECONDARY, fwd_only, "", vec![0, 1, 2]),
        (SECONDARY, fwd_only, "", vec![5, 4, 3]),
        (SECONDARY, BOTH, "", vec![0, 3]),
        (SECONDARY, BOTH, "", vec![2, 5]),
    ];
    let net = from_parts(&pts, &ways, &[]);
    // eastwards: stops by the lower street (the middle one a little nearer the upper one would not change it)
    let m = run(&net, Mode::Bus, "", &[stop(ox + 50.0, oy - 5.0, ""), stop(ox + 500.0, oy + 16.0, ""), stop(ox + 950.0, oy - 5.0, "")]);
    assert!(off_line(&m, oy) < 0.01, "eastwards on the eastbound street: {:?}", m.pts);
    // westwards
    let m = run(&net, Mode::Bus, "", &[stop(ox + 950.0, oy + 35.0, ""), stop(ox + 50.0, oy + 35.0, "")]);
    assert!(m.pts.iter().all(|q| (q[1] - (oy + 30.0)).abs() < 0.01), "westwards on the westbound street: {:?}", m.pts);
    // westwards with its stops by the eastbound street: round by the westbound one, not 900 m against the one-way
    let m = run(&net, Mode::Bus, "", &[stop(ox + 950.0, oy - 5.0, ""), stop(ox + 50.0, oy - 5.0, "")]);
    assert!(m.pts.iter().any(|q| (q[1] - (oy + 30.0)).abs() < 0.01), "round by the westbound street: {:?}", m.pts);
}

/// In a station with four parallel tracks, the stop's platform number picks the track.
#[test]
fn the_platform_number_picks_the_track() {
    let (ox, oy) = (1000.0, 1000.0);
    let mut pts = Vec::new();
    let mut ways = Vec::new();
    for (k, tr) in ["1", "2", "3", "4"].iter().enumerate() {
        let y = oy + k as f32 * 5.0;
        pts.push([ox, y]);
        pts.push([ox + 2000.0, y]);
        ways.push((RAIL, BOTH, *tr, vec![2 * k, 2 * k + 1]));
    }
    let net = from_parts(&pts, &ways, &[]);
    // the platform between tracks 3 and 4, nearer 4
    let m = run(&net, Mode::Rail, "", &[stop(ox + 500.0, oy + 13.0, "3"), stop(ox + 1500.0, oy + 13.0, "3")]);
    assert!(off_line(&m, oy + 10.0) < 0.01, "on track 3: {:?}", m.pts);
}

/// Two relations with the same line number, one per direction: the pattern takes the one that passes its stops
/// in order.
#[test]
fn the_relation_in_the_pattern_s_direction() {
    let (ox, oy) = (1000.0, 1000.0);
    // a street loop: outbound on y = 0 (one-way east), back on y = 40 (one-way west)
    let pts = vec![[ox, oy], [ox + 400.0, oy], [ox + 800.0, oy], [ox + 800.0, oy + 40.0], [ox + 400.0, oy + 40.0], [ox, oy + 40.0]];
    let ways = vec![
        (TERTIARY, F_FWD, "", vec![0, 1]),
        (TERTIARY, F_FWD, "", vec![1, 2]),
        (TERTIARY, BOTH, "", vec![2, 3]),
        (TERTIARY, F_FWD, "", vec![3, 4]),
        (TERTIARY, F_FWD, "", vec![4, 5]),
        (TERTIARY, BOTH, "", vec![5, 0]),
    ];
    let net = from_parts(&pts, &ways, &[(RK_BUS, "7", vec![0, 1, 2]), (RK_BUS, "7", vec![3, 4, 5])]);
    let p = profile(Mode::Bus).unwrap();
    let st = |x: f32, y: f32| StopIn { pos: LatLon::from_xy(x, y), label: "", precision: Precision::Edge };
    let out = [st(ox + 100.0, oy - 4.0), st(ox + 400.0, oy - 4.0), st(ox + 700.0, oy - 4.0)];
    assert_eq!(pick_relation(&net, &p, "7", &out).map(|r| r.0), Some(0));
    let back = [st(ox + 700.0, oy + 44.0), st(ox + 400.0, oy + 44.0), st(ox + 100.0, oy + 44.0)];
    assert_eq!(pick_relation(&net, &p, "7", &back).map(|r| r.0), Some(1));
    assert_eq!(pick_relation(&net, &p, "8", &back), None, "another line number");
    // a two-stop pattern against a relation drawn once: both stops passed, backwards
    let net1 = from_parts(&pts, &ways, &[(RK_BUS, "9", vec![0, 1, 2])]);
    assert_eq!(pick_relation(&net1, &p, "9", &[st(ox + 700.0, oy - 4.0), st(ox + 100.0, oy - 4.0)]).map(|r| r.1), Some(2));
}

/// A stop far from every way (outside the map) makes only its own hops straight.
#[test]
fn a_stop_off_the_map_only_breaks_its_own_hops() {
    let (ox, oy) = (1000.0, 1000.0);
    let pts = vec![[ox, oy], [ox + 3000.0, oy]];
    let net = from_parts(&pts, &[(RAIL, BOTH, "", vec![0, 1])], &[]);
    let m = run(
        &net,
        Mode::Rail,
        "",
        &[stop(ox + 100.0, oy, ""), stop(ox + 1000.0, oy, ""), stop(ox + 2000.0, oy + 3000.0, ""), stop(ox + 2900.0, oy, ""), stop(ox + 2950.0, oy, "")],
    );
    assert_eq!(m.hops, vec![HOP_NET, HOP_STRAIGHT, HOP_STRAIGHT, HOP_NET]);
    assert_eq!(m.at.len(), 5);
}

#[test]
fn refs_and_tracks_compare_loosely() {
    assert_eq!(norm_ref("IC 1"), norm_ref("ic1"));
    assert_eq!(norm_ref("S 3"), "S3");
    assert_eq!(norm_track("07"), "7");
    assert_eq!(norm_track("3a"), "3A");
    assert_eq!(norm_track("0"), "0");
}

#[test]
fn polyline_encoding() {
    // Google's example: (38.5, -120.2), (40.7, -120.95), (43.252, -126.453)
    let pts = [LatLon::from_deg(38.5, -120.2), LatLon::from_deg(40.7, -120.95), LatLon::from_deg(43.252, -126.453)];
    assert_eq!(crate::encode(pts), "_p~iF~ps|U_ulLnnqC_mqNvxq`@");
}

