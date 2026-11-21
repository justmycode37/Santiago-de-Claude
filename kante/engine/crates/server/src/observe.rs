//! On-board position reports (`POST /api/observe`), opt-in on the phone.
//!
//! A phone on a vehicle may say where it is, so that vehicle's position gets
//! better for everyone. The feeds only report stop times; a report from on
//! board is the only measured position there is between stops. Rules, so that
//! one phone cannot move a vehicle and nobody can be followed:
//!
//! - The handler (`api.rs`) only stores reports that are fresh (≤ 30 s), precise
//!   (≤ 50 m), on the line between the stops the vehicle is between right now,
//!   and at most one per 5 s per address.
//! - A report is reduced to "this far along this hop at this time"; the
//!   position itself is not kept. Reports expire after 3 minutes. The address is
//!   only kept, hashed, for the rate limit, and expires with it.
//! - A correction needs two reports on the same hop that are ≥ 5 s apart and
//!   move forward, and it never moves the vehicle more than [`MAX_SHIFT_S`] of
//!   travel time away from the feed's estimate, nor onto another hop.

use kante_core::time::Date;
use kante_core::TripIdx;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hash, Hasher};

/// How long a report counts, seconds.
pub const KEEP_S: i64 = 180;
/// Largest correction of the feed's estimate, in seconds of travel time.
pub const MAX_SHIFT_S: f32 = 45.0;
/// One report per address per this many seconds.
pub const RATE_S: i64 = 5;

#[derive(Clone, Copy, Debug)]
struct Report {
    t: i64,
    hop: u16,
    frac: f32,
}

#[derive(Default)]
struct Inner {
    /// Reports per (trip, service date) or per extra-journey id.
    by_trip: HashMap<Key, Vec<Report>>,
    last_from: HashMap<u64, i64>,
    gc_at: i64,
    hasher: std::collections::hash_map::RandomState,
}

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub enum Key {
    Trip(Date, TripIdx),
    Extra(String),
}

#[derive(Default)]
pub struct Store {
    inner: Mutex<Inner>,
}

/// Why a report was not taken.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    TooFrequent,
}

impl Store {
    /// Take a report that the handler has already checked against the trip:
    /// at `t` the phone was `frac` (0…1) along the hop that starts at `hop`.
    pub fn add(&self, key: Key, addr: &str, now: i64, t: i64, hop: u16, frac: f32) -> Result<(), Refused> {
        let mut g = self.inner.lock();
        let inner = &mut *g;
        if now - inner.gc_at > 30 {
            inner.by_trip.retain(|_, v| {
                v.retain(|r| now - r.t <= KEEP_S);
                !v.is_empty()
            });
            inner.last_from.retain(|_, &mut at| now - at < RATE_S);
            inner.gc_at = now;
        }
        let mut h = inner.hasher.build_hasher();
        addr.hash(&mut h);
        let who = h.finish();
        if inner.last_from.get(&who).is_some_and(|&at| now - at < RATE_S) {
            return Err(Refused::TooFrequent);
        }
        inner.last_from.insert(who, now);
        let v = inner.by_trip.entry(key).or_default();
        v.push(Report { t, hop, frac: frac.clamp(0.0, 1.0) });
        if v.len() > 32 {
            v.remove(0);
        }
        Ok(())
    }

    /// The fraction of hop `hop` (from `dep` to `arr`, unix seconds) the vehicle
    /// has covered at `now` according to the reports, when they qualify (see
    /// the module docs), bounded to [`MAX_SHIFT_S`] around `est` (the feed's
    /// fraction). `None` when they do not.
    pub fn correct(&self, key: &Key, hop: u16, dep: i64, arr: i64, now: i64, est: f32) -> Option<f32> {
        let g = self.inner.lock();
        let v = g.by_trip.get(key)?;
        let mut rs: Vec<Report> = v.iter().copied().filter(|r| r.hop == hop && now - r.t <= KEEP_S && r.t <= now).collect();
        if rs.len() < 2 {
            return None;
        }
        rs.sort_by_key(|r| r.t);
        let (a, b) = (rs[rs.len() - 2], rs[rs.len() - 1]);
        if b.t - a.t < RATE_S || b.frac + 0.01 < a.frac {
            return None;
        }
        let span = (arr - dep).max(1) as f32;
        // From the newest report on, at the hop's own pace.
        let reported = b.frac + (now - b.t) as f32 / span;
        let max = MAX_SHIFT_S / span;
        Some(reported.clamp(est - max, est + max).clamp(0.0, 1.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn needs_two_forward_reports_and_stays_bounded() {
        let s = Store::default();
        let k = Key::Trip(100, 7);
        // Hop of 120 s; the feed thinks the vehicle is 50 % along.
        assert!(s.add(k.clone(), "a", 1000, 1000, 3, 0.2).is_ok());
        assert_eq!(s.correct(&k, 3, 900, 1020, 1000, 0.5), None, "one report is not enough");
        assert_eq!(s.add(k.clone(), "a", 1002, 1002, 3, 0.3), Err(Refused::TooFrequent));
        assert!(s.add(k.clone(), "a", 1006, 1006, 3, 0.25).is_ok());
        // 0.25 + 4/120 ≈ 0.283, within 45 s (0.375) of 0.5.
        let f = s.correct(&k, 3, 900, 1020, 1010, 0.5).unwrap();
        assert!((f - 0.2833).abs() < 0.01, "{f}");
        // A far-off estimate: moved at most 45 s of travel (0.375) towards the reports.
        let f = s.correct(&k, 3, 900, 1020, 1010, 0.95).unwrap();
        assert!((f - 0.575).abs() < 0.01, "{f}");
        // Other hop: nothing.
        assert_eq!(s.correct(&k, 4, 900, 1020, 1010, 0.5), None);
        // Going backwards: nothing.
        assert!(s.add(k.clone(), "b", 1012, 1012, 3, 0.05).is_ok());
        assert_eq!(s.correct(&k, 3, 900, 1020, 1013, 0.5), None);
        // Expired after 3 minutes.
        assert_eq!(s.correct(&k, 3, 900, 1020, 1012 + KEEP_S + 1, 0.5), None);
    }
}
