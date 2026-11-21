//! Joining live journeys to the static timetable.
//!
//! A feed names a journey by an id and an operating day, and its stops by
//! references that are sometimes a boarding point, sometimes the whole stop.
//! [`Matcher::apply`] turns one [`RtJourney`] into a [`MatchedTrip`]:
//!
//! 1. **Find the trip.**
//!    - GTFS-RT: `trip_id` is the static trip id.
//!    - Journey id (`ch:1:sjyid:…`): several static trips can share one id
//!      (one per calendar variant), so every trip with that id that runs on
//!      the operating day (± 1 day, for feeds that count after-midnight runs
//!      differently) is aligned against the calls and the best fit wins.
//!    - Fallback for operators whose live ids are not in the timetable (29 %
//!      of the national SIRI-ET sample, e.g. `ch:1:ServiceJourney:801:…` from
//!      PostAuto): trips that leave the journey's first stop at its aimed
//!      time are looked up through `stop_patterns`, and one is accepted when
//!      the stop sequence and the aimed times fit.
//! 2. **Align calls to stop positions** by station and scheduled time. Order
//!    numbers are not used: they differ between feeds and the timetable.
//!    Extra calls and calls at unknown stops stay unaligned; positions without
//!    a call inherit the last known delay.
//! 3. **Build the overlay**: delays relative to the *timetable's* scheduled
//!    times (so `scheduled + delay` is exactly the live time), skipped stops,
//!    the last measured position, and the boarding point in use when it
//!    differs from the planned one.

use crate::model::{RtCall, RtJourney};
use kante_core::time::{self, Date};
use kante_core::{Precision, StationIdx, StopIdx, Timetable, TripIdx, TripLive, NONE};
use std::collections::HashMap;

/// How a journey was tied to its trip.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MatchMethod {
    /// GTFS-RT `trip_id` = static `trip_id`.
    TripId,
    /// Swiss journey id (`original_trip_id`) + operating day.
    JourneyId,
    /// Stop sequence + aimed times (+ line name).
    Fallback,
}

/// Why a journey could not be matched.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Unmatched {
    /// Operating day missing or unreadable, or outside the timetable.
    BadDay,
    /// An extra journey: not in the timetable by definition.
    Extra,
    /// None of its stops is known to the timetable.
    NoStops,
    /// The id is known, but no trip with it runs that day with these stops,
    /// and the fallback found nothing either.
    IdDoesNotFit,
    /// Unknown id and no trip with these stops and times.
    NotFound,
}

#[derive(Clone, Debug)]
pub struct MatchedTrip {
    pub date: Date,
    pub trip: TripIdx,
    pub live: TripLive,
    /// `(position, planned, current)` platform text wherever the live platform
    /// differs from the planned one, whether or not it could be resolved to a
    /// Stop (`live.quay[pos]`). `planned` is empty when the timetable has no
    /// label for the stop.
    pub platform_changes: Vec<(u16, String, String)>,

    // ---- additions beyond the contract ----
    pub method: MatchMethod,
    /// Calls of the journey (including extra calls).
    pub calls: u16,
    /// Of those, calls aligned to a stop position.
    pub aligned: u16,
    /// Of those, calls whose aimed time equals the timetable's (± [`MatchOptions::time_tolerance`]).
    pub on_schedule: u16,
    /// Reported times that were dropped as implausible (see [`MatchOptions::max_delay`]).
    pub implausible: u16,
}

#[derive(Clone, Copy, Debug)]
pub struct MatchOptions {
    /// An aimed time within this many seconds of the timetable time counts as
    /// "the same stop event". The timetable is rounded to minutes, live aimed
    /// times are not.
    pub time_tolerance: i64,
    /// A call may be aligned to a position at the right station whose
    /// scheduled time is at most this far off (operating-day plan vs. annual plan).
    pub max_time_offset: i64,
    /// Share of a journey's calls that must fit for a fallback match.
    pub fallback_min_share: f32,
    /// Delays outside `-max_early ..= max_delay` seconds are treated as "no
    /// data": the national feed contains stale journeys "8 h late" and
    /// forecasts a whole day off.
    pub max_delay: i32,
    pub max_early: i32,
    /// Take a live stop reference to *another* boarding point of the station
    /// as a change of boarding point even when no platform name says so.
    /// Some operators' live systems consistently name another edge than the
    /// timetable does (measured: about 1 % of bus calls, see the report), and
    /// offline there is no telling which side is right. With `false` only
    /// platform names and references that refine a stop-level plan are used.
    pub trust_stop_refs: bool,
}

impl Default for MatchOptions {
    fn default() -> Self {
        MatchOptions { time_tolerance: 90, max_time_offset: 1800, fallback_min_share: 0.8, max_delay: 3 * 3600, max_early: 1800, trust_stop_refs: true }
    }
}

