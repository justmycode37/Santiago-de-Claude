//! Everything the server keeps in memory, and the small helpers that turn
//! engine indices into API objects.

use crate::json;
use anyhow::{Context, Result};
use kante_core::geo::{BBox, LatLon};
use kante_core::time::Secs;
use kante_core::*;
use kante_raptor::Router;
use kante_search::SearchIndex;
use kante_walk::WalkRouter;
use parking_lot::RwLock;
use rustc_hash::FxHashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

/// Uniform grid over points for radius and bbox lookups.
pub struct PointGrid {
    cell_m: f32,
    /// (cell key, point index), sorted by key.
    cells: Vec<(u64, u32)>,
}

impl PointGrid {
    pub fn new(points: impl Iterator<Item = (u32, LatLon)>, cell_m: f32) -> Self {
        let mut cells: Vec<(u64, u32)> = points.filter(|(_, p)| !p.is_none()).map(|(i, p)| (Self::key_of(&p, cell_m), i)).collect();
        cells.sort_unstable();
        PointGrid { cell_m, cells }
    }
    fn cell(p: &LatLon, cell_m: f32) -> (i32, i32) {
        let (x, y) = p.xy();
        ((x / cell_m).floor() as i32, (y / cell_m).floor() as i32)
    }
    fn key(cx: i32, cy: i32) -> u64 {
        (((cx as i64 + (1 << 30)) as u64) << 32) | ((cy as i64 + (1 << 30)) as u64)
    }
    fn key_of(p: &LatLon, cell_m: f32) -> u64 {
        let (cx, cy) = Self::cell(p, cell_m);
        Self::key(cx, cy)
    }
    /// Calls `f` for every point index in cells touching `bbox` (a superset of the points inside).
    pub fn for_bbox(&self, bbox: &BBox, mut f: impl FnMut(u32)) {
        let (x0, y0) = Self::cell(&bbox.min, self.cell_m);
        let (x1, y1) = Self::cell(&bbox.max, self.cell_m);
        if (x1 - x0) as i64 * (y1 - y0) as i64 > 250_000 {
            return; // absurdly large request
        }
        for cx in x0..=x1 {
            let lo = self.cells.partition_point(|c| c.0 < Self::key(cx, y0));
            for c in &self.cells[lo..] {
                if c.0 > Self::key(cx, y1) {
                    break;
                }
                f(c.1);
            }
        }
    }
    pub fn around(&self, p: LatLon, radius_m: f32, f: impl FnMut(u32)) {
        self.for_bbox(&BBox::around(p, radius_m), f)
    }
}

pub struct LiveState {
    pub view: Option<Arc<dyn LiveView>>,
    pub meta: json::RealtimeMeta,
}

pub struct App {
    pub tt: Arc<Timetable>,
    pub router: Router,
    pub walk: Option<WalkRouter>,
    pub links: Option<Vec<StopLink>>,
    pub fp_normal: Footpaths,
    pub fp_step_free: Footpaths,
    pub fp_few: Footpaths,
    pub search: Option<SearchIndex>,
    pub stop_grid: PointGrid,
    pub station_grid: PointGrid,
    pub station_ids: FxHashMap<String, StationIdx>,
    pub stop_ids: FxHashMap<String, StopIdx>,
    /// ATLAS SLOID → the engine's quays on it. Usually one, whose id is the SLOID; a platform
    /// whose sectors the timetable splits has one quay per part (`…_pf:5A-C`).
    pub sloid_stops: FxHashMap<String, Vec<StopIdx>>,
    /// Normalised station names for the fallback search.
    pub station_norm: Vec<String>,
    pub live: RwLock<LiveState>,
    /// Each live feed's last matched trips (see `live.rs`).
    pub feeds: parking_lot::Mutex<crate::live::Feeds>,
    /// Bumped whenever a new live snapshot is swapped in (for `/api/stream`).
    pub live_tx: tokio::sync::watch::Sender<u64>,
    /// Set when the server shuts down, so open streams end and do not hold it up.
    pub shutdown: tokio::sync::watch::Sender<bool>,
    /// Vehicle lists being computed at once (requests and streams wait their turn).
    pub heavy: Arc<tokio::sync::Semaphore>,
    /// Open `/api/stream` connections.
    pub streams: std::sync::atomic::AtomicUsize,
    /// Learned travel and dwell times per pair of stops.
    pub profiles: crate::profiles::Shared,
    pub walk_bbox: BBox,
    pub data_dir: PathBuf,
    /// Buildings and their doors (`doors.bin`), for walks that start in or end at one.
    pub doors: Option<kante_link::doors::DoorIndex>,
    /// The way each pattern's vehicles take on the rails and roads (`shapes.bin`); None: straight lines between stops.
    pub shapes: Option<kante_shapes::Shapes>,
}

