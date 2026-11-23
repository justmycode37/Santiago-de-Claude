// Tests for the engine's guessed walk ends (approxStart / approxEnd on a walking leg, kante/engine json.rs): the same
// leg without them and with them, through the page's own code (KanteJourney.setWalk() in src/engine-journey.ts,
// stepFeatures() in src/app/journey-steps.ts, snapToTrip() in src/app/tracking.ts, refineWalks() and engineGuess() in
// src/app/routing.ts). Without them everything must come out as main made it before these fields
// (test_walkguess_main.json: this test run with GOLDEN=1 on main at cae95971, with only snapToTrip() exported); with
// them the guessed stretches are drawn dashed, said as a guess, left out of how far GPS moves you along the walk, and
// not taken as routed. The modules are imported as they are, with the parts of the page they import stubbed.
// Offline; exit code 1 on any failure.
//
//   node --experimental-test-module-mocks tools/test_walkguess.mts          (GOLDEN=1: print the outputs to record)
import fs from 'node:fs';
import { mock } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

let passed = 0, failed = 0;
const check = (ok: boolean, what: string) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };
const settle = () => new Promise((r) => setTimeout(r, 0));

// ---- the page around the modules tested, stubbed (as in test_walkrefine.mts) ----
const APP = new URL('../src/app/', import.meta.url);
const [major, minor] = process.versions.node.split('.').map(Number);
const hasExports = major > 25 || (major === 25 && minor >= 9) || (major === 24 && minor >= 15);
const fake = (file: string, exports: Record<string, unknown>) => mock.module(new URL(file, APP).href,
  (hasExports ? { exports } : { namedExports: exports }) as Parameters<typeof mock.module>[1]);
const nothing = () => {};
const marker = { remove: nothing, setLngLat: nothing };
/** What the stubs count: the walks asked of the pedestrian network, and the station models asked for. */
const page = { netAsked: 0, plan: null as { key: string } | null };
fake('map.ts', { map: { flyTo: nothing } });
fake('map-events.ts', { updateCards: nothing });
fake('location.ts', { fixAge: () => 0, gpsOn: () => false, userAccuracy: 0, userLngLat: null, userMarker: marker });
fake('search.ts', { destMarker: marker, startMarker: marker });
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
fake('sheet-content.ts', { connStart: nothing, connEnd: nothing, queueSheet: nothing, s3Plan: () => page.plan, s3Prefs: () => ({}) });
fake('pill.ts', { goToStep: nothing, updateProgress: nothing });
fake('time-picker.ts', { closeTimeSheet: nothing, updateWhenChip: nothing });
fake('../toast.ts', { showToast: nothing });
fake('../live.ts', { KANTE_LIVE: {} });
fake('../settings.ts', { SETTINGS: { prefs: () => ({}), transportations: () => [], walkCosting: () => null, journey: () => ({}) } });
fake('../engine.ts', { KANTE: { available: () => false, uicOf: () => null } });
// a station model without a way through (its router finds none), and the pedestrian network, which never answers
fake('../station3d.ts', { Station3D: { loadData: () => Promise.resolve({}), preload: nothing }, stationRouter: () => ({ route: () => null, toLngLat: nothing }) });
fake('../walkroute.ts', { WALKROUTE: { route: () => { page.netAsked++; return new Promise(nothing); } } });
const element = () => ({ className: '', title: '', setAttribute: nothing, addEventListener: nothing, appendChild: nothing });
Object.assign(globalThis, { requestAnimationFrame: (f: () => void) => f(), document: { createElement: element },
  maplibregl: { Marker: class { setLngLat() { return this; } } } });

// ---- the modules tested, as far as these tests call them ----
/** A walk step as the code reads and writes it. */
interface Step {
  type: 'walk';
  final: boolean;
  lines: LngLat[][];
  walks?: { coords: LngLat[]; dirs?: { kind: string; text: string; coords: LngLat[] }[]; approxTo?: number | null; approxFrom?: number | null; approx?: boolean }[];
  kanteWalk?: boolean;
  t0: number | null;
  t1: number | null;
  min: number;
  from: null;
}
interface Feature { geometry: { type: string; coordinates: LngLat[] | LngLat }; properties: { kind: string; approx?: boolean } }
const load = (file: string) => import(new URL(file, APP).href);
const J: { setWalk(st: Step, leg: KanteWalk): void } = (await load('../engine-journey.ts')).KanteJourney;
const steps: { stepFeatures(steps: Step[]): Feature[] } = await load('journey-steps.ts');
const tracking: { snapToTrip(p: LngLat, ref: number, now: number): { i: number; kmIn: number; d: number } | null } = await load('tracking.ts');
const routing: { refineWalks(id: number): void; engineGuess?(st: Step): object | null } = await load('routing.ts');
const S: { journey: { steps: Step[]; req: number }; tracking: { geoVersion: number } } = await load('state.ts');

