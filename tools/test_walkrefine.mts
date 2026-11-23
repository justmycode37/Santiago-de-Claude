// Tests for how a journey's walks are drawn and routed again while it is open (src/app/70-routing.ts, requay() and
// the engine's walks in src/engine-journey.ts): the engine's walk as the page keeps it (door, covered stretches,
// guessed ends), what routeWalk() asks the engine, and answers that arrive late, after the walk has moved, been
// cancelled or changed platform, are dropped. The sources are transpiled as they are; the engine is stubbed with
// promises the test settles. Offline; exit code 1 on any failure.
//
//   node tools/test_walkrefine.mts
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'amaro';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const js = (f: string) => transformSync(fs.readFileSync(path.join(ROOT, f), 'utf8'), { mode: 'strip-only' }).code; // as scripts/build.mts does
const ROUTING = js('src/app/70-routing.ts'), ENGINE = js('src/engine-journey.ts');
let passed = 0, failed = 0;
const check = (ok: boolean, what: string) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };
const defer = <T,>(): Deferred<T> => { let res!: (answer: T) => void; const p = new Promise<T>((r) => (res = r)); return { p, res }; };
const settle = () => new Promise((r) => setTimeout(r, 0));

// ---- the app as these tests stand in for it: only what the routing code and the engine's journeys read and write ----
interface Deferred<T> { p: Promise<T>; res: (answer: T) => void }
/** A stop of a ride, as the engine's call: its boarding point (by its name), or its times (unix seconds). */
interface FakeStop { quay?: { label: string; id?: string } | FakeQuay; dep?: number; arr?: number }
/** Where a ride is boarded or left, as the engine has it (requay()). */
interface FakeQuay { id?: string; lon: number; lat: number; precision: string; label: string; level: number }
interface FakePlatformAt { ll: LngLat; edge: { ref: string; bearing: null; level: number; ll: LngLat; side: string }; travel: null }
/** A step of the journey (type: 'walk', 'change', 'ride', 'arrive'). */
interface FakeStep {
  type: string;
  // a walk or change: the lines drawn, what they were routed between, the routed walks, its times
  lines?: LngLat[][];
  points?: LngLat[];
  ends?: [WalkEnd, WalkEnd][];
  walks?: { to?: string }[];
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
/** What routeWalk() answers, what stationWalk() does, and the engine's walk (KANTE.walk()). */
interface FakeRouted { net?: boolean; coords: LngLat[]; dist: number | null; approx?: boolean }
interface FakeStationWalk { lines: LngLat[][]; walks: { to?: string }[]; floors: KanteFloorChange[] | null }
type FakeEngineWalk = Partial<KanteWalk> & { durationS: number; geometry: LngLat[]; approximate: boolean; steps: KanteWalkStep[] };
/** The page the routing script runs in: the app's state, and what the stubs count and keep. */
interface AppPage {
  journeySteps: FakeStep[];
  journeyReq: number;
  routeKey: string;
  geoVersion: number;
  sheets: number;
  pending: { a: LngLat; b: LngLat; d: Deferred<FakeRouted> }[];
  station: Deferred<FakeStationWalk>[];
  plan: { key: string } | null;
  /** What the engine's /api/walk was asked (routeWalk()), and how it answers. */
  asked: KanteWalkRequest[];
  answer: (() => Promise<FakeEngineWalk>) | null;
  window: { KANTE?: { walk(body: KanteWalkRequest): Promise<FakeEngineWalk> } };
  KanteJourney: { options(): object; routed(leg: FakeEngineWalk): unknown };
  console: Console;
  Date: DateConstructor;
  Math: Math;
  JSON: JSON;
  Map: MapConstructor;
  Promise: PromiseConstructor;
}
/** What the routing script (src/app/70-routing.ts) leaves there once it has run, the first two stubbed. */
interface AppRouting {
  routeWalk(a: LngLat, b: LngLat, ends?: [WalkEnd, WalkEnd]): Promise<FakeRouted>;
  stationWalk(): Promise<FakeStationWalk>;
  refineWalks(id: number, onlyMoved?: boolean): void;
  realRouteWalk: AppRouting['routeWalk'];
}
type AppContext = AppPage & AppRouting;
/** The window the engine's journeys run in; KanteJourney is what their script leaves there. */
interface EngineWindow {
  KANTE: { available(): boolean; walk(body: KanteWalkRequest): Promise<FakeEngineWalk> } | undefined;
  SETTINGS: { prefs(): object; transportations?(): string[] };
  KanteJourney?: { requay(steps: object[], changed: () => void): void; routed(leg: FakeEngineWalk): RoutedWalk | null };
}

// the engine's journeys (requay(), routed()), with the engine stubbed: K.walk() answers when the test says
function engine() {
  const walks: Deferred<FakeEngineWalk>[] = [], bodies: KanteWalkRequest[] = [];
  const w: EngineWindow = { KANTE: { available: () => true, walk: (body) => { bodies.push(body); const d = defer<FakeEngineWalk>(); walks.push(d); return d.p; } },
    SETTINGS: { prefs: () => ({ walkKmh: 4.7, extraChangeMin: 0, maxWalkMin: 20 }), transportations: () => [] } };
  const c = { window: w, console, Date, Math, JSON, Map, Set, WeakMap, Promise };
  vm.createContext(c);
  vm.runInContext(ENGINE, c);
  return { J: w.KanteJourney!, walks, bodies };
}
// the app around the routing code: routeWalk() and stationWalk() hand back promises kept in `pending` / `station`
function app() {
  const J = engine().J;
  const c: AppPage & Partial<AppRouting> = { journeySteps: [], journeyReq: 1, routeKey: '', geoVersion: 0, sheets: 0, pending: [], station: [], plan: null,
    asked: [], answer: null, window: {}, KanteJourney: { options: () => ({ walkSpeed: 1.3 }), routed: (leg) => J.routed(leg) }, console, Date, Math, JSON, Map, Promise };
  c.window.KANTE = { walk: (body) => { c.asked.push(body); return c.answer ? c.answer() : Promise.reject(new Error('down')); } };
  Object.assign(c, {
    requestAnimationFrame: (f: () => void) => f(), updateProgress() {}, queueSheet() { c.sheets++; },
    platformOf: (s: FakeStop) => (s.quay && s.quay.label) || '–', s3Plan: () => c.plan, fmtDist: (m: number) => `${Math.round(m)} m`,
  });
  vm.createContext(c);
  vm.runInContext(ROUTING, c);
  c.realRouteWalk = c.routeWalk;
  c.routeWalk = (a, b) => { const d = defer<FakeRouted>(); c.pending.push({ a, b, d }); return d.p; };
  c.stationWalk = () => { const d = defer<FakeStationWalk>(); c.station.push(d); return d.p; };
  return c as AppContext;
}
const A: LngLat = [7.43, 46.94], B: LngLat = [7.44, 46.95], C: LngLat = [7.45, 46.96];
const net = (cs: LngLat[]) => ({ net: true, coords: cs, dist: 100 });
const stop = (platform: string): FakeStop => ({ quay: { label: platform } });
const step = (kind: KanteWalkStep['kind'], from: number, to: number, text: string = kind): KanteWalkStep => ({ kind, text, distM: 10, durS: 8, from, to });

console.log('1. a walk cancelled while its route is on the way stays cancelled');
{
  const c = app(), st = { type: 'change', lines: [[A, B]], prev: { to: stop('1') }, next: { from: stop('2') } };
  c.journeySteps.push(st);
  c.refineWalks(1);
  check(c.pending.length === 0, "the engine's walk as planned is not asked for again");
  st.lines = [[A, C]]; // requay(): a live platform change moved its end
  c.refineWalks(1, true);
  check(c.pending.length === 1, 'the moved walk is asked for again');
  st.lines = []; // requay(): both rides at the same point now
  c.refineWalks(1, true);
  c.pending[0].d.res(net([A, [7.435, 46.945], C])); await settle();
  check(st.lines.length === 0, 'the older answer does not bring the walk back');
}

console.log('2. a walk through a modelled station, moved while the model loads');
{
  const c = app(), st = { type: 'change', lines: [[A, B]], prev: { to: stop('1') }, next: { from: stop('2') } };
  c.plan = { key: 'bern' };
  c.journeySteps.push(st);
  c.refineWalks(1);
  st.lines = [[A, C]]; // a live platform change moved its end
  c.refineWalks(1, true);
  check(c.station.length === 2, 'the moved walk is routed again');
  c.station[1].res({ lines: [[A, [7.44, 46.955], C]], walks: [{}], floors: null }); await settle();
  c.station[0].res({ lines: [[A, [7.435, 46.945], B]], walks: [{}], floors: null }); await settle();
  check(st.lines[0][2] === C, 'the older answer (to the old platform) is dropped');
  c.refineWalks(1, true);
  check(c.station.length === 2, 'an unmoved walk is not routed again');
}

console.log('3. a platform change at the same point (only its name changes)');
{
  const c = app(), st: FakeStep = { type: 'walk', lines: [[A, B]], next: { from: stop('1') }, from: null };
  c.plan = { key: 'bern' };
  c.journeySteps.push(st);
  c.refineWalks(1);
  st.next!.from.quay = { label: '2' }; // Gleis 1 → Gleis 2, the same coordinates
  c.refineWalks(1, true);
  check(c.station.length === 2, 'the walk is routed again to the new platform');
  c.station[1].res({ lines: [[A, [7.44, 46.951], B]], walks: [{ to: '2' }], floors: null }); await settle();
  c.station[0].res({ lines: [[A, [7.44, 46.949], B]], walks: [{ to: '1' }], floors: null }); await settle();
  check(st.walks![0].to === '2', "the first answer (to Gleis 1) arrives late and is dropped");
  c.refineWalks(1, true);
  check(c.station.length === 2, 'and it is not routed again while nothing changes');
  st.next!.from.quay = { label: '3' }; // changed again, after its route was drawn
  c.refineWalks(1, true);
  check(c.station.length === 3, 'a routed walk is routed again when only the platform changes');
}
{
  // requay(): the engine moves the boarding edge to another platform at the very same point
  const w: EngineWindow = { KANTE: undefined, SETTINGS: { prefs: () => ({}) } };
  const c = { window: w, console, Date, Math, JSON, Map, Set, Promise };
  vm.createContext(c);
  vm.runInContext(ENGINE, c);
  const quay = (label: string) => ({ lon: B[0], lat: B[1], precision: 'edge', label, level: 0 });
  const dep = { quay: quay('1') }, arr = { quay: { lon: C[0], lat: C[1], precision: 'edge', label: '5', level: 0 } };
  const edge = (ref: string, ll: LngLat) => ({ ll, edge: { ref, bearing: null, level: 0, ll, side: '' }, travel: null });
  const walk = { type: 'walk', lines: [[A, B]] };
  const ride = { type: 'ride', s: { stops: [dep, arr], legs: [{}] }, depLL: B, arrLL: C, depAt: edge('1', B), arrAt: edge('5', C), stops: [B, C], path: [B, C] };
  const steps = [walk, ride, { type: 'arrive' }];
  let changed = 0;
  w.KanteJourney!.requay(steps, () => changed++);
  check(changed === 0, 'requay(): nothing changed, nothing to do');
  dep.quay = quay('2');
  w.KanteJourney!.requay(steps, () => changed++);
  check(changed === 1 && ride.depAt.edge.ref === '2', 'requay(): another platform at the same point counts as a change (its edge is updated)');
  check(walk.lines[0][1] === B, 'requay(): the walk itself is left as it is (routed again by refineWalks())');
}

console.log("4. the engine's walk as the page keeps it");
{
  const { J } = engine();
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
  check(J.routed({ durationS: 60, distanceM: 80, approximate: true, geometry: [A, B], levels: [null, null], steps: [] }) === null, 'no path found: none');
  const sf = J.routed({ ...leg, door: undefined, noStepFreeDoor: true })!;
  check(sf.dirs!.some((d) => d.text === 'No step-free entrance is mapped for this building') && sf.door === null, 'step-free, no step-free door: said so');
}

console.log('5. the walk to the destination is routed to the place, not to the door it found');
{
  const c = app(), st = { type: 'walk', final: true, lines: [[A, B]], toLL: B, from: { to: stop('3') } };
  c.journeySteps.push(st, { type: 'ride' });
  c.refineWalks(1);
  st.lines = [[A, [7.435, 46.945], [7.4399, 46.9499]]]; // the engine's walk, ending at the door
  c.refineWalks(1, true);
  c.pending[0].d.res(net([A, [7.435, 46.945], [7.4399, 46.9499]])); await settle();
  st.lines = [[C, st.lines[0][2]]]; // requay() moved its start
  c.refineWalks(1, true);
  check(c.pending[1].b === B, 'routed to the place again');
}

console.log('6. what routeWalk() asks the engine, and the straight line without an answer');
{
  const c = app();
  c.answer = () => Promise.resolve({ kind: 'direct', durationS: 60, distanceM: 90, approximate: false, geometry: [A, [7.435, 46.945], B], levels: [null, null, null], steps: [step('walk', 0, 2)] });
  const r = await c.realRouteWalk(A, B, [{ platform: true, level: -1, ref: '7', quay: 'ch:1:sloid:7000:4:7' }, { exact: true }]);
  const q = c.asked[0];
  check(q.from.quay === 'ch:1:sloid:7000:4:7' && q.from.lat === A[1] && q.from.lon === A[0], 'from the boarding point by its id (and its point, for an older engine)');
  check(q.to.exact === true && q.to.quay === undefined && q.to.lat === B[1], 'to the point as it is (where a station model begins)');
  check(JSON.stringify(q.options) === JSON.stringify({ walkSpeed: 1.3 }), 'with the traveller\'s options');
  check(r.coords.length === 3 && r.dist === 90 && !r.approx, "the engine's path");
  await c.realRouteWalk(A, B);
  check(c.asked[1].from.quay === undefined && c.asked[1].to.exact === undefined, 'a place: no boarding point, not exact (its door)');
  c.answer = () => Promise.resolve({ durationS: 60, approximate: true, geometry: [A, B], levels: [null, null], steps: [] });
  const none = await c.realRouteWalk(A, B);
  check(none.approx === true && none.dist === null && none.coords.length === 2, 'no path found: the straight line');
  c.answer = null; // the engine is down
  const down = await c.realRouteWalk(A, B);
  check(down.approx === true && down.coords[1] === B, 'no answer at all: the straight line');
}

console.log('7. requay(): a change left without a walk, and the engine walk answering after another way is in');
{
  const { J, walks, bodies } = engine();
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
  // moved: the station model's way is in before the engine's walk answers; the engine's time still counts
  const r3 = ride('1', '5', A, B), r4 = ride('6', '7', C, [7.47, 46.97]);
  const ch = { type: 'change', lines: [[B, C]], points: [B, C], walkMin: 5, walkS: 300, prev: r3.s, next: r4.s };
  const D: LngLat = [7.46, 46.965];
  r4.s.stops[0].quay = quay(D, '8');
  let changed = 0;
  J.requay([r3, ch, r4, { type: 'arrive' }], () => changed++);
  check(bodies.length === 1 && bodies[0].from.quay === 'q5' && bodies[0].to.quay === 'q8', `the engine is asked between the boarding points (${bodies[0] && bodies[0].from.quay} → ${bodies[0] && bodies[0].to.quay})`);
  const model: LngLat[][] = [[B, [7.455, 46.962], [7.4601, 46.9651]]]; // the model ends at another point on the right platform
  ch.lines = model;
  walks[0].res({ durationS: 90, geometry: [B, D], approximate: false, steps: [] }); await settle();
  check(ch.walkS === 90 && ch.walkMin === 2, `the engine's walk time is taken (${ch.walkS} s, ${ch.walkMin} min)`);
  check(ch.lines === model, "the station model's way stays drawn");
  // the last ride ends on another platform and no walk follows it: the arrival step ends there too
  const r5 = ride('1', '5', A, B), arrive = { type: 'arrive', from: r5.s, end: B };
  r5.s.stops[1].quay = quay(C, '6');
  J.requay([r5, arrive], () => {});
  check(arrive.end[0] === C[0] && arrive.end[1] === C[1], "requay(): the arrival step follows the last ride's new platform when no walk comes after it");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
