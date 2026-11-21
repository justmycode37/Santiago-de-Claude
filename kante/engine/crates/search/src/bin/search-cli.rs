//! Developer tool for the geocoder.
//!
//! ```text
//! search-cli build   [--pbf P] [--tt P] [--out P] [--bbox minlat,minlon,maxlat,maxlon]
//! search-cli query   [--index P] [--near lat,lon] [--limit N] words…
//! search-cli repl    [--index P]          lines: `text`, `@lat,lon text`, `r lat,lon`, `id st:…`
//! search-cli samples [--index P]          the reference queries with timings
//! search-cli bench   [--index P] [--n N]  latency percentiles over random prefixes of real names
//! search-cli stats   [--index P]
//! ```
//! Paths default to `data/…` under the project root (found by walking up from
//! the current directory).

use anyhow::{bail, Context, Result};
use kante_core::{io, BBox, LatLon, Timetable, TIMETABLE_SCHEMA};
use kante_search::{Hit, SearchIndex, SEARCH_SCHEMA};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::Instant;

fn root() -> PathBuf {
    let mut d = std::env::current_dir().unwrap_or_default();
    loop {
        if d.join("data/raw").is_dir() {
            return d;
        }
        if !d.pop() {
            return PathBuf::from(".");
        }
    }
}

struct Args {
    flags: Vec<(String, String)>,
    rest: Vec<String>,
}

impl Args {
    fn parse(it: impl Iterator<Item = String>) -> Args {
        let mut a = Args { flags: Vec::new(), rest: Vec::new() };
        let mut it = it.peekable();
        while let Some(x) = it.next() {
            if let Some(name) = x.strip_prefix("--") {
                a.flags.push((name.to_string(), it.next().unwrap_or_default()));
            } else {
                a.rest.push(x);
            }
        }
        a
    }
    fn get(&self, name: &str) -> Option<&str> {
        self.flags.iter().find(|f| f.0 == name).map(|f| f.1.as_str())
    }
    fn path(&self, name: &str, default: &str) -> PathBuf {
        self.get(name).map(PathBuf::from).unwrap_or_else(|| root().join(default))
    }
}

fn latlon(s: &str) -> Result<LatLon> {
    let (a, b) = s.split_once(',').context("expected lat,lon")?;
    Ok(LatLon::from_deg(a.trim().parse()?, b.trim().parse()?))
}

/// (resident, peak) memory of this process in MB.
fn rss_mb() -> (f64, f64) {
    let s = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let get = |k: &str| s.lines().find(|l| l.starts_with(k)).and_then(|l| l.split_whitespace().nth(1)).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0) / 1024.0;
    (get("VmRSS:"), get("VmHWM:"))
}

fn load(a: &Args) -> Result<SearchIndex> {
    let p = a.path("index", "data/built/search.bin");
    let (before, _) = rss_mb();
    let t = Instant::now();
    let ix: SearchIndex = io::load(&p, SEARCH_SCHEMA)?;
    let (after, _) = rss_mb();
    eprintln!("loaded {} in {:.2}s, +{:.0} MB resident", p.display(), t.elapsed().as_secs_f32(), after - before);
    Ok(ix)
}

fn show(hits: &[Hit], near: Option<LatLon>) {
    for (i, h) in hits.iter().enumerate() {
        let dist = near.map(|n| format!("  {:.1} km", n.dist_m(&h.pos) / 1000.0)).unwrap_or_default();
        println!(
            "  {}. [{:7}] {}{}{}  ({:.5},{:.5})  score {:.1}{}  {}",
            i + 1,
            format!("{:?}", h.kind),
            h.name,
            if h.detail.is_empty() { "" } else { " — " },
            h.detail,
            h.pos.lat_deg(),
            h.pos.lon_deg(),
            h.score,
            dist,
            h.id
        );
    }
    if hits.is_empty() {
        println!("  (nothing)");
    }
}

