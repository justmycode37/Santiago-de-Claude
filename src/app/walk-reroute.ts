// ---------- A walk rerouted from where you are ----------
// Following a journey by GPS on a walk (to the first stop, a change, to the destination): when you leave the walk's
// way for another way that leads to the same place, the engine is asked for the walk again from where you are, and the
// walk is drawn and timed along that, as a navigation app reroutes; the part already walked stays drawn as walked.
// GPS noise does not do it: only fixes clearly off the way, several in a row and some seconds apart (noteFix()). The
// engine decides whether you are on a way at all: a walk from you that starts with a guess (a straight line of over
// 20 m onto its network) or that it finds no way for is not taken, and you are off the route as before; no answer
// (the engine down) leaves the walk as it was. The rides after it are not planned again: the walk's end, the time to
// spare at a change and the arrival follow the new walk's time (rerouteTimes()), and the live line says when it is
// too late for the next ride.
import { KANTE } from '../engine.ts';
import { KanteJourney } from '../engine-journey.ts';
import { applyLiveTimes, footPieces, liveMs, spareOf, splitLine } from './journey-steps.ts';
import { fixAge, fixTime, userAccuracy, userLngLat } from './location.ts';
import { distKm, lengthKm, newWalkRev, walkGoal } from './routing.ts';
import { queueSheet } from './sheet-content.ts';
import { scheduleProgress } from './live-line.ts';
import { nearestOnLine, tripLayout } from './tracking.ts';
import { journey, sheet, tracking } from './state.ts';
import { SETTINGS } from '../settings.ts';
import type { JourneyChangeStep, JourneyStep, JourneyWalkStep, WalkedPiece } from './journey-steps.ts';
import type { RoutedWalk, WalkEnd } from './routing.ts';
import type { KanteFloorChange } from '../engine.ts';
import type { TrackState, TripSnap } from './tracking.ts';

type FootStep = JourneyWalkStep | JourneyChangeStep;

/** GPS worse than this (m, its accuracy) cannot tell a street beside the way from the way: nothing is rerouted. */
export const MAX_ACC = 30;
/** Further off the walk's way than this (m) counts as off it; within clearTol() you are back on it; between the two,
 *  neither (a fix wavering about one line does not start and stop it). Below the off-route tolerance (45 m and up). */
export const enterTol = (acc: number) => Math.max(20, acc) + 12;
export const clearTol = (acc: number) => Math.max(15, acc);
/** Fixes off the way in a row that are believed: two at least 2 s apart beyond the off-route tolerance, else three
 *  over at least 3 s that have moved 10 m (not GPS wandering under arcades while you stand); a gap of more than 10 s
 *  between two of them starts the count again. Only fixes taken later than the one before count. */
export const CONFIRM = { farN: 2, farMs: 2000, n: 3, ms: 3000, movedM: 10, gapMs: 10000 };
/** "Off the route" is held back while a reroute is being made sure of (at most this long from the first fix off the
 *  way, by the clock), or while one is being asked for (the engine's client gives up after 8 s; at most this long all
 *  the same); never taken back once it is said (a retry later does not hide it again; a reroute taken ends it). */
export const HOLD_MS = 15000, FLIGHT_MS = 10000;
/** How long before the walk is asked for again (ms): after a reroute was taken; after the engine found you on no way
 *  (sooner once you have gone 30 m on from there, 5 s on: out of a park onto a street); after it did not answer. */
export const WAIT = { taken: 10000, refused: 20000, down: 30000, movedMs: 5000, movedM: 30 };
/** Not within this (m) of the walk's end, along it or as the crow flies: there is nothing left to reroute. */
const END_M = 30;

/** A run of fixes off the walk's way (noteFix()), for these lines of the step; farN: the last of them in a row beyond
 *  the off-route tolerance, the first of those at farAt. fromKm: where you left it, km into the step's line (stepLine()). */
