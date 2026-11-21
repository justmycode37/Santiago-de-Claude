//! Development tool: route between two coordinates on a built walk graph and
//! print the instructions; run the Bern station test cases; measure speed.
//!
//! ```text
//! walk-route [--graph FILE] route LAT,LON[,LEVEL] LAT,LON[,LEVEL] [profile flags] [--edges] [--geojson FILE]
//! walk-route [--graph FILE] bern [--edges] [--geojson-dir DIR]
//! walk-route [--graph FILE] bench [--center LAT,LON]
//! walk-route [--graph FILE] check [--center LAT,LON] [--radius M]   floors joined without a connector
//! walk-route [--graph FILE] islands [--center LAT,LON] [--radius M] why step-free walks fail
//! walk-route [--graph FILE] selftest [N]                 random walks all over the graph
//! profile flags: --speed M_PER_S  --step-free  --avoid-stairs  --no-lifts  --no-escalators  --wheelchair
//! ```

use anyhow::{anyhow, bail, Context, Result};
use kante_core::*;
use kante_walk::{SnapOptions, WalkPath, WalkRouter};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

struct Place {
    pos: LatLon,
    level: Option<Level2>,
}

fn parse_place(s: &str) -> Result<Place> {
    let v: Vec<&str> = s.split(',').collect();
    if v.len() < 2 || v.len() > 3 {
        bail!("expected LAT,LON[,LEVEL], got {s:?}");
    }
    let lat: f64 = v[0].trim().parse().context("latitude")?;
    let lon: f64 = v[1].trim().parse().context("longitude")?;
    let level = match v.get(2) {
        Some(l) => Some((l.trim().parse::<f32>().context("level")? * 2.0).round() as Level2),
        None => None,
    };
    Ok(Place { pos: LatLon::from_deg(lat, lon), level })
}

fn lvl(l: Level2) -> String {
    if l == LEVEL_NONE {
        "–".into()
    } else {
        format!("{}", l as f32 / 2.0)
    }
}

fn rss_mb() -> f64 {
    let s = std::fs::read_to_string("/proc/self/statm").unwrap_or_default();
    s.split_whitespace().nth(1).and_then(|p| p.parse::<f64>().ok()).unwrap_or(0.0) * 4096.0 / 1e6
}

fn snap(r: &WalkRouter, p: &Place, profile: &WalkProfile, max: f32) -> Result<Snap> {
    let opts = SnapOptions { max_dist_m: max, level: p.level, profile: Some(*profile), exclude_kinds: 1 << EdgeKind::Lift as u8 };
    r.snap(p.pos, &opts).ok_or_else(|| anyhow!("no usable edge within {max} m of {:.6},{:.6} (level {:?})", p.pos.lat_deg(), p.pos.lon_deg(), p.level))
}

fn describe_snap(r: &WalkRouter, what: &str, s: &Snap) {
    let g = r.graph();
    let ed = &g.edges[s.edge as usize];
    println!(
        "  {what}: {:.1} m to edge {} (way {}, {:?}, levels {}/{}, {:.0} m long, at {:.2}) {}",
        s.dist_m,
        s.edge,
        g.edge_way.get(s.edge as usize).copied().unwrap_or(0),
        ed.kind,
        lvl(ed.level_a),
        lvl(ed.level_b),
        ed.len_m(),
        s.frac,
        g.edge_name(s.edge)
    );
}

fn print_path(p: &WalkPath, speed: f32) {
    let t = p.cost.secs(speed);
    println!(
        "  {:.0} m, {:.0} s ({}:{:02} at {speed} m/s; var {:.0} m + fix {:.0} s) | stairs up {} down {} | escalators {} | lifts {}",
        p.dist_m,
        t,
        (t / 60.0) as u32,
        (t % 60.0) as u32,
        p.cost.var_m,
        p.cost.fix_s,
        p.stairs_up,
        p.stairs_down,
        p.escalators,
        p.lifts
    );
    for (i, s) in p.steps.iter().enumerate() {
        let extra = if s.dist_m > 0.0 || s.cost.fix_s > 0.0 { format!("  [{:.0} m, {:.0} s]", s.dist_m, s.cost.secs(speed)) } else { String::new() };
        println!("    {:>2}. {}{}", i + 1, s.text, extra);
    }
}

