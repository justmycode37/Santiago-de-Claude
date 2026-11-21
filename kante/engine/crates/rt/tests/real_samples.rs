//! Checks against the saved national feeds of 2026-11-20 21:55 UTC and the
//! built timetable. Each test is skipped (with a note) when its files are not
//! there, so the suite also runs on a machine without the research data.
//!
//! Paths: `KANTE_RT_SAMPLES` (directory with `otd-siriet/siri-et.xml` and
//! `otd-gtfsrt/gtfs_rt.pb`) and `KANTE_TIMETABLE` (a `timetable.bin`).

use kante_core::{LiveView, Timetable, NONE, TIMETABLE_SCHEMA};
use kante_rt::{parse_gtfs_rt, parse_siri_et, LiveSnapshotBuilder, MatchMethod, Matcher, RtJourney};
use std::path::PathBuf;
use std::time::Instant;

fn samples() -> PathBuf {
    std::env::var_os("KANTE_RT_SAMPLES")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/home/niknal/.t3/scratch/2026-11-20-i-want-you-to-look-59090bd5/data/realtime-fable"))
}

fn read(rel: &str) -> Option<Vec<u8>> {
    let p = samples().join(rel);
    match std::fs::read(&p) {
        Ok(b) => Some(b),
        Err(_) => {
            eprintln!("skipped: {} not found", p.display());
            None
        }
    }
}

fn timetable() -> Option<Timetable> {
    let p = std::env::var_os("KANTE_TIMETABLE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../data/built/timetable.bin"));
    match kante_core::io::load::<Timetable>(&p, TIMETABLE_SCHEMA) {
        Ok(tt) if tt.feed_version == "20261118" => Some(tt),
        Ok(tt) => {
            eprintln!("skipped: timetable is feed version {}, the samples need 20261118", tt.feed_version);
            None
        }
        Err(e) => {
            eprintln!("skipped: {e}");
            None
        }
    }
}

#[test]
fn siri_et_sample_parses_fast() {
    let Some(data) = read("otd-siriet/siri-et.xml") else { return };
    let t = Instant::now();
    let mut js: Vec<RtJourney> = Vec::new();
    let meta = parse_siri_et(&data[..], |j| js.push(j)).unwrap();
    let dt = t.elapsed();
    eprintln!("SIRI-ET: {:.1} MB in {:.0} ms", data.len() as f64 / 1e6, dt.as_secs_f64() * 1e3);
    assert_eq!((meta.journeys, js.len()), (6812, 6812));
    assert_eq!(js.iter().map(|j| j.calls.len()).sum::<usize>(), 113_884);
    assert_eq!(meta.timestamp, 1_795_211_705); // 2026-11-20T21:55:05Z
    assert!(js.iter().all(|j| !j.journey_ref.is_empty() && j.operating_day.len() == 10 && !j.operator_ref.is_empty()));
    assert_eq!(js.iter().filter(|j| j.cancelled).count(), 64);
    assert_eq!(js.iter().filter(|j| j.extra).count(), 280);
    assert_eq!(js.iter().flat_map(|j| &j.calls).filter(|c| c.extra_call).count(), 1182);
    assert_eq!(js.iter().flat_map(|j| &j.calls).filter(|c| c.cancelled).count(), 417);
    assert_eq!(js.iter().flat_map(|j| &j.calls).filter(|c| c.actual_dep.is_some()).count(), 18_566);
    // Calls come in travel order: recorded ones first.
    assert!(js.iter().all(|j| j.calls.windows(2).all(|w| w[0].recorded || !w[1].recorded)));
    // The target is "well under 1.5 s"; leave room for a busy machine and unoptimised test builds.
    if !cfg!(debug_assertions) {
        assert!(dt.as_secs_f64() < 1.5, "took {dt:?}");
    }
}

#[test]
fn gtfs_rt_sample_decodes() {
    let Some(data) = read("otd-gtfsrt/gtfs_rt.pb") else { return };
    let mut js: Vec<RtJourney> = Vec::new();
    let meta = parse_gtfs_rt(&data, |j| js.push(j)).unwrap();
    assert_eq!((meta.journeys, meta.timestamp, meta.feed_version.as_str()), (6699, 1_795_211_721, "20261118"));
    assert_eq!(js.iter().map(|j| j.calls.len()).sum::<usize>(), 89_981);
    assert_eq!(js.iter().filter(|j| j.extra).count(), 352);
    assert_eq!(js.iter().filter(|j| j.cancelled).count(), 69);
    assert_eq!(js.iter().flat_map(|j| &j.calls).filter(|c| c.cancelled).count(), 443);
    // The Swiss extension: original_trip_id in field 8 on all but the cancelled trips.
    assert_eq!(js.iter().filter(|j| !j.journey_ref.is_empty()).count(), 6630);
    assert!(js.iter().any(|j| j.journey_ref == "ch:1:sjyid:100001:733-001" && j.trip_id == ".ojp-91-1-D.1.TA.1063.j26"));
    assert!(js.iter().flat_map(|j| &j.calls).any(|c| c.arr_delay.is_some_and(|d| d < 0)));
}

