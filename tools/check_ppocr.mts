// Runs the web's PP-OCR front end (src/ppocr.ts) in Node with onnxruntime-web, the same runtime as the browser, on
// rendered LED displays (tools/fixtures/ppocr-display-*.png: our own pictures, a near and a far one), and checks that
// it reads them. Not part of `npm test`: it needs onnxruntime-web and the two models (about 13 MB).
//
//   npm i --no-save onnxruntime-web@1.20.1
//   node tools/check_ppocr.mts                 # fetches the models from Hugging Face (SHA-256 checked)
//   node tools/check_ppocr.mts --models DIR    # or det.onnx and rec.onnx from DIR (checked the same way)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadModels, readRegion } from '../src/ppocr.ts';
import type { OcrImage, OcrRuntime } from '../src/ppocr.ts';
import { ARCORE } from '../src/arcore.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };

/** 8-bit RGB/RGBA, non-interlaced PNG → RGBA (enough for the fixtures). */
function readPng(file: string): OcrImage {
  const b = fs.readFileSync(file);
  let p = 8, width = 0, height = 0, type = 0;
  const idat: Buffer[] = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), kind = b.toString('latin1', p + 4, p + 8), data = b.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); type = data[9]; if (data[8] !== 8 || data[12]) throw new Error('unsupported PNG'); }
    if (kind === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (!bpp) throw new Error('unsupported PNG colour type ' + type);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = width * bpp;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, up = y ? px[(y - 1) * stride + x] : 0, ul = y && x >= bpp ? px[(y - 1) * stride + x - bpp] : 0;
      const pa = Math.abs(up - ul), pb = Math.abs(a - ul), pc = Math.abs(a + up - 2 * ul);
      const pred = [0, a, up, (a + up) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? up : ul][f];
      px[y * stride + x] = (row[x] + pred) & 255;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) for (let k = 0; k < 4; k++) data[i * 4 + k] = k < bpp ? px[i * bpp + k] : 255;
  return { data, width, height };
}

let ort: OcrRuntime & { env: { wasm: { numThreads: number } } };
try { ort = await import('onnxruntime-web' as string) as typeof ort; } catch (e) {
  console.log('onnxruntime-web is not installed: npm i --no-save onnxruntime-web@1.20.1');
  process.exit(2);
}
ort.env.wasm.numThreads = 1;
const dir = arg('--models');
const started = Date.now();
const models = await loadModels(ort, dir ? async (u) => {
  const b = fs.readFileSync(path.join(dir, u.includes('_det_') ? 'det.onnx' : 'rec.onnx'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
} : undefined);
console.log(`models ready in ${Date.now() - started} ms`);

const board = [{ line: '10', destination: 'Ostermundigen, Rüti' }, { line: '10', destination: 'Köniz, Schliern' }, { line: '9', destination: 'Wabern, Tram-Endstation' }];
let failed = 0;
for (const name of ['near', 'far']) {
  const img = readPng(path.join(ROOT, 'tools', 'fixtures', `ppocr-display-${name}.png`));
  const t0 = Date.now();
  const words = await readRegion(models, img);
  const ms = Date.now() - t0;
  const m = ARCORE.match(words.map((w) => ({ text: w.text, box: w.box, score: w.score })), board);
  const ok = m.outcome === 'matched' && m.best!.candidate.destination === 'Ostermundigen, Rüti' && m.best!.line === 'exact';
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name} ${img.width}×${img.height}, ${ms} ms: ${words.map((w) => `"${w.text}" ${w.score.toFixed(2)}`).join(', ')} → ${m.outcome} ${m.best ? m.best.candidate.line + ' ' + m.best.candidate.destination + ' (' + m.best.line + ')' : ''}`);
}
process.exit(failed ? 1 : 0);
