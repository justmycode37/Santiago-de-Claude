// Tests for the engine's guessed walk ends (approxStart / approxEnd on a walking leg, kante/engine json.rs): the same
// legs without them and with them, through the page's own code (KanteJourney.setWalk() and routed() in
// src/engine-journey.ts, stepFeatures() in src/app/journey-steps.ts, snapToTrip(), trackJourney() and placeUserDot()
// in src/app/tracking.ts, refineWalks() in src/app/routing.ts, which asks the engine's /api/walk again). Without them
// everything must come out as the page made it before it said and tracked guesses (test_walkguess_plain.json: this
// test run with GOLDEN=1 at ade69857, the engine as the one walking router before #73 was merged in, with only
// snapToTrip() exported); with them the guessed stretches are drawn dashed, said as a guess, left out of how far GPS
// moves you along the walk, and the blue dot is not put on them. The modules are imported as they are, with the
// parts of the page they import stubbed. Offline; exit code 1 on any failure.
//
//   node --experimental-test-module-mocks tools/test_walkguess.mts          (GOLDEN=1: print the outputs to record)
import fs from 'node:fs';
import { mock } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

let passed = 0, failed = 0;
const check = (ok: boolean, what: string) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };
const settle = () => new Promise((r) => setTimeout(r, 0));
const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);
const distKmFlat = (a: LngLat, b: LngLat) => Math.hypot((a[0] - b[0]) * 111.195 * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * 111.195);

// ---- places: GPS puts you at P (a mocked module's values are fixed, so the walks below are laid out around it) ----
const P: LngLat = [7.4405, 46.9485];
/** A point e metres east and n metres north of b. */
const off = (b: LngLat, e: number, n: number): LngLat => [b[0] + e / (111195 * Math.cos(b[1] * Math.PI / 180)), b[1] + n / 111195];

// ---- the page around the modules tested, stubbed (as in test_walkrefine.mts) ----
const APP = new URL('../src/app/', import.meta.url);
const [major, minor] = process.versions.node.split('.').map(Number);
const hasExports = major > 25 || (major === 25 && minor >= 9) || (major === 24 && minor >= 15);
const fake = (file: string, exports: Record<string, unknown>) => mock.module(new URL(file, APP).href,
  (hasExports ? { exports } : { namedExports: exports }) as Parameters<typeof mock.module>[1]);
const nothing = () => {};
const marker = { remove: nothing, setLngLat: nothing };
/** The destination pin: on the map (`_map`) where a test puts it (`at`). */
const dest = { _map: null as object | null, at: P, getLngLat: () => ({ toArray: () => dest.at }), remove: nothing };
/** What the stubs count and answer: the walks asked of the engine's /api/walk and its answer, the station model, where
 *  the blue dot was put. */
const page = { asked: 0, answer: null as KanteWalk | null, plan: null as { key: string } | null, dot: null as LngLat | null };
fake('map.ts', { map: { flyTo: nothing } });
fake('map-events.ts', { updateCards: nothing });
fake('location.ts', { fixAge: () => 0, gpsOn: () => true, userAccuracy: 10, userLngLat: P, userMarker: { setLngLat: (ll: LngLat) => { page.dot = ll; } } });
fake('search.ts', { destMarker: dest, startMarker: marker });
fake('search-pins.ts', { clearPlacePins: nothing, render: nothing });
fake('trip-ends.ts', { blurSearch: nothing, setField: nothing, setFollowing: nothing, setPlanOpen: nothing });
fake('pins.ts', { armPin: nothing, pinMenu: marker });
fake('map-places.ts', { updatePlaces: nothing });
fake('journey-map.ts', { jBody: null, jFoot: null, jHead: null, setRoute: nothing });
fake('platforms.ts', { platformKey: () => '' });
fake('sprites.ts', { INK: '#000' });
fake('live-engine.ts', { rideTrip: () => null });
fake('sheet.ts', { MODE_NAME: {} });
fake('live-vehicles.ts', { fmtDist: (m: number) => `${Math.round(m)} m`, levelShort: String, platformOf: () => '–', platformWord: () => 'Platform',
  splitPlatform: () => ({}), vehUpdate: nothing });
