/*
 * station3d-detail.js: draws a detail scene (stations3d/DETAIL.md) for the first-person view of station3d.js.
 * A short stretch of street with everything you would recognise on the spot: trees, benches, lamps, kerbs and
 * ledges, the houses at their real size. Classic script, no dependencies beyond the THREE module object that is
 * passed in, no network requests, no image files: geometry and canvas textures are made here.
 *
 * API
 *   const h = Station3DDetail.build(THREE, detail, opts)
 *     opts.theme     "light" (day) | "dark" (night: lamps and windows lit)            default "light"
 *     opts.quality   "high" | "low"   crown, branch, facade and texture detail         default "high"
 *     opts.season    "winter" | "summer"   all trees bare / all in leaf, whatever the data says. Default: the
 *                    data (tree.leaves)
 *     opts.pollard   true | false   draw all broadleaf trees pollarded / none. Default: the data (tree.form)
 *     opts.toScene   (x, y, z) => [X, Y, Z]   model metres (x east, y north, z up, relative to level 0) to scene
 *                    coordinates. Default: [x, z, -y] (the viewer is Y-up).
 *     opts.zShift    metres the whole scene is moved up (+) or down (-) before toScene; true: by detail.zOffset.
 *                    groundAt answers in the shifted frame. Default 0.
 *     opts.palette   { ground: "#…", wall: "#…", crown: "#…", … }   overrides single colours of PALETTE[theme]
 *     opts.sun       { azimuth: 228, elevation: 64 }   where the light comes from (compass bearing, degrees).
 *                    Default: the direction of the viewer's sun.
 *     opts.sky       true: add a sky dome to the group (the viewer has its own sky)
 *     opts.feather   metres the ground fades out over beyond detail.area (default 5; 0: no fade)
 *     opts.clearance metres of free height kept under crowns that reach over detail.path (default 2.7)
 *   returns a handle:
 *     h.group        THREE.Group to add to the scene. All positions are already in scene coordinates.
 *     h.stats        { triangles, drawCalls, vertices, textures, buildMs, counts, parts, warnings }
 *     h.dispose()    removes the group from its parent and frees geometries, materials and textures
 *     h.groundAt(x, y)   same as Station3DDetail.groundAt(h, x, y)
 *     h.zShift       the shift that was applied (a number)
 *     h.parts        { ground: [Mesh…], decals, solid, buildings, crowns, glass, shadows, pools, glows, feather, sky }
 *                    the meshes by role, so the viewer can fade or hide one (crowns.material.opacity …)
 *     h.lamps        [{ xy, z, height }]  where the lamps are (model coordinates, z shifted)
 *
 *   Station3DDetail.update(h, { theme, quality, season, pollard, zShift, palette, sun })
 *     Changes the look without a new handle: the contents of h.group are built again in place (some tens of
 *     milliseconds; colours and shading are baked into the vertices, so there is no cheaper way). h.stats is renewed.
 *   Station3DDetail.groundAt(h, x, y)  →  z of what you stand on at this point (model metres relative to level 0,
 *     plus zShift): the topmost detailed surface, kerb and low ledge tops, steps as a ramp, arcade floors; the
 *     plain ground of detail.area where there is no surface; null outside the scene.
 *   Station3DDetail.sky(THREE, { theme, palette, radius })  →  a sky dome mesh (Y-up scene), for pages without one
 *   Station3DDetail.palette(theme)  →  a copy of the default colours
 *
 * How it draws
 *   Lighting is baked: every vertex gets its final colour here (sun side lighter, shaded side darker, lamps at
 *   night), and all materials are unlit MeshBasicMaterial. So the look does not depend on the lights of the scene,
 *   it is the cheapest thing a phone can draw, and the scene's fog and clipping planes still apply. Everything
 *   static is merged: one mesh for all props, edges and trunks, one for the buildings, one for the crowns, one per
 *   ground texture and layer, one each for ground markings, glass, shadows, light pools and lamp glows.
 *
 * Data beyond DETAIL.md that is understood (all optional; anything else is ignored)
 *   detail.zOffset                   used by zShift: true
 *   surface.use, surface.color       road / pavement / square / island set the tone; a colour shifts it a little
 *   surface.heading                  direction of the pattern (paving joints, cobble arcs) or, for a crossing, of walking
 *   surface.line, tracks, gauge      tram track: centre line [[x, y], …], number of tracks, gauge (default 1.0 m)
 *   edge.side                        "left" | "right": the side (seen along the line) steps climb to
 *   tree.form: "pollard…" | tree.pollarded: true     knuckles with one year's shoots instead of a crown
 *   tree.planted                     year: sets the trunk thickness when tree.trunk is missing
 *   prop.axis (when heading is missing), prop.capacity (bike stands), prop.mount (a sign strapped to the mast
 *   beside it), statue.plinthHeight / plinthColor / color, kind "ticket-machine"
 *   building.arcade: "arches" | "pillars", arcadeDepth, shutters: true | "#…", roofFloors (dormers on a mesh roof),
 *   face.heading (the way the wall looks, for buildings without a ring)
 *   Missing z: things stand on the detailed ground below them.
 */
