//! Real-time overlay contract between the server (which owns the live store,
//! fed by `kante-rt`) and the router (`kante-raptor`).

use crate::time::{Date, Secs};
use crate::timetable::{Mode, StationIdx, StopIdx, TripIdx};

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
    /// Journeys that are not in the timetable (see [`ExtraTrip`]).
    fn extras(&self) -> &[ExtraTrip] {
        &[]
    }
    /// One of [`LiveView::extras`] by its id.
    fn extra(&self, id: &str) -> Option<&ExtraTrip> {
        self.extras().iter().find(|e| e.id == id)
    }
}
