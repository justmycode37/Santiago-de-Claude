// ---------- Accurate route shapes ----------
// Walks are the Kante engine's (its path comes with every walk of a journey, and from /api/walk). Only a walk the
// engine has no path for at all (its map ends at the border) is asked of OSRM's foot profile, as before the engine
// routed walks (footWalk()): its line and directions, never a time (the engine's stays). The engine's rides only give stop coordinates, so the lines between them are routed:
// trains → BRouter rail profile (brouter.de), buses/trams → OSM road routing. Anything implausible falls back to the
// straight line.
import { map } from './map.ts';
import { updateCards } from './map-events.ts';
import { userLngLat } from './location.ts';
import { destMarker, startMarker } from './search.ts';
import { clearPlacePins, render } from './search-pins.ts';
import { blurSearch, setField, setFollowing, setPlanOpen } from './trip-ends.ts';
import { armPin, pinMenu } from './pins.ts';
import { updatePlaces } from './map-places.ts';
import { jBody, jFoot, jHead, setRoute } from './journey-map.ts';
import { applyLiveTimes, changeRoomS, modeOf } from './journey-steps.ts';
import { nowMarker, placeUserDot, vehMarker } from './tracking.ts';
import { fmtDist, platformOf, vehUpdate } from './live-vehicles.ts';
import { queueSheet, s3Plan, s3Prefs } from './sheet-content.ts';
import { updateProgress } from './pill.ts';
import { closeTimeSheet, updateWhenChip } from './time-picker.ts';
import { journey, searchState, sheet, tracking } from './state.ts';
import { stationRouter } from '../station3d.ts';
import { Station3D } from '../station3d.ts';
import { KANTE } from '../engine.ts';
import { KanteJourney } from '../engine-journey.ts';
import type { Station3DEndpoint } from '../station3d.ts';
import type { JourneyChangeStep, JourneyWalkStep, LineMode } from './journey-steps.ts';
import type { LngLatFirst } from './search.ts';
import type { KanteFloorChange, KanteWalkDir } from '../engine.ts';

// ---------------------------------------------------------------- walks

/**
 * A routed walk (routeWalk(), stationWalk(), and the engine's): its line, its metres (null when no router found a
 * way and it is the straight line), and its directions written out in `dirs` (a station model's, the engine's).
 */
export interface RoutedWalk {
  coords: LngLat[];
  steps: null;
  dist: number | null;
  dirs?: KanteWalkDir[];
  /** Routed on a walking network (the engine's): the blue dot may sit on it. */
  net?: boolean;
  /** A straight line, not a route (no router found a way). */
  approx?: boolean;
  /** The engine answered, but has no path for any of it (`approximate`): OSRM's foot profile is asked (footWalk()). */
  noPath?: boolean;
  /** Coordinate indices: the guessed straight bits from the start (0…approxTo) and to the end (approxFrom…). */
  approxTo?: number | null;
  approxFrom?: number | null;
  /** Stretches under arcades, through passages and underpasses, indoors. */
  covered?: { kind: string; coords: LngLat[] }[];
  /** The door the walk ends at. */
  door?: { ll: LngLat; type: string; addr: string } | null;
  floors?: KanteFloorChange[];
  /** Its time, seconds: the engine's (or a station model's). */
  walkS?: number;
  /** Metres climbed on it (the engine's, from the terrain model). */
  climb?: number;
}
/** What an end of a walk is: your position (GPS), a boarding point (on its floor, by its number and the engine's
 *  `quay` id), a point taken as it is (where a station model's own paths begin), or a place (the walk ends at its door). */
export interface WalkEnd {
  gps?: boolean;
  platform?: boolean;
  level?: number | null;
  ref?: string | null;
  quay?: string;
  exact?: boolean;
}
/** What a routed walk through a station puts on its step (stationWalk()); `floors` null: routed along the streets. */
export interface StationWalkParts { lines: LngLat[][]; walks: RoutedWalk[]; floors: KanteFloorChange[] | null; /** Routed along the streets: the model had no route. */ street?: boolean }
/** A walk's place in a station with a 3D model (s3Plan() in sheet-content.ts): the model and the two ends. */
export interface StationWalkPlan { key: string; from: Station3DEndpoint; to: Station3DEndpoint }

