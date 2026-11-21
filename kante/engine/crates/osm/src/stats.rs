//! Statistics and self-checks on an imported graph: counts by kind and level,
//! connected components, and a deliberately simple Dijkstra over edge lengths
//! used to validate the import against known walks. This is test tooling, not
//! the product router (that is `kante-walk`).

use kante_core::geo::{project_on_segment, BBox, LatLon};
use kante_core::walk::*;
use std::collections::{BTreeMap, BinaryHeap};
use std::fmt::Write;

pub const KIND_NAMES: [&str; 12] =
    ["Footway", "Sidewalk", "Crossing", "Path", "Pedestrian", "Steps", "Escalator", "Lift", "Corridor", "Platform", "Road", "RoadBusy"];

pub fn level_str(l: Level2) -> String {
    if l == LEVEL_NONE {
        "-".to_string()
    } else if l % 2 == 0 {
        format!("{}", l / 2)
    } else {
        format!("{:.1}", l as f32 / 2.0)
    }
}

pub fn edge_in_box(g: &WalkGraph, e: u32, b: &BBox) -> bool {
    g.edge_geom(e).iter().any(|p| b.contains(p))
}

pub struct Components {
    /// Component id per node.
    pub comp: Vec<u32>,
    /// Edges and metres per component.
    pub edges: Vec<u32>,
    pub len_m: Vec<f64>,
}

/// Connected components of the graph ignoring one-way restrictions.
pub fn components(g: &WalkGraph) -> Components {
    let n = g.nodes.len();
    let mut parent: Vec<u32> = (0..n as u32).collect();
    fn find(p: &mut [u32], mut x: u32) -> u32 {
        while p[x as usize] != x {
            p[x as usize] = p[p[x as usize] as usize];
            x = p[x as usize];
        }
        x
    }
    for e in &g.edges {
        let (a, b) = (find(&mut parent, e.a), find(&mut parent, e.b));
        if a != b {
            parent[a.max(b) as usize] = a.min(b);
        }
    }
    let mut id = vec![u32::MAX; n];
    let mut comp = vec![0u32; n];
    let mut k = 0u32;
    for i in 0..n as u32 {
        let r = find(&mut parent, i);
        if id[r as usize] == u32::MAX {
            id[r as usize] = k;
            k += 1;
        }
        comp[i as usize] = id[r as usize];
    }
    let mut edges = vec![0u32; k as usize];
    let mut len_m = vec![0f64; k as usize];
    for e in &g.edges {
        let c = comp[e.a as usize] as usize;
        edges[c] += 1;
        len_m[c] += e.len_dm as f64 * 0.1;
    }
    Components { comp, edges, len_m }
}

