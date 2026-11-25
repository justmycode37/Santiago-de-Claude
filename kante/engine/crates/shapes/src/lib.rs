//! The way each line's vehicles actually take between their stops: on the rails, tram tracks, roads, ferry lines
//! and aerialways of OpenStreetMap, not in straight lines (the Swiss timetable has no `shapes.txt`).
//!
//! `kante build` lays every timetable pattern onto the network ([`build`], see [`matcher`] for how) and writes the
//! result ([`Shapes`], `shapes.bin`); the server reads it and places vehicles along these paths.

pub mod matcher;
pub mod net;
#[cfg(test)]
mod tests;

use anyhow::Result;
use kante_core::geo::{BBox, LatLon};
use kante_core::{PatternIdx, StopIdx, Timetable};
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

pub const SHAPES_SCHEMA: &str = "shapes-v1";
pub const NONE: u32 = u32::MAX;

pub use matcher::{HOP_LINE, HOP_NET, HOP_STRAIGHT};

/// Every pattern's path, as a list of hops (stop to next stop) from a pool: the patterns of a line, and lines sharing
/// a street or a track, share their hops.
#[derive(Serialize, Deserialize, Default)]
pub struct Shapes {
    /// [`fingerprint`] of the timetable they were made for.
    pub timetable: u64,
    /// Per pattern: its shape, or [`NONE`] (a lift, a mode not laid out).
    pub pattern_shape: Vec<u32>,
    /// Shape `s`'s hops, one per stop but the last: `shape_hops[shape_off[s]..shape_off[s + 1]]`.
    pub shape_off: Vec<u32>,
    pub shape_hops: Vec<u32>,
    /// Per shape: the OSM route relation it follows, 0 when none fitted.
    pub relation: Vec<i64>,
    /// Hop `h`'s points are `pts[hop_off[h]..hop_off[h + 1]]`: from where the vehicle stands at the first stop
    /// (beside the boarding point, on its track or road) to where it stands at the second.
    pub hop_off: Vec<u32>,
    pub pts: Vec<LatLon>,
    /// Per hop: how it was found ([`HOP_NET`], [`HOP_LINE`], [`HOP_STRAIGHT`]).
    pub hop_kind: Vec<u8>,
}

/// Ties `shapes.bin` to the timetable: changes whenever the boarding points or the patterns' stops or lines do.
pub fn fingerprint(tt: &Timetable) -> u64 {
    let mut h: u64 = tt.stops_fingerprint() ^ 0x9e37_79b9_7f4a_7c15;
    let mut mix = |v: u64| h = (h ^ v).wrapping_mul(0x0000_0100_0000_01b3);
    mix(tt.patterns.len() as u64);
    for p in &tt.patterns {
        mix(p.line as u64);
        mix(p.n_stops as u64);
    }
    for &s in &tt.pattern_stops {
        mix(s as u64);
    }
    for l in &tt.lines {
        mix(l.mode as u64);
        for b in l.name.bytes() {
            mix(b as u64);
        }
    }
    h
}

/// A piece of a shape: from one stop of its pattern to a later one.
pub struct Piece {
    /// The points, from where the vehicle stands at the first stop to where it stands at the last.
    pub pts: Vec<LatLon>,
    /// Per stop of the piece: its vertex in `pts`.
    pub at: Vec<u32>,
    /// Some hop of the piece is a straight line, not on the network.
    pub straight: bool,
}

