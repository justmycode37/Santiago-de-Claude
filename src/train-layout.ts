// Where a train stands at a platform of a station model: each coach on the track as a stretch from a to b (model
// metres), from the sectors the formation gives each coach (train-formation.ts) and the platform's sectors in the
// model (sectorSpans where the model has them, else the sector points). docs/train-formation.md
//
//   layoutTrain(model, ref, { coaches, sectors }) → TrainLayout | null   (null: the model has no sectors there)
//
// The formation says which sectors a coach is in, not where in them. So the coaches are laid end to end at their
// real lengths and the whole train is slid along the track to where it fits the sectors best (least squares on the
// coaches' sector middles), kept on the platform when it fits. Without coaches (no formation), the stretch of the
// sectors the timetable gives the train is filled with coaches of a usual length.
import { StationRoute } from './station-route.ts';
import type { TrainCoach } from './train-formation.ts';

const COACH_M = 26.5;      // a usual coach (IC2000 26.8 m, EW IV 26.4 m)
const ONE_SECTOR_M = 50;   // a sector's length where the model has only one sector point on the platform
const TRACK_NEAR_M = 14;   // a track this close to the platform edge is the one along it

export interface TrainSector { name: string; s0: number; s1: number; a: XY; b: XY; mid: XY }
export interface TrainCar {
  coach: TrainCoach | null;
  /** Index into the coaches given (-1: a filler, no formation). */
  idx: number;
  /** Along the platform, metres; s0 < s1. */
  s0: number; s1: number;
  /** On the track. */
  a: XY; b: XY;
  /** A driving end (a sloped nose) at a / at b. */
  noseA: boolean; noseB: boolean;
}
export interface TrainLayout {
  /** A train from its formation or the timetable's sectors; a tram or bus of a typical shape at its stop. */
  kind: 'train' | 'tram' | 'bus';
  ref: string;
  level: number;
  sectors: TrainSector[];
  cars: TrainCar[];
  /** Unit vector from the track towards the platform (where you stand). */
  side: XY;
  /** The point on the track at s, and the platform edge's direction there. */
  at(s: number): XY;
  dir(s: number): XY;
  /** The track along the platform was not found: the train is drawn along the sector line itself. */
  guessed: boolean;
}

const sub = (a: XY, b: XY): XY => [a[0] - b[0], a[1] - b[1]];
const add = (a: XY, b: XY): XY => [a[0] + b[0], a[1] + b[1]];
const mul = (a: XY, k: number): XY => [a[0] * k, a[1] * k];
const len = (a: XY) => Math.hypot(a[0], a[1]);
/** The nearest point of a polyline; `end`: it is one of the line's two ends (p lies beyond them). */
function nearestOn(line: XY[], p: XY): { q: XY; d: number; end: boolean } {
  let best = { q: line[0], d: Infinity, end: false };
  const n = line.length - 1;
  for (let i = 0; i < n; i++) {
    const a = line[i], ab = sub(line[i + 1], a), L2 = ab[0] * ab[0] + ab[1] * ab[1] || 1e-9;
    const raw = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / L2, t = Math.max(0, Math.min(1, raw));
    const q = add(a, mul(ab, t)), d = len(sub(p, q));
    if (d < best.d) best = { q, d, end: (i === 0 && raw < 0) || (i === n - 1 && raw > 1) };
  }
  return best;
}

