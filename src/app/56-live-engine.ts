// ---- Live data from the Kante engine (kante/docs/LIVE-API.md). Every ride of the journey knows its trips (the
//      engine planned it), so each one is asked of /api/trip every 30 s while the trip is on: measured and forecast
//      times, platform changes, cancellations, and where the vehicle is. Without the engine nothing here runs. ----
let kanteRetryTimer: number | null = null;
// /api/meta: an engine that can't be reached when the page loads is asked again every 30 s (and when the tab
// comes back), so it is not off for the rest of the visit
function kanteConnect(force?: boolean) {
  if (!KANTE || !KANTE.base) return;
  clearTimeout(kanteRetryTimer);
  KANTE.ready(force).then((m) => {
    if (m) { vehUpdate(); if (journeyConn) livePoll(); return; }
    clearTimeout(kanteRetryTimer);
    if (!document.hidden) kanteRetryTimer = setTimeout(kanteConnect, KANTE!.RETRY_MS + 500);
  });
}
kanteConnect();
// The engine's answer for trip n of a ride, while it is recent (100 s) and (unless anyState) has live data
function rideTrip(s: JourneyRide | null | undefined, n: number, anyState?: boolean) {
  const k = s && s.live[n];
  if (!k || !k.trip || Date.now() - k.at > 100000) return null;
  return anyState || KANTE_LIVE.isLive(KANTE_LIVE.liveInfoOf(k.trip)) ? k.trip : null;
}
// Fresh live data for every ride still to come or under way
async function livePoll() {
  if (!journeyConn || document.hidden || !tripLive() || !KANTE || !KANTE.base) return;
  const id = journeyReq, now = Date.now();
  // rides already behind you keep their last answer
  const rides = journeyConn.parts.filter(isRide).filter((s) => (liveMs(s.to, 'arr') || 0) > now - 120000);
  const todo = rides.flatMap((s) => s.legs.map((leg, n) => ({ s, leg, n }))).filter(({ s, n }) => !s.live[n].busy);
  if (!todo.length) return;
  const before = liveSig();
  await Promise.all(todo.map(async ({ s, leg, n }) => {
    const k = s.live[n];
    k.busy = true; // one request per trip at a time
    let trip: KanteTrip | null = null;
    try { trip = await KANTE!.trip(leg.tripId, leg.serviceDate); } catch (e) { trip = null; }
    k.busy = false;
    if (id !== journeyReq) return;
    if (!trip) { k.fails++; return; }
    Object.assign(k, { trip, at: Date.now(), fails: 0 });
    KanteJourney.applyTrip(s, n, trip); // its live times and boarding points, into the ride's stops
  }));
  if (id === journeyReq) liveUpdated(before);
}
const liveSig = () => journeyConn!.parts.filter(isRide)
  .map((s) => [liveMs(s.from, 'dep'), liveMs(s.to, 'arr'), platformOf(s.from), platformOf(s.to), s.from.quay.id, s.to.quay.id].join()).join(';');
// New live times are in: time the trip again; a changed platform also moves the boarding point and its walk
let platKey = '';
const platSig = () => journeyConn!.parts.filter(isRide).map((s) => [platformOf(s.from), platformOf(s.to)].join()).join(';');
function liveUpdated(before: string) {
  if (!journeyConn || liveSig() === before) return;
  // the engine names the boarding points itself: move the rides' ends (and the walks to them) there
  const id = journeyReq;
  const moved = () => {
    if (id !== journeyReq) return;
    syncEnds(journeySteps);
    refineWalks(id, true); // the moved walks again on the network (older answers are dropped by their revision)
    geoVersion++; routeKey = ''; queueSheet(); updateProgress();
  };
  KanteJourney.requay(journeySteps, moved);
  // a platform named anew where the engine's boarding point stays: its walks again too (to the platform by name)
  if (platSig() !== platKey) { platKey = platSig(); moved(); }
  applyLiveTimes(journeySteps);
  renderSheet();
  updatePillTimes();
  updateProgress();
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && KANTE && !KANTE.ok()) kanteConnect(true); // the engine was unreachable: ask again now
  vehUpdate();
  if (document.hidden || !journeyConn) return;
  livePoll();
  updateProgress();
});
