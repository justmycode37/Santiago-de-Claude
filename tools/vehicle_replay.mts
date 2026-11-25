// How the map's live vehicles move as drawn: a replay of an engine's /api/vehicles answers as the page gets them (one
// every 15 s, a little late, for the box around a view that is panned now and then), through the layout of the page
// (src/live-layout.ts: gliding, the way laid onto the base map's lines, the body and its carriages), 60 frames a second.
// Counts what should never happen to a drawn vehicle: going backwards, moving sideways off its way, leaps, speeding up
// or slowing down harder than any vehicle can (over 3.5 m/s², over a quarter of a second), stops of less than three
// seconds between driving on (stop and go), and two vehicles running alongside or after each other drawn over each
// other (one crossing the other at an angle is most often over or under it: a bridge, a tunnel).
//
//   node tools/vehicle_replay.mts [--engine URL] [--at lon,lat] [--minutes 10] [--layout path] [--tiles dir]
//   node tools/vehicle_replay.mts --engine http://127.0.0.1:8161 --at 7.4440,46.9480 --minutes 10
//
// --layout: another module with makeLayout() (the same interface), e.g. an older layout to compare with. --tiles:
// where the base map's tiles are kept between runs (else fetched every run).
import fs from 'node:fs';
import path from 'node:path';
import { KANTE_LIVE } from '../src/live.ts';
import { tileLines, tileOf } from '../src/vector-lines.ts';
import { DrawnLines, layRoad, railTunnels, RAIL_CLASSES, ROAD_CLASSES } from '../src/live-lines.ts';
import { VehicleLayout, mergeAnswer } from '../src/live-layout.ts';
import type { LayoutVehicle } from '../src/live-layout.ts';

