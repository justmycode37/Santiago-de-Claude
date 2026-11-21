//! The immutable live overlay the router queries.
//!
//! One snapshot is built per poll from the matched journeys and swapped in as
//! a whole (`Arc<LiveSnapshot>`); queries keep the snapshot they started with.

use crate::matcher::{MatchMethod, MatchedTrip, Matcher};
use crate::model::{FeedMeta, RtJourney};
use kante_core::time::{Date, Secs};
use kante_core::{ExtraTrip, LiveView, Timetable, TripIdx, TripLive, OBSERVED_DEP, SOURCE_GTFS_RT, SOURCE_SIRI_ET};
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

/// Hasher for `(Date, TripIdx)` keys: the router looks trips up on its hot
/// path, where SipHash would cost more than the rest of the lookup.
#[derive(Default, Clone, Copy)]
pub struct KeyHasher(u64);

impl Hasher for KeyHasher {
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0.rotate_left(8) ^ b as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
        }
    }
    #[inline]
    fn write_u32(&mut self, v: u32) {
        self.0 = (self.0.rotate_left(32) ^ v as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
    }
    #[inline]
    fn write_i32(&mut self, v: i32) {
        self.write_u32(v as u32)
    }
    #[inline]
    fn finish(&self) -> u64 {
        // Fold the well-mixed high bits into the low ones the table indexes by.
        self.0 ^ (self.0 >> 29)
    }
}

type Key = (Date, TripIdx);
type Map<V> = HashMap<Key, V, BuildHasherDefault<KeyHasher>>;

/// Live state of all matched trips at one point in time.
#[derive(Default)]
pub struct LiveSnapshot {
    trips: Map<TripLive>,
    /// `(position, planned, current)` platform texts per trip, for display.
    changes: Map<Vec<(u16, String, String)>>,
    max_delay: Secs,
    /// Trips running at least [`LATE_THRESHOLD`] late, latest first.
    late: Vec<(Date, TripIdx, Secs)>,
    common_max_delay: Secs,
    /// Journeys that are not in the timetable, and their index by id.
    extras: Vec<ExtraTrip>,
    extra_ids: HashMap<String, usize>,
    /// Feeds that went into this snapshot.
    pub feeds: Vec<FeedMeta>,
}

/// Delay from which a trip is listed in [`LiveSnapshot::late_trips`].
pub const LATE_THRESHOLD: Secs = 900;

impl LiveSnapshot {
    pub fn len(&self) -> usize {
        self.trips.len()
    }
    pub fn is_empty(&self) -> bool {
        self.trips.is_empty()
    }
    pub fn iter(&self) -> impl Iterator<Item = (Date, TripIdx, &TripLive)> {
        self.trips.iter().map(|(&(d, t), l)| (d, t, l))
    }
    /// Platform texts `(position, planned, current)` of a trip where the live
    /// platform differs from the plan; empty if none. `TripLive::quay` has the
    /// resolved boarding point where there is one.
    pub fn platform_changes(&self, date: Date, trip: TripIdx) -> &[(u16, String, String)] {
        self.changes.get(&(date, trip)).map(Vec::as_slice).unwrap_or(&[])
    }
    /// The few trips that are very late (largest departure delay ≥
    /// [`LATE_THRESHOLD`]), latest first, with that delay. `max_delay()` is
    /// dictated by the worst of them — one ICE 2.5 h late makes it 9,000 s —
    /// so a router can look back only [`LiveSnapshot::common_max_delay`] in
    /// general and handle these trips one by one.
    pub fn late_trips(&self) -> &[(Date, TripIdx, Secs)] {
        &self.late
    }
    /// Largest positive departure delay among the trips *not* in
    /// [`LiveSnapshot::late_trips`] (below [`LATE_THRESHOLD`]).
    pub fn common_max_delay(&self) -> Secs {
        self.common_max_delay
    }
    /// Newest feed timestamp in the snapshot (unix seconds), 0 if none.
    pub fn timestamp(&self) -> i64 {
        self.feeds.iter().map(|f| f.timestamp).max().unwrap_or(0)
    }
}