const routeCache = new Map<string, Promise<unknown>>();
function getJSON<T>(url: string) {
  if (!routeCache.has(url)) routeCache.set(url, fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return routeCache.get(url) as Promise<T | null>;
}
export function distKm(a: LngLatFirst, b: LngLatFirst) {
  const R = 6371, toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad, dLng = (b[0] - a[0]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export const lengthKm = (cs: LngLat[]) => cs.reduce((sum, c, i) => (i ? sum + distKm(cs[i - 1], c) : 0), 0);
const plausible = (route: LngLat[] | false | null | undefined, straight: LngLat[]) => route && route.length > 1 && lengthKm(route) <= Math.max(lengthKm(straight) * 2.5, lengthKm(straight) + 0.4);
const ll = (c: LngLat) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;

// What the routers answer, as far as it is read: OSRM (routing.openstreetmap.de; its foot profile with its
// turn-by-turn steps), BRouter
interface OsrmStep { distance?: number; name?: string; maneuver?: { type?: string; modifier?: string }; geometry?: { coordinates: LngLat[] } }
interface OsrmRoute { geometry: { coordinates: LngLat[] }; distance: number; legs?: { steps?: OsrmStep[] }[] }
interface OsrmAnswer { code: string; routes: OsrmRoute[] }
interface BrouterAnswer { features?: { geometry: { coordinates: number[][] } }[] }
// A walk between two points, by the Kante engine (/api/walk): its path, metres, written directions, floor changes, the
// door it ends at, its stretches under a roof and its guessed ends. ends: [from, to], what each end is (WalkEnd): a
// boarding point (by the engine's id), a point taken as it is, or a place (the walk then ends at its door). No path:
// the straight line with the engine's time for it; no answer (the engine is off or down): the straight line.
// limitS (a change): the seconds there are for it, so that the way the traveller prefers (round a hill) is taken only
// when it fits, the quickest otherwise.
export async function routeWalk(a: LngLat, b: LngLat, ends?: [WalkEnd, WalkEnd], limitS?: number | null): Promise<RoutedWalk> {
  const [from, to] = ends || [{}, {}];
  const place = (p: LngLat, e: WalkEnd): KantePlaceRef => ({ lat: p[1], lon: p[0], ...(e.quay ? { quay: e.quay } : {}), ...(e.exact ? { exact: true } : {}) });
  try {
    const r = KanteJourney.routed(await KANTE.walk({ from: place(a, from), to: place(b, to), options: KanteJourney.options(), ...(limitS != null ? { limitS } : {}) }));
    if (r) return (r.noPath && (await footWalk(a, b, r))) || r;
  } catch (e) { /* the straight line */ }
  return { coords: [a, b], steps: null, dist: null, approx: true };
}

// The one walk router besides the engine: OSRM's foot profile (routing.openstreetmap.de), asked as the site asked it
// before the engine routed walks, only for a walk the engine has no path for at all (outside its map: abroad, past
// the border). Its line, metres and street-by-street directions; the time stays the engine's (`timed`: the engine's
// straight line for this walk), as main kept the engine's times for every walk OSRM drew. null: no way found.
const TURN: Record<string, string> = { left: 'Turn left', right: 'Turn right', 'slight left': 'Bear left', 'slight right': 'Bear right',
  'sharp left': 'Turn sharp left', 'sharp right': 'Turn sharp right', straight: 'Continue straight', uturn: 'Turn around' };
export async function footWalk(a: LngLat, b: LngLat, timed: RoutedWalk): Promise<RoutedWalk | null> {
  if (distKm(a, b) < 0.02) return null;
  const d = await getJSON<OsrmAnswer>(`https://routing.openstreetmap.de/routed-foot/route/v1/foot/${ll(a)};${ll(b)}?overview=full&geometries=geojson&steps=true`);
  const r = d && d.code === 'Ok' && d.routes[0];
  if (!r || !plausible(r.geometry.coordinates, [a, b])) return null;
  const dirs: KanteWalkDir[] = [];
  ((r.legs && r.legs[0] && r.legs[0].steps) || []).forEach((s) => {
    const m = s.maneuver || {}, dist = Math.round(s.distance || 0);
    if (m.type === 'arrive' || dist < 3) return;
    const along = s.name ? ` along ${s.name}` : '';
    const verb = !dirs.length ? 'Walk' : `${TURN[m.modifier!] || 'Continue'} and walk`;
    dirs.push({ kind: !dirs.length ? 'depart' : 'walk', text: `${verb} ${fmtDist(dist)}${along}`, coords: (s.geometry && s.geometry.coordinates) || [] });
  });
  const dist = Math.round(r.distance);
  return { coords: [a, ...r.geometry.coordinates, b], steps: null, dist, dirs, ...(timed.walkS != null ? { walkS: timed.walkS } : {}) };
}

async function routeRide(path: LngLat[], mode: LineMode): Promise<LngLat[]> {
  if (path.length < 2) return path;
  let g: LngLat[] | false | null | undefined = null;
  if (mode === 'train') {
    const d = await getJSON<BrouterAnswer>(`https://brouter.de/brouter?lonlats=${path.map(ll).join('|')}&profile=rail&alternativeidx=0&format=geojson`);
    g = d && d.features && d.features[0] && d.features[0].geometry.coordinates.map((c): LngLat => [c[0], c[1]]);
  } else if (mode === 'bus' || mode === 'tram') {
    const d = await getJSON<OsrmAnswer>(`https://routing.openstreetmap.de/routed-car/route/v1/driving/${path.map(ll).join(';')}?overview=full&geometries=geojson`);
    g = d && d.code === 'Ok' && d.routes[0] && d.routes[0].geometry.coordinates;
  }
  return plausible(g, path) ? [path[0], ...g as LngLat[], path[path.length - 1]] : path;
}

// A walk that passes through a station with a 3D model: the model's route for the part inside it, the street
// router for what lies before and after. When the model has no route (or does not load): the street router alone
// (`street` set), or, for a walk as the plan came with the engine's path (`asPlanned`), nothing (null: keep that).
export async function stationWalk(st: JourneyWalkStep | JourneyChangeStep, plan: StationWalkPlan, asPlanned?: boolean): Promise<StationWalkParts | null> {
  const lines = st.lines.map((l) => l.slice());
  const a = lines[0][0], last = lines[lines.length - 1], b = last[last.length - 1];
  const ends = st.ends || [];
  const street = async (): Promise<StationWalkParts> => {
    // a change of one stretch: within the time there is for it, as refineWalk() asks
    const limit = st.type === 'change' && lines.length === 1 ? changeRoomS(st) : null;
    const walks = await Promise.all(lines.map((l, k) => routeWalk(l[0], k === lines.length - 1 ? walkGoal(st, l[l.length - 1]) : l[l.length - 1], ends[k], limit)));
    const floors = walks.flatMap((w) => w.floors || []);
    return { lines: walks.map((w) => w.coords), walks, floors: floors.length ? floors : null, street: true };
  };
  let model = null, route = null;
  try {
    model = await Station3D.loadData(plan.key);
    route = model && stationRouter()!.route(model, plan.from, plan.to, s3Prefs(st));
  } catch (e) { route = null; }
  // no path in the model: the street router, or for a walk as planned that the engine has routed, the engine's own path
  if (!route || route.points.length < 2 || route.same) return asPlanned && st.kanteWalk ? null : street();
  const inside = route.points.map((p) => stationRouter()!.toLngLat(model!, p));
  const parts: LngLat[][] = [], walks: RoutedWalk[] = [];
  // the stretch between the walk's end and where the model's paths begin: left out under 2 m, except to the
  // destination (place), however near, so that the engine leads to the door it picks
  const join = async (p: LngLat, q: LngLat, end: [WalkEnd, WalkEnd], place?: boolean) => {
    if (!place && distKm(p, q) < 0.002) return;
    const w = await routeWalk(p, q, end);
    parts.push(w.coords);
    walks.push(w);
  };
  // only for free positions: a route from a platform starts wherever it is best to leave that platform
  if (!route.fromStop) await join(a, inside[0], [(ends[0] || [])[0] || {}, { exact: true }]);
  const whole = (x: number) => Math.round(x);
  // the station's own written directions, in the shape walkDirections() lists them
  const dirs = route.steps.filter((s) => s.kind !== 'arrive').map((s, k) => {
    const change = s.kind !== 'walk' && whole(s.toLevel) !== whole(s.level);
    const d: KanteWalkDir = { kind: change ? (s.toLevel < s.level ? 'stairs-down' : 'stairs-up') : k === 0 && !parts.length ? 'depart' : 'walk',
      text: s.text, coords: inside.slice(s.from, s.to + 1) };
    if (change) { d.from = whole(s.level); d.to = whole(s.toLevel); }
    return d;
  });
  parts.push(inside);
  walks.push({ coords: inside, steps: null, dist: route.length, dirs, walkS: route.seconds });
  // to the destination: to the place itself, so that the engine picks its door
  if (!route.toStop) await join(inside[inside.length - 1], walkGoal(st, b), [{ exact: true }, (ends[ends.length - 1] || [])[1] || {}], st.type === 'walk' && !!st.final);
  // the model's floor changes, and any on the street parts before and after it
  const floors = dirs.filter((d) => d.from != null).map((d) => ({ at: d.coords[0], from: d.from!, to: d.to! }))
    .concat(walks.flatMap((w) => w.floors || []));
  return { lines: parts, walks, floors };
}

// Walks only, again (after a live platform change): every walk whose line is no longer the one its last answer drew
export function refineWalks(id: number, onlyMoved?: boolean) {
  let scheduled = false;
  const redraw = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; if (id === journey.req) { journey.routeKey = ''; updateProgress(); } });
  };
  const task: WalkTask = (promise, apply) => { promise.then((res) => { if (id !== journey.req) return; apply(res); tracking.geoVersion++; redraw(); }); };
  journey.steps.forEach((st) => {
    if (st.type !== 'walk' && st.type !== 'change') return;
    const sig = walkSig(st);
    if (onlyMoved) {
      // asked for these lines, ends and platforms, and the answer on its way (or in)
      if (st._askFor === st.lines && st._askSig === sig) return;
      // routed for them already (it was moved away and back before an answer came): what is drawn stays, and an
      // answer still on its way for the other ends is dropped, by a new revision
      if (st._netFor === st.lines && st._netSig === sig) { newWalkRev(st).done(); return; }
    }
    // no walk any more (both rides at the same point now): an answer still on its way must not bring it back
    if (!(st.lines || []).length) { newWalkRev(st); return; }
    const plan = s3Plan(st);
    if (plan) refineStationWalk(st, plan, task); else refineWalk(st, task);
  });
}
type WalkTask = <T>(promise: Promise<T>, apply: (res: T) => void) => void;
// What a walk was routed for besides its line: what its two ends are and the platforms it leaves from and goes to (a
// platform can change without its point moving, and a station model routes to the platform by its name), and for a
// change the time there is for it. A change asked for again (walkRev 2 on) was asked within that time (limitS): a
// delay that changes it asks again, and an answer asked for another time is dropped. One as the plan came is timed
// as the engine planned it (a minimum change time included): asked again only once its walk no longer fits. Where
// its lines meet inside it (syncEnds()) is not: that follows from how it is drawn.
const walkSig = (st: JourneyWalkStep | JourneyChangeStep) => {
  const stops = st.type === 'change' ? [st.prev.to, st.next.from] : [st.from && st.from.to, st.next && st.next.from];
  const ends = st.ends || [];
  const room = st.type === 'change' ? changeRoomS(st) : null;
  const time = room == null ? null : (st.walkRev || 0) >= 2 ? Math.round(room) : st.walkS == null || st.walkS <= room;
  return JSON.stringify([ends.length ? [ends[0][0], ends[ends.length - 1][1]] : [], stops.map((s) => (s ? platformOf(s) : '')), time]);
};
// A new revision of a walk's route: answers for older ones (it has been moved or rerouted since), and answers for
// ends and platforms the walk no longer has, are dropped
function newWalkRev(st: JourneyWalkStep | JourneyChangeStep) {
  const rev = (st.walkRev = (st.walkRev || 0) + 1), sig = walkSig(st);
  st._askFor = st.lines;
  st._askSig = sig;
  const current = () => st.walkRev === rev && walkSig(st) === sig && journey.steps.includes(st);
  // the answer is in: this line, for these ends and platforms, has its route
  const done = () => { st._netFor = st.lines; st._netSig = sig; };
  // no answer (the engine is down or cannot be reached): nothing is on its way any more, so it is asked again
  const retry = () => { st._askFor = undefined; st._askSig = undefined; };
  return Object.assign(current, { done, retry });
}
// Through a station with a 3D model: its own paths (right underpass, stairs, lifts), not the street router or the
// engine's path, so the map shows the same way as the 3D view; and the time of the way it draws
function refineStationWalk(st: JourneyWalkStep | JourneyChangeStep, plan: StationWalkPlan, task: WalkTask) {
  const first = st.walkRev == null;
  const current = newWalkRev(st);
  task(stationWalk(st, plan, first), (res) => {
    if (!current()) return;
    if (!res) { current.done(); return; } // as planned, and the model has no way: the engine's walk stays, with its time
    st.lines = res.lines;
    st.walks = res.walks;
    st.floors = res.floors;
    if (res.street) st.kanteWalk = res.walks.every((w) => !w.approx);
    if (res.walks.every(answered)) current.done(); else current.retry();
    walkTime(st, res.walks);
  });
}
// One walk (or change). As planned it has the engine's walk already; moved since, or at another platform at the same
// point (a live platform change), the engine is asked again between its ends. Each request carries the walk's revision:
// an answer for an older revision (the walk has been moved or rerouted since) is dropped.
function refineWalk(st: JourneyWalkStep | JourneyChangeStep, task: WalkTask) {
  const first = st.walkRev == null;
  const current = newWalkRev(st);
  const lines = st.lines || [];
  const goal = (line: LngLat[], k: number) => (k === lines.length - 1 ? walkGoal(st, line[line.length - 1]) : line[line.length - 1]);
  if (first) { // the engine's walk as the plan came
    current.done();
    // one it has no path for at all: OSRM's foot profile draws it and gives its directions (else it stays the
    // straight line). Either way its times stay the engine's, so the journey opened keeps the times of its row
    const w = st.walks && st.walks[0];
    if (lines.length !== 1 || !w || !w.noPath) return;
    task(footWalk(lines[0][0], goal(lines[0], 0), w), (res) => {
      if (!res || !current()) return;
      Object.assign(st, { lines: [res.coords], walks: [res], floors: null });
      current.done();
      queueSheet(); // its line, metres and directions
    });
    return;
  }
  // a change of one stretch: within the time there is for it (a walk through a station model has its own way)
  const limit = st.type === 'change' && lines.length === 1 ? changeRoomS(st) : null;
  task(Promise.all(lines.map((line, k) => routeWalk(line[0], goal(line, k), st.ends && st.ends[k], limit))), (res) => {
    if (!current()) return;
    st.lines = res.map((w) => w.coords);
    st.walks = res;
    st.kanteWalk = res.every((w) => !w.approx);
    // floor changes where the walk actually takes them (else the platform levels imply one)
    const floors = res.flatMap((w) => w.floors || []);
    st.floors = floors.length ? floors : null;
    if (res.every(answered)) current.done(); else current.retry();
    walkTime(st, res);
  });
}

