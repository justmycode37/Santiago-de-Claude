// Exact walking routes between and around buildings, on the pedestrian network in walkgraph/ (tools/build_walkgraph.py).
//
// Car-style routers snap both ends to the nearest street and join them with straight lines, which then cut through
// buildings, and they go round squares instead of across. This router knows sidewalks, crossings, steps, lifts,
// arcades, passages through buildings, underpasses, station corridors and floors, and the doors of every building:
//   - a walk ends at a door of the building you are going to (the best one for the route, not just the nearest),
//     and starts from the door of the building you are in, or from the nearest path you can actually reach;
//   - squares and platforms are crossed in a straight line;
//   - step-free / fewer-stairs settings avoid steps and raised kerbs.
// Where the network has no tiles, WALKROUTE.route() answers null and the app uses its online router instead.
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ geometry (local metres)
  const KY = 110540;
  const kx = (lat) => 111320 * Math.cos(lat * Math.PI / 180);
  function distM(a, b) {
    return Math.hypot((a[0] - b[0]) * kx((a[1] + b[1]) / 2), (a[1] - b[1]) * KY);
  }
  // closest point to p on a→b → { d (m), t (0…1), q ([lon, lat]) }
  function project(p, a, b) {
    const k = kx(p[1]);
    const ax = (a[0] - p[0]) * k, ay = (a[1] - p[1]) * KY, dx = (b[0] - a[0]) * k, dy = (b[1] - a[1]) * KY;
    const L2 = dx * dx + dy * dy;
    const t = L2 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / L2)) : 0;
    return { d: Math.hypot(ax + dx * t, ay + dy * t), t, q: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
  }
  function crosses(p1, p2, q1, q2) {
    const c = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const d1 = c(q1, q2, p1), d2 = c(q1, q2, p2), d3 = c(p1, p2, q1), d4 = c(p1, p2, q2);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }
  function inside(p, ring) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[j];
      if ((y1 > p[1]) !== (y2 > p[1]) && p[0] < (x2 - x1) * (p[1] - y1) / (y2 - y1) + x1) c = !c;
    }
    return c;
  }
  function parseLevels(l) {
    if (l == null) return null;
    const out = [];
    String(l).split(';').forEach((part) => {
      const m = /^(-?\d+(?:\.\d+)?)(?:-(-?\d+(?:\.\d+)?))?$/.exec(part.trim());
      if (!m) return;
      if (m[2] == null) out.push(+m[1]);
      else for (let x = Math.floor(Math.min(+m[1], +m[2])); x <= Math.ceil(Math.max(+m[1], +m[2])); x++) out.push(x);
    });
    return out.length ? out : null;
  }

  // ------------------------------------------------------------------ the network, built from the tiles that are loaded
  const nodes = new Map();      // osm id → { id, ll, adj: [edge], blocked, kerb, lift }
  const seenWays = new Set();
  const seenShort = new Set();
  const seenRail = new Set();
  const buildings = new Map();  // id → { id, ring, bb, entrances: [] }
  const entrances = new Map();  // node id → { node, bld, type, wc, addr }
  const ECELL = 0.0003;         // edge grid (~23 m × 33 m)
  const BCELL = 0.001;          // building grid
  const egrid = new Map(), bgrid = new Map(), rgrid = new Map(); // rgrid: railway tracks on the ground
  function gridAdd(grid, s, bb, item) {
    for (let x = Math.floor(bb[0] / s); x <= Math.floor(bb[2] / s); x++)
      for (let y = Math.floor(bb[1] / s); y <= Math.floor(bb[3] / s); y++) {
        const k = x + ',' + y;
        let l = grid.get(k);
        if (!l) grid.set(k, (l = []));
        l.push(item);
      }
  }
  function gridNear(grid, s, p, rM) {
    const dx = rM / kx(p[1]), dy = rM / KY, out = new Set();
    for (let x = Math.floor((p[0] - dx) / s); x <= Math.floor((p[0] + dx) / s); x++)
      for (let y = Math.floor((p[1] - dy) / s); y <= Math.floor((p[1] + dy) / s); y++)
        (grid.get(x + ',' + y) || []).forEach((it) => out.add(it));
    return out;
  }
  function node(id, ll) {
    let n = nodes.get(id);
    if (!n) nodes.set(id, (n = { id, ll, adj: [] }));
    return n;
  }
  function addEdge(a, b, attr) {
    if (a === b) return;
    const e = { a, b, attr, len: distM(a.ll, b.ll) };
    a.adj.push(e);
    b.adj.push(e);
    gridAdd(egrid, ECELL, [Math.min(a.ll[0], b.ll[0]), Math.min(a.ll[1], b.ll[1]), Math.max(a.ll[0], b.ll[0]), Math.max(a.ll[1], b.ll[1])], e);
  }

  function addTile(data) {
    const [ox, oy] = data.o;
    const n = data.n, local = [];
    let id = 0, x = 0, y = 0; // delta-coded: id, x, y each relative to the node before
    for (let i = 0; i < n.length; i += 3) {
      id += n[i]; x += n[i + 1]; y += n[i + 2];
      local.push(node(id, [(ox + x) / 1e6, (oy + y) / 1e6]));
    }
    const attrs = data.a.map((a) => ({ ...a, lv: parseLevels(a.l) }));
    data.w.forEach((w) => {
      if (seenWays.has(w[0])) return;
      seenWays.add(w[0]);
      const attr = attrs[w[1]];
      for (let i = 3; i < w.length; i++) addEdge(local[w[i - 1]], local[w[i]], attr);
    });
    data.v.forEach(([i, j, a]) => {
      const A = local[i], B = local[j], key = A.id < B.id ? A.id + '_' + B.id : B.id + '_' + A.id;
      if (seenShort.has(key)) return;
      seenShort.add(key);
      addEdge(A, B, attrs[a]);
    });
    data.b.forEach((row) => {
      if (buildings.has(row[0])) return;
      let x = ox + row[1], y = oy + row[2];
      const ring = [[x / 1e6, y / 1e6]];
      for (let i = 3; i < row.length; i += 2) { x += row[i]; y += row[i + 1]; ring.push([x / 1e6, y / 1e6]); }
      const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
      const b = { id: row[0], ring, bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], entrances: [] };
      buildings.set(b.id, b);
      gridAdd(bgrid, BCELL, b.bb, b);
    });
    data.e.forEach(([i, bld, type, wc, addr]) => {
      const nd = local[i];
      if (entrances.has(nd.id)) return;
      const e = { node: nd, bld, type, wc, addr };
      entrances.set(nd.id, e);
    });
    (data.z || []).forEach((flat) => {
      for (let i = 2; i < flat.length; i += 2) {
        const a = [(ox + flat[i - 2]) / 1e6, (oy + flat[i - 1]) / 1e6], b = [(ox + flat[i]) / 1e6, (oy + flat[i + 1]) / 1e6];
        const key = a.join() + '|' + b.join();
        if (seenRail.has(key)) continue; // the same track in two tiles
        seenRail.add(key);
        gridAdd(rgrid, ECELL, [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])], [a, b]);
      }
    });
    data.x.forEach((i) => { local[i].blocked = true; });
    data.r.forEach((i) => { local[i].kerb = true; });
    data.l.forEach((i) => { local[i].lift = true; });
    // entrances may arrive before their building (other tile): link both ways whenever either appears
    entrances.forEach((e) => {
      const b = e.bld && buildings.get(e.bld);
      if (b && !b.entrances.includes(e)) b.entrances.push(e);
    });
  }

  // ------------------------------------------------------------------ tiles
  let index = null, indexPromise = null;
  const tiles = new Map(); // key → Promise<boolean>
  const pending = new Map();
  let loader = null;       // (key) → Promise<data>; browser default: <script src="walkgraph/t/key.js">
  let base = 'walkgraph/';

  function loadScript(src) {
    return new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => ok();
      s.onerror = () => fail(new Error('load ' + src));
      document.head.appendChild(s);
    });
  }
  root.WALKGRAPH_TILE = (key, data) => {
    const p = pending.get(key);
    if (p) { pending.delete(key); p(data); }
  };
  function loadIndex() {
    if (index) return Promise.resolve(index);
    if (root.WALKGRAPH_INDEX) return Promise.resolve((index = root.WALKGRAPH_INDEX));
    if (!indexPromise) {
      indexPromise = (loader ? loader('index') : loadScript(base + 'index.js').then(() => root.WALKGRAPH_INDEX))
        .then((x) => (index = x || null)).catch(() => null)
        .then((x) => { if (!x) indexPromise = null; return x; }); // offline: try again next time
    }
    return indexPromise;
  }
  function loadTile(key) {
    if (!tiles.has(key)) {
      const got = loader ? loader(key)
        : new Promise((ok, fail) => {
          pending.set(key, ok);
          // a script that loads but does not hand over the tile (a captive portal page, say) has failed too
          loadScript(base + 't/' + key + '.js')
            .then(() => { if (pending.get(key) === ok) { pending.delete(key); fail(new Error('no tile ' + key)); } })
            .catch((e) => { pending.delete(key); fail(e); });
        });
      // a tile that failed to load is tried again next time (the phone may have been offline)
      tiles.set(key, got.then((data) => { addTile(data); return true; }).catch(() => { tiles.delete(key); return false; }));
    }
    return tiles.get(key);
  }
  const tileKey = (ll, size) => Math.floor(ll[1] / size + 1e-9) + '_' + Math.floor(ll[0] / size + 1e-9);
  // Load every tile of the box around a and b; false when the network does not cover both ends
  async function ensure(a, b, padM) {
    const idx = await loadIndex();
    if (!idx) return false;
    const size = idx.tile;
    if (!idx.tiles[tileKey(a, size)] || !idx.tiles[tileKey(b, size)]) return false;
    const w = Math.min(a[0], b[0]) - padM / kx(a[1]), e = Math.max(a[0], b[0]) + padM / kx(a[1]);
    const s = Math.min(a[1], b[1]) - padM / KY, n = Math.max(a[1], b[1]) + padM / KY;
    const keys = [];
    for (let y = Math.floor(s / size); y <= Math.floor(n / size); y++)
      for (let x = Math.floor(w / size); x <= Math.floor(e / size); x++) if (idx.tiles[y + '_' + x]) keys.push(y + '_' + x);
    // a missing tile in the middle would send the walk on a detour round it: then better the online router
    return (await Promise.all(keys.map(loadTile))).every(Boolean);
  }

  // ------------------------------------------------------------------ costs
  const FACTOR = { fw: 1, sw: 1, cr: 1.05, pl: 1, co: 1, ar: 1, rd: 1.15, cy: 1.2, mr: 1.8, sep: 4, st: 1.3, es: 1.1, el: 1 };
  const COVERED = { a: 'arcade', p: 'passage', t: 'underpass', i: 'indoors', c: 'covered' };
  function edgeCost(e, opt) {
    const a = e.attr, k = a.k;
    let c = e.len * (FACTOR[k] || 1.2) * (a.s === 't' ? 1.05 : 1); // s: 't' = a path only swisstopo's map has
    if (k === 'st') {
      if (opt.stepFree && a.w) return Infinity;
      c += opt.fewerStairs ? 40 + e.len * 3 : 3;
    } else if (k === 'es') {
      if (opt.stepFree || opt.noEscalators) return Infinity;
    } else if (k === 'el') c += 20; // waiting for the lift
    if (opt.stepFree && a.w) return Infinity;
    return c;
  }
  const passable = (n, opt) => !n.blocked && !(opt.stepFree && n.kerb);

  // ------------------------------------------------------------------ the two ends of a walk
  function buildingsAt(p, rM) {
    const out = [];
    gridNear(bgrid, BCELL, p, rM).forEach((b) => {
      if (p[0] < b.bb[0] - 0.0003 || p[0] > b.bb[2] + 0.0003 || p[1] < b.bb[1] - 0.0003 || p[1] > b.bb[3] + 0.0003) return;
      if (inside(p, b.ring)) out.push(b);
    });
    return out;
  }
  // Does the straight line p→q cross a railway track on the ground?
  function cutsRail(p, q) {
    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    for (const [a, b] of gridNear(rgrid, ECELL, mid, distM(p, q) / 2 + 5)) if (crosses(p, q, a, b)) return true;
    return false;
  }
  // Does the straight line p→q cut through a building (other than those in `allow`)?
  function cutsBuilding(p, q, allow) {
    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    for (const b of gridNear(bgrid, BCELL, mid, distM(p, q) / 2 + 30)) {
      if (allow.has(b)) continue;
      if (Math.max(p[0], q[0]) < b.bb[0] || Math.min(p[0], q[0]) > b.bb[2] || Math.max(p[1], q[1]) < b.bb[1] || Math.min(p[1], q[1]) > b.bb[3]) continue;
      const r = b.ring;
      for (let i = 1; i < r.length; i++) if (crosses(p, q, r[i - 1], r[i])) return true;
    }
    return false;
  }
  // Is the path on this floor? Untagged paths count as on any floor, except bridges and tunnels for the street
  const levelOk = (attr, level) => level == null || (attr.lv ? attr.lv.includes(level) : !(attr.y && level === 0));

  // Points on the network near p, each with the cost of getting there from p in a straight line
  function attachments(p, o, allow, rM) {
    const best = new Map(); // edge → attachment
    gridNear(egrid, ECELL, p, rM).forEach((e) => {
      const pr = project(p, e.a.ll, e.b.ll);
      if (pr.d > rM) return;
      const a = e.attr;
      if (!levelOk(a, o.level)) return;
      if (a.k === 'es' || (o.stepFree && a.w)) return; // never step onto the middle of an escalator
      if (o.osmOnly && a.s === 't') return; // second try: a swisstopo path near the end may lead nowhere
      // a platform below or above the street: only paths known to be on its floor (not the street right above it)
      if (o.platform && !o.wide && o.level && !a.lv) return;
      // the platform of another track or bay is never where you board, however close (islands are metres apart)
      const own = o.ref && a.r ? a.r.split(';').includes(o.ref) : null;
      if (own === false || (o.onlyOwn && !own)) return;
      // from the street you cannot step straight into an underpass below you (its floor is often not tagged)
      if (a.c === 't' && o.level === 0 && !o.platform) return;
      let f = 1.3;
      if (a.k === 'sep' || a.k === 'mr') f = 4;                     // onto a road whose sidewalks are drawn separately
      if (o.platform && (a.k === 'pl' || own) && (a.lv ? a.lv.includes(o.level) : !a.y)) f = own ? 0.3 : 0.5; // a platform point belongs on its platform
      if (o.level != null && o.level !== 0 && !a.lv) f *= 2;        // floor of the path unknown
      // a straight line into the network must not go through a wall. It may only cross the outline of the building
      // the path itself runs under (an arcade is open to the street); passages, corridors and underpasses are only
      // entered at their ends, never through a wall
      if (pr.d > 1 && cutsRail(p, pr.q)) return; // never across the tracks
      if (pr.d > 2) {
        const under = a.c === 'a' ? buildingsAt(pr.q, 5) : [];
        if (cutsBuilding(p, pr.q, under.length ? new Set([...allow, ...under]) : allow)) {
          if (a.c === 'p' || a.c === 'i' || a.c === 't') return;
          f = 6;
        }
      }
      best.set(e, { e, t: pr.t, q: pr.q, d: pr.d, cost: pr.d * f });
    });
    return [...best.values()].sort((x, y) => x.cost - y.cost).slice(0, 8);
  }

  const DOOR_RANK = { main: 0, yes: 0, shop: 0, home: 0, staircase: 2, entrance: 0, service: 40, exit: 60, emergency: 200, garage: 120, private: 200 };
  // The ways into (or out of) the network at one end: { node or edge position, extra cost, door }
  function endpoint(p, o) {
    const out = [];
    // an exact point (where a station model's own paths begin) is joined to the paths right there, not to a door
    const inB = o.platform || o.exact ? [] : buildingsAt(p, 40);
    const allow = new Set(o.platform ? buildingsAt(p, 40) : inB); // a platform under the station roof may leave it
    const r0 = o.radius || 40;
    // a platform point belongs on its own platform: look close by first, so the next platform across the tracks
    // (or a bridge over them) never wins
    if (o.platform && !o.wide) {
      // its own platform (by track / bay number) up to 40 m away, else whatever platform path is right there
      const own = o.ref ? attachments(p, { ...o, onlyOwn: true }, allow, 40) : [];
      const near = own.length ? own : attachments(p, o, allow, 15);
      if (near.length) return near.map((x) => ({ ...x, door: null, from: p }));
    }
    const att = (q, extra, door, allowSet, r) => attachments(q, o, allowSet, r || r0).forEach((x) =>
      out.push({ ...x, cost: x.cost + extra, door, from: q }));
    // through a door of the building you are in / going to
    const doors = [];
    inB.forEach((b) => b.entrances.forEach((d) => {
      const rank = DOOR_RANK[d.type] != null ? DOOR_RANK[d.type] : 10;
      if (o.stepFree && d.wc === 'no') return;
      doors.push({ d, rank: rank + (o.stepFree && d.wc === 'yes' ? -5 : 0) });
    }));
    doors.forEach(({ d, rank }) => {
      const inside = distM(p, d.node.ll); // walking inside the building to (or from) its door
      if (d.node.adj.length) out.push({ n: d.node, cost: inside + rank, door: d, from: d.node.ll });
      // a door can be some way from any mapped path (across a lawn or a yard)
      else att(d.node.ll, inside + rank, d, new Set(inB.concat(buildingsAt(d.node.ll, 5))), 80);
    });
    // straight to the network: only when the building has no door that can be reached (the line is then a guess)
    if (!out.length) att(p, 0, null, allow);
    // nothing close: the nearest path up to 400 m away (the stretch across open ground to it is drawn dashed)
    for (const r of [150, 400]) {
      if (out.length || o.radius) break;
      attachments(p, o, allow, r).forEach((x) => out.push({ ...x, door: null, from: p }));
    }
    return out;
  }

  // ------------------------------------------------------------------ search
  class Heap {
    constructor() { this.a = []; }
    push(x, k) {
      const a = this.a;
      a.push([k, x]);
      let i = a.length - 1;
      while (i) { const j = (i - 1) >> 1; if (a[j][0] <= a[i][0]) break; [a[i], a[j]] = [a[j], a[i]]; i = j; }
    }
    pop() {
      const a = this.a, top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l;
          if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break;
          [a[i], a[m]] = [a[m], a[i]];
          i = m;
        }
      }
      return top;
    }
    get size() { return this.a.length; }
  }

  // a, b: [lon, lat]. opt: { stepFree, fewerStairs, noEscalators, from: { level, platform, ref, exact, accuracy },
  //   to: { level, platform, ref, exact } }
  // → { coords, dist (m), covered: [[ll…]…], door: { ll, type, addr } | null, cues: [{ at, kind, text }], via } or null
  function search(a, b, opt) {
    // a street address or a GPS position is on the ground floor unless said otherwise (not in the corridor below it)
    const side = (o) => ({ ...(o || {}), level: o && o.level != null ? o.level : o && o.platform ? null : 0, stepFree: opt.stepFree });
    const fromO = side(opt.from), toO = side(opt.to);
    if (fromO.accuracy != null) fromO.radius = Math.max(25, Math.min(80, fromO.accuracy * 1.5));
    const S = endpoint(a, fromO), T = endpoint(b, toO);
    if (!S.length || !T.length) return null;

    // targets: per node, the cheapest way on to b; and per edge, the attachments on it
    const goal = new Map(), goalEdge = new Map();
    const addGoal = (n, cost, t) => { const g = goal.get(n); if (!g || cost < g.cost) goal.set(n, { cost, t }); };
    T.forEach((t) => {
      if (t.n) return addGoal(t.n, t.cost, t);
      const e = t.e, f = edgeCost(e, opt) / (e.len || 1);
      if (!isFinite(f)) return;
      addGoal(e.a, t.cost + t.t * e.len * f, t);
      addGoal(e.b, t.cost + (1 - t.t) * e.len * f, t);
      (goalEdge.get(e) || goalEdge.set(e, []).get(e)).push(t);
    });

    const dist = new Map(), prev = new Map(), heap = new Heap();
    // A* towards b. A target can cost less than its straight distance to b (a platform's own path is preferred,
    // a step-free door gets a bonus), so take that slack off to keep the estimate from ever overshooting
    let slack = 0;
    T.forEach((t) => { const at = t.n ? t.n.ll : t.q; slack = Math.max(slack, distM(at, b) - t.cost); });
    const h = (n) => Math.max(0, distM(n.ll, b) - slack);
    let best = null; // { cost, node | null, t, s }
    const relax = (n, cost, p) => {
      if (!passable(n, opt)) return;
      const d = dist.get(n);
      if (d != null && d <= cost) return;
      dist.set(n, cost);
      prev.set(n, p);
      heap.push(n, cost + h(n));
    };
    S.forEach((s) => {
      if (s.n) return relax(s.n, s.cost, { s });
      const e = s.e, f = edgeCost(e, opt) / (e.len || 1);
      if (!isFinite(f)) return;
      relax(e.a, s.cost + s.t * e.len * f, { s, e });
      relax(e.b, s.cost + (1 - s.t) * e.len * f, { s, e });
      // both ends on the same stretch of path
      (goalEdge.get(e) || []).forEach((t) => {
        const c = s.cost + Math.abs(s.t - t.t) * e.len * f + t.cost;
        if (!best || c < best.cost) best = { cost: c, s, t, direct: true };
      });
    });

    let settled = 0;
    while (heap.size) {
      const [key, n] = heap.pop();
      const d = dist.get(n);
      if (key > d + h(n) + 1e-6) continue; // an old entry: n was reached more cheaply since
      if (best && d + h(n) >= best.cost) break;
      if (++settled > 250000) break;
      const g = goal.get(n);
      if (g && (!best || d + g.cost < best.cost)) best = { cost: d + g.cost, node: n, t: g.t };
      const came = n.lift && prev.get(n).e;
      for (const e of n.adj) {
        if (e.attr.d && (e.attr.d === 'f') !== (e.a === n)) continue; // an escalator against its direction
        const m = e.a === n ? e.b : e.a;
        let c = edgeCost(e, opt);
        if (!isFinite(c)) continue;
        // a lift drawn as a point where paths on different floors meet: changing floor there means waiting for it
        if (came && came.attr.l !== e.attr.l) c += 20;
        relax(m, d + c, { n, e });
      }
    }
    if (!best) return null;
    return assemble(a, b, best, prev);
  }

  // ------------------------------------------------------------------ the result: line, covered parts, door and cues
  function assemble(a, b, best, prev) {
    const pts = []; // [ll, attr of the way that leads to it]
    let s;
    // each point carries the way that leads to it (null: a straight connector) and whether that way is walked
    // in its drawn direction (for steps tagged incline=up/down)
    if (best.direct) {
      s = best.s;
      pts.push([s.q, null], [best.t.q, s.e.attr, best.t.t >= s.t]);
    } else {
      const chain = [];
      let n = best.node;
      for (;;) {
        const p = prev.get(n);
        if (p.n) { chain.push([n.ll, p.e.attr, p.e.b === n, n.lift]); n = p.n; continue; }
        chain.push([n.ll, p.e ? p.e.attr : null, p.e ? p.e.b === n : true, n.lift]);
        s = p.s;
        if (p.e) chain.push([s.q, null]);
        break;
      }
      chain.reverse();
      pts.push(...chain);
      const t = best.t;
      if (t.e && t.q) pts.push([t.q, t.e.attr, t.e.a === best.node]);
    }
    const t = best.t;
    // from where you are to the network, through the door if one was taken
    const head = [[a, null]];
    if (s.door && s.door.node.ll !== (pts[0] && pts[0][0])) head.push([s.door.node.ll, null]);
    const tail = [];
    if (t.door && t.door.node.ll !== (pts.length && pts[pts.length - 1][0])) tail.push([t.door.node.ll, null]);
    if (!t.door) tail.push([b, null]); // no door: the line goes to the place itself
    const raw = head.concat(pts, tail);
    const all = raw.filter((p, i, arr) => !i || distM(p[0], arr[i - 1][0]) > 0.3);
    const coords = all.map((p) => p[0]);
    // the straight bits from where you are onto the paths, and from the paths to the end (or its door), are guesses
    // across open ground when they are long: say so (drawn dashed). approxTo / approxFrom: coordinate indices.
    let first = all.findIndex((p) => p[1]), last = all.length - 1 - [...all].reverse().findIndex((p) => p[1]);
    const offPath = first < 0; // no stretch of path left at all (both ends meet the same point): all of it is a guess
    if (offPath) { first = all.length - 1; last = 0; }
    const along = (i, j) => { let m = 0; for (let k = i + 1; k <= j; k++) m += distM(coords[k - 1], coords[k]); return m; };
    const approxTo = first > 0 && along(0, first - 1) > 20 ? first - 1 : null;
    const approxFrom = last < coords.length - 1 && along(last, coords.length - 1) > 20 ? last : null;

    let dist = 0;
    for (let i = 1; i < coords.length; i++) dist += distM(coords[i - 1], coords[i]);
    // covered stretches (arcades, passages, underpasses, indoors)
    const covered = [];
    let run = null;
    all.forEach(([ll, attr], i) => {
      const c = attr && attr.c;
      if (c && run && run.c === c) run.cs.push(ll);
      else {
        if (run && run.cs.length > 1) covered.push(run);
        run = c && i ? { c, cs: [all[i - 1][0], ll] } : null;
      }
    });
    if (run && run.cs.length > 1) covered.push(run);
    const cues = cuesOf(raw); // before dropping repeated points: a lift ride has none of its own
    const door = t.door ? { ll: t.door.node.ll, type: t.door.type, addr: t.door.addr } : null;
    const via = summary(cues, door);
    let swisstopo = 0; // metres on paths only swisstopo's map has (swissTLM3D)
    for (let k = 1; k < all.length; k++) if (all[k][1] && all[k][1].s === 't') swisstopo += distM(coords[k - 1], coords[k]);
    return { net: true, coords, approx: offPath || undefined, approxTo, approxFrom, swisstopo: Math.round(swisstopo), levels: all.map((p) => (p[1] && p[1].l != null ? p[1].l : null)), dist: Math.round(dist), covered: covered.map((r) => ({ kind: COVERED[r.c], coords: r.cs })), door,
      startDoor: s.door ? { ll: s.door.node.ll, type: s.door.type } : null, cues, via };
  }
  // The moments worth a word: stairs, escalators and lifts (with the floor they take you to), arcades, passages,
  // underpasses, crossings and named squares. all: [ll, attr of the way leading to it, walked forwards, lift node]
  const levelText = (l) => (l === 0 ? 'street level' : 'level ' + String(l).replace('-', '−'));
  function cuesOf(all) {
    const cum = [0];
    for (let i = 1; i < all.length; i++) cum.push(cum[i - 1] + distM(all[i - 1][0], all[i][0]));
    const single = (attr) => (attr && attr.lv && attr.lv.length === 1 ? attr.lv[0] : null);
    // the floor just before / after a staircase (within 60 m: a floor tag further away says nothing about it)
    const levelBefore = (i) => { for (let j = i; j >= 1 && cum[i] - cum[j] < 60; j--) { const l = single(all[j][1]); if (l != null) return l; } return null; };
    const levelAfter = (i) => { for (let j = i; j < all.length && cum[j] - cum[Math.min(i, all.length - 1)] < 60; j++) { const l = single(all[j][1]); if (l != null) return l; } return null; };
    const kindOf = (attr) => {
      if (!attr) return null;
      const k = attr.k, c = attr.c;
      return k === 'st' ? 'steps' : k === 'es' ? 'escalator' : k === 'el' ? 'lift'
        : attr.lv && attr.lv.length > 1 && k !== 'ar' ? 'ramp' // a path that joins two floors (a ramp, a sloping corridor)
        : c === 'a' ? 'arcade' : c === 'p' ? 'passage' : c === 't' ? 'underpass'
        : k === 'cr' ? 'crossing' : k === 'ar' && attr.n ? 'square' : null;
    };
    const cues = [], lastAt = {};
    const push = (i, kind, text) => {
      const key = kind + '|' + text;
      if (lastAt[key] != null && cum[i] - lastAt[key] < 80) { lastAt[key] = cum[i]; return; } // the same arcade, block after block
      lastAt[key] = cum[i];
      cues.push({ at: all[i][0], kind, text, m: Math.round(cum[i]) });
    };
    for (let i = 1; i < all.length; i++) {
      const attr = all[i][1], kind = kindOf(attr);
      // a lift drawn as a point where paths on different floors meet
      if (all[i - 1][3] && i >= 2) {
        const before = single(all[i - 1][1]), after = single(attr);
        if (before != null && after != null && before !== after) push(i - 1, 'lift', 'Lift to ' + levelText(after));
      }
      if (!kind || kind === kindOf(all[i - 1][1]) && (all[i - 1][1] || {}).n === attr.n) continue; // still on the same one
      let text;
      if (kind === 'steps' || kind === 'escalator' || kind === 'lift' || kind === 'ramp') {
        let j = i;
        while (j + 1 < all.length && kindOf(all[j + 1][1]) === kind) j++;
        const from = levelBefore(i - 1), to = levelAfter(j + 1);
        const word = { steps: 'Stairs', escalator: 'Escalator', lift: 'Lift', ramp: '' }[kind];
        if (from != null && to != null && from !== to) {
          text = kind === 'lift' ? `Lift to ${levelText(to)}` : `${word} ${to > from ? 'up' : 'down'} to ${levelText(to)}`.trim();
          text = text[0].toUpperCase() + text.slice(1);
        } else if (kind === 'ramp') continue;
        else if (attr.i && kind !== 'lift') text = `${word} ${(attr.i === 'u') === (all[i][2] !== false) ? 'up' : 'down'}`;
        else text = word;
      } else {
        text = { arcade: 'Under the arcades', passage: 'Through the passage', underpass: 'Through the underpass',
          crossing: 'Cross the street', square: 'Straight across' }[kind];
        if (attr.n && kind !== 'crossing') text += (kind === 'arcade' ? ' of ' : ' ') + attr.n;
      }
      push(i - 1, kind, text);
    }
    // the floor changes where paths simply meet (stairs or a lift not drawn): still say so
    const VERTICAL = { steps: 1, escalator: 1, lift: 1, ramp: 1 };
    let lastLv = null, lastI = 0;
    for (let i = 1; i < all.length; i++) {
      const l = single(all[i][1]);
      if (l == null) continue;
      if (lastLv != null && l !== lastLv && !cues.some((c) => VERTICAL[c.kind] && c.m >= cum[lastI] - 1 && c.m <= cum[i] + 1)) {
        cues.push({ at: all[i - 1][0], kind: 'ramp', text: `${l > lastLv ? 'Up' : 'Down'} to ${levelText(l)}`, m: Math.round(cum[i - 1]) });
      }
      lastLv = l;
      lastI = i;
    }
    return cues.sort((x, y) => x.m - y.m);
  }

  function summary(cues, door) {
    const parts = [];
    const has = (k) => cues.find((c) => c.kind === k);
    const arcade = has('arcade');
    if (arcade) parts.push(arcade.text.replace(/^Under/, 'under'));
    if (has('passage')) parts.push('through a passage');
    if (has('underpass')) parts.push('through the underpass');
    // the last stairs / escalator / lift (the one that takes you to where you are going); floor changes on plain paths
    // stay in the step-by-step cues
    const vertical = [...cues].reverse().find((c) => c.kind === 'lift' || c.kind === 'escalator' || c.kind === 'steps');
    if (vertical) parts.push(vertical.text.replace(/^\w/, (c) => c.toLowerCase()));
    if (door) parts.push(door.type === 'main' ? 'main entrance' : door.addr ? 'entrance ' + door.addr : 'to the door');
    return parts.slice(0, 3).join(' · ');
  }

  // ------------------------------------------------------------------ public
  async function route(a, b, opt = {}) {
    const straight = distM(a, b);
    if (straight > 4000) return null;
    if (!(await ensure(a, b, Math.max(450, straight * 0.4)))) return null; // the nearest path can be up to 400 m off
    // a network gap can send the search on a huge detour: that counts as no route (the next try, or the online router)
    const ok = (r) => r && r.dist <= Math.max(straight * 4, straight + 1200);
    const from = opt.from || {}, to = opt.to || {};
    const tries = [
      opt,
      // GPS: if nothing within its accuracy leads anywhere, any path nearby
      from.accuracy != null && { ...opt, from: { ...from, accuracy: null } },
      // nothing from the platform's own paths (e.g. step-free and its lift is further along): look wider
      (from.platform || to.platform) && { ...opt, from: { ...from, accuracy: null, wide: true }, to: { ...to, wide: true } },
      // a path only swisstopo's map has, right by an end, can be a piece on its own: then from OSM's paths (dashed
      // across) at that end, at the other, or at both
      { ...opt, from: { ...from, accuracy: null, wide: true }, to: { ...to, wide: true, osmOnly: true } },
      { ...opt, from: { ...from, accuracy: null, wide: true, osmOnly: true }, to: { ...to, wide: true } },
      { ...opt, from: { ...from, accuracy: null, wide: true, osmOnly: true }, to: { ...to, wide: true, osmOnly: true } },
    ];
    for (const t of tries) {
      if (!t) continue;
      const r = search(a, b, t);
      if (ok(r)) return r;
    }
    return null;
  }


  root.WALKROUTE = {
    route,
    covers: async (ll) => { const idx = await loadIndex(); return !!(idx && idx.tiles[tileKey(ll, idx.tile)]); },
    configure: (o) => { if (o.loader) loader = o.loader; if (o.base) base = o.base; if (o.index) index = o.index; },
    _debug: { nodes, buildings, entrances, endpoint, buildingsAt, cutsBuilding, search, distM },
  };
})(typeof window !== 'undefined' ? window : globalThis);