/// Text report: edges by kind, vertical connectors, levels, platforms and
/// connectivity, for the whole graph or the part inside `bbox`.
pub fn report(g: &WalkGraph, x: &OsmExtract, bbox: Option<&BBox>, list_platforms: bool) -> String {
    let mut s = String::new();
    let inb = |e: u32| bbox.map(|b| edge_in_box(g, e, b)).unwrap_or(true);
    let sel: Vec<u32> = (0..g.edges.len() as u32).filter(|&e| inb(e)).collect();
    let mut n_kind = [0u64; 12];
    let mut m_kind = [0f64; 12];
    let mut lv_hist: BTreeMap<(i16, i16), (u64, f64)> = BTreeMap::new();
    let (mut area_e, mut esc_ab, mut esc_ba, mut esc_both, mut esc_up_known) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let (mut steps_e, mut steps_total, mut steps_up_known, mut steps_ramp) = (0u64, 0u64, 0u64, 0u64);
    let (mut with_level, mut indoor, mut wc_no, mut wc_yes, mut rough) = (0u64, 0u64, 0u64, 0u64, 0u64);
    for &ei in &sel {
        let e = &g.edges[ei as usize];
        let k = e.kind as usize;
        n_kind[k] += 1;
        m_kind[k] += e.len_m() as f64;
        if e.flags & EF_AREA != 0 {
            area_e += 1;
        }
        if e.flags & EF_INDOOR != 0 {
            indoor += 1;
        }
        if e.flags & EF_WHEELCHAIR_NO != 0 {
            wc_no += 1;
        }
        if e.flags & EF_WHEELCHAIR_YES != 0 {
            wc_yes += 1;
        }
        if e.flags & EF_ROUGH != 0 {
            rough += 1;
        }
        if e.level_a != LEVEL_NONE || e.level_b != LEVEL_NONE {
            with_level += 1;
        }
        let key = (e.level_a.min(e.level_b) as i16, e.level_a.max(e.level_b) as i16);
        let h = lv_hist.entry(key).or_insert((0, 0.0));
        h.0 += 1;
        h.1 += e.len_m() as f64;
        match e.kind {
            EdgeKind::Escalator => {
                match (e.flags & EF_ONEWAY_AB != 0, e.flags & EF_ONEWAY_BA != 0) {
                    (true, false) => esc_ab += 1,
                    (false, true) => esc_ba += 1,
                    _ => esc_both += 1,
                }
                if e.flags & (EF_UP_AB | EF_UP_BA) != 0 {
                    esc_up_known += 1;
                }
            }
            EdgeKind::Steps => {
                steps_e += 1;
                steps_total += e.steps as u64;
                if e.flags & (EF_UP_AB | EF_UP_BA) != 0 {
                    steps_up_known += 1;
                }
                if e.flags & EF_RAMP != 0 {
                    steps_ramp += 1;
                }
            }
            _ => {}
        }
    }
    let conn: Vec<f32> = sel
        .iter()
        .filter(|&&e| g.edge_way[e as usize] == 0 && g.edges[e as usize].kind == EdgeKind::Footway)
        .map(|&e| g.edges[e as usize].len_m())
        .collect();
    let total_m: f64 = m_kind.iter().sum();
    let _ = writeln!(s, "edges {}  length {:.1} km", sel.len(), total_m / 1000.0);
    for k in 0..12 {
        if n_kind[k] > 0 {
            let _ = writeln!(s, "  {:<10} {:>9} edges {:>10.2} km", KIND_NAMES[k], n_kind[k], m_kind[k] / 1000.0);
        }
    }
    let _ = writeln!(
        s,
        "connector edges {}: mean {:.1} m, {} longer than 10 m, {} longer than 20 m",
        conn.len(),
        conn.iter().sum::<f32>() / conn.len().max(1) as f32,
        conn.iter().filter(|l| **l > 10.0).count(),
        conn.iter().filter(|l| **l > 20.0).count()
    );
    let _ = writeln!(s, "synthetic area edges {area_e}; indoor {indoor}; wheelchair=no {wc_no} yes {wc_yes}; rough {rough}");
    let _ = writeln!(
        s,
        "escalator edges: one-way a→b {esc_ab}, one-way b→a {esc_ba}, both ways {esc_both}; up direction known on {esc_up_known}"
    );
    let _ = writeln!(s, "steps edges {steps_e}: {steps_total} steps, up direction known on {steps_up_known}, with ramp {steps_ramp}");
    // lift nodes
    let node_in = |n: u32| bbox.map(|b| b.contains(&g.nodes[n as usize])).unwrap_or(true);
    let mut nf = [0u64; 8];
    let mut n_nodes = 0u64;
    let mut odd_junctions = 0u64;
    for n in 0..g.nodes.len() as u32 {
        if !node_in(n) {
            continue;
        }
        n_nodes += 1;
        for b in 0..8 {
            if g.node_flags[n as usize] & (1 << b) != 0 {
                nf[b] += 1;
            }
        }
        if g.node_flags[n as usize] & NF_ELEVATOR == 0 {
            // levels of flat edges meeting here without a lift
            let mut lv: Vec<Level2> = Vec::new();
            for &ei in g.incident(n) {
                let e = &g.edges[ei as usize];
                if e.level_a != e.level_b || matches!(e.kind, EdgeKind::Steps | EdgeKind::Escalator | EdgeKind::Lift) {
                    continue;
                }
                if e.level_a != LEVEL_NONE && !lv.contains(&e.level_a) {
                    lv.push(e.level_a);
                }
            }
            if lv.len() >= 2 {
                odd_junctions += 1;
            }
        }
    }
    let _ = writeln!(
        s,
        "nodes {n_nodes}: lift ports {} entrance {} door {} no-wheelchair {} crossing {} crossing-with-signals {}",
        nf[0], nf[1], nf[5], nf[2], nf[4], nf[3]
    );
    let _ = writeln!(s, "nodes where flat ways of different levels meet without a lift: {odd_junctions}");
    let _ = writeln!(s, "edges with a level: {with_level}");
    for ((lo, hi), (n, m)) in &lv_hist {
        let name = if *lo == LEVEL_NONE as i16 && *hi == LEVEL_NONE as i16 {
            "none".to_string()
        } else if lo == hi {
            level_str(*lo as Level2)
        } else if *lo == LEVEL_NONE as i16 {
            format!("?..{}", level_str(*hi as Level2))
        } else {
            format!("{}..{}", level_str(*lo as Level2), level_str(*hi as Level2))
        };
        let _ = writeln!(s, "  level {:<9} {:>8} edges {:>9.2} km", name, n, m / 1000.0);
    }
    // platforms
    let ps: Vec<&OsmPlatform> = x.platforms.iter().filter(|p| bbox.map(|b| b.contains(&p.pos)).unwrap_or(true)).collect();
    let cnt = |k: PlatformKind| ps.iter().filter(|p| p.kind == k).count();
    let _ = writeln!(
        s,
        "platform objects {}: ways/areas {} (with walk edges {}), nodes {}, stop positions {}; with refs {}, sloid {}, uic_ref {}, level {}, mode hint {}",
        ps.len(),
        cnt(PlatformKind::PlatformWay),
        ps.iter().filter(|p| !p.edges.is_empty()).count(),
        cnt(PlatformKind::PlatformNode),
        cnt(PlatformKind::StopPosition),
        ps.iter().filter(|p| !p.refs.is_empty()).count(),
        ps.iter().filter(|p| !p.sloid.is_empty()).count(),
        ps.iter().filter(|p| p.uic_ref != 0).count(),
        ps.iter().filter(|p| p.level != LEVEL_NONE).count(),
        ps.iter().filter(|p| p.modes != 0).count(),
    );
    if list_platforms {
        let mut rows: Vec<String> = ps
            .iter()
            .filter(|p| p.kind != PlatformKind::StopPosition)
            .map(|p| {
                format!(
                    "  {:<22} refs {:<10} level {:<3} {} {:<11} modes {:06b} uic {:<8} edges {:<3} {:.6},{:.6} {}",
                    p.name,
                    p.refs.join(";"),
                    level_str(p.level),
                    ["node", "way ", "rel "][p.osm_type as usize],
                    p.osm_id,
                    p.modes,
                    p.uic_ref,
                    p.edges.len(),
                    p.pos.lat_deg(),
                    p.pos.lon_deg(),
                    p.sloid
                )
            })
            .collect();
        rows.sort();
        for r in rows {
            let _ = writeln!(s, "{r}");
        }
    }
    s
}

