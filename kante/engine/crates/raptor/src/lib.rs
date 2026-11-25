//! kante-raptor — query-time transit engine on a [`kante_core::Timetable`]:
//! journey search (range RAPTOR), departure boards, vehicles under way.
//! The public API is fixed in `docs/ARCHITECTURE.md`.
//!
//! Per-date data (trips of the day, departure columns, stop departure lists;
//! ~30 MB and a few tens of milliseconds per date on the national feed) is
//! built on first use and kept for the most recently used dates; see
//! [`Router::warm_up`].
//!
//! # Semantics worth knowing
//!
//! - **Rounds**: at most `min(max_transfers + 1, MAX_RIDES)` rides. An in-seat
//!   continuation does not count as a ride.
//! - **Range queries** (`window > 0`) run one RAPTOR iteration per distinct
//!   origin departure, latest first, keeping labels between iterations
//!   (rRAPTOR). The result is the Pareto set over (departure ↑, arrival ↓,
//!   rides ↓) of the journeys leaving inside the window. A journey that is
//!   beaten by simply walking to one of the access stops and boarding there is
//!   never returned, even when that better journey leaves after the window.
//! - **`window == 0`**: one earliest-arrival search from `from`; every returned
//!   journey reports the departure of its own first ride minus the access time.
//! - **Access stops** are taken as given: no footpath is walked before the
//!   first ride (the caller's access list is the complete set of first stops).
//!   A ride that passes an access stop at a time the traveller could have
//!   walked there and boarded the same vehicle ends there for the search:
//!   "ride one stop back to catch the bus that leaves from where you are" is
//!   never returned.
//! - **Changes** use at most one footpath between two rides (no chaining).
//!   Walking seconds are `ceil(walk_secs(var_m, fix_s, speed))`.
//! - **Live data**: times are scheduled + delay. Inside a pattern a trip is
//!   boarded by earliest live departure; trips are assumed to run at most
//!   [`EARLY_SLACK`] seconds early. When delays make trips of one pattern
//!   overtake each other *after* the boarding stop, the earlier-leaving trip
//!   is still the one taken (the result is feasible, in rare cases not the
//!   fastest). A trip that skips stops further on does not hide the following
//!   trips of its pattern. `TripLive::quay` (changed boarding point) is not
//!   used for routing.
//! - **On-board start**: `window` and `access` are ignored. The first leg is
//!   `Ride { onboard: true, from_pos: next_pos, dep: q.from, .. }` and
//!   `Journey::dep == q.from`. Arrival times of the on-board trip are clamped
//!   to `q.from` from below. A cancellation flag on the trip the traveller is
//!   sitting in is ignored (skipped positions are honoured).
//! - **Target pruning**: labels that cannot beat the best arrival found so far
//!   even on the fastest path to the destination are dropped (see
//!   `lower_bounds.rs`). That changes nothing, except where live times step
//!   back: an in-seat continuation is followed when its *scheduled* departure
//!   is not before the scheduled arrival, so with live data it can leave
//!   before the trip feeding it arrives (a late trip continuing as one the
//!   feed has no delay, or a smaller one, for). A journey that relies on
//!   such a step may be pruned.

mod days;
mod departures;
mod footpaths;
mod ids;
mod lower_bounds;
mod plan;
#[cfg(feature = "stats")]
pub use plan::stats;
mod vehicles;

#[cfg(test)]
mod tests;
#[cfg(test)]
pub(crate) mod testutil;

use kante_core::geo::BBox;
use kante_core::time::{Date, Secs};
use kante_core::{Footpaths, LiveView, Mode, StopIdx, Timetable, TripIdx};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, OnceLock};

pub use footpaths::crowfly_footpaths;

/// Upper limit on rides per journey (`max_transfers` is clamped to `MAX_RIDES - 1`). Remote places need many: two
/// town buses to the station, three trains and three valley buses are eight rides, and with seven the planner
/// answered with a journey a day later. A round is only run while the one before it still improved a stop that can
/// beat the best arrival, so the rounds a query does not need cost it nothing.
pub const MAX_RIDES: usize = 15;
/// With live data a trip is assumed to leave at most this many seconds before schedule.
pub const EARLY_SLACK: Secs = 300;
/// Bitmask with every [`Mode`] allowed.
pub const ALL_MODES: u16 = (1 << Mode::ALL.len()) - 1;

pub struct Router {
    tt: Arc<Timetable>,
    /// Earliest and latest time of any trip of each pattern (service-day seconds).
    pat_span: Vec<(Secs, Secs)>,
    /// Bitset over trips: has at least one in-seat continuation.
    has_cont: Vec<u64>,
    days: days::DayCache,
    ids: OnceLock<ids::IdMaps>,
    pat_bbox: OnceLock<Vec<BBox>>,
    /// Per pattern stop (`Timetable::pattern_stops` order): the box around the way to the next stop, where it is
    /// known (`set_shape_boxes`); a vehicle on a bend is found in a window its straight stop-to-stop line misses.
    hop_bbox: OnceLock<Vec<BBox>>,
    /// Minimum-travel-time graph for target pruning (see `lower_bounds.rs`).
    lb_graph: lower_bounds::Graph,
    target_bounds: AtomicBool,
}

