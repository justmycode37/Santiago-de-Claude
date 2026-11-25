// Tests for src/coach-plan.ts (the coach chosen for a whole ride), the router's door endpoint ({ stop: { at } }) and
// src/train-layout.ts's trams and buses (layoutAtStop). Run: node tools/test_coach_plan.mts
// The formation answer is made up in the shape of formations_full v2 and handed to the code as a data: URL in place
// of the engine, so nothing goes over the network; the station models are the real ones (stations3d/).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { StationRoute as SR } from '../src/station-route.ts';
import { doorsOf, pickCoach, planCoach } from '../src/coach-plan.ts';
import { layoutAtStop, layoutTrain } from '../src/train-layout.ts';
import type { FormationAnswer, Station3DTrain, TrainEngine } from '../src/train-formation.ts';

declare global {
  var window: typeof globalThis;
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;
const models: Record<string, StationModel> = {};
const loadModel = (key: string) => {
  if (!models[key]) {
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'stations3d', key + '.js'), 'utf8'), { filename: key + '.js' });
    models[key] = window.STATION3D![key];
  }
  return models[key];
};

let passed = 0, failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); }
}
function assert(cond: unknown, msg?: string): asserts cond { if (!cond) throw new Error(msg || 'assertion failed'); }
const eq = (a: unknown, b: unknown, msg?: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg || ''} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

await test('pickCoach: the shortest walk in plus out; a side with no way rules a coach out', () => {
  eq(pickCoach([{ id: 'a', inS: 100, outS: 50 }, { id: 'b', inS: 60, outS: 60 }, { id: 'c', inS: 30, outS: 200 }]), 'b');
  eq(pickCoach([{ id: 'a', inS: 100, outS: null }, { id: 'b', inS: 60, outS: null }]), 'b');           // only the walk in
  eq(pickCoach([{ id: 'a', inS: 10, outS: Infinity }, { id: 'b', inS: 60, outS: 60 }]), 'b');
  eq(pickCoach([{ id: 'a', inS: Infinity, outS: 1 }]), null);
  eq(pickCoach([{ id: 'a', inS: 50, outS: 50 }, { id: 'b', inS: 40, outS: 60 }]), 'b');                 // a tie: the shorter walk in
});

// ---------------------------------------------------------------- the router's door endpoint
await test('router: { stop: { at } } aims at the door on that platform, else at its sector', () => {
  const m = loadModel('bern');
  const L = layoutTrain(m, '7', { coaches: null, sectors: ['C', 'D', 'E'] })!;
  const stop = m.stops!.find((s) => s.mode === 'train' && s.ref === '7')!;
  let at = 0, n = 0;
  for (const c of L.cars) {
    const p = L.at((c.s0 + c.s1) / 2), xy: XY = [p[0] + L.side[0] * 2.6, p[1] + L.side[1] * 2.6];
    const r = SR.route(m, { entrance: 'Bahnhofplatz (main hall)' }, { stop: { uic: stop.uic, ref: '7', at: xy } }, {})!;
    n++;
    if (r.toAt) { at++; assert(dist(r.points[r.points.length - 1] as unknown as XY, xy) < 9, 'the way ends near the door'); }
  }
  assert(at === n, `${at} of ${n} doors aimed at`);
  // a point far from the platform: not this platform's, so the sector (here given) is aimed at instead
  const r2 = SR.route(m, { entrance: 'Bahnhofplatz (main hall)' }, { stop: { uic: stop.uic, ref: '7', at: [0, 0], sector: 'D' } }, {})!;
  assert(!r2.toAt && r2.toSectors && r2.toSectors[0] === 'D', 'falls back to the sector');
});