fn print_edges(r: &WalkRouter, from: &Snap, to: &Snap, profile: &WalkProfile) {
    let g = r.graph();
    let Some(es) = r.route_edges(from, to, profile) else { return };
    println!("    edges:");
    for (e, f0, f1) in es {
        let ed = &g.edges[e as usize];
        let (l0, l1) = if f0 <= f1 { (ed.level_a, ed.level_b) } else { (ed.level_b, ed.level_a) };
        println!(
            "      {:>6.1} m  way {:<11} {:<10} level {:>4}→{:<4} flags {:#06x} steps {:>2}  {}",
            ed.len_m() * (f1 - f0).abs(),
            g.edge_way.get(e as usize).copied().unwrap_or(0),
            format!("{:?}", ed.kind),
            lvl(l0),
            lvl(l1),
            ed.flags,
            ed.steps,
            g.edge_name(e)
        );
    }
}

fn geojson(p: &WalkPath, path: &Path) -> Result<()> {
    // One LineString per step (with its text), plus the whole line.
    let coords = |a: usize, b: usize| -> Vec<[f64; 2]> { p.geometry[a..=b].iter().map(|q| [q.lon_deg(), q.lat_deg()]).collect() };
    let mut feats = Vec::new();
    for s in &p.steps {
        let (a, b) = (s.from as usize, s.to as usize);
        let geom = if a == b { serde_json::json!({"type": "Point", "coordinates": coords(a, a)[0]}) } else { serde_json::json!({"type": "LineString", "coordinates": coords(a, b)}) };
        feats.push(serde_json::json!({
            "type": "Feature",
            "geometry": geom,
            "properties": {"kind": format!("{:?}", s.kind), "text": s.text, "dist_m": s.dist_m, "level": s.level as f32 / 2.0, "to_level": s.to_level as f32 / 2.0, "name": s.name}
        }));
    }
    let fc = serde_json::json!({"type": "FeatureCollection", "features": feats});
    std::fs::write(path, serde_json::to_string(&fc)?)?;
    Ok(())
}

fn run_route(r: &WalkRouter, from: &Place, to: &Place, profile: &WalkProfile, max_snap: f32, edges: bool, gj: Option<&Path>, quiet_snap: bool) -> Result<Option<WalkPath>> {
    let (s, t) = (snap(r, from, profile, max_snap)?, snap(r, to, profile, max_snap)?);
    if !quiet_snap {
        describe_snap(r, "from", &s);
        describe_snap(r, "to  ", &t);
    }
    let t0 = Instant::now();
    let path = r.route(&s, &t, profile);
    let dt = t0.elapsed();
    match &path {
        None => println!("  no route"),
        Some(p) => {
            print_path(p, profile.speed_mps);
            println!("    (search + instructions: {:.0} µs)", dt.as_secs_f64() * 1e6);
            if edges {
                print_edges(r, &s, &t, profile);
            }
            if let Some(f) = gj {
                geojson(p, f)?;
                println!("    wrote {}", f.display());
            }
        }
    }
    Ok(path)
}

/// (name, from, to, expected metres normal / step-free from the research run)
/// Street-level stops are given level 0: without it bay Z snaps to the
/// underpass four metres below it.
const BERN: &[(&str, &str, &str, f32, f32)] = &[
    ("city bay G → SBB track 7", "46.948604,7.440440,0", "46.948566,7.436830,0", 205.0, 245.0),
    ("PostAuto bay T (deck, level 2) → SBB track 7", "46.948959,7.438580,2", "46.948566,7.436830,0", 218.0, 251.0),
    ("city bay L → RBS track 21 (level −2)", "46.947298,7.440548,0", "46.949650,7.439890,-2", 287.0, 321.0),
    ("PostAuto bay T (deck) → city bay K1", "46.948959,7.438580,2", "46.946875,7.440772,0", 383.0, 397.0),
    ("SBB track 12/13 → city bay Z", "46.949214,7.437780,0", "46.949046,7.440701,0", 253.0, 285.0),
    ("Schanzenstrasse → SBB track 5", "46.947942,7.437114,0", "46.948507,7.437208,0", 72.0, 70.0),
];

fn bern(r: &WalkRouter, edges: bool, dir: Option<&Path>) -> Result<()> {
    let mut summary = Vec::new();
    for (i, (name, from, to, exp_n, exp_sf)) in BERN.iter().enumerate() {
        let (from, to) = (parse_place(from)?, parse_place(to)?);
        let mut got = [f32::NAN; 2];
        for (k, (label, prof, exp)) in [("normal", WalkProfile::normal(1.3), exp_n), ("step-free", WalkProfile::step_free(1.3), exp_sf)].into_iter().enumerate() {
            println!("\n=== {name} — {label} (research: ≈ {exp} m)");
            let gj = dir.map(|d| d.join(format!("bern-{}-{label}.geojson", i + 1)));
            match run_route(r, &from, &to, &prof, 40.0, edges, gj.as_deref(), false) {
                Ok(Some(p)) => got[k] = p.dist_m,
                Ok(None) => {}
                Err(e) => println!("  {e}"),
            }
        }
        summary.push((name, got, exp_n, exp_sf));
    }
    println!("\n=== summary (metres: got / research)");
    for (name, got, en, es) in summary {
        println!("  {:<48} normal {:>4.0} / {:>3.0}   step-free {:>4.0} / {:>3.0}", name, got[0], en, got[1], es);
    }
    Ok(())
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 40) as f32 / (1u64 << 24) as f32
    }
}

