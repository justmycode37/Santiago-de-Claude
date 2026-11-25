//! Laying a stop sequence onto the network: one path through all the stops of a pattern at once.
//!
//! Each stop has a few candidate places on the network (the ways usable by the mode within a radius, each in both
//! directions a vehicle can drive it), plus a "free" place at the stop itself for when none of them is right
//! (a stop outside the map, a way missing from it). A hidden Markov model picks one candidate per stop: emission =
//! how far the candidate is from the boarding point (less where the track's `railway:track_ref` is the stop's
//! platform number, more where it is another), transition = the cost of driving from one to the next on the
//! network. Viterbi's recursion over a hop is one multi-source Dijkstra seeded with the cost so far of every
//! candidate of the stop before, so the whole sequence is chosen together: one stop nearer another track or
//! another road does not move the path there when the stops around it say otherwise.
//!
//! The search runs on directed edges, so a vehicle never turns back on the edge it came along, and a train never
//! takes a switch from one branch into the other (a turn sharper than the profile's `max_turn` at a junction).
//! Turning back at a stop is allowed with a penalty (trains reverse in stub stations; buses hardly ever).
//!
//! The pattern's own line: the OSM route relation of the same kind and `ref` whose member ways pass the most stops
//! in order (in member order, or in reverse for a relation that serves both directions) makes the ways it uses
//! cheaper (`ON_LINE`), so the path follows the line as mapped, not merely a quick way between the stops. Ways of
//! any relation of the mode are slightly cheaper (`ON_MODE`). Without a relation that fits, the network alone.

use crate::net::*;
use kante_core::geo::LatLon;
use kante_core::{Mode, Precision, Stop};
use std::cmp::Reverse;
use std::collections::BinaryHeap;

pub const ON_LINE: f32 = 0.4;
pub const ON_MODE: f32 = 0.85;

pub struct Profile {
    /// m/s per way class; 0 = the mode cannot use it.
    pub speed: [f32; NCLASS],
    pub wrong_way: f32,
    pub penal: f32,
    /// How far a candidate may be from a boarding point with its own coordinate / one known only as the station.
    pub radius: f32,
    pub radius_far: f32,
    pub max_cands: usize,
    /// Seconds per metre between the boarding point and the candidate.
    pub snap_cost: f32,
    pub vmax: f32,
    /// For budgets and straight stretches.
    pub v_typ: f32,
    /// Cosine of the sharpest turn allowed at a junction.
    pub max_turn_cos: f32,
    /// Seconds for turning back at a stop.
    pub reversal: f32,
    /// Route relation kinds of this mode.
    pub rel_kinds: u8,
    /// Platform numbers on tracks (`railway:track_ref`) say which track a stop is at.
    pub tracks: bool,
    /// How near a relation's way must pass a stop to count it as served.
    pub cover_r: f32,
    /// Seconds for a hop that leaves the network (a straight line), on top of its straight time.
    pub gap: f32,
}

fn turn_cos(deg: f32) -> f32 {
    deg.to_radians().cos()
}

