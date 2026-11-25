// ---- Live vehicles on the map, from zoom 14: the engine's stream when it has one, else every 15 s. During a journey
//      only the vehicles of its rides (at any zoom, the one coming to your stop too). Not while the page is hidden.
//      Below zoom 15 a pictogram on the map; from zoom 15 each drawn as itself on a canvas over the map (see paint()). ----
import * as maplibregl from 'maplibre-gl';
import { map } from './map.ts';
import { platformPopup } from './platforms.ts';
import { vehicleGlyph } from './sprites.ts';
import { lineColor, lineLabel, lineVars, modeOf } from './journey-steps.ts';
import { h, kBadge } from './sheet.ts';
import { journey } from './state.ts';
import { isRide } from './journey-steps.ts';
import { KANTE } from '../engine.ts';
import { KANTE_LIVE } from '../live.ts';
import { SETTINGS } from '../settings.ts';
import type { KanteJourneyLike, KanteShownVehicle } from '../live.ts';
import { currentTheme } from '../theme.ts';
import type { Theme } from '../theme.ts';
import type { LineLike, LineMode } from './journey-steps.ts';

// ---------------------------------------------------------------- live vehicles on the map

/** A vehicle of /api/vehicles as the map keeps it: with the response's time, its line as a journey, and how live it is. */
export interface LiveVehicle extends KanteVehicle {
  t: number;
  j: KanteJourneyLike;
  info: KanteLiveInfo | null;
}
/** What the map's 'kveh' source says about a vehicle. i: its index in the list. */
export interface LiveVehicleProps {
  i: number;
  label: string;
  /** Sprite ids (sprites.ts): the pictogram alone and with the line number, on the light and on the dark map. */
  icon: string;
  pill: string;
  iconD: string;
  pillD: string;
  /** Not in the timetable. */
  extra: boolean;
  /** Not live (or not updated for a while): drawn faded. */
  dim: boolean;
}
export type LiveVehicleCollection = GeoJSON.FeatureCollection<GeoJSON.Point, LiveVehicleProps>;
// ---------------------------------------------------------------- small helpers (the end of live-vehicles.ts)

/** A platform as the timetable writes it, taken apart: "7A-D" → num "7", sectors "A–D". */
export interface PlatformParts { num: string; sectors: string }

