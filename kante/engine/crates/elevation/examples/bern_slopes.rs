//! Compares the terrain model's grades with the City of Bern's street slopes (`data/street-slopes.geojson`,
//! Stadt Bern's "Strassensteigungen"): `cargo run --release -p kante-elevation --example bern_slopes -- DEM GEOJSON`.
use kante_core::LatLon;
use kante_elevation::dem::{wgs84_to_lv95, Dem, Terrain};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let dem = Dem::open(std::path::Path::new(&args[1]))?;
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&args[2])?)?;
    let mut rows = Vec::new();
    for f in v["features"].as_array().unwrap() {
        let p = &f["properties"];
        let (Some(pct), Some(dir)) = (p["slope_pct"].as_f64(), p["direction"].as_str()) else { continue };
        let cs: Vec<LatLon> = f["geometry"]["coordinates"].as_array().unwrap().iter().map(|c| LatLon::from_deg(c[1].as_f64().unwrap(), c[0].as_f64().unwrap())).collect();
        if cs.len() < 2 {
            continue;
        }
        let len: f32 = cs.windows(2).map(|w| w[0].dist_m(&w[1])).sum();
        if len < 30.0 {
            continue;
        }
        let h = dem.heights(&[wgs84_to_lv95(&cs[0]), wgs84_to_lv95(cs.last().unwrap())]);
        let ours = (h[1] - h[0]) / len * 100.0;
        let theirs = pct.abs() as f32 * if dir.starts_with("up") { 1.0 } else { -1.0 };
        rows.push((theirs, ours, len));
    }
    let n = rows.len() as f32;
    let mut err: Vec<f32> = rows.iter().map(|r| (r.0 - r.1).abs()).collect();
    err.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let same_sign = rows.iter().filter(|r| r.0.abs() < 1.0 || r.0.signum() == r.1.signum()).count() as f32;
    let (mx, my) = (rows.iter().map(|r| r.0).sum::<f32>() / n, rows.iter().map(|r| r.1).sum::<f32>() / n);
    let cov: f32 = rows.iter().map(|r| (r.0 - mx) * (r.1 - my)).sum();
    let (vx, vy): (f32, f32) = (rows.iter().map(|r| (r.0 - mx).powi(2)).sum(), rows.iter().map(|r| (r.1 - my).powi(2)).sum());
    let class = |g: f32| if g.abs() < 3.0 { 0 } else if g.abs() < 6.0 { 1 } else if g.abs() < 10.0 { 2 } else { 3 };
    let same_class = rows.iter().filter(|r| class(r.0) == class(r.1)).count() as f32;
    println!(
        "{} segments of 30 m or more: |grade error| median {:.2} %, 90th {:.2} %; same direction {:.1} %; same class {:.1} %; r = {:.3}",
        rows.len(),
        err[err.len() / 2],
        err[err.len() * 9 / 10],
        100.0 * same_sign / n,
        100.0 * same_class / n,
        cov / (vx.sqrt() * vy.sqrt())
    );
    Ok(())
}