/** The platform edge as a polyline with its sectors along it (s = metres from its first point). */
function edgeOf(model: StationModel, key: string): { pts: XY[]; secs: { name: string; s0: number; s1: number }[] } | null {
  const pk = StationRoute.platformKey;
  const spans = (model.sectorSpans || []).filter((s) => pk(s.ref) === key && s.a && s.b);
  if (spans.length) {
    // chain them: each span's b is the next one's a (in either direction)
    const rest = spans.slice();
    const isStart = (s: StationSectorSpan) => !rest.some((o) => o !== s && len(sub(o.b, s.a)) < 1);
    const chain: StationSectorSpan[] = [];
    let cur = rest.find(isStart) || rest[0];
    while (cur) {
      chain.push(cur); rest.splice(rest.indexOf(cur), 1);
      const end = cur.b;
      cur = rest.find((o) => len(sub(o.a, end)) < 1) as StationSectorSpan;
    }
    // what did not chain (gaps between sectors): sorted along the platform after the chain
    chain.push(...rest);
    const pts: XY[] = [], secs: { name: string; s0: number; s1: number }[] = [];
    let s = 0;
    for (const sp of chain) {
      const line = sp.line && sp.line.length >= 2 ? sp.line : [sp.a, sp.b];
      if (pts.length) s += len(sub(line[0], pts[pts.length - 1]));
      const s0 = s;
      line.forEach((p, i) => { if (i) s += len(sub(p, line[i - 1])); pts.push(p); });
      secs.push({ name: sp.name, s0, s1: s });
    }
    return pts.length >= 2 ? { pts: dedupe(pts), secs } : null;
  }
  const marks = (model.sectors || []).filter((s) => pk(s.ref) === key && s.xy);
  if (!marks.length) return null;
  if (marks.length === 1) {
    // one sector: along the platform's track, ONE_SECTOR_M long
    const m = marks[0], t = nearestTrack(model, key, m.xy, null);
    if (!t) return null;
    const d = trackDir(t.line, t.q);
    return { pts: [sub(m.xy, mul(d, ONE_SECTOR_M / 2)), add(m.xy, mul(d, ONE_SECTOR_M / 2))], secs: [{ name: m.name, s0: 0, s1: ONE_SECTOR_M }] };
  }
  // order along the platform: from one end (the mark farthest from the others' middle) outwards
  const mid = mul(marks.reduce((acc, m) => add(acc, m.xy), [0, 0] as XY), 1 / marks.length);
  const end = marks.reduce((f, m) => (len(sub(m.xy, mid)) > len(sub(f.xy, mid)) ? m : f), marks[0]);
  const order = marks.slice().sort((a, b) => len(sub(a.xy, end.xy)) - len(sub(b.xy, end.xy)));
  const c = order.map((m) => m.xy);
  // the polyline through the sector middles, stretched half a gap at either end
  const g0 = mul(sub(c[0], c[1]), 0.5), g1 = mul(sub(c[c.length - 1], c[c.length - 2]), 0.5);
  const pts: XY[] = [add(c[0], g0), ...c, add(c[c.length - 1], g1)];
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + len(sub(pts[i], pts[i - 1])));
  // each sector from halfway to the previous middle to halfway to the next; the end ones out to the stretched ends
  const last = order.length - 1;
  const secs = order.map((m, i) => ({ name: m.name, s0: i === 0 ? acc[0] : (acc[i] + acc[i + 1]) / 2, s1: i === last ? acc[i + 2] : (acc[i + 1] + acc[i + 2]) / 2 }));
  return { pts, secs };
}
function dedupe(pts: XY[]) { return pts.filter((p, i) => !i || len(sub(p, pts[i - 1])) > 0.05); }
function trackDir(line: XY[], q: XY): XY {
  let best = 0, bd = Infinity;
  for (let i = 0; i + 1 < line.length; i++) { const d = nearestOn([line[i], line[i + 1]], q).d; if (d < bd) { bd = d; best = i; } }
  const d = sub(line[best + 1], line[best]);
  return mul(d, 1 / (len(d) || 1));
}
/** The track along this platform near p: one with the platform's number first, else any standard-gauge one. */
function nearestTrack(model: StationModel, key: string, p: XY, level: number | null) {
  const pick = (ts: StationTrack[], within: number) => {
    let best: { q: XY; d: number; line: XY[] } | null = null;
    for (const t of ts) { const n = nearestOn(t.line, p); if (n.d < within && (!best || n.d < best.d)) best = { ...n, line: t.line }; }
    return best;
  };
  const { tagged, all } = tracksOf(model, key, level);
  return pick(tagged, TRACK_NEAR_M * 2) || pick(all, TRACK_NEAR_M);
}
function tracksOf(model: StationModel, key: string, level: number | null) {
  const pk = StationRoute.platformKey;
  const all = (model.tracks || []).filter((t) => t.line && t.line.length >= 2 && t.kind !== 'tram' && (level == null || Math.round(t.level) === Math.round(level)));
  return { tagged: all.filter((t) => t.ref != null && pk(t.ref) === key), all };
}
/** The tracks the train stands on along the whole platform: the ones with its number (a track is often in pieces),
 *  else the one track nearest the platform's middle, so that the train does not jump to another track half way. */