fn pctl(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() - 1) as f64 * p) as usize]
}

fn bench(r: &WalkRouter, center: LatLon) -> Result<()> {
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    let around = |rng: &mut Rng, radius: f32| -> LatLon {
        let b = BBox::around(center, radius);
        LatLon { lat: b.min.lat + ((b.max.lat - b.min.lat) as f32 * rng.next()) as i32, lon: b.min.lon + ((b.max.lon - b.min.lon) as f32 * rng.next()) as i32 }
    };
    let no_lift = 1u32 << EdgeKind::Lift as u8;

    // ---- snap
    let pts: Vec<LatLon> = (0..200_000).map(|_| around(&mut rng, 600.0)).collect();
    for (label, opts) in [
        ("any edge, 50 m", SnapOptions::default()),
        ("step-free profile, 50 m", SnapOptions { profile: Some(WalkProfile::step_free(1.3)), exclude_kinds: no_lift, ..Default::default() }),
        ("level -1 only, 50 m", SnapOptions { level: Some(-2), ..Default::default() }),
        ("any edge, 300 m", SnapOptions { max_dist_m: 300.0, ..Default::default() }),
    ] {
        let t = Instant::now();
        let mut hits = 0usize;
        for p in &pts {
            hits += r.snap(*p, &opts).is_some() as usize;
        }
        println!("snap ({label}): {:.2} µs each, {} of {} matched", t.elapsed().as_secs_f64() * 1e6 / pts.len() as f64, hits, pts.len());
    }
    let t = Instant::now();
    let mut n = 0;
    for p in pts.iter().take(50_000) {
        n += r.snap_candidates(*p, &SnapOptions::default(), 8).len();
    }
    println!("snap_candidates (k = 8, 50 m): {:.2} µs each, {:.1} found on average", t.elapsed().as_secs_f64() * 1e6 / 50_000.0, n as f64 / 50_000.0);

    // ---- route across the station area
    for (label, prof) in [("normal", WalkProfile::normal(1.3)), ("step-free", WalkProfile::step_free(1.3)), ("avoid stairs", WalkProfile { stairs: StairsPref::Avoid, ..WalkProfile::normal(1.3) })] {
        let opts = SnapOptions { profile: Some(prof), exclude_kinds: no_lift, ..Default::default() };
        let mut pairs = Vec::new();
        while pairs.len() < 2000 {
            let (a, b) = (around(&mut rng, 450.0), around(&mut rng, 450.0));
            let d = a.dist_m(&b);
            if !(300.0..=800.0).contains(&d) {
                continue;
            }
            if let (Some(s), Some(t)) = (r.snap(a, &opts), r.snap(b, &opts)) {
                pairs.push((s, t));
            }
        }
        let mut times = Vec::with_capacity(pairs.len());
        let (mut found, mut dist) = (0usize, 0f64);
        for (s, t) in &pairs {
            let t0 = Instant::now();
            let p = r.route(s, t, &prof);
            times.push(t0.elapsed().as_secs_f64() * 1e6);
            if let Some(p) = p {
                found += 1;
                dist += p.dist_m as f64;
            }
        }
        let mean = times.iter().sum::<f64>() / times.len() as f64;
        println!(
            "route {label} (beeline 300–800 m): mean {:.0} µs, median {:.0} µs, p95 {:.0} µs, max {:.0} µs; {} of {} found, mean length {:.0} m",
            mean,
            pctl(&mut times, 0.5),
            pctl(&mut times, 0.95),
            pctl(&mut times, 1.0),
            found,
            pairs.len(),
            dist / found.max(1) as f64
        );
    }

    // ---- one to many, 15 minutes
    for (label, prof) in [("normal", WalkProfile::normal(1.3)), ("step-free", WalkProfile::step_free(1.3))] {
        let opts = SnapOptions { profile: Some(prof), exclude_kinds: no_lift, ..Default::default() };
        let from = r.snap(center, &opts).ok_or_else(|| anyhow!("centre does not snap"))?;
        let targets: Vec<Snap> = (0..4000).filter_map(|_| r.snap(around(&mut rng, 1300.0), &opts)).take(400).collect();
        let reps = 200;
        let t0 = Instant::now();
        let mut reached = 0usize;
        for _ in 0..reps {
            reached = r.one_to_many(&from, &targets, &prof, 900.0).iter().filter(|c| c.is_some()).count();
        }
        let per = t0.elapsed().as_secs_f64() * 1e3 / reps as f64;
        // The same without the early stop: targets nobody can reach in time.
        let far: Vec<Snap> = targets.iter().copied().chain(std::iter::once(r.snap(around(&mut rng, 1300.0), &opts).unwrap_or(from))).collect();
        let t0 = Instant::now();
        for _ in 0..reps {
            let _ = r.one_to_many(&from, &far, &prof, 900.0);
        }
        let per_far = t0.elapsed().as_secs_f64() * 1e3 / reps as f64;
        println!("one_to_many {label} (15 min, {} targets within 1.3 km): {per:.2} ms ({reached} reached); repeat with one more target {per_far:.2} ms", targets.len());
        for bound in [300.0f32, 600.0, 1200.0] {
            let t0 = Instant::now();
            for _ in 0..reps {
                let _ = r.one_to_many(&from, &targets, &prof, bound);
            }
            println!("    bound {:>2.0} min: {:.2} ms", bound / 60.0, t0.elapsed().as_secs_f64() * 1e3 / reps as f64);
        }
    }

    // ---- box query
    let t0 = Instant::now();
    let mut n = 0;
    for _ in 0..2000 {
        n += r.edges_in(&BBox::around(around(&mut rng, 600.0), 150.0)).len();
    }
    println!("edges_in (300 m box): {:.1} µs each, {:.0} edges on average", t0.elapsed().as_secs_f64() * 1e6 / 2000.0, n as f64 / 2000.0);
    Ok(())
}

