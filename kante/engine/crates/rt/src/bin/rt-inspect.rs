//! Inspect saved SIRI-ET / GTFS-RT documents offline.
//!
//! ```text
//! rt-inspect <feed file>... [--timetable data/built/timetable.bin]
//!            [--station "Bern"]... [--examples 12] [--runs 3]
//! ```
//!
//! Prints feed statistics for every file (format and gzip are detected) and,
//! with a timetable, how the journeys match it: by id, by fallback, unmatched
//! per operator, calls aligned, platform changes, and a live departure board
//! for each `--station` (default: "Bern" and "Bern, Bahnhof").

use anyhow::{bail, Context, Result};
use kante_core::time::{self, Date};
use kante_core::{LiveView, Timetable, NONE, TIMETABLE_SCHEMA};
use kante_rt::{
    parse_gtfs_rt, parse_siri_et_auto, FeedMeta, LiveSnapshotBuilder, MatchMethod, MatchedTrip, Matcher, RtJourney, Unmatched,
};
use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

struct Args {
    files: Vec<String>,
    timetable: Option<String>,
    stations: Vec<String>,
    examples: usize,
    runs: usize,
    why: Vec<String>,
    unmatched: usize,
}

fn args() -> Result<Args> {
    let mut a = Args { files: vec![], timetable: None, stations: vec![], examples: 12, runs: 3, why: vec![], unmatched: 0 };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut val = |name: &str| it.next().with_context(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--timetable" | "-t" => a.timetable = Some(val("--timetable")?),
            "--station" | "-s" => a.stations.push(val("--station")?),
            "--examples" | "-n" => a.examples = val("--examples")?.parse()?,
            "--unmatched" => a.unmatched = val("--unmatched")?.parse()?,
            "--why" => a.why.push(val("--why")?),
            "--runs" => a.runs = val("--runs")?.parse::<usize>()?.max(1),
            "--help" | "-h" => {
                println!("usage: rt-inspect <feed file>... [--timetable timetable.bin] [--station NAME]... [--examples N] [--runs N]");
                std::process::exit(0);
            }
            s if s.starts_with("--") => bail!("unknown option {s}"),
            _ => a.files.push(arg),
        }
    }
    if a.files.is_empty() {
        bail!("usage: rt-inspect <feed file>... [--timetable timetable.bin] [--station NAME]... [--examples N]");
    }
    if a.stations.is_empty() {
        a.stations = vec!["Bern".into(), "Bern, Bahnhof".into()];
    }
    Ok(a)
}

fn is_siri(data: &[u8]) -> Result<bool> {
    let head: Vec<u8> = if data.starts_with(&[0x1f, 0x8b]) {
        use std::io::Read;
        let mut h = vec![0u8; 64];
        let n = flate2::read::MultiGzDecoder::new(data).read(&mut h)?;
        h.truncate(n);
        h
    } else {
        data[..data.len().min(64)].to_vec()
    };
    let first = head.iter().copied().find(|b| !b.is_ascii_whitespace() && *b != 0xef && *b != 0xbb && *b != 0xbf);
    Ok(first == Some(b'<'))
}

fn parse(data: &[u8], siri: bool, mut sink: impl FnMut(RtJourney)) -> Result<FeedMeta> {
    if siri {
        parse_siri_et_auto(data, &mut sink)
    } else {
        parse_gtfs_rt(data, &mut sink)
    }
}

fn pct(a: usize, b: usize) -> String {
    if b == 0 {
        "–".into()
    } else {
        format!("{:.1} %", 100.0 * a as f64 / b as f64)
    }
}

fn quantiles(v: &mut [i64]) -> String {
    if v.is_empty() {
        return "no data".into();
    }
    v.sort_unstable();
    let q = |p: f64| v[((v.len() - 1) as f64 * p).round() as usize];
    let zero = v.iter().filter(|&&x| x == 0).count();
    let late3 = v.iter().filter(|&&x| x >= 180).count();
    format!(
        "n {}  min {}  p10 {}  median {}  p90 {}  p99 {}  max {} s; exactly 0: {}; ≥ 3 min: {}",
        v.len(),
        v[0],
        q(0.10),
        q(0.50),
        q(0.90),
        q(0.99),
        v[v.len() - 1],
        pct(zero, v.len()),
        pct(late3, v.len())
    )
}

fn hm(unix: i64) -> String {
    let s = time::fmt_iso(unix);
    s.get(11..16).unwrap_or("").to_string()
}