impl Shapes {
    pub fn is_empty(&self) -> bool {
        self.hop_kind.is_empty()
    }
    pub fn shape_of(&self, p: PatternIdx) -> Option<u32> {
        self.pattern_shape.get(p as usize).copied().filter(|&s| s != NONE)
    }
    fn hops_of(&self, s: u32) -> &[u32] {
        &self.shape_hops[self.shape_off[s as usize] as usize..self.shape_off[s as usize + 1] as usize]
    }
    /// Hop `h`'s points.
    pub fn hop(&self, h: u32) -> &[LatLon] {
        &self.pts[self.hop_off[h as usize] as usize..self.hop_off[h as usize + 1] as usize]
    }
    /// Where the vehicle of pattern `p` stands at its stop `pos`.
    pub fn anchor(&self, p: PatternIdx, pos: usize) -> Option<LatLon> {
        let hops = self.hops_of(self.shape_of(p)?);
        if pos < hops.len() {
            self.hop(hops[pos]).first().copied()
        } else if pos == hops.len() && pos > 0 {
            self.hop(hops[pos - 1]).last().copied()
        } else {
            None
        }
    }
    /// The way of pattern `p` from its stop `from` to its stop `to` (`from < to`).
    pub fn piece(&self, p: PatternIdx, from: usize, to: usize) -> Option<Piece> {
        let hops = self.hops_of(self.shape_of(p)?);
        if from >= to || to > hops.len() {
            return None;
        }
        let mut pts: Vec<LatLon> = Vec::new();
        let mut at = Vec::with_capacity(to - from + 1);
        let mut straight = false;
        for &h in &hops[from..to] {
            let q = self.hop(h);
            if pts.is_empty() {
                at.push(0);
            }
            let skip = usize::from(!pts.is_empty() && pts.last() == q.first());
            pts.extend_from_slice(&q[skip..]);
            at.push(pts.len() as u32 - 1);
            straight |= self.hop_kind[h as usize] == HOP_STRAIGHT;
        }
        Some(Piece { pts, at, straight })
    }
    /// The relation a pattern's shape follows (0: none).
    pub fn relation_of(&self, p: PatternIdx) -> i64 {
        self.shape_of(p).map_or(0, |s| self.relation[s as usize])
    }
    fn hop_box(&self, h: u32) -> BBox {
        let mut b = BBox::empty();
        for q in self.hop(h) {
            b.extend(q);
        }
        b
    }
    /// Per pattern, the box around its shape (empty where it has none).
    pub fn pattern_boxes(&self) -> Vec<BBox> {
        let boxes: Vec<BBox> = (0..self.hop_kind.len() as u32).map(|h| self.hop_box(h)).collect();
        self.pattern_shape
            .iter()
            .map(|&s| {
                let mut b = BBox::empty();
                if s != NONE {
                    for &h in self.hops_of(s) {
                        let hb = &boxes[h as usize];
                        b.extend(&hb.min);
                        b.extend(&hb.max);
                    }
                }
                b
            })
            .collect()
    }
    /// The box around each distinct hop's way, and per pattern stop (`Timetable::pattern_stops` order) the hop to
    /// the next stop ([`NONE`] after the last stop and where the pattern has no shape).
    pub fn hop_boxes(&self, tt: &Timetable) -> (Vec<BBox>, Vec<u32>) {
        let boxes = (0..self.hop_kind.len() as u32).map(|h| self.hop_box(h)).collect();
        let mut of = vec![NONE; tt.pattern_stops.len()];
        for (pi, pat) in tt.patterns.iter().enumerate() {
            let Some(s) = self.shape_of(pi as PatternIdx) else { continue };
            let hops = self.hops_of(s);
            if hops.len() + 1 != pat.n_stops as usize {
                continue;
            }
            of[pat.stops_off as usize..pat.stops_off as usize + hops.len()].copy_from_slice(hops);
        }
        (boxes, of)
    }
    /// The hop from stop `pos` of pattern `p` to the next is on the network (not a straight line).
    pub fn hop_on_network(&self, p: PatternIdx, pos: usize) -> bool {
        self.shape_of(p).and_then(|s| self.hops_of(s).get(pos).copied()).is_some_and(|h| self.hop_kind[h as usize] != HOP_STRAIGHT)
    }
    /// A pattern that makes the hop from boarding point `a` straight on to `b` on the network, for a run that is not a
    /// pattern of its own (an extra journey) or left it (a changed platform): (pattern, position of `a`). Only of
    /// `mode`; of the line named `line` where there is one (two lines between the same stops can take other streets).
    pub fn borrow(&self, tt: &Timetable, mode: Option<kante_core::Mode>, line: &str, a: StopIdx, b: StopIdx) -> Option<(PatternIdx, usize)> {
        let want = net::norm_ref(line);
        let mut best: Option<(bool, PatternIdx, usize)> = None;
        for &(p, pos) in tt.stop_patterns(a) {
            let (pos, st) = (pos as usize, tt.pattern_stops(p));
            if st.get(pos + 1) != Some(&b) || !self.hop_on_network(p, pos) {
                continue;
            }
            let l = &tt.lines[tt.patterns[p as usize].line as usize];
            if Some(l.mode) != mode {
                continue;
            }
            let own = !want.is_empty() && net::norm_ref(&l.name) == want;
            if best.is_none_or(|x| own && !x.0) {
                best = Some((own, p, pos));
            }
        }
        best.map(|x| (x.1, x.2))
    }
}

