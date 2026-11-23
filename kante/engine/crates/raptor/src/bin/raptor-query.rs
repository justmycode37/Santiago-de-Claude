//! Developer tool for kante-raptor on the built national timetable.
//!
//! ```text
//! raptor-query [--tt FILE] [--links FILE] COMMAND …
//!   plan FROM TO DATE TIME [WINDOW_MIN] [--speed M/S] [--margin S] [--transfers N] [--modes rail,bus,…] [--near N] [--live 1]
//!   onboard BOARDED_AT NEXT_STOP DEST DATE TIME [CATEGORY]
//!   departures STATION DATE TIME [N]
//!   vehicles LAT LON RADIUS_M DATE TIME
//!   bench [PAIRS]
//!   bounds-check [PAIRS]            same journeys with and without target bounds (static and live)
//!   stats
//!   (any command) --no-bounds 1   plan without per-stop target bounds (for comparison)
//!   continuations DATE [SAMPLES]      check in-seat continuations of the feed end to end
//! ```
//! Stations are looked up by exact `Station::name`; DATE is `YYYY-MM-DD`,
//! TIME is `HH:MM` (hours ≥ 24 allowed).

use anyhow::{anyhow, bail, Context, Result};
use kante_core::geo::BBox;
use kante_core::time::{self, Date, Secs};
use kante_core::*;
use kante_raptor::{crowfly_footpaths, Journey, Leg, Onboard, Query, Router};
use rustc_hash::FxHashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

fn hhmm(s: Secs) -> String {
    let day = s.div_euclid(86_400);
    let r = s.rem_euclid(86_400);
    let base = format!("{:02}:{:02}", r / 3600, r % 3600 / 60);
    let base = if r % 60 != 0 { format!("{base}:{:02}", r % 60) } else { base };
    match day {
        0 => base,
        d => format!("{base}{d:+}d"),
    }
}

fn dur(s: Secs) -> String {
    format!("{}:{:02}", s / 3600, s % 3600 / 60)
}

fn parse_time(s: &str) -> Result<Secs> {
    let full = if s.matches(':').count() == 1 { format!("{s}:00") } else { s.to_string() };
    time::parse_hms(&full).ok_or_else(|| anyhow!("bad time {s:?}"))
}

struct Ctx {
    rt: Router,
    fp: Footpaths,
}

impl Ctx {
    fn tt(&self) -> &Timetable {
        self.rt.timetable()
    }

    fn station(&self, name: &str) -> Result<StationIdx> {
        let tt = self.tt();
        let best = tt.stations.iter().enumerate().filter(|(_, s)| s.name == name).max_by_key(|(_, s)| s.weight);
        if let Some((i, _)) = best {
            return Ok(i as StationIdx);
        }
        let lower = name.to_lowercase();
        let mut near: Vec<_> = tt.stations.iter().filter(|s| s.name.to_lowercase().contains(&lower)).collect();
        near.sort_by_key(|s| std::cmp::Reverse(s.weight));
        let names: Vec<_> = near.iter().take(8).map(|s| s.name.as_str()).collect();
        bail!("no station named {name:?}; similar: {names:?}")
    }

    fn stop_name(&self, s: StopIdx) -> String {
        let st = &self.tt().stops[s as usize];
        let name = &self.tt().stations[st.station as usize].name;
        match (st.label.is_empty(), st.sectors.is_empty()) {
            (true, _) => name.clone(),
            (false, true) => format!("{name} [{}]", st.label),
            (false, false) => format!("{name} [{} {}]", st.label, st.sectors),
        }
    }

    fn trip_name(&self, t: TripIdx) -> String {
        let tt = self.tt();
        let line = tt.trip_line(t);
        let tr = &tt.trips[t as usize];
        let nr = tt.str(tr.short_name);
        let cat = if line.category.is_empty() || line.name.starts_with(&line.category) { String::new() } else { format!("{} ", line.category) };
        format!("{cat}{}{} → {}", line.name, if nr.is_empty() { String::new() } else { format!(" ({nr})") }, tt.str(tr.headsign))
    }

    /// All stops of a station at 0 s, or with `near > 0` the `near` closest
    /// stops around the station with a crow-fly walking time (door-to-door-like).
    fn ends(&self, station: StationIdx, near: usize) -> Vec<(StopIdx, Secs)> {
        let tt = self.tt();
        let st = &tt.stations[station as usize];
        if near == 0 {
            return st.stops.iter().map(|&s| (s, 0)).collect();
        }
        let b = BBox::around(st.pos, 1500.0);
        let mut v: Vec<(f32, StopIdx)> = tt.stops.iter().enumerate().filter(|(_, s)| b.contains(&s.pos)).map(|(i, s)| (s.pos.dist_m(&st.pos), i as StopIdx)).collect();
        v.sort_by(|a, b| a.0.total_cmp(&b.0));
        v.truncate(near);
        v.into_iter().map(|(d, s)| (s, (d * 1.35 / 1.3) as Secs + 30)).collect()
    }

