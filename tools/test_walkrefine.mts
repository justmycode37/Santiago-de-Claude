// Tests for how a journey's walks are routed again while it is open (src/app/70-routing.ts, requay() in
// src/engine-journey.ts): answers that arrive late, after the walk has moved, been cancelled or changed platform,
// are dropped. The sources are transpiled as they are; the routers are stubbed with promises the test settles.
// Offline; exit code 1 on any failure.
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
/** A stop of a ride: its platform (and the one forecast), or its time. */
interface FakeStop { platform?: string; station?: { id: number }; prognosis?: { platform: string }; departure?: string; arrival?: string }
/** Where a ride is boarded or left, as the engine has it (requay()). */
interface FakeQuay { lon: number; lat: number; precision: string; label: string; level: number }
interface FakePlatformAt { ll: LngLat; edge: { ref: string; bearing: null; level: number; ll: LngLat; side: string }; travel: null }
/** A step of the journey (type: 'walk', 'change', 'ride', 'arrive'). */
interface FakeStep {
  type: string;
  // a walk or change: the lines drawn, what they were routed between, the routed walks, its times
  lines?: LngLat[][];
  points?: LngLat[];
  ends?: [WalkEnd, WalkEnd][];
  walks?: { to?: string }[];
  prev?: { arrival: FakeStop };
  next?: { departure: FakeStop };
  from?: { arrival: FakeStop } | null;
  kanteWalk?: boolean;
  final?: boolean;
  toLL?: LngLat;
  t0?: number;
  t1?: number;
  min?: number;
  walkMin?: number;
  walkS?: number;
  // a ride of an engine journey
  s?: { departure: { kante: { quay: FakeQuay } }; arrival: { kante: { quay: FakeQuay } } };
  depLL?: LngLat;
  arrLL?: LngLat;
  depAt?: FakePlatformAt;
  arrAt?: FakePlatformAt;
  stops?: LngLat[];
  path?: LngLat[];
  // the arrival
  time?: string;
}
interface FakeSection { walk?: { duration: number }; journey?: object; departure?: object; arrival?: object; kante?: { durationS: number }; _netWalkS?: number }
interface FakeConn { from: { departure: string }; to: { arrival: string }; sections: FakeSection[]; _netMetres?: number }
/** What routeWalk() answers, what stationWalk() does, and the engine's walk (KANTE.walk()). */
interface FakeRouted { net?: boolean; coords?: LngLat[]; dist: number }
interface FakeStationWalk { lines: LngLat[][]; walks: { to?: string }[]; floors: KanteFloorChange[] | null }
interface FakeEngineWalk { durationS: number; geometry: LngLat[]; approximate: boolean; steps: unknown[] }
/** The page the routing script runs in: the app's state, and what the stubs count and keep. */
interface AppPage {
  journeySteps: FakeStep[];
  journeyReq: number;
  routeKey: string;
  geoVersion: number;
  journeyConn: FakeConn | null;
  journeyOptions: { list: FakeConn[]; walk: FakeConn; best: FakeConn } | null;
  journeyQuery: KanteTimeQuery;
  prefs: { walkKmh: number; maxWalkMin: number };
  tripStart: null;
  window: { WALKROUTE: object };
  sheets: number;
  timed: number;
  pending: { a: LngLat; b: LngLat; d: Deferred<FakeRouted> }[];
  station: Deferred<FakeStationWalk>[];
  plan: { key: string } | null;
  console: Console;
  Date: DateConstructor;
  Math: Math;
  JSON: JSON;
  Map: MapConstructor;
  Promise: PromiseConstructor;
}
/** What the routing script (src/app/70-routing.ts) leaves there once it has run, the first two stubbed. */
interface AppRouting {
  routeWalk(a: LngLat, b: LngLat): Promise<FakeRouted>;
  stationWalk(): Promise<FakeStationWalk>;
  refineWalks(id: number, onlyMoved?: boolean): void;
  netWalkFits(st: FakeStep, res: { dist: number }): boolean;
  retimeWalkConn(conn: FakeConn, metres: number): void;
  netWalkOption(conn: FakeConn, from: LngLat, dest: { lngLat: LngLat }): void;
  netDirections(r: Pick<WalkRouteResult, 'coords' | 'cues' | 'swisstopo'> & Partial<WalkRouteResult>): { dirs?: KanteWalkDir[]; floors: KanteFloorChange[] };
  real: Pick<AppRouting, 'netWalkFits' | 'retimeWalkConn'>;
}
type AppContext = AppPage & AppRouting;
/** The window the engine's journeys run in; KanteJourney is what their script leaves there. */
interface EngineWindow {
  KANTE: { available(): boolean; walk(): Promise<FakeEngineWalk> } | undefined;
  SETTINGS: { prefs(): object; transportations?(): string[] };
  KanteJourney?: { requay(steps: FakeStep[], changed: () => void): void };
}
/** The page the router's script runs in: the globals handed to it, and the WALKROUTE it leaves there. */
interface RouterPage { [name: string]: unknown; globalThis?: RouterPage; WALKROUTE?: WalkRouteApi }
/** A platform edge of platforms.js, as the router is asked for it. */
interface PlatformEdge { ll: LngLat; ref?: string; level: number }