/// The profile a mode is laid out with; None: not laid out (lifts, unknown).
pub fn profile(mode: Mode) -> Option<Profile> {
    let mut s = [0f32; NCLASS];
    Some(match mode {
        Mode::Bus | Mode::OnDemand => {
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
            Profile {
                speed: s,
                wrong_way: 20.0,
                penal: 3.0,
                radius: 70.0,
                radius_far: 250.0,
                max_cands: 8,
                snap_cost: 0.5,
                vmax: 25.0,
                v_typ: 8.0,
                max_turn_cos: turn_cos(165.0),
                reversal: 300.0,
                rel_kinds: RK_BUS,
                tracks: false,
                cover_r: 40.0,
                gap: 600.0,
            }
        }
        Mode::Rail | Mode::RackRail => {
            s[RAIL as usize] = 30.0;
            s[NARROW as usize] = 25.0;
            s[LIGHT as usize] = 15.0;
            s[TRAM as usize] = 4.0;
            s[SUBWAY as usize] = 4.0;
            s[FUNI as usize] = 3.0;
            Profile {
                speed: s,
                wrong_way: 1.0,
                penal: 3.0,
                radius: 120.0,
                radius_far: 400.0,
                max_cands: 12,
                snap_cost: 0.2,
                vmax: 45.0,
                v_typ: 20.0,
                max_turn_cos: turn_cos(100.0),
                reversal: 300.0,
                rel_kinds: RK_TRAIN | RK_SUBWAY,
                tracks: true,
                cover_r: 100.0,
                gap: 900.0,
            }
        }
        Mode::Tram => {
            s[TRAM as usize] = 10.0;
            s[LIGHT as usize] = 10.0;
            s[NARROW as usize] = 8.0;
            s[SUBWAY as usize] = 8.0;
            s[RAIL as usize] = 4.0;
            Profile {
                speed: s,
                wrong_way: 4.0,
                penal: 3.0,
                radius: 60.0,
                radius_far: 200.0,
                max_cands: 8,
                snap_cost: 0.4,
                vmax: 20.0,
                v_typ: 7.0,
                max_turn_cos: turn_cos(120.0),
                reversal: 600.0,
                rel_kinds: RK_TRAM | RK_SUBWAY,
                tracks: false,
                cover_r: 40.0,
                gap: 600.0,
            }
        }
        Mode::Metro => {
            s[SUBWAY as usize] = 12.0;
            s[LIGHT as usize] = 10.0;
            s[RAIL as usize] = 8.0;
            s[NARROW as usize] = 8.0;
            s[TRAM as usize] = 5.0;
            s[FUNI as usize] = 5.0;
            Profile {
                speed: s,
                wrong_way: 1.0,
                penal: 3.0,
                radius: 120.0,
                radius_far: 300.0,
                max_cands: 8,
                snap_cost: 0.2,
                vmax: 20.0,
                v_typ: 10.0,
                max_turn_cos: turn_cos(120.0),
                reversal: 300.0,
                rel_kinds: RK_SUBWAY | RK_TRAIN,
                tracks: true,
                cover_r: 80.0,
                gap: 600.0,
            }
        }
        Mode::Funicular => {
            s[FUNI as usize] = 5.0;
            s[RAIL as usize] = 3.0;
            s[NARROW as usize] = 3.0;
            s[LIGHT as usize] = 3.0;
            s[AERIAL as usize] = 2.0;
            Profile {
                speed: s,
                wrong_way: 1.0,
                penal: 3.0,
                radius: 120.0,
                radius_far: 300.0,
                max_cands: 6,
                snap_cost: 0.1,
                vmax: 12.0,
                v_typ: 5.0,
                max_turn_cos: turn_cos(120.0),
                reversal: 0.0,
                rel_kinds: RK_FUNI | RK_TRAIN,
                tracks: false,
                cover_r: 80.0,
                gap: 300.0,
            }
        }
        Mode::Boat => {
            s[FERRY as usize] = 8.0;
            Profile {
                speed: s,
                wrong_way: 1.0,
                penal: 1.0,
                radius: 800.0,
                radius_far: 1500.0,
                max_cands: 8,
                snap_cost: 0.02,
                vmax: 12.0,
                v_typ: 6.0,
                max_turn_cos: -1.0,
                reversal: 0.0,
                rel_kinds: RK_FERRY,
                tracks: false,
                cover_r: 600.0,
                gap: 600.0,
            }
        }
        Mode::Cableway => {
            s[AERIAL as usize] = 6.0;
            Profile {
                speed: s,
                wrong_way: 1.0,
                penal: 1.0,
                radius: 150.0,
                radius_far: 400.0,
                max_cands: 6,
                snap_cost: 0.1,
                vmax: 12.0,
                v_typ: 6.0,
                max_turn_cos: turn_cos(120.0),
                reversal: 0.0,
                rel_kinds: RK_AERIAL,
                tracks: false,
                cover_r: 150.0,
                gap: 120.0,
            }
        }
        Mode::Lift | Mode::Other => return None,
    })
}

/// One stop as the matcher sees it.
pub struct StopIn<'a> {
    pub pos: LatLon,
    pub label: &'a str,
    pub precision: Precision,
}

impl<'a> StopIn<'a> {
    pub fn of(s: &'a Stop) -> Self {
        StopIn { pos: s.pos, label: &s.label, precision: s.precision }
    }
}

/// How a hop of the result was found.
pub const HOP_NET: u8 = 0;
/// On the network, mostly along the pattern's own route relation.
pub const HOP_LINE: u8 = 1;
/// A straight line: no way on the network (outside the map, a way missing from it).
pub const HOP_STRAIGHT: u8 = 2;