fn timed_query(ix: &SearchIndex, q: &str, near: Option<LatLon>, limit: usize) -> (Vec<Hit>, f64) {
    let hits = ix.search(q, near, limit);
    // Best of a few runs: the first one pays for cold caches.
    let mut best = f64::MAX;
    for _ in 0..5 {
        let t = Instant::now();
        std::hint::black_box(ix.search(q, near, limit));
        best = best.min(t.elapsed().as_secs_f64() * 1e6);
    }
    (hits, best)
}

fn cmd_build(a: &Args) -> Result<()> {
    let tt_path = a.path("tt", "data/built/timetable.bin");
    let pbf = a.path("pbf", "data/raw/osm/switzerland-latest.osm.pbf");
    let out = a.path("out", "data/built/search.bin");
    let bbox = match a.get("bbox") {
        Some(s) => {
            let v: Vec<f64> = s.split(',').map(|x| x.trim().parse()).collect::<Result<_, _>>()?;
            if v.len() != 4 {
                bail!("--bbox minlat,minlon,maxlat,maxlon");
            }
            Some(BBox::from_deg(v[0], v[1], v[2], v[3]))
        }
        None => None,
    };
    let t = Instant::now();
    let tt: Timetable = if tt_path.exists() {
        let tt = io::load(&tt_path, TIMETABLE_SCHEMA)?;
        eprintln!("timetable {} loaded in {:.1}s", tt_path.display(), t.elapsed().as_secs_f32());
        tt
    } else {
        eprintln!("warning: {} not found — building without stations", tt_path.display());
        Timetable::default()
    };
    // Only the stations are needed; drop the rest before the big allocations.
    let tt = Timetable { feed_version: tt.feed_version, stations: tt.stations, ..Timetable::default() };
    let t = Instant::now();
    let ix = kante_search::build_logged(&tt, pbf.exists().then_some(pbf.as_path()), bbox, &mut |l| eprintln!("  {l}"))?;
    let build_s = t.elapsed().as_secs_f32();
    let (_, peak) = rss_mb();
    let t = Instant::now();
    io::save(&out, SEARCH_SCHEMA, &ix)?;
    let size = std::fs::metadata(&out)?.len();
    println!("index build {:.1}s (peak process memory {:.0} MB), saved {} ({:.1} MB) in {:.1}s", build_s, peak, out.display(), size as f64 / 1e6, t.elapsed().as_secs_f32());
    println!("{:#?}", ix.stats());
    Ok(())
}

const BERN: (f64, f64) = (46.9488, 7.4391);

