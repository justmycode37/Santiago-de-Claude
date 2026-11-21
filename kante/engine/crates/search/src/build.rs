//! Raw items + stations → the flat index.

use crate::osm::RawData;
use crate::text::{self, Toks};
use crate::*;
use kante_core::text::normalize;
use rayon::prelude::*;
use rustc_hash::FxHashMap;
use std::time::Instant;

#[derive(Default)]
struct Interner {
    map: FxHashMap<Box<str>, u32>,
    items: Vec<Box<str>>,
    count: Vec<u32>,
}

impl Interner {
    /// Id 0 is the empty string.
    fn with_empty() -> Interner {
        let mut i = Interner::default();
        i.get("");
        i
    }
    fn get(&mut self, s: &str) -> u32 {
        if let Some(&i) = self.map.get(s) {
            self.count[i as usize] += 1;
            return i;
        }
        let i = self.items.len() as u32;
        self.map.insert(s.into(), i);
        self.items.push(s.into());
        self.count.push(1);
        i
    }
}

/// Strings grouped under a normalised key; the most frequent spelling is shown.
struct Keyed {
    raw: Interner,
    key_of: Vec<u32>,
    keys: Interner,
    best: Vec<u32>,
}

impl Keyed {
    fn new() -> Keyed {
        let mut k = Keyed { raw: Interner::with_empty(), key_of: vec![0], keys: Interner::with_empty(), best: Vec::new() };
        k.raw.count[0] = 0;
        k
    }
    fn get(&mut self, s: &str, keyf: impl Fn(&str) -> String) -> u32 {
        let n = self.raw.items.len();
        let r = self.raw.get(s) as usize;
        if r == n {
            let k = self.keys.get(&keyf(s));
            self.key_of.push(k);
        }
        self.key_of[r]
    }
    fn finish(&mut self) {
        self.best = vec![0; self.keys.items.len()];
        self.raw.count[0] = u32::MAX; // the empty key always shows as ""
        let mut best_n = vec![0u32; self.keys.items.len()];
        for (r, &k) in self.key_of.iter().enumerate() {
            if self.raw.count[r] > best_n[k as usize] {
                best_n[k as usize] = self.raw.count[r];
                self.best[k as usize] = r as u32;
            }
        }
    }
    fn display(&self, key: u32) -> &str {
        &self.raw.items[self.best[key as usize] as usize]
    }
}

fn street_key(s: &str) -> String {
    text::tokens(s).join(" ")
}

fn clean_postcode(s: &str) -> &str {
    let s = s.trim();
    if s.is_empty() || s.len() > 8 || !s.bytes().all(|b| b.is_ascii_alphanumeric()) {
        ""
    } else {
        s
    }
}

// ---------------------------------------------------------------------------
// Locality lookup
// ---------------------------------------------------------------------------

const L0_LAT: i32 = 13_500; // ≈ 150 m
const L0_LON: i32 = 19_700;
const KM_LAT: i32 = 90_000; // ≈ 1 km
const KM_LON: i32 = 131_000;

#[derive(Clone, Copy)]
struct Rep {
    pid: u32,
    cid: u32,
    pos: LatLon,
    votes: i32,
}

struct Resolver {
    street_cell: FxHashMap<(u32, i32, i32), (u32, u32)>,
    levels: Vec<FxHashMap<(i32, i32), Rep>>,
}

#[derive(Clone, Copy)]
struct A {
    skey: u32,
    hn: u32,
    pid: u32,
    cid: u32,
    pos: LatLon,
}

impl Resolver {
    fn level_cell(k: usize, p: LatLon) -> (i32, i32) {
        (p.lat.div_euclid(L0_LAT << (2 * k)), p.lon.div_euclid(L0_LON << (2 * k)))
    }

    fn build(addrs: &[A]) -> Resolver {
        let complete = |a: &&A| a.pid != 0 && a.cid != 0;
        let (street_cell, levels) = rayon::join(
            || {
                let mut m: FxHashMap<(u32, i32, i32), (u32, u32)> = FxHashMap::default();
                for a in addrs.iter().filter(complete) {
                    m.entry((a.skey, a.pos.lat.div_euclid(KM_LAT), a.pos.lon.div_euclid(KM_LON))).or_insert((a.pid, a.cid));
                }
                m
            },
            || {
                (0..4usize)
                    .into_par_iter()
                    .map(|k| {
                        // Majority locality per cell by Boyer–Moore voting.
                        let mut m: FxHashMap<(i32, i32), Rep> = FxHashMap::default();
                        for a in addrs.iter().filter(complete) {
                            let e = m.entry(Self::level_cell(k, a.pos)).or_insert(Rep { pid: a.pid, cid: a.cid, pos: a.pos, votes: 0 });
                            if (e.pid, e.cid) == (a.pid, a.cid) {
                                e.votes += 1;
                            } else if e.votes <= 1 {
                                *e = Rep { pid: a.pid, cid: a.cid, pos: a.pos, votes: 1 };
                            } else {
                                e.votes -= 1;
                            }
                        }
                        m
                    })
                    .collect()
            },
        );
        Resolver { street_cell, levels }
    }

