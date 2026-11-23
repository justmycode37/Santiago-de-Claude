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
interface FakeRouted { coords: LngLat[]; dist: number | null; approx?: boolean; net?: boolean; walkS?: number; shownS?: number;
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
/** The page around the routing code, as these tests stand in for it: what the stubs read, count and keep. */
interface AppPage {
  sheets: number;
  /** What the engine's /api/walk was asked (KANTE.walk()), each answered when the test says. */
  asked: { body: KanteWalkRequest; d: Deferred<FakeEngineWalk> }[];
  /** The station models asked for (Station3D.loadData()), answered when the test says with the route through it. */
  station: Deferred<FakeModel>[];
  plan: { key: string } | null;
  /** What the engine's /api/plan answers (KANTE.plan()), and /api/trip for each trip (KANTE.trip()). */
  planned: KantePlanResponse | null;
  trips: Record<string, KanteTrip>;
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
  spareOf(st: FakeStep): { s: number; level: string; text: string };
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
fake('live-vehicles.ts', { platformOf: (s: FakeStop) => (s.quay && s.quay.label) || '–', vehUpdate: nothing,
  levelShort: (l: number) => (l < 0 ? '−' + -l : String(l)), platformWord: () => 'Platform', splitPlatform: (p: string) => ({ num: p || '', sectors: '' }) });
fake('sheet-content.ts', { queueSheet: () => { page.sheets++; }, renderSheet: nothing, s3Plan: () => page.plan, s3Prefs: () => ({}) });
fake('pill.ts', { updateProgress: nothing, updatePillTimes: nothing });
fake('time-picker.ts', { closeTimeSheet: nothing, updateWhenChip: nothing });
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
// (the rides' tracks and roads are asked of BRouter and OSRM: no answer here, so they stay the lines between the stops)
Object.assign(globalThis, { requestAnimationFrame: (f: () => void) => f(), document: { hidden: false }, fetch: async () => ({ ok: false }) });
// (a specifier TypeScript does not follow: the app's modules are checked with the app, not with the tools)
const load = (file: string) => import(new URL(file, APP).href);
const R: AppRouting = await load('routing.ts');
const S: AppState = await load('state.ts');
const J: EngineJourneys = (await load('../engine-journey.ts')).KanteJourney;
const JS: AppSteps = await load('journey-steps.ts');
const LE: LiveEngine = await load('live-engine.ts');
/** A fresh page for a test: nothing asked yet, and the state as when the page has just planned journey 1. */
function app() {
  page = { sheets: 0, asked: [], station: [], plan: null, planned: null, trips: {} };
  Object.assign(S.journey, { steps: [], req: 1, routeKey: '', conn: null, dest: null, platKey: '' });
  S.tracking.geoVersion = 0;
  return page;
}
const A: LngLat = [7.43, 46.94], B: LngLat = [7.44, 46.95], C: LngLat = [7.45, 46.96];
const stop = (platform: string): FakeStop => ({ quay: { label: platform } });
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
const NOW = Math.floor(Date.now() / 1000), T = (min: number) => NOW + min * 60; // unix seconds, minutes from now
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
  x.d.res(walk([at(x.body.from)!, at(x.body.to)!], { durationS, distanceM: Math.round(durationS * 1.3), ...more }));
  return settle();
};
const minutesOf = (st: FakeStep) => (st.type === 'change' ? st.walkMin : st.min); // the walk's minutes on the card
const walkLines = (i: number) => JS.stepFeatures(S.journey.steps).filter((f) => f.properties.step === i && f.properties.kind === 'walk');

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
  check(!!none && none.approx === true && none.coords.length === 2 && none.walkS === 200 && none.shownS === 200 && none.dist === 80,
    "no path found: the straight line, with the engine's time for it");
  check(J.routed({ durationS: 60, distanceM: 0, approximate: true, geometry: [A], levels: [null], steps: [] }) === null, 'no line at all: none');
  const sf = J.routed({ ...leg, door: undefined, noStepFreeDoor: true })!;
  check(sf.dirs!.some((d) => d.text === 'No step-free entrance is mapped for this building') && sf.door === null, 'step-free, no step-free door: said so');
}

console.log('5. the walk to the destination is routed to the place, not to the door it found');
{
  const c = app(), st = { type: 'walk', final: true, lines: [[A, B]], toLL: B, from: { to: stop('3') } };
  S.journey.steps.push(st, { type: 'ride' });
  R.refineWalks(1);
  st.lines = [[A, [7.435, 46.945], [7.4399, 46.9499]]]; // the engine's walk, ending at the door
  R.refineWalks(1, true);
  c.asked[0].d.res(walk([A, [7.435, 46.945], [7.4399, 46.9499]])); await settle();
  st.lines = [[C, st.lines[0][2]]]; // requay() moved its start
  R.refineWalks(1, true);
  check(c.asked.length === 2 && same(at(c.asked[1].body.to), B), 'routed to the place again');
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
  const inside: LngLat[] = [B, [7.441, 46.951]];
  const place: LngLat = [7.45, 46.955], door: LngLat = [7.4499, 46.9549];
  const st: FakeStep = { type: 'walk', final: true, lines: [[B, door]], toLL: place, from: { to: stop('3') } };
  const done = R.stationWalk(st, { key: 'bern' });
  c.station[0].res(model(inside, false)); await settle();
  check(c.asked.length === 1 && same(at(c.asked[0].body.to), place) && c.asked[0].body.from.exact === true,
    `the last stretch is routed to the place, not to the door drawn before (${c.asked[0] && JSON.stringify(c.asked[0].body.to)})`);
  c.asked[0].d.res(walk([[7.441, 46.951], place]));
  await done;
}

