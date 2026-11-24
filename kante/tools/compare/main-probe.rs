// Run with A's (`main`'s) own walk code on B's graph: for each line of stdin (`compare explain`'s output:
// "b_start" and "b_target" as [edge, frac, metres], "options", "limit" in minutes), whether A's one_to_many reaches
// the target from the start within the limit, as A's stop search computes it (the 30 s buffer included).
// Copy into the main worktree as kante/engine/crates/walk/examples/probe.rs and run
//   cargo run --release -p kante-walk --example probe -- <B's walkgraph.bin> < explained.jsonl
use kante_core::*;
use kante_walk::*;
use std::io::BufRead;
fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let g: WalkGraph = io::load(a[0].as_ref(), WALKGRAPH_SCHEMA).unwrap();
    let r = WalkRouter::new(std::sync::Arc::new(g));
    for line in std::io::stdin().lock().lines() {
        let v: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        let snap = |x: &serde_json::Value| -> Option<Snap> {
            let e = x[0].as_u64()? as u32;
            let f = x[1].as_f64()? as f32;
            let s = r.snap_at(e, f);
            Some(Snap { dist_m: x[2].as_f64()? as f32, ..s })
        };
        let o = &v["options"];
        let stairs = match o["stairs"].as_str() { Some("never") => StairsPref::Never, Some("avoid") => StairsPref::Avoid, _ => StairsPref::Ok };
        let wc = o["wheelchair"].as_bool().unwrap_or(false);
        let prof = WalkProfile { speed_mps: 1.3, stairs, escalators: o["escalators"].as_bool().unwrap_or(true) && !wc, lifts: true, wheelchair: wc, ..WalkProfile::normal(1.3) };
        let max = v["limit"].as_f64().unwrap_or(20.0) as f32 * 60.0;
        let res = match (snap(&v["b_start"]), snap(&v["b_target"])) {
            (Some(s), Some(t)) => r.one_to_many(&s, &[t], &prof, max)[0].map(|c| walk_secs(c.var_m + s.dist_m + t.dist_m, c.fix_s, 1.3).ceil() + 30.0).filter(|secs| *secs <= max),
            _ => None,
        };
        println!("{}", serde_json::json!({ "key": v["key"], "a_code_on_b_graph": res }));
    }
}
