// ---- What the buttons do ----
// The whole journey again
import { map } from './map.ts';
import { showToast } from '../toast.ts';
import { gpsOn, onPosition, onPositionError } from './location.ts';
import { setFollowing } from './trip-ends.ts';
import { refreshRouteHighlight } from './journey-map.ts';
import { fmtTime, journeyEnd, lineLabel, stopName, stopUic } from './journey-steps.ts';
import { journeyProgress } from './tracking.ts';
import { h, kIcon, setDetent, sheetDetent } from './sheet.ts';
import { renderSheet, walkDirections } from './sheet-content.ts';
import { fitCoords, fitJourney, goToStep, mapPadding } from './pill.ts';
import { lengthKm } from './routing.ts';
import { journey, sheet, tracking } from './state.ts';
import type { TimedPlace } from './tracking.ts';
export function overview() {
  sheet.focus = null;
  journey.overview = true;
  refreshRouteHighlight();
  fitJourney();
  renderSheet();
}
// One walking direction on the map, close up
export function focusDir(i: number, k: number) {
  const st = journey.steps[i], d = st && walkDirections(st)[k];
  if (!d) return;
  sheet.focus = { step: i, dir: k };
  journey.step = i;
  journey.overview = false;
  tracking.userPickedAt = Date.now();
  refreshRouteHighlight();
  const cs = (d.coords || []).filter(Boolean);
  if (cs.length > 1 && lengthKm(cs) > 0.03) fitCoords(cs, 18.5);
  else if (cs.length) map.flyTo({ center: cs[Math.floor((cs.length - 1) / 2)], zoom: 18.5, padding: mapPadding(), duration: 700 });
  if (sheetDetent === 'full') setDetent('mid');
  renderSheet();
}
// A boarding point close up
export function showQuay(i: number) {
  const r = journey.steps[i];
  if (!r) return;
  sheet.focus = null;
  journey.step = i;
  journey.overview = false;
  tracking.userPickedAt = Date.now();
  refreshRouteHighlight();
  if (r.depLL) map.flyTo({ center: r.depLL, zoom: 18.5, padding: mapPadding(), duration: 700 });
  if (sheetDetent === 'full') setDetent('mid');
  renderSheet();
}
// Start: the sheet steps aside and the map shows where you are on the trip (GPS moves it along from there)
export function startFollowing() {
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
export function swissTicketTime(departure: string | number) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(departure)).map((p) => [p.type, p.value]));
}
const sbbStopId = (id: string | null | undefined) => /^0?(\d{7})$/.exec(String(id || ''))?.[1];
function sbbTicketUrl() {
  const rides = journey.steps.filter((st) => st.type === 'ride');
  if (!rides.length) return null;
  const a = rides[0].s.from, b = rides[rides.length - 1].s.to;
  if (!sbbStopId(stopUic(a)) || !sbbStopId(stopUic(b)) || a.dep == null) return null;
  const stop = (c: KanteStopCall) => `${stopName(c).replace(/[_~]/g, ' ')}_I${sbbStopId(stopUic(c))}`;
  const parts = swissTicketTime(a.dep * 1000);
  const q = new URLSearchParams({
    stops: `${stop(a)}~${stop(b)}`,
    day: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}_${parts.minute}`,
    moment: 'dep',
    trip: '0_0',
  });
  return `https://www.sbb.ch/en/offer?${q}`;
}
export function ticketLink() {
  const url = sbbTicketUrl();
  if (!url) return null; // nothing to buy: a walk only, or a stop without an id
  const a = h('a', 'pill-btn ticket', kIcon('ticket', 18), h('span', 'tk-long', 'Get ticket'), h('span', 'tk-short', 'Ticket'));
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.setAttribute('aria-label', 'Get a ticket for this journey on sbb.ch');
  return a;
}
export async function shareJourney() {
  const title = `${journey.from} to ${journey.dest ? journey.dest.title : 'destination'}`;
  const lines = journey.steps.filter((st) => st.type === 'ride').map((st) => lineLabel(st.s.line)).join(' → ');
  const text = `${title}: ${fmtTime(journey.conn!.t0)} – ${fmtTime(journeyEnd())}${lines ? ` (${lines})` : ''}`;
  const url = location.origin + location.pathname;
  try {
    if (navigator.share) await navigator.share({ title, text, url });
    else { await navigator.clipboard.writeText(`${text}\n${url}`); showToast('Journey copied'); }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') showToast('Couldn\'t share the journey');
  }
}