// the app around the routing code: routeWalk() and stationWalk() hand back promises kept in `pending` / `station`
function app() {
  const c: AppPage & Partial<AppRouting> = { journeySteps: [], journeyReq: 1, routeKey: '', geoVersion: 0, journeyConn: null, journeyOptions: null, journeyQuery: {},
    prefs: { walkKmh: 3.6, maxWalkMin: 20 }, tripStart: null, window: { WALKROUTE: {} }, sheets: 0, timed: 0, pending: [], station: [], plan: null, console, Date, Math, JSON, Map, Promise };
  Object.assign(c, {
    requestAnimationFrame: (f: () => void) => f(), updateProgress() {}, queueSheet(t?: boolean) { c.sheets++; if (t) c.timed++; },
    platformOf: (s: FakeStop) => (s.prognosis && s.prognosis.platform) || s.platform || '–', s3Plan: () => c.plan,
    SETTINGS: { prefs: () => c.prefs }, connStart: (x: FakeConn) => Date.parse(x.from.departure), connEnd: (x: FakeConn) => Date.parse(x.to.arrival),
    fmtDist: (m: number) => `${Math.round(m)} m`, liveMs: (stop: FakeStop, which: 'arrival' | 'departure') => Date.parse(stop[which]!),
  });
  vm.createContext(c);
  vm.runInContext(ROUTING, c);
  c.routeWalk = (a, b) => { const d = defer<FakeRouted>(); c.pending.push({ a, b, d }); return d.p; };
  c.stationWalk = () => { const d = defer<FakeStationWalk>(); c.station.push(d); return d.p; };
  c.real = { netWalkFits: c.netWalkFits!, retimeWalkConn: c.retimeWalkConn! };
  c.netWalkFits = () => true;
  return c as AppContext;
}
// the engine's journeys (requay()), with the engine's walking router stubbed: K.walk() answers when the test says
function engine() {
  const walks: Deferred<FakeEngineWalk>[] = [];
  const w: EngineWindow = { KANTE: { available: () => true, walk: () => { const d = defer<FakeEngineWalk>(); walks.push(d); return d.p; } },
    SETTINGS: { prefs: () => ({ walkKmh: 4.7, extraChangeMin: 0, maxWalkMin: 20 }), transportations: () => [] } };
  const c = { window: w, console, Date, Math, JSON, Map, Set, WeakMap, Promise };
  vm.createContext(c);
  vm.runInContext(ENGINE, c);
  return { J: w.KanteJourney!, walks };
}
const A: LngLat = [7.43, 46.94], B: LngLat = [7.44, 46.95], C: LngLat = [7.45, 46.96];
const net = (cs: LngLat[]) => ({ net: true, coords: cs, dist: 100 });
const stop = (platform: string): FakeStop => ({ platform, station: { id: 8507000 } });

console.log('1. a walk cancelled while its route is on the way stays cancelled');
{
  const c = app(), st = { type: 'change', lines: [[A, B]], prev: { arrival: stop('1') }, next: { departure: stop('2') } };
  c.journeySteps.push(st);
  c.refineWalks(1);
  st.lines = []; // requay(): both rides at the same point now
  c.refineWalks(1, true);
  c.pending[0].d.res(net([A, [7.435, 46.945], B])); await settle();
  check(st.lines.length === 0, 'the older answer does not bring the walk back');
}

