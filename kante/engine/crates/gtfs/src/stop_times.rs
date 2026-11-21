//! `stop_times.txt` (3.7 GB uncompressed in the national feed): one thread
//! inflates the zip member and cuts it into line-aligned chunks, a pool of
//! workers turns the chunks into compact rows.

use crate::csv::{self, Field, Header};
use crate::zipio;
use anyhow::{anyhow, bail, Context, Result};
use kante_core::{FLAG_DROPOFF_ON_REQUEST, FLAG_NO_DROPOFF, FLAG_NO_PICKUP, FLAG_PICKUP_ON_REQUEST, NONE};
use rustc_hash::FxHashMap;
use std::io::Read;
use std::path::Path;
use std::sync::mpsc::{Receiver, Sender, SyncSender};
use std::sync::Mutex;

/// Marker for an empty arrival/departure time (filled in later).
pub const MISSING: i32 = i32::MIN;

const CHUNK: usize = 8 << 20;
/// Chunks buffered between the inflater and the parsers (≈ 2 GB at most), so
/// that inflating can run ahead while the trip table is still being built.
pub const CHANNEL_CAP: usize = 256;

#[derive(Clone, Copy, Debug)]
pub struct StRow {
    /// Row index into the parsed trips table.
    pub trip: u32,
    /// Row index into the parsed stops table.
    pub stop: u32,
    pub arr: i32,
    pub dep: i32,
    /// `stop_sequence << 8 | pattern flags`
    pub seqf: u32,
}

impl StRow {
    #[inline]
    pub fn seq(&self) -> u32 {
        self.seqf >> 8
    }
    #[inline]
    pub fn flags(&self) -> u8 {
        self.seqf as u8
    }
}

#[derive(Clone, Copy, Debug)]
pub struct StCols {
    trip: usize,
    arr: usize,
    dep: usize,
    stop: usize,
    seq: usize,
    pickup: Option<usize>,
    dropoff: Option<usize>,
    /// Highest required column index.
    need: usize,
}

impl StCols {
    pub fn from_header(h: &Header) -> Result<StCols> {
        let c = StCols {
            trip: h.col("trip_id")?,
            arr: h.col("arrival_time")?,
            dep: h.col("departure_time")?,
            stop: h.col("stop_id")?,
            seq: h.col("stop_sequence")?,
            pickup: h.opt("pickup_type"),
            dropoff: h.opt("drop_off_type"),
            need: 0,
        };
        let need = c.trip.max(c.arr).max(c.dep).max(c.stop).max(c.seq);
        Ok(StCols { need, ..c })
    }
}

pub struct Chunk {
    pub idx: usize,
    pub data: Vec<u8>,
    /// Offset of the first data record (skips the header in chunk 0).
    pub start: usize,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct StStats {
    pub rows: u64,
    pub malformed: u64,
    pub unknown_trip: u64,
    pub unknown_stop: u64,
}

impl StStats {
    pub fn add(&mut self, o: &StStats) {
        self.rows += o.rows;
        self.malformed += o.malformed;
        self.unknown_trip += o.unknown_trip;
        self.unknown_stop += o.unknown_stop;
    }
}

/// Inflate `stop_times.txt` and send line-aligned chunks. The column layout is
/// sent once, before the first chunk. Returns the uncompressed size.
pub fn inflate(zip: &Path, tx: SyncSender<Chunk>, cols_tx: Sender<StCols>) -> Result<u64> {
    let mut ar = zipio::open(zip)?;
    let mut f = ar.by_name("stop_times.txt").map_err(|e| anyhow!("stop_times.txt: {e}"))?;
    let mut carry: Vec<u8> = Vec::new();
    let mut idx = 0;
    let mut header_done = false;
    let mut total = 0u64;
    loop {
        let mut buf = Vec::with_capacity(carry.len() + CHUNK + 16);
        buf.append(&mut carry);
        let n = (&mut f).take(CHUNK as u64).read_to_end(&mut buf).context("stop_times.txt: decompression failed")?;
        total += n as u64;
        let eof = n == 0;
        let cut = if eof {
            buf.len()
        } else {
            match memchr::memrchr(b'\n', &buf) {
                Some(i) => i + 1,
                None => {
                    carry = buf;
                    continue;
                }
            }
        };
        carry.extend_from_slice(&buf[cut..]);
        buf.truncate(cut);
        let mut start = 0;
        if !header_done {
            let h = Header::parse("stop_times.txt", &buf, b',')?;
            if cols_tx.send(StCols::from_header(&h)?).is_err() {
                return Ok(total);
            }
            start = h.body;
            header_done = true;
        }
        if start < buf.len() {
            if tx.send(Chunk { idx, data: buf, start }).is_err() {
                // The importer gave up (an error elsewhere); stop quietly.
                return Ok(total);
            }
            idx += 1;
        }
        if eof {
            break;
        }
    }
    if !header_done {
        bail!("stop_times.txt: file is empty");
    }
    Ok(total)
}

#[inline]
fn raw<'a>(buf: &'a [u8], fields: &[Field], col: usize) -> &'a [u8] {
    let f = &fields[col];
    &buf[f.start..f.end]
}

