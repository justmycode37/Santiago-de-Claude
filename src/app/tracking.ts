// ---------- Live tracking: where you and your vehicle are on the trip ----------
// Swiss operators publish no open live vehicle positions, so a vehicle is placed from its live (real-time)
// stop times; you are followed by GPS, snapped onto the trip's line. Without GPS, the live times place you.
import * as maplibregl from 'maplibre-gl';
import { map } from './map.ts';
import { showToast } from '../toast.ts';
import { fixAge, fixTime, gpsOn, userAccuracy, userLngLat, userMarker } from './location.ts';
import { destMarker } from './search.ts';
import { hasForecast, icon, journeyEnd, lineLabel, lineVars, liveMs, modeOf, routedSpan, splitLine, stopName } from './journey-steps.ts';
import { rideTrip } from './live-engine.ts';
import { MODE_NAME } from './sheet.ts';
import { goToStep } from './pill.ts';
import { distKm, lengthKm } from './routing.ts';
import { journey, searchState, tracking } from './state.ts';
import { KANTE_LIVE } from '../live.ts';
import { bearingDeg } from '../compass.ts';
import type { KanteAdvancedPosition } from '../live.ts';
import type { JourneyRideStep, JourneyStep } from './journey-steps.ts';

// ---------------------------------------------------------------- your place on the trip

/**
 * A place on the trip: the step (its index in journeySteps) and how many km into that step's line. walkedKmIn: how
 * far of it is drawn as walked, when that is less (on a walk's guessed stretch: snapToTrip()).
 */
export interface TripPlace { i: number; kmIn: number; walkedKmIn?: number }
/** Where the live timetable says you are (timeProgress()). ended: the last timed step is over. */
export interface TimedPlace extends TripPlace { ended?: boolean }
/** A GPS position snapped onto the trip (snapToTrip()). */
export interface TripSnap extends TripPlace {
  /** What the snap was chosen by: metres off the line, plus the penalties for going backwards and boarding early. */
  cost: number;
  /** Metres off the line. */
  d: number;
  /** km into the whole trip. */
  km: number;
  /** On a guessed stretch of a walk (guessedKm()): not routed, so the blue dot is not put on it, and the walk is
   *  drawn as walked only up to where the stretch begins (walkedKmIn), until you are within 25 m of the walk's end. */
  guess?: boolean;
}
/** GPS progress (`track`): the last fix snapped onto the trip. */
export interface TrackState extends TripSnap {
  /** The geoVersion its km were measured on. */
  v: number;
  /** Fixes in a row that were off the line; two make it `off`. */
  offCount: number;
  off: boolean;
  /** You have been on the route at some fix (a trip that starts elsewhere is not "off the route" before that). */
  onRoute?: boolean;
  /** The ride that has left without you (missedRide()). */
  missed?: JourneyRideStep | null;
  /** Within 25 m of the trip's end along its line, or within the GPS accuracy of the destination (counted as 20 to
   *  40 m); when the trip ends on foot, only past its last ride. For good (tracking.arrivedAt) only on a fix that is
   *  itself there (trackOnce()). */
  arrived?: boolean;
}
/** The trip's steps laid end to end (tripLayout()): each step's length and where it starts, in km. */
export interface TripLayout {
  /** The geoVersion and the steps it was measured for. */
  v: number;
  steps: JourneyStep[];
  lens: number[];
  km0: number[];
  total: number;
}
/** The closest point of a segment to a position (projectSeg()): metres away, and 0…1 along the segment. */
export interface SegProjection { d: number; t: number }
// ---------------------------------------------------------------- the vehicle of a ride

/** Where a ride's vehicle is along the ride's line: at a stop (its name), or between two. */
export interface VehiclePlace {
  km: number;
  at?: string | null;
  from?: string | null;
  to?: string | null;
}
/** …placed by the Kante engine: its position moved on to `tNow` (the engine's clock, unix seconds), and the trip it is of. */
export interface EngineVehiclePlace extends VehiclePlace { engine: KanteAdvancedPosition; tNow: number; trip: KanteTrip }
/** …placed from the ride's live stop times. */
export interface TimedVehiclePlace extends VehiclePlace { engine?: undefined; tNow?: undefined; trip?: undefined }
/** vehicleState() */
export type VehicleState = EngineVehiclePlace | TimedVehiclePlace;


