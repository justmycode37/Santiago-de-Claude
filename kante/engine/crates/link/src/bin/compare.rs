//! Comparing two builds of the engine on the same raw data (`kante/tools/compare`): the samples to ask both, and
//! the checks on their answers that need the built data.
//!
//! ```text
//! compare sample <data dir> <points> <seed>      sample points, walks and trips (JSON on stdout)
//! compare through <data dir> < walks.jsonl       which straight segments of each walk run through a building
//! compare lifts <walkgraph a> <walkgraph b>       lift edges in one graph and not the other, with their OSM ids
//! compare doors <data dir> <n> <seed>             doors joined to the network only through a building, a sample
//! ```
//!
//! Points: addresses of the official register that lie inside a building outline, points near streets and paths (up
//! to 5 m off a walkable way), and stations' coordinates. Walks: from a point to an address 100 m – 2.5 km away.
//! Trips: between addresses 3 – 60 km apart.
use anyhow::{bail, Context, Result};
use kante_core::geo::LatLon;
use kante_core::*;
use kante_link::doors::DoorIndex;
use rustc_hash::FxHashMap;
use std::io::{BufRead, Write};
use std::path::Path;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    fn unit(&mut self) -> f32 {
        (self.next() >> 40) as f32 / (1u64 << 24) as f32
    }
}

fn load_doors(data: &Path) -> Result<DoorIndex> {
    let d: Doors = io::load(&data.join("built/doors.bin"), DOORS_SCHEMA)?;
    Ok(DoorIndex::new(d))
}

fn pt_json(kind: &str, p: LatLon) -> serde_json::Value {
    serde_json::json!({ "kind": kind, "lat": (p.lat_deg() * 1e6).round() / 1e6, "lon": (p.lon_deg() * 1e6).round() / 1e6 })
}

const PROFILES: [&str; 3] = ["normal", "stepfree", "wheelchair"];

fn sample(data: &Path, n: usize, seed: u64) -> Result<()> {
    let mut rng = Rng(seed.max(1) * 0x9E37_79B9_7F4A_7C15);
    let ix = load_doors(data)?;
    let tt: Timetable = io::load(&data.join("built/timetable.bin"), TIMETABLE_SCHEMA)?;
    let g: WalkGraph = io::load(&data.join("built/walkgraph.bin"), WALKGRAPH_SCHEMA)?;
    let reg = kante_link::register::read(&data.join("raw/register/adr.csv.zip"), None)?;
    let router = kante_walk::WalkRouter::new(std::sync::Arc::new(g));
    let g = router.graph().clone();
    eprintln!("{} addresses, {} buildings, {} edges, {} stations", reg.len(), ix.doors.buildings.len(), g.edges.len(), tt.stations.len());

    // addresses: from the register, inside a building or not
    let mut pool: Vec<LatLon> = Vec::new();
    let mut tries = 0;
    while pool.len() < n * 4 && tries < n * 40 {
        tries += 1;
        pool.push(reg[rng.below(reg.len())].pos);
    }
    let mut points: Vec<serde_json::Value> = Vec::new();
    let mut origins: Vec<LatLon> = Vec::new();
    let push = |points: &mut Vec<serde_json::Value>, origins: &mut Vec<LatLon>, kind: &str, p: LatLon| {
        points.push(pt_json(kind, p));
        origins.push(p);
    };
    // 40 %: addresses (inside a building or not, as the register has them)
    for p in pool.iter().take(n * 2 / 5) {
        push(&mut points, &mut origins, if ix.buildings_at(*p).is_empty() { "address-out" } else { "address" }, *p);
    }
    // 20 %: points beside streets and paths on the ground, up to 5 m off them
    let walkable = |e: &WalkEdge| {
        matches!(e.kind, EdgeKind::Sidewalk | EdgeKind::Footway | EdgeKind::Path | EdgeKind::Road | EdgeKind::Pedestrian | EdgeKind::Crossing)
            && e.flags & (EF_TUNNEL | EF_BRIDGE | EF_INDOOR) == 0
    };
    let mut k = 0;
    while k < n / 5 {
        let e = rng.below(g.edges.len());
        if !walkable(&g.edges[e]) {
            continue;
        }
        let geom = g.edge_geom(e as u32);
        let i = rng.below(geom.len() - 1);
        let (a, b) = (geom[i].xy(), geom[i + 1].xy());
        let t = rng.unit();
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let l = (dx * dx + dy * dy).sqrt().max(1e-3);
        let off = (rng.unit() * 2.0 - 1.0) * 5.0;
        push(&mut points, &mut origins, "street", LatLon::from_xy(a.0 + dx * t - dy / l * off, a.1 + dy * t + dx / l * off));
        k += 1;
    }
    // 10 % station coordinates, 10 % stations by id
    let swiss: Vec<&Station> = tt.stations.iter().filter(|s| s.didok / 100_000 == 85 && !s.pos.is_none()).collect();
    for _ in 0..n / 10 {
        push(&mut points, &mut origins, "station", swiss[rng.below(swiss.len())].pos);
    }
    for _ in 0..n / 10 {
        let s = swiss[rng.below(swiss.len())];
        let mut v = pt_json("station-id", s.pos);
        v["id"] = serde_json::json!(format!("st:{}", s.gtfs_id));
        points.push(v);
        origins.push(s.pos);
    }
    // 12 %: off the network (fields, forests, parks, mountains, water's edge): anywhere in the country's box more
    // than 50 m from every walkable way, within 1 km of one
    let (lat0, lat1, lon0, lon1) = (45.82, 47.81, 5.96, 10.49);
    let off_opts = |m: f32| kante_walk::SnapOptions { max_dist_m: m, level: None, profile: None, exclude_kinds: 0 };
    let mut k = 0;
    while k < n * 12 / 100 {
        let p = LatLon::from_deg(lat0 + (lat1 - lat0) * rng.unit() as f64, lon0 + (lon1 - lon0) * rng.unit() as f64);
        if router.snap(p, &off_opts(50.0)).is_none() && router.snap(p, &off_opts(1000.0)).is_some() {
            push(&mut points, &mut origins, "off-network", p);
            k += 1;
        }
    }
    // the rest: near the border (within 3 km of a stop outside Switzerland), on the network or not
    let foreign: Vec<&Stop> = tt.stops.iter().filter(|s| tt.stations[s.station as usize].didok / 100_000 != 85 && !s.pos.is_none() && s.pos.lat_deg() > lat0 && s.pos.lat_deg() < lat1 && s.pos.lon_deg() > lon0 && s.pos.lon_deg() < lon1).collect();
    while points.len() < n && !foreign.is_empty() {
        let s = foreign[rng.below(foreign.len())];
        let (x, y) = s.pos.xy();
        let p = LatLon::from_xy(x + (rng.unit() * 2.0 - 1.0) * 3000.0, y + (rng.unit() * 2.0 - 1.0) * 3000.0);
        if router.snap(p, &off_opts(1000.0)).is_some() {
            push(&mut points, &mut origins, "border", p);
        }
    }

    // walks: from each point to an address 100 m – 2.5 km away
    let cell = |p: &LatLon| {
        let (x, y) = p.xy();
        ((x / 1000.0).floor() as i32, (y / 1000.0).floor() as i32)
    };
    let mut grid: FxHashMap<(i32, i32), Vec<u32>> = FxHashMap::default();
    for (i, p) in pool.iter().enumerate() {
        grid.entry(cell(p)).or_default().push(i as u32);
    }
    let mut walks = Vec::new();
    for (i, o) in origins.iter().enumerate() {
        let (cx, cy) = cell(o);
        for _ in 0..20 {
            let c = (cx + rng.below(5) as i32 - 2, cy + rng.below(5) as i32 - 2);
            let Some(v) = grid.get(&c) else { continue };
            let d = pool[v[rng.below(v.len())] as usize];
            let m = o.dist_m(&d);
            if (100.0..=2500.0).contains(&m) {
                walks.push(serde_json::json!({ "from": points[i], "to": pt_json("address", d), "profile": PROFILES[i % 3] }));
                break;
            }
        }
    }
    // trips: from any sampled point to an address 3 – 60 km away, at an hour from 05:00 to 23:00, in each profile
    let mut trips = Vec::new();
    let mut t = 0;
    while trips.len() < n / 5 && t < n * 50 {
        t += 1;
        let i = rng.below(points.len());
        let b = pool[rng.below(pool.len())];
        if (3000.0..=60000.0).contains(&origins[i].dist_m(&b)) {
            let k = trips.len();
            trips.push(serde_json::json!({ "from": points[i], "to": pt_json("address", b), "hour": 5 + (k * 7) % 19, "profile": PROFILES[k % 3] }));
        }
    }
    eprintln!("{} points, {} walks, {} trips", points.len(), walks.len(), trips.len());
    serde_json::to_writer(std::io::stdout().lock(), &serde_json::json!({ "seed": seed, "points": points, "walks": walks, "trips": trips }))?;
    Ok(())
}

