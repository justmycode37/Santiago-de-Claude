// ---- What the buttons do ----
// The whole journey again
function overview() {
  jFocus = null;
  routeOverview = true;
  refreshRouteHighlight();
  fitJourney();
  renderSheet();
}
// One walking direction on the map, close up
function focusDir(i: number, k: number) {
  const st = journeySteps[i], d = st && walkDirections(st)[k];
  if (!d) return;
  jFocus = { step: i, dir: k };
  journeyStep = i;
  routeOverview = false;
  userPickedAt = Date.now();
  refreshRouteHighlight();
  const cs = (d.coords || []).filter(Boolean);
  if (cs.length > 1 && lengthKm(cs) > 0.03) fitCoords(cs, 18.5);
  else if (cs.length) map.flyTo({ center: cs[Math.floor((cs.length - 1) / 2)], zoom: 18.5, padding: mapPadding(), duration: 700 });
  if (sheetDetent === 'full') setDetent('mid');
  renderSheet();
}
// A boarding point close up
function showQuay(i: number) {
  const r = journeySteps[i];
  if (!r) return;
  jFocus = null;
  journeyStep = i;
  routeOverview = false;
  userPickedAt = Date.now();
  refreshRouteHighlight();
  if (r.depLL) map.flyTo({ center: r.depLL, zoom: 18.5, padding: mapPadding(), duration: 700 });
  if (sheetDetent === 'full') setDetent('mid');
  renderSheet();
}
// Start: the sheet steps aside and the map shows where you are on the trip (GPS moves it along from there)
function startFollowing() {
  setFollowing(true);
  if (!gpsOn() && window.isSecureContext && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(onPosition, onPositionError, { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
  }
  setDetent('low');
  const p = journeyProgress();
  goToStep(p && !(p as TimedPlace).ended ? p.i : 0, true);
}
// "Get ticket": SBB's ticket page for this exact connection, ready to buy. SBB's own link format (read from sbb.ch):
//   /en/offer?stops=Name_I<stop id>~Name_I<stop id>&day=YYYY-MM-DD&time=HH_mm&moment=dep&trip=0_0
// From the first stop you board to the last one you leave, at the first departure (Swiss time), so SBB's first
// connection (trip=0_0) is this one. The page preselects the cheapest ticket for it (a supersaver ticket where
// there is one) and starts with a Half Fare Travelcard, which the buyer can change there.
function sbbTicketUrl() {
  const rides = journeySteps.filter((st) => st.type === 'ride');
  if (!rides.length) return null;
  const a = rides[0].s.departure, b = rides[rides.length - 1].s.arrival;
  const sbbId = (st: OdLocation | null | undefined) => !!st && /^\d{7}$/.test(String(st.id || '')); // Swiss stop number (UIC), as sbb.ch knows it
  if (!sbbId(a.station) || !sbbId(b.station) || !a.departure) return null;
  const stop = (st: OdLocation) => `${(st.name || '').replace(/[_~]/g, ' ')}_I${st.id}`;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(a.departure)).map((p) => [p.type, p.value]));
  const q = new URLSearchParams({
    stops: `${stop(a.station!)}~${stop(b.station!)}`,
    day: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}_${parts.minute}`,
    moment: 'dep',
    trip: '0_0',
  });
  return `https://www.sbb.ch/en/offer?${q}`;
}
function ticketLink() {
  const url = sbbTicketUrl();
  if (!url) return null; // nothing to buy: a walk only, or a stop without an id
  const a = h('a', 'pill-btn ticket', kIcon('ticket', 18), h('span', 'tk-long', 'Get ticket'), h('span', 'tk-short', 'Ticket'));
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.setAttribute('aria-label', 'Get a ticket for this journey on sbb.ch');
  return a;
}
async function shareJourney() {
  const title = `${journeyFrom} to ${journeyDest ? journeyDest.title : 'destination'}`;
  const lines = journeySteps.filter((st) => st.type === 'ride').map((st) => lineLabel(st.s.journey)).join(' → ');
  const text = `${title}: ${fmtTime(journeyConn!.from.departure)} – ${fmtTime(journeyEnd())}${lines ? ` (${lines})` : ''}`;
  const url = location.origin + location.pathname;
  try {
    if (navigator.share) await navigator.share({ title, text, url });
    else { await navigator.clipboard.writeText(`${text}\n${url}`); showToast('Journey copied'); }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') showToast('Couldn\'t share the journey');
  }
}