// A part of a walk that has its time: the engine answered (with a path, or with the straight line it found no path
// for), or it is a station model's
const answered = (w: RoutedWalk) => w.walkS != null;
// How the engine times a walk it finds no path for (plan.rs): its straight line, a third longer, at the walking pace
const DETOUR = 1.35;
// The time of a walk as it is now drawn: the engine's for each part of it (a station model's for its part), its
// minutes, and for the walk to the first ride when to leave (so as to be at the stop at the same time); a change's
// end, the last walk's and the journey's arrival follow it. A part without an answer is timed as the engine times
// a straight line, and the walk's time is marked as an estimate.
function walkTime(st: JourneyWalkStep | JourneyChangeStep, walks: RoutedWalk[]) {
  const pace = KanteJourney.options().walkSpeed; // m/s
  const metres = (w: RoutedWalk) => (w.dist != null ? w.dist : lengthKm(w.coords) * 1000 * DETOUR);
  const s = Math.round(walks.reduce((sum, w) => sum + (answered(w) ? w.walkS! : metres(w) / pace), 0));
  const dist = walks.reduce((sum, w) => sum + metres(w), 0);
  st.walkS = s;
  st.walkEst = !walks.every(answered);
  const min = Math.round(KanteJourney.walkSecs({ distanceM: dist, durationS: s }) / 60);
  if (st.type === 'change') st.walkMin = min; else st.min = min;
  if (st.type === 'walk' && !st.final && st.t1 != null) st.t0 = st.t1 - s * 1000;
  applyLiveTimes(journey.steps);
  queueSheet(true); // the card (its minutes, metres and directions), and the journey's times in the header and the pill
}

