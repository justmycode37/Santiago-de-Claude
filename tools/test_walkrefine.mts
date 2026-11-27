// Tests for how a journey's walks are drawn and routed again while it is open (src/app/routing.ts, requay() and
// the engine's walks in src/engine-journey.ts): the engine's walk as the page keeps it (door, covered stretches,
// guessed ends), what routeWalk() asks the engine, and answers that arrive late, after the walk has moved, been
// cancelled or changed platform, are dropped. The routing module, the engine's journeys, the journey's steps
// (src/app/journey-steps.ts: what the sheet and the map read, the time to spare at a change, the journey's times)
// and the live updates (src/app/live-engine.ts) are imported as they are, with the parts of the page they import
// stubbed. Journeys are planned as the app plans them (KanteJourney.plans(), buildSteps()); the engine's /api/plan
// and /api/trip answer what the test sets, its /api/walk (KANTE.walk()) and the station models
// (Station3D.loadData()) with promises the test settles. Offline; exit code 1 on any failure.
//
//   node --experimental-test-module-mocks tools/test_walkrefine.mts
import { mock } from 'node:test';

import type { KanteFloorChange } from '../src/engine.ts';

let passed = 0, failed = 0;
const check = (ok: boolean, what: string) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };
const defer = <T,>(): Deferred<T> => {
  let res!: (answer: T) => void, rej!: (e: Error) => void;
  const p = new Promise<T>((r, j) => { res = r; rej = j; });
  return { p, res, rej };
};
const settle = () => new Promise((r) => setTimeout(r, 0));

// ---- the app as these tests stand in for it: only what the routing code and the engine's journeys read and write ----
interface Deferred<T> { p: Promise<T>; res: (answer: T) => void; rej: (e: Error) => void }
/** What an end of a walk is (WalkEnd in src/app/routing.ts). */
interface FakeEnd { gps?: boolean; platform?: boolean; level?: number | null; ref?: string | null; quay?: string; exact?: boolean }
/** A stop of a ride, as the engine's call: its boarding point (by its name), or its times (unix seconds). */
interface FakeStop { quay?: { label: string; id?: string } | FakeQuay; dep?: number; arr?: number }
/** Where a ride is boarded or left, as the engine has it (requay()). */
interface FakeQuay { id?: string; lon: number; lat: number; precision: string; label: string; level: number }
interface FakePlatformAt { ll: LngLat; edge: { ref: string; bearing: null; level: number; ll: LngLat; side: string }; travel: null }
/** A routed walk as the step keeps it (RoutedWalk in src/app/routing.ts), as far as these tests read it. */
interface FakeRouted { coords: LngLat[]; dist: number | null; approx?: boolean; net?: boolean; walkS?: number;
  door?: { ll: LngLat; type: string; addr: string } | null; dirs?: { text: string }[];
  covered?: { kind: string; coords: LngLat[] }[]; approxTo?: number | null; approxFrom?: number | null; floors?: KanteFloorChange[] }
/** A step of the journey (type: 'walk', 'change', 'ride', 'arrive'). */
interface FakeStep {
  type: string;
  // a walk or change: the lines drawn, what they were routed between, the routed walks, its times
  lines?: LngLat[][];
  points?: LngLat[];
  ends?: [FakeEnd, FakeEnd][];
  walks?: FakeRouted[];
  prev?: { to: FakeStop };
  next?: { from: FakeStop };
  from?: { to: FakeStop } | null;
  kanteWalk?: boolean;
  final?: boolean;
  toLL?: LngLat;
  t0?: number;
  t1?: number;
  min?: number;
  walkMin?: number;
  walkS?: number;
  // a ride: its stops (the engine's calls) and its trips
  s?: { stops: { quay: FakeQuay }[]; from?: { quay: FakeQuay }; to?: { quay: FakeQuay }; legs: object[] };
  depLL?: LngLat;
  arrLL?: LngLat;
  depAt?: FakePlatformAt;
  arrAt?: FakePlatformAt;
  stops?: LngLat[];
  path?: LngLat[];
  // the arrival
  time?: number;
}
type FakeEngineWalk = Partial<KanteWalk> & { durationS: number; geometry: LngLat[]; approximate: boolean; steps: KanteWalkStep[] };
/** A station model as the stubbed router reads it: the route through it is in it. */
interface FakeModel { route: { points: LngLat[]; steps: []; fromStop: boolean; toStop: boolean; length: number; seconds: number } }
/** The page around the routing code, as these tests stand in for it: what the stubs read and keep. */
interface AppPage {
  /** What the engine's /api/walk was asked (KANTE.walk()), each answered when the test says. */
  asked: { body: KanteWalkRequest; d: Deferred<FakeEngineWalk> }[];
  /** The station models asked for (Station3D.loadData()), answered when the test says with the route through it. */
  station: Deferred<FakeModel>[];
  plan: { key: string } | null;
  /** What the engine's /api/plan answers (KANTE.plan()), and /api/trip for each trip (KANTE.trip()). */
  planned: KantePlanResponse | null;
  trips: Record<string, KanteTrip>;
  /** The URLs fetched (the routers on the web: OSRM's foot profile, the ride routers), and what OSRM's foot profile
   *  answers for a walk between two points (null: no answer). */
  fetched: string[];
  foot: ((a: LngLat, b: LngLat) => object | null) | null;
}
/** What src/app/routing.ts exports, as far as these tests call it. */
interface AppRouting {
  refineWalks(id: number, onlyMoved?: boolean): void;
  routeWalk(a: LngLat, b: LngLat, ends?: [FakeEnd, FakeEnd]): Promise<FakeRouted>;
  stationWalk(st: FakeStep, plan: { key: string }, asPlanned?: boolean): Promise<{ lines: LngLat[][]; walks: FakeRouted[]; floors: KanteFloorChange[] | null; street?: boolean } | null>;
}
/** The state the routing code reads and writes (src/app/state.ts). */
interface AppState {
  journey: { steps: FakeStep[]; req: number; routeKey: string; conn: object | null; dest: { lngLat: LngLat; title: string } | null; platKey: string };
  tracking: { geoVersion: number };
}
/** The engine's journeys (src/engine-journey.ts), as far as these tests call them. */
interface EngineJourneys {
  requay(steps: object[], changed: () => void): void;
  routed(leg: FakeEngineWalk): FakeRouted | null;
  plans(fromLL: LngLat, dest: { lngLat: LngLat }): Promise<{ best: object } | null>;
}
/** A feature of the journey's map (stepFeatures() in src/app/journey-steps.ts): a walk's line, a door, a stop… */
interface MapFeature { properties: { kind: string; step: number; approx?: boolean }; geometry: { type: string; coordinates: LngLat | LngLat[] } }
/** The journey's steps as the sheet and the map read them (src/app/journey-steps.ts). */
interface AppSteps {
  buildSteps(conn: object, destTitle: string): FakeStep[];
  stepFeatures(steps: FakeStep[]): MapFeature[];
  /** The time to spare at a change, as the sheet writes it ("2 min to spare"). */
  spareOf(st: FakeStep): { s: number; level: string; text: string; est: boolean };
  /** When the journey leaves and arrives, as the header, the pill and the timeline's first and last rows show it. */
  journeyStart(): number;
  journeyEnd(): number;
}
/** The live updates (src/app/live-engine.ts): /api/trip for every ride, and what follows from its answers. */
interface LiveEngine { livePoll(): Promise<void>; platSig(): string }

// The app around the routing code: the parts of the page it imports, stubbed (node --experimental-test-module-mocks),
// and what it asks: the engine's /api/walk hands back promises kept in `asked`, the station models in `station`
let page: AppPage;
const APP = new URL('../src/app/', import.meta.url);
// The module's exports go in as `exports` from Node 24.15 and 25.9 on, as `namedExports` before (which later
// versions still take, with a deprecation warning)
const [major, minor] = process.versions.node.split('.').map(Number);
const hasExports = major > 25 || (major === 25 && minor >= 9) || (major === 24 && minor >= 15);
const fake = (file: string, exports: Record<string, unknown>) => mock.module(new URL(file, APP).href,
  (hasExports ? { exports } : { namedExports: exports }) as Parameters<typeof mock.module>[1]);