console.log('2. a walk through a modelled station, moved while the model loads');
{
  const c = app(), st = { type: 'change', lines: [[A, B]], prev: { arrival: stop('1') }, next: { departure: stop('2') } };
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
  const c = app(), st: FakeStep = { type: 'walk', lines: [[A, B]], next: { departure: stop('1') }, from: null };
  c.plan = { key: 'bern' };
  c.journeySteps.push(st);
  c.refineWalks(1);
  st.next!.departure.prognosis = { platform: '2' }; // Gleis 1 → Gleis 2, the same coordinates
  c.refineWalks(1, true);
  check(c.station.length === 2, 'the walk is routed again to the new platform');
  c.station[1].res({ lines: [[A, [7.44, 46.951], B]], walks: [{ to: '2' }], floors: null }); await settle();
  c.station[0].res({ lines: [[A, [7.44, 46.949], B]], walks: [{ to: '1' }], floors: null }); await settle();
  check(st.walks![0].to === '2', "the first answer (to Gleis 1) arrives late and is dropped");
  c.refineWalks(1, true);
  check(c.station.length === 2, 'and it is not routed again while nothing changes');
  st.next!.departure.prognosis = { platform: '3' }; // changed again, after its route was drawn
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
  const dep = { kante: { quay: quay('1') } }, arr = { kante: { quay: { lon: C[0], lat: C[1], precision: 'edge', label: '5', level: 0 } } };
  const edge = (ref: string, ll: LngLat) => ({ ll, edge: { ref, bearing: null, level: 0, ll, side: '' }, travel: null });
  const walk = { type: 'walk', lines: [[A, B]] };
  const ride = { type: 'ride', s: { departure: dep, arrival: arr }, depLL: B, arrLL: C, depAt: edge('1', B), arrAt: edge('5', C), stops: [B, C], path: [B, C] };
  const steps = [walk, ride, { type: 'arrive' }];
  let changed = 0;
  w.KanteJourney!.requay(steps, () => changed++);
  check(changed === 0, 'requay(): nothing changed, nothing to do');
  dep.kante.quay = quay('2');
  w.KanteJourney!.requay(steps, () => changed++);
  check(changed === 1 && ride.depAt.edge.ref === '2', 'requay(): another platform at the same point counts as a change (its edge is updated)');
  check(walk.lines[0][1] === B, 'requay(): the walk itself is left as it is (routed again by refineWalks())');
}

console.log('4. the engine answers after the network: the network route comes back');
{
  const c = app(), st = { type: 'walk', lines: [[A, B]], kanteWalk: false, next: { departure: stop('1') } };
  c.journeySteps.push(st, { type: 'ride' });
  c.refineWalks(1, true);
  c.pending[0].d.res(net([A, [7.435, 46.945], B])); await settle();
  Object.assign(st, { lines: [[A, [7.431, 46.941], B]], kanteWalk: true }); // setWalk() from the engine, same ends
  c.refineWalks(1, true);
  check(c.pending.length === 2, "the engine's path is routed on the network again");
  c.pending[1].d.res(net([A, [7.435, 46.945], B])); await settle();
  check(st.lines[0][1][0] === 7.435, 'and the network route is drawn');
}

console.log('5. the walk to the destination is routed to the place, not to the door it found');
{
  const c = app(), st = { type: 'walk', final: true, lines: [[A, B]], toLL: B, from: { arrival: stop('3') } };
  c.journeySteps.push(st, { type: 'ride' });
  c.refineWalks(1);
  c.pending[0].d.res(net([A, [7.435, 46.945], [7.4399, 46.9499]])); await settle(); // ends at the door
  st.lines = [[C, st.lines[0][2]]]; // requay() moved its start
  c.refineWalks(1, true);
  check(c.pending[1].b === B, 'routed to the place again');
}

console.log('6. walking all the way, opened again: the network times though the distance is known');
{
  const c = app();
  const conn = { from: { departure: '2026-11-21T12:00:00Z' }, to: { arrival: '2026-11-21T12:10:00Z' },
    sections: [{ walk: { duration: 600 }, departure: {}, arrival: {}, kante: { durationS: 900 } }] };
  c.journeyConn = conn;
  c.retimeWalkConn(conn, 600); // 600 m at 3.6 km/h: 10 min
  check(conn.sections[0].kante.durationS === 600, "the engine's walk time follows (decorate() reads it)");
  const t0 = Date.parse('2026-11-21T12:00:00Z'), walk = { type: 'walk', t0, t1: t0 + 900000 }; // decorate(): the engine's 15 min
  c.journeySteps = [walk, { type: 'arrive', time: '2026-11-21T12:15:00Z' }];
  c.timed = 0;
  c.retimeWalkConn(conn, 600);
  check(walk.t1 === t0 + 600000, "the walk ends at 12:10, not the engine's 12:15");
  check(c.timed === 1, 'and the pill, the bar and the footer are drawn again');
}

