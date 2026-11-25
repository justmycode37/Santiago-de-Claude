//! How a vehicle moves between two stops: it accelerates away from the stop, runs at a cruising speed, and brakes into
//! the next one, at the service rates of its kind of vehicle. Used to make a run's times physically possible (a hop
//! the timetable gives no time for, its times being whole minutes, takes what the vehicle needs, borrowed from the
//! stops around it) and to place a vehicle along its way (a vehicle that has just left a stop is near it, not a
//! steady share of the way on).
//!
//! The rates are service figures from manufacturers' datasheets and studies (not the vehicles' utmost): trams
//! accelerate at 1.2–1.3 m/s² and brake at 1.1–1.3 m/s² (Siemens Combino Plus, Avenio; Bombardier Flexity Swift,
//! Outlook), city buses at about 1 m/s² (passenger comfort; 2 m/s² is where standing passengers lose balance),
//! regional trains at 0.95–1.3 m/s² (Stadler FLIRT, KISS); long-distance trains and the rest are slower. There is no
//! top speed: what limits a hop is how fast the vehicle can speed up and brake; how fast it runs between is what the
//! times say.

use kante_core::Mode;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Motion {
    /// m/s²
    pub accel: f32,
    pub brake: f32,
    /// m/s, the most it runs at between two stops (none: infinite).
    pub vmax: f32,
}

/// The motion of a kind of vehicle; `category` tells long-distance trains (IC, IR, EC, …) from regional ones.
pub fn of(mode: Option<Mode>, category: &str) -> Option<Motion> {
    let long = matches!(category, "IC" | "ICE" | "ICN" | "IR" | "IRE" | "EC" | "EN" | "NJ" | "TGV" | "RJ" | "RJX" | "PE" | "EXT");
    let m = |accel, brake| Motion { accel, brake, vmax: f32::INFINITY };
    Some(match mode? {
        Mode::Tram => m(1.2, 1.2),
        Mode::Bus | Mode::OnDemand => m(1.0, 1.1),
        Mode::Rail if long => m(0.5, 0.6),
        Mode::Rail => m(0.9, 0.8),
        Mode::Metro => m(1.1, 1.1),
        Mode::RackRail => m(0.5, 0.5),
        Mode::Funicular | Mode::Cableway => m(0.5, 0.5),
        Mode::Boat => m(0.2, 0.3),
        Mode::Lift | Mode::Other => return None,
    })
}

impl Motion {
    /// Seconds per (m/s)² of speed spent speeding up and slowing down: a hop at speed v needs v²·c metres for both.
    fn c(&self) -> f32 {
        0.5 / self.accel + 0.5 / self.brake
    }

    /// The least time to go `len` metres from standing to standing (at most at `vmax`).
    pub fn min_time(&self, len: f32) -> f32 {
        let c = self.c();
        if len <= 0.0 {
            0.0
        } else if len >= self.vmax * self.vmax * c {
            len / self.vmax + self.vmax * c
        } else {
            2.0 * (len * c).sqrt()
        }
    }

    /// The cruising speed that covers `len` metres in `t` seconds, standing at both ends; None when `t` is too short.
    pub fn cruise(&self, len: f32, t: f32) -> Option<f32> {
        if len <= 0.0 || t <= 0.0 || t < self.min_time(len) - 0.01 {
            return None;
        }
        let c = self.c();
        let disc = t * t - 4.0 * c * len;
        // t ≥ min_time: the root is at most vmax (and at vmax exactly when t is the least time at vmax)
        Some(((t - disc.max(0.0).sqrt()) / (2.0 * c)).min(self.vmax))
    }

    #[cfg_attr(not(test), allow(dead_code))]
    /// How far (a share of `len`) a vehicle is `tau` seconds into a hop of `len` metres that takes `t` seconds: speeding
    /// up, cruising, slowing down. A share of the time where the time is too short for that.
    pub fn share(&self, len: f32, t: f32, tau: f32) -> f32 {
        let tau = tau.clamp(0.0, t.max(0.0));
        match self.cruise(len, t) {
            Some(v) if v > 0.0 => share_at(self.accel, self.brake, v, len, t, tau),
            _ if t > 0.0 => tau / t,
            _ => 1.0,
        }
    }
}

