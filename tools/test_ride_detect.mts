// Tests for telling which vehicle you are on from GPS fixes (src/app/ride-detect.ts), on made-up tracks: a line
// running east with a stop every 500 m, its vehicles 8 m/s between stops and 20 s at each. Offline; exit code 1 on
// any failure.
//
//   node tools/test_ride_detect.mts
import { RIDE_DETECT, RIDE } from '../src/app/ride-detect.ts';
import type { RideCandidate, RideFix, RideStop, RideSeen } from '../src/app/ride-detect.ts';

let passed = 0, failed = 0;
const check = (ok: boolean, what: string) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };
const { decide, confirm, motion, recentFixes, vehicleTimeAt, match } = RIDE_DETECT;

// ---- the made-up world
const LAT = 46.95, LON = 7.40;
const DEG_KM_X = 1 / (111.32 * Math.cos(LAT * Math.PI / 180)), DEG_KM_Y = 1 / 110.54;
const east = (km: number, northKm = 0): LngLat => [LON + km * DEG_KM_X, LAT + northKm * DEG_KM_Y];
// a little GPS noise, the same every run
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
const jitter = (p: LngLat, m: number): LngLat => [p[0] + rnd() * 2 * m / 1000 * DEG_KM_X, p[1] + rnd() * 2 * m / 1000 * DEG_KM_Y];

const T0 = 1_800_000_000; // unix s
const STOP_KM = 0.5, SPEED = 8, DWELL = 20, N_STOPS = 9;
const hopS = (STOP_KM * 1000) / SPEED; // 62.5 s from stop to stop
/** A trip along a way (km → point), leaving its first stop at dep0 (unix s). */
function trip(key: string, line: string, dep0: number, opts: { planned?: boolean; way?: (km: number) => LngLat; live?: boolean } = {}): RideCandidate {
  const way = opts.way || ((km: number) => east(km));
  const path: LngLat[] = [];
  for (let m = 0; m <= (N_STOPS - 1) * STOP_KM * 1000; m += 50) path.push(way(m / 1000));
  const stops: RideStop[] = [];
  for (let k = 0; k < N_STOPS; k++) {
    const arr = dep0 + k * (hopS + DWELL) - DWELL;
    stops.push({ seq: k + 1, km: k * STOP_KM, arr: k ? arr : null, dep: k < N_STOPS - 1 ? arr + DWELL : null });
  }
  return { key, line, path, stops, planned: opts.planned, live: opts.live !== false };
}
/** Where a trip's vehicle is at t (unix s): km along. */
function kmAt(c: RideCandidate, t: number): number {
  const s = c.stops;
  for (let k = 0; k < s.length; k++) {
    const dep = s[k].dep, nx = s[k + 1];
    if (dep == null) return s[k].km;
    if (t <= dep) return s[k].km;
    if (nx && t < nx.arr!) return s[k].km + (nx.km - s[k].km) * (t - dep) / (nx.arr! - dep);
  }
  return s[s.length - 1].km;
}
/** Fixes every `every` s from t0 to t1 (unix s) at pos(t), with noise (m) and accuracy. */
function track(t0: number, t1: number, pos: (t: number) => LngLat, noise = 6, acc = 12, every = 2): RideFix[] {
  const out: RideFix[] = [];
  for (let t = t0; t <= t1; t += every) out.push({ ll: jitter(pos(t), noise), t: t * 1000, acc });
  return out;
}
const onTrip = (c: RideCandidate, way = (km: number) => east(km)) => (t: number) => way(kmAt(c, t));

// ---- the cases
console.log('when the vehicle is at a place');
{
  const c = trip('a', 'B 12', T0);
  const at0 = vehicleTimeAt(c.stops, 0), mid = vehicleTimeAt(c.stops, 0.25), at1 = vehicleTimeAt(c.stops, 0.5);
  check(!!at0 && at0[0] === T0 && at0[1] === T0, 'at its first stop when it leaves');
  check(!!mid && Math.abs(mid[0] - (T0 + hopS / 2)) < 1e-6, 'half way between two stops half way between their times');
  check(!!at1 && at1[0] === T0 + hopS && at1[1] === T0 + hopS + DWELL, 'a span while it stands at a stop');
  check(vehicleTimeAt(c.stops, 5) === null, 'none past its last stop');
}

