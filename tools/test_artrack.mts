// Scripted event replays through src/artrack.ts, the AR camera's own decision path (src/app/ar.ts only feeds it and
// draws what it answers). Each suite is a list of events (detections, display reads that arrive late, boards, failed
// polls) and, after every event, what each vehicle on screen must show: nothing, its display text, green or red.
//
//   node tools/test_artrack.mts             # all suites
//   node tools/test_artrack.mts --verbose   # every step
//
// The rules under test are docs/ar-recognition-plan.md's: green only from this vehicle's own display read with a
// complete, fresh board on which every run showing that display serves the rider's stop; red only from text, in two
// distinct frames; timing never on a vehicle; labels revoked on a crossing, an ambiguous match, a lost track or a
// stale board. A capture saved in the field ("Save last 10 s", docs/ar-field-test.md) goes into tools/ar-replays/
// and is replayed below too.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArSession, AR_LIMITS } from '../src/artrack.ts';
import type { ArBoard, ArBoardEntry, ArBox, ArEvent, ArLabelKind, ArRide, ArText } from '../src/artrack.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');
let passed = 0, failed = 0;
const check = (ok: boolean, what: string) => { if (ok) passed++; else { failed++; console.log(`  FAIL  ${what}`); } if (ok && verbose) console.log(`  ok    ${what}`); };

// ---------------------------------------------------------------- a Bern stop
const SD = '2026-11-24';
const E = (tripId: string, line: string, headsign: string, more: Partial<ArBoardEntry> = {}): ArBoardEntry =>
  ({ tripId, serviceDate: SD, line, headsign, quayId: 'Q-A', quayLabel: 'A', state: 'approaching', etaS: 120, dep: 1, ...more });
const MINE = E('T10a', '10', 'Ostermundigen, Rüti', { servesTo: true, etaS: 240 });
const BASE: ArBoardEntry[] = [
  MINE,
  E('T10b', '10', 'Köniz, Schliern', { servesTo: false, quayId: 'Q-B', quayLabel: 'B' }),
  E('T9a', '9', 'Wabern, Tram-Endstation', { servesTo: false }),
  E('T9b', '9', 'Bern, Wankdorf Bahnhof', { servesTo: false, quayId: 'Q-B', quayLabel: 'B' }),
  E('T19', '19', 'Blinzern', { servesTo: false }),
];
const RIDE: ArRide = { line: '10', destination: 'Ostermundigen, Rüti', mode: 'bus', tripId: 'T10a', serviceDate: SD, quayId: 'Q-A', quayLabel: 'A',
  stopsBefore: ['Bern, Zytglogge', 'Bern, Kursaal', 'Ostermundigen, Zollgasse'], dep: 1764000000 };

/** What a vehicle's display looks like to OCR: its route number and destination in the upper band of its box. */
function displayOn(box: ArBox, line: string, dest: string): ArText[] {
  const [x, y, w, h] = box;
  const out: ArText[] = [];
  if (line) out.push({ text: line, box: [x + 0.05 * w, y + 0.08 * h, 0.08 * w, 0.08 * h], score: 0.95 });
  if (dest) out.push({ text: dest, box: [x + 0.16 * w, y + 0.08 * h, 0.6 * w, 0.08 * h], score: 0.95 });
  return out;
}

type Want = ArLabelKind | 'absent' | [ArLabelKind, RegExp];
interface Step {
  at: number;
  /** what this step is */
  say: string;
  det?: Record<string, ArBox>;
  shift?: { dx: number; dy: number };
  /** a read of the picture taken at `captured`, arriving now: which vehicle showed what (at its box of that moment) */
  words?: { captured: number; on: Record<string, [string, string]>; free?: ArText[] };
  board?: { entries: ArBoardEntry[]; complete?: boolean } | 'fail';
  expect: Record<string, Want>;
  banner?: RegExp;
}

