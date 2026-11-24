// Tests for src/train-formation.ts (reading the Train Formation Service's answer, where to get on) and
// src/train-layout.ts (the coaches laid along a platform of a real station model). Run: node tools/test_train_formation.mts
// The formation answers are made up in the shape of formations_full v2 (its OpenAPI description, openTdataCH).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { coachesFor, evuOf, parseFormation, sectorList } from '../src/train-formation.ts';
import type { FormationAnswer, TrainCoach } from '../src/train-formation.ts';
import { layoutTrain } from '../src/train-layout.ts';

declare global {
  var window: typeof globalThis;
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;
const loadModel = (key: string) => {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'stations3d', key + '.js'), 'utf8'), { filename: key + '.js' });
  return window.STATION3D![key];
};

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); }
}
function assert(cond: unknown, msg?: string): asserts cond { if (!cond) throw new Error(msg || 'assertion failed'); }
const eq = (a: unknown, b: unknown, msg?: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg || ''} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// ---------------------------------------------------------------- reading
test('sectorList', () => {
  eq(sectorList('A-D'), ['A', 'B', 'C', 'D']);
  eq(sectorList('AB'), ['A', 'B']);
  eq(sectorList('A,B'), ['A', 'B']);
  eq(sectorList('c–e'), ['C', 'D', 'E']);
  eq(sectorList('N/A'), []);
  eq(sectorList(''), []);
});
test('evuOf: the timetable\'s operator names', () => {
  eq(evuOf('Schweizerische Bundesbahnen SBB'), 'SBBP');
  eq(evuOf('SBB'), 'SBBP');
  eq(evuOf('BLS AG (bls)'), 'BLSP');
  eq(evuOf('Schweizerische Südostbahn (sob)'), 'SOB');
  eq(evuOf('THURBO'), 'THURBO');
  eq(evuOf('Rhätische Bahn'), 'RhB');
  eq(evuOf('Zentralbahn'), 'ZB');
  eq(evuOf('Regionalverkehr Bern-Solothurn'), null);
  eq(evuOf(''), null);
});