/// Does the straight line p → q run through a building, by sampling and nothing of the engine's test: points every
/// 25 cm (the last `trim_m` before q left out: the walkway under an arcade); it runs through a building when some
/// of them are inside it (more than 30 cm from its outline) and some clearly outside it (likewise). A line that
/// stays inside one building end to end (to its own corridor, to its door on the outline) does not.
fn through_sampled(ix: &DoorIndex, p: LatLon, q: LatLon, trim_m: f32) -> bool {
    let len = p.dist_m(&q);
    let usable = (len - trim_m).max(0.0);
    if usable < 0.4 {
        return false;
    }
    let (a, b) = (p.xy(), q.xy());
    let n = (usable / 0.25).ceil() as usize;
    let pts: Vec<(f32, f32)> = (0..=n).map(|k| {
        let t = (k as f32 * 0.25).min(usable) / len;
        (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
    }).collect();
    ix.buildings_near(p, q).into_iter().any(|bld| {
        let r = ix.rings_of(bld);
        let (mut inn, mut out) = (false, false);
        for &x in &pts {
            let d = kante_link::doors::outline_dist_pub(x, &r);
            if d > 0.3 {
                if kante_link::doors::inside_pub(x, &r) {
                    inn = true;
                } else {
                    out = true;
                }
            }
        }
        inn && out
    })
}

/// The wheelchair walk between two nodes (lat, lon, lat, lon) in two graphs: seconds and edges.
fn hop(a: &Path, b: &Path, c: [f64; 4]) -> Result<()> {
    let prof = WalkProfile { speed_mps: 1.3, stairs: StairsPref::Never, escalators: false, lifts: true, wheelchair: true };
    for p in [a, b] {
        let g: WalkGraph = io::load(p, WALKGRAPH_SCHEMA)?;
        let r = kante_walk::WalkRouter::new(std::sync::Arc::new(g));
        let o = kante_walk::SnapOptions { max_dist_m: 0.2, level: None, profile: None, exclude_kinds: 0 };
        let (x, y) = (r.snap(LatLon::from_deg(c[0], c[1]), &o), r.snap(LatLon::from_deg(c[2], c[3]), &o));
        match (x, y) {
            (Some(x), Some(y)) => {
                let w = r.route(&x, &y, &prof).map(|w| walk_secs(w.cost.var_m, w.cost.fix_s, 1.3));
                let d = r.one_to_many(&x, &[y], &prof, 3600.0)[0].map(|c| c.secs(1.3));
                println!("  dijkstra {d:?}");
                let g = r.graph();
                let ye = &g.edges[y.edge as usize];
                let mut ts: Vec<(u32, f32)> = (0..=4).map(|k| (y.edge, k as f32 / 4.0)).collect();
                for n in [ye.a, ye.b] {
                    for &e in &g.adj[g.adj_off[n as usize] as usize..g.adj_off[n as usize + 1] as usize] {
                        if e != y.edge {
                            ts.push((e, if g.edges[e as usize].a == n { 0.02 } else { 0.98 }));
                        }
                    }
                }
                let snaps: Vec<Snap> = ts.iter().map(|&(e, f)| r.snap_at(e, f)).collect();
                let cs = r.one_to_many(&x, &snaps, &prof, 3600.0);
                let one: Vec<Option<f32>> = snaps.iter().map(|t| r.one_to_many(&x, std::slice::from_ref(t), &prof, 3600.0)[0].map(|c| c.secs(1.3))).collect();
                for ((t, c), o) in ts.iter().zip(&cs).zip(&one) {
                    println!("    edge {} way {} at {:.2}: {:?} (alone {:?})", t.0, g.edge_way[t.0 as usize], t.1, c.map(|c| c.secs(1.3)), o);
                }
                for j in r.level_joins() {
                    let p = r.graph().nodes[j.node as usize];
                    if p.dist_m(&LatLon::from_deg(c[2], c[3])) < 30.0 {
                        println!("  level join at node {} {:.6},{:.6}: {:?}", j.node, p.lat_deg(), p.lon_deg(), j);
                    }
                }
                for q in [LatLon::from_deg(c[2], c[3])] {
                    for (n, np) in r.graph().nodes.iter().enumerate() {
                        if np.dist_m(&q) < 0.5 {
                            println!("  node {n}: arcs {:?}", r.arcs_at(n as u32));
                        }
                    }
                }
                let ud = r.upside_down_edges();
                let g = r.graph();
                for (e, ed) in g.edges.iter().enumerate() {
                    if g.nodes[ed.a as usize].dist_m(&LatLon::from_deg(c[2], c[3])) < 30.0 && ud.contains(&(e as u32)) {
                        println!("  upside-down edge {e} way {}", g.edge_way[e]);
                    }
                }
                let e = r.route_edges(&x, &y, &prof).unwrap_or_default();
                println!("{}: {:?} s via {:?}; from {:?} to {:?}", p.display(), w, e.iter().map(|x| (x.0, r.graph().edge_way[x.0 as usize])).collect::<Vec<_>>(), x, y);
            }
            _ => println!("{}: no snap", p.display()),
        }
    }
    Ok(())
}

/// One straight line (lat, lon, lat, lon): the buildings near it, and what the sampled test and the engine's say.
fn segment(data: &Path, c: [f64; 4]) -> Result<()> {
    let ix = load_doors(data)?;
    let (p, q) = (LatLon::from_deg(c[0], c[1]), LatLon::from_deg(c[2], c[3]));
    println!("{:.1} m; sampled: {}, engine: {}", p.dist_m(&q), through_sampled(&ix, p, q, 0.0), ix.through(p, q, 0.0));
    for b in ix.buildings_near(p, q) {
        let r = ix.rings_of(b);
        let (x, y) = (p.xy(), q.xy());
        println!(
            "  building {b}: {} rings, {} points; p inside {} ({:.2} m from outline), q inside {} ({:.2} m), alone sampled {} engine {}",
            r.len(),
            r[0].len(),
            kante_link::doors::inside_pub(x, &r),
            kante_link::doors::outline_dist_pub(x, &r),
            kante_link::doors::inside_pub(y, &r),
            kante_link::doors::outline_dist_pub(y, &r),
            {
                let n = 40;
                let (mut i, mut o) = (false, false);
                for k in 0..=n {
                    let t = k as f32 / n as f32;
                    let z = (x.0 + (y.0 - x.0) * t, x.1 + (y.1 - x.1) * t);
                    let d = kante_link::doors::outline_dist_pub(z, &r);
                    if d > 0.2 {
                        if kante_link::doors::inside_pub(z, &r) { i = true } else { o = true }
                    }
                }
                i && o
            },
            kante_link::doors::through_building(x, y, 0.0, std::iter::once(r.as_slice()))
        );
        let len = p.dist_m(&q);
        for k in 0..=20 {
            let t = k as f32 / 20.0;
            let z = (x.0 + (y.0 - x.0) * t, x.1 + (y.1 - x.1) * t);
            print!(" {:.1}:{}{:.2}", t * len, if kante_link::doors::inside_pub(z, &r) { "in" } else { "out" }, kante_link::doors::outline_dist_pub(z, &r));
        }
        println!();
        println!("    ring {:?}", r[0]);
        println!("    p {:?} q {:?}", x, y);
    }
    Ok(())
}

/// For each walk (`{"key", "geometry": [[lon, lat], …], "arcade": [[segment, network end first], …]}` per line):
/// the segments that run through a building ([`through_sampled`]).
fn through(data: &Path) -> Result<()> {
    let ix = load_doors(data)?;
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let v: serde_json::Value = serde_json::from_str(&line?)?;
        let geom: Vec<LatLon> = v["geometry"].as_array().context("geometry")?.iter().map(|c| LatLon::from_deg(c[1].as_f64().unwrap_or(0.0), c[0].as_f64().unwrap_or(0.0))).collect();
        // segments onto a way under an arcade: (segment, its network end is its first point); the last 5 m before
        // the way do not count, as in the engine
        let arcade: Vec<(usize, bool)> = v["arcade"].as_array().map(|a| a.iter().filter_map(|x| Some((x[0].as_u64()? as usize, x[1].as_bool()?))).collect()).unwrap_or_default();
        let through_seg = |i: usize| match arcade.iter().find(|a| a.0 == i) {
            Some(&(_, true)) => through_sampled(&ix, geom[i + 1], geom[i], 5.0),
            Some(&(_, false)) => through_sampled(&ix, geom[i], geom[i + 1], 5.0),
            None => through_sampled(&ix, geom[i], geom[i + 1], 0.0),
        };
        let segs: Vec<usize> = (0..geom.len().saturating_sub(1)).filter(|&i| through_seg(i)).collect();
        writeln!(out, "{}", serde_json::json!({ "key": v["key"], "through": segs }))?;
    }
    Ok(())
}