/// FNV-1a over the ASCII-lowercased bytes (the static feed has both
/// `ch:1:sjyid:` and `CH:1:sjyid:`).
fn hash_ci(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in s.as_bytes() {
        h ^= b.to_ascii_lowercase() as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

#[inline]
fn hash32(s: &str) -> u32 {
    let h = hash_ci(s);
    (h ^ (h >> 32)) as u32
}

/// String → indices without storing the strings: `(hash, index)` pairs sorted
/// by hash (8 bytes per entry; the national timetable has 2.7 million trips).
/// A hit is confirmed against the timetable's own string.
#[derive(Default)]
struct StrIndex {
    entries: Vec<(u32, u32)>,
}

impl StrIndex {
    fn build(mut entries: Vec<(u32, u32)>) -> Self {
        entries.sort_unstable();
        entries.dedup();
        StrIndex { entries }
    }
    #[inline]
    fn candidates(&self, key: &str) -> impl Iterator<Item = u32> + '_ {
        let h = hash32(key);
        let lo = self.entries.partition_point(|e| e.0 < h);
        self.entries[lo..].iter().take_while(move |e| e.0 == h).map(|e| e.1)
    }
}

/// The number after `ch:1:sloid:` (the service point), if `s` is a SLOID.
fn sloid_number(s: &str) -> Option<u32> {
    let b = s.as_bytes();
    const P: &[u8] = b"ch:1:sloid:";
    if b.len() <= P.len() || !b[..P.len()].eq_ignore_ascii_case(P) {
        return None;
    }
    let digits = &s[P.len()..];
    let end = digits.bytes().position(|c| !c.is_ascii_digit()).unwrap_or(digits.len());
    if end == 0 || end > 9 {
        return None;
    }
    digits[..end].parse().ok()
}

/// A trailing all-digit component: `8507000`, `ch:1:ScheduledStopPoint:8301318`.
fn trailing_number(s: &str) -> Option<u32> {
    let tail = s.rsplit(':').next()?;
    if tail.is_empty() || tail.len() > 9 || !tail.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    tail.parse().ok()
}

#[inline]
fn eq_label(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// A platform label reduced to what distinguishes it: lower case, no blanks,
/// no generic word in front ("Kante B" → "b", "6 Süd" → "6süd").
fn norm_label(s: &str) -> String {
    let n: String = s.chars().filter(|c| !c.is_whitespace()).flat_map(char::to_lowercase).collect();
    for word in ["kante", "gleis", "steig", "perron", "quai", "voie", "binario", "platform"] {
        if let Some(rest) = n.strip_prefix(word) {
            if !rest.is_empty() {
                return rest.to_string();
            }
        }
    }
    n
}

/// Do two platform texts name the same place? Equal after [`norm_label`], or
/// one is a double platform ("41/42") that includes the other ("42").
fn same_platform(a: &str, b: &str) -> bool {
    let (a, b) = (norm_label(a), norm_label(b));
    if a == b {
        return true;
    }
    if a.is_empty() || b.is_empty() {
        return false;
    }
    a.split('/').any(|part| part == b) || b.split('/').any(|part| part == a)
}

/// "12A-C" → ("12", "A-C"), "2CD" → ("2", "CD"); "A", "B2", "41/42" stay whole.
fn split_platform(name: &str) -> (&str, &str) {
    let name = name.trim();
    let digits = name.bytes().take_while(u8::is_ascii_digit).count();
    let rest = &name[digits..];
    if digits > 0 && !rest.is_empty() && rest.bytes().all(|c| c.is_ascii_uppercase() || c == b'-') {
        (&name[..digits], rest)
    } else {
        (name, "")
    }
}

fn norm_line(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).flat_map(char::to_lowercase).collect()
}

/// Platform text as printed in the timetable: label plus sectors ("12A-C").
fn planned_text(tt: &Timetable, s: StopIdx) -> String {
    let st = &tt.stops[s as usize];
    format!("{}{}", st.label, st.sectors)
}

/// A vehicle standing at a stop is reported twice by SIRI-ET: as the last
/// `RecordedCall` (with the measured arrival) and as the first `EstimatedCall`
/// (with the expected departure), both with the same stop and visit number.
/// Returns the calls with such pairs merged, or `None` if there are none.
fn merge_split_calls(calls: &[RtCall]) -> Option<Vec<RtCall>> {
    let split = |a: &RtCall, b: &RtCall| a.recorded && !b.recorded && a.order == b.order && a.stop_ref == b.stop_ref;
    if !calls.windows(2).any(|w| split(&w[0], &w[1])) {
        return None;
    }
    let mut out: Vec<RtCall> = Vec::with_capacity(calls.len());
    for c in calls {
        match out.last_mut() {
            Some(prev) if split(prev, c) => {
                prev.aimed_arr = prev.aimed_arr.or(c.aimed_arr);
                prev.expected_arr = prev.expected_arr.or(c.expected_arr);
                prev.actual_arr = prev.actual_arr.or(c.actual_arr);
                prev.aimed_dep = prev.aimed_dep.or(c.aimed_dep);
                prev.expected_dep = prev.expected_dep.or(c.expected_dep);
                prev.actual_dep = prev.actual_dep.or(c.actual_dep);
                // The estimate is the newer statement about the platform.
                if !c.platform.is_empty() {
                    prev.platform = c.platform.clone();
                }
                if prev.arr_platform.is_empty() {
                    prev.arr_platform = c.arr_platform.clone();
                }
                if !c.quay_ref.is_empty() {
                    prev.quay_ref = c.quay_ref.clone();
                }
                prev.cancelled |= c.cancelled;
                prev.extra_call |= c.extra_call;
            }
            _ => out.push(c.clone()),
        }
    }
    Some(out)
}

#[derive(Clone, Copy)]
struct CallInfo {
    station: StationIdx,
    /// Aimed departure, else aimed arrival; 0 when the feed has no aimed time.
    aimed: i64,
    aimed_is_dep: bool,
    extra: bool,
}

#[derive(Clone, Copy, Default, PartialEq, PartialOrd)]
struct Score {
    on_schedule: u32,
    aligned: u32,
}

struct Candidate {
    trip: TripIdx,
    date: Date,
    score: Score,
    /// Call index per stop position, `u32::MAX` where none.
    pos_call: Vec<u32>,
}

pub struct Matcher {
    sjyid: StrIndex,
    trip_id: StrIndex,
    /// Stop.sloid and Stop.gtfs_id → StopIdx.
    stop_ref: StrIndex,
    /// SLOID service-point number → station, learnt from the timetable's stops.
    sloid_station: HashMap<u32, StationIdx>,
    /// DiDok number → station.
    didok_station: HashMap<u32, StationIdx>,
    pub options: MatchOptions,
}

impl Matcher {
    pub fn new(tt: &Timetable) -> Self {
        Self::with_options(tt, MatchOptions::default())
    }

    pub fn with_options(tt: &Timetable, options: MatchOptions) -> Self {
        let mut sj = Vec::with_capacity(tt.trips.len());
        let mut ti = Vec::with_capacity(tt.trips.len());
        // Trips of one pattern usually share few distinct strings, but ids
        // are unique per trip: hash each once.
        for (i, t) in tt.trips.iter().enumerate() {
            let s = tt.str(t.sjyid);
            if !s.is_empty() {
                sj.push((hash32(s), i as u32));
            }
            let g = tt.str(t.gtfs_id);
            if !g.is_empty() {
                ti.push((hash32(g), i as u32));
            }
        }
        let mut sr = Vec::with_capacity(tt.stops.len() * 2);
        let mut sloid_station = HashMap::new();
        let mut didok_station = HashMap::new();
        for (i, st) in tt.stations.iter().enumerate() {
            if st.didok != 0 {
                didok_station.entry(st.didok).or_insert(i as StationIdx);
            }
        }
        for (i, s) in tt.stops.iter().enumerate() {
            if !s.sloid.is_empty() {
                sr.push((hash32(&s.sloid), i as u32));
                if let Some(n) = sloid_number(&s.sloid) {
                    sloid_station.entry(n).or_insert(s.station);
                } else if let Some(n) = trailing_number(&s.sloid) {
                    didok_station.entry(n).or_insert(s.station);
                }
            }
            if !s.gtfs_id.is_empty() && s.gtfs_id != s.sloid {
                sr.push((hash32(&s.gtfs_id), i as u32));
            }
        }
        Matcher {
            sjyid: StrIndex::build(sj),
            trip_id: StrIndex::build(ti),
            stop_ref: StrIndex::build(sr),
            sloid_station,
            didok_station,
            options,
        }
    }

    /// Stops whose SLOID or GTFS id is exactly `r`.
    pub fn stops_of_ref<'a>(&'a self, tt: &'a Timetable, r: &'a str) -> impl Iterator<Item = StopIdx> + 'a {
        self.stop_ref.candidates(r).filter(move |&s| {
            let st = &tt.stops[s as usize];
            st.sloid.eq_ignore_ascii_case(r) || st.gtfs_id.eq_ignore_ascii_case(r)
        })
    }

    /// The station a stop reference belongs to: a boarding point's or a stop's
    /// SLOID, a GTFS stop id, a DiDok number or `…:ScheduledStopPoint:<didok>`.
    pub fn station_of_ref(&self, tt: &Timetable, r: &str) -> Option<StationIdx> {
        if r.is_empty() {
            return None;
        }
        if let Some(s) = self.stops_of_ref(tt, r).next() {
            return Some(tt.stops[s as usize].station);
        }
        if let Some(n) = sloid_number(r) {
            // The service-point number of a Swiss SLOID is the DiDok number
            // without the country prefix 85.
            return self.sloid_station.get(&n).or_else(|| self.didok_station.get(&(8_500_000 + n))).copied();
        }
        let n = trailing_number(r)?;
        self.didok_station.get(&n).copied()
    }

    /// Trips carrying this Swiss journey id.
    pub fn trips_of_journey<'a>(&'a self, tt: &'a Timetable, journey_ref: &'a str) -> impl Iterator<Item = TripIdx> + 'a {
        self.sjyid.candidates(journey_ref).filter(move |&t| tt.str(tt.trips[t as usize].sjyid).eq_ignore_ascii_case(journey_ref))
    }

    pub fn trip_of_gtfs_id(&self, tt: &Timetable, trip_id: &str) -> Option<TripIdx> {
        self.trip_id.candidates(trip_id).find(|&t| tt.trip_gtfs_id(t).eq_ignore_ascii_case(trip_id))
    }

    /// Align the calls to the stop positions of `trip` running on `date`.
    ///
    /// Pass 1 takes, in order, every call whose station and aimed time equal a
    /// later stop position (feeds without aimed times: the station alone).
    /// Pass 2 places the remaining calls between their aligned neighbours at a
    /// position of the right station whose time is merely close: the plan of
    /// the day can differ from the annual timetable by a few minutes.
    fn align(&self, tt: &Timetable, trip: TripIdx, date: Date, calls: &[CallInfo]) -> Candidate {
        let pattern = tt.trips[trip as usize].pattern;
        let stops = tt.pattern_stops(pattern);
        let times = tt.trip_times(trip);
        let base = time::service_day_start_unix(date);
        let n = stops.len();
        let station = |p: usize| tt.stops[stops[p] as usize].station;
        let diff = |p: usize, c: &CallInfo| (base + times[2 * p + c.aimed_is_dep as usize] as i64 - c.aimed).abs();
        let mut call_pos = vec![u32::MAX; calls.len()];
        let mut score = Score::default();

        let mut cursor = 0usize;
        for (ci, c) in calls.iter().enumerate() {
            // A call flagged "extra" is extra relative to the operating-day
            // plan; diverted runs flag stops the timetable does have. Such a
            // call is taken for a scheduled stop only if its time says so.
            if c.station == NONE || (c.extra && c.aimed == 0) {
                continue;
            }
            let fits = |p: &usize| station(*p) == c.station && (c.aimed == 0 || diff(*p, c) <= self.options.time_tolerance);
            if let Some(p) = (cursor..n).find(fits) {
                call_pos[ci] = p as u32;
                cursor = p + 1;
                score.aligned += 1;
                score.on_schedule += (c.aimed != 0) as u32;
            }
        }

        if (score.aligned as usize) < calls.len() {
            // Position of the next aligned call after each call.
            let mut next = vec![n; calls.len()];
            let mut hi = n;
            for ci in (0..calls.len()).rev() {
                next[ci] = hi;
                if call_pos[ci] != u32::MAX {
                    hi = call_pos[ci] as usize;
                }
            }
            let mut lo = 0usize;
            for (ci, c) in calls.iter().enumerate() {
                if call_pos[ci] != u32::MAX {
                    lo = call_pos[ci] as usize + 1;
                    continue;
                }
                if c.station == NONE || c.extra || c.aimed == 0 {
                    continue;
                }
                let best = (lo..next[ci]).filter(|&p| station(p) == c.station).map(|p| (diff(p, c), p)).min();
                if let Some((d, p)) = best {
                    if d <= self.options.max_time_offset {
                        call_pos[ci] = p as u32;
                        lo = p + 1;
                        score.aligned += 1;
                    }
                }
            }
        }

        let mut pos_call = vec![u32::MAX; n];
        for (ci, &p) in call_pos.iter().enumerate() {
            if p != u32::MAX {
                pos_call[p as usize] = ci as u32;
            }
        }
        Candidate { trip, date, score, pos_call }
    }

    fn call_infos(&self, tt: &Timetable, rt_calls: &[RtCall]) -> Vec<CallInfo> {
        rt_calls
            .iter()
            .map(|c| {
                let station = self.station_of_ref(tt, &c.stop_ref).unwrap_or(NONE);
                let (aimed, aimed_is_dep) = match (c.aimed_dep, c.aimed_arr) {
                    (Some(t), _) => (t, true),
                    (None, Some(t)) => (t, false),
                    (None, None) => (0, true),
                };
                CallInfo { station, aimed, aimed_is_dep, extra: c.extra_call }
            })
            .collect()
    }

    /// Trips that call at the station of call `anchor` at its aimed time.
    fn fallback_candidates(&self, tt: &Timetable, calls: &[CallInfo], anchor: usize, out: &mut Vec<(TripIdx, Date)>) {
        let c = &calls[anchor];
        let (day, _) = time::from_unix(c.aimed);
        let tol = self.options.time_tolerance as i32;
        // The same instant is "00:25 today" and "24:25 yesterday".
        for date in [day, day - 1] {
            if date < tt.start_date || date > tt.end_date() {
                continue;
            }
            let secs = (c.aimed - time::service_day_start_unix(date)) as i32;
            for &stop in &tt.stations[c.station as usize].stops {
                for &(pat, pos) in tt.stop_patterns(stop) {
                    let p = &tt.patterns[pat as usize];
                    let n = 2 * p.n_stops as usize;
                    let col = p.times_off as usize + 2 * pos as usize + c.aimed_is_dep as usize;
                    // Trips of a pattern do not overtake: the column is sorted.
                    let at = |k: usize| tt.times[col + k * n];
                    let (mut lo, mut hi) = (0usize, p.n_trips as usize);
                    while lo < hi {
                        let mid = (lo + hi) / 2;
                        if at(mid) < secs - tol {
                            lo = mid + 1;
                        } else {
                            hi = mid;
                        }
                    }
                    let mut k = lo;
                    while k < p.n_trips as usize && at(k) <= secs + tol {
                        let t = p.trips_off + k as u32;
                        if tt.trip_active(t, date) {
                            out.push((t, date));
                        }
                        k += 1;
                    }
                }
            }
        }
    }

    /// Match one journey and build its overlay; `None` when it cannot be tied
    /// to a trip of the timetable (see [`Matcher::explain`] for the reason).
    pub fn apply(&self, tt: &Timetable, j: &RtJourney) -> Option<MatchedTrip> {
        self.explain(tt, j).ok()
    }

    /// Like [`Matcher::apply`], with the reason for a miss.
    pub fn explain(&self, tt: &Timetable, j: &RtJourney) -> Result<MatchedTrip, Unmatched> {
        let day = time::parse_date(&j.operating_day).ok_or(Unmatched::BadDay)?;
        if day < tt.start_date - 1 || day > tt.end_date() + 1 {
            return Err(Unmatched::BadDay);
        }
        let merged = merge_split_calls(&j.calls);
        let rt_calls: &[RtCall] = merged.as_deref().unwrap_or(&j.calls);
        let calls = self.call_infos(tt, rt_calls);
        let n_calls = calls.len() as u32;
        let n_known = calls.iter().filter(|c| !c.extra && c.station != NONE).count() as u32;
        let has_times = calls.iter().any(|c| c.aimed != 0);

        // 1. Static trip id (GTFS-RT).
        if !j.trip_id.is_empty() {
            if let Some(t) = self.trip_of_gtfs_id(tt, &j.trip_id) {
                if tt.trip_active(t, day) {
                    let cand = self.align(tt, t, day, &calls);
                    if n_calls == 0 || cand.score.aligned > 0 {
                        return Ok(self.overlay(tt, j, rt_calls, &cand, MatchMethod::TripId, n_calls));
                    }
                }
            }
        }

        // 2. Journey id + operating day.
        let mut id_known = false;
        if !j.journey_ref.is_empty() && (has_times || !j.extra) {
            let mut best: Option<Candidate> = None;
            let mut on_day = (0u32, NONE);
            for t in self.trips_of_journey(tt, &j.journey_ref) {
                id_known = true;
                for date in [day, day - 1, day + 1] {
                    if !tt.trip_active(t, date) {
                        continue;
                    }
                    if date == day {
                        on_day = (on_day.0 + 1, t);
                    }
                    let cand = self.align(tt, t, date, &calls);
                    // Earlier candidates win ties: the stated day before its neighbours.
                    if best.as_ref().is_none_or(|b| cand.score > b.score) {
                        best = Some(cand);
                    }
                }
            }
            if let Some(b) = best {
                let fits = if has_times { b.score.on_schedule > 0 } else { b.score.aligned > 0 };
                if fits {
                    return Ok(self.overlay(tt, j, rt_calls, &b, MatchMethod::JourneyId, n_calls));
                }
                // A journey without usable calls (typically a cancellation
                // without stop list): unambiguous when exactly one trip with
                // this id runs that day.
                if n_known == 0 && on_day.0 == 1 {
                    let cand = self.align(tt, on_day.1, day, &calls);
                    return Ok(self.overlay(tt, j, rt_calls, &cand, MatchMethod::JourneyId, n_calls));
                }
            }
        }

        // 3. Stop sequence and aimed times.
        if j.extra {
            return Err(Unmatched::Extra);
        }
        if n_known == 0 && n_calls > 0 && !id_known {
            return Err(Unmatched::NoStops);
        }
        if has_times && n_known >= 2 {
            let usable = |c: &CallInfo| !c.extra && c.station != NONE && c.aimed != 0;
            // Anchors: where the run starts, where it ends, and one stop in
            // between for runs whose ends the timetable does not have.
            let idx: Vec<usize> = (0..calls.len()).filter(|&i| usable(&calls[i])).collect();
            let anchors = [idx.first().copied(), idx.last().copied(), idx.get(idx.len() / 2).copied()];
            let line = norm_line(&j.line_name);
            let need = ((n_known as f32 * self.options.fallback_min_share).ceil() as u32).max(2);
            let mut pairs: Vec<(TripIdx, Date)> = Vec::new();
            for anchor in anchors.into_iter().flatten() {
                pairs.clear();
                self.fallback_candidates(tt, &calls, anchor, &mut pairs);
                pairs.sort_unstable();
                pairs.dedup();
                let mut best: Option<(bool, Candidate)> = None;
                for &(t, date) in &pairs {
                    let cand = self.align(tt, t, date, &calls);
                    if cand.score.on_schedule < need {
                        continue;
                    }
                    let same_line = !line.is_empty() && norm_line(&tt.trip_line(t).name) == line;
                    // Without the line name as a second witness the whole run must fit.
                    let n_stops = tt.patterns[tt.trips[t as usize].pattern as usize].n_stops as u32;
                    if !same_line && !(cand.score.on_schedule >= n_known && n_stops == cand.score.on_schedule) {
                        continue;
                    }
                    if best.as_ref().is_none_or(|(l, b)| (same_line, cand.score) > (*l, b.score)) {
                        best = Some((same_line, cand));
                    }
                }
                if let Some((_, b)) = best {
                    return Ok(self.overlay(tt, j, rt_calls, &b, MatchMethod::Fallback, n_calls));
                }
            }
        }
        Err(if id_known { Unmatched::IdDoesNotFit } else { Unmatched::NotFound })
    }

    /// Boarding point of `station` that the platform name `name` refers to.
    fn stop_by_label(&self, tt: &Timetable, station: StationIdx, planned: StopIdx, name: &str) -> Option<StopIdx> {
        let (label, sectors) = split_platform(name);
        let modes = tt.stops[planned as usize].modes;
        let mut best: Option<(u32, StopIdx)> = None;
        for &s in &tt.stations[station as usize].stops {
            let st = &tt.stops[s as usize];
            if st.label.is_empty() {
                continue;
            }
            let whole = same_platform(&st.label, name) && st.sectors.is_empty();
            let split = same_platform(&st.label, label);
            if !whole && !split {
                continue;
            }
            // Prefer: the label itself rather than a double platform containing
            // it, the same sectors, a point served by the same kind of
            // vehicle, a boarding point with its own coordinate.
            let mut rank = 0;
            if norm_label(&st.label) == norm_label(name) || norm_label(&st.label) == norm_label(label) {
                rank += 8;
            }
            if whole || eq_label(&st.sectors, sectors) {
                rank += 4;
            }
            if modes == 0 || st.modes & modes != 0 {
                rank += 2;
            }
            if st.precision == Precision::Edge {
                rank += 1;
            }
            if best.is_none_or(|(r, _)| rank > r) {
                best = Some((rank, s));
            }
        }
        best.map(|(_, s)| s)
    }

    /// Where the live data says the vehicle stops, if not at `planned`.
    /// Returns `(resolved stop or NONE, planned text, current text)`.
    ///
    /// The stop reference decides about the *place*: a reference to the planned
    /// boarding point confirms it even if the feed uses another name for it
    /// (operators' letters and the registry's do not always agree), and a
    /// reference to another boarding point of the station is a change. Only
    /// where the reference is at stop level (all of rail) does the platform
    /// name decide, looked up among the labels of the station.
    fn platform_change(&self, tt: &Timetable, planned: StopIdx, c: &RtCall) -> Option<(StopIdx, String, String)> {
        let ps = &tt.stops[planned as usize];
        let name = c.platform.trim();
        let r = if c.quay_ref.is_empty() { c.stop_ref.as_str() } else { c.quay_ref.as_str() };
        let mut confirmed = false;
        let mut other = None;
        for s in self.stops_of_ref(tt, r) {
            let st = &tt.stops[s as usize];
            // A stop-level reference says nothing about the boarding point.
            if st.precision == Precision::Station || st.station != ps.station {
                continue;
            }
            if s == planned {
                confirmed = true;
            } else if other.is_none() {
                other = Some(s);
            }
        }
        if confirmed {
            // Same place. If the plan has no sign text, pass on the feed's.
            return (ps.label.is_empty() && !name.is_empty()).then(|| (NONE, String::new(), name.to_string()));
        }
        // An unnamed edge-to-edge difference is the doubtful case.
        let doubtful = name.is_empty() && ps.precision != Precision::Station;
        if let Some(s) = other.filter(|_| self.options.trust_stop_refs || !doubtful) {
            let st = &tt.stops[s as usize];
            // Same sign, another registry entry (sector variants of one track): not a change.
            if !ps.label.is_empty() && same_platform(&st.label, &ps.label) && eq_label(&st.sectors, &ps.sectors) {
                return None;
            }
            let current = if name.is_empty() { planned_text(tt, s) } else { name.to_string() };
            return Some((s, planned_text(tt, planned), current));
        }
        if name.is_empty() {
            return None;
        }
        let (label, sectors) = split_platform(name);
        let same_track = !ps.label.is_empty() && (same_platform(&ps.label, name) || same_platform(&ps.label, label));
        let same_sectors = sectors.is_empty() || ps.sectors.is_empty() || eq_label(&ps.sectors, sectors) || same_platform(&ps.label, name);
        if same_track && same_sectors {
            return None;
        }
        let found = self.stop_by_label(tt, ps.station, planned, name).filter(|&s| s != planned);
        if same_track {
            // Only the sectors differ: a change only if that exact variant exists.
            let s = found.filter(|&s| eq_label(&tt.stops[s as usize].sectors, sectors))?;
            return Some((s, planned_text(tt, planned), name.to_string()));
        }
        Some((found.unwrap_or(NONE), planned_text(tt, planned), name.to_string()))
    }

    fn overlay(&self, tt: &Timetable, j: &RtJourney, rt_calls: &[RtCall], cand: &Candidate, method: MatchMethod, n_calls: u32) -> MatchedTrip {
        let trip = cand.trip;
        let stops = tt.pattern_stops(tt.trips[trip as usize].pattern);
        let times = tt.trip_times(trip);
        let base = time::service_day_start_unix(cand.date);
        let n = stops.len();
        let mut live = TripLive {
            cancelled: j.cancelled,
            arr_delay: vec![0; n],
            dep_delay: vec![0; n],
            skipped: Vec::new(),
            quay: Vec::new(),
            observed_pos: -1,
            updated_at: j.recorded_at,
        };
        let mut changes = Vec::new();
        let mut implausible = 0u16;
        let plausible = -self.options.max_early..=self.options.max_delay;
        let mut carry: Option<i32> = None;
        // Latest live time so far, to keep the overlay free of time travel.
        let mut prev = i64::MIN;
        for p in 0..n {
            let sched_arr = base + times[2 * p] as i64;
            let sched_dep = base + times[2 * p + 1] as i64;
            let (mut arr, mut dep) = (None, None);
            if cand.pos_call[p] != u32::MAX {
                let c = &rt_calls[cand.pos_call[p] as usize];
                if c.cancelled {
                    if live.skipped.is_empty() {
                        live.skipped = vec![false; n];
                    }
                    live.skipped[p] = true;
                } else if !c.no_data {
                    let mut delay = |actual: Option<i64>, expected: Option<i64>, rel: Option<i32>, sched: i64| {
                        let d = actual.or(expected).map(|t| (t - sched).clamp(-1_000_000, 1_000_000) as i32).or(rel)?;
                        if plausible.contains(&d) {
                            Some(d)
                        } else {
                            implausible += 1;
                            None
                        }
                    };
                    arr = delay(c.actual_arr, c.expected_arr, c.arr_delay, sched_arr);
                    dep = delay(c.actual_dep, c.expected_dep, c.dep_delay, sched_dep);
                    if (c.actual_arr.is_some() && arr.is_some()) || (c.actual_dep.is_some() && dep.is_some()) {
                        live.observed_pos = p as i16;
                    }
                }
                if !c.cancelled && !j.cancelled {
                    if let Some((stop, planned, current)) = self.platform_change(tt, stops[p], c) {
                        if stop != NONE {
                            if live.quay.is_empty() {
                                live.quay = vec![NONE; n];
                            }
                            live.quay[p] = stop;
                        }
                        if !same_platform(&planned, &current) {
                            changes.push((p as u16, planned, current));
                        }
                    }
                }
            }
            // Arrival: reported, else as late as the vehicle was last known to be.
            let mut a = arr.or(carry).unwrap_or(0);
            if sched_arr + (a as i64) < prev {
                a = (prev - sched_arr) as i32;
            }
            prev = sched_arr + a as i64;
            if arr.is_some() {
                carry = arr;
            }
            // Departure: reported, else the carried delay, but never early on a guess.
            let mut d = dep.or(carry.map(|c| c.max(0))).unwrap_or(0);
            if sched_dep + (d as i64) < prev {
                d = (prev - sched_dep) as i32;
            }
            prev = sched_dep + d as i64;
            if dep.is_some() {
                carry = dep;
            }
            live.arr_delay[p] = a;
            live.dep_delay[p] = d;
        }
        MatchedTrip {
            date: cand.date,
            trip,
            live,
            platform_changes: changes,
            method,
            calls: n_calls.min(u16::MAX as u32) as u16,
            aligned: cand.score.aligned.min(u16::MAX as u32) as u16,
            on_schedule: cand.score.on_schedule.min(u16::MAX as u32) as u16,
            implausible,
        }
    }
}

