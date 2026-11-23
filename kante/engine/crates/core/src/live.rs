//! Real-time overlay contract between the server (which owns the live store,
//! fed by `kante-rt`) and the router (`kante-raptor`).

use crate::time::{Date, Secs};
use crate::timetable::{Mode, PatternIdx, StationIdx, StopIdx, Timetable, TripIdx};

/// Live state of one trip on one service date. Vectors are indexed by stop
/// position in the trip's pattern and have `n_stops` entries unless noted.
#[derive(Clone, Debug, Default)]
pub struct TripLive {
    pub cancelled: bool,
    /// Seconds to add to the scheduled arrival / departure (may be negative).
    pub arr_delay: Vec<i32>,
    pub dep_delay: Vec<i32>,
    /// Stop positions not served today. Empty = all served.
    pub skipped: Vec<bool>,
    /// Boarding point actually used per position, `NONE` where unchanged.
    /// Empty = no changes.
    pub quay: Vec<StopIdx>,
    /// Last position for which a *measured* time was reported, -1 if none:
    /// everything after it is a forecast.
    pub observed_pos: i16,
    /// What was measured at `observed_pos`: [`OBSERVED_ARR`] and/or
    /// [`OBSERVED_DEP`]. A measured arrival alone does not mean the vehicle has left.
    pub observed_kind: u8,
    /// First position with a time from the feed, -1 if none. Times before it
    /// are the timetable's, not live (see [`TripLive::is_live_at`]).
    pub first_live: i16,
    /// Unix time the source last updated this trip.
    pub updated_at: i64,
    /// Feeds that contributed: [`SOURCE_SIRI_ET`] | [`SOURCE_GTFS_RT`].
    pub sources: u8,
    /// The operator flags the forecast as unreliable (SIRI `PredictionInaccurate`).
    pub inaccurate: bool,
    /// The vehicle is in a traffic jam (SIRI `InCongestion`).
    pub congestion: bool,
}

pub const OBSERVED_ARR: u8 = 1;
pub const OBSERVED_DEP: u8 = 2;
pub const SOURCE_SIRI_ET: u8 = 1;
pub const SOURCE_GTFS_RT: u8 = 2;

impl TripLive {
    #[inline]
    pub fn arr_delay_at(&self, pos: usize) -> Secs {
        self.arr_delay.get(pos).copied().unwrap_or(0)
    }
    #[inline]
    pub fn dep_delay_at(&self, pos: usize) -> Secs {
        self.dep_delay.get(pos).copied().unwrap_or(0)
    }
    /// Whether the time at `pos` comes from the feed (reported, or carried
    /// on from an earlier report) rather than the timetable.
    #[inline]
    pub fn is_live_at(&self, pos: usize) -> bool {
        self.first_live >= 0 && pos >= self.first_live as usize
    }
    #[inline]
    pub fn is_skipped(&self, pos: usize) -> bool {
        self.cancelled || self.skipped.get(pos).copied().unwrap_or(false)
    }
}

/// A journey the live feed reports that is not in the timetable: a
/// replacement bus, an extra train. It exists only while the feed carries it
/// and cannot be planned with; it can be shown, tracked and found at a stop.
#[derive(Clone, Debug, Default)]
pub struct ExtraTrip {
    /// `extra:<journey reference of the feed>`.
    pub id: String,
    /// Operating day.
    pub date: Date,
    /// Line as published ("EV", "S 1", "IC 8").
    pub line: String,
    pub mode: Option<Mode>,
    pub headsign: String,
    pub cancelled: bool,
    /// Calls at stops the timetable knows, in order (calls elsewhere are left out).
    pub calls: Vec<ExtraCall>,
    /// Last call with a measured time, -1 if none; see [`TripLive::observed_kind`].
    pub observed_pos: i16,
    pub observed_kind: u8,
    pub updated_at: i64,
    pub inaccurate: bool,
    pub congestion: bool,
}