// ---- the leg: out of a building through no known door (0 → 1), along the paths (1 … 4), across a square (4 → 5) ----
const G: LngLat[] = [[7.4390, 46.9480], [7.4394, 46.9481], [7.4400, 46.9483], [7.4407, 46.9483], [7.4412, 46.9486], [7.4417, 46.9490]];
const leg = (extra?: Partial<KanteWalk>): KanteWalk => ({
  kind: 'egress', from: { name: 'Bern, Zytglogge', lat: G[0][1], lon: G[0][0] }, to: { name: 'Kornhausplatz', lat: G[5][1], lon: G[5][0] },
  dep: 1795000000, arr: 1795000300, durationS: 300, distanceM: 230, stairsUp: 0, stairsDown: 0, lifts: 0, escalators: 0, stepFree: true,
  geometry: G.map((c): LngLat => [c[0], c[1]]), levels: G.map(() => 0),
  steps: [{ kind: 'depart', text: 'Walk 60 m along Kramgasse', distM: 60, durS: 50, from: 0, to: 2 },
    { kind: 'walk', text: 'Turn left onto Kornhausplatz, then 110 m', distM: 110, durS: 90, from: 2, to: 5 },
    { kind: 'arrive', text: 'Arrive at Kornhausplatz', distM: 0, durS: 0, from: 5, to: 5 }],
  ...extra,
});
const step = (): Step => ({ type: 'walk', final: true, lines: [[G[0], G[5]]], t0: null, t1: null, min: 5, from: null });
// where GPS puts you: beside the guessed start, on the routed part, beside the guessed end, and where the paths end
const fixes: LngLat[] = [[7.4392, 46.94804], [7.4403, 46.94832], [7.4415, 46.94885], G[4]];
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
/** Everything these fields can change, as main's code paths make it of one leg. */
async function outputs(l: KanteWalk) {
  const st = step();
  J.setWalk(st, l);
  Object.assign(S.journey, { steps: [st], req: 1 });
  S.tracking.geoVersion++;
  const features = steps.stepFeatures([st]);
  const snaps = fixes.map((p) => { const s = tracking.snapToTrip(p, 0, Date.now())!; return { i: s.i, kmIn: r6(s.kmIn), d: r6(s.d) }; });
  // through a modelled station with no way through it: whether the pedestrian network is asked
  page.plan = { key: 'bern' };
  page.netAsked = 0;
  routing.refineWalks(1);
  await settle(); await settle();
  page.plan = null;
  const kept = st.walks && st.walks[0];
  return { kanteWalk: !!st.kanteWalk, lines: st.lines, walk: kept || null, dirs: kept ? kept.dirs : null, features, snaps, netAsked: page.netAsked, st };
}
const shown = (o: Awaited<ReturnType<typeof outputs>>) => { const { st, ...rest } = o; return rest; };

if (process.env.GOLDEN) {
  console.log(`{\n${Object.entries(shown(await outputs(leg()))).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}`);
  process.exit(0);
}
const MAIN = JSON.parse(fs.readFileSync(new URL('test_walkguess_main.json', import.meta.url), 'utf8'));
// the walk's lines as drawn: dashed (properties.approx: the map's route-walk-approx layer) or solid, and how many points each
const walkLines = (list: Feature[]) => list.filter((f) => f.properties.kind === 'walk').map((f) => [f.properties.approx ? 'dashed' : 'solid', f.geometry.coordinates.length]);