// A step's line in travel order (a change without a walk is just the platform)
function stepLine(st: JourneyStep): LngLat[] {
  if (st._lv === tracking.geoVersion) return st._line!;
  let cs = st.type === 'ride' ? st.path : (st.lines || []).flat();
  if (!cs.length && st.type === 'change') cs = st.points.filter(Boolean).slice(-1) as LngLat[];
  st._lv = tracking.geoVersion;
  st._line = cs || [];
  return st._line;
}
let layCache: TripLayout | null = null;
export function tripLayout(): TripLayout {
  if (layCache && layCache.v === tracking.geoVersion && layCache.steps === journey.steps) return layCache;
  const lens: number[] = [], km0: number[] = [];
  let total = 0;
  journey.steps.forEach((st) => { km0.push(total); const l = lengthKm(stepLine(st)); lens.push(l); total += l; });
  layCache = { v: tracking.geoVersion, steps: journey.steps, lens, km0, total };
  return layCache;
}
function cumKm(cs: LngLat[]) {
  const out = [0];
  for (let k = 1; k < cs.length; k++) out.push(out[k - 1] + distKm(cs[k - 1], cs[k]));
  return out;
}
// Closest point to p on the segment a→b (flat approximation, fine over a few km) → { d: metres, t: 0…1 }
function projectSeg(p: LngLat, a: LngLat, b: LngLat): SegProjection {
  const kx = 111320 * Math.cos(p[1] * Math.PI / 180), ky = 110540;
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky;
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / L2)) : 0;
  return { d: Math.hypot(ax + dx * t, ay + dy * t), t };
}
function pointAtKm(cs: LngLat[], km: number): LngLat | null {
  if (!cs.length) return null;
  const len = lengthKm(cs);
  return cs.length < 2 || !len ? cs[0] : splitLine(cs, Math.min(1, Math.max(0, km / len)))[2];
}
// How far along a ride's line (km) each of its stops is. Where the engine laid the ride onto the rails and roads, each
// stop is a vertex of the line (pathIdx): exact, also where the line passes the same place twice (a loop, a terminus
// it goes round). Else each stop is projected onto the line drawn through them.
export function stopKms(st: JourneyRideStep): number[] {
  if (st._kmFor === st.path) return st._kms!;
  const cs = st.path, cum = cumKm(cs);
  if (st.pathIdx && st.pathIdx.length === st.stops.length && st.pathIdx.every((i) => i < cs.length)) {
    st._kms = st.pathIdx.map((i) => cum[i]);
    st._kmFor = cs;
    return st._kms;
  }
  let j0 = 0;
  st._kms = st.stops.map((p) => {
    let best: { d: number; j: number; km: number } | null = null;
    for (let j = j0; j < cs.length - 1; j++) {
      const q = projectSeg(p, cs[j], cs[j + 1]);
      if (!best || q.d < best.d) best = { d: q.d, j, km: cum[j] + q.t * (cum[j + 1] - cum[j]) };
      if (q.d < 40) break; // the line runs through every stop: take the first pass, not a later one nearby
    }
    if (!best) return cum[cum.length - 1];
    j0 = best.j;
    return best.km;
  });
  st._kmFor = cs;
  return st._kms;
}