fake('sheet-content.ts', { connStart: (c: { t0: number }) => c.t0, connEnd: (c: { t1: number }) => c.t1, queueSheet: nothing, s3Plan: () => page.plan, s3Prefs: () => ({}) });
fake('pill.ts', { goToStep: nothing, updateProgress: nothing, updatePillTimes: nothing });
fake('time-picker.ts', { closeTimeSheet: nothing, updateWhenChip: nothing });
fake('../toast.ts', { showToast: nothing });
fake('../live.ts', { KANTE_LIVE: {} });
const prefs = { walkKmh: 4.68, stepFree: false, fewerStairs: false, noEscalators: false, wheelchair: false, extraChangeMin: 0, maxWalkMin: 20 };
fake('../settings.ts', { SETTINGS: { prefs: () => prefs, transportations: () => [], journey: () => ({}) } });
// the engine's /api/walk answers page.answer, or never
fake('../engine.ts', { KANTE: { available: () => true, uicOf: () => null, failure: () => 'down',
  walk: () => { page.asked++; return page.answer ? Promise.resolve(page.answer) : new Promise(nothing); } } });
// a station model without a way through (its router finds none)
fake('../station3d.ts', { Station3D: { loadData: () => Promise.resolve({}), preload: nothing }, stationRouter: () => ({ route: () => null, toLngLat: nothing }) });
const element = () => ({ className: '', title: '', setAttribute: nothing, addEventListener: nothing, appendChild: nothing });
Object.assign(globalThis, { requestAnimationFrame: (f: () => void) => f(), document: { createElement: element },
  maplibregl: { Marker: class { setLngLat() { return this; } } } });

// ---- the modules tested, as far as these tests call them ----
interface Dir { kind: string; text: string; coords: LngLat[] }
/** A walk step as the code reads and writes it. */
interface Step {
  type: 'walk';
  final: boolean;
  lines: LngLat[][];
  walks?: { coords: LngLat[]; dirs?: Dir[]; approxTo?: number | null; approxFrom?: number | null; approx?: boolean; net?: boolean }[];
  kanteWalk?: boolean;
  t0: number | null;
  t1: number | null;
  min: number;
  walkS?: number;
  from: null;
}
interface Feature { geometry: { type: string; coordinates: LngLat[] | LngLat }; properties: { kind: string; approx?: boolean } }
interface Track { i: number; kmIn: number; km: number; d: number; off: boolean; arrived?: boolean }
interface Conn { t0: number; t1: number; parts: { type: string; durationS: number; dep: number; arr: number }[]; walkM: number }
const load = (file: string) => import(new URL(file, APP).href);
type Walk = NonNullable<Step['walks']>[number];
const J: { setWalk(st: Step, leg: KanteWalk): void; routed(leg: KanteWalk): Walk | null } = (await load('../engine-journey.ts')).KanteJourney;
const steps: { stepFeatures(steps: Step[]): Feature[] } = await load('journey-steps.ts');
const tracking: { snapToTrip(p: LngLat, ref: number, now: number): Track | null; trackJourney(): void } = await load('tracking.ts');
const routing: { refineWalks(id: number): void } = await load('routing.ts');
const S: {
  journey: { steps: Step[]; req: number; conn: Conn | null; options: null; query: object };
  tracking: { geoVersion: number; track: Track | null; autoStep: number; userPickedAt: number };
  searchState: { tripStart: null };
} = await load('state.ts');

