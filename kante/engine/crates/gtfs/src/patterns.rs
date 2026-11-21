//! From raw stop-time rows to RAPTOR patterns: index the rows per trip, repair
//! times, and group trips into non-overtaking patterns.

use crate::stop_times::{StRow, MISSING};
use kante_core::NONE;
use rayon::prelude::*;
use std::cmp::Ordering;

pub struct Grouped {
    /// First row of each trip (`NONE` when the trip has no rows).
    pub first: Vec<u32>,
    /// Number of rows of each trip.
    pub len: Vec<u32>,
    /// The file was not grouped by trip / ordered by sequence and had to be sorted.
    pub resorted: bool,
    pub duplicate_seq: u64,
}

fn runs(rows: &[StRow], n_trips: usize) -> Option<(Vec<u32>, Vec<u32>)> {
    let mut first = vec![NONE; n_trips];
    let mut len = vec![0u32; n_trips];
    let mut i = 0;
    while i < rows.len() {
        let t = rows[i].trip as usize;
        let mut j = i + 1;
        while j < rows.len() && rows[j].trip as usize == t {
            if rows[j].seq() <= rows[j - 1].seq() {
                return None;
            }
            j += 1;
        }
        if first[t] != NONE {
            return None;
        }
        first[t] = i as u32;
        len[t] = (j - i) as u32;
        i = j;
    }
    Some((first, len))
}

/// Make the rows of every trip contiguous and ordered by `stop_sequence`.
/// The national feed already is, so the common case is one linear scan.
pub fn group_rows(rows: &mut Vec<StRow>, n_trips: usize) -> Grouped {
    if let Some((first, len)) = runs(rows, n_trips) {
        return Grouped { first, len, resorted: false, duplicate_seq: 0 };
    }
    rows.par_sort_by_key(|r| (r.trip, r.seq()));
    let before = rows.len();
    rows.dedup_by(|b, a| a.trip == b.trip && a.seq() == b.seq());
    let duplicate_seq = (before - rows.len()) as u64;
    let (first, len) = runs(rows, n_trips).expect("sorted rows are grouped");
    Grouped { first, len, resorted: true, duplicate_seq }
}

#[derive(Default)]
pub struct NormStats {
    /// Rows whose arrival and/or departure was empty and has been filled in.
    pub interpolated: u64,
    /// Rows moved forward because they ran backwards in time.
    pub clamped: u64,
    /// Trips dropped because not a single row carried a time.
    pub trips_no_times: u64,
}

/// Fill empty times and make times non-decreasing along every trip.
pub fn normalise(rows: &mut [StRow], first: &[u32], len: &mut [u32]) -> NormStats {
    let mut st = NormStats::default();
    for t in 0..first.len() {
        if len[t] == 0 {
            continue;
        }
        let r = &mut rows[first[t] as usize..(first[t] + len[t]) as usize];
        let mut gaps = false;
        for x in r.iter_mut() {
            match (x.arr == MISSING, x.dep == MISSING) {
                (true, false) => {
                    x.arr = x.dep;
                    st.interpolated += 1;
                }
                (false, true) => {
                    x.dep = x.arr;
                    st.interpolated += 1;
                }
                (true, true) => gaps = true,
                _ => {}
            }
        }
        if gaps {
            let known: Vec<usize> = (0..r.len()).filter(|&i| r[i].arr != MISSING).collect();
            if known.is_empty() {
                st.trips_no_times += 1;
                len[t] = 0;
                continue;
            }
            for i in 0..known[0] {
                let v = r[known[0]].arr;
                r[i].arr = v;
                r[i].dep = v;
                st.interpolated += 1;
            }
            for i in known[known.len() - 1] + 1..r.len() {
                let v = r[known[known.len() - 1]].dep;
                r[i].arr = v;
                r[i].dep = v;
                st.interpolated += 1;
            }
            for w in known.windows(2) {
                let (a, b) = (w[0], w[1]);
                let (ta, tb) = (r[a].dep as i64, r[b].arr.max(r[a].dep) as i64);
                for k in a + 1..b {
                    let v = (ta + (tb - ta) * (k - a) as i64 / (b - a) as i64) as i32;
                    r[k].arr = v;
                    r[k].dep = v;
                    st.interpolated += 1;
                }
            }
        }
        let mut prev = i32::MIN;
        for x in r.iter_mut() {
            let mut moved = false;
            if x.arr < prev {
                x.arr = prev;
                moved = true;
            }
            if x.dep < x.arr {
                x.dep = x.arr;
                moved = true;
            }
            st.clamped += moved as u64;
            prev = x.dep;
        }
    }
    st
}