/// Random walks all over the graph: invariants of the result, and
/// `one_to_many` against `route`.
fn selftest(r: &Arc<WalkRouter>, n: usize) -> Result<()> {
    let g = r.graph().clone();
    // First query on a fresh thread (allocates that thread's scratch).
    {
        let r = r.clone();
        let cold = std::thread::spawn(move || {
            let s = r.snap_at(0, 0.5);
            let t0 = Instant::now();
            let _ = r.one_to_many(&s, &[s], &WalkProfile::normal(1.3), 900.0);
            let first = t0.elapsed();
            let t0 = Instant::now();
            let _ = r.one_to_many(&s, &[s], &WalkProfile::normal(1.3), 900.0);
            (first, t0.elapsed())
        })
        .join()
        .unwrap();
        println!("first query on a new thread: {:.0} µs, second: {:.1} µs", cold.0.as_secs_f64() * 1e6, cold.1.as_secs_f64() * 1e6);
    }
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let profiles = [WalkProfile::normal(1.3), WalkProfile::step_free(1.1), WalkProfile { stairs: StairsPref::Avoid, ..WalkProfile::normal(1.5) }];
    let (mut routed, mut none, mut bad, mut cmp, mut cmp_bad) = (0usize, 0usize, 0usize, 0usize, 0usize);
    let (mut t_route, mut t_many) = (0f64, 0f64);
    for i in 0..n {
        let prof = profiles[i % profiles.len()];
        let opts = SnapOptions { max_dist_m: 80.0, profile: Some(prof), exclude_kinds: 1 << EdgeKind::Lift as u8, ..Default::default() };
        let c = g.nodes[(rng.next() * g.nodes.len() as f32) as usize % g.nodes.len()];
        let Some(from) = r.snap(c, &opts) else { continue };
        let mut targets = Vec::new();
        for _ in 0..12 {
            let b = BBox::around(c, 150.0 + rng.next() * 900.0);
            let q = LatLon { lat: b.min.lat + ((b.max.lat - b.min.lat) as f32 * rng.next()) as i32, lon: b.min.lon + ((b.max.lon - b.min.lon) as f32 * rng.next()) as i32 };
            if let Some(t) = r.snap(q, &opts) {
                targets.push(t);
            }
        }
        let bound = 900.0;
        let t0 = Instant::now();
        let many = r.one_to_many(&from, &targets, &prof, bound);
        t_many += t0.elapsed().as_secs_f64();
        for (t, m) in targets.iter().zip(&many) {
            let t0 = Instant::now();
            let p = r.route(&from, t, &prof);
            t_route += t0.elapsed().as_secs_f64();
            match &p {
                None => none += 1,
                Some(p) => {
                    routed += 1;
                    let drawn: f32 = p.geometry.windows(2).map(|w| w[0].dist_m(&w[1])).sum();
                    let (mut var, mut fix, mut at, mut ok) = (0f32, 0f32, 0u32, true);
                    for st in &p.steps {
                        ok &= (st.from == at || st.from == st.to) && st.to >= st.from && !st.text.is_empty();
                        at = at.max(st.to);
                        var += st.cost.var_m;
                        fix += st.cost.fix_s;
                    }
                    ok &= at as usize == p.geometry.len() - 1 && p.geometry.len() == p.levels.len();
                    ok &= (var - p.cost.var_m).abs() < 0.5 + p.cost.var_m * 1e-3 && (fix - p.cost.fix_s).abs() < 0.5;
                    // Edge lengths in the graph and the drawn line agree to within a few percent.
                    ok &= (drawn - p.dist_m).abs() < 3.0 + p.dist_m * 0.03;
                    ok &= p.geometry[0].dist_m(&from.pos) < 0.5 && p.geometry.last().unwrap().dist_m(&t.pos) < 0.5;
                    if !ok {
                        bad += 1;
                        if bad <= 5 {
                            println!("  INVARIANT: {:.6},{:.6} → {:.6},{:.6} {prof:?}: dist {} drawn {drawn} cost {:?} steps {var}/{fix}", from.pos.lat_deg(), from.pos.lon_deg(), t.pos.lat_deg(), t.pos.lon_deg(), p.dist_m, p.cost);
                        }
                    }
                }
            }
            // one_to_many agrees with route wherever the walk fits the bound
            cmp += 1;
            let secs = p.as_ref().map(|p| p.cost.secs(prof.speed_mps));
            let agree = match (m, secs) {
                (Some(c), Some(sec)) => (c.secs(prof.speed_mps) - sec).abs() < 0.5,
                (None, Some(sec)) => sec > bound - 0.5,
                (None, None) => true,
                (Some(_), None) => false,
            };
            if !agree {
                cmp_bad += 1;
                if cmp_bad <= 5 {
                    println!("  MISMATCH: {:.6},{:.6} → {:.6},{:.6} {prof:?}: one_to_many {:?} route {:?}", from.pos.lat_deg(), from.pos.lon_deg(), t.pos.lat_deg(), t.pos.lon_deg(), m.map(|c| c.secs(prof.speed_mps)), secs);
                }
            }
        }
    }
    println!(
        "selftest: {routed} routes ({none} without a route), {bad} broke an invariant; one_to_many vs route: {cmp_bad} of {cmp} disagree; mean route {:.0} µs, mean one_to_many (12 targets, 15 min) {:.0} µs",
        t_route * 1e6 / (routed + none).max(1) as f64,
        t_many * 1e6 / n.max(1) as f64
    );
    Ok(())
}

