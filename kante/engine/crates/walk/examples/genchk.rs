//! Checks on the real graph that A* (`route_between`) and the bounded Dijkstra (`many_to_many_raw`) agree on the
//! generalised cost of a walk (`cargo run --release -p kante-walk --example genchk -- DATA lat lon lat lon [wc]`).
use kante_core::*;
use kante_walk::{SnapOptions, WalkRouter};
use std::sync::Arc;

fn main() -> anyhow::Result<()> {
    let a: Vec<String> = std::env::args().collect();
    let data = std::path::Path::new(&a[1]);
    let mut g: WalkGraph = io::load(&data.join("built/walkgraph.bin"), WALKGRAPH_SCHEMA)?;
    if let Ok(x) = io::load::<WalkAttrs>(&data.join("built/walkattr.bin"), WALKATTR_SCHEMA) {
        g.attrs = x;
    }
    let r = WalkRouter::new(Arc::new(g));
    let p = |i: usize| LatLon::from_deg(a[i].parse().unwrap(), a[i + 1].parse().unwrap());
    let prof = match a.get(6).map(|s| s.as_str()) {
        Some("wc") => WalkProfile::step_free(1.3),
        Some("sf") => WalkProfile { stairs: StairsPref::Never, escalators: false, ..WalkProfile::normal(1.3) },
        _ => WalkProfile::normal(1.3),
    };
    let o = SnapOptions { max_dist_m: 100.0, level: Some(0), profile: Some(prof), exclude_kinds: 0 };
    let (s, t) = (r.snap(p(2), &o).unwrap(), r.snap(p(4), &o).unwrap());
    let (_, _, w, gen) = r.route_between(&[(s, 0.0, 0.0)], &[(t, 0.0, 0.0)], &prof).unwrap();
    let m = r.many_to_many_raw(&[(s, 0.0, 0.0)], &[t], &prof, 3600.0)[0].unwrap();
    let back = r.many_to_many_raw(&[(t, 0.0, 0.0)], &[s], &WalkProfile { backwards: true, ..prof }, 3600.0)[0].unwrap();
    println!("A*: gen {gen:.1} s, {:.0} m walked ({:.0} m long); Dijkstra: gen {:.1} s, {:.0} m; backwards: gen {:.1} s", w.cost.var_m, w.dist_m, m.2, m.1.var_m, back.2);
    Ok(())
}