pub struct Matched {
    /// Planar metres.
    pub pts: Vec<[f32; 2]>,
    /// Per stop: its vertex in `pts` (where the vehicle stands there).
    pub at: Vec<u32>,
    /// Per hop (stop k → k + 1): HOP_*.
    pub hops: Vec<u8>,
    /// The OSM id of the route relation followed, 0 when none.
    pub relation: i64,
    /// Per stop: metres from the boarding point to where the vehicle stands (NaN where free).
    pub snap_m: Vec<f32>,
    /// Per stop: it has no way of the mode near it (outside the map, or a way the map lacks).
    pub off_map: Vec<bool>,
}

#[derive(Clone, Copy)]
struct Cand {
    /// NONE for the free place at the stop.
    edge: u32,
    dir: u8,
    /// Metres from the edge's node a.
    off: f32,
    pt: [f32; 2],
    emis: f32,
    d: f32,
}

const NONE: u32 = u32::MAX;
const SEED: u32 = u32::MAX - 1;
/// Partial Viterbi costs further above the best one than this are not searched on.
const MARGIN: f32 = 1000.0;
/** Targets costing more than the best one by this are not searched for: above the dearest turning back at a stop
 *  (a tram's), so a candidate that will have to turn back is still reached. */
const SEARCH_MARGIN: f32 = 600.0;
const MAX_POPS: u32 = 3_000_000;

/// Per-thread search arrays, reused from pattern to pattern.
pub struct Scratch {
    dist: Vec<f32>,
    prev: Vec<u32>,
    src: Vec<u16>,
    stamp: Vec<u32>,
    tgt: Vec<u32>,
    cur: u32,
    way_line: Vec<u32>,
    line_cur: u32,
}

impl Scratch {
    pub fn new(net: &Net) -> Self {
        let n = net.n_edges() * 2;
        Scratch {
            dist: vec![0.0; n],
            prev: vec![0; n],
            src: vec![0; n],
            stamp: vec![0; n],
            tgt: vec![0; n],
            cur: 0,
            way_line: vec![0; net.way_track.len()],
            line_cur: 0,
        }
    }
    fn next_round(&mut self) -> u32 {
        self.cur = self.cur.wrapping_add(1);
        if self.cur == 0 {
            self.stamp.iter_mut().for_each(|x| *x = 0);
            self.tgt.iter_mut().for_each(|x| *x = 0);
            self.cur = 1;
        }
        self.cur
    }
}

struct Ctx<'a> {
    net: &'a Net,
    p: &'a Profile,
}

impl<'a> Ctx<'a> {
    /// Seconds to drive all of directed edge `de`; infinite where the profile may not.
    #[inline]
    fn cost(&self, s: &Scratch, de: u32) -> f32 {
        let e = (de >> 1) as usize;
        let net = self.net;
        let sp = self.p.speed[net.e_class[e] as usize];
        if sp <= 0.0 {
            return f32::INFINITY;
        }
        let fl = net.e_flags[e];
        let (allow, wrong) = if de & 1 == 0 { (fl & F_FWD, fl & F_FWD_WRONG) } else { (fl & F_BWD, fl & F_BWD_WRONG) };
        if allow == 0 {
            return f32::INFINITY;
        }
        let mut t = net.e_len[e] / sp;
        if wrong != 0 {
            t *= self.p.wrong_way;
        }
        if fl & F_PENAL != 0 {
            t *= self.p.penal;
        }
        let w = net.e_way[e] as usize;
        if s.way_line[w] == s.line_cur && s.line_cur != 0 {
            t *= ON_LINE;
        } else if net.way_kinds[w] & self.p.rel_kinds != 0 {
            t *= ON_MODE;
        }
        t
    }
    #[inline]
    fn turn_ok(&self, from: u32, to: u32) -> bool {
        if from >> 1 == to >> 1 {
            // back along the same edge; only a closed way (a loop) runs on into itself
            let e = (from >> 1) as usize;
            if !(self.net.ea[e] == self.net.eb[e] && from == to) {
                return false;
            }
        }
        if self.p.max_turn_cos <= -1.0 {
            return true;
        }
        let h1 = self.net.de_heading(from, true);
        let h2 = self.net.de_heading(to, false);
        h1[0] * h2[0] + h1[1] * h2[1] >= self.p.max_turn_cos
    }
}