impl Router {
    pub fn new(tt: Arc<Timetable>) -> Self {
        let pat_span = tt
            .patterns
            .iter()
            .map(|p| {
                if p.n_trips == 0 {
                    return (0, 0);
                }
                // Trips are sorted and do not overtake: the first and the last row bound all others.
                let n2 = 2 * p.n_stops as usize;
                let first = &tt.times[p.times_off as usize..p.times_off as usize + n2];
                let last_off = p.times_off as usize + (p.n_trips as usize - 1) * n2;
                let last = &tt.times[last_off..last_off + n2];
                (*first.iter().min().unwrap(), *last.iter().max().unwrap())
            })
            .collect();
        let mut has_cont = vec![0u64; tt.trips.len() / 64 + 1];
        for c in &tt.continuations {
            has_cont[c.from as usize >> 6] |= 1 << (c.from & 63);
        }
        let lb_graph = lower_bounds::Graph::new(&tt);
        Router { tt, pat_span, has_cont, days: days::DayCache::default(), ids: OnceLock::new(), pat_bbox: OnceLock::new(), hop_bbox: OnceLock::new(), lb_graph, target_bounds: AtomicBool::new(true) }
    }

    /// Switch target pruning with per-stop lower bounds on or off (on by
    /// default). Results are the same either way (but see "Target pruning"
    /// above); this exists for testing and measuring.
    pub fn set_target_bounds(&self, on: bool) {
        self.target_bounds.store(on, std::sync::atomic::Ordering::Relaxed);
    }

    /// Build now what target pruning derives from a footpath set, e.g. at
    /// server start, so that the first query using the set does not pay for
    /// it. The result is cached in `fp`: a set that is changed in place
    /// afterwards must have its `derived` slot replaced by a new one.
    pub fn prepare_footpaths(&self, fp: &Footpaths) {
        self.lb_graph.prepare(fp);
    }

    /// Bytes held by the lower-bound graph.
    pub fn target_bounds_bytes(&self) -> usize {
        self.lb_graph.heap_bytes()
    }

    pub fn timetable(&self) -> &Arc<Timetable> {
        &self.tt
    }

    /// Pareto-optimal journeys (arrival time vs. number of rides) for every
    /// departure in `[q.from, q.from + q.window]`, sorted by departure.
    pub fn plan(&self, q: &Query) -> Vec<Journey> {
        plan::plan(self, q)
    }

    /// Next departures from any of `stops`, sorted by live departure time.
    /// Cancelled trips (and calls skipped today) are included with `cancelled`.
    pub fn departures(&self, stops: &[StopIdx], date: Date, from: Secs, limit: usize, live: Option<&dyn LiveView>) -> Vec<DepartureEvent> {
        departures::departures(self, stops, date, from, limit, live)
    }

    /// Trips under way inside `bbox` at `now` (service-day seconds of `date`).
    pub fn vehicles(&self, bbox: &BBox, date: Date, now: Secs, live: Option<&dyn LiveView>) -> Vec<VehicleSeg> {
        vehicles::vehicles(self, bbox, date, now, live)
    }

    pub fn find_trip(&self, gtfs_trip_id: &str) -> Option<TripIdx> {
        self.id_maps().find_trip(&self.tt, gtfs_trip_id)
    }

    /// Trips carrying this Swiss journey id (several GTFS variants can share one).
    pub fn find_sjyid(&self, sjyid: &str) -> &[TripIdx] {
        self.id_maps().find_sjyid(&self.tt, sjyid)
    }

    /// Build the lazily initialised parts now (id maps, pattern boxes, the day
    /// indices around `date`), e.g. at server start, so the first request does
    /// not pay for them.
    pub fn warm_up(&self, date: Date) {
        self.id_maps();
        self.pattern_boxes();
        let set = self.days.set(&self.tt, &self.pat_span, date);
        for d in &set.days {
            d.under_way(&self.tt);
        }
    }

    fn id_maps(&self) -> &ids::IdMaps {
        self.ids.get_or_init(|| ids::IdMaps::build(&self.tt))
    }

    fn pattern_boxes(&self) -> &[BBox] {
        self.pat_bbox.get_or_init(|| vehicles::pattern_boxes(&self.tt))
    }

    /// The boxes around the ways vehicles take (per pattern, and per pattern stop to the next one; empty where not
    /// known), for `vehicles`: a pattern's box grows to hold its way. Before the first `vehicles` or `warm_up`;
    /// false (and nothing changed) after.
    pub fn set_shape_boxes(&self, pattern: Vec<BBox>, hops: Vec<BBox>) -> bool {
        if self.pat_bbox.get().is_some() || pattern.len() != self.tt.patterns.len() || hops.len() != self.tt.pattern_stops.len() {
            return false;
        }
        let mut boxes = vehicles::pattern_boxes(&self.tt);
        for (b, s) in boxes.iter_mut().zip(&pattern) {
            if s.min.lat <= s.max.lat {
                b.extend(&s.min);
                b.extend(&s.max);
            }
        }
        self.pat_bbox.set(boxes).is_ok() && self.hop_bbox.set(hops).is_ok()
    }

