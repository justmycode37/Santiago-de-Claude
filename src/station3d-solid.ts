// Continuous 3D view of the inside of a station: one building at true heights (stretched upwards so floors read),
// floors with the wells of their stairs and escalators, walls where OpenStreetMap has them, shops, and every stair,
// escalator, ramp and lift as a 3D object with its direction. The route is a tube through it, and the floors above
// the route are cut open along it (a corridor cutaway), so the way down stays in view without pulling floors apart.
//
// Reads the station model (stations3d/<key>.js, SCHEMA.md), its solid companion (stations3d/<key>.solid.js, built by
// tools/station3d_solid.py) and routes with station-route.ts. three.js r170 through the page's import map.
//
//   import { open } from './station3d-solid.ts';
//   const view = await open({ mount, key, from, to, prefs, onChange });
//   view.step(i) · view.whole() · view.floor(levelId | null) · view.setStretch(s) · view.reset() · view.dispose()
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { StationRoute } from './station-route.ts';
import { layoutAtStop, layoutTrain } from './train-layout.ts';
import type { StationRouteEndpoint, StationRoutePrefs, StationRouteResult, StationRouteSnap, StationRouteStep } from './station-route.ts';
import type { StopPose, TrainCar, TrainLayout } from './train-layout.ts';
import type { TrainCoach, TrainCrowd } from './train-formation.ts';
import { DOOR_IN_M, NOSE_DOOR_M } from './coach-plan.ts';


const MAX_CUT = 40;               // route pieces the cutaway can follow
const CUT_R = 14;                 // m: half-width of the corridor cut open above the route
const XRAY_R = 9;                 // m: the hole seen through whatever stands between the camera and the step
const ROUTE_Y = 0.55;             // m above the floor
const WALL_H = 2.2, KERB_H = 0.22, RAIL_H = 1.0, SLAB_T = 0.4, ROOM_H = 1.6;
const ESC_UP = 0x0f9d8a, ESC_DOWN = 0xe07b00, ESC_BOTH = 0x8a929c;
const ROUTE = 0xffc928, ROUTE_CASE = 0x14161a;
const ARROW_M = 9;                // m between the arrowheads on the way
const TUBE_R = 0.5, THIN_R = 0.24; // m: the way's tube; on stairs, escalators and ramps (so they show under it)
const PIN = { shop: 0x5b6cff, food: 0xe0533d, service: 0x1f8a4c, toilets: 0x7a5cc4 };
const POI_M = 35;                 // m: services this near the way are named on it
const POI_NAME: Record<string, string> = { tickets: 'Tickets', toilets: 'Toilets', info: 'Information', 'meeting-point': 'Meeting point', lockers: 'Lockers' };

/** An end of the way, as the router takes it; none: no way is planned (the station is only shown). */
type SolidEnd = StationRouteEndpoint | null | undefined;
/** What onChange is told: the way (if any), the step shown (-1: the whole way) and the floor picked (if one is). */
export interface SolidChange { route: StationRouteResult | null; step: number; focusLevel: number | null; playing?: boolean; pov?: boolean }
/** Where you are, as the view shows it (setUser): onUser gets it at every fix. */
export interface SolidUserState {
  visible: boolean; outside?: boolean; far?: number; x?: number; y?: number;
  /** null: no floor observed (GPS alone, or the filter not sure enough to say one). */
  level?: number | null; levelProb?: number | null; levelProbs?: Record<string, number> | null; sure?: boolean;
  acc?: number;
  /** 'route': on the way (its step is shown); 'free': somewhere else in the station. */
  mode?: 'route' | 'free'; step?: number; offRouteSec?: number; follow: boolean;
}
export interface SolidOptions {
  mount: HTMLElement;
  key: string;
  from?: SolidEnd;
  to?: SolidEnd;
  prefs?: StationRoutePrefs | null;
  /** Vertical stretch (default 2.2). */
  stretch?: number;
  onChange?: (state: SolidChange) => void;
  /** Your position as the view shows it, at every setUser(). */
  onUser?: (state: SolidUserState) => void;
}
/** What open() gives: the view and its controls. */
export type SolidView = Awaited<ReturnType<typeof open>>;
/** Anything in the scene that may have a geometry and materials to free. */
interface SolidDrawn extends THREE.Object3D { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] }
interface SolidFrameOptions { elev?: number; yaw?: number | null; pad?: number }
/** `near`: shown only from closer than about twice this; `up`: metres above the floor; `step`: index into route.steps. */
interface SolidLabelOptions { up?: number; near?: number; step?: number; html?: string }
interface SolidLabel extends SolidLabelOptions {
  el: HTMLDivElement; pos: THREE.Vector3; prio: number; z: number; behind?: boolean;
  /** What the DOM shows now (written only when it changes). */
  vis?: boolean; tf?: string;
  /** First person: the room it stands in (its walls do not hide it; -1: none). */
  room?: number;
}
type SolidMode = { kind: 'whole' } | { kind: 'step' } | { kind: 'floor'; id: number };
/** A vehicle at a platform or stop of the way (setTrain): the one the way leads to (board) or starts from (alight).
 *  A train with its coaches, or only the sectors it stops in; a tram or bus of a typical shape at its stop. */
export interface SolidTrainInput {
  role: 'board' | 'alight';
  kind: 'train' | 'tram' | 'bus';
  ref: string;
  coaches: TrainCoach[] | null;
  sectors: string[];
  /** Indices into coaches: where to get on (drawn in the way's colour, with the boarding zone on the platform). */
  target: number[];
  /** The sector the way leads to (named on the boarding zone). */
  sector?: string | null;
  /** The forecast per class, and the class you travel in (the crowding the coaches show is that class's). */
  crowd: { first: TrainCrowd | null; second: TrainCrowd | null } | null;
  cls: 1 | 2;
  /** The door of the chosen coach (coach-plan.ts): the way is drawn on through it into the coach (board) or out of
   *  it (alight). xy: the spot on the platform in front of it; inside: on the track. */
  door?: { xy: XY; inside: XY } | null;
  /** A tram or bus: its stop and the direction it travels. */
  pose?: StopPose | null;
  /** The label over a tram or bus ("Tram 9"). */
  title?: string;
  /** Not from the journey: a typical train at the platform the way ends or starts at, when the journey gave none there.
   *  A few plain coaches near where the way arrives, no classes, no boarding zone, quieter. */
  ambient?: boolean;
}
const HOLO = 0x52d6ff, HOLO_TARGET = 0xffc928, HOLO_LIGHT = 0x0a7fb5, HOLO_TARGET_LIGHT = 0xc98a00, HOLO_OFF = 0x3ddc84, HOLO_OFF_LIGHT = 0x1f8a4c;
/** Text for a label's innerHTML (names from the timetable go into it). */
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);

