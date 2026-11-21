// ---- Top pill: the trip on one line, roughly to scale in time. Every ride is a solid line with its name above it;
//      walking, changing and waiting are rows of single dots (always at least a few, so a short change still shows).
//      The part already behind you fades. Tap to jump to that step. ----
const jBar = document.getElementById('jBar')!;
const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) => { const e = document.createElementNS(SVG_NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k] as string); return e; };
const BAR = { pad: 6, lineY: 26, textY: 14, dot: 8, ball: 2.5, node: 4.2, inset: 4 }; // ball: walking dots, node: ends of a ride
// → { segs: [{ kind, a, b, x0, x1, label }], t0, t1, W, x(t), tAt(px) }
/** A part of the bar: from when to when (ms), its least width, and (once laid out) its width and where it is, px. */
interface BarPart { a: number; b: number; min: number; w: number; x0: number; x1: number }
interface BarRide extends BarPart { kind: 'ride'; label: string }
interface BarGap extends BarPart { kind: 'gap' }
type BarSeg = BarRide | BarGap;
function barLayout() {
  const t0 = new Date(journeyConn!.from.departure!).getTime(), t1 = Math.max(new Date(journeyConn!.to.arrival!).getTime(), journeyEnd());
  const W = jBar.clientWidth, L = W - 2 * BAR.pad;
  const segs: BarSeg[] = [];
  let cursor = t0, rides = 0;
  journeyConn!.sections.filter((s) => s.journey).forEach((s) => {
    const a = Math.max(cursor, liveMs(s.departure, 'departure')!), b = Math.max(a, liveMs(s.arrival, 'arrival')!);
    if (a > cursor || rides) segs.push({ kind: 'gap', a: cursor, b: a, min: rides ? 28 : 17 } as BarGap); // a change, or the walk to the first stop
    segs.push({ kind: 'ride', a, b, min: 26, label: lineLabel(s.journey!) } as BarRide);
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
      g.appendChild(svgEl('line', { x1: xa, y1: BAR.lineY, x2: xb, y2: BAR.lineY, stroke: 'currentColor', 'stroke-width': 4, 'stroke-linecap': 'round' }));
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
function renderBar() {
  jBar.replaceChildren();
  if (!journeyConn || !jBar.clientWidth) return;
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
if (window.ResizeObserver) new ResizeObserver(() => renderBar()).observe(jBar);
jBar.addEventListener('click', (e) => {
  if (!journeyConn || !journeySteps.length) return;
  const geo = barLayout();
  const t = geo.tAt(e.clientX - jBar.getBoundingClientRect().left);
  let i = 0;
  journeySteps.forEach((st, k) => { if (st.t0 != null && st.t0 <= t) i = k; });
  if (t >= geo.t1 - 1000) i = journeySteps.length - 1;
  goToStep(i);
});

function updateProgress() {
  if (!journeyConn) return;
  trackJourney();
  guideTick();
  renderBar();
  renderLive();
  if (journeySteps.length) { redrawRoute(); updateNowMarker(); }
}
// Every few seconds during a trip: move things along, and keep GPS fixes coming while you stand still
let gpsPolling = false;
function tick() {
  updateProgress();
  refreshList();
  if (!journeyConn || gpsPolling || fixAge() < 25000 || !tripLive() || !window.isSecureContext || !navigator.geolocation) return;
  gpsPolling = true;
  navigator.geolocation.getCurrentPosition((pos) => { gpsPolling = false; onPosition(pos); }, () => { gpsPolling = false; },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
}

function updatePillTimes() {
  const plan = new Date(journeyConn!.to.arrival!).getTime(), live = journeyEnd();
  const el = document.getElementById('jArr')!;
  el.textContent = fmtTime(live);
  el.classList.toggle('late', live - plan >= 60000);
}
function renderJourney(conn: OdConnection, destTitle: string) {
  journeyConn = conn;
  journeySteps = buildSteps(conn, destTitle);
  platKey = platSig();
  journeyStep = 0;
  routeOverview = true;
  track = null;
  autoStep = 0;
  jFocus = null;
  sheetMsg = '';
  guideSaid.clear(); // another journey: nothing of it has been said yet
  guideDelay.clear();
  guidePlat.clear();
  guideHeld = { key: '', since: 0 };
  document.getElementById('jDep')!.textContent = fmtTime(conn.from.departure);
  updatePillTimes();
  trackJourney();
  renderBar();
  renderSheet();
  redrawRoute(true);
  updateNowMarker();
  refreshRouteHighlight();
  fitJourney(); // the whole journey first; a step picked in the sheet (or reached by GPS) zooms in on it
}

// Show one step of the trip on the map (the rest dims); auto: moved there by GPS, not by you
function goToStep(i: number, auto?: boolean) {
  if (!journeySteps.length) return;
  if (!auto) userPickedAt = Date.now();
  journeyStep = Math.min(journeySteps.length - 1, Math.max(0, i));
  routeOverview = false;
  jFocus = null;
  refreshRouteHighlight();
  fitStep(journeyStep);
  if (!auto && sheetDetent === 'full') setDetent('mid');
  renderSheet();
}

// Keep what the camera shows clear of the top bar and of the sheet where it rests
function mapPadding() {
  const hgt = window.innerHeight;
  // under way the menu button hangs below the pill; otherwise it is beside the card
  // (with room for a pin, which stands above its point)
  const top = document.body.classList.contains('following') ? 150 : Math.max(56, topUiBottom()) + 48;
  const covered = document.body.classList.contains('journey-mode') ? Math.max(0, hgt - sheetY) : 0;
  const bottom = Math.max(40, Math.min(covered + 24, hgt - top - 120));
  const side = window.innerWidth >= 700 && covered ? 444 : 48; // wide screens: the sheet is a panel on the left
  return { top, bottom: side > 48 ? 40 : bottom, left: side, right: 48 };
}
function fitCoords(coords: LngLat[], maxZoom = 17) {
  if (!coords.length) return;
  const b = coords.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  map.fitBounds(b, { padding: mapPadding(), maxZoom, duration: 700 });
}
function fitJourney() {
  const all: LngLat[] = [];
  journeySteps.forEach((st) => all.push(...stepCoords(st)));
  requestAnimationFrame(() => fitCoords(all));
}
function fitStep(i: number) {
  const st = journeySteps[i];
  if (st) fitCoords(stepCoords(st));
}

async function startJourney(r: JourneyDest, keepQuery?: boolean) {
  const id = ++journeyReq;
  if (!keepQuery) journeyQuery = { mode: 'dep', date: '', time: '' };
  journeyDest = r;
  journeyConn = null;
  journeySteps = [];
  journeyOptions = null;
  journeyList = false;
  journeyMore = null;
  journeyFrom = tripStart ? tripStart.title : userLngLat ? 'Your location' : 'Map centre';
  updateWhenChip();
  jFocus = null;
  openDirs.clear();
  closedDirs.clear();
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
  sheetMsg = 'Finding a connection…';
  track = null;
  placeUserDot(); // plain GPS until the new trip follows you
  renderSheet();
  if (!wasOpen) openSheet();
  if (lowVision() && sheetDetent !== 'full') setDetent('full'); // Settings › Blind or low vision: journeys as a list
  loadAccessData();
  // A screen reader goes to the journey, which says where it leads, then hears what is found
  journeyEl.setAttribute('aria-label', `Journey to ${r.title}`);
  journeyEl.focus({ preventScroll: true });
  A11Y.say(`Finding a connection to ${r.title}.`, { quiet: true });
  vehMarker.remove();
  nowMarker.remove();
  setRoute([]);
  if (!keepQuery) map.flyTo({ center: r.lngLat, zoom: 14, speed: 1.4 }); // between the card above and the sheet below
  clearInterval(progressTimer);
  progressTimer = setInterval(tick, 5000);
  clearInterval(liveTimer);
  liveTimer = setInterval(refreshLive, 60000); // live forecasts once a minute while the trip is on
  clearInterval(kanteTimer);
  kanteTimer = setInterval(kantePoll, 30000); // …and every 30 s from the Kante engine, for the rides it knows
  vehStop(); // the map shows only the trip

  const from = tripStart ? tripStart.lngLat : userLngLat || map.getCenter().toArray();
  try {
    // exact platforms if their data is there in time; never hold a journey up for more than 4 s
    startPlatforms();
    const [opts] = await Promise.all([findOptions(from, r), Promise.race([platformsReady, new Promise((ok) => setTimeout(ok, 4000))])]);
    if (id !== journeyReq) return;
    if (!opts) { sheetMsg = 'No public transport connection found for this trip.'; renderSheet(); A11Y.say(sheetMsg, { urgent: true }); return; }
    // More than one way to go: the list to choose from, with the best one on the map. (Under way, a new
    // plan goes straight to its best journey.)
    journeyOptions = opts;
    journeyTab = opts.best === opts.walk ? 'walk' : 'pt';
    journeyList = optionCount() > 1 && !document.body.classList.contains('following');
    if (journeyList && sheetDetent === 'low') placeSheet('mid', true); // room for the first rows
    renderJourney(opts.best, r.title);
    if (journeyList) announceOptions();
    else announceJourney();
    refineJourney(id); // swap straight lines for real walking paths and tracks/roads
    if (opts.walk && opts.walk !== opts.best) netWalkOption(id, opts.walk, from, r); // its tab and card in network times
    kanteMatch(id);    // the engine's trip for every ride, for its live data
  } catch (e) {
    if (id === journeyReq) { sheetMsg = 'Connections could not be loaded. Check your internet connection.'; renderSheet(); A11Y.say(sheetMsg, { urgent: true }); }
  }
}
