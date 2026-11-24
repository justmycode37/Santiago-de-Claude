//! Turns the legs of a search result into a [`WalkPath`]: geometry cut at the
//! snapped ends, a level per vertex, totals, and the pieces the instruction
//! builder works on.

use crate::Cover;
use crate::net::{steps_as_ramp, C_KIND, K_BOARD, K_JUMP, NO_EDGE};
use crate::search::Leg;
use crate::{steps, WalkCost, WalkPath, WalkRouter};
use kante_core::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Dir {
    Up,
    Down,
    Unknown,
}

/// What a traveller perceives a stretch as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Cat {
    Walk,
    Platform,
    Cross,
    Stairs(Dir),
    /// Ramp beside stairs, or a non-step way that changes level.
    Ramp(Dir),
    Escalator(Dir),
    /// Moving walkway (escalator without a level change).
    Walkway,
    Lift,
    /// Change of floor at a node where the map joins two floors without
    /// saying how (see `net::floors_at`).
    Jump,
}

/// One leg with everything the instruction builder needs.
#[derive(Clone, Debug)]
pub(crate) struct Piece {
    pub cat: Cat,
    /// `NO_EDGE` for the virtual lift arcs.
    pub edge: u32,
    /// Cost class of the arc (see `net`).
    pub cls: u8,
    pub kind: EdgeKind,
    pub flags: u16,
    pub name: u32,
    pub dist: f32,
    pub cost: WalkCost,
    /// Level where the piece starts / ends, in travel direction.
    pub l0: Level2,
    pub l1: Level2,
    /// Vertex range in the path geometry, inclusive.
    pub v0: u32,
    pub v1: u32,
    /// Graph node at the end of the piece (`NO_NODE` at the very end).
    pub end_node: u32,
    /// Number of steps climbed on this piece (stairs only).
    pub steps: f32,
}

/// Level at fraction `f` of an edge.
fn level_at(ed: &WalkEdge, f: f32) -> Level2 {
    if ed.level_a == ed.level_b || f <= 0.0 {
        ed.level_a
    } else if f >= 1.0 {
        ed.level_b
    } else if ed.level_a == LEVEL_NONE || ed.level_b == LEVEL_NONE {
        LEVEL_NONE
    } else if f < 0.5 {
        ed.level_a
    } else {
        ed.level_b
    }
}

/// Appends the points of edge `e` from fraction `f0` to `f1` (backwards when
/// `f0 > f1`), each with its fraction. Always at least two points.
fn edge_slice(g: &WalkGraph, e: u32, f0: f32, f1: f32, cum: &mut Vec<f32>, out: &mut Vec<(LatLon, f32)>) {
    let pts = g.edge_geom(e);
    let start = out.len();
    if pts.len() < 2 {
        let p = pts.first().copied().unwrap_or(LatLon::NONE);
        out.push((p, f0));
        out.push((p, f1));
        return;
    }
    cum.clear();
    cum.push(0.0);
    for w in pts.windows(2) {
        let l = cum[cum.len() - 1] + w[0].dist_m(&w[1]);
        cum.push(l);
    }
    let total = cum[cum.len() - 1];
    let (lo, hi) = (f0.min(f1), f0.max(f1));
    if total <= 0.0 {
        out.push((pts[0], lo));
        out.push((pts[pts.len() - 1], hi));
    } else {
        let at = |f: f32| -> LatLon {
            if f <= 0.0 {
                return pts[0];
            }
            if f >= 1.0 {
                return pts[pts.len() - 1];
            }
            let d = f * total;
            let j = cum.partition_point(|&c| c <= d).clamp(1, pts.len() - 1);
            let seg = cum[j] - cum[j - 1];
            let t = if seg > 0.0 { ((d - cum[j - 1]) / seg).clamp(0.0, 1.0) } else { 0.0 };
            pts[j - 1].lerp(&pts[j], t)
        };
        out.push((at(lo), lo));
        for i in 1..pts.len() - 1 {
            let f = cum[i] / total;
            if f > lo + 1e-6 && f < hi - 1e-6 {
                out.push((pts[i], f));
            }
        }
        out.push((at(hi), hi));
    }
    if f0 > f1 {
        out[start..].reverse();
    }
}