fn feed_stats(meta: &FeedMeta, js: &[RtJourney], bytes: usize) {
    let calls: usize = js.iter().map(|j| j.calls.len()).sum();
    let c = |f: &dyn Fn(&RtJourney) -> bool| js.iter().filter(|j| f(j)).count();
    let cc = |f: &dyn Fn(&kante_rt::RtCall) -> bool| js.iter().flat_map(|j| &j.calls).filter(|c| f(c)).count();
    println!("  feed timestamp   {} ({})  feed_version {:?}", meta.timestamp, time::fmt_iso(meta.timestamp), meta.feed_version);
    println!("  size             {:.1} MB", bytes as f64 / 1e6);
    println!("  journeys         {}   calls {}", js.len(), calls);
    let mut days: HashMap<&str, usize> = HashMap::new();
    for j in js {
        *days.entry(&j.operating_day).or_default() += 1;
    }
    let mut days: Vec<_> = days.into_iter().collect();
    days.sort();
    println!("  operating days   {}", days.iter().map(|(d, n)| format!("{d}: {n}")).collect::<Vec<_>>().join(", "));
    println!(
        "  journey flags    cancelled {}  extra {}  monitored {}  not monitored {}  prediction inaccurate {}",
        c(&|j| j.cancelled),
        c(&|j| j.extra),
        c(&|j| j.monitored),
        c(&|j| !j.monitored),
        c(&|j| j.prediction_inaccurate)
    );
    println!(
        "  journey ids      ch:1:sjyid:… {}   other {}   none {}   with GTFS trip_id {}",
        c(&|j| j.journey_ref.to_ascii_lowercase().starts_with("ch:1:sjyid:")),
        c(&|j| !j.journey_ref.is_empty() && !j.journey_ref.to_ascii_lowercase().starts_with("ch:1:sjyid:")),
        c(&|j| j.journey_ref.is_empty()),
        c(&|j| !j.trip_id.is_empty())
    );
    println!(
        "  with actual times {} journeys ({} calls from RecordedCalls, {} actual arrivals, {} actual departures)",
        c(&|j| j.calls.iter().any(|c| c.actual_arr.is_some() || c.actual_dep.is_some())),
        cc(&|c| c.recorded),
        cc(&|c| c.actual_arr.is_some()),
        cc(&|c| c.actual_dep.is_some())
    );
    let split: usize = js
        .iter()
        .map(|j| j.calls.windows(2).filter(|w| w[0].recorded && !w[1].recorded && w[0].order == w[1].order && w[0].stop_ref == w[1].stop_ref).count())
        .sum();
    println!(
        "  call flags       cancelled/skipped {}  extra {}  no_data {}  stops reported as RecordedCall and EstimatedCall at once {}",
        cc(&|c| c.cancelled),
        cc(&|c| c.extra_call),
        cc(&|c| c.no_data),
        split
    );
    println!(
        "  platforms        current name on {} calls ({}), planned name on {}, separate quay ref on {}",
        cc(&|c| !c.platform.is_empty()),
        pct(cc(&|c| !c.platform.is_empty()), calls),
        cc(&|c| !c.planned_platform.is_empty()),
        cc(&|c| !c.quay_ref.is_empty())
    );
    let level = |r: &str| {
        let l = r.to_ascii_lowercase();
        match l.strip_prefix("ch:1:sloid:") {
            Some(rest) if rest.contains("_gen") => 3,
            Some(rest) if rest.contains(':') => 0,
            Some(_) => 1,
            None => 2,
        }
    };
    let mut lv = [0usize; 4];
    for c in js.iter().flat_map(|j| &j.calls) {
        lv[level(&c.stop_ref)] += 1;
    }
    println!(
        "  stop references  boarding-point SLOID {} ({}), stop SLOID {}, generated GTFS id {}, other {}",
        lv[0],
        pct(lv[0], calls),
        lv[1],
        lv[3],
        lv[2]
    );
    let mut dep: Vec<i64> = Vec::new();
    let mut act: Vec<i64> = Vec::new();
    for c in js.iter().flat_map(|j| &j.calls) {
        if c.cancelled {
            continue;
        }
        if let (Some(a), Some(e)) = (c.aimed_dep, c.expected_dep) {
            dep.push(e - a);
        } else if let Some(d) = c.dep_delay {
            dep.push(d as i64);
        }
        if let (Some(a), Some(e)) = (c.aimed_dep, c.actual_dep) {
            act.push(e - a);
        }
    }
    println!("  forecast departure delay   {}", quantiles(&mut dep));
    if !act.is_empty() {
        println!("  measured departure delay   {}", quantiles(&mut act));
    }
}

#[derive(Default)]
struct OpStat {
    total: usize,
    by_id: usize,
    fallback: usize,
    unmatched: usize,
    agency: HashMap<u32, usize>,
    example: String,
}

/// Display key for the operator of a journey.
fn operator_key(j: &RtJourney) -> String {
    if !j.operator_ref.is_empty() {
        j.operator_ref.clone()
    } else {
        // GTFS-RT has no operator; the legacy ids start with "<country>:<agency>:".
        let mut parts = j.journey_ref.split(':');
        match (parts.next(), parts.next()) {
            (Some(a), Some(b)) if a.len() == 2 && a.bytes().all(|c| c.is_ascii_digit()) => format!("agency {b}"),
            (Some("ch"), _) => j.journey_ref.split(':').take(4).collect::<Vec<_>>().join(":"),
            _ => "(no operator)".into(),
        }
    }
}

