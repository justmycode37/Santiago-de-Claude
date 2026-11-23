//! Compact timetable builder and a live-data stub for tests.

use kante_core::geo::LatLon;
use kante_core::time::{Date, Secs};
use kante_core::*;
use rustc_hash::FxHashMap;

pub const D0: Date = 20_000; // first service date of test timetables
pub const N_DAYS: u32 = 16;

/// `hm(8, 30)` = 08:30:00 as service-day seconds.
pub const fn hm(h: i32, m: i32) -> Secs {
    h * 3600 + m * 60
}

struct PTrip {
    id: usize,
    service: ServiceIdx,
    times: Vec<Secs>,
}

#[derive(Default)]
pub struct Builder {
    tt: Timetable,
    pats: Vec<(LineIdx, Vec<StopIdx>, Vec<u8>, Vec<PTrip>)>,
    n_trips: usize,
    conts: Vec<(usize, usize, ServiceIdx)>,
}

pub struct Built {
    pub tt: Timetable,
    /// Declaration id (as returned by `Builder::trip`) → TripIdx.
    pub trips: Vec<TripIdx>,
}

impl Builder {
    pub fn new() -> Self {
        let mut b = Builder::default();
        b.tt.start_date = D0;
        b.tt.n_days = N_DAYS;
        b.tt.service_words = 1;
        b.tt.strings.push(String::new());
        b.tt.agencies.push(Agency { gtfs_id: "a".into(), name: "A".into() });
        // service 0: every day
        b.tt.service_bits.push((1u64 << N_DAYS) - 1);
        b
    }

    /// A service running on the given day offsets from `D0`.
    pub fn service(&mut self, days: &[u32]) -> ServiceIdx {
        self.tt.service_bits.push(days.iter().fold(0, |m, d| m | 1u64 << d));
        self.tt.service_bits.len() as ServiceIdx - 1
    }

    /// A stop that is its own station, at planar metres (x, y).
    pub fn stop_at(&mut self, name: &str, x: f32, y: f32) -> StopIdx {
        let s = self.tt.stops.len() as StopIdx;
        let pos = LatLon::from_xy(x, y);
        self.tt.stations.push(Station { gtfs_id: name.into(), name: name.into(), pos, didok: 0, stops: vec![s], weight: 1, modes: 0 });
        self.tt.stops.push(Stop {
            gtfs_id: name.into(),
            sloid: String::new(),
            station: s,
            pos,
            label: String::new(),
            sectors: String::new(),
            precision: Precision::Edge,
            compass: -1,
            access: QuayAccess::Unknown,
            modes: 0,
        });
        s
    }

    /// Stops 10 km apart on a line, far enough that nothing is walkable by accident.
    pub fn stop(&mut self, name: &str) -> StopIdx {
        let n = self.tt.stops.len() as f32;
        self.stop_at(name, n * 10_000.0, 0.0)
    }

    pub fn line(&mut self, name: &str, mode: Mode) -> LineIdx {
        self.tt.lines.push(Line { gtfs_route_id: name.into(), name: name.into(), category: String::new(), mode, route_type: 0, agency: 0 });
        self.tt.lines.len() as LineIdx - 1
    }

    pub fn pattern(&mut self, line: LineIdx, stops: &[StopIdx]) -> usize {
        self.pattern_flags(line, stops, &vec![0; stops.len()])
    }

    pub fn pattern_flags(&mut self, line: LineIdx, stops: &[StopIdx], flags: &[u8]) -> usize {
        assert_eq!(stops.len(), flags.len());
        self.pats.push((line, stops.to_vec(), flags.to_vec(), Vec::new()));
        self.pats.len() - 1
    }

    /// A trip with `(arr, dep)` per stop. Returns a declaration id for `Built::t`.
    pub fn trip_on(&mut self, pat: usize, service: ServiceIdx, times: &[(Secs, Secs)]) -> usize {
        assert_eq!(times.len(), self.pats[pat].1.len());
        let id = self.n_trips;
        self.n_trips += 1;
        self.pats[pat].3.push(PTrip { id, service, times: times.iter().flat_map(|&(a, d)| [a, d]).collect() });
        id
    }

    /// A daily trip calling at each stop at the given time (arr = dep).
    pub fn trip(&mut self, pat: usize, times: &[Secs]) -> usize {
        let t: Vec<_> = times.iter().map(|&t| (t, t)).collect();
        self.trip_on(pat, 0, &t)
    }

    /// Daily trips every `headway` from `first` (departure at the first stop)
    /// with the given offsets per stop; returns the declaration ids.
    pub fn trips_every(&mut self, pat: usize, first: Secs, headway: Secs, count: usize, offsets: &[Secs]) -> Vec<usize> {
        (0..count)
            .map(|i| {
                let t: Vec<_> = offsets.iter().map(|o| first + i as Secs * headway + o).collect();
                self.trip(pat, &t)
            })
            .collect()
    }

    pub fn continuation(&mut self, from: usize, to: usize, service: ServiceIdx) {
        self.conts.push((from, to, service));
    }

