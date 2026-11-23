// ---- The live line in the sheet's header: "120 m to Platform 7 · S1 in 4 min", "On 10 · 3 stops to Bern" ----
import { gpsOn } from './location.ts';
import { setRoute } from './journey-map.ts';
import { fmtTime, hasForecast, lateMin, liveMs, stepFeatures, stopName } from './journey-steps.ts';
import { journeyProgress, stopKms, tripLayout, vehicleState } from './tracking.ts';
import { rideTrip } from './live-engine.ts';
import { fmtDist, platformOf, platformWord, splitPlatform } from './live-vehicles.ts';
import { h, kBadge, kDelay, quayOf } from './sheet.ts';
import { renderHead } from './sheet-content.ts';
import { startJourney, updateProgress } from './pill.ts';
import { journey, tracking } from './state.ts';
import { KANTE_LIVE } from '../live.ts';
import { SETTINGS } from '../settings.ts';
import type { KanteRunOrWait } from '../live.ts';
import type { JourneyChangeStep, JourneyRideStep } from './journey-steps.ts';

// ---------------------------------------------------------------- the live line in the sheet's header

/** One piece of the live line: text, or an element (a line badge, a delay, a platform change); null is skipped. */
export type LiveLinePart = string | HTMLElement | null;
/** liveParts(): the live line. */
export interface LiveLine {
  /** off: something is wrong (off the route, a ride missed or cancelled); gps: from your position; est: from the live timetable. */
  kind: 'off' | 'gps' | 'est';
  parts: LiveLinePart[];
  /** Offer "Replan". */
  replan?: boolean;
  /** The second half: what is left of the trip, or whether to hurry. */
  rest?: string;
  restLevel?: KanteRunOrWait['level'] | null;
}

