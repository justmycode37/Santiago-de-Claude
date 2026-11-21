//! Streaming SIRI-ET (Estimated Timetable) parser.
//!
//! The national feed is one XML document of 60–150 MB without line breaks. It
//! is read with quick-xml's pull parser: no DOM, one reusable event buffer, one
//! `RtJourney` alive at a time, which is handed to the sink as soon as its
//! `</EstimatedVehicleJourney>` is seen.
//!
//! What the Swiss feed (opentransportdata.swiss `/la/siri-et`, sample of
//! 2026-11-20) actually contains, per `EstimatedVehicleJourney`:
//!
//! | Fact | Element |
//! |---|---|
//! | journey id | `FramedVehicleJourneyRef/DatedVehicleJourneyRef` (always present; `ch:1:sjyid:…` for 71 %, `ch:1:ServiceJourney:<agency>:…` for the rest) |
//! | operating day | `FramedVehicleJourneyRef/DataFrameRef` = `YYYY-MM-DD` (always present) |
//! | line | `LineRef` (`ch:1:Line:<agency>:<name>`), `PublishedLineName` |
//! | operator | `OperatorRef` (`ch:1:sboid:…`) |
//! | destination | `DirectionName` (always), `DestinationName` (12 %) |
//! | flags | `Cancellation`, `ExtraJourney`, `Monitored`, `PredictionInaccurate`, `InCongestion` |
//! | calls | `RecordedCalls/RecordedCall*` then `EstimatedCalls/EstimatedCall*` |
//! | stop | `StopPointRef` (SLOID of a boarding point, of the stop, or `ch:1:ScheduledStopPoint:<didok>`) |
//! | order | `VisitNumber` (there is no `Order` element in the feed) |
//! | times | `Aimed…`, `Expected…`, `Actual…` × `ArrivalTime` / `DepartureTime`, all UTC with `Z` |
//! | platform | `ArrivalPlatformName`, `DeparturePlatformName` — the *current* name only |
//! | call flags | `Cancellation`, `ExtraCall` |
//!
//! The feed carries **no planned platform** (no `…StopAssignment`, no aimed
//! quay): a platform change is only visible by comparing with the timetable.
//! `ArrivalStopAssignment` / `DepartureStopAssignment` with `AimedQuayName`,
//! `ExpectedQuayName`, `ExpectedQuayRef` are parsed anyway (SIRI 2.0 standard)
//! so that such data is picked up if the feed starts to send it.

use crate::model::{FeedMeta, RtCall, RtJourney};
use anyhow::{Context, Result};
use quick_xml::events::Event;
use quick_xml::Reader;
use std::io::{BufRead, BufReader, Read};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Tag {
    Other,
    // containers
    Journey,
    RecordedCall,
    EstimatedCall,
    ArrAssign,
    DepAssign,
    // document level
    ResponseTimestamp,
    // journey level
    RecordedAtTime,
    LineRef,
    DataFrameRef,
    DatedVehicleJourneyRef,
    JourneyCode,
    PublishedLineName,
    DirectionName,
    DestinationName,
    OriginName,
    OperatorRef,
    VehicleMode,
    Monitored,
    Cancellation,
    ExtraJourney,
    TrainNumberRef,
    VehicleJourneyName,
    PredictionInaccurate,
    InCongestion,
    // call level
    StopPointRef,
    Order,
    VisitNumber,
    StopPointName,
    AimedArr,
    ExpectedArr,
    ActualArr,
    AimedDep,
    ExpectedDep,
    ActualDep,
    ArrPlatform,
    DepPlatform,
    ExtraCall,
    DestinationDisplay,
    // inside a stop assignment
    AimedQuayName,
    ExpectedQuayName,
    ActualQuayName,
    ExpectedQuayRef,
    ActualQuayRef,
}

