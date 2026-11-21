// ---- Live timetable: fetch the same trip again for fresh forecasts (delays, platform changes) ----
const tripKey = (s: OdSection) => [s.journey!.name, s.journey!.category, s.journey!.number, s.departure.station!.id, new Date(s.departure.departure!).getTime()].join('|');
function mergeLive(old: OdSection, fresh: OdSection) {
  old._liveAt = Date.now();
  (['departure', 'arrival'] as const).forEach((k) => { old[k].prognosis = fresh[k].prognosis; old[k].delay = fresh[k].delay; });
  const byId = new Map((fresh.journey!.passList || []).map((x) => [x.station && x.station.id, x]));
  (old.journey!.passList || []).forEach((x) => {
    const f = x.station && byId.get(x.station.id);
    if (f) { x.prognosis = f.prognosis; x.delay = f.delay; }
  });
}
const liveSig = () => journeyConn!.sections.filter((s) => s.journey)
  .map((s) => [liveMs(s.departure, 'departure'), liveMs(s.arrival, 'arrival'), platformOf(s.departure), platformOf(s.arrival)].join()).join(';');
let liveBusy = false;
async function refreshLive() {
  if (!journeyConn || liveBusy || document.hidden || !tripLive()) return;
  const id = journeyReq, conn = journeyConn, now = Date.now();
  const rides = conn.sections.filter((s) => s.journey);
  // rides already behind you keep their last forecast; rides the Kante engine has live data for come from there
  // (for a journey planned by the engine any recent answer counts: it is the same trip engine-journey.js would ask for)
  let todo = rides.filter((s) => (liveMs(s.arrival, 'arrival') || 0) > now - 120000 && !engineFresh(s, !!conn.kante));
  if (!todo.length) return;
  liveBusy = true;
  const before = liveSig();
  try {
    // a journey from the Kante engine: its trips again from the engine (engine-journey.js)
    if (conn.kante) await KanteJourney.refresh(todo);
    // ask from the first ride still to come; if the answer goes another way, ask again from the next one missing
    for (let n = 0; n < 3 && todo.length && !conn.kante; n++) {
      const first = todo[0], last = rides[rides.length - 1], dep = new Date(first.departure.departure!);
      const params = new URLSearchParams({ from: first.departure.station!.id!, to: last.arrival.station!.id!,
        date: dateValue(dep), time: timeValue(dep), limit: '4' });
      SETTINGS.transportations().forEach((t) => params.append('transportations[]', t));
      const res = await fetch(`${OPENDATA}connections?` + params);
      const data: OdConnectionsResponse | null = res.ok ? await res.json() : null;
      if (id !== journeyReq) return;
      const found = new Map<string, OdSection>();
      ((data && data.connections) || []).forEach((c) => c.sections.forEach((s) => { if (s.journey) found.set(tripKey(s), s); }));
      todo.forEach((s) => { const f = found.get(tripKey(s)); if (f) mergeLive(s, f); });
      const missing = todo.filter((s) => !found.has(tripKey(s)));
      if (missing[0] === first) break; // even the first could not be found: try again next time
      todo = missing;
    }
  } catch (e) {
    return; // offline for a moment: keep the last forecast
  } finally {
    liveBusy = false;
  }
  if (id === journeyReq) liveUpdated(before);
}
// New live times are in: time the trip again; a changed platform also moves the boarding point and its walk
let platKey = '';
const platSig = () => journeyConn!.sections.filter((s) => s.journey).map((s) => [platformOf(s.departure), platformOf(s.arrival)].join()).join(';');
function liveUpdated(before: string) {
  if (!journeyConn || liveSig() === before) return;
  if (journeyConn.kante) {
    // a journey planned by the engine names its boarding points itself (engine-journey.js): move them there
    const id = journeyReq;
    KanteJourney.requay(journeySteps, () => {
      if (id !== journeyReq) return;
      syncEnds(journeySteps);
      refineWalks(id, true); // the moved walks again on the network (older answers are dropped by their revision)
      geoVersion++; routeKey = ''; queueSheet(); updateProgress();
    });
  } else if (platSig() !== platKey) {
    platKey = platSig();
    journeySteps = buildSteps(journeyConn, journeyDest ? journeyDest.title : '');
    geoVersion++;
    routeKey = '';
    refineJourney(journeyReq); // walks routed again to the new edge (the others come from the cache)
  }
  applyLiveTimes(journeySteps);
  renderSheet();
  updatePillTimes();
  updateProgress();
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !kante.ok()) kanteConnect(true); // the engine was unreachable: ask again now
  vehUpdate();
  if (document.hidden || !journeyConn) return;
  refreshLive();
  kantePoll();
  updateProgress();
});
