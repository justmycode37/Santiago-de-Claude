//! Stop-to-stop path finder on OpenStreetMap rails, roads and ferry lines.
//!
//! Loads an OSM PBF once, then answers queries on stdin, one per line:
//!     <id> <profile> <fromLon> <fromLat> <toLon> <toLat>
//! and prints `<id> <encoded polyline>` or `<id> -` when there is no
//! believable path. Profiles: bus, rail, tram, metro, funi, boat.

use osmpbf::{Element, ElementReader};
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::io::{BufRead, Write};
use std::sync::{mpsc, Arc, Mutex};

const M: f64 = 111_195.0; // metres per degree of latitude

// Way classes.
const MOTORWAY: u8 = 0;
const TRUNK: u8 = 1;
const PRIMARY: u8 = 2;
const SECONDARY: u8 = 3;
const TERTIARY: u8 = 4;
const UNCLASSIFIED: u8 = 5;
const RESIDENTIAL: u8 = 6;
const LIVING: u8 = 7;
const SERVICE: u8 = 8;
const BUSWAY: u8 = 9;
const TRACK: u8 = 10;
const RAIL: u8 = 11;
const NARROW: u8 = 12;
const LIGHT: u8 = 13;
const TRAM: u8 = 14;
const SUBWAY: u8 = 15;
const FUNI: u8 = 16;
const FERRY: u8 = 17;
const NCLASS: usize = 18;

// Edge flags. "Forward" is from node a to node b.
const F_FWD: u8 = 1;
const F_BWD: u8 = 2;
const F_FWD_WRONG: u8 = 4; // allowed, but against a one-way: costs extra
const F_BWD_WRONG: u8 = 8;
const F_PENAL: u8 = 16; // restricted road or siding: costs extra

struct Profile {
    speed: [f32; NCLASS], // m/s; 0 = this mode cannot use the class
    wrong_way: f32,
    penal: f32,
    radius: f64,    // how far a stop may be from the way it snaps to, metres
    max_cands: usize,
    snap_cost: f32, // seconds charged per metre of snapping distance
    vmax: f32,
    ratio: f64, // a path longer than ratio × straight + slack is rejected
    slack: f64,
}

fn profile(name: &str) -> Option<Profile> {
    let mut s = [0f32; NCLASS];
    Some(match name {
        "bus" => {
            s[MOTORWAY as usize] = 25.0;
            s[TRUNK as usize] = 22.0;
            s[PRIMARY as usize] = 15.0;
            s[SECONDARY as usize] = 13.5;
            s[TERTIARY as usize] = 12.0;
            s[UNCLASSIFIED as usize] = 9.0;
            s[RESIDENTIAL as usize] = 6.5;
            s[LIVING as usize] = 3.0;
            s[SERVICE as usize] = 4.0;
            s[BUSWAY as usize] = 12.0;
            s[TRACK as usize] = 3.0;
            Profile { speed: s, wrong_way: 6.0, penal: 3.0, radius: 150.0, max_cands: 10, snap_cost: 0.35, vmax: 25.0, ratio: 4.0, slack: 600.0 }
        }
        "rail" => {
            s[RAIL as usize] = 30.0;
            s[NARROW as usize] = 30.0;
            s[LIGHT as usize] = 15.0;
            s[TRAM as usize] = 4.0;
            s[SUBWAY as usize] = 4.0;
            s[FUNI as usize] = 4.0;
            Profile { speed: s, wrong_way: 1.0, penal: 3.0, radius: 400.0, max_cands: 16, snap_cost: 0.05, vmax: 30.0, ratio: 3.0, slack: 1500.0 }
        }
        "tram" => {
            s[TRAM as usize] = 10.0;
            s[LIGHT as usize] = 10.0;
            s[NARROW as usize] = 8.0;
            s[SUBWAY as usize] = 8.0;
            s[RAIL as usize] = 4.0;
            Profile { speed: s, wrong_way: 1.0, penal: 3.0, radius: 150.0, max_cands: 10, snap_cost: 0.3, vmax: 10.0, ratio: 3.0, slack: 500.0 }
        }
        "metro" => {
            s[SUBWAY as usize] = 12.0;
            s[LIGHT as usize] = 10.0;
            s[TRAM as usize] = 5.0;
            s[RAIL as usize] = 4.0;
            s[NARROW as usize] = 4.0;
            Profile { speed: s, wrong_way: 1.0, penal: 3.0, radius: 300.0, max_cands: 10, snap_cost: 0.1, vmax: 12.0, ratio: 3.0, slack: 500.0 }
        }
        "funi" => {
            s[FUNI as usize] = 5.0;
            s[RAIL as usize] = 2.0;
            s[NARROW as usize] = 2.0;
            s[LIGHT as usize] = 2.0;
            Profile { speed: s, wrong_way: 1.0, penal: 3.0, radius: 300.0, max_cands: 8, snap_cost: 0.1, vmax: 5.0, ratio: 2.5, slack: 300.0 }
        }
        "boat" => {
            s[FERRY as usize] = 8.0;
            Profile { speed: s, wrong_way: 1.0, penal: 1.0, radius: 2000.0, max_cands: 8, snap_cost: 0.02, vmax: 8.0, ratio: 3.0, slack: 2000.0 }
        }
        _ => return None,
    })
}