// Where a ride's vehicle is now → { km, at } or { km, from, to } (+ engine: the Kante engine's position, when it
// placed it), or null when it is not on this part of its route
export function vehicleState(st: JourneyRideStep, now: number): VehicleState | null { return engineVehicle(st, now) || timedVehicle(st, now); }
// The engine's position (timed from measured stops, forecasts or on-board reports), laid onto the drawn ride: of the
// trip the ride is on now. A ride you stay seated on over several trips is on the last one that has left the stop
// where it begins (by the live times): an older answer for the trip before must not place the vehicle there.
function engineVehicle(st: JourneyRideStep, now: number): EngineVehiclePlace | null {
  const s = st.s;
  let n = 0;
  for (let x = 1; x < s.legs.length; x++) {
    const k = s.seqIdx[x].get(s.legs[x].from.seq), t = k == null ? null : liveMs(s.stops[k], 'dep');
    if (t != null && now >= t) n = x;
  }
  const k = s.live[n], trip = rideTrip(s, n), pos = trip && trip.position;
  if (!pos) return null;
  // the engine's "now": the position's t plus the time since that answer came in (so a wrong phone clock doesn't matter)
  const tNow = (pos.t != null ? pos.t : k.at / 1000) + (now - k.at) / 1000;
  const p = KANTE_LIVE.advance(pos, trip!.calls, tNow);
  // the trip's stops laid onto the ride's by seq; a position elsewhere leaves the timetable placing below
  const r = KANTE_LIVE.rideKm(p, s.seqIdx[n], stopKms(st), st.stopIdx || []);
  if (!r) return null;
  const name = (x: number) => st.s.stops[x] && stopName(st.s.stops[x]);
  return r.at != null ? { km: r.km, at: name(r.at), engine: p!, tNow, trip: trip! } : { km: r.km, from: name(r.from), to: name(r.to), engine: p!, tNow, trip: trip! };
}
// From its live stop times: at a stop while it is due there, else between two stops in proportion to time
function timedVehicle(st: JourneyRideStep, now: number): TimedVehiclePlace | null {
  interface TimedStop { km: number; a: number; d: number; name: string }
  const list = st.s.stops, kms = stopKms(st);
  const pts = (st.stopIdx || []).map((k, m) => {
    const stop = list[k];
    const a = liveMs(stop, 'arr'), d = liveMs(stop, 'dep');
    return { km: kms[m], a: a != null ? a : d, d: d != null ? d : a, name: stopName(stop) };
  }).filter((x): x is TimedStop => x.a != null && x.km != null);
  if (pts.length < 2 || now < pts[0].d || now > pts[pts.length - 1].a) return null;
  for (let n = 0; n < pts.length - 1; n++) {
    const p = pts[n], q = pts[n + 1];
    if (now <= p.d) return { km: p.km, at: p.name };
    if (now < q.a) return { km: p.km + (q.km - p.km) * ((now - p.d) / Math.max(1, q.a - p.d)), from: p.name, to: q.name };
  }
  const z = pts[pts.length - 1];
  return { km: z.km, at: z.name };
}

// Where the live timetable says you are → { i, kmIn, ended }, or null before the trip starts
function timeProgress(now = Date.now()): TimedPlace | null {
  let last: TimedPlace | null = null;
  for (let i = 0; i < journey.steps.length; i++) {
    const st = journey.steps[i];
    if (st.t0 == null || st.t1 == null) continue;
    if (now < st.t0) return last; // between steps: waiting where the last one ended
    const len = tripLayout().lens[i];
    if (now >= st.t1) { last = { i, kmIn: len }; continue; }
    let k = null;
    if (st.type === 'ride') { const v = vehicleState(st, now); k = v && v.km; }
    else if (st.type === 'change' && st.walkMin > 0) k = Math.min(1, (now - st.t0) / (st.walkMin * 60000)) * len;
    if (k == null) k = ((now - st.t0) / Math.max(1, st.t1 - st.t0)) * len;
    return { i, kmIn: k };
  }
  return last && { ...last, ended: true };
}

// The trip is under way (or about to be): only then does GPS move you along it, so a trip planned for later is left alone
export function tripLive(now = Date.now()) {
  const first = journey.steps.find((st) => st.t0 != null);
  return !!first && now >= first.t0! - 30 * 60000 && now <= journeyEnd() + 30 * 60000;
}

