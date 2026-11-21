//! `kante build`: raw inputs in `data/raw` → caches in `data/built`.
//!
//! Steps (each is skipped when its output exists, unless `--force` or it is
//! named in `--only`):
//!
//! | step        | input                                   | output                              |
//! |-------------|-----------------------------------------|-------------------------------------|
//! | `timetable` | `raw/gtfs/gtfs.zip`, `raw/atlas/*.csv`  | `timetable.bin`                     |
//! | `osm`       | `raw/osm/switzerland-latest.osm.pbf`    | `walkgraph.bin`, `osm-extract.bin`  |
//! | `links`     | the three files above                   | `links.bin`                         |
//! | `search`    | `timetable.bin`, the PBF                | `search.bin`                        |

use crate::Args;
use anyhow::{bail, Context, Result};
use kante_core::geo::BBox;
use kante_core::*;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

pub const EXTRACT_SCHEMA: &str = "osm-extract-v1";

fn step<T>(name: &str, f: impl FnOnce() -> Result<T>) -> Result<T> {
    eprintln!("== {name}");
    let t = Instant::now();
    let r = f().with_context(|| name.to_string())?;
    eprintln!("== {name} done in {:.1}s", t.elapsed().as_secs_f32());
    Ok(r)
}

fn parse_bbox(s: &str) -> Result<BBox> {
    let v: Vec<f64> = s.split(',').map(|x| x.trim().parse::<f64>()).collect::<Result<_, _>>().context("--walk-bbox")?;
    if v.len() != 4 {
        bail!("--walk-bbox takes south,west,north,east");
    }
    Ok(BBox::from_deg(v[0], v[1], v[2], v[3]))
}

pub fn run(args: &Args) -> Result<()> {
    let data = args.data_dir();
    let raw = data.join("raw");
    let built = data.join("built");
    std::fs::create_dir_all(&built)?;
    let force = args.has("force");
    let only: Option<Vec<&str>> = args.get("only").map(|s| s.split(',').collect());
    let wanted = |name: &str, outputs: &[&Path]| match &only {
        Some(list) => list.contains(&name),
        None => force || outputs.iter().any(|p| !p.exists()),
    };
    let bbox = args.get("walk-bbox").map(parse_bbox).transpose()?;

    let tt_path = built.join("timetable.bin");
    let graph_path = built.join("walkgraph.bin");
    let extract_path = built.join("osm-extract.bin");
    let links_path = built.join("links.bin");
    let search_path = built.join("search.bin");
    let pbf = raw.join("osm/switzerland-latest.osm.pbf");

    if wanted("timetable", &[&tt_path]) {
        step("timetable", || {
            let atlas = raw.join("atlas");
            let tt = kante_gtfs::import(&kante_gtfs::ImportOptions {
                gtfs_zip: raw.join("gtfs/gtfs.zip"),
                atlas_dir: atlas.join("traffic-point.csv").exists().then_some(atlas),
                min_headway_s: 300,
            })?;
            eprintln!("   {} stations, {} boarding points, {} patterns, {} trips", tt.stations.len(), tt.stops.len(), tt.patterns.len(), tt.trips.len());
            io::save(&tt_path, TIMETABLE_SCHEMA, &tt)
        })?;
    }

    if wanted("osm", &[&graph_path, &extract_path]) {
        step("osm", || {
            let (graph, extract) = kante_osm::import(&kante_osm::OsmOptions { pbf: pbf.clone(), bbox })?;
            eprintln!("   {} nodes, {} edges, {} platforms", graph.nodes.len(), graph.edges.len(), extract.platforms.len());
            io::save(&graph_path, WALKGRAPH_SCHEMA, &graph)?;
            io::save(&extract_path, EXTRACT_SCHEMA, &extract)
        })?;
    }

    if wanted("links", &[&links_path]) {
        step("links", || {
            let tt: Timetable = io::load(&tt_path, TIMETABLE_SCHEMA)?;
            let graph: WalkGraph = io::load(&graph_path, WALKGRAPH_SCHEMA)?;
            let extract: OsmExtract = io::load(&extract_path, EXTRACT_SCHEMA)?;
            let router = kante_walk::WalkRouter::new(Arc::new(graph));
            let links = kante_link::link(&tt, &router, &extract, &kante_link::LinkOptions { max_transfer_s: 720.0 });
            let linked = links.links.iter().filter(|l| l.matched != LinkMatch::None).count();
            eprintln!("   {} of {} boarding points attached, {} footpaths ({} step-free)", linked, links.links.len(), links.normal.len(), links.step_free.len());
            io::save(&links_path, LINKS_SCHEMA, &links)
        })?;
    }

    if wanted("search", &[&search_path]) {
        step("search", || {
            let tt: Timetable = io::load(&tt_path, TIMETABLE_SCHEMA)?;
            let idx = kante_search::build(&tt, pbf.exists().then_some(pbf.as_path()), None)?;
            io::save(&search_path, "search-v1", &idx)
        })?;
    }
    eprintln!("build complete: {}", built.display());
    Ok(())
}
