//! The import pipeline: zip members → tables → patterns → `Timetable`.

use crate::atlas::{self, Atlas};
use crate::csv::{self, Field, Header, Table};
use crate::patterns::{self, Inst, TripTable};
use crate::report::ImportReport;
use crate::stop_times::{self, StRow, StStats};
use crate::{zipio, ImportOptions};
use anyhow::{anyhow, bail, Result};
use kante_core::time::{self, Date};
use kante_core::*;
use rayon::prelude::*;
use rustc_hash::FxHashMap;
use std::sync::mpsc::{channel, sync_channel};
use std::sync::Mutex;
use std::thread::ScopedJoinHandle;
use std::time::Instant;

/// Upper bound on trips materialised from one frequencies.txt row (untrusted input).
const MAX_FREQ_TRIPS_PER_ROW: i64 = 5_000;
/// Feeds longer than this are rejected rather than allocating absurd bitsets.
const MAX_FEED_DAYS: i64 = 5 * 366;

fn join<T>(h: ScopedJoinHandle<'_, Result<T>>, what: &str) -> Result<T> {
    h.join().map_err(|_| anyhow!("{what}: worker thread panicked"))?
}

struct Phases {
    last: Instant,
}

impl Phases {
    fn mark(&mut self, rep: &mut ImportReport, name: &str) {
        let now = Instant::now();
        rep.phases.push((name.to_string(), (now - self.last).as_secs_f64()));
        self.last = now;
    }
}

// ---------------------------------------------------------------------------
// Small tables
// ---------------------------------------------------------------------------

pub(crate) fn mode_of(route_type: u16) -> Mode {
    match route_type {
        116 => Mode::RackRail,
        100..=199 => Mode::Rail,
        200..=299 => Mode::Bus,
        400..=499 => Mode::Metro,
        715 => Mode::OnDemand,
        700..=899 => Mode::Bus,
        900..=999 => Mode::Tram,
        1000..=1099 | 1200..=1299 => Mode::Boat,
        1303 => Mode::Lift,
        1300..=1399 => Mode::Cableway,
        1400..=1499 => Mode::Funicular,
        1500..=1599 => Mode::OnDemand,
        // Basic GTFS route types, should a feed use them.
        0 | 5 => Mode::Tram,
        1 => Mode::Metro,
        2 | 12 => Mode::Rail,
        3 | 11 => Mode::Bus,
        4 => Mode::Boat,
        6 => Mode::Cableway,
        7 => Mode::Funicular,
        _ => Mode::Other,
    }
}

/// Weight of one departure in `Station::weight`. Rail dominates so that the
/// railway station outranks the bus stops named after it.
fn mode_weight(m: Mode) -> f64 {
    match m {
        Mode::Rail => 10.0,
        Mode::RackRail => 5.0,
        Mode::Metro => 4.0,
        Mode::Boat => 3.0,
        Mode::Tram | Mode::Funicular => 2.0,
        Mode::Bus | Mode::Cableway | Mode::Lift | Mode::Other => 1.0,
        Mode::OnDemand => 0.5,
    }
}

fn parse_agencies(buf: &[u8], rep: &mut ImportReport) -> Result<(Vec<Agency>, FxHashMap<Vec<u8>, u32>)> {
    let mut t = Table::new("agency.txt", buf, b',')?;
    let c_id = t.opt("agency_id");
    let c_name = t.col("agency_name")?;
    let mut out = Vec::new();
    let mut ids = FxHashMap::default();
    while t.next() {
        rep.agencies += 1;
        let id = t.get_opt(c_id);
        if ids.contains_key(id) {
            continue;
        }
        ids.insert(id.to_vec(), out.len() as u32);
        out.push(Agency { gtfs_id: t.text_opt(c_id), name: t.text(c_name) });
    }
    Ok((out, ids))
}

fn parse_routes(
    buf: &[u8],
    agencies: &mut Vec<Agency>,
    agency_ids: &mut FxHashMap<Vec<u8>, u32>,
    rep: &mut ImportReport,
) -> Result<(Vec<Line>, FxHashMap<Vec<u8>, u32>)> {
    let mut t = Table::new("routes.txt", buf, b',')?;
    let c_id = t.col("route_id")?;
    let c_type = t.col("route_type")?;
    let c_agency = t.opt("agency_id");
    let c_short = t.opt("route_short_name");
    let c_long = t.opt("route_long_name");
    let c_desc = t.opt("route_desc");
    let mut lines = Vec::new();
    let mut ids = FxHashMap::default();
    while t.next() {
        rep.routes += 1;
        let id = t.get(c_id);
        if id.is_empty() || ids.contains_key(id) {
            continue;
        }
        let agency_raw = t.get_opt(c_agency);
        let agency = match agency_ids.get(agency_raw) {
            Some(&a) => a,
            // A feed with one agency may leave agency_id empty.
            None if agency_raw.is_empty() && agencies.len() == 1 => 0,
            None => {
                rep.routes_unknown_agency += 1;
                agency_ids.insert(agency_raw.to_vec(), agencies.len() as u32);
                agencies.push(Agency { gtfs_id: t.text_opt(c_agency), name: String::new() });
                agencies.len() as u32 - 1
            }
        };
        let route_type = csv::parse_u32(t.get(c_type)).unwrap_or(u32::MAX).min(u16::MAX as u32) as u16;
        let mut name = t.text_opt(c_short);
        if name.is_empty() {
            name = t.text_opt(c_long);
        }
        ids.insert(id.to_vec(), lines.len() as u32);
        lines.push(Line { gtfs_route_id: t.text(c_id), name, category: t.text_opt(c_desc), mode: mode_of(route_type), route_type, agency });
    }
    Ok((lines, ids))
}

struct StopRow {
    id: String,
    name: String,
    pos: LatLon,
    is_parent: bool,
    /// Row of the parent station, `NONE` if the stop has none.
    parent: u32,
    code: String,
    orig: String,
    didok: u32,
}

fn parse_stops<'a>(buf: &'a [u8], rep: &mut ImportReport) -> Result<(Vec<StopRow>, FxHashMap<&'a [u8], u32>)> {
    let mut t = Table::new("stops.txt", buf, b',')?;
    let c_id = t.col("stop_id")?;
    let c_name = t.col("stop_name")?;
    let c_lat = t.col("stop_lat")?;
    let c_lon = t.col("stop_lon")?;
    let c_loc = t.opt("location_type");
    let c_parent = t.opt("parent_station");
    let c_code = t.opt("platform_code");
    let c_orig = t.opt("original_stop_id");
    let c_didok = t.opt("didok");
    let mut rows = Vec::new();
    let mut parents: Vec<&[u8]> = Vec::new();
    let mut map: FxHashMap<&[u8], u32> = FxHashMap::default();
    while t.next() {
        rep.stop_rows += 1;
        let id = t.get(c_id);
        if id.is_empty() {
            continue;
        }
        if map.contains_key(id) {
            rep.stops_duplicate_id += 1;
            continue;
        }
        let pos = match (csv::parse_f64(t.get(c_lat)), csv::parse_f64(t.get(c_lon))) {
            (Some(lat), Some(lon)) if (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon) => LatLon::from_deg(lat, lon),
            _ => {
                rep.stops_bad_coordinate += 1;
                LatLon::NONE
            }
        };
        let is_parent = t.get_opt(c_loc) == b"1";
        rep.stop_rows_parents += is_parent as u64;
        map.insert(id, rows.len() as u32);
        parents.push(t.get_opt(c_parent));
        rows.push(StopRow {
            id: t.text(c_id),
            name: t.text(c_name),
            pos,
            is_parent,
            parent: NONE,
            code: t.text_opt(c_code).trim().to_string(),
            orig: t.text_opt(c_orig).trim().to_string(),
            didok: csv::parse_u32(t.get_opt(c_didok)).unwrap_or(0),
        });
    }
    for (i, p) in parents.iter().enumerate() {
        if p.is_empty() {
            continue;
        }
        match map.get(p) {
            Some(&r) if r as usize != i => rows[i].parent = r,
            Some(_) => {}
            None => rep.stops_missing_parent += 1,
        }
    }
    Ok((rows, map))
}

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

