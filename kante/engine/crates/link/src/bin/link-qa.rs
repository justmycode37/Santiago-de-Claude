//! Dev tool: quality checks on the linker's output against real data.
//!
//! ```text
//! link-qa <timetable.bin> <walkgraph.bin> <osm-extract.bin> <command> [args]
//!   unlinked            who is not attached to the network, and why
//!   far [N]             stops snapped more than 25 m away, worst first
//!   hub NAME...         every stop of the stations with these exact names
//!   sides [N]           side-of-road descriptions checked against the geometry
//!   footpaths           sanity of the precomputed footpaths
//!   standing            what kind of edge the stops of each mode stand on
//!   find WORD...        station names containing all the words
//! ```
//! With `KANTE_LINKS=<links.bin>` an existing file is checked instead of
//! linking afresh.
use kante_core::*;
use kante_walk::{SnapOptions, WalkRouter};
use std::collections::BTreeMap;
use std::sync::Arc;

struct Ctx {
    tt: Timetable,
    router: WalkRouter,
    extract: OsmExtract,
    data: LinkData,
}

fn swiss(tt: &Timetable, s: &Stop) -> bool {
    tt.stations[s.station as usize].didok / 100_000 == 85
}

fn main_mode(m: u16) -> &'static str {
    Mode::ALL.iter().find(|x| m & x.bit() != 0).map(|x| x.as_str()).unwrap_or("none")
}

fn lv(l: Level2) -> String {
    if l == LEVEL_NONE {
        "–".into()
    } else {
        format!("{}", l as f32 / 2.0)
    }
}

fn unlinked(c: &Ctx) {
    let g = c.router.graph();
    let mut area = BBox::empty();
    for p in g.nodes.iter().step_by(16) {
        area.extend(p);
    }
    let mut classes: BTreeMap<String, (usize, Vec<String>)> = BTreeMap::new();
    let mut by_mode: BTreeMap<&str, usize> = BTreeMap::new();
    let mut n = 0;
    for (i, s) in c.tt.stops.iter().enumerate() {
        if c.data.links[i].matched != LinkMatch::None {
            continue;
        }
        n += 1;
        let st = &c.tt.stations[s.station as usize];
        let liechtenstein = s.pos.lat > 470_400_000 && s.pos.lat < 472_800_000 && s.pos.lon > 94_700_000 && s.pos.lon < 96_400_000;
        let class = if s.pos.is_none() {
            "no coordinate".to_string()
        } else if liechtenstein {
            "Liechtenstein (Swiss-numbered, but not in the Swiss OSM extract)".to_string()
        } else if !swiss(&c.tt, s) {
            if area.contains(&s.pos) { "foreign stop inside the graph's bounding box (no ways there)" } else { "foreign stop outside the graph" }.to_string()
        } else {
            // how far is the nearest edge of any kind?
            let d = c.router.snap(s.pos, &SnapOptions { max_dist_m: 2000.0, level: None, profile: None, exclude_kinds: 0 }).map(|x| x.dist_m);
            *by_mode.entry(main_mode(s.modes)).or_default() += 1;
            match d {
                None => "Swiss: no way within 2 km".to_string(),
                Some(d) if d > 500.0 => "Swiss: nearest way 500 m – 2 km".to_string(),
                Some(d) if d > 200.0 => "Swiss: nearest way 200–500 m".to_string(),
                Some(d) if d > 80.0 => "Swiss: nearest way 80–200 m".to_string(),
                Some(_) => "Swiss: a way within 80 m but not linked".to_string(),
            }
        };
        let e = classes.entry(class).or_default();
        e.0 += 1;
        if e.1.len() < 12 {
            e.1.push(format!("{} [{}] {:.5},{:.5} {}", st.name, s.label, s.pos.lat_deg(), s.pos.lon_deg(), main_mode(s.modes)));
        }
    }
    println!("{n} unlinked stops");
    for (k, (n, ex)) in &classes {
        println!("{n:>6}  {k}");
        for e in ex {
            println!("          {e}");
        }
    }
    println!("unlinked Swiss stops by mode: {by_mode:?}");
}

const SIDES: [&str; 8] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

fn platform_of<'a>(c: &'a Ctx, l: &StopLink) -> Option<&'a OsmPlatform> {
    if l.osm_id == 0 {
        return None;
    }
    let i = c.extract.platforms.binary_search_by(|p| (p.osm_type, p.osm_id).cmp(&(l.osm_type, l.osm_id))).ok()?;
    Some(&c.extract.platforms[i])
}

