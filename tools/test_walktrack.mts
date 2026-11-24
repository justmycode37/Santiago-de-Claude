// Tests for following a journey by GPS along walks whose ends the engine only guessed (approxStart / approxEnd on a
// walking leg): what the page shows as each fix comes in. A journey is planned as the app plans it
// (KanteJourney.plans() in src/engine-journey.ts, buildSteps() in src/app/journey-steps.ts), each fix goes in through
// onPosition() (src/app/location.ts) and is followed as updateProgress() (src/app/pill.ts) follows it: trackJourney()
// (src/app/tracking.ts). What is checked is what the page shows from it: the live line in the sheet's header
// (liveParts() in src/app/live-line.ts), the bar at the top (progressTime()), the walk drawn as walked
// (stepFeatures()), and the step the cards follow. The modules are imported as they are, with the parts of the page
// they import stubbed. Offline; exit code 1 on any failure.
//
//   node --experimental-test-module-mocks tools/test_walktrack.mts
import { mock } from 'node:test';

let passed = 0, failed = 0;
const check = (ok: boolean, what: string) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };

// ---- places: around O, in metres east and north ----
const O: LngLat = [7.4405, 46.9485];
const at = (e: number, n: number): LngLat => [O[0] + e / (111195 * Math.cos(O[1] * Math.PI / 180)), O[1] + n / 111195];

// ---- the page around the modules tested, stubbed ----
const APP = new URL('../src/app/', import.meta.url);
const [major, minor] = process.versions.node.split('.').map(Number);
const hasExports = major > 25 || (major === 25 && minor >= 9) || (major === 24 && minor >= 15);
const fake = (file: string, exports: Record<string, unknown>) => mock.module(new URL(file, APP).href,
  (hasExports ? { exports } : { namedExports: exports }) as Parameters<typeof mock.module>[1]);
const nothing = () => {};
const marker = { remove: nothing, setLngLat: nothing, _map: null };
/** The destination pin: on the map where a test puts it. */
const dest = { _map: {} as object | null, at: O, getLngLat: () => ({ toArray: () => dest.at }), remove: nothing };
/** The page's own updateProgress() (pill.ts) follows the trip with every fix: trackJourney() first, then it draws. */
let follow = nothing;
fake('map.ts', { map: { flyTo: nothing, jumpTo: nothing, getZoom: () => 16, isZooming: () => false, on: nothing },
  CH_BOUNDS: [[5.9, 45.8], [10.5, 47.9]] });
fake('map-events.ts', { updateCards: nothing });
fake('search.ts', { destMarker: dest, startMarker: marker, inputs: { from: {} } });
fake('search-pins.ts', { clearPlacePins: nothing, render: nothing });
fake('trip-ends.ts', { blurSearch: nothing, setField: nothing, setFollowing: nothing, setPlanOpen: nothing });
fake('pins.ts', { armPin: nothing, pinMenu: marker });
fake('map-places.ts', { updatePlaces: nothing });
fake('journey-map.ts', { jBody: null, jFoot: null, jHead: null, setRoute: nothing });
fake('platforms.ts', { platformKey: () => '' });
fake('sprites.ts', { INK: '#000' });
fake('live-engine.ts', { rideTrip: () => null });
// the header's pieces as text: a line's badge is its name
fake('sheet.ts', { MODE_NAME: {}, h: (_tag: string, _cls: string, ...kids: unknown[]) => kids.join(''), kBadge: (j: { name: string }) => j.name,
  kDelay: (m: number) => `+${m}`, quayOf: () => null });