#[derive(Clone, Debug)]
pub struct ExtraCall {
    pub station: StationIdx,
    /// The boarding point, or the station's first stop when the feed names none.
    pub stop: StopIdx,
    /// Platform name as the feed gives it, may be empty.
    pub platform: String,
    /// Unix seconds. `arr`/`dep` are the live times (measured, else forecast, else aimed).
    pub aimed_arr: Option<i64>,
    pub aimed_dep: Option<i64>,
    pub arr: Option<i64>,
    pub dep: Option<i64>,
    pub skipped: bool,
}

impl ExtraCall {
    /// Live arrival, else live departure.
    pub fn at(&self) -> Option<i64> {
        self.arr.or(self.dep)
    }
    /// Live departure, else live arrival.
    pub fn leaves(&self) -> Option<i64> {
        self.dep.or(self.arr)
    }
}

/// An immutable snapshot of live data. The server swaps in a new snapshot
/// after every poll; queries hold one snapshot for their whole run.
pub trait LiveView: Send + Sync {
    /// Live state of `trip` on service date `date`, if any is known.
    fn trip(&self, date: Date, trip: TripIdx) -> Option<&TripLive>;
    /// Upper bound on any positive departure delay in the snapshot. The router
    /// uses it to look back for late-running trips that are still catchable.
    fn max_delay(&self) -> Secs;
    /// Finer bounds for the trips of service date `date` (see [`DelayBounds`]),
    /// so that one very late train does not make every lookup look back as
    /// far as [`LiveView::max_delay`]. The router uses the smaller of the two.
    /// The default claims live data everywhere, delayed up to `max_delay`.
    fn delay_bounds(&self, _date: Date) -> DelayBounds<'_> {
        DelayBounds { max: self.max_delay().max(0), pattern: &[], stop: &[] }
    }
    /// Journeys that are not in the timetable (see [`ExtraTrip`]).
    fn extras(&self) -> &[ExtraTrip] {
        &[]
    }
    /// One of [`LiveView::extras`] by its id.
    fn extra(&self, id: &str) -> Option<&ExtraTrip> {
        self.extras().iter().find(|e| e.id == id)
    }
}

/// In [`DelayBounds`] slices: no trip there has live data.
pub const NO_LIVE: Secs = Secs::MIN;

/// Delay bounds of the live trips of one service date. Each bound is at
/// least `max(0, dep_delay_at(i))` for every position `i` of every trip it
/// covers, cancelled trips and skipped positions included; `NO_LIVE` (or
/// `max == NO_LIVE` for the whole date) means no trip it covers has live data.
#[derive(Clone, Copy, Debug)]
pub struct DelayBounds<'a> {
    /// Over all trips of the date.
    pub max: Secs,
    /// Per pattern, over its trips; empty = unknown (use `max`).
    pub pattern: &'a [Secs],
    /// Per stop, over the trips calling there, at the positions where they
    /// call there; empty = unknown (use `max`).
    pub stop: &'a [Secs],
}

impl DelayBounds<'_> {
    /// No live data on the date.
    pub const NONE: DelayBounds<'static> = DelayBounds { max: NO_LIVE, pattern: &[], stop: &[] };

    /// Whether any trip of the date has live data.
    #[inline]
    pub fn any(&self) -> bool {
        self.max != NO_LIVE
    }
    /// Bound for the trips of pattern `p`, `None` if none of them has live data.
    #[inline]
    pub fn pattern(&self, p: PatternIdx) -> Option<Secs> {
        Self::get(self.max, self.pattern, p as usize)
    }
    /// Bound for the trips calling at stop `s`, `None` if none of them has live data.
    #[inline]
    pub fn stop(&self, s: StopIdx) -> Option<Secs> {
        Self::get(self.max, self.stop, s as usize)
    }
    #[inline]
    fn get(max: Secs, v: &[Secs], i: usize) -> Option<Secs> {
        if max == NO_LIVE {
            return None;
        }
        // A bound is never negative: the router subtracts it to look back.
        match v.get(i) {
            Some(&NO_LIVE) => None,
            Some(&b) => Some(b.max(0)),
            None => Some(max.max(0)),
        }
    }
    /// Drops per-pattern / per-stop bounds that were not built for a
    /// timetable with these sizes.
    pub fn fit(mut self, n_patterns: usize, n_stops: usize) -> Self {
        if self.pattern.len() != n_patterns {
            self.pattern = &[];
        }
        if self.stop.len() != n_stops {
            self.stop = &[];
        }
        self
    }
}