// A walk's guessed stretches (the engine's approxStart / approxEnd, kept as approxTo / approxFrom; all of a line
// that is all a guess: no path found, or not routed yet), as km ranges along its step's line (stepLine()): what
// journey-steps.ts draws dashed.
function guessedKm(st: JourneyStep, cum: number[]): [number, number][] {
  if (st.type === 'ride') return [];
  const out: [number, number][] = [];
  let o = 0; // where line k begins in stepLine()
  (st.lines || []).forEach((l, k) => {
    const w = st.walks && st.walks[k], z = o + l.length - 1;
    if (l.length > 1 && (!w || w.approx)) out.push([cum[o], cum[z]]);
    else if (w && l.length > 1 && (w.approxTo != null || w.approxFrom != null)) {
      const [a, b] = routedSpan(w, l.length);
      if (a > 0) out.push([cum[o], cum[o + a]]);
      if (b < l.length - 1) out.push([cum[o + b], cum[z]]);
    }
    o += l.length;
  });
  return out;
}
// Snap a GPS position onto the trip. Ties go to the earlier step (waiting at the stop, not yet riding);
// going backwards and boarding before the vehicle has left are penalised, so loops and parallel lines stay right.
// On a walk's guessed stretch (guessedKm()) you are where you are, as on any line (how far you are from it, where along
// it, so the next fix, the distance left, the bar and arrival go by that); only the walk drawn as walked stops where
// the stretch begins (walkedKmIn: on the guessed start, or a walk all guessed, not at all; on the guessed end, up to
// where the routed part ends), until you are within 25 m of the walk's end. The blue dot is not put on it
// (placeUserDot()), there too.
export function snapToTrip(p: LngLat, ref: number, now: number, reach?: Reach | null): TripSnap | null {
  return snapBoth(p, ref, now, reach).best;
}
/** Where you can have got to since the last fix: km into the trip. */
export interface Reach { lo: number; hi: number }
// The snap within `reach` (best), and the best anywhere on the trip (free): a place outside reach is not taken from one
// fix (it costs a kilometre and more), however near the line it is.
function snapBoth(p: LngLat, ref: number, now: number, reach?: Reach | null): { best: TripSnap | null; free: TripSnap | null } {
  const lay = tripLayout();
  let best: TripSnap | null = null, free: TripSnap | null = null;
  journey.steps.forEach((st, i) => {
    const cs = stepLine(st);
    if (!cs.length) return;
    const early = st.type === 'ride' && st.t0 != null && now < st.t0 - 60000 ? 150 : 0;
    // walkedKmIn: on a guessed stretch, how far it is drawn as walked; reachOnly: a place only for the snap within reach
    const consider = (d: number, kmIn: number, walkedKmIn?: number, reachOnly?: boolean) => {
      const km = lay.km0[i] + kmIn;
      const cost = d + early + (km < ref ? (ref - km) * 500 : (km - ref) * 20);
      const out = reach ? Math.max(0, reach.lo - km, km - reach.hi) : 0;
      const c = cost + (out > 0 ? 1000 + out * 2000 : 0);
      // free: where the fix is nearest the line, wherever that is (ties to the nearer to where you were)
      const near = d + early + Math.abs(km - ref) * 2;
      const snap = (x: number): TripSnap => walkedKmIn == null ? { cost: x, d, i, kmIn, km } : { cost: x, d, i, kmIn, km, walkedKmIn, guess: true };
      if (!best || c < best.cost) best = snap(c);
      if (!reachOnly && (!free || near < free.cost)) free = snap(near);
    };
    if (cs.length === 1) { consider(distKm(p, cs[0]) * 1000, 0); return; }
    const cum = cumKm(cs), guesses = guessedKm(st, cum);
    const nearEnd = distKm(p, cs[cs.length - 1]) < 0.025; // within 25 m of the walk's end: drawn as walked up to you
    for (let j = 0; j < cs.length - 1; j++) {
      const q = projectSeg(p, cs[j], cs[j + 1]), k = cum[j] + q.t * (cum[j + 1] - cum[j]);
      // on a guess: past where it begins (where a routed part ends is on that part), or anywhere on a guess the walk starts with
      const g = guesses.find(([a, b]) => k >= a && k <= b && (k > a || a === 0));
      consider(q.d, k, g ? (nearEnd ? k : g[0]) : undefined);
      // the fix's foot on the segment is out of reach, but some of the segment is not: its nearest place within reach
      // (a long straight stretch must not let one fix carry you to its far end)
      if (reach) {
        const k0 = lay.km0[i] + cum[j], k1 = lay.km0[i] + cum[j + 1], kk = lay.km0[i] + k;
        const lo = Math.max(k0, reach.lo), hi = Math.min(k1, reach.hi);
        if (lo <= hi && (kk < lo || kk > hi) && k1 > k0) {
          const kc = Math.min(hi, Math.max(lo, kk)), t = (kc - k0) / (k1 - k0);
          const pt: LngLat = [cs[j][0] + (cs[j + 1][0] - cs[j][0]) * t, cs[j][1] + (cs[j + 1][1] - cs[j][1]) * t];
          const kin = kc - lay.km0[i], gc = guesses.find(([a, b]) => kin >= a && kin <= b && (kin > a || a === 0));
          consider(distKm(p, pt) * 1000, kin, gc ? (nearEnd ? kin : gc[0]) : undefined, true);
        }
      }
    }
  });
  return { best, free };
}