/// Candidates of one stop: the nearest usable edges (each once, in each direction it may be driven) and the free place.
fn candidates(ctx: &Ctx, s: &Scratch, st: &StopIn) -> Vec<Cand> {
    let net = ctx.net;
    let p = ctx.p;
    let at = xy(&st.pos);
    let r = if st.precision == Precision::Edge { p.radius } else { p.radius_far };
    let mut best: Vec<(u32, u32, f32, f32)> = Vec::new(); // (edge, seg, t, d)
    net.grid.around(at, r, |e, seg| {
        let eu = e as usize;
        if p.speed[net.e_class[eu] as usize] <= 0.0 {
            return;
        }
        let g = net.geom(eu);
        let (d, t) = project(at, g[seg as usize], g[seg as usize + 1]);
        if d > r {
            return;
        }
        match best.iter_mut().find(|b| b.0 == e) {
            Some(b) => {
                if d < b.3 {
                    *b = (e, seg, t, d);
                }
            }
            None => best.push((e, seg, t, d)),
        }
    });
    best.sort_by(|a, b| a.3.total_cmp(&b.3).then(a.0.cmp(&b.0)));
    best.truncate(p.max_cands);
    let label = if p.tracks && !st.label.is_empty() { norm_track(st.label) } else { String::new() };
    let mut out = Vec::new();
    for (e, seg, t, d) in best {
        let eu = e as usize;
        let g = net.geom(eu);
        let (a, b) = (g[seg as usize], g[seg as usize + 1]);
        let pt = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
        let off = net.offset_of(eu, seg as usize, t);
        // the track's platform number: the same as the stop's makes it the likely one, another number less likely
        let mut de = d;
        if !label.is_empty() {
            let tr = net.way_track[net.e_way[eu] as usize];
            if tr != NO_TRACK {
                if net.tracks[tr as usize] == label {
                    de *= 0.3;
                } else {
                    de += 15.0;
                }
            }
        }
        for dir in 0..2u8 {
            if ctx.cost(s, e << 1 | dir as u32).is_finite() {
                out.push(Cand { edge: e, dir, off, pt, emis: de * p.snap_cost, d });
            }
        }
    }
    out.push(Cand { edge: NONE, dir: 0, off: 0.0, pt: at, emis: 0.0, d: f32::NAN });
    out
}

/// How a candidate of stop k + 1 was reached.
#[derive(Clone)]
enum Via {
    Start,
    /// From candidate `from` of stop k, along the directed edges `des` (the first is the one it leaves on).
    Path { from: u16, des: Vec<u32> },
    Direct { from: u16 },
    Straight { from: u16 },
}

