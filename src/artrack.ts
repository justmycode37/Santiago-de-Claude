// AR vehicles: which box on screen is which vehicle, which display read belongs to which vehicle, and what label each
// one may carry. DOM-free like arcore.ts, so Node replays scripted events through exactly this code
// (tools/test_artrack.mts) and the AR camera (src/app/ar.ts) only feeds it and draws what it answers.
//
// The plan (docs/ar-recognition-plan.md) puts safety in structural rules, not in tuned numbers:
// - Ownership. Every detected vehicle is a track with its own id. A display read is stamped with the moment its picture
//   was taken and goes to the track whose box held the text at that moment, never to "the biggest box now". A track
//   whose identity may have swapped (two boxes crossing, an ambiguous match from one detection to the next, a fast
//   pan) loses its reads and its label: it is revoked, not handed on.
// - Green only when the unchanged display matcher (arcore.ts decide) accepts this track's own reads, the Kante board
//   is fresh and complete, and every run due here that shows that display boards here and serves the rider's stop.
//   Otherwise the display text is shown neutrally ("Display: 10 → Rüti").
// - Red only from text: another departure's display, a short turn, or "out of service", each in two distinct frames,
//   on a fresh board. Timing, direction and position never paint a vehicle; they only fill the banner.
// - No "probably yours" on a vehicle.
//
// Times are seconds (Date.now() / 1000 on the phone). Boxes are arcore.ts's: [x, y, w, h], 0–1 of the picture.
import { ARCORE } from './arcore.ts';
import type { ArBox, ArCandidate, ArDecision, ArExpectation, ArReading, ArText } from './arcore.ts';
export type { ArBox, ArText };

/** One detected vehicle in one picture. cls is kept for the box's caption only: tracking ignores it (a tram flickers between "bus" and "train"). */
export interface ArDet { box: ArBox; score: number; cls?: string }
/** How far the picture moved since the last detection because the phone turned (gyro), as a fraction of its width and height. */
export interface ArShift { dx: number; dy: number }
/** One departure on the Kante board (/api/due). */
export interface ArBoardEntry {
  tripId?: string; serviceDate?: string;
  line: string; headsign: string; vias?: string[];
  quayId?: string | null; quayLabel?: string | null;
  state?: 'approaching' | 'at-stop' | 'departed';
  /** Seconds from the board's `t` to its arrival here (departure where it starts here). */
  etaS?: number | null;
  /** null: it only sets down here (no departure). undefined: not told. */
  dep?: number | null;
  /** false: riders may not board it here (it only sets down, or is skipped today). */
  pickup?: boolean;
  cancelled?: boolean;
  /** Does it call at the rider's stop after this one? /api/due with `to=`; undefined: not told. */
  servesTo?: boolean | null;
}
export interface ArBoard {
  /** When the phone got it. */
  at: number;
  entries: ArBoardEntry[];
  /** The engine says nothing is missing (not cut at its limit, live data not stale). Without it there is no green. */
  complete: boolean;
}
/** The ride the rider wants to board here. */
export interface ArRide {
  line: string; destination: string; vias?: string[];
  /** How the rider's vehicle is called on screen: "bus", "tram"… */
  mode?: string;
  /** The planned trip: the board's entry with this trip and day is the rider's run (no guessing by line). */
  tripId?: string; serviceDate?: string;
  /** The planned boarding point, to tell the rider when the run leaves from another one today. */
  quayId?: string; quayLabel?: string;
  /** The ride's stops before where the rider gets off: the same line showing one of them is a short turn. */
  stopsBefore?: string[];
  /** Planned departure here, unix seconds (the banner's fallback without a board). */
  dep?: number;
}
export type ArLabelKind = 'none' | 'neutral' | 'green' | 'red';
export interface ArLabel { track: number; box: ArBox; cls?: string; kind: ArLabelKind; text: string; reason: string }
/** What happened, for the debug capture ("save last 10 s") and for replaying it. */
export interface ArEvent { at: number; type: string; [k: string]: unknown }