const VEH_MIN_ZOOM = 14;
const BODY_MIN_ZOOM = 15; // from here a vehicle is drawn as its body
const VEH_PILL_ZOOM = 16; // from here the vehicle shows its line number too
export const VEH_FC: LiveVehicleCollection = { type: 'FeatureCollection', features: [] };
const VEH_MAX = 300; // enough for a city centre, light enough for a phone
let vehList: LiveVehicle[] = [], vehBox: KanteBbox | null = null, vehES: EventSource | null = null, vehPollTimer: number | null = null, vehBusy = false, vehReq = 0;
// Drawing: about 12 times a second (smooth at street zoom, light enough for a phone), not while the map is moved
const VEH_FRAME_MS = 80, VEH_FRAME_MOVING_MS = 160; // while the map is moved: less often, not not at all
let vehRaf = 0, vehDrawnAt = 0;
// ---- The base map's red lines (swisstopo's rails and tram tracks, layers public_transport…): a vehicle on rails is
//      drawn on them where they run within RED_SNAP_M of the engine's way and the same way (KANTE_LIVE.setLineRefiner).
//      Further off (a diversion, a line the drawing lacks) the engine's way stays: the drawing never decides the route.
const RED_SOURCE = 'base_v1.0.0', RED_SNAP_M = 6, RED_COS = Math.cos(35 * Math.PI / 180), RED_CELL = 0.0005, RED_STEP_M = 8;
type Seg = [LngLat, LngLat, number, boolean]; // and the line (feature) it is part of, whether that runs in a tunnel
let redGrid: Map<string, Seg[]> | null = null, redTimer = 0;
const redKey = (x: number, y: number) => x + ',' + y;
let redSig = '';
function loadRed() {
  // only where the map draws them (not on the satellite view)
  if (!map.getLayer('public_transport') || !map.getSource(RED_SOURCE)) { redGrid = null; redSig = ''; KANTE_LIVE.setLineRefiner(null); return; }
  const feats = map.querySourceFeatures(RED_SOURCE, { sourceLayer: 'transportation', filter: ['in', ['get', 'class'], ['literal', ['rail', 'transit']]] });
  const grid = new Map<string, Seg[]>();
  let segs = 0;
  feats.forEach((f, fid) => {
    const g = f.geometry, tunnel = (f.properties || {}).brunnel === 'tunnel';
    const lines = g.type === 'LineString' ? [g.coordinates as LngLat[]] : g.type === 'MultiLineString' ? (g.coordinates as LngLat[][]) : [];
    for (const l of lines) for (let k = 0; k + 1 < l.length; k++) {
      const a = l[k], b = l[k + 1];
      for (let x = Math.floor(Math.min(a[0], b[0]) / RED_CELL); x <= Math.floor(Math.max(a[0], b[0]) / RED_CELL); x++)
        for (let y = Math.floor(Math.min(a[1], b[1]) / RED_CELL); y <= Math.floor(Math.max(a[1], b[1]) / RED_CELL); y++) {
          const key = redKey(x, y), list = grid.get(key);
          if (list) list.push([a, b, fid, tunnel]); else grid.set(key, [[a, b, fid, tunnel]]);
          segs++;
        }
    }
  });
  // the same lines as last time (tiles that came in elsewhere, a move within them): the ways laid onto them stay
  const sig = `${feats.length}|${segs}|${grid.size}`;
  if (sig === redSig && redGrid) return;
  redSig = sig;
  redGrid = grid.size ? grid : null;
  KANTE_LIVE.setLineRefiner(redGrid ? redRefine : null);
}
// once the map has its tiles around: after a move, and as tiles of the base map come in
const redSoon = () => { clearTimeout(redTimer); if (vehBox) redTimer = window.setTimeout(loadRed, 400); };
/** Whether the red line nearest p (within 8 m) runs in a tunnel: the vehicle there is underground. */
function underground(p: LngLat): boolean {
  if (!redGrid) return false;
  const kx = 111320 * Math.cos(p[1] * Math.PI / 180), ky = 110540, cx = Math.floor(p[0] / RED_CELL), cy = Math.floor(p[1] / RED_CELL);
  let best = 8, tunnel = false;
  for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) for (const [a, b, , t] of redGrid.get(redKey(x, y)) || []) {
    const sx = (b[0] - a[0]) * kx, sy = (b[1] - a[1]) * ky, l2 = sx * sx + sy * sy;
    const u = l2 ? Math.max(0, Math.min(1, (((p[0] - a[0]) * kx) * sx + ((p[1] - a[1]) * ky) * sy) / l2)) : 0;
    const d = Math.hypot(a[0] * kx + u * sx - p[0] * kx, a[1] * ky + u * sy - p[1] * ky);
    if (d < best) { best = d; tunnel = t; }
  }
  return tunnel;
}
/** The way laid onto the red lines where they run beside it (within RED_SNAP_M, at most 35° off its direction). */
function redRefine(pts: LngLat[]): LngLat[] | null {
  if (!redGrid) return null;
  const kx = 111320 * Math.cos(pts[0][1] * Math.PI / 180), ky = 110540;
  // every RED_STEP_M along the way, so the drawing's bends are followed too
  const dense: LngLat[] = [pts[0]];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k], n = Math.max(1, Math.ceil(Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * ky) / RED_STEP_M));
    for (let s = 1; s <= n; s++) dense.push([a[0] + (b[0] - a[0]) * s / n, a[1] + (b[1] - a[1]) * s / n]);
  }
  let any = false, prev = -1; // the line the sample before was laid onto
  const out = dense.map((q, k) => {
    const p0 = dense[Math.max(0, k - 1)], p1 = dense[Math.min(dense.length - 1, k + 1)];
    const dx = (p1[0] - p0[0]) * kx, dy = (p1[1] - p0[1]) * ky, dl = Math.hypot(dx, dy);
    if (!dl) return q;
    // the nearest place on each red line beside it (within RED_SNAP_M, running its way)
    const near = new Map<number, { d: number; p: LngLat }>();
    const cx = Math.floor(q[0] / RED_CELL), cy = Math.floor(q[1] / RED_CELL);
    for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) for (const [a, b, fid] of redGrid!.get(redKey(x, y)) || []) {
      const sx = (b[0] - a[0]) * kx, sy = (b[1] - a[1]) * ky, sl = Math.hypot(sx, sy);
      if (!sl || Math.abs((sx * dx + sy * dy) / (sl * dl)) < RED_COS) continue; // crossing, not beside
      const t = Math.max(0, Math.min(1, (((q[0] - a[0]) * kx) * sx + ((q[1] - a[1]) * ky) * sy) / (sl * sl)));
      const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t, d = Math.hypot((px - q[0]) * kx, (py - q[1]) * ky);
      const cur = near.get(fid);
      if (d <= RED_SNAP_M && (!cur || d < cur.d)) near.set(fid, { d, p: [px, py] });
    }
    const ranked = [...near.entries()].sort((x, y) => x[1].d - y[1].d);
    if (!ranked.length) { prev = -1; return q; }
    // on along the line it was on, where that is still about as near; two other lines about as near (tracks side by
    // side, the way between them): neither, the engine's way
    const kept = near.get(prev);
    let pick: [number, { d: number; p: LngLat }] | null = kept && kept.d <= ranked[0][1].d + 2 ? [prev, kept] : ranked[0];
    if (pick[0] !== prev && ranked.length > 1 && ranked[1][1].d - ranked[0][1].d < 1) pick = null;
    prev = pick ? pick[0] : -1;
    if (pick) any = true;
    if (!pick) return q;
    // fully onto the line within RED_SNAP_M / 2, fading back to the engine's way towards RED_SNAP_M
    const w = Math.min(1, Math.max(0, (RED_SNAP_M - pick[1].d) / (RED_SNAP_M / 2)));
    return [q[0] + (pick[1].p[0] - q[0]) * w, q[1] + (pick[1].p[1] - q[1]) * w] as LngLat;
  });
  // the ends stay where the vehicle stands at its stops
  out[0] = pts[0];
  out[out.length - 1] = pts[pts.length - 1];
  return any ? out : null;
}

