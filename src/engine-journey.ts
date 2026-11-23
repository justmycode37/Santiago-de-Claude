// Journeys from the Kante engine (engine.ts): the app's journeys are the engine's, laid out as the trip is shown.
//
// A Journey (below) is the engine's journey with `parts`: its walk legs as they are, and its
// ride legs as rides. A ride is one leg, or more when you stay seated while the vehicle goes on as another trip;
// its `stops` are the engine's calls, so the sheet, the map and live tracking read the engine's boarding points,
// times and delays directly. Live data from /api/trip is written into those calls (applyTrip()).
//
// Walking speed, step-free, extra change time, maximum walk and transport types go in as routing options:
// the engine only offers changes that work with them. Nothing is retimed or filtered afterwards.
//
// plans() gives every journey the engine offers for a trip (and walking all the way when that is near enough),
// with the one to show first. It throws when the engine is off or cannot be reached, so the page can say so.
import { KANTE } from './engine.ts';
import { SETTINGS } from './settings.ts';
import type { JourneyChangeStep, JourneyStep, JourneyWalkStep } from './app/journey-steps.ts';
import type { TransportMode } from './settings.ts';
import type { KanteFloorChange, KanteTimeQuery, KanteWalkDir } from './engine.ts';
import type { RoutedWalk } from './app/routing.ts';

// ---------------------------------------------------------------- a journey

/**
 * A journey as the app keeps it: the engine's journey (POST /api/plan, kante/engine/crates/server/src/json.rs),
 * with its legs laid out as the trip is shown (`parts`) and the times the app shows for it. KanteJourney.plans()
 * (src/engine-journey.ts) makes them.
 */
export interface Journey extends KanteJourney {
  /**
   * The legs as the trip is shown, in order: rides (each one or more of the engine's ride legs) and the engine's
   * walk legs. A change at the very same boarding point has no walk.
   */
  parts: JourneyPart[];
  /** When it starts, ms: the engine's `dep`. */
  t0: number;
  /** When it arrives as timetabled, ms: the last ride's arrival plus the walk after it (a later live arrival is the steps'). */
  t1: number;
}
export type JourneyPart = JourneyRide | KanteWalkLeg;
/** A line as the badges, colours and modes read it (lineLabel(), lineColor(), modeOf()): category "IC", number "8". */
export interface ShownLine { name: string; category: string; number: string; operator: string }
/**
 * One ride: the trips of the engine you ride (more than one when you stay seated while the vehicle goes on as
 * another trip; it is shown under the line you board), and every stop it stops at.
 */
export interface JourneyRide {
  type: 'ride';
  /** The engine's ride legs, in order. */
  legs: KanteRideLeg[];
  /** The first leg's line, as shown. */
  line: ShownLine;
  /** Where it goes (the first leg's headsign). */
  headsign: string;
  /**
   * The engine's calls at every stop it stops at, where you board and where you get off included (stops it skips
   * today are left out). At a stop where the trip changes there is one, with the arrival of the trip before and
   * the departure of the next. Live data (applyTrip()) is written into these objects, so they stay the same ones.
   */
  stops: KanteStopCall[];
  /** stops[0] and the last of them: where you board and where you get off. */
  from: KanteStopCall;
  to: KanteStopCall;
  /** For each leg: its call's seq → the stop's place in `stops`. */
  seqIdx: Map<number, number>[];
  /** For each leg: what the engine said last about its trip (live-engine.ts). */
  live: RideTripLive[];
}
/** What the engine said last about one trip of a ride: GET /api/trip, asked every 30 s while the trip is on. */
export interface RideTripLive {
  /** The last answer. */
  trip?: KanteTrip;
  /** When it came in (ms; 0 = not yet). */
  at: number;
  /** Polls in a row without an answer. */
  fails: number;
  /** A request is under way. */
  busy?: boolean;
}
// ---------------------------------------------------------------- the journeys to choose from