function platformTracks(model: StationModel, key: string, level: number, E: XY[]): XY[][] {
  const { tagged, all } = tracksOf(model, key, level);
  const mid = E[Math.floor(E.length / 2)];
  const near = (ts: StationTrack[], within: number) => ts.filter((t) => E.some((p) => nearestOn(t.line, p).d < within));
  const own = near(tagged, TRACK_NEAR_M * 2);
  if (own.length) return own.map((t) => t.line);
  let best: StationTrack | null = null, bd = TRACK_NEAR_M;
  for (const t of all) { const d = Math.min(...E.map((p) => nearestOn(t.line, p).d), nearestOn(t.line, mid).d); if (d < bd) { bd = d; best = t; } }
  return best ? [best.line] : [];
}

export function layoutTrain(model: StationModel, ref: string, o: { coaches: TrainCoach[] | null; sectors: string[] }): TrainLayout | null {
  const key = StationRoute.platformKey(ref);
  const edge = edgeOf(model, key);
  if (!edge) return null;
  const stop = (model.stops || []).find((s) => s.mode === 'train' && StationRoute.platformKey(s.ref) === key);
  const level = stop && stop.level != null ? stop.level : 0;
  // the track: the nearest point of the platform's track to every point of the edge
  const E = edge.pts, acc = [0];
  for (let i = 1; i < E.length; i++) acc.push(acc[i - 1] + len(sub(E[i], E[i - 1])));
  // the offset across the platform only (along it, a track that ends early would squeeze or stretch the coaches);
  // a point beyond the end of the track takes the others' offset
  const lines = platformTracks(model, key, level, E);
  const normal = (i: number): XY => {
    const d = sub(E[Math.min(E.length - 1, i + 1)], E[Math.max(0, i - 1)]), l = len(d) || 1;
    return [-d[1] / l, d[0] / l];
  };
  const offs: (XY | null)[] = E.map((p, i) => {
    let best: { q: XY; d: number; end: boolean } | null = null;
    for (const l of lines) { const n = nearestOn(l, p); if (!best || n.d < best.d) best = n; }
    if (!best || best.end || best.d > TRACK_NEAR_M * 2) return null;
    const n = normal(i), k = (best.q[0] - p[0]) * n[0] + (best.q[1] - p[1]) * n[1];
    return mul(n, k);
  });
  const found = offs.filter(Boolean) as XY[];
  const guessed = !found.length;
  const mean: XY = found.length ? mul(found.reduce(add, [0, 0] as XY), 1 / found.length) : [0, 0];
  const off = offs.map((x) => x || mean);
  const seg = (s: number) => { let i = 0; while (i < E.length - 2 && acc[i + 1] < s) i++; return i; };
  const at = (s: number): XY => {
    const i = seg(s), L = acc[i + 1] - acc[i] || 1, t = (s - acc[i]) / L;   // beyond the ends: straight on
    return add(add(E[i], mul(sub(E[i + 1], E[i]), t)), add(off[i], mul(sub(off[i + 1], off[i]), Math.max(0, Math.min(1, t)))));
  };
  const dir = (s: number): XY => { const i = seg(s), d = sub(E[i + 1], E[i]); return mul(d, 1 / (len(d) || 1)); };
  const side: XY = len(mean) > 0.3 ? mul(mean, -1 / len(mean)) : (() => { const d = dir(acc[acc.length - 1] / 2); return [-d[1], d[0]] as XY; })();
  const secByName = new Map(edge.secs.map((s) => [s.name.toUpperCase(), s]));
  const sectors: TrainSector[] = edge.secs.map((s) => ({ name: s.name, s0: s.s0, s1: s.s1, a: at(s.s0), b: at(s.s1), mid: at((s.s0 + s.s1) / 2) }));
  const lo = Math.min(...edge.secs.map((s) => s.s0)), hi = Math.max(...edge.secs.map((s) => s.s1));
  const span = (names: string[]) => {
    const ss = names.map((n) => secByName.get(n.toUpperCase())).filter(Boolean) as { s0: number; s1: number }[];
    return ss.length ? [Math.min(...ss.map((x) => x.s0)), Math.max(...ss.map((x) => x.s1))] as [number, number] : null;
  };

  let cars: TrainCar[] = [];
  const coaches = o.coaches || [];
  const target = coaches.map((c) => span(c.sectors));
  if (coaches.length && target.some(Boolean)) {
    // end to end at their lengths (u: the middle of each along the train), then slid to fit the sectors
    const U: number[] = [], mids: number[] = [];
    let u = 0;
    for (const c of coaches) { U.push(u); mids.push(u + c.len / 2); u += c.len; }
    const total = u;
    const pairs = coaches.map((_, i) => target[i] ? [mids[i], (target[i]![0] + target[i]![1]) / 2] : null).filter(Boolean) as [number, number][];
    // which way the formation's order runs along the platform
    const mu = pairs.reduce((t, p) => t + p[0], 0) / pairs.length, mc = pairs.reduce((t, p) => t + p[1], 0) / pairs.length;
    const cov = pairs.reduce((t, p) => t + (p[0] - mu) * (p[1] - mc), 0);
    const sgn = cov < 0 ? -1 : 1;
    let s0 = pairs.reduce((t, p) => t + p[1] - sgn * p[0], 0) / pairs.length;
    // on the platform, when it fits: the train's ends are s0 and s0 + sgn * total
    const a = Math.min(s0, s0 + sgn * total), b = Math.max(s0, s0 + sgn * total);
    if (total <= hi - lo) { if (a < lo) s0 += lo - a; else if (b > hi) s0 -= b - hi; }
    cars = coaches.map((c, i) => {
      const p = s0 + sgn * U[i], q = s0 + sgn * (U[i] + c.len);
      return { coach: c, idx: i, s0: Math.min(p, q), s1: Math.max(p, q), a: at(Math.min(p, q)), b: at(Math.max(p, q)), noseA: false, noseB: false };
    });
  } else {
    const st = span(o.sectors);
    if (!st) return { kind: 'train', ref, level, sectors, cars: [], side, at, dir, guessed };
    const n = Math.max(2, Math.round((st[1] - st[0]) / COACH_M)), L = (st[1] - st[0]) / n;
    for (let i = 0; i < n; i++) {
      const p = st[0] + i * L, q = p + L;
      cars.push({ coach: null, idx: -1, s0: p, s1: q, a: at(p), b: at(q), noseA: false, noseB: false });
    }
  }
  // driving ends: a locomotive has two; else the coach at either end of the train has one
  const sorted = cars.slice().sort((x, y) => x.s0 - y.s0);
  for (const c of sorted) if (c.coach && c.coach.kind === 'loco') c.noseA = c.noseB = true;
  const first = sorted[0], last = sorted[sorted.length - 1];
  if (first && !(first.coach && first.coach.kind === 'loco')) first.noseA = true;
  if (last && !(last.coach && last.coach.kind === 'loco')) last.noseB = true;
  return { kind: 'train', ref, level, sectors, cars: sorted, side, at, dir, guessed };
}