// What is shown of each vehicle (KANTE_LIVE.showVehicle: glided to each newer answer, not jumped to)
const shown = new Map<string, KanteShownVehicle<LiveVehicle>>();
const vehKey = (v: LiveVehicle) => v.tripId + '|' + v.serviceDate;
// When the vehicles' data came in (vehAt, ms) and the engine's time it is for (vehT, unix s). Older than VEH_DIM_MS
// (the stream stalled, polls fail) they are drawn faded; older than VEH_DROP_MS they are taken off the map.
let vehAt = 0, vehT = 0;
const VEH_DIM_MS = 45000, VEH_DROP_MS = 120000;
// The engine's "now" for the vehicles: their t plus the time since they came (so a wrong phone clock doesn't matter)
const vehNow = () => vehT + (Date.now() - vehAt) / 1000;
export function vehLayers(theme: Theme): maplibregl.LayerSpecification[] {
  const dark = theme === 'dark';
  // estimated from the timetable alone (no live data, or none for a while): faded, so it is not taken for live
  const fade: maplibregl.ExpressionSpecification = ['case', ['get', 'dim'], .45, 1];
  // What each vehicle is, as a pictogram in its line's colour (sprites.ts), below BODY_MIN_ZOOM (from there: paint())
  return [
    { id: 'kveh-dot', type: 'symbol', source: 'kveh', minzoom: VEH_MIN_ZOOM, maxzoom: BODY_MIN_ZOOM,
      layout: { 'icon-image': ['get', dark ? 'iconD' : 'icon'],
                'icon-size': ['interpolate', ['exponential', 1.5], ['zoom'], VEH_MIN_ZOOM, .62, 16, .8, 18, 1.15, 20, 1.9],
                'icon-allow-overlap': true, 'icon-ignore-placement': true },
      paint: { 'icon-opacity': fade } },
  ];
}
// During a journey: the trips of its rides (`tripId|serviceDate`), and the box around their stops
function journeyTrips(): Set<string> | null {
  if (!journey.dest || !journey.conn) return null;
  return new Set(journey.conn.parts.filter(isRide).flatMap((s) => s.legs.map((l) => l.tripId + '|' + l.serviceDate)));
}
function journeyBox(): KanteBbox | null {
  if (!journey.conn) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const r of journey.conn.parts.filter(isRide)) for (const c of r.stops) {
    w = Math.min(w, c.quay.lon); e = Math.max(e, c.quay.lon); s = Math.min(s, c.quay.lat); n = Math.max(n, c.quay.lat);
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}
// what the vehicles are fetched for: 'map' (all around, from zoom 14, when Settings has them on) or a journey's trips
let vehMode = '';
const vehWanted = () => !!KANTE && KANTE.ok() && !document.hidden && (journey.dest
  ? !!journeyTrips()?.size
  : map.getZoom() >= VEH_MIN_ZOOM && SETTINGS.prefs().liveVehicles !== false);
