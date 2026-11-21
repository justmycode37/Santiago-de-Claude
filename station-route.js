// Indoor router for the station 3D models (stations3d/SCHEMA.md, section "Router"): the quickest walk through a
// model's graph, with step-by-step instructions. Classic script, no dependencies; sets window.StationRoute
// (and module.exports in Node, for tools/test_station_route.mjs).
//
// ---- API ----
// StationRoute.toLocal(model, [lng, lat])  → [x, y]
// StationRoute.toLngLat(model, [x, y])     → [lng, lat]
// StationRoute.z(model, level)             → metres (piecewise linear through model.levels[].z)
// StationRoute.route(model, from, to, prefs) → route | null
//   from / to: { stop: { uic, ref } } | { node: i } | { entrance: "name" } | { xy: [x, y], level } | { ll: [lng, lat], level }
//   prefs: { stepFree, fewerStairs, noEscalators, wheelchair, walkKmh } (stricter ones imply the others, as in settings.js)
//   null when an endpoint cannot be found in the model, or the two are not connected at all.
//   route, as in SCHEMA.md: { points, nodes, length, seconds, steps: [{ kind, from, to, level, toLevel, dir, len, seconds, text }] }
//   plus these optional fields:
//     route.relaxed   ['wheelchair', 'stepFree', 'noEscalators']: set only when no route meets the preferences; the route
//                     returned is then the one that breaks them least (fewest stairs, then escalators, then
//                     wheelchair: false edges, then steep slopes), and these are the settings it breaks.
//     route.notice    one sentence for the user when relaxed is set, e.g. "No step-free way here: this route has stairs."
//     route.dists     metres from the start at each point (stairs and ramps along the slope, lifts 0)
//     route.edges     graph edge index for each piece points[i] → points[i + 1] (-1 for none)
//     route.fromStop / route.toStop   the model.stops entry chosen for a { stop } endpoint
//     step.turn       'left' | 'right' | 'bear-left' | 'bear-right' | 'straight' | 'around' when the path bends there
//     step.place      what the walk goes through / along ("platform 7", "the underpass", "Bahnhofplatz")
//     step.warn       true on a step that breaks a preference (see relaxed)
//     arrive step: sector (e.g. "B") when the end is near a sector sign
// StationRoute.snap(model, route, xy, hint?) → { index, t, point: [x, y, level], dist, along, remaining, step }
//   Nearest position on a route to a position fix (local xy; pass { ll: [lng, lat] } for GPS). index = piece
//   points[index] → points[index + 1], t = 0..1 on it, dist = horizontal metres from the fix, along / remaining =
//   metres of route, step = index into route.steps. hint is the current level (a number) or the previous snap result
//   (then the level and the progress so far both count): where floors overlap in plan, the fix stays on the floor
//   and part of the route it was on rather than jumping to a piece above or below.
// StationRoute.pointAt(route, metres) → [x, y, level] (clamped to the route)
// Extras: StationRoute.resolve(model, endpoint) → candidates (for debugging), StationRoute.platformKey(ref),
//   StationRoute.levelName(model, level), StationRoute.TIME (the numbers below).
// The graph is indexed once per model object (WeakMap): treat a model as read-only after its first route.
// { stop } endpoints: refs compare like platformKey in index.html; all stops of that stop id with that ref are
// candidates and the route picks the best one. A stop id that is not in the model falls back to the ref across the
// whole complex. Free positions snap to the nearest point on an edge (not a node): on the given level, another
// floor only when nothing on this one is within ~30 m; without a level, outdoor and level-0 edges first.
//
// ---- Time model ----
// Real seconds (route.seconds, step.seconds):
//   walk       distance / walkKmh (default 4.7 km/h = 1.31 m/s). On slopes (edge.incline, or the level heights on
//              ramps) Tobler's hiking function, normalised to 1 on the flat: 6 % uphill ≈ 0.81 × speed, 8 % ≈ 0.75 ×,
//              gentle downhill up to 1.15 ×.
//   stairs     0.34 m of height per second going up (a 17 cm step every half second), 0.45 m/s going down, but never
//              faster than walking the slope length; both scale with walkKmh (a slow walker is slow on stairs too).
//              4.8 m (one floor) ≈ 14 s up, 11 s down.
//   escalator  2 s to step on, then 0.6 m/s along the slope (people standing at 0.5 m/s, some walking); without a
//              horizontal length the slope is taken as 30°. One floor ≈ 18 s.
//   ramp       as walk, with the slope from the level heights (or edge.incline).
//   lift       30 s on boarding (average wait plus doors), then 2 s + 1 s per metre of height for each lift edge.
//              One floor ≈ 37 s, which is why people who can take the stairs rarely get a lift.
// Extra cost that is not time (it only steers the choice, so routes look like what a local would do):
//   +5 s for every change of level (stairs, escalator, lift, ramp that changes level): no pointless up-and-down.
//   +2 s per metre climbed on stairs, +0.8 s per metre down them, +0.5 s per metre climbed on slopes (effort).
//   Turns: up to +3 s for a bend sharper than 40° (U-turn = 3 s): no zig-zag across squares and junctions.
//   +2 s each time a walk switches between outdoor and indoor edges: stay on one kind of way.
//   fewerStairs: each flight of stairs costs 3 × its time + 90 s, so stairs win only when the alternative is about
//   1.5 min longer.
// Preferences that forbid something (noEscalators, stepFree, wheelchair) are hard: an edge that breaks one costs
// 10000 s (stairs), 8000 s (escalator), 5000 s (wheelchair: false) or 3000 s (steep: incline above 8 %) for each
// run of such edges. So the route uses them only when nothing else connects, and then as few as possible;
// that is the "least-violating relaxation", reported in route.relaxed. One-way edges are never used backwards.
//
// The search runs over directed edges (Dijkstra, binary heap): the cost of going on can depend on how you arrived,
// which is what the lift wait (paid once per ride, not per floor), the level-change cost (once per staircase, not
// per flight piece) and the turn cost need.
(function (root) {
  'use strict';

  const KX = 111320, KY = 110540, DEG = 180 / Math.PI;
  const TIME = {
    walkKmh: 4.7,
    stairsUpVert: 0.34, stairsDownVert: 0.45,
    escalatorSpeed: 0.6, escalatorBoard: 2, escalatorSlope: 1.73, // horizontal metres per metre of height (30°)
    liftWait: 30, liftPerEdge: 2, liftSpeed: 1,
    levelChange: 5,
    stairsUpEffort: 2, stairsDownEffort: 0.8, climbEffort: 0.5,
    turnFrom: 40, turnMax: 3,
    outdoorSwitch: 2,
    fewerStairsFactor: 3, fewerStairsEntry: 90,
    steepIncline: 0.08,
    violation: { stairs: 10000, escalator: 8000, wheelchair: 5000, steep: 3000 },
  };

  const WALK = 0, STAIRS = 1, ESC = 2, RAMP = 3, LIFT = 4, NONE = 5;
  const KIND_NAMES = ['walk', 'stairs', 'escalator', 'ramp', 'elevator', 'none'];
  const KIND_CODES = {
    walk: WALK, footway: WALK, corridor: WALK, path: WALK,
    stairs: STAIRS, steps: STAIRS,
    escalator: ESC,
    ramp: RAMP,
    elevator: LIFT, lift: LIFT,
  };
  const V_STAIRS = 1, V_ESC = 2, V_WCF = 4, V_STEEP = 8;

  // ---------- Coordinates ----------
  function toLocal(model, ll) {
    const [lng0, lat0] = model.origin;
    return [(ll[0] - lng0) * KX * Math.cos(lat0 * Math.PI / 180), (ll[1] - lat0) * KY];
  }
  function toLngLat(model, xy) {
    const [lng0, lat0] = model.origin;
    return [lng0 + xy[0] / (KX * Math.cos(lat0 * Math.PI / 180)), lat0 + xy[1] / KY];
  }

  const zCache = new WeakMap();
  function zFn(model) {
    let f = zCache.get(model);
    if (f) return f;
    const lv = (model.levels || []).filter((l) => isFinite(l.id) && isFinite(l.z)).slice().sort((a, b) => a.id - b.id);
    f = (level) => {
      level = +level || 0;
      if (!lv.length) return level * 4.5;
      if (lv.length === 1) return lv[0].z + (level - lv[0].id) * 4.5;
      let i = 0;
      while (i < lv.length - 2 && level > lv[i + 1].id) i++;
      const a = lv[i], b = lv[i + 1];
      return a.z + (level - a.id) * (b.z - a.z) / (b.id - a.id);
    };
    zCache.set(model, f);
    return f;
  }
  const z = (model, level) => zFn(model)(level);

  // Same as platformKey in index.html: "7A-D" → "7", "Gleis 7" → "7", "Kante H" → "H", "K1" → "K1"
  function platformKey(p) {
    const s = String(p == null ? '' : p).toUpperCase().replace(/^(GLEIS|GL\.|KANTE|QUAI|VOIE|BINARIO|STEG|PERRON)\s*/, '').trim();
    const digits = /^\d+/.exec(s);
    return digits ? digits[0] : s.replace(/[^0-9A-Z]/g, '');
  }

  // ---------- Prepared model (cached) ----------
  const prepCache = new WeakMap();
  function prepare(model) {
    let P = prepCache.get(model);
    if (P) return P;
    const g = model.graph || { nodes: [], edges: [] };
    const nodes = g.nodes || [], edges = g.edges || [];
    const N = nodes.length, E = edges.length;
    const zf = zFn(model);
    const nz = new Float64Array(N);
    for (let i = 0; i < N; i++) nz[i] = zf(nodes[i][2] || 0);
    const EA = new Int32Array(E), EB = new Int32Array(E);
    const kind = new Uint8Array(E), L = new Float64Array(E), dz = new Float64Array(E), hd = new Float64Array(E);
    const outdoor = new Uint8Array(E), oneway = new Uint8Array(E), vmask = new Uint8Array(E), ok = new Uint8Array(E);
    const incl = new Float64Array(E); // signed slope in a → b direction (NaN: flat / unknown)
    const outs = Array.from({ length: N }, () => []);
    const parent = new Int32Array(N);
    for (let i = 0; i < N; i++) parent[i] = i;
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };

    for (let e = 0; e < E; e++) {
      const ed = edges[e], a = ed.a, b = ed.b;
      if (!(a >= 0 && a < N && b >= 0 && b < N) || a === b) continue;
      ok[e] = 1;
      EA[e] = a; EB[e] = b;
      const k = KIND_CODES[ed.kind] != null ? KIND_CODES[ed.kind] : WALK;
      kind[e] = k;
      const geo = Math.hypot(nodes[b][0] - nodes[a][0], nodes[b][1] - nodes[a][1]);
      L[e] = k === LIFT ? 0 : (isFinite(ed.len) && ed.len >= 0 ? ed.len : geo);
      dz[e] = nz[b] - nz[a];
      hd[e] = geo > 0.3 ? Math.atan2(nodes[b][1] - nodes[a][1], nodes[b][0] - nodes[a][0]) : NaN;
      outdoor[e] = ed.outdoor ? 1 : 0;
      oneway[e] = ed.oneway ? 1 : 0;
      // edge.incline gives the steepness; which way is up comes from the level heights when they differ
      // (builders often write the size only), else from the sign of incline (a → b)
      let s = NaN;
      const hasInc = isFinite(ed.incline) && ed.incline !== 0;
      if (Math.abs(dz[e]) > 0.05 && (k === RAMP || k === WALK)) {
        const mag = hasInc ? Math.abs(ed.incline) : L[e] > 0.5 ? Math.abs(dz[e]) / L[e] : 1;
        s = Math.sign(dz[e]) * mag;
      } else if (hasInc) s = +ed.incline;
      incl[e] = s;
      let m = 0;
      if (k === STAIRS) m |= V_STAIRS;
      if (k === ESC) m |= V_ESC;
      if (ed.wheelchair === false) m |= V_WCF;
      if ((k === RAMP || k === WALK) && isFinite(s) && Math.abs(s) > TIME.steepIncline + 1e-9) m |= V_STEEP;
      vmask[e] = m;
      outs[a].push(2 * e);
      if (!oneway[e]) outs[b].push(2 * e + 1);
      parent[find(a)] = find(b);
    }
    // Main connected part: the one with the stops (else the biggest)
    const comp = new Int32Array(N);
    const size = new Map();
    for (let i = 0; i < N; i++) { comp[i] = find(i); size.set(comp[i], (size.get(comp[i]) || 0) + 1); }
    let main = -1;
    const st0 = (model.stops || []).find((s) => s.node >= 0 && s.node < N);
    if (st0) main = comp[st0.node];
    else { let best = -1; size.forEach((n, c) => { if (n > best) { best = n; main = c; } }); }

    // Areas by level, with bounding boxes, for names of places
    const areas = (model.areas || []).filter((a) => a.ring && a.ring.length >= 3 && a.kind !== 'room').map((a) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of a.ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      return { a, level: +a.level || 0, box: [x0, y0, x1, y1], prio: a.kind === 'platform' ? 0 : a.kind === 'floor' ? 1 : a.kind === 'plaza' ? 2 : 3 };
    });
    P = { model, nodes, edges, N, E, nz, EA, EB, kind, L, dz, hd, outdoor, oneway, vmask, ok, incl, outs, comp, main, areas, zf, placeCache: new Map() };
    prepCache.set(model, P);
    return P;
  }

  // ---------- Geometry helpers ----------
  function inRing(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function areaAt(P, x, y, level) {
    const lr = Math.round(level);
    if (Math.abs(level - lr) > 0.3) return null;
    let best = null;
    for (const A of P.areas) {
      if (A.level !== lr) continue;
      const b = A.box;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (!inRing(A.a.ring, x, y)) continue;
      if (A.a.holes && A.a.holes.some((h) => h && h.length >= 3 && inRing(h, x, y))) continue;
      if (!best || A.prio < best.prio) best = A;
    }
    return best && best.a;
  }
  const angleDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d <= -Math.PI) d += 2 * Math.PI; return d; };

  // ---------- Endpoints ----------
  // Nearest point on an edge to (x, y). level: the floor the position is on, or null (then prefer outdoor / level 0).
  function snapToGraph(P, x, y, level) {
    const hasLevel = level != null && isFinite(level);
    let best = null;
    for (let e = 0; e < P.E; e++) {
      if (!P.ok[e] || P.kind[e] === LIFT) continue;
      const pa = P.nodes[P.EA[e]], pb = P.nodes[P.EB[e]];
      const dx = pb[0] - pa[0], dy = pb[1] - pa[1], l2 = dx * dx + dy * dy;
      let t = l2 > 1e-9 ? ((x - pa[0]) * dx + (y - pa[1]) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = pa[0] + t * dx, py = pa[1] + t * dy;
      const lv = (pa[2] || 0) + t * ((pb[2] || 0) - (pa[2] || 0));
      const d = Math.hypot(x - px, y - py);
      let score = d;
      if (hasLevel) {
        const dl = Math.abs(lv - level);
        if (dl > 0.26) score += 30 * dl; // a different floor only when nothing on this one is within ~30 m
      } else if (!P.outdoor[e]) {
        score += Math.abs(lv) < 0.26 ? 3 : 25 + 10 * Math.abs(lv);
      }
      if (P.kind[e] !== WALK) score += 3; // stand on a floor rather than half way up the stairs
      if (P.comp[P.EA[e]] !== P.main) score += 50; // stray bits of graph that do not connect
      if (!best || score < best.score) best = { edge: e, s: t, point: [px, py, lv], dist: d, score };
    }
    return best;
  }

  function resolve(model, ep) {
    const P = prepare(model);
    if (!ep) return [];
    const stops = model.stops || [];
    const nodeOk = (n) => Number.isInteger(n) && n >= 0 && n < P.N;
    const fromNode = (n, extra) => Object.assign({ node: n, point: P.nodes[n].slice(0, 3) }, extra);
    const fromXY = (xy, level, extra) => {
      const s = snapToGraph(P, xy[0], xy[1], level);
      return s ? [Object.assign({ edge: s.edge, s: s.s, point: s.point, dist: s.dist }, extra)] : [];
    };
    if (ep.stop) {
      const uic = ep.stop.uic != null ? String(ep.stop.uic) : null;
      const key = platformKey(ep.stop.ref);
      let pool = uic ? stops.filter((s) => String(s.uic) === uic) : stops;
      if (uic && !pool.length && key) pool = stops; // stop id not in the model: try the ref across the complex
      let c = pool.filter((s) => !key || platformKey(s.ref) === key);
      if (!c.length && key) c = pool.filter((s) => { const k = platformKey(s.ref); return k && (k.startsWith(key) || key.startsWith(k)); });
      const out = [];
      for (const s of c) {
        if (nodeOk(s.node)) out.push(fromNode(s.node, { stop: s }));
        else if (s.xy) out.push(...fromXY(s.xy, s.level, { stop: s }));
      }
      // a stop the model does not know (no such ref): fall back to the position given with it, if any
      if (out.length || !(ep.xy || ep.ll)) return out;
    }
    if (ep.node != null) return nodeOk(ep.node) ? [fromNode(ep.node, {})] : [];
    if (ep.entrance != null) {
      const ents = model.entrances || [];
      const want = String(ep.entrance).trim().toLowerCase();
      let c = ents.filter((e) => String(e.name || '').trim().toLowerCase() === want);
      if (!c.length && want) c = ents.filter((e) => String(e.name || '').toLowerCase().includes(want));
      const out = [];
      for (const en of c) {
        if (nodeOk(en.node)) out.push(fromNode(en.node, { entrance: en }));
        else if (en.xy) out.push(...fromXY(en.xy, en.level, { entrance: en }));
      }
      return out;
    }
    if (ep.xy || ep.ll) {
      const xy = ep.xy || toLocal(model, ep.ll);
      return fromXY(xy, ep.level != null && isFinite(ep.level) ? +ep.level : null, {});
    }
    return [];
  }

  // ---------- Binary heap ----------
  function Heap() { this.k = []; this.v = []; }
  Heap.prototype.push = function (key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  };
  Heap.prototype.pop = function () {
    const k = this.k, v = this.v;
    const top = v[0], topK = k[0];
    const lk = k.pop(), lv = v.pop();
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    this.lastKey = topK;
    return top;
  };

  // ---------- Search ----------
  function settings(prefs) {
    const p = prefs || {};
    const wheel = !!p.wheelchair;
    const stepFree = wheel || !!p.stepFree;
    const fewer = stepFree || !!p.fewerStairs;
    const noEsc = stepFree || !!p.noEscalators;
    const kmh = isFinite(p.walkKmh) && p.walkKmh > 0 ? +p.walkKmh : TIME.walkKmh;
    let active = 0;
    if (stepFree) active |= V_STAIRS;
    if (noEsc) active |= V_ESC;
    if (wheel) active |= V_WCF | V_STEEP;
    return { wheel, stepFree, fewer, noEsc, v: kmh / 3.6, scale: kmh / TIME.walkKmh, active };
  }

  // Seconds and steering cost of a whole edge in one direction
  function edgeCost(P, e, fwd, S) {
    const k = P.kind[e], L = P.L[e], dz = fwd ? P.dz[e] : -P.dz[e], h = Math.abs(dz);
    let time = 0, extra = 0;
    if (k === WALK || k === RAMP) {
      let g = P.incl[e];
      g = isFinite(g) ? (fwd ? g : -g) : 0;
      let f = Math.exp(-3.5 * Math.abs(g + 0.05)) / Math.exp(-3.5 * 0.05);
      f = Math.min(1.15, Math.max(0.3, f));
      time = L / (S.v * f);
      if (g > 0.02) extra += TIME.climbEffort * g * L;
    } else if (k === STAIRS) {
      const sl = Math.hypot(L, h);
      const vert = (dz >= 0 ? TIME.stairsUpVert : TIME.stairsDownVert) * S.scale;
      time = Math.max(h / vert, sl / S.v);
      extra += h * (dz >= 0 ? TIME.stairsUpEffort : TIME.stairsDownEffort);
      if (S.fewer) extra += (TIME.fewerStairsFactor - 1) * time;
    } else if (k === ESC) {
      const hl = Math.max(L, h * TIME.escalatorSlope);
      time = Math.hypot(hl, h) / TIME.escalatorSpeed;
    } else if (k === LIFT) {
      time = TIME.liftPerEdge + h / TIME.liftSpeed;
    }
    return [time, extra];
  }
  const changesLevel = (P, e) => Math.abs(P.dz[e]) > 0.5 || P.kind[e] === LIFT;

  function runSearch(P, model, src, dst, S) {
    const E = P.E, B = 2 * E, SN = P.N, TN = P.N + 1;
    // Base arc costs for these preferences
    const bCost = new Float64Array(B), bTime = new Float64Array(B);
    for (let e = 0; e < E; e++) {
      if (!P.ok[e]) continue;
      const f = edgeCost(P, e, true, S), r = edgeCost(P, e, false, S);
      bTime[2 * e] = f[0]; bCost[2 * e] = f[0] + f[1];
      bTime[2 * e + 1] = r[0]; bCost[2 * e + 1] = r[0] + r[1];
    }
    // Virtual arcs: start S → graph, graph → end T (partial edges for snapped points)
    // vCs / vCd: index of the start / end candidate an arc belongs to
    const vF = [], vT = [], vE = [], vS0 = [], vS1 = [], vCs = [], vCd = [];
    const extra = new Map(), sOut = [];
    const addV = (from, to, e, s0, s1, cs, cd) => {
      const id = B + vF.length;
      vF.push(from); vT.push(to); vE.push(e); vS0.push(s0); vS1.push(s1); vCs.push(cs); vCd.push(cd);
      if (from === SN) sOut.push(id);
      else { if (!extra.has(from)) extra.set(from, []); extra.get(from).push(id); }
    };
    src.forEach((c, ci) => {
      if (c.node != null) addV(SN, c.node, -1, 0, 0, ci, -1);
      else {
        addV(SN, P.EB[c.edge], c.edge, c.s, 1, ci, -1);
        if (!P.oneway[c.edge]) addV(SN, P.EA[c.edge], c.edge, c.s, 0, ci, -1);
      }
    });
    dst.forEach((c, ci) => {
      if (c.node != null) addV(c.node, TN, -1, 0, 0, -1, ci);
      else {
        addV(P.EA[c.edge], TN, c.edge, 0, c.s, -1, ci);
        if (!P.oneway[c.edge]) addV(P.EB[c.edge], TN, c.edge, 1, c.s, -1, ci);
      }
    });
    src.forEach((a, ai) => dst.forEach((b, bi) => {
      if (a.edge == null || a.edge !== b.edge) return;
      if (b.s >= a.s || !P.oneway[a.edge]) addV(SN, TN, a.edge, a.s, b.s, ai, bi);
    }));
    const nA = B + vF.length;
    const arcEdge = (id) => (id < B ? id >> 1 : vE[id - B]);
    const arcFwd = (id) => (id < B ? (id & 1) === 0 : vS1[id - B] >= vS0[id - B]);
    const arcFrac = (id) => (id < B ? 1 : Math.abs(vS1[id - B] - vS0[id - B]));
    const arcTo = (id) => (id < B ? (id & 1 ? P.EA[id >> 1] : P.EB[id >> 1]) : vT[id - B]);
    const arcKind = (id) => { const e = arcEdge(id); return e < 0 ? NONE : P.kind[e]; };
    const arcCost = (id) => {
      if (id < B) return bCost[id];
      const e = vE[id - B];
      return e < 0 ? 0 : arcFrac(id) * bCost[2 * e + (arcFwd(id) ? 0 : 1)];
    };
    const arcTime = (id) => {
      if (id < B) return bTime[id];
      const e = vE[id - B];
      return e < 0 ? 0 : arcFrac(id) * bTime[2 * e + (arcFwd(id) ? 0 : 1)];
    };
    const arcHead = (id) => {
      const e = arcEdge(id);
      if (e < 0 || P.L[e] * arcFrac(id) < 0.3) return NaN;
      return arcFwd(id) ? P.hd[e] : P.hd[e] + Math.PI;
    };
    const arcMask = (id) => { const e = arcEdge(id); return e < 0 ? 0 : P.vmask[e]; };
    const W = TIME.violation;
    // Cost (or, with real = true, only the real seconds) of going on from arc i (-1: start) into arc o
    const trans = (i, o, real) => {
      const ki = i < 0 ? NONE : arcKind(i), ko = arcKind(o);
      if (ko === NONE) return 0;
      let t = 0, c = 0;
      const eo = arcEdge(o);
      if (ko !== ki) {
        if (ko === ESC) t += TIME.escalatorBoard;
        if (ko === LIFT) t += TIME.liftWait;
        if (ko !== WALK && changesLevel(P, eo)) c += TIME.levelChange;
        if (ko === STAIRS && S.fewer) c += TIME.fewerStairsEntry;
      }
      if (real) return t;
      const nm = arcMask(o) & ~(i < 0 ? 0 : arcMask(i)) & S.active;
      if (nm) {
        if (nm & V_STAIRS) c += W.stairs;
        if (nm & V_ESC) c += W.escalator;
        if (nm & V_WCF) c += W.wheelchair;
        if (nm & V_STEEP) c += W.steep;
      }
      if (i >= 0 && ki !== LIFT && ko !== LIFT) {
        const h1 = arcHead(i), h2 = arcHead(o);
        if (h1 === h1 && h2 === h2) {
          const a = Math.abs(angleDiff(h1, h2)) * DEG;
          if (a > TIME.turnFrom) c += TIME.turnMax * (a - TIME.turnFrom) / (180 - TIME.turnFrom);
        }
        const ei = arcEdge(i);
        if (ki === WALK && ko === WALK && P.outdoor[ei] !== P.outdoor[eo]) c += TIME.outdoorSwitch;
      }
      return c + t;
    };

    const dist = new Float64Array(nA).fill(Infinity);
    const prev = new Int32Array(nA).fill(-1);
    const heap = new Heap();
    for (const a of sOut) {
      const d = trans(-1, a) + arcCost(a);
      if (d < dist[a]) { dist[a] = d; heap.push(d, a); }
    }
    let goal = -1;
    while (heap.k.length) {
      const a = heap.pop();
      const d = heap.lastKey;
      if (d > dist[a]) continue;
      const v = arcTo(a);
      if (v === TN) { goal = a; break; }
      const ea = arcEdge(a), fa = arcFwd(a);
      const lists = [v < P.N ? P.outs[v] : null, extra.get(v)];
      for (const list of lists) {
        if (!list) continue;
        for (const b of list) {
          const eb = arcEdge(b);
          if (eb >= 0 && eb === ea && arcFwd(b) !== fa) continue; // no turning back on the same edge
          const nd = d + trans(a, b) + arcCost(b);
          if (nd < dist[b]) { dist[b] = nd; prev[b] = a; heap.push(nd, b); }
        }
      }
    }
    if (goal < 0) return null;
    const arcs = [];
    for (let a = goal; a >= 0; a = prev[a]) arcs.push(a);
    arcs.reverse();

    // Geometry of each arc
    const pointOn = (e, s) => {
      const pa = P.nodes[P.EA[e]], pb = P.nodes[P.EB[e]];
      return [pa[0] + s * (pb[0] - pa[0]), pa[1] + s * (pb[1] - pa[1]), (pa[2] || 0) + s * ((pb[2] || 0) - (pa[2] || 0))];
    };
    const arcFromPoint = (id) => {
      if (id < B) return P.nodes[id & 1 ? P.EB[id >> 1] : P.EA[id >> 1]].slice(0, 3);
      const j = id - B;
      if (vE[j] >= 0) return pointOn(vE[j], vS0[j]);
      return vF[j] === SN ? src[vCs[j]].point.slice() : P.nodes[vF[j]].slice(0, 3);
    };
    const arcToPoint = (id) => {
      if (id < B) return P.nodes[id & 1 ? P.EA[id >> 1] : P.EB[id >> 1]].slice(0, 3);
      const j = id - B;
      if (vE[j] >= 0) return pointOn(vE[j], vS1[j]);
      return vT[j] === TN ? dst[vCd[j]].point.slice() : P.nodes[vT[j]].slice(0, 3);
    };
    const pts = [], segs = [], nodesOut = [];
    let used = 0, pendingTime = 0;
    const same = (p, q) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6 && Math.abs(p[2] - q[2]) < 1e-6;
    arcs.forEach((a, i) => {
      const p0 = arcFromPoint(a), p1 = arcToPoint(a);
      if (!pts.length) pts.push(p0);
      const to = a < B ? (a & 1 ? P.EA[a >> 1] : P.EB[a >> 1]) : vT[a - B];
      const fromN = a < B ? (a & 1 ? P.EB[a >> 1] : P.EA[a >> 1]) : vF[a - B];
      if (!nodesOut.length && fromN < P.N) nodesOut.push(fromN);
      if (to < P.N && nodesOut[nodesOut.length - 1] !== to) nodesOut.push(to);
      const t = trans(i ? arcs[i - 1] : -1, a, true) + arcTime(a);
      used |= arcMask(a) & S.active;
      if (same(pts[pts.length - 1], p1)) { pendingTime += t; return; }
      const e = arcEdge(a), k = arcKind(a);
      const hl = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const dzs = P.zf(p1[2]) - P.zf(p0[2]);
      const len = k === LIFT ? 0 : k === WALK ? (e >= 0 ? P.L[e] * arcFrac(a) : hl) : Math.hypot(e >= 0 ? P.L[e] * arcFrac(a) : hl, dzs);
      segs.push({ kind: KIND_NAMES[k === NONE ? WALK : k], edge: e, len, hlen: hl, time: t + pendingTime, dz: dzs,
        l0: p0[2], l1: p1[2], outdoor: e >= 0 ? !!P.outdoor[e] : false, warn: !!(arcMask(a) & S.active) });
      pendingTime = 0;
      pts.push(p1);
    });
    if (pendingTime && segs.length) segs[segs.length - 1].time += pendingTime;
    return { pts, segs, nodes: nodesOut, used, srcCand: src[vCs[arcs[0] - B]] || src[0], dstCand: dst[vCd[goal - B]] || dst[0] };
  }

  // ---------- Words ----------
  const levelShort = (l) => (l < 0 ? '−' + -l : String(l));
  const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`);
  const GENERIC = /^(the )?(underpass|subway|overpass|platforms?|platform level|concourse|hall|station hall|main hall|ticket hall|passage|passageway|tunnel|footbridge|bridge|mezzanine|gallery|basement|lower level|upper level|lower floor|upper floor|ground floor|first floor|shopping level|shops|mall|shopping centre|car park|parking|bus station|tram stop|forecourt|square|station square|terrace|deck|roof|east wing|west wing)$/;
  // A name as it reads after "to" / "through": "Underpass" → "the underpass", "Underpass and shops" → "the underpass
  // and shops", "Welle and gallery" → "Welle and the gallery", "PostAuto deck" → "the PostAuto deck",
  // "Level -3" → "level −3", "RBS station" / "Bahnhofplatz" / "Grosse Schanze, lower terrace" unchanged.
  const GENERIC_TAIL = /^[A-ZÄÖÜ][\w-]*\s+(deck|terrace|hall|underpass|overpass|passage|concourse|gallery|footbridge|mezzanine)$/;
  function articledOne(name, first) {
    const n = String(name).trim(), low = n.toLowerCase();
    const lv = /^level\s*(-?\d+)$/.exec(low);
    if (lv) return `level ${levelShort(+lv[1])}`;
    if (/^(street|ground|track|platform) level$/.test(low)) return low;
    if (GENERIC.test(low)) return (first ? 'the ' : '') + low.replace(/^the /, '');
    if (first && !n.includes(',') && GENERIC_TAIL.test(n)) return 'the ' + n;
    return n;
  }
  function articled(name) {
    const parts = String(name).trim().split(/\s+and\s+/);
    if (parts.length === 1) return articledOne(parts[0], true);
    const firstGeneric = GENERIC.test(parts[0].trim().toLowerCase());
    return parts.map((p, i) => {
      if (i === 0) return articledOne(p, true);
      // "the underpass and shops" (one article for both), "Welle and the gallery"
      return GENERIC.test(p.trim().toLowerCase()) ? articledOne(p, !firstGeneric) : articledOne(p, false);
    }).join(' and ');
  }
  function levelObj(model, level) {
    let best = null;
    for (const l of model.levels || []) if (!best || Math.abs(l.id - level) < Math.abs(best.id - level)) best = l;
    return best && Math.abs(best.id - level) < 0.5 ? best : null;
  }
  function levelName(model, level) {
    const l = levelObj(model, level);
    return l && l.name ? articled(l.name) : `level ${levelShort(Math.round(level))}`;
  }
  const isNumRef = (r) => /^\d+$/.test(platformKey(r));
  function platformRefs(area) {
    const keys = [...new Set((area.refs || []).map(platformKey).filter(Boolean))];
    return keys.sort((a, b) => (+a || 0) - (+b || 0) || (a < b ? -1 : 1));
  }
  function nounFor(stop) {
    const m = stop && stop.mode;
    return m === 'train' || m === 'cable' || m === 'cableway' || m === 'rack' || m === 'funicular' ? 'Platform' : m === 'boat' || m === 'ship' ? 'Pier' : 'Bay';
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // Where a walk piece is: platform area > named floor / square > named edge > a named lower or upper level
  // keys: platform refs the walk starts / ends at, so "platform 7/8" reads "platform 7" on the right one
  const normName = (s) => String(s).toLowerCase().replace(/[^0-9a-zà-ÿ]+/g, ' ').trim();
  // "Bern", "Bern, Hauptbahnhof", "Bern Bahnhof", "Bern Hbf" …: names that just say "this station"
  function isStationName(P, name) {
    if (!P.stationNames) {
      P.stationNames = new Set([P.model.name, ...(P.model.stops || []).map((s) => s.name)].filter(Boolean).map(normName));
    }
    const n = normName(name);
    if (P.stationNames.has(n)) return true;
    const base = normName(P.model.name || '');
    return !!base && new RegExp(`^${base} (bahnhof|hauptbahnhof|hbf|bhf|station|gare|stazione)$`).test(n);
  }
  function placeOf(P, model, p, q, edge, keys) {
    const lv = (p[2] + q[2]) / 2;
    const A = areaAt(P, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2, lv);
    // same words, same place (a named floor area and its level name do not split a walk)
    const mk = (kind, text, prep, refs) => ({ key: text ? 'T' + text.toLowerCase() : '', kind, text, prep, refs });
    if (A && A.kind === 'platform') {
      const refs = platformRefs(A);
      if (refs.length && refs.every(isNumRef)) {
        const k = keys.find((x) => x && refs.includes(x));
        return Object.assign(mk('platform', `platform ${k || refs.join('/')}`, 'along', refs), { key: 'P' + refs.join('/') });
      }
      // a bus / tram stop area is usually named after the stop ("Bern Bahnhof"): no help in a station
      if (A.name && !isStationName(P, A.name)) return mk('platform', A.name, 'along', refs);
      return Object.assign(mk('platform', '', '', refs), { key: 'P' + refs.join('/') });
    }
    if (A && A.name) return mk(A.kind === 'plaza' ? 'plaza' : 'floor', articled(A.name), A.kind === 'plaza' ? 'across' : 'through');
    const ed = edge >= 0 ? P.edges[edge] : null;
    if (ed && ed.name && !isStationName(P, ed.name)) return mk('edge', articled(ed.name), 'along');
    const lr = Math.round(lv);
    if (lr !== 0) {
      const l = levelObj(model, lr);
      if (l && l.name) return mk('level', articled(l.name), /(deck|terrace|square|platz|plaza)$/i.test(l.name) ? 'across' : 'through');
    }
    return mk('', '', '');
  }

  function turnOf(deg) {
    const a = Math.abs(deg);
    if (a < 30) return 'straight';
    if (a > 150) return 'around';
    if (a < 60) return deg > 0 ? 'bear-left' : 'bear-right';
    return deg > 0 ? 'left' : 'right';
  }
  const TURN_WORDS = { left: 'Turn left', right: 'Turn right', 'bear-left': 'Bear left', 'bear-right': 'Bear right', around: 'Turn around', straight: 'Keep straight on' };

  // ---------- Steps ----------
  function buildSteps(P, model, pts, segs, ctx) {
    const MIN_FRAG = 10, MIN_PLACE = 15, MIN_TURN = 20;
    const segDir = (s) => {
      if (s.kind === 'walk') return null;
      const dl = s.l1 - s.l0;
      if (Math.abs(dl) > 1e-6) return dl > 0 ? 'up' : 'down';
      if (Math.abs(s.dz) > 0.2) return s.dz > 0 ? 'up' : 'down';
      return null;
    };
    // 1. Runs of one kind and direction
    let runs = [];
    segs.forEach((s, i) => {
      const d = segDir(s), r = runs[runs.length - 1];
      if (r && r.kind === s.kind && r.dir === d) { r.b = i + 1; r.len += s.len; }
      else runs.push({ kind: s.kind, dir: d, a: i, b: i + 1, len: s.len });
    });
    // 2. Tiny walk fragments: a landing between two flights joins them; otherwise it joins the level change next to it
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 0; i < runs.length; i++) {
        const r = runs[i];
        if (r.kind !== 'walk' || r.len >= MIN_FRAG || runs.length === 1) continue;
        const p = runs[i - 1], n = runs[i + 1];
        if (p && n && p.kind === n.kind && p.dir === n.dir) {
          runs.splice(i - 1, 3, { kind: p.kind, dir: p.dir, a: p.a, b: n.b, len: p.len + r.len + n.len });
        } else if (p) {
          p.b = r.b; p.len += r.len; runs.splice(i, 1);
        } else if (n) {
          n.a = r.a; n.len += r.len; runs.splice(i, 1);
        } else continue;
        changed = true;
        break;
      }
    }
    // 3. Split long walks where the place changes or the path bends clearly
    const targetKey = ctx.toStop ? platformKey(ctx.toStop.ref) : '';
    const fromKey = ctx.fromStop ? platformKey(ctx.fromStop.ref) : '';
    const half = segs.reduce((a, s) => a + s.len, 0) / 2;
    let acc0 = 0;
    const place = segs.map((s, i) => {
      const keys = acc0 < half ? [fromKey, targetKey] : [targetKey, fromKey];
      acc0 += s.len;
      return s.kind === 'walk' ? placeOf(P, model, pts[i], pts[i + 1], s.edge, keys) : null;
    });
    const heading = (i, back, limit, win = 10) => {
      // direction over up to win m of horizontal path before (back) / after point i, within seg range limit [a, b)
      let d = 0, j = i;
      const [x, y] = pts[i];
      let px = x, py = y;
      for (;;) {
        const k = back ? j - 1 : j;
        if (k < limit[0] || k >= limit[1]) break;
        const s = segs[k];
        if (s.kind === 'elevator') break;
        j = back ? j - 1 : j + 1;
        px = pts[j][0]; py = pts[j][1];
        d += s.hlen;
        if (d >= win) break;
      }
      if (d < Math.min(2, win)) return NaN;
      return back ? Math.atan2(y - py, x - px) : Math.atan2(py - y, px - x);
    };
    const out = [];
    for (const r of runs) {
      if (r.kind !== 'walk') { out.push(r); continue; }
      // by place
      let parts = [];
      for (let i = r.a; i < r.b; i++) {
        const k = place[i].key, last = parts[parts.length - 1];
        if (last && last.key === k) { last.b = i + 1; last.len += segs[i].len; }
        else parts.push({ key: k, a: i, b: i + 1, len: segs[i].len });
      }
      for (let changed = true; changed && parts.length > 1;) {
        changed = false;
        let mi = -1;
        parts.forEach((p, i) => { if (p.len < MIN_PLACE && (mi < 0 || p.len < parts[mi].len)) mi = i; });
        if (mi < 0) break;
        const p = parts[mi], prev = parts[mi - 1], next = parts[mi + 1];
        const into = !prev ? next : !next ? prev : (prev.len >= next.len ? prev : next);
        into.a = Math.min(into.a, p.a); into.b = Math.max(into.b, p.b); into.len += p.len;
        parts.splice(mi, 1);
        // neighbours with the same place now touch
        for (let i = 1; i < parts.length; i++) if (parts[i].key === parts[i - 1].key) { parts[i - 1].b = parts[i].b; parts[i - 1].len += parts[i].len; parts.splice(i, 1); i--; }
        changed = true;
      }
      // by bends
      for (const p of parts) {
        let start = p.a, along = 0, total = 0;
        for (let i = p.a; i < p.b; i++) total += segs[i].len;
        let acc = 0;
        const cut = [];
        for (let i = p.a + 1; i < p.b; i++) {
          acc += segs[i - 1].len;
          if (acc - along < MIN_TURN || total - acc < MIN_TURN) continue;
          const h1 = heading(i, true, [p.a, p.b]), h2 = heading(i, false, [p.a, p.b]);
          if (!(h1 === h1 && h2 === h2)) continue;
          const a = Math.abs(angleDiff(h1, h2)) * DEG;
          if (a < 45) continue;
          // take the sharpest point of this bend (within the next 10 m)
          let bi = i, ba = a, acc2 = acc;
          for (let j = i + 1; j < p.b && acc2 + segs[j - 1].len - acc <= 10; j++) {
            acc2 += segs[j - 1].len;
            if (total - acc2 < MIN_TURN) break;
            const g1 = heading(j, true, [p.a, p.b]), g2 = heading(j, false, [p.a, p.b]);
            const aj = Math.abs(angleDiff(g1, g2)) * DEG;
            if (aj > ba) { ba = aj; bi = j; }
          }
          let accAtBi = acc;
          for (let j = i; j < bi; j++) accAtBi += segs[j].len;
          cut.push(bi);
          along = accAtBi; acc = accAtBi; i = bi;
        }
        cut.push(p.b);
        for (const c of cut) {
          let len = 0;
          for (let i = start; i < c; i++) len += segs[i].len;
          out.push({ kind: 'walk', dir: null, a: start, b: c, len });
          start = c;
        }
      }
    }
    runs = out;

    // 4. Text
    const steps = [];
    const sumT = (r) => { let t = 0; for (let i = r.a; i < r.b; i++) t += segs[i].time; return t; };
    const bestPlace = (r) => {
      const m = new Map();
      for (let i = r.a; i < r.b; i++) { const p = place[i]; if (p) m.set(p.key, (m.get(p.key) || 0) + segs[i].len); }
      let bk = null, bl = -1;
      m.forEach((l, k) => { if (l > bl) { bl = l; bk = k; } });
      for (let i = r.a; i < r.b; i++) if (place[i] && place[i].key === bk) return place[i];
      return null;
    };
    const lastWalk = (() => { for (let i = runs.length - 1; i >= 0; i--) if (runs[i].kind === 'walk') return i === runs.length - 1 ? i : -1; return -1; })();
    const sectors = (model.sectors || []).filter((s) => targetKey && platformKey(s.ref) === targetKey && s.xy);
    const endPt = pts[pts.length - 1];
    let arriveSector = null;
    if (sectors.length) {
      let best = null, bd = Infinity;
      for (const s of sectors) { const d = Math.hypot(s.xy[0] - endPt[0], s.xy[1] - endPt[1]); if (d < bd) { bd = d; best = s; } }
      if (best && bd <= 30) arriveSector = best;
    }
    runs.forEach((r, ri) => {
      const from = r.a, to = r.b;
      const level = pts[from][2], toLevel = pts[to][2];
      const st = { kind: r.kind, from, to, level, toLevel, dir: r.dir, len: Math.round(r.len), seconds: Math.round(sumT(r)), text: '' };
      if (segs.slice(r.a, r.b).some((s) => s.warn)) st.warn = true;
      // turn hint from the geometry around the start of this step
      let turn = null;
      if (ri > 0 && r.kind !== 'elevator' && runs[ri - 1].kind !== 'elevator') {
        const pr = runs[ri - 1];
        // a level change: the way its first piece points (stairs turn on their landings)
        const h1 = heading(from, true, [pr.a, pr.b]), h2 = heading(from, false, r.kind === 'walk' ? [r.a, r.b] : [r.a, r.a + 1], r.kind === 'walk' ? 10 : 0.3);
        if (h1 === h1 && h2 === h2) turn = turnOf(angleDiff(h1, h2) * DEG);
      }
      if (turn) st.turn = turn;
      if (r.kind === 'walk') {
        const pl = bestPlace(r);
        let tail = '';
        if (pl && pl.text) { tail = ` ${pl.prep ? pl.prep + ' ' : ''}${pl.text}`; st.place = pl.text; }
        if (ri === lastWalk && arriveSector && pl && pl.kind === 'platform') {
          // only when the walk actually goes some way along the platform towards it
          const s0 = pts[from];
          if (Math.hypot(arriveSector.xy[0] - s0[0], arriveSector.xy[1] - s0[1]) > 12) tail += ` to sector ${arriveSector.name}`;
        }
        const d = fmtDist(r.len);
        if (turn === 'straight' && ri > 0 && runs[ri - 1].kind === 'walk') st.text = `Keep straight on for ${d}${tail}`;
        else if (turn && turn !== 'straight') st.text = `${TURN_WORDS[turn]} and walk ${d}${tail}`;
        else st.text = `Walk ${d}${tail}`;
      } else {
        const noun = { stairs: 'the stairs', escalator: 'the escalator', ramp: 'the ramp', elevator: 'the lift' }[r.kind];
        let dest = '';
        const fromL = Math.round(level), toL = Math.round(toLevel);
        if (fromL !== toL) {
          // a train platform where it comes out (or where the next walk goes along), else the level's name
          const A = areaAt(P, pts[to][0], pts[to][1], toLevel);
          let refs = A && A.kind === 'platform' ? platformRefs(A) : [];
          const nx = runs[ri + 1];
          const np = nx && nx.kind === 'walk' ? bestPlace(nx) : null;
          if (!refs.length && np && np.kind === 'platform') refs = np.refs || [];
          if (refs.length && refs.every(isNumRef)) {
            dest = ` to platform ${targetKey && refs.includes(targetKey) ? targetKey : refs.join('/')}`;
          } else dest = ` to ${levelName(model, toLevel)}`;
        }
        const verb = r.kind === 'stairs' && fromL === toL && r.len < 6 ? `take the steps` : `take ${noun}`;
        const dir = r.dir ? ` ${r.dir}` : '';
        const pre = turn === 'left' || turn === 'right' || turn === 'around' ? `${TURN_WORDS[turn]} and ` : '';
        st.text = cap(`${pre}${verb}${dir}${dest}`);
      }
      steps.push(st);
    });
    // 5. Arrive
    const last = pts.length - 1;
    const arrive = { kind: 'arrive', from: last, to: last, level: pts[last][2], toLevel: pts[last][2], dir: null, len: 0, seconds: 0, text: ctx.label || 'Arrive' };
    if (arriveSector) arrive.sector = arriveSector.name;
    steps.push(arrive);
    return steps;
  }

  function endLabel(model, cand) {
    if (!cand) return null;
    let s = cand.stop;
    if (!s && cand.node != null) s = (model.stops || []).find((x) => x.node === cand.node);
    if (s) return s.ref ? `${nounFor(s)} ${s.ref}` : s.name || null;
    let en = cand.entrance;
    if (!en && cand.node != null) en = (model.entrances || []).find((x) => x.node === cand.node);
    if (en) return en.name || 'Exit';
    return null;
  }

  // ---------- route ----------
  function route(model, from, to, prefs) {
    if (!model || !model.graph) return null;
    const P = prepare(model);
    const src = resolve(model, from), dst = resolve(model, to);
    if (!src.length || !dst.length) return null;
    const S = settings(prefs);
    const r = runSearch(P, model, src, dst, S);
    if (!r) return null;
    const { pts, segs } = r;
    const dc = r.dstCand;
    const toStop = dc && (dc.stop || (dc.node != null ? (model.stops || []).find((x) => x.node === dc.node) : null));
    const sc = r.srcCand;
    const fromStop = sc && (sc.stop || (sc.node != null ? (model.stops || []).find((x) => x.node === sc.node) : null));
    const steps = buildSteps(P, model, pts, segs, { toStop, fromStop, label: endLabel(model, dc) || 'Arrive' });
    const dists = [0];
    let length = 0, seconds = 0;
    for (const s of segs) { length += s.len; seconds += s.time; dists.push(Math.round(length * 100) / 100); }
    const rd = (v) => Math.round(v * 100) / 100;
    const out = {
      points: pts.map((p) => [rd(p[0]), rd(p[1]), rd(p[2])]),
      nodes: r.nodes,
      length: Math.round(length),
      seconds: Math.round(seconds),
      steps,
      dists,
      edges: segs.map((s) => s.edge),
    };
    if (r.srcCand && r.srcCand.stop) out.fromStop = r.srcCand.stop;
    if (r.dstCand && r.dstCand.stop) out.toStop = r.dstCand.stop;
    const relaxed = [];
    if (r.used & (V_WCF | V_STEEP) || (S.wheel && r.used & (V_STAIRS | V_ESC))) relaxed.push('wheelchair');
    if (S.stepFree && r.used & (V_STAIRS | V_ESC)) relaxed.push('stepFree');
    if (S.noEsc && r.used & V_ESC) relaxed.push('noEscalators');
    if (relaxed.length) {
      out.relaxed = relaxed;
      const what = [];
      if (r.used & V_STAIRS) what.push('stairs');
      if (r.used & V_ESC) what.push('an escalator');
      if (r.used & V_WCF) what.push('a part marked not suitable for wheelchairs');
      if (r.used & V_STEEP) what.push('a steep slope');
      const lead = S.wheel ? 'No wheelchair-accessible way here' : S.stepFree ? 'No step-free way here' : 'No way here without escalators';
      out.notice = `${lead}: this route has ${what.join(' and ')}.`;
    }
    return out;
  }

  // ---------- Position on a route ----------
  function dists(route) {
    if (route.dists && route.dists.length === route.points.length) return route.dists;
    const d = [0];
    for (let i = 1; i < route.points.length; i++) {
      const p = route.points[i - 1], q = route.points[i];
      d.push(d[i - 1] + Math.hypot(q[0] - p[0], q[1] - p[1]));
    }
    return d;
  }
  const climbCache = new WeakMap();
  function climbs(route) {
    let c = climbCache.get(route);
    if (c && c.length === route.points.length) return c;
    const pts = route.points;
    c = [0];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i];
      const flat = Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.05; // a lift
      c.push(c[i - 1] + (flat ? 0 : Math.abs(q[2] - p[2])));
    }
    climbCache.set(route, c);
    return c;
  }
  function stepAt(route, index) {
    const st = route.steps || [];
    for (let i = 0; i < st.length; i++) if (st[i].kind !== 'arrive' && index >= st[i].from && index < st[i].to) return i;
    return Math.max(0, st.length - 1);
  }

  function snap(model, route, xy, hint) {
    if (!route || !route.points || !route.points.length) return null;
    if (xy && !Array.isArray(xy) && xy.ll) xy = toLocal(model, xy.ll);
    const pts = route.points, D = dists(route), total = D[D.length - 1];
    let hl = null, prev = null;
    // A previous result keeps the position continuous along the route (which also keeps it on the right one of two
    // floors that overlap in plan, and lets it change floor in a lift); a level number only when the caller knows it.
    if (typeof hint === 'number' && isFinite(hint)) hl = hint;
    else if (hint && typeof hint === 'object') {
      if (isFinite(hint.along)) prev = hint;
      if (isFinite(hint.level)) hl = +hint.level;
    }
    const x = xy[0], y = xy[1];
    if (pts.length === 1) {
      return { index: 0, t: 0, point: pts[0].slice(), dist: Math.hypot(x - pts[0][0], y - pts[0][1]), along: 0, remaining: 0, step: stepAt(route, 0) };
    }
    // climb[i]: levels changed on stairs, escalators and ramps before point i (lifts do not count: they have no
    // length, so the next fix can be on the new floor). Moving between two fixes may change floor only by about as
    // much as the route climbs in between, so a fix cannot hop onto the floor above or below the way it is going.
    const CL = climbs(route);
    const climbAt = (i, t) => CL[i] + t * (CL[i + 1] - CL[i]);
    let prevClimb = 0;
    if (prev) {
      let pi = Number.isInteger(prev.index) && prev.index >= 0 && prev.index < pts.length - 1 ? prev.index : -1, pt = isFinite(prev.t) ? prev.t : 0;
      if (pi < 0) {
        pi = 0;
        while (pi < pts.length - 2 && D[pi + 1] < prev.along) pi++;
        pt = D[pi + 1] > D[pi] ? Math.min(1, Math.max(0, (prev.along - D[pi]) / (D[pi + 1] - D[pi]))) : 0;
      }
      prevClimb = climbAt(pi, pt);
      if (!Number.isInteger(prev.index)) prev = Object.assign({}, prev, { index: pi });
    }
    let best = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      const dx = q[0] - p[0], dy = q[1] - p[1], l2 = dx * dx + dy * dy;
      let t;
      if (l2 > 1e-6) t = ((x - p[0]) * dx + (y - p[1]) * dy) / l2;
      else if (hl != null && q[2] !== p[2]) t = (hl - p[2]) / (q[2] - p[2]);
      else if (prev) t = prev.index >= i ? 1 : 0; // in a lift: at the floor you are going to once past it
      else t = 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = p[0] + t * dx, py = p[1] + t * dy, lv = p[2] + t * (q[2] - p[2]);
      const d = Math.hypot(x - px, y - py);
      const along = D[i] + t * (D[i + 1] - D[i]);
      let score = d;
      if (hl != null) score += 10 * Math.max(0, Math.abs(lv - hl) - 0.3);
      if (prev) {
        const jump = along - prev.along;
        if (jump < -3) score += 0.5 * (-jump - 3);
        else if (jump > 30) score += 0.2 * (jump - 30);
        const hop = Math.abs(climbAt(i, t) - prevClimb);
        if (hop > 0.3) score += 15 * (hop - 0.3);
      }
      if (!best || score < best.score - 1e-9) best = { score, index: i, t, point: [px, py, lv], dist: d, along };
    }
    return { index: best.index, t: best.t, point: best.point, dist: best.dist, along: best.along, remaining: Math.max(0, total - best.along), step: stepAt(route, best.index) };
  }

  function pointAt(route, m) {
    const pts = route.points, D = dists(route);
    if (!pts.length) return null;
    if (!(m > 0)) return pts[0].slice();
    if (m >= D[D.length - 1]) return pts[pts.length - 1].slice();
    let lo = 0, hi = D.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (D[mid] <= m) lo = mid; else hi = mid; }
    const seg = D[hi] - D[lo], t = seg > 0 ? (m - D[lo]) / seg : 0;
    const p = pts[lo], q = pts[hi];
    return [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])];
  }

  const api = { toLocal, toLngLat, z, route, snap, pointAt, resolve, platformKey, levelName, TIME };
  root.StationRoute = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