/** Every way on offer to make the trip (`journeyOptions`), as KanteJourney.plans() answers. */
export interface JourneyOptions {
  /** By public transport, in order of departure. */
  list: Journey[];
  /** On foot all the way, when that is near enough (up to about 3.5 km and 50 minutes); else null. */
  walk: Journey | null;
  /** The one shown first: one of `list`, or `walk`. */
  best: Journey;
  /** Whether there are earlier and later ones to fetch (KanteJourney.more()). */
  earlier: boolean;
  later: boolean;
  /** What more() asks on with: the request plans() sent, and the engine's pages before and after (null: none left). */
  request: { body: KantePlanBody; earlier?: string | null; later?: string | null };
}
// ---------------------------------------------------------------- where a ride stops

/** The platform or stop edge a ride is boarded at, as the engine names it (KanteJourney.at()). */
export interface JourneyEdge {
  /** Its name ("7", "H"); '' when it has none. */
  ref: string;
  /** The floor; null (or 0) at street level, or when it is not known. */
  level: number | null;
  ll: LngLat;
  /** "north side of Bundesgasse", or ''. */
  side: string;
}
/** Where a stop of a ride is (KanteJourney.at()). */
export interface JourneyPlatformAt {
  ll: LngLat;
  /** The engine's boarding point (its quay id). */
  quay?: string;
  /** null: the engine only knows the stop, not the platform or edge. */
  edge: JourneyEdge | null;
  /** The compass direction the vehicle leaves in. */
  travel: number | null;
}
// ---------------------------------------------------------------- KanteJourney (src/engine-journey.ts): journeys

/** A walk as the app keeps a routed one (RoutedWalk), from the engine's walk. */
export interface KanteRoutedWalk extends RoutedWalk { steps: null; dirs: KanteWalkDir[] }
/** The engine found no path: the straight line between the points, with the engine's time for it. */
export interface KanteStraightWalk extends RoutedWalk { steps: null; approx: true }
/** The engine's walk in the three fields a step keeps a routed walk in. */
export interface KanteWalkParts { lines: LngLat[][]; walks: KanteRoutedWalk[]; floors: KanteFloorChange[] }

const K = KANTE;
const pad2 = (n: number) => String(n).padStart(2, '0');

// ---- Settings → routing options (kante/engine/crates/server/src/json.rs, PlanOptions) ----
// The app's transport types (settings.ts) → the engine's modes
const ENGINE_MODES: Record<TransportMode, KanteMode[]> = { train: ['rail', 'rack'], tram: ['tram', 'metro'], bus: ['bus', 'ondemand', 'other'], ship: ['boat'], cableway: ['cableway', 'funicular', 'lift'] };
/** The traveller's settings as routing options. */
function options() {
  const p = SETTINGS.prefs();
  const o: KanteRoutingOptions = {
    walkSpeed: Math.round((p.walkKmh / 3.6) * 1000) / 1000, // m/s
    stairs: p.stepFree ? 'never' : p.fewerStairs ? 'avoid' : 'ok',
    escalators: !p.noEscalators,
    wheelchair: !!p.wheelchair,
    transferMarginS: p.extraChangeMin * 60,
    maxWalkMin: p.maxWalkMin,
  };
  const modes = SETTINGS.transportations();
  if (modes.length) o.modes = modes.flatMap((m) => ENGINE_MODES[m] || []);
  return o;
}

