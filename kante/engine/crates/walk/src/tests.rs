//! Unit tests on small graphs built in code.

use crate::*;
use kante_core::geo::M_PER_DEG_LAT;

const LAT0: f64 = 46.948;
const LON0: f64 = 7.44;

/// Synthetic graph builder; coordinates are metres east / north of a point in Bern.
pub(crate) struct Gb {
    pub g: WalkGraph,
}

pub(crate) fn pt(x: f32, y: f32) -> LatLon {
    LatLon::from_deg(LAT0 + y as f64 / M_PER_DEG_LAT, LON0 + x as f64 / (M_PER_DEG_LAT * LAT0.to_radians().cos()))
}

impl Gb {
    pub fn new() -> Gb {
        let mut g = WalkGraph::default();
        g.names.push(String::new());
        Gb { g }
    }
    pub fn node(&mut self, x: f32, y: f32) -> u32 {
        self.g.nodes.push(pt(x, y));
        self.g.node_flags.push(0);
        self.g.nodes.len() as u32 - 1
    }
    pub fn nflag(&mut self, n: u32, f: u8) {
        self.g.node_flags[n as usize] |= f;
    }
    pub fn edge(&mut self, a: u32, b: u32, kind: EdgeKind) -> u32 {
        self.edge_via(a, b, kind, &[])
    }
    pub fn edge_via(&mut self, a: u32, b: u32, kind: EdgeKind, via: &[(f32, f32)]) -> u32 {
        let off = self.g.geom.len() as u32;
        self.g.geom.push(self.g.nodes[a as usize]);
        for &(x, y) in via {
            self.g.geom.push(pt(x, y));
        }
        self.g.geom.push(self.g.nodes[b as usize]);
        let pts = &self.g.geom[off as usize..];
        let len: f32 = pts.windows(2).map(|w| w[0].dist_m(&w[1])).sum();
        self.g.edges.push(WalkEdge {
            a,
            b,
            geom_off: off,
            geom_len: pts.len() as u16,
            kind,
            level_a: LEVEL_NONE,
            level_b: LEVEL_NONE,
            steps: 0,
            flags: 0,
            len_dm: (len * 10.0).round() as u32,
            name: 0,
        });
        self.g.edge_way.push(0);
        self.g.edges.len() as u32 - 1
    }
    pub fn e(&mut self, e: u32) -> &mut WalkEdge {
        &mut self.g.edges[e as usize]
    }
    pub fn lv(&mut self, e: u32, a: Level2, b: Level2) -> u32 {
        self.e(e).level_a = a;
        self.e(e).level_b = b;
        e
    }
    pub fn fl(&mut self, e: u32, f: u16) -> u32 {
        self.e(e).flags |= f;
        e
    }
    pub fn name(&mut self, e: u32, s: &str) -> u32 {
        let i = match self.g.names.iter().position(|n| n == s) {
            Some(i) => i,
            None => {
                self.g.names.push(s.to_string());
                self.g.names.len() - 1
            }
        };
        self.e(e).name = i as u32;
        e
    }
    pub fn way(&mut self, e: u32, id: i64) -> u32 {
        self.g.edge_way[e as usize] = id;
        e
    }
    pub fn build(mut self) -> WalkRouter {
        let n = self.g.nodes.len();
        let mut off = vec![0u32; n + 1];
        for ed in &self.g.edges {
            off[ed.a as usize + 1] += 1;
            if ed.b != ed.a {
                off[ed.b as usize + 1] += 1;
            }
        }
        for i in 1..=n {
            off[i] += off[i - 1];
        }
        let mut adj = vec![0u32; off[n] as usize];
        let mut cur = off.clone();
        for (e, ed) in self.g.edges.iter().enumerate() {
            adj[cur[ed.a as usize] as usize] = e as u32;
            cur[ed.a as usize] += 1;
            if ed.b != ed.a {
                adj[cur[ed.b as usize] as usize] = e as u32;
                cur[ed.b as usize] += 1;
            }
        }
        self.g.adj_off = off;
        self.g.adj = adj;
        WalkRouter::new(Arc::new(self.g))
    }
}

fn on(e: u32, frac: f32, r: &WalkRouter) -> Snap {
    let pts = r.graph().edge_geom(e);
    // Only used on straight two-point edges.
    Snap { edge: e, frac, pos: pts[0].lerp(&pts[pts.len() - 1], frac), dist_m: 0.0 }
}

const NORMAL: WalkProfile = WalkProfile::normal(1.3);
const STEP_FREE: WalkProfile = WalkProfile::step_free(1.3);
fn avoid() -> WalkProfile {
    WalkProfile { stairs: StairsPref::Avoid, ..NORMAL }
}
fn close(a: f32, b: f32, tol: f32) -> bool {
    (a - b).abs() <= tol
}
fn texts(p: &WalkPath) -> Vec<&str> {
    p.steps.iter().map(|s| s.text.as_str()).collect()
}
fn kinds(p: &WalkPath) -> Vec<StepKind> {
    p.steps.iter().map(|s| s.kind).collect()
}

// ---------------------------------------------------------------- snapping

#[test]
fn snap_projects_onto_polyline() {
    let mut b = Gb::new();
    let (n0, n1, n2) = (b.node(0.0, 0.0), b.node(100.0, 0.0), b.node(100.0, 50.0));
    // L-shaped edge: 100 m east then 50 m north.
    let e = b.edge_via(n0, n2, EdgeKind::Footway, &[(100.0, 0.0)]);
    let far = b.edge(n0, n1, EdgeKind::Footway);
    let _ = far;
    let r = b.build();
    let s = r.snap(pt(104.0, 25.0), &SnapOptions::default()).unwrap();
    assert_eq!(s.edge, e);
    assert!(close(s.dist_m, 4.0, 0.05), "{}", s.dist_m);
    assert!(close(s.frac, 125.0 / 150.0, 0.002), "{}", s.frac);
    assert!(s.pos.dist_m(&pt(100.0, 25.0)) < 0.05);
    // Too far away.
    assert!(r.snap(pt(50.0, 80.0), &SnapOptions { max_dist_m: 20.0, ..Default::default() }).is_none());
    // Outside the grid entirely but within reach.
    let s = r.snap(pt(-30.0, -5.0), &SnapOptions::default()).unwrap();
    assert!(close(s.dist_m, (30f32 * 30.0 + 25.0).sqrt(), 0.1) && s.frac == 0.0);
    assert!(r.snap(pt(-3000.0, -5.0), &SnapOptions::default()).is_none());
}

#[test]
fn snap_filters_level_kind_profile() {
    let mut b = Gb::new();
    // Three parallel 40 m edges 2 m apart: street level (no level), level -1, steps spanning -1..0.
    let mk = |b: &mut Gb, y: f32, kind| {
        let (p, q) = (b.node(0.0, y), b.node(40.0, y));
        b.edge(p, q, kind)
    };
    let street = mk(&mut b, 0.0, EdgeKind::Sidewalk);
    let under = mk(&mut b, 2.0, EdgeKind::Corridor);
    b.lv(under, -2, -2);
    let steps = mk(&mut b, 4.0, EdgeKind::Steps);
    b.lv(steps, -2, 0);
    let r = b.build();
    let p = pt(20.0, 2.2);
    let o = SnapOptions::default();
    assert_eq!(r.snap(p, &o).unwrap().edge, under);
    // Level 0: the unlevelled street and the steps qualify, the street is nearer.
    assert_eq!(r.snap(p, &SnapOptions { level: Some(0), ..o }).unwrap().edge, steps);
    assert_eq!(r.snap(pt(20.0, 0.5), &SnapOptions { level: Some(0), ..o }).unwrap().edge, street);
    // Level -1: corridor or steps, never the street.
    assert_eq!(r.snap(pt(20.0, 0.1), &SnapOptions { level: Some(-2), ..o }).unwrap().edge, under);
    assert!(r.snap(p, &SnapOptions { level: Some(4), ..o }).is_none());
    // Step-free walkers are not put on stairs; kinds can be excluded.
    assert_eq!(r.snap(pt(20.0, 4.0), &SnapOptions { profile: Some(STEP_FREE), ..o }).unwrap().edge, under);
    assert_eq!(r.snap(p, &SnapOptions { exclude_kinds: 1 << EdgeKind::Corridor as u8, ..o }).unwrap().edge, steps);
    // Candidates: distinct edges, nearest first.
    let c = r.snap_candidates(p, &o, 5);
    assert_eq!(c.iter().map(|s| s.edge).collect::<Vec<_>>(), vec![under, steps, street]);
    assert!(c.windows(2).all(|w| w[0].dist_m <= w[1].dist_m));
    assert_eq!(r.snap_candidates(p, &o, 2).len(), 2);
}

/// Deterministic pseudo-random numbers for the randomised tests.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 40) as f32 / (1u64 << 24) as f32
    }
}