interface Candidate { st: FootStep; lines: LngLat[][]; n: number; firstAt: number; firstLL: LngLat; lastAt: number; farN: number; farAt: number; fromKm: number }
/** A request on its way: for this step, its route revision and lines (a newer one drops the answer). */
interface Flight { st: FootStep; rev: number | undefined; lines: LngLat[][]; at: number; from: LngLat; fromKm: number }
const R = {
  /** The journey's steps all this is for: another journey starts afresh. */
  steps: null as JourneyStep[] | null,
  /** The last fix on the way (within clearTol()): where, km into the step's line, measured on which lines. */
  lastOn: null as { st: FootStep; km: number; at: number; v: number } | null,
  cand: null as Candidate | null,
  /** When (ms, by the clock) the first fix off the way of this time off it came; 0: on it. */
  offSince: 0,
  flight: null as Flight | null,
  /** No request before this (ms), and why: a reroute taken, the engine finding you on no way, or no answer. */
  waitUntil: 0,
  waitFor: '' as '' | 'taken' | 'refused' | 'down',
  /** Where the engine last found you on no way, and when. */
  refusedAt: null as { ll: LngLat; at: number } | null,
  /** The minute the rerouted walk's end was last shown at, and for a change how much time it leaves (the sheet is
   *  drawn again when that changes). */
  etaKey: '',
};

const isFoot = (st: JourneyStep | undefined): st is FootStep => !!st && (st.type === 'walk' || st.type === 'change');
const walkedKm = (st: FootStep) => (st.walked || []).reduce((sum, pc) => sum + lengthKm(pc.coords), 0);

/**
 * A fix followed on the trip (trackOnce() in tracking.ts, with every update; fresh: a fix not counted before), snapped
 * at s; tol: the off-route tolerance there. Watches for you leaving a walk's way and asks for the walk from where you
 * are once that is sure. Answers whether "Off the route" is to be held back for now (that is being made sure of, or
 * asked for).
 */
export function noteFix(s: TripSnap, fresh: boolean, fixAt: number, tol: number): boolean {
  if (R.steps !== journey.steps) Object.assign(R, { steps: journey.steps, lastOn: null, cand: null, offSince: 0, flight: null, waitUntil: 0, waitFor: '', refusedAt: null });
  const st = journey.steps[s.i], p = userLngLat;
  if (!p || !isFoot(st)) { R.cand = null; R.offSince = 0; return holding(null, p); }
  if (st.reroute && fresh) followEta(st, s, fixAt); // (on a guessed end too: you are where you are along it)
  if (!eligible(st, s, p)) { R.cand = null; R.offSince = 0; return holding(st, p); }
  const acc = userAccuracy, done = walkedKm(st), near = nearestOnLine(st.lines.flat(), p);
  if (near.d <= clearTol(acc)) {
    // back on the way: an answer still on its way for where you were off it is not wanted any more
    R.lastOn = { st, km: done + near.km, at: fixAt, v: tracking.geoVersion };
    Object.assign(R, { cand: null, offSince: 0, flight: null });
    return holding(st, p);
  }
  if (near.d <= enterTol(acc) || !fresh) return holding(st, p);
  if (!R.offSince) R.offSince = Date.now();
  let c = R.cand;
  if (!c || c.st !== st || c.lines !== st.lines || fixAt - c.lastAt > CONFIRM.gapMs) {
    // where you left the way: the last fix on it (a minute ago at most, not ahead of here), else across from here
    const on = R.lastOn;
    const fromKm = on && on.st === st && on.v === tracking.geoVersion && fixAt - on.at < 60000 && on.km <= done + near.km ? on.km : done + near.km;
    c = R.cand = { st, lines: st.lines, n: 0, firstAt: fixAt, firstLL: p, lastAt: fixAt, farN: 0, farAt: fixAt, fromKm };
  }
  c.n++;
  c.lastAt = fixAt;
  if (near.d > tol) { if (!c.farN) c.farAt = fixAt; c.farN++; } else c.farN = 0;
  const sure = (c.farN >= CONFIRM.farN && fixAt - c.farAt >= CONFIRM.farMs)
    || (c.n >= CONFIRM.n && fixAt - c.firstAt >= CONFIRM.ms && distKm(c.firstLL, p) * 1000 >= CONFIRM.movedM);
  if (sure && mayAsk(p)) ask(st, c, p);
  return holding(st, p);
}