/// Position at fraction `f` of the length of edge `e`.
pub(crate) fn point_on_edge(g: &WalkGraph, e: u32, f: f32) -> LatLon {
    let pts = g.edge_geom(e);
    if pts.len() < 2 || f <= 0.0 {
        return pts.first().copied().unwrap_or(LatLon::NONE);
    }
    if f >= 1.0 {
        return pts[pts.len() - 1];
    }
    let total: f32 = pts.windows(2).map(|w| w[0].dist_m(&w[1])).sum();
    let mut left = f * total;
    for w in pts.windows(2) {
        let l = w[0].dist_m(&w[1]);
        if left <= l {
            return w[0].lerp(&w[1], if l > 0.0 { left / l } else { 0.0 });
        }
        left -= l;
    }
    pts[pts.len() - 1]
}

fn vertical_dir(ed: &WalkEdge, rev: bool, l0: Level2, l1: Level2) -> Dir {
    if ed.flags & EF_UP_AB != 0 {
        if rev {
            Dir::Down
        } else {
            Dir::Up
        }
    } else if ed.flags & EF_UP_BA != 0 {
        if rev {
            Dir::Up
        } else {
            Dir::Down
        }
    } else if l0 != LEVEL_NONE && l1 != LEVEL_NONE && l0 != l1 {
        if l1 > l0 {
            Dir::Up
        } else {
            Dir::Down
        }
    } else {
        Dir::Unknown
    }
}

