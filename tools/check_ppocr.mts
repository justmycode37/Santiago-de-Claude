// Runs the web's PP-OCR front end (src/ppocr.ts) in Node with onnxruntime-web, the same runtime as the browser, on
// rendered LED displays (tools/fixtures/ppocr-display-*.png: our own pictures, a near and a far one), and checks that
// it reads them. Not part of `npm test`: it needs onnxruntime-web and the two models (about 13 MB).
//
//   npm i --no-save onnxruntime-web@1.20.1
//   node tools/check_ppocr.mts                 # fetches the models from Hugging Face (SHA-256 checked)
//   node tools/check_ppocr.mts --models DIR    # or det.onnx and rec.onnx from DIR (checked the same way)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModels, readRegion } from '../src/ppocr.ts';
import type { OcrRuntime } from '../src/ppocr.ts';
import { readPng } from './png.mts';
import { ARCORE } from '../src/arcore.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };


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
