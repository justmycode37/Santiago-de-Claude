// ---- Line colours: every line gets one colour of the app palette (sun stays for walks),
//      the same on its badge and on the map. [name, light bg, light text, dark bg, dark (vivid) colour] ----
import { destMarker } from './search.ts';
import { platformKey } from './platforms.ts';
import { INK } from './sprites.ts';
import { journeyProgress, stopKms } from './tracking.ts';
import { levelShort, platformOf, platformWord, splitPlatform } from './live-vehicles.ts';
import { distKm, lengthKm } from './routing.ts';
import { journey, searchState } from './state.ts';
import { SETTINGS } from '../settings.ts';
import { KANTE } from '../engine.ts';
import { KanteJourney } from '../engine-journey.ts';
import type { Journey, JourneyPart, JourneyPlatformAt, JourneyRide } from '../engine-journey.ts';
import type { RouteFeature, RouteFeatureProps } from './journey-map.ts';
import type { RoutedWalk, WalkEnd } from './routing.ts';
import type { KanteFloorChange, KanteWalkDir } from '../engine.ts';

// ---------------------------------------------------------------- lines

/** How a line runs, as far as its timetable category tells (modeOf()). */
export type LineMode = 'train' | 'tram' | 'bus' | 'boat' | 'cable';
/** What tells a line apart: a ride's line, a departure of a board, or a live vehicle's line. */
export interface LineLike { category?: string | null; number?: string | null; operator?: string | null }
/** A line's colour, one of the app's palette: badge background and text on the light theme, and on the dark one. */
export interface LineColor { name: string; bg: string; fg: string; dbg: string; dfg: string }
/**
 * One written direction of a walk as the sheet lists them (walkDirections() in sheet-content.ts): a router's,
 * the floor change the platforms imply, and at the end "Arrive at …".
 */
export interface JourneyDirection {
  kind: KanteWalkDir['kind'] | 'arrive';
  text: string;
  /** Its part of the walk's line (a single point for a floor change or the arrival); may be missing. */
  coords?: LngLat[] | null;
  /** A floor change: the floors it leads from and to. */
  from?: number;
  to?: number;
}
/** A floor change on a walk between platforms on different floors (levelChange()); `at`: where to show it. */
export interface JourneyLevelChange { from: number; to: number; at: LngLat | null | undefined; text: string }
// ---------------------------------------------------------------- steps

