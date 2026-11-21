//! Trip lookup by GTFS trip id and by Swiss journey id.
//!
//! Both maps are arrays of trips sorted by a 64-bit hash of the id (built in
//! parallel, 12 bytes per trip) and searched by binary search; the string is
//! compared on a hash hit, so a collision cannot return a wrong trip.

use kante_core::{Timetable, TripIdx};
use rayon::prelude::*;

pub(crate) struct IdMaps {
    gtfs_keys: Vec<u64>,
    gtfs_trips: Vec<TripIdx>,
    sj_keys: Vec<u64>,
    sj_trips: Vec<TripIdx>,
}

/// FNV-1a with a final mix.
fn hash(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in s.as_bytes() {
        h = (h ^ b as u64).wrapping_mul(0x100000001b3);
    }
    h ^= h >> 32;
    h = h.wrapping_mul(0x9e3779b97f4a7c15);
    h ^ (h >> 29)
}

fn sorted(tt: &Timetable, id_of: impl Fn(TripIdx) -> u32 + Sync, skip_empty: bool) -> (Vec<u64>, Vec<TripIdx>) {
    let mut v: Vec<(u64, TripIdx)> = (0..tt.trips.len() as TripIdx)
        .into_par_iter()
        .filter_map(|t| {
            let s = tt.str(id_of(t));
            (!(skip_empty && s.is_empty())).then(|| (hash(s), t))
        })
        .collect();
    // Equal hashes: order by the string so that equal ids are adjacent even
    // if two different ids collide.
    v.par_sort_unstable_by(|a, b| a.0.cmp(&b.0).then_with(|| tt.str(id_of(a.1)).cmp(tt.str(id_of(b.1)))).then(a.1.cmp(&b.1)));
    v.into_iter().unzip()
}

impl IdMaps {
    pub fn build(tt: &Timetable) -> Self {
        let ((gtfs_keys, gtfs_trips), (sj_keys, sj_trips)) =
            rayon::join(|| sorted(tt, |t| tt.trips[t as usize].gtfs_id, false), || sorted(tt, |t| tt.trips[t as usize].sjyid, true));
        IdMaps { gtfs_keys, gtfs_trips, sj_keys, sj_trips }
    }

    pub fn find_trip(&self, tt: &Timetable, id: &str) -> Option<TripIdx> {
        let h = hash(id);
        let lo = self.gtfs_keys.partition_point(|&k| k < h);
        self.gtfs_trips[lo..]
            .iter()
            .zip(&self.gtfs_keys[lo..])
            .take_while(|&(_, &k)| k == h)
            .map(|(&t, _)| t)
            .find(|&t| tt.trip_gtfs_id(t) == id)
    }

    pub fn find_sjyid<'a>(&'a self, tt: &Timetable, id: &str) -> &'a [TripIdx] {
        if id.is_empty() {
            return &[];
        }
        let h = hash(id);
        let lo = self.sj_keys.partition_point(|&k| k < h);
        let hi = self.sj_keys.partition_point(|&k| k <= h);
        let run = &self.sj_trips[lo..hi];
        let sj = |t: TripIdx| tt.str(tt.trips[t as usize].sjyid);
        let a = run.partition_point(|&t| sj(t) < id);
        let b = run.partition_point(|&t| sj(t) <= id);
        &run[a..b]
    }
}
