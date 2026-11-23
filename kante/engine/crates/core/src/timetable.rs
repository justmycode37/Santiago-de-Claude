//! The national timetable in routing-ready form.
//!
//! Vocabulary
//! - **Stop**: the routing unit. Wherever the feed allows it this is one
//!   *boarding point* (atlas "Haltekante": a bus bay, a tram edge, a rail
//!   track, a pier) with its own coordinate. When the feed only names the
//!   stop, the Stop is the stop-level fallback (`Precision::Station`).
//! - **Station**: the group of Stops that share a GTFS parent (one DiDok
//!   number), e.g. "Bern, Bahnhof" with bays A–Z. Used for search and display.
//! - **Pattern**: trips of one line with the identical stop sequence and
//!   pickup/drop-off flags, in which no trip overtakes another (RAPTOR "route").
//! - **Trip**: one scheduled run, valid on the dates of its service calendar.
//!
//! All times are service-day seconds (see [`crate::time`]).

use crate::geo::LatLon;
use crate::time::{Date, Secs};
use serde::{Deserialize, Serialize};

pub type StopIdx = u32;
pub type StationIdx = u32;
pub type PatternIdx = u32;
pub type TripIdx = u32;
pub type LineIdx = u32;
pub type ServiceIdx = u32;
pub type StrIdx = u32;

pub const NONE: u32 = u32::MAX;

/// Schema tag for the cache file; bump on any layout change in this module.
pub const TIMETABLE_SCHEMA: &str = "timetable-v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum Mode {
    Rail = 0,
    Tram = 1,
    Bus = 2,
    Metro = 3,
    Boat = 4,
    Funicular = 5,
    /// Aerial tramway, gondola, chairlift (GTFS 1300); `Line::category` keeps PB/GB/SL.
    Cableway = 6,
    RackRail = 7,
    Lift = 8,
    /// Fixed-stop on-demand bus and taxi services.
    OnDemand = 9,
    Other = 10,
}

impl Mode {
    pub fn bit(self) -> u16 {
        1 << (self as u8)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Rail => "rail",
            Mode::Tram => "tram",
            Mode::Bus => "bus",
            Mode::Metro => "metro",
            Mode::Boat => "boat",
            Mode::Funicular => "funicular",
            Mode::Cableway => "cableway",
            Mode::RackRail => "rack",
            Mode::Lift => "lift",
            Mode::OnDemand => "ondemand",
            Mode::Other => "other",
        }
    }
    pub const ALL: [Mode; 11] = [
        Mode::Rail,
        Mode::Tram,
        Mode::Bus,
        Mode::Metro,
        Mode::Boat,
        Mode::Funicular,
        Mode::Cableway,
        Mode::RackRail,
        Mode::Lift,
        Mode::OnDemand,
        Mode::Other,
    ];
}

/// How well we know where a Stop physically is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Precision {
    /// An individual boarding point with its own coordinate.
    Edge = 0,
    /// The boarding point is identified, but the registry has no coordinate of
    /// its own for it (or it equals the stop point); `pos` is the stop point.
    EdgeAtStation = 1,
    /// The feed only names the stop; `pos` is the stop point.
    Station = 2,
}