function suite(name: string, steps: Step[], ride: ArRide = RIDE) {
  console.log(name);
  const ses = createArSession(ride);
  const where: Record<string, { at: number; box: ArBox }[]> = {}; // the boxes each vehicle had, by time
  const boxAt = (v: string, t: number) => {
    const h = where[v] || [];
    let best: ArBox | null = null;
    for (const s of h) if (s.at <= t + 1e-9) best = s.box;
    return best;
  };
  const current: Record<string, ArBox> = {};
  for (const st of steps) {
    if (st.board === 'fail') ses.boardFailed(st.at);
    else if (st.board) ses.board({ at: st.at, entries: st.board.entries, complete: st.board.complete !== false } as ArBoard);
    if (st.det) {
      for (const k of Object.keys(current)) delete current[k];
      Object.assign(current, st.det);
      for (const [v, b] of Object.entries(st.det)) (where[v] = where[v] || []).push({ at: st.at, box: b });
      ses.detections(Object.values(st.det).map((box) => ({ box, score: 0.9, cls: 'bus' })), st.at, st.shift || null);
    }
    if (st.words) {
      const texts = [...Object.entries(st.words.on).flatMap(([v, [l, d]]) => displayOn(boxAt(v, st.words!.captured)!, l, d)), ...(st.words.free || [])];
      ses.words(texts, st.words.captured, st.at);
    }
    const labels = ses.labels(st.at);
    for (const [v, want] of Object.entries(st.expect)) {
      const box = current[v];
      const l = box ? labels.find((x) => x.box === box) : undefined;
      const [kind, re] = Array.isArray(want) ? want : [want, null];
      const got = l ? l.kind : 'absent';
      check(got === kind && (!re || (!!l && re.test(l.text))),
        `${name} · t=${st.at} ${st.say}: ${v} shows ${kind}${re ? ' ' + re : ''} (got ${got}${l ? ` "${l.text}" ${l.reason}` : ''})`);
    }
    // no green or red anywhere that this step does not name: not on a vehicle left out of `expect`, nor on a box
    // the script no longer tracks (a label lingering on, or handed to, another vehicle)
    const allowed = new Set(Object.entries(st.expect).filter(([, w]) => {
      const k = Array.isArray(w) ? w[0] : w;
      return k === 'green' || k === 'red';
    }).map(([v]) => current[v]));
    for (const l of labels) {
      if ((l.kind === 'green' || l.kind === 'red') && !allowed.has(l.box)) check(false, `${name} · t=${st.at} ${st.say}: unexpected ${l.kind} "${l.text}" on track ${l.track}`);
    }
    if (st.banner) { const b = ses.banner(st.at).text; check(st.banner.test(b), `${name} · t=${st.at} banner ${st.banner} (got "${b}")`); }
  }
  return ses;
}

// vehicle boxes: a bus on the left, one on the right, and positions in between
const LEFT: ArBox = [0.05, 0.3, 0.35, 0.4], RIGHT: ArBox = [0.6, 0.3, 0.35, 0.4];
const mv = (b: ArBox, dx: number): ArBox => [b[0] + dx, b[1], b[2], b[3]];
const board = (entries = BASE, complete = true) => ({ entries, complete });

// ---------------------------------------------------------------- the old shortcuts are gone
suite('No label without a read (no one-due green, no timing-only red)', [
  { at: 0, say: 'only my run is due', board: board([MINE]), det: { A: LEFT }, expect: { A: 'none' }, banner: /in 4 min/ },
  { at: 1, say: 'it is due now', board: board([{ ...MINE, etaS: 0, state: 'at-stop' }]), det: { A: LEFT }, expect: { A: 'none' }, banner: /at the stop now/ },
  { at: 2, say: 'my run is 10 min away, a bus is here', board: board([{ ...MINE, etaS: 600 }, BASE[2]]), det: { A: LEFT }, expect: { A: 'none' }, banner: /in 10 min/ },
]);

// ---------------------------------------------------------------- green and red, and what holds them back
suite('Green from the vehicle\'s own read; red only from two frames of text', [
  { at: 0, say: 'board', board: board(), det: { A: LEFT, B: RIGHT }, expect: { A: 'none', B: 'none' } },
  { at: 0.3, say: 'A reads 10 Rüti', det: { A: LEFT, B: RIGHT }, words: { captured: 0.3, on: { A: ['10', 'Ostermundigen Rüti'] } },
    expect: { A: ['green', /Your bus 10 → Ostermundigen, Rüti/], B: 'none' } },
  { at: 0.6, say: 'B reads 9 Wabern once', det: { A: LEFT, B: RIGHT }, words: { captured: 0.6, on: { B: ['9', 'Wabern'] } },
    expect: { A: 'green', B: ['neutral', /Display: 9 → Wabern/] } },
  { at: 0.9, say: 'B reads 9 Wabern again', det: { A: LEFT, B: RIGHT }, words: { captured: 0.9, on: { B: ['9', 'Wabern'] } },
    expect: { A: 'green', B: ['red', /Not yours: 9 → Wabern/] } },
  { at: 9.5, say: 'no read for 8 s: labels expire', det: { A: LEFT, B: RIGHT }, expect: { A: 'none', B: 'none' } },
]);
suite('Out of service needs two frames', [
  { at: 0, say: 'board', board: board(), det: { A: LEFT }, expect: { A: 'none' } },
  { at: 0.3, say: 'Ausser Betrieb once', det: { A: LEFT }, words: { captured: 0.3, on: { A: ['', 'Ausser Betrieb'] } }, expect: { A: ['neutral', /not in service/] } },
  { at: 0.6, say: 'and again', det: { A: LEFT }, words: { captured: 0.6, on: { A: ['', 'Ausser Betrieb'] } }, expect: { A: ['red', /Not in service/] } },
]);

