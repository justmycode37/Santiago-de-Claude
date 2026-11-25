//! The network vehicles run on, from OpenStreetMap: rails, tram tracks, roads buses may use, ferry lines and
//! aerialways, joined at their junctions, with the public transport route relations (PTv2: `type=route`,
//! `route=bus|tram|train|…`, `ref`=the line) whose ways they are.
//!
//! An edge is a piece of one way between two junctions (a node more than one way uses, or a way's end), with its
//! polyline. Coordinates are planar metres ([`LatLon::xy`]). Only the build uses this: the server loads the
//! finished paths ([`crate::Shapes`]), not the network.

use anyhow::{Context, Result};
use kante_core::geo::LatLon;
use osmpbf::{BlobDecode, BlobReader, PrimitiveBlock, RelMemberType};
use rayon::prelude::*;
use rustc_hash::FxHashMap;
use std::path::Path;

// Way classes.
pub const MOTORWAY: u8 = 0;
pub const TRUNK: u8 = 1;
pub const PRIMARY: u8 = 2;
pub const SECONDARY: u8 = 3;
pub const TERTIARY: u8 = 4;
pub const UNCLASSIFIED: u8 = 5;
pub const RESIDENTIAL: u8 = 6;
pub const LIVING: u8 = 7;
pub const SERVICE: u8 = 8;
pub const BUSWAY: u8 = 9;
pub const TRACK: u8 = 10;
pub const RAIL: u8 = 11;
pub const NARROW: u8 = 12;
pub const LIGHT: u8 = 13;
pub const TRAM: u8 = 14;
pub const SUBWAY: u8 = 15;
pub const FUNI: u8 = 16;
pub const FERRY: u8 = 17;
pub const AERIAL: u8 = 18;
pub const NCLASS: usize = 19;

/// The classes on rails (sharp kinks at a node are switches taken backwards: not allowed, see `Profile::max_turn`).
pub fn is_rail(c: u8) -> bool {
    (RAIL..=FUNI).contains(&c)
}

// Edge flags. "Forward" is from node a to node b.
pub const F_FWD: u8 = 1;
pub const F_BWD: u8 = 2;
/// Allowed, but against a one-way: costs extra.
pub const F_FWD_WRONG: u8 = 4;
pub const F_BWD_WRONG: u8 = 8;
/// A restricted road, a parking aisle, a siding or yard track: costs extra.
pub const F_PENAL: u8 = 16;

// Kinds of route relation (bits).
pub const RK_BUS: u8 = 1;
pub const RK_TRAM: u8 = 2;
pub const RK_TRAIN: u8 = 4;
pub const RK_SUBWAY: u8 = 8;
pub const RK_FERRY: u8 = 16;
pub const RK_FUNI: u8 = 32;
pub const RK_AERIAL: u8 = 64;

pub fn route_kind(route: &str) -> u8 {
    match route {
        "bus" | "trolleybus" | "coach" | "share_taxi" | "minibus" => RK_BUS,
        "tram" => RK_TRAM,
        "train" => RK_TRAIN,
        "subway" | "light_rail" | "monorail" => RK_SUBWAY,
        "ferry" => RK_FERRY,
        "funicular" => RK_FUNI,
        "aerialway" | "gondola" | "cable_car" | "chair_lift" => RK_AERIAL,
        _ => 0,
    }
}

/// A line name as a route relation's `ref` or the timetable writes it, compared without spaces, dashes and case:
/// "IC 1" = "IC1", "S 3" = "s3".
pub fn norm_ref(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace() && *c != '-' && *c != '_').flat_map(|c| c.to_uppercase()).collect()
}

/// A platform number as `railway:track_ref` or a stop's label writes it: "07" = "7", "3a" = "3A".
pub fn norm_track(s: &str) -> String {
    let t = s.trim().trim_start_matches('0');
    let t = if t.is_empty() && !s.trim().is_empty() { "0" } else { t };
    t.chars().filter(|c| !c.is_whitespace()).flat_map(|c| c.to_uppercase()).collect()
}

pub struct RouteRel {
    pub id: i64,
    pub kind: u8,
    /// [`norm_ref`] of `ref` ("" when it has none).
    pub line_ref: String,
}

pub const NO_TRACK: u32 = u32::MAX;

