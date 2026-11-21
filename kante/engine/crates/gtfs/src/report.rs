//! What the importer saw and what it had to skip or repair.

use kante_core::time::Date;
use kante_core::Timetable;
use std::fmt;

#[derive(Clone, Debug, Default)]
pub struct ImportReport {
    // ---- input rows -------------------------------------------------------
    pub agencies: u64,
    pub routes: u64,
    /// Data rows of trips.txt (before frequency expansion and before any skip).
    pub trip_rows: u64,
    pub stop_rows: u64,
    pub stop_rows_parents: u64,
    pub stop_time_rows: u64,
    pub stop_times_bytes: u64,
    pub calendar_rows: u64,
    pub calendar_date_rows: u64,
    pub transfer_rows: u64,
    pub frequency_rows: u64,

    // ---- skipped / repaired -----------------------------------------------
    pub routes_unknown_agency: u64,
    pub trips_malformed: u64,
    pub trips_unknown_route: u64,
    pub trips_unknown_service: u64,
    pub trips_duplicate_id: u64,
    pub trips_without_stop_times: u64,
    pub trips_single_stop: u64,
    pub trips_no_times: u64,
    pub trips_too_long: u64,
    pub stop_times_malformed: u64,
    pub stop_times_unknown_trip: u64,
    pub stop_times_unknown_stop: u64,
    pub stop_times_duplicate_seq: u64,
    pub stop_times_resorted: bool,
    pub times_interpolated: u64,
    pub times_clamped: u64,
    pub calendar_malformed: u64,
    pub calendar_dates_malformed: u64,
    pub calendar_dates_out_of_range: u64,
    pub services_only_in_calendar_dates: u64,
    pub stops_duplicate_id: u64,
    pub stops_missing_parent: u64,
    pub stops_bad_coordinate: u64,

    // ---- frequencies ------------------------------------------------------
    pub frequency_templates: u64,
    pub frequency_unknown_trip: u64,
    pub frequency_malformed: u64,
    pub frequency_trips_materialised: u64,

    // ---- transfers --------------------------------------------------------
    pub transfers_type1: u64,
    pub transfers_other_type: u64,
    pub transfers_malformed: u64,
    /// Type 2 rows without route/trip restriction (candidates for `official_transfers`).
    pub transfers_type2_generic: u64,
    pub transfers_type2_unknown_stop: u64,
    pub transfers_type2_not_a_stop: u64,
    pub transfers_type2_duplicates: u64,
    /// Type 2 rows restricted to a route and/or trip pair. They have no place
    /// in `Timetable::official_transfers` and are not imported.
    pub transfers_type2_trip_specific: u64,
    /// Of the trip-specific rows: how their time compares with the generic
    /// rule for the same stop pair.
    pub trip_specific_shorter: u64,
    pub trip_specific_equal: u64,
    pub trip_specific_longer: u64,
    pub trip_specific_no_generic: u64,
    /// Trip-specific rows whose two trips are in the timetable and call at the two stops.
    pub trip_specific_resolvable: u64,
    pub transfers_type4: u64,
    pub continuations_unknown_trip: u64,
    pub continuations_unknown_service: u64,
    pub continuations_duplicate: u64,
    /// Shape of the kept continuations: where the second trip starts
    /// relative to where the first one ends.
    pub continuations_same_stop: u64,
    pub continuations_same_station: u64,
    pub continuations_other_station: u64,
    /// The second trip departs before the first one arrives.
    pub continuations_negative_wait: u64,
    /// … of which by 20 h or more (the second trip belongs to the next service day).
    pub continuations_wait_about_minus_24h: u64,
    pub continuations_wait_over_1h: u64,
    /// Type 4 rows whose stops are not the last stop of the first trip and
    /// the first stop of the second (dropped: not expressible).
    pub continuations_not_at_trip_ends: u64,
    /// Examples of anomalies, for the import log.
    pub notes: Vec<String>,

