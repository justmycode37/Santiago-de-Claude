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

fn sample(data: &Path, n: usize, seed: u64) -> Result<()> {
    let mut rng = Rng(seed.max(1) * 0x9E37_79B9_7F4A_7C15);
    let ix = load_doors(data)?;
    let tt: Timetable = io::load(&data.join("built/timetable.bin"), TIMETABLE_SCHEMA)?;
    let g: WalkGraph = io::load(&data.join("built/walkgraph.bin"), WALKGRAPH_SCHEMA)?;
    let reg = kante_link::register::read(&data.join("raw/register/adr.csv.zip"), None)?;
    eprintln!("{} addresses, {} buildings, {} edges, {} stations", reg.len(), ix.doors.buildings.len(), g.edges.len(), tt.stations.len());

    // a pool of addresses inside buildings, for points and for the far ends of walks and trips
    let mut pool: Vec<LatLon> = Vec::new();
    let mut tries = 0;
    while pool.len() < n * 4 && tries < n * 40 {
        tries += 1;
        let a = &reg[rng.below(reg.len())];
        if !ix.buildings_at(a.pos).is_empty() {
            pool.push(a.pos);
        }
    }
    let mut points: Vec<serde_json::Value> = Vec::new();
    let mut origins: Vec<LatLon> = Vec::new();
    for p in pool.iter().take(n / 2) {
        points.push(pt_json("address", *p));
        origins.push(*p);
    }
    // street points: on a walkable way on the ground, up to 5 m off it
    let walkable = |e: &WalkEdge| {
        matches!(e.kind, EdgeKind::Sidewalk | EdgeKind::Footway | EdgeKind::Path | EdgeKind::Road | EdgeKind::Pedestrian | EdgeKind::Crossing)
            && e.flags & (EF_TUNNEL | EF_BRIDGE | EF_INDOOR) == 0
    };
    let mut k = 0;
    while k < n * 3 / 10 {
        let e = rng.below(g.edges.len());
        let ed = &g.edges[e];
        if !walkable(ed) {
            continue;
        }
        let geom = g.edge_geom(e as u32);
        let i = rng.below(geom.len() - 1);
        let (a, b) = (geom[i].xy(), geom[i + 1].xy());
        let t = rng.unit();
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let l = (dx * dx + dy * dy).sqrt().max(1e-3);
        let off = (rng.unit() * 2.0 - 1.0) * 5.0;
        let p = LatLon::from_xy(a.0 + dx * t - dy / l * off, a.1 + dy * t + dx / l * off);
        points.push(pt_json("street", p));
        origins.push(p);
        k += 1;
    }
    // stations with a stop that has trips in Switzerland
    let swiss: Vec<&Station> = tt.stations.iter().filter(|s| s.didok / 100_000 == 85 && !s.pos.is_none()).collect();
    while points.len() < n {
        let s = swiss[rng.below(swiss.len())];
        points.push(pt_json("station", s.pos));
        origins.push(s.pos);
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
                walks.push(serde_json::json!({ "from": points[i], "to": pt_json("address", d) }));
                break;
            }
        }
    }
    // trips: between addresses 3 – 60 km apart
    let mut trips = Vec::new();
    let mut t = 0;
    while trips.len() < n / 5 && t < n * 50 {
        t += 1;
        let (a, b) = (pool[rng.below(pool.len())], pool[rng.below(pool.len())]);
        if (3000.0..=60000.0).contains(&a.dist_m(&b)) {
            trips.push(serde_json::json!({ "from": pt_json("address", a), "to": pt_json("address", b) }));
        }
    }
    eprintln!("{} points, {} walks, {} trips", points.len(), walks.len(), trips.len());
    serde_json::to_writer(std::io::stdout().lock(), &serde_json::json!({ "seed": seed, "points": points, "walks": walks, "trips": trips }))?;
    Ok(())
}

/// For each walk (`{"key", "geometry": [[lon, lat], …]}` per line): the segments that run through a building.
fn through(data: &Path) -> Result<()> {
    let ix = load_doors(data)?;
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let v: serde_json::Value = serde_json::from_str(&line?)?;
        let geom: Vec<LatLon> = v["geometry"].as_array().context("geometry")?.iter().map(|c| LatLon::from_deg(c[1].as_f64().unwrap_or(0.0), c[0].as_f64().unwrap_or(0.0))).collect();
        let segs: Vec<usize> = (0..geom.len().saturating_sub(1)).filter(|&i| geom[i].dist_m(&geom[i + 1]) > 0.4 && ix.through(geom[i], geom[i + 1], 0.0)).collect();
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

/// The edges within `r` metres of a point: kind, levels, flags, OSM way, ends.
fn edges(graph: &Path, lat: f64, lon: f64, r: f32) -> Result<()> {
    let g: WalkGraph = io::load(graph, WALKGRAPH_SCHEMA)?;
    let p = LatLon::from_deg(lat, lon);
    let mut out = std::io::stdout().lock();
    for (e, ed) in g.edges.iter().enumerate() {
        let geom = g.edge_geom(e as u32);
        if geom.iter().any(|q| q.dist_m(&p) <= r) {
            let (a, b) = (g.nodes[ed.a as usize], g.nodes[ed.b as usize]);
            writeln!(out, "{e} {:?} way {} levels {}/{} flags {:#x} {:.1} m  {:.6},{:.6} -> {:.6},{:.6} (nodes {} {})", ed.kind, g.edge_way[e], ed.level_a, ed.level_b, ed.flags, ed.len_dm as f32 / 10.0, a.lat_deg(), a.lon_deg(), b.lat_deg(), b.lon_deg(), ed.a, ed.b)?;
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
        "edges" => edges(arg(1).as_ref(), arg(2).parse()?, arg(3).parse()?, arg(4).parse().unwrap_or(30.0)),
        "doors" => doors(arg(1).as_ref(), arg(2).parse().unwrap_or(30), arg(3).parse().unwrap_or(1)),
        _ => bail!("usage: compare sample <data> <points> <seed> | through <data> < walks.jsonl | lifts <graph a> <graph b> | doors <data> <n> <seed>"),
    }
}