#[cfg(test)]
pub(crate) mod testkit {
    //! A hand-built timetable around Bern for the matcher and snapshot tests.
    use kante_core::time::{parse_date, parse_hms};
    use kante_core::*;

    pub struct Tb {
        pub tt: Timetable,
    }

    pub fn day(s: &str) -> time::Date {
        parse_date(s).unwrap()
    }

    impl Tb {
        pub fn new() -> Self {
            let mut tt = Timetable { feed_version: "test".into(), start_date: day("2026-11-01"), n_days: 60, service_words: 1, ..Default::default() };
            tt.strings.push(String::new());
            tt.agencies.push(Agency { gtfs_id: "11".into(), name: "SBB".into() });
            Tb { tt }
        }
        pub fn station(&mut self, name: &str, didok: u32) -> StationIdx {
            self.tt.stations.push(Station {
                gtfs_id: format!("Parent{didok}"),
                name: name.into(),
                pos: Default::default(),
                didok,
                stops: vec![],
                weight: 1,
                modes: 0,
            });
            self.tt.stations.len() as u32 - 1
        }
        pub fn stop(&mut self, station: StationIdx, sloid: &str, label: &str, sectors: &str, precision: Precision) -> StopIdx {
            let i = self.tt.stops.len() as u32;
            self.tt.stops.push(Stop {
                gtfs_id: if sectors.is_empty() { sloid.to_string() } else { format!("{sloid}_gen:{sloid}_pf:{label}{sectors}") },
                sloid: sloid.into(),
                station,
                pos: Default::default(),
                label: label.into(),
                sectors: sectors.into(),
                precision,
                compass: -1,
                access: QuayAccess::Unknown,
                modes: 0,
            });
            self.tt.stations[station as usize].stops.push(i);
            i
        }
        pub fn line(&mut self, name: &str, mode: Mode) -> LineIdx {
            self.tt.lines.push(Line { gtfs_route_id: name.into(), name: name.into(), category: String::new(), mode, route_type: 0, agency: 0 });
            self.tt.lines.len() as u32 - 1
        }
        /// A calendar running on the given days.
        pub fn service(&mut self, days: &[&str]) -> ServiceIdx {
            let mut w = 0u64;
            for d in days {
                w |= 1 << (day(d) - self.tt.start_date);
            }
            self.tt.service_bits.push(w);
            self.tt.service_bits.len() as u32 - 1
        }
        fn intern(&mut self, s: &str) -> StrIdx {
            self.tt.strings.push(s.into());
            self.tt.strings.len() as u32 - 1
        }
        /// One pattern with its trips: `(gtfs id, sjyid, service, "arr dep" per stop)`.
        /// Trips must be given in time order.
        pub fn pattern(&mut self, line: LineIdx, stops: &[StopIdx], trips: &[(&str, &str, ServiceIdx, &[&str])]) -> TripIdx {
            let pat = self.tt.patterns.len() as u32;
            let first = self.tt.trips.len() as u32;
            self.tt.patterns.push(Pattern {
                line,
                stops_off: self.tt.pattern_stops.len() as u32,
                n_stops: stops.len() as u16,
                trips_off: first,
                n_trips: trips.len() as u32,
                times_off: self.tt.times.len() as u64,
            });
            let mode_bit = self.tt.lines[line as usize].mode.bit();
            for &s in stops {
                self.tt.pattern_stops.push(s);
                self.tt.pattern_flags.push(0);
                self.tt.stops[s as usize].modes |= mode_bit;
            }
            for (gtfs_id, sjyid, service, times) in trips {
                assert_eq!(times.len(), stops.len());
                let (g, s) = (self.intern(gtfs_id), self.intern(sjyid));
                self.tt.trips.push(Trip { pattern: pat, service: *service, headsign: 0, short_name: 0, gtfs_id: g, sjyid: s, flags: 0, headway_s: 0 });
                for t in times.iter() {
                    let (a, d) = t.split_once(' ').unwrap_or((t, t));
                    self.tt.times.push(parse_hms(&format!("{a}:00")).unwrap());
                    self.tt.times.push(parse_hms(&format!("{d}:00")).unwrap());
                }
            }
            first
        }
        pub fn finish(mut self) -> Timetable {
            let mut per_stop: Vec<Vec<(PatternIdx, u16)>> = vec![vec![]; self.tt.stops.len()];
            for (p, pat) in self.tt.patterns.iter().enumerate() {
                for k in 0..pat.n_stops as usize {
                    per_stop[self.tt.pattern_stops[pat.stops_off as usize + k] as usize].push((p as u32, k as u16));
                }
            }
            for v in per_stop {
                self.tt.stop_pattern_off.push(self.tt.stop_patterns.len() as u32);
                self.tt.stop_patterns.extend(v);
            }
            self.tt.stop_pattern_off.push(self.tt.stop_patterns.len() as u32);
            self.tt
        }
    }