// ---- the legs ----
/** An engine's walk along `g`, with its directions: one step over all of it (or `dirs`), then the arrival. */
const leg = (g: LngLat[], extra?: Partial<KanteWalk>, dirs?: KanteWalkStep[]): KanteWalk => ({
  kind: 'egress', from: { name: 'Bern, Zytglogge', lat: g[0][1], lon: g[0][0] }, to: { name: 'Kornhausplatz', lat: g[g.length - 1][1], lon: g[g.length - 1][0] },
  dep: 1795000000, arr: 1795000300, durationS: 300, distanceM: 230, stairsUp: 0, stairsDown: 0, lifts: 0, escalators: 0, stepFree: true,
  geometry: g.map((c): LngLat => [c[0], c[1]]), levels: g.map(() => 0),
  steps: [...(dirs || [{ kind: 'depart', text: 'Head east', distM: 100, durS: 80, from: 0, to: g.length - 1 }]),
    { kind: 'arrive', text: 'Arrive at Kornhausplatz', distM: 0, durS: 0, from: g.length - 1, to: g.length - 1 }],
  ...extra,
});
// out of a building through no known door (0 → 1), along the paths (1 … 4), across a square (4 → 5); the engine's
// first direction is of the paths ("Head north": its heading is the path's), from point 0 as the engine counts it
const G: LngLat[] = [[7.4390, 46.9480], [7.4394, 46.9481], [7.4400, 46.9483], [7.4407, 46.9483], [7.4412, 46.9486], [7.4417, 46.9490]];
const legG = (extra?: Partial<KanteWalk>) => leg(G, extra, [{ kind: 'depart', text: 'Head north, then 60 m along Kramgasse', distM: 60, durS: 50, from: 0, to: 2 },
  { kind: 'walk', text: 'Turn left onto Kornhausplatz, then 110 m', distM: 110, durS: 90, from: 2, to: 5 }]);
/** A fresh page with one walk step for the engine's walk `l` (timed from `t0` for `secs`, when given). */
function walkOf(l: KanteWalk, t0?: number, secs = 300): Step {
  const st: Step = { type: 'walk', final: true, lines: [[l.geometry[0], l.geometry[l.geometry.length - 1]]], t0: t0 ?? null, t1: t0 != null ? t0 + secs * 1000 : null, min: 5, from: null };
  J.setWalk(st, l);
  // walking all the way: the trip is this walk
  const conn = st.t0 != null ? { t0: st.t0, t1: st.t1!, parts: [{ type: 'walk', durationS: secs, dep: st.t0 / 1000, arr: st.t1! / 1000 }], walkM: l.distanceM } : null;
  Object.assign(S.journey, { steps: [st], req: 1, conn, options: null, query: {} });
  Object.assign(S.tracking, { track: null, autoStep: -1, userPickedAt: 0 });
  S.tracking.geoVersion++;
  S.searchState.tripStart = null;
  Object.assign(page, { asked: 0, answer: null, plan: null, dot: null });
  dest._map = null;
  return st;
}
const texts = (w: { dirs?: Dir[] } | null) => ((w && w.dirs) || []).map((d) => d.text);
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const snap = (p: LngLat, ref = 0) => { const s = tracking.snapToTrip(p, ref, Date.now())!; return { i: s.i, kmIn: r6(s.kmIn), d: r6(s.d) }; };
const tracked = () => { const t = S.tracking.track; return t && { i: t.i, kmIn: r6(t.kmIn), d: r6(t.d), off: t.off, arrived: !!t.arrived }; };
const walkOut = (st: Step) => ({ lines: st.lines, walk: (st.walks && st.walks[0]) || null, kanteWalk: !!st.kanteWalk });

