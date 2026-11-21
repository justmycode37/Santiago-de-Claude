//! Development tool: import an OSM PBF into `walkgraph*.bin` +
//! `osm-extract*.bin`, print statistics and run the Bern self-checks.
//!
//! ```text
//! osm-import [--pbf FILE] [--out-dir DIR] [--suffix -bern] [--bbox minlat,minlon,maxlat,maxlon]
//!            [--bern] [--no-save] [--load] [--validate] [--platforms]
//! ```
//! `--bern` = `--bbox 46.90,7.35,47.00,7.52 --suffix -bern`. `--load` skips the
//! import and reads the files back (to validate an existing build).

use anyhow::{bail, Context, Result};
use kante_core::geo::{BBox, LatLon};
use kante_core::walk::*;
use kante_osm::stats;
use kante_osm::{import_with_stats, OsmOptions};
use std::path::PathBuf;
use std::time::Instant;

fn peak_rss_mb() -> f64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("VmHWM:")).and_then(|l| l.split_whitespace().nth(1).map(|x| x.to_string())))
        .and_then(|x| x.parse::<f64>().ok())
        .map(|kb| kb / 1024.0)
        .unwrap_or(0.0)
}

fn mem_mb(g: &WalkGraph, x: &OsmExtract) -> (f64, f64) {
    use std::mem::size_of;
    let gm = g.nodes.len() * size_of::<LatLon>()
        + g.node_flags.len()
        + (g.adj_off.len() + g.adj.len()) * 4
        + g.edges.len() * size_of::<WalkEdge>()
        + g.edge_way.len() * 8
        + g.geom.len() * size_of::<LatLon>()
        + g.names.iter().map(|s| s.len() + 24).sum::<usize>();
    let xm = x.platforms.iter().map(|p| size_of::<OsmPlatform>() + p.edges.len() * 4 + p.name.len() + p.sloid.len() + p.refs.iter().map(|r| r.len() + 24).sum::<usize>()).sum::<usize>()
        + x.carriageways.len() * size_of::<Carriageway>()
        + x.carriageway_geom.len() * size_of::<LatLon>()
        + x.carriageway_names.iter().map(|s| s.len() + 24).sum::<usize>();
    (gm as f64 / 1048576.0, xm as f64 / 1048576.0)
}