(function () {
  'use strict';

  // ---------- small maths ----------
  const RAD = Math.PI / 180, TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const smooth = (a, b, v) => { const t = sat((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : undefined);
  const or = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  function faceN(a, b, c) {
    const n = cross(sub(b, a), sub(c, a)), l = Math.hypot(n[0], n[1], n[2]);
    return l < 1e-10 ? null : [n[0] / l, n[1] / l, n[2] / l];
  }
  // a seed from a position (centimetre grid), and a small random generator: the same place always looks the same
  function seedOf(x, y, salt) {
    let h = (Math.imul(Math.round(x * 100), 73856093) ^ Math.imul(Math.round(y * 100), 19349663) ^ Math.imul((salt || 0) + 1, 83492791)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b); h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    return (h ^ (h >>> 16)) >>> 0;
  }
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // smooth noise in 3D, 0..1
  function hash3(i, j, k) { const s = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453; return s - Math.floor(s); }
  function noise3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let fx = x - xi, fy = y - yi, fz = z - zi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    const a = lerp(lerp(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), fx), lerp(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), fx), fy);
    const b = lerp(lerp(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), fx), lerp(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), fx), fy);
    return lerp(a, b, fz);
  }

  // ---------- colours: sRGB triples 0..1 while building, linear in the buffers ----------
  function hex(h) {
    if (Array.isArray(h)) return h;
    let s = String(h || '').trim().replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    const n = parseInt(s, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const tone = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  const toLin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const css = (c, a) => 'rgba(' + Math.round(sat(c[0]) * 255) + ',' + Math.round(sat(c[1]) * 255) + ',' + Math.round(sat(c[2]) * 255) + ',' + (a == null ? 1 : a) + ')';
  const WHITE = [1, 1, 1], BLACK = [0, 0, 0];

  const PALETTE = {
    light: {
      sky: '#DCEBFA', horizon: '#F4F1EA', ground: '#F3EFE7',
      paving: '#EDE8DE', asphalt: '#D9D6D0', cobble: '#E2DCD0', gravel: '#E9E1D0', grass: '#CDE6B8', soil: '#C9BBA4', water: '#A8D2EE',
      tram: '#DFDBD3', kerb: '#C9C3B6', stone: '#DDD7CA', marking: '#F0CE56', rail: '#8C9096',
      wall: '#EDEAE3', wallShade: '#D6D1C6', trim: '#F7F4EE', roof: '#B9B0A4', roofTile: '#B58D78',
      glass: '#9FB4C8', glassLit: '#FFE9B0', pane: '#CFE3F2', door: '#8E7A66',
      crown: '#A9D18E', crownDark: '#8FBF78', crownLight: '#C4E2AC', hedge: '#9CC784', conifer: '#7FB08A',
      trunk: '#8D7B68', metal: '#6E7278', steel: '#B4B8BD', wood: '#B08A62',
      lamp: '#FFE9B0', lens: '#FBF7EA', bronze: '#84978C', sign: '#4C8FE0', hydrant: '#C8705F',
      shadow: '#4A4233', shadowAlpha: 0.27,
      awnings: ['#C9907C', '#A3B79E', '#E3CFA2', '#9FB1C4'], shutters: ['#9DB39A', '#A8B6BF', '#BC958C'],
      flowers: ['#E58F8F', '#F2C75C', '#E9A6C6'],
    },
    dark: {
      sky: '#101216', horizon: '#1B1D22', ground: '#26282C',
      paving: '#2E3035', asphalt: '#232427', cobble: '#2C2D31', gravel: '#33332F', grass: '#22372A', soil: '#2B2823', water: '#1E3449',
      tram: '#28292D', kerb: '#3A3C42', stone: '#42444A', marking: '#9C8638', rail: '#5F636A',
      wall: '#3B3D43', wallShade: '#2F3136', trim: '#494B52', roof: '#2A2B30', roofTile: '#3A302C',
      glass: '#1D2530', glassLit: '#FFD98A', pane: '#2B3A4A', door: '#3A322B',
      crown: '#2F4A36', crownDark: '#27402F', crownLight: '#38573F', hedge: '#2B4532', conifer: '#263E33',
      trunk: '#4A4138', metal: '#55585E', steel: '#6B6F76', wood: '#6A5440',
      lamp: '#FFD98A', lens: '#FFF1C9', bronze: '#3F5048', sign: '#35629F', hydrant: '#7A4439',
      shadow: '#000000', shadowAlpha: 0.34,
      awnings: ['#6A4A40', '#4A5A4A', '#6B6046', '#46546A'], shutters: ['#3F5244', '#465058', '#5A433E'],
      flowers: ['#8E5252', '#9A7F35', '#8E5F78'],
    },
  };
  function paletteOf(theme, over) {
    const src = PALETTE[theme === 'dark' ? 'dark' : 'light'], out = {};
    for (const k of Object.keys(src)) {
      const v = over && over[k] != null ? over[k] : src[k];
      if (Array.isArray(src[k])) out[k] = (Array.isArray(v) ? v : src[k]).map((c) => hex(c) || hex(src[k][0]));
      else if (typeof src[k] === 'number') out[k] = typeof v === 'number' ? v : src[k];
      else out[k] = hex(v) || hex(src[k]);
    }
    return out;
  }

  // ---------- polygons and lines in the plan ----------
  const area2 = (r) => { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
  // A usable ring: no repeated points, counter-clockwise. keep[] says which of the given points stayed (for zs).
  function cleanRing(ring) {
    if (!Array.isArray(ring)) return null;
    const pts = [], keep = [];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
      const q = pts[pts.length - 1];
      if (q && Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-4) continue;
      pts.push([+p[0], +p[1]]); keep.push(i);
    }
    while (pts.length > 1 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-4) { pts.pop(); keep.pop(); }
    if (pts.length < 3) return null;
    if (Math.abs(area2(pts)) < 1e-6) return null;
    if (area2(pts) < 0) { pts.reverse(); keep.reverse(); }
    pts.keep = keep;
    return pts;
  }
  function inRing(r, x, y) {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i], b = r[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  const boxOf = (r) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of r) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); } return [x0, y0, x1, y1]; };
  const centroid = (r) => { let x = 0, y = 0; for (const p of r) { x += p[0]; y += p[1]; } return [x / r.length, y / r.length]; };
  function segDist(px, py, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? clamp(((px - a[0]) * dx + (py - a[1]) * dy) / l2, 0, 1) : 0;
    return Math.hypot(px - a[0] - dx * t, py - a[1] - dy * t);
  }
  function lineDist(line, x, y) { let d = Infinity; for (let i = 0; i + 1 < line.length; i++) d = Math.min(d, segDist(x, y, line[i], line[i + 1])); return d; }
  // keep the part of a polygon where A·x + B·y + C >= 0
  function clipPoly(poly, A, B, C) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const dp = A * p[0] + B * p[1] + C, dq = A * q[0] + B * q[1] + C;
      if (dp >= 0) out.push(p);
      if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
    }
    return out;
  }
  // The direction most edges of a ring run in (degrees, 0..90 folded: paving is laid along or across it)
  function grainOf(ring) {
    let c = 0, s = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const t = Math.atan2(b[1] - a[1], b[0] - a[0]) * 4;
      c += Math.cos(t) * l; s += Math.sin(t) * l;
    }
    return Math.atan2(s, c) / 4;
  }
  // The long axis of a ring: [ux, uy] and the extents along and across it
  function longAxis(ring, ang) {
    let best = null;
    const tryDir = (t) => {
      const ux = Math.cos(t), uy = Math.sin(t);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const p of ring) { const u = p[0] * ux + p[1] * uy, v = -p[0] * uy + p[1] * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
      const r = { ux, uy, u0, u1, v0, v1, len: u1 - u0, wid: v1 - v0 };
      if (ang != null) { best = r; return; }
      if (!best || r.len * r.wid < best.len * best.wid - 1e-6) best = r;
    };
    if (ang != null) tryDir(ang);
    else for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.05) tryDir(Math.atan2(b[1] - a[1], b[0] - a[0])); }
    if (best && best.wid > best.len) best = { ux: -best.uy, uy: best.ux, u0: best.v0, u1: best.v1, v0: -best.u1, v1: -best.u0, len: best.wid, wid: best.len };
    return best;
  }
  // A line without repeated points; closed: the last point joins the first
  function cleanLine(line, closed) {
    const pts = [];
    for (const p of line || []) {
      if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
      const q = pts[pts.length - 1];
      if (q && Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-3) continue;
      pts.push([+p[0], +p[1]]);
    }
    if (closed && pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-3) pts.pop();
    return pts.length >= 2 ? pts : null;
  }
  // Per point of a line: the direction of travel and the mitre to its left (already scaled for a clean corner)
  function lineFrames(pts, closed) {
    const n = pts.length, out = [];
    for (let i = 0; i < n; i++) {
      const a = closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)], b = closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)], p = pts[i];
      let d0x = p[0] - a[0], d0y = p[1] - a[1], d1x = b[0] - p[0], d1y = b[1] - p[1];
      let l0 = Math.hypot(d0x, d0y), l1 = Math.hypot(d1x, d1y);
      if (l0 < 1e-6) { d0x = d1x; d0y = d1y; l0 = l1; }
      if (l1 < 1e-6) { d1x = d0x; d1y = d0y; l1 = l0; }
      d0x /= l0 || 1; d0y /= l0 || 1; d1x /= l1 || 1; d1y /= l1 || 1;
      let tx = d0x + d1x, ty = d0y + d1y;
      const tl = Math.hypot(tx, ty);
      if (tl < 1e-6) { tx = d1x; ty = d1y; } else { tx /= tl; ty /= tl; }
      const cosHalf = Math.max(0.35, tx * d1x + ty * d1y); // limits the spike of a sharp corner
      out.push({ p, t: [tx, ty], l: [-ty / cosHalf, tx / cosHalf] });
    }
    return out;
  }
  const offPt = (f, d) => [f.p[0] + f.l[0] * d, f.p[1] + f.l[1] * d];
  // Points every `step` metres along a line (corners always included): [{ p, t, s }]
  function walkLine(pts, step, closed) {
    const out = [], n = pts.length, m = closed ? n : n - 1;
    let s = 0;
    for (let i = 0; i < m; i++) {
      const a = pts[i], b = pts[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l < 1e-6) continue;
      const k = Math.max(1, Math.round(l / step)), t = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
      for (let j = 0; j < k; j++) out.push({ p: [lerp(a[0], b[0], j / k), lerp(a[1], b[1], j / k)], t, s: s + l * j / k, corner: j === 0 });
      s += l;
      if (i === m - 1) out.push({ p: [b[0], b[1]], t, s, corner: true, last: true });
    }
    return out;
  }

  // ---------- the detailed ground: what z a point has ----------
  function Ground() { this.t = []; this.grid = new Map(); this.cell = 4; }
  Ground.prototype.add = function (a, b, c, layer) {
    const d = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(d) < 1e-9) return;
    const i = this.t.length;
    this.t.push([a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d, layer || 0]);
    const s = this.cell;
    const x0 = Math.floor(Math.min(a[0], b[0], c[0]) / s), x1 = Math.floor(Math.max(a[0], b[0], c[0]) / s);
    const y0 = Math.floor(Math.min(a[1], b[1], c[1]) / s), y1 = Math.floor(Math.max(a[1], b[1], c[1]) / s);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const k = x * 100003 + y;
      let l = this.grid.get(k);
      if (!l) this.grid.set(k, (l = []));
      l.push(i);
    }
  };
  // z of the surface drawn last at (x, y); hit(x, y) also tells its layer
  Ground.prototype.hit = function (x, y) {
    const l = this.grid.get(Math.floor(x / this.cell) * 100003 + Math.floor(y / this.cell));
    if (!l) return null;
    for (let i = l.length - 1; i >= 0; i--) {
      const t = this.t[l[i]];
      const w1 = ((x - t[0]) * (t[7] - t[1]) - (y - t[1]) * (t[6] - t[0])) / t[9];
      const w2 = ((t[3] - t[0]) * (y - t[1]) - (t[4] - t[1]) * (x - t[0])) / t[9];
      if (w1 < -1e-6 || w2 < -1e-6 || w1 + w2 > 1 + 1e-6) continue;
      return { z: t[2] + (t[5] - t[2]) * w1 + (t[8] - t[2]) * w2, layer: t[10] };
    }
    return null;
  };
  Ground.prototype.at = function (x, y) { const h = this.hit(x, y); return h ? h.z : null; };

  // ---------- geometry buffers ----------
  // One merged mesh in the making. Positions are model coordinates until finish() maps them to the scene.
  function Batch(alpha) { this.p = []; this.c = []; this.i = []; this.uv = null; this.n = 0; this.alpha = !!alpha; }
  Batch.prototype.vert = function (p, c, a) {
    this.p.push(p[0], p[1], p[2]);
    if (this.alpha) this.c.push(c[0], c[1], c[2], a == null ? 1 : a); else this.c.push(c[0], c[1], c[2]);
    return this.n++;
  };

  // Writes shapes into a batch. Points are given in a local frame (frame(): x to the right, y the way the thing
  // faces, z up) or in model coordinates (world()). Every vertex colour runs through shade().
  function Writer(batch, shade) { this.b = batch; this.shade = shade; this.o = null; }
  Writer.prototype.frame = function (x, y, z, heading) { const h = (heading || 0) * RAD; this.o = { x, y, z, c: Math.cos(h), s: Math.sin(h) }; return this; };
  Writer.prototype.world = function () { this.o = null; return this; };
  Writer.prototype.P = function (p) { const o = this.o; return o ? [o.x + p[0] * o.c + p[1] * o.s, o.y - p[0] * o.s + p[1] * o.c, o.z + p[2]] : p; };
  Writer.prototype.N = function (n) { const o = this.o; return o ? [n[0] * o.c + n[1] * o.s, -n[0] * o.s + n[1] * o.c, n[2]] : n; };
  // one vertex: world position, world normal, colour (or a function of both), mode (see shade), alpha
  Writer.prototype.emit = function (P, n, col, mode, a) {
    const c = typeof col === 'function' ? col(P, n) : col;
    return this.b.vert(P, this.shade(c, n, P, mode), a);
  };
  Writer.prototype.tri = function (a, b, c, col, opt) {
    const A = this.P(a), B = this.P(b), C = this.P(c);
    let n = faceN(A, B, C);
    if (!n) return;
    let flip = false;
    if (opt && opt.n) { const h = this.N(opt.n); if (dot(n, h) < 0) { flip = true; n = [-n[0], -n[1], -n[2]]; } }
    const cs = Array.isArray(col) && Array.isArray(col[0]) ? col : null, mode = opt && opt.mode, al = opt && opt.a;
    const i0 = this.emit(A, n, cs ? cs[0] : col, mode, al), i1 = this.emit(B, n, cs ? cs[1] : col, mode, al), i2 = this.emit(C, n, cs ? cs[2] : col, mode, al);
    if (flip) this.b.i.push(i0, i2, i1); else this.b.i.push(i0, i1, i2);
    if (opt && opt.two) { if (flip) this.b.i.push(i0, i1, i2); else this.b.i.push(i0, i2, i1); }
  };
  // a flat four-sided face; opt.n: a direction the face should look to (the winding is turned to match),
  // opt.two: visible from both sides, col: one colour, four colours or a function, opt.a: alpha or four alphas
  Writer.prototype.quad = function (a, b, c, d, col, opt) {
    const A = this.P(a), B = this.P(b), C = this.P(c), D = this.P(d);
    let n = faceN(A, B, C) || faceN(A, C, D) || faceN(B, C, D);
    if (!n) return;
    let flip = false;
    if (opt && opt.n) { const h = this.N(opt.n); if (dot(n, h) < 0) { flip = true; n = [-n[0], -n[1], -n[2]]; } }
    const cs = Array.isArray(col) && Array.isArray(col[0]) ? col : null, mode = opt && opt.mode, al = opt && opt.a, as = Array.isArray(al) ? al : null;
    const i0 = this.emit(A, n, cs ? cs[0] : col, mode, as ? as[0] : al), i1 = this.emit(B, n, cs ? cs[1] : col, mode, as ? as[1] : al);
    const i2 = this.emit(C, n, cs ? cs[2] : col, mode, as ? as[2] : al), i3 = this.emit(D, n, cs ? cs[3] : col, mode, as ? as[3] : al);
    if (flip) this.b.i.push(i0, i2, i1, i0, i3, i2); else this.b.i.push(i0, i1, i2, i0, i2, i3);
    if (opt && opt.two) { if (flip) this.b.i.push(i0, i1, i2, i0, i2, i3); else this.b.i.push(i0, i2, i1, i0, i3, i2); }
  };
  // a flat convex face from its outline
  Writer.prototype.fan = function (pts, col, opt) {
    if (pts.length < 3) return;
    const W = pts.map((p) => this.P(p));
    let n = null;
    for (let i = 1; i + 1 < W.length && !n; i++) n = faceN(W[0], W[i], W[i + 1]);
    if (!n) return;
    let flip = false;
    if (opt && opt.n) { const h = this.N(opt.n); if (dot(n, h) < 0) { flip = true; n = [-n[0], -n[1], -n[2]]; } }
    const mode = opt && opt.mode, idx = W.map((p) => this.emit(p, n, col, mode, opt && opt.a));
    for (let i = 1; i + 1 < idx.length; i++) {
      if (flip) this.b.i.push(idx[0], idx[i + 1], idx[i]); else this.b.i.push(idx[0], idx[i], idx[i + 1]);
      if (opt && opt.two) { if (flip) this.b.i.push(idx[0], idx[i], idx[i + 1]); else this.b.i.push(idx[0], idx[i + 1], idx[i]); }
    }
  };
  // a box along the axes of the frame; opt.top: colour of the lid, opt.bottom: draw the underside too
  Writer.prototype.box = function (x0, y0, z0, x1, y1, z1, col, opt) {
    const t = (opt && opt.top) || col, o = opt && opt.mode ? { mode: opt.mode } : {};
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], t, Object.assign({ n: [0, 0, 1] }, o));
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], col, Object.assign({ n: [0, -1, 0] }, o));
    this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], col, Object.assign({ n: [0, 1, 0] }, o));
    this.quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], col, Object.assign({ n: [-1, 0, 0] }, o));
    this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], col, Object.assign({ n: [1, 0, 0] }, o));
    if (opt && opt.bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], col, Object.assign({ n: [0, 0, -1] }, o));
  };
  // a box of any orientation: centre and three half-axes
  Writer.prototype.obox = function (c, ax, ay, az, col, opt) {
    const P = (i, j, k) => [c[0] + ax[0] * i + ay[0] * j + az[0] * k, c[1] + ax[1] * i + ay[1] * j + az[1] * k, c[2] + ax[2] * i + ay[2] * j + az[2] * k];
    const o = (n) => (opt && opt.mode ? { n, mode: opt.mode } : { n });
    const skip = (opt && opt.skip) || '';
    if (!skip.includes('+z')) this.quad(P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), (opt && opt.top) || col, o(az));
    if (!skip.includes('-z')) this.quad(P(-1, -1, -1), P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1), col, o(mul3(az, -1)));
    if (!skip.includes('-y')) this.quad(P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), col, o(mul3(ay, -1)));
    if (!skip.includes('+y')) this.quad(P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1), col, o(ay));
    if (!skip.includes('-x')) this.quad(P(-1, -1, -1), P(-1, 1, -1), P(-1, 1, 1), P(-1, -1, 1), col, o(mul3(ax, -1)));
    if (!skip.includes('+x')) this.quad(P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1), col, o(ax));
  };
  // an upright round post or cone, smooth around; opt.cap: close the top, opt.col1: colour at the top
  Writer.prototype.cyl = function (x, y, z0, z1, r0, r1, seg, col, opt) {
    const h = z1 - z0, sl = (r0 - r1) / (h || 1), il = 1 / Math.hypot(1, sl), mode = opt && opt.mode;
    const c1 = (opt && opt.col1) || col, base = this.b.n, ph = (opt && opt.phase) || 0;
    for (let k = 0; k <= seg; k++) {
      const a = ph + (k / seg) * TAU, ca = Math.cos(a), sa = Math.sin(a), n = this.N([ca * il, sa * il, sl * il]);
      this.emit(this.P([x + ca * r0, y + sa * r0, z0]), n, col, mode);
      this.emit(this.P([x + ca * r1, y + sa * r1, z1]), n, c1, mode);
    }
    for (let k = 0; k < seg; k++) { const a = base + k * 2; this.b.i.push(a, a + 2, a + 3, a, a + 3, a + 1); }
    if (opt && opt.cap && r1 > 1e-4) {
      const pts = [];
      for (let k = 0; k < seg; k++) { const a = ph + (k / seg) * TAU; pts.push([x + Math.cos(a) * r1, y + Math.sin(a) * r1, z1]); }
      this.fan(pts, (opt && opt.capCol) || c1, { n: [0, 0, 1], mode });
    }
  };
  // a round bar along a path of [x, y, z, radius]; opt.cap: close the far end; opt.cols: a colour per path point
  Writer.prototype.tube = function (path, seg, col, opt) {
    const n = path.length;
    if (n < 2) return;
    const mode = opt && opt.mode, base = this.b.n;
    let u = null;
    for (let i = 0; i < n; i++) {
      const a = path[Math.max(0, i - 1)], b = path[Math.min(n - 1, i + 1)];
      const t = norm(sub(b, a));
      if (!u) u = Math.abs(t[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
      u = norm(sub(u, mul3(t, dot(u, t))));
      const v = cross(t, u), p = path[i], r = p[3], c = opt && opt.cols ? opt.cols[i] : col;
      for (let k = 0; k <= seg; k++) {
        const an = (k / seg) * TAU, ca = Math.cos(an), sa = Math.sin(an);
        const d = [u[0] * ca + v[0] * sa, u[1] * ca + v[1] * sa, u[2] * ca + v[2] * sa];
        this.emit(this.P([p[0] + d[0] * r, p[1] + d[1] * r, p[2] + d[2] * r]), this.N(d), c, mode);
      }
    }
    const m = seg + 1;
    for (let i = 0; i + 1 < n; i++) for (let k = 0; k < seg; k++) {
      const a = base + i * m + k, b = a + m;
      this.b.i.push(a, a + 1, b + 1, a, b + 1, b);
    }
    if (opt && opt.cap && path[n - 1][3] > 1e-3) {
      const t = norm(sub(path[n - 1], path[n - 2])), p = path[n - 1], r = p[3];
      let w = Math.abs(t[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
      w = norm(sub(w, mul3(t, dot(w, t))));
      const v = cross(t, w), pts = [];
      for (let k = 0; k < seg; k++) { const an = (k / seg) * TAU; pts.push([p[0] + (w[0] * Math.cos(an) + v[0] * Math.sin(an)) * r, p[1] + (w[1] * Math.cos(an) + v[1] * Math.sin(an)) * r, p[2] + (w[2] * Math.cos(an) + v[2] * Math.sin(an)) * r]); }
      this.fan(pts, opt.cols ? opt.cols[n - 1] : col, { n: t, mode });
    }
  };
  // a turned shape around an upright axis: profile [[radius, height, colour?], …] from the bottom up.
  // Few sides give facets (an octagonal basin), many a round body.
  Writer.prototype.lathe = function (x, y, z, profile, seg, col, opt) {
    const mode = opt && opt.mode, ph = (opt && opt.phase) || 0, facet = opt && opt.facet != null ? opt.facet : seg <= 8;
    for (let i = 0; i + 1 < profile.length; i++) {
      const a = profile[i], b = profile[i + 1], c = b[2] || col;
      if (Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5) continue;
      if (facet) {
        for (let k = 0; k < seg; k++) {
          const a0 = ph + (k / seg) * TAU, a1 = ph + ((k + 1) / seg) * TAU, am = (a0 + a1) / 2;
          const dz = b[1] - a[1], dr = b[0] - a[0], l = Math.hypot(dz, dr) || 1;
          const hint = [Math.cos(am) * dz / l, Math.sin(am) * dz / l, -dr / l];
          const p0 = [x + Math.cos(a0) * a[0], y + Math.sin(a0) * a[0], z + a[1]], p1 = [x + Math.cos(a1) * a[0], y + Math.sin(a1) * a[0], z + a[1]];
          const p2 = [x + Math.cos(a1) * b[0], y + Math.sin(a1) * b[0], z + b[1]], p3 = [x + Math.cos(a0) * b[0], y + Math.sin(a0) * b[0], z + b[1]];
          if (a[0] < 1e-5) this.tri(p0, p2, p3, c, { n: hint, mode });
          else if (b[0] < 1e-5) this.tri(p0, p1, p2, c, { n: hint, mode });
          else this.quad(p0, p1, p2, p3, c, { n: hint, mode });
        }
      } else {
        const dz = b[1] - a[1], dr = b[0] - a[0], l = Math.hypot(dz, dr) || 1, base = this.b.n;
        for (let k = 0; k <= seg; k++) {
          const an = ph + (k / seg) * TAU, ca = Math.cos(an), sa = Math.sin(an), nn = this.N([ca * dz / l, sa * dz / l, -dr / l]);
          this.emit(this.P([x + ca * a[0], y + sa * a[0], z + a[1]]), nn, c, mode);
          this.emit(this.P([x + ca * b[0], y + sa * b[0], z + b[1]]), nn, c, mode);
        }
        for (let k = 0; k < seg; k++) { const q = base + k * 2; this.b.i.push(q, q + 2, q + 3, q, q + 3, q + 1); }
      }
    }
  };

  // A ball of triangles (an icosahedron with every face split f × f), made once per f
  const ICO = {};
  function icosphere(f) {
    if (ICO[f]) return ICO[f];
    const t = (1 + Math.sqrt(5)) / 2;
    const V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    const F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const v = [], tris = [], key = new Map();
    const put = (x, y, z) => {
      const l = Math.hypot(x, y, z), q = [x / l, y / l, z / l], k = Math.round(q[0] * 1e4) + ',' + Math.round(q[1] * 1e4) + ',' + Math.round(q[2] * 1e4);
      let i = key.get(k);
      if (i == null) { i = v.length; v.push(q); key.set(k, i); }
      return i;
    };
    for (const [a, b, c] of F) {
      const A = V[a], B = V[b], C = V[c], idx = [];
      for (let i = 0; i <= f; i++) {
        idx[i] = [];
        for (let j = 0; j <= f - i; j++) { const k = f - i - j; idx[i][j] = put(A[0] * i + B[0] * j + C[0] * k, A[1] * i + B[1] * j + C[1] * k, A[2] * i + B[2] * j + C[2] * k); }
      }
      for (let i = 0; i < f; i++) for (let j = 0; j < f - i; j++) {
        tris.push([idx[i][j], idx[i + 1][j], idx[i][j + 1]]);
        if (j < f - i - 1) tris.push([idx[i + 1][j], idx[i + 1][j + 1], idx[i][j + 1]]);
      }
    }
    for (const tr of tris) { // all faces look outwards
      const n = cross(sub(v[tr[1]], v[tr[0]]), sub(v[tr[2]], v[tr[0]]));
      if (dot(n, v[tr[0]]) < 0) { const s = tr[1]; tr[1] = tr[2]; tr[2] = s; }
    }
    return (ICO[f] = { v, t: tris });
  }
  // A soft lump: a ball with radii rad, dented by noise. col(P, n, dir) gives the colour of a vertex.
  Writer.prototype.lump = function (c, rad, f, amp, seed, col, mode) {
    const ico = icosphere(f), base = this.b.n, sx = (seed % 97) * 0.37, sy = (seed % 89) * 0.53;
    for (const d of ico.v) {
      const k = 1 + amp * (noise3(d[0] * 1.9 + sx, d[1] * 1.9 + sy, d[2] * 1.9) - 0.5) * 2;
      const P = this.P([c[0] + d[0] * rad[0] * k, c[1] + d[1] * rad[1] * k, c[2] + d[2] * rad[2] * k]);
      const n = this.N(norm([d[0] / rad[0], d[1] / rad[1], d[2] / rad[2]]));
      this.b.vert(P, this.shade(col(P, n, d), n, P, mode));
    }
    for (const t of ico.t) this.b.i.push(base + t[0], base + t[1], base + t[2]);
  };

  // ---------- ground textures, painted once per theme ----------
  // How many metres one repeat of a texture covers
  const TILE = { asphalt: 5, paving: 3.6, cobble: 2.4, gravel: 3, grass: 6, soil: 3, water: 4, tram: 5 };
  const TEXTURED = { asphalt: 1, paving: 1, cobble: 1, gravel: 1, grass: 1, soil: 1, water: 1, tram: 1 };
  function paint(kind, pal, n, dark) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = n;
    const g = cv.getContext('2d'), R = rng(seedOf(kind.length * 3.7, kind.charCodeAt(0) * 1.3, 5));
    const base = pal[kind] || pal.paving, k = dark ? 0.7 : 1, px = n / 512;
    g.fillStyle = css(base);
    g.fillRect(0, 0, n, n);
    const dots = (count, c, a, r0, r1) => {
      g.fillStyle = css(c, a);
      for (let i = 0; i < count; i++) { const r = lerp(r0, r1, R()) * px; g.fillRect(R() * n, R() * n, r, r); }
    };
    const clouds = (count, c, a, r0, r1) => {
      for (let i = 0; i < count; i++) {
        const x = R() * n, y = R() * n, r = lerp(r0, r1, R()) * n;
        for (const ox of [-n, 0, n]) for (const oy of [-n, 0, n]) {
          if (x + ox + r < 0 || x + ox - r > n || y + oy + r < 0 || y + oy - r > n) continue;
          const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
          gr.addColorStop(0, css(c, a)); gr.addColorStop(1, css(c, 0));
          g.fillStyle = gr;
          g.fillRect(x + ox - r, y + oy - r, 2 * r, 2 * r);
        }
      }
    };
    const lighter = mix(base, WHITE, dark ? 0.16 : 0.5), darker = tone(base, dark ? 0.72 : 0.84);
    if (kind === 'asphalt' || kind === 'tram') {
      clouds(14, darker, 0.07 * k, 0.1, 0.3); clouds(10, lighter, 0.08 * k, 0.1, 0.25);
      dots(5200, lighter, 0.26 * k, 1.2, 2.6); dots(5200, darker, 0.2 * k, 1.2, 2.6);
    } else if (kind === 'gravel') {
      clouds(12, darker, 0.08 * k, 0.1, 0.3); clouds(10, lighter, 0.1 * k, 0.1, 0.3);
      dots(9000, lighter, 0.5 * k, 1.2, 3); dots(9000, darker, 0.34 * k, 1.2, 3); dots(2500, tone(base, 0.7), 0.3 * k, 1, 2);
    } else if (kind === 'soil') {
      clouds(12, darker, 0.12 * k, 0.1, 0.3);
      dots(6000, lighter, 0.3 * k, 1.2, 3); dots(7000, darker, 0.36 * k, 1.2, 3.4);
    } else if (kind === 'grass') {
      const warm = mix(base, hex(dark ? '#3A4A2A' : '#E3EBA9'), 0.6);
      clouds(16, darker, 0.16 * k, 0.08, 0.26); clouds(14, lighter, 0.16 * k, 0.08, 0.26); clouds(8, warm, 0.14 * k, 0.06, 0.2);
      for (let i = 0; i < 7000; i++) { // short blades
        const x = R() * n, y = R() * n, l = (2 + R() * 4) * px, a = -Math.PI / 2 + (R() - 0.5) * 1.1;
        g.strokeStyle = css(R() < 0.5 ? lighter : darker, 0.2 * k);
        g.lineWidth = px;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
      }
    } else if (kind === 'water') {
      clouds(14, lighter, 0.2 * k, 0.08, 0.22); clouds(10, darker, 0.14 * k, 0.1, 0.25);
      g.lineCap = 'round';
      for (let i = 0; i < 70; i++) { // ripples
        const x = R() * n, y = R() * n, l = (14 + R() * 30) * px;
        g.strokeStyle = css(WHITE, (dark ? 0.08 : 0.34) * (0.5 + R() * 0.5));
        g.lineWidth = 1.4 * px;
        g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + l / 2, y - 3 * px, x + l, y); g.stroke();
      }
    } else if (kind === 'cobble') {
      // setts laid in arcs (Bogenpflaster): courses 10 cm apart, each a row of shallow arcs 1.2 m wide
      const m = n / TILE.cobble, W = 1.2 * m, s = 0.1 * m, rise = 0.27 * m, gap = 0.014 * m, rows = Math.round(n / s);
      g.fillStyle = css(tone(base, dark ? 0.74 : 0.83));
      g.fillRect(0, 0, n, n);
      const f = (x) => rise * (1 - Math.pow(2 * x / W - 1, 2)), S = 48, len = [0];
      for (let i = 1; i <= S; i++) len.push(len[i - 1] + Math.hypot(W / S, f(i * W / S) - f((i - 1) * W / S)));
      const N = Math.round(len[S] / (0.105 * m)), sl = len[S] / N;
      for (let row = -4; row < rows + 1; row++) for (let arc = 0; arc * W < n - 1; arc++) for (let i = 0; i < N; i++) {
        const want = (i + 0.5) * sl;
        let j = 1;
        while (j < S && len[j] < want) j++;
        const u = (j - 1 + (want - len[j - 1]) / (len[j] - len[j - 1])) / S, x = u * W, ang = Math.atan2(f(x + 1) - f(x - 1), 2);
        const h = hash3(((row % rows) + rows) % rows, arc, i), h2 = hash3(i, ((row % rows) + rows) % rows, arc + 7);
        const c = mix(tone(base, 0.95 + h * 0.1 * k), hex(dark ? '#3A3833' : '#D9CBB5'), h2 * 0.25);
        g.save();
        g.translate(arc * W + x, row * s + f(x) + s / 2);
        g.rotate(ang);
        g.fillStyle = css(c);
        const w = sl - gap, hh = s - gap, r = Math.min(w, hh) * 0.28;
        g.beginPath();
        if (g.roundRect) g.roundRect(-w / 2, -hh / 2, w, hh, r); else g.rect(-w / 2, -hh / 2, w, hh);
        g.fill();
        g.restore();
      }
      clouds(8, lighter, 0.06 * k, 0.1, 0.3);
    } else {
      // paving: slabs 90 × 60 cm in running bond
      const cols = 4, rows = 6, w = n / cols, h = n / rows;
      for (let j = 0; j < rows; j++) for (let i = -1; i <= cols; i++) {
        const t = hash3(((i % cols) + cols) % cols, j, 3), t2 = hash3(j, ((i % cols) + cols) % cols, 11);
        g.fillStyle = css(mix(tone(base, 0.972 + t * 0.05 * k), hex(dark ? '#34332F' : '#E6DCCB'), t2 * 0.3));
        g.fillRect(i * w + (j % 2) * w / 2, j * h, w, h);
      }
      dots(2600, lighter, 0.3 * k, 1, 2); dots(2600, darker, 0.16 * k, 1, 2);
      g.strokeStyle = css(tone(base, dark ? 0.72 : 0.86), 0.95);
      g.lineWidth = Math.max(1.5, n / 380);
      g.beginPath();
      for (let j = 0; j <= rows; j++) { g.moveTo(0, j * h); g.lineTo(n, j * h); }
      for (let j = 0; j < rows; j++) for (let i = 0; i <= cols; i++) { const x = i * w + (j % 2) * w / 2; g.moveTo(x, j * h); g.lineTo(x, (j + 1) * h); }
      g.stroke();
    }
    return cv;
  }

  // ---------- light ----------
  // shade(colour, normal, position, mode) → the colour a vertex gets. mode 1: glows by itself (untouched),
  // mode 2: already shaded by the shape (crowns), only the lamps are added at night.
  function makeShade(dark, L, lamps, lampCol) {
    return function (col, n, p, mode) {
      if (mode === 1) return col;
      const nL = lamps.length;
      let r = col[0], g = col[1], b = col[2];
      if (mode !== 2) {
        if (dark) { const m = 0.85 + 0.15 * (0.5 + 0.5 * n[2]); r *= m; g *= m; b *= m; }
        else {
          const t = sat((n[0] * L[0] + n[1] * L[1] + n[2] * L[2] + 0.2) / 0.95);
          let m = 0.865 + 0.135 * t + 0.03 * Math.max(0, n[2]);
          if (n[2] < 0) m *= 1 + 0.22 * n[2];
          const w = (t - 0.4) * 0.018; // a little warmer in the sun, cooler in the shade
          r *= m * (1 + w); g *= m; b *= m * (1 - w * 1.5);
        }
      }
      if (nL) {
        let w = 0;
        for (let i = 0; i < nL; i++) {
          const l = lamps[i], dx = l.x - p[0], dy = l.y - p[1], dz = l.z - p[2], d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= l.r2) continue;
          const f = 1 - d2 / l.r2, nl = (n[0] * dx + n[1] * dy + n[2] * dz) / Math.sqrt(d2 + 1e-4);
          w += f * f * (0.3 + 0.7 * Math.max(0, nl)) * l.k;
        }
        if (w > 0) {
          w = Math.min(w, 1.25);
          const k = 1 + 2.3 * w, s = sat(w * 1.2);
          r = r * k * lerp(1, lampCol[0] * 1.06, s) + 0.05 * w * lampCol[0];
          g = g * k * lerp(1, lampCol[1], s) + 0.05 * w * lampCol[1];
          b = b * k * lerp(1, lampCol[2] * 0.92, s) + 0.05 * w * lampCol[2];
        }
      }
      return [r, g, b];
    };
  }

  // ---------- shadows on the ground: dark, see-through shapes that lie on it ----------
  function groundZ(C, x, y, fallback) { const z = C.ground.at(x, y); return z == null ? (fallback == null ? C.z0 : fallback) : z; }
  // a soft round or oval shadow; the ground is followed point by point
  function blob(C, x, y, rx, ry, heading, alpha, zf) {
    const b = C.shadow, n = C.high ? 14 : 10, h = (heading || 0) * RAD, c = Math.cos(h), s = Math.sin(h), col = C.pal.shadow;
    const a = Math.min(0.6, alpha * C.pal.shadowAlpha);
    // the rim follows rising ground but never drops below the middle: beside a kerb it would vanish under the pavement
    const zc = groundZ(C, x, y, zf), i0 = b.vert([x, y, zc + 0.012], col, a);
    for (let ring = 0; ring < 2; ring++) for (let k = 0; k < n; k++) {
      const an = (k / n) * TAU, f = ring ? 1 : 0.55, lx = Math.cos(an) * rx * f, ly = Math.sin(an) * ry * f;
      const px = x + lx * c + ly * s, py = y - lx * s + ly * c;
      b.vert([px, py, Math.max(zc, groundZ(C, px, py, zf)) + 0.012], col, ring ? 0 : a * 0.8);
    }
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n, a0 = i0 + 1 + k, a1 = i0 + 1 + k1, b0 = i0 + 1 + n + k, b1 = i0 + 1 + n + k1;
      b.i.push(i0, a0, a1, a0, b0, b1, a0, b1, a1);
    }
  }
  // a band of shadow between two lines of points (inner: dark, outer: gone)
  function shadeStrip(C, inner, outer, alpha, zf, closed) {
    const b = C.shadow, col = C.pal.shadow, a = Math.min(0.6, alpha * C.pal.shadowAlpha), base = b.n, n = inner.length;
    for (let i = 0; i < n; i++) {
      b.vert([inner[i][0], inner[i][1], (inner[i][2] != null ? inner[i][2] : groundZ(C, inner[i][0], inner[i][1], zf)) + 0.01], col, a);
      b.vert([outer[i][0], outer[i][1], (outer[i][2] != null ? outer[i][2] : groundZ(C, outer[i][0], outer[i][1], zf)) + 0.01], col, 0);
    }
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const p = base + i * 2, q = base + ((i + 1) % n) * 2;
      b.i.push(p, q, q + 1, p, q + 1, p + 1, p, q + 1, q, p, p + 1, q + 1); // both windings: the side does not matter
    }
  }
  // a pool of lamp light on the ground (night)
  function pool(C, x, y, r, strength, zf) {
    const b = C.pool, n = 18, col = C.pal.lamp;
    const zc = groundZ(C, x, y, zf), i0 = b.vert([x, y, zc + 0.014], col, strength);
    const rings = [[0.3, 0.72], [0.62, 0.3], [1, 0]];
    rings.forEach((rg) => {
      for (let k = 0; k < n; k++) {
        const an = (k / n) * TAU, px = x + Math.cos(an) * r * rg[0], py = y + Math.sin(an) * r * rg[0];
        b.vert([px, py, Math.max(zc, groundZ(C, px, py, zf)) + 0.014], col, strength * rg[1]);
      }
    });
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      b.i.push(i0, i0 + 1 + k, i0 + 1 + k1);
      for (let rg = 0; rg < 2; rg++) { const a0 = i0 + 1 + rg * n + k, a1 = i0 + 1 + rg * n + k1; b.i.push(a0, a0 + n, a1 + n, a0, a1 + n, a1); }
    }
  }

  // ---------- surfaces ----------
  function triangulate(THREE, ring, holes) {
    const V2 = THREE.Vector2, c = ring.map((p) => new V2(p[0], p[1])), hs = (holes || []).map((h) => h.map((p) => new V2(p[0], p[1])));
    let f;
    try { f = THREE.ShapeUtils.triangulateShape(c, hs); } catch (e) { return []; }
    return f || [];
  }
  function ringsTouch(a, b) {
    const A = a.box, B = b.box;
    if (A[0] > B[2] || B[0] > A[2] || A[1] > B[3] || B[1] > A[3]) return false;
    for (const p of a.ring) if (inRing(b.ring, p[0], p[1])) return true;
    for (const p of b.ring) if (inRing(a.ring, p[0], p[1])) return true;
    const ca = centroid(a.ring), cb = centroid(b.ring);
    return inRing(b.ring, ca[0], ca[1]) || inRing(a.ring, cb[0], cb[1]);
  }
  // Read the surfaces: clean rings, a height per point, and the layer each lies in (a surface on top of another at
  // the same height is drawn a layer higher, so the two never flicker).
  function readSurfaces(C) {
    const out = [];
    (C.detail.surfaces || []).forEach((s, order) => {
      if (!s) return;
      const ring = cleanRing(s.ring);
      if (!ring) { if (s.ring) C.warn('surface ' + order + ': ring unusable'); return; }
      const zs = ring.keep.map((i) => (Array.isArray(s.zs) && isFinite(s.zs[i]) ? +s.zs[i] : or(s.z, 0)));
      const holes = (s.holes || []).map(cleanRing).filter(Boolean);
      // a plane through the ring, for the height of hole points
      let sx = 0, sy = 0, sz = 0;
      ring.forEach((p, i) => { sx += p[0]; sy += p[1]; sz += zs[i]; });
      const cx = sx / ring.length, cy = sy / ring.length, cz = sz / ring.length;
      let xx = 0, xy = 0, yy = 0, xz = 0, yz = 0;
      ring.forEach((p, i) => { const dx = p[0] - cx, dy = p[1] - cy, dz = zs[i] - cz; xx += dx * dx; xy += dx * dy; yy += dy * dy; xz += dx * dz; yz += dy * dz; });
      const det = xx * yy - xy * xy, pa = Math.abs(det) > 1e-9 ? (xz * yy - yz * xy) / det : 0, pb = Math.abs(det) > 1e-9 ? (yz * xx - xz * xy) / det : 0;
      const zAt = (x, y) => cz + pa * (x - cx) + pb * (y - cy);
      const kind = s.kind === 'tram-track' ? 'tram' : String(s.kind || 'paving');
      const rec = { src: s, order, kind, ring, zs, holes, zAt, box: boxOf(ring), zMean: cz, layer: 0 };
      for (const o of out) {
        if (!ringsTouch(o, rec)) continue;
        // the same height where they meet? (compared at a point both cover, so slopes do not mislead)
        const c = centroid(rec.ring), oc = centroid(o.ring), q = inRing(o.ring, c[0], c[1]) ? c : inRing(rec.ring, oc[0], oc[1]) ? oc : rec.ring.find((p) => inRing(o.ring, p[0], p[1])) || o.ring.find((p) => inRing(rec.ring, p[0], p[1])) || c;
        if (Math.abs(o.zAt(q[0], q[1]) - rec.zAt(q[0], q[1])) < 0.06) rec.layer = Math.max(rec.layer, o.layer + 1);
      }
      rec.layer = Math.min(rec.layer, 4);
      out.push(rec);
    });
    return out;
  }
  function groundBatch(C, kind, layer) {
    const key = kind + ':' + layer;
    let g = C.groundBatches.get(key);
    if (!g) { g = new Batch(false); g.uv = []; g.kind = kind; g.layer = layer; C.groundBatches.set(key, g); }
    return g;
  }
  function buildSurfaces(C, list) {
    const THREE = C.THREE;
    for (const s of list) {
      const all = s.ring.concat(...s.holes), zOf = (i) => (i < s.ring.length ? s.zs[i] : s.zAt(all[i][0], all[i][1])) + s.layer * 0.003;
      const tris = triangulate(THREE, s.ring, s.holes);
      if (!tris.length) { C.warn('surface ' + s.order + ': could not be triangulated'); continue; }
      const crossing = s.kind === 'crossing';
      if (!crossing) {
        const kind = TEXTURED[s.kind] ? s.kind : 'paving';
        const b = groundBatch(C, kind, s.layer), tile = TILE[kind];
        // the pattern runs along the surface: its own heading, or the direction most of its edges have
        const grain = kind === 'paving' || kind === 'cobble' ? (num(s.src.heading) != null ? (90 - s.src.heading) * RAD : grainOf(s.ring)) : 0.4;
        const ca = Math.cos(grain), sa = Math.sin(grain), base = b.n;
        // what the surface is used for sets its tone: roads a shade darker, pavements and squares warmer
        const use = String(s.src.use || ''); let tint = /road|street|carriage|fahrbahn/.test(use) ? [0.945, 0.945, 0.955] : /pavement|sidewalk|footway|trottoir/.test(use) ? [1.0, 0.992, 0.975] : /island|insel/.test(use) ? [1.02, 1.01, 0.99] : [1, 1, 1];
        const given = !C.dark && hex(s.src.color), base0 = C.pal[kind]; // a colour from the data shifts the tone a little, the palette stays in charge
        if (given) { const want = mix(base0, given, 0.17); for (let k = 0; k < 3; k++) tint[k] = want[k] / Math.max(0.05, base0[k]); }
        all.forEach((p, i) => {
          b.vert([p[0], p[1], zOf(i)], tint);
          b.uv.push((p[0] * ca + p[1] * sa) / tile, (-p[0] * sa + p[1] * ca) / tile);
        });
        for (const t of tris) {
          const A = all[t[0]], B = all[t[1]], D = all[t[2]];
          const cr = (B[0] - A[0]) * (D[1] - A[1]) - (B[1] - A[1]) * (D[0] - A[0]);
          if (Math.abs(cr) < 1e-9) continue;
          if (cr > 0) b.i.push(base + t[0], base + t[1], base + t[2]); else b.i.push(base + t[0], base + t[2], base + t[1]);
        }
      }
      for (const t of tris) {
        const P = (i) => [all[i][0], all[i][1], zOf(i)];
        if (!crossing || C.ground.at(all[t[0]][0], all[t[0]][1]) == null) C.ground.add(P(t[0]), P(t[1]), P(t[2]), s.layer);
      }
      C.counts.surfaces++;
      // a skirt down from every edge: where the neighbour lies lower, the step has a face
      if (!crossing) {
        const col = tone(C.pal[TEXTURED[s.kind] ? s.kind : 'paving'], C.dark ? 0.78 : 0.84), W = C.W.solid.world();
        const skirt = (r, zf, out) => {
          for (let i = 0; i < r.length; i++) {
            const a = r[i], b = r[(i + 1) % r.length], za = zf(i), zb = zf((i + 1) % r.length);
            const nx = (b[1] - a[1]) * out, ny = -(b[0] - a[0]) * out;
            W.quad([a[0], a[1], za], [b[0], b[1], zb], [b[0], b[1], zb - 0.4], [a[0], a[1], za - 0.4], col, { n: [nx, ny, 0] });
          }
        };
        skirt(s.ring, (i) => s.zs[i] + s.layer * 0.003, 1);
        s.holes.forEach((h) => skirt(h, (i) => s.zAt(h[i][0], h[i][1]) + s.layer * 0.003, -1));
      }
      if (s.kind === 'tram') rails(C, s);
      if (crossing) stripes(C, s);
    }
  }
  // a flat band along a line, lying on the ground (rails, markings): into the decal batch
  function band(C, line, off, half, col, lift, mode) {
    const W = C.W.decal.world(), fr = lineFrames(line, false);
    for (let i = 0; i + 1 < fr.length; i++) {
      const a = fr[i], b = fr[i + 1];
      const p = [offPt(a, off - half), offPt(b, off - half), offPt(b, off + half), offPt(a, off + half)].map((q) => [q[0], q[1], groundZ(C, q[0], q[1]) + lift]);
      W.quad(p[0], p[1], p[2], p[3], col, { n: [0, 0, 1], mode });
    }
  }
  // split a line so no piece is longer than `step` (so bands follow sloping ground)
  function densify(line, step) {
    const out = [line[0]];
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i], b = line[i + 1], k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
      for (let j = 1; j <= k; j++) out.push([lerp(a[0], b[0], j / k), lerp(a[1], b[1], j / k)]);
    }
    return out;
  }
  // Where the rails of a tram-track surface run: its own centre line, else worked out from the outline
  function trackLine(s) {
    const own = s.src.line && cleanLine(s.src.line);
    if (own) return { line: own, width: num(s.src.width) };
    const r = s.ring, n = r.length;
    if (n >= 4 && n % 2 === 0) { // a ribbon: the points of one side, then those of the other going back
      let best = null;
      for (let k = 0; k < n / 2; k++) {
        const mids = [], ws = [];
        for (let i = 0; i < n / 2; i++) { const a = r[(k + i) % n], b = r[(k - 1 - i + 2 * n) % n]; mids.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); ws.push(Math.hypot(a[0] - b[0], a[1] - b[1])); }
        const wMin = Math.min(...ws), wMax = Math.max(...ws);
        let len = 0;
        for (let i = 0; i + 1 < mids.length; i++) len += Math.hypot(mids[i + 1][0] - mids[i][0], mids[i + 1][1] - mids[i][1]);
        if (wMin < 1 || wMax / wMin > 1.5 || len < wMax * 1.5) continue;
        if (!best || len > best.len) best = { line: mids, width: (wMin + wMax) / 2, len };
      }
      if (best) return best;
    }
    const ax = longAxis(r), vm = (ax.v0 + ax.v1) / 2;
    return { line: [[ax.ux * ax.u0 - ax.uy * vm, ax.uy * ax.u0 + ax.ux * vm], [ax.ux * ax.u1 - ax.uy * vm, ax.uy * ax.u1 + ax.ux * vm]], width: ax.wid };
  }
  function rails(C, s) {
    const t = trackLine(s);
    if (!t || !t.line || t.line.length < 2) return;
    const line = densify(t.line, 3), width = t.width || 2.6, gauge = or(s.src.gauge, 1.0);
    const tracks = clamp(Math.round(or(s.src.tracks, width / 3.3)), 1, 4), pitch = width / tracks;
    const steel = C.pal.rail, groove = tone(C.pal.rail, C.dark ? 0.5 : 0.62), edge = mix(C.pal.tram, BLACK, C.dark ? 0.2 : 0.1);
    for (let k = 0; k < tracks; k++) {
      const c = (k - (tracks - 1) / 2) * pitch;
      for (const side of [-1, 1]) {
        const o = c + side * gauge / 2;
        band(C, line, o, 0.075, edge, 0.004);            // the joint of the rail in the paving
        band(C, line, o + side * 0.012, 0.03, steel, 0.006); // the head you see shine
        band(C, line, o - side * 0.028, 0.014, groove, 0.007); // the groove the flange runs in
      }
    }
  }
  // a pedestrian crossing: yellow bars (this is Switzerland), each as long as the crossing is wide
  function stripes(C, s) {
    const dir = num(s.src.heading) != null ? (90 - s.src.heading) * RAD : null;
    const ax = longAxis(s.ring, dir), W = C.W.decal.world(), col = C.pal.marking;
    const n = Math.max(1, Math.floor((ax.len + 0.5) / 1)), start = ax.u0 + (ax.len - (n - 0.5)) / 2;
    for (let i = 0; i < n; i++) {
      const u0 = start + i, u1 = u0 + 0.5;
      // the part of the ring between u0 and u1 along the walking direction
      let poly = clipPoly(s.ring, ax.ux, ax.uy, -u0);
      poly = clipPoly(poly, -ax.ux, -ax.uy, u1);
      if (poly.length < 3) continue;
      for (const t of triangulate(C.THREE, poly)) {
        const P = (j) => [poly[j][0], poly[j][1], groundZ(C, poly[j][0], poly[j][1], s.zAt(poly[j][0], poly[j][1])) + 0.006];
        W.tri(P(t[0]), P(t[1]), P(t[2]), col, { n: [0, 0, 1], mode: 1 });
      }
    }
  }
  // The plain ground under everything: the outline of the stretch, a little below the lowest surface and
  // following the general slope; beyond the outline it fades out.
  function basePlate(C, list) {
    const area = cleanRing(C.detail.area);
    let n = 0, sx = 0, sy = 0, sz = 0;
    const pts = [];
    for (const s of list) s.ring.forEach((p, i) => { pts.push([p[0], p[1], s.zs[i]]); sx += p[0]; sy += p[1]; sz += s.zs[i]; n++; });
    if (!n) { C.plane = () => C.z0; if (!area) return; }
    else {
      const cx = sx / n, cy = sy / n, cz = sz / n;
      let xx = 0, xy = 0, yy = 0, xz = 0, yz = 0;
      for (const p of pts) { const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz; xx += dx * dx; xy += dx * dy; yy += dy * dy; xz += dx * dz; yz += dy * dz; }
      const det = xx * yy - xy * xy, ok = Math.abs(det) > 1e-6 * Math.max(1, xx * yy);
      const a = ok ? (xz * yy - yz * xy) / det : 0, b = ok ? (yz * xx - xz * xy) / det : 0;
      let drop = 0;
      for (const p of pts) drop = Math.max(drop, cz + a * (p[0] - cx) + b * (p[1] - cy) - p[2]);
      C.plane = (x, y) => cz + a * (x - cx) + b * (y - cy) - drop - 0.03;
      C.z0 = cz;
    }
    if (!area) return;
    const W = C.W.solid.world(), col = C.pal.ground;
    const P = (p) => [p[0], p[1], C.plane(p[0], p[1])];
    for (const t of triangulate(C.THREE, area)) {
      W.tri(P(area[t[0]]), P(area[t[1]]), P(area[t[2]]), col, { n: [0, 0, 1], mode: 1 });
      C.ground.add(P(area[t[0]]), P(area[t[1]]), P(area[t[2]]), -1);
    }
    const f = or(C.opts.feather, 5);
    if (f > 0) {
      const fr = lineFrames(area, true), b = C.feather, base = b.n;
      fr.forEach((q) => { const o = offPt(q, -f); b.vert(P(q.p), col, 1); b.vert(P(o), col, 0); });
      for (let i = 0; i < fr.length; i++) { const p = base + i * 2, q = base + ((i + 1) % fr.length) * 2; b.i.push(p, p + 1, q + 1, p, q + 1, q); }
    }
  }

  // ---------- edges: kerbs, ledges, walls, fences, railings, hedges, steps ----------
  // A solid strip along a line: a top, a face on each side down to the ground there, closed ends.
  // st[i] = { f: frame, top, gl, gr } with gl / gr the ground left and right. o: { w, top, face, arris, lip }
  function strip(C, st, closed, o) {
    const W = C.W.solid.world(), n = st.length, h = o.w / 2;
    const L = st.map((s) => offPt(s.f, h)), R = st.map((s) => offPt(s.f, -h));
    const faceCols = [o.face, o.face, tone(o.face, 0.84), tone(o.face, 0.84)];
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const j = (i + 1) % n, a = st[i], b = st[j];
      const dx = b.f.p[0] - a.f.p[0], dy = b.f.p[1] - a.f.p[1], ln = [-dy, dx, 0];
      W.quad([R[i][0], R[i][1], a.top], [R[j][0], R[j][1], b.top], [L[j][0], L[j][1], b.top], [L[i][0], L[i][1], a.top], o.top, { n: [0, 0, 1] });
      if (o.walk && a.top - Math.min(a.gl, a.gr) < 0.3) { // low enough to step on: part of the ground
        const A = [R[i][0], R[i][1], a.top], B = [R[j][0], R[j][1], b.top], D = [L[j][0], L[j][1], b.top], E = [L[i][0], L[i][1], a.top];
        o.walk.push([A, B, D], [A, D, E]);
      }
      for (const side of [1, -1]) {
        const E = side > 0 ? L : R, ga = side > 0 ? a.gl : a.gr, gb = side > 0 ? b.gl : b.gr;
        if (a.top - ga < 0.012 && b.top - gb < 0.012) continue;
        const hint = [ln[0] * side, ln[1] * side, 0];
        W.quad([E[i][0], E[i][1], a.top], [E[j][0], E[j][1], b.top], [E[j][0], E[j][1], gb - 0.06], [E[i][0], E[i][1], ga - 0.06], faceCols, { n: hint });
        if (o.arris) { // the light edge that makes a low step readable from eye height
          const I = st.map((s) => offPt(s.f, side * (h - o.arris)));
          W.quad([E[i][0], E[i][1], a.top + 0.002], [E[j][0], E[j][1], b.top + 0.002], [I[j][0], I[j][1], b.top + 0.002], [I[i][0], I[i][1], a.top + 0.002], o.arrisCol, { n: [0, 0, 1] });
        }
        if (o.shadow) {
          const O = st.map((s) => offPt(s.f, side * (h + o.shadow)));
          shadeStrip(C, [[E[i][0], E[i][1], ga], [E[j][0], E[j][1], gb]], [[O[i][0], O[i][1], ga], [O[j][0], O[j][1], gb]], o.shadowA || 1.3);
        }
      }
    }
    if (!closed) for (const e of [0, n - 1]) {
      const s = st[e], t = s.f.t, sign = e ? 1 : -1;
      W.quad([L[e][0], L[e][1], s.top], [R[e][0], R[e][1], s.top], [R[e][0], R[e][1], s.gr - 0.06], [L[e][0], L[e][1], s.gl - 0.06], o.face, { n: [t[0] * sign, t[1] * sign, 0] });
    }
  }
  function buildEdge(C, e) {
    const closed = !!e.closed, pts = cleanLine(e.line, closed);
    if (!pts) return;
    const pal = C.pal, kind = e.kind, ez = num(e.z);
    C.counts.edges++;
    if (kind === 'steps') return steps(C, e, pts);
    if (kind === 'fence' || kind === 'railing') return fence(C, e, pts, closed);
    if (kind === 'hedge') return hedge(C, e, pts, closed);
    const w = or(e.width, kind === 'kerb' ? 0.2 : kind === 'wall' ? 0.3 : 0.35);
    const hgt = or(e.height, kind === 'kerb' ? 0.12 : kind === 'wall' ? 1.0 : 0.4);
    // finer along the line, so the strip follows sloping ground
    const fr = lineFrames(closed ? pts : densify(pts, 4), closed);
    const st = fr.map((f) => {
      const l = offPt(f, w / 2 + 0.12), r = offPt(f, -w / 2 - 0.12);
      let gl = C.ground.at(l[0], l[1]), gr = C.ground.at(r[0], r[1]);
      if (gl == null && gr == null) gl = gr = ez != null ? ez : C.z0;
      else if (gl == null) gl = gr; else if (gr == null) gr = gl;
      let top;
      if (kind === 'kerb') {
        if (Math.abs(gl - gr) >= 0.02) top = Math.max(gl, gr) + 0.004;       // a step in the ground: the kerb is its face
        else if (ez != null && Math.abs(ez - hgt - Math.min(gl, gr)) < 0.035) top = ez; // z given as the top
        else top = Math.min(gl, gr) + hgt;                                   // flat ground: a kerb stone standing on it
      } else top = (ez != null ? ez : Math.min(gl, gr)) + hgt;
      return { f, top, gl: Math.min(gl, top), gr: Math.min(gr, top) };
    });
    if (kind === 'kerb') {
      // the higher the step, the wider the dark line at its foot: that is what you see of it from the upper side
      const step = st.reduce((m, q) => Math.max(m, q.top - Math.min(q.gl, q.gr)), 0), c = pal.kerb;
      strip(C, st, closed, { w, top: mix(c, WHITE, C.dark ? 0.06 : 0.22), face: tone(c, C.dark ? 0.8 : 0.84), arris: Math.min(0.03, w * 0.3), arrisCol: mix(c, WHITE, C.dark ? 0.3 : 0.75), shadow: clamp(0.1 + 1.5 * step, 0.14, 0.42), shadowA: 1.8, walk: C.walk });
    } else if (kind === 'wall') {
      const c = pal.stone, capH = Math.min(0.09, hgt * 0.25);
      strip(C, st.map((s) => ({ f: s.f, top: s.top - capH, gl: s.gl, gr: s.gr })), closed, { w, top: c, face: tone(c, 0.94), shadow: 0.3, shadowA: 1.3 });
      strip(C, st.map((s) => ({ f: s.f, top: s.top, gl: s.top - capH, gr: s.top - capH })), closed, { w: w + 0.07, top: mix(c, WHITE, C.dark ? 0.1 : 0.4), face: mix(c, WHITE, C.dark ? 0.03 : 0.12), arris: 0.025, arrisCol: mix(c, WHITE, C.dark ? 0.3 : 0.8) });
    } else { // ledge, and anything unknown that has a line: a plain stone block
      const c = pal.stone;
      strip(C, st, closed, { w, top: mix(c, WHITE, C.dark ? 0.08 : 0.3), face: tone(c, 0.9), arris: Math.min(0.03, w * 0.25), arrisCol: mix(c, WHITE, C.dark ? 0.3 : 0.8), shadow: 0.24, shadowA: 1.5, walk: C.walk });
    }
  }
  function steps(C, e, pts) {
    const W = C.W.solid.world(), pal = C.pal, hgt = or(e.height, 0.48), width = or(e.width, Math.max(0.3, hgt / 0.16 * 0.3));
    const fr = lineFrames(pts, false), n = Math.max(1, Math.round(hgt / 0.165)), rh = hgt / n, td = width / n;
    // which way they climb: said in the data, else towards the higher ground, else to the left of the line
    let side = e.side === 'right' ? -1 : e.side === 'left' ? 1 : 0;
    if (!side) {
      const m = fr[Math.floor(fr.length / 2)], l = offPt(m, width + 0.3), r = offPt(m, -width - 0.3);
      const zl = C.ground.at(l[0], l[1]), zr = C.ground.at(r[0], r[1]);
      side = zl != null && zr != null && zr > zl + 0.05 ? -1 : 1;
    }
    const z0 = fr.map((f) => { const q = offPt(f, -side * 0.15); return num(e.z) != null ? e.z : groundZ(C, q[0], q[1]); });
    const tread = mix(pal.stone, WHITE, C.dark ? 0.08 : 0.3), riser = tone(pal.stone, C.dark ? 0.8 : 0.8), nose = mix(pal.stone, WHITE, C.dark ? 0.3 : 0.8);
    const at = (i, k, z) => { const q = offPt(fr[i], side * k * td); return [q[0], q[1], z0[i] + z]; };
    for (let i = 0; i + 1 < fr.length; i++) {
      const dx = fr[i + 1].p[0] - fr[i].p[0], dy = fr[i + 1].p[1] - fr[i].p[1], down = [dy * side, -dx * side, 0];
      for (let k = 0; k < n; k++) {
        W.quad(at(i, k, k * rh), at(i + 1, k, k * rh), at(i + 1, k, (k + 1) * rh), at(i, k, (k + 1) * rh), [tone(riser, 0.9), tone(riser, 0.9), riser, riser], { n: down });
        W.quad(at(i, k, (k + 1) * rh), at(i + 1, k, (k + 1) * rh), at(i + 1, k + 1, (k + 1) * rh), at(i, k + 1, (k + 1) * rh), tread, { n: [0, 0, 1] });
        const a = (ii) => { const q = offPt(fr[ii], side * (k * td + 0.035)); return [q[0], q[1], z0[ii] + (k + 1) * rh + 0.002]; };
        W.quad([at(i, k, 0)[0], at(i, k, 0)[1], z0[i] + (k + 1) * rh + 0.002], [at(i + 1, k, 0)[0], at(i + 1, k, 0)[1], z0[i + 1] + (k + 1) * rh + 0.002], a(i + 1), a(i), nose, { n: [0, 0, 1] });
      }
      // walking on them: a ramp from the first to the last edge
      const A = at(i, 0, 0), B = at(i + 1, 0, 0), D = at(i + 1, n, hgt), E = at(i, n, hgt);
      C.ground.add(A, B, D, 9); C.ground.add(A, D, E, 9);
      const O = [offPt(fr[i], -side * 0.2), offPt(fr[i + 1], -side * 0.2)];
      shadeStrip(C, [[A[0], A[1], A[2]], [B[0], B[1], B[2]]], [[O[0][0], O[0][1], A[2]], [O[1][0], O[1][1], B[2]]], 1.2);
    }
    for (const i of [0, fr.length - 1]) { // the cheeks at both ends
      const t = fr[i].t, sign = i ? 1 : -1;
      for (let k = 0; k < n; k++) W.quad(at(i, k, -0.1), at(i, k + 1, -0.1), at(i, k + 1, (k + 1) * rh), at(i, k, (k + 1) * rh), tone(pal.stone, 0.9), { n: [t[0] * sign, t[1] * sign, 0] });
    }
  }
  function fence(C, e, pts, closed) {
    const W = C.W.solid.world(), pal = C.pal, rail = e.kind === 'railing';
    const hgt = or(e.height, rail ? 1.0 : 1.2), wood = /wood|picket|holz/i.test(e.variant || '');
    const col = wood ? pal.wood : pal.metal, light = mix(col, WHITE, C.dark ? 0.06 : 0.18);
    const posts = walkLine(pts, rail ? 1.5 : 2.2, closed);
    const zf = (p) => (num(e.z) != null ? e.z : groundZ(C, p[0], p[1]));
    const pw = wood ? 0.05 : rail ? 0.022 : 0.03;
    const list = closed ? posts.concat([Object.assign({}, posts[0])]) : posts;
    for (let i = 0; i < list.length; i++) {
      const a = list[i], za = zf(a.p);
      if (!(closed && i === list.length - 1)) {
        if (rail) W.cyl(a.p[0], a.p[1], za, za + hgt, pw, pw, 5, col);
        else W.box(a.p[0] - pw, a.p[1] - pw, za, a.p[0] + pw, a.p[1] + pw, za + hgt + (wood ? 0.06 : 0.1), col, { top: light });
        blob(C, a.p[0], a.p[1], 0.14, 0.14, 0, 0.9, za);
      }
      if (i + 1 >= list.length) continue;
      const b = list[i + 1], zb = zf(b.p);
      const dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1], l = Math.hypot(dx, dy);
      if (l < 1e-4) continue;
      const lat = [-dy / l, dx / l, 0];
      const bar = (z, th, tw, c) => W.obox([(a.p[0] + b.p[0]) / 2, (a.p[1] + b.p[1]) / 2, (za + zb) / 2 + z], [dx / 2, dy / 2, (zb - za) / 2], mul3(lat, tw), [0, 0, th], c, { skip: '+x-x' });
      if (rail) { bar(hgt, 0.028, 0.028, light); bar(hgt * 0.52, 0.016, 0.016, col); bar(0.12, 0.016, 0.016, col); }
      else {
        bar(hgt - 0.08, 0.025, wood ? 0.02 : 0.016, light); bar(0.18, 0.025, wood ? 0.02 : 0.016, col);
        const gap = wood ? 0.14 : C.high ? 0.13 : 0.26, k = Math.max(1, Math.round(l / gap)), half = wood ? 0.045 : 0.011;
        for (let j = 1; j < k + (wood ? 1 : 0); j++) {
          const f = (j - (wood ? 0.5 : 0)) / k, x = lerp(a.p[0], b.p[0], f), y = lerp(a.p[1], b.p[1], f), z = lerp(za, zb, f);
          const tx = dx / l * half, ty = dy / l * half, top = z + hgt + (wood ? 0.04 : 0.06);
          W.quad([x - tx, y - ty, z + 0.1], [x + tx, y + ty, z + 0.1], [x + tx, y + ty, top], [x - tx, y - ty, top], col, { two: true, n: lat });
        }
      }
    }
  }
  function leaf(C, q) { // a leaf colour: 0 deep in the shade, 1 in the sun
    const p = C.pal;
    return q < 0.5 ? mix(p.crownDark, p.crown, smooth(0, 0.5, q)) : mix(p.crown, p.crownLight, smooth(0.5, 1, q));
  }
  function hedge(C, e, pts, closed) {
    const W = C.W.crown.world(), hgt = or(e.height, 1.1), w = or(e.width, 0.7), L = C.sun;
    const st = walkLine(pts, 0.7, closed), prof = [[-0.5, 0.0], [-0.53, 0.55], [-0.36, 0.92], [0, 1.02], [0.36, 0.92], [0.53, 0.55], [0.5, 0.0]];
    const base = W.b.n, m = prof.length, hc = C.pal.hedge;
    const rows = closed ? st.filter((s) => !s.last) : st;
    rows.forEach((s) => {
      const z = num(e.z) != null ? e.z : groundZ(C, s.p[0], s.p[1]), lx = -s.t[1], ly = s.t[0];
      prof.forEach((q, k) => {
        const nz = noise3(s.p[0] * 1.7 + k, s.p[1] * 1.7, k * 0.6), d = 1 + (nz - 0.5) * 0.16;
        const P = [s.p[0] + lx * q[0] * w * d, s.p[1] + ly * q[0] * w * d, z + q[1] * hgt * (k === 0 || k === m - 1 ? 1 : d)];
        const n = norm([lx * q[0] * 2, ly * q[0] * 2, (q[1] - 0.45) * 1.6]);
        const t = sat(0.5 + 0.5 * dot(n, L)) * 0.6 + q[1] * 0.3 + (nz - 0.5) * 0.3;
        W.b.vert(P, W.shade(mix(hc, leaf(C, sat(t)), 0.6), n, P, 2));
      });
    });
    const nr = rows.length;
    for (let i = 0; i < (closed ? nr : nr - 1); i++) for (let k = 0; k + 1 < m; k++) {
      const a = base + i * m + k, b = base + ((i + 1) % nr) * m + k;
      W.b.i.push(a, b, b + 1, a, b + 1, a + 1);
    }
    if (!closed) for (const i of [0, nr - 1]) for (let k = 1; k + 1 < m; k++) { const a = base + i * m; if (i) W.b.i.push(a, a + k + 1, a + k); else W.b.i.push(a, a + k, a + k + 1); }
    const fr = lineFrames(pts, closed);
    for (const side of [1, -1]) shadeStrip(C, fr.map((f) => offPt(f, side * w * 0.5)), fr.map((f) => offPt(f, side * (w * 0.5 + 0.45))), 1.1, num(e.z), closed);
  }

  // ---------- trees ----------
  const GENUS = { aesculus: [-0.07, 0], tilia: [0.03, 0.3], platanus: [0.02, 0.5], acer: [0.04, 0.4], quercus: [-0.05, 0.1], fagus: [-0.02, 0.2], betula: [0.07, 0.6], carpinus: [-0.03, 0], fraxinus: [0.02, 0.2], robinia: [0.05, 0.5], prunus: [0.03, 0.3], ginkgo: [0.06, 0.7] };
  // a branch and what grows from it; env(p) says whether a point is still inside the crown
  function grow(W, C, R, p, d, len, rad, depth, maxDepth, env, col) {
    const side = norm(cross(d, Math.abs(d[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1])), up = cross(side, d), bend = len * 0.09 * (R() - 0.5) * 2;
    const mid = [p[0] + d[0] * len * 0.5 + side[0] * bend, p[1] + d[1] * len * 0.5 + side[1] * bend, p[2] + d[2] * len * 0.5 + len * 0.03];
    const end = [p[0] + d[0] * len, p[1] + d[1] * len, p[2] + d[2] * len + len * 0.06];
    const sides = depth === 0 ? (C.high ? 6 : 5) : depth === 1 ? (C.high ? 5 : 4) : 3;
    const c = mix(col, C.pal.stone, Math.min(0.3, depth * 0.07));
    if (depth <= 1) W.tube([[p[0], p[1], p[2], rad], [mid[0], mid[1], mid[2], rad * 0.8], [end[0], end[1], end[2], rad * 0.6]], sides, c);
    else W.tube([[p[0], p[1], p[2], rad], [end[0], end[1], end[2], rad * 0.5]], sides, c);
    if (depth >= maxDepth || rad < 0.012) return;
    const kids = depth === 0 ? 3 : 2 + (C.high && R() < 0.45 ? 1 : 0);
    for (let i = 0; i < kids; i++) {
      const az = (i / kids) * TAU + R() * 1.6, tilt = i === 0 ? 0.16 + R() * 0.22 : 0.45 + R() * 0.45;
      const ca = Math.cos(az) * Math.sin(tilt), sa = Math.sin(az) * Math.sin(tilt), ct = Math.cos(tilt);
      const nd = norm([d[0] * ct + side[0] * ca + up[0] * sa, d[1] * ct + side[1] * ca + up[1] * sa, d[2] * ct + side[2] * ca + up[2] * sa + 0.16]);
      const f = i === 0 ? 1 : 0.45 + R() * 0.55, start = [lerp(mid[0], end[0], f), lerp(mid[1], end[1], f), lerp(mid[2], end[2], f)];
      let l2 = len * (0.62 + R() * 0.2);
      if (!env([start[0] + nd[0] * l2, start[1] + nd[1] * l2, start[2] + nd[2] * l2])) {
        l2 *= 0.55;
        if (!env([start[0] + nd[0] * l2, start[1] + nd[1] * l2, start[2] + nd[2] * l2])) continue;
      }
      grow(W, C, R, start, nd, l2, rad * (i === 0 ? 0.6 : 0.46), depth + 1, maxDepth, env, col);
    }
  }
  function buildTree(C, t) {
    const xy = t.xy;
    if (!xy || !isFinite(xy[0]) || !isFinite(xy[1])) return;
    const x = +xy[0], y = +xy[1], R = rng(seedOf(x, y, 1)), pal = C.pal, L = C.sun;
    const z0 = num(t.z) != null ? t.z : groundZ(C, x, y);
    const kind = t.kind === 'conifer' || t.kind === 'columnar' ? t.kind : 'broadleaf';
    const H = clamp(or(t.height, kind === 'columnar' ? 12 : 9), 1.5, 60);
    const cr = clamp(or(t.crown, H * (kind === 'conifer' ? 0.2 : kind === 'columnar' ? 0.13 : 0.32)), 0.4, 25);
    const age = num(t.planted) != null ? clamp(2026 - t.planted, 3, 160) : null;
    const tr = clamp(or(t.trunk, age != null ? clamp(0.07 + age * 0.0034, 0.08, 0.5) : clamp(H * 0.022, 0.07, 0.5)), 0.03, 1.5);
    let cb = or(t.crownBase, kind === 'broadleaf' ? clamp(H * 0.3, 2.2, 5) : kind === 'conifer' ? clamp(H * 0.12, 0.8, 2.5) : clamp(H * 0.15, 1.5, 3));
    if (C.path && lineDist(C.path, x, y) < cr + 1.2) cb = Math.max(cb, C.clearance); // nothing hangs into the walk at eye height
    cb = clamp(cb, 0.3, H * 0.7);
    // the season of the scene wins over what the data says about one tree
    const leaves = C.season === 'summer' ? true : C.season === 'winter' ? false : t.leaves !== false;
    // pollarded: cut back every year to the same knuckles (form: "pollard" or pollarded: true in the data)
    const pollard = kind === 'broadleaf' && (C.opts.pollard != null ? !!C.opts.pollard : t.pollarded === true || /pollard|kopf|knob|knuckle/i.test(String(t.form || t.pruning || t.shape || t.variant || '')));
    const c = (H - cb) / 2, zc = (cb + H) / 2;
    const lx = (R() - 0.5) * 0.05 * H, ly = (R() - 0.5) * 0.05 * H;
    C.counts.trees++;

    // trunk: a wide foot, a slight taper and lean
    const W = C.W.solid.frame(x, y, z0, 0);
    const bark = mix(tone(pal.trunk, 0.94 + R() * 0.12), pal.stone, R() * 0.18), seg = C.high ? 8 : 6;
    const topZ = pollard ? cb + 0.1 : leaves ? cb + c * 0.7 : cb + c * 0.25;
    const tp = [[0, 0, -0.15, tr * 1.5], [0, 0, 0.1, tr * 1.28], [0, 0, 0.55, tr * 1.03], [lx * 0.3, ly * 0.3, cb * 0.6, tr * 0.93], [lx * 0.6, ly * 0.6, cb - (pollard ? 0.5 : 0), tr * (pollard ? 0.9 : 0.84)], [pollard ? lx * 0.6 : lx, pollard ? ly * 0.6 : ly, topZ, tr * (pollard ? 0.95 : leaves ? 0.45 : 0.62)]];
    W.tube(tp, seg, bark, { cols: tp.map((p, i) => tone(bark, i < 2 ? 0.8 : i < 3 ? 0.9 : 1)), cap: true });
    blob(C, x, y, tr * 3.6, tr * 3.6, 0, 1.5, z0);
    const sh = norm([-L[0], -L[1], 0]), far = leaves ? 0.28 : 0.22;
    blob(C, x + sh[0] * cr * far, y + sh[1] * cr * far, cr * 1.05, cr * 1.05, 0, leaves ? (C.dark ? 0.55 : 1.0) : pollard ? 0.62 : 0.42, z0);

    const env = (p) => { const dx = (p[0] - lx) / cr, dy = (p[1] - ly) / cr, dz = (p[2] - zc) / (c * 1.03); return dx * dx + dy * dy + dz * dz <= 1; };
    const limbs = (n, maxDepth, len0) => {
      for (let i = 0; i < n; i++) {
        const az = (i / n) * TAU + R() * 0.9, tilt = 0.5 + R() * 0.4, zs = cb - 0.45 + R() * Math.min(1.0, c * 0.4);
        const d = [Math.cos(az) * Math.sin(tilt), Math.sin(az) * Math.sin(tilt), Math.cos(tilt)];
        grow(W, C, R, [lx * 0.6, ly * 0.6, zs], d, len0 * (0.85 + R() * 0.3), tr * 0.5, 0, maxDepth, env, bark);
      }
    };
    // a tint per tree and species, so a row of trees is not a row of copies
    const g = GENUS[String(t.species || '').split(' ')[0].toLowerCase()] || [0, R()];
    const bright = 1 + g[0] + (R() - 0.5) * 0.07, warm = hex(C.dark ? '#3D4A2C' : '#C8D989'), cool = hex(C.dark ? '#254036' : '#93CDA4'), hue = (g[1] - 0.5) * 0.3;
    const tint = (col) => tone(mix(col, hue > 0 ? warm : cool, Math.abs(hue)), bright);
    const WC = C.W.crown.frame(x, y, z0, 0), amp = C.high ? 0.11 : 0.08;
    const lobe = (cx, cy, cz, rx, rz, bias, coneCol, ff) => {
      const s = seedOf(x + cx, y + cy, Math.round(cz * 10));
      bias += ((s % 1000) / 1000 - 0.5) * 0.2; // every lobe its own tone, so the crown reads as a cluster
      WC.lump([cx, cy, cz], [rx, rx, rz], ff || C.lobeF, amp, s, (P, n) => {
        const hz = sat((P[2] - z0 - cb) / (H - cb)), rim = sat(Math.hypot(P[0] - x - lx, P[1] - y - ly) / cr);
        const sun = C.dark ? 0.5 + 0.3 * n[2] : sat(0.5 + 0.5 * dot(n, L));
        // lighter towards the sun, the top and the outside of the crown; deep inside and underneath it is dark
        let q = 0.44 * sun + 0.3 * hz + 0.2 * rim * rim + bias + (noise3(P[0] * 0.8, P[1] * 0.8, P[2] * 0.8) - 0.5) * 0.24;
        if (n[2] < 0) q += 0.16 * n[2];
        const cl = q < 0 ? tone(pal.crownDark, 1 + Math.max(-0.5, q) * 0.36) : leaf(C, sat(q));
        return tint(coneCol ? mix(cl, coneCol, 0.6) : cl);
      }, 2);
    };
    if (pollard) {
      // A pollarded tree: a boss on the trunk, a few stout kinked limbs that fork, a knuckle at every end;
      // from the knuckles the thin shoots of one year (or, in summer, a tuft of leaves).
      const shoot = Math.min(1.05, (H - cb) * 0.27), top = H - shoot * 0.8, nL = C.high ? 5 : 4, heads = [], a0 = R() * TAU, bx = lx * 0.6, by = ly * 0.6;
      const knob = (p, r) => { W.lump(p, [r, r, r * 1.08], C.high ? 2 : 1, 0.34, seedOf(x + p[0], y + p[1], 7), () => tone(bark, 0.88)); heads.push([p[0], p[1], p[2], r]); };
      const limb = (a, b, r0, r1, sides) => {
        const k = Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.22, m = [lerp(a[0], b[0], 0.55) + (R() - 0.5) * k, lerp(a[1], b[1], 0.55) + (R() - 0.5) * k, lerp(a[2], b[2], 0.34)];
        W.tube([[a[0], a[1], a[2], r0], [m[0], m[1], m[2], lerp(r0, r1, 0.55)], [b[0], b[1], b[2], r1]], sides, bark);
      };
      W.lump([bx, by, cb - 0.12], [tr * 1.12, tr * 1.12, tr * 0.95], C.high ? 2 : 1, 0.2, seedOf(x, y, 8), () => tone(bark, 0.94));
      for (let i = 0; i < nL; i++) {
        const az = a0 + (i / nL) * TAU + (R() - 0.5) * 0.6, reach = cr * (0.4 + R() * 0.2), rise = (top - cb) * (0.18 + R() * 0.34);
        const p2 = [bx + Math.cos(az) * reach, by + Math.sin(az) * reach, cb + rise];
        limb([bx, by, cb - 0.4], p2, tr * 0.66, tr * 0.5, C.high ? 6 : 5);
        knob(p2, tr * 0.7);
        const arms = C.high ? 2 + (R() < 0.4 ? 1 : 0) : 1 + (R() < 0.5 ? 1 : 0);
        for (let a = 0; a < arms; a++) {
          const az2 = az + (arms === 1 ? 0 : (a / (arms - 1) - 0.5) * (1.3 + R() * 0.5)) + (R() - 0.5) * 0.35, r2 = Math.min(cr, reach + cr * (0.26 + R() * 0.3));
          const e = [bx + Math.cos(az2) * r2, by + Math.sin(az2) * r2, Math.min(top, p2[2] + (top - p2[2]) * (0.3 + R() * 0.7))];
          limb(p2, e, tr * 0.42, tr * 0.3, C.high ? 5 : 4);
          knob(e, tr * 0.55);
        }
      }
      const pt = [bx + (R() - 0.5) * cr * 0.25, by + (R() - 0.5) * cr * 0.25, top];
      limb([bx, by, cb - 0.2], pt, tr * 0.6, tr * 0.34, C.high ? 6 : 5);
      knob(pt, tr * 0.58);
      const twig = mix(bark, pal.stone, 0.25);
      for (const hd of heads) {
        if (leaves) { const r = shoot * 0.95 + 0.55; lobe(hd[0], hd[1], hd[2] + r * 0.3, r, r * 0.85, (R() - 0.5) * 0.1, null, 2); continue; }
        const n = C.high ? 10 : 4, ox = hd[0] - bx, oy = hd[1] - by, ol = Math.hypot(ox, oy) || 1;
        for (let k = 0; k < n; k++) {
          const az = R() * TAU, tilt = 0.04 + R() * 0.46, l = shoot * (0.35 + R() * 0.65);
          const d = norm([Math.cos(az) * Math.sin(tilt) + ox / ol * 0.14, Math.sin(az) * Math.sin(tilt) + oy / ol * 0.14, Math.cos(tilt)]), s = hd[3] * 0.55;
          W.tube([[hd[0] + d[0] * s, hd[1] + d[1] * s, hd[2] + d[2] * s, 0.015], [hd[0] + d[0] * (s + l), hd[1] + d[1] * (s + l), hd[2] + d[2] * (s + l), 0.004]], 3, twig);
        }
      }
      if (leaves) lobe(bx, by, cb + (top - cb) * 0.5, cr * 0.72, (H - cb) * 0.42, -0.15);
      return;
    }
    if (!leaves) {
      // a winter tree: limbs, branches, twigs
      const depth = C.high ? 3 : 2;
      limbs(kind === 'columnar' ? 3 : C.high ? 5 : 4, depth, kind === 'columnar' ? c * 0.5 : 0.36 * (cr + c));
      grow(W, C, R, [lx, ly, topZ - 0.4], norm([lx * 0.02, ly * 0.02, 1]), c * 0.75, tr * 0.6, 0, depth, env, bark);
      return;
    }
    if (kind === 'conifer') {
      // tiers of drooping skirts, one above the other
      const n = C.high ? 6 : 4, segs = C.high ? 12 : 8, th = (H - cb) / n * 1.9, cc = pal.conifer;
      for (let i = 0; i < n; i++) {
        const zb = cb + (H - cb) * (i / n) * 0.9, r = cr * (1 - (i / n) * 0.8), zt = Math.min(H, zb + th), base = WC.b.n;
        const colAt = (P, nn) => {
          const sun = C.dark ? 0.5 : sat(0.5 + 0.5 * dot(nn, L));
          return tint(mix(leaf(C, sat(0.2 + 0.5 * sun + 0.25 * i / n)), cc, 0.65));
        };
        const apex = WC.P([lx, ly, zt]);
        WC.b.vert(apex, WC.shade(colAt(apex, [0, 0, 1]), [0, 0, 1], apex, 2));
        for (let k = 0; k < segs; k++) {
          const a = (k / segs) * TAU + i * 0.5, rr = r * (k % 2 ? 0.84 : 1), P = WC.P([lx + Math.cos(a) * rr, ly + Math.sin(a) * rr, zb + (k % 2 ? th * 0.1 : 0)]);
          const nn = norm([Math.cos(a) * th, Math.sin(a) * th, r]);
          WC.b.vert(P, WC.shade(tone(colAt(P, nn), 0.9), nn, P, 2));
        }
        const under = WC.P([lx, ly, zb + th * 0.3]), ui = WC.b.vert(under, WC.shade(tone(tint(pal.crownDark), 0.8), [0, 0, -1], under, 2));
        for (let k = 0; k < segs; k++) { const k1 = (k + 1) % segs; WC.b.i.push(base, base + 1 + k, base + 1 + k1, ui, base + 1 + k1, base + 1 + k); }
      }
      return;
    }
    limbs(C.high ? 4 : 3, 0, Math.min(0.62 * cr, 0.9 * c));
    if (kind === 'columnar') {
      const n = Math.max(3, Math.round((H - cb) / (cr * 2.2)));
      for (let i = 0; i < n; i++) {
        const k = i === n - 1 ? 0.78 : 0.9 + R() * 0.14, rz = (H - cb) / n * 0.78;
        lobe(lx + (R() - 0.5) * cr * 0.2, ly + (R() - 0.5) * cr * 0.2, cb + (H - cb) * (i + 0.5) / n, cr * k, rz, -0.06);
      }
      return;
    }
    // broadleaf: a core, a ring of lobes around it, a few on top
    lobe(lx, ly, zc + 0.05 * c, cr * 0.62, c * 0.8, -0.12);
    const nr = C.high ? 5 : 4, a0 = R() * TAU;
    for (let i = 0; i < nr; i++) {
      const a = a0 + (i / nr) * TAU + (R() - 0.5) * 0.5, d = cr * 0.46 * (0.86 + R() * 0.22), r = cr * 0.52 * (0.88 + R() * 0.22), rz = Math.min(c * 0.64, r * 0.92);
      lobe(lx + Math.cos(a) * d, ly + Math.sin(a) * d, Math.max(cb + rz + 0.05, zc - 0.3 * c + (R() - 0.5) * 0.25 * c), r, rz, -0.05);
    }
    const nt = C.high ? 3 : 2, a1 = R() * TAU;
    for (let i = 0; i < nt; i++) {
      const a = a1 + (i / nt) * TAU, d = cr * 0.24, r = cr * 0.5 * (0.9 + R() * 0.2);
      lobe(lx + Math.cos(a) * d, ly + Math.sin(a) * d, zc + 0.42 * c, r, Math.min(c * 0.52, r), 0.05);
    }
  }

  // ---------- props ----------
  // Where a prop gives light at night: [{ at: [x, y, z] in its own frame, reach, power, glow }]
  function lightsOf(p) {
    const v = String(p.variant || '').toLowerCase();
    if (p.kind === 'lamp') {
      const hung = /wire|hung|hang|suspend|catenary|seil|pendant|cable/.test(v), wall = /wall|bracket|wand/.test(v), lantern = /lantern|historic|laterne|candelabr/.test(v);
      const H = or(p.height, hung ? 7 : wall ? 3.4 : lantern ? 3.6 : 4.5);
      if (hung) return [{ at: [0, 0, H - 0.08], reach: Math.max(H * 2.4, 16), power: 1.1, glow: 1.15 }];
      if (wall) return [{ at: [0, 0.55, H - 0.2], reach: H * 2.2, power: 0.9, glow: 0.9 }];
      if (lantern) return [{ at: [0, 0, H - 0.26], reach: H * 2.4, power: 1, glow: 1 }];
      const reach = clamp(or(p.length, H * 0.2), 0.5, 1.6), dirs = /double|twin|zwei/.test(v) ? [1, -1] : [1];
      return dirs.map((d) => ({ at: [0, d * (reach + 0.22), H - 0.07], reach: H * 2.3, power: 1, glow: 1 }));
    }
    if (p.kind === 'shelter') return [{ at: [0, 0.1, or(p.height, 2.5) - 0.08], reach: 5.5, power: 0.75, glow: 0 }];
    return [];
  }
  const PROPS = {};
  PROPS.bench = function (C, p, W, R) {
    const pal = C.pal, v = String(p.variant || '').toLowerCase();
    const back = !/backless|no-?back|without|flat|ohne|hocker|block|stone/.test(v), stone = /stone|block|stein|concrete|beton/.test(v);
    const L = or(p.length, 1.8), D = or(p.width, 0.5), ht = back ? clamp(or(p.height, 0.84), 0.7, 1.1) : 0, hs = back ? 0.45 : clamp(or(p.height, 0.45), 0.3, 0.7);
    const M = pal.metal, wood = pal.wood;
    if (stone) W.box(-L / 2 + 0.04, -D / 2 + 0.03, 0, L / 2 - 0.04, D / 2 - 0.03, hs - 0.04, pal.stone, { top: mix(pal.stone, WHITE, 0.2) });
    else for (const sx of [-1, 1]) {
      const fx = sx * (L / 2 - 0.22);
      W.box(fx - 0.025, D / 2 - 0.09, 0, fx + 0.025, D / 2 - 0.04, hs - 0.04, M);
      W.box(fx - 0.025, -D / 2 + 0.04, 0, fx + 0.025, -D / 2 + 0.09, hs - 0.04, M);
      W.box(fx - 0.025, -D / 2 + 0.04, hs - 0.085, fx + 0.025, D / 2 - 0.04, hs - 0.04, M, { bottom: true });
    }
    const n = 4, gap = 0.016, sw = (D - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      const c = tone(wood, 0.95 + R() * 0.1), y0 = -D / 2 + i * (sw + gap);
      W.box(-L / 2, y0, hs - 0.036, L / 2, y0 + sw, hs, c, { top: mix(c, WHITE, C.dark ? 0.04 : 0.14), bottom: true });
    }
    if (back) {
      const ta = 14 * RAD, dir = [0, -Math.sin(ta), Math.cos(ta)], nr = [0, Math.cos(ta), Math.sin(ta)], y0 = -D / 2 + 0.03, len = (ht - hs) / Math.cos(ta);
      if (!stone) for (const sx of [-1, 1]) {
        const fx = sx * (L / 2 - 0.22);
        W.obox([fx, y0 + dir[1] * len / 2 - 0.02, hs - 0.04 + dir[2] * len / 2], [0.025, 0, 0], mul3(nr, 0.02), mul3(dir, len / 2 + 0.02), M);
      }
      const ns = len > 0.33 ? 3 : 2, sh = Math.min(0.055, (len - 0.08) / ns / 2 - 0.008);
      for (let i = 0; i < ns; i++) {
        const d = len - sh - i * (sh * 2 + 0.02), c = tone(wood, 0.95 + R() * 0.1);
        W.obox([0, y0 + dir[1] * d + nr[1] * 0.02, hs - 0.04 + dir[2] * d + nr[2] * 0.02], [L / 2, 0, 0], mul3(nr, 0.016), mul3(dir, sh), c, { top: mix(c, WHITE, C.dark ? 0.03 : 0.1) });
      }
    }
    return { rx: L / 2 + 0.16, ry: D / 2 + 0.2, a: 1.15 };
  };
  PROPS.lamp = function (C, p, W) {
    const pal = C.pal, v = String(p.variant || '').toLowerCase(), M = pal.metal, ML = mix(M, WHITE, C.dark ? 0.08 : 0.2), lens = pal.lens;
    const hung = /wire|hung|hang|suspend|catenary|seil|pendant|cable/.test(v), wall = /wall|bracket|wand/.test(v), lantern = /lantern|historic|laterne|candelabr/.test(v);
    const H = or(p.height, hung ? 7 : wall ? 3.4 : lantern ? 3.6 : 4.5), on = C.dark;
    const lensCol = on ? lens : mix(lens, pal.steel, 0.25);
    if (hung) {
      // a light hung on a wire across the street; the wire runs across the heading
      const span = or(p.length, 14), path = [], sp = p._span;
      if (sp) { // from house to house, as the span wires of the trams are
        const o = W.o, top = W.P([0, 0, H + 0.28]);
        W.world();
        for (const e of [sp.a, sp.b]) {
          const pts = [];
          for (let i = 0; i <= 6; i++) { const u = i / 6; pts.push([lerp(top[0], e[0], u), lerp(top[1], e[1], u), top[2] + (e[2] - top[2]) * u * u, 0.012]); }
          W.tube(pts, 3, tone(M, 0.8));
        }
        W.o = o;
      } else {
        for (let i = -5; i <= 5; i++) { const u = i / 5; path.push([u * span / 2, 0, H + 0.28 + 0.5 * u * u, 0.011]); }
        W.tube(path, 3, tone(M, 0.8));
      }
      W.cyl(0, 0, H + 0.1, H + 0.3, 0.012, 0.012, 4, M);
      W.lathe(0, 0, H - 0.1, [[0.3, 0, ML], [0.11, 0.14, ML], [0.05, 0.2, M], [0, 0.21, M]], C.high ? 12 : 8, ML, { facet: false });
      const pts = [];
      for (let k = 0; k < 10; k++) pts.push([Math.cos(k / 10 * TAU) * 0.27, Math.sin(k / 10 * TAU) * 0.27, H - 0.1]);
      W.fan(pts, lensCol, { n: [0, 0, -1], mode: 1 });
      return null;
    }
    if (wall) {
      const path = [];
      for (let k = 0; k <= 5; k++) { const a = (k / 5) * Math.PI / 2; path.push([0, 0.55 * Math.sin(a), H + 0.25 * (1 - Math.cos(a)) - 0.0, 0.02]); }
      W.tube(path, 4, M);
      W.box(-0.1, -0.02, H - 0.18, 0.1, 0.02, H + 0.12, M);
      W.box(-0.11, 0.44, H - 0.38, 0.11, 0.66, H - 0.1, lensCol, { mode: 1, bottom: true });
      W.lathe(0, 0.55, H - 0.1, [[0.19, 0], [0.04, 0.14], [0, 0.15]], 4, M, { phase: Math.PI / 4 });
      return null;
    }
    const seg = C.high ? 10 : 6;
    W.lathe(0, 0, 0, [[0.105, 0], [0.105, 0.05], [0.08, 0.09], [0.075, 0.95], [0.058, 1.0]], seg, tone(M, 0.92), { facet: false });
    if (lantern) {
      W.cyl(0, 0, 1.0, H - 0.55, 0.055, 0.045, seg, M);
      W.lathe(0, 0, H - 0.55, [[0.045, 0], [0.11, 0.06], [0.11, 0.1]], 6, M);
      W.lathe(0, 0, H - 0.45, [[0.1, 0], [0.17, 0.36]], 6, lensCol, { mode: 1 });
      W.lathe(0, 0, H - 0.09, [[0.2, 0], [0.2, 0.03], [0.05, 0.2], [0, 0.26]], 6, M);
      return { rx: 0.22, ry: 0.22, a: 1.2 };
    }
    W.cyl(0, 0, 1.0, H - 0.4, 0.058, 0.04, seg, M, { col1: ML });
    const reach = clamp(or(p.length, H * 0.2), 0.5, 1.6), dirs = /double|twin|zwei/.test(v) ? [1, -1] : [1];
    for (const d of dirs) {
      const path = [];
      for (let k = 0; k <= 6; k++) { const a = (k / 6) * Math.PI / 2; path.push([0, d * reach * (1 - Math.cos(a)), H - 0.4 + 0.4 * Math.sin(a), lerp(0.04, 0.03, k / 6)]); }
      W.tube(path, C.high ? 6 : 4, ML);
      const cy = d * (reach + 0.2);
      W.obox([0, cy, H - 0.012], [0.12, 0, 0], [0, 0.3, 0], [0, 0, 0.035], M, { top: ML, skip: '-z' });
      W.quad([-0.12, cy - 0.3, H - 0.047], [0.12, cy - 0.3, H - 0.047], [0.12, cy + 0.3, H - 0.047], [-0.12, cy + 0.3, H - 0.047], tone(M, 0.8), { n: [0, 0, -1] });
      W.quad([-0.09, cy - 0.25, H - 0.05], [0.09, cy - 0.25, H - 0.05], [0.09, cy + 0.25, H - 0.05], [-0.09, cy + 0.25, H - 0.05], lensCol, { n: [0, 0, -1], mode: 1 });
    }
    return { rx: 0.22, ry: 0.22, a: 1.2 };
  };
  PROPS.bollard = function (C, p, W) {
    const pal = C.pal, v = String(p.variant || '').toLowerCase(), h = or(p.height, 0.9), r = or(p.width, 0.16) / 2;
    if (/stone|stein|granit/.test(v)) {
      const q = Math.max(r, 0.13) * 1.3;
      W.lathe(0, 0, 0, [[q * 1.15, 0], [q * 1.15, 0.08], [q, 0.1], [q * 0.86, h - 0.1], [q * 0.5, h, mix(pal.stone, WHITE, 0.25)], [0, h + 0.02, mix(pal.stone, WHITE, 0.25)]], 4, pal.stone, { phase: Math.PI / 4 });
      return { rx: q * 1.6, ry: q * 1.6, a: 1.2 };
    }
    const M = pal.metal, band = mix(pal.steel, WHITE, C.dark ? 0.1 : 0.45);
    W.lathe(0, 0, 0, [[r + 0.02, 0], [r + 0.02, 0.04], [r, 0.06], [r, h - 0.24], [r + 0.006, h - 0.235, band], [r + 0.006, h - 0.14, band], [r, h - 0.135], [r, h - 0.05], [r * 0.62, h, mix(M, WHITE, 0.15)], [0, h + 0.012, mix(M, WHITE, 0.15)]], C.high ? 10 : 6, M, { facet: false });
    return { rx: r * 2.6, ry: r * 2.6, a: 1.2 };
  };
  PROPS.bin = function (C, p, W) {
    // the Swiss street bin: a steel cylinder with a slanted mouth
    const pal = C.pal, h = or(p.height, 0.95), r = or(p.width, 0.44) / 2, S = pal.steel, seg = C.high ? 14 : 8;
    if (/recycl|sammel|trenn/.test(String(p.variant || '').toLowerCase())) {
      // a recycling station: three bins side by side, a coloured lid each
      const lids = [pal.sign, pal.marking, pal.hydrant], w = 0.52;
      for (let i = 0; i < 3; i++) {
        const x0 = (i - 1.5) * w;
        W.box(x0 + 0.02, -0.26, 0.05, x0 + w - 0.02, 0.26, 1.02, tone(S, 0.94), { top: S });
        W.box(x0, -0.28, 1.02, x0 + w, 0.28, 1.12, lids[i], { top: mix(lids[i], WHITE, C.dark ? 0.05 : 0.2), bottom: true });
        W.quad([x0 + 0.12, 0.262, 0.74], [x0 + w - 0.12, 0.262, 0.74], [x0 + w - 0.12, 0.262, 0.9], [x0 + 0.12, 0.262, 0.9], tone(pal.metal, 0.3), { n: [0, 1, 0] });
      }
      return { rx: 1.0, ry: 0.5, a: 1.2 };
    }
    W.cyl(0, 0, 0, 0.07, r * 0.5, r * 0.5, 6, tone(pal.metal, 0.8));
    W.cyl(0, 0, 0.07, h * 0.8, r, r, seg, tone(S, 0.92), { col1: S });
    const base = W.b.n, zt = (a) => h * 0.9 - h * 0.1 * Math.sin(a), pts = [];
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * TAU, ca = Math.cos(a), sa = Math.sin(a), n = W.N([ca, sa, 0]);
      W.emit(W.P([ca * r, sa * r, h * 0.8]), n, S);
      W.emit(W.P([ca * r, sa * r, zt(a)]), n, mix(S, WHITE, C.dark ? 0.05 : 0.2));
      if (k < seg) pts.push([ca * r, sa * r, zt(a)]);
    }
    for (let k = 0; k < seg; k++) { const a = base + k * 2; W.b.i.push(a, a + 2, a + 3, a, a + 3, a + 1); }
    W.fan(pts, tone(pal.metal, 0.45), { n: [0, 0.3, 1] });
    W.fan(pts.map((q) => [q[0] * 0.55, q[1] * 0.55 + r * 0.12, lerp(zt(Math.PI / 2), q[2], 0.55) + 0.003]), tone(pal.metal, 0.22), { n: [0, 0.3, 1] });
    return { rx: r * 1.5, ry: r * 1.5, a: 1.25 };
  };
  PROPS['bike-stand'] = function (C, p, W) {
    const pal = C.pal, v = String(p.variant || '').toLowerCase(), h = or(p.height, 0.8), S = pal.steel, sides = C.high ? 5 : 4;
    const hoop = (cx, cy, l, alongX) => {
      const path = [], rc = 0.13, P = (u, z) => (alongX ? [cx + u, cy, z, 0.022] : [cx, cy + u, z, 0.022]);
      path.push(P(-l / 2, -0.05), P(-l / 2, h - rc));
      for (let k = 1; k <= 3; k++) { const a = (k / 3) * Math.PI / 2; path.push(P(-l / 2 + rc * (1 - Math.cos(a)), h - rc + rc * Math.sin(a))); }
      for (let k = 2; k >= 0; k--) { const a = (k / 3) * Math.PI / 2; path.push(P(l / 2 - rc * (1 - Math.cos(a)), h - rc + rc * Math.sin(a))); }
      path.push(P(l / 2, -0.05));
      W.tube(path, sides, S);
    };
    const cap = num(p.capacity), row = /row|reihe|rack/.test(v) || or(p.length, 0) >= 1.6 || cap > 2;
    if (!row) { hoop(0, 0, or(p.length, 0.8), true); return { rx: or(p.length, 0.8) / 2 + 0.1, ry: 0.16, a: 0.9 }; }
    // two bikes lean on a hoop; a place for a hundred is drawn as a row of at most ten metres
    const L = or(p.length, cap ? clamp(cap / 2 * 0.75, 1.5, 10) : 3), n = Math.max(2, Math.round(L / 0.75) + 1), l = or(p.width, 0.8);
    for (let i = 0; i < n; i++) hoop(-L / 2 + (i / (n - 1)) * L, 0, l, false);
    return { rx: L / 2 + 0.2, ry: l / 2 + 0.15, a: 0.7 };
  };
  // a standing figure, for statues and fountain columns: legs apart, armour skirt, chest, neck and head, a cloak
  // down the back, one arm stretched forward, the other on a sword
  function figure(C, W, x, y, z, h, col) {
    const hi = mix(col, WHITE, C.dark ? 0.06 : 0.14), lo = tone(col, 0.84), f = C.high ? 2 : 1;
    W.box(x - 0.2 * h, y - 0.14 * h, z, x + 0.2 * h, y + 0.14 * h, z + 0.025 * h, lo, { top: col });
    W.tube([[x - 0.085 * h, y - 0.03 * h, z + 0.02 * h, 0.042 * h], [x - 0.075 * h, y - 0.01 * h, z + 0.25 * h, 0.05 * h], [x - 0.055 * h, y, z + 0.48 * h, 0.066 * h]], 6, lo);
    W.tube([[x + 0.09 * h, y + 0.05 * h, z + 0.02 * h, 0.042 * h], [x + 0.08 * h, y + 0.03 * h, z + 0.25 * h, 0.05 * h], [x + 0.055 * h, y, z + 0.48 * h, 0.066 * h]], 6, lo);
    for (const s of [-1, 1]) W.box(x + s * 0.088 * h - 0.045 * h, y - 0.05 * h + (s > 0 ? 0.05 * h : 0), z + 0.02 * h, x + s * 0.088 * h + 0.045 * h, y + 0.1 * h + (s > 0 ? 0.05 * h : 0), z + 0.06 * h, lo); // feet
    W.lathe(x, y, z + 0.42 * h, [[0.135 * h, 0], [0.115 * h, 0.09 * h], [0.1 * h, 0.14 * h]], C.high ? 9 : 6, col, { facet: false });  // the skirt of the armour
    W.lump([x, y, z + 0.66 * h], [0.118 * h, 0.08 * h, 0.14 * h], f, 0.03, 2, (P) => (P[2] > z + 0.7 * h ? hi : col));                    // chest
    W.lump([x, y, z + 0.765 * h], [0.165 * h, 0.075 * h, 0.05 * h], f, 0.02, 3, () => hi);                                                   // shoulders
    W.cyl(x, y, z + 0.78 * h, z + 0.84 * h, 0.035 * h, 0.032 * h, 6, col);
    W.lump([x, y + 0.008 * h, z + 0.895 * h], [0.058 * h, 0.066 * h, 0.075 * h], f, 0.03, 4, () => hi);                                      // head
    W.lump([x, y - 0.012 * h, z + 0.925 * h], [0.066 * h, 0.07 * h, 0.05 * h], f, 0.02, 5, () => col);                                       // hair, or a helmet
    W.lump([x, y - 0.085 * h, z + 0.52 * h], [0.125 * h, 0.03 * h, 0.27 * h], f, 0.05, 6, () => lo);                                         // the cloak
    W.tube([[x - 0.16 * h, y, z + 0.75 * h, 0.04 * h], [x - 0.2 * h, y + 0.02 * h, z + 0.6 * h, 0.034 * h], [x - 0.17 * h, y + 0.09 * h, z + 0.48 * h, 0.03 * h]], 5, col, { cap: true });
    W.tube([[x + 0.16 * h, y, z + 0.75 * h, 0.04 * h], [x + 0.21 * h, y + 0.1 * h, z + 0.65 * h, 0.034 * h], [x + 0.22 * h, y + 0.27 * h, z + 0.62 * h, 0.028 * h]], 5, col, { cap: true });
    W.lump([x + 0.222 * h, y + 0.295 * h, z + 0.62 * h], [0.03 * h, 0.035 * h, 0.03 * h], 1, 0, 7, () => hi);
    W.tube([[x - 0.18 * h, y + 0.11 * h, z + 0.52 * h, 0.013 * h], [x - 0.2 * h, y + 0.15 * h, z + 0.04 * h, 0.009 * h]], 4, hi, { cap: true });
    W.box(x - 0.215 * h, y + 0.1 * h, z + 0.5 * h, x - 0.145 * h, y + 0.125 * h, z + 0.515 * h, hi);
  }
  PROPS.fountain = function (C, p, W) {
    const pal = C.pal, v = String(p.variant || '').toLowerCase(), stone = pal.stone, lt = mix(stone, WHITE, C.dark ? 0.08 : 0.3), water = pal.water;
    const trough = /trough|trog|rect|long/.test(v) || (num(p.length) && num(p.width) && p.length > p.width * 1.5);
    const low = num(p.height) != null && p.height < 1.5, hb = low ? p.height : 0.8, hc = low ? hb + 1.0 : or(p.height, 3.1);
    let cy = 0, Rb = 0, L = 0, D = 0;
    if (trough) {
      L = or(p.length, 3.2); D = or(p.width, 1.3);
      const t = 0.16;
      W.box(-L / 2 - 0.12, -D / 2 - 0.12, 0, L / 2 + 0.12, D / 2 + 0.12, 0.1, tone(stone, 0.94));
      W.box(-L / 2, -D / 2, 0.1, L / 2, -D / 2 + t, hb, stone, { top: lt }); W.box(-L / 2, D / 2 - t, 0.1, L / 2, D / 2, hb, stone, { top: lt });
      W.box(-L / 2, -D / 2 + t, 0.1, -L / 2 + t, D / 2 - t, hb, stone, { top: lt }); W.box(L / 2 - t, -D / 2 + t, 0.1, L / 2, D / 2 - t, hb, stone, { top: lt });
      W.quad([-L / 2 + t, -D / 2 + t, hb - 0.12], [L / 2 - t, -D / 2 + t, hb - 0.12], [L / 2 - t, D / 2 - t, hb - 0.12], [-L / 2 + t, D / 2 - t, hb - 0.12], water, { n: [0, 0, 1], mode: 1 });
      cy = -D / 2 - 0.12;
    } else {
      Rb = or(num(p.width) != null ? p.width : p.length, 2.6) / 2;
      W.lathe(0, 0, 0, [[Rb + 0.14, 0], [Rb + 0.14, 0.1], [Rb + 0.02, 0.12], [Rb, hb - 0.1], [Rb + 0.07, hb - 0.06], [Rb + 0.07, hb], [Rb - 0.17, hb, lt], [Rb - 0.17, hb - 0.16, tone(stone, 0.8)]], 8, stone, { phase: Math.PI / 8 });
      const pts = [];
      for (let k = 0; k < 8; k++) { const a = Math.PI / 8 + (k / 8) * TAU; pts.push([Math.cos(a) * (Rb - 0.17), Math.sin(a) * (Rb - 0.17), hb - 0.13]); }
      W.fan(pts, water, { n: [0, 0, 1], mode: 1 });
    }
    // the column (Brunnenstock) with its capital, something on top, and spouts
    W.lathe(0, cy, 0, [[0.3, 0], [0.3, hb + 0.12], [0.2, hb + 0.2], [0.17, hc - 0.5], [0.26, hc - 0.42, lt], [0.29, hc - 0.3, lt], [0.2, hc - 0.27], [0.2, hc - 0.2], [0, hc - 0.2]], 8, lt, { phase: Math.PI / 8 });
    if (/figure|statue|figur/.test(v) || /brunnen/i.test(p.name || '')) figure(C, W, 0, cy, hc - 0.2, Math.max(0.9, hc * 0.36), pal.bronze);
    else W.lump([0, cy, hc - 0.03], [0.19, 0.19, 0.19], 2, 0, 1, () => pal.bronze);
    const jet = mix(water, WHITE, C.dark ? 0.2 : 0.6), zs = hb + 0.42, dirs = trough ? [[0, 1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const d of dirs) {
      const e = [d[0] * 0.62, cy + d[1] * 0.62, zs];
      W.tube([[d[0] * 0.15, cy + d[1] * 0.15, zs, 0.022], [e[0], e[1], e[2], 0.018]], 4, pal.metal, { cap: true });
      const path = [];
      for (let k = 0; k <= 4; k++) { const u = k / 4; path.push([e[0] + d[0] * 0.3 * u, e[1] + d[1] * 0.3 * u, zs - (zs - hb + 0.13) * u * u, 0.012]); }
      W.tube(path, 3, jet, { mode: 1 });
    }
    return trough ? { rx: L / 2 + 0.45, ry: D / 2 + 0.5, a: 1.2 } : { rx: Rb + 0.5, ry: Rb + 0.5, a: 1.2 };
  };
  PROPS.planter = function (C, p, W, R, x, y, z) {
    const pal = C.pal, v = String(p.variant || '').toLowerCase(), h = or(p.height, 0.6), L = or(p.length, 1.2), D = or(p.width, Math.min(L, 1.2));
    const st = mix(pal.stone, pal.kerb, 0.4), lt = mix(st, WHITE, C.dark ? 0.08 : 0.3), round = /round|rund|tub|pot/.test(v);
    if (round) {
      const r = Math.max(L, D) / 2;
      W.lathe(0, 0, 0, [[r * 0.82, 0], [r, h], [r - 0.06, h, lt], [r - 0.06, h - 0.07, pal.soil], [0, h - 0.07, pal.soil]], C.high ? 12 : 8, st, { facet: false });
    } else {
      W.box(-L / 2, -D / 2, 0, L / 2, D / 2, h, st, { top: lt });
      W.quad([-L / 2 + 0.06, -D / 2 + 0.06, h + 0.004], [L / 2 - 0.06, -D / 2 + 0.06, h + 0.004], [L / 2 - 0.06, D / 2 - 0.06, h + 0.004], [-L / 2 + 0.06, D / 2 - 0.06, h + 0.004], pal.soil, { n: [0, 0, 1] });
    }
    const WC = C.W.crown.frame(x, y, z, p.heading || 0), n = Math.max(1, Math.round(L / 0.65)), Ls = C.sun;
    for (let i = 0; i < n; i++) {
      const cx = n === 1 ? 0 : -L / 2 + 0.35 + (i / (n - 1)) * (L - 0.7), s = 0.85 + R() * 0.3, rr = Math.min(D / 2 - 0.02, 0.4 * s);
      WC.lump([cx, (R() - 0.5) * 0.1, h + 0.24 * s], [rr, rr, 0.32 * s], C.high ? 2 : 1, 0.12, seedOf(x + cx, y, 3), (P, nn) => leaf(C, sat(0.25 + 0.45 * sat(0.5 + 0.5 * dot(nn, Ls)) + 0.3 * nn[2])), 2);
      if (C.high && !/shrub|hedge|grass/.test(v)) for (let k = 0; k < 5; k++) {
        const a = R() * TAU, e = 0.5 + R() * 0.45, fc = pal.flowers[Math.floor(R() * pal.flowers.length) % pal.flowers.length];
        WC.lump([cx + Math.cos(a) * rr * e, Math.sin(a) * rr * e, h + 0.24 * s + 0.3 * s * Math.sqrt(1 - e * e * 0.8)], [0.05, 0.05, 0.04], 1, 0, 1, () => fc, 2);
      }
    }
    return { rx: L / 2 + 0.25, ry: D / 2 + 0.25, a: 1.2 };
  };
  PROPS.hydrant = function (C, p, W) {
    const pal = C.pal, H = or(p.height, 0.85), c = pal.hydrant, lt = mix(c, WHITE, C.dark ? 0.05 : 0.2), seg = C.high ? 10 : 6;
    W.lathe(0, 0, 0, [[0.13, 0], [0.13, 0.05], [0.085, 0.08], [0.085, H * 0.6], [0.11, H * 0.64, lt], [0.11, H * 0.84, lt], [0.075, H * 0.93], [0.03, H], [0, H + 0.01]], seg, c, { facet: false });
    for (const s of [-1, 1]) W.tube([[s * 0.09, 0, H * 0.74, 0.042], [s * 0.17, 0, H * 0.74, 0.042]], 6, pal.steel, { cap: true });
    W.tube([[0, 0.09, H * 0.74, 0.05], [0, 0.16, H * 0.74, 0.05]], 6, pal.steel, { cap: true });
    return { rx: 0.26, ry: 0.26, a: 1.2 };
  };
  PROPS['sign-post'] = function (C, p, W) {
    const pal = C.pal, v = String(p.variant || '').toLowerCase(), blue = pal.sign, white = C.dark ? hex('#C9CCD2') : hex('#FBFBF8'), red = pal.hydrant, back = pal.steel;
    if (/guide|finger|wegweis|cycling|velo/.test(v)) {
      // a guidepost: a stout pole with red arrow blades pointing both ways
      const H = or(p.height, 4.2), r = p._host || 0.075, dk = mix(hex(C.dark ? '#7A3A3A' : '#B8454B'), pal.hydrant, 0.3);
      if (!p._host) {
        W.lathe(0, 0, 0, [[r * 1.7, 0], [r * 1.7, 0.22], [r, 0.28]], C.high ? 8 : 5, tone(pal.metal, 0.9), { facet: false });
        W.cyl(0, 0, 0.28, H, r, r * 0.9, C.high ? 8 : 5, pal.steel, { cap: true });
      }
      [[1, 2.25], [1, 2.55], [1, 2.85], [-1, 2.4], [-1, 2.7], [0.6, 3.25]].forEach(([dir, z0], i) => {
        const s = dir > 0 ? 1 : -1, l = 0.95 * Math.abs(dir) + 0.2, y0 = (i % 2 ? 1 : -1) * (r + 0.012), pts = [[-s * 0.06, 0], [s * (l - 0.14), 0], [s * l, 0.12], [s * (l - 0.14), 0.24], [-s * 0.06, 0.24]];
        for (const side of [1, -1]) W.fan(pts.map((q) => [q[0], y0 + side * 0.004, z0 + q[1]]), dk, { n: [0, side, 0] });
        for (const side of [1, -1]) W.quad([s * 0.14, y0 + side * 0.006, z0 + 0.04], [s * 0.3, y0 + side * 0.006, z0 + 0.04], [s * 0.3, y0 + side * 0.006, z0 + 0.2], [s * 0.14, y0 + side * 0.006, z0 + 0.2], side > 0 ? white : dk, { n: [0, side, 0] });
      });
      return { rx: 0.3, ry: 0.3, a: 1.2 };
    }
    if (/board|map|plan|tafel|panel/.test(v)) {
      // an information board on two legs
      const host = p._host, H = or(p.height, host ? 1.95 : 2.1), w = or(p.length, host ? 0.8 : 1.2) / 2;
      if (host) W.o = Object.assign({}, W.o, { x: W.P([0, host + 0.04, 0])[0], y: W.P([0, host + 0.04, 0])[1] });
      else for (const s of [-1, 1]) W.box(s * w - 0.03, -0.03, 0, s * w + 0.03, 0.03, H, pal.metal);
      W.box(-w, -0.035, H - 1.05, w, 0.035, H - 0.02, tone(pal.metal, 0.9), { bottom: true });
      for (const side of [1, -1]) {
        W.quad([-w + 0.05, side * 0.037, H - 1.0], [w - 0.05, side * 0.037, H - 1.0], [w - 0.05, side * 0.037, H - 0.07], [-w + 0.05, side * 0.037, H - 0.07], white, { n: [0, side, 0] });
        W.quad([-w + 0.12, side * 0.039, H - 0.9], [w * 0.2, side * 0.039, H - 0.9], [w * 0.2, side * 0.039, H - 0.3], [-w + 0.12, side * 0.039, H - 0.3], mix(pal.grass, white, 0.45), { n: [0, side, 0] });
        W.quad([-w + 0.12, side * 0.039, H - 0.25], [w - 0.12, side * 0.039, H - 0.25], [w - 0.12, side * 0.039, H - 0.14], [-w + 0.12, side * 0.039, H - 0.14], blue, { n: [0, side, 0] });
      }
      return { rx: w + 0.2, ry: 0.25, a: 1.1 };
    }
    const H = or(p.height, 2.6);
    W.cyl(0, 0, 0, H, 0.03, 0.03, C.high ? 6 : 4, pal.steel, { cap: true });
    const y0 = 0.034, zc = H - 0.38;
    const plate = (pts, col, lift) => W.fan(pts.map((q) => [q[0], y0 + (lift || 0), zc + q[1]]), col, { n: [0, 1, 0] });
    const backPlate = (pts) => W.fan(pts.map((q) => [q[0], y0 - 0.006, zc + q[1]]), back, { n: [0, -1, 0] });
    const disc = (r, n) => { const o = []; for (let k = 0; k < n; k++) o.push([Math.cos(k / n * TAU) * r, Math.sin(k / n * TAU) * r]); return o; };
    const rect = (w, h, dz) => [[-w / 2, -h / 2 + (dz || 0)], [w / 2, -h / 2 + (dz || 0)], [w / 2, h / 2 + (dz || 0)], [-w / 2, h / 2 + (dz || 0)]];
    if (/cross|zebra|fussg|pedestrian/.test(v)) {
      const sq = rect(0.6, 0.6);
      plate(sq, blue); backPlate(sq);
      plate([[-0.24, -0.2], [0.24, -0.2], [0, 0.22]], white, 0.002);
      plate(rect(0.05, 0.2, -0.07), tone(pal.metal, 0.5), 0.004); plate(disc(0.035, 6).map((q) => [q[0], q[1] + 0.08]), tone(pal.metal, 0.5), 0.004);
    } else if (/triang|warn|gefahr|yield|vortritt/.test(v)) {
      const tr = [[-0.36, -0.3], [0.36, -0.3], [0, 0.32]];
      plate(tr, red); backPlate(tr); plate([[-0.25, -0.235], [0.25, -0.235], [0, 0.2]], white, 0.002);
    } else if (/stop|tram|bus|halt/.test(v)) {
      const r = rect(0.46, 0.62);
      plate(r, white); backPlate(r); plate(rect(0.46, 0.22, 0.2), red, 0.002); plate(disc(0.07, 8).map((q) => [q[0], q[1] + 0.2]), white, 0.004);
      W.box(-0.17, -0.03, 1.15, 0.17, 0.05, 1.65, tone(pal.metal, 0.9)); W.quad([-0.14, 0.052, 1.19], [0.14, 0.052, 1.19], [0.14, 0.052, 1.61], [-0.14, 0.052, 1.61], white, { n: [0, 1, 0] });
    } else if (/name|street|strasse|gasse/.test(v)) {
      const r = rect(0.85, 0.2, 0.2);
      plate(r, white); backPlate(r); plate(rect(0.81, 0.16, 0.2), blue, 0.002); plate(rect(0.5, 0.03, 0.2), white, 0.004);
    } else if (/park|square|info|rect/.test(v)) {
      const sq = rect(0.55, 0.55);
      plate(sq, blue); backPlate(sq); plate(rect(0.3, 0.34), white, 0.002);
    } else {
      const d = disc(0.3, C.high ? 16 : 10);
      plate(d, blue); backPlate(d);
      plate(rect(0.07, 0.26, -0.05), white, 0.002); plate([[-0.13, 0.06], [0.13, 0.06], [0, 0.2]], white, 0.002);
    }
    return { rx: 0.2, ry: 0.2, a: 1.1 };
  };
  PROPS.pole = function (C, p, W) {
    const pal = C.pal, v = String(p.variant || '').toLowerCase(), H = or(p.height, 6), mast = /tram|mast|fahrleit|span/.test(v) && H > 5.5;
    const r = or(p.width, mast ? 0.3 : 0.15) / 2, M = mast ? mix(pal.metal, pal.steel, 0.45) : pal.metal, seg = C.high ? (mast ? 10 : 8) : 5;
    if (mast) {
      // a tram mast: a round concrete foot, a tapering steel pole, bands where signs were strapped on
      const foot = mix(pal.stone, pal.kerb, 0.5), band = mix(pal.steel, WHITE, C.dark ? 0.1 : 0.4);
      W.lathe(0, 0, 0, [[r * 2.3, 0], [r * 2.3, 0.3, foot], [r * 1.5, 0.36, mix(foot, WHITE, 0.2)], [r * 1.15, 0.36, mix(foot, WHITE, 0.2)]], seg, foot, { facet: false });
      const prof = [[r * 1.1, 0.36], [r * 1.02, 1.9]];
      if (/band|ring/.test(v)) for (const z of [2.0, 2.45, 2.9, 3.35]) prof.push([r * 1.0, z], [r * 1.07, z + 0.01, band], [r * 1.07, z + 0.1, band], [r * 1.0, z + 0.11]);
      prof.push([r * 0.98, 3.9], [r * 0.62, H - 0.05], [0, H]);
      W.lathe(0, 0, 0, prof, seg, M, { facet: false });
      return { rx: r * 3.4, ry: r * 3.4, a: 1.3 };
    }
    W.lathe(0, 0, 0, [[r * 1.5, 0], [r * 1.5, 0.3], [r * 1.05, 0.36]], seg, tone(M, 0.9), { facet: false });
    W.cyl(0, 0, 0.36, H, r, r * 0.7, seg, M, { col1: mix(M, WHITE, C.dark ? 0.05 : 0.15), cap: true });
    if (/catenary|cantilever|ausleger|arm/.test(v)) {
      const len = or(p.length, 3.2);
      W.tube([[0, 0, H - 0.5, 0.035], [0, len, H - 0.32, 0.028]], 5, M, { cap: true });
      W.tube([[0, 0, H - 0.05, 0.014], [0, len * 0.7, H - 0.37, 0.014]], 3, M);
      W.lump([0, len - 0.1, H - 0.42], [0.045, 0.045, 0.07], 1, 0, 1, () => pal.steel);
    } else if (/flag|fahne/.test(v)) {
      W.quad([0, 0.03, H - 1.0], [0, 1.3, H - 1.05], [0, 1.3, H - 0.15], [0, 0.03, H - 0.1], [pal.hydrant, tone(pal.hydrant, 0.9), pal.hydrant, tone(pal.hydrant, 1.06)], { two: true });
    }
    return { rx: r * 3.2, ry: r * 3.2, a: 1.2 };
  };
  PROPS.shelter = function (C, p, W) {
    const pal = C.pal, L = or(p.length, 4), D = or(p.width, 1.5), H = or(p.height, 2.5), M = pal.metal, ML = mix(M, WHITE, C.dark ? 0.06 : 0.2);
    const G = C.W.glass.frame(W.o.x, W.o.y, W.o.z, p.heading || 0), gc = pal.pane, ga = C.dark ? 0.5 : 0.46;
    const yb = -D / 2 + 0.05, xe = L / 2 - 0.06;
    for (const sx of [-1, 1]) { W.box(sx * xe - 0.03, yb - 0.03, 0, sx * xe + 0.03, yb + 0.03, H, M); W.box(sx * xe - 0.03, D * 0.2 - 0.03, 0, sx * xe + 0.03, D * 0.2 + 0.03, H, M); }
    W.box(-L / 2 - 0.15, -D / 2 - 0.08, H, L / 2 + 0.15, D / 2 + 0.3, H + 0.08, M, { top: ML, bottom: true });
    W.box(-xe, yb - 0.02, 0.1, xe, yb + 0.02, 0.16, M); W.box(-xe, yb - 0.02, H - 0.22, xe, yb + 0.02, H - 0.16, M);
    G.quad([-xe, yb, 0.16], [xe, yb, 0.16], [xe, yb, H - 0.22], [-xe, yb, H - 0.22], gc, { a: ga, two: true, mode: 1 });
    for (const sx of [-1, 1]) G.quad([sx * xe, yb, 0.16], [sx * xe, D * 0.2, 0.16], [sx * xe, D * 0.2, H - 0.22], [sx * xe, yb, H - 0.22], gc, { a: ga, two: true, mode: 1 });
    // a bench inside, and the timetable case
    const own = (C.detail.props || []).some((q) => q && q.kind === 'bench' && q.xy && Math.hypot(q.xy[0] - W.o.x, q.xy[1] - W.o.y) < L / 2 + 0.3);
    if (!own) {
      W.box(-L / 2 + 0.5, yb + 0.1, 0.42, L / 2 - 1.1, yb + 0.48, 0.47, pal.wood, { top: mix(pal.wood, WHITE, C.dark ? 0.04 : 0.14), bottom: true });
      for (const bx of [-L / 2 + 0.75, L / 2 - 1.35]) W.box(bx - 0.03, yb + 0.2, 0, bx + 0.03, yb + 0.4, 0.42, M);
    }
    W.box(L / 2 - 0.95, yb + 0.03, 0.75, L / 2 - 0.2, yb + 0.1, 1.95, tone(M, 0.85));
    W.quad([L / 2 - 0.9, yb + 0.102, 0.8], [L / 2 - 0.25, yb + 0.102, 0.8], [L / 2 - 0.25, yb + 0.102, 1.9], [L / 2 - 0.9, yb + 0.102, 1.9], C.dark ? hex('#E9E3CF') : hex('#FAF8F1'), { n: [0, 1, 0], mode: C.dark ? 1 : 0 });
    if (C.dark) W.quad([-L / 2 + 0.3, -0.1, H - 0.002], [L / 2 - 0.3, -0.1, H - 0.002], [L / 2 - 0.3, 0.1, H - 0.002], [-L / 2 + 0.3, 0.1, H - 0.002], pal.lens, { n: [0, 0, -1], mode: 1 });
    return { rx: L / 2 + 0.45, ry: D / 2 + 0.5, a: 1.0 };
  };
  PROPS.clock = function (C, p, W) {
    // the station clock: white face, black hands, the red second hand with its disc
    const pal = C.pal, H = or(p.height, 3.6), r = or(p.width, 0.8) / 2, M = pal.metal, dk = tone(pal.metal, 0.35), seg = C.high ? 18 : 10, t = 0.07;
    const face = C.dark ? hex('#F1EBD6') : hex('#FCFBF6'), red = hex(C.dark ? '#C24A3E' : '#E0473A'), zc = H - r;
    W.lathe(0, 0, 0, [[0.09, 0], [0.09, 0.3], [0.06, 0.36]], C.high ? 8 : 5, tone(M, 0.9), { facet: false });
    W.cyl(0, 0, 0.36, zc - r + 0.02, 0.06, 0.05, C.high ? 8 : 5, M);
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * TAU, a1 = ((k + 1) / seg) * TAU, am = (a0 + a1) / 2;
      W.quad([Math.cos(a0) * r, -t, zc + Math.sin(a0) * r], [Math.cos(a1) * r, -t, zc + Math.sin(a1) * r], [Math.cos(a1) * r, t, zc + Math.sin(a1) * r], [Math.cos(a0) * r, t, zc + Math.sin(a0) * r], dk, { n: [Math.cos(am), 0, Math.sin(am)] });
    }
    for (const s of [1, -1]) {
      const y = s * (t + 0.001), ring = [], inner = [];
      for (let k = 0; k < seg; k++) { const a = (k / seg) * TAU; ring.push([Math.cos(a) * r, y, zc + Math.sin(a) * r]); inner.push([Math.cos(a) * r * 0.9, y + s * 0.002, zc + Math.sin(a) * r * 0.9]); }
      W.fan(ring, dk, { n: [0, s, 0] });
      W.fan(inner, face, { n: [0, s, 0], mode: C.dark ? 1 : 0 });
      const hand = (deg, len, w, col, lift, tail) => {
        const a = deg * RAD, dx = Math.sin(a) * s, dz = Math.cos(a), px = Math.cos(a) * s, pz = -Math.sin(a), yy = y + s * lift;
        const P = (u, q) => [dx * u + px * q, yy, zc + dz * u + pz * q];
        W.quad(P(-tail, -w), P(len, -w), P(len, w), P(-tail, w), col, { n: [0, s, 0], mode: 1 });
      };
      if (C.high) for (let k = 0; k < 12; k++) hand(k * 30, r * 0.84, r * (k % 3 ? 0.018 : 0.035), dk, 0.004, -r * (k % 3 ? 0.7 : 0.62));
      hand(305, r * 0.5, r * 0.05, dk, 0.006, r * 0.12);
      hand(60, r * 0.76, r * 0.04, dk, 0.008, r * 0.12);
      hand(205, r * 0.6, r * 0.014, red, 0.01, r * 0.18);
      const disc = [];
      for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU, c = [Math.sin(205 * RAD) * s * r * 0.6, Math.cos(205 * RAD) * r * 0.6]; disc.push([c[0] + Math.cos(a) * r * 0.07, y + s * 0.011, zc + c[1] + Math.sin(a) * r * 0.07]); }
      W.fan(disc, red, { n: [0, s, 0], mode: 1 });
    }
    return { rx: 0.3, ry: 0.3, a: 1.2 };
  };
  PROPS.statue = function (C, p, W) {
    const pal = C.pal, v = String(p.variant || '').toLowerCase(), H = or(p.height, 4.4), L = or(p.length, 1.7), D = or(p.width, L);
    const given = hex(p.plinthColor), metal = hex(p.color);
    const st = given && !C.dark ? mix(pal.stone, given, 0.4) : mix(pal.stone, hex(C.dark ? '#4A4442' : '#D9CCC2'), 0.5), lt = mix(st, WHITE, C.dark ? 0.08 : 0.3), a = L / 2, b = D / 2;
    const bronze = metal && !C.dark ? mix(pal.bronze, metal, 0.5) : pal.bronze;
    if (/obelisk|column|säule|saeule|stele/.test(v)) {
      W.box(-a, -b, 0, a, b, 0.25, tone(st, 0.94), { top: lt });
      W.lathe(0, 0, 0.25, [[a * 0.62, 0], [a * 0.4, H - 0.75], [0, H - 0.25, lt]], 4, st, { phase: Math.PI / 4 });
      return { rx: a + 0.4, ry: b + 0.4, a: 1.2 };
    }
    const bust = /bust|büste|bueste/.test(v), hp = clamp(or(p.plinthHeight, bust ? H * 0.72 : H * 0.48), 0.3, H - 0.3);
    // a block that may narrow upwards: half sizes a·k0 × b·k0 at the bottom, a·k1 × b·k1 at the top
    const block = (z0, z1, k0, k1, col, top) => {
      const q = (k, z) => [[-a * k, -b * k, z], [a * k, -b * k, z], [a * k, b * k, z], [-a * k, b * k, z]], lo = q(k0, z0), hi = q(k1, z1), hint = [[0, -1, 0], [1, 0, 0], [0, 1, 0], [-1, 0, 0]];
      for (let i = 0; i < 4; i++) W.quad(lo[i], lo[(i + 1) % 4], hi[(i + 1) % 4], hi[i], [tone(col, 0.94), tone(col, 0.94), col, col], { n: hint[i] });
      W.quad(hi[0], hi[1], hi[2], hi[3], top || lt, { n: [0, 0, 1] });
      W.quad(lo[0], lo[1], lo[2], lo[3], tone(col, 0.8), { n: [0, 0, -1] });
    };
    if (L >= 2.4 && hp >= 2.4) {
      // a monument: steps, a base, the tapering die with its inscription, a cornice
      const hs = Math.min(0.9, hp * 0.17), s = hs / 3, z1 = hs + hp * 0.13, z2 = hp - Math.min(0.75, hp * 0.16);
      block(0, s, 1, 1, tone(st, 0.95)); block(s, 2 * s, 0.9, 0.9, tone(st, 0.97)); block(2 * s, hs, 0.8, 0.8, st);
      block(hs, z1, 0.7, 0.68, st); block(z1, z1 + 0.12, 0.72, 0.7, lt);
      block(z1 + 0.12, z2, 0.6, 0.47, st);
      block(z2, z2 + (hp - z2) * 0.3, 0.5, 0.56, lt); block(z2 + (hp - z2) * 0.3, z2 + (hp - z2) * 0.62, 0.58, 0.58, st); block(z2 + (hp - z2) * 0.62, hp, 0.5, 0.42, st);
      // on the front: the lines of the inscription and a bronze trophy below them
      const dz = z2 - z1 - 0.12, fy = (z) => b * lerp(0.6, 0.47, (z - z1 - 0.12) / dz) + 0.012, red = mix(hex(C.dark ? '#6A3A34' : '#B5564A'), st, 0.25);
      [[0.74, 0.32, 0.05], [0.64, 0.5, 0.075], [0.53, 0.36, 0.045]].forEach((ln) => {
        const z = z1 + 0.12 + dz * ln[0];
        W.quad([-a * ln[1], fy(z), z - ln[2]], [a * ln[1], fy(z), z - ln[2]], [a * ln[1], fy(z + ln[2]), z + ln[2]], [-a * ln[1], fy(z + ln[2]), z + ln[2]], red, { n: [0, 1, 0] });
      });
      const zt = z1 + 0.12 + dz * 0.22;
      W.lump([0, fy(zt) + 0.05, zt], [a * 0.3, 0.14, dz * 0.11], 2, 0.25, 5, () => bronze);
      W.lump([0, fy(zt + dz * 0.13) + 0.05, zt + dz * 0.13], [a * 0.12, 0.12, dz * 0.07], 1, 0.1, 6, () => mix(bronze, WHITE, 0.08));
      W.tube([[-a * 0.42, fy(zt) + 0.07, zt - dz * 0.05, 0.035], [a * 0.42, fy(zt) + 0.07, zt + dz * 0.04, 0.03]], 4, bronze, { cap: true });
    } else {
      W.box(-a - 0.28, -b - 0.28, 0, a + 0.28, b + 0.28, 0.18, tone(st, 0.92), { top: lt });
      W.box(-a - 0.1, -b - 0.1, 0.18, a + 0.1, b + 0.1, 0.36, tone(st, 0.96), { top: lt });
      block(0.36, hp - 0.18, 0.84, 0.84, st);
      W.box(-a * 0.96, -b * 0.96, hp - 0.18, a * 0.96, b * 0.96, hp, st, { top: lt, bottom: true });
      W.quad([-a * 0.5, b * 0.84 + 0.004, 0.36 + (hp - 0.54) * 0.3], [a * 0.5, b * 0.84 + 0.004, 0.36 + (hp - 0.54) * 0.3], [a * 0.5, b * 0.84 + 0.004, 0.36 + (hp - 0.54) * 0.75], [-a * 0.5, b * 0.84 + 0.004, 0.36 + (hp - 0.54) * 0.75], mix(pal.bronze, st, 0.35), { n: [0, 1, 0] });
    }
    if (bust) {
      const h = H - hp;
      W.lathe(0, 0, hp, [[0.5 * h, 0], [0.55 * h, 0.3 * h], [0.2 * h, 0.5 * h], [0.16 * h, 0.58 * h]], C.high ? 9 : 6, pal.bronze, { facet: false });
      W.lump([0, 0, hp + 0.78 * h], [0.2 * h, 0.22 * h, 0.24 * h], 2, 0.03, 2, () => mix(pal.bronze, WHITE, 0.1));
    } else figure(C, W, 0, 0, hp, H - hp, bronze);
    return { rx: a + 0.55, ry: b + 0.55, a: 1.2 };
  };
  PROPS['ticket-machine'] = function (C, p, W) {
    // a ticket machine: a column with a screen, a red band on top
    const pal = C.pal, H = or(p.height, 1.75), w = or(p.length, 0.72) / 2, d = or(p.width, 0.46) / 2, body = mix(pal.steel, pal.metal, 0.35), dk = tone(pal.metal, 0.55);
    W.box(-w, -d, 0, w, d, 0.1, dk);
    W.box(-w, -d, 0.1, w, d, H - 0.16, body, { top: mix(body, WHITE, 0.15) });
    W.box(-w - 0.01, -d - 0.01, H - 0.16, w + 0.01, d + 0.01, H, pal.hydrant, { top: mix(pal.hydrant, WHITE, 0.15), bottom: true });
    const f = d + 0.004;
    W.quad([-w * 0.82, f, 0.55], [w * 0.82, f, 0.55], [w * 0.82, f, H - 0.24], [-w * 0.82, f, H - 0.24], dk, { n: [0, 1, 0] });
    const scr = C.dark ? hex('#BFD9F2') : hex('#CFE3F2');
    W.quad([-w * 0.6, f + 0.003, 1.12], [w * 0.6, f + 0.003, 1.12], [w * 0.6, f + 0.003, H - 0.34], [-w * 0.6, f + 0.003, H - 0.34], [scr, scr, tone(scr, 0.85), tone(scr, 0.85)], { n: [0, 1, 0], mode: C.dark ? 1 : 0 });
    W.quad([-w * 0.6, f + 0.003, 0.68], [w * 0.1, f + 0.003, 0.68], [w * 0.1, f + 0.003, 0.98], [-w * 0.6, f + 0.003, 0.98], tone(pal.steel, 0.9), { n: [0, 1, 0] });
    W.quad([w * 0.25, f + 0.003, 0.68], [w * 0.6, f + 0.003, 0.68], [w * 0.6, f + 0.003, 0.98], [w * 0.25, f + 0.003, 0.98], tone(pal.metal, 0.3), { n: [0, 1, 0] });
    return { rx: w + 0.3, ry: d + 0.3, a: 1.25 };
  };
  const ALIAS = { 'street-lamp': 'lamp', streetlamp: 'lamp', 'street_lamp': 'lamp', 'waste-basket': 'bin', 'waste_basket': 'bin', 'bicycle-parking': 'bike-stand', 'bike-rack': 'bike-stand', sign: 'sign-post', signpost: 'sign-post', monument: 'statue', mast: 'pole', 'bus-shelter': 'shelter' };
  // Where the wire of a hanging lamp is fixed: the nearest house fronts on both sides of it (trams hang their
  // span wires the same way). heading given: the wire runs across it. null if there are no two houses in reach.
  function spanWire(C, x, y, z, heading) {
    const hit = (dx, dy) => {
      for (let d = 1; d <= 70; d += 0.5) {
        const px = x + dx * d, py = y + dy * d;
        for (const r of C.rings) if (r && px >= r.box[0] && px <= r.box[2] && py >= r.box[1] && py <= r.box[3] && inRing(r, px, py)) return d;
      }
      return 0;
    };
    let best = null;
    const dirs = [];
    if (heading != null) dirs.push(heading + 90); else for (let a = 0; a < 180; a += 10) dirs.push(a);
    for (const deg of dirs) {
      const dx = Math.sin(deg * RAD), dy = Math.cos(deg * RAD), d1 = hit(dx, dy), d2 = hit(-dx, -dy);
      if (d1 && d2 && d1 + d2 < 95 && (!best || d1 + d2 < best.len)) best = { len: d1 + d2, a: [x + dx * d1, y + dy * d1, z + 0.045 * d1], b: [x - dx * d2, y - dy * d2, z + 0.045 * d2] };
    }
    return best;
  }
  function buildProp(C, p) {
    const xy = p.xy;
    if (!xy || !isFinite(xy[0]) || !isFinite(xy[1])) return;
    const kind = ALIAS[p.kind] || p.kind, fn = PROPS[kind];
    if (!fn) { C.warn('prop kind "' + p.kind + '" is not known'); return; }
    const x = +xy[0], y = +xy[1], z = num(p.z) != null ? p.z : groundZ(C, x, y), h = or(p.heading, or(p.axis, 0));
    if (p.heading == null && p.axis != null) p = Object.assign({}, p, { heading: p.axis });
    let fx = x, fy = y, fz = z;
    if (kind === 'sign-post' && (p.mount || /mounted|on a (tram )?(pole|mast)/i.test(p.variant || ''))) {
      // a sign strapped to a mast: it goes where the mast is, and brings no pole of its own
      let best = null;
      for (const q of C.detail.props || []) {
        if (!q || (ALIAS[q.kind] || q.kind) !== 'pole' || !q.xy) continue;
        const d = Math.hypot(q.xy[0] - x, q.xy[1] - y);
        if (d < 1.2 && (!best || d < best.d)) best = { d, q };
      }
      if (best) {
        const q = best.q, tall = /tram|mast|fahrleit|span/i.test(q.variant || '') && or(q.height, 6) > 5.5;
        fx = q.xy[0]; fy = q.xy[1]; fz = num(q.z) != null ? q.z : groundZ(C, fx, fy);
        p = Object.assign({}, p, { _host: or(q.width, tall ? 0.3 : 0.15) / 2 });
      }
    }
    if (kind === 'lamp' && /wire|hung|hang|suspend|catenary|seil|pendant|cable/i.test(p.variant || '')) {
      const sp = spanWire(C, x, y, z + or(p.height, 7) + 0.28, num(p.heading));
      if (sp) p = Object.assign({}, p, { _span: sp });
    }
    const W = C.W.solid.frame(fx, fy, fz, h);
    const sh = fn(C, p, W, rng(seedOf(x, y, 2)), fx, fy, fz);
    if (sh && !p._host) blob(C, fx, fy, sh.rx, sh.ry, h, sh.a, fz);
    C.counts.props++;
    if (C.dark) for (const l of lightsOf(p)) {
      const P = C.W.solid.frame(x, y, z, h).P(l.at);
      if (l.glow) C.glows.push({ p: P, size: 1.5 * l.glow, a: 0.8 }, { p: P, size: 0.42 * l.glow, a: 1 });
      pool(C, P[0], P[1], Math.max(3.2, (P[2] - z) * 1.5), (P[2] - z > 7 ? 0.5 : 0.42) * l.power, z);
    }
  }

  // ---------- buildings ----------
  // A colour from the data, fitted to the theme: by day nearly as given, at night the palette's dark tone tinted by it
  function themed(C, given, def) {
    const g = hex(given);
    if (!g) return def;
    if (!C.dark) return mix(g, def, 0.42); // the real tone, softened towards the palette so houses stay one family
    const l = Math.max(lum(g), 0.05), k = lum(def) * (0.7 + 0.55 * l);
    return mix(def, [g[0] / l * k, g[1] / l * k, g[2] / l * k], 0.6);
  }
  // The shape of a pitched roof over a footprint: height above the eaves at any point, the flat pieces it is
  // made of, and the lines where it folds (walls are split there, so they meet the roof without gaps).
  function roofModel(type, ring, H, dirDeg) {
    let ang;
    if (num(dirDeg) != null) ang = (90 - dirDeg) * RAD;
    else { let best = 0; ang = 0; for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l > best) { best = l; ang = Math.atan2(b[1] - a[1], b[0] - a[0]); } } }
    const ux = Math.cos(ang), uy = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of ring) { const u = p[0] * ux + p[1] * uy, v = -p[0] * uy + p[1] * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2, a = (u1 - u0) / 2, b = (v1 - v0) / 2;
    const toUV = (p) => [p[0] * ux + p[1] * uy - cu, -p[0] * uy + p[1] * ux - cv];
    const toXY = (u, v) => [(u + cu) * ux - (v + cv) * uy, (u + cu) * uy + (v + cv) * ux];
    // distance to each eaves line, as [ku, kv, k0]
    const E = type === 'gabled' ? [[0, -1, b], [0, 1, b]] : [[0, -1, b], [0, 1, b], [-1, 0, a], [1, 0, a]];
    const m = type === 'gabled' ? b : Math.min(a, b);
    const prof = type === 'mansard' ? [[0, 0], [Math.min(1.3, m * 0.32), H * 0.68], [m, H]] : [[0, 0], [m, H]];
    const hOfE = (e) => { e = clamp(e, 0, m); for (let i = 0; i + 1 < prof.length; i++) if (e <= prof[i + 1][0] + 1e-9) return lerp(prof[i][1], prof[i + 1][1], (e - prof[i][0]) / ((prof[i + 1][0] - prof[i][0]) || 1)); return H; };
    const hAt = (u, v) => { let e = Infinity; for (const f of E) e = Math.min(e, f[0] * u + f[1] * v + f[2]); return hOfE(e); };
    const folds = [];
    for (let j = 0; j < E.length; j++) for (let k = j + 1; k < E.length; k++) folds.push([E[j][0] - E[k][0], E[j][1] - E[k][1], E[j][2] - E[k][2]]);
    for (const f of E) for (let i = 1; i + 1 < prof.length; i++) folds.push([f[0], f[1], f[2] - prof[i][0]]);
    return { E, prof, hAt, hOfE, toUV, toXY, folds, a, b, m, ux, uy };
  }
  function buildBuilding(C, b, index) {
    const pal = C.pal, W = C.W.bld.world(), THREE = C.THREE;
    const ring = cleanRing(b.ring);
    const mesh = b.mesh && Array.isArray(b.mesh.positions) && b.mesh.positions.length >= 9 ? b.mesh : null;
    if (!ring && !mesh) { C.warn('building ' + index + ': neither ring nor mesh'); return; }
    const holes = ring ? (b.holes || []).map(cleanRing).filter(Boolean) : [];
    const seedP = ring ? ring[0] : [mesh.positions[0], mesh.positions[1]], R = rng(seedOf(seedP[0], seedP[1], 4));
    C.counts.buildings++;

    // the triangles of a given mesh, and what they tell about the heights
    const mt = [];
    let mz0 = Infinity, mz1 = -Infinity, mcx = 0, mcy = 0;
    if (mesh) {
      const P = mesh.positions, I = Array.isArray(mesh.indices) && mesh.indices.length ? mesh.indices : null, n = I ? I.length : P.length / 3;
      for (let i = 0; i + 2 < n; i += 3) {
        const ia = I ? I[i] : i, ib = I ? I[i + 1] : i + 1, ic = I ? I[i + 2] : i + 2;
        const A = [P[ia * 3], P[ia * 3 + 1], P[ia * 3 + 2]], B = [P[ib * 3], P[ib * 3 + 1], P[ib * 3 + 2]], D = [P[ic * 3], P[ic * 3 + 1], P[ic * 3 + 2]];
        if (!A.concat(B, D).every(isFinite)) continue;
        const nn = cross(sub(B, A), sub(D, A)), ar = Math.hypot(nn[0], nn[1], nn[2]) / 2;
        if (ar < 1e-6) continue;
        mt.push({ A, B, D, n: [nn[0] / ar / 2, nn[1] / ar / 2, nn[2] / ar / 2], ar });
        for (const q of [A, B, D]) { mz0 = Math.min(mz0, q[2]); mz1 = Math.max(mz1, q[2]); mcx += q[0]; mcy += q[1]; }
      }
      if (!mt.length) { C.warn('building ' + index + ': mesh has no usable triangles'); if (!ring) return; }
      else { mcx /= mt.length * 3; mcy /= mt.length * 3; }
    }
    const isMesh = mt.length > 0;
    const gz = ring ? ring.map((p) => C.ground.at(p[0], p[1])).filter((v) => v != null) : [];
    const base = num(b.base) != null ? b.base : gz.length ? Math.min(...gz) : isMesh ? mz0 : C.z0;
    let eaves = num(b.eaves);
    if (eaves == null && isMesh) { // where most walls end
      const tops = mt.filter((t) => Math.abs(t.n[2]) < 0.3).map((t) => [Math.max(t.A[2], t.B[2], t.D[2]), t.ar]).sort((p, q) => p[0] - q[0]);
      let sum = 0, half = tops.reduce((s, t) => s + t[1], 0) * 0.5;
      eaves = mz1;
      for (const t of tops) { sum += t[1]; if (sum >= half) { eaves = t[0]; break; } }
    }
    if (eaves == null) eaves = base + (num(b.floors) || 4) * 3.1 + 0.6;
    if (eaves < base + 2.4) eaves = base + 2.4;
    let type = ['flat', 'gabled', 'hipped', 'mansard'].includes(b.roof) ? b.roof : num(b.ridge) != null && b.ridge > eaves + 0.6 ? 'gabled' : 'flat';
    if (holes.length && type !== 'flat') type = 'flat';
    let ridge = num(b.ridge);
    const wallC = themed(C, b.color, pal.wall), trim = mix(wallC, pal.trim, 0.7);
    const roofC = themed(C, b.roofColor, type === 'flat' ? pal.roof : pal.roofTile);
    const zBot = Math.min(base, gz.length ? Math.min(...gz) : base) - 0.4;
    const parapet = type === 'flat' && !isMesh ? 0.45 : 0, wallTop = eaves + parapet;
    const wallAt = (col, z) => tone(col, lerp(0.95, 1.02, sat((z - base) / Math.max(1, eaves - base))));
    const cen = ring ? centroid(ring) : [mcx, mcy];
    const inOther = (x, y) => C.rings.some((r, i) => i !== index && r && x >= r.box[0] && x <= r.box[2] && y >= r.box[1] && y <= r.box[3] && inRing(r, x, y));

    // ----- runs: stretches of wall that are straight, each laid out as one front -----
    const runs = [];
    if (ring) {
      const n = ring.length, E = [];
      for (let i = 0; i < n; i++) {
        const a = ring[i], q = ring[(i + 1) % n], l = Math.hypot(q[0] - a[0], q[1] - a[1]);
        E.push({ i, a, b: q, len: l, t: [(q[0] - a[0]) / l, (q[1] - a[1]) / l], n: [(q[1] - a[1]) / l, -(q[0] - a[0]) / l], gaps: [] });
      }
      const corner = (i) => { const p = E[(i - 1 + n) % n].t, q = E[i].t; return Math.abs(p[0] * q[1] - p[1] * q[0]) > 0.1 || p[0] * q[0] + p[1] * q[1] < 0; };
      let start = 0;
      while (start < n && !corner(start)) start++;
      const all = start === n;
      for (let k = 0; k < n; k++) {
        const i = (start + k) % n, e = E[i];
        if (all || corner(i) || !runs.length) runs.push({ edges: [e], A: e.a, B: e.b });
        else { const r = runs[runs.length - 1]; r.edges.push(e); r.B = e.b; }
      }
      for (const r of runs) {
        const dx = r.B[0] - r.A[0], dy = r.B[1] - r.A[1];
        r.len = Math.hypot(dx, dy) || 1e-6; r.t = [dx / r.len, dy / r.len]; r.n = [r.t[1], -r.t[0]];
      }
      runs.E = E;
    } else for (const f of b.faces || []) {
      if (!f || !f.a || !f.b) continue;
      const dx = f.b[0] - f.a[0], dy = f.b[1] - f.a[1], len = Math.hypot(dx, dy);
      if (len < 0.5) continue;
      const t = [dx / len, dy / len];
      let n = [t[1], -t[0]];
      // which side is outside: the heading of the face if given, else away from the middle of the house
      const out = num(f.heading) != null ? [Math.sin(f.heading * RAD), Math.cos(f.heading * RAD)] : [f.a[0] + dx / 2 - cen[0], f.a[1] + dy / 2 - cen[1]];
      if (out[0] * n[0] + out[1] * n[1] < 0) n = [-n[0], -n[1]];
      runs.push({ edges: [], A: f.a, B: f.b, len, t, n, spec: f });
    }
    for (const r of runs) {
      if (!r.spec) { // the entry of `faces` that describes this wall, if any
        let best = null;
        for (const f of b.faces || []) {
          if (!f || !f.a || !f.b) continue;
          const pd = (p) => Math.abs((p[0] - r.A[0]) * r.t[1] - (p[1] - r.A[1]) * r.t[0]);
          if (pd(f.a) > 0.8 || pd(f.b) > 0.8) continue;
          const sa = (f.a[0] - r.A[0]) * r.t[0] + (f.a[1] - r.A[1]) * r.t[1], sb = (f.b[0] - r.A[0]) * r.t[0] + (f.b[1] - r.A[1]) * r.t[1];
          const ov = Math.min(r.len, Math.max(sa, sb)) - Math.max(0, Math.min(sa, sb));
          if (ov < 0.5 * Math.min(r.len, Math.abs(sb - sa))) continue;
          if (!best || ov > best.ov) best = { f, ov };
        }
        r.spec = best ? best.f : {};
      }
      const s = r.spec, mx = (r.A[0] + r.B[0]) / 2 + r.n[0] * 0.35, my = (r.A[1] + r.B[1]) / 2 + r.n[1] * 0.35;
      r.party = inOther(mx, my);
      r.col = s.color ? themed(C, s.color, pal.wall) : wallC;
      r.floors = Math.max(1, Math.round(or(s.floors, or(b.floors, (eaves - base - 0.4) / 3.05))));
      r.kind = s.groundFloor || b.groundFloor || 'plain';
      r.bays = Math.max(1, Math.round(or(s.bays, r.len / 3.1)));
      const nom = (eaves - base - 0.35) / r.floors;
      r.gf = r.floors === 1 ? eaves - base - 0.35 : r.kind === 'arcade' ? clamp(nom * 1.3, 3.4, 4.8) : r.kind === 'shop' ? clamp(nom * 1.2, 3.2, 4.4) : nom;
      if (r.floors > 1 && eaves - base - 0.35 - r.gf < 2.3 * (r.floors - 1)) r.gf = nom;
      r.fh = r.floors > 1 ? (eaves - base - 0.35 - r.gf) / (r.floors - 1) : 0;
      r.deco = !r.party && r.len >= 2;
      r.Q = (s2, out, z) => [r.A[0] + r.t[0] * s2 + r.n[0] * out, r.A[1] + r.t[1] * s2 + r.n[1] * out, z];
      r.zg = (s2) => { const q = r.Q(s2, 0.35, 0), g = C.ground.at(q[0], q[1]); return g == null ? base : clamp(g, base - 1.5, base + 1.2); };
      // a real arcade needs room behind the front: how deep is the house here?
      r.arcade = false;
      if (r.kind === 'arcade' && r.deco && !isMesh && ring && r.len >= 3) {
        const o = r.Q(r.len / 2, -0.05, 0);
        let depth = Infinity;
        for (const e of runs.E) {
          const den = -r.n[0] * (e.b[1] - e.a[1]) + r.n[1] * (e.b[0] - e.a[0]);
          if (Math.abs(den) < 1e-9) continue;
          const tt = ((e.a[0] - o[0]) * (e.b[1] - e.a[1]) - (e.a[1] - o[1]) * (e.b[0] - e.a[0])) / den;
          const uu = ((e.a[0] - o[0]) * -r.n[1] - (e.a[1] - o[1]) * -r.n[0]) / den;
          if (tt > 0.01 && uu >= 0 && uu <= 1) depth = Math.min(depth, tt);
        }
        r.D = Math.min(or(b.arcadeDepth, 3.2), depth * 0.45);
        r.arcade = r.D >= 1.3;
        r.pd = 0.55;
      }
    }
    // an arcade passes through the side walls at both ends, so walkways of neighbours join up
    if (ring) for (const r of runs) {
      if (!r.arcade) continue;
      for (const e of r.edges) e.gaps.push({ s0: 0, s1: e.len, top: base + r.gf });
      const n = ring.length, first = r.edges[0], last = r.edges[r.edges.length - 1];
      const prev = runs.E[(first.i - 1 + n) % n], next = runs.E[(last.i + 1) % n];
      const side = (e) => Math.abs(e.t[0] * r.t[0] + e.t[1] * r.t[1]) < 0.5 && !runs.some((q) => q.arcade && q.edges.includes(e));
      r.openA = side(prev) && prev.t[0] * r.t[1] - prev.t[1] * r.t[0] > 0;
      r.openB = side(next) && r.t[0] * next.t[1] - r.t[1] * next.t[0] > 0;
      if (r.openA) prev.gaps.push({ s0: Math.max(0, prev.len - r.D), s1: prev.len - r.pd, top: base + r.gf - 0.35 });
      if (r.openB) next.gaps.push({ s0: r.pd, s1: Math.min(next.len, r.D), top: base + r.gf - 0.35 });
    }

    // ----- walls and roof of the plain prism -----
    if (ring && !isMesh) {
      const rm = type === 'flat' ? null : roofModel(type, ring, Math.max(0.6, (ridge != null ? ridge : eaves + Math.min(5, 0.4 * Math.sqrt(Math.abs(area2(ring))))) - eaves), b.ridgeDir);
      const hUV = (p) => (rm ? rm.hAt(...rm.toUV(p)) : 0);
      const wall = (e, col, out) => {
        const P = (s, z) => [e.a[0] + e.t[0] * s, e.a[1] + e.t[1] * s, z], hint = [e.n[0] * out, e.n[1] * out, 0];
        const piece = (s0, s1, z0) => { if (s1 - s0 > 1e-4) W.quad(P(s0, z0), P(s1, z0), P(s1, wallTop), P(s0, wallTop), [wallAt(col, z0), wallAt(col, z0), wallAt(col, wallTop), wallAt(col, wallTop)], { n: hint }); };
        let s = 0;
        for (const g of e.gaps.slice().sort((p, q) => p.s0 - q.s0)) { piece(s, g.s0, zBot); piece(Math.max(s, g.s0), g.s1, g.top); s = Math.max(s, g.s1); }
        piece(s, e.len, zBot);
        if (rm) { // the gable: the wall above the eaves, up to the roof
          const pa = rm.toUV(e.a), pb = rm.toUV(e.b), ts = [0, 1];
          for (const f of rm.folds) { const fa = f[0] * pa[0] + f[1] * pa[1] + f[2], fb = f[0] * pb[0] + f[1] * pb[1] + f[2]; if (fa * fb < 0) ts.push(fa / (fa - fb)); }
          ts.sort((p, q) => p - q);
          for (let k = 0; k + 1 < ts.length; k++) {
            if (ts[k + 1] - ts[k] < 1e-6) continue;
            const s0 = ts[k] * e.len, s1 = ts[k + 1] * e.len, h0 = hUV(P(s0, 0)), h1 = hUV(P(s1, 0));
            if (Math.max(h0, h1) > 0.02) W.quad(P(s0, eaves), P(s1, eaves), P(s1, eaves + h1), P(s0, eaves + h0), wallAt(col, eaves), { n: hint });
          }
          e.gable = Math.max(hUV(e.a), hUV(e.b)) > 0.05;
        }
      };
      for (const r of runs) for (const e of r.edges) wall(e, r.col, 1);
      for (const h of holes) for (let i = 0; i < h.length; i++) { // courtyard walls look inwards
        const a = h[i], q = h[(i + 1) % h.length], l = Math.hypot(q[0] - a[0], q[1] - a[1]);
        if (l > 1e-4) wall({ a, b: q, len: l, t: [(q[0] - a[0]) / l, (q[1] - a[1]) / l], n: [(q[1] - a[1]) / l, -(q[0] - a[0]) / l], gaps: [] }, wallC, -1);
      }
      if (!rm) {
        const all = ring.concat(...holes);
        for (const t of triangulate(THREE, ring, holes)) W.tri([all[t[0]][0], all[t[0]][1], eaves], [all[t[1]][0], all[t[1]][1], eaves], [all[t[2]][0], all[t[2]][1], eaves], roofC, { n: [0, 0, 1] });
        // the parapet: a rim around the flat roof
        const fr = lineFrames(ring, true), top = mix(wallC, pal.trim, 0.6), inner = tone(wallC, 0.82);
        for (let i = 0; i < fr.length; i++) {
          const j = (i + 1) % fr.length, a = fr[i].p, q = fr[j].p, ia = offPt(fr[i], 0.3), iq = offPt(fr[j], 0.3), e = runs.E[i];
          W.quad([a[0], a[1], wallTop], [q[0], q[1], wallTop], [iq[0], iq[1], wallTop], [ia[0], ia[1], wallTop], top, { n: [0, 0, 1] });
          W.quad([ia[0], ia[1], eaves], [iq[0], iq[1], eaves], [iq[0], iq[1], wallTop], [ia[0], ia[1], wallTop], inner, { n: [-e.n[0], -e.n[1], 0] });
        }
        if (C.high && Math.abs(area2(ring)) > 90 && !holes.length && inRing(ring, cen[0], cen[1])) { // the lift overrun
          const ax = longAxis(ring), ux = ax.ux, uy = ax.uy, o = (R() - 0.5) * 0.3 * ax.len;
          W.obox([cen[0] + ux * o, cen[1] + uy * o, eaves + 0.75], [ux * 1.5, uy * 1.5, 0], [-uy * 1.1, ux * 1.1, 0], [0, 0, 0.75], tone(wallC, 0.97), { top: mix(roofC, WHITE, 0.15), skip: '-z' });
        }
      } else {
        const uv = ring.map(rm.toUV);
        for (let k = 0; k < rm.E.length; k++) for (let i = 0; i + 1 < rm.prof.length; i++) {
          let poly = uv;
          for (let j = 0; j < rm.E.length && poly.length >= 3; j++) if (j !== k) poly = clipPoly(poly, rm.E[j][0] - rm.E[k][0], rm.E[j][1] - rm.E[k][1], rm.E[j][2] - rm.E[k][2]);
          if (poly.length >= 3) poly = clipPoly(poly, rm.E[k][0], rm.E[k][1], rm.E[k][2] - rm.prof[i][0]);
          if (poly.length >= 3 && i + 2 < rm.prof.length) poly = clipPoly(poly, -rm.E[k][0], -rm.E[k][1], rm.prof[i + 1][0] - rm.E[k][2]);
          poly = cleanRing(poly);
          if (!poly) continue;
          const P = (q) => { const xy = rm.toXY(q[0], q[1]); return [xy[0], xy[1], eaves + rm.hOfE(rm.E[k][0] * q[0] + rm.E[k][1] * q[1] + rm.E[k][2])]; };
          for (const t of triangulate(THREE, poly)) W.tri(P(poly[t[0]]), P(poly[t[1]]), P(poly[t[2]]), roofC, { n: [0, 0, 1] });
        }
        if (C.high) { // chimneys near the ridge
          const nc = 1 + (R() < 0.5 ? 1 : 0), span = type === 'gabled' ? rm.a : Math.max(0, rm.a - rm.b), cc = mix(wallC, roofC, 0.35);
          for (let i = 0; i < nc; i++) {
            const u = (nc === 1 ? (R() - 0.5) : (i ? 1 : -1) * (0.3 + R() * 0.4)) * span * 0.9, v = (R() < 0.5 ? -1 : 1) * Math.min(0.9, rm.m * 0.25), xy = rm.toXY(u, v);
            if (!inRing(ring, xy[0], xy[1])) continue;
            const zt = eaves + rm.hAt(u, 0) + 0.75, zb2 = eaves + rm.hAt(u, v) - 0.4;
            W.obox([xy[0], xy[1], (zt + zb2) / 2], [rm.ux * 0.42, rm.uy * 0.42, 0], [-rm.uy * 0.3, rm.ux * 0.3, 0], [0, 0, (zt - zb2) / 2], cc, { top: tone(cc, 0.7), skip: '-z' });
          }
        }
        if (C.high && type === 'mansard') { // dormers in the steep part
          const w1 = rm.prof[1][0], h1 = rm.prof[1][1], s1 = h1 / w1;
          for (const sg of [1, -1]) {
            const n = Math.max(1, Math.round(rm.a * 2 / 3.2) - 1);
            for (let i = 0; i < n; i++) {
              const u = (n === 1 ? 0 : -1 + (2 * i) / (n - 1)) * (rm.a - 2.2), e0 = 0.22, zb2 = eaves + s1 * e0, zt = Math.min(eaves + h1 + 0.25, zb2 + 1.35), e1 = Math.min(w1 + 0.6, (zt - eaves) / s1 + 0.1);
              const c = rm.toXY(u, sg * (rm.b - (e0 + e1) / 2)), fx = -rm.uy * sg, fy = rm.ux * sg;
              if (!inRing(ring, c[0], c[1])) continue;
              W.obox([c[0], c[1], (zb2 + zt) / 2], [rm.ux * 0.6, rm.uy * 0.6, 0], [fx * (e1 - e0) / 2, fy * (e1 - e0) / 2, 0], [0, 0, (zt - zb2) / 2], tone(wallC, 0.98), { top: tone(roofC, 0.92), skip: '-z-y' });
              const f = rm.toXY(u, sg * (rm.b - e0 + 0.012)), lit = C.dark && R() < 0.3;
              W.quad([f[0] - rm.ux * 0.4, f[1] - rm.uy * 0.4, zb2 + 0.25], [f[0] + rm.ux * 0.4, f[1] + rm.uy * 0.4, zb2 + 0.25], [f[0] + rm.ux * 0.4, f[1] + rm.uy * 0.4, zt - 0.2], [f[0] - rm.ux * 0.4, f[1] - rm.uy * 0.4, zt - 0.2], lit ? pal.glassLit : pal.glass, { n: [fx, fy, 0], mode: lit ? 1 : 0 });
            }
          }
        }
      }
    }
    // ----- a given mesh: real geometry, walls and roofs told apart by their slope -----
    if (isMesh) {
      C.meshBuildings = true;
      for (const t of mt) {
        let n = t.n, flip = false;
        const mid = [(t.A[0] + t.B[0] + t.D[0]) / 3, (t.A[1] + t.B[1] + t.D[1]) / 3];
        let col;
        if (Math.abs(n[2]) < 0.3) {
          const inwards = ring ? inRing(ring, mid[0] + n[0] * 0.25, mid[1] + n[1] * 0.25) && !inRing(ring, mid[0] - n[0] * 0.25, mid[1] - n[1] * 0.25) : (mid[0] - cen[0]) * n[0] + (mid[1] - cen[1]) * n[1] < 0;
          flip = inwards;
          col = (P) => wallAt(wallC, P[2]);
        } else {
          flip = n[2] < 0 && (t.A[2] + t.B[2] + t.D[2]) / 3 > base + 2;
          col = n[2] < -0.3 && !flip ? tone(wallC, 0.7) : Math.abs(n[2]) > 0.985 ? (b.roofColor ? roofC : themed(C, null, pal.roof)) : (b.roofColor || type !== 'flat' ? roofC : pal.roofTile);
        }
        W.tri(t.A, t.B, t.D, col, { n: flip ? [-n[0], -n[1], -n[2]] : n });
      }
    }
    // the height of a mesh roof above a point (null beside the house)
    const roofTris = mt.filter((t) => Math.abs(t.n[2]) >= 0.3 && (t.A[2] + t.B[2] + t.D[2]) / 3 > base + 2);
    const roofZ = (x, y) => {
      let best = null;
      for (const t of roofTris) {
        const d = (t.B[0] - t.A[0]) * (t.D[1] - t.A[1]) - (t.B[1] - t.A[1]) * (t.D[0] - t.A[0]);
        if (Math.abs(d) < 1e-9) continue;
        const w1 = ((x - t.A[0]) * (t.D[1] - t.A[1]) - (y - t.A[1]) * (t.D[0] - t.A[0])) / d, w2 = ((t.B[0] - t.A[0]) * (y - t.A[1]) - (t.B[1] - t.A[1]) * (x - t.A[0])) / d;
        if (w1 < -1e-6 || w2 < -1e-6 || w1 + w2 > 1 + 1e-6) continue;
        const z = t.A[2] + (t.B[2] - t.A[2]) * w1 + (t.D[2] - t.A[2]) * w2;
        if (best == null || z > best) best = z;
      }
      return best;
    };
    // a dormer standing in a steep mesh roof, above the bay at s of a run
    const dormer = (r, s, RW) => {
      const f = r.Q(s, -0.55, 0), zf = roofZ(f[0], f[1]);
      if (zf == null || zf < eaves - 1.2) return;
      const zt = zf + 1.5;
      let depth = 0, zb2 = zf;
      for (let d = 0.95; d <= 4.3; d += 0.4) { const q = r.Q(s, -d, 0), z = roofZ(q[0], q[1]); if (z == null) break; depth = d; zb2 = z; if (z >= zt) break; }
      if (depth < 1.3 || zb2 - zf < 0.9) return;
      W.obox(r.Q(s, -(0.55 + depth) / 2, (zf + zt) / 2 - 0.1), [r.t[0] * 0.62, r.t[1] * 0.62, 0], [r.n[0] * (depth - 0.55) / 2, r.n[1] * (depth - 0.55) / 2, 0], [0, 0, (zt - zf) / 2 + 0.1], tone(wallC, 0.98), { top: tone(roofC, 0.9), skip: '-z-y' });
      const lit = C.dark && RW() < 0.3, g = lit ? pal.glassLit : pal.glass;
      W.quad(r.Q(s - 0.4, -0.538, zf + 0.3), r.Q(s + 0.4, -0.538, zf + 0.3), r.Q(s + 0.4, -0.538, zt - 0.22), r.Q(s - 0.4, -0.538, zt - 0.22), lit ? g : [mix(g, pal.sky, C.dark ? 0 : 0.4), mix(g, pal.sky, C.dark ? 0 : 0.4), g, g], { n: [r.n[0], r.n[1], 0], mode: lit ? 1 : 0 });
    };

    // ----- what is on the walls -----
    const off0 = isMesh ? 0.07 : 0;
    const shut = C.high && b.shutters ? (hex(b.shutters) && !C.dark ? mix(hex(b.shutters), pal.shutters[0], 0.3) : pal.shutters[Math.floor(R() * pal.shutters.length) % pal.shutters.length]) : null; // only where the data says so
    let budget = C.windowBudget;
    for (const r of runs) {
      if (!r.deco) continue;
      const Q = r.Q, nrm = [r.n[0], r.n[1], 0], tdir = [r.t[0], r.t[1], 0], gfTop = base + r.gf, RW = rng(seedOf(r.A[0], r.A[1], 9));
      const rect = (s0, s1, z0, z1, out, col, opt) => W.quad(Q(s0, off0 + out, z0), Q(s1, off0 + out, z0), Q(s1, off0 + out, z1), Q(s0, off0 + out, z1), col, Object.assign({ n: nrm }, opt));
      const ledge = (s0, s1, z0, z1, out, col, topCol) => { // a band that stands out from the wall
        rect(s0, s1, z0, z1, out, col);
        W.quad(Q(s0, off0, z1), Q(s1, off0, z1), Q(s1, off0 + out, z1), Q(s0, off0 + out, z1), topCol || col, { n: [0, 0, 1] });
        W.quad(Q(s0, off0, z0), Q(s1, off0, z0), Q(s1, off0 + out, z0), Q(s0, off0 + out, z0), tone(col, 0.8), { n: [0, 0, -1] });
        W.quad(Q(s0, off0, z0), Q(s0, off0 + out, z0), Q(s0, off0 + out, z1), Q(s0, off0, z1), col, { n: [-tdir[0], -tdir[1], 0] });
        W.quad(Q(s1, off0, z0), Q(s1, off0 + out, z0), Q(s1, off0 + out, z1), Q(s1, off0, z1), col, { n: tdir });
      };
      const rtrim = mix(r.col, pal.trim, 0.7), glassT = tone(pal.glass, C.dark ? 1 : 0.9), glassB = C.dark ? tone(pal.glass, 1.25) : mix(pal.glass, pal.sky, 0.5);
      const simple = !C.high || budget < 0;
      const glow = () => { const k = RW(); return mix(pal.glassLit, hex(k < 0.5 ? '#F3B56B' : '#FFF3D6'), RW() * 0.45); };
      const win = (sc, z0, ww, wh, litP) => {
        budget--;
        const lit = C.dark && RW() < litP, v = 0.94 + RW() * 0.12;
        rect(sc - ww / 2 - 0.1, sc + ww / 2 + 0.1, z0 - 0.05, z0 + wh + 0.12, 0.03, rtrim);
        if (lit) { const g = glow(); rect(sc - ww / 2, sc + ww / 2, z0, z0 + wh, 0.045, [g, g, tone(g, 0.86), tone(g, 0.86)], { mode: 1 }); }
        else rect(sc - ww / 2, sc + ww / 2, z0, z0 + wh, 0.045, [tone(glassB, v), tone(glassB, v), tone(glassT, v), tone(glassT, v)]);
        if (simple) return;
        const bar = lit ? tone(rtrim, C.dark ? 0.75 : 0.6) : rtrim;
        rect(sc - 0.022, sc + 0.022, z0, z0 + wh, 0.052, bar);
        rect(sc - ww / 2, sc + ww / 2, z0 + wh * 0.68 - 0.02, z0 + wh * 0.68 + 0.02, 0.052, bar);
        ledge(sc - ww / 2 - 0.14, sc + ww / 2 + 0.14, z0 - 0.1, z0 - 0.04, 0.13, rtrim, mix(rtrim, WHITE, C.dark ? 0.05 : 0.3));
        if (shut && r.len / r.bays - ww > 1.15) for (const sd of [-1, 1]) rect(sc + sd * (ww / 2 + 0.12), sc + sd * (ww / 2 + 0.12 + ww * 0.46), z0 - 0.02, z0 + wh + 0.04, 0.06, shut);
      };
      const bw = r.len / r.bays;
      // upper floors: a line under each, a window per bay
      for (let k = 0; k + 1 < r.floors; k++) {
        const zf = gfTop + k * r.fh;
        if (C.high) ledge(0, r.len, zf - 0.08, zf + 0.06, 0.06, rtrim, mix(rtrim, WHITE, C.dark ? 0.05 : 0.3)); else rect(0, r.len, zf - 0.08, zf + 0.06, 0.03, rtrim);
        if (bw < 1.3) continue;
        const ww = clamp(bw * 0.42, 0.7, 1.35), wh = clamp(r.fh * 0.6, 1.0, 2.1);
        for (let i = 0; i < r.bays; i++) win((i + 0.5) * bw, zf + (r.fh - wh) * 0.45, ww, wh, 0.3);
      }
      // the line under the roof
      const eave = !r.edges.length || r.edges.every((e) => !e.gable);
      if (eave) {
        const o = type === 'flat' ? 0.1 : 0.3, zt = type === 'flat' ? wallTop : eaves;
        ledge(-o, r.len + o, zt - (type === 'flat' ? 0.16 : 0.26), zt + 0.03, o, rtrim, type === 'flat' || isMesh ? mix(rtrim, WHITE, C.dark ? 0.05 : 0.3) : roofC);
      }
      if (isMesh && C.high && bw >= 2 && (or(b.roofFloors, 0) >= 1 || b.roof === 'mansard')) for (let i = 0; i < r.bays; i++) dormer(r, (i + 0.5) * bw, RW);
      // ground floor
      const zLo = (s0, s1) => Math.min(r.zg(s0), r.zg(s1), base) - 0.3;
      if (r.arcade) arcade(C, W, r, base, gfTop, zLo, b, RW, glow);
      else if (r.kind === 'arcade') { // no room for a walkway (or a given mesh): arches drawn on the wall
        const na = Math.max(1, Math.round(r.len / 3.4)), aw = r.len / na, pw = clamp(aw * 0.22, 0.45, 0.9), ow = aw - pw, zt = gfTop - 0.42, rise = Math.min(ow / 2, Math.max(0.35, zt - base - 2.25));
        for (let i = 0; i < na; i++) {
          const sl = i * aw + pw / 2, zg = r.zg(i * aw + aw / 2), pts = [Q(sl, off0 + 0.03, zg), Q(sl + ow, off0 + 0.03, zg)];
          for (let k = 0; k <= 8; k++) { const a = (k / 8) * Math.PI; pts.push(Q(sl + ow / 2 + Math.cos(a) * ow / 2, off0 + 0.03, zt - rise + Math.sin(a) * rise)); }
          W.fan(pts, mix(pal.wallShade, BLACK, C.dark ? 0.35 : 0.42), { n: nrm });
        }
      } else if (r.kind === 'shop') {
        const fascia = mix(pal.awnings[Math.floor(RW() * pal.awnings.length) % pal.awnings.length], r.col, 0.35), awn = pal.awnings[Math.floor(RW() * pal.awnings.length) % pal.awnings.length];
        const doorEvery = 3, phase = Math.floor(RW() * doorEvery), frame = mix(r.col, BLACK, C.dark ? 0.3 : 0.45), hasAwn = RW() < 0.7;
        rect(0.12, r.len - 0.12, gfTop - 0.85, gfTop - 0.28, 0.05, fascia);
        for (let i = 0; i < r.bays; i++) {
          const s0 = i * bw, zg = r.zg(s0 + bw / 2), top = gfTop - 1.0, m = Math.min(0.3, bw * 0.12), lit = C.dark && RW() < 0.75;
          const g = lit ? glow() : null, gl = (a, c2, z0, z1) => (lit ? rect(a, c2, z0, z1, 0.05, [g, g, tone(g, 0.85), tone(g, 0.85)], { mode: 1 }) : rect(a, c2, z0, z1, 0.05, [glassB, glassB, glassT, glassT]));
          if (top - zg < 1.6) continue;
          if (i % doorEvery === phase && bw > 2.2) { // a door beside a narrower window
            rect(s0 + m, s0 + bw - m, zg - 0.1, top, 0.03, frame);
            rect(s0 + m + 0.06, s0 + m + 1.0, zg + 0.02, Math.min(top - 0.06, zg + 2.3), 0.045, pal.door);
            gl(s0 + m + 0.16, s0 + m + 0.9, zg + 0.9, Math.min(top - 0.16, zg + 2.2));
            rect(s0 + m + 1.1, s0 + bw - m - 0.06, zg - 0.1, zg + 0.5, 0.045, tone(r.col, 0.86));
            gl(s0 + m + 1.1, s0 + bw - m - 0.06, zg + 0.5, top - 0.06);
          } else {
            rect(s0 + m, s0 + bw - m, zg - 0.1, top, 0.03, frame);
            rect(s0 + m + 0.06, s0 + bw - m - 0.06, zg - 0.1, zg + 0.5, 0.045, tone(r.col, 0.86));
            gl(s0 + m + 0.06, s0 + bw - m - 0.06, zg + 0.5, top - 0.06);
          }
          if (lit) pool(C, Q(s0 + bw / 2, 1.1, 0)[0], Q(s0 + bw / 2, 1.1, 0)[1], 2.6, 0.2, zg);
          if (hasAwn && RW() < 0.75) { // an awning: a sloping sheet with a hanging edge
            const z1 = top + 0.12, z2 = z1 - 0.45, o1 = 1.15, a0 = s0 + m - 0.05, a1 = s0 + bw - m + 0.05, dk = tone(awn, 0.82);
            W.quad(Q(a0, off0 + 0.05, z1), Q(a1, off0 + 0.05, z1), Q(a1, off0 + o1, z2), Q(a0, off0 + o1, z2), [awn, awn, mix(awn, WHITE, C.dark ? 0 : 0.12), mix(awn, WHITE, C.dark ? 0 : 0.12)], { n: [0, 0, 1], two: true });
            W.quad(Q(a0, off0 + o1, z2), Q(a1, off0 + o1, z2), Q(a1, off0 + o1, z2 - 0.17), Q(a0, off0 + o1, z2 - 0.17), dk, { n: nrm, two: true });
            for (const s of [a0, a1]) W.tri(Q(s, off0 + 0.05, z1), Q(s, off0 + o1, z2), Q(s, off0 + 0.05, z2), dk, { two: true });
          }
        }
      } else {
        // plain: a low plinth, windows, and a door on the longer fronts
        const door = r.len >= 5 ? Math.floor(RW() * r.bays) % r.bays : -1;
        rect(0, r.len, zLo(0, r.len), base + 0.5, 0.03, tone(r.col, C.dark ? 0.86 : 0.9));
        if (bw >= 1.3) for (let i = 0; i < r.bays; i++) {
          const sc = (i + 0.5) * bw, zg = r.zg(sc);
          if (i === door) {
            rect(sc - 0.68, sc + 0.68, zg, zg + 2.5, 0.03, rtrim);
            rect(sc - 0.55, sc + 0.55, zg, zg + 2.3, 0.045, pal.door);
            if (C.high) { rect(sc - 0.4, sc + 0.4, zg + 1.35, zg + 2.1, 0.052, C.dark && RW() < 0.6 ? glow() : glassT, { mode: C.dark ? 1 : 0 }); ledge(sc - 0.8, sc + 0.8, zg - 0.3, zg + 0.02, 0.35, pal.stone, mix(pal.stone, WHITE, C.dark ? 0.08 : 0.3)); }
          } else if (r.gf > 2.6) {
            const wh = clamp(r.gf * 0.5, 1.0, 1.9), z0 = Math.max(zg + 0.85, base + 0.75);
            if (z0 + wh < gfTop - 0.3) win(sc, z0, clamp(bw * 0.42, 0.7, 1.35), wh, 0.35);
          }
        }
      }
    }
    C.windowBudget = budget;

    // ----- its shadow on the ground: a soft band along the walls, wider on the side away from the sun -----
    if (ring) for (const e of runs.E) {
      const r = runs.find((q) => q.edges.includes(e));
      if (r && r.party) continue;
      const P = (s, o) => [e.a[0] + e.t[0] * s + e.n[0] * o, e.a[1] + e.t[1] * s + e.n[1] * o];
      const steps2 = Math.max(1, Math.ceil(e.len / 4)), inner = [], o1 = [], o2 = [], away = !C.dark && e.n[0] * C.sun[0] + e.n[1] * C.sun[1] < -0.2;
      for (let k = 0; k <= steps2; k++) { const s = (k / steps2) * e.len; inner.push(P(s, 0.02)); o1.push(P(s, 1.5)); o2.push(P(s, 4.2)); }
      shadeStrip(C, inner, o1, 1.05, base);
      if (away) shadeStrip(C, inner, o2, 0.6, base);
    }
  }
  // A real arcade: pillars and arches in the front, a walkway behind them with shop windows at its back
  function arcade(C, W, r, base, gfTop, zLo, b, RW, glow) {
    const pal = C.pal, Q = r.Q, nrm = [r.n[0], r.n[1], 0], t3 = [r.t[0], r.t[1], 0], D = r.D, pd = r.pd, col = r.col;
    const arches = !/pillar|post|column|pfeiler/i.test(b.arcade || '');
    const want = r.len / r.bays >= 2.4 && r.len / r.bays <= 5.2 ? r.bays : Math.max(1, Math.round(r.len / 3.5));
    const na = want, aw = r.len / na, pw = clamp(aw * 0.22, 0.45, 0.9), ow = aw - pw, zt = gfTop - 0.42;
    const rise = arches ? Math.min(ow / 2, Math.max(0.35, zt - base - 2.25)) : 0, spring = zt - rise, N = arches ? (C.high ? 8 : 4) : 1;
    const inside = tone(col, C.dark ? 0.62 : 0.66), deep = mix(pal.wallShade, BLACK, C.dark ? 0.3 : 0.3), soff = tone(col, C.dark ? 0.72 : 0.8);
    const front = (out, hint, c) => { // the wall with its openings, at this depth
      for (let i = 0; i < na; i++) {
        const s0 = i * aw, sl = s0 + pw / 2, sr = s0 + aw - pw / 2, zb = zLo(s0, s0 + aw);
        const cb = Array.isArray(c[0]) ? c : [tone(c, 0.93), tone(c, 0.93), c, c];
        W.quad(Q(s0, out, zb), Q(sl, out, zb), Q(sl, out, gfTop), Q(s0, out, gfTop), cb, { n: hint });
        W.quad(Q(sr, out, zb), Q(s0 + aw, out, zb), Q(s0 + aw, out, gfTop), Q(sr, out, gfTop), cb, { n: hint });
        for (let k = 0; k < N; k++) {
          const a0 = (k / N) * Math.PI, a1 = ((k + 1) / N) * Math.PI;
          const x0 = sl + ow * (1 - Math.cos(a0)) / 2, x1 = sl + ow * (1 - Math.cos(a1)) / 2, z0 = spring + rise * Math.sin(a0), z1 = spring + rise * Math.sin(a1);
          W.quad(Q(x0, out, arches ? z0 : zt), Q(x1, out, arches ? z1 : zt), Q(x1, out, gfTop), Q(x0, out, gfTop), cb[2], { n: hint });
        }
      }
    };
    front(0, nrm, col);
    front(-pd, [-nrm[0], -nrm[1], 0], [tone(inside, 0.9), tone(inside, 0.9), inside, inside]);
    for (let i = 0; i < na; i++) {
      const s0 = i * aw, sl = s0 + pw / 2, sr = s0 + aw - pw / 2, zb = zLo(s0, s0 + aw);
      // the sides of the pillars and the underside of the arch
      W.quad(Q(sl, 0, zb), Q(sl, -pd, zb), Q(sl, -pd, spring), Q(sl, 0, spring), [tone(soff, 0.9), tone(soff, 0.8), tone(soff, 0.9), soff], { n: t3 });
      W.quad(Q(sr, 0, zb), Q(sr, -pd, zb), Q(sr, -pd, spring), Q(sr, 0, spring), [tone(soff, 0.9), tone(soff, 0.8), tone(soff, 0.9), soff], { n: [-t3[0], -t3[1], 0] });
      for (let k = 0; k < N; k++) {
        const a0 = (k / N) * Math.PI, a1 = ((k + 1) / N) * Math.PI, am = (a0 + a1) / 2;
        const x0 = sl + ow * (1 - Math.cos(a0)) / 2, x1 = sl + ow * (1 - Math.cos(a1)) / 2, z0 = arches ? spring + rise * Math.sin(a0) : zt, z1 = arches ? spring + rise * Math.sin(a1) : zt;
        const hint = arches ? [t3[0] * Math.cos(am), t3[1] * Math.cos(am), -Math.sin(am) - 0.01] : [0, 0, -1];
        W.quad(Q(x0, 0, z0), Q(x1, 0, z1), Q(x1, -pd, z1), Q(x0, -pd, z0), [soff, soff, tone(soff, 0.82), tone(soff, 0.82)], { n: hint });
      }
      // the walkway: floor, back wall with a shop window, ceiling
      const z0 = r.zg(s0), z1 = r.zg(s0 + aw), fl = mix(pal.paving, BLACK, C.dark ? 0.2 : 0.16), fl2 = mix(pal.paving, BLACK, C.dark ? 0.32 : 0.3);
      const A = Q(s0, 0.02, z0 + 0.004), B = Q(s0 + aw, 0.02, z1 + 0.004), B2 = Q(s0 + aw, -D, z1 + 0.004), A2 = Q(s0, -D, z0 + 0.004);
      W.quad(A, B, B2, A2, [fl, fl, fl2, fl2], { n: [0, 0, 1] });
      C.ground.add(A, B, B2, 8); C.ground.add(A, B2, A2, 8);
      W.quad(Q(s0, -D, zb), Q(s0 + aw, -D, zb), Q(s0 + aw, -D, gfTop), Q(s0, -D, gfTop), [deep, deep, tone(deep, 0.8), tone(deep, 0.8)], { n: nrm });
      W.quad(Q(s0, -pd, gfTop - 0.3), Q(s0 + aw, -pd, gfTop - 0.3), Q(s0 + aw, -D, gfTop - 0.3), Q(s0, -D, gfTop - 0.3), [tone(deep, 0.92), tone(deep, 0.92), tone(deep, 0.75), tone(deep, 0.75)], { n: [0, 0, -1] });
      const zg = Math.max(z0, z1), lit = C.dark && RW() < 0.7, m = Math.min(0.45, aw * 0.14), top = Math.min(gfTop - 0.75, zg + 2.7);
      if (top - zg > 1.5) {
        W.quad(Q(s0 + m, -D + 0.03, zg), Q(s0 + aw - m, -D + 0.03, zg), Q(s0 + aw - m, -D + 0.03, top), Q(s0 + m, -D + 0.03, top), mix(deep, BLACK, 0.25), { n: nrm });
        const g = lit ? glow() : null, gd = mix(pal.glass, deep, C.dark ? 0.3 : 0.45);
        W.quad(Q(s0 + m + 0.07, -D + 0.045, zg + 0.45), Q(s0 + aw - m - 0.07, -D + 0.045, zg + 0.45), Q(s0 + aw - m - 0.07, -D + 0.045, top - 0.07), Q(s0 + m + 0.07, -D + 0.045, top - 0.07), lit ? [g, g, tone(g, 0.8), tone(g, 0.8)] : [mix(gd, WHITE, 0.08), mix(gd, WHITE, 0.08), gd, gd], { n: nrm, mode: lit ? 1 : 0 });
        if (lit) { const c = Q(s0 + aw / 2, -D * 0.5, 0); pool(C, c[0], c[1], Math.max(2.2, D * 0.9), 0.3, zg); }
      }
    }
    // where the walkway does not pass through a side wall, it ends in one
    for (const end of [0, 1]) {
      if (end ? r.openB : r.openA) continue;
      const s = end ? r.len : 0, zb = zLo(s, s);
      W.quad(Q(s, -pd, zb), Q(s, -D, zb), Q(s, -D, gfTop), Q(s, -pd, gfTop), deep, { n: end ? [-t3[0], -t3[1], 0] : t3 });
    }
  }

  // ---------- putting it together ----------
  const GLOW_VERT = [
    'attribute vec2 corner; attribute float gsize; attribute vec4 gcol;',
    'varying vec2 vC; varying vec4 vCol;',
    '#include <fog_pars_vertex>',
    '#include <clipping_planes_pars_vertex>',
    'void main() {',
    '  vC = corner; vCol = gcol;',
    '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
    '  mvPosition.xy += corner * gsize;', // always faces the eye
    '  gl_Position = projectionMatrix * mvPosition;',
    '  #include <clipping_planes_vertex>',
    '  #include <fog_vertex>',
    '}'].join('\n');
  const GLOW_FRAG = [
    'varying vec2 vC; varying vec4 vCol;',
    '#include <fog_pars_fragment>',
    '#include <clipping_planes_pars_fragment>',
    'void main() {',
    '  #include <clipping_planes_fragment>',
    '  float d = length(vC);',
    '  float a = pow(max(0.0, 1.0 - d), 2.4) * vCol.a;',
    '  #ifdef USE_FOG',
    '    #ifdef FOG_EXP2',
    '      a *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);',
    '    #else',
    '      a *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);',
    '    #endif',
    '  #endif',
    '  gl_FragColor = vec4(vCol.rgb, a);',
    '  #include <colorspace_fragment>',
    '}'].join('\n');

  // A batch becomes a geometry: positions go through toScene, colours become linear
  function finish(THREE, b, toScene, flip, plain) {
    const n = b.n, pos = new Float32Array(n * 3), g = new THREE.BufferGeometry();
    for (let i = 0; i < n; i++) { const s = toScene(b.p[i * 3], b.p[i * 3 + 1], b.p[i * 3 + 2]); pos[i * 3] = s[0]; pos[i * 3 + 1] = s[1]; pos[i * 3 + 2] = s[2]; }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (!plain) {
      const k = b.alpha ? 4 : 3, col = new Float32Array(n * k);
      for (let i = 0; i < n; i++) { for (let j = 0; j < 3; j++) col[i * k + j] = toLin(sat(b.c[i * k + j])); if (b.alpha) col[i * k + 3] = b.c[i * k + 3]; }
      g.setAttribute('color', new THREE.BufferAttribute(col, k));
    }
    if (b.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(b.uv), 2));
    const idx = n > 65535 ? new Uint32Array(b.i) : new Uint16Array(b.i);
    if (flip) for (let i = 0; i + 2 < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }
  function sky(THREE, o) {
    o = o || {};
    const pal = paletteOf(o.theme, o.palette), r = o.radius || 480, g = new THREE.SphereGeometry(r, 24, 14);
    const p = g.attributes.position, col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const c = mix(pal.horizon, pal.sky, smooth(-0.02, 0.42, p.getY(i) / r));
      col[i * 3] = toLin(c[0]); col[i * 3 + 1] = toLin(c[1]); col[i * 3 + 2] = toLin(c[2]);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    m.name = 'detail-sky'; m.renderOrder = -1000; m.frustumCulled = false;
    return m;
  }
  function clear(h) {
    for (const r of h._res || []) { try { r.dispose(); } catch (e) { /* already gone */ } }
    h._res = [];
    while (h.group.children.length) h.group.remove(h.group.children[0]);
    h.parts = {};
  }
  function fill(THREE, h) {
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()), t0 = now();
    const detail = h.detail || {}, opts = h.opts, dark = opts.theme === 'dark', high = opts.quality !== 'low';
    const pal = paletteOf(dark ? 'dark' : 'light', opts.palette);
    const az = or(opts.sun && opts.sun.azimuth, 227.7) * RAD, el = clamp(or(opts.sun && opts.sun.elevation, 63.6), 5, 90) * RAD;
    const sun = [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)];
    const lamps = [], shade = makeShade(dark, sun, lamps, pal.lamp), warnings = [];
    const B = { solid: new Batch(), bld: new Batch(), crown: new Batch(), glass: new Batch(true), decal: new Batch() };
    const nTrees = (detail.trees || []).length;
    const C = {
      THREE, detail, opts, pal, dark, high, sun, ground: new Ground(), z0: 0, plane: null,
      season: opts.season === 'summer' || opts.season === 'winter' ? opts.season : null,
      counts: { surfaces: 0, edges: 0, trees: 0, props: 0, buildings: 0 }, warn: (m) => { if (warnings.length < 40) warnings.push(m); },
      walk: [], groundBatches: new Map(), shadow: new Batch(true), pool: new Batch(true), feather: new Batch(true), glows: [],
      W: { solid: new Writer(B.solid, shade), bld: new Writer(B.bld, shade), crown: new Writer(B.crown, shade), glass: new Writer(B.glass, shade), decal: new Writer(B.decal, shade) },
      path: cleanLine(detail.path || []), clearance: or(opts.clearance, 2.7),
      lobeF: high ? (nTrees > 44 ? 2 : 3) : (nTrees > 90 ? 1 : 2), windowBudget: high ? 1100 : -1,
      rings: (detail.buildings || []).map((b) => { const r = b && cleanRing(b.ring); if (r) r.box = boxOf(r); return r; }),
    };
    const each = (list, name, fn) => (list || []).forEach((item, i) => {
      if (!item) return;
      try { fn(item, i); } catch (e) { C.warn(name + ' ' + i + ': ' + (e && e.message)); }
    });
    const surfaces = readSurfaces(C);
    basePlate(C, surfaces);
    buildSurfaces(C, surfaces);
    // the lamps first: at night everything built after this is lit by them
    h.lamps = [];
    each(detail.props, 'prop', (p) => {
      if (!p.xy || !isFinite(p.xy[0]) || !isFinite(p.xy[1])) return;
      const kind = ALIAS[p.kind] || p.kind, z = num(p.z) != null ? p.z : groundZ(C, p.xy[0], p.xy[1]);
      const ls = lightsOf(Object.assign({}, p, { kind }));
      if (kind === 'lamp') h.lamps.push({ xy: [p.xy[0], p.xy[1]], z, height: ls.length ? ls[0].at[2] : or(p.height, 4.5) });
      if (dark) for (const l of ls) { const P = new Writer(null, null).frame(p.xy[0], p.xy[1], z, or(p.heading, 0)).P(l.at); lamps.push({ x: P[0], y: P[1], z: P[2], r2: l.reach * l.reach, k: l.power }); }
    });
    each(detail.edges, 'edge', (e) => buildEdge(C, e));
    for (const t of C.walk) C.ground.add(t[0], t[1], t[2], 9); // kerb tops, once all edges have measured the ground beside them
    each(detail.buildings, 'building', (b, i) => buildBuilding(C, b, i));
    each(detail.trees, 'tree', (t) => buildTree(C, t));
    each(detail.props, 'prop', (p) => buildProp(C, p));

    // ----- meshes -----
    const map = typeof opts.toScene === 'function' ? opts.toScene : (x, y, z) => [x, z, -y];
    // zShift: the whole scene moves up or down by this much (true: by the zOffset the data asks for)
    const shift = h.zShift = opts.zShift === true ? or(detail.zOffset, 0) : or(opts.zShift, 0);
    const toScene = shift ? (x, y, z) => map(x, y, z + shift) : map;
    for (const l of h.lamps) l.z += shift;
    const o = toScene(0, 0, 0), ex = sub(toScene(1, 0, 0), o), ey = sub(toScene(0, 1, 0), o), ez = sub(toScene(0, 0, 1), o);
    const flip = dot(ex, cross(ey, ez)) < 0; // a mirrored mapping turns every triangle over
    const res = h._res = [], group = h.group, parts = h.parts = { ground: [] };
    const mesh = (name, batch, mat, order, plain) => {
      if (!batch.i.length) { mat.dispose(); return null; }
      const geo = finish(THREE, batch, toScene, flip, plain), m = new THREE.Mesh(geo, mat);
      m.name = 'detail-' + name; m.renderOrder = order; m.matrixAutoUpdate = false;
      group.add(m); res.push(geo, mat);
      return m;
    };
    const Basic = THREE.MeshBasicMaterial, texes = {};
    let nTex = 0;
    [...C.groundBatches.values()].sort((p, q) => p.layer - q.layer).forEach((g) => {
      let tex = texes[g.kind];
      if (!tex) {
        const big = g.kind === 'paving' || g.kind === 'cobble';
        tex = texes[g.kind] = new THREE.CanvasTexture(paint(g.kind, pal, high ? (big ? 1024 : 512) : (big ? 512 : 256), dark));
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = high ? 8 : 4;
        res.push(tex); nTex++;
      }
      const m = mesh('ground-' + g.kind + '-' + g.layer, g, new Basic({ map: tex, vertexColors: true, polygonOffset: g.layer > 0, polygonOffsetFactor: -g.layer, polygonOffsetUnits: -2 * g.layer }), -20 + g.layer);
      if (m) parts.ground.push(m);
    });
    parts.decals = mesh('decals', B.decal, new Basic({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -10 }), -10);
    parts.solid = mesh('solid', B.solid, new Basic({ vertexColors: true }), 0);
    parts.buildings = mesh('buildings', B.bld, new Basic({ vertexColors: true, side: C.meshBuildings ? THREE.DoubleSide : THREE.FrontSide }), 0);
    parts.crowns = mesh('crowns', B.crown, new Basic({ vertexColors: true }), 0);
    const veil = (extra) => new Basic(Object.assign({ vertexColors: true, transparent: true, depthWrite: false }, extra));
    parts.feather = mesh('feather', C.feather, veil(), 1);
    parts.shadows = mesh('shadows', C.shadow, veil({ polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12 }), 2);
    parts.pools = mesh('pools', C.pool, veil({ polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12, blending: THREE.AdditiveBlending, fog: false }), 3);
    parts.glass = mesh('glass', B.glass, veil({ side: THREE.DoubleSide }), 4);
    if (C.glows.length) {
      const n = C.glows.length, pos = new Float32Array(n * 12), cor = new Float32Array(n * 8), siz = new Float32Array(n * 4), col = new Float32Array(n * 16), idx = new Uint16Array(n * 6);
      const lc = [toLin(pal.lamp[0]), toLin(pal.lamp[1]), toLin(pal.lamp[2])], Q = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      C.glows.forEach((gl, i) => {
        const s = toScene(gl.p[0], gl.p[1], gl.p[2]);
        for (let k = 0; k < 4; k++) {
          pos.set(s, i * 12 + k * 3); cor.set(Q[k], i * 8 + k * 2); siz[i * 4 + k] = gl.size;
          col.set([lc[0], lc[1], lc[2], gl.a], i * 16 + k * 4);
        }
        idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('corner', new THREE.BufferAttribute(cor, 2));
      geo.setAttribute('gsize', new THREE.BufferAttribute(siz, 1)); geo.setAttribute('gcol', new THREE.BufferAttribute(col, 4));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      const mat = new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]), vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true, clipping: true,
      });
      const m = new THREE.Mesh(geo, mat);
      m.name = 'detail-glows'; m.renderOrder = 5; m.frustumCulled = false; m.matrixAutoUpdate = false;
      group.add(m); res.push(geo, mat);
      parts.glows = m;
    }
    if (opts.sky) {
      const s = sky(THREE, { theme: opts.theme, palette: opts.palette }), c = C.path && C.path.length ? C.path[Math.floor(C.path.length / 2)] : [0, 0];
      s.position.fromArray(toScene(c[0], c[1], 0));
      group.add(s); res.push(s.geometry, s.material);
      parts.sky = s;
    }
    let tris = 0, verts = 0, calls = 0;
    const per = {};
    for (const m of group.children) {
      const t = m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3;
      tris += t; verts += m.geometry.attributes.position.count; calls++;
      per[m.name.replace('detail-', '')] = Math.round(t);
    }
    h._ground = C.ground;
    h.theme = dark ? 'dark' : 'light'; h.quality = high ? 'high' : 'low';
    h.stats = { triangles: Math.round(tris), drawCalls: calls, vertices: verts, textures: nTex, buildMs: Math.round(now() - t0), counts: C.counts, parts: per, warnings };
  }
  function build(THREE, detail, opts) {
    if (!THREE || !THREE.BufferGeometry) throw new Error('Station3DDetail.build: pass the THREE module object first');
    const h = { group: new THREE.Group(), detail: detail || {}, opts: Object.assign({}, opts), stats: null, parts: {}, lamps: [], _res: [], _THREE: THREE };
    h.group.name = 'detail:' + ((detail && detail.key) || '');
    fill(THREE, h);
    h.groundAt = (x, y) => groundAt(h, x, y);
    h.dispose = () => { clear(h); if (h.group.parent) h.group.parent.remove(h.group); h._ground = null; };
    return h;
  }
  function update(h, change) {
    if (!h || !h._THREE) return h;
    const o = Object.assign({}, h.opts, change);
    const same = ['theme', 'quality', 'season', 'pollard', 'zShift', 'sun', 'palette', 'sky', 'feather', 'clearance'].every((k) => JSON.stringify(o[k]) === JSON.stringify(h.opts[k]));
    if (same && h.group.children.length) return h;
    h.opts = o;
    clear(h);
    fill(h._THREE, h);
    return h;
  }
  function groundAt(h, x, y) {
    const z = h && h._ground ? h._ground.at(x, y) : null;
    return z == null ? null : z + (h.zShift || 0);
  }

  window.Station3DDetail = { build, update, groundAt, sky, palette: (theme) => JSON.parse(JSON.stringify(PALETTE[theme === 'dark' ? 'dark' : 'light'])), version: 1 };
})();