struct WayRec {
    class: u8,
    flags: u8,
    refs: Vec<i64>,
}

/// Which graph classes a way belongs to (a way can be both a road and a tramway).
fn classify(way: &osmpbf::Way) -> Vec<(u8, u8)> {
    let (mut highway, mut railway, mut route, mut oneway, mut junction) = ("", "", "", "", "");
    let (mut access, mut vehicle, mut motor_vehicle, mut bus, mut psv, mut service) = ("", "", "", "", "", "");
    let mut contra = false; // buses may run against the one-way
    for (k, v) in way.tags() {
        match k {
            "highway" => highway = v,
            "railway" => railway = v,
            "route" => route = v,
            "oneway" => oneway = v,
            "junction" => junction = v,
            "access" => access = v,
            "vehicle" => vehicle = v,
            "motor_vehicle" => motor_vehicle = v,
            "bus" => bus = v,
            "psv" => psv = v,
            "service" => service = v,
            "oneway:bus" | "oneway:psv" => contra |= v == "no",
            "busway" | "busway:left" | "busway:right" | "busway:both" => contra |= v == "opposite_lane" || v == "opposite",
            "lanes:bus:backward" | "lanes:psv:backward" => contra = true,
            "bus:backward" | "psv:backward" => contra |= v == "yes" || v == "designated",
            _ => {}
        }
    }
    let mut out = Vec::new();
    let both = F_FWD | F_BWD;

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
        out.push((c, both | if siding { F_PENAL } else { 0 }));
    }
    if route == "ferry" {
        out.push((FERRY, both));
    }

    let yes = |v: &str| matches!(v, "yes" | "designated" | "official" | "permissive");
    let bus_ok = yes(bus) || yes(psv);
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
            _ => if highway == "motorway" || roundabout { 1 } else { 0 },
        };
        let strict = c == MOTORWAY || roundabout;
        let mut f = if dir == 0 || (contra && !strict) {
            both
        } else if dir == 1 {
            if strict { F_FWD } else { both | F_BWD_WRONG }
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
    out
}

struct Grid {
    w: f64,
    s: f64,
    cw: f64,
    ch: f64,
    nx: usize,
    ny: usize,
    off: Vec<u32>,
    items: Vec<u32>,
}

impl Grid {
    fn cx(&self, lon: f64) -> usize {
        (((lon - self.w) / self.cw).floor().max(0.0) as usize).min(self.nx - 1)
    }
    fn cy(&self, lat: f64) -> usize {
        (((lat - self.s) / self.ch).floor().max(0.0) as usize).min(self.ny - 1)
    }
}

struct Graph {
    lon: Vec<f64>,
    lat: Vec<f64>,
    ea: Vec<u32>,
    eb: Vec<u32>,
    elen: Vec<f32>,
    eclass: Vec<u8>,
    eflags: Vec<u8>,
    adj_off: Vec<u32>,
    adj: Vec<u32>, // edge << 1 | dir; dir 0 leaves from a, dir 1 leaves from b
    grid: Grid,
}

fn dist_m(lon1: f64, lat1: f64, lon2: f64, lat2: f64) -> f64 {
    let c = ((lat1 + lat2) * 0.5).to_radians().cos();
    let dx = (lon2 - lon1) * c * M;
    let dy = (lat2 - lat1) * M;
    (dx * dx + dy * dy).sqrt()
}

struct Cand {
    edge: u32,
    t: f32, // 0 at a, 1 at b
    lon: f64,
    lat: f64,
    d: f32,
}