// Whether "Off the route" waits, on this step: while a request for it is on its way, or while fixes off its way are
// being made sure of and a request could follow (not while the engine has just found you on no way, or not
// answered). Once said, it is not taken back for a retry.
function holding(st: FootStep | null, p: LngLat | null) {
  if (!st || (tracking.track && tracking.track.off)) return false;
  if (R.flight) return R.flight.st === st && Date.now() - R.flight.at < FLIGHT_MS;
  if (!R.cand || R.cand.st !== st || !R.offSince || Date.now() - R.offSince >= HOLD_MS) return false;
  return R.waitFor === 'taken' || Date.now() >= R.waitUntil || (!!p && movedOn(p));
}
const movedOn = (p: LngLat) => R.waitFor === 'refused' && !!R.refusedAt && Date.now() - R.refusedAt.at >= WAIT.movedMs && distKm(R.refusedAt.ll, p) * 1000 >= WAIT.movedM;
const mayAsk = (p: LngLat) => !R.flight && (Date.now() >= R.waitUntil || movedOn(p));

// A walk that may be rerouted, with you where you are on it: the engine routed it (not a straight line, not a station
// model's way, not one whose route is still on its way), GPS is sure enough and recent, you are not on a guessed
// stretch, have not arrived or missed the next ride, and are not about at its end
function eligible(st: FootStep, s: TripSnap, p: LngLat) {
  const t = tracking.track;
  if (s.guess || (t && (t.arrived || t.missed)) || tracking.arrivedAt === journey.steps) return false;
  if (!(userAccuracy > 0 && userAccuracy <= MAX_ACC) || fixAge() > 20000) return false;
  if (!st.lines.length || st._modelDrawn) return false;
  if (st._askFor === st.lines && st._netFor !== st.lines) return false;
  if (!(st.walks || []).some((w) => w && w.net && !w.approx)) return false;
  const last = st.lines[st.lines.length - 1], end = last[last.length - 1];
  return (tripLayout().lens[s.i] - s.kmIn) * 1000 > END_M && distKm(p, end) * 1000 > END_M;
}

// The walk from p to where the step leads (the boarding point by its id, the destination's place), at the walker's
// settings, avoiding ways closed now, and for a walk to a ride within the time there is until it leaves
function ask(st: FootStep, c: Candidate, p: LngLat) {
  const now = Date.now(), lines = st.lines, last = lines[lines.length - 1];
  const goal = walkGoal(st, last[last.length - 1]), to = lastEnd(st), { limitS } = rerouteAsk(st, now);
  const f: Flight = { st, rev: st.walkRev, lines, at: now, from: p, fromKm: c.fromKm };
  R.flight = f;
  R.cand = null;
  const body: KanteWalkRequest = { from: { lat: p[1], lon: p[0] }, to: { lat: goal[1], lon: goal[0], ...(to.quay ? { quay: to.quay } : {}), ...(to.exact ? { exact: true } : {}) },
    options: KanteJourney.options(), time: Math.floor(now / 1000), ...(limitS != null ? { limitS } : {}) };
  KANTE.walk(body).then((w) => answered(f, w), (e) => failed(f, e));
}
/** What a walk from where you are is asked within: the time it sets out (s), and for a walk to a ride the seconds
 *  until that leaves (less the extra change time at a change). */