/// A jittered grid of mixed edge kinds with two floors joined by stairs,
/// escalators and lifts.
fn random_city(seed: u64, w: usize, h: usize) -> WalkRouter {
    let mut rng = Rng(seed);
    let mut b = Gb::new();
    let mut ids = vec![vec![0u32; w]; h];
    for (y, row) in ids.iter_mut().enumerate() {
        for (x, id) in row.iter_mut().enumerate() {
            *id = b.node(x as f32 * 40.0 + rng.next() * 15.0, y as f32 * 40.0 + rng.next() * 15.0);
        }
    }
    let kinds = [EdgeKind::Footway, EdgeKind::Sidewalk, EdgeKind::Road, EdgeKind::RoadBusy, EdgeKind::Pedestrian, EdgeKind::Path, EdgeKind::Crossing, EdgeKind::Steps];
    let mut way = 1i64;
    for y in 0..h {
        for x in 0..w {
            for (dx, dy) in [(1usize, 0usize), (0, 1)] {
                if x + dx >= w || y + dy >= h || rng.next() < 0.12 {
                    continue;
                }
                let kind = kinds[(rng.next() * 12.0) as usize % kinds.len()];
                let (a, c) = (ids[y][x], ids[y + dy][x + dx]);
                let pa = (x as f32 * 40.0 + 20.0 * dx as f32 + rng.next() * 6.0, y as f32 * 40.0 + 20.0 * dy as f32 + rng.next() * 6.0);
                let e = b.edge_via(a, c, kind, &[pa]);
                b.way(e, way);
                way += 1;
                if kind == EdgeKind::Crossing && rng.next() < 0.5 {
                    b.fl(e, EF_SIGNALS);
                }
                if kind == EdgeKind::Steps {
                    b.e(e).steps = 12;
                    if rng.next() < 0.3 {
                        b.fl(e, EF_RAMP);
                    }
                }
                if rng.next() < 0.1 {
                    b.fl(e, EF_ROUGH);
                }
            }
        }
    }
    // A basement corridor under row 1, reached by a lift node, lift edges and a one-way escalator.
    let y = 1usize;
    let mut prev = None;
    for x in 0..w {
        let n = b.node(x as f32 * 40.0 + 3.0, y as f32 * 40.0 - 6.0);
        if let Some(p) = prev {
            let e = b.edge(p, n, EdgeKind::Corridor);
            b.lv(e, -2, -2);
            b.fl(e, EF_INDOOR);
        }
        match x % 4 {
            0 => {
                // lift node between the street node and the basement
                let l = b.node(x as f32 * 40.0 + 1.0, y as f32 * 40.0 - 3.0);
                b.nflag(l, NF_ELEVATOR);
                let e1 = b.edge(ids[y][x], l, EdgeKind::Footway);
                b.lv(e1, 0, 0);
                let e2 = b.edge(l, n, EdgeKind::Corridor);
                b.lv(e2, -2, -2);
            }
            1 => {
                let e = b.edge(ids[y][x], n, EdgeKind::Escalator);
                b.lv(e, 0, -2);
                b.fl(e, EF_ONEWAY_AB | EF_UP_BA);
            }
            2 => {
                let e = b.edge(ids[y][x], n, EdgeKind::Lift);
                b.lv(e, 0, -2);
            }
            _ => {
                let e = b.edge(ids[y][x], n, EdgeKind::Steps);
                b.lv(e, 0, -2);
                b.fl(e, EF_UP_BA);
                b.e(e).steps = 20;
            }
        }
        prev = Some(n);
    }
    b.build()
}

#[test]
fn snap_matches_brute_force() {
    let r = random_city(7, 14, 11);
    let g = r.graph().clone();
    let mut rng = Rng(99);
    for _ in 0..400 {
        let p = pt(rng.next() * 600.0 - 30.0, rng.next() * 480.0 - 30.0);
        let opts = SnapOptions { max_dist_m: 60.0, ..Default::default() };
        let got = r.snap(p, &opts);
        let mut best = f32::INFINITY;
        for e in 0..g.edges.len() as u32 {
            for w in g.edge_geom(e).windows(2) {
                let (_, d) = kante_core::geo::project_on_segment(&p, &w[0], &w[1]);
                best = best.min(d);
            }
        }
        match got {
            Some(s) => {
                assert!(close(s.dist_m, best, 0.02), "{} vs {}", s.dist_m, best);
                assert!(close(s.pos.dist_m(&p), s.dist_m, 0.03));
            }
            None => assert!(best > 60.0 - 0.02, "missed an edge at {best} m"),
        }
    }
}

#[test]
fn edges_in_box() {
    let r = random_city(3, 12, 9);
    let g = r.graph().clone();
    let mut rng = Rng(5);
    for _ in 0..60 {
        let (x, y) = (rng.next() * 400.0, rng.next() * 300.0);
        let (w, h) = (rng.next() * 150.0 + 1.0, rng.next() * 150.0 + 1.0);
        let (lo, hi) = (pt(x, y), pt(x + w, y + h));
        let bbox = BBox { min: lo, max: hi };
        let got = r.edges_in(&bbox);
        // Brute force with dense sampling along each edge.
        let mut want = Vec::new();
        for e in 0..g.edges.len() as u32 {
            let hit = g.edge_geom(e).windows(2).any(|s| (0..=200).any(|i| bbox.contains(&s[0].lerp(&s[1], i as f32 / 200.0))));
            if hit {
                want.push(e);
            }
        }
        for e in &want {
            assert!(got.contains(e), "edge {e} missing");
        }
        // Anything extra must at least come within a few centimetres of the box (sampling gaps).
        assert!(got.len() <= want.len() + 3, "{} vs {}", got.len(), want.len());
    }
    assert!(r.edges_in(&BBox { min: pt(5000.0, 5000.0), max: pt(5100.0, 5100.0) }).is_empty());
}

// ----------------------------------------------------------------- routing

#[test]
fn same_edge_and_speed_scaling() {
    let mut b = Gb::new();
    let (p, q, s) = (b.node(0.0, 0.0), b.node(100.0, 0.0), b.node(100.0, 30.0));
    let e = b.edge(p, q, EdgeKind::Footway);
    let st = b.edge(q, s, EdgeKind::Steps);
    b.e(st).steps = 40;
    let r = b.build();
    // Both ends on one edge, in both directions.
    for (f0, f1) in [(0.2, 0.7), (0.9, 0.25)] {
        let path = r.route(&on(e, f0, &r), &on(e, f1, &r), &NORMAL).unwrap();
        let d = 100.0 * (f1 - f0 as f32).abs();
        assert!(close(path.dist_m, d, 0.05) && close(path.cost.var_m, d, 0.05) && path.cost.fix_s == 0.0);
        assert_eq!(path.geometry.len(), 2);
        assert!(path.geometry[0].dist_m(&pt(100.0 * f0, 0.0)) < 0.05 && path.geometry[1].dist_m(&pt(100.0 * f1, 0.0)) < 0.05);
        assert_eq!(kinds(&path), vec![StepKind::Depart, StepKind::Walk, StepKind::Arrive]);
    }
    // Start = destination.
    let here = r.route(&on(e, 0.4, &r), &on(e, 0.4, &r), &NORMAL).unwrap();
    assert!(here.dist_m == 0.0 && here.cost.secs(1.3) == 0.0);
    assert_eq!(kinds(&here), vec![StepKind::Depart, StepKind::Arrive]);
    assert_eq!(r.one_to_many(&on(e, 0.4, &r), &[on(e, 0.4, &r)], &NORMAL, 0.0), vec![Some(WalkCost { var_m: 0.0, fix_s: 0.0 })]);
    // time = var / speed + fix, with stairs counted STAIRS_FACTOR times.
    for speed in [0.8f32, 1.3, 2.0] {
        let prof = WalkProfile::normal(speed);
        let path = r.route(&on(e, 0.5, &r), &on(st, 0.5, &r), &prof).unwrap();
        assert!(close(path.cost.var_m, 50.0 + 15.0 * STAIRS_FACTOR, 0.1), "{}", path.cost.var_m);
        assert!(close(path.cost.secs(speed), (50.0 + 15.0 * STAIRS_FACTOR) / speed, 0.1));
        assert!(close(path.dist_m, 65.0, 0.1));
        assert_eq!(path.stairs_up, 20);
        let m = r.one_to_many(&on(e, 0.5, &r), &[on(st, 0.5, &r), on(e, 0.1, &r)], &prof, 600.0);
        assert!(close(m[0].unwrap().var_m, path.cost.var_m, 0.01));
        assert!(close(m[1].unwrap().var_m, 40.0, 0.05));
    }
}

/// Upper hall (level 0) and lower hall (level -1), 10 m apart on the map,
/// joined by stairs, optionally a 60 m ramp and optionally a lift node.
struct Halls {
    r: WalkRouter,
    top: u32,
    bottom: u32,
}

fn halls(ramp: bool, lift: bool, stairs_ramp: bool) -> Halls {
    let mut b = Gb::new();
    let (a0, a1) = (b.node(-20.0, 0.0), b.node(0.0, 0.0));
    let (b0, b1) = (b.node(10.0, 0.0), b.node(30.0, 0.0));
    let top = b.edge(a0, a1, EdgeKind::Corridor);
    b.lv(top, 0, 0);
    let bottom = b.edge(b0, b1, EdgeKind::Corridor);
    b.lv(bottom, -2, -2);
    let st = b.edge(a1, b0, EdgeKind::Steps);
    b.lv(st, 0, -2);
    b.fl(st, EF_UP_BA);
    b.e(st).steps = 24;
    if stairs_ramp {
        b.fl(st, EF_RAMP);
    }
    if ramp {
        let e = b.edge_via(a1, b0, EdgeKind::Footway, &[(5.0, 29.6)]);
        b.lv(e, 0, -2);
    }
    if lift {
        let l = b.node(5.0, -5.0);
        b.nflag(l, NF_ELEVATOR);
        let e1 = b.edge(a1, l, EdgeKind::Corridor);
        b.lv(e1, 0, 0);
        let e2 = b.edge(l, b0, EdgeKind::Corridor);
        b.lv(e2, -2, -2);
    }
    Halls { r: b.build(), top, bottom }
}