impl LiveView for LiveSnapshot {
    #[inline]
    fn trip(&self, date: Date, trip: TripIdx) -> Option<&TripLive> {
        self.trips.get(&(date, trip))
    }
    #[inline]
    fn max_delay(&self) -> Secs {
        self.max_delay
    }
    fn extras(&self) -> &[ExtraTrip] {
        &self.extras
    }
    fn extra(&self, id: &str) -> Option<&ExtraTrip> {
        self.extra_ids.get(id).map(|&i| &self.extras[i])
    }
}

/// Collects [`MatchedTrip`]s into a [`LiveSnapshot`].
#[derive(Default)]
pub struct LiveSnapshotBuilder {
    snap: LiveSnapshot,
    /// Journeys that hit a trip which already had live data.
    pub duplicates: usize,
}

impl LiveSnapshotBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_capacity(n: usize) -> Self {
        let mut b = Self::default();
        b.snap.trips.reserve(n);
        b
    }

    /// Add a trip, replacing earlier data for the same trip and date.
    pub fn push(&mut self, m: MatchedTrip) {
        let key = (m.date, m.trip);
        if m.platform_changes.is_empty() {
            self.snap.changes.remove(&key);
        } else {
            self.snap.changes.insert(key, m.platform_changes);
        }
        if self.snap.trips.insert(key, m.live).is_some() {
            self.duplicates += 1;
        }
    }

    /// Add a trip unless it already has live data. Use this for the secondary
    /// feed (GTFS-RT after SIRI-ET): its unchanged stop ids must not undo a
    /// platform change the richer feed reported. Returns whether it was added.
    pub fn push_if_absent(&mut self, m: MatchedTrip) -> bool {
        let key = (m.date, m.trip);
        if self.snap.trips.contains_key(&key) {
            self.duplicates += 1;
            return false;
        }
        if !m.platform_changes.is_empty() {
            self.snap.changes.insert(key, m.platform_changes);
        }
        self.snap.trips.insert(key, m.live);
        true
    }

    /// Add a trip from the secondary feed (GTFS-RT), stop by stop:
    ///
    /// - a trip without live data yet is added as it is;
    /// - otherwise only the *forecasts* for stops the vehicle has not reached
    ///   are taken, and only when this report updated the trip later than the
    ///   one already there (by the trip's own timestamp, not the feed's).
    ///   Measured times, platform changes and cancellations already there stay.
    pub fn merge_forecasts(&mut self, tt: &Timetable, m: MatchedTrip) -> Merge {
        let key = (m.date, m.trip);
        let Some(old) = self.snap.trips.get_mut(&key) else {
            if !m.platform_changes.is_empty() {
                self.snap.changes.insert(key, m.platform_changes);
            }
            self.snap.trips.insert(key, m.live);
            return Merge::Added;
        };
        self.duplicates += 1;
        let new = &m.live;
        let n = old.arr_delay.len();
        if !m.own_timestamp || new.updated_at <= old.updated_at || new.cancelled || old.cancelled || new.arr_delay.len() != n {
            return Merge::Kept;
        }
        // First position whose arrival / departure is still a forecast, and
        // that this report actually covers (positions before its first call
        // only hold the timetable, not a statement about the delay).
        let obs = old.observed_pos;
        let from = m.first_reported as usize;
        let first_arr = ((obs + 1).max(0) as usize).max(from);
        let first_dep = (if obs >= 0 && old.observed_kind & OBSERVED_DEP == 0 { obs as usize } else { first_arr }).max(from);
        let times = tt.trip_times(m.trip);
        // Never earlier than what was measured or forecast before it: no time travel.
        let mut prev = i64::MIN;
        let mut changed = false;
        for p in 0..n {
            let (sa, sd) = (times[2 * p] as i64, times[2 * p + 1] as i64);
            if p >= first_arr {
                let a = (new.arr_delay[p] as i64).max(prev - sa) as i32;
                changed |= a != old.arr_delay[p];
                old.arr_delay[p] = a;
            }
            prev = prev.max(sa + old.arr_delay[p] as i64);
            if p >= first_dep {
                let d = (new.dep_delay[p] as i64).max(prev - sd) as i32;
                changed |= d != old.dep_delay[p];
                old.dep_delay[p] = d;
            }
            prev = prev.max(sd + old.dep_delay[p] as i64);
            // A stop newly skipped ahead of the vehicle.
            if p >= first_arr && new.skipped.get(p).copied().unwrap_or(false) {
                if old.skipped.is_empty() {
                    old.skipped = vec![false; n];
                }
                changed |= !old.skipped[p];
                old.skipped[p] = true;
            }
        }
        old.updated_at = new.updated_at;
        old.sources |= SOURCE_GTFS_RT;
        if changed {
            Merge::Merged
        } else {
            Merge::Kept
        }
    }

    /// Add a journey that is not in the timetable, replacing an earlier report of it.
    pub fn push_extra(&mut self, e: ExtraTrip) {
        match self.snap.extra_ids.get(&e.id) {
            Some(&i) => self.snap.extras[i] = e,
            None => {
                self.snap.extra_ids.insert(e.id.clone(), self.snap.extras.len());
                self.snap.extras.push(e);
            }
        }
    }

    /// Record a feed that contributed.
    pub fn feed(&mut self, meta: FeedMeta) {
        self.snap.feeds.push(meta);
    }

    pub fn len(&self) -> usize {
        self.snap.trips.len()
    }
    pub fn is_empty(&self) -> bool {
        self.snap.trips.is_empty()
    }

    pub fn build(mut self) -> LiveSnapshot {
        // Only delays a traveller can still meet: trips that run, at stops they serve.
        let (mut max, mut common) = (0, 0);
        let mut late = Vec::new();
        for (&(date, trip), l) in &self.snap.trips {
            if l.cancelled {
                continue;
            }
            let mut worst = 0;
            for (p, &d) in l.dep_delay.iter().enumerate() {
                if d > worst && !l.skipped.get(p).copied().unwrap_or(false) {
                    worst = d;
                }
            }
            max = max.max(worst);
            if worst >= LATE_THRESHOLD {
                late.push((date, trip, worst));
            } else {
                common = common.max(worst);
            }
        }
        late.sort_unstable_by_key(|&(d, t, w)| (-w, d, t));
        self.snap.max_delay = max;
        self.snap.common_max_delay = common;
        self.snap.late = late;
        self.snap
    }
}