/// Read-only view of the indexed rows.
pub struct TripTable<'a> {
    pub rows: &'a [StRow],
    pub first: &'a [u32],
    pub len: &'a [u32],
    /// Line (route row) of each trip row.
    pub line: &'a [u32],
}

impl<'a> TripTable<'a> {
    #[inline]
    pub fn rows_of(&self, t: u32) -> &'a [StRow] {
        let n = self.len[t as usize] as usize;
        if n == 0 {
            // No stop_times at all (`first` is NONE) or dropped during repair.
            return &[];
        }
        let f = self.first[t as usize] as usize;
        &self.rows[f..f + n]
    }
}

/// One trip of the output: a source trip shifted in time (shift 0 for
/// ordinary trips, one instance per departure for frequency templates).
#[derive(Clone, Copy, Debug)]
pub struct Inst {
    pub src: u32,
    pub shift: i32,
    /// Real headway in seconds for frequency instances, else 0.
    pub headway: u16,
    pub freq: bool,
}

fn seq_hash(t: &TripTable, trip: u32) -> u64 {
    const K: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut h = (t.line[trip as usize] as u64 + 1).wrapping_mul(K);
    for r in t.rows_of(trip) {
        h = (h.rotate_left(23) ^ (((r.stop as u64) << 8) | r.flags() as u64)).wrapping_mul(K);
    }
    h ^ (h >> 29)
}

/// `a` is nowhere later than `b`.
#[inline]
fn not_after(t: &TripTable, a: &Inst, b: &Inst) -> bool {
    let d = b.shift - a.shift;
    t.rows_of(a.src).iter().zip(t.rows_of(b.src)).all(|(x, y)| x.arr <= y.arr + d && x.dep <= y.dep + d)
}

