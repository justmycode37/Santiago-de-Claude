//! GTFS-Realtime TripUpdates, decoded by hand from the protobuf wire format
//! (no codegen, no `protoc`).
//!
//! Only the messages on the path `FeedMessage → FeedEntity → TripUpdate →
//! StopTimeUpdate` are read; everything else is skipped by wire type.
//!
//! Field numbers (gtfs-realtime.proto, plus the Swiss extension) as verified
//! in the national sample of 2026-11-20:
//!
//! ```text
//! FeedMessage      1 header, 2 entity*
//! FeedHeader       1 gtfs_realtime_version, 2 incrementality, 3 timestamp, 4 feed_version
//! FeedEntity       1 id, 2 is_deleted, 3 trip_update
//! TripUpdate       1 trip, 2 stop_time_update*, 4 timestamp, 5 delay
//! TripDescriptor   1 trip_id, 2 start_time, 3 start_date, 4 schedule_relationship,
//!                  5 route_id, 6 direction_id, 8 original_trip_id (Swiss: SJYID or
//!                  legacy "85:801:7631-1276"; absent on cancelled trips)
//! StopTimeUpdate   1 stop_sequence, 2 arrival, 3 departure, 4 stop_id,
//!                  5 schedule_relationship, 6 stop_time_properties
//! StopTimeEvent    1 delay (int32, seconds), 2 time (int64, unix), 3 uncertainty
//! StopTimeProperties 1 assigned_stop_id
//! ```
//!
//! The operating day is `TripDescriptor.start_date` (`YYYYMMDD`); the platform
//! is implied by `stop_id`, which is a `stop_id` of the static GTFS feed named
//! in `FeedHeader.feed_version` (a boarding point for ~60 % of the updates).

use crate::model::{FeedMeta, RtCall, RtJourney};
use anyhow::{bail, Result};
use std::borrow::Cow;
use std::io::Read;

/// A cursor over one protobuf message.
struct Pb<'a> {
    b: &'a [u8],
    i: usize,
}

enum Val<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
    /// 32- or 64-bit fixed value; nothing we read uses them.
    Fixed,
}

impl<'a> Pb<'a> {
    fn new(b: &'a [u8]) -> Self {
        Pb { b, i: 0 }
    }

    #[inline]
    fn varint(&mut self) -> Result<u64> {
        let mut v = 0u64;
        let mut shift = 0u32;
        loop {
            let Some(&c) = self.b.get(self.i) else { bail!("protobuf: truncated varint at byte {}", self.i) };
            self.i += 1;
            if shift < 64 {
                v |= ((c & 0x7f) as u64) << shift;
            }
            if c < 0x80 {
                return Ok(v);
            }
            shift += 7;
            if shift > 70 {
                bail!("protobuf: varint too long at byte {}", self.i);
            }
        }
    }

    /// Next `(field number, value)` or `None` at the end of the message.
    #[inline]
    fn next(&mut self) -> Result<Option<(u32, Val<'a>)>> {
        if self.i >= self.b.len() {
            return Ok(None);
        }
        let key = self.varint()?;
        let field = (key >> 3) as u32;
        let val = match key & 7 {
            0 => Val::Varint(self.varint()?),
            1 => {
                self.skip(8)?;
                Val::Fixed
            }
            2 => {
                let len = self.varint()? as usize;
                let start = self.i;
                self.skip(len)?;
                Val::Bytes(&self.b[start..start + len])
            }
            5 => {
                self.skip(4)?;
                Val::Fixed
            }
            w => bail!("protobuf: unsupported wire type {w} for field {field} at byte {}", self.i),
        };
        Ok(Some((field, val)))
    }

    #[inline]
    fn skip(&mut self, n: usize) -> Result<()> {
        match self.i.checked_add(n) {
            Some(end) if end <= self.b.len() => {
                self.i = end;
                Ok(())
            }
            _ => bail!("protobuf: field of {n} bytes runs past the end at byte {}", self.i),
        }
    }
}

