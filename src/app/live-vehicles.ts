// ---- Live vehicles on the map, from zoom 14 when Settings has them on: the engine's stream when it has one, else every
//      15 s. Once a journey's route is chosen, only the vehicles of its rides, at any zoom, whether Settings has them on
//      or not (the one coming to your stop too). Not while the page is hidden.
//      Drawn on a canvas over the map, every frame and with the map as it moves (paint()): below zoom 15 each as a
//      pictogram, from zoom 15 as itself. Where each is: src/live-layout.ts (the same code the replay
//      tools/vehicle_replay.mts measures); buses on the roads the map draws: src/live-lines.ts. ----
import * as maplibregl from 'maplibre-gl';
import { map } from './map.ts';
import { platformPopup } from './platforms.ts';
import { spriteImage, vehicleGlyph } from './sprites.ts';
import { lineColor, lineLabel, lineVars, modeOf } from './journey-steps.ts';
import { h, kBadge, kBtn } from './sheet.ts';
import { journey } from './state.ts';
import { isRide } from './journey-steps.ts';
import { KANTE } from '../engine.ts';
import { KANTE_LIVE } from '../live.ts';
import { DrawnLines, layRoad, railTunnels, RAIL_CLASSES, ROAD_CLASSES, tileKey } from '../live-lines.ts';
import { VehicleLayout, mergeAnswer } from '../live-layout.ts';
import type { Make, Placed } from '../live-layout.ts';
import { tileLines } from '../vector-lines.ts';
import type { LinesAnswer, LinesAsk } from './lines-worker.ts';
import { SETTINGS } from '../settings.ts';
import type { KanteJourneyLike, KanteShownVehicle } from '../live.ts';
import { currentTheme } from '../theme.ts';
import type { LineLike, LineMode } from './journey-steps.ts';

// ---------------------------------------------------------------- live vehicles on the map

/** A vehicle of /api/vehicles as the map keeps it: with the response's time, its line as a journey, and how live it is. */
export interface LiveVehicle extends KanteVehicle {
  t: number;
  j: KanteJourneyLike;
  info: KanteLiveInfo | null;
  /** Answers since that lacked it (it is kept for two: src/live-layout.ts mergeAnswer()). */
  missed?: number;
}
/** What is drawn of a vehicle's kind: sprite ids (sprites.ts), the pictogram alone and with the line number, on the light and on the dark map. */
export interface LiveVehicleProps {
  label: string;
  icon: string;
  pill: string;
  iconD: string;
  pillD: string;
  /** Not in the timetable. */
  extra: boolean;
  /** Live (not the timetable alone, not stale). */
  live: boolean;
}
// ---------------------------------------------------------------- small helpers (the end of live-vehicles.ts)

/** A platform as the timetable writes it, taken apart: "7A-D" → num "7", sectors "A–D". */
export interface PlatformParts { num: string; sectors: string }

const VEH_MIN_ZOOM = 14;
const BODY_MIN_ZOOM = 15; // from here a vehicle is drawn as its body
const VEH_PILL_ZOOM = 16; // from here the vehicle shows its line number too
const DEST_MIN_ZOOM = 17; // …and where it goes
const VEH_MAX = 300; // enough for a city centre, light enough for a phone (the nearest the view's middle)
let vehList: LiveVehicle[] = [], vehBox: KanteBbox | null = null, vehES: EventSource | null = null, vehPollTimer: number | null = null, vehBusy = false, vehReq = 0;
let vehRaf = 0;
// What is shown of each vehicle, frame by frame
const layout = new VehicleLayout<LiveVehicle>();
const vehKey = (v: LiveVehicle) => VehicleLayout.key(v);
// When the vehicles' data last came in (vehAt, ms of Date.now()): older than VEH_DIM_MS (the stream stalled, polls
// fail) they are drawn faded; older than VEH_DROP_MS they are taken off the map. The engine's clock: as its answers
// tell it, never going back (KANTE_LIVE.engineClock()), so a wrong phone clock doesn't matter either.
let vehAt = 0;
const clock = KANTE_LIVE.engineClock();
const VEH_DIM_MS = 45000, VEH_DROP_MS = 120000;
const vehNow = () => clock.now(performance.now());

