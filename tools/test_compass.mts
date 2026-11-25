// Tests for src/compass.ts: where the phone faces, and how wide the blue dot's beam is (src/app/heading.ts).
//
//   node tools/test_compass.mts
import { CompassFilter, CourseTracker, SPREAD_MIN, angDiff, bearingDeg, compassOff, compassReading, swissDeclination } from '../src/compass.ts';

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

console.log('True north');
const at2026 = Date.UTC(2026, 10, 25);
check(near(swissDeclination(7.44, at2026), 3.39, 0.1), `Bern, late 2026: 3.4° (${swissDeclination(7.44, at2026).toFixed(2)}°)`);
check(near(swissDeclination(6.14, at2026), 3.08, 0.1), 'Geneva: 3.1°');
check(near(swissDeclination(9.37, at2026), 3.85, 0.1), 'St. Gallen: 3.8°');
check(near(swissDeclination(7.44, Date.UTC(2029, 0, 1)), 3.66, 0.1), 'Bern, 2029: 3.7°');

console.log('Direction you go (GPS)');
const east = (m: number): [number, number] => [7.44 + m / (111320 * Math.cos(46.95 * Math.PI / 180)), 46.95];
const north = (m: number): [number, number] => [7.44, 46.95 + m / 110540];
check(near(bearingDeg(east(0), east(100)), 90) && near(bearingDeg(north(0), north(100)), 0) && near(bearingDeg(north(100), north(0)), 180), 'bearing: east 90°, north 0°, south 180°');
{
  const c = new CourseTracker();
  c.fix(north(0), 5, null, null, 0);
  check(c.fix(north(6), 5, null, null, 4000) == null, 'moved 6 m with fixes ±5 m: not yet clearly anywhere → none');
  const k = c.fix(north(14), 5, null, null, 9000);
  check(near(k?.deg, 0) && k!.spread >= 12 && k!.spread <= 45, `moved 14 m north, no heading from the phone → 0° (±${k?.spread.toFixed(0)}°)`);
  check(c.fix(north(14), 5, null, 0.2, 10000) == null, 'standing (0.2 m/s) → forgotten');
  const p = c.fix(north(14), 5, 270, 1.3, 11000);
  check(near(p?.deg, 270) && p!.spread === 25, 'the phone says 270° at 1.3 m/s → 270°');
  const d = new CourseTracker();
  d.fix(east(0), 40, null, null, 0);
  check(d.fix(east(50), 40, null, null, 5000) == null, 'fixes ±40 m: too rough → none');
  const s = new CourseTracker();
  s.fix(east(0), 5, null, null, 0);
  check(s.fix(east(20), 5, null, null, 60000) == null, 'the earlier fix a minute old → starts again from this one');
  const h = new CourseTracker();
  h.fix(east(0), 80, null, 0, 0); // standing in a station hall: a rough fix
  h.fix(east(0), 5, null, null, 2000); // outside
  const o = h.fix(east(15), 5, null, null, 12000);
  check(near(o?.deg, 90), 'a rough fix indoors is not measured from: 15 m east once outside → 90°');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