/// Connectivity summary; with `bbox`, restricted to edges inside it (the
/// components themselves are computed on the whole graph).
pub fn connectivity(g: &WalkGraph, c: &Components, bbox: Option<&BBox>, list: usize) -> String {
    let mut s = String::new();
    let main = (0..c.edges.len()).max_by_key(|&i| c.edges[i]).unwrap_or(0) as u32;
    let mut per: BTreeMap<u32, (u32, f64, u32)> = BTreeMap::new();
    let mut total = 0u64;
    let mut total_m = 0f64;
    for (ei, e) in g.edges.iter().enumerate() {
        if let Some(b) = bbox {
            if !edge_in_box(g, ei as u32, b) {
                continue;
            }
        }
        total += 1;
        total_m += e.len_m() as f64;
        let p = per.entry(c.comp[e.a as usize]).or_insert((0, 0.0, ei as u32));
        p.0 += 1;
        p.1 += e.len_m() as f64;
    }
    let (me, mm, _) = per.get(&main).copied().unwrap_or((0, 0.0, 0));
    let _ = writeln!(
        s,
        "components touching the selection: {}; largest holds {:.3}% of edges ({} of {}) and {:.3}% of length",
        per.len(),
        100.0 * me as f64 / total.max(1) as f64,
        me,
        total,
        100.0 * mm / total_m.max(1e-9)
    );
    let mut others: Vec<(u32, (u32, f64, u32))> = per.into_iter().filter(|(k, _)| *k != main).collect();
    others.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
    for (_, (n, m, ei)) in others.iter().take(list) {
        let e = &g.edges[*ei as usize];
        let p = g.nodes[e.a as usize];
        let mut kinds: BTreeMap<&str, u32> = BTreeMap::new();
        // describe the fragment by its first edge
        *kinds.entry(KIND_NAMES[e.kind as usize]).or_default() += 1;
        let _ = writeln!(
            s,
            "  fragment: {:>4} edges {:>7.1} m  e.g. way {} {} level {} at {:.6},{:.6} name {:?}",
            n,
            m,
            g.edge_way[*ei as usize],
            KIND_NAMES[e.kind as usize],
            level_str(e.level_a),
            p.lat_deg(),
            p.lon_deg(),
            g.edge_name(*ei)
        );
    }
    s
}