/// The route relation this pattern most likely is: same kind and line ref, its ways passing the most stops in
/// order. (relation index, stops passed in order)
pub fn pick_relation(net: &Net, p: &Profile, line_ref: &str, stops: &[StopIn]) -> Option<(u32, usize)> {
    if line_ref.is_empty() || stops.len() < 2 {
        return None;
    }
    // per stop: (relation, member position) of the matching relations' ways passing it
    let mut per_stop: Vec<Vec<(u32, u32)>> = Vec::with_capacity(stops.len());
    let mut rels: Vec<u32> = Vec::new();
    for st in stops {
        let at = xy(&st.pos);
        let r = if st.precision == Precision::Edge { p.cover_r } else { p.cover_r * 3.0 };
        let mut v: Vec<(u32, u32)> = Vec::new();
        net.grid.around(at, r, |e, seg| {
            let eu = e as usize;
            let w = net.e_way[eu] as usize;
            if net.way_kinds[w] & p.rel_kinds == 0 {
                return;
            }
            let g = net.geom(eu);
            if project(at, g[seg as usize], g[seg as usize + 1]).0 > r {
                return;
            }
            for &(ri, pos) in &net.way_rel[net.way_rel_off[w] as usize..net.way_rel_off[w + 1] as usize] {
                let rel = &net.rels[ri as usize];
                if rel.kind & p.rel_kinds != 0 && rel.line_ref == line_ref && !v.contains(&(ri, pos)) {
                    v.push((ri, pos));
                }
            }
        });
        for &(ri, _) in &v {
            if !rels.contains(&ri) {
                rels.push(ri);
            }
        }
        per_stop.push(v);
    }
    let mut best: Option<(u32, f32, usize)> = None;
    for &ri in &rels {
        // the most stops passed in member order (the longest run of stops whose members never go back), forwards
        // and backwards (a relation drawn once for both directions); one stop passing the relation twice (a loop)
        // counts at whichever place fits the order
        let ordered = |rev: bool| -> usize {
            let mut done: Vec<(u32, usize)> = Vec::new(); // (member position, stops passed up to it)
            let mut top = 0;
            let iter: Box<dyn Iterator<Item = &Vec<(u32, u32)>>> = if rev { Box::new(per_stop.iter().rev()) } else { Box::new(per_stop.iter()) };
            for v in iter {
                let here: Vec<(u32, usize)> = v
                    .iter()
                    .filter(|x| x.0 == ri)
                    .map(|&(_, pos)| (pos, 1 + done.iter().filter(|d| d.0 <= pos).map(|d| d.1).max().unwrap_or(0)))
                    .collect();
                for h in here {
                    top = top.max(h.1);
                    done.push(h);
                }
            }
            top
        };
        let (f, b) = (ordered(false), ordered(true));
        // the direction the relation is drawn in counts a little more where both fit (the other direction's relation)
        let score = (f as f32).max(b as f32 * 0.95);
        if best.is_none_or(|x| score > x.1) {
            best = Some((ri, score, f.max(b)));
        }
    }
    let (ri, _, n) = best?;
    let need = ((stops.len() as f32) * 0.6).ceil().max(2.0) as usize;
    (n >= need).then_some((ri, n))
}

