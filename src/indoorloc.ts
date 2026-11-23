// Indoor positioning in stations: which floor you are on and where, from the phone's sensors and the station 3D
// model (stations3d/<key>.js, format in stations3d/SCHEMA.md; drawn by the station view, routed by station-route.ts).
// indoornav.ts ties it to the app: it feeds the estimate to Station3D.setUser({ xy, level, accuracy, heading }).
//
// Four parts, usable on their own (no DOM needed except for Sensors, so the filter runs in Node for tests):
//   Model    the station model as the filter needs it: the walking graph with each node's floor and height,
//            stairs / escalators / lifts / ramps between floors, a spatial index, and the landmarks a sign can name
//            (platforms, sector signs, entrances, named halls and underpasses, shops, services).
//   Filter   a particle filter whose particles live ON the walking network. A particle can only change floor by
//            moving along a stair, escalator or lift edge, so a floor change needs a connector nearby: this is
//            what makes a lone pressure jump (a train pushing air through an underground station, a door, the
//            ventilation) unable to move you to another floor by itself. Evidence it uses, all optional:
//              steps + heading (pedestrian dead reckoning), time (escalators carry you without steps; a lift
//              moves you while you stand), GPS (weak indoors, heavy-tailed), relative barometric height (only
//              from a native wrapper: no browser exposes the barometer), signs / landmarks read by the camera
//              (signloc.ts), the journey (you got off at platform 32), and a floor or spot the user picks.
//            It keeps several hypotheses (e.g. two floors) until the evidence separates them, and says so: the
//            estimate has `confident: false` and per-floor probabilities rather than a made-up answer.
//   Sensors  browser adapter: step detection (DeviceMotion), heading from the gyro corrected by the compass
//            (DeviceOrientation), GPS, an optional pressure source (Capacitor barometer plugin or
//            INDOORLOC.pushPressure), permission requests on a tap (iOS), and screen-lock gaps.
//   Recorder raw sensor log with user checkpoints ("I am here"), exported as JSON and replayed through the Filter,
//            so the filter can be tuned on real walks in real stations, not only on simulations.
// ================================================================================================ Model
// The station 3D model (stations3d/<key>.js, format in stations3d/SCHEMA.md, built by tools/build_station3d.py)
// seen as the filter needs it: the walking graph with each node's floor and height, a spatial index of the edges,
// and the landmarks a sign can name. Routing stays with station-route.ts (StationRoute).
import { SIGNLOC } from './signloc.ts';
const KIND: StationEdgeKind[] = ['walk', 'stairs', 'escalator', 'elevator', 'ramp'];
const KIND_ID = { walk: 0, stairs: 1, escalator: 2, elevator: 3, ramp: 4 };
const F_INDOOR = 1, F_ONEWAY = 2, F_NOT_STEPFREE = 4, F_OUTDOOR = 8;

// closures as in SCHEMA.md: closed when from <= today < until
/** Closed when from <= today < until (today: "YYYY-MM-DD"). */
function isClosed(c: StationClosure | null | undefined, today?: string | null) {
  if (!c) return false;
  const d = today || new Date().toISOString().slice(0, 10);
  return (!c.from || c.from <= d) && (!c.until || d < c.until);
}

function Model(this: IndoorModel, m: StationModel, opts: IndoorModelOptions = {}) {
  if (!(this instanceof Model)) return new (Model as IndoorParts['Model'])(m, opts);
  this.raw = m;
  this.key = m.key; this.name = m.name; this.uics = m.uics || [];
  this.origin = m.origin;
  // same frame as SCHEMA.md / station-route.ts: x = (lng - lng0) * 111320 * cos(lat0), y = (lat - lat0) * 110540
  this.mx = 111320 * Math.cos(m.origin[1] * Math.PI / 180); this.my = 110540;
  // h: height relative to level 0 (m); sh: how sure (± m). The models' heights are measured (swisstopo, survey
  // points) or estimated where nothing could be measured; SCHEMA.md does not say which, so ±0.5 m by default.
  this.levels = m.levels.slice().sort((a, b) => a.id - b.id).map((l) => ({ id: l.id, h: l.z, sh: l.sh != null ? l.sh : 0.5, name: l.name || '' }));
  this.levelIndex = new Map(this.levels.map((l, i) => [l.id, i]));
  const today = opts.date || null;
  const nodes = m.graph.nodes;
  const n = nodes.length;
  this.n = n;
  this.x = new Float64Array(n); this.y = new Float64Array(n); this.lv = new Float64Array(n);
  this.li = new Int16Array(n); this.z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [x, y, level] = nodes[i];
    this.x[i] = x; this.y[i] = y; this.lv[i] = level;
    this.z[i] = this.zOf(level);
    this.li[i] = this.floorOf(level);
  }
  const edges = m.graph.edges.filter((e) => !isClosed(e.closed, today));
  const ne = edges.length;
  this.ne = ne;
  this.ea = new Int32Array(ne); this.eb = new Int32Array(ne); this.ek = new Int8Array(ne); this.ef = new Int8Array(ne);
  this.elen = new Float64Array(ne); this.ebear = new Float64Array(ne);
  this.out = Array.from({ length: n }, () => []);   // edges you can leave a node by: [edge, +1 (a→b) | -1 (b→a)]
  edges.forEach((E, e) => {
    const a = E.a, c = E.b, k = KIND_ID[E.kind] ?? 0;
    this.ea[e] = a; this.eb[e] = c; this.ek[e] = k;
    let f = E.outdoor ? F_OUTDOOR : F_INDOOR;
    if (E.oneway) f |= F_ONEWAY;
    if (k === 1 || k === 2 || E.wheelchair === false) f |= F_NOT_STEPFREE;
    this.ef[e] = f;
    const dx = this.x[c] - this.x[a], dy = this.y[c] - this.y[a];
    // walking distance: along the slope on stairs and ramps; a lift has none (time moves you there)
    this.elen[e] = Math.max(0.05, k === 3 ? 0.05 : Math.hypot(E.len != null ? E.len : Math.hypot(dx, dy), (k === 1 || k === 4) ? this.z[c] - this.z[a] : 0));
    this.ebear[e] = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    this.out[a].push([e, 1]);
    if (!(f & F_ONEWAY)) this.out[c].push([e, -1]);
  });
  // spatial grid of edges per floor (10 m cells)
  this.cell = 10;
  this.grid = new Map();
  for (let e = 0; e < ne; e++) {
    const a = this.ea[e], c = this.eb[e];
    const lis = this.li[a] === this.li[c] ? [this.li[a]] : [this.li[a], this.li[c]];
    const x0 = Math.min(this.x[a], this.x[c]), x1 = Math.max(this.x[a], this.x[c]);
    const y0 = Math.min(this.y[a], this.y[c]), y1 = Math.max(this.y[a], this.y[c]);
    for (const l of lis)
      for (let gx = Math.floor(x0 / this.cell); gx <= Math.floor(x1 / this.cell); gx++)
        for (let gy = Math.floor(y0 / this.cell); gy <= Math.floor(y1 / this.cell); gy++) {
          const k = l + ':' + gx + ':' + gy;
          if (!this.grid.has(k)) this.grid.set(k, []);
          this.grid.get(k)!.push(e);
        }
  }
  this.landmarks = landmarksOf(m, this, today);
}
// height (m, relative to level 0) of a level number, fractional levels included (piecewise linear, as SCHEMA.md)
(Model.prototype as IndoorModel).zOf = function (level: number) {
  const L = this.levels;
  if (level <= L[0].id) return L[0].h + (level - L[0].id) * 4.5;
  for (let i = 1; i < L.length; i++) {
    if (level <= L[i].id) { const a = L[i - 1], b = L[i]; return a.h + (b.h - a.h) * (level - a.id) / (b.id - a.id); }
  }
  const t = L[L.length - 1];
  return t.h + (level - t.id) * 4.5;
};
// the floor (index into levels) a level number belongs to: the nearest whole level
(Model.prototype as IndoorModel).floorOf = function (level: number) {
  let best = 0;
  for (let i = 1; i < this.levels.length; i++) if (Math.abs(this.levels[i].id - level) < Math.abs(this.levels[best].id - level)) best = i;
  return best;
};
(Model.prototype as IndoorModel).levelId = function (li: number) { return this.levels[li] ? this.levels[li].id : null; };
(Model.prototype as IndoorModel).toLngLat = function (x: number, y: number): LngLat { return [this.origin[0] + x / this.mx, this.origin[1] + y / this.my]; };
(Model.prototype as IndoorModel).fromLngLat = function (lon: number, lat: number): XY { return [(lon - this.origin[0]) * this.mx, (lat - this.origin[1]) * this.my]; };
(Model.prototype as IndoorModel).kind = function (e: number) { return KIND[this.ek[e]]; };
// point on edge e at distance s from its a end
(Model.prototype as IndoorModel).at = function (e: number, s: number): IndoorEdgePoint {
  const a = this.ea[e], c = this.eb[e];
  const t = Math.min(1, Math.max(0, s / this.elen[e]));
  const level = this.lv[a] + (this.lv[c] - this.lv[a]) * t;
  return {
    x: this.x[a] + (this.x[c] - this.x[a]) * t, y: this.y[a] + (this.y[c] - this.y[a]) * t,
    z: this.z[a] + (this.z[c] - this.z[a]) * t, level, li: t < 0.5 ? this.li[a] : this.li[c], t,
  };
};
// closest point on edge e to (x, y): { d, s }
(Model.prototype as IndoorModel).project = function (e: number, x: number, y: number) {
  const a = this.ea[e], c = this.eb[e];
  const ax = this.x[a], ay = this.y[a], dx = this.x[c] - ax, dy = this.y[c] - ay;
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
  return { d: Math.hypot(ax + dx * t - x, ay + dy * t - y), s: t * this.elen[e] };
};
// edges within r metres of (x, y) on floor li (null: every floor) → [{ e, d, s }], nearest first
(Model.prototype as IndoorModel).nearEdges = function (x: number, y: number, li: number | null | undefined, r: number) {
  const out: IndoorEdgeHit[] = [], seen = new Set<number>();
  const lis = li == null ? this.levels.map((_, i) => i) : [li];
  for (const l of lis)
    for (let gx = Math.floor((x - r) / this.cell); gx <= Math.floor((x + r) / this.cell); gx++)
      for (let gy = Math.floor((y - r) / this.cell); gy <= Math.floor((y + r) / this.cell); gy++) {
        const list = this.grid.get(l + ':' + gx + ':' + gy);
        if (!list) continue;
        for (const e of list) {
          if (seen.has(e)) continue;
          seen.add(e);
          const p = this.project(e, x, y);
          if (p.d <= r) out.push({ e, d: p.d, s: p.s });
        }
      }
  return out.sort((p, q) => p.d - q.d);
};
(Model.prototype as IndoorModel).nearestOnLevel = function (x: number, y: number, li: number | null | undefined, r = 60) {
  for (const rr of [5, 15, r]) {
    const list = this.nearEdges(x, y, li, rr).filter((c) => li == null || (this.li[this.ea[c.e]] === li || this.li[this.eb[c.e]] === li));
    if (list.length) return list[0];
  }
  return null;
};