#[inline]
fn string(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

/// `YYYYMMDD` → `YYYY-MM-DD`; anything else is passed through.
fn iso_date(b: &[u8]) -> String {
    if b.len() == 8 && b.iter().all(u8::is_ascii_digit) {
        let s = std::str::from_utf8(b).unwrap();
        format!("{}-{}-{}", &s[0..4], &s[4..6], &s[6..8])
    } else {
        string(b)
    }
}

// TripDescriptor.ScheduleRelationship
const TRIP_ADDED: u64 = 1;
const TRIP_CANCELED: u64 = 3;
const TRIP_REPLACEMENT: u64 = 5;
const TRIP_DUPLICATED: u64 = 6;
const TRIP_DELETED: u64 = 7;
// StopTimeUpdate.ScheduleRelationship
const STOP_SKIPPED: u64 = 1;
const STOP_NO_DATA: u64 = 2;

fn stop_time_event(b: &[u8]) -> Result<(Option<i32>, Option<i64>)> {
    let mut pb = Pb::new(b);
    let (mut delay, mut time) = (None, None);
    while let Some((f, v)) = pb.next()? {
        match (f, v) {
            // Negative int32 values are sign-extended to 64 bits on the wire.
            (1, Val::Varint(x)) => delay = Some(x as i64 as i32),
            (2, Val::Varint(x)) => time = Some(x as i64),
            _ => {}
        }
    }
    Ok((delay, time))
}

fn stop_time_update(b: &[u8]) -> Result<RtCall> {
    let mut pb = Pb::new(b);
    let mut c = RtCall::default();
    while let Some((f, v)) = pb.next()? {
        match (f, v) {
            (1, Val::Varint(x)) => c.order = x.min(u16::MAX as u64) as u16,
            (2, Val::Bytes(m)) => (c.arr_delay, c.expected_arr) = stop_time_event(m)?,
            (3, Val::Bytes(m)) => (c.dep_delay, c.expected_dep) = stop_time_event(m)?,
            (4, Val::Bytes(s)) => c.stop_ref = string(s),
            (5, Val::Varint(x)) => {
                c.cancelled = x == STOP_SKIPPED;
                c.no_data = x == STOP_NO_DATA;
            }
            (6, Val::Bytes(m)) => {
                let mut p = Pb::new(m);
                while let Some((f, v)) = p.next()? {
                    if let (1, Val::Bytes(s)) = (f, v) {
                        c.quay_ref = string(s);
                    }
                }
            }
            _ => {}
        }
    }
    Ok(c)
}

fn trip_descriptor(b: &[u8], j: &mut RtJourney) -> Result<()> {
    let mut pb = Pb::new(b);
    while let Some((f, v)) = pb.next()? {
        match (f, v) {
            (1, Val::Bytes(s)) => j.trip_id = string(s),
            (2, Val::Bytes(s)) => j.start_time = string(s),
            (3, Val::Bytes(s)) => j.operating_day = iso_date(s),
            (4, Val::Varint(x)) => {
                j.cancelled = matches!(x, TRIP_CANCELED | TRIP_DELETED);
                j.extra = matches!(x, TRIP_ADDED | TRIP_REPLACEMENT | TRIP_DUPLICATED);
            }
            (5, Val::Bytes(s)) => j.line_ref = string(s),
            (8, Val::Bytes(s)) => j.journey_ref = string(s),
            _ => {}
        }
    }
    Ok(())
}

fn trip_update(b: &[u8], feed_ts: i64) -> Result<RtJourney> {
    let mut pb = Pb::new(b);
    // A trip in this feed has real-time data by definition.
    let mut j = RtJourney { monitored: true, recorded_at: feed_ts, ..Default::default() };
    while let Some((f, v)) = pb.next()? {
        match (f, v) {
            (1, Val::Bytes(m)) => trip_descriptor(m, &mut j)?,
            (2, Val::Bytes(m)) => j.calls.push(stop_time_update(m)?),
            (4, Val::Varint(x)) if x != 0 => {
                j.recorded_at = x as i64;
                j.recorded_at_own = true;
            }
            _ => {}
        }
    }
    Ok(j)
}

/// Decode a GTFS-RT `FeedMessage` (gzip is detected and unpacked), calling
/// `sink` once per entity that carries a `TripUpdate`, in feed order.
///
/// Mapping onto the shared model: `journey_ref` = `original_trip_id`,
/// `trip_id` = `trip_id`, `operating_day` = `start_date`, `line_ref` =
/// `route_id`, `cancelled` = CANCELED/DELETED, `extra` = ADDED/REPLACEMENT/
/// DUPLICATED; per stop `stop_ref` = `stop_id`, `order` = `stop_sequence`,
/// `expected_*` = absolute `time` where given, `arr_delay`/`dep_delay` =
/// `delay` where given, `cancelled` = SKIPPED, `no_data` = NO_DATA.
pub fn parse_gtfs_rt(bytes: &[u8], mut sink: impl FnMut(RtJourney)) -> Result<FeedMeta> {
    let bytes: Cow<[u8]> = if crate::siri::is_gzip(bytes) {
        let mut out = Vec::with_capacity(bytes.len() * 4);
        flate2::read::MultiGzDecoder::new(bytes).read_to_end(&mut out)?;
        Cow::Owned(out)
    } else {
        Cow::Borrowed(bytes)
    };
    let mut meta = FeedMeta { source: "gtfs-rt", ..Default::default() };
    let mut pb = Pb::new(&bytes);
    while let Some((f, v)) = pb.next()? {
        match (f, v) {
            (1, Val::Bytes(m)) => {
                let mut h = Pb::new(m);
                while let Some((f, v)) = h.next()? {
                    match (f, v) {
                        (3, Val::Varint(x)) => meta.timestamp = x as i64,
                        (4, Val::Bytes(s)) => meta.feed_version = string(s),
                        _ => {}
                    }
                }
            }
            (2, Val::Bytes(m)) => {
                let mut e = Pb::new(m);
                let mut deleted = false;
                let mut journey = None;
                while let Some((f, v)) = e.next()? {
                    match (f, v) {
                        (2, Val::Varint(x)) => deleted = x != 0,
                        (3, Val::Bytes(tu)) => journey = Some(trip_update(tu, meta.timestamp)?),
                        _ => {}
                    }
                }
                if let (Some(j), false) = (journey, deleted) {
                    meta.journeys += 1;
                    sink(j);
                }
            }
            _ => {}
        }
    }
    Ok(meta)
}

/// Minimal protobuf writer, used by tests (here and in the matcher) to
/// hand-encode feeds.
#[cfg(test)]
pub(crate) mod enc {
    pub fn varint(out: &mut Vec<u8>, mut v: u64) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                return;
            }
            out.push(b | 0x80);
        }
    }
    pub fn int(out: &mut Vec<u8>, field: u32, v: i64) {
        varint(out, (field as u64) << 3);
        varint(out, v as u64);
    }
    pub fn bytes(out: &mut Vec<u8>, field: u32, b: &[u8]) {
        varint(out, ((field as u64) << 3) | 2);
        varint(out, b.len() as u64);
        out.extend_from_slice(b);
    }
    pub fn msg(field: u32, parts: &[Vec<u8>]) -> Vec<u8> {
        let mut out = Vec::new();
        bytes(&mut out, field, &parts.concat());
        out
    }
    pub fn s(field: u32, v: &str) -> Vec<u8> {
        let mut out = Vec::new();
        bytes(&mut out, field, v.as_bytes());
        out
    }
    pub fn i(field: u32, v: i64) -> Vec<u8> {
        let mut out = Vec::new();
        int(&mut out, field, v);
        out
    }
    /// StopTimeUpdate with optional delay-only arrival/departure.
    pub fn stu(seq: i64, stop: &str, arr_delay: Option<i64>, dep_delay: Option<i64>, rel: i64) -> Vec<u8> {
        let mut parts = vec![i(1, seq)];
        if let Some(d) = arr_delay {
            parts.push(msg(2, &[i(1, d)]));
        }
        if let Some(d) = dep_delay {
            parts.push(msg(3, &[i(1, d)]));
        }
        parts.push(s(4, stop));
        parts.push(i(5, rel));
        msg(2, &parts)
    }
    pub fn header(ts: i64, version: &str) -> Vec<u8> {
        msg(1, &[s(1, "2.0"), i(2, 0), i(3, ts), s(4, version)])
    }
    /// FeedEntity wrapping a TripUpdate.
    pub fn entity(id: &str, trip: &[Vec<u8>], stus: &[Vec<u8>]) -> Vec<u8> {
        let mut tu = vec![msg(1, trip)];
        tu.extend_from_slice(stus);
        msg(2, &[s(1, id), msg(3, &tu)])
    }
}

