//! The official building address register (swisstopo "Amtliches
//! Gebäudeadressverzeichnis", `amtliches-gebaeudeadressverzeichnis_ch_2056.csv.zip`,
//! about 140 MB): one point per building address, placed by the register's
//! rules at the building's entrance. Used for the doors of buildings that
//! OpenStreetMap maps without one (most buildings in Zürich, Geneva and
//! Lausanne).

use anyhow::{bail, Context, Result};
use kante_core::geo::{BBox, LatLon};
use std::io::{BufRead, BufReader};
use std::path::Path;

/// One real (not planned or retired) address.
#[derive(Clone, Debug)]
pub struct Address {
    pub pos: LatLon,
    /// "Bundesgasse 3"
    pub label: String,
}

/// Swiss LV95 (E, N) → WGS84, swisstopo's approximate formulas (about 1 m).
pub fn lv95_to_wgs84(e: f64, n: f64) -> LatLon {
    let (y, x) = ((e - 2_600_000.0) / 1e6, (n - 1_200_000.0) / 1e6);
    let lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
    let lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.0140 * x * x * x;
    LatLon::from_deg(lat * 100.0 / 36.0, lon * 100.0 / 36.0)
}

/// The real addresses of the register (zipped CSV as published), within `bbox` if given.
pub fn read(zip_path: &Path, bbox: Option<&BBox>) -> Result<Vec<Address>> {
    let f = std::fs::File::open(zip_path).with_context(|| format!("open {}", zip_path.display()))?;
    let mut z = zip::ZipArchive::new(f).with_context(|| format!("{} is not a zip file", zip_path.display()))?;
    let name = (0..z.len()).filter_map(|i| z.by_index(i).ok().and_then(|e| e.name().ok().map(|n| n.to_string()))).find(|n| n.ends_with(".csv")).context("no .csv in the register's zip")?;
    let r = BufReader::with_capacity(1 << 20, z.by_name(&name)?);
    let mut lines = r.lines();
    let head = lines.next().context("empty register")??;
    let head = head.trim_start_matches('\u{feff}');
    let cols: Vec<&str> = head.split(';').collect();
    let col = |c: &str| cols.iter().position(|x| *x == c).with_context(|| format!("register: no column {c}"));
    let (status, number, east, north, street) = (col("ADR_STATUS")?, col("ADR_NUMBER")?, col("ADR_EASTING")?, col("ADR_NORTHING")?, col("STN_LABEL")?);
    let mut out = Vec::new();
    let mut valid = 0usize;
    for line in lines {
        let line = line?;
        let r: Vec<&str> = line.split(';').collect();
        // a few rows have ";" inside a field: skipped
        if r.len() != cols.len() || r[status] != "real" || r[number].is_empty() {
            continue;
        }
        let (Ok(e), Ok(n)) = (r[east].trim().parse::<f64>(), r[north].trim().parse::<f64>()) else { continue };
        if !(LV95_E.contains(&e) && LV95_N.contains(&n)) {
            continue;
        }
        valid += 1;
        let pos = lv95_to_wgs84(e, n);
        if bbox.is_some_and(|b| !b.contains(&pos)) {
            continue;
        }
        out.push(Address { pos, label: format!("{} {}", r[street], r[number]).trim().to_string() });
    }
    check_count(zip_path, valid)?;
    Ok(out)
}

/// Switzerland in LV95 metres.
const LV95_E: std::ops::RangeInclusive<f64> = 2_480_000.0..=2_840_000.0;
const LV95_N: std::ops::RangeInclusive<f64> = 1_070_000.0..=1_300_000.0;
/// The register has about 3.2 million real addresses; one with fewer than this is not the register.
pub const MIN_ADDRESSES: usize = 1_000_000;

fn check_count(zip_path: &Path, valid: usize) -> Result<()> {
    if valid < MIN_ADDRESSES {
        bail!("{}: only {valid} real addresses with coordinates in Switzerland; the file looks cut short or broken", zip_path.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_register_with_the_right_header_but_no_usable_rows_is_refused() {
        let dir = std::env::temp_dir().join(format!("kante-register-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("adr.csv.zip");
        for body in ["", "real;3;x;y;Bahnhofstrasse\n", "real;3;2600000;1200000;Bahnhofstrasse\n"] {
            let f = std::fs::File::create(&path).unwrap();
            let mut z = zip::ZipWriter::new(f);
            z.start_file("adr.csv", zip::write::SimpleFileOptions::default()).unwrap();
            use std::io::Write;
            z.write_all(format!("ADR_STATUS;ADR_NUMBER;ADR_EASTING;ADR_NORTHING;STN_LABEL\n{body}").as_bytes()).unwrap();
            z.finish().unwrap();
            // nationally and for a box alike
            assert!(read(&path, None).is_err(), "{body:?}");
            assert!(read(&path, Some(&BBox::from_deg(46.0, 7.0, 47.0, 8.0))).is_err(), "{body:?}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn lv95() {
        // Grellingerstrasse 31, Basel (the register's first row): the same as tools' Python formula gave
        let p = lv95_to_wgs84(2_612_677.919, 1_266_615.227);
        assert!(p.dist_m(&LatLon::from_deg(47.550133, 7.607052)) < 0.5, "{p:?}");
    }
}