fn match_stats(tt: &Timetable, m: &Matcher, js: &[RtJourney], results: &[Result<MatchedTrip, Unmatched>]) {
    let n = js.len();
    let count = |f: &dyn Fn(&Result<MatchedTrip, Unmatched>) -> bool| results.iter().filter(|r| f(r)).count();
    let by = |method: MatchMethod| count(&|r| matches!(r, Ok(x) if x.method == method));
    let (trip_id, jid, fb) = (by(MatchMethod::TripId), by(MatchMethod::JourneyId), by(MatchMethod::Fallback));
    let matched = trip_id + jid + fb;
    println!("  matched          {} of {} ({})", matched, n, pct(matched, n));
    println!("    by GTFS trip id      {:6}  {}", trip_id, pct(trip_id, n));
    println!("    by journey id + day  {:6}  {}", jid, pct(jid, n));
    println!("    by fallback          {:6}  {}", fb, pct(fb, n));
    let reason = |u: Unmatched| count(&|r| matches!(r, Err(e) if *e == u));
    println!(
        "    unmatched            {:6}  {}  (extra journey {}, id known but does not fit {}, not found {}, no known stop {}, bad day {})",
        n - matched,
        pct(n - matched, n),
        reason(Unmatched::Extra),
        reason(Unmatched::IdDoesNotFit),
        reason(Unmatched::NotFound),
        reason(Unmatched::NoStops),
        reason(Unmatched::BadDay)
    );
    let regular = js.iter().filter(|j| !j.extra).count();
    let regular_matched = js.iter().zip(results).filter(|(j, r)| !j.extra && r.is_ok()).count();
    println!("    of the {} journeys not flagged extra: {} matched", regular, pct(regular_matched, regular));
    let other_day = js
        .iter()
        .zip(results)
        .filter(|(j, r)| matches!(r, Ok(x) if time::parse_date(&j.operating_day) != Some(x.date)))
        .count();
    println!("    matched on a neighbouring service day: {other_day}");

    // Calls.
    let (mut calls, mut aligned, mut on_sched) = (0usize, 0usize, 0usize);
    let mut all_calls = 0usize;
    let mut unknown_station = 0usize;
    for (j, r) in js.iter().zip(results) {
        all_calls += j.calls.len();
        unknown_station += j.calls.iter().filter(|c| m.station_of_ref(tt, &c.stop_ref).is_none()).count();
        if let Ok(x) = r {
            calls += x.calls as usize;
            aligned += x.aligned as usize;
            on_sched += x.on_schedule as usize;
        }
    }
    println!(
        "  calls            {} calls in the feed; stop reference unknown to the timetable: {} ({})",
        all_calls,
        unknown_station,
        pct(unknown_station, all_calls)
    );
    println!(
        "    in matched journeys {}: aligned to a stop position {} ({}), aimed time = timetable time (±90 s) {} ({})",
        calls,
        aligned,
        pct(aligned, calls),
        on_sched,
        pct(on_sched, calls)
    );
    let extra_calls = js.iter().zip(results).filter(|(_, r)| r.is_ok()).flat_map(|(j, _)| &j.calls).filter(|c| c.extra_call).count();
    println!("    ({} of the calls in matched journeys are flagged ExtraCall; unaligned calls in total: {})", extra_calls, calls - aligned);
    println!("    aligned calls over all calls of the feed: {}", pct(aligned, all_calls));
    let fbs: Vec<&MatchedTrip> = results.iter().flatten().filter(|x| x.method == MatchMethod::Fallback).collect();
    let fb_full = fbs.iter().filter(|x| x.on_schedule == x.calls).count();
    let fb_line = js.iter().zip(results).filter(|(j, r)| matches!(r, Ok(x) if x.method == MatchMethod::Fallback && tt.trip_line(x.trip).name.replace(' ', "").eq_ignore_ascii_case(&j.line_name.replace(' ', "")))).count();
    let fb_calls: usize = fbs.iter().map(|x| x.calls as usize).sum();
    let fb_ok: usize = fbs.iter().map(|x| x.on_schedule as usize).sum();
    println!(
        "    fallback matches: {} — every call on schedule {}, same line name {}, calls on schedule {} of {} ({})",
        fbs.len(), fb_full, fb_line, fb_ok, fb_calls, pct(fb_ok, fb_calls)
    );
    let implausible: usize = results.iter().flatten().map(|x| x.implausible as usize).sum();
    let impl_trips = results.iter().flatten().filter(|x| x.implausible > 0).count();
    println!("    reported times dropped as implausible (> 3 h late or > 30 min early): {implausible} in {impl_trips} journeys");

    // Platforms.
    let (mut named, mut resolved, mut textual, mut by_ref, mut plan_unlabelled, mut trips_changed) = (0usize, 0, 0, 0, 0, 0);
    let (mut plan_named, mut refined, mut unlabelled_resolved) = (0usize, 0usize, 0usize);
    for (j, r) in js.iter().zip(results) {
        let Ok(x) = r else { continue };
        named += j.calls.iter().filter(|c| !c.platform.is_empty() && !c.extra_call).count();
        let quay_at = |p: u16| x.live.quay.get(p as usize).copied().unwrap_or(NONE);
        let mut any = false;
        for (p, planned, _) in &x.platform_changes {
            any = true;
            if planned.is_empty() {
                plan_unlabelled += 1;
                unlabelled_resolved += (quay_at(*p) != NONE) as usize;
            } else if quay_at(*p) != NONE {
                resolved += 1;
            } else {
                textual += 1;
            }
        }
        let stops = tt.pattern_stops(tt.trips[x.trip as usize].pattern);
        plan_named += stops.iter().enumerate().filter(|(p, &s)| !tt.stops[s as usize].label.is_empty() && x.live.arr_delay.len() > *p).count();
        let mut silent = 0;
        for (p, &q) in x.live.quay.iter().enumerate() {
            if q != NONE && !x.platform_changes.iter().any(|c| c.0 as usize == p) {
                silent += 1;
                refined += (tt.stops[stops[p] as usize].precision == kante_core::Precision::Station) as usize;
            }
        }
        by_ref += silent;
        if any || silent > 0 {
            trips_changed += 1;
        }
    }
    println!("  platforms        {} calls of matched journeys carry a platform name", named);
    println!("    changed vs. plan, resolved to a Stop:   {resolved}");
    println!("    changed vs. plan, text only:            {textual}");
    println!("    named live where the plan has no label: {plan_unlabelled} ({unlabelled_resolved} resolved to a Stop)");
    println!("    boarding point given by reference only: {by_ref} ({refined} where the plan only names the stop, {} another boarding point than planned)", by_ref - refined);
    println!("    (stop positions of matched trips with a planned label: {plan_named})");
    println!("    trips affected: {trips_changed}");

    // A few examples of each kind of platform statement.
    let mut ex: [Vec<String>; 4] = Default::default();
    let mut text_only_names: HashMap<String, usize> = HashMap::new();
    for (j, r) in js.iter().zip(results) {
        let Ok(x) = r else { continue };
        let stops = tt.pattern_stops(tt.trips[x.trip as usize].pattern);
        for (p, planned, current) in &x.platform_changes {
            let s = &tt.stops[stops[*p as usize] as usize];
            let q = x.live.quay.get(*p as usize).copied().unwrap_or(NONE);
            let kind = match (planned.is_empty(), q != NONE) {
                (false, true) => 0,
                (false, false) => 1,
                (true, true) => 2,
                (true, false) => 3,
            };
            if kind == 1 {
                *text_only_names.entry(format!("{planned}→{current}")).or_default() += 1;
            }
            if ex[kind].len() < 6 && !ex[kind].iter().any(|e| e.contains(&tt.stations[s.station as usize].name)) {
                let labels: Vec<&str> = tt.stations[s.station as usize].stops.iter().map(|&k| tt.stops[k as usize].label.as_str()).filter(|l| !l.is_empty()).take(14).collect();
                ex[kind].push(format!(
                    "line {} → {} at {} ({}): {:?} → {:?}{}; labels at the station: {:?}",
                    j.line_name,
                    trunc(&j.destination, 20),
                    tt.stations[s.station as usize].name,
                    hm(time::to_unix(x.date, tt.dep(x.trip, *p as usize))),
                    planned,
                    current,
                    if q != NONE { format!(" = {}", tt.stops[q as usize].sloid) } else { String::new() },
                    labels
                ));
            }
        }
    }
    for (kind, title) in ["changed, resolved", "changed, text only", "plan unlabelled, resolved", "plan unlabelled, text only"].iter().enumerate() {
        println!("    examples — {title}:");
        for e in &ex[kind] {
            println!("      {}", trunc(e, 230));
        }
    }
    let mut v: Vec<_> = text_only_names.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    println!("    text-only changes by (plan→live): {}", v.iter().take(14).map(|(k, n)| format!("{k} ×{n}")).collect::<Vec<_>>().join(", "));

    // Boarding points changed by reference only: who sends them?
    let mut ref_ops: HashMap<String, (usize, String)> = HashMap::new();
    for (j, r) in js.iter().zip(results) {
        let Ok(x) = r else { continue };
        let stops = tt.pattern_stops(tt.trips[x.trip as usize].pattern);
        for (p, &q) in x.live.quay.iter().enumerate() {
            if q == NONE || tt.stops[stops[p] as usize].precision == kante_core::Precision::Station {
                continue;
            }
            let e = ref_ops.entry(operator_key(j)).or_default();
            e.0 += 1;
            if e.1.is_empty() {
                let (a, b) = (&tt.stops[stops[p] as usize], &tt.stops[q as usize]);
                e.1 = format!("line {} at {}: plan {} {:?} ({:?}) → live {} {:?} ({:?})", j.line_name, tt.stations[a.station as usize].name, a.sloid, a.label, a.precision, b.sloid, b.label, b.precision);
            }
        }
    }
    let mut v: Vec<_> = ref_ops.into_iter().collect();
    v.sort_by_key(|e| std::cmp::Reverse(e.1 .0));
    println!("    another boarding point than the planned one (by name or reference), by operator:");
    for (k, (n, ex)) in v.iter().take(8) {
        println!("      {:<24} {:>5}  e.g. {}", k, n, trunc(ex, 170));
    }

    // Largest delays and extra journeys that matched anyway.
    let mut big: Vec<(i32, String)> = Vec::new();
    let (mut d1h, mut d3h, mut neg10) = (0usize, 0usize, 0usize);
    for (j, r) in js.iter().zip(results) {
        let Ok(x) = r else { continue };
        if x.live.cancelled {
            continue;
        }
        let max = x.live.dep_delay.iter().copied().max().unwrap_or(0);
        let min = x.live.dep_delay.iter().chain(&x.live.arr_delay).copied().min().unwrap_or(0);
        d1h += (max >= 3600) as usize;
        d3h += (max >= 10_800) as usize;
        neg10 += (min <= -600) as usize;
        if max >= 3600 || min <= -600 {
            big.push((if max >= 3600 { max } else { min }, format!("{} line {} → {} [{}] monitored {} dep delays {:?}", j.journey_ref, j.line_name, j.destination, j.operator_ref, j.monitored, &x.live.dep_delay[..x.live.dep_delay.len().min(6)])));
        }
    }
    big.sort_by_key(|b| -(b.0.abs()));
    println!("  delays           trips with a departure ≥ 1 h late: {d1h}, ≥ 3 h: {d3h}; with a time ≥ 10 min early: {neg10}");
    for (d, text) in big.iter().take(10) {
        println!("      {:>7} s  {}", d, trunc(text, 190));
    }
    let extra: Vec<_> = js.iter().zip(results).filter(|(j, r)| j.extra && r.is_ok()).collect();
    let full = extra.iter().filter(|(_, r)| matches!(r, Ok(x) if x.on_schedule == x.calls)).count();
    println!("  extra journeys   {} carry a known id and match; {} of them with every call on schedule", extra.len(), full);
    for (j, r) in extra.iter().filter(|(_, r)| matches!(r, Ok(x) if x.on_schedule != x.calls)).take(4) {
        let x = r.as_ref().unwrap();
        println!("      {} line {} → {}: {} calls, {} aligned, {} on schedule", j.journey_ref, j.line_name, j.destination, x.calls, x.aligned, x.on_schedule);
    }

    // Operators.
    let mut ops: HashMap<String, OpStat> = HashMap::new();
    for (j, r) in js.iter().zip(results) {
        let o = ops.entry(operator_key(j)).or_default();
        o.total += 1;
        match r {
            Ok(x) => {
                if x.method == MatchMethod::Fallback {
                    o.fallback += 1;
                } else {
                    o.by_id += 1;
                }
                *o.agency.entry(tt.trip_line(x.trip).agency).or_default() += 1;
            }
            Err(e) => {
                if *e != Unmatched::Extra {
                    o.unmatched += 1;
                    if o.example.is_empty() {
                        o.example = format!("{} line {} → {} ({:?})", j.journey_ref, j.line_name, j.destination, e);
                    }
                }
            }
        }
    }
    let name = |o: &OpStat| {
        o.agency.iter().max_by_key(|(_, &n)| n).map(|(&a, _)| tt.agencies[a as usize].name.clone()).unwrap_or_else(|| "?".into())
    };
    let mut v: Vec<_> = ops.iter().collect();
    v.sort_by(|a, b| b.1.total.cmp(&a.1.total).then(a.0.cmp(b.0)));
    println!("  operators        {} distinct; largest:", v.len());
    println!("    {:<28} {:<38} {:>6} {:>6} {:>8} {:>9}", "operator", "agency (from matched trips)", "total", "by id", "fallback", "unmatched");
    for (k, o) in v.iter().take(15) {
        println!("    {:<28} {:<38} {:>6} {:>6} {:>8} {:>9}", k, trunc(&name(o), 38), o.total, o.by_id, o.fallback, o.unmatched);
    }
    v.sort_by(|a, b| b.1.unmatched.cmp(&a.1.unmatched).then(a.0.cmp(b.0)));
    println!("  unmatched by operator (extra journeys not counted):");
    for (k, o) in v.iter().filter(|(_, o)| o.unmatched > 0).take(15) {
        println!("    {:<28} {:<30} {:>4} of {:>4}   e.g. {}", k, trunc(&name(o), 30), o.unmatched, o.total, trunc(&o.example, 110));
    }
    let fb_ops = v.iter().filter(|(_, o)| o.fallback > 0).count();
    let fb_only: usize = v.iter().filter(|(_, o)| o.by_id == 0 && o.fallback > 0).map(|(_, o)| o.fallback).sum();
    println!("  fallback matched journeys of {fb_ops} operators; {fb_only} of them from operators with no id match at all");
}

