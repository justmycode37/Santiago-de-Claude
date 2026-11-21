//! Per-date trip indices, cached inside the [`crate::Router`].

use crate::vehicles::UnderWay;
use kante_core::time::{Date, Secs};
use kante_core::{DayIndex, PatternIdx, StopIdx, Timetable, TripIdx, FLAG_NO_PICKUP};
use parking_lot::Mutex;
use rayon::prelude::*;
use std::sync::{Arc, OnceLock};

/// Bits of a packed stop departure that hold the `stop_patterns` index.
pub(crate) const ENT_BITS: u32 = 12;
const MAX_PACKED_TIME: Secs = 1 << (32 - ENT_BITS);

/// One service date.
pub(crate) struct DayData {
    pub idx: DayIndex,
    /// Scheduled departures of the day's trips, column-major per pattern: the
    /// block of pattern `p` starts at `col_off[p]` and holds, for each stop
    /// position, the departures of its `m` active trips in trip order. The
    /// "next trip at this stop after t" search then stays inside one or two
    /// cache lines instead of jumping through `Timetable::times`.
    col_off: Vec<u32>,
    deps: Vec<Secs>,
    /// Per stop, every scheduled departure of the day that can be boarded
    /// there, sorted by time (CSR by stop), packed as
    /// `time << ENT_BITS | index into Timetable::stop_patterns(stop)`.
    /// Answers "which patterns leave this stop between t₁ and t₂" without
    /// touching the patterns. Empty when the feed does not fit the packing
    /// (`sd_ok` false); the router then queues every pattern of a stop.
    sd_off: Vec<u32>,
    sd: Vec<u32>,
    pub sd_ok: bool,
    /// Earliest and latest boardable departure of the day.
    pub t_min: Secs,
    pub t_max: Secs,
    under: OnceLock<UnderWay>,
}

impl DayData {
    fn build(tt: &Timetable, date: Date) -> Self {
        let idx = tt.day_index(date);
        let np = tt.patterns.len();
        let mut col_off = Vec::with_capacity(np + 1);
        let mut total = 0u32;
        for (p, pat) in tt.patterns.iter().enumerate() {
            col_off.push(total);
            total += (idx.pat_off[p + 1] - idx.pat_off[p]) * pat.n_stops as u32;
        }
        col_off.push(total);
        let mut deps = vec![0; total as usize];
        for (p, pat) in tt.patterns.iter().enumerate() {
            let trips = idx.pattern_trips(p as PatternIdx);
            let (m, n) = (trips.len(), pat.n_stops as usize);
            let block = &mut deps[col_off[p] as usize..col_off[p + 1] as usize];
            for (j, &t) in trips.iter().enumerate() {
                let row = pat.times_off as usize + (t - pat.trips_off) as usize * 2 * n;
                for (i, d) in tt.times[row..row + 2 * n].chunks_exact(2).enumerate() {
                    block[i * m + j] = d[1];
                }
            }
        }
        // Stop departure lists, built stop by stop in parallel.
        let sd_ok = tt.stop_pattern_off.windows(2).all(|w| w[1] - w[0] <= 1 << ENT_BITS) && tt.times.iter().step_by(4097).all(|&t| (0..MAX_PACKED_TIME).contains(&t));
        let lists: Vec<Vec<u32>> = if !sd_ok {
            Vec::new()
        } else {
            (0..tt.stops.len() as StopIdx)
                .into_par_iter()
                .map(|s| {
                    let mut v = Vec::new();
                    for (e, &(p, pos)) in tt.stop_patterns(s).iter().enumerate() {
                        let m = (idx.pat_off[p as usize + 1] - idx.pat_off[p as usize]) as usize;
                        if m == 0 {
                            continue;
                        }
                        let pat = &tt.patterns[p as usize];
                        if pos + 1 >= pat.n_stops || tt.pattern_flags[pat.stops_off as usize + pos as usize] & FLAG_NO_PICKUP != 0 {
                            continue;
                        }
                        let b = col_off[p as usize] as usize + pos as usize * m;
                        v.extend(deps[b..b + m].iter().map(|&t| (t.clamp(0, MAX_PACKED_TIME - 1) as u32) << ENT_BITS | e as u32));
                    }
                    v.sort_unstable();
                    v
                })
                .collect()
        };
        let mut sd_off = Vec::with_capacity(tt.stops.len() + 1);
        let mut sd = Vec::with_capacity(lists.iter().map(Vec::len).sum());
        let (mut t_min, mut t_max) = (Secs::MAX, Secs::MIN);
        sd_off.push(0);
        for l in &lists {
            if let (Some(a), Some(b)) = (l.first(), l.last()) {
                t_min = t_min.min((a >> ENT_BITS) as Secs);
                t_max = t_max.max((b >> ENT_BITS) as Secs);
            }
            sd.extend_from_slice(l);
            sd_off.push(sd.len() as u32);
        }
        if !sd_ok {
            sd_off.resize(tt.stops.len() + 1, 0);
        }
        DayData { idx, col_off, deps, sd_off, sd, sd_ok, t_min, t_max, under: OnceLock::new() }
    }

