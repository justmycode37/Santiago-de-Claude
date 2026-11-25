// How the map's live vehicles move as drawn: a replay of an engine's /api/vehicles answers as the page gets them (one
// every 15 s, a little late, for the box around a view that is panned now and then), through the layout of the page
// (src/live-layout.ts: gliding, the way laid onto the base map's lines, the body and its carriages), 60 frames a second.
// Counts what should never happen to a drawn vehicle: going backwards, moving sideways off its way, and leaps.
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
import { DrawnLines, layRoad, ROAD_CLASSES } from '../src/live-lines.ts';
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
export interface Drawn { k: string; mode: string; cars: [[number, number], [number, number]][] }
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
  const roads = new DrawnLines(), L = new VehicleLayout<LayoutVehicle>(), clock = KANTE_LIVE.engineClock();
  let list: LayoutVehicle[] = [];
  KANTE_LIVE.setLineRefiner((pts) => layRoad(pts, roads));
  return {
    name: 'now',
    async lines(_view, box, get) {
      let added = false;
      for (const [x, y] of tilesOf(box)) {
        if (roads.tiles.has(`${x}/${y}`)) continue;
        roads.add(`${x}/${y}`, tileLines(await get(x, y), 14, x, y, 'transportation', ROAD_CLASSES));
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
      return L.place(list, ms, (p) => p[0] > view[0] - pad && p[0] < view[2] + pad && p[1] > view[1] - pad && p[1] < view[3] + pad)
        .filter((P) => P.cars).map((P) => ({ k: P.k, mode: String(P.v.line.mode),
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
interface Track { m: [number, number]; backRun: number; sideRun: number }
const tracks = new Map<string, Track>();
const by = new Map<string, { frames: number; back: number; backM: number; side: number; sideM: number; leaps: number }>();
const stat = (mode: string) => by.get(mode) || by.set(mode, { frames: 0, back: 0, backM: 0, side: 0, sideM: 0, leaps: 0 }).get(mode)!;
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
    const tr = tracks.get(d.k), st = stat(d.mode);
    st.frames++;
    if (!tr || !hl) { tracks.set(d.k, { m, backRun: 0, sideRun: 0 }); continue; }
    const h = [(q[0] - p[0]) / hl, (q[1] - p[1]) / hl], dm = [m[0] - tr.m[0], m[1] - tr.m[1]];
    const along = dm[0] * h[0] + dm[1] * h[1], side = Math.abs(-dm[0] * h[1] + dm[1] * h[0]), moved = Math.hypot(dm[0], dm[1]);
    tr.m = m;
    if (moved > 3) { st.leaps++; ev('leap', `${d.mode} ${d.k} at ${s.toFixed(2)} s: ${moved.toFixed(1)} m (along ${along.toFixed(1)}, across ${side.toFixed(1)})`); tr.backRun = tr.sideRun = 0; continue; }
    // backwards: more than a centimetre against the way it faces in a frame, 30 cm or more in a row
    if (along < -0.01) tr.backRun -= along;
    else { if (tr.backRun >= 0.3) { st.back++; st.backM += tr.backRun; ev('back', `${d.mode} ${d.k} at ${s.toFixed(2)} s: ${tr.backRun.toFixed(2)} m`); } tr.backRun = 0; }
    // sideways: across the way it faces, more than a rigid carriage on a curve does (a third of its motion along)
    if (side > Math.max(0.03, 0.35 * Math.abs(along))) tr.sideRun += side;
    else { if (tr.sideRun >= 0.3) { st.side++; st.sideM += tr.sideRun; ev('side', `${d.mode} ${d.k} at ${s.toFixed(2)} s: ${tr.sideRun.toFixed(2)} m`); } tr.sideRun = 0; }
  }
  for (const k of tracks.keys()) if (!now.has(k)) tracks.delete(k);
}
console.log(`${layout.name}: ${MINUTES} min from ${T0} at ${CX},${CY}, ${answers.length} answers, ${boxes.length} boxes; up to ${drawnMax} drawn; layout ${(cpu / frames).toFixed(2)} ms a frame`);
const row = (name: string, x: { frames: number; back: number; backM: number; side: number; sideM: number; leaps: number }) => {
  const vh = x.frames / FPS / 3600;
  console.log(`  ${name.padEnd(9)} ${vh.toFixed(1).padStart(5)} vehicle-h  backwards ${String(x.back).padStart(4)} (${(x.back / vh).toFixed(1)}/vh, ${x.backM.toFixed(1)} m)  sideways ${String(x.side).padStart(4)} (${(x.side / vh).toFixed(1)}/vh, ${x.sideM.toFixed(1)} m)  leaps ${x.leaps}`);
};
const all = { frames: 0, back: 0, backM: 0, side: 0, sideM: 0, leaps: 0 };
for (const [m, x] of [...by].sort()) { row(m, x); for (const k of Object.keys(all) as (keyof typeof all)[]) all[k] += x[k]; }
row('all', all);
export {};
