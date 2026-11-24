// The AR camera's labels on the public-video bench, frame by frame (docs/ar-labels-bench.md): how often a labelled
// vehicle is shown certain (green on the rider's own, red on another), white, or nothing, and whether a label is ever
// wrong. It runs the camera's own decision code (src/artrack.ts) at the phone's pace on the bench's videos.
//
// Stage 1 (slow, once): the web's detector (YOLOX nano and tiny, src/yolox.ts) on every frame, and the web's display
// reader (src/ppocr.ts) on every detected vehicle's display band and the road band, every third frame (0.6 s, the
// reader's pace on a phone). Kept in CACHE_DIR, one file per video.
//   npm i --no-save onnxruntime-web@1.20.1 jpeg-js@0.4.4
//   node tools/ar_bench.mts cache FRAMES_DIR RANGE_DIR [RANGE_DIR…] --cache CACHE_DIR --models PPOCR_DIR --yolox YOLOX_DIR [--detectors nano,tiny]
// Stage 2 (seconds): the session, replayed from the cache.
//   node tools/ar_bench.mts run RANGE_DIR [RANGE_DIR…] --cache CACHE_DIR [--det nano|tiny|…] [--detections det5.jsonl]
//
// FRAMES_DIR: one folder of 5 frames/s JPEGs per video; RANGE_DIR: range_crops.py's output for one video (its labelled
// passes: the bench's real line and destination, and the reference detector's box in every frame); det5.jsonl: the
// reference detector's boxes of every vehicle (range_detect.py), to find boxes that span two vehicles.
// Frames and videos stay local; nothing of them is committed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ArBox } from '../src/arcore.ts';
import type { ArBoard, ArDet, ArRide, ArLabel } from '../src/artrack.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const plain = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const [MODE, ...POS] = plain;
const CACHE = opt('--cache')!;
const OCR_EVERY = 3; // frames between two display reads (5 frames/s: 0.6 s)

interface PassRow { event: number; frame: number; line: string; destination: string; box: ArBox }
interface Range { video: string; frames: PassRow[] }
interface Words { text: string; score: number; box: ArBox }
interface Cached { segments: [number, number][]; frames: Record<number, Record<string, ArDet[]> & { reads?: Record<string, Words[]> }> }
// Ties the bench's own tracker got wrong, checked on the frames: a video cut joined two trams into one pass
const FIXES: { video: string; event: number; from?: number; upTo?: number; line: string; destination: string }[] = [
  { video: 'QfULTK-AKAM', event: 203, upTo: 4478, line: '3', destination: 'Bern, Weissenbühl (Tram)' }, // the 3 (fleet 756) before the cut at 4479
  { video: 'SFXYdgCvsik', event: 71, from: 74, line: '8', destination: 'Bern, Saali' }, // the 8 (fleet 661) after the cut at 74
];
/** Cuts in the videos (the first frame after each): a phone never jumps to another street, so the session sees a
 *  turn bigger than any pan there and forgets every vehicle. */
const CUTS: Record<string, number[]> = { 'QfULTK-AKAM': [4479], SFXYdgCvsik: [74] };
const loadRange = (d: string) => {
  const r = JSON.parse(fs.readFileSync(path.join(d, 'range.json'), 'utf8')) as Range;
  for (const f of r.frames) {
    const fix = FIXES.find((x) => x.video === r.video && x.event === f.event && f.frame <= (x.upTo ?? Infinity) && f.frame >= (x.from ?? -Infinity));
    if (fix) Object.assign(f, { event: f.event + 0.5, line: fix.line, destination: fix.destination });
  }
  return r;
};
/** A labelled pass's frames, with 10 frames either side; overlapping ones joined. */
function segments(r: Range): [number, number][] {
  const ev = new Map<number, number[]>();
  for (const f of r.frames) { const a = ev.get(f.event) || []; a.push(f.frame); ev.set(f.event, a); }
  const spans = [...ev.values()].map((fs2) => [Math.max(1, Math.min(...fs2) - 10), Math.max(...fs2) + 10] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const s of spans) { const l = out[out.length - 1]; if (l && s[0] <= l[1]) l[1] = Math.max(l[1], s[1]); else out.push([...s]); }
  return out;
}
/** The display band of a vehicle box, as the phone cuts it (src/app/ar.ts). */
const band = (b: ArBox): ArBox => [b[0] - b[2] * 0.04, b[1], b[2] * 1.08, b[3] * 0.55];
const ROAD: ArBox = [0, 0.2, 1, 0.5];
const iou = (a: ArBox, b: ArBox) => {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return (ix * iy) / Math.max(1e-9, a[2] * a[3] + b[2] * b[3] - ix * iy);
};
const inside = (inner: ArBox, outer: ArBox) => {
  const ix = Math.max(0, Math.min(inner[0] + inner[2], outer[0] + outer[2]) - Math.max(inner[0], outer[0])), iy = Math.max(0, Math.min(inner[1] + inner[3], outer[1] + outer[3]) - Math.max(inner[1], outer[1]));
  return (ix * iy) / Math.max(1e-9, inner[2] * inner[3]);
};