pub(crate) fn build(r: &WalkRouter, from: &Snap, to: &Snap, profile: &WalkProfile, legs: &[Leg]) -> WalkPath {
    let g = &**r.graph();
    let mut geometry: Vec<LatLon> = vec![from.pos];
    let mut levels: Vec<Level2> = vec![LEVEL_NONE];
    let mut pieces: Vec<Piece> = Vec::with_capacity(legs.len());
    let mut cum: Vec<f32> = Vec::new();
    let mut pts: Vec<(LatLon, f32)> = Vec::new();
    let mut cost = WalkCost { var_m: 0.0, fix_s: 0.0 };
    let (mut dist_m, mut up, mut down) = (0f32, 0f32, 0f32);
    let (mut climb_m, mut descent_m) = (0f32, 0f32);
    let slopes = (g.slopes.len() == g.edges.len()).then_some(&g.slopes);

    for leg in legs {
        cost.var_m += leg.var_m;
        cost.fix_s += leg.fix_s;
        let leg_cost = WalkCost { var_m: leg.var_m, fix_s: leg.fix_s };
        if leg.edge == NO_EDGE {
            // Stepping into the lift: the same spot appears twice so that the
            // vertex before the ride and the one after can carry two levels.
            let v0 = geometry.len() as u32 - 1;
            let jump = leg.cls & C_KIND == K_JUMP;
            if jump || leg.cls & C_KIND == K_BOARD {
                let p = geometry[v0 as usize];
                geometry.push(p);
                levels.push(LEVEL_NONE);
            }
            pieces.push(Piece {
                cat: if jump { Cat::Jump } else { Cat::Lift },
                edge: NO_EDGE,
                cls: leg.cls,
                kind: EdgeKind::Lift,
                flags: 0,
                name: 0,
                dist: 0.0,
                cost: leg_cost,
                l0: LEVEL_NONE,
                l1: LEVEL_NONE,
                v0,
                v1: geometry.len() as u32 - 1,
                end_node: leg.end_node,
                steps: 0.0,
            });
            continue;
        }
        let ed = &r.net.edge_view(g, leg.edge);
        let rev = leg.f0 > leg.f1;
        let scale = (leg.f1 - leg.f0).abs();
        let d = leg.len_m;
        dist_m += d;
        if let Some(sl) = slopes {
            let (u, dn) = sl[leg.edge as usize].climb(rev);
            climb_m += u * scale;
            descent_m += dn * scale;
        }
        pts.clear();
        edge_slice(g, leg.edge, leg.f0, leg.f1, &mut cum, &mut pts);
        let v0 = geometry.len() as u32 - 1;
        for (i, &(p, f)) in pts.iter().enumerate() {
            let l = level_at(ed, f);
            if i == 0 {
                // Shared with the end of the previous leg.
                if levels[v0 as usize] == LEVEL_NONE {
                    levels[v0 as usize] = l;
                }
            } else {
                geometry.push(p);
                levels.push(l);
            }
        }
        let v1 = geometry.len() as u32 - 1;
        let (l0, l1) = (level_at(ed, leg.f0), level_at(ed, leg.f1));
        let mut steps_n = 0f32;
        let cat = match ed.kind {
            EdgeKind::Steps => {
                let dir = vertical_dir(ed, rev, l0, l1);
                if steps_as_ramp(profile, ed.flags & EF_RAMP != 0) {
                    Cat::Ramp(dir)
                } else {
                    steps_n = ed.steps as f32 * scale;
                    match dir {
                        Dir::Down => down += steps_n,
                        _ => up += steps_n,
                    }
                    Cat::Stairs(dir)
                }
            }
            EdgeKind::Escalator => match vertical_dir(ed, rev, l0, l1) {
                Dir::Unknown => Cat::Walkway,
                dir => Cat::Escalator(dir),
            },
            EdgeKind::Lift => Cat::Lift,
            EdgeKind::Crossing => Cat::Cross,
            EdgeKind::Platform => Cat::Platform,
            _ => {
                if ed.level_a != LEVEL_NONE && ed.level_b != LEVEL_NONE && ed.level_a != ed.level_b {
                    Cat::Ramp(if (ed.level_b > ed.level_a) != rev { Dir::Up } else { Dir::Down })
                } else {
                    Cat::Walk
                }
            }
        };
        pieces.push(Piece { cat, edge: leg.edge, cls: leg.cls, kind: ed.kind, flags: ed.flags, name: ed.name, dist: d, cost: leg_cost, l0, l1, v0, v1, end_node: leg.end_node, steps: steps_n });
    }

    // The path ends exactly where the caller snapped (the cut point computed
    // from the fraction can be a few centimetres off).
    let last = geometry.len() - 1;
    if !to.pos.is_none() && geometry[last].dist_m(&to.pos) < 5.0 {
        geometry[last] = to.pos;
    }

    // An unmapped level change leads from the floor of the way before it to
    // the floor of the way after it.
    let n = pieces.len();
    let mut jumps = 0u32;
    for i in 0..n {
        if pieces[i].cat == Cat::Jump {
            jumps += 1;
            pieces[i].l0 = if i > 0 { pieces[i - 1].l1 } else { LEVEL_NONE };
            pieces[i].l1 = if i + 1 < n { pieces[i + 1].l0 } else { LEVEL_NONE };
        }
    }

    // A lift ride takes its levels from what comes before and after it.
    let mut i = 0;
    while i < n {
        if pieces[i].cat != Cat::Lift {
            i += 1;
            continue;
        }
        let mut j = i;
        while j + 1 < n && pieces[j + 1].cat == Cat::Lift {
            j += 1;
        }
        let known = |l: Level2| l != LEVEL_NONE;
        // The lift edges know their floors best (the importer names them from
        // the lift's own tag); otherwise use the ways before and after.
        let mut l0 = pieces[i..=j].iter().filter(|p| p.edge != NO_EDGE).map(|p| p.l0).next().unwrap_or(LEVEL_NONE);
        let mut l1 = pieces[i..=j].iter().rev().filter(|p| p.edge != NO_EDGE).map(|p| p.l1).next().unwrap_or(LEVEL_NONE);
        if !known(l0) && i > 0 {
            l0 = pieces[i - 1].l1;
        }
        if !known(l1) && j + 1 < n {
            l1 = pieces[j + 1].l0;
        }
        for p in &mut pieces[i..=j] {
            p.l0 = l0;
            p.l1 = l1;
        }
        let (va, vb) = (pieces[i].v0 as usize, pieces[j].v1 as usize);
        if known(l0) {
            levels[va] = l0;
        }
        if vb > va && known(l1) {
            for l in &mut levels[va + 1..=vb] {
                *l = l1;
            }
        }
        i = j + 1;
    }

    let runs = |pred: &dyn Fn(&Cat) -> bool| -> u8 {
        let mut n = 0u32;
        let mut inside = false;
        for p in &pieces {
            let is = pred(&p.cat);
            if is && !inside {
                n += 1;
            }
            inside = is;
        }
        n.min(255) as u8
    };
    let lifts = runs(&|c| *c == Cat::Lift);
    let escalators = runs(&|c| matches!(c, Cat::Escalator(_) | Cat::Walkway));

    let steps = steps::build(g, &geometry, &levels, &pieces);
    let mut covered: Vec<(u32, u32, Cover)> = Vec::new();
    for p in pieces.iter().filter(|p| p.edge != NO_EDGE && p.v1 > p.v0) {
        let Some(c) = Cover::of(p.kind, p.flags) else { continue };
        match covered.last_mut() {
            Some(last) if last.2 == c && last.1 == p.v0 => last.1 = p.v1,
            _ => covered.push((p.v0, p.v1, c)),
        }
    }
    WalkPath { cost, dist_m, climb_m, descent_m, stairs_up: up.round() as u16, stairs_down: down.round() as u16, lifts, escalators, unmapped_level_changes: jumps.min(255) as u8, closed_m: legs.iter().map(|l| l.closed_m).sum(), geometry, levels, steps, covered }
}