const BERN = { uic: 8507000, name: 'Bern' }, OLTEN = { uic: 8500218, name: 'Olten' };
type V = NonNullable<NonNullable<FormationAnswer['formations']>[number]['formationVehicles']>[number];
const veh = (position: number, sectors: string, props: NonNullable<V['vehicleProperties']>, type = 'IC2000', more: Partial<V> = {}): V => ({
  position, number: position, vehicleIdentifier: { typeCodeName: type, evn: 'x' + position },
  formationVehicleAtScheduledStops: [{ stopPoint: BERN, sectors }, { stopPoint: OLTEN, sectors: 'N/A' }],
  vehicleProperties: props, ...more,
});
const ANSWER: FormationAnswer = {
  formationsAtScheduledStops: [{
    scheduledStop: { stopPoint: BERN },
    formationShort: { vehicleGoals: [
      { fromVehicleAtPosition: 1, toVehicleAtPosition: 3, destinationStopPoint: { uic: 8500218, name: 'Olten' } },
      { fromVehicleAtPosition: 4, toVehicleAtPosition: 6, destinationStopPoint: { uic: 8500010, name: 'Basel SBB' } },
    ] },
  }],
  formations: [{
    formationVehicles: [
      veh(2, 'A,B', { number1class: 60, length: 26.8 }),
      veh(1, 'A', { length: 18.5 }, 'Re460'),
      veh(3, 'B', { number2class: 30, numberRestaurantSpace: 40 }),
      veh(4, 'C', { number2class: 110, pictoProperties: { wheelchairPicto: true } }),
      veh(5, 'C', { number2class: 110, closed: true }),
      veh(6, 'D', { number1class: 20, number2class: 80, trolleyStatus: 'Deklassiert', pictoProperties: { bikePicto: true } }),
    ],
  }, {
    // the same coaches again further on (a formation per part of the journey), and one that is not at Bern
    formationVehicles: [veh(4, 'C', { number2class: 110 }), { position: 7, vehicleIdentifier: { evn: 'x7' }, formationVehicleAtScheduledStops: [{ stopPoint: OLTEN, sectors: 'A' }] }],
  }],
};
test('parseFormation: the coaches at the stop, in order, once', () => {
  const cs = parseFormation(ANSWER, '8507000')!;
  eq(cs.map((c) => c.pos), [1, 2, 3, 4, 5, 6]);
  eq(cs.map((c) => c.kind), ['loco', 'coach', 'restaurant', 'coach', 'coach', 'coach']);
  eq(cs.map((c) => c.cls), [null, 1, 2, 2, 2, 12]);
  eq(cs[1].sectors, ['A', 'B']);
  eq(cs[0].len, 18.5);
  assert(cs[4].closed && !cs[3].closed, 'closed');
  assert(cs[5].declassed && cs[5].bike && cs[3].wheelchair, 'status and pictograms');
  eq(cs.map((c) => c.goesTo), ['Olten', 'Olten', 'Olten', 'Basel SBB', 'Basel SBB', 'Basel SBB']);
});
test('parseFormation: where the train turns or leaves coaches, the coaches leaving', () => {
  const at = (sectors: string, from: number, to: number) => ({ formationVehicleAtScheduledStops: [{ stopPoint: BERN, sectors }],
    vehicleProperties: { number2class: 100, fromStop: { uic: from }, toStop: { uic: to } } });
  const turn: FormationAnswer = { formations: [
    // arriving: 1 2 3 (3 stays here); leaving: the same two coaches the other way round, as 1 2
    { formationVehicles: [{ position: 1, vehicleIdentifier: { evn: 'a' }, ...at('A', 8500218, 8507000) }, { position: 2, vehicleIdentifier: { evn: 'b' }, ...at('B', 8500218, 8507000) }, { position: 3, vehicleIdentifier: { evn: 'c' }, ...at('C', 8500218, 8507000) }] },
    { formationVehicles: [{ position: 1, vehicleIdentifier: { evn: 'b' }, ...at('B', 8507000, 8500010) }, { position: 2, vehicleIdentifier: { evn: 'a' }, ...at('A', 8507000, 8500010) }] },
  ] };
  const cs = parseFormation(turn, 8507000)!;
  eq(cs.map((c) => c.pos + c.sectors.join('')), ['1B', '2A']);
  // where you get off: the coaches arriving, the one left here (c) among them
  const arr = parseFormation(turn, 8507000, null, true)!;
  eq(arr.map((c) => c.pos + c.sectors.join('')), ['1A', '2B', '3C']);
});
test('evuOf: ÖBB is not SBB; sectorList: reversed and unsorted', () => {
  eq(evuOf('Österreichische Bundesbahnen'), 'OeBB');
  eq(evuOf('ÖBB'), 'OeBB');
  eq(sectorList('D-A'), ['A', 'B', 'C', 'D']);
  eq(sectorList('BA'), ['A', 'B']);
});
test('parseFormation: nothing for a stop it has not, or no answer', () => {
  eq(parseFormation(ANSWER, '8503000'), null);
  eq(parseFormation(null, '8507000'), null);
  eq(parseFormation({} as FormationAnswer, '8507000'), null);
});
// one train, split: positions 1–3 go to Olten, 4–6 to Basel; where each part stops is in the per-stop list
const SPLIT: FormationAnswer = JSON.parse(JSON.stringify(ANSWER));
for (const v of SPLIT.formations![0].formationVehicles!) {
  if ((v.position || 0) >= 4) v.formationVehicleAtScheduledStops!.push({ stopPoint: { uic: 8500010, name: 'Basel SBB' }, sectors: 'N/A' });
}
const pos = (cs: TrainCoach[], r: { picks: number[] }) => r.picks.map((i) => cs[i].pos);
test('coachesFor: your class, open, a wheelchair space when needed', () => {
  const cs = parseFormation(ANSWER, 8507000)!.map((c) => ({ ...c, goesTo: null }));
  eq(pos(cs, coachesFor(cs, 1, false)), [2, 6]);
  eq(pos(cs, coachesFor(cs, 2, false)), [4, 6]);       // 5 is closed, the restaurant is not a seat
  eq(pos(cs, coachesFor(cs, 2, true)), [4]);
});
test('coachesFor: nothing when your class or a wheelchair space cannot be had', () => {
  const cs = parseFormation(ANSWER, 8507000)!.map((c) => ({ ...c, goesTo: null }));
  const only2 = cs.filter((c) => c.cls === 2 && c.kind === 'coach');
  eq(coachesFor(only2, 1, false), { picks: [], missing: 'class' });
  eq(coachesFor(cs, 1, true), { picks: [], missing: 'wheelchair' });   // no 1st class coach has wheelchair spaces
});
test('coachesFor: a train that splits — the part that stops where you get off', () => {
  const toBasel = parseFormation(SPLIT, 8507000, 8500010)!;
  eq(toBasel.map((c) => c.reaches), [false, false, false, true, true, true]);
  eq(pos(toBasel, coachesFor(toBasel, 2, false)), [4, 6]);
  eq(pos(toBasel, coachesFor(toBasel, 1, false)), [6]);
  // Olten is in every coach's list (all of them stop there): the whole train is a candidate
  const toOlten = parseFormation(SPLIT, 8507000, 8500218)!;
  eq(pos(toOlten, coachesFor(toOlten, 1, false)), [2, 6]);
  // a stop the formation does not list for any coach: not known, and the train splits: nothing recommended
  const unknown = parseFormation(SPLIT, 8507000, 8503000)!;
  assert(unknown.every((c) => c.reaches === null), 'not known');
  eq(coachesFor(unknown, 2, false), { picks: [], missing: 'portion' });
});