export const AR_LIMITS = {
  /** A box must overlap its track's predicted box this much to be the same vehicle. */
  IOU_MATCH: 0.2,
  /** A second box (or track) this close to the best one makes the match ambiguous. */
  AMBIGUOUS_RATIO: 0.7,
  /** A track seen in fewer detections than this, and small beside a remembered vehicle, is flicker (flicker()). */
  BLIP_HITS: 2,
  /** A box that holds another vehicle's box (80 % of it, at least this share of its own area) gets no colour. */
  HOLDS_MIN: 0.05,
  /** A box whose width or height changes more than this between two detections this far apart (s) may have taken in
   *  or lost a second vehicle: one vehicle's change on the bench (YOLOX-tiny boxes of labelled passes; width p99.5,
   *  height p99.9: a passing tram's box changes height often, and two vehicles side by side change its width),
   *  interpolated, the last value beyond 1 s. */
  JUMP_W: [[0.2, 1.66], [0.4, 1.76], [0.6, 1.99], [0.8, 2.37], [1.0, 2.78]] as [number, number][],
  JUMP_H: [[0.2, 1.31], [0.4, 1.42], [0.6, 1.61], [0.8, 1.77], [1.0, 2.0]] as [number, number][],
  /** Two tracks overlapping this much may swap identities: both are revoked. */
  IOU_CROSSING: 0.3,
  /** A track missing from one detection is gone (a vehicle seen again is a new track without a label: another
   *  vehicle can take its place, and nothing could tell). Two detections this far apart are not compared at all. */
  LOST_S: 1.2,
  /** Reads of pictures taken this close together are one frame (Tesseract and PP-OCR can read the same picture). */
  SAME_FRAME_S: 0.12,
  /** A box is drawn while it was seen this recently. */
  SHOWN_S: 0.6,
  /** The phone turned more than this (fraction of the picture) between two detections: every track is revoked. */
  PAN_MAX: 0.25,
  /** How long a track's box history is kept (to place reads that come late). */
  HISTORY_S: 6,
  /** A read is placed on the box of its capture moment, from history samples at most this far apart. */
  HISTORY_GAP_S: 0.8,
  /** A read that comes this late is dropped. */
  LATE_S: 4,
  /** A label stays this long after the read that made it. */
  HOLD_S: 8,
  /** The board is stale (and every green and red revoked) when the last good poll is older than this. */
  BOARD_STALE_S: 40,
  /** A stale board is still used to tell displays apart (neutral text only) this long. */
  BOARD_MATCH_S: 300,
  /** Distinct frames that a red needs. */
  RED_FRAMES: 2,
  /** A track remembers what its display said once this many distinct frames agree within LATCH_S (green or red). */
  LATCH_FRAMES: 2,
  LATCH_S: 6,
  /** A remembered display stays this long after the last read that supported it, while the track stays the same
   *  vehicle (any doubt about that forgets it). Garbled and unreadable reads neither support nor clear it. */
  MEMORY_S: 20,
  /** A picture counts for a display when it matches it this well on its own (the matcher's floor for a frame that
   *  takes part in a consensus, arcore.ts CONSENSUS_MIN). */
  PICTURE_MIN: 0.35,
  /** One picture alone is remembered when it matches this well (its confidence × frame quality). */
  LATCH_SINGLE_MIN: 0.8,
  /** Distinct frames that contradict a remembered display before it is forgotten (one only hides the label). */
  FORGET_FRAMES: 2,
  /** Two text groups this far apart (share of the box's width) that each match a listed display: two vehicles in one box. */
  SPLIT_GAP: 0.12,
  /** A vehicle whose display is remembered is read again after this long (the others go first). */
  RECHECK_S: 1.5,
  /** Debug capture length. */
  LOG_S: 10,
};

interface Track {
  id: number;
  box: ArBox; score: number; cls?: string;
  born: number; lastSeen: number; hits: number;
  history: { at: number; box: ArBox }[];
  readings: ArReading[];
  decision: ArDecision | null;
  decidedAt: number;
  /** The last moment its identity was in doubt: reads captured before it are not its own. */
  contestedAt: number;
  /** What its display said, once LATCH_FRAMES frames agreed; kept through unreadable reads. support: the readings
   *  that said it (checked again when the board's departures change); board: those departures then. */
  memory: { key: string; decision: ArDecision; since: number; lastSupport: number; frames: number; support: ArReading[]; board: string } | null;
  /** Capture moment of its last read that showed two displays (a box over two vehicles): no latching near it. */
  twoAt: number;
  /** Pictures that each named a display on their own (key), for latching. */
  named: { key: string; at: number; frame: string; decision: ArDecision }[];
  /** Frames that contradicted the memory since it was last supported; the first hides the label. */
  against: { at: number; frame: string }[];
  /** When the display reader last looked at it. */
  lastRead: number;
}

const iou = ARCORE.iou;
// Frame ids are unique across sessions: arcore.ts memoises a frame's match by its id (and the board), so an id used
// again by a later session with the same board would be answered with an old picture's text.
let frameSeq = 0;
const shifted = (b: ArBox, s: ArShift | null): ArBox => (s ? [b[0] + s.dx, b[1] + s.dy, b[2], b[3]] : b);
const midX = (b: ArBox) => b[0] + b[2] / 2;
/** The limit of a JUMP_* table at a step of dt seconds. */
const jumpLimit = (table: [number, number][], dt: number) => {
  if (dt <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [t1, v1] = table[i], [t0, v0] = table[i - 1];
    if (dt <= t1) return v0 + (v1 - v0) * (dt - t0) / (t1 - t0);
  }
  return table[table.length - 1][1];
};
/** How much of box a lies inside box b (0–1). */
const insideShare = (a: ArBox, b: ArBox) => {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return (ix * iy) / Math.max(1e-9, a[2] * a[3]);
};

/** Two reads of one picture as one reading (at the first's moment). Two different line/destination pairs make it
 *  ambiguous, as two pairs in one read do; out of service from either counts. */
export function joinReadings(a: ArReading, b: ArReading, frameId: string): ArReading {
  const observed = [...a.observed];
  for (const t of b.observed) if (!observed.some((o) => o.text === t.text && iou(o.box, t.box) > 0.5)) observed.push(t);
  const pa = a.line != null && a.destination != null ? a.line + '|' + a.destination : null;
  const pb = b.line != null && b.destination != null ? b.line + '|' + b.destination : null;
  const clash = !!pa && !!pb && pa !== pb;
  const pick = pa ? a : pb ? b : null;
  return {
    frameId, at: a.at, line: clash || !pick ? null : pick.line, destination: clash || !pick ? null : pick.destination,
    outOfService: a.outOfService || b.outOfService, ambiguous: a.ambiguous || b.ambiguous || clash,
    raw: [...new Set([...a.raw, ...b.raw])], observed: observed.slice(0, 24), frameQuality: Math.max(a.frameQuality, b.frameQuality),
  };
}

