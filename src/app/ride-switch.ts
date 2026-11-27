// ---- On another vehicle than planned: "Looks like you're on 10 — update route?" ----
// While a journey is followed by GPS, the last two minutes of fixes are matched against the journey's own rides and,
// when they fit none of them, against the vehicles around you (ride-detect.ts tells which, if any). Once the same
// trip has been named twice in a row, the engine is asked for the journey from on board it to the same destination
// (KanteJourney.onboard()); when that is a sensible way there, a notice offers it. Nothing changes until you tap
// "Update route"; closing the notice leaves that vehicle alone for the rest of the trip (docs/journeys.md, "Another
// vehicle than planned"). pill.ts calls checkRide() with every update of the trip's progress.
import { KANTE } from '../engine.ts';
import { KanteJourney } from '../engine-journey.ts';
import { KANTE_LIVE } from '../live.ts';
import { bearingDeg } from '../compass.ts';
import { showToast } from '../toast.ts';
import { fixTime, gpsOn, userAccuracy, userLngLat } from './location.ts';
import { fmtTime, isRide, journeyEnd, lineLabel, liveMs, modeOf } from './journey-steps.ts';
import { stopKms, tripLive } from './tracking.ts';
import { renderJourney } from './pill.ts';
import { refineJourney } from './routing.ts';
import { livePoll } from './live-engine.ts';
import { MODE_NAME, h, kBadge, kIcon, openDirs, openStops } from './sheet.ts';
import { journey, searchState, tracking } from './state.ts';
import { RIDE, RIDE_DETECT } from './ride-detect.ts';
import type { RideCandidate, RideDecision, RideFix, RideMatch, RideSeen } from './ride-detect.ts';
import type { JourneyDest } from './state.ts';
import type { Journey, JourneyOptions, JourneyRide } from '../engine-journey.ts';
import type { JourneyRideStep } from './journey-steps.ts';

const { decide, confirm, motion, recentFixes, cumKm, metres, project } = RIDE_DETECT;
const tripKey = (x: { tripId: string; serviceDate: string }) => `${x.tripId}|${x.serviceDate}`;
/** A line as two trips are told to be of the same one by: its mode, category and name as the engine has them. */
const lineKey = (l: KanteLine) => `${l.mode}|${l.category}|${l.name}`;
const secs = (ms: number | null | undefined) => (ms == null ? null : ms / 1000);

// ---------------------------------------------------------------- what is kept

/** The fixes of the last two and a half minutes (the phone's clock, ms). */
let fixes: RideFix[] = [];
let lastFixAt = 0;
/** The engine's clock less the phone's (ms), from the last answer of /api/vehicles: fixes are compared with its times. */
let clockOffset = 0;
/** The trip named last, and how often in a row (ride-detect.ts confirm()). */
let seen: RideSeen | null = null;
/** The destination all this is for: another one starts afresh. */
let forDest: JourneyDest | null = null;
/** Trips you said no to; trips the engine had no sensible journey from (until when, ms). */
const dismissed = new Set<string>();
const failed = new Map<string, number>();
/** The vehicles around you, as candidates (refreshed at most every 20 s, less often while none of them fits). */
const near = { cands: [] as RideCandidate[], busy: false, next: 0, idle: 0, hit: false, crowded: false, req: -1 };
/** The engine's answers of /api/trip, by trip (kept a minute, 30 at most). */
const trips = new Map<string, { trip: KanteTrip; at: number }>();
/** Asking the engine for a journey from on board is under way. */
let planning = false;
/** "Update route" tapped: its journey is being asked for (nothing else is offered meanwhile). */
let accepting = false;
/** The trip the fixes last fitted, and when (ms): a journey asked for it is offered only while that is recent. */
let named: { key: string; at: number } | null = null;

/** The journey on offer: from on board which trip, for which plan, and what it is. */
interface RideOffer {
  key: string;
  trip: KanteTrip;
  tripAt: number;
  /** journey.req and journey.dest it was made for. */
  req: number;
  dest: JourneyDest;
  /** Where you were along the trip when it was last seen to hold. */
  match: RideMatch;
  heldAt: number;
  opts: JourneyOptions;
}
let offer: RideOffer | null = null;

// ---------------------------------------------------------------- the candidates