/// Lift edges in one graph and not the other, by lift (OSM way id, 0 for a lift mapped as a node) and place, each
/// with what the other graph has there: the same ways joined at one node (no lift needed), a lift between other
/// floors, or nothing (the ways are not joined there).
fn lifts(a: &Path, b: &Path) -> Result<()> {
    let ga: WalkGraph = io::load(a, WALKGRAPH_SCHEMA)?;
    let gb: WalkGraph = io::load(b, WALKGRAPH_SCHEMA)?;
    type Key = (i64, i8, i8, (i32, i32));
    let key = |g: &WalkGraph, e: usize| -> Key {
        let ed = &g.edges[e];
        let p = g.nodes[ed.a as usize];
        (g.edge_way[e], ed.level_a.min(ed.level_b), ed.level_a.max(ed.level_b), (p.lat / 10, p.lon / 10))
    };
    let lift_keys = |g: &WalkGraph| -> Vec<(Key, usize)> {
        let mut v: Vec<(Key, usize)> = (0..g.edges.len()).filter(|&e| g.edges[e].kind == EdgeKind::Lift).map(|e| (key(g, e), e)).collect();
        v.sort_unstable();
        v
    };
    let (la, lb) = (lift_keys(&ga), lift_keys(&gb));
    // nodes by 1e-6° cell, for "what is there in the other graph"
    let index = |g: &WalkGraph| {
        let mut m: FxHashMap<(i32, i32), Vec<u32>> = FxHashMap::default();
        for (i, n) in g.nodes.iter().enumerate() {
            m.entry((n.lat / 10, n.lon / 10)).or_default().push(i as u32);
        }
        m
    };
    let (ia, ib) = (index(&ga), index(&gb));
    let ways_at = |g: &WalkGraph, n: u32| -> Vec<i64> {
        let mut w: Vec<i64> = g.adj[g.adj_off[n as usize] as usize..g.adj_off[n as usize + 1] as usize].iter().filter(|&&e| g.edges[e as usize].kind != EdgeKind::Lift).map(|&e| g.edge_way[e as usize]).collect();
        w.sort_unstable();
        w.dedup();
        w
    };
    let lv = |l: i8| if l == LEVEL_NONE { "?".to_string() } else { format!("{}", l as f32 / 2.0) };
    let mut groups: std::collections::BTreeMap<(i64, (i32, i32)), (Vec<String>, Vec<String>, String)> = Default::default();
    for (name, (x, gx), (y, gy, iy)) in [("removed", (&la, &ga), (&lb, &gb, &ib)), ("added", (&lb, &gb), (&la, &ga, &ia))] {
        for (k, e) in x.iter() {
            if y.binary_search_by(|(ky, _)| ky.cmp(k)).is_ok() {
                continue;
            }
            let g = gx;
            let ed = &g.edges[*e];
            // the ways the lift edge joins (at each end), and whether the other graph joins them there (within 5 m):
            // at one node, or by a lift edge between a node with the one and a node with the other
            let (wa, wb) = (ways_at(g, ed.a), ways_at(g, ed.b));
            let mut want: Vec<i64> = wa.iter().chain(wb.iter()).copied().collect();
            want.sort_unstable();
            want.dedup();
            let cell = k.3;
            let mut nodes: Vec<u32> = Vec::new();
            for dl in -6..=6 {
                for dn in -8..=8 {
                    if let Some(v) = iy.get(&(cell.0 + dl, cell.1 + dn)) {
                        nodes.extend(v.iter().copied().filter(|&n| gy.nodes[n as usize].dist_m(&g.nodes[ed.a as usize]) < 5.0));
                    }
                }
            }
            let has = |n: u32, w: &[i64]| {
                let x = ways_at(gy, n);
                !w.is_empty() && w.iter().any(|v| x.contains(v))
            };
            let one_node = nodes.iter().any(|&n| has(n, &wa) && has(n, &wb));
            let by_lift = nodes.iter().any(|&n| {
                has(n, &wa)
                    && gy.adj[gy.adj_off[n as usize] as usize..gy.adj_off[n as usize + 1] as usize].iter().any(|&e| {
                        let le = &gy.edges[e as usize];
                        le.kind == EdgeKind::Lift && has(if le.a == n { le.b } else { le.a }, &wb)
                    })
            });
            let what = if one_node {
                "joined at one node"
            } else if by_lift {
                "joined by a lift"
            } else {
                "not joined there"
            };
            let gr = groups.entry((k.0, (cell.0 / 100, cell.1 / 100))).or_insert_with(|| (Vec::new(), Vec::new(), String::new()));
            let s = format!("{}–{} ({what}; ways {:?})", lv(k.1), lv(k.2), want);
            if name == "removed" {
                gr.0.push(s);
            } else {
                gr.1.push(s);
            }
            gr.2 = format!("{:.5},{:.5}", g.nodes[ed.a as usize].lat_deg(), g.nodes[ed.a as usize].lon_deg());
        }
    }
    let mut out = std::io::stdout().lock();
    writeln!(out, "lift edges: {} in A, {} in B; {} lifts differ", la.len(), lb.len(), groups.len())?;
    for ((id, _), (rem, add, at)) in &groups {
        writeln!(out, "{} at {at}", if *id == 0 { "node lift".to_string() } else { format!("way {id}") })?;
        for r in rem {
            writeln!(out, "   - {r}")?;
        }
        for a in add {
            writeln!(out, "   + {a}")?;
        }
    }
    Ok(())
}