// What a sign can name, each on its floor: [{ li, x, y, kind, text, extra }]
//   platform (stop ref) · sector ("7:BC", the letters on a sector sign or a sector centre) · exit (named entrance)
//   passage (a named floor or plaza: "Main underpass", "Welle") · shop / amenity (named rooms and points of interest)
function landmarksOf(m: StationModel, M: IndoorModel, today: string | null) {
  const out: IndoorLandmark[] = [];
  const li = (level: number) => M.floorOf(level);
  const centre = (ring: XY[]): XY => {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
    }
    return a ? [cx / (3 * a), cy / (3 * a)] : ring[0];
  };
  const stopLevel = new Map<string, number>();
  for (const s of m.stops || []) {
    if (isClosed(s.closed, today) || !s.ref) continue;
    out.push({ li: li(s.level), x: s.xy[0], y: s.xy[1], kind: 'platform', text: String(s.ref), extra: s.mode || '', node: s.node });
    stopLevel.set(String(s.ref), s.level);
  }
  const signs = (m.props || []).filter((p) => p.kind === 'sector-sign');
  for (const p of signs) out.push({ li: li(p.level), x: p.xy[0], y: p.xy[1], kind: 'sector', text: `${p.ref}:${String(p.name || '').replace(/[^A-Z]/gi, '')}`, extra: p.mount || '' });
  if (!signs.length)
    for (const s of m.sectors || []) out.push({ li: li(stopLevel.get(String(s.ref)) || 0), x: s.xy[0], y: s.xy[1], kind: 'sector', text: `${s.ref}:${s.name}`, extra: 'centre' });
  for (const e of m.entrances || []) if (e.name && !isClosed(e.closed, today)) out.push({ li: li(e.level), x: e.xy[0], y: e.xy[1], kind: 'exit', text: e.name, extra: '' });
  (m.areas || []).forEach((a, ai) => {
    if (!a.name || a.kind === 'platform' || isClosed(a.closed, today)) return;
    const [x, y] = centre(a.ring);
    const kind = a.kind === 'room' ? 'shop' : 'passage', group = 'area:' + ai;
    out.push({ li: li(a.level), x, y, kind, text: a.name, extra: a.kind, group });
    // a long underpass or a big hall: its name can be read anywhere along it, so add points spread through it
    // (corners pulled a third of the way in, at least 25 m apart)
    if (kind !== 'passage') return;
    const pts = [[x, y]];
    for (const [vx, vy] of a.ring) {
      const q = [vx + (x - vx) / 3, vy + (y - vy) / 3];
      if (pts.every((r) => Math.hypot(r[0] - q[0], r[1] - q[1]) >= 25)) pts.push(q);
      if (pts.length >= 12) break;
    }
    for (const q of pts.slice(1)) out.push({ li: li(a.level), x: q[0], y: q[1], kind, text: a.name, extra: a.kind, group });
  });
  for (const p of m.pois || []) if (p.name) out.push({ li: li(p.level), x: p.xy[0], y: p.xy[1], kind: 'amenity', text: p.name, extra: p.kind });
  for (const p of m.props || []) if (p.kind === 'clock' || p.kind === 'ticket-machine' || p.kind === 'meeting-point') out.push({ li: li(p.level), x: p.xy[0], y: p.xy[1], kind: 'prop', text: p.name || '', extra: p.kind });
  return out;
}