// ---- The lines the base map draws (swisstopo's base map, layer `transportation`), from its tiles at zoom 14 (the
//      most it has; the same addresses as the map's, so the browser's cache serves them): buses are laid onto its roads
//      (live-lines.ts layRoad), vehicles on rails drawn dashed where their track is in a tunnel (railTunnels). All of it
//      in a worker (lines-worker.ts), off the thread that draws the map: the tiles of the view only, from zoom 15 (where
//      vehicles are drawn as themselves). A bus is drawn once its way is laid; until then it is not (never laid onto the
//      road while one watches). Without a worker, the same here, a tile at a time while the map is still. ----
declare const __LINES_WORKER__: string | undefined;
const BASE_SOURCE = 'base_v1.0.0', BASE_TILES = 'https://vectortiles.geo.admin.ch/tiles/ch.swisstopo.base.vt/v1.0.0/{z}/{x}/{y}.pbf';
const LINE_CLASSES = new Set([...ROAD_CLASSES, ...RAIL_CLASSES]);
const MAX_TILES = 24; // then they start again (a long way off)
// the tiles taken in (or asked for, or that failed: asked for again after a while)
const tilesIn = new Set<string>(), tileBusy = new Set<string>(), tileFailed = new Map<string, number>();
let tileGen = 0; // how often they started again (a worker's answer for tiles asked before that is of no use)
let layGen = 0; // how often more lines came: a way laid before that, not in full, is laid again
let linesFrom = 0; // when the view's tiles were last asked for (performance.now())
type Laid = { pts: LngLat[] | null; cum: number[]; tunnel: Uint8Array | null; complete: boolean };
let worker: Worker | null = null;
try { if (typeof __LINES_WORKER__ === 'string' && window.Worker) worker = new Worker(new URL(__LINES_WORKER__, document.baseURI)); } catch { worker = null; }
// the ways laid in the worker (road: onto the roads; rail: where in tunnels), or asked for there
const laid = { road: new Map<string, Laid | 'asked'>(), rail: new Map<string, Laid | 'asked'>() };
// without a worker: the lines here
let roads = new DrawnLines(), rails = new DrawnLines();
function fromWorker(kind: 'road' | 'rail', path: string) {
  const x = laid[kind].get(path);
  if (x && x !== 'asked') return x;
  if (!x) {
    if (laid[kind].size > 4000) laid[kind].clear();
    laid[kind].set(path, 'asked');
    worker!.postMessage({ type: 'lay', kind, path, gen: layGen } satisfies LinesAsk);
  }
  return 'pending' as const;
}
function setLaying() {
  if (worker) {
    KANTE_LIVE.setLineRefiner((_pts, path) => { const x = fromWorker('road', path); return x === 'pending' ? x : x.pts ? { pts: x.pts, cum: x.cum, complete: x.complete, tunnel: x.tunnel } : null; });
    KANTE_LIVE.setTunneler((_pts, path) => { const x = fromWorker('rail', path); return x === 'pending' ? x : { cum: x.cum, tunnel: x.tunnel || new Uint8Array(x.cum.length), complete: x.complete }; });
  } else {
    KANTE_LIVE.setLineRefiner((pts) => layRoad(pts, roads));
    KANTE_LIVE.setTunneler((pts) => railTunnels(pts, rails));
  }
}
setLaying();
if (worker) {
  worker.onmessage = (e: MessageEvent<LinesAnswer>) => {
    const m = e.data;
    if (m.type === 'tiles') {
      if (m.gen !== tileGen) return; // asked before starting again: of no use
      for (const t of m.done) { tilesIn.add(t); tileBusy.delete(t); tileFailed.delete(t); }
      for (const t of m.failed) { tileBusy.delete(t); tileFailed.set(t, performance.now()); }
      if (m.done.length) linesCame();
    } else {
      // laid before more lines came (or before starting again) and not in full: asked again
      if (m.gen !== layGen && !m.complete) { if (laid[m.kind].get(m.path) === 'asked') laid[m.kind].delete(m.path); return; }
      const pts: LngLat[] | null = m.pts ? Array.from({ length: m.pts.length / 2 }, (_, k) => [m.pts![2 * k], m.pts![2 * k + 1]] as LngLat) : null;
      laid[m.kind].set(m.path, { pts, cum: Array.from(m.cum), tunnel: m.tunnel, complete: m.complete });
      relayLater(); // a way laid again (more tiles came): in place of the one before, where no vehicle is drawn on it yet
    }
  };
  // the worker failed: the lines here, from the start
  worker.onerror = () => { worker = null; tilesIn.clear(); tileBusy.clear(); laid.road.clear(); laid.rail.clear(); setLaying(); linesForView(); };
}
// more lines came: the ways laid without them are laid again
function linesCame() {
  layGen++;
  for (const m of [laid.road, laid.rail]) for (const [k, x] of m) if (x === 'asked' || !x.complete) m.delete(k);
  KANTE_LIVE.linesCame();
  relayLater();
}
function tileUrl() {
  const src = map.getStyle()?.sources?.[BASE_SOURCE] as maplibregl.VectorSourceSpecification | undefined;
  return (src && src.tiles && src.tiles[0]) || BASE_TILES;
}
function tilesOf(b: KanteBbox): string[] {
  const n = 16384, tx = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const ty = (lat: number) => { const s = Math.sin((lat * Math.PI) / 180); return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n); };
  const out: string[] = [];
  for (let x = tx(b[0]); x <= tx(b[2]); x++) for (let y = ty(b[3]); y <= ty(b[1]); y++) out.push(x + '/' + y);
  return out;
}
/** The tiles of the view (and a little round it), from zoom 15 where vehicles are drawn as themselves: asked for. */
function linesForView() {
  if (!vehBox || map.getZoom() < BODY_MIN_ZOOM) return;
  const v = map.getBounds(), now = performance.now();
  const want = tilesOf(KANTE_LIVE.padBbox([v.getWest(), v.getSouth(), v.getEast(), v.getNorth()], 0.1))
    .filter((t) => !tilesIn.has(t) && !tileBusy.has(t) && !(now - (tileFailed.get(t) || -1e9) < 20000)).slice(0, MAX_TILES);
  if (!want.length) return;
  if (tilesIn.size + want.length > MAX_TILES) {
    tileGen++;
    layGen++;
    tilesIn.clear();
    for (const t of tileBusy) if (!want.includes(t)) tileBusy.delete(t);
    laid.road.clear(); laid.rail.clear();
    if (worker) worker.postMessage({ type: 'reset' } satisfies LinesAsk);
    roads = new DrawnLines(); rails = new DrawnLines();
    setLaying();
  }
  linesFrom = now;
  for (const t of want) tileBusy.add(t);
  if (worker) worker.postMessage({ type: 'tiles', url: tileUrl(), tiles: want, gen: tileGen } satisfies LinesAsk);
  else for (const t of want) tileHere(t);
}
// without a worker: a tile taken in here, while the map is still
function tileHere(t: string) {
  const [x, y] = t.split('/').map(Number);
  fetch(tileUrl().replace('{z}', '14').replace('{x}', String(x)).replace('{y}', String(y)))
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
    .then((buf) => whenStill(() => {
      const all = tileLines(new Uint8Array(buf), 14, x, y, 'transportation', LINE_CLASSES);
      roads.add(t, all.filter((l) => ROAD_CLASSES.has(l.cls)));
      rails.add(t, all.filter((l) => RAIL_CLASSES.has(l.cls)));
      tilesIn.add(t);
      tileFailed.delete(t);
      linesCame();
    }))
    .catch(() => { tileFailed.set(t, performance.now()); })
    .finally(() => tileBusy.delete(t));
}
/** The ways laid before the tiles around them came: laid again a few at a time when the page has a moment (not in a frame). */
let relayTimer = 0;
function relayLater() {
  if (relayTimer) return;
  relayTimer = 1;
  idle((d) => { relayTimer = 0; if (KANTE_LIVE.relayLines(Math.max(4, d.timeRemaining() - 1))) relayLater(); });
}
const idle = (f: IdleRequestCallback) => (window.requestIdleCallback ? window.requestIdleCallback(f, { timeout: 500 })
  : setTimeout(() => f({ didTimeout: false, timeRemaining: () => 8 }), 50));
/** f once the map is not moving (a tile's lines take a few milliseconds). */
function whenStill(f: () => void): Promise<void> {
  return new Promise((done) => {
    const go = () => (map.isMoving() ? setTimeout(go, 200) : (f(), done()));
    go();
  });
}
/** A road vehicle at p is drawn as its body once the lines of its tile have come (or failed, or after a moment without
 *  them): never laid onto the road while one watches. */