/// Nodes where ways of different floors meet without stairs, ramp or lift
/// (`WalkRouter::level_joins`): lists those within `radius` metres of
/// `center` and counts all of them by kind.
fn check(r: &WalkRouter, center: LatLon, radius: f32) {
    use kante_walk::LevelJoinKind;
    let g = r.graph();
    let (mut levels, mut tunnel, mut bridge, mut shown) = (0usize, 0usize, 0usize, 0usize);
    for j in r.level_joins() {
        let what = match j.kind {
            LevelJoinKind::Levels => {
                levels += 1;
                "levels differ      "
            }
            LevelJoinKind::StreetOverTunnel => {
                tunnel += 1;
                "street over tunnel "
            }
            LevelJoinKind::StreetUnderBridge => {
                bridge += 1;
                "street under bridge"
            }
        };
        let p = g.nodes[j.node as usize];
        if p.dist_m(&center) <= radius {
            shown += 1;
            let mut ways: Vec<String> = g
                .incident(j.node)
                .iter()
                .map(|&e| {
                    let ed = &g.edges[e as usize];
                    let l = if ed.a == j.node { ed.level_a } else { ed.level_b };
                    format!("{}:{:?}@{}", g.edge_way.get(e as usize).copied().unwrap_or(0), ed.kind, lvl(l))
                })
                .collect();
            ways.sort();
            ways.dedup();
            println!("  {what} {:.6},{:.6}  {}", p.lat_deg(), p.lon_deg(), ways.join("  "));
        }
    }
    println!("nodes where the router does not change floor for free: {} in the graph", r.level_joins().len());
    println!("  {levels} flat ways of different known levels sharing a node");
    println!("  {tunnel} street-level way and pedestrian tunnel / indoor way below ground crossing in a node");
    println!("  {bridge} street-level way and levelled footbridge crossing in a node");
    println!("({shown} of them within {radius} m of the centre, listed above)");
    let flipped = r.upside_down_edges();
    println!("stairs / escalators / ramps whose end levels are the wrong way round (both ends contradict the ways around them): {}", flipped.len());
    for &e in flipped {
        let ed = &g.edges[e as usize];
        let p = g.nodes[ed.a as usize];
        if p.dist_m(&center) <= radius {
            println!("  upside down  {:.6},{:.6}  way {} {:?} tagged {}→{}", p.lat_deg(), p.lon_deg(), g.edge_way.get(e as usize).copied().unwrap_or(0), ed.kind, lvl(ed.level_a), lvl(ed.level_b));
        }
    }
}