    /// Boardable departures of the day at stop `s`, sorted; see `sd`.
    #[inline]
    pub fn stop_departures(&self, s: StopIdx) -> &[u32] {
        &self.sd[self.sd_off[s as usize] as usize..self.sd_off[s as usize + 1] as usize]
    }

    pub fn under_way(&self, tt: &Timetable) -> &UnderWay {
        self.under.get_or_init(|| UnderWay::build(tt, &self.idx))
    }
}

/// The three service dates a query on `date` looks at: `date - 1`, `date`, `date + 1`.
pub(crate) struct DaySet {
    #[allow(dead_code)]
    pub date: Date,
    pub days: [Arc<DayData>; 3],
    /// `Timetable::stop_patterns` reduced to what can be boarded around this
    /// date: patterns with a trip on one of the three dates, at positions
    /// that allow pickup and are not the last. CSR by stop.
    sp_off: Vec<u32>,
    sp: Vec<Boardable>,
    /// Per pattern, where its trips of the three dates are: one cache line
    /// instead of one per date and array.
    pat: Vec<PatDays>,
}

/// Where a pattern's trips are in each of the three `DayData`.
#[derive(Clone, Copy)]
#[repr(C)]
pub(crate) struct PatDays {
    /// Offset of the pattern's block in `DayData::deps`.
    col: [u32; 3],
    /// First trip in `DayIndex::trips`.
    lo: [u32; 3],
    /// Number of trips on that date.
    m: [u32; 3],
    /// Earliest and latest time of any trip of the pattern (service-day seconds).
    pub min: Secs,
    pub max: Secs,
    /// `Mode::bit` of the pattern's line.
    pub mode: u16,
}