// ================================================================================================ Filter
// A small, seedable random generator, so simulations and replays are repeatable
function rng(seed: number): IndoorRandom {
  let s = (seed >>> 0) || 0x9e3779b9;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  next.gauss = () => { let u = 0, v = 0; while (u === 0) u = next(); while (v === 0) v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  return next;
}
const angDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180;
const HPA_TO_M = 8.43 * 1013.25 / 960; // m per hPa near 960 hPa (Swiss lowlands, ~400–550 m)

const DEFAULTS = {
  particles: 1500,
  stepLength: 0.7, stepSigma: 0.12,          // m, per step; per-particle scale is learnt
  headingSigma: 30,                          // deg: how far the measured walking heading may be from the path
  escalatorSpeed: 0.5,                       // m/s along the escalator when standing on it
  liftSpeed: 1.0,                            // m/s vertical
  liftRate: 0.08,                            // per second: chance a particle at a lift starts a ride while you stand
  baroSigma: 1.2,                            // m, height mismatch tolerated (plus the level's own height uncertainty)
  baroOutlier: 0.05,                         // floor of the barometer likelihood (robust to piston/door jumps)
  baroJump: 2.5,                             // m/s: faster height changes than this are not people moving: ignored
  gpsMinSigma: 12, gpsOutlier: 0.15,
  resampleEss: 0.5,
};

/** The filter with what only this file reads and writes. */
interface FilterSelf extends IndoorFilter {
  o: typeof DEFAULTS & IndoorFilterOptions;
  rand: IndoorRandom;
  baro: { z0: number } | null;
  lastBaro: null;
  lastBaroZ?: number | null;
  lastBaroT?: number | null;
  baroHold?: { until: number; z0: number } | null;
  baroHist?: { t: number; z: number }[];
  still: number;
  listeners: ((est: IndoorEstimate) => void)[];
  lastEvidence: IndoorEvidence;
  lastGpsT?: number | null;
  gpsMiss?: number;
  wSlow?: number | null;
  wFast?: number | null;
  /** Running sum of the edges' lengths. */
  _cum?: Float64Array;
  _last?: IndoorEstimateTracking;
  _emit(): IndoorEstimate;
  _spawn(i: number, cand: IndoorEdgePlace[] | null): void;
  _move(i: number, dist: number, heading: number | null, sigma: number, allowVertical?: boolean): number;
  _time(dt: number): void;
  _advance(t?: number | null): void;
  _recover(lik: number): void;
  _gpsFloor(e: number, p: IndoorEdgePoint, acc: number): number;
  _inject(cands: IndoorCandidate[], frac: number, w?: number | null): void;
  _normalise(why: string): void;
  _resample(): void;
}

function Filter(this: FilterSelf, model: IndoorModel, opts: IndoorFilterOptions = {}) {
  if (!(this instanceof Filter)) return new (Filter as IndoorParts['Filter'])(model, opts);
  this.M = model;
  this.o = Object.assign({}, DEFAULTS, opts);
  this.rand = rng(opts.seed || Date.now());
  const N = this.o.particles;
  this.N = N;
  this.e = new Int32Array(N);      // edge
  this.s = new Float64Array(N);    // metres from the edge's a end
  this.d = new Int8Array(N);       // direction of travel along the edge: +1 a→b, -1 b→a
  this.k = new Float64Array(N);    // step length scale
  this.hb = new Float64Array(N);   // heading bias (compass offset, phone held askew)
  this.bo = new Float64Array(N);   // barometer offset (m)
  this.ride = new Float64Array(N); // >0: riding a lift/escalator for this many more seconds
  this.w = new Float64Array(N).fill(1 / N);
  this.t = null;                   // time of the last update (s)
  this.baro = null;                // { z0 } reference for relative height
  this.lastBaro = null;
  this.still = 0;                  // seconds without steps
  this.initialised = false;
  this.listeners = [];
  this.lastEvidence = {};
}

(Filter.prototype as FilterSelf).on = function (fn: (est: IndoorEstimate) => void) { this.listeners.push(fn); return this; };
(Filter.prototype as FilterSelf)._emit = function () { const est = this.estimate(); for (const f of this.listeners) f(est); return est; };

// spread particles over edges, weighted by length (optionally near a point / on given levels)
(Filter.prototype as FilterSelf)._spawn = function (i: number, cand: IndoorEdgePlace[] | null) {
  const R = this.rand;
  let e, s;
  if (cand && cand.length) {
    const c = cand[Math.floor(R() * cand.length)];
    e = c.e; s = Math.min(this.M.elen[e], Math.max(0, c.s + (R() - 0.5) * 4));
  } else {
    // whole network, by length
    if (!this._cum) { this._cum = new Float64Array(this.M.ne); let a = 0; for (let j = 0; j < this.M.ne; j++) { a += this.M.elen[j]; this._cum[j] = a; } }
    const r = R() * this._cum[this.M.ne - 1];
    let lo = 0, hi = this.M.ne - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this._cum[mid] < r) lo = mid + 1; else hi = mid; }
    e = lo; s = R() * this.M.elen[e];
  }
  this.e[i] = e; this.s[i] = s; this.d[i] = R() < 0.5 ? 1 : -1;
  if (this.M.ef[e] & F_ONEWAY) this.d[i] = 1;
  this.k[i] = 1 + 0.12 * R.gauss();
  this.hb[i] = 8 * R.gauss();
  this.ride[i] = 0;
  // a particle placed on another floor (sign, GPS, recovery) must not inherit the old one's barometer offset
  this.bo[i] = this.baro && this.lastBaroZ != null ? this.lastBaroZ - this.M.at(e, s).z : 0;
};
// Start (or restart) from what is known: { x, y, r, levels: [li] } or nothing (anywhere in the station)
(Filter.prototype as FilterSelf).init = function (where: IndoorWhere = {}) {
  let cand: IndoorEdgePlace[] | null = null;
  if (where.x != null) {
    const r = where.r || 20;
    const lis = where.levels && where.levels.length ? where.levels : null;
    cand = [];
    for (const li of lis || [null]) cand.push(...this.M.nearEdges(where.x, where.y!, li, r));
    if (!cand.length) cand = null;
  } else if (where.levels && where.levels.length) {
    const set = new Set(where.levels);
    cand = [];
    // by length: one candidate per 5 m of edge
    for (let e = 0; e < this.M.ne; e++) if (set.has(this.M.li[this.M.ea[e]])) for (let k = 0; k < Math.max(1, Math.ceil(this.M.elen[e] / 5)); k++) cand.push({ e, s: this.M.elen[e] * this.rand() });
  }
  this.baro = null; this.lastBaro = null; this.lastBaroZ = null; this.lastBaroT = null; this.baroHold = null; this.baroHist = [];
  this.lastGpsT = null; this.gpsMiss = 0; this.wSlow = null; this.wFast = null; this.lastEvidence = {}; this.still = 0;
  for (let i = 0; i < this.N; i++) this._spawn(i, cand);
  this.w.fill(1 / this.N);
  this.bo.fill(0);
  this.initialised = true;
  return this._emit();
};

// ------------------------------------------------------------------------ motion
// Move particle i by dist metres along the network, choosing at junctions the way that best fits `heading`
// (null: no heading, keep as straight as possible). Returns how well the path fit the heading (0…1).
(Filter.prototype as FilterSelf)._move = function (i: number, dist: number, heading: number | null, sigma: number, allowVertical = true) {
  const M = this.M, R = this.rand;
  let e = this.e[i], s = this.s[i], d = this.d[i], fit = 1, guard = 0;
  if (M.ek[e] === 3) {
    // walking out of a lift: from the stop it is at (a lift edge has no direction on the ground)
    d = s > M.elen[e] / 2 ? 1 : -1;
    this.ride[i] = 0;
  } else if (heading != null) {
    // turn around on the current edge if the heading says so
    const bear = d > 0 ? M.ebear[e] : (M.ebear[e] + 180) % 360;
    if (Math.abs(angDiff(heading + this.hb[i], bear)) > 100 && !(M.ef[e] & F_ONEWAY)) d = -d;
  }
  while (dist > 1e-6 && guard++ < 50) {
    const L = M.elen[e];
    const left = d > 0 ? L - s : s;
    const kind = M.ek[e];
    // steps on an escalator still move you, at the escalator's pace plus yours
    if (dist <= left) { s += d * dist; dist = 0; break; }
    dist -= left;
    const node = d > 0 ? M.eb[e] : M.ea[e];
    // next edge: by heading (or straight on), never back the way we came unless it is a dead end
    const opts = M.out[node].filter(([f]) => f !== e && (allowVertical || M.li[M.ea[f]] === M.li[M.eb[f]]));
    if (!opts.length) { d = -d; s = d > 0 ? 0 : L; fit *= 0.1; continue; } // dead end: you would have to turn back
    const cur = d > 0 ? M.ebear[e] : (M.ebear[e] + 180) % 360;
    let tot = 0;
    const ws = opts.map(([f, fd]) => {
      const b = fd > 0 ? M.ebear[f] : (M.ebear[f] + 180) % 360;
      const ref = heading != null ? heading + this.hb[i] : cur;
      const sg = heading != null ? sigma : 50;
      const dd = M.ek[f] === 3 ? 0 : angDiff(ref, b);
      // lifts are entered when standing still (time update), not by walking into them
      const w = (M.ek[f] === 3 ? 0.02 : 1) * Math.exp(-dd * dd / (2 * sg * sg)) + 1e-4;
      tot += w;
      return w;
    });
    let r = R() * tot, j = 0;
    while (r > ws[j] && j < ws.length - 1) { r -= ws[j]; j++; }
    if (heading != null) fit *= Math.min(1, ws[j] * 1.2);
    const [f, fd] = opts[j];
    e = f; d = fd; s = fd > 0 ? 0 : M.elen[f];
    void kind;
  }
  this.e[i] = e; this.s[i] = s; this.d[i] = d;
  return fit;
};

// Time passes (s seconds): escalators carry particles that are on them, lifts take particles that wait at them
(Filter.prototype as FilterSelf)._time = function (dt: number) {
  if (!(dt > 0)) return;
  const M = this.M, R = this.rand, o = this.o;
  this.still += dt;
  for (let i = 0; i < this.N; i++) {
    const e = this.e[i];
    const k = M.ek[e];
    if (k === 2) {
      // escalator: carried along its running direction
      const dir = (M.ef[e] & F_ONEWAY) ? 1 : this.d[i];
      this.d[i] = dir;
      this._move(i, o.escalatorSpeed * dt, null, 50);
    } else if (k === 3) {
      // a lift: riding (ride > 0) until the next stop, then on to the next floor or stopped there; stopped and
      // still waiting, it may set off again
      if (!(this.ride[i] > 0)) {
        if (this.still > 4 && R() < o.liftRate * dt) { this.ride[i] = 1; this.d[i] = R() < 0.5 ? 1 : -1; }
        continue;
      }
      const dz = Math.abs(M.z[M.ea[e]] - M.z[M.eb[e]]) || 4;
      this.s[i] += this.d[i] * M.elen[e] * (o.liftSpeed * dt / dz);
      if (this.s[i] <= 0 || this.s[i] >= M.elen[e]) {
        const node = this.s[i] <= 0 ? M.ea[e] : M.eb[e];
        const next = M.out[node].filter(([f]) => M.ek[f] === 3 && f !== e);
        if (next.length && R() < 0.5) { const [f, fd] = next[Math.floor(R() * next.length)]; this.e[i] = f; this.d[i] = fd; this.s[i] = fd > 0 ? 0 : M.elen[f]; }
        else { this.s[i] = Math.min(M.elen[e], Math.max(0, this.s[i])); this.ride[i] = 0; }
      }
    } else if (this.still > 4) {
      // standing still next to a lift: some particles take it (they are tested by the barometer, signs, …)
      const node = this.s[i] < 3 ? M.ea[e] : (M.elen[e] - this.s[i] < 3 ? M.eb[e] : -1);
      if (node >= 0 && R() < o.liftRate * dt) {
        const lifts = M.out[node].filter(([f]) => M.ek[f] === 3);
        if (lifts.length) { const [f, fd] = lifts[Math.floor(R() * lifts.length)]; this.e[i] = f; this.d[i] = fd; this.s[i] = fd > 0 ? 0 : M.elen[f]; this.ride[i] = 1; }
      }
    }
    // baro offset drifts slowly (weather, ventilation): ~0.3 m per minute
    this.bo[i] += 0.04 * Math.sqrt(dt) * R.gauss();
  }
};