/// What [`LiveSnapshotBuilder::merge_forecasts`] did with a trip.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Merge {
    /// The trip had no live data yet.
    Added,
    /// Newer forecasts replaced older ones.
    Merged,
    /// The data already there stays (older report, or nothing new).
    Kept,
}

/// What happened to the journeys of one feed document.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MatchCounts {
    pub journeys: usize,
    pub by_trip_id: usize,
    pub by_journey_id: usize,
    pub by_fallback: usize,
    pub unmatched: usize,
    /// Unmatched journeys kept as [`ExtraTrip`]s.
    pub extras: usize,
}

impl MatchCounts {
    pub fn matched(&self) -> usize {
        self.by_trip_id + self.by_journey_id + self.by_fallback
    }
}

impl LiveSnapshotBuilder {
    /// Match one journey and add it. `primary` journeys replace existing data,
    /// others only fill gaps.
    pub fn add_journey(&mut self, tt: &Timetable, matcher: &Matcher, j: &RtJourney, primary: bool, counts: &mut MatchCounts) {
        counts.journeys += 1;
        match matcher.apply(tt, j) {
            Some(mut m) => {
                m.live.sources = if primary { SOURCE_SIRI_ET } else { SOURCE_GTFS_RT };
                match m.method {
                    MatchMethod::TripId => counts.by_trip_id += 1,
                    MatchMethod::JourneyId => counts.by_journey_id += 1,
                    MatchMethod::Fallback => counts.by_fallback += 1,
                }
                if primary {
                    self.push(m);
                } else {
                    self.merge_forecasts(tt, m);
                }
            }
            None => {
                counts.unmatched += 1;
                // Only the primary feed names lines and destinations of added journeys.
                if primary && j.extra {
                    if let Some(e) = matcher.extra_trip(tt, j) {
                        counts.extras += 1;
                        self.push_extra(e);
                    }
                }
            }
        }
    }