fn trunc(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n - 1).collect::<String>())
    }
}

/// Live departure board of one station, built from the matched journeys.
fn board(tt: &Timetable, station_name: &str, js: &[RtJourney], results: &[Result<MatchedTrip, Unmatched>], now: i64, limit: usize) {
    let Some(station) = tt.stations.iter().position(|s| s.name == station_name) else {
        println!("  station {station_name:?} not in the timetable");
        return;
    };
    struct Row {
        sched: i64,
        text: String,
        changed: bool,
    }
    let mut rows: Vec<Row> = Vec::new();
    for (j, r) in js.iter().zip(results) {
        let Ok(x) = r else { continue };
        let stops = tt.pattern_stops(tt.trips[x.trip as usize].pattern);
        for (p, &s) in stops.iter().enumerate() {
            if tt.stops[s as usize].station as usize != station || p + 1 == stops.len() {
                continue;
            }
            let sched = time::to_unix(x.date, tt.dep(x.trip, p));
            if sched < now - 300 {
                continue;
            }
            let st = &tt.stops[s as usize];
            let planned = format!("{}{}", st.label, st.sectors);
            let change = x.platform_changes.iter().find(|c| c.0 as usize == p);
            let quay = x.live.quay.get(p).copied().unwrap_or(NONE);
            let platform = match change {
                Some((_, a, b)) => format!(
                    "{} → {}{}",
                    if a.is_empty() { "?" } else { a },
                    b,
                    if quay != NONE { format!("  [{}]", tt.stops[quay as usize].sloid) } else { "  [text only]".into() }
                ),
                None if quay != NONE => format!("{planned} → [{}]", tt.stops[quay as usize].sloid),
                None => planned,
            };
            let line = tt.trip_line(x.trip);
            let delay = x.live.dep_delay_at(p);
            let state = if x.live.is_skipped(p) {
                "CANCELLED".to_string()
            } else {
                format!("{:+} s", delay)
            };
            rows.push(Row {
                sched,
                changed: change.is_some_and(|c| !c.1.is_empty()),
                text: format!(
                    "{}  {:<7} {:<28} {:<26} {:<10} {:<9} {}",
                    hm(sched),
                    trunc(&line.name, 7),
                    trunc(if j.destination.is_empty() { tt.str(tt.trips[x.trip as usize].headsign) } else { &j.destination }, 28),
                    trunc(&platform, 26),
                    state,
                    match x.method {
                        MatchMethod::TripId => "trip id",
                        MatchMethod::JourneyId => "sjyid",
                        MatchMethod::Fallback => "fallback",
                    },
                    trunc(&tt.agencies[line.agency as usize].name, 24)
                ),
            });
        }
    }
    rows.sort_by(|a, b| a.sched.cmp(&b.sched).then(a.text.cmp(&b.text)));
    let changed: Vec<&Row> = rows.iter().filter(|r| r.changed).collect();
    println!("  {:?}: {} live departures from now on, {} with a platform other than planned", station_name, rows.len(), changed.len());
    println!("    time   line    to                           platform (plan → live)     delay      match     operator");
    for r in &changed {
        println!("  * {}", r.text);
    }
    for r in rows.iter().filter(|r| !r.changed).take(limit) {
        println!("    {}", r.text);
    }
}

