// Tests for how a journey's walks are routed again while it is open (src/app/70-routing.ts, requay() in
// src/engine-journey.ts): answers that arrive late, after the walk has moved, been cancelled or changed platform,
// are dropped. The sources are transpiled as they are; the routers are stubbed with promises the test settles.
// Offline; exit code 1 on any failure.
//
//   node tools/test_walkrefine.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'amaro';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const js = (f) => transformSync(fs.readFileSync(path.join(ROOT, f), 'utf8'), { mode: 'strip-only' }).code; // as scripts/build.mts does
const ROUTING = js('src/app/70-routing.ts'), ENGINE = js('src/engine-journey.ts');
let passed = 0, failed = 0;
const check = (ok, what) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };
const defer = () => { let res; const p = new Promise((r) => (res = r)); return { p, res }; };
const settle = () => new Promise((r) => setTimeout(r, 0));

// the app around the routing code: routeWalk() and stationWalk() hand back promises kept in `pending` / `station`
function app() {
  const c = { journeySteps: [], journeyReq: 1, routeKey: '', geoVersion: 0, journeyConn: null, journeyOptions: null, journeyQuery: {},
    SETTINGS: { prefs: () => ({ walkKmh: 3.6 }) }, sheets: 0, timed: 0, pending: [], station: [], plan: null, console, Date, Math, JSON, Map, Promise };
  Object.assign(c, {
    requestAnimationFrame: (f) => f(), updateProgress() {}, queueSheet(t) { c.sheets++; if (t) c.timed++; },
    platformOf: (s) => (s.prognosis && s.prognosis.platform) || s.platform || '–', s3Plan: () => c.plan,
    connStart: () => 0, connEnd: () => 0,
  });
  vm.createContext(c);
  vm.runInContext(ROUTING, c);
  c.routeWalk = (a, b) => { const d = defer(); c.pending.push({ a, b, d }); return d.p; };
  c.stationWalk = () => { const d = defer(); c.station.push(d); return d.p; };
  c.netWalkFits = () => true;
  return c;
}
const A = [7.43, 46.94], B = [7.44, 46.95], C = [7.45, 46.96];
const net = (cs) => ({ net: true, coords: cs, dist: 100 });
const stop = (platform) => ({ platform, station: { id: 8507000 } });

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
  const c = app(), st = { type: 'walk', lines: [[A, B]], next: { departure: stop('1') }, from: null };
  c.plan = { key: 'bern' };
  c.journeySteps.push(st);
  c.refineWalks(1);
  st.next.departure.prognosis = { platform: '2' }; // Gleis 1 → Gleis 2, the same coordinates
  c.refineWalks(1, true);
  check(c.station.length === 2, 'the walk is routed again to the new platform');
  c.station[1].res({ lines: [[A, [7.44, 46.951], B]], walks: [{ to: '2' }], floors: null }); await settle();
  c.station[0].res({ lines: [[A, [7.44, 46.949], B]], walks: [{ to: '1' }], floors: null }); await settle();
  check(st.walks[0].to === '2', "the first answer (to Gleis 1) arrives late and is dropped");
  c.refineWalks(1, true);
  check(c.station.length === 2, 'and it is not routed again while nothing changes');
  st.next.departure.prognosis = { platform: '3' }; // changed again, after its route was drawn
  c.refineWalks(1, true);
  check(c.station.length === 3, 'a routed walk is routed again when only the platform changes');
}
{
  // requay(): the engine moves the boarding edge to another platform at the very same point
  const w = { KANTE: undefined, SETTINGS: { prefs: () => ({}) } };
  const c = { window: w, console, Date, Math, JSON, Map, Set, Promise };
  vm.createContext(c);
  vm.runInContext(ENGINE, c);
  const quay = (label) => ({ lon: B[0], lat: B[1], precision: 'edge', label, level: 0 });
  const dep = { kante: { quay: quay('1') } }, arr = { kante: { quay: { lon: C[0], lat: C[1], precision: 'edge', label: '5', level: 0 } } };
  const edge = (ref, ll) => ({ ll, edge: { ref, bearing: null, level: 0, ll, side: '' }, travel: null });
  const walk = { type: 'walk', lines: [[A, B]] };
  const ride = { type: 'ride', s: { departure: dep, arrival: arr }, depLL: B, arrLL: C, depAt: edge('1', B), arrAt: edge('5', C), stops: [B, C], path: [B, C] };
  const steps = [walk, ride, { type: 'arrive' }];
  let changed = 0;
  w.KanteJourney.requay(steps, () => changed++);
  check(changed === 0, 'requay(): nothing changed, nothing to do');
  dep.kante.quay = quay('2');
  w.KanteJourney.requay(steps, () => changed++);
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
