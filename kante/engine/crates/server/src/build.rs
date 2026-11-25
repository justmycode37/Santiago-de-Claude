//! `kante build`: raw inputs in `data/raw` → caches in `data/built`.
//!
//! Steps (each is skipped when its output exists, unless `--force` or it is
//! named in `--only`):
//!
//! | step        | input                                   | output                              |
//! |-------------|-----------------------------------------|-------------------------------------|
//! | `timetable` | `raw/gtfs/gtfs.zip`, `raw/atlas/*.csv`  | `timetable.bin`                     |
//! | `osm`       | `raw/osm/switzerland-latest.osm.pbf`    | `walkgraph.bin`, `osm-extract.bin`, `walkattr.bin` |
//! | `links`     | the three files above                   | `links.bin`                         |
//! | `search`    | `timetable.bin`, the PBF                | `search.bin`                        |
//! | `doors`     | the PBF, `walkgraph.bin`, `osm-extract.bin`, `raw/register/adr.csv.zip` | `doors.bin` (again whenever `osm` runs) |
//! | `elevation` | `walkgraph.bin`, `raw/dem/swissaltiregio.tif` | `slopes.bin` (again whenever `osm` runs) |
//!
//! Without the terrain model (`scripts/fetch-data.sh --elevation`) there is no `slopes.bin` and walks are timed
//! as if the country were flat; the links are made again when the slopes they were timed with change.
//!
//! The building address register gives most buildings their doors: without it (missing, unreadable, or fewer than a
//! million doors from it) the build fails, unless `--without-register` (a regional extract, a test) says to build
//! with OpenStreetMap's doors only.

use crate::Args;
use anyhow::{bail, Context, Result};
use kante_core::geo::BBox;
use kante_core::*;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;


fn step<T>(name: &str, f: impl FnOnce() -> Result<T>) -> Result<T> {
    eprintln!("== {name}");
    let t = Instant::now();
    let r = f().with_context(|| name.to_string())?;
    eprintln!("== {name} done in {:.1}s", t.elapsed().as_secs_f32());
    // hand what the step freed back to the system, so the next one does not add its peak on top
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: malloc_trim only releases free heap memory; no Rust object is touched.
    unsafe {
        libc::malloc_trim(0);
    }
    Ok(r)
}

