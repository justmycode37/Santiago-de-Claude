//! How a vehicle moves between two stops: it stands at every stop it serves for a moment at least, speeds up away
//! from it, runs at a reasonable speed and slows down into the next one, standing there when it arrives. Used to place
//! a vehicle along its way (one that has just left a stop is near it, not a steady share of the way on) and to make the
//! times of a run something a vehicle can do: published times are whole minutes, so a hop is often given no time at all
//! and a stop no time to stand.
//!
//! Nothing here limits how hard a vehicle may speed up or brake: where the time a hop has allows it, the vehicle moves
//! at the service rates of its kind (trams 1.2 m/s² both ways, Siemens Combino Plus, Avenio; Bombardier Flexity: 1.2–1.3;
//! city buses about 1 m/s², passenger comfort; regional trains 0.9 / 0.8, Stadler FLIRT, KISS; long-distance trains and
//! the rest slower); where it does not, it speeds up for a quarter of the hop's time and brakes for the last quarter,
//! as hard as that takes. What is limited is how fast it goes: a hop is never made faster than its kind of vehicle
//! runs (`vmax`), and one with more time than it needs does not crawl: the vehicle stands at the stop until it leaves
//! at a reasonable pace (half its usual speed at the least).

use kante_core::Mode;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Motion {
    /// m/s², the service rates.
    pub accel: f32,
    pub brake: f32,
    /// m/s: its usual speed between stops, and the fastest it runs.
    pub cruise: f32,
    pub vmax: f32,
    /// Seconds it stands at a stop at the least.
    pub dwell: i64,
}

/// The motion of a kind of vehicle; `category` tells long-distance trains (IC, IR, EC, …) from regional ones.
pub fn of(mode: Option<Mode>, category: &str) -> Option<Motion> {
    let long = matches!(category, "IC" | "ICE" | "ICN" | "IR" | "IRE" | "EC" | "EN" | "NJ" | "TGV" | "RJ" | "RJX" | "PE" | "EXT");
    let m = |accel, brake, cruise, vmax, dwell| Motion { accel, brake, cruise, vmax, dwell };
    Some(match mode? {
        Mode::Tram => m(1.2, 1.2, 9.0, 19.5, 15),
        Mode::Bus | Mode::OnDemand => m(1.0, 1.1, 9.0, 22.0, 12),
        Mode::Rail if long => m(0.5, 0.6, 30.0, 55.0, 45),
        Mode::Rail => m(0.9, 0.8, 18.0, 44.0, 25),
        Mode::Metro => m(1.1, 1.1, 12.0, 22.0, 20),
        Mode::RackRail => m(0.5, 0.5, 7.0, 20.0, 25),
        Mode::Funicular | Mode::Cableway => m(0.5, 0.5, 5.0, 12.0, 20),
        Mode::Boat => m(0.2, 0.3, 7.0, 15.0, 45),
        Mode::Lift | Mode::Other => return None,
    })
}

impl Motion {
    /// Seconds per (m/s)² of speed spent speeding up and slowing down at the service rates: a hop at speed v needs
    /// v²·c metres for both.
    fn c(&self) -> f32 {
        0.5 / self.accel + 0.5 / self.brake
    }

    /// The cruising speed that covers `len` metres in `t` seconds at the service rates, standing at both ends; None
    /// when `t` is too short for those rates.
    pub fn cruise(&self, len: f32, t: f32) -> Option<f32> {
        if len <= 0.0 || t <= 0.0 {
            return None;
        }
        let c = self.c();
        let disc = t * t - 4.0 * c * len;
        if disc < -0.01 {
            return None;
        }
        Some((t - disc.max(0.0).sqrt()) / (2.0 * c))
    }

    /// How it covers `len` metres in `t` seconds, standing at both ends: [accel, brake, cruise] (m/s², m/s², m/s). At
    /// the service rates where `t` allows them, else speeding up for the first quarter of `t` and braking for the last.
    pub fn profile(&self, len: f32, t: f32) -> Option<[f32; 3]> {
        if len <= 0.0 || t <= 0.0 {
            return None;
        }
        match self.cruise(len, t) {
            Some(v) if v > 0.0 => Some([self.accel, self.brake, v]),
            _ => {
                let v = len / (0.75 * t);
                let a = v / (0.25 * t);
                Some([a, a, v])
            }
        }
    }

    /// The least time for `len` metres: not faster than `vmax` (with a quarter of the time each to speed up and brake).
    fn least(&self, len: f32) -> i64 {
        (len / (0.75 * self.vmax)).ceil() as i64
    }

    /// The time `len` metres take at half its usual speed at the most, at the service rates.
    fn unhurried(&self, len: f32) -> i64 {
        let (v, c) = (0.5 * self.cruise, self.c());
        let t = if len >= v * v * c { len / v + v * c } else { 2.0 * (len * c).sqrt() };
        t.ceil() as i64
    }
}

