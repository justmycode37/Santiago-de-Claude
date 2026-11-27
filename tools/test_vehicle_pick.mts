// Tests for finding a line typed into the search among the live vehicles (src/vehicle-pick.ts): which queries are a
// line, which lines they match, how the lines are grouped and which vehicle is nearest. Offline; exit code 1 on any
// failure.
//
//   node tools/test_vehicle_pick.mts
import { groupLines, legNow, lineMatches, lineQuery, nearestVehicle, tripPoint } from '../src/vehicle-pick.ts';

let passed = 0, failed = 0;
const check = (ok: boolean, what: string) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log('queries that are a line');
const Q: [string, unknown][] = [
  ['9', { mode: null, cat: '', num: '9' }],
  ['Tram 9', { mode: 'tram', cat: '', num: '9' }],
  ['tram9', { mode: 'tram', cat: '', num: '9' }],
  ['Bus 12', { mode: 'bus', cat: '', num: '12' }],
  ['bus12', { mode: 'bus', cat: '', num: '12' }],
  ['S1', { mode: null, cat: 's', num: '1' }],
  ['s 1', { mode: null, cat: 's', num: '1' }],
  ['IC 8', { mode: null, cat: 'ic', num: '8' }],
  ['IC8', { mode: null, cat: 'ic', num: '8' }],
  ['T9', { mode: 'tram', cat: '', num: '9' }],
  ['Linie 10', { mode: null, cat: '', num: '10' }],
  ['linie10', { mode: null, cat: '', num: '10' }],
  ['N1', { mode: null, cat: 'n', num: '1' }],
  ['Bus N1', { mode: 'bus', cat: 'n', num: '1' }],
  ['S-Bahn 3', { mode: 'rail', cat: '', num: '3' }],
  ['Tram 09', { mode: 'tram', cat: '', num: '9' }],
  ['Kramgasse 9', null],
  ['3011', null],
  ['Bern', null],
  ['Bahnhofstrasse 12', null],
  ['', null],
];
for (const [text, want] of Q) check(same(lineQuery(text), want), `"${text}" → ${JSON.stringify(want)}`);

console.log('which lines a query matches');
const L = (name: string, category: string, mode: KanteMode, operator = 'X'): KanteLine => ({ name, category, mode, operator });
const tram9 = L('9', 'T', 'tram'), bus9 = L('9', 'B', 'bus'), s9 = L('S9', 'S', 'rail'), ic8 = L('IC8', 'IC', 'rail');
const s1 = L('S1', 'S', 'rail'), n1 = L('N1', 'B', 'bus'), bus12 = L('12', 'B', 'bus'), ir9 = L('IR9', 'IR', 'rail');
const q = (t: string) => lineQuery(t)!;
check(lineMatches(q('9'), tram9) && lineMatches(q('9'), bus9), '"9" is tram 9 and bus 9');
check(!lineMatches(q('9'), s9) && !lineMatches(q('9'), ir9), '"9" is not S9 or IR 9');
check(lineMatches(q('Tram 9'), tram9) && !lineMatches(q('Tram 9'), bus9), '"Tram 9" is only the tram');
check(lineMatches(q('Bus 12'), bus12) && !lineMatches(q('Tram 12'), bus12), '"Bus 12" is the bus, "Tram 12" is not');
check(lineMatches(q('S1'), s1) && !lineMatches(q('S1'), s9), '"S1" is S1, not S9');
check(lineMatches(q('IC 8'), ic8) && lineMatches(q('ic8'), ic8) && !lineMatches(q('IR 8'), ic8), '"IC 8" is IC 8, "IR 8" is not');
check(lineMatches(q('N1'), n1) && !lineMatches(q('1'), n1), '"N1" is the night bus N1; "1" is not');
check(!lineMatches(q('1'), L('N1', 'N', 'bus')), '"1" is not N1 with the category N either');
check(lineMatches(q('Zug 9'), s9), '"Zug 9" is the train numbered 9');