pub struct Endpoint {
    pub place: json::Place,
    pub pos: LatLon,
    pub station: Option<StationIdx>,
}

use kante_link::ends::{self, End};

/// Stops reachable on foot from an endpoint.
pub struct Reach {
    pub stops: Vec<(StopIdx, Secs)>,
    /// The endpoint's ways onto the network the stops were reached from (the walks drawn take them too).
    pub end: End,
    /// How each stop was reached: `station` (a stop of the station asked for), `point` (a line from the point),
    /// `door` (through a door), `line` (no network: the straight line).
    pub via: FxHashMap<StopIdx, &'static str>,
}

/// Seconds added to every walked access/egress on top of the walking time:
/// finding the exact spot, the doors closing a little early. Shown to the
/// user as slack, not as walking.
pub const ACCESS_BUFFER_S: Secs = 30;

const SIDE_WORDS: [&str; 8] = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
const SIDE_CODES: [&str; 8] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const MODE_ORDER: [Mode; 11] = [
    Mode::Rail,
    Mode::Metro,
    Mode::Tram,
    Mode::Bus,
    Mode::Boat,
    Mode::RackRail,
    Mode::Funicular,
    Mode::Cableway,
    Mode::Lift,
    Mode::OnDemand,
    Mode::Other,
];

pub fn modes_list(mask: u16) -> Vec<&'static str> {
    MODE_ORDER.iter().filter(|m| mask & m.bit() != 0).map(|m| m.as_str()).collect()
}

pub fn level_f(l: Level2) -> Option<f32> {
    (l != LEVEL_NONE).then(|| l as f32 * 0.5)
}

pub fn lonlat(p: &LatLon) -> [f64; 2] {
    [round7(p.lon_deg()), round7(p.lat_deg())]
}

fn round7(v: f64) -> f64 {
    (v * 1e7).round() / 1e7
}

/// Merge the normal and step-free footpaths into the "fewer stairs" set: take
/// the step-free walk wherever it costs at most ~35 % + 40 s more.
fn merge_few(normal: &Footpaths, step_free: &Footpaths) -> Footpaths {
    let n = normal.off.len().saturating_sub(1);
    let mut out = Footpaths { off: Vec::with_capacity(n + 1), ..Default::default() };
    let t = |v: u16, f: u16| walk_secs(v as f32, f as f32, DEFAULT_SPEED_MPS);
    for s in 0..n as u32 {
        out.off.push(out.to.len() as u32);
        for (to, v, f) in normal.from(s) {
            let (mut bv, mut bf) = (v, f);
            if s < step_free.off.len().saturating_sub(1) as u32 {
                if let Some((sv, sf)) = step_free.get(s, to) {
                    if t(sv, sf) <= t(v, f) * 1.35 + 40.0 {
                        (bv, bf) = (sv, sf);
                    }
                }
            }
            out.to.push(to);
            out.var_m.push(bv);
            out.fix_s.push(bf);
        }
    }
    out.off.push(out.to.len() as u32);
    out
}