// The fastest you can move on a step, m/s: on foot (running for it), or on board (the line's mode)
function topSpeed(st: JourneyStep) {
  if (st.type !== 'ride') return 7;
  const m = modeOf(st.s.line.category);
  return m === 'train' ? 70 : m === 'bus' || m === 'tram' || m === 'boat' || m === 'cable' ? 28 : 40;
}

// Still at (or on the way to) the stop of a ride that has left without you?
function missedRide(t: TripPlace, now: number): JourneyRideStep | null {
  if (fixAge() > 20000) return null;
  const st = journey.steps[t.i];
  const r = st.type === 'ride' ? st : st.nextRide;
  if (!r || r.t0 == null || now < r.t0 + 90000) return null;
  if (st === r && t.kmIn > 0.1) return null; // moving along it: on board
  const v = vehicleState(r, now);
  return !v || v.km > 0.4 ? r : null;
}

// On a walk, the blue dot sits on the walking route while GPS puts you within its accuracy of it (the halo stays
// where GPS says), so it does not wander through walls; on a ride, or away from the route, it shows GPS as it is.
export function placeUserDot() {
  if (!userLngLat) return;
  let at: LngLat = userLngLat;
  const st = tracking.track && !tracking.track.off && !tracking.track.arrived ? journey.steps[tracking.track.i] : null;
  const routed = !!st && st.type !== 'ride' && (st.walks || []).some((w) => w && w.net && !w.approx); // only onto real paths, never a straight guess
  if (routed && tracking.track && !tracking.track.guess && tracking.track.d <= Math.max(12, Math.min(userAccuracy, 40))) at = pointAtKm(stepLine(st!), tracking.track.kmIn) || at;
  userMarker.setLngLat(at);
}
/**
 * Where you are on the trip, for the follow camera (follow-cam.ts): on a ride or not, and which way the trip's line
 * goes there (deg; looking 25 m on, so a bend of the path or track does not swing it), null when GPS does not put you
 * on a known stretch of it (off the route, on a walk's guessed stretch, arrived, the last metres of a step).
 */