/** The journey's own rides, as candidates: their way and their stops' live times. */
function plannedCands(): RideCandidate[] {
  return journey.steps.filter((st): st is JourneyRideStep => st.type === 'ride').flatMap((st) => {
    const kms = stopKms(st), list = st.s.stops;
    const stops = (st.stopIdx || []).map((k, m) => ({ seq: list[k].seq, km: kms[m], arr: secs(liveMs(list[k], 'arr')), dep: secs(liveMs(list[k], 'dep')) }))
      .filter((s) => s.km != null);
    if (st.path.length < 2 || stops.length < 2) return [];
    const live = st.s.live.some((k) => !!k.trip && KANTE_LIVE.isLive(KANTE_LIVE.liveInfoOf(k.trip)));
    return [{ key: tripKey(st.s.legs[0]), line: lineKey(st.s.legs[0].line), planned: true, live, path: st.path, stops }];
  });
}
/** A trip of the engine (/api/trip) as a candidate: its way and every stop it stops at today. */
function candidateOf(trip: KanteTrip): RideCandidate | null {
  const calls = trip.calls || [];
  if (calls.length < 2 || trip.cancelled) return null;
  let path: LngLat[], kms: number[];
  if (trip.path && trip.pathAt && trip.pathAt.length === calls.length && trip.path.length > 1) {
    path = trip.path;
    const cum = cumKm(path);
    kms = trip.pathAt.map((i) => cum[Math.min(i, cum.length - 1)]);
  } else {
    path = calls.map((c): LngLat => [c.quay.lon, c.quay.lat]);
    kms = cumKm(path);
  }
  const live = (t: number | undefined, d: number | undefined) => (t == null ? null : t + (d || 0));
  const stops = calls.map((c, i) => ({ seq: c.seq, km: kms[i], arr: live(c.arr, c.arrDelayS), dep: live(c.dep, c.depDelayS), skip: !!c.skipped }))
    .filter((s) => !s.skip).map(({ skip, ...s }) => s);
  return { key: tripKey(trip), line: lineKey(trip.line), live: KANTE_LIVE.isLive(KANTE_LIVE.liveInfoOf(trip)), path, stops };
}
// metres from p to a vehicle's way between two stops: its encoded path where it has one, else the straight line
function toHop(p: LngLat, a: LngLat, b: LngLat, path?: string) {
  let cs: LngLat[] = [a, b];
  if (path) { try { const d = KANTE_LIVE.decodePolyline(path); if (d.length > 1) cs = d; } catch (e) { /* the straight line */ } }
  const q = project(cs, cumKm(cs), p);
  return q ? q.d : Infinity;
}
/**
 * The vehicles around you that may be the one you are on (their trips from the engine), into `near`. Their positions
 * are worked out from live stop times, so a fast one can be a kilometre off where it really is: they are picked by
 * how near you are to its way between the stops before, at and after where it is drawn, going your way (over the
 * last 20 s: a bend), not by where they are drawn.
 */
async function lookAround(win: RideFix[]) {
  if (near.busy || Date.now() < near.next || document.hidden || !KANTE || !KANTE.base || !KANTE.ok()) return;
  const req = journey.req, a = win[0], z = win[win.length - 1];
  // less often while none of the vehicles found last time fitted (moving with the trip open in a car): 20, 40, 60 s
  if (near.req === req) near.idle = near.hit ? 0 : near.idle + 1;
  near.hit = false;
  near.busy = true;
  const speed = metres(a.ll, z.ll) / Math.max(1, (z.t - a.t) / 1000);
  const h0 = win.find((f) => f.t >= z.t - 20000 && metres(f.ll, z.ll) >= 30) || a, heading = bearingDeg(h0.ll, z.ll);
  const half = Math.min(3000, Math.max(900, speed * 120)); // m
  const kx = 111195 * Math.cos(z.ll[1] * Math.PI / 180), ky = 111195;
  const box: KanteBbox = [z.ll[0] - half / kx, z.ll[1] - half / ky, z.ll[0] + half / kx, z.ll[1] + half / ky];
  const sent = Date.now();
  const res = await KANTE.vehicles({ bbox: KANTE_LIVE.bboxParam(box) }).catch(() => null);
  near.busy = false;
  if (req !== journey.req) return;
  near.next = Date.now() + 20000 * (1 + Math.min(2, near.idle));
  if (!res) return;
  if (Number.isFinite(res.t)) clockOffset = res.t * 1000 - (sent + Date.now()) / 2;
  const turn = (x: number) => { const d = Math.abs(((x - heading) % 360 + 360) % 360); return Math.min(d, 360 - d); };
  // (extra journeys, not in the timetable, cannot be planned from on board)
  const picks = (res.vehicles || []).filter((v) => !v.extra).map((v) => {
    const d = Math.min(toHop(z.ll, v.from, v.to, v.hopPath), v.onward ? toHop(z.ll, v.to, v.onward.to, v.onward.hopPath) : Infinity,
      v.behind ? toHop(z.ll, v.from, v.from, v.behind.hopPath) : Infinity, v.point ? metres(z.ll, v.point) : Infinity);
    const standing = v.from[0] === v.to[0] && v.from[1] === v.to[1];
    const hd = v.heading != null ? v.heading : standing ? (v.onward ? bearingDeg(v.to, v.onward.to) : null) : bearingDeg(v.from, v.to);
    return { v, d, hd };
  }).filter((x) => x.d <= 400 && (x.hd == null || turn(x.hd) <= 100)).sort((p, q) => p.d - q.d);
  const now = Date.now();
  for (const [k, t] of trips) if (now - t.at > 60000) trips.delete(k);
  near.busy = true;
  const got = await Promise.all(picks.slice(0, 6).map(async ({ v }) => {
    const k = tripKey(v), had = trips.get(k);
    if (had) return had.trip;
    const trip = await KANTE!.trip(v.tripId, v.serviceDate).catch(() => null);
    if (trip) { trips.set(k, { trip, at: Date.now() }); while (trips.size > 30) trips.delete(trips.keys().next().value!); }
    return trip;
  }));
  near.busy = false;
  if (req !== journey.req) return;
  near.cands = got.map((t) => t && candidateOf(t)).filter((c): c is RideCandidate => !!c);
  // too many going your way right beside you to look at them all (a station's throat): not sure, wait
  near.crowded = picks.filter((x) => x.d <= 150).length > 6;
  near.req = req;
}

