// ---------- Live tracking: where you and your vehicle are on the trip ----------
// Swiss operators publish no open live vehicle positions, so a vehicle is placed from its live (real-time)
// stop times; you are followed by GPS, snapped onto the trip's line. Without GPS, the live times place you.
import { map } from './map.ts';
import { showToast } from '../toast.ts';
import { fixAge, gpsOn, userAccuracy, userLngLat, userMarker } from './location.ts';
import { destMarker } from './search.ts';
import { hasForecast, icon, journeyEnd, lineLabel, lineVars, liveMs, modeOf, splitLine, stopName } from './journey-steps.ts';
import { rideTrip } from './live-engine.ts';
import { MODE_NAME } from './sheet.ts';
import { goToStep } from './pill.ts';
import { distKm, lengthKm } from './routing.ts';
import { journey, searchState, tracking } from './state.ts';
import { KANTE_LIVE } from '../live.ts';
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
   *  drawn as walked only up to where the stretch begins (walkedKmIn). */
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
  /** Within 25 m of the trip's end along its line, or (past its last ride) within the GPS accuracy of the destination,
   *  counted as 20 to 40 m. Once arrived, you stay arrived (trackOnce()). */
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
// How far along a ride's line (km) each of its stops is
export function stopKms(st: JourneyRideStep): number[] {
  if (st._kmFor === st.path) return st._kms!;
  const cs = st.path, cum = cumKm(cs);
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

// A walk's guessed stretches (the engine's approxStart / approxEnd, kept as approxTo / approxFrom; all of a walk
// that is all a guess), as km ranges along its step's line (stepLine()): what journey-steps.ts draws dashed.
function guessedKm(st: JourneyStep, cum: number[]): [number, number][] {
  if (st.type === 'ride' || !st.walks) return [];
  const out: [number, number][] = [];
  let o = 0; // where line k begins in stepLine()
  (st.lines || []).forEach((l, k) => {
    const w = st.walks![k], z = o + l.length - 1;
    if (w && l.length > 1 && (w.approxTo != null || w.approxFrom != null)) {
      const a = w.approxTo != null && w.approxTo < l.length - 1 ? w.approxTo : 0;
      const b = w.approxFrom != null && w.approxFrom >= a ? w.approxFrom : l.length - 1;
      if (w.approx) out.push([cum[o], cum[z]]);
      else {
        if (a > 0) out.push([cum[o], cum[o + a]]);
        if (b < l.length - 1) out.push([cum[o + b], cum[z]]);
      }
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
// where the routed part ends), until you are within 25 m of the walk's end.
export function snapToTrip(p: LngLat, ref: number, now: number): TripSnap | null {
  const lay = tripLayout();
  let best: TripSnap | null = null;
  journey.steps.forEach((st, i) => {
    const cs = stepLine(st);
    if (!cs.length) return;
    const early = st.type === 'ride' && st.t0 != null && now < st.t0 - 60000 ? 150 : 0;
    const consider = (d: number, kmIn: number, walkedKmIn?: number) => { // walkedKmIn: on a guessed stretch, where it begins
      const km = lay.km0[i] + kmIn;
      const cost = d + early + (km < ref ? (ref - km) * 500 : (km - ref) * 20);
      if (!best || cost < best.cost) best = walkedKmIn == null ? { cost, d, i, kmIn, km } : { cost, d, i, kmIn, km, walkedKmIn, guess: true };
    };
    if (cs.length === 1) { consider(distKm(p, cs[0]) * 1000, 0); return; }
    const cum = cumKm(cs);
    const guesses = distKm(p, cs[cs.length - 1]) < 0.025 ? [] : guessedKm(st, cum); // within 25 m of the walk's end: walked
    for (let j = 0; j < cs.length - 1; j++) {
      const q = projectSeg(p, cs[j], cs[j + 1]), k = cum[j] + q.t * (cum[j + 1] - cum[j]);
      const g = guesses.find(([a, b]) => k >= a && k <= b);
      consider(q.d, k, g && k > g[0] ? g[0] : undefined);
    }
  });
  return best;
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
export function trackJourney() {
  trackOnce();
  placeUserDot();
}
function trackOnce() {
  if (!journey.steps.length || !gpsOn() || !tripLive()) { tracking.track = null; return; }
  const now = Date.now(), lay = tripLayout(), tp = timeProgress(now);
  // Once arrived, you stay arrived (walking on into the building, or GPS straying there, does not undo it), until
  // another trip is opened (tracking.track is cleared then)
  if (tracking.track && tracking.track.arrived) {
    Object.assign(tracking.track, { i: journey.steps.length - 1, kmIn: 0, km: lay.total, v: tracking.geoVersion });
    return;
  }
  // where you were at the last fix (measured on today's lines), else where the timetable puts you
  const ref = tracking.track && !tracking.track.off && tracking.track.v === tracking.geoVersion ? tracking.track.km : tp ? lay.km0[tp.i] + tp.kmIn : 0;
  const s = snapToTrip(userLngLat!, ref, now);
  if (!s) { tracking.track = null; return; }
  // walks follow exact footpaths now, so leaving one shows sooner than leaving a ride's line
  const here = journey.steps[s.i];
  const onFoot = here.type !== 'ride' && !s.guess && (here.walks || []).some((w) => w && w.net && !w.approx);
  const tol = onFoot ? Math.max(25, Math.min(userAccuracy, 150)) + 20 : Math.max(35, Math.min(userAccuracy, 150)) + 30;
  // A trip that starts somewhere else: you are not "off the route" before you have been on it
  // (once you have been on it, leaving it again is "off the route", however long that lasts)
  const onRoute = !!(tracking.track && tracking.track.onRoute) || s.d <= tol;
  if (searchState.tripStart && !onRoute) { tracking.track = null; return; }
  const offCount = s.d > tol ? ((tracking.track && tracking.track.offCount) || 0) + 1 : 0;
  tracking.track = { ...s, v: tracking.geoVersion, offCount, off: offCount >= 2, onRoute }; // two fixes in a row, so one stray fix doesn't count
  if (tracking.track.off) return;
  // Arrived: within 25 m of the trip's end along its line, or, past its last ride, within the GPS accuracy of the
  // destination (counted as 20 to 40 m; not while a ride passes it)
  const dest = destMarker._map && destMarker.getLngLat().toArray();
  const pastRides = journey.steps.slice(s.i).every((st) => st.type !== 'ride');
  if (lay.total - s.km < 0.025 || (pastRides && dest && distKm(userLngLat!, dest) < Math.min(0.04, Math.max(0.02, userAccuracy / 1000)))) {
    Object.assign(tracking.track, { i: journey.steps.length - 1, kmIn: 0, km: lay.total, arrived: true });
    delete tracking.track.walkedKmIn;
    delete tracking.track.guess;
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
    vehMarker.setLngLat(pointAtKm(ride!.path, v.km)!);
    if (!vehMarker._map) vehMarker.addTo(map);
  } else vehMarker.remove();
  const tp = !gpsOn() && !ride ? timeProgress(now) : null;
  const pos = tp && !tp.ended ? pointAtKm(stepLine(journey.steps[tp.i]), tp.kmIn) : null;
  if (pos) { nowMarker.setLngLat(pos); if (!nowMarker._map) nowMarker.addTo(map); }
  else nowMarker.remove();
}
