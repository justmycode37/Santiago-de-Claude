//! Dev tool: run the GTFS import, print statistics, check the result against
//! known facts of the national feed and write `data/built/timetable.bin`.
//!
//! ```text
//! gtfs-import [--gtfs ZIP] [--atlas DIR | --no-atlas] [--out FILE | --no-save]
//!             [--min-headway SECS] [--date YYYY-MM-DD] [--check FILE]
//!             [--dump-sample N FILE] [--station DIDOK|NAME]...
//! ```
//! Paths default to `data/raw/gtfs/gtfs.zip`, `data/raw/atlas` and
//! `data/built/timetable.bin` under the project root (found from the current
//! directory or its parents). `--check FILE` loads an existing cache instead
//! of importing. `--dump-sample N FILE` writes N evenly spaced trips (stops,
//! times, flags, running days) as TSV for an independent comparison with the
//! raw feed. `--station` prints the stops of a station (DiDok number or exact name).

use anyhow::{anyhow, bail, Context, Result};
use kante_core::time::{self, Date};
use kante_core::*;
use kante_gtfs::{import_with_report, verify, ImportOptions, ImportReport};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn project_root() -> PathBuf {
    let mut dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    loop {
        if dir.join("data/raw").is_dir() {
            return dir;
        }
        if !dir.pop() {
            return PathBuf::from(".");
        }
    }
}

fn peak_rss_mb() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    line.split_whitespace().nth(1)?.parse::<u64>().ok().map(|kb| kb / 1024)
}

fn hms(s: i32) -> String {
    format!("{:02}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
}

fn main() -> Result<()> {
    let root = project_root();
    let mut gtfs = root.join("data/raw/gtfs/gtfs.zip");
    let mut atlas = Some(root.join("data/raw/atlas"));
    let mut out = Some(root.join("data/built/timetable.bin"));
    let mut min_headway = 300u32;
    let mut date = time::parse_date("2026-11-20").unwrap();
    let mut check: Option<PathBuf> = None;
    let mut dump: Option<(usize, PathBuf)> = None;
    let mut extra_stations: Vec<String> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut val = |name: &str| args.next().ok_or_else(|| anyhow!("{name} needs a value"));
        match a.as_str() {
            "--gtfs" => gtfs = val("--gtfs")?.into(),
            "--atlas" => atlas = Some(val("--atlas")?.into()),
            "--no-atlas" => atlas = None,
            "--out" => out = Some(val("--out")?.into()),
            "--no-save" => out = None,
            "--min-headway" => min_headway = val("--min-headway")?.parse().context("--min-headway")?,
            "--date" => date = time::parse_date(&val("--date")?).ok_or_else(|| anyhow!("--date: expected YYYY-MM-DD"))?,
            "--check" => check = Some(val("--check")?.into()),
            "--station" => extra_stations.push(val("--station")?),
            "--dump-sample" => {
                let n = val("--dump-sample")?.parse().context("--dump-sample N FILE")?;
                dump = Some((n, val("--dump-sample")?.into()));
            }
            "-h" | "--help" => {
                println!("gtfs-import [--gtfs ZIP] [--atlas DIR | --no-atlas] [--out FILE | --no-save] [--min-headway SECS] [--date YYYY-MM-DD] [--check FILE] [--dump-sample N FILE] [--station DIDOK|NAME]...");
                return Ok(());
            }
            other => bail!("unknown argument {other}"),
        }
    }

    let (tt, report) = match &check {
        Some(path) => {
            let t = Instant::now();
            let tt: Timetable = io::load(path, TIMETABLE_SCHEMA)?;
            println!("loaded {} in {:.2} s", path.display(), t.elapsed().as_secs_f64());
            (tt, None)
        }
        None => {
            println!("importing {}\n  atlas: {}", gtfs.display(), atlas.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "(none)".into()));
            let opts = ImportOptions { gtfs_zip: gtfs, atlas_dir: atlas, min_headway_s: min_headway };
            let (tt, rep) = import_with_report(&opts)?;
            println!("{rep}");
            println!("peak RSS after import: {} MB", peak_rss_mb().unwrap_or(0));
            (tt, Some(rep))
        }
    };

    let t = Instant::now();
    let verified = verify(&tt);
    match &verified {
        Ok(()) => println!("\nverify: OK ({:.2} s)", t.elapsed().as_secs_f64()),
        Err(e) => println!("\nverify: FAILED: {e:#}"),
    }

    summary(&tt, report.as_ref(), date);
    bern(&tt);
    gornergrat(&tt, date);
    frequency_example(&tt, date);
    ranking(&tt);
    for q in &extra_stations {
        let didok = q.parse::<u32>().ok().or_else(|| tt.stations.iter().find(|s| &s.name == q).map(|s| s.didok));
        match didok {
            Some(d) if d != 0 => print_station(&tt, d),
            _ => println!("\nstation {q}: NOT FOUND (or it has no DiDok number)"),
        }
    }

    verified?;
    if let Some((n, path)) = &dump {
        dump_sample(&tt, *n, path)?;
        println!("\nwrote sample of {n} trips to {}", path.display());
    }
    if let (Some(path), None) = (&out, &check) {
        let t = Instant::now();
        io::save(path, TIMETABLE_SCHEMA, &tt)?;
        let size = std::fs::metadata(path)?.len();
        println!("\nwrote {} ({:.1} MB) in {:.2} s", path.display(), size as f64 / (1 << 20) as f64, t.elapsed().as_secs_f64());
    }
    println!("peak RSS overall: {} MB", peak_rss_mb().unwrap_or(0));
    Ok(())
}