fn stop_line(c: &Ctx, s: StopIdx) -> String {
    let g = c.router.graph();
    let stop = &c.tt.stops[s as usize];
    let l = &c.data.links[s as usize];
    let edge = if l.matched != LinkMatch::None {
        let ed = &g.edges[l.snap.edge as usize];
        format!("{:?}{} lvl {}/{} way {}", ed.kind, if ed.flags & EF_AREA != 0 { "+area" } else { "" }, lv(ed.level_a), lv(ed.level_b), g.edge_way[l.snap.edge as usize])
    } else {
        "-".into()
    };
    let pl = match platform_of(c, l) {
        Some(p) => format!("{:?} {}/{} refs {:?} lvl {} modes {:#04x} uic {}", p.kind, p.osm_type, p.osm_id, p.refs, lv(p.level), p.modes, p.uic_ref),
        None => "no osm object".into(),
    };
    format!(
        "{:>6}{:<5} {:<5} {:.6},{:.6} {:<13} {:<7} {:>5.1} m  level {:<4} on {:<44} | {} | side {} of '{}' ({:.0} m, kind {}) | fp {}/{}",
        stop.label,
        stop.sectors,
        main_mode(stop.modes),
        stop.pos.lat_deg(),
        stop.pos.lon_deg(),
        format!("{:?}", stop.precision),
        format!("{:?}", l.matched),
        l.snap.dist_m,
        lv(l.level),
        edge,
        pl,
        SIDES.get(l.side.side as usize).unwrap_or(&"?"),
        l.side.street,
        l.side.dist_m,
        l.side.ref_kind,
        c.data.normal.from(s).count(),
        c.data.step_free.from(s).count()
    )
}

fn hub(c: &Ctx, names: &[String]) {
    for name in names {
        for (si, st) in c.tt.stations.iter().enumerate().filter(|(_, s)| &s.name == name) {
            println!("\n== {} (station {si}, didok {}, {:.6},{:.6})", st.name, st.didok, st.pos.lat_deg(), st.pos.lon_deg());
            let mut stops = st.stops.clone();
            stops.sort_by_key(|&s| (c.tt.stops[s as usize].label.clone(), c.tt.stops[s as usize].sectors.clone()));
            for s in stops {
                println!("  {}", stop_line(c, s));
            }
        }
    }
}

/// Where linked stops stand, by mode: the systematic view of "is this a
/// place a person can wait".
fn standing(c: &Ctx) {
    let g = c.router.graph();
    let mut t: BTreeMap<(&str, String), usize> = BTreeMap::new();
    for (i, s) in c.tt.stops.iter().enumerate() {
        let l = &c.data.links[i];
        if l.matched == LinkMatch::None {
            continue;
        }
        let ed = &g.edges[l.snap.edge as usize];
        *t.entry((main_mode(s.modes), format!("{:?}", ed.kind))).or_default() += 1;
    }
    let mut modes: Vec<&str> = t.keys().map(|k| k.0).collect();
    modes.dedup();
    for m in modes {
        let row: Vec<String> = t.iter().filter(|(k, _)| k.0 == m).map(|(k, n)| format!("{} {}", k.1, n)).collect();
        println!("  {m:<10} {}", row.join(", "));
    }
}

fn far(c: &Ctx, n: usize) {
    let mut v: Vec<u32> = (0..c.tt.stops.len() as u32).filter(|&s| c.data.links[s as usize].matched != LinkMatch::None && c.data.links[s as usize].snap.dist_m > 25.0).collect();
    v.sort_by(|a, b| c.data.links[*b as usize].snap.dist_m.partial_cmp(&c.data.links[*a as usize].snap.dist_m).unwrap());
    let mut hist: BTreeMap<String, usize> = BTreeMap::new();
    for &s in &v {
        let (stop, l) = (&c.tt.stops[s as usize], &c.data.links[s as usize]);
        let d = l.snap.dist_m;
        let band = if d > 80.0 { ">80" } else if d > 50.0 { "50–80" } else { "25–50" };
        *hist.entry(format!("{:<9} {:<8} {:<13} {band}", main_mode(stop.modes), format!("{:?}", l.matched), format!("{:?}", stop.precision))).or_default() += 1;
    }
    println!("{} stops snapped more than 25 m from their registry coordinate", v.len());
    for (k, n) in &hist {
        println!("  {n:>5}  {k}");
    }
    let step = (v.len() / n.max(1)).max(1);
    println!("every {step}th, farthest first:");
    for &s in v.iter().step_by(step) {
        let st = &c.tt.stations[c.tt.stops[s as usize].station as usize];
        println!("  {:<34} {:.5},{:.5} {}", st.name.chars().take(34).collect::<String>(), c.tt.stops[s as usize].pos.lat_deg(), c.tt.stops[s as usize].pos.lon_deg(), stop_line(c, s));
    }
}