const linesReady = (p: LngLat) => tilesIn.has(tileKey(p)) || tileFailed.has(tileKey(p)) || performance.now() - linesFrom > 2500;

// During a journey: the trips of its rides (`tripId|serviceDate`), and the box around their stops
function journeyTrips(): Set<string> | null {
  if (!journey.dest || !journey.conn) return null;
  return new Set(journey.conn.parts.filter(isRide).flatMap((s) => s.legs.map((l) => l.tripId + '|' + l.serviceDate)));
}
// The box a journey's vehicles are asked for: around all its stops where that is small enough for the engine (it answers
// boxes up to 120 km across, padded); a longer one (Geneva to Zurich): the part the map shows, else around where its
// first ride is boarded (never the middle of the way, where neither end is)
const diagKm = (b: KanteBbox) => KANTE_LIVE.distKm([b[0], b[1]], [b[2], b[3]]);
function journeyView(shown: KanteBbox): KanteBbox {
  const all = journeyBox()!;
  if (focusAt) all.splice(0, 4, Math.min(all[0], focusAt[0]), Math.min(all[1], focusAt[1]), Math.max(all[2], focusAt[0]), Math.max(all[3], focusAt[1]));
  if (diagKm(all) * 1.6 <= KANTE_LIVE.MAX_BBOX_KM * 0.95) return all;
  if (diagKm(shown) * 1.35 <= KANTE_LIVE.MAX_BBOX_KM * 0.95) return shown;
  const q = journey.conn!.parts.filter(isRide)[0]?.stops[0]?.quay;
  return q ? [q.lon - 0.05, q.lat - 0.035, q.lon + 0.05, q.lat + 0.035] : shown;
}
function journeyBox(): KanteBbox | null {
  if (!journey.conn) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const r of journey.conn.parts.filter(isRide)) for (const c of r.stops) {
    w = Math.min(w, c.quay.lon); e = Math.max(e, c.quay.lon); s = Math.min(s, c.quay.lat); n = Math.max(n, c.quay.lat);
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}
// ---- For src/app/vehicle-follow.ts and src/app/line-search.ts: one line's vehicles only (at any zoom, Settings' live
//      vehicles on or not), and one vehicle followed: drawn with a ring round it, moved on every frame (not only every
//      MOVING_MS while the map moves: the camera moves with it, so it would step against the map), and where it was
//      drawn last. ----
/** One line's vehicles, as line-search.ts asks for them: its key, which vehicles are of it, the box they were found in. */
export interface VehLineFilter { key: string; match: (line: KanteLine) => boolean; box: KanteBbox }
let lineFilter: VehLineFilter | null = null;
/** Only this line's vehicles (null: all of them again, from zoom 14 as Settings has it). */
export function vehLine(f: VehLineFilter | null) {
  if ((f && f.key) === (lineFilter && lineFilter.key)) return;
  lineFilter = f;
  vehUpdate();
}
/** The vehicles the map has now (only a line's while vehLine() has one, only a journey's during a journey). */
export const vehShown = (): readonly LiveVehicle[] => vehList;
/** The engine has answered for what is asked now (a line's vehicles: an empty list then means none). */
export const vehAnswered = () => vehAt > 0;
let focusKey: string | null = null;
/** A place the vehicles of a journey are asked for too (the vehicle followed, still on its way to the journey's stops). */
let focusAt: LngLat | null = null;
/** Where the followed vehicle was drawn (or is, off the screen), as of `at` (performance.now()). */
export interface VehFocusSample { key: string; ll: LngLat; at: number; v: LiveVehicle; drawn: boolean; /** ms since the live data last came in, when longer than it should be (0: fresh) */ old: number }
let focusSample: VehFocusSample | null = null;
/** The vehicle followed (`tripId|serviceDate`), or none; `at`: where it is said to be, when it may be outside the box a
 *  journey's vehicles are asked for. */
export function vehFocus(key: string | null, at: LngLat | null = null) {
  const moved = (at && at.join()) !== (focusAt && focusAt.join());
  focusAt = at;
  if (key !== focusKey) { focusKey = key; focusSample = null; paintedAt = -1; placedAt = -Infinity; }
  if (moved) vehUpdate();
}
/** Where the followed vehicle was drawn in the last frame; null while the live layer does not have it. */
export const vehFocusNow = (): VehFocusSample | null => (focusSample && focusSample.key === focusKey ? focusSample : null);
let followHandler: ((v: LiveVehicle) => void) | null = null;
/** A tapped vehicle's card offers "Follow", which calls this. */
export function onFollowVehicle(fn: (v: LiveVehicle) => void) { followHandler = fn; }

// what the vehicles are fetched for: 'map' (all around, from zoom 14, when Settings has them on), a journey's trips,
// or one line's
let vehMode = '';
const vehWanted = () => !!KANTE && KANTE.ok() && !document.hidden && (journey.dest
  ? !!journeyTrips()?.size
  : !!lineFilter || (map.getZoom() >= VEH_MIN_ZOOM && SETTINGS.prefs().liveVehicles !== false));