fn main() -> Result<()> {
    let mut pbf = PathBuf::from("../data/raw/osm/switzerland-latest.osm.pbf");
    let mut out_dir = PathBuf::from("../data/built");
    let mut suffix = String::new();
    let mut bbox: Option<BBox> = None;
    let (mut save, mut load, mut validate, mut platforms, mut odd) = (true, false, false, false, false);
    let mut routes: Vec<((f64, f64, Option<Level2>), (f64, f64, Option<Level2>))> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--pbf" => pbf = args.next().context("--pbf FILE")?.into(),
            "--out-dir" => out_dir = args.next().context("--out-dir DIR")?.into(),
            "--suffix" => suffix = args.next().context("--suffix S")?,
            "--bbox" => {
                let v: Vec<f64> = args.next().context("--bbox a,b,c,d")?.split(',').map(|x| x.trim().parse::<f64>()).collect::<Result<_, _>>()?;
                if v.len() != 4 {
                    bail!("--bbox minlat,minlon,maxlat,maxlon");
                }
                bbox = Some(BBox::from_deg(v[0], v[1], v[2], v[3]));
            }
            "--bern" => {
                bbox = Some(BBox::from_deg(46.90, 7.35, 47.00, 7.52));
                suffix = "-bern".into();
            }
            "--no-save" => save = false,
            "--load" => load = true,
            "--validate" => validate = true,
            "--platforms" => platforms = true,
            "--route" => {
                // --route lat,lon[,level] lat,lon[,level] : test walk on the saved graph
                let a = args.next().context("--route FROM TO")?;
                let b = args.next().context("--route FROM TO")?;
                routes.push((parse_pt(&a)?, parse_pt(&b)?));
                load = true;
            }
            "--odd" => odd = true,
            "--keys" => return keys(&pbf),
            "--dump" => {
                // debug: print the tags of ways (w123), nodes (n123), relations (r123)
                let ids: Vec<String> = args.next().context("--dump w1,n2,r3")?.split(',').map(|s| s.trim().to_string()).collect();
                return dump(&pbf, &ids);
            }
            other => bail!("unknown argument {other}"),
        }
    }
    let gpath = out_dir.join(format!("walkgraph{suffix}.bin"));
    let xpath = out_dir.join(format!("osm-extract{suffix}.bin"));

    let t0 = Instant::now();
    let (g, x) = if load {
        let g: WalkGraph = kante_core::io::load(&gpath, WALKGRAPH_SCHEMA)?;
        let x: OsmExtract = kante_core::io::load(&xpath, "osm-extract-v1")?;
        println!("loaded {} and {} in {:.1} s", gpath.display(), xpath.display(), t0.elapsed().as_secs_f32());
        (g, x)
    } else {
        let (g, x, st) = import_with_stats(&OsmOptions { pbf: pbf.clone(), bbox })?;
        println!("import of {} took {:.1} s (relations {:.1}, ways {:.1}, nodes {:.1}, build {:.1}); peak RSS {:.0} MB",
            pbf.display(), t0.elapsed().as_secs_f32(), st.secs_relations, st.secs_ways, st.secs_nodes, st.secs_build, peak_rss_mb());
        println!("{st:#?}");
        if save {
            let t = Instant::now();
            kante_core::io::save(&gpath, WALKGRAPH_SCHEMA, &g)?;
            kante_core::io::save(&xpath, "osm-extract-v1", &x)?;
            println!(
                "wrote {} ({:.1} MB) and {} ({:.1} MB) in {:.1} s",
                gpath.display(),
                std::fs::metadata(&gpath)?.len() as f64 / 1048576.0,
                xpath.display(),
                std::fs::metadata(&xpath)?.len() as f64 / 1048576.0,
                t.elapsed().as_secs_f32()
            );
        }
        (g, x)
    };

    let (gm, xm) = mem_mb(&g, &x);
    println!("\n== totals");
    println!(
        "graph: {} nodes, {} edges, {} geometry points, {} names; ~{:.0} MB in RAM",
        g.nodes.len(),
        g.edges.len(),
        g.geom.len(),
        g.names.len(),
        gm
    );
    println!(
        "extract: {} platform objects, {} carriageways ({} points, {} names); ~{:.0} MB in RAM",
        x.platforms.len(),
        x.carriageways.len(),
        x.carriageway_geom.len(),
        x.carriageway_names.len(),
        xm
    );
    let ck = |k: CarriagewayKind| x.carriageways.iter().filter(|c| c.kind == k).count();
    println!("carriageways: road {}, tram track {}, rail track {}", ck(CarriagewayKind::Road), ck(CarriagewayKind::TramTrack), ck(CarriagewayKind::RailTrack));
    print!("{}", stats::report(&g, &x, None, false));
    let comps = stats::components(&g);
    print!("{}", stats::connectivity(&g, &comps, None, 0));

    let problems = stats::check(&g, &x);
    if problems.is_empty() {
        println!("self-check: ok");
    } else {
        println!("self-check: {} PROBLEMS", problems.len());
        for p in problems.iter().take(20) {
            println!("  {p}");
        }
    }
    if odd {
        let station = BBox::from_deg(46.9445, 7.4330, 46.9510, 7.4470);
        print!("{}", stats::odd_junctions(&g, Some(&station)));
    }
    if !routes.is_empty() {
        let main = (0..comps.edges.len()).max_by_key(|&i| comps.edges[i]).unwrap_or(0) as u32;
        for (f, t) in &routes {
            println!("{f:?} → {t:?}");
            for step_free in [false, true] {
                let a = stats::snap(&g, LatLon::from_deg(f.0, f.1), f.2, step_free, Some((&comps, main)));
                let b = stats::snap(&g, LatLon::from_deg(t.0, t.1), t.2, step_free, Some((&comps, main)));
                let label = if step_free { "step-free" } else { "normal" };
                match (a, b) {
                    (Some(a), Some(b)) => match stats::route(&g, a, b, step_free) {
                        Some(r) => print!("  {label}:\n{}", stats::describe(&r)),
                        None => println!("  {label}: NO ROUTE"),
                    },
                    _ => println!("  {label}: could not snap"),
                }
            }
        }
    }
    if validate {
        let station = BBox::from_deg(46.9445, 7.4330, 46.9510, 7.4470);
        println!("\n== Bern station box (46.9445–46.9510, 7.4330–7.4470)");
        print!("{}", stats::report(&g, &x, Some(&station), platforms));
        print!("{}", stats::connectivity(&g, &comps, Some(&station), 15));
        let main = (0..comps.edges.len()).max_by_key(|&i| comps.edges[i]).unwrap_or(0) as u32;

        println!("\n== test walks (plain edge length; reference from route_tests.txt)");
        // The first three use the boarding-point coordinates of the brief; the
        // last three start and end where the reference routes do (the stop
        // node and the first platform node reached), so the lengths compare.
        type Pt = (f64, f64, Option<Level2>);
        let tests: [(&str, Pt, Pt, &str); 6] = [
            ("city bay G → SBB track 7 (boarding point coordinates)", (46.948604, 7.440440, None), (46.948566, 7.436830, Some(0)), "205 m / 245 m step-free to the nearest point of platform 7/8"),
            ("PostAuto bay T (level 2) → bay K1 (boarding point coordinates)", (46.948959, 7.438580, Some(4)), (46.946875, 7.440772, None), "383 m / 397 m step-free"),
            ("bay L → RBS track 21 (level -2) (boarding point coordinates)", (46.947298, 7.440548, None), (46.949650, 7.439890, Some(-4)), "287 m / 321 m step-free to the near end of platform 21/22"),
            ("bay G stop node → top of the stairs onto platform 7/8", (46.948645, 7.440426, None), (46.9491680, 7.4384082, Some(0)), "205 m / 245 m step-free (step-free reference ends at the ramp instead)"),
            ("bay T stop node (level 2) → top of the stairs onto platform 7/8", (46.949047, 7.438581, Some(4)), (46.9491680, 7.4384082, Some(0)), "218 m / 251 m step-free (step-free reference ends at the ramp instead)"),
            ("top of the stairs on platform 12/13 → bay Z stop node", (46.9494131, 7.4380997, Some(0)), (46.949060, 7.440749, None), "253 m / 285 m step-free (step-free reference starts at the ramp instead)"),
        ];
        for (name, f, t, reference) in tests {
            println!("{name}   [reference {reference}]");
            for step_free in [false, true] {
                let a = stats::snap(&g, LatLon::from_deg(f.0, f.1), f.2, step_free, Some((&comps, main)));
                let b = stats::snap(&g, LatLon::from_deg(t.0, t.1), t.2, step_free, Some((&comps, main)));
                let label = if step_free { "step-free" } else { "normal" };
                match (a, b) {
                    (Some(a), Some(b)) => match stats::route(&g, a, b, step_free) {
                        Some(r) => print!("  {label}:\n{}", stats::describe(&r)),
                        None => println!("  {label}: NO ROUTE"),
                    },
                    _ => println!("  {label}: could not snap"),
                }
            }
        }
    }
    Ok(())
}

