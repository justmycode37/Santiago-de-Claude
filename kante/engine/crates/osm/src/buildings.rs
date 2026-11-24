//! Building outlines and their mapped entrances, for walks that start in or
//! end at a building (`kante-link::doors` turns them into [`kante_core::Doors`]).
//!
//! A building is a closed way with `building=*` (not `no`, `roof`,
//! `construction`), or an outer ring of a multipolygon relation with
//! `building=*`; the relation's inner rings are its courtyards (a point in a
//! courtyard is not in the building). A way that is part of two building
//! relations (a wall two buildings share) belongs to both. An entrance is a
//! node with `entrance=*` or `door=*` (not `no`) on a building's outline or
//! courtyard; it belongs to the first building that has it. Three more passes
//! over the PBF file, separate from the walking network's (about 3 s
//! nationally on 32 cores).

use crate::area::assemble_rings;
use crate::read::for_each_block;
use anyhow::Result;
use kante_core::geo::{BBox, LatLon};
use kante_core::walk::*;
use rustc_hash::{FxHashMap, FxHashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// An entrance as mapped: on the outline of `building` (index into the buildings).
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

/// A building: its outline and its courtyards, rings stored open.
#[derive(Clone, Debug, Default)]
pub struct BuildingRaw {
    pub outer: Vec<LatLon>,
    pub holes: Vec<Vec<LatLon>>,
}

#[derive(Clone, Debug, Default)]
pub struct BuildingsRaw {
    pub buildings: Vec<BuildingRaw>,
    pub entrances: Vec<EntranceRaw>,
}

impl BuildingsRaw {
    pub fn len(&self) -> usize {
        self.buildings.len()
    }
    pub fn is_empty(&self) -> bool {
        self.buildings.is_empty()
    }
    /// The outline of building `b`.
    #[inline]
    pub fn ring_of(&self, b: u32) -> &[LatLon] {
        &self.buildings[b as usize].outer
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

/// A way of a building: a closed building way (`rel == 0`), or a member of building relation `rel`.
#[derive(Clone, Debug)]
pub struct Piece {
    pub way: i64,
    pub rel: i64,
    pub inner: bool,
    pub refs: Vec<i64>,
}

/// An entrance node: (node id, position, kind, wheelchair, address).
pub type EntranceNode = (i64, LatLon, DoorKind, u8, String);

fn inside(p: LatLon, ring: &[LatLon]) -> bool {
    let mut c = false;
    let n = ring.len();
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (ring[i], ring[j]);
        if (a.lat > p.lat) != (b.lat > p.lat) && (p.lon as f64) < (b.lon as f64 - a.lon as f64) * (p.lat as f64 - a.lat as f64) / (b.lat as f64 - a.lat as f64) + a.lon as f64 {
            c = !c;
        }
        j = i;
    }
    c
}

/// Buildings from their ways (node ids resolved by `pos`, `LatLon::NONE` if missing) and the entrance nodes.
pub fn assemble(mut pieces: Vec<Piece>, pos: impl Fn(i64) -> LatLon, entrances: Vec<EntranceNode>, bbox: Option<&BBox>) -> BuildingsRaw {
    pieces.sort_by_key(|p| (p.rel, p.way, p.inner));
    pieces.dedup_by_key(|p| (p.rel, p.way, p.inner));
    let entrance_ids: FxHashSet<i64> = entrances.iter().map(|e| e.0).collect();
    let mut out = BuildingsRaw::default();
    let mut node_bld: FxHashMap<i64, u32> = FxHashMap::default();
    let ok = |r: &[i64]| r.len() >= 3 && r.iter().all(|&i| !pos(i).is_none());
    let mut add = |out: &mut BuildingsRaw, outer: Vec<i64>, holes: Vec<Vec<i64>>| {
        let ring: Vec<LatLon> = outer.iter().map(|&i| pos(i)).collect();
        if let Some(b) = bbox {
            if !ring.iter().any(|p| b.contains(p)) {
                return;
            }
        }
        let b = out.buildings.len() as u32;
        for &i in outer.iter().chain(holes.iter().flatten()) {
            if entrance_ids.contains(&i) {
                node_bld.entry(i).or_insert(b);
            }
        }
        out.buildings.push(BuildingRaw { outer: ring, holes: holes.iter().map(|h| h.iter().map(|&i| pos(i)).collect()).collect() });
    };
    let mut k = 0;
    while k < pieces.len() {
        let rel = pieces[k].rel;
        let mut end = k + 1;
        while rel != 0 && end < pieces.len() && pieces[end].rel == rel {
            end += 1;
        }
        if rel == 0 {
            let r = pieces[k].refs[..pieces[k].refs.len() - 1].to_vec();
            if ok(&r) {
                add(&mut out, r, Vec::new());
            }
        } else {
            let rings = |inner: bool| -> Vec<Vec<i64>> {
                // assemble_rings works on u32 node handles: number the ids of this relation
                let ps: Vec<&Piece> = pieces[k..end].iter().filter(|p| p.inner == inner).collect();
                let mut ids: Vec<i64> = ps.iter().flat_map(|p| p.refs.iter().copied()).collect();
                ids.sort_unstable();
                ids.dedup();
                let parts: Vec<Vec<u32>> = ps.iter().map(|p| p.refs.iter().map(|r| ids.binary_search(r).unwrap() as u32).collect()).collect();
                let slices: Vec<&[u32]> = parts.iter().map(|p| p.as_slice()).collect();
                assemble_rings(&slices).into_iter().map(|r| r.into_iter().map(|i| ids[i as usize]).collect::<Vec<i64>>()).filter(|r| ok(r)).collect()
            };
            let outers = rings(false);
            let mut inners = rings(true);
            for o in outers {
                let ring: Vec<LatLon> = o.iter().map(|&i| pos(i)).collect();
                let (mine, rest): (Vec<Vec<i64>>, Vec<Vec<i64>>) = inners.into_iter().partition(|h| inside(pos(h[0]), &ring));
                inners = rest;
                add(&mut out, o, mine);
            }
        }
        k = end;
    }
    let mut ents = entrances;
    ents.sort_by_key(|e| e.0);
    ents.dedup_by_key(|e| e.0);
    for (id, p, kind, wheelchair, addr) in ents {
        if let Some(&b) = node_bld.get(&id) {
            out.entrances.push(EntranceRaw { pos: p, building: b, kind, wheelchair, addr });
        }
    }
    out
}

pub fn import_buildings(pbf: &Path, bbox: Option<&BBox>) -> Result<BuildingsRaw> {
    // ---- relations: the member ways of multipolygon buildings, (way, relation, inner)
    let rel_chunks = for_each_block(pbf, |block| {
        let mut out: Vec<(i64, i64, bool)> = Vec::new();
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
                    if m.member_type == osmpbf::RelMemberType::Way {
                        out.push((m.member_id, r.id(), m.role().unwrap_or("") == "inner"));
                    }
                }
            }
        }
        (!out.is_empty()).then_some(out)
    })?;
    // a way can be a member of several building relations (a shared wall): of each one
    let mut member_of: FxHashMap<i64, Vec<(i64, bool)>> = FxHashMap::default();
    for (w, r, inner) in rel_chunks.into_iter().flatten() {
        member_of.entry(w).or_default().push((r, inner));
    }

    // ---- ways: closed building ways and the members of building relations
    let way_chunks = for_each_block(pbf, |block| {
        let mut out: Vec<Piece> = Vec::new();
        for g in block.groups() {
            for w in g.ways() {
                let rels = member_of.get(&w.id());
                let bld = w.tags().any(|(k, v)| k == "building" && is_building(v));
                if !bld && rels.is_none() {
                    continue;
                }
                let refs: Vec<i64> = w.refs().collect();
                if refs.len() < 2 {
                    continue;
                }
                if bld && refs.len() >= 4 && refs.first() == refs.last() && rels.is_none_or(|rs| rs.iter().all(|r| r.1)) {
                    // a building of its own (also when it is the courtyard of another one)
                    out.push(Piece { way: w.id(), rel: 0, inner: false, refs: refs.clone() });
                }
                for &(rel, inner) in rels.map(|v| v.as_slice()).unwrap_or(&[]) {
                    out.push(Piece { way: w.id(), rel, inner, refs: refs.clone() });
                }
            }
        }
        (!out.is_empty()).then_some(out)
    })?;
    let pieces: Vec<Piece> = way_chunks.into_iter().flatten().collect();
    let mut ids: Vec<i64> = pieces.iter().flat_map(|p| p.refs.iter().copied()).collect();
    ids.sort_unstable();
    ids.dedup();

    // ---- nodes: coordinates of the outlines, and the entrances on them
    let coords: Vec<AtomicU64> = (0..ids.len()).map(|_| AtomicU64::new(u64::MAX)).collect();
    let node_chunks = for_each_block(pbf, |block| {
        let mut ents: Vec<EntranceNode> = Vec::new();
        let mut one = |id: i64, lat: i32, lon: i32, tags: &mut dyn Iterator<Item = (&str, &str)>| {
            let Ok(i) = ids.binary_search(&id) else { return }; // an entrance on no building outline is no use here
            coords[i].store(((lat as u32 as u64) << 32) | lon as u32 as u64, Ordering::Relaxed);
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
                ents.push((id, LatLon { lat, lon }, kind, w, addr));
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
        (!ents.is_empty()).then_some(ents)
    })?;
    let pos = |id: i64| match ids.binary_search(&id) {
        Ok(i) => {
            let v = coords[i].load(Ordering::Relaxed);
            if v == u64::MAX {
                LatLon::NONE
            } else {
                LatLon { lat: (v >> 32) as u32 as i32, lon: v as u32 as i32 }
            }
        }
        Err(_) => LatLon::NONE,
    };
    Ok(assemble(pieces, pos, node_chunks.into_iter().flatten().collect(), bbox))
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

    // nodes on a 1e-4 degree grid: id = 100 * x + y
    fn at(id: i64) -> LatLon {
        LatLon { lat: 469_000_000 + (id % 100) as i32 * 1000, lon: 74_000_000 + (id / 100) as i32 * 1000 }
    }
    fn piece(way: i64, rel: i64, inner: bool, refs: &[i64]) -> Piece {
        Piece { way, rel, inner, refs: refs.to_vec() }
    }

    #[test]
    fn a_courtyard_is_not_in_the_building() {
        // outer 0..10 × 0..10, courtyard 4..6 × 4..6, a door on the courtyard wall
        let b = assemble(
            vec![piece(1, 7, false, &[0, 1000, 1010, 10, 0]), piece(2, 7, true, &[404, 604, 606, 406, 404])],
            at,
            vec![(604, at(604), DoorKind::Yes, 0, String::new())],
            None,
        );
        assert_eq!(b.len(), 1);
        assert_eq!(b.buildings[0].holes.len(), 1);
        assert_eq!(b.entrances.len(), 1, "a door on the courtyard wall belongs to the building");
    }

    #[test]
    fn a_wall_shared_by_two_buildings_belongs_to_both() {
        // two relations sharing way 3 (x = 5); each closes its ring with it
        let b = assemble(
            vec![
                piece(1, 7, false, &[500, 0, 10, 510]),
                piece(3, 7, false, &[510, 500]),
                piece(2, 8, false, &[500, 1000, 1010, 510]),
                piece(3, 8, false, &[510, 500]),
            ],
            at,
            vec![(500, at(500), DoorKind::Main, 0, String::new())],
            None,
        );
        assert_eq!(b.len(), 2, "both buildings close");
        assert_eq!(b.entrances.len(), 1, "the shared corner's door goes to one of them");
    }
}