#[test]
fn stairs_ramp_lift_choice() {
    let go = |h: &Halls, p: &WalkProfile| h.r.route(&on(h.top, 0.5, &h.r), &on(h.bottom, 0.5, &h.r), p);
    let h = halls(true, true, false);
    // Ok: straight down the stairs.
    let p = go(&h, &NORMAL).unwrap();
    assert!(kinds(&p).contains(&StepKind::StairsDown));
    assert!(close(p.cost.var_m, 20.0 + 10.0 * STAIRS_FACTOR, 0.2) && p.cost.fix_s == 0.0);
    assert_eq!((p.stairs_down, p.stairs_up, p.lifts), (24, 0, 0));
    // Avoid: the 60 m ramp beats the stairs (penalised) and the lift (50 s).
    let p = go(&h, &avoid()).unwrap();
    assert!(kinds(&p).contains(&StepKind::RampDown) && !kinds(&p).contains(&StepKind::StairsDown), "{:?}", texts(&p));
    assert!(close(p.cost.var_m, 80.0, 0.5) && p.cost.fix_s == 0.0);
    assert_eq!(p.stairs_down, 0);
    // Never: same.
    let p = go(&h, &STEP_FREE).unwrap();
    assert!(kinds(&p).contains(&StepKind::RampDown));

    // No ramp: Avoid and Never take the lift; the penalty is not in the cost.
    let h = halls(false, true, false);
    for prof in [avoid(), STEP_FREE] {
        let p = go(&h, &prof).unwrap();
        assert_eq!(p.lifts, 1, "{:?}", texts(&p));
        assert!(close(p.cost.fix_s, LIFT_S, 1e-3));
        assert!(close(p.cost.var_m, 20.0 + 2.0 * 50f32.sqrt(), 0.3), "{}", p.cost.var_m);
        assert!(texts(&p).contains(&"Take the lift down to level \u{2212}1"), "{:?}", texts(&p));
    }
    assert!(kinds(&go(&h, &NORMAL).unwrap()).contains(&StepKind::StairsDown));
    // Lifts switched off as well: Avoid still walks the stairs (real time reported), Never has no route.
    let no_lift = WalkProfile { lifts: false, ..avoid() };
    let p = go(&h, &no_lift).unwrap();
    assert!(close(p.cost.var_m, 20.0 + 10.0 * STAIRS_FACTOR, 0.2) && p.cost.fix_s == 0.0);
    assert!(go(&h, &WalkProfile { lifts: false, ..STEP_FREE }).is_none());
    let m = h.r.one_to_many(&on(h.top, 0.5, &h.r), &[on(h.bottom, 0.5, &h.r)], &WalkProfile { lifts: false, ..STEP_FREE }, 900.0);
    assert!(m[0].is_none());

    // Stairs with a ramp are usable step-free, as a ramp.
    let h = halls(false, false, true);
    let p = go(&h, &STEP_FREE).unwrap();
    assert_eq!(kinds(&p), vec![StepKind::Depart, StepKind::Walk, StepKind::RampDown, StepKind::Walk, StepKind::Arrive]);
    assert!(texts(&p)[2].contains("ramp beside the stairs down to level \u{2212}1"), "{:?}", texts(&p));
    assert_eq!(p.stairs_down, 0);
    assert!(close(p.cost.var_m, 20.0 + 10.0 * crate::net::RAMP_FACTOR, 0.2));
    assert!(kinds(&go(&h, &NORMAL).unwrap()).contains(&StepKind::StairsDown));
}

#[test]
fn one_way_escalator() {
    let mut b = Gb::new();
    let (a0, a1, b0, b1) = (b.node(-20.0, 0.0), b.node(0.0, 0.0), b.node(11.0, 0.0), b.node(30.0, 0.0));
    let top = b.edge(a0, a1, EdgeKind::Corridor);
    b.lv(top, 2, 2);
    let bottom = b.edge(b0, b1, EdgeKind::Corridor);
    b.lv(bottom, 0, 0);
    // Escalator running up only (b0 -> a1), and a long way round by stairs.
    let esc = b.edge(b0, a1, EdgeKind::Escalator);
    b.lv(esc, 0, 2);
    b.fl(esc, EF_ONEWAY_AB | EF_UP_AB);
    let st = b.edge_via(a1, b0, EdgeKind::Steps, &[(5.0, 20.0)]);
    b.lv(st, 2, 0);
    b.fl(st, EF_UP_BA);
    b.e(st).steps = 60;
    let r = b.build();
    let up = r.route(&on(bottom, 0.5, &r), &on(top, 0.5, &r), &NORMAL).unwrap();
    assert_eq!(up.escalators, 1);
    assert!(close(up.cost.fix_s, 11.0 / ESCALATOR_MPS, 0.05) && close(up.cost.var_m, 19.5, 0.1), "{:?}", up.cost);
    assert!(texts(&up).contains(&"Take the escalator up to level 1"), "{:?}", texts(&up));
    // Down: the escalator runs the wrong way.
    let down = r.route(&on(top, 0.5, &r), &on(bottom, 0.5, &r), &NORMAL).unwrap();
    assert_eq!((down.escalators, down.stairs_down), (0, 60));
    assert!(kinds(&down).contains(&StepKind::StairsDown));
    // Starting on the escalator itself one can only ride on.
    let mid = r.route(&on(esc, 0.5, &r), &on(bottom, 0.5, &r), &NORMAL).unwrap();
    assert!(mid.escalators == 1 && mid.stairs_down == 60);
    // No escalators allowed: stairs up.
    let p = r.route(&on(bottom, 0.5, &r), &on(top, 0.5, &r), &WalkProfile { escalators: false, ..NORMAL }).unwrap();
    assert_eq!((p.escalators, p.stairs_up), (0, 60));
}

#[test]
fn lift_charged_once() {
    // (a) Elevator node serving three floors; a corridor passes it on level 0.
    let mut b = Gb::new();
    let l = b.node(0.0, 0.0);
    b.nflag(l, NF_ELEVATOR);
    let arm = |b: &mut Gb, x: f32, y: f32, lv: Level2| {
        let n = b.node(x, y);
        let e = b.edge(l, n, EdgeKind::Corridor);
        b.lv(e, lv, lv)
    };
    let west0 = arm(&mut b, -20.0, 0.0, 0);
    let east0 = arm(&mut b, 20.0, 0.0, 0);
    let north2 = arm(&mut b, 0.0, 20.0, 4);
    let south_m1 = arm(&mut b, 0.0, -20.0, -2);
    let r = b.build();
    let p = r.route(&on(west0, 0.5, &r), &on(east0, 0.5, &r), &NORMAL).unwrap();
    assert!(p.lifts == 0 && p.cost.fix_s == 0.0 && close(p.cost.var_m, 20.0, 0.1), "walking past a lift is free");
    let p = r.route(&on(south_m1, 0.5, &r), &on(north2, 0.5, &r), &NORMAL).unwrap();
    assert_eq!(p.lifts, 1);
    assert!(close(p.cost.fix_s, LIFT_S, 1e-3) && close(p.cost.var_m, 20.0, 0.1));
    assert_eq!(texts(&p), vec!["Start on level \u{2212}1, heading north", "Walk 10 m", "Take the lift up to level 2", "Walk 10 m", "Arrive at your destination on level 2"]);
    // Geometry: the lift position twice, once per level.
    assert_eq!(p.levels, vec![-2, -2, 4, 4]);
    assert_eq!(p.geometry[1], p.geometry[2]);
    let lift = p.steps.iter().find(|s| s.kind == StepKind::Lift).unwrap();
    assert_eq!((lift.from, lift.to, lift.level, lift.to_level), (1, 2, -2, 4));
    assert!(r.route(&on(south_m1, 0.5, &r), &on(north2, 0.5, &r), &WalkProfile { lifts: false, ..NORMAL }).is_none());
    let m = r.one_to_many(&on(south_m1, 0.5, &r), &[on(north2, 0.5, &r), on(west0, 0.5, &r)], &NORMAL, 300.0);
    assert!(close(m[0].unwrap().fix_s, LIFT_S, 1e-3) && close(m[1].unwrap().fix_s, LIFT_S, 1e-3));

    // (b) Shaft made of lift edges: door -1 — car — door 0 — and on to door 2 through a second edge chain.
    let mut b = Gb::new();
    let (d_m1, mid, d0, d2) = (b.node(0.0, 0.0), b.node(1.0, 0.0), b.node(2.0, 0.0), b.node(2.0, 1.0));
    let s1 = b.edge(d_m1, mid, EdgeKind::Lift);
    b.lv(s1, -2, 0);
    let s2 = b.edge(mid, d0, EdgeKind::Lift);
    b.lv(s2, 0, 0);
    let s3 = b.edge(mid, d2, EdgeKind::Lift);
    b.lv(s3, 0, 4);
    let (x_m1, x0, x2) = (b.node(-30.0, 0.0), b.node(32.0, 0.0), b.node(2.0, 31.0));
    let c_m1 = b.edge(x_m1, d_m1, EdgeKind::Corridor);
    b.lv(c_m1, -2, -2);
    let c0 = b.edge(d0, x0, EdgeKind::Corridor);
    b.lv(c0, 0, 0);
    let c2 = b.edge(d2, x2, EdgeKind::Corridor);
    b.lv(c2, 4, 4);
    let r = b.build();
    for (to, lvl) in [(c0, "ground level"), (c2, "level 2")] {
        let p = r.route(&on(c_m1, 0.5, &r), &on(to, 0.5, &r), &STEP_FREE).unwrap();
        assert_eq!(p.lifts, 1);
        assert!(close(p.cost.fix_s, LIFT_S, 1e-3), "{:?}", p.cost);
        assert!(close(p.cost.var_m, 30.0, 0.1), "lift edges are not walked: {:?}", p.cost);
        assert_eq!(texts(&p)[2], format!("Take the lift up to {lvl}"));
    }
    assert!(r.route(&on(c_m1, 0.5, &r), &on(c0, 0.5, &r), &WalkProfile { lifts: false, ..NORMAL }).is_none());
}

