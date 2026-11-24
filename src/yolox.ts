// YOLOX (Megvii, Apache-2.0), an off-the-shelf COCO detector, in onnxruntime-web: a candidate to replace COCO-SSD as
// the AR camera's vehicle detector (docs/ar-recognition-plan.md step 5; docs/ar-reading-range.md measures it). Plain
// functions on RGBA pixels, like ppocr.ts, so Node can run them on the bench.
//
// The 0.1.1rc0 ONNX exports: input 1×3×416×416, BGR 0–255, the picture scaled into the top-left corner and the rest
// filled with 114; output 1×3549×85 per anchor point of strides 8, 16, 32: centre and size (relative to the point
// and the stride), objectness and the 80 COCO class scores (already sigmoid).
import type { OcrImage, OcrRuntime, OcrSession } from './ppocr.ts';

export const YOLOX_MODELS = {
  // served by the site itself (models/yolox/, with its licence): GitHub's release download sends no CORS header
  nano: { url: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx', file: 'models/yolox/yolox_nano.onnx',
    sha256: 'c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d' },
  tiny: { url: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx',
    sha256: '427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7' },
};
/** COCO: 5 bus, 6 train (no tram class: trams come out as either). */
export const YOLOX_CLASSES: Record<number, string> = { 5: 'bus', 6: 'train' };
const SIDE = 416, STRIDES = [8, 16, 32];

export interface YoloxBox { box: [number, number, number, number]; score: number; cls: string }

/** The input tensor and the scale used (picture pixels × r = input pixels). */
export function yoloxInput(img: OcrImage): { data: Float32Array; r: number } {
  const r = Math.min(SIDE / img.width, SIDE / img.height);
  const w = Math.round(img.width * r), h = Math.round(img.height * r), n = SIDE * SIDE;
  const out = new Float32Array(3 * n).fill(114);
  const sx = img.width / w, sy = img.height / h, d = img.data, W = img.width;
  for (let y = 0; y < h; y++) {
    // area average over each output pixel's footprint (a phone frame shrinks 3–5 times)
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r0 = 0, g0 = 0, b0 = 0, c = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * W + xx) * 4; r0 += d[i]; g0 += d[i + 1]; b0 += d[i + 2]; c++; }
      const o = y * SIDE + x;
      out[o] = b0 / c; out[n + o] = g0 / c; out[2 * n + o] = r0 / c; // BGR
    }
  }
  return { data: out, r };
}

/** The input tensor from a 416 × 416 RGBA picture already letterboxed (the browser scales the camera frame into the
 *  top-left corner of a canvas filled with rgb(114, 114, 114)). */
export function yoloxTensor(rgba: ArrayLike<number>): Float32Array {
  const n = SIDE * SIDE, out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { out[i] = rgba[i * 4 + 2]; out[n + i] = rgba[i * 4 + 1]; out[2 * n + i] = rgba[i * 4]; }
  return out;
}
export const YOLOX_SIDE = SIDE;

/** Decode, keep buses and trains above `min`, non-maximum suppression across both classes (one vehicle, one box). */
export function yoloxDecode(raw: ArrayLike<number>, r: number, width: number, height: number, min = 0.3, max = 6): YoloxBox[] {
  const found: YoloxBox[] = [];
  let k = 0;
  for (const s of STRIDES) {
    const g = SIDE / s;
    for (let gy = 0; gy < g; gy++) for (let gx = 0; gx < g; gx++, k++) {
      const o = k * 85, obj = raw[o + 4];
      if (obj < min) continue;
      for (const c of [5, 6]) {
        const score = obj * raw[o + 5 + c];
        if (score < min) continue;
        const cx = (raw[o] + gx) * s, cy = (raw[o + 1] + gy) * s, bw = Math.exp(raw[o + 2]) * s, bh = Math.exp(raw[o + 3]) * s;
        const x0 = Math.max(0, (cx - bw / 2) / r), y0 = Math.max(0, (cy - bh / 2) / r);
        const x1 = Math.min(width, (cx + bw / 2) / r), y1 = Math.min(height, (cy + bh / 2) / r);
        if (x1 > x0 && y1 > y0) found.push({ box: [x0 / width, y0 / height, (x1 - x0) / width, (y1 - y0) / height], score, cls: YOLOX_CLASSES[c] });
      }
    }
  }
  found.sort((a, b) => b.score - a.score);
  const kept: YoloxBox[] = [];
  const iou = (a: YoloxBox['box'], b: YoloxBox['box']) => {
    const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
    return (ix * iy) / (a[2] * a[3] + b[2] * b[3] - ix * iy);
  };
  for (const f of found) {
    if (kept.every((k2) => iou(k2.box, f.box) < 0.45)) kept.push(f);
    if (kept.length === max) break;
  }
  return kept;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
/** Open YOLOX-nano from `bytes` after checking its SHA-256. */
export async function loadYolox(rt: OcrRuntime, bytes: ArrayBuffer): Promise<OcrSession> {
  const sum = hex(await crypto.subtle.digest('SHA-256', bytes));
  if (sum !== YOLOX_MODELS.nano.sha256) throw new Error(`yolox_nano.onnx: SHA-256 ${sum}, expected ${YOLOX_MODELS.nano.sha256}`);
  return rt.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
}

/** Detect on a letterboxed 416 × 416 RGBA picture; boxes normalised to the original picture of width × height. */
export async function yoloxDetectLetterboxed(rt: OcrRuntime, session: OcrSession, rgba: ArrayLike<number>, r: number, width: number, height: number, min = 0.3): Promise<YoloxBox[]> {
  const out = await session.run({ [session.inputNames[0]]: new rt.Tensor('float32', yoloxTensor(rgba), [1, 3, SIDE, SIDE]) });
  return yoloxDecode(Object.values(out)[0].data as Float32Array, r, width, height, min);
}

export async function yoloxDetect(rt: OcrRuntime, session: OcrSession, img: OcrImage, min = 0.3): Promise<YoloxBox[]> {
  const { data, r } = yoloxInput(img);
  const out = await session.run({ [session.inputNames[0]]: new rt.Tensor('float32', data, [1, 3, SIDE, SIDE]) });
  return yoloxDecode(Object.values(out)[0].data as Float32Array, r, img.width, img.height, min);
}