fn days_from_civil(y: i32, m: u32, d: u32) -> i32 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i32 - 719_468
}

/// `YYYYMMDD` → days since 1970-01-01.
#[inline]
fn parse_ymd(b: &[u8]) -> Option<Date> {
    if b.len() != 8 || !b.iter().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let n = |r: std::ops::Range<usize>| b[r].iter().fold(0u32, |a, c| a * 10 + (c - b'0') as u32);
    let (y, m, d) = (n(0..4), n(4..6), n(6..8));
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y as i32, m, d))
}

struct Calendar {
    start: Date,
    n_days: u32,
    words: usize,
    ids: FxHashMap<Vec<u8>, u32>,
    bits: Vec<u64>,
}

impl Calendar {
    fn new(start: Date, end: Date) -> Result<Calendar> {
        let n = end as i64 - start as i64 + 1;
        if n <= 0 || n > MAX_FEED_DAYS {
            bail!("feed validity {}..{} is not a usable date range", time::fmt_date(start), time::fmt_date(end));
        }
        Ok(Calendar { start, n_days: n as u32, words: (n as usize).div_ceil(64), ids: FxHashMap::default(), bits: Vec::new() })
    }
    fn n_services(&self) -> usize {
        self.ids.len()
    }
    fn service(&mut self, id: &[u8]) -> u32 {
        if let Some(&s) = self.ids.get(id) {
            return s;
        }
        let s = self.ids.len() as u32;
        self.ids.insert(id.to_vec(), s);
        self.bits.resize(self.bits.len() + self.words, 0);
        s
    }
    #[inline]
    fn set(&mut self, svc: u32, day: u32, on: bool) {
        let w = &mut self.bits[svc as usize * self.words + (day as usize >> 6)];
        if on {
            *w |= 1 << (day & 63);
        } else {
            *w &= !(1 << (day & 63));
        }
    }
    fn days(&self, svc: u32) -> u32 {
        self.bits[svc as usize * self.words..(svc as usize + 1) * self.words].iter().map(|w| w.count_ones()).sum()
    }
}

/// Feed version and validity. Falls back to the span of the calendar files
/// when feed_info.txt is absent or incomplete.
fn feed_range(feed_info: Option<&[u8]>, calendar: Option<&[u8]>, calendar_dates: Option<&[u8]>) -> Result<(String, Date, Date)> {
    let mut version = String::new();
    if let Some(buf) = feed_info {
        let mut t = Table::new("feed_info.txt", buf, b',')?;
        let (c_s, c_e, c_v) = (t.opt("feed_start_date"), t.opt("feed_end_date"), t.opt("feed_version"));
        if t.next() {
            version = t.text_opt(c_v);
            if let (Some(s), Some(e)) = (parse_ymd(t.get_opt(c_s)), parse_ymd(t.get_opt(c_e))) {
                return Ok((version, s, e));
            }
        }
    }
    let (mut lo, mut hi) = (Date::MAX, Date::MIN);
    if let Some(buf) = calendar {
        let mut t = Table::new("calendar.txt", buf, b',')?;
        let (c_s, c_e) = (t.col("start_date")?, t.col("end_date")?);
        while t.next() {
            if let (Some(s), Some(e)) = (parse_ymd(t.get(c_s)), parse_ymd(t.get(c_e))) {
                lo = lo.min(s);
                hi = hi.max(e);
            }
        }
    }
    if let Some(buf) = calendar_dates {
        let mut t = Table::new("calendar_dates.txt", buf, b',')?;
        let c_d = t.col("date")?;
        while t.next() {
            if let Some(d) = parse_ymd(t.get(c_d)) {
                lo = lo.min(d);
                hi = hi.max(d);
            }
        }
    }
    if lo > hi {
        bail!("no feed validity: feed_info.txt has no dates and the calendar files are empty");
    }
    Ok((version, lo, hi))
}

fn parse_calendar(buf: &[u8], cal: &mut Calendar, rep: &mut ImportReport) -> Result<()> {
    let mut t = Table::new("calendar.txt", buf, b',')?;
    let c_id = t.col("service_id")?;
    let mut c_wd = [0usize; 7];
    for (i, n) in ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].iter().enumerate() {
        c_wd[i] = t.col(n)?;
    }
    let (c_s, c_e) = (t.col("start_date")?, t.col("end_date")?);
    let end = cal.start + cal.n_days as Date - 1;
    let wd0 = time::weekday(cal.start);
    while t.next() {
        rep.calendar_rows += 1;
        let id = t.get(c_id);
        let (Some(s), Some(e), false) = (parse_ymd(t.get(c_s)), parse_ymd(t.get(c_e)), id.is_empty()) else {
            rep.calendar_malformed += 1;
            continue;
        };
        let svc = cal.service(id);
        let mut on = [false; 7];
        for i in 0..7 {
            on[i] = t.get(c_wd[i]) == b"1";
        }
        for d in s.max(cal.start)..=e.min(end) {
            let day = (d - cal.start) as u32;
            if on[((wd0 + day) % 7) as usize] {
                cal.set(svc, day, true);
            }
        }
    }
    Ok(())
}