/// [`Motion::share`] for a cruising speed `v` (what `/api/vehicles` sends as `motion`, so a page moves the vehicle the
/// same way).
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

/// Seconds a hop's time may borrow from each stop beside it: published times are whole minutes.
pub const BORROW_S: i64 = 60;

/// Makes the times of `served` (index, arrival, departure; unix seconds) physically possible for hops overlapping
/// `[from, until]`: a hop shorter than its vehicle needs for its length (`len(k)`: metres of the hop from `served[k]`
/// to `served[k + 1]`) leaves earlier (from its dwell at the stop, up to [`BORROW_S`]; not from a wait longer than
/// that, a timing point it leaves on time from) and arrives later (up to [`BORROW_S`], leaving that stop later too
/// where it must, never past a measured departure). Times measured (`fixed_dep(k)`, `fixed_arr(k)`) stay; times after
/// a moved one keep their order.
pub fn feasible(
    served: &mut [(usize, i64, i64)],
    m: &Motion,
    from: i64,
    until: i64,
    mut len: impl FnMut(usize) -> Option<f32>,
    fixed_dep: impl Fn(usize) -> bool,
    fixed_arr: impl Fn(usize) -> bool,
) {
    for k in 0..served.len().saturating_sub(1) {
        let (dep, arr) = (served[k].2, served[k + 1].1);
        if arr < from || dep > until {
            continue;
        }
        let Some(l) = len(k) else { continue };
        let need = m.min_time(l).ceil() as i64;
        let mut deficit = need - (arr - dep);
        if deficit <= 0 {
            continue;
        }
        let dwell = served[k].2 - served[k].1;
        let room = if fixed_dep(k) || dwell > BORROW_S { 0 } else { dwell.max(0) };
        let x = room.min((deficit + 1) / 2);
        served[k].2 -= x;
        deficit -= x;
        if !fixed_arr(k + 1) {
            // not past a measured departure from that stop (it has left by then)
            let cap = if fixed_dep(k + 1) { (served[k + 1].2 - served[k + 1].1).max(0) } else { BORROW_S };
            let y = deficit.min(BORROW_S).min(cap);
            served[k + 1].1 += y;
            served[k + 1].2 = served[k + 1].2.max(served[k + 1].1);
            deficit -= y;
        }
        let x2 = (room - x).min(deficit.max(0));
        served[k].2 -= x2;
    }
    // a stop left later (an arrival pushed on) pushes on what comes after it, unless measured
    for k in 1..served.len() {
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

    #[test]
    fn a_tram_needs_time_to_speed_up_and_slow_down() {
        let m = of(Some(Mode::Tram), "T").unwrap();
        // 400 m: speeding up for the first half, braking for the second (no top speed): 2·√(400·c), about 37 s
        let t = m.min_time(400.0);
        assert!((t - 2.0 * (400.0f32 * (1.0 / 1.2)).sqrt()).abs() < 0.01 && t > 30.0 && t < 40.0, "{t}");
        assert!((m.min_time(100.0) - 2.0 * (100.0f32 * (1.0 / 1.2)).sqrt()).abs() < 0.01);
        // in 60 s it need not go flat out
        let v = m.cruise(400.0, 60.0).unwrap();
        assert!(v < m.vmax && v > 400.0 / 60.0, "{v}");
        assert!(m.cruise(400.0, 20.0).is_none());
    }

    #[test]
    fn a_hop_too_short_for_the_vehicle_runs_at_an_even_pace_without_jumps() {
        let m = of(Some(Mode::Tram), "T").unwrap();
        // 2 km in 70 s is more than a tram can speed up and brake for: no motion, an even pace
        assert!(m.cruise(2000.0, 70.0).is_none());
        assert!((m.share(2000.0, 70.0, 35.0) - 0.5).abs() < 1e-6);
        // where it can: no jump where speeding up, cruising and braking meet
        for (len, t) in [(2000.0f32, 140.0f32), (400.0, 40.0), (400.0, 120.0), (150.0, 25.0)] {
            let (v, mut last) = (m.cruise(len, t).unwrap(), 0.0);
            for k in 0..=10000 {
                let x = m.share(len, t, t * k as f32 / 10000.0) * len;
                assert!(x - last <= v * t / 10000.0 + 0.05, "{len} m in {t} s: {last} → {x} at step {k}");
                last = x;
            }
        }
    }

    #[test]
    fn it_leaves_a_stop_slowly_and_comes_into_the_next_slowly() {
        let m = of(Some(Mode::Tram), "T").unwrap();
        let (len, t) = (500.0, 60.0);
        assert_eq!(m.share(len, t, 0.0), 0.0);
        assert!((m.share(len, t, t) - 1.0).abs() < 1e-4);
        // 5 s after leaving: 15 m (½·1.2·5²), not a twelfth of the way (42 m)
        assert!((m.share(len, t, 5.0) * len - 15.0).abs() < 0.1, "{}", m.share(len, t, 5.0) * len);
        // half the time: half the way (the same rates both ways)
        assert!((m.share(len, t, 30.0) - 0.5).abs() < 1e-3);
        // never backwards
        let mut last = 0.0;
        for s in 0..=600 {
            let x = m.share(len, t, s as f32 / 10.0);
            assert!(x >= last - 1e-6);
            last = x;
        }
    }

    #[test]
    fn a_hop_of_no_time_borrows_from_the_stops_around_it() {
        let m = of(Some(Mode::Tram), "T").unwrap();
        // stop 0 arrive 0, leave 60; stop 1 arrive 60 (a 400 m hop in no time), leave 60; stop 2 arrive 120
        let mut s = vec![(0, 0, 60), (1, 60, 60), (2, 120, 120)];
        feasible(&mut s, &m, 0, 200, |_| Some(400.0), |_| false, |_| false);
        let need = m.min_time(400.0).ceil() as i64;
        assert_eq!(s[1].1 - s[0].2, need, "{s:?}");
        assert!(s[0].2 >= s[0].1 && s[1].2 >= s[1].1, "never leaves before it came: {s:?}");
        assert!(s[2].1 - s[1].2 >= need, "the hop after still has its time: {s:?}");
        // a measured departure stays; the arrival moves instead
        let mut s = vec![(0, 0, 60), (1, 60, 60), (2, 180, 180)];
        feasible(&mut s, &m, 0, 200, |_| Some(400.0), |k| k == 0, |_| false);
        assert_eq!(s[0].2, 60);
        assert_eq!(s[1].1, 60 + need);
        // the arrival is not pushed past a measured departure from that stop
        let mut s = vec![(0, 0, 60), (1, 60, 65), (2, 180, 180)];
        feasible(&mut s, &m, 0, 200, |_| Some(400.0), |k| k == 0 || k == 1, |_| false);
        assert_eq!(s[1].2, 65, "{s:?}");
        assert!(s[1].1 <= s[1].2, "{s:?}");
        // a timing point (a wait of minutes) is left on time; the arrival moves instead
        let mut s = vec![(0, 0, 300), (1, 300, 300), (2, 600, 600)];
        feasible(&mut s, &m, 0, 700, |_| Some(400.0), |_| false, |_| false);
        assert_eq!(s[0].2, 300, "{s:?}");
        // never out of order, also where the next hop has no time either
        let mut s = vec![(0, 0, 60), (1, 60, 60), (2, 60, 60), (3, 60, 60)];
        feasible(&mut s, &m, 0, 100, |_| Some(400.0), |_| false, |_| false);
        assert!(s.windows(2).all(|w| w[0].2 <= w[1].1) && s.iter().all(|x| x.1 <= x.2), "{s:?}");
        // a hop with time enough is left as it is
        let mut s = vec![(0, 0, 0), (1, 120, 120)];
        feasible(&mut s, &m, 0, 200, |_| Some(400.0), |_| false, |_| false);
        assert_eq!(s, vec![(0, 0, 0), (1, 120, 120)]);
    }
}