(Filter.prototype as FilterSelf)._advance = function (t?: number | null) {
  if (t == null) return;
  if (this.t != null && t > this.t) this._time(Math.min(t - this.t, 30));
  if (this.t == null || t > this.t) this.t = t;
};

// ------------------------------------------------------------------------ evidence
// a step was taken: { t, length?, heading? (deg, walking direction), headingSigma? }
(Filter.prototype as FilterSelf).step = function (ev: IndoorStep) {
  // nothing known yet (no GPS fix, journey or sign): a step alone cannot place you
  if (!this.initialised) return this.estimate();
  this._advance(ev.t);
  this.still = 0;
  const o = this.o, R = this.rand;
  const L = ev.length || o.stepLength;
  const heading = Number.isFinite(ev.heading) ? ev.heading! : null;
  const sg = ev.headingSigma || o.headingSigma;
  let lik = 0;
  for (let i = 0; i < this.N; i++) {
    const dist = Math.max(0.2, L * this.k[i] + o.stepSigma * R.gauss());
    const fit = this._move(i, dist, heading, sg);
    let m = 1;
    if (heading != null) {
      // how well the particle's direction of travel fits the measured heading; the floor keeps a burst of
      // magnetic disturbance (trains, steel) from wiping out the right particles
      const e = this.e[i];
      const bear = this.d[i] > 0 ? this.M.ebear[e] : (this.M.ebear[e] + 180) % 360;
      const dd = this.M.ek[e] === 3 ? 0 : angDiff(heading + this.hb[i], bear);
      m = 0.1 + Math.exp(-dd * dd / (2 * sg * sg)) * (0.2 + 0.8 * fit);
    } else m = 0.3 + 0.7 * fit;
    if (ev.stairs != null) {
      const e = this.e[i];
      const onStairs = (this.M.ek[e] === 1 || this.M.ek[e] === 2) && this.M.li[this.M.ea[e]] !== this.M.li[this.M.eb[e]];
      m *= onStairs === !!ev.stairs ? 1 : 0.35;
    }
    lik += this.w[i] * m;
    this.w[i] *= m;
    this.hb[i] += 1.5 * R.gauss();
    this.k[i] = Math.min(1.5, Math.max(0.6, this.k[i] + 0.01 * R.gauss()));
  }
  this._recover(lik);
  this._normalise('step');
  return this._emit();
};

// Augmented MCL: when the particles explain the steps much worse lately than they used to (all of them stuck
// in a dead end, or the wrong corridor), put some new particles around the estimate. lik = Σ w·likelihood.
(Filter.prototype as FilterSelf)._recover = function (lik: number) {
  this.wSlow = this.wSlow == null ? lik : this.wSlow + 0.02 * (lik - this.wSlow);
  this.wFast = this.wFast == null ? lik : this.wFast + 0.25 * (lik - this.wFast);
  const p = Math.max(0, 1 - this.wFast / (this.wSlow * 0.9));
  if (p > 0.05 && this._last && this._last.state === 'tracking') {
    const n = Math.floor(this.N * Math.min(0.3, p));
    const M = this.M, est = this._last;
    const same = M.nearEdges(est.x, est.y, est.li, 35);
    const any = M.nearEdges(est.x, est.y, null, 35);
    for (let j = 0; j < n; j++) {
      const i = Math.floor(this.rand() * this.N);
      // mostly around the estimate (same floor, then any), some anywhere: the estimate itself may be the mistake.
      // Each new one weighs as much as an average particle now: a fresh guess, not a favoured one
      const r = this.rand();
      this._spawn(i, r < 0.6 && same.length ? same : r < 0.85 && any.length ? any : null);
      this.w[i] = lik / this.N;
    }
    this.lastEvidence.recovered = n;
    this.wFast = this.wSlow;
  }
};

// nothing but time (call every second or so, e.g. while standing on an escalator or in a lift)
(Filter.prototype as FilterSelf).tick = function (t: number) {
  if (!this.initialised) { this.t = t; return this.estimate(); }
  this._advance(t);
  return this._emit();
};

// relative barometric height: { t, hPa } (or { t, z } in metres). Only relative changes matter.
(Filter.prototype as FilterSelf).pressure = function (ev: IndoorPressure) {
  if (!this.initialised) return this.estimate();
  this._advance(ev.t);
  const z = ev.z != null ? ev.z : -(ev.hPa! - 1013.25) * HPA_TO_M;
  const o = this.o, M = this.M;
  // Disturbances: people move vertically at most ~1–1.5 m/s (station lifts ~1 m/s, escalators 0.25 m/s). A
  // faster change of the apparent height (over a few seconds) is air being pushed around: a train entering an
  // underground station, a door, the ventilation. Hold the barometer until it settles, then re-anchor it.
  const hist = (this.baroHist = (this.baroHist || []).filter((h) => ev.t - h.t <= 4));
  hist.push({ t: ev.t, z });
  const old = hist[0];
  const v = ev.t - old.t >= 1.5 ? Math.abs(z - old.z) / (ev.t - old.t) : 0; // high-rate jitter is no jump
  if (v > o.baroJump * 0.6 || (this.baroHold && ev.t < this.baroHold.until)) {
    if (!this.baroHold || ev.t >= this.baroHold.until) this.baroHold = { until: ev.t + 20, z0: old.z };
    else if (v > o.baroJump * 0.6) this.baroHold.until = Math.max(this.baroHold.until, ev.t + 10);
    this.lastEvidence.baro = 'disturbed';
    return this.estimate();
  }
  if (this.baroHold) {
    // settled: whatever the height did during the disturbance, start again from here (the particles' own
    // positions, which the walk kept up to date, carry the floor across)
    this.baroHold = null;
    for (let i = 0; i < this.N; i++) { const p = M.at(this.e[i], this.s[i]); this.bo[i] = z - p.z; }
    this.lastBaroZ = z;
    this.lastEvidence.baro = 're-anchored';
    return this.estimate();
  }
  if (!this.baro) {
    // first reading: each particle explains it with its own offset, so it says nothing yet
    for (let i = 0; i < this.N; i++) { const p = M.at(this.e[i], this.s[i]); this.bo[i] = z - p.z; }
    this.baro = { z0: z };
    this.lastBaroZ = z;
    return this.estimate();
  }
  // readings a second apart are not independent: temper each one (exponent < 1)
  const dtb = this.lastBaroT != null ? Math.min(5, Math.max(0.2, ev.t - this.lastBaroT)) : 1;
  this.lastBaroT = ev.t;
  const temper = Math.min(1, 0.3 * dtb);
  for (let i = 0; i < this.N; i++) {
    const p = M.at(this.e[i], this.s[i]);
    const lv = M.levels[p.li];
    const sg = Math.hypot(o.baroSigma, Math.min(lv.sh, 3) * 0.5);
    const r = z - (p.z + this.bo[i]);
    this.w[i] *= Math.pow(o.baroOutlier + Math.exp(-r * r / (2 * sg * sg)), temper);
    // the offset follows slowly (absorbs weather drift and the schematic level heights)
    this.bo[i] += 0.01 * dtb * r;
  }
  this.lastBaroZ = z;
  this.lastEvidence.baro = 'ok';
  this._normalise('pressure');
  return this._emit();
};