// ---- the scenarios: each gives what the page made of the walk, as JSON; `x` adds the engine's fields ----
const NOW = Date.now();
const scenarios = {
  /** The leg drawn, written out, snapped (from the start of the trip), and in a modelled station without a way through. */
  async basic(x?: Partial<KanteWalk>) {
    const st = walkOf(legG(x));
    const features = steps.stepFeatures([st]);
    const snaps = [[7.4392, 46.94804], [7.4403, 46.94832], [7.4414, 46.94872], G[4]].map((p) => snap(p as LngLat));
    page.plan = { key: 'bern' };
    routing.refineWalks(1);
    await settle(); await settle();
    return { ...walkOut(st), features, snaps, asked: page.asked };
  },
  /** Walking all the way, in 10 minutes; the walk routed again (as after a live platform change): the engine answers
   *  it anew, in 240 s; a fix beside the guessed start. */
  async rerouted(x?: Partial<KanteWalk>) {
    const st = walkOf(legG(), NOW + 600000, 300);
    routing.refineWalks(1); // as planned: kept
    await settle();
    page.answer = legG({ durationS: 240, ...x });
    routing.refineWalks(1);
    await settle(); await settle();
    return { ...walkOut(st), walkS: st.walkS, min: st.min, features: steps.stepFeatures([st]), snap: snap([7.4392, 46.94804]), asked: page.asked };
  },
  /** 200 m out of a building eastwards, then 200 m north on paths; halfway by the timetable; two fixes 110 m along
   *  the first stretch. */
  offRoute(x?: Partial<KanteWalk>) {
    const a = off(P, -110, 0), b = off(a, 200, 0), c = off(b, 0, 200);
    walkOf(leg([a, b, c], x), NOW - 150000, 300);
    tracking.trackJourney();
    const first = tracked();
    tracking.trackJourney();
    return { first, second: tracked(), dot: page.dot };
  },
  /** 110 m to a mapped door, the last 40 m to it straight; the destination pin 76 m inside; a fix at the door, and
   *  one 30 m before it. */
  door(x?: Partial<KanteWalk>) {
    walkOf(leg([off(P, -110, 0), off(P, -40, 0), P], x), NOW - 60000, 120);
    dest._map = {};
    dest.at = off(P, 0, 76);
    const before = snap(off(P, -30, 0), 0.07);
    tracking.trackJourney();
    return { before, atDoor: tracked() };
  },
  /** Three points, guessed from both ends up to the middle one; a fix past the middle, 60 m from the end. */
  meet(x?: Partial<KanteWalk>) {
    const g = [P, off(P, 100, 0), off(P, 200, 0)];
    const st = walkOf(leg(g, x));
    return { ...walkOut(st), features: steps.stepFeatures([st]), snap: snap(off(P, 140, 0)) };
  },
  /** A point repeated where the guesses end and begin. */
  repeated(x?: Partial<KanteWalk>) {
    const g = [P, off(P, 50, 0), off(P, 50, 0), off(P, 100, 0)];
    const st = walkOf(leg(g, x));
    return { ...walkOut(st), features: steps.stepFeatures([st]) };
  },
  /** Two points, guessed through the last; a fix past its end 60 m to the side, and one beside its end. */
  two(x?: Partial<KanteWalk>) {
    const g = [P, off(P, 100, 0)];
    walkOf(leg(g, x));
    return { aside: snap(off(P, 110, 60)), atEnd: snap(off(P, 100, 10)) };
  },
  /** A walk in two parts (as on either side of a station model), 100 m east, then 200 m on; the second one's fields
   *  `x`; a fix 50 m into the second part. */
  parts(x?: Partial<KanteWalk>) {
    const a = off(P, -150, 0), b = off(P, -50, 0), c = [b, off(P, 50, 0), off(P, 150, 0)];
    const st = walkOf(leg([a, b]));
    const w = [J.routed(leg([a, b]))!, J.routed(leg(c, x))!];
    Object.assign(st, { lines: w.map((r) => r.coords), walks: w });
    S.tracking.geoVersion++;
    return { features: steps.stepFeatures([st]), texts: w.map(texts), snap: snap(P) };
  },
};
type Name = keyof typeof scenarios;
const NO: Record<Name, Partial<KanteWalk>> = { basic: {}, rerouted: {}, offRoute: {}, door: {}, meet: {}, repeated: {}, two: {}, parts: {} };
async function all(fields: Record<Name, Partial<KanteWalk>>) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(scenarios) as Name[]) out[k] = await scenarios[k](fields[k]);
  return JSON.parse(JSON.stringify(out)) as Record<Name, any>;
}
if (process.env.GOLDEN) {
  console.log(`{\n${Object.entries(await all(NO)).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}`);
  process.exit(0);
}
const BEFORE = JSON.parse(fs.readFileSync(new URL('test_walkguess_plain.json', import.meta.url), 'utf8'));
// the walk's lines as drawn: dashed (properties.approx: the map's route-walk-approx layer) or solid, and how many points each
const walkLines = (list: Feature[]) => list.filter((f) => f.properties.kind === 'walk').map((f) => [f.properties.approx ? 'dashed' : 'solid', f.geometry.coordinates.length]);
const GUESS = /^(Walk|Then) about \d+ m where no way is mapped$/;

