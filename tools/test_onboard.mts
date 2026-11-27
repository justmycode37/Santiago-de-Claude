// Tests for the journey from on board a vehicle (KanteJourney.onboard(), src/engine-journey.ts): what is asked of the
// engine, which of its journeys are offered, and the first ride drawn from the stop you passed last. The engine's
// answer is made up; offline. Exit code 1 on any failure.
//
//   node --experimental-test-module-mocks tools/test_onboard.mts
import { mock } from 'node:test';

let passed = 0, failed = 0;
const check = (ok: boolean, what: string) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };

// ---- a bus with six stops, 500 m apart going east, two minutes from stop to stop; now it is between stops 2 and 3
const now = Math.floor(Date.now() / 1000), t0 = now - 300;
const ll = (k: number): LngLat => [7.40 + k * 0.0066, 46.95];
const quay = (k: number) => ({ id: `q${k}`, stationId: `st${k}`, stationName: `Stop ${k}`, lat: ll(k)[1], lon: ll(k)[0], precision: 'edge' }) as unknown as KanteQuay;
const call = (k: number): KanteStopCall => ({ seq: k, quay: quay(k), arr: k ? t0 + k * 120 - 20 : undefined, dep: k < 5 ? t0 + k * 120 : undefined });
const path: LngLat[] = [];
for (let k = 0; k <= 50; k++) path.push([7.40 + k * 0.00066, 46.95 + (k % 10 === 5 ? 0.0002 : 0)]);
const trip = { tripId: 'bus10', serviceDate: '2026-11-27', line: { name: '10', category: 'B', mode: 'bus', operator: 'X' }, headsign: 'East',
  calls: [0, 1, 2, 3, 4, 5].map(call), geometry: [], path, pathAt: [0, 10, 20, 30, 40, 50], live: 'observed',
  liveInfo: { state: 'observed' } } as unknown as KanteTrip;
// the engine's on-board leg: from the trip's next stop on
const rideLeg = (from: number, to: number, extra: Partial<KanteRideLeg> = {}): KanteRideLeg => ({ type: 'ride', line: trip.line,
  headsign: 'East', tripId: 'bus10', serviceDate: '2026-11-27', from: call(from), to: call(to),
  intermediate: Array.from({ length: Math.max(0, to - from - 1) }, (_, i) => call(from + 1 + i)), geometry: [],
  path: path.slice(from * 10, to * 10 + 1), pathAt: Array.from({ length: to - from + 1 }, (_, i) => i * 10), onboard: true, live: 'observed', ...extra } as KanteRideLeg);
const egress = (dep: number): KanteWalkLeg => ({ type: 'walk', kind: 'egress', dep, arr: dep + 120, durationS: 120, distanceM: 150,
  from: { lat: 46.95, lon: 7.433 }, to: { lat: 46.951, lon: 7.434 }, geometry: [ll(5), [7.434, 46.951]] } as unknown as KanteWalkLeg);
const journeyOf = (id: string, legs: KanteLeg[], arr: number, alerts: KanteJourneyAlert[] = []): KanteJourney =>
  ({ id, dep: now, arr, durationS: arr - now, transfers: 0, walkS: 120, walkM: 150, legs, alerts });

let answer = null as KantePlanResponse | null, sent = null as KantePlanRequest | null;
const asked = () => sent!.onboard!;
mock.module(new URL('../src/engine.ts', import.meta.url).href, { exports: { KANTE: { plan: async (b: KantePlanRequest) => { sent = b; return answer; }, failure: () => null } } });
mock.module(new URL('../src/settings.ts', import.meta.url).href, { exports: { SETTINGS: { prefs: () => ({ walkKmh: 4.7, maxWalkMin: 15, extraChangeMin: 0 }), transportations: () => [] } } });
/** What these tests read of a journey and its rides (src/engine-journey.ts). */
interface Ride { type: 'ride'; from: KanteStopCall; to: KanteStopCall; stops: KanteStopCall[]; legs: KanteRideLeg[]; live: { trip?: KanteTrip; at: number }[] }
interface Options { list: unknown[]; walk: unknown; best: { dep: number; t0: number; parts: Ride[] }; earlier: boolean; later: boolean }
interface EngineJourneys {
  onboard(trip: KanteTrip, tripAt: number, fromSeq: number, nextSeq: number | null, dest: { lngLat: LngLat }): Promise<Options | null>;
  ridePath(r: Ride): { path: LngLat[]; idx: number[] } | null;
}
// (a specifier TypeScript does not follow: the app's modules are checked with the app, not with the tools)
const KanteJourney: EngineJourneys = (await import(new URL('../src/engine-journey.ts', import.meta.url).href)).KanteJourney;
const dest = { lngLat: [7.434, 46.951] as LngLat };
const respond = (journeys: KanteJourney[]) => { answer = { journeys, from: {}, to: {}, tookMs: 1, realtime: true } as unknown as KantePlanResponse; };