/// Independent check of the side-of-road descriptions: for every stop that
/// names a street, look at all carriageways with that name within 60 m of
/// the registry point (brute force, no shared code with the linker) and see
/// on which compass side of each the registry point lies.
fn sides(c: &Ctx, show: usize) {
    use std::collections::HashMap;
    let x = &c.extract;
    let cell = 100.0f32;
    let key = |px: f32, py: f32| (((px / cell).floor() as i64) << 32) ^ ((py / cell).floor() as i64 & 0xffff_ffff);
    let mut grid: HashMap<i64, Vec<(u32, u16)>> = HashMap::new();
    for (ci, cw) in x.carriageways.iter().enumerate() {
        if cw.kind != CarriagewayKind::Road || cw.name == 0 {
            continue;
        }
        let geom = &x.carriageway_geom[cw.geom_off as usize..cw.geom_off as usize + cw.geom_len as usize];
        for (si, w) in geom.windows(2).enumerate() {
            let (a, b) = (w[0].xy(), w[1].xy());
            let n = (w[0].dist_m(&w[1]) / 50.0).ceil().max(1.0) as usize;
            for i in 0..=n {
                let t = i as f32 / n as f32;
                grid.entry(key(a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)).or_default().push((ci as u32, si as u16));
            }
        }
    }
    let dirs = [0.0f32, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0];
    let (mut named, mut ok, mut on_line, mut contradicted, mut no_street) = (0usize, 0usize, 0usize, 0usize, 0usize);
    let mut by_kind = [[0usize; 3]; 3]; // ref_kind → [with side, with side + street, no side]
    let mut bad: Vec<String> = Vec::new();
    let mut sample: Vec<String> = Vec::new();
    for (i, s) in c.tt.stops.iter().enumerate() {
        let l = &c.data.links[i];
        if l.side.ref_kind <= 2 {
            let k = l.side.ref_kind as usize;
            if l.side.side > 7 {
                by_kind[k][2] += 1;
            } else {
                by_kind[k][0] += 1;
                by_kind[k][1] += !l.side.street.is_empty() as usize;
            }
        }
        if l.side.side > 7 {
            continue;
        }
        if l.side.street.is_empty() {
            no_street += 1;
            continue;
        }
        named += 1;
        let claimed = dirs[l.side.side as usize];
        let (px, py) = s.pos.xy();
        // nearest point per carriageway with that name
        let mut per: HashMap<u32, (f32, f32)> = HashMap::new();
        for dx in -1..=1 {
            for dy in -1..=1 {
                let Some(list) = grid.get(&key(px + dx as f32 * cell, py + dy as f32 * cell)) else { continue };
                for &(ci, si) in list {
                    let cw = &x.carriageways[ci as usize];
                    if x.carriageway_names[cw.name as usize] != l.side.street {
                        continue;
                    }
                    let a = x.carriageway_geom[cw.geom_off as usize + si as usize];
                    let b = x.carriageway_geom[cw.geom_off as usize + si as usize + 1];
                    let (t, d) = geo::project_on_segment(&s.pos, &a, &b);
                    // Only where the point lies squarely beside the segment:
                    // seen from the end of a street round the corner, "side" means nothing.
                    if t <= 0.01 || t >= 0.99 {
                        continue;
                    }
                    let e = per.entry(ci).or_insert((f32::MAX, 0.0));
                    if d < e.0 {
                        *e = (d, a.lerp(&b, t).bearing_deg(&s.pos));
                    }
                }
            }
        }
        let near: Vec<(f32, f32)> = per.values().copied().filter(|p| p.0 <= 40.0).collect();
        let diff = |b: f32| {
            let d = (b - claimed).rem_euclid(360.0);
            d.min(360.0 - d)
        };
        let st = &c.tt.stations[s.station as usize];
        let line = format!("{} [{}] {:.6},{:.6} {} side of {} ({:?}, registry {:.1} m from its snap)", st.name, s.label, s.pos.lat_deg(), s.pos.lon_deg(), SIDES[l.side.side as usize], l.side.street, l.matched, l.snap.dist_m);
        if near.iter().any(|p| p.0 >= 2.0 && diff(p.1) > 90.0) {
            contradicted += 1;
            if bad.len() < show {
                bad.push(format!("{line}; registry point is {}", near.iter().map(|p| format!("{:.0} m at {:.0}°", p.0, p.1)).collect::<Vec<_>>().join(" / ")));
            }
        } else if near.iter().all(|p| p.0 < 2.0) {
            // (also: no carriageway of that name squarely beside the point)
            on_line += 1;
        } else {
            ok += 1;
            if i % 2011 == 0 && sample.len() < show {
                sample.push(format!("{line}; registry point is {}", near.iter().map(|p| format!("{:.0} m at {:.0}°", p.0, p.1)).collect::<Vec<_>>().join(" / ")));
            }
        }
    }
    println!("reference line     with side  …and street   line found, no side");
    for (k, name) in ["road", "tram track", "railway"].iter().enumerate() {
        println!("  {name:<12} {:>12} {:>13} {:>21}", by_kind[k][0], by_kind[k][1], by_kind[k][2]);
    }
    println!("{named} stops name a street; {no_street} have a side without a street name");
    println!("  {ok} agree with the registry point seen from every carriageway of that name within 40 m");
    println!("  {on_line} cannot be checked this way (registry point within 2 m of the line; side came from the standing point)");
    println!("  {contradicted} are contradicted by the registry point");
    for b in &bad {
        println!("    ✗ {b}");
    }
    println!("random agreeing examples:");
    for b in &sample {
        println!("    ✓ {b}");
    }
}