if (MODE === 'cache') {
  const [FRAMES, ...DIRS] = POS;
  type Rt = import('../src/ppocr.ts').OcrRuntime & { env: { wasm: { numThreads: number } } };
  const ort = await import('onnxruntime-web' as string) as Rt;
  ort.env.wasm.numThreads = Number(opt('--threads') || 2);
  const jpeg = (await import('jpeg-js' as string)) as { default: { decode(b: Buffer, o: object): { width: number; height: number; data: Uint8Array } } };
  const { loadModels, readRegion } = await import('../src/ppocr.ts');
  const { yoloxDetect } = await import('../src/yolox.ts');
  const buf = (p: string) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
  const md = opt('--models')!, yd = opt('--yolox')!;
  const ocr = await loadModels(ort, async (u) => buf(path.join(md, u.includes('_det_') ? 'det.onnx' : 'rec.onnx')));
  // detectors: yolox_<name>.onnx in YOLOX_DIR (--detectors nano,tiny,tiny_int8); a cached frame gets the ones it lacks
  const names = (opt('--detectors') || 'nano,tiny').split(',');
  const det: Record<string, import('../src/ppocr.ts').OcrSession> = {};
  for (const m of names) det[m] = await ort.InferenceSession.create(new Uint8Array(buf(path.join(yd, `yolox_${m}.onnx`))));
  fs.mkdirSync(CACHE, { recursive: true });
  for (const d of DIRS) {
    const r = loadRange(d), file = path.join(CACHE, `${r.video}.json`);
    const out: Cached = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { segments: segments(r), frames: {} };
    out.segments = segments(r);
    const t0 = Date.now();
    let n = 0;
    for (const [a, b] of out.segments) for (let f = a; f <= b; f++) {
      const p = path.join(FRAMES, r.video, String(f).padStart(5, '0') + '.jpg');
      const missing = names.filter((m) => !out.frames[f] || !out.frames[f][m]);
      if (!fs.existsSync(p) || !missing.length) continue;
      const img = jpeg.default.decode(fs.readFileSync(p), { useTArray: true, formatAsRGBA: true });
      const box = (x: { box: ArBox; score: number; cls: string }): ArDet => ({ box: x.box.map((v) => +v.toFixed(5)) as ArBox, score: +x.score.toFixed(4), cls: x.cls });
      const fr: Cached['frames'][number] = out.frames[f] || {};
      for (const m of missing) fr[m] = (await yoloxDetect(ort, det[m], img, 0.3)).map(box);
      if ((f - a) % OCR_EVERY === 0) {
        fr.reads ||= {};
        // reads already made (another detector's boxes) serve a box within IoU 0.9 of theirs
        const done: { region: ArBox; words: Words[] }[] = Object.keys(fr).filter((m) => m !== 'reads' && !missing.includes(m))
          .flatMap((m) => fr[m].map((x, i) => ({ region: band(x.box), words: fr.reads![`${m}:${i}`] || [] })));
        const readBand = async (rb: ArBox) => {
          const again = done.find((x) => iou(x.region, rb) >= 0.9);
          if (again) return again.words;
          const x0 = Math.max(0, Math.round(rb[0] * img.width)), y0 = Math.max(0, Math.round(rb[1] * img.height));
          const w = Math.min(img.width - x0, Math.round(rb[2] * img.width)), h = Math.min(img.height - y0, Math.round(rb[3] * img.height));
          let words: Words[] = [];
          if (w >= 24 && h >= 12) {
            const crop = new Uint8Array(w * h * 4);
            for (let y = 0; y < h; y++) crop.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4);
            words = (await readRegion(ocr, { data: crop, width: w, height: h }, { width: img.width, height: img.height, x: x0, y: y0 }))
              .map((x) => ({ text: x.text, score: +x.score.toFixed(4), box: x.box.map((v) => +v.toFixed(5)) as ArBox }));
          }
          done.push({ region: rb, words });
          return words;
        };
        if (!fr.reads.road) fr.reads.road = await readBand(ROAD);
        for (const m of missing) for (let i = 0; i < fr[m].length; i++) fr.reads[`${m}:${i}`] = await readBand(band(fr[m][i].box));
        n++;
      }
      out.frames[f] = fr;
    }
    fs.writeFileSync(file, JSON.stringify(out));
    console.log(`${r.video}: ${Object.keys(out.frames).length} frames, ${n} read, ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- stage 2: the session, replayed
const DET = opt('--det') || 'nano';
// --artrack: another version of the label code, to compare (e.g. a copy of the one before a change)
const { createArSession, AR_LIMITS } = await import(opt('--artrack') ? pathToFileURL(path.resolve(opt('--artrack')!)).href : '../src/artrack.ts') as typeof import('../src/artrack.ts');
const REF = new Map<string, ArBox[]>(); // the reference detector's boxes of every vehicle, by video/frame
for (const f of (opt('--detections') || '').split(',').filter(Boolean)) {
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) if (line.trim()) { const d = JSON.parse(line); REF.set(d.image, d.vehicles.map((v: { box: ArBox }) => v.box)); }
}
// --limits '{"MEMORY_S":30}': try other settings of the label code
const FORGET: Record<string, number> = {};
if (opt('--limits')) Object.assign(AR_LIMITS, JSON.parse(opt('--limits')!));
const BOARD = (JSON.parse(fs.readFileSync(path.join(ROOT, 'rightside/tools/display-bench/data/bern-board.json'), 'utf8')) as { candidates: { line: string; destination: string; category?: string }[] }).candidates;
const boardAt = (at: number): ArBoard => ({ at, complete: true, entries: BOARD.map((c) => ({ line: c.line, headsign: c.destination, pickup: true, servesTo: true, etaS: 120, dep: 0 })) });
const service = (p: { line: string; destination: string }) => `${p.line}|${p.destination}`;
/** Another service of the same line (the hardest rider for that vehicle: same numeral). */
const sibling = (p: { line: string; destination: string }) => BOARD.find((c) => c.line === p.line && c.destination !== p.destination);

type Kind = 'certain' | 'white' | 'none' | 'WRONG';
const tally = () => ({ certain: 0, white: 0, none: 0, WRONG: 0 });
const T = { mine: tally(), other: tally() };
const byHeight: Record<string, { mine: ReturnType<typeof tally>; other: ReturnType<typeof tally> }> = {};
const H = (h: number) => (h < 0.15 ? 'a <0.15' : h < 0.3 ? 'b 0.15-0.3' : 'c >=0.3');
const passes = new Map<string, { video: string; event: number; rider: string; mine: boolean; frames: Kind[]; why: string[] }>();
const wrong: string[] = [];
let merged = 0, mergedLabelled = 0, labelledFrames = 0;
const mergedMoments = new Set<string>();
const redText = new Set<string>();
const reasons = new Map<string, number>();

for (const d of POS) {
  const r = loadRange(d);
  const cache = JSON.parse(fs.readFileSync(path.join(CACHE, `${r.video}.json`), 'utf8')) as Cached;
  const rows = new Map<number, PassRow[]>();
  for (const f of r.frames) { const a = rows.get(f.frame) || []; a.push(f); rows.set(f.frame, a); }
  for (const [a, b] of cache.segments) {
    const inSeg = r.frames.filter((f) => f.frame >= a && f.frame <= b);
    const riders = new Map<string, ArRide>();
    for (const p of inSeg) {
      const mode = BOARD.find((c) => service(c) === service(p))?.category === 'B' ? 'bus' : 'tram';
      riders.set(service(p), { line: p.line, destination: p.destination, mode });
      const s = sibling(p);
      if (s) riders.set(service(s), { line: s.line, destination: s.destination, mode });
    }
    for (const [key, ride] of riders) {
      // why remembered displays were forgotten
      const ses = createArSession(ride, (e) => { if (e.type === 'forget') FORGET[String(e.why)] = (FORGET[String(e.why)] || 0) + 1; });
      let nextBoard = a / 5;
      for (let f = a; f <= b; f++) {
        const fr = cache.frames[f];
        if (!fr) continue;
        const at = f / 5;
        if (at >= nextBoard) { ses.board(boardAt(at)); nextBoard += 15; }
        const dets = fr[DET];
        ses.detections(dets, at, null, (CUTS[r.video] || []).includes(f) ? 1 : null);
        if (fr.reads && argv.includes('--read-all')) {
          // a ceiling: every vehicle and the road read at once (a reader with unlimited time)
          const all = [...fr.reads.road, ...dets.flatMap((_, i) => fr.reads![`${DET}:${i}`] || [])];
          ses.words(all, at, at + 0.1);
        } else if (fr.reads) {
          // what the phone would read now: the same choice as src/app/ar.ts
          const target = ses.readTarget(at);
          let words: Words[] = [];
          if (target === 'road') words = fr.reads.road;
          else {
            const i = dets.findIndex((x) => iou(x.box, target) >= 0.999);
            words = i >= 0 ? fr.reads[`${DET}:${i}`] || [] : [];
          }
          ses.words(words, at, at + 0.1);
        }
        const now = at + 0.1;
        const labels = ses.labels(now);
        const ref = REF.get(`${r.video}/${String(f).padStart(5, '0')}.jpg`) || [];
        // a label box that spans two vehicles of the reference detector
        for (const l of labels) {
          // two reference vehicles mostly inside one label box (also when the box fits the bigger one well): a vehicle
          // behind or beside it is in the coloured box too. Tiny far ones (under 5 % of the box) do not count.
          // The reference detector also boxes parts of one vehicle (a box nested in another): only two vehicles that
          // are not nested in each other count.
          const covered = ref.filter((v) => inside(v, l.box) >= 0.6 && v[2] * v[3] >= 0.05 * l.box[2] * l.box[3]);
          const apart = covered.some((x, i) => covered.some((y, j) => j > i && inside(x, y) < 0.6 && inside(y, x) < 0.6));
          if (apart) { merged++; if (l.kind === 'green' || l.kind === 'red') { mergedLabelled++; mergedMoments.add(`${r.video} f${f}`); wrong.push(`${r.video} f${f} ${key}: ${l.kind} "${l.text}" on a box spanning ${covered.length} vehicles`); } }
        }
        labelledFrames += labels.length;
        for (const p of rows.get(f) || []) {
          const mine = service(p) === key;
          const best = labels.map((l) => ({ l, o: iou(l.box, p.box) })).filter((x) => x.o >= 0.3).sort((x, y) => y.o - x.o)[0];
          const l: ArLabel | undefined = best?.l;
          let k: Kind;
          if (!l || l.kind === 'none') k = 'none';
          else if (l.kind === 'neutral') k = 'white';
          else if ((l.kind === 'green') === mine) k = 'certain';
          else k = 'WRONG';
          if (l && l.kind !== 'green' && l.kind !== 'red') reasons.set(`${l.kind}:${l.reason}`, (reasons.get(`${l.kind}:${l.reason}`) || 0) + 1);
          if (!l) reasons.set('no box', (reasons.get('no box') || 0) + 1);
          // a right red whose text names another service than this vehicle's (the rider is safe, the text is not)
          if (k === 'certain' && l!.kind === 'red' && !l!.text.includes(`${p.line} → ${p.destination}`)) redText.add(`${r.video} f${f}: "${l!.text}" on ${p.line} ${p.destination}`);
          if (k === 'WRONG') wrong.push(`${r.video} f${f} pass ${p.event} (${p.line} ${p.destination}) rider ${key}: ${l!.kind} "${l!.text}" (${l!.reason})`);
          const side = mine ? 'mine' : 'other';
          T[side][k]++;
          const hb = (byHeight[H(p.box[3])] ||= { mine: tally(), other: tally() });
          hb[side][k]++;
          const pk = `${r.video}:${p.event}:${key}`;
          const ps = passes.get(pk) || { video: r.video, event: p.event, rider: key, mine, frames: [], why: [] };
          ps.frames.push(k); ps.why.push(l ? `${l.reason}#${l.track}#${labels.map((x) => x.track).join(',')}` : `no box##${labels.map((x) => x.track).join(',')}`); passes.set(pk, ps);
        }
      }
    }
  }
}