// ---------------------------------------------------------------- watching

/** Called with every update of the trip's progress (pill.ts updateProgress()): a new fix is matched. */
// Following the journey by GPS now (not choosing from the list, not arrived)
// (a trip that starts somewhere else: only once you have been on it, as tracking.ts has it)
const following = () => !!journey.conn && !!journey.dest && !journey.list && tripLive() && gpsOn() && !(tracking.track && tracking.track.arrived)
  && !(searchState.tripStart && !(tracking.track && tracking.track.onRoute));
export function checkRide() {
  if (offer && (offer.req !== journey.req || offer.dest !== journey.dest)) hideNote();
  // not following: what was seen does not hold any more, nor does a notice (you may have got off meanwhile)
  if (!following()) { seen = null; named = null; if (offer) hideNote(); return; }
  if (!journey.conn || !journey.dest) return;
  if (journey.dest !== forDest) {
    forDest = journey.dest;
    dismissed.clear(); failed.clear(); seen = null; named = null; fixes = [];
    Object.assign(near, { cands: [], next: 0, idle: 0, hit: false, crowded: false, req: -1 });
  }
  const at = fixTime();
  if (at <= lastFixAt || !userLngLat) return; // (the same fix again: a timer tick)
  lastFixAt = at;
  fixes.push({ ll: userLngLat, t: at, acc: userAccuracy });
  fixes = fixes.filter((f) => f.t > at - 150000);
  // in the engine's time
  const off = clockOffset, now = Date.now() + off, fx = fixes.map((f) => ({ ...f, t: f.t + off }));
  const win = recentFixes(fx, now);
  if (!motion(win, now)) { seen = null; return; }
  // on a planned ride, closer to its vehicle than any other trip could beat it by: nothing more to ask (a planned ride
  // that fits only loosely may be beaten by another run of its line that fits well: those around you are looked at)
  const planned = plannedCands(), local = decide(fx, planned, now);
  if ((local.kind === 'planned' && local.score < RIDE.rivalS) || local.kind === 'unsure') { seen = null; if (offer) hideNote(); return; }
  if (!offer) lookAround(win); // (its answer counts from the next fix on)
  // the trips around you, not the planned ones (but the first trip of a planned ride, all of it: you may have stayed
  // on past your stop)
  const firstKeys = new Set(planned.map((c) => c.key));
  const legKeys = new Set(journey.conn.parts.filter(isRide).flatMap((s) => s.legs.map(tripKey)));
  const others = near.req === journey.req ? near.cands.filter((c) => !legKeys.has(c.key) || firstKeys.has(c.key)) : [];
  const d: RideDecision = near.crowded && near.req === journey.req ? { kind: 'unsure' } : decide(fx, [...planned, ...others], now);
  // (a vehicle found that you said no to, or that has no journey worth taking, is no reason to keep looking often)
  if (d.kind === 'unsure' || (d.kind === 'ride' && !dismissed.has(d.cand.key) && !((failed.get(d.cand.key) || 0) > Date.now()))) near.hit = true;
  const c = confirm(seen, d, at + off);
  seen = c.seen;
  if (d.kind === 'ride') named = { key: d.cand.key, at: Date.now() };
  if (offer && d.kind === 'ride' && d.cand.key === offer.key) { offer.match = d.match; offer.heldAt = Date.now(); }
  if (!c.sure || d.kind !== 'ride' || offer || planning || accepting) return;
  const key = d.cand.key, had = trips.get(key);
  if (dismissed.has(key) || (failed.get(key) || 0) > Date.now() || !had) return;
  // a planned trip, all of it: only once past the stop the plan gets off at (before that, following the trip has you)
  const mine = journey.conn.parts.filter(isRide).find((s) => tripKey(s.legs[0]) === key);
  if (mine && d.match.lastSeq < mine.legs[0].to.seq) return;
  propose(had.trip, had.at, d.match);
}