    fn print_journey(&self, j: &Journey, qdate: Date) {
        let tt = self.tt();
        println!("{} → {}   {}   {} change{}", hhmm(j.dep), hhmm(j.arr), dur(j.arr - j.dep), j.transfers, if j.transfers == 1 { "" } else { "s" });
        for leg in &j.legs {
            match *leg {
                Leg::Access { to, dep, arr } => {
                    if arr > dep {
                        println!("    {}  walk {} s to {}", hhmm(dep), arr - dep, self.stop_name(to));
                    }
                }
                Leg::Ride { trip, date, from_pos, to_pos, dep, arr, stay_seated, onboard } => {
                    let stops = tt.pattern_stops(tt.trips[trip as usize].pattern);
                    let tag = if onboard {
                        "  (on board)"
                    } else if stay_seated {
                        "  (stay seated)"
                    } else {
                        ""
                    };
                    let day = if date == qdate { String::new() } else { format!("  [service day {}]", time::fmt_date(date)) };
                    println!("    {}  {:<34} {}{tag}{day}", hhmm(dep), self.stop_name(stops[from_pos as usize]), self.trip_name(trip));
                    println!("    {}  {:<34} ({} stops)", hhmm(arr), self.stop_name(stops[to_pos as usize]), to_pos - from_pos);
                }
                Leg::Transfer { from, to, dep, arr, var_m, .. } => {
                    if from == to {
                        println!("           change at the same point");
                    } else {
                        println!("    {}  walk {} s ({} m) to {}", hhmm(dep), arr - dep, var_m, self.stop_name(to));
                    }
                }
                Leg::Egress { arr, dep, .. } => {
                    if arr > dep {
                        println!("    {}  walk {} s to the destination", hhmm(dep), arr - dep);
                    }
                }
            }
        }
        println!();
    }
}

fn parse_modes(s: &str) -> Result<u16> {
    let mut m = 0;
    for part in s.split(',') {
        m |= Mode::ALL.iter().find(|x| x.as_str() == part).ok_or_else(|| anyhow!("unknown mode {part:?}"))?.bit();
    }
    Ok(m)
}

/// Positional arguments and `--key value` options.
struct Args {
    pos: Vec<String>,
    opt: FxHashMap<String, String>,
}

impl Args {
    fn parse() -> Self {
        let mut pos = Vec::new();
        let mut opt = FxHashMap::default();
        let mut it = std::env::args().skip(1);
        while let Some(a) = it.next() {
            match a.strip_prefix("--") {
                Some(k) => {
                    opt.insert(k.to_string(), it.next().unwrap_or_default());
                }
                None => pos.push(a),
            }
        }
        Args { pos, opt }
    }
    fn get<T: std::str::FromStr>(&self, key: &str, default: T) -> T {
        self.opt.get(key).and_then(|v| v.parse().ok()).unwrap_or(default)
    }
    fn at(&self, i: usize) -> Result<&str> {
        self.pos.get(i).map(String::as_str).ok_or_else(|| anyhow!("missing argument {i}; see the header of raptor-query.rs"))
    }
}

fn main() -> Result<()> {
    let args = Args::parse();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../data/built");
    let tt_path = args.opt.get("tt").map(PathBuf::from).unwrap_or_else(|| root.join("timetable.bin"));
    let t0 = Instant::now();
    let tt: Timetable = io::load(&tt_path, TIMETABLE_SCHEMA)?;
    let tt = Arc::new(tt);
    let t_load = t0.elapsed();
    let t0 = Instant::now();
    let rt = Router::new(tt.clone());
    let t_new = t0.elapsed();
    let t0 = Instant::now();
    let links = args.opt.get("links").map(PathBuf::from).unwrap_or_else(|| root.join("links.bin"));
    let (fp, fp_src) = match io::load::<LinkData>(&links, LINKS_SCHEMA) {
        Ok(l) if l.normal.off.len() == tt.stops.len() + 1 => (l.normal, "links.bin"),
        _ => (crowfly_footpaths(&tt, 400.0, 1.35), "crow-fly 400 m × 1.35"),
    };
    eprintln!(
        "timetable {}: {} stops, {} patterns, {} trips, {} → {} | load {:.1?}, Router::new {:.1?}, footpaths ({fp_src}, {}) {:.1?}",
        tt.feed_version,
        tt.stops.len(),
        tt.patterns.len(),
        tt.trips.len(),
        time::fmt_date(tt.start_date),
        time::fmt_date(tt.end_date()),
        t_load,
        t_new,
        fp.len(),
        t0.elapsed()
    );
    if args.opt.contains_key("no-bounds") {
        rt.set_target_bounds(false);
    }
    let cx = Ctx { rt, fp };
    match args.at(0)? {
        "plan" => cmd_plan(&cx, &args),
        "onboard" => cmd_onboard(&cx, &args),
        "departures" => cmd_departures(&cx, &args),
        "vehicles" => cmd_vehicles(&cx, &args),
        "bench" => bench::run(&cx, args.pos.get(1).and_then(|s| s.parse().ok()).unwrap_or(300)),
        "bounds-check" => bench::bounds_check(&cx, args.pos.get(1).and_then(|s| s.parse().ok()).unwrap_or(300)),
        "stats" => cmd_stats(&cx),
        "continuations" => cmd_continuations(&cx, &args),
        other => bail!("unknown command {other:?}"),
    }
}

fn base_query<'a>(cx: &'a Ctx, args: &Args, date: Date, from: Secs, acc: &'a [(StopIdx, Secs)], egr: &'a [(StopIdx, Secs)]) -> Result<Query<'a>> {
    let mut q = Query::new(date, from, acc, egr, &cx.fp);
    q.walk_speed = args.get("speed", q.walk_speed);
    q.transfer_margin = args.get("margin", q.transfer_margin);
    q.max_transfers = args.get("transfers", q.max_transfers);
    q.max_walk = args.get("max-walk", q.max_walk);
    if let Some(m) = args.opt.get("modes") {
        q.modes = parse_modes(m)?;
    }
    Ok(q)
}