const pct = (x: number, n: number) => (n ? `${(100 * x / n).toFixed(1)} %` : '-');
const row = (name: string, t: ReturnType<typeof tally>) => {
  const n = t.certain + t.white + t.none + t.WRONG;
  return `| ${name} | ${n} | ${pct(t.certain, n)} | ${pct(t.white, n)} | ${pct(t.none, n)} | ${t.WRONG} |`;
};
console.log(`# AR labels on the bench (${DET}), every frame a labelled vehicle is in view\n`);
console.log('| rider | frames | certain | white | nothing | WRONG |\n|---|---:|---:|---:|---:|---:|');
console.log(row('its own service (green is right)', T.mine));
console.log(row('another service (red is right)', T.other));
for (const h of Object.keys(byHeight).sort()) { console.log(row(`own, height ${h.slice(2)}`, byHeight[h].mine)); console.log(row(`other, height ${h.slice(2)}`, byHeight[h].other)); }
// per pass: once certain, how much of the rest stays certain (the "remembering" the owner asked for)
let after = 0, afterCertain = 0, reached = 0, flips = 0;
for (const p of passes.values()) {
  const i = p.frames.indexOf('certain');
  if (i < 0) continue;
  reached++;
  const rest = p.frames.slice(i);
  after += rest.length; afterCertain += rest.filter((k) => k === 'certain').length;
  for (let j = 1; j < rest.length; j++) if (rest[j - 1] === 'certain' && rest[j] !== 'certain') flips++;
}
console.log(`\nPasses × riders: ${passes.size}; reached certain: ${reached} (${pct(reached, passes.size)}); after the first certain frame, certain ${pct(afterCertain, after)} of the frames; certain→not ${flips} times`);
if (opt('--timeline')) {
  // one line per pass and rider: g/r certain, w white, . nothing, _ no box, X wrong; then the reasons
  const [vid, ev] = opt('--timeline')!.split(':');
  for (const p of passes.values()) if (p.video === vid && String(p.event) === ev) {
    console.log(p.rider, p.mine ? '(own)' : '(other)', p.frames.map((k) => ({ certain: p.mine ? 'g' : 'r', white: 'w', none: '.', WRONG: 'X' })[k]).join(''));
    console.log('   ', p.why.map((w) => w.split('#').slice(0, 2).join('#')).join(' '));
  }
}
if (argv.includes('--trace')) {
  const worst = [...passes.values()].filter((p) => p.frames.includes('certain')).map((p) => ({ p, n: p.why.filter((w, j) => j > p.frames.indexOf('certain') && p.frames[j] !== 'certain' && !w.startsWith(p.why[p.frames.indexOf('certain')].split('#')[0] + '#' + p.why[p.frames.indexOf('certain')].split('#')[1])).length })).sort((a2, b2) => b2.n - a2.n)[0];
  if (worst) console.log('TRACE', worst.p.video, worst.p.event, worst.p.rider, worst.p.frames.map((k, j) => k[0] + ':' + worst.p.why[j]).join(' | '));
}
// after a vehicle was first certain: why it is not, and whether it is still the same track
const lost = new Map<string, number>();
for (const p of passes.values()) {
  const i = p.frames.indexOf('certain');
  if (i < 0) continue;
  const track = p.why[i].split('#')[1];
  for (let j = i + 1; j < p.frames.length; j++) if (p.frames[j] !== 'certain') {
    const [why, tr, ids] = p.why[j].split('#');
    const alive = ids.split(',').includes(track) ? ' (old track still there)' : '';
    const k = why === 'no box' ? 'no box' + alive : (tr === track ? 'same track: ' : 'other track' + alive + ': ') + why;
    lost.set(k, (lost.get(k) || 0) + 1);
  }
}
console.log('After the first certain frame, not certain because (frames):', [...lost.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(', '));
console.log(`Red naming another service than the vehicle's (rider frames): ${redText.size}`); for (const x of [...redText].slice(0, 8)) console.log('  ' + x);
console.log('Remembered displays forgotten because:', JSON.stringify(FORGET));
console.log(`Label boxes spanning two reference vehicles: ${merged} of ${labelledFrames} (${mergedLabelled} green/red, at ${mergedMoments.size} moments: ${[...mergedMoments].join(', ')})`);
console.log('\nWhy not certain (frames):', [...reasons.entries()].sort((x, y) => y[1] - x[1]).slice(0, 14).map(([k, v]) => `${k} ${v}`).join(', '));
if (wrong.length) { console.log(`\nWRONG (${wrong.length}):`); for (const w of wrong.slice(0, 40)) console.log('  ' + w); }
