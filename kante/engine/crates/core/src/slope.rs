//! Hills: how a slope changes walking time, and how much a walker minds it.
//!
//! Heights come from a terrain model (`kante-elevation`, swisstopo's swissALTIRegio) and are
//! summarised per edge and direction in an [`EdgeSlope`]: the extra metres of walking time its slopes
//! cost, an effort penalty that only route choice sees, and the metres climbed and descended. Both
//! costs are metres of flat walking, so `time = var_m / speed + fix_s` (see [`crate::walk`]) still
//! holds for every walking speed: a slope adds to `var_m`.
//!
//! # Time ([`slope_time_factor`])
//!
//! Large GPS studies of walkers (Campbell et al. 2022, the median of 1 999 tracks; Wood et al. 2023 on
//! paved ways) and experiments on sidewalks (Aghabayk et al. 2021: no measurable effect at ±6 %) agree
//! that the hiking rules (Tobler, Naismith) overstate how much a short climb slows a walker down:
//! grades under about 5 % barely matter, steep urban climbs (10–15 %) cost 10–25 %, and walkers are
//! fastest on a slight descent. The factor here is 1 from −8 % to +2 % and grows with the square of
//! the grade beyond: +6 % 1.06, +10 % 1.13, +15 % 1.24, +20 % 1.38; −15 % 1.10, −20 % 1.21. It is never
//! below 1 (the slight speed-up on a gentle descent, about 3 %, is left out), so no edge is quicker than
//! the flat and the A* bound (`kante-walk`) stays admissible.
//!
//! # Effort ([`slope_effort`])
//!
//! Walkers avoid climbs far more than the climbs slow them down: in Portland (Broach & Dill 2015) a
//! 10 % climb made a route feel about twice as long, roughly 10 m of flat walking per metre climbed, and
//! the energy a metre costs doubles by +10 % (Minetti et al. 2002). The effort penalty, for route
//! choice only, is zero up to +3 % and convex beyond: per metre *climbed* it is worth about 0.8 m of flat
//! walking at +4 %, 2 m at +6 %, 4 m at +10 % and 6 m at +15 % (on top of the time). Steep descents cost a
//! little (knees, ice): from −8 %, 0.7 m per metre descended at −15 %, 2.3 m at −25 %. Stairs climbed out of
//! doors count [`STAIRS_EFFORT_PER_M`] per metre climbed (their time is [`crate::STAIRS_FACTOR`]'s).
//!
//! A walker's [`HillsPref`] scales the effort: [`HillsPref::Ignore`] ×0 (the quickest way, hills or
//! not: the time still counts them), [`HillsPref::Normal`] ×1, [`HillsPref::Avoid`] ×3. A wheelchair
//! adds [`slope_steep`] for grades over 6 % (SN 640 075's limit for footways), up or down.

use serde::{Deserialize, Serialize};

pub const SLOPES_SCHEMA: &str = "slopes-v1";

/// How much a walker minds hills (route choice only; walking time always counts them).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum HillsPref {
    /// The quickest way, hills or not.
    Ignore,
    /// A flatter way when it costs about a minute at most for a short hill.
    #[default]
    Normal,
    /// A flatter way even when it is a few minutes longer.
    Avoid,
}

impl HillsPref {
    /// Multiplier of [`slope_effort`].
    #[inline]
    pub fn effort_weight(self) -> f32 {
        match self {
            HillsPref::Ignore => 0.0,
            HillsPref::Normal => 1.0,
            HillsPref::Avoid => 3.0,
        }
    }
}

/// Effort penalty per metre climbed on outdoor stairs, in metres of flat walking.
pub const STAIRS_EFFORT_PER_M: f32 = 6.0;

/// Walking time on grade `g` (rise / run, +0.10 = 10 % uphill) as a multiple of the time on the flat.
#[inline]
pub fn slope_time_factor(g: f32) -> f32 {
    if g > 0.02 {
        let x = g - 0.02;
        (1.0 + 1.2 * x + 5.0 * x * x).min(3.0)
    } else if g < -0.08 {
        let x = -g - 0.08;
        (1.0 + x + 6.0 * x * x).min(3.0)
    } else {
        1.0
    }
}

/// Route-choice effort of one metre (horizontal) on grade `g`, in metres of flat walking, for a walker
/// with [`HillsPref::Normal`].
#[inline]
pub fn slope_effort(g: f32) -> f32 {
    if g > 0.03 {
        let x = g - 0.03;
        2.7 * x + 43.0 * x * x
    } else if g < -0.08 {
        let x = -g - 0.08;
        20.0 * x * x
    } else {
        0.0
    }
}

