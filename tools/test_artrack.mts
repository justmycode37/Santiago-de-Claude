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
suite('A small vehicle swallowed by a big merged box revokes the track that took it', [
  { at: 0, say: 'board; S (small, far) is my 10, M beside it', board: board(), det: { S: [0.3, 0.35, 0.12, 0.12], M: [0.45, 0.3, 0.3, 0.3] },
    words: { captured: 0, on: { S: ['10', 'Ostermundigen Rüti'] } }, expect: { S: 'green', M: 'none' } },
  { at: 0.33, say: 'one big box covers both; it is matched to M, S is gone', det: { M: [0.25, 0.25, 0.5, 0.6] }, expect: { M: 'none' } },
]);
suite('A gyro with the wrong sign is never used', [
  { at: 0, say: 'board; A is my 10, B to its right', board: board(), det: { A: [0.1, 0.3, 0.25, 0.4], B: [0.45, 0.3, 0.25, 0.4] },
    words: { captured: 0, on: { A: ['10', 'Ostermundigen Rüti'] } }, expect: { A: 'green', B: 'none' } },
  { at: 0.33, say: 'a pan moves the picture left by 0.15, the gyro says right by 0.2: B lands where the shift puts A',
    det: { A: [-0.05, 0.3, 0.25, 0.4], B: [0.3, 0.3, 0.25, 0.4] }, shift: { dx: 0.2, dy: 0 }, expect: { A: 'none', B: 'none' } }, // gyro and boxes disagree: revoked
]);
suite('A pan just under the jerk limit: the neighbour does not inherit the green', [
  { at: 0, say: 'board; two vehicles side by side, the right one is my 10', board: board(), det: { L: [0.2, 0.3, 0.18, 0.4], R: [0.42, 0.3, 0.18, 0.4] },
    words: { captured: 0, on: { R: ['10', 'Ostermundigen Rüti'] } }, expect: { L: 'none', R: 'green' } },
  { at: 0.33, say: 'the phone turns: both move right by 0.22, the left one lands in the right one\'s old box', det: { L: [0.42, 0.3, 0.18, 0.4], R: [0.64, 0.3, 0.18, 0.4] },
    shift: { dx: 0.22, dy: 0 }, expect: { L: 'none', R: 'none' } },
]);
suite('A short turn needs two frames naming it', [
  { at: 0, say: 'board; my 7 to Ostring passes Kursaal first', board: board([E('T7a', '7', 'Bern, Ostring', { servesTo: true }), ...BASE.slice(1)]), det: { A: LEFT }, expect: { A: 'none' } },
  { at: 0.3, say: '"7 Kursaal"', det: { A: LEFT }, words: { captured: 0.3, on: { A: ['7', 'Bern Kursaal'] } }, expect: { A: 'none' } },
  { at: 0.6, say: '"7 Detrina": two contradictions, only one names a stop: no red', det: { A: LEFT }, words: { captured: 0.6, on: { A: ['7', 'Detrina'] } }, expect: { A: 'none' } },
], { line: '7', destination: 'Bern, Ostring', mode: 'tram', tripId: 'T7a', serviceDate: SD, stopsBefore: ['Bern, Kursaal'] });
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

// ---------------------------------------------------------------- memory: a vehicle keeps what its display said
const RUTI: [string, string] = ['10', 'Ostermundigen Rüti'];
/** The detector keeps seeing A (every 0.5 s) between two steps. */
const seen = (from: number, to: number, want: Want | ((t: number) => Want)): Step[] => {
  const out: Step[] = [];
  for (let t = from + 0.5; t < to - 1e-9; t += 0.5) out.push({ at: +t.toFixed(2), say: 'still in view', det: { A: LEFT }, expect: { A: typeof want === 'function' ? want(t) : want } });
  return out;
};
const junk = (b: ArBox): ArText[] => [{ text: 'WW', box: [b[0] + 0.1 * b[2], b[1] + 0.1 * b[3], 0.1 * b[2], 0.08 * b[3]], score: 0.9 },
  { text: 'KURZ', box: [b[0] + 0.3 * b[2], b[1] + 0.1 * b[3], 0.2 * b[2], 0.08 * b[3]], score: 0.9 }];