/// [`DelayBounds`] for every service date of a set of live trips; what a
/// [`LiveView`] returns from [`LiveView::delay_bounds`].
#[derive(Clone, Debug, Default)]
pub struct DelayIndex {
    /// `(date, max, per pattern, per stop)`; snapshots span a few dates.
    dates: Vec<(Date, Secs, Vec<Secs>, Vec<Secs>)>,
}

impl DelayIndex {
    /// Dates that get per-pattern and per-stop bounds. Those cost memory per
    /// date (4 bytes per pattern and stop); a feed normally spans two or three.
    pub const MAX_DATES: usize = 8;

    /// Bounds of `trips`. Without a timetable (or for a date with a trip it
    /// does not know) only the per-date maximum is kept; the same goes for all
    /// but the [`Self::MAX_DATES`] dates with most live trips.
    pub fn build<'a, I>(tt: Option<&Timetable>, trips: I) -> Self
    where
        I: IntoIterator<Item = (Date, TripIdx, &'a TripLive)>,
        I::IntoIter: Clone,
    {
        let trips = trips.into_iter();
        let mut counts: Vec<(Date, usize)> = Vec::new();
        for (date, _, _) in trips.clone() {
            match counts.iter_mut().find(|c| c.0 == date) {
                Some(c) => c.1 += 1,
                None => counts.push((date, 1)),
            }
        }
        counts.sort_unstable_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        counts.truncate(Self::MAX_DATES);
        let mut ix = DelayIndex::default();
        let mut unknown: Vec<Date> = Vec::new();
        for (date, trip, l) in trips {
            let k = match ix.dates.iter().position(|e| e.0 == date) {
                Some(k) => k,
                None => {
                    let (np, ns) = match tt {
                        Some(tt) if counts.iter().any(|c| c.0 == date) => (tt.patterns.len(), tt.stops.len()),
                        _ => (0, 0),
                    };
                    ix.dates.push((date, 0, vec![NO_LIVE; np], vec![NO_LIVE; ns]));
                    ix.dates.len() - 1
                }
            };
            let e = &mut ix.dates[k];
            let worst = l.dep_delay.iter().copied().max().unwrap_or(0).max(0);
            e.1 = e.1.max(worst);
            let Some(tt) = tt else { continue };
            if e.2.is_empty() {
                continue;
            }
            let Some(t) = tt.trips.get(trip as usize) else {
                if !unknown.contains(&date) {
                    unknown.push(date);
                }
                continue;
            };
            let p = t.pattern;
            e.2[p as usize] = e.2[p as usize].max(worst);
            for (i, &s) in tt.pattern_stops(p).iter().enumerate() {
                let b = &mut e.3[s as usize];
                *b = (*b).max(l.dep_delay_at(i).max(0));
            }
        }
        for e in &mut ix.dates {
            if tt.is_none() || unknown.contains(&e.0) {
                e.2 = Vec::new();
                e.3 = Vec::new();
            }
        }
        ix
    }

    pub fn get(&self, date: Date) -> DelayBounds<'_> {
        match self.dates.iter().find(|e| e.0 == date) {
            Some((_, max, pattern, stop)) => DelayBounds { max: *max, pattern, stop },
            None => DelayBounds::NONE,
        }
    }
}