// ---- Lines ----
// The page tells a ride's mode from its category (modeOf) and builds its label from category + number
// (lineLabel). The engine names the mode itself; its line name often repeats the category ("IC61", "S1").
type AppMode = 'train' | 'tram' | 'bus' | 'boat' | 'cable';
const APP_MODE: Partial<Record<KanteMode, AppMode>> = { rail: 'train', rack: 'train', tram: 'tram', metro: 'tram', boat: 'boat', funicular: 'cable', cableway: 'cable', lift: 'cable' };
const CATEGORY_MODE: [RegExp, AppMode][] = [
  [/^(IC|ICE|ICN|IR|IRE|EC|EN|EXT|NJ|RE|R|RB|S|SN|PE|TGV|RJX|TER)$/, 'train'],
  [/^(T|TRAM|M)$/, 'tram'],
  [/^(BAT|FAE|BAV)$/, 'boat'],
  [/^(FUN|PB|GB|SL|LB|ASC)$/, 'cable'],
];
const PLAIN_CATEGORY = { train: 'R', tram: 'T', bus: 'B', boat: 'BAT', cable: 'FUN' };
function lineOf(line: KanteLine): ShownLine {
  const mode = APP_MODE[line.mode] || 'bus';
  const name = line.name || '';
  let category = (line.category || '').toUpperCase();
  let number = name.toUpperCase().startsWith(category) ? name.slice(category.length).trim() : name;
  const known = CATEGORY_MODE.find(([re]) => re.test(category));
  // a category the page would take for another mode: a plain one of the right mode, the full name as its number
  if ((known ? known[1] : 'bus') !== mode) { category = PLAIN_CATEGORY[mode]; number = name; }
  return { name: `${category} ${number}`.trim(), category, number, operator: line.operator || '' };
}

// ---- Rides ----
// A trip's call written into a stop of the ride. At the stop where the trip changes, the stop keeps the arrival of
// the trip before (arr false) or the departure of the next (dep false). The object stays the same one.
const ARR = ['arr', 'arrDelayS'] as const, DEP = ['dep', 'depDelayS'] as const;
function writeCall(stop: KanteStopCall, call: KanteStopCall, arr: boolean, dep: boolean) {
  const old: Record<string, unknown> = { ...stop }, s = stop as unknown as Record<string, unknown>;
  for (const k of Object.keys(s)) delete s[k];
  Object.assign(s, call);
  const keep = (keys: readonly string[]) => keys.forEach((k) => { if (old[k] != null) s[k] = old[k]; else delete s[k]; });
  if (!arr) keep(ARR);
  if (!dep) keep(DEP);
}
function rideOf(legs: KanteRideLeg[]): JourneyRide {
  const stops: KanteStopCall[] = [], seqIdx = legs.map(() => new Map<number, number>());
  legs.forEach((leg, n) => {
    const list = [leg.from, ...leg.intermediate, leg.to];
    list.forEach((call, k) => {
      if (call.skipped && k > 0 && k < list.length - 1) return; // the vehicle does not stop there today
      if (n > 0 && k === 0) { // the stop where the trip changes: one stop, arriving on one trip, leaving on the next
        const at = stops.length - 1;
        writeCall(stops[at], call, false, true);
        seqIdx[n].set(call.seq, at);
        return;
      }
      seqIdx[n].set(call.seq, stops.length);
      stops.push({ ...call });
    });
  });
  const first = legs[0];
  return { type: 'ride', legs, line: lineOf(first.line), headsign: first.headsign, stops, from: stops[0], to: stops[stops.length - 1],
    seqIdx, live: legs.map(() => ({ at: 0, fails: 0 })) };
}
// An answer of /api/trip for leg n of the ride: its calls written into the ride's stops
/** Writes an answer of /api/trip for trip n of the ride (its leg) into the ride's stops. */
function applyTrip(ride: JourneyRide, n: number, trip: KanteTrip) {
  const idx = ride.seqIdx[n], leg = ride.legs[n], last = ride.legs.length - 1;
  if (!idx || !leg) return;
  (trip.calls || []).forEach((c) => {
    const k = idx.get(c.seq);
    if (k == null) return;
    writeCall(ride.stops[k], c, !(n > 0 && c.seq === leg.from.seq), !(n < last && c.seq === leg.to.seq));
  });
}

// Where stop k of a ride is boarded or left → { ll, edge, travel }. edge is null when the engine only knows the
// stop, not the boarding point; travel is the way the vehicle leaves, at the first stop.
/** Where stop k of a ride is boarded or left: its boarding point, and for the first stop the way the vehicle leaves. */
function at(ride: JourneyRide, k: number): JourneyPlatformAt {
  const q = ride.stops[k].quay;
  const ll: LngLat = [q.lon, q.lat];
  const exact = q.precision === 'edge' || (q.precision === 'edge-at-station' && !!q.label);
  const edge = exact ? { ref: q.label || '', level: q.level == null ? null : q.level, ll, side: q.side ? q.side.text : '' } : null;
  const b = k === 0 ? ride.legs[0].bearing : null;
  return { ll, edge, travel: b == null ? null : b, quay: q.id };
}

