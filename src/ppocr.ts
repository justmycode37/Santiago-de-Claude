// PP-OCRv5 in the browser, for the AR camera's vehicle displays: PaddlePaddle's mobile text detector (DB) finds the
// lines of text in a crop, the latin recogniser reads each one (the weights the iOS app bundles as
// VehicleDisplayRecognizer). Both run in onnxruntime-web (WebAssembly). The same front end as the display bench's
// rightside/tools/display-bench/ocr_frames.py, so what the bench measures is what the web runs.
//
// The work is plain functions on RGBA pixels (no DOM), so Node runs them with onnxruntime-web too
// (tools/check_ppocr.mts); src/app/ar.ts draws the crops and calls readRegion().
//
// Models: Apache-2.0, fetched from Hugging Face at a fixed revision and checked against their SHA-256 before use.
import { PPOCR_LATIN_CHARS } from './ppocr-chars.ts';

export const PPOCR_MODELS = {
  det: {
    url: 'https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/e6f4fa85f00e168c862bc462aebca69eef9b3d3d/inference.onnx',
    sha256: 'a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d',
  },
  rec: {
    url: 'https://huggingface.co/PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx/resolve/89d3a50e2c27e2e7cceeab0e944c25c807d5db4f/inference.onnx',
    sha256: '7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498',
  },
};

/** RGBA pixels, row by row. */
export interface OcrImage { data: Uint8ClampedArray | Uint8Array; width: number; height: number }
/** One line of text read: box normalised to the whole picture ([x, y, w, h], top-left origin), score 0–1. */
export interface OcrWord { text: string; score: number; box: [number, number, number, number] }
/** What of onnxruntime-web this needs (the browser's global `ort`, or the npm module in Node). */
export interface OcrRuntime {
  InferenceSession: { create(model: Uint8Array, options?: object): Promise<OcrSession> };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
}
export interface OcrSession {
  readonly inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown; dims: readonly number[] }>>;
}
export interface OcrModels { rt: OcrRuntime; det: OcrSession; rec: OcrSession }

export const PPOCR_LIMITS = {
  /** The detector's input: the crop's long side scaled to this, at most doubled (small, far displays). */
  DET_SIDE: 640,
  DET_UPSCALE: 2,
  /** DB post-processing, as PaddleOCR's and the bench's: pixel threshold, box score, unclip ratio. */
  DET_THRESH: 0.3, BOX_THRESH: 0.6, UNCLIP: 1.6,
  /** Lines read per crop, biggest first. */
  MAX_LINES: 8,
  /** The recogniser's input height, and the widest line it is given. */
  REC_H: 48, REC_MAX_W: 960,
  /** Each line is read with this much more height above and below (of its own height): a display's route number is
   *  often taller than its destination, and the detector sizes the line by the destination. */
  REC_PAD_Y: 0.2,
};

// ---------------------------------------------------------------- pixels
/**
 * Resize an RGBA region (x, y, w, h in source pixels) to outW × outH: bilinear, averaged over k × k samples per output
 * pixel when shrinking (k = the shrink factor, rounded up). Point sampling would alias an LED display's dot grid
 * into gaps that split its digits apart.
 */