const opt = (name: string, def: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const ENGINE = opt('--engine', 'http://127.0.0.1:8161');
const [CX, CY] = opt('--at', '7.4440,46.9480').split(',').map(Number);
const MINUTES = Number(opt('--minutes', '10'));
const LAYOUT = opt('--layout', '');
const TILES = opt('--tiles', '');
const FPS = 60, EVERY = 15, PAN_S = 90, PAN_M = Number(opt('--pan', '600'));
const SHOW = Number(opt('--show', '0')); // print this many events of each kind
const shownEv = new Map<string, number>();
const ev = (kind: string, text: string) => { const n = shownEv.get(kind) || 0; if (n < SHOW) { shownEv.set(kind, n + 1); console.log(`  [${kind}] ${text}`); } };
// a view of about 900 m by 900 m (a tablet at zoom 16): the vehicles drawn as bodies
const VIEW_W = 0.012, VIEW_H = 0.008;

const TILE_URL = 'https://vectortiles.geo.admin.ch/tiles/ch.swisstopo.base.vt/v1.0.0/14/{x}/{y}.pbf';
const tileBytes = new Map<string, Uint8Array>();
async function tile(x: number, y: number): Promise<Uint8Array> {
  const key = `${x}_${y}`;
  let b = tileBytes.get(key);
  if (b) return b;
  const file = TILES && path.join(TILES, `14_${key}.pbf`);
  if (file && fs.existsSync(file)) b = new Uint8Array(fs.readFileSync(file));
  else {
    const r = await fetch(TILE_URL.replace('{x}', String(x)).replace('{y}', String(y)));
    b = new Uint8Array(await r.arrayBuffer());
    if (file) fs.writeFileSync(file, b);
  }
  tileBytes.set(key, b);
  return b;
}
const tilesOf = (b: KanteBbox) => {
  const [x0, y1] = tileOf([b[0], b[1]], 14), [x1, y0] = tileOf([b[2], b[3]], 14), out: [number, number][] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([x, y]);
  return out;
};

type V = KanteVehicle;
export interface Drawn {
  k: string; mode: string; cars: [[number, number], [number, number]][];
  /** Per carriage in a tunnel: as drawn, and by the nearest drawn rail line running its way (how it was told before) */
  tunnel?: boolean[]; tunnelNearest?: boolean[];
}
export interface Layout {
  name: string;
  /** The base map's lines: the page's way of getting them. `get` gives a tile's bytes (z14). */
  lines(view: KanteBbox, box: KanteBbox, get: (x: number, y: number) => Promise<Uint8Array>): Promise<void>;
  answer(list: V[], t: number, atMs: number): void;
  frame(ms: number, view: KanteBbox): Drawn[];
}
// The page's layout (src/app/live-vehicles.ts does the same): the base map's tiles over the box asked for, buses laid
// onto its roads; the engine's clock; a vehicle an answer lacks kept for two answers
function pageLayout(): Layout {
  const roads = new DrawnLines(), rails = new DrawnLines(), L = new VehicleLayout<LayoutVehicle>(), clock = KANTE_LIVE.engineClock();
  let list: LayoutVehicle[] = [];
  KANTE_LIVE.setLineRefiner((pts) => layRoad(pts, roads));
  KANTE_LIVE.setTunneler((pts) => railTunnels(pts, rails));
  return {
    name: 'now',
    async lines(_view, box, get) {
      let added = false;
      for (const [x, y] of tilesOf(box)) {
        if (roads.tiles.has(`${x}/${y}`)) continue;
        const all = tileLines(await get(x, y), 14, x, y, 'transportation', new Set([...ROAD_CLASSES, ...RAIL_CLASSES]));
        roads.add(`${x}/${y}`, all.filter((l) => ROAD_CLASSES.has(l.cls)));
        rails.add(`${x}/${y}`, all.filter((l) => RAIL_CLASSES.has(l.cls)));
        added = true;
      }
      if (added) { KANTE_LIVE.linesCame(); KANTE_LIVE.relayLines(); }
    },
    answer(vs, t, atMs) {
      clock.answer(t, atMs);
      list = mergeAnswer(list, vs.map((v) => ({ ...v, t })));
      L.forget(new Set(list.map((v) => VehicleLayout.key(v))));
    },
    frame(ms, view) {
      const tNow = clock.now(ms), pad = 0.01;
      if (!Number.isFinite(tNow)) return [];
      L.step(list, tNow, ms);
      const w = view[2] - view[0], h = view[3] - view[1], within = (p: LngLat, m: number, n: number) => p[0] > view[0] - m && p[0] < view[2] + m && p[1] > view[1] - n && p[1] < view[3] + n;
      return L.place(list, ms, (p) => (within(p, pad, pad) ? true : within(p, w, h) ? 'near' : false))
        .filter((P) => P.cars).map((P) => ({ k: P.k, mode: String(P.v.line.mode), tunnel: P.tunnel,
          tunnelNearest: P.make.rail ? P.cars!.map(([a, b]) => rails.tunnelAt([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], a, b)) : undefined,
          cars: P.cars!.map(([a, b]) => [[a[0] * kx, a[1] * KY], [b[0] * kx, b[1] * KY]] as [[number, number], [number, number]]) }));
    },
  };
}
const layout = LAYOUT ? (await import('file://' + path.resolve(LAYOUT).replace(/\\/g, '/')) as { makeLayout: () => Layout }).makeLayout() : pageLayout();

// ---- the timeline: the view panned every PAN_S, the box asked for (as vehUpdate), answers every EVERY from each box
const T0 = Number(opt('--t0', String(Math.floor(Date.now() / 600000) * 600))), END = MINUTES * 60;
const kx = 111320 * Math.cos(CY * Math.PI / 180), KY = 110540;
const viewAt = (s: number): KanteBbox => {
  const k = Math.floor(s / PAN_S), dx = (k % 4 === 1 ? 1 : k % 4 === 3 ? -1 : 0) * PAN_M / kx, dy = (k % 4 === 2 ? 1 : 0) * PAN_M / KY;
  return [CX + dx - VIEW_W / 2, CY + dy - VIEW_H / 2, CX + dx + VIEW_W / 2, CY + dy + VIEW_H / 2];
};
interface Answer { at: number; t: number; list: V[] }
const answers: Answer[] = [];
let box: KanteBbox | null = null, boxFrom = 0;
const boxes: { at: number; view: KanteBbox; box: KanteBbox }[] = [];
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
for (let s = 0; s < END; s += 1) {
  const view = viewAt(s);
  if (!box || !KANTE_LIVE.bboxContains(box, view)) { box = KANTE_LIVE.padBbox(view, 0.35); boxFrom = s; boxes.push({ at: s, view, box }); }
  if ((s - boxFrom) % EVERY === 0) {
    // asked at a moment within the second; the engine answers for its whole second; it arrives 0.1–0.4 s later
    const real = T0 + s + rnd(), t = Math.floor(real);
    const res = await (await fetch(`${ENGINE}/api/vehicles?bbox=${KANTE_LIVE.bboxParam(box)}&t=${t}`)).json() as KanteVehiclesResponse;
    answers.push({ at: (real - T0 + 0.1 + 0.3 * rnd()) * 1000, t: res.t, list: res.vehicles });
  }
}
const pans = [...new Set(Array.from({ length: Math.ceil(END / PAN_S) }, (_, k) => k * PAN_S))];

// ---- frames
interface Track { m: [number, number]; backRun: number; sideRun: number; v: number[]; hard: boolean; stopAt: number; fast: boolean }
const tracks = new Map<string, Track>();
type Stat = { frames: number; back: number; backM: number; side: number; sideM: number; leaps: number; hard: number; stopGo: number; overlapS: number; overlaps: number };
const by = new Map<string, Stat>();
const stat = (mode: string) => by.get(mode) || by.set(mode, { frames: 0, back: 0, backM: 0, side: 0, sideM: 0, leaps: 0, hard: 0, stopGo: 0, overlapS: 0, overlaps: 0 }).get(mode)!;
const WIDTH: Record<string, number> = { tram: 2.4, bus: 2.55, ondemand: 2.55, rail: 2.9, metro: 2.7, rack: 2.65, funicular: 2.6 };
// Whether two carriages (from p to q, w wide) overlap by more than 10 cm: their rectangles, by separating axes
function carsOverlap(p1: number[], q1: number[], w1: number, p2: number[], q2: number[], w2: number) {
  const corners = (p: number[], q: number[], w: number) => {
    const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1, nx = (-dy / l) * (w / 2), ny = (dx / l) * (w / 2);
    return [[p[0] + nx, p[1] + ny], [q[0] + nx, q[1] + ny], [q[0] - nx, q[1] - ny], [p[0] - nx, p[1] - ny]];
  };
  const A = corners(p1, q1, w1), B = corners(p2, q2, w2);
  for (const R of [A, B]) for (let i = 0; i < 2; i++) {
    const ax = R[i + 1][0] - R[i][0], ay = R[i + 1][1] - R[i][1], l = Math.hypot(ax, ay) || 1, ux = ax / l, uy = ay / l;
    const proj = (P: number[][]) => P.map((c) => c[0] * ux + c[1] * uy);
    const a = proj(A), b = proj(B);
    if (Math.min(...a) > Math.max(...b) - 0.1 || Math.min(...b) > Math.max(...a) - 0.1) return false;
  }
  return true;
}
const overlapping = new Set<string>();
// tunnel flags per carriage: when each last changed, and whether it changed back within 5 s (a flicker)
const flags = new Map<string, { now: boolean[]; old: boolean[]; at: number[]; atOld: number[] }>();
let flick = 0, flickOld = 0, portal = 0, portalOld = 0;
function countFlags(d: Drawn, s: number) {
  if (!d.tunnel || !d.tunnelNearest) return;
  const f = flags.get(d.k) || flags.set(d.k, { now: d.tunnel.slice(), old: d.tunnelNearest.slice(), at: d.tunnel.map(() => -1e9), atOld: d.tunnel.map(() => -1e9) }).get(d.k)!;
  d.tunnel.forEach((x, j) => { if (x !== f.now[j]) { portal++; if (s - f.at[j] < 5) flick++; f.at[j] = s; f.now[j] = x; } });
  d.tunnelNearest.forEach((x, j) => { if (x !== f.old[j]) { portalOld++; if (s - f.atOld[j] < 5) flickOld++; f.atOld[j] = s; f.old[j] = x; } });
}
let cpu = 0, frames = 0, drawnMax = 0, ai = 0;
for (let f = 0; f < END * FPS; f++) {
  const ms = (f * 1000) / FPS, s = ms / 1000;
  if (pans.includes(Math.round(s * FPS) / FPS) || f === 0) {
    const b = [...boxes].reverse().find((x) => x.at <= s)!;
    await layout.lines(viewAt(s), b.box, tile);
  }
  while (ai < answers.length && answers[ai].at <= ms) { layout.answer(answers[ai].list, answers[ai].t, answers[ai].at); ai++; }
  const view = viewAt(s);
  const c0 = performance.now();
  const drawn = layout.frame(ms, view);
  cpu += performance.now() - c0;
  frames++;
  drawnMax = Math.max(drawnMax, drawn.length);
  const now = new Set<string>();
  for (const d of drawn) {
    // its middle carriage: where it is and which way it faces
    const [p, q] = d.cars[Math.floor(d.cars.length / 2)], m: [number, number] = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const hl = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (m[0] < view[0] * kx || m[0] > view[2] * kx || m[1] < view[1] * KY || m[1] > view[3] * KY) continue;
    now.add(d.k);
    countFlags(d, s);
    const tr = tracks.get(d.k), st = stat(d.mode);
    st.frames++;
    if (!tr || !hl) { tracks.set(d.k, { m, backRun: 0, sideRun: 0, v: [], hard: false, stopAt: -1, fast: false }); continue; }
    const h = [(q[0] - p[0]) / hl, (q[1] - p[1]) / hl], dm = [m[0] - tr.m[0], m[1] - tr.m[1]];
    const along = dm[0] * h[0] + dm[1] * h[1], side = Math.abs(-dm[0] * h[1] + dm[1] * h[0]), moved = Math.hypot(dm[0], dm[1]);
    tr.m = m;
    if (moved > 3) { st.leaps++; ev('leap', `${d.mode} ${d.k} at ${s.toFixed(2)} s: ${moved.toFixed(1)} m (along ${along.toFixed(1)}, across ${side.toFixed(1)})`); tr.backRun = tr.sideRun = 0; tr.v = []; continue; }
    // its speed, and how fast that changes over a tenth of a second
    const v = Math.max(0, along) * FPS;
    tr.v.push(v);
    if (tr.v.length > 16) tr.v.shift();
    if (tr.v.length === 16) {
      // over a quarter of a second, each end the mean of 4 frames (a carriage's middle on a bent way wavers a little)
      const a0 = (tr.v[0] + tr.v[1] + tr.v[2] + tr.v[3]) / 4, a1 = (tr.v[12] + tr.v[13] + tr.v[14] + tr.v[15]) / 4;
      const acc = (a1 - a0) / (12 / FPS), hard = Math.abs(acc) > 3.5;
      if (hard && !tr.hard) { st.hard++; ev('hard', `${d.mode} ${d.k} at ${s.toFixed(2)} s: ${acc.toFixed(1)} m/s² (${a0.toFixed(1)} → ${a1.toFixed(1)} m/s)`); }
      tr.hard = hard;
    }
    // stop and go: it stood less than 3 s between driving (over 2 m/s) before and after
    if (v > 2) {
      if (tr.stopAt >= 0 && tr.fast && s - tr.stopAt < 3) { st.stopGo++; ev('stopgo', `${d.mode} ${d.k} at ${s.toFixed(2)} s: stood ${(s - tr.stopAt).toFixed(1)} s`); }
      tr.stopAt = -1; tr.fast = true;
    } else if (v < 0.2 && tr.stopAt < 0 && tr.fast) tr.stopAt = s;
    // backwards: more than a centimetre against the way it faces in a frame, 30 cm or more in a row
    if (along < -0.01) tr.backRun -= along;
    else { if (tr.backRun >= 0.3) { st.back++; st.backM += tr.backRun; ev('back', `${d.mode} ${d.k} at ${s.toFixed(2)} s: ${tr.backRun.toFixed(2)} m`); } tr.backRun = 0; }
    // sideways: across the way it faces, more than a rigid carriage on a curve does (a third of its motion along)
    if (side > Math.max(0.03, 0.35 * Math.abs(along))) tr.sideRun += side;
    else { if (tr.sideRun >= 0.3) { st.side++; st.sideM += tr.sideRun; ev('side', `${d.mode} ${d.k} at ${s.toFixed(2)} s: ${tr.sideRun.toFixed(2)} m`); } tr.sideRun = 0; }
  }
  for (const k of tracks.keys()) if (!now.has(k)) tracks.delete(k);
  // two drawn over each other: any of their carriages nearer than half their widths together (20 cm spared)
  const shown = drawn.filter((d) => now.has(d.k)), still = new Set<string>();
  for (let a = 0; a < shown.length; a++) for (let b = a + 1; b < shown.length; b++) {
    const A = shown[a], B = shown[b], wa = WIDTH[A.mode] || 2.5, wb = WIDTH[B.mode] || 2.5;
    const [pa] = A.cars[0], [pb] = B.cars[0];
    if (Math.abs(pa[0] - pb[0]) > 400 || Math.abs(pa[1] - pb[1]) > 400) continue;
    let hit = false;
    for (const [p, q] of A.cars) {
      for (const [r2, t2] of B.cars) {
        const da = [q[0] - p[0], q[1] - p[1]], db = [t2[0] - r2[0], t2[1] - r2[1]];
        const cos = Math.abs(da[0] * db[0] + da[1] * db[1]) / ((Math.hypot(da[0], da[1]) * Math.hypot(db[0], db[1])) || 1);
        if (cos >= 0.7 && carsOverlap(p, q, wa, r2, t2, wb)) { hit = true; break; }
      }
      if (hit) break;
    }
    if (!hit) continue;
    const key = A.k < B.k ? A.k + ' ' + B.k : B.k + ' ' + A.k, st = stat(A.mode);
    still.add(key);
    st.overlapS += 1 / FPS;
    if (!overlapping.has(key)) { st.overlaps++; ev('overlap', `${A.mode}/${B.mode} ${key} at ${s.toFixed(2)} s`); }
  }
  overlapping.clear();
  for (const k of still) overlapping.add(k);
}
console.log(`${layout.name}: ${MINUTES} min from ${T0} at ${CX},${CY}, ${answers.length} answers, ${boxes.length} boxes; up to ${drawnMax} drawn; layout ${(cpu / frames).toFixed(2)} ms a frame`);
const row = (name: string, x: Stat) => {
  const vh = x.frames / FPS / 3600;
  console.log(`  ${name.padEnd(9)} ${vh.toFixed(1).padStart(5)} vehicle-h  backwards ${String(x.back).padStart(4)} (${x.backM.toFixed(1)} m)  sideways ${String(x.side).padStart(4)} (${x.sideM.toFixed(1)} m)  leaps ${String(x.leaps).padStart(3)}  hard ${String(x.hard).padStart(4)} (${(x.hard / vh).toFixed(1)}/vh)  stop-and-go ${String(x.stopGo).padStart(3)}  overlaps ${String(x.overlaps).padStart(3)} (${x.overlapS.toFixed(0)} s)`);
};
const all: Stat = { frames: 0, back: 0, backM: 0, side: 0, sideM: 0, leaps: 0, hard: 0, stopGo: 0, overlapS: 0, overlaps: 0 };
for (const [m, x] of [...by].sort()) { row(m, x); for (const k of Object.keys(all) as (keyof typeof all)[]) all[k] += x[k]; }
row('all', all);
if (portal || portalOld) console.log(`  tunnels (vehicles on rails): changes ${portal}, flickers (back within 5 s) ${flick}; told by the nearest drawn line running its way, as before: changes ${portalOld}, flickers ${flickOld}`);
export {};
