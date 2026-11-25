//! Reading addresses, places and named streets out of an OSM PBF extract.
//!
//! The file is untrusted input: every string is length-capped and stripped of
//! control characters, every reference is looked up, nothing is assumed about
//! tags being present.
//!
//! The file is read blob-parallel in three phases — relations, ways, nodes —
//! because a way's position needs its nodes and a multipolygon's position
//! needs its ways, and both come *earlier* in the file than the thing that
//! needs them. Geofabrik extracts are sorted (`Sort.Type_then_ID`), so each
//! phase only decodes its own part of the file; an unsorted file is read three
//! times instead.

use crate::cats::{self, Tags};
use anyhow::{Context, Result};
use kante_core::{BBox, LatLon};
use osmpbf::{Blob, BlobDecode, BlobReader, PrimitiveBlock, RelMemberType};
use rayon::prelude::*;
use std::path::Path;

#[derive(Clone, Copy, Default, Debug)]
pub struct Span {
    pub off: u32,
    pub len: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct RawAddr {
    pub street: Span,
    pub hn: Span,
    pub city: Span,
    pub postcode: Span,
    pub pos: LatLon,
}

#[derive(Clone, Copy, Debug)]
pub struct RawPoi {
    pub name: Span,
    /// Other names (short, alternative, other languages), space separated.
    pub alt: Span,
    pub label: Span,
    pub city: Span,
    pub postcode: Span,
    pub street: Span,
    pub hn: Span,
    pub pos: LatLon,
    /// OSM id × 4 + element type (0 node, 1 way, 2 relation): stable across builds.
    pub code: u64,
    pub score: u8,
    pub class: u8,
    /// Somebody linked a Wikidata or Wikipedia entry.
    pub wiki: bool,
    /// Search words for what it serves ("pizza pizzeria italian …"), from `cats::details`.
    pub kw: Span,
    /// Its `PoiInfo`, encoded (`PoiInfo::encode`).
    pub info: Span,
}

#[derive(Clone, Copy, Debug)]
pub struct RawSeg {
    pub name: Span,
    /// Range in `RawData::seg_pts`.
    pub start: u32,
    pub len: u32,
}

/// Everything the index is built from, apart from the stations.
#[derive(Default)]
pub struct RawData {
    pub text: String,
    pub addrs: Vec<RawAddr>,
    pub pois: Vec<RawPoi>,
    pub segs: Vec<RawSeg>,
    pub seg_pts: Vec<LatLon>,
}

impl RawData {
    #[inline]
    pub fn s(&self, sp: Span) -> &str {
        &self.text[sp.off as usize..(sp.off + sp.len) as usize]
    }

    /// Store a cleaned copy of `s` (trimmed, no control characters, capped).
    pub fn put(&mut self, s: &str) -> Span {
        let s = s.trim();
        if s.is_empty() || self.text.len() > u32::MAX as usize - 1024 {
            return Span::default();
        }
        let off = self.text.len() as u32;
        for ch in s.chars().take(160) {
            self.text.push(if ch.is_control() { ' ' } else { ch });
        }
        Span { off, len: self.text.len() as u32 - off }
    }