/// Google's encoded polyline (precision 5: about a metre), latitude first.
pub fn encode(pts: impl IntoIterator<Item = LatLon>) -> String {
    fn put(out: &mut String, v: i64) {
        let mut v = if v < 0 { !(v << 1) } else { v << 1 };
        while v >= 0x20 {
            out.push((((v & 0x1f) | 0x20) as u8 + 63) as char);
            v >>= 5;
        }
        out.push((v as u8 + 63) as char);
    }
    let mut out = String::new();
    let (mut plat, mut plon) = (0i64, 0i64);
    for q in pts {
        let (la, lo) = ((q.lat as f64 / 100.0).round() as i64, (q.lon as f64 / 100.0).round() as i64);
        put(&mut out, la - plat);
        put(&mut out, lo - plon);
        plat = la;
        plon = lo;
    }
    out
}

#[derive(Default, Debug)]
pub struct BuildStats {
    pub patterns: usize,
    pub laid_out: usize,
    pub shapes: usize,
    pub with_relation: usize,
    /// Hops of all shapes by kind, and the distinct ones kept.
    pub hops: [usize; 3],
    pub unique_hops: usize,
    pub points: usize,
    /// Straight hops at a stop with no way of its mode near it (abroad, outside the map), and the others.
    pub straight_off_map: usize,
    pub straight_other: usize,
    pub straight_m: f64,
    pub all_m: f64,
    /// Metres between boarding point and vehicle anchor, boarding points with their own coordinate: p50, p95.
    pub snap_p50: f32,
    pub snap_p95: f32,
    /// A few straight hops between stops on the map, to look at.
    pub samples: Vec<String>,
}

/// What the build needs of the timetable, and nothing more: the boarding points and, per distinct (mode, line,
/// stops), its stops. `kante build` takes this and lets the timetable go (its trips and times are most of its memory)
/// before the network is read.
pub struct Input {
    /// [`fingerprint`] of the timetable.
    pub timetable: u64,
    /// Per boarding point (`StopIdx`): position, platform label, precision, station name (for the build's samples).
    pub stops: Vec<(LatLon, String, kante_core::Precision, String)>,
    /// Per pattern: its group, or [`NONE`] (a lift, a mode not laid out).
    pub group_of: Vec<u32>,
    /// Per group, in the order of its first pattern: mode, line name, stops.
    pub groups: Vec<(kante_core::Mode, String, Vec<StopIdx>)>,
}

impl Input {
    pub fn of(tt: &Timetable) -> Input {
        // one search per (mode, line, stops): RAPTOR patterns that differ only in pickup flags share it
        let mut index: FxHashMap<(u8, String, &[StopIdx]), u32> = FxHashMap::default();
        let mut group_of = vec![NONE; tt.patterns.len()];
        let mut groups = Vec::new();
        for p in 0..tt.patterns.len() as PatternIdx {
            let line = &tt.lines[tt.patterns[p as usize].line as usize];
            if matcher::profile(line.mode).is_none() || tt.pattern_stops(p).len() < 2 {
                continue;
            }
            let key = (line.mode as u8, net::norm_ref(&line.name), tt.pattern_stops(p));
            let g = *index.entry(key).or_insert_with(|| {
                groups.push((line.mode, line.name.clone(), tt.pattern_stops(p).to_vec()));
                groups.len() as u32 - 1
            });
            group_of[p as usize] = g;
        }
        let stops = tt.stops.iter().map(|s| (s.pos, s.label.clone(), s.precision, tt.stations[s.station as usize].name.clone())).collect();
        Input { timetable: fingerprint(tt), stops, group_of, groups }
    }
}

/// Lays every pattern of `tt` onto the network read from `pbf`, with `threads` searches at once.
pub fn build(tt: &Timetable, pbf: &Path, threads: usize) -> Result<(Shapes, BuildStats)> {
    build_input(Input::of(tt), pbf, threads)
}

