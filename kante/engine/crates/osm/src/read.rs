//! The three passes over the PBF file: relations, then ways, then nodes.
//!
//! Each pass decodes blobs in parallel (rayon over `osmpbf::BlobReader`) and
//! returns per-blob chunks that are merged in id order, so the result does not
//! depend on thread scheduling.

use crate::tags::*;
use anyhow::{Context, Result};
use kante_core::geo::{BBox, LatLon};
use kante_core::walk::*;
use osmpbf::{BlobDecode, BlobReader, PrimitiveBlock, RelMemberType};
use rayon::prelude::*;
use rustc_hash::FxHashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) fn for_each_block<T: Send>(pbf: &Path, f: impl Fn(&PrimitiveBlock) -> Option<T> + Sync + Send) -> Result<Vec<T>> {
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

// ---------------------------------------------------------------- relations

pub struct RelRec {
    pub id: i64,
    pub class: WayClass,
    pub name: String,
    pub plat: Option<PlatInfo>,
    pub outers: Vec<i64>,
    pub inners: Vec<i64>,
}

pub struct StopArea {
    /// (0 node / 1 way / 2 relation, id)
    pub members: Vec<(u8, i64)>,
    pub modes: u8,
    pub uic_ref: u32,
    pub name: String,
}

#[derive(Default)]
pub struct Relations {
    /// Multipolygons that become walkable areas, sorted by id.
    pub areas: Vec<RelRec>,
    pub stop_areas: Vec<StopArea>,
    /// Mode bits per stop / platform member of route relations.
    pub route_modes: FxHashMap<(u8, i64), u8>,
    /// Member way id → index into `areas` (first relation wins).
    pub member_of: FxHashMap<i64, u32>,
    pub n_relations: u64,
}

fn mtype(t: &RelMemberType) -> u8 {
    match t {
        RelMemberType::Node => 0,
        RelMemberType::Way => 1,
        RelMemberType::Relation => 2,
    }
}

struct RelChunk {
    areas: Vec<RelRec>,
    stop_areas: Vec<(i64, StopArea)>,
    route_modes: Vec<((u8, i64), u8)>,
    n: u64,
}

pub fn read_relations(pbf: &Path) -> Result<Relations> {
    let chunks = for_each_block(pbf, |block| {
        let mut ch = RelChunk { areas: Vec::new(), stop_areas: Vec::new(), route_modes: Vec::new(), n: 0 };
        for g in block.groups() {
            for r in g.relations() {
                ch.n += 1;
                let t = Tags::collect(r.tags());
                match t.type_ {
                    "multipolygon" => {
                        let c = classify_way(&t, false, true);
                        if c.roles & R_AREA == 0 {
                            continue;
                        }
                        let mut rec = RelRec {
                            id: r.id(),
                            class: c,
                            name: t.name.to_string(),
                            plat: if c.roles & R_PLATFORM != 0 { Some(plat_info(&t)) } else { None },
                            outers: Vec::new(),
                            inners: Vec::new(),
                        };
                        for m in r.members() {
                            if m.member_type != RelMemberType::Way {
                                continue;
                            }
                            if m.role().unwrap_or("") == "inner" {
                                rec.inners.push(m.member_id);
                            } else {
                                rec.outers.push(m.member_id);
                            }
                        }
                        if !rec.outers.is_empty() && rec.outers.len() + rec.inners.len() <= 4000 {
                            ch.areas.push(rec);
                        }
                    }
                    "public_transport" if t.public_transport == "stop_area" => {
                        let members: Vec<(u8, i64)> = r.members().take(2000).map(|m| (mtype(&m.member_type), m.member_id)).collect();
                        ch.stop_areas.push((
                            r.id(),
                            StopArea { members, modes: mode_hints(&t), uic_ref: t.uic_ref.trim().parse().unwrap_or(0), name: t.name.to_string() },
                        ));
                    }
                    "route" => {
                        let m = route_modes(t.route);
                        if m != 0 {
                            for mem in r.members() {
                                let role = mem.role().unwrap_or("");
                                if role.starts_with("platform") || role.starts_with("stop") {
                                    ch.route_modes.push(((mtype(&mem.member_type), mem.member_id), m));
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        if ch.n == 0 {
            None
        } else {
            Some(ch)
        }
    })?;
    let mut out = Relations::default();
    let mut stop_areas: Vec<(i64, StopArea)> = Vec::new();
    for ch in chunks {
        out.n_relations += ch.n;
        out.areas.extend(ch.areas);
        stop_areas.extend(ch.stop_areas);
        for (k, m) in ch.route_modes {
            *out.route_modes.entry(k).or_insert(0) |= m;
        }
    }
    out.areas.sort_by_key(|r| r.id);
    stop_areas.sort_by_key(|r| r.0);
    out.stop_areas = stop_areas.into_iter().map(|r| r.1).collect();
    for (i, r) in out.areas.iter().enumerate() {
        for w in r.outers.iter().chain(r.inners.iter()) {
            out.member_of.entry(*w).or_insert(i as u32);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- ways

pub const NO_IDX: u32 = u32::MAX;

#[derive(Clone, Debug)]
pub struct WayRec {
    pub id: i64,
    pub class: WayClass,
    /// Index into `Ways::names` (0 = unnamed).
    pub name: u32,
    pub refs_off: u32,
    pub refs_len: u32,
    /// Index into `Ways::plats` or `NO_IDX`.
    pub plat: u32,
    /// Index into `Relations::areas` or `NO_IDX`.
    pub rel: u32,
    /// Index into `Ways::lift_levels` or `NO_IDX`.
    pub lift: u32,
    pub closed: bool,
}

#[derive(Default)]
pub struct Ways {
    /// Sorted by way id.
    pub recs: Vec<WayRec>,
    /// Node references of all records; once resolved these are
    /// indices into the sorted needed-node table.
    pub refs: Vec<u32>,
    pub names: Vec<String>,
    pub plats: Vec<PlatInfo>,
    pub lift_levels: Vec<Vec<Level2>>,
    /// Sorted unique ids of every node referenced by a kept way.
    pub node_ids: Vec<i64>,
    pub n_ways: u64,
}

impl Ways {
    #[inline]
    pub fn refs_of(&self, w: &WayRec) -> &[u32] {
        &self.refs[w.refs_off as usize..(w.refs_off + w.refs_len) as usize]
    }
}

struct WayChunk {
    first_id: i64,
    recs: Vec<WayRec>,
    refs: Vec<i64>,
    names: Vec<String>,
    plats: Vec<PlatInfo>,
    lift_levels: Vec<Vec<Level2>>,
    n: u64,
}

pub fn read_ways(pbf: &Path, rels: &Relations) -> Result<Ways> {
    let mut chunks = for_each_block(pbf, |block| {
        let mut ch = WayChunk {
            first_id: i64::MAX,
            recs: Vec::new(),
            refs: Vec::new(),
            names: vec![String::new()],
            plats: Vec::new(),
            lift_levels: Vec::new(),
            n: 0,
        };
        for g in block.groups() {
            for w in g.ways() {
                ch.n += 1;
                ch.first_id = ch.first_id.min(w.id());
                let member = rels.member_of.get(&w.id()).copied();
                let t = Tags::collect(w.tags());
                if member.is_none()
                    && t.highway.is_empty()
                    && t.railway.is_empty()
                    && t.public_transport.is_empty()
                    && t.indoor.is_empty()
                    && t.building_part.is_empty()
                    && t.room.is_empty()
                {
                    continue;
                }
                let raw = w.raw_refs();
                if raw.len() < 2 || raw.len() > 20_000 {
                    continue;
                }
                let refs_off = ch.refs.len() as u32;
                let mut id = 0i64;
                let mut prev = i64::MIN;
                for d in raw {
                    id += *d;
                    if id != prev {
                        ch.refs.push(id);
                    }
                    prev = id;
                }
                let n = ch.refs.len() as u32 - refs_off;
                let closed = n >= 4 && ch.refs[refs_off as usize] == *ch.refs.last().unwrap();
                let mut class = classify_way(&t, closed, false);
                let mut name = t.name;
                let mut rel = NO_IDX;
                if let Some(ri) = member {
                    rel = ri;
                    class.roles |= R_MEMBER;
                    // (a lift shaft drawn as a hole in the platform around it stays a lift)
                    if class.roles & (R_WALK | R_LIFT) == 0 {
                        // Ring of a walkable area: the outline is walked with the area's class.
                        let rc = &rels.areas[ri as usize].class;
                        if rc.roles & R_WALK != 0 {
                            let keep = class.roles & !(R_AREA | R_LIFT | R_LIFT_PRIVATE);
                            class = WayClass { roles: keep | R_WALK | R_INHERITED, kind: rc.kind, flags: rc.flags, level: rc.level, incline: 0, step_count: 0, layer: rc.layer };
                            name = &rels.areas[ri as usize].name;
                        }
                    }
                }
                if class.roles == 0 || n < 2 {
                    ch.refs.truncate(refs_off as usize);
                    continue;
                }
                let name_idx = if name.is_empty() || name.len() > 200 {
                    0
                } else {
                    ch.names.push(name.to_string());
                    ch.names.len() as u32 - 1
                };
                let plat = if class.roles & (R_PLATFORM | R_PLATFORM_EDGE) != 0 {
                    let mut p = plat_info(&t);
                    if t.railway == "platform" && p.modes == 0 {
                        // nothing: railway=platform is used for trams and trains alike
                        p.modes = 0;
                    }
                    ch.plats.push(p);
                    ch.plats.len() as u32 - 1
                } else {
                    NO_IDX
                };
                let lift = if class.roles & R_LIFT != 0 {
                    ch.lift_levels.push(parse_levels(t.level));
                    ch.lift_levels.len() as u32 - 1
                } else {
                    NO_IDX
                };
                ch.recs.push(WayRec { id: w.id(), class, name: name_idx, refs_off, refs_len: n, plat, rel, lift, closed });
            }
        }
        if ch.n == 0 {
            None
        } else {
            Some(ch)
        }
    })?;
    chunks.sort_by_key(|c| c.first_id);

    let mut out = Ways::default();
    out.names.push(String::new());
    let mut name_ix: FxHashMap<String, u32> = FxHashMap::default();
    let total_refs: usize = chunks.iter().map(|c| c.refs.len()).sum();
    anyhow::ensure!(total_refs < u32::MAX as usize, "too many way nodes");
    let mut refs64: Vec<i64> = Vec::with_capacity(total_refs);
    for ch in chunks {
        out.n_ways += ch.n;
        let ro = refs64.len() as u32;
        let po = out.plats.len() as u32;
        let lo = out.lift_levels.len() as u32;
        refs64.extend_from_slice(&ch.refs);
        let WayChunk { recs, names, plats, lift_levels, .. } = ch;
        let name_map: Vec<u32> = names
            .into_iter()
            .enumerate()
            .map(|(i, s)| {
                if i == 0 {
                    return 0;
                }
                if let Some(&x) = name_ix.get(&s) {
                    x
                } else {
                    let x = out.names.len() as u32;
                    out.names.push(s.clone());
                    name_ix.insert(s, x);
                    x
                }
            })
            .collect();
        out.plats.extend(plats);
        out.lift_levels.extend(lift_levels);
        for mut r in recs {
            r.refs_off += ro;
            r.name = name_map[r.name as usize];
            if r.plat != NO_IDX {
                r.plat += po;
            }
            if r.lift != NO_IDX {
                r.lift += lo;
            }
            out.recs.push(r);
        }
    }
    out.recs.sort_by_key(|r| r.id);

    let mut ids = refs64.clone();
    ids.par_sort_unstable();
    ids.dedup();
    ids.shrink_to_fit();
    anyhow::ensure!(ids.len() < u32::MAX as usize - 1, "too many nodes");
    out.refs = refs64.par_iter().map(|id| ids.binary_search(id).unwrap() as u32).collect();
    out.node_ids = ids;
    Ok(out)
}

// ---------------------------------------------------------------- nodes

#[derive(Clone, Debug)]
pub struct NodeTag {
    /// Index into the needed-node table.
    pub idx: u32,
    pub class: NodeClass,
    /// `level=*` of an elevator node.
    pub levels: Vec<Level2>,
}

pub struct StopNode {
    pub id: i64,
    pub pos: LatLon,
    pub kind: PlatformKind,
    pub info: PlatInfo,
}

pub struct Nodes {
    /// Coordinates parallel to `Ways::node_ids`; `LatLon::NONE` if the node is
    /// not in the file.
    pub coords: Vec<LatLon>,
    /// Sorted by `idx`.
    pub tags: Vec<NodeTag>,
    /// Sorted by id.
    pub stops: Vec<StopNode>,
    pub n_nodes: u64,
}

#[inline]
fn pack(lat: i32, lon: i32) -> u64 {
    ((lat as u32 as u64) << 32) | lon as u32 as u64
}
const UNSET: u64 = u64::MAX;

struct NodeChunk {
    tags: Vec<NodeTag>,
    stops: Vec<StopNode>,
    n: u64,
}

/// Merge-style lookup into the sorted needed-id table: node ids ascend within
/// a block, so the cursor usually only moves forward a few slots; a binary
/// search re-syncs after a jump or any disorder.
struct Lookup<'a> {
    ids: &'a [i64],
    cur: usize,
    last: i64,
}

impl Lookup<'_> {
    #[inline]
    fn find(&mut self, id: i64) -> Option<usize> {
        if self.cur == usize::MAX || id < self.last {
            self.cur = self.ids.partition_point(|x| *x < id);
        } else {
            let mut steps = 0;
            while self.cur < self.ids.len() && self.ids[self.cur] < id {
                self.cur += 1;
                steps += 1;
                if steps > 32 {
                    self.cur += self.ids[self.cur..].partition_point(|x| *x < id);
                    break;
                }
            }
        }
        self.last = id;
        if self.cur < self.ids.len() && self.ids[self.cur] == id {
            Some(self.cur)
        } else {
            None
        }
    }
}

#[allow(clippy::too_many_arguments)]
#[inline]
fn one_node<'a>(
    id: i64,
    lat: i32,
    lon: i32,
    tags: impl Iterator<Item = (&'a str, &'a str)>,
    lk: &mut Lookup,
    coords: &[AtomicU64],
    bbox: Option<&BBox>,
    ch: &mut NodeChunk,
) {
    ch.n += 1;
    let found = lk.find(id);
    if let Some(i) = found {
        coords[i].store(pack(lat, lon), Ordering::Relaxed);
    }
    let mut tags = tags.peekable();
    if tags.peek().is_none() {
        return;
    }
    let t = Tags::collect(tags);
    if let Some(kind) = node_platform_kind(&t) {
        let pos = LatLon { lat, lon };
        if bbox.map(|b| b.contains(&pos)).unwrap_or(true) {
            ch.stops.push(StopNode { id, pos, kind, info: plat_info(&t) });
        }
    }
    if let Some(i) = found {
        let class = classify_node(&t);
        if class != NodeClass::default() {
            let levels = if class.nf & NF_ELEVATOR != 0 { parse_levels(t.level) } else { Vec::new() };
            ch.tags.push(NodeTag { idx: i as u32, class, levels });
        }
    }
}

pub fn read_nodes(pbf: &Path, node_ids: &[i64], bbox: Option<&BBox>) -> Result<Nodes> {
    let coords: Vec<AtomicU64> = (0..node_ids.len()).into_par_iter().map(|_| AtomicU64::new(UNSET)).collect();
    let chunks = for_each_block(pbf, |block| {
        let mut ch = NodeChunk { tags: Vec::new(), stops: Vec::new(), n: 0 };
        let mut lk = Lookup { ids: node_ids, cur: usize::MAX, last: i64::MIN };
        for g in block.groups() {
            for n in g.dense_nodes() {
                one_node(n.id(), n.decimicro_lat(), n.decimicro_lon(), n.tags(), &mut lk, &coords, bbox, &mut ch);
            }
            for n in g.nodes() {
                one_node(n.id(), n.decimicro_lat(), n.decimicro_lon(), n.tags(), &mut lk, &coords, bbox, &mut ch);
            }
        }
        if ch.n == 0 {
            None
        } else {
            Some(ch)
        }
    })?;
    let mut tags = Vec::new();
    let mut stops = Vec::new();
    let mut n_nodes = 0;
    for ch in chunks {
        n_nodes += ch.n;
        tags.extend(ch.tags);
        stops.extend(ch.stops);
    }
    tags.sort_by_key(|t: &NodeTag| t.idx);
    tags.dedup_by_key(|t| t.idx);
    stops.sort_by_key(|s: &StopNode| s.id);
    stops.dedup_by_key(|s| s.id);
    let coords: Vec<LatLon> = coords
        .into_par_iter()
        .map(|a| {
            let v = a.into_inner();
            if v == UNSET {
                LatLon::NONE
            } else {
                LatLon { lat: (v >> 32) as u32 as i32, lon: v as u32 as i32 }
            }
        })
        .collect();
    Ok(Nodes { coords, tags, stops, n_nodes })
}