/** The live layer shows this trip's vehicle now (a journey's ride: then its own marker is not needed). */
export function vehShowsTrip(tripId: string, serviceDate: string) {
  return Date.now() - vehAt < VEH_DIM_MS && vehList.some((v) => v.tripId === tripId && v.serviceDate === serviceDate);
}
export function vehStop() {
  vehReq++;
  if (vehES) { vehES.close(); vehES = null; }
  clearInterval(vehPollTimer);
  cancelAnimationFrame(vehRaf);
  vehPollTimer = null;
  vehRaf = 0;
  vehDrawnKey = '';
  vehMode = '';
  shown.clear();
  vehBox = null;
  vehList = [];
  vehAt = vehT = 0;
  vehPopup.remove();
  vehDraw();
  paint();
}
export function vehUpdate() {
  if (!vehWanted()) { if (vehBox || vehList.length) vehStop(); return; }
  const trips = journeyTrips(), mode = trips ? [...trips].sort().join(',') : 'map';
  const b = map.getBounds(), view: KanteBbox = trips ? journeyBox()! : [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
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
  vehBox = KANTE_LIVE.padBbox(view, trips ? .3 : .35);
  if (!KANTE_LIVE.bboxOk(vehBox)) { vehBox = null; return; }
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
  // every frame: the canvas (while the map moves, from its render event, so both move as one), and the pictograms
  // below zoom 15 (through the map's data: a few times a second)
  const frame = () => {
    vehRaf = requestAnimationFrame(frame);
    if (!vehList.length && !VEH_FC.features.length) { if (vehHits.length) paint(); return; } // (clear what was drawn)
    if (!map.isMoving()) paint();
    const t = performance.now();
    if (t - vehDrawnAt < (map.isMoving() ? VEH_FRAME_MOVING_MS : VEH_FRAME_MS)) return;
    vehDrawnAt = t;
    vehDraw();
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
  vehAt = Date.now();
  vehT = data && Number.isFinite(data.t) ? data.t : vehAt / 1000;
  // each vehicle is placed from its frac at the response's t
  const trips = journeyTrips();
  vehList = ((data && data.vehicles) || []).filter((v) => !trips || trips.has(v.tripId + '|' + v.serviceDate)).slice(0, VEH_MAX)
    .map((v) => ({ ...v, t: vehT, j: KANTE_LIVE.journeyLike(v.line), info: KANTE_LIVE.liveInfoOf(v) }));
  const keys = new Set(vehList.map(vehKey));
  for (const k of shown.keys()) if (!keys.has(k)) shown.delete(k);
  if (!redGrid) redSoon();
  vehDraw();
}
// Where vehicle v is shown at tNow (the engine's clock), at ms (the page's clock)
function vehShownAt(v: LiveVehicle, tNow: number, ms: number): LngLat {
  const k = vehKey(v), s = KANTE_LIVE.showVehicle(shown.get(k), v, tNow, ms);
  shown.set(k, s);
  return s.ll;
}
// ---- From zoom 15 the vehicles are drawn on a canvas over the map, every frame (in step with the map while it moves),
//      not through the map's data (which redraws a fraction of a second later, so they could only step): each as its
//      parts seen from above, as long and wide as such a vehicle — tram sections, a bus (two halves where articulated),
//      the coaches of a train — with a cab window at the front, in a colour of its own (none of the vehicles near it
//      has it when it first shows, and it keeps it), the line number on it from zoom 16, dashed where it runs in a
//      tunnel. ----
// How a vehicle of this kind is made up, metres: [lengths of its parts], width. Swiss trams 36–43 m in five or so
// sections (Combino, Flexity, Cobra), city buses articulated (18 m), PostAuto's 12 m, regional trains about 100 m
// (FLIRT, KISS in pairs), long-distance ones 300 m in coaches of 25 m
const LONG_DISTANCE = /^(IC|ICE|ICN|IR|IRE|EC|EN|NJ|TGV|RJ|RJX|PE|EXT)$/;
const repeat = (n: number, len: number) => Array.from({ length: n }, () => len);
function partsOf(v: LiveVehicle): [number[], number] {
  const cat = (v.line.category || '').toUpperCase();
  switch (v.line.mode) {
    case 'tram': return [[9, 6, 9, 6, 9], 2.4];
    case 'bus': case 'ondemand': return [/PostAuto|CarPostal|AutoPostale/i.test(v.line.operator || '') ? [12] : [10.5, 7.5], 2.55];
    case 'rail': return [LONG_DISTANCE.test(cat) ? repeat(12, 25) : repeat(4, 25), 2.9];
    case 'metro': return [repeat(3, 20), 2.7];
    case 'rack': return [repeat(2, 24), 2.65];
    case 'funicular': return [[25], 2.6];
    case 'cableway': return [[8], 3];
    case 'boat': return [[50], 9];
    default: return [[12], 2.5];
  }
}
const PART_GAP_M = 0.8; // between two parts (a joint, a coupling)
// Colours a vehicle can have: far apart from each other, plain on the light and the dark map
const VEH_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0fb5c9', '#f032e6', '#8cc63f', '#469990', '#9a6324',
  '#800000', '#000075', '#808000', '#d4a106', '#ff6f91', '#5b5b5b'];
const vehColor = new Map<string, number>();
const NEAR_KM = 2; // vehicles nearer than this never share a colour when one of them first shows
function colorOf(k: string, at: LngLat): string {
  let c = vehColor.get(k);
  if (c == null) {
    const used = new Map<number, number>();
    for (const [o, s] of shown) {
      const oc = vehColor.get(o);
      if (oc != null && o !== k && KANTE_LIVE.distKm(s.ll, at) < NEAR_KM) used.set(oc, (used.get(oc) || 0) + 1);
    }
    // from a place its trip names (so a reload tends to give the same), the first colour none near it has
    let h = 0;
    for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
    let best = h % VEH_COLORS.length, bestN = Infinity;
    for (let j = 0; j < VEH_COLORS.length; j++) {
      const i = (h + j) % VEH_COLORS.length, n = used.get(i) || 0;
      if (n < bestN) { best = i; bestN = n; }
      if (n === 0) break;
    }
    c = best;
    vehColor.set(k, c);
  }
  return VEH_COLORS[c];
}
// A colour a third of the way to black: the edge
function darker(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16), f = (x: number) => Math.round(x * 0.6).toString(16).padStart(2, '0');
  return '#' + f(n >> 16) + f((n >> 8) & 255) + f(n & 255);
}
// The points of a line from metre a to metre b along it
function cutLine(pts: LngLat[], cum: number[], a: number, b: number): LngLat[] {
  const at = (m: number): LngLat => {
    let k = 1;
    while (k < cum.length - 1 && cum[k] < m) k++;
    const l = cum[k] - cum[k - 1], t = l > 0 ? Math.max(0, Math.min(1, (m - cum[k - 1]) / l)) : 0;
    return [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * t, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * t];
  };
  const out = [at(a)];
  for (let k = 1; k < pts.length - 1; k++) if (cum[k] > a && cum[k] < b) out.push(pts[k]);
  out.push(at(b));
  return out;
}

