//! Building outlines and their mapped entrances, for walks that start in or
//! end at a building (`kante-link::doors` turns them into [`kante_core::Doors`]).
//!
//! A building is a closed way with `building=*` (not `no`, `roof`,
//! `construction`), or an outer ring of a multipolygon relation with
//! `building=*`. An entrance is a node with `entrance=*` or `door=*` (not
//! `no`) that is part of a building's outline; it belongs to the first
//! building whose outline holds it. Three more passes over the PBF file,
//! separate from the walking network's (about 3 s nationally on 32 cores).

use crate::area::assemble_rings;
use crate::read::for_each_block;
use anyhow::Result;
use kante_core::geo::{BBox, LatLon};
use kante_core::walk::*;
use rustc_hash::{FxHashMap, FxHashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// An entrance as mapped: on the outline of `building` (index into the rings).
#[derive(Clone, Debug)]
pub struct EntranceRaw {
    pub pos: LatLon,
    pub building: u32,
    pub kind: DoorKind,
    /// `DOOR_WC_*`.
    pub wheelchair: u8,
    /// `addr:street` + `addr:housenumber`, or empty.
    pub addr: String,
}

#[derive(Clone, Debug, Default)]
pub struct BuildingsRaw {
    /// Outline of building `i`: `ring[ring_off[i] .. ring_off[i + 1]]`, open.
    pub ring_off: Vec<u32>,
    pub ring: Vec<LatLon>,
    pub entrances: Vec<EntranceRaw>,
}

impl BuildingsRaw {
    pub fn len(&self) -> usize {
        self.ring_off.len().saturating_sub(1)
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    #[inline]
    pub fn ring_of(&self, b: u32) -> &[LatLon] {
        &self.ring[self.ring_off[b as usize] as usize..self.ring_off[b as usize + 1] as usize]
    }
}

fn is_building(v: &str) -> bool {
    !v.is_empty() && !matches!(v, "no" | "roof" | "construction" | "proposed" | "demolished")
}

/// `entrance=*` / `door=*` (+ `access`) → the kind of door, None if it is not one.
pub fn door_kind(entrance: &str, door: &str, access: &str) -> Option<DoorKind> {
    if (entrance.is_empty() && door.is_empty()) || entrance == "no" || door == "no" {
        return None;
    }
    let k = match entrance {
        "main" => DoorKind::Main,
        "shop" => DoorKind::Shop,
        "home" => DoorKind::Home,
        "staircase" => DoorKind::Staircase,
        "service" => DoorKind::Service,
        "exit" => DoorKind::Exit,
        "emergency" => DoorKind::Emergency,
        "garage" => DoorKind::Garage,
        "private" => DoorKind::Private,
        _ => DoorKind::Yes,
    };
    if matches!(access, "private" | "no") && k != DoorKind::Main {
        return Some(DoorKind::Private);
    }
    Some(k)
}

struct WayPiece {
    id: i64,
    /// Relation the way is an outer member of, or 0 for a closed building way.
    rel: i64,
    refs: Vec<i64>,
}

struct NodeChunk {
    entrances: Vec<(i64, LatLon, DoorKind, u8, String)>,
}

pub fn import_buildings(pbf: &Path, bbox: Option<&BBox>) -> Result<BuildingsRaw> {
    // ---- relations: outer ways of multipolygon buildings
    let rel_chunks = for_each_block(pbf, |block| {
        let mut out: Vec<(i64, i64)> = Vec::new();
        for g in block.groups() {
            for r in g.relations() {
                let (mut mp, mut bld) = (false, false);
                for (k, v) in r.tags() {
                    match k {
                        "type" => mp = v == "multipolygon",
                        "building" => bld = is_building(v),
                        _ => {}
                    }
                }
                if !(mp && bld) {
                    continue;
                }
                for m in r.members() {
                    if m.member_type == osmpbf::RelMemberType::Way && m.role().unwrap_or("") != "inner" {
                        out.push((m.member_id, r.id()));
                    }
                }
            }
        }
        (!out.is_empty()).then_some(out)
    })?;
    // a way in two building relations belongs to the one with the lower id (whatever order the blocks came in)
    let mut pairs: Vec<(i64, i64)> = rel_chunks.into_iter().flatten().collect();
    pairs.sort_unstable();
    pairs.dedup_by_key(|p| p.0);
    let outer_of: FxHashMap<i64, i64> = pairs.into_iter().collect();

    // ---- ways: closed building ways and outer pieces of building relations
    let way_chunks = for_each_block(pbf, |block| {
        let mut out: Vec<WayPiece> = Vec::new();
        for g in block.groups() {
            for w in g.ways() {
                let rel = outer_of.get(&w.id()).copied().unwrap_or(0);
                let bld = rel == 0 && w.tags().any(|(k, v)| k == "building" && is_building(v));
                if !bld && rel == 0 {
                    continue;
                }
                let refs: Vec<i64> = w.refs().collect();
                if bld && (refs.len() < 4 || refs.first() != refs.last()) {
                    continue;
                }
                if refs.len() < 2 {
                    continue;
                }
                out.push(WayPiece { id: w.id(), rel, refs });
            }
        }
        (!out.is_empty()).then_some(out)
    })?;
    let mut pieces: Vec<WayPiece> = way_chunks.into_iter().flatten().collect();
    pieces.sort_by_key(|p| (p.rel, p.id));
    pieces.dedup_by_key(|p| (p.rel, p.id));
    let mut ids: Vec<i64> = pieces.iter().flat_map(|p| p.refs.iter().copied()).collect();
    ids.sort_unstable();
    ids.dedup();

    // ---- nodes: coordinates of the outlines, and every entrance
    let coords: Vec<AtomicU64> = (0..ids.len()).map(|_| AtomicU64::new(u64::MAX)).collect();
    let node_chunks = for_each_block(pbf, |block| {
        let mut ch = NodeChunk { entrances: Vec::new() };
        let mut one = |id: i64, lat: i32, lon: i32, tags: &mut dyn Iterator<Item = (&str, &str)>| {
            if let Ok(i) = ids.binary_search(&id) {
                coords[i].store(((lat as u32 as u64) << 32) | lon as u32 as u64, Ordering::Relaxed);
            } else {
                return; // an entrance that is not on a building outline is no use here
            }
            let (mut entrance, mut door, mut access, mut wc, mut street, mut number) = ("", "", "", "", "", "");
            for (k, v) in tags {
                match k {
                    "entrance" => entrance = v,
                    "door" => door = v,
                    "access" => access = v,
                    "wheelchair" => wc = v,
                    "addr:street" | "addr:place" if street.is_empty() => street = v,
                    "addr:housenumber" => number = v,
                    _ => {}
                }
            }
            if let Some(kind) = door_kind(entrance, door, access) {
                let w = match wc {
                    "yes" | "designated" => DOOR_WC_YES,
                    "no" => DOOR_WC_NO,
                    "limited" => DOOR_WC_LIMITED,
                    _ => DOOR_WC_UNKNOWN,
                };
                let addr = [street, number].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(" ");
                ch.entrances.push((id, LatLon { lat, lon }, kind, w, addr));
            }
        };
        for g in block.groups() {
            for n in g.dense_nodes() {
                one(n.id(), n.decimicro_lat(), n.decimicro_lon(), &mut n.tags());
            }
            for n in g.nodes() {
                one(n.id(), n.decimicro_lat(), n.decimicro_lon(), &mut n.tags());
            }
        }
        (!ch.entrances.is_empty()).then_some(ch)
    })?;
    let pos = |i: u32| {
        let v = coords[i as usize].load(Ordering::Relaxed);
        if v == u64::MAX {
            LatLon::NONE
        } else {
            LatLon { lat: (v >> 32) as u32 as i32, lon: v as u32 as i32 }
        }
    };
    let idx = |id: &i64| ids.binary_search(id).map(|i| i as u32).unwrap_or(u32::MAX);

    // ---- rings: (node indices) per building
    let mut rings: Vec<Vec<u32>> = Vec::new();
    let mut k = 0;
    while k < pieces.len() {
        let rel = pieces[k].rel;
        let mut end = k + 1;
        while rel != 0 && end < pieces.len() && pieces[end].rel == rel {
            end += 1;
        }
        if rel == 0 {
            let r: Vec<u32> = pieces[k].refs[..pieces[k].refs.len() - 1].iter().map(idx).collect();
            rings.push(r);
        } else {
            let parts: Vec<Vec<u32>> = pieces[k..end].iter().map(|p| p.refs.iter().map(idx).collect()).collect();
            let slices: Vec<&[u32]> = parts.iter().map(|p| p.as_slice()).collect();
            rings.extend(assemble_rings(&slices));
        }
        k = end;
    }
    let mut out = BuildingsRaw { ring_off: vec![0], ..Default::default() };
    let mut node_bld: FxHashMap<u32, u32> = FxHashMap::default();
    let entrance_nodes: FxHashSet<u32> = node_chunks.iter().flat_map(|c| c.entrances.iter().map(|e| idx(&e.0))).collect();
    for r in rings {
        if r.len() < 3 || r.iter().any(|&i| i == u32::MAX || pos(i).is_none()) {
            continue;
        }
        if let Some(b) = bbox {
            if !r.iter().any(|&i| b.contains(&pos(i))) {
                continue;
            }
        }
        let b = out.len() as u32;
        for &i in &r {
            out.ring.push(pos(i));
            if entrance_nodes.contains(&i) {
                node_bld.entry(i).or_insert(b);
            }
        }
        out.ring_off.push(out.ring.len() as u32);
    }
    let mut ents: Vec<(i64, LatLon, DoorKind, u8, String)> = node_chunks.into_iter().flat_map(|c| c.entrances).collect();
    ents.sort_by_key(|e| e.0);
    ents.dedup_by_key(|e| e.0);
    for (id, p, kind, wheelchair, addr) in ents {
        if let Some(&b) = node_bld.get(&idx(&id)) {
            out.entrances.push(EntranceRaw { pos: p, building: b, kind, wheelchair, addr });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn door_kinds() {
        assert_eq!(door_kind("main", "", ""), Some(DoorKind::Main));
        assert_eq!(door_kind("", "hinged", ""), Some(DoorKind::Yes));
        assert_eq!(door_kind("yes", "", "private"), Some(DoorKind::Private));
        assert_eq!(door_kind("main", "", "private"), Some(DoorKind::Main));
        assert_eq!(door_kind("no", "", ""), None);
        assert_eq!(door_kind("", "", ""), None);
    }
}
