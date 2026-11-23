// The pages of journeys as the app asks for them (KanteJourney.plans() and more() in src/engine-journey.ts, as
// they are), with the engine stubbed: a journey the engine adds to the first page (the one that arrives first,
// kante/engine/crates/server/src/plan.rs, page()) and returns again on the earlier page is shown once, and the
// earlier page adds what it has. Offline; exit code 1 on any failure.
//
//   node --experimental-test-module-mocks tools/test_pages.mts
import { mock } from 'node:test';

let passed = 0, failed = 0;
const check = (ok: boolean, what: string) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };

const SRC = new URL('../src/', import.meta.url);
// The module's exports go in as `exports` from Node 24.15 and 25.9 on, as `namedExports` before
const [major, minor] = process.versions.node.split('.').map(Number);
const hasExports = major > 25 || (major === 25 && minor >= 9) || (major === 24 && minor >= 15);
const fake = (file: string, exports: Record<string, unknown>) => mock.module(new URL(file, SRC).href,
  (hasExports ? { exports } : { namedExports: exports }) as Parameters<typeof mock.module>[1]);

// A journey of the engine: one ride from A to B, leaving and arriving at these times (unix seconds), with changes
const D = 1795503600; // Tue 24 Nov 2026 08:00 in Zürich
const journey = (dep: number, arr: number, transfers: number, trip = `t${dep}`) => ({
  id: `${dep}-${arr}-${transfers}`, dep, arr, durationS: arr - dep, transfers, walkS: 0, walkM: 0,
  legs: [{ type: 'ride', line: { name: 'S1', mode: 'train' }, headsign: 'B', tripId: trip, serviceDate: '2026-11-24',
    from: { name: 'A', dep, seq: 1 }, to: { name: 'B', arr, seq: 2 }, intermediate: [], geometry: [] }],
});
// leaving at 07:50: 08:00–11:00 with two changes (arrives first), 08:00:30–11:30 with one, 10:30–11:45 direct
const X = journey(D, D + 3 * 3600, 2), Y = journey(D + 30, D + 3.5 * 3600, 1), Z = journey(D + 2.5 * 3600, D + 3.75 * 3600, 0);
// what the engine answers: main's pages (from the direct one, ±60 s) and on the first page also the one arriving first
let pages: Record<string, object> = {
  first: { journeys: [X, Z], earlier: `e:${Z.dep - 60}`, later: `l:${Z.dep + 60}` },
  [`e:${Z.dep - 60}`]: { journeys: [X, Y], earlier: `e:${X.dep - 60}`, later: `l:${Y.dep + 60}` },
};
const asked: string[] = [];
fake('engine.ts', { KANTE: { plan: async (body: { page?: string }) => { asked.push(body.page || 'first'); return pages[body.page || 'first']; }, failure: () => 'down', available: () => true } });
fake('settings.ts', { SETTINGS: { prefs: () => ({ walkKmh: 4.7, extraChangeMin: 0, maxWalkMin: 20, modes: [] }), transportations: () => [] } });

const { KanteJourney } = await import(new URL('engine-journey.ts', SRC).href);
const o = await KanteJourney.plans([7.44, 46.95], { lngLat: [7.45, 46.96] }, null);
const ids = (list: { id: string }[]) => list.map((j) => j.id);
console.log('first page');
check(JSON.stringify(ids(o.list)) === JSON.stringify([X.id, Z.id]), `the direct one and the one arriving first: ${ids(o.list)}`);
check(o.earlier && o.later, 'both directions offered');
console.log('earlier');
await KanteJourney.more(o, 'earlier');
check(asked[1] === `e:${Z.dep - 60}`, `asked with main's cursor: ${asked[1]}`);
check(JSON.stringify(ids(o.list)) === JSON.stringify([X.id, Y.id, Z.id]), `the one returned again is shown once, the other added: ${ids(o.list)}`);


// A live update between the pages: the added journey leaves and arrives 30 s later when Earlier returns it, so its
// id is another; it makes the same rides, so it replaces the one in the list. (A second direct one at 10:45.)
console.log('earlier, after a live delay of the journey added back');
const Z2 = journey(D + 2.75 * 3600, D + 4 * 3600, 0);
const X2 = journey(X.dep + 30, X.arr + 30, 2, X.legs[0].tripId);
pages = {
  first: { journeys: [X, Z, Z2], earlier: `e:${Z.dep - 60}`, later: `l:${Z2.dep + 60}` },
  [`e:${Z.dep - 60}`]: { journeys: [X2, Y], earlier: `e:${X2.dep - 60}`, later: `l:${Y.dep + 60}` },
};
const o2 = await KanteJourney.plans([7.44, 46.95], { lngLat: [7.45, 46.96] }, null);
await KanteJourney.more(o2, 'earlier');
const rows = o2.list.map((j: { dep: number; arr: number }) => `${j.dep - D}-${j.arr - D}`);
check(JSON.stringify(ids(o2.list)) === JSON.stringify([X2.id, Y.id, Z.id, Z2.id]), `the delayed one replaces it, shown once: ${rows}`);
check(!o2.list.some((j: { id: string }) => j.id === X.id), 'the one before the delay is gone');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