fn summary(tt: &Timetable, rep: Option<&ImportReport>, date: Date) {
    println!("\n== timetable ==");
    println!("feed version {}  valid {} .. {} ({} days)", tt.feed_version, time::fmt_date(tt.start_date), time::fmt_date(tt.end_date()), tt.n_days);
    println!(
        "agencies {}  lines {}  stations {}  stops {}  patterns {}  trips {}  times {}  strings {}",
        tt.agencies.len(),
        tt.lines.len(),
        tt.stations.len(),
        tt.stops.len(),
        tt.patterns.len(),
        tt.trips.len(),
        tt.times.len(),
        tt.strings.len()
    );
    println!(
        "services {}  continuations {}  official transfers {}  pattern stops {}",
        tt.service_bits.len() / tt.service_words.max(1) as usize,
        tt.continuations.len(),
        tt.official_transfers.len(),
        tt.pattern_stops.len()
    );
    let max_trips = tt.patterns.iter().map(|p| p.n_trips).max().unwrap_or(0);
    let single = tt.patterns.iter().filter(|p| p.n_trips == 1).count();
    println!(
        "trips per pattern: mean {:.1}, max {}, patterns with one trip {}",
        tt.trips.len() as f64 / tt.patterns.len().max(1) as f64,
        max_trips,
        single
    );
    let mut prec = [0usize; 3];
    let (mut labelled, mut sectors, mut compass, mut access) = (0, 0, 0, 0);
    for s in &tt.stops {
        prec[s.precision as usize] += 1;
        labelled += !s.label.is_empty() as usize;
        sectors += !s.sectors.is_empty() as usize;
        compass += (s.compass >= 0) as usize;
        access += (s.access != QuayAccess::Unknown) as usize;
    }
    println!(
        "stops: edge {} / edge-at-station {} / station {};  labelled {}  with sectors {}  compass {}  access known {}",
        prec[0], prec[1], prec[2], labelled, sectors, compass, access
    );
    let mut by_mode: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    for p in &tt.patterns {
        let e = by_mode.entry(tt.lines[p.line as usize].mode.as_str()).or_default();
        e.0 += 1;
        e.1 += p.n_trips as usize;
    }
    println!("patterns / trips by mode: {}", by_mode.iter().map(|(m, (p, t))| format!("{m} {p}/{t}")).collect::<Vec<_>>().join("  "));
    let freq = tt.trips.iter().filter(|t| t.flags & TRIP_FREQUENCY != 0).count();
    println!("frequency trips {}", freq);

    let day = tt.day_index(date);
    println!("{}: {} trips active after frequency expansion", time::fmt_date(date), day.trips.len());
    if let Some(rep) = rep {
        println!("{}: {} trips.txt rows active before frequency expansion", time::fmt_date(date), rep.trip_rows_active(tt, date));
    }
}