/// Group instances by (line, stop sequence, pickup/drop-off flags) and split
/// each group into chains in which no trip overtakes another: inside a chain
/// arrival and departure are non-decreasing from trip to trip at every stop.
/// The result is ordered by line, then by first appearance in the feed.
/// Also returns the number of distinct (line, stop sequence, flags) keys.
pub fn build_patterns(t: &TripTable, mut insts: Vec<Inst>) -> (Vec<Vec<Inst>>, usize) {
    if insts.is_empty() {
        return (Vec::new(), 0);
    }
    let hashes: Vec<u64> = (0..t.first.len() as u32).into_par_iter().map(|i| seq_hash(t, i)).collect();
    // Total order on "same pattern key"; the hash only makes the common case cheap.
    let key_cmp = |a: u32, b: u32| -> Ordering {
        if a == b {
            return Ordering::Equal;
        }
        hashes[a as usize]
            .cmp(&hashes[b as usize])
            .then_with(|| t.line[a as usize].cmp(&t.line[b as usize]))
            .then_with(|| t.len[a as usize].cmp(&t.len[b as usize]))
            .then_with(|| {
                for (x, y) in t.rows_of(a).iter().zip(t.rows_of(b)) {
                    let o = x.stop.cmp(&y.stop).then(x.flags().cmp(&y.flags()));
                    if o != Ordering::Equal {
                        return o;
                    }
                }
                Ordering::Equal
            })
    };
    let time_cmp = |x: &Inst, y: &Inst| -> Ordering {
        let (ra, rb) = (t.rows_of(x.src), t.rows_of(y.src));
        let d = y.shift - x.shift;
        ra[0].dep.cmp(&(rb[0].dep + d)).then_with(|| {
            for (p, q) in ra.iter().zip(rb) {
                let o = p.arr.cmp(&(q.arr + d)).then(p.dep.cmp(&(q.dep + d)));
                if o != Ordering::Equal {
                    return o;
                }
            }
            Ordering::Equal
        })
    };
    insts.par_sort_unstable_by(|x, y| {
        key_cmp(x.src, y.src)
            .then_with(|| time_cmp(x, y))
            .then_with(|| x.src.cmp(&y.src))
            .then_with(|| x.shift.cmp(&y.shift))
    });

    let mut bounds = vec![0usize];
    for i in 1..insts.len() {
        if key_cmp(insts[i - 1].src, insts[i].src) != Ordering::Equal {
            bounds.push(i);
        }
    }
    bounds.push(insts.len());

    let mut groups: Vec<(u32, u32, Vec<Vec<Inst>>)> = bounds
        .par_windows(2)
        .map(|w| {
            let g = &insts[w[0]..w[1]];
            let mut chains: Vec<Vec<Inst>> = Vec::new();
            'next: for inst in g {
                for c in chains.iter_mut() {
                    if not_after(t, c.last().expect("chains are never empty"), inst) {
                        c.push(*inst);
                        continue 'next;
                    }
                }
                chains.push(vec![*inst]);
            }
            let min_src = g.iter().map(|i| i.src).min().unwrap_or(0);
            (t.line[g[0].src as usize], min_src, chains)
        })
        .collect();
    groups.par_sort_unstable_by_key(|g| (g.0, g.1));
    let n_keys = groups.len();
    (groups.into_iter().flat_map(|g| g.2).collect(), n_keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(trip: u32, stop: u32, seq: u32, arr: i32, dep: i32) -> StRow {
        StRow { trip, stop, arr, dep, seqf: seq << 8 }
    }

    #[test]
    fn grouping_and_resort() {
        let mut rows = vec![row(1, 5, 1, 10, 10), row(1, 6, 2, 20, 20), row(0, 5, 1, 0, 0), row(0, 6, 4, 5, 5)];
        let g = group_rows(&mut rows, 3);
        assert!(!g.resorted);
        assert_eq!((g.first.clone(), g.len.clone()), (vec![2, 0, NONE], vec![2, 2, 0]));

        // Interleaved trips, descending sequence and a duplicate.
        let mut rows =
            vec![row(1, 6, 2, 20, 20), row(0, 5, 1, 0, 0), row(1, 5, 1, 10, 10), row(0, 6, 4, 5, 5), row(0, 7, 4, 6, 6)];
        let g = group_rows(&mut rows, 2);
        assert!(g.resorted);
        assert_eq!(g.duplicate_seq, 1);
        assert_eq!((g.first, g.len), (vec![0, 2], vec![2, 2]));
        assert_eq!(rows.iter().map(|r| (r.trip, r.stop)).collect::<Vec<_>>(), vec![(0, 5), (0, 6), (1, 5), (1, 6)]);
    }

    #[test]
    fn repair_times() {
        let m = MISSING;
        let mut rows = vec![
            row(0, 1, 1, m, 100),
            row(0, 2, 2, m, m),
            row(0, 3, 3, m, m),
            row(0, 4, 4, 400, m),
            row(0, 5, 5, 390, 380),
            row(1, 1, 1, m, m),
            row(1, 2, 2, m, m),
        ];
        let first = vec![0, 5];
        let mut len = vec![5, 2];
        let st = normalise(&mut rows, &first, &mut len);
        assert_eq!(rows[..5].iter().map(|r| (r.arr, r.dep)).collect::<Vec<_>>(), vec![(100, 100), (200, 200), (300, 300), (400, 400), (400, 400)]);
        assert_eq!((st.interpolated, st.clamped, st.trips_no_times), (4, 1, 1));
        assert_eq!(len, vec![5, 0]);
    }

    #[test]
    fn overtaking_splits() {
        // Trips 0..3 on stops 1→2→3; trip 2 leaves after trip 1 but arrives earlier.
        // Trip 4 has other flags, trip 5 another line.
        let mut rows = Vec::new();
        let mut add = |trip: u32, t: [i32; 3], flag: u32| {
            for (i, &x) in t.iter().enumerate() {
                rows.push(StRow { trip, stop: i as u32 + 1, arr: x, dep: x, seqf: ((i as u32 + 1) << 8) | if i == 1 { flag } else { 0 } });
            }
        };
        add(0, [100, 200, 300], 0);
        add(1, [150, 400, 500], 0);
        add(2, [160, 250, 350], 0);
        add(3, [400, 500, 600], 0);
        add(4, [100, 200, 300], 1);
        add(5, [100, 200, 300], 0);
        let first: Vec<u32> = (0..6).map(|i| i * 3).collect();
        let len = vec![3u32; 6];
        let line = vec![0, 0, 0, 0, 0, 1];
        let t = TripTable { rows: &rows, first: &first, len: &len, line: &line };
        let insts = (0..6).rev().map(|src| Inst { src, shift: 0, headway: 0, freq: false }).collect();
        let (pats, keys) = build_patterns(&t, insts);
        assert_eq!(keys, 3);
        let got: Vec<Vec<u32>> = pats.iter().map(|c| c.iter().map(|i| i.src).collect()).collect();
        assert_eq!(got, vec![vec![0, 1, 3], vec![2], vec![4], vec![5]]);

        // Shifted copies of one template stay in one chain, in time order.
        let insts = vec![
            Inst { src: 0, shift: 600, headway: 60, freq: true },
            Inst { src: 0, shift: 0, headway: 60, freq: true },
            Inst { src: 0, shift: 300, headway: 60, freq: true },
        ];
        let (pats, _) = build_patterns(&t, insts);
        assert_eq!(pats.len(), 1);
        assert_eq!(pats[0].iter().map(|i| i.shift).collect::<Vec<_>>(), vec![0, 300, 600]);
    }
}