/// The slopes in `slopes.bin` when they belong to graph `g` (none when the file is missing, unreadable or of
/// another build).
pub fn load_slopes(path: &Path, g: &WalkGraph) -> Option<Vec<EdgeSlope>> {
    if !path.exists() {
        return None;
    }
    let s = io::load::<Slopes>(path, SLOPES_SCHEMA).ok()?;
    (s.graph == graph_fingerprint(g) && s.edges.len() == g.edges.len()).then_some(s.edges)
}

/// The attributes in `walkattr.bin` when they belong to graph `g` (none when the file is missing, unreadable or of
/// another build: every edge then as before they were read).
pub fn load_attrs(path: &Path, g: &WalkGraph) -> Option<WalkAttrs> {
    if !path.exists() {
        return None;
    }
    let a = io::load::<WalkAttrs>(path, WALKATTR_SCHEMA).ok()?;
    (a.graph == graph_fingerprint(g) && a.fits(g)).then_some(a)
}

fn timed<T>(what: &str, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let t = Instant::now();
    let r = f().with_context(|| what.to_string())?;
    eprintln!("  {what}: {:.2}s", t.elapsed().as_secs_f32());
    Ok(r)
}

impl App {
    pub fn load(data_dir: &Path) -> Result<App> {
        let built = data_dir.join("built");
        let t0 = Instant::now();
        eprintln!("loading caches from {}", built.display());

        // The big caches are independent: load them side by side.
        let (tt, (walk_parts, search)) = rayon::join(
            || timed("timetable", || io::load::<Timetable>(&built.join("timetable.bin"), TIMETABLE_SCHEMA)),
            || {
                rayon::join(
                    || {
                        let graph_path = ["walkgraph.bin", "walkgraph-bern.bin"].iter().map(|f| built.join(f)).find(|p| p.exists());
                        let links_path = built.join("links.bin");
                        let graph = graph_path.and_then(|p| match timed("walk graph", || io::load::<WalkGraph>(&p, WALKGRAPH_SCHEMA)) {
                            Ok(g) => Some(g),
                            Err(e) => {
                                eprintln!("  walk graph unavailable: {e:#}");
                                None
                            }
                        });
                        let links = if links_path.exists() {
                            match timed("links", || io::load::<LinkData>(&links_path, LINKS_SCHEMA)) {
                                Ok(l) => Some(l),
                                Err(e) => {
                                    eprintln!("  links unavailable: {e:#}");
                                    None
                                }
                            }
                        } else {
                            None
                        };
                        (graph, links)
                    },
                    || {
                        let p = built.join("search.bin");
                        if !p.exists() {
                            return None;
                        }
                        match timed("search index", || io::load::<SearchIndex>(&p, kante_search::SEARCH_SCHEMA)) {
                            Ok(s) => Some(s),
                            Err(e) => {
                                eprintln!("  search index unavailable: {e:#}");
                                None
                            }
                        }
                    },
                )
            },
        );
        let tt = Arc::new(tt?);
        let (graph, links) = walk_parts;

        let mut walk_bbox = BBox::empty();
        let slopes_path = built.join("slopes.bin");
        let attrs_path = built.join("walkattr.bin");
        let walk = graph.map(|mut g| {
            for n in g.nodes.iter().step_by(64) {
                walk_bbox.extend(n);
            }
            match timed("slopes", || Ok(load_slopes(&slopes_path, &g))) {
                Ok(Some(s)) => g.slopes = s,
                _ if slopes_path.exists() => eprintln!("  slopes.bin belongs to another walk graph build: walks timed as if flat (run `kante build`)"),
                _ => eprintln!("  no slopes.bin: walks timed as if flat (scripts/fetch-data.sh --elevation, then `kante build`)"),
            }
            match timed("walk attributes", || Ok(load_attrs(&attrs_path, &g))) {
                Ok(Some(a)) => g.attrs = a,
                _ => eprintln!("  no walkattr.bin for this walk graph: sidewalks drawn apart, road sizes and opening hours unknown (run `kante build`)"),
            }
            let t = Instant::now();
            let r = WalkRouter::new(Arc::new(g));
            let st = r.index_stats();
            eprintln!("  walk index: {:.2}s ({} junctions with turns or crossings, {} search states, {} MB)", t.elapsed().as_secs_f32(), st.junctions, st.search_states, st.net_bytes / 1_000_000);
            r
        });
        if walk.is_none() {
            walk_bbox = BBox::from_deg(0.0, 0.0, 0.0, 0.0);
        }
        // Doors and stop links refer to edges of the graph they were built with (and links to the timetable's
        // stops by index): only with that graph and timetable.
        let graph_fp = walk.as_ref().map(|w| graph_fingerprint(w.graph()));
        let doors_path = built.join("doors.bin");
        let doors = match (&walk, doors_path.exists()) {
            (Some(_), true) => match timed("doors", || io::load::<Doors>(&doors_path, DOORS_SCHEMA)) {
                Ok(d) if Some(d.graph) == graph_fp => {
                    let t = Instant::now();
                    let ix = kante_link::doors::DoorIndex::new(d);
                    let m = ix.breakdown_mb();
                    eprintln!(
                        "  door index: {} buildings, {} doors, {} MB (outlines {:.0}, doors {:.0}, ways out {:.0}, addresses {:.0}, grid {:.0}), {:.2}s",
                        ix.doors.buildings.len(),
                        ix.doors.doors.len(),
                        ix.heap_bytes() >> 20,
                        m[0],
                        m[1],
                        m[2],
                        m[3],
                        m[4],
                        t.elapsed().as_secs_f32()
                    );
                    Some(ix)
                }
                Ok(_) => {
                    eprintln!("  doors.bin belongs to another walk graph build: ignoring it (run `kante build --only doors`)");
                    None
                }
                Err(e) => {
                    eprintln!("  doors unavailable: {e:#}");
                    None
                }
            },
            _ => None,
        };

        let tt_fp = tt.stops_fingerprint();
        let links = links.filter(|l| {
            let ok = l.links.len() == tt.stops.len() && l.timetable == tt_fp && Some(l.graph) == graph_fp;
            if !ok {
                eprintln!("  links.bin belongs to another timetable or walk graph build: ignoring it (run `kante build`)");
            }
            ok
        });
        if let (Some(l), Some(w)) = (&links, &walk) {
            if l.slopes != slopes_fingerprint(&w.graph().slopes) {
                eprintln!("  links.bin was timed with other slopes: changes keep those times until `kante build` runs");
            }
        }
        let (stop_links, fp_normal, fp_step_free) = match links {
            Some(l) if walk.is_some() => (Some(l.links), l.normal, l.step_free),
            _ => {
                eprintln!("  no stop links: using straight-line footpaths (run `kante build`)");
                let t = Instant::now();
                let fp = kante_raptor::crowfly_footpaths(&tt, 400.0, 1.35);
                eprintln!("  crow-fly footpaths: {} in {:.2}s", fp.len(), t.elapsed().as_secs_f32());
                (None, fp.clone(), fp)
            }
        };
        // A change takes the walk between the two boarding points, as the footpaths time it (and the seconds the
        // traveller asks for on top). The timetable's own minimum change times are not used: they are one number
        // for a whole station and every walker, sometimes more than this walk and sometimes less.
        let fp_few = merge_few(&fp_normal, &fp_step_free);

        // the ways vehicles take; only those made for this timetable
        let shapes_path = built.join("shapes.bin");
        let shapes = if shapes_path.exists() {
            match timed("shapes", || io::load::<kante_shapes::Shapes>(&shapes_path, kante_shapes::SHAPES_SCHEMA)) {
                Ok(mut sh) if sh.timetable == kante_shapes::fingerprint(&tt) && sh.pattern_shape.len() == tt.patterns.len() => {
                    sh.measure();
                    Some(sh)
                }
                Ok(_) => {
                    eprintln!("  shapes.bin belongs to another timetable: vehicles move in straight lines (run `kante build`)");
                    None
                }
                Err(e) => {
                    eprintln!("  shapes unavailable: {e:#}");
                    None
                }
            }
        } else {
            eprintln!("  no shapes.bin: vehicles move in straight lines between stops (run `kante build`)");
            None
        };

        let t = Instant::now();
        let router = Router::new(tt.clone());
        if let Some(sh) = &shapes {
            let (boxes, of) = sh.hop_boxes(&tt);
            router.set_shape_boxes(sh.pattern_boxes(), kante_raptor::HopBoxes { boxes, of });
        }
        let today = kante_core::time::from_unix(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)).0;
        router.warm_up(today);
        // The footpath sets are final here: derive the router's data from them now.
        for fp in [&fp_normal, &fp_step_free, &fp_few] {
            router.prepare_footpaths(fp);
        }
        eprintln!("  router: {:.2}s", t.elapsed().as_secs_f32());