pub struct Net {
    /// Junction positions, planar metres.
    pub node_xy: Vec<[f32; 2]>,
    pub ea: Vec<u32>,
    pub eb: Vec<u32>,
    /// Metres.
    pub e_len: Vec<f32>,
    pub e_class: Vec<u8>,
    pub e_flags: Vec<u8>,
    /// The way record the edge is a piece of.
    pub e_way: Vec<u32>,
    /// Edge `e`'s polyline is `pts[e_geom[e]..e_geom[e + 1]]`, from `ea` to `eb`.
    pub e_geom: Vec<u32>,
    pub pts: Vec<[f32; 2]>,
    /// Directed edges (`e * 2 + dir`, dir 0 = from a to b) leaving each node.
    pub adj_off: Vec<u32>,
    pub adj: Vec<u32>,
    /// Per way record: index into `tracks` of its `railway:track_ref`, or [`NO_TRACK`].
    pub way_track: Vec<u32>,
    pub tracks: Vec<String>,
    /// Per way record: the kinds of route relation it is a member of.
    pub way_kinds: Vec<u8>,
    pub rels: Vec<RouteRel>,
    /// Relation `r`'s member ways, in member order: `rel_mem[rel_mem_off[r]..rel_mem_off[r + 1]]` (way records).
    pub rel_mem_off: Vec<u32>,
    pub rel_mem: Vec<u32>,
    /// Per way record: (relation, position in its member list), `way_rel[way_rel_off[w]..way_rel_off[w + 1]]`.
    pub way_rel_off: Vec<u32>,
    pub way_rel: Vec<(u32, u32)>,
    pub grid: Grid,
}

/// Segments by 100 m cells.
pub struct Grid {
    pub x0: f32,
    pub y0: f32,
    pub cell: f32,
    pub nx: usize,
    pub ny: usize,
    pub off: Vec<u32>,
    /// (edge, segment index within the edge)
    pub items: Vec<(u32, u32)>,
}

impl Grid {
    #[inline]
    pub fn cx(&self, x: f32) -> usize {
        (((x - self.x0) / self.cell).floor().max(0.0) as usize).min(self.nx - 1)
    }
    #[inline]
    pub fn cy(&self, y: f32) -> usize {
        (((y - self.y0) / self.cell).floor().max(0.0) as usize).min(self.ny - 1)
    }
    /// Every (edge, segment) in the cells around `p` within `r` metres (a segment may come more than once).
    pub fn around(&self, p: [f32; 2], r: f32, mut f: impl FnMut(u32, u32)) {
        if self.nx == 0 {
            return;
        }
        let (x0, x1, y0, y1) = (self.cx(p[0] - r), self.cx(p[0] + r), self.cy(p[1] - r), self.cy(p[1] + r));
        for y in y0..=y1 {
            for x in x0..=x1 {
                let c = y * self.nx + x;
                for &(e, s) in &self.items[self.off[c] as usize..self.off[c + 1] as usize] {
                    f(e, s);
                }
            }
        }
    }
}

