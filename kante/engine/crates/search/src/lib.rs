//! kante-search — the geocoder: stations, street addresses and places behind
//! one type-ahead box. See docs/ARCHITECTURE.md for the contract.
//!
//! # What is indexed
//! - **Stations** from `Timetable::stations`, ranked by `Station::weight`.
//!   Rail stations also answer to "bahnhof", "gare", "stazione" (and "hb" for
//!   a town's main station), so "bern hb" finds the station called "Bern".
//! - **Places** from OSM: localities, amenities, shops, sights, peaks, lakes …
//!   (`cats.rs` decides what counts, what it is called and how prominent it
//!   is; a Wikidata link is the "well-known" signal). Each also answers to its
//!   category in four languages ("apotheke", "pharmacie" …).
//! - **Streets**: one entry per street name + locality, merged from address
//!   tags and named `highway` ways, positioned at the house nearest to the
//!   centre of its houses (or the way vertex nearest to the way's centre).
//! - **Houses**: every `addr:housenumber`; reached through their street, so
//!   they cost no tokens.
//!
//! # Shape of the index
//! Stations, places and streets are *documents*, numbered by descending
//! prominence, so every posting list is already in ranking order and "the best
//! k" is "the first k". Tokens live in one sorted vocabulary (a prefix is a
//! range of ids); there are two inverted lists per token (name / locality) and
//! a forward list per document for verification and scoring. Prefixes with
//! more than `HEAVY_MIN` postings ("b", "bahnhof") have a precomputed top
//! list. Everything is a flat array; the query path allocates only its result.
//!
//! # Matching and ranking (`query.rs`)
//! Tokens are canonical (`text.rs`): no case, no diacritics, `ae/oe/ue` = the
//! umlaut, `str.` = `strasse`, `st.` = `sankt` = `saint`, plus a small alias
//! table (`hbf`, `genf`, `geneva`, `av.` …). Every typed word must match a
//! word of the name, of another name, or of the locality; the last word (and
//! any word of three letters or more) may be a prefix. A number is also tried
//! as a house number of the streets the other words select.
//!
//! Score = prominence (0…100, stations 45…100 by weight, localities ≤ 74,
//! places ≤ 68, streets ≤ 36) + how the words fit the name (whole name 60,
//! the stop's own name 50, beginning of the name 40, …) + up to 45 for being
//! close to `near` (half of it at 2 km) + 45 for an exact house number.
//! When that finds fewer than three results, words of five letters or more
//! are retried one edit away (insert, delete, substitute, transpose).
//!
//! # Missing localities
//! 11 % of the address points in the Swiss extract have no `addr:city` or
//! `addr:postcode` (254 000 of 2.24 million; 8 000 stay incomplete). They
//! inherit them from (1) the usual town of their postcode, (2) the nearest
//! complete address on a street of the same name within about a kilometre,
//! (3) the nearest complete address at all, looked up in grids of 150 m,
//! 600 m, 2.4 km and 9.6 km cells that each remember the majority locality of
//! the cell. Places and street-only ways use the same lookup.
//!
//! # Ids
//! `st:<gtfs id>`; `poi:<OSM id × 4 + element type>` (stable across
//! rebuilds); `addr:<2 × house number index>` / `addr:<2 × street + 1>`
//! (valid for one built index).

mod build;
mod cats;
mod osm;
mod query;
mod text;

use kante_core::{BBox, LatLon, StationIdx, Timetable};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub use cats::{CLASS_NATURE, CLASS_PLACE_MAJOR, CLASS_PLACE_MINOR, CLASS_POI};
pub use osm::RawData;

/// Schema tag for `kante_core::io::save` / `load`.
pub const SEARCH_SCHEMA: &str = "search-v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum HitKind {
    Station,
    Address,
    Poi,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Hit {
    pub kind: HitKind,
    /// `st:<station gtfs id>`, `addr:<n>`, `poi:<n>`
    pub id: String,
    pub name: String,
    /// Empty for stations; "3011 Bern" for addresses; "Supermarket · Bern" for places.
    pub detail: String,
    pub pos: LatLon,
    /// Station hits: index into `Timetable::stations`.
    pub station: Option<StationIdx>,
    /// Ranking score (higher is better). For `reverse`: distance in metres.
    pub score: f32,
}