console.log('not moving like a vehicle');
{
  const bus = trip('b', 'B 12', T0, {});
  const planned = trip('p', 'B 12', T0 + 480, { planned: true });
  // standing at the stop (GPS wanders 15 m) while the bus leaves beside you
  const fixes = track(T0 - 30, T0 + 90, () => east(0, 0.01), 15, 20, 1);
  check(decide(fixes, [bus, planned], (T0 + 90) * 1000).kind === 'still', 'waiting at the stop next to the line, a bus leaving: nothing');
  // a fix far off once (a stray), the rest at the stop
  const stray = fixes.map((f, i) => (i === 60 ? { ...f, ll: east(0.4) } : f));
  check(decide(stray, [bus, planned], (T0 + 90) * 1000).kind === 'still', 'one stray fix 400 m on: nothing');
  // walking along the line, 1.4 m/s
  const walk = track(T0, T0 + 120, (t) => east((t - T0) * 0.0014), 5);
  check(decide(walk, [bus, planned], (T0 + 120) * 1000).kind === 'still', 'walking along the line: nothing');
  // running for it, 4 m/s for 90 s (as far as 300 m and more, but no faster than a runner)
  const run = track(T0, T0 + 90, (t) => east((t - T0) * 0.004), 5);
  check(decide(run, [bus, planned], (T0 + 90) * 1000).kind === 'still', 'running along the line at 4 m/s: nothing');
  // a fix from before a tunnel and fresh ones after it: only the fresh ones count (too few yet)
  const tunnel = [...track(T0, T0 + 20, onTrip(bus)), ...track(T0 + 140, T0 + 160, onTrip(bus))];
  const win = recentFixes(tunnel, (T0 + 160) * 1000);
  check(win[0].t === (T0 + 140) * 1000, 'after a gap of more than 30 s only the fixes since count');
  check(decide(tunnel, [bus, planned], (T0 + 160) * 1000).kind === 'still', 'just out of a tunnel: not yet');
  // old fixes: nothing
  const ride = track(T0 + 10, T0 + 100, onTrip(bus));
  check(motion(recentFixes(ride, (T0 + 160) * 1000), (T0 + 160) * 1000) === null, 'fixes a minute old: not moving now');
}

console.log('on another vehicle than planned');
{
  // an earlier bus of another line, 8 minutes before the planned one, along the same road
  const other = trip('other|2026-11-27', 'B 10', T0);
  const planned = trip('plan|2026-11-27', 'B 12', T0 + 480, { planned: true });
  const now = T0 + 100;
  const fixes = track(T0 - 20, now, onTrip(other));
  const d = decide(fixes, [other, planned], now * 1000);
  check(d.kind === 'ride' && d.cand.key === 'other|2026-11-27', `on bus 10 that left before the planned 12: found (${d.kind})`);
  if (d.kind === 'ride') {
    check(d.match.boardSeq === 1, `boarded at its first stop (seq ${d.match.boardSeq})`);
    check(d.match.lastSeq === 2 && d.match.nextSeq === 3, `between its 2nd and 3rd stop now (${d.match.lastSeq} → ${d.match.nextSeq})`);
    check(d.match.score < 15, `close to its vehicle (${d.match.score.toFixed(0)} s)`);
  }
  // its live times say a minute late; it really is 50 s ahead of them: still that one
  const late = { ...other, stops: other.stops.map((s) => ({ ...s, arr: s.arr && s.arr + 60, dep: s.dep && s.dep + 60 })) };
  const fixesEarly = track(T0 + 40, now + 60, (t) => east(kmAt(other, t - 10)));
  const dl = decide(fixesEarly, [late, planned], (now + 60) * 1000);
  check(dl.kind === 'ride', `its live times 50 s off: still found (${dl.kind})`);
  // the same line, an earlier run: found too (ride-switch.ts words it as new times)
  const earlier = trip('early|2026-11-27', 'B 12', T0);
  const de = decide(track(T0 - 20, now, onTrip(earlier)), [earlier, planned], now * 1000);
  check(de.kind === 'ride' && de.cand.key === 'early|2026-11-27', 'an earlier run of the planned line: found');
  // with no candidate that fits in time (no vehicle there then): nothing
  const dn = decide(track(T0 - 20, now, onTrip(other)), [trip('x', 'B 10', T0 + 300), planned], now * 1000);
  check(dn.kind === 'none', `moving along the line with no vehicle there: nothing (${dn.kind})`);
  // the other way along the line: not that trip
  const back = track(T0, T0 + 100, (t) => east(3 - (t - T0) * 0.008));
  check(decide(back, [trip('y', 'B 10', T0)], (T0 + 100) * 1000).kind === 'none', 'the other way along its line: not that trip');
  // far beside the line (a parallel road 300 m away)
  const beside = track(T0 - 20, now, (t) => east(kmAt(other, t), 0.3));
  check(decide(beside, [other, planned], now * 1000).kind === 'none', 'on a road 300 m beside it: not that trip');
}