        let stop_grid = PointGrid::new(tt.stops.iter().enumerate().map(|(i, s)| (i as u32, s.pos)), 250.0);
        let station_grid = PointGrid::new(tt.stations.iter().enumerate().map(|(i, s)| (i as u32, s.pos)), 500.0);
        let station_ids = tt.stations.iter().enumerate().map(|(i, s)| (s.gtfs_id.clone(), i as u32)).collect();
        let stop_ids = tt.stops.iter().enumerate().map(|(i, s)| (s.gtfs_id.clone(), i as u32)).collect();
        let mut sloid_stops: FxHashMap<String, Vec<StopIdx>> = FxHashMap::default();
        for (i, s) in tt.stops.iter().enumerate() {
            if !s.sloid.is_empty() {
                sloid_stops.entry(s.sloid.clone()).or_default().push(i as StopIdx);
            }
        }
        let station_norm = tt.stations.iter().map(|s| text::normalize(&s.name)).collect();

        eprintln!(
            "ready in {:.2}s: {} stations, {} boarding points, {} trips, {} footpaths, walking {}, search {}",
            t0.elapsed().as_secs_f32(),
            tt.stations.len(),
            tt.stops.len(),
            tt.trips.len(),
            fp_normal.len(),
            if walk.is_some() { "on" } else { "off" },
            if search.is_some() { "full" } else { "stations only" },
        );