#[test]
fn wheelchair_barriers() {
    let mut b = Gb::new();
    // Two ways from W to E: direct 100 m with a stile in the middle, detour 160 m.
    let (w, m, e) = (b.node(0.0, 0.0), b.node(50.0, 0.0), b.node(100.0, 0.0));
    b.nflag(m, NF_NO_WHEELCHAIR);
    let (w0, e0) = (b.node(-10.0, 0.0), b.node(110.0, 0.0));
    let start = b.edge(w0, w, EdgeKind::Footway);
    let end = b.edge(e, e0, EdgeKind::Footway);
    let before = b.edge(w, m, EdgeKind::Footway);
    let after = b.edge(m, e, EdgeKind::Footway);
    let detour = b.edge_via(w, e, EdgeKind::Footway, &[(50.0, 62.45)]);
    let r = b.build();
    let (s, t) = (on(start, 0.0, &r), on(end, 1.0, &r));
    assert!(close(r.route(&s, &t, &NORMAL).unwrap().dist_m, 120.0, 0.2));
    let p = r.route(&s, &t, &STEP_FREE).unwrap();
    assert!(close(p.dist_m, 180.0, 0.5), "{}", p.dist_m);
    // A place beside the stile can be reached and left, from its own side
    // only, and the walk there is as long as the walk back.
    for (edge, want) in [(before, 10.0 + 25.0), (after, 10.0 + 160.0 + 25.0)] {
        let x = on(edge, 0.5, &r);
        let (there, back) = (r.route(&s, &x, &STEP_FREE).unwrap(), r.route(&x, &s, &STEP_FREE).unwrap());
        assert!(close(there.dist_m, want, 0.5) && close(back.dist_m, want, 0.5), "{} {} {want}", there.dist_m, back.dist_m);
        let m = r.one_to_many(&s, &[x], &STEP_FREE, 900.0)[0].unwrap();
        let m_back = r.one_to_many(&x, &[s], &STEP_FREE, 900.0)[0].unwrap();
        assert!(close(m.var_m, want, 0.5) && close(m_back.var_m, want, 0.5));
    }
    let c = r.components(&STEP_FREE);
    assert_eq!(c[before as usize], c[after as usize]); // joined by the detour, not through the stile
    assert_eq!(c[before as usize], c[start as usize]);
    // wheelchair=no on the detour as well: no route.
    let mut g = (**r.graph()).clone();
    g.edges[detour as usize].flags |= EF_WHEELCHAIR_NO;
    let r2 = WalkRouter::new(Arc::new(g));
    assert!(r2.route(&s, &t, &STEP_FREE).is_none());
    assert!(r2.route(&s, &t, &NORMAL).is_some());
    assert!(r2.snap(pt(50.0, 60.0), &SnapOptions { profile: Some(STEP_FREE), max_dist_m: 10.0, ..Default::default() }).is_none());

    // Rough surface: fine on foot, avoided in a wheelchair when the detour is moderate.
    let mut b = Gb::new();
    let (w, e) = (b.node(0.0, 0.0), b.node(100.0, 0.0));
    let rough = b.edge(w, e, EdgeKind::Path);
    b.fl(rough, EF_ROUGH);
    b.edge_via(w, e, EdgeKind::Footway, &[(50.0, 40.0)]);
    let (w0, e0) = (b.node(-10.0, 0.0), b.node(110.0, 0.0));
    let start = b.edge(w0, w, EdgeKind::Footway);
    let end = b.edge(e, e0, EdgeKind::Footway);
    let r = b.build();
    let (s, t) = (on(start, 0.0, &r), on(end, 1.0, &r));
    assert!(close(r.route(&s, &t, &NORMAL).unwrap().dist_m, 120.0, 0.2));
    let p = r.route(&s, &t, &STEP_FREE).unwrap();
    assert!(p.dist_m > 140.0 && close(p.cost.var_m, p.dist_m, 0.01), "penalty must not leak into the cost");
}

#[test]
fn crossing_wait_once() {
    let mut b = Gb::new();
    // Sidewalk — crossing (split in two by the road it crosses) — sidewalk.
    let (s0, k0, mid, k1, s1) = (b.node(0.0, -30.0), b.node(0.0, 0.0), b.node(0.0, 6.0), b.node(0.0, 12.0), b.node(0.0, 42.0));
    let south = b.edge(s0, k0, EdgeKind::Sidewalk);
    let x1 = b.edge(k0, mid, EdgeKind::Crossing);
    let x2 = b.edge(mid, k1, EdgeKind::Crossing);
    b.way(x1, 77);
    b.way(x2, 77);
    b.fl(x1, EF_SIGNALS);
    let north = b.edge(k1, s1, EdgeKind::Sidewalk);
    let (r0, r1) = (b.node(-50.0, 6.0), b.node(50.0, 6.0));
    let road_w = b.edge(r0, mid, EdgeKind::Road);
    let road_e = b.edge(mid, r1, EdgeKind::Road);
    b.name(road_w, "Bubenbergplatz");
    b.name(road_e, "Bubenbergplatz");
    let r = b.build();
    let p = r.route(&on(south, 0.5, &r), &on(north, 0.5, &r), &NORMAL).unwrap();
    assert!(close(p.cost.fix_s, CROSSING_SIGNAL_S, 0.01), "{:?}", p.cost);
    assert!(close(p.cost.var_m, 42.0, 0.1));
    assert_eq!(texts(&p), vec!["Head north", "Walk 15 m", "Cross Bubenbergplatz at the traffic lights", "Walk 15 m", "Arrive at your destination"]);
    let cross = &p.steps[2];
    assert!(cross.kind == StepKind::Cross && cross.name == "Bubenbergplatz" && close(cross.cost.fix_s, CROSSING_SIGNAL_S, 0.01));
    // Leaving the crossing half way (along the road) costs half the wait.
    let p = r.route(&on(south, 0.5, &r), &on(road_e, 0.5, &r), &NORMAL).unwrap();
    assert!(close(p.cost.fix_s, CROSSING_SIGNAL_S / 2.0, 0.01));
    let m = r.one_to_many(&on(south, 0.5, &r), &[on(north, 0.5, &r)], &NORMAL, 300.0);
    assert!(close(m[0].unwrap().fix_s, CROSSING_SIGNAL_S, 0.01));

    // Unsplit crossings of each type.
    for (flags, wait, how) in [(0u16, CROSSING_UNMARKED_S, "Cross the street"), (EF_MARKED, CROSSING_MARKED_S, "Cross the street at the zebra crossing"), (EF_SIGNALS, CROSSING_SIGNAL_S, "Cross the street at the traffic lights")] {
        let mut b = Gb::new();
        let (a, k0, k1, c) = (b.node(0.0, 0.0), b.node(30.0, 0.0), b.node(40.0, 0.0), b.node(70.0, 0.0));
        let s = b.edge(a, k0, EdgeKind::Sidewalk);
        let x = b.edge(k0, k1, EdgeKind::Crossing);
        b.fl(x, flags);
        let t = b.edge(k1, c, EdgeKind::Sidewalk);
        let r = b.build();
        let p = r.route(&on(s, 0.0, &r), &on(t, 1.0, &r), &NORMAL).unwrap();
        assert!(close(p.cost.fix_s, wait, 0.01));
        assert_eq!(texts(&p)[2], how);
    }
}

#[test]
fn one_to_many_equals_route() {
    let r = random_city(42, 16, 12);
    let g = r.graph().clone();
    let mut rng = Rng(1234);
    let profiles = [NORMAL, WalkProfile::normal(0.9), avoid(), STEP_FREE, WalkProfile { lifts: false, escalators: false, ..NORMAL }];
    let pick = |rng: &mut Rng| -> Snap {
        let e = (rng.next() * g.edges.len() as f32) as u32 % g.edges.len() as u32;
        let frac = rng.next();
        let pts = g.edge_geom(e);
        // Position does not matter for the cost, only (edge, frac); take any point of the edge.
        Snap { edge: e, frac, pos: pts[0], dist_m: 0.0 }
    };
    let (mut some, mut none) = (0, 0);
    for round in 0..12 {
        let prof = profiles[round % profiles.len()];
        let from = pick(&mut rng);
        let targets: Vec<Snap> = (0..60).map(|_| pick(&mut rng)).chain([from, Snap { frac: 1.0 - from.frac, ..from }]).collect();
        let bound = 240.0;
        let many = r.one_to_many(&from, &targets, &prof, bound);
        for (t, m) in targets.iter().zip(&many) {
            // Only (edge, frac) may matter: the position stays wrong on purpose.
            let t2 = *t;
            let single = r.route(&from, &t2, &prof);
            match (m, single) {
                (Some(c), Some(p)) => {
                    assert!(close(c.var_m, p.cost.var_m, 0.05) && close(c.fix_s, p.cost.fix_s, 0.05), "{c:?} vs {:?} ({prof:?})", p.cost);
                    assert!(c.secs(prof.speed_mps) <= bound + 0.01);
                    some += 1;
                }
                (None, Some(p)) => {
                    assert!(p.cost.secs(prof.speed_mps) > bound - 0.01, "missed a target at {} s", p.cost.secs(prof.speed_mps));
                    none += 1;
                }
                (None, None) => none += 1,
                (Some(c), None) => panic!("one_to_many found {c:?} but route did not"),
            }
        }
    }
    assert!(some > 150 && none > 20, "{some} {none}");
}