// ---------------------------------------------------------------- test router

fn level_or_ground(l: Level2) -> Level2 {
    if l == LEVEL_NONE {
        0
    } else {
        l
    }
}

fn usable(e: &WalkEdge, step_free: bool) -> bool {
    if !step_free {
        return true;
    }
    match e.kind {
        EdgeKind::Steps => e.flags & EF_RAMP != 0,
        EdgeKind::Escalator => false,
        _ => e.flags & EF_WHEELCHAIR_NO == 0,
    }
}

/// Nearest edge to `p` (brute force): (edge, fraction from a, distance m).
/// `level`: only edges touching this level (edges without a level count as 0).
/// `only_comp`: only edges of this component.
pub fn snap(g: &WalkGraph, p: LatLon, level: Option<Level2>, step_free: bool, only: Option<(&Components, u32)>) -> Option<(u32, f32, f32)> {
    let mut best: Option<(u32, f32, f32)> = None;
    let reach = BBox::around(p, 150.0);
    for (ei, e) in g.edges.iter().enumerate() {
        if e.kind == EdgeKind::Lift || !usable(e, step_free) {
            continue;
        }
        if let Some(l) = level {
            if level_or_ground(e.level_a) != l && level_or_ground(e.level_b) != l {
                continue;
            }
        }
        let geom = g.edge_geom(ei as u32);
        let mut bb = BBox::empty();
        for q in geom {
            bb.extend(q);
        }
        if !bb.intersects(&reach) {
            continue;
        }
        if let Some((c, id)) = only {
            if c.comp[e.a as usize] != id {
                continue;
            }
        }
        let mut done = 0f32;
        for w in geom.windows(2) {
            let seg = w[0].dist_m(&w[1]);
            let (t, d) = project_on_segment(&p, &w[0], &w[1]);
            if best.map(|b| d < b.2).unwrap_or(true) {
                let len = e.len_m().max(0.01);
                best = Some((ei as u32, ((done + t * seg) / len).clamp(0.0, 1.0), d));
            }
            done += seg;
        }
    }
    best
}

#[derive(Clone, Debug)]
pub struct TestLeg {
    pub way: i64,
    pub kind: EdgeKind,
    pub level_a: Level2,
    pub level_b: Level2,
    pub len_m: f32,
    pub name: String,
    pub flags: u16,
}

#[derive(Clone, Debug)]
pub struct TestRoute {
    pub dist_m: f32,
    pub snap_from_m: f32,
    pub snap_to_m: f32,
    pub lifts: u32,
    pub steps: u32,
    pub escalators: u32,
    pub legs: Vec<TestLeg>,
}

#[derive(PartialEq)]
struct QItem(f32, u32);
impl Eq for QItem {}
impl PartialOrd for QItem {
    fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for QItem {
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        o.0.partial_cmp(&self.0).unwrap().then(o.1.cmp(&self.1))
    }
}

