//! kante-gtfs — the Swiss national GTFS feed plus the atlas registry exports
//! turned into a routing-ready [`kante_core::Timetable`].
//!
//! See `docs/ARCHITECTURE.md` for the contract. What this crate decides:
//!
//! **Stops and stations.** A Stop is every `stop_id` that `stop_times.txt`
//! references; a Station is a GTFS parent with at least one such stop (a stop
//! without parent is its own station). `Stop::sloid` is `original_stop_id`.
//!
//! **Labels.** `platform_code` is the sign text. Digits followed by upper-case
//! sector letters are split (`"5A-C"` → label `"5"`, sectors `"A-C"`), unless
//! the registry edge itself carries that designation (`"11A"` in Niederbipp is
//! a track name). Without a `platform_code` the atlas `designation` is used.
//! Nothing is ever derived from ids or operational codes.
//!
//! **Positions.** Sector centroid > atlas boarding point > GTFS coordinate.
//! Sector points are looked up on the stop's own edge and on the other atlas
//! edges of the same stop with the same designation (a track is often
//! registered as two operational halves, with the sector points on one).
//! A stop counts as a boarding point when its SLOID is an atlas boarding
//! platform, has the edge form `ch:1:sloid:<stop>:<area>:<edge>`, or the feed
//! gives it a `platform_code`.
//!
//! **Patterns.** Trips are grouped by (route, stop sequence, pickup/drop-off
//! flags), sorted by time and split greedily into chains without overtaking.
//! Patterns are ordered by line; the output is deterministic.
//!
//! **Frequencies.** Every `frequencies.txt` window becomes individual trips at
//! `max(headway_secs, min_headway_s)`, from `start_time` to `end_time`
//! inclusive (in this feed `end_time` is the last departure); the last real
//! departure is added when the coarser grid misses it. Such trips carry
//! `TRIP_FREQUENCY`, the real headway, and the id `<template trip_id>@HH:MM:SS`
//! of their first departure, so every instance has a distinct id.
//!
//! **Transfers.** Type 4 rows become `continuations` (with their `TraCal_*`
//! calendar). A continuation whose second trip departs *before* the first one
//! arrives is not an error: the second trip belongs to the following service
//! day (a train arriving 24:58 continuing as a trip that starts 01:01).
//! Type 2 rows without route/trip restriction become `official_transfers`;
//! type 2 rows restricted to a trip pair have no place in the contract and
//! are only counted (see [`ImportReport`]).
//!
//! **Station weight.** Mode-weighted departures per day averaged over the
//! feed (rail 10, rack rail 5, metro 4, boat 3, tram and funicular 2,
//! everything else 1, on-demand 0.5), at least 1 for any station with a
//! boardable departure.

mod atlas;
mod csv;
mod import;
mod patterns;
mod report;
mod stop_times;
mod verify;
mod zipio;

use std::path::PathBuf;

pub use report::ImportReport;
pub use verify::verify;

#[derive(Clone, Debug)]
pub struct ImportOptions {
    pub gtfs_zip: PathBuf,
    /// Directory with traffic-point.csv, sectors.csv, prm-platform.csv (atlas). Optional.
    pub atlas_dir: Option<PathBuf>,
    /// Frequency templates are materialised with at least this headway (default 300 s).
    pub min_headway_s: u32,
}

impl Default for ImportOptions {
    fn default() -> Self {
        ImportOptions { gtfs_zip: PathBuf::from("data/raw/gtfs/gtfs.zip"), atlas_dir: None, min_headway_s: 300 }
    }
}

/// Import the feed. Rows that reference unknown ids are skipped; a missing
/// member or column is an error.
pub fn import(opts: &ImportOptions) -> anyhow::Result<kante_core::Timetable> {
    import::run(opts).map(|(tt, _)| tt)
}

/// [`import`], plus the counts of what was read, skipped and repaired.
pub fn import_with_report(opts: &ImportOptions) -> anyhow::Result<(kante_core::Timetable, ImportReport)> {
    import::run(opts)
}