    /// Parse a SIRI-ET document (gzip or plain) and add every journey that matches.
    pub fn add_siri_et<R: std::io::BufRead>(&mut self, tt: &Timetable, matcher: &Matcher, r: R) -> anyhow::Result<MatchCounts> {
        let mut counts = MatchCounts::default();
        let meta = crate::siri::parse_siri_et_auto(r, |j| self.add_journey(tt, matcher, &j, true, &mut counts))?;
        self.feed(meta);
        Ok(counts)
    }

    /// Decode a GTFS-RT document and merge every trip that matches (see
    /// [`LiveSnapshotBuilder::merge_forecasts`]).
    pub fn add_gtfs_rt(&mut self, tt: &Timetable, matcher: &Matcher, bytes: &[u8]) -> anyhow::Result<MatchCounts> {
        let mut counts = MatchCounts::default();
        let meta = crate::gtfsrt::parse_gtfs_rt(bytes, |j| self.add_journey(tt, matcher, &j, false, &mut counts))?;
        self.feed(meta);
        Ok(counts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::matcher::testkit::*;
    use kante_core::NONE;

    const SIRI: &str = r#"<Siri><ServiceDelivery><ResponseTimestamp>2026-11-20T21:55:05Z</ResponseTimestamp>
<EstimatedTimetableDelivery><EstimatedJourneyVersionFrame>
<EstimatedVehicleJourney><RecordedAtTime>2026-11-20T21:54:00Z</RecordedAtTime>
 <FramedVehicleJourneyRef><DataFrameRef>2026-11-20</DataFrameRef><DatedVehicleJourneyRef>ch:1:sjyid:100001:733-001</DatedVehicleJourneyRef></FramedVehicleJourneyRef>
 <PublishedLineName>IC 1</PublishedLineName><Monitored>true</Monitored>
 <RecordedCalls><RecordedCall><StopPointRef>ch:1:sloid:1008</StopPointRef>
  <AimedDepartureTime>2026-11-20T20:42:00Z</AimedDepartureTime><ActualDepartureTime>2026-11-20T20:47:00Z</ActualDepartureTime></RecordedCall></RecordedCalls>
 <EstimatedCalls><EstimatedCall><StopPointRef>ch:1:sloid:7000</StopPointRef>
  <AimedArrivalTime>2026-11-20T22:26:00Z</AimedArrivalTime><ExpectedArrivalTime>2026-11-20T22:30:00Z</ExpectedArrivalTime>
  <AimedDepartureTime>2026-11-20T22:32:00Z</AimedDepartureTime><ExpectedDepartureTime>2026-11-20T22:34:00Z</ExpectedDepartureTime>
  <DeparturePlatformName>5</DeparturePlatformName></EstimatedCall></EstimatedCalls>
</EstimatedVehicleJourney>
<EstimatedVehicleJourney>
 <FramedVehicleJourneyRef><DataFrameRef>2026-11-20</DataFrameRef><DatedVehicleJourneyRef>ch:1:ServiceJourney:801:1</DatedVehicleJourneyRef></FramedVehicleJourneyRef>
 <PublishedLineName>101</PublishedLineName><Cancellation>true</Cancellation>
 <EstimatedCalls>
  <EstimatedCall><StopPointRef>ch:1:sloid:76646:0:1</StopPointRef><AimedDepartureTime>2026-11-20T21:30:00Z</AimedDepartureTime><ExpectedDepartureTime>2026-11-20T23:30:00Z</ExpectedDepartureTime></EstimatedCall>
  <EstimatedCall><StopPointRef>ch:1:sloid:90002</StopPointRef><AimedArrivalTime>2026-11-20T21:34:00Z</AimedArrivalTime><AimedDepartureTime>2026-11-20T21:34:00Z</AimedDepartureTime></EstimatedCall>
  <EstimatedCall><StopPointRef>8590003</StopPointRef><AimedArrivalTime>2026-11-20T21:45:00Z</AimedArrivalTime></EstimatedCall>
 </EstimatedCalls>
</EstimatedVehicleJourney>
<EstimatedVehicleJourney><ExtraJourney>true</ExtraJourney>
 <FramedVehicleJourneyRef><DataFrameRef>2026-11-20</DataFrameRef><DatedVehicleJourneyRef>ch:1:sjyid:100001:extra</DatedVehicleJourneyRef></FramedVehicleJourneyRef>
</EstimatedVehicleJourney>
</EstimatedJourneyVersionFrame></EstimatedTimetableDelivery></ServiceDelivery></Siri>"#;

    #[test]
    fn snapshot_from_both_feeds() {
        use crate::gtfsrt::enc::*;
        let (tt, ids) = bern();
        let m = Matcher::new(&tt);
        let fri = day("2026-11-20");
        let mut b = LiveSnapshotBuilder::new();

        let c = b.add_siri_et(&tt, &m, SIRI.as_bytes()).unwrap();
        assert_eq!(c, MatchCounts { journeys: 3, by_trip_id: 0, by_journey_id: 1, by_fallback: 1, unmatched: 1, extras: 0 });

        // GTFS-RT knows the IC too (with the planned stop id, i.e. no platform
        // change) and one more bus.
        let mut feed = header(1_795_211_721, "test");
        feed.extend(entity("e1", &[s(1, "ic733.fri"), s(3, "20261120"), i(4, 0)], &[stu(3, "ch:1:sloid:7000:4:7", Some(0), Some(0), 0)]));
        feed.extend(entity("e2", &[s(1, "bus101.3"), s(3, "20261120"), i(4, 0)], &[stu(1, "ch:1:sloid:76646:0:1", None, Some(240), 0)]));
        let c = b.add_gtfs_rt(&tt, &m, &feed).unwrap();
        assert_eq!((c.journeys, c.by_trip_id, c.unmatched), (2, 2, 0));
        assert_eq!((b.len(), b.duplicates), (3, 1));

        let snap = b.build();
        assert_eq!(snap.len(), 3);
        assert_eq!(snap.feeds.len(), 2);
        assert_eq!(snap.timestamp(), 1_795_211_721);

        // The IC keeps SIRI's data: 5 min late out of Genève, track 5 in Bern.
        let ic = snap.trip(fri, ids.ic).unwrap();
        assert_eq!(ic.dep_delay, vec![300, 300, 120, 120]);
        assert_eq!(ic.arr_delay, vec![0, 300, 240, 120]);
        assert_eq!(ic.quay, vec![NONE, NONE, ids.bern5, NONE]);
        assert_eq!(ic.observed_pos, 0);
        assert_eq!(snap.platform_changes(fri, ids.ic), &[(2, "7".to_string(), "5".to_string())]);
        assert!(snap.platform_changes(fri, ids.bus).is_empty());

        // Same trip on another day, or another trip: nothing.
        assert!(snap.trip(fri + 1, ids.ic).is_none());
        assert!(snap.trip(fri, ids.ic_sat).is_none());
        assert!(snap.trip(fri, ids.night).is_none());

        // The cancelled bus (2 h "late") does not count towards max_delay.
        let bus = snap.trip(fri, ids.bus).unwrap();
        assert!(bus.cancelled && bus.dep_delay[0] == 7200);
        assert_eq!(snap.trip(fri, ids.bus + 2).unwrap().dep_delay, vec![240, 240, 240]);
        assert_eq!(snap.max_delay(), 300);
        assert!(snap.late_trips().is_empty());
        assert_eq!(snap.common_max_delay(), 300);

        let view: &dyn LiveView = &snap;
        assert_eq!(view.trip(fri, ids.ic).unwrap().dep_delay_at(0), 300);
    }

    #[test]
    fn extra_journeys_are_kept() {
        let doc = r#"<Siri><ServiceDelivery><ResponseTimestamp>2026-11-20T21:55:05Z</ResponseTimestamp>
<EstimatedTimetableDelivery><EstimatedJourneyVersionFrame>
<EstimatedVehicleJourney><RecordedAtTime>2026-11-20T21:54:00Z</RecordedAtTime><ExtraJourney>true</ExtraJourney>
 <VehicleMode>bus</VehicleMode><PublishedLineName>EV</PublishedLineName>
 <FramedVehicleJourneyRef><DataFrameRef>2026-11-20</DataFrameRef><DatedVehicleJourneyRef>ch:1:sjyid:100001:ev-1</DatedVehicleJourneyRef></FramedVehicleJourneyRef>
 <RecordedCalls><RecordedCall><StopPointRef>ch:1:sloid:1008</StopPointRef>
  <AimedDepartureTime>2026-11-20T21:40:00Z</AimedDepartureTime><ActualDepartureTime>2026-11-20T21:42:00Z</ActualDepartureTime></RecordedCall></RecordedCalls>
 <EstimatedCalls>
  <EstimatedCall><StopPointRef>ch:1:sloid:99999999</StopPointRef><AimedArrivalTime>2026-11-20T22:00:00Z</AimedArrivalTime></EstimatedCall>
  <EstimatedCall><StopPointRef>ch:1:sloid:7000</StopPointRef><AimedArrivalTime>2026-11-20T22:20:00Z</AimedArrivalTime><ExpectedArrivalTime>2026-11-20T22:23:00Z</ExpectedArrivalTime></EstimatedCall>
 </EstimatedCalls>
</EstimatedVehicleJourney>
</EstimatedJourneyVersionFrame></EstimatedTimetableDelivery></ServiceDelivery></Siri>"#;
        let (tt, _) = bern();
        let m = Matcher::new(&tt);
        let mut b = LiveSnapshotBuilder::new();
        let c = b.add_siri_et(&tt, &m, doc.as_bytes()).unwrap();
        assert_eq!((c.unmatched, c.extras), (1, 1));
        let snap = b.build();
        let e = snap.extra("extra:ch:1:sjyid:100001:ev-1").expect("kept");
        assert_eq!(snap.extras().len(), 1);
        assert_eq!((e.line.as_str(), e.mode), ("EV", Some(kante_core::Mode::Bus)));
        assert_eq!(e.calls.len(), 2, "the call at an unknown stop is left out");
        assert_eq!((e.observed_pos, e.observed_kind), (0, OBSERVED_DEP));
        assert_eq!(e.calls[1].arr, Some(1_795_213_380), "expected, not aimed");
        assert_eq!(e.headsign, tt.stations[e.calls[1].station as usize].name);
    }

    #[test]
    fn gtfs_rt_merges_newer_forecasts_stop_by_stop() {
        use crate::gtfsrt::enc::*;
        let (tt, ids) = bern();
        let m = Matcher::new(&tt);
        let fri = day("2026-11-20");
        let ic_report = |ts: i64| {
            let mut feed = header(1_795_211_721, "test");
            // A delay-only update from Bern on: 7 min late in, 6 min late out.
            feed.extend(entity("e1", &[s(1, "ic733.fri"), s(3, "20261120"), i(4, 0)], &[stu(3, "ch:1:sloid:7000:4:7", Some(420), Some(360), 0), i(4, ts)]));
            feed
        };

        // Updated after SIRI-ET (21:54:00): its forecasts win from Bern on.
        let mut b = LiveSnapshotBuilder::new();
        b.add_siri_et(&tt, &m, SIRI.as_bytes()).unwrap();
        b.add_gtfs_rt(&tt, &m, &ic_report(1_795_211_700)).unwrap();
        let snap = b.build();
        let ic = snap.trip(fri, ids.ic).unwrap();
        assert_eq!(ic.dep_delay, vec![300, 300, 360, 360], "measured departure kept, Lausanne keeps SIRI's forecast");
        assert_eq!(ic.arr_delay, vec![0, 300, 420, 360]);
        assert_eq!((ic.observed_pos, ic.observed_kind), (0, OBSERVED_DEP));
        assert_eq!(ic.quay, vec![NONE, NONE, ids.bern5, NONE], "SIRI's platform change stays");
        assert_eq!(snap.platform_changes(fri, ids.ic), &[(2, "7".to_string(), "5".to_string())]);
        assert_eq!(ic.sources, SOURCE_SIRI_ET | SOURCE_GTFS_RT);
        assert_eq!(ic.updated_at, 1_795_211_700);

        // Updated before SIRI-ET: nothing changes.
        let mut b = LiveSnapshotBuilder::new();
        b.add_siri_et(&tt, &m, SIRI.as_bytes()).unwrap();
        b.add_gtfs_rt(&tt, &m, &ic_report(1_795_211_600)).unwrap();
        let snap = b.build();
        let ic = snap.trip(fri, ids.ic).unwrap();
        assert_eq!(ic.dep_delay, vec![300, 300, 120, 120]);
        assert_eq!(ic.sources, SOURCE_SIRI_ET);
    }

    #[test]
    fn merged_forecast_never_goes_back_in_time() {
        let (tt, ids) = bern();
        let fri = day("2026-11-20");
        let n = tt.pattern_stops(tt.trips[ids.ic as usize].pattern).len();
        let mk = |arr: Vec<i32>, dep: Vec<i32>, at: i64| MatchedTrip {
            date: fri,
            trip: ids.ic,
            live: TripLive { arr_delay: arr, dep_delay: dep, observed_pos: -1, updated_at: at, ..Default::default() },
            platform_changes: vec![],
            method: MatchMethod::TripId,
            calls: n as u16,
            aligned: n as u16,
            on_schedule: n as u16,
            implausible: 0,
            own_timestamp: true,
            first_reported: 0,
        };
        let mut b = LiveSnapshotBuilder::new();
        let mut first = mk(vec![0, 600, 600, 600], vec![600, 600, 600, 600], 100);
        first.live.observed_pos = 1;
        first.live.observed_kind = kante_core::OBSERVED_ARR;
        b.push(first);
        // A newer report that would have the train leave Lausanne before it arrived there.
        assert_eq!(b.merge_forecasts(&tt, mk(vec![0, 0, 0, 0], vec![0, -60_000, 0, 0], 200)), Merge::Merged);
        let snap = b.build();
        let ic = snap.trip(fri, ids.ic).unwrap();
        let times = tt.trip_times(ids.ic);
        assert_eq!(ic.arr_delay[1], 600, "measured arrival stays");
        let left = times[3] as i64 + ic.dep_delay[1] as i64;
        assert!(left >= times[2] as i64 + 600, "departure from Lausanne not before the measured arrival");
        for p in 1..n {
            assert!(times[2 * p] as i64 + ic.arr_delay[p] as i64 >= times[2 * p - 1] as i64 + ic.dep_delay[p - 1] as i64);
        }
    }

    #[test]
    fn push_replaces_and_empty_snapshot() {
        let (tt, ids) = bern();
        let fri = day("2026-11-20");
        let n = tt.pattern_stops(tt.trips[ids.bus as usize].pattern).len();
        let mk = |delay: i32, changes: Vec<(u16, String, String)>| MatchedTrip {
            date: fri,
            trip: ids.bus,
            live: TripLive { arr_delay: vec![delay; n], dep_delay: vec![delay; n], observed_pos: -1, ..Default::default() },
            platform_changes: changes,
            method: MatchMethod::JourneyId,
            calls: 3,
            aligned: 3,
            on_schedule: 3,
            implausible: 0,
            own_timestamp: true,
            first_reported: 0,
        };
        let mut b = LiveSnapshotBuilder::with_capacity(4);
        b.push(mk(60, vec![(0, "A".into(), "C".into())]));
        assert!(!b.push_if_absent(mk(600, vec![])));
        b.push(mk(-30, vec![]));
        b.push(MatchedTrip { trip: ids.ic, ..mk(9000, vec![]) });
        b.push(MatchedTrip { trip: ids.night, ..mk(1200, vec![]) });
        b.push(MatchedTrip { trip: ids.bus + 1, ..mk(240, vec![]) });
        let snap = b.build();
        assert_eq!(snap.max_delay(), 9000);
        assert_eq!(snap.late_trips(), &[(fri, ids.ic, 9000), (fri, ids.night, 1200)]);
        assert_eq!(snap.common_max_delay(), 240);
        assert_eq!(snap.trip(fri, ids.bus).unwrap().dep_delay_at(1), -30);
        assert!(snap.platform_changes(fri, ids.bus).is_empty(), "a newer report without change clears the old one");

        let empty = LiveSnapshotBuilder::new().build();
        assert!(empty.is_empty() && empty.max_delay() == 0 && empty.timestamp() == 0);
        assert!(empty.trip(fri, 0).is_none());
    }
}
