//! The atlas registry exports: boarding points, sector points and
//! vehicle-access information, all keyed by the boarding point's SLOID.

use crate::csv::{parse_f64, Table};
use anyhow::{Context, Result};
use kante_core::{LatLon, QuayAccess};
use rustc_hash::FxHashMap;
use std::path::Path;

#[derive(Clone, Debug)]
pub struct BoardingPoint {
    /// `None` when the registry has no coordinate for this edge.
    pub pos: Option<LatLon>,
    /// Customer-facing label; empty when the edge is unsigned.
    pub designation: String,
    /// Degrees, -1 when unknown.
    pub compass: i16,
    /// SLOID of the stop (service point) the edge belongs to.
    pub parent: String,
}

#[derive(Default)]
pub struct Atlas {
    /// `trafficPointElementType = BOARDING_PLATFORM` rows by SLOID.
    pub points: FxHashMap<String, BoardingPoint>,
    /// Sector points (designation, position) by boarding-point SLOID.
    pub sectors: FxHashMap<String, Vec<(String, LatLon)>>,
    pub access: FxHashMap<String, QuayAccess>,
    /// Edges by (stop SLOID, designation): the operational halves of one
    /// track ("5" as `…:3:5` and `…:0:1752`) are registered separately.
    pub same_label: FxHashMap<(String, String), Vec<String>>,
    /// Files that were expected in the directory but not found.
    pub missing: Vec<String>,
}

fn coord(east: &[u8], north: &[u8]) -> Option<LatLon> {
    let (lon, lat) = (parse_f64(east)?, parse_f64(north)?);
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) || (lat == 0.0 && lon == 0.0) {
        return None;
    }
    Some(LatLon::from_deg(lat, lon))
}

fn read_file(dir: &Path, name: &str, missing: &mut Vec<String>) -> Result<Option<Vec<u8>>> {
    let p = dir.join(name);
    if !p.exists() {
        missing.push(name.to_string());
        return Ok(None);
    }
    Ok(Some(std::fs::read(&p).with_context(|| format!("read {}", p.display()))?))
}

pub fn parse_traffic_points(buf: &[u8]) -> Result<FxHashMap<String, BoardingPoint>> {
    let mut t = Table::new("traffic-point.csv", buf, b';')?;
    let c_sloid = t.col("sloid")?;
    let c_des = t.col("designation")?;
    let c_compass = t.col("compassDirection")?;
    let c_east = t.col("wgs84East")?;
    let c_north = t.col("wgs84North")?;
    let c_type = t.col("trafficPointElementType")?;
    let c_parent = t.opt("parentSloidServicePoint");
    let mut out = FxHashMap::default();
    while t.next() {
        if t.get(c_type) != b"BOARDING_PLATFORM" || t.get(c_sloid).is_empty() {
            continue;
        }
        let compass = parse_f64(t.get(c_compass))
            .filter(|v| (0.0..=360.0).contains(v))
            .map(|v| (v.round() as i16) % 360)
            .unwrap_or(-1);
        out.insert(
            t.text(c_sloid),
            BoardingPoint { pos: coord(t.get(c_east), t.get(c_north)), designation: t.text(c_des).trim().to_string(), compass, parent: t.text_opt(c_parent) },
        );
    }
    Ok(out)
}

pub fn parse_sectors(buf: &[u8]) -> Result<FxHashMap<String, Vec<(String, LatLon)>>> {
    let mut t = Table::new("sectors.csv", buf, b';')?;
    let c_tp = t.col("trafficPointSloid")?;
    let c_des = t.col("designation")?;
    let c_east = t.col("wgs84East")?;
    let c_north = t.col("wgs84North")?;
    let c_type = t.opt("type");
    let mut out: FxHashMap<String, Vec<(String, LatLon)>> = FxHashMap::default();
    while t.next() {
        if let Some(c) = c_type {
            if t.get(c) != b"SECTOR" {
                continue;
            }
        }
        let des = t.text(c_des).trim().to_string();
        if let (Some(pos), false) = (coord(t.get(c_east), t.get(c_north)), des.is_empty()) {
            out.entry(t.text(c_tp)).or_default().push((des, pos));
        }
    }
    Ok(out)
}

pub fn parse_access(buf: &[u8]) -> Result<FxHashMap<String, QuayAccess>> {
    let mut t = Table::new("prm-platform.csv", buf, b';')?;
    let c_sloid = t.col("sloid")?;
    let c_va = t.col("vehicleAccess")?;
    let mut out = FxHashMap::default();
    while t.next() {
        let a = match t.get(c_va) {
            b"PLATFORM_ACCESS_WITHOUT_ASSISTANCE" => QuayAccess::Autonomous,
            b"PLATFORM_ACCESS_WITH_ASSISTANCE" => QuayAccess::Assisted,
            b"PLATFORM_ACCESS_WITH_ASSISTANCE_WHEN_NOTIFIED" => QuayAccess::AssistedOnNotice,
            b"PLATFORM_NOT_WHEELCHAIR_ACCESSIBLE" => QuayAccess::NotAccessible,
            _ => continue,
        };
        out.insert(t.text(c_sloid), a);
    }
    Ok(out)
}