console.log('what is asked');
{
  respond([journeyOf('a', [rideLeg(3, 5), egress(t0 + 580)], t0 + 700)]);
  await KanteJourney.onboard(trip, Date.now(), 2, 3, dest);
  check(asked().tripId === 'bus10' && asked().nextSeq === 3 && !sent!.from, 'the trip, and the stop ahead (its arrival still to come); no start');
  await KanteJourney.onboard(trip, Date.now(), 2, 1, dest);
  check(asked().nextSeq === undefined, 'a stop ahead whose arrival has passed by the times: left to the engine');
  await KanteJourney.onboard(trip, Date.now(), 2, null, dest);
  check(asked().nextSeq === undefined, 'no stop ahead known: left to the engine');
}

console.log('the first ride from the stop you passed last');
{
  respond([journeyOf('a', [rideLeg(3, 5), egress(t0 + 580)], t0 + 700)]);
  const o = (await KanteJourney.onboard(trip, 1234, 2, 3, dest))!;
  const r = o.best.parts[0];
  check(r.type === 'ride' && r.from.seq === 2 && r.to.seq === 5 && r.stops.length === 4, `stops 2 to 5 (${r.from.seq}…${r.to.seq}, ${r.stops.length} stops)`);
  check(r.legs[0].path!.length === 31 && r.legs[0].pathAt!.join() === '0,10,20,30', `its way from stop 2 on (${r.legs[0].path!.length} points, at ${r.legs[0].pathAt!.join()})`);
  check(!!KanteJourney.ridePath(r), 'its way read back as the ride’s (ridePath())');
  check(o.best.dep === t0 + 240 && o.best.t0 === (t0 + 240) * 1000, 'it starts when the bus left stop 2');
  check(r.live[0].trip === trip && r.live[0].at === 1234, 'the trip’s answer is its first live data');
  check(o.list.length === 1 && o.best === o.list[0] && !o.earlier && !o.later && !o.walk, 'that journey alone, nothing earlier or later');
  // a single-stop leg (get off at the very next stop): from the stop passed last to it
  respond([journeyOf('b', [rideLeg(3, 3, { intermediate: [], path: [], pathAt: [] }), egress(t0 + 340)], t0 + 460)]);
  const o2 = (await KanteJourney.onboard(trip, 1, 2, 3, dest))!;
  const r2 = o2.best.parts[0];
  check(r2.from.seq === 2 && r2.to.seq === 3 && r2.stops.length === 2, `getting off at the next stop: stops 2 and 3 (${r2.stops.length})`);
}

console.log('what is not offered');
{
  respond([journeyOf('c', [rideLeg(3, 5, { cancelled: true }), egress(t0 + 580)], t0 + 700)]);
  check(await KanteJourney.onboard(trip, 1, 2, 3, dest) === null, 'a cancelled ride');
  respond([journeyOf('d', [rideLeg(3, 5), egress(t0 + 580)], t0 + 700, [{ severity: 'severe', kind: 'missed-connection', text: '' }])]);
  check(await KanteJourney.onboard(trip, 1, 2, 3, dest) === null, 'a missed change');
  respond([journeyOf('e', [rideLeg(1, 2), egress(t0 + 220)], t0 + 340)]);
  check(await KanteJourney.onboard(trip, 1, 2, 3, dest) === null, 'getting off where you have already been');
  respond([journeyOf('f', [{ ...rideLeg(3, 5), tripId: 'other' }, egress(t0 + 580)], t0 + 700)]);
  check(await KanteJourney.onboard(trip, 1, 2, 3, dest) === null, 'a journey that starts on another trip');
  answer = null;
  check(await KanteJourney.onboard(trip, 1, 2, 3, dest) === null, 'no journey at all');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