/// Why step-free walks fail: samples random pairs around `center` like
/// `bench`, and for every end point that is cut off from the main step-free
/// network describes the island it sits on and what bounds it.
fn islands(r: &WalkRouter, center: LatLon, radius: f32) -> Result<()> {
    use std::collections::{BTreeMap, HashMap};
    let g = r.graph();
    let prof = WalkProfile::step_free(1.3);
    let comp = r.components(&prof);
    let mut len: HashMap<u32, f32> = HashMap::new();
    for (e, &c) in comp.iter().enumerate() {
        if c != u32::MAX {
            *len.entry(c).or_default() += g.edges[e].len_m();
        }
    }
    let main = len.iter().max_by(|a, b| a.1.partial_cmp(b.1).unwrap()).map(|x| *x.0).unwrap_or(u32::MAX);
    let total: f32 = len.values().sum();
    println!("step-free network: {} pieces, the largest holds {:.1} % of the usable length", len.len(), 100.0 * len[&main] / total);
    for (lo, hi) in [(0.0, 20.0), (20.0, 50.0), (50.0, 150.0), (150.0, 500.0), (500.0, 2000.0), (2000.0, 1e12)] {
        let v: Vec<f32> = len.iter().filter(|x| *x.0 != main && *x.1 >= lo && *x.1 < hi).map(|x| *x.1).collect();
        println!("  pieces of {lo:>4.0}–{:<6} m besides the largest: {:>6}, {:>9.0} m in total", if hi > 1e9 { "∞".to_string() } else { format!("{hi:.0}") }, v.len(), v.iter().sum::<f32>());
    }

    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    let around = |rng: &mut Rng, radius: f32| -> LatLon {
        let b = BBox::around(center, radius);
        LatLon { lat: b.min.lat + ((b.max.lat - b.min.lat) as f32 * rng.next()) as i32, lon: b.min.lon + ((b.max.lon - b.min.lon) as f32 * rng.next()) as i32 }
    };
    let opts = SnapOptions { profile: Some(prof), exclude_kinds: 1 << EdgeKind::Lift as u8, ..Default::default() };
    let (mut pairs, mut failed, mut explained, mut walled) = (0usize, 0usize, 0usize, 0usize);
    let mut hits: HashMap<u32, usize> = HashMap::new();
    while pairs < 2000 {
        let (a, b) = (around(&mut rng, radius), around(&mut rng, radius));
        if !(radius * 0.66..=radius * 1.78).contains(&a.dist_m(&b)) {
            continue;
        }
        let (Some(s), Some(t)) = (r.snap(a, &opts), r.snap(b, &opts)) else { continue };
        pairs += 1;
        if r.route(&s, &t, &prof).is_some() {
            continue;
        }
        failed += 1;
        let (cs, ct) = (comp[s.edge as usize], comp[t.edge as usize]);
        if cs != ct {
            explained += 1;
        }
        for c in [cs, ct] {
            if c == u32::MAX {
                walled += 1; // an edge whose both ends are barrier nodes
            } else if c != main {
                *hits.entry(c).or_default() += 1;
            }
        }
    }
    println!("{failed} of {pairs} random pairs within {radius} m have no step-free route ({explained} of them: ends in different pieces; {walled} ends on an edge between two barrier nodes)");

    let mut list: Vec<(u32, usize)> = hits.into_iter().collect();
    list.sort_by_key(|x| std::cmp::Reverse(x.1));
    // Also the biggest cut-off pieces near the centre, whether sampled or not.
    let mut near: Vec<u32> = (0..comp.len()).filter(|&e| comp[e] != u32::MAX && comp[e] != main && g.nodes[g.edges[e].a as usize].dist_m(&center) <= radius).map(|e| comp[e]).collect();
    near.sort_unstable();
    near.dedup();
    near.sort_by(|a, b| len[b].partial_cmp(&len[a]).unwrap());
    println!("{} cut-off pieces touch the area; the 15 largest follow the sampled ones (marked 0 ends)", near.len());
    for c in near.into_iter().take(15) {
        if !list.iter().any(|x| x.0 == c) {
            list.push((c, 0));
        }
    }
    // piece → its edges
    let mut members: HashMap<u32, Vec<u32>> = HashMap::new();
    for (e, &c) in comp.iter().enumerate() {
        if c != u32::MAX && c != main {
            members.entry(c).or_default().push(e as u32);
        }
    }
    let joins: std::collections::HashSet<u32> = r.level_joins().iter().map(|j| j.node).collect();
    // (description, main thing that bounds the piece)
    let describe = |c: u32| -> (String, &'static str) {
        let edges = &members[&c];
        let mut kinds: BTreeMap<String, f32> = BTreeMap::new();
        let mut nodes: Vec<u32> = Vec::new();
        let (mut lat, mut lon) = (0f64, 0f64);
        for &e in edges {
            let ed = &g.edges[e as usize];
            *kinds.entry(format!("{:?}", ed.kind)).or_default() += ed.len_m();
            nodes.extend([ed.a, ed.b]);
            lat += g.nodes[ed.a as usize].lat_deg();
            lon += g.nodes[ed.a as usize].lon_deg();
        }
        nodes.sort_unstable();
        nodes.dedup();
        // What stops the walker at the rim of the island.
        let mut causes: BTreeMap<&'static str, (usize, LatLon)> = BTreeMap::new();
        let mut add = |k: &'static str, p: LatLon| {
            causes.entry(k).or_insert((0, p)).0 += 1;
        };
        for &n in &nodes {
            let p = g.nodes[n as usize];
            let barrier = g.node_flags[n as usize] & NF_NO_WHEELCHAIR != 0;
            for &f in g.incident(n) {
                if comp[f as usize] == c {
                    continue;
                }
                let fd = &g.edges[f as usize];
                if comp[f as usize] == u32::MAX {
                    add(
                        match fd.kind {
                            EdgeKind::Steps => "stairs",
                            EdgeKind::Escalator => "escalator",
                            _ if fd.flags & EF_WHEELCHAIR_NO != 0 => "way tagged wheelchair=no",
                            _ => "other unusable way",
                        },
                        p,
                    );
                } else if barrier {
                    add("barrier / raised kerb node", p);
                } else if joins.contains(&n) {
                    add("floors joined without connector", p);
                } else {
                    add("other", p);
                }
            }
            if barrier && g.incident(n).iter().all(|&f| comp[f as usize] == c) {
                add("barrier / raised kerb node", p);
            }
        }
        let total: f32 = kinds.values().sum();
        let k: Vec<String> = kinds.iter().map(|(k, v)| format!("{k} {v:.0} m")).collect();
        let cs: Vec<String> = causes.iter().map(|(k, v)| format!("{} × {k} (e.g. {:.6},{:.6})", v.0, v.1.lat_deg(), v.1.lon_deg())).collect();
        let dominant = causes.iter().max_by_key(|x| x.1 .0).map(|x| *x.0).unwrap_or("not connected to the rest of the map at all");
        let text = format!(
            "island of {:.0} m, {} edges around {:.6},{:.6} [{}]; rim: {}",
            total,
            edges.len(),
            lat / edges.len().max(1) as f64,
            lon / edges.len().max(1) as f64,
            k.join(", "),
            if cs.is_empty() { "nothing — not connected to the rest of the map".to_string() } else { cs.join("; ") }
        );
        (text, dominant)
    };
    let mut causes_total: BTreeMap<&'static str, usize> = BTreeMap::new();
    for (c, n) in &list {
        let (text, dominant) = describe(*c);
        *causes_total.entry(dominant).or_default() += n;
        println!("  {n:>3} ends on an {text}");
    }
    println!("unreachable sampled ends by the main thing that bounds their island:");
    for (k, n) in causes_total {
        println!("  {n:>4}  {k}");
    }
    // The whole graph: every cut-off piece big enough to snap to.
    let mut by_cause: BTreeMap<&'static str, (usize, f32)> = BTreeMap::new();
    for (&c, _) in members.iter().filter(|x| len[x.0] >= kante_walk::SNAP_MIN_PIECE_M) {
        let (text, cause) = describe(c);
        if cause == "floors joined without connector" {
            println!("  cut off only by an unmapped floor change: {text}");
        }
        let e = by_cause.entry(cause).or_default();
        e.0 += 1;
        e.1 += len[&c];
    }
    println!("all cut-off pieces of at least {} m in the graph, by the main thing that bounds them:", kante_walk::SNAP_MIN_PIECE_M);
    for (k, (n, l)) in by_cause {
        println!("  {n:>5} pieces, {:>7.1} km  {k}", l / 1000.0);
    }
    Ok(())
}

