//! Dev tool: walk edges and platform objects within R metres of a point.
//! usage: near <walkgraph.bin> <osm-extract.bin> LAT,LON R
use kante_core::*;
use kante_walk::{SnapOptions, WalkRouter};
use std::sync::Arc;
fn main() -> anyhow::Result<()> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let g: WalkGraph = io::load(a[0].as_ref(), WALKGRAPH_SCHEMA)?;
    let x: OsmExtract = io::load(a[1].as_ref(), kante_core::walk::EXTRACT_SCHEMA)?;
    let v: Vec<f64> = a[2].split(',').map(|x| x.parse().unwrap()).collect();
    let p = LatLon::from_deg(v[0], v[1]);
    let r: f32 = a[3].parse()?;
    let router = WalkRouter::new(Arc::new(g));
    let g = router.graph();
    let lv = |l: Level2| if l == LEVEL_NONE { "–".to_string() } else { format!("{}", l as f32 / 2.0) };
    for s in router.snap_candidates(p, &SnapOptions { max_dist_m: r, level: None, profile: None, exclude_kinds: 0 }, 30) {
        let ed = &g.edges[s.edge as usize];
        println!("  edge {:>5.1} m brg {:>3.0} {:<10} lvl {}/{} flags {:#06x} way {} '{}'", s.dist_m, p.bearing_deg(&s.pos), format!("{:?}", ed.kind), lv(ed.level_a), lv(ed.level_b), ed.flags, g.edge_way[s.edge as usize], g.edge_name(s.edge));
    }
    for pl in x.platforms.iter().filter(|pl| pl.pos.dist_m(&p) <= r.max(60.0)) {
        println!("  platform {:>5.1} m brg {:>3.0} {:?} {}/{} refs {:?} lvl {} modes {:#04x} uic {} sloid '{}' edges {} '{}'", pl.pos.dist_m(&p), p.bearing_deg(&pl.pos), pl.kind, pl.osm_type, pl.osm_id, pl.refs, lv(pl.level), pl.modes, pl.uic_ref, pl.sloid, pl.edges.len(), pl.name);
    }
    for cw in &x.carriageways {
        let geom = &x.carriageway_geom[cw.geom_off as usize..cw.geom_off as usize + cw.geom_len as usize];
        let mut best = (f32::MAX, 0.0f32, 0.0f32);
        for w in geom.windows(2) {
            if (w[0].lat - p.lat).abs() > 50_000 { continue; }
            let (t, d) = geo::project_on_segment(&p, &w[0], &w[1]);
            if d < best.0 { best = (d, p.bearing_deg(&w[0].lerp(&w[1], t)), w[0].bearing_deg(&w[1])); }
        }
        if best.0 <= r { println!("  line {:>5.1} m brg {:>3.0} {:?} runs {:.0}° '{}'", best.0, best.1, cw.kind, best.2 % 180.0, x.carriageway_names[cw.name as usize]); }
    }
    Ok(())
}