    // ---- stops ------------------------------------------------------------
    pub atlas_boarding_points: u64,
    pub atlas_missing_files: Vec<String>,
    pub stops_precision_edge: u64,
    pub stops_precision_edge_at_station: u64,
    pub stops_precision_station: u64,
    pub stops_pos_atlas: u64,
    pub stops_pos_sectors: u64,
    /// … of which the sector points hang on another edge of the same track.
    pub stops_pos_sectors_sibling: u64,
    pub stops_pos_gtfs: u64,
    pub stops_label_gtfs: u64,
    pub stops_label_atlas: u64,
    pub stops_with_sectors: u64,
    pub stops_sectors_without_points: u64,
    /// Stops that are boarding points by id but unknown to the atlas file.
    pub stops_edge_not_in_atlas: u64,
    /// Atlas position used although it differs from the GTFS coordinate by more than 5 m / 50 m.
    pub stops_atlas_vs_gtfs_over_5m: u64,
    pub stops_atlas_vs_gtfs_over_50m: u64,
    /// Distinct (line, stop sequence, flags) keys before splitting for overtaking.
    pub pattern_keys: u64,
    pub stations_without_stops: u64,

    /// trips.txt rows per service calendar (all rows with a known service).
    pub trip_rows_per_service: Vec<u32>,
    /// (phase, seconds since the previous mark)
    pub phases: Vec<(String, f64)>,
    pub total_secs: f64,
}

impl ImportReport {
    /// trips.txt rows whose calendar runs on `date` (frequency templates count once).
    pub fn trip_rows_active(&self, tt: &Timetable, date: Date) -> u64 {
        self.trip_rows_per_service
            .iter()
            .enumerate()
            .filter(|(s, _)| tt.service_active(*s as u32, date))
            .map(|(_, &n)| n as u64)
            .sum()
    }
}