fn main() -> Result<()> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let take = |flag: &str, args: &mut Vec<String>| -> Option<String> {
        let i = args.iter().position(|a| a == flag)?;
        if i + 1 >= args.len() {
            return None;
        }
        args.remove(i);
        Some(args.remove(i))
    };
    let has = |flag: &str, args: &mut Vec<String>| -> bool {
        match args.iter().position(|a| a == flag) {
            Some(i) => {
                args.remove(i);
                true
            }
            None => false,
        }
    };
    let graph = take("--graph", &mut args).map(PathBuf::from).unwrap_or_else(|| {
        for c in ["data/built/walkgraph-bern.bin", "../data/built/walkgraph-bern.bin", "../../data/built/walkgraph-bern.bin"] {
            if Path::new(c).exists() {
                return PathBuf::from(c);
            }
        }
        PathBuf::from("data/built/walkgraph-bern.bin")
    });
    let speed: f32 = take("--speed", &mut args).map(|s| s.parse()).transpose()?.unwrap_or(1.3);
    let mut profile = if has("--step-free", &mut args) { WalkProfile::step_free(speed) } else { WalkProfile::normal(speed) };
    if has("--avoid-stairs", &mut args) {
        profile.stairs = StairsPref::Avoid;
    }
    if has("--no-lifts", &mut args) {
        profile.lifts = false;
    }
    if has("--no-escalators", &mut args) {
        profile.escalators = false;
    }
    if has("--wheelchair", &mut args) {
        profile.wheelchair = true;
    }
    let edges = has("--edges", &mut args);
    let gj = take("--geojson", &mut args).map(PathBuf::from);
    let gj_dir = take("--geojson-dir", &mut args).map(PathBuf::from);
    let center = take("--center", &mut args);
    let radius: f32 = take("--radius", &mut args).map(|s| s.parse()).transpose()?.unwrap_or(400.0);
    let max_snap: f32 = take("--max-snap", &mut args).map(|s| s.parse()).transpose()?.unwrap_or(40.0);

    let rss0 = rss_mb();
    let t = Instant::now();
    let g: WalkGraph = kante_core::io::load(&graph, WALKGRAPH_SCHEMA)?;
    let t_load = t.elapsed();
    let rss1 = rss_mb();
    let g = Arc::new(g);
    let t = Instant::now();
    let r = Arc::new(WalkRouter::new(g.clone()));
    let t_index = t.elapsed();
    let st = r.index_stats();
    println!(
        "{}: {} nodes, {} edges, {} geometry points, {} names; loaded in {:.2} s ({:.0} MB resident)",
        graph.display(),
        g.nodes.len(),
        g.edges.len(),
        g.geom.len(),
        g.names.len(),
        t_load.as_secs_f64(),
        rss1 - rss0
    );
    println!(
        "index: built in {:.3} s; grid {:.0} m cells, {} cells, {} entries, {:.1} MB; routing net {} nodes, {} arcs, {:.1} MB; {} lift nodes (+{:.0} MB resident)",
        t_index.as_secs_f64(),
        st.grid_cell_m,
        st.grid_cells,
        st.grid_entries,
        st.grid_bytes as f64 / 1e6,
        st.routing_nodes,
        st.arcs,
        st.net_bytes as f64 / 1e6,
        st.lift_nodes,
        rss_mb() - rss1
    );

    match args.first().map(String::as_str) {
        Some("route") if args.len() == 3 => {
            let (from, to) = (parse_place(&args[1])?, parse_place(&args[2])?);
            println!("{profile:?}");
            run_route(&r, &from, &to, &profile, max_snap, edges, gj.as_deref(), false)?;
        }
        Some("bern") => bern(&r, edges, gj_dir.as_deref())?,
        Some("bench") => {
            let c = match center {
                Some(c) => parse_place(&c)?.pos,
                None => LatLon::from_deg(46.94797, 7.44745), // Bern, Zytglogge
            };
            bench(&r, c)?;
        }
        Some("check") => {
            let c = match center {
                Some(c) => parse_place(&c)?.pos,
                None => LatLon::from_deg(46.9488, 7.4391), // Bern station
            };
            check(&r, c, radius);
        }
        Some("islands") => {
            let c = match center {
                Some(c) => parse_place(&c)?.pos,
                None => LatLon::from_deg(46.9488, 7.4391), // Bern station
            };
            islands(&r, c, if radius == 400.0 { 450.0 } else { radius })?;
        }
        Some("selftest") => selftest(&r, args.get(1).map(|n| n.parse()).transpose()?.unwrap_or(3000))?,
        Some("stats") | None => {}
        _ => bail!("usage: walk-route [--graph FILE] route FROM TO [flags] | bern | bench [--center LAT,LON] | check [--center LAT,LON] | stats"),
    }
    Ok(())
}