console.log('grouped by line, nearest first');
const V = (line: KanteLine, at: LngLat, headsign: string, to: LngLat = at, tripId = Math.random().toString(36)): KanteVehicle => ({
  tripId, serviceDate: '2026-11-27', line, headsign, from: at, to, dep: 0, arr: 0, nextStop: '', nextSeq: 2, live: 'observed',
  frac: 0, basis: 'forecast', liveInfo: { state: 'observed' }, point: at });
const here: LngLat = [7.44, 46.95];
const bern9a = V(tram9, [7.445, 46.95], 'Wabern'), bern9b = V(tram9, [7.46, 46.95], 'Wankdorf'), bern9c = V(tram9, [7.43, 46.94], 'Wabern');
const zurich9 = V(L('9', 'T', 'tram', 'VBZ'), [8.54, 47.37], 'Triemli');
const bus9v = V(bus9, [7.441, 46.951], 'Bümpliz');
const groups = groupLines(q('9'), [bern9a, bern9b, bern9c, zurich9, bus9v, V(s9, [7.44, 46.95], 'Biel')], here);
check(groups.length === 3, `three lines: bus 9, tram 9 (Bern), tram 9 (Zurich) — got ${groups.length}`);
check(groups[0].line === bus9 && groups[1].line === tram9, 'nearest line first');
check(same(groups[1].headsigns, ['Wabern', 'Wankdorf']), 'its directions, the commonest first');
check(groups[1].vehicles[0] === bern9a && groups[1].vehicles.length === 3, 'its vehicles nearest first');

console.log('the vehicle to follow first');
const away = V(tram9, [7.442, 46.95], 'Wabern', [7.45, 46.95]); // nearest, but driving away from you
const coming = V(tram9, [7.43, 46.95], 'Wankdorf', [7.435, 46.95]); // further, next stop nearer to you
const pick = nearestVehicle([away, coming], here, true);
check(pick?.v === coming && pick.coming, 'with your position: the nearest coming towards you');
const pick2 = nearestVehicle([away, coming], here, false);
check(pick2?.v === away && !pick2.coming, 'without it: the nearest to the map centre, not said to be coming');
check(nearestVehicle([], here, true) === null, 'none: none');
const standing = { ...V(tram9, [7.436, 46.95], 'Wankdorf'), onward: { nextSeq: 3, to: [7.438, 46.95] as LngLat, dep: 0, arr: 0 } };
check(nearestVehicle([away, standing], here, true)?.v === standing, 'standing at a stop: coming by the stop it leaves for next');

console.log('where a trip\'s vehicle is by its /api/trip answer');
{
  const call = (seq: number, lon: number): KanteStopCall => ({ seq, quay: { lon, lat: 46.95 } as KanteQuay });
  // three stops 0.01° apart; the way bends north between the first two
  const trip = { calls: [call(1, 7.40), call(2, 7.41), call(3, 7.42)],
    path: [[7.40, 46.95], [7.405, 46.96], [7.41, 46.95], [7.42, 46.95]] as LngLat[], pathAt: [0, 2, 3] };
  const near = (a: LngLat | null, b: LngLat) => !!a && Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
  check(near(tripPoint(trip, { state: 'at', seq: 2, frac: 0 }), [7.41, 46.95]), 'standing at a stop: at its point of the way');
  check(near(tripPoint(trip, { state: 'between', seq: 1, nextSeq: 2, frac: 0.5 }), [7.405, 46.96]), 'half way: on the bend of the way, not the straight line');
  check(near(tripPoint({ calls: trip.calls }, { state: 'between', seq: 2, nextSeq: 3, frac: 0.25 }), [7.4125, 46.95]), 'without a way: on the straight line');
  check(tripPoint(trip, { state: 'before-start', seq: 1, frac: 0 }) === null && tripPoint(trip, null) === null, 'not under way: nowhere');
}
console.log('which leg of a ride runs now');
check(legNow([null, 2000, 5000], 1000) === 0 && legNow([null, 2000, 5000], 3000) === 1 && legNow([null, 2000, 5000], 6000) === 2, 'the last leg that has left');
check(legNow([null, null], 9e9) === 0, 'times not known: the first');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