fn cmd_plan(cx: &Ctx, args: &Args) -> Result<()> {
    let (from, to) = (cx.station(args.at(1)?)?, cx.station(args.at(2)?)?);
    let date = time::parse_date(args.at(3)?).context("bad date")?;
    let t = parse_time(args.at(4)?)?;
    let near = args.get("near", 0usize);
    let (acc, egr) = (cx.ends(from, near), cx.ends(to, near));
    let mut q = base_query(cx, args, date, t, &acc, &egr)?;
    q.window = args.pos.get(5).map(|w| w.parse::<Secs>()).transpose()?.unwrap_or(0) * 60;
    // `--live 1`: the synthetic overlay of `bench` (its delays are drawn for 2026-11-23).
    let fake = args.opt.contains_key("live").then(|| bench::fake_live(cx.tt(), time::parse_date("2026-11-23").unwrap(), &mut bench::Rng(0x9E3779B97F4A7C15)).0);
    q.live = fake.as_ref().map(|l| l as &dyn LiveView);
    let t0 = Instant::now();
    let js = cx.rt.plan(&q);
    let first = t0.elapsed();
    #[cfg(feature = "stats")]
    eprintln!("counters: {:?}", kante_raptor::stats::take());
    // Warm timing: the machine is shared, so report the fastest and the median run.
    let mut runs: Vec<_> = (0..25)
        .map(|_| {
            let t0 = Instant::now();
            std::hint::black_box(cx.rt.plan(&q));
            t0.elapsed()
        })
        .collect();
    runs.sort();
    let (best, warm) = (runs[0], runs[runs.len() / 2]);
    #[cfg(feature = "stats")]
    eprintln!("counters over 25 runs: {:?}", kante_raptor::stats::take());
    println!(
        "{} → {}   {} {}  window {} min   {} access / {} egress stops",
        args.at(1)?,
        args.at(2)?,
        time::fmt_date(date),
        hhmm(t),
        q.window / 60,
        acc.len(),
        egr.len()
    );
    println!("{} journeys   first call {:.2?} (includes building the day index), then median {:.2?}, best {:.2?}\n", js.len(), first, warm, best);
    for j in &js {
        cx.print_journey(j, date);
    }
    Ok(())
}

fn cmd_onboard(cx: &Ctx, args: &Args) -> Result<()> {
    let tt = cx.tt();
    let (at, next, dest) = (cx.station(args.at(1)?)?, cx.station(args.at(2)?)?, cx.station(args.at(3)?)?);
    let date = time::parse_date(args.at(4)?).context("bad date")?;
    let t = parse_time(args.at(5)?)?;
    let cat = args.pos.get(6);
    // The first trip leaving `at` after `t` whose following call is at `next`.
    let evs = cx.rt.departures(&tt.stations[at as usize].stops, date, t, 400, None);
    let found = evs.iter().find_map(|e| {
        let stops = tt.pattern_stops(tt.trips[e.trip as usize].pattern);
        let np = (e.pos as usize + 1..stops.len()).find(|&i| tt.stops[stops[i] as usize].station == next)?;
        (cat.is_none_or(|c| &tt.trip_line(e.trip).category == c)).then_some((*e, np))
    });
    let (ev, next_pos) = found.ok_or_else(|| anyhow!("no trip from {} towards {}", args.at(1).unwrap(), args.at(2).unwrap()))?;
    let shift = (ev.date - date) * time::DAY;
    let arr_next = tt.arr(ev.trip, next_pos) + shift;
    let now = (ev.dep + arr_next) / 2;
    println!(
        "on board {} (left {} {}, next stop {} at {}), now {} → {}",
        cx.trip_name(ev.trip),
        cx.stop_name(ev.stop),
        hhmm(ev.dep),
        args.at(2)?,
        hhmm(arr_next),
        hhmm(now),
        args.at(3)?
    );
    let egr = cx.ends(dest, 0);
    let mut q = base_query(cx, args, date, now, &[], &egr)?;
    q.onboard = Some(Onboard { trip: ev.trip, date: ev.date, next_pos: next_pos as u16 });
    let t0 = Instant::now();
    let js = cx.rt.plan(&q);
    println!("{} journeys in {:.2?}\n", js.len(), t0.elapsed());
    for j in &js {
        cx.print_journey(j, date);
    }
    Ok(())
}

fn cmd_departures(cx: &Ctx, args: &Args) -> Result<()> {
    let tt = cx.tt();
    let st = cx.station(args.at(1)?)?;
    let date = time::parse_date(args.at(2)?).context("bad date")?;
    let t = parse_time(args.at(3)?)?;
    let n = args.pos.get(4).and_then(|s| s.parse().ok()).unwrap_or(15);
    let stops = &tt.stations[st as usize].stops;
    cx.rt.departures(stops, date, t, n, None);
    let t0 = Instant::now();
    let reps = 200;
    for _ in 0..reps {
        std::hint::black_box(cx.rt.departures(stops, date, t, n, None));
    }
    let per = t0.elapsed() / reps;
    let evs = cx.rt.departures(stops, date, t, n, None);
    println!("{} — {} stops, {} departures from {} in {:.1?} per call", args.at(1)?, stops.len(), evs.len(), hhmm(t), per);
    for e in &evs {
        let label = &tt.stops[e.stop as usize].label;
        println!("  {}  {:<6} {}", hhmm(e.dep), label, cx.trip_name(e.trip));
    }
    Ok(())
}