fn footpaths(c: &Ctx) {
    let tt = &c.tt;
    for (name, fp) in [("normal", &c.data.normal), ("step-free", &c.data.step_free)] {
        let n = tt.stops.len();
        let bytes = fp.off.len() * 4 + fp.to.len() * 4 + fp.var_m.len() * 2 + fp.fix_s.len() * 2;
        let mut counts: Vec<usize> = (0..n as u32).map(|s| fp.from(s).count()).collect();
        let with = counts.iter().filter(|c| **c > 0).count();
        counts.sort_unstable();
        let q = |p: f64| counts[((n - 1) as f64 * p) as usize];
        println!("\n{name}: {} footpaths, {:.1} MB; {with} of {n} stops have any; per stop: median {}, p90 {}, p99 {}, max {}", fp.len(), bytes as f64 / 1e6, q(0.5), q(0.9), q(0.99), q(1.0));
        let (mut asym_missing, mut asym_cost, mut asym_big, mut shorter_than_beeline, mut slow, mut self_loops, mut unsorted) = (0usize, 0usize, 0usize, 0usize, 0usize, 0usize, 0usize);
        let (mut same_missing, mut same_total, mut estimates) = (0usize, 0usize, 0usize);
        let mut worst: Vec<(f32, String)> = Vec::new();
        for s in 0..n as u32 {
            let a = &tt.stops[s as usize];
            let mut prev = None;
            for (t, var, fix) in fp.from(s) {
                if prev.map_or(false, |p| p >= t) {
                    unsorted += 1;
                }
                prev = Some(t);
                if t == s {
                    self_loops += 1;
                }
                let b = &tt.stops[t as usize];
                let d = a.pos.dist_m(&b.pos);
                // the walk includes the way from each registry point to the network, so it cannot beat the beeline by much
                if (var as f32) < d - 3.0 {
                    shorter_than_beeline += 1;
                }
                let secs = walk_secs(var as f32, fix as f32, DEFAULT_SPEED_MPS);
                if secs > 721.0 {
                    slow += 1;
                }
                let estimate = var == (d * 1.5 + 10.0).ceil() as u16;
                estimates += estimate as usize;
                match fp.get(t, s) {
                    None => asym_missing += 1,
                    Some((v2, f2)) => {
                        let back = walk_secs(v2 as f32, f2 as f32, DEFAULT_SPEED_MPS);
                        if (back - secs).abs() > 2.0 {
                            asym_cost += 1;
                        }
                        if (back - secs).abs() > 60.0 {
                            asym_big += 1;
                            if worst.len() < 400 {
                                worst.push(((back - secs).abs(), format!("{} [{}] → {} [{}]: {:.0} s there, {:.0} s back", tt.stations[a.station as usize].name, a.label, tt.stations[b.station as usize].name, b.label, secs, back)));
                            }
                        }
                    }
                }
            }
            // every other stop of the same station within 450 m
            for &t in &tt.stations[a.station as usize].stops {
                if t != s && !a.pos.is_none() && tt.stops[t as usize].pos.dist_m(&a.pos) <= 450.0 {
                    same_total += 1;
                    if fp.get(s, t).is_none() {
                        same_missing += 1;
                    }
                }
            }
        }
        println!("  order and identity: {unsorted} rows out of order, {self_loops} self loops");
        println!("  symmetry: {asym_missing} have no way back, {asym_cost} differ by more than 2 s from the way back, {asym_big} by more than a minute");
        worst.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
        for (_, w) in worst.iter().take(4) {
            println!("    {w}");
        }
        println!("  values: {shorter_than_beeline} shorter than the beeline between the registry points, {slow} longer than the 720 s bound");
        println!("  same station (≤ 450 m apart): {same_missing} of {same_total} pairs missing; {estimates} footpaths are beeline estimates");
    }
    // step-free against normal
    let (mut not_in_normal, mut faster, mut much_faster) = (0usize, 0usize, 0usize);
    for s in 0..tt.stops.len() as u32 {
        for (t, var, fix) in c.data.step_free.from(s) {
            match c.data.normal.get(s, t) {
                None => not_in_normal += 1,
                Some((v, f)) => {
                    let (sf, no) = (walk_secs(var as f32, fix as f32, DEFAULT_SPEED_MPS), walk_secs(v as f32, f as f32, DEFAULT_SPEED_MPS));
                    faster += (sf < no - 2.0) as usize;
                    much_faster += (sf < no - 30.0) as usize;
                }
            }
        }
    }
    println!("\nstep-free vs normal: {not_in_normal} step-free footpaths have no normal counterpart; {faster} are more than 2 s faster than the normal one ({much_faster} more than 30 s)");
    // identical standing points inside one station
    let (mut dup_stops, mut dup_groups, mut fp_saved) = (0usize, 0usize, 0usize);
    for st in &tt.stations {
        let mut by: BTreeMap<(u32, u32), Vec<StopIdx>> = BTreeMap::new();
        for &s in &st.stops {
            let l = &c.data.links[s as usize];
            if l.matched != LinkMatch::None {
                by.entry((l.snap.edge, (l.snap.frac * 1e6) as u32)).or_default().push(s);
            }
        }
        for v in by.values().filter(|v| v.len() > 1) {
            dup_groups += 1;
            dup_stops += v.len() - 1;
            for &s in &v[1..] {
                fp_saved += c.data.normal.from(s).count();
            }
        }
    }
    println!("identical standing points within a station: {dup_groups} groups, {dup_stops} surplus stops; their normal footpaths: {fp_saved} ({:.1} % of all)", 100.0 * fp_saved as f64 / c.data.normal.len().max(1) as f64);
}