console.log("1. without approxStart / approxEnd (today's engine): exactly as before");
const plain = await all(NO);
for (const k of Object.keys(scenarios) as Name[]) check(same(plain[k], BEFORE[k]), `${k}: as before`);
check(same(walkLines(plain.basic.features), [['solid', 6]]) && plain.basic.kanteWalk && plain.basic.asked === 0, "basic: drawn solid, the engine's path kept in a station without a way through");
check(!plain.offRoute.second.off && plain.offRoute.second.d === 0 && plain.door.atDoor.arrived, 'on the line and at the door: on the route, arrived');

console.log('2. with them: dashed, said as a guess, not tracked along');
{
  const o = await scenarios.basic({ approxStart: 1, approxEnd: 4 }) as any;
  const p = plain.basic;
  check(same(walkLines(o.features), [['dashed', 2], ['solid', 4], ['dashed', 2]]), 'drawn: points 0…1 dashed, 1…4 solid, 4…5 dashed');
  check(same(o.features.filter((f: Feature) => f.properties.approx).map((f: Feature) => f.geometry.coordinates), [G.slice(0, 2), G.slice(4)]), 'the dashed lines are exactly the guessed points');
  const t = texts(o.walk);
  check(t.length === 4 && GUESS.test(t[0]) && GUESS.test(t[3]) && same(t.slice(1, 3), texts(p.walk)), `said as a guess: "${t[0]}" … "${t[3]}", the engine's directions between them`);
  const d = o.walk.dirs as Dir[];
  check(same(d[0].coords, G.slice(0, 2)) && same(d[3].coords, G.slice(4)), 'each guess over its own points');
  check(same(d[1].coords[0], G[1]) && same(d[2].coords[d[2].coords.length - 1], G[4]) && d[1].text === 'Head north, then 60 m along Kramgasse',
    "the engine's directions are of the routed part (\"Head north\" begins where the paths do, and is focused there)");
  check(o.snaps[0].kmIn === 0 && o.snaps[0].d === p.snaps[0].d && p.snaps[0].kmIn > 0, 'GPS beside the guessed start: as far from the line, not moved along it');
  check(same(o.snaps[1], p.snaps[1]) && same(o.snaps[3], p.snaps[3]), 'on the routed part and where it ends: as before');
  check(o.snaps[2].d === p.snaps[2].d && o.snaps[2].kmIn === o.snaps[3].kmIn && o.snaps[2].kmIn < p.snaps[2].kmIn, 'beside the guessed end: no further along than where the paths end');
  check(o.kanteWalk && o.asked === 0, "the engine's path drawn; in a station without a way through, kept (the engine not asked again)");
  check(o.walk.net === true && o.walk.approxTo === 1 && o.walk.approxFrom === 4 && !o.walk.approx, 'kept as the walk\'s approxTo / approxFrom');
}

console.log('3. routed again by the engine: its answer\'s guesses are guesses too');
{
  const p = plain.rerouted;
  check(p.asked === 1 && p.walkS === 240 && same(walkLines(p.features), [['solid', 6]]), "(without the fields: the engine asked again, its answer drawn solid, its time taken)");
  const o = await scenarios.rerouted({ approxStart: 1, approxEnd: 4 }) as any;
  check(o.asked === 1 && o.walkS === 240 && o.min === p.min && o.kanteWalk, `with them: the answer taken, with its time (${o.walkS} s, ${o.min} min)`);
  check(same(walkLines(o.features), [['dashed', 2], ['solid', 4], ['dashed', 2]]), 'drawn dashed at both ends');
  const t = texts(o.walk);
  check(t.length === 4 && GUESS.test(t[0]) && GUESS.test(t[3]), `said as a guess ("${t[0]}")`);
  check(o.snap.kmIn === 0 && o.snap.d === p.snap.d && p.snap.kmIn > 0, 'a fix beside its guessed start: not moved along it');
}