/** The fields a kind of step does not have. */
export type JourneyStepWithout<K extends string> = { [P in K]?: undefined };
/** What every step has. */
export interface JourneyStepBase {
  /** The last ride before this step and the first one after it. */
  prevRide?: JourneyRideStep;
  nextRide?: JourneyRideStep;
  /** stepLine() (tracking.ts): the step's line in travel order, and the geoVersion it was made for. */
  _line?: LngLat[];
  _lv?: number;
  /** walkDirections() (sheet-content.ts): the directions, and the geoVersion they were written for. */
  _dirs?: JourneyDirection[];
  _dirsV?: number;
}
/** What a walk and a change share: the way on foot. */
export interface JourneyFootStep extends JourneyStepBase {
  /** When it starts and ends, ms (by the live forecasts; null where a ride has no time). */
  t0: number | null;
  t1: number | null;
  /** The lines drawn on the map: straight ones at first, then each replaced by its routed path. */
  lines: LngLat[][];
  /** The routed walks, one for each of `lines` (a place stays empty until its walk is routed). */
  walks?: RoutedWalk[];
  /** Where the walk changes floor, when its router says so (a station model, the engine). */
  floors?: KanteFloorChange[] | null;
  // The engine's walk (KanteJourney.setWalk() and requay()):
  /** Its time on foot, to the second. */
  walkS?: number;
  /** …only an estimate: routed again, it had no answer (its straight line, timed as the engine times one). */
  walkEst?: boolean;
  /** The engine has routed it: `lines`, `walks` and `floors` are its path, directions and floor changes (its ends
   *  perhaps only guessed: the walk's approxTo / approxFrom). */
  kanteWalk?: boolean;
  // what its ends are, the revision of its route, the lines its last answer drew (a walk moved since has new ones), and for the walk to the destination the place it leads to
  ends?: [WalkEnd, WalkEnd][];
  walkRev?: number;
  _netFor?: LngLat[][];
  /** …and the ends and platforms it was routed for (walkSig()), and those alone (walkEnds()). */
  _netSig?: string;
  _netEnds?: string;
  /** Drawn by a station model (its way does not depend on the time there is: walkTimeKey()). */
  _modelDrawn?: boolean;
  /** …and what the last request was for (an answer may still be on its way). */
  _askFor?: LngLat[][];
  _askSig?: string;
  toLL?: LngLat;
}
/** On foot to the first stop, or (final) from the last stop to the destination. A trip without a ride is one final walk. */
export interface JourneyWalkStep extends JourneyFootStep,
  JourneyStepWithout<'prev' | 'walkMin' | 'points' | 's' | 'path' | 'stops' | 'stopIdx' | 'depLL' | 'arrLL' | 'depAt' | 'arrAt' | 'destTitle' | 'time' | 'end'> {
  type: 'walk';
  /** Minutes. */
  min: number;
  /** When the engine starts the walk, ms. */
  start: number | null;
  /** Where it leads: the first stop, or the destination. */
  toName: string;
  /** The last walk, to the destination. */
  final?: boolean;
  /** To the first stop: the ride that follows, and where it is boarded. */
  next?: JourneyRide;
  board?: LngLat | null;
  /** The last walk: the ride before (null: there is none), and where you got off. */
  from?: JourneyRide | null;
  alight?: LngLat | null;
}
/** Between two rides. */
export interface JourneyChangeStep extends JourneyFootStep,
  JourneyStepWithout<'min' | 'start' | 'toName' | 'final' | 'from' | 'board' | 'alight' | 's' | 'path' | 'stops' | 'stopIdx' | 'depLL' | 'arrLL' | 'depAt' | 'arrAt' | 'destTitle' | 'time' | 'end'> {
  type: 'change';
  prev: JourneyRide;
  next: JourneyRide;
  /** Minutes on foot; 0: same platform, or the timetable has no walk. */
  walkMin: number;
  /** Where you get off and where you board. */
  points: [off: LngLat | null, on: LngLat | null];
}
export interface JourneyRideStep extends JourneyStepBase,
  JourneyStepWithout<'min' | 'start' | 'toName' | 'final' | 'from' | 'board' | 'alight' | 'prev' | 'next' | 'walkMin' | 'points' | 'lines' | 'walks' | 'floors' | 'walkS' | 'kanteWalk' | 'destTitle' | 'time' | 'end'> {
  type: 'ride';
  /** When it leaves and arrives, ms (by the live forecasts; null where the stop has no time). */
  t0: number | null;
  t1: number | null;
  s: JourneyRide;
  /** The line on the map: through the stops at first (the same array as `stops`), then the track or road. */
  path: LngLat[];
  /** The stops that have a position, and each one's place in the ride's stops. */
  stops: LngLat[];
  stopIdx: number[];
  /** Where it is boarded and left: the position, and what is known of the platform. */
  depLL: LngLat | null;
  arrLL: LngLat | null;
  depAt: JourneyPlatformAt;
  arrAt: JourneyPlatformAt;
  /** stopKms() (tracking.ts): the km of each of `stops` along `path`, and the `path` they were measured on. */
  _kms?: number[];
  _kmFor?: LngLat[];
}
/** The last step: being there. */
export interface JourneyArriveStep extends JourneyStepBase,
  JourneyStepWithout<'t0' | 't1' | 'min' | 'start' | 'toName' | 'final' | 'board' | 'alight' | 'prev' | 'next' | 'walkMin' | 'points' | 'lines' | 'walks' | 'floors' | 'walkS' | 'kanteWalk' | 's' | 'path' | 'stops' | 'stopIdx' | 'depLL' | 'arrLL' | 'depAt' | 'arrAt'> {
  type: 'arrive';
  destTitle: string;
  /** When, ms: the timetable's arrival, then the live times'. */
  time: number | null | undefined;
  /** The last ride (null: there is none), and where it ends. */
  from: JourneyRide | null;
  end: LngLat | null;
}
// JourneyStep is a union of the four kinds of step, so `st.type === 'ride'` narrows it. A field only another kind
// has reads as undefined, so `st.lines || []` works on any step. A field every step has goes into JourneyStepBase,
// else into the kind it belongs to.
/** A step of the journey on show (buildSteps()): walk → ride → change → ride → … → walk → arrive. */
export type JourneyStep = JourneyWalkStep | JourneyChangeStep | JourneyRideStep | JourneyArriveStep;