/// Getting from the platform into the vehicle (atlas `prm-platform`,
/// `vehicleAccess`). This is about boarding, not about reaching the platform.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum QuayAccess {
    Unknown = 0,
    /// Level boarding without help.
    Autonomous = 1,
    /// Boarding with staff assistance.
    Assisted = 2,
    /// Boarding with assistance that must be booked in advance.
    AssistedOnNotice = 3,
    NotAccessible = 4,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Stop {
    /// GTFS `stop_id` (may be a generated id such as `…_gen:…_pf:5A-C`).
    pub gtfs_id: String,
    /// GTFS `original_stop_id`: the atlas SLOID of the boarding point or stop
    /// (a plain number for some foreign stops). Join key to atlas and real time.
    pub sloid: String,
    pub station: StationIdx,
    /// Best known position: sector centroid > atlas boarding point > GTFS.
    pub pos: LatLon,
    /// Passenger-facing label without sectors: "K1", "7", "" if unsigned.
    pub label: String,
    /// Sector part of a rail platform code: "A-C", "" if none.
    pub sectors: String,
    pub precision: Precision,
    /// Atlas compass direction of the edge in degrees, -1 if unknown.
    pub compass: i16,
    pub access: QuayAccess,
    /// Bitmask of [`Mode::bit`] over the lines that call here.
    pub modes: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Station {
    /// GTFS id of the parent (or of the stop itself if it has no parent).
    pub gtfs_id: String,
    pub name: String,
    pub pos: LatLon,
    /// DiDok/BPUIC number, 0 if unknown.
    pub didok: u32,
    pub stops: Vec<StopIdx>,
    /// Search ranking weight: departures over the feed, weighted by mode.
    pub weight: u32,
    pub modes: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Agency {
    pub gtfs_id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Line {
    pub gtfs_route_id: String,
    /// Public line name: "IC 1", "S3", "10", "N17" (GTFS `route_short_name`).
    pub name: String,
    /// Swiss product category from `route_desc`: IC, IR, RE, S, T, B, BAT, FUN, PB, GB, SL …
    pub category: String,
    pub mode: Mode,
    pub route_type: u16,
    pub agency: u32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Pattern {
    pub line: LineIdx,
    /// Offset into `Timetable::pattern_stops` / `pattern_flags`.
    pub stops_off: u32,
    pub n_stops: u16,
    /// Trips of this pattern are `trips_off .. trips_off + n_trips`, sorted so
    /// that for every stop position times are non-decreasing (no overtaking).
    pub trips_off: u32,
    pub n_trips: u32,
    /// Offset into `Timetable::times` of the first trip's first arrival.
    pub times_off: u64,
}

pub const FLAG_NO_PICKUP: u8 = 1;
pub const FLAG_NO_DROPOFF: u8 = 2;
pub const FLAG_PICKUP_ON_REQUEST: u8 = 4;
pub const FLAG_DROPOFF_ON_REQUEST: u8 = 8;

/// Trip materialised from a `frequencies.txt` template (cableways etc.):
/// times are representative, the service runs every `headway_s`.
pub const TRIP_FREQUENCY: u8 = 1;

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Trip {
    pub pattern: PatternIdx,
    pub service: ServiceIdx,
    pub headsign: StrIdx,
    /// Train / course number (`trip_short_name`), empty string if none.
    pub short_name: StrIdx,
    pub gtfs_id: StrIdx,
    /// Swiss journey id (`original_trip_id`, `ch:1:sjyid:…`); join key to real time
    /// together with the operating day. Empty string if absent.
    pub sjyid: StrIdx,
    pub flags: u8,
    /// Real headway in seconds for `TRIP_FREQUENCY` trips, else 0.
    pub headway_s: u16,
}

/// "Stay seated": `from` ends where `to` starts and the vehicle runs through.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Continuation {
    pub from: TripIdx,
    pub to: TripIdx,
    /// Calendar restricting the link, or `NONE` when it always applies.
    pub service: ServiceIdx,
}

/// Official minimum transfer time between two Stops (`transfers.txt` type 2).
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct OfficialTransfer {
    pub from: StopIdx,
    pub to: StopIdx,
    pub secs: u16,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Timetable {
    pub feed_version: String,
    /// First service date covered.
    pub start_date: Date,
    /// Number of service dates covered (bits per service calendar).
    pub n_days: u32,

    pub agencies: Vec<Agency>,
    pub lines: Vec<Line>,
    pub stations: Vec<Station>,
    pub stops: Vec<Stop>,

    pub patterns: Vec<Pattern>,
    pub pattern_stops: Vec<StopIdx>,
    pub pattern_flags: Vec<u8>,

    pub trips: Vec<Trip>,
    /// For each trip, `2 * n_stops` values: arr₀, dep₀, arr₁, dep₁, …
    pub times: Vec<Secs>,

    /// String pool for trip attributes; index 0 is the empty string.
    pub strings: Vec<String>,

    /// Service calendars as bitsets, `service_words` u64 per service; bit `d`
    /// is set when the service runs on `start_date + d`.
    pub service_words: u32,
    pub service_bits: Vec<u64>,

    /// CSR: for stop `s`, `stop_patterns[stop_pattern_off[s] .. stop_pattern_off[s+1]]`
    /// lists every (pattern, position) that calls at `s`.
    pub stop_pattern_off: Vec<u32>,
    pub stop_patterns: Vec<(PatternIdx, u16)>,

    /// Sorted by `from`.
    pub continuations: Vec<Continuation>,
    /// Sorted by `(from, to)`.
    pub official_transfers: Vec<OfficialTransfer>,
}

/// The trips of one service date, grouped by pattern (same order as within
/// the pattern, i.e. sorted by time). Cheap to build (one pass over trips).
#[derive(Clone, Debug)]
pub struct DayIndex {
    pub date: Date,
    /// `trips[pat_off[p] .. pat_off[p+1]]` are the active trips of pattern `p`.
    pub pat_off: Vec<u32>,
    pub trips: Vec<TripIdx>,
}

impl DayIndex {
    #[inline]
    pub fn pattern_trips(&self, p: PatternIdx) -> &[TripIdx] {
        &self.trips[self.pat_off[p as usize] as usize..self.pat_off[p as usize + 1] as usize]
    }
}

impl Timetable {
    /// Changes whenever the boarding points do (their ids, order and places): ties caches that refer to stops by
    /// index to the timetable they were made for.
    pub fn stops_fingerprint(&self) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut mix = |v: u64| h = (h ^ v).wrapping_mul(0x0000_0100_0000_01b3);
        mix(self.stops.len() as u64);
        for s in &self.stops {
            for b in s.gtfs_id.bytes() {
                mix(b as u64);
            }
            mix(((s.pos.lat as u32 as u64) << 32) | s.pos.lon as u32 as u64);
        }
        h
    }

    #[inline]
    pub fn str(&self, i: StrIdx) -> &str {
        &self.strings[i as usize]
    }

    #[inline]
    pub fn pattern_stops(&self, p: PatternIdx) -> &[StopIdx] {
        let pat = &self.patterns[p as usize];
        &self.pattern_stops[pat.stops_off as usize..pat.stops_off as usize + pat.n_stops as usize]
    }

    #[inline]
    pub fn pattern_flags(&self, p: PatternIdx) -> &[u8] {
        let pat = &self.patterns[p as usize];
        &self.pattern_flags[pat.stops_off as usize..pat.stops_off as usize + pat.n_stops as usize]
    }

    /// `[arr₀, dep₀, arr₁, dep₁, …]` of a trip.
    #[inline]
    pub fn trip_times(&self, t: TripIdx) -> &[Secs] {
        let trip = &self.trips[t as usize];
        let pat = &self.patterns[trip.pattern as usize];
        let n = 2 * pat.n_stops as usize;
        let off = pat.times_off as usize + (t - pat.trips_off) as usize * n;
        &self.times[off..off + n]
    }

    #[inline]
    pub fn arr(&self, t: TripIdx, pos: usize) -> Secs {
        self.trip_times(t)[2 * pos]
    }

    #[inline]
    pub fn dep(&self, t: TripIdx, pos: usize) -> Secs {
        self.trip_times(t)[2 * pos + 1]
    }

    #[inline]
    pub fn trip_line(&self, t: TripIdx) -> &Line {
        &self.lines[self.patterns[self.trips[t as usize].pattern as usize].line as usize]
    }

    #[inline]
    pub fn stop_patterns(&self, s: StopIdx) -> &[(PatternIdx, u16)] {
        &self.stop_patterns[self.stop_pattern_off[s as usize] as usize..self.stop_pattern_off[s as usize + 1] as usize]
    }

    /// Does `service` run on `date`?
    #[inline]
    pub fn service_active(&self, service: ServiceIdx, date: Date) -> bool {
        let d = date - self.start_date;
        if d < 0 || d as u32 >= self.n_days || service == NONE {
            return false;
        }
        let w = self.service_bits[service as usize * self.service_words as usize + (d as usize >> 6)];
        (w >> (d as usize & 63)) & 1 == 1
    }

    #[inline]
    pub fn trip_active(&self, t: TripIdx, date: Date) -> bool {
        self.service_active(self.trips[t as usize].service, date)
    }

    pub fn end_date(&self) -> Date {
        self.start_date + self.n_days as Date - 1
    }

    pub fn day_index(&self, date: Date) -> DayIndex {
        let mut pat_off = Vec::with_capacity(self.patterns.len() + 1);
        let mut trips = Vec::new();
        let in_range = date >= self.start_date && date <= self.end_date();
        for pat in &self.patterns {
            pat_off.push(trips.len() as u32);
            if in_range {
                for t in pat.trips_off..pat.trips_off + pat.n_trips {
                    if self.trip_active(t, date) {
                        trips.push(t);
                    }
                }
            }
        }
        pat_off.push(trips.len() as u32);
        DayIndex { date, pat_off, trips }
    }

    /// In-seat continuations starting from `t`.
    pub fn continuations_from(&self, t: TripIdx) -> &[Continuation] {
        let lo = self.continuations.partition_point(|c| c.from < t);
        let hi = self.continuations.partition_point(|c| c.from <= t);
        &self.continuations[lo..hi]
    }

    /// Official minimum transfer time between two stops, if the feed has one.
    pub fn official_transfer(&self, from: StopIdx, to: StopIdx) -> Option<u16> {
        self.official_transfers
            .binary_search_by(|o| (o.from, o.to).cmp(&(from, to)))
            .ok()
            .map(|i| self.official_transfers[i].secs)
    }

    /// Stable public id of a trip instance, used in the HTTP API.
    pub fn trip_gtfs_id(&self, t: TripIdx) -> &str {
        self.str(self.trips[t as usize].gtfs_id)
    }
}