fn dump(pbf: &std::path::Path, ids: &[String]) -> Result<()> {
    use osmpbf::{Element, ElementReader};
    use std::collections::HashSet;
    let mut want: [HashSet<i64>; 3] = Default::default();
    for id in ids {
        let (k, n) = id.split_at(1);
        let i = match k {
            "n" => 0,
            "w" => 1,
            "r" => 2,
            _ => bail!("ids look like w123, n123, r123"),
        };
        want[i].insert(n.parse()?);
    }
    let out = ElementReader::from_path(pbf)?.par_map_reduce(
        |el| {
            let fmt = |tags: Vec<(&str, &str)>| tags.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(" | ");
            match el {
                Element::Way(w) if want[1].contains(&w.id()) => {
                    let refs: Vec<i64> = w.refs().collect();
                    vec![format!("way {} [{} nodes: {:?}] {}", w.id(), refs.len(), refs, fmt(w.tags().collect()))]
                }
                Element::Node(n) if want[0].contains(&n.id()) => vec![format!("node {} {:.7},{:.7} {}", n.id(), n.lat(), n.lon(), fmt(n.tags().collect()))],
                Element::DenseNode(n) if want[0].contains(&n.id()) => vec![format!("node {} {:.7},{:.7} {}", n.id(), n.lat(), n.lon(), fmt(n.tags().collect()))],
                Element::Relation(r) if want[2].contains(&r.id()) => {
                    let m: Vec<String> = r.members().map(|m| format!("{:?}:{}:{}", m.member_type, m.member_id, m.role().unwrap_or(""))).collect();
                    vec![format!("relation {} members {:?} {}", r.id(), m, fmt(r.tags().collect()))]
                }
                _ => Vec::new(),
            }
        },
        Vec::new,
        |mut a, mut b| {
            a.append(&mut b);
            a
        },
    )?;
    for l in out {
        println!("{l}");
    }
    Ok(())
}