suite('Memory: a display read in two frames stays through garbled reads, then lapses', [
  { at: 0, say: 'board', board: board(), det: { A: LEFT }, expect: { A: 'none' } },
  { at: 0.3, say: 'my 10', det: { A: LEFT }, words: { captured: 0.3, on: { A: RUTI } }, expect: { A: 'green' } },
  { at: 0.9, say: 'again: remembered', det: { A: LEFT }, words: { captured: 0.9, on: { A: RUTI } }, expect: { A: 'green' } },
  { at: 1.5, say: 'it passes by: garbled text', det: { A: LEFT }, words: { captured: 1.5, on: {}, free: junk(LEFT) }, expect: { A: 'green' } },
  ...seen(1.5, 5, 'green'),
  { at: 5, say: 'nothing readable for 4 s', det: { A: LEFT }, words: { captured: 5, on: {}, free: junk(LEFT) }, expect: { A: 'green' } },
  ...seen(5, 12, 'green'),
  { at: 12, say: 'still the same vehicle, 11 s after the last good read', board: board(), det: { A: LEFT }, expect: { A: 'green' } },
  ...seen(12, 22, (t) => (t <= 20.9 ? 'green' : 'none')),
  { at: 22, say: 'more than 20 s after it: lapsed', board: board(), det: { A: LEFT }, expect: { A: 'none' } },
]);
suite('Memory: one contradicting frame hides the label, two forget it', [
  { at: 0, say: 'board', board: board(), det: { A: LEFT }, expect: { A: 'none' } },
  { at: 0.3, say: 'my 10', det: { A: LEFT }, words: { captured: 0.3, on: { A: RUTI } }, expect: { A: 'green' } },
  { at: 0.9, say: 'again: remembered', det: { A: LEFT }, words: { captured: 0.9, on: { A: RUTI } }, expect: { A: 'green' } },
  { at: 1.5, say: 'a 9 to Wabern once: hidden', det: { A: LEFT }, words: { captured: 1.5, on: { A: ['9', 'Wabern'] } }, expect: { A: 'none' } },
  ...seen(1.5, 4, 'none'),
  { at: 4, say: 'my 10 again: back', det: { A: LEFT }, words: { captured: 4, on: { A: RUTI } }, expect: { A: 'green' } },
  { at: 4.6, say: 'a 9 to Wabern', det: { A: LEFT }, words: { captured: 4.6, on: { A: ['9', 'Wabern'] } }, expect: { A: 'none' } },
  { at: 5.2, say: 'again: forgotten, and reads before now are not its own', det: { A: LEFT }, words: { captured: 5.2, on: { A: ['9', 'Wabern'] } }, expect: { A: 'none' } },
  { at: 5.8, say: 'a new read of 9 Wabern: one frame', det: { A: LEFT }, words: { captured: 5.8, on: { A: ['9', 'Wabern'] } }, expect: { A: ['neutral', /Wabern/] } },
  { at: 6.4, say: 'two: red', det: { A: LEFT }, words: { captured: 6.4, on: { A: ['9', 'Wabern'] } }, expect: { A: 'red' } },
]);
suite('Memory: one very clear picture is remembered', [
  { at: 0, say: 'board', board: board(), det: { A: LEFT }, expect: { A: 'none' } },
  { at: 0.3, say: 'my 10, once, sharp', det: { A: LEFT }, words: { captured: 0.3, on: { A: RUTI } }, expect: { A: 'green' } },
  ...seen(0.3, 2.5, 'green'),
  { at: 2.5, say: 'garbled, 2.2 s later: still remembered', det: { A: LEFT }, words: { captured: 2.5, on: {}, free: junk(LEFT) }, expect: { A: 'green' } },
]);
const WEAK = (b: ArBox): ArText[] => [{ text: '10', box: [b[0] + 0.05 * b[2], b[1] + 0.08 * b[3], 0.08 * b[2], 0.08 * b[3]], score: 0.75 },
  { text: 'Ostermundigen', box: [b[0] + 0.16 * b[2], b[1] + 0.08 * b[3], 0.4 * b[2], 0.08 * b[3]], score: 0.75 }];
