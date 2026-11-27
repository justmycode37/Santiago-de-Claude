// Tests for rerouting a walk from where you are (src/app/walk-reroute.ts): following a journey by GPS on a walk, you
// leave its way for another way to the same place, and the walk is asked of the engine again from there. A journey is
// planned as the app plans it (KanteJourney.plans(), buildSteps()), each fix goes in through onPosition()
// (src/app/location.ts) and is followed as updateProgress() (src/app/pill.ts) follows it: trackJourney()
// (src/app/tracking.ts). The engine's /api/walk is a fake that answers as each test says. What is checked is what the
// page shows: the live line in the sheet's header (liveParts()), the walk drawn and drawn as walked (stepFeatures()),
// the step's times, and how often the engine is asked. The modules are imported as they are, with the parts of the
// page they import stubbed. Offline; exit code 1 on any failure.
//
//   node --experimental-test-module-mocks tools/test_walkreroute.mts
import { mock } from 'node:test';

let passed = 0, failed = 0;
const check = (ok: boolean, what: string) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };

// ---- places: around O, in metres east and north ----
const O: LngLat = [7.4405, 46.9485];
const KX = 111195 * Math.cos(O[1] * Math.PI / 180), KY = 111195;
const at = (e: number, n: number): LngLat => [O[0] + e / KX, O[1] + n / KY];
const en = (p: LngLat): [number, number] => [(p[0] - O[0]) * KX, (p[1] - O[1]) * KY];

// ---- the page around the modules tested, stubbed ----
const APP = new URL('../src/app/', import.meta.url);
const [major, minor] = process.versions.node.split('.').map(Number);
const hasExports = major > 25 || (major === 25 && minor >= 9) || (major === 24 && minor >= 15);
const fake = (file: string, exports: Record<string, unknown>) => mock.module(new URL(file, APP).href,
  (hasExports ? { exports } : { namedExports: exports }) as Parameters<typeof mock.module>[1]);
const nothing = () => {};
const marker = { remove: nothing, setLngLat: nothing, _map: null };
const dest = { _map: {} as object | null, at: O, getLngLat: () => ({ toArray: () => dest.at }), remove: nothing };
let follow = nothing;
fake('map.ts', { map: { flyTo: nothing, jumpTo: nothing, getZoom: () => 16, isZooming: () => false, on: nothing }, CH_BOUNDS: [[5.9, 45.8], [10.5, 47.9]] });
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
fake('sheet.ts', { MODE_NAME: {}, h: (_tag: string, _cls: string, ...kids: unknown[]) => kids.join(''), kBadge: (j: { name: string }) => j.name,
  kDelay: (m: number) => `+${m}`, quayOf: () => null });
