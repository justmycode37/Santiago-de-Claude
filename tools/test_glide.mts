// Tests for how vehicles are moved on the map between answers of the engine (src/live.ts): along the way they take
// (hopPointAt), and gliding to a newer answer instead of jumping (glide). Offline; exit code 1 on any failure.
//
//   node tools/test_glide.mts
import { KANTE_LIVE } from '../src/live.ts';

let passed = 0, failed = 0;
const check = (ok: boolean, what: string) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };
const { glide, hopFrac, hopPointAt, decodePolyline } = KANTE_LIVE;

console.log('gliding to a newer answer');
{
  // a vehicle 100 s from stop to stop (rate 0.01 a second); an answer at 30 s puts it 20 s further on than shown
  const rate = 0.01, dt = 0.08;
  let shownF = 0.3, target = 0.5, maxStep = 0, back = false, t = 0;
  while (t < 40) {
    const next = glide(shownF, target, rate, dt);
    maxStep = Math.max(maxStep, (next - shownF) / dt);
    back ||= next < shownF - 1e-12;
    shownF = next; target += rate * dt; t += dt;
  }
  check(!back, 'behind: never backwards');
  check(maxStep <= 2 * rate + 1e-9, `behind: at most twice its pace (${(maxStep / rate).toFixed(2)}×)`);
  check(Math.abs(shownF - target) < 0.002, `behind: caught up within 40 s, closing 1 s of travel a second (${((target - shownF) * 100).toFixed(2)} s of travel left)`);
}
{
  // ahead: an answer puts it 10 s behind what is shown; it slows down, never goes back
  const rate = 0.01, dt = 0.08;
  let shownF = 0.5, target = 0.4, back = false;
  for (let t = 0; t < 30; t += dt) { const next = glide(shownF, target, rate, dt); back ||= next < shownF - 1e-12; shownF = next; target += rate * dt; }
  check(!back && Math.abs(shownF - target) < 0.003, `ahead: waits for it, never backwards (${((shownF - target) * 100).toFixed(2)} s apart after 30 s)`);
}
check(glide(0.1, 0.9, 0.01, 0.08) === 0.9, 'a gap of more than a minute of travel is jumped');
{
  // shown 92 % along A→B when an answer has it 7 s into B→C: it drives into B first, then on; no leap past the stop
  const { showVehicle } = KANTE_LIVE;
  const A: LngLat = [7.44, 46.94], B: LngLat = [7.45465, 46.94], C: LngLat = [7.45465, 46.95];
  const ab = { from: A, to: B, dep: 0, arr: 100, nextSeq: 2, frac: 0.92, t: 92 };
  const bc = { from: B, to: C, dep: 100, arr: 200, nextSeq: 3, frac: 0.07, t: 107 };
  let s = showVehicle(null, ab, 92, 0), worst = 0;
  for (let ms = 80; ms <= 20000; ms += 80) {
    const next = showVehicle(s, bc, 107 + ms / 1000, ms);
    worst = Math.max(worst, KANTE_LIVE.distKm(s.ll, next.ll) * 1000);
    s = next;
  }
  // 1.1 km in 100 s is 11 m/s: at twice that, under 2 m in a frame
  check(worst < 2, `an answer already past the stop: it drives into it and on (at most ${worst.toFixed(1)} m in a frame)`);
  // shown leaving A (driven on past its forecast departure), then an answer with it still at A (a delay): it waits
  const atA = { from: A, to: A, dep: 130, arr: 0, nextSeq: 1, point: A, onward: { nextSeq: 2, to: B, dep: 100, arr: 200 } };
  let w = showVehicle(null, atA, 110, 0);
  const shownOut = w.ll;
  const late = { ...atA, dep: 140, onward: { ...atA.onward, dep: 140, arr: 240 } };
  let back = 0;
  for (let ms = 80; ms <= 5000; ms += 80) {
    const next = showVehicle(w, late, 110 + ms / 1000, ms);
    back = Math.max(back, KANTE_LIVE.distKm(shownOut, A) * 1000 - KANTE_LIVE.distKm(next.ll, A) * 1000);
    w = next;
  }
  check(KANTE_LIVE.distKm(shownOut, A) > 0.05 && back < 0.5, `a delay after it was shown leaving: it waits, not back to the stop (${(back).toFixed(1)} m back)`);
  // the same hop with new times (a delay) moves nothing by itself
  const hop = { from: A, to: B, dep: 0, arr: 100, nextSeq: 2, frac: 0.3, t: 30 };
  const s1 = showVehicle(null, hop, 30, 0), s2 = showVehicle(s1, { ...hop, arr: 160, frac: 0.25, t: 40 }, 30.08, 80);
  check(KanteLiveDist(s1.ll, s2.ll) < 3, `new times for the same hop: no jump (${KanteLiveDist(s1.ll, s2.ll).toFixed(1)} m in a frame)`);
}
function KanteLiveDist(a: LngLat, b: LngLat) { return KANTE_LIVE.distKm(a, b) * 1000; }
check(glide(null, 0.4, 0.01, 0.08) === 0.4, 'nothing shown yet: where the answer puts it');
{
  // standing still (rate 0), shown 200 m short of it: it gets there all the same
  let km = 1.0;
  for (let t = 0; t < 15; t += 0.05) km = glide(km, 1.2, 0, 0.05, 0.5);
  check(Math.abs(km - 1.2) < 0.002, `a vehicle standing still is reached (${((1.2 - km) * 1000).toFixed(1)} m short after 15 s)`);
}

