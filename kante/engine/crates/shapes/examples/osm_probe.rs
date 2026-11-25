//! The ways with a `railway` tag that have a node within a box: their tags.
//!
//!     cargo run --release -p kante-shapes --example osm_probe -- file.osm.pbf south,west,north,east
use osmpbf::{Element, ElementReader};
fn main() -> anyhow::Result<()> {
    let a: Vec<String> = std::env::args().collect();
    let b: Vec<f64> = a[2].split(',').map(|x| x.parse().unwrap()).collect();
    let mut nodes = std::collections::HashSet::new();
    ElementReader::from_path(&a[1])?.for_each(|e| {
        if let Element::DenseNode(n) = e {
            if n.lat() >= b[0] && n.lat() <= b[2] && n.lon() >= b[1] && n.lon() <= b[3] {
                nodes.insert(n.id());
            }
        }
    })?;
    ElementReader::from_path(&a[1])?.for_each(|e| {
        if let Element::Way(w) = e {
            if w.refs().any(|r| nodes.contains(&r)) {
                let tags: Vec<String> = w.tags().filter(|(k, _)| k.starts_with("railway") || *k == "highway" || *k == "oneway" || *k == "service").map(|(k, v)| format!("{k}={v}")).collect();
                if tags.iter().any(|t| t.starts_with("railway")) {
                    println!("way {} ({} nodes): {}", w.id(), w.refs().count(), tags.join(" "));
                }
            }
        }
    })?;
    Ok(())
}