fn cmd_vehicles(cx: &Ctx, args: &Args) -> Result<()> {
    let tt = cx.tt();
    let c = LatLon::from_deg(args.at(1)?.parse()?, args.at(2)?.parse()?);
    let bbox = BBox::around(c, args.at(3)?.parse()?);
    let date = time::parse_date(args.at(4)?).context("bad date")?;
    let t = parse_time(args.at(5)?)?;
    let t0 = Instant::now();
    let v = cx.rt.vehicles(&bbox, date, t, None);
    let first = t0.elapsed();
    let t0 = Instant::now();
    for _ in 0..100 {
        std::hint::black_box(cx.rt.vehicles(&bbox, date, t, None));
    }
    println!("{} vehicles; first call {:.2?}, then {:.1?} per call", v.len(), first, t0.elapsed() / 100);
    let mut by_mode: FxHashMap<&str, usize> = FxHashMap::default();
    for s in &v {
        *by_mode.entry(tt.trip_line(s.trip).mode.as_str()).or_default() += 1;
    }
    println!("by mode: {by_mode:?}");
    for s in v.iter().take(args.get("show", 12)) {
        let stops = tt.pattern_stops(tt.trips[s.trip as usize].pattern);
        let a = cx.stop_name(stops[s.pos as usize]);
        if s.dwell {
            println!("  {:<40} at {a} until {}", cx.trip_name(s.trip), hhmm(s.dep));
        } else {
            println!("  {:<40} {a} {} → {} {}", cx.trip_name(s.trip), hhmm(s.dep), cx.stop_name(stops[s.pos as usize + 1]), hhmm(s.arr));
        }
    }
    Ok(())
}

/// For a sample of the feed's in-seat continuations A → B running on DATE:
/// plan from the stop before A's last to B's second stop with no transfer
/// allowed, leaving just before A does. The answer must stay seated (or be an
/// equally fast direct trip).
fn cmd_continuations(cx: &Ctx, args: &Args) -> Result<()> {
    let tt = cx.tt();
    let date = time::parse_date(args.at(1)?).context("bad date")?;
    let samples: usize = args.pos.get(2).and_then(|s| s.parse().ok()).unwrap_or(2000);
    let active: Vec<_> = tt
        .continuations
        .iter()
        .filter(|c| tt.trip_active(c.from, date) && tt.trip_active(c.to, date) && (c.service == NONE || tt.service_active(c.service, date)))
        .collect();
    println!("{} continuations in the feed, {} with both trips running on {}", tt.continuations.len(), active.len(), time::fmt_date(date));
    let step = (active.len() / samples).max(1);
    let (mut tried, mut seated, mut as_good, mut worse, mut none, mut unusable) = (0, 0, 0, 0, 0, 0);
    let mut shown = 0;
    for c in active.iter().step_by(step) {
        let (pa, pb) = (tt.trips[c.from as usize].pattern, tt.trips[c.to as usize].pattern);
        let (sa, sb) = (tt.pattern_stops(pa), tt.pattern_stops(pb));
        let (fa, fb) = (tt.pattern_flags(pa), tt.pattern_flags(pb));
        let i = sa.len() - 2;
        let gap = tt.dep(c.to, 0) - tt.arr(c.from, sa.len() - 1);
        // Needs a boardable stop on A, an alighting stop on B, and B leaving after A arrives.
        if sb.len() < 2 || fa[i] & FLAG_NO_PICKUP != 0 || fb[1] & FLAG_NO_DROPOFF != 0 || !(0..=3 * 3600).contains(&gap) || sa[i] == sb[1] {
            unusable += 1;
            continue;
        }
        tried += 1;
        let (acc, egr) = ([(sa[i], 0)], [(sb[1], 0)]);
        let mut q = Query::new(date, tt.dep(c.from, i), &acc, &egr, &cx.fp);
        q.max_transfers = 0;
        let js = cx.rt.plan(&q);
        let want = tt.arr(c.to, 1);
        match js.first() {
            None => none += 1,
            Some(j) if j.legs.iter().any(|l| matches!(l, Leg::Ride { stay_seated: true, .. })) && j.arr <= want => {
                seated += 1;
                if shown < 2 {
                    shown += 1;
                    cx.print_journey(j, date);
                }
            }
            Some(j) if j.arr <= want => as_good += 1,
            Some(_) => worse += 1,
        }
    }
    println!("{tried} sampled ({unusable} skipped: no pickup/drop-off there, or the second trip leaves before the first arrives)");
    println!("  stay-seated journey found: {seated}\n  another direct trip at least as fast: {as_good}\n  only a slower journey: {worse}\n  no journey: {none}");
    Ok(())
}