let hereFor: { t: TrackState; v: number; here: { onRide: boolean; bearing: number | null } } | null = null;
export function tripHere(): { onRide: boolean; bearing: number | null } | null {
  const t = tracking.track;
  if (!t || t.off || t.arrived || !gpsOn()) return null;
  // (asked a few times a second: measured again only for a new fix or new lines)
  if (hereFor && hereFor.t === t && hereFor.v === tracking.geoVersion) return hereFor.here;
  const st = journey.steps[t.i];
  const onRide = st.type === 'ride' && !t.missed && t.kmIn > 0;
  let bearing: number | null = null;
  if (!t.guess) {
    const cs = stepLine(st), a = pointAtKm(cs, t.kmIn), b = pointAtKm(cs, t.kmIn + 0.025);
    if (a && b && distKm(a, b) > 0.008) bearing = bearingDeg(a, b);
  }
  hereFor = { t, v: tracking.geoVersion, here: { onRide, bearing } };
  return hereFor.here;
}
export function trackJourney() {
  trackOnce();
  placeUserDot();
}
// Where the trip's line ends: the door or the place of its last walk, else where its last ride ends
function tripEndPoint(): LngLat | null {
  for (let i = journey.steps.length - 1; i >= 0; i--) {
    const cs = stepLine(journey.steps[i]);
    if (cs.length) return cs[cs.length - 1];
  }
  return null;
}
function trackOnce() {
  if (!journey.steps.length || !gpsOn() || !tripLive()) { tracking.track = null; return; }
  const now = Date.now(), lay = tripLayout(), tp = timeProgress(now);
  // where you were at the last fix (measured on today's lines), else where the timetable puts you
  const prev = tracking.track && !tracking.track.off && tracking.track.v === tracking.geoVersion ? tracking.track : null;
  const ref = prev ? prev.km : tp ? lay.km0[tp.i] + tp.kmIn : 0;
  // From a place on the trip you can only have got so far since that fix (at the top speed of the step you were on):
  // on a line that passes the same place twice (a loop, the way out and back beside it, a walk beside the ride), or
  // past a stray fix, you stay where you were going. The fix's own time: the same fix followed again (the page does
  // every few seconds) gets you no further, and does not count again towards being off the route or towards a jump.
  const fixAt = fixTime(), fresh = fixAt > tracking.fixAt;
  const acc = Math.min(Math.max(userAccuracy, 10), 150);
  // (back along the trip is only dear, as it was: a fix that put you on too far is undone by the next one)
  // (at the top speed of the step you were on or the next ones: from the platform onto a train between two fixes)
  const vmax = prev ? Math.max(...journey.steps.slice(prev.i, prev.i + 3).map(topSpeed)) : 0;
  const reach = prev && prev.i < journey.steps.length
    ? { lo: -Infinity, hi: prev.km + (fresh ? (vmax * Math.max(0, fixAt - tracking.fixAt) / 1000 + 2 * acc + 100) / 1000 : 0) }
    : null;
  if (!reach) tracking.jump = null; // nothing to jump from (a trip just opened, or you were off it)
  const both = snapBoth(userLngLat!, ref, now, reach);
  let s = both.best;
  if (!s) { tracking.track = null; return; }
  // Somewhere else on the trip, much nearer the fix than the place within reach (on, out of reach; or back, further
  // than going back is believed from one fix), is believed when three fixes in a row (each taken later than the one
  // before) agree on it: the line really does go on there (you got on a vehicle the timetable did not expect, GPS was
  // lost for a while), or you were put on the wrong pass of a line that passes the same place twice
  const free = both.free;
  if (reach && free && Math.abs(free.km - s.km) > 0.2 && free.d + 25 < s.d) {
    const j = tracking.jump;
    const along = j ? (topSpeed(journey.steps[free.i]) * Math.max(0, fixAt - j.at) / 1000 + 2 * acc + 100) / 1000 : 0;
    const n = !j ? 1 : fixAt === j.at ? j.n : Math.abs(free.km - j.km) <= along ? j.n + 1 : 1;
    tracking.jump = { km: free.km, at: fixAt, n };
    if (n >= 3) { s = free; tracking.jump = null; }
  } else tracking.jump = null;
  tracking.fixAt = fixAt;
  const arrive = (t: TripSnap) => {
    const a: TrackState = { ...t, i: journey.steps.length - 1, kmIn: 0, km: lay.total, v: tracking.geoVersion, offCount: 0, off: false, onRoute: true, arrived: true, missed: null };
    delete a.walkedKmIn;
    delete a.guess;
    return a;
  };
  // Arrived for good: you stay arrived (walking on into the building, GPS straying there or lost for a while do not
  // undo it) until another trip is opened, whose steps are new ones
  if (tracking.arrivedAt === journey.steps) { tracking.track = arrive(s); return; }
  // walks follow exact footpaths now, so leaving one shows sooner than leaving a ride's line
  const here = journey.steps[s.i];
  const onFoot = here.type !== 'ride' && !s.guess && (here.walks || []).some((w) => w && w.net && !w.approx);
  const tol = onFoot ? Math.max(25, Math.min(userAccuracy, 150)) + 20 : Math.max(35, Math.min(userAccuracy, 150)) + 30;
  // A trip that starts somewhere else: you are not "off the route" before you have been on it
  // (once you have been on it, leaving it again is "off the route", however long that lasts)
  // near some part of the trip is not off it, also while a jump there is not believed yet
  const near = Math.min(s.d, free ? free.d : Infinity);
  const onRoute = !!(tracking.track && tracking.track.onRoute) || near <= tol;
  if (searchState.tripStart && !onRoute) { tracking.track = null; return; }
  const offCount = near > tol ? ((tracking.track && tracking.track.offCount) || 0) + (fresh ? 1 : 0) : 0;
  tracking.track = { ...s, v: tracking.geoVersion, offCount, off: offCount >= 2, onRoute }; // two fixes in a row, so one stray fix doesn't count
  if (tracking.track.off) return;
  // Arrived: within 25 m of the trip's end along its line (a trip that ends on foot only past its last ride: not on
  // a bus 10 m before the stop a short walk leads on from), or with the fix itself at the end: within the GPS
  // accuracy (counted as 20 to 40 m) of the destination, or of where the trip's line ends (at least 25 m). That one
  // counts past the last ride, or from a minute before the last ride gets to its stop (live) on: the last walk can
  // double back beside the ride, so a fix there snaps onto the ride. Before then a ride passing the destination is
  // just passing, and in that minute a fix on the ride within 25 m of its stop is the vehicle pulling in.
  const dest = destMarker._map && destMarker.getLngLat().toArray();
  const pastRides = journey.steps.slice(s.i).every((st) => st.type !== 'ride');
  const onFootLast = journey.steps.some((st) => st.type === 'walk' && st.final);
  const radius = Math.min(0.04, Math.max(0.02, userAccuracy / 1000)); // km
  const end = tripEndPoint();
  const there = (!!dest && distKm(userLngLat!, dest) < radius) || (!!end && distKm(userLngLat!, end) < Math.max(0.025, radius));
  const lastRide = journey.steps.filter((st): st is JourneyRideStep => st.type === 'ride').pop();
  const pullingIn = here === lastRide && lay.lens[s.i] - s.kmIn < 0.025;
  const ridden = pastRides || (!!lastRide && lastRide.t1 != null && (now >= lastRide.t1 || (now >= lastRide.t1 - 60000 && !pullingIn)));
  if (((pastRides || !onFootLast) && lay.total - s.km < 0.025) || (there && ridden)) {
    tracking.track = { ...arrive(s), offCount: tracking.track.offCount, onRoute };
    // for good only on a fix that is itself there (not one that is only snapped onto the trip's end from far off:
    // a stray fix)
    if (there) tracking.arrivedAt = journey.steps;
  }
  tracking.track.missed = tracking.track.arrived ? null : missedRide(tracking.track, now);
  // move the cards along with you, unless you have just picked a step yourself
  if (!tracking.track.missed && tracking.track.i !== tracking.autoStep) {
    tracking.autoStep = tracking.track.i;
    if (now - tracking.userPickedAt > 20000 && !journey.list) goToStep(tracking.track.i, true);
  }
}