    pub fn add_addr(&mut self, street: &str, hn: &str, postcode: &str, city: &str, pos: LatLon) {
        let a = RawAddr { street: self.put(street), hn: self.put(hn), city: self.put(city), postcode: self.put(postcode), pos };
        self.addrs.push(a);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_poi(&mut self, name: &str, alt: &str, label: &str, score: u8, class: u8, postcode: &str, city: &str, pos: LatLon, code: u64) {
        let p = RawPoi {
            name: self.put(name),
            alt: self.put(alt),
            label: self.put(label),
            city: self.put(city),
            postcode: self.put(postcode),
            street: Span::default(),
            hn: Span::default(),
            pos,
            code,
            score,
            class,
            wiki: false,
            kw: Span::default(),
            info: Span::default(),
        };
        self.pois.push(p);
    }

    /// Details of the place added last, and the words it is found by besides its name and category
    /// ("pizza italian" for what it serves).
    pub fn add_poi_info(&mut self, info: &crate::PoiInfo, keywords: &str) {
        let kw = self.put(keywords);
        let info = self.put_verbatim(&info.encode());
        if let Some(p) = self.pois.last_mut() {
            p.kw = kw;
            p.info = info;
        }
    }

    /// Store `s` as it is: the caller has cleaned it (an encoded `PoiInfo` keeps its 0x1f separators).
    fn put_verbatim(&mut self, s: &str) -> Span {
        if s.is_empty() || s.len() > 4096 || self.text.len() + s.len() > u32::MAX as usize - 1024 {
            return Span::default();
        }
        let off = self.text.len() as u32;
        self.text.push_str(s);
        Span { off, len: s.len() as u32 }
    }

    pub fn add_street(&mut self, name: &str, pts: &[LatLon]) {
        let s = RawSeg { name: self.put(name), start: self.seg_pts.len() as u32, len: pts.len() as u32 };
        self.seg_pts.extend_from_slice(pts);
        self.segs.push(s);
    }

    fn shift(sp: Span, by: u32) -> Span {
        if sp.len == 0 {
            sp
        } else {
            Span { off: sp.off + by, len: sp.len }
        }
    }

    /// Append `o`, keeping only what lies inside `bbox`.
    fn absorb(&mut self, o: RawData, bbox: Option<&BBox>) {
        if self.text.len() + o.text.len() >= u32::MAX as usize {
            return;
        }
        let by = self.text.len() as u32;
        self.text.push_str(&o.text);
        let inside = |p: &LatLon| !p.is_none() && bbox.is_none_or(|b| b.contains(p));
        for mut a in o.addrs {
            if inside(&a.pos) {
                a.street = Self::shift(a.street, by);
                a.hn = Self::shift(a.hn, by);
                a.city = Self::shift(a.city, by);
                a.postcode = Self::shift(a.postcode, by);
                self.addrs.push(a);
            }
        }
        for mut p in o.pois {
            if inside(&p.pos) {
                p.name = Self::shift(p.name, by);
                p.alt = Self::shift(p.alt, by);
                p.label = Self::shift(p.label, by);
                p.city = Self::shift(p.city, by);
                p.postcode = Self::shift(p.postcode, by);
                p.street = Self::shift(p.street, by);
                p.hn = Self::shift(p.hn, by);
                p.kw = Self::shift(p.kw, by);
                p.info = Self::shift(p.info, by);
                self.pois.push(p);
            }
        }
        for s in o.segs {
            let pts = &o.seg_pts[s.start as usize..(s.start + s.len) as usize];
            if pts.is_empty() || !pts.iter().any(inside) {
                continue;
            }
            let seg = RawSeg { name: Self::shift(s.name, by), start: self.seg_pts.len() as u32, len: s.len };
            self.seg_pts.extend_from_slice(pts);
            self.segs.push(seg);
        }
    }
}

const P_ADDR: u8 = 0;
const P_POI: u8 = 1;
const P_SEG: u8 = 2;

/// An item whose position is still a list of references.
struct Pend {
    kind: u8,
    idx: u32,
    start: u32,
    len: u32,
}

#[derive(Default)]
struct Chunk {
    data: RawData,
    /// Node ids (ways) or way ids (relations) of the pending items.
    refs: Vec<i64>,
    pend: Vec<Pend>,
    /// Way phase: sampled node ids of ways that a relation asked for.
    rel_ways: Vec<(i64, [i64; 8], u8)>,
    /// Node phase: (index into the needed-id list, lat, lon).
    coords: Vec<(u32, i32, i32)>,
}

struct Found {
    addr: Option<u32>,
    poi: Option<u32>,
    street: bool,
}

/// Turn one tagged element into raw items. `pos` is `LatLon::NONE` for ways
/// and relations (filled in later).
fn handle(ch: &mut Chunk, t: &Tags, pos: LatLon, code: u64, is_way: bool) -> Found {
    let d = &mut ch.data;
    let mut found = Found { addr: None, poi: None, street: false };

    let street = if !t.street.is_empty() { t.street } else { t.addr_place };
    let hn = t.hn.trim();
    if !hn.is_empty() && hn.len() <= 12 && !street.trim().is_empty() {
        let a = RawAddr { street: d.put(street), hn: d.put(hn), city: d.put(t.city), postcode: d.put(t.postcode), pos };
        found.addr = Some(d.addrs.len() as u32);
        d.addrs.push(a);
    }

    let name = if !t.name.trim().is_empty() { t.name } else { t.brand };
    if !name.trim().is_empty() {
        if let Some(cls) = cats::classify(t) {
            let mut alt = String::new();
            for a in [t.short_name, t.alt_name, t.official_name, t.loc_name, t.old_name, t.name_de, t.name_fr, t.name_it, t.name_en, t.name_rm, t.brand] {
                if !a.is_empty() && a != name && alt.len() < 300 {
                    alt.push_str(a);
                    alt.push(' ');
                }
            }
            let (info, kw) = cats::details(t);
            let p = RawPoi {
                name: d.put(name),
                alt: d.put(&alt),
                label: d.put(&cls.label),
                city: d.put(t.city),
                postcode: d.put(t.postcode),
                street: d.put(t.street),
                hn: if t.street.is_empty() || hn.len() > 12 { Span::default() } else { d.put(hn) },
                pos,
                code,
                score: cls.score,
                class: cls.class,
                wiki: !t.wikidata.is_empty() || !t.wikipedia.is_empty(),
                kw: d.put(&kw),
                info: d.put_verbatim(&info.encode()),
            };
            found.poi = Some(d.pois.len() as u32);
            d.pois.push(p);
        }
        if is_way && cats::is_street(t.highway) && !t.name.trim().is_empty() {
            found.street = true;
        }
    }
    found
}

/// 0 = nodes only, 1 = has ways, 2 = has relations.
fn block_kind(b: &Blob) -> u8 {
    let Ok(BlobDecode::OsmData(block)) = b.decode() else { return 0 };
    let mut k = 0;
    for g in block.groups() {
        if g.relations().next().is_some() {
            k = 2;
        } else if g.ways().next().is_some() {
            k = k.max(1);
        }
    }
    k
}

fn decode(b: &Blob) -> Option<PrimitiveBlock> {
    match b.decode() {
        Ok(BlobDecode::OsmData(block)) => Some(block),
        _ => None,
    }
}

fn relation_phase(blobs: &[Blob]) -> Vec<Chunk> {
    blobs
        .par_iter()
        .filter_map(|b| {
            let block = decode(b)?;
            let mut ch = Chunk::default();
            for g in block.groups() {
                for r in g.relations() {
                    let t = Tags::collect(r.tags());
                    if t.typ != "multipolygon" || (t.name.is_empty() && t.hn.is_empty() && t.brand.is_empty()) {
                        continue;
                    }
                    let code = ((r.id() as u64) << 2) | 2;
                    let f = handle(&mut ch, &t, LatLon::NONE, code, false);
                    if f.addr.is_none() && f.poi.is_none() {
                        continue;
                    }
                    let start = ch.refs.len() as u32;
                    for m in r.members() {
                        if m.member_type == RelMemberType::Way && m.role().map(|r| r != "inner").unwrap_or(true) {
                            ch.refs.push(m.member_id);
                            if ch.refs.len() as u32 - start >= 8 {
                                break;
                            }
                        }
                    }
                    let len = ch.refs.len() as u32 - start;
                    if let Some(i) = f.addr {
                        ch.pend.push(Pend { kind: P_ADDR, idx: i, start, len });
                    }
                    if let Some(i) = f.poi {
                        ch.pend.push(Pend { kind: P_POI, idx: i, start, len });
                    }
                }
            }
            Some(ch)
        })
        .collect()
}

fn way_phase(blobs: &[Blob], rel_ways: &[i64]) -> Vec<Chunk> {
    blobs
        .par_iter()
        .filter_map(|b| {
            let block = decode(b)?;
            let mut ch = Chunk::default();
            for g in block.groups() {
                for w in g.ways() {
                    let refs = w.raw_refs();
                    if refs.is_empty() || refs.len() > 20_000 {
                        continue;
                    }
                    if !rel_ways.is_empty() && rel_ways.binary_search(&w.id()).is_ok() {
                        let mut sample = [0i64; 8];
                        let mut id = 0i64;
                        let ids: Vec<i64> = refs
                            .iter()
                            .map(|d| {
                                id += d;
                                id
                            })
                            .collect();
                        let n = ids.len().min(8);
                        for (k, s) in sample.iter_mut().enumerate().take(n) {
                            *s = ids[k * ids.len() / n];
                        }
                        ch.rel_ways.push((w.id(), sample, n as u8));
                    }
                    let t = Tags::collect(w.tags());
                    if t.name.is_empty() && t.hn.is_empty() && t.brand.is_empty() {
                        continue;
                    }
                    let code = ((w.id() as u64) << 2) | 1;
                    let f = handle(&mut ch, &t, LatLon::NONE, code, true);
                    if f.addr.is_none() && f.poi.is_none() && !f.street {
                        continue;
                    }
                    let start = ch.refs.len() as u32;
                    ch.refs.extend(w.refs());
                    let len = ch.refs.len() as u32 - start;
                    if let Some(i) = f.addr {
                        ch.pend.push(Pend { kind: P_ADDR, idx: i, start, len });
                    }
                    if let Some(i) = f.poi {
                        ch.pend.push(Pend { kind: P_POI, idx: i, start, len });
                    }
                    if f.street {
                        let name = ch.data.put(t.name);
                        let idx = ch.data.segs.len() as u32;
                        ch.data.segs.push(RawSeg { name, start: 0, len: 0 });
                        ch.pend.push(Pend { kind: P_SEG, idx, start, len });
                    }
                }
            }
            Some(ch)
        })
        .collect()
}

fn node_phase(blobs: &[Blob], needed: &[i64], bbox: Option<&BBox>) -> Vec<Chunk> {
    blobs
        .par_iter()
        .filter_map(|b| {
            let block = decode(b)?;
            let mut ch = Chunk::default();
            let mut ptr = 0usize;
            let mut prev = i64::MIN;
            let mut visit = |ch: &mut Chunk, id: i64, lat: i32, lon: i32| {
                if id < prev {
                    ptr = needed.partition_point(|&x| x < id);
                } else if ptr == 0 && prev == i64::MIN {
                    ptr = needed.partition_point(|&x| x < id);
                }
                prev = id;
                while ptr < needed.len() && needed[ptr] < id {
                    ptr += 1;
                }
                if ptr < needed.len() && needed[ptr] == id {
                    ch.coords.push((ptr as u32, lat, lon));
                }
            };
            for g in block.groups() {
                for n in g.dense_nodes() {
                    let (lat, lon) = (n.decimicro_lat(), n.decimicro_lon());
                    visit(&mut ch, n.id(), lat, lon);
                    let mut tags = n.tags();
                    let Some(first) = tags.next() else { continue };
                    let pos = LatLon { lat, lon };
                    if bbox.is_some_and(|b| !b.contains(&pos)) {
                        continue;
                    }
                    let t = Tags::collect(std::iter::once(first).chain(tags));
                    if t.name.is_empty() && t.hn.is_empty() && t.brand.is_empty() {
                        continue;
                    }
                    handle(&mut ch, &t, pos, (n.id() as u64) << 2, false);
                }
                for n in g.nodes() {
                    let (lat, lon) = (n.decimicro_lat(), n.decimicro_lon());
                    visit(&mut ch, n.id(), lat, lon);
                    let pos = LatLon { lat, lon };
                    if bbox.is_some_and(|b| !b.contains(&pos)) {
                        continue;
                    }
                    let t = Tags::collect(n.tags());
                    if t.name.is_empty() && t.hn.is_empty() && t.brand.is_empty() {
                        continue;
                    }
                    handle(&mut ch, &t, pos, (n.id() as u64) << 2, false);
                }
            }
            Some(ch)
        })
        .collect()
}

/// Positions for the pending items of `ch`: bounding-box centre of the nodes
/// for addresses and places, the node polyline for streets.
fn resolve_chunk(ch: &mut Chunk, needed: &[i64], lat: &[i32], lon: &[i32]) {
    let at = |id: i64| -> Option<LatLon> {
        let i = needed.binary_search(&id).ok()?;
        (lat[i] != i32::MIN).then(|| LatLon { lat: lat[i], lon: lon[i] })
    };
    for p in &ch.pend {
        let refs = &ch.refs[p.start as usize..(p.start + p.len) as usize];
        if p.kind == P_SEG {
            let start = ch.data.seg_pts.len() as u32;
            ch.data.seg_pts.extend(refs.iter().filter_map(|&r| at(r)));
            let seg = &mut ch.data.segs[p.idx as usize];
            seg.start = start;
            seg.len = ch.data.seg_pts.len() as u32 - start;
            continue;
        }
        let mut bb = BBox::empty();
        let mut any = false;
        for q in refs.iter().filter_map(|&r| at(r)) {
            bb.extend(&q);
            any = true;
        }
        let pos = if any {
            LatLon { lat: ((bb.min.lat as i64 + bb.max.lat as i64) / 2) as i32, lon: ((bb.min.lon as i64 + bb.max.lon as i64) / 2) as i32 }
        } else {
            LatLon::NONE
        };
        match p.kind {
            P_ADDR => ch.data.addrs[p.idx as usize].pos = pos,
            _ => ch.data.pois[p.idx as usize].pos = pos,
        }
    }
}

/// Read the extract. `log` receives progress lines.
pub fn read_pbf(path: &Path, bbox: Option<BBox>, log: &mut dyn FnMut(String)) -> Result<RawData> {
    let t0 = std::time::Instant::now();
    let mut sorted = false;
    let mut blobs: Vec<Blob> = Vec::new();
    for b in BlobReader::from_path(path).with_context(|| format!("open {}", path.display()))? {
        let b = b.with_context(|| format!("read {}", path.display()))?;
        match b.get_type() {
            osmpbf::BlobType::OsmHeader => {
                if let Ok(h) = b.to_headerblock() {
                    sorted = h.optional_features().iter().any(|f| f == "Sort.Type_then_ID");
                }
            }
            osmpbf::BlobType::OsmData => blobs.push(b),
            _ => {}
        }
    }
    let n = blobs.len();
    let (first_way, first_rel) = if sorted {
        let idx: Vec<usize> = (0..n).collect();
        (idx.partition_point(|&i| block_kind(&blobs[i]) < 1), idx.partition_point(|&i| block_kind(&blobs[i]) < 2))
    } else {
        (0, 0)
    };
    let (node_r, way_r, rel_r) = if sorted { (0..(first_way + 1).min(n), first_way..(first_rel + 1).min(n), first_rel..n) } else { (0..n, 0..n, 0..n) };
    log(format!("pbf: {n} blobs read in {:.1}s (sorted: {sorted}, ways from blob {first_way}, relations from {first_rel})", t0.elapsed().as_secs_f32()));

    // Relations → which ways do we need a few nodes of?
    let mut rel_chunks = relation_phase(&blobs[rel_r]);
    let mut rel_ways: Vec<i64> = rel_chunks.iter().flat_map(|c| c.refs.iter().copied()).collect();
    rel_ways.par_sort_unstable();
    rel_ways.dedup();

    // Ways.
    let mut way_chunks = way_phase(&blobs[way_r], &rel_ways);
    let mut sampled: Vec<(i64, [i64; 8], u8)> = way_chunks.iter_mut().flat_map(|c| std::mem::take(&mut c.rel_ways)).collect();
    sampled.par_sort_unstable_by_key(|s| s.0);
    // Relations now point at node ids like ways do.
    for ch in &mut rel_chunks {
        let way_ids = std::mem::take(&mut ch.refs);
        for p in &mut ch.pend {
            let start = ch.refs.len() as u32;
            for w in &way_ids[p.start as usize..(p.start + p.len) as usize] {
                if let Ok(i) = sampled.binary_search_by_key(w, |s| s.0) {
                    ch.refs.extend_from_slice(&sampled[i].1[..sampled[i].2 as usize]);
                }
            }
            p.start = start;
            p.len = ch.refs.len() as u32 - start;
        }
    }
    drop(sampled);
    log(format!("pbf: relations + ways scanned at {:.1}s", t0.elapsed().as_secs_f32()));

    // Which nodes do we need coordinates for?
    let mut needed: Vec<i64> = way_chunks.iter().chain(rel_chunks.iter()).flat_map(|c| c.refs.iter().copied()).collect();
    needed.par_sort_unstable();
    needed.dedup();
    if needed.len() >= u32::MAX as usize {
        anyhow::bail!("extract too large: {} referenced nodes", needed.len());
    }

    // Nodes: tagged ones become items, referenced ones give coordinates.
    let mut node_chunks = node_phase(&blobs[node_r], &needed, bbox.as_ref());
    drop(blobs);
    let mut lat = vec![i32::MIN; needed.len()];
    let mut lon = vec![i32::MIN; needed.len()];
    for ch in &mut node_chunks {
        for &(i, la, lo) in &ch.coords {
            lat[i as usize] = la;
            lon[i as usize] = lo;
        }
        ch.coords = Vec::new();
    }
    log(format!("pbf: nodes scanned at {:.1}s ({} referenced nodes)", t0.elapsed().as_secs_f32(), needed.len()));

    way_chunks.par_iter_mut().chain(rel_chunks.par_iter_mut()).for_each(|ch| resolve_chunk(ch, &needed, &lat, &lon));
    drop((needed, lat, lon));

    let mut out = RawData::default();
    for ch in node_chunks.into_iter().chain(way_chunks).chain(rel_chunks) {
        out.absorb(ch.data, bbox.as_ref());
    }
    log(format!(
        "pbf: {} address points, {} places, {} street segments ({} points) in {:.1}s",
        out.addrs.len(),
        out.pois.len(),
        out.segs.len(),
        out.seg_pts.len(),
        t0.elapsed().as_secs_f32()
    ));
    Ok(out)
}