fn parse_pt(s: &str) -> Result<(f64, f64, Option<Level2>)> {
    let v: Vec<&str> = s.split(',').collect();
    if v.len() < 2 {
        bail!("point is lat,lon[,level]");
    }
    let level = match v.get(2) {
        Some(l) => Some((l.trim().parse::<f32>()? * 2.0).round() as Level2),
        None => None,
    };
    Ok((v[0].trim().parse()?, v[1].trim().parse()?, level))
}

/// Tag keys used on platform / stop objects (how are refs and ids tagged?).
fn keys(pbf: &std::path::Path) -> Result<()> {
    use kante_osm::tags::{node_platform_kind, Tags};
    use osmpbf::{Element, ElementReader};
    use std::collections::HashMap;
    let merge = |mut a: HashMap<String, u64>, b: HashMap<String, u64>| {
        for (k, v) in b {
            *a.entry(k).or_default() += v;
        }
        a
    };
    let out = ElementReader::from_path(pbf)?.par_map_reduce(
        |el| {
            let mut m: HashMap<String, u64> = HashMap::new();
            let mut add = |kind: &str, tags: Vec<(&str, &str)>| {
                *m.entry(format!("{kind} (objects)")).or_default() += 1;
                for (k, _) in tags {
                    if k.starts_with("ref") || k.contains("uic") || k.contains("IFOPT") || k.contains("sloid") || k == "level" || k == "layer" || k == "local_ref" {
                        *m.entry(format!("{kind} {k}")).or_default() += 1;
                    }
                }
            };
            match el {
                Element::DenseNode(n) => {
                    let t = Tags::collect(n.tags());
                    if node_platform_kind(&t).is_some() {
                        add("node", n.tags().collect());
                    }
                }
                Element::Way(w) => {
                    let t = Tags::collect(w.tags());
                    if t.is_platform() {
                        add("way", w.tags().collect());
                    }
                }
                Element::Relation(r) => {
                    let t = Tags::collect(r.tags());
                    if t.is_platform() {
                        add("relation", r.tags().collect());
                    }
                }
                _ => {}
            }
            m
        },
        HashMap::new,
        merge,
    )?;
    let mut v: Vec<(String, u64)> = out.into_iter().collect();
    v.sort();
    for (k, n) in v {
        println!("{n:>8}  {k}");
    }
    Ok(())
}