suite('Memory: one weak picture is not remembered', [
  { at: 0, say: 'board', board: board(), det: { A: LEFT }, expect: { A: 'none' } },
  { at: 0.3, say: '"10 Ostermundigen", blurred: green for now', det: { A: LEFT }, words: { captured: 0.3, on: {}, free: WEAK(LEFT) }, expect: { A: 'green' } },
  ...seen(0.3, 2.5, 'green'),
  { at: 2.5, say: 'garbled, 2.2 s later: gone', det: { A: LEFT }, words: { captured: 2.5, on: {}, free: junk(LEFT) }, expect: { A: 'none' } },
]);
suite('Memory: a remembered red stays red, and a stale board still takes the colour away', [
  { at: 0, say: 'board', board: board(), det: { A: LEFT }, expect: { A: 'none' } },
  { at: 0.3, say: '9 Wabern', det: { A: LEFT }, words: { captured: 0.3, on: { A: ['9', 'Wabern'] } }, expect: { A: 'neutral' } },
  { at: 0.9, say: 'again: red, remembered', det: { A: LEFT }, words: { captured: 0.9, on: { A: ['9', 'Wabern'] } }, expect: { A: 'red' } },
  ...seen(0.9, 6, 'red'),
  { at: 6, say: 'garbled', det: { A: LEFT }, words: { captured: 6, on: {}, free: junk(LEFT) }, expect: { A: 'red' } },
  ...seen(6, 45, (t) => (t <= 20.9 ? 'red' : 'none')),
  { at: 45, say: 'the board is stale (and the memory lapsed)', det: { A: LEFT }, expect: { A: 'none' } },
]);
suite('Memory: a stale board takes a remembered green away at once', [
  { at: 0, say: 'board', board: board(), det: { A: LEFT }, expect: { A: 'none' } },
  { at: 0.3, say: 'my 10', det: { A: LEFT }, words: { captured: 0.3, on: { A: RUTI } }, expect: { A: 'green' } },
  { at: 0.9, say: 'again: remembered', det: { A: LEFT }, words: { captured: 0.9, on: { A: RUTI } }, expect: { A: 'green' } },
  ...seen(0.9, 15, 'green'),
  { at: 15, say: 'a read again: remembered 20 s from now', det: { A: LEFT }, words: { captured: 15, on: { A: RUTI } }, expect: { A: 'green' } },
  ...seen(15, 41, (t) => (t <= 35 ? 'green' : 'none')),
  { at: 41, say: 'no board for 41 s: display text only', det: { A: LEFT }, words: { captured: 41, on: { A: RUTI } }, expect: { A: ['neutral', /Display: 10/] } },
]);
suite('Memory is forgotten when two vehicles cross', [
  { at: 0, say: 'board; A is my 10, B beside it', board: board(), det: { A: [0.1, 0.3, 0.3, 0.4], B: [0.5, 0.3, 0.3, 0.4] },
    words: { captured: 0, on: { A: RUTI } }, expect: { A: 'green', B: 'none' } },
  { at: 0.6, say: 'again: remembered', det: { A: [0.12, 0.3, 0.3, 0.4], B: [0.48, 0.3, 0.3, 0.4] }, words: { captured: 0.6, on: { A: RUTI } }, expect: { A: 'green', B: 'none' } },
  { at: 0.9, say: 'they overlap heavily', det: { A: [0.25, 0.3, 0.3, 0.4], B: [0.32, 0.3, 0.3, 0.4] }, expect: { A: 'none', B: 'none' } },
  { at: 1.2, say: 'apart again: neither has it', det: { A: [0.1, 0.3, 0.3, 0.4], B: [0.5, 0.3, 0.3, 0.4] }, expect: { A: 'none', B: 'none' } },
]);
suite('A one-detection box beside a remembered vehicle does not wipe it', [
  { at: 0, say: 'board; A is my 10', board: board(), det: { A: [0.1, 0.3, 0.3, 0.4] }, words: { captured: 0, on: { A: RUTI } }, expect: { A: 'green' } },
  { at: 0.3, say: 'again: remembered', det: { A: [0.1, 0.3, 0.3, 0.4] }, words: { captured: 0.3, on: { A: RUTI } }, expect: { A: 'green' } },
  { at: 0.5, say: 'a small box flickers at its edge (a part of it)', det: { A: [0.1, 0.3, 0.3, 0.4], P: [0.36, 0.38, 0.1, 0.2] }, expect: { A: 'green', P: 'none' } },
  { at: 0.7, say: 'gone again; A grows a little', det: { A: [0.1, 0.3, 0.34, 0.41] }, expect: { A: 'green' } },
]);
suite('A vehicle seen twice that vanishes into a remembered one wipes it', [
  { at: 0, say: 'board; A is my 10, B beside it', board: board(), det: { A: [0.1, 0.3, 0.3, 0.4], B: [0.42, 0.38, 0.12, 0.2] }, words: { captured: 0, on: { A: RUTI } }, expect: { A: 'green', B: 'none' } },
  { at: 0.3, say: 'again: remembered', det: { A: [0.1, 0.3, 0.3, 0.4], B: [0.42, 0.38, 0.12, 0.2] }, words: { captured: 0.3, on: { A: RUTI } }, expect: { A: 'green', B: 'none' } },
  { at: 0.6, say: 'one box over both', det: { A: [0.1, 0.3, 0.44, 0.4] }, expect: { A: 'none' } },
]);
suite('A box that jumps in size hides a remembered display until it is read again', [
  { at: 0, say: 'board; A is my 10', board: board(), det: { A: [0.1, 0.3, 0.25, 0.4] }, words: { captured: 0, on: { A: RUTI } }, expect: { A: 'green' } },
  { at: 0.3, say: 'again: remembered', det: { A: [0.1, 0.3, 0.25, 0.4] }, words: { captured: 0.3, on: { A: RUTI } }, expect: { A: 'green' } },
  { at: 0.5, say: 'the box doubles in width in one detection', det: { A: [0.1, 0.3, 0.5, 0.4] }, expect: { A: 'none' } },
  { at: 0.8, say: 'its display read again: back', det: { A: [0.1, 0.3, 0.5, 0.4] }, words: { captured: 0.8, on: { A: RUTI } }, expect: { A: 'green' } },
]);
const TWO: ArText[] = [{ text: '10', box: [0.08, 0.33, 0.03, 0.03], score: 0.95 }, { text: 'Ostermundigen Rüti', box: [0.12, 0.33, 0.2, 0.03], score: 0.95 },
  { text: 'Wabern Tram-Endstation', box: [0.6, 0.33, 0.25, 0.03], score: 0.95 }];