// ---- Journeys ----
// A walk shorter than half a minute would round to "0 min" and drop out of the trip; one that has a way
// to go still counts as a walk
/** A walk's time as the trip shows it, seconds: at least half a minute when it has a way to go (10 m or more). */
const shownSecs = (leg: Pick<KanteWalk, 'distanceM' | 'durationS'>) => (leg.distanceM >= 10 ? Math.max(30, leg.durationS) : leg.durationS);
function journeyOf(j: KanteJourney): Journey {
  const groups: (KanteRideLeg[] | KanteWalkLeg)[] = [];
  let ride: KanteRideLeg[] | null = null;
  j.legs.forEach((leg) => {
    if (leg.type === 'ride') {
      if (leg.stayOnBoard && ride) { ride.push(leg); return; }
      ride = [leg];
      groups.push(ride);
      return;
    }
    ride = null;
    if (leg.kind === 'transfer' && !(leg.distanceM > 0)) return; // changing at the same boarding point: no walk
    groups.push(leg);
  });
  const parts = groups.map((g): JourneyPart => (Array.isArray(g) ? rideOf(g) : g));
  // the arrival as timetabled (the pill marks a later live arrival): the last ride's, plus the walk after it
  let arrival = j.arr;
  const last = parts.map((p) => p.type === 'ride').lastIndexOf(true);
  if (last >= 0) {
    arrival = (parts[last] as JourneyRide).to.arr!;
    parts.slice(last + 1).forEach((p) => { arrival += Math.round(shownSecs(p as KanteWalkLeg) / 60) * 60; });
  }
  return { ...j, parts, t0: j.dep * 1000, t1: arrival * 1000 };
}

// ---- Planning ----
type PlanBody = KantePlanBody;
interface Offers { list: KanteJourney[]; walk: KanteJourney | null }
// The engine's journeys worth showing, and walking all the way when the engine offers it (up to about
// 3.5 km and 50 minutes) → { list, walk }
function offers(res: KantePlanResponse, body: PlanBody): Offers {
  const sound = (j: KanteJourney) => !j.legs.some((l) => (l as KanteRideLeg).cancelled) && !(j.alerts || []).some((a) => a.kind === 'missed-connection');
  let list = (res.journeys || []).filter((j) => j.legs && j.legs.length);
  if (list.some(sound)) list = list.filter(sound);
  let walk = res.walkOnly && res.walkOnly.legs && res.walkOnly.legs.length === 1 ? res.walkOnly : null;
  if (walk && body.arriveBy && body.time) {
    // the engine starts this walk when its last journey leaves: move it to end at the chosen time
    const dep = body.time - walk.durationS;
    walk = { ...walk, dep, arr: body.time, legs: [{ ...walk.legs[0] as KanteWalkLeg, dep, arr: body.time }] };
  }
  return { list, walk };
}
// Which of them to show first. Leaving now or at a set time: the one that gets there first; "arrive by": the
// one that leaves last. One change less is worth three minutes. Walking all the way wins when it is no
// slower and within the maximum walk.
function pick({ list, walk }: Offers, body: PlanBody) {
  const cost = (j: KanteJourney) => (body.arriveBy ? -j.dep : j.arr) + j.transfers * 180;
  const best = list.reduce<KanteJourney | null>((a, b) => (a && cost(a) <= cost(b) ? a : b), null);
  if (!walk || !best) return best || walk;
  const noSlower = body.arriveBy ? walk.dep >= best.dep : walk.arr <= best.arr;
  return noSlower && walk.durationS <= body.options.maxWalkMin * 60 ? walk : best;
}
// Journeys that another one beats outright (leaving no earlier, arriving no later, with no more changes) are
// left out: next to its neighbours a page of the engine's answer can hold such leftovers
function prune(list: Journey[]) {
  return list.filter((a) => !list.some((b) => b !== a && b.dep >= a.dep && b.arr <= a.arr && b.transfers <= a.transfers
    && (b.dep > a.dep || b.arr < a.arr || b.transfers < a.transfers)));
}
const byDeparture = (a: Journey, b: Journey) => a.dep - b.dep;