fn doors(data: &Path, n: usize, seed: u64) -> Result<()> {
    let ix = load_doors(data)?;
    let _ = GRAPH.set(io::load(&data.join("built/walkgraph.bin"), WALKGRAPH_SCHEMA)?);
    let d = &ix.doors;
    let mut rng = Rng(seed.max(1) * 0x9E37_79B9_7F4A_7C15);
    let all: Vec<u32> = (0..d.doors.len() as u32).filter(|&i| !d.attach_of(i).is_empty() && d.attach_of(i).iter().all(|a| a.through())).collect();
    eprintln!("{} of {} doors joined only through a building", all.len(), d.doors.len());
    let mut out = std::io::stdout().lock();
    let owner = |i: u32| d.buildings.partition_point(|b| b.door_off + b.door_len as u32 <= i) as u32;
    let (mut own, mut other, mut sub) = (0, 0, 0);
    let m = 5000.min(all.len());
    for k in 0..m {
        let i = all[rng.below(all.len())];
        let door = &d.doors[i as usize];
        let a = d.attach_of(i)[0];
        let b = owner(i);
        let q = kante_walk_point(&ix, a);
        let rings = ix.rings_of(b);
        let own_hit = kante_link::doors::through_building(door.pos.xy(), q.xy(), 0.0, std::iter::once(rings.as_slice()));
        if own_hit {
            own += 1
        } else {
            other += 1
        }
        if d.addr_of(i).split(' ').last().is_some_and(|n| n.contains('.')) {
            sub += 1;
        }
        if k < n {
            writeln!(out, "{:.6},{:.6} {} {:?} line {:.1} m, through {}", door.pos.lat_deg(), door.pos.lon_deg(), d.addr_of(i), door.kind, a.dist_m(), if own_hit { "its own building" } else { "another" })?;
        }
    }
    writeln!(out, "of {m}: through its own building {own}, only through another {other}; sub-addresses (\"5.1\") {sub}")?;
    Ok(())
}

/// `links.bin` as `main` writes it (`links-v2`: before the links named the graph and timetable they were made from).
#[derive(serde::Deserialize)]
struct LinkDataV2 {
    links: Vec<StopLink>,
    #[allow(dead_code)]
    normal: Footpaths,
    #[allow(dead_code)]
    step_free: Footpaths,
}

fn load_links(data: &Path) -> Result<Vec<StopLink>> {
    let p = data.join("built/links.bin");
    match io::schema_of(&p).as_deref() {
        Some("links-v2") => Ok(io::load::<LinkDataV2>(&p, "links-v2")?.links),
        _ => Ok(io::load::<LinkData>(&p, LINKS_SCHEMA)?.links),
    }
}

fn profile_of(o: &serde_json::Value) -> WalkProfile {
    let stairs = match o["stairs"].as_str() {
        Some("never") => StairsPref::Never,
        Some("avoid") => StairsPref::Avoid,
        _ => StairsPref::Ok,
    };
    let wheelchair = o["wheelchair"].as_bool().unwrap_or(false);
    WalkProfile { speed_mps: 1.3, stairs, escalators: o["escalators"].as_bool().unwrap_or(true) && !wheelchair, lifts: true, wheelchair }
}