#[test]
fn route_cost_is_sum_of_steps_and_geometry_is_continuous() {
    let r = random_city(11, 14, 10);
    let g = r.graph().clone();
    let mut rng = Rng(77);
    let mut n = 0;
    for i in 0..300 {
        let prof = if i % 3 == 0 { STEP_FREE } else { NORMAL };
        let a = pt(rng.next() * 520.0, rng.next() * 360.0);
        let b = pt(rng.next() * 520.0, rng.next() * 360.0);
        let o = SnapOptions { profile: Some(prof), exclude_kinds: 1 << EdgeKind::Lift as u8, ..Default::default() };
        let (Some(s), Some(t)) = (r.snap(a, &o), r.snap(b, &o)) else { continue };
        let Some(p) = r.route(&s, &t, &prof) else { continue };
        n += 1;
        assert_eq!(p.geometry.len(), p.levels.len());
        assert!(p.geometry[0].dist_m(&s.pos) < 0.05 && p.geometry.last().unwrap().dist_m(&t.pos) < 0.05);
        // Length of the drawn line = reported distance.
        let drawn: f32 = p.geometry.windows(2).map(|w| w[0].dist_m(&w[1])).sum();
        assert!(close(drawn, p.dist_m, 0.5 + p.dist_m * 0.002), "{drawn} vs {}", p.dist_m);
        // Steps tile the path.
        let (mut var, mut fix, mut dist) = (0.0, 0.0, 0.0);
        let mut at = 0u32;
        for st in &p.steps {
            assert!(st.from == at || (st.from == st.to && st.from <= at + 1), "{:?}", p.steps);
            assert!(st.to >= st.from);
            at = st.to;
            var += st.cost.var_m;
            fix += st.cost.fix_s;
            dist += st.dist_m;
        }
        assert_eq!(at as usize, p.geometry.len() - 1);
        assert!(close(var, p.cost.var_m, 0.05) && close(fix, p.cost.fix_s, 0.05) && close(dist, p.dist_m, 0.05));
        assert_eq!(p.steps.first().unwrap().kind, StepKind::Depart);
        assert_eq!(p.steps.last().unwrap().kind, StepKind::Arrive);
        // Reverse walk on foot costs the same unless one-way escalators are involved.
        let _ = &g;
    }
    assert!(n > 200, "{n}");
}

#[test]
fn geometry_cut_inside_edges() {
    let mut b = Gb::new();
    let (n0, n1, n2, n3) = (b.node(0.0, 0.0), b.node(60.0, 0.0), b.node(60.0, 80.0), b.node(100.0, 80.0));
    // First edge bends: (0,0) → (30,0) → (30,20)?? keep it simple: via (30,10).
    let e0 = b.edge_via(n0, n1, EdgeKind::Footway, &[(30.0, 10.0)]);
    let e1 = b.edge_via(n2, n1, EdgeKind::Footway, &[(70.0, 40.0)]); // stored against travel direction
    let e2 = b.edge(n2, n3, EdgeKind::Footway);
    let r = b.build();
    let s = r.snap(pt(15.0, 6.0), &SnapOptions::default()).unwrap();
    let t = r.snap(pt(90.0, 81.0), &SnapOptions::default()).unwrap();
    assert_eq!((s.edge, t.edge), (e0, e2));
    let p = r.route(&s, &t, &NORMAL).unwrap();
    // snapped start, bend of e0, n1, bend of e1, n2, snapped end
    assert_eq!(p.geometry.len(), 6, "{:?}", p.geometry);
    assert_eq!(p.geometry[0], s.pos);
    assert!(p.geometry[1].dist_m(&pt(30.0, 10.0)) < 0.02);
    assert!(p.geometry[2].dist_m(&pt(60.0, 0.0)) < 0.02);
    assert!(p.geometry[3].dist_m(&pt(70.0, 40.0)) < 0.02);
    assert!(p.geometry[4].dist_m(&pt(60.0, 80.0)) < 0.02);
    assert_eq!(p.geometry[5], t.pos);
    let g = r.graph();
    let want = g.edges[e0 as usize].len_m() * (1.0 - s.frac) + g.edges[e1 as usize].len_m() + g.edges[e2 as usize].len_m() * t.frac;
    assert!(close(p.dist_m, want, 0.05));
    // And backwards.
    let q = r.route(&t, &s, &NORMAL).unwrap();
    let mut rev = q.geometry.clone();
    rev.reverse();
    assert_eq!(rev, p.geometry);
    assert!(close(q.dist_m, p.dist_m, 0.01));
}

// ------------------------------------------------------------ instructions

/// Street → signalled crossing → station door → concourse → stairs down →
/// named underpass → escalator up → platform.
fn station() -> (WalkRouter, u32, u32) {
    let mut b = Gb::new();
    let n: Vec<u32> = [
        (0.0, 0.0),     // 0 start of Neuengasse
        (120.0, 0.0),   // 1 kerb
        (120.0, 5.0),   // 2 middle of the road
        (120.0, 10.0),  // 3 far kerb
        (120.0, 13.0),  // 4 door
        (120.0, 30.0),  // 5 top of stairs
        (120.0, 40.0),  // 6 bottom of stairs
        (300.0, 40.0),  // 7 end of underpass
        (300.0, 52.0),  // 8 top of escalator
        (300.0, 55.0),  // 9 platform start
        (360.0, 55.0),  // 10 platform end
    ]
    .iter()
    .map(|&(x, y)| b.node(x, y))
    .collect();
    let street = b.edge(n[0], n[1], EdgeKind::Sidewalk);
    b.name(street, "Neuengasse");
    for (i, (p, q)) in [(1, 2), (2, 3)].into_iter().enumerate() {
        let x = b.edge(n[p], n[q], EdgeKind::Crossing);
        b.fl(x, if i == 0 { EF_SIGNALS } else { 0 });
        b.way(x, 500);
    }
    let (rw, re) = (b.node(60.0, 5.0), b.node(180.0, 5.0));
    for (p, q) in [(rw, n[2]), (n[2], re)] {
        let e = b.edge(p, q, EdgeKind::RoadBusy);
        b.name(e, "Bubenbergplatz");
    }
    b.edge(n[3], n[4], EdgeKind::Footway); // 3 m forecourt, folded away
    b.nflag(n[4], NF_ENTRANCE);
    let hall = b.edge(n[4], n[5], EdgeKind::Corridor);
    b.lv(hall, 0, 0);
    b.fl(hall, EF_INDOOR);
    let st = b.edge(n[6], n[5], EdgeKind::Steps); // stored bottom → top
    b.lv(st, -2, 0);
    b.fl(st, EF_INDOOR | EF_UP_AB);
    b.e(st).steps = 24;
    let tun = b.edge(n[6], n[7], EdgeKind::Footway);
    b.lv(tun, -2, -2);
    b.fl(tun, EF_INDOOR | EF_TUNNEL);
    b.name(tun, "Christoffelunterführung");
    // side passages so that the corners are real junctions
    let (j1, j2) = (b.node(100.0, 40.0), b.node(320.0, 40.0));
    for (p, q) in [(j1, n[6]), (n[7], j2)] {
        let e = b.edge(p, q, EdgeKind::Footway);
        b.lv(e, -2, -2);
        b.fl(e, EF_INDOOR | EF_TUNNEL);
    }
    let esc = b.edge(n[7], n[8], EdgeKind::Escalator);
    b.lv(esc, -2, 0);
    b.fl(esc, EF_ONEWAY_AB | EF_UP_AB | EF_INDOOR);
    let link = b.edge(n[8], n[9], EdgeKind::Footway); // 3 m, folded
    b.lv(link, 0, 0);
    let plat = b.edge(n[9], n[10], EdgeKind::Platform);
    b.lv(plat, 0, 0);
    let pw = b.node(240.0, 55.0);
    let plat_w = b.edge(pw, n[9], EdgeKind::Platform);
    b.lv(plat_w, 0, 0);
    (b.build(), street, plat)
}

#[test]
fn instructions_station() {
    let (r, street, plat) = station();
    let p = r.route(&on(street, 0.0, &r), &on(plat, 1.0, &r), &NORMAL).unwrap();
    assert_eq!(
        texts(&p),
        vec![
            "Head east",
            "Walk 120 m along Neuengasse",
            "Turn left and cross Bubenbergplatz at the traffic lights",
            "Go through the entrance into the building",
            "Walk 17 m",
            "Take the stairs down to level \u{2212}1 (24 steps)",
            "Turn right and walk 180 m through Christoffelunterführung",
            "Turn left and take the escalator up to ground level",
            "Turn right and walk 60 m along the platform",
            "Arrive at your destination",
        ]
    );
    assert_eq!(
        kinds(&p),
        vec![
            StepKind::Depart,
            StepKind::Walk,
            StepKind::Cross,
            StepKind::Enter,
            StepKind::Walk,
            StepKind::StairsDown,
            StepKind::Walk,
            StepKind::EscalatorUp,
            StepKind::Platform,
            StepKind::Arrive
        ]
    );
    assert_eq!((p.stairs_down, p.stairs_up, p.escalators, p.lifts), (24, 0, 1, 0));
    let walk = &p.steps[1];
    assert!(walk.name == "Neuengasse" && close(walk.dist_m, 120.0, 0.1) && walk.level == LEVEL_NONE);
    let stairs = &p.steps[5];
    assert_eq!((stairs.level, stairs.to_level), (0, -2));
    assert!(close(stairs.cost.var_m, 10.0 * STAIRS_FACTOR, 0.1));
    let tunnel = &p.steps[6];
    assert_eq!((tunnel.level, tunnel.to_level, tunnel.name.as_str()), (-2, -2, "Christoffelunterführung"));
    // The escalator step absorbed the 3 m link; the crossing absorbed the 3 m forecourt.
    assert!(close(p.steps[7].dist_m, 15.0, 0.1) && close(p.steps[2].dist_m, 13.0, 0.1));
    assert!(close(p.cost.fix_s, CROSSING_SIGNAL_S + 12.0 / ESCALATOR_MPS, 0.05));
    // Levels along the line: unknown on the street, 0 in the hall, -1 below, 0 on the platform.
    assert_eq!(p.levels.first(), Some(&LEVEL_NONE));
    assert_eq!(p.levels.last(), Some(&0));
    assert!(p.levels.contains(&-2));

    // Step-free: neither stairs nor escalator, so no way down here.
    assert!(r.route(&on(street, 0.0, &r), &on(plat, 1.0, &r), &STEP_FREE).is_none());

    // The other way: the escalator only runs up, so no route either; from the underpass up the stairs works.
    let tun = r.snap(pt(200.0, 40.0), &SnapOptions { level: Some(-2), ..Default::default() }).unwrap();
    let q = r.route(&tun, &on(street, 0.0, &r), &NORMAL).unwrap();
    assert_eq!(
        texts(&q),
        vec![
            "Start on level \u{2212}1, heading west",
            "Walk 80 m through Christoffelunterführung",
            "Turn left and take the stairs up to ground level (24 steps)",
            "Walk 17 m",
            "Exit the building",
            "Cross Bubenbergplatz at the traffic lights",
            "Turn right and walk 120 m along Neuengasse",
            "Arrive at your destination",
        ]
    );
}