export function resizeRegion(img: OcrImage, x: number, y: number, w: number, h: number, outW: number, outH: number): OcrImage {
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sx = w / outW, sy = h / outH, W = img.width, H = img.height, d = img.data;
  const kx = Math.max(1, Math.ceil(sx - 1e-9)), ky = Math.max(1, Math.ceil(sy - 1e-9)), acc = [0, 0, 0, 0];
  for (let oy = 0; oy < outH; oy++) for (let ox = 0; ox < outW; ox++) {
    acc[0] = acc[1] = acc[2] = acc[3] = 0;
    for (let j = 0; j < ky; j++) for (let i = 0; i < kx; i++) {
      const fx = Math.min(W - 1, Math.max(0, x + (ox + (i + 0.5) / kx) * sx - 0.5));
      const fy = Math.min(H - 1, Math.max(0, y + (oy + (j + 0.5) / ky) * sy - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(W - 1, x0 + 1), tx = fx - x0, y0 = Math.floor(fy), y1 = Math.min(H - 1, y0 + 1), ty = fy - y0;
      const a = (y0 * W + x0) * 4, b = (y0 * W + x1) * 4, c = (y1 * W + x0) * 4, e = (y1 * W + x1) * 4;
      for (let k = 0; k < 4; k++) acc[k] += (d[a + k] * (1 - tx) + d[b + k] * tx) * (1 - ty) + (d[c + k] * (1 - tx) + d[e + k] * tx) * ty;
    }
    const o = (oy * outW + ox) * 4, n = kx * ky;
    for (let k = 0; k < 4; k++) out[o + k] = acc[k] / n;
  }
  return { data: out, width: outW, height: outH };
}

/** The detector's tensor: BGR, (v/255 − mean) / std, channels first; and its size (multiples of 32). */
export function detInput(img: OcrImage): { data: Float32Array; width: number; height: number } {
  const L = PPOCR_LIMITS;
  const scale = Math.min(L.DET_UPSCALE, L.DET_SIDE / Math.max(img.width, img.height));
  const width = Math.max(32, Math.round(img.width * scale / 32) * 32), height = Math.max(32, Math.round(img.height * scale / 32) * 32);
  const r = resizeRegion(img, 0, 0, img.width, img.height, width, height);
  const n = width * height, out = new Float32Array(3 * n);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let i = 0; i < n; i++) {
    // channel 0 is blue: the model was trained on OpenCV's BGR pictures
    for (let ch = 0; ch < 3; ch++) out[ch * n + i] = (r.data[i * 4 + (2 - ch)] / 255 - mean[ch]) / std[ch];
  }
  return { data: out, width, height };
}

/**
 * DB post-processing: the detector's probability map → text boxes, [x0, y0, x1, y1] normalised to the map. The pixels
 * above DET_THRESH, dilated by one pixel right and down (PaddleOCR's use_dilation: an LED display's dot grid otherwise
 * breaks big digits apart); each connected region whose mean probability is at least BOX_THRESH, grown by
 * area × UNCLIP / perimeter on every side (PaddleOCR grows the region's polygon the same way; displays are level, so
 * its bounding box does).
 */
export function dbBoxes(prob: Float32Array, width: number, height: number): [number, number, number, number][] {
  const L = PPOCR_LIMITS;
  const on = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (prob[y * width + x] <= L.DET_THRESH) continue;
    on[y * width + x] = 1;
    if (x + 1 < width) on[y * width + x + 1] = 1;
    if (y + 1 < height) { on[(y + 1) * width + x] = 1; if (x + 1 < width) on[(y + 1) * width + x + 1] = 1; }
  }
  const seen = new Uint8Array(width * height), stack: number[] = [];
  const out: { box: [number, number, number, number]; area: number }[] = [];
  for (let start = 0; start < prob.length; start++) {
    if (seen[start] || !on[start]) continue;
    let x0 = width, y0 = height, x1 = -1, y1 = -1, sum = 0, count = 0;
    seen[start] = 1; stack.push(start);
    while (stack.length) {
      const p = stack.pop()!, px = p % width, py = (p - px) / width;
      if (prob[p] > L.DET_THRESH) { sum += prob[p]; count++; } // the score: the region's own pixels, not the dilation's
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      const next = [px > 0 ? p - 1 : -1, px < width - 1 ? p + 1 : -1, py > 0 ? p - width : -1, py < height - 1 ? p + width : -1];
      for (const q of next) if (q >= 0 && !seen[q] && on[q]) { seen[q] = 1; stack.push(q); }
    }
    if (count < 6 || sum / count < L.BOX_THRESH) continue;
    const w = x1 - x0 + 1, h = y1 - y0 + 1, grow = (w * h * L.UNCLIP) / (2 * (w + h));
    const box: [number, number, number, number] = [Math.max(0, (x0 - grow) / width), Math.max(0, (y0 - grow) / height),
      Math.min(1, (x1 + 1 + grow) / width), Math.min(1, (y1 + 1 + grow) / height)];
    out.push({ box, area: w * h });
  }
  return out.sort((a, b) => b.area - a.area).map((o) => o.box);
}

/** The recogniser's tensor for one line (x, y, w, h of `img`, default all of it): 48 px high, BGR, v/127.5 − 1,
 *  padded with zeros to at least 320 wide. One resize from the source pixels. */