fn station_by_didok(tt: &Timetable, didok: u32) -> Option<(StationIdx, &Station)> {
    tt.stations.iter().enumerate().find(|(_, s)| s.didok == didok).map(|(i, s)| (i as u32, s))
}

fn print_station(tt: &Timetable, didok: u32) {
    let Some((idx, st)) = station_by_didok(tt, didok) else {
        println!("station with didok {didok}: NOT FOUND");
        return;
    };
    println!(
        "\n== {} (didok {}, station {}, {}) at {:.6}, {:.6}; weight {}; {} stops ==",
        st.name,
        st.didok,
        idx,
        st.gtfs_id,
        st.pos.lat_deg(),
        st.pos.lon_deg(),
        st.weight,
        st.stops.len()
    );
    let mut stops: Vec<&Stop> = st.stops.iter().map(|&s| &tt.stops[s as usize]).collect();
    stops.sort_by(|a, b| {
        let num = |s: &Stop| s.label.parse::<u32>().unwrap_or(u32::MAX);
        (a.label.is_empty(), num(a), &a.label, &a.sectors, &a.sloid).cmp(&(b.label.is_empty(), num(b), &b.label, &b.sectors, &b.sloid))
    });
    println!("  {:<6} {:<7} {:<11} {:<10} {:<16} {:>7} {:>4} {:>7} {:>8}  sloid", "label", "sectors", "lat", "lon", "precision", "compass", "acc", "dist m", "patterns");
    for s in stops {
        let i = tt.stations[idx as usize].stops.iter().copied().find(|&i| std::ptr::eq(&tt.stops[i as usize], s)).unwrap();
        println!(
            "  {:<6} {:<7} {:<11.6} {:<10.6} {:<16} {:>7} {:>4} {:>7.1} {:>8}  {}",
            if s.label.is_empty() { "-" } else { &s.label },
            if s.sectors.is_empty() { "-" } else { &s.sectors },
            s.pos.lat_deg(),
            s.pos.lon_deg(),
            format!("{:?}", s.precision),
            s.compass,
            s.access as u8,
            s.pos.dist_m(&st.pos),
            tt.stop_patterns(i).len(),
            if s.gtfs_id == s.sloid { s.sloid.clone() } else { format!("{}  [gtfs {}]", s.sloid, s.gtfs_id) }
        );
    }
}

fn bern(tt: &Timetable) {
    print_station(tt, 8576646);
    if let Some((_, st)) = station_by_didok(tt, 8576646) {
        // Expected coordinates from the research report (atlas registry).
        let expect = [
            ("A", 46.947568, 7.440602),
            ("B", 46.947666, 7.440629),
            ("C", 46.947580, 7.440072),
            ("D", 46.947666, 7.440180),
            ("E", 46.948206, 7.440009),
            ("F", 46.947856, 7.439892),
            ("G", 46.948604, 7.440440),
            ("H", 46.949089, 7.440296),
            ("I", 46.947359, 7.440997),
            ("J", 46.946795, 7.440970),
            ("K1", 46.946875, 7.440772),
            ("K2", 46.946648, 7.440871),
            ("L", 46.947298, 7.440548),
            ("M", 46.947377, 7.439683),
            ("N", 46.947047, 7.438967),
            ("Q", 46.947593, 7.439368),
            ("Z", 46.949046, 7.440701),
        ];
        let mut ok = 0;
        for (label, lat, lon) in expect {
            let want = LatLon::from_deg(lat, lon);
            let found: Vec<&Stop> = st.stops.iter().map(|&s| &tt.stops[s as usize]).filter(|s| s.label == label).collect();
            match found.as_slice() {
                [s] if s.pos.dist_m(&want) < 0.5 && s.precision == Precision::Edge => ok += 1,
                [s] => println!("  MISMATCH bay {label}: got {:.6}, {:.6} ({:?}), {:.1} m off", s.pos.lat_deg(), s.pos.lon_deg(), s.precision, s.pos.dist_m(&want)),
                other => println!("  MISMATCH bay {label}: {} stops carry this label", other.len()),
            }
        }
        println!("  check: {ok} of {} lettered bays at the expected coordinate (< 0.5 m)", expect.len());
    }
    print_station(tt, 8507000);
    if let Some((_, st)) = station_by_didok(tt, 8507000) {
        let labels: std::collections::BTreeSet<&str> = st.stops.iter().map(|&s| tt.stops[s as usize].label.as_str()).collect();
        let want = ["21", "22", "23", "24", "49", "50"];
        println!("  check: tracks {:?} present: {}", want, want.iter().all(|w| labels.contains(w)));
        let sect: Vec<&Stop> = st.stops.iter().map(|&s| &tt.stops[s as usize]).filter(|s| s.gtfs_id.ends_with("_pf:5A-C")).collect();
        for s in sect {
            println!(
                "  check: {} -> label {:?} sectors {:?} at {:.6}, {:.6} ({:?})",
                s.gtfs_id,
                s.label,
                s.sectors,
                s.pos.lat_deg(),
                s.pos.lon_deg(),
                s.precision
            );
        }
    }
}