pub fn parse_chunk(
    buf: &[u8],
    cols: &StCols,
    trips: &FxHashMap<&[u8], u32>,
    stops: &FxHashMap<&[u8], u32>,
    rows: &mut Vec<StRow>,
    st: &mut StStats,
) {
    let mut fields: Vec<Field> = Vec::with_capacity(16);
    let mut pos = 0;
    let mut last_trip: &[u8] = b"";
    let mut last_idx = NONE;
    while pos < buf.len() {
        pos = csv::next_record(buf, pos, b',', &mut fields);
        if fields.len() <= cols.need {
            if !(fields.len() == 1 && fields[0].is_empty()) {
                st.malformed += 1;
            }
            continue;
        }
        st.rows += 1;
        // Rows of one trip are consecutive: only look the id up when it changes.
        let tb = raw(buf, &fields, cols.trip);
        if tb != last_trip {
            last_trip = tb;
            last_idx = trips.get(tb).copied().unwrap_or(NONE);
        }
        if last_idx == NONE {
            st.unknown_trip += 1;
            continue;
        }
        let Some(&stop) = stops.get(raw(buf, &fields, cols.stop)) else {
            st.unknown_stop += 1;
            continue;
        };
        let seq = match csv::parse_u32(raw(buf, &fields, cols.seq)) {
            Some(s) if s < (1 << 24) => s,
            _ => {
                st.malformed += 1;
                continue;
            }
        };
        let arr = csv::parse_time(raw(buf, &fields, cols.arr)).unwrap_or(MISSING);
        let dep = csv::parse_time(raw(buf, &fields, cols.dep)).unwrap_or(MISSING);
        let mut flags = 0u8;
        if let Some(c) = cols.pickup {
            if let Some(f) = fields.get(c) {
                match &buf[f.start..f.end] {
                    b"1" => flags |= FLAG_NO_PICKUP,
                    b"2" | b"3" => flags |= FLAG_PICKUP_ON_REQUEST,
                    _ => {}
                }
            }
        }
        if let Some(c) = cols.dropoff {
            if let Some(f) = fields.get(c) {
                match &buf[f.start..f.end] {
                    b"1" => flags |= FLAG_NO_DROPOFF,
                    b"2" | b"3" => flags |= FLAG_DROPOFF_ON_REQUEST,
                    _ => {}
                }
            }
        }
        rows.push(StRow { trip: last_idx, stop, arr, dep, seqf: seq << 8 | flags as u32 });
    }
}

/// Worker loop: take chunks until the inflater is done.
pub fn worker(
    rx: &Mutex<Receiver<Chunk>>,
    cols: &StCols,
    trips: &FxHashMap<&[u8], u32>,
    stops: &FxHashMap<&[u8], u32>,
) -> (Vec<(usize, Vec<StRow>)>, StStats) {
    let mut out = Vec::new();
    let mut st = StStats::default();
    loop {
        let chunk = {
            let guard = rx.lock().unwrap_or_else(|e| e.into_inner());
            guard.recv()
        };
        let Ok(chunk) = chunk else { break };
        let buf = &chunk.data[chunk.start..];
        let mut rows = Vec::with_capacity(buf.len() / 72 + 16);
        parse_chunk(buf, cols, trips, stops, &mut rows, &mut st);
        out.push((chunk.idx, rows));
    }
    (out, st)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk() {
        let hdr = b"trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\r\n";
        let h = Header::parse("stop_times.txt", hdr, b',').unwrap();
        let cols = StCols::from_header(&h).unwrap();
        let body = b"\"t1\",\"05:47:00\",\"05:48:00\",\"s1\",\"1\",\"0\",\"1\"\r\n\
                     \"t1\",\"\",\"\",\"s2\",\"2\",\"2\",\"3\"\r\n\
                     \"tX\",\"06:00:00\",\"06:00:00\",\"s2\",\"3\",\"0\",\"0\"\r\n\
                     \"t1\",\"25:00:00\",\"25:00:00\",\"sX\",\"3\",\"0\",\"0\"\r\n\
                     \"t1\",\"25:00:00\"\r\n\
                     \"t2\",\"25:00:00\",\"25:01:00\",\"s1\",\"7\",\"1\",\"0\"\r\n";
        let mut trips: FxHashMap<&[u8], u32> = FxHashMap::default();
        trips.insert(b"t1", 0);
        trips.insert(b"t2", 1);
        let mut stops: FxHashMap<&[u8], u32> = FxHashMap::default();
        stops.insert(b"s1", 10);
        stops.insert(b"s2", 11);
        let mut rows = Vec::new();
        let mut st = StStats::default();
        parse_chunk(body, &cols, &trips, &stops, &mut rows, &mut st);
        assert_eq!((st.rows, st.malformed, st.unknown_trip, st.unknown_stop), (5, 1, 1, 1));
        assert_eq!(rows.len(), 3);
        assert_eq!((rows[0].trip, rows[0].stop, rows[0].arr, rows[0].dep, rows[0].seq(), rows[0].flags()), (0, 10, 20820, 20880, 1, FLAG_NO_DROPOFF));
        assert_eq!((rows[1].arr, rows[1].dep, rows[1].flags()), (MISSING, MISSING, FLAG_PICKUP_ON_REQUEST | FLAG_DROPOFF_ON_REQUEST));
        assert_eq!((rows[2].trip, rows[2].arr, rows[2].dep, rows[2].seq(), rows[2].flags()), (1, 90000, 90060, 7, FLAG_NO_PICKUP));
        assert!(Header::parse("stop_times.txt", b"trip_id,stop_id\n", b',').and_then(|h| StCols::from_header(&h)).is_err());
    }
}