        Ok(App {
            tt,
            router,
            walk,
            links: stop_links,
            fp_normal,
            fp_step_free,
            fp_few,
            search,
            stop_grid,
            station_grid,
            station_ids,
            stop_ids,
            sloid_stops,
            station_norm,
            live: RwLock::new(LiveState { view: None, meta: Default::default() }),
            feeds: Default::default(),
            live_tx: tokio::sync::watch::channel(0).0,
            shutdown: tokio::sync::watch::channel(false).0,
            heavy: Arc::new(tokio::sync::Semaphore::new(4)),
            streams: Default::default(),
            profiles: Default::default(),
            walk_bbox,
            data_dir: data_dir.to_path_buf(),
            doors,
            shapes,
        })
    }

    /// The quays a `quay=` parameter names: an engine quay id, or an ATLAS SLOID (all the
    /// engine's quays on that boarding point). Empty when unknown.
    pub fn quays_of(&self, id: &str) -> Vec<StopIdx> {
        if let Some(v) = self.sloid_stops.get(id) {
            return v.clone();
        }
        self.stop_ids.get(id).map(|&s| vec![s]).unwrap_or_default()
    }

    pub fn live_view(&self) -> Option<Arc<dyn LiveView>> {
        self.live.read().view.clone()
    }

    /// Tell `/api/stream` listeners that the live data changed.
    pub fn bump_live(&self) {
        self.live_tx.send_modify(|v| *v += 1);
    }

    pub fn footpaths_for(&self, p: &WalkProfile) -> &Footpaths {
        match p.stairs {
            StairsPref::Never => &self.fp_step_free,
            StairsPref::Avoid => &self.fp_few,
            StairsPref::Ok if !p.escalators || p.wheelchair => &self.fp_few,
            StairsPref::Ok => &self.fp_normal,
        }
    }

    pub fn link(&self, s: StopIdx) -> Option<&StopLink> {
        self.links.as_ref().map(|l| &l[s as usize]).filter(|l| l.matched != LinkMatch::None)
    }

    pub fn station_place(&self, st: StationIdx) -> json::Place {
        let s = &self.tt.stations[st as usize];
        json::Place {
            id: format!("st:{}", s.gtfs_id),
            kind: "station",
            name: s.name.clone(),
            detail: None,
            lat: s.pos.lat_deg(),
            lon: s.pos.lon_deg(),
            modes: Some(modes_list(s.modes)),
            dist_m: None,
            icon: Some("station".into()),
            ..Default::default()
        }
    }

    pub fn line_badge(&self, trip: TripIdx) -> json::LineBadge {
        let line = self.tt.trip_line(trip);
        // Cableways, funiculars and lifts carry an internal course number as
        // their "line name" ("2350"); nobody knows them by it.
        let internal = matches!(line.mode, Mode::Funicular | Mode::Cableway | Mode::Lift) && line.name.len() >= 3 && line.name.chars().all(|c| c.is_ascii_digit());
        json::LineBadge {
            name: if internal { String::new() } else { line.name.clone() },
            category: line.category.clone(),
            mode: line.mode.as_str(),
            operator: self.tt.agencies.get(line.agency as usize).map(|a| a.name.clone()).unwrap_or_default(),
        }
    }

    pub fn quay(&self, s: StopIdx) -> json::Quay {
        let stop = &self.tt.stops[s as usize];
        let station = &self.tt.stations[stop.station as usize];
        let railish = Mode::Rail.bit() | Mode::Metro.bit() | Mode::RackRail.bit() | Mode::Funicular.bit();
        let noun = if stop.precision == Precision::Station {
            "stop"
        } else if stop.modes & railish != 0 {
            if stop.label.is_empty() {
                "edge"
            } else {
                "track"
            }
        } else if stop.modes & Mode::Boat.bit() != 0 {
            "pier"
        } else if !stop.label.is_empty() {
            "bay"
        } else {
            "edge"
        };
        let link = self.link(s);
        let side = link.and_then(|l| {
            let sd = &l.side;
            if sd.side > 7 || sd.ref_kind > 2 || (noun == "track" && !stop.label.is_empty()) {
                return None;
            }
            let (of, generic) = match sd.ref_kind {
                0 => ("road", "the road"),
                1 => ("tram-track", "the tram tracks"),
                _ => ("rail-track", "the tracks"),
            };
            let word = SIDE_WORDS[sd.side as usize];
            let text = if !sd.street.is_empty() {
                format!("{word} side of {}", sd.street)
            } else if !sd.place.is_empty() {
                // On an island or in a square: the side is of the lane or
                // track right beside the stop, not of the whole street.
                format!("on {}, {word} side of {generic}", sd.place)
            } else {
                format!("{word} side of {generic}")
            };
            Some(json::QuaySide { street: if sd.street.is_empty() { sd.place.clone() } else { sd.street.clone() }, side: SIDE_CODES[sd.side as usize], of, text })
        });
        json::Quay {
            id: stop.gtfs_id.clone(),
            sloid: stop.sloid.clone(),
            station_id: format!("st:{}", station.gtfs_id),
            station_name: station.name.clone(),
            label: stop.label.clone(),
            sectors: (!stop.sectors.is_empty()).then(|| stop.sectors.clone()),
            noun,
            lat: stop.pos.lat_deg(),
            lon: stop.pos.lon_deg(),
            precision: match stop.precision {
                Precision::Edge => "edge",
                Precision::EdgeAtStation => "edge-at-station",
                Precision::Station => "station",
            },
            level: link.and_then(|l| level_f(l.level)),
            side,
            access: match stop.access {
                QuayAccess::Unknown => None,
                QuayAccess::Autonomous => Some("autonomous"),
                QuayAccess::Assisted => Some("assisted"),
                QuayAccess::AssistedOnNotice => Some("assisted-on-notice"),
                QuayAccess::NotAccessible => Some("not-accessible"),
            },
            modes: modes_list(stop.modes),
        }
    }

    /// Turn an API place reference into a routable endpoint.
    pub fn resolve(&self, r: &json::PlaceRef) -> Result<Endpoint, String> {
        if let Some(id) = r.id.as_deref() {
            if let Some(st) = id.strip_prefix("st:") {
                let idx = *self.station_ids.get(st).ok_or_else(|| format!("unknown station {id}"))?;
                return Ok(Endpoint { place: self.station_place(idx), pos: self.tt.stations[idx as usize].pos, station: Some(idx) });
            }
            if id.starts_with("addr:") || id.starts_with("poi:") {
                if let Some(hit) = self.search.as_ref().and_then(|s| s.resolve(id)) {
                    // Trust the client's coordinate if it sent one (ids are only
                    // stable within one index build), else the index.
                    let pos = match (r.lat, r.lon) {
                        (Some(lat), Some(lon)) => LatLon::from_deg(lat, lon),
                        _ => hit.pos,
                    };
                    return Ok(Endpoint { place: self.hit_place(&hit, None), pos, station: None });
                }
            }
        }
        let (lat, lon) = match (r.lat, r.lon) {
            (Some(a), Some(b)) => (a, b),
            _ => return Err("place needs an id or lat/lon".into()),
        };
        if !(40.0..=52.0).contains(&lat) || !(0.0..=20.0).contains(&lon) {
            return Err("coordinate outside the supported area".into());
        }
        let pos = LatLon::from_deg(lat, lon);
        let rev = self.search.as_ref().and_then(|s| s.reverse(pos));
        let name = r.name.clone().filter(|n| !n.is_empty()).or_else(|| rev.as_ref().map(|h| h.name.clone())).unwrap_or_else(|| "Pinned location".into());
        Ok(Endpoint {
            place: json::Place {
                id: format!("coord:{lat:.6},{lon:.6}"),
                kind: "coord",
                name,
                detail: rev.map(|h| h.detail).filter(|d| !d.is_empty()),
                lat,
                lon,
                modes: None,
                dist_m: None,
                ..Default::default()
            },
            pos,
            station: None,
        })
    }

    pub fn hit_place(&self, hit: &kante_search::Hit, near: Option<LatLon>) -> json::Place {
        let dist = near.map(|n| n.dist_m(&hit.pos) as u32);
        if let Some(st) = hit.station {
            let mut p = self.station_place(st);
            p.dist_m = dist;
            return p;
        }
        json::Place {
            id: hit.id.clone(),
            kind: match hit.kind {
                kante_search::HitKind::Station => "station",
                kante_search::HitKind::Address => "address",
                kante_search::HitKind::Poi => "poi",
            },
            name: hit.name.clone(),
            detail: (!hit.detail.is_empty()).then(|| hit.detail.clone()),
            lat: hit.pos.lat_deg(),
            lon: hit.pos.lon_deg(),
            modes: None,
            dist_m: dist,
            icon: Some(hit.icon.clone()),
            category: (!hit.category.is_empty()).then(|| hit.category.clone()),
            info: hit.info.as_deref().cloned(),
        }
    }

    /// Snap a point taken as it is (a station's centre when nothing better is found, where a station model's own
    /// paths begin) onto the walking network, as `main` has always done ([`ends::snap_main`]). A place has several
    /// candidates instead ([`App::place_end`]).
    pub fn snap_free(&self, pos: LatLon, profile: &WalkProfile) -> Option<Snap> {
        ends::snap_main(self.walk.as_ref()?, pos, profile)
    }

    /// A place's ways onto the network: the point itself, and the doors of the building it is in.
    pub fn place_end(&self, pos: LatLon, profile: &WalkProfile, name: Option<&str>) -> End {
        match self.walk.as_ref() {
            Some(walk) => End::place_at(walk, self.doors.as_ref(), pos, profile, name),
            None => End::exact(pos, None),
        }
    }

    /// Which stops can be walked to from `ep` within `max_s` (`to_here`: from which stops `ep` can be walked to, an
    /// egress), and how long it takes. The search always runs from `ep`; for an egress against the direction of
    /// travel ([`WalkProfile::backwards`]), so its times are those of walking from the stop (up a hill, not down).
    pub fn reach(&self, ep: &Endpoint, profile: &WalkProfile, max_s: Secs, to_here: bool) -> Reach {
        let search = WalkProfile { backwards: to_here, ..*profile };
        let profile = &search;
        let speed = profile.speed_mps;
        let mut best: FxHashMap<StopIdx, Secs> = FxHashMap::default();
        if let Some(st) = ep.station {
            for &s in &self.tt.stations[st as usize].stops {
                best.insert(s, 0);
            }
        }
        let radius = max_s as f32 * speed;
        let mut near: Vec<StopIdx> = Vec::new();
        self.stop_grid.around(ep.pos, radius, |s| {
            if !best.contains_key(&s) && self.tt.stops[s as usize].pos.dist_m(&ep.pos) <= radius {
                near.push(s);
            }
        });

        // A station is entered at street level: do not let its centre point
        // fall into an underpass or onto a deck that happens to be nearest.
        // from each of the point's lines onto the network and from the doors of the building it is in (a station is
        // entered at street level, as above)
        let end = match (ep.station, self.walk.as_ref()) {
            (Some(_), Some(walk)) => End::station(walk, self.doors.as_ref(), ep.pos, profile),
            (None, Some(walk)) => End::place_at(walk, self.doors.as_ref(), ep.pos, profile, Some(ep.place.name.as_str())),
            _ => End::exact(ep.pos, None),
        };
        let mut via: FxHashMap<StopIdx, &'static str> = best.keys().map(|&s| (s, "station")).collect();
        let mut routed: Vec<bool> = vec![false; near.len()];
        if let (Some(walk), false) = (self.walk.as_ref(), end.joins.is_empty()) {
            let mut idx = Vec::with_capacity(near.len());
            let mut targets = Vec::with_capacity(near.len());
            for (i, &s) in near.iter().enumerate() {
                if let Some(l) = self.link(s) {
                    idx.push(i);
                    targets.push(l.snap);
                }
            }
            // the metres from the point to the network and from it to the stop are in `c`; a stop is reached when a
            // candidate's walk to it leaves room for the buffer
            let limit = (max_s - ACCESS_BUFFER_S).max(0) as f32;
            // a line through a building, onto another floor or across unmapped ground only for the stops no other
            // reaches in time (ends::reach_costs); a step-free walker's journey that takes one says so (plan.rs)
            let costs = ends::reach_costs(walk, &end, &targets, profile, max_s as f32, limit);
            for (k, c) in costs.into_iter().enumerate() {
                let i = idx[k];
                if let Some((c, j)) = c {
                    let secs = walk_secs(c.var_m, c.fix_s, speed).ceil() as Secs + ACCESS_BUFFER_S;
                    routed[i] = true;
                    if secs <= max_s {
                        best.insert(near[i], secs);
                        via.insert(near[i], if end.joins[j].door.is_some() { "door" } else { "point" });
                    }
                }
            }
        }
        // Stops the network search could not reach (not linked, or no walking
        // data here): fall back to the straight line with a detour factor,
        // but only nearby, so a river or motorway is not walked through.
        let have_network = !end.joins.is_empty();
        for (i, &s) in near.iter().enumerate() {
            if routed[i] {
                continue;
            }
            let d = self.tt.stops[s as usize].pos.dist_m(&ep.pos);
            if have_network && (self.link(s).is_some() || d > 250.0) {
                continue;
            }
            let secs = (d * 1.35 / speed).ceil() as Secs + ACCESS_BUFFER_S;
            if secs <= max_s {
                best.insert(s, secs);
                via.insert(s, "line");
            }
        }
        let mut stops: Vec<(StopIdx, Secs)> = best.into_iter().collect();
        stops.sort_unstable();
        Reach { stops, end, via }
    }
}