/** The live layer shows this trip's vehicle now (a journey's ride: then its own marker is not needed). */
export function vehShowsTrip(tripId: string, serviceDate: string) {
  return Date.now() - vehAt < VEH_DIM_MS && drawnTrips.has(tripId + '|' + serviceDate);
}
/** The trips drawn in the last frame. */
let drawnTrips = new Set<string>();
export function vehStop() {
  vehReq++;
  if (vehES) { vehES.close(); vehES = null; }
  clearInterval(vehPollTimer);
  cancelAnimationFrame(vehRaf);
  vehPollTimer = null;
  vehRaf = 0;
  vehMode = '';
  layout.forget(new Set());
  vehBox = null;
  vehList = [];
  vehAt = 0;
  clock.reset();
  vehPopup.remove();
  paint();
}
export function vehUpdate() {
  if (!vehWanted()) { if (vehBox || vehList.length) vehStop(); return; }
  const trips = journeyTrips(), line = trips ? null : lineFilter, mode = trips ? [...trips].sort().join(',') : line ? 'line:' + line.key : 'map';
  const b = map.getBounds(), shown: KanteBbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  // a line's: the box it was found in while the map shows a part of it, else the map
  const view: KanteBbox = trips ? journeyView(shown) : line && KANTE_LIVE.bboxContains(line.box, shown) ? line.box : shown;
  if (mode === vehMode && vehBox && KANTE_LIVE.bboxContains(vehBox, view)) return; // still covered: keep the stream / poll as it is
  if (mode !== vehMode) vehStop();
  else {
    // the map moved on: a stream for the new box, and what is shown stays (gliding on) until its first answer
    vehReq++;
    if (vehES) { vehES.close(); vehES = null; }
    clearInterval(vehPollTimer);
    vehPollTimer = null;
    cancelAnimationFrame(vehRaf);
  }
  vehMode = mode;
  vehBox = KANTE_LIVE.padBbox(view, trips || line ? .3 : .35);
  if (!KANTE_LIVE.bboxOk(vehBox)) { vehBox = null; return; }
  linesForView();
  const bbox = KANTE_LIVE.bboxParam(vehBox), id = vehReq;
  if (KANTE!.has('stream') && window.EventSource) {
    vehES = new EventSource(KANTE!.href('/api/stream', { bbox }));
    vehES.addEventListener('vehicles', (e) => { try { vehSet(JSON.parse(e.data)); } catch (err) { /* skip a bad event */ } });
    // closed for good (not a reconnect; e.g. 503 when the engine has too many streams open): poll instead
    vehES.onerror = () => {
      if (vehES && vehES.readyState === 2 && id === vehReq) { vehES = null; vehPollTimer = setInterval(() => vehFetch(bbox, id), 15000); vehFetch(bbox, id); }
    };
  } else {
    vehFetch(bbox, id);
    vehPollTimer = setInterval(() => vehFetch(bbox, id), 15000);
  }
  // every frame (while the map moves, from its render event instead, so both move as one)
  const frame = () => {
    vehRaf = requestAnimationFrame(frame);
    if (!map.isMoving()) paint();
  };
  vehRaf = requestAnimationFrame(frame);
}
async function vehFetch(bbox: string, id: number) {
  if (vehBusy || document.hidden) return;
  vehBusy = true;
  const data = await KANTE!.vehicles({ bbox }).catch(() => null);
  vehBusy = false;
  if (data && id === vehReq) vehSet(data);
}
function vehSet(data: KanteVehiclesResponse) {
  const t = data && Number.isFinite(data.t) ? data.t : Date.now() / 1000;
  vehAt = Date.now();
  clock.answer(t, performance.now());
  // the nearest the view's middle first, as many as a phone draws smoothly
  const trips = journeyTrips(), c = map.getCenter(), kx = Math.cos((c.lat * Math.PI) / 180);
  // (a line's only; the one followed is never left out)
  const near = (v: KanteVehicle) => { const p = v.point || v.from; return focusKey === VehicleLayout.key(v) ? -1 : ((p[0] - c.lng) * kx) ** 2 + (p[1] - c.lat) ** 2; };
  const line = trips ? null : lineFilter;
  let list = ((data && data.vehicles) || []).filter((v) => (trips ? trips.has(v.tripId + '|' + v.serviceDate) : !line || line.match(v.line)));
  if (list.length > VEH_MAX) list = list.map((v) => [near(v), v] as const).sort((a, b) => a[0] - b[0]).slice(0, VEH_MAX).map((x) => x[1]);
  vehList = mergeAnswer(vehList, list.map((v) => ({ ...v, t, j: KANTE_LIVE.journeyLike(v.line), info: KANTE_LIVE.liveInfoOf(v) })));
  layout.forget(new Set(vehList.map(vehKey)));
  placedAt = -Infinity; // (what was placed is of the list before)
  layLater();
}
// The buses' ways laid onto the roads ahead of drawing them, a few at a time when the page has a moment
let layTimer = 0;
function layLater() {
  if (layTimer) return;
  layTimer = 1;
  idle((d) => {
    layTimer = 0;
    // what the moment allows, at least a few milliseconds (a page that is never idle still gets them laid)
    const until = performance.now() + Math.max(4, d.timeRemaining() - 1);
    for (const v of vehList) {
      if (performance.now() > until) { layLater(); return; }
      if (v.line.mode === 'bus' || v.line.mode === 'ondemand') {
        KANTE_LIVE.pointAtShare(v, 0.5);
        for (const w of [v.onward, v.behind]) if (w && w.hopPath) KANTE_LIVE.pointAtShare({ ...v, hopPath: w.hopPath, hopSpan: w.hopSpan }, 0.5);
      }
    }
  });
}

// ---- Drawn on a canvas over the map, every frame (in step with the map while it moves), not through the map's data
//      (which redraws a fraction of a second later, so they could only step). From zoom 15 each as its parts seen
//      from above: rigid carriages, each a straight body from where its back is on the way to where its front is,
//      linked at their joints (so they follow the curve as a real train does, not as a snake), as long and wide as
//      such a vehicle (at least a few pixels wide), rounded at the cabs, shaded across the roof, with windows along the
//      sides and a windscreen at the front; in a colour of its own (none of the vehicles near it has it when it first
//      shows, and it keeps it); dashed and paler in a tunnel. Over it its badge (what it is and its line, as below
//      zoom 15), from zoom 17 where it goes. Below zoom 15: the pictogram of what it is, in its line's colour. ----
// Colours a vehicle can have: far apart from each other, plain on the light and the dark map
const VEH_COLORS = ['#d7263d', '#2e9e44', '#2f5fd0', '#f08a24', '#8b3fb5', '#0ea5b7', '#d63fa8', '#7cb518', '#2f7f78', '#a0632a',
  '#7a1f2b', '#23306b', '#6b6b1f', '#d4a106', '#ff6f91', '#4a5563'];