// Where a walk leads: for the walk to the destination the place itself, not the door its last route ended at (which
// the router would take for a point on the building's wall)
const walkGoal = (st: JourneyWalkStep | JourneyChangeStep, end: LngLat) => (st.type === 'walk' && st.final && st.toLL) || end;

export function refineJourney(id: number) {
  let scheduled = false;
  const redraw = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; if (id === journey.req) { journey.routeKey = ''; updateProgress(); } });
  };
  const task = <T>(promise: Promise<T>, apply: (res: T) => void) => {
    promise.then((res) => { if (id !== journey.req) return; apply(res); tracking.geoVersion++; redraw(); });
  };
  const keys3d = new Set(journey.steps.map((st) => (s3Plan(st) || {}).key).filter(Boolean));
  // get the 3D view ready in the background, so "3D view" opens at once
  if (keys3d.size) setTimeout(() => { if (id === journey.req) keys3d.forEach((k) => Station3D.preload(k)); }, 2500);
  journey.steps.forEach((st) => {
    const plan = (st.lines || []).length ? s3Plan(st) : null;
    if (plan) refineStationWalk(st as JourneyWalkStep | JourneyChangeStep, plan, task);
    else if (st.type === 'walk' || st.type === 'change') refineWalk(st, task);
    if (st.type === 'ride') task(routeRide(st.path, modeOf(st.s.line.category)), (res) => { st.path = res; });
  });
}