/// The path of one pattern. `relation`: what [`pick_relation`] chose.
pub fn match_pattern(net: &Net, p: &Profile, s: &mut Scratch, stops: &[StopIn], relation: Option<u32>) -> Matched {
    // mark the relation's ways with a fresh value (without a relation no way carries it)
    s.line_cur = s.line_cur.wrapping_add(1);
    if s.line_cur == 0 {
        s.way_line.iter_mut().for_each(|x| *x = 0);
        s.line_cur = 1;
    }
    if let Some(ri) = relation {
        let ri = ri as usize;
        for &w in &net.rel_mem[net.rel_mem_off[ri] as usize..net.rel_mem_off[ri + 1] as usize] {
            s.way_line[w as usize] = s.line_cur;
        }
    }
    let ctx = Ctx { net, p };
    let n = stops.len();
    let cands: Vec<Vec<Cand>> = stops.iter().map(|st| candidates(&ctx, s, st)).collect();
    let mut v: Vec<f32> = cands[0].iter().map(|c| c.emis).collect();
    // per stop k ≥ 1: how each candidate was reached; per stop: the candidate turned back from (or u16::MAX)
    let mut via: Vec<Vec<Via>> = vec![vec![Via::Start; cands[0].len()]];
    let mut turned: Vec<Vec<u16>> = Vec::with_capacity(n);
    for k in 0..n - 1 {
        let (ca, cb) = (&cands[k], &cands[k + 1]);
        // turning back at stop k: a candidate may start from its opposite direction's cost, plus the penalty
        let mut tv = v.clone();
        let mut tback = vec![u16::MAX; ca.len()];
        if k > 0 {
            for (i, c) in ca.iter().enumerate() {
                if c.edge == NONE {
                    continue;
                }
                if let Some(j) = ca.iter().position(|o| o.edge == c.edge && o.dir != c.dir && o.off == c.off) {
                    if v[j] + p.reversal < tv[i] {
                        tv[i] = v[j] + p.reversal;
                        tback[i] = j as u16;
                    }
                }
            }
        }
        turned.push(tback);
        let (nv, nvia) = hop(&ctx, s, ca, &tv, cb, stops[k].pos.dist_m(&stops[k + 1].pos));
        v = nv;
        via.push(nvia);
    }
    turned.push(vec![u16::MAX; cands[n - 1].len()]);

    // back from the best last candidate
    let mut chosen = vec![0usize; n];
    let mut best = 0;
    for i in 1..v.len() {
        if v[i] < v[best] {
            best = i;
        }
    }
    chosen[n - 1] = best;
    // the candidate each hop leaves from (after turning back), per stop
    let mut leave = vec![0usize; n];
    for k in (1..n).rev() {
        let from = match &via[k][chosen[k]] {
            Via::Path { from, .. } | Via::Direct { from } | Via::Straight { from } => *from as usize,
            Via::Start => 0,
        };
        leave[k - 1] = from;
        let tb = turned[k - 1][from];
        chosen[k - 1] = if tb != u16::MAX { tb as usize } else { from };
    }

    // the geometry
    let mut pts: Vec<[f32; 2]> = Vec::new();
    let mut at = Vec::with_capacity(n);
    let mut hops = Vec::with_capacity(n.saturating_sub(1));
    let push = |pts: &mut Vec<[f32; 2]>, q: [f32; 2]| {
        if pts.last().is_none_or(|l| dist(*l, q) > 0.01) {
            pts.push(q);
        }
    };
    let c0 = &cands[0][chosen[0]];
    pts.push(c0.pt);
    at.push(0u32);
    for k in 1..n {
        let a = &cands[k - 1][leave[k - 1]];
        let b = &cands[k][chosen[k]];
        let kind = match &via[k][chosen[k]] {
            Via::Path { des, .. } => {
                let mut part = Vec::new();
                let (ea, eb) = (a.edge as usize, b.edge as usize);
                // the rest of the edge it leaves on, the edges between, the start of the edge it arrives on
                net.cut(ea, a.off, if a.dir == 0 { net.e_len[ea] } else { 0.0 }, &mut part);
                // how much of the hop is on the line's relation, the partly driven edges at its ends included
                let on_line = |e: usize| relation.is_some() && s.way_line[net.e_way[e] as usize] == s.line_cur;
                let a_part = if a.dir == 0 { net.e_len[ea] - a.off } else { a.off };
                let b_part = if b.dir == 0 { b.off } else { net.e_len[eb] - b.off };
                let mut m = a_part + b_part;
                let mut line_m = if on_line(ea) { a_part } else { 0.0 } + if on_line(eb) { b_part } else { 0.0 };
                for &de in des.iter().skip(1) {
                    let e = (de >> 1) as usize;
                    let g = net.geom(e);
                    if de & 1 == 0 {
                        part.extend_from_slice(g);
                    } else {
                        part.extend(g.iter().rev());
                    }
                    m += net.e_len[e];
                    if on_line(e) {
                        line_m += net.e_len[e];
                    }
                }
                net.cut(eb, if b.dir == 0 { 0.0 } else { net.e_len[eb] }, b.off, &mut part);
                for q in part {
                    push(&mut pts, q);
                }
                if relation.is_some() && m > 0.0 && line_m >= 0.6 * m {
                    HOP_LINE
                } else {
                    HOP_NET
                }
            }
            Via::Direct { .. } => {
                let mut part = Vec::new();
                net.cut(a.edge as usize, a.off, b.off, &mut part);
                for q in part {
                    push(&mut pts, q);
                }
                let w = net.e_way[a.edge as usize] as usize;
                if relation.is_some() && s.way_line[w] == s.line_cur {
                    HOP_LINE
                } else {
                    HOP_NET
                }
            }
            Via::Straight { .. } | Via::Start => {
                push(&mut pts, a.pt);
                push(&mut pts, b.pt);
                HOP_STRAIGHT
            }
        };
        // the stop's own vertex is where its candidate is, even when the part ended a hair off it
        if pts.last().is_none_or(|l| dist(*l, b.pt) > 0.01) {
            pts.push(b.pt);
        }
        at.push(pts.len() as u32 - 1);
        hops.push(kind);
    }
    let snap_m = (0..n).map(|k| cands[k][chosen[k]].d).collect();
    let off_map = cands.iter().map(|c| c.len() == 1).collect();
    let rel_id = relation.map_or(0, |r| net.rels[r as usize].id);
    let (pts, at) = simplify_hops(&pts, &at, 1.0);
    Matched { pts, at, hops, relation: rel_id, snap_m, off_map }
}

