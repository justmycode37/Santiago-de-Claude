// ---- Live data from the Kante engine (live.js, kante/docs/LIVE-API.md). Each ride is matched to the engine's
//      trip once; while the trip is on, the engine's measured and forecast times replace the refetch above for
//      that ride, and its position places the vehicle. Without the engine (or a feature), nothing here runs. ----
const kante = KANTE_LIVE.client(location.search, window.APP_CONFIG);
// Settings › Live data names the server your position would go to
const shareHost = document.getElementById('setShareHost');
if (shareHost) shareHost.textContent = kante.url ? new URL(kante.url).host : 'none (live data is switched off)';
if (kante.ignored) console.warn('Kante engine: ?kante= only accepts an engine on this machine; ignored', kante.ignored);
let kanteTimer: number | null = null, kanteRetryTimer: number | null = null;
// /api/meta: an engine that can't be reached when the page loads is asked again every 30 s (and when the tab
// comes back), so it is not off for the rest of the visit
function kanteConnect(force?: boolean) {
  if (!kante.url) return;
  clearTimeout(kanteRetryTimer);
  kante.ready(force).then((m) => {
    if (m) { vehUpdate(); if (journeyConn) kantePoll(); return; }
    clearTimeout(kanteRetryTimer);
    if (!document.hidden) kanteRetryTimer = setTimeout(kanteConnect, KANTE_LIVE.RETRY_MS + 500);
  });
}
kanteConnect();
// The engine's answer for a ride is recent (and, unless anyState, has live data): then it is the ride's source
function engineFresh(s: OdSection | null | undefined, anyState?: boolean) {
  const k = s && s._k;
  if (!k || k.state !== 'ok' || !k.trip || Date.now() - k.at > 100000) return false;
  return anyState || KANTE_LIVE.isLive(KANTE_LIVE.liveInfoOf(k.trip));
}
// Rides still to be matched: never asked, or the engine could not be reached (again after 25 s, 3 tries at most)
const needsMatch = (s: OdSection) => s.journey && (!s._k || (s._k.state === 'error' && s._k.tries! < 3 && Date.now() - s._k.tried! > 25000));
async function kanteMatch(id: number) {
  await kante.ready();
  if (id !== journeyReq || !journeyConn) return;
  // rides planned elsewhere need /api/match; rides of an engine journey do not
  const rides = journeyConn.sections.filter((s) => needsMatch(s) && (kante.has('match') || (s.kanteLegs && s.kanteLegs.length)));
  if (!rides.length) return;
  await Promise.all(rides.map(async (s) => {
    // planned by the engine (engine-journey.js): the trip is known, nothing to match. A ride that stays seated
    // into another trip is a chain: engine-journey.js's own refresh follows each of its trips.
    if (s.kanteLegs && s.kanteLegs.length) {
      const legs = s.kanteLegs, leg = legs[0];
      s._k = legs.length > 1 || !leg.from || !leg.to ? { state: 'chain' } : { state: 'ok', at: 0,
        match: { tripId: leg.tripId, serviceDate: leg.serviceDate, fromSeq: leg.from.seq, toSeq: leg.to.seq } };
      return;
    }
    const k: KanteRideLink = (s._k = { state: 'matching', tries: ((s._k && s._k.tries) || 0) + 1, tried: Date.now() });
    const j = s.journey!;
    const r = await kante.get('/api/match', KANTE_LIVE.matchParams(s, lineLabel(j), modeOf(j.category) === 'train'));
    if (!r) k.state = 'error';
    // only a sure match: "ambiguous" or "none" leaves the ride with transport.opendata.ch's forecasts. A ride that
    // stays seated into the trip this one continues as ("then", no toSeq) would need every trip of the chain
    // polled: it keeps transport.opendata.ch's refetch too.
    else if (r.reason === 'unique' && r.match && r.match.tripId) {
      const chain = r.match.toSeq == null || (Array.isArray(r.match.then) && r.match.then.length > 0);
      Object.assign(k, { state: chain ? 'chain' : 'ok', match: r.match, at: 0 });
    } else k.state = 'none';
  }));
  if (id === journeyReq) kantePoll();
}
async function kantePoll() {
  if (!journeyConn || document.hidden || !tripLive()) return;
  const id = journeyReq, now = Date.now();
  if (journeyConn.sections.some(needsMatch)) kanteMatch(id); // the engine is back, or a match did not get through
  const rides = journeyConn.sections.filter((s) => s.journey && s._k && s._k.state === 'ok' && !s._k.busy
    && (liveMs(s.arrival, 'arrival') || 0) > now - 120000);
  if (!rides.length) return;
  const before = liveSig();
  let lost = false;
  await Promise.all(rides.map(async (s) => {
    const k = s._k as KanteRideMatched;
    k.busy = true; // one request per ride at a time
    const trip = await kante.get('/api/trip', { id: k.match.tripId, date: k.match.serviceDate });
    k.busy = false;
    if (id !== journeyReq) return;
    if (trip) {
      k.trip = trip;
      k.at = Date.now();
      k.fails = 0;
      k.seqIdx = KANTE_LIVE.seqIndex(KANTE_LIVE.alignCalls(trip, k.match, s.journey!.passList));
      // an engine journey keeps its stops in the engine's shape (stop.kante: boarding point, platform)
      if (s.kanteLegs) KanteJourney.applyTrip(s, trip);
      else KANTE_LIVE.applyTrip(s, trip, k.match);
    } else k.fails = (k.fails || 0) + 1;
    // no longer the ride's source (no answer for 100 s, or no live data any more): hand it back once
    if (engineFresh(s)) k.handedBack = false;
    else if (!k.handedBack) { k.handedBack = true; lost = true; }
  }));
  if (id !== journeyReq) return;
  liveUpdated(before);
  if (lost) refreshLive(); // the engine stopped answering for a ride (or has no live data any more): transport.opendata.ch's forecasts at once
}