// GPS fix: { t, lon, lat, acc }. Indoors GPS is often far off, so its likelihood has heavy tails; good fixes
// (acc < 10 m) also make outdoor ways on level 0 more likely than deep underground ones.
// GPS fix: { t, lon, lat, acc }. Indoors GPS is often far off, so its likelihood has heavy tails. A usable fix
// also says something about the floor: it needs sky, so you are most likely outdoors or near street level, not
// deep underground or inside an upper floor. That is what anchors the floor (and the barometer) at the entrance.
(Filter.prototype as FilterSelf)._gpsFloor = function (e: number, p: IndoorEdgePoint, acc: number) {
  const M = this.M;
  const outdoor = !(M.ef[e] & F_INDOOR);
  const nearStreet = Math.abs(p.z) < 2.5;
  if (acc < 15) return outdoor ? 1 : nearStreet ? 0.45 : 0.12;
  if (acc < 50) return outdoor ? 1 : nearStreet ? 0.7 : 0.4;
  return 1;
};
(Filter.prototype as FilterSelf).gps = function (ev: IndoorGps) {
  const M = this.M, o = this.o;
  const [x, y] = M.fromLngLat(ev.lon, ev.lat);
  const acc = ev.acc || 30;
  const sg = Math.max(o.gpsMinSigma, acc * 1.2);
  if (!this.initialised) {
    // first knowledge: around the fix, on every floor (a fix above a platform does not mean street level), but
    // weighted towards the outdoor ways and street level (the fix needed sky). A fix with no path of the station
    // near it places nobody: the traveller is not at this station (yet).
    if (!M.nearEdges(x, y, null, Math.min(80, sg * 2)).length) return this.estimate();
    this.init({ x, y, r: Math.min(80, sg * 2) });
    this.lastGpsT = ev.t;
    for (let i = 0; i < this.N; i++) this.w[i] *= this._gpsFloor(this.e[i], M.at(this.e[i], this.s[i]), acc);
    this._normalise('gps');
    return this._emit();
  }
  this._advance(ev.t);
  // Fixes a second apart are not independent (the same multipath, the same "it has sky"): together they count as
  // about one fix per 8 s, so a stream of them cannot talk the filter into a floor.
  const temper = this.lastGpsT == null ? 1 : Math.min(1, Math.max(0.1, (ev.t - this.lastGpsT) / 8));
  this.lastGpsT = ev.t;
  // how far off can a fix be? An outdoor fix that claims 8 m is rarely 100 m off; a 40 m fix indoors often is
  const outlier = acc < 15 ? 0.01 : acc < 50 ? 0.05 : o.gpsOutlier;
  let best = 0;
  for (let i = 0; i < this.N; i++) {
    const p = M.at(this.e[i], this.s[i]);
    const d = Math.hypot(p.x - x, p.y - y);
    const g = Math.exp(-d * d / (2 * sg * sg));
    best = Math.max(best, g);
    this.w[i] *= Math.pow((outlier + g) * this._gpsFloor(this.e[i], p, acc), temper);
  }
  // a good fix that no particle explains: some of them start again around it
  // three good fixes in a row that no particle explains (one could be multipath): some particles start again
  // around the fix, each weighing as much as an average particle
  this.gpsMiss = best < 0.01 && acc < 20 ? (this.gpsMiss || 0) + 1 : 0;
  if (this.gpsMiss >= 3) {
    let mass = 0;
    for (let i = 0; i < this.N; i++) mass += this.w[i];
    const near = M.nearEdges(x, y, null, Math.min(60, sg * 2));
    if (near.length) for (let j = 0; j < this.N * 0.3; j++) { const i = Math.floor(this.rand() * this.N); this._spawn(i, near); this.w[i] = mass / this.N * this._gpsFloor(this.e[i], M.at(this.e[i], this.s[i]), acc); }
    this.lastEvidence.relocalised = 'gps';
    this.gpsMiss = 0;
  }
  this._normalise('gps');
  return this._emit();
};

// What the body did, from the accelerometer (optional; Sensors does not classify these yet, a native wrapper or
// a future classifier can): { t, kind: 'lift', dir: 'up' | 'down' } a lift started moving; the step event can
// also carry stairs: true / false (a step on stairs or not).
(Filter.prototype as FilterSelf).motion = function (ev: IndoorMotion) {
  if (!this.initialised) this.init();
  this._advance(ev.t);
  const M = this.M;
  if (ev.kind === 'lift') {
    for (let i = 0; i < this.N; i++) {
      const e = this.e[i];
      const node = M.ek[e] === 3 ? M.ea[e] : (this.s[i] < 4 ? M.ea[e] : (M.elen[e] - this.s[i] < 4 ? M.eb[e] : -1));
      const lifts = node >= 0 ? M.out[node].filter(([f, fd]) => M.ek[f] === 3 && (ev.dir == null ||
        (ev.dir === 'up') === (M.z[fd > 0 ? M.eb[f] : M.ea[f]] > M.z[node]))) : [];
      if (M.ek[e] === 3) { this.ride[i] = 1; continue; }
      if (lifts.length) { const [f, fd] = lifts[Math.floor(this.rand() * lifts.length)]; this.e[i] = f; this.d[i] = fd; this.s[i] = fd > 0 ? 0 : M.elen[f]; this.ride[i] = 1; }
      else this.w[i] *= 0.05;
    }
    this._normalise('motion');
  }
  return this._emit();
};

// Something seen: { t, candidates: [{ x, y, li (or null: any level), sigma, w? }], strength? (0…1) }
// e.g. "Gleis 32 + Sektor B" → the sector sign's position on level −4. Several candidates = ambiguous sign.
(Filter.prototype as FilterSelf).landmark = function (ev: IndoorSighting) {
  if (!this.initialised) this.init();
  this._advance(ev.t);
  const M = this.M;
  const k = ev.strength == null ? 0.8 : ev.strength;
  const cands = ev.candidates || [];
  if (!cands.length) return this.estimate();
  // if the sign points far from every particle, add some particles there (relocalisation)
  let best = 0;
  for (let i = 0; i < this.N; i++) {
    const p = M.at(this.e[i], this.s[i]);
    let lik = 0;
    for (const c of cands) {
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      const lv = c.li == null || c.li === p.li ? 1 : 0.02;
      lik = Math.max(lik, (c.w || 1) * lv * Math.exp(-d * d / (2 * (c.sigma || 10) ** 2)));
    }
    best = Math.max(best, lik);
    // a strong sign (a platform number with its sector letter) leaves little weight to particles far from it
    this.w[i] *= (1 - k) * (1 - k) + k * lik;
  }
  // make sure the places a strong sign names are represented (a weak one, like a direction sign, only reweighs).
  // The new particles carry a prior of being there (20 %, 50 % when nobody was) times the sign's likelihood
  if (k >= 0.5 && (k >= 0.7 || best < 0.05)) {
    const mix = best < 0.05 ? 0.5 : 0.2, frac = best < 0.05 ? 0.3 : 0.15;
    this._inject(cands, frac, mix / (frac * this.N) * ((1 - k) * (1 - k) + k));
  }
  this.lastEvidence.sign = { candidates: cands.length, strength: +k.toFixed(2) };
  this._normalise('landmark');
  return this._emit();
};

// The user (or the journey) says: on this floor, maybe near this spot. { li | level (OSM id), x?, y?, r? }
(Filter.prototype as FilterSelf).prior = function (ev: IndoorPrior) {
  const li = ev.li != null ? ev.li : (ev.level != null ? this.M.levelIndex.get(ev.level) : null);
  if (ev.lon != null) [ev.x, ev.y] = this.M.fromLngLat(ev.lon, ev.lat!);
  return this.init({ x: ev.x, y: ev.y, r: ev.r || 40, levels: li == null ? null : [li] });
};

// The screen was off / the page hidden for dt seconds: anything could have happened nearby
(Filter.prototype as FilterSelf).gap = function (t: number, dt: number) {
  if (!this.initialised) return this.estimate();
  const R = this.rand;
  for (let i = 0; i < this.N; i++) this._move(i, R() * Math.min(dt, 120) * 1.2, null, 60);
  this.t = t;
  return this._emit();
};

// put n = frac·N particles at the candidates, each with weight w (the caller says what they are worth)
(Filter.prototype as FilterSelf)._inject = function (cands: IndoorCandidate[], frac: number, w?: number | null) {
  const n = Math.floor(this.N * frac);
  const M = this.M;
  for (let j = 0; j < n; j++) {
    const i = Math.floor(this.rand() * this.N);
    const c = cands[Math.floor(this.rand() * cands.length)];
    const near = M.nearEdges(c.x, c.y, c.li, (c.sigma || 10) * 1.5);
    if (!near.length) continue;
    this._spawn(i, near);
    this.w[i] = w != null ? w : 1 / this.N;
  }
};