#[test]
fn instructions_merge_bends_and_names() {
    let mut b = Gb::new();
    // A street made of five short pieces with gentle bends and one unnamed 5 m gap, then a real turn.
    let xs = [(0.0, 0.0), (30.0, 0.0), (60.0, 4.0), (65.0, 4.0), (95.0, 2.0), (125.0, 2.0), (125.0, 62.0)];
    let n: Vec<u32> = xs.iter().map(|&(x, y)| b.node(x, y)).collect();
    let mut first = 0;
    let mut last = 0;
    for i in 0..6 {
        let e = b.edge(n[i], n[i + 1], EdgeKind::Footway);
        if i == 0 {
            first = e;
        }
        last = e;
        if i < 5 && i != 2 {
            b.name(e, "Aarbergergasse");
        } else if i == 5 {
            b.name(e, "Speichergasse");
        }
    }
    // side streets make every node a junction
    for i in 1..6 {
        let s = b.node(xs[i].0, xs[i].1 - 25.0);
        b.edge(n[i], s, EdgeKind::Footway);
    }
    let r = b.build();
    let p = r.route(&on(first, 0.0, &r), &on(last, 1.0, &r), &NORMAL).unwrap();
    assert_eq!(texts(&p), vec!["Head east", "Walk 130 m along Aarbergergasse", "Turn left and walk 60 m along Speichergasse", "Arrive at your destination"]);

    // Fractions of levels and distances.
    assert_eq!(steps::fmt_level(-3), "\u{2212}1.5");
    assert_eq!(steps::fmt_level(1), "0.5");
    assert_eq!(steps::fmt_level(4), "2");
    assert_eq!((steps::fmt_dist(0.3), steps::fmt_dist(17.4), steps::fmt_dist(63.0), steps::fmt_dist(287.0)), ("1 m".into(), "17 m".into(), "65 m".into(), "290 m".into()));
}

#[test]
fn instructions_ramp_and_flights() {
    let mut b = Gb::new();
    // Two flights with a 2 m landing, then a ramp way spanning two levels.
    let n: Vec<u32> = [(0.0, 0.0), (20.0, 0.0), (26.0, 0.0), (28.0, 0.0), (34.0, 0.0), (54.0, 0.0), (94.0, 0.0), (114.0, 0.0)].iter().map(|&(x, y)| b.node(x, y)).collect();
    let a = b.edge(n[0], n[1], EdgeKind::Corridor);
    b.lv(a, 0, 0);
    let f1 = b.edge(n[1], n[2], EdgeKind::Steps);
    b.lv(f1, 0, 1);
    b.e(f1).steps = 9;
    b.fl(f1, EF_UP_AB);
    let land = b.edge(n[2], n[3], EdgeKind::Footway);
    b.lv(land, 1, 1);
    let f2 = b.edge(n[3], n[4], EdgeKind::Steps);
    b.lv(f2, 1, 2);
    b.e(f2).steps = 9;
    b.fl(f2, EF_UP_AB);
    let c = b.edge(n[4], n[5], EdgeKind::Corridor);
    b.lv(c, 2, 2);
    let ramp = b.edge(n[5], n[6], EdgeKind::Footway);
    b.lv(ramp, 2, 4);
    let d = b.edge(n[6], n[7], EdgeKind::Corridor);
    b.lv(d, 4, 4);
    let r = b.build();
    let p = r.route(&on(a, 0.0, &r), &on(d, 1.0, &r), &NORMAL).unwrap();
    assert_eq!(texts(&p), vec!["Head east", "Walk 20 m", "Take the stairs up to level 1 (18 steps)", "Walk 20 m", "Take the ramp up to level 2 (40 m)", "Walk 20 m", "Arrive at your destination on level 2"]);
    assert_eq!(p.stairs_up, 18);
    let q = r.route(&on(d, 1.0, &r), &on(a, 0.0, &r), &NORMAL).unwrap();
    assert_eq!(texts(&q)[2], "Take the ramp down to level 1 (40 m)");
    assert_eq!(texts(&q)[4], "Take the stairs down to ground level (18 steps)");
    assert_eq!(q.stairs_down, 18);
    assert_eq!(kinds(&q)[2], StepKind::RampDown);
}

#[test]
fn concurrent_queries() {
    let r = Arc::new(random_city(5, 14, 10));
    let prof = NORMAL;
    let o = SnapOptions { exclude_kinds: 1 << EdgeKind::Lift as u8, ..Default::default() };
    let s = r.snap(pt(100.0, 100.0), &o).unwrap();
    let targets: Vec<Snap> = (0..40).filter_map(|i| r.snap(pt(13.0 * i as f32, 9.0 * i as f32), &o)).collect();
    let want = r.one_to_many(&s, &targets, &prof, 500.0);
    std::thread::scope(|sc| {
        for _ in 0..8 {
            sc.spawn(|| {
                for _ in 0..50 {
                    assert_eq!(r.one_to_many(&s, &targets, &prof, 500.0), want);
                    for (t, w) in targets.iter().zip(&want).take(5) {
                        assert_eq!(r.route(&s, t, &prof).map(|p| p.cost.var_m.round()), w.map(|c| c.var_m.round()));
                    }
                }
            });
        }
    });
}

#[test]
fn instructions_open_areas_and_untagged_level_changes() {
    let mut b = Gb::new();
    // Street → named square crossed on two area edges with a right-angle bend
    // (same OSM way) → corridor on level -1 → corridor on level -2 joined
    // without any connector → stairs tagged with one level only → street.
    let n: Vec<u32> = [(0.0, 0.0), (40.0, 0.0), (80.0, 0.0), (80.0, 40.0), (80.0, 70.0), (80.0, 100.0), (80.0, 110.0), (80.0, 140.0)].iter().map(|&(x, y)| b.node(x, y)).collect();
    let street = b.edge(n[0], n[1], EdgeKind::Sidewalk);
    b.name(street, "Neuengasse");
    for (p, q) in [(1, 2), (2, 3)] {
        let e = b.edge(n[p], n[q], EdgeKind::Pedestrian);
        b.fl(e, EF_AREA);
        b.way(e, 900);
        b.name(e, "Bahnhofplatz");
    }
    // more area edges so that the bend is a junction
    let extra = b.node(120.0, 0.0);
    let e = b.edge(n[2], extra, EdgeKind::Pedestrian);
    b.fl(e, EF_AREA);
    b.way(e, 900);
    let upper = b.edge(n[3], n[4], EdgeKind::Corridor);
    b.lv(upper, -2, -2);
    b.fl(upper, EF_INDOOR | EF_TUNNEL);
    let lower = b.edge(n[4], n[5], EdgeKind::Corridor);
    b.lv(lower, -4, -4);
    b.fl(lower, EF_INDOOR | EF_TUNNEL);
    let st = b.edge(n[5], n[6], EdgeKind::Steps);
    b.lv(st, -4, -4);
    b.fl(st, EF_UP_AB | EF_INDOOR);
    b.e(st).steps = 30;
    let out = b.edge(n[6], n[7], EdgeKind::Footway);
    let r = b.build();
    let p = r.route(&on(street, 0.0, &r), &on(out, 1.0, &r), &NORMAL).unwrap();
    assert_eq!(
        texts(&p),
        vec![
            "Head east",
            "Walk 40 m along Neuengasse",
            "Walk 80 m across Bahnhofplatz",
            "Walk 30 m through the underpass",
            "Go down to level \u{2212}2 (stairs or lift not mapped)",
            "Walk 30 m through the underpass",
            "Take the stairs up (30 steps)",
            "Walk 30 m",
            "Arrive at your destination",
        ]
    );
    assert_eq!(p.stairs_up, 30);
    assert_eq!(p.unmapped_level_changes, 1);
    // The level change is a step of its own with both floors, drawn as a
    // point; the geometry repeats that point once per floor.
    let j = p.steps.iter().find(|s| s.text.starts_with("Go down")).unwrap();
    assert_eq!((j.kind, j.level, j.to_level, j.dist_m), (StepKind::Walk, -2, -4, 0.0));
    assert_eq!(p.geometry[j.from as usize], p.geometry[j.to as usize]);
    assert_eq!((p.levels[j.from as usize], p.levels[j.to as usize]), (-2, -4));
}

