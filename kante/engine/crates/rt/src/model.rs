//! Source-independent real-time model: one [`RtJourney`] per vehicle journey,
//! filled by the SIRI-ET and the GTFS-RT parser alike.

/// One vehicle journey on one operating day as reported by a live feed.
///
/// Fields up to `calls` are the contract from `docs/ARCHITECTURE.md`; the rest
/// are additions (empty / zero when the source does not carry them).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RtJourney {
    /// Journey reference as delivered (Swiss journey id, `ch:1:sjyid:…`, where available).
    ///
    /// SIRI-ET: `FramedVehicleJourneyRef/DatedVehicleJourneyRef`.
    /// GTFS-RT: `TripDescriptor.original_trip_id` (Swiss extension, field 8).
    pub journey_ref: String,
    /// Operating day, `YYYY-MM-DD`.
    ///
    /// SIRI-ET: `FramedVehicleJourneyRef/DataFrameRef`. GTFS-RT: `start_date`.
    pub operating_day: String,
    pub line_ref: String,
    pub operator_ref: String,
    pub line_name: String,
    pub destination: String,
    pub cancelled: bool,
    pub extra: bool,
    pub monitored: bool,
    pub calls: Vec<RtCall>,

    // ---- additions beyond the contract ----
    /// GTFS-RT `TripDescriptor.trip_id` (the static GTFS trip id for scheduled
    /// trips). Empty for SIRI-ET.
    pub trip_id: String,
    /// GTFS-RT `start_time` (`HH:MM:SS`), empty for SIRI-ET.
    pub start_time: String,
    /// SIRI `VehicleMode` ("bus", "rail", "tram", "metro", …), empty for GTFS-RT.
    pub mode: String,
    /// SIRI `TrainNumbers/TrainNumberRef` or `VehicleJourneyName`, empty if absent.
    pub train_number: String,
    /// SIRI `OriginName`, empty if absent.
    pub origin: String,
    /// When the source last updated this journey, unix seconds
    /// (SIRI journey-level `RecordedAtTime`, GTFS-RT `TripUpdate.timestamp`,
    /// else the feed timestamp). 0 if unknown.
    pub recorded_at: i64,
    /// SIRI `PredictionInaccurate` / `InCongestion`.
    pub prediction_inaccurate: bool,
    pub in_congestion: bool,
}

/// One stop of a journey: a SIRI `RecordedCall` / `EstimatedCall` or a GTFS-RT
/// `StopTimeUpdate`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RtCall {
    /// Stop reference as delivered (SLOID of a boarding point or stop, or a number).
    pub stop_ref: String,
    /// SIRI `Order` if present, else `VisitNumber`; GTFS-RT `stop_sequence`.
    /// Not comparable between feeds or with a pattern position.
    pub order: u16,
    /// Unix seconds.
    pub aimed_arr: Option<i64>,
    pub expected_arr: Option<i64>,
    pub actual_arr: Option<i64>,
    pub aimed_dep: Option<i64>,
    pub expected_dep: Option<i64>,
    pub actual_dep: Option<i64>,
    /// Planned platform name, if the feed states one (`…StopAssignment/AimedQuayName`).
    /// The national SIRI-ET feed does not; the plan then comes from the timetable.
    pub planned_platform: String,
    /// Current platform name for boarding: `DeparturePlatformName`, else
    /// `…StopAssignment/ExpectedQuayName`, else `ArrivalPlatformName`.
    pub platform: String,
    pub cancelled: bool,
    pub extra_call: bool,

    // ---- additions beyond the contract ----
    /// `ArrivalPlatformName` as delivered (may differ from `platform`).
    pub arr_platform: String,
    /// Reference of the boarding point currently assigned, when the feed gives
    /// one separately from `stop_ref` (SIRI `ExpectedQuayRef`, GTFS-RT
    /// `StopTimeProperties.assigned_stop_id`). Empty otherwise.
    pub quay_ref: String,
    /// `StopPointName`, empty for GTFS-RT.
    pub stop_name: String,
    /// GTFS-RT delay-only updates: seconds relative to the static schedule
    /// (`StopTimeEvent.delay`). `None` for SIRI-ET, where delays follow from the
    /// absolute times.
    pub arr_delay: Option<i32>,
    pub dep_delay: Option<i32>,
    /// From a SIRI `RecordedCall` (the vehicle has been there).
    pub recorded: bool,
    /// GTFS-RT `StopTimeUpdate.schedule_relationship == NO_DATA`.
    pub no_data: bool,
}

/// Summary of one parsed feed document.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FeedMeta {
    /// Unix seconds: SIRI `ServiceDelivery/ResponseTimestamp`, GTFS-RT `FeedHeader.timestamp`.
    pub timestamp: i64,
    pub journeys: usize,
    /// `"siri-et"` or `"gtfs-rt"`.
    pub source: &'static str,
    /// GTFS-RT `FeedHeader.feed_version` (the static GTFS version the ids
    /// refer to). Empty for SIRI-ET, which has no such field.
    pub feed_version: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FeedKind {
    SiriEt,
    GtfsRt,
}

impl FeedKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FeedKind::SiriEt => "siri-et",
            FeedKind::GtfsRt => "gtfs-rt",
        }
    }
    /// Path below the API base URL.
    pub fn path(self) -> &'static str {
        match self {
            FeedKind::SiriEt => "/la/siri-et",
            FeedKind::GtfsRt => "/la/gtfs-rt",
        }
    }
}