// The journey from on board: asked of the engine, offered when it is a sensible way there
async function propose(trip: KanteTrip, tripAt: number, m: RideMatch) {
  const key = tripKey(trip), req = journey.req, dest = journey.dest!;
  planning = true;
  let opts: JourneyOptions | null = null;
  try { opts = await KanteJourney.onboard(trip, tripAt, m.lastSeq, m.nextSeq, dest, (Date.now() + clockOffset) / 1000); } catch (e) { opts = null; }
  planning = false;
  if (req !== journey.req || dest !== journey.dest || !following()) return;
  if (!opts || !sensible(opts.best, m, key)) { failed.set(key, Date.now() + 120000); return; }
  // (moved on meanwhile: off it, or not seen on it for a while)
  if (!seen || seen.key !== key || dismissed.has(key) || !named || named.key !== key || Date.now() - named.at > 20000) return;
  offer = { key, trip, tripAt, req, dest, match: m, heldAt: Date.now(), opts };
  showNote(offer);
}
/**
 * A sensible way there from on board: it gets there no more than half an hour after the journey on show would (or
 * after now, when that one can no longer be made), and it does not have you get off at the next stop only to ride
 * back past where you were (the vehicle goes the wrong way; a change at the next stop onto a train that goes on
 * elsewhere is fine).
 */
function sensible(j: Journey, m: RideMatch, key: string) {
  if (j.arr * 1000 > Math.max(journeyEnd(), Date.now()) + 30 * 60000) return false;
  const rides = j.parts.filter(isRide), first = rides[0];
  if (!first) return false;
  // (staying on a planned trip past its stop: getting off and going back is just what to do)
  if (journey.conn!.parts.filter(isRide).some((s) => s.legs.some((l) => tripKey(l) === key))) return true;
  const ll = (c: KanteStopCall): LngLat => [c.quay.lon, c.quay.lat], was = ll(first.from), leg = first.legs[0];
  const back = rides.length > 1 && first.legs.length === 1 && (m.nextSeq == null || leg.to.seq <= m.nextSeq)
    && rides[1].stops.some((c) => metres(ll(c), was) < 200);
  return !back;
}

// ---------------------------------------------------------------- the notice