suite('Two displays in one box (two vehicles the detector merged): no label', [
  { at: 0, say: 'board; one wide box', board: board(), det: { W: [0.05, 0.3, 0.9, 0.4] }, expect: { W: 'none' } },
  { at: 0.3, say: 'my 10 on the left, Wabern Tram-Endstation (no number) on the right', det: { W: [0.05, 0.3, 0.9, 0.4] },
    words: { captured: 0.3, on: {}, free: TWO }, expect: { W: 'none' } },
  { at: 0.6, say: 'again', det: { W: [0.05, 0.3, 0.9, 0.4] }, words: { captured: 0.6, on: {}, free: TWO }, expect: { W: 'none' } },
]);
{
  // the reader: a vehicle not yet known goes before one already known
  const ses = createArSession(RIDE);
  ses.board({ at: 0, entries: BASE, complete: true });
  for (const at of [0, 0.3, 0.9]) {
    ses.detections([{ box: LEFT, score: 0.9 }, { box: RIGHT, score: 0.9 }], at);
    if (at) ses.words(displayOn(LEFT, ...RUTI), at, at);
  }
  ses.detections([{ box: LEFT, score: 0.9 }, { box: RIGHT, score: 0.9 }], 1.0);
  const pick = ses.readTarget(1.0), again = ses.readTarget(1.05);
  check(pick !== 'road' && pick[0] === RIGHT[0], `reader: first the vehicle not yet known (got ${JSON.stringify(pick)})`);
  check(again !== 'road' && again[0] === RIGHT[0], `reader: the known one waits for its re-check (got ${JSON.stringify(again)})`);
}

