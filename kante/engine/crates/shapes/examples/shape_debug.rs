//! Lays stops onto the network and says what came out: a few points, or a timetable pattern.
//!
//!     cargo run --release -p kante-shapes --example shape_debug -- data tram lat,lon lat,lon …
//!     cargo run --release -p kante-shapes --example shape_debug -- data tram 'pattern:14:Cornavin'

use kante_core::geo::LatLon;
use kante_core::*;
use kante_shapes::matcher::*;
use kante_shapes::net;

fn main() -> anyhow::Result<()> {
    let a: Vec<String> = std::env::args().collect();
    let data = std::path::PathBuf::from(&a[1]);
    let n = net::load(&data.join("raw/osm/switzerland-latest.osm.pbf"))?;
    let mode = Mode::ALL.into_iter().find(|m| m.as_str() == a[2]).expect("mode");
    let p = profile(mode).unwrap();
    let tt: Option<Timetable> = a[3].starts_with("pattern:").then(|| io::load(&data.join("built/timetable.bin"), TIMETABLE_SCHEMA)).transpose()?;
    let (line, stops, names): (String, Vec<StopIn>, Vec<String>) = match &tt {
        Some(tt) => {
            let parts: Vec<&str> = a[3].splitn(3, ':').collect();
            let pat = (0..tt.patterns.len() as PatternIdx)
                .find(|&q| {
                    let l = &tt.lines[tt.patterns[q as usize].line as usize];
                    let name = |s: StopIdx| &tt.stations[tt.stops[s as usize].station as usize].name;
                    let want: Vec<&str> = parts[2].split('>').collect();
                    l.mode == mode && l.name == parts[1] && tt.pattern_stops(q).windows(want.len()).any(|w| w.iter().zip(&want).all(|(&s, x)| name(s).contains(x)))
                })
                .expect("no such pattern");
            let st = tt.pattern_stops(pat);
            (
                parts[1].to_string(),
                st.iter().map(|&s| StopIn::of(&tt.stops[s as usize])).collect(),
                st.iter().map(|&s| format!("{} [{}]", tt.stations[tt.stops[s as usize].station as usize].name, tt.stops[s as usize].label)).collect(),
            )
        }
        None => {
            let stops: Vec<StopIn> = a[3..]
                .iter()
                .map(|s| {
                    let v: Vec<f64> = s.split(',').map(|x| x.parse().unwrap()).collect();
                    StopIn { pos: LatLon::from_deg(v[0], v[1]), label: "", precision: Precision::Edge }
                })
                .collect();
            let names = a[3..].to_vec();
            (std::env::var("LINE").unwrap_or_default(), stops, names)
        }
    };
    let rel = pick_relation(&n, &p, &net::norm_ref(&line), &stops);
    println!("relation {:?}", rel.map(|r| (n.rels[r.0 as usize].id, r.1)));
    let mut s = Scratch::new(&n);
    let m = match_pattern(&n, &p, &mut s, &stops, rel.map(|r| r.0));
    for (k, name) in names.iter().enumerate() {
        let st = &stops[k];
        println!(
            "{k:>3} {name:<40} ({:.5},{:.5}) cands {:>2} snap {:>5.1} m {}",
            st.pos.lat_deg(),
            st.pos.lon_deg(),
            debug_candidates(&n, &p, st).len(),
            m.snap_m[k],
            m.hops.get(k).map_or("", |h| match *h {
                HOP_NET => "→ network",
                HOP_LINE => "→ line",
                _ => "→ STRAIGHT",
            })
        );
    }
    if std::env::var_os("PTS").is_some() {
        for q in &m.pts {
            let l = LatLon::from_xy(q[0], q[1]);
            print!("[{:.6},{:.6}],", l.lon_deg(), l.lat_deg());
        }
        println!();
    }
    Ok(())
}