export async function open(opts: SolidOptions) {
  const { mount, key } = opts;
  const model = window.STATION3D && window.STATION3D[key];
  const solid = window.STATION3D_SOLID && window.STATION3D_SOLID[key];
  /** The cadastral survey's layer (tools/station3d_av.py), where the canton publishes it. */
  const av = solid ? solid.av || null : null;
  const SR = StationRoute;
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
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 2.2);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(-300, 600, 400);
  scene.add(sun);
  const labelsEl = document.createElement('div');
  labelsEl.className = 'sx-labels';
  mount.appendChild(labelsEl);
  // first person in a lift: what its display would say (the eye would only see the inside of the car)
  const liftEl = document.createElement('div');
  liftEl.className = 'sx-lift';
  liftEl.hidden = true;
  mount.appendChild(liftEl);

  // the corridor cutaway: every architecture material discards fragments above the route, near it
  const CUT = {
    uSeg: { value: Array.from({ length: MAX_CUT }, () => new THREE.Vector4()) },
    uSegY: { value: new Float32Array(MAX_CUT) }, uSegR: { value: new Float32Array(MAX_CUT) },
    uN: { value: 0 }, uR: { value: CUT_R }, uCutY: { value: 1e6 },
    // where the pieces are (x0, z0, x1, z1, each widened by its radius) and the lowest height they open: a fragment outside
    // either skips the loop
    uCutBox: { value: new THREE.Vector4() }, uCutMinY: { value: 1e6 },
    // the see-through hole: what is above the floor in focus and between the camera and it (uXR: its radius; 0 = off)
    uEye: { value: new THREE.Vector3() }, uFocus: { value: new THREE.Vector3() }, uXR: { value: 0 }, uXY: { value: 0 },
  };
  function cutaway<M extends THREE.Material>(mat: M) {
    if (pov) return mat;
    mat.customProgramCacheKey = () => 'sx-cut';
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
          uniform float uR; uniform float uCutY; uniform vec3 uEye; uniform vec3 uFocus; uniform float uXR; uniform float uXY;
          uniform vec4 uCutBox; uniform float uCutMinY;`)
        .replace('void main() {', `void main() {
          if (vWP.y > uCutY) discard;
          if (uXR > 0.0 && vWP.y > uXY) {
            vec3 ray = uEye - uFocus; float L = length(ray); vec3 dir = ray / max(L, 1e-3);
            float s = dot(vWP - uFocus, dir);
            if (s > 0.0 && s < L && length(vWP - uFocus - dir * s) < uXR) discard;
          }
          if (vWP.y > uCutMinY && vWP.x > uCutBox.x && vWP.z > uCutBox.y && vWP.x < uCutBox.z && vWP.z < uCutBox.w)
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
        track: 0x1a1d22, rail: 0x6b717a, step: 0xb9b2a5, riser: 0x55524c, room: 0x6b6f86, outline: 0x8a94a3,
        truss: 0x3d434c, handrail: 0x0d0f12, glassEdge: 0x7f9fc4, povWall: 0x4a4f58, povCeil: 0x3a3d42,
        povFloor: 0x55524d, under: 0x1d1c1a, bed: 0x23221f, steel: 0x8d939b }
    : { bg: 0xeef1f4, top: 0xe9e2d4, deep: 0x8e9cb0, edge: 0x3a4250, wall: 0xf7f5f0, kerb: 0x6a7180, glass: 0x7fb2e5,
        track: 0x50545b, rail: 0x9aa0a8, step: 0xf2ece0, riser: 0x9c9384, room: 0xd9dcef, outline: 0x56606e,
        truss: 0xaeb5bf, handrail: 0x2a2f37, glassEdge: 0x5d8fc4, povWall: 0xe4e1da, povCeil: 0xe2e2df,
        povFloor: 0xd9d5cd, under: 0x3b3934, bed: 0x4a4843, steel: 0x9aa1aa };
  type SolidPalette = ReturnType<typeof pal>;
  function levelColour(id: number, P: SolidPalette) {
    // warm stone at the top, cooler and darker going down; floors above 0 lighter still
    const i = levels.findIndex((l) => l.id === id), n = Math.max(1, levels.length - 1);
    const top = levels.findIndex((l) => l.id === 0);
    const f = top < 0 ? i / n : Math.max(0, (top - i) / Math.max(1, top));
    return new THREE.Color(P.top).lerp(new THREE.Color(P.deep), Math.min(1, f));
  }

  // ------------------------------------------------------------------ geometry helpers
  function strip(lines: { line: XY[]; z: number }[], h: number, lift = 0, uvLen = 1) {
    // vertical quads along polylines: [{ line: [[x, y]], z }] → BufferGeometry; uv: u in uvLen metres along, v 0 → 1 up
    const pos: number[] = [], uv: number[] = [];
    for (const { line, z } of lines) {
      let run = 0;
      for (let i = 0; i + 1 < line.length; i++) {
        const a = V(line[i][0], line[i][1], z), c = V(line[i + 1][0], line[i + 1][1], z);
        const y0 = z * S + lift, y1 = y0 + h, u0 = run / uvLen, u1 = (run += Math.hypot(c.x - a.x, c.z - a.z)) / uvLen;
        pos.push(a.x, y0, a.z, c.x, y0, c.z, c.x, y1, c.z, a.x, y0, a.z, c.x, y1, c.z, a.x, y1, a.z);
        uv.push(u0, 0, u1, 0, u1, 1, u0, 0, u1, 1, u0, 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
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

  // ------------------------------------------------------------------ first person: surfaces
  // Small canvas textures, drawn once and light (the material's colour tints them, so the dark scheme changes only colours):
  // stone floor tiles, wall panels with a skirting and soft shade at the floor and under the ceiling, ceiling panels with
  // light strips (glowing), and shop fronts (a plinth, glazing between mullions lit from inside, a fascia in the kind's
  // colour). World-sized: a floor tile is 60 cm, a wall panel 1.2 m, a shop bay 2 m.
  type ShopKind = StationSolidPinKind | 'room';
  interface Surfaces { floor: THREE.Texture; wall: THREE.Texture; ceil: THREE.Texture; ceilGlow: THREE.Texture; bed: THREE.Texture;
    shop: Record<ShopKind, { map: THREE.Texture; glow: THREE.Texture }> }
  let surf: Surfaces | null = null;
  function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, data = false) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d')!);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (!data) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return t;
  }
  /** A repeatable pseudo-random sequence (the same tiles every time). */
  const rnd = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  function surfaces(): Surfaces {
    if (surf) return surf;
    const r = rnd(7);
    const floor = canvasTex(512, 512, (g) => {
      // 4 × 4 tiles of 60 cm (128 px), each a slightly different stone, a fine speckle, grout between them
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        const v = 240 + Math.round(r() * 9);
        g.fillStyle = `rgb(${v},${v - 1},${v - 4})`; g.fillRect(i * 128, j * 128, 128, 128);
      }
      for (let k = 0; k < 2600; k++) { g.fillStyle = `rgba(${r() < 0.5 ? '90,86,80' : '255,255,255'},${0.05 + r() * 0.08})`; g.fillRect(r() * 512, r() * 512, 1 + r() * 2, 1 + r() * 2); }
      g.fillStyle = 'rgba(120,114,104,0.28)';
      for (let i = 0; i < 4; i++) { g.fillRect(i * 128, 0, 2, 512); g.fillRect(0, i * 128, 512, 2); }
    });
    floor.repeat.set(1 / 2.4, 1 / 2.4);
    const wall = canvasTex(128, 512, (g) => {
      // a panel 1.2 m wide, the whole height of the wall: joint at its edge, skirting, shade at the foot and the top
      g.fillStyle = '#f3f1ed'; g.fillRect(0, 0, 128, 512);
      let gr = g.createLinearGradient(0, 512, 0, 380); gr.addColorStop(0, 'rgba(40,36,30,0.30)'); gr.addColorStop(1, 'rgba(40,36,30,0)');
      g.fillStyle = gr; g.fillRect(0, 380, 128, 132);
      gr = g.createLinearGradient(0, 0, 0, 70); gr.addColorStop(0, 'rgba(40,36,30,0.22)'); gr.addColorStop(1, 'rgba(40,36,30,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 128, 70);
      g.fillStyle = '#7a756d'; g.fillRect(0, 494, 128, 18);     // skirting
      g.fillStyle = 'rgba(90,84,76,0.35)'; g.fillRect(0, 0, 2, 494);   // joint
    });
    const ceilDraw = (glow: boolean) => (g: CanvasRenderingContext2D) => {
      // 60 cm panels; one light strip of 1.8 m × 14 cm in each 2.4 m
      g.fillStyle = glow ? '#000' : '#f4f4f1'; g.fillRect(0, 0, 512, 512);
      if (!glow) { g.fillStyle = 'rgba(140,140,135,0.45)'; for (let i = 0; i < 4; i++) { g.fillRect(i * 128, 0, 2, 512); g.fillRect(0, i * 128, 512, 2); } }
      if (glow) { g.shadowColor = 'rgba(255,240,210,0.9)'; g.shadowBlur = 18; }
      g.fillStyle = glow ? '#fff6e6' : '#fffdf7'; g.fillRect(64, 241, 384, 30);
    };
    const ceil = canvasTex(512, 512, ceilDraw(false)), ceilGlow = canvasTex(512, 512, ceilDraw(true));
    for (const t of [ceil, ceilGlow]) t.repeat.set(1 / 2.4, 1 / 2.4);
    const bed = canvasTex(256, 256, (g) => {
      // concrete of a track trough: grey, blotched
      g.fillStyle = '#c9c6c0'; g.fillRect(0, 0, 256, 256);
      for (let k = 0; k < 900; k++) { g.fillStyle = `rgba(60,58,54,${0.04 + r() * 0.08})`; g.beginPath(); g.arc(r() * 256, r() * 256, 1 + r() * 4, 0, 7); g.fill(); }
    });
    bed.repeat.set(1 / 4, 1 / 4);
    const fascia: Record<ShopKind, string> = { shop: '#3f4fb8', food: '#b8432f', service: '#1f7a46', toilets: '#6a4fb0', room: '#8c8a85' };
    const shop = {} as Surfaces['shop'];
    for (const k of Object.keys(fascia) as ShopKind[]) {
      const glass = k !== 'room';
      // a bay 2 m wide, the whole height (v: 0 the floor, 1 the ceiling): plinth, glazing, transom, fascia, wall
      const Y = (f: number) => 512 - f * 512;
      const map = canvasTex(256, 512, (g) => {
        g.fillStyle = '#efeeea'; g.fillRect(0, 0, 256, 512);
        g.fillStyle = '#56524c'; g.fillRect(0, Y(0.05), 256, 0.05 * 512);
        if (glass) {
          const gr = g.createLinearGradient(0, Y(0.05), 0, Y(0.72)); gr.addColorStop(0, '#9fb6c6'); gr.addColorStop(1, '#d9e6ee');
          g.fillStyle = gr; g.fillRect(0, Y(0.72), 256, 0.67 * 512);
          // a reflection across the glass
          g.fillStyle = 'rgba(255,255,255,0.28)'; g.beginPath(); g.moveTo(40, Y(0.05)); g.lineTo(110, Y(0.05)); g.lineTo(200, Y(0.72)); g.lineTo(130, Y(0.72)); g.fill();
          g.fillStyle = '#35383d'; g.fillRect(0, Y(0.72), 8, 0.67 * 512); g.fillRect(0, Y(0.75), 256, 0.03 * 512);   // mullion, transom
        } else {
          g.fillStyle = '#dedbd5'; g.fillRect(6, Y(0.75), 244, 0.70 * 512);
          g.fillStyle = 'rgba(90,84,76,0.35)'; g.fillRect(0, Y(0.75), 2, 0.70 * 512);
        }
        g.fillStyle = fascia[k]; g.fillRect(0, Y(0.88), 256, 0.13 * 512);
        g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillRect(0, Y(0.81), 256, 4);
        const gr2 = g.createLinearGradient(0, 512, 0, Y(0.16)); gr2.addColorStop(0, 'rgba(40,36,30,0.28)'); gr2.addColorStop(1, 'rgba(40,36,30,0)');
        g.fillStyle = gr2; g.fillRect(0, Y(0.16), 256, 0.16 * 512);
      });
      // the light from inside the shop, and its sign
      const glow = canvasTex(256, 512, (g) => {
        g.fillStyle = '#000'; g.fillRect(0, 0, 256, 512);
        if (glass) { const gr = g.createLinearGradient(0, Y(0.05), 0, Y(0.72)); gr.addColorStop(0, '#6b5a40'); gr.addColorStop(1, '#3a3226'); g.fillStyle = gr; g.fillRect(8, Y(0.72), 248, 0.67 * 512); }
        g.fillStyle = '#2a2a2a'; g.fillRect(0, Y(0.88), 256, 0.13 * 512);
      });
      shop[k] = { map, glow };
    }
    surf = { floor, wall, ceil, ceilGlow, bed, shop };
    return surf;
  }
  function freeSurfaces() {
    if (!surf) return;
    for (const t of [surf.floor, surf.wall, surf.ceil, surf.ceilGlow, surf.bed, ...Object.values(surf.shop).flatMap((x) => [x.map, x.glow])]) t.dispose();
    surf = null;
  }
  // ------------------------------------------------------------------ focus: only the part of the station the route uses
  // With a route, only its floors (and those a lift or escalator on it passes) are drawn, and on them only what lies
  // within FOCUS_M of the route; showAll(true) draws the whole station again.
  const FOCUS_M = 40;
  let showAll = false;
  let focus: { levels: Set<number>; box: [number, number, number, number]; around: [number, number, number, number] } | null = null;
  /** The buildings round the way (or the station) are drawn this far from it. */
  const AROUND_M = 130;
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
    focus = { levels: lv, box: [x0 - FOCUS_M, y0 - FOCUS_M, x1 + FOCUS_M, y1 + FOCUS_M], around: [x0 - AROUND_M, y0 - AROUND_M, x1 + AROUND_M, y1 + AROUND_M] };
  }
  const inBox = (x: number, y: number) => !focus || (x >= focus.box[0] && x <= focus.box[2] && y >= focus.box[1] && y <= focus.box[3]);
  const onLevel = (level: number) => !focus || focus.levels.has(Math.round(level));
  const lineIn = (line: XY[]) => !focus || line.some(([x, y]) => inBox(x, y)) || (() => {
    // a line that crosses the box without a point in it
    const xs = line.map((p) => p[0]), ys = line.map((p) => p[1]);
    return Math.min(...xs) <= focus!.box[2] && Math.max(...xs) >= focus!.box[0] && Math.min(...ys) <= focus!.box[3] && Math.max(...ys) >= focus!.box[1];
  })();
  const keep = (level: number, x: number, y: number) => onLevel(level) && inBox(x, y);
  const aroundIn = (ring: XY[]) => !focus || ring.some(([x, y]) => x >= focus!.around[0] && x <= focus!.around[2] && y >= focus!.around[1] && y <= focus!.around[3]);
  function build() {
    stale = false;
    buildN++;
    overCache = new Map(); idxCache = new Map(); boxCache = new Map();
    if (world) { scene.remove(world); freeGroup(world); }
    world = new THREE.Group();
    const P = pal();
    scene.background = new THREE.Color(P.bg);
    skyCol.set(P.bg); underCol.set(P.under);
    if (scene.fog instanceof THREE.Fog) scene.fog.color.set(P.bg);   // first person: the fog is the background's colour
    // first person: light from all round and from the ceilings (a hall is lit, not sunlit), so ceilings and walls read
    hemi.color.set(0xffffff); hemi.groundColor.set(pov ? (dark() ? 0x6a665f : 0xd6d0c6) : 0x8a8f99); hemi.intensity = pov ? 2.3 : 2.2;
    sun.intensity = pov ? 0.55 : 1.4;
    if (shared.outline) shared.outline.dispose();
    shared.outline = new THREE.LineBasicMaterial({ color: P.outline, transparent: true, opacity: 0.35 });

    // floors, one mesh per level, and their outlines (the outlines stay when the cutaway opens a floor)
    const byLevel = new Map<number, THREE.ExtrudeGeometry[]>();
    for (const s of solid!.slabs) {
      if (!onLevel(s.level) || !lineIn(s.rings[0])) continue;
      if (!byLevel.has(s.level)) byLevel.set(s.level, []);
      const sh = new THREE.Shape(s.rings[0].map(([x, y]) => new THREE.Vector2(x - cx, y - cy)));
      for (const h of s.rings.slice(1)) sh.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x - cx, y - cy))));
      const T = slabT(s.level);
      const g = new THREE.ExtrudeGeometry(sh, { depth: T, bevelEnabled: false, curveSegments: 1 });
      g.rotateX(-Math.PI / 2);
      g.translate(0, s.z * S - T, 0);
      byLevel.get(s.level)!.push(g);
    }
    if (pov) {
      // stone underfoot, open where a stair or an escalator passes under it within head height (the eye never goes
      // through a floor on its way down)
      const S2 = surfaces();
      for (const [lv, gs] of byLevel) {
        const z = (levels.find((l) => l.id === lv) || { z: 0 }).z;
        const mat = holed(new THREE.MeshLambertMaterial({ color: P.povFloor, map: S2.floor }), connectorHoles(z - slabT(lv) - 2.3, z - 0.05, false, true), 'f' + lv);
        const mesh = new THREE.Mesh(merged(gs), mat);
        mesh.userData.level = lv;
        world.add(mesh);
      }
      byLevel.clear();
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
    // first person: the shops drawn as blocks (not those the way walks through: OpenStreetMap's path runs through them)
    blocks = pov ? solid!.rooms.map((r, i) => (onLevel(r.level) && lineIn(r.ring) && !routeThrough(r) ? i : -1)).filter((i) => i >= 0) : [];
    if (!pov) {
      wallIndex.clear();
      world.add(new THREE.Mesh(strip(wallLines('wall'), WALL_H), cutaway(new THREE.MeshLambertMaterial({ color: P.wall, side: THREE.DoubleSide }))));
      world.add(new THREE.Mesh(strip(wallLines('edge'), KERB_H), cutaway(new THREE.MeshLambertMaterial({ color: P.kerb, side: THREE.DoubleSide }))));
    } else enclose(P, wallLines);
    world.add(new THREE.Mesh(strip(wallLines('rail'), RAIL_H), cutaway(new THREE.MeshLambertMaterial({ color: P.glass, side: THREE.DoubleSide, transparent: true, opacity: 0.32, depthWrite: false }))));
    // rooms with outlines (named only)
    if (pov) shopFronts(P);
    const roomGs: THREE.BufferGeometry[] = [];
    for (const r of solid!.rooms) {
      if (pov || !onLevel(r.level) || !lineIn(r.ring)) continue;
      const sh = new THREE.Shape(r.ring.map(([x, y]) => new THREE.Vector2(x - cx, y - cy)));
      // low (the height is schematic anyway) and opaque: a block that marks the shop without hiding the way
      const g = new THREE.ExtrudeGeometry(sh, { depth: pov ? roomHeight(r.level) : Math.min(r.height, ROOM_H), bevelEnabled: false });
      g.rotateX(-Math.PI / 2); g.translate(0, r.z * S + 0.02, 0);
      // tinted by its kind (shop, food, service, toilets), as the pins are
      const c = new THREE.Color(P.room).lerp(new THREE.Color(r.kind === 'room' ? P.room : PIN[r.kind]), 0.22), n = g.getAttribute('position').count;
      g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n * 3 }, (_, i) => [c.r, c.g, c.b][i % 3]), 3));
      roomGs.push(g);
    }
    if (roomGs.length) {
      const g = merged(roomGs);
      const rm = new THREE.Mesh(g, cutaway(new THREE.MeshLambertMaterial({ vertexColors: true })));
      world.add(rm);
      world.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 40), shared.outline));
    }
    // tracks: a dark bed and two rails (first person: a trough below ground, see povTracks)
    const bedGs = [], railPts = [];
    if (pov) povTracks(P);
    for (const t of pov ? [] : solid!.tracks) {
      if (focus && (!onLevel(levelOfZ(t.z + (t.kind === 'tram' ? 0 : 1.1))) || !lineIn(t.line))) continue;
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
    const pinList = solid!.pins.filter((p) => keep(p.level, p.x, p.y) && !(pov && (fronted.has(p) || roomAt(p.x, p.y, p.level) >= 0)));
    const pins = new THREE.InstancedMesh(pinGeo, cutaway(new THREE.MeshLambertMaterial({ color: 0xffffff })), Math.max(1, pinList.length));
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    pinList.forEach((p, i) => { m4.makeTranslation(p.x - cx, p.z * S, -(p.y - cy)); pins.setMatrixAt(i, m4); pins.setColorAt(i, col.set(PIN[p.kind] || PIN.shop)); });
    if (pinList.length) world.add(pins); else { pinGeo.dispose(); (pins.material as THREE.Material).dispose(); pins.dispose(); }
    // the buildings round it, to find your way outside too: their footprints as faint lines (lines never hide the way)
    const fp: THREE.Vector3[] = [];
    for (const sh of pov ? [] : solid!.shell) {
      if (sh.kind === 'deck' || !aroundIn(sh.ring)) continue;
      const y = sh.base * S + 0.08;
      for (let i = 0; i < sh.ring.length; i++) {
        const a = sh.ring[i], c = sh.ring[(i + 1) % sh.ring.length];
        fp.push(new THREE.Vector3(a[0] - cx, y, -(a[1] - cy)), new THREE.Vector3(c[0] - cx, y, -(c[1] - cy)));
      }
    }
    if (fp.length) world.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(fp), cutaway(new THREE.LineBasicMaterial({ color: P.outline, transparent: true, opacity: 0.4, depthWrite: false }))));
    singlePass(world);
    scene.add(world);
    if (route) drawRoute();
  }
  const shared: { outline: THREE.LineBasicMaterial | null } = { outline: null };
  /** First person: the rooms (indices into solid.rooms) drawn as blocks. */
  let blocks: number[] = [];
  /** Does the way run through this room (a point of it inside, or a piece of it across its outline)? */
  function routeThrough(r: StationSolidRoom) {
    if (!route) return false;
    const P = route.points, ring = r.ring;
    for (let i = 0; i < P.length; i++) {
      if (Math.round(P[i][2]) !== r.level) continue;
      if (inRing(ring, P[i][0], P[i][1])) return true;
      const q = P[i + 1];
      if (q && Math.round(q[2]) === r.level)
        for (let k = 0; k < ring.length; k++) { const a = ring[k], b2 = ring[(k + 1) % ring.length]; if (crosses(P[i][0], P[i][1], q[0], q[1], a[0], a[1], b2[0], b2[1])) return true; }
    }
    return false;
  }
  /** The block (index into solid.rooms) that (x, y) on that level stands in; -1: none. */
  function roomAt(x: number, y: number, level: number) {
    for (const i of blocks) { const r = solid!.rooms[i]; if (r.level === level && inRing(r.ring, x, y)) return i; }
    return -1;
  }

  // ------------------------------------------------------------------ first person: the enclosure
  // From eye level the model has to be closed: walls you cannot look over or through, ceilings below ground, and
  // openings where you actually walk. OpenStreetMap has the floors, not the walls, so the walls are schematic: below
  // ground every edge of a floor (but the platform edges along the tracks) is a wall; at street level and above, the
  // edges of the indoor floors and OpenStreetMap's own walls. Every wall is as high as the room (to the floor above, at
  // most ROOM_MAX), and it opens where a path of the walking graph, a stair, an escalator or a ramp crosses it, so the
  // way never runs through a wall. Below ground a ceiling closes the room, open where stairs, escalators and lifts go up.
  const ROOM_MAX = 3.4, DOOR_M = 1.8, TRACK_SLAB = 1.2;
  /** How thick a floor is drawn: in first person, a floor with tracks reaches below their bed (no gap under a platform's
   *  edge). */
  let trackLevels: Set<number> | null = null;
  const slabT = (level: number) => {
    if (!pov) return SLAB_T;
    trackLevels ||= new Set(solid!.tracks.filter((t) => t.kind !== 'tram').map((t) => levelOfZ(t.z + 1.1)));
    return trackLevels.has(level) ? TRACK_SLAB : SLAB_T;
  };
  /** The level whose floors are over this one's: the first higher level that covers a sixth of its floors (in the focus).
   *  Not merely the next in the table: Zürich's −3 (Museumstrasse) is 1.8 m above −4 (Löwenstrasse), elsewhere. */
  let overCache = new Map<number, StationLevel | null>();
  function levelOver(level: number): StationLevel | null {
    if (overCache.has(level)) return overCache.get(level)!;
    const i = levels.findIndex((l) => l.id === level);
    const pts: XY[] = [];
    for (const s of solid!.slabs) {
      if (s.level !== level || !lineIn(s.rings[0])) continue;
      const r = s.rings[0];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const step = Math.max(4, Math.sqrt((x1 - x0) * (y1 - y0) / 60));
      for (let x = x0 + step / 2; x < x1; x += step) for (let y = y0 + step / 2; y < y1; y += step) if (inRing(r, x, y)) pts.push([x, y]);
    }
    let found: StationLevel | null = null;
    for (let k = i + 1; k < levels.length && pts.length && !found; k++) {
      const up = solid!.slabs.filter((s) => s.level === levels[k].id);
      const n = pts.filter(([x, y]) => up.some((s) => inRing(s.rings[0], x, y))).length;
      if (n >= Math.max(1, pts.length / 6)) found = levels[k];
    }
    overCache.set(level, found);
    return found;
  }
  /** How high a room on this level is (m, in the current stretch): to the underside of the floor above, at most ROOM_MAX. */
  function roomHeight(level: number) {
    const i = levels.findIndex((l) => l.id === Math.round(level)), up = i >= 0 ? levelOver(levels[i].id) : null;
    const room = up ? (up.z - levels[i].z) * S - slabT(up.id) - 0.05 : ROOM_MAX;
    return Math.min(ROOM_MAX, room > 0.5 ? room : 2.4);   // floors closer than that: as much as there is
  }
  type Crossing = [ax: number, ay: number, bx: number, by: number, gap: number];
  /** What may pass through a wall on this level: walking paths on it and the stairs, escalators and ramps that reach it. */
  function crossings(level: number, h: number): Crossing[] {
    const out: Crossing[] = [];
    const lv = levels.find((l) => l.id === level);
    if (!lv) return out;
    // the part of a piece (heights za → zb, metres) that is within the wall's height, from just under its foot
    const z0 = lv.z - 0.5, z1 = lv.z + h / S;
    const clip = (ax: number, ay: number, za: number, bx: number, by: number, zb: number, gap: number) => {
      let t0 = 0, t1 = 1;
      if (Math.abs(zb - za) > 1e-6) {
        const ta = (z0 - za) / (zb - za), tb = (z1 - za) / (zb - za);
        t0 = Math.max(0, Math.min(ta, tb)); t1 = Math.min(1, Math.max(ta, tb));
      } else if (za < z0 || za > z1) return;
      if (t1 <= t0) return;
      out.push([ax + (bx - ax) * t0, ay + (by - ay) * t0, ax + (bx - ax) * t1, ay + (by - ay) * t1, gap]);
    };
    const g = model!.graph, N = g.nodes;
    for (const e of g.edges) {
      const a = N[e.a], c = N[e.b];
      if (Math.abs(a[2] - level) > 1.2 && Math.abs(c[2] - level) > 1.2 && (a[2] - level) * (c[2] - level) > 0) continue;
      clip(a[0], a[1], zOf(a[2]), c[0], c[1], zOf(c[2]), DOOR_M);
    }
    if (route) {
      const P = route.points;
      for (let k = 0; k + 1 < P.length; k++) clip(P[k][0], P[k][1], zOf(P[k][2]), P[k + 1][0], P[k + 1][1], zOf(P[k + 1][2]), 2.2);
    }
    for (const c of solid!.connectors) {
      if (c.kind === 'elevator') continue;
      const gap = Math.max(DOOR_M, (c.width || 1.5) + 0.8);
      for (let k = 0; k + 1 < c.pts.length; k++) clip(c.pts[k][0], c.pts[k][1], c.pts[k][2], c.pts[k + 1][0], c.pts[k + 1][1], c.pts[k + 1][2], gap);
    }
    return out;
  }
  /** The wall lines with openings cut where something crosses them. */
  function withDoors(lines: XY[][], cross: Crossing[]): XY[][] {
    const CELL = 8, grid = new Map<string, number[]>();
    cross.forEach((c, i) => {
      for (let gx = Math.floor(Math.min(c[0], c[2]) / CELL); gx <= Math.floor(Math.max(c[0], c[2]) / CELL); gx++)
        for (let gy = Math.floor(Math.min(c[1], c[3]) / CELL); gy <= Math.floor(Math.max(c[1], c[3]) / CELL); gy++) {
          const k = gx + ',' + gy;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k)!.push(i);
        }
    });
    const out: XY[][] = [];
    for (const line of lines) {
      for (let s = 0; s + 1 < line.length; s++) {
        const [ax, ay] = line[s], [bx, by] = line[s + 1], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
        if (L < 0.05) continue;
        const cut: [number, number][] = [], seen = new Set<number>();
        for (let gx = Math.floor(Math.min(ax, bx) / CELL); gx <= Math.floor(Math.max(ax, bx) / CELL); gx++)
          for (let gy = Math.floor(Math.min(ay, by) / CELL); gy <= Math.floor(Math.max(ay, by) / CELL); gy++)
            for (const i of grid.get(gx + ',' + gy) || []) {
              if (seen.has(i)) continue;
              seen.add(i);
              const [cx0, cy0, cx1, cy1, gap] = cross[i], ex = cx1 - cx0, ey = cy1 - cy0;
              const den = dx * ey - dy * ex, el = Math.hypot(ex, ey);
              if (el < 1e-6) continue;
              if (Math.abs(den) / (L * el) < 0.17) {
                // (nearly) along the wall: where it runs within 0.4 m of it, the wall is open (the floor's edge is wrong there)
                const off0 = Math.abs((cx0 - ax) * dy - (cy0 - ay) * dx) / L, off1 = Math.abs((cx1 - ax) * dy - (cy1 - ay) * dx) / L;
                if (Math.min(off0, off1) > 0.4) continue;
                const s0 = ((cx0 - ax) * dx + (cy0 - ay) * dy) / (L * L), s1 = ((cx1 - ax) * dx + (cy1 - ay) * dy) / (L * L);
                if (Math.max(s0, s1) < -0.02 || Math.min(s0, s1) > 1.02) continue;
                cut.push([Math.min(s0, s1) - 0.5 / L, Math.max(s0, s1) + 0.5 / L]);
                continue;
              }
              const t = ((cx0 - ax) * ey - (cy0 - ay) * ex) / den, u = ((cx0 - ax) * dy - (cy0 - ay) * dx) / den;
              if (t < -0.5 / L || t > 1 + 0.5 / L || u < -0.05 || u > 1.05) continue;
              // the opening is as wide as the gap across the path, wider where the path crosses at a slant
              const sin = Math.abs(den) / (L * el), half = Math.min(gap / 2 / Math.max(sin, 0.35), 4) / L;
              cut.push([t - half, t + half]);
            }
        cut.sort((p, q) => p[0] - q[0]);
        // openings less than 1.2 m apart are one; what stands between two openings (or an opening and the end of the wall)
        // and is under 1 m long is not a wall but a blade, and goes
        const open: [number, number][] = [];
        for (const c of cut) { const last = open[open.length - 1]; if (last && c[0] - last[1] < 1.2 / L) last[1] = Math.max(last[1], c[1]); else open.push([c[0], c[1]]); }
        const lineEnd0 = s === 0, lineEnd1 = s + 2 === line.length;
        let t0 = 0, cutBefore = lineEnd0;
        const piece = (u0: number, u1: number, cutAfter: boolean) => {
          if (u1 - u0 <= 0.02 / L) return;
          if ((u1 - u0) * L < 1.0 && cutBefore && cutAfter && open.length) return;
          out.push([[ax + dx * u0, ay + dy * u0], [ax + dx * u1, ay + dy * u1]]);
        };
        for (const [c0, c1] of open) {
          if (t0 >= 1) break;
          if (c0 > t0) piece(t0, Math.min(c0, 1), true);
          t0 = Math.max(t0, c1);
          cutBefore = true;
        }
        if (t0 < 1) piece(t0, 1, lineEnd1);
      }
    }
    return out.filter((l) => Math.hypot(l[1][0] - l[0][0], l[1][1] - l[0][1]) > 0.05);
  }
  // Where the walls are, per level, to keep the eye and the line on the floor off them: OpenStreetMap often draws a
  // passage's path along its edge, which is now a wall.
  const WCELL = 6;
  /** owner: the room (index into solid.rooms) a piece is the outline of; -1: a wall or a pillar. */
  type WallIdx = { segs: [number, number, number, number][]; owner: number[]; grid: Map<string, number[]> };
  let wallIndex = new Map<number, WallIdx>();
  function indexWalls(lines: XY[][], owners?: number[]): WallIdx {
    const segs: WallIdx['segs'] = [], owner: number[] = [], grid = new Map<string, number[]>();
    for (const [n, l] of lines.entries()) for (let k = 0; k + 1 < l.length; k++) {
      const i = segs.push([l[k][0], l[k][1], l[k + 1][0], l[k + 1][1]]) - 1;
      owner.push(owners ? owners[n] : -1);
      for (let gx = Math.floor(Math.min(l[k][0], l[k + 1][0]) / WCELL); gx <= Math.floor(Math.max(l[k][0], l[k + 1][0]) / WCELL); gx++)
        for (let gy = Math.floor(Math.min(l[k][1], l[k + 1][1]) / WCELL); gy <= Math.floor(Math.max(l[k][1], l[k + 1][1]) / WCELL); gy++) {
          const key = gx + ',' + gy;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key)!.push(i);
        }
    }
    return { segs, owner, grid };
  }
  /** (x, y) moved out to at least d metres from the walls of that level (two passes, for corners). */
  function clearOfWalls(x: number, y: number, level: number, d: number): XY {
    const W = wallIndex.get(Math.round(level));
    if (!W) return [x, y];
    const inside = roomAt(x, y, Math.round(level));
    if (inside >= 0) {
      // inside a shop: out through its nearest edge, d beyond it
      const r = solid!.rooms[inside].ring;
      let best = Infinity, bx = x, by = y;
      for (let k = 0; k < r.length; k++) {
        const a = r[k], c = r[(k + 1) % r.length], ex = c[0] - a[0], ey = c[1] - a[1];
        const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / Math.max(ex * ex + ey * ey, 1e-9)));
        const qx = a[0] + ex * t, qy = a[1] + ey * t, q = Math.hypot(qx - x, qy - y);
        if (q < best) { best = q; bx = qx; by = qy; }
      }
      const L = Math.max(best, 1e-4);
      x = bx + (bx - x) / L * d; y = by + (by - y) / L * d;
    }
    for (let pass = 0; pass < 2; pass++) {
      const gx = Math.floor(x / WCELL), gy = Math.floor(y / WCELL), seen = new Set<number>();
      let px = 0, py = 0, best = 0;
      for (let ix = gx - 1; ix <= gx + 1; ix++) for (let iy = gy - 1; iy <= gy + 1; iy++)
        for (const i of W.grid.get(ix + ',' + iy) || []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const [ax, ay, bx, by] = W.segs[i], dx = bx - ax, dy = by - ay, dl = Math.hypot(dx, dy);
          if (dl < 1e-6) continue;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dl * dl)));
          let qx = x - ax - dx * t, qy = y - ay - dy * t, q = Math.hypot(qx, qy);
          if (q < 1e-4) { qx = -dy / dl; qy = dx / dl; q = 0; } else { qx /= q; qy /= q; }   // on it: out along its normal
          // the strongest push wins (summing them overshoots at corners and on walls drawn in many short pieces)
          if (q < d && d - q > best) { best = d - q; px = qx * best; py = qy * best; }
        }
      if (!px && !py) break;
      x += px; y += py;
    }
    return [x, y];
  }
  function enclose(P: SolidPalette, wallLines: (k: StationSolidWall['kind']) => StationSolidWall[]) {
    wallIndex = new Map();
    const walls: THREE.BufferGeometry[] = [];
    for (const lv of levels) {
      if (!onLevel(lv.id)) continue;
      const lines: XY[][] = wallLines('wall').filter((w) => w.level === lv.id).map((w) => w.line);
      if (lv.id < 0) {
        // below ground: the walls the cadastral survey measured (solid.av, tools/station3d_av.py), and every other edge
        // of the floor, but where it meets the tracks (a platform edge)
        const measured = (av ? av.walls : []).filter((w) => w.level === lv.id && lineIn(w.line)).map((w) => w.line);
        lines.push(...measured);
        const mIdx = indexWalls(measured);
        const nearMeasured = (x: number, y: number) => {
          const gx = Math.floor(x / WCELL), gy = Math.floor(y / WCELL);
          for (let ix = gx - 1; ix <= gx + 1; ix++) for (let iy = gy - 1; iy <= gy + 1; iy++)
            for (const i of mIdx.grid.get(ix + ',' + iy) || []) { const [ax, ay, bx, by] = mIdx.segs[i]; if (segDist(x, y, [ax, ay], [bx, by]) < AV_BAND) return true; }
          return false;
        };
        const nearTrack = (x: number, y: number) => nearMeasured(x, y) || nearIdx(tracksOn(lv.id), x, y, 4.5);
        for (const s of solid!.slabs) {
          if (s.level !== lv.id || !lineIn(s.rings[0])) continue;
          // the outline in pieces of at most 2 m: a long edge may run along the tracks for part of its length only
          const r = s.rings[0], pts: XY[] = [];
          for (let k = 0; k < r.length; k++) {
            const p = r[k], q = r[(k + 1) % r.length], n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 2));
            for (let j = 0; j < n; j++) pts.push([p[0] + (q[0] - p[0]) * j / n, p[1] + (q[1] - p[1]) * j / n]);
          }
          let run: XY[] = [];
          for (let k = 0; k <= pts.length; k++) {
            const p = pts[k % pts.length], q = pts[(k + 1) % pts.length];
            if (k < pts.length && !nearTrack((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)) { if (!run.length) run.push(p); run.push(q); }
            else if (run.length) { lines.push(run); run = []; }
          }
        }
      } else lines.push(...wallLines('edge').filter((w) => w.level === lv.id).map((w) => w.line));
      const h = roomHeight(lv.id);
      const open = withDoors(lines, crossings(lv.id, h));
      // what the eye and the line keep off: the walls, and the survey's pillars on this floor
      const pillarRings = (av ? av.pillars : []).filter((p) => p.level === lv.id && lineIn(p.ring)).map((p) => p.ring);
      const shops = blocks.filter((i) => solid!.rooms[i].level === lv.id);
      const rings = shops.map((i) => { const r = solid!.rooms[i].ring; return r.concat([r[0]]); });
      wallIndex.set(lv.id, indexWalls(open.concat(pillarRings.map((r) => r.concat([r[0]])), rings), open.map(() => -1).concat(pillarRings.map(() => -1), shops)));
      if (open.length) walls.push(strip(open.map((line) => ({ line, z: lv.z })), h, 0, 1.2));
      if (lv.id < 0) ceiling(P, lv, h);
    }
    if (walls.length) {
      const m = new THREE.Mesh(merged(walls), new THREE.MeshLambertMaterial({ color: P.povWall, map: surfaces().wall, side: THREE.DoubleSide }));
      world!.add(m);
    }
    if (av) surveyed(P, av);
  }
  // ------------------------------------------------------------------ first person: shops and tracks
  /** Pins that have a shop front (they need no pin of their own). */
  let fronted = new Set<StationSolidPin>();
  /** Shops as fronts to the ceiling, in the colours of their kind: a room of OpenStreetMap all round its outline; a shop
   *  mapped only as a point (all of Zürich's ShopVille) as a front 4 m wide on the wall nearest it, if one is within 5 m. */
  function shopFronts(P: SolidPalette) {
    const S2 = surfaces(), byKind = new Map<ShopKind, THREE.BufferGeometry[]>(), caps: THREE.BufferGeometry[] = [];
    const put = (k: ShopKind, g: THREE.BufferGeometry) => { if (!byKind.has(k)) byKind.set(k, []); byKind.get(k)!.push(g); };
    for (const i of blocks) {
      const r = solid!.rooms[i], h = roomHeight(r.level);
      put(r.kind, strip([{ line: r.ring.concat([r.ring[0]]), z: r.z }], h - 0.02, 0.02, 2.0));
      const g = new THREE.ShapeGeometry(new THREE.Shape(r.ring.map(([x, y]) => new THREE.Vector2(x - cx, y - cy))));
      g.rotateX(-Math.PI / 2); g.translate(0, r.z * S + h, 0);
      caps.push(g);
    }
    fronted = new Set();
    const taken = new Map<string, [number, number][]>();
    for (const p of solid!.pins) {
      if (!keep(p.level, p.x, p.y) || roomAt(p.x, p.y, p.level) >= 0) continue;
      const W = wallIndex.get(p.level), lv = levels.find((l) => l.id === p.level);
      if (!W || !lv) continue;
      let best = 5, bi = -1;
      const gx = Math.floor(p.x / WCELL), gy = Math.floor(p.y / WCELL);
      for (let ix = gx - 1; ix <= gx + 1; ix++) for (let iy = gy - 1; iy <= gy + 1; iy++)
        for (const i of W.grid.get(ix + ',' + iy) || []) {
          if (W.owner[i] !== -1) continue;
          const [ax, ay, bx, by] = W.segs[i], d = segDist(p.x, p.y, [ax, ay], [bx, by]);
          if (d < best) { best = d; bi = i; }
        }
      if (bi < 0) continue;
      const [ax, ay, bx, by] = W.segs[bi], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
      if (L < 1.5) continue;
      const t = Math.max(0, Math.min(L, ((p.x - ax) * dx + (p.y - ay) * dy) / L));
      const t0 = Math.max(0, t - 2), t1 = Math.min(L, t + 2), k = `${ax},${ay},${bx},${by}`;
      if (t1 - t0 < 1.5) continue;
      const occ = taken.get(k) || [];
      if (occ.some(([u0, u1]) => Math.min(u1, t1) - Math.max(u0, t0) > 0.5)) continue;
      occ.push([t0, t1]); taken.set(k, occ);
      // on the pin's side of the wall, 4 cm off it
      const side = Math.sign(dx * (p.y - ay) - dy * (p.x - ax)) || 1, nx = -dy / L * side * 0.04, ny = dx / L * side * 0.04;
      const line: XY[] = [[ax + dx * t0 / L + nx, ay + dy * t0 / L + ny], [ax + dx * t1 / L + nx, ay + dy * t1 / L + ny]];
      put(p.kind, strip([{ line, z: lv.z }], roomHeight(lv.id) - 0.02, 0.02, 2.0));
      fronted.add(p);
    }
    for (const [k, gs] of byKind) {
      const m = new THREE.MeshLambertMaterial({ map: S2.shop[k].map, emissive: 0xffffff, emissiveMap: S2.shop[k].glow, emissiveIntensity: 0.9, side: THREE.DoubleSide });
      world!.add(new THREE.Mesh(merged(gs), m));
    }
    if (caps.length) world!.add(new THREE.Mesh(merged(caps), new THREE.MeshLambertMaterial({ color: P.povCeil })));
  }
  /** First person: tracks in a trough. Its concrete bed under every track, the rails, and below ground a ceiling over the
   *  tracks a little higher than the platforms' (a train fits under it), the drop between the two along the platform edge,
   *  and a wall along the outer side of the outer tracks: past a platform's edge there is a station, not the void. */
  const TRACK_CEIL = 4.1;
  let tunnelSides: { line: XY[]; z: number; h: number }[] = [];
  function povTracks(P: SolidPalette) {
    const S2 = surfaces();
    const beds: number[] = [], rails: number[] = [], tops: number[] = [], sides: { line: XY[]; z: number; h: number }[] = [];
    // flat bands along the tracks, straight into one array each (hundreds of track pieces: no geometry per piece); uvs in
    // world metres, so the overlapping beds of tracks side by side match
    const flat = (out: number[], ax: number, az: number, bx: number, bz: number, y: number, w: number) => {
      const L = Math.hypot(bx - ax, bz - az), sx = -(bz - az) / L * w / 2, sz = (bx - ax) / L * w / 2;
      out.push(ax + sx, y, az + sz, bx - sx, y, bz - sz, ax - sx, y, az - sz, ax + sx, y, az + sz, bx + sx, y, bz + sz, bx - sx, y, bz - sz);
    };
    const mesh = (pos: number[], uvWorld: boolean) => {
      const g = new THREE.BufferGeometry(), n = pos.length / 3;
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(Array.from({ length: n * 3 }, (_, i) => (i % 3 === 1 ? 1 : 0)), 3));
      if (uvWorld) g.setAttribute('uv', new THREE.Float32BufferAttribute(Array.from({ length: n * 2 }, (_, i) => pos[Math.floor(i / 2) * 3 + (i % 2 ? 2 : 0)]), 2));
      return g;
    };
    const ts = solid!.tracks.filter((t) => !(focus && (!onLevel(levelOfZ(t.z + (t.kind === 'tram' ? 0 : 1.1))) || !lineIn(t.line))));
    for (const t of ts) {
      const tram = t.kind === 'tram', lvId = levelOfZ(t.z + (tram ? 0 : 1.1)), under = lvId < 0 && !tram;
      const floorZ = t.z + (tram ? 0 : 1.1), lv = levels.find((l) => l.id === lvId);
      const ceil = (lv ? lv.z : floorZ) * S + Math.max(TRACK_CEIL, roomHeight(lvId) + 0.3);
      for (let i = 0; i + 1 < t.line.length; i++) {
        const p0 = V(t.line[i][0], t.line[i][1], t.z), p1 = V(t.line[i + 1][0], t.line[i + 1][1], t.z);
        if (p0.distanceTo(p1) < 0.05) continue;
        if (!tram) flat(beds, p0.x, p0.z, p1.x, p1.z, p0.y, under ? 9 : 3.2);
        const d = new THREE.Vector3().subVectors(p1, p0), side = new THREE.Vector3(-d.z, 0, d.x).normalize().multiplyScalar(tram ? 0.5 : 0.72);
        for (const sgn of [1, -1]) flat(rails, p0.x + side.x * sgn, p0.z + side.z * sgn, p1.x + side.x * sgn, p1.z + side.z * sgn, p0.y + (tram ? 0.03 : 0.17), 0.08);
        if (under) flat(tops, p0.x, p0.z, p1.x, p1.z, ceil, 9);
      }
      if (!under) continue;
      // the outer wall: where 4.6 m to the side there is neither a platform nor another track
      // (x, y) 4.6 m to the side: on a platform or by its edge, or another track runs there (tracks are 3.5–6 m apart)
      const open = (x: number, y: number) => onFloor(lvId, x, y) || nearIdx(edgesOn(lvId), x, y, 1.2) || nearIdx(tracksOn(lvId), x, y, 1.8);
      for (const sgn of [1, -1]) {
        let run: XY[] = [];
        const flush = () => { if (run.length > 1) sides.push({ line: run, z: t.z, h: ceil - t.z * S }); run = []; };
        for (let i = 0; i + 1 < t.line.length; i++) {
          const [ax, ay] = t.line[i], [bx, by] = t.line[i + 1], L = Math.hypot(bx - ax, by - ay);
          if (L < 0.05) continue;
          const nx = -(by - ay) / L * sgn, ny = (bx - ax) / L * sgn, n = Math.max(1, Math.ceil(L / 2));
          for (let j = 0; j < n; j++) {
            const f0 = j / n, f1 = (j + 1) / n, mx = ax + (bx - ax) * (f0 + f1) / 2, my = ay + (by - ay) * (f0 + f1) / 2;
            if (open(mx + nx * 4.6, my + ny * 4.6)) { flush(); continue; }
            const q0: XY = [ax + (bx - ax) * f0 + nx * 4.5, ay + (by - ay) * f0 + ny * 4.5], q1: XY = [ax + (bx - ax) * f1 + nx * 4.5, ay + (by - ay) * f1 + ny * 4.5];
            if (!run.length) run.push(q0);
            run.push(q1);
          }
        }
        flush();
      }
    }
    // the drop from the platforms' ceiling to the tracks' along each platform edge below ground
    const drops: THREE.BufferGeometry[] = [];
    for (const lv of levels) {
      if (lv.id >= 0 || !onLevel(lv.id)) continue;
      const tr = ts.filter((t) => t.kind !== 'tram' && levelOfZ(t.z + 1.1) === lv.id);
      if (!tr.length) continue;
      const h = roomHeight(lv.id), top = Math.max(TRACK_CEIL, h + 0.3);
      const runs = edgeRuns(lv.id, (x, y) => nearIdx(tracksOn(lv.id), x, y, 4.5));
      if (runs.length) drops.push(strip(runs.map((line) => ({ line, z: lv.z })), top - h, h, 1.2));
    }
    const concrete = () => new THREE.MeshLambertMaterial({ color: P.bed, map: S2.bed, side: THREE.DoubleSide });
    if (beds.length) world!.add(new THREE.Mesh(mesh(beds, true), concrete()));
    if (rails.length) world!.add(new THREE.Mesh(mesh(rails, false), new THREE.MeshLambertMaterial({ color: P.steel })));
    if (tops.length) world!.add(new THREE.Mesh(mesh(tops, true), ceilingMat(P)));
    tunnelSides = sides;
    const walls = sides.map((sd) => {
      const g = strip([{ line: sd.line, z: sd.z }], sd.h, 0, 1), uv = g.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * sd.h);   // v in metres, as u
      return g;
    });
    if (walls.length) world!.add(new THREE.Mesh(merged(walls), new THREE.MeshLambertMaterial({ color: P.povWall, map: S2.bed, side: THREE.DoubleSide })));
    // the white safety line along every platform edge, 1.2 m in from it
    const lines: THREE.BufferGeometry[] = [];
    for (const lv of levels) {
      if (!onLevel(lv.id)) continue;
      const tr = solid!.tracks.filter((t) => t.kind !== 'tram' && levelOfZ(t.z + 1.1) === lv.id);
      if (!tr.length) continue;
      for (const run of edgeRuns(lv.id, (x, y) => nearIdx(tracksOn(lv.id), x, y, 3.2))) {
        for (let k = 0; k + 1 < run.length; k++) {
          const [ax, ay] = run[k], [bx, by] = run[k + 1], L = Math.hypot(bx - ax, by - ay);
          if (L < 0.3) continue;
          let nx = -(by - ay) / L, ny = (bx - ax) / L;
          const mx = (ax + bx) / 2, my = (ay + by) / 2;
          if (!onFloor(lv.id, mx + nx * 1.2, my + ny * 1.2)) { nx = -nx; ny = -ny; }
          if (!onFloor(lv.id, mx + nx * 1.2, my + ny * 1.2)) continue;
          lines.push(band(V(ax + nx * 1.2, ay + ny * 1.2, lv.z), V(bx + nx * 1.2, by + ny * 1.2, lv.z), 0.1, 0.012));
        }
      }
    }
    if (lines.length) world!.add(new THREE.Mesh(merged(lines), new THREE.MeshBasicMaterial({ color: 0xf4f4f0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })));
    if (drops.length) world!.add(new THREE.Mesh(merged(drops), new THREE.MeshLambertMaterial({ color: P.povWall, side: THREE.DoubleSide })));
  }
  // Per build and level: the tracks (by the level of their platforms) and the floors' outlines in a grid, the floors' boxes.
  let idxCache = new Map<string, WallIdx>(), boxCache = new Map<number, { ring: XY[]; box: [number, number, number, number] }[]>();
  function tracksOn(level: number) {
    const k = 't' + level;
    if (!idxCache.has(k)) idxCache.set(k, indexWalls(solid!.tracks.filter((t) => levelOfZ(t.z + (t.kind === 'tram' ? 0 : 1.1)) === level).map((t) => t.line)));
    return idxCache.get(k)!;
  }
  function edgesOn(level: number) {
    const k = 'e' + level;
    if (!idxCache.has(k)) idxCache.set(k, indexWalls(solid!.slabs.filter((s) => s.level === level).map((s) => s.rings[0].concat([s.rings[0][0]]))));
    return idxCache.get(k)!;
  }
  /** Is (x, y) inside a floor of that level (its outline; wells count as floor)? */
  function onFloor(level: number, x: number, y: number) {
    if (!boxCache.has(level)) boxCache.set(level, solid!.slabs.filter((s) => s.level === level).map((s) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [px, py] of s.rings[0]) { x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py); }
      return { ring: s.rings[0], box: [x0, y0, x1, y1] as [number, number, number, number] };
    }));
    return boxCache.get(level)!.some((s) => x >= s.box[0] && x <= s.box[2] && y >= s.box[1] && y <= s.box[3] && inRing(s.ring, x, y));
  }
  /** Is a piece of the index within r of (x, y)? */
  function nearIdx(W: WallIdx, x: number, y: number, r: number) {
    for (let gx = Math.floor((x - r) / WCELL); gx <= Math.floor((x + r) / WCELL); gx++)
      for (let gy = Math.floor((y - r) / WCELL); gy <= Math.floor((y + r) / WCELL); gy++)
        for (const i of W.grid.get(gx + ',' + gy) || []) {
          const [ax, ay, bx, by] = W.segs[i], dx = bx - ax, dy = by - ay;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / Math.max(dx * dx + dy * dy, 1e-9)));
          const ex = x - ax - dx * t, ey = y - ay - dy * t;
          if (ex * ex + ey * ey < r * r) return true;
        }
    return false;
  }
  /** The pieces (at most 2 m) of a level's floor outlines where `near` holds at their middle, joined into runs. */
  function edgeRuns(level: number, near: (x: number, y: number) => boolean): XY[][] {
    const out: XY[][] = [];
    for (const s of solid!.slabs) {
      if (s.level !== level || !lineIn(s.rings[0])) continue;
      const r = s.rings[0], pts: XY[] = [];
      for (let k = 0; k < r.length; k++) {
        const p = r[k], q = r[(k + 1) % r.length], n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 2));
        for (let j = 0; j < n; j++) pts.push([p[0] + (q[0] - p[0]) * j / n, p[1] + (q[1] - p[1]) * j / n]);
      }
      let run: XY[] = [];
      for (let k = 0; k <= pts.length; k++) {
        const p = pts[k % pts.length], q = pts[(k + 1) % pts.length];
        if (k < pts.length && near((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)) { if (!run.length) run.push(p); run.push(q); }
        else if (run.length) { out.push(run); run = []; }
      }
    }
    return out;
  }
  /** The cadastral survey's pieces in first person: the floor up to a measured wall, pillars, platform canopies. */
  const AV_BAND = 1.8;   // m: a schematic edge this near a measured wall gives way to it
  function surveyed(P: SolidPalette, a: StationSolidAv) {
    const prism = (ring: XY[], y0: number, depth: number) => {
      const g = new THREE.ExtrudeGeometry(new THREE.Shape(ring.map(([x, y]) => new THREE.Vector2(x - cx, y - cy))), { depth, bevelEnabled: false, curveSegments: 1 });
      g.rotateX(-Math.PI / 2); g.translate(0, y0, 0);
      return g;
    };
    const fills = new Map<number, THREE.BufferGeometry[]>();
    for (const f of a.fills) {
      if (!onLevel(f.level) || !lineIn(f.ring)) continue;
      const lv = levels.find((l) => l.id === f.level);
      if (!lv) continue;
      if (!fills.has(f.level)) fills.set(f.level, []);
      fills.get(f.level)!.push(prism(f.ring, lv.z * S - SLAB_T, SLAB_T));
    }
    for (const [lv, gs] of fills) world!.add(new THREE.Mesh(merged(gs), new THREE.MeshLambertMaterial({ color: levelColour(lv, P) })));
    // a pillar to the ceiling below ground, else up to the canopy over it (or 4.6 m)
    const pil: THREE.BufferGeometry[] = [];
    for (const p of a.pillars) {
      if (!onLevel(p.level) || !lineIn(p.ring)) continue;
      const lv = levels.find((l) => l.id === p.level);
      if (!lv) continue;
      const h = p.level < 0 ? roomHeight(p.level) : ((p.top != null ? p.top : lv.z + 4.6) - lv.z) * S;
      pil.push(prism(p.ring, lv.z * S, h));
    }
    if (pil.length) {
      const m = new THREE.Mesh(merged(pil), new THREE.MeshLambertMaterial({ color: P.povWall }));
      world!.add(m);
    }
    const can: THREE.BufferGeometry[] = [];
    for (const k of a.canopies) {
      if (!onLevel(k.level) || !lineIn(k.ring)) continue;
      can.push(prism(k.ring, k.top * S, 0.3));
    }
    if (can.length) world!.add(new THREE.Mesh(merged(can), new THREE.MeshLambertMaterial({ color: P.povCeil })));
  }
  const inRing = (r: XY[], x: number, y: number) => {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; }
    return c;
  };
  const segDist = (x: number, y: number, a: XY, b: XY) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / Math.max(dx * dx + dy * dy, 1e-9)));
    return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t);
  };
  // Openings for what passes through a floor or a ceiling: every stair, escalator and ramp (and lift, for a ceiling) that
  // crosses the band of heights round it, as capsules the shader cuts out (no fragment loop where the box has none).
  const HOLES = 64;
  interface Holes { holes: THREE.Vector4[]; r2: number[]; n: number; box: THREE.Vector4 }
  /** z0 → z1: the band (metres); trimTop: the capsule ends its radius before the upper end of the piece, so the opening
   *  stops at the step you get off on (for a floor you walk on). */
  function connectorHoles(z0: number, z1: number, lifts: boolean, trimTop: boolean): Holes {
    const holes: THREE.Vector4[] = [], radii: number[] = [];
    for (const c of solid!.connectors) {
      if (c.kind === 'elevator') {
        if (lifts && Math.min(...c.zs) < z1 && Math.max(...c.zs) > z0 && inBox(c.xy[0], c.xy[1])) { holes.push(new THREE.Vector4(c.xy[0] - cx, -(c.xy[1] - cy), c.xy[0] - cx, -(c.xy[1] - cy))); radii.push(1.6); }
        continue;
      }
      if (!c.pts.some(([x, y]) => inBox(x, y))) continue;
      const r = (c.width || 1.5) / 2 + (trimTop ? 0.35 : 0.6);
      for (let k = 0; k + 1 < c.pts.length; k++) {
        let [x0, y0, za] = c.pts[k], [x1, y1, zb] = c.pts[k + 1];
        if (Math.max(za, zb) < z0 || Math.min(za, zb) > z1 || Math.abs(zb - za) < 0.05) continue;
        if (za > zb) { [x0, y0, za, x1, y1, zb] = [x1, y1, zb, x0, y0, za]; }   // from low to high
        const t0 = Math.max(0, (z0 - za) / (zb - za)), t1 = Math.min(1, (z1 - za) / (zb - za));
        let ax = x0 + (x1 - x0) * t0, ay = y0 + (y1 - y0) * t0, bx = x0 + (x1 - x0) * t1, by = y0 + (y1 - y0) * t1;
        if (trimTop && zb <= z1 + 0.3) {
          const L = Math.hypot(bx - ax, by - ay);
          if (L <= r) continue;
          bx -= (bx - ax) / L * r; by -= (by - ay) / L * r;
        }
        holes.push(new THREE.Vector4(ax - cx, -(ay - cy), bx - cx, -(by - cy)));
        radii.push(r);
      }
    }
    // the ones nearest the way, if there are more than the shader takes
    if (holes.length > HOLES && route) {
      const order = holes.map((v, i) => [i, nearRoute(v.x + cx, -v.y + cy)] as const).sort((p1, p2) => p1[1] - p2[1]).slice(0, HOLES).map((x) => x[0]);
      const h2 = order.map((i) => holes[i]), r2 = order.map((i) => radii[i]);
      holes.length = 0; radii.length = 0; holes.push(...h2); radii.push(...r2);
    }
    const n = Math.min(HOLES, holes.length), box = new THREE.Vector4(Infinity, Infinity, -Infinity, -Infinity);
    for (let i = 0; i < n; i++) {
      const v = holes[i], rr = radii[i];
      box.set(Math.min(box.x, v.x - rr, v.z - rr), Math.min(box.y, v.y - rr, v.w - rr), Math.max(box.z, v.x + rr, v.z + rr), Math.max(box.w, v.y + rr, v.w + rr));
    }
    const r2 = radii.slice(0, n).map((x) => x * x);
    while (holes.length < HOLES) holes.push(new THREE.Vector4());
    while (r2.length < HOLES) r2.push(0);
    return { holes: holes.slice(0, HOLES), r2, n, box };
  }
  /** The material with those openings cut out. */
  function holed<M extends THREE.Material>(mat: M, h: Holes, key: string): M {
    if (!h.n) return mat;
    mat.customProgramCacheKey = () => 'sx-holes';
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, { uHole: { value: h.holes }, uHoleR2: { value: h.r2 }, uHoleN: { value: h.n }, uHoleBox: { value: h.box } });
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
          varying vec3 vWP; uniform vec4 uHole[${HOLES}]; uniform float uHoleR2[${HOLES}]; uniform int uHoleN; uniform vec4 uHoleBox;`)
        .replace('void main() {', `void main() {
          vec2 p = vWP.xz;
          if (p.x > uHoleBox.x && p.y > uHoleBox.y && p.x < uHoleBox.z && p.y < uHoleBox.w) {
            for (int i = 0; i < ${HOLES}; i++) {
              if (i >= uHoleN) break;
              vec2 a = uHole[i].xy, ab = uHole[i].zw - uHole[i].xy;
              vec2 d = p - a - ab * clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
              if (dot(d, d) < uHoleR2[i]) discard;
            }
          }`);
    };
    return mat;
  }
  // A ceiling over a floor below ground, at the room's height: the floor's outline (less the wells of the floor above),
  // open (in the shader) over every stair, escalator, ramp and lift that passes through it, with its lights.
  function ceilingMat(P: SolidPalette) {
    const S2 = surfaces();
    return new THREE.MeshLambertMaterial({ color: P.povCeil, map: S2.ceil, emissive: 0xfff3dc, emissiveMap: S2.ceilGlow, emissiveIntensity: 1.1, side: THREE.BackSide });
  }
  function ceiling(P: SolidPalette, lv: StationLevel, h: number) {
    const gs: THREE.BufferGeometry[] = [];
    const above = levelOver(lv.id);
    const wells = above ? solid!.slabs.filter((s) => s.level === above.id).flatMap((s) => s.rings.slice(1)) : [];
    const flat = (ring: XY[]) => {
      const sh = new THREE.Shape(ring.map(([x, y]) => new THREE.Vector2(x - cx, y - cy)));
      // a well of the floor above that lies wholly inside: open here too
      for (const w of wells) if (w.every(([x, y]) => inRing(ring, x, y))) sh.holes.push(new THREE.Path(w.map(([x, y]) => new THREE.Vector2(x - cx, y - cy))));
      const g = new THREE.ShapeGeometry(sh);
      g.rotateX(-Math.PI / 2);
      g.translate(0, lv.z * S + h, 0);
      gs.push(g);
    };
    for (const s of solid!.slabs) if (s.level === lv.id && lineIn(s.rings[0])) flat(s.rings[0]);
    for (const f of av ? av.fills : []) if (f.level === lv.id && lineIn(f.ring)) flat(f.ring);
    if (!gs.length) return;
    const zc = lv.z + h / S;
    // seen from below only: from the floor above it is not there (it would look like a floor of its own)
    world!.add(new THREE.Mesh(merged(gs), holed(ceilingMat(P), connectorHoles(zc - 2.4, zc + 0.6, true, false), 'c' + lv.id)));
  }
  function freeGroup(g: THREE.Object3D) {
    const mats = new Set<THREE.Material>();
    g.traverse((o: SolidDrawn) => { if (o instanceof THREE.InstancedMesh) o.dispose(); if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m)); });
    mats.forEach((m) => m.dispose());
  }
  // merge and free the pieces
  const merged = (gs: THREE.BufferGeometry[]) => { const g = mergeGeometries(gs, false); gs.forEach((x) => x.dispose()); return g; };

  /** Is (x, y) on a floor at height z (metres), give or take a metre? (Ring tests against the slabs of that level.) */
  function onSlab(x: number, y: number, z: number) {
    const lv = levels.find((l) => Math.abs(l.z - z) < 0.3);
    if (!lv) return true;   // between floors: not an end that should land on one
    const inRing = (r: XY[]) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
    const nearRing = (r: XY[]) => r.some((p, i) => { const q = r[(i + 1) % r.length], dx = q[0] - p[0], dy = q[1] - p[1]; const t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / Math.max(dx * dx + dy * dy, 1e-6))); return Math.hypot(x - p[0] - dx * t, y - p[1] - dy * t) < 1.0; });
    return solid!.slabs.some((sl) => sl.level === lv.id && (nearRing(sl.rings[0]) || (inRing(sl.rings[0]) && !sl.rings.slice(1).some((h) => inRing(h) && !nearRing(h)))))
      // the end of a well cut into a floor counts as on it
      || solid!.slabs.some((sl) => sl.level === lv.id && sl.rings.slice(1).some(nearRing));
  }
  /** Lifts the way rides: their position, and the heights (z, metres) where it gets on and off. */
  function routeLifts(): { xy: XY; zs: number[] }[] {
    if (!route) return [];
    return route.steps.filter((s) => s.kind === 'elevator').map((s) => {
      const a = route!.points[s.from], b = route!.points[s.to];
      return { xy: [a[0], a[1]] as XY, zs: [zOf(a[2]), zOf(b[2])] };
    });
  }
  function buildConnectors(P: SolidPalette) {
    const esc: Record<'up' | 'down' | 'both', THREE.BufferGeometry[]> = { up: [], down: [], both: [] }, glass: THREE.BufferGeometry[] = [], slopes: THREE.BufferGeometry[] = [], ramps: THREE.BufferGeometry[] = [], shaftEdges: THREE.BufferGeometry[] = [], rings: THREE.BufferGeometry[] = [], ringsOn: THREE.BufferGeometry[] = [];
    const glassOn: THREE.BufferGeometry[] = [], edgesOn: THREE.BufferGeometry[] = [], pads: THREE.BufferGeometry[] = [], shafts: THREE.BufferGeometry[] = [];
    // stairs and escalator bodies as closed solids, vertex coloured: treads light, risers and sides darker
    const tCol = new THREE.Color(P.step), rCol = new THREE.Color(P.riser), sCol = new THREE.Color(P.riser).lerp(new THREE.Color(P.step), 0.35);
    const uCol = new THREE.Color(P.riser).multiplyScalar(0.7), trussCol = new THREE.Color(P.truss);
    const solidPos: number[] = [], solidCol: number[] = [];
    const rails: THREE.Vector3[] = [];   // handrails, as line segments
    const bars: THREE.BufferGeometry[] = [];   // first person: handrails as bars
    const quad = (a: THREE.Vector3, b2: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, colr: THREE.Color) => {
      for (const v of [a, b2, c, a, c, d]) { solidPos.push(v.x, v.y, v.z); solidCol.push(colr.r, colr.g, colr.b); }
    };
    const lifts = routeLifts();
    for (const c of solid!.connectors) {
      if (focus) {
        // a lift, stair or escalator in the box that reaches one of the route's floors
        const pts: [number, number, number][] = c.kind === 'elevator' ? c.zs.map((z) => [c.xy[0], c.xy[1], z] as [number, number, number]) : c.pts;
        if (!pts.some(([x, y]) => inBox(x, y)) || !pts.some(([, , z]) => onLevel(levelOfZ(z)))) continue;
      }
      if (c.kind === 'elevator') {
        // the shaft only between the floors shown (a lift serving seven floors would otherwise tower over the way)
        const zs = focus ? c.zs.filter((z) => onLevel(levelOfZ(z))) : c.zs;
        if (!zs.length) continue;
        const lo = Math.min(...zs), hi = Math.max(...zs);
        const [x, y] = c.xy;
        const H = (hi - lo) * S + 2.6;
        const box = new THREE.BoxGeometry(2.0, H, 2.0).translate(x - cx, lo * S + H / 2, -(y - cy));
        // the lift the way rides is not cut away with the floors round it (the cut opens its shaft): it stays in view
        const mine = lifts.find((l) => Math.hypot(l.xy[0] - x, l.xy[1] - y) < 4);
        (mine ? glassOn : shafts).push(box);
        (mine ? edgesOn : shaftEdges).push(new THREE.EdgesGeometry(box));
        // the floors it stops at: a quiet ring; where the way gets on and off, a ring in the way's colour
        for (const z of zs) {
          const on = !!mine && mine.zs.some((q) => Math.abs(q - z) < 0.3);
          (on ? ringsOn : rings).push(new THREE.RingGeometry(1.25, on ? 1.75 : 1.5, 24).rotateX(-Math.PI / 2).translate(x - cx, z * S + 0.06, -(y - cy)));
        }
        continue;
      }
      const all = c.pts.map(([x, y, z]) => V(x, y, z));
      const totalRise = Math.abs(all[all.length - 1].y - all[0].y) || 1;
      // an end that reaches no floor (a street bridge or a pavement the model has no area for): a landing to step
      // onto, so the stair does not end in the air
      for (const [k, k2] of [[0, 1], [c.pts.length - 1, c.pts.length - 2]]) {
        const [x, y, z] = c.pts[k];
        if (k2 < 0 || k2 >= c.pts.length || onSlab(x, y, z)) continue;
        const out = new THREE.Vector3().subVectors(all[k], all[k2]).setY(0);
        if (out.lengthSq() < 1e-4) continue;
        out.normalize();
        const w = Math.min(c.width || 1.5, 2.4) + 0.4, centre = all[k].clone().addScaledVector(out, 1.0);
        const g = new THREE.BoxGeometry(2.0, SLAB_T, w);
        g.rotateY(Math.atan2(-out.z, out.x));
        g.translate(centre.x, all[k].y - SLAB_T / 2 - 0.02, centre.z);
        pads.push(g);
      }
      for (let si = 0; si + 1 < all.length; si++) {
      const p0 = all[si], p1 = all[si + 1];
      if (p0.distanceTo(p1) < 0.05) continue;
      if (Math.abs(p1.y - p0.y) < 0.05 && c.kind !== 'ramp') { ramps.push(band(p0, p1, Math.min(c.width || 2, 2.4), 0.03)); continue; } // a landing
      if (c.kind === 'escalator') {
        // chevrons point the way it runs: 'up' = towards the higher end
        const upEnd = p1.y >= p0.y ? [p0, p1] : [p1, p0];
        const [from, to] = c.dir === 'down' ? [upEnd[1], upEnd[0]] : upEnd;
        const w = Math.min(Math.max(c.width || 1, 1), 1.2);
        (c.dir === 'up' ? esc.up : c.dir === 'down' ? esc.down : esc.both).push(band(from, to, w, 0.12, 1.4));
        // the truss under the steps (a closed body, so it reads as a machine and not as a painted strip), glass
        // balustrades on it and a handrail along their top
        const d = new THREE.Vector3().subVectors(to, from), side = new THREE.Vector3(-d.z, 0, d.x).normalize();
        const half = side.clone().multiplyScalar(w / 2 + 0.12), DEPTH = 1.1;
        const top = (p: THREE.Vector3, sgn: number, up: number) => p.clone().addScaledVector(half, sgn).setY(p.y + up);
        for (const sgn of [1, -1]) {
          quad(top(from, sgn, -DEPTH), top(to, sgn, -DEPTH), top(to, sgn, 0.14), top(from, sgn, 0.14), trussCol);
          const a = top(from, sgn, 0.14), e = top(to, sgn, 0.14);
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute([a.x, a.y, a.z, e.x, e.y, e.z, e.x, e.y + 0.95, e.z, a.x, a.y, a.z, e.x, e.y + 0.95, e.z, a.x, a.y + 0.95, a.z], 3));
          g.computeVertexNormals();
          glass.push(g);
          if (pov) bars.push(bar(a.clone().setY(a.y + 0.97), e.clone().setY(e.y + 0.97), 0.09));
          else rails.push(a.clone().setY(a.y + 0.95), e.clone().setY(e.y + 0.95));
        }
        quad(top(from, 1, -DEPTH), top(from, -1, -DEPTH), top(to, -1, -DEPTH), top(to, 1, -DEPTH), uCol);   // underside
        for (const p of [from, to]) quad(top(p, 1, -DEPTH), top(p, -1, -DEPTH), top(p, -1, 0.12), top(p, 1, 0.12), trussCol);   // ends
      } else if (c.kind === 'stairs' && !c.steep && c.steps) {
        stairFlight(p0, p1, c.steps * Math.abs(p1.y - p0.y) / totalRise, Math.min(c.width || 1.5, 2.4));
      } else if (c.kind === 'stairs') {
        slopes.push(band(p0, p1, Math.min(c.width || 2, 2.4), 0.05, 0.6));
      } else {
        ramps.push(band(p0, p1, Math.min(c.width || 2, 3), 0.05));
      }
      }
    }
    // A flight of stairs as one closed solid: its steps (risers and treads), the two strings along its sides down to a
    // sloping underside, and the handrails. As many steps as it has (from OpenStreetMap, or its rise), but never
    // treads under 28 cm in plan: finer than that they alias into noise when seen from afar.
    function stairFlight(p0: THREE.Vector3, p1: THREE.Vector3, steps: number, w: number) {
      const [lo, hi] = p1.y >= p0.y ? [p0, p1] : [p1, p0];
      const d = new THREE.Vector3().subVectors(hi, lo), run = new THREE.Vector3(d.x, 0, d.z), runLen = run.length();
      if (runLen < 0.2 || d.y < 0.05) return;
      const n = Math.max(2, Math.min(Math.round(steps), 24, Math.floor(runLen / 0.28)));
      const side = new THREE.Vector3(-d.z, 0, d.x).normalize().multiplyScalar(w / 2);
      const T = Math.min(0.45 * S, d.y * 0.5);   // how deep the strings go under the nosing line
      const at = (f: number, y: number, sgn: number) => lo.clone().addScaledVector(run, f).addScaledVector(side, sgn).setY(y);
      const under = (f: number) => Math.max(lo.y, lo.y + d.y * f - T);
      for (let k = 0; k < n; k++) {
        // the top tread a little under the floor it reaches (no flicker where they meet)
        const f0 = k / n, f1 = (k + 1) / n, yb = lo.y + d.y * k / n, yt = lo.y + d.y * (k + 1) / n - (k === n - 1 ? 0.02 : 0);
        quad(at(f0, yb, 1), at(f0, yb, -1), at(f0, yt, -1), at(f0, yt, 1), rCol);   // riser
        quad(at(f0, yt, 1), at(f0, yt, -1), at(f1, yt, -1), at(f1, yt, 1), tCol);   // tread
      }
      // the strings: from the floor and the sloping underside up to a straight line 12 cm over the nosings (a sawtooth of
      // the steps' sides would alias from afar)
      const fc = Math.min(1, T / Math.max(d.y, 1e-3));
      const top = (f: number) => Math.min(hi.y, lo.y + d.y * (f + 1 / n)) + 0.12;
      const sw = w / 2 + 0.06;
      const atS = (f: number, y: number, sgn: number) => lo.clone().addScaledVector(run, f).addScaledVector(side, sgn * sw / (w / 2)).setY(y);
      for (const sgn of [1, -1]) {
        quad(atS(0, lo.y, sgn), atS(fc, lo.y, sgn), atS(fc, top(fc), sgn), atS(0, top(0), sgn), sCol);
        quad(atS(fc, lo.y, sgn), atS(1, under(1), sgn), atS(1, top(1), sgn), atS(fc, top(fc), sgn), sCol);
        // its top edge, 12 cm wide (the string has a thickness)
        quad(atS(0, top(0), sgn), atS(1, top(1), sgn), at(1, top(1), sgn).addScaledVector(side, -sgn * 0.12 / (w / 2)).setY(top(1)), at(0, top(0), sgn).addScaledVector(side, -sgn * 0.12 / (w / 2)).setY(top(0)), tCol);
      }
      // the sloping underside, from where it leaves the floor below to under the top step, and the end under the top
      if (fc < 1) quad(at(fc, lo.y, 1), at(1, under(1), 1), at(1, under(1), -1), at(fc, lo.y, -1), uCol);
      quad(at(1, under(1), 1), at(1, under(1), -1), at(1, hi.y, -1), at(1, hi.y, 1), sCol);
      if (pov) {
        // a balustrade from the string to the handrail, and the handrail on it, 0.9 m over the nosings
        for (const sgn of [1, -1]) {
          const r0 = atS(0, top(0), sgn), r1 = atS(1, top(1), sgn);
          const h0 = lo.y + d.y / n + 0.9, h1 = hi.y + 0.9;
          quad(r0, r1, r1.clone().setY(h1 - 0.04), r0.clone().setY(h0 - 0.04), sCol);
          bars.push(bar(r0.clone().setY(h0), r1.clone().setY(h1), 0.06));
        }
      } else for (const sgn of [1, -1]) rails.push(at(0, lo.y + 0.9, sgn * 0.96), at(1, hi.y + 0.9, sgn * 0.96));
    }
    /** A bar of square section s from a to b (a handrail). */
    function bar(a: THREE.Vector3, b2: THREE.Vector3, s: number) {
      const L = a.distanceTo(b2), g = new THREE.BoxGeometry(s, s, L);
      g.lookAt(new THREE.Vector3().subVectors(b2, a));
      g.translate((a.x + b2.x) / 2, (a.y + b2.y) / 2, (a.z + b2.z) / 2);
      g.deleteAttribute('uv');
      return g;
    }
    const escMat = (colr: number) => cutaway(new THREE.MeshLambertMaterial({ color: colr, map: textures.chevron, side: THREE.DoubleSide }));
    if (esc.up.length) world!.add(new THREE.Mesh(merged(esc.up), escMat(ESC_UP)));
    if (esc.down.length) world!.add(new THREE.Mesh(merged(esc.down), escMat(ESC_DOWN)));
    if (esc.both.length) world!.add(new THREE.Mesh(merged(esc.both), cutaway(new THREE.MeshLambertMaterial({ color: ESC_BOTH, side: THREE.DoubleSide }))));
    if (solidPos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(solidPos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(solidCol, 3));
      g.computeVertexNormals();
      world!.add(new THREE.Mesh(g, cutaway(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }))));
    }
    if (rails.length) world!.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(rails), cutaway(new THREE.LineBasicMaterial({ color: P.handrail }))));
    if (bars.length) world!.add(new THREE.Mesh(merged(bars), new THREE.MeshLambertMaterial({ color: P.handrail })));
    // flat things lying on a floor: drawn in front of it (no flicker where they touch it)
    const decal = <M extends THREE.Material>(m: M) => { m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2; return m; };
    if (slopes.length) world!.add(new THREE.Mesh(merged(slopes), cutaway(new THREE.MeshLambertMaterial({ color: P.step, map: textures.stripe, side: THREE.DoubleSide }))));
    if (ramps.length) world!.add(new THREE.Mesh(merged(ramps), cutaway(decal(new THREE.MeshLambertMaterial({ color: P.step, side: THREE.DoubleSide })))));
    if (glass.length) {
      const g = merged(glass.map((x) => { const y = x.index ? x.toNonIndexed() : x; if (y !== x) x.dispose(); y.deleteAttribute('uv'); return y; }));
      world!.add(new THREE.Mesh(g, cutaway(new THREE.MeshLambertMaterial({ color: P.glass, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }))));
    }
    if (shafts.length) {
      const g = merged(shafts.map((x) => { const y = x.toNonIndexed(); x.dispose(); y.deleteAttribute('uv'); return y; }));
      world!.add(new THREE.Mesh(g, cutaway(new THREE.MeshLambertMaterial({ color: P.glass, transparent: true, opacity: 0.2, depthWrite: false, side: pov ? THREE.FrontSide : THREE.DoubleSide }))));
    }
    if (shaftEdges.length) world!.add(new THREE.LineSegments(merged(shaftEdges), cutaway(new THREE.LineBasicMaterial({ color: P.glassEdge, transparent: true, opacity: 0.7 }))));
    if (rings.length) world!.add(new THREE.Mesh(merged(rings), cutaway(decal(new THREE.MeshBasicMaterial({ color: P.glassEdge, side: THREE.DoubleSide })))));
    if (ringsOn.length) world!.add(new THREE.Mesh(merged(ringsOn), decal(new THREE.MeshBasicMaterial({ color: ROUTE, side: THREE.DoubleSide }))));   // as its shaft: not cut
    if (pads.length) {
      const g = merged(pads.map((x) => { const y = x.toNonIndexed(); x.dispose(); y.deleteAttribute('uv'); return y; }));
      world!.add(new THREE.Mesh(g, cutaway(new THREE.MeshLambertMaterial({ color: P.step }))));
      world!.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 40), shared.outline!));
    }
    if (glassOn.length) {
      const m = new THREE.Mesh(merged(glassOn), new THREE.MeshLambertMaterial({ color: P.glass, transparent: true, opacity: 0.3, depthWrite: false, side: pov ? THREE.FrontSide : THREE.DoubleSide }));
      m.renderOrder = 2;
      world!.add(m, new THREE.LineSegments(merged(edgesOn), new THREE.LineBasicMaterial({ color: P.handrail, transparent: true, opacity: 0.85 })));
    }
  }

  // ------------------------------------------------------------------ the route
  let route: StationRouteResult | null = null, routeGroup: THREE.Group | null = null, stepIdx = -1;
  function plan(from: SolidEnd, to: SolidEnd, p?: StationRoutePrefs | null, first?: boolean) {
    route = from && to ? SR.route(model!, from, to, Object.assign({}, p || {})) : null;
    stepIdx = -1; here = null; playT = 0; snapPrev = null;   // nothing of the old way's steps or progress is kept
    routeN++;
    const had = focus;
    setFocus();
    if (routeGroup) { scene.remove(routeGroup); freeGroup(routeGroup); routeGroup = null; }
    if (!first && (had || focus || route || stale)) build();   // another part of the station, or another lift to ride (draws the way)
    else if (route) drawRoute();
    syncAmbient();
    labelsDirty = true;
    return route;
  }
  function routePoints() { return route!.points.map(([x, y, l]) => V(x, y, zOf(l)).setY(zOf(l) * S + ROUTE_Y)); }
  // ------------------------------------------------------------------ the walk, smoothed
  // OpenStreetMap's paths turn in sharp corners and zig-zag where a path is drawn in short pieces; the eye, the walker
  // and the line on the floor follow one smoothed copy of the way instead: samples every 0.5 m, on walks averaged over
  // ±2.5 m (never across a stair, an escalator, a lift or another floor, so they keep their own line), then kept off
  // walls, pillars and shops (in first person). `along` stays the way's metres (route.dists): the steps and the sign
  // keep their distances.
  interface SmoothWay { along: number[]; x: number[]; y: number[]; l: number[]; walk: boolean[] }
  let smooth: SmoothWay | null = null;
  const SMOOTH_M = 0.5, SMOOTH_W = 2.5;
  function buildSmooth() {
    smooth = null;
    if (!route || route.same) return;
    const r = route, sw: SmoothWay = { along: [], x: [], y: [], l: [], walk: [] };
    for (const s of r.steps) {
      const walk = s.kind === 'walk' || s.kind === 'arrive';
      for (let k = s.from; k < s.to; k++) {
        const [x0, y0, l0] = r.points[k], [x1, y1, l1] = r.points[k + 1], a0 = r.dists[k], a1 = r.dists[k + 1];
        if (a1 - a0 < 1e-3) continue;   // a lift: no metres
        const n = Math.max(1, Math.ceil((a1 - a0) / SMOOTH_M));
        for (let j = sw.along.length && Math.abs(sw.along[sw.along.length - 1] - a0) < 1e-6 && sw.l[sw.l.length - 1] === l0 ? 1 : 0; j <= n; j++) {
          const f = j / n;
          sw.along.push(a0 + (a1 - a0) * f); sw.x.push(x0 + (x1 - x0) * f); sw.y.push(y0 + (y1 - y0) * f); sw.l.push(l0 + (l1 - l0) * f); sw.walk.push(walk);
        }
      }
    }
    const N = sw.along.length;
    if (N < 2) return;
    const ok = (i: number, j: number) => sw.walk[j] && Math.round(sw.l[j]) === Math.round(sw.l[i]);
    const x = sw.x.slice(), y = sw.y.slice();
    for (let i = 0; i < N; i++) {
      if (!sw.walk[i]) continue;
      // as far either way as both sides allow (the ends of a walk stay where they are)
      let w = SMOOTH_W;
      for (let j = i - 1; j >= 0 && sw.along[i] - sw.along[j] <= w; j--) if (!ok(i, j)) { w = Math.min(w, sw.along[i] - sw.along[j + 1]); break; }
      for (let j = i + 1; j < N && sw.along[j] - sw.along[i] <= w; j++) if (!ok(i, j)) { w = Math.min(w, sw.along[j - 1] - sw.along[i]); break; }
      if (i === 0 || i === N - 1) w = 0;
      let sx = 0, sy = 0, n = 0;
      for (let j = i; j >= 0 && sw.along[i] - sw.along[j] <= w + 1e-6; j--) { sx += sw.x[j]; sy += sw.y[j]; n++; }
      for (let j = i + 1; j < N && sw.along[j] - sw.along[i] <= w + 1e-6; j++) { sx += sw.x[j]; sy += sw.y[j]; n++; }
      x[i] = sx / n; y[i] = sy / n;
    }
    for (let i = 0; i < N; i++) if (sw.walk[i]) [x[i], y[i]] = clearOfWalls(x[i], y[i], sw.l[i], CLEAR_M);
    sw.x = x; sw.y = y;
    smooth = sw;
  }
  /** The smoothed way at `along` metres: [x, y, level]; null without one. */
  function smoothAt(along: number): XYL | null {
    const s = smooth;
    if (!s) return null;
    let lo = 0, hi = s.along.length - 1;
    if (along <= s.along[0]) return [s.x[0], s.y[0], s.l[0]];
    if (along >= s.along[hi]) return [s.x[hi], s.y[hi], s.l[hi]];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s.along[m] <= along) lo = m; else hi = m; }
    const f = (along - s.along[lo]) / Math.max(1e-6, s.along[hi] - s.along[lo]);
    return [s.x[lo] + (s.x[hi] - s.x[lo]) * f, s.y[lo] + (s.y[hi] - s.y[lo]) * f, s.l[lo] + (s.l[hi] - s.l[lo]) * f];
  }
  /** Where the walker (or the eye) is on a pose of the play-through: the smoothed way on a walk, the way itself on a
   *  stair, an escalator, a ramp or in a lift (world, at ROUTE_Y). */
  function walkPos(pose: { p: THREE.Vector3; i: number; along: number }) {
    const st = route && route.steps[pose.i];
    const q = st && (st.kind === 'walk' || st.kind === 'arrive') ? smoothAt(pose.along) : null;
    return q ? V(q[0], q[1], zOf(q[2])).setY(zOf(q[2]) * S + ROUTE_Y) : pose.p;
  }
  function drawRoute() {
    if (routeGroup) { scene.remove(routeGroup); freeGroup(routeGroup); }
    buildSmooth();
    routeGroup = new THREE.Group();
    if (pov) { floorLine(routeGroup); scene.add(routeGroup); activeDrawn = -2; drawActive(); return; }
    const pts = routePoints();
    if (!pts.some((p, i) => i > 0 && p.distanceTo(pts[i - 1]) > 0.01)) return;
    // a tube per step: on stairs, escalators and ramps a thin one, so the steps under it stay in view; a ball where two
    // meet. And an x-ray copy, faint, drawn through the floors: where a floor hides the way, you still see where it goes
    const caseMat = new THREE.MeshBasicMaterial({ color: ROUTE_CASE, side: THREE.BackSide });
    const coreMat = new THREE.MeshLambertMaterial({ color: ROUTE, emissive: ROUTE, emissiveIntensity: 0.35 });
    const xrayMat = new THREE.MeshBasicMaterial({ color: ROUTE, transparent: true, opacity: 0.4, depthTest: false, depthWrite: false });
    const pieces = route!.steps.filter((s) => s.to > s.from).map((s) => ({ pts: pts.slice(s.from, s.to + 1), thin: s.kind !== 'walk' && s.kind !== 'elevator' }));
    if (!pieces.length) pieces.push({ pts, thin: false });
    for (const pc of pieces) {
      const path = new THREE.CurvePath<THREE.Vector3>();
      for (let i = 0; i + 1 < pc.pts.length; i++) if (pc.pts[i].distanceTo(pc.pts[i + 1]) > 0.01) path.add(new THREE.LineCurve3(pc.pts[i], pc.pts[i + 1]));
      if (!path.curves.length) continue;
      const seg = Math.min(800, Math.max(4, Math.round(path.getLength() / 1.5)));
      const r = pc.thin ? THIN_R : TUBE_R;
      const tube = new THREE.TubeGeometry(path, seg, r, 8, false);
      routeGroup.add(new THREE.Mesh(new THREE.TubeGeometry(path, seg, r * 1.55, 8, false), caseMat));
      routeGroup.add(new THREE.Mesh(tube, coreMat));
      const xray = new THREE.Mesh(tube, xrayMat);
      xray.renderOrder = 10;
      routeGroup.add(xray);
    }
    for (let k = 1; k < pieces.length; k++) {
      const p = pieces[k].pts[0], r = pieces[k].thin && pieces[k - 1].thin ? THIN_R : TUBE_R;
      routeGroup.add(new THREE.Mesh(new THREE.SphereGeometry(r * 1.55, 12, 8).translate(p.x, p.y, p.z), caseMat));
      routeGroup.add(new THREE.Mesh(new THREE.SphereGeometry(r * 1.02, 12, 8).translate(p.x, p.y, p.z), coreMat));
    }
    for (const dp of doorPaths(pts)) {
      const c = new THREE.CurvePath<THREE.Vector3>();
      for (let i = 0; i + 1 < dp.length; i++) if (dp[i].distanceTo(dp[i + 1]) > 0.05) c.add(new THREE.LineCurve3(dp[i], dp[i + 1]));
      if (!c.curves.length) continue;
      const n = Math.max(4, Math.round(c.getLength() / 1.5));
      routeGroup.add(new THREE.Mesh(new THREE.TubeGeometry(c, n, 0.78, 8, false), new THREE.MeshBasicMaterial({ color: ROUTE_CASE, side: THREE.BackSide })));
      routeGroup.add(new THREE.Mesh(new THREE.TubeGeometry(c, n, 0.5, 8, false), new THREE.MeshLambertMaterial({ color: ROUTE, emissive: ROUTE, emissiveIntensity: 0.35 })));
    }
    for (const [p, colr] of [[pts[0], 0x1f8a4c], [pts[pts.length - 1], 0xd7263d]] as const) {
      routeGroup.add(new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.5, 20).translate(p.x, p.y, p.z), new THREE.MeshLambertMaterial({ color: colr })));
    }
    // which way it goes: small dark arrowheads on the tube, every ARROW_M along it (not up and down lift shafts)
    const marks: THREE.Matrix4[] = [];
    let next = ARROW_M / 2;
    const q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
    const onWalk = new Uint8Array(pts.length);
    for (const s of route!.steps) if (s.kind === 'walk') for (let k = s.from; k < s.to; k++) onWalk[k] = 1;
    for (let i = 0, run = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b2 = pts[i + 1], flat = Math.hypot(b2.x - a.x, b2.z - a.z);
      if (flat < 0.3) continue;
      if (!onWalk[i]) { run += flat; next = Math.max(next, run + ARROW_M / 3); continue; }
      const dir = new THREE.Vector3().subVectors(b2, a).normalize();
      // x along the way, y as near up as the slope allows: no roll on a sloping walk
      const zz = new THREE.Vector3().crossVectors(dir, UP).normalize(), yy = new THREE.Vector3().crossVectors(zz, dir);
      q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(dir, yy, zz));
      while (next <= run + flat) {
        const p = a.clone().lerp(b2, (next - run) / flat);
        p.y += TUBE_R * 1.3;   // on top of the tube, also where the step at hand thickens it
        marks.push(new THREE.Matrix4().compose(p, q, one));
        next += ARROW_M;
      }
      run += flat;
    }
    if (marks.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0.75, 0.02, 0, -0.45, 0.02, -0.45, -0.2, 0.02, 0, 0.75, 0.02, 0, -0.2, 0.02, 0, -0.45, 0.02, 0.45], 3));
      const arrows = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: ROUTE_CASE, side: THREE.DoubleSide }), marks.length);
      marks.forEach((m, i) => arrows.setMatrixAt(i, m));
      routeGroup.add(arrows);
    }
    singlePass(routeGroup);
    scene.add(routeGroup);
    activeDrawn = -2;
    drawActive();
  }
  // first person: the way as a yellow line on the floor (a tube at knee height would block the view), with arrowheads
  // every 4 m; over stairs and escalators a little higher, on their steps
  function floorLine(g: THREE.Group) {
    const bands: THREE.BufferGeometry[] = [], marks: THREE.Matrix4[] = [];
    // the smoothed way (the eye follows the same), a little higher over stairs and escalators, on their steps
    const line: THREE.Vector3[] = [];
    if (smooth) for (let i = 0; i < smooth.along.length; i++) {
      const l = smooth.l[i];
      line.push(V(smooth.x[i], smooth.y[i], zOf(l)).setY(zOf(l) * S + 0.03 + (smooth.walk[i] ? 0 : 0.22)));
    }
    let next = 2, run = 0;
    const q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
    for (let k = 0; k + 1 < line.length; k++) {
      const a = line[k], b2 = line[k + 1], flat = Math.hypot(b2.x - a.x, b2.z - a.z);
      if (flat < 0.05) continue;   // a lift shaft
      bands.push(band(a, b2, 0.5, 0));
      const dir = new THREE.Vector3().subVectors(b2, a).normalize();
      const zz = new THREE.Vector3().crossVectors(dir, UP).normalize(), yy = new THREE.Vector3().crossVectors(zz, dir);
      q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(dir, yy, zz));
      while (next <= run + flat) {
        const f = (next - run) / flat;
        marks.push(new THREE.Matrix4().compose(a.clone().lerp(b2, f).setY(a.y + (b2.y - a.y) * f + 0.01), q, one));
        next += 4;
      }
      run += flat;
    }
    if (bands.length) {
      const m = new THREE.MeshBasicMaterial({ color: ROUTE, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
      g.add(new THREE.Mesh(merged(bands), m));
    }
    if (marks.length) {
      const ag = new THREE.BufferGeometry();
      ag.setAttribute('position', new THREE.Float32BufferAttribute([0.3, 0.02, 0, -0.18, 0.02, -0.2, -0.08, 0.02, 0, 0.3, 0.02, 0, -0.08, 0.02, 0, -0.18, 0.02, 0.2], 3));
      const arrows = new THREE.InstancedMesh(ag, new THREE.MeshBasicMaterial({ color: ROUTE_CASE, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }), marks.length);
      marks.forEach((m, i) => arrows.setMatrixAt(i, m));
      g.add(arrows);
    }
  }
  // the piece of the way the current step covers: thicker, with a white casing (redrawn when the step changes)
  let activeGroup: THREE.Group | null = null, activeDrawn = -2;
  function drawActive() {
    const i = route ? stepIdx : -1;
    if (activeGroup && activeDrawn === i && activeGroup.parent) return;
    if (activeGroup) { scene.remove(activeGroup); freeGroup(activeGroup); activeGroup = null; }
    activeDrawn = i;
    if (!route || i < 0 || pov) return;
    const s = route.steps[i], all = routePoints();
    const pts = all.slice(s.from, Math.max(s.from, s.to) + 1);
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let k = 0; k + 1 < pts.length; k++) if (pts[k].distanceTo(pts[k + 1]) > 0.01) path.add(new THREE.LineCurve3(pts[k], pts[k + 1]));
    if (!path.curves.length) return;
    const seg = Math.min(600, Math.max(8, Math.round(path.getLength() / 1.5)));
    activeGroup = new THREE.Group();
    const r = s.kind !== 'walk' && s.kind !== 'elevator' ? THIN_R * 1.2 : TUBE_R * 1.25;
    activeGroup.add(new THREE.Mesh(new THREE.TubeGeometry(path, seg, r * 1.6, 10, false), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide })));
    activeGroup.add(new THREE.Mesh(new THREE.TubeGeometry(path, seg, r, 10, false), new THREE.MeshLambertMaterial({ color: ROUTE, emissive: ROUTE, emissiveIntensity: 0.5 })));
    scene.add(activeGroup);
  }
  // the cutaway follows the given points: pieces of at most `piece` metres, each opening the floors above it
  function cutAlong(pts: THREE.Vector3[], R = CUT_R) {
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
        pieces.push({ p, q, y: ceilingAbove(Math.max(p.y, q.y)), r: R });
      }
    }
    // too many after rounding: merge neighbours (never drop the end of the way)
    while (pieces.length > MAX_CUT) {
      let best = 0, bl = Infinity;
      for (let i = 0; i + 1 < pieces.length; i++) {
        const l = pieces[i].p.distanceTo(pieces[i + 1].q);
        if (pieces[i].r === R && pieces[i + 1].r === R && l < bl) { bl = l; best = i; }
      }
      const a = pieces[best], b2 = pieces[best + 1];
      pieces.splice(best, 2, { p: a.p, q: b2.q, y: Math.max(a.y, b2.y), r: R });
    }
    CUT.uN.value = pieces.length;
    const box = CUT.uCutBox.value.set(Infinity, Infinity, -Infinity, -Infinity);
    let minY = Infinity;
    pieces.forEach((pc, i) => {
      CUT.uSeg.value[i].set(pc.p.x, pc.p.z, pc.q.x, pc.q.z);
      CUT.uSegY.value[i] = pc.y;   // open what is above this piece of the way (its own floor stays)
      CUT.uSegR.value[i] = pc.r;
      box.set(Math.min(box.x, pc.p.x - pc.r, pc.q.x - pc.r), Math.min(box.y, pc.p.z - pc.r, pc.q.z - pc.r), Math.max(box.z, pc.p.x + pc.r, pc.q.x + pc.r), Math.max(box.w, pc.p.z + pc.r, pc.q.z + pc.r));
      minY = Math.min(minY, pc.y);
    });
    CUT.uCutMinY.value = minY;
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

  // ------------------------------------------------------------------ the train: a hologram on the track
  // A double-deck coach (the IC 2000 / Twindexx / KISS shape most SBB trains have) or a locomotive, drawn as a
  // glowing see-through shell with its windows, doors and class marks; the coaches to get on in the way's colour, the
  // stretch of platform in front of them lit as the boarding zone. docs/train-formation.md
  interface SolidTrain {
    input: SolidTrainInput; layout: TrainLayout; group: THREE.Group; y: number;
    zone: THREE.MeshBasicMaterial | null; textures: THREE.Texture[]; box: THREE.Box3;
  }
  /** The vehicles shown: at most one per role. */
  let trains: SolidTrain[] = [];
  const holoTime = { value: 0 };
  const stillMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** Typical trains that are not the journey's (SolidTrainInput.ambient). */
  let ambient: SolidTrain[] = [];
  /** The roles the journey gave a vehicle for (setTrain), whether or not it could be placed: no typical train there. */
  const given = new Set<SolidTrainInput['role']>();
  const AMBIENT_M = 4 * 26.5;   // m: a typical train is drawn this long, round where the way arrives
  // cross-sections (across the track, height above the rail; metres): a double-deck coach, a locomotive
  const PROFILE_DD: [number, number][] = [[-1.4, 0.6], [-1.42, 3.35], [-1.3, 4.1], [-0.9, 4.48], [0, 4.6], [0.9, 4.48], [1.3, 4.1], [1.42, 3.35], [1.4, 0.6]];
  const PROFILE_LOCO: [number, number][] = [[-1.48, 0.7], [-1.5, 3.0], [-1.32, 3.65], [-0.8, 3.92], [0, 3.98], [0.8, 3.92], [1.32, 3.65], [1.5, 3.0], [1.48, 0.7]];
  // a low-floor tram, an articulated bus
  const PROFILE_TRAM: [number, number][] = [[-1.15, 0.35], [-1.17, 2.95], [-1.02, 3.35], [-0.5, 3.5], [0, 3.52], [0.5, 3.5], [1.02, 3.35], [1.17, 2.95], [1.15, 0.35]];
  // a single-deck regional unit of a narrow-gauge line (the RBS, the MOB …)
  const PROFILE_SD: [number, number][] = [[-1.3, 0.5], [-1.33, 2.95], [-1.2, 3.5], [-0.62, 3.74], [0, 3.78], [0.62, 3.74], [1.2, 3.5], [1.33, 2.95], [1.3, 0.5]];
  const PROFILE_BUS: [number, number][] = [[-1.27, 0.3], [-1.28, 2.75], [-1.15, 3.05], [0, 3.12], [1.15, 3.05], [1.28, 2.75], [1.27, 0.3]];
  const NOSE_M = 3.4;
  /** A shell L long along +x, its profile across z; sloped driving ends where asked. uv: u along, v round the profile. */
  function coachGeometry(L: number, prof: [number, number][], noseA: boolean, noseB: boolean) {
    const rings: [number, number, number][] = [];   // x, width scale, height scale
    // a nose takes at most a third of a short shell (with two, the rings stay in order)
    const N = Math.min(NOSE_M, L / 3), N1 = N * 1.1 / NOSE_M;
    if (noseA) rings.push([0, 0.84, 0.5], [N1, 0.95, 0.8], [N, 1, 1]); else rings.push([0, 1, 1]);
    if (noseB) rings.push([L - N, 1, 1], [L - N1, 0.95, 0.8], [L, 0.84, 0.5]); else rings.push([L, 1, 1]);
    const base = prof[0][1], n = prof.length;
    const per = [0];
    for (let i = 1; i < n; i++) per.push(per[i - 1] + Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]));
    const P = per[n - 1];
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (const [x, sw, sh] of rings) prof.forEach(([z, y], k) => { pos.push(x, base + (y - base) * sh, z * sw); uv.push(x / L, per[k] / P); });
    for (let r = 0; r + 1 < rings.length; r++) {
      // wound so the normals point out (the shader tells the near side from the far one by them)
      for (let k = 0; k + 1 < n; k++) { const a = r * n + k, c = a + n; idx.push(a, a + 1, c, a + 1, c + 1, c); }
      const a = r * n + n - 1, b = r * n, c = a + n, d = b + n;   // the floor
      idx.push(a, b, c, b, d, c);
    }
    for (const r of [0, rings.length - 1]) {   // the two ends, a fan from their middle (their own corners: flat normals)
      const [x, sw, sh] = rings[r], c0 = pos.length / 3;
      pos.push(x, base + (2.2 - base) * sh, 0); uv.push(x / L, 0.5);
      prof.forEach(([z, y]) => { pos.push(x, base + (y - base) * sh, z * sw); uv.push(x / L, 0.5); });
      const out = r === 0 ? -1 : 1;
      for (let k = 0; k < n; k++) { const p = c0 + 1 + k, q = c0 + 1 + ((k + 1) % n); if (out > 0) idx.push(c0, p, q); else idx.push(c0, q, p); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return { g, per, P };
  }
  type SkinKind = 'c1' | 'c2' | 'c12' | 'rest' | 'loco' | 'plain' | 'single' | 'tram' | 'bus';
  /** The coach's sides, unrolled (u along, v round the profile): windows, doors, the yellow band of 1st class, numerals. */
  function skin(kind: SkinKind, L: number, prof: [number, number][], noseA = false, noseB = false) {
    const W = 1024, H = 256, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d')!;
    const per = [0];
    for (let i = 1; i < prof.length; i++) per.push(per[i - 1] + Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]));
    const P = per[per.length - 1];
    // v of a height on the left side (the right side is the mirror: 1 − v); canvas y with flipY: (1 − v) · H
    const vOf = (h: number) => {
      for (let i = 1; i < prof.length; i++) {
        const [, y0] = prof[i - 1], [, y1] = prof[i];
        if (y1 > y0 && h <= y1) return (per[i - 1] + (per[i] - per[i - 1]) * Math.max(0, (h - y0) / (y1 - y0))) / P;
      }
      return 0.5;
    };
    const X = (m: number) => m / L * W;
    const sides: { y: (h: number) => number; flip: number }[] = [{ y: (h) => (1 - vOf(h)) * H, flip: -1 }, { y: (h) => vOf(h) * H, flip: 1 }];
    const rect = (x0: number, x1: number, h0: number, h1: number, fill: string | null, stroke?: string) => {
      for (const s of sides) {
        const ya = s.y(h0), yb = s.y(h1), y = Math.min(ya, yb), hh = Math.abs(yb - ya);
        if (fill) { g.fillStyle = fill; g.beginPath(); g.roundRect(X(x0), y, X(x1) - X(x0), hh, Math.min(4, hh / 3)); g.fill(); }
        if (stroke) { g.strokeStyle = stroke; g.lineWidth = 2; g.beginPath(); g.roundRect(X(x0), y, X(x1) - X(x0), hh, 3); g.stroke(); }
      }
    };
    const text = (t: string, xm: number, h: number, size: number, col: string) => {
      for (const s of sides) {
        g.save(); g.translate(X(xm), s.y(h));
        // left side: seen from outside, u runs right to left (mirror); right side: v runs downwards (upside down)
        if (s.flip < 0) g.scale(-1, 1); else g.scale(1, -1);
        g.fillStyle = col; g.font = `800 ${size}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(t, 0, 0); g.restore();
      }
    };
    const win = 'rgba(235,250,255,0.92)', frame = 'rgba(235,250,255,0.75)';
    // a line along the body at the floor and under the roof
    rect(0.3, L - 0.3, 0.62, 0.72, frame);
    if (kind === 'single') {
      // one row of windows, the doors where coach-plan.ts puts them (the way is drawn through them)
      const doors = [(noseA ? NOSE_DOOR_M : DOOR_IN_M) - 0.9, L - (noseB ? NOSE_DOOR_M : DOOR_IN_M) - 0.5];
      for (let x = 0.6; x + 1.3 < L - 0.5; x += 1.75) if (!doors.some((d) => x + 1.3 > d - 0.15 && x < d + 1.45)) rect(x, x + 1.3, 1.2, 2.45, win);
      for (const d of doors) rect(d, d + 1.3, 0.55, 2.5, 'rgba(235,250,255,0.18)', frame);
    } else if (kind === 'tram' || kind === 'bus') {
      // one row of tall windows, double doors (a tram part has one in its middle; a bus at the front and the middle)
      const top = kind === 'tram' ? 2.55 : 2.6, doors = kind === 'tram' ? [L / 2 - 0.65] : L > 9 ? [0.9, L / 2 - 0.6] : [L / 2 - 0.6];
      for (let x = 0.5; x + 1.1 < L - 0.4; x += 1.55) if (!doors.some((d) => x + 1.1 > d - 0.1 && x < d + 1.4)) rect(x, x + 1.1, 1.15, top, win);
      for (const d of doors) rect(d, d + 1.3, 0.45, top, 'rgba(235,250,255,0.18)', frame);
    } else if (kind === 'loco') {
      rect(0.4, 2.6, 2.3, 3.2, win); rect(L - 2.6, L - 0.4, 2.3, 3.2, win);           // cab windows
      for (let x = 4.2; x + 1.2 < L - 4.2; x += 2.2) rect(x, x + 1.2, 2.2, 2.9, 'rgba(235,250,255,0.35)');   // grilles
      rect(L / 2 - 1.6, L / 2 + 1.6, 1.4, 1.9, 'rgba(255,70,80,0.95)');                  // the red front-to-back band
    } else {
      rect(0.3, L - 0.3, 4.02, 4.1, frame);
      // where coach-plan.ts puts them (the shell starts 0.2 m into the car): not in a sloped driving end
      const doors = [(noseA ? NOSE_DOOR_M : DOOR_IN_M) - 0.9, L - (noseB ? NOSE_DOOR_M : DOOR_IN_M) - 0.5];
      for (const d of doors) rect(d, d + 1.4, 0.75, 2.55, 'rgba(235,250,255,0.18)', frame);
      for (let x = 4.4; x + 1.5 < L - 4.2; x += 1.95) { rect(x, x + 1.5, 1.3, 2.15, win); rect(x, x + 1.5, 2.65, 3.55, win); }
      if (kind === 'c1') rect(0.3, L - 0.3, 3.72, 3.86, 'rgba(255,212,0,1)');
      if (kind === 'c12') rect(0.3, L / 2, 3.72, 3.86, 'rgba(255,212,0,1)');
      if (kind === 'rest') rect(0.3, L - 0.3, 3.72, 3.86, 'rgba(255,70,80,1)');
      const num = kind === 'c1' ? ['1', '1'] : kind === 'c2' ? ['2', '2'] : kind === 'c12' ? ['1', '2'] : null;
      if (num) { text(num[0], 2.9, 3.1, 64, kind === 'c2' ? '#ffffff' : '#ffd400'); text(num[1], L - 2.9, 3.1, 64, num[1] === '1' ? '#ffd400' : '#ffffff'); }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  }
  function holoMaterial(color: number, map: THREE.Texture, light: boolean) {
    return new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uColor: { value: new THREE.Color(color) }, uMap: { value: map }, uTime: holoTime, uOpacity: { value: light ? 0.95 : 0.9 } },
      vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying float vH;
        #include <fog_pars_vertex>
        void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; vN = normalMatrix * normal; vH = position.y;
          gl_Position = projectionMatrix * mv; vec4 mvPosition = mv;
          #include <fog_vertex>
        }`,
      fragmentShader: `uniform vec3 uColor; uniform sampler2D uMap; uniform float uTime; uniform float uOpacity;
        #include <fog_pars_fragment>
        varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying float vH;
        void main() {
          float facing = dot(normalize(vN), normalize(vV));
          float fres = pow(1.0 - abs(facing), 2.0);
          // the far side shows through, faintly: its numerals would read mirrored
          vec4 t = texture2D(uMap, vUv) * (facing > 0.0 ? 1.0 : 0.28);
          float scan = 0.6 + 0.4 * sin(vH * 10.0 - uTime * 2.6);
          float sweep = smoothstep(0.92, 1.0, fract(vH * 0.22 - uTime * 0.35));
          float a = uOpacity * ((0.08 + 0.7 * fres) * scan + 0.85 * t.a + 0.35 * sweep);
          vec3 col = mix(uColor * (0.75 + 0.7 * fres), t.rgb, t.a * 0.8) + sweep * 0.35;
          gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
          #ifdef USE_FOG
            gl_FragColor.a *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);   // fades (it glows: mixing in the fog's colour would not)
          #endif
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
      blending: light ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
  }
  const skinKind = (c: TrainCoach | null): SkinKind => !c ? 'plain' : c.kind === 'loco' ? 'loco' : c.kind === 'restaurant' ? 'rest'
    : c.cls === 1 ? 'c1' : c.cls === 2 ? 'c2' : c.cls === 12 ? 'c12' : 'plain';
  /** Takes away the vehicle of that role (or all of them). */
  function dropTrain(role?: SolidTrainInput['role']) {
    trainsN++;
    for (const t of trains.filter((x) => !role || x.input.role === role)) {
      scene.remove(t.group); freeGroup(t.group);
      t.textures.forEach((x) => x.dispose());
    }
    trains = trains.filter((x) => role && x.input.role !== role);
  }
  function drawTrain(input: SolidTrainInput) {
    dropTrain(input.role);
    // where the model has no sectors for the platform, along the platform's own line (only to be shown: approx)
    const layout = input.kind === 'train' ? layoutTrain(model!, input.ref, { coaches: input.coaches, sectors: input.sectors, approx: true })
      : input.pose ? layoutAtStop(model!, input.kind, input.pose) : null;
    // laid out without sectors: where it stands is a guess, so no coach is marked to get on and no way leads to a door
    const shown = layout && layout.approx ? { ...input, target: [], sector: null, door: null } : input;
    const t = layout && layout.cars.length ? makeTrain(shown, layout) : null;
    if (t) { scene.add(t.group); trains.push(t); }
    given.add(input.role);
    syncAmbient();
    // the old vehicle's labels and its stretch of the way go, the new one's come
    labelsDirty = true;
    if (route) drawRoute();   // the way's stretch through the door
    request();
    return layout;
  }
  function makeTrain(input: SolidTrainInput, layout: TrainLayout): SolidTrain {
    const light = !dark(), amb = !!input.ambient;
    const group = new THREE.Group(), textures: THREE.Texture[] = [];
    const floorY = zOf(layout.level) * S, y = layout.kind === 'train' ? (zOf(layout.level) - 1.1) * S + 0.15 : floorY;
    const target = new Set(input.target);
    const mats = new Map<string, THREE.ShaderMaterial>();
    // made when first used: freeGroup frees what is in the group, and only that
    const edgeMats: { on?: THREE.LineBasicMaterial; off?: THREE.LineBasicMaterial } = {};
    const onCol = input.role === 'alight' ? (light ? HOLO_OFF_LIGHT : HOLO_OFF) : (light ? HOLO_TARGET_LIGHT : HOLO_TARGET);
    const edgeMat = (on: boolean) => edgeMats[on ? 'on' : 'off'] ||= new THREE.LineBasicMaterial({ color: on ? onCol : (light ? HOLO_LIGHT : HOLO), transparent: true, opacity: light ? 0.9 : 0.85, depthWrite: false });
    // no crowding drawn per coach: the forecast is one figure per class for the whole train (the card shows it)
    const ground: THREE.BufferGeometry[] = [], zoneGs: THREE.BufferGeometry[] = [];
    const P3 = (xy: XY, up = 0) => V(xy[0], xy[1], 0).setY(y + up);
    for (const car of layout.cars) {
      const on = !!car.coach && target.has(car.idx);
      const loco = !!car.coach && car.coach.kind === 'loco';
      const prof = layout.kind === 'tram' ? PROFILE_TRAM : layout.kind === 'bus' ? PROFILE_BUS : loco ? PROFILE_LOCO : layout.narrow ? PROFILE_SD : PROFILE_DD;
      const a = P3(car.a), b = P3(car.b), d = new THREE.Vector3().subVectors(b, a), L = d.length();
      if (L < 3) continue;
      const kind: SkinKind = layout.kind === 'train' ? (layout.narrow && !loco ? 'single' : skinKind(car.coach)) : layout.kind, mk = kind + (on ? '*' : '') + '|' + Math.round(L) + (car.noseA ? '<' : '') + (car.noseB ? '>' : '');
      if (!mats.has(mk)) {
        const t = skin(kind, L - 0.4, prof, car.noseA, car.noseB);
        textures.push(t);
        const m = holoMaterial(on ? onCol : (light ? HOLO_LIGHT : HOLO), t, light);
        if (amb) m.uniforms.uOpacity.value *= 0.8;   // not the journey's: a little quieter
        mats.set(mk, m);
      }
      const { g } = coachGeometry(L - 0.4, prof, car.noseA, car.noseB);
      g.translate(0.2, 0, 0);
      const body = new THREE.Mesh(g, mats.get(mk)!);
      body.renderOrder = 6;
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(g, 28), edgeMat(on));
      lines.renderOrder = 7;
      for (const o of [body, lines]) { o.position.copy(a); o.rotation.y = Math.atan2(-d.z, d.x); group.add(o); }
      // under it: the light it stands in, coloured by how full its class is expected to be
      ground.push(band(a, b, 3.4, 0.2));

      // where to stand: the stretch of platform in front of the coach
      if (on) {
        const s = new THREE.Vector3(layout.side[0], 0, -layout.side[1]).multiplyScalar(3.0);
        zoneGs.push(band(a.clone().lerp(b, 0.08).add(s), b.clone().lerp(a, 0.08).add(s), 1.7, floorY - y + 0.1));
      }
    }
    if (ground.length) group.add(new THREE.Mesh(merged(ground), new THREE.MeshBasicMaterial({ color: light ? HOLO_LIGHT : HOLO, transparent: true, opacity: light ? 0.16 : 0.2, depthWrite: false, side: THREE.DoubleSide })));
    let zone: THREE.MeshBasicMaterial | null = null;
    if (zoneGs.length) {
      zone = new THREE.MeshBasicMaterial({ color: input.role === 'alight' ? HOLO_OFF : ROUTE, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
      const m = new THREE.Mesh(merged(zoneGs), zone);
      m.renderOrder = 8;
      group.add(m);
    }
    singlePass(group);
    // the coaches' skins to the GPU now, not in the frame the train first comes into view
    for (const t of textures) renderer.initTexture(t);
    return { input, layout, group, y, zone, textures, box: new THREE.Box3().setFromObject(group) };
  }
  /** A typical train (SolidTrainInput.ambient) at the end and at the start of the way when they are at a train's platform
   *  and the journey gave no vehicle there: so that the platform you walk to has a train, as it will when you get there. */
  let ambientKey = '';
  function syncAmbient() {
    const want: { input: SolidTrainInput; at: XY }[] = [];
    const pk = StationRoute.platformKey;
    if (route && !route.same) {
      const pts = route.points;
      for (const [stop, role, p] of [[route.toStop, 'board', pts[pts.length - 1]], [route.fromStop, 'alight', pts[0]]] as const) {
        if (!stop || stop.mode !== 'train' || !stop.ref || given.has(role) || trains.some((t) => pk(t.input.ref) === pk(stop.ref))) continue;
        if (want.some((w) => pk(w.input.ref) === pk(stop.ref))) continue;
        const secs = [...new Set((model!.sectors || []).filter((x) => pk(x.ref) === pk(stop.ref)).map((x) => x.name))];
        want.push({ input: { role, kind: 'train', ref: stop.ref, coaches: null, sectors: secs, target: [], crowd: null, cls: 2, ambient: true }, at: [p[0], p[1]] });
      }
    }
    const key = want.map((w) => w.input.ref + w.input.role + w.at.map(Math.round)).join('|') + (dark() ? 'd' : 'l') + S;
    if (key === ambientKey) return;
    ambientKey = key;
    dropAmbient();
    for (const w of want) {
      const layout = layoutTrain(model!, w.input.ref, { coaches: null, sectors: w.input.sectors, approx: true, around: w.at, maxLen: AMBIENT_M });
      if (!layout || !layout.cars.length) continue;
      const t = makeTrain(w.input, layout);
      scene.add(t.group);
      ambient.push(t);
    }
    labelsDirty = true;
    request();
  }
  function dropAmbient() {
    for (const t of ambient) { scene.remove(t.group); freeGroup(t.group); t.textures.forEach((x) => x.dispose()); }
    ambient = [];
  }
  /** Transparent and double-sided: drawn in one pass. (three.js otherwise draws the back and the front apart, changing the
   *  material twice a frame to do so, which makes it look up the material's shader program again every frame.) */
  function singlePass(o: THREE.Object3D) {
    o.traverse((x: SolidDrawn) => { for (const m of x.material ? (Array.isArray(x.material) ? x.material : [x.material]) : []) if (m.transparent && m.side === THREE.DoubleSide) m.forceSinglePass = true; });
  }
  /** The ends of the coaches to get on or off (or the whole vehicle): for framing the whole way. */
  function trainFrame(): THREE.Vector3[] {
    // (not the typical trains: the way is framed, they stand where it ends)
    return trains.flatMap((tr) => {
      const cars = tr.layout.cars, t = new Set(tr.input.target);
      const on = cars.filter((c) => c.coach && t.has(c.idx));
      return (on.length ? on : cars).flatMap((c) => [V(c.a[0], c.a[1], 0).setY(tr.y + 4.6), V(c.b[0], c.b[1], 0).setY(tr.y)]);
    });
  }
  /** The last metres of the way: from its end on the platform through the chosen coach's door into the coach
   *  (board), or out of it to the way's start (alight). Joined to the way only when it ends near the door. */
  function doorPaths(pts: THREE.Vector3[]): THREE.Vector3[][] {
    const out: THREE.Vector3[][] = [];
    for (const tr of trains) {
      const d = tr.input.door;
      if (!d) continue;
      const lv = zOf(tr.layout.level) * S;
      const spot = V(d.xy[0], d.xy[1], 0).setY(lv + ROUTE_Y), inside = V(d.inside[0], d.inside[1], 0).setY(lv + 1.3);
      const end = tr.input.role === 'board' ? pts[pts.length - 1] : pts[0];
      const path = end && end.distanceTo(spot) < 60 ? [end, spot, inside] : [spot, inside];
      out.push(tr.input.role === 'board' ? path : path.reverse());
    }
    return out;
  }

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
  /** The sign of the manoeuvre, and whether it is the step at hand (it then goes with the walker or with you). */
  let beacon: SolidLabel | null = null, beaconRides = false;
  // The labels that do not depend on the step (floors, places, shops, services, the way's ends, the train) are made again
  // only when what they show changes (a build, another way, first person, a train); a step remakes only its chips and sign.
  let staticLabels: SolidLabel[] = [], stepLabels: SolidLabel[] = [], staticKey = '', buildN = 0, routeN = 0, trainsN = 0;
  function makeLabels() {
    const key = `${buildN}|${routeN}|${trainsN}|${pov}`;
    for (const L of stepLabels) L.el.remove();
    stepLabels = [];
    beacon = null;
    occAt = 0;   // new labels: which are behind a wall is checked at once
    let into: SolidLabel[] = stepLabels;
    const add = (text: string, x: number, y: number, z: number, cls: string, prio: number, opts2: SolidLabelOptions = {}) => {
      const el = document.createElement('div');
      el.className = 'sx-label ' + cls;
      if (opts2.html) el.innerHTML = opts2.html; else el.textContent = text;
      el.style.display = 'none';
      labelsEl.appendChild(el);
      const L: SolidLabel = Object.assign({ el, pos: V(x, y, z).setY(z * S + (opts2.up || 2.4)), prio, z, vis: false }, opts2);
      if (pov) L.room = roomAt(x, y, levelOfZ(z));
      into.push(L);
      return L;
    };
    if (key !== staticKey) {
      staticKey = key;
      for (const L of staticLabels) L.el.remove();
      staticLabels = [];
      into = staticLabels;
      staticPart(add);
    }
    into = stepLabels;
    if (route) {
      // one full sign for the manoeuvre at hand (the step's own, or the next change of floor on a walk); the other
      // changes of floor as small chips, which give way to everything more important
      const pts = route.points, man = manoeuvre();
      route.steps.forEach((s, i) => {
        if (i === man || !floorChange(s)) return;
        const p = pts[s.from];
        add(`${kindName(s.kind)} ${arrowOf(s)} ${levelTag(s.toLevel)}`, p[0], p[1], zOf(p[2]), 'sx-step sx-chip', 80, { up: 3.0, step: i });
      });
      if (man >= 0) {
        const s = route.steps[man], p = pts[s.from];
        beacon = add(kindName(s.kind), p[0], p[1], zOf(p[2]), 'sx-step sx-on sx-beacon sx-k-' + s.kind, 99, { up: 3.4, step: man, html: beaconHtml(man) });
        beaconRides = man === stepIdx;
      }
    }
    labels = staticLabels.concat(stepLabels).sort((a, b2) => b2.prio - a.prio);   // the most important first: they win the room on screen
    labelsDirty = false;
  }
  type SolidAdd = (text: string, x: number, y: number, z: number, cls: string, prio: number, o?: SolidLabelOptions) => SolidLabel;
  function staticPart(add: SolidAdd) {
    const used = new Set(route ? route.points.map((p) => Math.round(p[2])) : []);
    // each floor named at the edge of its largest slab (the west-most corner), so the stack reads as one building
    for (const lv of levels) {
      if (!onLevel(lv.id) || pov) continue;   // first person: you are on a floor, not looking at the stack
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
    // named buildings round it (Sihlpost, KKL, the main hall): landmarks for the way out, quiet, and only from near
    const named = new Set<string>();
    for (const sh of solid!.shell) {
      if (!sh.name || sh.kind !== 'building' || named.has(sh.name) || !aroundIn(sh.ring)) continue;
      named.add(sh.name);
      let ax = 0, ay = 0;
      for (const [x, y] of sh.ring) { ax += x; ay += y; }
      add(sh.name, ax / sh.ring.length, ay / sh.ring.length, sh.base, 'sx-landmark', 20, { near: 220, up: 1.5 });
    }
    if (route) {
      const pts = route.points;
      add('Start', pts[0][0], pts[0][1], zOf(pts[0][2]), 'sx-start', 100, { up: 3.2 });
      add(endName(), pts[pts.length - 1][0], pts[pts.length - 1][1], zOf(pts[pts.length - 1][2]), 'sx-end', 100, { up: 3.2 });
      // what is round the way: tickets, toilets, information, meeting point, lockers (near it, on its floors)
      for (const q of model!.pois || []) {
        if (!used.has(Math.round(q.level)) || nearRoute(q.xy[0], q.xy[1]) > POI_M) continue;
        add(POI_NAME[q.kind] || q.kind, q.xy[0], q.xy[1], zOf(q.level), 'sx-poi sx-poi-' + q.kind, 40, { near: 160, up: 2.2 });
      }
    }
    for (const tr of trains) trainLabels(tr, add);
  }
  // over each coach its class (and how full that class is expected to be); on the platform, where to get on
  function trainLabels(t: SolidTrain, add: SolidAdd) {
    const tg = new Set(t.input.target), z = zOf(t.layout.level);
    const mid = (c: TrainCar) => [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2];
    if (t.layout.kind !== 'train') {
      // a tram or bus: what it is, and that its shape and place are typical
      const cars = t.layout.cars, [x, y] = mid(cars[Math.floor(cars.length / 2)]);
      add(t.input.title || (t.layout.kind === 'tram' ? 'Tram' : 'Bus'), x, y, z, 'sx-coach sx-vehicle', t.input.role === 'board' ? 93 : 91,
        { up: 4.6, html: `<b>${escHtml(t.input.title || (t.layout.kind === 'tram' ? 'Tram' : 'Bus'))}</b> <em>${t.input.role === 'board' ? 'get on' : 'you arrive'} · approximate</em>` });
      return;
    }
    for (const car of t.layout.cars) {
      const c = car.coach;
      if (!c || c.kind === 'loco' || c.kind === 'luggage' || c.kind === 'other') continue;
      const on = tg.has(car.idx);
      const name = c.kind === 'restaurant' ? 'Restaurant' : c.kind === 'sleeper' ? 'Sleeper' : c.cls === 12 ? '1 | 2' : String(c.cls || '');
      const html = `<b>${name}</b>${c.closed ? ' <em>closed</em>' : c.declassed ? ' <em>open to all</em>' : ''}`
;
      const [x, y] = mid(car);
      add(name, x, y, z, 'sx-coach' + (on ? ' sx-on' + (t.input.role === 'alight' ? ' sx-off' : '') : '') + (c.cls === 1 || c.cls === 12 ? ' sx-c1' : '') + (c.closed ? ' sx-closed' : ''), on ? 96 : 34, { up: 5.3, near: on ? undefined : 190, html });
    }
    const on = t.layout.cars.filter((c) => c.coach && tg.has(c.idx));
    if (on.length) {
      const secs = t.input.sector ? [t.input.sector] : [...new Set(on.flatMap((c) => c.coach!.sectors))].sort();
      const m = on[Math.floor((on.length - 1) / 2)], [x, y] = mid(m);
      const where = secs[0] ? ` · sector ${secs.length > 1 ? secs[0] + '–' + secs[secs.length - 1] : secs[0]}` : '';
      add(t.input.role === 'board' ? `Get on here${where}` : `You get off here${where}`, x + t.layout.side[0] * 3, y + t.layout.side[1] * 3, z, 'sx-board' + (t.input.role === 'alight' ? ' sx-off' : ''), 99, { up: 1.4 });
    } else if (!t.input.coaches && t.input.sectors.length) {
      const cars = t.layout.cars, [x, y] = mid(cars[Math.floor(cars.length / 2)]);
      const s = t.input.sectors;
      add(`Train stops in sector${s.length > 1 ? 's ' + s[0] + '–' + s[s.length - 1] : ' ' + s[0]}`, x, y, z, 'sx-coach sx-on', 92, { up: 5.3 });
    }
  }
  const levelOfZ = (z: number) => levels.reduce((best, l) => (Math.abs(l.z - z) < Math.abs(best.z - z) ? l : best), levels[0]).id;
  const kindName = (k: StationRouteStep['kind']) => ({ escalator: 'Escalator', stairs: 'Stairs', elevator: 'Lift', ramp: 'Ramp', walk: 'Walk', arrive: 'Arrive' } as Record<string, string>)[k] || k;
  const levelTag = (l: number) => (Math.round(l) > 0 ? '+' : Math.round(l) < 0 ? '−' : '') + Math.abs(Math.round(l));
  const arrowOf = (s: StationRouteStep) => (s.dir === 'up' ? '↑' : s.dir === 'down' ? '↓' : Math.round(s.toLevel) > Math.round(s.level) ? '↑' : Math.round(s.toLevel) < Math.round(s.level) ? '↓' : '');
  const floorChange = (s: StationRouteStep) => s.kind !== 'walk' && s.kind !== 'arrive' && Math.round(s.toLevel) !== Math.round(s.level);
  /** The step whose sign shows now: the step at hand when it is a stair, escalator, ramp or lift; on a walk, the next
   *  change of floor (or the end). -1: none (the whole way is shown). */
  function manoeuvre(): number {
    if (!route) return -1;
    const i = stepIdx;
    if (i < 0) return -1;
    const s = route.steps[i];
    if (s.kind !== 'walk' && s.kind !== 'arrive') return i;
    for (let k = i + 1; k < route.steps.length; k++) if (floorChange(route.steps[k])) return k;
    return -1;
  }
  /** The height (world y) of the highest point of step i. */
  function stepTop(i: number) {
    const st = route!.steps[i];
    let y = -Infinity;
    for (let k = st.from; k <= st.to; k++) y = Math.max(y, zOf(route!.points[k][2]) * S + ROUTE_Y);
    return y;
  }
  /** The sign's text: "In 25 m Lift ↓ −4 Löwenstrasse". */
  function beaconHtml(i: number) {
    const s = route!.steps[i], ahead = aheadOf(i);
    return (ahead > 4 ? `<em>In ${ahead < 100 ? Math.max(5, Math.round(ahead / 5) * 5) : Math.round(ahead / 10) * 10} m</em> ` : '')
      + `<b>${escHtml(kindName(s.kind))} ${arrowOf(s)}</b>` + (Math.round(s.toLevel) !== Math.round(s.level) ? ` ${escHtml(levelName(s.toLevel))}` : '');
  }
  /** As you (or the walker) go: only the sign's distance changes, the other labels stay as they are. */
  function refreshBeacon() {
    if (labelsDirty || !beacon || beacon.step == null) return;
    const html = beaconHtml(beacon.step);
    if (beacon.el.innerHTML !== html) beacon.el.innerHTML = html;
  }
  /** Metres from where you are (the play-through's walker, your position on the way, else the step's start) to step i. */
  function aheadOf(i: number): number {
    if (!route || i <= stepIdx) return 0;
    const mine = playing || (user.mode === 'route' && user.step === stepIdx);
    const at = here != null && mine ? here : route.dists[route.steps[stepIdx].from];
    return Math.max(0, route.dists[route.steps[i].from] - at);
  }
  /** Horizontal metres from (x, y) to the way. */
  function nearRoute(x: number, y: number) {
    if (!route) return Infinity;
    let d = Infinity;
    const p = route.points;
    for (let i = 0; i + 1 < p.length; i++) {
      const ax = p[i][0], ay = p[i][1], dx = p[i + 1][0] - ax, dy = p[i + 1][1] - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / Math.max(dx * dx + dy * dy, 1e-6)));
      d = Math.min(d, Math.hypot(x - ax - dx * t, y - ay - dy * t));
    }
    return d;
  }
  const levelName = (l: number) => { const lv = levels.find((x) => x.id === Math.round(l)); return lv ? `${lv.id > 0 ? '+' : ''}${lv.id}${lv.name ? ' ' + lv.name : ''}` : String(l); };
  const endName = () => {
    const s = route && route.toStop;
    if (!s) return 'Destination';
    if (s.mode === 'train' && s.ref) return `Platform ${s.ref}`;
    return `${s.mode === 'tram' ? 'Tram' : 'Bus'} ${String(s.name).replace(/^[^,]*,\s*/, '')}${s.ref ? ' ' + s.ref : ''}`;
  };
  const tmp = new THREE.Vector3();
  let occAt = 0, occTimer = 0;
  function placeLabels() {
    if (labelsDirty) makeLabels();
    // in a lift or on an escalator, the sign rides along with the walker (or with you)
    const rider = pov ? null : playing && walker ? walker.position : user.mode === 'route' && user.step === stepIdx && youAt ? youAt : null;
    if (beacon && beaconRides && rider) beacon.pos.copy(rider).setY(rider.y + 3.4);
    const w = viewW, h = viewH;
    const camDist = camera.position.distanceTo(controls.target);
    const shown: { x0: number; x1: number; y0: number; y1: number }[] = [];
    // first person: a label behind a wall or a shop is not shown (checked four times a second, not every frame, in the
    // plan of the floor you are on: walls and shops stand from floor to ceiling)
    const now = performance.now(), check = pov && now - occAt > 250;
    if (check) occAt = now;
    else if (pov && !occTimer) occTimer = window.setTimeout(() => { occTimer = 0; request(); }, 260);   // once still, checked again
    const eyeFloor = camera.position.y - EYE, eyeLevel = pov ? levelOfZ(eyeFloor / S) : 0;
    const ex = camera.position.x + cx, ey = -camera.position.z + cy;
    for (const L of labels) {
      let ok = true;
      // first person: far, or on another floor (cheap tests first)
      if (pov && L.prio < 99 && (Math.abs(L.z * S - eyeFloor) > 2.8 || camera.position.distanceTo(L.pos) > (L.near ? 45 : 90))) ok = false;
      if (ok) { tmp.copy(L.pos).project(camera); ok = tmp.z < 1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05; }
      if (ok && L.near && camDist > L.near * 2.2 && !pov) ok = false;
      if (ok && check && L.prio < 99) L.behind = wallBetween(ex, ey, L.pos.x + cx, -L.pos.z + cy, eyeLevel, L.room ?? -1);
      if (ok && pov && L.behind) ok = false;
      if (ok && L.z * S > CUT.uCutY.value) ok = false;
      if (ok && L.prio < 80 && cutHere(L.pos)) ok = false;
      const x = (tmp.x + 1) / 2 * w, y = (1 - tmp.y) / 2 * h;
      if (ok) {
        const r = { x0: x - 60, x1: x + 60, y0: y - 16, y1: y + 4 };
        if (shown.length >= 15 && L.prio < 99) ok = false;
        else if (shown.some((s) => !(r.x1 < s.x0 || r.x0 > s.x1 || r.y1 < s.y0 || r.y0 > s.y1))) ok = L.prio >= 99;   // the way's ends and the sign for the manoeuvre always show
        if (ok) shown.push(r);
      }
      if (ok !== L.vis) { L.vis = ok; L.el.style.display = ok ? '' : 'none'; }
      if (ok) {
        const tf = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
        if (tf !== L.tf) { L.tf = tf; L.el.style.transform = tf; }
      }
    }
  }
  /** First person: does a wall, a pillar or a shop of that floor stand between (ax, ay) and (bx, by)? The last 0.8 m before b
   *  do not count (a label on a wall), nor the walls of the room b stands in. */
  function wallBetween(ax: number, ay: number, bx: number, by: number, level: number, room: number) {
    const W = wallIndex.get(level);
    if (!W) return false;
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    if (L < 1) return false;
    const k = Math.max(0, (L - 0.8) / L), qx = ax + dx * k, qy = ay + dy * k;
    const seen = new Set<number>();
    for (let gx = Math.floor(Math.min(ax, qx) / WCELL); gx <= Math.floor(Math.max(ax, qx) / WCELL); gx++)
      for (let gy = Math.floor(Math.min(ay, qy) / WCELL); gy <= Math.floor(Math.max(ay, qy) / WCELL); gy++)
        for (const i of W.grid.get(gx + ',' + gy) || []) {
          if (seen.has(i) || (room >= 0 && W.owner[i] === room)) continue;
          seen.add(i);
          const [sx, sy, tx, ty] = W.segs[i];
          if (crosses(ax, ay, qx, qy, sx, sy, tx, ty)) return true;
        }
    return false;
  }
  const crosses = (ax: number, ay: number, bx: number, by: number, cx2: number, cy2: number, dx2: number, dy2: number) => {
    const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
    const d1 = o(cx2, cy2, dx2, dy2, ax, ay), d2 = o(cx2, cy2, dx2, dy2, bx, by), d3 = o(ax, ay, bx, by, cx2, cy2), d4 = o(ax, ay, bx, by, dx2, dy2);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  };
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
  /** First person: the background at street level and below ground (set by build). */
  const skyCol = new THREE.Color(), underCol = new THREE.Color();
  // the hologram's shimmer: a frame every GLOW_MS while the train shows and the page is seen (not every display
  // frame), and those frames leave the labels where they are
  const GLOW_MS = 70;
  let glowTimer = 0, glowTick = false;
  const frustum = new THREE.Frustum(), projScreen = new THREE.Matrix4();
  function request() { if (!pending && !disposed) { pending = true; raf = requestAnimationFrame(render); } }
  function render(now: number) {
    pending = false;
    const tick = glowTick;
    glowTick = false;
    if (anim) anim(now);
    if (playing) playFrame(now);
    const moving = pov && playing ? (camera.lookAt(controls.target), false) : controls.update();
    // depth precision: the near plane follows how far the camera is (no flicker between floors and what lies on them)
    const dist = camera.position.distanceTo(controls.target);
    const near = pov ? 0.15 : Math.min(1.5, Math.max(0.2, dist / 250)), far = pov ? FOG_FAR + 30 : dist + 2500;
    if (pov && scene.background instanceof THREE.Color && scene.fog instanceof THREE.Fog) {
      // below ground the distance is dark (a tunnel, a hall's far end), at street level it is the sky
      const z = (camera.position.y - EYE) / S, k = Math.max(0, Math.min(1, (0.8 - z) / 2.6));
      scene.background.copy(skyCol).lerp(underCol, k);
      scene.fog.color.copy(scene.background);
    }
    if (Math.abs(camera.near - near) > 0.05 || Math.abs(camera.far - far) > 200) { camera.near = near; camera.far = far; camera.updateProjectionMatrix(); }
    let glowing = false;
    if (trains.length || ambient.length) camera.updateMatrixWorld();
    if (trains.length || ambient.length) frustum.setFromProjectionMatrix(projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (const tr of trains.concat(ambient)) {
      // hidden when a floor below the platform is picked (everything above it is lifted away)
      tr.group.visible = CUT.uCutY.value > tr.y + 1;
      // the shimmer goes on only while a train is in view (each of its frames draws the whole station)
      glowing = glowing || (tr.group.visible && !stillMotion && document.visibilityState === 'visible' && frustum.intersectsBox(tr.box));
      holoTime.value = now / 1000;
      if (tr.zone) tr.zone.opacity = stillMotion ? 0.85 : 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(now / 380));
    }
    CUT.uEye.value.copy(camera.position);
    CUT.uFocus.value.copy(controls.target);
    CUT.uXR.value = !pov && ((mode.kind === 'step' && stepIdx >= 0) || playing || following) ? XRAY_R : 0;
    // what stays: everything up to 1.5 m over the floor in focus, and the whole of the step at hand (a stair's top)
    CUT.uXY.value = Math.max(controls.target.y, route && stepIdx >= 0 && !following ? stepTop(stepIdx) : -Infinity) + 1.5;
    renderer.render(scene, camera);
    if (!tick || anim || moving || labelsDirty || playing) placeLabels();
    if (anim || moving || playing) request();
    else if (glowing && !glowTimer) glowTimer = window.setTimeout(() => { glowTimer = 0; glowTick = true; request(); }, GLOW_MS);
  }
  // back from another tab or app: the shimmer goes on
  const onVisible = () => { if (document.visibilityState === 'visible') request(); };
  document.addEventListener('visibilitychange', onVisible);
  controls.addEventListener('change', request);
  // a drag or a pinch takes the camera: the play-through pauses, following stops, the step stays as it is
  controls.addEventListener('start', () => {
    manualAt = performance.now();
    anim = null;
    if (isPlaying()) pause();
    if (following) follow(false);
  });
  let viewW = 1, viewH = 1;
  function resize() {
    const w = mount.clientWidth || window.innerWidth, h = mount.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    viewW = w; viewH = h;
    renderer.domElement.style.width = w + 'px'; renderer.domElement.style.height = h + 'px';
    camera.aspect = w / h; camera.updateProjectionMatrix();
    request();
  }
  const ro = new ResizeObserver(resize); ro.observe(mount);
  const mq = matchMedia('(prefers-color-scheme: dark)'); const onScheme = () => { build(); redrawTrains(); request(); };
  function redrawTrains() { for (const inp of trains.map((t) => t.input)) drawTrain(inp); syncAmbient(); }
  mq.addEventListener('change', onScheme);

  // ------------------------------------------------------------------ pucks: you, and the walker of the play-through
  // Drawn over everything (a position must never hide under a floor), flat, the size of a person's reach.
  function puck(fill: number, ring: number, arrow: number | null) {
    const g = new THREE.Group();
    const top = (m: THREE.Material) => { m.depthTest = false; m.depthWrite = false; m.transparent = true; return m; };
    const parts: [THREE.BufferGeometry, THREE.Material][] = [
      [new THREE.CircleGeometry(1.45, 28), top(new THREE.MeshBasicMaterial({ color: ring }))],
      [new THREE.CircleGeometry(1.05, 28), top(new THREE.MeshBasicMaterial({ color: fill }))],
    ];
    if (arrow != null) {
      const a = new THREE.BufferGeometry();
      a.setAttribute('position', new THREE.Float32BufferAttribute([3.1, 0, 0, 1.2, 0, 1.25, 1.2, 0, -1.25], 3));
      parts.unshift([a, top(new THREE.MeshBasicMaterial({ color: arrow, side: THREE.DoubleSide, opacity: 0.9, forceSinglePass: true }))]);
    }
    parts.forEach(([geo, m], k) => {
      if (geo.type === 'CircleGeometry') geo.rotateX(-Math.PI / 2);
      const o = new THREE.Mesh(geo, m);
      o.position.y = 0.05 * k;
      o.renderOrder = 12 + k;
      g.add(o);
    });
    return g;
  }

  // ------------------------------------------------------------------ where you are (the indoor position)
  // setUser() takes what the app knows (GPS, or the indoor filter of indoornav.ts) and shows it as a blue puck. On
  // the way, it also says which step you are at: the step's card and the sign of the manoeuvre ahead change as you
  // walk, without moving the camera (follow(true) does that). A step changes only after two fixes on it, or 3 m
  // into it, and never within MANUAL_MS of you stepping through the way yourself.
  interface SolidUserIn { ll?: LngLat; xy?: XY; level?: number | null; accuracy?: number; heading?: number | null;
    levelProbs?: Record<string, number>; levelProb?: number; levelSure?: boolean }
  const MANUAL_MS = 20e3, ON_WAY_M = 25, MAX_ACC = 40;
  let user: SolidUserState = { visible: false, follow: false };
  let you: THREE.Group | null = null, accDisc: THREE.Mesh | null = null, youAt: THREE.Vector3 | null = null;
  let snapPrev: StationRouteSnap | null = null, onWayAt = 0, cand = -1, candN = 0, manualAt = -Infinity, following = false;
  /** Metres along the way of the walker or of you, while one of them is on it (null: neither). */
  let here: number | null = null;
  let lastFix: SolidUserIn | null = null;
  function setUser(u: SolidUserIn | null | undefined) {
    const now = performance.now();
    lastFix = u || null;
    if (!u || (!u.xy && !u.ll)) { user = { visible: false, follow: following }; youAt = null; if (you) you.visible = false; here = playing ? here : null; refreshBeacon(); tellUser(); request(); return; }
    const xy = u.xy || SR.toLocal(model!, u.ll!);
    const acc = Math.max(1, u.accuracy != null && isFinite(u.accuracy) ? u.accuracy : 25);
    const bx = Math.max(b[0] - xy[0], 0, xy[0] - b[2]), by = Math.max(b[1] - xy[1], 0, xy[1] - b[3]);
    if (Math.hypot(bx, by) > 150) {
      user = { visible: false, outside: true, far: Math.hypot(xy[0] - cx, xy[1] - cy), follow: following };
      youAt = null; if (you) you.visible = false; here = playing ? here : null; refreshBeacon(); tellUser(); request(); return;
    }
    let sn: StationRouteSnap | null = null;
    if (route && !route.same) {
      const hint = { ...(snapPrev ? { along: snapPrev.along, index: snapPrev.index, t: snapPrev.t, progress: snapPrev.progress } : {}),
        ...(u.levelSure && u.level != null ? { level: u.level } : {}) };
      sn = SR.snap(model!, route, xy, hint);
    }
    const sameFloor = !sn || !(u.levelSure && u.level != null) || Math.abs(sn.point[2] - u.level) < 0.6
      || (route!.steps[sn.step] && route!.steps[sn.step].kind !== 'walk' && route!.steps[sn.step].kind !== 'arrive');
    const onWay = !!sn && sameFloor && acc <= MAX_ACC && sn.dist <= Math.max(10, Math.min(acc, ON_WAY_M));
    const level = u.level != null ? u.level : onWay ? sn!.point[2] : user.level != null ? user.level : route && stepIdx >= 0 ? route.steps[stepIdx].level : 0;
    if (onWay) { snapPrev = sn; onWayAt = now; if (!playing) here = sn!.along; }
    else if (!playing) here = null;
    // the step you are at, once it is clear
    if (onWay && !isPlaying() && now - manualAt > MANUAL_MS) {
      const st = sn!.step;
      if (st !== stepIdx) {
        candN = st === cand ? candN + 1 : 1; cand = st;
        const into = sn!.along - route!.dists[route!.steps[st].from];
        if (candN >= 2 || (st > stepIdx && into > 3)) cue(st);
      } else candN = 0;
    }
    user = { visible: true, x: xy[0], y: xy[1], level: u.level != null ? u.level : null, levelProb: u.levelProb ?? null, levelProbs: u.levelProbs || null,
      sure: !!u.levelSure, acc, mode: onWay ? 'route' : 'free', step: onWay ? sn!.step : undefined,
      offRouteSec: onWay || !onWayAt ? 0 : Math.round((now - onWayAt) / 1000), follow: following };
    if (!you) {
      you = puck(0x0a84ff, 0xffffff, 0x0a84ff);
      accDisc = new THREE.Mesh(new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x0a84ff, transparent: true, opacity: 0.13, depthWrite: false }));
      accDisc.renderOrder = 9;
      you.add(accDisc);
      scene.add(you);
    }
    youAt = V(xy[0], xy[1], zOf(level)).setY(zOf(level) * S + 0.3);
    you.position.copy(youAt);
    you.visible = true;
    accDisc!.scale.setScalar(Math.min(acc, 60));
    // the arrow only with a heading (compass bearing: 0 = north = −z)
    const arrow = you.children[0];
    arrow.visible = u.heading != null && isFinite(u.heading);
    if (arrow.visible) you.rotation.y = Math.PI / 2 - u.heading! * Math.PI / 180;
    if (following) followCam();
    refreshBeacon();
    tellUser();
    request();
  }
  function tellUser() { if (opts.onUser) opts.onUser(user); }
  /** Shows step i as the one at hand (from your position or the play-through): the card, the sign and the cut follow,
   *  the camera stays where it is. */
  function cue(i: number) {
    if (!route) return;
    stepIdx = i; mode = { kind: 'step' }; cand = -1; candN = 0;
    const s = route.steps[i], all = routePoints();
    // the play-through's camera looks down at the walker from behind: a wider cut keeps the floors above out of its way
    if (pov) noCut();   // from inside, the floors above are the ceilings
    else cutAlong(all.slice(Math.max(0, s.from - 3), Math.min(all.length, s.to + 4)), playing ? PLAY_CUT_R : CUT_R);
    drawActive();
    labelsDirty = true; request(); changed();
  }
  function followCam() {
    if (!youAt) return;
    // keep how the camera looks at it, between 40 and 110 m off (from above and behind when there is no view yet)
    const off = new THREE.Vector3().subVectors(camera.position, controls.target);
    if (off.length() < 1 || off.y < 5) off.set(-0.45, 0.8, 0.4);
    off.setLength(Math.min(110, Math.max(40, off.length())));
    flyTo(youAt.clone().add(off), youAt.clone());
  }
  function follow(on: boolean) {
    if (on && pov) setPov(false);   // following looks down at you, not from your eyes
    if (on && isPlaying()) pause();
    following = !!on;
    user = { ...user, follow: following };
    if (following) followCam();
    tellUser(); request();
  }
  function locate() {
    if (!youAt) return;
    if (pov) setPov(false);
    if (isPlaying()) pause();
    const off = new THREE.Vector3().subVectors(camera.position, controls.target);
    if (off.length() < 1 || off.y < 5) off.set(-0.45, 0.8, 0.4);
    off.setLength(80);
    flyTo(youAt.clone().add(off), youAt.clone());
  }

  // ------------------------------------------------------------------ the play-through
  // A walker goes the way at about PLAY_SPEED times walking pace, on a timeline made of the steps' own seconds (a lift
  // ride is 0 m of the way but takes its time), and the camera follows behind it. The card and the sign change as it
  // reaches each step. Dragging the view pauses it. With reduced motion, it goes step by step instead.
  const PLAY_SPEED = 6;
  interface PlayPiece { i: number; t0: number; t1: number; idx: number[]; cum: number[]; conn: boolean }
  let playing = false, playT = 0, playLast = 0, playEnd = 0, timeline: PlayPiece[] = [], walker: THREE.Group | null = null;
  let heading = 0, labelTick = 0, stepper = 0, cueNext = false;
  const isPlaying = () => playing || !!stepper;
  function buildTimeline() {
    timeline = [];
    if (!route) return;
    let t = 0;
    route.steps.forEach((s, i) => {
      if (s.kind === 'arrive' || s.to <= s.from) return;
      const conn = s.kind !== 'walk';
      const d = pov ? Math.min(conn ? 14 : 30, Math.max(conn ? 3 : 1.5, (s.seconds || 0) / POV_SPEED))
        : Math.min(conn ? 5 : 9, Math.max(conn ? 2.5 : 1.2, (s.seconds || 0) / PLAY_SPEED));
      const idx = [s.from], cum = [0];
      for (let k = s.from + 1; k <= s.to; k++) {
        const p = route!.points[k - 1], q = route!.points[k];
        idx.push(k);
        cum.push(cum[cum.length - 1] + Math.hypot(q[0] - p[0], q[1] - p[1], zOf(q[2]) - zOf(p[2])));
      }
      timeline.push({ i, t0: t, t1: t + d, idx, cum, conn });
      t += d;
    });
    playEnd = t;
  }
  function poseAt(t: number) {
    const pc = timeline.find((x) => t < x.t1) || timeline[timeline.length - 1];
    let f = Math.max(0, Math.min(1, (t - pc.t0) / Math.max(1e-6, pc.t1 - pc.t0)));
    if (pc.conn) f = f * f * (3 - 2 * f);   // a lift or an escalator starts and stops gently
    const L = pc.cum[pc.cum.length - 1] * f;
    let k = 0;
    while (k + 2 < pc.cum.length && pc.cum[k + 1] < L) k++;
    const seg = pc.cum[k + 1] - pc.cum[k], u = seg > 0 ? Math.max(0, Math.min(1, (L - pc.cum[k]) / seg)) : 1;
    const a = route!.points[pc.idx[k]], q = route!.points[pc.idx[Math.min(k + 1, pc.idx.length - 1)]];
    const lv = a[2] + (q[2] - a[2]) * u;
    const p = V(a[0] + (q[0] - a[0]) * u, a[1] + (q[1] - a[1]) * u, zOf(lv)).setY(zOf(lv) * S + ROUTE_Y);
    const da = route!.dists[pc.idx[k]], db = route!.dists[pc.idx[Math.min(k + 1, pc.idx.length - 1)]];
    const flat = Math.hypot(q[0] - a[0], q[1] - a[1]);
    // the way it faces: along the piece (world: x east, −z north); none in a lift shaft
    const dir = flat > 0.3 ? Math.atan2(-(q[1] - a[1]), q[0] - a[0]) : null;
    return { p, i: pc.i, along: da + (db - da) * u, dir };
  }
  function play() {
    if (!route || route.same || isPlaying()) return;
    manualAt = performance.now();
    if (following) follow(false);
    if (stillMotion) {
      // reduced motion: the steps one after the other, each framed as Next › would
      const go = () => {
        if (!route || stepIdx >= route.steps.length - 1) { pause(); return; }
        if (pov) povJump(stepIdx + 1); else step(stepIdx + 1);
      };
      stepper = window.setInterval(go, 3500);
      if (stepIdx < 0 || stepIdx >= route.steps.length - 1) { if (pov) povJump(0); else step(0); } else changed();
      return;
    }
    buildTimeline();
    if (!timeline.length) return;
    // from the step shown (or the start), unless the last run stopped in the middle of it
    const pc = timeline.find((x) => x.i === stepIdx);
    const resumed = playT > 0 && playT < playEnd && !!pc && playT >= pc.t0 && playT < pc.t1;
    if (!resumed) playT = pc ? pc.t0 : 0;
    playing = true; playLast = performance.now();
    cueNext = true;   // the first frame shows the step it is in
    if (pov) {
      if (resumed) camera.getWorldDirection(povDir); else aimAlong(timeline.find((x) => x.i === poseAt(playT).i)!.idx[0]);
      controls.enabled = false; anim = null; request(); return;
    }
    if (!walker) { walker = puck(ROUTE, ROUTE_CASE, ROUTE_CASE); scene.add(walker); }
    walker.visible = true;
    const p0 = poseAt(playT);
    heading = p0.dir != null ? p0.dir : heading;
    // the camera starts behind the walker
    flyTo(chasePos(p0.p, heading), p0.p.clone());
    request();
  }
  function pause() {
    if (stepper) { clearInterval(stepper); stepper = 0; }
    controls.enabled = true;
    liftHide();
    if (!playing) { changed(); return; }
    playing = false;
    if (pov) lookFrom(camera.position.clone());   // paused: drag to look round
    changed(); request();
  }
  const CHASE_D = 80, CHASE_E = 56 * Math.PI / 180, PLAY_CUT_R = 30;
  function chasePos(p: THREE.Vector3, h: number) {
    return new THREE.Vector3(p.x - Math.cos(h) * CHASE_D * Math.cos(CHASE_E), p.y + CHASE_D * Math.sin(CHASE_E), p.z - Math.sin(h) * CHASE_D * Math.cos(CHASE_E));
  }
  function playFrame(now: number) {
    const dt = Math.max(0, Math.min(0.1, (now - playLast) / 1000));
    playLast = now;
    playT += dt;
    const done = playT >= playEnd;
    if (done) playT = playEnd;
    const pose = poseAt(playT);
    here = pose.along;
    if (pose.dir != null) { let d = pose.dir - heading; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; heading += d * Math.min(1, dt * 3.5); }
    if (pose.i !== stepIdx || cueNext) { cueNext = false; cue(pose.i); }
    else if (now - labelTick > 400) { labelTick = now; refreshBeacon(); }   // "In 30 m"
    if (pov) {
      povLook(eyeAt(walkPos(pose), dt), pose.along, pose.dir == null, dt);
      const st = route!.steps[pose.i];
      if (st && st.kind === 'elevator') liftShow(st, levelOfZ((pose.p.y - ROUTE_Y) / S));
      else liftHide();
    } else {
      const wp = walkPos(pose);
      walker!.position.copy(wp).setY(wp.y - ROUTE_Y + 0.3);
      walker!.rotation.y = -heading;
    }
    if (!pov && !anim) {
      const k = 1 - Math.exp(-dt * 2.5), wp = walkPos(pose);
      controls.target.lerp(wp, k);
      camera.position.lerp(chasePos(wp, heading), k);
    }
    if (done) {
      playing = false; playT = 0;
      if (walker) walker.visible = false;
      here = null;
      if (pov) { liftHide(); controls.enabled = true; alongPlatform(); lookFrom(camera.position.clone()); cue(route!.steps.length - 1); }
      else step(route!.steps.length - 1);   // there: the end of the way, framed
    }
  }

  // ------------------------------------------------------------------ first person
  // The play-through at eye height (1.65 m) and true heights: the floors above are ceilings (no cut, no see-through
  // hole), fog hides what is far, the edges of the floors stand as schematic walls, and the way is a line on the floor.
  // The eye goes along the way on the same timeline (slower), looking where the way goes 7 m ahead (2.5 m on stairs and
  // escalators, so the view looks down an escalator), pitch at most 20°; in a lift it keeps looking the way it did.
  // Paused, a drag looks round (the camera turns about a point just in front of the eye); ‹ › jump to a step's start.
  /** m: the eye and the line on the floor keep this far off walls, pillars and shops (the same, so the eye stays over the line). */
  const CLEAR_M = 0.65;
  const EYE = 1.65, POV_SPEED = 3.5, MAX_PITCH = Math.tan(20 * Math.PI / 180), FOG_FAR = 110;
  let pov = false, povS = 2.2, stale = false;   // stale: built for first person, not rebuilt since
  const povDir = new THREE.Vector3(1, 0, 0);
  function setPov(on: boolean) {
    if (on === pov || (on && (!route || route.same))) return;
    halt();
    if (on) {
      pov = true;
      povS = S; S = 1;
      scene.fog = new THREE.Fog(pal().bg, 16, FOG_FAR);
      Object.assign(controls, { minDistance: 0.01, maxDistance: 1e4, maxPolarAngle: Math.PI * 0.95, minPolarAngle: Math.PI * 0.05, enablePan: false, enableZoom: false });
    } else leavePov();
    build(); redrawTrains(); replayFix();
    labelsDirty = true;
    if (on) { buildTimeline(); povJump(Math.max(0, Math.min(stepIdx, route!.steps.length - 1))); }
    else if (stepIdx >= 0) step(stepIdx); else whole();
    request();
  }
  /** Back to the model: the stretch, no fog, the orbit's limits, the camera well above where it looked (the fly out
   *  starts there). The caller builds and frames. */
  function leavePov() {
    if (!pov) return;
    pov = false;
    S = povS;
    scene.fog = null;
    liftHide();
    Object.assign(controls, { minDistance: 15, maxDistance: 1600, maxPolarAngle: Math.PI * 0.49, minPolarAngle: 0, enablePan: true, enableZoom: true, enabled: true });
    settle();
    camera.position.copy(controls.target).add(new THREE.Vector3(-0.45, 0.8, 0.4).setLength(40));
    stale = true;
  }
  /** First person: stand where step i starts, looking along it. */
  function povJump(i: number) {
    if (!route) return;
    const st = route.steps[i], [x0, y0, l0] = route.points[st.from];
    const q = (st.kind === 'walk' || st.kind === 'arrive') && smoothAt(route.dists[st.from]);
    const [x, y, l] = q || [x0, y0, l0];
    const eye = eyeAt(V(x, y, zOf(l)).setY(zOf(l) * S + ROUTE_Y));
    // look along the way: the first point ahead that is not straight up or down (a lift) — this step's or a later one
    aimAlong(st.from);
    const pc = timeline.find((t) => t.i === i);
    playT = pc ? pc.t0 : 0;
    if (st.kind === 'elevator' && stepper) liftShow(st, Math.round(st.level)); else liftHide();
    lookFrom(eye);
    cue(i);
  }
  /** Drops what OrbitControls still had to turn or pan (its damping), so it cannot move a camera put in place. */
  function settle() { controls.enableDamping = false; controls.update(); controls.enableDamping = true; }
  /** Look along the way from point k: to the first point ahead that is not straight up or down (a lift); at the end, along
   *  the platform. */
  function aimAlong(k0: number) {
    const [x, y] = route!.points[k0];
    for (let k = k0 + 1; k < route!.points.length; k++) {
      const [x2, y2] = route!.points[k];
      if (Math.hypot(x2 - x, y2 - y) > 1) { povDir.set(x2 - x, 0, -(y2 - y)).normalize(); return; }
    }
    alongPlatform();
  }
  /** The eye over a point of the way (world, at ROUTE_Y; on a walk the smoothed way, already off the walls). */
  function eyeAt(p: THREE.Vector3, _dt?: number) {
    return new THREE.Vector3(p.x, p.y - ROUTE_Y + EYE, p.z);
  }
  function lookFrom(eye: THREE.Vector3) {
    settle();
    camera.position.copy(eye);
    controls.target.copy(eye).addScaledVector(povDir, 0.6);
    anim = null; request();
  }
  function povLook(eye: THREE.Vector3, along: number, inLift: boolean, dt: number) {
    const L = route!.steps[stepIdx] && route!.steps[stepIdx].kind !== 'walk' ? 2.5 : 7;
    const a = inLift ? null : smoothAt(along + L) || SR.pointAt(route!, along + L);
    if (a) {
      const want = V(a[0], a[1], zOf(a[2])).setY(zOf(a[2]) * S + EYE).sub(eye);
      const h = Math.hypot(want.x, want.z);
      if (h > 0.5) {
        // turn by yaw and pitch (a lerp of the vectors would never turn round when the way doubles back)
        const k = 1 - Math.exp(-dt * 3.5);
        const yaw0 = Math.atan2(povDir.z, povDir.x), pitch0 = Math.asin(Math.max(-1, Math.min(1, povDir.y)));
        let dy = Math.atan2(want.z, want.x) - yaw0;
        while (dy > Math.PI) dy -= 2 * Math.PI;
        while (dy <= -Math.PI) dy += 2 * Math.PI;
        const pitch1 = Math.max(-Math.atan(MAX_PITCH), Math.min(Math.atan(MAX_PITCH), Math.atan2(want.y, h)));
        const yaw = yaw0 + dy * k, pitch = pitch0 + (pitch1 - pitch0) * k;
        povDir.set(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw));
      }
    }
    camera.position.copy(eye);
    controls.target.copy(eye).addScaledVector(povDir, 0.6);
  }
  /** At the end of the way: look along the nearest track on its floor (out of a lift you would face its doors). */
  function alongPlatform() {
    const [x, y, l] = route!.points[route!.points.length - 1], z = zOf(l);
    let best = Infinity, dx = 0, dy = 0;
    for (const t of solid!.tracks) {
      if (Math.abs(t.z - z) > 2) continue;
      for (let k = 0; k + 1 < t.line.length; k++) {
        const [ax, ay] = t.line[k], [bx, by] = t.line[k + 1], ex = bx - ax, ey = by - ay;
        const u = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / Math.max(ex * ex + ey * ey, 1e-6)));
        const d = Math.hypot(x - ax - ex * u, y - ay - ey * u);
        if (d < best) { best = d; dx = ex; dy = ey; }
      }
    }
    if (best > 25 || !(dx || dy)) return;
    const along = new THREE.Vector3(dx, 0, -dy).normalize();
    if (along.dot(povDir) < 0) along.negate();
    povDir.copy(along);
  }
  function liftShow(st: StationRouteStep, now: number) {
    const arrow = arrowOf(st) || '↕';
    const html = `<div class="sx-lift-car"><div class="sx-lift-arrow">${arrow}</div><div class="sx-lift-now">${escHtml(levelTag(now))}</div>`
      + `<div class="sx-lift-to">Lift to <b>${escHtml(levelName(st.toLevel))}</b></div></div>`;
    if (liftEl.innerHTML !== html) liftEl.innerHTML = html;
    liftEl.hidden = false;
  }
  function liftHide() { if (!liftEl.hidden) liftEl.hidden = true; }
  function replayFix() { if (lastFix) { const f = lastFix, c = cand, n = candN; setUser(f); cand = c; candN = n; } }

  // ------------------------------------------------------------------ views
  function whole() {
    stepIdx = -1; mode = { kind: 'whole' };
    drawActive();
    if (route) { const pts = routePoints(); cutAlong(pts); frame(pts.concat(trainFrame()), { elev: 34, pad: 1.1 }); }
    else { noCut(); overview(); }
    labelsDirty = true; request(); changed();
  }
  function step(i: number) {
    if (!route) return;
    stepIdx = Math.max(0, Math.min(route.steps.length - 1, i));
    mode = { kind: 'step' };
    drawActive();
    const s = route.steps[stepIdx];
    const all = routePoints();
    // the step, with a little of what comes before and after it; a stair, escalator or ramp on its own, close up
    const conn = s.kind !== 'walk' && s.kind !== 'arrive' && s.kind !== 'elevator';
    const pts = conn ? all.slice(s.from, s.to + 1) : all.slice(Math.max(0, s.from - 1), Math.min(all.length, s.to + 2));
    cutAlong(all.slice(Math.max(0, s.from - 3), Math.min(all.length, s.to + 4)));
    frame(pts.length > 1 ? pts : all, { elev: s.kind === 'walk' ? 45 : conn ? 40 : 30, pad: conn ? 0.9 : 1.3 });
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
    stepIdx = -1; drawActive(); labelsDirty = true; request(); changed();
  }
  function overview() {
    const pts = solid!.slabs.flatMap((s) => s.rings[0].map(([x, y]) => V(x, y, s.z)));
    frame(pts, { elev: 32, yaw: 30, pad: 0.8 });
  }
  /** You took over (a button, a floor): the play-through stops, and your position does not move the step for a while. */
  function halt() {
    manualAt = performance.now();
    liftHide();
    controls.enabled = true;
    if (following) follow(false);
    playing = false; playT = 0;
    if (stepper) { clearInterval(stepper); stepper = 0; }
    if (walker && walker.visible) { walker.visible = false; here = snapPrev && user.mode === 'route' ? snapPrev.along : null; }
  }
  function changed() { if (opts.onChange) opts.onChange({ route, step: stepIdx, focusLevel: stepIdx < 0 && mode.kind === 'floor' ? mode.id : null, playing: isPlaying(), pov }); }

  // ------------------------------------------------------------------ first person's shaders, ahead of time
  // Entering first person needs some twenty shader programs at once: compiled then, they stop the view for a third of a
  // second here, longer on a phone. So they are compiled while the view is idle: a tiny scene with one mesh per kind of
  // first-person material, under first person's lights and fog. three.js keeps a program while a material uses it, so
  // these materials live as long as the view; the build then finds its programs made.
  let warmMats: THREE.Material[] = [], warmGeo: THREE.BufferGeometry | null = null, warmTimer = 0;
  function prewarm() {
    warmTimer = 0;
    if (warmMats.length || disposed || !route || route.same) return;
    const P = pal(), S2 = surfaces(), sc = new THREE.Scene();
    sc.fog = new THREE.Fog(P.bg, 16, FOG_FAR);
    sc.add(new THREE.HemisphereLight(0xffffff, 0xd6d0c6, 2.3), new THREE.DirectionalLight(0xffffff, 0.55));
    const holes: Holes = { holes: Array.from({ length: HOLES }, () => new THREE.Vector4()), r2: new Array(HOLES).fill(0), n: 1, box: new THREE.Vector4() };
    const glass = { color: P.glass, transparent: true, opacity: 0.2, depthWrite: false };
    warmMats = [
      holed(new THREE.MeshLambertMaterial({ color: P.povFloor, map: S2.floor }), holes, ''),
      holed(ceilingMat(P), holes, ''), ceilingMat(P),
      new THREE.MeshLambertMaterial({ color: P.povWall, map: S2.wall, side: THREE.DoubleSide }),
      new THREE.MeshLambertMaterial({ map: S2.shop.shop.map, emissive: 0xffffff, emissiveMap: S2.shop.shop.glow, side: THREE.DoubleSide }),
      new THREE.MeshLambertMaterial({ color: P.povCeil }), new THREE.MeshLambertMaterial({ color: P.povWall, side: THREE.DoubleSide }),
      new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      new THREE.MeshLambertMaterial({ color: ESC_UP, map: textures.chevron, side: THREE.DoubleSide }),
      new THREE.MeshLambertMaterial({ ...glass, side: THREE.DoubleSide, forceSinglePass: true }), new THREE.MeshLambertMaterial({ ...glass }),
      new THREE.MeshBasicMaterial({ color: ROUTE, side: THREE.DoubleSide }), new THREE.MeshBasicMaterial({ color: ROUTE }),
      new THREE.LineBasicMaterial({ color: P.glassEdge, transparent: true, opacity: 0.7 }),
      holoMaterial(HOLO, S2.floor, !dark()),
    ];
    warmGeo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    warmGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Array(warmGeo.getAttribute('position').count * 3).fill(1), 3));
    for (const m of warmMats) sc.add(m instanceof THREE.LineBasicMaterial ? new THREE.LineSegments(warmGeo, m) : new THREE.Mesh(warmGeo, m));
    // the instanced ones: arrowheads on the line, pins (with a colour each)
    const arrows = new THREE.InstancedMesh(warmGeo, warmMats[11], 1), pins = new THREE.InstancedMesh(warmGeo, warmMats[5], 1);
    pins.setColorAt(0, new THREE.Color(1, 1, 1));
    sc.add(arrows, pins);
    renderer.compile(sc, camera);
  }
  /** Once the view is still (or after 2 s), first person's shaders. */
  function prewarmSoon() {
    if (warmMats.length || warmTimer) return;
    const idle = (window as Window & { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    warmTimer = idle ? idle(prewarm, { timeout: 2000 }) : window.setTimeout(prewarm, 1500);
  }

  // ------------------------------------------------------------------ start
  if (opts.from && opts.to) plan(opts.from, opts.to, opts.prefs, true);
  build();
  resize();
  whole();
  prewarmSoon();

  return {
    model, solid, levels,
    get route() { return route; },
    plan: (from: SolidEnd, to: SolidEnd, p?: StationRoutePrefs | null) => { prewarmSoon(); const wasPov = pov; if (pov) { const tr = trains.map((t) => t.input); leavePov(); tr.forEach((t) => drawTrain(t)); } halt(); snapPrev = null; plan(from, to, p); if (wasPov) replayFix(); whole(); return route; },
    step: (i: number) => { halt(); if (pov && route) povJump(Math.max(0, Math.min(route.steps.length - 1, i))); else step(i); },
    whole: () => { setPov(false); halt(); whole(); }, floor: (id: number | null) => { setPov(false); halt(); floor(id); },
    next: () => { halt(); if (pov && route) povJump(Math.min(route.steps.length - 1, stepIdx + 1)); else step(stepIdx + 1); },
    prev: () => { halt(); if (pov && route) { if (stepIdx > 0) povJump(stepIdx - 1); else setPov(false); } else step(stepIdx - 1); },
    /** First person: the play-through at eye height (true heights, ceilings, schematic walls). */
    pov: (on: boolean) => setPov(!!on), get povOn() { return pov; },
    /** The play-through: a walker goes the way and the camera follows it, step by step. */
    play, pause, get playing() { return isPlaying(); },
    /** Your position (Station3D.setUser): a puck, and on the way the step you are at. */
    setUser, get user() { return user; }, follow, locate,
    /** true: the whole station; false: only the part the route uses (the default). */
    showAll: (on: boolean) => { showAll = !!on; setFocus(); build(); labelsDirty = true; if (pov) { noCut(); request(); return; } if (mode.kind === 'floor') floor(mode.id); else if (stepIdx >= 0) step(stepIdx); else whole(); },
    get focused() { return !!focus; },
    setStretch: (s: number) => { leavePov(); halt(); S = s; build(); redrawTrains(); replayFix(); if (mode.kind === 'floor') floor(mode.id); else if (stepIdx >= 0) step(stepIdx); else whole(); },
    get stretch() { return S; },
    /** The train at the platform the way leads to (null: none). Returns where it was laid out (null: the model has
     *  no sectors at that platform, so nothing is drawn). */
    setTrain: (t: SolidTrainInput): TrainLayout | null => drawTrain(t),
    /** Takes the vehicle of that role away (all of them without one). */
    clearTrain: (role?: SolidTrainInput['role']) => { dropTrain(role); if (role) given.delete(role); else given.clear(); syncAmbient(); labelsDirty = true; if (route) drawRoute(); request(); },
    /** Seconds on foot from `from` to each of these sectors of platform `ref` (Infinity: no way there). */
    sectorWalks: (from: SolidEnd, uic: string, ref: string, names: string[], p?: StationRoutePrefs | null): Record<string, number> =>
      Object.fromEntries(names.map((n) => {
        const r = from ? SR.route(model!, from, { stop: { uic, ref, sector: n } }, Object.assign({}, p || {})) : null;
        // a sector the model does not have: the router would aim at the whole platform instead, so it does not count
        return [n, r && !r.incomplete && r.toSectors && r.toSectors.length ? r.seconds : Infinity];
      })),
    reset: () => { halt(); if (pov && route) povJump(Math.max(0, stepIdx)); else if (stepIdx >= 0) step(stepIdx); else whole(); },
    dispose: () => { disposed = true; playing = false; warmMats.forEach((m) => m.dispose()); if (warmGeo) warmGeo.dispose(); clearTimeout(occTimer); wallIndex.clear(); if (stepper) clearInterval(stepper); cancelAnimationFrame(raf); clearTimeout(glowTimer);
      for (const g of [activeGroup, you, walker]) if (g) freeGroup(g); document.removeEventListener('visibilitychange', onVisible); if (world) freeGroup(world); if (routeGroup) freeGroup(routeGroup); dropTrain(); dropAmbient();
      textures.chevron.dispose(); textures.stripe.dispose(); freeSurfaces(); ro.disconnect(); mq.removeEventListener('change', onScheme); controls.dispose(); renderer.dispose(); mount.removeChild(renderer.domElement); mount.removeChild(labelsEl); mount.removeChild(liftEl); },
    /** Tests: the camera on (x, y) of a level, from dist metres at elev degrees, from the compass bearing yaw. */
    _look: (x: number, y: number, level: number, dist = 40, elev = 35, yaw = 30) => {
      const t = V(x, y, zOf(level)), e = elev * Math.PI / 180, a = yaw * Math.PI / 180;
      camera.position.set(t.x - Math.sin(a) * dist * Math.cos(e), t.y + dist * Math.sin(e), t.z + Math.cos(a) * dist * Math.cos(e));
      controls.target.copy(t); anim = null; request();
    },
    /** Tests: the play-through (first person with pov) stopped t seconds in, as if played up to there. */
    _at: (t: number, inPov = true) => {
      if (!route || route.same) return null;
      halt();
      if (inPov !== pov) setPov(inPov);
      buildTimeline();
      if (!inPov) { if (!walker) { walker = puck(ROUTE, ROUTE_CASE, ROUTE_CASE); scene.add(walker); } walker.visible = true; }
      playing = true; cueNext = true; anim = null;
      let now = performance.now();
      playT = Math.max(0, Math.min(playEnd, t) - 2.5); playLast = now;
      heading = poseAt(playT).dir ?? heading;
      if (inPov) aimAlong(timeline.find((x) => x.i === poseAt(playT).i)!.idx[0]);
      while (playing && playT < t - 1e-6) { now += 50; playFrame(now); }
      if (playing) { playing = false; controls.enabled = true; if (pov) lookFrom(camera.position.clone()); }
      changed(); request();
      return { t: playT, end: playEnd, step: stepIdx };
    },
    /** Tests: a level's plan as first person builds it (walls with their openings, rooms, floors, the way). */
    _plan: (level: number) => ({
      walls: (wallIndex.get(level) || { segs: [] }).segs,
      rooms: solid!.rooms.filter((r) => r.level === level).map((r) => r.ring),
      slabs: solid!.slabs.filter((s) => s.level === level).map((s) => s.rings),
      av: av ? av.walls.filter((w) => w.level === level).map((w) => w.line) : [],
      route: route ? route.points.filter((p) => Math.round(p[2]) === level) : [],
      graph: model!.graph.edges.filter((e) => Math.round(model!.graph.nodes[e.a][2]) === level && Math.round(model!.graph.nodes[e.b][2]) === level).map((e) => [model!.graph.nodes[e.a], model!.graph.nodes[e.b]]),
      tunnel: tunnelSides.filter((t) => levelOfZ(t.z + 1.1) === level).map((t) => t.line),
      conns: solid!.connectors.flatMap((c) => c.kind !== 'elevator' && c.pts.some((p) => levelOfZ(p[2]) === level) ? [{ kind: c.kind, pts: c.pts, width: c.width }] : []),
    }),
    /** Tests and profiling: the three.js objects. */
    _three: () => ({ renderer, scene, camera, THREE }),
    _debug: () => ({ cut: CUT.uN.value, labels: labels.filter((l) => l.el.style.display !== 'none').map((l) => l.el.textContent), calls: renderer.info.render.calls, tris: renderer.info.render.triangles, mem: Object.assign({}, renderer.info.memory) }),
  };
}
