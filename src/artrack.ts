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
  /** The text behind each reading (by frame id), so a second read of the same moment joins the first. */
  sources: Map<string, ArText[]>;
}

const iou = ARCORE.iou;
// Frame ids are unique across sessions: arcore.ts memoises a frame's match by its id (and the board), so an id used
// again by a later session with the same board would be answered with an old picture's text.
let frameSeq = 0;
const shifted = (b: ArBox, s: ArShift | null): ArBox => (s ? [b[0] + s.dx, b[1] + s.dy, b[2], b[3]] : b);
const midX = (b: ArBox) => b[0] + b[2] / 2;

export function createArSession(ride: ArRide) {
  const L = AR_LIMITS;
  let tracks: Track[] = [];
  /** Tracks gone in the last few seconds: their boxes still keep late text from a neighbour; they own nothing. */
  let gone: Track[] = [];
  let nextId = 1;
  let board: ArBoard | null = null;
  let lastDetections = -Infinity;
  const log: ArEvent[] = [];
  let lastBoardEvent: ArEvent | null = null;
  // the gyro shift is applied only while it helps: on a phone whose axes or signs differ, raw boxes match better
  const derot = { on: true, better: 0, worse: 0 };

  const note = (e: ArEvent) => {
    log.push(e);
    while (log.length && log[0].at < e.at - L.LOG_S) log.shift();
  };
  const contest = (t: Track, at: number, why: string) => {
    if (t.decision || t.readings.length) note({ at, type: 'revoke', track: t.id, why });
    t.contestedAt = at; t.readings = []; t.decision = null; t.sources.clear();
  };

  /** A new set of detections (one picture). shift: how far the phone's turn moved the picture since the last one. */
  function detections(dets: ArDet[], at: number, shift: ArShift | null = null) {
    note({ at, type: 'detections', dets: dets.map((d) => ({ box: d.box, score: d.score, cls: d.cls })), shift });
    const live = tracks.filter((t) => at - t.lastSeen <= L.LOST_S);
    const use = derot.on ? shift : null;
    if (shift && Math.hypot(shift.dx, shift.dy) > L.PAN_MAX) for (const t of live) contest(t, at, 'fast_pan');
    const pred = live.map((t) => shifted(t.box, use));
    // learn whether the gyro shift helps (only when it is big enough to tell)
    if (shift && Math.hypot(shift.dx, shift.dy) > 0.03) {
      live.forEach((t) => {
        const raw = Math.max(0, ...dets.map((d) => iou(t.box, d.box))), moved = Math.max(0, ...dets.map((d) => iou(shifted(t.box, shift), d.box)));
        if (Math.max(raw, moved) >= L.IOU_MATCH) { if (moved >= raw) derot.better++; else derot.worse++; }
      });
      if (derot.on && derot.better + derot.worse >= 12 && derot.worse > 2 * derot.better) { derot.on = false; note({ at, type: 'derotation_off' }); }
    }
    const m = live.map((_, i) => dets.map((d) => iou(pred[i], d.box)));
    // greedy, best overlap first
    const pairs: [number, number, number][] = [];
    m.forEach((row, i) => row.forEach((v, j) => { if (v >= L.IOU_MATCH) pairs.push([i, j, v]); }));
    pairs.sort((a, b) => b[2] - a[2]);
    const tUsed = new Set<number>(), dUsed = new Set<number>();
    for (const [i, j, v] of pairs) {
      if (tUsed.has(i) || dUsed.has(j)) continue;
      tUsed.add(i); dUsed.add(j);
      const t = live[i];
      // ambiguous: another box fits this track almost as well, or another track fits this box almost as well
      const rivalDet = m[i].some((w, k) => k !== j && w >= L.IOU_MATCH && w >= v * L.AMBIGUOUS_RATIO);
      const rivalTracks = live.filter((_, k) => k !== i && m[k][j] >= L.IOU_MATCH && m[k][j] >= v * L.AMBIGUOUS_RATIO);
      if (rivalDet || rivalTracks.length) {
        contest(t, at, 'ambiguous_match');
        rivalTracks.forEach((o) => contest(o, at, 'ambiguous_match'));
      }
      const d = dets[j];
      t.box = d.box; t.score = d.score; t.cls = d.cls; t.lastSeen = at; t.hits++;
      t.history.push({ at, box: d.box });
      while (t.history.length && t.history[0].at < at - L.HISTORY_S) t.history.shift();
    }
    dets.forEach((d, j) => {
      if (dUsed.has(j)) return;
      const t: Track = { id: nextId++, box: d.box, score: d.score, cls: d.cls, born: at, lastSeen: at, hits: 1,
        history: [{ at, box: d.box }], readings: [], decision: null, decidedAt: -Infinity, contestedAt: -Infinity, sources: new Map() };
      tracks.push(t);
      note({ at, type: 'track_new', track: t.id, box: d.box });
    });
    // crossings: two vehicles overlapping heavily, or swapping sides while they overlap
    const seen = tracks.filter((t) => t.lastSeen === at);
    for (let a = 0; a < seen.length; a++) for (let b = a + 1; b < seen.length; b++) {
      const A = seen[a], B = seen[b], o = iou(A.box, B.box);
      let crossed = o >= L.IOU_CROSSING;
      if (!crossed && o > 0 && A.history.length > 1 && B.history.length > 1) {
        const pa = A.history[A.history.length - 2].box, pb = B.history[B.history.length - 2].box;
        crossed = Math.sign(midX(pa) - midX(pb)) !== Math.sign(midX(A.box) - midX(B.box));
      }
      if (crossed) { contest(A, at, 'crossing'); contest(B, at, 'crossing'); }
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
      // a read of the same moment (the other OCR engine, same picture) joins it: one frame, never two
      const twin = t.readings.find((x) => Math.abs(x.at - capturedAt) <= L.SAME_FRAME_S);
      const all = twin ? [...(t.sources.get(twin.frameId) || []), ...texts] : texts;
      const at = twin ? twin.at : capturedAt;
      const r = ARCORE.read(all, { box, score: t.score }, others, at, `${f}:${t.id}`);
      if (!r.raw.length && !r.observed.length) continue;
      if (twin) { t.readings = t.readings.filter((x) => x !== twin); t.sources.delete(twin.frameId); }
      t.sources.set(r.frameId, all);
      t.readings.push(r);
      t.readings.sort((a, b) => a.at - b.at);
      const newest = t.readings[t.readings.length - 1].at;
      t.readings = t.readings.filter((x) => newest - x.at <= 2);
      for (const k of [...t.sources.keys()]) if (!t.readings.some((x) => x.frameId === k)) t.sources.delete(k);
      decideTrack(t, now);
    }
  }

  function decideTrack(t: Track, now: number) {
    if (!t.readings.length) { t.decision = null; return; }
    const at = t.readings[t.readings.length - 1].at;
    // judged at the moment of its newest read, as the matcher is meant to be (reads arrive late on a phone)
    t.decision = ARCORE.decide(t.readings, at, expectation(now), at);
    t.decidedAt = at;
    note({ at: now, type: 'decision', track: t.id, state: t.decision.state, reason: t.decision.reason, frames: t.decision.frames ?? null,
      other: t.decision.other ? `${t.decision.other.line} ${t.decision.other.destination}` : null });
  }

  /** A new board (Kante /api/due). */
  function setBoard(b: ArBoard) {
    board = b;
    lastBoardEvent = { at: b.at, type: 'board', board: b }; // whole, so a saved capture replays (tools/test_artrack.mts)
    note(lastBoardEvent);
    for (const t of tracks) if (t.readings.length) decideTrack(t, b.at); // the alternatives changed
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
    for (const t of tracks) {
      if (now - t.lastSeen > L.SHOWN_S) continue;
      const base = { track: t.id, box: t.box, cls: t.cls };
      const d = t.decision;
      if (!d || now - t.decidedAt > L.HOLD_S || t.contestedAt > t.decidedAt) { out.push({ ...base, kind: 'none', text: '', reason: d ? 'expired' : 'no_read' }); continue; }
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
        const why = !fresh ? (board ? 'board_stale' : 'no_board') : (d.frames || 0) < L.RED_FRAMES ? 'one_frame_only' : '';
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

  return {
    detections, words, board: setBoard, labels, banner, riderRun,
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
