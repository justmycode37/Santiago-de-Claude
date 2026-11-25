// How smoothly the map's live vehicles move: answers of an engine's /api/vehicles one every 15 s (as the stream sends
// them), drawn as before (vehicleAt() once a second) and as now (showVehicle() about 12 times a second). Counts the
// jumps: a vehicle moving more in one drawn step than three times its pace allows (and over 10 m).
//
//   node tools/glide_replay.mts [engine] [bbox w,s,e,n] [minutes]
//   node tools/glide_replay.mts http://127.0.0.1:8131 7.42,46.94,7.46,46.96 4
import { KANTE_LIVE } from '../src/live.ts';
import type { KanteShownVehicle } from '../src/live.ts';

const [engine = 'http://127.0.0.1:8131', bbox = '7.42,46.94,7.46,46.96', minutes = '4'] = process.argv.slice(2);
const t0 = Math.floor(Date.now() / 1000), EVERY = 15, N = Math.round(Number(minutes) * 60 / EVERY);
type V = KanteVehicle & { t: number };
const answers: V[][] = [];
for (let k = 0; k <= N; k++) {
  const t = t0 + k * EVERY;
  const res = await (await fetch(`${engine}/api/vehicles?bbox=${bbox}&t=${t}`)).json() as KanteVehiclesResponse;
  answers.push(res.vehicles.map((v) => ({ ...v, t: res.t })));
}
const metres = (a: LngLat, b: LngLat) => KANTE_LIVE.distKm(a, b) * 1000;
const keyOf = (v: V) => v.tripId + '|' + v.serviceDate;
// the pace of a vehicle on its hop, m/s (its way's length over its time; standing: 0)
const pace = (v: V) => (v.arr > v.dep && (v.from[0] !== v.to[0] || v.from[1] !== v.to[1])
  ? metres(KANTE_LIVE.hopPointAt(v, 0), KANTE_LIVE.hopPointAt(v, 1)) / (v.arr - v.dep) : 0);

function run(stepS: number, glide: boolean) {
  let steps = 0, jumps = 0, biggest = 0, moved = 0;
  const last = new Map<string, LngLat>(), shownBy = new Map<string, KanteShownVehicle<V>>();
  for (let s = 0; s < N * EVERY; s += stepS) {
    const list = answers[Math.floor(s / EVERY)], tNow = t0 + s;
    for (const v of list) {
      const k = keyOf(v);
      let ll: LngLat;
      if (glide) { const sh = KANTE_LIVE.showVehicle(shownBy.get(k), v, tNow, s * 1000); shownBy.set(k, sh); ll = sh.ll; }
      else ll = KANTE_LIVE.vehicleAt(v, tNow);
      const before = last.get(k);
      last.set(k, ll);
      if (!before) continue;
      const d = metres(before, ll), allowed = Math.max(10, 3 * pace(v) * stepS);
      steps++;
      moved += d;
      if (d > allowed) { jumps++; biggest = Math.max(biggest, d); }
    }
  }
  return { steps, jumps, biggest, moved };
}
const vehicleHours = answers.slice(0, N).reduce((n, l) => n + l.length, 0) * EVERY / 3600;
for (const [name, stepS, glide] of [['before: once a second, jumping to each answer', 1, false], ['now: 12 times a second, gliding', 0.08, true]] as const) {
  const r = run(stepS, glide);
  console.log(`${name}: ${(1 / stepS).toFixed(0)} steps a second; ${r.jumps} jumps (${(r.jumps / vehicleHours).toFixed(1)} per vehicle-hour), the biggest ${r.biggest.toFixed(0)} m`);
}
console.log(`(${answers[0].length} vehicles at first, ${N} answers ${EVERY} s apart, ${vehicleHours.toFixed(1)} vehicle-hours)`);
