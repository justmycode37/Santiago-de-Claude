//! A small world in metres for the tests of doors and ends: ways, buildings, doors, rails.

use crate::doors::{build, DoorIndex, DoorStats, NO_STEP};
use kante_core::geo::LatLon;
use kante_core::walk::*;
use kante_osm::buildings::{BuildingRaw, BuildingsRaw, EntranceRaw};
use kante_walk::{SnapOptions, WalkRouter};
use std::sync::Arc;

pub fn pt(x: f32, y: f32) -> LatLon {
    LatLon::from_xy(x, y)
}

#[derive(Default)]
pub struct World {
    pub g: WalkGraph,
    pub x: OsmExtract,
    pub b: BuildingsRaw,
}

pub const NORMAL: WalkProfile = WalkProfile::normal(1.3);
pub const STEP_FREE: WalkProfile = WalkProfile::step_free(1.3);

impl World {
    pub fn new() -> World {
        let mut w = World::default();
        w.g.names.push(String::new());
        w.x.carriageway_names.push(String::new());
        w
    }
    /// The node at (x, y): ways that meet there share it.
    pub fn node(&mut self, x: f32, y: f32) -> u32 {
        let p = pt(x, y);
        if let Some(i) = self.g.nodes.iter().position(|n| n.dist_m(&p) < 0.01) {
            return i as u32;
        }
        self.g.nodes.push(p);
        self.g.node_flags.push(0);
        self.g.nodes.len() as u32 - 1
    }
    pub fn edge(&mut self, a: u32, b: u32, kind: EdgeKind, flags: u16) -> u32 {
        let off = self.g.geom.len() as u32;
        let (pa, pb) = (self.g.nodes[a as usize], self.g.nodes[b as usize]);
        self.g.geom.extend([pa, pb]);
        let steps = if kind == EdgeKind::Steps { 10 } else { 0 };
        self.g.edges.push(WalkEdge { a, b, geom_off: off, geom_len: 2, kind, level_a: LEVEL_NONE, level_b: LEVEL_NONE, steps, flags, len_dm: (pa.dist_m(&pb) * 10.0).round() as u32, name: 0 });
        self.g.edge_way.push(self.g.edges.len() as i64);
        self.g.edges.len() as u32 - 1
    }
    /// A way from a to b in `n` edges; returns its nodes.
    /// A way from a to b in `n` edges (one OSM way); returns its nodes.
    pub fn way(&mut self, a: (f32, f32), b: (f32, f32), n: usize, kind: EdgeKind, flags: u16) -> Vec<u32> {
        let ns: Vec<u32> = (0..=n).map(|i| self.node(a.0 + (b.0 - a.0) * i as f32 / n as f32, a.1 + (b.1 - a.1) * i as f32 / n as f32)).collect();
        let id = 1000 + self.g.edges.len() as i64;
        for w in ns.windows(2) {
            self.edge(w[0], w[1], kind, flags);
            *self.g.edge_way.last_mut().unwrap() = id;
        }
        ns
    }
    /// [`World::way`] with a street name.
    pub fn named_way(&mut self, a: (f32, f32), b: (f32, f32), n: usize, kind: EdgeKind, name: &str) -> Vec<u32> {
        let first = self.g.edges.len();
        let ns = self.way(a, b, n, kind, 0);
        self.g.names.push(name.to_string());
        let ix = self.g.names.len() as u32 - 1;
        for e in &mut self.g.edges[first..] {
            e.name = ix;
        }
        ns
    }
    /// A door with its address.
    pub fn door_addr(&mut self, b: u32, x: f32, y: f32, kind: DoorKind, addr: &str) {
        self.b.entrances.push(EntranceRaw { pos: pt(x, y), building: b, kind, wheelchair: DOOR_WC_UNKNOWN, addr: addr.to_string() });
    }
    pub fn building(&mut self, x0: f32, y0: f32, x1: f32, y1: f32) -> u32 {
        self.b.buildings.push(BuildingRaw { outer: vec![pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)], holes: vec![] });
        self.b.buildings.len() as u32 - 1
    }
    pub fn door(&mut self, b: u32, x: f32, y: f32, kind: DoorKind, wheelchair: u8) {
        self.b.entrances.push(EntranceRaw { pos: pt(x, y), building: b, kind, wheelchair, addr: format!("Door {}", self.b.entrances.len()) });
    }
    pub fn rail(&mut self, pts: &[(f32, f32)], off_ground: bool) {
        let off = self.x.carriageway_geom.len() as u32;
        self.x.carriageway_geom.extend(pts.iter().map(|&(x, y)| pt(x, y)));
        self.x.carriageways.push(Carriageway { kind: CarriagewayKind::RailTrack, geom_off: off, geom_len: pts.len() as u16, name: 0, off_ground });
    }
    pub fn router(mut self) -> (WalkRouter, OsmExtract, BuildingsRaw) {
        let n = self.g.nodes.len();
        let mut off = vec![0u32; n + 1];
        for ed in &self.g.edges {
            off[ed.a as usize + 1] += 1;
            off[ed.b as usize + 1] += 1;
        }
        for i in 1..=n {
            off[i] += off[i - 1];
        }
        let mut adj = vec![0u32; off[n] as usize];
        let mut cur = off.clone();
        for (e, ed) in self.g.edges.iter().enumerate() {
            for node in [ed.a, ed.b] {
                adj[cur[node as usize] as usize] = e as u32;
                cur[node as usize] += 1;
            }
        }
        self.g.adj_off = off;
        self.g.adj = adj;
        (WalkRouter::new(Arc::new(self.g)), self.x, self.b)
    }
    pub fn finish(self) -> (WalkRouter, DoorIndex) {
        let (r, ix, _) = self.finish_with_stats();
        (r, ix)
    }
    pub fn finish_with_stats(self) -> (WalkRouter, DoorIndex, DoorStats) {
        let (router, x, b) = self.router();
        let (doors, st) = build(&b, &[], &router, &x);
        (router, DoorIndex::new(doors), st)
    }
}

/// A boarding point's link: the nearest way at (x, y), as the stop linker would put it.
pub fn snap(r: &WalkRouter, x: f32, y: f32, p: &WalkProfile) -> Snap {
    r.snap(pt(x, y), &SnapOptions { max_dist_m: 100.0, level: None, profile: Some(*p), exclude_kinds: NO_STEP }).unwrap()
}