    pub fn build(mut self) -> Built {
        let mut map = vec![0; self.n_trips];
        let mut by_stop: Vec<Vec<(PatternIdx, u16)>> = vec![Vec::new(); self.tt.stops.len()];
        for (p, (line, stops, flags, mut trips)) in std::mem::take(&mut self.pats).into_iter().enumerate() {
            trips.sort_by_key(|t| t.times[1]);
            let tt = &mut self.tt;
            tt.patterns.push(Pattern {
                line,
                stops_off: tt.pattern_stops.len() as u32,
                n_stops: stops.len() as u16,
                trips_off: tt.trips.len() as u32,
                n_trips: trips.len() as u32,
                times_off: tt.times.len() as u64,
            });
            for (i, &s) in stops.iter().enumerate() {
                by_stop[s as usize].push((p as PatternIdx, i as u16));
                tt.stops[s as usize].modes |= tt.lines[line as usize].mode.bit();
            }
            tt.pattern_stops.extend(&stops);
            tt.pattern_flags.extend(&flags);
            for t in trips {
                map[t.id] = tt.trips.len() as TripIdx;
                tt.strings.push(format!("trip{}", t.id));
                tt.strings.push(format!("ch:1:sjyid:{}", t.id / 2));
                let n = tt.strings.len() as u32;
                tt.trips.push(Trip { pattern: p as PatternIdx, service: t.service, headsign: 0, short_name: 0, gtfs_id: n - 2, sjyid: n - 1, flags: 0, headway_s: 0 });
                tt.times.extend(&t.times);
            }
        }
        let tt = &mut self.tt;
        tt.stop_pattern_off.push(0);
        for l in by_stop {
            tt.stop_patterns.extend(l);
            tt.stop_pattern_off.push(tt.stop_patterns.len() as u32);
        }
        for &(a, b, service) in &self.conts {
            tt.continuations.push(Continuation { from: map[a], to: map[b], service });
        }
        tt.continuations.sort_by_key(|c| c.from);
        Built { tt: self.tt, trips: map }
    }
}

/// Footpaths from an explicit list of directed `(from, to, var_m, fix_s)`.
pub fn footpaths(n_stops: usize, list: &[(StopIdx, StopIdx, u16, u16)]) -> Footpaths {
    let mut l = list.to_vec();
    l.sort();
    let mut fp = Footpaths { off: vec![0; n_stops + 1], ..Default::default() };
    for &(from, to, v, f) in &l {
        fp.off[from as usize + 1] += 1;
        fp.to.push(to);
        fp.var_m.push(v);
        fp.fix_s.push(f);
    }
    for i in 0..n_stops {
        fp.off[i + 1] += fp.off[i];
    }
    fp
}

#[derive(Default)]
pub struct TestLive {
    pub map: FxHashMap<(Date, TripIdx), TripLive>,
    /// Per-pattern / per-stop delay bounds, once [`TestLive::index`] was called;
    /// without them the `LiveView` defaults apply (global `max_delay`).
    pub bounds: Option<DelayIndex>,
}

impl TestLive {
    /// Delay the whole trip by `secs` from position `from_pos` on.
    pub fn delay(&mut self, date: Date, trip: TripIdx, n_stops: usize, from_pos: usize, secs: i32) -> &mut Self {
        let l = self.map.entry((date, trip)).or_default();
        l.arr_delay = (0..n_stops).map(|i| if i >= from_pos { secs } else { 0 }).collect();
        l.dep_delay = l.arr_delay.clone();
        l.observed_pos = -1;
        self
    }
    pub fn cancel(&mut self, date: Date, trip: TripIdx) -> &mut Self {
        self.map.entry((date, trip)).or_default().cancelled = true;
        self
    }
    /// Compute per-date, per-pattern and per-stop delay bounds (call after the last change).
    pub fn index(&mut self, tt: &Timetable) -> &mut Self {
        self.bounds = Some(DelayIndex::build(Some(tt), self.map.iter().map(|(&(d, t), l)| (d, t, l))));
        self
    }
    pub fn skip(&mut self, date: Date, trip: TripIdx, n_stops: usize, pos: usize) -> &mut Self {
        let l = self.map.entry((date, trip)).or_default();
        l.skipped.resize(n_stops, false);
        l.skipped[pos] = true;
        self
    }
}

impl LiveView for TestLive {
    fn trip(&self, date: Date, trip: TripIdx) -> Option<&TripLive> {
        self.map.get(&(date, trip))
    }
    fn max_delay(&self) -> Secs {
        self.map.values().flat_map(|l| l.dep_delay.iter().copied()).max().unwrap_or(0).max(0)
    }
    fn delay_bounds(&self, date: Date) -> DelayBounds<'_> {
        match &self.bounds {
            Some(b) => b.get(date),
            None => DelayBounds { max: self.max_delay(), pattern: &[], stop: &[] },
        }
    }
}

/// Only the required `LiveView` methods: the router looks back by the global
/// `max_delay` on every pattern and stop, as it did before per-pattern bounds.
pub struct GlobalOnly<'a>(pub &'a TestLive);

impl LiveView for GlobalOnly<'_> {
    fn trip(&self, date: Date, trip: TripIdx) -> Option<&TripLive> {
        self.0.trip(date, trip)
    }
    fn max_delay(&self) -> Secs {
        self.0.max_delay()
    }
}