/// Why A (`main`) reaches a stop that B does not, from the built data of both, for each line of stdin
/// (`{"point": {lat, lon} or {id: "st:…"}, "options": {…}, "limit": min, "stop": gtfs id, "a_secs": s}`):
///
/// - `relinked`: B joins the stop to the network elsewhere (another edge, or more than 0.5 m away);
/// - `graph: <what>`: A's own walk to the stop, recomputed on A's graph as A computes it (A's snap, A's link),
///   uses an edge that B's graph does not have as it is: a lift edge, a connector the import made (way 0), a
///   straight line across an area, an edge whose tags changed, or another;
/// - `unexplained`: A's walk runs on edges B has unchanged, to the same link.
///
/// `reproduced` says whether the recomputed walk takes A's time (to the second, with the 30 s buffer).
fn explain(a_dir: &Path, b_dir: &Path) -> Result<()> {
    let tt: Timetable = io::load(&b_dir.join("built/timetable.bin"), TIMETABLE_SCHEMA)?;
    let ga: WalkGraph = io::load(&a_dir.join("built/walkgraph.bin"), WALKGRAPH_SCHEMA)?;
    let gb: WalkGraph = io::load(&b_dir.join("built/walkgraph.bin"), WALKGRAPH_SCHEMA)?;
    let (la, lb) = (load_links(a_dir)?, load_links(b_dir)?);
    let ra = kante_walk::WalkRouter::new(std::sync::Arc::new(ga));
    let ga = ra.graph().clone();
    let rb = kante_walk::WalkRouter::new(std::sync::Arc::new(gb));
    let gb = rb.graph().clone();
    // B's edges by the points of their geometry
    let mut at: FxHashMap<(i32, i32), Vec<u32>> = FxHashMap::default();
    for e in 0..gb.edges.len() as u32 {
        for p in gb.edge_geom(e) {
            at.entry((p.lat, p.lon)).or_default().push(e);
        }
    }
    let same = |x: &WalkEdge, y: &WalkEdge| x.kind == y.kind && x.flags == y.flags && x.steps == y.steps && (x.level_a, x.level_b) == (y.level_a, y.level_b) || x.kind == y.kind && x.flags == y.flags && x.steps == y.steps && (x.level_a, x.level_b) == (y.level_b, y.level_a);
    // does B have A's edge `e`: edges of the same way, kind, tags and floors whose geometry holds every point of it,
    // as long as it (split where B has a node A has not) or one edge that holds all of it?
    let b_has = |e: u32| -> Option<&'static str> {
        let ea = &ga.edges[e as usize];
        let way = ga.edge_way[e as usize];
        let pts = ga.edge_geom(e);
        let mut cand: Vec<u32> = pts.iter().flat_map(|p| at.get(&(p.lat, p.lon)).cloned().unwrap_or_default()).filter(|&f| gb.edge_way[f as usize] == way && gb.edges[f as usize].kind == ea.kind).collect();
        cand.sort_unstable();
        cand.dedup();
        let what = || {
            if ea.kind == EdgeKind::Lift {
                "a lift edge"
            } else if way == 0 {
                "a connector the import made (way 0)"
            } else if ea.flags & EF_AREA != 0 {
                "a straight line across an area"
            } else {
                "an edge of a way"
            }
        };
        if cand.is_empty() {
            return Some(what());
        }
        let tagged: Vec<u32> = cand.iter().copied().filter(|&f| same(ea, &gb.edges[f as usize])).collect();
        if tagged.is_empty() {
            return Some(if ea.kind == EdgeKind::Lift { "a lift edge, other floors" } else { "an edge whose tags or floors changed" });
        }
        let covered = pts.iter().all(|p| tagged.iter().any(|&f| gb.edge_geom(f).iter().any(|q| q.lat == p.lat && q.lon == p.lon)));
        let one = tagged.iter().any(|&f| pts.iter().all(|p| gb.edge_geom(f).iter().any(|q| q.lat == p.lat && q.lon == p.lon)));
        let len: f32 = tagged.iter().map(|&f| gb.edges[f as usize].len_m()).sum();
        if covered && (one || (len - ea.len_m()).abs() < 0.5 + 0.01 * ea.len_m()) {
            return None;
        }
        // split differently: B joins the edge's two ends along edges of the same way, kind and tags
        let (pa, pb) = (ga.nodes[ea.a as usize], ga.nodes[ea.b as usize]);
        let starts: Vec<u32> = at.get(&(pa.lat, pa.lon)).into_iter().flatten().flat_map(|&f| [gb.edges[f as usize].a, gb.edges[f as usize].b]).filter(|&m| gb.nodes[m as usize] == pa).collect();
        let mut seen: Vec<u32> = starts.clone();
        let mut todo = starts;
        while let Some(m) = todo.pop() {
            if gb.nodes[m as usize] == pb {
                return None;
            }
            if seen.len() > 200 {
                break;
            }
            for &f in &gb.adj[gb.adj_off[m as usize] as usize..gb.adj_off[m as usize + 1] as usize] {
                let fe = &gb.edges[f as usize];
                if gb.edge_way[f as usize] != way || !same(ea, fe) {
                    continue;
                }
                let o = if fe.a == m { fe.b } else { fe.a };
                if !seen.contains(&o) {
                    seen.push(o);
                    todo.push(o);
                }
            }
        }
        Some(what())
    };
    let by_id: FxHashMap<&str, usize> = tt.stops.iter().enumerate().map(|(i, s)| (s.gtfs_id.as_str(), i)).collect();
    let st_by_id: FxHashMap<&str, usize> = tt.stations.iter().enumerate().map(|(i, s)| (s.gtfs_id.as_str(), i)).collect();
    let mut out = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let v: serde_json::Value = serde_json::from_str(&line?)?;
        let prof = profile_of(&v["options"]);
        let stop = *by_id.get(v["stop"].as_str().unwrap_or("")).context("stop")?;
        let (a_link, b_link) = (&la[stop], &lb[stop]);
        let pos_of = |s: &Snap| s.pos;
        let relinked = a_link.matched == LinkMatch::None
            || b_link.matched == LinkMatch::None
            || pos_of(&a_link.snap).dist_m(&pos_of(&b_link.snap)) > 0.5
            || ga.edge_way[a_link.snap.edge as usize] != gb.edge_way[b_link.snap.edge as usize];
        // A's start: a station by id as A enters it, else A's snap of the point
        let pt = &v["point"];
        let start = |r: &kante_walk::WalkRouter| -> Result<Option<Snap>> {
            Ok(if let Some(id) = pt["id"].as_str() {
                let st = &tt.stations[*st_by_id.get(id.trim_start_matches("st:")).context("station")?];
                r.snap(st.pos, &kante_walk::SnapOptions { max_dist_m: 120.0, level: Some(0), profile: Some(prof), exclude_kinds: NO_STEP_KINDS | (1 << EdgeKind::Platform as u8) })
                    .or_else(|| kante_link::ends::snap_main(r, st.pos, &prof))
            } else {
                kante_link::ends::snap_main(r, LatLon::from_deg(pt["lat"].as_f64().unwrap_or(0.0), pt["lon"].as_f64().unwrap_or(0.0)), &prof)
            })
        };
        // a change in a journey: from one boarding point to another, each at its link
        let from_stop = v["from_stop"].as_str().and_then(|id| by_id.get(id).copied());
        let (snap, snap_b) = match from_stop {
            Some(f) => (Some(la[f].snap).filter(|_| la[f].matched != LinkMatch::None), Some(lb[f].snap).filter(|_| lb[f].matched != LinkMatch::None)),
            None => (start(&ra)?, start(&rb)?),
        };
        let mut cause = String::new();
        let from_relinked = from_stop.is_some_and(|f| match (snap, snap_b) {
            (Some(x), Some(y)) => x.pos.dist_m(&y.pos) > 0.5 || ga.edge_way[x.edge as usize] != gb.edge_way[y.edge as usize],
            _ => true,
        });
        // where B starts the walk A takes: the same way, else why not (a step-free walker is not put on a piece of path
        // that stairs cut off, and B's pieces differ where its graph does)
        if from_relinked {
            cause = "relinked (the first boarding point)".into();
        } else if let (Some(sa), Some(sb)) = (snap, snap_b) {
            if sa.pos.dist_m(&sb.pos) > 0.5 || ga.edge_way[sa.edge as usize] != gb.edge_way[sb.edge as usize] {
                let on_a: Vec<u32> = at.get(&(ga.nodes[ga.edges[sa.edge as usize].a as usize].lat, ga.nodes[ga.edges[sa.edge as usize].a as usize].lon)).cloned().unwrap_or_default();
                let crumb = on_a.iter().any(|&f| gb.edge_way[f as usize] == ga.edge_way[sa.edge as usize] && !rb.usable(f, &prof));
                cause = format!(
                    "snap: B starts elsewhere ({}{:?}, way {}, {:.1} m) than A ({:?}, way {}, {:.1} m)",
                    if crumb { "A's way is cut off by stairs in B, so on " } else { "" },
                    gb.edges[sb.edge as usize].kind,
                    gb.edge_way[sb.edge as usize],
                    sb.dist_m,
                    ga.edges[sa.edge as usize].kind,
                    ga.edge_way[sa.edge as usize],
                    sa.dist_m
                );
            }
        }
        let mut reproduced = false;
        if let Some(sn) = snap {
            if let Some(path) = ra.route(&sn, &a_link.snap, &prof) {
                let secs = walk_secs(path.cost.var_m + sn.dist_m + a_link.snap.dist_m, path.cost.fix_s, prof.speed_mps).ceil() as i64 + 30;
                reproduced = v["a_secs"].as_i64().is_some_and(|a| (a - secs).abs() <= 1);
                let edges = ra.route_edges(&sn, &a_link.snap, &prof).unwrap_or_default();
                if std::env::var_os("COMPARE_VERBOSE").is_some() {
                    for &(e, f0, f1) in &edges {
                        let ed = &ga.edges[e as usize];
                        let (pa, pb) = (ga.nodes[ed.a as usize], ga.nodes[ed.b as usize]);
                        eprintln!("A edge {e} {:?} way {} flags {:#x} levels {}/{} {:.1} m [{f0:.2}..{f1:.2}] {:.6},{:.6} -> {:.6},{:.6}: in B {:?}", ed.kind, ga.edge_way[e as usize], ed.flags, ed.level_a, ed.level_b, ed.len_m(), pa.lat_deg(), pa.lon_deg(), pb.lat_deg(), pb.lon_deg(), b_has(e));
                    }
                    eprintln!("A snap {:?}\nB snap {:?}", snap, snap_b);
                    if let (Some(sb), Some(pb)) = (snap_b, rb.route(&snap_b.unwrap(), &b_link.snap, &prof)) {
                        let _ = sb;
                        eprintln!("A {:.0} s, B {:.0} s on its own graph", walk_secs(path.cost.var_m, path.cost.fix_s, 1.3), walk_secs(pb.cost.var_m, pb.cost.fix_s, 1.3));
                        let eb = rb.route_edges(&snap_b.unwrap(), &b_link.snap, &prof).unwrap_or_default();
                        for &(e, _, _) in eb.iter().take(60) {
                            let ed = &gb.edges[e as usize];
                            let pa = gb.nodes[ed.a as usize];
                            eprint!("{}:{:?}@{:.5},{:.5} ", gb.edge_way[e as usize], ed.kind, pa.lat_deg(), pa.lon_deg());
                        }
                        eprintln!();
                        for &(e, _, _) in edges.iter().take(60) {
                            let ed = &ga.edges[e as usize];
                            let pa = ga.nodes[ed.a as usize];
                            eprint!("{}:{:?}@{:.5},{:.5} ", ga.edge_way[e as usize], ed.kind, pa.lat_deg(), pa.lon_deg());
                        }
                        eprintln!();
                        // the first point along A's walk that B reaches later than A does
                        let o = kante_walk::SnapOptions { max_dist_m: 0.2, level: None, profile: Some(prof), exclude_kinds: 0 };
                        let mids: Vec<Snap> = edges.iter().map(|&(e, _, _)| ra.snap_at(e, 0.5)).collect();
                        let ta: Vec<Snap> = mids.clone();
                        let tbs: Vec<Option<Snap>> = mids.iter().map(|m| rb.snap(m.pos, &o)).collect();
                        let ca = ra.one_to_many(&sn, &ta, &prof, 3600.0);
                        let tbv: Vec<Snap> = tbs.iter().map(|t| t.unwrap_or(mids[0])).collect();
                        let cb = rb.one_to_many(&snap_b.unwrap(), &tbv, &prof, 3600.0);
                        let mut last = 0f32;
                        for (k, &(e, _, _)) in edges.iter().enumerate() {
                            let (x, y) = (ca[k].map(|c| c.secs(1.3)), cb[k].map(|c| c.secs(1.3)));
                            let d = y.unwrap_or(9e9) - x.unwrap_or(0.0);
                            if (d - last).abs() > 3.0 {
                                let ed = &ga.edges[e as usize];
                                let (pa, pb) = (ga.nodes[ed.a as usize], ga.nodes[ed.b as usize]);
                                eprintln!("  edge {k} way {} {:?} {:.6},{:.6} -> {:.6},{:.6}: A {x:?} B {y:?} (B snap {:?})", ga.edge_way[e as usize], ed.kind, pa.lat_deg(), pa.lon_deg(), pb.lat_deg(), pb.lon_deg(), tbs[k].map(|t| (t.edge, gb.edge_way[t.edge as usize])));
                                last = d;
                            }
                        }
                        for &(e, _, f1) in edges.iter().take(0) {
                            let ed = &ga.edges[e as usize];
                            let n = if f1 > 0.5 { ed.b } else { ed.a };
                            let pos = ga.nodes[n as usize];
                            let (Some(ta), Some(tb)) = (ra.snap(pos, &o), rb.snap(pos, &o)) else { eprintln!("  no snap at {:.6},{:.6}", pos.lat_deg(), pos.lon_deg()); break };
                            let ca = ra.route(&sn, &ta, &prof).map(|p| walk_secs(p.cost.var_m, p.cost.fix_s, 1.3));
                            let cb = rb.route(&snap_b.unwrap(), &tb, &prof).map(|p| walk_secs(p.cost.var_m, p.cost.fix_s, 1.3));
                            if cb.is_none() || ca.is_none() || cb.unwrap() > ca.unwrap() + 5.0 {
                                eprintln!("  first later at {:.6},{:.6} (way {} {:?}): A {:?} s, B {:?} s; B node flags {:?}", pos.lat_deg(), pos.lon_deg(), ga.edge_way[e as usize], ed.kind, ca, cb, tb);
                                break;
                            }
                        }
                    }
                }
                if !cause.is_empty() {
                    // the start differs: that is the cause
                } else if let Some((e, what)) = edges.iter().find_map(|&(e, _, _)| b_has(e).map(|w| (e, w))) {
                    let ed = &ga.edges[e as usize];
                    let p = ga.nodes[ed.a as usize];
                    cause = format!("graph: {what} (way {}, {:?}, at {:.6},{:.6})", ga.edge_way[e as usize], ed.kind, p.lat_deg(), p.lon_deg());
                } else {
                    // every edge is there: are consecutive ones still joined at their node in B, with its tags?
                    for w in edges.windows(2) {
                        let (e1, e2) = (&ga.edges[w[0].0 as usize], &ga.edges[w[1].0 as usize]);
                        let Some(n) = [e1.a, e1.b].into_iter().find(|n| *n == e2.a || *n == e2.b) else {
                            // no node in common: A rides a lift between them (a lift in the walk router is not an
                            // edge of the walk). B must have a lift edge between a node of the one way and one of
                            // the other, there.
                            let ends_of = |e: &WalkEdge, g: &WalkGraph| [g.nodes[e.a as usize], g.nodes[e.b as usize]];
                            let (w1, w2) = (ga.edge_way[w[0].0 as usize], ga.edge_way[w[1].0 as usize]);
                            let nodes_b = |way: i64, ps: [LatLon; 2]| -> Vec<u32> {
                                ps.iter().flat_map(|p| at.get(&(p.lat, p.lon)).cloned().unwrap_or_default()).filter(|&f| gb.edge_way[f as usize] == way).flat_map(|f| [gb.edges[f as usize].a, gb.edges[f as usize].b]).collect()
                            };
                            let (b1, b2) = (nodes_b(w1, ends_of(e1, &ga)), nodes_b(w2, ends_of(e2, &ga)));
                            let lift = b1.iter().any(|&x| gb.adj[gb.adj_off[x as usize] as usize..gb.adj_off[x as usize + 1] as usize].iter().any(|&f| {
                                let fe = &gb.edges[f as usize];
                                fe.kind == EdgeKind::Lift && b2.contains(&if fe.a == x { fe.b } else { fe.a })
                            }));
                            if !lift {
                                let p = ga.nodes[e1.b as usize];
                                cause = format!("graph: a lift A rides is not in B as it is (from way {w1} to way {w2}, at {:.6},{:.6})", p.lat_deg(), p.lon_deg());
                                break;
                            }
                            continue;
                        };
                        let pos = ga.nodes[n as usize];
                        let ends = |e: u32| -> Vec<u32> {
                            let ed = &ga.edges[e as usize];
                            let way = ga.edge_way[e as usize];
                            at.get(&(pos.lat, pos.lon)).into_iter().flatten().copied().filter(|&f| gb.edge_way[f as usize] == way && gb.edges[f as usize].kind == ed.kind).flat_map(|f| [gb.edges[f as usize].a, gb.edges[f as usize].b]).filter(|&m| gb.nodes[m as usize] == pos).collect()
                        };
                        let (n1, n2) = (ends(w[0].0), ends(w[1].0));
                        if !n1.is_empty() && !n2.is_empty() && !n1.iter().any(|m| n2.contains(m)) {
                            cause = format!("graph: two edges joined at a node in A are not in B (ways {} and {}, at {:.6},{:.6})", ga.edge_way[w[0].0 as usize], ga.edge_way[w[1].0 as usize], pos.lat_deg(), pos.lon_deg());
                            break;
                        }
                        if let Some(&m) = n1.iter().find(|m| n2.contains(m)) {
                            if gb.node_flags[m as usize] != ga.node_flags[n as usize] {
                                cause = format!("graph: a node's tags changed ({:#x} → {:#x}, at {:.6},{:.6})", ga.node_flags[n as usize], gb.node_flags[m as usize], pos.lat_deg(), pos.lon_deg());
                                break;
                            }
                        }
                    }
                }
            }
        }
        if relinked && cause.is_empty() {
            cause = "relinked".into();
        } else if relinked {
            cause = format!("relinked; {cause}");
        }
        if cause.is_empty() {
            cause = "unexplained".into();
        }
        // for the check with A's own code on B's graph (`kante/tools/compare/main-probe.rs`): A's start as B's graph
        // has it, and B's link
        let snap_json = |s: &Snap| serde_json::json!([s.edge, s.frac, s.dist_m]);
        writeln!(
            out,
            "{}",
            serde_json::json!({ "key": v["key"], "cause": cause, "reproduced": reproduced, "b_start": snap_b.map(|s| snap_json(&s)), "b_target": snap_json(&b_link.snap), "options": v["options"], "limit": v["limit"] })
        )?;
    }
    Ok(())
}