console.log('7. requay(): a change left without a walk, and the engine walk answering after another way is in');
{
  const { J, walks } = engine();
  const quay = (ll: LngLat, label: string) => ({ lon: ll[0], lat: ll[1], precision: 'edge', label, level: 0 });
  const edge = (ref: string, ll: LngLat) => ({ ll, edge: { ref, bearing: null, level: 0, ll, side: '' }, travel: null });
  const ride = (dep: string, arr: string, d: LngLat, a: LngLat) => ({ type: 'ride', s: { departure: { kante: { quay: quay(d, dep) } }, arrival: { kante: { quay: quay(a, arr) } } },
    depLL: d, arrLL: a, depAt: edge(dep, d), arrAt: edge(arr, a), stops: [d, a], path: [d, a] });
  // both rides now at the same point: the change has no walk left, and no walk time either
  const r1 = ride('1', '5', A, B), r2 = ride('6', '7', C, [7.47, 46.97]);
  const change = { type: 'change', lines: [[B, C]], points: [B, C], walkMin: 5, walkS: 300 };
  r2.s.departure.kante.quay = quay(B, '6');
  J.requay([r1, change, r2, { type: 'arrive' }], () => {});
  check(change.lines.length === 0 && change.walkMin === 0 && change.walkS === 0, 'a change without a walk has no walk time (its spare time is the whole wait)');
  // moved: the station model's way is in before the engine's walk answers; the engine's time still counts
  const r3 = ride('1', '5', A, B), r4 = ride('6', '7', C, [7.47, 46.97]);
  const ch = { type: 'change', lines: [[B, C]], points: [B, C], walkMin: 5, walkS: 300 };
  const D: LngLat = [7.46, 46.965];
  r4.s.departure.kante.quay = quay(D, '8');
  let changed = 0;
  J.requay([r3, ch, r4, { type: 'arrive' }], () => changed++);
  const model: LngLat[][] = [[B, [7.455, 46.962], [7.4601, 46.9651]]]; // the model ends at another point on the right platform
  ch.lines = model;
  walks[0].res({ durationS: 90, geometry: [B, D], approximate: false, steps: [] }); await settle();
  check(ch.walkS === 90 && ch.walkMin === 2, `the engine's walk time is taken (${ch.walkS} s, ${ch.walkMin} min)`);
  check(ch.lines === model, "the station model's way stays drawn");
}

console.log("8. the floor a lift starts on, from the router (step-free from platform 13 at Bern)");
{
  const ctx: RouterPage = { console, setTimeout, Promise, Math, JSON, Map, Set, Array, Object, Number, String, Infinity, isFinite };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(transformSync(fs.readFileSync(path.join(ROOT, 'src', 'walkroute.ts'), 'utf8'), { mode: 'strip-only' }).code, ctx); // the script as the browser gets it: types taken out
  ctx.WALKROUTE!.configure({ loader: async (k: string) => {
    const s = fs.readFileSync(path.join(ROOT, 'walkgraph', k === 'index' ? 'index.js' : `t/${k}.js`), 'utf8');
    return k === 'index' ? JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)) : JSON.parse(s.slice(s.indexOf(',') + 1, s.lastIndexOf(')')));
  } });
  const pd = fs.readFileSync(path.join(ROOT, 'platforms.js'), 'utf8');
  const edges: PlatformEdge[] = JSON.parse(pd.slice(pd.indexOf('{'), pd.lastIndexOf('}') + 1)).stops['8507000'][2].map((e: PlatformDataEdge) => ({ ll: [e[0] / 1e5, e[1] / 1e5], ref: e[2], level: e[4] || 0 }));
  // the platform's edges (sectors) in turn, to a route that takes the lift down first
  let r: WalkRouteResult | null = null;
  for (const a of edges.filter((e) => e.ref === '13')) for (const b of edges.filter((e) => e.ref === '1')) {
    const x: WalkRouteResult | null = r ? null : await ctx.WALKROUTE!.route(a.ll, b.ll, { stepFree: true, from: { platform: true, level: a.level, ref: '13' }, to: { platform: true, level: b.level, ref: '1' } });
    if (x && x.cues.some((q) => /^Lift to level −1/.test(q.text))) r = x;
  }
  const c = app();
  const { dirs = [] } = r ? c.netDirections(r) : {};
  const lift = dirs.find((d) => /^Lift to level −1/.test(d.text));
  check(!!lift && lift.kind === 'stairs-down' && lift.from! > lift.to!, `"Lift to level −1" is drawn going down (${lift && `${lift.kind}, ${lift.from} → ${lift.to}`})`);
  const vertical = dirs.filter((d) => d.from != null);
  check(vertical.length > 0 && vertical.every((d) => (d.kind === 'stairs-down') === (d.to! < d.from!)), `every floor change points the way it goes (${vertical.map((d) => `${d.from}→${d.to}`).join(', ')})`);
  const noFrom = c.netDirections({ coords: [A, B], cues: [{ at: A, kind: 'lift', text: 'Lift to level −1', m: 20 }], swisstopo: 0 });
  check(noFrom.dirs!.some((d) => d.kind === 'stairs-down' && d.from === 0), 'a lift down whose start floor is not known: down from street level');
}