pub(crate) const KIND_STATION: u8 = 0;
pub(crate) const KIND_POI: u8 = 1;
pub(crate) const KIND_STREET: u8 = 2;

/// Forward-list entry: token id in the low 29 bits, a "minor word" flag
/// ("de", "am" …) in bit 29, the class in the top two bits.
pub(crate) const CLS_SHIFT: u32 = 30;
pub(crate) const CLS_NAME: u32 = 0;
pub(crate) const CLS_ALT: u32 = 1;
pub(crate) const CLS_LOC: u32 = 2;
pub(crate) const MINOR: u32 = 1 << 29;
pub(crate) const ID_MASK: u32 = MINOR - 1;
/// Name-posting flag: the token is the document's whole name.
pub(crate) const SOLE: u32 = 1 << 31;
/// Name-posting flag: the token is a category keyword ("bahnhof" on the
/// station "Bern"), which only counts when typed (nearly) in full. On an
/// alternative-name forward entry the `MINOR` bit says the same.
pub(crate) const KEYWORD: u32 = 1 << 30;
pub(crate) const POST_MASK: u32 = !(SOLE | KEYWORD);
/// Typed length from which a prefix may match a category keyword.
pub(crate) const KEYWORD_MIN_PREFIX: usize = 5;
pub(crate) const NONE: u32 = u32::MAX;

/// A prefix whose name postings exceed this gets a precomputed top list.
pub(crate) const HEAVY_MIN: usize = 6000;
pub(crate) const HEAVY_TOP: usize = 512;
pub(crate) const HEAVY_MAX_LEN: usize = 16;

/// Strings stored back to back.
#[derive(Default, Clone, Serialize, Deserialize)]
pub(crate) struct Pool {
    pub off: Vec<u32>,
    pub bytes: Vec<u8>,
}

impl Pool {
    pub fn new() -> Pool {
        Pool { off: vec![0], bytes: Vec::new() }
    }
    pub fn push(&mut self, s: &[u8]) {
        if self.off.is_empty() {
            self.off.push(0);
        }
        self.bytes.extend_from_slice(s);
        self.off.push(self.bytes.len() as u32);
    }
    #[inline]
    pub fn len(&self) -> usize {
        self.off.len().saturating_sub(1)
    }
    #[inline]
    pub fn get(&self, i: usize) -> &[u8] {
        &self.bytes[self.off[i] as usize..self.off[i + 1] as usize]
    }
    #[inline]
    pub fn str(&self, i: usize) -> &str {
        std::str::from_utf8(self.get(i)).unwrap_or("")
    }
    fn heap(&self) -> usize {
        self.off.len() * 4 + self.bytes.len()
    }
}

/// Uniform grid over fixed-point coordinates; `items` of a cell keep build order.
#[derive(Default, Clone, Serialize, Deserialize)]
pub(crate) struct Grid {
    pub lat0: i32,
    pub lon0: i32,
    pub dlat: i32,
    pub dlon: i32,
    pub w: i32,
    pub h: i32,
    pub off: Vec<u32>,
    pub items: Vec<u32>,
}

/// Points outside this box (stray border data, bad coordinates) are searchable
/// by name but not spatially indexed.
const SANE: (i32, i32, i32, i32) = (455_000_000, 480_500_000, 56_000_000, 108_000_000);

impl Grid {
    pub fn build(pts: &[(LatLon, u32)], dlat: i32, dlon: i32) -> Grid {
        let sane = |p: &LatLon| p.lat >= SANE.0 && p.lat <= SANE.1 && p.lon >= SANE.2 && p.lon <= SANE.3;
        let mut bb = BBox::empty();
        for (p, _) in pts.iter().filter(|(p, _)| sane(p)) {
            bb.extend(p);
        }
        if bb.min.lat > bb.max.lat {
            return Grid { dlat, dlon, off: vec![0], ..Grid::default() };
        }
        let w = (bb.max.lon - bb.min.lon) / dlon + 1;
        let h = (bb.max.lat - bb.min.lat) / dlat + 1;
        let mut g = Grid { lat0: bb.min.lat, lon0: bb.min.lon, dlat, dlon, w, h, off: vec![0; (w as usize) * (h as usize) + 1], items: vec![0; 0] };
        let cell = |p: &LatLon| ((p.lat - bb.min.lat) / dlat) as usize * w as usize + ((p.lon - bb.min.lon) / dlon) as usize;
        let mut n = 0u32;
        for (p, _) in pts.iter().filter(|(p, _)| sane(p)) {
            g.off[cell(p) + 1] += 1;
            n += 1;
        }
        for i in 1..g.off.len() {
            g.off[i] += g.off[i - 1];
        }
        g.items = vec![0; n as usize];
        let mut cur = g.off.clone();
        for (p, it) in pts.iter().filter(|(p, _)| sane(p)) {
            let c = cell(p);
            g.items[cur[c] as usize] = *it;
            cur[c] += 1;
        }
        g
    }

