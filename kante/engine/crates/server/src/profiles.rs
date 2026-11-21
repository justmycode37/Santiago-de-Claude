//! Learned travel and dwell times per pair of stops, from the measured times of
//! the past weeks (the open "Ist-Daten" archive; built by
//! `livemap/measure/ist_daten_hops.py --write-profile`).
//!
//! Once a vehicle's departure from a stop has been measured, the time to the
//! next stop is far better predicted by what that hop usually takes than by
//! the timetable (whole minutes, often 0 s for short bus hops): on 4.5 M test
//! hops the mean error of the arrival fell from 33.5 s to 10.6 s
//! (`livemap/measure/IST-DATEN.md`). The same holds for how long buses and trams
//! stand at a stop.
//!
//! Files: `<data>/profiles/hop.csv.gz` and `<data>/profiles/dwell.csv.gz`, rows
//! `a,b,daytype,hour,n,median_s` with `a`, `b` stop numbers (UIC, or UIC and two
//! more digits; dwell: the stop and
//! the next one). Only the all-day rows (`*,*`) are used. Missing files: the
//! timetable is used. A changed file is picked up within ten minutes.

use crate::state::App;
use kante_core::StationIdx;
use parking_lot::RwLock;
use rustc_hash::FxHashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::Arc;
use std::time::SystemTime;

/// Fewer samples than this: not used.
const MIN_SAMPLES: u32 = 5;

#[derive(Default)]
pub struct Profiles {
    hop: FxHashMap<(StationIdx, StationIdx), u16>,
    dwell: FxHashMap<(StationIdx, StationIdx), u16>,
    stamp: Option<(SystemTime, SystemTime)>,
}

impl Profiles {
    /// Usual travel time from station `a` to the next stop `b`, seconds.
    pub fn hop(&self, a: StationIdx, b: StationIdx) -> Option<i64> {
        self.hop.get(&(a, b)).map(|&s| s as i64)
    }
    /// Usual time standing at `a` before going on to `b`, seconds.
    pub fn dwell(&self, a: StationIdx, b: StationIdx) -> Option<i64> {
        self.dwell.get(&(a, b)).map(|&s| s as i64)
    }
    pub fn len(&self) -> (usize, usize) {
        (self.hop.len(), self.dwell.len())
    }
}

fn read(path: &Path, uic: &FxHashMap<u32, StationIdx>) -> std::io::Result<FxHashMap<(StationIdx, StationIdx), u16>> {
    let file = std::fs::File::open(path)?;
    let r = BufReader::new(flate2::read::MultiGzDecoder::new(file));
    let mut out: FxHashMap<(StationIdx, StationIdx), u16> = FxHashMap::default();
    let mut samples: FxHashMap<(StationIdx, StationIdx), u32> = FxHashMap::default();
    // Most stop numbers in the archive have 9 digits: the 7-digit UIC number of
    // the stop and two more; the station pair is what is looked up.
    let station = |n: u32| uic.get(&if n >= 100_000_000 { n / 100 } else { n }).copied();
    for line in r.lines().skip(1) {
        let line = line?;
        let f: Vec<&str> = line.split(',').collect();
        if f.len() < 6 || f[2] != "*" || f[3] != "*" {
            continue;
        }
        let (Ok(a), Ok(b), Ok(n), Ok(s)) = (f[0].parse::<u32>(), f[1].parse::<u32>(), f[4].parse::<u32>(), f[5].parse::<f64>()) else { continue };
        if n < MIN_SAMPLES || !(0.0..7200.0).contains(&s) {
            continue;
        }
        if let (Some(sa), Some(sb)) = (station(a), station(b)) {
            // Several rows can name the same pair of stations: keep the best-sampled.
            if samples.get(&(sa, sb)).is_none_or(|&m| n > m) {
                samples.insert((sa, sb), n);
                out.insert((sa, sb), s.round() as u16);
            }
        }
    }
    Ok(out)
}

/// UIC number of every station whose id carries one (`…sloid:7000` → 8507000).
fn uic_map(app: &App) -> FxHashMap<u32, StationIdx> {
    let mut m = FxHashMap::default();
    for (i, s) in app.tt.stations.iter().enumerate() {
        let id = s.gtfs_id.as_str();
        let n = if let Some(p) = id.rfind("sloid:") {
            id[p + 6..].split(':').next().and_then(|x| x.parse::<u32>().ok()).filter(|&n| n < 100_000).map(|n| 8_500_000 + n)
        } else {
            id.trim_start_matches("Parent").split(':').next().and_then(|x| x.parse::<u32>().ok()).filter(|&n| n >= 1_000_000)
        };
        if let Some(n) = n {
            m.insert(n, i as StationIdx);
        }
    }
    m
}

fn mtime(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

/// Load the profiles now, and again whenever the files change.
pub fn start(app: Arc<App>) {
    let dir = app.data_dir.join("profiles");
    let (hp, dp) = (dir.join("hop.csv.gz"), dir.join("dwell.csv.gz"));
    std::thread::Builder::new()
        .name("profiles".into())
        .spawn(move || {
            let mut uic: Option<FxHashMap<u32, StationIdx>> = None;
            loop {
                if let (Some(h), Some(d)) = (mtime(&hp), mtime(&dp)) {
                    if app.profiles.read().stamp != Some((h, d)) {
                        let uic = uic.get_or_insert_with(|| uic_map(&app));
                        match (read(&hp, uic), read(&dp, uic)) {
                            (Ok(hop), Ok(dwell)) => {
                                eprintln!("profiles: {} hops, {} dwells", hop.len(), dwell.len());
                                *app.profiles.write() = Profiles { hop, dwell, stamp: Some((h, d)) };
                            }
                            (Err(e), _) | (_, Err(e)) => {
                                eprintln!("profiles: cannot read {}: {e}", dir.display());
                                app.profiles.write().stamp = Some((h, d));
                            }
                        }
                    }
                }
                std::thread::sleep(std::time::Duration::from_secs(600));
            }
        })
        .expect("spawn profiles thread");
}

pub type Shared = RwLock<Profiles>;
