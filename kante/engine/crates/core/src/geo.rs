//! Coordinates and cheap planar geometry.
//!
//! Coordinates are stored as fixed-point WGS84 (degrees × 1e7, like OSM), which
//! keeps centimetre precision — the product is about telling bay A from bay B
//! six metres away, so `f32` degrees are not good enough.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct LatLon {
    /// degrees × 1e7
    pub lat: i32,
    /// degrees × 1e7
    pub lon: i32,
}

/// Metres per degree of latitude.
pub const M_PER_DEG_LAT: f64 = 111_132.0;
/// Reference latitude of the national planar projection used by [`LatLon::xy`].
pub const REF_LAT: f64 = 46.8;
pub const REF_LON: f64 = 8.2;

impl LatLon {
    pub const NONE: LatLon = LatLon { lat: i32::MIN, lon: i32::MIN };

    #[inline]
    pub fn from_deg(lat: f64, lon: f64) -> Self {
        LatLon { lat: (lat * 1e7).round() as i32, lon: (lon * 1e7).round() as i32 }
    }
    #[inline]
    pub fn is_none(&self) -> bool {
        self.lat == i32::MIN
    }
    #[inline]
    pub fn lat_deg(&self) -> f64 {
        self.lat as f64 * 1e-7
    }
    #[inline]
    pub fn lon_deg(&self) -> f64 {
        self.lon as f64 * 1e-7
    }

    /// Distance in metres (equirectangular; error < 0.1 % below 50 km).
    #[inline]
    pub fn dist_m(&self, o: &LatLon) -> f32 {
        let mid = ((self.lat as f64 + o.lat as f64) * 0.5e-7).to_radians();
        let dy = (self.lat as f64 - o.lat as f64) * 1e-7 * M_PER_DEG_LAT;
        let dx = (self.lon as f64 - o.lon as f64) * 1e-7 * M_PER_DEG_LAT * mid.cos();
        (dx * dx + dy * dy).sqrt() as f32
    }

    /// Initial bearing towards `o` in degrees, 0 = north, clockwise, 0..360.
    #[inline]
    pub fn bearing_deg(&self, o: &LatLon) -> f32 {
        let mid = ((self.lat as f64 + o.lat as f64) * 0.5e-7).to_radians();
        let dy = (o.lat as f64 - self.lat as f64) * 1e-7;
        let dx = (o.lon as f64 - self.lon as f64) * 1e-7 * mid.cos();
        let b = dx.atan2(dy).to_degrees();
        (if b < 0.0 { b + 360.0 } else { b }) as f32
    }

    /// Planar metres in one national frame (x east, y north) relative to
    /// (REF_LAT, REF_LON). Scale error east–west is below 2 % anywhere in
    /// Switzerland, so use it for grids and nearest-neighbour search, and
    /// [`LatLon::dist_m`] for reported distances.
    #[inline]
    pub fn xy(&self) -> (f32, f32) {
        let x = (self.lon_deg() - REF_LON) * M_PER_DEG_LAT * REF_LAT.to_radians().cos();
        let y = (self.lat_deg() - REF_LAT) * M_PER_DEG_LAT;
        (x as f32, y as f32)
    }

    /// Inverse of [`LatLon::xy`].
    #[inline]
    pub fn from_xy(x: f32, y: f32) -> LatLon {
        let lat = y as f64 / M_PER_DEG_LAT + REF_LAT;
        let lon = x as f64 / (M_PER_DEG_LAT * REF_LAT.to_radians().cos()) + REF_LON;
        LatLon::from_deg(lat, lon)
    }

