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
    /// Hashed address of the reporter (only to tell reporters apart; expires with the report).
    who: u64,
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

/// A reporter, as far as the rate limit and "two different phones" go.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Who(u64);

impl Store {
    /// The rate limit, checked before any other work: one report per address
    /// per [`RATE_S`].
    pub fn admit(&self, addr: &str, now: i64) -> Result<Who, Refused> {
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
        Ok(Who(who))
    }

    /// Keep a report that the handler has checked against the trip: at `t` the
    /// phone was `frac` (0…1) along the hop that starts at `hop`.
    pub fn add(&self, key: Key, who: Who, t: i64, hop: u16, frac: f32) {
        let mut g = self.inner.lock();
        let v = g.by_trip.entry(key).or_default();
        v.push(Report { t, hop, frac: frac.clamp(0.0, 1.0), who: who.0 });
        if v.len() > 32 {
            v.remove(0);
        }
    }

    /// The fraction of hop `hop` (from `dep` to `arr`, unix seconds) the vehicle
    /// has covered at `now` according to the reports, when they qualify: the
    /// newest reports of at least two different reporters, none of whom went
    /// backwards, agreeing within 20 s of travel. Bounded to [`MAX_SHIFT_S`]
    /// around `est` (the feed's fraction). `None` otherwise.
    pub fn correct(&self, key: &Key, hop: u16, dep: i64, arr: i64, now: i64, est: f32) -> Option<f32> {
        let g = self.inner.lock();
        let v = g.by_trip.get(key)?;
        let span = (arr - dep).max(1) as f32;
        let mut rs: Vec<Report> = v.iter().copied().filter(|r| r.hop == hop && now - r.t <= KEEP_S && r.t <= now).collect();
        rs.sort_by_key(|r| r.t);
        // Newest report per reporter on this hop, and whether that reporter went backwards.
        let mut newest: HashMap<u64, (Report, bool)> = HashMap::new();
        for r in rs {
            match newest.get_mut(&r.who) {
                Some((last, back)) => {
                    *back |= r.frac + 0.01 < last.frac;
                    *last = r;
                }
                None => {
                    newest.insert(r.who, (r, false));
                }
            }
        }
        let now_frac: Vec<f32> = newest.values().filter(|(_, back)| !back).map(|(r, _)| r.frac + (now - r.t) as f32 / span).collect();
        if now_frac.len() < 2 {
            return None;
        }
        let (lo, hi) = now_frac.iter().fold((f32::MAX, f32::MIN), |(lo, hi), &f| (lo.min(f), hi.max(f)));
        if (hi - lo) * span > 20.0 {
            return None; // the reporters disagree
        }
        let reported = now_frac.iter().sum::<f32>() / now_frac.len() as f32;
        let max = MAX_SHIFT_S / span;
        Some(reported.clamp(est - max, est + max).clamp(0.0, 1.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn needs_two_reporters_who_agree_and_stays_bounded() {
        let s = Store::default();
        let k = Key::Trip(100, 7);
        // Hop of 120 s from 900 to 1020; the feed thinks the vehicle is 50 % along.
        let a = s.admit("a", 1000).unwrap();
        s.add(k.clone(), a, 1000, 3, 0.2);
        assert_eq!(s.admit("a", 1002), Err(Refused::TooFrequent));
        let a = s.admit("a", 1006).unwrap();
        s.add(k.clone(), a, 1006, 3, 0.25);
        assert_eq!(s.correct(&k, 3, 900, 1020, 1010, 0.5), None, "one phone is not enough");
        let b = s.admit("b", 1007).unwrap();
        s.add(k.clone(), b, 1007, 3, 0.27);
        // a: 0.25 + 4/120 = 0.283, b: 0.27 + 3/120 = 0.295, mean 0.289
        let f = s.correct(&k, 3, 900, 1020, 1010, 0.5).unwrap();
        assert!((f - 0.289).abs() < 0.01, "{f}");
        // A far-off estimate: moved at most 45 s of travel (0.375) towards the reports.
        let f = s.correct(&k, 3, 900, 1020, 1010, 0.95).unwrap();
        assert!((f - 0.575).abs() < 0.01, "{f}");
        assert_eq!(s.correct(&k, 4, 900, 1020, 1010, 0.5), None, "other hop");
        // b now disagrees by more than 20 s of travel: nothing.
        let b = s.admit("b", 1013).unwrap();
        s.add(k.clone(), b, 1013, 3, 0.8);
        assert_eq!(s.correct(&k, 3, 900, 1020, 1014, 0.5), None);
        // Expired after 3 minutes.
        assert_eq!(s.correct(&k, 3, 900, 1020, 1013 + KEEP_S + 1, 0.5), None);
    }
}