suite('Review: a remembered red goes when a board refresh drops that departure', [
  { at: 0, say: 'board with a 9 to Wabern', board: board(), det: { A: LEFT }, expect: { A: 'none' } },
  { at: 0.3, say: '9 Wabern', det: { A: LEFT }, words: { captured: 0.3, on: { A: ['9', 'Wabern'] } }, expect: { A: 'neutral' } },
  { at: 0.9, say: 'again: red, remembered', det: { A: LEFT }, words: { captured: 0.9, on: { A: ['9', 'Wabern'] } }, expect: { A: 'red' } },
  { at: 1.5, say: 'a new board without it; a garbled read', board: board(BASE.filter((e) => e.tripId !== 'T9a')), det: { A: LEFT },
    words: { captured: 1.5, on: {}, free: junk(LEFT) }, expect: { A: 'none' } }, // forgotten: its pictures no longer name anything listed
]);
suite('Review: two reads of one picture, one display each, joined: no label', [
  { at: 0, say: 'board; one wide box', board: board(), det: { W: [0.05, 0.3, 0.9, 0.4] }, expect: { W: 'none' } },
  { at: 0.3, say: 'one engine reads my 10 on the left', det: { W: [0.05, 0.3, 0.9, 0.4] },
    words: { captured: 0.3, on: {}, free: TWO.slice(0, 2) }, expect: { W: 'green' } },
  { at: 0.4, say: 'the other engine reads Wabern Tram-Endstation on the right of the same picture', det: { W: [0.05, 0.3, 0.9, 0.4] },
    words: { captured: 0.31, on: {}, free: TWO.slice(2) }, expect: { W: 'none' } },
]);
// A known limit (docs/ar-labels-bench.md): a box seen once inside a remembered vehicle's box, then gone, is taken for
// flicker, so the colour comes back; only while both boxes are there is the big one left without colour.
suite('A box seen once inside a remembered vehicle: no colour while both are seen', [
  { at: 0, say: 'board; A is my 10', board: board(), det: { A: [0.1, 0.3, 0.4, 0.45] }, words: { captured: 0, on: { A: RUTI } }, expect: { A: 'green' } },
  { at: 0.3, say: 'again: remembered', det: { A: [0.1, 0.3, 0.4, 0.45] }, words: { captured: 0.3, on: { A: RUTI } }, expect: { A: 'green' } },
  { at: 0.5, say: 'a small vehicle behind it, inside its box, seen once (no colour on a box holding another)', det: { A: [0.1, 0.3, 0.4, 0.45], S: [0.28, 0.35, 0.16, 0.2] },
    expect: { A: 'none', S: 'none' } },
  { at: 0.7, say: 'one box again, the same size: taken for flicker (the known limit)', det: { A: [0.1, 0.3, 0.4, 0.45] }, expect: { A: 'green' } },
]);
{
  // the picture clock: two reads of one presented frame get one moment, a new frame a new one
  const { pictureTime } = await import('../src/pictime.ts');
  let cb: ((now: number, meta: { presentationTime?: number }) => void) | null = null;
  const video = { requestVideoFrameCallback: (f: typeof cb) => { cb = f; return 1; } };
  pictureTime(video, 1000); // starts watching
  cb!(performance.now(), { presentationTime: performance.now() });
  const a = pictureTime(video, 5000), b = pictureTime(video, 9000);
  check(a === b, `picture clock: the same frame read twice, 4 s apart, has one moment (${a}, ${b})`);
  cb!(performance.now(), { presentationTime: performance.now() });
  check(pictureTime(video, 9500) >= a, 'picture clock: a new frame, a moment not before the last');
  check(pictureTime({}, 1234) === 1234, 'picture clock: without frame callbacks, now');
}