/// Departures on `date` from all stops of a station: (dep, trip).
fn departures(tt: &Timetable, station: StationIdx, date: Date) -> Vec<(i32, TripIdx)> {
    let day = tt.day_index(date);
    let mut out = Vec::new();
    for &s in &tt.stations[station as usize].stops {
        for &(p, pos) in tt.stop_patterns(s) {
            let pat = &tt.patterns[p as usize];
            if pos + 1 == pat.n_stops || tt.pattern_flags(p)[pos as usize] & FLAG_NO_PICKUP != 0 {
                continue;
            }
            for &t in day.pattern_trips(p) {
                out.push((tt.dep(t, pos as usize), t));
            }
        }
    }
    out.sort_unstable();
    out
}

fn gornergrat(tt: &Timetable, date: Date) {
    println!("\n== Zermatt GGB, departures on {} ==", time::fmt_date(date));
    let Some(st) = tt.stations.iter().position(|s| s.name == "Zermatt GGB") else {
        println!("  station NOT FOUND");
        return;
    };
    let deps = departures(tt, st as u32, date);
    for &(dep, t) in &deps {
        let trip = &tt.trips[t as usize];
        let line = tt.trip_line(t);
        println!("  {}  {} {} ({:?})  train {}  -> {}", hms(dep), line.category, line.name, line.mode, tt.str(trip.short_name), tt.str(trip.headsign));
    }
    let times: Vec<String> = deps.iter().map(|d| hms(d.0)[..5].to_string()).collect();
    let ok = times.len() == 12 && times[..3] == ["07:00", "08:24", "09:12"] && times[11] == "16:24";
    println!("  check: {} departures, expected 12 with 07:00, 08:24, 09:12 … 16:24: {}", times.len(), if ok { "OK" } else { "MISMATCH" });
}