    /// Locality of the nearest complete address, coarser grids further out.
    fn locate(&self, p: LatLon) -> Option<(u32, u32)> {
        for (k, m) in self.levels.iter().enumerate() {
            let (cy, cx) = Self::level_cell(k, p);
            let mut best: Option<(f32, (u32, u32))> = None;
            for dy in -1..=1 {
                for dx in -1..=1 {
                    if let Some(r) = m.get(&(cy + dy, cx + dx)) {
                        let d = r.pos.dist_m(&p);
                        if best.is_none_or(|b| d < b.0) {
                            best = Some((d, (r.pid, r.cid)));
                        }
                    }
                }
            }
            if let Some(b) = best {
                return Some(b.1);
            }
        }
        None
    }

    /// Locality of a complete address on a street of this name close by.
    fn locate_street(&self, skey: u32, p: LatLon) -> Option<(u32, u32)> {
        let (cy, cx) = (p.lat.div_euclid(KM_LAT), p.lon.div_euclid(KM_LON));
        for (dy, dx) in [(0, 0), (0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1)] {
            if let Some(&l) = self.street_cell.get(&(skey, cy + dy, cx + dx)) {
                return Some(l);
            }
        }
        None
    }

    fn near(&self, skey: u32, p: LatLon) -> Option<(u32, u32)> {
        (skey != 0).then(|| self.locate_street(skey, p)).flatten().or_else(|| self.locate(p))
    }
}

struct StreetB {
    skey: u32,
    cid: u32,
    /// Way-derived position and locality, used when the street has no houses.
    way_n: u32,
    way_lat: i64,
    way_lon: i64,
    way_pid: u32,
    way_votes: i32,
    way_best: (f32, LatLon),
    // Filled once houses are sorted.
    pos: LatLon,
    loc: u32,
    n_houses: u32,
    multi_pc: bool,
    pids: Vec<u32>,
}


#[derive(Default)]
struct Streets {
    ids: FxHashMap<(u32, u32, i32, i32), u32>,
    list: Vec<StreetB>,
}

impl Streets {
    fn get(&mut self, skey: u32, cid: u32, pos: LatLon) -> u32 {
        // Streets without a known town are kept apart by a 10 km cell.
        let cell = if cid == 0 { (pos.lat.div_euclid(KM_LAT * 10), pos.lon.div_euclid(KM_LON * 10)) } else { (0, 0) };
        let list = &mut self.list;
        *self.ids.entry((skey, cid, cell.0, cell.1)).or_insert_with(|| {
            list.push(StreetB {
                skey,
                cid,
                way_n: 0,
                way_lat: 0,
                way_lon: 0,
                way_pid: 0,
                way_votes: 0,
                way_best: (f32::MAX, LatLon::NONE),
                pos: LatLon::NONE,
                loc: NONE,
                n_houses: 0,
                multi_pc: false,
                pids: Vec::new(),
            });
            list.len() as u32 - 1
        })
    }
}

/// Distinct (postcode, town) pairs.
#[derive(Default)]
struct Locs {
    ids: FxHashMap<(u32, u32), u32>,
    list: Vec<(u32, u32)>,
}

impl Locs {
    fn get(&mut self, pid: u32, cid: u32) -> u32 {
        if pid == 0 && cid == 0 {
            return NONE;
        }
        let list = &mut self.list;
        *self.ids.entry((pid, cid)).or_insert_with(|| {
            list.push((pid, cid));
            list.len() as u32 - 1
        })
    }
}

#[derive(Clone, Copy)]
struct H {
    street: u32,
    hn: u32,
    pos: LatLon,
    loc: u32,
}

struct DocB {
    stat: u8,
    kind: u8,
    src: u32,
}

fn is_canton(s: &str) -> bool {
    matches!(
        s,
        "AG" | "AI" | "AR" | "BE" | "BL" | "BS" | "FR" | "GE" | "GL" | "GR" | "JU" | "LU" | "NE" | "NW" | "OW" | "SG" | "SH" | "SO" | "SZ" | "TG" | "TI" | "UR" | "VD" | "VS" | "ZG" | "ZH"
    )
}

fn stat_u8(score: f32) -> u8 {
    (score * 2.0).round().clamp(0.0, 255.0) as u8
}