    /// Linear interpolation, `t` in 0..=1.
    #[inline]
    pub fn lerp(&self, o: &LatLon, t: f32) -> LatLon {
        LatLon {
            lat: self.lat + ((o.lat - self.lat) as f64 * t as f64).round() as i32,
            lon: self.lon + ((o.lon - self.lon) as f64 * t as f64).round() as i32,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct BBox {
    pub min: LatLon,
    pub max: LatLon,
}

impl BBox {
    pub fn empty() -> Self {
        BBox { min: LatLon { lat: i32::MAX, lon: i32::MAX }, max: LatLon { lat: i32::MIN, lon: i32::MIN } }
    }
    pub fn from_deg(min_lat: f64, min_lon: f64, max_lat: f64, max_lon: f64) -> Self {
        BBox { min: LatLon::from_deg(min_lat, min_lon), max: LatLon::from_deg(max_lat, max_lon) }
    }
    pub fn around(c: LatLon, radius_m: f32) -> Self {
        let dlat = (radius_m as f64 / M_PER_DEG_LAT * 1e7) as i32;
        let dlon = (radius_m as f64 / (M_PER_DEG_LAT * c.lat_deg().to_radians().cos()) * 1e7) as i32;
        BBox { min: LatLon { lat: c.lat - dlat, lon: c.lon - dlon }, max: LatLon { lat: c.lat + dlat, lon: c.lon + dlon } }
    }
    #[inline]
    pub fn contains(&self, p: &LatLon) -> bool {
        p.lat >= self.min.lat && p.lat <= self.max.lat && p.lon >= self.min.lon && p.lon <= self.max.lon
    }
    #[inline]
    pub fn intersects(&self, o: &BBox) -> bool {
        self.min.lat <= o.max.lat && self.max.lat >= o.min.lat && self.min.lon <= o.max.lon && self.max.lon >= o.min.lon
    }
    pub fn extend(&mut self, p: &LatLon) {
        self.min.lat = self.min.lat.min(p.lat);
        self.min.lon = self.min.lon.min(p.lon);
        self.max.lat = self.max.lat.max(p.lat);
        self.max.lon = self.max.lon.max(p.lon);
    }
}

/// Project `p` onto segment `a`–`b` in planar metres. Returns (fraction 0..=1
/// along a→b, distance in metres from `p` to the projected point).
pub fn project_on_segment(p: &LatLon, a: &LatLon, b: &LatLon) -> (f32, f32) {
    let c = (p.lat as f64 * 1e-7).to_radians().cos();
    let ax = (a.lon as f64 - p.lon as f64) * 1e-7 * M_PER_DEG_LAT * c;
    let ay = (a.lat as f64 - p.lat as f64) * 1e-7 * M_PER_DEG_LAT;
    let bx = (b.lon as f64 - p.lon as f64) * 1e-7 * M_PER_DEG_LAT * c;
    let by = (b.lat as f64 - p.lat as f64) * 1e-7 * M_PER_DEG_LAT;
    let (dx, dy) = (bx - ax, by - ay);
    let l2 = dx * dx + dy * dy;
    let t = if l2 <= 1e-9 { 0.0 } else { (-(ax * dx + ay * dy) / l2).clamp(0.0, 1.0) };
    let (qx, qy) = (ax + t * dx, ay + t * dy);
    (t as f32, (qx * qx + qy * qy).sqrt() as f32)
}

/// Eight-way compass word for a bearing in degrees.
pub fn compass8(bearing: f32) -> &'static str {
    const N: [&str; 8] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    N[(((bearing.rem_euclid(360.0)) + 22.5) / 45.0) as usize % 8]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bern_bays() {
        // Bern, Bahnhof bay A vs bay K2: about 105 m apart.
        let a = LatLon::from_deg(46.947568, 7.440602);
        let k2 = LatLon::from_deg(46.946648, 7.440871);
        let d = a.dist_m(&k2);
        assert!((d - 104.0).abs() < 3.0, "{d}");
        let (x, y) = a.xy();
        let back = LatLon::from_xy(x, y);
        assert!(a.dist_m(&back) < 0.05);
        assert_eq!(compass8(a.bearing_deg(&k2)), "S");
    }
}