// fromLL: [lng, lat]; dest: a search result ({ lngLat }); query: the time picker ({ mode: 'dep' | 'arr', date, time })
function request(fromLL: LngLat | null | undefined, dest: { lngLat?: LngLat | null } | null | undefined, query?: KanteTimeQuery | null) {
  if (!fromLL || !dest || !dest.lngLat) return null;
  const body: PlanBody = { from: { lat: fromLL[1], lon: fromLL[0] }, to: { lat: dest.lngLat[1], lon: dest.lngLat[0] }, options: options() };
  const { mode, date, time } = query || {};
  if (date || time) {
    const now = new Date();
    const day = date || `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    const t = new Date(`${day}T${time || `${pad2(now.getHours())}:${pad2(now.getMinutes())}`}`).getTime();
    if (!Number.isFinite(t)) return null;
    body.time = Math.floor(t / 1000);
    if (mode === 'arr') body.arriveBy = true;
  }
  return body;
}
// The engine's answer for a request; null when it found no route (it says no with HTTP 400)
async function ask(body: KantePlanRequest) {
  if (!K) throw Object.assign(new Error('engine.js not loaded'), { reason: 'off' });
  try {
    return await K.plan(body);
  } catch (e) {
    if (K.failure(e) === 'refused') return null;
    throw e; // off or down: the page says so
  }
}
// Every way to make the trip, for the list to choose from → { list: by departure, walk: walking all the way (or
// null), best: the one to show first, earlier / later: whether more() has any, request: what more() asks with }
/**
 * Every journey the engine offers for the trip, and walking all the way when that is near enough. null: the engine
 * found none (or the trip has no end yet). Throws a KanteError when the engine is off or cannot be reached.
 * fromLL: where from; dest: a search result.
 */
async function plans(fromLL: LngLat | null | undefined, dest: { lngLat?: LngLat | null } | null | undefined, query?: KanteTimeQuery | null): Promise<JourneyOptions | null> {
  const body = request(fromLL, dest, query);
  if (!body) return null;
  const res = await ask(body);
  if (!res) return null;
  const o = offers(res, body);
  const first = pick(o, body);
  if (!first) return null;
  const made = new Map<KanteJourney, Journey>(o.list.map((j) => [j, journeyOf(j)]));
  const walk = o.walk ? journeyOf(o.walk) : null;
  const best = first === o.walk ? walk! : made.get(first)!;
  const list = prune([...made.values()]);
  if (best !== walk && !list.includes(best)) list.push(best); // the one shown first stays, whatever else there is
  list.sort(byDeparture);
  return { list, walk, best, earlier: !!res.earlier, later: !!res.later, request: { body, earlier: res.earlier, later: res.later } };
}
// Earlier or later journeys for the same trip, added to plans()'s answer → true when there was a page to ask for
/**
 * Adds the earlier or later journeys for the same trip to plans()'s answer (`list`, `earlier`, `later`).
 * → false when there was no page to ask for. Throws when the engine cannot be reached.
 */
async function more(o: JourneyOptions | null | undefined, dir: 'earlier' | 'later') {
  const r = o && o.request, cursor = r && r[dir];
  if (!cursor) return false;
  const res = await ask({ ...r.body, page: cursor });
  const seen = new Set(o.list.map((c) => c.id));
  const fresh = res ? offers(res, r.body).list.filter((j) => !seen.has(j.id)).map(journeyOf) : [];
  o.list = prune([...o.list, ...fresh]).sort(byDeparture);
  r[dir] = (res && res[dir]) || null;
  o[dir] = !!r[dir];
  return true;
}

// ---- Walks ----
// The engine's walking leg as the page keeps a routed walk: its line, metres, and written directions
// with the floor changes ({ kind, text, coords, from, to } as walkDirections() lists them).
function walkParts(leg: KanteWalk): KanteWalkParts {
  const coords = leg.geometry;
  const whole = (x: number | null | undefined) => Math.round(x || 0);
  const dirs: KanteWalkDir[] = [];
  (leg.steps || []).forEach((s) => {
    if (s.kind === 'arrive') return; // the page ends the list with its own "Arrive at …"
    const vertical = /^(stairs|escalator|ramp)-|^lift$/.test(s.kind);
    const change = vertical && s.toLevel != null && whole(s.toLevel) !== whole(s.level);
    const down = /-down$/.test(s.kind) || (change && s.toLevel! < (s.level || 0));
    const up = /-up$/.test(s.kind) || (change && !down);
    const d: KanteWalkDir = { kind: down ? 'stairs-down' : up ? 'stairs-up' : !dirs.length ? 'depart' : 'walk', text: s.text, coords: coords.slice(s.from, s.to + 1) };
    if (change) { d.from = whole(s.level); d.to = whole(s.toLevel); }
    dirs.push(d);
  });
  // A change with an official minimum change time is timed by that, while the engine's path runs between the
  // platforms' registry points and can be far longer than what people walk there (long platforms, V-shaped
  // stations; cap_by_official in the engine). Metres that contradict the minutes are left out.
  const pathS = (leg.steps || []).reduce((sum, s) => sum + (s.durS || 0), 0);
  const dist = leg.kind === 'transfer' && pathS > leg.durationS + 150 ? null : leg.distanceM;
  // the building at the end: which door, or that none is step-free
  const door = leg.door ? { ll: [leg.door.lon, leg.door.lat] as LngLat, type: leg.door.kind, addr: leg.door.addr || '' } : null;
  if (leg.noStepFreeDoor) dirs.push({ kind: 'walk', text: 'No step-free entrance is mapped for this building', coords: [] });
  if (door) dirs.push({ kind: 'walk', text: door.addr ? `In at the entrance, ${door.addr}` : door.type === 'main' ? 'In at the main entrance' : 'In at the door marked on the map', coords: [door.ll] });
  const walk: KanteRoutedWalk = { coords, steps: null, dist, dirs, net: true, door,
    // the guessed straight bits at either end (drawn dashed), and the stretches under a roof
    approxTo: leg.approxStart != null ? leg.approxStart : null, approxFrom: leg.approxEnd != null ? leg.approxEnd : null,
    covered: (leg.covered || []).map((c) => ({ kind: c.kind, coords: coords.slice(c.from, c.to + 1) })) };
  return { lines: [coords], walks: [walk],
    floors: dirs.filter((d) => d.from != null && d.coords.length).map((d) => ({ at: d.coords[0], from: d.from!, to: d.to! })) };
}
// As routeWalk() keeps it: routed, or (no path found) the straight line with the engine's time for it all the same
/** The engine's walk as routeWalk() keeps it; without a path (`approximate`), the straight line with its time. */
function routed(leg: KanteWalk): ((KanteRoutedWalk | KanteStraightWalk) & { floors: KanteFloorChange[] }) | null {
  if (!leg.geometry || leg.geometry.length < 2) return null;
  if (leg.approximate) return { coords: leg.geometry, steps: null, dist: leg.distanceM, approx: true, floors: [], walkS: leg.durationS, shownS: shownSecs(leg) };
  const p = walkParts(leg);
  return { ...p.walks[0], floors: p.floors, walkS: leg.durationS, shownS: shownSecs(leg) };
}
// A walk or change step gets the engine's walk: its time, and its path, directions and floor changes when the
// engine has routed it (an approximate one stays a dashed straight line)
/** Gives a walk or change step the engine's walk: its time, and its path, directions and floor changes when it has one. */
function setWalk(st: JourneyWalkStep | JourneyChangeStep, leg: KanteWalk) {
  st.walkS = leg.durationS; // to the second, for the time to spare at a change
  st.kanteWalk = !leg.approximate && !!leg.geometry && leg.geometry.length > 1;
  if (st.kanteWalk) Object.assign(st, walkParts(leg));
}

// ---- Live ----
// After live data: a platform change moves the boarding (or alighting) point. Put the ride's ends, and the
// walks that lead to and from them, on the new one. changed() is called whenever a line on the map has moved.
/**
 * After live data: moves the rides' ends, and the walks to and from them, to the boarding points now in use.
 * changed() is called whenever a line on the map has moved; refineWalks() then asks the engine for the moved walks.
 */
function requay(steps: JourneyStep[], changed: () => void) {
  const same = (a: LngLat | null | undefined, b: LngLat | null | undefined) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
  const lastOf = (st: JourneyStep) => { const l = st.lines && st.lines[st.lines.length - 1]; return l && l[l.length - 1]; };
  const sameEdge = (x: JourneyPlatformAt, y: JourneyPlatformAt | null | undefined) => {
    const e = x.edge, f = y && y.edge;
    return (e ? e.ref : null) === (f ? f.ref : null) && (e ? e.level : null) === (f ? f.level : null) && x.quay === (y && y.quay);
  };
  const rewalk = new Map<JourneyWalkStep | JourneyChangeStep, [LngLat, LngLat]>(); // step → [from, to]
  let moved = false;
  steps.forEach((st, i) => {
    if (st.type !== 'ride') return;
    const d = at(st.s, 0), a = at(st.s, st.s.stops.length - 1);
    if (same(d.ll, st.depLL) && same(a.ll, st.arrLL) && sameEdge(d, st.depAt) && sameEdge(a, st.arrAt)) return;
    const prev = steps[i - 1], next = steps[i + 1], final = steps[steps.length - 1];
    moved = true;
    // the same point, another platform (its name or floor): the walks stay, and are routed again to it (refineWalks())
    if (same(d.ll, st.depLL) && same(a.ll, st.arrLL)) { Object.assign(st, { depAt: d, arrAt: a }); return; }
    if (!same(d.ll, st.depLL) && prev && (prev.type === 'walk' || prev.type === 'change')) {
      const from = prev.type === 'change' ? prev.points[0] : prev.lines[0] && prev.lines[0][0];
      if (prev.type === 'change') prev.points[1] = d.ll; else prev.board = d.ll;
      if (from) rewalk.set(prev, [(rewalk.get(prev) || [from])[0], d.ll]);
    }
    if (!same(a.ll, st.arrLL)) {
      // the arrival step ends where the last ride now ends, whether a walk follows it or not
      if (final.type === 'arrive' && final.from === st.s) final.end = a.ll;
      if (next && (next.type === 'walk' || next.type === 'change')) {
        const to = next.type === 'change' ? next.points[1] : next.toLL || lastOf(next); // the place, not the door last found
        if (next.type === 'change') next.points[0] = a.ll;
        else next.alight = a.ll;
        if (to) rewalk.set(next, [a.ll, (rewalk.get(next) || [null, to] as [null, LngLat])[1]]);
      }
    }
    const routed = st.path !== st.stops; // the track or road between the stops has been drawn in
    st.stops[0] = d.ll;
    st.stops[st.stops.length - 1] = a.ll;
    st.path = routed ? [d.ll, ...st.path.slice(1, -1), a.ll] : st.stops;
    Object.assign(st, { depAt: d, depLL: d.ll, arrAt: a, arrLL: a.ll });
  });
  rewalk.forEach(([a, b], st) => {
    // straight to the new point at once; refineWalks() then asks the engine for the way there and its time
    const lines = same(a, b) ? [] : [[a, b]];
    Object.assign(st, { lines, walks: undefined, floors: undefined, kanteWalk: false });
    if (!lines.length) { // no walk left: both rides at one point
      st.walkS = 0;
      if (st.type === 'change') st.walkMin = 0; else st.min = 0;
    }
  });
  if (moved) changed();
}

export const KanteJourney = { plans, more, at, walkSecs: shownSecs, setWalk, routed, applyTrip, requay, options };
