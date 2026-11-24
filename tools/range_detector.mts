// Does the web's vehicle detector lose vehicles whose display could still be read? (docs/ar-reading-range.md; the
// plan's step 5: swap the detector only if recall is the bottleneck.) The web reads displays only on what its detector
// finds. This compares detectors, frame by frame, with the bench's YOLOE boxes on the frames of labelled passes
// (range_crops.py), by the vehicle's height in the picture. That is agreement with another detector, not recall (no
// ground truth here), but a vehicle YOLOE finds and the web's detector misses, at a size where the display is still
// read, is reach the web loses.
//
// Candidates, all off the shelf and permissively licensed (step 5): COCO-SSD lite as today; the same on two overlapping
// parts of the picture (more pixels per vehicle, two runs); COCO-SSD with the full mobilenet_v2 base; YOLOX-nano and
// YOLOX-tiny (Apache-2.0, src/yolox.ts, in onnxruntime-web like the display reader).
//
//   npm i --no-save @tensorflow/tfjs@4.22.0 @tensorflow-models/coco-ssd@2.2.3 jpeg-js@0.4.4 onnxruntime-web@1.20.1
//   node tools/range_detector.mts FRAMES_DIR OUT_DIR [OUT_DIR…] [--sample 400] [--yolox DIR] [--detections det5.jsonl[,…]]
//   (FRAMES_DIR: one folder of 5 frames/s JPEGs per video, as range_detect.py read them; DIR: yolox_nano.onnx,
//   yolox_tiny.onnx)
import fs from 'node:fs';
import path from 'node:path';
import { yoloxDetect } from '../src/yolox.ts';
import type { OcrRuntime, OcrSession } from '../src/ppocr.ts';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const SAMPLE = Number(opt('--sample') || 400);
const YOLOX_DIR = opt('--yolox');
// every YOLOE box of every frame (range_detect.py's output), to count a detector's boxes on no vehicle at all
const ALL = new Map<string, Box[]>();
for (const f of (opt('--detections') || '').split(',').filter(Boolean)) {
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) if (line.trim()) { const d = JSON.parse(line); ALL.set(d.image, d.vehicles.map((v: { box: Box }) => v.box)); }
}
const plain = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [FRAMES, ...DIRS] = plain;
type Box = [number, number, number, number];
interface Row { event: number; frame: number; box: Box; glyphPx: number; crop: string; bench: { text: string }[] }
type Pic = { width: number; height: number; data: Uint8Array };
type Coco = { detect(x: unknown, max?: number, min?: number): Promise<{ bbox: number[]; class: string; score: number }[]> };

const tf = await import('@tensorflow/tfjs' as string) as { tensor3d(d: Uint8Array, s: number[], t: string): { dispose(): void }; setBackend(b: string): Promise<boolean>; ready(): Promise<void> };
const cocoSsd = await import('@tensorflow-models/coco-ssd' as string) as { load(o: object): Promise<Coco> };
const jpeg = (await import('jpeg-js' as string)) as { default: { decode(b: Buffer, o: object): Pic } };
await tf.setBackend('cpu'); await tf.ready();
const lite = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
const full = await cocoSsd.load({ base: 'mobilenet_v2' });
const ort = YOLOX_DIR ? await import('onnxruntime-web' as string) as OcrRuntime & { env: { wasm: { numThreads: number } } } : null;
if (ort) ort.env.wasm.numThreads = 1;
const yolox: Record<string, OcrSession> = {};
if (ort && YOLOX_DIR) for (const m of ['nano', 'tiny']) yolox[m] = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync(path.join(YOLOX_DIR, `yolox_${m}.onnx`))));

