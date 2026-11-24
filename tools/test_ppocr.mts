// Unit tests for src/ppocr.ts's model-free parts: resizing, the two models' inputs, DB boxes and CTC decoding.
// tools/check_ppocr.mts runs the real models on rendered displays (it needs onnxruntime-web and the models).
import { ctcDecode, dbBoxes, detInput, recInput, resizeRegion, PPOCR_LIMITS } from '../src/ppocr.ts';
import { PPOCR_LATIN_CHARS } from '../src/ppocr-chars.ts';

let passed = 0, failed = 0;
const check = (ok: boolean, what: string) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };
const solid = (w: number, h: number, rgba: [number, number, number, number]) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { data, width: w, height: h };
};

console.log('Pixels');
const r = resizeRegion(solid(10, 10, [200, 100, 50, 255]), 0, 0, 10, 10, 4, 3);
check(r.width === 4 && r.height === 3 && r.data[0] === 200 && r.data[1] === 100 && r.data[2] === 50, 'a flat colour stays flat when resized');
// a dot grid (an LED display) shrunk 4×: averaged, not aliased into black or full colour
const grid = solid(16, 16, [0, 0, 0, 255]);
for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (x % 2 === 0 && y % 2 === 0) grid.data[(y * 16 + x) * 4] = 255;
const g = resizeRegion(grid, 0, 0, 16, 16, 4, 4);
check([...Array(16).keys()].every((i) => Math.abs(g.data[i * 4] - 64) <= 16), `a dot grid shrinks to its average (${g.data[0]})`);

console.log('Model inputs');
const d = detInput(solid(300, 100, [0, 0, 255, 255]));
check(d.width % 32 === 0 && d.height % 32 === 0 && d.width === 608 && d.height === 192, `detector input: doubled at most, multiples of 32 (${d.width}×${d.height})`);
const n = d.width * d.height;
check(Math.abs(d.data[0] - (1 - 0.485) / 0.229) < 1e-4 && Math.abs(d.data[2 * n] - (0 - 0.406) / 0.225) < 1e-4, 'detector input is BGR: a blue picture is bright in channel 0');
const big = detInput(solid(2000, 500, [0, 0, 0, 255]));
check(big.width === PPOCR_LIMITS.DET_SIDE && big.height === 160, `a big crop is shrunk to ${PPOCR_LIMITS.DET_SIDE} (${big.width}×${big.height})`);
const rec = recInput(solid(100, 20, [255, 255, 255, 255]));
check(rec.width === 320 && rec.data.length === 3 * 48 * 320 && rec.data[0] === 1 && rec.data[48 * 320 - 1] === 0,
  'recogniser input: 48 high, padded with zeros to 320, white is 1');

console.log('DB boxes');
const W = 64, H = 32, prob = new Float32Array(W * H);
for (let y = 10; y < 16; y++) for (let x = 8; x < 40; x++) prob[y * W + x] = 0.9;   // a line of text
for (let y = 24; y < 26; y++) for (let x = 50; x < 52; x++) prob[y * W + x] = 0.9;  // a speck (4 px)
for (let y = 2; y < 6; y++) for (let x = 50; x < 60; x++) prob[y * W + x] = 0.35;  // faint: under the box score
const boxes = dbBoxes(prob, W, H);
check(boxes.length === 1, `one box: the line; not the speck or the faint patch (${boxes.length})`);
const [x0, y0, x1, y1] = boxes[0];
check(x0 * W < 8 && x1 * W > 40 && y0 * H < 10 && y1 * H > 16, `the line's box is grown around it (${boxes[0].map((v) => v.toFixed(2))})`);

console.log('CTC');
const C = PPOCR_LATIN_CHARS.length, idx = (c: string) => PPOCR_LATIN_CHARS.indexOf(c);
const steps = ['1', '1', '', '0', '0', '', '', 'B', 'B', 'B'].map((c) => (c ? idx(c) : 0));
const probs = new Float32Array(steps.length * C);
steps.forEach((k, t) => { probs[t * C + k] = 0.9; });
const out = ctcDecode(probs, steps.length, C);
check(out.text === '10B' && Math.abs(out.score - 0.9) < 1e-6, `repeats collapse, blanks drop: "${out.text}"`);
check(PPOCR_LATIN_CHARS[0] === '' && PPOCR_LATIN_CHARS[C - 1] === ' ' && C === 838, 'the character list: blank, 836 characters, space');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