#[test]
fn samples_match_the_timetable() {
    let (Some(siri), Some(pb)) = (read("otd-siriet/siri-et.xml"), read("otd-gtfsrt/gtfs_rt.pb")) else { return };
    let Some(tt) = timetable() else { return };
    let matcher = Matcher::new(&tt);

    // What the server does per poll.
    let t = Instant::now();
    let mut b = LiveSnapshotBuilder::with_capacity(8192);
    let c = b.add_siri_et(&tt, &matcher, &siri[..]).unwrap();
    let dt = t.elapsed();
    eprintln!("SIRI-ET parse + match + build: {:.0} ms, {:?}", dt.as_secs_f64() * 1e3, c);
    assert_eq!(c.journeys, 6812);
    assert!(c.matched() * 100 >= c.journeys * 97, "{c:?}");
    assert!(c.by_fallback > 1500 && c.by_journey_id > 4000, "{c:?}");
    if !cfg!(debug_assertions) {
        assert!(dt.as_secs_f64() < 3.0, "took {dt:?}");
    }
    let g = b.add_gtfs_rt(&tt, &matcher, &pb).unwrap();
    assert_eq!((g.journeys, g.by_trip_id), (6699, 6347), "every trip that is not ADDED matches by its id");
    let snap = b.build();
    assert!(snap.len() > 7000);
    assert!(snap.max_delay() <= matcher.options.max_delay);

    // Bern, 23:08 ICE 377 to Interlaken West: planned track 7, live track 5.
    // 23:12 S44 to Thun: planned 5, live 7. GTFS-RT shows neither.
    let mut js: Vec<RtJourney> = Vec::new();
    parse_siri_et(&siri[..], |j| js.push(j)).unwrap();
    for (journey_ref, from, to) in [("ch:1:sjyid:100001:377-002", "7", "5"), ("ch:1:sjyid:100015:16484-001", "5", "7")] {
        let j = js.iter().find(|j| j.journey_ref == journey_ref).unwrap();
        let m = matcher.apply(&tt, j).unwrap();
        assert_eq!(m.method, MatchMethod::JourneyId);
        let stops = tt.pattern_stops(tt.trips[m.trip as usize].pattern);
        let (p, planned, current) = m.platform_changes.iter().find(|c| tt.stations[tt.stops[stops[c.0 as usize] as usize].station as usize].name == "Bern").unwrap();
        assert_eq!((planned.as_str(), current.as_str()), (from, to));
        let quay = m.live.quay[*p as usize];
        assert_ne!(quay, NONE);
        assert_eq!(tt.stops[quay as usize].label, to);
        assert_eq!(tt.stops[quay as usize].station, tt.stops[stops[*p as usize] as usize].station);
        let live = snap.trip(m.date, m.trip).unwrap();
        assert_eq!(live.quay[*p as usize], quay, "SIRI-ET's platform survives the GTFS-RT merge");
        assert_eq!(snap.platform_changes(m.date, m.trip).len(), m.platform_changes.len());
    }

    // The fallback agrees with the trip id GTFS-RT states for the same journey:
    // SIRI "ch:1:ServiceJourney:801:x" is GTFS-RT "85:801:x".
    let mut by_ref = std::collections::HashMap::new();
    parse_gtfs_rt(&pb, |j| {
        if let Some((_, rest)) = j.journey_ref.split_once(':') {
            if !j.journey_ref.starts_with("ch:") {
                by_ref.insert((format!("ch:1:ServiceJourney:{rest}"), j.operating_day.clone()), j.trip_id.clone());
            }
        }
    })
    .unwrap();
    let (mut compared, mut same) = (0, 0);
    parse_siri_et(&siri[..], |j| {
        let Some(trip_id) = by_ref.get(&(j.journey_ref.clone(), j.operating_day.clone())) else { return };
        if let Some(m) = matcher.apply(&tt, &j) {
            if m.method == MatchMethod::Fallback {
                compared += 1;
                same += (tt.trip_gtfs_id(m.trip) == trip_id) as usize;
            }
        }
    })
    .unwrap();
    eprintln!("fallback cross-check: {same} of {compared} agree with GTFS-RT");
    assert!(compared > 1000 && same * 1000 >= compared * 995, "{same} of {compared}");
}