/// Viterbi over one hop: the cost of the best way to each candidate of the next stop (`v` + emission) and how it
/// was reached.
fn hop(ctx: &Ctx, s: &mut Scratch, ca: &[Cand], va: &[f32], cb: &[Cand], straight: f32) -> (Vec<f32>, Vec<Via>) {
    let net = ctx.net;
    let p = ctx.p;
    let nb = cb.len();
    let mut best = vec![f32::INFINITY; nb];
    let mut how: Vec<Via> = vec![Via::Start; nb];
    let mut pred = vec![NONE; nb]; // the directed edge before the target's, or SEED (seeded on it)
    let mut pred_src = vec![0u16; nb];
    let cur = s.next_round();
    let vmin = va.iter().copied().fold(f32::INFINITY, f32::min);

    // free places and straight lines: from and to every candidate, as the crow flies, with the gap penalty
    for (j, b) in cb.iter().enumerate() {
        for (i, a) in ca.iter().enumerate() {
            if !va[i].is_finite() || (a.edge != NONE && b.edge != NONE) {
                continue;
            }
            let c = va[i] + p.gap + dist(a.pt, b.pt) / p.v_typ;
            if c < best[j] {
                best[j] = c;
                how[j] = Via::Straight { from: i as u16 };
            }
        }
    }
    // the same edge, the same direction, onwards
    for (j, b) in cb.iter().enumerate() {
        if b.edge == NONE {
            continue;
        }
        for (i, a) in ca.iter().enumerate() {
            if a.edge != b.edge || a.dir != b.dir || !va[i].is_finite() {
                continue;
            }
            let ahead = if a.dir == 0 { b.off - a.off } else { a.off - b.off };
            if ahead < 0.0 {
                continue;
            }
            let e = a.edge as usize;
            let c = va[i] + ctx.cost(s, a.edge << 1 | a.dir as u32) * ahead / net.e_len[e].max(0.01);
            if c < best[j] {
                best[j] = c;
                how[j] = Via::Direct { from: i as u16 };
            }
        }
    }
    // targets: the directed edge each candidate is on, with the share of it driven to get there
    let mut tgt_list: Vec<(u32, u16, f32)> = Vec::new();
    for (j, b) in cb.iter().enumerate() {
        if b.edge == NONE {
            continue;
        }
        let de = b.edge << 1 | b.dir as u32;
        let len = net.e_len[b.edge as usize].max(0.01);
        let frac = if b.dir == 0 { b.off / len } else { (len - b.off) / len };
        tgt_list.push((de, j as u16, frac.clamp(0.0, 1.0)));
        s.tgt[de as usize] = cur;
    }
    let goal = {
        let mut c = [0.0f32; 2];
        let mut k = 0.0;
        for b in cb {
            c[0] += b.pt[0];
            c[1] += b.pt[1];
            k += 1.0;
        }
        [c[0] / k, c[1] / k]
    };
    let goal_r = cb.iter().map(|b| dist(b.pt, goal)).fold(0.0, f32::max);
    let min_per_m = ON_LINE / p.vmax;
    let h = |net: &Net, de: u32| -> f32 {
        let (_, end) = net.de_nodes(de);
        (dist(net.node_xy[end as usize], goal) - goal_r).max(0.0) * min_per_m
    };
    let budget = vmin + (3.0 * straight + 3000.0) / p.v_typ + SEARCH_MARGIN;
    let mut heap: BinaryHeap<Reverse<(u32, u32, u32)>> = BinaryHeap::new();
    // seeds: the rest of the edge each candidate of stop k leaves on
    for (i, a) in ca.iter().enumerate() {
        if a.edge == NONE || !va[i].is_finite() || va[i] > vmin + MARGIN {
            continue;
        }
        let de = a.edge << 1 | a.dir as u32;
        let c = ctx.cost(s, de);
        if !c.is_finite() {
            continue;
        }
        let len = net.e_len[a.edge as usize].max(0.01);
        let rest = if a.dir == 0 { (len - a.off) / len } else { a.off / len };
        let g = va[i] + c * rest.clamp(0.0, 1.0);
        let du = de as usize;
        if s.stamp[du] != cur || g < s.dist[du] {
            s.stamp[du] = cur;
            s.dist[du] = g;
            s.prev[du] = SEED;
            s.src[du] = i as u16;
            heap.push(Reverse(((g + h(net, de)).to_bits(), g.to_bits(), de)));
        }
    }
    let mut pops = 0u32;
    while let Some(Reverse((fb, gb, de))) = heap.pop() {
        let (f, g) = (f32::from_bits(fb), f32::from_bits(gb));
        let du = de as usize;
        if g > s.dist[du] {
            continue;
        }
        // nothing better can come for any target the search could still matter for
        let bound = best.iter().zip(cb).map(|(b, c)| b + c.emis).fold(f32::INFINITY, f32::min) + SEARCH_MARGIN;
        if f >= bound {
            break;
        }
        if g > budget {
            continue;
        }
        pops += 1;
        if pops > MAX_POPS {
            break;
        }
        let (_, end) = net.de_nodes(de);
        for &out in net.leaving(end) {
            if !ctx.turn_ok(de, out) {
                continue;
            }
            let c = ctx.cost(s, out);
            if !c.is_finite() {
                continue;
            }
            let ou = out as usize;
            if s.tgt[ou] == cur {
                for &(tde, j, frac) in &tgt_list {
                    if tde != out {
                        continue;
                    }
                    let cand = g + c * frac;
                    let j = j as usize;
                    if cand < best[j] {
                        best[j] = cand;
                        pred[j] = de;
                        pred_src[j] = s.src[du];
                        how[j] = Via::Path { from: s.src[du], des: Vec::new() };
                    }
                }
            }
            let ng = g + c;
            if s.stamp[ou] != cur || ng < s.dist[ou] {
                s.stamp[ou] = cur;
                s.dist[ou] = ng;
                s.prev[ou] = de;
                s.src[ou] = s.src[du];
                heap.push(Reverse(((ng + h(net, out)).to_bits(), ng.to_bits(), out)));
            }
        }
    }
    // the directed edges of each path, from the edge it leaves on to the one before the target's
    for j in 0..nb {
        if let Via::Path { from, .. } = how[j] {
            let mut des = Vec::new();
            let mut de = pred[j];
            while de != SEED && de != NONE {
                des.push(de);
                let pv = s.prev[de as usize];
                if pv == SEED {
                    break;
                }
                de = pv;
            }
            des.reverse();
            debug_assert_eq!(from, pred_src[j]);
            // the target's own edge closes the path (cut from its start to the candidate)
            how[j] = Via::Path { from, des };
        }
    }
    let v = best.iter().zip(cb).map(|(b, c)| b + c.emis).collect();
    (v, how)
}