const vehColor = new Map<string, number>();
const NEAR_KM = 2; // vehicles nearer than this never share a colour when one of them first shows
function colorOf(k: string, at: LngLat): string {
  let c = vehColor.get(k);
  if (c == null) {
    const used = new Map<number, number>();
    for (const [o, s] of layout.shown) {
      const oc = vehColor.get(o);
      if (oc != null && o !== k && KANTE_LIVE.distKm(s.ll, at) < NEAR_KM) used.set(oc, (used.get(oc) || 0) + 1);
    }
    // from a place its trip names (so a reload tends to give the same), the first colour none near it has
    let hh = 0;
    for (let i = 0; i < k.length; i++) hh = (hh * 31 + k.charCodeAt(i)) >>> 0;
    let best = hh % VEH_COLORS.length, bestN = Infinity;
    for (let j = 0; j < VEH_COLORS.length; j++) {
      const i = (hh + j) % VEH_COLORS.length, n = used.get(i) || 0;
      if (n < bestN) { best = i; bestN = n; }
      if (n === 0) break;
    }
    c = best;
    vehColor.set(k, c);
    if (vehColor.size > 5000) vehColor.clear();
  }
  return VEH_COLORS[c];
}
// A colour moved towards black (f < 1) or white (f > 1); kept once worked out
const shades = new Map<string, string>();
function shade(hex: string, f: number) {
  const key = hex + f;
  let out = shades.get(key);
  if (out) return out;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16), ch = (x: number) => Math.round(f <= 1 ? x * f : x + (255 - x) * (f - 1)).toString(16).padStart(2, '0');
  out = '#' + ch(n >> 16) + ch((n >> 8) & 255) + ch(n & 255);
  shades.set(key, out);
  return out;
}