// ---------------------------------------------------------------- a whole ride, Bern → Zürich HB
const BERN = 8507000, ZH = 8503000;
const secsOf = (m: StationModel, ref: string) => [...new Set(m.sectors!.filter((s) => s.ref === ref).map((s) => s.name))].sort();
const bern = loadModel('bern'), zurich = loadModel('zurich');
const sB = secsOf(bern, '7'), sZ = secsOf(zurich, '7');
// ten vehicles; at Bern they run A→, at Zürich the train stands the other way round
const veh = (i: number) => ({
  position: i + 1, number: i === 0 ? 0 : i + 1, vehicleIdentifier: { evn: 'v' + i, typeCodeName: i === 0 ? 'Re460' : 'IC2000' },
  formationVehicleAtScheduledStops: [
    { stopPoint: { uic: BERN }, sectors: sB[Math.min(sB.length - 1, Math.floor(i * sB.length / 10))] },
    { stopPoint: { uic: ZH }, sectors: sZ[Math.min(sZ.length - 1, Math.floor((9 - i) * sZ.length / 10))] },
  ],
  vehicleProperties: i === 0 ? { length: 18.5 } : { length: 26.8, number1class: i < 3 ? 60 : 0, number2class: i >= 3 ? 110 : 0 },
});
const ANSWER: FormationAnswer = { formations: [{ formationVehicles: Array.from({ length: 10 }, (_, i) => veh(i)) }] };
const engine: TrainEngine = { base: 'data:', href: () => 'data:application/json,' + encodeURIComponent(JSON.stringify(ANSWER)) };
const ride = (role: 'board' | 'alight', fromEntrance: string, toEntrance: string, id = 'ride1'): Station3DTrain => ({
  id, mode: 'train', role, through: true, number: '1083', operator: 'SBB', category: 'IC', line: 'IC1', headsign: 'Zürich HB', date: '2026-11-24',
  dep: null, uic: String(role === 'board' ? BERN : ZH), ref: '7', sectors: '', toUic: String(ZH), toName: 'Zürich HB',
  board: { uic: String(BERN), ref: '7', sectors: '', name: 'Bern', key: 'bern', walk: { entrance: fromEntrance }, ll: null, heading: null },
  alight: { uic: String(ZH), ref: '7', sectors: '', name: 'Zürich HB', key: 'zurich', walk: { entrance: toEntrance }, ll: null, heading: null },
});
const ctx = { engine, loadModel: async (k: string) => loadModel(k), router: () => SR, cls: 2 as const, prefs: {} };

await test('planCoach: one coach for the ride, the same from either end, with a door at each', async () => {
  const t0 = performance.now();
  const pb = (await planCoach(ride('board', 'Bahnhofplatz (main hall)', 'Bahnhofplatz'), ctx))!;
  const ms = performance.now() - t0;
  const pa = (await planCoach(ride('alight', 'Bahnhofplatz (main hall)', 'Bahnhofplatz'), ctx))!;
  assert(pb && pb.coachId && pb.coachId === pa.coachId, 'the same coach from both ends');
  eq(pb.weighed, ['in', 'out']);
  assert(pb.board && pb.board.door && pb.alight && pb.alight.door, 'a door at both ends');
  assert(pb.board!.seconds! > 0 && pb.alight!.seconds! > 0, 'both walks timed');
  // a 2nd class coach (positions 4–10)
  assert(/^v[3-9]$/.test(pb.coachId!), 'a 2nd class coach: ' + pb.coachId);
  console.log(`        coach ${pb.coachId}: ${Math.round(pb.board!.seconds!)} s in, ${Math.round(pb.alight!.seconds!)} s out (planned in ${Math.round(ms)} ms)`);
});
await test('planCoach: it is the best of the coaches by the walks weighed', async () => {
  const pb = (await planCoach(ride('board', 'Bahnhofplatz (main hall)', 'Bahnhofplatz'), ctx))!;
  const best = pb.board!.seconds! + pb.alight!.seconds!;
  // close the chosen coach, then the next one, …: each next choice is a different coach and no shorter
  const closed = new Set([pb.coachId!]);
  for (let round = 0; round < 4; round++) {
    const answer: FormationAnswer = JSON.parse(JSON.stringify(ANSWER));
    for (const v of answer.formations![0].formationVehicles!) if (closed.has(v.vehicleIdentifier!.evn!)) v.vehicleProperties!.closed = true;
    const eng: TrainEngine = { base: 'data:', href: () => 'data:application/json,' + encodeURIComponent(JSON.stringify(answer)) };
    const r = { ...ride('board', 'Bahnhofplatz (main hall)', 'Bahnhofplatz', 'closed-' + round), number: String(2000 + round) };
    const other = (await planCoach(r, { ...ctx, engine: eng }))!;
    assert(other.coachId && !closed.has(other.coachId), 'another coach');
    assert(other.board!.seconds! + other.alight!.seconds! >= best - 1, `coach ${other.coachId} would be shorter than ${pb.coachId}`);
    closed.add(other.coachId!);
  }
});
await test('planCoach: where you go next changes the coach (the other end of Zürich HB)', async () => {
  const a = (await planCoach(ride('board', 'Bahnhofplatz (main hall)', 'Bahnhofplatz', 'r-a'), ctx))!;
  const b = (await planCoach(ride('board', 'Bahnhofplatz (main hall)', 'Eingang Löwenplatz', 'r-b'), ctx))!;
  console.log(`        to Bahnhofplatz: ${a.coachId} (door sector ${a.alight!.door!.sector}); to Löwenplatz: ${b.coachId} (door sector ${b.alight!.door!.sector})`);
  assert(a.coachId && b.coachId, 'both chosen');
});
await test('planCoach: no coach of your class with a wheelchair space: none chosen, and why', async () => {
  const p = (await planCoach(ride('board', 'Bahnhofplatz (main hall)', 'Bahnhofplatz', 'r-w'), { ...ctx, prefs: { wheelchair: true } }))!;
  eq([p.coachId, p.missing], [null, 'wheelchair']);
});
await test('doorsOf: two doors per coach on the platform side, none on the locomotive', () => {
  const coaches = ANSWER.formations![0].formationVehicles!.map((v, i) => ({ pos: i + 1, number: i + 1, id: 'v' + i, sectors: [v.formationVehicleAtScheduledStops![0].sectors!], cls: i === 0 ? null : 2 as const,
    kind: i === 0 ? 'loco' as const : 'coach' as const, len: i === 0 ? 18.5 : 26.8, closed: false, declassed: false, wheelchair: false, bike: false, stroller: false, family: false, business: false, lowFloor: false, goesTo: null, reaches: null }));
  const L = layoutTrain(bern, '7', { coaches, sectors: [] })!;
  eq(doorsOf(L, 0).length, 0);
  const d = doorsOf(L, 4);
  eq(d.length, 2);
  for (const x of d) {
    assert(Math.abs(dist(x.xy, x.inside) - 2.6) < 0.01, 'on the platform side, 2.6 m from the track');
    const toPlat = [x.xy[0] - x.inside[0], x.xy[1] - x.inside[1]];
    assert(toPlat[0] * L.side[0] + toPlat[1] * L.side[1] > 0, 'towards the platform');
  }
});

