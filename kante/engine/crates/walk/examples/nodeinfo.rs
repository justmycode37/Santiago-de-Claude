//! Dev tool: list the edges meeting at the graph node(s) nearest to LAT,LON.
//! usage: nodeinfo <walkgraph.bin> LAT,LON [LAT,LON ...]
use kante_core::*;
fn main() -> anyhow::Result<()> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let g: WalkGraph = io::load(a[0].as_ref(), WALKGRAPH_SCHEMA)?;
    let lv = |l: Level2| if l == LEVEL_NONE { "–".to_string() } else { format!("{}", l as f32 / 2.0) };
    for s in &a[1..] {
        let v: Vec<f64> = s.split(',').map(|x| x.parse().unwrap()).collect();
        let p = LatLon::from_deg(v[0], v[1]);
        let mut best: Vec<(f32, u32)> = g.nodes.iter().enumerate().map(|(i, q)| (if (q.lat - p.lat).abs() < 3000 { q.dist_m(&p) } else { 1e9 }, i as u32)).filter(|x| x.0 < 3.0).collect();
        best.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap());
        println!("== {s}");
        for (d, n) in best.iter().take(4) {
            println!(" node {n} at {d:.1} m flags {:#04x}", g.node_flags[*n as usize]);
            for &e in g.incident(*n) {
                let ed = &g.edges[e as usize];
                let (here, there, other) = if ed.a == *n { (ed.level_a, ed.level_b, ed.b) } else { (ed.level_b, ed.level_a, ed.a) };
                let q = g.nodes[other as usize];
                println!("   e{e} way {:<11} {:<10} lvl {:>4}→{:<4} flags {:#06x} {:>6.1} m brg {:>3.0} → node {other} '{}'", g.edge_way[e as usize], format!("{:?}", ed.kind), lv(here), lv(there), ed.flags, ed.len_m(), g.nodes[*n as usize].bearing_deg(&q), g.edge_name(e));
            }
        }
    }
    Ok(())
}