/// What terrain model is at `path` (file name, size, modification time), if any: slopes made from another are made
/// again.
fn dem_id(path: &Path) -> Option<String> {
    let m = std::fs::metadata(path).ok()?;
    let t = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
    Some(format!("{} {} {}", path.file_name()?.to_string_lossy(), m.len(), t))
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
    let without_register = args.has("without-register");
    let only: Option<Vec<&str>> = args.get("only").map(|s| s.split(',').collect());
    // a step runs when one of its outputs is missing or was written in an older format (a cache the server would
    // refuse), or when it is named in --only
    let wanted = |name: &str, outputs: &[(&Path, &str)]| match &only {
        Some(list) => list.contains(&name),
        None => force || outputs.iter().any(|(p, schema)| io::schema_of(p).as_deref() != Some(*schema)),
    };
    let bbox = args.get("walk-bbox").map(parse_bbox).transpose()?;

    let tt_path = built.join("timetable.bin");
    let graph_path = built.join("walkgraph.bin");
    let extract_path = built.join("osm-extract.bin");
    let attrs_path = built.join("walkattr.bin");
    let links_path = built.join("links.bin");
    let search_path = built.join("search.bin");
    let doors_path = built.join("doors.bin");
    let slopes_path = built.join("slopes.bin");
    let dem_path = raw.join("dem/swissaltiregio.tif");
    let pbf = raw.join("osm/switzerland-latest.osm.pbf");

    let tt_wanted = wanted("timetable", &[(&tt_path, TIMETABLE_SCHEMA)]);
    if tt_wanted {
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

    // buildings: obstacles for the straight lines across squares, and the doors
    let mut buildings: Option<kante_osm::buildings::BuildingsRaw> = None;
    let osm_wanted = wanted("osm", &[(&graph_path, WALKGRAPH_SCHEMA), (&extract_path, EXTRACT_SCHEMA), (&attrs_path, WALKATTR_SCHEMA)]);
    // the doors refer to the graph's edges: built again with the graph, and whenever they belong to another one
    let doors_wanted = wanted("doors", &[(&doors_path, DOORS_SCHEMA)])
        || (!osm_wanted && only.is_none() && {
            let g = io::load::<WalkGraph>(&graph_path, WALKGRAPH_SCHEMA).ok();
            let d = io::load::<Doors>(&doors_path, DOORS_SCHEMA).ok();
            !matches!((g, d), (Some(g), Some(d)) if d.graph == graph_fingerprint(&g))
        });
    if osm_wanted || doors_wanted {
        step("buildings", || {
            let b = kante_osm::buildings::import_buildings(&pbf, bbox.as_ref())?;
            eprintln!("   {} buildings, {} mapped entrances", b.len(), b.entrances.len());
            buildings = Some(b);
            Ok(())
        })?;
    }
    if osm_wanted {
        step("osm", || {
            let (graph, extract, _) = kante_osm::import_full(&kante_osm::OsmOptions { pbf: pbf.clone(), bbox }, buildings.as_ref())?;
            eprintln!("   {} nodes, {} edges, {} platforms", graph.nodes.len(), graph.edges.len(), extract.platforms.len());
            let (attrs, st) = kante_osm::attrs::import_attrs(&pbf, &graph, bbox.as_ref())?;
            eprintln!(
                "   {} edges ({:.0} km) of roads whose sidewalks are drawn apart, {} car-only, {} away from traffic, {} with hours ({} by an area's; {} of {} hours readable), {} crossing=no nodes",
                st.separate_edges,
                st.separate_m / 1000.0,
                st.car_only_edges,
                st.favoured_edges,
                st.hours_edges,
                st.hours_by_area,
                st.hours_readable,
                st.hours,
                st.crossing_no_nodes
            );
            eprintln!("   {} carriageway edges say where their sidewalks are, {} with one on one side only", st.kerb_tagged_edges, st.kerb_sided_edges);
            io::save(&graph_path, WALKGRAPH_SCHEMA, &graph)?;
            io::save(&attrs_path, WALKATTR_SCHEMA, &attrs)?;
            io::save(&extract_path, EXTRACT_SCHEMA, &extract)
        })?;
    }

    // the doors refer to the walk graph's edges: built again whenever the graph is; right after it, so that the
    // buildings are not held through the steps after (they set the build's peak memory)
    if osm_wanted || doors_wanted {
        step("doors", || {
            let raw_b = buildings.take().expect("buildings read above");
            // the official address register gives the buildings without a mapped door theirs; without it, OSM's doors only
            let reg_path = raw.join("register/adr.csv.zip");
            let register = if reg_path.exists() {
                match kante_link::register::read(&reg_path, bbox.as_ref()) {
                    Ok(r) => r,
                    Err(e) if without_register => {
                        eprintln!("   warning: {e:#}; doors from OpenStreetMap only (--without-register)");
                        Vec::new()
                    }
                    Err(e) => bail!("the building address register {} cannot be read: {e:#} (scripts/fetch-data.sh --register; --without-register builds without it)", reg_path.display()),
                }
            } else if without_register {
                eprintln!("   no {}: doors from OpenStreetMap only (--without-register)", reg_path.display());
                Vec::new()
            } else {
                bail!("no building address register at {} (scripts/fetch-data.sh --register; --without-register builds without it)", reg_path.display());
            };
            let mut graph: WalkGraph = io::load(&graph_path, WALKGRAPH_SCHEMA)?;
            // the attributes say which carriageways are busy (a door's way out across one counts more)
            graph.attrs = crate::state::load_attrs(&attrs_path, &graph).unwrap_or_default();
            let extract: OsmExtract = io::load(&extract_path, EXTRACT_SCHEMA)?;
            let router = kante_walk::WalkRouter::new(Arc::new(graph));
            let (doors, st) = kante_link::doors::build(&raw_b, &register, &router, &extract);
            eprintln!(
                "   {} addresses; {} doors from the register; {} doors, {} buildings ({} doors too far from any way, {} joined only through a building)",
                register.len(),
                st.register_doors,
                doors.doors.len(),
                doors.buildings.len(),
                st.unattached,
                st.through_only
            );
            let facing = |f: u8| doors.doors.iter().filter(|d| d.faces == f).count();
            let crossing = doors.attach.iter().filter(|a| a.crosses().is_some()).count();
            eprintln!("   {} doors look onto their address's street, {} onto another; {} of {} ways out walk over a carriageway", facing(DOOR_FACES_OWN), facing(DOOR_FACES_OTHER), crossing, doors.attach.len());
            if st.register_doors < 1_000_000 && !without_register {
                bail!("only {} doors from the building address register {}, fewer than a million: not building (--without-register builds without it)", st.register_doors, reg_path.display());
            }
            io::save(&doors_path, DOORS_SCHEMA, &doors)
        })?;
    }
    // the slopes of the graph's edges, from the terrain model: made again with the graph, with another terrain model
    // (`Slopes::source` names the file, its size and time), and whenever they belong to another graph; without the
    // terrain model, none (a slopes.bin left from one is removed)
    let dem = dem_id(&dem_path);
    let slopes_wanted = match &only {
        Some(list) => list.contains(&"elevation"),
        None => {
            force
                || osm_wanted
                || match (&dem, io::load::<Slopes>(&slopes_path, SLOPES_SCHEMA).ok()) {
                    // no terrain model: a slopes.bin of any kind (readable or not) is removed
                    (None, _) => slopes_path.exists(),
                    (Some(_), None) => true,
                    (Some(id), Some(s)) => s.source != *id || io::load::<WalkGraph>(&graph_path, WALKGRAPH_SCHEMA).map_or(true, |g| s.graph != graph_fingerprint(&g)),
                }
        }
    };
    if slopes_wanted {
        step("elevation", || {
            let flat = |why: String| -> Result<()> {
                eprintln!("   {why}: walks are timed as if flat");
                if slopes_path.exists() {
                    std::fs::remove_file(&slopes_path)?;
                }
                Ok(())
            };
            let Some(id) = dem.clone() else {
                return flat(format!("no terrain model at {} (scripts/fetch-data.sh --elevation)", dem_path.display()));
            };
            // an input that is optional: one that cannot be read is said, not a reason to stop the build
            let dem = match kante_elevation::dem::Dem::open(&dem_path) {
                Ok(d) => d,
                Err(e) => return flat(format!("the terrain model {} cannot be read ({e:#})", dem_path.display())),
            };
            let graph: WalkGraph = io::load(&graph_path, WALKGRAPH_SCHEMA)?;
            let (edges, st) = kante_elevation::build(&graph, &dem);
            eprintln!(
                "   {} edges on the ground, {} bridges and tunnels ({} with no end on the ground), {} flights of stairs; {} nodes outside the terrain model, {} segments steeper than {:.0} %",
                st.ground,
                st.spans,
                st.spans_unanchored,
                st.stairs,
                st.no_height,
                st.clamped,
                kante_elevation::MAX_GRADE * 100.0
            );
            if dem.failed_tiles() > 0 {
                return flat(format!("{} tiles of the terrain model {} cannot be read", dem.failed_tiles(), dem_path.display()));
            }
            if st.no_height * 2 > graph.nodes.len() {
                return flat(format!("the terrain model {} has no height for {} of {} nodes", dem_path.display(), st.no_height, graph.nodes.len()));
            }
            io::save(&slopes_path, SLOPES_SCHEMA, &Slopes { graph: graph_fingerprint(&graph), source: id, edges })
        })?;
    }

    // the links refer to the graph's edges and the timetable's stops, and their footpaths are timed with the slopes:
    // built again with any of them, and whenever they belong to another one (caches upgraded in place)
    let links_wanted = wanted("links", &[(&links_path, LINKS_SCHEMA)])
        || (only.is_none() && (osm_wanted || tt_wanted || {
            let l = io::load::<LinkData>(&links_path, LINKS_SCHEMA).ok();
            let g = io::load::<WalkGraph>(&graph_path, WALKGRAPH_SCHEMA).ok();
            let t = io::load::<Timetable>(&tt_path, TIMETABLE_SCHEMA).ok();
            !matches!((l, g, t), (Some(l), Some(g), Some(t))
                if l.graph == graph_fingerprint(&g) && l.timetable == t.stops_fingerprint()
                    && l.slopes == crate::state::load_slopes(&slopes_path, &g).map_or(0, |s| slopes_fingerprint(&s)))
        }));
    if links_wanted {
        step("links", || {
            let tt: Timetable = io::load(&tt_path, TIMETABLE_SCHEMA)?;
            let mut graph: WalkGraph = io::load(&graph_path, WALKGRAPH_SCHEMA)?;
            graph.slopes = crate::state::load_slopes(&slopes_path, &graph).unwrap_or_default();
            graph.attrs = crate::state::load_attrs(&attrs_path, &graph).unwrap_or_default();
            let extract: OsmExtract = io::load(&extract_path, EXTRACT_SCHEMA)?;
            let router = kante_walk::WalkRouter::new(Arc::new(graph));
            let links = kante_link::link(&tt, &router, &extract, &kante_link::LinkOptions { max_transfer_s: 720.0 });
            let linked = links.links.iter().filter(|l| l.matched != LinkMatch::None).count();
            eprintln!("   {} of {} boarding points attached, {} footpaths ({} step-free)", linked, links.links.len(), links.normal.len(), links.step_free.len());
            io::save(&links_path, LINKS_SCHEMA, &links)
        })?;
    }

    if wanted("search", &[(&search_path, kante_search::SEARCH_SCHEMA)]) {
        step("search", || {
            let tt: Timetable = io::load(&tt_path, TIMETABLE_SCHEMA)?;
            let idx = kante_search::build(&tt, pbf.exists().then_some(pbf.as_path()), None)?;
            io::save(&search_path, kante_search::SEARCH_SCHEMA, &idx)
        })?;
    }
    eprintln!("build complete: {}", built.display());
    Ok(())
}
