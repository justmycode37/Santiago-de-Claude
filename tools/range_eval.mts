// Reading-range pilot, stage D (docs/ar-reading-range.md): the web's PP-OCR front end (src/ppocr.ts) reads the crops
// range_crops.py cut (each frame's display band, and the aligned 3-frame best-contrast and max composites), the
// bench's front end has read them already; both are judged by the display matcher (src/arcore.ts) against the bench's
// board, by the display's glyph height in pixels:
//   - per frame: did this one view name the right display (matched, and the right one), the wrong one, or neither;
//   - per pass, at a 0.6 s OCR cadence: when did decide() first accept the right ride (and at what glyph height), and
//     did it ever accept a wrong one (the same trials as the bench: same line, same destination, two others).
//
//   npm i --no-save onnxruntime-web@1.20.1
//   node tools/range_eval.mts OUT_DIR [OUT_DIR…] --models DIR [--bench rightside/tools/display-bench/data]
// (one OUT_DIR of range_crops.py per video). A vehicle cut off by the picture's edge is left out of the per-view table:
// its band need not hold the display, and its glyph size is not known.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModels, readRegion, PPOCR_LIMITS } from '../src/ppocr.ts';
import type { OcrRuntime } from '../src/ppocr.ts';
import { ARCORE as A } from '../src/arcore.ts';
import type { ArBox, ArCandidate, ArReading, ArText } from '../src/arcore.ts';
import { readPng } from './png.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const DIRS: string[] = [];
for (let i = 2; i < process.argv.length && !process.argv[i].startsWith('--'); i++) DIRS.push(process.argv[i]);
const BENCH = arg('--bench', path.join(ROOT, 'rightside', 'tools', 'display-bench', 'data'))!;
interface Row { event: number; frame: number; t: number; line: string; destination: string; box: ArBox; glyphPx: number; crop: string;
  region: [number, number, number, number]; best?: string; max?: string; bench: { text: string; score: number; box: number[] }[]; dir: string }
const data = { video: '', frames: [] as Row[], skipped: [] as unknown[] };
for (const d of DIRS) {
  const one = JSON.parse(fs.readFileSync(path.join(d, 'range.json'), 'utf8')) as { video: string; frames: Row[]; skipped: unknown[]; sized?: { event: number; from: number }[] };
  // passes whose glyphs were sized from fewer than three reads of their own display (a logo or a single misread can
  // pass for it): left out
  const unsized = new Set((one.sized || []).filter((x) => x.from < 3).map((x) => x.event));
  one.skipped.push(...[...unsized].map((event) => ({ event, why: 'glyphs sized from fewer than three reads' })));
  one.frames = one.frames.filter((r) => !unsized.has(r.event));
  data.video += (data.video ? ', ' : '') + one.video;
  // passes are numbered per bench set (unique across its videos); keep the directory to find the crops
  data.frames.push(...one.frames.map((r) => ({ ...r, dir: d })));
  data.skipped.push(...one.skipped);
}
const clipped = (r: Row) => r.box[0] < 0.005 || r.box[1] < 0.005 || r.box[0] + r.box[2] > 0.995 || r.box[1] + r.box[3] > 0.995;
const board: ArCandidate[] = JSON.parse(fs.readFileSync(path.join(BENCH, 'bern-board.json'), 'utf8')).candidates.map((c: ArCandidate) => ({ line: c.line, destination: c.destination }));
const W = 1920, H = 1080;

let ort: OcrRuntime & { env: { wasm: { numThreads: number } } };
try { ort = await import('onnxruntime-web' as string) as typeof ort; } catch (e) { console.log('npm i --no-save onnxruntime-web@1.20.1'); process.exit(2); }
ort.env.wasm.numThreads = 1;
const dir = arg('--models');
const models = await loadModels(ort, dir ? async (u) => { const b = fs.readFileSync(path.join(dir, u.includes('_det_') ? 'det.onnx' : 'rec.onnx')); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; } : undefined);

/** crop-relative texts -> picture-relative (as the camera's whole frame) */
const toFrame = (r: Row, box: number[], text: string, score: number): ArText => {
  const [rx, ry, rw, rh] = r.region;
  return { text, score, box: [(rx + box[0] * rw) / W, (ry + box[1] * rh) / H, (box[2] * rw) / W, (box[3] * rh) / H] };
};
const variants: Record<string, (r: Row) => Promise<ArText[] | null>> = {
  'bench, one frame': async (r) => r.bench.map((t) => toFrame(r, t.box, t.text, t.score)),
  'web, one frame': async (r) => web(r, r.crop),
  'web, detector at 960 px': async (r) => web(r, r.crop, 960),
  'web, sharpest of 3': async (r) => (r.best ? web(r, r.best) : null),
  'web, max of 3': async (r) => (r.max ? web(r, r.max) : null),
};
const cache = new Map<string, ArText[]>();
async function web(r: Row, file: string, side = 640) {
  const key = `${r.dir}|${file}|${side}`;
  if (!cache.has(key)) {
    const img = readPng(path.join(r.dir, 'crops', file));
    const was = PPOCR_LIMITS.DET_SIDE;
    PPOCR_LIMITS.DET_SIDE = side;
    const words = await readRegion(models, img);
    PPOCR_LIMITS.DET_SIDE = was;
    cache.set(key, words.map((w) => toFrame(r, w.box, w.text, w.score)));
  }
  return cache.get(key)!;
}