    fn hop_boxes(&self) -> Option<&[BBox]> {
        self.hop_bbox.get().map(|v| v.as_slice())
    }

    #[inline]
    fn trip_has_cont(&self, t: TripIdx) -> bool {
        (self.has_cont[t as usize >> 6] >> (t & 63)) & 1 == 1
    }
}

#[derive(Clone, Copy)]
pub struct Query<'a> {
    /// Service date that all `Secs` in the query and the answer are relative to.
    pub date: Date,
    /// Earliest time to leave the origin.
    pub from: Secs,
    /// Length of the departure window; 0 = one earliest-arrival search.
    pub window: Secs,
    /// Latest acceptable arrival at the destination; later journeys are
    /// neither returned nor explored.
    pub max_arr: Option<Secs>,
    /// (stop, seconds needed to reach it from the origin). Ignored when `onboard` is set.
    pub access: &'a [(StopIdx, Secs)],
    /// For access stops the traveller would rather not walk to (farther than they like to walk): the seconds a
    /// journey that starts at `access[i]` counts as leaving earlier than it does (empty: none). Such a journey is
    /// compared, and returned, with that departure (`Journey::dep`, `Leg::Access::dep`): it is in the answer only
    /// where no journey from another stop leaves after it and arrives as early. What can be caught at the stop is
    /// decided by the walk alone. The other end's counterpart needs no field: seconds added to a stop of `egress`.
    pub access_late: &'a [Secs],
    /// (stop, seconds from it to the destination).
    pub egress: &'a [(StopIdx, Secs)],
    pub onboard: Option<Onboard>,
    pub footpaths: &'a Footpaths,
    pub walk_speed: f32,
    /// Added to every change of vehicle on top of the walking time.
    pub transfer_margin: Secs,
    /// Footpaths longer than this (at `walk_speed`) are not used.
    pub max_walk: Secs,
    pub max_transfers: u8,
    /// Allowed modes as a bitmask of `Mode::bit()`.
    pub modes: u16,
    pub live: Option<&'a dyn LiveView>,
}

impl<'a> Query<'a> {
    /// A query with common defaults: no window, 1.3 m/s, 120 s margin, walks up
    /// to 15 min, 5 transfers, all modes, no live data.
    pub fn new(date: Date, from: Secs, access: &'a [(StopIdx, Secs)], egress: &'a [(StopIdx, Secs)], footpaths: &'a Footpaths) -> Self {
        Query {
            date,
            from,
            window: 0,
            max_arr: None,
            access,
            access_late: &[],
            egress,
            onboard: None,
            footpaths,
            walk_speed: kante_core::DEFAULT_SPEED_MPS,
            transfer_margin: 120,
            max_walk: 900,
            max_transfers: 5,
            modes: ALL_MODES,
            live: None,
        }
    }
}

/// The traveller sits in `trip` (service date `date`) and its next stop is position `next_pos`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Onboard {
    pub trip: TripIdx,
    pub date: Date,
    pub next_pos: u16,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Journey {
    /// Leave the origin / reach the destination, relative to `Query::date`.
    pub dep: Secs,
    pub arr: Secs,
    pub transfers: u8,
    pub legs: Vec<Leg>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Leg {
    /// Origin → first stop. Absent in on-board plans.
    Access { to: StopIdx, dep: Secs, arr: Secs },
    /// `date` is the trip's own service date; `dep`/`arr` are live-adjusted and
    /// relative to `Query::date`. `stay_seated`: reached by an in-seat
    /// continuation from the previous Ride. `onboard`: the trip the traveller is on.
    Ride { trip: TripIdx, date: Date, from_pos: u16, to_pos: u16, dep: Secs, arr: Secs, stay_seated: bool, onboard: bool },
    /// Walk between two stops (`from == to` for a same-point change; then var_m = fix_s = 0).
    /// `arr - dep` is the pure walking time; the margin is not included.
    Transfer { from: StopIdx, to: StopIdx, dep: Secs, arr: Secs, var_m: u16, fix_s: u16 },
    /// Last stop → destination.
    Egress { from: StopIdx, dep: Secs, arr: Secs },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DepartureEvent {
    pub trip: TripIdx,
    pub date: Date,
    pub pos: u16,
    pub stop: StopIdx,
    /// scheduled and live departure, relative to the `date` argument of `departures`
    pub dep: Secs,
    pub live_dep: Secs,
    pub cancelled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VehicleSeg {
    pub trip: TripIdx,
    pub date: Date,
    /// travelling from position `pos` to `pos + 1`, or dwelling at `pos` when `dwell`
    pub pos: u16,
    pub dwell: bool,
    /// live-adjusted departure at `pos` and arrival at `pos + 1`, relative to the `date` argument
    pub dep: Secs,
    pub arr: Secs,
}
