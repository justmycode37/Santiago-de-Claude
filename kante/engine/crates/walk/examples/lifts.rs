//! Dev tool: lifts (elevator nodes and lift edges) within a radius of a point.
//! usage: lifts <walkgraph.bin> LAT,LON RADIUS_M
use kante_core::*;
fn main() -> anyhow::Result<()> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let g: WalkGraph = io::load(a[0].as_ref(), WALKGRAPH_SCHEMA)?;
    let v: Vec<f64> = a[1].split(',').map(|x| x.parse().unwrap()).collect();
    let c = LatLon::from_deg(v[0], v[1]);
    let rad: f32 = a[2].parse()?;
    let lv = |l: Level2| if l == LEVEL_NONE { "–".to_string() } else { format!("{}", l as f32 / 2.0) };
    let mut seen = std::collections::BTreeMap::<(i32, i32), (usize, usize, Vec<String>, Vec<String>)>::new();
    for (n, p) in g.nodes.iter().enumerate() {
        if g.node_flags[n] & NF_ELEVATOR == 0 || p.dist_m(&c) > rad { continue; }
        let e = seen.entry((p.lat, p.lon)).or_default();
        e.0 += 1;
        for &ed in g.incident(n as u32) {
            let x = &g.edges[ed as usize];
            if x.kind == EdgeKind::Lift { e.1 += 1; e.2.push(format!("{}↔{}{}", lv(x.level_a), lv(x.level_b), if x.flags & EF_WHEELCHAIR_NO != 0 { " wc=no" } else { "" })); }
            else { e.3.push(format!("{:?}@{} w{}", x.kind, lv(if x.a == n as u32 { x.level_a } else { x.level_b }), g.edge_way[ed as usize])); }
        }
    }
    for ((lat, lon), (ports, lifts, mut ls, ways)) in seen {
        ls.sort(); ls.dedup();
        println!("{:.6},{:.6} ports {ports} lift-edge ends {lifts} [{}] ways: {}", lat as f64 * 1e-7, lon as f64 * 1e-7, ls.join(" "), ways.join(", "));
    }
    Ok(())
}