console.log('1. without approxStart / approxEnd (today\'s engine): exactly as main made it');
const plain = await outputs(leg());
{
  const o = JSON.parse(JSON.stringify(shown(plain))) as typeof MAIN; // as recorded
  check(isDeepStrictEqual(o.features, MAIN.features) && isDeepStrictEqual(walkLines(plain.features), [['solid', 6]]), 'the same lines and points drawn (all of the walk solid)');
  check(isDeepStrictEqual(o.dirs, MAIN.dirs), 'the same written directions');
  check(isDeepStrictEqual(o.snaps, MAIN.snaps), 'GPS snapped to the same places on the walk');
  check(o.kanteWalk === MAIN.kanteWalk && o.kanteWalk, 'the engine\'s walk is taken as routed');
  check(o.netAsked === MAIN.netAsked && o.netAsked === 0, 'in a modelled station without a way through, the engine\'s path is kept as it is');
  check(isDeepStrictEqual(o, MAIN), 'and nothing else differs');
  check(routing.engineGuess!(plain.st) === null, 'engineGuess(): none');
}

console.log('2. with them: the guessed stretches dashed, said as a guess, not tracked along, not taken as routed');
const guessed = await outputs(leg({ approxStart: 1, approxEnd: 4 }));
{
  const o = shown(guessed);
  check(isDeepStrictEqual(walkLines(o.features), [['dashed', 2], ['solid', 4], ['dashed', 2]]), 'drawn: points 0…1 dashed, 1…4 solid, 4…5 dashed');
  const dash = o.features.filter((f) => f.properties.kind === 'walk' && f.properties.approx).map((f) => f.geometry.coordinates);
  check(isDeepStrictEqual(dash, [G.slice(0, 2), G.slice(4)]), 'the dashed lines are exactly the guessed points');
  check(isDeepStrictEqual(o.features.filter((f) => f.properties.kind !== 'walk'), plain.features.filter((f) => f.properties.kind !== 'walk')), 'the rest drawn as before');
  const texts = o.dirs!.map((d) => d.text);
  check(texts.length === 4 && /^Walk about \d+ m where no way is mapped$/.test(texts[0]) && /^Then about \d+ m where no way is mapped$/.test(texts[3]),
    `said as a guess: "${texts[0]}" … "${texts[3]}"`);
  check(isDeepStrictEqual(texts.slice(1, 3), plain.dirs!.map((d) => d.text)), "the engine's own directions between them as before");
  check(o.dirs![0].kind === 'depart' && o.dirs![1].kind === 'walk' && isDeepStrictEqual(o.dirs![0].coords, G.slice(0, 2)) && isDeepStrictEqual(o.dirs![3].coords, G.slice(4)),
    'the guesses lead the list and end it, each over its own points');
  const [head, mid, tail, pathEnd] = o.snaps;
  check(head.kmIn === 0 && head.d === plain.snaps[0].d && plain.snaps[0].kmIn > 0, 'GPS beside the guessed start: as far from the line as before, but not moved along it');
  check(isDeepStrictEqual(mid, plain.snaps[1]), 'on the routed part: as before');
  check(isDeepStrictEqual(pathEnd, plain.snaps[3]), 'where the paths end: as before');
  check(tail.d === plain.snaps[2].d && tail.kmIn < plain.snaps[2].kmIn && tail.kmIn === pathEnd.kmIn, 'beside the guessed end: as far from the line as before, and no further along it than where the paths end');
  check(o.kanteWalk, "the engine's path is drawn (its routed part)");
  check(routing.engineGuess!(guessed.st) === guessed.st.walks![0], 'engineGuess(): the guessed ends are known as such');
  check(o.netAsked === 1, 'in a modelled station without a way through, the pedestrian network is asked instead of keeping the path as routed');
}

console.log('3. the guesses meet (none of it routed): all of it dashed, said as one guess');
{
  const o = shown(await outputs(leg({ approxStart: 5 })));
  check(isDeepStrictEqual(walkLines(o.features), [['dashed', 6]]), 'drawn dashed all the way');
  check(/^Walk about \d+ m where no way is mapped$/.test(o.dirs![0].text) && o.dirs!.length === 3, 'one guess said, then the engine\'s directions');
  check(o.snaps.every((s) => s.kmIn === 0), 'GPS does not move you along it');
}
{
  const o = shown(await outputs(leg({ approxStart: 0, approxEnd: 5 })));
  check(isDeepStrictEqual(o, shown(plain)), 'approxStart 0 / approxEnd at the last point (nothing guessed): as without them');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