/// Extra route-choice cost of one metre on grade `g` for a wheelchair, up or down, in metres of flat
/// walking: from 6 %, 0.22 at 8 %, 0.56 at 10 %, 1.0 at 12 %, at most 2.
#[inline]
pub fn slope_steep(g: f32) -> f32 {
    let a = g.abs();
    if a > 0.06 {
        let x = a - 0.06;
        (8.0 * x + 150.0 * x * x).min(2.0)
    } else {
        0.0
    }
}

/// One edge's slopes, from its node `a` to `b` (`[0]`) and back (`[1]`), in decimetres.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EdgeSlope {
    /// Metres climbed and descended from `a` to `b` (the other way they swap), ×10.
    pub up_dm: u16,
    pub down_dm: u16,
    /// Extra metres of walking time ([`slope_time_factor`] − 1 over the edge), ×10.
    pub time_dm: [u16; 2],
    /// Route-choice effort at [`HillsPref::Normal`] ([`slope_effort`] over the edge), ×10.
    pub effort_dm: [u16; 2],
    /// Wheelchair steepness ([`slope_steep`] over the edge), ×10.
    pub steep_dm: [u16; 2],
}

impl EdgeSlope {
    /// (time, effort, steep) decimetres travelling from `b` to `a` when `rev`.
    #[inline]
    pub fn dir(&self, rev: bool) -> (u16, u16, u16) {
        let i = rev as usize;
        (self.time_dm[i], self.effort_dm[i], self.steep_dm[i])
    }
    /// (climbed, descended) metres travelling from `b` to `a` when `rev`.
    #[inline]
    pub fn climb(&self, rev: bool) -> (f32, f32) {
        let (u, d) = (self.up_dm as f32 * 0.1, self.down_dm as f32 * 0.1);
        if rev {
            (d, u)
        } else {
            (u, d)
        }
    }
}

/// The slopes of every edge of a walk graph (`slopes.bin`), made by `kante build` from a terrain model.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Slopes {
    /// [`crate::graph_fingerprint`] of the graph the slopes belong to.
    pub graph: u64,
    /// The terrain model they come from: its file name, size and modification time (`kante build` makes the
    /// slopes again from another).
    pub source: String,
    /// One per edge of the graph.
    pub edges: Vec<EdgeSlope>,
}

/// What a set of slopes is, for the caches made from it ([`crate::LinkData::slopes`]): 0 for none.
pub fn slopes_fingerprint(s: &[EdgeSlope]) -> u64 {
    if s.is_empty() {
        return 0;
    }
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut mix = |v: u64| {
        h = (h ^ v).wrapping_mul(0x0000_0100_0000_01b3);
    };
    mix(s.len() as u64);
    for e in s {
        mix(((e.up_dm as u64) << 48) | ((e.down_dm as u64) << 32) | ((e.time_dm[0] as u64) << 16) | e.time_dm[1] as u64);
        mix(((e.effort_dm[0] as u64) << 48) | ((e.effort_dm[1] as u64) << 32) | ((e.steep_dm[0] as u64) << 16) | e.steep_dm[1] as u64);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_is_never_quicker_than_flat() {
        for i in -60..=60 {
            let g = i as f32 / 100.0;
            assert!(slope_time_factor(g) >= 1.0, "{g}");
            assert!(slope_effort(g) >= 0.0 && slope_steep(g) >= 0.0);
        }
        assert_eq!(slope_time_factor(0.0), 1.0);
        assert_eq!(slope_time_factor(-0.05), 1.0);
    }

    #[test]
    fn values_as_documented() {
        let near = |a: f32, b: f32| (a - b).abs() < 0.01;
        assert!(near(slope_time_factor(0.10), 1.128));
        assert!(near(slope_time_factor(0.15), 1.241));
        assert!(near(slope_time_factor(-0.15), 1.099));
        // effort per metre climbed
        let per_climb = |g: f32| slope_effort(g) / g;
        assert!(near(per_climb(0.06), 2.0));
        assert!((per_climb(0.10) - 4.0).abs() < 0.05);
        assert!((per_climb(0.15) - 6.3).abs() < 0.1);
        assert!(near(slope_steep(0.10), 0.56));
        assert_eq!(slope_steep(0.05), 0.0);
    }
}