// ---------------------------------------------------------------- laying it out
const coach = (pos: number, sectors: string[], kind: TrainCoach['kind'] = 'coach', len = 26.8): TrainCoach => ({
  pos, number: pos, sectors, cls: kind === 'coach' ? 2 : null, kind, len, closed: false, declassed: false,
  wheelchair: false, bike: false, stroller: false, family: false, business: false, lowFloor: false, goesTo: null, reaches: null, id: "c" + pos,
});
const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);
for (const [key, ref] of [['bern', '7'], ['zurich', '3'], ['basel', '1'], ['wankdorf', '1']] as const) {
  const model = loadModel(key);
  const names = [...new Set(model.sectors!.filter((s) => s.ref === ref).map((s) => s.name))].sort();
  test(`layoutTrain ${key} ${ref}: end to end, in their sectors, on the track`, () => {
    const cs = [coach(1, [names[0]], 'loco', 18.5), coach(2, [names[0]]), coach(3, [names[1]]), coach(4, [names[1]]), coach(5, [names[2]]), coach(6, [names[2]])];
    const L = layoutTrain(model, ref, { coaches: cs, sectors: [] })!;
    assert(L && !L.guessed, 'laid out on a track');
    eq(L.cars.length, cs.length);
    // end to end, each at its length
    for (let i = 0; i + 1 < L.cars.length; i++) assert(Math.abs(L.cars[i].s1 - L.cars[i + 1].s0) < 0.01, 'no gaps');
    for (const c of L.cars) assert(Math.abs(c.s1 - c.s0 - c.coach!.len) < 0.01, 'length');
    // the formation's order along the platform, either way round
    const order = L.cars.map((c) => c.coach!.pos);
    assert(JSON.stringify(order) === '[1,2,3,4,5,6]' || JSON.stringify(order) === '[6,5,4,3,2,1]', 'order ' + order);
    // each coach's middle within half a sector or so of its sector
    for (const c of L.cars) {
      const sec = L.sectors.find((s) => s.name === c.coach!.sectors[0])!, m = (c.s0 + c.s1) / 2;
      const lo = Math.min(sec.s0, sec.s1), hi = Math.max(sec.s0, sec.s1), slack = (hi - lo) / 2 + 15;
      assert(m > lo - slack && m < hi + slack, `coach ${c.coach!.pos} at ${m.toFixed(0)}, sector ${sec.name} ${lo.toFixed(0)}–${hi.toFixed(0)}`);
    }
    // on a track: a few metres from the platform's sector line, and the platform side is a unit vector
    const sm = L.sectors[0];
    assert(dist(L.at((sm.s0 + sm.s1) / 2), sm.mid) < 0.01, 'at() is the track point');
    assert(Math.abs(Math.hypot(L.side[0], L.side[1]) - 1) < 1e-6, 'side is a unit vector');
    // driving ends: the loco both, the far end coach one
    const loco = L.cars.find((c) => c.coach!.kind === 'loco')!;
    assert(loco.noseA && loco.noseB, 'loco has two cabs');
    const ends = [L.cars[0], L.cars[L.cars.length - 1]].filter((c) => c !== loco);
    assert(ends.every((c) => c.noseA || c.noseB), 'the other end has a cab');
  });
  test(`layoutTrain ${key} ${ref}: from the timetable's sectors alone`, () => {
    const L = layoutTrain(model, ref, { coaches: null, sectors: names.slice(0, 2) })!;
    const a = L.sectors.find((s) => s.name === names[0])!, b = L.sectors.find((s) => s.name === names[1])!;
    const lo = Math.min(a.s0, a.s1, b.s0, b.s1), hi = Math.max(a.s0, a.s1, b.s0, b.s1);
    assert(L.cars.length >= 2, 'some coaches');
    assert(Math.abs(L.cars[0].s0 - lo) < 0.01 && Math.abs(L.cars[L.cars.length - 1].s1 - hi) < 0.01, 'they fill the sectors');
    assert(L.cars.every((c) => c.coach === null && c.idx === -1), 'no coach data');
  });
}
test('layoutTrain: the end sectors reach the ends (sector points only), coaches keep their length everywhere', () => {
  for (const key of ['zurich', 'basel', 'luzern', 'lausanne', 'geneve', 'bern', 'wankdorf']) {
    const model = loadModel(key);
    for (const ref of [...new Set(model.sectors!.map((s) => s.ref))]) {
      const names = [...new Set(model.sectors!.filter((s) => s.ref === ref).map((s) => s.name))].sort();
      const cs = Array.from({ length: 12 }, (_, i) => coach(i + 1, [names[Math.min(names.length - 1, Math.floor(i * names.length / 12))]]));
      const L = layoutTrain(model, ref, { coaches: cs, sectors: [] });
      if (!L) continue;
      const lo = Math.min(...L.sectors.map((s) => Math.min(s.s0, s.s1)));
      assert(Math.abs(lo) < 0.01, `${key} ${ref}: the first sector starts at the edge's start (${lo.toFixed(1)})`);
      for (const c of L.cars) assert(Math.abs(dist(c.a, c.b) - 26.8) < 3, `${key} ${ref}: coach ${c.coach!.pos} drawn ${dist(c.a, c.b).toFixed(1)} m long`);
    }
  }
});
test('layoutTrain: a platform without sectors in the model', () => {
  const model = loadModel('bern');
  eq(layoutTrain(model, '999', { coaches: null, sectors: ['A'] }), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