#[test]
fn instructions_fold_short_platform_and_name_crossing_from_kerb() {
    let mut b = Gb::new();
    // 3 m of bus-bay platform, then a road, then a crossing drawn from the carriageway.
    let n: Vec<u32> = [(0.0, 0.0), (3.0, 0.0), (43.0, 0.0), (43.0, 6.0), (43.0, 36.0)].iter().map(|&(x, y)| b.node(x, y)).collect();
    let plat = b.edge(n[0], n[1], EdgeKind::Platform);
    b.name(plat, "Bern Bahnhof");
    let road = b.edge(n[1], n[2], EdgeKind::Road);
    b.name(road, "Bubenbergplatz");
    let side = b.node(83.0, 0.0);
    let road2 = b.edge(n[2], side, EdgeKind::Road);
    b.name(road2, "Bubenbergplatz");
    let x = b.edge(n[2], n[3], EdgeKind::Crossing);
    b.fl(x, EF_MARKED);
    let far = b.edge(n[3], n[4], EdgeKind::Sidewalk);
    let r = b.build();
    let p = r.route(&on(plat, 0.0, &r), &on(far, 1.0, &r), &NORMAL).unwrap();
    assert_eq!(texts(&p), vec!["Head east", "Walk 45 m along Bubenbergplatz", "Turn left and cross Bubenbergplatz at the zebra crossing", "Walk 30 m", "Arrive at your destination"]);
    assert!(close(p.cost.fix_s, CROSSING_MARKED_S, 0.01));
    // The folded platform does not lend its name to the walk.
    let mut g2 = (**r.graph()).clone();
    g2.edges[road as usize].name = 0;
    let r2 = WalkRouter::new(Arc::new(g2));
    let p2 = r2.route(&on(plat, 0.0, &r2), &on(road, 1.0, &r2), &NORMAL).unwrap();
    assert_eq!(texts(&p2), vec!["Head east", "Walk 45 m along the road", "Arrive at your destination"]);
    // Three metres of platform before the destination are not worth a step …
    let q = r.route(&on(far, 1.0, &r), &on(plat, 0.0, &r), &NORMAL).unwrap();
    assert_eq!(texts(&q), vec!["Head south", "Walk 30 m", "Cross Bubenbergplatz at the zebra crossing", "Turn right and walk 45 m along Bubenbergplatz", "Arrive at your destination"]);
    assert!(close(q.steps.iter().map(|s| s.dist_m).sum::<f32>(), q.dist_m, 0.1));
}

#[test]
fn instructions_ends_lifts_and_repeats() {
    // 2 m of a named street, a 30 m crossing-free walk in a passage with a
    // turn in it, a lift between two untagged ways, then 6 m of platform.
    let mut b = Gb::new();
    let n: Vec<u32> = [(0.0, 0.0), (2.0, 0.0), (42.0, 0.0), (42.0, 40.0), (42.0, 40.0), (42.0, 70.0), (42.0, 76.0)].iter().map(|&(x, y)| b.node(x, y)).collect();
    let first = b.edge(n[0], n[1], EdgeKind::Sidewalk);
    b.name(first, "Kurzgasse");
    let a = b.edge(n[1], n[2], EdgeKind::Corridor);
    let c = b.edge(n[2], n[3], EdgeKind::Corridor);
    for e in [a, c] {
        b.name(e, "Passage");
        b.fl(e, EF_INDOOR);
    }
    // make the bend a junction
    let side = b.node(82.0, 0.0);
    let spur = b.edge(n[2], side, EdgeKind::Corridor);
    b.fl(spur, EF_INDOOR);
    b.nflag(n[3], NF_ELEVATOR);
    b.nflag(n[4], NF_ELEVATOR);
    let lift = b.edge(n[3], n[4], EdgeKind::Lift);
    let street = b.edge(n[4], n[5], EdgeKind::Footway);
    b.name(street, "Obere Gasse");
    let plat = b.edge(n[5], n[6], EdgeKind::Platform);
    let _ = lift;
    let r = b.build();
    let p = r.route(&on(first, 0.0, &r), &on(plat, 1.0, &r), &NORMAL).unwrap();
    assert_eq!(
        texts(&p),
        vec![
            "Head east",
            // the 2 m of Kurzgasse are gone, the door is not
            "Enter the building",
            "Walk 40 m through Passage",
            "Turn left and continue for 40 m",
            // no level on either side: say where the lift leads
            "Take the lift to Obere Gasse",
            "Walk 30 m along Obere Gasse",
            // six metres of platform are still worth saying
            "Walk 6 m along the platform",
            "Arrive at your destination",
        ]
    );
    assert_eq!(p.lifts, 1);
    assert!(close(p.steps.iter().map(|s| s.cost.var_m).sum::<f32>(), p.cost.var_m, 0.1));
    // The dropped metres belong to the first step, so nothing is lost.
    assert!(close(p.steps[0].dist_m, 2.0, 0.1) && p.steps[0].to > 0 && p.steps[1].from == p.steps[0].to);
    // One side tagged: the untagged street is street level.
    let mut g = (**r.graph()).clone();
    for e in [a, c, spur] {
        g.edges[e as usize].level_a = -2;
        g.edges[e as usize].level_b = -2;
    }
    let r2 = WalkRouter::new(Arc::new(g));
    let up = r2.route(&on(first, 0.0, &r2), &on(plat, 1.0, &r2), &NORMAL).unwrap();
    assert!(texts(&up).contains(&"Take the lift up to ground level"), "{:?}", texts(&up));
    let down = r2.route(&on(plat, 1.0, &r2), &on(a, 0.5, &r2), &NORMAL).unwrap();
    assert!(texts(&down).contains(&"Take the lift down to level \u{2212}1"), "{:?}", texts(&down));

    // A roofed open area is a hall.
    let mut b = Gb::new();
    let (p0, p1, p2) = (b.node(0.0, 0.0), b.node(30.0, 0.0), b.node(60.0, 0.0));
    let hall = b.edge(p0, p1, EdgeKind::Pedestrian);
    b.fl(hall, EF_AREA | EF_COVERED);
    let out = b.edge(p1, p2, EdgeKind::Pedestrian);
    b.fl(out, EF_AREA);
    b.way(hall, 1);
    b.way(out, 2);
    let r = b.build();
    assert_eq!(texts(&r.route(&on(hall, 0.0, &r), &on(hall, 1.0, &r), &NORMAL).unwrap())[1], "Walk 30 m across the hall");
    assert_eq!(texts(&r.route(&on(out, 0.0, &r), &on(out, 1.0, &r), &NORMAL).unwrap())[1], "Walk 30 m across the square");
}

/// Underpass (level −1) and platform (level 0) drawn through one node `j`
/// with no stairs there; a 40 m ramp links the two floors elsewhere if `ramp`.
/// Returns (router, corridor a–j, platform j–b).
fn glued_floors(ramp: bool) -> (WalkRouter, u32, u32) {
    let mut b = Gb::new();
    let (a, j, e) = (b.node(0.0, 0.0), b.node(40.0, 0.0), b.node(80.0, 0.0));
    let under = b.edge(a, j, EdgeKind::Corridor);
    b.lv(under, -2, -2);
    b.fl(under, EF_INDOOR | EF_TUNNEL);
    let plat = b.edge(j, e, EdgeKind::Platform);
    b.lv(plat, 0, 0);
    if ramp {
        let (c, d) = (b.node(0.0, 10.0), b.node(40.0, 10.0));
        let side = b.edge(a, c, EdgeKind::Corridor);
        b.lv(side, -2, -2);
        b.fl(side, EF_INDOOR | EF_TUNNEL);
        let up = b.edge(c, d, EdgeKind::Footway);
        b.lv(up, -2, 0);
        let back = b.edge(d, e, EdgeKind::Platform);
        b.lv(back, 0, 0);
    }
    (b.build(), under, plat)
}

#[test]
fn floors_joined_in_a_node_are_not_step_free() {
    let (r, under, plat) = glued_floors(true);
    assert_eq!(r.level_joins().len(), 1);
    assert_eq!((r.level_joins()[0].kind, r.level_joins()[0].levels.clone()), (LevelJoinKind::Levels, vec![-2, 0]));
    let (s, t) = (on(under, 0.5, &r), on(plat, 0.5, &r));

    // Unrestricted: straight through, said and counted, costed like a flight of stairs.
    let p = r.route(&s, &t, &NORMAL).unwrap();
    assert_eq!(texts(&p), vec!["Start on level \u{2212}1, heading east", "Walk 20 m through the underpass", "Go up to ground level (stairs or lift not mapped)", "Walk 20 m along the platform", "Arrive at your destination"]);
    assert_eq!((p.unmapped_level_changes, p.stairs_up, p.lifts), (1, 0, 0));
    assert!(close(p.dist_m, 40.0, 0.2));
    assert!(close(p.cost.var_m, 40.0 + 2.0 * net::JUMP_M_PER_HALF_LEVEL * STAIRS_FACTOR, 0.2), "{:?}", p.cost);
    let m = r.one_to_many(&s, &[t], &NORMAL, 600.0)[0].unwrap();
    assert!(close(m.var_m, p.cost.var_m, 0.2) && close(m.fix_s, p.cost.fix_s, 0.1));

    // Step-free and wheelchair: only by the mapped ramp, both ways.
    for prof in [STEP_FREE, WalkProfile { wheelchair: true, ..NORMAL }, WalkProfile { stairs: StairsPref::Never, ..NORMAL }] {
        for (x, y) in [(s, t), (t, s)] {
            let q = r.route(&x, &y, &prof).unwrap();
            assert_eq!(q.unmapped_level_changes, 0);
            assert!(close(q.dist_m, 20.0 + 10.0 + 40.0 + 41.2 + 20.0, 1.0), "{}", q.dist_m);
            assert!(q.steps.iter().any(|st| matches!(st.kind, StepKind::RampUp | StepKind::RampDown)));
            assert!(texts(&q).iter().all(|x| !x.contains("not mapped")));
        }
    }
    // Avoiding stairs: an unknown connection is taken to be stairs, so the ramp wins here.
    assert_eq!(r.route(&s, &t, &avoid()).unwrap().unmapped_level_changes, 0);

    // Without the ramp there is no step-free way between the floors at all.
    let (r, under, plat) = glued_floors(false);
    let (s, t) = (on(under, 0.5, &r), on(plat, 0.5, &r));
    assert!(r.route(&s, &t, &STEP_FREE).is_none() && r.route(&t, &s, &STEP_FREE).is_none());
    assert_eq!(r.one_to_many(&s, &[t], &STEP_FREE, 900.0), vec![None]);
    let c = r.components(&STEP_FREE);
    assert_ne!(c[under as usize], c[plat as usize]);
    let down = r.route(&t, &s, &NORMAL).unwrap();
    assert!(texts(&down).contains(&"Go down to level \u{2212}1 (stairs or lift not mapped)"));
    assert_eq!(r.route(&s, &t, &avoid()).unwrap().unmapped_level_changes, 1);
}

