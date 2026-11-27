// ---- Top pill: the trip on one line, roughly to scale in time. Every ride is a solid line with its name above it;
//      walking, changing and waiting are rows of single dots (always at least a few, so a short change still shows).
//      The part already behind you fades. Tap to jump to that step. ----
import * as maplibregl from 'maplibre-gl';
import { map } from './map.ts';
import { updateCards } from './map-events.ts';
import { setMenu } from './menu.ts';
import { fixAge, onPosition, userLngLat } from './location.ts';
import { setPlanOpen, topUiBottom } from './trip-ends.ts';
import { engineFailure, engineMessage, startPlatforms } from './platforms.ts';
import { updatePlaces } from './map-places.ts';
import { refreshRouteHighlight, setRoute } from './journey-map.ts';
import { buildSteps, fmtTime, isRide, journeyEnd, journeyStart, lineLabel, liveMs, stepCoords } from './journey-steps.ts';
import { nowMarker, placeUserDot, progressTime, trackJourney, tripLive, updateNowMarker, vehMarker } from './tracking.ts';
import { redrawRoute, renderLive } from './live-line.ts';
import { checkRide } from './ride-switch.ts';
import { livePoll, platSig } from './live-engine.ts';
import { vehStop, vehUpdate } from './live-vehicles.ts';
import { openDirs, openSheet, openStops, placeSheet, setDetent, sheetDetent } from './sheet.ts';
import { optionCount, refreshList, renderSheet } from './sheet-content.ts';
import { updateWhenChip } from './time-picker.ts';
import { refineJourney } from './routing.ts';
import { journey, placeView, searchState, sheet, tracking } from './state.ts';
import { KanteJourney } from '../engine-journey.ts';
import { followCamOn, pauseFollowCam } from './follow-cam.ts';
import { closeLine, followsRide, stopFollowing, toggleRide, vehicleFollowing } from './vehicle-follow.ts';
import type { Journey, JourneyRide } from '../engine-journey.ts';
import type { JourneyDest, JourneyOrigin } from './state.ts';
const jBar = document.getElementById('jBar')!;
const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) => { const e = document.createElementNS(SVG_NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k] as string); return e; };
const BAR = { pad: 6, lineY: 26, textY: 14, dot: 8, ball: 2.5, node: 4.2, inset: 4 }; // ball: walking dots, node: ends of a ride
// → { segs: [{ kind, a, b, x0, x1, label }], t0, t1, W, x(t), tAt(px) }
/** A part of the bar: from when to when (ms), its least width, and (once laid out) its width and where it is, px. */
interface BarPart { a: number; b: number; min: number; w: number; x0: number; x1: number }
interface BarRide extends BarPart { kind: 'ride'; label: string; ride: JourneyRide }
interface BarGap extends BarPart { kind: 'gap' }
type BarSeg = BarRide | BarGap;
function barLayout() {
  const t0 = journeyStart(), t1 = Math.max(journey.conn!.t1, journeyEnd());
  const W = jBar.clientWidth, L = W - 2 * BAR.pad;
  const segs: BarSeg[] = [];
  let cursor = t0, rides = 0;
  journey.conn!.parts.filter(isRide).forEach((s) => {
    const a = Math.max(cursor, liveMs(s.from, 'dep')!), b = Math.max(a, liveMs(s.to, 'arr')!);
    if (a > cursor || rides) segs.push({ kind: 'gap', a: cursor, b: a, min: rides ? 28 : 17 } as BarGap); // a change, or the walk to the first stop
    segs.push({ kind: 'ride', a, b, min: 26, label: lineLabel(s.line), ride: s } as BarRide);
    cursor = b;
    rides++;
  });
  if (t1 > cursor || !rides) segs.push({ kind: 'gap', a: cursor, b: Math.max(cursor, t1), min: 17 } as BarGap);
  // widths in proportion to time, but never below each part's minimum
  let fixed = new Set<BarSeg>();
  for (let pass = 0; pass < 4; pass++) {
    const freeMs = segs.reduce((s, g) => s + (fixed.has(g) ? 0 : g.b - g.a), 0);
    const freePx = L - segs.reduce((s, g) => s + (fixed.has(g) ? g.min : 0), 0);
    segs.forEach((g) => { g.w = fixed.has(g) ? g.min : freeMs ? ((g.b - g.a) / freeMs) * freePx : freePx / segs.length; });
    const low = segs.filter((g) => !fixed.has(g) && g.w < g.min);
    if (!low.length) break;
    low.forEach((g) => fixed.add(g));
  }
  let px = BAR.pad;
  segs.forEach((g) => { g.x0 = px; px += Math.max(0, g.w); g.x1 = px; });
  const x = (t: number) => {
    if (t <= t0) return BAR.pad;
    const g = segs.find((s) => t <= s.b) || segs[segs.length - 1];
    return g.x0 + (g.x1 - g.x0) * (g.b > g.a ? Math.min(1, Math.max(0, (t - g.a) / (g.b - g.a))) : 1);
  };
  const tAt = (p: number) => {
    const g = segs.find((s) => p <= s.x1) || segs[segs.length - 1];
    return g.a + (g.b - g.a) * (g.x1 > g.x0 ? Math.min(1, Math.max(0, (p - g.x0) / (g.x1 - g.x0))) : 0);
  };
  return { segs, t0, t1, W, x, tAt };
}
function drawBarArt(g: SVGGElement, { segs }: { segs: BarSeg[] }) {
  const first = segs[0], last = segs[segs.length - 1];
  const dot = (cx: number, r: number) => g.appendChild(svgEl('circle', { cx, cy: BAR.lineY, r, fill: 'currentColor' }));
  segs.forEach((s) => {
    if (s.kind === 'ride') {
      // a big dot where the ride starts and where it ends, the line between them
      const xa = s === first ? s.x0 : s.x0 + BAR.inset, xb = Math.max(xa, s === last ? s.x1 : s.x1 - BAR.inset);
      // (thicker: the ride whose vehicle the map follows, vehicle-follow.ts)
      g.appendChild(svgEl('line', { x1: xa, y1: BAR.lineY, x2: xb, y2: BAR.lineY, stroke: 'currentColor', 'stroke-width': followsRide(s.ride) ? 7 : 4, 'stroke-linecap': 'round' }));
      if (s !== first) dot(xa, BAR.node);
      if (s !== last) dot(xb, BAR.node);
      return;
    }
    // walking / changing / waiting: evenly spaced dots, clear of the big dots on either side
    const xa = s.x0 + (s === first ? 10 : 6), xb = s.x1 - (s === last ? 10 : 6);
    const n = Math.max(1, Math.floor(Math.max(0, xb - xa) / BAR.dot) + 1);
    const start = (xa + xb) / 2 - ((n - 1) * BAR.dot) / 2;
    for (let k = 0; k < n; k++) dot(start + k * BAR.dot, BAR.ball);
  });
  g.appendChild(svgEl('circle', { cx: first.x0, cy: BAR.lineY, r: 3.6, class: 'j-bar-start', 'stroke-width': 2, stroke: 'currentColor' }));
  dot(last.x1, BAR.node);
}
export function renderBar() {
  jBar.replaceChildren();
  if (!journey.conn || !jBar.clientWidth) return;
  const geo = barLayout();
  const pt = progressTime(); // GPS when it follows you, else the clock
  const now = pt.t, live = pt.gps ? now < geo.t1 : now > geo.t0 && now < geo.t1;
  const nx = now <= geo.t0 ? 0 : now >= geo.t1 ? geo.W : geo.x(now);
  const svg = svgEl('svg', { viewBox: `0 0 ${geo.W} ${jBar.clientHeight}`, 'aria-hidden': 'true' });
  const clip = (id: string, xa: number, xb: number) => {
    const c = svgEl('clipPath', { id });
    c.appendChild(svgEl('rect', { x: xa, y: -10, width: Math.max(0, xb - xa), height: 80 }));
    return c;
  };
  const defs = svgEl('defs', {});
  defs.append(clip('jBarAhead', nx, geo.W + 10), clip('jBarDone', -10, nx));
  const ahead = svgEl('g', { 'clip-path': 'url(#jBarAhead)' });
  const done = svgEl('g', { 'clip-path': 'url(#jBarDone)', opacity: '.32' });
  svg.append(defs, done, ahead);
  jBar.appendChild(svg);
  drawBarArt(ahead, geo);
  drawBarArt(done, geo);
  // line names, where they fit; faded once that ride is over
  geo.segs.filter((s) => s.kind === 'ride').forEach((s) => {
    const text = svgEl('text', { x: (s.x0 + s.x1) / 2, y: BAR.textY, 'text-anchor': 'middle', fill: 'currentColor', opacity: now >= s.b ? '.32' : '1' });
    text.textContent = s.label;
    svg.appendChild(text);
    if (text.getComputedTextLength() > s.x1 - s.x0 + 8) text.remove();
  });
  if (live) {
    svg.appendChild(svgEl('circle', { cx: nx, cy: BAR.lineY, r: 9, opacity: '.18', class: 'j-bar-halo' }));
    svg.appendChild(svgEl('circle', { cx: nx, cy: BAR.lineY, r: 5, class: 'j-bar-now', 'stroke-width': 2.5 }));
  }
}

