// ---- Live vehicles on the map, from zoom 14: the engine's stream when it has one, else every 15 s. During a journey
//      only the vehicles of its rides (at any zoom, the one coming to your stop too). Not while the page is hidden.
//      From zoom 15 each is drawn as its body: as long and wide as such a vehicle is, along its way, in its line's
//      colour. ----
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
  /** Its body is drawn (from zoom 15): no pictogram there, only the line number from VEH_PILL_ZOOM. */
  body: boolean;
}
export type LiveVehicleCollection = GeoJSON.FeatureCollection<GeoJSON.Point, LiveVehicleProps>;
/** What the map's 'kvehBody' source says about a vehicle's body: its width (m), colours (light and dark map), faded. */
export interface LiveVehicleBodyProps { w: number; fill: string; edge: string; fillD: string; edgeD: string; dim: boolean }
export const VEH_BODY_FC: GeoJSON.FeatureCollection<GeoJSON.LineString, LiveVehicleBodyProps> = { type: 'FeatureCollection', features: [] };
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
type Seg = [LngLat, LngLat, number]; // and the line (feature) it is part of
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
    const g = f.geometry;
    const lines = g.type === 'LineString' ? [g.coordinates as LngLat[]] : g.type === 'MultiLineString' ? (g.coordinates as LngLat[][]) : [];
    for (const l of lines) for (let k = 0; k + 1 < l.length; k++) {
      const a = l[k], b = l[k + 1];
      for (let x = Math.floor(Math.min(a[0], b[0]) / RED_CELL); x <= Math.floor(Math.max(a[0], b[0]) / RED_CELL); x++)
        for (let y = Math.floor(Math.min(a[1], b[1]) / RED_CELL); y <= Math.floor(Math.max(a[1], b[1]) / RED_CELL); y++) {
          const key = redKey(x, y), list = grid.get(key);
          if (list) list.push([a, b, fid]); else grid.set(key, [[a, b, fid]]);
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
// Metres on the map at zoom 15 and 22 in pixels (MapLibre's 512 px tiles, at Switzerland's latitude, ~47°)
const PX_PER_M_15 = 32768 / 53483, PX_PER_M_22 = 4194304 / 53483;
export function vehLayers(theme: Theme): maplibregl.LayerSpecification[] {
  const dark = theme === 'dark';
  // estimated from the timetable alone (no live data, or none for a while): faded, so it is not taken for live
  const fade: maplibregl.ExpressionSpecification = ['case', ['get', 'dim'], .45, 1];
  const metres = (extra: number): maplibregl.ExpressionSpecification =>
    ['interpolate', ['exponential', 2], ['zoom'], BODY_MIN_ZOOM, ['*', ['+', ['get', 'w'], extra], PX_PER_M_15], 22, ['*', ['+', ['get', 'w'], extra], PX_PER_M_22]];
  // What each vehicle is, as a pictogram in its line's colour (sprites.ts); from BODY_MIN_ZOOM its body instead (as
  // long and wide as such a vehicle, along its way, edged darker), from VEH_PILL_ZOOM with the line number on it.
  return [
    { id: 'kveh-body-edge', type: 'line', source: 'kvehBody', minzoom: BODY_MIN_ZOOM,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-color': ['get', dark ? 'edgeD' : 'edge'], 'line-width': metres(0.9), 'line-opacity': fade } },
    { id: 'kveh-body', type: 'line', source: 'kvehBody', minzoom: BODY_MIN_ZOOM,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-color': ['get', dark ? 'fillD' : 'fill'], 'line-width': metres(0), 'line-opacity': fade } },
    { id: 'kveh-dot', type: 'symbol', source: 'kveh', minzoom: VEH_MIN_ZOOM,
      layout: { 'icon-image': ['step', ['zoom'], ['get', dark ? 'iconD' : 'icon'],
                  BODY_MIN_ZOOM, ['case', ['get', 'body'], '', ['get', dark ? 'iconD' : 'icon']], VEH_PILL_ZOOM, ['get', dark ? 'pillD' : 'pill']],
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
  // glide along their ways; not while the map is being moved (each redraw re-places every label on the map)
  const frame = () => {
    vehRaf = requestAnimationFrame(frame);
    const t = performance.now();
    if (t - vehDrawnAt < (map.isMoving() ? VEH_FRAME_MOVING_MS : VEH_FRAME_MS) || (!vehList.length && !VEH_FC.features.length)) return;
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
// How long and wide a vehicle of this kind is, metres: Swiss trams 36–43 m (Combino, Flexity, Cobra), city buses
// articulated (18 m), PostAuto's 12 m, regional trains about 100 m (FLIRT, KISS in pairs), long-distance ones 300 m
const LONG_DISTANCE = /^(IC|ICE|ICN|IR|IRE|EC|EN|NJ|TGV|RJ|RJX|PE|EXT)$/;
function bodySize(v: LiveVehicle): [number, number] {
  const cat = (v.line.category || '').toUpperCase();
  switch (v.line.mode) {
    case 'tram': return [40, 2.4];
    case 'bus': case 'ondemand': return [/PostAuto|CarPostal|AutoPostale/i.test(v.line.operator || '') ? 12 : 18, 2.55];
    case 'rail': return [LONG_DISTANCE.test(cat) ? 300 : 100, 2.9];
    case 'metro': return [60, 2.7];
    case 'rack': return [50, 2.65];
    case 'funicular': return [25, 2.6];
    case 'cableway': return [8, 3];
    case 'boat': return [50, 9];
    default: return [12, 2.5];
  }
}
// A colour a third of the way to black: the body's edge
function darker(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16), f = (x: number) => Math.round(x * 0.62).toString(16).padStart(2, '0');
  return '#' + f(n >> 16) + f((n >> 8) & 255) + f(n & 255);
}
const vehBodies = new WeakMap<LiveVehicle, Omit<LiveVehicleBodyProps, 'dim'> & { len: number }>();
function bodyOf(v: LiveVehicle) {
  let b = vehBodies.get(v);
  if (!b) {
    const c = lineColor(v.j), [len, w] = bodySize(v);
    b = { len, w, fill: c.bg, edge: darker(c.bg), fillD: c.dbg, edgeD: darker(c.dbg) };
    vehBodies.set(v, b);
  }
  return b;
}
const vehProps = new WeakMap<LiveVehicle, Omit<LiveVehicleProps, 'dim' | 'body'> & { live: boolean }>();
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
  const now = vehNow(), old = age > VEH_DIM_MS, ms = performance.now(), bodies = map.getZoom() >= BODY_MIN_ZOOM - 0.5;
  VEH_BODY_FC.features = [];
  VEH_FC.features = vehList.map((v, i) => {
    const { live, ...p } = propsOf(v, i), at = vehShownAt(v, now, ms), dim = old || !live;
    // its body, only where it is drawn (from zoom 15): the stretch of its way it covers
    const s = bodies ? shown.get(vehKey(v)) : null, b = bodyOf(v);
    const line = s ? KANTE_LIVE.bodyAt(s.rec, s.f, b.len) : null;
    if (line && line.length > 1) {
      const { len, ...bp } = b;
      VEH_BODY_FC.features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: { ...bp, dim } });
    }
    return { type: 'Feature', geometry: { type: 'Point', coordinates: at }, properties: { ...p, i, dim, body: !!line } };
  });
  // nothing moved (all standing, or less than about 10 cm): the map keeps what it has
  const key = VEH_FC.features.map((f) => f.geometry.coordinates.map((c) => c.toFixed(6)).join() + (f.properties.dim ? 'd' : '') + (f.properties.body ? 'b' : '')).join(';');
  if (key === vehDrawnKey) return;
  vehDrawnKey = key;
  const src = map.getSource<maplibregl.GeoJSONSource>('kveh'), body = map.getSource<maplibregl.GeoJSONSource>('kvehBody');
  if (src) src.setData(VEH_FC);
  if (body) body.setData(VEH_BODY_FC);
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
    if (!vehList.length || !map.getLayer('kveh-dot')) return;
    const r = 14; // forgiving tap, as for platforms
    const hits = map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers: ['kveh-dot'] });
    const dist = (x: maplibregl.MapGeoJSONFeature) => map.project((x.geometry as GeoJSON.Point).coordinates as LngLat).dist(e.point);
    const f = hits.length ? hits.reduce((a, b) => (dist(b) < dist(a) ? b : a)) : null, v = f && vehList[f.properties.i];
    if (!v) return;
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
    vehPopup.setLngLat((f!.geometry as GeoJSON.Point).coordinates as LngLat).setDOMContent(body).addTo(map);
  });
  map.on('mouseenter', 'kveh-dot', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'kveh-dot', () => { map.getCanvas().style.cursor = ''; });
  map.on('moveend', vehUpdate);
  // the red lines to draw vehicles on rails onto: again after a move and as the base map's tiles come in
  map.on('moveend', redSoon);
  map.on('styledata', redSoon);
  map.on('sourcedata', (e) => { if (e.sourceId === RED_SOURCE && e.isSourceLoaded && vehList.length) redSoon(); });
}
