// Continuous 3D view of the inside of a station: one building at true heights (stretched upwards so floors read),
// floors with the wells of their stairs and escalators, walls where OpenStreetMap has them, shops, and every stair,
// escalator, ramp and lift as a 3D object with its direction. The route is a tube through it, and the floors above
// the route are cut open along it (a corridor cutaway), so the way down stays in view without pulling floors apart.
//
// Reads the station model (stations3d/<key>.js, SCHEMA.md), its solid companion (stations3d/<key>.solid.js, built by
// tools/station3d_solid.py) and routes with station-route.js. ES module; three.js r170 through the page's import map.
//
//   import { open } from './station3d-solid.js';
//   const view = await open({ mount, key, from, to, prefs, onChange });
//   view.step(i) · view.whole() · view.floor(levelId | null) · view.setStretch(s) · view.reset() · view.dispose()
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const MAX_CUT = 40;               // route pieces the cutaway can follow
const CUT_R = 14;                 // m: half-width of the corridor cut open above the route
const ROUTE_Y = 0.55;             // m above the floor
const WALL_H = 2.2, KERB_H = 0.22, RAIL_H = 1.0, SLAB_T = 0.4;
const ESC_UP = 0x0f9d8a, ESC_DOWN = 0xe07b00, ESC_BOTH = 0x8a929c;
const ROUTE = 0xffc928, ROUTE_CASE = 0x14161a;
const PIN = { shop: 0x5b6cff, food: 0xe0533d, service: 0x1f8a4c, toilets: 0x7a5cc4 };

/** An end of the way, as the router takes it; none: no way is planned (the station is only shown). */
type SolidEnd = StationRouteEndpoint | null | undefined;
/** What onChange is told: the way (if any), the step shown (-1: the whole way) and the floor picked (if one is). */
export interface SolidChange { route: StationRouteResult | null; step: number; focusLevel: number | null }
export interface SolidOptions {
  mount: HTMLElement;
  key: string;
  from?: SolidEnd;
  to?: SolidEnd;
  prefs?: StationRoutePrefs | null;
  /** Vertical stretch (default 2.2). */
  stretch?: number;
  onChange?: (state: SolidChange) => void;
}
/** What open() gives: the view and its controls. */
export type SolidView = Awaited<ReturnType<typeof open>>;
/** Anything in the scene that may have a geometry and materials to free. */
interface SolidDrawn extends THREE.Object3D { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] }
interface SolidFrameOptions { elev?: number; yaw?: number | null; pad?: number }
/** `near`: shown only from closer than about twice this; `up`: metres above the floor; `step`: index into route.steps. */
interface SolidLabelOptions { up?: number; near?: number; step?: number }
interface SolidLabel extends SolidLabelOptions { el: HTMLDivElement; pos: THREE.Vector3; prio: number; z: number }
type SolidMode = { kind: 'whole' } | { kind: 'step' } | { kind: 'floor'; id: number };

