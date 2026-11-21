//! Departure board: a k-way merge over (stop, pattern, service date) lists,
//! each of which is sorted by scheduled departure.

use crate::{DepartureEvent, Router, EARLY_SLACK};
use kante_core::time::{Date, Secs, DAY};
use kante_core::{LiveView, StopIdx, TripIdx};
use std::cmp::Reverse;
use std::collections::BinaryHeap;

struct Cursor<'a> {
    /// Scheduled departures at this stop position and the trips, in step.
    col: &'a [Secs],
    trips: &'a [TripIdx],
    shift: Secs,
    date: Date,
    idx: usize,
    pos: u16,
    stop: StopIdx,
}

pub(crate) fn departures(rt: &Router, stops: &[StopIdx], date: Date, from: Secs, limit: usize, live: Option<&dyn LiveView>) -> Vec<DepartureEvent> {
    let tt = &*rt.tt;
    if limit == 0 {
        return Vec::new();
    }
    let days = rt.days.set(tt, &rt.pat_span, date);
    let max_delay = live.map_or(0, |l| l.max_delay().max(0));
    let early = if live.is_some() { EARLY_SLACK } else { 0 };
    // A trip scheduled before `from` can still be due if it runs late.
    let lo = from.saturating_sub(max_delay);

    let mut uniq: Vec<StopIdx> = stops.iter().copied().filter(|&s| (s as usize) < tt.stops.len()).collect();
    uniq.sort_unstable();
    uniq.dedup();

    let mut cursors: Vec<Cursor> = Vec::new();
    let mut heap: BinaryHeap<Reverse<(Secs, u32)>> = BinaryHeap::new();
    for &s in &uniq {
        for b in days.boardable(s) {
            let h = days.pat(b.pattern);
            for d in 0..3usize {
                let shift = (d as Secs - 1) * DAY;
                if h.max + shift < lo {
                    continue;
                }
                let (col, trips) = days.column(h, d, b.pos as usize);
                let idx = col.partition_point(|&x| x + shift < lo);
                if idx < col.len() {
                    heap.push(Reverse((col[idx] + shift, cursors.len() as u32)));
                    cursors.push(Cursor { col, trips, shift, date: date + d as Date - 1, idx, pos: b.pos, stop: s });
                }
            }
        }
    }

    // The `limit` earliest by live departure seen so far (max-heap).
    let mut kept: BinaryHeap<(Secs, Secs, TripIdx, Date, u16, StopIdx, bool)> = BinaryHeap::with_capacity(limit + 1);
    while let Some(Reverse((sd, ci))) = heap.pop() {
        if kept.len() == limit && sd - early > kept.peek().unwrap().0 {
            break;
        }
        let c = &mut cursors[ci as usize];
        let trip = c.trips[c.idx];
        let (live_dep, cancelled) = match live.and_then(|l| l.trip(c.date, trip)) {
            Some(l) => (sd + l.dep_delay_at(c.pos as usize), l.is_skipped(c.pos as usize)),
            None => (sd, false),
        };
        if live_dep >= from {
            kept.push((live_dep, sd, trip, c.date, c.pos, c.stop, cancelled));
            if kept.len() > limit {
                kept.pop();
            }
        }
        c.idx += 1;
        if c.idx < c.col.len() {
            heap.push(Reverse((c.col[c.idx] + c.shift, ci)));
        }
    }
    kept.into_sorted_vec()
        .into_iter()
        .map(|(live_dep, dep, trip, date, pos, stop, cancelled)| DepartureEvent { trip, date, pos, stop, dep, live_dep, cancelled })
        .collect()
}
