//! Vehicles under way in a map window.
//!
//! The question "which trips are between two stops inside this box right now"
//! is answered time-first: per service date the trips are bucketed by the
//! quarter hours they are running in (built lazily, once per date), so only
//! the few thousand trips running nationally at `now` are looked at. Each is
//! rejected by the bounding box of its pattern (the spatial index over pattern
//! segments, one box per pattern) before its stop times are read; the exact
//! test is on the segment between the two stops it is currently between.
//! The cost depends on the number of running trips, hardly on the box size.

use crate::{Router, VehicleSeg, EARLY_SLACK};
use kante_core::geo::{BBox, LatLon};
use kante_core::time::{Date, Secs, DAY};
use kante_core::{DayIndex, LiveView, PatternIdx, Timetable, TripIdx};

const BUCKET: Secs = 900;

/// Trips of one service date by the time buckets their scheduled run overlaps.
pub(crate) struct UnderWay {
    off: Vec<u32>,
    /// (trip, pattern)
    trips: Vec<(TripIdx, PatternIdx)>,
}

impl UnderWay {
    pub fn build(tt: &Timetable, idx: &DayIndex) -> Self {
        let span = |t: TripIdx| {
            let times = tt.trip_times(t);
            let b0 = (times[1].max(0) / BUCKET) as usize;
            let b1 = (times[times.len() - 2].max(0) / BUCKET) as usize;
            (b0, b1.max(b0))
        };
        let mut nb = 0;
        for &t in &idx.trips {
            nb = nb.max(span(t).1 + 1);
        }
        let mut off = vec![0u32; nb + 1];
        for &t in &idx.trips {
            let (b0, b1) = span(t);
            for b in b0..=b1 {
                off[b + 1] += 1;
            }
        }
        for b in 0..nb {
            off[b + 1] += off[b];
        }
        let mut fill = off.clone();
        let mut trips = vec![(0, 0); off[nb] as usize];
        for &t in &idx.trips {
            let (b0, b1) = span(t);
            let p = tt.trips[t as usize].pattern;
            for b in b0..=b1 {
                trips[fill[b] as usize] = (t, p);
                fill[b] += 1;
            }
        }
        UnderWay { off, trips }
    }

    fn buckets(&self) -> usize {
        self.off.len() - 1
    }

    fn bucket(&self, b: usize) -> &[(TripIdx, PatternIdx)] {
        &self.trips[self.off[b] as usize..self.off[b + 1] as usize]
    }
}

pub(crate) fn pattern_boxes(tt: &Timetable) -> Vec<BBox> {
    (0..tt.patterns.len() as PatternIdx)
        .map(|p| {
            let mut b = BBox::empty();
            for &s in tt.pattern_stops(p) {
                b.extend(&tt.stops[s as usize].pos);
            }
            b
        })
        .collect()
}

/// Does the straight segment `a`–`b` touch `bbox`? (Liang–Barsky clipping.)
fn segment_hits(a: &LatLon, b: &LatLon, bbox: &BBox) -> bool {
    if bbox.contains(a) || bbox.contains(b) {
        return true;
    }
    let (x0, y0) = (a.lon as f64, a.lat as f64);
    let (dx, dy) = (b.lon as f64 - x0, b.lat as f64 - y0);
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for (p, q) in [
        (-dx, x0 - bbox.min.lon as f64),
        (dx, bbox.max.lon as f64 - x0),
        (-dy, y0 - bbox.min.lat as f64),
        (dy, bbox.max.lat as f64 - y0),
    ] {
        if p == 0.0 {
            if q < 0.0 {
                return false;
            }
        } else {
            let r = q / p;
            if p < 0.0 {
                t0 = t0.max(r);
            } else {
                t1 = t1.min(r);
            }
            if t0 > t1 {
                return false;
            }
        }
    }
    true
}

pub(crate) fn vehicles(rt: &Router, bbox: &BBox, date: Date, now: Secs, live: Option<&dyn LiveView>) -> Vec<VehicleSeg> {
    let tt = &*rt.tt;
    let days = rt.days.set(tt, &rt.pat_span, date);
    let boxes = rt.pattern_boxes();
    let hop_boxes = rt.hop_boxes();
    let max_delay = live.map_or(0, |l| l.max_delay().max(0));
    let early = if live.is_some() { EARLY_SLACK } else { 0 };
    let mut out = Vec::new();
    for d in 0..3usize {
        let shift = (d as Secs - 1) * DAY;
        let t = now - shift;
        let day = &days.days[d];
        if day.idx.trips.is_empty() {
            continue;
        }
        let uw = day.under_way(tt);
        // A late trip is still under way after its scheduled end, an early one before its start.
        let (lo, hi) = (t - max_delay, t + early);
        if hi < 0 || uw.buckets() == 0 || lo / BUCKET >= uw.buckets() as Secs {
            continue;
        }
        let b_lo = (lo.max(0) / BUCKET) as usize;
        let b_hi = ((hi / BUCKET) as usize).min(uw.buckets() - 1);
        let tdate = date + d as Date - 1;
        for b in b_lo..=b_hi {
            for &(trip, p) in uw.bucket(b) {
                if !boxes[p as usize].intersects(bbox) {
                    continue;
                }
                let times = tt.trip_times(trip);
                // A trip sits in every bucket it overlaps; take it once.
                if b > b_lo && (times[1].max(0) / BUCKET) as usize != b {
                    continue;
                }
                let lv = live.and_then(|l| l.trip(tdate, trip));
                if lv.is_some_and(|l| l.cancelled) {
                    continue;
                }
                let n = times.len() / 2;
                let arr = |i: usize| times[2 * i] + lv.map_or(0, |l| l.arr_delay_at(i));
                let dep = |i: usize| times[2 * i + 1] + lv.map_or(0, |l| l.dep_delay_at(i));
                // First position the vehicle has not left yet.
                let Some(i) = (0..n).find(|&i| t < dep(i)) else { continue };
                let stops = tt.pattern_stops(p);
                let pos_of = |i: usize| &tt.stops[stops[i] as usize].pos;
                if t >= arr(i) {
                    // Standing at stop `i`; a vehicle at its terminus is no longer under way.
                    if i + 1 < n && bbox.contains(pos_of(i)) {
                        out.push(VehicleSeg { trip, date: tdate, pos: i as u16, dwell: true, dep: dep(i) + shift, arr: arr(i + 1) + shift });
                    }
                } else if i > 0
                    && (segment_hits(pos_of(i - 1), pos_of(i), bbox)
                        // the way of the hop, and of those beside it: over a stop skipped today the vehicle is placed
                        // on the way between the stops it serves
                        || hop_boxes.is_some_and(|h| {
                            let off = tt.patterns[p as usize].stops_off as usize;
                            (i.saturating_sub(2)..=i.min(n - 2)).any(|k| h[off + k].intersects(bbox))
                        }))
                {
                    out.push(VehicleSeg { trip, date: tdate, pos: i as u16 - 1, dwell: false, dep: dep(i - 1) + shift, arr: arr(i) + shift });
                }
            }
        }
    }
    out
}