console.log('9. On foot: its network time kept while those options are on show; your longest walk in the ranking');
{
  const c = app();
  const walk: FakeConn = { from: { departure: '2026-11-21T12:00:00Z' }, to: { arrival: '2026-11-21T12:10:00Z' }, sections: [{ walk: { duration: 600 }, departure: {}, arrival: {} }] };
  const pt = { from: { departure: '2026-11-21T12:00:00Z' }, to: { arrival: '2026-11-21T12:40:00Z' }, sections: [{ journey: {} }] };
  c.journeyOptions = { list: [pt], walk, best: pt };
  c.netWalkOption(walk, A, { lngLat: B });
  c.journeyReq = 2; // another option opened meanwhile
  c.pending[0].d.res({ net: true, coords: [A, B], dist: 1800 }); await settle(); // 30 min at 3.6 km/h
  check(walk._netMetres === 1800, 'the walk is retimed though another option has been opened since');
  check(c.journeyOptions.best === pt, 'a 30-minute walk is not shown first when your longest walk is 20 minutes');
  c.prefs.maxWalkMin = 60;
  c.retimeWalkConn(walk, 1801);
  check(c.journeyOptions.best === walk, 'with 60 minutes allowed, the walk (no slower) is');
  c.journeyOptions = null;
  c.netWalkOption(walk, A, { lngLat: B });
  c.pending[1].d.res({ net: true, coords: [A, B], dist: 900 }); await settle();
  check(walk._netMetres === 1801, 'options no longer on show: nothing is retimed');
}

console.log('10. times that follow the walk drawn');
{
  const c = app();
  c.netWalkFits = c.real.netWalkFits;
  // the first walk, longer on the network: the option row's walk minutes too
  const conn: FakeConn = { from: { departure: '2026-11-21T12:00:00Z' }, to: { arrival: '2026-11-21T12:30:00Z' },
    sections: [{ walk: { duration: 300 } }, { journey: {} }] };
  c.journeyConn = conn;
  const t1 = Date.parse('2026-11-21T12:05:00Z');
  const first = { type: 'walk', t0: t1 - 300000, t1, min: 5, walkS: 300 };
  c.journeySteps = [first, { type: 'ride' }];
  c.netWalkFits(first, { dist: 420 }); // 7 min at 3.6 km/h
  check(conn.from.departure === '2026-11-21T11:58:00.000Z' && conn.sections[0]._netWalkS === 420, 'leave 2 minutes earlier; the row lists a 7-minute walk');
  // a change: its end moves with its walk
  const change = { type: 'change', t0: t1, t1: t1 + 300000, walkMin: 5, walkS: 300,
    prev: { arrival: { arrival: '2026-11-21T12:05:00Z' } }, next: { departure: { departure: '2026-11-21T12:15:00Z' } } };
  c.journeySteps = [{ type: 'ride' }, change, { type: 'ride' }];
  c.netWalkFits(change, { dist: 180 }); // 3 min
  check(change.t1 === t1 + 180000 && change.walkMin === 3, "a change's walk ends when the network walk does");
  // walking all the way in two stretches: timed once, by both
  const c2 = app(), seen: number[] = [];
  c2.retimeWalkConn = (_, m) => seen.push(m);
  const st: FakeStep = { type: 'walk', lines: [[A, B], [B, C]], ends: [[{}, {}], [{}, {}]] };
  c2.journeySteps.push(st, { type: 'arrive' });
  c2.refineWalks(1);
  c2.pending[0].d.res(net([A, B])); await settle();
  c2.pending[1].d.res({ ...net([B, C]), dist: 250 }); await settle();
  check(seen.length === 1 && seen[0] === 350, `retimed once, by the whole walk (${seen.join(', ')} m)`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