/// The point of segment `a`–`b` nearest to `p`: (distance, fraction along the segment).
#[inline]
pub fn project(p: [f32; 2], a: [f32; 2], b: [f32; 2]) -> (f32, f32) {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    let (qx, qy) = (a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
    ((qx * qx + qy * qy).sqrt(), t)
}

#[inline]
pub fn dist(a: [f32; 2], b: [f32; 2]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

pub fn xy(p: &LatLon) -> [f32; 2] {
    let (x, y) = p.xy();
    [x, y]
}

impl Net {
    pub fn n_edges(&self) -> usize {
        self.ea.len()
    }
    #[inline]
    pub fn geom(&self, e: usize) -> &[[f32; 2]] {
        &self.pts[self.e_geom[e] as usize..self.e_geom[e + 1] as usize]
    }
    #[inline]
    pub fn leaving(&self, n: u32) -> &[u32] {
        &self.adj[self.adj_off[n as usize] as usize..self.adj_off[n as usize + 1] as usize]
    }
    /// Directed edge `de`'s start and end node.
    #[inline]
    pub fn de_nodes(&self, de: u32) -> (u32, u32) {
        let e = (de >> 1) as usize;
        if de & 1 == 0 {
            (self.ea[e], self.eb[e])
        } else {
            (self.eb[e], self.ea[e])
        }
    }
    /// The direction (unit vector) a vehicle on directed edge `de` leaves its start / reaches its end with.
    pub fn de_heading(&self, de: u32, at_end: bool) -> [f32; 2] {
        let g = self.geom((de >> 1) as usize);
        let n = g.len();
        let fwd = de & 1 == 0;
        // the segment at the asked end, as driven
        let (p, q) = match (fwd, at_end) {
            (true, false) => (g[0], g[1]),
            (true, true) => (g[n - 2], g[n - 1]),
            (false, false) => (g[n - 1], g[n - 2]),
            (false, true) => (g[1], g[0]),
        };
        let (dx, dy) = (q[0] - p[0], q[1] - p[1]);
        let l = (dx * dx + dy * dy).sqrt().max(1e-6);
        [dx / l, dy / l]
    }
    /// Metres from `a` along edge `e` to the point at fraction `t` of segment `seg`.
    pub fn offset_of(&self, e: usize, seg: usize, t: f32) -> f32 {
        let g = self.geom(e);
        let mut m = 0.0;
        for k in 0..seg {
            m += dist(g[k], g[k + 1]);
        }
        m + t * dist(g[seg], g[seg + 1])
    }
    /// The polyline of edge `e` between offsets `from` and `to` (metres from `a`; `from > to` runs backwards).
    pub fn cut(&self, e: usize, from: f32, to: f32, out: &mut Vec<[f32; 2]>) {
        let g = self.geom(e);
        let point_at = |m: f32| -> [f32; 2] {
            let mut acc = 0.0;
            for k in 0..g.len() - 1 {
                let l = dist(g[k], g[k + 1]);
                if acc + l >= m || k == g.len() - 2 {
                    let t = if l > 0.0 { ((m - acc) / l).clamp(0.0, 1.0) } else { 0.0 };
                    return [g[k][0] + t * (g[k + 1][0] - g[k][0]), g[k][1] + t * (g[k + 1][1] - g[k][1])];
                }
                acc += l;
            }
            g[g.len() - 1]
        };
        let (lo, hi) = (from.min(to), from.max(to));
        let mut part = vec![point_at(lo)];
        let mut acc = 0.0;
        for k in 0..g.len() - 1 {
            acc += dist(g[k], g[k + 1]);
            if acc > lo && acc < hi && k + 1 < g.len() - 1 {
                part.push(g[k + 1]);
            }
        }
        part.push(point_at(hi));
        if from > to {
            part.reverse();
        }
        out.extend(part);
    }
}

// ---------------------------------------------------------------- reading the PBF

fn for_each_block<T: Send>(pbf: &Path, f: impl Fn(&PrimitiveBlock) -> Option<T> + Sync + Send) -> Result<Vec<T>> {
    let reader = BlobReader::from_path(pbf).with_context(|| format!("open {}", pbf.display()))?;
    let res: Result<Vec<Option<T>>> = reader
        .par_bridge()
        .map(|blob| -> Result<Option<T>> {
            let blob = blob?;
            match blob.decode()? {
                BlobDecode::OsmData(block) => Ok(f(&block)),
                _ => Ok(None),
            }
        })
        .collect();
    Ok(res?.into_iter().flatten().collect())
}

struct RelRaw {
    id: i64,
    kind: u8,
    line_ref: String,
    ways: Vec<i64>,
}

struct WayRec {
    id: i64,
    class: u8,
    flags: u8,
    track: String,
    refs: Vec<i64>,
}

/// Which graph classes a way belongs to (a way can be both a road and a tram track), and its `railway:track_ref`.
/// `kinds`: the kinds of route relation the way is a member of (a bus route on a footway makes it a bus way).
pub(crate) fn classify<'a>(tags: impl Iterator<Item = (&'a str, &'a str)>, kinds: u8) -> (Vec<(u8, u8)>, String) {
    let (mut highway, mut railway, mut route, mut oneway, mut junction, mut aerialway) = ("", "", "", "", "", "");
    let (mut access, mut vehicle, mut motor_vehicle, mut bus, mut psv, mut service, mut track) = ("", "", "", "", "", "", "");
    let (mut area, mut tram_oneway, mut construction) = (false, "", "");
    let mut contra = false; // buses may run against the one-way
    for (k, v) in tags {
        match k {
            "highway" => highway = v,
            "railway" => railway = v,
            "route" => route = v,
            "aerialway" => aerialway = v,
            "oneway" => oneway = v,
            "railway:oneway" | "oneway:tram" => tram_oneway = v,
            "junction" => junction = v,
            "access" => access = v,
            "vehicle" => vehicle = v,
            "motor_vehicle" => motor_vehicle = v,
            "bus" => bus = v,
            "psv" => psv = v,
            "service" => service = v,
            "railway:track_ref" => track = v,
            "construction" | "construction:railway" => construction = v,
            "area" => area = v == "yes",
            "oneway:bus" | "oneway:psv" => contra |= v == "no",
            "busway" | "busway:left" | "busway:right" | "busway:both" => contra |= v == "opposite_lane" || v == "opposite",
            "lanes:bus:backward" | "lanes:psv:backward" => contra = true,
            "bus:backward" | "psv:backward" => contra |= v == "yes" || v == "designated",
            _ => {}
        }
    }
    let mut out = Vec::new();
    let both = F_FWD | F_BWD;
    if area {
        return (out, String::new());
    }

    // track being rebuilt (or still tagged so after it reopened): usable, at a cost
    let (railway, rebuilt) = if railway == "construction" && !construction.is_empty() { (construction, true) } else { (railway, false) };
    let rail_class = match railway {
        "rail" => Some(RAIL),
        "narrow_gauge" => Some(NARROW),
        "light_rail" | "monorail" => Some(LIGHT),
        "tram" => Some(TRAM),
        "subway" => Some(SUBWAY),
        "funicular" => Some(FUNI),
        _ => None,
    };
    if let Some(c) = rail_class {
        let siding = matches!(service, "yard" | "siding" | "spur");
        let mut f = both | if siding || rebuilt { F_PENAL } else { 0 };
        // a tram track mapped one way (a turning loop, a single track per direction): the other way costs extra
        if c == TRAM {
            match if tram_oneway.is_empty() { oneway } else { tram_oneway } {
                "yes" | "true" | "1" => f |= F_BWD_WRONG,
                "-1" | "reverse" => f |= F_FWD_WRONG,
                _ => {}
            }
        }
        out.push((c, f));
    }
    if route == "ferry" {
        out.push((FERRY, both));
    }
    if matches!(aerialway, "cable_car" | "gondola" | "mixed_lift" | "chair_lift" | "funicular") {
        out.push((AERIAL, both));
    }

    let yes = |v: &str| matches!(v, "yes" | "designated" | "official" | "permissive");
    let bus_ok = yes(bus) || yes(psv) || kinds & RK_BUS != 0;
    let road_class = match highway {
        "motorway" | "motorway_link" => Some(MOTORWAY),
        "trunk" | "trunk_link" => Some(TRUNK),
        "primary" | "primary_link" => Some(PRIMARY),
        "secondary" | "secondary_link" => Some(SECONDARY),
        "tertiary" | "tertiary_link" => Some(TERTIARY),
        "unclassified" | "road" => Some(UNCLASSIFIED),
        "residential" => Some(RESIDENTIAL),
        "living_street" => Some(LIVING),
        "service" => Some(SERVICE),
        "busway" | "bus_guideway" => Some(BUSWAY),
        "pedestrian" if bus_ok => Some(LIVING),
        "track" | "path" | "footway" | "cycleway" if bus_ok => Some(TRACK),
        _ => None,
    };
    if let Some(c) = road_class {
        let no = |v: &str| matches!(v, "no" | "private");
        let restricted = !bus_ok && (no(access) || no(vehicle) || no(motor_vehicle) || bus == "no");
        let aisle = c == SERVICE && matches!(service, "parking_aisle" | "driveway" | "drive-through");
        let roundabout = matches!(junction, "roundabout" | "circular");
        let dir = match oneway {
            "yes" | "true" | "1" => 1,
            "-1" | "reverse" => -1,
            "no" | "false" | "0" => 0,
            _ => {
                if highway == "motorway" || roundabout {
                    1
                } else {
                    0
                }
            }
        };
        let strict = c == MOTORWAY || roundabout;
        let mut f = if dir == 0 || (contra && !strict) {
            both
        } else if dir == 1 {
            if strict {
                F_FWD
            } else {
                both | F_BWD_WRONG
            }
        } else if strict {
            F_BWD
        } else {
            both | F_FWD_WRONG
        };
        if restricted || aisle {
            f |= F_PENAL;
        }
        out.push((c, f));
    }
    let track = if rail_class.is_some() { norm_track(track.split(';').next().unwrap_or("")) } else { String::new() };
    (out, track)
}

fn merge<T>(mut a: Vec<T>, mut b: Vec<T>) -> Vec<T> {
    if a.len() < b.len() {
        std::mem::swap(&mut a, &mut b);
    }
    a.append(&mut b);
    a
}

pub fn load(pbf: &Path) -> Result<Net> {
    let t0 = std::time::Instant::now();
    // 1. route relations
    let mut rels: Vec<RelRaw> = for_each_block(pbf, |block| {
        let mut v = Vec::new();
        for g in block.groups() {
            for r in g.relations() {
                let (mut ty, mut route, mut rf) = ("", "", "");
                for (k, val) in r.tags() {
                    match k {
                        "type" => ty = val,
                        "route" => route = val,
                        "ref" => rf = val,
                        _ => {}
                    }
                }
                if ty != "route" {
                    continue;
                }
                let kind = route_kind(route);
                if kind == 0 {
                    continue;
                }
                let ways: Vec<i64> = r
                    .members()
                    .filter(|m| m.member_type == RelMemberType::Way && !m.role().unwrap_or("").starts_with("platform"))
                    .map(|m| m.member_id)
                    .collect();
                if !ways.is_empty() {
                    v.push(RelRaw { id: r.id(), kind, line_ref: norm_ref(rf), ways });
                }
            }
        }
        (!v.is_empty()).then_some(v)
    })?
    .into_iter()
    .fold(Vec::new(), merge);
    rels.sort_by_key(|r| r.id);
    // way id → kinds of the relations it is in
    let mut member_kinds: Vec<(i64, u8)> = rels.iter().flat_map(|r| r.ways.iter().map(move |&w| (w, r.kind))).collect();
    member_kinds.sort_unstable();
    member_kinds.dedup();
    let kinds_of = |id: i64| -> u8 {
        let i = member_kinds.partition_point(|x| x.0 < id);
        member_kinds[i..].iter().take_while(|x| x.0 == id).fold(0, |a, x| a | x.1)
    };
    eprintln!("   {} route relations ({:.1}s)", rels.len(), t0.elapsed().as_secs_f32());

    // 2. ways
    let mut ways: Vec<WayRec> = for_each_block(pbf, |block| {
        let mut v = Vec::new();
        for g in block.groups() {
            for w in g.ways() {
                let (cls, track) = classify(w.tags(), kinds_of(w.id()));
                if cls.is_empty() {
                    continue;
                }
                let refs: Vec<i64> = w.refs().collect();
                if refs.len() < 2 {
                    continue;
                }
                for (class, flags) in cls {
                    v.push(WayRec { id: w.id(), class, flags, track: track.clone(), refs: refs.clone() });
                }
            }
        }
        (!v.is_empty()).then_some(v)
    })?
    .into_iter()
    .fold(Vec::new(), merge);
    ways.sort_by(|a, b| a.id.cmp(&b.id).then(a.class.cmp(&b.class)));
    eprintln!("   {} way records ({:.1}s)", ways.len(), t0.elapsed().as_secs_f32());

    // 3. nodes
    let mut ids: Vec<i64> = ways.iter().flat_map(|w| w.refs.iter().copied()).collect();
    ids.par_sort_unstable();
    ids.dedup();
    let n = ids.len();
    let ids_ref = &ids;
    let found: Vec<(u32, [f32; 2])> = for_each_block(pbf, |block| {
        let mut v = Vec::new();
        for g in block.groups() {
            for nd in g.dense_nodes() {
                if let Ok(i) = ids_ref.binary_search(&nd.id()) {
                    v.push((i as u32, xy(&LatLon::from_deg(nd.lat(), nd.lon()))));
                }
            }
            for nd in g.nodes() {
                if let Ok(i) = ids_ref.binary_search(&nd.id()) {
                    v.push((i as u32, xy(&LatLon::from_deg(nd.lat(), nd.lon()))));
                }
            }
        }
        (!v.is_empty()).then_some(v)
    })?
    .into_iter()
    .fold(Vec::new(), merge);
    let mut pos = vec![[f32::NAN; 2]; n];
    for (i, p) in found {
        pos[i as usize] = p;
    }
    eprintln!("   {} nodes ({:.1}s)", n, t0.elapsed().as_secs_f32());

    // junctions: nodes used by more than one way record (or twice by one), and every way's ends
    let mut uses = vec![0u8; n];
    let idx: Vec<Vec<u32>> = ways.par_iter().map(|w| w.refs.iter().map(|r| ids.binary_search(r).unwrap() as u32).collect()).collect();
    for wi in &idx {
        for &i in wi {
            uses[i as usize] = uses[i as usize].saturating_add(1);
        }
        uses[wi[0] as usize] = uses[wi[0] as usize].saturating_add(1);
        uses[wi[wi.len() - 1] as usize] = uses[wi[wi.len() - 1] as usize].saturating_add(1);
    }
    let mut node_of = vec![u32::MAX; n];
    let mut node_xy: Vec<[f32; 2]> = Vec::new();
    let mut junction = |i: u32, node_xy: &mut Vec<[f32; 2]>| -> u32 {
        if node_of[i as usize] == u32::MAX {
            node_of[i as usize] = node_xy.len() as u32;
            node_xy.push(pos[i as usize]);
        }
        node_of[i as usize]
    };
    let (mut ea, mut eb, mut e_len, mut e_class, mut e_flags, mut e_way, mut e_geom, mut pts) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), vec![0u32], Vec::new());
    let mut tracks: Vec<String> = Vec::new();
    let mut track_ix: FxHashMap<String, u32> = FxHashMap::default();
    let mut way_track = Vec::with_capacity(ways.len());
    for w in &ways {
        way_track.push(if w.track.is_empty() {
            NO_TRACK
        } else {
            *track_ix.entry(w.track.clone()).or_insert_with(|| {
                tracks.push(w.track.clone());
                tracks.len() as u32 - 1
            })
        });
    }
    for (wn, wi) in idx.iter().enumerate() {
        let w = &ways[wn];
        let mut start: Option<u32> = None; // raw node index where the current edge began
        let mut chain: Vec<[f32; 2]> = Vec::new();
        let mut len = 0.0f32;
        for (k, &i) in wi.iter().enumerate() {
            let p = pos[i as usize];
            if p[0].is_nan() {
                // a node outside the extract: the edge ends at the node before
                if let (Some(s), true) = (start, chain.len() >= 2) {
                    let last = wi[k - 1];
                    let (a, b) = (junction(s, &mut node_xy), junction(last, &mut node_xy));
                    ea.push(a);
                    eb.push(b);
                    e_len.push(len);
                    e_class.push(w.class);
                    e_flags.push(w.flags);
                    e_way.push(wn as u32);
                    pts.extend_from_slice(&chain);
                    e_geom.push(pts.len() as u32);
                }
                start = None;
                chain.clear();
                len = 0.0;
                continue;
            }
            if let Some(&q) = chain.last() {
                len += dist(q, p);
            }
            if start.is_none() {
                start = Some(i);
            }
            chain.push(p);
            let is_end = k + 1 == wi.len();
            if chain.len() >= 2 && (uses[i as usize] >= 2 || is_end) {
                let s = start.unwrap();
                if s != i || len > 0.0 {
                    let (a, b) = (junction(s, &mut node_xy), junction(i, &mut node_xy));
                    ea.push(a);
                    eb.push(b);
                    e_len.push(len.max(0.01));
                    e_class.push(w.class);
                    e_flags.push(w.flags);
                    e_way.push(wn as u32);
                    pts.extend_from_slice(&chain);
                    e_geom.push(pts.len() as u32);
                }
                start = Some(i);
                chain.clear();
                chain.push(p);
                len = 0.0;
            }
        }
    }
    drop(idx);
    drop(pos);
    let ne = ea.len();
    let nn = node_xy.len();

    let mut adj_off = vec![0u32; nn + 1];
    for e in 0..ne {
        adj_off[ea[e] as usize + 1] += 1;
        adj_off[eb[e] as usize + 1] += 1;
    }
    for i in 0..nn {
        adj_off[i + 1] += adj_off[i];
    }
    let mut fill = adj_off.clone();
    let mut adj = vec![0u32; 2 * ne];
    for e in 0..ne {
        let (a, b) = (ea[e] as usize, eb[e] as usize);
        adj[fill[a] as usize] = (e as u32) << 1;
        fill[a] += 1;
        adj[fill[b] as usize] = (e as u32) << 1 | 1;
        fill[b] += 1;
    }

    // relations: member ways as way records, in member order
    let way_ids: Vec<i64> = ways.iter().map(|w| w.id).collect();
    let mut out_rels = Vec::with_capacity(rels.len());
    let mut rel_mem_off = vec![0u32];
    let mut rel_mem = Vec::new();
    for r in &rels {
        for &w in &r.ways {
            let i = way_ids.partition_point(|&x| x < w);
            for j in i..way_ids.len() {
                if way_ids[j] != w {
                    break;
                }
                rel_mem.push(j as u32);
            }
        }
        rel_mem_off.push(rel_mem.len() as u32);
        out_rels.push(RouteRel { id: r.id, kind: r.kind, line_ref: r.line_ref.clone() });
    }
    let nw = ways.len();
    let mut way_kinds = vec![0u8; nw];
    let mut way_rel_off = vec![0u32; nw + 1];
    for (ri, r) in out_rels.iter().enumerate() {
        for &w in &rel_mem[rel_mem_off[ri] as usize..rel_mem_off[ri + 1] as usize] {
            way_kinds[w as usize] |= r.kind;
            way_rel_off[w as usize + 1] += 1;
        }
    }
    for i in 0..nw {
        way_rel_off[i + 1] += way_rel_off[i];
    }
    let mut fill = way_rel_off.clone();
    let mut way_rel = vec![(0u32, 0u32); way_rel_off[nw] as usize];
    for ri in 0..out_rels.len() {
        let (a, b) = (rel_mem_off[ri] as usize, rel_mem_off[ri + 1] as usize);
        for (pos, &w) in rel_mem[a..b].iter().enumerate() {
            way_rel[fill[w as usize] as usize] = (ri as u32, pos as u32);
            fill[w as usize] += 1;
        }
    }
    drop(ways);

    // the grid over segments
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for p in &pts {
        x0 = x0.min(p[0]);
        y0 = y0.min(p[1]);
        x1 = x1.max(p[0]);
        y1 = y1.max(p[1]);
    }
    let cell = 100.0;
    let (nx, ny) = if pts.is_empty() { (0, 0) } else { (((x1 - x0) / cell) as usize + 1, ((y1 - y0) / cell) as usize + 1) };
    let mut grid = Grid { x0, y0, cell, nx, ny, off: vec![0u32; nx * ny + 1], items: Vec::new() };
    if nx > 0 {
        let cells = |g: &Grid, a: [f32; 2], b: [f32; 2]| (g.cx(a[0].min(b[0])), g.cx(a[0].max(b[0])), g.cy(a[1].min(b[1])), g.cy(a[1].max(b[1])));
        for e in 0..ne {
            let g = &pts[e_geom[e] as usize..e_geom[e + 1] as usize];
            for s in 0..g.len() - 1 {
                let (cx0, cx1, cy0, cy1) = cells(&grid, g[s], g[s + 1]);
                for y in cy0..=cy1 {
                    for x in cx0..=cx1 {
                        grid.off[y * nx + x + 1] += 1;
                    }
                }
            }
        }
        for i in 0..nx * ny {
            grid.off[i + 1] += grid.off[i];
        }
        let mut fill = grid.off.clone();
        let mut items = vec![(0u32, 0u32); grid.off[nx * ny] as usize];
        for e in 0..ne {
            let g = &pts[e_geom[e] as usize..e_geom[e + 1] as usize];
            for s in 0..g.len() - 1 {
                let (cx0, cx1, cy0, cy1) = cells(&grid, g[s], g[s + 1]);
                for y in cy0..=cy1 {
                    for x in cx0..=cx1 {
                        let c = y * nx + x;
                        items[fill[c] as usize] = (e as u32, s as u32);
                        fill[c] += 1;
                    }
                }
            }
        }
        grid.items = items;
    }
    eprintln!(
        "   network: {} junctions, {} edges, {} points, {} route relations; {:.1}s",
        nn,
        ne,
        pts.len(),
        out_rels.len(),
        t0.elapsed().as_secs_f32()
    );
    Ok(Net {
        node_xy,
        ea,
        eb,
        e_len,
        e_class,
        e_flags,
        e_way,
        e_geom,
        pts,
        adj_off,
        adj,
        way_track,
        tracks,
        way_kinds,
        rels: out_rels,
        rel_mem_off,
        rel_mem,
        way_rel_off,
        way_rel,
        grid,
    })
}