/// Explain the matching of every journey whose reference contains `needle`.
fn why(tt: &Timetable, m: &Matcher, js: &[RtJourney], needle: &str) {
    let local = |t: Option<i64>| t.map(|t| time::fmt_iso(t)[11..19].to_string()).unwrap_or_else(|| "--:--:--".into());
    for j in js.iter().filter(|j| j.journey_ref.contains(needle) || j.trip_id.contains(needle)).take(3) {
        println!("\n--- {} / {:?} day {} line {} → {} (cancelled {}, extra {})", j.journey_ref, j.trip_id, j.operating_day, j.line_name, j.destination, j.cancelled, j.extra);
        match m.explain(tt, j) {
            Ok(x) => println!(
                "    MATCHED {:?} trip {} ({}) on {} aligned {}/{} on schedule {}; delays dep {:?}; changes {:?}",
                x.method, x.trip, tt.trip_gtfs_id(x.trip), time::fmt_date(x.date), x.aligned, x.calls, x.on_schedule, x.live.dep_delay, x.platform_changes
            ),
            Err(e) => println!("    UNMATCHED: {e:?}"),
        }
        for c in &j.calls {
            let st = m.station_of_ref(tt, &c.stop_ref);
            println!(
                "    call {:>3} {:<28} {:<26} station {:<24} aimed {} / {}  exp {} / {}  act {} / {}  pf {:?}{}{}",
                c.order,
                c.stop_ref,
                trunc(&c.stop_name, 26),
                st.map(|s| trunc(&tt.stations[s as usize].name, 24)).unwrap_or_else(|| "?".into()),
                local(c.aimed_arr), local(c.aimed_dep), local(c.expected_arr), local(c.expected_dep), local(c.actual_arr), local(c.actual_dep),
                c.platform,
                if c.extra_call { " EXTRA" } else { "" },
                if c.cancelled { " CANCELLED" } else { "" },
            );
        }
        let Some(day) = time::parse_date(&j.operating_day) else { continue };
        let mut cands: Vec<u32> = m.trips_of_journey(tt, &j.journey_ref).collect();
        cands.extend(m.trip_of_gtfs_id(tt, &j.trip_id));
        println!("    {} static trips with this id", cands.len());
        for t in cands.into_iter().take(6) {
            let act: Vec<String> = (-1..=1).filter(|d| tt.trip_active(t, day + d)).map(|d| time::fmt_date(day + d)).collect();
            println!("    trip {} {} line {} active on {:?}", t, tt.trip_gtfs_id(t), tt.trip_line(t).name, act);
            if act.is_empty() {
                continue;
            }
            for (p, &s) in tt.pattern_stops(tt.trips[t as usize].pattern).iter().enumerate() {
                let st = &tt.stops[s as usize];
                let f = |x: i32| format!("{:02}:{:02}:{:02}", x / 3600, x / 60 % 60, x % 60);
                println!("      {:>3} {:<24} {:<34} {:<6} {} / {}", p, trunc(&tt.stations[st.station as usize].name, 24), st.sloid, format!("{}{}", st.label, st.sectors), f(tt.arr(t, p)), f(tt.dep(t, p)));
            }
        }
    }
}

