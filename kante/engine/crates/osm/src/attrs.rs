//! What route choice reads beyond an edge's kind and flags ([`WalkAttrs`], `walkattr.bin`): the size of the road a
//! carriageway belongs to, whether its sidewalks are drawn as ways of their own, car-only service roads, footways
//! and paths away from traffic, opening hours and closing conditions, and `crossing=no` nodes. Three more passes
//! over the PBF file (relations, ways, nodes), after the graph is built: the graph's edges know their OSM way
//! (`WalkGraph::edge_way`) and its nodes their coordinates, which are those of their OSM nodes.
//!
//! - **Road size** (`EA_ROAD`): residential, unclassified, living_street, road → minor; service; tertiary,
//!   secondary, primary, trunk (with their `_link`s). Only on `Road` / `RoadBusy` edges.
//! - **Sidewalks drawn apart** (`EA_SIDEWALK_SEPARATE`): a road with `sidewalk`, `sidewalk:both`, `sidewalk:left` or
//!   `sidewalk:right` = `separate` and no sidewalk tagged on the road itself (`sidewalk=both|left|right|yes`,
//!   `sidewalk:*=yes`: that one is walked on the road's line), or with `foot=use_sidepath`.
//! - **Car-only** (`EA_CAR_ONLY`): `highway=service` with `service=parking_aisle|driveway|drive-through`, or with
//!   `access=destination|customers|delivery|permit|agricultural|forestry|residents` (unless `foot=yes|designated`).
//! - **Away from traffic** (`EA_FAVOURED`): `Footway` edges that are not cycleways, `Pedestrian` edges (streets and
//!   squares), and footways and paths in a park or garden (`leisure=park|garden`, points 1/4, 1/2 and 3/4 along the edge in it).
//!   Not sidewalks, crossings, corridors or platforms.
//! - **Hours** (`EA_HOURS`): the way's own `opening_hours`, else `foot:conditional`, else `access:conditional` (unless
//!   `foot=yes|designated`) with a `no` or `private` condition; else the hours of an area it lies in (its middle):
//!   a park or garden (`leisure=park|garden`) for its footways, paths, steps and squares (not the sidewalks round
//!   it; points 1/4, 1/2 and 3/4 along the edge in it), a mall or an indoor area
//!   (`shop=mall`, `indoor=area|yes|corridor`) for indoor ways. Station buildings' hours are not read: they are the
//!   ticket office's.
//! - **`crossing=no`** (`NA_CROSSING_NO`) on a node of the graph.

use crate::area::assemble_rings;
use crate::read::for_each_block;
use anyhow::Result;
use kante_core::geo::{BBox, LatLon};
use kante_core::walk::*;
use rayon::prelude::*;
use rustc_hash::{FxHashMap, FxHashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// Internal: the way is a cycleway (cleared before the attributes are stored).
const CYCLEWAY: u8 = 1 << 7;

/// What a way's own tags say: (`EA_*` bits without `EA_FAVOURED`, which comes from the edge kind; its hours entry).
pub fn way_attrs(tags: &[(&str, &str)]) -> (u8, Option<String>) {
    let (bits, hours, _) = way_attrs_full(tags);
    (bits, hours)
}

/// [`way_attrs`], and whether the way is a cycleway (its footway edges are not favoured).
fn way_attrs_full(tags: &[(&str, &str)]) -> (u8, Option<String>, bool) {
    let get = |k: &str| tags.iter().find(|t| t.0 == k).map(|t| t.1).unwrap_or("");
    let hw = get("highway");
    let mut bits = match hw {
        "residential" | "unclassified" | "living_street" | "road" => RC_MINOR,
        "service" => RC_SERVICE,
        "tertiary" | "tertiary_link" => RC_TERTIARY,
        "secondary" | "secondary_link" => RC_SECONDARY,
        "primary" | "primary_link" => RC_PRIMARY,
        "trunk" | "trunk_link" => RC_TRUNK,
        _ => RC_NONE,
    };
    let foot = get("foot");
    let foot_yes = matches!(foot, "yes" | "designated" | "permissive" | "official");
    let side = ["sidewalk", "sidewalk:both", "sidewalk:left", "sidewalk:right"].map(get);
    let separate = side.contains(&"separate");
    let on_road = matches!(side[0], "both" | "left" | "right" | "yes") || side[1..].contains(&"yes");
    if (bits != RC_NONE && separate && !on_road) || foot == "use_sidepath" {
        bits |= EA_SIDEWALK_SEPARATE;
    }
    if hw == "service"
        && (matches!(get("service"), "parking_aisle" | "driveway" | "drive-through")
            || (!foot_yes && matches!(get("access"), "destination" | "customers" | "delivery" | "permit" | "agricultural" | "forestry" | "residents")))
    {
        bits |= EA_CAR_ONLY;
    }
    let oh = get("opening_hours");
    let hours = if !oh.is_empty() {
        Some(format!("oh:{oh}"))
    } else if !get("foot:conditional").is_empty() {
        Some(format!("no:{}", get("foot:conditional")))
    } else if !get("access:conditional").is_empty() && !foot_yes {
        Some(format!("no:{}", get("access:conditional")))
    } else {
        None
    };
    // a condition that closes nothing to walkers (`delivery @ …` only) is no hours at all
    let hours = hours.filter(|h| !h.starts_with("no:") || h.contains("no @") || h.contains("private @"));
    (bits, hours, hw == "cycleway")
}

/// Which areas' hours apply to the ways in them.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AreaKind {
    /// A park or garden: its footways, paths, steps and squares.
    Park,
    /// A mall or an indoor area: its indoor ways.
    Indoor,
}

