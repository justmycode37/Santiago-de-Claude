//! Real-time overlay contract between the server (which owns the live store,
//! fed by `kante-rt`) and the router (`kante-raptor`).

use crate::time::{Date, Secs};
use crate::timetable::{StopIdx, TripIdx};

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
    /// Unix time the source last updated this trip.
    pub updated_at: i64,
}

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

/// An immutable snapshot of live data. The server swaps in a new snapshot
/// after every poll; queries hold one snapshot for their whole run.
pub trait LiveView: Send + Sync {
    /// Live state of `trip` on service date `date`, if any is known.
    fn trip(&self, date: Date, trip: TripIdx) -> Option<&TripLive>;
    /// Upper bound on any positive departure delay in the snapshot. The router
    /// uses it to look back for late-running trips that are still catchable.
    fn max_delay(&self) -> Secs;
}