suite('Review: no memory from a clear read right after a read of two displays in the box', [
  { at: 0, say: 'board; one wide box', board: board(), det: { W: [0.05, 0.3, 0.9, 0.4] }, expect: { W: 'none' } },
  { at: 0.3, say: 'two displays in it', det: { W: [0.05, 0.3, 0.9, 0.4] }, words: { captured: 0.3, on: {}, free: TWO }, expect: { W: 'none' } },
  ...[0.8, 1.3, 1.8, 2.3].map((t): Step => ({ at: t, say: 'still one box', det: { W: [0.05, 0.3, 0.9, 0.4] }, expect: {} })),
  { at: 2.6, say: 'my 10 alone, sharp: green for now (the decision), not remembered', det: { W: [0.05, 0.3, 0.9, 0.4] },
    words: { captured: 2.6, on: {}, free: TWO.slice(0, 2) }, expect: { W: 'green' } },
  ...[3.1, 3.6, 4.1, 4.6].map((t): Step => ({ at: t, say: 'still one box', det: { W: [0.05, 0.3, 0.9, 0.4] }, expect: { W: 'green' } })),
  { at: 4.9, say: 'garbled, 2.3 s later: gone', det: { W: [0.05, 0.3, 0.9, 0.4] }, words: { captured: 4.9, on: {}, free: junk([0.05, 0.3, 0.9, 0.4]) }, expect: { W: 'none' } },
]);
suite('Review: nothing is remembered on an incomplete board', [
  { at: 0, say: 'a board cut at its limit', board: board(BASE, false), det: { A: LEFT }, expect: { A: 'none' } },
  { at: 0.3, say: 'my 10', det: { A: LEFT }, words: { captured: 0.3, on: { A: RUTI } }, expect: { A: ['neutral', /Display: 10/] } },
  { at: 0.9, say: 'again', det: { A: LEFT }, words: { captured: 0.9, on: { A: RUTI } }, expect: { A: ['neutral', /Display: 10/] } },
  { at: 1.2, say: 'a complete board: green from the reads in hand', board: board(), det: { A: LEFT }, expect: { A: 'green' } },
  ...seen(1.2, 3.5, 'green'),
  { at: 3.5, say: 'garbled, 2.6 s after the last good read: gone (it was never remembered)', det: { A: LEFT }, words: { captured: 3.5, on: {}, free: junk(LEFT) }, expect: { A: 'none' } },
]);
suite('Review: a box that jumps in size loses a label that is not remembered too', [
  { at: 0, say: 'board', board: board(), det: { A: [0.1, 0.3, 0.2, 0.4] }, expect: { A: 'none' } },
  { at: 0.3, say: '"10 Ostermundigen", blurred: green for now', det: { A: [0.1, 0.3, 0.2, 0.4] }, words: { captured: 0.3, on: {}, free: WEAK([0.1, 0.3, 0.2, 0.4]) }, expect: { A: 'green' } },
  { at: 0.6, say: 'its box triples in width', det: { A: [0.1, 0.3, 0.6, 0.4] }, expect: { A: 'none' } },
]);
suite('Review: a late read that contradicts a remembered display counts at its own moment', [
  { at: 0, say: 'board', board: board(), det: { A: LEFT }, expect: { A: 'none' } },
  ...seen(0, 2.0, 'none'),
  { at: 2.0, say: 'my 10, sharp: remembered', det: { A: LEFT }, words: { captured: 2.0, on: { A: RUTI } }, expect: { A: 'green' } },
  { at: 2.4, say: 'garbled', det: { A: LEFT }, words: { captured: 2.4, on: {}, free: junk(LEFT) }, expect: { A: 'green' } },
  { at: 2.8, say: 'a slow read of 1.8 arrives: 9 Wabern: hidden', det: { A: LEFT }, words: { captured: 1.8, on: { A: ['9', 'Wabern'] } }, expect: { A: 'none' } },
]);