/** onEvent: every event of the session's log as it happens (the bench counts them; the log keeps only LOG_S). */
export function createArSession(ride: ArRide, onEvent?: (e: ArEvent) => void) {
  const L = AR_LIMITS;
  let tracks: Track[] = [];
  /** Tracks gone in the last few seconds: their boxes still keep late text from a neighbour; they own nothing. */
  let gone: Track[] = [];
  let nextId = 1;
  let board: ArBoard | null = null;
  let lastDetections = -Infinity;
  const log: ArEvent[] = [];
  let lastBoardEvent: ArEvent | null = null;
  // The gyro shift is used only once it has shown it helps: on a phone whose axes or signs differ it would move a
  // track's box onto its neighbour. Until then (and if it stops helping) boxes are matched unshifted, and a pan
  // simply breaks tracks (labels are lost, never handed on).
  const derot = { on: false, better: 0, worse: 0 };

  const note = (e: ArEvent) => {
    if (onEvent) onEvent(e);
    log.push(e);
    while (log.length && log[0].at < e.at - L.LOG_S) log.shift();
  };
  const contest = (t: Track, at: number, why: string) => {
    if (t.decision || t.readings.length) note({ at, type: 'revoke', track: t.id, why });
    if (t.memory) note({ at, type: 'forget', track: t.id, why });
    t.contestedAt = at; t.readings = []; t.decision = null; t.memory = null; t.named = []; t.against = [];
  };

  /** Identity in some doubt (its box jumped in size): a remembered display is hidden until a picture taken
   *  after now says it again (and forgotten on one more contradiction); a track with nothing remembered is revoked. */
  const doubt = (t: Track, at: number, why: string) => {
    if (!t.memory) { contest(t, at, why); return; }
    if (!t.against.some((x) => x.frame === why && x.at === at)) t.against.push({ at, frame: why });
    note({ at, type: 'doubt', track: t.id, why });
    if (t.against.length >= L.FORGET_FRAMES) contest(t, at, why);
  };

  /**
   * A new set of detections (one picture, taken at `at`; older than the last one: ignored). shift: how far the phone's
   * turn moved the picture since the last one (portrait only); pan: how far it turned, as a fraction of the picture, in
   * any orientation (default: the shift's length), for revoking every label on a jerk.
   */
  function detections(dets: ArDet[], at: number, shift: ArShift | null = null, pan: number | null = null) {
    if (at <= lastDetections) { note({ at, type: 'detections_dropped', why: 'out_of_order' }); return; }
    note({ at, type: 'detections', dets: dets.map((d) => ({ box: d.box, score: d.score, cls: d.cls })), shift, pan });
    const live = tracks.filter((t) => at - t.lastSeen <= L.LOST_S);
    const use = derot.on ? shift : null;
    const turned = pan != null ? pan : shift ? Math.hypot(shift.dx, shift.dy) : 0;
    if (turned > L.PAN_MAX) for (const t of live) contest(t, at, 'fast_pan');
    const pred = live.map((t) => shifted(t.box, use));
    // learn whether the gyro shift helps (only when it is big enough to tell)
    // learned only with one vehicle and one box in view: a neighbour can fit a shifted box by chance
    if (shift && Math.hypot(shift.dx, shift.dy) > 0.03 && live.length === 1 && dets.length === 1) {
      live.forEach((t) => {
        const raw = Math.max(0, ...dets.map((d) => iou(t.box, d.box))), moved = Math.max(0, ...dets.map((d) => iou(shifted(t.box, shift), d.box)));
        if (Math.max(raw, moved) >= L.IOU_MATCH) { if (moved >= raw) derot.better++; else derot.worse++; }
      });
      if (!derot.on && derot.better >= 8 && derot.better >= 4 * derot.worse) { derot.on = true; note({ at, type: 'derotation_on' }); }
      if (derot.on && derot.worse * 2 > derot.better) { derot.on = false; note({ at, type: 'derotation_off' }); }
    }
    const m = live.map((_, i) => dets.map((d) => iou(pred[i], d.box)));
    // greedy, best overlap first
    const pairs: [number, number, number][] = [];
    m.forEach((row, i) => row.forEach((v, j) => { if (v >= L.IOU_MATCH) pairs.push([i, j, v]); }));
    pairs.sort((a, b) => b[2] - a[2]);
    const tUsed = new Set<number>(), dUsed = new Set<number>(), matched: [number, number][] = [];
    const jumped = new Set<number>();
    /** A box seen in one detection only, smaller than half of a remembered vehicle's box that did not jump in size:
     *  detector flicker on a part of that vehicle (as a tram turns, its rear section comes and goes), not a second
     *  vehicle. Anything else that vanishes into, or crosses, a vehicle's box makes it forget. */
    const flicker = (hits: number, box: ArBox, of: Track) => {
      const was = (of.history[of.history.length - 2] || of.history[of.history.length - 1]).box; // before this detection
      return hits < L.BLIP_HITS && !!of.memory && !jumped.has(of.id) && box[2] * box[3] < 0.5 * Math.min(was[2] * was[3], of.box[2] * of.box[3]);
    };
    for (const [i, j, v] of pairs) {
      if (tUsed.has(i) || dUsed.has(j)) continue;
      tUsed.add(i); dUsed.add(j); matched.push([i, j]);
      const t = live[i];
      // ambiguous: another box fits this track almost as well, or another track fits this box almost as well
      const rivalDet = m[i].some((w, k) => k !== j && w >= L.IOU_MATCH && w >= v * L.AMBIGUOUS_RATIO);
      const rivalTracks = live.filter((_, k) => k !== i && m[k][j] >= L.IOU_MATCH && m[k][j] >= v * L.AMBIGUOUS_RATIO);
      if (rivalDet || rivalTracks.length) {
        contest(t, at, 'ambiguous_match');
        rivalTracks.forEach((o) => contest(o, at, 'ambiguous_match'));
      }
      // while the phone turns, the box that fits unshifted and the one that fits shifted by the gyro must be the
      // same: if they differ, a neighbour may have slid into this vehicle's old place (or the gyro is wrong)
      if (shift && Math.hypot(shift.dx, shift.dy) > 0.03) {
        const other = use ? t.box : shifted(t.box, shift);
        let bestK = -1, bestV = L.IOU_MATCH;
        dets.forEach((dd, k2) => { const w = iou(other, dd.box); if (w >= bestV) { bestV = w; bestK = k2; } });
        if (bestK >= 0 && bestK !== j) contest(t, at, 'pan_ambiguous');
      }
      const d = dets[j];
      // a box that grows or shrinks faster than one vehicle's does between two detections (the bench's p99.5) may
      // have taken in, or lost, a second vehicle
      const wr = Math.max(d.box[2] / t.box[2], t.box[2] / d.box[2]), hr = Math.max(d.box[3] / t.box[3], t.box[3] / d.box[3]);
      const dt = at - t.lastSeen;
      if (wr > jumpLimit(L.JUMP_W, dt) || hr > jumpLimit(L.JUMP_H, dt)) jumped.add(t.id);
      t.box = d.box; t.score = d.score; t.cls = d.cls; t.lastSeen = at; t.hits++;
      t.history.push({ at, box: d.box });
      while (t.history.length && t.history[0].at < at - L.HISTORY_S) t.history.shift();
    }
    // a vehicle that vanished where another track's box now is may be hidden behind it, or be the one now seen
    // there (the detector merged two into one box): the track that took that box is in doubt
    live.forEach((u, i) => {
      if (tUsed.has(i)) return;
      for (const [k, j] of matched) {
        // overlap as a share of the vanished vehicle's own box: a small one swallowed by a big merged box counts
        const p = pred[i], b = dets[j].box;
        const ix = Math.max(0, Math.min(p[0] + p[2], b[0] + b[2]) - Math.max(p[0], b[0])), iy = Math.max(0, Math.min(p[1] + p[3], b[1] + b[3]) - Math.max(p[1], b[1]));
        if (iou(p, b) > 0.05 || (ix * iy) / Math.max(1e-9, p[2] * p[3]) > 0.3) {
          if (!flicker(u.hits, p, live[k])) contest(live[k], at, 'occlusion');
        }
      }
    });
    dets.forEach((d, j) => {
      if (dUsed.has(j)) return;
      const t: Track = { id: nextId++, box: d.box, score: d.score, cls: d.cls, born: at, lastSeen: at, hits: 1,
        history: [{ at, box: d.box }], readings: [], decision: null, decidedAt: -Infinity, contestedAt: -Infinity,
        memory: null, named: [], against: [], lastRead: -Infinity, twoAt: -Infinity };
      tracks.push(t);
      note({ at, type: 'track_new', track: t.id, box: d.box });
    });
    // a box that jumped in size: a remembered display waits for a fresh read, any other label goes (a vehicle that
    // entered and merged in one detection leaves no track to vanish)
    for (const t of tracks) if (jumped.has(t.id) && (t.memory || t.decision || t.readings.length)) doubt(t, at, 'box_jump');
    // crossings: two vehicles overlapping heavily, or swapping sides while they overlap
    const seen = tracks.filter((t) => t.lastSeen === at);
    for (let a = 0; a < seen.length; a++) for (let b = a + 1; b < seen.length; b++) {
      const A = seen[a], B = seen[b], o = iou(A.box, B.box);
      let crossed = o >= L.IOU_CROSSING;
      if (!crossed && o > 0 && A.history.length > 1 && B.history.length > 1) {
        const pa = A.history[A.history.length - 2].box, pb = B.history[B.history.length - 2].box;
        crossed = Math.sign(midX(pa) - midX(pb)) !== Math.sign(midX(A.box) - midX(B.box));
      }
      if (crossed && !flicker(B.hits, B.box, A) && !flicker(A.hits, A.box, B)) { contest(A, at, 'crossing'); contest(B, at, 'crossing'); }
      else if (crossed) for (const T2 of [A, B]) if (!T2.memory) contest(T2, at, 'crossing');
    }
    for (const t of tracks) if (t.lastSeen !== at) { note({ at, type: 'track_lost', track: t.id }); gone.push(t); }
    tracks = tracks.filter((t) => t.lastSeen === at);
    gone = gone.filter((t) => at - t.lastSeen <= L.HISTORY_S);
    lastDetections = at;
  }

  /** Where track t was at `when`, from its history (null when that moment is not covered closely enough). */
  function boxAt(t: Track, when: number): ArBox | null {
    const h = t.history;
    let before: { at: number; box: ArBox } | null = null, after: { at: number; box: ArBox } | null = null;
    for (const s of h) { if (s.at <= when) before = s; else { after = s; break; } }
    if (before && Math.abs(when - before.at) < 1e-6) return before.box;
    if (before && after && after.at - before.at <= L.HISTORY_GAP_S) {
      const f = (when - before.at) / (after.at - before.at);
      return before.box.map((v, k) => v + (after!.box[k] - v) * f) as ArBox;
    }
    // just past the newest detection; a track first seen after the picture was taken was not in it
    if (before && !after && when - before.at <= L.HISTORY_GAP_S / 2) return before.box;
    return null;
  }

  /** A board fresh enough for green, red and the banner's times. */
  function boardFresh(now: number) { return !!board && now - board.at <= L.BOARD_STALE_S; }
  /** What the display matcher compares with: the departures due here. A stale board still tells displays apart for
   *  the neutral text ("Display: 9 → Wabern") for a while; it never makes a label green or red (labels()). */
  function expectation(now: number): ArExpectation {
    const cands: ArCandidate[] = board && now - board.at <= L.BOARD_MATCH_S
      ? board!.entries.filter((e) => e.line && e.headsign && !e.cancelled).map((e) => ({ line: e.line, destination: e.headsign, vias: e.vias }))
      : [];
    return { line: ride.line, destination: ride.destination, vias: ride.vias, board: cands, stopsBefore: ride.stopsBefore };
  }

  /**
   * Display text OCR read on the picture captured at `capturedAt`, arriving at `now`. Each track gets the text that lay
   * on its own box at that moment; a track born after it, or whose identity was in doubt since, gets nothing.
   */
  function words(texts: ArText[], capturedAt: number, now: number) {
    const f = `ar${++frameSeq}`;
    note({ at: now, type: 'words', capturedAt, texts });
    if (now - capturedAt > L.LATE_S || capturedAt > now + 0.05) { note({ at: now, type: 'words_dropped', why: 'late' }); return; }
    // where every track was then; one whose identity came into doubt since cannot own the text, but its box still
    // keeps its text from going to a neighbour
    const placed = [...tracks.map((t) => ({ t, box: boxAt(t, capturedAt), owner: t.contestedAt < capturedAt })),
      ...gone.map((t) => ({ t, box: boxAt(t, capturedAt), owner: false }))];
    for (const { t, box, owner } of placed) {
      if (!box || !owner) continue;
      const others = placed.filter((p) => p.t !== t && p.box).map((p) => p.box!);
      const read = ARCORE.read(texts, { box, score: t.score }, others, capturedAt, `${f}:${t.id}`);
      if (!read.raw.length && !read.observed.length) continue;
      if (twoDisplays(read.observed, box, now)) { read.ambiguous = true; t.twoAt = Math.max(t.twoAt, capturedAt); note({ at: now, type: 'two_displays', track: t.id }); }
      // a read of the same moment (the other OCR engine, same picture) joins it: one frame, never two. Each was
      // placed on the box of its own moment; only what each kept is joined.
      const twin = t.readings.find((x) => Math.abs(x.at - capturedAt) <= L.SAME_FRAME_S);
      const r = twin ? joinReadings(twin, read, `${f}:${t.id}`) : read;
      // two reads of one picture may each hold one display only: the joined one is checked again
      if (twin && !r.ambiguous && twoDisplays(r.observed, box, now)) { r.ambiguous = true; t.twoAt = Math.max(t.twoAt, capturedAt); note({ at: now, type: 'two_displays', track: t.id }); }
      if (twin) t.readings = t.readings.filter((x) => x !== twin);
      t.readings.push(r);
      t.readings.sort((a, b) => a.at - b.at);
      const newest = t.readings[t.readings.length - 1].at;
      t.readings = t.readings.filter((x) => newest - x.at <= 2);
      decideTrack(t, now, t.readings.includes(r) ? r : null);
    }
  }

  /** Text groups side by side in one box that each match a listed display: the box holds two vehicles. */
  function twoDisplays(observed: ArText[], box: ArBox, now: number) {
    const words = observed.filter((x) => /\p{L}{3}/u.test(x.text)).sort((a, b) => a.box[0] - b.box[0]);
    if (words.length < 2) return false;
    const groups: ArText[][] = [[words[0]]];
    for (const w of words.slice(1)) {
      const g = groups[groups.length - 1], right = Math.max(...g.map((x) => x.box[0] + x.box[2]));
      if (w.box[0] - right > L.SPLIT_GAP * box[2]) groups.push([w]); else g.push(w);
    }
    if (groups.length < 2) return false;
    const e = expectation(now);
    const cands: ArCandidate[] = [{ line: e.line, destination: e.destination, vias: e.vias }, ...(e.board || [])];
    // nearby route numbers join their group (they stand left or right of the destination)
    const routes = observed.filter((x) => ARCORE.isRouteToken(ARCORE.lineKey(x.text)));
    const matched = groups.filter((g) => {
      const x0 = Math.min(...g.map((x) => x.box[0])) - box[2] * 0.1, x1 = Math.max(...g.map((x) => x.box[0] + x.box[2])) + box[2] * 0.1;
      const withRoute = [...g, ...routes.filter((r) => r.box[0] >= x0 && r.box[0] + r.box[2] <= x1 && !g.includes(r))];
      return ARCORE.match(withRoute, cands).outcome === 'matched';
    });
    return matched.length >= 2;
  }

  /** What a decision names: the rider's display, another listed one, a short turn, out of service; null: nothing. */
  const keyOf = (d: ArDecision): string | null => {
    if (d.state === 'match') return 'mine';
    if (d.state !== 'wrong') return null;
    if (d.reason === 'out_of_service') return 'out_of_service';
    if (d.other) return 'other:' + ARCORE.identity(d.other);
    if (d.reason === 'display_short_turn_before_alighting') return 'short_turn';
    return null;
  };
  /** What one picture says on its own: the listed display it matches clearly (the rider's or another), or out of
   *  service; null when it says nothing clear. Without a board nothing is listed, and nothing is remembered. */
  function pictureSays(r: ArReading, now: number): { key: string; decision: ArDecision; strength: number } | null {
    if (r.ambiguous) return null;
    if (r.outOfService) return { key: 'out_of_service', decision: { state: 'wrong', reason: 'out_of_service', frames: 1 }, strength: 0 };
    const e = expectation(now);
    const own: ArCandidate = { line: e.line, destination: e.destination, vias: e.vias, isExpected: true };
    const alternatives = (e.board || []).filter((c) => !ARCORE.sameDisplay(c, own));
    if (!e.board || !e.board.length || !r.observed.length) return null;
    if (!alternatives.length) {
      // only the rider's display is listed: as the matcher's own rule then (decide()), a sharp, exact read only
      const m1 = ARCORE.match(r.observed.filter((x) => x.score >= 0.7), [own]);
      if (m1.outcome !== 'matched' || !m1.best || m1.best.line !== 'exact' || m1.best.destination < 0.85) return null;
      return { key: 'mine', decision: { state: 'match', reason: 'display_matches', basis: 'consensus', confidence: m1.confidence, frames: 1 }, strength: m1.confidence * r.frameQuality };
    }
    const m = ARCORE.match(r.observed, [own, ...alternatives]);
    if (m.outcome !== 'matched' || !m.best || m.confidence * r.frameQuality < L.PICTURE_MIN) return null;
    const c = m.best.candidate, strength = m.confidence * r.frameQuality;
    if (c.isExpected) return { key: 'mine', decision: { state: 'match', reason: 'display_matches', basis: 'consensus', confidence: m.confidence, frames: 1 }, strength };
    const shortTurn = ARCORE.lineKey(c.line) === ARCORE.lineKey(e.line) && (e.stopsBefore || []).some((x) => ARCORE.sameDestination(x, c.destination));
    return { key: 'other:' + ARCORE.identity(c), decision: { state: 'wrong', reason: shortTurn ? 'display_short_turn_before_alighting' : 'display_matches_other_departure',
      other: c, observed: `${c.line} ${c.destination}`, basis: 'consensus', confidence: m.confidence, frames: 1 }, strength };
  }

  /** Does reading r speak against what the track remembers? */
  function contradicts(t: Track, r: ArReading, own: string | null, now: number) {
    const m = t.memory!;
    if (own) return own !== m.key;
    if (r.ambiguous) return true;
    if (r.outOfService) return m.key !== 'out_of_service';
    if (m.key === 'mine') return ARCORE.credibleContradiction(r, expectation(now));
    if (m.key.startsWith('other:') && m.decision.other) return ARCORE.credibleContradiction(r, { line: m.decision.other.line, destination: m.decision.other.destination, vias: m.decision.other.vias });
    return false;
  }

  /** The departures the matcher compares with, as one string (to tell when they change). */
  const boardKey = (now: number) => [...new Set((expectation(now).board || []).map(ARCORE.identity))].sort().join(';');
  /** A box that holds most of another vehicle's box now: not one vehicle. */
  const holdsAnother = (t: Track) => tracks.some((o) => o !== t && o.lastSeen === t.lastSeen && insideShare(o.box, t.box) >= 0.8
    && o.box[2] * o.box[3] >= L.HOLDS_MIN * t.box[2] * t.box[3]);

  /** fresh: the reading that just came (null when only the board changed). */
  function decideTrack(t: Track, now: number, fresh: ArReading | null = null) {
    if (!t.readings.length) { t.decision = null; if (t.memory && !fresh) recheck(t, now); return; }
    const newest = t.readings[t.readings.length - 1];
    // judged at the moment of its newest read, as the matcher is meant to be (reads arrive late on a phone)
    const d = t.decision = ARCORE.decide(t.readings, newest.at, expectation(now), newest.at);
    t.decidedAt = newest.at;
    note({ at: now, type: 'decision', track: t.id, state: d.state, reason: d.reason, frames: d.frames ?? null,
      other: d.other ? `${d.other.line} ${d.other.destination}` : null });
    if (!fresh) { if (t.memory) recheck(t, now); return; }
    // memory: what the display said, once two pictures agree; garbled reads leave it alone, a contradiction hides
    // it, a second one forgets it. Only what the new picture says on its own counts (the decision above also weighs
    // the frames before it), so a garbled read right after a good one adds nothing; a late read counts at its own
    // capture moment.
    const at = fresh.at, said = pictureSays(fresh, now), own = said ? said.key : null;
    // one entry per picture: two reads of one picture (SAME_FRAME_S apart, joined under a new frame id) are one frame
    const samePicture = (x: { at: number }) => Math.abs(x.at - at) <= L.SAME_FRAME_S;
    if (said && !t.named.some((x) => x.key === said.key && samePicture(x))) t.named.push({ key: said.key, at, frame: fresh.frameId, decision: said.decision });
    const latest = Math.max(...t.named.map((x) => x.at), at);
    t.named = t.named.filter((x) => latest - x.at <= L.LATCH_S);
    if (t.memory) {
      if (own === t.memory.key) {
        // a fresh picture that says it again: it holds longer, and a contradiction before it no longer hides it
        if (at > t.memory.lastSupport) t.memory.lastSupport = at;
        if (!t.memory.support.some(samePicture)) { t.memory.frames++; t.memory.support = [...t.memory.support, fresh].slice(-6); }
        t.against = t.against.filter((x) => x.at > at);
      } else if (contradicts(t, fresh, own, now)) {
        if (!t.against.some(samePicture)) t.against.push({ at, frame: fresh.frameId });
        if (t.against.length >= L.FORGET_FRAMES) contest(t, now, 'display_changed');
      }
      return;
    }
    // latch only on a fresh, complete board (what it was compared with is everything that is due), never near a read
    // of two displays in the box, never on a box that holds another vehicle's
    if (!boardFresh(now) || !board!.complete || Math.abs(at - t.twoAt) <= L.LATCH_S || newest.at - t.twoAt <= L.LATCH_S || holdsAnother(t)) return;
    if (t.readings.some((x) => x.ambiguous)) return;
    // LATCH_FRAMES pictures within LATCH_S name the same display and none names another; or the decision itself
    // already rests on that many frames
    const k = keyOf(d), support = (key: string) => t.readings.filter((x) => pictureSays(x, now)?.key === key);
    if (k && (d.frames || 0) >= L.LATCH_FRAMES && !t.named.some((x) => x.key !== k)) {
      t.memory = { key: k, decision: d, since: at, lastSupport: at, frames: d.frames || 0, support: support(k), board: boardKey(now) };
    } else if (said) {
      const same = t.named.filter((x) => x.key === said.key);
      // a red needs two pictures always (RED_FRAMES); a green may rest on one very clear picture
      const enough = same.length >= L.LATCH_FRAMES || (said.key === 'mine' && said.strength >= L.LATCH_SINGLE_MIN);
      if (enough && !t.named.some((x) => x.key !== said.key)) {
        t.memory = { key: said.key, decision: said.decision, since: same[0].at, lastSupport: at, frames: same.length, support: support(said.key), board: boardKey(now) };
      }
    }
    if (t.memory) { t.against = []; note({ at: now, type: 'remember', track: t.id, key: t.memory.key }); }
  }

  /** The board's departures changed: a remembered display must still be what its own pictures say against them (a
   *  departure that was missing may match a short read better), else it is forgotten. */
  function recheck(t: Track, now: number) {
    const m = t.memory!, key = boardKey(now);
    if (key === m.board) return;
    const says = m.support.map((x) => pictureSays(x, now));
    const agree = says.filter((x) => x && x.key === m.key);
    const enough = agree.length >= L.LATCH_FRAMES || (m.key === 'mine' && agree.some((x) => x!.strength >= L.LATCH_SINGLE_MIN));
    if (!enough || says.some((x) => x && x.key !== m.key)) contest(t, now, 'board_changed');
    else m.board = key;
  }

  /** A new board (Kante /api/due). */
  function setBoard(b: ArBoard) {
    board = b;
    lastBoardEvent = { at: b.at, type: 'board', board: b }; // whole, so a saved capture replays (tools/test_artrack.mts)
    note(lastBoardEvent);
    for (const t of tracks) if (t.readings.length || t.memory) decideTrack(t, b.at); // the alternatives changed
  }

  const display = (line: string, dest: string) => `${line} → ${dest}`;

  /** Runs due here whose display is the rider's; and whether all of them take the rider where they are going. */
  function plausibleRuns(now: number) {
    const own = { line: ride.line, destination: ride.destination };
    // every run on the board with that display, also one timed as departed: a late vehicle may still be standing here
    const runs = board!.entries.filter((e) => !e.cancelled && e.line && e.headsign
      && ARCORE.sameDisplay({ line: e.line, destination: e.headsign }, own));
    const isRider = (e: ArBoardEntry) => !!ride.tripId && e.tripId === ride.tripId && (!ride.serviceDate || e.serviceDate === ride.serviceDate);
    // the planned trip needs no servesTo from an engine that does not send it; one that says "no" always counts
    const serves = (e: ArBoardEntry) => e.servesTo === true || (isRider(e) && e.servesTo == null);
    const why = !runs.length ? 'no_such_run_due'
      : runs.some((e) => e.dep === null || e.pickup === false) ? 'a_run_cannot_be_boarded_here'
      : runs.some((e) => e.servesTo === false) ? 'a_run_skips_your_stop'
      : runs.some((e) => !serves(e)) ? 'stop_served_unknown'
      : '';
    return { runs, why };
  }

  /** The label of every vehicle on screen now. Two vehicles that would both be green are both shown neutral: the
   *  camera cannot tell the rider which one to take (multiple_matching_vehicles). */
  function labels(now: number): ArLabel[] {
    const out = labelsEach(now);
    if (out.filter((l) => l.kind === 'green').length > 1) {
      for (const l of out) if (l.kind === 'green') Object.assign(l, { kind: 'neutral', text: `Display: ${display(ride.line, ride.destination)}`, reason: 'multiple_matching_vehicles' });
    }
    return out;
  }
  function labelsEach(now: number): ArLabel[] {
    const out: ArLabel[] = [];
    const fresh = boardFresh(now);
    const shown = tracks.filter((t) => now - t.lastSeen <= L.SHOWN_S);
    for (const t of shown) {
      const base = { track: t.id, box: t.box, cls: t.cls };
      // a box that holds most of another vehicle's box is not one vehicle (the detector drew one box over two, and
      // one of them on its own as well): no colour on it, whatever it remembers
      if (holdsAnother(t)) { out.push({ ...base, kind: 'none', text: '', reason: 'box_holds_another' }); continue; }
      const m = t.memory && now - t.memory.lastSupport <= L.MEMORY_S ? t.memory : null;
      if (m && t.against.length) { out.push({ ...base, kind: 'none', text: '', reason: 'display_contradicted' }); continue; }
      const d = m ? { ...m.decision, frames: Math.max(m.decision.frames || 0, m.frames) } : t.decision;
      if (!m && (!d || now - t.decidedAt > L.HOLD_S || t.contestedAt > t.decidedAt)) { out.push({ ...base, kind: 'none', text: '', reason: d ? 'expired' : 'no_read' }); continue; }
      if (!d) continue;
      if (d.state === 'match') {
        const text = display(ride.line, ride.destination);
        let why = !board ? 'no_board' : !fresh ? 'board_stale' : !board.complete ? 'board_incomplete' : plausibleRuns(now).why;
        if (why) out.push({ ...base, kind: 'neutral', text: `Display: ${text}`, reason: why });
        else out.push({ ...base, kind: 'green', text: `Your ${ride.mode || 'ride'} ${text}`, reason: d.reason });
        continue;
      }
      if (d.state === 'wrong') {
        const other = d.other ? display(d.other.line, d.other.destination) : '';
        const text = d.reason === 'out_of_service' ? 'Not in service' : other ? `Not yours: ${other}` : 'Not yours';
        // Red only for text that names something: another departure on the board, a stop of the rider's own route
        // (a short turn), or out of service. A contradiction that names nothing listed ("7 Detrina" for "7 Ostring")
        // is what correlated misreads of the right display look like (the reading-range bench, docs/ar-reading-range.md).
        // a remembered "other departure" counts only while the board still lists it (a refresh may drop it)
        const listed = !d.other || d.reason === 'display_short_turn_before_alighting' || (!!board && board.entries.some((e) => !e.cancelled && e.line && e.headsign
          && ARCORE.sameDisplay({ line: e.line, destination: e.headsign }, d.other!)));
        const named = (!!d.other && listed) || d.reason === 'out_of_service' || d.reason === 'display_short_turn_before_alighting';
        const why = !fresh ? (board ? 'board_stale' : 'no_board') : (d.frames || 0) < L.RED_FRAMES ? 'one_frame_only' : !named ? 'names_nothing_listed' : '';
        if (why) out.push({ ...base, kind: other || d.reason === 'out_of_service' ? 'neutral' : 'none', text: other ? `Display: ${other}` : d.reason === 'out_of_service' ? 'Display: not in service' : '', reason: why });
        else out.push({ ...base, kind: 'red', text, reason: d.reason });
        continue;
      }
      out.push({ ...base, kind: 'none', text: '', reason: d.reason });
    }
    return out;
  }

  /** The rider's run on the board, bound by trip and day (never guessed by line). */
  function riderRun(now: number): ArBoardEntry | null {
    if (!boardFresh(now) || !ride.tripId) return null;
    return board!.entries.find((e) => e.tripId === ride.tripId && (!ride.serviceDate || e.serviceDate === ride.serviceDate)) || null;
  }

  /** The line across the bottom: the rider's run, when it comes and from where. Timing lives here, never on a vehicle. */
  function banner(now: number): { text: string; state: 'live' | 'not_on_board' | 'no_live' | 'cancelled' | 'departed' } {
    const head = display(ride.line, ride.destination);
    const planned = ride.dep ? ` · planned ${clock(ride.dep)}` : '';
    if (!boardFresh(now)) return { text: `${head}${planned} · live times unavailable`, state: 'no_live' };
    const e = riderRun(now);
    if (!e) return { text: `${head}${planned} · not on the live board`, state: 'not_on_board' };
    if (e.cancelled) return { text: `${head} · cancelled`, state: 'cancelled' };
    const eta = e.etaS == null ? null : e.etaS - (now - board!.at);
    const quay = ride.quayId && e.quayId && e.quayId !== ride.quayId && e.quayLabel ? ` · leaves from ${e.quayLabel} today` : '';
    if (e.state === 'departed' || (eta != null && eta < -90)) return { text: `${head} · has left${quay}`, state: 'departed' };
    const when = e.state === 'at-stop' || (eta != null && eta <= 30) ? 'at the stop now' : eta != null ? `in ${Math.round(eta / 60)} min` : '';
    return { text: `${head}${when ? ' · ' + when : ''}${quay}`, state: 'live' };
  }

  // which display the reader looks at next: one vehicle's band at a time, in turn (never by how likely a vehicle is
  // to be the rider's, so a late real bus is not starved); every third turn, or with no vehicle in view, a band
  // across the road for one the detector missed
  let readTurn = 0;
  /** The next region for the display reader: a vehicle's box (the reader cuts its display band) or 'road'. Vehicles
   *  whose display is not known yet go first, the one read longest ago first; a known one is read again after
   *  RECHECK_S; every fourth turn the road band. */
  function readTarget(now: number): ArBox | 'road' {
    const shown = tracks.filter((t) => now - t.lastSeen <= 0.5);
    const turn = readTurn++;
    if (!shown.length || turn % 4 === 3) return 'road';
    const known = (t: Track) => !!t.memory && !t.against.length;
    const due = shown.filter((t) => !known(t) || now - t.lastRead >= L.RECHECK_S)
      .sort((a, b) => Number(known(a)) - Number(known(b)) || a.lastRead - b.lastRead);
    if (!due.length) return 'road';
    due[0].lastRead = now;
    return due[0].box;
  }

  return {
    detections, words, board: setBoard, labels, banner, riderRun, readTarget,
    /** The board failed to load: nothing changes now, and the old one goes stale on its own (BOARD_STALE_S). */
    boardFailed(at: number) { note({ at, type: 'board_failed' }); },
    /** The last LOG_S seconds, for the debug capture; led by the board in use when it came before them. */
    log: () => (lastBoardEvent && !log.includes(lastBoardEvent) ? [lastBoardEvent, ...log] : log.slice()),
    tracks: () => tracks.map((t) => ({ id: t.id, box: t.box, cls: t.cls, seen: t.lastSeen, readings: t.readings.length, decision: t.decision, contestedAt: t.contestedAt })),
    derotation: () => ({ ...derot }),
    lastDetections: () => lastDetections,
  };
}
export type ArSession = ReturnType<typeof createArSession>;

const clock = (unix: number) => {
  const d = new Date(unix * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** /api/due's answer as a board (entries without a line or headsign are left out: nothing to compare a display with). */
export function boardOf(d: KanteDueResponse, at: number): ArBoard {
  return {
    at,
    complete: d.complete === true,
    entries: (d.due || []).filter((x) => x.line && x.headsign).map((x) => ({
      tripId: x.tripId, serviceDate: x.serviceDate, line: x.line!.name, headsign: x.headsign!, vias: x.vias || undefined,
      quayId: x.quayId, quayLabel: x.quayLabel, state: x.state, etaS: x.etaS, dep: x.dep, cancelled: x.cancelled, servesTo: x.servesTo,
      pickup: x.pickup,
    })),
  };
}