/// Shortest walk by plain edge length between two snapped points. Honours
/// one-way escalators; `step_free` forbids stairs without ramp, escalators,
/// `wheelchair=no` ways and nodes a wheelchair cannot pass.
pub fn route(g: &WalkGraph, from: (u32, f32, f32), to: (u32, f32, f32), step_free: bool) -> Option<TestRoute> {
    let n = g.nodes.len();
    let mut dist = vec![f32::INFINITY; n];
    let mut prev = vec![u32::MAX; n];
    let mut heap = BinaryHeap::new();
    let fe = &g.edges[from.0 as usize];
    let te = &g.edges[to.0 as usize];
    let can = |e: &WalkEdge, from_a: bool| -> bool {
        usable(e, step_free) && !(from_a && e.flags & EF_ONEWAY_BA != 0) && !(!from_a && e.flags & EF_ONEWAY_AB != 0)
    };
    // leave the start edge towards a or b
    if can(fe, false) {
        dist[fe.a as usize] = fe.len_m() * from.1;
        heap.push(QItem(dist[fe.a as usize], fe.a));
    }
    if can(fe, true) {
        let d = fe.len_m() * (1.0 - from.1);
        if d < dist[fe.b as usize] {
            dist[fe.b as usize] = d;
            heap.push(QItem(d, fe.b));
        }
    }
    let mut best = f32::INFINITY;
    let mut best_end = u32::MAX; // node through which the target edge is entered
    if from.0 == to.0 {
        let forward = to.1 >= from.1;
        if can(fe, forward) {
            best = fe.len_m() * (to.1 - from.1).abs();
        }
    }
    while let Some(QItem(d, u)) = heap.pop() {
        if d > dist[u as usize] {
            continue;
        }
        if d >= best {
            break;
        }
        if step_free && g.node_flags[u as usize] & NF_NO_WHEELCHAIR != 0 {
            continue;
        }
        if u == te.a && can(te, true) && d + te.len_m() * to.1 < best {
            best = d + te.len_m() * to.1;
            best_end = u;
        }
        if u == te.b && can(te, false) && d + te.len_m() * (1.0 - to.1) < best {
            best = d + te.len_m() * (1.0 - to.1);
            best_end = u;
        }
        for &ei in g.incident(u) {
            let e = &g.edges[ei as usize];
            let from_a = e.a == u;
            if !can(e, from_a) {
                continue;
            }
            let v = if from_a { e.b } else { e.a };
            let nd = d + e.len_m();
            if nd < dist[v as usize] {
                dist[v as usize] = nd;
                prev[v as usize] = ei;
                heap.push(QItem(nd, v));
            }
        }
    }
    if !best.is_finite() {
        return None;
    }
    let mut chain: Vec<(u32, f32)> = Vec::new(); // (edge, metres walked on it), reversed
    if best_end == u32::MAX {
        chain.push((from.0, best));
    } else {
        chain.push((to.0, if best_end == te.a { te.len_m() * to.1 } else { te.len_m() * (1.0 - to.1) }));
        let mut u = best_end;
        while prev[u as usize] != u32::MAX {
            let ei = prev[u as usize];
            let e = &g.edges[ei as usize];
            chain.push((ei, e.len_m()));
            u = e.other(u);
        }
        chain.push((from.0, if u == fe.a { fe.len_m() * from.1 } else { fe.len_m() * (1.0 - from.1) }));
    }
    chain.reverse();
    let mut r = TestRoute { dist_m: best, snap_from_m: from.2, snap_to_m: to.2, lifts: 0, steps: 0, escalators: 0, legs: Vec::new() };
    for (ei, m) in chain {
        let e = &g.edges[ei as usize];
        match e.kind {
            EdgeKind::Lift => r.lifts += 1,
            EdgeKind::Steps => r.steps += e.steps as u32,
            EdgeKind::Escalator => r.escalators += 1,
            _ => {}
        }
        let way = g.edge_way[ei as usize];
        match r.legs.last_mut() {
            Some(l) if l.way == way && l.kind == e.kind && way != 0 && e.kind != EdgeKind::Lift => {
                l.len_m += m;
                l.level_b = if e.level_a == l.level_b { e.level_b } else { e.level_a };
            }
            _ => r.legs.push(TestLeg { way, kind: e.kind, level_a: e.level_a, level_b: e.level_b, len_m: m, name: g.edge_name(ei).to_string(), flags: e.flags }),
        }
    }
    Some(r)
}

pub fn describe(r: &TestRoute) -> String {
    let mut s = String::new();
    let _ = writeln!(
        s,
        "    {:.0} m (snap {:.1} m / {:.1} m), lifts {}, steps {}, escalators {}",
        r.dist_m, r.snap_from_m, r.snap_to_m, r.lifts, r.steps, r.escalators
    );
    for l in &r.legs {
        let lv = if l.level_a == l.level_b { level_str(l.level_a) } else { format!("{}→{}", level_str(l.level_a), level_str(l.level_b)) };
        let _ = writeln!(
            s,
            "      {:>6.1} m  {:<10} level {:<6} way {:<11} {}{}",
            l.len_m,
            KIND_NAMES[l.kind as usize],
            lv,
            l.way,
            l.name,
            if l.flags & EF_AREA != 0 { " [area]" } else { "" }
        );
    }
    s
}