console.log('10. a station model that does not load: one request per line, none twice');
{
  // moved since the plan (requay() drew it straight): along the streets, one request for each of its lines, and
  // its time from those answers
  const c = app();
  c.plan = { key: 'bern' };
  const st: FakeStep = { type: 'walk', lines: [[A, B], [B, C]], ends: [[{}, { exact: true }], [{ exact: true }, { platform: true, quay: 'q7' }]],
    from: null, next: { from: stop('7') }, kanteWalk: true };
  S.journey.steps.push(st, { type: 'ride' });
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
  S.journey.steps.push(one, { type: 'ride' });
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

console.log("11. the engine's answer without a path still times the walk");
{
  const c = app();
  const t1 = Date.parse('2026-11-21T12:05:00Z');
  const st: FakeStep = { type: 'walk', lines: [[A, B]], from: null, next: { from: stop('1') }, kanteWalk: true, t1, t0: t1 - 120000, min: 2, walkS: 120 };
  S.journey.steps.push(st, { type: 'ride' });
  R.refineWalks(1);
  st.lines = [[A, C]]; // requay(): moved
  st.kanteWalk = false;
  R.refineWalks(1, true);
  const sheets = c.sheets;
  c.asked[0].d.res({ kind: 'access', durationS: 400, distanceM: 520, approximate: true, geometry: [A, C], levels: [null, null], steps: [] }); await settle();
  check(st.walkS === 400 && st.min === 7 && st.t0 === t1 - 400000, `the engine's durationS reaches the step's minutes (${st.walkS} s, ${st.min} min)`);
  check(st.walks![0].approx === true && st.kanteWalk === false && st.lines![0].length === 2, 'drawn as the straight line it is');
  check(c.sheets > sheets, 'and the card is drawn again');
}

console.log("12. a walk through a modelled station, moved: the model's way, the engine's time, and the card follows it");
{
  const c = app();
  c.plan = { key: 'bern' };
  const st: FakeStep = { type: 'change', lines: [[A, B]], prev: { to: stop('1') }, next: { from: stop('2') }, walkMin: 1, walkS: 50 };
  S.journey.steps.push(st);
  R.refineWalks(1);
  c.station[0].res(model([A, [7.435, 46.945], B])); await settle();
  check(c.asked.length === 0, 'as planned: the model draws it, the engine is not asked');
  st.lines = [[A, C]];
  R.refineWalks(1, true);
  c.station[1].res(model([A, [7.44, 46.955], C])); await settle();
  check(c.asked.length === 1 && same(at(c.asked[0].body.to), C), 'moved: one request, for its time');
  const sheets = c.sheets;
  c.asked[0].d.res(walk([A, C], { durationS: 230 })); await settle();
  check(st.walkMin === 4 && st.walkS === 230 && st.lines![0][1][1] === 46.955, `the time is the engine's, the way the model's (${st.walkMin} min)`);
  check(c.sheets === sheets + 1, `walkTime() draws the card again (${c.sheets - sheets})`);
}

console.log("13. the last metres from a station model to the destination's door");
{
  const c = app();
  c.plan = { key: 'bern' };
  const end: LngLat = [7.441, 46.951], place = east(end, 20), door: LngLat = east(end, 24);
  const st: FakeStep = { type: 'walk', final: true, lines: [[B, place]], toLL: place, from: { to: stop('3') }, kanteWalk: true };
  S.journey.steps.push({ type: 'ride' }, st);
  R.refineWalks(1);
  c.station[0].res(model([B, end], false)); await settle();
  check(c.asked.length === 1 && same(at(c.asked[0].body.to), place) && c.asked[0].body.from.exact === true,
    `a destination 20 m past the model's end is routed (${c.asked.length} request)`);
  c.asked[0].d.res(walk([end, door], { distanceM: 24, door: { lat: door[1], lon: door[0], kind: 'main' } })); await settle();
  const last = st.walks && st.walks[st.walks.length - 1];
  check(st.lines!.length === 2 && !!last && !!last.door && last.door.ll[0] === door[0], "and the engine's door shows");
  const c2 = app();
  c2.plan = { key: 'bern' };
  const near = east(end, 1);
  const st2: FakeStep = { type: 'walk', final: true, lines: [[B, near]], toLL: near, from: { to: stop('3') }, kanteWalk: true };
  S.journey.steps.push({ type: 'ride' }, st2);
  R.refineWalks(1);
  c2.station[0].res(model([B, end], false)); await settle();
  check(c2.asked.length === 0 && st2.lines!.length === 1, 'one under 2 m from it is not');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