fn parse_calendar_dates(buf: &[u8], cal: &mut Calendar, rep: &mut ImportReport) -> Result<()> {
    let h = Header::parse("calendar_dates.txt", buf, b',')?;
    let (c_id, c_date, c_type) = (h.col("service_id")?, h.col("date")?, h.col("exception_type")?);
    let need = c_id.max(c_date).max(c_type);
    let (start, n_days) = (cal.start, cal.n_days);
    let ids = &cal.ids;
    struct Part<'a> {
        known: Vec<(u32, u16, bool)>,
        unknown: Vec<(&'a [u8], u16, bool)>,
        rows: u64,
        malformed: u64,
        out_of_range: u64,
    }
    let body = &buf[h.body..];
    let parts: Vec<Part> = csv::split_lines(body, rayon::current_num_threads() * 4)
        .into_par_iter()
        .map(|chunk| {
            let mut p = Part { known: Vec::with_capacity(chunk.len() / 26), unknown: Vec::new(), rows: 0, malformed: 0, out_of_range: 0 };
            let mut fields: Vec<Field> = Vec::with_capacity(8);
            let mut pos = 0;
            let mut last_id: &[u8] = b"";
            let mut last_svc: Option<u32> = None;
            while pos < chunk.len() {
                pos = csv::next_record(chunk, pos, b',', &mut fields);
                if fields.len() <= need {
                    if !(fields.len() == 1 && fields[0].is_empty()) {
                        p.malformed += 1;
                    }
                    continue;
                }
                p.rows += 1;
                let id = fields[c_id].raw(chunk);
                let on = match fields[c_type].raw(chunk) {
                    b"1" => true,
                    b"2" => false,
                    _ => {
                        p.malformed += 1;
                        continue;
                    }
                };
                let Some(date) = parse_ymd(fields[c_date].raw(chunk)) else {
                    p.malformed += 1;
                    continue;
                };
                if id.is_empty() {
                    p.malformed += 1;
                    continue;
                }
                let day = date as i64 - start as i64;
                if day < 0 || day >= n_days as i64 {
                    p.out_of_range += 1;
                    continue;
                }
                if id != last_id || last_svc.is_none() {
                    last_id = id;
                    last_svc = ids.get(id).copied();
                }
                match last_svc {
                    Some(s) => p.known.push((s, day as u16, on)),
                    None => p.unknown.push((id, day as u16, on)),
                }
            }
            p
        })
        .collect();
    let before = cal.n_services();
    for p in &parts {
        rep.calendar_date_rows += p.rows;
        rep.calendar_dates_malformed += p.malformed;
        rep.calendar_dates_out_of_range += p.out_of_range;
        for &(s, day, on) in &p.known {
            cal.set(s, day as u32, on);
        }
    }
    // Services that only exist as lists of dates.
    for p in &parts {
        for &(id, day, on) in &p.unknown {
            let s = cal.service(id);
            cal.set(s, day as u32, on);
        }
    }
    rep.services_only_in_calendar_dates = (cal.n_services() - before) as u64;
    Ok(())
}

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

/// Byte range of a field inside the trips buffer.
#[derive(Clone, Copy, Default)]
struct Span {
    off: u32,
    /// Length; the top bit marks `""` escapes.
    len: u32,
}

impl Span {
    const ESC: u32 = 1 << 31;
    fn new(f: Field, base: usize) -> Span {
        Span { off: (base + f.start) as u32, len: (f.end - f.start) as u32 | if f.esc { Span::ESC } else { 0 } }
    }
    fn raw<'a>(&self, buf: &'a [u8]) -> &'a [u8] {
        &buf[self.off as usize..self.off as usize + (self.len & !Span::ESC) as usize]
    }
    fn text(&self, buf: &[u8]) -> String {
        csv::unescape(self.raw(buf), self.len & Span::ESC != 0)
    }
}

struct TripRow {
    route: u32,
    service: u32,
    id: Span,
    headsign: Span,
    short: Span,
    sjyid: Span,
}