    /// Cell coordinates of `p`; may lie outside the grid.
    #[inline]
    pub fn xy(&self, p: LatLon) -> (i32, i32) {
        if self.dlat == 0 {
            return (-1, -1);
        }
        ((p.lon as i64 - self.lon0 as i64).div_euclid(self.dlon as i64) as i32, (p.lat as i64 - self.lat0 as i64).div_euclid(self.dlat as i64) as i32)
    }

    #[inline]
    pub fn cell(&self, x: i32, y: i32) -> &[u32] {
        if x < 0 || y < 0 || x >= self.w || y >= self.h {
            return &[];
        }
        let c = y as usize * self.w as usize + x as usize;
        &self.items[self.off[c] as usize..self.off[c + 1] as usize]
    }

    fn heap(&self) -> usize {
        (self.off.len() + self.items.len()) * 4
    }
}

/// The geocoder. Build once with [`build`], store with
/// `kante_core::io::save(path, SEARCH_SCHEMA, &index)`.
#[derive(Default, Serialize, Deserialize)]
pub struct SearchIndex {
    /// `Timetable::feed_version` and station count the station part was built from.
    pub(crate) feed_version: String,
    pub(crate) n_stations: u32,

    // ---- documents, ordered by descending prominence ----
    pub(crate) kind: Vec<u8>,
    /// Prominence × 2 (0..=255).
    pub(crate) stat: Vec<u8>,
    /// Station: number of name tokens before the stop's own name ("Bern, " = 1).
    /// Place: category id | class << 12. Street: 1 if it spans several postcodes.
    pub(crate) cat: Vec<u16>,
    pub(crate) lat: Vec<i32>,
    pub(crate) lon: Vec<i32>,
    pub(crate) loc: Vec<u32>,
    /// Station: `StationIdx`. Place: index into `poi_code`. Street: street number.
    pub(crate) ext: Vec<u32>,
    /// Display name, for places optionally followed by 0x1f and a street address.
    pub(crate) strs: Pool,
    pub(crate) cats: Vec<String>,
    /// Localities: "postcode\x1fcity".
    pub(crate) locs: Pool,

    // ---- tokens ----
    pub(crate) vocab: Pool,
    /// Token ids sorted by reversed spelling (typo lookups by word ending).
    pub(crate) vocab_rev: Vec<u32>,
    pub(crate) npost_off: Vec<u32>,
    pub(crate) npost: Vec<u32>,
    pub(crate) lpost_off: Vec<u32>,
    pub(crate) lpost: Vec<u32>,
    pub(crate) fwd_off: Vec<u32>,
    pub(crate) fwd: Vec<u32>,
    pub(crate) heavy_keys: Pool,
    pub(crate) heavy_off: Vec<u32>,
    pub(crate) heavy: Vec<u32>,

    // ---- stations ----
    pub(crate) st_ids: Vec<String>,
    pub(crate) st_doc: Vec<u32>,
    pub(crate) st_sorted: Vec<u32>,

    // ---- places ----
    pub(crate) poi_code: Vec<u64>,
    pub(crate) poi_doc: Vec<u32>,

    // ---- streets and houses ----
    pub(crate) street_doc: Vec<u32>,
    /// Houses of street `s` are `house_off[s]..house_off[s+1]`, sorted by number.
    pub(crate) house_off: Vec<u32>,
    pub(crate) h_lat: Vec<i32>,
    pub(crate) h_lon: Vec<i32>,
    pub(crate) h_hn: Vec<u32>,
    pub(crate) h_loc: Vec<u32>,
    /// House-number pool sorted by (leading integer, key): ids compare like numbers.
    pub(crate) hn_int: Vec<u32>,
    pub(crate) hn_raw: Pool,
    pub(crate) hn_key: Pool,