pub(crate) fn assemble(tt: &Timetable, raw: &RawData, log: &mut dyn FnMut(String)) -> SearchIndex {
    let t0 = Instant::now();
    let mut ix = SearchIndex { feed_version: tt.feed_version.clone(), n_stations: tt.stations.len() as u32, ..SearchIndex::default() };

    // ---- 1. address strings -------------------------------------------------
    let mut streets_k = Keyed::new();
    let mut cities_k = Keyed::new();
    let mut pcs = Interner::with_empty();
    let mut hns = Interner::default();
    let mut addrs: Vec<A> = Vec::with_capacity(raw.addrs.len());
    for a in &raw.addrs {
        if a.pos.is_none() {
            continue;
        }
        let hn = raw.s(a.hn);
        let skey = streets_k.get(raw.s(a.street), street_key);
        if skey == 0 || hn.is_empty() {
            continue;
        }
        addrs.push(A { skey, hn: hns.get(hn), pid: pcs.get(clean_postcode(raw.s(a.postcode))), cid: cities_k.get(raw.s(a.city), normalize), pos: a.pos });
    }

    // Towns and postcodes tagged on places (interned here so that ids are
    // final before anything is sized by them).
    let poi_pre: Vec<(u32, u32, u32)> = raw
        .pois
        .iter()
        .map(|p| {
            let skey = if p.street.len > 0 { streets_k.keys.map.get(street_key(raw.s(p.street)).as_str()).copied().unwrap_or(0) } else { 0 };
            (skey, pcs.get(clean_postcode(raw.s(p.postcode))), cities_k.get(raw.s(p.city), normalize))
        })
        .collect();

    // ---- 2. fill in missing localities --------------------------------------
    let res = Resolver::build(&addrs);
    let mut pc_votes: FxHashMap<(u32, u32), u32> = FxHashMap::default();
    for a in addrs.iter().filter(|a| a.pid != 0 && a.cid != 0) {
        *pc_votes.entry((a.pid, a.cid)).or_insert(0) += 1;
    }
    let mut pc_city: FxHashMap<u32, (u32, u32)> = FxHashMap::default();
    for (&(pid, cid), &n) in &pc_votes {
        let e = pc_city.entry(pid).or_insert((cid, n));
        if n > e.1 || (n == e.1 && cid < e.0) {
            *e = (cid, n);
        }
    }
    drop(pc_votes);
    let fill = |skey: u32, pid: u32, cid: u32, pos: LatLon| -> (u32, u32) {
        match (pid != 0, cid != 0) {
            (true, true) => (pid, cid),
            (true, false) => (pid, pc_city.get(&pid).map(|c| c.0).or_else(|| res.near(skey, pos).map(|l| l.1)).unwrap_or(0)),
            (false, true) => match res.near(skey, pos) {
                Some((p, c)) if c == cid => (p, cid),
                _ => match res.locate(pos) {
                    Some((p, c)) if c == cid => (p, cid),
                    _ => (0, cid),
                },
            },
            (false, false) => res.near(skey, pos).unwrap_or((0, 0)),
        }
    };
    let n_incomplete = addrs.iter().filter(|a| a.pid == 0 || a.cid == 0).count();
    addrs.par_iter_mut().for_each(|a| {
        if a.pid == 0 || a.cid == 0 {
            let (p, c) = fill(a.skey, a.pid, a.cid, a.pos);
            a.pid = p;
            a.cid = c;
        }
    });
    let n_still = addrs.iter().filter(|a| a.pid == 0 || a.cid == 0).count();
    log(format!(
        "build: {} address points, {} without city or postcode, {} still incomplete after fill-in ({:.1}s)",
        addrs.len(),
        n_incomplete,
        n_still,
        t0.elapsed().as_secs_f32()
    ));

    // ---- 3. streets ---------------------------------------------------------
    let mut streets = Streets::default();
    let mut locs = Locs::default();

    // House numbers ordered like numbers: (leading integer, key, spelling).
    let hn_keys: Vec<String> = hns.items.iter().map(|s| normalize(s)).collect();
    let mut hn_order: Vec<u32> = (0..hns.items.len() as u32).collect();
    hn_order.sort_by(|&a, &b| {
        let (ka, kb) = (&hn_keys[a as usize], &hn_keys[b as usize]);
        (text::leading_int(ka), ka, &hns.items[a as usize]).cmp(&(text::leading_int(kb), kb, &hns.items[b as usize]))
    });
    let mut hn_rank = vec![0u32; hn_order.len()];
    ix.hn_raw = Pool::new();
    ix.hn_key = Pool::new();
    for (rank, &old) in hn_order.iter().enumerate() {
        hn_rank[old as usize] = rank as u32;
        ix.hn_int.push(text::leading_int(&hn_keys[old as usize]));
        ix.hn_raw.push(hns.items[old as usize].as_bytes());
        ix.hn_key.push(hn_keys[old as usize].as_bytes());
    }

    let mut houses: Vec<H> = Vec::with_capacity(addrs.len());
    let mut city_houses: Vec<u32> = vec![0; cities_k.keys.items.len()];
    for a in &addrs {
        let street = streets.get(a.skey, a.cid, a.pos);
        houses.push(H { street, hn: hn_rank[a.hn as usize], pos: a.pos, loc: locs.get(a.pid, a.cid) });
    }
    drop(addrs);
    houses.par_sort_unstable_by_key(|h| (h.street, h.hn, h.pos.lat, h.pos.lon));
    // The same address is often mapped twice (building + entrance, shop + building).
    {
        let mut kept: Vec<H> = Vec::with_capacity(houses.len());
        let mut group = 0usize;
        for h in &houses {
            if kept.last().is_none_or(|l| l.street != h.street || ix.hn_key.get(l.hn as usize) != ix.hn_key.get(h.hn as usize)) {
                group = kept.len();
            }
            if kept[group..].iter().any(|k| k.pos.dist_m(&h.pos) < 100.0) {
                continue;
            }
            kept.push(*h);
        }
        houses = kept;
    }

    // Named ways: join the street of the same name and town, or make a new one.
    let seg_keys: Vec<u32> = raw.segs.iter().map(|s| streets_k.get(raw.s(s.name), street_key)).collect();
    let seg_locs: Vec<(u32, u32)> = raw
        .segs
        .par_iter()
        .zip(seg_keys.par_iter())
        .map(|(s, &skey)| {
            if skey == 0 || s.len == 0 {
                return (0, 0);
            }
            let mid = raw.seg_pts[(s.start + s.len / 2) as usize];
            res.near(skey, mid).unwrap_or((0, 0))
        })
        .collect();
    let mut seg_street: Vec<u32> = vec![NONE; raw.segs.len()];
    for (i, s) in raw.segs.iter().enumerate() {
        if seg_keys[i] == 0 || s.len == 0 {
            continue;
        }
        let pts = &raw.seg_pts[s.start as usize..(s.start + s.len) as usize];
        let (pid, cid) = seg_locs[i];
        let si = streets.get(seg_keys[i], cid, pts[pts.len() / 2]);
        seg_street[i] = si;
        let st = &mut streets.list[si as usize];
        for p in pts {
            st.way_lat += p.lat as i64;
            st.way_lon += p.lon as i64;
        }
        st.way_n += pts.len() as u32;
        if st.way_pid == pid {
            st.way_votes += 1;
        } else if st.way_votes <= 1 {
            st.way_pid = pid;
            st.way_votes = 1;
        } else {
            st.way_votes -= 1;
        }
    }
    drop(seg_locs);
    streets_k.finish();
    cities_k.finish();

    // Street sample points (≈ every 40 m) for reverse geocoding, and the way
    // vertex nearest to the centroid as the position of house-less streets.
    let mut sp: Vec<(LatLon, u32)> = Vec::new();
    for (i, s) in raw.segs.iter().enumerate() {
        let si = seg_street[i];
        if si == NONE {
            continue;
        }
        let pts = &raw.seg_pts[s.start as usize..(s.start + s.len) as usize];
        let st = &mut streets.list[si as usize];
        let c = LatLon { lat: (st.way_lat / st.way_n as i64) as i32, lon: (st.way_lon / st.way_n as i64) as i32 };
        let mut acc = 40.0f32;
        for (j, p) in pts.iter().enumerate() {
            let d = c.dist_m(p);
            if d < st.way_best.0 {
                st.way_best = (d, *p);
            }
            if j > 0 {
                let prev = pts[j - 1];
                let len = prev.dist_m(p);
                if len > 5_000.0 {
                    acc = 40.0;
                    continue;
                }
                let mut at = 40.0 - acc;
                while at < len {
                    sp.push((prev.lerp(p, at / len), si));
                    at += 40.0;
                }
                acc = (acc + len) % 40.0;
            } else {
                sp.push((*p, si));
                acc = 0.0;
            }
        }
    }

    // Per-street facts from the sorted houses.
    ix.house_off = vec![0; streets.list.len() + 1];
    for h in &houses {
        ix.house_off[h.street as usize + 1] += 1;
    }
    for i in 1..ix.house_off.len() {
        ix.house_off[i] += ix.house_off[i - 1];
    }
    let streets = &mut streets.list;
    for (si, st) in streets.iter_mut().enumerate() {
        let hs = &houses[ix.house_off[si] as usize..ix.house_off[si + 1] as usize];
        st.n_houses = hs.len() as u32;
        if hs.is_empty() {
            st.pos = st.way_best.1;
            st.loc = locs.get(st.way_pid, st.cid);
            if st.way_pid != 0 {
                st.pids.push(st.way_pid);
            }
            continue;
        }
        city_houses[st.cid as usize] += hs.len() as u32;
        let (mut la, mut lo) = (0i64, 0i64);
        let mut hl: Vec<u32> = Vec::with_capacity(hs.len());
        for h in hs {
            la += h.pos.lat as i64;
            lo += h.pos.lon as i64;
            hl.push(h.loc);
        }
        let c = LatLon { lat: (la / hs.len() as i64) as i32, lon: (lo / hs.len() as i64) as i32 };
        st.pos = hs.iter().map(|h| h.pos).min_by(|a, b| c.dist_m(a).total_cmp(&c.dist_m(b))).unwrap_or(c);
        hl.sort_unstable();
        let (mut best, mut best_n, mut i) = (NONE, 0, 0);
        while i < hl.len() {
            let j = i + hl[i..].iter().take_while(|&&l| l == hl[i]).count();
            if hl[i] != NONE {
                let pid = locs.list[hl[i] as usize].0;
                if pid != 0 && !st.pids.contains(&pid) && st.pids.len() < 8 {
                    st.pids.push(pid);
                }
                if j - i > best_n {
                    best_n = j - i;
                    best = hl[i];
                }
            }
            i = j;
        }
        st.loc = best;
        st.multi_pc = st.pids.len() > 1;
    }
    log(format!("build: {} streets, {} houses, {} street points ({:.1}s)", streets.len(), houses.len(), sp.len(), t0.elapsed().as_secs_f32()));

    // ---- 4. places ----------------------------------------------------------
    let poi_fill: Vec<(u32, u32, u32)> =
        raw.pois.par_iter().zip(poi_pre.par_iter()).map(|(p, &(skey, pid, cid))| if p.pos.is_none() { (skey, 0, 0) } else { let (a, b) = fill(skey, pid, cid, p.pos); (skey, a, b) }).collect();
    drop(poi_pre);
    let poi_loc: Vec<u32> = poi_fill.iter().map(|&(_, pid, cid)| locs.get(pid, cid)).collect();
    drop(poi_fill);

    // ---- 5. documents in prominence order ------------------------------------
    let max_w = tt.stations.iter().map(|s| s.weight).max().unwrap_or(0).max(1) as f32;
    let mut docs: Vec<DocB> = Vec::with_capacity(tt.stations.len() + raw.pois.len() + streets.len());
    for (i, s) in tt.stations.iter().enumerate() {
        if s.name.trim().is_empty() {
            continue;
        }
        // 45 for a stop nobody serves … 100 for the busiest station in the feed.
        // Weights span four orders of magnitude; the cube-root-ish curve keeps
        // the big stations apart (a logarithm squeezes them all into 90…100).
        let score = 45.0 + 55.0 * (s.weight as f32 / max_w).powf(0.3);
        docs.push(DocB { stat: stat_u8(score), kind: KIND_STATION, src: i as u32 });
    }
    // Unlinked "attractions" inside a theme park or zoo, or eight of them
    // within 300 m, are the exhibits of one site (Swissminiatur's model of the
    // Bundeshaus, a zoo's enclosures), not sights: they must not outrank the
    // real thing of the same name.
    let exhibit_cell = |p: &LatLon| (p.lat.div_euclid(L0_LAT * 2), p.lon.div_euclid(L0_LON * 2));
    let is_plain_attraction = |p: &crate::osm::RawPoi| !p.wiki && !p.pos.is_none() && raw.s(p.label) == "Attraction";
    let mut attraction_cells: FxHashMap<(i32, i32), u32> = FxHashMap::default();
    for p in raw.pois.iter().filter(|p| !p.pos.is_none()) {
        let (y, x) = exhibit_cell(&p.pos);
        if is_plain_attraction(p) {
            *attraction_cells.entry((y, x)).or_insert(0) += 1;
        } else if matches!(raw.s(p.label), "Theme park" | "Zoo" | "Aquarium") {
            for dy in -1..=1 {
                for dx in -1..=1 {
                    *attraction_cells.entry((y + dy, x + dx)).or_insert(0) += 8;
                }
            }
        }
    }
    let is_exhibit = |p: &crate::osm::RawPoi| is_plain_attraction(p) && attraction_cells.get(&exhibit_cell(&p.pos)).is_some_and(|&n| n >= 8);
    for (i, p) in raw.pois.iter().enumerate() {
        if p.pos.is_none() || p.name.len == 0 {
            continue;
        }
        let score = if is_exhibit(p) { 22.0 } else { p.score as f32 };
        docs.push(DocB { stat: stat_u8(score), kind: KIND_POI, src: i as u32 });
    }
    for (i, st) in streets.iter().enumerate() {
        if st.pos.is_none() {
            continue;
        }
        // Long streets and streets of big towns first: 12 … 36.
        let score = 12.0 + (1.2 * (1.0 + st.n_houses as f32).log2()).min(10.0) + (0.8 * (1.0 + city_houses[st.cid as usize] as f32).log2()).min(14.0);
        docs.push(DocB { stat: stat_u8(score), kind: KIND_STREET, src: i as u32 });
    }
    docs.par_sort_unstable_by_key(|d| (std::cmp::Reverse(d.stat), d.kind, d.src));
    let n_docs = docs.len();

    // Localities.
    ix.locs = Pool::new();
    for &(pid, cid) in &locs.list {
        let mut s = String::new();
        s.push_str(&pcs.items[pid as usize]);
        s.push('\x1f');
        s.push_str(cities_k.display(cid));
        ix.locs.push(s.as_bytes());
    }

    // Category labels.
    let mut cat_ids: FxHashMap<&str, u16> = FxHashMap::default();
    ix.cats.push("Place".to_string());
    cat_ids.insert("Place", 0);

    // Places sorted by OSM code for `resolve`.
    let mut poi_sorted: Vec<(u64, u32)> = docs.iter().enumerate().filter(|(_, d)| d.kind == KIND_POI).map(|(di, d)| (raw.pois[d.src as usize].code, di as u32)).collect();
    poi_sorted.par_sort_unstable();
    poi_sorted.dedup_by_key(|p| p.0);
    ix.poi_code = poi_sorted.iter().map(|p| p.0).collect();
    ix.poi_doc = poi_sorted.iter().map(|p| p.1).collect();
    let mut poi_rank = vec![NONE; n_docs];
    for (r, p) in poi_sorted.iter().enumerate() {
        poi_rank[p.1 as usize] = r as u32;
    }
    drop(poi_sorted);

    ix.st_ids = tt.stations.iter().map(|s| s.gtfs_id.clone()).collect();
    ix.st_doc = vec![NONE; tt.stations.len()];
    ix.street_doc = vec![NONE; streets.len()];
    ix.strs = Pool::new();

    // ---- 6. tokens ----------------------------------------------------------
    let mut vocab = Interner::default();
    let mut fwd: Vec<u32> = Vec::with_capacity(n_docs * 7);
    let mut fwd_off: Vec<u32> = Vec::with_capacity(n_docs + 1);
    let mut n_name_of: Vec<u8> = Vec::with_capacity(n_docs);
    let mut toks = Toks::default();
    let mut name_buf = String::new();
    for (di, d) in docs.iter().enumerate() {
        fwd_off.push(fwd.len() as u32);
        let start = fwd.len();
        let mut alt = "";
        let mut keywords = "";
        let mut loc = NONE;
        let mut pids: &[u32] = &[];
        let mut extra_loc = "";
        let mut cat = 0u16;
        let pos;
        let ext;
        name_buf.clear();
        match d.kind {
            KIND_STATION => {
                let s = &tt.stations[d.src as usize];
                name_buf.push_str(s.name.trim());
                // People say "Bern Bahnhof" and "Bern HB" for the station called "Bern".
                if s.modes & kante_core::Mode::Rail.bit() != 0 && !s.name.contains(',') {
                    let one_word = !s.name.trim().contains(' ') || s.name.ends_with(" SBB");
                    keywords = if one_word { "bahnhof gare stazione station hb" } else { "bahnhof gare stazione station" };
                }
                pos = s.pos;
                ext = d.src;
                ix.st_doc[d.src as usize] = di as u32;
            }
            KIND_POI => {
                let p = &raw.pois[d.src as usize];
                name_buf.push_str(raw.s(p.name));
                alt = raw.s(p.alt);
                loc = poi_loc[d.src as usize];
                pos = p.pos;
                ext = poi_rank[di];
                extra_loc = raw.s(p.street);
                let label = if is_exhibit(p) { "Exhibit" } else { raw.s(p.label) };
                keywords = crate::cats::keywords(label);
                let id = match cat_ids.get(label) {
                    Some(&i) => i,
                    None if ix.cats.len() < 4000 && !label.is_empty() => {
                        ix.cats.push(label.to_string());
                        cat_ids.insert(label, ix.cats.len() as u16 - 1);
                        ix.cats.len() as u16 - 1
                    }
                    None => 0,
                };
                cat = id | ((p.class as u16) << 12);
            }
            _ => {
                let st = &streets[d.src as usize];
                name_buf.push_str(streets_k.display(st.skey));
                loc = st.loc;
                pids = &st.pids;
                pos = st.pos;
                ext = d.src;
                cat = st.multi_pc as u16;
                ix.street_doc[d.src as usize] = di as u32;
            }
        }

        // Name tokens, in order.
        toks.clear();
        text::tokenize_into(&name_buf, &mut toks);
        let mut add = |fwd: &mut Vec<u32>, t: &str, cls: u32, keyword: bool, cap: usize| {
            if t.len() > 40 || fwd.len() - start >= cap {
                return;
            }
            let id = vocab.get(t);
            if id < ID_MASK && !fwd[start..].iter().any(|&e| e & ID_MASK == id) {
                let flag = if keyword || (cls == CLS_NAME && text::is_minor(t)) { MINOR } else { 0 };
                fwd.push(id | flag | (cls << CLS_SHIFT));
            }
        };
        for t in toks.iter() {
            add(&mut fwd, t, CLS_NAME, false, 12);
        }
        let n_name = fwd.len() - start;
        n_name_of.push(n_name as u8);
        if d.kind == KIND_STATION {
            // "Bern, Bahnhof" / "Bern Wankdorf": the stop's own name starts after the town.
            // A trailing canton code ("Busswil BE") is not a name of its own.
            let sub = match name_buf.find(',') {
                Some(c) => text::tokens(&name_buf[..c]).len(),
                None if n_name == 2 && name_buf.rsplit(' ').next().is_some_and(is_canton) => 0,
                None => (n_name >= 2) as usize,
            };
            cat = if sub < n_name { sub as u16 } else { 0 };
        }
        if !alt.is_empty() || !keywords.is_empty() {
            toks.clear();
            text::tokenize_into(alt, &mut toks);
            for t in toks.iter() {
                add(&mut fwd, t, CLS_ALT, false, 20);
            }
            toks.clear();
            text::tokenize_into(keywords, &mut toks);
            for t in toks.iter() {
                add(&mut fwd, t, CLS_ALT, true, 28);
            }
        }
        if loc != NONE {
            let (_, cid) = locs.list[loc as usize];
            toks.clear();
            text::tokenize_into(cities_k.display(cid), &mut toks);
            if pids.is_empty() {
                let pc = &pcs.items[locs.list[loc as usize].0 as usize];
                if !pc.is_empty() {
                    text::tokenize_into(pc, &mut toks);
                }
            }
        } else {
            toks.clear();
        }
        for &pid in pids {
            text::tokenize_into(&pcs.items[pid as usize], &mut toks);
        }
        if !extra_loc.is_empty() {
            text::tokenize_into(extra_loc, &mut toks);
        }
        for t in toks.iter() {
            add(&mut fwd, t, CLS_LOC, false, 36);
        }

        // Document row.
        ix.kind.push(d.kind);
        ix.stat.push(d.stat);
        ix.cat.push(cat);
        ix.lat.push(pos.lat);
        ix.lon.push(pos.lon);
        ix.loc.push(loc);
        ix.ext.push(ext);
        if d.kind == KIND_POI {
            let p = &raw.pois[d.src as usize];
            if p.street.len > 0 {
                name_buf.push('\x1f');
                name_buf.push_str(raw.s(p.street));
                if p.hn.len > 0 {
                    name_buf.push(' ');
                    name_buf.push_str(raw.s(p.hn));
                }
            }
        }
        ix.strs.push(name_buf.as_bytes());
    }
    fwd_off.push(fwd.len() as u32);
    drop(poi_rank);
    log(format!("build: {} documents, {} distinct tokens, {} token occurrences ({:.1}s)", n_docs, vocab.items.len(), fwd.len(), t0.elapsed().as_secs_f32()));

    // Sorted vocabulary; remap ids.
    let n_vocab = vocab.items.len();
    let mut order: Vec<u32> = (0..n_vocab as u32).collect();
    order.par_sort_unstable_by(|&a, &b| vocab.items[a as usize].as_bytes().cmp(vocab.items[b as usize].as_bytes()));
    let mut new_id = vec![0u32; n_vocab];
    ix.vocab = Pool::new();
    for (rank, &old) in order.iter().enumerate() {
        new_id[old as usize] = rank as u32;
        ix.vocab.push(vocab.items[old as usize].as_bytes());
    }
    drop(vocab);
    fwd.par_iter_mut().for_each(|e| *e = new_id[(*e & ID_MASK) as usize] | (*e & !ID_MASK));
    drop(new_id);

    // Inverted lists by counting sort; documents arrive in ascending order.
    let mut ncount = vec![0u32; n_vocab + 1];
    let mut lcount = vec![0u32; n_vocab + 1];
    for &e in &fwd {
        if e >> CLS_SHIFT == CLS_LOC {
            lcount[(e & ID_MASK) as usize + 1] += 1;
        } else {
            ncount[(e & ID_MASK) as usize + 1] += 1;
        }
    }
    for i in 1..=n_vocab {
        ncount[i] += ncount[i - 1];
        lcount[i] += lcount[i - 1];
    }
    let mut npost = vec![0u32; ncount[n_vocab] as usize];
    let mut lpost = vec![0u32; lcount[n_vocab] as usize];
    {
        let (mut nc, mut lc) = (ncount.clone(), lcount.clone());
        for di in 0..n_docs {
            for &e in &fwd[fwd_off[di] as usize..fwd_off[di + 1] as usize] {
                let id = (e & ID_MASK) as usize;
                match e >> CLS_SHIFT {
                    CLS_LOC => {
                        lpost[lc[id] as usize] = di as u32;
                        lc[id] += 1;
                    }
                    cls => {
                        let sole = cls == CLS_NAME && n_name_of[di] == 1;
                        let keyword = cls == CLS_ALT && e & MINOR != 0;
                        npost[nc[id] as usize] = di as u32 | if sole { SOLE } else { 0 } | if keyword { KEYWORD } else { 0 };
                        nc[id] += 1;
                    }
                }
            }
        }
    }

    // Top lists for prefixes too frequent to scan.
    let mut heavy: Vec<(Vec<u8>, Vec<u32>)> = Vec::new();
    for l in 1..=HEAVY_MAX_LEN {
        let mut i = 0;
        while i < n_vocab {
            let t = ix.vocab.get(i);
            if t.len() < l {
                i += 1;
                continue;
            }
            let p = &t[..l];
            let mut j = i + 1;
            while j < n_vocab && ix.vocab.get(j).starts_with(p) {
                j += 1;
            }
            let range = &npost[ncount[i] as usize..ncount[j] as usize];
            if range.len() > HEAVY_MIN {
                // A short prefix does not reach category keywords (see `KEYWORD`).
                let mut v: Vec<u32> = range.iter().filter(|&&d| l >= KEYWORD_MIN_PREFIX || d & KEYWORD == 0).map(|&d| d & POST_MASK).collect();
                let keep = HEAVY_TOP * 4;
                if v.len() > keep {
                    v.select_nth_unstable(keep);
                    v.truncate(keep);
                }
                v.sort_unstable();
                v.dedup();
                v.truncate(HEAVY_TOP);
                heavy.push((p.to_vec(), v));
            }
            i = j;
        }
    }
    heavy.sort();
    ix.heavy_keys = Pool::new();
    ix.heavy_off.push(0);
    for (k, v) in &heavy {
        ix.heavy_keys.push(k);
        ix.heavy.extend_from_slice(v);
        ix.heavy_off.push(ix.heavy.len() as u32);
    }
    drop(heavy);

    let mut rev: Vec<u32> = (0..n_vocab as u32).collect();
    rev.par_sort_unstable_by(|&a, &b| ix.vocab.get(a as usize).iter().rev().cmp(ix.vocab.get(b as usize).iter().rev()));
    ix.vocab_rev = rev;
    ix.npost_off = ncount;
    ix.npost = npost;
    ix.lpost_off = lcount;
    ix.lpost = lpost;
    ix.fwd_off = fwd_off;
    ix.fwd = fwd;

    let mut st_sorted: Vec<u32> = (0..tt.stations.len() as u32).filter(|&i| ix.st_doc[i as usize] != NONE).collect();
    st_sorted.sort_by(|&a, &b| ix.st_ids[a as usize].cmp(&ix.st_ids[b as usize]));
    ix.st_sorted = st_sorted;

    // ---- 7. houses and space -------------------------------------------------
    ix.h_lat = houses.iter().map(|h| h.pos.lat).collect();
    ix.h_lon = houses.iter().map(|h| h.pos.lon).collect();
    ix.h_hn = houses.iter().map(|h| h.hn).collect();
    ix.h_loc = houses.iter().map(|h| h.loc).collect();
    let n_houses = houses.len() as u32;
    let mut pts: Vec<(LatLon, u32)> = Vec::with_capacity(houses.len() + sp.len());
    pts.extend(houses.iter().enumerate().map(|(i, h)| (h.pos, i as u32)));
    drop(houses);
    pts.extend(sp.iter().enumerate().map(|(i, s)| (s.0, n_houses + i as u32)));
    ix.fine = Grid::build(&pts, L0_LAT, L0_LON);
    drop(pts);
    // Street points are only ever reached through the grid: store them in grid order.
    for it in ix.fine.items.iter_mut() {
        if *it >= n_houses {
            let (p, street) = sp[(*it - n_houses) as usize];
            *it = n_houses + ix.sp_lat.len() as u32;
            ix.sp_lat.push(p.lat);
            ix.sp_lon.push(p.lon);
            ix.sp_street.push(street);
        }
    }
    drop(sp);
    let dpts: Vec<(LatLon, u32)> = (0..n_docs).map(|d| (LatLon { lat: ix.lat[d], lon: ix.lon[d] }, d as u32)).collect();
    ix.dgrid = Grid::build(&dpts, 45_000, 65_700);

    log(format!("build: index assembled in {:.1}s", t0.elapsed().as_secs_f32()));
    ix
}