#[test]
fn which_joins_count_as_floor_changes() {
    // Car park ramp: carriageways of different levels stay joined.
    let mut b = Gb::new();
    let (a, j, c) = (b.node(0.0, 0.0), b.node(40.0, 0.0), b.node(80.0, 0.0));
    let (lo, hi) = (b.edge(a, j, EdgeKind::Road), b.edge(j, c, EdgeKind::Road));
    b.lv(lo, -4, -4);
    b.lv(hi, -2, -2);
    let r = b.build();
    assert!(r.level_joins().is_empty());
    let p = r.route(&on(lo, 0.5, &r), &on(hi, 0.5, &r), &STEP_FREE).unwrap();
    assert_eq!(p.unmapped_level_changes, 0);
    assert!(close(p.dist_m, 40.0, 0.2));

    // A bridge tagged level=1 that runs into its untagged approach, and a
    // levelled tunnel that ends on a street: continuous, not split.
    let mut b = Gb::new();
    let n: Vec<u32> = [(0.0, 0.0), (40.0, 0.0), (80.0, 0.0), (80.0, 40.0), (40.0, 40.0), (120.0, 40.0)].iter().map(|&(x, y)| b.node(x, y)).collect();
    let approach = b.edge(n[0], n[1], EdgeKind::Path);
    let bridge = b.edge(n[1], n[2], EdgeKind::Path);
    b.lv(bridge, 2, 2);
    b.fl(bridge, EF_BRIDGE);
    let tunnel = b.edge(n[2], n[3], EdgeKind::Footway);
    b.lv(tunnel, -2, -2);
    b.fl(tunnel, EF_TUNNEL);
    b.way(tunnel, 7);
    for (p, q) in [(4, 3), (3, 5)] {
        let e = b.edge(n[p], n[q], EdgeKind::Sidewalk);
        b.way(e, 8);
    }
    let r = b.build();
    // (the bridge end meets the tunnel end at n[2]: two known levels, one node)
    assert_eq!(r.level_joins().iter().map(|j| j.node).collect::<Vec<_>>(), vec![n[2]]);
    assert!(r.route(&on(approach, 0.0, &r), &on(bridge, 1.0, &r), &STEP_FREE).is_some());
    let c = r.components(&STEP_FREE);
    assert_eq!(c[tunnel as usize], c[tunnel as usize + 1]);

    // Street crossing drawn through a node of the underpass below it.
    let x_graph = |tunnel_flags: u16| {
        let mut b = Gb::new();
        let n: Vec<u32> = [(0.0, 0.0), (40.0, 0.0), (80.0, 0.0), (40.0, 20.0), (40.0, -20.0)].iter().map(|&(x, y)| b.node(x, y)).collect();
        let mut tun = [0u32; 2];
        for (i, (p, q)) in [(0, 1), (1, 2)].into_iter().enumerate() {
            let e = b.edge(n[p], n[q], EdgeKind::Corridor);
            b.lv(e, -2, -2);
            b.fl(e, tunnel_flags);
            b.way(e, 5);
            tun[i] = e;
        }
        let cross = b.edge(n[3], n[1], EdgeKind::Crossing);
        let foot = b.edge(n[1], n[4], EdgeKind::Footway);
        (b.build(), tun[0], cross, foot)
    };
    let (r, tun, cross, foot) = x_graph(EF_TUNNEL);
    assert_eq!(r.level_joins().len(), 1);
    assert_eq!(r.level_joins()[0].kind, LevelJoinKind::StreetOverTunnel);
    assert!(r.route(&on(cross, 0.0, &r), &on(tun, 0.0, &r), &STEP_FREE).is_none());
    // … while staying on the street, or in the tunnel, is unaffected.
    let over = r.route(&on(cross, 0.0, &r), &on(foot, 1.0, &r), &STEP_FREE).unwrap();
    assert!(close(over.dist_m, 40.0, 0.2) && over.unmapped_level_changes == 0);
    let p = r.route(&on(cross, 0.0, &r), &on(tun, 0.0, &r), &NORMAL).unwrap();
    assert!(texts(&p).contains(&"Go down to level \u{2212}1 (stairs or lift not mapped)"), "{:?}", texts(&p));
    let q = r.route(&on(tun, 0.0, &r), &on(cross, 0.0, &r), &NORMAL).unwrap();
    assert!(texts(&q).contains(&"Go up to ground level (stairs or lift not mapped)"), "{:?}", texts(&q));
    // An arcade (tunnel=building_passage) with a level tag is at street level.
    let (r, tun, cross, _) = x_graph(EF_TUNNEL | EF_COVERED);
    assert!(r.level_joins().is_empty());
    assert!(r.route(&on(cross, 0.0, &r), &on(tun, 0.0, &r), &STEP_FREE).is_some());
}

#[test]
fn step_free_snap_skips_stair_landings() {
    let mut b = Gb::new();
    // 200 m path – stairs – 6 m landing – stairs – 200 m path; and, apart
    // from all that, a short path connected to nothing.
    let n: Vec<u32> = [(0.0, 0.0), (200.0, 0.0), (205.0, 0.0), (211.0, 0.0), (216.0, 0.0), (416.0, 0.0)].iter().map(|&(x, y)| b.node(x, y)).collect();
    let low = b.edge(n[0], n[1], EdgeKind::Footway);
    let s1 = b.edge(n[1], n[2], EdgeKind::Steps);
    let landing = b.edge(n[2], n[3], EdgeKind::Footway);
    let s2 = b.edge(n[3], n[4], EdgeKind::Steps);
    let high = b.edge(n[4], n[5], EdgeKind::Footway);
    let (p, q) = (b.node(0.0, 300.0), b.node(30.0, 300.0));
    let alone = b.edge(p, q, EdgeKind::Footway);
    let _ = (s1, s2);
    let r = b.build();
    let at = pt(208.0, 1.0);
    let o = SnapOptions { max_dist_m: 50.0, ..Default::default() };
    assert_eq!(r.snap(at, &o).unwrap().edge, landing);
    assert_eq!(r.snap(at, &SnapOptions { profile: Some(NORMAL), ..o }).unwrap().edge, landing);
    for prof in [STEP_FREE, WalkProfile { wheelchair: true, ..NORMAL }, WalkProfile { stairs: StairsPref::Never, ..NORMAL }] {
        let s = r.snap(at, &SnapOptions { profile: Some(prof), ..o }).unwrap();
        assert!(s.edge == low || s.edge == high, "{s:?}");
        assert!(r.snap_candidates(at, &SnapOptions { profile: Some(prof), ..o }, 8).iter().all(|c| c.edge != landing));
    }
    // A small piece nothing else is attached to is not a crumb.
    assert_eq!(r.snap(pt(15.0, 301.0), &SnapOptions { profile: Some(STEP_FREE), ..o }).unwrap().edge, alone);
}

#[test]
fn many_to_many_takes_the_best_source() {
    // Several doors of a building: the metres already walked to a source are counted, a route-choice
    // penalty steers the choice without being counted.
    let r = random_city(7, 12, 10);
    let g = r.graph().clone();
    let mut rng = Rng(99);
    let pick = |rng: &mut Rng| -> Snap {
        let e = (rng.next() * g.edges.len() as f32) as u32 % g.edges.len() as u32;
        Snap { edge: e, frac: rng.next(), pos: g.edge_geom(e)[0], dist_m: 0.0 }
    };
    let mut checked = 0;
    for _ in 0..8 {
        let (a, b) = (pick(&mut rng), pick(&mut rng));
        let targets: Vec<Snap> = (0..30).map(|_| pick(&mut rng)).collect();
        let one = r.one_to_many(&a, &targets, &NORMAL, 3600.0);
        // one source, 12 m before it: the same walks, 12 m longer
        let shifted = r.many_to_many(&[(a, 12.0, 0.0)], &targets, &NORMAL, 3600.0);
        // the other source made useless by a penalty: the same walks as from the first alone
        let steered = r.many_to_many(&[(b, 0.0, 100_000.0), (a, 0.0, 0.0)], &targets, &NORMAL, 3600.0);
        for k in 0..targets.len() {
            match (one[k], shifted[k], steered[k]) {
                (Some(o), Some(s), Some(t)) => {
                    assert!(close(s.var_m, o.var_m + 12.0, 0.05) && close(s.fix_s, o.fix_s, 0.05), "{s:?} vs {o:?}");
                    assert!(close(t.var_m, o.var_m, 0.05) && close(t.fix_s, o.fix_s, 0.05), "{t:?} vs {o:?}");
                    checked += 1;
                }
                (None, _, None) => {}
                x => panic!("{x:?}"),
            }
        }
    }
    assert!(checked > 100, "{checked}");
}