// ---------------------------------------------------------------- what can be here: the board's live times
// A clear "Wabern" fits a 9 and a 19 to Wabern, Tram-Endstation equally. For a rider waiting for the 7 it is not
// theirs whichever it is: red, naming both, the likelier in view now (live times) first. For a rider waiting for the 9
// it stays unlabelled however far the 19 is: timing only orders a name, it never makes a vehicle green or red. A
// garbled read ("abern") is never enough for this.
const OST = E('T7', '7', 'Bern, Ostring', { servesTo: true, live: true, etaS: 60 });
const W9 = (eta: number) => E('T9w', '9', 'Wabern, Tram-Endstation', { servesTo: false, live: true, etaS: eta });
const W19 = (eta: number) => E('T19', '19', 'Wabern, Tram-Endstation', { servesTo: false, live: true, etaS: eta }); // another line, the same destination
const RIDE7: ArRide = { line: '7', destination: 'Bern, Ostring', mode: 'tram', tripId: 'T7', serviceDate: SD };
const RIDE9: ArRide = { line: '9', destination: 'Wabern, Tram-Endstation', mode: 'tram', tripId: 'T9w', serviceDate: SD };
const abern = (at: number): Step => ({ at, say: '"abern"', det: { A: LEFT }, words: { captured: at, on: { A: ['', 'abern'] } }, expect: {} });
const wabern = (at: number): Step => ({ at, say: '"Wabern"', det: { A: LEFT }, words: { captured: at, on: { A: ['', 'Wabern'] } }, expect: {} });
suite('Context: "Wabern" for a rider of the 7, a 9 close and a 19 far: red, naming both, the 9 first', [
  { at: 0, say: 'board', board: board([OST, W9(30), W19(900)]), det: { A: LEFT }, expect: { A: 'none' } },
  wabern(0.3),
  { ...wabern(0.9), expect: { A: ['red', /^Not yours: 9\/19 → Wabern, Tram-Endstation$/] } },
], RIDE7);
suite('Context: the same with the 19 close and the 9 far: the same red, the 19 first', [
  { at: 0, say: 'board', board: board([OST, W9(900), W19(30)]), det: { A: LEFT }, expect: { A: 'none' } },
  wabern(0.3),
  { ...wabern(0.9), expect: { A: ['red', /^Not yours: 19\/9 → Wabern, Tram-Endstation$/] } },
], RIDE7);
suite('Context: a garbled "abern" is never enough for red', [
  { at: 0, say: 'board', board: board([OST, W9(30), W19(900)]), det: { A: LEFT }, expect: { A: 'none' } },
  { ...abern(0.3), expect: { A: 'none' } },
  { ...abern(0.9), expect: { A: 'none' } },
  { ...abern(1.5), expect: { A: 'none' } },
], RIDE7);
for (const far of [900, 30]) for (const read of [abern, wabern]) {
  suite(`Context: ${read === abern ? '"abern"' : '"Wabern"'} for a rider waiting for the 9, the 19 ${far === 900 ? 'far away' : 'close'}: no colour either way`, [
    { at: 0, say: 'board', board: board([W9(30), W19(far)]), det: { A: LEFT }, expect: { A: 'none' } },
    ...[0.3, 0.9, 1.5].map((t) => ({ ...read(t), expect: { A: 'none' as const } })),
  ], RIDE9);
}

// review: a tentative 9 ("y Wabern") never tells a 9 from a 19 to the same place
const RIDE19: ArRide = { line: '19', destination: 'Wabern, Tram-Endstation', mode: 'tram', tripId: 'T19', serviceDate: SD };
for (const ride of [RIDE9, RIDE19]) {
  suite(`Review: "y Wabern" with a 9 and a 19 due, rider of the ${ride.line}: no colour`, [
    { at: 0, say: 'board', board: board([W9(30), W19(30)]), det: { A: LEFT }, expect: { A: 'none' } },
    ...[0.3, 0.9, 1.5].map((t): Step => ({ at: t, say: '"y Wabern"', det: { A: LEFT }, words: { captured: t, on: { A: ['y', 'Wabern'] } }, expect: { A: 'none' } })),
  ], ride);
}

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