fn cmd_stats(cx: &Ctx) -> Result<()> {
    let tt = cx.tt();
    println!("stations {}  stops {}  lines {}  patterns {}  trips {}  stop times {}", tt.stations.len(), tt.stops.len(), tt.lines.len(), tt.patterns.len(), tt.trips.len(), tt.times.len() / 2);
    println!("continuations {}  official transfers {}  footpaths {}", tt.continuations.len(), tt.official_transfers.len(), cx.fp.len());
    println!("target-bound graph {:.1} MB", cx.rt.target_bounds_bytes() as f64 / 1e6);
    // Footpath coverage: can one change between the stops of a station at all?
    let with_fp = (0..tt.stops.len()).filter(|&s| cx.fp.off[s] != cx.fp.off[s + 1]).count();
    let (mut pairs, mut missing, mut stations_missing) = (0u64, 0u64, 0);
    let mut example = None;
    for st in &tt.stations {
        let mut miss = 0;
        for &a in &st.stops {
            for &b in &st.stops {
                if a != b {
                    pairs += 1;
                    miss += cx.fp.get(a, b).is_none() as u64;
                }
            }
        }
        if miss > 0 {
            stations_missing += 1;
            if example.is_none_or(|(w, _)| st.weight > w) {
                example = Some((st.weight, st.name.as_str()));
            }
        }
        missing += miss;
    }
    println!(
        "footpaths: {} of {} stops have any; {} of {} same-station stop pairs have none ({} stations affected, busiest: {:?})",
        with_fp,
        tt.stops.len(),
        missing,
        pairs,
        stations_missing,
        example.map(|e| e.1)
    );
    let sp = tt.stop_patterns.len() as f64 / tt.stops.len() as f64;
    let max_sp = (0..tt.stops.len() as StopIdx).map(|s| tt.stop_patterns(s).len()).max().unwrap_or(0);
    println!("patterns per stop: mean {sp:.1}, max {max_sp}");
    let date = time::parse_date("2026-11-23").unwrap();
    let t0 = Instant::now();
    let day = tt.day_index(date);
    let active = (0..tt.patterns.len()).filter(|&p| day.pat_off[p] != day.pat_off[p + 1]).count();
    println!("2026-11-23: {} trips on {} patterns; day_index {:.1?}", day.trips.len(), active, t0.elapsed());
    // Cost of the per-date data on dates not seen before (each needs three days, two of them new after the first).
    for (i, d) in ["2026-11-23", "2026-11-25", "2026-11-27", "2026-11-29"].iter().enumerate() {
        let date = time::parse_date(d).unwrap();
        let q = Query::new(date, 8 * 3600, &[(0, 0)], &[(1, 0)], &cx.fp);
        let t0 = Instant::now();
        cx.rt.plan(&q);
        println!("first plan() on {d}: {:.1?}{}", t0.elapsed(), if i == 0 { " (three new days, thread pool start, scratch allocation)" } else { " (two or three new days)" });
    }
    let t0 = Instant::now();
    cx.rt.warm_up(time::parse_date("2026-12-01").unwrap());
    println!("warm_up(2026-12-01): {:.1?}", t0.elapsed());
    let t0 = Instant::now();
    let found = cx.rt.find_trip(tt.trip_gtfs_id(tt.trips.len() as TripIdx / 2));
    println!("id maps built in {:.1?}; find_trip ok: {}", t0.elapsed(), found == Some(tt.trips.len() as TripIdx / 2));
    let t0 = Instant::now();
    let mut n = 0;
    for t in (0..tt.trips.len() as TripIdx).step_by(97) {
        n += (cx.rt.find_trip(tt.trip_gtfs_id(t)) == Some(t)) as usize;
        let sj = tt.str(tt.trips[t as usize].sjyid);
        assert!(sj.is_empty() || cx.rt.find_sjyid(sj).contains(&t));
    }
    let k = tt.trips.len().div_ceil(97);
    println!("find_trip + find_sjyid: {n}/{k} round-trips ok, {:.0?} per pair", t0.elapsed() / k as u32);
    Ok(())
}

mod bench {
    use super::*;

