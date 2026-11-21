//! Wire types of the HTTP API. Mirrors `app/src/api/types.ts` field for field.

use serde::{Deserialize, Serialize};

fn is_zero(v: &u8) -> bool {
    *v == 0
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LineBadge {
    pub name: String,
    pub category: String,
    pub mode: &'static str,
    pub operator: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub lat: f64,
    pub lon: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<Vec<&'static str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dist_m: Option<u32>,
}

#[derive(Serialize)]
pub struct SearchResponse {
    pub results: Vec<Place>,
}

#[derive(Serialize)]
pub struct NearbyResponse {
    pub stations: Vec<NearbyStation>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearbyStation {
    pub place: Place,
    pub dist_m: u32,
    pub lines: Vec<NearbyLine>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearbyLine {
    pub line: LineBadge,
    pub headsign: String,
    pub quay: Quay,
    pub next: Vec<i64>,
    pub live: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delay_s: Option<i32>,
    pub trip_id: String,
    pub service_date: String,
    pub seq: u16,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QuaySide {
    pub street: String,
    pub side: &'static str,
    pub of: &'static str,
    pub text: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Quay {
    pub id: String,
    pub sloid: String,
    pub station_id: String,
    pub station_name: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sectors: Option<String>,
    pub noun: &'static str,
    pub lat: f64,
    pub lon: f64,
    pub precision: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<QuaySide>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access: Option<&'static str>,
    pub modes: Vec<&'static str>,
}

#[derive(Serialize)]
pub struct QuaysResponse {
    pub quays: Vec<Quay>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct PlanOptions {
    pub walk_speed: f32,
    pub stairs: String,
    pub escalators: bool,
    pub wheelchair: bool,
    pub transfer_margin_s: i32,
    pub max_walk_min: f32,
    pub modes: Option<Vec<String>>,
    pub max_transfers: Option<u8>,
}

impl Default for PlanOptions {
    fn default() -> Self {
        PlanOptions {
            walk_speed: 1.3,
            stairs: "ok".into(),
            escalators: true,
            wheelchair: false,
            transfer_margin_s: 120,
            max_walk_min: 20.0,
            modes: None,
            max_transfers: None,
        }
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PlaceRef {
    pub id: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub name: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OnboardRef {
    pub trip_id: String,
    pub service_date: String,
    #[serde(default)]
    pub next_seq: Option<u16>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlanRequest {
    #[serde(default)]
    pub from: Option<PlaceRef>,
    pub to: PlaceRef,
    #[serde(default)]
    pub time: Option<i64>,
    #[serde(default)]
    pub arrive_by: bool,
    #[serde(default)]
    pub onboard: Option<OnboardRef>,
    #[serde(default)]
    pub options: PlanOptions,
    #[serde(default)]
    pub page: Option<String>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WalkRequest {
    pub from: PlaceRef,
    pub to: PlaceRef,
    #[serde(default)]
    pub options: PlanOptions,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanResponse {
    pub from: Place,
    pub to: Place,
    pub journeys: Vec<Journey>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub walk_only: Option<Journey>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub earlier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub later: Option<String>,
    pub took_ms: f64,
    pub realtime: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Journey {
    pub id: String,
    pub dep: i64,
    pub arr: i64,
    pub duration_s: i64,
    pub transfers: u8,
    pub walk_s: i64,
    pub walk_m: u32,
    pub legs: Vec<Leg>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub alerts: Vec<JourneyAlert>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JourneyAlert {
    pub severity: &'static str,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leg: Option<usize>,
    pub text: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Leg {
    Ride(RideLeg),
    Walk(WalkLeg),
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RideLeg {
    pub line: LineBadge,
    pub headsign: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    pub trip_id: String,
    pub service_date: String,
    pub from: StopCall,
    pub to: StopCall,
    pub intermediate: Vec<StopCall>,
    pub geometry: Vec<[f64; 2]>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub stay_on_board: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub onboard: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headway_s: Option<u16>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cancelled: bool,
    pub live: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub towards: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bearing: Option<f32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StopCall {
    pub seq: u16,
    pub quay: Quay,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arr: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dep: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arr_delay_s: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dep_delay_s: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub planned_label: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub skipped: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub on_request: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WalkPoint {
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quay: Option<Quay>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WalkLeg {
    pub kind: &'static str,
    pub from: WalkPoint,
    pub to: WalkPoint,
    pub dep: i64,
    pub arr: i64,
    pub duration_s: i64,
    pub distance_m: u32,
    pub stairs_up: u16,
    pub stairs_down: u16,
    pub lifts: u8,
    pub escalators: u8,
    pub step_free: bool,
    #[serde(skip_serializing_if = "is_zero")]
    pub unmapped_level_changes: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slack_s: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub official_min_s: Option<u16>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub approximate: bool,
    pub geometry: Vec<[f64; 2]>,
    pub levels: Vec<Option<f32>>,
    pub steps: Vec<WalkStep>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WalkStep {
    pub kind: &'static str,
    pub text: String,
    pub dist_m: u32,
    pub dur_s: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_level: Option<f32>,
    pub from: u32,
    pub to: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeparturesResponse {
    pub station: Place,
    pub quays: Vec<Quay>,
    pub departures: Vec<Departure>,
    pub realtime: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Departure {
    pub line: LineBadge,
    pub headsign: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    pub trip_id: String,
    pub service_date: String,
    pub seq: u16,
    pub dep: i64,
    pub live: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delay_s: Option<i32>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cancelled: bool,
    pub quay_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub planned_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub towards: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bearing: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headway_s: Option<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TripResponse {
    pub trip_id: String,
    pub service_date: String,
    pub line: LineBadge,
    pub headsign: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    pub calls: Vec<StopCall>,
    pub geometry: Vec<[f64; 2]>,
    pub live: &'static str,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headway_s: Option<u16>,
}

#[derive(Serialize)]
pub struct VehiclesResponse {
    pub t: i64,
    pub vehicles: Vec<Vehicle>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vehicle {
    pub trip_id: String,
    pub service_date: String,
    pub line: LineBadge,
    pub headsign: String,
    pub from: [f64; 2],
    pub to: [f64; 2],
    pub dep: i64,
    pub arr: i64,
    pub next_stop: String,
    pub next_seq: u16,
    pub live: &'static str,
}

#[derive(Serialize)]
pub struct OnboardResponse {
    pub candidates: Vec<OnboardCandidate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardCandidate {
    pub trip_id: String,
    pub service_date: String,
    pub line: LineBadge,
    pub headsign: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    pub dist_m: u32,
    pub next_seq: u16,
    pub next_stop: String,
    pub next_arr: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev_stop: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delay_s: Option<i32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaResponse {
    pub feed_version: String,
    pub valid_from: String,
    pub valid_to: String,
    pub walk_bbox: [f64; 4],
    pub realtime: RealtimeMeta,
    pub counts: Counts,
    pub attribution: Vec<&'static str>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeMeta {
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trips: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub stations: usize,
    pub quays: usize,
    pub trips: usize,
    pub walk_edges: usize,
}
