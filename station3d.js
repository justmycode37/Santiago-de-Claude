/* 3D station viewer: window.Station3D. Model format and API: stations3d/SCHEMA.md.
   Nothing heavy runs until Station3D.open(): three.js, the station model, the router and the styles
   are loaded on first use. */
(function () {
  'use strict';

  const THREE_URL = 'https://unpkg.com/three@0.170.0/build/three.module.min.js';
  const HASH = '#station3d';
  const me = document.currentScript;
  const SRC = (me && me.src) || '';
  const BASE = SRC.replace(/[^/]*(\?.*)?$/, '');
  const BUST = SRC.includes('?') ? SRC.slice(SRC.indexOf('?')) : ''; // a cache-busting query is passed on to what we load
  const WALK = '#FFD23F', INK = '#14161A';
  const FOV = 30;
  const EXPLODE = 1.9;
  const POV_FOV = 76, EYE = 1.6;
  const HS_MODEL = .6; // rooms and buildings are drawn at this part of their height in the model view

  // ---------- small helpers ----------
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const reducedMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const isDark = () => document.documentElement.dataset.theme === 'dark';
  const angDiff = (a, b) => { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

  // The app's --spring curve, cubic-bezier(.32,.72,0,1), as a function
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    return (x) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) {
        const d = (3 * ax * t + 2 * bx) * t + cx;
        if (Math.abs(d) < 1e-6) break;
        t -= (((ax * t + bx) * t + cx) * t - x) / d;
      }
      t = clamp(t, 0, 1);
      return ((ay * t + by) * t + cy) * t;
    };
  }
  const spring = bezier(.32, .72, 0, 1);

  const ICON = {
    walk: '<circle cx="13" cy="4.2" r="1.9"/><path d="M10.5 21l1.5-5.5 2.5 2.5v3M8.5 12.5l2.5-4.5 3 1 2 3.5M12 15.5l-1.2-6.5"/>',
    stairs: '<path d="M4 20h5v-5h5v-5h5V5"/>',
    escalator: '<path d="M3 15.5h4.5L15 7h6M3 20h6.5L17 11.5h4"/>',
    ramp: '<path d="M3 18.5h18V9.5z"/>',
    elevator: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M9.3 10.3L12 7.6l2.7 2.7M9.3 13.7l2.7 2.7 2.7-2.7"/>',
    arrive: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    next: '<path d="M9 6l6 6-6 6"/>',
    prev: '<path d="M15 6l-6 6 6 6"/>',
    close: '<path d="M2.5 2.5l9 9M11.5 2.5l-9 9"/>',
    fit: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>',
    follow: '<path d="M20 4L3.5 10.6l6.6 2.2 2.2 6.7z"/>',
    layers: '<path d="M12 3.5l8.5 4.3-8.5 4.3-8.5-4.3zM3.5 12.2l8.5 4.3 8.5-4.3M3.5 16.4l8.5 4.3 8.5-4.3"/>',
    spread: '<path d="M12 2.8l7 3.2-7 3.2L5 6zM12 14.8l7 3.2-7 3.2-7-3.2zM12 10v3.6M10.2 11.9l1.8 1.8 1.8-1.8"/>',
    tleft: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v5"/>',
    tright: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0-6 6v5"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    phone: '<rect x="7.5" y="3" width="9" height="18" rx="2.2"/><path d="M3 9.5a9 9 0 0 0 0 5M21 9.5a9 9 0 0 1 0 5"/>',
    centre: '<path d="M12 20V8M7 12.5l5-5 5 5M5 4h14"/>',
    here: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3.3M12 18.2v3.3M2.5 12h3.3M18.2 12h3.3"/>',
    info: '<path d="M12 11v6M12 7.2v.1"/><circle cx="12" cy="12" r="9"/>',
    tickets: '<path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4zM14 6v12"/>',
    toilets: '<circle cx="7.5" cy="5" r="1.8"/><circle cx="16.5" cy="5" r="1.8"/><path d="M7.5 9v11M4.5 13l3-4 3 4M16.5 9v11M13.5 16h6l-3-7z"/>',
    'meeting-point': '<circle cx="12" cy="12" r="2.2"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>',
    lockers: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M5 12h14M14.5 8h.01M14.5 16h.01"/>',
  };
  const svg = (name, vb) => `<svg viewBox="${vb || '0 0 24 24'}" aria-hidden="true">${ICON[name] || ''}</svg>`;

  const levelShort = (l) => (l < 0 ? '−' + -l : l > 0 ? '+' + l : '0');
  const nounOf = (mode) => (mode === 'train' || mode === 'cable' ? 'Platform' : mode === 'boat' ? 'Pier' : 'Bay');
  const fmtM = (m) => (m < 7.5 ? 'a few steps' : `${Math.round(m / 5) * 5} m`);
  const fmtSec = (s) => (s < 50 ? `${Math.max(10, Math.round(s / 10) * 10)} s` : `${Math.round(s / 60)} min`);
  const fmtMin = (s) => (s < 45 ? 'under 1 min' : `${Math.max(1, Math.round(s / 60))} min`);

  // ---------- loading (everything is lazy) ----------
  let THREE = null;
  let threePromise = null;
  const scriptPromises = new Map();
  function loadScript(src) {
    if (!scriptPromises.has(src)) {
      scriptPromises.set(src, new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => { scriptPromises.delete(src); s.remove(); reject(new Error('Could not load ' + src)); };
        document.head.appendChild(s);
      }));
    }
    return scriptPromises.get(src);
  }
  function loadThree() {
    if (!threePromise) threePromise = import(THREE_URL).then((m) => (THREE = m), (e) => { threePromise = null; throw e; });
    return threePromise;
  }
  let cssPromise = null;
  function loadCss() {
    if (cssPromise) return cssPromise;
    const have = [...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => /station3d\.css/.test(l.href));
    cssPromise = have ? Promise.resolve() : new Promise((resolve) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = BASE + 'station3d.css' + BUST;
      l.onload = l.onerror = () => resolve();
      document.head.appendChild(l);
    });
    return cssPromise;
  }
  function loadModel(key) {
    const have = () => window.STATION3D && window.STATION3D[key];
    if (have()) return Promise.resolve(have());
    return loadScript(BASE + 'stations3d/' + key + '.js' + BUST).then(() => {
      if (!have()) throw new Error('No model "' + key + '"');
      return have();
    });
  }
  function loadRouter() {
    if (window.StationRoute) return Promise.resolve(window.StationRoute);
    return loadScript(BASE + 'station-route.js' + BUST).then(() => window.StationRoute || null, () => null);
  }

  // ---------- model helpers ----------
  const toLocal = (model, ll) => {
    const [lng0, lat0] = model.origin;
    return [(ll[0] - lng0) * 111320 * Math.cos(lat0 * Math.PI / 180), (ll[1] - lat0) * 110540];
  };
  const toLngLat = (model, xy) => {
    const [lng0, lat0] = model.origin;
    return [lng0 + xy[0] / (111320 * Math.cos(lat0 * Math.PI / 180)), lat0 + xy[1] / 110540];
  };

  function cleanRing(ring, ccw) {
    const out = [];
    for (const p of ring || []) {
      const q = out[out.length - 1];
      if (!q || Math.abs(q[0] - p[0]) > 1e-3 || Math.abs(q[1] - p[1]) > 1e-3) out.push([p[0], p[1]]);
    }
    if (out.length > 1) {
      const a = out[0], b = out[out.length - 1];
      if (Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3) out.pop();
    }
    if (out.length < 3) return null;
    let area = 0;
    for (let i = 0, j = out.length - 1; i < out.length; j = i++) area += (out[j][0] * out[i][1] - out[i][0] * out[j][1]);
    if ((area > 0) !== ccw) out.reverse();
    return out;
  }
  function inRing(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function hull(points) {
    const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
    const upper = [];
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  // Everything derived from a model once: sorted levels, cleaned polygons per level, heights.
  const prepared = new WeakMap();
  function prepare(model) {
    if (prepared.has(model)) return prepared.get(model);
    const levels = (model.levels || []).slice().sort((a, b) => a.id - b.id).map((l, i) => ({ id: l.id, z: l.z, name: l.name || `Level ${l.id}`, i, areas: [], pts: [] }));
    if (!levels.length) levels.push({ id: 0, z: 0, name: 'Ground', i: 0, areas: [], pts: [] });
    const zOf = (level) => {
      const n = levels.length;
      if (n === 1) return levels[0].z + (level - levels[0].id) * 5;
      let k = 0;
      while (k < n - 2 && level > levels[k + 1].id) k++;
      const a = levels[k], b = levels[k + 1];
      return a.z + ((level - a.id) / (b.id - a.id)) * (b.z - a.z);
    };
    const idxOf = (level) => {
      let best = 0;
      for (let k = 1; k < levels.length; k++) if (Math.abs(levels[k].id - level) < Math.abs(levels[best].id - level)) best = k;
      return best;
    };
    const ORDER = { plaza: 0, floor: 1, platform: 2, room: 3 };
    for (const a of model.areas || []) {
      const ring = cleanRing(a.ring, true);
      if (!ring) continue;
      const holes = (a.holes || []).map((h) => cleanRing(h, false)).filter(Boolean);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of ring) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      const lv = levels[idxOf(a.level || 0)];
      lv.areas.push({ src: a, kind: a.kind, ring, holes, box: [x0, y0, x1, y1], level: a.level || 0, li: lv.i, order: ORDER[a.kind] == null ? 1 : ORDER[a.kind] });
      for (const p of ring) lv.pts.push(p);
    }
    // A deck in the shell (a bridge, a bus deck) is ground you walk on: draw it as the floor it belongs to
    const decks = new Set();
    for (const sh of model.shell || []) {
      if (sh.kind !== 'deck' || sh.top == null) continue;
      const lv = levels.slice().sort((a, b) => Math.abs(a.z - sh.top) - Math.abs(b.z - sh.top))[0];
      const ring = cleanRing(sh.ring, true);
      if (!ring || Math.abs(lv.z - sh.top) > 2) continue;
      const holes = (sh.holes || []).map((h) => cleanRing(h, false)).filter(Boolean);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of ring) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      lv.areas.push({ src: { kind: 'plaza', name: sh.name || '', level: lv.id }, kind: 'plaza', ring, holes, box: [x0, y0, x1, y1], level: lv.id, li: lv.i, order: 0 });
      for (const p of ring) lv.pts.push(p);
      decks.add(sh);
    }
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const lv of levels) {
      lv.areas.sort((a, b) => a.order - b.order);
      const h = hull(lv.pts);
      // points along the outline, for placing the level's name
      lv.rim = [];
      for (let i = 0; i < h.length; i++) {
        const a = h[i], b = h[(i + 1) % h.length];
        const n = Math.max(1, Math.min(8, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 14)));
        for (let k = 0; k < n; k++) lv.rim.push([lerp(a[0], b[0], k / n), lerp(a[1], b[1], k / n)]);
      }
      const all = [];
      for (const a of lv.areas) for (const p of a.ring) all.push(p);
      const stride = Math.max(1, Math.ceil(all.length / 320));
      for (let i = 0; i < all.length; i += stride) lv.rim.push(all[i]);
      lv.box = null;
      for (const p of h) {
        if (!lv.box) lv.box = [p[0], p[1], p[0], p[1]];
        lv.box[0] = Math.min(lv.box[0], p[0]); lv.box[1] = Math.min(lv.box[1], p[1]);
        lv.box[2] = Math.max(lv.box[2], p[0]); lv.box[3] = Math.max(lv.box[3], p[1]);
      }
      if (lv.box) { bx0 = Math.min(bx0, lv.box[0]); by0 = Math.min(by0, lv.box[1]); bx1 = Math.max(bx1, lv.box[2]); by1 = Math.max(by1, lv.box[3]); }
      delete lv.pts;
    }
    if (!isFinite(bx0)) [bx0, by0, bx1, by1] = model.bbox || [-50, -50, 50, 50];
    const zs = levels.map((l) => l.z);
    const gap = levels.length > 1 ? (Math.max(...zs) - Math.min(...zs)) / (levels.length - 1) : 5;
    const diag = Math.hypot(bx1 - bx0, by1 - by0);
    // real floor heights are small against a station's footprint: stretch them so the floors separate
    const vex = clamp(clamp(diag * 0.05, 8, 13) / Math.max(2, gap), 1.3, 2.6);
    const P = { model, levels, zOf, idxOf, decks, box: [bx0, by0, bx1, by1], diag, vex, zMin: Math.min(...zs), zMax: Math.max(...zs) };
    prepared.set(model, P);
    return P;
  }

  // Which area is at (x, y) on level index li? Platforms and rooms win over the floor they stand on.
  function areaAt(P, li, x, y) {
    const lv = P.levels[li];
    let hit = null;
    for (const a of lv.areas) {
      if (x < a.box[0] || x > a.box[2] || y < a.box[1] || y > a.box[3]) continue;
      if (!inRing(a.ring, x, y) || a.holes.some((h) => inRing(h, x, y))) continue;
      if (!hit || a.order >= hit.order) hit = a;
    }
    return hit;
  }

  // ---------- colours of the model, per theme ----------
  const THEME = {
    light: {
      level: (id) => (id <= -2 ? '#b3bfce' : id === -1 ? '#cad3de' : id === 0 ? '#ebe8e0' : id === 1 ? '#f4f2ec' : '#fbfaf7'),
      platform: ['#7d786a', .2], plaza: ['#b4c4ad', .4], room: ['#69707c', .24],
      bed: '#aaa69c', rail: '#62656b', stairs: '#fbfaf7', ramp: '#e4e1d8', tread: '#565c66', glass: ['#7f9ab8', .42],
      shaft: ['#42566f', .18], cab: '#6a7686', shell: '#8d97a8', shellAlpha: .13, ceil: ['#ffffff', .55],
      line: '#14161A', lineOpacity: .3, shellLine: .2,
      route: WALK, casing: INK, chevron: INK, dim: '#e9d9a3', done: '#b9bdc6',
      hemiSky: '#ffffff', hemiGround: '#c9cfda', hemi: 2.35, sun: 1.25, shadow: .3,
    },
    dark: {
      level: (id) => (id <= -2 ? '#252e3c' : id === -1 ? '#2f3948' : id === 0 ? '#45474d' : id === 1 ? '#55575d' : '#64666c'),
      platform: ['#ffffff', .1], plaza: ['#22302a', .45], room: ['#ffffff', .13],
      bed: '#26282c', rail: '#8a8e96', stairs: '#7b7e86', ramp: '#5d6067', tread: '#a2a8b2', glass: ['#a9c4e2', .3],
      shaft: ['#c5d9f5', .14], cab: '#c3ccd8', shell: '#aab4c6', shellAlpha: .1, ceil: ['#000000', .25],
      line: '#ffffff', lineOpacity: .22, shellLine: .16,
      route: WALK, casing: '#0B0D10', chevron: INK, dim: '#7d6f3a', done: '#5c6068',
      hemiSky: '#ffffff', hemiGround: '#7a8296', hemi: 2.5, sun: 1.3, shadow: .42,
    },
  };

  // ---------- geometry: everything is merged into a few big buffers ----------
  // A vertex is [x, y, zr, yo]: model x/y, the real height zr (scaled by the vertical stretch) and a fixed offset yo.
  function Geo() { this.p = []; this.zr = []; this.ho = []; this.c = []; }
  Geo.prototype.tri = function (a, b, c, col) {
    this.p.push(a[0], a[3], -a[1], b[0], b[3], -b[1], c[0], c[3], -c[1]);
    this.zr.push(a[2], b[2], c[2]);
    this.ho.push(a[4] || 0, b[4] || 0, c[4] || 0);
    if (col) this.c.push(col[0], col[1], col[2], col[3], col[0], col[1], col[2], col[3], col[0], col[1], col[2], col[3]);
  };
  Geo.prototype.quad = function (a, b, c, d, col) { this.tri(a, b, c, col); this.tri(a, c, d, col); };
  Geo.prototype.seg = function (a, b) { // for LineSegments
    this.p.push(a[0], a[3], -a[1], b[0], b[3], -b[1]);
    this.zr.push(a[2], b[2]);
    this.ho.push(a[4] || 0, b[4] || 0);
  };
  Geo.prototype.loop = function (ring, zr, yo, ho) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      this.seg([a[0], a[1], zr, yo, ho], [b[0], b[1], zr, yo, ho]);
    }
  };
  function triangulate(ring, holes) {
    const V2 = THREE.Vector2;
    const c = ring.map((p) => new V2(p[0], p[1]));
    const hs = (holes || []).map((h) => h.map((p) => new V2(p[0], p[1])));
    const all = c.concat(...hs);
    let faces;
    try { faces = THREE.ShapeUtils.triangulateShape(c, hs); } catch (e) { return []; }
    const out = [];
    for (const f of faces) {
      const a = all[f[0]], b = all[f[1]], d = all[f[2]];
      if (!a || !b || !d) continue;
      const cr = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
      if (Math.abs(cr) < 1e-7) continue;
      out.push(cr > 0 ? [a, b, d] : [a, d, b]);
    }
    return out;
  }
  // Extruded polygon: a top cap at (zr1, y1 [, h1]) and walls down to (zr0, y0). No bottom: the camera never goes below.
  // down = true turns the cap to face down (a ceiling).
  Geo.prototype.prism = function (ring, holes, zr0, y0, zr1, y1, top, side, h1, down) {
    if (top) {
      for (const t of triangulate(ring, holes)) {
        const A = [t[0].x, t[0].y, zr1, y1, h1], B = [t[1].x, t[1].y, zr1, y1, h1], C = [t[2].x, t[2].y, zr1, y1, h1];
        if (down) this.tri(A, C, B, top); else this.tri(A, B, C, top);
      }
    }
    if (!side) return;
    const wall = (r) => {
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length];
        this.quad([a[0], a[1], zr0, y0], [b[0], b[1], zr0, y0], [b[0], b[1], zr1, y1, h1], [a[0], a[1], zr1, y1, h1], side);
      }
    };
    wall(ring);
    (holes || []).forEach(wall);
  };
  // Flat band along a line. zrs[i] is the real height at point i; off shifts it sideways (to the left of travel).
  Geo.prototype.ribbon = function (line, half, zrs, yo, col, off) {
    const n = line.length;
    if (n < 2) return;
    const L = [], R = [];
    for (let i = 0; i < n; i++) {
      const p = line[i], a = line[Math.max(0, i - 1)], b = line[Math.min(n - 1, i + 1)];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      dx /= l; dy /= l;
      L.push([p[0] - dy * ((off || 0) + half), p[1] + dx * ((off || 0) + half)]);
      R.push([p[0] - dy * ((off || 0) - half), p[1] + dx * ((off || 0) - half)]);
    }
    for (let i = 0; i < n - 1; i++) {
      this.quad([R[i][0], R[i][1], zrs[i], yo], [R[i + 1][0], R[i + 1][1], zrs[i + 1], yo], [L[i + 1][0], L[i + 1][1], zrs[i + 1], yo], [L[i][0], L[i][1], zrs[i], yo], col);
    }
  };
  Geo.prototype.box = function (cx, cy, half, zr0, y0, zr1, y1, col, top) {
    const r = [[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half]];
    this.prism(r, null, zr0, y0, zr1, y1, top || col, col);
    return r;
  };
  Geo.prototype.count = function () { return this.zr.length; };
  // → BufferGeometry whose heights can be re-stretched later: y = zr × S + yo + ho × Hs
  Geo.prototype.build = function (S, Hs, normals) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(this.p);
    const zr = new Float32Array(this.zr), ho = new Float32Array(this.ho);
    const yo = new Float32Array(zr.length);
    for (let i = 0; i < zr.length; i++) { yo[i] = pos[i * 3 + 1]; pos[i * 3 + 1] = zr[i] * S + yo[i] + ho[i] * Hs; }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (this.c.length) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.c), 4));
    g.userData = { zr, yo, ho, normals: !!normals };
    if (normals) g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  };
  function stretch(g, S, Hs, finish) {
    const { zr, yo, ho, normals } = g.userData;
    const pos = g.attributes.position;
    const a = pos.array;
    for (let i = 0; i < zr.length; i++) a[i * 3 + 1] = zr[i] * S + yo[i] + ho[i] * Hs;
    pos.needsUpdate = true;
    if (finish) {
      if (normals) g.computeVertexNormals();
      g.computeBoundingSphere();
    }
  }

  // One staircase / escalator / ramp, following its line. Levels on the line may be fractional.
  function addConnector(g, ln, P, c, col) {
    const w = clamp((c.width || 2.2), 1.2, 9) / 2;
    const line = c.line;
    for (let i = 0; i < line.length - 1; i++) {
      let p = line[i], q = line[i + 1];
      let zp = P.zOf(p[2]), zq = P.zOf(q[2]);
      if (zq < zp) { [p, q] = [q, p]; [zp, zq] = [zq, zp]; } // always build upwards
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 0.05) continue;
      const dx = (q[0] - p[0]) / len, dy = (q[1] - p[1]) / len;
      const at = (u, s, zr, yo) => [p[0] + dx * u * len - dy * s * w, p[1] + dy * u * len + dx * s * w, zr, yo];
      const dz = zq - zp;
      const zAt = (u) => zp + dz * u;
      ln.seg(at(0, -1, zp, .05), at(1, -1, zq, .05));
      ln.seg(at(0, 1, zp, .05), at(1, 1, zq, .05));
      if (c.kind === 'stairs' && dz > 0.2) {
        const n = clamp(Math.round(len / 0.8), 4, 18);
        for (let k = 0; k < n; k++) {
          const u0 = k / n, u1 = (k + 1) / n, zt = zAt(u1), zb = zAt(u0);
          g.quad(at(u0, -1, zt, 0), at(u1, -1, zt, 0), at(u1, 1, zt, 0), at(u0, 1, zt, 0), col.stairs); // tread
          g.quad(at(u0, 1, zb, 0), at(u0, -1, zb, 0), at(u0, -1, zt, 0), at(u0, 1, zt, 0), col.stairs); // riser
          for (const s of [-1, 1]) g.quad(at(u0, s, zb, -.45), at(u1, s, zt, -.45), at(u1, s, zt, 0), at(u0, s, zt, 0), col.stairs); // cheek
        }
      } else {
        const top = c.kind === 'escalator' ? col.tread : c.kind === 'stairs' ? col.stairs : col.ramp;
        g.quad(at(0, -1, zp, 0), at(1, -1, zq, 0), at(1, 1, zq, 0), at(0, 1, zp, 0), top);
        for (const s of [-1, 1]) g.quad(at(0, s, zp, -.4), at(1, s, zq, -.4), at(1, s, zq, 0), at(0, s, zp, 0), top);
        if (c.kind === 'escalator') {
          for (const s of [-1, 1]) {
            g.quad(at(0, s, zp, 0), at(1, s, zq, 0), at(1, s, zq, 1.05), at(0, s, zp, 1.05), col.glass); // balustrade
            ln.seg(at(0, s, zp, 1.05), at(1, s, zq, 1.05)); // handrail
          }
        }
      }
    }
  }

  // The walking route as a tube along its points. Its width is set on screen by the shader, so only the
  // centre line, the direction around it and the distance along are stored.
  function smoothPath(points) {
    const out = [];
    const n = points.length;
    for (let i = 0; i < n; i++) {
      const c = points[i];
      const a = points[i - 1], b = points[i + 1];
      const flat = a && b && Math.abs(a[2] - c[2]) < 1e-6 && Math.abs(b[2] - c[2]) < 1e-6;
      const la = flat ? Math.hypot(a[0] - c[0], a[1] - c[1]) : 0, lb = flat ? Math.hypot(b[0] - c[0], b[1] - c[1]) : 0;
      if (!flat || la < .4 || lb < .4) { out.push({ x: c[0], y: c[1], l: c[2], o: i }); continue; }
      const cut = Math.min(2.2, la * .45, lb * .45);
      const A = [c[0] + (a[0] - c[0]) / la * cut, c[1] + (a[1] - c[1]) / la * cut];
      const B = [c[0] + (b[0] - c[0]) / lb * cut, c[1] + (b[1] - c[1]) / lb * cut];
      for (let k = 0; k <= 4; k++) {
        const t = k / 4, u = 1 - t;
        out.push({ x: u * u * A[0] + 2 * u * t * c[0] + t * t * B[0], y: u * u * A[1] + 2 * u * t * c[1] + t * t * B[1], l: c[2], o: k === 2 ? i : -1 });
      }
    }
    return out;
  }

  const ROUTE_VERT = `
    attribute vec3 aRad;
    attribute vec3 aTan;
    attribute float aZr;
    attribute float aD;
    uniform float uS, uPx, uRmin, uScale, uA0, uA1, uThin, uSquash;
    varying float vDepth;
    varying float vD;
    varying float vR;
    varying float vFace;
    void main() {
      vec3 c = vec3(position.x, aZr * uS, position.z);
      float depth = -(modelViewMatrix * vec4(c, 1.0)).z;
      float base = max(uRmin, uPx * depth);
      float act = step(uA0 - 0.05, aD) * step(aD, uA1 + 0.05);
      float r = base * mix(uThin, 1.0, act);
      c.y += base * 0.9 * uSquash + (1.0 - uSquash) * 0.06;
      vDepth = depth;
      vec3 toCam = cameraPosition - c;
      vec3 side = toCam - aTan * dot(toCam, aTan);
      vFace = dot(aRad, normalize(side + vec3(0.0, 1e-4, 0.0)));
      vD = aD;
      vR = r;
      vec3 off = aRad * r * uScale;
      off.y *= uSquash;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(c + off, 1.0);
    }`;
  const ROUTE_FRAG = `
    uniform vec3 uCol, uInk, uDim, uDone;
    uniform float uA0, uA1, uProg, uGrow, uSpacing, uPhase, uAlpha, uFlat, uFogN, uFogF;
    varying float vDepth;
    varying float vD;
    varying float vR;
    varying float vFace;
    void main() {
      if (vD > uGrow) discard;
      vec3 col = uCol;
      if (uFlat < 0.5) {
        float act = step(uA0 - 0.05, vD) * step(vD, uA1 + 0.05);
        col = mix(uDim, uCol, act);
        if (vD < uProg - 0.01) col = uDone;
        float face = clamp(vFace, -1.0, 1.0);
        float across = sqrt(max(0.0, 1.0 - face * face));
        float f = fract(vD / uSpacing - uPhase) * uSpacing / vR;
        float q = f + across * 1.25;
        float aa = min(0.14, fwidth(q) * 1.2 + 0.02);
        float chev = smoothstep(2.0 - aa, 2.0 + aa, q) * (1.0 - smoothstep(3.1 - aa, 3.1 + aa, q)) * (1.0 - smoothstep(0.72, 0.8, across)) * step(0.0, face);
        col = mix(col, uInk, chev * mix(0.35, 0.92, act));
        col *= 0.93 + 0.07 * face;
      }
      gl_FragColor = vec4(col, uAlpha * (1.0 - 0.92 * smoothstep(uFogN, uFogF, vDepth)));
      #include <colorspace_fragment>
    }`;

  // ---------- events for the page that embeds the viewer ----------
  const listeners = {};
  function emit(name, detail) {
    (listeners[name] || []).slice().forEach((fn) => { try { fn(detail); } catch (e) { console.error(e); } });
  }

  // ---------- one open viewer ----------
  function createViewer(opts) {
    const self = { alive: true, ready: false, opts };
    let model, P, router, route = null, T;
    let fromEnd = opts.from || null, toEnd = opts.to || null;
    let routeFromExplore = false;
    let root, topEl, titleEl, subEl, stage, canvas, labelsEl, levelsEl, toolsEl, followBtn, fitBtn, sheetEl, stepsEl, navEl, stateEl, toastEl, liveEl, creditEl;
    let renderer, scene, camera, sun, hemi, raycaster, ndc, v3;
    let W = 1, H = 1;
    let theme = isDark() ? 'dark' : 'light';
    let S = 1, Sto = 1, Hs = HS_MODEL, stretchAnim = null, exploded = false, pov = false;
    const cam = { az: -.6, pol: 1, dist: 300, tx: 0, ty: 0, tz: 0 };
    let tween = null, maxDist = 2000;
    const spin = { az: 0, pol: 0, x: 0, z: 0 };
    let free = { x0: 0, y0: 0, x1: 1, y1: 1, w: 1, h: 1, cx: .5, cy: .5 };
    let parts = [];      // everything that fades as a whole: { mesh, lines, op, target, lineBase, gain }
    let lv3 = [];        // per level: its main part (what the route uses, or all of it), with .rest and .ceil
    let conns = [];      // connector groups: { mesh, lines, lo, hi, op }
    let shell = null;    // { mesh, lines, op, target }
    let R = null;        // the route: { geo, meshes, U, D, Dorig, total, sm, levels:Set, steps }
    let hl = [];         // highlighted areas: { mesh, li, base }
    let disc = null;     // the accuracy disc of the user
    let labels = [], labelsDirty = false, levelLabels = [], tip = null, tipTimer = 0;
    let sel = -1, isolate = null, listMode = false;
    let follow = false, user = null, userStep = -1, manualAt = null, compassOn = false, compassHeading = null;
    let picked = null, exploreEnds = { from: null, to: null };
    let raf = 0, slowTimer = 0, lastT = 0, lastActivity = 0, shadowDirty = true, grow = null, phase = 0;
    let ro = null, mo = null, toastTimer = 0, scrollTimer = 0, progScroll = 0;
    // first-person view: where the eye is (x, y, level), which way the path goes (bearing), the head (yaw, pitch)
    let povT = 0, povAnim = null, camB = null, fog = null, hudEl = null, miniEl = null, scrubEl = null, hudKey = '';
    const pv = { x: 0, y: 0, level: 0, tx: 0, ty: 0, tl: 0, bearing: 0, tb: 0, slope: 0, yaw: 0, pitch: 0, along: 0, walk: null, free: false, device: false, dB: 0, dP: 0, orient: null };
    const disposables = [];
    const offs = [];
    const on = (el, type, fn, o) => { el.addEventListener(type, fn, o); offs.push(() => el.removeEventListener(type, fn, o)); };

    // ----- DOM -----
    function buildDom() {
      root = mk('section', 's3');
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-labelledby', 's3Title');
      root.innerHTML = `
        <header class="s3-top s3-glass">
          <div class="s3-title"><b id="s3Title"></b><span></span></div>
          <button class="s3-close" type="button" aria-label="Close station view">${svg('close', '0 0 14 14').replace('<svg', '<svg fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"')}</button>
        </header>
        <div class="s3-stage"><div class="s3-labels"></div></div>
        <nav class="s3-levels s3-glass" aria-label="Floors" hidden></nav>
        <div class="s3-tools">
          <button class="s3-fab s3-follow" type="button" aria-label="Follow my position" aria-pressed="false" hidden>${svg('follow')}</button>
          <button class="s3-fab s3-fit" type="button" aria-label="Fit to screen" hidden>${svg('fit')}</button>
        </div>
        <div class="s3-callout" hidden><span class="s3-callout-ico"></span><div><b></b><span></span></div></div>
        <canvas class="s3-mini" width="208" height="208" hidden aria-hidden="true"></canvas>
        <div class="s3-credit"></div>
        <section class="s3-sheet s3-glass" aria-label="Directions" hidden></section>
        <div class="s3-toast" role="status"></div>
        <div class="s3-state" hidden></div>
        <div class="s3-sr" aria-live="polite"></div>`;
      const q = (s) => root.querySelector(s);
      topEl = q('.s3-top'); titleEl = q('.s3-title b'); subEl = q('.s3-title span');
      stage = q('.s3-stage'); labelsEl = q('.s3-labels'); levelsEl = q('.s3-levels'); toolsEl = q('.s3-tools');
      followBtn = q('.s3-follow'); fitBtn = q('.s3-fit'); sheetEl = q('.s3-sheet'); stateEl = q('.s3-state');
      toastEl = q('.s3-toast'); liveEl = q('.s3-sr'); creditEl = q('.s3-credit');
      hudEl = q('.s3-callout'); miniEl = q('.s3-mini');
      titleEl.textContent = opts.title || 'Station';
      on(q('.s3-close'), 'click', () => api.close());
      on(fitBtn, 'click', () => { setFollow(false); moved = false; flyTo(currentPose(), 800); });
      on(followBtn, 'click', () => { setFollow(!follow); if (follow) enableCompass(); });
      on(root, 'keydown', onKey);
      root.classList.toggle('s3-dark', theme === 'dark');
      (opts.mount || document.body).appendChild(root);
    }

    function showState(kind) {
      const M = {
        loading: ['', 'Loading the station…'],
        nowebgl: ['3D isn’t available here', 'This browser or device can’t draw 3D graphics. The walking route is still on the map.'],
        model: ['The station didn’t load', 'Check your connection, then try again.'],
        three: ['The 3D view didn’t load', 'Check your connection, then try again.'],
        lost: ['The 3D view stopped', 'Your device ran out of graphics memory. Close this view and open it again.'],
      }[kind];
      stateEl.hidden = !M;
      if (!M) return;
      stateEl.innerHTML = '';
      if (kind === 'loading') {
        const f = mk('div', 's3-floors');
        f.setAttribute('aria-hidden', 'true');
        f.append(mk('i'), mk('i'), mk('i'));
        stateEl.append(f);
      }
      const p = mk('p');
      if (M[0]) p.append(mk('b', null, M[0]));
      p.append(M[1]);
      p.setAttribute('role', kind === 'loading' ? 'status' : 'alert');
      stateEl.append(p);
      if (kind === 'model' || kind === 'three') {
        const b = mk('button', null, 'Try again');
        b.type = 'button';
        b.onclick = () => { const o = self.opts; api.reopen(o); };
        stateEl.append(b);
      }
      if (kind !== 'loading') emit('error', { code: kind, message: M[1] });
    }
    function toast(text, ms) {
      toastEl.textContent = text;
      toastEl.classList.add('s3-show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('s3-show'), ms || 3200);
    }
    const say = (text) => { liveEl.textContent = text; };

    // ----- WebGL -----
    function initGL() {
      canvas = document.createElement('canvas');
      canvas.tabIndex = 0;
      canvas.setAttribute('role', 'application');
      canvas.setAttribute('aria-label', '3D model of the station. Drag to turn it, pinch or scroll to zoom, arrow keys also turn it. The walking steps are listed below.');
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setClearColor(0x000000, 0);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.shadowMap.autoUpdate = false;
      stage.insertBefore(canvas, labelsEl);
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(FOV, 1, 1, 6000);
      hemi = new THREE.HemisphereLight(0xffffff, 0xcccccc, 2);
      sun = new THREE.DirectionalLight(0xffffff, 1);
      sun.castShadow = true;
      scene.add(hemi, sun, sun.target);
      camB = new THREE.PerspectiveCamera(POV_FOV, 1, .2, 600);
      fog = new THREE.Fog(0xffffff, 1e6, 1e7);
      scene.fog = fog;
      raycaster = new THREE.Raycaster();
      ndc = new THREE.Vector2();
      v3 = new THREE.Vector3();
      on(canvas, 'webglcontextlost', (e) => { e.preventDefault(); cancelAnimationFrame(raf); raf = -1; showState('lost'); });
    }

    const track = (o) => { disposables.push(o); return o; };
    function clearScene() {
      for (const o of disposables) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
        if (o.parent) o.parent.remove(o);
      }
      disposables.length = 0;
      lv3 = []; conns = []; parts = []; shell = null; R = null; hl = []; disc = null;
    }

    // Which parts of the model the route uses: these stay solid, the rest recedes
    function markTouched() {
      for (const lv of P.levels) for (const a of lv.areas) a.touched = false;
      for (const c of model.connectors || []) c._touched = false;
      if (!route || !route.points || route.points.length < 2) return;
      const rp = route.points;
      const mark = (x, y, level) => {
        const lv = P.levels[P.idxOf(level)];
        for (const a of lv.areas) {
          const m = a.kind === 'room' ? 7 : 0;
          if (x < a.box[0] - m || x > a.box[2] + m || y < a.box[1] - m || y > a.box[3] + m) continue;
          if (m || (inRing(a.ring, x, y) && !a.holes.some((h) => inRing(h, x, y)))) a.touched = true;
        }
      };
      for (let i = 0; i < rp.length; i++) {
        const p = rp[i], q = rp[i + 1];
        if (Math.abs(p[2] - Math.round(p[2])) < .02) mark(p[0], p[1], Math.round(p[2]));
        if (!q) break;
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (Math.abs(q[2] - p[2]) < 1e-3) {
          for (let d = 2; d < len; d += 2) mark(lerp(p[0], q[0], d / len), lerp(p[1], q[1], d / len), Math.round(p[2]));
          continue;
        }
        // a change of level: which connector is it?
        const lo = Math.min(p[2], q[2]) - .05, hi = Math.max(p[2], q[2]) + .05;
        for (const c of model.connectors || []) {
          if (c.kind === 'elevator') {
            if (c.xy && Math.hypot(c.xy[0] - p[0], c.xy[1] - p[1]) < 3 && len < 1) c._touched = true;
            continue;
          }
          const ln = c.line || [];
          const near = (pt) => ln.some((v) => Math.hypot(v[0] - pt[0], v[1] - pt[1]) < 2.5 && v[2] >= lo && v[2] <= hi);
          if (near(p) && near(q)) c._touched = true;
        }
      }
      const d = destArea();
      if (d) d.touched = true;
    }
    function destArea() {
      const info = endInfo(toEnd, 'to');
      if (!route || !info.stop || !info.stop.xy) return null;
      const li = P.idxOf(info.stop.level || 0);
      let a = areaAt(P, li, info.stop.xy[0], info.stop.xy[1]);
      if (!a || a.kind !== 'platform') {
        const e = route.points[route.points.length - 1];
        a = areaAt(P, li, e[0], e[1]);
      }
      if (!a || a.kind !== 'platform') {
        let bd = Infinity;
        for (const q of P.levels[li].areas) {
          if (q.kind !== 'platform' || !(q.src.refs || []).includes(info.stop.ref)) continue;
          const d = Math.hypot((q.box[0] + q.box[2]) / 2 - info.stop.xy[0], (q.box[1] + q.box[3]) / 2 - info.stop.xy[1]);
          if (d < bd) { bd = d; a = q; }
        }
      }
      return a && a.kind === 'platform' ? a : null;
    }

    function buildScene() {
      T = THEME[theme];
      const C = (hex, a) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b, a == null ? 1 : a]; };
      const mix = (hex, m) => { const c = new THREE.Color(hex).lerp(new THREE.Color(m[0]), m[1]); return [c.r, c.g, c.b, 1]; };
      const solid = (side) => new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, side: side || THREE.FrontSide });
      const lineMat = (o) => new THREE.LineBasicMaterial({ color: T.line, transparent: true, opacity: o, depthWrite: false });
      // a part = one mesh with its outlines, faded as a whole
      const addPart = (g, ln, order, o) => {
        const mesh = track(new THREE.Mesh(g.build(S, Hs, true), solid(o && o.side)));
        mesh.castShadow = mesh.receiveShadow = !(o && o.ghost);
        mesh.frustumCulled = false;
        mesh.renderOrder = order;
        const lineBase = (o && o.line) || T.lineOpacity;
        const lines = track(new THREE.LineSegments(ln.build(S, Hs, false), lineMat(lineBase)));
        lines.frustumCulled = false;
        lines.renderOrder = order + 1;
        scene.add(mesh, lines);
        const part = Object.assign({ mesh, lines, op: 1, target: 1, lineBase, gain: 1 }, o && o.extra);
        parts.push(part);
        return part;
      };
      const hasRoute = !!(route && route.points && route.points.length > 1);
      markTouched();

      hemi.color.set(T.hemiSky); hemi.groundColor.set(T.hemiGround); hemi.intensity = T.hemi;
      sun.intensity = T.sun;
      sun.shadow.intensity = T.shadow;

      // floors
      const tracksBy = P.levels.map(() => []);
      for (const t of model.tracks || []) if (t.line && t.line.length > 1) tracksBy[P.idxOf(t.level || 0)].push(t);
      const cBed = C(T.bed), cRail = C(T.rail);
      P.levels.forEach((lv, li) => {
        const A = { g: new Geo(), ln: new Geo() }, B = { g: new Geo(), ln: new Geo() }, cg = new Geo();
        const base = T.level(lv.id);
        const cFloor = C(base), cPlat = mix(base, T.platform), cPlaza = mix(base, T.plaza), cRoom = mix(base, T.room), cCeil = mix(base, T.ceil);
        const next = P.levels[li + 1];
        const gapUp = next ? next.z - lv.z : 99;
        const indoor = lv.areas.some((a) => a.kind === 'floor');
        lv.ceilH = gapUp <= 9 ? clamp(gapUp - .7, 2.6, 5) : 3.4;
        for (const a of lv.areas) {
          const G = !hasRoute || a.touched ? A : B;
          const zr = P.zOf(a.level);
          a.top = 0; a.topH = 0;
          if (a.kind === 'room') { // a low block in the model, a full wall when you stand beside it
            const h = indoor ? lv.ceilH : clamp(a.src.height || 3, 2.2, 5);
            a.topH = h;
            G.g.prism(a.ring, a.holes, zr, 0, zr, 0, cRoom, cRoom, h);
            G.ln.loop(a.ring, zr, .03, h);
          } else if (a.kind === 'platform') {
            a.top = .05;
            G.g.prism(a.ring, a.holes, zr, -1.05, zr, .05, cPlat, cPlat);
            G.ln.loop(a.ring, zr, .08);
            a.holes.forEach((h) => G.ln.loop(h, zr, .08));
          } else if (a.kind === 'plaza') {
            a.top = -.07;
            G.g.prism(a.ring, a.holes, zr, -.4, zr, -.07, cPlaza, cPlaza);
            G.ln.loop(a.ring, zr, -.04);
          } else {
            G.g.prism(a.ring, a.holes, zr, -.5, zr, 0, cFloor, cFloor);
            G.ln.loop(a.ring, zr, .03);
            a.holes.forEach((h) => G.ln.loop(h, zr, .03));
            cg.prism(a.ring, a.holes, zr, 0, zr, 0, cCeil, null, lv.ceilH, true); // indoors there is a ceiling
          }
        }
        // tracks: sunk beside the platforms, flush where they cross a square (trams)
        const TG = hasRoute ? B : A;
        for (const t of tracksBy[li]) {
          const zr = P.zOf(t.level || 0);
          let run = [], runFlush = null;
          const flushRun = () => {
            if (run.length < 2) return;
            const zs = run.map(() => zr);
            if (runFlush) {
              TG.g.ribbon(run, .1, zs, .09, cRail, .72);
              TG.g.ribbon(run, .1, zs, .09, cRail, -.72);
            } else {
              TG.g.ribbon(run, 1.45, zs, -1.0, cBed, 0);
              TG.g.ribbon(run, .1, zs, -.9, cRail, .72);
              TG.g.ribbon(run, .1, zs, -.9, cRail, -.72);
            }
          };
          for (let i = 0; i < t.line.length - 1; i++) {
            const a = t.line[i], b = t.line[i + 1];
            const hit = areaAt(P, li, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
            const flush = !!hit && hit.kind !== 'room';
            if (runFlush !== null && flush !== runFlush) { flushRun(); run = [a]; }
            if (!run.length) run.push(a);
            run.push(b);
            runFlush = flush;
          }
          flushRun();
        }
        const main = addPart(A.g, A.ln, li * 10);
        main.rest = B.g.count() ? addPart(B.g, B.ln, li * 10 + 2) : null;
        main.ceil = null;
        main.hasMain = A.g.count() > 0;
        if (cg.count()) {
          const m = track(new THREE.Mesh(cg.build(S, Hs, true), new THREE.MeshLambertMaterial({ vertexColors: true })));
          m.frustumCulled = false;
          m.visible = false;
          scene.add(m);
          main.ceil = m;
        }
        lv3.push(main);
      });

      // stairs, escalators, ramps and lifts, grouped by the floors they join (and by whether the route uses them)
      const col = { stairs: C(T.stairs), ramp: C(T.ramp), tread: C(T.tread), glass: C(T.glass[0], T.glass[1]), shaft: C(T.shaft[0], T.shaft[1]), cab: C(T.cab) };
      const groups = new Map();
      const groupFor = (lo, hi, touched) => {
        const k = lo + ':' + hi + ':' + touched;
        if (!groups.has(k)) groups.set(k, { lo, hi, touched, g: new Geo(), ln: new Geo() });
        return groups.get(k);
      };
      for (const c of model.connectors || []) {
        const touched = !hasRoute || !!c._touched;
        if (c.kind === 'elevator') {
          if (!c.xy || !c.levels || !c.levels.length) continue;
          const zs = c.levels.map((l) => P.zOf(l));
          const z0 = Math.min(...zs), z1 = Math.max(...zs);
          const idx = c.levels.map((l) => P.idxOf(l));
          const G = groupFor(Math.min(...idx), Math.max(...idx), touched);
          for (const z of zs) G.g.box(c.xy[0], c.xy[1], 1.0, z, 0, z, 2.3, col.cab);
          const r = G.g.box(c.xy[0], c.xy[1], 1.3, z0, 0, z1, 3.1, col.shaft);
          for (const p of r) G.ln.seg([p[0], p[1], z0, 0], [p[0], p[1], z1, 3.1]);
          G.ln.loop(r, z1, 3.1);
        } else if (c.line && c.line.length > 1) {
          const ls = c.line.map((p) => p[2]);
          const G = groupFor(P.idxOf(Math.floor(Math.min(...ls) + 1e-6)), P.idxOf(Math.ceil(Math.max(...ls) - 1e-6)), touched);
          addConnector(G.g, G.ln, P, c, col);
        }
      }
      for (const G of groups.values()) {
        if (!G.g.count()) continue;
        conns.push(addPart(G.g, G.ln, G.lo * 10 + 5, { side: THREE.DoubleSide, extra: { lo: G.lo, hi: G.hi, touched: G.touched } }));
      }

      // the town and the roofs around it all: a ghost in the model view, solid when you stand in it
      {
        const g = new Geo(), ln = new Geo();
        const c = C(T.shell);
        for (const s of model.shell || []) {
          const ring = cleanRing(s.ring, true);
          if (!ring || P.decks.has(s)) continue;
          const holes = (s.holes || []).map((h) => cleanRing(h, false)).filter(Boolean);
          const base = s.base || 0, top = s.top == null ? base + 4 : s.top;
          if (s.kind === 'building') { // not stretched like the floors, and lower still in the model view
            const h = clamp(top - base, 3, 45);
            g.prism(ring, holes, base, 0, base, 0, c, c, h);
            ln.loop(ring, base, 0, h);
          } else {
            g.prism(ring, holes, base, 0, top, 0, c, top - base > 1.2 ? c : null);
            g.prism(ring, holes, base, 0, base, 0, c, null, 0, true); // seen from below
            ln.loop(ring, top, 0);
          }
        }
        if (g.count()) {
          shell = addPart(g, ln, 500, { ghost: true, line: T.shellLine, extra: { gain: T.shellAlpha } });
          shell.mesh.material.depthWrite = false;
        }
      }

      // sun: fixed to the model, so the shadows only need redrawing when the model changes
      const [bx0, by0, bx1, by1] = P.box;
      const cx = (bx0 + bx1) / 2, cz = -(by0 + by1) / 2;
      const rad = Math.hypot(bx1 - bx0, by1 - by0) / 2 + (P.zMax - P.zMin) * P.vex * EXPLODE;
      sun.target.position.set(cx, 0, cz);
      sun.position.set(cx - rad * .55, rad * 1.5, cz + rad * .5);
      const sc = sun.shadow.camera;
      sc.left = -rad; sc.right = rad; sc.top = rad; sc.bottom = -rad; sc.near = 1; sc.far = rad * 4;
      sc.updateProjectionMatrix();
      const size = rad > 260 || (window.devicePixelRatio || 1) < 1.5 ? 2048 : 1024;
      sun.shadow.mapSize.set(size, size);
      sun.shadow.bias = -0.0006;
      sun.shadow.normalBias = (rad * 2 / size) * 2.2;
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      shadowDirty = true;

      buildRoute();
      buildUserDisc();
      povScene();
    }
    // What differs when you stand inside the model: floors seen from below, ceilings, solid buildings, haze
    function povScene() {
      for (const l of lv3) {
        for (const part of [l, l.rest]) {
          if (!part) continue;
          const side = pov ? THREE.DoubleSide : THREE.FrontSide;
          if (part.mesh.material.side !== side) { part.mesh.material.side = side; part.mesh.material.needsUpdate = true; }
        }
        if (l.ceil) l.ceil.visible = pov;
      }
      if (shell) shell.gain = pov ? .9 : T.shellAlpha;
      fog.color.set(theme === 'dark' ? '#1d2026' : '#eceff3');
      shadowDirty = true;
    }

    // ----- the route -----
    function buildRoute() {
      R = null;
      if (!route || !route.points || route.points.length < 2) return;
      const sm = smoothPath(route.points);
      const m = sm.length, K = 10;
      const D = new Float32Array(m);
      const Dorig = new Float32Array(route.points.length);
      const levels = new Set();
      for (let j = 0; j < m; j++) {
        if (j) {
          const a = sm[j - 1], b = sm[j];
          D[j] = D[j - 1] + Math.hypot(b.x - a.x, b.y - a.y, (P.zOf(b.l) - P.zOf(a.l)) * P.vex);
        }
        if (sm[j].o >= 0) Dorig[sm[j].o] = D[j];
      }
      for (const p of route.points) { levels.add(P.idxOf(Math.floor(p[2] + 1e-6))); levels.add(P.idxOf(Math.ceil(p[2] - 1e-6))); }
      const nv = m * K + 2;
      const pos = new Float32Array(nv * 3), zr = new Float32Array(nv), dd = new Float32Array(nv);
      for (let j = 0; j < m; j++) {
        for (let k = 0; k < K; k++) {
          const i = j * K + k;
          pos[i * 3] = sm[j].x; pos[i * 3 + 2] = -sm[j].y;
          zr[i] = P.zOf(sm[j].l); dd[i] = D[j];
        }
      }
      for (const [i, j] of [[m * K, 0], [m * K + 1, m - 1]]) { pos[i * 3] = sm[j].x; pos[i * 3 + 2] = -sm[j].y; zr[i] = P.zOf(sm[j].l); dd[i] = D[j]; }
      const index = [];
      for (let j = 0; j < m - 1; j++) {
        for (let k = 0; k < K; k++) {
          const a = j * K + k, b = (j + 1) * K + k, c = (j + 1) * K + (k + 1) % K, d = j * K + (k + 1) % K;
          index.push(a, c, b, a, d, c);
        }
      }
      for (let k = 0; k < K; k++) {
        index.push(m * K, (k + 1) % K, k);
        index.push(m * K + 1, (m - 1) * K + k, (m - 1) * K + (k + 1) % K);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aZr', new THREE.BufferAttribute(zr, 1));
      geo.setAttribute('aD', new THREE.BufferAttribute(dd, 1));
      geo.setAttribute('aRad', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
      geo.setAttribute('aTan', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
      geo.setIndex(index);
      const total = D[m - 1];
      const col = (hex) => new THREE.Color(hex);
      const shared = {
        uS: { value: S }, uPx: { value: .01 }, uRmin: { value: .5 }, uA0: { value: -1 }, uA1: { value: 1e9 }, uThin: { value: .7 },
        uInk: { value: col(T.chevron) }, uDim: { value: col(T.dim) }, uDone: { value: col(T.done) },
        uProg: { value: -1 }, uGrow: { value: 1e9 }, uSpacing: { value: 8 }, uPhase: { value: 0 },
        uSquash: { value: 1 }, uFogN: { value: 1e8 }, uFogF: { value: 1e9 },
      };
      const make = (extra, o) => new THREE.ShaderMaterial(Object.assign({
        uniforms: Object.assign({}, shared, extra), vertexShader: ROUTE_VERT, fragmentShader: ROUTE_FRAG, transparent: true,
      }, o));
      const mats = [
        make({ uCol: { value: col(T.casing) }, uScale: { value: 1.36 }, uAlpha: { value: 1 }, uFlat: { value: 1 } }, { side: THREE.BackSide }),
        make({ uCol: { value: col(T.route) }, uScale: { value: 1 }, uAlpha: { value: 1 }, uFlat: { value: 0 } }, {}),
        make({ uCol: { value: col(T.route) }, uScale: { value: 1 }, uAlpha: { value: .7 }, uFlat: { value: 0 } }, { depthFunc: THREE.GreaterDepth, depthWrite: false }),
      ];
      const meshes = mats.map((mat, i) => {
        const mesh = track(new THREE.Mesh(geo, mat));
        mesh.frustumCulled = false;
        mesh.renderOrder = 600 + i;
        scene.add(mesh);
        return mesh;
      });
      const A = route.dists && route.dists.length === route.points.length ? route.dists : (() => {
        const d = [0];
        for (let i = 1; i < route.points.length; i++) d.push(d[i - 1] + Math.hypot(route.points[i][0] - route.points[i - 1][0], route.points[i][1] - route.points[i - 1][1]));
        return d;
      })();
      R = { geo, meshes, U: shared, sm, D, Dorig, total, levels, K, A };
      routeFrames();
    }
    // The directions around the centre line depend on how steep the stairs look, so on the vertical stretch
    function routeFrames() {
      if (!R) return;
      const { sm, K, geo } = R, m = sm.length;
      const rad = geo.attributes.aRad.array, tan = geo.attributes.aTan.array;
      let bx = 1, by = 0, bz = 0, tx = 1, ty = 0, tz = 0;
      const y = (j) => P.zOf(sm[j].l) * S;
      for (let j = 0; j < m; j++) {
        const a = Math.max(0, j - 1), b = Math.min(m - 1, j + 1);
        let dx = sm[b].x - sm[a].x, dy = y(b) - y(a), dz = -(sm[b].y - sm[a].y);
        const l = Math.hypot(dx, dy, dz);
        if (l > 1e-4) { tx = dx / l; ty = dy / l; tz = dz / l; }
        // side = t × up; keep the previous one where the path is vertical (a lift)
        let sx = -tz, sz = tx;
        const sl = Math.hypot(sx, sz);
        if (sl > .05) { bx = sx / sl; by = 0; bz = sz / sl; }
        // n = side × t
        const nx = by * tz - bz * ty, ny = bz * tx - bx * tz, nz = bx * ty - by * tx;
        for (let k = 0; k < K; k++) {
          const ang = (k / K) * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang), i = (j * K + k) * 3;
          rad[i] = nx * c + bx * s; rad[i + 1] = ny * c + by * s; rad[i + 2] = nz * c + bz * s;
          tan[i] = tx; tan[i + 1] = ty; tan[i + 2] = tz;
        }
        if (j === 0 || j === m - 1) { const i = (m * K + (j ? 1 : 0)) * 3; tan[i] = tx; tan[i + 1] = ty; tan[i + 2] = tz; }
      }
      geo.attributes.aRad.needsUpdate = true;
      geo.attributes.aTan.needsUpdate = true;
    }
    // display distance along the route at a (fractional) index into route.points
    function distAt(pi) {
      const i = clamp(Math.floor(pi), 0, R.Dorig.length - 1), j = Math.min(R.Dorig.length - 1, i + 1);
      return lerp(R.Dorig[i], R.Dorig[j], clamp(pi - i, 0, 1));
    }
    function pointAt(pi) {
      const pts = route.points, i = clamp(Math.floor(pi), 0, pts.length - 1), j = Math.min(pts.length - 1, i + 1), t = clamp(pi - i, 0, 1);
      return [lerp(pts[i][0], pts[j][0], t), lerp(pts[i][1], pts[j][1], t), lerp(pts[i][2], pts[j][2], t)];
    }

    function highlight(area, hex, alpha) {
      const g = new Geo();
      const zr = P.zOf(area.level);
      g.prism(area.ring, area.holes, zr, 0, zr, (area.top || 0) + .07, [1, 1, 1, 1], null, area.topH || 0);
      const mesh = track(new THREE.Mesh(g.build(S, Hs, false), new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: alpha, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })));
      mesh.frustumCulled = false;
      mesh.renderOrder = area.li * 10 + 2;
      scene.add(mesh);
      const h = { mesh, li: area.li, base: alpha };
      hl.push(h);
      return h;
    }
    function dropHighlight(h) {
      if (!h) return;
      hl = hl.filter((x) => x !== h);
      scene.remove(h.mesh);
      h.mesh.geometry.dispose(); h.mesh.material.dispose();
      const i = disposables.indexOf(h.mesh);
      if (i >= 0) disposables.splice(i, 1);
    }

    function buildUserDisc() {
      const mesh = track(new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({ color: 0x0a84ff, transparent: true, opacity: .16, depthTest: false, depthWrite: false })));
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 700;
      mesh.visible = false;
      scene.add(mesh);
      disc = mesh;
    }

    // ----- camera -----
    function limit(p) {
      const [bx0, by0, bx1, by1] = P.box, m = Math.max(20, P.diag * .15);
      p.pol = clamp(p.pol, .1, 1.42);
      p.dist = clamp(p.dist, 16, maxDist);
      p.tx = clamp(p.tx, bx0 - m, bx1 + m);
      p.tz = clamp(p.tz, -by1 - m, -by0 + m);
      p.ty = clamp(p.ty, P.zMin * Sto - 8, P.zMax * Sto + 14);
      return p;
    }
    function applyCam() {
      const sp = Math.sin(cam.pol), cp = Math.cos(cam.pol);
      camera.position.set(cam.tx + cam.dist * sp * Math.sin(cam.az), cam.ty + cam.dist * cp, cam.tz + cam.dist * sp * Math.cos(cam.az));
      camera.lookAt(cam.tx, cam.ty, cam.tz);
      const e = povT;
      if (e > 0) {
        const b = pv.device ? pv.dB : pv.bearing + pv.yaw;
        const ph = clamp(pv.device ? pv.dP : pv.pitch + pv.slope - .1, -1.25, 1.25);
        camB.position.set(pv.x, P.zOf(pv.level) * S + EYE, -pv.y);
        v3.set(Math.sin(b) * Math.cos(ph), Math.sin(ph), -Math.cos(b) * Math.cos(ph)).add(camB.position);
        camB.lookAt(v3);
        camera.position.lerp(camB.position, e);
        camera.quaternion.slerp(camB.quaternion, e);
      }
      camera.fov = lerp(FOV, POV_FOV, e);
      camera.near = lerp(Math.max(1, cam.dist * .04), .25, e);
      camera.far = lerp(cam.dist + P.diag * 3 + 400, 700, e);
      camera.updateProjectionMatrix();
      const f = Math.pow(e, 3);
      fog.near = lerp(1e6, 28, f);
      fog.far = lerp(1e7, 210, f);
    }
    const focal = () => H / (2 * Math.tan(FOV * Math.PI / 360));
    // The pose (looking from az / pol) that just fits the points into the free part of the screen
    function fitPose(pts, az, pol, pad) {
      const sp = Math.sin(pol), cp = Math.cos(pol), sa = Math.sin(az), ca = Math.cos(az);
      const f = [-sp * sa, -cp, -sp * ca], r = [ca, 0, -sa], u = [-sa * cp, sp, -ca * cp];
      let r0 = Infinity, r1 = -Infinity, u0 = Infinity, u1 = -Infinity, f0 = Infinity, f1 = -Infinity;
      for (const p of pts) {
        const pr = p[0] * r[0] + p[2] * r[2], pu = p[0] * u[0] + p[1] * u[1] + p[2] * u[2], pf = p[0] * f[0] + p[1] * f[1] + p[2] * f[2];
        if (pr < r0) r0 = pr; if (pr > r1) r1 = pr;
        if (pu < u0) u0 = pu; if (pu > u1) u1 = pu;
        if (pf < f0) f0 = pf; if (pf > f1) f1 = pf;
      }
      const F = focal();
      const tx = Math.max(60, free.w) / 2 / F, ty = Math.max(60, free.h) / 2 / F;
      const dist = Math.max(((r1 - r0) / 2 + pad) / tx, ((u1 - u0) / 2 + pad) / ty) + (f1 - f0) / 2;
      const cr = (r0 + r1) / 2, cu = (u0 + u1) / 2, cf = (f0 + f1) / 2;
      return { az, pol, dist, tx: r[0] * cr + u[0] * cu + f[0] * cf, ty: u[1] * cu + f[1] * cf, tz: r[2] * cr + u[2] * cu + f[2] * cf };
    }
    // Try the view from all around and keep the best: big on screen, stairs seen from the side, walking away from the eye
    function bestPose(pts, o) {
      const cands = [];
      let dmin = Infinity;
      for (let k = 0; k < 24; k++) {
        const pose = fitPose(pts, k * Math.PI / 12, o.pol, o.pad);
        cands.push(pose);
        dmin = Math.min(dmin, pose.dist);
      }
      let best = null, bestScore = -Infinity;
      for (const pose of cands) {
        const fx = -Math.sin(pose.az), fy = Math.cos(pose.az); // view direction on the ground (model x/y); right = (fy, -fx)
        let side = 0, wsum = 0;
        for (const s of o.inclines || []) { side += s[2] * Math.abs(s[0] * fy - s[1] * fx); wsum += s[2]; }
        if (wsum) side /= wsum;
        const front = o.dir ? o.dir[0] * fx + o.dir[1] * fy : 0;
        const cont = o.near == null ? 0 : 1 - Math.abs(angDiff(pose.az, o.near)) / Math.PI;
        const score = (o.wFit || 1) * (dmin / pose.dist) + (o.wSide || 0) * side + (o.wFront || 0) * front + (o.wCont || 0) * cont;
        if (score > bestScore) { bestScore = score; best = pose; }
      }
      return best;
    }
    const dpt = (x, y, level, lift) => [x, P.zOf(level) * Sto + (lift || 0), -y];
    function routeSection(i0, i1) { // points of route.points[i0..i1] for framing, with what the scoring needs
      const pts = [], inclines = [];
      const rp = route.points;
      for (let i = i0; i <= i1; i++) {
        pts.push(dpt(rp[i][0], rp[i][1], rp[i][2], 0));
        if (i > i0 && Math.abs(rp[i][2] - rp[i - 1][2]) > 1e-3) {
          const dx = rp[i][0] - rp[i - 1][0], dy = rp[i][1] - rp[i - 1][1], l = Math.hypot(dx, dy);
          if (l > .5) inclines.push([dx / l, dy / l, l]);
        }
      }
      const a = rp[i0], b = rp[i1];
      const dl = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return { pts, inclines, dir: dl > 1 ? [(b[0] - a[0]) / dl, (b[1] - a[1]) / dl] : null };
    }
    function overviewPose() {
      if (route && R) {
        const s = routeSection(0, route.points.length - 1);
        const e = route.points[route.points.length - 1];
        s.pts.push(dpt(e[0], e[1], e[2], 7)); // room for the sign
        const multi = R.levels.size > 1;
        const ext = Math.max(20, Math.hypot(...[0, 2].map((k) => Math.max(...s.pts.map((p) => p[k])) - Math.min(...s.pts.map((p) => p[k])))));
        return bestPose(s.pts, { pol: multi ? 1.02 : .86, pad: Math.max(7, ext * .07), inclines: s.inclines, dir: s.dir, wFit: 1, wSide: .3, wFront: .22 });
      }
      return levelPose(isolate);
    }
    function levelPose(li) {
      const pts = [];
      // all floors: the station itself (around its train platforms), not the whole neighbourhood
      const tr = li == null ? (model.stops || []).filter((st) => st.mode === 'train' && st.xy) : [];
      if (tr.length) {
        const cx = tr.reduce((a, st) => a + st.xy[0], 0) / tr.length, cy = tr.reduce((a, st) => a + st.xy[1], 0) / tr.length;
        const ds = tr.map((st) => Math.hypot(st.xy[0] - cx, st.xy[1] - cy)).sort((p, q) => p - q);
        const r = clamp(ds[ds.length >> 1] * 1.3, 50, 170);
        for (const lv of P.levels) {
          if (!lv.box || lv.box[0] > cx + r || lv.box[2] < cx - r || lv.box[1] > cy + r || lv.box[3] < cy - r) continue;
          for (const [x, y] of [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]]) pts.push(dpt(clamp(x, lv.box[0], lv.box[2]), clamp(y, lv.box[1], lv.box[3]), lv.id, 0));
        }
      }
      if (!pts.length) P.levels.forEach((lv, i) => {
        if ((li != null && i !== li) || !lv.box) return;
        const [x0, y0, x1, y1] = lv.box;
        for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) pts.push(dpt(x, y, lv.id, 0));
      });
      if (!pts.length) pts.push([0, 0, 0]);
      return bestPose(pts, { pol: li != null ? .8 : .88, pad: Math.max(6, P.diag * .03), wFit: 1, wCont: .25, near: tween ? tween.to.az : cam.az });
    }
    function stepPose(i) {
      const st = route.steps[i];
      const s = routeSection(st.from, Math.max(st.from, st.to));
      const lift = st.kind === 'arrive' || i === route.steps.length - 1;
      if (lift) { const e = route.points[st.to]; s.pts.push(dpt(e[0], e[1], e[2], 7)); }
      const xs = s.pts.map((p) => p[0]), zs = s.pts.map((p) => p[2]);
      const ext = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
      const pad = Math.max(9, 20 - ext / 2);
      const climb = st.kind !== 'walk' && st.kind !== 'arrive';
      const near = tween ? tween.to.az : cam.az;
      if (!s.dir && i > 0) { // a lift or the arrival: keep looking the way we came
        const prev = routeSection(route.steps[i - 1].from, route.steps[i - 1].to);
        s.dir = prev.dir;
      }
      return bestPose(s.pts, climb
        ? { pol: 1.1, pad, inclines: s.inclines, dir: s.dir, wFit: .35, wSide: .75, wFront: .3, wCont: .2, near }
        : { pol: .92, pad, dir: s.dir, wFit: .5, wFront: .55, wCont: .2, near });
    }
    function currentPose() {
      if (route && R && sel >= 0 && isolate == null) return stepPose(sel);
      if (isolate != null) return levelPose(isolate);
      return overviewPose();
    }
    function flyTo(pose, dur) {
      pose = limit(Object.assign({}, pose));
      spin.az = spin.pol = spin.x = spin.z = 0;
      if (reducedMotion() || dur === 0) { Object.assign(cam, pose); tween = null; }
      else tween = { from: Object.assign({}, cam), to: pose, daz: angDiff(pose.az, cam.az), t0: performance.now(), dur: dur || 900 };
      request();
    }
    function stepTween(now) {
      if (!tween) return false;
      const t = clamp((now - tween.t0) / tween.dur, 0, 1), e = spring(t), a = tween.from, b = tween.to;
      cam.az = a.az + tween.daz * e;
      cam.pol = lerp(a.pol, b.pol, e);
      cam.dist = Math.exp(lerp(Math.log(a.dist), Math.log(b.dist), e));
      cam.tx = lerp(a.tx, b.tx, e); cam.ty = lerp(a.ty, b.ty, e); cam.tz = lerp(a.tz, b.tz, e);
      if (t >= 1) tween = null;
      return true;
    }
    function stepSpin(dt) {
      if (!spin.az && !spin.pol && !spin.x && !spin.z) return false;
      cam.az += spin.az * dt; cam.pol += spin.pol * dt; cam.tx += spin.x * dt; cam.tz += spin.z * dt;
      limit(cam);
      const k = Math.exp(-dt / 280);
      spin.az *= k; spin.pol *= k; spin.x *= k; spin.z *= k;
      if (Math.abs(spin.az) < 2e-5) spin.az = 0;
      if (Math.abs(spin.pol) < 2e-5) spin.pol = 0;
      if (Math.abs(spin.x) < 1e-3) spin.x = 0;
      if (Math.abs(spin.z) < 1e-3) spin.z = 0;
      return true;
    }

    // ----- what is solid and what recedes -----
    function setTargets() {
      const n = P.levels.length;
      const main = new Array(n).fill(1), rest = new Array(n).fill(1);
      let shellT = .5;
      const routed = !!(route && R);
      if (pov) shellT = 1;
      else if (isolate != null) {
        for (let i = 0; i < n; i++) main[i] = rest[i] = i === isolate ? 1 : .05;
        shellT = 0;
      } else if (routed) {
        const lo = Math.min(...R.levels);
        if (sel < 0) { // the whole route: what it uses is solid, everything else a ghost
          for (let i = 0; i < n; i++) rest[i] = R.levels.has(i) ? .13 : i > lo ? .04 : .1;
          shellT = .22;
        } else { // one step: its floor in full, floors above cut away
          const st = route.steps[sel], l2 = st.toLevel == null ? st.level : st.toLevel;
          const a = P.idxOf(Math.min(st.level, l2)), b = P.idxOf(Math.max(st.level, l2));
          for (let i = 0; i < n; i++) {
            if (i > b) { main[i] = .06; rest[i] = .04; }
            else if (i >= a) { main[i] = 1; rest[i] = .5; }
            else { main[i] = .85; rest[i] = .1; }
          }
          shellT = b >= n - 1 ? .25 : 0;
        }
      }
      lv3.forEach((l, i) => { l.target = main[i]; if (l.rest) l.rest.target = rest[i]; });
      conns.forEach((c) => {
        if (routed && !pov && isolate == null) c.target = c.touched ? Math.min(main[c.lo], main[c.hi]) : Math.min(rest[c.lo], rest[c.hi]);
        else { let t = 0; for (let i = c.lo; i <= c.hi; i++) t = Math.max(t, main[i]); c.target = t; }
      });
      if (shell) shell.target = shellT;
      // the route: the selected step is bright, the rest thinner and paler
      if (R) {
        if (sel >= 0 && !pov) {
          const st = route.steps[sel];
          R.U.uA0.value = distAt(st.from);
          R.U.uA1.value = distAt(st.to);
        } else { R.U.uA0.value = -1; R.U.uA1.value = 1e9; }
      }
      const active = new Set();
      if (route && sel >= 0) {
        const st = route.steps[sel];
        active.add(P.idxOf(st.level));
        if (st.toLevel != null) active.add(P.idxOf(st.toLevel));
      } else if (isolate != null) active.add(isolate);
      levelLabels.forEach((L) => {
        L.el.classList.toggle('s3-active', active.has(L.li));
        L.el.classList.toggle('s3-dim', routed && !R.levels.has(L.li));
      });
      request();
    }
    function applyOpacity() {
      for (const p of parts) {
        const m = p.mesh.material;
        m.opacity = p.op * p.gain;
        const solid = m.opacity >= .45;
        if (m.depthWrite !== solid) { m.depthWrite = solid; shadowDirty = true; }
        p.mesh.castShadow = solid && p !== shell;
        p.mesh.visible = p.lines.visible = p.op > .01;
        p.lines.material.opacity = p === shell ? p.lineBase * p.op : p.lineBase * (.3 + .7 * p.op) * (p.op < .5 ? 1.3 : 1);
      }
      hl.forEach((h) => { const o = Math.max(lv3[h.li].op, lv3[h.li].rest ? lv3[h.li].rest.op : 0); h.mesh.material.opacity = h.base * o; h.mesh.visible = o > .3; });
    }
    function stepOpacity(dt) {
      let busy = false;
      const k = reducedMotion() ? 1 : 1 - Math.exp(-dt / 110);
      for (const o of parts) {
        if (o.op === o.target) continue;
        o.op += (o.target - o.op) * k;
        if (Math.abs(o.target - o.op) < .004) o.op = o.target; else busy = true;
      }
      applyOpacity();
      return busy;
    }
    const snapOpacity = () => { for (const p of parts) p.op = p.target; applyOpacity(); };
    // how much of a floor shows: its solid part if it has one, else its receding part
    const vis = (li) => { const l = lv3[li]; return l.hasMain ? l.op : l.rest ? l.rest.op : 0; };

    // ----- vertical stretch ("spread the floors") -----
    function restretch(finish) {
      for (const p of parts) { stretch(p.mesh.geometry, S, Hs, finish); stretch(p.lines.geometry, S, Hs, finish); }
      for (const l of lv3) if (l.ceil) stretch(l.ceil.geometry, S, Hs, finish);
      for (const h of hl) stretch(h.mesh.geometry, S, Hs, finish);
      if (R) { R.U.uS.value = S; routeFrames(); }
      shadowDirty = true;
    }
    function stretchTo(to, dur, hs) {
      Sto = to;
      const toH = hs == null ? Hs : hs;
      if (reducedMotion() || !dur) { S = to; Hs = toH; stretchAnim = null; restretch(true); }
      else stretchAnim = { from: S, to, fromH: Hs, toH, t0: performance.now(), dur };
      request();
    }
    function stepStretch(now) {
      if (!stretchAnim) return false;
      const t = clamp((now - stretchAnim.t0) / stretchAnim.dur, 0, 1), e = spring(t);
      S = lerp(stretchAnim.from, stretchAnim.to, e);
      Hs = lerp(stretchAnim.fromH, stretchAnim.toH, e);
      const done = t >= 1;
      if (done) stretchAnim = null;
      restretch(done);
      return true;
    }

    // ----- first-person view -----
    const stepAtPi = (pi) => {
      const st = route.steps;
      for (let i = 0; i < st.length; i++) if (st[i].kind !== 'arrive' && pi < st[i].to - 1e-6) return i;
      return st.length - 1;
    };
    function walkTo(along) {
      along = clamp(along, 0, R.A[R.A.length - 1]);
      if (reducedMotion()) { pv.along = along; pv.walk = null; }
      else pv.walk = { from: pv.along, to: along, t0: performance.now(), dur: clamp(Math.abs(along - pv.along) * 55, 450, 3200) };
      request();
    }
    function setPov(on) {
      on = !!on;
      if (on === pov || !self.ready) return;
      pov = on;
      root.classList.toggle('s3-pov', pov);
      if (pov) {
        if (isolate != null) { isolate = null; syncLevels(); }
        pv.yaw = pv.pitch = pv.slope = 0;
        pv.walk = null;
        if (route && R) {
          pv.free = false;
          pv.along = user && user.along != null ? user.along : opts.povAt != null ? clamp(+opts.povAt, 0, R.A[R.A.length - 1]) : R.A[route.steps[Math.max(0, sel)].from];
          opts.povAt = null;
          const pt = pointAt(piAt(pv.along));
          pv.x = pv.tx = pt[0]; pv.y = pv.ty = pt[1]; pv.level = pv.tl = pt[2];
          const q = pointAt(piAt(Math.min(R.A[R.A.length - 1], pv.along + 4)));
          pv.bearing = pv.tb = Math.hypot(q[0] - pt[0], q[1] - pt[1]) > .3 ? Math.atan2(q[0] - pt[0], q[1] - pt[1]) : -cam.az;
        } else {
          pv.free = true;
          const at = picked || (user && user.sx != null ? { xy: [user.sx, user.sy], level: Math.round(user.sl) } : null) || ((model.entrances || [])[0]) || { xy: [cam.tx, -cam.tz], level: P.levels[P.idxOf(0)].id };
          pv.x = pv.tx = at.xy[0]; pv.y = pv.ty = at.xy[1]; pv.level = pv.tl = at.level || 0;
          pv.bearing = pv.tb = -cam.az;
        }
      } else {
        pv.device = false;
        cam.tx = pv.x; cam.tz = -pv.y; cam.ty = P.zOf(pv.level) * P.vex;
      }
      povAnim = { from: povT, to: pov ? 1 : 0, t0: performance.now(), dur: reducedMotion() ? 1 : 1300 };
      stretchTo(pov ? 1 : P.vex * (exploded ? EXPLODE : 1), 1100, pov ? 1 : HS_MODEL);
      povScene();
      setTargets();
      syncPov();
      if (!pov) flyTo(currentPose(), 1300);
      hudKey = '';
      say(pov ? 'Street-level view' : 'Model view');
      emit('pov', pov);
      touch();
      request();
    }
    function stepPov(dt, now) {
      let busy = false;
      if (povAnim) {
        const t = clamp((now - povAnim.t0) / povAnim.dur, 0, 1);
        povT = lerp(povAnim.from, povAnim.to, spring(t));
        if (t >= 1) { povT = povAnim.to; povAnim = null; }
        busy = true;
      }
      if (!pov) return busy;
      const k = (tau) => (reducedMotion() ? 1 : 1 - Math.exp(-dt / tau));
      if (!pv.free && route && R) {
        const total = R.A[R.A.length - 1];
        if (follow && user && user.salong != null) { pv.along = user.salong; pv.walk = null; }
        else if (pv.walk) {
          const t = clamp((now - pv.walk.t0) / pv.walk.dur, 0, 1), e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          pv.along = lerp(pv.walk.from, pv.walk.to, e);
          if (t >= 1) pv.walk = null;
          busy = true;
        }
        const pi = piAt(pv.along), pt = pointAt(pi);
        const q = pointAt(piAt(Math.min(total, pv.along + 4)));
        const dh = Math.hypot(q[0] - pt[0], q[1] - pt[1]);
        if (dh > .3) pv.tb = Math.atan2(q[0] - pt[0], q[1] - pt[1]);
        pv.slope = lerp(pv.slope, Math.atan2(P.zOf(q[2]) - P.zOf(pt[2]), Math.max(2, dh)) * .55, k(300));
        pv.tx = pt[0]; pv.ty = pt[1]; pv.tl = pt[2];
        const cs = stepAtPi(pi);
        if (cs !== sel) select(cs, { fromPov: true });
      } else if (follow && user && user.sx != null) { pv.tx = user.sx; pv.ty = user.sy; pv.tl = user.sl; }
      const kk = k(140);
      pv.x += (pv.tx - pv.x) * kk; pv.y += (pv.ty - pv.y) * kk; pv.level += (pv.tl - pv.level) * kk;
      const db = angDiff(pv.tb, pv.bearing);
      pv.bearing += db * k(260);
      if (Math.hypot(pv.tx - pv.x, pv.ty - pv.y) > .02 || Math.abs(pv.tl - pv.level) > .003 || Math.abs(db) > .004) busy = true;
      if (pv.device && pv.orient) {
        pv.dB += angDiff(pv.orient.b, pv.dB) * k(90);
        pv.dP += (pv.orient.p - pv.dP) * k(90);
        if (Math.abs(angDiff(pv.orient.b, pv.dB)) > .003) busy = true;
      }
      updateHud();
      return busy;
    }
    // The callout ("in 40 m: stairs up"), the line under the station name, the scrubber and the little plan
    function updateHud() {
      const routed = !pv.free && route && R;
      hudEl.hidden = !routed;
      miniEl.hidden = !routed;
      if (!routed) { subEl.textContent = `${levelName(Math.round(pv.level))} · tap the floor to walk there`; return; }
      const total = R.A[R.A.length - 1], pi = piAt(pv.along), cs = stepAtPi(pi), st = route.steps[cs], n = route.steps.length;
      const next = route.steps[cs + 1];
      const left = Math.max(0, R.A[st.to] - pv.along), togo = Math.max(0, total - pv.along);
      const key = cs + ':' + Math.round(left / 5) + ':' + Math.round(togo / 5);
      if (key !== hudKey) {
        hudKey = key;
        const arrived = st.kind === 'arrive' || togo < 2;
        const what = arrived ? st.text : next && next.kind !== 'arrive' ? next.text : `${endInfo(toEnd, 'to').name.replace(/^./, (c) => c.toUpperCase())} is ahead`;
        const turn = next && next.turn;
        const ic = arrived ? 'arrive' : !next || next.kind === 'arrive' ? 'arrive' : next.kind !== 'walk' ? next.kind : turn === 'left' || turn === 'bear-left' ? 'tleft' : turn === 'right' || turn === 'bear-right' ? 'tright' : 'up';
        hudEl.firstElementChild.innerHTML = svg(ic);
        hudEl.querySelector('b').textContent = arrived ? 'You have arrived' : left < 4 ? 'Now' : `In ${fmtM(left)}`;
        hudEl.querySelector(':scope > div > span').textContent = what;
        subEl.textContent = `${levelName(Math.round(pv.level))} · step ${cs + 1} of ${n} · ${togo < 4 ? 'there' : fmtM(togo) + ' to go'}`;
      }
      if (scrubEl && document.activeElement !== scrubEl) scrubEl.value = pv.along;
      if (scrubEl) scrubEl.style.setProperty('--s3-p', (pv.along / total * 100).toFixed(1) + '%');
      drawMini();
    }
    function drawMini() {
      const c = miniEl, g = c.getContext('2d'), w = c.width, r = w / 2, sc = w / 96; // 96 m across
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, w, w);
      g.save();
      g.beginPath(); g.arc(r, r, r - 2, 0, Math.PI * 2); g.clip();
      g.fillStyle = theme === 'dark' ? 'rgba(44,44,46,.92)' : 'rgba(255,255,255,.94)';
      g.fillRect(0, 0, w, w);
      const b = pv.device ? pv.dB : pv.bearing + pv.yaw;
      g.translate(r, r * 1.25);
      g.rotate(-b);
      g.scale(sc, -sc);
      g.translate(-pv.x, -pv.y);
      g.lineJoin = g.lineCap = 'round';
      const rp = route.points, lvl = Math.round(pv.level);
      const stroke = (same, width, color) => {
        g.beginPath();
        for (let i = 0; i < rp.length - 1; i++) {
          const on = Math.abs((rp[i][2] + rp[i + 1][2]) / 2 - lvl) < .75;
          if (on !== same) continue;
          g.moveTo(rp[i][0], rp[i][1]); g.lineTo(rp[i + 1][0], rp[i + 1][1]);
        }
        g.lineWidth = width; g.strokeStyle = color; g.stroke();
      };
      stroke(false, 2.2, theme === 'dark' ? 'rgba(255,255,255,.28)' : 'rgba(20,22,26,.22)');
      stroke(true, 5.2, theme === 'dark' ? '#0B0D10' : INK);
      stroke(true, 3.4, WALK);
      const e = rp[rp.length - 1];
      g.fillStyle = theme === 'dark' ? '#F2F3F5' : INK;
      g.beginPath(); g.arc(e[0], e[1], 3.2, 0, Math.PI * 2); g.fill();
      g.restore();
      // you: an arrow pointing the way you look
      g.save();
      g.translate(r, r * 1.25);
      g.scale(sc * 1.9, sc * 1.9);
      g.fillStyle = '#0a84ff'; g.strokeStyle = '#fff'; g.lineWidth = 1.1; g.lineJoin = 'round';
      g.beginPath(); g.moveTo(0, -4.6); g.lineTo(3.6, 3.6); g.lineTo(0, 1.9); g.lineTo(-3.6, 3.6); g.closePath(); g.fill(); g.stroke();
      g.restore();
    }
    function syncPov() {
      for (const b of levelsEl.querySelectorAll('.s3-povbtn')) b.setAttribute('aria-pressed', String(pov));
      const pb = levelsEl.querySelector('.s3-povbtn');
      if (pb) {
        pb.innerHTML = svg(pov ? 'layers' : 'eye');
        pb.title = pov ? 'Back to the model from above' : 'See it as you walk';
        pb.setAttribute('aria-label', pov ? 'Street-level view is on. Switch to the model from above' : 'Switch to street-level view');
      }
      const lb = levelsEl.querySelector('.s3-lookbtn');
      if (lb) lb.setAttribute('aria-pressed', String(pv.device));
      fitBtn.hidden = pov;
      if (!pov) { hudEl.hidden = true; miniEl.hidden = true; if (sheetEl && !sheetEl.hidden) buildSubtitle(); }
      if (scrubEl) scrubEl.hidden = !pov;
      root.style.setProperty('--s3-sheet-h', sheetEl.offsetHeight + 'px');
    }
    // "Look where I'm facing": the phone's compass and tilt turn the head
    function setDeviceLook(on) {
      pv.device = !!on;
      if (pv.device) {
        enableCompass();
        if (!pv.orient) { pv.dB = pv.bearing + pv.yaw; pv.dP = pv.pitch - .1; toast('Hold the phone upright and turn around: the view turns with you.', 3500); }
      } else { pv.yaw = angDiff(pv.dB, pv.bearing); pv.pitch = clamp(pv.dP + .1, -1.1, 1); }
      syncPov();
      request();
    }
    function recentre() {
      if (pv.device) setDeviceLook(false);
      pv.yaw = 0; pv.pitch = 0;
      request();
    }

    // ----- frame loop: runs only while something moves -----
    function request() {
      if (!self.alive || raf) return;
      clearTimeout(slowTimer); slowTimer = 0;
      raf = requestAnimationFrame(frame);
    }
    function frame(now) {
      raf = 0;
      if (!self.alive || !self.ready) return;
      const dt = now - lastT > 250 ? 16 : Math.max(1, now - lastT);
      lastT = now;
      let busy = false;
      busy = stepTween(now) || busy;
      busy = stepSpin(dt) || busy;
      busy = stepStretch(now) || busy;
      busy = stepOpacity(dt) || busy;
      busy = stepUser(dt) || busy;
      busy = stepPov(dt, now) || busy;
      if (grow && R) {
        const t = clamp((now - grow.t0) / grow.dur, 0, 1);
        R.U.uGrow.value = t >= 1 ? 1e9 : R.total * (1 - Math.pow(1 - t, 2.2));
        if (t >= 1) grow = null; else busy = true;
      }
      // the arrows on the route keep drifting for a while after the last touch, then rest
      const flowing = R && !reducedMotion() && !document.hidden && now - lastActivity < 14000;
      if (flowing) { phase = (phase + dt * .00042) % 1; R.U.uPhase.value = phase; }
      render();
      if (busy) request();
      else if (flowing) slowTimer = setTimeout(request, 34);
    }
    function render() {
      applyCam();
      if (R) {
        const px = 2 * Math.tan(camera.fov * Math.PI / 360) / H, e = povT;
        const half = lerp(4.6, 2.2, e);
        R.U.uPx.value = half * px;
        R.U.uRmin.value = lerp(.5, .17, e);
        R.U.uSquash.value = lerp(1, .14, e);
        R.U.uFogN.value = fog.near; R.U.uFogF.value = fog.far * .9;
        const r = Math.max(R.U.uRmin.value, half * px * cam.dist);
        R.U.uSpacing.value = e > .5 ? 2 : 2 * Math.pow(2, Math.round(Math.log2(Math.max(1, r * 9) / 2)));
      }
      if (shadowDirty) { renderer.shadowMap.needsUpdate = true; shadowDirty = false; }
      renderer.render(scene, camera);
      placeLabels();
    }
    let moved = false; // has the user turned or zoomed the model themselves?
    const touch = () => { lastActivity = performance.now(); };

    // ----- labels pinned to the model (HTML, so they stay sharp and are real buttons) -----
    let userLabel = null;
    function clearLabels() {
      labelsEl.textContent = '';
      labels = []; levelLabels = []; tip = null; userLabel = null;
    }
    function addLabel(el, o) {
      el.classList.add('s3-l', 's3-off');
      labelsEl.appendChild(el);
      const L = Object.assign({ el, ax: .5, ay: .5, prio: 0, li: -1, lift: 0, shown: false, w: 0, h: 0, solid: true }, o);
      labels.push(L);
      labelsDirty = true;
      return L;
    }
    function project(x, y, level, lift) {
      v3.set(x, P.zOf(level) * S + (lift || 0), -y).project(camera);
      if (v3.z < -1 || v3.z > 1) return null;
      return [(v3.x * .5 + .5) * W, (-v3.y * .5 + .5) * H];
    }
    const stopTitle = (s) => (s.ref ? `${nounOf(s.mode)} ${s.ref}` : s.name);

    function buildLabels() {
      clearLabels();
      // floors
      for (const lv of P.levels) {
        if (!lv.rim.length) continue;
        const b = mk('button', 's3-lv');
        b.type = 'button';
        b.append(mk('i', null, levelShort(lv.id)), mk('span', null, lv.name));
        b.setAttribute('aria-label', `${lv.name}: show only this floor`);
        b.onclick = () => setIsolate(isolate === lv.i ? null : lv.i);
        levelLabels.push(addLabel(b, { kind: 'level', li: lv.i, level: lv.id, rim: lv.rim, prio: 70, ax: 0, ay: 0 }));
      }
      // platforms and stop edges
      const destStop = route && toEnd && toEnd.stop ? (route.toStop || findStop(toEnd.stop)) : null;
      const seen = [];
      for (const s of model.stops || []) {
        if (!s.xy) continue;
        if (destStop && s.uic === destStop.uic && String(s.ref) === String(destStop.ref)) continue;
        if (seen.some((q) => q.uic === s.uic && q.ref === s.ref && Math.hypot(q.xy[0] - s.xy[0], q.xy[1] - s.xy[1]) < 30)) continue;
        seen.push(s);
        const b = mk('button', 's3-stop', s.ref || '');
        b.type = 'button';
        b.tabIndex = -1;
        b.setAttribute('aria-label', `${stopTitle(s)}${s.ref ? ', ' + s.name : ''}`);
        b.onclick = () => showPick({ stop: s, li: P.idxOf(s.level || 0), level: s.level || 0, xy: s.xy, area: areaAt(P, P.idxOf(s.level || 0), s.xy[0], s.xy[1]) });
        addLabel(b, { kind: 'stop', stop: s, x: s.xy[0], y: s.xy[1], level: s.level || 0, li: P.idxOf(s.level || 0), lift: .6, prio: s.mode === 'train' ? 52 : 50 });
      }
      for (const s of model.sectors || []) {
        if (!s.xy) continue;
        const st = (model.stops || []).find((q) => q.ref === s.ref);
        const lvl = st ? st.level || 0 : 0;
        addLabel(mk('div', 's3-sector', s.name), { kind: 'sector', x: s.xy[0], y: s.xy[1], level: lvl, li: P.idxOf(lvl), lift: .6, prio: destStop && destStop.ref === s.ref ? 60 : 30, minPpm: destStop && destStop.ref === s.ref ? 2.2 : 4 });
      }
      for (const e of model.entrances || []) {
        if (!e.xy || !e.name) continue;
        addLabel(mk('div', 's3-ent', e.name), { kind: 'ent', x: e.xy[0], y: e.xy[1], level: e.level || 0, li: P.idxOf(e.level || 0), lift: 1.5, prio: 25, minPpm: 1.5 });
      }
      for (const p of model.pois || []) {
        if (!p.xy || !ICON[p.kind]) continue;
        const d = mk('div', 's3-poi');
        d.innerHTML = svg(p.kind);
        d.title = p.name || p.kind;
        addLabel(d, { kind: 'poi', x: p.xy[0], y: p.xy[1], level: p.level || 0, li: P.idxOf(p.level || 0), lift: 1.5, prio: p.kind === 'tickets' ? 18 : 22, minPpm: p.kind === 'tickets' ? 5 : 3 });
      }
      // the route's own marks
      if (route && R) {
        const a = route.points[0], e = route.points[route.points.length - 1];
        addLabel(mk('div', 's3-start'), { kind: 'start', x: a[0], y: a[1], level: a[2], lift: .5, prio: 95, always: true, solid: false });
        const info = endInfo(toEnd, 'to');
        const sign = mk('div', 's3-sign');
        const plate = mk('div', 's3-plate' + (info.ref ? '' : ' s3-text'));
        if (info.ref) plate.append(mk('small', null, info.noun), mk('b', null, info.ref)); else plate.append(mk('b', null, info.name));
        sign.append(plate, mk('div', 's3-stem'), mk('div', 's3-foot'));
        sign.setAttribute('aria-hidden', 'true');
        addLabel(sign, { kind: 'sign', x: e[0], y: e[1], level: e[2], lift: .5, prio: 100, always: true, ax: .5, ay: 1, solid: false });
        route.steps.forEach((st, i) => {
          if (st.kind === 'walk' || st.kind === 'arrive') return;
          const p = pointAt((st.from + st.to) / 2);
          const b = mk('button', 's3-via');
          b.type = 'button';
          b.tabIndex = -1;
          b.innerHTML = svg(st.kind);
          b.setAttribute('aria-label', `Step ${i + 1}: ${st.text}`);
          b.onclick = () => { setFollow(false); select(i); };
          addLabel(b, { kind: 'via', step: i, x: p[0], y: p[1], level: p[2], lift: 3.2, prio: 80, always: true });
        });
      }
      tip = addLabel(mk('div', 's3-tip'), { kind: 'tip', prio: 98, always: true, on: false, ax: .5, ay: 1.25, solid: false });
      const u = mk('div', 's3-user');
      u.append(mk('i'));
      u.setAttribute('aria-hidden', 'true');
      userLabel = addLabel(u, { kind: 'user', prio: 99, always: true, solid: false });
    }

    const hits = [];
    function placeLabels() {
      if (labelsDirty) {
        for (const L of labels) if (!L.w) { L.w = L.el.offsetWidth; L.h = L.el.offsetHeight; }
        labels.sort((a, b) => b.prio - a.prio);
        labelsDirty = false;
      }
      const ppm = focal() / cam.dist; // pixels per metre at the point we look at
      const routed = !!(route && R);
      const fp = povT > .6;
      const far = !fp && ppm < (routed ? 3.3 : 1.9);
      const REACH = { stop: 90, via: 130, sign: 130, poi: 30, ent: 60, sector: 70, tip: 1e9 };
      labelsEl.classList.toggle('s3-far', far);
      // floor names: at the leftmost visible point of each floor's outline, kept apart from each other
      for (const L of levelLabels) {
        L.want = false;
        const act1 = L.el.classList.contains('s3-active');
        if (vis(L.li) < .5 || (routed && sel >= 0 && isolate == null && !act1)) continue;
        let best = null;
        for (const p of L.rim) {
          const s = project(p[0], p[1], L.level, 0);
          if (!s || s[0] < free.x0 - 6 || s[0] > free.x1 || s[1] < free.y0 || s[1] > free.y1) continue;
          if (!best || s[0] < best[0]) best = s;
        }
        if (!best && act1) best = [0, free.y0 + 20];
        if (!best) continue;
        L.want = true;
        L.px = routed ? Math.max(8, best[0] - L.w - 9) : 8; // without a route: a legend down the left edge
        L.py = best[1] - L.h / 2;
      }
      const act = levelLabels.filter((L) => L.want).sort((a, b) => b.li - a.li);
      for (let i = 1; i < act.length; i++) if (act[i].py < act[i - 1].py + act[i - 1].h + 4) act[i].py = act[i - 1].py + act[i - 1].h + 4;
      for (const L of act) if (L.py + L.h > free.y1) L.want = false;

      hits.length = 0;
      for (const L of labels) {
        let show = L.on !== false, x0 = 0, y0 = 0;
        if (show && fp && (L.kind === 'level' || L.kind === 'start')) show = false;
        if (show && L.kind === 'level') { show = L.want; x0 = L.px; y0 = L.py; }
        else if (show && L.kind === 'user') {
          show = !!user && user.sx != null;
          if (show) {
            const s = project(user.sx, user.sy, user.sl, .7);
            if (!s) show = false;
            else {
              x0 = s[0] - L.w / 2; y0 = s[1] - L.h / 2;
              const hd = user.heading != null ? user.heading : compassHeading;
              L.el.classList.toggle('s3-heading', hd != null);
              L.el.classList.toggle('s3-approx', user.mode === 'approx');
              if (hd != null) {
                const r = hd * Math.PI / 180;
                const s2 = project(user.sx + Math.sin(r) * 4, user.sy + Math.cos(r) * 4, user.sl, .7);
                if (s2) L.el.style.setProperty('--s3-heading', (Math.atan2(s2[0] - s[0], -(s2[1] - s[1])) * 180 / Math.PI).toFixed(1) + 'deg');
              }
            }
          }
        } else if (show) {
          if (!L.always && L.li >= 0 && vis(L.li) < .5) show = false;
          if (show && !fp && L.minPpm && ppm < L.minPpm * (routed && L.kind !== 'sector' ? 2.4 : 1)) show = false;
          if (show && fp && (Math.hypot(L.x - pv.x, L.y - pv.y) > (REACH[L.kind] || 60) || (L.kind !== 'via' && L.kind !== 'sign' && L.kind !== 'tip' && Math.abs(L.level - pv.level) > .7))) show = false;
          if (show) {
            const s = project(L.x, L.y, L.level, fp && (L.kind === 'stop' || L.kind === 'sector') ? 2.7 : L.lift);
            if (!s) show = false;
            else { x0 = s[0] - L.ax * L.w; y0 = s[1] - L.ay * L.h; }
          }
        }
        if (show && (x0 > W || y0 > H || x0 + L.w < 0 || y0 + L.h < 0)) show = false;
        if (show && L.solid && !(far && L.kind === 'stop')) {
          const x1 = x0 + L.w, y1 = y0 + L.h;
          for (const h of hits) if (x0 < h[2] && x1 > h[0] && y0 < h[3] && y1 > h[1]) { show = false; break; }
          if (show) hits.push([x0 - 2, y0 - 2, x1 + 2, y1 + 2]);
        }
        if (show) L.el.style.transform = `translate(${Math.round(x0)}px,${Math.round(y0)}px)`;
        if (show !== L.shown) { L.shown = show; L.el.classList.toggle('s3-off', !show); }
      }
    }

    // ----- touch, mouse, keyboard -----
    function panBy(dx, dy) {
      const wpp = cam.dist / focal(), ca = Math.cos(cam.az), sa = Math.sin(cam.az), k = 1 / Math.max(.35, Math.cos(cam.pol));
      cam.tx += (-ca * dx - sa * dy * k) * wpp;
      cam.tz += (sa * dx - ca * dy * k) * wpp;
    }
    function buildControls() {
      const ptrs = new Map();
      let g = null, lastTap = null;
      const two = () => { const [a, b] = [...ptrs.values()]; return { span: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }; };
      on(canvas, 'pointerdown', (e) => {
        try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
        ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        touch();
        moved = true;
        tween = null;
        spin.az = spin.pol = spin.x = spin.z = 0;
        const now = performance.now();
        if (ptrs.size === 1) g = { mode: e.button === 2 || e.button === 1 || e.shiftKey ? 'pan' : 'orbit', moved: 0, t0: now, lt: now, vx: 0, vy: 0, drift: 0 };
        else if (ptrs.size === 2) g = Object.assign({ mode: 'pinch', moved: 99, drift: 0 }, two());
        canvas.classList.add('s3-grabbing');
      });
      on(canvas, 'pointermove', (e) => {
        const p = ptrs.get(e.pointerId);
        if (!p || !g) return;
        const dx = e.clientX - p.x, dy = e.clientY - p.y, now = performance.now();
        p.x = e.clientX; p.y = e.clientY;
        touch();
        if (g.mode === 'pinch') {
          if (ptrs.size < 2) return;
          const t = two();
          if (pov) { g.span = t.span; g.cx = t.cx; g.cy = t.cy; return; }
          cam.dist *= g.span / t.span;
          panBy(t.cx - g.cx, t.cy - g.cy);
          g.drift += Math.abs(t.cx - g.cx) + Math.abs(t.cy - g.cy);
          if (g.drift > 24) setFollow(false);
          g.span = t.span; g.cx = t.cx; g.cy = t.cy;
        } else {
          g.moved += Math.abs(dx) + Math.abs(dy);
          if (g.moved <= 6) return;
          const dtm = Math.max(1, now - g.lt);
          g.vx = lerp(g.vx, dx / dtm, .6); g.vy = lerp(g.vy, dy / dtm, .6); g.lt = now;
          if (pov) {
            if (pv.device) setDeviceLook(false);
            pv.yaw -= dx * .0042; pv.pitch = clamp(pv.pitch + dy * .0036, -1.1, 1);
          } else if (g.mode === 'orbit') { cam.az -= dx * .008; cam.pol -= dy * .006; }
          else { panBy(dx, dy); setFollow(false); }
        }
        limit(cam);
        request();
      });
      const up = (e) => {
        if (!ptrs.has(e.pointerId)) return;
        ptrs.delete(e.pointerId);
        const now = performance.now();
        if (ptrs.size === 1) { g = { mode: 'orbit', moved: 99, t0: now, lt: now, vx: 0, vy: 0, drift: 0 }; return; }
        if (ptrs.size) return;
        canvas.classList.remove('s3-grabbing');
        if (!g) return;
        if (g.mode !== 'pinch' && g.moved <= 6 && now - g.t0 < 500 && e.type === 'pointerup') {
          const dbl = lastTap && now - lastTap.t < 330 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30;
          lastTap = dbl ? null : { t: now, x: e.clientX, y: e.clientY };
          onTap(e.clientX, e.clientY, dbl);
        } else if (!pov && g.mode !== 'pinch' && now - g.lt < 70 && !reducedMotion()) {
          if (g.mode === 'orbit') { spin.az = -g.vx * .008; spin.pol = -g.vy * .006; }
          else {
            const wpp = cam.dist / focal(), ca = Math.cos(cam.az), sa = Math.sin(cam.az), k = 1 / Math.max(.35, Math.cos(cam.pol));
            spin.x = (-ca * g.vx - sa * g.vy * k) * wpp; spin.z = (sa * g.vx - ca * g.vy * k) * wpp;
          }
          request();
        }
        g = null;
      };
      on(canvas, 'pointerup', up);
      on(canvas, 'pointercancel', up);
      on(canvas, 'wheel', (e) => {
        e.preventDefault();
        touch();
        moved = true;
        tween = null;
        const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        if (pov) { povMove(-clamp(d, -240, 240) * .03); return; }
        cam.dist *= Math.exp(clamp(d, -240, 240) * (e.ctrlKey ? .01 : .0016));
        limit(cam);
        request();
      }, { passive: false });
      on(canvas, 'contextmenu', (e) => e.preventDefault());
    }
    // forwards / backwards on foot: along the route, or straight ahead when there is none
    function povMove(m) {
      if (!pv.free && route && R) { setFollow(false); pv.walk = null; pv.along = clamp(pv.along + m, 0, R.A[R.A.length - 1]); }
      else {
        const b = pv.bearing + pv.yaw, x = pv.tx + Math.sin(b) * m, y = pv.ty + Math.cos(b) * m;
        if (areaAt(P, P.idxOf(Math.round(pv.tl)), x, y)) { pv.tx = x; pv.ty = y; }
      }
      touch();
      request();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); if (listMode) toggleList(); else api.close(); return; }
      if (e.key === 'Tab') { // keep the focus inside the dialog
        const f = [...root.querySelectorAll('button:not([disabled]):not([tabindex="-1"]), canvas')].filter((el) => el.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        return;
      }
      if (e.target !== canvas || !self.ready) return;
      const k = e.key;
      let used = true;
      tween = null;
      if (pov) {
        if (k === 'ArrowLeft') pv.yaw -= .14;
        else if (k === 'ArrowRight') pv.yaw += .14;
        else if (k === 'ArrowUp') povMove(5);
        else if (k === 'ArrowDown') povMove(-5);
        else if (k === '0') recentre();
        else used = false;
        if (used) { e.preventDefault(); touch(); request(); }
        return;
      }
      if (k === 'ArrowLeft') cam.az += .2;
      else if (k === 'ArrowRight') cam.az -= .2;
      else if (k === 'ArrowUp') cam.pol -= .1;
      else if (k === 'ArrowDown') cam.pol += .1;
      else if (k === '+' || k === '=') cam.dist *= .8;
      else if (k === '-' || k === '_') cam.dist *= 1.25;
      else if (k === '0') flyTo(currentPose(), 700);
      else used = false;
      if (used) { e.preventDefault(); limit(cam); touch(); request(); }
    }

    // ----- tapping the model -----
    function pick(cx, cy) {
      const r = canvas.getBoundingClientRect();
      ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const o = raycaster.ray.origin, d = raycaster.ray.direction;
      let ground = null;
      for (let li = P.levels.length - 1; li >= 0; li--) {
        if (vis(li) < .4 && !(lv3[li].rest && lv3[li].rest.op >= .4)) continue;
        const t = (P.levels[li].z * S - o.y) / d.y;
        if (!(t > 0)) continue;
        const x = o.x + d.x * t, y = -(o.z + d.z * t);
        const a = areaAt(P, li, x, y);
        if (a) return { li, level: P.levels[li].id, xy: [x, y], area: a };
        if (!ground && (isolate === li || (isolate == null && P.levels[li].id === 0))) ground = { li, level: P.levels[li].id, xy: [x, y], area: null };
      }
      return ground;
    }
    function describe(hit) {
      const lv = P.levels[hit.li];
      const where = `${lv.name} · level ${levelShort(lv.id)}`;
      if (hit.stop) return { title: stopTitle(hit.stop), sub: hit.stop.ref ? `${hit.stop.name} · ${lv.name}` : where, icon: 'arrive' };
      const a = hit.area;
      if (!a) return { title: lv.name, sub: `Level ${levelShort(lv.id)}`, icon: 'layers' };
      const refs = (a.src.refs || []).filter(Boolean);
      if (a.kind === 'platform' && refs.length) {
        const st = (model.stops || []).find((s) => refs.includes(s.ref) && P.idxOf(s.level || 0) === hit.li);
        const noun = nounOf(st ? st.mode : 'train');
        const title = refs.length === 1 ? `${noun} ${refs[0]}` : `${noun}s ${refs.slice(0, -1).join(', ')} and ${refs[refs.length - 1]}`;
        return { title, sub: a.src.name ? `${a.src.name} · ${lv.name}` : where, icon: 'arrive' };
      }
      const title = a.src.name || (a.kind === 'room' ? 'Shop or office' : a.kind === 'plaza' ? 'Open ground' : a.kind === 'platform' ? 'Platform' : lv.name);
      return { title, sub: where, icon: a.kind === 'room' ? 'lockers' : 'layers' };
    }
    let pickHl = null;
    function showPick(hit) {
      picked = hit;
      const d = describe(hit);
      tip.el.textContent = d.title;
      tip.w = 0; labelsDirty = true;
      tip.x = hit.xy[0]; tip.y = hit.xy[1]; tip.level = hit.level; tip.lift = hit.area && hit.area.top > 1 ? hit.area.top : 1;
      tip.on = true;
      clearTimeout(tipTimer);
      labels.forEach((L) => { if (L.kind === 'stop') L.el.classList.toggle('s3-picked', !!hit.stop && L.stop === hit.stop); });
      if (!route) {
        dropHighlight(pickHl);
        pickHl = hit.area && hit.area.kind !== 'plaza' ? highlight(hit.area, WALK, .55) : null;
        fillExplore(d);
      } else tipTimer = setTimeout(() => { tip.on = false; request(); }, 2600);
      say(`${d.title}. ${d.sub}`);
      emit('pick', { title: d.title, level: hit.level, xy: hit.xy.slice(), ll: toLngLat(model, hit.xy), stop: hit.stop || null, area: hit.area ? hit.area.src : null, endpoint: endOf(hit) });
      touch();
      request();
    }
    const endOf = (hit) => (hit.stop ? { stop: { uic: hit.stop.uic, ref: hit.stop.ref } } : { xy: hit.xy.slice(), level: hit.level });
    function onTap(x, y, dbl) {
      const hit = pick(x, y);
      if (pov) {
        if (pv.free && hit && hit.area && hit.area.kind !== 'room') { pv.tx = hit.xy[0]; pv.ty = hit.xy[1]; pv.tl = hit.level; touch(); request(); }
        else if (hit && hit.area) showPick(hit);
        return;
      }
      if (dbl) {
        const pose = Object.assign({}, cam, { dist: cam.dist * .5 });
        if (hit) { pose.tx = hit.xy[0]; pose.tz = -hit.xy[1]; pose.ty = P.zOf(hit.level) * Sto; }
        flyTo(pose, 450);
        return;
      }
      if (hit && (hit.area || opts.pickAnywhere)) showPick(hit);
      else if (hit) emit('pick', { title: '', level: hit.level, xy: hit.xy.slice(), ll: toLngLat(model, hit.xy), stop: null, area: null, endpoint: endOf(hit) });
      else if (tip && tip.on) { tip.on = false; request(); }
    }

    // ----- floors panel -----
    function buildLevels() {
      levelsEl.textContent = '';
      const list = P.levels.filter((lv) => lv.areas.length || (R && R.levels.has(lv.i)));
      levelsEl.hidden = false;
      const ctl = (cls, icon, label, fn) => {
        const b = mk('button', cls);
        b.type = 'button';
        b.innerHTML = svg(icon);
        b.title = label;
        b.setAttribute('aria-label', label);
        b.onclick = fn;
        levelsEl.append(b);
        return b;
      };
      ctl('s3-povbtn', 'eye', 'Switch to street-level view', () => setPov(!pov)).setAttribute('aria-pressed', 'false');
      ctl('s3-lookbtn s3-povonly', 'phone', 'Look where I’m facing: turn the phone to look around', () => setDeviceLook(!pv.device)).setAttribute('aria-pressed', 'false');
      ctl('s3-povonly', 'centre', 'Look the way the route goes', recentre);
      levelsEl.append(mk('hr', 's3-modelonly'));
      for (const lv of list.slice().reverse()) {
        const b = mk('button', 's3-modelonly' + (R && R.levels.has(lv.i) ? ' s3-on-route' : ''), levelShort(lv.id));
        b.type = 'button';
        b.dataset.li = lv.i;
        b.title = lv.name;
        b.setAttribute('aria-label', `${lv.name}, level ${lv.id}${R && R.levels.has(lv.i) ? ', on your route' : ''}`);
        b.setAttribute('aria-pressed', 'false');
        b.onclick = () => setIsolate(isolate === lv.i ? null : lv.i);
        levelsEl.append(b);
      }
      levelsEl.append(mk('hr', 's3-modelonly'));
      const all = mk('button', 's3-all s3-modelonly');
      all.type = 'button';
      all.innerHTML = svg('layers');
      all.dataset.li = 'all';
      all.title = 'All floors';
      all.setAttribute('aria-label', 'All floors');
      all.onclick = () => setIsolate(null);
      const ex = mk('button', 's3-spread s3-modelonly');
      ex.type = 'button';
      ex.innerHTML = svg('spread');
      ex.title = 'Spread the floors apart';
      ex.setAttribute('aria-label', 'Spread the floors apart');
      ex.setAttribute('aria-pressed', String(exploded));
      ex.onclick = () => {
        exploded = !exploded;
        ex.setAttribute('aria-pressed', String(exploded));
        stretchTo(P.vex * (exploded ? EXPLODE : 1), 700);
        flyTo(currentPose(), 800);
        touch();
      };
      levelsEl.append(all, ex);
      syncLevels();
      syncPov();
    }
    function syncLevels() {
      for (const b of levelsEl.querySelectorAll('button[data-li]')) {
        b.setAttribute('aria-pressed', String(b.dataset.li === 'all' ? isolate == null : +b.dataset.li === isolate));
      }
    }
    function setIsolate(li) {
      isolate = li;
      syncLevels();
      setTargets();
      setFollow(false);
      flyTo(currentPose(), 850);
      const name = li == null ? 'All floors' : P.levels[li].name;
      if (li != null) toast(name, 1500);
      say(li == null ? 'Showing all floors' : `Showing only ${name}`);
      touch();
    }

    // ----- the sheet: steps of the route, or what was tapped -----
    function findStop(q) {
      const all = model.stops || [];
      return all.find((s) => s.uic === q.uic && String(s.ref || '') === String(q.ref || '')) || all.find((s) => String(s.ref || '') === String(q.ref || '') && q.ref) || all.find((s) => s.uic === q.uic) || null;
    }
    function endInfo(end, which) {
      if (end && end.label) return { name: end.label };
      if (end && end.stop) {
        const s = (route && (which === 'to' ? route.toStop : route.fromStop)) || findStop(end.stop);
        if (s) return { stop: s, noun: s.ref ? nounOf(s.mode) : '', ref: s.ref || '', name: stopTitle(s) };
      }
      if (end && end.entrance) return { name: end.entrance };
      return { name: which === 'from' ? 'your position' : 'your destination' };
    }
    const levelName = (level) => P.levels[P.idxOf(level)].name;
    function buildSheet() {
      sheetEl.textContent = '';
      sheetEl.hidden = false;
      sheetEl.classList.remove('s3-list');
      listMode = false;
      stepsEl = navEl = scrubEl = null;
      if (route && R) buildSteps(); else buildExplore();
      buildSubtitle();
      root.style.setProperty('--s3-sheet-h', sheetEl.offsetHeight + 'px');
    }
    function buildSubtitle() {
      const from = endInfo(fromEnd, 'from'), to = endInfo(toEnd, 'to');
      subEl.textContent = route && R ? `${from.name.charAt(0).toUpperCase() + from.name.slice(1)} to ${to.name} · ${fmtMin(route.seconds)}` : 'Station plan in 3D';
    }
    function card(iconName, iconCls, title, count) {
      const c = mk('div', 's3-card');
      const ico = mk('span', 's3-ico ' + (iconCls || ''));
      ico.innerHTML = svg(iconName);
      const txt = mk('div', 's3-txt');
      const t = mk('div', 's3-step-title', title);
      const meta = mk('div', 's3-meta');
      txt.append(t, meta);
      c.append(ico, txt);
      if (count) c.append(mk('span', 's3-count', count));
      return { el: c, ico, title: t, meta };
    }
    function tag(cls, iconName, text) {
      const t = mk('span', 's3-tag ' + (cls || ''));
      if (iconName) t.innerHTML = svg(iconName);
      t.append(mk('span', null, text));
      return t;
    }
    function buildSteps() {
      const n = route.steps.length;
      const grab = mk('button', 's3-grab');
      grab.type = 'button';
      grab.setAttribute('aria-label', 'Show all steps as a list');
      grab.setAttribute('aria-expanded', 'false');
      grab.onclick = toggleList;
      stepsEl = mk('ol', 's3-steps');
      stepsEl.setAttribute('aria-label', 'Walking directions');
      // overview
      {
        const li = mk('li', 's3-step');
        li.dataset.i = -1;
        const to = endInfo(toEnd, 'to');
        const c = card('walk', 's3-k-route', `To ${to.name}`);
        c.meta.append(mk('span', null, `${fmtMin(route.seconds)} · ${fmtM(route.length)}`));
        const seq = [];
        for (const st of route.steps) {
          for (const l of [st.level, st.toLevel]) {
            if (l == null) continue;
            const i = P.idxOf(Math.round(l));
            if (seq[seq.length - 1] !== i) seq.push(i);
          }
        }
        if (seq.length > 1) {
          const flow = mk('span', 's3-flow');
          flow.setAttribute('aria-label', 'Floors: ' + seq.map((i) => P.levels[i].name).join(', then '));
          seq.forEach((i, k) => {
            if (k) flow.insertAdjacentHTML('beforeend', svg(i > seq[k - 1] ? 'up' : 'down'));
            const t = tag('', null, levelShort(P.levels[i].id));
            t.title = P.levels[i].name;
            flow.append(t);
          });
          c.meta.append(flow);
        }
        if (route.notice) { const w = mk('div', 's3-meta', route.notice); w.style.color = '#ff9500'; c.meta.after(w); }
        if (routeFromExplore) {
          const b = mk('button', 's3-tag s3-here', 'End route');
          b.type = 'button';
          b.onclick = () => { route = null; fromEnd = toEnd = null; routeFromExplore = false; exploreEnds = { from: null, to: null }; rebuild(); };
          c.meta.append(b);
        }
        li.append(c.el);
        stepsEl.append(li);
      }
      route.steps.forEach((st, i) => {
        const li = mk('li', 's3-step');
        li.dataset.i = i;
        const climb = st.kind !== 'walk' && st.kind !== 'arrive';
        const c = card(st.kind, st.kind === 'arrive' ? 's3-k-arrive' : climb ? 's3-k-level' : '', st.text, `${i + 1} of ${n}`);
        if (climb && st.toLevel != null && st.toLevel !== st.level) c.meta.append(tag('s3-tag-level', st.dir === 'up' || st.toLevel > st.level ? 'up' : 'down', levelName(st.toLevel)));
        else c.meta.append(tag('', null, levelName(st.level)));
        if (st.seconds >= 8) c.meta.append(mk('span', null, fmtSec(st.seconds)));
        if (st.sector) c.meta.append(tag('', null, `Sector ${st.sector}`));
        if (st.warn) { const w = tag('', null, 'Not as you asked'); w.style.cssText = 'background:rgba(255,149,0,.16);color:#ff9500'; c.meta.append(w); }
        const here = mk('button', 's3-tag s3-here');
        here.type = 'button';
        here.innerHTML = svg('here') + '<span>I’m here</span>';
        here.setAttribute('aria-pressed', 'false');
        here.setAttribute('aria-label', `I’m here: step ${i + 1}`);
        c.meta.append(here);
        li.append(c.el);
        stepsEl.append(li);
      });
      on(stepsEl, 'click', (e) => {
        const li = e.target.closest('.s3-step');
        if (!li) return;
        const i = +li.dataset.i;
        if (e.target.closest('.s3-here') && i >= 0) { setManual(i); return; }
        if (e.target.closest('button')) return;
        setFollow(false);
        select(i);
      });
      on(stepsEl, 'scroll', () => {
        if (listMode || progScroll) return;
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
          if (listMode || progScroll || !stepsEl) return;
          const w = stepsEl.firstElementChild.offsetWidth || 1;
          const i = Math.round(stepsEl.scrollLeft / w) - 1;
          if (i !== sel) { setFollow(false); select(i, { fromScroll: true }); }
        }, 90);
      }, { passive: true });
      navEl = mk('div', 's3-nav');
      const prev = mk('button', 's3-prev');
      prev.type = 'button';
      prev.innerHTML = svg('prev');
      prev.setAttribute('aria-label', 'Previous step');
      prev.onclick = () => { setFollow(false); select(sel - 1); };
      const dots = mk('div', 's3-dots');
      dots.setAttribute('aria-hidden', 'true');
      for (let i = 0; i <= n; i++) dots.append(mk('i'));
      const next = mk('button', 's3-next');
      next.type = 'button';
      next.innerHTML = '<span></span>' + svg('next');
      next.onclick = () => { setFollow(false); select(sel + 1); };
      navEl.append(prev, dots, next);
      scrubEl = mk('input', 's3-scrub');
      scrubEl.type = 'range';
      scrubEl.min = 0; scrubEl.max = Math.round(R.A[R.A.length - 1] * 10) / 10; scrubEl.step = .5; scrubEl.value = 0;
      scrubEl.setAttribute('aria-label', 'Walk along the route');
      scrubEl.hidden = !pov;
      scrubEl.oninput = () => { setFollow(false); pv.walk = null; pv.along = +scrubEl.value; touch(); request(); };
      sheetEl.append(grab, scrubEl, stepsEl, navEl);
      syncSteps({});
    }
    function syncSteps(o) {
      if (!stepsEl) return;
      const n = route.steps.length, items = [...stepsEl.children];
      items.forEach((li, k) => {
        const i = k - 1;
        if (i === sel) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
        li.classList.toggle('s3-done', i >= 0 && userStep > i);
        const here = li.querySelector('.s3-here[aria-pressed]');
        if (here) {
          const on = userStep === i;
          here.setAttribute('aria-pressed', String(on));
          here.lastElementChild.textContent = on ? 'You’re here' : 'I’m here';
        }
      });
      [...navEl.querySelector('.s3-dots').children].forEach((d, k) => { d.classList.toggle('s3-on', k === sel + 1); d.classList.toggle('s3-you', userStep >= 0 && k === userStep + 1 && k !== sel + 1); });
      const prev = navEl.querySelector('.s3-prev'), next = navEl.querySelector('.s3-next');
      prev.disabled = sel < 0;
      next.disabled = sel >= n - 1;
      next.firstElementChild.textContent = sel < 0 ? 'Start' : 'Next';
      next.setAttribute('aria-label', sel < 0 ? 'Start: first step' : 'Next step');
      if (o.fromScroll) return;
      const cur = items[sel + 1];
      if (listMode) { if (cur) cur.scrollIntoView({ block: 'nearest' }); return; }
      const left = (items[0].offsetWidth || 0) * (sel + 1);
      if (Math.abs(stepsEl.scrollLeft - left) > 2) {
        progScroll++;
        const mine = progScroll;
        stepsEl.scrollTo({ left, behavior: o.instant || reducedMotion() ? 'auto' : 'smooth' });
        setTimeout(() => { if (progScroll === mine) progScroll = 0; }, o.instant ? 60 : 650);
      }
    }
    function toggleList() {
      if (!stepsEl) return;
      listMode = !listMode;
      sheetEl.classList.toggle('s3-list', listMode);
      const grab = sheetEl.querySelector('.s3-grab');
      grab.setAttribute('aria-expanded', String(listMode));
      grab.setAttribute('aria-label', listMode ? 'Show one step at a time' : 'Show all steps as a list');
      syncSteps({ instant: true });
      root.style.setProperty('--s3-sheet-h', sheetEl.offsetHeight + 'px');
    }
    function select(i, o) {
      if (!route || !R) return;
      o = o || {};
      const n = route.steps.length;
      i = clamp(i, -1, n - 1);
      const changed = i !== sel;
      sel = i;
      if (isolate != null) { isolate = null; syncLevels(); }
      syncSteps(o);
      setTargets();
      labels.forEach((L) => { if (L.kind === 'via') L.el.classList.toggle('s3-active', L.step === sel); });
      if (pov) { if (!o.fromPov) { setFollowQuiet(); walkTo(R.A[route.steps[Math.max(0, i)].from]); } }
      else if (!o.keepCam) {
        const pose = i < 0 ? overviewPose() : stepPose(i);
        if (o.follow && user && user.sx != null) {
          pose.tx = user.sx; pose.ty = P.zOf(user.sl) * Sto; pose.tz = -user.sy;
          pose.dist = Math.min(pose.dist, 130);
        }
        flyTo(pose, 950);
      }
      if (changed) {
        say(i < 0 ? 'Overview of the route' : `Step ${i + 1} of ${n}: ${route.steps[i].text}`);
        emit('step', { index: i, step: i < 0 ? null : route.steps[i] });
      }
      touch();
    }

    const setFollowQuiet = () => { if (follow) setFollow(false); };
    let exploreCard = null, exploreActions = null;
    function buildExplore() {
      const box = mk('div', 's3-explore');
      box.style.paddingTop = '12px';
      exploreCard = card('info', 's3-k-info', 'Explore the station');
      exploreCard.meta.textContent = 'Tap a platform, a stop or a room to see what it is.';
      exploreActions = mk('div', 's3-actions');
      exploreActions.hidden = true;
      const from = mk('button', null, 'Start here'), to = mk('button', 's3-primary', 'Go here');
      from.type = to.type = 'button';
      from.onclick = () => { if (!picked) return; exploreEnds.from = { end: endOf(picked), name: describe(picked).title }; from.setAttribute('aria-pressed', 'true'); tryExploreRoute(); };
      to.onclick = () => { if (!picked) return; exploreEnds.to = { end: endOf(picked), name: describe(picked).title }; tryExploreRoute(); };
      exploreActions.append(from, to);
      box.append(exploreCard.el, exploreActions);
      sheetEl.append(box);
    }
    function fillExplore(d) {
      if (!exploreCard) return;
      exploreCard.title.textContent = d.title;
      exploreCard.meta.textContent = d.sub;
      exploreCard.ico.innerHTML = svg(d.icon || 'info');
      exploreCard.ico.className = 's3-ico ' + (d.icon === 'arrive' ? 's3-k-route' : 's3-k-info');
      exploreActions.hidden = !(router && router.route);
      exploreActions.firstElementChild.setAttribute('aria-pressed', 'false');
      root.style.setProperty('--s3-sheet-h', sheetEl.offsetHeight + 'px');
    }
    function tryExploreRoute() {
      let { from, to } = exploreEnds;
      if (to && !from && user && user.sx != null) from = exploreEnds.from = { end: { xy: [user.sx, user.sy], level: Math.round(user.sl) }, name: 'your position' };
      if (from && !to) { toast('Start set. Now tap where you want to go, then “Go here”.'); return; }
      if (to && !from) { toast('Destination set. Now tap where you start, then “Start here”.'); return; }
      const r = computeRoute(from.end, to.end);
      if (!r) { toast('No walking route found between these two places.'); return; }
      route = r;
      fromEnd = Object.assign({ label: from.end.stop ? undefined : from.name }, from.end);
      toEnd = Object.assign({ label: to.end.stop ? undefined : to.name }, to.end);
      routeFromExplore = true;
      rebuild();
    }
    function computeRoute(from, to) {
      if (!router || !router.route) return null;
      try { return router.route(model, from, to, opts.prefs || {}) || null; } catch (e) { console.error('Station3D: route failed', e); return null; }
    }

    // ----- you are here -----
    function piAt(along) {
      const A = R.A;
      if (!(along > 0)) return 0;
      if (along >= A[A.length - 1]) return A.length - 1;
      let lo = 0, hi = A.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (A[mid] <= along) lo = mid; else hi = mid; }
      const seg = A[hi] - A[lo];
      return lo + (seg > 0 ? (along - A[lo]) / seg : 0);
    }
    function guessLevel(x, y) {
      const order = P.levels.map((l) => l.i).sort((a, b) => Math.abs(P.levels[a].id) - Math.abs(P.levels[b].id) || P.levels[b].id - P.levels[a].id);
      for (const li of order) if (areaAt(P, li, x, y)) return P.levels[li].id;
      return P.levels[P.idxOf(0)].id;
    }
    function setUser(u) {
      if (!self.ready) return;
      if (!u || (!u.ll && !u.xy)) {
        user = null; manualAt = null;
        if (disc) disc.visible = false;
        if (R) R.U.uProg.value = -1;
        followBtn.hidden = true;
        if (userStep !== -1) { userStep = -1; if (stepsEl) syncSteps({ fromScroll: true }); }
        setFollow(false);
        request();
        return;
      }
      const xy = u.xy || toLocal(model, u.ll);
      const acc = isFinite(u.accuracy) && u.accuracy > 0 ? u.accuracy : 15;
      const nu = user || { sx: null, sy: null, sl: null, salong: null, snap: null };
      nu.acc = acc;
      nu.heading = isFinite(u.heading) && u.heading != null ? ((u.heading % 360) + 360) % 360 : null;
      let mode = 'approx', x = xy[0], y = xy[1], level = u.level != null && isFinite(u.level) ? u.level : null, along = null, pi = null, step = userStep;
      if (route && R && router && router.snap) {
        const hint = nu.snap || (manualAt ? { along: manualAt.along, level: manualAt.point[2] } : level != null ? level : undefined);
        let sn = null;
        try { sn = router.snap(model, route, xy, hint); } catch (e) { sn = null; }
        // on the route while the fix could plausibly be there; GPS knows no floor, the route does
        if (sn && sn.dist <= clamp(acc * 1.5, 18, 70)) {
          mode = 'route'; along = sn.along; pi = sn.index + sn.t; [x, y, level] = sn.point; step = sn.step;
          nu.snap = sn; manualAt = null;
        } else if (manualAt) {
          mode = 'manual'; along = manualAt.along; pi = manualAt.pi; [x, y, level] = manualAt.point; step = manualAt.step;
        } else {
          nu.snap = null;
          if (sn && level == null) level = Math.round(sn.point[2]);
        }
      }
      if (level == null) level = guessLevel(x, y);
      nu.mode = mode; nu.x = x; nu.y = y; nu.level = level; nu.along = along; nu.pi = pi;
      const first = !user;
      user = nu;
      followBtn.hidden = false;
      if (nu.heading == null && !compassOn && !(window.DeviceOrientationEvent && typeof window.DeviceOrientationEvent.requestPermission === 'function')) enableCompass();
      if (step !== userStep) {
        userStep = step;
        if (stepsEl) syncSteps({ fromScroll: true });
        if (follow && route && userStep >= 0) select(userStep, { follow: true });
      }
      if (first) root.style.setProperty('--s3-sheet-h', sheetEl.offsetHeight + 'px');
      if (first && wantFollow) setFollow(true);
      touch();
      request();
    }
    // "I'm here": the user says which step they are at; a position fix near the route takes over again
    function setManual(i) {
      const st = route.steps[i];
      manualAt = { step: i, pi: st.from, along: R.A[st.from], point: route.points[st.from].slice() };
      const nu = user || { sx: null, sy: null, sl: null, salong: null, acc: 0, heading: null };
      nu.snap = null;
      nu.mode = 'manual'; nu.along = manualAt.along; nu.pi = manualAt.pi;
      [nu.x, nu.y, nu.level] = manualAt.point;
      user = nu;
      followBtn.hidden = false;
      userStep = i;
      syncSteps({ fromScroll: true });
      if (sel !== i) select(i); else request();
      say(`You are at step ${i + 1}`);
      touch();
    }
    function stepUser(dt) {
      if (!user || !disc) return false;
      let busy = false, tx, ty, tl;
      const k = (tau) => (reducedMotion() ? 1 : 1 - Math.exp(-dt / tau));
      if (user.along != null && R) {
        if (user.salong == null) user.salong = user.along;
        const d = user.along - user.salong;
        if (Math.abs(d) > .08) { user.salong += d * k(320); busy = !reducedMotion(); } else user.salong = user.along;
        const pi = Math.abs(user.along - user.salong) <= .08 ? user.pi : piAt(user.salong);
        [tx, ty, tl] = pointAt(pi);
        R.U.uProg.value = distAt(pi);
      } else { tx = user.x; ty = user.y; tl = user.level; user.salong = null; }
      if (user.sx == null) { user.sx = tx; user.sy = ty; user.sl = tl; }
      else {
        const kk = k(150);
        user.sx += (tx - user.sx) * kk; user.sy += (ty - user.sy) * kk; user.sl += (tl - user.sl) * kk;
        if (Math.hypot(tx - user.sx, ty - user.sy) > .04 || Math.abs(tl - user.sl) > .004) busy = true;
        else { user.sx = tx; user.sy = ty; user.sl = tl; }
      }
      const uy = P.zOf(user.sl) * S;
      disc.visible = user.mode !== 'manual' && user.acc > 0;
      disc.position.set(user.sx, uy + .3, -user.sy);
      disc.scale.setScalar(Math.max(2.5, user.acc));
      disc.material.opacity = user.mode === 'approx' ? .1 : .16;
      if (follow) {
        if (tween) { tween.to.tx = user.sx; tween.to.ty = uy; tween.to.tz = -user.sy; }
        else {
          const kk = k(240);
          const dx = user.sx - cam.tx, dy = uy - cam.ty, dz = -user.sy - cam.tz;
          if (Math.hypot(dx, dy, dz) > .05) { cam.tx += dx * kk; cam.ty += dy * kk; cam.tz += dz * kk; busy = true; }
        }
      }
      return busy;
    }
    let wantFollow = false; // asked for before the first position arrived
    function setFollow(b) {
      if (b && !user) { wantFollow = true; return; }
      wantFollow = false;
      b = !!b && !!user;
      if (b === follow) return;
      follow = b;
      followBtn.setAttribute('aria-pressed', String(follow));
      followBtn.setAttribute('aria-label', follow ? 'Stop following my position' : 'Follow my position');
      if (follow) {
        if (route && R && userStep >= 0) select(userStep, { follow: true });
        else if (user.sx != null) flyTo(Object.assign({}, cam, { tx: user.sx, ty: P.zOf(user.sl) * Sto, tz: -user.sy, dist: Math.min(cam.dist, 140) }), 800);
      }
      emit('follow', follow);
      request();
    }
    let lastOrient = 0;
    function enableCompass() {
      const D = window.DeviceOrientationEvent;
      if (compassOn || !D) return;
      const attach = () => {
        if (!self.alive || compassOn) return;
        compassOn = true;
        on(window, 'deviceorientationabsolute', onOrient, true);
        on(window, 'deviceorientation', onOrient, true);
      };
      if (typeof D.requestPermission === 'function') D.requestPermission().then((s) => { if (s === 'granted') attach(); }).catch(() => {});
      else attach();
    }
    function onOrient(e) {
      // which way the back of the phone points: bearing and tilt, for "look where I'm facing"
      if (e.beta != null && (e.absolute || typeof e.webkitCompassHeading === 'number')) {
        const rad = Math.PI / 180;
        const alpha = typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading) ? 360 - e.webkitCompassHeading : e.alpha || 0;
        const so = ((screen.orientation && screen.orientation.angle) || 0) * rad;
        const eu = new THREE.Euler(e.beta * rad, alpha * rad, -(e.gamma || 0) * rad, 'YXZ');
        const qd = new THREE.Quaternion().setFromEuler(eu);
        qd.multiply(new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2));
        qd.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -so));
        const f = new THREE.Vector3(0, 0, -1).applyQuaternion(qd);
        const had = !!pv.orient;
        pv.orient = { b: Math.atan2(f.x, -f.z), p: Math.asin(clamp(f.y, -1, 1)) };
        if (!had) { pv.dB = pv.orient.b; pv.dP = pv.orient.p; }
        if (pov && pv.device) request();
      }
      let h = null;
      if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) h = e.webkitCompassHeading;
      else if (e.absolute && e.alpha != null) h = 360 - e.alpha;
      if (h == null) return;
      const so = (screen.orientation && screen.orientation.angle) || 0;
      h = (h + so + 360) % 360;
      const now = performance.now();
      if (now - lastOrient < 90) return;
      if (compassHeading != null && Math.abs(angDiff(h * Math.PI / 180, compassHeading * Math.PI / 180)) < .03) return;
      lastOrient = now;
      compassHeading = h;
      if (user && user.heading == null) request();
    }

    // ----- layout -----
    function layout() {
      const r = root.getBoundingClientRect();
      W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(W, H, false);
      const top = topEl.getBoundingClientRect().bottom - r.top + 8;
      const sr = sheetEl.hidden ? null : sheetEl.getBoundingClientRect();
      const wide = sr && sr.width < W * .7;
      const bottom = sr && !wide ? r.bottom - sr.top + 8 : 10;
      free = { x0: 8, y0: top, x1: W - (levelsEl.hidden ? 8 : 60), y1: H - bottom };
      free.w = Math.max(40, free.x1 - free.x0); free.h = Math.max(40, free.y1 - free.y0);
      free.cx = (free.x0 + free.x1) / 2; free.cy = (free.y0 + free.y1) / 2;
      camera.aspect = W / H;
      camera.setViewOffset(W, H, W / 2 - free.cx, H / 2 - free.cy, W, H);
      const [bx0, by0, bx1, by1] = P.box;
      const pts = [];
      for (const z of [P.zMin, P.zMax]) for (const [x, y] of [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]]) pts.push([x, z * Sto, -y]);
      // how far out you can go: the station still fills a good part of the screen
      maxDist = 1e9;
      maxDist = Math.min(fitPose(pts, cam.az, .9, 10).dist * 1.2, Math.max(levelPose(null).dist, route && R ? overviewPose().dist : 0) * 1.7);
    }

    // ----- start, rebuild, stop -----
    function rebuild() {
      clearScene();
      pickHl = null; picked = null; exploreCard = exploreActions = null;
      sel = -1; isolate = null;
      buildScene();
      restretch(true);
      buildLevels();
      buildSheet();
      layout();
      buildLabels();
      decorateRoute();
      setTargets();
      snapOpacity();
      if (user) { user.snap = null; user.salong = null; }
      if (R) select(-1, {}); else flyTo(overviewPose(), 900);
      if (pov) { const keep = pov; if (!pv.free && R) opts.povAt = pv.along; pov = false; povT = 0; Hs = HS_MODEL; S = Sto = P.vex; restretch(true); setPov(keep); }
      request();
    }
    function decorateRoute() {
      if (!route || !R) return;
      const a = destArea();
      if (a) highlight(a, WALK, theme === 'dark' ? .5 : .6);
    }
    function start(m, r) {
      model = m; P = prepare(m); router = r;
      titleEl.textContent = opts.title || m.name || 'Station';
      creditEl.textContent = (m.attribution || []).join(' · ');
      let noRoute = false;
      if (fromEnd && toEnd) { route = computeRoute(fromEnd, toEnd); noRoute = !route; }
      try { initGL(); } catch (e) { console.warn('Station3D: no WebGL', e); showState('nowebgl'); return; }
      S = Sto = P.vex;
      exploded = !!opts.explode;
      if (exploded) S = Sto = P.vex * EXPLODE;
      layout();
      buildScene();
      buildLevels();
      buildSheet();
      layout();
      buildLabels();
      decorateRoute();
      buildControls();
      setTargets();
      snapOpacity();
      const pose = limit(overviewPose());
      if (reducedMotion()) Object.assign(cam, pose);
      else { // one entrance: the floors rise apart, the camera settles, the route draws itself
        const full = Sto;
        S = full * .25;
        restretch(false);
        stretchTo(full, 1150);
        Object.assign(cam, limit(Object.assign({}, pose, { az: pose.az + .55, dist: pose.dist * 1.3 })));
        flyTo(pose, 1350);
        if (R) { R.U.uGrow.value = 0; grow = { t0: performance.now() + 350, dur: 1300 }; }
      }
      self.ready = true;
      showState(null);
      fitBtn.hidden = false;
      ro = new ResizeObserver(() => { if (self.ready) { layout(); if (!moved && !pov) flyTo(currentPose(), 0); request(); } });
      ro.observe(root);
      mo = new MutationObserver(() => {
        const t = isDark() ? 'dark' : 'light';
        if (t === theme) return;
        theme = t;
        root.classList.toggle('s3-dark', theme === 'dark');
        const keep = { sel, isolate, cam: Object.assign({}, cam) };
        rebuild();
        if (R && keep.sel >= 0) select(keep.sel, { keepCam: true, instant: true });
        tween = null;
        Object.assign(cam, keep.cam);
      });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      on(document, 'visibilitychange', () => { if (!document.hidden) { touch(); request(); } });
      if (pendingUser) setUser(pendingUser);
      if (noRoute) toast('No walking route found between these places. Showing the whole station.', 5000);
      else if (route && route.notice) toast(route.notice, 5000);
      if (opts.step != null && R) select(+opts.step);
      if (opts.level != null && P.levels.some((l) => l.id === +opts.level)) setIsolate(P.idxOf(+opts.level));
      if (opts.follow) setFollow(true);
      if (opts.pov) { setPov(true); if (opts.povYaw != null) pv.yaw = +opts.povYaw * Math.PI / 180; if (opts.povPitch != null) pv.pitch = +opts.povPitch * Math.PI / 180; }
      touch();
      request();
      emit('open', { key: m.key, route });
    }

    const api = { close: () => close(), reopen: (o) => open(o) };
    self.boot = function (instant) {
      loadCss().then(() => {
        if (!self.alive) return null;
        buildDom();
        showState('loading');
        if (instant) root.style.transition = 'none';
        void root.offsetWidth; // start from the closed position, also in a tab that gets no animation frames
        root.classList.add('s3-open');
        if (instant) { void root.offsetWidth; root.style.transition = ''; }
        try { root.querySelector('.s3-close').focus({ preventScroll: true }); } catch (e) {}
        const three = loadThree().catch((e) => { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { s3: 'three' }); });
        const mdl = loadModel(opts.key).catch((e) => { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { s3: 'model' }); });
        return Promise.all([three, mdl, loadRouter()]).then(([, m, r]) => { if (self.alive) start(m, r); });
      }).catch((e) => {
        if (!self.alive) return;
        console.error('Station3D:', e);
        if (root) showState(e && e.s3 ? e.s3 : 'three');
      });
    };
    self.destroy = function (instant) {
      if (!self.alive) return;
      self.alive = false;
      self.ready = false;
      if (raf > 0) cancelAnimationFrame(raf);
      [slowTimer, toastTimer, scrollTimer, tipTimer].forEach(clearTimeout);
      offs.forEach((f) => f());
      offs.length = 0;
      if (ro) ro.disconnect();
      if (mo) mo.disconnect();
      const el = root, rr = renderer, light = sun;
      const kill = () => {
        clearScene();
        if (light && light.shadow && light.shadow.map) light.shadow.map.dispose();
        if (rr) { rr.dispose(); try { rr.forceContextLoss(); } catch (e) {} }
        if (el) el.remove();
      };
      if (el) el.classList.remove('s3-open');
      if (instant || reducedMotion() || !el) kill(); else setTimeout(kill, 520);
    };
    self.setUser = setUser;
    self.select = (i) => { if (self.ready && R) { setFollow(false); select(i); } };
    self.setFollow = (b) => { if (self.ready) { setFollow(b); if (b) enableCompass(); } };
    self.enableCompass = enableCompass;
    self.setPov = (b) => setPov(b);
    self.orient = (e) => { if (!pv.device) setDeviceLook(true); onOrient(e); };
    self.debug = () => ({ cam: Object.assign({}, cam), S, sel, isolate, follow, user: user && Object.assign({}, user), userStep, route, model, levels: lv3.map((l) => l.op), draws: renderer ? renderer.info.render.calls : 0, tris: renderer ? renderer.info.render.triangles : 0, geoms: renderer ? renderer.info.memory.geometries : 0, labels: labels.length, pov, povT, pv: Object.assign({}, pv), pick, flyTo, request });
    return self;
  }

  // ---------- public API ----------
  let V = null;
  let pendingUser = null; // the last position: also shown when it arrived before the model was ready
  let lastFocus = null;

  // The view is one history entry (URL hash #station3d), so the back gesture closes it. pushState rather than
  // location.hash: a hash set while the page is still loading replaces the entry instead of adding one.
  function onHash() { if (V && location.hash !== HASH) shut(); }
  const ours = () => { try { return !!(history.state && history.state.station3d); } catch (e) { return false; } };
  function shut(instant) {
    if (!V) return;
    const v = V;
    V = null;
    v.destroy(instant);
    window.removeEventListener('hashchange', onHash);
    window.removeEventListener('popstate', onHash);
    emit('close');
    try { if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true }); } catch (e) {}
    lastFocus = null;
  }
  function open(opts) {
    opts = Object.assign({}, opts);
    if (!opts.key) throw new Error('Station3D.open needs a key');
    const again = !!V;
    if (V) { const v = V; V = null; v.destroy(true); }
    else lastFocus = document.activeElement;
    if (location.hash !== HASH) {
      try { history.pushState({ station3d: true }, '', HASH); } catch (e) { location.hash = HASH; }
    }
    window.removeEventListener('hashchange', onHash);
    window.removeEventListener('popstate', onHash);
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    V = createViewer(opts);
    V.boot(again);
  }
  function close() {
    if (!V) return;
    shut();
    if (location.hash === HASH) {
      if (ours()) history.back();
      else history.replaceState(null, '', location.pathname + location.search);
    }
  }

  window.Station3D = {
    // SCHEMA.md
    has: (uic) => (window.STATION3D_INDEX && window.STATION3D_INDEX[String(uic)]) || null,
    open,
    setUser: (u) => { pendingUser = u || null; if (V) V.setUser(pendingUser); },
    close,
    // extras
    isOpen: () => !!V,
    on: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); return () => window.Station3D.off(name, fn); },
    off: (name, fn) => { listeners[name] = (listeners[name] || []).filter((f) => f !== fn); },
    selectStep: (i) => { if (V) V.select(i); },
    setFollow: (b) => { if (V) V.setFollow(b); },
    enableCompass: () => { if (V) V.enableCompass(); },
    setPov: (b) => { if (V) V.setPov(b); },
    _orient: (e) => { if (V) V.orient(e); },
    preload: (key) => Promise.all([loadCss(), loadThree(), key ? loadModel(key) : null, loadRouter()]).then(() => true, () => false),
    _debug: () => (V ? V.debug() : null),
  };

})();