/// [`build`] from what it needs of the timetable.
pub fn build_input(input: Input, pbf: &Path, threads: usize) -> Result<(Shapes, BuildStats)> {
    let t0 = std::time::Instant::now();
    let net = net::load(pbf)?;
    let Input { timetable, stops, group_of, groups } = input;
    eprintln!("   {} patterns, {} to lay out", group_of.len(), groups.len());
    let pool = rayon::ThreadPoolBuilder::new().num_threads(threads.max(1)).build()?;
    let scratches: Mutex<Vec<matcher::Scratch>> = Mutex::new(Vec::new());
    let mut out = Shapes { timetable, shape_off: vec![0], hop_off: vec![0], ..Default::default() };
    let mut st = BuildStats { patterns: group_of.len(), shapes: groups.len(), ..Default::default() };
    let mut snaps: Vec<f32> = Vec::new();
    let mut pool_ix: FxHashMap<Vec<LatLon>, u32> = FxHashMap::default();
    // a chunk of groups at a time, each chunk's results put into the hop pool in order (the same file as all at
    // once, without holding every pattern's points until the end)
    const CHUNK: usize = 4096;
    for (c, chunk) in groups.chunks(CHUNK).enumerate() {
        let results: Vec<(matcher::Matched, Vec<bool>)> = pool.install(|| {
            use rayon::prelude::*;
            chunk
                .par_iter()
                .map(|(mode, line, stop_ix)| {
                    let mut s = scratches.lock().unwrap().pop().unwrap_or_else(|| matcher::Scratch::new(&net));
                    let prof = matcher::profile(*mode).expect("laid-out modes have a profile");
                    let ins: Vec<matcher::StopIn> = stop_ix
                        .iter()
                        .map(|&i| {
                            let x = &stops[i as usize];
                            matcher::StopIn { pos: x.0, label: &x.1, precision: x.2 }
                        })
                        .collect();
                    let rel = matcher::pick_relation(&net, &prof, &net::norm_ref(line), &ins).map(|r| r.0);
                    let m = matcher::match_pattern(&net, &prof, &mut s, &ins, rel);
                    let own = ins.iter().map(|s| s.precision == kante_core::Precision::Edge).collect();
                    scratches.lock().unwrap().push(s);
                    (m, own)
                })
                .collect()
        });
        for (k, (m, own)) in results.iter().enumerate() {
            let (mode, line, stop_ix) = &groups[c * CHUNK + k];
            let ll: Vec<LatLon> = m.pts.iter().map(|q| LatLon::from_xy(q[0], q[1])).collect();
            for (h, &kind) in m.hops.iter().enumerate() {
                let (a, b) = (m.at[h] as usize, m.at[h + 1] as usize);
                let len: f64 = m.pts[a..=b].windows(2).map(|w| net::dist(w[0], w[1]) as f64).sum();
                st.hops[kind as usize] += 1;
                st.all_m += len;
                if kind == HOP_STRAIGHT {
                    st.straight_m += len;
                    if m.off_map[h] || m.off_map[h + 1] {
                        st.straight_off_map += 1;
                    } else {
                        st.straight_other += 1;
                        if st.samples.len() < 40 && st.straight_other % 97 == 1 {
                            let (sa, sb) = (&stops[stop_ix[h] as usize], &stops[stop_ix[h + 1] as usize]);
                            st.samples.push(format!(
                                "{} {} {} ({:.5},{:.5}) -> {} ({:.5},{:.5}) {:.0} m",
                                mode.as_str(),
                                line,
                                sa.3,
                                sa.0.lat_deg(),
                                sa.0.lon_deg(),
                                sb.3,
                                sb.0.lat_deg(),
                                sb.0.lon_deg(),
                                sa.0.dist_m(&sb.0)
                            ));
                        }
                    }
                }
                let q = ll[a..=b].to_vec();
                let next = pool_ix.len() as u32;
                let id = *pool_ix.entry(q).or_insert_with_key(|q| {
                    out.pts.extend_from_slice(q);
                    out.hop_off.push(out.pts.len() as u32);
                    out.hop_kind.push(kind);
                    next
                });
                out.shape_hops.push(id);
            }
            out.shape_off.push(out.shape_hops.len() as u32);
            out.relation.push(m.relation);
            if m.relation != 0 {
                st.with_relation += 1;
            }
            for (d, o) in m.snap_m.iter().zip(own) {
                if *o && d.is_finite() {
                    snaps.push(*d);
                }
            }
        }
        let done = (c * CHUNK + chunk.len()) as u64;
        if done / 20000 != (c * CHUNK) as u64 / 20000 {
            eprintln!("   {done} of {} laid out ({:.0}s)", groups.len(), t0.elapsed().as_secs_f32());
        }
    }
    drop(scratches);
    st.unique_hops = out.hop_kind.len();
    st.points = out.pts.len();
    out.pattern_shape = group_of;
    st.laid_out = out.pattern_shape.iter().filter(|&&s| s != NONE).count();
    snaps.sort_by(f32::total_cmp);
    if !snaps.is_empty() {
        st.snap_p50 = snaps[snaps.len() / 2];
        st.snap_p95 = snaps[snaps.len() * 95 / 100];
    }
    Ok((out, st))
}
