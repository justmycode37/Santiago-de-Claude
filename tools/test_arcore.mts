// Tests for src/arcore.ts (window.ARCORE): the vehicle-display decision ported from RightSide.
//
//   node tools/test_arcore.mts                 # unit checks + both display-bench sets, compared with the Swift numbers
//   node tools/test_arcore.mts --details       # also each labelled pass's outcome
//
// The display bench (rightside/tools/display-bench) replays labelled Bern video passes: per-frame OCR (PP-OCRv5 on a
// PC, the same text the Swift sees) through read() → decide(), frame by frame with a sliding 2 s window, exactly as
// its main.swift does for "strategy C" (board matching + confidence ranking). The expected numbers below are the
// Swift's on the same data (run-eval.sh). This measures that the logic is the same, not how well the web's own OCR
// (tesseract.js on a phone) reads a display: that only a real phone at a real stop can tell.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const A = require(path.join(ROOT, 'src', 'arcore.ts')) as ArCoreApi;
const details = process.argv.includes('--details');

let passed = 0, failed = 0;
const check = (ok: boolean, what: string) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };

// ---------------------------------------------------------------- unit checks (cases from the Swift's comments)
console.log('Display text');
check(A.words('9Wankdorf Bhf').join(' ') === '9 wankdorf bahnhof', '"9Wankdorf Bhf" → 9 wankdorf bahnhof');
check(A.words('BernBhf').join(' ') === 'bern bahnhof', 'glued abbreviation "BernBhf"');
check(A.words('Zürich, Hauptbahnhof').join(' ') === 'zurich hauptbahnhof', 'accents folded');
check(A.lineKey('Bus 10') === '10' && A.lineKey('T 9') === '9' && A.lineKey('S7') === 's7', 'line keys');
check(A.isRouteToken('n1') && A.isRouteToken('10e') && !A.isRouteToken('wabern'), 'route tokens');
check(A.destinationSimilarity('Wabern, Tram-Endstation', 'Wabern') >= 0.9, '"Wabern" is how "Wabern, Tram-Endstation" is shown');
check(A.destinationSimilarity('Bern, Wankdorf Bahnhof', 'Wankdorf Bhf') >= 0.9, '"Wankdorf Bhf" for "Bern, Wankdorf Bahnhof"');
check(A.similarity('Saali', 'Soali') >= 0.85, 'LED a/o counts half an edit');

console.log('One frame against a board');
const board = [
  { line: '9', destination: 'Wabern, Tram-Endstation' }, { line: '9', destination: 'Bern, Wankdorf Bahnhof' },
  { line: '10', destination: 'Ostermundigen, Rüti' }, { line: '10', destination: 'Köniz, Schliern' },
];
const t = (text: string, x: number, y: number, w: number, h: number, score = 0.9): ArText => ({ text, box: [x, y, w, h], score });
const m1 = A.match([t('9', 0.1, 0.1, 0.05, 0.08), t('Wabern', 0.2, 0.1, 0.3, 0.08)], board);
check(m1.outcome === 'matched' && m1.best!.candidate.destination.startsWith('Wabern'), `"9 Wabern" → matched Wabern (${m1.outcome})`);
const m2 = A.match([t('Ostermundigen Rüti', 0.2, 0.1, 0.4, 0.08)], board);
check(m2.outcome === 'matched' && m2.best!.candidate.line === '10', `"Ostermundigen Rüti" without a number → line 10 (${m2.outcome})`);
const m2b = A.match([t('Ostermundigen', 0.2, 0.1, 0.4, 0.08)], board);
check(m2b.outcome !== 'matched', `half the name ("Ostermundigen" for "Ostermundigen, Rüti") is not enough on its own (${m2b.outcome})`);
const m3 = A.match([t('Bümpliz', 0.2, 0.1, 0.3, 0.08)], board);
check(m3.outcome === 'unlisted', `a destination not on the board is "unlisted" (${m3.outcome})`);
const m4 = A.match([t('AARE DACH AG', 0.2, 0.6, 0.3, 0.03)], board);
check(m4.outcome !== 'matched', `an advert is never a match (${m4.outcome})`);

console.log('Decision over frames');
const det: ArDetection = { box: [0, 0, 1, 1], score: 1 };
let frameNo = 0; // frame ids are unique, as the camera's are (the matcher memoises per frame)
const frames = (texts: ArText[], n: number) => Array.from({ length: n }, (_, i) => A.read(texts, det, [], i * 0.5, `f${frameNo++}`));
const exp9 = { line: '9', destination: 'Wabern, Tram-Endstation', board };
const r9 = frames([t('9', 0.1, 0.1, 0.05, 0.08), t('Wabern', 0.2, 0.1, 0.3, 0.08)], 3);
check(A.decide(r9, 1, exp9, 1).state === 'match', 'the right display over three frames → match');
const exp10 = { line: '10', destination: 'Ostermundigen, Rüti', board };
const d10 = A.decide(r9, 1, exp10, 1);
check(d10.state === 'wrong' && /Wabern/.test(d10.observed || ''), `expecting the 10, seeing the 9 → wrong, names it (${d10.observed})`);
check(A.decide(r9, 1, exp9, 5).state === 'unknown', 'stale readings → unknown');
const rBlank = frames([t('Linie', 0.1, 0.1, 0.1, 0.05)], 3);
check(A.decide(rBlank, 1, exp9, 1).state === 'unknown', 'nothing readable → unknown, never wrong');