// keepPlan: only the destination goes (its field was cleared); the card and the start stay for another one
export function endJourney(keepPlan?: boolean) {
  const had = !!journey.dest;
  journey.req++;
  document.body.classList.remove('journey-mode');
  setFollowing(false);
  clearInterval(journey.progressTimer);
  clearInterval(journey.liveTimer);
  journey.conn = null;
  journey.dest = null;
  journey.options = null;
  journey.list = false;
  journey.more = null;
  vehUpdate(); // live vehicles come back (from zoom 14)
  updateCards(); // events and places come back if they were on
  updatePlaces();
  tracking.track = null;
  sheet.focus = null;
  sheet.msg = '';
  sheet.retry = false;
  sheet.headKey = '';
  jHead.replaceChildren();
  jBody.replaceChildren();
  jFoot.replaceChildren();
  sheet.y = window.innerHeight;
  nowMarker.remove();
  vehMarker.remove();
  closeTimeSheet();
  setRoute([]);
  journey.steps = [];
  placeUserDot(); // back to plain GPS
  destMarker.remove();
  clearPlacePins();
  armPin(null);
  pinMenu.remove();
  setField('to', '');
  searchState.results = [];
  searchState.last = null;
  updateWhenChip();
  render();
  if (keepPlan === true) return;
  searchState.tripStart = null;
  startMarker.remove();
  setField('from', '');
  blurSearch();
  setPlanOpen(false);
  if (had && userLngLat) map.flyTo({ center: userLngLat, zoom: 15 });
}