/// How far (a share of `len`) a vehicle is `tau` seconds into a hop of `len` metres that takes `t` seconds, moving as
/// `[accel, brake, v]` says: speeding up, cruising at `v`, slowing down. What `/api/vehicles` sends as `motion`, so a
/// page moves the vehicle the same way.
pub fn share_at(accel: f32, brake: f32, v: f32, len: f32, t: f32, tau: f32) -> f32 {
    if len <= 0.0 || t <= 0.0 {
        return 1.0;
    }
    let (t1, t3) = (v / accel, v / brake);
    let d = if tau < t1 {
        0.5 * accel * tau * tau
    } else if tau < t - t3 {
        0.5 * v * t1 + v * (tau - t1)
    } else {
        len - 0.5 * brake * (t - tau).powi(2)
    };
    (d / len).clamp(0.0, 1.0)
}

/// Seconds a hop's time may take from the stop after it: published times are whole minutes.
pub const BORROW_S: i64 = 60;

/// Makes the times of `served` (index, arrival, departure; unix seconds) something its vehicle does, for hops
/// overlapping `[from, until]` (`len(k)`: metres of the hop from `served[k]` to `served[k + 1]`):
/// - a hop has the time to be driven no faster than its vehicle runs (`vmax`): from the stop it leaves (its time standing
///   there) and the one it reaches (arriving later, up to [`BORROW_S`]);
/// - it stands at every stop between its first and last for `dwell` at the least: arriving earlier and leaving later,
///   from the hops beside it, as long as those stay no faster than it runs (`vmax`);
/// - a hop with far more time than it needs (a timing point, a long wait written into the hop) is driven at a
///   reasonable pace after standing at the stop it leaves from, not crawled.
///
/// Times measured (`fixed_dep(k)`, `fixed_arr(k)`) stay; the times after a moved one keep their order.
pub fn fit(
    served: &mut [(usize, i64, i64)],
    m: &Motion,
    from: i64,
    until: i64,
    mut len: impl FnMut(usize) -> Option<f32>,
    fixed_dep: impl Fn(usize) -> bool,
    fixed_arr: impl Fn(usize) -> bool,
) {
    let n = served.len();
    if n < 2 {
        return;
    }
    let lens: Vec<Option<f32>> = (0..n - 1)
        .map(|k| {
            let (dep, arr) = (served[k].2, served[k + 1].1);
            if arr < from || dep > until { None } else { len(k) }
        })
        .collect();
    // a hop given less time than its vehicle needs at the fastest it runs (published times are whole minutes: often
    // none at all) leaves earlier, from its time standing at the stop (not from a wait of more than a minute: a timing
    // point it leaves on time from), and arrives later, up to a minute (not past a measured departure)
    for k in 0..n - 1 {
        let Some(l) = lens[k] else { continue };
        let mut deficit = m.least(l) - (served[k + 1].1 - served[k].2);
        if deficit <= 0 {
            continue;
        }
        let dwell = served[k].2 - served[k].1;
        let room = if fixed_dep(k) || dwell > BORROW_S { 0 } else { dwell.max(0) };
        let x = room.min((deficit + 1) / 2);
        served[k].2 -= x;
        deficit -= x;
        if !fixed_arr(k + 1) {
            let cap = if fixed_dep(k + 1) { (served[k + 1].2 - served[k + 1].1).max(0) } else { BORROW_S };
            let y = deficit.min(cap);
            served[k + 1].1 += y;
            served[k + 1].2 = served[k + 1].2.max(served[k + 1].1);
            deficit -= y;
        }
        served[k].2 -= (room - x).min(deficit.max(0));
    }
    // how much hop k can give (keeping no faster than it runs)
    let room = |s: &[(usize, i64, i64)], k: usize| match lens[k] {
        Some(l) => (s[k + 1].1 - s[k].2 - m.least(l)).max(0),
        None => 0,
    };
    for k in 1..n - 1 {
        if lens[k - 1].is_none() && lens[k].is_none() {
            continue;
        }
        let short = m.dwell - (served[k].2 - served[k].1);
        if short <= 0 {
            continue;
        }
        let ra = if fixed_arr(k) { 0 } else { room(served, k - 1) };
        let rd = if fixed_dep(k) { 0 } else { room(served, k) };
        let x = ra.min((short + 1) / 2);
        let y = rd.min(short - x);
        let x = x + (ra - x).min(short - x - y);
        served[k].1 -= x;
        served[k].2 += y;
    }
    for k in 0..n - 1 {
        let Some(l) = lens[k] else { continue };
        if fixed_dep(k) {
            continue;
        }
        let spare = served[k + 1].1 - served[k].2 - m.unhurried(l);
        if spare > 5 {
            served[k].2 += spare;
        }
    }
    // a stop left later (an arrival pushed on) pushes on what comes after it, unless measured
    for k in 1..n {
        if !fixed_arr(k) && served[k].1 < served[k - 1].2 {
            served[k].1 = served[k - 1].2;
        }
        if !fixed_dep(k) && served[k].2 < served[k].1 {
            served[k].2 = served[k].1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tram() -> Motion {
        of(Some(Mode::Tram), "T").unwrap()
    }

    #[test]
    fn every_hop_speeds_up_and_slows_down() {
        let m = tram();
        // at the service rates where there is time: 5 s after leaving, 15 m (½·1.2·5²), not a twelfth of 500 m
        let [a, b, v] = m.profile(500.0, 60.0).unwrap();
        assert_eq!((a, b), (1.2, 1.2));
        assert!((share_at(a, b, v, 500.0, 60.0, 5.0) * 500.0 - 15.0).abs() < 0.1);
        // 2 km in 70 s is more than those rates make: steeper, a quarter of the time each way; never an even pace
        let [a, b, v] = m.profile(2000.0, 70.0).unwrap();
        assert!(a > 1.2 && b > 1.2 && (v - 2000.0 / 52.5).abs() < 0.01, "{a} {b} {v}");
        for (len, t) in [(2000.0f32, 70.0f32), (500.0, 60.0), (150.0, 10.0), (400.0, 600.0)] {
            let [a, b, v] = m.profile(len, t).unwrap();
            assert!(share_at(a, b, v, len, t, 0.0) == 0.0 && (share_at(a, b, v, len, t, t) - 1.0).abs() < 1e-3, "{len} in {t}");
            // standing at both ends: the first and the last second cover little; no step anywhere
            assert!(share_at(a, b, v, len, t, 1.0) * len < 0.6 * a.max(1.0) + 0.01, "{len} in {t}: leaves gently");
            let mut last = 0.0;
            for s in 0..=1000 {
                let x = share_at(a, b, v, len, t, t * s as f32 / 1000.0);
                assert!(x >= last - 1e-6 && (x - last) * len <= v * t / 1000.0 + 0.05, "{len} in {t}: step at {s}");
                last = x;
            }
        }
    }

    #[test]
    fn it_stands_at_every_stop_it_serves() {
        let m = tram();
        // whole minutes: arriving and leaving in the same minute at the middle stop, the hops 400 m in 2 min
        let mut s = vec![(0, 0, 0), (1, 120, 120), (2, 240, 240)];
        fit(&mut s, &m, i64::MIN, i64::MAX, |_| Some(400.0), |_| false, |_| false);
        assert!(s[1].2 - s[1].1 >= m.dwell, "{s:?}");
        assert!(s[1].1 < 120 && s[1].2 > 120, "half earlier, half later: {s:?}");
        // a measured arrival stays: it leaves later instead
        let mut s = vec![(0, 0, 0), (1, 120, 120), (2, 240, 240)];
        fit(&mut s, &m, i64::MIN, i64::MAX, |_| Some(400.0), |_| false, |k| k == 1);
        assert_eq!(s[1].1, 120);
        assert!(s[1].2 - s[1].1 >= m.dwell, "{s:?}");
        // a hop with no time to give (already as fast as a tram runs) gives none
        let mut s = vec![(0, 0, 0), (1, 52, 52), (2, 104, 104)];
        fit(&mut s, &m, i64::MIN, i64::MAX, |_| Some(760.0), |_| false, |_| false);
        assert!(s[1].1 >= 52 - 1 && s[1].2 <= 52 + 1, "{s:?}");
        assert!(s.windows(2).all(|w| w[0].2 <= w[1].1) && s.iter().all(|x| x.1 <= x.2), "{s:?}");
    }

    #[test]
    fn a_hop_given_no_time_gets_what_it_needs() {
        let m = tram();
        // stop 0 arrive 0, leave 60; stop 1 arrive 60 (300 m in no time), leave 60; stop 2 arrive 180
        let mut s = vec![(0, 0, 60), (1, 60, 60), (2, 180, 180)];
        fit(&mut s, &m, i64::MIN, i64::MAX, |_| Some(300.0), |_| false, |_| false);
        assert!(s[1].1 - s[0].2 >= m.least(300.0), "{s:?}");
        assert!(s.windows(2).all(|w| w[0].2 <= w[1].1) && s.iter().all(|x| x.1 <= x.2), "{s:?}");
        // a measured departure stays; it arrives later instead
        let mut s = vec![(0, 0, 60), (1, 60, 60), (2, 180, 180)];
        fit(&mut s, &m, i64::MIN, i64::MAX, |_| Some(300.0), |k| k == 0, |_| false);
        assert_eq!(s[0].2, 60);
        assert!(s[1].1 - s[0].2 >= m.least(300.0), "{s:?}");
    }

    #[test]
    fn a_hop_with_time_to_spare_is_not_crawled() {
        let m = tram();
        // 300 m in 5 minutes (a timing point): it stands at the stop, then drives at a reasonable pace
        let mut s = vec![(0, 0, 0), (1, 300, 300)];
        fit(&mut s, &m, i64::MIN, i64::MAX, |_| Some(300.0), |_| false, |_| false);
        let t = (s[1].1 - s[0].2) as f32;
        assert!(t < 100.0 && s[1].1 == 300, "{s:?}");
        assert!(300.0 / t > 0.4 * m.cruise, "{} m/s", 300.0 / t);
        // already left (measured): it keeps its time
        let mut s = vec![(0, 0, 0), (1, 300, 300)];
        fit(&mut s, &m, i64::MIN, i64::MAX, |_| Some(300.0), |k| k == 0, |_| false);
        assert_eq!(s[0].2, 0);
    }
}