(Filter.prototype as FilterSelf)._normalise = function (why: string) {
  let sum = 0;
  for (let i = 0; i < this.N; i++) { if (!(this.w[i] >= 0)) this.w[i] = 0; sum += this.w[i]; } // NaN-safe
  if (!(sum > 1e-300)) {
    // nothing fits any more: start again around the last estimate, every level
    this.lastEvidence.reset = why;
    const est = this._last;
    this.init(est ? { x: est.x, y: est.y, r: 60 } : {});
    return;
  }
  let ess = 0;
  for (let i = 0; i < this.N; i++) { this.w[i] /= sum; ess += this.w[i] * this.w[i]; }
  ess = 1 / ess;
  this.ess = ess;
  if (ess < this.N * this.o.resampleEss) this._resample();
};
(Filter.prototype as FilterSelf)._resample = function () {
  const N = this.N, R = this.rand;
  const idx = new Int32Array(N);
  let c = this.w[0], j = 0;
  const u0 = R() / N;
  for (let i = 0; i < N; i++) {
    const u = u0 + i / N;
    while (u > c && j < N - 1) { j++; c += this.w[j]; }
    idx[i] = j;
  }
  const cp = (a: Int32Array | Float64Array | Int8Array) => { const b = a.slice(); for (let i = 0; i < N; i++) a[i] = b[idx[i]]; };
  cp(this.e); cp(this.s); cp(this.d); cp(this.k); cp(this.hb); cp(this.bo); cp(this.ride);
  this.w.fill(1 / N);
  // a little jitter along the edge so copies do not stay identical
  for (let i = 0; i < N; i++) this.s[i] = Math.min(this.M.elen[this.e[i]], Math.max(0, this.s[i] + (R() - 0.5) * 0.6));
};

// Where are we? { x, y, lon, lat, li, level, levelProbs: { id: p }, sigma, confident, heading? }
(Filter.prototype as FilterSelf).estimate = function (): IndoorEstimate {
  const M = this.M;
  if (!this.initialised) return { state: 'unknown', confident: false };
  const pl = new Float64Array(M.levels.length);
  const pts = new Array<IndoorEdgePoint>(this.N);
  for (let i = 0; i < this.N; i++) { const p = M.at(this.e[i], this.s[i]); pts[i] = p; pl[p.li] += this.w[i]; }
  let li = 0;
  for (let j = 1; j < pl.length; j++) if (pl[j] > pl[li]) li = j;
  // position: weighted mean over the particles on the most likely floor (never averaged across floors)
  let sx = 0, sy = 0, sw = 0;
  for (let i = 0; i < this.N; i++) if (pts[i].li === li) { sx += pts[i].x * this.w[i]; sy += pts[i].y * this.w[i]; sw += this.w[i]; }
  const x = sx / sw, y = sy / sw;
  let v = 0;
  for (let i = 0; i < this.N; i++) if (pts[i].li === li) v += this.w[i] * ((pts[i].x - x) ** 2 + (pts[i].y - y) ** 2);
  const sigma = Math.sqrt(v / sw);
  // snap the shown point to the network on that floor (a mean of two corridors may lie inside a wall)
  const snap = M.nearestOnLevel(x, y, li, 40);
  const sp = snap ? M.at(snap.e, snap.s) : { x, y };
  const levelProbs: Record<number, number> = {};
  M.levels.forEach((l, j) => { if (pl[j] > 0.005) levelProbs[l.id] = +pl[j].toFixed(3); });
  const [lon, lat] = M.toLngLat(sp.x, sp.y);
  const est: IndoorEstimateTracking = {
    state: 'tracking', x: sp.x, y: sp.y, lon, lat, li, level: M.levels[li].id, levelProb: pl[li], levelProbs,
    sigma, confident: pl[li] > 0.8 && sigma < 15, z: M.levels[li].h, t: this.t, evidence: Object.assign({}, this.lastEvidence),
  };
  this._last = est;
  return est;
};
// particles for drawing: [x, y, li, w]
(Filter.prototype as FilterSelf).cloud = function (max = 400) {
  const out: IndoorParticle[] = [];
  const step = Math.max(1, Math.floor(this.N / max));
  for (let i = 0; i < this.N; i += step) { const p = this.M.at(this.e[i], this.s[i]); out.push([p.x, p.y, p.li, this.w[i] * this.N]); }
  return out;
};

// ================================================================================================ Sensors (browser)
// Attaches to the phone's sensors and feeds a Filter. Everything is optional and detected:
//   sensors.start() must be called from a tap (iOS asks for motion + orientation permission then).
// Emits raw events to `onRaw` (for the Recorder) before they are interpreted.
/** The motion and orientation events' constructors: on iOS, access must be asked for. */
type AskPermission = (typeof DeviceMotionEvent | typeof DeviceOrientationEvent) & { requestPermission?: () => Promise<string> };
/** A Capacitor barometer plugin (in the native wrapper), as far as it is used. */
interface BaroPlugin {
  addListener?(name: 'measurement', fn: (d: { pressure?: number | null; hPa?: number }) => void): Promise<BaroHandle> | BaroHandle;
  startMeasurementUpdates?(): Promise<unknown> | void;
  stopMeasurementUpdates?(): unknown;
}
interface BaroHandle { remove?(): unknown }
interface CapacitorPlugins { Barometer?: BaroPlugin; CapacitorBarometer?: BaroPlugin }
type SensorsWindow = Window & typeof globalThis & { Capacitor?: { Plugins?: CapacitorPlugins } };
/** Safari gives the compass bearing itself. */
type CompassEvent = DeviceOrientationEvent & { webkitCompassHeading?: number | null; webkitCompassAccuracy?: number | null };
interface SensorHandlers {
  motion?: (e: DeviceMotionEvent) => void;
  orient?: (e: DeviceOrientationEvent) => void;
  press?: (e: CustomEvent<IndoorPressureDetail>) => void;
  vis?: () => void;
}
/** The sensors with what only this file reads and writes. */
interface SensorsSelf extends IndoorSensors {
  f: IndoorFilter;
  opts: IndoorSensorsOptions;
  onRaw: NonNullable<IndoorSensorsOptions['onRaw']> | null;
  compass: number | null;
  compassAcc: number | null | undefined;
  gyroSign: number;
  signVotes: number;
  grav: number[];
  acc: number[];
  lastStep: number;
  peak: { max: number; min: number; rising: boolean } | null;
  handHeld: boolean;
  hiddenAt: number | null;
  _h: SensorHandlers;
  stopped?: boolean;
  _geo?: number;
  _tick?: ReturnType<typeof setInterval>;
  _baro?: BaroPlugin;
  _baroHandle?: BaroHandle;
  _gyroSince?: number;
  _orientAt?: number;
  _gravInit?: boolean;
  _rawN?: number;
  _pb?: number[];
  _raw<K extends IndoorLogType>(type: K, data: IndoorLogData[K]): void;
  _visibility(): void;
  _orient(e: CompassEvent): void;
  _motion(e: DeviceMotionEvent): void;
  _detectStep(av: number, t: number): void;
  _gps(p: GeolocationPosition): void;
  _pressure(hPa: number, t?: number): void;
}

function Sensors(this: SensorsSelf, filter: IndoorFilter, opts: IndoorSensorsOptions = {}) {
  if (!(this instanceof Sensors)) return new (Sensors as IndoorParts['Sensors'])(filter, opts);
  this.f = filter;
  this.opts = opts;
  this.onRaw = opts.onRaw || null;
  this.state = { motion: 'off', orientation: 'off', gps: 'off', pressure: 'off' };
  this.heading = null;          // fused heading of the phone (deg)
  this.headingSigma = 90;
  this.compass = null; this.compassAcc = null;
  this.gyroSign = 0;            // +1 / -1 once learnt (browsers disagree about axis signs)
  this.signVotes = 0;
  this.grav = [0, 0, 9.81];
  this.acc = [];                // recent |a| samples for step detection
  this.lastStep = 0; this.peak = null;
  this.handHeld = true;
  this.hiddenAt = null;
  this._h = {};
}
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

