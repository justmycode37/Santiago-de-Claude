//! A terrain model in a tiled GeoTIFF in Swiss LV95 (swisstopo's swissALTIRegio: 10 m, float32,
//! 256 × 256 tiles), read a band of tiles at a time.

use anyhow::{bail, Context, Result};
use kante_core::LatLon;
use rayon::prelude::*;
use rustc_hash::FxHashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use tiff::decoder::{Decoder, DecodingResult};
use tiff::tags::Tag;

/// Heights in metres at points in LV95 (east, north), NaN where there is none.
pub trait Terrain: Sync {
    fn heights(&self, pts: &[(f64, f64)]) -> Vec<f32>;
}

/// WGS84 → Swiss LV95 (east, north), swisstopo's approximate formulas (about 1 m).
pub fn wgs84_to_lv95(p: &LatLon) -> (f64, f64) {
    let phi = (p.lat_deg() * 3600.0 - 169_028.66) / 10_000.0;
    let lam = (p.lon_deg() * 3600.0 - 26_782.5) / 10_000.0;
    let e = 2_600_072.37 + 211_455.93 * lam - 10_938.51 * lam * phi - 0.36 * lam * phi * phi - 44.54 * lam * lam * lam;
    let n = 1_200_147.07 + 308_807.95 * phi + 3_745.25 * lam * lam + 76.63 * phi * phi - 194.56 * lam * lam * phi + 119.79 * phi * phi * phi;
    (e, n)
}

pub struct Dem {
    path: PathBuf,
    /// LV95 of the top-left corner of the top-left pixel.
    e0: f64,
    n0: f64,
    /// Metres per pixel.
    px: f64,
    width: u32,
    height: u32,
    tile_w: u32,
    tile_h: u32,
    tiles_across: u32,
    /// Tiles that could not be read (a file cut short, a compression this reader does not know).
    failed: AtomicUsize,
}

/// A value that is no height: GDAL's nodata (3.4e38) or anything off the scale.
#[inline]
fn valid(h: f32) -> bool {
    h.is_finite() && (-500.0..9000.0).contains(&h)
}

impl Dem {
    pub fn open(path: &Path) -> Result<Dem> {
        let mut d = decoder(path)?;
        let (width, height) = d.dimensions()?;
        let scale = d.get_tag_f64_vec(Tag::ModelPixelScaleTag).context("no pixel scale (not a GeoTIFF)")?;
        let tie = d.get_tag_f64_vec(Tag::ModelTiepointTag).context("no tie point (not a GeoTIFF)")?;
        if scale.len() < 2 || tie.len() < 6 || scale[0] <= 0.0 || (scale[0] - scale[1]).abs() > 1e-9 {
            bail!("unexpected georeferencing: scale {scale:?}, tie point {tie:?}");
        }
        if tie[0] != 0.0 || tie[1] != 0.0 {
            bail!("tie point not at the corner pixel: {tie:?}");
        }
        // LV95 easting / northing ranges: anything else is another projection
        if !(2_000_000.0..3_000_000.0).contains(&tie[3]) || !(1_000_000.0..2_000_000.0).contains(&tie[4]) {
            bail!("not in Swiss LV95: tie point {tie:?}");
        }
        let (tile_w, tile_h) = d.chunk_dimensions();
        if width == 0 || height == 0 || tile_w == 0 || tile_h == 0 {
            bail!("an empty image");
        }
        if tile_w == width && height > tile_h {
            bail!("a striped TIFF: tiles needed");
        }
        match d.colortype()? {
            tiff::ColorType::Gray(32) => {}
            c => bail!("heights as {c:?}, not 32-bit floats"),
        }
        let dem = Dem { path: path.to_path_buf(), e0: tie[3], n0: tie[4], px: scale[0], width, height, tile_w, tile_h, tiles_across: width.div_ceil(tile_w), failed: AtomicUsize::new(0) };
        // the last tile: a file cut short fails here, not halfway through the build
        let last = dem.tiles_across * height.div_ceil(tile_h) - 1;
        match d.read_chunk(last) {
            Ok(DecodingResult::F32(_)) => Ok(dem),
            Ok(_) => bail!("heights not as 32-bit floats"),
            Err(e) => bail!("its last tile cannot be read ({e}): cut short?"),
        }
    }

    /// Tiles that could not be read so far.
    pub fn failed_tiles(&self) -> usize {
        self.failed.load(Ordering::Relaxed)
    }

    /// (column, row) of pixel centres: point (e, n) lies between pixels `floor` and `floor + 1`.
    #[inline]
    fn pixel(&self, e: f64, n: f64) -> (f64, f64) {
        ((e - self.e0) / self.px - 0.5, (self.n0 - n) / self.px - 0.5)
    }

    #[inline]
    fn tile_of(&self, col: u32, row: u32) -> u32 {
        (row / self.tile_h) * self.tiles_across + col / self.tile_w
    }
}

fn decoder(path: &Path) -> Result<Decoder<BufReader<File>>> {
    let f = File::open(path).with_context(|| format!("{}", path.display()))?;
    Decoder::new(BufReader::new(f)).with_context(|| format!("{}: not a TIFF", path.display()))
}

/// One decoded tile: its values, row by row, `w` wide.
struct Tile {
    w: u32,
    v: Vec<f32>,
}