impl Graph {
    fn load(path: &str) -> Result<Graph, Box<dyn std::error::Error>> {
        let t0 = std::time::Instant::now();
        let ways: Vec<WayRec> = ElementReader::from_path(path)?.par_map_reduce(
            |el| match el {
                Element::Way(w) => {
                    let cls = classify(&w);
                    if cls.is_empty() {
                        return Vec::new();
                    }
                    let refs: Vec<i64> = w.refs().collect();
                    if refs.len() < 2 {
                        return Vec::new();
                    }
                    cls.into_iter().map(|(class, flags)| WayRec { class, flags, refs: refs.clone() }).collect()
                }
                _ => Vec::new(),
            },
            Vec::new,
            |mut a, mut b| {
                if a.len() < b.len() {
                    std::mem::swap(&mut a, &mut b);
                }
                a.append(&mut b);
                a
            },
        )?;
        eprintln!("shaper: {} ways in {:.1}s", ways.len(), t0.elapsed().as_secs_f32());

        let mut ids: Vec<i64> = ways.iter().flat_map(|w| w.refs.iter().copied()).collect();
        ids.sort_unstable();
        ids.dedup();
        let n = ids.len();
        let ids_ref = &ids;
        let found: Vec<(u32, f64, f64)> = ElementReader::from_path(path)?.par_map_reduce(
            |el| {
                let (id, lon, lat) = match el {
                    Element::DenseNode(nd) => (nd.id(), nd.lon(), nd.lat()),
                    Element::Node(nd) => (nd.id(), nd.lon(), nd.lat()),
                    _ => return Vec::new(),
                };
                match ids_ref.binary_search(&id) {
                    Ok(i) => vec![(i as u32, lon, lat)],
                    Err(_) => Vec::new(),
                }
            },
            Vec::new,
            |mut a, mut b| {
                if a.len() < b.len() {
                    std::mem::swap(&mut a, &mut b);
                }
                a.append(&mut b);
                a
            },
        )?;
        let mut lon = vec![f64::NAN; n];
        let mut lat = vec![f64::NAN; n];
        for (i, x, y) in found {
            lon[i as usize] = x;
            lat[i as usize] = y;
        }
        eprintln!("shaper: {} nodes in {:.1}s", n, t0.elapsed().as_secs_f32());

        let (mut ea, mut eb, mut elen, mut eclass, mut eflags) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
        for w in &ways {
            let mut prev: Option<u32> = None;
            for r in &w.refs {
                let i = ids.binary_search(r).unwrap() as u32;
                if lon[i as usize].is_nan() {
                    prev = None; // node outside the extract
                    continue;
                }
                if let Some(p) = prev {
                    if p != i {
                        let (pu, iu) = (p as usize, i as usize);
                        ea.push(p);
                        eb.push(i);
                        elen.push(dist_m(lon[pu], lat[pu], lon[iu], lat[iu]) as f32);
                        eclass.push(w.class);
                        eflags.push(w.flags);
                    }
                }
                prev = Some(i);
            }
        }
        drop(ways);
        drop(ids);
        let ne = ea.len();

        let mut adj_off = vec![0u32; n + 1];
        for e in 0..ne {
            adj_off[ea[e] as usize + 1] += 1;
            adj_off[eb[e] as usize + 1] += 1;
        }
        for i in 0..n {
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
        drop(fill);

        let (mut w, mut s, mut e_, mut n_) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for i in 0..n {
            if !lon[i].is_nan() {
                w = w.min(lon[i]);
                e_ = e_.max(lon[i]);
                s = s.min(lat[i]);
                n_ = n_.max(lat[i]);
            }
        }
        let (cw, ch) = (0.0015, 0.001); // about 115 × 111 m
        let nx = ((e_ - w) / cw).ceil() as usize + 1;
        let ny = ((n_ - s) / ch).ceil() as usize + 1;
        let mut grid = Grid { w, s, cw, ch, nx, ny, off: vec![0u32; nx * ny + 1], items: Vec::new() };
        let cells = |g: &Grid, e: usize| {
            let (a, b) = (ea[e] as usize, eb[e] as usize);
            let (x0, x1) = (g.cx(lon[a].min(lon[b])), g.cx(lon[a].max(lon[b])));
            let (y0, y1) = (g.cy(lat[a].min(lat[b])), g.cy(lat[a].max(lat[b])));
            (x0, x1, y0, y1)
        };
        for e in 0..ne {
            let (x0, x1, y0, y1) = cells(&grid, e);
            for y in y0..=y1 {
                for x in x0..=x1 {
                    grid.off[y * nx + x + 1] += 1;
                }
            }
        }
        for i in 0..nx * ny {
            grid.off[i + 1] += grid.off[i];
        }
        let mut gfill = grid.off.clone();
        let mut items = vec![0u32; grid.off[nx * ny] as usize];
        for e in 0..ne {
            let (x0, x1, y0, y1) = cells(&grid, e);
            for y in y0..=y1 {
                for x in x0..=x1 {
                    let c = y * nx + x;
                    items[gfill[c] as usize] = e as u32;
                    gfill[c] += 1;
                }
            }
        }
        grid.items = items;
        eprintln!("shaper: graph of {} nodes, {} edges ready in {:.1}s", n, ne, t0.elapsed().as_secs_f32());
        Ok(Graph { lon, lat, ea, eb, elen, eclass, eflags, adj_off, adj, grid })
    }

    #[inline]
    fn cost(&self, p: &Profile, e: usize, dir: u32) -> f32 {
        let sp = p.speed[self.eclass[e] as usize];
        if sp <= 0.0 {
            return f32::INFINITY;
        }
        let fl = self.eflags[e];
        let (allow, wrong) = if dir == 0 { (fl & F_FWD, fl & F_FWD_WRONG) } else { (fl & F_BWD, fl & F_BWD_WRONG) };
        if allow == 0 {
            return f32::INFINITY;
        }
        let mut t = self.elen[e] / sp;
        if wrong != 0 {
            t *= p.wrong_way;
        }
        if fl & F_PENAL != 0 {
            t *= p.penal;
        }
        t
    }

    /// The nearest usable ways around a stop, at most one per spot.
    fn candidates(&self, p: &Profile, lon: f64, lat: f64) -> Vec<Cand> {
        let cosl = lat.to_radians().cos();
        let rlat = p.radius / M;
        let rlon = rlat / cosl;
        let g = &self.grid;
        let (x0, x1, y0, y1) = (g.cx(lon - rlon), g.cx(lon + rlon), g.cy(lat - rlat), g.cy(lat + rlat));
        let mut v: Vec<Cand> = Vec::new();
        for cy in y0..=y1 {
            for cx in x0..=x1 {
                let c = cy * g.nx + cx;
                for &e in &g.items[g.off[c] as usize..g.off[c + 1] as usize] {
                    let eu = e as usize;
                    if p.speed[self.eclass[eu] as usize] <= 0.0 {
                        continue;
                    }
                    let (a, b) = (self.ea[eu] as usize, self.eb[eu] as usize);
                    let (ax, ay) = ((self.lon[a] - lon) * cosl * M, (self.lat[a] - lat) * M);
                    let (bx, by) = ((self.lon[b] - lon) * cosl * M, (self.lat[b] - lat) * M);
                    let (dx, dy) = (bx - ax, by - ay);
                    let l2 = dx * dx + dy * dy;
                    let t = if l2 > 0.0 { ((-ax * dx - ay * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
                    let (px, py) = (ax + t * dx, ay + t * dy);
                    let d = (px * px + py * py).sqrt();
                    if d <= p.radius {
                        v.push(Cand { edge: e, t: t as f32, lon: lon + px / (cosl * M), lat: lat + py / M, d: d as f32 });
                    }
                }
            }
        }
        v.sort_by(|a, b| a.d.partial_cmp(&b.d).unwrap().then(a.edge.cmp(&b.edge)));
        let mut out: Vec<Cand> = Vec::new();
        for c in v {
            if out.iter().any(|o| o.edge == c.edge || dist_m(o.lon, o.lat, c.lon, c.lat) < 8.0) {
                continue;
            }
            out.push(c);
            if out.len() >= p.max_cands {
                break;
            }
        }
        out
    }
}

struct Scratch {
    dist: Vec<f32>,
    prev: Vec<u32>,
    stamp: Vec<u32>,
    cur: u32,
}

const SEED: u32 = 0xFFFF_FF00;

enum Best {
    None,
    Direct(usize, usize),
    Via(u32, usize),
}

fn route(g: &Graph, p: &Profile, s: &mut Scratch, fx: f64, fy: f64, tx: f64, ty: f64) -> Option<Vec<(f64, f64)>> {
    let straight = dist_m(fx, fy, tx, ty);
    if straight < 15.0 {
        return None;
    }
    let cs = g.candidates(p, fx, fy);
    let ct = g.candidates(p, tx, ty);
    if cs.is_empty() || ct.is_empty() {
        return None;
    }
    s.cur = s.cur.wrapping_add(1);
    if s.cur == 0 {
        s.stamp.iter_mut().for_each(|x| *x = 0);
        s.cur = 1;
    }
    let cur = s.cur;
    let mut best_total = f32::INFINITY;
    let mut best = Best::None;

    // Both stops on the same piece of way.
    for (si, a) in cs.iter().enumerate() {
        for (ti, b) in ct.iter().enumerate() {
            if a.edge != b.edge {
                continue;
            }
            let e = a.edge as usize;
            let c = if b.t >= a.t { (b.t - a.t) * g.cost(p, e, 0) } else { (a.t - b.t) * g.cost(p, e, 1) };
            let total = c + (a.d + b.d) * p.snap_cost;
            if total < best_total {
                best_total = total;
                best = Best::Direct(si, ti);
            }
        }
    }

    // Nodes from which a target point can be reached, with the remaining cost.
    let mut targets: Vec<(u32, usize, f32)> = Vec::new();
    for (ti, c) in ct.iter().enumerate() {
        let e = c.edge as usize;
        let pen = c.d * p.snap_cost;
        let (cab, cba) = (g.cost(p, e, 0), g.cost(p, e, 1));
        if cab.is_finite() {
            targets.push((g.ea[e], ti, c.t * cab + pen));
        }
        if cba.is_finite() {
            targets.push((g.eb[e], ti, (1.0 - c.t) * cba + pen));
        }
    }

    let mut heap: BinaryHeap<Reverse<(u32, u32, u32)>> = BinaryHeap::new();
    let h = |n: u32| -> f32 { ((dist_m(g.lon[n as usize], g.lat[n as usize], tx, ty) - p.radius).max(0.0) as f32) / p.vmax };
    let relax = |s: &mut Scratch, heap: &mut BinaryHeap<Reverse<(u32, u32, u32)>>, n: u32, gc: f32, via: u32| {
        let nu = n as usize;
        if s.stamp[nu] != cur || gc < s.dist[nu] {
            s.stamp[nu] = cur;
            s.dist[nu] = gc;
            s.prev[nu] = via;
            heap.push(Reverse(((gc + h(n)).to_bits(), gc.to_bits(), n)));
        }
    };
    for (si, c) in cs.iter().enumerate() {
        let e = c.edge as usize;
        let pen = c.d * p.snap_cost;
        let (cab, cba) = (g.cost(p, e, 0), g.cost(p, e, 1));
        if cab.is_finite() {
            relax(s, &mut heap, g.eb[e], pen + (1.0 - c.t) * cab, SEED + si as u32);
        }
        if cba.is_finite() {
            relax(s, &mut heap, g.ea[e], pen + c.t * cba, SEED + si as u32);
        }
    }

    let mut pops = 0u32;
    while let Some(Reverse((fb, gb, n))) = heap.pop() {
        let (f, gc) = (f32::from_bits(fb), f32::from_bits(gb));
        if f >= best_total {
            break;
        }
        let nu = n as usize;
        if gc > s.dist[nu] {
            continue;
        }
        pops += 1;
        if pops > 4_000_000 {
            break;
        }
        for &(tn, ti, c) in &targets {
            if tn == n && gc + c < best_total {
                best_total = gc + c;
                best = Best::Via(n, ti);
            }
        }
        for &code in &g.adj[g.adj_off[nu] as usize..g.adj_off[nu + 1] as usize] {
            let e = (code >> 1) as usize;
            let dir = code & 1;
            let c = g.cost(p, e, dir);
            if !c.is_finite() {
                continue;
            }
            let m = if dir == 0 { g.eb[e] } else { g.ea[e] };
            relax(s, &mut heap, m, gc + c, code);
        }
    }

    let mut pts: Vec<(f64, f64)> = Vec::new();
    match best {
        Best::None => return None,
        Best::Direct(si, ti) => {
            pts.push((cs[si].lon, cs[si].lat));
            pts.push((ct[ti].lon, ct[ti].lat));
        }
        Best::Via(end, ti) => {
            let mut nodes = vec![end];
            let mut n = end;
            let si;
            loop {
                let pv = s.prev[n as usize];
                if pv >= SEED {
                    si = (pv - SEED) as usize;
                    break;
                }
                let e = (pv >> 1) as usize;
                n = if pv & 1 == 0 { g.ea[e] } else { g.eb[e] };
                nodes.push(n);
            }
            pts.push((cs[si].lon, cs[si].lat));
            for &nd in nodes.iter().rev() {
                pts.push((g.lon[nd as usize], g.lat[nd as usize]));
            }
            pts.push((ct[ti].lon, ct[ti].lat));
        }
    }
    pts.dedup_by(|a, b| (a.0 - b.0).abs() < 1e-7 && (a.1 - b.1).abs() < 1e-7);
    if pts.len() < 2 {
        return None;
    }
    let len: f64 = pts.windows(2).map(|w| dist_m(w[0].0, w[0].1, w[1].0, w[1].1)).sum();
    if len > p.ratio * straight + p.slack {
        return None;
    }
    Some(simplify(&pts, 2.0))
}

/// Douglas–Peucker, tolerance in metres.
fn simplify(pts: &[(f64, f64)], tol: f64) -> Vec<(f64, f64)> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let cosl = pts[0].1.to_radians().cos();
    let xy: Vec<(f64, f64)> = pts.iter().map(|p| (p.0 * cosl * M, p.1 * M)).collect();
    let mut keep = vec![false; pts.len()];
    keep[0] = true;
    keep[pts.len() - 1] = true;
    let mut stack = vec![(0usize, pts.len() - 1)];
    while let Some((a, b)) = stack.pop() {
        if b <= a + 1 {
            continue;
        }
        let (ax, ay) = xy[a];
        let (dx, dy) = (xy[b].0 - ax, xy[b].1 - ay);
        let l2 = dx * dx + dy * dy;
        let (mut worst, mut wi) = (0.0, a);
        for i in a + 1..b {
            let (px, py) = (xy[i].0 - ax, xy[i].1 - ay);
            let t = if l2 > 0.0 { ((px * dx + py * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
            let d = ((px - t * dx).powi(2) + (py - t * dy).powi(2)).sqrt();
            if d > worst {
                worst = d;
                wi = i;
            }
        }
        if worst > tol {
            keep[wi] = true;
            stack.push((a, wi));
            stack.push((wi, b));
        }
    }
    pts.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| *p).collect()
}

/// Google encoded polyline, precision 5, latitude first.
fn encode(pts: &[(f64, f64)]) -> String {
    fn put(out: &mut String, v: i64) {
        let mut v = if v < 0 { !(v << 1) } else { v << 1 };
        while v >= 0x20 {
            out.push((((v & 0x1f) | 0x20) as u8 + 63) as char);
            v >>= 5;
        }
        out.push((v as u8 + 63) as char);
    }
    let mut out = String::new();
    let (mut plat, mut plon) = (0i64, 0i64);
    for &(lon, lat) in pts {
        let (la, lo) = ((lat * 1e5).round() as i64, (lon * 1e5).round() as i64);
        put(&mut out, la - plat);
        put(&mut out, lo - plon);
        plat = la;
        plon = lo;
    }
    out
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: shaper <file.osm.pbf>");
    let g = Arc::new(Graph::load(&path).expect("cannot read the OSM file"));
    let n = g.lon.len();
    let (tx, rx) = mpsc::channel::<String>();
    let rx = Arc::new(Mutex::new(rx));
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let workers: Vec<_> = (0..6)
        .map(|_| {
            let (g, rx, out) = (g.clone(), rx.clone(), out.clone());
            std::thread::spawn(move || {
                let mut s = Scratch { dist: vec![0.0; n], prev: vec![0; n], stamp: vec![0; n], cur: 0 };
                loop {
                    let line = match rx.lock().unwrap().recv() {
                        Ok(l) => l,
                        Err(_) => return,
                    };
                    let f: Vec<&str> = line.split_whitespace().collect();
                    if f.len() != 6 {
                        continue;
                    }
                    let num = |i: usize| f[i].parse::<f64>().ok();
                    let res = match (profile(f[1]), num(2), num(3), num(4), num(5)) {
                        (Some(p), Some(a), Some(b), Some(c), Some(d)) => route(&g, &p, &mut s, a, b, c, d),
                        _ => None,
                    };
                    let text = match res {
                        Some(pts) => encode(&pts),
                        None => "-".to_string(),
                    };
                    let mut o = out.lock().unwrap();
                    let _ = writeln!(o, "{} {}", f[0], text);
                    let _ = o.flush();
                }
            })
        })
        .collect();
    {
        let mut o = out.lock().unwrap();
        let _ = writeln!(o, "READY {} nodes {} edges", n, g.ea.len());
        let _ = o.flush();
    }
    for line in std::io::stdin().lock().lines() {
        match line {
            Ok(l) => {
                if tx.send(l).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    drop(tx);
    for w in workers {
        let _ = w.join();
    }
}