fn cmd_samples(a: &Args) -> Result<()> {
    let ix = load(a)?;
    let bern = Some(LatLon::from_deg(BERN.0, BERN.1));
    let cases: &[(&str, Option<LatLon>)] = &[
        ("bern", None),
        ("bern bah", None),
        ("zurich", None),
        ("zürich hb", None),
        ("geneve aero", None),
        ("bundesgasse 3 bern", None),
        ("bundesplatz", None),
        ("bahnhofstrasse 10 zurich", None),
        ("zytglogge", None),
        ("inselspital", None),
        ("uni bern", None),
        ("wankdorf", None),
        ("jungfraujoch", None),
        ("luzern verkehrshaus", None),
        ("coop", bern),
        ("kornhausplatz 18", None),
        ("hirschengrabn", None),
        // beyond the brief
        ("migros", bern),
        ("bahnhof", bern),
        ("b", None),
        ("be", None),
        ("bahnhofstrasse 10 8001", None),
        ("3 rue du mont-blanc genève", None),
        ("bundesgasse 3", None),
        ("bundesgasse", None),
        ("bahnhof bern", None),
        ("zuerich hbf", None),
        ("genf", None),
        ("geneva airport", None),
        ("st gallen", None),
        ("sankt gallen", None),
        ("bahnhofstr 10 zurich", None),
        ("zurihc hb", None),
        ("matterhorn", None),
        ("gurten", None),
        ("3011", None),
    ];
    for (q, near) in cases {
        let (hits, us) = timed_query(&ix, q, *near, 5);
        println!("{q:?}{}  [{us:.0} µs]", if near.is_some() { " near Bern station" } else { "" });
        show(&hits, *near);
    }
    for (lat, lon) in [(46.94658, 7.44414), (46.9488, 7.4391), (46.9470, 7.4520), (46.5475, 7.9851), (47.3769, 8.5417)] {
        let p = LatLon::from_deg(lat, lon);
        let h = ix.reverse(p);
        let t = Instant::now();
        for _ in 0..1000 {
            std::hint::black_box(ix.reverse(p));
        }
        let us = t.elapsed().as_secs_f64() * 1e3;
        match h {
            Some(h) => println!("reverse({lat},{lon}) → {} — {}  ({:.0} m, {})  [{us:.1} µs]", h.name, h.detail, h.score, h.id),
            None => println!("reverse({lat},{lon}) → nothing  [{us:.1} µs]"),
        }
    }
    Ok(())
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

fn percentiles(label: &str, mut v: Vec<f64>) {
    if v.is_empty() {
        return;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    let p = |q: f64| v[((v.len() - 1) as f64 * q) as usize];
    println!(
        "{label:42} n={:5}  median {:7.1} µs  p90 {:7.1}  p99 {:7.1}  max {:8.1}  mean {:7.1}",
        v.len(),
        p(0.5),
        p(0.9),
        p(0.99),
        v[v.len() - 1],
        v.iter().sum::<f64>() / v.len() as f64
    );
}

fn cmd_bench(a: &Args) -> Result<()> {
    let ix = load(a)?;
    let n: usize = a.get("n").map(|s| s.parse()).transpose()?.unwrap_or(5000);
    let st = ix.stats();
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let run = |q: &str, near: Option<LatLon>| -> f64 {
        let t = Instant::now();
        std::hint::black_box(ix.search(q, near, 10));
        t.elapsed().as_secs_f64() * 1e6
    };
    let prefix = |s: &str, chars: usize| -> String { s.chars().take(chars).collect() };
    // Half the samples from the most prominent 5 % (what people actually type), half from everything.
    let pick_name = |rng: &mut Rng| -> String {
        let d = if rng.below(2) == 0 { rng.below(ix.doc_count() / 20 + 1) } else { rng.below(ix.doc_count()) };
        ix.doc_name(d).to_string()
    };
    let pick_pos = |rng: &mut Rng| -> LatLon {
        loop {
            let d = rng.below(ix.doc_count() / 10 + 1);
            if let Some(h) = ix.search(ix.doc_name(d), None, 1).into_iter().next() {
                return h.pos;
            }
        }
    };

    let (mut all, mut all_near, mut one, mut two, mut one_near, mut two_near, mut full, mut typo, mut addr, mut addr_typing) = (vec![], vec![], vec![], vec![], vec![], vec![], vec![], vec![], vec![], vec![]);
    for _ in 0..n {
        let name = pick_name(&mut rng);
        let len = name.chars().count();
        if len == 0 {
            continue;
        }
        let q = prefix(&name, 1 + rng.below(len));
        all.push(run(&q, None));
        let near = pick_pos(&mut rng);
        all_near.push(run(&q, Some(near)));
        full.push(run(&name, None));
        one.push(run(&prefix(&name, 1), None));
        two.push(run(&prefix(&name, 2), None));
        one_near.push(run(&prefix(&name, 1), Some(near)));
        two_near.push(run(&prefix(&name, 2), Some(near)));
        // One wrong letter somewhere in the name.
        let mut chars: Vec<char> = name.chars().collect();
        let i = rng.below(chars.len());
        chars[i] = 'x';
        typo.push(run(&chars.into_iter().collect::<String>(), None));
        if st.houses > 0 {
            if let Some(h) = ix.resolve(&format!("addr:{}", 2 * rng.below(st.houses))) {
                let q = format!("{} {}", h.name, h.detail);
                addr.push(run(&q, None));
                let len = h.name.chars().count();
                addr_typing.push(run(&prefix(&h.name, 1 + rng.below(len)), None));
            }
        }
    }
    println!("search latency, single thread, limit 10:");
    percentiles("random prefix of a real name", all);
    percentiles("random prefix + position", all_near);
    percentiles("1-letter prefix", one);
    percentiles("2-letter prefix", two);
    percentiles("1-letter prefix + position", one_near);
    percentiles("2-letter prefix + position", two_near);
    percentiles("whole name", full);
    percentiles("name with one wrong letter", typo);
    percentiles("full address (street no, postcode town)", addr);
    percentiles("address while typing", addr_typing);

    let mut rev = vec![];
    let mut found = 0;
    for _ in 0..n * 4 {
        let base = if st.houses > 0 && rng.below(4) != 0 { ix.resolve(&format!("addr:{}", 2 * rng.below(st.houses))).map(|h| h.pos) } else { Some(pick_pos(&mut rng)) };
        let Some(b) = base else { continue };
        let p = LatLon { lat: b.lat + rng.below(6000) as i32 - 3000, lon: b.lon + rng.below(9000) as i32 - 4500 };
        let t = Instant::now();
        let r = std::hint::black_box(ix.reverse(p));
        rev.push(t.elapsed().as_secs_f64() * 1e6);
        found += r.is_some() as usize;
    }
    println!("reverse geocoding ({} of {} answered):", found, rev.len());
    percentiles("reverse", rev);
    let (rss, peak) = rss_mb();
    println!("process memory: {rss:.0} MB resident, {peak:.0} MB peak; index heap {:.0} MB", st.heap_bytes as f64 / 1e6);
    Ok(())
}

fn cmd_repl(a: &Args) -> Result<()> {
    let ix = load(a)?;
    let stdin = std::io::stdin();
    eprint!("> ");
    std::io::stderr().flush().ok();
    for line in stdin.lock().lines() {
        let line = line?;
        let line = line.trim();
        if let Some(r) = line.strip_prefix("r ") {
            match latlon(r) {
                Ok(p) => {
                    let t = Instant::now();
                    let h = ix.reverse(p);
                    println!("  [{:.1} µs]", t.elapsed().as_secs_f64() * 1e6);
                    show(&h.into_iter().collect::<Vec<_>>(), Some(p));
                }
                Err(e) => println!("  {e}"),
            }
        } else if let Some(id) = line.strip_prefix("id ") {
            show(&ix.resolve(id.trim()).into_iter().collect::<Vec<_>>(), None);
        } else if !line.is_empty() {
            let (near, q) = match line.strip_prefix('@').and_then(|r| r.split_once(' ')) {
                Some((pos, q)) => (latlon(pos).ok(), q),
                None => (None, line),
            };
            let (hits, us) = timed_query(&ix, q, near, 8);
            println!("  [{us:.0} µs]");
            show(&hits, near);
        }
        eprint!("> ");
        std::io::stderr().flush().ok();
    }
    Ok(())
}

fn main() -> Result<()> {
    let mut argv = std::env::args().skip(1);
    let cmd = argv.next().unwrap_or_default();
    let a = Args::parse(argv);
    match cmd.as_str() {
        "build" => cmd_build(&a),
        "query" => {
            let ix = load(&a)?;
            let near = a.get("near").map(latlon).transpose()?;
            let limit = a.get("limit").map(|s| s.parse()).transpose()?.unwrap_or(8);
            let q = a.rest.join(" ");
            let (hits, us) = timed_query(&ix, &q, near, limit);
            println!("{q:?}  [{us:.0} µs]");
            show(&hits, near);
            Ok(())
        }
        "repl" => cmd_repl(&a),
        "samples" => cmd_samples(&a),
        "bench" => cmd_bench(&a),
        "stats" => {
            let ix = load(&a)?;
            println!("{:#?}", ix.stats());
            println!("timetable feed {:?}, {} stations", ix.feed_version(), ix.station_count());
            Ok(())
        }
        _ => {
            eprintln!("usage: search-cli build|query|repl|samples|bench|stats  (see the top of src/bin/search-cli.rs)");
            Ok(())
        }
    }
}