export function updateProgress() {
  if (!journey.conn) return;
  trackJourney();
  checkRide(); // on another vehicle than planned? (ride-switch.ts)
  renderBar();
  renderLive();
  if (journey.steps.length) { redrawRoute(); updateNowMarker(); }
}
// Every few seconds during a trip: move things along, and keep GPS fixes coming while you stand still
let gpsPolling = false;
function tick() {
  updateProgress();
  refreshList();
  if (!journey.conn || gpsPolling || fixAge() < 25000 || !tripLive() || !window.isSecureContext || !navigator.geolocation) return;
  gpsPolling = true;
  navigator.geolocation.getCurrentPosition((pos) => { gpsPolling = false; onPosition(pos); }, () => { gpsPolling = false; },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
}

export function updatePillTimes() {
  const plan = journey.conn!.t1, live = journeyEnd();
  const el = document.getElementById('jArr')!;
  el.textContent = fmtTime(live);
  el.classList.toggle('late', live - plan >= 60000);
}
export function renderJourney(conn: Journey, destTitle: string) {
  stopFollowing(); // (a vehicle of the journey before)
  journey.conn = conn;
  journey.steps = buildSteps(conn, destTitle);
  journey.platKey = platSig();
  journey.step = 0;
  journey.overview = true;
  tracking.track = null;
  tracking.autoStep = 0;
  sheet.focus = null;
  sheet.msg = '';
  sheet.retry = false;
  document.getElementById('jDep')!.textContent = fmtTime(journeyStart());
  updatePillTimes();
  trackJourney();
  renderBar();
  renderSheet();
  redrawRoute(true);
  vehUpdate(); // the vehicles of its rides, live (the one coming to your stop too)
  updateNowMarker();
  refreshRouteHighlight();
  if (!followCamOn() && !vehicleFollowing()) fitJourney(); // the whole journey first; a step picked in the sheet (or reached by GPS) zooms in on it
}

// Show one step of the trip on the map (the rest dims); auto: moved there by GPS, not by you; keepCamera: the map is
// left as it is (a ride whose vehicle is to be followed: vehicle-follow.ts moves it)
export function goToStep(i: number, auto?: boolean, keepCamera?: boolean) {
  if (!journey.steps.length) return;
  if (!auto) { tracking.userPickedAt = Date.now(); pauseFollowCam(); }
  if (!auto && !keepCamera) stopFollowing(); // you picked another step: the map shows it, not the vehicle
  journey.step = Math.min(journey.steps.length - 1, Math.max(0, i));
  journey.overview = false;
  sheet.focus = null;
  refreshRouteHighlight();
  if (!followCamOn() && !keepCamera && !vehicleFollowing()) fitStep(journey.step); // (the follow camera shows where you are on it)
  if (!auto && sheetDetent === 'full') setDetent('mid');
  renderSheet();
}

// Keep what the camera shows clear of the top bar and of the sheet where it rests
export function mapPadding() {
  const hgt = window.innerHeight;
  // under way the menu button hangs below the pill; otherwise it is beside the card
  // (with room for a pin, which stands above its point)
  const top = document.body.classList.contains('following') ? 150 : Math.max(56, topUiBottom()) + 48;
  // the journey sheet, or the place sheet (place-sheet.ts): never both
  const covered = document.body.classList.contains('journey-mode') ? Math.max(0, hgt - sheet.y) : placeView.covered;
  const bottom = Math.max(40, Math.min(covered + 24, hgt - top - 120));
  const side = window.innerWidth >= 700 && (covered || placeView.side) ? 444 : 48; // wide screens: the sheet is a panel on the left
  return { top, bottom: side > 48 ? 40 : bottom, left: side, right: 48 };
}
export function fitCoords(coords: LngLat[], maxZoom = 17) {
  if (!coords.length) return;
  const b = coords.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  map.fitBounds(b, { padding: mapPadding(), maxZoom, bearing: 0, pitch: 0, duration: 700 });
}
export function fitJourney() {
  const all: LngLat[] = [];
  journey.steps.forEach((st) => all.push(...stepCoords(st)));
  requestAnimationFrame(() => fitCoords(all));
}
export function fitStep(i: number) {
  const st = journey.steps[i];
  if (st) fitCoords(stepCoords(st));
}

// origin: where the trip starts and what it is called; left out: the start, else your position, else the map centre
export async function startJourney(r: JourneyDest, keepQuery?: boolean, origin?: JourneyOrigin) {
  const id = ++journey.req;
  closeLine(); // a line chosen in the search gives way to the trip
  stopFollowing();
  if (!keepQuery) journey.query = { mode: 'dep', date: '', time: '' };
  journey.dest = r;
  journey.conn = null;
  journey.steps = [];
  journey.options = null;
  journey.list = false;
  journey.more = null;
  journey.origin = origin || (searchState.tripStart ? { ll: searchState.tripStart.lngLat, label: searchState.tripStart.title }
    : userLngLat ? { ll: userLngLat, label: 'Your location' } : { ll: map.getCenter().toArray(), label: 'Map centre' });
  journey.from = journey.origin.label;
  updateWhenChip();
  sheet.focus = null;
  openDirs.clear();
  openStops.clear();
  updateCards(); // hide events and places: only the trip and the destination
  updatePlaces();
  const wasOpen = document.body.classList.contains('journey-mode');
  setPlanOpen(true);
  document.body.classList.add('journey-mode');
  setMenu(false);
  document.getElementById('jBar')!.innerHTML = '';
  document.getElementById('jDep')!.textContent = '--:--';
  document.getElementById('jArr')!.textContent = '--:--';
  sheet.msg = 'Finding a connection…';
  sheet.retry = false;
  tracking.track = null;
  placeUserDot(); // plain GPS until the new trip follows you
  renderSheet();
  if (!wasOpen) openSheet();
  vehMarker.remove();
  nowMarker.remove();
  setRoute([]);
  if (!keepQuery) map.flyTo({ center: r.lngLat, zoom: 14, bearing: 0, pitch: 0, speed: 1.4 }); // between the card above and the sheet below
  clearInterval(journey.progressTimer);
  journey.progressTimer = setInterval(tick, 5000);
  clearInterval(journey.liveTimer);
  journey.liveTimer = setInterval(livePoll, 30000); // live times from the Kante engine every 30 s while the trip is on
  vehStop(); // the map shows only the trip

  const from = journey.origin.ll;
  try {
    startPlatforms(); // the platform dots on the map (the journey's boarding points come from the engine)
    const opts = await KanteJourney.plans(from, r, journey.query);
    if (id !== journey.req) return;
    if (!opts) { sheet.msg = 'No public transport connection found for this trip.'; renderSheet(); return; }
    // More than one way to go: the list to choose from, with the best one on the map. (Under way, a new
    // plan goes straight to its best journey.)
    journey.options = opts;
    journey.tab = opts.best === opts.walk ? 'walk' : 'pt';
    journey.list = optionCount() > 1 && !document.body.classList.contains('following');
    if (journey.list && sheetDetent === 'low') placeSheet('mid', true); // room for the first rows
    renderJourney(opts.best, r.title);
    refineJourney(id); // swap straight lines for real walking paths and tracks/roads
    livePoll(); // live times for its rides at once
  } catch (e) {
    if (id !== journey.req) return;
    // the engine is switched off or cannot be reached: say so, and (when it can come back) offer to ask again
    const why = engineFailure(e);
    sheet.msg = why ? engineMessage(why, 'Journeys') : 'Connections could not be loaded. Check your internet connection.';
    sheet.retry = why !== 'off';
    renderSheet();
  }
}
// "Try again" after the engine could not be reached: the same trip, from the same place, at the same time (the
// first try has moved the map, so the map centre is no longer where it started)
export function retryJourney() {
  if (!journey.dest) return;
  startJourney(journey.dest, true, journey.origin || undefined);
}

/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() {
  if (window.ResizeObserver) new ResizeObserver(() => renderBar()).observe(jBar);
  jBar.addEventListener('click', (e) => {
    if (!journey.conn || !journey.steps.length) return;
    const geo = barLayout();
    const x = e.clientX - jBar.getBoundingClientRect().left;
    // a ride: follow its vehicle (again: stop); between rides, that step
    const seg = geo.segs.find((s) => x >= s.x0 && x <= s.x1);
    if (seg && seg.kind === 'ride') {
      const k = journey.steps.findIndex((st) => st.type === 'ride' && st.s === seg.ride);
      if (k >= 0) { toggleRide(k); return; }
    }
    const t = geo.tAt(x);
    let i = 0;
    journey.steps.forEach((st, k) => { if (st.t0 != null && st.t0 <= t) i = k; });
    if (t >= geo.t1 - 1000) i = journey.steps.length - 1;
    goToStep(i);
  });
}