const rows: (Row & { video: string })[] = [];
for (const d of DIRS) {
  const one = JSON.parse(fs.readFileSync(path.join(d, 'range.json'), 'utf8')) as { video: string; frames: Row[] };
  rows.push(...one.frames.map((r) => ({ ...r, video: one.video })));
}
// an even spread over the passes and their distances
const step = Math.max(1, Math.floor(rows.length / SAMPLE));
const pick = rows.filter((_, i) => i % step === 0);
const iou = (a: Box, b: Box) => {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]), x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / (a[2] * a[3] + b[2] * b[3] - i);
};
const coco = (m: Coco, min = 0.5) => async (img: Pic, x0 = 0, w = img.width): Promise<Box[]> => {
  // as src/app/ar.ts: at most 6 boxes at 0.5, buses and trains (COCO has no tram)
  let data = img.data;
  if (x0 || w !== img.width) {
    data = new Uint8Array(w * img.height * 3);
    for (let y = 0; y < img.height; y++) data.set(img.data.subarray((y * img.width + x0) * 3, (y * img.width + x0 + w) * 3), y * w * 3);
  }
  const x = tf.tensor3d(data, [img.height, w, 3], 'int32');
  const got = (await m.detect(x, 6, min)).filter((b) => b.class === 'bus' || b.class === 'train')
    .map((b) => [(x0 + b.bbox[0]) / img.width, b.bbox[1] / img.height, b.bbox[2] / img.width, b.bbox[3] / img.height] as Box);
  x.dispose();
  return got;
};
const rgba = (img: Pic) => {
  const o = new Uint8Array(img.width * img.height * 4);
  for (let i = 0; i < img.width * img.height; i++) { o[i * 4] = img.data[i * 3]; o[i * 4 + 1] = img.data[i * 3 + 1]; o[i * 4 + 2] = img.data[i * 3 + 2]; o[i * 4 + 3] = 255; }
  return { data: o, width: img.width, height: img.height };
};
const DETECTORS: Record<string, (img: Pic) => Promise<Box[]>> = {
  'COCO-SSD lite at 0.5 (the web, before)': (img) => coco(lite)(img),
  'COCO-SSD lite at 0.3': (img) => coco(lite, 0.3)(img),
  'COCO-SSD lite, two parts': async (img) => {
    const w = Math.round(img.width * 0.6);
    return [...await coco(lite)(img, 0, w), ...await coco(lite)(img, img.width - w, w)];
  },
  'COCO-SSD mobilenet_v2': (img) => coco(full)(img),
};
if (ort) for (const m of Object.keys(yolox)) for (const min of [0.3, 0.5]) DETECTORS[`YOLOX-${m} at ${min}`] = async (img) => (await yoloxDetect(ort, yolox[m], rgba(img), min)).map((b) => b.box);

const BUCKETS = [0, 0.1, 0.15, 0.2, 0.3, 0.5, 1.01];
const names = Object.keys(DETECTORS);
const tally: Record<string, { n: number; found: number; readable: number; readableFound: number; ms: number }[]> = {};
for (const name of names) tally[name] = BUCKETS.slice(0, -1).map(() => ({ n: 0, found: 0, readable: 0, readableFound: 0, ms: 0 }));
const extra: Record<string, number> = {}; // boxes on no YOLOE vehicle (a false-detection proxy)
let withAll = 0;
const t0 = Date.now();
for (const r of pick) {
  const img = jpeg.default.decode(fs.readFileSync(path.join(FRAMES, r.video, String(r.frame).padStart(5, '0') + '.jpg')), { useTArray: true, formatAsRGBA: false });
  const k = BUCKETS.findIndex((b, i) => r.box[3] >= b && r.box[3] < BUCKETS[i + 1]);
  const readable = r.bench.length > 0; // the bench's front end read some text on it
  const yoloe = ALL.get(`${r.video}/${String(r.frame).padStart(5, '0')}.jpg`);
  if (yoloe) withAll++;
  for (const name of names) {
    const s = Date.now();
    const boxes = await DETECTORS[name](img);
    const hit = boxes.some((b) => iou(b, r.box) >= 0.3);
    if (yoloe) extra[name] = (extra[name] || 0) + boxes.filter((b) => yoloe.every((y) => iou(b, y) < 0.3)).length;
    const t = tally[name][k];
    t.ms += Date.now() - s; t.n++; if (hit) t.found++;
    if (readable) { t.readable++; if (hit) t.readableFound++; }
  }
}
console.log(`# Vehicle detectors against YOLOE (bench) on ${pick.length} frames of labelled passes, ${Math.round((Date.now() - t0) / 1000)} s\n`);
console.log('Share of the frames where the detector finds the labelled vehicle (IoU >= 0.3), by its height in the picture; in brackets, of the frames where the bench read text on it. Node CPU ms per frame (not a phone).\n');
console.log('| vehicle height | frames | ' + names.join(' | ') + ' |');
console.log('|---|---:|' + names.map(() => '---|').join(''));
const p = (a: number, n: number) => (n ? `${Math.round(100 * a / n)} %` : '-');
BUCKETS.slice(0, -1).forEach((b, i) => {
  const n = tally[names[0]][i].n;
  if (!n) return;
  console.log(`| ${b}–${Math.min(1, BUCKETS[i + 1])} | ${n} | ` + names.map((nm) => { const t = tally[nm][i]; return `${p(t.found, t.n)} (${p(t.readableFound, t.readable)})`; }).join(' | ') + ' |');
});
if (withAll) console.log(`| boxes on no YOLOE vehicle, per frame (${withAll} frames) | | ` + names.map((nm) => ((extra[nm] || 0) / withAll).toFixed(2)).join(' | ') + ' |');
console.log('| ms per frame | | ' + names.map((nm) => String(Math.round(tally[nm].reduce((a, t) => a + t.ms, 0) / Math.max(1, tally[nm].reduce((a, t) => a + t.n, 0))))).join(' | ') + ' |');