console.log('on the planned vehicle, or not sure which');
{
  const planned = trip('plan', 'B 12', T0, { planned: true });
  const now = T0 + 100;
  const fixes = track(T0 - 20, now, onTrip(planned));
  check(decide(fixes, [planned], now * 1000).kind === 'planned', 'on the planned bus: planned');
  // another line 20 s behind on the same road: the planned one fits best, so planned
  const close = trip('c', 'B 10', T0 + 20);
  check(decide(fixes, [planned, close], now * 1000).kind === 'planned', 'another line 20 s behind the planned one: planned');
  // another line 15 s ahead of the planned one, you on the planned one: still not a switch
  const ahead = trip('d', 'B 10', T0 - 15);
  const da = decide(fixes, [ahead, planned], now * 1000);
  check(da.kind === 'planned' || da.kind === 'unsure', `another line 15 s ahead: no switch (${da.kind})`);
  // the planned run 60 s behind the one you are on: it fits, loosely; the one you are on fits far better
  const plan80 = trip('p80', 'B 12', T0 + 60, { planned: true }), run = trip('run', 'B 12', T0);
  const ride80 = track(T0 - 20, now, onTrip(run));
  const loose = decide(ride80, [plan80], now * 1000);
  check(loose.kind === 'planned' && loose.score >= RIDE.rivalS, `the planned run alone fits, but only loosely (${loose.kind === 'planned' ? loose.score.toFixed(0) + ' s' : loose.kind})`);
  const d80 = decide(ride80, [plan80, run], now * 1000);
  check(d80.kind === 'ride' && d80.cand.key === 'run', `the run 60 s before the planned one is the one you are on (${d80.kind})`);
  // two runs of an unplanned line bunched 20 s apart: not sure which
  const p2 = trip('p2', 'B 12', T0 + 600, { planned: true });
  const r1 = trip('r1', 'B 10', T0), r2 = trip('r2', 'B 10', T0 + 20);
  const fx = track(T0 - 20, now, (t) => east(kmAt(r1, t + 10) ));
  check(decide(fx, [r1, r2, p2], now * 1000).kind === 'unsure', 'two buses bunched 20 s apart: not sure which');
}

console.log('a shared road, then the lines part');
{
  // 10 and 21 run together for 1.5 km, then 21 turns north; you are on the 21, leaving 25 s after the 10
  const turn = (km: number): LngLat => (km <= 1.5 ? east(km) : east(1.5, km - 1.5));
  const ten = trip('ten', 'B 10', T0), tw1 = trip('tw1', 'B 21', T0 + 25, { way: turn });
  const planned = trip('plan', 'B 12', T0 + 600, { planned: true });
  const pos = onTrip(tw1, turn);
  const during = T0 + 25 + 140; // still on the shared road
  check(decide(track(T0 + 5, during, pos), [ten, tw1, planned], during * 1000).kind === 'unsure', 'on the shared road: not sure yet');
  const after = T0 + 25 + 300; // well past the turn
  const d = decide(track(T0 + 5, after, pos), [ten, tw1, planned], after * 1000);
  check(d.kind === 'ride' && d.cand.key === 'tw1', `past where they part: the 21 (${d.kind})`);
}

console.log('believed only twice in a row');
{
  const other = trip('o', 'B 10', T0), planned = trip('p', 'B 12', T0 + 480, { planned: true });
  const fixes = track(T0 - 20, T0 + 160, onTrip(other));
  const at = (t: number) => decide(fixes.filter((f) => f.t <= t * 1000), [other, planned], t * 1000);
  let seen: RideSeen | null = null, sure = false;
  ({ seen, sure } = confirm(seen, at(T0 + 100), (T0 + 100) * 1000));
  check(!sure, 'the first answer alone: not yet');
  // the page asks again with the same fix (a timer tick): no further
  ({ seen, sure } = confirm(seen, at(T0 + 100), (T0 + 100) * 1000));
  check(!sure, 'the same fix asked again: not yet');
  ({ seen, sure } = confirm(seen, at(T0 + 108), (T0 + 108) * 1000));
  check(!sure, '8 s of fixes later: not yet');
  ({ seen, sure } = confirm(seen, at(T0 + 120), (T0 + 120) * 1000));
  check(sure, '20 s of fixes later, the same trip: believed');
  const other2 = confirm(seen, { kind: 'unsure' }, (T0 + 130) * 1000);
  check(!other2.sure && other2.seen === null, 'then not sure: starts again');
  const gap = confirm({ key: 'o', at: (T0 - 200) * 1000, n: 1 }, at(T0 + 100), (T0 + 100) * 1000);
  check(!gap.sure, 'an answer long before does not count');
}

