//! What the shapes in `data/built/shapes.bin` are like: straight hops by mode, and a sample of them to look at.
//!
//!     cargo run --release -p kante-shapes --example shape_stats -- data [mode] [n]

use kante_core::*;
use kante_shapes::*;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let data = std::path::PathBuf::from(args.get(1).map(|s| s.as_str()).unwrap_or("data"));
    let want = args.get(2).cloned().unwrap_or_default();
    let n_show: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(20);
    let tt: Timetable = io::load(&data.join("built/timetable.bin"), TIMETABLE_SCHEMA)?;
    let sh: Shapes = io::load(&data.join("built/shapes.bin"), SHAPES_SCHEMA)?;
    let mut by_mode: std::collections::BTreeMap<&str, [usize; 4]> = Default::default();
    let mut shown = 0;
    let mut seen = rustc_hash::FxHashSet::default();
    for p in 0..tt.patterns.len() as PatternIdx {
        let line = &tt.lines[tt.patterns[p as usize].line as usize];
        let stops = tt.pattern_stops(p);
        let e = by_mode.entry(line.mode.as_str()).or_default();
        if sh.shape_of(p).is_none() {
            e[3] += 1;
            continue;
        };
        for k in 0..stops.len() - 1 {
            let w = sh.piece(p, k, k + 1).unwrap();
            let a = &tt.stops[stops[k] as usize];
            let b = &tt.stops[stops[k + 1] as usize];
            if w.straight {
                e[2] += 1;
                let swiss = |q: &LatLon| q.lat_deg() > 45.83 && q.lat_deg() < 47.8 && q.lon_deg() > 5.97 && q.lon_deg() < 10.48;
                if swiss(&a.pos) && swiss(&b.pos) && (want.is_empty() || want == line.mode.as_str()) && shown < n_show && seen.insert((stops[k], stops[k + 1])) && (shown * 97 + k) % 3 == 0 {
                    shown += 1;
                    println!(
                        "{} {:<8} {} [{}] ({:.5},{:.5}) -> {} [{}] ({:.5},{:.5})  {:.0} m  rel {}",
                        line.mode.as_str(),
                        line.name,
                        tt.stations[a.station as usize].name,
                        a.label,
                        a.pos.lat_deg(),
                        a.pos.lon_deg(),
                        tt.stations[b.station as usize].name,
                        b.label,
                        b.pos.lat_deg(),
                        b.pos.lon_deg(),
                        a.pos.dist_m(&b.pos),
                        sh.relation_of(p)
                    );
                }
            } else {
                e[0] += 1;
            }
            e[1] += 1;
        }
    }
    for (m, c) in by_mode {
        println!("{m:<10} hops {:>8}  straight {:>7} ({:>5.1} %)  patterns without shape {}", c[1], c[2], 100.0 * c[2] as f64 / c[1].max(1) as f64, c[3]);
    }
    Ok(())
}