/// Footpaths of both builds (stdin: `{"key", "set": "normal" | "step_free", "from", "to"}` by GTFS id; out: the
/// seconds at 1.3 m/s each build's precomputed footpath takes, or null).
fn footpaths(a_dir: &Path, b_dir: &Path) -> Result<()> {
    let tt: Timetable = io::load(&b_dir.join("built/timetable.bin"), TIMETABLE_SCHEMA)?;
    let load = |d: &Path| -> Result<(Footpaths, Footpaths)> {
        let p = d.join("built/links.bin");
        Ok(match io::schema_of(&p).as_deref() {
            Some("links-v2") => {
                let l: LinkDataV2 = io::load(&p, "links-v2")?;
                (l.normal, l.step_free)
            }
            _ => {
                let l: LinkData = io::load(&p, LINKS_SCHEMA)?;
                (l.normal, l.step_free)
            }
        })
    };
    let (fa, fb) = (load(a_dir)?, load(b_dir)?);
    let by_id: FxHashMap<&str, u32> = tt.stops.iter().enumerate().map(|(i, s)| (s.gtfs_id.as_str(), i as u32)).collect();
    let secs = |f: &Footpaths, a: u32, b: u32| -> Option<f32> {
        (f.off[a as usize] as usize..f.off[a as usize + 1] as usize).find(|&k| f.to[k] == b).map(|k| walk_secs(f.var_m[k] as f32, f.fix_s[k] as f32, 1.3))
    };
    let mut out = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let v: serde_json::Value = serde_json::from_str(&line?)?;
        let (Some(&a), Some(&b)) = (by_id.get(v["from"].as_str().unwrap_or("")), by_id.get(v["to"].as_str().unwrap_or(""))) else {
            writeln!(out, "{}", serde_json::json!({ "key": v["key"], "a": null, "b": null }))?;
            continue;
        };
        let step_free = v["set"].as_str() == Some("step_free");
        let (xa, xb) = if step_free { (&fa.1, &fb.1) } else { (&fa.0, &fb.0) };
        writeln!(out, "{}", serde_json::json!({ "key": v["key"], "a": secs(xa, a, b), "b": secs(xb, a, b) }))?;
    }
    Ok(())
}

