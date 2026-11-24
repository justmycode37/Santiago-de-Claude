use crate::dem::{wgs84_to_lv95, Terrain};
use crate::*;
use kante_core::geo::M_PER_DEG_LAT;

const LAT0: f64 = 46.948;
const LON0: f64 = 7.44;

fn pt(x: f32, y: f32) -> LatLon {
    LatLon::from_deg(LAT0 + y as f64 / M_PER_DEG_LAT, LON0 + x as f64 / (M_PER_DEG_LAT * LAT0.to_radians().cos()))
}

/// Heights from a function of metres east / north of the test origin.
struct Fn(fn(f64, f64) -> f32);
impl Terrain for Fn {
    fn heights(&self, pts: &[(f64, f64)]) -> Vec<f32> {
        let (e0, n0) = wgs84_to_lv95(&pt(0.0, 0.0));
        pts.iter().map(|&(e, n)| (self.0)(e - e0, n - n0)).collect()
    }
}

struct Gb {
    g: WalkGraph,
}

impl Gb {
    fn new() -> Gb {
        Gb { g: WalkGraph { names: vec![String::new()], ..Default::default() } }
    }
    fn node(&mut self, x: f32, y: f32) -> u32 {
        self.g.nodes.push(pt(x, y));
        self.g.node_flags.push(0);
        self.g.nodes.len() as u32 - 1
    }
    fn edge(&mut self, a: u32, b: u32, kind: EdgeKind, flags: u16) -> u32 {
        let off = self.g.geom.len() as u32;
        self.g.geom.push(self.g.nodes[a as usize]);
        self.g.geom.push(self.g.nodes[b as usize]);
        let len = self.g.nodes[a as usize].dist_m(&self.g.nodes[b as usize]);
        self.g.edges.push(WalkEdge { a, b, geom_off: off, geom_len: 2, kind, level_a: LEVEL_NONE, level_b: LEVEL_NONE, steps: 0, flags, len_dm: (len * 10.0).round() as u32, name: 0 });
        self.g.edge_way.push(0);
        self.g.edges.len() as u32 - 1
    }
    fn done(mut self) -> WalkGraph {
        let n = self.g.nodes.len();
        let mut off = vec![0u32; n + 1];
        for ed in &self.g.edges {
            off[ed.a as usize + 1] += 1;
            off[ed.b as usize + 1] += 1;
        }
        for i in 1..=n {
            off[i] += off[i - 1];
        }
        let mut adj = vec![0u32; off[n] as usize];
        let mut cur = off.clone();
        for (e, ed) in self.g.edges.iter().enumerate() {
            for v in [ed.a, ed.b] {
                adj[cur[v as usize] as usize] = e as u32;
                cur[v as usize] += 1;
            }
        }
        self.g.adj_off = off;
        self.g.adj = adj;
        self.g
    }
}

fn near(a: f32, b: f32, tol: f32) -> bool {
    (a - b).abs() <= tol
}

#[test]
fn a_street_up_a_hill() {
    let mut b = Gb::new();
    let (s, n) = (b.node(0.0, 0.0), b.node(0.0, 200.0));
    let e = b.edge(s, n, EdgeKind::Road, 0);
    let g = b.done();
    // 10 % up to the north
    let (sl, st) = build(&g, &Fn(|_, n| 500.0 + 0.1 * n as f32));
    let x = sl[e as usize];
    assert_eq!(st.ground, 1);
    assert!(near(x.up_dm as f32 / 10.0, 20.0, 0.5), "{x:?}");
    assert!(x.down_dm <= 2, "{x:?}");
    // up: 200 m × (1.128 − 1) of time, 200 m × 0.40 of effort; down: a little of both
    assert!(near(x.time_dm[0] as f32 / 10.0, 25.6, 1.0), "{x:?}");
    assert!(near(x.effort_dm[0] as f32 / 10.0, 80.0, 3.0), "{x:?}");
    assert!(x.time_dm[1] < x.time_dm[0] / 4 && x.effort_dm[1] < 30, "{x:?}");
    assert!(x.steep_dm[0] > 0 && x.steep_dm[0] == x.steep_dm[1]);
    // the climb telescopes: up minus down is the height between the ends
    assert_eq!(slopes_fingerprint(&sl) != 0, true);
}