    // ---- space ----
    /// 150 m cells over houses (item < number of houses) and street sample points.
    pub(crate) fine: Grid,
    pub(crate) sp_lat: Vec<i32>,
    pub(crate) sp_lon: Vec<i32>,
    pub(crate) sp_street: Vec<u32>,
    /// 500 m cells over documents, each cell in prominence order.
    pub(crate) dgrid: Grid,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Stats {
    pub stations: usize,
    pub places: usize,
    pub streets: usize,
    pub houses: usize,
    pub tokens: usize,
    pub localities: usize,
    pub street_points: usize,
    pub heavy_prefixes: usize,
    /// Bytes held on the heap by the index.
    pub heap_bytes: usize,
}

/// Build the index. `pbf = None` gives a stations-only index; `bbox` limits
/// the OSM part to an area (stations are always national).
pub fn build(tt: &Timetable, pbf: Option<&Path>, bbox: Option<BBox>) -> anyhow::Result<SearchIndex> {
    build_logged(tt, pbf, bbox, &mut |_| {})
}

/// [`build`] with progress lines handed to `log`.
pub fn build_logged(tt: &Timetable, pbf: Option<&Path>, bbox: Option<BBox>, log: &mut dyn FnMut(String)) -> anyhow::Result<SearchIndex> {
    let raw = match pbf {
        Some(p) => osm::read_pbf(p, bbox, log)?,
        None => RawData::default(),
    };
    Ok(build::assemble(tt, &raw, log))
}

/// Build from already extracted OSM items (tests, other importers).
pub fn build_from_raw(tt: &Timetable, raw: &RawData) -> SearchIndex {
    build::assemble(tt, raw, &mut |_| {})
}

impl SearchIndex {
    pub fn stats(&self) -> Stats {
        let v4 = |v: &Vec<u32>| v.len() * 4;
        let i4 = |v: &Vec<i32>| v.len() * 4;
        let heap = self.kind.len()
            + self.stat.len()
            + self.cat.len() * 2
            + i4(&self.lat)
            + i4(&self.lon)
            + v4(&self.loc)
            + v4(&self.ext)
            + self.strs.heap()
            + self.locs.heap()
            + self.vocab.heap()
            + v4(&self.vocab_rev)
            + v4(&self.npost_off)
            + v4(&self.npost)
            + v4(&self.lpost_off)
            + v4(&self.lpost)
            + v4(&self.fwd_off)
            + v4(&self.fwd)
            + self.heavy_keys.heap()
            + v4(&self.heavy_off)
            + v4(&self.heavy)
            + self.st_ids.iter().map(|s| s.len() + 24).sum::<usize>()
            + v4(&self.st_doc)
            + v4(&self.st_sorted)
            + self.poi_code.len() * 8
            + v4(&self.poi_doc)
            + v4(&self.street_doc)
            + v4(&self.house_off)
            + i4(&self.h_lat)
            + i4(&self.h_lon)
            + v4(&self.h_hn)
            + v4(&self.h_loc)
            + v4(&self.hn_int)
            + self.hn_raw.heap()
            + self.hn_key.heap()
            + self.fine.heap()
            + i4(&self.sp_lat)
            + i4(&self.sp_lon)
            + v4(&self.sp_street)
            + self.dgrid.heap();
        Stats {
            stations: self.kind.iter().filter(|&&k| k == KIND_STATION).count(),
            places: self.poi_code.len(),
            streets: self.street_doc.len(),
            houses: self.h_lat.len(),
            tokens: self.vocab.len(),
            localities: self.locs.len(),
            street_points: self.sp_lat.len(),
            heavy_prefixes: self.heavy_keys.len(),
            heap_bytes: heap,
        }
    }

    /// Feed version of the timetable the station entries (and `Hit::station`
    /// indices) belong to; compare before pairing a cached index with a timetable.
    pub fn feed_version(&self) -> &str {
        &self.feed_version
    }

    /// Number of timetable stations the index was built from.
    pub fn station_count(&self) -> u32 {
        self.n_stations
    }

    /// Number of searchable documents (stations + places + streets).
    pub fn doc_count(&self) -> usize {
        self.kind.len()
    }

    /// Display name of document `i` (for benchmarks and debugging).
    pub fn doc_name(&self, i: usize) -> &str {
        let s = self.strs.str(i);
        s.split('\x1f').next().unwrap_or("")
    }
}