export function rerouteAsk(st: FootStep, now = Date.now()): { time: number; limitS: number | null } {
  const ride = st.type === 'change' || !st.final ? st.nextRide : null, dep = ride ? liveMs(ride.s.from, 'dep') : null;
  const extra = st.type === 'change' ? ((SETTINGS.prefs ? SETTINGS.prefs().extraChangeMin : 0) || 0) * 60 : 0;
  return { time: Math.floor(now / 1000), limitS: dep != null ? Math.max(0, Math.round((dep - now) / 1000 - extra)) : null };
}
const lastEnd = (st: FootStep): WalkEnd => { const e = st.ends || []; return (e[e.length - 1] || [])[1] || {}; };

// The answer, taken only for the walk as it was asked for, with you still on it: the same journey, step and route
// revision (no live platform change since), GPS recent, not boarded or arrived meanwhile, and the latest fix on the
// new way. Not on a way at all (its start a guess, no way found): not taken, and you are off the route.
function answered(f: Flight, w: KanteWalk) {
  if (R.flight !== f) return;
  R.flight = null;
  const r = KanteJourney.routed(w);
  // (GPS no longer sure enough to tell where you are: not taken)
  if (!current(f) || !(userAccuracy > 0 && userAccuracy <= MAX_ACC)) { scheduleProgress(); return; }
  if (!r || r.approx || r.noPath || (r.approxTo != null && r.approxTo > 0)) { refused(f.from); return; }
  if (nearestOnLine(r.coords, userLngLat!).d > enterTol(userAccuracy)) { scheduleProgress(); return; } // back on the old way meanwhile
  apply(f, r);
}
function failed(f: Flight, e: unknown) {
  if (R.flight !== f) return;
  R.flight = null;
  if (KANTE.failure(e) === 'refused') { refused(f.from); return; }
  Object.assign(R, { waitUntil: Date.now() + WAIT.down, waitFor: 'down' });
  scheduleProgress(); // "Off the route", if you are, at once
}
function refused(ll: LngLat) {
  const now = Date.now();
  Object.assign(R, { waitUntil: now + WAIT.refused, waitFor: 'refused', refusedAt: { ll, at: now } });
  scheduleProgress();
}
function current(f: Flight) {
  const t = tracking.track, i = journey.steps.indexOf(f.st);
  return i >= 0 && R.steps === journey.steps && f.st.walkRev === f.rev && f.st.lines === f.lines && !!t && t.i === i
    && !t.arrived && !t.missed && tracking.arrivedAt !== journey.steps && fixAge() < 20000 && !!userLngLat;
}

// The new way in: the part walked kept as it was drawn (up to where you left the way, then straight to where the new
// way begins), the new way as the step's line, routed for its ends (so the live updates do not ask for it again unless
// its ends or time change), and you on it where the latest fix is
function apply(f: Flight, r: RoutedWalk & { floors: KanteFloorChange[] }) {
  const st = f.st, i = journey.steps.indexOf(st), to = lastEnd(st);
  const walked = cutPieces(st, f.fromKm);
  const lastPc = walked[walked.length - 1], left = lastPc ? lastPc.coords[lastPc.coords.length - 1] : st.lines[0][0], junction = r.coords[0];
  if (distKm(left, junction) > 0.001) walked.push({ coords: [left, junction], guess: true });
  Object.assign(st, { walked, lines: [r.coords], walks: [r], floors: r.floors.length ? r.floors : null, kanteWalk: true, _modelDrawn: false, ends: [[{}, to]] });
  newWalkRev(st).done();
  tracking.geoVersion++;
  const near = nearestOnLine(r.coords, userLngLat!), lay = tripLayout(), kmIn = walkedKm(st) + near.km;
  const t: TrackState = { ...tracking.track!, i, kmIn, km: lay.km0[i] + kmIn, d: near.d, v: tracking.geoVersion, offCount: 0, off: false };
  delete t.guess;
  delete t.walkedKmIn;
  tracking.track = t;
  R.lastOn = { st, km: kmIn, at: fixTime(), v: tracking.geoVersion };
  Object.assign(R, { waitUntil: Date.now() + WAIT.taken, waitFor: 'taken', refusedAt: null, offSince: 0 });
  rerouteTimes(st, near.km);
  if (sheet.focus && sheet.focus.step === i) sheet.focus = null; // (a direction of the old way picked in the sheet)
  journey.routeKey = '';
  queueSheet(true);
  scheduleProgress();
}
// What was drawn of a walk up to km into its line (stepLine()): the part walked before, then its pieces as drawn
function cutPieces(st: FootStep, km: number): WalkedPiece[] {
  const out = (st.walked || []).slice();
  let left = km - walkedKm(st);
  for (const pc of footPieces(st)) {
    if (left <= 0) break;
    const len = lengthKm(pc.coords);
    if (len <= left) { out.push(pc); left -= len; continue; }
    out.push({ coords: splitLine(pc.coords, left / len)[0], guess: pc.guess });
    break;
  }
  return out;
}