// Your place on the trip: GPS when it is following you, else the live timetable
export function journeyProgress(): TripPlace | null {
  if (tracking.track && !tracking.track.off && gpsOn()) return tracking.track;
  return journey.steps.length ? timeProgress() : null;
}
// …as a moment of the trip, for the bar at the top
export function progressTime() {
  const t = tracking.track && !tracking.track.off && gpsOn() ? tracking.track : null;
  if (!t) return { t: Date.now(), gps: false };
  if (t.arrived) return { t: Infinity, gps: true };
  const st = journey.steps[t.i], len = tripLayout().lens[t.i];
  if (st.t0 == null || st.t1 == null) return { t: Date.now(), gps: false };
  return { t: st.t0 + (st.t1 - st.t0) * (len ? Math.min(1, t.kmIn / len) : 1), gps: true };
}

// Map markers: the vehicle of the ride under way, and (without GPS) where the timetable says you are
const nowEl = document.createElement('div');
nowEl.className = 'route-now';
nowEl.title = 'Estimated from the live timetable (no GPS)';
export const nowMarker = new maplibregl.Marker({ element: nowEl });
const vehEl = document.createElement('div');
vehEl.className = 'route-veh';
vehEl.setAttribute('role', 'img');
vehEl.title = 'Position estimated from live departure times';
vehEl.addEventListener('click', () => showToast(vehEl.title, 5000)); // phones have no hover: a tap says how it was placed
export const vehMarker = new maplibregl.Marker({ element: vehEl });
// How the vehicle was placed, honestly: measured, forecast or timetable → { text, dim }
function vehicleHonesty(st: JourneyRideStep, v: VehicleState, now: number) {
  const s = st.s, n = Math.max(0, s.legs.findIndex((_, x) => !!rideTrip(s, x, true)));
  const trip = v.trip || rideTrip(s, n, true), info = trip && KANTE_LIVE.liveInfoOf(trip);
  // the engine had this ride but has stopped answering
  if (!trip && s.live.some((k) => k.trip && k.fails >= 2)) return KANTE_LIVE.liveText({ state: 'stale' });
  if (v.engine) {
    const p = v.engine, calls = new Map((v.trip.calls || []).map((c) => [c.seq, c]));
    // "Left Zytglogge 1 min ago (measured)" only when that departure itself was measured: not when the vehicle was
    // only moved on from a stop because its departure time had passed (p.stepped)
    const measuredHere = p.state === 'between' && !p.stepped && KANTE_LIVE.depMeasured(info, p.seq);
    const dep = measuredHere ? (p.dep != null ? p.dep : KANTE_LIVE.liveDep(calls.get(p.seq))) : null;
    const obs = info && info.observedSeq != null ? calls.get(info.observedSeq) : null;
    return KANTE_LIVE.liveText(info, { basis: p.basis, from: v.from,
      leftS: dep != null ? Math.max(0, v.tNow - dep) : null, observedAt: obs && obs.quay && obs.quay.stationName });
  }
  if (info && info.state === 'stale') return KANTE_LIVE.liveText(info);
  const forecast = s.stops.some((x) => hasForecast(x, 'dep') || hasForecast(x, 'arr'));
  return forecast ? { text: 'Estimated from forecasts', dim: false } : KANTE_LIVE.liveText({ state: 'timetable' });
}
// The ride's vehicle as shown: glided along the ride's line (km) towards where the live data puts it, about 20 times
// a second between the page's updates (KANTE_LIVE.glide: never backwards, catching up at up to twice its pace)
let vehShown: { st: JourneyRideStep; path: LngLat[]; km: number; at: number } | null = null;
let vehAnim = 0, vehAnimAt = 0;
function shownKm(st: JourneyRideStep, km: number, now: number) {
  const s = vehShown && vehShown.st === st && vehShown.path === st.path ? vehShown : null;
  const ahead = vehicleState(st, now + 1000), rate = ahead ? Math.max(0, ahead.km - km) : 0; // km a second
  const k = s ? KANTE_LIVE.glide(s.km, km, rate, (now - s.at) / 1000, Math.max(0.5, 60 * rate)) : km;
  vehShown = { st, path: st.path, km: k, at: now };
  return k;
}
function animateVehMarker(t: number) {
  vehAnim = 0;
  if (!vehMarker._map || !vehShown || document.hidden) return;
  vehAnim = requestAnimationFrame(animateVehMarker);
  if (t - vehAnimAt < 50) return;
  vehAnimAt = t;
  const now = Date.now(), st = vehShown.st, v = vehicleState(st, now);
  if (v) vehMarker.setLngLat(pointAtKm(st.path, shownKm(st, v.km, now))!);
}
export function updateNowMarker() {
  const now = Date.now();
  const ride = journey.steps.find((st): st is JourneyRideStep => st.type === 'ride' && st.t0 != null && now >= st.t0 && now <= st.t1!);
  const gps = !!tracking.track && !tracking.track.off && gpsOn();
  // once GPS shows you on board, your blue dot is the vehicle
  const v = ride && !(gps && journey.steps[tracking.track!.i] === ride && !tracking.track!.missed) ? vehicleState(ride, now) : null;
  if (v && ride!.path.length > 1) {
    const j = ride!.s.line, key = lineLabel(j) + '|' + j.category;
    if (vehEl.dataset.key !== key) {
      vehEl.dataset.key = key;
      vehEl.innerHTML = icon(modeOf(j.category));
      vehEl.appendChild(document.createTextNode(lineLabel(j)));
      lineVars(vehEl, j);
    }
    const how = vehicleHonesty(ride!, v, now);
    if (vehEl.title !== how.text) {
      vehEl.title = how.text;
      vehEl.setAttribute('aria-label', `${MODE_NAME[modeOf(j.category)] || 'Vehicle'} ${lineLabel(j)}: ${how.text}`);
    }
    vehEl.classList.toggle('dim', how.dim);
    vehMarker.setLngLat(pointAtKm(ride!.path, shownKm(ride!, v.km, now))!);
    if (!vehMarker._map) vehMarker.addTo(map);
    if (!vehAnim) vehAnim = requestAnimationFrame(animateVehMarker);
  } else { vehMarker.remove(); vehShown = null; }
  const tp = !gpsOn() && !ride ? timeProgress(now) : null;
  const pos = tp && !tp.ended ? pointAtKm(stepLine(journey.steps[tp.i]), tp.kmIn) : null;
  if (pos) { nowMarker.setLngLat(pos); if (!nowMarker._map) nowMarker.addTo(map); }
  else nowMarker.remove();
}