console.log('walking to the stop, then on board; staying on past your stop; a sprint');
{
  // 60 s walking up a side street to the first stop (north of it, towards the line), then the bus
  const bus = trip('w', 'B 10', T0 + 60), planned = trip('p', 'B 12', T0 + 600, { planned: true });
  const pos = (t: number) => (t < T0 + 60 ? east(0, 0.084 - (t - T0) * 0.0014) : east(kmAt(bus, t)));
  const now = T0 + 60 + 100;
  const d = decide(track(now - 119, now, pos), [bus, planned], now * 1000);
  check(d.kind === 'ride' && d.cand.key === 'w', `the walk up to the stop left out: the bus is found (${d.kind})`);
  // the planned ride is the trip's first three stops; you stay on past the third: the trip found around you is the
  // planned one, all of it
  const whole = trip('same|2026-11-27', 'B 12', T0);
  const slice = { ...whole, planned: true, stops: whole.stops.slice(0, 3), path: whole.path.filter((_, i) => i <= 20) };
  const in1 = T0 + 100;
  check(decide(track(T0 - 20, in1, onTrip(whole)), [slice, whole], in1 * 1000).kind === 'planned', 'on the planned trip, before your stop: planned');
  const past = T0 + 3 * (hopS + DWELL) + 40;
  const dp = decide(track(past - 100, past, onTrip(whole)), [slice, whole], past * 1000);
  check(dp.kind === 'ride' && dp.cand.key === 'same|2026-11-27', `stayed on past your stop: that same trip, from where you are now (${dp.kind})`);
  // running 4 m/s with a 10 s sprint at 7 m/s
  const sprint = track(T0, T0 + 90, (t) => east((t - T0) * 0.004 + Math.max(0, Math.min(10, t - T0 - 40)) * 0.003), 5);
  check(decide(sprint, [trip('s', 'B 10', T0)], (T0 + 90) * 1000).kind === 'still', 'running with a short sprint: nothing');
}

console.log('a way that passes the same place twice');
{
  // out 1 km east and back on the other side of the road (20 m north): you are on the way back
  const loop = (km: number): LngLat => (km <= 1 ? east(km) : east(2 - km, 0.02));
  const c = trip('loop', 'B 31', T0, { way: loop });
  const t1 = T0 + 4 * (hopS + DWELL) - DWELL + 5; // just past the turn (km 2 is stop 5)
  const fixes = track(t1, t1 + 90, onTrip(c, loop), 4, 10);
  const m = match(recentFixes(fixes, (t1 + 90) * 1000), c, (t1 + 90) * 1000);
  check(!!m && m.km > 2, `on the way back, not the way out (${m ? m.km.toFixed(2) : 'none'} km)`);
  // out 2 km and back along the very same street; you are on the way back, over the stretch the way out took too
  const same = (km: number): LngLat => (km <= 2 ? east(km) : east(4 - km));
  const sc = trip('same', 'B 32', T0, { way: same });
  const t2 = T0 + 5 * (hopS + DWELL); // past km 2.5, on the way back
  const fx2 = track(t2, t2 + 100, onTrip(sc, same), 4, 10);
  const m2 = match(recentFixes(fx2, (t2 + 100) * 1000), sc, (t2 + 100) * 1000);
  check(!!m2 && m2.km > 2.5 && m2.score < 15, `out and back along one street: the way back (${m2 ? m2.km.toFixed(2) + ' km, ' + m2.score.toFixed(0) + ' s' : 'none'})`);
}

console.log('waiting at the stop, then on board; a long stop just ahead');
{
  // 70 s at the stop (GPS wandering 12 m), then the bus leaves with you
  const bus = trip('wait', 'B 10', T0 + 70), planned = trip('p', 'B 12', T0 + 600, { planned: true });
  const pos = (t: number) => (t < T0 + 70 ? east(0, 0.005) : east(kmAt(bus, t)));
  const now = T0 + 70 + 75;
  const d = decide(track(T0, now, pos, 12, 15), [bus, planned], now * 1000);
  check(d.kind === 'ride' && d.cand.key === 'wait' && d.match.boardSeq === 1, `waited 70 s, then on: found, boarded at the stop (${d.kind})`);
  // a train standing 5 minutes at a station: a fix 15 m before the stop is there for all of that time
  const stops: RideStop[] = [{ seq: 1, km: 0, arr: null, dep: T0 }, { seq: 2, km: 2, arr: T0 + 120, dep: T0 + 420 }, { seq: 3, km: 4, arr: T0 + 540, dep: null }];
  const span = vehicleTimeAt(stops, 1.985);
  check(!!span && span[0] === T0 + 120 && span[1] === T0 + 420, 'just before a stop it stands at for 5 minutes: all of that time');
}

console.log(`\n${passed} passed, ${failed} failed (thresholds: ${RIDE.minDispM} m, ${RIDE.minSpeed} m/s)`);
if (failed) process.exit(1);
