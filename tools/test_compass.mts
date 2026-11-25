// Tests for src/compass.ts: where the phone faces, and how wide the blue dot's beam is (src/app/heading.ts).
//
//   node tools/test_compass.mts
import { CompassFilter, SPREAD_MIN, angDiff, compassOff, compassReading } from '../src/compass.ts';

let passed = 0, failed = 0;
const check = (ok: boolean, what: string) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };
const near = (a: number | null | undefined, b: number, tol = 0.5) => a != null && Math.abs(angDiff(a, b)) <= tol;
const w3c = (alpha: number, beta: number, gamma: number, absolute = true) => ({ alpha, beta, gamma, absolute });

console.log('Direction (W3C angles, Android)');
check(near(compassReading(w3c(0, 0, 0))?.deg, 0), 'flat, top to the north → 0°');
check(near(compassReading(w3c(90, 0, 0))?.deg, 270), 'flat, turned a quarter left (α 90) → 270°');
check(near(compassReading(w3c(300, 0, 0))?.deg, 60), 'flat, α 300 → 60°');
check(near(compassReading(w3c(0, 45, 0))?.deg, 0), 'tilted towards you → where its top points');
check(near(compassReading(w3c(0, 90, 0))?.deg, 0), 'upright → where the camera looks (the same way)');
check(near(compassReading(w3c(0, 120, 0))?.deg, 0), 'past upright → still where the camera looks, not behind you');
check(near(compassReading(w3c(0, 0, 0), 90)?.deg, 90), 'flat in landscape (screen turned 90°) → the top of the screen');
check(near(compassReading(w3c(0, 0, 0), 270)?.deg, 270), 'flat in the other landscape → 270°');
check(compassReading(w3c(0, 180, 0)) == null, 'screen down, camera at the sky → none');
check(compassReading(w3c(0, -55, 0)) == null, 'tilted 55° away (top down, screen up): you could be on either side → none');
check(near(compassReading(w3c(0, -10, 0))?.deg, 0), 'nearly flat, top slightly down → still the top');
check(near(compassReading(w3c(0, -90, 0))?.deg, 180), 'upright upside down, screen to the north → you look south');
check(near(compassReading(w3c(0, 0, 90), 270)?.deg, 270), 'upright on its side (landscape), screen to the east → you look west');
// tilting the phone without turning it never flips the direction
let flips = 0, prev: number | null = null;
for (let b = -180; b <= 180; b += 1) {
  const r = compassReading(w3c(30, b, 0));
  if (r && prev != null && Math.abs(angDiff(r.deg, prev)) > 5) flips++;
  prev = r ? r.deg : null;
}
check(flips === 0, `tilting from −180° to 180° (α 30): no jump between neighbouring readings (${flips})`);
check(near(compassReading(w3c(0, -65, 0))?.deg, compassReading(w3c(0, -67, 0))!.deg, 2), 'β −65° and −67° agree');
check(compassReading(w3c(0, 0, 0, false)) == null, 'not relative to north → none');
check(compassReading({ alpha: 0, beta: 0, gamma: 0 }) == null, 'absolute unknown (iOS without a compass heading) → none');
check(near(compassReading(w3c(0, 0, 30))?.deg, 0, 5), 'flat, wrist rolled 30° → within 5° of the top');
check(near(compassReading(w3c(0, 35, 20))?.deg, 0, 8), 'reading tilt with a 20° roll → within 8° of the top');
check(compassReading({ alpha: null, beta: null, gamma: null }) == null, 'no angles → none');

console.log('Direction (iOS)');
const ios = (h: number, acc: number) => ({ alpha: 10, beta: 0, gamma: 0, webkitCompassHeading: h, webkitCompassAccuracy: acc });
check(near(compassReading(ios(100, 15))?.deg, 100) && compassReading(ios(100, 15))!.acc === 15, 'heading and its accuracy as reported');
check(near(compassReading(ios(300, 15), 90)?.deg, 30), 'turned screen corrects it');
check(compassReading({ ...ios(0, -1) }) == null && compassOff(ios(0, -1)), 'accuracy −1 (no compass: heading 0) → none, and off');

console.log('Beam');
const run = (readings: [number, number | null][], dt = 50) => {
  const f = new CompassFilter();
  readings.forEach(([deg, acc], i) => f.update({ deg, acc }, i * dt));
  return f;
};
const steady = run(Array.from({ length: 200 }, () => [80, 8] as [number, number]));
check(near(steady.deg, 80) && Math.abs(steady.spread - SPREAD_MIN) < 0.5, `steady, sure phone → narrowest beam (${steady.spread.toFixed(1)}°)`);
const unsure = run(Array.from({ length: 200 }, () => [80, 45] as [number, number]));
check(Math.abs(unsure.spread - 45) < 1, `reported ±45° → 45° each side (${unsure.spread.toFixed(1)}°)`);
const unknown = run(Array.from({ length: 200 }, () => [80, null] as [number, null]));
check(unknown.spread > 20 && unknown.spread < 25, `Android, steady → ~22° (${unknown.spread.toFixed(1)}°)`);
const noisy = run(Array.from({ length: 200 }, (_, i) => [80 + (i % 2 ? 35 : -35), 8] as [number, number]));
check(noisy.spread > 40, `readings jumping ±35° → wide, whatever is reported (${noisy.spread.toFixed(1)}°)`);
const wrap = run(Array.from({ length: 60 }, (_, i) => [i < 20 ? 350 : 10, 8] as [number, number]));
check(near(wrap.deg, 10, 1), `350° → 10° turns through north (${wrap.deg!.toFixed(1)}°)`);
const mid = run([[350, 8], [10, 8]]);
check(near(mid.deg, 355), `one step 350° → 10° goes a quarter of the way: 355° (${mid.deg!.toFixed(1)}°)`);
const f = run([[0, 8], [0, 8]]);
f.update({ deg: 180, acc: 8 }, 10000);
check(near(f.deg, 180), 'after a pause, starts again from the new reading');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