impl fmt::Display for ImportReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "input rows")?;
        writeln!(
            f,
            "  agencies {}  routes {}  trips {}  stops {} ({} parents)  stop_times {} ({} MB)",
            self.agencies,
            self.routes,
            self.trip_rows,
            self.stop_rows,
            self.stop_rows_parents,
            self.stop_time_rows,
            self.stop_times_bytes >> 20
        )?;
        writeln!(
            f,
            "  calendar {}  calendar_dates {}  transfers {}  frequencies {}",
            self.calendar_rows, self.calendar_date_rows, self.transfer_rows, self.frequency_rows
        )?;
        writeln!(f, "skipped / repaired")?;
        writeln!(
            f,
            "  routes: unknown agency {}   trips: malformed {} unknown route {} unknown service {} duplicate id {}",
            self.routes_unknown_agency, self.trips_malformed, self.trips_unknown_route, self.trips_unknown_service, self.trips_duplicate_id
        )?;
        writeln!(
            f,
            "  trips dropped: no stop_times {} single stop {} no times {} too long {}",
            self.trips_without_stop_times, self.trips_single_stop, self.trips_no_times, self.trips_too_long
        )?;
        writeln!(
            f,
            "  stop_times: malformed {} unknown trip {} unknown stop {} duplicate sequence {} resorted {}",
            self.stop_times_malformed, self.stop_times_unknown_trip, self.stop_times_unknown_stop, self.stop_times_duplicate_seq, self.stop_times_resorted
        )?;
        writeln!(f, "  times: interpolated {} clamped (ran backwards) {}", self.times_interpolated, self.times_clamped)?;
        writeln!(
            f,
            "  calendar: malformed {}   calendar_dates: malformed {} out of feed range {} services only there {}",
            self.calendar_malformed, self.calendar_dates_malformed, self.calendar_dates_out_of_range, self.services_only_in_calendar_dates
        )?;
        writeln!(
            f,
            "  stops: duplicate id {} missing parent {} bad coordinate {}",
            self.stops_duplicate_id, self.stops_missing_parent, self.stops_bad_coordinate
        )?;
        writeln!(f, "frequencies")?;
        writeln!(
            f,
            "  templates {} -> {} trips materialised; unknown trip {} malformed {}",
            self.frequency_templates, self.frequency_trips_materialised, self.frequency_unknown_trip, self.frequency_malformed
        )?;
        writeln!(f, "transfers")?;
        writeln!(
            f,
            "  type 2 generic {} (unknown stop id {}, id is not a Stop {}, duplicate pair {})",
            self.transfers_type2_generic, self.transfers_type2_unknown_stop, self.transfers_type2_not_a_stop, self.transfers_type2_duplicates
        )?;
        writeln!(
            f,
            "  type 2 trip/route-specific {} (NOT imported; {} resolvable to two timetable trips; vs generic rule of the stop pair: shorter {} equal {} longer {} no generic rule {})",
            self.transfers_type2_trip_specific,
            self.trip_specific_resolvable,
            self.trip_specific_shorter,
            self.trip_specific_equal,
            self.trip_specific_longer,
            self.trip_specific_no_generic
        )?;
        writeln!(
            f,
            "  type 4 {} (unknown trip {}, unknown service {}, duplicate {})  type 1 {}  other {}  malformed {}",
            self.transfers_type4,
            self.continuations_unknown_trip,
            self.continuations_unknown_service,
            self.continuations_duplicate,
            self.transfers_type1,
            self.transfers_other_type,
            self.transfers_malformed
        )?;
        writeln!(
            f,
            "  type 4 not linking last stop -> first stop (dropped) {}",
            self.continuations_not_at_trip_ends
        )?;
        writeln!(
            f,
            "  continuations kept: same stop {} same station {} other station {}; wait < 0: {} (of which <= -20 h: {}), wait > 1 h: {}",
            self.continuations_same_stop,
            self.continuations_same_station,
            self.continuations_other_station,
            self.continuations_negative_wait,
            self.continuations_wait_about_minus_24h,
            self.continuations_wait_over_1h
        )?;
        writeln!(f, "stops")?;
        writeln!(
            f,
            "  atlas boarding points {}{}",
            self.atlas_boarding_points,
            if self.atlas_missing_files.is_empty() { String::new() } else { format!("  (missing files: {})", self.atlas_missing_files.join(", ")) }
        )?;
        writeln!(
            f,
            "  precision: edge {} edge-at-station {} station {}   boarding-point ids not in atlas {}",
            self.stops_precision_edge, self.stops_precision_edge_at_station, self.stops_precision_station, self.stops_edge_not_in_atlas
        )?;
        writeln!(
            f,
            "  position from: sector centroid {} (via sibling edge {}) atlas {} gtfs {}   label from: platform_code {} atlas designation {}",
            self.stops_pos_sectors, self.stops_pos_sectors_sibling, self.stops_pos_atlas, self.stops_pos_gtfs, self.stops_label_gtfs, self.stops_label_atlas
        )?;
        writeln!(
            f,
            "  with sectors {} (no sector points in atlas: {})   parent stations without any Stop: {}",
            self.stops_with_sectors, self.stops_sectors_without_points, self.stations_without_stops
        )?;
        writeln!(
            f,
            "  atlas position differs from GTFS by > 5 m: {}, > 50 m: {}",
            self.stops_atlas_vs_gtfs_over_5m, self.stops_atlas_vs_gtfs_over_50m
        )?;
        writeln!(f, "patterns: {} distinct (line, stops, flags) keys before the no-overtaking split", self.pattern_keys)?;
        if !self.notes.is_empty() {
            writeln!(f, "notes")?;
            for n in &self.notes {
                writeln!(f, "  {n}")?;
            }
        }
        writeln!(f, "phases")?;
        for (name, secs) in &self.phases {
            writeln!(f, "  {:<34} {:>7.2} s", name, secs)?;
        }
        write!(f, "  {:<34} {:>7.2} s", "total", self.total_secs)
    }
}