/// A network made by hand, for tests: `ways` are (class, flags, track_ref, point indices), `rels` (kind, ref, way
/// indices in order).
#[cfg(test)]
pub fn from_parts(points: &[[f32; 2]], ways: &[(u8, u8, &str, Vec<usize>)], rels: &[(u8, &str, Vec<usize>)]) -> Net {
    let mut uses = vec![0u8; points.len()];
    for w in ways {
        for &i in &w.3 {
            uses[i] += 1;
        }
        uses[w.3[0]] += 1;
        uses[*w.3.last().unwrap()] += 1;
    }
    let mut node_of = vec![u32::MAX; points.len()];
    let mut node_xy = Vec::new();
    let (mut ea, mut eb, mut e_len, mut e_class, mut e_flags, mut e_way, mut e_geom, mut pts) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), vec![0u32], Vec::new());
    let mut tracks = Vec::new();
    let mut way_track = Vec::new();
    for (wn, w) in ways.iter().enumerate() {
        way_track.push(if w.2.is_empty() {
            NO_TRACK
        } else {
            tracks.push(norm_track(w.2));
            tracks.len() as u32 - 1
        });
        let mut j = |i: usize, node_xy: &mut Vec<[f32; 2]>| {
            if node_of[i] == u32::MAX {
                node_of[i] = node_xy.len() as u32;
                node_xy.push(points[i]);
            }
            node_of[i]
        };
        let mut start = w.3[0];
        let mut chain = vec![points[start]];
        for (k, &i) in w.3.iter().enumerate().skip(1) {
            chain.push(points[i]);
            if uses[i] >= 2 || k + 1 == w.3.len() {
                ea.push(j(start, &mut node_xy));
                eb.push(j(i, &mut node_xy));
                e_len.push(chain.windows(2).map(|s| dist(s[0], s[1])).sum());
                e_class.push(w.0);
                e_flags.push(w.1);
                e_way.push(wn as u32);
                pts.extend_from_slice(&chain);
                e_geom.push(pts.len() as u32);
                start = i;
                chain = vec![points[i]];
            }
        }
    }
    let ne = ea.len();
    let nn = node_xy.len();
    let mut adj_off = vec![0u32; nn + 1];
    for e in 0..ne {
        adj_off[ea[e] as usize + 1] += 1;
        adj_off[eb[e] as usize + 1] += 1;
    }
    for i in 0..nn {
        adj_off[i + 1] += adj_off[i];
    }
    let mut fill = adj_off.clone();
    let mut adj = vec![0u32; 2 * ne];
    for e in 0..ne {
        adj[fill[ea[e] as usize] as usize] = (e as u32) << 1;
        fill[ea[e] as usize] += 1;
        adj[fill[eb[e] as usize] as usize] = (e as u32) << 1 | 1;
        fill[eb[e] as usize] += 1;
    }
    let mut out_rels = Vec::new();
    let mut rel_mem_off = vec![0u32];
    let mut rel_mem = Vec::new();
    let nw = ways.len();
    let mut way_kinds = vec![0u8; nw];
    let mut lists: Vec<Vec<(u32, u32)>> = vec![Vec::new(); nw];
    for (ri, r) in rels.iter().enumerate() {
        for (p, &w) in r.2.iter().enumerate() {
            rel_mem.push(w as u32);
            way_kinds[w] |= r.0;
            lists[w].push((ri as u32, p as u32));
        }
        rel_mem_off.push(rel_mem.len() as u32);
        out_rels.push(RouteRel { id: ri as i64 + 1, kind: r.0, line_ref: norm_ref(r.1) });
    }
    let mut way_rel_off = vec![0u32];
    let mut way_rel = Vec::new();
    for l in lists {
        way_rel.extend(l);
        way_rel_off.push(way_rel.len() as u32);
    }
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for p in &pts {
        x0 = x0.min(p[0]);
        y0 = y0.min(p[1]);
        x1 = x1.max(p[0]);
        y1 = y1.max(p[1]);
    }
    let cell = 100.0;
    let (nx, ny) = (((x1 - x0) / cell) as usize + 1, ((y1 - y0) / cell) as usize + 1);
    let mut grid = Grid { x0, y0, cell, nx, ny, off: vec![0u32; nx * ny + 1], items: Vec::new() };
    let mut cells: Vec<Vec<(u32, u32)>> = vec![Vec::new(); nx * ny];
    for e in 0..ne {
        let g = &pts[e_geom[e] as usize..e_geom[e + 1] as usize];
        for s in 0..g.len() - 1 {
            let (a, b) = (g[s], g[s + 1]);
            for y in grid.cy(a[1].min(b[1]))..=grid.cy(a[1].max(b[1])) {
                for x in grid.cx(a[0].min(b[0]))..=grid.cx(a[0].max(b[0])) {
                    cells[y * nx + x].push((e as u32, s as u32));
                }
            }
        }
    }
    for (c, v) in cells.into_iter().enumerate() {
        grid.items.extend(v);
        grid.off[c + 1] = grid.items.len() as u32;
    }
    Net {
        node_xy,
        ea,
        eb,
        e_len,
        e_class,
        e_flags,
        e_way,
        e_geom,
        pts,
        adj_off,
        adj,
        way_track,
        tracks,
        way_kinds,
        rels: out_rels,
        rel_mem_off,
        rel_mem,
        way_rel_off,
        way_rel,
        grid,
    }
}
