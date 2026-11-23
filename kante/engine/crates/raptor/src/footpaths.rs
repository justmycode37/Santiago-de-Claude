//! Straight-line footpaths: the fallback when no walking network is linked.

use kante_core::{Footpaths, StopIdx, Timetable};
use rayon::prelude::*;
use rustc_hash::FxHashMap;

/// Footpaths between all pairs of stops closer than `max_m` as the crow
/// flies: `var_m = distance × detour`, `fix_s = 0`. Symmetric, no self-entries,
/// each stop's list sorted by target.
pub fn crowfly_footpaths(tt: &Timetable, max_m: f32, detour: f32) -> Footpaths {
    let n = tt.stops.len();
    // `xy` distorts east–west distances by up to 2 %; slightly larger cells
    // guarantee that every pair within `max_m` is in neighbouring cells.
    let cell = max_m.max(1.0) * 1.03;
    let key = |s: usize| {
        let (x, y) = tt.stops[s].pos.xy();
        ((x / cell).floor() as i32, (y / cell).floor() as i32)
    };
    let mut grid: FxHashMap<(i32, i32), Vec<StopIdx>> = FxHashMap::default();
    for s in 0..n {
        if !tt.stops[s].pos.is_none() {
            grid.entry(key(s)).or_default().push(s as StopIdx);
        }
    }
    let reach = 1;
    let lists: Vec<Vec<(StopIdx, u16)>> = (0..n)
        .into_par_iter()
        .map(|s| {
            let mut out = Vec::new();
            let p = tt.stops[s].pos;
            if p.is_none() {
                return out;
            }
            let (cx, cy) = key(s);
            for dx in -reach..=reach {
                for dy in -reach..=reach {
                    let Some(c) = grid.get(&(cx + dx, cy + dy)) else { continue };
                    for &o in c {
                        if o as usize == s {
                            continue;
                        }
                        let d = p.dist_m(&tt.stops[o as usize].pos);
                        if d < max_m {
                            out.push((o, (d * detour).round().min(65_535.0) as u16));
                        }
                    }
                }
            }
            out.sort_unstable();
            out
        })
        .collect();
    let total: usize = lists.iter().map(Vec::len).sum();
    let mut fp = Footpaths { off: Vec::with_capacity(n + 1), to: Vec::with_capacity(total), var_m: Vec::with_capacity(total), fix_s: vec![0; total], ..Default::default() };
    fp.off.push(0);
    for l in &lists {
        for &(to, v) in l {
            fp.to.push(to);
            fp.var_m.push(v);
        }
        fp.off.push(fp.to.len() as u32);
    }
    fp
}