#[inline]
fn tag_of(name: &[u8]) -> Tag {
    match name {
        b"EstimatedVehicleJourney" => Tag::Journey,
        b"RecordedCall" => Tag::RecordedCall,
        b"EstimatedCall" => Tag::EstimatedCall,
        b"ArrivalStopAssignment" => Tag::ArrAssign,
        b"DepartureStopAssignment" => Tag::DepAssign,
        b"ResponseTimestamp" => Tag::ResponseTimestamp,
        b"RecordedAtTime" => Tag::RecordedAtTime,
        b"LineRef" => Tag::LineRef,
        b"DataFrameRef" => Tag::DataFrameRef,
        b"DatedVehicleJourneyRef" => Tag::DatedVehicleJourneyRef,
        b"EstimatedVehicleJourneyCode" => Tag::JourneyCode,
        b"PublishedLineName" => Tag::PublishedLineName,
        b"DirectionName" => Tag::DirectionName,
        b"DestinationName" => Tag::DestinationName,
        b"OriginName" => Tag::OriginName,
        b"OperatorRef" => Tag::OperatorRef,
        b"VehicleMode" => Tag::VehicleMode,
        b"Monitored" => Tag::Monitored,
        b"Cancellation" => Tag::Cancellation,
        b"ExtraJourney" => Tag::ExtraJourney,
        b"TrainNumberRef" => Tag::TrainNumberRef,
        b"VehicleJourneyName" => Tag::VehicleJourneyName,
        b"PredictionInaccurate" => Tag::PredictionInaccurate,
        b"InCongestion" => Tag::InCongestion,
        b"StopPointRef" => Tag::StopPointRef,
        b"Order" => Tag::Order,
        b"VisitNumber" => Tag::VisitNumber,
        b"StopPointName" => Tag::StopPointName,
        b"AimedArrivalTime" => Tag::AimedArr,
        b"ExpectedArrivalTime" => Tag::ExpectedArr,
        b"ActualArrivalTime" => Tag::ActualArr,
        b"AimedDepartureTime" => Tag::AimedDep,
        b"ExpectedDepartureTime" => Tag::ExpectedDep,
        b"ActualDepartureTime" => Tag::ActualDep,
        b"ArrivalPlatformName" => Tag::ArrPlatform,
        b"DeparturePlatformName" => Tag::DepPlatform,
        b"ExtraCall" => Tag::ExtraCall,
        b"DestinationDisplay" => Tag::DestinationDisplay,
        b"AimedQuayName" => Tag::AimedQuayName,
        b"ExpectedQuayName" => Tag::ExpectedQuayName,
        b"ActualQuayName" => Tag::ActualQuayName,
        b"ExpectedQuayRef" => Tag::ExpectedQuayRef,
        b"ActualQuayRef" => Tag::ActualQuayRef,
        _ => Tag::Other,
    }
}

/// Days from 1970-01-01 for a proleptic Gregorian date (Howard Hinnant).
#[inline]
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[inline]
fn trim(mut b: &[u8]) -> &[u8] {
    while let [first, rest @ ..] = b {
        if first.is_ascii_whitespace() {
            b = rest;
        } else {
            break;
        }
    }
    while let [rest @ .., last] = b {
        if last.is_ascii_whitespace() {
            b = rest;
        } else {
            break;
        }
    }
    b
}