fake('live-vehicles.ts', { fmtDist: (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`), levelShort: String, platformOf: () => '–', platformWord: () => 'Platform',
  splitPlatform: () => ({}), vehUpdate: nothing });
fake('sheet-content.ts', { connStart: (c: { t0: number }) => c.t0, connEnd: (c: { t1: number }) => c.t1, queueSheet: nothing, renderHead: nothing,
  s3Plan: () => null, s3Prefs: () => ({}) });
fake('pill.ts', { goToStep: nothing, updateProgress: () => follow(), updatePillTimes: nothing, startJourney: nothing });
fake('time-picker.ts', { closeTimeSheet: nothing, updateWhenChip: nothing });
fake('../toast.ts', { showToast: nothing });
fake('../walk-pace.ts', { WALK_PACE: { fix: nothing, attach: nothing } });
fake('../live.ts', { KANTE_LIVE: { runOrWait: () => ({ text: '', level: null }), liveInfoOf: () => ({}), advance: () => null, rideKm: () => null } });
const prefs = { walkKmh: 4.68, stepFree: false, fewerStairs: false, noEscalators: false, wheelchair: false, extraChangeMin: 0, maxWalkMin: 20 };
fake('../settings.ts', { SETTINGS: { prefs: () => prefs, transportations: () => [], journey: () => ({}) } });
let planned: object | null = null;
fake('../engine.ts', { KANTE: { available: () => true, uicOf: () => null, failure: () => 'down', plan: async () => planned, walk: () => new Promise(nothing) } });
fake('../station3d.ts', { Station3D: { loadData: () => Promise.resolve({}), preload: nothing, setUser: nothing }, indoor: { nav: null },
  stationRouter: () => ({ route: () => null, toLngLat: nothing }) });
class Marker { _map: object | null = null; at: LngLat | null = null; setLngLat(ll: LngLat) { this.at = ll; return this; } addTo() { this._map = {}; return this; } remove() { return this; } }
const element = () => ({ className: '', title: '', style: {}, setAttribute: nothing, addEventListener: nothing, appendChild: nothing });
Object.assign(globalThis, { requestAnimationFrame: (f: () => void) => f(), document: { createElement: element }, maplibregl: { Marker } });

// ---- the modules tested, as far as these tests call them ----
interface Feature { geometry: { type: string; coordinates: LngLat[] }; properties: { kind: string; step: number; done?: boolean } }
interface Track { i: number; kmIn: number; km: number; d: number; off: boolean; arrived?: boolean }
const load = (file: string) => import(new URL(file, APP).href);
const J: { plans(fromLL: LngLat, dest: { lngLat: LngLat }): Promise<{ best: { t0: number; t1: number } } | null> } = (await load('../engine-journey.ts')).KanteJourney;
const JS: { buildSteps(conn: object, destTitle: string): { type: string }[]; stepFeatures(steps: object[]): Feature[]; spareOf(st: object): { s: number; text: string } } = await load('journey-steps.ts');
const LOC: { onPosition(pos: { coords: { longitude: number; latitude: number; accuracy: number }; timestamp: number }): void; userMarker: { at: LngLat | null } } = await load('location.ts');
const TR: { trackJourney(): void; progressTime(): { t: number; gps: boolean } } = await load('tracking.ts');
const LL: { liveParts(now: number): { kind: string; parts: unknown[] } | null } = await load('live-line.ts');
const R: { lengthKm(cs: LngLat[]): number } = await load('routing.ts');
const S: { journey: { steps: { type: string }[]; conn: object | null; list: boolean }; tracking: { track: Track | null; geoVersion: number; autoStep: number; userPickedAt: number; arrivedAt: object | null };
  searchState: { tripStart: null } } = await load('state.ts');
follow = () => TR.trackJourney();

// ---- the clock: the page reads Date.now(), set here to when each fix is taken ----
let clock = Math.floor(Date.now() / 60000) * 60000;
Date.now = () => clock;

// ---- the journey: planned by the engine, laid out as the app lays it out ----
let NOW = clock / 1000; // when the access walk starts: an hour on for each journey shown (GPS fixes come in in order)
const quay = (id: string, ll: LngLat, name: string): KanteQuay => ({ id, sloid: id, stationId: `st:${id}`, stationName: name, label: '', noun: 'stop',
  lat: ll[1], lon: ll[0], precision: 'station', level: 0, modes: ['bus'] });
const step = (kind: KanteWalkStep['kind'], from: number, to: number, text: string): KanteWalkStep => ({ kind, text, distM: 50, durS: 40, from, to });
const walkLeg = (kind: KanteWalk['kind'], g: LngLat[], from: KanteWalkPoint, to: KanteWalkPoint, dep: number, durationS: number, more: Partial<KanteWalk>): KanteWalkLeg => ({
  type: 'walk', kind, from, to, dep, arr: dep + durationS, durationS, distanceM: Math.round(R.lengthKm(g) * 1000), stairsUp: 0, stairsDown: 0, lifts: 0,
  escalators: 0, stepFree: true, approximate: false, geometry: g, levels: g.map(() => 0), steps: [step('depart', 0, g.length - 1, 'Head east')], ...more });
const point = (ll: LngLat, q?: KanteQuay): KanteWalkPoint => ({ name: q ? q.stationName : 'Kunsthaus', lat: ll[1], lon: ll[0], ...(q ? { quay: q } : {}) });
// The access walk: 70 m east on paths, then 150 m straight on (a guess) to the stop Q, 220 m in all. The bus from Q
// doubles back west, 2 m beside the walk, to R 400 m on. From R the last walk goes 60 m north on paths and 40 m on to
// the door D (a guess); the destination pin is 30 m inside the building.
const Q = at(220, 0), I = at(210, 2), R0 = at(-180, 2), D = at(-180, 102), PIN = at(-180, 132);
const qQ = quay('q', Q, 'Bern, Zytglogge'), qI = quay('i', I, 'Bern, Rathaus'), qR = quay('r', R0, 'Bern, Kornhausplatz');
let DEP = 0, ARR = 0; // the bus: show()
const access = (x: Partial<KanteWalk>) => walkLeg('access', [at(0, 0), at(35, 0), at(70, 0), Q], point(at(0, 0)), point(Q, qQ), NOW, 240, x);
const egress = (x: Partial<KanteWalk>) => walkLeg('egress', [R0, at(-180, 60), D], point(R0, qR), point(PIN), ARR, 120, { ...x, door: { lat: D[1], lon: D[0], kind: 'main' } });
const bus = (): KanteRideLeg => ({ type: 'ride', tripId: 't1', serviceDate: '2026-11-24', line: { name: '10', category: 'B', mode: 'bus', operator: 'BERNMOBIL' },
  headsign: 'Kornhausplatz', from: { seq: 1, quay: qQ, dep: DEP }, intermediate: [{ seq: 2, quay: qI, arr: DEP + 20, dep: DEP + 20 }],
  to: { seq: 3, quay: qR, arr: ARR }, geometry: [], live: 'timetable' }) as unknown as KanteRideLeg;
/** The journey on show, with or without the guessed ends, and nothing tracked yet. */
async function show(guessed: boolean, accessX?: Partial<KanteWalk>) {
  NOW += 3600;
  DEP = NOW + 270; // the walk takes 240 s, then 30 s at the stop
  ARR = DEP + 300;
  const legs = [access(accessX || (guessed ? { approxEnd: 2 } : {})), bus(), egress(guessed ? { approxEnd: 1 } : {})];
  planned = { journeys: [{ id: 'j1', dep: NOW, arr: ARR + 120, durationS: ARR + 120 - NOW, transfers: 0, walkS: 360, walkM: 320, legs }] };
  const o = await J.plans(O, { lngLat: PIN });
  Object.assign(S.journey, { conn: o!.best, steps: JS.buildSteps(o!.best, 'Kunsthaus'), list: false });
  Object.assign(S.tracking, { track: null, autoStep: -1, userPickedAt: 0 });
  S.tracking.geoVersion++;
  S.searchState.tripStart = null;
  dest._map = {};
  dest.at = PIN;
}
/** Another journey on show, as the engine plans it (walkOnly: walking all the way), with its destination pin. */
async function showPlan(plan: { journeys: KanteJourney[]; walkOnly?: KanteJourney }, pin: LngLat, title: string) {
  planned = plan;
  const o = await J.plans(O, { lngLat: pin });
  Object.assign(S.journey, { conn: o!.best, steps: JS.buildSteps(o!.best, title), list: false });
  Object.assign(S.tracking, { track: null, autoStep: -1, userPickedAt: 0 }); // (opening it as pill.ts does)
  S.tracking.geoVersion++;
  S.searchState.tripStart = null;
  dest._map = {};
  dest.at = pin;
}
/** A GPS fix at e m east and n m north of O, 10 m accurate, taken at `when` (unix seconds): what the page shows then (bar: the moment of the trip it shows, s after the walk starts). */
const fix = (e: number, n: number, when: number) => fixAt(at(e, n), when);
/** …at a point, `accuracy` m accurate. */
function fixAt(ll: LngLat, when: number, accuracy = 10) {
  clock = when * 1000;
  LOC.onPosition({ coords: { longitude: ll[0], latitude: ll[1], accuracy }, timestamp: clock });
  const t = S.tracking.track!, line = LL.liveParts(Date.now());
  const walked = JS.stepFeatures(S.journey.steps).filter((f) => f.properties.kind === 'walk' && f.properties.step === t.i && f.properties.done)
    .reduce((m, f) => m + R.lengthKm(f.geometry.coordinates) * 1000, 0);
  return { i: t.i, km: t.km, arrived: !!t.arrived, off: t.off, live: line ? line.parts.join('') : '', bar: (TR.progressTime().t - NOW * 1000) / 1000, walked: Math.round(walked) };
}
const steps = () => S.journey.steps.map((s) => s.type);

console.log('the journey as laid out');
await show(true);
check(steps().join(' ') === 'walk ride walk arrive', `walk, bus, walk, arrive (${steps().join(' ')})`);

// along the access walk at its pace, the last fix 40 m before the stop (and then at the stop)
const walkToStop = (wait = true) => [20, 50, 100, 150, 180, ...(wait ? [220] : [])].map((x) => fix(x, 0, NOW + (x / 220) * 240 + (x === 220 ? 20 : 0)));

console.log('1. boarding after a walk with a guessed tail, the bus doubling back 2 m beside it');
async function boarding(guessed: boolean) {
  await show(guessed);
  const walking = walkToStop(false); // (no fix at the stop: the bus is boarded straight from the guessed tail)
  const riding = [62, 87, 112, 137, 162].map((m, k) => fix(220 - m, 2, DEP + 15 + 5 * k)); // 18 km/h
  return { walking, riding, firstRide: riding.findIndex((f) => f.i === 1) };
}
const plainBoard = await boarding(false), guessBoard = await boarding(true);
check(plainBoard.firstRide === 0, `(without the fields: on the bus at the first fix on it, ${plainBoard.riding[0].live})`);
check(guessBoard.firstRide === 0, `with them: on the bus at the first fix on it too (fix ${guessBoard.firstRide + 1}, 62 m in: "${guessBoard.riding[0].live}")`);
check(guessBoard.riding.every((f, k) => f.live === plainBoard.riding[k].live && f.i === plainBoard.riding[k].i), 'every fix on the bus shows what it shows without the fields');
check(Math.abs(guessBoard.walking[4].km - 0.18) < 0.002, `the next fix is snapped from where you are on the guessed tail (${guessBoard.walking[4].km.toFixed(3)} km into the trip, not where the paths end)`);

console.log('6. along the guessed tail: the distance and the bar from where you are, the walk drawn as walked up to the paths');
{
  const tail = guessBoard.walking.slice(2, 5), plain = plainBoard.walking.slice(2, 5);
  check(tail.every((f, k) => f.live === plain[k].live), `the distance to the stop as without the fields: ${tail.map((f) => `"${f.live}"`).join(', ')}`);
  check(tail[0].live.startsWith('120 m to') && tail[1].live.startsWith('70 m to') && tail[2].live.startsWith('40 m to'), 'it goes down as you walk: 120 m, 70 m, 40 m');
  check(tail[0].bar < tail[1].bar && tail[1].bar < tail[2].bar && tail.every((f, k) => f.bar === plain[k].bar), 'the bar moves on with you, as without the fields');
  check(tail.every((f) => f.walked === 70) && plain[2].walked >= 180, `drawn as walked: the 70 m of paths, not the guess (${tail.map((f) => f.walked).join(', ')} m; without the fields ${plain.map((f) => f.walked).join(', ')} m)`);
}

console.log('5. into the building at the end: once arrived, arrived');
async function arriving(guessed: boolean) {
  await show(guessed);
  walkToStop();
  [62, 200, 390].forEach((m, k) => fix(220 - m, 2, DEP + [15, 60, 290][k])); // on the bus to R
  const walk = [[-180, 30], [-180, 60], [-180, 72]].map(([e, n], k) => fix(e, n, ARR + 30 * (k + 1)));
  const door = fix(-180, 102, ARR + 120);
  // inside: back along the guessed line 30 m behind the door, then 70 m to one side (twice)
  const inside = [[-185, 72], [-110, 132], [-110, 132]].map(([e, n], k) => fix(e, n, ARR + 130 + 10 * k));
  return { walk, door, inside };
}
{
  const p = await arriving(false), g = await arriving(true);
  check(g.door.arrived && g.door.live === 'You have arrived', `at the door: "${g.door.live}"`);
  check(g.inside.every((f) => f.arrived && f.live === 'You have arrived' && !f.off), `walking on inside, it stays so (${g.inside.map((f) => `"${f.live}"`).join(', ')})`);
  check(p.inside.every((f) => f.arrived && f.live === 'You have arrived'), '(without the fields too)');
  check(g.walk.every((f) => !f.arrived) && g.walk[2].live === '30 m to Kunsthaus', `before the door, not yet: "${g.walk.map((f) => f.live).join('", "')}"`);
}
{
  // the bus passes 10 m from the destination pin, which is then within the GPS accuracy (counted as at least 20 m)
  await show(true);
  walkToStop();
  fix(158, 2, DEP + 15);
  dest.at = at(0, 12);
  const passing = fix(0, 2, DEP + 60);
  check(!passing.arrived && passing.i === 1 && passing.live.startsWith('On '), `passing the destination on the bus: not arrived ("${passing.live}")`);
}

// ---- the review's findings (round 3): arrival, guessed walks, the change's seconds ----
// Each journey below starts a day later than the one before, so its fixes come after every fix before them.
let day = 0;
/** 09:00 on a day after every fix so far (unix seconds). */
function nineAm() {
  const d = new Date(clock + (++day) * 864e5);
  d.setHours(9, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}
const W0: LngLat = [7.4382, 46.9485], RATHAUS: LngLat = [7.4520, 46.9481], BEND: LngLat = [7.4450, 46.9481];
/** A point m metres before the end of the line a → b (along it). */
const before = (a: LngLat, b: LngLat, m: number): LngLat => { const f = m / (R.lengthKm([a, b]) * 1000); return [b[0] + (a[0] - b[0]) * f, b[1] + (a[1] - b[1]) * f]; };
/** Walking all the way to Bern Rathaus, leaving at 09:00 (with or without a guessed start). */
async function walkToRathaus(guessed: boolean) {
  const t0 = nineAm(), g: LngLat[] = guessed ? [W0, before(BEND, W0, 20), BEND, RATHAUS] : [W0, BEND, RATHAUS];
  const leg = walkLeg('direct', g, point(W0), { name: 'Bern Rathaus', lat: RATHAUS[1], lon: RATHAUS[0] }, t0, 810, guessed ? { approxStart: 1 } : {});
  await showPlan({ journeys: [], walkOnly: { id: 'w', dep: t0, arr: t0 + 810, durationS: 810, transfers: 0, walkS: 810, walkM: leg.distanceM, legs: [leg] } }, RATHAUS, 'Bern Rathaus');
  return t0;
}

console.log('7. arrival: one stray fix does not end the journey for good (review finding 1)');
for (const guessed of [true, false]) {
  const t0 = await walkToRathaus(guessed), at908 = t0 + 8 * 60;
  const here: LngLat = [7.450753, 46.9480774], stray: LngLat = [7.4519996, 46.9493026];
  const a = fixAt(here, at908, 8), b = fixAt(stray, at908 + 5, 8), c = fixAt(here, at908 + 10, 8);
  const tag = guessed ? '' : ' (without the approx fields)';
  check(a.live === '90 m to Bern Rathaus', `at 09:08: "${a.live}"${tag}`);
  check(c.live === '90 m to Bern Rathaus' && !c.arrived, `a stray fix ${Math.round(R.lengthKm([stray, RATHAUS]) * 1000)} m off the end ("${b.live}") and back: "${c.live}"${tag}`);
}
{
  // 82 m left, then a fix 129 m beyond the end (on the line's extension, 120 m accurate: within the off-route tolerance)
  const t0 = await walkToRathaus(false);
  const beyond: LngLat = [RATHAUS[0] + 129 / (111195 * Math.cos(RATHAUS[1] * Math.PI / 180)), RATHAUS[1]];
  fixAt(before(BEND, RATHAUS, 82), t0 + 700);
  const b = fixAt(beyond, t0 + 705, 120), c = fixAt(before(BEND, RATHAUS, 82), t0 + 710);
  check(!b.off && c.live === '80 m to Bern Rathaus', `a fix 129 m beyond the end with 120 m accuracy ("${b.live}"), then 82 m before it: "${c.live}"`);
}
{
  // a ride, then a walk of 12 m: on the bus 10 m before its last stop is within 25 m of the trip's end along its line
  NOW = nineAm();
  DEP = NOW + 60; ARR = DEP + 300;
  const P12 = at(-180, 14);
  const leg = walkLeg('egress', [R0, P12], point(R0, qR), point(P12), ARR, 20, {});
  await showPlan({ journeys: [{ id: 'j2', dep: DEP, arr: ARR + 20, durationS: ARR + 20 - DEP, transfers: 0, walkS: 20, walkM: 12, legs: [bus(), leg] }] }, P12, 'Kunsthaus');
  check(steps().join(' ') === 'ride walk arrive', `a bus, then 12 m on foot (${steps().join(' ')})`);
  const onBus = fix(-170, 2, ARR - 5);
  check(onBus.i === 0 && !onBus.arrived && onBus.live.startsWith('On '), `on the bus 10 m before the stop: not arrived ("${onBus.live}")`);
  const there = fix(-180, 14, ARR + 25);
  check(there.arrived && there.live === 'You have arrived', `at the destination: "${there.live}"`);
}

console.log('8. arrived for good: kept through a gap in GPS (review finding 8)');
{
  const t0 = await walkToRathaus(true);
  const end = fixAt(RATHAUS, t0 + 800);
  clock += 100000; // 100 s without a fix: the progress timer runs on
  TR.trackJourney();
  const back = fixAt(before(BEND, RATHAUS, 54), t0 + 920);
  check(end.arrived && back.arrived && back.live === 'You have arrived', `at the end, then 100 s later a fix 54 m back: "${back.live}"`);
  const t1 = await walkToRathaus(true); // another trip opened: not arrived there
  const again = fixAt(before(BEND, RATHAUS, 54), t1 + 700);
  check(!again.arrived && again.live === '50 m to Bern Rathaus', `another trip opened: "${again.live}"`);
}

console.log('9. a walk that is all a guess is not drawn as walked; the blue dot stays off guessed stretches (review finding 7)');
{
  const t0 = nineAm(), B300 = at(300, 0);
  const leg = walkLeg('direct', [O, B300], point(O), point(B300), t0, 300, { approximate: true, steps: [step('walk', 0, 1, 'Walk about 390 m to Kunsthaus')] });
  await showPlan({ journeys: [], walkOnly: { id: 'w', dep: t0, arr: t0 + 300, durationS: 300, transfers: 0, walkS: 300, walkM: 300, legs: [leg] } }, B300, 'Kunsthaus');
  const f = fix(130, 2, t0 + 130);
  check(f.walked === 0 && f.live === '170 m to Kunsthaus', `130 m into a walk with no path: none of it drawn as walked (${f.walked} m), "${f.live}"`);
}
{
  // a walk in two parts: the engine's path, then a straight line it found no path for (a station model's way that
  // failed, a moved end): the dot does not go onto the straight part
  NOW = nineAm() - 3600; // (show() moves it on an hour)
  await show(false);
  const st = S.journey.steps[0] as unknown as { lines: LngLat[][]; walks: object[] };
  const l1: LngLat[] = [at(0, 0), at(35, 0), at(70, 0)], l2: LngLat[] = [at(70, 0), Q];
  st.lines = [l1, l2];
  st.walks = [{ ...st.walks[0], coords: l1 }, { coords: l2, steps: null, dist: null, approx: true }];
  S.tracking.geoVersion++;
  fix(20, 0, NOW + 20);
  const f = fix(150, 3, NOW + 160);
  const dot = LOC.userMarker.at!;
  check(R.lengthKm([dot, at(150, 3)]) < 0.0005, `on the straight part, 3 m off it: the dot where GPS says (${Math.round(R.lengthKm([dot, at(150, 0)]) * 1000)} m from the line)`);
  check(f.walked === 70, `drawn as walked: the path, not the straight part (${f.walked} m)`);
}
{
  // a guessed tail, 20 m before the stop: within 25 m of the walk's end the walk is drawn as walked, but the dot stays
  // off the guess
  NOW = nineAm() - 3600;
  await show(true);
  [20, 50, 100, 150].forEach((x) => fix(x, 0, NOW + (x / 220) * 240));
  const f = fix(200, 3, NOW + 200);
  const dot = LOC.userMarker.at!;
  check(R.lengthKm([dot, at(200, 3)]) < 0.0005, `20 m before the stop, on the guessed tail: the dot where GPS says (${Math.round(R.lengthKm([dot, at(200, 0)]) * 1000)} m from the line)`);
  check(f.walked === 200, `and the walk drawn as walked up to you (${f.walked} m)`);
}
{
  // a guessed start, a fix 3 m behind its first point (review Neon 6)
  NOW = nineAm() - 3600;
  await show(false, { approxStart: 1 });
  fix(-3, 0, NOW + 1);
  const dot = LOC.userMarker.at!;
  check(R.lengthKm([dot, at(-3, 0)]) < 0.0005, `3 m behind the start of a guessed start: the dot where GPS says (${Math.round(R.lengthKm([dot, at(0, 0)]) * 1000)} m from its first point)`);
}

console.log('10. the live header and the change card count the same seconds (review finding 5)');
{
  // a bus to I, 155 s on foot to the next stop, which the next bus leaves 165 s after the first arrives
  NOW = nineAm();
  const qJ = quay('j', at(210, 150), 'Bern, Theaterplatz');
  const ride = (id: string, a: KanteQuay, dep: number, b: KanteQuay, arr: number) => ({ type: 'ride', tripId: id, serviceDate: '2026-11-24',
    line: { name: id, category: 'B', mode: 'bus', operator: 'BERNMOBIL' }, headsign: 'x', from: { seq: 1, quay: a, dep, depDelayS: 0 }, intermediate: [],
    to: { seq: 2, quay: b, arr, arrDelayS: 0 }, geometry: [], live: 'forecast' }) as unknown as KanteRideLeg;
  const arr = NOW + 600, dep = arr + 165;
  const change = walkLeg('transfer', [I, at(210, 75), at(210, 150)], point(I, qI), point(at(210, 150), qJ), arr, 155, {});
  await showPlan({ journeys: [{ id: 'j3', dep: NOW, arr: dep + 300, durationS: dep + 300 - NOW, transfers: 1, walkS: 155, walkM: 150,
    legs: [ride('10', qQ, NOW, qI, arr), change, ride('12', qJ, dep, qR, dep + 300)] }] }, R0, 'Kornhausplatz');
  const ch = S.journey.steps.find((x) => x.type === 'change')!;
  clock = (NOW + 60) * 1000; // no GPS (the last fix is a day old)
  const line = LL.liveParts(Date.now()), head = line ? line.parts.join('') : '';
  check(JS.spareOf(ch).text === '10 s to spare', `the card: "${JS.spareOf(ch).text}"`);
  check(!head.startsWith('Not enough time'), `the header agrees: "${head}"`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