/**
 * The times of a rerouted walk: its seconds (the part walked at the walking pace, the engine's for the way on), its
 * minutes, and when you get to its end (eta), from the latest fix at the engine's pace for the way left; the step's
 * end, the arrival and the time to spare at a change follow (applyLiveTimes(), spareOf()); when it starts stays.
 * kmOn: how far along its lines you are (else where GPS puts you on them, if on this step). A part of it without the
 * engine's time is timed as the engine times a straight line, and marked as an estimate. A walk GPS has you past
 * already keeps when you got to its end.
 */
export function rerouteTimes(st: FootStep, kmOn?: number) {
  const pace = KanteJourney.options().walkSpeed, walks = st.walks || [];
  let remS = 0, remM = 0, remKm = 0;
  st.lines.forEach((l, k) => {
    const w = walks[k], km = lengthKm(l);
    remKm += km;
    remM += w && w.dist != null ? w.dist : km * 1000;
    remS += w && w.walkS != null ? w.walkS : (km * 1000 * 1.35) / pace;
  });
  const t = tracking.track, i = journey.steps.indexOf(st), onIt = !!t && t.i === i && !!userLngLat;
  const on = kmOn != null ? kmOn : onIt ? nearestOnLine(st.lines.flat(), userLngLat!).km : 0;
  const sPerM = remS / Math.max(1, remKm * 1000), at = fixAge() < 20000 ? fixTime() : Date.now();
  const past = !!t && i >= 0 && t.i > i && !!st.reroute;
  st.reroute = { sPerM, eta: past ? st.reroute!.eta : at + Math.max(0, remKm - on) * 1e6 * sPerM };
  const doneM = walkedKm(st) * 1000;
  st.walkS = Math.round(doneM / pace + remS);
  st.walkEst = !walks.every((w) => w && w.walkS != null);
  const min = Math.round(KanteJourney.walkSecs({ distanceM: doneM + remM, durationS: st.walkS }) / 60);
  if (st.type === 'change') st.walkMin = min; else st.min = min;
  applyLiveTimes(journey.steps);
  R.etaKey = etaKey(st);
}
// The minute shown (times are shown cut to the minute) and, at a change, how much time it leaves
const etaKey = (st: FootStep) => `${Math.floor(st.reroute!.eta / 60000)}|${st.type === 'change' ? spareOf(st).level : ''}`;
// With each fix on a rerouted walk: when you get to its end, from there at the engine's pace (the sheet again when
// that is another minute)
function followEta(st: FootStep, s: TripSnap, fixAt: number) {
  const left = Math.max(0, tripLayout().lens[s.i] - s.kmIn) * 1000;
  st.reroute!.eta = fixAt + left * st.reroute!.sPerM * 1000;
  applyLiveTimes(journey.steps);
  const k = etaKey(st);
  if (k !== R.etaKey) { R.etaKey = k; queueSheet(true); }
}