fn frequency_example(tt: &Timetable, date: Date) {
    println!("\n== frequency-based services ==");
    // Group materialised trips by pattern and template id.
    let mut groups: BTreeMap<(u32, &str), Vec<TripIdx>> = BTreeMap::new();
    for (i, t) in tt.trips.iter().enumerate() {
        if t.flags & TRIP_FREQUENCY != 0 {
            let id = tt.str(t.gtfs_id);
            groups.entry((t.pattern, id.split('@').next().unwrap_or(id))).or_default().push(i as u32);
        }
    }
    let mut headways: BTreeMap<u16, usize> = BTreeMap::new();
    for t in tt.trips.iter().filter(|t| t.flags & TRIP_FREQUENCY != 0) {
        *headways.entry(t.headway_s).or_default() += 1;
    }
    println!("  {} templates; materialised trips by real headway: {:?}", groups.len(), headways);
    let mut shown = 0;
    for want in [Mode::Cableway, Mode::Funicular] {
        for ((p, id), trips) in &groups {
            let line = &tt.lines[tt.patterns[*p as usize].line as usize];
            if line.mode != want || !tt.trip_active(trips[0], date) || tt.trips[trips[0] as usize].headway_s != 60 {
                continue;
            }
            let stops = tt.pattern_stops(*p);
            let name = |s: StopIdx| tt.stations[tt.stops[s as usize].station as usize].name.as_str();
            let (first, last) = (trips[0], trips[trips.len() - 1]);
            let gaps: Vec<i32> = trips.windows(2).map(|w| tt.dep(w[1], 0) - tt.dep(w[0], 0)).collect();
            println!(
                "  {} {} {:?} ({}): {} -> {}, ride {} s; template {}",
                line.category,
                line.name,
                line.mode,
                tt.agencies[line.agency as usize].name,
                name(stops[0]),
                name(stops[stops.len() - 1]),
                tt.arr(first, stops.len() - 1) - tt.dep(first, 0),
                id
            );
            println!(
                "    window {} .. {}, real headway {} s, {} trips materialised, gaps {:?}..{:?} s, last gap {:?} s, runs on {}: yes",
                hms(tt.dep(first, 0)),
                hms(tt.dep(last, 0)),
                tt.trips[first as usize].headway_s,
                trips.len(),
                gaps.iter().min(),
                gaps.iter().max(),
                gaps.last(),
                time::fmt_date(date)
            );
            println!("    first ids: {}, {}", tt.trip_gtfs_id(first), tt.trip_gtfs_id(trips[1.min(trips.len() - 1)]));
            shown += 1;
            break;
        }
    }
    if shown == 0 {
        println!("  no 60 s cableway/funicular template runs on {}", time::fmt_date(date));
    }
}

fn ranking(tt: &Timetable) {
    println!("\n== station weights ==");
    let mut top: Vec<&Station> = tt.stations.iter().collect();
    top.sort_by_key(|s| std::cmp::Reverse(s.weight));
    println!("  top: {}", top.iter().take(12).map(|s| format!("{} {}", s.name, s.weight)).collect::<Vec<_>>().join(" | "));
    for prefix in ["Bern", "Zürich", "Basel", "Genève", "Luzern"] {
        let mut v: Vec<&Station> = tt.stations.iter().filter(|s| s.name.starts_with(prefix)).collect();
        v.sort_by_key(|s| std::cmp::Reverse(s.weight));
        println!("  {prefix}*: {}", v.iter().take(6).map(|s| format!("{} {}", s.name, s.weight)).collect::<Vec<_>>().join(" | "));
    }
    let zero = tt.stations.iter().filter(|s| s.weight == 0).count();
    println!("  stations with weight 0 (no boardable departure): {zero}");
}

/// `T` lines: trip id, route id, headsign, short name, sjyid, frequency flag,
/// headway, running dates. `S` lines: trip id, position, stop id, arrival,
/// departure, flags.
fn dump_sample(tt: &Timetable, n: usize, path: &Path) -> Result<()> {
    use std::io::Write;
    let mut w = std::io::BufWriter::new(std::fs::File::create(path)?);
    let step = (tt.trips.len() / n.max(1)).max(1);
    for t in (0..tt.trips.len()).step_by(step) {
        let (t, trip) = (t as u32, &tt.trips[t]);
        let dates: Vec<String> =
            (0..tt.n_days as Date).map(|d| tt.start_date + d).filter(|&d| tt.trip_active(t, d)).map(|d| time::fmt_date(d).replace('-', "")).collect();
        writeln!(
            w,
            "T\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
            tt.trip_gtfs_id(t),
            tt.trip_line(t).gtfs_route_id,
            tt.str(trip.headsign),
            tt.str(trip.short_name),
            tt.str(trip.sjyid),
            trip.flags,
            trip.headway_s,
            dates.join(",")
        )?;
        let (stops, flags) = (tt.pattern_stops(trip.pattern), tt.pattern_flags(trip.pattern));
        for i in 0..stops.len() {
            writeln!(w, "S\t{}\t{}\t{}\t{}\t{}\t{}", tt.trip_gtfs_id(t), i, tt.stops[stops[i] as usize].gtfs_id, tt.arr(t, i), tt.dep(t, i), flags[i])?;
        }
    }
    Ok(())
}