pub fn load(dir: Option<&Path>) -> Result<Atlas> {
    let mut a = Atlas::default();
    let Some(dir) = dir else { return Ok(a) };
    if let Some(buf) = read_file(dir, "traffic-point.csv", &mut a.missing)? {
        a.points = parse_traffic_points(&buf)?;
        a.index_labels();
    }
    if let Some(buf) = read_file(dir, "sectors.csv", &mut a.missing)? {
        a.sectors = parse_sectors(&buf)?;
    }
    if let Some(buf) = read_file(dir, "prm-platform.csv", &mut a.missing)? {
        a.access = parse_access(&buf)?;
    }
    Ok(a)
}

/// Split a rail platform code into track and sectors: `"5A-C"` → `("5", "A-C")`,
/// `"33AB"` → `("33", "AB")`, `"1 E-G"` → `("1", "E-G")`. Anything that is not
/// digits followed by upper-case sector letters is not split (`"K1"`, `"1a"`,
/// `"41/42"`, `"3 Süd"`).
pub fn split_track_sectors(code: &str) -> Option<(&str, &str)> {
    let digits = code.bytes().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 || digits == code.len() {
        return None;
    }
    let sect = code[digits..].trim_start_matches(' ');
    let b = sect.as_bytes();
    if b.is_empty() || !b[0].is_ascii_uppercase() || !b[b.len() - 1].is_ascii_uppercase() {
        return None;
    }
    for (i, &c) in b.iter().enumerate() {
        let ok = c.is_ascii_uppercase() || (c == b'-' && b[i - 1].is_ascii_uppercase());
        if !ok {
            return None;
        }
    }
    Some((&code[..digits], sect))
}

/// Sector letters named by a sector expression: `"A-C"` → A, B, C; `"AB"` → A, B.
pub fn sector_letters(sectors: &str) -> Vec<char> {
    let b = sectors.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c.is_ascii_uppercase() {
            if i + 2 < b.len() && b[i + 1] == b'-' && b[i + 2].is_ascii_uppercase() && b[i + 2] >= c {
                for x in c..=b[i + 2] {
                    out.push(x as char);
                }
                i += 3;
                continue;
            }
            out.push(c as char);
        }
        i += 1;
    }
    out.sort_unstable();
    out.dedup();
    out
}

impl Atlas {
    pub fn index_labels(&mut self) {
        self.same_label.clear();
        let mut sloids: Vec<&String> = self.points.keys().collect();
        sloids.sort_unstable();
        for sloid in sloids {
            let p = &self.points[sloid];
            if !p.parent.is_empty() && !p.designation.is_empty() {
                self.same_label.entry((p.parent.clone(), p.designation.clone())).or_default().push(sloid.clone());
            }
        }
    }

    /// Where to stand for `sectors` of the track that edge `sloid` belongs
    /// to: the centroid of the named sector points. The registry hangs the
    /// sector points of a track on one of its edges, so the other edges of
    /// the same stop with the same designation are searched as well; the
    /// flag tells whether the points came from such a sibling only.
    pub fn sector_centroid(&self, sloid: &str, sectors: &str) -> Option<(LatLon, bool)> {
        let letters = sector_letters(sectors);
        let own = self.centroid_of(std::iter::once(sloid), &letters);
        let siblings = self
            .points
            .get(sloid)
            .filter(|p| !p.parent.is_empty() && !p.designation.is_empty())
            .and_then(|p| self.same_label.get(&(p.parent.clone(), p.designation.clone())));
        match siblings {
            Some(s) if s.len() > 1 => self.centroid_of(s.iter().map(|x| x.as_str()), &letters).map(|p| (p, own.is_none())),
            _ => own.map(|p| (p, false)),
        }
    }