export function recInput(img: OcrImage, x = 0, y = 0, lw = img.width, lh = img.height): { data: Float32Array; width: number } {
  const L = PPOCR_LIMITS;
  const w = Math.min(L.REC_MAX_W, Math.max(16, Math.ceil(L.REC_H * lw / Math.max(1, lh))));
  const width = Math.max(320, w), r = resizeRegion(img, x, y, lw, lh, w, L.REC_H);
  const n = width * L.REC_H, out = new Float32Array(3 * n); // zeros: the padding
  for (let y = 0; y < L.REC_H; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, o = y * width + x;
    for (let ch = 0; ch < 3; ch++) out[ch * n + o] = r.data[i + (2 - ch)] / 127.5 - 1;
  }
  return { data: out, width };
}

/** Greedy CTC: the best class per step, repeats collapsed, blanks (0) dropped; score: mean probability of the kept steps. */
export function ctcDecode(probs: ArrayLike<number>, steps: number, classes: number, chars: readonly string[] = PPOCR_LATIN_CHARS) {
  let text = '', sum = 0, kept = 0, prev = -1;
  for (let t = 0; t < steps; t++) {
    let best = 0, p = -Infinity;
    for (let c = 0; c < classes; c++) { const v = probs[t * classes + c]; if (v > p) { p = v; best = c; } }
    if (best !== 0 && best !== prev) { text += chars[best] ?? ''; sum += p; kept++; }
    prev = best;
  }
  return { text: text.trim(), score: kept ? sum / kept : 0 };
}

// ---------------------------------------------------------------- the models
/**
 * Read the text in `region` of `img` (pixels; default the whole image). Boxes come back normalised to `frame`
 * (the whole camera picture: its width and height, and where `img` sits in it), as the display matcher wants them.
 */
export async function readRegion(m: OcrModels, img: OcrImage, frame: { width: number; height: number; x: number; y: number } = { width: img.width, height: img.height, x: 0, y: 0 }): Promise<OcrWord[]> {
  const L = PPOCR_LIMITS;
  const det = detInput(img);
  const dout = await m.det.run({ [m.det.inputNames[0]]: new m.rt.Tensor('float32', det.data, [1, 3, det.height, det.width]) });
  const pm = Object.values(dout)[0];
  const boxes = dbBoxes(pm.data as Float32Array, det.width, det.height).slice(0, L.MAX_LINES);
  const words: OcrWord[] = [];
  for (const [bx0, by0, bx1, by1] of boxes) {
    const pad = (by1 - by0) * L.REC_PAD_Y, ty0 = Math.max(0, by0 - pad), ty1 = Math.min(1, by1 + pad);
    const x = bx0 * img.width, y = ty0 * img.height, w = (bx1 - bx0) * img.width, h = (ty1 - ty0) * img.height;
    if (w < 5 || h < 5) continue;
    const rec = recInput(img, x, y, w, h);
    const rout = await m.rec.run({ [m.rec.inputNames[0]]: new m.rt.Tensor('float32', rec.data, [1, 3, L.REC_H, rec.width]) });
    const r = Object.values(rout)[0];
    const [, steps, classes] = r.dims;
    const { text, score } = ctcDecode(r.data as Float32Array, steps, classes);
    if (!text) continue;
    words.push({ text, score, box: [(frame.x + x) / frame.width, (frame.y + y) / frame.height, w / frame.width, h / frame.height] });
  }
  return words;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
/** Fetch both models, check their SHA-256, and open them. Rejects on a network error or a different file. */
export async function loadModels(rt: OcrRuntime, fetchBytes: (url: string) => Promise<ArrayBuffer> = (u) => fetch(u).then((r) => {
  if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
  return r.arrayBuffer();
})): Promise<OcrModels> {
  const open = async (spec: { url: string; sha256: string }) => {
    const bytes = await fetchBytes(spec.url);
    const sum = hex(await crypto.subtle.digest('SHA-256', bytes));
    if (sum !== spec.sha256) throw new Error(`${spec.url}: SHA-256 ${sum}, expected ${spec.sha256}`);
    return rt.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  };
  const [det, rec] = await Promise.all([open(PPOCR_MODELS.det), open(PPOCR_MODELS.rec)]);
  return { rt, det, rec };
}