// ---------------------------------------------------------------- the display bench
// the bench's files (rightside/tools/display-bench/data*): only what is read here
/** bern-video-ocr.json: per frame, the vehicles found in it and the texts read on each. */
interface BenchVehicle { box: ArBox; score: number; texts: ArText[] }
interface BenchFrame { image: string; vehicles: BenchVehicle[] }
interface BenchOcr { frames: BenchFrame[] }
/** bern-board.json: the services that can stop there. */
interface BenchBoard { candidates: ArCandidate[] }
/** bern-video-events.json: a vehicle passing, as the names of its frames. */
interface BenchEvent { id: number; frames: string[] }
interface BenchEvents { events: BenchEvent[] }
/** bern-video-labels.json: what the vehicle of an event really is (line '-': not in service). */
interface BenchLabel { event: number; line: string; destination: string }
interface BenchLabels { labels: BenchLabel[] }
/** How a pass ends: accepted (and on what basis), or flagged as wrong (and as which service), or unknown. */
interface PassResult { o: 'accepted' | 'conflicting' | 'unknown'; basis?: string; named?: string | null }
const BENCH = path.join(ROOT, 'rightside', 'tools', 'display-bench');
const load = <T,>(dir: string, f: string): T => JSON.parse(fs.readFileSync(path.join(BENCH, dir, f), 'utf8'));
const ocrDev = load<BenchOcr>('data', 'bern-video-ocr.json');
const benchBoard = load<BenchBoard>('data', 'bern-board.json').candidates.map((c) => ({ line: c.line, destination: c.destination }));

function runSet(dir: string, ocr: BenchOcr) {
  const events = new Map<number, BenchEvent>(load<BenchEvents>(dir, 'bern-video-events.json').events.map((e) => [e.id, e]));
  const labels = load<BenchLabels>(dir, 'bern-video-labels.json').labels;
  const brd = fs.existsSync(path.join(BENCH, dir, 'bern-board.json')) ? load<BenchBoard>(dir, 'bern-board.json').candidates.map((c) => ({ line: c.line, destination: c.destination })) : benchBoard;
  const frames = new Map<string, BenchFrame>(ocr.frames.map((f) => [f.image, f]));
  const STEP = 0.5;
  let uid = 0;
  function readings(event: BenchEvent) {
    const out: ArReading[] = [], times: number[] = [];
    event.frames.forEach((name, index) => {
      const f = frames.get(name);
      if (!f || !f.vehicles.length) return;
      const v = f.vehicles.reduce((a, b) => (b.box[3] > a.box[3] ? b : a));
      const others = f.vehicles.filter((o) => o.box.join() !== v.box.join()).map((o) => o.box);
      const at = index * STEP;
      out.push(A.read(v.texts.map((x) => ({ text: x.text, box: x.box, score: x.score })), { box: v.box, score: v.score }, others, at, `u${uid++}`, true));
      times.push(at);
    });
    return { readings: out, times };
  }
  function run(event: BenchEvent, expected: ArExpectation): PassResult {
    const { readings: rs, times } = readings(event);
    let conflict = false, named: string | null = null;
    for (let i = 0; i < times.length; i++) {
      const now = times[i];
      const win = rs.slice(0, i + 1).filter((r) => now - r.at <= 2);
      const d = A.decide(win, now, expected, now);
      if (d.state === 'match') return { o: 'accepted', basis: d.basis || 'strict' };
      if (d.state === 'wrong') { conflict = true; named = named || d.observed || null; }
    }
    return { o: conflict ? 'conflicting' : 'unknown', named };
  }
  const pos = { accepted: 0, conflicting: 0, unknown: 0, n: 0 }, neg = { accepted: 0, conflicting: 0, unknown: 0, n: 0, namedRight: 0, namedWrong: 0 };
  const perFrame: Record<string, number> = {};
  const lines: string[] = [];
  for (const label of labels) {
    const event = events.get(label.event);
    if (!event) continue;
    const truth = { line: label.line, destination: label.destination };
    for (const r of readings(event).readings) {
      const m = A.match(r.observed, brd);
      const key = m.outcome === 'matched' ? (A.sameDisplay(m.best!.candidate, truth) ? 'matched-correct' : 'matched-WRONG') : m.outcome;
      perFrame[key] = (perFrame[key] || 0) + 1;
    }
    if (label.line !== '-') {
      const r = run(event, { line: label.line, destination: label.destination, board: brd });
      pos[r.o]++; pos.n++;
      lines.push(`#${label.event} ${label.line} ${label.destination}: C positive → ${r.o}`);
    }
    const others = brd.filter((c) => !A.sameDisplay(c, truth));
    const sameLine = others.filter((c) => A.lineKey(c.line) === A.lineKey(truth.line)).slice(0, 1);
    const sameDest = others.filter((c) => A.destinationSimilarity(c.destination, truth.destination) >= 0.9).slice(0, 1);
    const rest = others.filter((o) => !sameLine.includes(o) && !sameDest.includes(o));
    const offset = label.event % Math.max(1, rest.length);
    const picks = [...sameLine, ...sameDest, rest[offset % rest.length], rest[(offset + 7) % rest.length]];
    for (const wrong of picks) {
      const r = run(event, { line: wrong.line, destination: wrong.destination, board: brd });
      neg[r.o]++; neg.n++;
      if (r.named) {
        const [l, ...d] = r.named.split(' ');
        if (A.sameDisplay({ line: l, destination: d.join(' ') }, truth)) neg.namedRight++; else neg.namedWrong++;
      }
    }
  }
  return { pos, neg, perFrame, lines };
}
const pct = (a: number, n: number) => (n ? (a * 100 / n).toFixed(1) + ' %' : '-');

