//! Structural invariants every consumer of a `Timetable` relies on.

use anyhow::{bail, ensure, Result};
use kante_core::{Timetable, NONE};
use rayon::prelude::*;

/// Check the invariants of a `Timetable`:
/// - every index is in range and the cross references agree (stop ↔ station,
///   trip ↔ pattern, `stop_patterns` ↔ `pattern_stops`);
/// - trips of a pattern are contiguous in `trips`, their times contiguous in
///   `times`, in the same order;
/// - times never run backwards along a trip;
/// - no trip overtakes another inside a pattern (arrival and departure are
///   non-decreasing from trip to trip at every position);
/// - `continuations` and `official_transfers` are sorted as documented.
pub fn verify(tt: &Timetable) -> Result<()> {
    let (n_stops, n_stations, n_lines) = (tt.stops.len(), tt.stations.len(), tt.lines.len());
    let (n_pats, n_trips, n_strings) = (tt.patterns.len(), tt.trips.len(), tt.strings.len());

    ensure!(tt.strings.first().is_some_and(|s| s.is_empty()), "strings[0] must be the empty string");
    ensure!(tt.n_days > 0, "n_days is 0");
    ensure!(tt.service_words as usize == (tt.n_days as usize).div_ceil(64), "service_words does not match n_days");
    ensure!(tt.service_bits.len() % tt.service_words as usize == 0, "service_bits is not a multiple of service_words");
    let n_services = tt.service_bits.len() / tt.service_words as usize;
    let spare = tt.service_words as usize * 64 - tt.n_days as usize;
    if spare > 0 {
        let mask = !0u64 << (64 - spare);
        for s in 0..n_services {
            ensure!(tt.service_bits[(s + 1) * tt.service_words as usize - 1] & mask == 0, "service {s} has bits beyond n_days");
        }
    }

    for (i, l) in tt.lines.iter().enumerate() {
        ensure!((l.agency as usize) < tt.agencies.len(), "line {i}: agency {} out of range", l.agency);
    }

    // Stops and stations refer to each other, every stop exactly once.
    let mut seen = vec![false; n_stops];
    for (i, st) in tt.stations.iter().enumerate() {
        ensure!(!st.stops.is_empty(), "station {i} ({}) has no stops", st.name);
        for &s in &st.stops {
            ensure!((s as usize) < n_stops, "station {i}: stop {s} out of range");
            ensure!(tt.stops[s as usize].station as usize == i, "station {i}: stop {s} points to station {}", tt.stops[s as usize].station);
            ensure!(!seen[s as usize], "stop {s} is listed twice");
            seen[s as usize] = true;
        }
    }
    for (i, s) in tt.stops.iter().enumerate() {
        ensure!((s.station as usize) < n_stations, "stop {i}: station out of range");
        ensure!(seen[i], "stop {i} is not listed by its station");
        ensure!(!s.pos.is_none(), "stop {i} ({}) has no position", s.gtfs_id);
    }

    // Patterns tile `pattern_stops`, `trips` and `times` without gaps.
    ensure!(tt.pattern_flags.len() == tt.pattern_stops.len(), "pattern_flags and pattern_stops differ in length");
    let (mut stops_off, mut trips_off, mut times_off) = (0u64, 0u64, 0u64);
    for (p, pat) in tt.patterns.iter().enumerate() {
        ensure!(pat.n_stops >= 2, "pattern {p} has {} stops", pat.n_stops);
        ensure!(pat.n_trips >= 1, "pattern {p} has no trips");
        ensure!((pat.line as usize) < n_lines, "pattern {p}: line out of range");
        ensure!(pat.stops_off as u64 == stops_off, "pattern {p}: stops_off {} but expected {stops_off}", pat.stops_off);
        ensure!(pat.trips_off as u64 == trips_off, "pattern {p}: trips are not contiguous (trips_off {} expected {trips_off})", pat.trips_off);
        ensure!(pat.times_off == times_off, "pattern {p}: times are not contiguous (times_off {} expected {times_off})", pat.times_off);
        stops_off += pat.n_stops as u64;
        trips_off += pat.n_trips as u64;
        times_off += 2 * pat.n_stops as u64 * pat.n_trips as u64;
    }
    ensure!(stops_off == tt.pattern_stops.len() as u64, "pattern_stops has {} entries, patterns cover {stops_off}", tt.pattern_stops.len());
    ensure!(trips_off == n_trips as u64, "trips has {n_trips} entries, patterns cover {trips_off}");
    ensure!(times_off == tt.times.len() as u64, "times has {} entries, patterns cover {times_off}", tt.times.len());
    if let Some(&s) = tt.pattern_stops.iter().find(|&&s| s as usize >= n_stops) {
        bail!("pattern_stops contains stop {s}, out of range");
    }

    // Trips: back references, calendars, strings; times along and across trips.
    tt.patterns.par_iter().enumerate().try_for_each(|(p, pat)| -> Result<()> {
        let n = 2 * pat.n_stops as usize;
        let block = &tt.times[pat.times_off as usize..pat.times_off as usize + n * pat.n_trips as usize];
        for k in 0..pat.n_trips as usize {
            let ti = pat.trips_off as usize + k;
            let trip = &tt.trips[ti];
            ensure!(trip.pattern as usize == p, "trip {ti} lies in pattern {p} but says {}", trip.pattern);
            ensure!((trip.service as usize) < n_services, "trip {ti}: service out of range");
            for s in [trip.headsign, trip.short_name, trip.gtfs_id, trip.sjyid] {
                ensure!((s as usize) < n_strings, "trip {ti}: string index out of range");
            }
            let t = &block[k * n..(k + 1) * n];
            if let Some(i) = (1..n).find(|&i| t[i] < t[i - 1]) {
                bail!("trip {ti} ({}) runs backwards in time at position {}", tt.trip_gtfs_id(ti as u32), i / 2);
            }
            if k > 0 {
                let prev = &block[(k - 1) * n..k * n];
                if let Some(i) = (0..n).find(|&i| t[i] < prev[i]) {
                    bail!("pattern {p}: trip {ti} ({}) overtakes its predecessor at position {}", tt.trip_gtfs_id(ti as u32), i / 2);
                }
            }
        }
        Ok(())
    })?;

    // stop → (pattern, position) index.
    ensure!(tt.stop_pattern_off.len() == n_stops + 1, "stop_pattern_off must have stops + 1 entries");
    ensure!(tt.stop_pattern_off[0] == 0 && tt.stop_pattern_off[n_stops] as usize == tt.stop_patterns.len(), "stop_pattern_off does not span stop_patterns");
    ensure!(tt.stop_patterns.len() == tt.pattern_stops.len(), "stop_patterns must have one entry per pattern stop");
    for s in 0..n_stops {
        ensure!(tt.stop_pattern_off[s] <= tt.stop_pattern_off[s + 1], "stop_pattern_off decreases at stop {s}");
        for &(p, pos) in tt.stop_patterns(s as u32) {
            ensure!((p as usize) < n_pats && pos < tt.patterns[p as usize].n_stops, "stop {s}: (pattern {p}, position {pos}) out of range");
            ensure!(tt.pattern_stops(p)[pos as usize] as usize == s, "stop {s}: pattern {p} position {pos} is another stop");
        }
    }

    for (i, c) in tt.continuations.iter().enumerate() {
        ensure!((c.from as usize) < n_trips && (c.to as usize) < n_trips, "continuation {i}: trip out of range");
        ensure!(c.service == NONE || (c.service as usize) < n_services, "continuation {i}: service out of range");
        ensure!(i == 0 || tt.continuations[i - 1].from <= c.from, "continuations are not sorted by `from` at {i}");
    }
    for (i, o) in tt.official_transfers.iter().enumerate() {
        ensure!((o.from as usize) < n_stops && (o.to as usize) < n_stops, "official transfer {i}: stop out of range");
        if i > 0 {
            let prev = &tt.official_transfers[i - 1];
            ensure!((prev.from, prev.to) < (o.from, o.to), "official_transfers not strictly sorted by (from, to) at {i}");
        }
    }
    Ok(())
}
