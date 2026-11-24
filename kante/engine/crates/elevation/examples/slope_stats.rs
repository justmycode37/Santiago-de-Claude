//! How steep the walking network is, by kind of way: `cargo run --release -p kante-elevation --example slope_stats -- data/built`.
use kante_core::*;

fn main() -> anyhow::Result<()> {
    let built = std::path::PathBuf::from(std::env::args().nth(1).unwrap());
    let g: WalkGraph = io::load(&built.join("walkgraph.bin"), WALKGRAPH_SCHEMA)?;
    let s: Slopes = io::load(&built.join("slopes.bin"), SLOPES_SCHEMA)?;
    let mut by: std::collections::BTreeMap<String, [f64; 6]> = Default::default();
    for (ed, sl) in g.edges.iter().zip(&s.edges) {
        let len = ed.len_m() as f64;
        if len < 1.0 {
            continue;
        }
        let g = (sl.up_dm as f64 + sl.down_dm as f64) * 0.1 / len;
        let r = by.entry(format!("{:?}", ed.kind)).or_default();
        r[0] += len;
        r[1] += if g >= 0.03 { len } else { 0.0 };
        r[2] += if g >= 0.06 { len } else { 0.0 };
        r[3] += if g >= 0.10 { len } else { 0.0 };
        r[4] += if g >= 0.30 { len } else { 0.0 };
        r[5] += sl.up_dm as f64 * 0.1;
    }
    println!("{:<12} {:>9} {:>6} {:>6} {:>6} {:>6} {:>10}", "kind", "km", ">=3%", ">=6%", ">=10%", ">=30%", "climb km");
    for (k, r) in by {
        let p = |x: f64| 100.0 * x / r[0].max(1.0);
        println!("{:<12} {:>9.0} {:>5.1}% {:>5.1}% {:>5.1}% {:>5.1}% {:>10.0}", k, r[0] / 1000.0, p(r[1]), p(r[2]), p(r[3]), p(r[4]), r[5] / 1000.0);
    }
    Ok(())
}