// ---------------------------------------------------------------- trains in a row: Zürich HB → Bern, change, Bern → Basel SBB
const basel = loadModel('basel');
const sB8 = secsOf(bern, '8'), sBs1 = secsOf(basel, '1');
const coachAt = (i: number, stops: [number, string][], n: number) => ({
  position: i + 1, number: i === 0 ? 0 : i + 1, vehicleIdentifier: { evn: 'w' + stops[0][0] + i, typeCodeName: i === 0 ? 'Re460' : 'IC2000' },
  formationVehicleAtScheduledStops: stops.map(([uic, s], k) => ({ stopPoint: { uic }, sectors: s.split('')[Math.min(s.length - 1, Math.floor((k ? n - 1 - i : i) * s.length / n))] })),
  vehicleProperties: i === 0 ? { length: 18.5 } : { length: 26.8, number2class: 110 },
});
const A1: FormationAnswer = { formations: [{ formationVehicles: Array.from({ length: 8 }, (_, i) => coachAt(i, [[ZH, sZ.join('')], [BERN, sB.join('')]], 8)) }] };
const A2: FormationAnswer = { formations: [{ formationVehicles: Array.from({ length: 8 }, (_, i) => coachAt(i, [[BERN, sB8.join('')], [8500010, sBs1.join('')]], 8)) }] };
const engine2: TrainEngine = { base: 'data:', href: (_p, q) => 'data:application/json,' + encodeURIComponent(JSON.stringify(q && q.train === '4001' ? A2 : A1)) };
const r1 = (): Station3DTrain => ({
  id: 'zb', mode: 'train', role: 'board', through: true, number: '3001', operator: 'SBB', category: 'IC', line: 'IC1', headsign: 'Bern', date: '2026-11-24', dep: null,
  uic: String(ZH), ref: '7', sectors: '', toUic: String(BERN), toName: 'Bern',
  board: { uic: String(ZH), ref: '7', sectors: '', name: 'Zürich HB', key: 'zurich', walk: { entrance: 'Bahnhofplatz' }, ll: null, heading: null },
  alight: { uic: String(BERN), ref: '7', sectors: '', name: 'Bern', key: 'bern', walk: { stop: { uic: String(BERN), ref: '8' } }, ll: null, heading: null },
});
const r2 = (): Station3DTrain => ({
  id: 'bb', mode: 'train', role: 'board', through: true, number: '4001', operator: 'SBB', category: 'IC', line: 'IC6', headsign: 'Basel SBB', date: '2026-11-24', dep: null,
  uic: String(BERN), ref: '8', sectors: '', toUic: '8500010', toName: 'Basel SBB',
  board: { uic: String(BERN), ref: '8', sectors: '', name: 'Bern', key: 'bern', walk: { stop: { uic: String(BERN), ref: '7' } }, ll: null, heading: null },
  alight: { uic: '8500010', ref: '1', sectors: '', name: 'Basel SBB', key: 'basel', walk: { entrance: basel.entrances![0].name }, ll: null, heading: null },
});
await test('planCoach: trains in a row are chosen together, door to door at the change, and agree from every view', async () => {
  const chain = [r1(), r2()];
  const c2 = { ...ctx, engine: engine2 };
  const t0 = performance.now();
  const p1 = (await planCoach({ ...r1(), chain }, c2))!, p2 = (await planCoach({ ...r2(), chain }, c2))!;
  const ms = performance.now() - t0;
  const p1a = (await planCoach({ ...r1(), role: 'alight', chain }, c2))!;
  assert(p1.coachId && p2.coachId, 'both chosen');
  eq(p1a.coachId, p1.coachId, 'the same coach from the arrival view');
  // the change: the walk from ride 1's coach door is the one into ride 2's coach door
  assert(p1.alight!.seconds != null && p1.alight!.seconds === p2.board!.seconds, `one walk at the change: ${JSON.stringify([p1.alight, p2.board, p1.weighed, p2.weighed])}`);
  const together = p1.board!.seconds! + p1.alight!.seconds! + p2.alight!.seconds!;
  // each on its own (no chain), then the change between the coaches chosen that way: never shorter
  const s1 = (await planCoach({ ...r1(), id: 'zb-solo' }, c2))!, s2 = (await planCoach({ ...r2(), id: 'bb-solo' }, c2))!;
  const SRr = SR.route(bern, { stop: { uic: String(BERN), ref: '7', at: s1.alight!.door!.xy, sector: s1.alight!.door!.sector } },
    { stop: { uic: String(BERN), ref: '8', at: s2.board!.door!.xy, sector: s2.board!.door!.sector } }, {})!;
  const alone = s1.board!.seconds! + SRr.seconds + s2.alight!.seconds!;
  assert(together <= alone + 1, `together ${Math.round(together)} s, one at a time ${Math.round(alone)} s`);
  console.log(`        together: ${p1.coachId} → ${p2.coachId}, ${Math.round(together)} s; one at a time: ${s1.coachId} → ${s2.coachId}, ${Math.round(alone)} s (${Math.round(ms)} ms)`);
});