export async function open(opts: SolidOptions) {
  const { mount, key } = opts;
  const model = window.STATION3D && window.STATION3D[key];
  const solid = window.STATION3D_SOLID && window.STATION3D_SOLID[key];
  const SR = window.StationRoute!;
  if (!model || !solid) throw new Error('no model for ' + key);
  const dark = () => document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);

  // ------------------------------------------------------------------ frame: model x east, y north, z up → three
  const b = model.bbox;
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  let S = opts.stretch || 2.2;      // vertical stretch: true heights × S (floors 2–9 m apart would look flat at 1×)
  const levels = solid.levels.slice().sort((a, b) => a.id - b.id);
  const zOf = (level: number) => SR.z(model, level);
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x - cx, z * S, -(y - cy));

  // ------------------------------------------------------------------ three.js
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  mount.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 1, 6000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 15; controls.maxDistance = 1600;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(-300, 600, 400);
  scene.add(sun);
  const labelsEl = document.createElement('div');
  labelsEl.className = 'sx-labels';
  mount.appendChild(labelsEl);

  // the corridor cutaway: every architecture material discards fragments above the route, near it
  const CUT = {
    uSeg: { value: Array.from({ length: MAX_CUT }, () => new THREE.Vector4()) },
    uSegY: { value: new Float32Array(MAX_CUT) }, uSegR: { value: new Float32Array(MAX_CUT) },
    uN: { value: 0 }, uR: { value: CUT_R }, uCutY: { value: 1e6 },
  };
  function cutaway<M extends THREE.Material>(mat: M) {
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, CUT);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
        .replace('#include <project_vertex>', `#include <project_vertex>
          #ifdef USE_INSTANCING
            vWP = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          #else
            vWP = (modelMatrix * vec4(transformed, 1.0)).xyz;
          #endif`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
          varying vec3 vWP; uniform vec4 uSeg[${MAX_CUT}]; uniform float uSegY[${MAX_CUT}]; uniform float uSegR[${MAX_CUT}]; uniform int uN;
          uniform float uR; uniform float uCutY;`)
        .replace('void main() {', `void main() {
          if (vWP.y > uCutY) discard;
          for (int i = 0; i < ${MAX_CUT}; i++) {
            if (i >= uN) break;
            if (vWP.y > uSegY[i]) {
              vec2 a = uSeg[i].xy, ab = uSeg[i].zw - uSeg[i].xy, p = vWP.xz;
              float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
              if (length(p - a - ab * t) < uSegR[i]) discard;
            }
          }`);
    };
    return mat;
  }

  // ------------------------------------------------------------------ colours
  const pal = () => dark()
    ? { bg: 0x101317, top: 0x5a554c, deep: 0x2d3a4d, edge: 0x0a0c0f, wall: 0x6d7480, kerb: 0x1b2027, glass: 0x9fc2e6,
        track: 0x1a1d22, rail: 0x6b717a, step: 0xb9b2a5, riser: 0x55524c, room: 0x6b6f86, outline: 0x8a94a3 }
    : { bg: 0xeef1f4, top: 0xe9e2d4, deep: 0x8e9cb0, edge: 0x3a4250, wall: 0xf7f5f0, kerb: 0x6a7180, glass: 0x7fb2e5,
        track: 0x50545b, rail: 0x9aa0a8, step: 0xf2ece0, riser: 0x9c9384, room: 0xd9dcef, outline: 0x56606e };
  type SolidPalette = ReturnType<typeof pal>;
  function levelColour(id: number, P: SolidPalette) {
    // warm stone at the top, cooler and darker going down; floors above 0 lighter still
    const i = levels.findIndex((l) => l.id === id), n = Math.max(1, levels.length - 1);
    const top = levels.findIndex((l) => l.id === 0);
    const f = top < 0 ? i / n : Math.max(0, (top - i) / Math.max(1, top));
    return new THREE.Color(P.top).lerp(new THREE.Color(P.deep), Math.min(1, f));
  }

  // ------------------------------------------------------------------ geometry helpers
  function strip(lines: { line: XY[]; z: number }[], h: number, lift = 0) {
    // vertical quads along polylines: [{ line: [[x, y]], z }] → BufferGeometry
    const pos: number[] = [];
    for (const { line, z } of lines) {
      for (let i = 0; i + 1 < line.length; i++) {
        const a = V(line[i][0], line[i][1], z), c = V(line[i + 1][0], line[i + 1][1], z);
        const y0 = z * S + lift, y1 = y0 + h;
        pos.push(a.x, y0, a.z, c.x, y0, c.z, c.x, y1, c.z, a.x, y0, a.z, c.x, y1, c.z, a.x, y1, a.z);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }
  function band(p0: THREE.Vector3, p1: THREE.Vector3, w: number, lift: number, uvLen?: number) {
    // a flat band from p0 to p1 (world vectors), w wide; uv: u across, v along (in units of uvLen)
    const d = new THREE.Vector3().subVectors(p1, p0), side = new THREE.Vector3(-d.z, 0, d.x).normalize().multiplyScalar(w / 2);
    const a = p0.clone().add(side), bb = p0.clone().sub(side), c = p1.clone().sub(side), e = p1.clone().add(side);
    for (const v of [a, bb, c, e]) v.y += lift;
    const g = new THREE.BufferGeometry();
    // wound so the face looks up (front side), whatever the direction of the band
    g.setAttribute('position', new THREE.Float32BufferAttribute([a, c, bb, a, e, c].flatMap((v) => [v.x, v.y, v.z]), 3));
    const L = d.length() / (uvLen || 1);
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, L, 1, 0, 0, 0, 0, L, 1, L], 2));
    g.computeVertexNormals();
    return g;
  }
  function chevronTexture() {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = '#d9dde3'; g.fillRect(0, 0, 64, 64);
    g.strokeStyle = '#ffffff'; g.lineWidth = 9; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(12, 42); g.lineTo(32, 20); g.lineTo(52, 42); g.stroke();   // apex at the top = +v once flipped (flipY)
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }
  function stripeTexture() {
    const c = document.createElement('canvas'); c.width = 16; c.height = 32;
    const g = c.getContext('2d')!;
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 16, 32); g.fillStyle = '#8a8378'; g.fillRect(0, 0, 16, 6);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // ------------------------------------------------------------------ the building
  let world: THREE.Group | null = null;
  const textures = { chevron: chevronTexture(), stripe: stripeTexture() };
  // ------------------------------------------------------------------ focus: only the part of the station the route uses
  // With a route, only its floors (and those a lift or escalator on it passes) are drawn, and on them only what lies
  // within FOCUS_M of the route; showAll(true) draws the whole station again.
  const FOCUS_M = 40;
  let showAll = false;
  let focus: { levels: Set<number>; box: [number, number, number, number] } | null = null;
  function setFocus() {
    if (showAll || !route || route.same) { focus = null; return; }
    const lv = new Set<number>();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const pts = route.points;
    for (let i = 0; i < pts.length; i++) {
      const [x, y, l] = pts[i];
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      const l2 = i + 1 < pts.length ? pts[i + 1][2] : l;
      for (let k = Math.round(Math.min(l, l2)); k <= Math.round(Math.max(l, l2)); k++) lv.add(k);
    }
    focus = { levels: lv, box: [x0 - FOCUS_M, y0 - FOCUS_M, x1 + FOCUS_M, y1 + FOCUS_M] };
  }
  const inBox = (x: number, y: number) => !focus || (x >= focus.box[0] && x <= focus.box[2] && y >= focus.box[1] && y <= focus.box[3]);
  const onLevel = (level: number) => !focus || focus.levels.has(Math.round(level));
  const lineIn = (line: XY[]) => !focus || line.some(([x, y]) => inBox(x, y)) || (() => {
    // a line that crosses the box without a point in it
    const xs = line.map((p) => p[0]), ys = line.map((p) => p[1]);
    return Math.min(...xs) <= focus!.box[2] && Math.max(...xs) >= focus!.box[0] && Math.min(...ys) <= focus!.box[3] && Math.max(...ys) >= focus!.box[1];
  })();
  const keep = (level: number, x: number, y: number) => onLevel(level) && inBox(x, y);
  function build() {
    if (world) { scene.remove(world); freeGroup(world); }
    world = new THREE.Group();
    const P = pal();
    scene.background = new THREE.Color(P.bg);
    shared.outline = new THREE.LineBasicMaterial({ color: P.outline, transparent: true, opacity: 0.35 });

    // floors, one mesh per level, and their outlines (the outlines stay when the cutaway opens a floor)
    const byLevel = new Map<number, THREE.ExtrudeGeometry[]>();
    for (const s of solid!.slabs) {
      if (!onLevel(s.level) || !lineIn(s.rings[0])) continue;
      if (!byLevel.has(s.level)) byLevel.set(s.level, []);
      const sh = new THREE.Shape(s.rings[0].map(([x, y]) => new THREE.Vector2(x - cx, y - cy)));
      for (const h of s.rings.slice(1)) sh.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x - cx, y - cy))));
      const g = new THREE.ExtrudeGeometry(sh, { depth: SLAB_T, bevelEnabled: false, curveSegments: 1 });
      g.rotateX(-Math.PI / 2);
      g.translate(0, s.z * S - SLAB_T, 0);
      byLevel.get(s.level)!.push(g);
    }
    for (const [lv, gs] of byLevel) {
      const g = mergeGeometries(gs, false);
      // tops in the level's colour, the sides of the slab darker: the floors read as stacked slabs
      const top = levelColour(lv, P), side = top.clone().multiplyScalar(0.62);
      const nrm = g.getAttribute('normal'), cols = new Float32Array(nrm.count * 3);
      for (let i = 0; i < nrm.count; i++) { const c = Math.abs(nrm.getY(i)) > 0.5 ? top : side; cols.set([c.r, c.g, c.b], i * 3); }
      g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      const mesh = new THREE.Mesh(g, cutaway(new THREE.MeshLambertMaterial({ vertexColors: true })));
      mesh.userData.level = lv;
      world.add(mesh);
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(g, 40), shared.outline);
      world.add(lines);
      gs.forEach((x) => x.dispose());
    }
    // walls (OSM), kerbs (floor edges), railings (round the wells)
    const wallLines = (k: StationSolidWall['kind']) => solid!.walls.filter((w) => w.kind === k && onLevel(w.level) && lineIn(w.line));
    world.add(new THREE.Mesh(strip(wallLines('wall'), WALL_H), cutaway(new THREE.MeshLambertMaterial({ color: P.wall, side: THREE.DoubleSide }))));
    world.add(new THREE.Mesh(strip(wallLines('edge'), KERB_H), cutaway(new THREE.MeshLambertMaterial({ color: P.kerb, side: THREE.DoubleSide }))));
    world.add(new THREE.Mesh(strip(wallLines('rail'), RAIL_H), cutaway(new THREE.MeshLambertMaterial({ color: P.glass, side: THREE.DoubleSide, transparent: true, opacity: 0.32, depthWrite: false }))));
    // rooms with outlines (named only)
    const roomGs = [];
    for (const r of solid!.rooms) {
      if (!onLevel(r.level) || !lineIn(r.ring)) continue;
      const sh = new THREE.Shape(r.ring.map(([x, y]) => new THREE.Vector2(x - cx, y - cy)));
      const g = new THREE.ExtrudeGeometry(sh, { depth: r.height, bevelEnabled: false });
      g.rotateX(-Math.PI / 2); g.translate(0, r.z * S, 0);
      roomGs.push(g);
    }
    if (roomGs.length) world.add(new THREE.Mesh(merged(roomGs), cutaway(new THREE.MeshLambertMaterial({ color: P.room, transparent: true, opacity: 0.85 }))));
    // tracks: a dark bed and two rails
    const bedGs = [], railPts = [];
    for (const t of solid!.tracks) {
      if (focus && (!onLevel(levelOfZ(t.z)) || !lineIn(t.line))) continue;
      const tram = t.kind === 'tram';
      for (let i = 0; i + 1 < t.line.length; i++) {
        const p0 = V(t.line[i][0], t.line[i][1], t.z), p1 = V(t.line[i + 1][0], t.line[i + 1][1], t.z);
        if (!tram) bedGs.push(band(p0, p1, 3.0, 0));
        const d = new THREE.Vector3().subVectors(p1, p0), side = new THREE.Vector3(-d.z, 0, d.x).normalize().multiplyScalar(tram ? 0.5 : 0.72);
        const lift = tram ? 0.04 : 0.15;
        for (const sgn of [1, -1]) railPts.push(p0.clone().addScaledVector(side, sgn).setY(p0.y + lift), p1.clone().addScaledVector(side, sgn).setY(p1.y + lift));
      }
    }
    if (bedGs.length) world.add(new THREE.Mesh(merged(bedGs), cutaway(new THREE.MeshLambertMaterial({ color: P.track }))));
    if (railPts.length) world.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(railPts), cutaway(new THREE.LineBasicMaterial({ color: P.rail }))));
    // stairs, escalators, ramps, lifts
    buildConnectors(P);
    // shops and services mapped as points: a stick and a coloured head, coloured by kind
    const pinGeo = merged([new THREE.CylinderGeometry(0.08, 0.08, 1.6, 4).translate(0, 0.8, 0), new THREE.SphereGeometry(0.45, 10, 8).translate(0, 1.8, 0)]);
    const pinList = solid!.pins.filter((p) => keep(p.level, p.x, p.y));
    const pins = new THREE.InstancedMesh(pinGeo, cutaway(new THREE.MeshLambertMaterial({ color: 0xffffff })), Math.max(1, pinList.length));
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    pinList.forEach((p, i) => { m4.makeTranslation(p.x - cx, p.z * S, -(p.y - cy)); pins.setMatrixAt(i, m4); pins.setColorAt(i, col.set(PIN[p.kind] || PIN.shop)); });
    if (pinList.length) world.add(pins); else pinGeo.dispose();
    scene.add(world);
    if (route) drawRoute();
  }
  const shared: { outline: THREE.LineBasicMaterial | null } = { outline: null };
  function freeGroup(g: THREE.Object3D) {
    const mats = new Set<THREE.Material>();
    g.traverse((o: SolidDrawn) => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m)); });
    mats.forEach((m) => m.dispose());
  }
  // merge and free the pieces
  const merged = (gs: THREE.BufferGeometry[]) => { const g = mergeGeometries(gs, false); gs.forEach((x) => x.dispose()); return g; };

  function buildConnectors(P: SolidPalette) {
    const esc: Record<'up' | 'down' | 'both', THREE.BufferGeometry[]> = { up: [], down: [], both: [] }, glass = [], slopes = [], ramps = [], shaftEdges = [], rings = [];
    const tCol = new THREE.Color(P.step), rCol = new THREE.Color(P.riser);
    const treadPos: number[] = [], treadCol: number[] = [];
    const quad = (a: THREE.Vector3, b2: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, colr: THREE.Color) => {
      for (const v of [a, b2, c, a, c, d]) { treadPos.push(v.x, v.y, v.z); treadCol.push(colr.r, colr.g, colr.b); }
    };
    for (const c of solid!.connectors) {
      if (focus) {
        // a lift, stair or escalator in the box that reaches one of the route's floors
        const pts: [number, number, number][] = c.kind === 'elevator' ? c.zs.map((z) => [c.xy[0], c.xy[1], z] as [number, number, number]) : c.pts;
        if (!pts.some(([x, y]) => inBox(x, y)) || !pts.some(([, , z]) => onLevel(levelOfZ(z)))) continue;
      }
      if (c.kind === 'elevator') {
        const lo = Math.min(...c.zs), hi = Math.max(...c.zs);
        const [x, y] = c.xy;
        const box = new THREE.BoxGeometry(2.0, (hi - lo) * S + 2.6, 2.0).translate(x - cx, lo * S + ((hi - lo) * S + 2.6) / 2, -(y - cy));
        glass.push(box);
        shaftEdges.push(new THREE.EdgesGeometry(box));
        for (const z of c.zs) rings.push(new THREE.RingGeometry(1.25, 1.7, 20).rotateX(-Math.PI / 2).translate(x - cx, z * S + 0.06, -(y - cy)));
        continue;
      }
      const all = c.pts.map(([x, y, z]) => V(x, y, z));
      const totalRise = Math.abs(all[all.length - 1].y - all[0].y) || 1;
      for (let si = 0; si + 1 < all.length; si++) {
      const p0 = all[si], p1 = all[si + 1];
      if (p0.distanceTo(p1) < 0.05) continue;
      if (Math.abs(p1.y - p0.y) < 0.05 && c.kind !== 'ramp') { ramps.push(band(p0, p1, Math.min(c.width || 2, 2.4), 0.05)); continue; } // a landing
      if (c.kind === 'escalator') {
        // chevrons point the way it runs: 'up' = towards the higher end
        const upEnd = p1.y >= p0.y ? [p0, p1] : [p1, p0];
        const [from, to] = c.dir === 'down' ? [upEnd[1], upEnd[0]] : upEnd;
        const w = Math.min(Math.max(c.width || 1, 1), 1.2);
        (c.dir === 'up' ? esc.up : c.dir === 'down' ? esc.down : esc.both).push(band(from, to, w, 0.12, 1.4));
        // balustrades
        const d = new THREE.Vector3().subVectors(to, from), side = new THREE.Vector3(-d.z, 0, d.x).normalize().multiplyScalar(w / 2 + 0.12);
        for (const sgn of [1, -1]) {
          const a = from.clone().addScaledVector(side, sgn), e = to.clone().addScaledVector(side, sgn);
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute([a.x, a.y, a.z, e.x, e.y, e.z, e.x, e.y + 1.0, e.z, a.x, a.y, a.z, e.x, e.y + 1.0, e.z, a.x, a.y + 1.0, a.z], 3));
          g.computeVertexNormals();
          glass.push(g);
        }
      } else if (c.kind === 'stairs' && !c.steep && c.steps) {
        // a few clear steps (not all of them: they alias into noise from afar), shared out by how much each flight climbs
        const share = Math.abs(p1.y - p0.y) / totalRise;
        const n = Math.max(2, Math.min(Math.round(c.steps * share), 9));
        const [lo, hi] = p1.y >= p0.y ? [p0, p1] : [p1, p0];
        const w = Math.min(c.width || 2, 2.4);
        const d = new THREE.Vector3().subVectors(hi, lo), run = new THREE.Vector3(d.x, 0, d.z);
        const side = new THREE.Vector3(-d.z, 0, d.x).normalize().multiplyScalar(w / 2);
        for (let k = 0; k < n; k++) {
          const f0 = k / n, f1 = (k + 1) / n;
          const y = lo.y + d.y * f1;
          const a = lo.clone().addScaledVector(run, f0), e = lo.clone().addScaledVector(run, f1);
          const A = a.clone().add(side), B2 = a.clone().sub(side), C = e.clone().sub(side), D = e.clone().add(side);
          // riser at the start of the step, tread on top
          quad(A.clone().setY(y - d.y / n), B2.clone().setY(y - d.y / n), B2.clone().setY(y), A.clone().setY(y), rCol);
          quad(A.clone().setY(y), B2.clone().setY(y), C.clone().setY(y), D.clone().setY(y), tCol);
        }
      } else if (c.kind === 'stairs') {
        slopes.push(band(p0, p1, Math.min(c.width || 2, 2.4), 0.05, 0.6));
      } else {
        ramps.push(band(p0, p1, Math.min(c.width || 2, 3), 0.05));
      }
      }
    }
    const escMat = (colr: number) => cutaway(new THREE.MeshLambertMaterial({ color: colr, map: textures.chevron, side: THREE.DoubleSide }));
    if (esc.up.length) world!.add(new THREE.Mesh(merged(esc.up), escMat(ESC_UP)));
    if (esc.down.length) world!.add(new THREE.Mesh(merged(esc.down), escMat(ESC_DOWN)));
    if (esc.both.length) world!.add(new THREE.Mesh(merged(esc.both), cutaway(new THREE.MeshLambertMaterial({ color: ESC_BOTH, side: THREE.DoubleSide }))));
    if (treadPos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(treadPos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(treadCol, 3));
      g.computeVertexNormals();
      world!.add(new THREE.Mesh(g, cutaway(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }))));
    }
    if (slopes.length) world!.add(new THREE.Mesh(merged(slopes), cutaway(new THREE.MeshLambertMaterial({ color: P.step, map: textures.stripe, side: THREE.DoubleSide }))));
    if (ramps.length) world!.add(new THREE.Mesh(merged(ramps), cutaway(new THREE.MeshLambertMaterial({ color: P.step, side: THREE.DoubleSide }))));
    if (glass.length) {
      const g = merged(glass.map((x) => { const y = x.index ? x.toNonIndexed() : x; if (y !== x) x.dispose(); y.deleteAttribute('uv'); return y; }));
      world!.add(new THREE.Mesh(g, cutaway(new THREE.MeshLambertMaterial({ color: P.glass, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }))));
    }
    if (shaftEdges.length) world!.add(new THREE.LineSegments(merged(shaftEdges), cutaway(new THREE.LineBasicMaterial({ color: P.edge, transparent: true, opacity: 0.6 }))));
    if (rings.length) world!.add(new THREE.Mesh(merged(rings), cutaway(new THREE.MeshBasicMaterial({ color: ROUTE, side: THREE.DoubleSide }))));
  }

  // ------------------------------------------------------------------ the route
  let route: StationRouteResult | null = null, routeGroup: THREE.Group | null = null, stepIdx = -1;
  function plan(from: SolidEnd, to: SolidEnd, p?: StationRoutePrefs | null, first?: boolean) {
    route = from && to ? SR.route(model!, from, to, Object.assign({}, p || {})) : null;
    const had = focus;
    setFocus();
    if (!first && (had || focus)) build();   // another part of the station
    if (routeGroup) { scene.remove(routeGroup); freeGroup(routeGroup); routeGroup = null; }
    if (route) drawRoute();
    labelsDirty = true;
    return route;
  }
  function routePoints() { return route!.points.map(([x, y, l]) => V(x, y, zOf(l)).setY(zOf(l) * S + ROUTE_Y)); }
  function drawRoute() {
    if (routeGroup) { scene.remove(routeGroup); freeGroup(routeGroup); }
    routeGroup = new THREE.Group();
    const pts = routePoints();
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 0; i + 1 < pts.length; i++) if (pts[i].distanceTo(pts[i + 1]) > 0.01) path.add(new THREE.LineCurve3(pts[i], pts[i + 1]));
    if (!path.curves.length) return;
    const seg = Math.min(1200, Math.max(16, Math.round(path.getLength() / 1.5)));
    const tube = new THREE.TubeGeometry(path, seg, 0.5, 8, false);
    const casing = new THREE.TubeGeometry(path, seg, 0.78, 8, false);
    routeGroup.add(new THREE.Mesh(casing, new THREE.MeshBasicMaterial({ color: ROUTE_CASE, side: THREE.BackSide })));
    routeGroup.add(new THREE.Mesh(tube, new THREE.MeshLambertMaterial({ color: ROUTE, emissive: ROUTE, emissiveIntensity: 0.35 })));
    // and an x-ray copy, faint, drawn through the floors: where a floor hides the way, you still see where it goes
    const xray = new THREE.Mesh(tube, new THREE.MeshBasicMaterial({ color: ROUTE, transparent: true, opacity: 0.38, depthTest: false, depthWrite: false }));
    xray.renderOrder = 10;
    routeGroup.add(xray);
    for (const [p, colr] of [[pts[0], 0x1f8a4c], [pts[pts.length - 1], 0xd7263d]] as const) {
      routeGroup.add(new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.5, 20).translate(p.x, p.y, p.z), new THREE.MeshLambertMaterial({ color: colr })));
    }
    scene.add(routeGroup);
  }
  // the cutaway follows the given points: pieces of at most `piece` metres, each opening the floors above it
  function cutAlong(pts: THREE.Vector3[]) {
    // join short pieces first, so the budget of MAX_CUT pieces covers the whole way, then split long ones
    const segs = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], c = pts[i + 1];
      const flat = Math.hypot(c.x - a.x, c.z - a.z);
      if (flat < 0.5 && Math.abs(c.y - a.y) > 1) segs.push({ a, c, shaft: true, len: 0 });
      else if (flat >= 0.01) segs.push({ a, c, shaft: false, len: flat });
    }
    const shafts = segs.filter((s) => s.shaft).length;
    const total = segs.reduce((t, s) => t + s.len, 0) || 1;
    const budget = Math.max(1, MAX_CUT - shafts);
    const pieces = [];
    for (const s of segs) {
      if (s.shaft) { pieces.push({ p: s.a, q: s.c, y: ceilingAbove(Math.min(s.a.y, s.c.y)), r: 3.5 }); continue; }
      const n = Math.max(1, Math.round(s.len / total * budget));
      for (let k = 0; k < n; k++) {
        const p = s.a.clone().lerp(s.c, k / n), q = s.a.clone().lerp(s.c, (k + 1) / n);
        // on a slope the threshold follows the slope: floors the escalator passes under are opened too
        pieces.push({ p, q, y: ceilingAbove(Math.max(p.y, q.y)), r: CUT_R });
      }
    }
    // too many after rounding: merge neighbours (never drop the end of the way)
    while (pieces.length > MAX_CUT) {
      let best = 0, bl = Infinity;
      for (let i = 0; i + 1 < pieces.length; i++) {
        const l = pieces[i].p.distanceTo(pieces[i + 1].q);
        if (pieces[i].r === CUT_R && pieces[i + 1].r === CUT_R && l < bl) { bl = l; best = i; }
      }
      const a = pieces[best], b2 = pieces[best + 1];
      pieces.splice(best, 2, { p: a.p, q: b2.q, y: Math.max(a.y, b2.y), r: CUT_R });
    }
    CUT.uN.value = pieces.length;
    pieces.forEach((pc, i) => {
      CUT.uSeg.value[i].set(pc.p.x, pc.p.z, pc.q.x, pc.q.z);
      CUT.uSegY.value[i] = pc.y;   // open what is above this piece of the way (its own floor stays)
      CUT.uSegR.value[i] = pc.r;
    });
    CUT.uCutY.value = 1e6;
  }
  // what may stay above a point of the way (y of the way): up to 3 m over its floor (walls, shops, pins stay whole),
  // but never into the underside of the next floor up, whatever the stretch
  function ceilingAbove(y: number) {
    const floorY = y - ROUTE_Y;
    let next = Infinity;
    for (const l of levels) { const ly = l.z * S - SLAB_T; if (ly > floorY + 0.3 && ly < next) next = ly; }
    return Math.min(floorY + 3.0, next - 0.05);
  }
  function noCut() { CUT.uN.value = 0; CUT.uCutY.value = 1e6; }

  // ------------------------------------------------------------------ camera
  let anim: ((now: number) => void) | null = null;
  function frame(pts: THREE.Vector3[], { elev = 42, yaw = null, pad = 1.25 }: SolidFrameOptions = {}) {
    const box = new THREE.Box3().setFromPoints(pts);
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(25, Math.hypot(size.x, size.z) / 2 + size.y / 2) * pad;
    // look across the way the step runs, so a climb shows in profile
    let az = yaw;
    if (az == null) {
      const d = new THREE.Vector3().subVectors(pts[pts.length - 1], pts[0]);
      az = Math.hypot(d.x, d.z) > 2 ? Math.atan2(d.x, d.z) + Math.PI / 2 : Math.PI / 4;
    } else az = yaw! * Math.PI / 180;
    const e = elev * Math.PI / 180;
    const fov = camera.fov * Math.PI / 180;
    const dist = r / Math.sin(fov / 2) * (camera.aspect < 1 ? 1 / Math.max(0.55, camera.aspect) : 1);
    const pos = new THREE.Vector3(centre.x + dist * Math.cos(e) * Math.sin(az), centre.y + dist * Math.sin(e), centre.z + dist * Math.cos(e) * Math.cos(az));
    flyTo(pos, centre);
  }
  function flyTo(pos: THREE.Vector3, target: THREE.Vector3) {
    const p0 = camera.position.clone(), t0 = controls.target.clone(), start = performance.now(), dur = 650;
    anim = (now) => {
      const k = Math.min(1, (now - start) / dur), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      camera.position.lerpVectors(p0, pos, e);
      controls.target.lerpVectors(t0, target, e);
      if (k >= 1) anim = null;
    };
    request();
  }

  // ------------------------------------------------------------------ labels (HTML, culled by priority)
  let labels: SolidLabel[] = [], labelsDirty = true;
  function makeLabels() {
    labelsEl.textContent = '';
    labels = [];
    const add = (text: string, x: number, y: number, z: number, cls: string, prio: number, opts2: SolidLabelOptions = {}) => {
      const el = document.createElement('div');
      el.className = 'sx-label ' + cls;
      el.textContent = text;
      labelsEl.appendChild(el);
      labels.push(Object.assign({ el, pos: V(x, y, z).setY(z * S + (opts2.up || 2.4)), prio, z }, opts2));
    };
    const used = new Set(route ? route.points.map((p) => Math.round(p[2])) : []);
    // each floor named at the edge of its largest slab (the west-most corner), so the stack reads as one building
    for (const lv of levels) {
      if (!onLevel(lv.id)) continue;
      const big = solid!.slabs.filter((s) => s.level === lv.id && lineIn(s.rings[0])).sort((a, b2) => b2.rings[0].length - a.rings[0].length)[0];
      if (!big) continue;
      const corner = big.rings[0].reduce((m, p) => (p[0] - p[1] < m[0] - m[1] ? p : m), big.rings[0][0]);
      add(`${lv.id > 0 ? '+' : ''}${lv.id}  ${lv.name}`, corner[0], corner[1], lv.z, 'sx-level', 60, { up: 0.6 });
    }
    for (const l of solid!.labels) {
      if (!keep(levelOfZ(l.z), l.x, l.y)) continue;
      if (l.kind === 'platform') add(l.text, l.x, l.y, l.z, 'sx-plat', used.has(Math.round(levelOfZ(l.z))) ? 70 : 45);
      else if (l.kind === 'place') add(l.text, l.x, l.y, l.z, 'sx-place', 55);
      else if (l.kind === 'entrance') add(l.text, l.x, l.y, l.z, 'sx-entr', 50);
      else if (l.kind === 'sector') add(l.text, l.x, l.y, l.z, 'sx-sector', 25, { near: 140 });
    }
    for (const p of solid!.pins) if (p.name && keep(p.level, p.x, p.y)) add(p.name, p.x, p.y, p.z, 'sx-pin sx-' + p.kind, 15, { near: 110, up: 2.9 });
    if (route) {
      const pts = route.points;
      add('Start', pts[0][0], pts[0][1], zOf(pts[0][2]), 'sx-start', 100, { up: 3.2 });
      add(endName(), pts[pts.length - 1][0], pts[pts.length - 1][1], zOf(pts[pts.length - 1][2]), 'sx-end', 100, { up: 3.2 });
      let n = 0;
      route.steps.forEach((s, i) => {
        if (s.kind === 'walk' || s.kind === 'arrive') return;
        n++;
        const p = pts[s.from];
        const arrow = s.dir === 'up' ? '↑' : s.dir === 'down' ? '↓' : '↕';
        add(`${n}  ${kindName(s.kind)} ${arrow} ${levelName(s.toLevel)}`, p[0], p[1], zOf(p[2]), 'sx-step' + (i === stepIdx ? ' sx-on' : ''), i === stepIdx ? 98 : 90, { up: 3.0, step: i });
      });
    }
    labelsDirty = false;
  }
  const levelOfZ = (z: number) => levels.reduce((best, l) => (Math.abs(l.z - z) < Math.abs(best.z - z) ? l : best), levels[0]).id;
  const kindName = (k: StationRouteConnectorKind) => ({ escalator: 'Escalator', stairs: 'Stairs', elevator: 'Lift', ramp: 'Ramp' })[k] || k;
  const levelName = (l: number) => { const lv = levels.find((x) => x.id === Math.round(l)); return lv ? `${lv.id > 0 ? '+' : ''}${lv.id}${lv.name ? ' ' + lv.name : ''}` : String(l); };
  const endName = () => {
    const s = route && route.toStop;
    if (!s) return 'Destination';
    if (s.mode === 'train' && s.ref) return `Platform ${s.ref}`;
    return `${s.mode === 'tram' ? 'Tram' : 'Bus'} ${String(s.name).replace(/^[^,]*,\s*/, '')}${s.ref ? ' ' + s.ref : ''}`;
  };
  const tmp = new THREE.Vector3();
  function placeLabels() {
    if (labelsDirty) makeLabels();
    const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
    const camDist = camera.position.distanceTo(controls.target);
    const shown: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const order = labels.slice().sort((a, b2) => b2.prio - a.prio);
    for (const L of order) {
      tmp.copy(L.pos).project(camera);
      let ok = tmp.z < 1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05;
      if (ok && L.near && camDist > L.near * 2.2) ok = false;
      if (ok && L.z * S > CUT.uCutY.value) ok = false;
      if (ok && L.prio < 90 && cutHere(L.pos)) ok = false;
      const x = (tmp.x + 1) / 2 * w, y = (1 - tmp.y) / 2 * h;
      if (ok) {
        const r = { x0: x - 60, x1: x + 60, y0: y - 16, y1: y + 4 };
        if (shown.length >= 15 && L.prio < 90) ok = false;
        else if (shown.some((s) => !(r.x1 < s.x0 || r.x0 > s.x1 || r.y1 < s.y0 || r.y0 > s.y1))) ok = L.prio >= 90;   // the way's own markers always show
        if (ok) shown.push(r);
      }
      L.el.style.display = ok ? '' : 'none';
      if (ok) L.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
    }
  }
  function cutHere(p: THREE.Vector3) {
    for (let i = 0; i < CUT.uN.value; i++) {
      if (p.y - 2 <= CUT.uSegY.value[i]) continue;
      const s = CUT.uSeg.value[i];
      const ax = s.x, az = s.y, bx = s.z, bz = s.w, dx = bx - ax, dz = bz - az;
      const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / Math.max(dx * dx + dz * dz, 1e-4)));
      if (Math.hypot(p.x - ax - dx * t, p.z - az - dz * t) < CUT.uSegR.value[i]) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ render loop (on demand)
  let pending = false, disposed = false, raf = 0;
  function request() { if (!pending && !disposed) { pending = true; raf = requestAnimationFrame(render); } }
  function render(now: number) {
    pending = false;
    if (anim) anim(now);
    const moving = controls.update();
    renderer.render(scene, camera);
    placeLabels();
    if (anim || moving) request();
  }
  controls.addEventListener('change', request);
  function resize() {
    const w = mount.clientWidth || window.innerWidth, h = mount.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = w + 'px'; renderer.domElement.style.height = h + 'px';
    camera.aspect = w / h; camera.updateProjectionMatrix();
    request();
  }
  const ro = new ResizeObserver(resize); ro.observe(mount);
  const mq = matchMedia('(prefers-color-scheme: dark)'); const onScheme = () => { build(); request(); };
  mq.addEventListener('change', onScheme);

  // ------------------------------------------------------------------ views
  function whole() {
    stepIdx = -1; mode = { kind: 'whole' };
    if (route) { const pts = routePoints(); cutAlong(pts); frame(pts, { elev: 34, pad: 1.1 }); }
    else { noCut(); overview(); }
    labelsDirty = true; request(); changed();
  }
  function step(i: number) {
    if (!route) return;
    stepIdx = Math.max(0, Math.min(route.steps.length - 1, i));
    mode = { kind: 'step' };
    const s = route.steps[stepIdx];
    const all = routePoints();
    // the step, with a little of what comes before and after it
    const pts = all.slice(Math.max(0, s.from - 1), Math.min(all.length, s.to + 2));
    cutAlong(all.slice(Math.max(0, s.from - 3), Math.min(all.length, s.to + 4)));
    frame(pts.length > 1 ? pts : all, { elev: s.kind === 'walk' ? 45 : 30, pad: 1.3 });
    labelsDirty = true; request(); changed();
  }
  let mode: SolidMode = { kind: 'whole' };
  function floor(id: number | null) {
    if (id == null) { whole(); return; }
    const lv = levels.find((l) => l.id === id);
    if (!lv) return;
    mode = { kind: 'floor', id };
    noCut();
    // everything above this floor is cut away (its outlines stay, as a ghost of the building)
    CUT.uCutY.value = lv.z * S + WALL_H + 0.5;
    const pts = solid!.slabs.filter((s) => s.level === id).flatMap((s) => s.rings[0].map(([x, y]) => V(x, y, s.z)));
    frame(pts.length ? pts : [V(cx, cy, lv.z)], { elev: 55, yaw: 30, pad: 0.9 });
    stepIdx = -1; focusLevel = id; labelsDirty = true; request(); changed();
  }
  let focusLevel: number | null = null;
  function overview() {
    const pts = solid!.slabs.flatMap((s) => s.rings[0].map(([x, y]) => V(x, y, s.z)));
    frame(pts, { elev: 32, yaw: 30, pad: 0.8 });
  }
  function changed() { if (opts.onChange) opts.onChange({ route, step: stepIdx, focusLevel: stepIdx < 0 ? focusLevel : null }); focusLevel = null; }

  // ------------------------------------------------------------------ start
  if (opts.from && opts.to) plan(opts.from, opts.to, opts.prefs, true);
  build();
  resize();
  whole();

  return {
    model, solid, levels,
    get route() { return route; },
    plan: (from: SolidEnd, to: SolidEnd, p?: StationRoutePrefs | null) => { plan(from, to, p); whole(); return route; },
    step, whole, floor,
    next: () => step(stepIdx + 1), prev: () => step(stepIdx - 1),
    /** true: the whole station; false: only the part the route uses (the default). */
    showAll: (on: boolean) => { showAll = !!on; setFocus(); build(); labelsDirty = true; if (mode.kind === 'floor') floor(mode.id); else if (stepIdx >= 0) step(stepIdx); else whole(); },
    get focused() { return !!focus; },
    setStretch: (s: number) => { S = s; build(); if (mode.kind === 'floor') floor(mode.id); else if (stepIdx >= 0) step(stepIdx); else whole(); },
    get stretch() { return S; },
    reset: () => (stepIdx >= 0 ? step(stepIdx) : whole()),
    dispose: () => { disposed = true; cancelAnimationFrame(raf); if (world) freeGroup(world); if (routeGroup) freeGroup(routeGroup);
      textures.chevron.dispose(); textures.stripe.dispose(); ro.disconnect(); mq.removeEventListener('change', onScheme); controls.dispose(); renderer.dispose(); mount.removeChild(renderer.domElement); mount.removeChild(labelsEl); },
    _debug: () => ({ cut: CUT.uN.value, labels: labels.filter((l) => l.el.style.display !== 'none').map((l) => l.el.textContent), calls: renderer.info.render.calls, tris: renderer.info.render.triangles, mem: Object.assign({}, renderer.info.memory) }),
  };
}