let vcv: HTMLCanvasElement | null = null, vctx: CanvasRenderingContext2D | null = null, drawnAny = false;
// The canvas at the map's own pixel ratio (at most 2: a 3× screen is drawn at 2×, as the map is)
const ratio = () => Math.min(window.devicePixelRatio || 1, 2);
/** What was drawn of each vehicle, for taps: its index and its carriages as screen rectangles (back, front, half width). */
type Pt = { x: number; y: number };
let vehHits: { i: number; cars: [Pt, Pt, number][] }[] = [];
let cssW = 0, cssH = 0;
let sized = false; // (reading the page's layout every frame is dear: only on a resize)
function canvasSize() {
  if (!vcv) return;
  if (sized) return;
  sized = true;
  const c = map.getCanvas(), dpr = ratio(), w = c.clientWidth, hh = c.clientHeight;
  cssW = w; cssH = hh;
  if (vcv.width !== Math.round(w * dpr) || vcv.height !== Math.round(hh * dpr)) {
    vcv.width = Math.round(w * dpr);
    vcv.height = Math.round(hh * dpr);
    vcv.style.width = w + 'px';
    vcv.style.height = hh + 'px';
  }
}
function canvasReady() {
  if (vcv) return vctx;
  vcv = document.createElement('canvas');
  vcv.className = 'kveh-canvas';
  Object.assign(vcv.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none' });
  // over the map, under its markers and popups
  map.getCanvas().after(vcv);
  vctx = vcv.getContext('2d');
  canvasSize();
  return vctx;
}
// From [lon, lat] to the screen, for one frame: a flat map (no tilt) is Mercator scaled, turned and moved, worked out
// from three points; a tilted one (following a ride) through the map itself
type Project = (p: LngLat) => Pt;
function projector(): Project {
  if (map.getPitch() > 0.01) return (p) => map.project(p as maplibregl.LngLatLike);
  const c = map.getCenter(), mc = maplibregl.MercatorCoordinate.fromLngLat(c), d = 1 / (512 * 2 ** map.getZoom());
  const o = map.project(c), ex = map.project(new maplibregl.MercatorCoordinate(mc.x + d, mc.y).toLngLat()), ey = map.project(new maplibregl.MercatorCoordinate(mc.x, mc.y + d).toLngLat());
  const ax = (ex.x - o.x) / d, ay = (ex.y - o.y) / d, bx = (ey.x - o.x) / d, by = (ey.y - o.y) / d;
  return (p) => {
    const x = (p[0] + 180) / 360 - mc.x, s = Math.sin((p[1] * Math.PI) / 180);
    const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) - mc.y;
    return { x: o.x + ax * x + bx * y, y: o.y + ay * x + by * y };
  };
}
let paintedAt = -1;
function paint() {
  const now = performance.now();
  if (now === paintedAt) return;
  paintedAt = now;
  if (!vehList.length && !drawnAny) return; // nothing drawn, nothing to draw
  const ctx = canvasReady();
  if (!ctx || !vcv) return;
  if (Date.now() - vehAt > VEH_DROP_MS && vehList.length) { vehList = []; layout.forget(new Set()); vehPopup.remove(); }
  const zoom = map.getZoom(), tNow = vehNow();
  if (drawnAny) {
    canvasSize();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, vcv.width, vcv.height);
    drawnAny = false;
  }
  vehHits = [];
  const drawn = new Set<string>();
  drawnTrips = drawn;
  // a journey's vehicles at any zoom (its route is chosen: the vehicles of its rides, Live vehicles on or not); the
  // others from zoom 14
  if (!vehList.length || !Number.isFinite(tNow) || (zoom < VEH_MIN_ZOOM && !journeyTrips() && !lineFilter)) return;
  canvasSize();
  const dpr = ratio();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawnAny = true;
  // the buses' ways not laid yet: a few milliseconds of laying a frame, the rest in the frames after (and when idle)
  KANTE_LIVE.layBudget(4);
  // (moved on every frame where they can be seen; the others a few times a second)
  const project0 = projector(), near = (p: LngLat) => { const q = project0(p); return q.x > -cssW && q.y > -cssH && q.x < 2 * cssW && q.y < 2 * cssH; };
  // while the map is dragged or zoomed, where each vehicle is (and its carriages) is worked out again every
  // MOVING_MS (it goes on less than a pixel in that time); each frame in between only draws it where the map now is
  // (every frame also while a vehicle is followed among few — a journey's, a line's —: the camera moves with it, so it
  // would step against the map; among a city's hundreds the followed one steps with the others)
  const again = !map.isMoving() || (!!focusKey && vehList.length <= FOCUS_EVERY_FRAME) || now - placedAt >= MOVING_MS || zoom < BODY_MIN_ZOOM !== placedLow;
  focusDrawn = null;
  try {
    if (again) layout.step(vehList, tNow, now, near);
    paintVehicles(ctx, zoom, now, again);
  } finally { if (KANTE_LIVE.layBudget(Infinity)) layLater(); }
  if (focusKey) {
    // where it is drawn (its body's middle; held back behind the one in front, that is not where it is shown going)
    const s = layout.shown.get(focusKey), v = s && vehList.find((x) => vehKey(x) === focusKey);
    const old = Date.now() - vehAt;
    focusSample = s && v ? { key: focusKey, ll: focusDrawn || s.ll, at: now, v, drawn: drawn.has(focusKey), old: old > VEH_DIM_MS ? old : 0 } : null;
  }
}
const MOVING_MS = 100, FOCUS_EVERY_FRAME = 40;
let focusDrawn: LngLat | null = null; // where the followed vehicle's body was drawn in this frame
let placed: Placed<LiveVehicle>[] = [], placedAt = -Infinity, placedLow = false;
function paintVehicles(ctx: CanvasRenderingContext2D, zoom: number, now: number, again: boolean) {
  const drawn = drawnTrips;
  const old = Date.now() - vehAt > VEH_DIM_MS, dark = currentTheme() === 'dark', project = projector();
  const pad = 60;
  if (zoom < BODY_MIN_ZOOM) {
    if (again) { placedAt = now; placedLow = true; }
    // the pictograms, as large as the map's symbols were (from 0.62 at zoom 14 to 0.8 at 16, exponentially)
    const size = Math.max(0.5, 0.62 + (0.8 - 0.62) * (1.5 ** (zoom - VEH_MIN_ZOOM) - 1) / (1.5 ** 2 - 1));
    vehList.forEach((v, i) => {
      const s = layout.shown.get(vehKey(v));
      if (!s) return;
      const q = project(s.ll), p = propsOf(v), img = spriteImage(dark ? p.iconD : p.icon);
      if (!img || q.x < -pad || q.y < -pad || q.x > cssW + pad || q.y > cssH + pad) return;
      const w = (img.img.width / img.ratio) * size, hh = (img.img.height / img.ratio) * size;
      ctx.globalAlpha = old || !p.live ? 0.45 : 1;
      ctx.drawImage(img.img, q.x - w / 2, q.y - hh / 2, w, hh);
      vehHits.push({ i, cars: [[q, q, Math.max(w, hh) / 2 + 4]] });
      drawn.add(vehKey(v));
      if (vehKey(v) === focusKey) focusRing(ctx, q, Math.max(w, hh) / 2 + 6, lineColor(v.j).bg);
    });
    ctx.globalAlpha = 1;
    return;
  }
  const lat = map.getCenter().lat, pxPerM = 1 / (40075016.686 * Math.cos((lat * Math.PI) / 180) / (512 * 2 ** zoom));
  // in view as far as its body reaches; a road vehicle once the roads around it have come and its way is laid onto
  // them (never laid while one watches)
  // (and around it, as far again as the screen is large: laid out, not drawn, so they are kept apart before they show)
  const inView = (p: LngLat, v: LiveVehicle, make: Make, reachM: number): boolean | 'near' => {
    if (make.road && !(linesReady(p) && KANTE_LIVE.isLaid(layout.shown.get(vehKey(v))!.rec))) return false;
    const q = project(p), r = pad + reachM * pxPerM;
    if (q.x > -r && q.y > -r && q.x < cssW + r && q.y < cssH + r) return true;
    return q.x > -cssW && q.y > -cssH && q.x < 2 * cssW && q.y < 2 * cssH ? 'near' : false;
  };
  const labels: { v: LiveVehicle; x: number; y: number; dim: boolean }[] = [];
  ctx.lineJoin = 'round';
  if (again) { placed = layout.place(vehList, now, inView); placedAt = now; placedLow = false; }
  for (const P of placed) {
    const { v, s, make, i, k } = P;
    drawn.add(k);
    const fill = colorOf(k, s.ll), live = propsOf(v).live;
    const W = Math.max(make.width * pxPerM, 5 + Math.min(3, Math.max(0, zoom - 15) * 1.5));
    ctx.globalAlpha = old || !live ? 0.55 : 1;
    let centre = project(s.ll);
    if (!P.cars) {
      // its way not known: a disc where it is
      ctx.beginPath(); ctx.arc(centre.x, centre.y, W * 0.8, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 1.2; ctx.strokeStyle = shade(fill, 0.55); ctx.stroke();
      vehHits.push({ i, cars: [[centre, centre, W * 0.8]] });
    } else {
      const cars = P.cars.map(([p, q]) => [project(p), project(q)] as [Pt, Pt]);
      const mid = cars[Math.floor(cars.length / 2)];
      centre = { x: (mid[0].x + mid[1].x) / 2, y: (mid[0].y + mid[1].y) / 2 };
      drawVehicle(ctx, cars, W, fill, make, P.tunnel, dark);
      vehHits.push({ i, cars: cars.map(([p, q]) => [p, q, W / 2 + 2]) });
    }
    ctx.globalAlpha = 1;
    if (k === focusKey) {
      focusRing(ctx, centre, Math.max(16, W * 1.6), fill);
      if (P.cars) { const ll = map.unproject([centre.x, centre.y]); focusDrawn = [ll.lng, ll.lat]; }
    }
    labels.push({ v, x: centre.x, y: centre.y - W / 2, dim: old || !live });
  }
  // over them all: each one's badge, and where it goes from zoom 17
  for (const L of labels) drawBadge(ctx, L.v, L.x, L.y, zoom, dark, L.dim);
}

// The vehicle followed: a ring round it in its own colour, over a pale disc (so it is found at a glance)
function focusRing(ctx: CanvasRenderingContext2D, c: Pt, r: number, color: string) {
  const a0 = ctx.globalAlpha;
  ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.globalAlpha = 0.16; ctx.fillStyle = color; ctx.fill();
  ctx.globalAlpha = 0.9; ctx.lineWidth = 2.5; ctx.strokeStyle = color; ctx.stroke();
  ctx.globalAlpha = a0;
}

/**
 * One vehicle seen from above: its carriages (screen back and front points, back to front), W px wide. Each a body
 * with squared corners and a rounded nose at a cab, painted flat with its roof a shade lighter, a crisp darker
 * outline, the windscreen across the front behind the nose; grey bellows between the parts; a soft shadow under it.
 * In a tunnel (per carriage) dashed and paler.
 */
function drawVehicle(ctx: CanvasRenderingContext2D, cars: [Pt, Pt][], W: number, fill: string,
  make: Make, tunnel: boolean[], dark: boolean) {
  const edge = shade(fill, 0.55), roof = shade(fill, 1.22), glass = dark ? '#9fc3ea' : '#1c2a3d';
  const n = cars.length, a0 = ctx.globalAlpha;
  // the bellows between the parts, under them
  if (n > 1) {
    ctx.beginPath();
    for (let j = 1; j < n; j++) { const p = cars[j - 1][1], q = cars[j][0]; ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
    ctx.lineCap = 'butt'; ctx.lineWidth = W * 0.74; ctx.strokeStyle = dark ? '#3a4049' : '#59606b'; ctx.stroke();
  }
  // each part of it at once, as a few paths for all its carriages (turned by hand: no saving and turning the canvas
  // for each), those in a tunnel apart (paler, dashed)
  const corner = W * 0.14, nose = W * 0.36, ins = Math.max(1, W * 0.2), depth = Math.max(1.2, W * 0.2), side = Math.max(0.8, W * 0.12);
  const geo = cars.map(([p, q], j) => {
    const L = Math.hypot(q.x - p.x, q.y - p.y);
    return { p, L, ux: L ? (q.x - p.x) / L : 1, uy: L ? (q.y - p.y) / L : 0, r: radii(j, n, make, W), front: j === n - 1, backCab: j === 0 && make.cabs === 2, under: tunnel[j] };
  });
  const each = (under: boolean, f: (g: typeof geo[number]) => void) => { for (const g of geo) if (g.L >= 0.5 && g.under === under) f(g); };
  // the soft shadow under it: its bodies a little lower, in a dark see-through grey with a softer edge round it
  // (a blur is far dearer to draw, on a phone above all; this looks the same at this size)
  const dy = Math.min(1.5, W * 0.08);
  ctx.beginPath();
  each(false, (g) => carPath(ctx, g.p.x, g.p.y + dy, g.ux, g.uy, g.L, W, g.r[0], g.r[1]));
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.min(3, W * 0.25); ctx.strokeStyle = 'rgba(10,14,20,.12)'; ctx.stroke();
  ctx.fillStyle = 'rgba(10,14,20,.24)'; ctx.fill();
  for (const under of [false, true]) {
    if (!geo.some((g) => g.under === under && g.L >= 0.5)) continue;
    ctx.globalAlpha = a0 * (under ? 0.5 : 1);
    // the bodies
    ctx.beginPath();
    each(under, (g) => carPath(ctx, g.p.x, g.p.y, g.ux, g.uy, g.L, W, g.r[0], g.r[1]));
    ctx.fillStyle = fill; ctx.fill();
    // their roofs, a shade lighter, inset from the sides
    if (W >= 6) {
      ctx.beginPath();
      each(under, (g) => {
        const x0 = (g.backCab ? nose : corner) * 0.6 + ins * 0.5, x1 = g.L - (g.front ? nose + W * 0.32 : corner * 0.6 + ins * 0.5);
        const r = Math.max(0.5, W * 0.08);
        if (x1 > x0) carPath(ctx, g.p.x + g.ux * x0, g.p.y + g.uy * x0, g.ux, g.uy, x1 - x0, W - ins * 2, r, r);
      });
      ctx.fillStyle = roof; ctx.fill();
    }
    // the windscreens across the front (and the back of one that drives both ways), behind the nose
    if (W >= 5) {
      ctx.beginPath();
      each(under, (g) => {
        const r = depth * 0.4;
        if (g.front) { const x = g.L - nose * 0.55 - depth; carPath(ctx, g.p.x + g.ux * x, g.p.y + g.uy * x, g.ux, g.uy, depth, W - side * 2, r, r); }
        if (g.backCab) { const x = nose * 0.55; carPath(ctx, g.p.x + g.ux * x, g.p.y + g.uy * x, g.ux, g.uy, depth, W - side * 2, r, r); }
      });
      ctx.fillStyle = glass; ctx.fill();
    }
    // the outlines: crisp; dashed in a tunnel
    ctx.globalAlpha = a0;
    ctx.beginPath();
    each(under, (g) => carPath(ctx, g.p.x, g.p.y, g.ux, g.uy, g.L, W, g.r[0], g.r[1]));
    ctx.lineWidth = W >= 10 ? 1.3 : 1; ctx.strokeStyle = edge;
    if (under) ctx.setLineDash([Math.max(3, W * 0.4), Math.max(2, W * 0.3)]);
    ctx.stroke();
    if (under) ctx.setLineDash([]);
  }
  ctx.globalAlpha = a0;
}
// The radii of a carriage's back and front corners: a rounded nose at a cab
function radii(j: number, n: number, make: Make, W: number): [number, number] {
  const corner = W * 0.14, nose = W * 0.36;
  return [j === 0 && make.cabs === 2 ? nose : corner, j === n - 1 ? nose : corner];
}
// A carriage's outline from p along (ux, uy), L long, W wide, its back corners rb and front ones rf round
function carPath(ctx: CanvasRenderingContext2D, px: number, py: number, ux: number, uy: number, L: number, W: number, rb: number, rf: number) {
  const nx = -uy * (W / 2), ny = ux * (W / 2);
  rb = Math.min(rb, W / 2, L / 2); rf = Math.min(rf, W / 2, L / 2);
  const at = (a: number, s: number) => [px + ux * a + nx * s, py + uy * a + ny * s] as const;
  const [ax, ay] = at(rb, -1), [bx, by] = at(L, -1), [cx, cy] = at(L, 1), [dx, dy] = at(0, 1), [ex, ey] = at(0, -1);
  ctx.moveTo(ax, ay);
  ctx.arcTo(bx, by, cx, cy, rf);
  ctx.arcTo(cx, cy, dx, dy, rf);
  ctx.arcTo(dx, dy, ex, ey, rb);
  ctx.arcTo(ex, ey, ax, ay, rb);
  ctx.closePath();
}

/** Its badge over it: what it is and its line (as below zoom 15); from zoom 17 where it goes. */
function drawBadge(ctx: CanvasRenderingContext2D, v: LiveVehicle, x: number, y: number, zoom: number, dark: boolean, dim: boolean) {
  const p = propsOf(v), img = spriteImage(zoom >= VEH_PILL_ZOOM ? (dark ? p.pillD : p.pill) : (dark ? p.iconD : p.icon));
  const a0 = ctx.globalAlpha;
  ctx.globalAlpha = dim ? 0.7 : 1;
  let bottom = y - 3;
  if (img) {
    const scale = (zoom >= 18 ? 0.95 : 0.8) / img.ratio, w = img.img.width * scale, hh = img.img.height * scale;
    ctx.drawImage(img.img, x - w / 2, bottom - hh, w, hh);
    bottom -= hh - 2;
  }
  if (zoom >= DEST_MIN_ZOOM && v.headsign) {
    const t = headsignImage('→ ' + v.headsign, dark);
    ctx.drawImage(t.img, x - t.w / 2, bottom - t.h, t.w, t.h);
  }
  ctx.globalAlpha = a0;
}
// Where it goes, as text with a halo: drawn once into an image of its own (text outlines are slow to draw every frame)
const headsigns = new Map<string, { img: HTMLCanvasElement; w: number; h: number }>();
function headsignImage(text: string, dark: boolean) {
  const key = text + (dark ? '\u0001' : '');
  let out = headsigns.get(key);
  if (out) return out;
  const r = ratio(), font = '600 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const c = document.createElement('canvas'), m = c.getContext('2d')!;
  m.font = font;
  const w = Math.ceil(m.measureText(text).width) + 6, hh = 16;
  c.width = w * r; c.height = hh * r;
  const g = c.getContext('2d')!;
  g.scale(r, r);
  g.font = font; g.textAlign = 'center'; g.textBaseline = 'bottom'; g.lineJoin = 'round';
  g.lineWidth = 3; g.strokeStyle = dark ? 'rgba(12,14,18,.92)' : 'rgba(255,255,255,.95)'; g.strokeText(text, w / 2, hh - 1);
  g.fillStyle = dark ? '#e9ecf1' : '#1d232c'; g.fillText(text, w / 2, hh - 1);
  out = { img: c, w, h: hh };
  if (headsigns.size > 400) headsigns.clear();
  headsigns.set(key, out);
  return out;
}

/** The vehicle drawn under a tap at point p (screen pixels), or null. */
function vehicleAt(p: Pt): number | null {
  let best: number | null = null, bestD = 10;
  for (const hit of vehHits) for (const [a, b, half] of hit.cars) {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const d = Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y) - half;
    if (d < bestD) { bestD = d; best = hit.i; }
  }
  return best;
}
const vehProps = new WeakMap<LiveVehicle, LiveVehicleProps>();
function propsOf(v: LiveVehicle): LiveVehicleProps {
  let p = vehProps.get(v);
  if (!p) {
    const c = lineColor(v.j), st = v.info && v.info.state;
    const glyph = vehicleGlyph(v.line.mode), x = v.extra ? 'x' : '', label = lineLabel(v.j);
    const id = (bg: string, fg: string, text: string, theme: string) => ['vh', glyph, bg.slice(1), fg.slice(1), text, x, theme].join('|');
    p = { label, extra: !!v.extra, live: st !== 'stale' && st !== 'timetable',
      icon: id(c.bg, c.fg, '', 'light'), pill: id(c.bg, c.fg, label, 'light'), iconD: id(c.dbg, c.dfg, '', 'dark'), pillD: id(c.dbg, c.dfg, label, 'dark') };
    vehProps.set(v, p);
  }
  return p;
}
const vehPopup = new maplibregl.Popup({ closeButton: false, className: 'pf-pop vh-pop', maxWidth: 'none', offset: 12 });

export const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: string | null): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
export const badge = (j: LineLike) => lineVars(mk('span', 'j-badge', lineLabel(j)), j);
// Platform (rail, cable cars) · Bay (bus and tram edges, "Kante") · Pier (boats)
export const nounOf = (mode: LineMode) => (mode === 'train' || mode === 'cable' ? 'Platform' : mode === 'boat' ? 'Pier' : 'Bay');
export const platformWord = (j: LineLike) => nounOf(modeOf(j.category));
// The platform a ride stops at today ('7', '7AB'): the boarding point the engine names; '–' at a stop without one
export const platformOf = (stop: KanteStopCall) => ((stop.quay.label || '') + (stop.quay.sectors || '')) || '–';