console.log('along the way it takes');
{
  // an L-shaped hop: 1.1 km east, then 1.1 km north (encoded polyline, as the engine sends it)
  const enc = '_~n}G_cll@?qzAo}@?';
  const pts = decodePolyline(enc);
  check(pts.length === 3 && Math.abs(pts[1][0] - pts[0][0] - 0.01465) < 1e-6, `the polyline decodes (${JSON.stringify(pts)})`);
  const v = { from: pts[0], to: pts[2], dep: 1000, arr: 1100, hopPath: enc, frac: 0.25, t: 1000 };
  const mid = hopPointAt(v, 0.5);
  check(Math.abs(mid[0] - pts[1][0]) < 2e-4 && Math.abs(mid[1] - pts[1][1]) < 2e-4, 'halfway in time is at the corner, not across it');
  check(Math.abs(hopFrac(v, 1025) - 0.5) < 1e-9, 'its share goes on from frac at the pace of dep→arr');
  // only part of the way sent (hopSpan): the second half; at 75 % of the whole it is halfway along the part
  const part = { ...v, hopPath: '_~n}Gq~nl@o}@?', hopSpan: [0.5, 1] as [number, number] };
  const q = hopPointAt(part, 0.75), corner = pts[1], end = pts[2];
  check(Math.abs(q[1] - (corner[1] + end[1]) / 2) < 2e-4, 'a part of the way: placed by its span');
}

console.log('speeding up and braking (the engine\'s motion)');
{
  const { wayShare, setLineRefiner } = KANTE_LIVE;
  // a tram: 1.2 m/s² both ways, cruising at 9.62 m/s, 500 m in 60 s (as the engine works it out)
  const m: [number, number, number] = [1.2, 1.2, 9.62], len = 500, t = 60;
  check(Math.abs(wayShare(m, len, t, 5 / 60) * len - 15) < 0.1, `5 s after leaving: 15 m on (${(wayShare(m, len, t, 5 / 60) * len).toFixed(1)} m), not 42 m`);
  check(Math.abs(wayShare(m, len, t, 0.5) - 0.5) < 0.01, 'halfway in time: halfway along (the same rates both ways)');
  check(Math.abs(wayShare(m, len, t, 1) - 1) < 1e-6 && wayShare(m, len, t, 0) === 0, 'from the stop to the next');
  check(wayShare(null, len, t, 0.3) === 0.3, 'without a motion: an even pace');
  // the map's own lines: buses are laid onto its roads; on rails the engine's way (already on the drawn rails)
  const enc = '_~n}G_cll@?qzAo}@?';
  const rawCum = (pts: LngLat[]) => pts.map((_, k) => pts.slice(1, k + 1).reduce((m, p, j) => m + KANTE_LIVE.distKm(pts[j], p), 0));
  setLineRefiner((pts) => ({ pts: pts.map(([x, y]) => [x, y + 0.00001] as LngLat), cum: rawCum(pts), complete: true }));
  const base = { from: [0, 0] as LngLat, to: [1, 1] as LngLat, dep: 0, arr: 100, hopPath: enc };
  const tram = hopPointAt({ ...base, line: { mode: 'tram' } }, 0.25), bus = hopPointAt({ ...base, line: { mode: 'bus' } }, 0.25);
  check(Math.abs(bus[1] - tram[1] - 0.00001) < 1e-9, 'a bus is drawn on the map\'s roads, a tram on the engine\'s way');
  // the laid way keeps the engine's way's length as its measure: the same share is as far along on both
  setLineRefiner((pts) => ({ pts: pts.map(([x, y], k) => [x, y + 0.0001 * k] as LngLat), cum: rawCum(pts), complete: true }));
  const shifted = hopPointAt({ ...base, line: { mode: 'bus' } }, 0.25);
  check(Math.abs(shifted[0] - tram[0]) < 1e-9, 'a laid way is measured along the engine\'s way');
  setLineRefiner(null);
}

console.log('the vehicle\'s body');
{
  const { bodyAt, distKm } = KANTE_LIVE;
  const len = (pts: LngLat[]) => pts.slice(1).reduce((m, p, k) => m + distKm(pts[k], p) * 1000, 0);
  // the L-shaped hop (1.1 km east, 1.1 km north): a 40 m tram halfway, at the corner, bends round it
  const enc = '_~n}G_cll@?qzAo}@?';
  const tram = { from: [7.44, 46.94] as LngLat, to: [7.45465, 46.95] as LngLat, dep: 0, arr: 100, hopPath: enc, line: { mode: 'tram' as KanteMode } };
  const b = bodyAt(tram, 0.5, 40)!;
  check(!!b && Math.abs(len(b) - 40) < 0.5 && b.length === 3, `40 m long along its way, round the corner (${b && len(b).toFixed(1)} m, ${b && b.length} points)`);
  // at the start of its hop: half of it behind the stop, straight back
  const b0 = bodyAt(tram, 0, 40)!;
  check(Math.abs(len(b0) - 40) < 0.5 && b0[0][0] < 7.44, `at the stop it left: across it (${len(b0).toFixed(1)} m)`);
  // standing, with the hop it leaves on: across its platform, along the way out
  const at = { from: [7.44, 46.94] as LngLat, to: [7.44, 46.94] as LngLat, dep: 0, arr: 0, point: [7.44, 46.94] as LngLat, line: { mode: 'tram' as KanteMode },
    onward: { nextSeq: 2, to: [7.45465, 46.95] as LngLat, dep: 10, arr: 100, hopPath: enc } };
  const bs = bodyAt(at, 0, 40)!;
  check(!!bs && Math.abs(len(bs) - 40) < 0.5, `standing at a stop: across its platform (${bs && len(bs).toFixed(1)} m)`);
  check(bodyAt({ ...at, onward: undefined }, 0, 40) === null, 'standing, nothing known of its way: no body (its pictogram)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
