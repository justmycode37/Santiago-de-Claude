//! The immutable live overlay the router queries.
//!
//! One snapshot is built per poll from the matched journeys and swapped in as
//! a whole (`Arc<LiveSnapshot>`); queries keep the snapshot they started with.

use crate::matcher::{MatchMethod, MatchedTrip, Matcher};
use crate::model::{FeedMeta, RtJourney};
use kante_core::time::{Date, Secs};
use kante_core::{LiveView, Timetable, TripIdx, TripLive};
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

/// What happened to the journeys of one feed document.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MatchCounts {
    pub journeys: usize,
    pub by_trip_id: usize,
    pub by_journey_id: usize,
    pub by_fallback: usize,
    pub unmatched: usize,
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
            Some(m) => {
                match m.method {
                    MatchMethod::TripId => counts.by_trip_id += 1,
                    MatchMethod::JourneyId => counts.by_journey_id += 1,
                    MatchMethod::Fallback => counts.by_fallback += 1,
                }
                if primary {
                    self.push(m);
                } else {
                    self.push_if_absent(m);
                }
            }
            None => counts.unmatched += 1,
        }
    }

    /// Parse a SIRI-ET document (gzip or plain) and add every journey that matches.
    pub fn add_siri_et<R: std::io::BufRead>(&mut self, tt: &Timetable, matcher: &Matcher, r: R) -> anyhow::Result<MatchCounts> {
        let mut counts = MatchCounts::default();
        let meta = crate::siri::parse_siri_et_auto(r, |j| self.add_journey(tt, matcher, &j, true, &mut counts))?;
        self.feed(meta);
        Ok(counts)
    }

    /// Decode a GTFS-RT document and add every trip that matches and has no
    /// live data yet.
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
        assert_eq!(c, MatchCounts { journeys: 3, by_trip_id: 0, by_journey_id: 1, by_fallback: 1, unmatched: 1 });

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