impl Terrain for Dem {
    /// Bilinear between the four nearest pixel centres (the nearest valid ones where some are missing).
    fn heights(&self, pts: &[(f64, f64)]) -> Vec<f32> {
        let mut out = vec![f32::NAN; pts.len()];
        // the points by the band of tiles of their upper-left pixel; a band needs its own tiles and the next one's
        let mut by_band: Vec<(u32, u32)> = Vec::with_capacity(pts.len());
        for (i, &(e, n)) in pts.iter().enumerate() {
            let (x, y) = self.pixel(e, n);
            if !(x > -1.0 && y > -1.0 && x < self.width as f64 && y < self.height as f64) {
                continue;
            }
            let row = (y.floor().max(0.0) as u32).min(self.height - 1);
            by_band.push((row / self.tile_h, i as u32));
        }
        by_band.sort_unstable();
        let mut cache: FxHashMap<u32, Tile> = FxHashMap::default();
        let mut k = 0;
        while k < by_band.len() {
            let band = by_band[k].0;
            let end = by_band[k..].iter().position(|b| b.0 != band).map_or(by_band.len(), |p| k + p);
            let idx: Vec<u32> = by_band[k..end].iter().map(|b| b.1).collect();
            // the tiles this band's points read
            let mut need: Vec<u32> = Vec::new();
            for &i in &idx {
                let (e, n) = pts[i as usize];
                let (x, y) = self.pixel(e, n);
                for (c, r) in self.corners(x, y) {
                    need.push(self.tile_of(c, r));
                }
            }
            need.sort_unstable();
            need.dedup();
            need.retain(|t| !cache.contains_key(t));
            let path = &self.path;
            let fresh: Vec<(u32, Option<Tile>)> = need
                .par_iter()
                .map_init(
                    || decoder(path).ok(),
                    |d, &t| {
                        let tile = d.as_mut().and_then(|d| {
                            let (w, _) = d.chunk_data_dimensions(t);
                            match d.read_chunk(t) {
                                Ok(DecodingResult::F32(v)) => Some(Tile { w, v }),
                                _ => None,
                            }
                        });
                        (t, tile)
                    },
                )
                .collect();
            for (t, tile) in fresh {
                if tile.is_none() {
                    self.failed.fetch_add(1, Ordering::Relaxed);
                }
                cache.insert(t, tile.unwrap_or(Tile { w: 0, v: Vec::new() }));
            }
            let hs: Vec<f32> = idx.par_iter().map(|&i| self.bilinear(pts[i as usize], &cache)).collect();
            for (&i, h) in idx.iter().zip(hs) {
                out[i as usize] = h;
            }
            // tiles of this band are not read again: the next band reads its own and the one after
            cache.retain(|t, _| t / self.tiles_across > band);
            k = end;
        }
        out
    }
}

impl Dem {
    /// The four pixels around pixel position (x, y), clamped to the image.
    fn corners(&self, x: f64, y: f64) -> [(u32, u32); 4] {
        let cl = |v: f64, max: u32| (v.max(0.0) as u32).min(max - 1);
        let (c0, r0) = (cl(x.floor(), self.width), cl(y.floor(), self.height));
        let (c1, r1) = (cl(x.floor() + 1.0, self.width), cl(y.floor() + 1.0, self.height));
        [(c0, r0), (c1, r0), (c0, r1), (c1, r1)]
    }

    fn value(&self, col: u32, row: u32, cache: &FxHashMap<u32, Tile>) -> f32 {
        let Some(t) = cache.get(&self.tile_of(col, row)) else { return f32::NAN };
        let (c, r) = (col % self.tile_w, row % self.tile_h);
        t.v.get((r * t.w + c) as usize).copied().filter(|h| valid(*h)).unwrap_or(f32::NAN)
    }

    fn bilinear(&self, (e, n): (f64, f64), cache: &FxHashMap<u32, Tile>) -> f32 {
        let (x, y) = self.pixel(e, n);
        let [p00, p10, p01, p11] = self.corners(x, y);
        let (fx, fy) = ((x - x.floor()).clamp(0.0, 1.0) as f32, (y - y.floor()).clamp(0.0, 1.0) as f32);
        let w = [(1.0 - fx) * (1.0 - fy), fx * (1.0 - fy), (1.0 - fx) * fy, fx * fy];
        let (mut s, mut ws) = (0f32, 0f32);
        for (p, w) in [p00, p10, p01, p11].into_iter().zip(w) {
            let h = self.value(p.0, p.1, cache);
            if h.is_finite() {
                s += h * w;
                ws += w;
            }
        }
        if ws > 1e-6 {
            s / ws
        } else {
            f32::NAN
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lv95_reference_point() {
        // swisstopo's worked example: 46° 2' 38.87" N, 8° 43' 49.79" E → E 2 699 999.76, N 1 099 999.97
        let p = LatLon::from_deg(46.0 + 2.0 / 60.0 + 38.87 / 3600.0, 8.0 + 43.0 / 60.0 + 49.79 / 3600.0);
        let (e, n) = wgs84_to_lv95(&p);
        assert!((e - 2_699_999.76).abs() < 1.5 && (n - 1_099_999.97).abs() < 1.5, "{e} {n}");
    }
}