fn main() -> anyhow::Result<()> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a.len() < 4 {
        anyhow::bail!("usage: link-qa <timetable.bin> <walkgraph.bin> <osm-extract.bin> unlinked | far [N] | hub NAME... | sides [N] | footpaths");
    }
    let tt: Timetable = io::load(a[0].as_ref(), TIMETABLE_SCHEMA)?;
    let graph: WalkGraph = io::load(a[1].as_ref(), WALKGRAPH_SCHEMA)?;
    let extract: OsmExtract = io::load(a[2].as_ref(), "osm-extract-v1")?;
    let router = WalkRouter::new(Arc::new(graph));
    // KANTE_LINKS=<links.bin>: check an existing file instead of linking afresh.
    let data: LinkData = match std::env::var_os("KANTE_LINKS") {
        Some(f) => io::load(f.as_ref(), LINKS_SCHEMA)?,
        None => kante_link::link(&tt, &router, &extract, &kante_link::LinkOptions::default()),
    };
    eprintln!("{}", kante_link::report(&tt, &data));
    let c = Ctx { tt, router, extract, data };
    match a[3].as_str() {
        "unlinked" => unlinked(&c),
        "hub" => hub(&c, &a[4..]),
        "find" => {
            for st in c.tt.stations.iter().filter(|s| a[4..].iter().all(|w| s.name.to_lowercase().contains(&w.to_lowercase()))).take(40) {
                println!("{} | {} stops | {}", st.name, st.stops.len(), main_mode(st.modes));
            }
        }
        "standing" => standing(&c),
        "footpaths" => footpaths(&c),
        "sides" => sides(&c, a.get(4).and_then(|x| x.parse().ok()).unwrap_or(20)),
        "far" => far(&c, a.get(4).and_then(|x| x.parse().ok()).unwrap_or(40)),
        other => anyhow::bail!("unknown command {other}"),
    }
    Ok(())
}