fn main() -> Result<()> {
    let a = args()?;
    let tt: Option<(Timetable, Matcher)> = match &a.timetable {
        Some(p) => {
            let t = Instant::now();
            let tt: Timetable = kante_core::io::load(Path::new(p), TIMETABLE_SCHEMA)?;
            let load = t.elapsed();
            let t = Instant::now();
            let m = Matcher::new(&tt);
            println!(
                "timetable {} (feed version {}): {} trips, {} stops, {} stations; loaded in {:.2} s, Matcher::new {:.0} ms",
                p,
                tt.feed_version,
                tt.trips.len(),
                tt.stops.len(),
                tt.stations.len(),
                load.as_secs_f64(),
                t.elapsed().as_secs_f64() * 1e3
            );
            Some((tt, m))
        }
        None => None,
    };

    let mut combined = LiveSnapshotBuilder::new();
    // Journey key → (date, trip, method) of the SIRI-ET files, to cross-check
    // against the trip ids GTFS-RT states outright.
    let mut siri_matches: HashMap<(String, String), (Date, u32, MatchMethod)> = HashMap::new();
    for file in &a.files {
        let data = std::fs::read(file).with_context(|| format!("read {file}"))?;
        let siri = is_siri(&data)?;
        println!("\n== {} ({})", file, if siri { "SIRI-ET" } else { "GTFS-RT" });

        // Parse only (best of N), discarding the journeys.
        let mut best = f64::MAX;
        for _ in 0..a.runs {
            let t = Instant::now();
            let mut n = 0usize;
            parse(&data, siri, |j| n += j.calls.len())?;
            best = best.min(t.elapsed().as_secs_f64());
        }
        let gz = if data.starts_with(&[0x1f, 0x8b]) { " of gzip input, unpacking included" } else { "" };
        println!("  parse            {:.1} ms ({:.0} MB/s{gz}, one thread, best of {})", best * 1e3, data.len() as f64 / 1e6 / best, a.runs);

        let mut js = Vec::new();
        let meta = parse(&data, siri, |j| js.push(j))?;
        if let Some((tt, _)) = &tt {
            if !meta.feed_version.is_empty() && meta.feed_version != tt.feed_version {
                println!("  WARNING: feed_version {:?} ≠ timetable {:?}; trip ids may not line up", meta.feed_version, tt.feed_version);
            }
        }
        feed_stats(&meta, &js, data.len());

        let Some((tt, m)) = &tt else { continue };
        // Match only (best of N).
        let mut best = f64::MAX;
        let mut results = Vec::new();
        for _ in 0..a.runs {
            let t = Instant::now();
            results = js.iter().map(|j| m.explain(tt, j)).collect();
            best = best.min(t.elapsed().as_secs_f64());
        }
        println!("  match            {:.1} ms for {} journeys ({:.1} µs each)", best * 1e3, js.len(), best * 1e6 / js.len().max(1) as f64);
        // What the server does per poll: parse + match + build, streaming.
        let mut best = f64::MAX;
        let mut snap_info = String::new();
        for _ in 0..a.runs {
            let t = Instant::now();
            let mut b = LiveSnapshotBuilder::with_capacity(8192);
            let counts = if siri { b.add_siri_et(tt, m, &data[..])? } else { b.add_gtfs_rt(tt, m, &data)? };
            let dup = b.duplicates;
            let snap = b.build();
            best = best.min(t.elapsed().as_secs_f64());
            let observed = snap.iter().filter(|(_, _, l)| l.observed_pos >= 0).count();
            let cancelled = snap.iter().filter(|(_, _, l)| l.cancelled).count();
            let skipped: usize = snap.iter().map(|(_, _, l)| l.skipped.iter().filter(|&&s| s).count()).sum();
            let quays: usize = snap.iter().map(|(_, _, l)| l.quay.iter().filter(|&&q| q != NONE).count()).sum();
            snap_info = format!(
                "{} trips ({} journeys matched, {} hit a trip that already had data); with a measured position {}, cancelled {}, skipped stops {}, changed boarding points {}, max_delay {} s ({} trips ≥ 15 min late; max of the rest {} s)",
                snap.len(),
                counts.matched(),
                dup,
                observed,
                cancelled,
                skipped,
                quays,
                snap.max_delay(),
                snap.late_trips().len(),
                snap.common_max_delay()
            );
        }
        println!("  snapshot         parse + match + build: {:.1} ms (best of {})", best * 1e3, a.runs);
        println!("                   {snap_info}");
        match_stats(tt, m, &js, &results);

        if a.unmatched > 0 {
            println!("  unmatched journeys (extra ones left out):");
            for (j, r) in js.iter().zip(&results).filter(|(_, r)| matches!(r, Err(e) if *e != Unmatched::Extra)).take(a.unmatched) {
                let first = j.calls.iter().find_map(|c| c.aimed_dep.or(c.aimed_arr)).map(time::fmt_iso).unwrap_or_default();
                println!(
                    "    {:?} {} day {} line {} → {} [{}] cancelled {} calls {} first {} ({}), static trips with id: {}",
                    r.as_ref().err().unwrap(), j.journey_ref, j.operating_day, j.line_name, trunc(&j.destination, 24), j.mode, j.cancelled, j.calls.len(), first,
                    j.calls.first().map(|c| c.stop_name.as_str()).unwrap_or(""),
                    m.trips_of_journey(tt, &j.journey_ref).map(|t| format!("{:?}", (-1..=1).filter(|d| tt.trip_active(t, time::parse_date(&j.operating_day).unwrap_or(0) + d)).collect::<Vec<_>>())).collect::<Vec<_>>().join(" ")
                );
            }
        }
        for needle in &a.why {
            why(tt, m, &js, needle);
        }
        let now = meta.timestamp;
        println!("  examples (feed time {}):", hm(now));
        for s in &a.stations {
            board(tt, s, &js, &results, now, a.examples);
        }
        if siri {
            for (j, r) in js.iter().zip(&results) {
                if let Ok(x) = r {
                    siri_matches.insert((j.journey_ref.to_ascii_lowercase(), j.operating_day.clone()), (x.date, x.trip, x.method));
                }
            }
        } else if !siri_matches.is_empty() {
            // GTFS-RT carries the same journeys with the static trip id. Legacy
            // ids "85:801:7631-1276" are SIRI's "ch:1:ServiceJourney:801:7631-1276".
            let mut stat: HashMap<MatchMethod, (usize, usize)> = HashMap::new();
            let mut shown = 0;
            for (j, r) in js.iter().zip(&results) {
                let Ok(x) = r else { continue };
                let key = if j.journey_ref.to_ascii_lowercase().starts_with("ch:") {
                    j.journey_ref.to_ascii_lowercase()
                } else {
                    match j.journey_ref.split_once(':') {
                        Some((_, rest)) => format!("ch:1:servicejourney:{}", rest.to_ascii_lowercase()),
                        None => continue,
                    }
                };
                let Some(&(date, trip, method)) = siri_matches.get(&(key, j.operating_day.clone())) else { continue };
                let e = stat.entry(method).or_default();
                e.0 += 1;
                if (date, trip) == (x.date, x.trip) {
                    e.1 += 1;
                } else if shown < 5 {
                    shown += 1;
                    println!("    differs: {} — SIRI-ET {:?} → {} on {}, GTFS-RT → {} on {}", j.journey_ref, method, tt.trip_gtfs_id(trip), time::fmt_date(date), tt.trip_gtfs_id(x.trip), time::fmt_date(x.date));
                }
            }
            println!("  cross-check      journeys present in both feeds, SIRI-ET match vs. the trip id GTFS-RT states:");
            for (method, (n, same)) in &stat {
                println!("    SIRI-ET matched by {:?}: {} compared, {} the same trip and day ({})", method, n, same, pct(*same, *n));
            }
        }
        for r in results.into_iter().flatten() {
            if siri {
                combined.push(r);
            } else {
                combined.push_if_absent(r);
            }
        }
        combined.feed(meta);
    }
    if tt.is_some() && a.files.len() > 1 {
        let dup = combined.duplicates;
        let snap = combined.build();
        println!(
            "\n== combined snapshot (SIRI-ET first, GTFS-RT fills gaps): {} trips, {} journeys overlapped, max_delay {} s, newest feed {}",
            snap.len(),
            dup,
            snap.max_delay(),
            time::fmt_iso(snap.timestamp())
        );
        let mut per_day: HashMap<Date, usize> = HashMap::new();
        for (d, _, _) in snap.iter() {
            *per_day.entry(d).or_default() += 1;
        }
        let mut v: Vec<_> = per_day.into_iter().collect();
        v.sort();
        println!("   trips per service day: {}", v.iter().map(|(d, n)| format!("{}: {}", time::fmt_date(*d), n)).collect::<Vec<_>>().join(", "));
    }
    Ok(())
}