#[cfg(test)]
mod tests {
    use super::enc::*;
    use super::*;

    fn parse(b: &[u8]) -> (FeedMeta, Vec<RtJourney>) {
        let mut out = Vec::new();
        let meta = parse_gtfs_rt(b, |j| out.push(j)).unwrap();
        (meta, out)
    }

    fn feed() -> Vec<u8> {
        let mut f = header(1_795_211_721, "20261118");
        // Scheduled trip, delay-only, one skipped stop, a negative delay.
        f.extend(entity(
            "e1",
            &[s(1, ".ojp-91-1-D.1.TA.1063.j26"), s(2, "18:25:00"), s(3, "20261120"), i(4, 0), s(5, "91-1-D-j26-1"), s(8, "ch:1:sjyid:100001:733-001")],
            &[
                stu(1, "ch:1:sloid:1026:2:4", None, Some(66), 0),
                stu(2, "ch:1:sloid:1008:3:4", Some(-30), Some(72), 0),
                stu(4, "ch:1:sloid:7000:4:8", None, None, 1),
            ],
        ));
        // Added trip with absolute times and an assigned stop; unknown fields
        // of every wire type are skipped.
        let mut unknown = Vec::new();
        varint(&mut unknown, (15 << 3) | 1);
        unknown.extend_from_slice(&[0; 8]);
        varint(&mut unknown, (16 << 3) | 5);
        unknown.extend_from_slice(&[0; 4]);
        let abs = msg(
            2,
            &[i(1, 3), msg(2, &[i(2, 1_795_212_000), i(3, 30)]), msg(3, &[i(2, 1_795_212_060)]), s(4, "8507000"), msg(6, &[s(1, "ch:1:sloid:7000:3:5")]), unknown],
        );
        f.extend(entity("e2", &[s(1, "ojp:added"), s(3, "20261121"), i(4, 1)], &[abs]));
        // Cancelled trip without stops and without original_trip_id.
        f.extend(entity("e3", &[s(1, ".ojp-91-2-H.1.TA.1270.j26"), s(3, "20261120"), i(4, 3)], &[]));
        // An entity without trip update (e.g. an alert) is ignored.
        f.extend(msg(2, &[s(1, "e4"), msg(5, &[s(1, "x")])]));
        f
    }