console.log('4. on the dashed start: not "off the route", and the blue dot where GPS puts you');
{
  const o = scenarios.offRoute({ approxStart: 1 });
  check(!o.second!.off && o.second!.d === 0 && o.first!.d === 0, `two fixes on the guessed start: 0 m from the line, on the route (${o.second!.d} m, off: ${o.second!.off})`);
  check(o.second!.kmIn === 0 && o.first!.kmIn === 0, 'and not moved along it');
  check(same(o.dot, P), `the blue dot at the fix, not pulled to where the walk begins (${JSON.stringify(o.dot)})`);
  const q = plain.offRoute.dot as LngLat;
  check(!!q && distKmFlat(q, P) < 0.001 && plain.offRoute.second.kmIn > 0.1, '(without the fields: the dot on the line, at the fix, 110 m along)');
}

console.log('5. at the door at the end of a guessed tail, arrived');
{
  const o = scenarios.door({ approxEnd: 1 });
  check(o.atDoor!.arrived, `a fix at the door: arrived (${JSON.stringify(o.atDoor)})`);
  check(Math.abs(o.before.kmIn - 0.07) < 0.001 && o.before.kmIn < plain.door.before.kmIn && o.before.d === plain.door.before.d, `30 m before it: where the paths end (${o.before.kmIn} km)`);
}

console.log('6. guesses that meet, a repeated point, a two-point guess');
{
  const m = scenarios.meet({ approxStart: 1, approxEnd: 1 }) as any;
  check(same(walkLines(m.features), [['dashed', 3]]) && m.walk.approx, 'guesses that meet: one dashed line, all of it a guess');
  check(texts(m.walk).length === 1 && GUESS.test(texts(m.walk)[0]), `said once ("${texts(m.walk)[0]}"), nothing else`);
  check(m.snap.kmIn === 0 && m.snap.d === plain.meet.snap.d, 'a fix past the middle: not moved along it');
  const r = scenarios.repeated({ approxStart: 1, approxEnd: 2 }) as any;
  check(same(walkLines(r.features), [['dashed', 4]]), 'a repeated point between the guesses: no solid line of no length');
  const t = scenarios.two({ approxStart: 1 });
  check(t.aside.kmIn === 0 && t.aside.d === plain.two.aside.d, `two points guessed through the last, a fix past its end to the side: not moved along it (${t.aside.kmIn} km)`);
  check(same(t.atEnd, plain.two.atEnd), 'beside its end: at the end, as without the fields');
}

console.log('7. a walk in parts: a guess on the second one');
{
  const o = scenarios.parts({ approxStart: 1 }) as any;
  check(same(walkLines(o.features), [['solid', 2], ['dashed', 2], ['solid', 2]]), 'the first part solid, the second one\'s guessed start dashed');
  check(GUESS.test(o.texts[1][0]) && !o.texts[0].some((x: string) => GUESS.test(x)), 'said as a guess on the second part only');
  check(Math.abs(o.snap.kmIn - 0.1) < 0.001 && plain.parts.snap.kmIn > 0.14 && o.snap.d === plain.parts.snap.d,
    `a fix on it: where the first part ends (${o.snap.kmIn} km; without the fields ${plain.parts.snap.kmIn} km)`);
}
{
  const none = (last: number) => ({ approxStart: 0, approxEnd: last });
  const o = await all({ basic: none(5), rerouted: none(5), offRoute: none(2), door: none(2), meet: none(2), repeated: none(3), two: none(1), parts: none(2) });
  check(same(o, plain), 'approxStart 0 / approxEnd at the last point (nothing guessed): as without them');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