/// Structural invariants every consumer relies on. Returns descriptions of
/// violations (empty = fine).
pub fn check(g: &WalkGraph, x: &OsmExtract) -> Vec<String> {
    let mut bad = Vec::new();
    let n = g.nodes.len();
    if g.node_flags.len() != n || g.adj_off.len() != n + 1 || g.adj.len() != g.edges.len() * 2 || g.edge_way.len() != g.edges.len() {
        bad.push("array lengths disagree".to_string());
        return bad;
    }
    if g.names.first().map(|s| !s.is_empty()).unwrap_or(true) {
        bad.push("names[0] is not the empty string".to_string());
    }
    let mut deg = vec![0u32; n];
    for (i, e) in g.edges.iter().enumerate() {
        if bad.len() > 50 {
            break;
        }
        if e.a as usize >= n || e.b as usize >= n {
            bad.push(format!("edge {i}: node out of range"));
            continue;
        }
        deg[e.a as usize] += 1;
        deg[e.b as usize] += 1;
        if e.a == e.b {
            bad.push(format!("edge {i}: self loop"));
        }
        if e.geom_len < 2 || e.geom_off as usize + e.geom_len as usize > g.geom.len() {
            bad.push(format!("edge {i}: bad geometry range"));
            continue;
        }
        let geom = g.edge_geom(i as u32);
        if geom[0] != g.nodes[e.a as usize] || geom[geom.len() - 1] != g.nodes[e.b as usize] {
            bad.push(format!("edge {i}: geometry does not start/end at its nodes"));
        }
        let len: f32 = geom.windows(2).map(|w| w[0].dist_m(&w[1])).sum();
        if (len - e.len_m()).abs() > 0.2 + len * 0.001 {
            bad.push(format!("edge {i}: len_dm {} but geometry is {len:.1} m", e.len_dm));
        }
        if e.name as usize >= g.names.len() {
            bad.push(format!("edge {i}: name out of range"));
        }
        if e.flags & EF_ONEWAY_AB != 0 && e.flags & EF_ONEWAY_BA != 0 {
            bad.push(format!("edge {i}: one-way in both directions"));
        }
        if e.flags & EF_UP_AB != 0 && e.flags & EF_UP_BA != 0 {
            bad.push(format!("edge {i}: up in both directions"));
        }
        if e.kind == EdgeKind::Steps && e.steps == 0 {
            bad.push(format!("edge {i}: steps without step count"));
        }
        if (e.level_a == LEVEL_NONE) != (e.level_b == LEVEL_NONE) && e.kind != EdgeKind::Lift {
            bad.push(format!("edge {i}: level known at one end only"));
        }
    }
    for v in 0..n as u32 {
        if bad.len() > 50 {
            break;
        }
        let inc = g.incident(v);
        if inc.len() as u32 != deg[v as usize] || inc.is_empty() {
            bad.push(format!("node {v}: adjacency has {} edges, expected {}", inc.len(), deg[v as usize]));
        }
        for &e in inc {
            let ed = &g.edges[e as usize];
            if ed.a != v && ed.b != v {
                bad.push(format!("node {v}: adjacency lists edge {e} which does not touch it"));
            }
        }
    }
    for (i, p) in x.platforms.iter().enumerate() {
        if p.edges.iter().any(|e| *e as usize >= g.edges.len()) {
            bad.push(format!("platform {i}: edge index out of range"));
        }
        if p.pos.is_none() {
            bad.push(format!("platform {i}: no position"));
        }
    }
    for (i, c) in x.carriageways.iter().enumerate() {
        if c.geom_len < 2 || c.geom_off as usize + c.geom_len as usize > x.carriageway_geom.len() || c.name as usize >= x.carriageway_names.len() {
            bad.push(format!("carriageway {i}: bad range"));
            break;
        }
    }
    bad
}

/// Lists the nodes where flat ways of different levels meet without a lift.
pub fn odd_junctions(g: &WalkGraph, bbox: Option<&BBox>) -> String {
    let mut s = String::new();
    for n in 0..g.nodes.len() as u32 {
        if bbox.map(|b| !b.contains(&g.nodes[n as usize])).unwrap_or(false) || g.node_flags[n as usize] & NF_ELEVATOR != 0 {
            continue;
        }
        let mut lv: Vec<(Level2, i64, EdgeKind)> = Vec::new();
        for &ei in g.incident(n) {
            let e = &g.edges[ei as usize];
            if e.level_a != e.level_b || matches!(e.kind, EdgeKind::Steps | EdgeKind::Escalator | EdgeKind::Lift) || e.level_a == LEVEL_NONE {
                continue;
            }
            if !lv.iter().any(|x| x.0 == e.level_a) {
                lv.push((e.level_a, g.edge_way[ei as usize], e.kind));
            }
        }
        if lv.len() >= 2 {
            let d: Vec<String> = lv.iter().map(|x| format!("level {} way {} {}", level_str(x.0), x.1, KIND_NAMES[x.2 as usize])).collect();
            let _ = writeln!(s, "  {:.6},{:.6}: {}", g.nodes[n as usize].lat_deg(), g.nodes[n as usize].lon_deg(), d.join(" | "));
        }
    }
    s
}