let note: HTMLElement | null = null, noteTimer = 0;
let noteParts: { title: HTMLElement; body: HTMLElement; go: HTMLButtonElement } | null = null;
function noteEl() {
  if (note) return note;
  const go = h('button', 'pace-note-go', 'Update route');
  go.type = 'button';
  const x = h('button', 'pace-note-x');
  x.type = 'button';
  x.setAttribute('aria-label', 'No, keep the route');
  x.innerHTML = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M2.5 2.5l9 9M11.5 2.5l-9 9" /></svg>';
  const ic = h('span', 'set-ic', kIcon('refresh', 20));
  ic.style.setProperty('--c', 'var(--user-blue)');
  ic.setAttribute('aria-hidden', 'true');
  noteParts = { title: h('b'), body: h('span'), go };
  note = h('div', 'pace-note ride-note', ic, h('div', 'pace-note-text', noteParts.title, noteParts.body, go), x);
  note.setAttribute('role', 'status');
  note.hidden = true;
  go.addEventListener('click', accept);
  x.addEventListener('click', () => { if (offer) dismissed.add(offer.key); hideNote(); });
  document.body.appendChild(note);
  return note;
}
/** What the notice says: on which vehicle you seem to be, and what updating does (new times, or a new route). */
function wording(o: RideOffer): { title: (string | HTMLElement)[]; body: string; go: string } {
  const j = o.opts.best, now = Date.now(), r0 = j.parts.find(isRide);
  const line = r0 ? r0.line : KANTE_LIVE.journeyLike(o.trip.line), mode = MODE_NAME[modeOf(line.category)] || 'Vehicle', badge = kBadge(line);
  const arr = j.arr * 1000, dt = Math.round((arr - journeyEnd()) / 60000);
  const when = `Arrive ${fmtTime(arr)}${dt >= 1 ? ` (${dt} min later)` : dt <= -1 ? ` (${-dt} min earlier)` : ''}`;
  const rides = (parts: (JourneyRide | KanteWalkLeg)[]) => parts.filter(isRide).filter((s) => (liveMs(s.to, 'arr') || 0) > now - 60000)
    .map((s) => `${lineKey(s.legs[0].line)}>${s.to.quay.stationId}`).join(' ');
  const legKeys = new Set(journey.conn!.parts.filter(isRide).flatMap((s) => s.legs.map(tripKey)));
  if (legKeys.has(o.key)) return { title: ['Still on ', badge, '?'], body: `Update the route from here? ${when}`, go: 'Update route' };
  // the same line, to the same stop, and the rest as planned: only the times change
  const mine = journey.conn!.parts.filter(isRide).find((s) => (liveMs(s.to, 'arr') || 0) > now - 60000);
  if (mine && rides(j.parts) === rides(journey.conn!.parts) && lineKey(mine.legs[0].line) === lineKey(o.trip.line)) {
    // earlier or later: both runs' departures from the station the plan boards at (else neither is said)
    const at = o.trip.calls.find((c) => c.quay.stationId === mine.from.quay.stationId);
    const dep = at && KANTE_LIVE.liveDep(at), planDep = liveMs(mine.from, 'dep');
    const which = dep == null || planDep == null || Math.abs(dep * 1000 - planDep) < 30000 ? 'another' : dep * 1000 > planDep ? 'a later' : 'an earlier';
    return { title: [`Looks like you're on ${which} `, badge], body: `Update the times? ${when}`, go: 'Update times' };
  }
  return { title: [`Looks like you're on ${mode === 'Train' ? '' : mode.toLowerCase() + ' '}`, badge, o.trip.headsign ? ` to ${o.trip.headsign}` : ''],
    body: `Update the route? ${when}`, go: 'Update route' };
}
function showNote(o: RideOffer) {
  const el = noteEl(), w = wording(o), p = noteParts!;
  p.title.replaceChildren(...w.title);
  p.body.textContent = w.body;
  p.go.textContent = w.go;
  el.hidden = false;
  document.body.classList.add('ride-note-on');
  document.body.style.setProperty('--ride-note-h', el.offsetHeight + 'px');
  // it goes by itself (not as a no) when the journey changes, or the vehicle has not been seen to fit for a minute
  clearInterval(noteTimer);
  noteTimer = setInterval(() => {
    if (!offer || offer.req !== journey.req || !journey.conn || Date.now() - offer.heldAt > 60000) hideNote();
  }, 5000);
}
function hideNote() {
  offer = null;
  clearInterval(noteTimer);
  if (!note) return;
  note.hidden = true;
  document.body.classList.remove('ride-note-on');
}
// "Update route": asked again (where you are now, the trip's newest times), then shown
async function accept() {
  const o = offer;
  hideNote();
  if (!o || o.req !== journey.req || o.dest !== journey.dest || !KANTE || accepting) return;
  accepting = true;
  seen = null;
  let opts: JourneyOptions | null = null, down = false, trip = o.trip;
  try {
    let at = o.tripAt;
    const fresh = await KANTE.trip(trip.tripId, trip.serviceDate).catch(() => null);
    if (fresh) { trip = fresh; at = Date.now(); trips.set(o.key, { trip, at }); }
    try { opts = await KanteJourney.onboard(trip, at, o.match.lastSeq, o.match.nextSeq, o.dest, (Date.now() + clockOffset) / 1000); }
    catch (e) { down = true; }
  } finally { accepting = false; }
  if (o.req !== journey.req || o.dest !== journey.dest || !following()) return;
  if (!opts || !sensible(opts.best, o.match, o.key)) {
    const r0 = opts && opts.best.parts.find(isRide);
    showToast(down ? 'The Kante engine isn’t answering: route not changed'
      : `${lineLabel(r0 ? r0.line : KANTE_LIVE.journeyLike(trip.line))} no longer gets you there in time: route not changed`, 5000);
    return;
  }
  // shown as a journey picked from the list is (sheet-content.ts showOption())
  const id = ++journey.req;
  journey.options = opts;
  journey.tab = 'pt';
  journey.list = false;
  journey.more = null;
  journey.query = { mode: 'dep', date: '', time: '' };
  openDirs.clear();
  openStops.clear();
  renderJourney(opts.best, o.dest.title);
  refineJourney(id);
  livePoll();
  showToast('Route updated', 3000);
}