// The Swift's numbers on the same data (run-eval.sh on Linux, strategy C, 21 Nov 2026): passes accepted, wrong-vehicle
// trials flagged. On Linux, Foundation's CGRect.contains(rect) is union(rect) == self, compared exactly, which fails
// for most float boxes (x + width − x ≠ width), so the Swift's line/destination pairs (VehicleTextRules.read) almost never form there. "Linux"
// mode below reproduces that and must give exactly the Swift's numbers; "phone" mode is the logic as intended (and as
// the web runs it).
interface SwiftNumbers { accepted: number; n: number; flagged: number; negN: number }
const SWIFT: Record<string, SwiftNumbers> = {
  data: { accepted: 76, n: 111, flagged: 241, negN: 349 },
  'data-holdout': { accepted: 27, n: 35, flagged: 81, negN: 113 },
};
const linuxContains = (o: ArBox, i: ArBox) => { // union(o, i) == o, compared exactly
  const x0 = Math.min(o[0], i[0]), y0 = Math.min(o[1], i[1]);
  return x0 === o[0] && y0 === o[1] && Math.max(o[0] + o[2], i[0] + i[2]) - x0 === o[2] && Math.max(o[1] + o[3], i[1] + i[3]) - y0 === o[3];
};
const phoneContains = A.options.containsBox;
for (const mode of ['linux', 'phone']) {
  A.options.containsBox = mode === 'linux' ? linuxContains : phoneContains;
  for (const dir of ['data', 'data-holdout']) {
    const ocr: BenchOcr = dir === 'data' ? ocrDev : JSON.parse(fs.readFileSync(path.join(BENCH, dir, 'bern-video-ocr.json'), 'utf8'));
    const started = Date.now();
    const r = runSet(dir, ocr);
    console.log(`
Display bench ${dir}, ${mode === 'linux' ? 'as the Swift bench runs on Linux' : 'as on a phone'} (${Date.now() - started} ms)`);
    const ft = Object.values(r.perFrame).reduce((a, b) => a + b, 0);
    console.log('  per frame: ' + ['matched-correct', 'matched-WRONG', 'ambiguous', 'unlisted', 'unreadable'].map((k) => `${k} ${r.perFrame[k] || 0} (${pct(r.perFrame[k] || 0, ft)})`).join(', '));
    console.log(`  right vehicle: accepted ${r.pos.accepted}/${r.pos.n} (${pct(r.pos.accepted, r.pos.n)}), flagged wrong ${r.pos.conflicting}, unknown ${r.pos.unknown}`);
    console.log(`  wrong vehicle: accepted ${r.neg.accepted}/${r.neg.n} (${pct(r.neg.accepted, r.neg.n)}), flagged ${r.neg.conflicting} (${pct(r.neg.conflicting, r.neg.n)}), named right ${r.neg.namedRight}/${r.neg.namedRight + r.neg.namedWrong}`);
    if (details) r.lines.forEach((l) => console.log('   ' + l));
    check(r.neg.accepted === 0, `${dir} ${mode}: no wrong vehicle accepted`);
    check(r.pos.conflicting === 0, `${dir} ${mode}: no right vehicle flagged as wrong`);
    check(r.neg.namedWrong === 0, `${dir} ${mode}: a wrong vehicle is never named as another wrong service`);
    const s = SWIFT[dir];
    if (mode === 'linux') {
      check(r.pos.accepted === s.accepted && r.pos.n === s.n && r.neg.conflicting === s.flagged && r.neg.n === s.negN,
        `${dir}: exactly the Swift's numbers (accepted ${r.pos.accepted}/${r.pos.n} vs ${s.accepted}/${s.n}, flagged ${r.neg.conflicting}/${r.neg.n} vs ${s.flagged}/${s.negN})`);
    }
  }
}
A.options.containsBox = phoneContains;

console.log(`
${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