function boardName(r: JourneyRideStep) {
  const raw = platformOf(r.s.from), edge = r.depAt && r.depAt.edge;
  const num = splitPlatform(raw === '–' ? '' : raw).num || (edge && edge.ref) || '';
  return num ? `${platformWord(r.s.line)} ${num}` : stopName(r.s.from);
}
const leaves = (t: number, now: number) => {
  const m = Math.round((t - now) / 60000);
  return m > 0 ? `in ${m} min` : m === 0 ? 'leaving now' : `left ${-m} min ago`;
};
const lateTag = (m: number) => (m > 0 ? kDelay(m) : '');
// "Platform 7 → 5" when a ride leaves from another platform than planned
function platChange(r: JourneyRideStep | null | undefined) {
  const q = r && quayOf(r, 'dep');
  return q && q.planned ? h('b', 'plat-move', ` · ${q.word} ${q.planned} → ${q.label}`) : null;
}
// A change ahead that live times make impossible: the next ride leaves before you can walk there
function brokenChange(now: number, from: number) {
  return journey.steps.find((st, i) => {
    if (st.type !== 'change' || i < from) return false;
    const arr = liveMs(st.prev.to, 'arr'), dep = liveMs(st.next.from, 'dep');
    const live = hasForecast(st.prev.to, 'arr') || hasForecast(st.next.from, 'dep');
    return live && arr != null && dep != null && now < dep && dep - arr < (st.walkMin || 0) * 60000;
  }) as JourneyChangeStep | undefined;
}
// Walking to a ride with GPS: is there time to spare, at your walking speed (Settings), for the metres left?
function hurry(left: number, r: JourneyRideStep, now: number) {
  const leftS = (r.t0! - now) / 1000;
  if (!(leftS > -30) || leftS > 20 * 60) return null;
  const kmh = (SETTINGS.prefs && SETTINGS.prefs().walkKmh) || 4.7;
  return KANTE_LIVE.runOrWait(leftS, left / (kmh / 3.6));
}
export function liveParts(now: number): LiveLine | null {
  const t = tracking.track && gpsOn() ? tracking.track : null;
  if (t && t.off) return { kind: 'off', parts: [`Off the route · ${fmtDist(t.d)} away`], replan: true };
  if (t && t.missed) {
    const r = t.missed;
    return { kind: 'off', parts: ['Missed ', kBadge(r.s.line), `? It left at ${fmtTime(r.t0)}`], replan: true };
  }
  const cancelled = journey.steps.find((st) => st.type === 'ride' && st.s.legs.some((_, n) => rideTrip(st.s, n, true)?.cancelled)
    && (!t || journey.steps.indexOf(st) >= t.i) && now < st.t1!) as JourneyRideStep | undefined;
  if (cancelled) return { kind: 'off', parts: [kBadge(cancelled.s.line), ' is cancelled'], replan: true };
  // GPS on a walk or change: run or wait decides it, not the timetable's walking time
  const walking = t && !t.arrived && journey.steps[t.i].type !== 'ride' && !journey.steps[t.i].final;
  const broken = brokenChange(now, t ? t.i + (walking ? 1 : 0) : 0);
  if (broken) {
    return { kind: 'off', replan: true, parts: [`Not enough time to change at ${stopName(broken.next.from)} · `, kBadge(broken.next.line), ` leaves ${fmtTime(liveMs(broken.next.from, 'dep'))}`] };
  }
  if (t) {
    const st = journey.steps[t.i], lay = tripLayout(), left = Math.max(0, lay.lens[t.i] - t.kmIn) * 1000; // from where you are (on a guessed stretch too)
    if (t.arrived) return { kind: 'gps', parts: ['You have arrived'] };
    if (st.type === 'ride') {
      const j = st.s.line;
      if (now < st.t0! && t.kmIn < 0.05) {
        return { kind: 'gps', parts: [`At ${boardName(st)} · `, kBadge(j), ` ${leaves(st.t0!, now)}`, lateTag(lateMin(st.s.from, 'dep')), platChange(st)] };
      }
      const n = stopKms(st).filter((k) => k > t.kmIn + 0.03).length;
      const to = stopName(st.s.to);
      return { kind: 'gps', parts: ['On ', kBadge(j), n > 1 ? ` · ${n} stops to ${to}` : ` · get off at ${to}`, lateTag(lateMin(st.s.to, 'arr'))] };
    }
    const r = st.nextRide;
    if (st.final || !r) return { kind: 'gps', parts: [`${fmtDist(left)} to ${st.toName || 'your destination'}`] };
    const board = boardName(r);
    const where = left < 30 ? `At ${board} ·` : `${fmtDist(left)} to ${board} ·`;
    const hr = left >= 30 ? hurry(left, r, now) : null;
    return { kind: 'gps', rest: hr ? hr.text : '', restLevel: hr && hr.level,
      parts: [h('span', 'live-lead', where, kBadge(r.s.line)), ` ${leaves(r.t0!, now)}`, lateTag(lateMin(r.s.from, 'dep')), platChange(r)] };
  }
  // no GPS: from the live timetable
  const ride = journey.steps.find((st): st is JourneyRideStep => st.type === 'ride' && st.t0 != null && now >= st.t0 && now <= st.t1!);
  if (ride) {
    const v = vehicleState(ride, now);
    const where = !v ? '' : v.at ? ` at ${v.at}` : ` between ${v.from} and ${v.to}`;
    return { kind: 'est', parts: [kBadge(ride.s.line), where || ' under way', lateTag(lateMin(ride.s.to, 'arr'))] };
  }
  const r = journey.steps.find((st): st is JourneyRideStep => st.type === 'ride' && st.t0 != null && st.t0 > now);
  if (r && r.t0! - now < 3600000) {
    return { kind: 'est', parts: [kBadge(r.s.line), ` leaves ${boardName(r)} ${leaves(r.t0!, now)}`, lateTag(lateMin(r.s.from, 'dep')), platChange(r)] };
  }
  return null;
}
export function renderLive() { renderHead(); }
export function replan() {
  if (!journey.dest) return;
  journey.query = { mode: 'dep', date: '', time: '' };
  startJourney(journey.dest, true);
}

let progressQueued = false;
export function scheduleProgress() {
  if (progressQueued) return;
  progressQueued = true;
  requestAnimationFrame(() => { progressQueued = false; updateProgress(); });
}
export function redrawRoute(force?: boolean) {
  const p = journeyProgress();
  const key = p ? `${p.i}|${Math.round((p.walkedKmIn != null ? p.walkedKmIn : p.kmIn) * 200)}` : '-'; // redraw every 5 m drawn as walked
  if (!force && key === journey.routeKey) return;
  journey.routeKey = key;
  setRoute(stepFeatures(journey.steps));
}