fn parse_trips(
    buf: &[u8],
    routes: &FxHashMap<Vec<u8>, u32>,
    services: &FxHashMap<Vec<u8>, u32>,
    rep: &mut ImportReport,
) -> Result<Vec<TripRow>> {
    if buf.len() >= (1 << 31) {
        bail!("trips.txt is larger than 2 GiB uncompressed; not supported");
    }
    let h = Header::parse("trips.txt", buf, b',')?;
    let (c_route, c_service, c_id) = (h.col("route_id")?, h.col("service_id")?, h.col("trip_id")?);
    let (c_head, c_short, c_orig) = (h.opt("trip_headsign"), h.opt("trip_short_name"), h.opt("original_trip_id"));
    let need = c_route.max(c_service).max(c_id);
    let body = &buf[h.body..];
    let parts: Vec<(Vec<TripRow>, [u64; 4])> = csv::split_lines(body, rayon::current_num_threads() * 4)
        .into_par_iter()
        .map(|chunk| {
            let base = chunk.as_ptr() as usize - buf.as_ptr() as usize;
            let mut rows = Vec::with_capacity(chunk.len() / 120);
            let mut n = [0u64; 4]; // rows, malformed, unknown route, unknown service
            let mut fields: Vec<Field> = Vec::with_capacity(16);
            let mut pos = 0;
            let (mut last_route, mut last_route_idx): (&[u8], Option<u32>) = (b"", None);
            while pos < chunk.len() {
                pos = csv::next_record(chunk, pos, b',', &mut fields);
                if fields.len() <= need {
                    if !(fields.len() == 1 && fields[0].is_empty()) {
                        n[1] += 1;
                    }
                    continue;
                }
                n[0] += 1;
                if fields[c_id].is_empty() {
                    n[1] += 1;
                    continue;
                }
                let r = fields[c_route].raw(chunk);
                if r != last_route || last_route_idx.is_none() {
                    last_route = r;
                    last_route_idx = routes.get(r).copied();
                }
                let Some(route) = last_route_idx else {
                    n[2] += 1;
                    continue;
                };
                let Some(&service) = services.get(fields[c_service].raw(chunk)) else {
                    n[3] += 1;
                    continue;
                };
                let span = |c: Option<usize>| c.and_then(|c| fields.get(c)).map(|f| Span::new(*f, base)).unwrap_or_default();
                rows.push(TripRow { route, service, id: Span::new(fields[c_id], base), headsign: span(c_head), short: span(c_short), sjyid: span(c_orig) });
            }
            (rows, n)
        })
        .collect();
    let mut out = Vec::with_capacity(parts.iter().map(|p| p.0.len()).sum());
    for (rows, n) in parts {
        rep.trip_rows += n[0];
        rep.trips_malformed += n[1];
        rep.trips_unknown_route += n[2];
        rep.trips_unknown_service += n[3];
        out.extend(rows);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Transfers and frequencies
// ---------------------------------------------------------------------------

#[derive(Default)]
struct RawTransfers {
    /// (from stop row, to stop row, seconds) without route/trip restriction.
    generic: Vec<(u32, u32, u32)>,
    /// Same, for rows restricted to a route or trip pair, plus the trip rows
    /// (NONE when the row names no or an unknown trip).
    specific: Vec<(u32, u32, u32, u32, u32)>,
    /// (from trip row, to trip row, service or NONE, from stop row or NONE, to stop row or NONE)
    continuations: Vec<(u32, u32, u32, u32, u32)>,
    rows: u64,
    type1: u64,
    other_type: u64,
    malformed: u64,
    type2_unknown_stop: u64,
    type4: u64,
    cont_unknown_trip: u64,
    cont_unknown_service: u64,
}

fn parse_transfers(
    buf: &[u8],
    stops: &FxHashMap<&[u8], u32>,
    trips: &FxHashMap<&[u8], u32>,
    services: &FxHashMap<Vec<u8>, u32>,
) -> Result<RawTransfers> {
    let h = Header::parse("transfers.txt", buf, b',')?;
    let (c_from, c_to, c_type) = (h.col("from_stop_id")?, h.col("to_stop_id")?, h.col("transfer_type")?);
    let c_min = h.opt("min_transfer_time");
    let (c_fr, c_tr) = (h.opt("from_route_id"), h.opt("to_route_id"));
    let (c_ft, c_tt) = (h.opt("from_trip_id"), h.opt("to_trip_id"));
    let c_svc = h.opt("service_id");
    let need = c_from.max(c_to).max(c_type);
    let parts: Vec<RawTransfers> = csv::split_lines(&buf[h.body..], rayon::current_num_threads() * 4)
        .into_par_iter()
        .map(|chunk| {
            let mut p = RawTransfers::default();
            let mut fields: Vec<Field> = Vec::with_capacity(16);
            let mut pos = 0;
            while pos < chunk.len() {
                pos = csv::next_record(chunk, pos, b',', &mut fields);
                if fields.len() <= need {
                    if !(fields.len() == 1 && fields[0].is_empty()) {
                        p.malformed += 1;
                    }
                    continue;
                }
                p.rows += 1;
                let get = |c: Option<usize>| -> &[u8] { c.and_then(|c| fields.get(c)).map(|f| f.raw(chunk)).unwrap_or(b"") };
                match fields[c_type].raw(chunk) {
                    b"2" => {
                        let Some(secs) = csv::parse_u32(get(c_min)) else {
                            p.malformed += 1;
                            continue;
                        };
                        let (Some(&a), Some(&b)) = (stops.get(fields[c_from].raw(chunk)), stops.get(fields[c_to].raw(chunk))) else {
                            p.type2_unknown_stop += 1;
                            continue;
                        };
                        let restricted = !(get(c_fr).is_empty() && get(c_tr).is_empty() && get(c_ft).is_empty() && get(c_tt).is_empty());
                        if restricted {
                            let trip = |c: Option<usize>| trips.get(get(c)).copied().unwrap_or(NONE);
                            p.specific.push((a, b, secs, trip(c_ft), trip(c_tt)));
                        } else {
                            p.generic.push((a, b, secs));
                        }
                    }
                    b"4" => {
                        p.type4 += 1;
                        let (Some(&a), Some(&b)) = (trips.get(get(c_ft)), trips.get(get(c_tt))) else {
                            p.cont_unknown_trip += 1;
                            continue;
                        };
                        let svc = get(c_svc);
                        let svc = if svc.is_empty() {
                            NONE
                        } else {
                            match services.get(svc) {
                                Some(&s) => s,
                                None => {
                                    p.cont_unknown_service += 1;
                                    continue;
                                }
                            }
                        };
                        let stop = |c: usize| stops.get(fields[c].raw(chunk)).copied().unwrap_or(NONE);
                        p.continuations.push((a, b, svc, stop(c_from), stop(c_to)));
                    }
                    b"1" => p.type1 += 1,
                    _ => p.other_type += 1,
                }
            }
            p
        })
        .collect();
    let mut out = RawTransfers::default();
    for mut p in parts {
        out.generic.append(&mut p.generic);
        out.specific.append(&mut p.specific);
        out.continuations.append(&mut p.continuations);
        out.rows += p.rows;
        out.type1 += p.type1;
        out.other_type += p.other_type;
        out.malformed += p.malformed;
        out.type2_unknown_stop += p.type2_unknown_stop;
        out.type4 += p.type4;
        out.cont_unknown_trip += p.cont_unknown_trip;
        out.cont_unknown_service += p.cont_unknown_service;
    }
    Ok(out)
}

/// (start, end, headway) windows per template trip row.
fn parse_frequencies(buf: &[u8], trips: &FxHashMap<&[u8], u32>, rep: &mut ImportReport) -> Result<FxHashMap<u32, Vec<(i32, i32, u32)>>> {
    let mut t = Table::new("frequencies.txt", buf, b',')?;
    let (c_trip, c_start, c_end, c_head) = (t.col("trip_id")?, t.col("start_time")?, t.col("end_time")?, t.col("headway_secs")?);
    let mut out: FxHashMap<u32, Vec<(i32, i32, u32)>> = FxHashMap::default();
    while t.next() {
        rep.frequency_rows += 1;
        let Some(&trip) = trips.get(t.get(c_trip)) else {
            rep.frequency_unknown_trip += 1;
            continue;
        };
        match (csv::parse_time(t.get(c_start)), csv::parse_time(t.get(c_end)), csv::parse_u32(t.get(c_head))) {
            (Some(s), Some(e), Some(h)) if h > 0 && e >= s => out.entry(trip).or_default().push((s, e, h)),
            _ => rep.frequency_malformed += 1,
        }
    }
    Ok(out)
}

/// Departures of one frequency window. The national feed gives the last
/// departure as `end_time` (windows such as 11:46–13:14 followed by 13:15–…,
/// every window a whole number of headways), so the end is inclusive. When
/// the coarser materialisation grid misses that last real departure, it is added.
fn frequency_departures(start: i32, end: i32, headway: u32, min_headway: u32) -> Option<Vec<i32>> {
    let step = headway.max(min_headway).max(1) as i64;
    let span = end as i64 - start as i64;
    if span / step > MAX_FREQ_TRIPS_PER_ROW {
        return None;
    }
    let mut out: Vec<i32> = (0..=span / step).map(|k| (start as i64 + k * step) as i32).collect();
    if span % step != 0 && span % headway as i64 == 0 {
        out.push(end);
    }
    Some(out)
}

fn fmt_hms(secs: i32) -> String {
    format!("{:02}:{:02}:{:02}", secs / 3600, secs / 60 % 60, secs % 60)
}

// ---------------------------------------------------------------------------
// Stops and stations
// ---------------------------------------------------------------------------

/// `ch:1:sloid:<stop>:<area>:<edge>` – the id names an edge, not just the stop.
fn sloid_is_edge(sloid: &str) -> bool {
    sloid.strip_prefix("ch:1:sloid:").is_some_and(|rest| rest.bytes().filter(|&c| c == b':').count() >= 2)
}

fn build_stops(rows: &[StopRow], used: &[bool], atlas: &Atlas, rep: &mut ImportReport) -> (Vec<Station>, Vec<Stop>, Vec<u32>) {
    let key = |r: usize| if rows[r].parent != NONE { rows[r].parent as usize } else { r };
    let mut order: Vec<(usize, usize)> = (0..rows.len()).filter(|&r| used[r]).map(|r| (key(r), r)).collect();
    order.sort_unstable();
    let mut stations: Vec<Station> = Vec::new();
    let mut stops: Vec<Stop> = Vec::with_capacity(order.len());
    let mut stop_of_row = vec![NONE; rows.len()];
    let mut last_key = usize::MAX;
    for &(k, r) in &order {
        if k != last_key {
            last_key = k;
            let p = &rows[k];
            let pos = if p.pos.is_none() { rows[r].pos } else { p.pos };
            stations.push(Station { gtfs_id: p.id.clone(), name: p.name.clone(), pos, didok: p.didok, stops: Vec::new(), weight: 0, modes: 0 });
        }
        let station = stations.len() as u32 - 1;
        let st_pos = stations[station as usize].pos;
        let row = &rows[r];
        let gtfs_pos = if row.pos.is_none() { st_pos } else { row.pos };
        let point = if row.orig.is_empty() { None } else { atlas.points.get(row.orig.as_str()) };

        // Label: the sign text. platform_code first, the registry designation
        // otherwise; never anything derived from ids or operational codes.
        let designation = point.map(|p| p.designation.as_str()).filter(|d| !d.is_empty());
        let (mut label, mut sectors) = (String::new(), String::new());
        if row.code.is_empty() {
            if let Some(d) = designation {
                label = d.to_string();
                rep.stops_label_atlas += 1;
            }
        } else {
            rep.stops_label_gtfs += 1;
            match atlas::split_track_sectors(&row.code) {
                // A registry edge that is itself called "2A" is not track 2, sector A.
                Some((track, sect)) if designation != Some(row.code.as_str()) => {
                    label = track.to_string();
                    sectors = sect.to_string();
                }
                _ => label = row.code.clone(),
            }
        }

        let is_edge = !row.is_parent && (point.is_some() || sloid_is_edge(&row.orig) || !row.code.is_empty());
        let (pos, precision) = if !is_edge {
            rep.stops_precision_station += 1;
            rep.stops_pos_gtfs += 1;
            (gtfs_pos, Precision::Station)
        } else {
            if point.is_none() && sloid_is_edge(&row.orig) {
                rep.stops_edge_not_in_atlas += 1;
            }
            let sector_pos = if sectors.is_empty() { None } else { atlas.sector_centroid(&row.orig, &sectors) };
            if !sectors.is_empty() {
                rep.stops_with_sectors += 1;
                rep.stops_sectors_without_points += sector_pos.is_none() as u64;
            }
            let pos = if let Some((p, sibling)) = sector_pos {
                rep.stops_pos_sectors += 1;
                rep.stops_pos_sectors_sibling += sibling as u64;
                p
            } else if let Some(p) = point.and_then(|p| p.pos) {
                rep.stops_pos_atlas += 1;
                let moved = p.dist_m(&gtfs_pos);
                rep.stops_atlas_vs_gtfs_over_5m += (moved > 5.0) as u64;
                rep.stops_atlas_vs_gtfs_over_50m += (moved > 50.0) as u64;
                p
            } else {
                rep.stops_pos_gtfs += 1;
                gtfs_pos
            };
            if !st_pos.is_none() && pos.dist_m(&st_pos) > 1.0 {
                rep.stops_precision_edge += 1;
                (pos, Precision::Edge)
            } else {
                rep.stops_precision_edge_at_station += 1;
                (pos, Precision::EdgeAtStation)
            }
        };
        let idx = stops.len() as u32;
        stop_of_row[r] = idx;
        stations[station as usize].stops.push(idx);
        stops.push(Stop {
            gtfs_id: row.id.clone(),
            sloid: row.orig.clone(),
            station,
            pos,
            label,
            sectors,
            precision,
            compass: point.map(|p| p.compass).unwrap_or(-1),
            access: atlas.access.get(row.orig.as_str()).copied().unwrap_or(QuayAccess::Unknown),
            modes: 0,
        });
    }
    // Parent rows (and parentless stops) no trip ever calls at.
    let mut has_stop = vec![false; rows.len()];
    for &(k, _) in &order {
        has_stop[k] = true;
    }
    rep.stations_without_stops = (0..rows.len()).filter(|&r| rows[r].parent == NONE && !has_stop[r]).count() as u64;
    (stations, stops, stop_of_row)
}

// ---------------------------------------------------------------------------
// String pool
// ---------------------------------------------------------------------------

struct Pool<'a> {
    strings: Vec<String>,
    map: FxHashMap<&'a [u8], u32>,
    buf: &'a [u8],
}

impl<'a> Pool<'a> {
    fn intern(&mut self, sp: Span) -> StrIdx {
        let raw = sp.raw(self.buf);
        if raw.is_empty() {
            return 0;
        }
        if let Some(&i) = self.map.get(raw) {
            return i;
        }
        let i = self.strings.len() as u32;
        self.strings.push(sp.text(self.buf));
        self.map.insert(raw, i);
        i
    }
    fn push(&mut self, s: String) -> StrIdx {
        self.strings.push(s);
        self.strings.len() as u32 - 1
    }
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

pub(crate) fn run(opts: &ImportOptions) -> Result<(Timetable, ImportReport)> {
    let t_all = Instant::now();
    let mut rep = ImportReport::default();
    let zip = opts.gtfs_zip.as_path();
    let mut ar = zipio::open(zip)?;
    for m in ["agency.txt", "routes.txt", "trips.txt", "stops.txt", "stop_times.txt"] {
        if !zipio::has(&ar, m) {
            bail!("{}: GTFS archive has no member {m}", zip.display());
        }
    }
    if !zipio::has(&ar, "calendar.txt") && !zipio::has(&ar, "calendar_dates.txt") {
        bail!("{}: GTFS archive has neither calendar.txt nor calendar_dates.txt", zip.display());
    }
    let n_workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).saturating_sub(2).clamp(1, 48);
    let min_headway = opts.min_headway_s;
    let atlas_dir = opts.atlas_dir.as_deref();

    let tt = std::thread::scope(|s| -> Result<Timetable> {
        let rep = &mut rep;
        let mut ph = Phases { last: Instant::now() };

        // Inflating stop_times is the one thing that cannot be parallelised,
        // so it starts first and runs ahead into a bounded queue while the
        // tables its parsers need are being built.
        let (tx, rx) = sync_channel(stop_times::CHANNEL_CAP);
        let (cols_tx, cols_rx) = channel();
        let h_st = s.spawn(move || stop_times::inflate(zip, tx, cols_tx));
        let h_trips = s.spawn(move || zipio::read_path(zip, "trips.txt"));
        let h_cd = s.spawn(move || zipio::read_path_opt(zip, "calendar_dates.txt"));
        let h_tf = s.spawn(move || zipio::read_path_opt(zip, "transfers.txt"));
        let h_atlas = s.spawn(move || atlas::load(atlas_dir));

        let agency_buf = zipio::read(&mut ar, "agency.txt")?;
        let routes_buf = zipio::read(&mut ar, "routes.txt")?;
        let stops_buf = zipio::read(&mut ar, "stops.txt")?;
        let calendar_buf = zipio::read_opt(&mut ar, "calendar.txt")?;
        let freq_buf = zipio::read_opt(&mut ar, "frequencies.txt")?;
        let feed_buf = zipio::read_opt(&mut ar, "feed_info.txt")?;

        let (mut agencies, mut agency_ids) = parse_agencies(&agency_buf, rep)?;
        let (lines, route_ids) = parse_routes(&routes_buf, &mut agencies, &mut agency_ids, rep)?;
        let (stop_rows, stop_map) = parse_stops(&stops_buf, rep)?;
        ph.mark(rep, "agency, routes, stops");

        let cd_buf = join(h_cd, "calendar_dates.txt")?;
        let (feed_version, feed_start, feed_end) = feed_range(feed_buf.as_deref(), calendar_buf.as_deref(), cd_buf.as_deref())?;
        let mut cal = Calendar::new(feed_start, feed_end)?;
        if let Some(buf) = &calendar_buf {
            parse_calendar(buf, &mut cal, rep)?;
        }
        if let Some(buf) = &cd_buf {
            parse_calendar_dates(buf, &mut cal, rep)?;
        }
        drop(cd_buf);
        let service_days: Vec<u32> = (0..cal.n_services() as u32).map(|s| cal.days(s)).collect();
        ph.mark(rep, "calendar, calendar_dates");

        let trips_buf = join(h_trips, "trips.txt")?;
        let trip_rows = parse_trips(&trips_buf, &route_ids, &cal.ids, rep)?;
        let n_trips = trip_rows.len();
        let mut trip_map: FxHashMap<&[u8], u32> = FxHashMap::default();
        trip_map.reserve(n_trips);
        rep.trip_rows_per_service = vec![0; cal.n_services()];
        for (i, t) in trip_rows.iter().enumerate() {
            rep.trip_rows_per_service[t.service as usize] += 1;
            match trip_map.entry(t.id.raw(&trips_buf)) {
                std::collections::hash_map::Entry::Occupied(_) => rep.trips_duplicate_id += 1,
                std::collections::hash_map::Entry::Vacant(e) => {
                    e.insert(i as u32);
                }
            }
        }
        let trip_line: Vec<u32> = trip_rows.iter().map(|t| t.route).collect();
        ph.mark(rep, "trips");

        // ---- stop_times ----------------------------------------------------
        let cols = match cols_rx.recv() {
            Ok(c) => c,
            Err(_) => {
                // The inflater stopped before it got to the header: report why.
                drop(rx);
                join(h_st, "stop_times.txt")?;
                bail!("stop_times.txt: no header");
            }
        };
        let rx = Mutex::new(rx);
        let (st_parts, raw_tf, freq) = std::thread::scope(|s2| -> Result<_> {
            let workers: Vec<_> =
                (0..n_workers).map(|_| s2.spawn(|| stop_times::worker(&rx, &cols, &trip_map, &stop_map))).collect();
            // Meanwhile, on this thread: the other files that need the trip table.
            let tf_buf = join(h_tf, "transfers.txt")?;
            let raw_tf = match &tf_buf {
                Some(buf) => parse_transfers(buf, &stop_map, &trip_map, &cal.ids)?,
                None => RawTransfers::default(),
            };
            let freq = match &freq_buf {
                Some(buf) => parse_frequencies(buf, &trip_map, rep)?,
                None => FxHashMap::default(),
            };
            let mut parts = Vec::new();
            let mut stats = StStats::default();
            for w in workers {
                let (p, st) = w.join().map_err(|_| anyhow!("stop_times.txt: parser thread panicked"))?;
                parts.extend(p);
                stats.add(&st);
            }
            Ok(((parts, stats), raw_tf, freq))
        })?;
        drop(rx);
        rep.stop_times_bytes = join(h_st, "stop_times.txt")?;
        let (mut parts, st_stats) = st_parts;
        rep.stop_time_rows = st_stats.rows;
        rep.stop_times_malformed = st_stats.malformed;
        rep.stop_times_unknown_trip = st_stats.unknown_trip;
        rep.stop_times_unknown_stop = st_stats.unknown_stop;
        parts.sort_unstable_by_key(|p| p.0);
        let total_rows: usize = parts.iter().map(|p| p.1.len()).sum();
        if total_rows >= u32::MAX as usize {
            bail!("stop_times.txt has {total_rows} usable rows; more than 4 billion are not supported");
        }
        let mut rows: Vec<StRow> = Vec::with_capacity(total_rows);
        for (_, p) in parts {
            rows.extend_from_slice(&p);
        }
        ph.mark(rep, "stop_times (inflate + parse), transfers");

        let grouped = patterns::group_rows(&mut rows, n_trips);
        rep.stop_times_resorted = grouped.resorted;
        rep.stop_times_duplicate_seq = grouped.duplicate_seq;
        let (first, mut len) = (grouped.first, grouped.len);
        let norm = patterns::normalise(&mut rows, &first, &mut len);
        rep.times_interpolated = norm.interpolated;
        rep.times_clamped = norm.clamped;
        rep.trips_no_times = norm.trips_no_times;
        let mut used = vec![false; stop_rows.len()];
        for r in &rows {
            used[r.stop as usize] = true;
        }
        ph.mark(rep, "index + repair stop_times");

        // ---- trip instances (frequency templates expanded) -----------------
        let mut insts: Vec<Inst> = Vec::with_capacity(n_trips);
        for t in 0..n_trips {
            match len[t] {
                0 if first[t] == NONE => {
                    rep.trips_without_stop_times += 1;
                    continue;
                }
                0 => continue, // dropped by normalise (counted there)
                1 => {
                    rep.trips_single_stop += 1;
                    continue;
                }
                n if n > u16::MAX as u32 => {
                    rep.trips_too_long += 1;
                    continue;
                }
                _ => {}
            }
            match freq.get(&(t as u32)) {
                None => insts.push(Inst { src: t as u32, shift: 0, headway: 0, freq: false }),
                Some(windows) => {
                    rep.frequency_templates += 1;
                    let first_dep = rows[first[t] as usize].dep;
                    for &(start, end, headway) in windows {
                        let Some(deps) = frequency_departures(start, end, headway, min_headway) else {
                            rep.frequency_malformed += 1;
                            continue;
                        };
                        for d in deps {
                            rep.frequency_trips_materialised += 1;
                            insts.push(Inst { src: t as u32, shift: d - first_dep, headway: headway.min(u16::MAX as u32) as u16, freq: true });
                        }
                    }
                }
            }
        }

        // ---- patterns --------------------------------------------------------
        let table = TripTable { rows: &rows, first: &first, len: &len, line: &trip_line };
        let (chains, n_keys) = patterns::build_patterns(&table, insts);
        rep.pattern_keys = n_keys as u64;
        ph.mark(rep, "patterns (group, sort, split)");

        let atlas = join(h_atlas, "atlas")?;
        rep.atlas_boarding_points = atlas.points.len() as u64;
        rep.atlas_missing_files = atlas.missing.clone();
        let (mut stations, mut stops, stop_of_row) = build_stops(&stop_rows, &used, &atlas, rep);
        drop(atlas);

        let n_out: usize = chains.iter().map(|c| c.len()).sum();
        let n_times: usize = chains.iter().map(|c| 2 * c.len() * table.len[c[0].src as usize] as usize).sum();
        let n_pstops: usize = chains.iter().map(|c| table.len[c[0].src as usize] as usize).sum();
        if n_out >= u32::MAX as usize || n_pstops >= u32::MAX as usize {
            bail!("timetable too large: {n_out} trips, {n_pstops} pattern stops");
        }
        let mut pats: Vec<Pattern> = Vec::with_capacity(chains.len());
        let mut pattern_stops: Vec<StopIdx> = Vec::with_capacity(n_pstops);
        let mut pattern_flags: Vec<u8> = Vec::with_capacity(n_pstops);
        let mut times: Vec<i32> = Vec::with_capacity(n_times);
        let mut out_insts: Vec<Inst> = Vec::with_capacity(n_out);
        let mut final_of_src = vec![NONE; n_trips];
        for c in &chains {
            let src_rows = table.rows_of(c[0].src);
            pats.push(Pattern {
                line: trip_line[c[0].src as usize],
                stops_off: pattern_stops.len() as u32,
                n_stops: src_rows.len() as u16,
                trips_off: out_insts.len() as u32,
                n_trips: c.len() as u32,
                times_off: times.len() as u64,
            });
            for r in src_rows {
                pattern_stops.push(stop_of_row[r.stop as usize]);
                pattern_flags.push(r.flags());
            }
            for inst in c {
                if !inst.freq {
                    final_of_src[inst.src as usize] = out_insts.len() as u32;
                }
                out_insts.push(*inst);
                for r in table.rows_of(inst.src) {
                    times.push(r.arr + inst.shift);
                    times.push(r.dep + inst.shift);
                }
            }
        }
        drop(chains);
        drop(rows);
        ph.mark(rep, "stops, pattern arrays, times");

        // ---- trips and their strings ---------------------------------------
        let mut pool = Pool { strings: Vec::with_capacity(2 * n_out + 16), map: FxHashMap::default(), buf: &trips_buf };
        pool.strings.push(String::new());
        let mut trips: Vec<Trip> = Vec::with_capacity(n_out);
        for (p, pat) in pats.iter().enumerate() {
            for inst in &out_insts[pat.trips_off as usize..(pat.trips_off + pat.n_trips) as usize] {
                let tr = &trip_rows[inst.src as usize];
                let gtfs_id = if inst.freq {
                    // One id per materialised departure, so that an instance
                    // can be addressed in the API.
                    let dep = times[pat.times_off as usize + (trips.len() - pat.trips_off as usize) * 2 * pat.n_stops as usize + 1];
                    pool.push(format!("{}@{}", tr.id.text(&trips_buf), fmt_hms(dep)))
                } else {
                    pool.push(tr.id.text(&trips_buf))
                };
                trips.push(Trip {
                    pattern: p as u32,
                    service: tr.service,
                    headsign: pool.intern(tr.headsign),
                    short_name: pool.intern(tr.short),
                    gtfs_id,
                    sjyid: pool.intern(tr.sjyid),
                    flags: if inst.freq { TRIP_FREQUENCY } else { 0 },
                    headway_s: inst.headway,
                });
            }
        }
        let strings = pool.strings;
        ph.mark(rep, "trips + string pool");

        // ---- transfers -----------------------------------------------------
        rep.transfer_rows = raw_tf.rows;
        rep.transfers_type1 = raw_tf.type1;
        rep.transfers_other_type = raw_tf.other_type;
        rep.transfers_malformed = raw_tf.malformed;
        rep.transfers_type2_unknown_stop = raw_tf.type2_unknown_stop;
        rep.transfers_type2_generic = raw_tf.generic.len() as u64;
        rep.transfers_type2_trip_specific = raw_tf.specific.len() as u64;
        rep.transfers_type4 = raw_tf.type4;
        rep.continuations_unknown_service = raw_tf.cont_unknown_service;
        rep.continuations_unknown_trip = raw_tf.cont_unknown_trip;

        let mut official: Vec<OfficialTransfer> = Vec::with_capacity(raw_tf.generic.len());
        for &(a, b, secs) in &raw_tf.generic {
            let (a, b) = (stop_of_row[a as usize], stop_of_row[b as usize]);
            if a == NONE || b == NONE {
                rep.transfers_type2_not_a_stop += 1;
                continue;
            }
            official.push(OfficialTransfer { from: a, to: b, secs: secs.min(u16::MAX as u32) as u16 });
        }
        official.par_sort_unstable_by_key(|o| (o.from, o.to, o.secs));
        let before = official.len();
        official.dedup_by_key(|o| (o.from, o.to));
        rep.transfers_type2_duplicates = (before - official.len()) as u64;
        let trip_times = |t: TripIdx| -> &[i32] {
            let pat = &pats[trips[t as usize].pattern as usize];
            let n = 2 * pat.n_stops as usize;
            let off = pat.times_off as usize + (t - pat.trips_off) as usize * n;
            &times[off..off + n]
        };
        let trip_stops = |t: TripIdx| -> &[StopIdx] {
            let pat = &pats[trips[t as usize].pattern as usize];
            &pattern_stops[pat.stops_off as usize..pat.stops_off as usize + pat.n_stops as usize]
        };
        let describe = |t: TripIdx| -> String {
            let (tm, st) = (trip_times(t), trip_stops(t));
            let name = |s: StopIdx| stations[stops[s as usize].station as usize].name.as_str();
            format!(
                "{} [{} {} -> {} {}]",
                strings[trips[t as usize].gtfs_id as usize],
                fmt_hms(tm[1]),
                name(st[0]),
                fmt_hms(tm[tm.len() - 2]),
                name(st[st.len() - 1])
            )
        };
        // Trip-pair specific minimum times: not representable in the contract
        // today; measure what a consumer would get.
        let mut secs_hist: FxHashMap<u32, u64> = FxHashMap::default();
        for &(a, b, secs, ta, tb) in &raw_tf.specific {
            let (a, b) = (stop_of_row[a as usize], stop_of_row[b as usize]);
            let generic = if a == NONE || b == NONE {
                None
            } else {
                official.binary_search_by(|o| (o.from, o.to).cmp(&(a, b))).ok().map(|i| official[i].secs as u32)
            };
            match generic {
                None => rep.trip_specific_no_generic += 1,
                Some(g) if secs < g => rep.trip_specific_shorter += 1,
                Some(g) if secs == g => rep.trip_specific_equal += 1,
                Some(_) => rep.trip_specific_longer += 1,
            }
            *secs_hist.entry(secs).or_default() += 1;
            let (fa, fb) = (
                if ta == NONE { NONE } else { final_of_src[ta as usize] },
                if tb == NONE { NONE } else { final_of_src[tb as usize] },
            );
            if fa != NONE && fb != NONE && a != NONE && b != NONE && trip_stops(fa).contains(&a) && trip_stops(fb).contains(&b) {
                rep.trip_specific_resolvable += 1;
            }
        }
        if !secs_hist.is_empty() {
            let mut h: Vec<(u32, u64)> = secs_hist.into_iter().collect();
            h.sort_unstable_by_key(|&(s, n)| (std::cmp::Reverse(n), s));
            rep.notes.push(format!(
                "trip-specific type 2 minimum times, most frequent (seconds x rows): {}",
                h.iter().take(8).map(|(s, n)| format!("{s} x {n}")).collect::<Vec<_>>().join(", ")
            ));
        }
        let mut continuations: Vec<Continuation> = Vec::with_capacity(raw_tf.continuations.len());
        let mut notes: Vec<String> = Vec::new();
        let mut examples = [0usize; 3];
        for &(a, b, svc, from_stop, to_stop) in &raw_tf.continuations {
            let (a, b) = (final_of_src[a as usize], final_of_src[b as usize]);
            if a == NONE || b == NONE {
                // A dropped trip or a frequency template.
                rep.continuations_unknown_trip += 1;
                continue;
            }
            // The link must be "last stop of `from`" → "first stop of `to`";
            // that is the only shape `Continuation` can express.
            let (sa, sb) = (trip_stops(a), trip_stops(b));
            let from_ok = from_stop == NONE || stop_of_row[from_stop as usize] == sa[sa.len() - 1];
            let to_ok = to_stop == NONE || stop_of_row[to_stop as usize] == sb[0];
            if !from_ok || !to_ok {
                rep.continuations_not_at_trip_ends += 1;
                if examples[0] < 3 {
                    examples[0] += 1;
                    notes.push(format!(
                        "type 4 not at trip ends (dropped): {} at {} => {} at {}",
                        describe(a),
                        stop_rows.get(from_stop as usize).map(|r| r.id.as_str()).unwrap_or("?"),
                        describe(b),
                        stop_rows.get(to_stop as usize).map(|r| r.id.as_str()).unwrap_or("?")
                    ));
                }
                continue;
            }
            continuations.push(Continuation { from: a, to: b, service: svc });
        }
        continuations.par_sort_unstable_by_key(|c| (c.from, c.to, c.service));
        let before = continuations.len();
        continuations.dedup_by_key(|c| (c.from, c.to, c.service));
        rep.continuations_duplicate = (before - continuations.len()) as u64;
        for c in &continuations {
            let (sa, sb) = (trip_stops(c.from), trip_stops(c.to));
            let (last, head) = (sa[sa.len() - 1], sb[0]);
            if last == head {
                rep.continuations_same_stop += 1;
            } else if stops[last as usize].station == stops[head as usize].station {
                rep.continuations_same_station += 1;
            } else {
                rep.continuations_other_station += 1;
                if examples[1] < 3 {
                    examples[1] += 1;
                    notes.push(format!("continuation between stations: {} => {}", describe(c.from), describe(c.to)));
                }
            }
            let (ta, tb) = (trip_times(c.from), trip_times(c.to));
            let wait = tb[1] - ta[ta.len() - 2];
            if wait < 0 {
                rep.continuations_negative_wait += 1;
                rep.continuations_wait_about_minus_24h += (wait <= -(20 * 3600)) as u64;
                if examples[2] < 4 {
                    examples[2] += 1;
                    notes.push(format!("continuation with negative wait ({} s): {} => {}", wait, describe(c.from), describe(c.to)));
                }
            } else {
                rep.continuations_wait_over_1h += (wait > 3600) as u64;
            }
        }
        rep.notes.append(&mut notes);
        ph.mark(rep, "transfers, continuations");

        // ---- per-stop data ---------------------------------------------------
        let mut stop_weight = vec![0f64; stops.len()];
        let mut counts = vec![0u32; stops.len() + 1];
        for pat in &pats {
            let line = &lines[pat.line as usize];
            let (bit, w) = (line.mode.bit(), mode_weight(line.mode));
            let days: u64 = trips[pat.trips_off as usize..(pat.trips_off + pat.n_trips) as usize]
                .iter()
                .map(|t| service_days[t.service as usize] as u64)
                .sum();
            let n = pat.n_stops as usize;
            for i in 0..n {
                let s = pattern_stops[pat.stops_off as usize + i] as usize;
                stops[s].modes |= bit;
                counts[s + 1] += 1;
                if i + 1 < n && pattern_flags[pat.stops_off as usize + i] & FLAG_NO_PICKUP == 0 {
                    stop_weight[s] += w * days as f64;
                }
            }
        }
        for i in 0..stops.len() {
            counts[i + 1] += counts[i];
        }
        let stop_pattern_off = counts;
        let mut cursor = stop_pattern_off.clone();
        let mut stop_patterns = vec![(0u32, 0u16); pattern_stops.len()];
        for (p, pat) in pats.iter().enumerate() {
            for i in 0..pat.n_stops as usize {
                let s = pattern_stops[pat.stops_off as usize + i] as usize;
                stop_patterns[cursor[s] as usize] = (p as u32, i as u16);
                cursor[s] += 1;
            }
        }
        for st in stations.iter_mut() {
            let mut w = 0f64;
            for &s in &st.stops {
                st.modes |= stops[s as usize].modes;
                w += stop_weight[s as usize];
            }
            // Mode-weighted departures per day, averaged over the feed.
            st.weight = if w > 0.0 { ((w / cal.n_days as f64).round() as u32).max(1) } else { 0 };
        }
        ph.mark(rep, "stop index, modes, weights");

        Ok(Timetable {
            feed_version,
            start_date: cal.start,
            n_days: cal.n_days,
            agencies,
            lines,
            stations,
            stops,
            patterns: pats,
            pattern_stops,
            pattern_flags,
            trips,
            times,
            strings,
            service_words: cal.words as u32,
            service_bits: cal.bits,
            stop_pattern_off,
            stop_patterns,
            continuations,
            official_transfers: official,
        })
    })?;
    rep.total_secs = t_all.elapsed().as_secs_f64();
    Ok((tt, rep))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        for s in ["19700101", "20251214", "20260228", "20261212", "20240229", "21000301", "19991231"] {
            assert_eq!(parse_ymd(s.as_bytes()), time::parse_date(s), "{s}");
        }
        assert_eq!(parse_ymd(b"19700101"), Some(0));
        assert_eq!(parse_ymd(b"20261212").unwrap() - parse_ymd(b"20251214").unwrap(), 363);
        assert_eq!(parse_ymd(b"2026121"), None);
        assert_eq!(parse_ymd(b"20261301"), None);
    }

    #[test]
    fn frequency_windows() {
        // Real headway kept when it is above the minimum; end inclusive.
        assert_eq!(frequency_departures(0, 3600, 1800, 300), Some(vec![0, 1800, 3600]));
        // "Continuous" 60 s service on a 300 s grid, last real departure kept.
        let d = frequency_departures(42360, 47640, 60, 300).unwrap(); // 11:46 – 13:14
        assert_eq!((d[0], d[1], d[d.len() - 2], d[d.len() - 1], d.len()), (42360, 42660, 47460, 47640, 19));
        assert_eq!(frequency_departures(0, 600, 60, 300), Some(vec![0, 300, 600]));
        assert_eq!(frequency_departures(0, 0, 60, 300), Some(vec![0]));
        assert_eq!(frequency_departures(0, 86_400 * 30, 1, 1), None);
    }

    #[test]
    fn modes() {
        assert_eq!(mode_of(109), Mode::Rail);
        assert_eq!(mode_of(116), Mode::RackRail);
        assert_eq!(mode_of(401), Mode::Metro);
        assert_eq!(mode_of(700), Mode::Bus);
        assert_eq!(mode_of(715), Mode::OnDemand);
        assert_eq!(mode_of(900), Mode::Tram);
        assert_eq!(mode_of(1000), Mode::Boat);
        assert_eq!(mode_of(1300), Mode::Cableway);
        assert_eq!(mode_of(1303), Mode::Lift);
        assert_eq!(mode_of(1400), Mode::Funicular);
        assert_eq!(mode_of(1500), Mode::OnDemand);
        assert_eq!(mode_of(202), Mode::Bus);
        assert!(sloid_is_edge("ch:1:sloid:7000:3:5") && sloid_is_edge("ch:1:sloid:73022::3"));
        assert!(!sloid_is_edge("ch:1:sloid:7000") && !sloid_is_edge("8014586") && !sloid_is_edge(""));
    }
}