// ------------------------------------------------------------------ a tram or a bus at its stop
// No open data says which vehicle runs or where exactly it stops, so the shape is a typical one (a tram of 36 m in
// four parts, as Bern's, Basel's, Zürich's and Geneva's are 32–43 m; an articulated bus of 18 m), with its front at
// the stop, along the direction it travels: a tram on the nearest tram track, a bus on the road beside the stop (the
// stop on its right, as traffic keeps right). Without that direction it is not drawn: front and back cannot be told.
const VEHICLE: Record<'tram' | 'bus', number[]> = { tram: [9, 9, 9, 9], bus: [11, 7] };
export interface StopPose { uic: string; ref: string; ll: LngLat | null; heading: number | null; level?: number | null }
export function layoutAtStop(model: StationModel, kind: 'tram' | 'bus', o: StopPose): TrainLayout | null {
  const pk = StationRoute.platformKey;
  const stops = (model.stops || []).filter((s) => String(s.uic) === String(o.uic) && s.mode !== 'train');
  const stop = stops.find((s) => o.ref && pk(s.ref) === pk(o.ref)) || (o.ll ? null : stops[0])
    || (o.ll ? stops.slice().sort((a, b) => len(sub(a.xy, StationRoute.toLocal(model, o.ll!))) - len(sub(b.xy, StationRoute.toLocal(model, o.ll!))))[0] : null);
  const pole: XY | null = stop && stop.xy ? stop.xy : o.ll ? StationRoute.toLocal(model, o.ll) : null;
  if (!pole || o.heading == null) return null;
  const level = stop && stop.level != null ? stop.level : o.level != null ? o.level : 0;
  const h: XY = [Math.sin(o.heading * Math.PI / 180), Math.cos(o.heading * Math.PI / 180)];
  let front: XY, dir: XY = h, guessed = false;
  const rails = kind === 'tram' ? (model.tracks || []).filter((t) => (t.kind === 'tram' || t.kind === 'light_rail') && Math.abs(t.level - level) < 0.6) : [];
  let best: { q: XY; d: number; line: XY[] } | null = null;
  for (const t of rails) { const n = nearestOn(t.line, pole); if (n.d < 12 && (!best || n.d < best.d)) best = { q: n.q, d: n.d, line: t.line }; }
  if (best) {
    const d = trackDir(best.line, best.q);
    dir = d[0] * h[0] + d[1] * h[1] >= 0 ? d : mul(d, -1);
    front = best.q;
  } else {
    // the bus (or a tram whose track the model does not have) in the lane beside the stop
    front = add(pole, mul([-h[1], h[0]], 1.7));
    guessed = kind === 'tram';
  }
  const parts = VEHICLE[kind], L = parts.reduce((a, b) => a + b, 0);
  // a stop the length of a vehicle or more (its walkway nodes): the front at its leading end
  const ns = stop && Array.isArray(stop.nodes) ? stop.nodes.map((n) => model.graph.nodes[n]).filter(Boolean) : [];
  if (ns.length > 1) {
    const proj = ns.map((p) => (p[0] - pole[0]) * dir[0] + (p[1] - pole[1]) * dir[1]);
    const hi = Math.max(...proj), lo = Math.min(...proj);
    if (hi - lo >= 10) front = add(front, mul(dir, hi));
  }
  const at = (s: number): XY => add(front, mul(dir, s - L));
  const side: XY = [dir[1], -dir[0]];   // the stop: on the vehicle's right
  const cars: TrainCar[] = [];
  let s = 0;
  parts.forEach((m, i) => {
    cars.push({ coach: null, idx: -1, s0: s, s1: s + m, a: at(s), b: at(s + m), noseA: kind === 'tram' && i === 0, noseB: kind === 'tram' && i === parts.length - 1 });
    s += m;
  });
  return { kind, ref: o.ref, level, sectors: [], cars, side, at, dir: () => dir, guessed };
}