// ---------------------------------------------------------------- crossings and lost tracks
suite('Crossing revokes both; a lost track comes back as a new one without a label', [
  { at: 0, say: 'board', board: board(), det: { A: LEFT, B: RIGHT }, expect: { A: 'none', B: 'none' } },
  { at: 0.3, say: 'A is my 10', det: { A: LEFT, B: RIGHT }, words: { captured: 0.3, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { A: 'green', B: 'none' } },
  { at: 0.6, say: 'they move toward each other', det: { A: mv(LEFT, 0.1), B: mv(RIGHT, -0.1) }, expect: { A: 'green', B: 'none' } },
  { at: 0.9, say: 'they overlap', det: { A: mv(LEFT, 0.2), B: mv(RIGHT, -0.2) }, expect: { A: 'none', B: 'none' } },
  { at: 1.2, say: 'past each other', det: { A: mv(LEFT, 0.3), B: mv(RIGHT, -0.3) }, expect: { A: 'none', B: 'none' } },
  { at: 1.5, say: 'apart again', det: { A: mv(LEFT, 0.45), B: mv(RIGHT, -0.45) }, expect: { A: 'none', B: 'none' } },
  { at: 1.8, say: 'a read taken before the crossing arrives late: nobody gets it', det: { A: mv(LEFT, 0.45), B: mv(RIGHT, -0.45) },
    words: { captured: 0.45, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { A: 'none', B: 'none' } },
  { at: 2.1, say: 'B leaves the picture', det: { A: mv(LEFT, 0.45) }, expect: { A: 'none' } },
  { at: 3.6, say: 'gone for 1.5 s', det: { A: mv(LEFT, 0.45) }, expect: { A: 'none' } },
  { at: 3.9, say: 'a vehicle appears where B was, with a read', det: { A: mv(LEFT, 0.45), C: mv(RIGHT, -0.45) },
    words: { captured: 3.9, on: { C: ['10', 'Ostermundigen Rüti'] } }, expect: { A: 'none', C: 'green' } },
]);
suite('Ambiguous match from one detection to the next revokes', [
  { at: 0, say: 'board', board: board(), det: { A: [0.3, 0.3, 0.3, 0.4] }, expect: { A: 'none' } },
  { at: 0.3, say: 'A is my 10', det: { A: [0.3, 0.3, 0.3, 0.4] }, words: { captured: 0.3, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { A: 'green' } },
  { at: 0.6, say: 'two boxes now fit A equally', det: { A: [0.22, 0.3, 0.3, 0.4], X: [0.38, 0.3, 0.3, 0.4] }, expect: { A: 'none', X: 'none' } },
]);
suite('A fast pan revokes; a slow one keeps the label (gyro shift)', [
  { at: 0, say: 'board', board: board(), det: { A: LEFT }, expect: { A: 'none' } },
  { at: 0.3, say: 'A is my 10', det: { A: LEFT }, words: { captured: 0.3, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { A: 'green' } },
  { at: 0.6, say: 'the phone turns: the box moves by 0.2, the gyro says so', det: { A: mv(LEFT, 0.2) }, shift: { dx: 0.2, dy: 0 }, expect: { A: 'green' } },
  { at: 0.9, say: 'a jerk: the picture moves by 0.4', det: { A: mv(LEFT, 0.6) }, shift: { dx: 0.4, dy: 0 }, expect: { A: 'none' } },
]);

// ---------------------------------------------------------------- late reads
suite('A late read goes to the vehicle that held it when the picture was taken', [
  { at: 0, say: 'board; A on the left', board: board(), det: { A: LEFT }, expect: { A: 'none' } },
  { at: 0.33, say: 'A drives right', det: { A: mv(LEFT, 0.08) }, expect: { A: 'none' } },
  { at: 0.66, say: 'A further right, B arrives behind it', det: { A: mv(LEFT, 0.16), B: mv(LEFT, -0.1) }, expect: { A: 'none', B: 'none' } },
  { at: 0.99, say: 'both drive on', det: { A: mv(LEFT, 0.24), B: mv(LEFT, -0.02) }, expect: { A: 'none', B: 'none' } },
  { at: 1.32, say: 'B is now about where A was when the picture was taken', det: { A: mv(LEFT, 0.32), B: mv(LEFT, 0.06) }, expect: { A: 'none', B: 'none' } },
  { at: 1.6, say: 'the read of t=0.33 (A, 10 Rüti) arrives: A, not B', det: { A: mv(LEFT, 0.32), B: mv(LEFT, 0.06) },
    words: { captured: 0.33, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { A: 'green', B: 'none' } },
  { at: 7, say: 'a read 4.5 s late is dropped', det: { A: mv(LEFT, 0.32), B: mv(LEFT, 0.06) }, words: { captured: 2.5, on: { B: ['10', 'Ostermundigen Rüti'] } },
    expect: { B: 'none' } },
]);

suite('A read on a small, far vehicle stays on it, not on the biggest box', [
  { at: 0, say: 'board; a big bus near, a small one far', board: board(), det: { BIG: [0.0, 0.2, 0.6, 0.7], FAR: [0.7, 0.35, 0.2, 0.15] }, expect: { BIG: 'none', FAR: 'none' } },
  { at: 0.3, say: 'the far one reads 9 Wabern twice', det: { BIG: [0.0, 0.2, 0.6, 0.7], FAR: [0.7, 0.35, 0.2, 0.15] },
    words: { captured: 0.3, on: { FAR: ['9', 'Wabern'] } }, expect: { BIG: 'none', FAR: 'neutral' } },
  { at: 0.6, say: 'again', det: { BIG: [0.0, 0.2, 0.6, 0.7], FAR: [0.7, 0.35, 0.2, 0.15] },
    words: { captured: 0.6, on: { FAR: ['9', 'Wabern'] } }, expect: { BIG: 'none', FAR: 'red' } },
]);

suite('A vehicle in doubt keeps its text from its neighbour', [
  { at: 0, say: 'board; A in front of a big box C that contains it', board: board(), det: { A: [0.3, 0.3, 0.3, 0.4], C: [0, 0.2, 0.7, 0.6] },
    expect: { A: 'none', C: 'none' } },
  { at: 0.3, say: 'two boxes now fit A equally: A is in doubt, C is not', det: { A: [0.27, 0.3, 0.3, 0.4], X: [0.33, 0.3, 0.3, 0.4], C: [0, 0.2, 0.7, 0.6] },
    expect: { A: 'none', X: 'none', C: 'none' } },
  { at: 0.6, say: 'reads of t=0 and t=0.3 arrive, on what was A: C does not get them', det: { A: [0.27, 0.3, 0.3, 0.4], X: [0.33, 0.3, 0.3, 0.4], C: [0, 0.2, 0.7, 0.6] },
    words: { captured: 0, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { C: 'none' } },
  { at: 0.65, say: 'again', det: { A: [0.27, 0.3, 0.3, 0.4], X: [0.33, 0.3, 0.3, 0.4], C: [0, 0.2, 0.7, 0.6] },
    words: { captured: 0.01, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { C: 'none' } },
]);

suite('A vehicle that takes the place of a lost one inherits nothing', [
  { at: 0, say: 'board; A is my 10', board: board(), det: { A: LEFT }, words: { captured: 0, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { A: 'green' } },
  { at: 0.2, say: 'the detector sees nothing', det: {}, expect: {} },
  { at: 0.5, say: 'B stands where A was, nothing read on it', det: { B: LEFT }, expect: { B: 'none' } },
]);
suite('Two reads of the same picture are one frame', [
  { at: 0, say: 'board', board: board(), det: { A: LEFT }, expect: { A: 'none' } },
  { at: 0.5, say: 'Tesseract reads 9 Wabern on the picture of t=0.3', det: { A: LEFT }, words: { captured: 0.3, on: { A: ['9', 'Wabern'] } }, expect: { A: 'neutral' } },
  { at: 0.7, say: 'PP-OCR reads the same picture (0.05 s apart): still one frame, no red', det: { A: LEFT },
    words: { captured: 0.35, on: { A: ['9', 'Wabern'] } }, expect: { A: ['neutral', /Display: 9/] } },
  { at: 0.9, say: 'a later picture: two frames, red', det: { A: LEFT }, words: { captured: 0.9, on: { A: ['9', 'Wabern'] } }, expect: { A: 'red' } },
]);

suite('Joining two reads of one picture never moves text onto another vehicle', [
  { at: 0.1, say: 'board; A and B side by side', board: board(), det: { A: [0.1, 0.3, 0.3, 0.4], B: [0.43, 0.3, 0.3, 0.4] }, expect: { A: 'none', B: 'none' } },
  { at: 0.12, say: 'a read of t=0.1: B shows 10 Rüti at its left edge (where A will be at t=0.22)', det: { A: [0.1, 0.3, 0.3, 0.4], B: [0.43, 0.3, 0.3, 0.4] },
    words: { captured: 0.1, on: {}, free: [{ text: 'Bernmobil', box: [0.15, 0.4, 0.15, 0.05], score: 0.95 },
      { text: '10', box: [0.44, 0.33, 0.02, 0.03], score: 0.95 }, { text: 'Rüti', box: [0.465, 0.33, 0.045, 0.03], score: 0.95 }] },
    expect: { A: 'none', B: 'green' } },
  { at: 0.22, say: 'both moved right; a read of t=0.22 on A joins its t=0.1 read', det: { A: [0.22, 0.3, 0.3, 0.4], B: [0.55, 0.3, 0.3, 0.4] },
    words: { captured: 0.22, on: {}, free: [{ text: 'Bernmobil', box: [0.27, 0.4, 0.15, 0.05], score: 0.95 }] }, expect: { A: 'none', B: 'green' } },
  { at: 0.5, say: 'B leaves: A has nothing of B', det: { A: [0.22, 0.3, 0.3, 0.4] }, expect: { A: 'none' } },
]);
suite('Two vehicles cross and the detector sees one box: the label is revoked, not handed on', [
  { at: 0, say: 'board; A is my 10, B beside it', board: board(), det: { A: [0.1, 0.3, 0.3, 0.4], B: [0.46, 0.3, 0.3, 0.4] },
    words: { captured: 0, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { A: 'green', B: 'none' } },
  { at: 0.33, say: 'one box between them (B in front)', det: { X: [0.25, 0.3, 0.3, 0.4] }, expect: { X: 'none' } },
]);
suite('A gyro with the wrong sign is never used', [
  { at: 0, say: 'board; A is my 10, B to its right', board: board(), det: { A: [0.1, 0.3, 0.25, 0.4], B: [0.45, 0.3, 0.25, 0.4] },
    words: { captured: 0, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { A: 'green', B: 'none' } },
  { at: 0.33, say: 'a pan moves the picture left by 0.15, the gyro says right by 0.2: B lands where the shift puts A',
    det: { A: [-0.05, 0.3, 0.25, 0.4], B: [0.3, 0.3, 0.25, 0.4] }, shift: { dx: 0.2, dy: 0 }, expect: { A: 'green', B: 'none' } },
]);
suite('Detections out of order are dropped', [
  { at: 1, say: 'board; A at t=1', board: board(), det: { A: LEFT }, expect: { A: 'none' } },
  { at: 0.8, say: 'an older detection arrives late: ignored', det: { A: LEFT }, expect: {} },
]);

// ---------------------------------------------------------------- stale and truncated boards
suite('Green and red need a complete, fresh board', [
  { at: 0, say: 'a board cut at its limit', board: board(BASE, false), det: { A: LEFT, B: RIGHT }, expect: { A: 'none' } },
  { at: 0.3, say: 'A reads 10 Rüti', det: { A: LEFT, B: RIGHT }, words: { captured: 0.3, on: { A: ['10', 'Ostermundigen Rüti'], B: ['9', 'Wabern'] } },
    expect: { A: ['neutral', /Display: 10 → Ostermundigen, Rüti/], B: 'neutral' } },
  { at: 0.6, say: 'complete board', board: board(), det: { A: LEFT, B: RIGHT }, words: { captured: 0.6, on: { A: ['10', 'Ostermundigen Rüti'], B: ['9', 'Wabern'] } },
    expect: { A: 'green', B: 'red' } },
  { at: 15.6, say: 'poll fails', board: 'fail', det: { A: LEFT, B: RIGHT }, words: { captured: 15.6, on: { A: ['10', 'Ostermundigen Rüti'], B: ['9', 'Wabern'] } },
    expect: { A: 'green', B: 'neutral' }, banner: /in \d min/ },
  { at: 15.9, say: 'B read twice on the 15 s old board', det: { A: LEFT, B: RIGHT }, words: { captured: 15.9, on: { A: ['10', 'Ostermundigen Rüti'], B: ['9', 'Wabern'] } },
    expect: { A: 'green', B: 'red' } },
  { at: 30.6, say: 'fails again (30 s old)', board: 'fail', det: { A: LEFT, B: RIGHT }, expect: { A: 'none', B: 'none' } },
  { at: 30.9, say: 'reads on the 30 s old board', det: { A: LEFT, B: RIGHT }, words: { captured: 30.9, on: { A: ['10', 'Ostermundigen Rüti'], B: ['9', 'Wabern'] } },
    expect: { A: 'green', B: 'neutral' } },
  { at: 31.2, say: 'and again', det: { A: LEFT, B: RIGHT }, words: { captured: 31.2, on: { A: ['10', 'Ostermundigen Rüti'], B: ['9', 'Wabern'] } },
    expect: { A: 'green', B: 'red' } },
  { at: 40.0, say: 'reads on the 39 s old board', det: { A: LEFT, B: RIGHT }, words: { captured: 40.0, on: { A: ['10', 'Ostermundigen Rüti'], B: ['9', 'Wabern'] } },
    expect: { A: 'green', B: 'neutral' } },
  { at: 40.3, say: 'and again', det: { A: LEFT, B: RIGHT }, words: { captured: 40.3, on: { A: ['10', 'Ostermundigen Rüti'], B: ['9', 'Wabern'] } },
    expect: { A: 'green', B: 'red' } },
  { at: 40.7, say: 'board older than 40 s: green and red revoked, due times expire', det: { A: LEFT, B: RIGHT },
    expect: { A: ['neutral', /Display: 10/], B: ['neutral', /Display: 9/] }, banner: /live times unavailable/ },
  { at: 41.0, say: 'new reads on the stale board: still only neutral', det: { A: LEFT, B: RIGHT }, words: { captured: 41.0, on: { A: ['10', 'Ostermundigen Rüti'], B: ['9', 'Wabern'] } },
    expect: { A: 'neutral', B: 'neutral' } },
  { at: 41.3, say: 'a new board brings them back', board: board(), det: { A: LEFT, B: RIGHT }, words: { captured: 41.3, on: { A: ['10', 'Ostermundigen Rüti'], B: ['9', 'Wabern'] } },
    expect: { A: 'green', B: 'red' } },
]);
// Red needs text in two frames, not a complete board (docs/ar-recognition-plan.md): the other departure it names is
// on the board, and what the display says does not depend on what else might be missing from it.
suite('Red on an incomplete board, green not', [
  { at: 0, say: 'a board cut at its limit', board: board(BASE, false), det: { A: LEFT, B: RIGHT }, expect: {} },
  { at: 0.3, say: 'reads', det: { A: LEFT, B: RIGHT }, words: { captured: 0.3, on: { A: ['10', 'Ostermundigen Rüti'], B: ['9', 'Wabern'] } }, expect: { A: 'neutral', B: 'neutral' } },
  { at: 0.6, say: 'reads again', det: { A: LEFT, B: RIGHT }, words: { captured: 0.6, on: { A: ['10', 'Ostermundigen Rüti'], B: ['9', 'Wabern'] } }, expect: { A: 'neutral', B: 'red' } },
]);
suite('No board at all: display text only', [
  { at: 0, say: 'A, no board yet', det: { A: LEFT }, expect: { A: 'none' }, banner: /live times unavailable/ },
  { at: 0.5, say: 'reads', det: { A: LEFT }, words: { captured: 0.5, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { A: 'none' } },
  { at: 1.0, say: 'reads', det: { A: LEFT }, words: { captured: 1.0, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { A: 'none' } },
  { at: 1.5, say: 'third read: the strict rule accepts, still only neutral', det: { A: LEFT }, words: { captured: 1.5, on: { A: ['10', 'Ostermundigen Rüti'] } },
    expect: { A: ['neutral', /Display: 10/] } },
]);

// ---------------------------------------------------------------- the rider's run: bound by trip, wrong quays
suite('The banner follows the planned trip, not the first run of the line', [
  { at: 0, say: 'an earlier 10 Rüti (another trip) comes first', board: board([E('T10z', '10', 'Ostermundigen, Rüti', { etaS: 30, servesTo: true }), MINE]),
    expect: {}, banner: /10 → Ostermundigen, Rüti · in 4 min$/ },
  { at: 1, say: 'my trip leaves from another quay today', board: board([{ ...MINE, quayId: 'Q-C', quayLabel: 'C' }]), expect: {}, banner: /leaves from C today/ },
  { at: 2, say: 'my trip is not on the board', board: board(BASE.slice(1)), expect: {}, banner: /not on the live board/ },
  { at: 3, say: 'my trip is cancelled', board: board([{ ...MINE, cancelled: true }]), expect: {}, banner: /cancelled/ },
]);
suite('Twin buses: green from its own read; two at once are both withheld', [
  { at: 0, say: 'two 10 Rüti due, both serve my stop', board: board([...BASE, E('T10c', '10', 'Ostermundigen, Rüti', { servesTo: true, etaS: 400 })]),
    det: { A: LEFT, B: RIGHT }, expect: { A: 'none', B: 'none' } },
  { at: 0.3, say: 'A reads 10 Rüti', det: { A: LEFT, B: RIGHT }, words: { captured: 0.3, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { A: 'green', B: 'none' } },
  { at: 0.6, say: 'B reads 10 Rüti too: which one to take is not for the camera to say', det: { A: LEFT, B: RIGHT },
    words: { captured: 0.6, on: { B: ['10', 'Ostermundigen Rüti'] } },
    expect: { A: ['neutral', /Display: 10/], B: ['neutral', /Display: 10/] } },
  { at: 1.0, say: 'B leaves: A alone is green again', det: { A: LEFT }, words: { captured: 1.0, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { A: 'green' } },
]);
suite('Express and local with the same display: no green', [
  { at: 0, say: 'a 10 Rüti that skips my stop is due too', board: board([...BASE, E('T10x', '10', 'Ostermundigen, Rüti', { servesTo: false, etaS: 60 })]),
    det: { A: LEFT }, expect: { A: 'none' } },
  { at: 0.3, say: 'A reads 10 Rüti', det: { A: LEFT }, words: { captured: 0.3, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { A: ['neutral', /Display: 10 → Ostermundigen, Rüti/] } },
  { at: 1, say: 'an old engine that does not say (servesTo unknown)', board: board([...BASE, E('T10x', '10', 'Ostermundigen, Rüti', { servesTo: undefined })]),
    det: { A: LEFT }, words: { captured: 1, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { A: 'neutral' } },
  { at: 2, say: 'a run that only sets down here', board: board([...BASE, E('T10y', '10', 'Ostermundigen, Rüti', { dep: null, servesTo: true })]),
    det: { A: LEFT }, words: { captured: 2, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { A: 'neutral' } },
]);
suite('My own trip, when the engine says it skips my stop today: no green', [
  { at: 0, say: 'my trip is on the board with servesTo false', board: board([{ ...MINE, servesTo: false }, ...BASE.slice(1)]), det: { A: LEFT }, expect: { A: 'none' } },
  { at: 0.3, say: 'A reads 10 Rüti', det: { A: LEFT }, words: { captured: 0.3, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { A: ['neutral', /Display: 10/] } },
  { at: 1, say: 'an engine without servesTo: my own trip is enough', board: board([{ ...MINE, servesTo: undefined }, ...BASE.slice(1)]),
    det: { A: LEFT }, words: { captured: 1, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { A: 'green' } },
]);
suite('A same-display express timed as departed still blocks green', [
  { at: 0, say: 'the express (skips my stop) should have left a minute ago', board: board([...BASE, E('T10x', '10', 'Ostermundigen, Rüti', { servesTo: false, state: 'departed', etaS: -60 })]),
    det: { A: LEFT }, expect: { A: 'none' } },
  { at: 0.3, say: 'A reads 10 Rüti: it may be the late express', det: { A: LEFT }, words: { captured: 0.3, on: { A: ['10', 'Ostermundigen Rüti'] } },
    expect: { A: ['neutral', /Display: 10/] } },
  { at: 1, say: 'a same-display run that may not be boarded here', board: board([...BASE, E('T10y', '10', 'Ostermundigen, Rüti', { servesTo: true, pickup: false })]),
    det: { A: LEFT }, words: { captured: 1, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { A: 'neutral' } },
]);
suite('Two frames that contradict the display but name nothing listed: no red (a correlated misread)', [
  { at: 0, say: 'board; my ride is a 7 to Ostring', board: board([E('T7a', '7', 'Bern, Ostring', { servesTo: true }), ...BASE.slice(1)]), det: { A: LEFT }, expect: { A: 'none' } },
  { at: 0.6, say: '"7 Detrina"', det: { A: LEFT }, words: { captured: 0.6, on: { A: ['7', 'Detrina'] } }, expect: { A: 'none' } },
  { at: 1.2, say: '"7 Detria" again: still nothing', det: { A: LEFT }, words: { captured: 1.2, on: { A: ['7', 'Detria'] } }, expect: { A: 'none' } },
], { line: '7', destination: 'Bern, Ostring', mode: 'tram', tripId: 'T7a', serviceDate: SD });
suite('Short turn: red after two frames', [
  { at: 0, say: 'a 10 to Zollgasse (before my stop) is due', board: board([...BASE, E('T10s', '10', 'Ostermundigen, Zollgasse', { servesTo: false })]),
    det: { A: LEFT }, expect: { A: 'none' } },
  { at: 0.3, say: 'A reads 10 Zollgasse', det: { A: LEFT }, words: { captured: 0.3, on: { A: ['10', 'Zollgasse'] } }, expect: { A: ['neutral', /Zollgasse/] } },
  { at: 0.6, say: 'again', det: { A: LEFT }, words: { captured: 0.6, on: { A: ['10', 'Zollgasse'] } }, expect: { A: ['red', /Not yours: 10 → Ostermundigen, Zollgasse/] } },
]);
suite('"Bern, Bahnhof" and "Bern Wankdorf, Bahnhof" stay two displays', [
  { at: 0, say: 'both due', board: board([E('T20a', '20', 'Bern, Bahnhof', { servesTo: true }), E('T20b', '20', 'Bern Wankdorf, Bahnhof', { servesTo: false })]),
    det: { A: LEFT }, expect: { A: 'none' } },
  { at: 0.3, say: 'A reads 20 Wankdorf Bahnhof', det: { A: LEFT }, words: { captured: 0.3, on: { A: ['20', 'Wankdorf Bahnhof'] } }, expect: { A: ['neutral', /Wankdorf/] } },
  { at: 0.6, say: 'again: red, not green', det: { A: LEFT }, words: { captured: 0.6, on: { A: ['20', 'Wankdorf Bahnhof'] } }, expect: { A: 'red' } },
], { line: '20', destination: 'Bern, Bahnhof', mode: 'bus', tripId: 'T20a', serviceDate: SD });

// ---------------------------------------------------------------- field captures
// A capture saved with "Save last 10 s" (src/app/ar.ts: format ar-capture/1) is replayed event by event through a new
// session. Its `expect` (added by hand once the glitch is understood) names labels that must never appear again,
// optionally only between two moments of the capture: { "never": ["green", "red"], "during": [1764000012.5, 1764000015] }.
interface Capture { ride: ArRide; log: ArEvent[]; expect?: { never?: ArLabelKind[]; during?: [number, number] } }
function replay(cap: Capture, each: (labels: ReturnType<ReturnType<typeof createArSession>['labels']>, at: number) => void) {
  const ses = createArSession(cap.ride);
  for (const e of cap.log) {
    if (e.type === 'detections') ses.detections(e.dets as { box: ArBox; score: number; cls?: string }[], e.at, (e.shift as { dx: number; dy: number } | null) || null);
    else if (e.type === 'words') ses.words(e.texts as ArText[], e.capturedAt as number, e.at);
    else if (e.type === 'board' && e.board) ses.board(e.board as ArBoard);
    else if (e.type === 'board_failed') ses.boardFailed(e.at);
    else continue;
    each(ses.labels(e.at), e.at);
  }
  return ses;
}
{
  console.log('A capture replays to the labels it was saved with');
  const steps = (at: number, words: boolean): Step => ({ at, say: '', det: { A: LEFT, B: RIGHT }, expect: { A: 'green', B: at < 0.9 ? 'neutral' : 'red' },
    words: words ? { captured: at, on: { A: ['10', 'Ostermundigen Rüti'], B: ['9', 'Wabern'] } } : undefined });
  const live = suite('  (recording)', [{ at: 0, say: 'board', board: board(), expect: {} }, steps(0.3, true), steps(0.6, false), steps(0.9, true), steps(2.0, false)]);
  const shown = (ls: { track: number; kind: string; text: string }[]) => ls.map((l) => `${l.track}:${l.kind}:${l.text}`).join('|');
  let last = '';
  replay({ ride: RIDE, log: JSON.parse(JSON.stringify(live.log())) }, (ls) => { last = shown(ls); });
  check(last === shown(live.labels(2.0)) && /green/.test(last) && /red/.test(last), `same labels after a JSON round trip (${last})`);
}
const REPLAYS = path.join(ROOT, 'tools', 'ar-replays');
if (fs.existsSync(REPLAYS)) {
  for (const f of fs.readdirSync(REPLAYS).filter((n) => n.endsWith('.json'))) {
    const cap = JSON.parse(fs.readFileSync(path.join(REPLAYS, f), 'utf8')) as Capture;
    console.log(`Field capture ${f}`);
    const never = (cap.expect && cap.expect.never) || [], during = cap.expect && cap.expect.during;
    let bad = 0;
    replay(cap, (ls, at) => { if (!during || (at >= during[0] && at <= during[1])) for (const l of ls) if (never.includes(l.kind)) bad++; });
    check(bad === 0, `${f}: none of ${JSON.stringify(never)} in the replay (${bad})`);
  }
}

console.log(`
${passed} passed, ${failed} failed (limits: ${JSON.stringify(AR_LIMITS)})`);
process.exit(failed ? 1 : 0);
