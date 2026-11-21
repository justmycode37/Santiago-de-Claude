//! Service days and wall-clock conversion.
//!
//! Timetable times are *service-day seconds*: seconds after "noon minus 12 h"
//! of a service date in Europe/Zurich, and may exceed 86 400 for trips that run
//! past midnight. A [`Date`] is a count of days since 1970-01-01.

use chrono::{Datelike, NaiveDate, TimeZone};
use chrono_tz::Europe::Zurich;

/// Days since 1970-01-01 (local calendar date in Europe/Zurich).
pub type Date = i32;
/// Seconds since the start of a service day; can be negative or > 86400 when
/// expressed relative to a neighbouring day.
pub type Secs = i32;

pub const DAY: Secs = 86_400;

fn epoch() -> NaiveDate {
    NaiveDate::from_ymd_opt(1970, 1, 1).unwrap()
}

pub fn date_from_ymd(y: i32, m: u32, d: u32) -> Option<Date> {
    NaiveDate::from_ymd_opt(y, m, d).map(|n| (n - epoch()).num_days() as Date)
}

/// Parse `YYYYMMDD` (GTFS) or `YYYY-MM-DD`.
pub fn parse_date(s: &str) -> Option<Date> {
    let digits: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() != 8 {
        return None;
    }
    date_from_ymd(digits[0..4].parse().ok()?, digits[4..6].parse().ok()?, digits[6..8].parse().ok()?)
}

pub fn naive(date: Date) -> NaiveDate {
    epoch() + chrono::Duration::days(date as i64)
}

/// `YYYY-MM-DD`
pub fn fmt_date(date: Date) -> String {
    naive(date).format("%Y-%m-%d").to_string()
}

/// 0 = Monday … 6 = Sunday
pub fn weekday(date: Date) -> u32 {
    naive(date).weekday().num_days_from_monday()
}

/// Unix time of second 0 of the service day (noon local time minus 12 h, so
/// that DST-change days still map timetable times correctly after 03:00).
pub fn service_day_start_unix(date: Date) -> i64 {
    let noon = naive(date).and_hms_opt(12, 0, 0).unwrap();
    let local = Zurich.from_local_datetime(&noon).single().expect("noon is never ambiguous");
    local.timestamp() - 12 * 3600
}

/// Unix seconds for a service-day time.
pub fn to_unix(date: Date, secs: Secs) -> i64 {
    service_day_start_unix(date) + secs as i64
}

/// Split a unix timestamp into (local service date, seconds since its start).
pub fn from_unix(unix: i64) -> (Date, Secs) {
    let local = Zurich.timestamp_opt(unix, 0).single().expect("valid timestamp");
    let date = (local.date_naive() - epoch()).num_days() as Date;
    (date, (unix - service_day_start_unix(date)) as Secs)
}

/// Parse `HH:MM:SS` (hours may exceed 23) into seconds.
pub fn parse_hms(s: &str) -> Option<Secs> {
    let b = s.as_bytes();
    let mut parts = [0i32; 3];
    let mut idx = 0;
    let mut any = false;
    for &c in b {
        match c {
            b'0'..=b'9' => {
                parts[idx] = parts[idx] * 10 + (c - b'0') as i32;
                any = true;
            }
            b':' => {
                idx += 1;
                if idx > 2 {
                    return None;
                }
            }
            b' ' => {}
            _ => return None,
        }
    }
    if !any || idx != 2 {
        return None;
    }
    Some(parts[0] * 3600 + parts[1] * 60 + parts[2])
}

/// RFC 3339 with the Zurich offset, e.g. `2026-11-21T14:05:00+01:00`.
pub fn fmt_iso(unix: i64) -> String {
    Zurich.timestamp_opt(unix, 0).single().expect("valid timestamp").to_rfc3339()
}

/// Parse RFC 3339 / ISO 8601 with offset, or a bare local `YYYY-MM-DDTHH:MM[:SS]`
/// interpreted in Europe/Zurich.
pub fn parse_iso(s: &str) -> Option<i64> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp());
    }
    for f in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(n) = chrono::NaiveDateTime::parse_from_str(s, f) {
            return Zurich.from_local_datetime(&n).earliest().map(|d| d.timestamp());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip() {
        let d = parse_date("20261121").unwrap();
        assert_eq!(fmt_date(d), "2026-11-21");
        assert_eq!(weekday(d), 5); // Saturday
        let u = to_unix(d, 25 * 3600 + 15 * 60);
        assert_eq!(fmt_iso(u), "2026-11-22T01:15:00+01:00");
        let (d2, s2) = from_unix(u);
        assert_eq!((d2, s2), (d + 1, 3600 + 15 * 60));
        assert_eq!(parse_hms("25:15:00"), Some(90900));
        assert_eq!(parse_iso("2026-11-22T01:15:00+01:00"), Some(u));
        assert_eq!(parse_iso("2026-11-22T01:15"), Some(u));
    }
}