const nothing = () => {};
const marker = { remove: nothing };
fake('map.ts', { map: { flyTo: nothing } });
fake('map-events.ts', { updateCards: nothing });
fake('location.ts', { userLngLat: null });
fake('search.ts', { destMarker: marker, startMarker: marker });
fake('search-pins.ts', { clearPlacePins: nothing, render: nothing });
fake('trip-ends.ts', { blurSearch: nothing, setField: nothing, setFollowing: nothing, setPlanOpen: nothing });
fake('pins.ts', { armPin: nothing, pinMenu: marker });
fake('map-places.ts', { updatePlaces: nothing });
fake('journey-map.ts', { jBody: null, jFoot: null, jHead: null, setRoute: nothing });
fake('platforms.ts', { platformKey: (p: string | null | undefined) => String(p || '').toUpperCase() });
fake('sprites.ts', { INK: '#000' });
fake('tracking.ts', { nowMarker: marker, placeUserDot: nothing, vehMarker: marker, journeyProgress: () => null, stopKms: () => null, tripLive: () => true });
fake('live-vehicles.ts', { vehShowsTrip: () => false, platformOf: (s: FakeStop) => (s.quay && s.quay.label) || '–', vehUpdate: nothing,
  fmtDist: (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`),
  levelShort: (l: number) => (l < 0 ? '−' + -l : String(l)), platformWord: () => 'Platform', splitPlatform: (p: string) => ({ num: p || '', sectors: '' }) });
fake('sheet-content.ts', { queueSheet: nothing, renderSheet: nothing, s3Plan: () => page.plan, s3Prefs: () => ({}) });
fake('pill.ts', { updateProgress: nothing, updatePillTimes: nothing });
fake('time-picker.ts', { closeTimeSheet: nothing, updateWhenChip: nothing });
fake('walk-reroute.ts', { rerouteTimes: nothing, rerouteAsk: () => ({ time: 0, limitS: null }), noteFix: () => false }); // (rerouting from where GPS puts you: test_walkreroute.mts)
// the modules beside the page's that the routing code and the engine's journeys read: the settings, the station
// models and their router, the engine's client
const prefs = { walkKmh: 4.68, stepFree: false, fewerStairs: false, noEscalators: false, wheelchair: false, extraChangeMin: 0, maxWalkMin: 20 };
fake('../settings.ts', { SETTINGS: { prefs: () => prefs, transportations: () => [] } });
fake('../station3d.ts', { Station3D: { loadData: () => { const d = defer<FakeModel>(); page.station.push(d); return d.p; }, preload: nothing },
  stationRouter: () => ({ route: (model: FakeModel) => model.route, toLngLat: (_model: FakeModel, p: LngLat) => p }) });
fake('../engine.ts', { KANTE: { available: () => true, base: 'https://engine.test', uicOf: (id: string) => id, failure: () => 'down',
  walk: (body: KanteWalkRequest) => { const d = defer<FakeEngineWalk>(); page.asked.push({ body, d }); return d.p; },
  plan: async () => page.planned, trip: async (tripId: string) => page.trips[tripId] || null } });
fake('../live.ts', { KANTE_LIVE: { isLive: () => true, liveInfoOf: () => ({}) } });
// (the rides' tracks and roads are asked of BRouter and OSRM: no answer here, so they stay the lines between the stops;
// OSRM's foot profile answers what the test sets, page.foot)
const fetchStub = async (url: string) => {
  page.fetched.push(url);
  const m = /routed-foot\/route\/v1\/foot\/([-\d.]+),([-\d.]+);([-\d.]+),([-\d.]+)\?/.exec(url);
  const answer = m && page.foot ? page.foot([+m[1], +m[2]], [+m[3], +m[4]]) : null;
  return answer ? { ok: true, json: async () => answer } : { ok: false };
};
Object.assign(globalThis, { requestAnimationFrame: (f: () => void) => f(), document: { hidden: false }, fetch: fetchStub });
// (a specifier TypeScript does not follow: the app's modules are checked with the app, not with the tools)
const load = (file: string) => import(new URL(file, APP).href);
const R: AppRouting = await load('routing.ts');
const S: AppState = await load('state.ts');
const J: EngineJourneys = (await load('../engine-journey.ts')).KanteJourney;
const JS: AppSteps = await load('journey-steps.ts');
const LE: LiveEngine = await load('live-engine.ts');
/** A fresh page for a test: nothing asked yet, and the state as when the page has just planned journey 1. */
function app() {
  page = { asked: [], station: [], plan: null, planned: null, trips: {}, fetched: [], foot: null };
  Object.assign(S.journey, { steps: [], req: 1, routeKey: '', conn: null, dest: null, platKey: '' });
  S.tracking.geoVersion = 0;
  return page;
}
const A: LngLat = [7.43, 46.94], B: LngLat = [7.44, 46.95], C: LngLat = [7.45, 46.96];
const stop = (platform: string): FakeStop => ({ quay: { label: platform } });
// a ride beside the walk under test, without times
const aRide = (): FakeStep => ({ type: 'ride', s: { stops: [], legs: [] } });
const step = (kind: KanteWalkStep['kind'], from: number, to: number, text: string = kind): KanteWalkStep => ({ kind, text, distM: 10, durS: 8, from, to });
// an answer of the engine's /api/walk: a path along these points (100 m, 80 s unless said)
const walk = (cs: LngLat[], more: Partial<FakeEngineWalk> = {}): FakeEngineWalk => ({ kind: 'direct', durationS: 80, distanceM: 100, approximate: false,
  geometry: cs, levels: cs.map(() => null), steps: [step('walk', 0, cs.length - 1)], ...more });
// a station model whose route is this line
const model = (line: LngLat[], toStop = true, seconds = 80): FakeModel => ({ route: { points: line, steps: [], fromStop: true, toStop, length: 100, seconds } });
const at = (b: KanteWalkRequest['to']) => (b.lon != null ? [b.lon, b.lat] as LngLat : null);
const same = (p: LngLat | null, q: LngLat) => !!p && p[0] === q[0] && p[1] === q[1];
// a moved point: n metres east of p
const east = (p: LngLat, m: number): LngLat => [p[0] + m / (111320 * Math.cos(p[1] * Math.PI / 180)), p[1]];


// ---- journeys as the app has them: the engine's journey (/api/plan) through KanteJourney.plans() and buildSteps(),
// its walks refined (refineJourney()), and live data through livePoll() (/api/trip) ----
const NOW = Math.floor(Date.now() / 60000) * 60, T = (min: number) => NOW + min * 60; // unix seconds, whole minutes from now
const quayAt = (id: string, ll: LngLat, label: string, level = 0, station = 'st:8507000'): KanteQuay => ({ id, sloid: id, stationId: station,
  stationName: station === 'st:8507000' ? 'Bern' : 'Zürich HB', label, noun: 'edge', lat: ll[1], lon: ll[0], precision: 'edge', level, modes: ['rail'] });
const callAt = (seq: number, quay: KanteQuay, arr?: number, dep?: number): KanteStopCall => ({ seq, quay, ...(arr != null ? { arr } : {}), ...(dep != null ? { dep } : {}) });
const rideLeg = (tripId: string, from: KanteStopCall, to: KanteStopCall): KanteRideLeg => ({ type: 'ride', tripId, serviceDate: '2026-11-23', from, to,
  line: { name: 'IC1', category: 'IC', mode: 'rail', operator: 'SBB' }, headsign: 'Zürich HB', intermediate: [], geometry: [], live: 'timetable' });
const point = (ll: LngLat, quay?: KanteQuay): KanteWalkPoint => ({ name: quay ? quay.stationName : 'Kunsthaus', lat: ll[1], lon: ll[0], ...(quay ? { quay } : {}) });
const walkLeg = (kind: KanteWalk['kind'], from: KanteWalkPoint, to: KanteWalkPoint, dep: number, durationS: number, more: Partial<KanteWalk> = {}): KanteWalkLeg => {
  const geometry: LngLat[] = [[from.lon, from.lat], [to.lon, to.lat]];
  return { type: 'walk', kind, from, to, dep, arr: dep + durationS, durationS, distanceM: Math.round(durationS * 1.3), stairsUp: 0, stairsDown: 0, lifts: 0,
    escalators: 0, stepFree: true, approximate: false, geometry, levels: [null, null], steps: [step('walk', 0, 1)], ...more };
};
/** The journey on show, as startJourney() and renderJourney() (src/app/pill.ts) make it: planned to `dest`, laid out,
 *  its walks refined. */
async function show(legs: KanteLeg[], dest: LngLat) {
  const first = legs[0], last = legs[legs.length - 1];
  const dep = first.type === 'ride' ? first.from.dep! : first.dep, arr = last.type === 'ride' ? last.to.arr! : last.arr;
  page.planned = { journeys: [{ id: 'j1', dep, arr, durationS: arr - dep, transfers: legs.filter((l) => l.type === 'ride').length - 1, walkS: 0, walkM: 0, legs }] } as unknown as KantePlanResponse;
  const o = await J.plans(A, { lngLat: dest });
  S.journey.conn = o!.best;
  S.journey.dest = { lngLat: dest, title: 'Kunsthaus' };
  S.journey.steps = JS.buildSteps(o!.best, 'Kunsthaus');
  S.journey.platKey = LE.platSig();
  R.refineWalks(1); // (refineJourney() without the rides' tracks and the 3D views' preloading)
  return S.journey.steps;
}
/** A live update: /api/trip answers for this trip with these calls (a platform change, new times). */
async function live(tripId: string, calls: KanteStopCall[]) {
  page.trips[tripId] = { tripId, serviceDate: '2026-11-23', calls } as KanteTrip;
  await LE.livePoll();
  await settle();
}
/** The engine answers the request it was asked (k: which one) with a walk between the points asked for. */
const answer = (k: number, durationS: number, more: Partial<FakeEngineWalk> = {}) => {
  const x = page.asked[k];
  if (!x) return settle(); // (not asked: the checks after it say so)
  x.d.res(walk([at(x.body.from)!, at(x.body.to)!], { durationS, distanceM: Math.round(durationS * 1.3), ...more }));
  return settle();
};
const minutesOf = (st: FakeStep) => (st.type === 'change' ? st.walkMin : st.min); // the walk's minutes on the card
const walkLines = (i: number) => JS.stepFeatures(S.journey.steps).filter((f) => f.properties.step === i && f.properties.kind === 'walk');

// a ride to Bern, platform 7 (at B), and the engine's walk on to a place, its path ending at the place's door
const PLACE: LngLat = east(B, 300), DOOR: LngLat = east(B, 296);
const arriving = (q: KanteQuay) => [callAt(0, quayAt('q1', A, '1', 0, 'st:8503000'), undefined, T(5)), callAt(1, q, T(30))] as [KanteStopCall, KanteStopCall];
const toDoor = (): KanteLeg[] => [rideLeg('t1', ...arriving(quayAt('q7', B, '7'))),
  walkLeg('egress', point(B, quayAt('q7', B, '7')), point(PLACE), T(30), 240, { geometry: [B, east(B, 150), DOOR], levels: [null, null, null],
    steps: [step('walk', 0, 2)], door: { lat: DOOR[1], lon: DOOR[0], kind: 'main' } })];

console.log('1. a walk cancelled while its route is on the way stays cancelled');
{
  const c = app(), st = { type: 'change', lines: [[A, B]], prev: { to: stop('1') }, next: { from: stop('2') } };
  S.journey.steps.push(st);
  R.refineWalks(1);
  check(c.asked.length === 0, "the engine's walk as planned is not asked for again");
  st.lines = [[A, C]]; // requay(): a live platform change moved its end
  R.refineWalks(1, true);
  check(c.asked.length === 1, 'the moved walk is asked for again');
  st.lines = []; // requay(): both rides at the same point now
  R.refineWalks(1, true);
  c.asked[0].d.res(walk([A, [7.435, 46.945], C])); await settle();
  check(st.lines.length === 0, 'the older answer does not bring the walk back');
}

console.log('2. a walk through a modelled station, moved while the model loads');
{
  const c = app(), st = { type: 'change', lines: [[A, B]], prev: { to: stop('1') }, next: { from: stop('2') } };
  c.plan = { key: 'bern' };
  S.journey.steps.push(st);
  R.refineWalks(1);
  st.lines = [[A, C]]; // a live platform change moved its end
  R.refineWalks(1, true);
  check(c.station.length === 2, 'the moved walk is routed again');
  c.station[1].res(model([A, [7.44, 46.955], C])); await settle();
  c.station[0].res(model([A, [7.435, 46.945], B])); await settle();
  check(st.lines[0][2] === C, 'the older answer (to the old platform) is dropped');
  R.refineWalks(1, true);
  check(c.station.length === 2, 'an unmoved walk is not routed again');
}

console.log('3. a platform change at the same point (only its name changes)');
{
  const c = app(), st: FakeStep = { type: 'walk', lines: [[A, B]], next: { from: stop('1') }, from: null };
  c.plan = { key: 'bern' };
  S.journey.steps.push(st);
  R.refineWalks(1);
  st.next!.from.quay = { label: '2' }; // Gleis 1 → Gleis 2, the same coordinates
  R.refineWalks(1, true);
  check(c.station.length === 2, 'the walk is routed again to the new platform');
  c.station[1].res(model([A, [7.44, 46.951], B])); await settle();
  c.station[0].res(model([A, [7.44, 46.949], B])); await settle();
  check(st.lines![0][1][1] === 46.951, 'the first answer (to Gleis 1) arrives late and is dropped');
  R.refineWalks(1, true);
  check(c.station.length === 2, 'and it is not routed again while nothing changes');
  st.next!.from.quay = { label: '3' }; // changed again, after its route was drawn
  R.refineWalks(1, true);
  check(c.station.length === 3, 'a routed walk is routed again when only the platform changes');
}
{
  // requay(): the engine moves the boarding edge to another platform at the very same point
  const quay = (label: string) => ({ lon: B[0], lat: B[1], precision: 'edge', label, level: 0 });
  const dep = { quay: quay('1') }, arr = { quay: { lon: C[0], lat: C[1], precision: 'edge', label: '5', level: 0 } };
  const edge = (ref: string, ll: LngLat) => ({ ll, edge: { ref, bearing: null, level: 0, ll, side: '' }, travel: null });
  const w = { type: 'walk', lines: [[A, B]] };
  const ride = { type: 'ride', s: { stops: [dep, arr], legs: [{}] }, depLL: B, arrLL: C, depAt: edge('1', B), arrAt: edge('5', C), stops: [B, C], path: [B, C] };
  const steps = [w, ride, { type: 'arrive' }];
  let changed = 0;
  J.requay(steps, () => changed++);
  check(changed === 0, 'requay(): nothing changed, nothing to do');
  dep.quay = quay('2');
  J.requay(steps, () => changed++);
  check(changed === 1 && ride.depAt.edge.ref === '2', 'requay(): another platform at the same point counts as a change (its edge is updated)');
  check(w.lines[0][1] === B, 'requay(): the walk itself is left as it is (routed again by refineWalks())');
}

console.log("4. the engine's walk as the page keeps it");
{
  const geometry: LngLat[] = [A, [7.432, 46.942], [7.435, 46.945], [7.438, 46.948], B];
  const leg: FakeEngineWalk = { kind: 'egress', durationS: 300, distanceM: 400, approximate: false, geometry, levels: [null, null, null, null, null],
    steps: [step('depart', 0, 0), step('walk', 0, 2, 'Walk 200 m under the arcades along Marktgasse'), step('stairs-down', 2, 3), step('walk', 3, 4), step('arrive', 4, 4)],
    door: { lat: B[1], lon: B[0], kind: 'addr', addr: 'Bundesgasse 3' }, covered: [{ kind: 'arcade', from: 1, to: 2 }], approxStart: 1, approxEnd: 3 };
  leg.steps[2] = { ...leg.steps[2], level: 0, toLevel: -1 };
  const r = J.routed(leg)!;
  check(!!r && r.net === true && r.coords === geometry && r.dist === 400, 'its path and metres, routed on a walking network');
  check(!!r.door && r.door.ll[0] === B[0] && r.door.addr === 'Bundesgasse 3' && r.door.type === 'addr', 'the door it ends at');
  check(!!r.dirs && r.dirs[r.dirs.length - 1].text === 'In at the entrance, Bundesgasse 3', 'and the written direction for it');
  check(!!r.covered && r.covered.length === 1 && r.covered[0].coords.length === 2 && r.covered[0].coords[1] === geometry[2], 'the stretch under the arcades');
  check(r.approxTo === 1 && r.approxFrom === 3, 'the guessed ends');
  check(!!r.floors && r.floors.length === 1 && r.floors[0].from === 0 && r.floors[0].to === -1, 'the floor change');
  const old = J.routed({ kind: 'direct', durationS: 60, distanceM: 80, approximate: false, geometry: [A, B], levels: [null, null], steps: [step('walk', 0, 1)] })!;
  check(old.door === null && old.covered!.length === 0 && old.approxTo === null && old.approxFrom === null, 'from an older engine (no doors): the path alone');
  const none = J.routed({ durationS: 200, distanceM: 80, approximate: true, geometry: [A, B], levels: [null, null], steps: [] });
  check(!!none && none.approx === true && none.coords.length === 2 && none.walkS === 200 && none.dist === 80,
    "no path found: the straight line, with the engine's time for it");
  check(J.routed({ durationS: 60, distanceM: 0, approximate: true, geometry: [A], levels: [null], steps: [] }) === null, 'no line at all: none');
  const sf = J.routed({ ...leg, door: undefined, noStepFreeDoor: true })!;
  check(sf.dirs!.some((d) => d.text === 'No step-free entrance is mapped for this building') && sf.door === null, 'step-free, no step-free door: said so');
}

console.log('5. the walk to the destination is routed to the place, not to the door it found');
{
  const c = app();
  const steps = await show(toDoor(), PLACE);
  const st = steps.find((x) => x.type === 'walk' && x.final)!;
  check(same(st.lines![0][2], DOOR) && c.asked.length === 0, "as planned: the engine's path, to the door");
  await live('t1', arriving(quayAt('q3', C, '3'))); // the train arrives at platform 3, elsewhere
  check(c.asked.length === 1 && same(at(c.asked[0].body.to), PLACE), `from platform 3: routed to the place (${c.asked[0] && JSON.stringify(c.asked[0].body.to)})`);
  await answer(0, 300);
  await live('t1', arriving(quayAt('q4', east(C, 50), '4'))); // and again, now from the end of the path it was given
  check(c.asked.length === 2 && same(at(c.asked[1].body.to), PLACE), 'routed to the place again');
}

console.log('6. what routeWalk() asks the engine, and the straight line without an answer');
{
  const c = app();
  const p = R.routeWalk(A, B, [{ platform: true, level: -1, ref: '7', quay: 'ch:1:sloid:7000:4:7' }, { exact: true }]);
  const q = c.asked[0].body;
  c.asked[0].d.res(walk([A, [7.435, 46.945], B], { distanceM: 90 }));
  const r = await p;
  check(q.from.quay === 'ch:1:sloid:7000:4:7' && q.from.lat === A[1] && q.from.lon === A[0], 'from the boarding point by its id (and its point, for an older engine)');
  check(q.to.exact === true && q.to.quay === undefined && q.to.lat === B[1], 'to the point as it is (where a station model begins)');
  check(!!q.options && q.options.walkSpeed === 1.3 && q.options.stairs === 'ok', `with the traveller's options (${JSON.stringify(q.options)})`);
  check(r.coords.length === 3 && r.dist === 90 && !r.approx, "the engine's path");
  const p2 = R.routeWalk(A, B);
  c.asked[1].d.res(walk([A, B]));
  await p2;
  check(c.asked[1].body.from.quay === undefined && c.asked[1].body.to.exact === undefined, 'a place: no boarding point, not exact (its door)');
  const p3 = R.routeWalk(A, B);
  c.asked[2].d.res({ durationS: 60, distanceM: 85, approximate: true, geometry: [A, B], levels: [null, null], steps: [] });
  const none = await p3;
  check(none.approx === true && none.coords.length === 2 && none.walkS === 60, "no path found: the straight line, with the engine's time");
  const p4 = R.routeWalk(A, B);
  c.asked[3].d.rej(new Error('down')); // the engine is down
  const down = await p4;
  check(down.approx === true && down.coords[1] === B && down.dist === null && down.walkS === undefined, 'no answer at all: the straight line');
}

console.log('7. requay(): a change left without a walk, and a moved walk drawn straight');
{
  const c = app();
  const quay = (ll: LngLat, label: string) => ({ id: `q${label}`, lon: ll[0], lat: ll[1], precision: 'edge', label, level: 0 });
  const edge = (ref: string, ll: LngLat) => ({ ll, edge: { ref, bearing: null, level: 0, ll, side: '' }, travel: null });
  // a ride as the journey has it: its first and last stop are its `from` and `to`
  const ride = (dep: string, arr: string, d: LngLat, a: LngLat) => {
    const stops = [{ quay: quay(d, dep) }, { quay: quay(a, arr) }];
    return { type: 'ride', s: { stops, from: stops[0], to: stops[1], legs: [{}] }, depLL: d, arrLL: a, depAt: edge(dep, d), arrAt: edge(arr, a), stops: [d, a], path: [d, a] };
  };
  // both rides now at the same point: the change has no walk left, and no walk time either
  const r1 = ride('1', '5', A, B), r2 = ride('6', '7', C, [7.47, 46.97]);
  const change = { type: 'change', lines: [[B, C]], points: [B, C], walkMin: 5, walkS: 300, prev: r1.s, next: r2.s };
  r2.s.stops[0].quay = quay(B, '6');
  J.requay([r1, change, r2, { type: 'arrive' }], () => {});
  check(change.lines.length === 0 && change.walkMin === 0 && change.walkS === 0, 'a change without a walk has no walk time (its spare time is the whole wait)');
  // moved: the change is drawn straight to the new boarding point at once; requay() asks the engine nothing itself
  const r3 = ride('1', '5', A, B), r4 = ride('6', '7', C, [7.47, 46.97]);
  const ch = { type: 'change', lines: [[B, C]], points: [B, C], walkMin: 5, walkS: 300, prev: r3.s, next: r4.s };
  const D: LngLat = [7.46, 46.965];
  r4.s.stops[0].quay = quay(D, '8');
  let changed = 0;
  J.requay([r3, ch, r4, { type: 'arrive' }], () => changed++);
  check(changed === 1 && ch.lines.length === 1 && ch.lines[0][1][0] === D[0] && ch.lines[0][1][1] === D[1], 'requay(): the walk is drawn straight to the new point');
  check(c.asked.length === 0, 'requay(): no request of its own (refineWalks() asks, once)');
  // the last ride ends on another platform and no walk follows it: the arrival step ends there too
  const r5 = ride('1', '5', A, B), arrive = { type: 'arrive', from: r5.s, end: B };
  r5.s.stops[1].quay = quay(C, '6');
  J.requay([r5, arrive], () => {});
  check(arrive.end[0] === C[0] && arrive.end[1] === C[1], "requay(): the arrival step follows the last ride's new platform when no walk comes after it");
}

console.log('8. two platform changes in a row, and one request per moved walk');
{
  const c = app();
  const st: FakeStep = { type: 'change', lines: [[A, B]], prev: { to: stop('1') }, next: { from: stop('2') }, walkMin: 1, walkS: 45 };
  S.journey.steps.push(st);
  R.refineWalks(1);
  st.lines = [[A, C]]; // requay(): Gleis 2 → Gleis 3, at another point
  st.next!.from.quay = { label: '3' };
  R.refineWalks(1, true);
  R.refineWalks(1, true); // moved() runs again (the live update calls it twice)
  check(c.asked.length === 1, `one request for the moved walk (${c.asked.length})`);
  st.next!.from.quay = { label: '4' }; // Gleis 4 at Gleis 3's point, while that answer is on its way
  R.refineWalks(1, true);
  check(c.asked.length === 2, 'the new platform is asked for');
  c.asked[1].d.res(walk([A, [7.441, 46.951], C], { distanceM: 200, durationS: 160 })); await settle();
  c.asked[0].d.res(walk([A, [7.442, 46.952], C], { distanceM: 60, durationS: 45 })); await settle();
  check(st.walkS === 160 && st.walkMin === 3 && st.lines![0][1][0] === 7.441, `Gleis 4's path and time stay (${st.walkS} s), the late answer for Gleis 3 is dropped`);
  R.refineWalks(1, true);
  check(c.asked.length === 2, 'and nothing is asked again once it is in');
}

console.log("9. after a modelled station, the walk to the destination goes to the place (its door is the engine's choice)");
{
  const c = app();
  c.plan = { key: 'bern' };
  const steps = await show(toDoor(), PLACE);
  const st = steps.find((x) => x.type === 'walk' && x.final)!;
  c.station[0].res(model([B, [7.441, 46.951]], false)); await settle();
  check(c.asked.length === 1 && same(at(c.asked[0].body.to), PLACE) && c.asked[0].body.from.exact === true,
    `the last stretch is routed to the place, not to the door drawn before (${c.asked[0] && JSON.stringify(c.asked[0].body.to)})`);
  await answer(0, 200);
  check(st.lines!.length === 2 && same(st.lines![1][1], PLACE), "the model's way, then the engine's to the place");
}

console.log('10. a station model that does not load: one request per line, none twice');
{
  // moved since the plan (requay() drew it straight): along the streets, one request for each of its lines, and
  // its time from those answers
  const c = app();
  c.plan = { key: 'bern' };
  const st: FakeStep = { type: 'walk', lines: [[A, B], [B, C]], ends: [[{}, { exact: true }], [{ exact: true }, { platform: true, quay: 'q7' }]],
    from: null, next: { from: stop('7') }, kanteWalk: true };
  S.journey.steps.push(st, aRide());
  R.refineWalks(1);
  c.station[0].rej(new Error('404')); await settle();
  check(c.asked.length === 0, "as planned: the engine's walk stays, nothing is asked");
  st.lines = [[A, B], [B, east(C, 30)]];
  st.kanteWalk = false;
  R.refineWalks(1, true);
  c.station[1].rej(new Error('404')); await settle();
  const keys = c.asked.map((x) => JSON.stringify(x.body));
  check(c.asked.length === 2 && new Set(keys).size === 2, `moved: one /api/walk per line, none twice (${c.asked.length})`);
  check(c.asked.length === 2 && c.asked[1].body.to.quay === 'q7', 'the line to the platform asks for its boarding point');
  c.asked.forEach((x, k) => x.d.res(walk([at(x.body.from)!, at(x.body.to)!], { durationS: 100 + k }))); await settle();
  check(c.asked.length === 2 && st.lines!.length === 2 && st.walks!.length === 2, `both lines routed along the streets, nothing asked again (${c.asked.length})`);
  // the same point, another platform: the engine's path as planned is not kept; along the streets once, and its
  // time and minutes from that answer
  const c2 = app();
  c2.plan = { key: 'bern' };
  const t1 = Date.parse('2026-11-21T12:05:00Z');
  const one: FakeStep = { type: 'walk', lines: [[A, B]], ends: [[{}, { platform: true, quay: 'q1' }]], from: null, next: { from: stop('1') }, kanteWalk: true, t1, t0: t1 - 120000, min: 2 };
  S.journey.steps.push(one, aRide());
  R.refineWalks(1);
  c2.station[0].rej(new Error('404')); await settle();
  one.next!.from.quay = { label: '2' };
  one.ends = [[{}, { platform: true, quay: 'q2' }]];
  R.refineWalks(1, true);
  c2.station[1].rej(new Error('404')); await settle();
  check(c2.asked.length === 1 && c2.asked[0].body.to.quay === 'q2', `one request, to the new platform (${c2.asked.length})`);
  c2.asked[0].d.res(walk([A, [7.436, 46.946], B], { durationS: 290 })); await settle();
  check(c2.asked.length === 1, 'its time is taken from that answer, not asked for again');
  check(one.lines![0][1][0] === 7.436 && one.walkS === 290 && one.min === 5 && one.t0 === t1 - 290000 && one.kanteWalk === true,
    `the path, its time and minutes, and when to leave (${one.walkS} s, ${one.min} min)`);
}

console.log("11. a change routed again that the engine finds no path for: its time, and the time to spare with it");
{
  const c = app();
  const P9 = east(B, 150), P12 = east(B, 400);
  const after = (q: KanteQuay) => [callAt(3, q, undefined, T(30)), callAt(4, quayAt('q2', A, '2', 0, 'st:8503000'), T(50))] as [KanteStopCall, KanteStopCall];
  const legs: KanteLeg[] = [rideLeg('t1', callAt(0, quayAt('q1', A, '1', 0, 'st:8503000'), undefined, T(5)), callAt(1, quayAt('q7', B, '7'), T(20))),
    walkLeg('transfer', point(B, quayAt('q7', B, '7')), point(P9, quayAt('q9', P9, '9')), T(20), 120), rideLeg('t2', ...after(quayAt('q9', P9, '9')))];
  const steps = await show(legs, A);
  const i = steps.findIndex((x) => x.type === 'change'), ch = steps[i];
  await live('t2', after(quayAt('q12', P12, '12')));
  c.asked[0].d.res({ kind: 'transfer', durationS: 400, distanceM: 520, approximate: true, geometry: [B, P12], levels: [null, null], steps: [] }); await settle();
  const spare = JS.spareOf(ch);
  check(ch.walkS === 400 && ch.walkMin === 7 && spare.text === '3 min to spare', `the engine's 400 s: its minutes and the time to spare (${ch.walkMin} min, ${spare.text})`);
  check(walkLines(i).length === 1 && walkLines(i)[0].properties.approx === true && ch.kanteWalk === false, 'drawn as the straight line it is');
}

console.log("12. a change through a modelled station, moved: the model's way and its time, and the time to spare with them");
{
  const c = app();
  c.plan = { key: 'bern' };
  const D: LngLat = east(C, 60);
  const off = quayAt('q7', B, '7'), on = quayAt('q9', C, '9');
  const legs: KanteLeg[] = [rideLeg('t1', callAt(0, quayAt('q1', A, '1', 0, 'st:8503000'), undefined, T(5)), callAt(1, off, T(20))),
    walkLeg('transfer', point(B, off), point(C, on), T(20), 90),
    rideLeg('t2', callAt(3, on, undefined, T(26)), callAt(4, quayAt('q2', A, '2', 0, 'st:8503000'), T(50)))];
  const steps = await show(legs, A);
  const ch = steps.find((x) => x.type === 'change')!;
  check(JS.spareOf(ch).text === '4 min to spare', `as planned, the engine's 90 s: ${JS.spareOf(ch).text}`);
  c.station[0].res(model([B, [7.445, 46.955], C], true, 150)); await settle();
  check(c.asked.length === 0, 'the model draws it, the engine is not asked');
  check(ch.walkS === 150 && ch.walkMin === 3 && JS.spareOf(ch).text === '3 min to spare', `the time is the drawn way's, 150 s (${JS.spareOf(ch).text})`);
  // live: the next train leaves from platform 12, further on
  await live('t2', [callAt(3, quayAt('q12', D, '12'), undefined, T(26)), callAt(4, quayAt('q2', A, '2', 0, 'st:8503000'), T(50))]);
  check(c.station.length === 2, 'moved: the model routes it again');
  c.station[1].res(model([B, [7.446, 46.956], D], true, 300)); await settle();
  check(c.asked.length === 0 && same(ch.lines![0][2], D), "the model's way to platform 12, the engine not asked");
  const spare = JS.spareOf(ch);
  check(ch.walkS === 300 && ch.walkMin === 5 && spare.text === '1 min to spare' && spare.level === 'tight', `after the redraw: its time and the time to spare (${ch.walkMin} min, ${spare.text})`);
}

console.log("13. the last metres from a station model to the destination's door (finding 6)");
{
  // the destination as the app has it: the place the engine's last walk leads to (buildSteps())
  const toPlace = async (metres: number) => {
    const c = app();
    c.plan = { key: 'bern' };
    const end: LngLat = [7.441, 46.951], place = east(end, metres), off = quayAt('q7', B, '7');
    const legs: KanteLeg[] = [rideLeg('t1', callAt(0, quayAt('q1', A, '1', 0, 'st:8503000'), undefined, T(5)), callAt(1, off, T(30))),
      walkLeg('egress', point(B, off), point(place), T(30), 120)];
    const steps = await show(legs, place);
    const i = steps.findIndex((x) => x.type === 'walk' && x.final);
    c.station[0].res(model([B, end], false)); await settle();
    const asked = c.asked.length === 1 && same(at(c.asked[0].body.to), place) && c.asked[0].body.from.exact === true;
    const door = east(end, metres + 4);
    await answer(0, 20, { distanceM: metres + 4, door: { lat: door[1], lon: door[0], kind: 'addr', addr: 'Bundesgasse 3' } });
    const st = steps[i], last = st.walks && st.walks[st.walks.length - 1];
    const doorShown = JS.stepFeatures(steps).some((f) => f.properties.kind === 'door' && same(f.geometry.coordinates as LngLat, door))
      && !!last && !!last.dirs && last.dirs.some((d) => d.text === 'In at the entrance, Bundesgasse 3');
    return { asked, doorShown, lines: st.lines!.length };
  };
  const far = await toPlace(20);
  check(far.asked, "a destination 20 m past the model's end is routed to the place");
  check(far.lines === 2 && far.doorShown, "and the engine's door shows, on the map and in the directions");
  const near = await toPlace(1);
  check(near.asked, 'one 1 m past it is routed too');
  check(near.lines === 2 && near.doorShown, 'and its door shows');
}

console.log("14. a station model's path replaces the engine's: its time with it (finding 4)");
{
  // a planned two-minute egress; the model draws its way out of the station (60 s) and the engine the 465 m on to
  // the place (363 s): the walk takes what the drawn path takes
  const c = app();
  c.plan = { key: 'bern' };
  const P: LngLat = east(B, 470), exit: LngLat = east(B, 40);
  const arrive = quayAt('q7', B, '7');
  const legs: KanteLeg[] = [rideLeg('t1', callAt(0, quayAt('q1', A, '1', 0, 'st:8503000'), undefined, T(5)), callAt(1, arrive, T(30))),
    walkLeg('egress', point(B, arrive), point(P), T(30), 120)];
  const steps = await show(legs, P);
  const st = steps.find((x) => x.type === 'walk' && x.final)!;
  check(st.min === 2, `as planned: ${st.min} min`);
  c.station[0].res(model([B, exit], false, 60)); await settle();
  check(c.asked.length === 1 && same(at(c.asked[0].body.to), P), 'the stretch from the model to the place is asked of the engine');
  await answer(0, 363, { distanceM: 465 });
  check(st.lines!.length === 2 && same(st.lines![1][1], P), "drawn: the model's way out, then the engine's");
  check(st.walkS === 423 && st.min === 7, `its time is the drawn path's, 60 s + 363 s (${st.walkS} s, ${st.min} min)`);
}

console.log('15. a change routed again without an answer: its time estimated, and asked again (finding 3)');
{
  const c = app();
  const P9 = east(B, 150), P12 = east(B, 400);
  const off = quayAt('q7', B, '7'), on = quayAt('q9', P9, '9');
  const after = (q: KanteQuay) => [callAt(3, q, undefined, T(30)), callAt(4, quayAt('q2', A, '2', 0, 'st:8503000'), T(50))];
  const legs: KanteLeg[] = [rideLeg('t1', callAt(0, quayAt('q1', A, '1', 0, 'st:8503000'), undefined, T(5)), callAt(1, off, T(20))),
    walkLeg('transfer', point(B, off), point(P9, on), T(20), 120), rideLeg('t2', ...after(on) as [KanteStopCall, KanteStopCall])];
  const steps = await show(legs, A);
  const i = steps.findIndex((x) => x.type === 'change'), ch = steps[i];
  check(JS.spareOf(ch).text === '8 min to spare', `as planned: ${JS.spareOf(ch).text}`);
  await live('t2', after(quayAt('q12', P12, '12'))); // the next train leaves from platform 12, 250 m further on
  check(c.asked.length === 1 && c.asked[0].body.to.quay === 'q12', 'the walk to platform 12 is asked of the engine');
  c.asked[0].d.rej(new Error('down')); await settle();
  const est = JS.spareOf(ch);
  check(est.text === 'About 3 min to spare', `no answer: the time to spare is an estimate for the new platform, not the old walk's (${est.text})`);
  check(walkLines(i).length === 1 && walkLines(i)[0].properties.approx === true, 'drawn as the straight line it is');
  await live('t2', after(quayAt('q12', P12, '12'))); // the next live update, with nothing new
  check(c.asked.length === 2 && c.asked[1].body.to.quay === 'q12', `not taken for done: asked again (${c.asked.length} requests)`);
  await answer(1, 300);
  check(JS.spareOf(ch).text === '5 min to spare' && !walkLines(i)[0].properties.approx, `answered: the engine's time (${JS.spareOf(ch).text})`);
  await live('t2', after(quayAt('q12', P12, '12')));
  check(c.asked.length === 2, 'and once answered, not asked again');
}

console.log("16. the journey's departure and arrival follow its first and last walks routed again (finding 2)");
{
  // the last walk: the train now arrives at platform 3, and the walk on grows from two minutes to seven
  const c = app();
  const P: LngLat = east(B, 150), Q = east(B, -300);
  const arrival = (q: KanteQuay) => [callAt(0, quayAt('q1', A, '1', 0, 'st:8503000'), undefined, T(5)), callAt(1, q, T(30))];
  const legs: KanteLeg[] = [rideLeg('t1', ...arrival(quayAt('q7', B, '7')) as [KanteStopCall, KanteStopCall]),
    walkLeg('egress', point(B, quayAt('q7', B, '7')), point(P), T(30), 120)];
  const steps = await show(legs, P);
  const st = steps.find((x) => x.type === 'walk' && x.final)!;
  check(JS.journeyEnd() === T(32) * 1000, 'as planned: there at the train\'s arrival and two minutes');
  await live('t1', arrival(quayAt('q3', Q, '3')));
  check(c.asked.length === 1 && same(at(c.asked[0].body.to), P), 'the walk from platform 3 is asked of the engine');
  await answer(0, 420);
  check(st.min === 7 && st.t1 === T(37) * 1000, `the walk: seven minutes (${st.min} min)`);
  check(JS.journeyEnd() === T(37) * 1000, `and the journey arrives with it (${(JS.journeyEnd() / 1000 - NOW) / 60} min from now, not 32)`);
  // the first walk: the train now leaves from platform 4, five minutes' walk further
  const c2 = app();
  const S1: LngLat = east(A, 100), S4 = east(A, 450);
  const departure = (q: KanteQuay) => [callAt(0, q, undefined, T(10)), callAt(1, quayAt('q7', B, '7'), T(30))];
  const legs2: KanteLeg[] = [walkLeg('access', point(A), point(S1, quayAt('q1', S1, '1', 0, 'st:8503000')), T(8), 120),
    rideLeg('t2', ...departure(quayAt('q1', S1, '1', 0, 'st:8503000')) as [KanteStopCall, KanteStopCall])];
  const steps2 = await show(legs2, B);
  const first = steps2[0];
  check(first.type === 'walk' && JS.journeyStart() === T(8) * 1000, 'as planned: leave two minutes before the train');
  await live('t2', departure(quayAt('q4', S4, '4', 0, 'st:8503000')));
  check(c2.asked.length === 1 && c2.asked[0].body.to.quay === 'q4', 'the walk to platform 4 is asked of the engine');
  await answer(0, 420);
  check(first.t0 === T(3) * 1000 && JS.journeyStart() === T(3) * 1000, `the walk and the journey leave seven minutes before the train (${(JS.journeyStart() / 1000 - NOW) / 60} min from now)`);
}

console.log('17. another floor at the same point, and a walk split by a station model: the walk goes to the platform in use (finding 1)');
{
  // a change on the same spot, platform 7 to 8; then the train leaves from platform 18, right below platform 8
  const c = app();
  const after = (q: KanteQuay) => [callAt(3, q, undefined, T(26)), callAt(4, quayAt('q2', A, '2', 0, 'st:8503000'), T(50))];
  const legs: KanteLeg[] = [rideLeg('t1', callAt(0, quayAt('q1', A, '1', 0, 'st:8503000'), undefined, T(5)), callAt(1, quayAt('q7', B, '7'), T(20))),
    rideLeg('t2', ...after(quayAt('q8', B, '8')) as [KanteStopCall, KanteStopCall])];
  const steps = await show(legs, A);
  const i = steps.findIndex((x) => x.type === 'change'), ch = steps[i];
  check(ch.lines!.length === 0 && ch.walkMin === 0 && JS.spareOf(ch).text === '6 min to spare', `as planned: no walk, ${JS.spareOf(ch).text}`);
  await live('t2', after(quayAt('q18', B, '18', -1)));
  check(walkLines(i).length === 1, 'platform 18 is a floor down: the change has a walk on the map');
  check(c.asked.length === 1 && c.asked[0].body.to.quay === 'q18' && c.asked[0].body.from.quay === 'q7', `the engine is asked for the way to platform 18 (${c.asked.length} requests)`);
  c.asked[0]?.d.res(walk([B, east(B, 20), B], { durationS: 150, distanceM: 60, steps: [{ ...step('stairs-down', 0, 2), level: 0, toLevel: -1 }] })); await settle();
  check(ch.walkMin === 3 && JS.spareOf(ch).text === '3 min to spare', `its minutes, and the time to spare less its walk (${ch.walkMin} min, ${JS.spareOf(ch).text})`);
}
{
  // the walk to the train through a modelled station, drawn as the street up to the model and the model's way to
  // the platform; the train then leaves from platform 4 at the same point, and the model does not load
  const c = app();
  c.plan = { key: 'bern' };
  const S1: LngLat = east(A, 300), joint = east(A, 200);
  const departure = (q: KanteQuay) => [callAt(0, q, undefined, T(10)), callAt(1, quayAt('q7', B, '7'), T(30))];
  const legs: KanteLeg[] = [walkLeg('access', point(A), point(S1, quayAt('q1', S1, '1', 0, 'st:8503000')), T(6), 240),
    rideLeg('t2', ...departure(quayAt('q1', S1, '1', 0, 'st:8503000')) as [KanteStopCall, KanteStopCall])];
  const steps = await show(legs, B);
  const st = steps[0];
  c.station[0].res({ route: { points: [joint, S1], steps: [], fromStop: false, toStop: true, length: 100, seconds: 80 } }); await settle();
  await answer(0, 150);
  check(st.lines!.length === 2, 'drawn in two lines: the street up to the model, the model to the platform');
  const arrival = departure(quayAt('q1', S1, '1', 0, 'st:8503000'));
  arrival[1] = callAt(1, quayAt('q17', east(B, 80), '17'), T(30));
  await live('t2', arrival); // the train arrives at another platform: this walk has not moved
  check(c.station.length === 1 && c.asked.length === 1, `a platform change elsewhere does not route it again (${c.station.length} station routes)`);
  await live('t2', departure(quayAt('q4', S1, '4', 0, 'st:8503000')));
  check(c.station.length === 2, 'platform 4: routed again');
  c.station[1].rej(new Error('404')); await settle();
  const asks = c.asked.slice(1).map((x) => x.body);
  check(asks.length === 2 && asks[1].to.quay === 'q4' && asks.every((b) => b.to.quay !== 'q1' && b.from.quay !== 'q1'),
    `along the streets: the line to the platform asks for platform 4, none for platform 1 (${JSON.stringify(asks.map((b) => [b.from.quay, b.to.quay]))})`);
}

console.log("18. a planned walk the engine found no path for keeps its metres and its direction (finding 5)");
{
  const c = app();
  const P: LngLat = east(B, 290), off = quayAt('q7', B, '7');
  const legs: KanteLeg[] = [rideLeg('t1', callAt(0, quayAt('q1', A, '1', 0, 'st:8503000'), undefined, T(5)), callAt(1, off, T(30))),
    walkLeg('egress', point(B, off), point(P), T(30), 300, { approximate: true, distanceM: 390, steps: [step('walk', 0, 1, 'Walk about 390 m to Kunsthaus')] })];
  const steps = await show(legs, P);
  const i = steps.findIndex((x) => x.type === 'walk' && x.final), st = steps[i], w = st.walks && st.walks[0];
  check(st.min === 5 && c.asked.length === 0, "the engine's time, nothing asked");
  check(!!w && w.dist === 390, `the engine's metres (${w && w.dist})`);
  check(!!w && !!w.dirs && w.dirs[0].text === 'Walk about 390 m to Kunsthaus', `and its direction (${w && w.dirs && w.dirs.map((d) => d.text)})`);
  check(walkLines(i).length === 1 && walkLines(i)[0].properties.approx === true, 'drawn as the straight line it is');
  const r = J.routed({ kind: 'egress', durationS: 300, distanceM: 390, approximate: true, geometry: [B, P], levels: [null, null], steps: [step('walk', 0, 1, 'Walk about 390 m to Kunsthaus')] });
  check(!!r && r.approx === true && r.dist === 390 && !!r.dirs && r.dirs[0].text === 'Walk about 390 m to Kunsthaus', 'routed again: the same (routed())');
}

console.log('19. a walk of a few metres to a door stays in the trip (finding 6)');
{
  const c = app();
  const P: LngLat = east(B, 6), door: LngLat = east(B, 5), off = quayAt('q7', B, '7');
  const legs: KanteLeg[] = [rideLeg('t1', callAt(0, quayAt('q1', A, '1', 0, 'st:8503000'), undefined, T(5)), callAt(1, off, T(30))),
    walkLeg('egress', point(B, off), point(P), T(30), 5, { distanceM: 6, geometry: [B, door], door: { lat: door[1], lon: door[0], kind: 'addr', addr: 'Bundesgasse 3' } })];
  const steps = await show(legs, P);
  const i = steps.findIndex((x) => x.type === 'walk' && x.final), st = steps[i];
  check(i >= 0 && c.asked.length === 0, `six metres to the door: a walk to the destination (${steps.map((x) => x.type).join(', ')})`);
  check(i >= 0 && JS.stepFeatures(steps).some((f) => f.properties.kind === 'door' && f.properties.step === i), 'its door on the map');
  check(i >= 0 && !!st.walks && !!st.walks[0].dirs && st.walks[0].dirs.some((d) => d.text === 'In at the entrance, Bundesgasse 3'), 'and in the directions');
  check(JS.journeyEnd() === T(30) * 1000, 'arriving with the train (no minute added)');
}

// ---- the review's findings (round 3) ----
console.log('20. a walk the engine has no path for at all: OSRM foot draws it, the times stay the engine\'s (review finding 2; round 4, B)');
{
  // near Weil am Rhein (Germany): the engine's map ends at the border, so its walks there are straight lines
  const c = app();
  const W1: LngLat = [7.5891, 47.6318], S1: LngLat = [7.5925, 47.6312], S2: LngLat = [7.6010, 47.6305], W2: LngLat = [7.6051, 47.6300];
  const s1 = quayAt('qw1', S1, 'A', 0, 'st:8014000'), s2 = quayAt('qw2', S2, 'B', 0, 'st:8014001');
  const legs: KanteLeg[] = [
    walkLeg('access', point(W1), point(S1, s1), T(4), 240, { approximate: true, distanceM: 300, steps: [step('walk', 0, 1, 'Walk about 300 m to Weil')] }),
    rideLeg('t1', callAt(0, s1, undefined, T(8)), callAt(1, s2, T(14))),
    walkLeg('egress', point(S2, s2), point(W2), T(14), 300, { approximate: true, distanceM: 360, steps: [step('walk', 0, 1, 'Walk about 360 m to Kunsthaus')] })];
  // OSRM's foot profile: a way along two streets, 420 m (for the walk from W1: 300 m)
  c.foot = (a, b) => {
    const mid: LngLat = [(a[0] + b[0]) / 2, a[1]], m = same(a, W1) ? 300 : 420;
    return { code: 'Ok', routes: [{ geometry: { coordinates: [a, mid, b] }, distance: m, legs: [{ steps: [
      { distance: m - 120, name: 'Hauptstrasse', maneuver: { type: 'depart' }, geometry: { coordinates: [a, mid] } },
      { distance: 120, name: 'Schulstrasse', maneuver: { type: 'turn', modifier: 'left' }, geometry: { coordinates: [mid, b] } },
      { distance: 0, name: '', maneuver: { type: 'arrive' } }] }] }] };
  };
  // the journey's row in the list (connStart() and connEnd() in sheet-content.ts: the journey's t0 and t1) and the
  // journey opened (journeyStart() and journeyEnd(): the header, the pill, the timeline's first and last rows)
  const times = () => { const c = S.journey.conn as { t0: number; t1: number }; return { row: [c.t0, c.t1], opened: [JS.journeyStart(), JS.journeyEnd()] }; };
  const mins = (ms: number) => `+${(ms / 1000 - NOW) / 60} min`;
  const steps = await show(legs, W2);
  const before = times();
  await settle(); await settle();
  const after = times();
  const first = steps[0], i = steps.findIndex((x) => x.type === 'walk' && x.final), last = steps[i];
  const asked = c.fetched.filter((u) => u.includes('routed-foot'));
  check(asked.length === 2 && c.asked.length === 0, `OSRM foot asked once for each walk without a path (${asked.length}), the engine not again`);
  const w = last.walks && last.walks[0];
  check(last.lines![0].length === 5 && same(last.lines![0][0], S2) && same(last.lines![0][4], W2), `the last walk drawn along OSRM's way, from the platform to the place (${last.lines![0].length} points)`);
  check(!!w && w.dist === 420 && !w.approx && !walkLines(i)[0].properties.approx, `its metres (${w && w.dist}), drawn solid`);
  const texts = (w && w.dirs || []).map((d) => d.text);
  check(texts.join(' | ') === 'Walk 300 m along Hauptstrasse | Turn left and walk 120 m along Schulstrasse', `its directions, street by street (${JSON.stringify(texts)})`);
  check(last.min === 5 && last.walkS === 300, `its time the engine's: ${last.walkS} s, ${last.min} min (not 323 s at the walking pace for OSRM's 420 m)`);
  check(first.walkS === 240 && first.min === 4 && first.t0 === T(4) * 1000, `the first walk too: ${first.walkS} s, leave ${(T(8) * 1000 - first.t0!) / 1000} s before the train (not 231)`);
  const same2 = (x: number[], y: number[]) => x[0] === y[0] && x[1] === y[1];
  check(same2(before.row, [T(4) * 1000, T(19) * 1000]) && same2(before.opened, before.row),
    `before OSRM answers, the row and the journey opened: ${before.row.map(mins).join('–')}, ${before.opened.map(mins).join('–')}`);
  check(same2(after.row, before.row) && same2(after.opened, before.row),
    `after it answers, the same: the row ${after.row.map(mins).join('–')}, the journey opened ${after.opened.map(mins).join('–')}`);
  // the engine answers /api/walk without a path (a walk moved by a live update): OSRM foot again
  const r = R.routeWalk(east(W1, 50), east(W2, -50));
  await settle();
  c.asked[0].d.res({ kind: 'direct', durationS: 600, distanceM: 600, approximate: true, geometry: [east(W1, 50), east(W2, -50)], levels: [null, null], steps: [] });
  const rw = await r;
  check(rw.dist === 420 && rw.coords.length === 5 && !!rw.dirs && rw.dirs.length === 2, `routeWalk(): the engine has no path, OSRM foot has (${rw.dist} m)`);
  check(rw.walkS === 600, `…and its time is the engine's for the walk (${rw.walkS} s)`);
  // OSRM has none either: the dashed line, as the engine had it
  c.foot = () => null;
  const r2 = R.routeWalk(east(W1, 80), east(W2, -80));
  await settle();
  c.asked[1].d.res({ kind: 'direct', durationS: 600, distanceM: 600, approximate: true, geometry: [east(W1, 80), east(W2, -80)], levels: [null, null], steps: [step('walk', 0, 1, 'Walk about 600 m')] });
  const rw2 = await r2;
  check(rw2.approx === true && rw2.dist === 600 && rw2.walkS === 600, `no answer from OSRM either: the engine's straight line, metres and time (${rw2.dist} m, ${rw2.walkS} s)`);
}
{
  // a walk the engine routed, and one with guessed ends: OSRM foot is not asked
  const c = app();
  c.foot = () => { throw new Error('not to be asked'); };
  const r = R.routeWalk(A, B);
  await settle();
  c.asked[0].d.res(walk([A, [7.435, 46.945], B], { approxStart: 1 }));
  const rw = await r;
  const steps = await show(toDoor(), PLACE);
  await settle();
  check(rw.net === true && c.fetched.every((u) => !u.includes('routed-foot')) && steps.length > 0, `a routed walk (guessed ends too): OSRM foot not asked (${c.fetched.length} fetched)`);
}

console.log('21. a late answer for a platform the walk no longer goes to is dropped (review finding 3)');
{
  // the train leaves from platform 1; a live update moves it to platform 2 at the same point, then back to 1 before
  // /api/walk answers for platform 2 (its stairs: seven minutes)
  const c = app();
  const S1: LngLat = east(A, 100);
  const departure = (q: KanteQuay) => [callAt(0, q, undefined, T(10)), callAt(1, quayAt('q7', B, '7'), T(30))] as [KanteStopCall, KanteStopCall];
  const p1 = quayAt('q1', S1, '1', 0, 'st:8503000'), p2 = quayAt('q2', S1, '2', -1, 'st:8503000');
  const steps = await show([walkLeg('access', point(A), point(S1, p1), T(8), 120), rideLeg('t2', ...departure(p1))], B);
  const first = steps[0];
  check(JS.journeyStart() === T(8) * 1000, 'as planned: leave two minutes before the train');
  await live('t2', departure(p2));
  check(c.asked.length === 1 && c.asked[0].body.to.quay === 'q2', 'platform 2: the walk there is asked for');
  await live('t2', departure(p1));
  await answer(0, 420);
  check(first.walkS === 120 && JS.journeyStart() === T(8) * 1000, `back on platform 1: the late answer for platform 2 is dropped (leave ${(T(10) * 1000 - JS.journeyStart()) / 60000} min before the train)`);
  await live('t2', departure(p2));
  check(c.asked.length === 2 && c.asked[1].body.to.quay === 'q2', `platform 2 again: asked again (${c.asked.length} requests)`);
  await answer(1, 420);
  check(first.walkS === 420 && JS.journeyStart() === T(3) * 1000, 'and its answer is the walk now');
}

console.log('22. a change by lift alone keeps its time and its directions (review finding 4)');
{
  const c = app();
  const p7 = quayAt('q7', B, '7', 0), p8 = quayAt('q8', B, '8', 2);
  const lift: KanteWalkStep = { ...step('lift', 0, 1, 'Take the lift up to level 2'), durS: 150, distM: 0, level: 0, toLevel: 2 };
  const legs: KanteLeg[] = [rideLeg('t1', callAt(0, quayAt('q1', A, '1', 0, 'st:8503000'), undefined, T(5)), callAt(1, p7, T(20))),
    walkLeg('transfer', point(B, p7), point(B, p8), T(20), 150, { distanceM: 0, lifts: 1, geometry: [B, B], levels: [0, 2], steps: [lift] }),
    rideLeg('t2', callAt(3, p8, undefined, T(22)), callAt(4, quayAt('q2', A, '2', 0, 'st:8503000'), T(50)))];
  const steps = await show(legs, A);
  const ch = steps.find((x) => x.type === 'change')!, sp = JS.spareOf(ch);
  check(ch.walkS === 150 && ch.walkMin === 3, `the lift's 150 s (${ch.walkS} s, ${ch.walkMin} min)`);
  check(!!ch.walks && ch.walks[0].dirs!.some((d) => d.text === 'Take the lift up to level 2'), `and its direction (${ch.walks && JSON.stringify(ch.walks[0].dirs!.map((d) => d.text))})`);
  check(sp.level === 'missed' && sp.s === -30, `two minutes between the trains: the change is missed by 30 s (${sp.text}, ${sp.s} s)`);
  // a change at the very same boarding point, in no time: no walk
  app();
  const same0 = await show([legs[0], walkLeg('transfer', point(B, p7), point(B, p7), T(20), 0, { distanceM: 0, geometry: [B, B], levels: [0, 0], steps: [] }),
    rideLeg('t2', callAt(3, p7, undefined, T(22)), callAt(4, quayAt('q2', A, '2', 0, 'st:8503000'), T(50)))], A);
  const ch0 = same0.find((x) => x.type === 'change')!;
  check(ch0.lines!.length === 0 && ch0.walkMin === 0 && JS.spareOf(ch0).text === '2 min to spare', `the same point, no time: no walk (${JS.spareOf(ch0).text})`);
}

console.log('23. the arrival adds the walk\'s seconds, then rounds (review finding 6)');
{
  // the train arrives at 0:40 past the minute; the walk on, rerouted, takes 143 s: it ends at 3:03 past, shown as 3
  const c = app();
  const P: LngLat = east(B, 150), Q = east(B, -200);
  const arrival = (q: KanteQuay) => [callAt(0, quayAt('q1', A, '1', 0, 'st:8503000'), undefined, T(5)), callAt(1, q, T(30) + 40)] as [KanteStopCall, KanteStopCall];
  const steps = await show([rideLeg('t1', ...arrival(quayAt('q7', B, '7'))), walkLeg('egress', point(B, quayAt('q7', B, '7')), point(P), T(30) + 40, 120)], P);
  await live('t1', arrival(quayAt('q3', Q, '3')));
  await answer(0, 143);
  const st = steps.find((x) => x.type === 'walk' && x.final)!;
  check(JS.journeyEnd() === T(33) * 1000 && st.t1 === T(33) * 1000, `arriving ${(JS.journeyEnd() / 1000 - T(30)) / 60} min after the train's minute, not 2 (40 s + 143 s = 3 min 3 s)`);
}

console.log('24. requay(): a change with no walk whose platform moves a floor while the ride\'s other end moves too (review Neon 3)');
{
  const c = app();
  const after = (q: KanteQuay, end: KanteQuay) => [callAt(3, q, undefined, T(26)), callAt(4, end, T(50))] as [KanteStopCall, KanteStopCall];
  const legs: KanteLeg[] = [rideLeg('t1', callAt(0, quayAt('q1', A, '1', 0, 'st:8503000'), undefined, T(5)), callAt(1, quayAt('q7', B, '7'), T(20))),
    rideLeg('t2', ...after(quayAt('q8', B, '8'), quayAt('q2', A, '2', 0, 'st:8503000')))];
  const steps = await show(legs, A);
  const i = steps.findIndex((x) => x.type === 'change');
  check(steps[i].lines!.length === 0, 'as planned: no walk');
  await live('t2', after(quayAt('q18', B, '18', -1), quayAt('q3', C, '3', 0, 'st:8503000')));
  check(walkLines(i).length === 1 && c.asked.length === 1 && c.asked[0].body.to.quay === 'q18', `platform 18 a floor down, and the train ends elsewhere: the change has a walk, asked for (${c.asked.length} requests)`);
}

console.log('25. a change moved back to the same platform is not an estimate any more (review Neon 4)');
{
  const c = app();
  const P12 = east(B, 400);
  const after = (q: KanteQuay) => [callAt(3, q, undefined, T(26)), callAt(4, quayAt('q2', A, '2', 0, 'st:8503000'), T(50))] as [KanteStopCall, KanteStopCall];
  const steps = await show([rideLeg('t1', callAt(0, quayAt('q1', A, '1', 0, 'st:8503000'), undefined, T(5)), callAt(1, quayAt('q7', B, '7'), T(20))),
    rideLeg('t2', ...after(quayAt('q8', B, '8')))], A);
  const ch = steps.find((x) => x.type === 'change')!;
  await live('t2', after(quayAt('q12', P12, '12')));
  c.asked[0].d.rej(new Error('down')); await settle();
  check(JS.spareOf(ch).est, `platform 12, no answer: an estimate (${JS.spareOf(ch).text})`);
  await live('t2', after(quayAt('q7b', B, '7')));
  const sp = JS.spareOf(ch);
  check(ch.lines!.length === 0 && !sp.est && sp.text === '6 min to spare', `back beside the arrival: no walk, and not an estimate ("${sp.text}")`);
}

// ---- hills: a change asked again for the time there is (/api/walk limitS) ----
// a ride arriving at Bern platform 7 (B) at minute `arr`, a change of `secs` to platform 9 (150 m on), the next train
// leaving it at minute `dep`; the change's walk climbs `climb` metres (0: flat)
const P9: LngLat = east(B, 150), P12: LngLat = east(B, 400);
const inT1 = (arr: number) => [callAt(0, quayAt('q1', A, '1', 0, 'st:8503000'), undefined, T(5)), callAt(1, quayAt('q7', B, '7'), T(arr))] as [KanteStopCall, KanteStopCall];
const outT2 = (dep: number, q: KanteQuay = quayAt('q9', P9, '9')) => [callAt(3, q, undefined, T(dep)), callAt(4, quayAt('q2', A, '2', 0, 'st:8503000'), T(50))] as [KanteStopCall, KanteStopCall];
const hillChange = (secs: number, climb: number, more: Partial<KanteWalk> = {}): KanteLeg[] => [rideLeg('t1', ...inT1(20)),
  walkLeg('transfer', point(B, quayAt('q7', B, '7')), point(P9, quayAt('q9', P9, '9')), T(20), secs, { ...(climb ? { climbM: climb } : {}), ...more }),
  rideLeg('t2', ...outT2(23))];

console.log('26. a delay asks for a change again with the time there is, and takes the way that fits');
{
  const c = app();
  const steps = await show(hillChange(120, 0), A);
  const ch = steps.find((x) => x.type === 'change')!;
  check(JS.spareOf(ch).s === 60, `as planned: a minute to spare (${JS.spareOf(ch).text})`);
  await live('t1', inT1(20));
  check(c.asked.length === 0, `the same times: not asked again (${c.asked.length} requests)`);
  await live('t1', inT1(20.5)); // half a minute late: within 150 s
  check(c.asked.length === 1 && c.asked[0].body.limitS === 150 && c.asked[0].body.to.quay === 'q9', `asked again within 150 s (${JSON.stringify(c.asked.map((x) => x.body.limitS))})`);
  await answer(0, 120);
  await live('t1', inT1(21.5)); // a minute and a half late: 90 s for a 120 s walk
  check(c.asked.length === 2 && c.asked[1].body.limitS === 90, `asked again within 90 s (${JSON.stringify(c.asked.map((x) => x.body.limitS))})`);
  await answer(1, 85);
  check(JS.spareOf(ch).s === 5, `the way that fits: 5 s to spare (${JS.spareOf(ch).text})`);
  await live('t1', inT1(21.5));
  check(c.asked.length === 2, 'answered for this time: not asked again');
}

console.log('27. a forecast that moves while an answer is on the way: the answer for the other time is dropped (review Sol round 8)');
{
  const c = app();
  const steps = await show(hillChange(120, 0), A);
  const ch = steps.find((x) => x.type === 'change')!;
  await live('t1', inT1(21.5)); // 90 s
  check(c.asked.length === 1 && c.asked[0].body.limitS === 90, 'asked within 90 s');
  c.trips.t1 = { tripId: 't1', serviceDate: '2026-11-23', calls: inT1(21.55) as KanteStopCall[] } as KanteTrip;
  await LE.livePoll(); await settle(); // 87 s, the answer for 90 s still on the way
  check(c.asked.length === 2 && c.asked[1].body.limitS === 87, `asked again within 87 s (${JSON.stringify(c.asked.map((x) => x.body.limitS))})`);
  await answer(0, 89);
  check(JS.spareOf(ch).s !== -2, 'the 89 s answer for 90 s is dropped');
  await answer(1, 86);
  check(JS.spareOf(ch).s === 1, `the answer for 87 s is taken (${JS.spareOf(ch).text})`);
}

console.log('28. a delay while a moved change is being asked for drops the answer and asks again (review Neon round 7)');
{
  const c = app();
  const steps = await show(hillChange(120, 0), A);
  const ch = steps.find((x) => x.type === 'change')!;
  await live('t2', outT2(23, quayAt('q12', P12, '12'))); // the next train from platform 12, 400 m on
  check(c.asked.length === 1 && c.asked[0].body.to.quay === 'q12' && c.asked[0].body.limitS === 180, `the walk to platform 12, within 180 s (${JSON.stringify(c.asked.map((x) => [x.body.to.quay, x.body.limitS]))})`);
  c.trips.t1 = { tripId: 't1', serviceDate: '2026-11-23', calls: inT1(21.5) as KanteStopCall[] } as KanteTrip;
  await LE.livePoll(); await settle(); // a minute and a half late, its answer still on the way
  check(c.asked.length === 2 && c.asked[1].body.limitS === 90, `asked again within 90 s (${JSON.stringify(c.asked.map((x) => x.body.limitS))})`);
  await answer(0, 170); // the answer for 180 s: too late
  check(JS.spareOf(ch).s !== 90 - 170, 'the answer for the other time is dropped');
  await answer(1, 88);
  check(JS.spareOf(ch).s === 2 && !JS.spareOf(ch).est, `the answer for 90 s is taken (${JS.spareOf(ch).text})`);
}

console.log('29. a change asked again for its time alone that gets no answer keeps its walk (review Sol round 6)');
{
  const c = app();
  const steps = await show(hillChange(120, 20), A);
  const ch = steps.find((x) => x.type === 'change')!;
  const lines = ch.lines;
  await live('t1', inT1(20.5));
  check(c.asked.length === 1, 'asked again for the time there is');
  c.asked[0].d.rej(new Error('down')); await settle();
  const sp = JS.spareOf(ch);
  check(ch.lines === lines && !sp.est && sp.s === 30, `no answer: the walk it has stays, timed as it was (${sp.text})`);
  await live('t1', inT1(20.5));
  check(c.asked.length === 2, `and it is asked again (${c.asked.length} requests)`);
}

console.log('30. a change asked again keeps quiet metres its minimum change time contradicts (review Neon round 6)');
{
  app();
  const w = J.routed(walk([B, P9], { durationS: 120, distanceM: 600, officialMinS: 180, steps: [{ ...step('walk', 0, 1), durS: 420 }] }));
  check(!!w && w.dist === null, `kind "direct", a minimum change time, steps of 7 min for 2: no metres (${w && w.dist})`);
  const plain = J.routed(walk([B, P9], { durationS: 120, distanceM: 600, steps: [{ ...step('walk', 0, 1), durS: 420 }] }));
  check(!!plain && plain.dist === 600, 'without a minimum change time: its metres');
}

console.log('31. a change a station model draws is not drawn again for a delay (review Sol round 9)');
{
  const c = app();
  c.plan = { key: 'bern' };
  await show(hillChange(120, 20), A);
  check(c.station.length === 1, 'the model is asked for the change');
  c.station[0].res(model([B, P9])); await settle();
  await live('t1', inT1(20.5));
  await live('t1', inT1(21));
  check(c.station.length === 1 && c.asked.length === 0, `delays: neither the model nor the engine asked again (${c.station.length} model, ${c.asked.length} engine requests)`);
  c.plan = null;
}

console.log('32. a station model that falls back to the street for a moved change: a delay meanwhile asks again (review Sol round 10)');
{
  const c = app();
  c.plan = { key: 'bern' };
  const steps = await show(hillChange(120, 20), A);
  const ch = steps.find((x) => x.type === 'change')!;
  c.station[0].res(model([B, P9])); await settle(); // the model draws it
  await live('t2', outT2(23, quayAt('q12', P12, '12'))); // platform 12: the model again
  check(c.station.length === 2, 'the model is asked for the moved change');
  c.station[1].res(null as unknown as FakeModel); await settle(); // no model: the street, within the time there is
  check(c.asked.length === 1 && c.asked[0].body.limitS === 180, `the street way within 180 s (${JSON.stringify(c.asked.map((x) => x.body.limitS))})`);
  c.trips.t1 = { tripId: 't1', serviceDate: '2026-11-23', calls: inT1(21.5) as KanteStopCall[] } as KanteTrip;
  await LE.livePoll(); await settle(); // 90 s, the street answer still on the way
  await answer(0, 170);
  check(JS.spareOf(ch).s !== 90 - 170, 'the answer for 180 s is dropped');
  check(c.station.length === 3 || c.asked.length === 2, `and it is asked again (${c.station.length} model, ${c.asked.length} engine requests)`);
  c.plan = null;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