const BUCKETS = [0, 8, 12, 16, 24, 32, 48, 1e9];
const bucketOf = (px: number) => BUCKETS.findIndex((b, i) => px >= b && px < BUCKETS[i + 1]);
const bname = (i: number) => (BUCKETS[i + 1] >= 1e9 ? `≥ ${BUCKETS[i]} px` : `${BUCKETS[i]}–${BUCKETS[i + 1]} px`);
type Tally = { right: number; wrong: number; none: number };
const perFrame: Record<string, Tally[]> = {};
const texts: Record<string, Map<string, ArText[]>> = {};
const t0 = Date.now();
for (const [name, fn] of Object.entries(variants)) {
  perFrame[name] = BUCKETS.slice(0, -1).map(() => ({ right: 0, wrong: 0, none: 0 }));
  texts[name] = new Map();
  for (const r of data.frames) {
    const t = await fn(r);
    if (!t) continue;
    texts[name].set(`${r.event}/${r.frame}`, t);
    const truth = { line: r.line, destination: r.destination };
    if (clipped(r)) continue;
    const m = A.match(t, board);
    const k = m.outcome === 'matched' ? (A.sameDisplay(m.best!.candidate, truth) ? 'right' : 'wrong') : 'none';
    perFrame[name][bucketOf(r.glyphPx)][k]++;
  }
}
console.log(`# Reading range pilot: ${data.video}, ${data.frames.length} frames of ${new Set(data.frames.map((r) => r.event)).size} passes (${data.skipped.length} left out), `
  + `${data.frames.filter(clipped).length} frames with the vehicle cut off by the picture's edge (not in the per-view table); ${Math.round((Date.now() - t0) / 1000)} s
`);
console.log('## One view at a time: right display named / wrong display named / neither\n');
console.log('| glyph height | frames | ' + Object.keys(variants).join(' | ') + ' |');
console.log('|---|---:|' + Object.keys(variants).map(() => '---|').join(''));
for (let i = 0; i < BUCKETS.length - 1; i++) {
  const n = perFrame['bench, one frame'][i];
  const total = n.right + n.wrong + n.none;
  if (!total) continue;
  const cells = Object.keys(variants).map((v) => {
    const x = perFrame[v][i], tot = x.right + x.wrong + x.none;
    return tot ? `${Math.round(100 * x.right / tot)} % / ${x.wrong} / ${Math.round(100 * x.none / tot)} %` : '-';
  });
  console.log(`| ${bname(i)} | ${total} | ${cells.join(' | ')} |`);
}

// passes at a 0.6 s OCR cadence (every third frame at 5 frames/s)
console.log('\n## Passes, read every 0.6 s: first acceptance of the right ride (decide), and any wrong acceptance\n');
console.log('| front end | passes accepted | glyph height at first acceptance (median, smallest) | wrong rides accepted | right ride flagged wrong |');
console.log('|---|---:|---|---:|---:|');
const passes = new Map<number, Row[]>();
for (const r of data.frames) (passes.get(r.event) || passes.set(r.event, []).get(r.event)!).push(r);
let uid = 0;
for (const name of Object.keys(variants)) {
  let accepted = 0, wrongAccepted = 0, rightFlagged = 0, trials = 0;
  const at: number[] = [];
  for (const [, rows] of passes) {
    rows.sort((a, b) => a.frame - b.frame);
    const sampled = rows.filter((_, i) => i % 3 === 0);
    const truth = { line: rows[0].line, destination: rows[0].destination };
    const reads: { r: Row; reading: ArReading }[] = [];
    for (const r of sampled) {
      const t = texts[name].get(`${r.event}/${r.frame}`);
      if (!t) continue;
      reads.push({ r, reading: A.read(t, { box: r.box, score: 0.9 }, [], r.t, `rv${uid++}`, true) });
    }
    const run = (exp: ArCandidate) => {
      let first: Row | null = null, flagged = false;
      for (let i = 0; i < reads.length; i++) {
        const now = reads[i].r.t;
        const d = A.decide(reads.slice(0, i + 1).map((x) => x.reading).filter((x) => now - x.at <= 2), now, { ...exp, board }, now);
        if (d.state === 'match' && !first) first = reads[i].r;
        if (d.state === 'wrong') flagged = true;
      }
      return { first, flagged };
    };
    const pos = run(truth);
    if (pos.first) { accepted++; at.push(pos.first.glyphPx); }
    if (pos.flagged) rightFlagged++;
    const others = board.filter((c) => !A.sameDisplay(c, truth));
    const picks = [...others.filter((c) => A.lineKey(c.line) === A.lineKey(truth.line)).slice(0, 1),
      ...others.filter((c) => A.destinationSimilarity(c.destination, truth.destination) >= 0.9).slice(0, 1), others[0], others[7 % others.length]];
    for (const w of picks) { trials++; if (run(w).first) wrongAccepted++; }
  }
  at.sort((a, b) => a - b);
  console.log(`| ${name} | ${accepted}/${passes.size} | ${at.length ? `${at[at.length >> 1]} px, ${at[0]} px` : '-'} | ${wrongAccepted}/${trials} | ${rightFlagged} |`);
}