const PALETTE = [
  ['navy', '#344D77', '#FFFFFF', '#141D2D', '#9DB4DD'],
  ['rose', '#C55A82', '#FFFFFF', '#2C1520', '#E28CAD'],
  ['tang', '#FF7241', INK, '#2E1810', '#FF7241'],
].map(([name, bg, fg, dbg, dfg]) => ({ name, bg, fg, dbg, dfg }));
const colorNamed = (n: string): LineColor => PALETTE.find((p) => p.name === n) || PALETTE[0];
// Zürich's trams are known by their colour (VBZ network map, snapped to the palette)
const VBZ_TRAM: Record<string, string> = { 2: 'rose', 3: 'navy', 4: 'navy', 5: 'tang', 6: 'tang', 7: 'navy', 8: 'navy', 9: 'rose', 10: 'rose', 11: 'navy', 13: 'tang', 14: 'navy', 15: 'rose', 17: 'rose' };
const LONG_DISTANCE = /^(IC|ICE|ICN|EC|IR|IRE|RE|RJ|RJX|TGV|NJ|EN|PE|GEX|BEX|VAE|TER|RB|EXT)/;
function hashText(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const lineColors = new Map<string, LineColor>();
export function lineColor(j: LineLike): LineColor {
  const cat = (j.category || '').toUpperCase(), num = String(j.number || ''), label = lineLabel(j);
  const key = `${j.operator || ''}|${cat}|${num}`;
  if (lineColors.has(key)) return lineColors.get(key)!;
  const mode = modeOf(cat);
  let c;
  if (mode === 'tram' && /VBZ|Verkehrsbetriebe Z/i.test(j.operator || '') && VBZ_TRAM[num]) c = colorNamed(VBZ_TRAM[num]);
  else if (/^(BN|TN|SN|NB)$/.test(cat) || /^(N|SN)\d/.test(label)) c = colorNamed('navy'); // night services
  else if (mode === 'boat') c = colorNamed('navy');
  else if (mode === 'cable') c = colorNamed('tang');
  else if (mode === 'train' && (LONG_DISTANCE.test(cat) || !num)) c = colorNamed('navy');
  else if (/^\d+$/.test(label)) c = PALETTE[Number(label) % PALETTE.length]; // consecutive numbers get different colours
  else c = PALETTE[hashText(label || cat) % PALETTE.length];
  lineColors.set(key, c);
  return c;
}
// CSS picks the light or the dark pair
export function lineVars<E extends HTMLElement>(el: E, j: LineLike) {
  const c = lineColor(j);
  el.style.setProperty('--lc', c.bg);
  el.style.setProperty('--lf', c.fg);
  el.style.setProperty('--ldc', c.dbg);
  el.style.setProperty('--ldf', c.dfg);
  return el;
}

const MODE_ICON = {
  train: '<path d="M7 3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM4 10h16M8 17l-2 4M16 17l2 4"/>',
  tram:  '<path d="M7 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM9 2.5h6M12 2.5V6M5 12h14M8 18l-2 3M16 18l2 3"/>',
  bus:   '<path d="M6 3h12a2 2 0 0 1 2 2v12H4V5a2 2 0 0 1 2-2zM4 11h16M7 17v3M17 17v3"/>',
  boat:  '<path d="M3 15l2 5h14l2-5zM6 15V9h12v6M12 5v4"/>',
  cable: '<path d="M3 4l18 4M12 6v4M7 10h10v8H7zM7 14h10"/>',
  walk:  '<circle cx="13" cy="4.2" r="1.9"/><path d="M10.5 21l1.5-5.5 2.5 2.5v3M8.5 12.5l2.5-4.5 3 1 2 3.5M12 15.5l-1.2-6.5"/>',
  pin:   '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  change: '<path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  left: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v5"/>',
  right: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0-6 6v5"/>',
  straight: '<path d="M12 20V4M6 10l6-6 6 6"/>',
  stairs: '<path d="M4 20h5v-5h5v-5h5V5"/>',
};
export const icon = (name: keyof typeof MODE_ICON) => `<svg viewBox="0 0 24 24" aria-hidden="true">${MODE_ICON[name]}</svg>`;

export function modeOf(category: string | null | undefined): LineMode {
  const c = (category || '').toUpperCase(); // some rides come without a category
  if (/^(IC|ICE|ICN|IR|IRE|EC|EN|EXT|NJ|RE|R|RB|S|SN|PE|TGV|RJX|TER)$/.test(c)) return 'train';
  if (/^(T|TRAM|M)$/.test(c)) return 'tram';
  if (/^(BAT|FAE|BAV)$/.test(c)) return 'boat';
  if (/^(FUN|PB|GB|SL|LB|ASC)$/.test(c)) return 'cable';
  return 'bus';
}
export function lineLabel(j: LineLike) {
  const c = (j.category || '').toUpperCase();
  // "000063" → "63"; a placeholder like "?" (replacement buses) is no number
  const n = /[A-Za-z0-9]/.test(j.number || '') ? String(j.number).replace(/^0+(?=\d)/, '') : '';
  if (!n) return c;
  if (/^(S|SN|R|RE|IR|IC|EC|ICE)$/.test(c)) return /^(S|SN)$/.test(c) ? c + n : `${c} ${n}`;
  if (c === 'B' || c === 'T' || c === 'BUS' || c === 'TRAM') return n;
  return `${c} ${n}`.trim();
}

export const fmtTime = (iso: string | number | null | undefined) => iso ? new Date(iso).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }) : '--:--';
export function dayLabel(iso: string | number) {
  const d = new Date(iso), now = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
// "< 1 min", "23 min", "1 h 05 min"; never "0 min" for a time that is not zero
export function kDur(s: number) {
  if (s > 0 && s < 60) return '< 1 min';
  const m = Math.max(0, Math.round(s / 60));
  if (m < 60) return `${m} min`;
  const hh = Math.floor(m / 60), r = m % 60;
  return r ? `${hh} h ${String(r).padStart(2, '0')} min` : `${hh} h`;
}
// where seconds decide: "45 s", "1 min 15 s", then whole minutes rounded down
export function kDurExact(s: number) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s} s`;
  if (s < 90) return s % 60 ? `1 min ${s % 60} s` : '1 min';
  return kDur(Math.floor(s / 60) * 60);
}
// ---- A stop of a ride: the engine's call there (KanteStopCall: its boarding point, times, delays) ----
export type StopTime = 'arr' | 'dep';
export const stopName = (c: KanteStopCall) => c.quay.stationName;
// The station's UIC number ("8507000"), as platforms.js and the 3D models know it; else the engine's own id
export const stopUic = (c: KanteStopCall) => (KANTE && KANTE.uicOf(c.quay.stationId)) || c.quay.stationId;
const delayOf = (c: KanteStopCall, which: StopTime) => (which === 'arr' ? c.arrDelayS : c.depDelayS);
// The timetable's time at a stop, ms (null where the ride has none: no arrival where it starts)
export const planMs = (c: KanteStopCall | null | undefined, which: StopTime) => (c && c[which] != null ? c[which]! * 1000 : null);
// Live (real-time) time at a stop in ms: the timetable plus the engine's delay
export function liveMs(c: KanteStopCall | null | undefined, which: StopTime) {
  return c && c[which] != null ? (c[which]! + (delayOf(c, which) || 0)) * 1000 : null;
}
// Minutes late
export const lateMin = (c: KanteStopCall | null | undefined, which: StopTime) => (c && c[which] != null && delayOf(c, which) != null ? Math.round(delayOf(c, which)! / 60) : 0);
// The engine has a forecast (or a measured time) for it, not only the timetable
export const hasForecast = (c: KanteStopCall | null | undefined, which: StopTime) => !!c && c[which] != null && delayOf(c, which) != null;

export const isRide = (p: JourneyPart | null | undefined): p is JourneyRide => !!p && p.type === 'ride';
const sameStation = (q: KanteQuay | null | undefined, c: KanteStopCall | null | undefined) => !!(q && c && q.stationId === c.quay.stationId);

// Every stop of a ride on its exact boarding point, as the engine names it
function placeRide(s: JourneyRide) {
  const at = s.stops.map((_, k) => KanteJourney.at(s, k));
  const pts = at.map((a) => a.ll);
  return { path: pts, idx: pts.map((_, k) => k), // idx: each path stop's place in the ride's stops
    dep: pts[0], arr: pts[pts.length - 1], depAt: at[0], arrAt: at[at.length - 1] };
}

// What the end of a walk at a platform is, for the walking router: the platform, on its floor, by its number
const platformEndOf = (pa: JourneyPlatformAt | null | undefined): WalkEnd => ({ ...(pa && pa.edge
  ? { platform: true, level: pa.edge.level || 0, ref: platformKey(pa.edge.ref) || null } : { platform: true }), ...(pa && pa.quay ? { quay: pa.quay } : {}) });
// After a live platform change: the walks' ends follow the rides' new boarding points, one pair for each of a
// walk's lines. Where a walk is drawn in more lines than it has ends for (a station model's way and the streets
// before or after it), the lines meet where the model's paths begin: points taken as they are.
export function syncEnds(steps: JourneyStep[]) {
  steps.forEach((st) => {
    if (st.type !== 'walk' && st.type !== 'change') return;
    const old = st.ends || [], n = Math.max(1, (st.lines || []).length);
    const from = st.prevRide ? platformEndOf(st.prevRide.arrAt) : (old[0] || [])[0] || {};
    const to = st.nextRide ? platformEndOf(st.nextRide.depAt) : (old[old.length - 1] || [])[1] || {};
    const joint = (k: number, side: 0 | 1): WalkEnd => (old.length === n ? old[k][side] : { exact: true });
    st.ends = Array.from({ length: n }, (_, k): [WalkEnd, WalkEnd] => [k === 0 ? from : joint(k, 0), k === n - 1 ? to : joint(k, 1)]);
  });
}

// Turn the journey's parts into swipeable steps: walk → ride → change → ride → … → walk → arrive
export function buildSteps(conn: Journey, destTitle: string) {
  const steps: JourneyStep[] = [];
  type PendingWalk = { min: number; lines: LngLat[][]; ends: [WalkEnd, WalkEnd][]; start: number | null; leg: KanteWalkLeg | null };
  const empty = (): PendingWalk => ({ min: 0, lines: [], ends: [], start: null, leg: null });
  let walk = empty();
  let lastRide = null as JourneyRide | null;
  const flushWalk = () => { const w = walk; walk = empty(); return w; };
  // the engine's walk for a walk or change step: its time, and its path, directions and floor changes
  const engineWalk = (st: JourneyWalkStep | JourneyChangeStep, w: PendingWalk) => {
    if (!w.leg) return;
    KanteJourney.setWalk(st, w.leg);
    if (st.type === 'walk' && st.t0 != null) st.t1 = st.t0 + w.leg.durationS * 1000;
  };
  // what each end of a walk is, for the walking router: your position, a platform (on its floor), a station, a place
  const platformEnd = platformEndOf;
  const at = new Map<JourneyRide, ReturnType<typeof placeRide>>(conn.parts.filter(isRide).map((s) => [s, placeRide(s)]));
  conn.parts.forEach((s, idx) => {
    if (s.type === 'walk') {
      walk.min += Math.round(KanteJourney.walkSecs(s) / 60);
      if (walk.start == null) walk.start = s.dep * 1000;
      walk.leg = s; // the last one before the next ride (or the destination) is the step's
      // walks start/end on the platform you get off / on, not at the station's centre
      let a: LngLat = [s.from.lon, s.from.lat], b: LngLat = [s.to.lon, s.to.lat];
      // the first walk starts where you are (GPS), or at the place the trip starts from (a pin, a search result)
      let fromEnd: WalkEnd = idx === 0 ? (searchState.tripStart ? {} : { gps: true }) : { platform: true };
      let toEnd: WalkEnd = idx === conn.parts.length - 1 ? {} : { platform: true };
      if (lastRide && sameStation(s.from.quay, lastRide.to)) { a = at.get(lastRide)!.arr; fromEnd = platformEnd(at.get(lastRide)!.arrAt); }
      const nextRide = conn.parts.slice(idx + 1).find(isRide);
      if (nextRide && sameStation(s.to.quay, nextRide.from)) { b = at.get(nextRide)!.dep; toEnd = platformEnd(at.get(nextRide)!.depAt); }
      walk.lines.push([a, b]);
      walk.ends.push([fromEnd, toEnd]);
      return;
    }
    const w = flushWalk();
    const here = at.get(s)!;
    if (!lastRide) {
      if (w.min > 0) {
        const t0 = w.start != null ? w.start : conn.t0;
        const st: JourneyWalkStep = { type: 'walk', min: w.min, lines: w.lines, ends: w.ends, start: w.start, toName: stopName(s.from), next: s,
          board: here.dep, t0, t1: t0 + w.min * 60000 };
        engineWalk(st, w);
        steps.push(st);
      }
    } else {
      const t0 = planMs(lastRide.to, 'arr')!;
      const pa = at.get(lastRide)!.arr, pd = here.dep;
      // changing platforms inside a station: show the way from one platform to the other
      // (also when the two are close on the map but on different floors: one may be right below the other)
      const fl = (x: JourneyPlatformAt | undefined) => (x && x.edge && x.edge.level) || 0;
      const lines = w.lines.length ? w.lines
        : distKm(pa, pd) > 0.015 || fl(at.get(lastRide)!.arrAt) !== fl(here.depAt) ? [[pa, pd]] : [];
      const ends: [WalkEnd, WalkEnd][] = w.lines.length ? w.ends : [[platformEnd(at.get(lastRide)!.arrAt), platformEnd(here.depAt)]];
      const st: JourneyChangeStep = { type: 'change', prev: lastRide, next: s, walkMin: w.min, lines, ends,
        points: [pa, pd], t0, t1: w.min > 0 ? t0 + w.min * 60000 : planMs(s.from, 'dep') };
      engineWalk(st, w);
      steps.push(st);
    }
    steps.push({ type: 'ride', s, path: here.path, stops: here.path, stopIdx: here.idx, depLL: here.dep, arrLL: here.arr, depAt: here.depAt, arrAt: here.arrAt,
      t0: planMs(s.from, 'dep'), t1: planMs(s.to, 'arr') });
    lastRide = s;
  });
  const w = flushWalk();
  const end = lastRide ? at.get(lastRide)!.arr : null;
  // (a walk of a few seconds to the destination's door stays: its door is where to go in)
  if (w.min > 0 || !lastRide || (w.leg && w.leg.door)) {
    const t0 = w.start != null ? w.start : lastRide ? planMs(lastRide.to, 'arr')! : conn.t0;
    const last = w.lines[w.lines.length - 1];
    const st: JourneyWalkStep = { type: 'walk', min: w.min, lines: w.lines, ends: w.ends, start: w.start, toName: destTitle, final: true,
      from: lastRide, alight: end, t0, t1: t0 + w.min * 60000, toLL: last && last[last.length - 1] };
    engineWalk(st, w);
    steps.push(st);
  }
  steps.push({ type: 'arrive', destTitle, time: conn.t1, from: lastRide, end });
  steps.forEach((st, i) => {
    st.prevRide = steps.slice(0, i).reverse().find((x) => x.type === 'ride');
    st.nextRide = steps.slice(i + 1).find((x) => x.type === 'ride');
  });
  applyLiveTimes(steps);
  return steps;
}

// Time every ride, change and the last walk by the live forecasts (run again whenever they change). The last walk
// ends its seconds after the last ride's arrival, to the nearest minute (the seconds added first, then rounded).
export function applyLiveTimes(steps: JourneyStep[]) {
  let end: number | null = null;
  steps.forEach((st) => {
    if (st.type === 'ride') {
      st.t0 = liveMs(st.s.from, 'dep');
      st.t1 = liveMs(st.s.to, 'arr');
      end = st.t1;
    } else if (st.type === 'change') {
      st.t0 = liveMs(st.prev.to, 'arr');
      st.t1 = st.walkMin > 0 ? st.t0! + st.walkMin * 60000 : liveMs(st.next.from, 'dep');
    } else if (st.type === 'walk' && st.final) {
      if (st.from) {
        st.t0 = liveMs(st.from.to, 'arr');
        st.t1 = Math.round((st.t0! + (st.walkS != null ? st.walkS : st.min * 60) * 1000) / 60000) * 60000;
      }
      end = st.t1;
    } else if (st.type === 'arrive' && end != null) st.time = end;
  });
}

// When the journey leaves as it now stands: when its first walk starts (a walk routed again moves it), else the
// timetable's departure
export function journeyStart() {
  const first = journey.steps[0];
  return first && first.type === 'walk' && first.t0 != null ? first.t0 : journey.conn!.t0;
}
// When the journey arrives as it now stands: the arrival step's time (the live times', and the last walk's as routed
// again), else the timetable's
export function journeyEnd() {
  const a = journey.steps[journey.steps.length - 1];
  return a && a.time != null ? a.time : journey.conn!.t1;
}
// Spare time on a change: from getting off to the next departure, less the walk
/** Seconds there are to walk a change in, after the extra change time asked for in Settings (null: no times). */
export function changeRoomS(st: JourneyChangeStep): number | null {
  const dep = liveMs(st.next.from, 'dep'), arr = liveMs(st.prev.to, 'arr');
  if (dep == null || arr == null) return null;
  const extra = (SETTINGS.prefs ? SETTINGS.prefs().extraChangeMin : 0) || 0;
  return Math.max(0, (dep - arr) / 1000 - extra * 60);
}
export function spareOf(st: JourneyChangeStep) {
  const wait = (liveMs(st.next.from, 'dep')! - liveMs(st.prev.to, 'arr')!) / 1000;
  const s = wait - (st.walkS != null ? st.walkS : (st.walkMin || 0) * 60); // walkS: the engine's walk, to the second
  const level = s < 0 ? 'missed' : s < 120 ? 'tight' : 'ok';
  const extra = (SETTINGS.prefs ? SETTINGS.prefs().extraChangeMin : 0) || 0;
  const short = extra > 0 && s < extra * 60; // less than the extra change time asked for in Settings
  // the walk's time an estimate (no router answered for the platform it now leads to): said so, in whole minutes
  const est = !!st.walkEst;
  const text = !est ? `${kDurExact(s)} to spare` : s < 60 ? 'Less than a minute to spare' : `About ${kDur(Math.floor(s / 60) * 60)} to spare`;
  return { s, level, extra, short, est, easy: level === 'ok' && !short && !est, text };
}

export function stepCoords(st: JourneyStep) {
  const c: LngLat[] = [];
  (st.lines || []).forEach((l) => c.push(...l));
  if (st.path) c.push(...st.path);
  if (st.points) c.push(...st.points.filter(Boolean) as LngLat[]);
  if (st.board) c.push(st.board);
  if (st.alight) c.push(st.alight);
  if (st.type === 'arrive') {
    if (destMarker._map) c.push(destMarker.getLngLat().toArray());
    if (st.end) c.push(st.end);
  }
  return c;
}

// Split a line at a fraction of its length → [travelled, ahead]
export function splitLine(cs: LngLat[], frac: number): [done: LngLat[], ahead: LngLat[], at: LngLat] {
  const total = lengthKm(cs);
  let target = total * frac, acc = 0;
  for (let i = 1; i < cs.length; i++) {
    const d = distKm(cs[i - 1], cs[i]);
    if (acc + d >= target) {
      const r = d ? (target - acc) / d : 0;
      const p: LngLat = [cs[i - 1][0] + (cs[i][0] - cs[i - 1][0]) * r, cs[i - 1][1] + (cs[i][1] - cs[i - 1][1]) * r];
      return [[...cs.slice(0, i), p], [p, ...cs.slice(i)], p];
    }
    acc += d;
  }
  return [cs, [cs[cs.length - 1]], cs[cs.length - 1]];
}

// A point a set distance along a line (km), from its start or (negative) from its end
function pointAlong(cs: LngLat[], km: number): LngLat | undefined {
  if (!cs || cs.length < 2) return cs && cs[0];
  const total = lengthKm(cs);
  const at = km >= 0 ? Math.min(km, total / 2) : Math.max(total / 2, total + km);
  return splitLine(cs, total ? at / total : 0)[2];
}

// Floor change on a walk ("Go down to level −4"); platforms without a level are at street level
export function levelChange(st: JourneyStep): JourneyLevelChange | null {
  const lv = (x: number | null | undefined) => (x == null ? 0 : x);
  const depLevel = (r: JourneyRideStep | undefined) => r && r.depAt && r.depAt.edge && r.depAt.edge.level;
  const arrLevel = (r: JourneyRideStep | undefined) => r && r.arrAt && r.arrAt.edge && r.arrAt.edge.level;
  const walk = (st.lines || []).flat();
  let from = 0, to = 0, at: LngLat | null | undefined = null;
  if (st.type === 'walk' && !st.final) { to = lv(depLevel(st.nextRide)); at = pointAlong(walk, -0.03); }
  else if (st.type === 'walk') { from = lv(arrLevel(st.prevRide)); at = pointAlong(walk, 0.03); }
  else if (st.type === 'change') {
    from = lv(arrLevel(st.prevRide)); to = lv(depLevel(st.nextRide));
    at = walk.length > 1 ? splitLine(walk, .5)[2] : st.points[1];
  } else return null;
  if (from === to) return null;
  return { from, to, at, text: `Go ${to < from ? 'down' : 'up'} to ${to === 0 ? 'street level' : 'level ' + levelShort(to)}` };
}

function signId(st: JourneyRideStep) {
  const j = st.s.line, raw = platformOf(st.s.from);
  const edge = st.depAt && st.depAt.edge;
  const label = splitPlatform(raw === '–' ? '' : raw).num || (edge && edge.ref) || '';
  return `sg|l|${label}|${label ? platformWord(j) : ''}`;
}

/** The routed points a..b of a walk's line of n points; before a and after b its guessed ends (approxTo / approxFrom). */
export function routedSpan(w: RoutedWalk, n: number): [a: number, b: number] {
  const a = w.approxTo != null && w.approxTo < n - 1 ? w.approxTo : 0;
  return [a, w.approxFrom != null && w.approxFrom >= a ? w.approxFrom : n - 1];
}
export function stepFeatures(steps: JourneyStep[]) {
  const f: RouteFeature[] = [];
  const add = (geometry: RouteFeature['geometry'], properties: RouteFeatureProps) => f.push({ type: 'Feature', properties, geometry });
  const line = (cs: LngLat[] | undefined, kind: 'ride' | 'walk' | 'wcov', step: number, extra?: Partial<RouteFeatureProps>) => cs && cs.length > 1 && add({ type: 'LineString', coordinates: cs }, { kind, step, ...extra });
  const pt = (c: LngLat | null | undefined, props: RouteFeatureProps) => c && add({ type: 'Point', coordinates: c }, props);
  // where you are on the trip: everything before it is drawn faded ("done")
  const p = journeyProgress();
  const doneLine = (cs: LngLat[] | undefined, kind: 'ride' | 'walk', step: number, from: number, extra?: Partial<RouteFeatureProps>) => { // from: km into its step where this line starts
    if (!cs || cs.length < 2) return;
    if (!p || step > p.i) return line(cs, kind, step, extra);
    const len = lengthKm(cs), k = (p.walkedKmIn != null ? p.walkedKmIn : p.kmIn) - from; // (along a guess, up to where it begins)
    if (step < p.i || k >= len) return line(cs, kind, step, { ...extra, done: true });
    if (k <= 0) return line(cs, kind, step, extra);
    const [a, b] = splitLine(cs, k / len);
    line(a, kind, step, { ...extra, done: true });
    line(b, kind, step, extra);
  };
  steps.forEach((st, i) => {
    let from = 0;
    (st.lines || []).forEach((l, k) => {
      // a straight line until a router has found the way, and the long straight bits across open ground onto and off
      // the paths (approxTo / approxFrom): dashed
      const w = st.walks && st.walks[k];
      if (!w || w.approx) doneLine(l, 'walk', i, from, { approx: true });
      else {
        const [a, b] = routedSpan(w, l.length);
        let at = from;
        const pieces: [from: number, to: number, guess: boolean][] = [[0, a, true], [a, b, false], [b, l.length - 1, true]];
        pieces.forEach(([x, y, guess]) => {
          if (y <= x) return;
          const part = l.slice(x, y + 1);
          doneLine(part, 'walk', i, at, guess ? { approx: true } : undefined);
          at += lengthKm(part);
        });
      }
      from += lengthKm(l);
      if (!w) return;
      (w.covered || []).forEach((c) => line(c.coords, 'wcov', i, { done: !!p && i < p.i }));
      if (w.door && st.final) pt(w.door.ll, { kind: 'door', step: i, done: !!p && i < p.i });
    });
    if (st.type === 'ride') {
      const c = lineColor(st.s.line), colors = { color: c.bg, dcolor: c.dfg };
      doneLine(st.path, 'ride', i, 0, colors);
      const kms = p && p.i === i ? stopKms(st) : null;
      const passed = (m: number) => !!p && (i < p.i || (!!kms && kms[m] <= p.kmIn));
      st.stops.slice(1, -1).forEach((q, m) => pt(q, { kind: 'stop', step: i, end: false, done: passed(m + 1), ...colors }));
      pt(st.arrLL, { kind: 'stop', step: i, end: true, done: !!p && i < p.i, ...colors });
      pt(st.depLL, { kind: 'sign', step: i, img: signId(st), sort: 10 });
    }
    // floor changes: every one on a walk through a modelled station (st.floors), else the one the platform levels imply
    const lvl = st.floors ? null : levelChange(st);
    if (lvl && lvl.at) pt(lvl.at, { kind: 'lvl', step: i, img: `lv|${lvl.to > lvl.from ? 'u' : 'd'}|${levelShort(lvl.to)}` });
    (st.floors || []).forEach((m) => pt(m.at, { kind: 'lvl', step: i, img: `lv|${m.to > m.from ? 'u' : 'd'}|${levelShort(m.to)}` }));
  });
  const first = steps[0];
  if (first && first.type === 'walk' && first.lines[0]) pt(first.lines[0][0], { kind: 'pin', step: 0, img: 'pin|from' });
  return f;
}
