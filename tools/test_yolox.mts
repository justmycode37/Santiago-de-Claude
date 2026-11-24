// Unit tests for src/yolox.ts without the model: the input letterbox and the output decoding (grid, stride, NMS).
import { yoloxDecode, yoloxInput } from '../src/yolox.ts';

let passed = 0, failed = 0;
const check = (ok: boolean, what: string) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };
const close = (a: number, b: number, e = 1e-3) => Math.abs(a - b) < e;

console.log('Input');
const img = { width: 832, height: 416, data: new Uint8ClampedArray(832 * 416 * 4) };
for (let i = 0; i < 832 * 416; i++) img.data.set([200, 100, 50, 255], i * 4);
const inp = yoloxInput(img);
const n = 416 * 416;
check(close(inp.r, 0.5), `scale ${inp.r}: the long side fits 416`);
check(inp.data[0] === 50 && inp.data[n] === 100 && inp.data[2 * n] === 200, 'BGR, 0–255, the picture top left');
check(inp.data[300 * 416 + 10] === 114, 'the rest filled with 114');

console.log('Decoding');
const raw = new Float32Array(3549 * 85);
// one bus at stride 32, cell (gx 5, gy 4): k = 52*52 + 26*26 + 4*13 + 5
const k = 52 * 52 + 26 * 26 + 4 * 13 + 5, o = k * 85;
raw.set([0.5, 0.5, Math.log(4), Math.log(2), 0.9], o); raw[o + 5 + 5] = 0.9; // centre (5.5, 4.5) cells, 4 x 2 cells
// the same vehicle seen by a neighbouring cell, weaker: suppressed
const k2 = k + 1, o2 = k2 * 85;
raw.set([-0.5, 0.5, Math.log(4), Math.log(2), 0.8], o2); raw[o2 + 5 + 6] = 0.8;
// a person (class 0): never kept
const k3 = 100, o3 = k3 * 85;
raw.set([0, 0, 0, 0, 0.99], o3); raw[o3 + 5] = 0.99;
const boxes = yoloxDecode(raw, 0.5, 832, 416);
check(boxes.length === 1, `one vehicle (NMS across bus and train; no person): ${boxes.length}`);
const b = boxes[0].box;
// centre 5.5*32 = 176, 4.5*32 = 144 input px; size 128 x 64; / r 0.5 -> picture px: x 224..480, y 224..352
check(boxes[0].cls === 'bus' && close(boxes[0].score, 0.81), `bus, score obj x cls (${boxes[0].score})`);
check(close(b[0], 224 / 832) && close(b[1], 224 / 416) && close(b[2], 256 / 832) && close(b[3], 128 / 416), `box back in the picture (${b.map((v) => v.toFixed(3))})`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
