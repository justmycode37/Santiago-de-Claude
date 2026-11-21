// ---- The live line in the sheet's header: "120 m to Platform 7 · S1 in 4 min", "On 10 · 3 stops to Bern" ----
function boardName(r: JourneyRideStep) {
  const raw = platformOf(r.s.departure), edge = r.depAt && r.depAt.edge;
  const num = splitPlatform(raw === '–' ? '' : raw).num || (edge && edge.ref) || '';
  return num ? `${platformWord(r.s.journey)} ${num}` : r.s.departure.station!.name;
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
  return journeySteps.find((st, i) => {
    if (st.type !== 'change' || i < from) return false;
    const arr = liveMs(st.prev.arrival, 'arrival'), dep = liveMs(st.next.departure, 'departure');
    const live = (st.prev.arrival.prognosis && st.prev.arrival.prognosis.arrival) || (st.next.departure.prognosis && st.next.departure.prognosis.departure);
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
function liveParts(now: number): LiveLine | null {
  const t = track && gpsOn() ? track : null;
  if (t && t.off) return { kind: 'off', parts: [`Off the route · ${fmtDist(t.d)} away`], replan: true };
  if (t && t.missed) {
    const r = t.missed;
    return { kind: 'off', parts: ['Missed ', kBadge(r.s.journey), `? It left at ${fmtTime(r.t0)}`], replan: true };
  }
  const cancelled = journeySteps.find((st) => st.type === 'ride' && engineFresh(st.s, true) && st.s._k!.trip!.cancelled && (!t || journeySteps.indexOf(st) >= t.i) && now < st.t1!) as JourneyRideStep | undefined;
  if (cancelled) return { kind: 'off', parts: [kBadge(cancelled.s.journey), ' is cancelled'], replan: true };
  // GPS on a walk or change: run or wait decides it, not the timetable's walking time
  const walking = t && !t.arrived && journeySteps[t.i].type !== 'ride' && !journeySteps[t.i].final;
  const broken = brokenChange(now, t ? t.i + (walking ? 1 : 0) : 0);
  if (broken) {
    return { kind: 'off', replan: true, parts: [`Not enough time to change at ${broken.next.departure.station!.name} · `, kBadge(broken.next.journey), ` leaves ${fmtTime(liveMs(broken.next.departure, 'departure'))}`] };
  }
  if (t) {
    const st = journeySteps[t.i], lay = tripLayout(), left = Math.max(0, lay.lens[t.i] - t.kmIn) * 1000;
    if (t.arrived) return { kind: 'gps', parts: ['You have arrived'] };
    if (st.type === 'ride') {
      const j = st.s.journey;
      if (now < st.t0! && t.kmIn < 0.05) {
        return { kind: 'gps', parts: [`At ${boardName(st)} · `, kBadge(j), ` ${leaves(st.t0!, now)}`, lateTag(lateMin(st.s.departure, 'departure')), platChange(st)] };
      }
      const n = stopKms(st).filter((k) => k > t.kmIn + 0.03).length;
      const to = st.s.arrival.station!.name;
      return { kind: 'gps', parts: ['On ', kBadge(j), n > 1 ? ` · ${n} stops to ${to}` : ` · get off at ${to}`, lateTag(lateMin(st.s.arrival, 'arrival'))] };
    }
    const r = st.nextRide;
    if (st.final || !r) return { kind: 'gps', parts: [`${fmtDist(left)} to ${st.toName || 'your destination'}`] };
    // the stop's name is the timeline's first item; a platform number is new
    const board = boardName(r), named = board !== r.s.departure.station!.name;
    const where = left < 30 ? `At ${board} ·` : named ? `${fmtDist(left)} to ${board} ·` : `${fmtDist(left)} ·`;
    const hr = left >= 30 ? hurry(left, r, now) : null;
    return { kind: 'gps', rest: hr ? hr.text : '', restLevel: hr && hr.level,
      parts: [h('span', 'live-lead', where, kBadge(r.s.journey)), ` ${leaves(r.t0!, now)}`, lateTag(lateMin(r.s.departure, 'departure')), platChange(r)] };
  }
  // no GPS: from the live timetable
  const ride = journeySteps.find((st): st is JourneyRideStep => st.type === 'ride' && st.t0 != null && now >= st.t0 && now <= st.t1!);
  if (ride) {
    const v = vehicleState(ride, now);
    const where = !v ? '' : v.at ? ` at ${v.at}` : ` between ${v.from} and ${v.to}`;
    return { kind: 'est', parts: [kBadge(ride.s.journey), where || ' under way', lateTag(lateMin(ride.s.arrival, 'arrival'))] };
  }
  const r = journeySteps.find((st): st is JourneyRideStep => st.type === 'ride' && st.t0 != null && st.t0 > now);
  if (r && r.t0! - now < 3600000) {
    return { kind: 'est', parts: [kBadge(r.s.journey), ` leaves ${boardName(r)} ${leaves(r.t0!, now)}`, lateTag(lateMin(r.s.departure, 'departure')), platChange(r)] };
  }
  return null;
}
function renderLive() { renderHead(); }
function replan() {
  if (!journeyDest) return;
  journeyQuery = { mode: 'dep', date: '', time: '' };
  startJourney(journeyDest, true);
}

let progressQueued = false;
function scheduleProgress() {
  if (progressQueued) return;
  progressQueued = true;
  requestAnimationFrame(() => { progressQueued = false; updateProgress(); });
}
let routeKey = '';
function redrawRoute(force?: boolean) {
  const p = journeyProgress();
  const key = p ? `${p.i}|${Math.round(p.kmIn * 200)}` : '-'; // redraw every 5 m
  if (!force && key === routeKey) return;
  routeKey = key;
  setRoute(stepFeatures(journeySteps));
}