/// An area whose ways it matters to be in: a park or garden (its paths are favoured, and close with its hours if it
/// has some), or a mall or indoor area with opening hours (its indoor ways close with it); from its tags.
pub fn area_kind(tags: &[(&str, &str)]) -> Option<(AreaKind, Option<String>)> {
    let get = |k: &str| tags.iter().find(|t| t.0 == k).map(|t| t.1).unwrap_or("");
    let oh = get("opening_hours");
    let hours = (!oh.is_empty()).then(|| format!("oh:{oh}"));
    if !get("highway").is_empty() {
        return None;
    }
    if matches!(get("leisure"), "park" | "garden") {
        Some((AreaKind::Park, hours))
    } else if (get("shop") == "mall" || matches!(get("indoor"), "area" | "yes" | "corridor")) && hours.is_some() {
        Some((AreaKind::Indoor, hours))
    } else {
        None
    }
}

/// Does an area of this kind close this edge?
fn closes(kind: AreaKind, e: &WalkEdge) -> bool {
    match kind {
        AreaKind::Park => matches!(e.kind, EdgeKind::Footway | EdgeKind::Path | EdgeKind::Pedestrian | EdgeKind::Steps) && e.flags & EF_INDOOR == 0,
        AreaKind::Indoor => e.flags & EF_INDOOR != 0 || e.kind == EdgeKind::Corridor,
    }
}

#[derive(Clone, Debug, Default)]
pub struct AttrStats {
    pub separate_edges: usize,
    pub separate_m: f64,
    pub car_only_edges: usize,
    pub favoured_edges: usize,
    pub hours_edges: usize,
    /// Of those, by an area's hours.
    pub hours_by_area: usize,
    /// Distinct hours entries, and how many of them can be read.
    pub hours: usize,
    pub hours_readable: usize,
    pub areas: usize,
    pub crossing_no_nodes: usize,
}

struct Area {
    kind: AreaKind,
    /// Index into the hours, `u32::MAX` for none.
    hours: u32,
    rings: Vec<Vec<LatLon>>,
    bbox: (i32, i32, i32, i32),
}

fn inside(p: LatLon, rings: &[Vec<LatLon>]) -> bool {
    let mut c = false;
    for ring in rings {
        let n = ring.len();
        if n < 3 {
            continue;
        }
        let mut j = n - 1;
        for i in 0..n {
            let (a, b) = (ring[i], ring[j]);
            if (a.lat > p.lat) != (b.lat > p.lat) && (p.lon as f64) < (b.lon as f64 - a.lon as f64) * (p.lat as f64 - a.lat as f64) / (b.lat as f64 - a.lat as f64) + a.lon as f64 {
                c = !c;
            }
            j = i;
        }
    }
    c
}

