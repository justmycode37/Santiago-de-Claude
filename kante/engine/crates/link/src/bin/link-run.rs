//! Dev tool: link a timetable to a walk graph, print diagnostics, save links.
//! usage: link-run <timetable.bin> <walkgraph.bin> <osm-extract.bin> <out links.bin> [station name to inspect]...
use kante_core::*;
use std::sync::Arc;
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a.len() < 4 {
        anyhow::bail!("usage: link-run <timetable.bin> <walkgraph.bin> <osm-extract.bin> <out> [station]...");
    }
    let tt: Timetable = io::load(a[0].as_ref(), TIMETABLE_SCHEMA)?;
    let graph: WalkGraph = io::load(a[1].as_ref(), WALKGRAPH_SCHEMA)?;
    let extract: OsmExtract = io::load(a[2].as_ref(), "osm-extract-v1")?;
    let t = Instant::now();
    let router = kante_walk::WalkRouter::new(Arc::new(graph));
    eprintln!("walk index {:.2}s", t.elapsed().as_secs_f32());
    let t = Instant::now();
    let data = kante_link::link(&tt, &router, &extract, &kante_link::LinkOptions::default());
    eprintln!("link {:.2}s", t.elapsed().as_secs_f32());
    println!("{}", kante_link::report(&tt, &data));
    let sides = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    for name in &a[4..] {
        for (si, st) in tt.stations.iter().enumerate().filter(|(_, s)| &s.name == name) {
            println!("\n== {} (station {si}, didok {})", st.name, st.didok);
            let mut stops = st.stops.clone();
            stops.sort_by_key(|&s| tt.stops[s as usize].label.clone());
            for s in stops {
                let stop = &tt.stops[s as usize];
                let l = &data.links[s as usize];
                let g = router.graph();
                let (kind, way) = if l.matched != LinkMatch::None { (format!("{:?}", g.edges[l.snap.edge as usize].kind), g.edge_way[l.snap.edge as usize]) } else { ("-".into(), 0) };
                println!(
                    "  {:>4}{:<5} {:?} {:<8} snap {:>5.1} m on {:<10} way {:<11} level {:<4} osm {}/{} side {} of '{}' ({:.0} m, kind {}) fp {}/{}",
                    stop.label,
                    stop.sectors,
                    stop.precision,
                    format!("{:?}", l.matched),
                    l.snap.dist_m,
                    kind,
                    way,
                    if l.level == LEVEL_NONE { "-".to_string() } else { format!("{}", l.level as f32 / 2.0) },
                    l.osm_type,
                    l.osm_id,
                    sides.get(l.side.side as usize).unwrap_or(&"?"),
                    l.side.street,
                    l.side.dist_m,
                    l.side.ref_kind,
                    data.normal.from(s).count(),
                    data.step_free.from(s).count(),
                );
            }
        }
    }
    io::save(a[3].as_ref(), LINKS_SCHEMA, &data)?;
    Ok(())
}