fake('live-vehicles.ts', { vehShowsTrip: () => false, fmtDist: (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`), levelShort: String, platformOf: () => '–', platformWord: () => 'Platform',
  splitPlatform: () => ({}), vehUpdate: nothing });
fake('sheet-content.ts', { connStart: (c: { t0: number }) => c.t0, connEnd: (c: { t1: number }) => c.t1, queueSheet: nothing, renderHead: nothing,
  s3Plan: () => null, s3Prefs: () => ({}) });
fake('pill.ts', { goToStep: nothing, updateProgress: () => follow(), updatePillTimes: nothing, startJourney: nothing });
fake('time-picker.ts', { closeTimeSheet: nothing, updateWhenChip: nothing });
fake('heading.ts', { noteFix: nothing, startHeading: nothing });
fake('../toast.ts', { showToast: nothing });
fake('../walk-pace.ts', { WALK_PACE: { fix: nothing, attach: nothing } });
fake('../live.ts', { KANTE_LIVE: { runOrWait: (leftS: number, walkS: number) => ({ text: `${Math.round(leftS - walkS)} s spare`, level: leftS < walkS ? 'late' : 'ok' }),
  liveInfoOf: () => ({}), advance: () => null, rideKm: () => null } });
const prefs = { walkKmh: 4.68, stepFree: false, fewerStairs: false, noEscalators: false, wheelchair: false, extraChangeMin: 0, maxWalkMin: 20 };
fake('../settings.ts', { SETTINGS: { prefs: () => prefs, transportations: () => [], journey: () => ({}) } });
let planned: object | null = null;
/** What /api/walk answers (set by each test), and every request it got. */
let walkAnswer: (req: KanteWalkRequest) => Promise<KanteWalk> = () => new Promise(nothing);
const asked: { req: KanteWalkRequest; at: number }[] = [];
fake('../engine.ts', { KANTE: { available: () => true, uicOf: () => null, failure: (e: { reason?: string } | null) => (e && e.reason) || null, plan: async () => planned,
  walk: (req: KanteWalkRequest) => { asked.push({ req, at: Date.now() }); return walkAnswer(req); } } });
fake('../station3d.ts', { Station3D: { loadData: () => Promise.resolve({}), preload: nothing, setUser: nothing }, indoor: { nav: null },
  stationRouter: () => ({ route: () => null, toLngLat: nothing }) });
class Marker { _map: object | null = null; at: LngLat | null = null; setLngLat(ll: LngLat) { this.at = ll; return this; } addTo() { this._map = {}; return this; } remove() { return this; } }
const element = () => ({ className: '', title: '', style: {}, setAttribute: nothing, addEventListener: nothing, appendChild: nothing });
Object.assign(globalThis, { requestAnimationFrame: (f: () => void) => f(), document: { createElement: element } });
mock.module('maplibre-gl', (hasExports ? { exports: { Marker } } : { namedExports: { Marker } }) as Parameters<typeof mock.module>[1]);

// ---- the modules tested ----
interface Feature { geometry: { type: string; coordinates: LngLat[] }; properties: { kind: string; step: number; done?: boolean; approx?: boolean } }
interface Track { i: number; kmIn: number; km: number; d: number; off: boolean; arrived?: boolean }
interface Foot { type: string; lines: LngLat[][]; walked?: { coords: LngLat[]; guess: boolean }[]; walkRev?: number; walkS?: number; t0: number | null; t1: number | null;
  reroute?: { eta: number }; time?: number | null }
const load = (file: string) => import(new URL(file, APP).href);
const J: { plans(fromLL: LngLat, dest: { lngLat: LngLat }): Promise<{ best: object } | null>; requay(steps: object[], changed: () => void): void } = (await load('../engine-journey.ts')).KanteJourney;
const JS: { buildSteps(conn: object, destTitle: string): Foot[]; stepFeatures(steps: object[]): Feature[]; spareOf(st: object): { s: number; text: string };
  syncEnds(steps: object[]): void } = await load('journey-steps.ts');
const LOC: { onPosition(pos: { coords: { longitude: number; latitude: number; accuracy: number }; timestamp: number }): void } = await load('location.ts');
const TR: { trackJourney(): void } = await load('tracking.ts');
const LL: { liveParts(now: number): { kind: string; parts: unknown[] } | null } = await load('live-line.ts');
const R: { lengthKm(cs: LngLat[]): number; refineWalks(id: number, onlyMoved?: boolean): void } = await load('routing.ts');
const S: { journey: { steps: Foot[]; conn: object | null; list: boolean; req: number }; tracking: { track: Track | null; geoVersion: number; autoStep: number; userPickedAt: number };
  searchState: { tripStart: null } } = await load('state.ts');
follow = () => TR.trackJourney();

let clock = Math.floor(Date.now() / 60000) * 60000;
Date.now = () => clock;
/** Lets answers that are already in (resolved promises) be taken, as the page would before the next fix. */
const settle = () => new Promise((r) => setImmediate(r));

// ---- the journey ----
const quay = (id: string, ll: LngLat, name: string): KanteQuay => ({ id, sloid: id, stationId: `st:${id}`, stationName: name, label: '', noun: 'stop',
  lat: ll[1], lon: ll[0], precision: 'station', level: 0, modes: ['bus'] });
const point = (ll: LngLat, q?: KanteQuay): KanteWalkPoint => ({ name: q ? q.stationName : 'Kunsthaus', lat: ll[1], lon: ll[0], ...(q ? { quay: q } : {}) });
const walkLeg = (kind: KanteWalk['kind'], g: LngLat[], from: KanteWalkPoint, to: KanteWalkPoint, dep: number, durationS: number, more?: Partial<KanteWalk>): KanteWalkLeg => ({
  type: 'walk', kind, from, to, dep, arr: dep + durationS, durationS, distanceM: Math.round(R.lengthKm(g) * 1000), stairsUp: 0, stairsDown: 0, lifts: 0,
  escalators: 0, stepFree: true, approximate: false, geometry: g, levels: g.map(() => 0), steps: [{ kind: 'depart', text: 'Head east', distM: 50, durS: 40, from: 0, to: g.length - 1 }], ...more });
const ride = (id: string, a: KanteQuay, dep: number, b: KanteQuay, arr: number) => ({ type: 'ride', tripId: id, serviceDate: '2026-11-24',
  line: { name: id, category: 'B', mode: 'bus', operator: 'BERNMOBIL' }, headsign: 'x', from: { seq: 1, quay: a, dep, depDelayS: 0 }, intermediate: [],
  to: { seq: 2, quay: b, arr, arrDelayS: 0 }, geometry: [], live: 'forecast' }) as unknown as KanteRideLeg;
// The walk to the stop Q, 300 m east along a street (n = 0); a street parallel to it 60 m north (n = 60), joined to it
// by a cross street at e = 60. The bus from Q goes 500 m south to R; from R a 20 m walk to the destination.
const Q = at(300, 0), R0 = at(300, -500), PIN = at(300, -520);
const qQ = quay('q', Q, 'Bern, Zytglogge'), qR = quay('r', R0, 'Bern, Kornhausplatz');
let NOW = Math.floor(clock / 1000) + 3600, DEP = 0;
async function showPlan(plan: object, pin: LngLat, title: string) {
  planned = plan;
  const o = await J.plans(O, { lngLat: pin });
  Object.assign(S.journey, { conn: o!.best, steps: JS.buildSteps(o!.best, title), list: false });
  Object.assign(S.tracking, { track: null, autoStep: -1, userPickedAt: 0 });
  S.tracking.geoVersion++;
  S.searchState.tripStart = null;
  dest._map = {};
  dest.at = pin;
}
/** The walk to Q and the bus, the walk setting out at NOW (an hour after the last journey's). */
async function show() {
  NOW = Math.max(NOW, Math.floor(clock / 1000)) + 3600;
  DEP = NOW + 600;
  const access = walkLeg('access', [at(0, 0), at(100, 0), at(200, 0), Q], point(at(0, 0)), point(Q, qQ), NOW, 230);
  const egress = walkLeg('egress', [R0, PIN], point(R0, qR), point(PIN), DEP + 300, 20);
  await showPlan({ journeys: [{ id: 'j1', dep: NOW, arr: DEP + 320, durationS: DEP + 320 - NOW, transfers: 0, walkS: 250, walkM: 320,
    legs: [access, ride('10', qQ, DEP, qR, DEP + 300), egress] }] }, PIN, 'Kunsthaus');
  asked.length = 0;
}
/** The engine's walk from where it is asked: up to the parallel street, along it, and down to the target (the end of
 *  the walk asked for), at 1.3 m/s; `more`: anything else on it (a guessed start). */
function engineWalk(req: KanteWalkRequest, more?: Partial<KanteWalk>): KanteWalk {
  const from: LngLat = [req.from.lon!, req.from.lat!], to: LngLat = [req.to.lon!, req.to.lat!];
  const [fe] = en(from), [te, tn] = en(to);
  const g: LngLat[] = [from, at(Math.max(fe, 60), 60), at(te, 60), to];
  if (tn === 60) g.pop();
  const m = R.lengthKm(g) * 1000;
  return walkLeg('direct', g, point(from), point(to), Math.floor(Date.now() / 1000), Math.round(m / 1.3), more);
}
/** A fix at e, n (m), taken at `when` (unix seconds), 10 m accurate: what the page shows then. */
async function fix(e: number, n: number, when: number, accuracy = 10) {
  clock = when * 1000;
  LOC.onPosition({ coords: { longitude: at(e, n)[0], latitude: at(e, n)[1], accuracy }, timestamp: clock });
  await settle();
  const t = S.tracking.track!, line = LL.liveParts(Date.now());
  const done = JS.stepFeatures(S.journey.steps).filter((f) => f.properties.kind === 'walk' && f.properties.step === 0 && f.properties.done)
    .reduce((m, f) => m + R.lengthKm(f.geometry.coordinates) * 1000, 0);
  return { i: t.i, off: t.off, live: line ? line.parts.join('') : '', done: Math.round(done) };
}
type Shown = Awaited<ReturnType<typeof fix>>;
/** Along the walk's street to e = 60 (fixes every 5 s), then north up the cross street at 1.3 m/s, a fix a second,
 *  up to n = `upTo`: what each fix shows. */
async function walkOff(t0: number, upTo: number) {
  const out: Shown[] = [];
  for (let e = 0; e <= 60; e += 6.5) out.push(await fix(Math.min(e, 60), 0, t0 + e / 1.3));
  let t = t0 + 60 / 1.3;
  for (let n = 1.3; n <= upTo + 0.01; n += 1.3) out.push(await fix(60, n, ++t));
  return { out, t };
}
const step0 = () => S.journey.steps[0];

console.log('1. GPS noise: no request, never "Off the route"');
{
  await show();
  walkAnswer = async (req) => engineWalk(req);
  const shown: Shown[] = [];
  for (let e = 0; e <= 100; e += 6.5) shown.push(await fix(e, 0, NOW + e / 1.3));
  let t = NOW + 100 / 1.3;
  shown.push(await fix(105, 40, ++t)); // one fix 40 m off
  shown.push(await fix(106, 1, ++t));
  shown.push(await fix(110, 50, ++t), await fix(111, 52, ++t)); // two fixes 50 m off, a second apart (multipath)
  for (let e = 112; e <= 140; e += 1.3) shown.push(await fix(e, 0, ++t));
  check(asked.length === 0, `no request to the engine (${asked.length})`);
  check(shown.every((f) => !f.off && !f.live.startsWith('Off the route')), `never "Off the route" (${shown.filter((f) => f.off).length} fixes off)`);
}

console.log('2. onto the parallel street: rerouted along it, the walked part drawn as walked');
{
  await show();
  walkAnswer = async (req) => engineWalk(req);
  const { out, t } = await walkOff(NOW, 50);
  check(asked.length === 1, `one request (${asked.length})`);
  const req = asked[0] && asked[0].req, [fe, fn] = req ? en([req.from.lon!, req.from.lat!]) : [0, 0];
  check(!!req && Math.abs(fe - 60) < 1 && fn > 32 && fn < 46, `asked from where you are, up the cross street (${fe.toFixed(0)}, ${fn.toFixed(0)} m), before the off-route tolerance (45 m)`);
  check(!!req && req.to.quay === 'q' && req.time === Math.floor(asked[0].at / 1000) && req.limitS != null && req.limitS > 0,
    `to the stop by its id, at the time asked, within the time there is until the bus (limitS ${req && req.limitS})`);
  check(out.every((f) => !f.off && !f.live.startsWith('Off the route')), `never "Off the route" on the way (${out.map((f) => f.live).filter((l) => l.startsWith('Off')).length})`);
  const st = step0();
  check(!!st.walked && st.lines.length === 1 && Math.abs(en(st.lines[0][0])[1] - fn) < 0.5, `the walk's way now starts where it was asked from, the part before it kept as walked (${st.walked && st.walked.length} pieces)`);
  const last = out[out.length - 1];
  check(Math.abs(last.done - (60 + 50)) <= 3, `drawn as walked: 60 m along the street and 50 m up the cross street (${last.done} m)`);
  const along = [await fix(60, 60, t + 8), await fix(150, 60, t + 80), await fix(250, 60, t + 156)];
  check(along.every((f) => !f.off && f.i === 0) && along[1].live.startsWith('210 m to') && along[2].live.startsWith('110 m to'),
    `along the parallel street: the metres left along it ("${along[1].live}", "${along[2].live}")`);
  check(asked.length === 1, `and no more requests along it (${asked.length})`);
  check(along[2].done >= 110 + 190 - 3, `the walk drawn as walked along the new way (${along[2].done} m)`);
  const sheetT1 = st.t1!, eta = st.reroute!.eta;
  check(sheetT1 === eta && Math.abs(eta - (clock + 110 / 1.3 * 1000)) < 1500, `the walk's end: the last fix and the 110 m left at the engine's pace (${((eta - clock) / 1000).toFixed(0)} s on)`);
}

console.log('3. the engine finds you on no way (a guessed start): the walk stays, "Off the route"');
{
  await show();
  walkAnswer = async (req) => engineWalk(req, { approxStart: 1 });
  const before = step0().lines;
  const { out } = await walkOff(NOW, 56);
  check(asked.length === 1 && step0().lines === before && !step0().walked, `asked once, the walk as it was (${asked.length} requests)`);
  check(out[out.length - 1].off && out[out.length - 1].live.startsWith('Off the route'), `"${out[out.length - 1].live}"`);
}

console.log('4. no answer (the engine down): the walk stays, "Off the route", asked again only 30 s later');
{
  await show();
  walkAnswer = () => Promise.reject(Object.assign(new Error('down'), { reason: 'down' }));
  const before = step0().lines;
  const { out, t } = await walkOff(NOW, 56);
  check(asked.length === 1 && step0().lines === before, `the walk as it was (${asked.length} requests)`);
  check(out[out.length - 1].live.startsWith('Off the route'), `"${out[out.length - 1].live}"`);
  const firstAt = asked[0].at;
  let tt = t;
  for (let k = 0; k < 40; k++) await fix(60 + k * 1.3, 58, ++tt); // on along the parallel street, still off the walk
  const second = asked[1];
  check(asked.length === 2 && !!second && second.at - firstAt >= 30000 && second.at - firstAt <= 32000, `asked again ${second ? ((second.at - firstAt) / 1000).toFixed(0) : '–'} s later, not before`);
}

console.log('5. a reroute taken: no new request for 10 s, even off the new way');
{
  await show();
  walkAnswer = async (req) => engineWalk(req);
  const { t } = await walkOff(NOW, 50);
  const firstAt = asked[0].at;
  let tt = t;
  // back west along the street at n = 50, away from the new way (which goes east)
  for (let k = 1; k <= 25; k++) await fix(60 - k * 2, 50, ++tt);
  check(asked.length >= 2 && asked[1].at - firstAt >= 10000, `the next request ${asked[1] ? ((asked[1].at - firstAt) / 1000).toFixed(0) : '–'} s after the first`);
}

console.log('6. the answer comes when it no longer fits: on the bus by then, or the walk routed again meanwhile');
{
  await show();
  let resolve: (w: KanteWalk) => void = nothing;
  walkAnswer = (req) => new Promise((r) => { resolve = (w) => r(w); void req; });
  const before = step0().lines;
  const { t } = await walkOff(NOW, 50);
  const req = asked[0].req;
  step0().walkRev = (step0().walkRev || 0) + 1; // a live platform change routed it again meanwhile
  resolve(engineWalk(req));
  await settle();
  check(step0().lines === before && !step0().walked, 'routed again meanwhile: the answer is dropped');
  walkAnswer = async (r) => engineWalk(r);
  const later: Shown[] = [];
  for (let k = 1; k <= 6; k++) later.push(await fix(60, 50 + 1.3 * k, t + k));
  check(asked.length === 2 && !!step0().walked && later.every((f) => !f.live.startsWith('Off the route')), `asked again from there, and rerouted then (${asked.length} requests)`);
}
{
  await show();
  let resolve: (w: KanteWalk) => void = nothing;
  walkAnswer = () => new Promise((r) => { resolve = (w) => r(w); });
  // to the stop along the walk, then up a side street at the stop (the request goes), then on the bus
  for (let e = 0; e <= 260; e += 13) await fix(e, 0, NOW + e / 1.3);
  let t = NOW + 200;
  for (let n = 1.3; n <= 50; n += 1.3) await fix(260, n, ++t);
  const req = asked[0] && asked[0].req;
  const before = step0().lines;
  clock = DEP * 1000;
  for (let k = 0; k < 4; k++) await fix(300, -20 - k * 40, DEP + 10 + 3 * k);
  if (req) resolve(engineWalk(req));
  await settle();
  check(!!req && S.tracking.track!.i === 1 && step0().lines === before, `on the bus when it comes: the answer is dropped (step ${S.tracking.track!.i})`);
}

console.log('7. a change rerouted: the time to spare from the new way; a delay is not asked for again, a platform move asks for the way on only');
{
  // a bus to I, 150 m north on foot to J (where the next bus leaves 600 s after the first arrives)
  NOW = Math.max(NOW, Math.floor(clock / 1000)) + 3600;
  const I = at(0, 0), Jp = at(300, 0), qI = quay('i', I, 'Bern, Rathaus'), qJ = quay('j', Jp, 'Bern, Theaterplatz');
  const arr = NOW + 300, dep = arr + 600;
  const change = walkLeg('transfer', [I, at(100, 0), at(200, 0), Jp], point(I, qI), point(Jp, qJ), arr, 230);
  await showPlan({ journeys: [{ id: 'j3', dep: NOW, arr: dep + 300, durationS: dep + 300 - NOW, transfers: 1, walkS: 230, walkM: 300,
    legs: [ride('a', qQ, NOW, qI, arr), change, ride('b', qJ, dep, qR, dep + 300)] }] }, R0, 'Kornhausplatz');
  asked.length = 0;
  walkAnswer = async (req) => engineWalk(req);
  const ch = S.journey.steps[1];
  check(ch.type === 'change', `a change (${S.journey.steps.map((s) => s.type).join(' ')})`);
  // got off at I: along the street, then up the cross street at e = 60
  await fix(0, 0, arr + 5);
  let t = arr + 5;
  for (let e = 6.5; e <= 60; e += 6.5) await fix(e, 0, t += 5);
  for (let n = 1.3; n <= 50; n += 1.3) await fix(60, n, ++t);
  check(asked.length === 1 && !!ch.walked, `rerouted (${asked.length} request)`);
  // (the last fix is about where the new way begins: all of it is left)
  const spare = JS.spareOf(ch).s, expected = dep - clock / 1000 - engineWalk(asked[0].req).durationS;
  check(Math.abs(spare - expected) < 15, `time to spare: the departure less the last fix and the new way at the engine's pace (${spare.toFixed(0)} s, about ${expected.toFixed(0)})`);
  // the next bus 2 min late (a live update): not asked for again for the time alone; the time to spare follows the delay
  const walkedBefore = JSON.stringify(ch.walked), start = ch.lines[0][0];
  const next = (S.journey.steps[2] as unknown as { s: { from: KanteStopCall } }).s.from;
  next.depDelayS = 120;
  R.refineWalks(S.journey.req, true);
  await settle();
  const spare2 = JS.spareOf(ch).s;
  check(asked.length === 1 && Math.abs(spare2 - (spare + 120)) < 2, `not asked again (${asked.length} request); the time to spare 2 min more (${spare.toFixed(0)} → ${spare2.toFixed(0)} s)`);
  // the next bus moved to a stop 40 m north (a live platform change, as live-engine.ts follows it): the way on is asked
  // for again, from where it begins, now and within the time until the bus leaves; the part walked stays
  const J2 = at(300, 40);
  next.quay = { ...next.quay, id: 'j2', sloid: 'j2', lat: J2[1], lon: J2[0] };
  J.requay(S.journey.steps, () => { JS.syncEnds(S.journey.steps); R.refineWalks(S.journey.req, true); });
  await settle();
  const again = asked[asked.length - 1], depNow = (dep + 120) * 1000;
  check(asked.length === 2 && Math.abs(again.req.from.lon! - start[0]) < 1e-9 && Math.abs(again.req.from.lat! - start[1]) < 1e-9 && again.req.to.quay === 'j2',
    `asked again from where the new way begins to the new stop (${asked.length} requests, to ${again.req.to.quay})`);
  check(again.req.time === Math.floor(clock / 1000) && Math.abs(again.req.limitS! - (depNow - clock) / 1000) <= 1, `at the time asked, within the ${again.req.limitS} s until the bus`);
  const end = ch.lines[ch.lines.length - 1];
  check(JSON.stringify(ch.walked) === walkedBefore && !!ch.reroute && R.lengthKm([end[end.length - 1], J2]) < 0.001, 'the part walked as it was, the way on to the new stop');
  // on the bus from there: a delay of it later does not move when you got to the change's end
  for (const [e, n] of [[150, 60], [300, 60], [300, 40]]) await fix(e, n, t += 60);
  const eta = ch.reroute!.eta;
  clock = depNow + 20000;
  await fix(300, 10, depNow / 1000 + 20);
  await fix(300, -40, depNow / 1000 + 30);
  next.depDelayS = 180;
  R.refineWalks(S.journey.req, true);
  await settle();
  check(S.tracking.track!.i === 2 && ch.reroute!.eta === eta, `on the bus (step ${S.tracking.track!.i}): the change's end stays (${((ch.reroute!.eta - eta) / 1000).toFixed(0)} s moved)`);
}

console.log('8. "Off the route" is not held back for good, nor taken back for a retry');
{
  // fixes 12 s apart, 60 m off the way: never two within 10 s, so never made sure of; said within 15 s all the same
  await show();
  walkAnswer = async (req) => engineWalk(req);
  for (let e = 0; e <= 60; e += 6.5) await fix(e, 0, NOW + e / 1.3);
  let t = NOW + 60 / 1.3;
  const sparse: Shown[] = [];
  for (let k = 0; k < 4; k++) sparse.push(await fix(60 + 15 * k, 60, t += 12));
  check(asked.length === 0 && sparse.slice(2).every((f) => f.live.startsWith('Off the route')), `said by the third fix 24 s on: ${sparse.map((f) => `"${f.live.slice(0, 13)}"`).join(', ')}`);
}
{
  // the engine finds you on no way: once said, it stays said through the retries 20 s on and after
  await show();
  walkAnswer = async (req) => engineWalk(req, { approxStart: 1 });
  const { t } = await walkOff(NOW, 56);
  let tt = t;
  const later: Shown[] = [];
  for (let k = 0; k < 45; k++) later.push(await fix(60 + k * 1.3, 58, ++tt));
  check(asked.length >= 2 && later.every((f) => f.live.startsWith('Off the route')), `${asked.length} requests, "Off the route" at every fix after (${later.filter((f) => !f.live.startsWith('Off')).length} not)`);
}

console.log('9. back on the way before the answer comes: it is dropped');
{
  await show();
  let resolve: (w: KanteWalk) => void = nothing;
  walkAnswer = () => new Promise((r) => { resolve = (w) => r(w); });
  const before = step0().lines;
  const { t } = await walkOff(NOW, 46);
  const req = asked[0] && asked[0].req;
  await fix(60, 20, t + 15);
  await fix(64, 5, t + 26); // back on the walk's street
  if (req) resolve(engineWalk(req));
  await settle();
  check(!!req && step0().lines === before && !step0().walked, 'the walk as it was');
}

console.log('10. the first fix off the way short of the off-route tolerance, the next ones beyond it');
{
  await show();
  walkAnswer = async (req) => engineWalk(req);
  for (let e = 0; e <= 60; e += 6.5) await fix(e, 0, NOW + e / 1.3);
  const t = NOW + 60 / 1.3;
  // 38 m off (counted, short of the 45 m tolerance), then three fixes a second apart 46 to 47 m off (9 m on)
  const shown = [await fix(60, 38, t + 10), await fix(60, 46, t + 11), await fix(60, 46.5, t + 12), await fix(60, 47, t + 13)];
  check(asked.length === 1 && shown.every((f) => !f.live.startsWith('Off the route')), `asked by the third fix beyond it (${asked.length} request)`);
}

console.log('11. walking all the way: the arrival follows the new way');
{
  NOW = Math.max(NOW, Math.floor(clock / 1000)) + 3600;
  const END = at(300, 0);
  const leg = walkLeg('direct', [at(0, 0), at(100, 0), at(200, 0), END], point(at(0, 0)), point(END), NOW, 230);
  await showPlan({ journeys: [], walkOnly: { id: 'w', dep: NOW, arr: NOW + 230, durationS: 230, transfers: 0, walkS: 230, walkM: 300, legs: [leg] } }, END, 'Kunsthaus');
  asked.length = 0;
  walkAnswer = async (req) => engineWalk(req);
  const { t } = await walkOff(NOW, 50);
  const arrive = S.journey.steps[S.journey.steps.length - 1], st = step0();
  check(asked.length === 1 && !!st.walked && arrive.type === 'arrive', `rerouted (${asked.length} request)`);
  const left = R.lengthKm(st.lines[0]) * 1000 - (50 - en(st.lines[0][0])[1]); // (from the last fix, 50 m up the cross street)
  check(arrive.time === st.reroute!.eta && Math.abs(st.reroute!.eta - (clock + left / 1.3 * 1000)) < 2000,
    `arriving when the last fix and the ${Math.round(left)} m left say (${((arrive.time! - clock) / 1000).toFixed(0)} s on)`);
  const on = await fix(150, 60, t + 100);
  check(on.live.startsWith('210 m to Kunsthaus') && Math.abs(arrive.time! - (clock + 210 / 1.3 * 1000)) < 2000, `on along the new way: "${on.live}", arriving ${((arrive.time! - clock) / 1000).toFixed(0)} s on`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