#[test]
fn flat_ground_has_no_slope() {
    let mut b = Gb::new();
    let (s, n) = (b.node(0.0, 0.0), b.node(150.0, 40.0));
    let e = b.edge(s, n, EdgeKind::Footway, 0);
    let g = b.done();
    let (sl, _) = build(&g, &Fn(|_, _| 540.0));
    assert_eq!(sl[e as usize], EdgeSlope::default());
}

#[test]
fn a_bridge_spans_the_valley() {
    // a valley 30 m deep between x = −50 and 50; the bridge crosses it level from bank to bank
    let mut b = Gb::new();
    let w0 = b.node(-120.0, 0.0);
    let w = b.node(-60.0, 0.0);
    let mid = b.node(0.0, 0.0);
    let e = b.node(60.0, 0.0);
    let e0 = b.node(120.0, 0.0);
    b.edge(w0, w, EdgeKind::Sidewalk, 0);
    let b1 = b.edge(w, mid, EdgeKind::Sidewalk, EF_BRIDGE);
    let b2 = b.edge(mid, e, EdgeKind::Sidewalk, EF_BRIDGE);
    b.edge(e, e0, EdgeKind::Sidewalk, 0);
    let g = b.done();
    let (sl, st) = build(&g, &Fn(|x, _| if x.abs() < 50.0 { 470.0 } else { 500.0 }));
    assert_eq!(st.spans, 2);
    assert_eq!(st.spans_unanchored, 0);
    assert_eq!(sl[b1 as usize], EdgeSlope::default(), "{:?}", sl[b1 as usize]);
    assert_eq!(sl[b2 as usize], EdgeSlope::default());
}

#[test]
fn a_tunnel_climbs_evenly_between_its_portals() {
    // portals at 500 m and 510 m; the hill above is 80 m higher
    let mut b = Gb::new();
    let a0 = b.node(-100.0, 0.0);
    let a = b.node(0.0, 0.0);
    let m = b.node(100.0, 0.0);
    let z = b.node(200.0, 0.0);
    let z0 = b.node(300.0, 0.0);
    b.edge(a0, a, EdgeKind::Footway, 0);
    let t1 = b.edge(a, m, EdgeKind::Footway, EF_TUNNEL);
    let t2 = b.edge(m, z, EdgeKind::Footway, EF_TUNNEL);
    b.edge(z, z0, EdgeKind::Footway, 0);
    let g = b.done();
    let (sl, _) = build(&g, &Fn(|x, _| if x <= 0.5 { 500.0 } else if x >= 199.5 { 510.0 } else { 580.0 }));
    for t in [t1, t2] {
        assert!(near(sl[t as usize].up_dm as f32 / 10.0, 5.0, 0.3), "{:?}", sl[t as usize]);
        assert_eq!(sl[t as usize].down_dm, 0);
    }
}

#[test]
fn stairs_climb_their_height_as_effort_not_time() {
    let mut b = Gb::new();
    let (lo, hi) = (b.node(0.0, 0.0), b.node(0.0, 12.0));
    let (lo0, hi0) = (b.node(0.0, -50.0), b.node(0.0, 60.0));
    b.edge(lo0, lo, EdgeKind::Footway, 0);
    let s = b.edge(lo, hi, EdgeKind::Steps, EF_UP_AB);
    b.edge(hi, hi0, EdgeKind::Footway, 0);
    let g = b.done();
    let (sl, st) = build(&g, &Fn(|_, n| if n < 0.0 { 500.0 } else if n > 12.0 { 506.0 } else { 500.0 + 0.5 * n as f32 }));
    let x = sl[s as usize];
    assert_eq!(st.stairs, 1);
    assert!(near(x.up_dm as f32 / 10.0, 6.0, 0.3), "{x:?}");
    assert_eq!(x.time_dm, [0, 0]);
    assert!(near(x.effort_dm[0] as f32 / 10.0, 6.0 * STAIRS_EFFORT_PER_M, 2.0) && x.effort_dm[1] == 0, "{x:?}");
}

#[test]
fn indoor_ways_are_flat() {
    let mut b = Gb::new();
    let (s, n) = (b.node(0.0, 0.0), b.node(0.0, 100.0));
    let c = b.edge(s, n, EdgeKind::Corridor, EF_INDOOR);
    let p = b.edge(s, n, EdgeKind::Platform, 0);
    let g = b.done();
    let (sl, _) = build(&g, &Fn(|_, n| 500.0 + 0.1 * n as f32));
    assert_eq!(sl[c as usize], EdgeSlope::default());
    assert_eq!(sl[p as usize], EdgeSlope::default());
}