/// The attributes of graph `g`'s edges and nodes from the PBF file it was built from.
pub fn import_attrs(pbf: &Path, g: &WalkGraph, bbox: Option<&BBox>) -> Result<(WalkAttrs, AttrStats)> {
    let mut st = AttrStats::default();
    // ---- relations: multipolygon areas with hours, (member way, relation, inner)
    let rel_chunks = for_each_block(pbf, |block| {
        let mut out: Vec<(i64, i64, bool, AreaKind, Option<String>)> = Vec::new();
        for grp in block.groups() {
            for r in grp.relations() {
                let tags: Vec<(&str, &str)> = r.tags().collect();
                if !tags.iter().any(|t| *t == ("type", "multipolygon")) {
                    continue;
                }
                let Some((kind, hours)) = area_kind(&tags) else { continue };
                for m in r.members() {
                    if m.member_type == osmpbf::RelMemberType::Way {
                        out.push((m.member_id, r.id(), m.role().unwrap_or("") == "inner", kind, hours.clone()));
                    }
                }
            }
        }
        (!out.is_empty()).then_some(out)
    })?;
    let mut member_of: FxHashMap<i64, Vec<(i64, bool)>> = FxHashMap::default();
    let mut rel_info: FxHashMap<i64, (AreaKind, Option<String>)> = FxHashMap::default();
    for (w, r, inner, kind, hours) in rel_chunks.into_iter().flatten() {
        member_of.entry(w).or_default().push((r, inner));
        rel_info.insert(r, (kind, hours));
    }

    // ---- ways: the walkable ways' own attributes; closed areas with hours, and the relations' member ways
    let ways_in_graph: FxHashSet<i64> = g.edge_way.iter().copied().filter(|&w| w != 0).collect();
    struct WayOut {
        attrs: Vec<(i64, u8, Option<String>)>,
        // (way, relation (0: a closed way of its own), inner, refs, kind, hours)
        pieces: Vec<(i64, i64, bool, Vec<i64>, Option<(AreaKind, Option<String>)>)>,
    }
    let way_chunks = for_each_block(pbf, |block| {
        let mut out = WayOut { attrs: Vec::new(), pieces: Vec::new() };
        for grp in block.groups() {
            for w in grp.ways() {
                let rels = member_of.get(&w.id());
                let walk = ways_in_graph.contains(&w.id());
                if !walk && rels.is_none() && !w.tags().any(|(k, v)| k == "opening_hours" || (k == "leisure" && matches!(v, "park" | "garden"))) {
                    continue;
                }
                let tags: Vec<(&str, &str)> = w.tags().collect();
                if walk {
                    let (bits, hours, cycleway) = way_attrs_full(&tags);
                    if bits != 0 || hours.is_some() || cycleway {
                        out.attrs.push((w.id(), bits | if cycleway { CYCLEWAY } else { 0 }, hours));
                    }
                }
                let area = area_kind(&tags);
                let closed = || {
                    let refs: Vec<i64> = w.refs().collect();
                    (refs.len() >= 4 && refs.first() == refs.last()).then_some(refs)
                };
                if let Some(a) = area {
                    if let Some(refs) = closed() {
                        out.pieces.push((w.id(), 0, false, refs, Some(a)));
                    }
                }
                for &(rel, inner) in rels.map(|v| v.as_slice()).unwrap_or(&[]) {
                    out.pieces.push((w.id(), rel, inner, w.refs().collect(), None));
                }
            }
        }
        (!out.attrs.is_empty() || !out.pieces.is_empty()).then_some(out)
    })?;
    let mut hours_ix: FxHashMap<String, u32> = FxHashMap::default();
    let mut hours: Vec<String> = Vec::new();
    let mut intern = |h: String| -> u32 {
        if let Some(&i) = hours_ix.get(&h) {
            return i;
        }
        hours.push(h.clone());
        hours_ix.insert(h, hours.len() as u32 - 1);
        hours.len() as u32 - 1
    };
    let mut way_bits: FxHashMap<i64, (u8, u32)> = FxHashMap::default();
    let mut pieces = Vec::new();
    for ch in way_chunks {
        for (w, bits, h) in ch.attrs {
            way_bits.insert(w, (bits, h.map(&mut intern).unwrap_or(u32::MAX)));
        }
        pieces.extend(ch.pieces);
    }

    // ---- nodes: the areas' outlines, and crossing=no
    let mut ids: Vec<i64> = pieces.iter().flat_map(|p| p.3.iter().copied()).collect();
    ids.sort_unstable();
    ids.dedup();
    let coords: Vec<AtomicU64> = (0..ids.len()).map(|_| AtomicU64::new(u64::MAX)).collect();
    let no_cross = for_each_block(pbf, |block| {
        let mut out: Vec<LatLon> = Vec::new();
        let mut one = |id: i64, lat: i32, lon: i32, tags: &mut dyn Iterator<Item = (&str, &str)>| {
            if let Ok(i) = ids.binary_search(&id) {
                coords[i].store(((lat as u32 as u64) << 32) | lon as u32 as u64, Ordering::Relaxed);
            }
            let mut no = false;
            while let Some(t) = tags.next() {
                no |= t == ("crossing", "no");
            }
            if no {
                out.push(LatLon { lat, lon });
            }
        };
        for grp in block.groups() {
            for n in grp.dense_nodes() {
                one(n.id(), n.decimicro_lat(), n.decimicro_lon(), &mut n.tags());
            }
            for n in grp.nodes() {
                one(n.id(), n.decimicro_lat(), n.decimicro_lon(), &mut n.tags());
            }
        }
        (!out.is_empty()).then_some(out)
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

    // ---- the areas
    let mut areas: Vec<Area> = Vec::new();
    let mut push_area = |kind: AreaKind, h: Option<String>, rings: Vec<Vec<LatLon>>, areas: &mut Vec<Area>| {
        let rings: Vec<Vec<LatLon>> = rings.into_iter().filter(|r| r.len() >= 3 && r.iter().all(|p| !p.is_none())).collect();
        if rings.is_empty() {
            return;
        }
        if let Some(b) = bbox {
            if !rings.iter().flatten().any(|p| b.contains(p)) {
                return;
            }
        }
        let mut bb = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        for p in rings.iter().flatten() {
            bb = (bb.0.min(p.lat), bb.1.min(p.lon), bb.2.max(p.lat), bb.3.max(p.lon));
        }
        areas.push(Area { kind, hours: h.map_or(u32::MAX, &mut intern), rings, bbox: bb });
    };
    let mut by_rel: FxHashMap<i64, Vec<(bool, Vec<i64>)>> = FxHashMap::default();
    for (_, rel, inner, refs, area) in pieces {
        if rel == 0 {
            if let Some((kind, h)) = area {
                push_area(kind, h, vec![refs[..refs.len() - 1].iter().map(|&i| pos(i)).collect()], &mut areas);
            }
        } else {
            by_rel.entry(rel).or_default().push((inner, refs));
        }
    }
    let mut rels: Vec<i64> = by_rel.keys().copied().collect();
    rels.sort_unstable();
    for rel in rels {
        let parts = &by_rel[&rel];
        let Some((kind, h)) = rel_info.get(&rel).cloned() else { continue };
        let mut all: Vec<i64> = parts.iter().flat_map(|p| p.1.iter().copied()).collect();
        all.sort_unstable();
        all.dedup();
        let mut rings: Vec<Vec<LatLon>> = Vec::new();
        for inner in [false, true] {
            let num: Vec<Vec<u32>> = parts.iter().filter(|p| p.0 == inner).map(|p| p.1.iter().map(|r| all.binary_search(r).unwrap() as u32).collect()).collect();
            let slices: Vec<&[u32]> = num.iter().map(|p| p.as_slice()).collect();
            // inner rings are holes: the even-odd test of `inside` takes them out
            rings.extend(assemble_rings(&slices).into_iter().map(|r| r.into_iter().map(|i| pos(all[i as usize])).collect::<Vec<LatLon>>()));
        }
        push_area(kind, h, rings, &mut areas);
    }
    st.areas = areas.len();
    // a grid of 0.01° cells: the areas whose box meets each
    const CELL: i32 = 100_000;
    let mut grid: FxHashMap<(i32, i32), Vec<u32>> = FxHashMap::default();
    for (i, a) in areas.iter().enumerate() {
        for cy in a.bbox.0.div_euclid(CELL)..=a.bbox.2.div_euclid(CELL) {
            for cx in a.bbox.1.div_euclid(CELL)..=a.bbox.3.div_euclid(CELL) {
                grid.entry((cy, cx)).or_default().push(i as u32);
            }
        }
    }

    // ---- per edge
    // the areas an edge lies in (its points a quarter, half and three quarters along: its ends may lie on the
    // area's outline) that matter to it
    let areas_of = |e: &WalkEdge| -> Vec<u32> {
        let geom = &g.geom[e.geom_off as usize..e.geom_off as usize + e.geom_len as usize];
        let total: f32 = geom.windows(2).map(|w| w[0].dist_m(&w[1])).sum();
        let along = |f: f32| -> LatLon {
            let mut left = f * total;
            for w in geom.windows(2) {
                let d = w[0].dist_m(&w[1]);
                if d > 0.0 && left <= d {
                    return w[0].lerp(&w[1], left / d);
                }
                left -= d;
            }
            geom[geom.len() - 1]
        };
        let pts = [along(0.25), along(0.5), along(0.75)];
        let mid = pts[1];
        let Some(cands) = grid.get(&(mid.lat.div_euclid(CELL), mid.lon.div_euclid(CELL))) else { return Vec::new() };
        cands
            .iter()
            .copied()
            .filter(|&i| {
                let a = &areas[i as usize];
                closes(a.kind, e) && pts.iter().all(|p| p.lat >= a.bbox.0 && p.lat <= a.bbox.2 && p.lon >= a.bbox.1 && p.lon <= a.bbox.3 && inside(*p, &a.rings))
            })
            .collect()
    };
    let per: Vec<(u8, u32, bool)> = g
        .edges
        .par_iter()
        .enumerate()
        .map(|(i, e)| {
            let synthetic = e.flags & EF_AREA != 0;
            // an edge across a square has the square's way (or relation) id: its hours, nothing else of it
            let (mut bits, mut h) = if synthetic {
                (0, way_bits.get(&g.edge_way[i]).map_or(u32::MAX, |x| x.1))
            } else {
                way_bits.get(&g.edge_way[i]).copied().unwrap_or((0, u32::MAX))
            };
            let cycleway = bits & CYCLEWAY != 0;
            bits &= !CYCLEWAY;
            if !matches!(e.kind, EdgeKind::Road | EdgeKind::RoadBusy) {
                bits &= !(EA_ROAD | EA_SIDEWALK_SEPARATE | EA_CAR_ONLY);
            }
            if (e.kind == EdgeKind::Footway && !cycleway) || e.kind == EdgeKind::Pedestrian {
                bits |= EA_FAVOURED;
            }
            let mut by_area = false;
            for a in areas_of(e) {
                let a = &areas[a as usize];
                if a.kind == AreaKind::Park && matches!(e.kind, EdgeKind::Footway | EdgeKind::Path | EdgeKind::Pedestrian) {
                    bits |= EA_FAVOURED;
                }
                if h == u32::MAX && a.hours != u32::MAX {
                    h = a.hours;
                    by_area = true;
                }
            }
            if h != u32::MAX {
                bits |= EA_HOURS;
            }
            (bits, h, by_area)
        })
        .collect();
    let mut attrs = WalkAttrs { graph: graph_fingerprint(g), edge: Vec::with_capacity(per.len()), node: vec![0; g.nodes.len()], hours, edge_hours: Vec::new() };
    for (i, &(bits, h, by_area)) in per.iter().enumerate() {
        attrs.edge.push(bits);
        if h != u32::MAX {
            attrs.edge_hours.push((i as u32, h));
            st.hours_edges += 1;
            st.hours_by_area += by_area as usize;
        }
        if bits & EA_SIDEWALK_SEPARATE != 0 {
            st.separate_edges += 1;
            st.separate_m += g.edges[i].len_m() as f64;
        }
        st.car_only_edges += (bits & EA_CAR_ONLY != 0) as usize;
        st.favoured_edges += (bits & EA_FAVOURED != 0) as usize;
    }
    // crossing=no: the graph's nodes at those coordinates (a graph node sits on its OSM node)
    let no: FxHashSet<(i32, i32)> = no_cross.into_iter().flatten().map(|p| (p.lat, p.lon)).collect();
    for (n, p) in g.nodes.iter().enumerate() {
        if no.contains(&(p.lat, p.lon)) {
            attrs.node[n] |= NA_CROSSING_NO;
            st.crossing_no_nodes += 1;
        }
    }
    st.hours = attrs.hours.len();
    st.hours_readable = attrs.hours.iter().filter(|h| parse_hours_entry(h).is_some()).count();
    Ok((attrs, st))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidewalks_drawn_apart() {
        let sep = |t: &[(&str, &str)]| way_attrs(t).0 & EA_SIDEWALK_SEPARATE != 0;
        assert!(sep(&[("highway", "primary"), ("sidewalk", "separate")]));
        assert!(sep(&[("highway", "residential"), ("sidewalk:both", "separate")]));
        assert!(sep(&[("highway", "secondary"), ("sidewalk:left", "separate"), ("sidewalk:right", "no")]));
        assert!(sep(&[("highway", "tertiary"), ("foot", "use_sidepath")]));
        // a sidewalk on the road's own line on one side: walked there
        assert!(!sep(&[("highway", "secondary"), ("sidewalk:left", "separate"), ("sidewalk:right", "yes")]));
        assert!(!sep(&[("highway", "secondary"), ("sidewalk", "right"), ("sidewalk:left", "separate")]));
        assert!(!sep(&[("highway", "primary"), ("sidewalk", "both")]));
        assert!(!sep(&[("highway", "footway"), ("sidewalk", "separate")]), "not a road");
    }

    #[test]
    fn road_sizes_and_car_only() {
        assert_eq!(way_attrs(&[("highway", "primary_link")]).0 & EA_ROAD, RC_PRIMARY);
        assert_eq!(way_attrs(&[("highway", "living_street")]).0 & EA_ROAD, RC_MINOR);
        assert_eq!(way_attrs(&[("highway", "cycleway")]).0 & EA_ROAD, RC_NONE);
        let car = |t: &[(&str, &str)]| way_attrs(t).0 & EA_CAR_ONLY != 0;
        assert!(car(&[("highway", "service"), ("service", "parking_aisle")]));
        assert!(car(&[("highway", "service"), ("service", "driveway")]));
        assert!(car(&[("highway", "service"), ("access", "customers")]));
        assert!(!car(&[("highway", "service"), ("access", "customers"), ("foot", "yes")]));
        assert!(!car(&[("highway", "service"), ("service", "alley")]));
        assert!(!car(&[("highway", "residential"), ("service", "driveway")]));
    }

    #[test]
    fn hours_of_a_way() {
        assert_eq!(way_attrs(&[("highway", "footway"), ("opening_hours", "06:00-22:00")]).1.as_deref(), Some("oh:06:00-22:00"));
        assert_eq!(way_attrs(&[("highway", "path"), ("access:conditional", "no @ (22:00-06:00)")]).1.as_deref(), Some("no:no @ (22:00-06:00)"));
        assert_eq!(way_attrs(&[("highway", "path"), ("foot", "yes"), ("access:conditional", "no @ (22:00-06:00)")]).1, None, "open to walkers");
        assert_eq!(way_attrs(&[("highway", "service"), ("access:conditional", "delivery @ (Mo-Fr 06:00-11:00)")]).1, None, "closes nothing to walkers");
        assert_eq!(area_kind(&[("leisure", "park"), ("opening_hours", "Mo-Su 07:00-21:00")]), Some((AreaKind::Park, Some("oh:Mo-Su 07:00-21:00".into()))));
        assert_eq!(area_kind(&[("building", "train_station"), ("opening_hours", "Mo-Su 05:00-24:00")]), None, "a ticket office's hours");
        assert_eq!(area_kind(&[("leisure", "park")]), Some((AreaKind::Park, None)), "a park without hours: its paths are favoured");
        assert_eq!(area_kind(&[("shop", "mall")]), None, "a mall without hours");
    }
}