/// `YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH[:MM])` → unix seconds (fractions are
/// truncated). A time without zone is taken as Europe/Zurich local time.
pub fn parse_time(b: &[u8]) -> Option<i64> {
    let b = trim(b);
    if b.len() < 19 {
        return None;
    }
    #[inline]
    fn two(b: &[u8], i: usize) -> Option<i64> {
        let (a, c) = (b[i].wrapping_sub(b'0'), b[i + 1].wrapping_sub(b'0'));
        (a < 10 && c < 10).then_some((a * 10 + c) as i64)
    }
    if b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let y = two(b, 0)? * 100 + two(b, 2)?;
    let (mo, d, h, mi, s) = (two(b, 5)?, two(b, 8)?, two(b, 11)?, two(b, 14)?, two(b, 17)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 24 || mi > 59 || s > 60 {
        return None;
    }
    let t = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + s;
    let mut i = 19;
    if i < b.len() && (b[i] == b'.' || b[i] == b',') {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
    }
    match &b[i..] {
        b"Z" | b"z" => Some(t),
        [] => kante_core::time::parse_iso(std::str::from_utf8(&b[..19]).ok()?),
        z @ [sign @ (b'+' | b'-'), ..] => {
            let off = match z.len() {
                3 => two(z, 1)? * 3600,
                5 => two(z, 1)? * 3600 + two(z, 3)? * 60,
                6 if z[3] == b':' => two(z, 1)? * 3600 + two(z, 4)? * 60,
                _ => return None,
            };
            Some(if *sign == b'+' { t - off } else { t + off })
        }
        _ => None,
    }
}

#[inline]
fn parse_bool(b: &[u8]) -> bool {
    matches!(trim(b), b"true" | b"1" | b"TRUE" | b"True")
}

#[inline]
fn text_string(b: &[u8]) -> String {
    String::from_utf8_lossy(trim(b)).into_owned()
}

fn parse_u16(b: &[u8]) -> u16 {
    let mut v: u32 = 0;
    for &c in trim(b) {
        if !c.is_ascii_digit() {
            break;
        }
        v = (v * 10 + (c - b'0') as u32).min(u16::MAX as u32);
    }
    v as u16
}

fn push_entity(text: &mut Vec<u8>, name: &[u8]) {
    match name {
        b"amp" => text.push(b'&'),
        b"lt" => text.push(b'<'),
        b"gt" => text.push(b'>'),
        b"quot" => text.push(b'"'),
        b"apos" => text.push(b'\''),
        [b'#', rest @ ..] => {
            let code = match rest {
                [b'x' | b'X', hex @ ..] => std::str::from_utf8(hex).ok().and_then(|h| u32::from_str_radix(h, 16).ok()),
                dec => std::str::from_utf8(dec).ok().and_then(|d| d.parse::<u32>().ok()),
            };
            if let Some(c) = code.and_then(char::from_u32) {
                let mut tmp = [0u8; 4];
                text.extend_from_slice(c.encode_utf8(&mut tmp).as_bytes());
            }
        }
        _ => {
            // Unknown entity: keep it readable rather than dropping it.
            text.push(b'&');
            text.extend_from_slice(name);
            text.push(b';');
        }
    }
}

#[derive(Default)]
struct State {
    depth: u32,
    /// Depth of the open `EstimatedVehicleJourney` element, 0 = none.
    journey_depth: u32,
    /// Depth of the open call element, 0 = none.
    call_depth: u32,
    /// Depth of the open stop-assignment element, 0 = none.
    assign_depth: u32,
    assign_is_dep: bool,
    journey: RtJourney,
    call: RtCall,
    dep_platform: String,
    assign_platform: String,
    direction_name: String,
    destination_name: String,
    destination_display: String,
    journey_code: String,
    response_ts: i64,
    frame_ts: i64,
    n: usize,
}

impl State {
    /// Which leaf to capture text for, given the element that just opened.
    #[inline]
    fn open(&mut self, name: &[u8]) -> Tag {
        self.depth += 1;
        let tag = tag_of(name);
        if tag == Tag::Other {
            return Tag::Other;
        }
        if self.journey_depth == 0 {
            return match tag {
                Tag::Journey => {
                    self.journey_depth = self.depth;
                    self.journey = RtJourney { monitored: false, ..Default::default() };
                    self.direction_name.clear();
                    self.destination_name.clear();
                    self.destination_display.clear();
                    self.journey_code.clear();
                    Tag::Other
                }
                Tag::ResponseTimestamp if self.response_ts == 0 => tag,
                Tag::RecordedAtTime if self.frame_ts == 0 => tag,
                _ => Tag::Other,
            };
        }
        if self.call_depth == 0 {
            return match tag {
                Tag::RecordedCall | Tag::EstimatedCall => {
                    self.call_depth = self.depth;
                    self.call = RtCall { recorded: tag == Tag::RecordedCall, ..Default::default() };
                    self.dep_platform.clear();
                    self.assign_platform.clear();
                    Tag::Other
                }
                // Nested one level down in the real feed; unique names.
                Tag::DataFrameRef | Tag::DatedVehicleJourneyRef | Tag::TrainNumberRef => tag,
                Tag::RecordedAtTime
                | Tag::LineRef
                | Tag::JourneyCode
                | Tag::PublishedLineName
                | Tag::DirectionName
                | Tag::DestinationName
                | Tag::OriginName
                | Tag::OperatorRef
                | Tag::VehicleMode
                | Tag::Monitored
                | Tag::Cancellation
                | Tag::ExtraJourney
                | Tag::VehicleJourneyName
                | Tag::PredictionInaccurate
                | Tag::InCongestion
                    if self.depth == self.journey_depth + 1 =>
                {
                    tag
                }
                _ => Tag::Other,
            };
        }
        if self.assign_depth != 0 {
            return match tag {
                Tag::AimedQuayName | Tag::ExpectedQuayName | Tag::ActualQuayName | Tag::ExpectedQuayRef | Tag::ActualQuayRef
                    if self.depth == self.assign_depth + 1 =>
                {
                    tag
                }
                _ => Tag::Other,
            };
        }
        if self.depth != self.call_depth + 1 {
            return Tag::Other;
        }
        match tag {
            Tag::ArrAssign | Tag::DepAssign => {
                self.assign_depth = self.depth;
                self.assign_is_dep = tag == Tag::DepAssign;
                Tag::Other
            }
            Tag::StopPointRef
            | Tag::Order
            | Tag::VisitNumber
            | Tag::StopPointName
            | Tag::AimedArr
            | Tag::ExpectedArr
            | Tag::ActualArr
            | Tag::AimedDep
            | Tag::ExpectedDep
            | Tag::ActualDep
            | Tag::ArrPlatform
            | Tag::DepPlatform
            | Tag::ExtraCall
            | Tag::Cancellation
            | Tag::DestinationDisplay => tag,
            _ => Tag::Other,
        }
    }

    #[inline]
    fn leaf(&mut self, tag: Tag, text: &[u8]) {
        let j = &mut self.journey;
        let c = &mut self.call;
        match tag {
            Tag::ResponseTimestamp => self.response_ts = parse_time(text).unwrap_or(0),
            Tag::RecordedAtTime => {
                let t = parse_time(text).unwrap_or(0);
                if self.journey_depth == 0 {
                    self.frame_ts = t;
                } else {
                    j.recorded_at = t;
                    j.recorded_at_own = t != 0;
                }
            }
            Tag::LineRef => j.line_ref = text_string(text),
            Tag::DataFrameRef => j.operating_day = text_string(text),
            Tag::DatedVehicleJourneyRef => j.journey_ref = text_string(text),
            Tag::JourneyCode => self.journey_code = text_string(text),
            Tag::PublishedLineName => j.line_name = text_string(text),
            Tag::DirectionName => self.direction_name = text_string(text),
            Tag::DestinationName => self.destination_name = text_string(text),
            Tag::OriginName => j.origin = text_string(text),
            Tag::OperatorRef => j.operator_ref = text_string(text),
            Tag::VehicleMode => j.mode = text_string(text),
            Tag::Monitored => j.monitored = parse_bool(text),
            Tag::ExtraJourney => j.extra = parse_bool(text),
            Tag::TrainNumberRef | Tag::VehicleJourneyName => {
                if j.train_number.is_empty() {
                    j.train_number = text_string(text)
                }
            }
            Tag::PredictionInaccurate => j.prediction_inaccurate = parse_bool(text),
            Tag::InCongestion => j.in_congestion = parse_bool(text),
            Tag::Cancellation => {
                if self.call_depth == 0 {
                    j.cancelled = parse_bool(text)
                } else {
                    c.cancelled = parse_bool(text)
                }
            }
            Tag::StopPointRef => c.stop_ref = text_string(text),
            Tag::Order => c.order = parse_u16(text),
            Tag::VisitNumber => {
                if c.order == 0 {
                    c.order = parse_u16(text)
                }
            }
            Tag::StopPointName => c.stop_name = text_string(text),
            Tag::AimedArr => c.aimed_arr = parse_time(text),
            Tag::ExpectedArr => c.expected_arr = parse_time(text),
            Tag::ActualArr => c.actual_arr = parse_time(text),
            Tag::AimedDep => c.aimed_dep = parse_time(text),
            Tag::ExpectedDep => c.expected_dep = parse_time(text),
            Tag::ActualDep => c.actual_dep = parse_time(text),
            Tag::ArrPlatform => c.arr_platform = text_string(text),
            Tag::DepPlatform => self.dep_platform = text_string(text),
            Tag::ExtraCall => c.extra_call = parse_bool(text),
            Tag::DestinationDisplay => {
                self.destination_display.clear();
                self.destination_display.push_str(&String::from_utf8_lossy(trim(text)));
            }
            Tag::AimedQuayName => {
                // The departure side wins: it is the one that matters for boarding.
                if self.assign_is_dep || c.planned_platform.is_empty() {
                    c.planned_platform = text_string(text)
                }
            }
            Tag::ExpectedQuayName | Tag::ActualQuayName => {
                if self.assign_is_dep || self.assign_platform.is_empty() {
                    self.assign_platform = text_string(text)
                }
            }
            Tag::ExpectedQuayRef | Tag::ActualQuayRef => {
                if self.assign_is_dep || c.quay_ref.is_empty() {
                    c.quay_ref = text_string(text)
                }
            }
            Tag::Other | Tag::Journey | Tag::RecordedCall | Tag::EstimatedCall | Tag::ArrAssign | Tag::DepAssign => {}
        }
    }

    /// An element closed. Returns a finished journey when it was the journey element.
    #[inline]
    fn close(&mut self) -> Option<RtJourney> {
        let d = self.depth;
        self.depth = self.depth.saturating_sub(1);
        if self.journey_depth == 0 {
            return None;
        }
        if self.assign_depth == d {
            self.assign_depth = 0;
        } else if self.call_depth == d {
            self.call_depth = 0;
            let mut c = std::mem::take(&mut self.call);
            c.platform = if !self.dep_platform.is_empty() {
                std::mem::take(&mut self.dep_platform)
            } else if !self.assign_platform.is_empty() {
                std::mem::take(&mut self.assign_platform)
            } else {
                c.arr_platform.clone()
            };
            self.journey.calls.push(c);
        } else if self.journey_depth == d {
            self.journey_depth = 0;
            let mut j = std::mem::take(&mut self.journey);
            if j.journey_ref.is_empty() {
                j.journey_ref = std::mem::take(&mut self.journey_code);
            }
            j.destination = if !self.destination_name.is_empty() {
                std::mem::take(&mut self.destination_name)
            } else if !self.direction_name.is_empty() {
                std::mem::take(&mut self.direction_name)
            } else {
                std::mem::take(&mut self.destination_display)
            };
            if j.operating_day.is_empty() {
                // Not seen in the Swiss feed; fall back to the local calendar
                // date of the first aimed time.
                if let Some(t) = j.calls.iter().find_map(|c| c.aimed_dep.or(c.aimed_arr)) {
                    j.operating_day = kante_core::time::fmt_date(kante_core::time::from_unix(t).0);
                }
            }
            if j.recorded_at == 0 {
                j.recorded_at = if self.frame_ts != 0 { self.frame_ts } else { self.response_ts };
            }
            self.n += 1;
            return Some(j);
        }
        None
    }
}

/// Parse a SIRI-ET document, calling `sink` once per `EstimatedVehicleJourney`
/// in document order. Memory use is independent of the document size.
pub fn parse_siri_et<R: BufRead>(r: R, mut sink: impl FnMut(RtJourney)) -> Result<FeedMeta> {
    let mut reader = Reader::from_reader(r);
    {
        let cfg = reader.config_mut();
        cfg.check_end_names = false;
        cfg.check_comments = false;
    }
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut text: Vec<u8> = Vec::with_capacity(256);
    let mut st = State::default();
    let mut cur = Tag::Other;
    loop {
        let ev = reader
            .read_event_into(&mut buf)
            .with_context(|| format!("SIRI-ET: XML error at byte {}", reader.buffer_position()))?;
        match ev {
            Event::Start(e) => {
                cur = st.open(e.local_name().as_ref().as_bytes());
                text.clear();
            }
            Event::Text(t) => {
                if cur != Tag::Other {
                    text.extend_from_slice(t.as_bytes());
                }
            }
            Event::GeneralRef(r) => {
                if cur != Tag::Other {
                    push_entity(&mut text, r.as_bytes());
                }
            }
            Event::CData(t) => {
                if cur != Tag::Other {
                    text.extend_from_slice(t.as_bytes());
                }
            }
            Event::End(_) => {
                if cur != Tag::Other {
                    st.leaf(cur, &text);
                    cur = Tag::Other;
                }
                if let Some(j) = st.close() {
                    sink(j);
                }
            }
            Event::Empty(_) => {
                // An empty element carries nothing we use, but it also ends
                // the text of any leaf we were in (cannot happen in valid SIRI).
                cur = Tag::Other;
            }
            Event::Eof => break,
            Event::Decl(_) | Event::PI(_) | Event::DocType(_) | Event::Comment(_) => {}
        }
        buf.clear();
    }
    Ok(FeedMeta {
        timestamp: if st.response_ts != 0 { st.response_ts } else { st.frame_ts },
        journeys: st.n,
        source: "siri-et",
        feed_version: String::new(),
    })
}

/// Parse a gzip-compressed SIRI-ET document.
pub fn parse_siri_et_gz<R: Read>(r: R, sink: impl FnMut(RtJourney)) -> Result<FeedMeta> {
    let gz = flate2::read::MultiGzDecoder::new(r);
    parse_siri_et(BufReader::with_capacity(1 << 18, gz), sink)
}

/// Parse a SIRI-ET document that may or may not be gzip-compressed (sniffs the
/// gzip magic bytes).
pub fn parse_siri_et_auto<R: BufRead>(mut r: R, sink: impl FnMut(RtJourney)) -> Result<FeedMeta> {
    if is_gzip(r.fill_buf()?) {
        parse_siri_et_gz(r, sink)
    } else {
        parse_siri_et(r, sink)
    }
}

#[inline]
pub(crate) fn is_gzip(head: &[u8]) -> bool {
    head.len() >= 2 && head[0] == 0x1f && head[1] == 0x8b
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(xml: &str) -> (FeedMeta, Vec<RtJourney>) {
        let mut out = Vec::new();
        let meta = parse_siri_et(xml.as_bytes(), |j| out.push(j)).unwrap();
        (meta, out)
    }

    const DOC: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<Siri xmlns="http://www.siri.org.uk/siri" version="2.0"><ServiceDelivery>
<ResponseTimestamp>2026-11-20T21:55:05.525534Z</ResponseTimestamp><ProducerRef>test</ProducerRef>
<EstimatedTimetableDelivery><ResponseTimestamp>2026-11-20T21:55:06Z</ResponseTimestamp>
<EstimatedJourneyVersionFrame><RecordedAtTime>2026-11-20T21:54:51Z</RecordedAtTime>
<EstimatedVehicleJourney>
  <RecordedAtTime>2026-11-20T21:54:00Z</RecordedAtTime>
  <LineRef>ch:1:Line:11:IC1</LineRef><DirectionRef>ch:1:Direction:1</DirectionRef>
  <FramedVehicleJourneyRef><DataFrameRef>2026-11-20</DataFrameRef>
    <DatedVehicleJourneyRef>ch:1:sjyid:100001:733-001</DatedVehicleJourneyRef></FramedVehicleJourneyRef>
  <VehicleMode>rail</VehicleMode><PublishedLineName>IC 1</PublishedLineName>
  <DirectionName>St. Gallen</DirectionName><OriginName>Gen&#232;ve &amp; A&#xE9;roport</OriginName>
  <OperatorRef>ch:1:sboid:100001</OperatorRef><Monitored>true</Monitored>
  <TrainNumbers><TrainNumberRef>733</TrainNumberRef></TrainNumbers>
  <RecordedCalls><RecordedCall>
    <StopPointRef>ch:1:sloid:1008</StopPointRef><VisitNumber>1</VisitNumber><StopPointName>Genève</StopPointName>
    <AimedDepartureTime>2026-11-20T21:42:00Z</AimedDepartureTime>
    <ActualDepartureTime>2026-11-20T21:43:12Z</ActualDepartureTime>
    <DeparturePlatformName>4</DeparturePlatformName>
  </RecordedCall></RecordedCalls>
  <EstimatedCalls>
  <EstimatedCall>
    <StopPointRef>ch:1:sloid:7000</StopPointRef><VisitNumber>2</VisitNumber><StopPointName>Bern</StopPointName>
    <AimedArrivalTime>2026-11-20T23:26:00Z</AimedArrivalTime><ExpectedArrivalTime>2026-11-21T00:28:30+01:00</ExpectedArrivalTime>
    <ArrivalPlatformName>5</ArrivalPlatformName><ArrivalBoardingActivity>alighting</ArrivalBoardingActivity>
    <AimedDepartureTime>2026-11-20T23:32:00Z</AimedDepartureTime><ExpectedDepartureTime>2026-11-20T23:33:00Z</ExpectedDepartureTime>
    <DeparturePlatformName>7</DeparturePlatformName><CallNote>Cancellation</CallNote>
  </EstimatedCall>
  <EstimatedCall>
    <StopPointRef>ch:1:sloid:3000</StopPointRef><Order>9</Order><VisitNumber>3</VisitNumber>
    <ExtraCall>true</ExtraCall><Cancellation>true</Cancellation>
    <AimedArrivalTime>2026-11-21T00:28:00Z</AimedArrivalTime>
    <ArrivalPlatformName>33</ArrivalPlatformName>
    <DepartureStopAssignment><AimedQuayRef>q1</AimedQuayRef><AimedQuayName>31</AimedQuayName>
      <ExpectedQuayRef>ch:1:sloid:3000:501:34</ExpectedQuayRef><ExpectedQuayName>34</ExpectedQuayName></DepartureStopAssignment>
  </EstimatedCall>
  </EstimatedCalls><IsCompleteStopSequence>true</IsCompleteStopSequence>
</EstimatedVehicleJourney>
<EstimatedVehicleJourney>
  <LineRef>ch:1:Line:801:101</LineRef>
  <FramedVehicleJourneyRef><DataFrameRef>2026-11-20</DataFrameRef><DatedVehicleJourneyRef>ch:1:ServiceJourney:801:24125-3541</DatedVehicleJourneyRef></FramedVehicleJourneyRef>
  <PublishedLineName>101</PublishedLineName><DirectionName>Hinterkappelen</DirectionName><DestinationName>Hinterkappelen, Post</DestinationName>
  <OperatorRef>ch:1:sboid:100602</OperatorRef><ExtraJourney>true</ExtraJourney><Cancellation>true</Cancellation><Monitored>false</Monitored>
  <PredictionInaccurate>true</PredictionInaccurate>
</EstimatedVehicleJourney>
</EstimatedJourneyVersionFrame></EstimatedTimetableDelivery></ServiceDelivery></Siri>"#;

    #[test]
    fn journeys_and_calls() {
        let (meta, js) = parse(DOC);
        assert_eq!(meta.source, "siri-et");
        assert_eq!(meta.journeys, 2);
        assert_eq!(meta.timestamp, parse_time(b"2026-11-20T21:55:05Z").unwrap());
        let j = &js[0];
        assert_eq!(j.journey_ref, "ch:1:sjyid:100001:733-001");
        assert_eq!(j.operating_day, "2026-11-20");
        assert_eq!(j.line_ref, "ch:1:Line:11:IC1");
        assert_eq!(j.line_name, "IC 1");
        assert_eq!(j.operator_ref, "ch:1:sboid:100001");
        assert_eq!(j.destination, "St. Gallen");
        assert_eq!(j.origin, "Genève & Aéroport");
        assert_eq!(j.mode, "rail");
        assert_eq!(j.train_number, "733");
        assert!(j.monitored && !j.cancelled && !j.extra);
        assert_eq!(j.recorded_at, parse_time(b"2026-11-20T21:54:00Z").unwrap());
        assert_eq!(j.calls.len(), 3);

        let c = &j.calls[0];
        assert!(c.recorded);
        assert_eq!((c.stop_ref.as_str(), c.order, c.stop_name.as_str()), ("ch:1:sloid:1008", 1, "Genève"));
        assert_eq!(c.aimed_arr, None);
        assert_eq!(c.actual_dep.unwrap() - c.aimed_dep.unwrap(), 72);
        assert_eq!(c.platform, "4");

        let c = &j.calls[1];
        assert!(!c.recorded && !c.cancelled && !c.extra_call);
        // The +01:00 offset and the Z form describe the same instant scale.
        assert_eq!(c.expected_arr.unwrap() - c.aimed_arr.unwrap(), 150);
        assert_eq!(c.expected_dep.unwrap() - c.aimed_dep.unwrap(), 60);
        assert_eq!((c.arr_platform.as_str(), c.platform.as_str()), ("5", "7"));
        assert_eq!(c.planned_platform, "");

        let c = &j.calls[2];
        assert!(c.cancelled && c.extra_call);
        assert_eq!(c.order, 9, "Order wins over VisitNumber");
        assert_eq!(c.aimed_dep, None);
        assert_eq!((c.planned_platform.as_str(), c.platform.as_str()), ("31", "34"));
        assert_eq!(c.quay_ref, "ch:1:sloid:3000:501:34");
        assert_eq!(c.arr_platform, "33");

        let j = &js[1];
        assert_eq!(j.journey_ref, "ch:1:ServiceJourney:801:24125-3541");
        assert!(j.cancelled && j.extra && !j.monitored && j.prediction_inaccurate);
        assert_eq!(j.destination, "Hinterkappelen, Post");
        assert!(j.calls.is_empty());
        // No journey-level RecordedAtTime: the frame's is used.
        assert_eq!(j.recorded_at, parse_time(b"2026-11-20T21:54:51Z").unwrap());
    }

    #[test]
    fn times() {
        let base = 1_795_211_705; // 2026-11-20T21:55:05Z
        assert_eq!(parse_time(b"2026-11-20T21:55:05Z"), Some(base));
        assert_eq!(parse_time(b"2026-11-20T21:55:05.525534Z"), Some(base));
        assert_eq!(parse_time(b"2026-11-20T22:55:05+01:00"), Some(base));
        assert_eq!(parse_time(b"2026-11-20T22:55:05+0100"), Some(base));
        assert_eq!(parse_time(b" 2026-11-20T16:55:05.1-05:00 "), Some(base));
        // No zone: Europe/Zurich local time (CET in November, CEST in July).
        assert_eq!(parse_time(b"2026-11-20T22:55:05"), Some(base));
        assert_eq!(parse_time(b"2026-07-01T12:00:00"), parse_time(b"2026-07-01T10:00:00Z"));
        assert_eq!(parse_time(b"1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_time(b"2024-02-29T00:00:00Z"), Some(1_709_164_800));
        assert_eq!(parse_time(b""), None);
        assert_eq!(parse_time(b"2026-11-20"), None);
        assert_eq!(parse_time(b"2026-13-20T21:55:05Z"), None);
        assert_eq!(parse_time(b"2026-11-20T21:55:05X"), None);
    }

    #[test]
    fn overnight_operating_day_is_kept() {
        // A run after midnight local time still belongs to the previous operating day.
        let xml = r#"<Siri><ServiceDelivery><EstimatedTimetableDelivery><EstimatedJourneyVersionFrame>
<EstimatedVehicleJourney><FramedVehicleJourneyRef><DataFrameRef>2026-11-20</DataFrameRef>
<DatedVehicleJourneyRef>x</DatedVehicleJourneyRef></FramedVehicleJourneyRef>
<EstimatedCalls><EstimatedCall><StopPointRef>a</StopPointRef>
<AimedDepartureTime>2026-11-20T23:25:30Z</AimedDepartureTime></EstimatedCall></EstimatedCalls></EstimatedVehicleJourney>
<EstimatedVehicleJourney><DatedVehicleJourneyRef>y</DatedVehicleJourneyRef>
<EstimatedCalls><EstimatedCall><StopPointRef>a</StopPointRef>
<AimedDepartureTime>2026-11-20T23:25:30Z</AimedDepartureTime></EstimatedCall></EstimatedCalls></EstimatedVehicleJourney>
</EstimatedJourneyVersionFrame></EstimatedTimetableDelivery></ServiceDelivery></Siri>"#;
        let (meta, js) = parse(xml);
        assert_eq!(meta.timestamp, 0);
        assert_eq!(js[0].operating_day, "2026-11-20");
        let (date, secs) = kante_core::time::from_unix(js[0].calls[0].aimed_dep.unwrap());
        assert_eq!((kante_core::time::fmt_date(date).as_str(), secs), ("2026-11-21", 25 * 60 + 30));
        // Without DataFrameRef the local calendar date of the first aimed time is used.
        assert_eq!(js[1].journey_ref, "y");
        assert_eq!(js[1].operating_day, "2026-11-21");
    }

    #[test]
    fn gzip_is_sniffed() {
        use std::io::Write;
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        enc.write_all(DOC.as_bytes()).unwrap();
        let gz = enc.finish().unwrap();
        let mut a = Vec::new();
        let m1 = parse_siri_et_auto(&gz[..], |j| a.push(j)).unwrap();
        let (m2, b) = parse(DOC);
        assert_eq!(m1, m2);
        assert_eq!(a, b);
        let mut c = Vec::new();
        parse_siri_et_auto(DOC.as_bytes(), |j| c.push(j)).unwrap();
        assert_eq!(c, b);
    }

    #[test]
    fn malformed_xml_is_an_error() {
        let r = parse_siri_et(&b"<Siri><EstimatedVehicleJourney><LineRef>x</LineRef"[..], |_| {});
        assert!(r.is_err());
    }
}