// ---------------------------------------------------------------- trams and buses
await test('layoutAtStop: a tram on its track, front at the stop, facing the way it goes', () => {
  const stop = zurich.stops!.find((s) => s.mode === 'tram')!;
  const L = layoutAtStop(zurich, 'tram', { uic: stop.uic, ref: stop.ref || '', ll: SR.toLngLat(zurich, stop.xy), heading: 90 })!;
  assert(L && L.kind === 'tram' && L.cars.length === 4, 'four parts');
  const front = L.cars[L.cars.length - 1].b, d = L.dir(0);
  // the front at the stop's leading end (along the way it goes), on the track (within a few metres of the stop)
  const ahead = Math.max(0, ...(stop.nodes || []).map((n) => { const p = zurich.graph.nodes[n]; return (p[0] - stop.xy[0]) * d[0] + (p[1] - stop.xy[1]) * d[1]; }));
  const along = (front[0] - stop.xy[0]) * d[0] + (front[1] - stop.xy[1]) * d[1];
  assert(Math.abs(along - (ahead >= 10 ? ahead : 0)) < 8, `front ${along.toFixed(1)} m along, the stop reaches ${ahead.toFixed(1)} m`);
  assert(d[0] * Math.sin(Math.PI / 2) + d[1] * Math.cos(Math.PI / 2) >= 0, 'facing east-ish (heading 90)');
  assert(Math.abs(L.cars[3].s1 - L.cars[0].s0 - 36) < 0.01, '36 m');
});
await test('layoutAtStop: a bus beside its stop; without a direction, nothing', () => {
  const stop = bern.stops!.find((s) => s.mode === 'bus' && s.ref === 'U')!;
  const L = layoutAtStop(bern, 'bus', { uic: stop.uic, ref: 'U', ll: null, heading: 0 })!;
  assert(L && L.cars.length === 2 && Math.abs(dist(L.cars[1].b, stop.xy) - 1.7) < 0.01, 'front 1.7 m beside the stop');
  eq(layoutAtStop(bern, 'bus', { uic: stop.uic, ref: 'U', ll: null, heading: null }), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