    pub(crate) struct Rng(pub u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    /// Random delays on a share of all trips of one date.
    pub(crate) struct FakeLive {
        pub date: Date,
        pub trips: Vec<Option<TripLive>>,
        pub max: Secs,
        pub derived: DerivedSlot,
    }
    impl LiveView for FakeLive {
        fn trip(&self, date: Date, trip: TripIdx) -> Option<&TripLive> {
            if date != self.date {
                return None;
            }
            self.trips[trip as usize].as_ref()
        }
        fn max_delay(&self) -> Secs {
            self.max
        }
        fn for_each_trip(&self, f: &mut dyn FnMut(Date, TripIdx, &TripLive)) -> bool {
            for (t, l) in self.trips.iter().enumerate() {
                if let Some(l) = l {
                    f(self.date, t as TripIdx, l);
                }
            }
            true
        }
        fn derived(&self) -> Option<&DerivedSlot> {
            Some(&self.derived)
        }
    }

    /// Live overlay: 30 % of the date's trips late by 1–10 min, 1 % cancelled;
    /// as on the real feed, one train almost 3 h late dictates `max_delay`
    /// (returned as the outlier).
    pub(crate) fn fake_live(tt: &Timetable, date: Date, rng: &mut Rng) -> (FakeLive, Option<usize>) {
        let mut trips: Vec<Option<TripLive>> = vec![None; tt.trips.len()];
        for t in 0..tt.trips.len() as TripIdx {
            if !tt.trip_active(t, date) {
                continue;
            }
            let r = rng.below(100);
            if r < 31 {
                let n = tt.pattern_stops(tt.trips[t as usize].pattern).len();
                let d = if r < 28 { 60 + rng.below(540) as i32 } else { 600 + rng.below(300) as i32 };
                trips[t as usize] = Some(TripLive { cancelled: r == 30, arr_delay: vec![d; n], dep_delay: vec![d; n], observed_pos: -1, ..Default::default() });
            }
        }
        let outlier = (0..tt.trips.len()).find(|&t| trips[t].as_ref().is_some_and(|l| !l.cancelled) && tt.trip_line(t as TripIdx).mode == Mode::Rail);
        let mut max = 900;
        if let Some(t) = outlier {
            let l = trips[t].as_mut().unwrap();
            l.arr_delay.fill(10_478);
            l.dep_delay.fill(10_478);
            max = 10_478;
        }
        (FakeLive { date, trips, max, derived: DerivedSlot::default() }, outlier)
    }

    /// Every fourth trip of a `FakeLive` (and its outlier): about the share
    /// of trips the real feed covers.
    struct Sparse<'a>(&'a FakeLive, usize, DerivedSlot);
    impl LiveView for Sparse<'_> {
        fn trip(&self, date: Date, trip: TripIdx) -> Option<&TripLive> {
            if trip % 4 == 0 || trip as usize == self.1 {
                self.0.trip(date, trip)
            } else {
                None
            }
        }
        fn max_delay(&self) -> Secs {
            self.0.max
        }
        fn for_each_trip(&self, f: &mut dyn FnMut(Date, TripIdx, &TripLive)) -> bool {
            self.0.for_each_trip(&mut |d, t, l| {
                if t % 4 == 0 || t as usize == self.1 {
                    f(d, t, l)
                }
            })
        }
        fn derived(&self) -> Option<&DerivedSlot> {
            Some(&self.2)
        }
    }

    /// Live data with per-date, per-pattern and per-stop delay
    /// bounds; `FakeLive` alone has the `LiveView` defaults (look back by
    /// `max_delay` everywhere).
    struct Indexed<'a>(&'a dyn LiveView, DelayIndex);
    impl Indexed<'_> {
        fn new<'a>(tt: &Timetable, date: Date, live: &'a dyn LiveView) -> Indexed<'a> {
            Indexed(live, DelayIndex::build(Some(tt), (0..tt.trips.len() as TripIdx).filter_map(|t| live.trip(date, t).map(|l| (date, t, l)))))
        }
    }
    impl LiveView for Indexed<'_> {
        fn trip(&self, date: Date, trip: TripIdx) -> Option<&TripLive> {
            self.0.trip(date, trip)
        }
        fn max_delay(&self) -> Secs {
            self.0.max_delay()
        }
        fn delay_bounds(&self, date: Date) -> DelayBounds<'_> {
            self.1.get(date)
        }
        fn for_each_trip(&self, f: &mut dyn FnMut(Date, TripIdx, &TripLive)) -> bool {
            self.0.for_each_trip(f)
        }
        // Same trips as the view it wraps.
        fn derived(&self) -> Option<&DerivedSlot> {
            self.0.derived()
        }
    }

    fn pct(v: &mut [f64], p: f64) -> f64 {
        v.sort_by(|a, b| a.total_cmp(b));
        v[((v.len() - 1) as f64 * p).round() as usize]
    }

    fn report(name: &str, ms: &mut [f64], journeys: usize) {
        if ms.is_empty() {
            return;
        }
        let mean = ms.iter().sum::<f64>() / ms.len() as f64;
        println!(
            "{name:<58} median {:>7.2} ms  p95 {:>7.2}  max {:>7.2}  mean {:>7.2}   {:.1} journeys/query",
            pct(ms, 0.5),
            pct(ms, 0.95),
            pct(ms, 1.0),
            mean,
            journeys as f64 / ms.len() as f64
        );
    }

    /// Random station pairs (uniform and by weight), live overlay as in `run`:
    /// every query must give the same journeys with and without target bounds.
    pub fn bounds_check(cx: &Ctx, pairs: usize) -> Result<()> {
        let tt = cx.tt();
        let date = time::parse_date("2026-11-23").unwrap();
        let mut rng = Rng(0x2545F4914F6CDD1D);
        let served: Vec<StationIdx> = (0..tt.stations.len() as StationIdx).filter(|&s| tt.stations[s as usize].weight > 0 && !tt.stations[s as usize].stops.is_empty()).collect();
        let total: u64 = served.iter().map(|&s| tt.stations[s as usize].weight as u64).sum();
        let cum: Vec<u64> = served.iter().scan(0u64, |c, &s| {
            *c += tt.stations[s as usize].weight as u64;
            Some(*c)
        }).collect();
        let mut set = Vec::new();
        while set.len() < pairs {
            let (a, b) = if set.len() % 2 == 0 {
                (served[rng.below(served.len())], served[rng.below(served.len())])
            } else {
                let mut pick = || served[cum.partition_point(|&c| c <= rng.next() % total)];
                (pick(), pick())
            };
            if a != b {
                set.push((a, b, (5 + rng.below(17)) as Secs * 3600 + rng.below(60) as Secs * 60, [0, 0, 1800, 7200][rng.below(4)], [0, 0, 40][rng.below(3)]));
            }
        }
        let (live, _) = fake_live(tt, date, &mut rng);
        // What the engine guarantees not to depend on the search order (ties
        // may be named either way; an earliest-arrival search may report
        // another departure for the same arrival).
        let key = |q: &Query, v: &[Journey]| v.iter().map(|j| (if q.window == 0 { 0 } else { j.dep }, j.arr, j.transfers)).collect::<Vec<_>>();
        for (name, lv) in [("static", None), ("live", Some(&live as &dyn LiveView))] {
            let (mut diff, mut legs, mut n_j, mut t_off, mut t_on) = (0, 0, 0, 0.0, 0.0);
            for &(a, b, t, window, near) in &set {
                let (acc, egr) = (cx.ends(a, near), cx.ends(b, near));
                let mut q = Query::new(date, t, &acc, &egr, &cx.fp);
                q.window = window;
                q.live = lv;
                cx.rt.set_target_bounds(false);
                let t0 = Instant::now();
                let off = cx.rt.plan(&q);
                t_off += t0.elapsed().as_secs_f64() * 1e3;
                cx.rt.set_target_bounds(true);
                let t0 = Instant::now();
                let on = cx.rt.plan(&q);
                t_on += t0.elapsed().as_secs_f64() * 1e3;
                n_j += on.len();
                legs += (on != off) as usize;
                if key(&q, &on) != key(&q, &off) {
                    diff += 1;
                    if diff <= 3 {
                        println!("DIFFERENT: {} → {} {} window {} near {near}", tt.stations[a as usize].name, tt.stations[b as usize].name, hhmm(t), window / 60);
                    }
                }
            }
            println!("{name}: {} queries, {n_j} journeys, {diff} different ({legs} not identical leg by leg); {t_off:.0} ms without bounds, {t_on:.0} ms with", set.len());
        }
        Ok(())
    }

    pub fn run(cx: &Ctx, pairs: usize) -> Result<()> {
        let tt = cx.tt();
        let date = time::parse_date("2026-11-23").unwrap();
        let t0 = Instant::now();
        cx.rt.plan(&Query::new(date, 8 * 3600, &[(0, 0)], &[(1, 0)], &cx.fp));
        println!("first plan() on a date (three day indices): {:.1?}", t0.elapsed());

        let mut rng = Rng(0x9E3779B97F4A7C15);
        // Stations with service; "busy" = drawn proportionally to their weight.
        let served: Vec<StationIdx> = (0..tt.stations.len() as StationIdx).filter(|&s| tt.stations[s as usize].weight > 0 && !tt.stations[s as usize].stops.is_empty()).collect();
        let mut cum = Vec::with_capacity(served.len());
        let mut total = 0u64;
        for &s in &served {
            total += tt.stations[s as usize].weight as u64;
            cum.push(total);
        }
        let mut uniform = Vec::new();
        let mut busy = Vec::new();
        while uniform.len() < pairs {
            let (a, b) = (served[rng.below(served.len())], served[rng.below(served.len())]);
            if a != b {
                uniform.push((a, b, (6 + rng.below(14)) as Secs * 3600 + rng.below(60) as Secs * 60));
            }
        }
        while busy.len() < pairs {
            let mut pick = || served[cum.partition_point(|&c| c <= rng.next() % total)];
            let (a, b) = (pick(), pick());
            if a != b {
                busy.push((a, b, (6 + rng.below(14)) as Secs * 3600 + rng.below(60) as Secs * 60));
            }
        }

        let run_on = |date: Date, name: &str, set: &[(StationIdx, StationIdx, Secs)], window: Secs, near: usize, live: Option<&dyn LiveView>| {
            #[cfg(feature = "stats")]
            kante_raptor::stats::take();
            let mut ms = Vec::with_capacity(set.len());
            let mut journeys = 0;
            let (mut na, mut ne) = (0, 0);
            for &(a, b, t) in set {
                let (acc, egr) = (cx.ends(a, near), cx.ends(b, near));
                na += acc.len();
                ne += egr.len();
                let mut q = Query::new(date, t, &acc, &egr, &cx.fp);
                q.window = window;
                q.live = live;
                let t0 = Instant::now();
                let js = cx.rt.plan(&q);
                ms.push(t0.elapsed().as_secs_f64() * 1e3);
                journeys += js.len();
            }
            let name = format!("{name} [{:.0} acc / {:.0} egr stops]", na as f64 / set.len() as f64, ne as f64 / set.len() as f64);
            report(&name, &mut ms, journeys);
            #[cfg(feature = "stats")]
            {
                let c = kante_raptor::stats::take();
                let per = |k: &str| c.iter().find(|x| x.0 == k).map_or(0, |x| x.1) / set.len().max(1) as u64;
                println!("    per query: queue_pairs {}  pattern_scans {}  scan_steps {}  lookups {}  boardings {}", per("queue_pairs"), per("pattern_scans"), per("scan_steps"), per("lookups"), per("boardings"));
            }
        };
        let run = |name: &str, set: &[(StationIdx, StationIdx, Secs)], window: Secs, near: usize, live: Option<&dyn LiveView>| run_on(date, name, set, window, near, live);

        println!("\n{pairs} random station pairs, Monday 2026-11-23, departure 06:00–20:00, single thread");
        run("uniform stations, earliest arrival", &uniform, 0, 0, None);
        run("uniform stations, 2 h range", &uniform, 7200, 0, None);
        run("busy stations (by weight), earliest arrival", &busy, 0, 0, None);
        run("busy stations (by weight), 2 h range", &busy, 7200, 0, None);
        run("busy, 40 nearest stops each end, earliest arrival", &busy, 0, 40, None);
        run("busy, 40 nearest stops each end, 2 h range", &busy, 7200, 40, None);
        run("uniform, 40 nearest stops each end, 2 h range", &uniform, 7200, 40, None);

        let (live, outlier) = fake_live(tt, date, &mut rng);
        let (n_live, max) = (live.trips.iter().filter(|t| t.is_some()).count(), live.max);
        let t0 = Instant::now();
        let indexed = Indexed::new(tt, date, &live);
        println!("\nwith synthetic live data ({n_live} trips delayed up to 15 min or cancelled, one {max} s late; delay index built in {:.1?})", t0.elapsed());
        let sparse = Sparse(&live, outlier.unwrap_or(usize::MAX), DerivedSlot::default());
        let sparse_indexed = Indexed::new(tt, date, &sparse);
        let n_sparse = (0..tt.trips.len() as TripIdx).filter(|&t| sparse.trip(date, t).is_some()).count();
        for (tag, lv) in [
            ("global look-back", &live as &dyn LiveView),
            ("per-pattern bounds", &indexed),
            (&*format!("{n_sparse} live trips (every 4th), global look-back"), &sparse),
            (&*format!("{n_sparse} live trips (every 4th), per-pattern bounds"), &sparse_indexed),
        ] {
            println!("  {tag}:");
            run("busy stations, earliest arrival, live", &busy, 0, 0, Some(lv));
            run("busy stations, 2 h range, live", &busy, 7200, 0, Some(lv));
            run("busy, 40 nearest stops each end, 2 h range, live", &busy, 7200, 40, Some(lv));
            run_on(date + 7, "busy stations, 2 h range, next week, live", &busy, 7200, 0, Some(lv));
        }
        run_on(date + 7, "busy stations, 2 h range, next week, static", &busy, 7200, 0, None);

        // Fixed reference queries, warm, median of 50.
        println!("\nreference queries (median of 50 warm runs)");
        for (a, b, window) in [("Bern", "Zürich HB", 0), ("Bern", "Zürich HB", 120), ("Bern", "Zermatt", 0), ("Zürich HB", "Lugano", 120), ("Genève", "St. Gallen", 120)] {
            let (Ok(sa), Ok(sb)) = (cx.station(a), cx.station(b)) else { continue };
            let (acc, egr) = (cx.ends(sa, 0), cx.ends(sb, 0));
            let mut q = Query::new(date, 8 * 3600, &acc, &egr, &cx.fp);
            q.window = window * 60;
            let mut ms = Vec::new();
            let mut n = 0;
            for _ in 0..50 {
                let t0 = Instant::now();
                n += cx.rt.plan(&q).len();
                ms.push(t0.elapsed().as_secs_f64() * 1e3);
            }
            report(&format!("{a} → {b} 08:00, window {window} min"), &mut ms, n);
        }

        // Departure boards.
        let mut us = Vec::new();
        let mut n = 0;
        for &(a, _, t) in busy.iter().chain(&uniform) {
            let stops = &tt.stations[a as usize].stops;
            let t0 = Instant::now();
            n += cx.rt.departures(stops, date, t, 30, None).len();
            us.push(t0.elapsed().as_secs_f64() * 1e3);
        }
        println!();
        report("departures(station, limit 30)", &mut us, n);
        for name in ["Bern", "Zürich HB", "Bern, Bahnhof"] {
            if let Ok(s) = cx.station(name) {
                let stops = &tt.stations[s as usize].stops;
                for (tag, lv) in [("global look-back", &live as &dyn LiveView), ("per-pattern bounds", &indexed)] {
                    let mut ms = Vec::new();
                    let mut n = 0;
                    for i in 0..200 {
                        let t0 = Instant::now();
                        n += cx.rt.departures(stops, date, 6 * 3600 + i * 240, 30, Some(lv)).len();
                        ms.push(t0.elapsed().as_secs_f64() * 1e3);
                    }
                    report(&format!("departures({name}, limit 30, live, {tag}) [{} stops]", stops.len()), &mut ms, n);
                }
            }
        }

        // Vehicles.
        println!();
        let t0 = Instant::now();
        cx.rt.vehicles(&BBox::around(LatLon::from_deg(46.948, 7.44), 100.0), date, 8 * 3600, None);
        println!("first vehicles() call (pattern boxes + time buckets of three dates): {:.1?}", t0.elapsed());
        for (name, lat, lon, r) in [("Bern city, 4 km", 46.948, 7.44, 4000.0), ("Zürich city, 6 km", 47.378, 8.54, 6000.0), ("canton-sized, 40 km around Bern", 46.948, 7.44, 40_000.0), ("all of Switzerland", 46.8, 8.2, 250_000.0)] {
            let bbox = BBox::around(LatLon::from_deg(lat, lon), r);
            for (tag, lv) in [("", None), (", live", Some(&live as &dyn LiveView))] {
                let mut ms = Vec::new();
                let mut n = 0;
                for i in 0..100 {
                    let t0 = Instant::now();
                    n += cx.rt.vehicles(&bbox, date, 6 * 3600 + i * 500, lv).len();
                    ms.push(t0.elapsed().as_secs_f64() * 1e3);
                }
                report(&format!("vehicles({name}{tag})"), &mut ms, n);
            }
        }
        Ok(())
    }
}