const NO_STEP_KINDS: u32 = (1 << EdgeKind::Steps as u8) | (1 << EdgeKind::Escalator as u8) | (1 << EdgeKind::Lift as u8);

/// Where a boarding point (by its GTFS id) is joined to the network.
fn link(data: &Path, id: &str) -> Result<()> {
    let tt: Timetable = io::load(&data.join("built/timetable.bin"), TIMETABLE_SCHEMA)?;
    let links = load_links(data)?;
    let g: WalkGraph = io::load(&data.join("built/walkgraph.bin"), WALKGRAPH_SCHEMA)?;
    for (i, s) in tt.stops.iter().enumerate().filter(|(_, s)| s.gtfs_id == id) {
        let l = &links[i];
        let e = &g.edges[l.snap.edge as usize];
        println!("{i} {} {:?}: edge {} {:?} way {} levels {}/{} flags {:#x} at {:.7},{:.7} ({:.1} m off), level {}", s.label, l.matched, l.snap.edge, e.kind, g.edge_way[l.snap.edge as usize], e.level_a, e.level_b, e.flags, l.snap.pos.lat_deg(), l.snap.pos.lon_deg(), l.snap.dist_m, l.level);
    }
    Ok(())
}

/// Every connection a lift edge makes in graph A, checked in graph B: for each lift edge, each pair of ways it joins
/// (a way at one end, a way at the other, lift edges left out), B must join that same pair within 5 m of either end
/// of the lift: a node with the one and a node with the other, connected through lift edges and step-free edges
/// between nodes within those 5 m (the lift's own ports and the walk round its door). Prints the pairs B does not join, and a count.
fn lift_pairs(a: &Path, b: &Path) -> Result<()> {
    let ga: WalkGraph = io::load(a, WALKGRAPH_SCHEMA)?;
    let gb: WalkGraph = io::load(b, WALKGRAPH_SCHEMA)?;
    let ways_at = |g: &WalkGraph, n: u32| -> Vec<i64> {
        let mut w: Vec<i64> = g.adj[g.adj_off[n as usize] as usize..g.adj_off[n as usize + 1] as usize].iter().filter(|&&e| g.edges[e as usize].kind != EdgeKind::Lift).map(|&e| g.edge_way[e as usize]).collect();
        w.sort_unstable();
        w.dedup();
        w
    };
    let mut cells: FxHashMap<(i32, i32), Vec<u32>> = FxHashMap::default();
    for (i, n) in gb.nodes.iter().enumerate() {
        cells.entry((n.lat / 500, n.lon / 700)).or_default().push(i as u32); // about 5.5 m cells (1e-7°)
    }
    let (mut edges, mut pairs, mut missing) = (0usize, 0usize, 0usize);
    let mut out = std::io::stdout().lock();
    for (e, ed) in ga.edges.iter().enumerate() {
        if ed.kind != EdgeKind::Lift {
            continue;
        }
        edges += 1;
        let at = ga.nodes[ed.a as usize];
        let (wa, wb) = (ways_at(&ga, ed.a), ways_at(&ga, ed.b));
        // B's nodes within 5 m of either end of the lift (an inclined lift is long), and its components among them
        // by lift and step-free edges between them
        let mut near: Vec<u32> = Vec::new();
        for end in [ga.nodes[ed.a as usize], ga.nodes[ed.b as usize]] {
            for dl in -2..=2 {
                for dn in -2..=2 {
                    if let Some(v) = cells.get(&(end.lat / 500 + dl, end.lon / 700 + dn)) {
                        near.extend(v.iter().copied().filter(|&n| gb.nodes[n as usize].dist_m(&end) <= 5.0));
                    }
                }
            }
        }
        near.sort_unstable();
        near.dedup();
        let idx: FxHashMap<u32, usize> = near.iter().enumerate().map(|(i, &n)| (n, i)).collect();
        let mut comp: Vec<usize> = (0..near.len()).collect();
        fn root(c: &mut [usize], mut x: usize) -> usize {
            while c[x] != x {
                c[x] = c[c[x]];
                x = c[x];
            }
            x
        }
        for (i, &n) in near.iter().enumerate() {
            for &f in &gb.adj[gb.adj_off[n as usize] as usize..gb.adj_off[n as usize + 1] as usize] {
                let fe = &gb.edges[f as usize];
                if matches!(fe.kind, EdgeKind::Steps | EdgeKind::Escalator) {
                    continue;
                }
                let other = if fe.a == n { fe.b } else { fe.a };
                if let Some(&j) = idx.get(&other) {
                    let (x, y) = (root(&mut comp, i), root(&mut comp, j));
                    comp[x] = y;
                }
            }
        }
        for &x in &wa {
            for &y in &wb {
                if x == y {
                    continue;
                }
                pairs += 1;
                let cx: Vec<usize> = near.iter().enumerate().filter(|(_, &n)| ways_at(&gb, n).contains(&x)).map(|(i, _)| i).collect();
                let cy: Vec<usize> = near.iter().enumerate().filter(|(_, &n)| ways_at(&gb, n).contains(&y)).map(|(i, _)| i).collect();
                let ok = cx.iter().any(|&i| cy.iter().any(|&j| root(&mut comp, i) == root(&mut comp, j)));
                if !ok {
                    missing += 1;
                    writeln!(out, "not joined: lift edge {e} (way {}, levels {}/{}) at {:.6},{:.6}: way {x} ↔ way {y}{}{}", ga.edge_way[e], ed.level_a, ed.level_b, at.lat_deg(), at.lon_deg(), if cx.is_empty() { " (the first not within 5 m in B)" } else { "" }, if cy.is_empty() { " (the second not within 5 m in B)" } else { "" })?;
                }
            }
        }
    }
    writeln!(out, "{edges} lift edges in A, {pairs} pairs of ways they join; {missing} not joined in B")?;
    Ok(())
}