    /// Mean over the named letters of the mean position of each letter's points.
    fn centroid_of<'a>(&self, sloids: impl Iterator<Item = &'a str> + Clone, letters: &[char]) -> Option<LatLon> {
        let (mut lat, mut lon, mut n) = (0f64, 0f64, 0f64);
        for &l in letters {
            let mut buf = [0u8; 4];
            let name: &str = l.encode_utf8(&mut buf);
            let (mut la, mut lo, mut k) = (0i64, 0i64, 0i64);
            for sloid in sloids.clone() {
                for (des, p) in self.sectors.get(sloid).map(|v| v.as_slice()).unwrap_or(&[]) {
                    if des == name {
                        la += p.lat as i64;
                        lo += p.lon as i64;
                        k += 1;
                    }
                }
            }
            if k > 0 {
                lat += la as f64 / k as f64;
                lon += lo as f64 / k as f64;
                n += 1.0;
            }
        }
        if n == 0.0 {
            return None;
        }
        Some(LatLon { lat: (lat / n).round() as i32, lon: (lon / n).round() as i32 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_codes() {
        assert_eq!(split_track_sectors("5A-C"), Some(("5", "A-C")));
        assert_eq!(split_track_sectors("33AB"), Some(("33", "AB")));
        assert_eq!(split_track_sectors("1 E-G"), Some(("1", "E-G")));
        assert_eq!(split_track_sectors("2A"), Some(("2", "A")));
        for c in ["K1", "A", "12", "1a", "41/42", "3 Süd", "5-A", "5A-", "", "Kante C", "45/5"] {
            assert_eq!(split_track_sectors(c), None, "{c}");
        }
        assert_eq!(sector_letters("A-C"), vec!['A', 'B', 'C']);
        assert_eq!(sector_letters("AB"), vec!['A', 'B']);
        assert_eq!(sector_letters("E-H"), vec!['E', 'F', 'G', 'H']);
        assert_eq!(sector_letters("A-BD"), vec!['A', 'B', 'D']);
    }

    #[test]
    fn parse_files() {
        let tp = "\u{feff}sloid;designation;designationOperational;compassDirection;trafficPointElementType;wgs84East;wgs84North;parentSloidServicePoint\n\
                  ch:1:sloid:1:0:5;A;05;70.0;BOARDING_PLATFORM;7.440602;46.947568;ch:1:sloid:1\n\
                  ch:1:sloid:1:0:6;;06;;BOARDING_PLATFORM;;;ch:1:sloid:1\n\
                  ch:1:sloid:1:9;X;;;BOARDING_AREA;7.0;46.0;ch:1:sloid:1\n";
        let m = parse_traffic_points(tp.as_bytes()).unwrap();
        assert_eq!(m.len(), 2);
        let a = &m["ch:1:sloid:1:0:5"];
        assert_eq!((a.designation.as_str(), a.compass), ("A", 70));
        assert_eq!(a.pos, Some(LatLon::from_deg(46.947568, 7.440602)));
        assert!(m["ch:1:sloid:1:0:6"].pos.is_none());
        assert_eq!(m["ch:1:sloid:1:0:6"].compass, -1);

        let sec = "sloid;type;trafficPointSloid;designation;wgs84East;wgs84North\n\
                   s1;SECTOR;tp;A;7.0;46.0\ns2;SECTOR;tp;B;7.2;46.2\ns3;SECTOR;tp;C;7.4;46.4\n";
        let mut a = Atlas::default();
        a.sectors = parse_sectors(sec.as_bytes()).unwrap();
        assert_eq!(a.sector_centroid("tp", "A-C"), Some((LatLon::from_deg(46.2, 7.2), false)));
        assert_eq!(a.sector_centroid("tp", "AB"), Some((LatLon::from_deg(46.1, 7.1), false)));
        assert_eq!(a.sector_centroid("tp", "D"), None);
        assert_eq!(a.sector_centroid("other", "A"), None);

        // Two registry edges for track 5 of one stop; the sector points hang on the first.
        let bp = |des: &str, parent: &str| BoardingPoint { pos: None, designation: des.into(), compass: -1, parent: parent.into() };
        a.points.insert("tp".into(), bp("5", "st"));
        a.points.insert("tp2".into(), bp("5", "st"));
        a.points.insert("tp3".into(), bp("6", "st"));
        a.points.insert("tp4".into(), bp("5", "other"));
        a.index_labels();
        assert_eq!(a.sector_centroid("tp2", "BC"), Some((LatLon::from_deg(46.3, 7.3), true)));
        assert_eq!(a.sector_centroid("tp", "BC"), Some((LatLon::from_deg(46.3, 7.3), false)));
        assert_eq!(a.sector_centroid("tp3", "BC"), None);
        assert_eq!(a.sector_centroid("tp4", "BC"), None);

        let prm = "sloid;vehicleAccess\na;PLATFORM_ACCESS_WITHOUT_ASSISTANCE\nb;TO_BE_COMPLETED\nc;\nd;PLATFORM_NOT_WHEELCHAIR_ACCESSIBLE\n";
        let m = parse_access(prm.as_bytes()).unwrap();
        assert_eq!(m.len(), 2);
        assert_eq!(m["a"], QuayAccess::Autonomous);
        assert_eq!(m["d"], QuayAccess::NotAccessible);
        assert!(parse_access(b"sloid;other\n").is_err());
    }
}