(Sensors.prototype as SensorsSelf).start = async function () {
  const W: SensorsWindow | null = typeof window !== 'undefined' ? window : null;
  if (!W) return this.state;
  // iOS 13+: both permissions must be asked from the same tap
  const ask = async (C: AskPermission | undefined) => {
    if (C && typeof C.requestPermission === 'function') {
      try { return (await C.requestPermission()) === 'granted'; } catch (e) { return false; }
    }
    return !!C;
  };
  const [m, o] = await Promise.all([ask(W.DeviceMotionEvent), ask(W.DeviceOrientationEvent)]);
  if (this.stopped) return this.state; // stopped while the permission prompt was open
  if (m) { W.addEventListener('devicemotion', this._h.motion = (e) => this._motion(e)); this.state.motion = 'on'; }
  else this.state.motion = 'denied';
  if (o) {
    const absolute = 'ondeviceorientationabsolute' in W;
    W.addEventListener(absolute ? 'deviceorientationabsolute' : 'deviceorientation', this._h.orient = (e) => this._orient(e));
    this.state.orientation = 'on';
  } else this.state.orientation = 'denied';
  if (!this.opts.noGeo && W.navigator && W.navigator.geolocation) { // noGeo: the app feeds GPS itself (Filter.gps)
    this._geo = W.navigator.geolocation.watchPosition((p) => this._gps(p), () => { this.state.gps = 'denied'; },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
    this.state.gps = 'on';
  }
  // pressure: a Capacitor barometer plugin when running in the native wrapper, or anything that calls
  // INDOORLOC.pushPressure(hPa) / dispatches 'indoorloc:pressure' with { detail: { hPa } }
  W.addEventListener('indoorloc:pressure', this._h.press = (e) => this._pressure(e.detail.hPa, e.detail.t));
  const cap = W.Capacitor && W.Capacitor.Plugins;
  const baro = cap && (cap.Barometer || cap.CapacitorBarometer);
  if (baro && baro.addListener) {
    try {
      if (baro.startMeasurementUpdates) await baro.startMeasurementUpdates();
      if (this.stopped) { if (baro.stopMeasurementUpdates) baro.stopMeasurementUpdates(); return this.state; }
      this._baro = baro;
      this._baroHandle = await baro.addListener('measurement', (d) => this._pressure(d.pressure != null ? d.pressure : d.hPa!));
      if (this.stopped) { this.stop(); return this.state; }
      this.state.pressure = 'on';
    } catch (e) { this.state.pressure = 'error'; }
  } else this.state.pressure = 'unavailable';
  if (this.stopped) return this.state;
  W.document && W.document.addEventListener('visibilitychange', this._h.vis = () => this._visibility());
  this._tick = setInterval(() => { this._raw('tick', {}); this.f.tick(now()); }, 1000);
  return this.state;
};
(Sensors.prototype as SensorsSelf).stop = function () {
  const W = window;
  this.stopped = true;
  if (this._baroHandle && this._baroHandle.remove) { try { this._baroHandle.remove(); } catch (e) {} }
  if (this._baro && this._baro.stopMeasurementUpdates) { try { this._baro.stopMeasurementUpdates(); } catch (e) {} }
  if (this._h.motion) W.removeEventListener('devicemotion', this._h.motion);
  if (this._h.orient) { W.removeEventListener('deviceorientationabsolute', this._h.orient); W.removeEventListener('deviceorientation', this._h.orient); }
  if (this._h.press) W.removeEventListener('indoorloc:pressure', this._h.press);
  if (this._h.vis) document.removeEventListener('visibilitychange', this._h.vis);
  if (this._geo != null) navigator.geolocation.clearWatch(this._geo);
  clearInterval(this._tick);
  this._h = {};
};
(Sensors.prototype as SensorsSelf)._raw = function <K extends IndoorLogType>(type: K, data: IndoorLogData[K]) { if (this.onRaw) this.onRaw(type, Object.assign({ t: now() }, data)); };

(Sensors.prototype as SensorsSelf)._visibility = function () {
  if (document.hidden) { this.hiddenAt = now(); this._raw('hidden', {}); return; }
  if (this.hiddenAt != null) {
    const dt = now() - this.hiddenAt;
    this._raw('visible', { dt });
    this.hiddenAt = null;
    if (dt > 3) this.f.gap(now(), dt);
  }
};

(Sensors.prototype as SensorsSelf)._orient = function (e: CompassEvent) {
  let h = null, acc = null;
  if (e.webkitCompassHeading != null) {
    acc = e.webkitCompassAccuracy;
    if (acc != null && acc < 0) return; // iOS: compass not calibrated
    h = e.webkitCompassHeading;
  }
  else if (e.absolute !== false && e.alpha != null) h = compassFromEuler(e.alpha, e.beta, e.gamma);
  // phone roughly flat or tilted towards you (reading the screen) = in hand; upright and swinging = pocket
  if (e.beta != null) this.handHeld = Math.abs(e.beta) < 80;
  if (h == null || !Number.isFinite(h)) return;
  this._raw('orient', { h, acc, a: e.alpha, b: e.beta, g: e.gamma });
  // learn the gyro sign from how compass and gyro turn together
  if (this.compass != null && this._gyroSince != null) {
    const dc = angDiff(h, this.compass);
    if (Math.abs(dc) > 8 && Math.abs(this._gyroSince) > 8) { this.signVotes += Math.sign(dc) * Math.sign(this._gyroSince); this.gyroSign = Math.sign(this.signVotes) || 0; }
  }
  if (this.compass == null || Math.abs(angDiff(h, this.compass)) > 8) { this.compass = h; this._gyroSince = 0; }
  this.compassAcc = acc;
  if (this.heading == null || !this.gyroSign) { this.heading = h; this.headingSigma = acc! > 0 ? Math.max(20, acc!) : 30; return; }
  // complementary filter: the gyro carries the heading, the compass pulls it slowly (iron and trains bend it).
  // The pull is per second, not per event (events come at 20–100 Hz): time constant ~20 s.
  const tn = now(), dt = this._orientAt ? Math.min(1, Math.max(0, tn - this._orientAt)) : 0.02;
  this._orientAt = tn;
  const k = dt / 20;
  this.heading = (this.heading + k * angDiff(h, this.heading) + 360) % 360;
  // how far the compass disagrees lately (a disturbed compass widens the heading's uncertainty)
  const kk = dt / 5;
  this.headingSigma = Math.min(45, Math.max(15, this.headingSigma * (1 - kk) + kk * Math.abs(angDiff(h, this.heading))));
};

(Sensors.prototype as SensorsSelf)._motion = function (e: DeviceMotionEvent) {
  const g = e.accelerationIncludingGravity, rr = e.rotationRate;
  const dt = (e.interval > 1 ? e.interval / 1000 : e.interval) || 0.016;
  if (!g || g.x == null) return;
  // gravity by low-pass (time constant 1 s, whatever the event rate); vertical acceleration = projection onto it.
  // Seeded from the first sample (iOS and Android disagree about its sign)
  if (!this._gravInit) { this.grav = [g.x, g.y!, g.z!]; this._gravInit = true; }
  const a = dt / (1 + dt);
  this.grav = [this.grav[0] + a * (g.x - this.grav[0]), this.grav[1] + a * (g.y! - this.grav[1]), this.grav[2] + a * (g.z! - this.grav[2])];
  const gn = Math.hypot(...this.grav) || 9.81;
  const u = this.grav.map((v) => v / gn);
  const av = g.x * u[0] + g.y! * u[1] + g.z! * u[2] - gn;
  if (this.onRaw && (this._rawN = (this._rawN || 0) + 1) % 2 === 0)
    this._raw('imu', { av: +av.toFixed(3), r: rr ? [+(rr.alpha || 0).toFixed(2), +(rr.beta || 0).toFixed(2), +(rr.gamma || 0).toFixed(2)] : null, u: u.map((v) => +v.toFixed(3)) });
  // yaw rate around the vertical (deg/s): rotationRate alpha/beta/gamma are about the device z/x/y axes
  if (rr && rr.alpha != null) {
    const yaw = -(rr.beta! * u[0] + rr.gamma! * u[1] + rr.alpha * u[2]);
    this._gyroSince = (this._gyroSince || 0) + yaw * dt;
    if (this.heading != null && this.gyroSign) this.heading = (this.heading + this.gyroSign * yaw * dt + 360) % 360;
  }
  this._detectStep(av, now());
};

// Steps: peaks of vertical acceleration (> 1.2 m/s², 0.3–2 s apart); length from the swing (Weinberg)
(Sensors.prototype as SensorsSelf)._detectStep = function (av: number, t: number) {
  const buf = this.acc;
  buf.push(av);
  if (buf.length > 5) buf.shift();
  const sm = buf.reduce((s, v) => s + v, 0) / buf.length;
  if (!this.peak) this.peak = { max: -1e9, min: 1e9, rising: false };
  const P = this.peak;
  P.max = Math.max(P.max, sm); P.min = Math.min(P.min, sm);
  if (sm > 1.2 && !P.rising) P.rising = true;
  if (P.rising && sm < 0 && t - this.lastStep > 0.3) {
    const swing = P.max - P.min;
    const length = Math.min(0.95, Math.max(0.45, 0.48 * Math.pow(Math.max(swing, 0.5), 0.25)));
    const gap = t - this.lastStep;
    this.lastStep = t;
    P.rising = false; P.max = -1e9; P.min = 1e9;
    if (gap > 2.5) return; // first step after a pause: no length yet
    const heading = this.handHeld && this.heading != null ? this.heading : null;
    const sigma = heading == null ? null : Math.max(20, this.headingSigma);
    this._raw('step', { length, heading, sigma });
    this.f.step({ t, length, heading, headingSigma: sigma });
  }
};

(Sensors.prototype as SensorsSelf)._gps = function (p: GeolocationPosition) {
  const c = p.coords;
  this._raw('gps', { lon: c.longitude, lat: c.latitude, acc: c.accuracy, alt: c.altitude, altAcc: c.altitudeAccuracy });
  this.f.gps({ t: now(), lon: c.longitude, lat: c.latitude, acc: c.accuracy });
};
(Sensors.prototype as SensorsSelf)._pressure = function (hPa: number, t?: number) {
  if (!(hPa > 500)) return;
  this.state.pressure = 'on';
  this._raw('pressure', { hPa });
  // a short median (5 readings) against single-sample spikes
  this._pb = (this._pb || []).concat([hPa]).slice(-5);
  const med = this._pb.slice().sort((a, b) => a - b)[Math.floor(this._pb.length / 2)];
  this.f.pressure({ t: t || now(), hPa: med });
};

// compass heading from W3C deviceorientation angles (phone screen up or tilted; the direction the top points)
// compass heading (deg, clockwise from north) from W3C deviceorientation angles (z-x'-y'' intrinsic, absolute alpha).
// Walking with the phone in hand, the top edge points where you go: its horizontal direction is used while the
// phone is flat or tilted towards you; held upright, the back (camera) direction. Null when neither is defined.
/** Compass heading (deg, clockwise from north) from deviceorientation angles; null when it is not defined. */
function compassFromEuler(alpha: number | null, beta: number | null, gamma: number | null) {
  if (![alpha, beta, gamma].every(Number.isFinite)) return null;
  const r = Math.PI / 180;
  const cA = Math.cos(alpha! * r), sA = Math.sin(alpha! * r), cB = Math.cos(beta! * r), sB = Math.sin(beta! * r);
  const cG = Math.cos(gamma! * r), sG = Math.sin(gamma! * r);
  // device +y (top edge) in east/north: R·(0,1,0) = (−sinα·cosβ, cosα·cosβ, sinβ)
  let e = -sA * cB, n = cA * cB;
  // only while the phone tilts towards you (cos β > 0.4): past upright the top edge points back at you
  if (cB < 0.4) {
    // upright: device −z (back camera) = (−cosα·sinγ − sinα·sinβ·cosγ, −sinα·sinγ + cosα·sinβ·cosγ, …)
    e = -cA * sG - sA * sB * cG; n = -sA * sG + cA * sB * cG;
    if (Math.hypot(e, n) < 0.4) return null;
  }
  return (Math.atan2(e, n) / r + 360) % 360;
}

// ================================================================================================ Recorder
// { meta, events: [[t, type, data]], checkpoints } → JSON. Replay feeds the same events through a new Filter.
interface RecorderSelf extends IndoorRecorder {
  /** The time of the first event. */
  t0: number | null;
}
function Recorder(this: RecorderSelf, meta: IndoorLogMeta = {}) {
  if (!(this instanceof Recorder)) return new (Recorder as IndoorParts['Recorder'])(meta);
  this.meta = Object.assign({ v: 1, ua: typeof navigator !== 'undefined' ? navigator.userAgent : 'node', start: new Date().toISOString() }, meta);
  this.events = [];
  this.t0 = null;
}
(Recorder.prototype as RecorderSelf).add = function <K extends IndoorLogType>(type: K, data: IndoorRaw<K>) {
  const t = data.t != null ? data.t : now();
  if (this.t0 == null) this.t0 = t;
  const d = Object.assign({}, data); delete d.t;
  this.events.push([+(t - this.t0).toFixed(3), type, d] as IndoorLogEvent);
};
// "I am here": ground truth for evaluation (tapped on the map, or a known place such as "bottom of escalator")
(Recorder.prototype as RecorderSelf).checkpoint = function (where: IndoorRaw<'checkpoint'>) { this.add('checkpoint', where); };
(Recorder.prototype as RecorderSelf).toJSON = function (): IndoorLog { return { meta: this.meta, events: this.events }; };

// Replay a recording through a filter → { estimates: [[t, est]], errors: [{ t, d, levelOk }] at checkpoints }
/** A recording through a new filter. */
function replay(log: IndoorLog, model: IndoorModel, opts: IndoorReplayOptions = {}) {
  const f = new (Filter as IndoorParts['Filter'])(model, Object.assign({ seed: 1 }, opts));
  const out: IndoorReplayResult = { estimates: [], checkpoints: [] };
  const prior = opts.prior || (log.meta && log.meta.prior);
  if (prior) f.prior(prior);
  for (const [t, type, d] of log.events) {
    let est = null;
    if (type === 'step') est = f.step({ t, length: d.length, heading: d.heading, headingSigma: d.headingSigma || d.sigma, stairs: d.stairs });
    else if (type === 'gps') est = f.gps({ t, lon: d.lon, lat: d.lat, acc: d.acc });
    else if (type === 'pressure') est = f.pressure({ t, hPa: d.hPa, z: d.z });
    else if (type === 'tick') est = f.tick(t);
    else if (type === 'landmark') est = f.landmark(Object.assign({ t }, d));
    else if (type === 'sign') est = SIGNLOC.apply(f, SIGNLOC.match(d.text, model), t);
    else if (type === 'motion') est = f.motion(Object.assign({ t }, d));
    else if (type === 'prior') est = f.prior(d);
    else if (type === 'visible' && d.dt > 3) est = f.gap(t, d.dt);
    else if (type === 'checkpoint' || type === 'truth') {
      const e = f.estimate();
      const li = d.level != null ? model.levelIndex.get(d.level) : d.li;
      let x = d.x, y = d.y;
      if (d.lon != null) [x, y] = model.fromLngLat(d.lon, d.lat!);
      out.checkpoints.push({ t, d: e.state === 'tracking' ? Math.hypot(e.x - x!, e.y - y!) : null, levelOk: e.li === li, prob: e.levelProbs ? (e.levelProbs[model.levelId(li!)!] || 0) : 0, est: e });
    }
    if (est && opts.every) out.estimates.push([t, est]);
  }
  return out;
}

// ================================================================================================ loading
// The model of a station: through loadData when the viewer is on the page (indoornav.ts passes Station3D.loadData,
// which loads the file once for both), else straight from stations3d/<key>.js. → Promise<Model | null>
/** A station's model: through loadData when the viewer is on the page, else from `base` + key + '.js'. */
function load(key: string, base = 'stations3d/', loadData?: (key: string) => Promise<StationModel | null>): Promise<IndoorModel | null> {
  const W = globalThis; // where the station models put themselves (stations3d/<key>.js)
  const make = (m: StationModel | null | undefined) => (m ? new (Model as IndoorParts['Model'])(m) : null);
  if (W.STATION3D && W.STATION3D[key]) return Promise.resolve(make(W.STATION3D[key]));
  if (loadData) return loadData(key).then(make);
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = base + key + '.js';
    s.onload = () => resolve(make(W.STATION3D && W.STATION3D[key]));
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
}

/** The four parts as constructors: each is a function that makes its object, with or without `new`. */
export interface IndoorParts {
  Model: IndoorCtor<[m: StationModel, opts?: IndoorModelOptions], IndoorModel>;
  Filter: IndoorCtor<[model: IndoorModel, opts?: IndoorFilterOptions], IndoorFilter>;
  Sensors: IndoorCtor<[filter: IndoorFilter, opts?: IndoorSensorsOptions], IndoorSensors>;
  Recorder: IndoorCtor<[meta?: IndoorLogMeta], IndoorRecorder>;
}

export const INDOORLOC = {
  Model: Model as IndoorParts['Model'], Filter: Filter as IndoorParts['Filter'], Sensors: Sensors as IndoorParts['Sensors'],
  Recorder: Recorder as IndoorParts['Recorder'], replay, load, isClosed, compassFromEuler, rng,
  /** `Model.ek` → the edge's kind. */
  KIND,
  /** A barometer reading from a native wrapper. → was the event dispatched? */
  pushPressure: (hPa: number): boolean => typeof window !== 'undefined' && window.dispatchEvent(new CustomEvent('indoorloc:pressure', { detail: { hPa } })),
  /** Bits of `Model.ef`. */
  flags: { F_INDOOR, F_ONEWAY, F_NOT_STEPFREE, F_OUTDOOR },
};