/// Douglas–Peucker per hop (tolerance in metres), keeping every stop's vertex.
fn simplify_hops(pts: &[[f32; 2]], at: &[u32], tol: f32) -> (Vec<[f32; 2]>, Vec<u32>) {
    let mut out: Vec<[f32; 2]> = Vec::with_capacity(pts.len());
    let mut new_at = Vec::with_capacity(at.len());
    out.push(pts[0]);
    new_at.push(0);
    for w in at.windows(2) {
        let (a, b) = (w[0] as usize, w[1] as usize);
        if b > a {
            let seg = &pts[a..=b];
            let mut keep = vec![false; seg.len()];
            keep[0] = true;
            keep[seg.len() - 1] = true;
            let mut stack = vec![(0usize, seg.len() - 1)];
            while let Some((i, j)) = stack.pop() {
                if j <= i + 1 {
                    continue;
                }
                let (mut worst, mut wi) = (0.0, i);
                for m in i + 1..j {
                    let d = project(seg[m], seg[i], seg[j]).0;
                    if d > worst {
                        worst = d;
                        wi = m;
                    }
                }
                if worst > tol {
                    keep[wi] = true;
                    stack.push((i, wi));
                    stack.push((wi, j));
                }
            }
            for (m, q) in seg.iter().enumerate().skip(1) {
                if keep[m] {
                    out.push(*q);
                }
            }
        }
        new_at.push(out.len() as u32 - 1);
    }
    (out, new_at)
}

/// The candidates of one stop, for looking at: (edge, direction, metres from the boarding point, way class, track).
pub fn debug_candidates(net: &Net, p: &Profile, st: &StopIn) -> Vec<(u32, u8, f32, u8, u32)> {
    let s = Scratch::new(net);
    let ctx = Ctx { net, p };
    candidates(&ctx, &s, st).iter().filter(|c| c.edge != NONE).map(|c| (c.edge, c.dir, c.d, net.e_class[c.edge as usize], net.way_track[net.e_way[c.edge as usize] as usize])).collect()
}