impl PatDays {
    /// Trips of consecutive service dates interleave in time (the pattern
    /// spans 24 h or more).
    #[inline]
    pub fn wraps(&self) -> bool {
        self.max - self.min >= kante_core::time::DAY
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Boardable {
    pub pattern: PatternIdx,
    pub pos: u16,
    /// `Mode::bit` of the pattern's line.
    pub mode: u16,
}

impl DaySet {
    #[inline]
    pub fn boardable(&self, s: StopIdx) -> &[Boardable] {
        &self.sp[self.sp_off[s as usize] as usize..self.sp_off[s as usize + 1] as usize]
    }

    #[inline]
    pub fn pat(&self, p: PatternIdx) -> &PatDays {
        &self.pat[p as usize]
    }

    /// Scheduled departures at position `pos` of the pattern's trips on day
    /// `d` (0 = the date before the query date), and those trips.
    #[inline]
    pub fn column(&self, h: &PatDays, d: usize, pos: usize) -> (&[Secs], &[TripIdx]) {
        let day = &*self.days[d];
        let m = h.m[d] as usize;
        let b = h.col[d] as usize + pos * m;
        (&day.deps[b..b + m], &day.idx.trips[h.lo[d] as usize..h.lo[d] as usize + m])
    }
}

const MAX_DAYS: usize = 10;
const MAX_SETS: usize = 8;

/// Small most-recently-used caches. A `DayData` takes ~30 MB on the national
/// feed and a few tens of milliseconds to build.
#[derive(Default)]
pub(crate) struct DayCache {
    days: Mutex<Vec<Arc<DayData>>>,
    sets: Mutex<Vec<Arc<DaySet>>>,
}

impl DayCache {
    fn day(&self, tt: &Timetable, date: Date) -> Arc<DayData> {
        {
            let mut g = self.days.lock();
            if let Some(i) = g.iter().position(|d| d.idx.date == date) {
                let d = g.remove(i);
                g.push(d.clone());
                return d;
            }
        }
        // Built outside the lock: two threads may both build the same date, the
        // second result is dropped.
        let built = Arc::new(DayData::build(tt, date));
        let mut g = self.days.lock();
        if let Some(d) = g.iter().find(|d| d.idx.date == date) {
            return d.clone();
        }
        if g.len() >= MAX_DAYS {
            g.remove(0);
        }
        g.push(built.clone());
        built
    }

    /// `span`: per pattern the earliest and latest time of any of its trips.
    pub fn set(&self, tt: &Timetable, span: &[(Secs, Secs)], date: Date) -> Arc<DaySet> {
        {
            let mut g = self.sets.lock();
            if let Some(i) = g.iter().position(|s| s.date == date) {
                // Keep the hot entry at the back without shifting when it already is.
                if i + 1 != g.len() {
                    let s = g.remove(i);
                    g.push(s);
                }
                return g.last().unwrap().clone();
            }
        }
        let (a, (b, c)) = rayon::join(|| self.day(tt, date - 1), || rayon::join(|| self.day(tt, date), || self.day(tt, date + 1)));
        let days = [a, b, c];
        let active = |p: PatternIdx| days.iter().any(|d| d.idx.pat_off[p as usize] != d.idx.pat_off[p as usize + 1]);
        let mut sp_off = Vec::with_capacity(tt.stops.len() + 1);
        let mut sp = Vec::new();
        for s in 0..tt.stops.len() as StopIdx {
            sp_off.push(sp.len() as u32);
            for &(p, pos) in tt.stop_patterns(s) {
                if !active(p) {
                    continue;
                }
                let pat = &tt.patterns[p as usize];
                if pos + 1 < pat.n_stops && tt.pattern_flags[pat.stops_off as usize + pos as usize] & FLAG_NO_PICKUP == 0 {
                    sp.push(Boardable { pattern: p, pos, mode: tt.lines[pat.line as usize].mode.bit() });
                }
            }
        }
        sp_off.push(sp.len() as u32);
        let pat = (0..tt.patterns.len())
            .map(|p| {
                let (min, max) = span[p];
                let mut h = PatDays { col: [0; 3], lo: [0; 3], m: [0; 3], min, max, mode: tt.lines[tt.patterns[p].line as usize].mode.bit() };
                for (d, day) in days.iter().enumerate() {
                    h.col[d] = day.col_off[p];
                    h.lo[d] = day.idx.pat_off[p];
                    h.m[d] = day.idx.pat_off[p + 1] - day.idx.pat_off[p];
                }
                h
            })
            .collect();
        let set = Arc::new(DaySet { date, days, sp_off, sp, pat });
        let mut g = self.sets.lock();
        if let Some(s) = g.iter().find(|s| s.date == date) {
            return s.clone();
        }
        if g.len() >= MAX_SETS {
            g.remove(0);
        }
        g.push(set.clone());
        set
    }
}