    pub struct Ids {
        pub ic: TripIdx,
        pub ic_sat: TripIdx,
        pub bus: TripIdx,
        pub night: TripIdx,
        pub bern7: StopIdx,
        pub bern5: StopIdx,
        pub bern12ac: StopIdx,
        pub bern12df: StopIdx,
        pub bay_a: StopIdx,
        pub bay_c: StopIdx,
    }

    /// Fri 2026-11-20 and Sat 2026-11-21.
    ///
    /// - IC 1 Genève → Lausanne → Bern (track 7) → Zürich HB, sjyid shared by a
    ///   weekday and a Saturday variant with different times.
    /// - Bus 101 Bern Bahnhof (bay A) → Brückfeld → Hinterkappelen, three runs,
    ///   static ids unrelated to the live ids.
    /// - Night bus M1 leaving Bern at 24:25 on the Friday service day.
    pub fn bern() -> (Timetable, Ids) {
        let mut b = Tb::new();
        let (fri, sat) = (b.service(&["2026-11-20"]), b.service(&["2026-11-21"]));
        let both = b.service(&["2026-11-20", "2026-11-21"]);
        let geneve = b.station("Genève", 8501008);
        let lausanne = b.station("Lausanne", 8501120);
        let bern = b.station("Bern", 8507000);
        let zurich = b.station("Zürich HB", 8503000);
        let ge4 = b.stop(geneve, "ch:1:sloid:1008:3:4", "4", "", Precision::Edge);
        let ls5 = b.stop(lausanne, "ch:1:sloid:1120:3:5", "5", "", Precision::Edge);
        let bern7 = b.stop(bern, "ch:1:sloid:7000:4:7", "7", "", Precision::Edge);
        let bern5 = b.stop(bern, "ch:1:sloid:7000:3:5", "5", "", Precision::Edge);
        let bern12ac = b.stop(bern, "ch:1:sloid:7000:7:12", "12", "A-C", Precision::Edge);
        let bern12df = b.stop(bern, "ch:1:sloid:7000:7:12", "12", "D-F", Precision::Edge);
        let zh33 = b.stop(zurich, "ch:1:sloid:3000:501:33", "33", "", Precision::Edge);
        let bbf = b.station("Bern, Bahnhof", 8576646);
        let bruck = b.station("Bern, Brückfeld", 8590002);
        let hint = b.station("Hinterkappelen, Post", 8590003);
        let bay_a = b.stop(bbf, "ch:1:sloid:76646:0:1", "A", "", Precision::Edge);
        let bay_c = b.stop(bbf, "ch:1:sloid:76646:0:3", "C", "", Precision::Edge);
        let bruck0 = b.stop(bruck, "ch:1:sloid:90002", "", "", Precision::Station);
        let hint0 = b.stop(hint, "8590003", "", "", Precision::Station);

        let ic1 = b.line("IC 1", Mode::Rail);
        let ic = b.pattern(
            ic1,
            &[ge4, ls5, bern7, zh33],
            &[
                ("ic733.sat", "ch:1:sjyid:100001:733-001", sat, &["21:10", "21:46 21:48", "22:56 23:02", "23:58"]),
                ("ic733.fri", "CH:1:sjyid:100001:733-001", fri, &["21:42", "22:18 22:20", "23:26 23:32", "24:28"]),
            ],
        );
        let l101 = b.line("101", Mode::Bus);
        let bus = b.pattern(
            l101,
            &[bay_a, bruck0, hint0],
            &[
                ("bus101.1", "ch:1:sjyid:100602:plan:aaa", both, &["22:30", "22:34", "22:45"]),
                ("bus101.2", "ch:1:sjyid:100602:plan:bbb", both, &["23:00", "23:04", "23:15"]),
                ("bus101.3", "ch:1:sjyid:100602:plan:ccc", both, &["23:30", "23:34", "23:45"]),
            ],
        );
        let m1 = b.line("M1", Mode::Bus);
        let night = b.pattern(m1, &[bay_c, bruck0], &[("m1.night", "ch:1:sjyid:100602:plan:night", fri, &["24:25", "24:31"])]);
        (b.finish(), Ids { ic_sat: ic, ic: ic + 1, bus, night, bern7, bern5, bern12ac, bern12df, bay_a, bay_c })
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::*;
    use super::*;
    use crate::siri::parse_time;

    fn t(s: &str) -> Option<i64> {
        // Local wall-clock time in Zurich (CET in November).
        Some(parse_time(format!("{s}+01:00").as_bytes()).unwrap())
    }

    fn call(stop: &str, aimed_arr: &str, aimed_dep: &str) -> RtCall {
        let p = |s: &str| if s.is_empty() { None } else { t(s) };
        RtCall { stop_ref: stop.into(), aimed_arr: p(aimed_arr), aimed_dep: p(aimed_dep), ..Default::default() }
    }

    fn ic733() -> RtJourney {
        let mut calls = vec![
            call("ch:1:sloid:1008", "", "2026-11-20T21:42:00"),
            call("ch:1:sloid:1120", "2026-11-20T22:18:00", "2026-11-20T22:20:00"),
            call("ch:1:sloid:7000", "2026-11-20T23:26:00", "2026-11-20T23:32:00"),
            call("ch:1:sloid:3000", "2026-11-21T00:28:00", ""),
        ];
        calls[0].recorded = true;
        calls[0].actual_dep = t("2026-11-20T21:43:12");
        calls[0].platform = "4".into();
        calls[1].recorded = true;
        calls[1].actual_arr = t("2026-11-20T22:21:00");
        calls[1].actual_dep = t("2026-11-20T22:24:30");
        calls[2].expected_arr = t("2026-11-20T23:29:00");
        calls[2].expected_dep = t("2026-11-20T23:33:00");
        calls[2].platform = "7".into();
        RtJourney {
            journey_ref: "ch:1:sjyid:100001:733-001".into(),
            operating_day: "2026-11-20".into(),
            line_name: "IC 1".into(),
            monitored: true,
            recorded_at: 1_795_211_640,
            calls,
            ..Default::default()
        }
    }

    #[test]
    fn journey_id_picks_the_variant_of_the_day() {
        let (tt, ids) = bern();
        let m = Matcher::new(&tt);
        let got = m.explain(&tt, &ic733()).unwrap();
        // Two static trips share the id (and one is spelled `CH:`): Friday's runs today.
        assert_eq!((got.trip, got.date, got.method), (ids.ic, day("2026-11-20"), MatchMethod::JourneyId));
        assert_eq!((got.calls, got.aligned, got.on_schedule), (4, 4, 4));
        let l = &got.live;
        assert!(!l.cancelled && l.skipped.is_empty() && l.quay.is_empty());
        // Actual where recorded, expected otherwise; the last stop has no
        // forecast and inherits the delay of the departure before it.
        assert_eq!(l.dep_delay, vec![72, 270, 60, 60]);
        assert_eq!(l.arr_delay, vec![0, 180, 180, 60]);
        assert_eq!(l.observed_pos, 1);
        assert_eq!(l.updated_at, 1_795_211_640);
        assert!(got.platform_changes.is_empty());
    }

    #[test]
    fn platform_change_by_name_resolves_to_the_stop() {
        let (tt, ids) = bern();
        let m = Matcher::new(&tt);
        let mut j = ic733();
        j.calls[2].platform = "5".into();
        let got = m.apply(&tt, &j).unwrap();
        assert_eq!(got.live.quay, vec![NONE, NONE, ids.bern5, NONE]);
        assert_eq!(got.platform_changes, vec![(2, "7".to_string(), "5".to_string())]);

        // A name the station does not have stays textual.
        j.calls[2].platform = "49".into();
        let got = m.apply(&tt, &j).unwrap();
        assert!(got.live.quay.is_empty());
        assert_eq!(got.platform_changes, vec![(2, "7".to_string(), "49".to_string())]);

        // Track and sectors: "12D-F" picks that sector variant, not 12A-C.
        j.calls[2].platform = "12D-F".into();
        let got = m.apply(&tt, &j).unwrap();
        assert_eq!(got.live.quay[2], ids.bern12df);
        assert_eq!(got.platform_changes, vec![(2, "7".to_string(), "12D-F".to_string())]);
        j.calls[2].platform = "12".into();
        assert_eq!(m.apply(&tt, &j).unwrap().live.quay[2], ids.bern12ac);

        // Same track with sectors appended is no change.
        j.calls[2].platform = "7A".into();
        let got = m.apply(&tt, &j).unwrap();
        assert!(got.live.quay.is_empty() && got.platform_changes.is_empty());
    }

    #[test]
    fn the_stop_reference_decides_about_the_place() {
        let (tt, ids) = bern();
        let m = Matcher::new(&tt);
        let bus = |stop_ref: &str, platform: &str| {
            let mut j = RtJourney {
                journey_ref: "ch:1:sjyid:100602:plan:bbb".into(),
                operating_day: "2026-11-20".into(),
                calls: vec![call(stop_ref, "", "2026-11-20T23:00:00"), call("ch:1:sloid:90002", "2026-11-20T23:04:00", "2026-11-20T23:04:00")],
                ..Default::default()
            };
            j.calls[0].platform = platform.into();
            m.apply(&tt, &j).unwrap()
        };
        // The planned bay by reference: confirmed, even if the operator calls it "1".
        let got = bus("ch:1:sloid:76646:0:1", "1");
        assert!(got.live.quay.is_empty() && got.platform_changes.is_empty());
        // Another bay by reference, without and with a name.
        let got = bus("ch:1:sloid:76646:0:3", "");
        assert_eq!(got.live.quay, vec![ids.bay_c, NONE, NONE]);
        assert_eq!(got.platform_changes, vec![(0, "A".to_string(), "C".to_string())]);
        let got = bus("ch:1:sloid:76646:0:3", "Kante C");
        assert_eq!(got.live.quay[0], ids.bay_c);
        assert_eq!(got.platform_changes, vec![(0, "A".to_string(), "Kante C".to_string())]);
        let cautious = Matcher::with_options(&tt, MatchOptions { trust_stop_refs: false, ..Default::default() });
        let mut j = RtJourney {
            journey_ref: "ch:1:sjyid:100602:plan:bbb".into(),
            operating_day: "2026-11-20".into(),
            calls: vec![call("ch:1:sloid:76646:0:3", "", "2026-11-20T23:00:00")],
            ..Default::default()
        };
        assert!(cautious.apply(&tt, &j).unwrap().live.quay.is_empty());
        j.calls[0].platform = "C".into();
        assert_eq!(cautious.apply(&tt, &j).unwrap().live.quay[0], ids.bay_c);
        // Stop-level reference: the name decides.
        let got = bus("ch:1:sloid:76646", "C");
        assert_eq!(got.live.quay[0], ids.bay_c);
        let got = bus("ch:1:sloid:76646", "Kante A");
        assert!(got.live.quay.is_empty() && got.platform_changes.is_empty());

        // A stop without a label in the plan: the feed's name is passed on as text.
        let mut j = RtJourney {
            journey_ref: "ch:1:sjyid:100602:plan:bbb".into(),
            operating_day: "2026-11-20".into(),
            calls: vec![call("ch:1:sloid:76646:0:1", "", "2026-11-20T23:00:00"), call("ch:1:sloid:90002", "2026-11-20T23:04:00", "2026-11-20T23:04:00")],
            ..Default::default()
        };
        j.calls[1].platform = "B".into();
        let got = m.apply(&tt, &j).unwrap();
        assert!(got.live.quay.is_empty());
        assert_eq!(got.platform_changes, vec![(1, String::new(), "B".to_string())]);

        assert!(same_platform("41/42", "42") && same_platform("43", "43/44") && !same_platform("41/42", "43"));
        assert!(same_platform("Kante B", "b") && same_platform("6 Süd", "6Süd") && same_platform("Gleis 7", "7"));
        assert!(!same_platform("", "7") && !same_platform("7", "") && same_platform("", ""));
        assert!(!same_platform("B", "A") && !same_platform("12", "1"));
    }

    #[test]
    fn cancellation_extra_call_and_missing_times() {
        let (tt, ids) = bern();
        let m = Matcher::new(&tt);
        let mut j = ic733();
        // Lausanne is cancelled, an extra call at an unknown stop is inserted,
        // and Bern has no forecast at all.
        j.calls[1].cancelled = true;
        j.calls[1].actual_arr = None;
        j.calls[1].actual_dep = None;
        j.calls[1].recorded = false;
        let mut extra = call("ch:1:sloid:4242", "2026-11-20T22:50:00", "2026-11-20T22:51:00");
        extra.extra_call = true;
        extra.expected_dep = t("2026-11-20T22:59:00");
        j.calls.insert(2, extra);
        j.calls[3].expected_arr = None;
        j.calls[3].expected_dep = None;
        let got = m.apply(&tt, &j).unwrap();
        assert_eq!(got.trip, ids.ic);
        assert_eq!((got.calls, got.aligned), (5, 4));
        let l = &got.live;
        assert_eq!(l.skipped, vec![false, true, false, false]);
        assert!(l.is_skipped(1) && !l.is_skipped(2));
        // 72 s late leaving Genève, carried all the way.
        assert_eq!(l.dep_delay, vec![72, 72, 72, 72]);
        assert_eq!(l.arr_delay, vec![0, 72, 72, 72]);
        assert_eq!(l.observed_pos, 0);

        // Whole journey cancelled.
        let mut j = ic733();
        j.cancelled = true;
        let got = m.apply(&tt, &j).unwrap();
        assert!(got.live.cancelled && got.live.is_skipped(0));

        // Cancelled with no stop list at all: still unambiguous on that day.
        j.calls.clear();
        let got = m.apply(&tt, &j).unwrap();
        assert_eq!((got.trip, got.live.cancelled, got.calls), (ids.ic, true, 0));
        assert_eq!(got.live.dep_delay, vec![0; 4]);
    }

    #[test]
    fn early_running_and_monotonic_times() {
        let (tt, _) = bern();
        let m = Matcher::new(&tt);
        let mut j = ic733();
        // Reported 90 s early into Bern with no departure forecast: the
        // departure is not assumed to be early.
        j.calls[1].actual_arr = t("2026-11-20T22:18:00");
        j.calls[1].actual_dep = t("2026-11-20T22:20:00");
        j.calls[2].expected_arr = t("2026-11-20T23:24:30");
        j.calls[2].expected_dep = None;
        let got = m.apply(&tt, &j).unwrap();
        assert_eq!(got.live.arr_delay[2], -90);
        assert_eq!(got.live.dep_delay[2], 0);
        assert_eq!(got.live.arr_delay[3], -90);

        // A forecast that would arrive before the previous departure is pulled up.
        j.calls[1].actual_dep = t("2026-11-20T23:05:00");
        j.calls[2].expected_arr = t("2026-11-20T23:00:00");
        let got = m.apply(&tt, &j).unwrap();
        // Lausanne left at 23:05 → Bern (planned 23:26) cannot be reached at 23:00.
        assert_eq!(got.live.dep_delay[1], 45 * 60);
        assert_eq!(got.live.arr_delay[2], -(21 * 60));
        assert_eq!(got.live.dep_delay[2], 0);
    }

    #[test]
    fn fallback_by_stops_and_times() {
        let (tt, ids) = bern();
        let m = Matcher::new(&tt);
        // PostAuto-style id that the timetable does not know; stop-level
        // references; aimed times with seconds.
        let mut j = RtJourney {
            journey_ref: "ch:1:ServiceJourney:801:24125-3541".into(),
            operating_day: "2026-11-20".into(),
            line_name: "101".into(),
            operator_ref: "ch:1:sboid:100602".into(),
            calls: vec![
                call("ch:1:sloid:76646", "", "2026-11-20T23:00:30"),
                call("ch:1:sloid:90002", "2026-11-20T23:03:40", "2026-11-20T23:04:10"),
                call("ch:1:ScheduledStopPoint:8590003", "2026-11-20T23:15:20", ""),
            ],
            ..Default::default()
        };
        j.calls[0].expected_dep = t("2026-11-20T23:02:30");
        j.calls[0].platform = "C".into();
        let got = m.explain(&tt, &j).unwrap();
        assert_eq!((got.trip, got.method), (ids.bus + 1, MatchMethod::Fallback));
        assert_eq!((got.aligned, got.on_schedule), (3, 3));
        assert_eq!(got.live.dep_delay, vec![150, 150, 150]);
        // The bay changed from A to C.
        assert_eq!(got.live.quay, vec![ids.bay_c, NONE, NONE]);
        assert_eq!(got.platform_changes, vec![(0, "A".to_string(), "C".to_string())]);

        // Another line name with only part of the run fitting is not accepted …
        let mut other = j.clone();
        other.line_name = "102".into();
        other.calls.pop();
        assert_eq!(m.explain(&tt, &other).unwrap_err(), Unmatched::NotFound);
        // … nor are times that belong to no run of the line …
        let mut off = j.clone();
        for c in &mut off.calls {
            c.aimed_dep = c.aimed_dep.map(|x| x + 600);
            c.aimed_arr = c.aimed_arr.map(|x| x + 600);
        }
        assert_eq!(m.explain(&tt, &off).unwrap_err(), Unmatched::NotFound);
        // … nor extra journeys or journeys at unknown stops.
        let mut extra = j.clone();
        extra.extra = true;
        assert_eq!(m.explain(&tt, &extra).unwrap_err(), Unmatched::Extra);
        let mut nowhere = j.clone();
        for c in &mut nowhere.calls {
            c.stop_ref = "ch:1:sloid:999999".into();
        }
        assert_eq!(m.explain(&tt, &nowhere).unwrap_err(), Unmatched::NoStops);
        let mut noday = j.clone();
        noday.operating_day.clear();
        assert_eq!(m.explain(&tt, &noday).unwrap_err(), Unmatched::BadDay);
    }

    #[test]
    fn diverted_run_flags_scheduled_stops_as_extra() {
        // Seen at TL Lausanne: on a diversion every remaining stop is sent as
        // ExtraCall although the timetable has it, and the skipped stops are
        // sent cancelled.
        let (tt, ids) = bern();
        let m = Matcher::new(&tt);
        let mut j = ic733();
        for c in &mut j.calls {
            c.extra_call = true;
        }
        let mut gone = call("ch:1:sloid:4242", "2026-11-20T22:50:00", "2026-11-20T22:51:00");
        gone.cancelled = true;
        j.calls.insert(2, gone);
        let got = m.explain(&tt, &j).unwrap();
        assert_eq!((got.trip, got.method), (ids.ic, MatchMethod::JourneyId));
        assert_eq!((got.calls, got.aligned, got.on_schedule), (5, 4, 4));
        assert_eq!(got.live.dep_delay, vec![72, 270, 60, 60]);

        // A real extra call at a station the trip also serves later, at
        // another time, is not mistaken for the scheduled stop.
        let mut j = ic733();
        let mut extra = call("ch:1:sloid:3000", "2026-11-20T22:00:00", "2026-11-20T22:01:00");
        extra.extra_call = true;
        extra.expected_dep = t("2026-11-20T22:31:00");
        j.calls.insert(1, extra);
        let got = m.apply(&tt, &j).unwrap();
        assert_eq!((got.calls, got.aligned), (5, 4));
        assert_eq!(got.live.dep_delay, vec![72, 270, 60, 60]);
    }

    #[test]
    fn implausible_times_are_dropped() {
        let (tt, _) = bern();
        let m = Matcher::new(&tt);
        let mut j = ic733();
        // A forecast a day early and a stale "8 h late" one.
        j.calls[2].expected_arr = t("2026-11-19T23:26:00");
        j.calls[2].expected_dep = t("2026-11-21T07:32:00");
        j.calls[1].actual_dep = None;
        j.calls[1].actual_arr = t("2026-11-20T15:00:00");
        let got = m.apply(&tt, &j).unwrap();
        assert_eq!(got.implausible, 3);
        // Only Genève's measured departure is left; it is carried forward.
        assert_eq!(got.live.dep_delay, vec![72, 72, 72, 72]);
        assert_eq!(got.live.arr_delay, vec![0, 72, 72, 72]);
        assert_eq!(got.live.observed_pos, 0);

        // 2.5 h late is rare but real.
        j.calls[2].expected_dep = t("2026-11-21T02:02:00");
        let got = m.apply(&tt, &j).unwrap();
        assert_eq!(got.live.dep_delay[2], 9000);
    }

    #[test]
    fn fallback_when_the_run_starts_before_the_timetable_does() {
        // Seen at TPG: the live run starts at a stop across the border that
        // the static trip does not have.
        let (tt, ids) = bern();
        let m = Matcher::new(&tt);
        let j = RtJourney {
            journey_ref: "ch:1:ServiceJourney:881:1".into(),
            operating_day: "2026-11-20".into(),
            line_name: "101".into(),
            calls: vec![
                call("ch:1:sloid:76646:0:3", "", "2026-11-20T22:20:00"),
                call("ch:1:sloid:7000", "2026-11-20T22:25:00", "2026-11-20T22:25:00"),
                call("ch:1:sloid:76646", "2026-11-20T22:30:00", "2026-11-20T22:30:00"),
                call("ch:1:sloid:90002", "2026-11-20T22:34:00", "2026-11-20T22:34:00"),
                call("8590003", "2026-11-20T22:45:00", "2026-11-20T22:45:30"),
                call("ch:1:sloid:999999", "2026-11-20T22:50:00", ""),
            ],
            ..Default::default()
        };
        // 3 of the 5 known calls fit: below the 80 % bar.
        assert_eq!(m.explain(&tt, &j).unwrap_err(), Unmatched::NotFound);
        let lenient = Matcher::with_options(&tt, MatchOptions { fallback_min_share: 0.6, ..Default::default() });
        let got = lenient.explain(&tt, &j).unwrap();
        assert_eq!((got.trip, got.method, got.on_schedule), (ids.bus, MatchMethod::Fallback, 3));
    }

    #[test]
    fn vehicle_at_a_stop_is_reported_twice() {
        let (tt, ids) = bern();
        let m = Matcher::new(&tt);
        let mut j = ic733();
        // Lausanne: arrival recorded, departure still estimated, same visit number.
        for (i, c) in j.calls.iter_mut().enumerate() {
            c.order = i as u16 + 1;
        }
        let mut est = j.calls[1].clone();
        j.calls[1].actual_dep = None;
        est.recorded = false;
        est.actual_arr = None;
        est.actual_dep = None;
        est.expected_dep = t("2026-11-20T22:23:00");
        est.platform = "6".into();
        j.calls.insert(2, est);
        let got = m.apply(&tt, &j).unwrap();
        assert_eq!((got.trip, got.calls, got.aligned), (ids.ic, 4, 4));
        assert_eq!(got.live.arr_delay[1], 180);
        assert_eq!(got.live.dep_delay[1], 180);
        assert_eq!(got.live.observed_pos, 1);
        assert_eq!(got.platform_changes, vec![(1, "5".to_string(), "6".to_string())]);
        assert!(merge_split_calls(&ic733().calls).is_none());
    }

    #[test]
    fn overnight_operating_day() {
        let (tt, ids) = bern();
        let m = Matcher::new(&tt);
        // 00:25 on Saturday's calendar, operating day Friday (24:25).
        let mut j = RtJourney {
            journey_ref: "ch:1:sjyid:100602:plan:night".into(),
            operating_day: "2026-11-20".into(),
            line_name: "M1".into(),
            calls: vec![call("ch:1:sloid:76646:0:3", "", "2026-11-21T00:25:00"), call("ch:1:sloid:90002", "2026-11-21T00:31:00", "")],
            ..Default::default()
        };
        j.calls[1].expected_arr = t("2026-11-21T00:33:00");
        let got = m.explain(&tt, &j).unwrap();
        assert_eq!((got.trip, got.date, got.method), (ids.night, day("2026-11-20"), MatchMethod::JourneyId));
        assert_eq!(got.live.arr_delay, vec![0, 120]);

        // A feed that stamps the calendar date instead still lands on Friday's trip.
        j.operating_day = "2026-11-21".into();
        let got = m.explain(&tt, &j).unwrap();
        assert_eq!((got.trip, got.date), (ids.night, day("2026-11-20")));

        // And so does the fallback when the id is unknown.
        j.journey_ref = "ch:1:ServiceJourney:801:1-2".into();
        let got = m.explain(&tt, &j).unwrap();
        assert_eq!((got.trip, got.date, got.method), (ids.night, day("2026-11-20"), MatchMethod::Fallback));
    }

    #[test]
    fn gtfs_rt_delays_skips_and_changed_stop() {
        use crate::gtfsrt::enc::*;
        let (tt, ids) = bern();
        let m = Matcher::new(&tt);
        let mut feed = header(1_795_211_721, "test");
        feed.extend(entity(
            "e1",
            &[s(1, "ic733.fri"), s(2, "21:42:00"), s(3, "20261120"), i(4, 0), s(8, "ch:1:sjyid:100001:733-001")],
            &[
                stu(1, "ch:1:sloid:1008:3:4", None, Some(66), 0),
                stu(2, "ch:1:sloid:1120:3:5", Some(-30), Some(72), 1),
                // Track 5 instead of 7, reported as another stop id; sequence numbers have a gap.
                stu(5, "ch:1:sloid:7000:3:5", Some(120), Some(180), 0),
                stu(6, "ch:1:sloid:3000:501:33", Some(96), None, 0),
            ],
        ));
        feed.extend(entity("e2", &[s(1, "bus101.2"), s(3, "20261120"), i(4, 3)], &[]));
        feed.extend(entity("e3", &[s(1, "ojp:added:1"), s(3, "20261120"), i(4, 1)], &[stu(1, "ch:1:sloid:7000:3:5", None, Some(0), 0)]));
        feed.extend(entity("e4", &[s(1, "bus101.1"), s(3, "20261122"), i(4, 0)], &[stu(1, "ch:1:sloid:76646:0:1", None, Some(60), 0)]));
        let mut js = Vec::new();
        crate::parse_gtfs_rt(&feed, |j| js.push(j)).unwrap();

        let got = m.explain(&tt, &js[0]).unwrap();
        assert_eq!((got.trip, got.date, got.method), (ids.ic, day("2026-11-20"), MatchMethod::TripId));
        let l = &got.live;
        assert_eq!(l.skipped, vec![false, true, false, false]);
        // Zürich reports only its arrival (96 s); that is the newest knowledge there.
        assert_eq!(l.dep_delay, vec![66, 66, 180, 96]);
        assert_eq!(l.arr_delay, vec![0, 66, 120, 96]);
        assert_eq!(l.quay, vec![NONE, NONE, ids.bern5, NONE]);
        assert_eq!(got.platform_changes, vec![(2, "7".to_string(), "5".to_string())]);
        assert_eq!((l.observed_pos, l.updated_at), (-1, 1_795_211_721));

        let got = m.explain(&tt, &js[1]).unwrap();
        assert_eq!((got.trip, got.live.cancelled), (ids.bus + 1, true));
        assert_eq!(m.explain(&tt, &js[2]).unwrap_err(), Unmatched::Extra);
        // Known trip id, but the trip does not run on the stated day.
        assert!(m.apply(&tt, &js[3]).is_none());
    }

    #[test]
    fn reference_resolution() {
        let (tt, ids) = bern();
        let m = Matcher::new(&tt);
        let bern = tt.stops[ids.bern7 as usize].station;
        for r in ["ch:1:sloid:7000:4:7", "ch:1:sloid:7000", "CH:1:SLOID:7000:99:99", "8507000", "ch:1:ScheduledStopPoint:8507000", "ch:1:sloid:7000:7:12_gen:ch:1:sloid:7000:7:12_pf:12A-C"] {
            assert_eq!(m.station_of_ref(&tt, r), Some(bern), "{r}");
        }
        assert_eq!(m.station_of_ref(&tt, "ch:1:sloid:76646::9"), Some(tt.stops[ids.bay_a as usize].station));
        for r in ["", "ch:1:sloid:", "ch:1:sloid:123456", "Bern", "ch:1:Line:11:IC1x"] {
            assert_eq!(m.station_of_ref(&tt, r), None, "{r}");
        }
        assert_eq!(m.stops_of_ref(&tt, "ch:1:sloid:7000:7:12").collect::<Vec<_>>(), vec![ids.bern12ac, ids.bern12df]);
        assert_eq!(m.trips_of_journey(&tt, "ch:1:sjyid:100001:733-001").collect::<Vec<_>>(), vec![ids.ic_sat, ids.ic]);
        assert_eq!(m.trip_of_gtfs_id(&tt, "m1.night"), Some(ids.night));
        assert_eq!(split_platform("12A-C"), ("12", "A-C"));
        assert_eq!(split_platform("2CD"), ("2", "CD"));
        assert_eq!(split_platform("41/42"), ("41/42", ""));
        assert_eq!(split_platform("B2"), ("B2", ""));
        assert_eq!(split_platform(" 7 "), ("7", ""));
    }
}