const COMPASS8 = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export const compassWord = (deg: number) => COMPASS8[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const levelShort = (l: number) => (l < 0 ? '−' + -l : String(l));
export const fmtDist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`);

// "7A-D" → { num: '7', sectors: 'A–D' }; "H" → { num: 'H', sectors: '' }
export function splitPlatform(p: string | null | undefined): PlatformParts {
  const m = /^(\d+)\s*([A-Z](?:\s*-\s*[A-Z])?|[A-Z]{2,})$/i.exec(p || '');
  if (!m) return { num: p || '', sectors: '' };
  let s = m[2].toUpperCase().replace(/\s*-\s*/, '–');
  if (!s.includes('–') && s.length > 1) s = `${s[0]}–${s[s.length - 1]}`;
  return { num: m[1], sectors: s };
}

/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() {
  map.on('click', (e) => {
    if (!vehList.length) return;
    const i = vehicleAt(e.point);
    const v = i == null ? null : vehList[i];
    const s: KanteShownVehicle<LiveVehicle> | undefined = v ? layout.shown.get(vehKey(v)) : undefined;
    const at = s ? s.ll : v ? v.from : null;
    if (!v || !at) return;
    const now = vehNow(), old = Date.now() - vehAt > VEH_DIM_MS;
    // "Left its last stop … (measured)" only when under way after a measured departure from that stop
    const measured = !old && KANTE_LIVE.vehicleLeftMeasured(v);
    const how = old ? { text: `Not updated for ${Math.round((Date.now() - vehAt) / 60000) || 1} min: the live data is not coming through` }
      : KANTE_LIVE.liveText(v.info, { basis: v.basis, from: measured ? 'its last stop' : null, leftS: measured ? Math.max(0, now - v.dep) : null });
    const body = h('div', null,
      h('div', 'pf-head', kBadge(v.j), h('span', 'pf-name', h('b', null, `to ${v.headsign}`), h('small', null, `Next stop: ${v.nextStop}`))),
      v.extra ? h('p', 'pf-note vh-extra', 'Extra journey, not in the timetable') : null,
      h('p', 'vh-how', how.text),
      followHandler ? kBtn('vh-follow', `Follow ${propsOf(v).label} to ${v.headsign}`, () => { vehPopup.remove(); followHandler!(v); }, 'Follow') : null);
    platformPopup.remove();
    vehPopup.setLngLat(at).setDOMContent(body).addTo(map);
  });
  map.on('moveend', vehUpdate);
  map.on('moveend', linesForView);
  // the canvas: drawn with the map while it moves (so they move as one), sized with it
  map.on('render', () => { if (map.isMoving() && (vehList.length || drawnAny)) paint(); });
  map.on('resize', () => { sized = false; canvasSize(); paintedAt = -1; paint(); });
  window.addEventListener('resize', () => { sized = false; });
}