// ---- On board (only with Settings › Live data › send my position switched on; off by default): every 20 s while
//      GPS shows you moving on a ride, ask the engine which vehicles you could be on. If it is clearly another one
//      twice in a row, the status line asks (never claims) and offers Replan. ----
let onboard: OnboardState | null = null; // { step, ours, byTrip, top, streak, at }
let onboardAt = 0, onboardBusy = false, observeAt = 0;
function movingNow() {
  const last = recentFixes[recentFixes.length - 1];
  if (!last || Date.now() - last.t > 15000) return false;
  if (last.speed != null && last.speed > 2) return true; // m/s: faster than walking
  const old = recentFixes.find((f) => f.t >= last.t - 40000);
  return !!old && last.t - old.t >= 10000 && distKm(old.ll, last.ll) * 1000 / ((last.t - old.t) / 1000) > 2;
}
// Only with Settings › Live data › share switched on (off by default): it sends your position to the engine.
async function kanteOnboard() {
  const t = track, now = Date.now();
  if (!SETTINGS.prefs().shareOnboard || !kante.ok() || !kante.trusted || onboardBusy || !t || !gpsOn() || now - onboardAt < 20000) return;
  const st = journeySteps[t.i];
  if (!st || st.type !== 'ride' || t.arrived || now < st.t0! - 60000 || !movingNow()) return;
  const id = journeyReq, k = st.s._k, j = st.s.journey, line = lineLabel(j);
  const mine = { tripId: k && k.state === 'ok' ? k.match.tripId : null, line, headsign: (k && k.trip && k.trip.headsign) || j.to };
  const at = { lat: KANTE_LIVE.roundLL(userLngLat![1]), lon: KANTE_LIVE.roundLL(userLngLat![0]) };
  onboardBusy = true;
  onboardAt = now;
  let v: KanteOnboardVerdict | null = null;
  try {
    const r = await kante.get('/api/onboard', { ...at, q: line.replace(/\s+/g, '') });
    if (r) v = KANTE_LIVE.onboardVerdict(r.candidates, mine);
    if (v && !v.ours) { // not among this line's vehicles: which one then?
      const all = await kante.get('/api/onboard', at);
      if (all) v = KANTE_LIVE.onboardVerdict(all.candidates, mine);
    }
  } finally {
    onboardBusy = false;
  }
  if (!v || id !== journeyReq) return;
  const same = onboard && onboard.step === t.i && v.top && onboard.top && onboard.top.tripId === v.top.tripId;
  onboard = { step: t.i, ours: v.ours, byTrip: v.byTrip, top: v.clear ? v.top : null, streak: v.clear ? (same ? onboard!.streak + 1 : 1) : 0, at: Date.now() };
  renderLive();
}
// On-board reports (Settings › Live data, off by default): only while you are on the planned, matched vehicle
// and the engine says it is among the ones you could be on, at most every 10 s. Nothing is sent otherwise.
function kanteObserve() {
  const now = Date.now(), t = track;
  if (!SETTINGS.prefs().shareOnboard || !kante.trusted || !kante.has('observe')) return;
  if (!onboard || !onboard.byTrip || now - onboard.at > 45000 || !t || t.off || t.arrived || t.i !== onboard.step) return;
  const st = journeySteps[t.i], k = st && st.s && st.s._k;
  if (!k || k.state !== 'ok' || !gpsOn() || fixAge() > 10000 || !(userAccuracy > 0 && userAccuracy <= 50) || now - observeAt < 10000) return;
  observeAt = now;
  kante.post('/api/observe', { tripId: k.match.tripId, serviceDate: k.match.serviceDate, lat: KANTE_LIVE.roundLL(userLngLat![1]),
    lon: KANTE_LIVE.roundLL(userLngLat![0]), t: Math.round(lastFixAt / 1000), accuracy: Math.round(userAccuracy) });
}