    #[test]
    fn decodes_trip_updates() {
        let (meta, js) = parse(&feed());
        assert_eq!(meta, FeedMeta { timestamp: 1_795_211_721, journeys: 3, source: "gtfs-rt", feed_version: "20261118".into() });

        let j = &js[0];
        assert_eq!(j.journey_ref, "ch:1:sjyid:100001:733-001");
        assert_eq!(j.trip_id, ".ojp-91-1-D.1.TA.1063.j26");
        assert_eq!(j.operating_day, "2026-11-20");
        assert_eq!(j.start_time, "18:25:00");
        assert_eq!(j.line_ref, "91-1-D-j26-1");
        assert!(j.monitored && !j.cancelled && !j.extra);
        assert_eq!(j.recorded_at, 1_795_211_721);
        assert_eq!(j.calls.len(), 3);
        assert_eq!((j.calls[0].order, j.calls[0].arr_delay, j.calls[0].dep_delay), (1, None, Some(66)));
        assert_eq!((j.calls[1].arr_delay, j.calls[1].dep_delay), (Some(-30), Some(72)));
        assert_eq!(j.calls[1].stop_ref, "ch:1:sloid:1008:3:4");
        assert!(j.calls[2].cancelled && j.calls[2].order == 4);
        assert_eq!(j.calls[2].dep_delay, None);

        let j = &js[1];
        assert!(j.extra && !j.cancelled);
        assert_eq!(j.operating_day, "2026-11-21");
        let c = &j.calls[0];
        assert_eq!((c.expected_arr, c.expected_dep), (Some(1_795_212_000), Some(1_795_212_060)));
        assert_eq!((c.arr_delay, c.dep_delay), (None, None));
        assert_eq!((c.stop_ref.as_str(), c.quay_ref.as_str()), ("8507000", "ch:1:sloid:7000:3:5"));

        let j = &js[2];
        assert!(j.cancelled && j.journey_ref.is_empty() && j.calls.is_empty());
    }

    #[test]
    fn gzip_and_truncation() {
        use std::io::Write;
        let f = feed();
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        enc.write_all(&f).unwrap();
        assert_eq!(parse(&enc.finish().unwrap()), parse(&f));
        assert!(parse_gtfs_rt(&f[..f.len() - 3], |_| {}).is_err());
        assert_eq!(parse(&[]).0.journeys, 0);
    }
}