/// The edges within `r` metres of a point: kind, levels, flags, OSM way, ends.
fn edges(graph: &Path, lat: f64, lon: f64, r: f32) -> Result<()> {
    let g: WalkGraph = io::load(graph, WALKGRAPH_SCHEMA)?;
    let p = LatLon::from_deg(lat, lon);
    let mut out = std::io::stdout().lock();
    for (e, ed) in g.edges.iter().enumerate() {
        let geom = g.edge_geom(e as u32);
        if geom.iter().any(|q| q.dist_m(&p) <= r) {
            let (a, b) = (g.nodes[ed.a as usize], g.nodes[ed.b as usize]);
            writeln!(out, "{e} {:?} way {} levels {}/{} flags {:#x} {:.1} m  {:.6},{:.6} -> {:.6},{:.6} (nodes {} {}, node flags {:#x} {:#x})", ed.kind, g.edge_way[e], ed.level_a, ed.level_b, ed.flags, ed.len_dm as f32 / 10.0, a.lat_deg(), a.lon_deg(), b.lat_deg(), b.lon_deg(), ed.a, ed.b, g.node_flags[ed.a as usize], g.node_flags[ed.b as usize])?;
        }
    }
    Ok(())
}

fn kante_walk_point(ix: &DoorIndex, a: DoorAttach) -> LatLon {
    let _ = ix;
    let g = GRAPH.get().expect("graph");
    let geom = g.edge_geom(a.edge);
    // the point at fraction `frac` of the edge's length
    let lens: Vec<f32> = geom.windows(2).map(|w| w[0].dist_m(&w[1])).collect();
    let total: f32 = lens.iter().sum();
    let mut left = total * a.frac();
    for (k, l) in lens.iter().enumerate() {
        if left <= *l || k + 1 == lens.len() {
            let t = if *l > 0.0 { (left / l).clamp(0.0, 1.0) } else { 0.0 };
            let (p, q) = (geom[k].xy(), geom[k + 1].xy());
            return LatLon::from_xy(p.0 + (q.0 - p.0) * t, p.1 + (q.1 - p.1) * t);
        }
        left -= l;
    }
    geom[0]
}
static GRAPH: std::sync::OnceLock<WalkGraph> = std::sync::OnceLock::new();

fn main() -> Result<()> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let arg = |i: usize| a.get(i).map(|s| s.as_str()).unwrap_or("");
    match arg(0) {
        "sample" => sample(arg(1).as_ref(), arg(2).parse().unwrap_or(20000), arg(3).parse().unwrap_or(1)),
        "through" => through(arg(1).as_ref()),
        "lifts" => lifts(arg(1).as_ref(), arg(2).as_ref()),
        "lift-pairs" => lift_pairs(arg(1).as_ref(), arg(2).as_ref()),
        "edges" => edges(arg(1).as_ref(), arg(2).parse()?, arg(3).parse()?, arg(4).parse().unwrap_or(30.0)),
        "link" => link(arg(1).as_ref(), arg(2)),
        "hop" => hop(arg(1).as_ref(), arg(2).as_ref(), [arg(3).parse()?, arg(4).parse()?, arg(5).parse()?, arg(6).parse()?]),
        "segment" => segment(arg(1).as_ref(), [arg(2).parse()?, arg(3).parse()?, arg(4).parse()?, arg(5).parse()?]),
        "explain" => explain(arg(1).as_ref(), arg(2).as_ref()),
        "footpaths" => footpaths(arg(1).as_ref(), arg(2).as_ref()),
        "doors" => doors(arg(1).as_ref(), arg(2).parse().unwrap_or(30), arg(3).parse().unwrap_or(1)),
        _ => bail!("usage: compare sample <data> <points> <seed> | through <data> < walks.jsonl | lifts <graph a> <graph b> | doors <data> <n> <seed>"),
    }
}