let vcv: HTMLCanvasElement | null = null, vctx: CanvasRenderingContext2D | null = null;
/** What was drawn of each vehicle, for taps: its index, its body in screen pixels, half its width. */
let vehHits: { i: number; pts: { x: number; y: number }[]; half: number }[] = [];
function canvasSize() {
  if (!vcv) return;
  const c = map.getCanvas(), dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (vcv.width !== Math.round(w * dpr) || vcv.height !== Math.round(h * dpr)) {
    vcv.width = Math.round(w * dpr);
    vcv.height = Math.round(h * dpr);
    vcv.style.width = w + 'px';
    vcv.style.height = h + 'px';
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
let paintedAt = -1;
function paint() {
  const now = performance.now();
  if (now === paintedAt) return;
  paintedAt = now;
  const ctx = canvasReady();
  if (!ctx || !vcv) return;
  canvasSize();
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vcv.width / dpr, vcv.height / dpr);
  vehHits = [];
  const zoom = map.getZoom();
  if (zoom < BODY_MIN_ZOOM || !vehList.length) return;
  const age = Date.now() - vehAt, old = age > VEH_DIM_MS, tNow = vehNow(), dark = currentTheme() === 'dark';
  const lat = map.getCenter().lat, pxPerM = 1 / (40075016.686 * Math.cos(lat * Math.PI / 180) / (512 * 2 ** zoom));
  const b = map.getBounds().toArray(), pad = 0.01;
  const inView = (p: LngLat) => p[0] > b[0][0] - pad && p[0] < b[1][0] + pad && p[1] > b[0][1] - pad && p[1] < b[1][1] + pad;
  vehList.forEach((v, i) => {
    const k = vehKey(v), s = KANTE_LIVE.showVehicle(shown.get(k), v, tNow, now);
    shown.set(k, s);
    if (!inView(s.ll)) return;
    const [parts, width] = partsOf(v), len = parts.reduce((a, x) => a + x, 0) + PART_GAP_M * (parts.length - 1);
    const fill = colorOf(k, s.ll), edge = darker(fill), live = v.info && v.info.state !== 'stale' && v.info.state !== 'timetable';
    const body = KANTE_LIVE.bodyAt(s.rec, s.f, len);
    const wpx = Math.max(3, width * pxPerM);
    ctx.globalAlpha = old || !live ? 0.5 : 1;
    if (!body || body.length < 2) {
      // its way not known: a dot where it is
      const p = map.project(s.ll);
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(4, wpx), 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = edge; ctx.stroke();
      vehHits.push({ i, pts: [p], half: Math.max(4, wpx) });
      return;
    }
    // the body in metres along it (back to front), cut into its parts
    const cum = [0];
    for (let j = 1; j < body.length; j++) cum.push(cum[j - 1] + KANTE_LIVE.distKm(body[j - 1], body[j]) * 1000);
    const scale = cum[cum.length - 1] / len || 1;
    let from = 0;
    const screen = body.map((p) => map.project(p));
    vehHits.push({ i, pts: screen, half: wpx / 2 + 1 });
    ctx.lineJoin = 'round';
    parts.forEach((pl, j) => {
      const a = from * scale, z = (from + pl) * scale;
      from += pl + PART_GAP_M;
      const seg = cutLine(body, cum, a, z).map((p) => map.project(p));
      const mid = cutLine(body, cum, (a + z) / 2, (a + z) / 2)[0];
      const tunnel = underground(mid);
      const path = () => { ctx.beginPath(); seg.forEach((q, n) => (n ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); };
      // edge, then the part: a dashed edge in a tunnel, the part paler there
      ctx.lineCap = 'butt';
      ctx.setLineDash(tunnel ? [Math.max(3, wpx * 0.9), Math.max(2, wpx * 0.6)] : []);
      path(); ctx.lineWidth = wpx + 2.2; ctx.strokeStyle = edge; ctx.stroke();
      ctx.setLineDash([]);
      path(); ctx.lineWidth = wpx; ctx.strokeStyle = fill;
      const a0 = ctx.globalAlpha;
      if (tunnel) ctx.globalAlpha = a0 * 0.45;
      ctx.stroke();
      ctx.globalAlpha = a0;
      // the cab window at the front
      if (j === parts.length - 1 && wpx >= 5) {
        const glass = cutLine(body, cum, Math.max(a, z - 1.1 * scale), z - 0.25 * scale).map((p) => map.project(p));
        ctx.beginPath(); glass.forEach((q, n) => (n ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.lineWidth = wpx * 0.7; ctx.strokeStyle = dark ? 'rgba(200,225,255,.85)' : 'rgba(25,40,60,.8)'; ctx.stroke();
      }
    });
    // the line number on it, in the line's colours
    if (zoom >= VEH_PILL_ZOOM) {
      const mid = map.project(cutLine(body, cum, cum[cum.length - 1] / 2, cum[cum.length - 1] / 2)[0]);
      const c = lineColor(v.j), label = lineLabel(v.j);
      ctx.font = '600 11px system-ui, -apple-system, Segoe UI, sans-serif';
      const tw = ctx.measureText(label).width, bw = tw + 10, bh = 16;
      ctx.beginPath();
      (ctx as CanvasRenderingContext2D & { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect
        ? ctx.roundRect(mid.x - bw / 2, mid.y - bh / 2, bw, bh, 5) : ctx.rect(mid.x - bw / 2, mid.y - bh / 2, bw, bh);
      ctx.fillStyle = dark ? c.dbg : c.bg; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.stroke();
      ctx.fillStyle = dark ? c.dfg : c.fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, mid.x, mid.y + 0.5);
    }
  });
  ctx.globalAlpha = 1;
}
/** The vehicle drawn under a tap at point p (screen pixels), or null. */
function vehicleAt(p: { x: number; y: number }): number | null {
  let best: number | null = null, bestD = 10;
  for (const h of vehHits) {
    let d = Infinity;
    if (h.pts.length === 1) d = Math.hypot(h.pts[0].x - p.x, h.pts[0].y - p.y) - h.half;
    for (let k = 1; k < h.pts.length; k++) {
      const a = h.pts[k - 1], b = h.pts[k], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
      d = Math.min(d, Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y) - h.half);
    }
    if (d < bestD) { bestD = d; best = h.i; }
  }
  return best;
}
const vehProps = new WeakMap<LiveVehicle, Omit<LiveVehicleProps, 'dim'> & { live: boolean }>();
function propsOf(v: LiveVehicle, i: number) {
  let p = vehProps.get(v);
  if (!p) {
    const c = lineColor(v.j), st = v.info && v.info.state;
    const glyph = vehicleGlyph(v.line.mode), x = v.extra ? 'x' : '', label = lineLabel(v.j);
    const id = (bg: string, fg: string, text: string, theme: string) => ['vh', glyph, bg.slice(1), fg.slice(1), text, x, theme].join('|');
    p = { i, label, extra: !!v.extra, live: st !== 'stale' && st !== 'timetable',
      icon: id(c.bg, c.fg, '', 'light'), pill: id(c.bg, c.fg, label, 'light'), iconD: id(c.dbg, c.dfg, '', 'dark'), pillD: id(c.dbg, c.dfg, label, 'dark') };
    vehProps.set(v, p);
  }
  return p;
}
let vehDrawnKey = '';
function vehDraw() {
  const age = Date.now() - vehAt;
  if (vehList.length && age > VEH_DROP_MS) { vehList = []; vehPopup.remove(); }
  if (!vehList.length && !VEH_FC.features.length) return; // nothing shown, nothing to show
  const now = vehNow(), old = age > VEH_DIM_MS, ms = performance.now();
  // from zoom 15 the canvas draws them (paint()): no pictograms
  VEH_FC.features = map.getZoom() >= BODY_MIN_ZOOM + 0.5 ? [] : vehList.map((v, i) => {
    const { live, ...p } = propsOf(v, i), at = vehShownAt(v, now, ms);
    return { type: 'Feature', geometry: { type: 'Point', coordinates: at }, properties: { ...p, i, dim: old || !live } };
  });
  // nothing moved (all standing, or less than about 10 cm): the map keeps what it has
  const key = VEH_FC.features.map((f) => f.geometry.coordinates.map((c) => c.toFixed(6)).join() + (f.properties.dim ? 'd' : '')).join(';');
  if (key === vehDrawnKey) return;
  vehDrawnKey = key;
  const src = map.getSource<maplibregl.GeoJSONSource>('kveh');
  if (src) src.setData(VEH_FC);
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
    let v: LiveVehicle | null = null, at: LngLat | null = null;
    if (map.getZoom() >= BODY_MIN_ZOOM) {
      // the vehicles drawn on the canvas
      const i = vehicleAt(e.point);
      v = i == null ? null : vehList[i];
      at = v ? (shown.get(vehKey(v)) || { ll: v.from }).ll : null;
    } else if (map.getLayer('kveh-dot')) {
      const r = 14; // forgiving tap, as for platforms
      const hits = map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers: ['kveh-dot'] });
      const dist = (x: maplibregl.MapGeoJSONFeature) => map.project((x.geometry as GeoJSON.Point).coordinates as LngLat).dist(e.point);
      const f = hits.length ? hits.reduce((a, b) => (dist(b) < dist(a) ? b : a)) : null;
      v = f ? vehList[f.properties.i] : null;
      at = f ? (f.geometry as GeoJSON.Point).coordinates as LngLat : null;
    }
    if (!v || !at) return;
    const now = vehNow(), old = Date.now() - vehAt > VEH_DIM_MS;
    // "Left its last stop … (measured)" only when under way after a measured departure from that stop
    const measured = !old && KANTE_LIVE.vehicleLeftMeasured(v);
    const how = old ? { text: `Not updated for ${Math.round((Date.now() - vehAt) / 60000) || 1} min: the live data is not coming through` }
      : KANTE_LIVE.liveText(v.info, { basis: v.basis, from: measured ? 'its last stop' : null, leftS: measured ? Math.max(0, now - v.dep) : null });
    const body = h('div', null,
      h('div', 'pf-head', kBadge(v.j), h('span', 'pf-name', h('b', null, `to ${v.headsign}`), h('small', null, `Next stop: ${v.nextStop}`))),
      v.extra ? h('p', 'pf-note vh-extra', 'Extra journey, not in the timetable') : null,
      h('p', 'vh-how', how.text));
    platformPopup.remove();
    vehPopup.setLngLat(at).setDOMContent(body).addTo(map);
  });
  map.on('mouseenter', 'kveh-dot', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'kveh-dot', () => { map.getCanvas().style.cursor = ''; });
  map.on('moveend', vehUpdate);
  // the canvas: drawn with the map while it moves (so they move as one), sized with it
  map.on('render', () => { if (map.isMoving() && vehList.length) paint(); });
  map.on('resize', () => { canvasSize(); paint(); });
  // the red lines to draw vehicles on rails onto: again after a move and as the base map's tiles come in
  map.on('moveend', redSoon);
  map.on('styledata', redSoon);
  map.on('sourcedata', (e) => { if (e.sourceId === RED_SOURCE && e.isSourceLoaded && vehList.length) redSoon(); });
}
