// ---- 3D station view (station3d.js): for walks and changes in a station that has a 3D model (stations3d/) ----
const S3_NEAR_KM = 0.5; // a station model reaches about this far around its platforms
const s3Key = (stop: OdCheckpoint | null | undefined) => (window.Station3D && stop && stop.station && Station3D.has(stop.station.id!)) || null;
// A ride's boarding / alighting point for the station router: the platform, with its position as a fallback
/** What s3End() fills in: the platform, its position, or both. */
interface S3EndParts { stop?: StationRouteStopRef; ll?: LngLat; level?: number | null }
function s3End(stop: OdCheckpoint, at: JourneyPlatformAt | null | undefined): Station3DEndpoint | null {
  const edge = at && at.edge, raw = platformOf(stop);
  const ref = raw !== '–' ? raw : (edge && edge.ref) || '';
  const ll = (at && at.ll) || coordOf(stop);
  if (!ref && !ll) return null;
  const end: S3EndParts = {};
  if (ref) end.stop = { uic: String(stop.station!.id), ref };
  if (ll) end.ll = ll;
  if (edge && edge.level != null) end.level = edge.level;
  return end as Station3DEndpoint;
}
// Where a step's walk starts and ends inside the modelled station, or null when it is not in one
function s3Plan(st: JourneyStep): StationWalkPlan | null {
  let key = null, from = null, to = null;
  if (st.type === 'walk' && st.next) {
    key = s3Key(st.next.departure);
    const here = tripStart ? null : userLngLat; // a trip from somewhere else starts there, not where you are
    const start = here || (st.lines[0] && st.lines[0][0]);
    to = s3End(st.next.departure, st.nextRide && st.nextRide.depAt);
    // from further away the model only shows the last stretch: where the walk comes in, not where you are
    const far = start && to && to.ll && distKm(start, to.ll) > S3_NEAR_KM;
    from = start ? (far ? { ll: start, label: 'the way in' } : here ? { ll: start } : { ll: start, label: 'the start' }) : null;
  } else if (st.type === 'walk') {
    key = st.from ? s3Key(st.from.arrival) : null;
    from = key && s3End(st.from!.arrival, st.prevRide && st.prevRide.arrAt);
    const end = (journeyDest && journeyDest.lngLat) || (st.lines.length ? st.lines[st.lines.length - 1][1] : null);
    const far = end && from && from.ll && distKm(from.ll, end) > S3_NEAR_KM;
    to = end ? { ll: end, label: far ? `the way to ${st.toName}` : st.toName } : null;
  } else if (st.type === 'change') {
    const ka = s3Key(st.prev.arrival), kb = s3Key(st.next.departure);
    key = kb || ka;
    from = ka === key ? s3End(st.prev.arrival, st.prevRide && st.prevRide.arrAt)
      : st.points[0] ? { ll: st.points[0], label: st.prev.arrival.station!.name! } : null;
    to = kb === key ? s3End(st.next.departure, st.nextRide && st.nextRide.depAt)
      : st.points[1] ? { ll: st.points[1], label: st.next.departure.station!.name! } : null;
  }
  return key && from && to ? { key, from, to } : null;
}
// The journey options for the station router, for the day of that step (closures in the model have dates)
const s3Prefs = (st: JourneyStep | null | undefined) => ({ ...SETTINGS.journey(), date: st && st.t0 ? dateValue(new Date(st.t0)) : undefined });
// The continuous "inside" view (station3d-solid.html) for the stations that have its companion stations3d/<key>.solid.js,
// listed in stations3d/solid-index.js (written by tools/station3d_solid.py; loaded once, when a walk card needs it)
let s3SolidIndex: Promise<Record<string, { file: string }>> | null = null;
function s3HasSolid(key: string): Promise<boolean> {
  if (!s3SolidIndex) s3SolidIndex = new Promise((resolve) => {
    if (window.STATION3D_SOLID_INDEX) { resolve(window.STATION3D_SOLID_INDEX); return; }
    const s = document.createElement('script');
    s.src = 'stations3d/solid-index.js';
    s.onload = () => resolve(window.STATION3D_SOLID_INDEX || {});
    s.onerror = () => { s.remove(); s3SolidIndex = null; resolve({}); };   // offline: try again for the next card
    document.head.appendChild(s);
  });
  return s3SolidIndex.then((ix) => !!ix[key]);
}
type S3SolidEnd = { stop?: { uic: string; ref?: string; sector?: string }; ll?: LngLat; level?: number | null };
function s3SolidUrl(plan: StationWalkPlan, prefs: object): string {
  const end = (e: S3SolidEnd) => (e.stop ? `stop:${e.stop.uic}:${e.stop.ref || ''}${e.stop.sector ? '@' + e.stop.sector : ''}`
    : e.ll ? `ll:${e.ll[0]},${e.ll[1]}${e.level != null ? ',' + e.level : ''}` : '');
  const p = Object.entries(prefs).filter(([, v]) => v === true).map(([k]) => k).join(',');
  return `station3d-solid.html?key=${encodeURIComponent(plan.key)}&from=${encodeURIComponent(end(plan.from as S3SolidEnd))}`
    + `&to=${encodeURIComponent(end(plan.to as S3SolidEnd))}${p ? '&prefs=' + p : ''}`;
}
let s3Step: JourneyStep | null = null; // the journey step the 3D view was opened from
function s3Open(st: JourneyStep, button: HTMLElement | null) {
  const plan = s3Plan(st); // now, not when the sheet was drawn: the start follows your position
  if (!plan) return;
  s3Step = st;
  Station3D.open({ ...plan, prefs: s3Prefs(st), returnFocus: button });
}
// "Done" at the end of the 3D walk: back to the journey, on the step that follows
if (window.Station3D) Station3D.on('done', () => {
  const i = journeySteps.indexOf(s3Step!);
  Station3D.close();
  if (i >= 0 && i < journeySteps.length - 1) goToStep(i + 1);
});

function walkTarget(st: JourneyStep) {
  const r = st.type === 'change' || !st.final ? st.nextRide : null;
  if (!r) return st.toName || (journeyDest && journeyDest.title) || 'your destination';
  const q = quayOf(r, 'dep');
  return q.label ? `${q.word} ${q.label}` : r.s.departure.station!.name;
}
// Metres on foot, once every part of the walk has been routed (null until then)
function walkDist(st: JourneyStep) {
  const lines = st.lines || [];
  if (!lines.length) return 0;
  const ws = st.walks || [];
  return lines.every((_, k) => ws[k] && ws[k].dist != null) ? ws.reduce((sum, w) => sum + (w ? w.dist! : 0), 0) : null;
}
const walkMinOf = (st: JourneyStep) => (st.type === 'change' ? st.walkMin || 0 : st.min || 0);

// Written directions for a walk, from the walking router's turn-by-turn steps, with the floor change in its place
const TURN: Record<string, string> = { left: 'Turn left', right: 'Turn right', 'slight left': 'Bear left', 'slight right': 'Bear right',
  'sharp left': 'Turn sharp left', 'sharp right': 'Turn sharp right', straight: 'Continue straight', uturn: 'Turn around' };
function walkDirections(st: JourneyStep) {
  if (st._dirsV === geoVersion) return st._dirs!;
  const out: JourneyDirection[] = [];
  (st.walks || []).forEach((w) => {
    // a stretch through a modelled station: its own directions, floor changes included
    if (w && w.dirs) out.push(...w.dirs);
  else ((w && w.steps) || []).forEach((s) => {
    const m = s.maneuver || {}, d = Math.round(s.distance || 0);
    if (m.type === 'arrive' || d < 3) return;
    const along = s.name ? ` along ${s.name}` : '';
    const verb = m.type === 'depart' ? 'Walk' : `${TURN[m.modifier!] || 'Continue'} and walk`;
    out.push({ kind: m.type === 'depart' ? 'depart' : 'walk', text: `${verb} ${fmtDist(d)}${along}`, coords: s.geometry && s.geometry.coordinates });
  });
  });
  const lvl = st.floors ? null : levelChange(st);
  if (lvl) {
    const item: JourneyDirection = { kind: lvl.to < lvl.from ? 'stairs-down' : 'stairs-up', text: lvl.text, from: lvl.from, to: lvl.to, coords: lvl.at ? [lvl.at] : null };
    if (st.type === 'walk' && st.final) out.unshift(item);
    else if (st.type === 'walk') out.push(item);
    else out.splice(Math.ceil(out.length / 2), 0, item);
  }
  if (out.length) {
    const cs = (st.lines || []).flat();
    out.push({ kind: 'arrive', text: `Arrive at ${walkTarget(st)}`, coords: cs.length ? [cs[cs.length - 1]] : null });
  }
  st._dirs = out;
  st._dirsV = geoVersion;
  return out;
}

// What to do first, and when: the verb is yours when the trip starts on foot ("Leave in 4 min"), the vehicle's otherwise
function firstAction(now: number) {
  const first = journeySteps[0], ride = journeySteps.find((st) => st.type === 'ride');
  const walkFirst = first && first.type === 'walk';
  const when = walkFirst ? first.t0 : ride ? ride.t0 : null;
  if (when == null) return { text: '', quay: ride && quayOf(ride, 'dep') };
  const s = (when - now) / 1000;
  let text = '';
  if (s < -45) text = `Left ${kDur(-s)} ago`;
  else if (s < 60) text = walkFirst ? 'Leave now' : 'Leaves now';
  else if (s < 3600) text = `${walkFirst ? 'Leave' : 'Leaves'} in ${kDur(Math.floor(s / 60) * 60)}`;
  const late = ride ? lateMin(ride.s.departure, 'departure') : 0;
  const forecast = ride && ride.s.departure.prognosis && ride.s.departure.prognosis.departure;
  return { text, gone: s < -45, state: !forecast ? 'plain' : late > 0 ? 'late' : 'ok', delay: late, quay: ride && quayOf(ride, 'dep') };
}

function legChain() {
  const items = journeySteps.filter((st) => st.type === 'ride' || ((st.type === 'walk' || st.type === 'change') && walkMinOf(st) >= 1));
  const max = 7, cut = items.length > max ? items.slice(0, max - 1) : items;
  const chain = h('span', 'chain');
  chain.setAttribute('aria-hidden', 'true');
  cut.forEach((st, i) => {
    if (i) chain.append(kIcon('right', 12, 'chain-sep'));
    chain.append(st.type === 'ride' ? kBadge(st.s.journey, null, chainIcon(st.s.journey))
      : h('span', 'chain-walk', kIcon('walk', 14), String(Math.max(1, walkMinOf(st)))));
  });
  if (cut.length < items.length) chain.append(h('span', 'chain-more', `+${items.length - cut.length}`));
  return chain;
}
function sheetActions() {
  const full = sheetDetent === 'full';
  return h('span', 'sheet-actions',
    kBtn('round-btn', full ? 'Show the map' : 'Show the list', () => setDetent(sheetDetent === 'full' ? 'mid' : 'full', true), kIcon(full ? 'map' : 'list', 18)),
    kBtn('round-btn', 'Close journey', () => endJourney(), kIcon('close', 18)));
}
// A walking direction picked: step through them, or back to the whole journey
function stepNav(): HTMLDivElement {
  const st = journeySteps[jFocus!.step], dirs = st ? walkDirections(st) : [], k = jFocus!.dir, d = dirs[k];
  if (!d) { jFocus = null; return buildHead(); }
  const text = h('div', 'stepnav-text', h('small', null, `${k + 1} of ${dirs.length}`), h('strong', 'trunc2', d.text));
  text.setAttribute('aria-live', 'polite');
  const prev = kBtn('round-btn', 'Previous direction', () => focusDir(jFocus!.step, k - 1), kIcon('back', 18));
  const next = kBtn('round-btn', 'Next direction', () => focusDir(jFocus!.step, k + 1), kIcon('go', 18));
  prev.disabled = k === 0;
  next.disabled = k === dirs.length - 1;
  return h('div', 'stepnav', prev, text, next, kBtn('round-btn', 'Back to the whole journey', overview, kIcon('close', 18)));
}
// ---- The journeys to choose from (the list of the Kante app, branch nikitas-implementation): one row each with
//      its vehicles, times and first boarding point; walking all the way, when that is near enough, on a tab of
//      its own. The one shown first is drawn on the map; a tap on a row opens that journey. ----
const optionCount = () => (journeyOptions ? journeyOptions.list.length + (journeyOptions.walk ? 1 : 0) : 0);
const connStart = (c: OdConnection) => new Date(c.from.departure!).getTime();
const connEnd = (c: OdConnection) => new Date(c.to.arrival!).getTime();
const connSecs = (c: OdConnection) => Math.max(0, connEnd(c) - connStart(c)) / 1000;

function optionRow(conn: OdConnection, now: number) {
  const rides = conn.sections.filter((s) => s.journey) as RideSection[], first = rides[0];
  const t0 = connStart(conn), t1 = Math.max(connEnd(conn), t0 + 60000);
  // line 1: every vehicle's badge, with the walks between them, and how long it all takes
  const chain = h('span', 'chain');
  chain.setAttribute('aria-hidden', 'true');
  let walkS = 0;
  const add = (node: HTMLElement) => { if (chain.childNodes.length) chain.append(kIcon('right', 12, 'chain-sep')); chain.append(node); };
  const addWalk = () => { const m = Math.round(walkS / 60); walkS = 0; if (m >= 1) add(h('span', 'chain-walk', kIcon('walk', 14), String(m))); };
  conn.sections.forEach((s) => {
    if (!s.journey) { walkS += s._netWalkS != null ? s._netWalkS : (s.walk && s.walk.duration) || 0; return; }
    addWalk();
    add(kBadge(s.journey, null, chainIcon(s.journey)));
  });
  addWalk();
  // line 2: the two times, and between them the rides to scale (a ring where you change)
  const bar = h('span', 'tbar', h('i', 'tbar-base'));
  bar.setAttribute('aria-hidden', 'true');
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - t0) / (t1 - t0)) * 100));
  rides.forEach((s, k) => {
    const a = pct(liveMs(s.departure, 'departure')!), b = pct(liveMs(s.arrival, 'arrival')!);
    const ride = lineVars(h('i', 'tbar-ride'), s.journey);
    ride.style.left = a + '%';
    ride.style.width = Math.max(4, b - a) + '%';
    bar.append(ride);
    if (!k) return;
    const change = h('i', 'tbar-change');
    change.style.left = pct((liveMs(rides[k - 1].arrival, 'arrival')! + liveMs(s.departure, 'departure')!) / 2) + '%';
    bar.append(change);
  });
  bar.append(h('i', 'tbar-end a'), h('i', 'tbar-end b'));
  // line 3: where it leaves from, in how long, and the changes (with the time there is for the tightest)
  const walkFirst = !conn.sections[0].journey;
  const secs = ((walkFirst || !first ? t0 : liveMs(first.departure, 'departure')!) - now) / 1000;
  const gone = secs < -45;
  const text = gone ? `Left ${kDur(-secs)} ago` : secs < 60 ? (walkFirst ? 'Leave now' : 'Leaves now')
    : secs < 3600 ? `${walkFirst ? 'Leave' : 'Leaves'} in ${kDur(Math.floor(secs / 60) * 60)}` : '';
  const late = first ? lateMin(first.departure, 'departure') : 0;
  const forecast = first && first.departure.prognosis && first.departure.prognosis.departure;
  const gaps = rides.slice(1).map((s, k) => Math.max(0, Math.floor((liveMs(s.departure, 'departure')! - liveMs(rides[k].arrival, 'arrival')!) / 60000)));
  const changes = !rides.length ? ['On foot'] : !gaps.length ? ['Direct']
    : [`${gaps.length} ${gaps.length === 1 ? 'change' : 'changes'}`, `· ${gaps.length === 1 ? '' : '≥ '}${Math.min(...gaps)} min`];
  const row = kBtn('jrow' + (gone ? ' gone' : '') + (conn === journeyConn ? ' shown' : ''), null, () => openOption(conn),
    h('span', 'jrow-l1', chain, h('b', 'jrow-dur', kDur((t1 - t0) / 1000))),
    h('span', 'jrow-l2', h('b', 'jrow-time', fmtTime(conn.from.departure)), bar, h('b', 'jrow-time end', fmtTime(conn.to.arrival))),
    h('span', 'jrow-l3', h('span', 'jrow-plat', first ? kPlat(quayOf({ s: first }, 'dep')) : null),
      h('span', 'jrow-mid',
        text ? h('span', 'jrow-act ' + (gone ? 'gone' : !forecast ? 'plain' : late > 0 ? 'late' : 'ok'), text, gone ? null : kDelay(late)) : null,
        h('span', 'jrow-chg', changes.map((t) => h('span', null, t))))));
  if (conn === journeyConn) row.setAttribute('aria-current', 'true'); // the one drawn on the map
  return row;
}
function walkCard(conn: OdConnection) {
  const m = conn.kante ? conn.kante.walkM : null;
  const kmh = SETTINGS.prefs ? Number(SETTINGS.prefs().walkKmh).toFixed(1).replace('.0', '') : '';
  return kBtn('walkcard', null, () => openOption(conn),
    h('span', 'walkcard-big', h('b', null, kDur(connSecs(conn))), h('span', null, [m ? fmtDist(m) : '', kmh ? `at ${kmh} km/h` : ''].filter(Boolean).join(' '))),
    h('span', 'walkcard-sub', `${fmtTime(conn.from.departure)} – ${fmtTime(conn.to.arrival)}`),
    h('span', 'walkcard-cta', 'Walking directions', kIcon('right', 16)));
}
function listHead() {
  const o = journeyOptions!;
  let title = h('h2', 'trunc', 'Journeys'); // (an h1 here is a place name, which the translator leaves alone)
  if (o.walk && o.list.length) {
    // public transport (its quickest journey) · on foot
    const tab = (key: JourneyTab, icon: KIconName, secs: number, label: string) => {
      const b = kBtn(journeyTab === key ? 'on' : '', `${label}, ${kDur(secs)}`, () => setJourneyTab(key), kIcon(icon, 20), kDur(secs));
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(journeyTab === key));
      return b;
    };
    title = h('div', 'tabs', tab('pt', 'rail', Math.min(...o.list.map(connSecs)), 'Public transport'), tab('walk', 'walk', connSecs(o.walk), 'On foot'));
    title.setAttribute('role', 'tablist');
    title.setAttribute('aria-label', 'How to travel');
  }
  return h('div', 'jhead', h('div', 'sheet-title', title, sheetActions()));
}
function listBody() {
  const o = journeyOptions!, now = Date.now(), frag = document.createDocumentFragment();
  if (journeyTab === 'walk' && o.walk) {
    frag.append(walkCard(o.walk), h('div', 'list-end'));
    return frag;
  }
  const more = (dir: JourneyMoreDir) => {
    const b = kBtn('more', null, () => loadMoreJourneys(dir), kIcon(dir === 'earlier' ? 'up' : 'down', 16),
      journeyMore === dir ? `Loading ${dir} journeys…` : cap(dir));
    b.disabled = !!journeyMore;
    return b;
  };
  if (o.earlier) frag.append(more('earlier'));
  const ol = h('ol', 'journeys');
  let lastDay = 'Today';
  o.list.forEach((conn) => {
    const day = dayLabel(conn.from.departure!);
    ol.append(h('li', null, day !== lastDay ? h('div', 'day-sep', day) : null, optionRow(conn, now)));
    lastDay = day;
  });
  frag.append(ol);
  if (o.later) frag.append(more('later'));
  frag.append(h('div', 'list-end'));
  return frag;
}
// Make one of the journeys the one on the map (and the one the sheet is about, once it is opened)
function showOption(conn: OdConnection) {
  if (conn === journeyConn || !journeyDest) return;
  const id = ++journeyReq; // what was still being fetched for the last one is dropped
  openDirs.clear();
  closedDirs.clear();
  openStops.clear();
  renderJourney(conn, journeyDest.title);
  refineJourney(id);
  kanteMatch(id);
}
// A row tapped: that journey, as before (the header gets a way back to the list)
function openOption(conn: OdConnection) {
  journeyList = false;
  if (conn === journeyConn) renderSheet();
  else showOption(conn);
  setDetent('low', true); // the map with that journey, its times, and Start
}
function showOptions() {
  if (optionCount() < 2) return;
  journeyList = true;
  jFocus = null;
  if (!routeOverview) { routeOverview = true; refreshRouteHighlight(); }
  renderSheet();
  if (sheetDetent === 'low') setDetent('mid', true);
  else fitJourney();
}
function setJourneyTab(tab: JourneyTab) {
  const o = journeyOptions;
  if (!o || tab === journeyTab) return;
  journeyTab = tab;
  const conn = tab === 'walk' ? o.walk : o.best !== o.walk ? o.best : o.list[0];
  if (conn && conn !== journeyConn) showOption(conn);
  else renderSheet();
}
// "Earlier" / "Later": more journeys for the same trip (from the Kante engine)
async function loadMoreJourneys(dir: JourneyMoreDir) {
  const o = journeyOptions;
  if (!o || journeyMore || !window.KanteJourney) return;
  journeyMore = dir;
  renderBody();
  try { await KanteJourney.more(o, dir); }
  catch (e) { showToast(`${cap(dir)} journeys could not be loaded.`); }
  if (o !== journeyOptions) return; // another trip has been planned meanwhile
  journeyMore = null;
  if (journeyList) renderBody();
}
// The countdowns in the rows ("Leaves in 6 min") move on with the clock
function refreshList() {
  if (!journeyList || !journeyOptions) return;
  const fresh = document.createElement('div');
  fresh.append(buildBody());
  if (fresh.innerHTML !== jBody.innerHTML) renderBody();
}

function buildHead(): HTMLDivElement {
  if (journeyList && journeyOptions) return listHead();
  if (jFocus) return stepNav();
  const head = h('div', 'jhead');
  if (!journeyConn) {
    head.append(h('div', 'sheet-title', h('h1', 'trunc', journeyDest ? journeyDest.title : 'Journey'), sheetActions()));
    if (sheetMsg) head.append(h('div', 'jhead-act', h('span', 'jrow-act gone', sheetMsg)));
    return head;
  }
  const now = Date.now(), end = journeyEnd();
  const rides = journeySteps.filter((st) => st.type === 'ride');
  const tr = Math.max(0, rides.length - 1);
  const onFoot = () => { const d = walkDist(journeySteps[0]); return d ? `${fmtDist(d)} on foot` : 'On foot'; };
  head.append(
    h('div', 'sheet-title',
      optionCount() > 1 && !document.body.classList.contains('following') ? kBtn('round-btn', 'All journeys', showOptions, kIcon('back', 18)) : null,
      legChain(), sheetActions()),
    h('div', 'jhead-times', h('b', null, `${fmtTime(journeyConn.from.departure)} – ${fmtTime(end)}`),
      h('span', null, !rides.length ? onFoot() : tr === 0 ? 'Direct' : `${tr} ${tr === 1 ? 'change' : 'changes'}`)));
  const act = h('div', 'jhead-act');
  // live: off the route, missed a ride, followed by GPS, or a ride under way — otherwise what to do first
  const lp = liveParts(now);
  const rideNow = rides.some((st) => st.t0 != null && now >= st.t0 && now <= st.t1!);
  if (now > end + 120000) act.append(h('span', 'jrow-act gone', 'This journey has ended'));
  else if (lp && lp.kind === 'off') act.append(h('span', 'jrow-act late', lp.parts), kBtn('pill-btn small', null, replan, kIcon('refresh', 16), 'Replan'));
  else if (lp && (lp.kind === 'gps' || (lp.kind === 'est' && rideNow))) act.append(h('span', 'jrow-act', lp.parts), ...(lp.rest ? [h('span', 'jhead-rest' + (lp.restLevel ? ' hurry-' + lp.restLevel : ''), lp.rest)] : [])); // append(null) would write "null"
  else {
    const a = firstAction(now);
    if (a.text) act.append(h('span', 'jrow-act ' + (a.gone ? 'gone' : a.state), a.text, a.gone ? null : kDelay(a.delay!)));
    else if (a.quay) act.append(h('span'));
    const plat = a.quay && kPlat(a.quay, true); // null at a stop without signed bays
    if (plat) act.append(plat);
  }
  if (act.childNodes.length) head.append(act);
  return head;
}
let headKey = '';
function renderHead(force?: boolean) {
  const node = buildHead();
  const key = node.outerHTML;
  if (!force && key === headKey) return; // unchanged: leave it alone (and its buttons pressable)
  headKey = key;
  jHead.replaceChildren(node);
}

function placeRow(t: number | null | undefined, name: string, kind: 'from' | 'to') {
  return h('li', 'tl-row tl-place ' + kind,
    h('span', 'tl-time', h('b', null, fmtTime(t))),
    h('span', 'tl-rail', h('i', kind === 'from' ? 'od-ring' : 'od-pin')),
    h('span', 'tl-name', h('strong', null, name), h('small', null, kind === 'from' ? 'Start' : 'Destination')));
}
// Spare time on a change: from getting off to the next departure, less the walk
function spareLine(st: JourneyChangeStep) {
  const wait = (liveMs(st.next.departure, 'departure')! - liveMs(st.prev.arrival, 'arrival')!) / 1000;
  const s = wait - (st.walkS != null ? st.walkS : (st.walkMin || 0) * 60); // walkS: the engine's walk, to the second
  const level = s < 0 ? 'missed' : s < 120 ? 'tight' : 'ok';
  const extra = (SETTINGS.prefs ? SETTINGS.prefs().extraChangeMin : 0) || 0;
  return h('div', 'spare ' + level, kIcon(level === 'ok' ? 'check' : 'alert', 15),
    level === 'missed' ? h('span', null, h('b', null, `Missed change — ${kDurExact(-s)} too late`))
      : h('span', null, h('b', null, `${kDurExact(s)} to spare`), extra > 0 && s < extra * 60 ? h('small', null, ` — less than your ${extra} min extra change time`) : null));
}
function stepRow(d: JourneyDirection, active: boolean, onClick: () => void) {
  const b = kBtn('step' + (active ? ' active' : '') + ' k-' + d.kind, null, onClick,
    h('span', 'step-icon', kIcon(STEP_K[d.kind] || 'walk', 18)), h('span', 'step-text', d.text),
    d.from != null && d.to != null ? h('span', 'tag lvl', levelShort(d.from), kIcon('go', 11), levelShort(d.to)) : null);
  if (active) b.setAttribute('aria-current', 'step');
  return h('li', null, b);
}
function walkBlock(st: JourneyWalkStep | JourneyChangeStep, i: number) {
  const transfer = st.type === 'change';
  const mins = walkMinOf(st);
  const target = walkTarget(st);
  if (transfer) {
    const pq = quayOf(st.prevRide!, 'arr'), nq = quayOf(st.nextRide!, 'dep');
    const samePlace = st.prev.arrival.station!.name === st.next.departure.station!.name;
    if (!mins && !(st.lines && st.lines.length) && samePlace && pq.label && pq.word === nq.word && pq.label === nq.label) {
      return h('li', 'tl-row tl-walk same', h('span', 'tl-time'), h('span', 'tl-rail walk'),
        h('div', 'tl-main', h('strong', null, `Change at the same ${nq.word.toLowerCase()}`), spareLine(st)));
    }
  }
  const dist = walkDist(st);
  const lvl = levelChange(st);
  const pq = (transfer && quayOf(st.prevRide!, 'arr')) as Quay, nq = (transfer && quayOf(st.nextRide!, 'dep')) as Quay;
  const meta = [
    mins ? `${kDur(mins * 60)} walk` : transfer && pq.label && nq.label ? (pq.word === nq.word ? `${pq.word} ${pq.label} → ${nq.label}` : `${pq.short} ${pq.label} → ${nq.short} ${nq.label}`) : '',
    dist ? fmtDist(dist) : '',
    lvl ? lvl.text.replace(/^Go /, '') : '',
  ].filter(Boolean).join(' · ');
  const active = !routeOverview && journeyStep === i;
  const dirs = walkDirections(st);
  const expanded = openDirs.has(i) || (transfer && !closedDirs.has(i)) || (!!jFocus && jFocus.step === i);
  const title = `${transfer ? 'Change to' : 'Walk to'} ${target}`;
  const main = h('div', 'tl-main',
    kBtn('walk-sum', `${title}, ${kDur(mins * 60)}${dist ? ', ' + fmtDist(dist) : ''}. Show on map`, () => goToStep(i),
      h('strong', null, title), meta ? h('span', 'walk-meta', meta) : null));
  if (transfer) main.append(spareLine(st));
  else if (!st.final && st.nextRide) main.append(h('div', 'quiet-line', 'Leave by ', h('b', null, fmtTime(st.t0))));
  const s3p = s3Plan(st);
  if (s3p) {
    const row = h('div', null, kBtn('view3d', 'Show this walk in the 3D station view', (e) => s3Open(st, e.currentTarget as HTMLElement), kIcon('cube', 16), '3D view'));
    main.append(row);
    // and, where the station has one, the whole building in one continuous 3D view (opens in a new tab)
    s3HasSolid(s3p.key).then((ok) => {
      if (ok) row.append(kBtn('view3d', 'Show this walk inside the station building, in one continuous 3D view', () => {
        const p = s3Plan(st);
        if (p) window.open(s3SolidUrl(p, s3Prefs(st)), '_blank', 'noopener');
      }, kIcon('cube', 16), 'Inside view'));
    });
  }
  if (dirs.length > 1) {
    main.append(kBtn('expander', null, () => {
      if (expanded) { closedDirs.add(i); openDirs.delete(i); } else { openDirs.add(i); closedDirs.delete(i); }
      renderBody();
    }, kIcon(expanded ? 'up' : 'down', 16), expanded ? 'Hide directions' : `Walking directions (${dirs.length})`));
    if (expanded) main.append(h('ol', 'steps', dirs.map((d, k) => stepRow(d, !!jFocus && jFocus.step === i && jFocus.dir === k, () => focusDir(i, k)))));
  }
  return h('li', 'tl-row tl-walk' + (active ? ' active' : ''),
    h('span', 'tl-time', h('small', null, kDur(mins * 60))),
    h('span', 'tl-rail walk', kIcon('walk', 18)),
    main);
}

// "Where to stand": the boarding point as a sign, with everything known about it in words
function standCard(st: JourneyRideStep, i: number) {
  const q = quayOf(st, 'dep'), j = st.s.journey, mode = modeOf(j.category), edge = q.edge;
  const bearing = edge && edge.bearing != null ? edge.bearing : q.travel;
  const sign = h('div', 'sign' + (q.label ? '' : ' unsigned') + (q.label.length > 2 ? ' long' : ''), h('span', 'sign-noun', q.label ? q.word : 'Stop'));
  if (q.label) sign.append(h('span', 'sign-label', q.label));
  else {
    const arrow = h('span', 'sign-arrow', kIcon(bearing != null ? 'arrow' : 'dot', bearing != null ? 30 : 26));
    if (bearing != null) arrow.style.transform = `rotate(${bearing}deg)`;
    sign.append(arrow);
  }
  const side = edge && edge.side ? cap(edge.side) // the engine names the street
    : mode !== 'train' && edge && edge.bearing != null ? `${cap(compassWord(edge.bearing + 90))} side of the road` : ''; // edges sit right of travel
  const level = edge && edge.level ? `Level ${levelShort(edge.level)}` : '';
  const next = j.passList && j.passList[1] && j.passList[1].station && j.passList[1].station.name;
  let compass = null;
  if (next && bearing != null && q.label) {
    compass = h('span', 'stand-compass', kIcon('arrow', 14));
    compass.style.transform = `rotate(${bearing}deg)`;
    compass.setAttribute('role', 'img');
    compass.setAttribute('aria-label', `Leaves heading ${compassWord(bearing)}`);
  }
  const info = h('div', 'stand-info',
    h('div', 'stand-kicker', 'Where to stand'),
    side ? h('div', 'stand-side', side) : null,
    q.sectors || level ? h('div', 'stand-tags',
      q.sectors ? h('span', 'tag strong', `${q.sectors.replace(/[^A-Za-z0-9]/g, '').length === 1 ? 'Sector' : 'Sectors'} ${q.sectors}`) : null,
      level ? h('span', 'tag', level) : null) : null,
    next ? h('div', 'stand-dir', compass, h('span', null, 'Next stop: ', h('b', null, next))) : null);
  const card = h('div', 'stand', h('div', 'stand-main', sign, info));
  if (q.planned) card.append(h('div', 'stand-note warn', kIcon('alert', 16), `${q.word} ${q.planned} → ${q.label}: changed today`));
  if (!edge) card.append(h('div', 'stand-note', kIcon('info', 16), 'Exact platform or bay unknown — map pin shows the stop'));
  card.append(h('div', 'stand-foot', h('span'), kBtn('link-btn', null, () => showQuay(i), 'Show on map ', kIcon('right', 14))));
  return card;
}
// Scheduled time; a delay follows as "+4 min" in the alarm colour
function callTime(stop: OdCheckpoint, which: 'departure' | 'arrival', strong?: boolean) {
  const t = stop[which] || stop[which === 'departure' ? 'arrival' : 'departure'];
  if (!t) return h('span', 'tl-time');
  return h('span', 'tl-time', strong ? h('b', null, fmtTime(t)) : h('span', null, fmtTime(t)), kDelay(lateMin(stop, which)));
}
// Real-time state as a word, never by colour alone
function liveTag(st: JourneyRideStep) {
  const p = (st.s.departure.prognosis && st.s.departure.prognosis.departure) || (st.s.arrival.prognosis && st.s.arrival.prognosis.arrival);
  return h('span', 'live-tag ' + (p ? 'predicted' : 'timetable'), p ? h('i', 'live-dot') : kIcon('clock', 12), p ? 'Expected' : 'Timetable');
}
function rideBlock(st: JourneyRideStep, i: number) {
  const s = st.s, j = s.journey, mode = modeOf(j.category);
  const list = j.passList || [];
  const stops = Math.max(0, list.length - 2);
  const rideS = Math.max(0, (st.t1! - st.t0!) / 1000);
  const open = openStops.has(i);
  const li = lineVars(h('li', 'tl-ride'), j);
  li.append(h('div', 'tl-row board',
    callTime(s.departure, 'departure', true),
    h('span', 'tl-rail ride first', h('i', 'tl-node', kIcon(MODE_K[mode] || 'bus', 15))),
    h('span', 'tl-name', h('strong', null, s.departure.station!.name)),
    kPlat(quayOf(st, 'dep'))));
  li.append(h('div', 'tl-row', h('span', 'tl-time'), h('span', 'tl-rail ride'),
    h('div', 'tl-main',
      standCard(st, i),
      h('div', 'ride-line', kBadge(j, 'lg'), kIcon('go', 14), h('span', 'ride-head', j.to)),
      h('div', 'ride-sum',
        stops > 0 ? kBtn('expander', null, () => { if (open) openStops.delete(i); else openStops.add(i); renderBody(); }, kIcon(open ? 'up' : 'down', 16), `Ride ${stops + 1} stops · ${kDur(rideS)}`)
          : h('span', 'quiet-line', `Non-stop · ${kDur(rideS)}`),
        liveTag(st)))));
  if (open) list.slice(1, -1).forEach((stop) => li.append(h('div', 'tl-row mid',
    h('span', 'tl-time', h('span', null, fmtTime(liveMs(stop, 'arrival') || liveMs(stop, 'departure')))),
    h('span', 'tl-rail ride', h('i', 'tl-stopdot')),
    h('span', 'tl-name', (stop.station && stop.station.name) || ''))));
  li.append(h('div', 'tl-row alight', callTime(s.arrival, 'arrival'), h('span', 'tl-rail ride last', h('i', 'tl-enddot')),
    h('span', 'tl-name', s.arrival.station!.name), kPlat(quayOf(st, 'arr'))));
  return li;
}
function footNote() {
  const p = (SETTINGS.prefs ? SETTINGS.prefs() : {}) as Settings;
  const walks = journeySteps.filter((st) => st.type === 'walk' || st.type === 'change');
  const mins = walks.reduce((sum, st) => sum + walkMinOf(st), 0);
  const dists = walks.map(walkDist);
  const dist = dists.every((d) => d != null) ? dists.reduce((a, b) => a + b, 0) : null;
  const kmh = p.walkKmh ? Number(p.walkKmh).toFixed(1).replace('.0', '') : '';
  const changes = Math.max(0, journeySteps.filter((st) => st.type === 'ride').length - 1);
  return h('p', 'foot-note',
    (mins > 0 ? `${kDur(mins * 60)} on foot${dist ? ` (${fmtDist(dist)})` : ''}${kmh ? ` at ${kmh} km/h` : ''}` : 'No walking on this journey') +
    (p.extraChangeMin > 0 && changes > 0 ? ` · ${p.extraChangeMin} min extra change time` : ''));
}
function buildBody() {
  if (journeyList && journeyOptions) return listBody();
  const frag = document.createDocumentFragment();
  if (!journeyConn) {
    if (sheetMsg === 'Finding a connection…') for (let k = 0; k < 4; k++) frag.append(h('div', 'skeleton'));
    return frag;
  }
  if (!routeOverview) frag.append(kBtn('pill-btn overview-btn', null, overview, kIcon('map', 16), 'Show full journey'));
  const tl = h('ol', 'tl');
  const first = journeySteps[0];
  if (first && first.type === 'walk') tl.append(placeRow(first.t0, journeyFrom, 'from'));
  journeySteps.forEach((st, i) => {
    if (st.type === 'ride') tl.append(rideBlock(st, i));
    else if (st.type === 'walk' || st.type === 'change') tl.append(walkBlock(st, i));
  });
  const last = journeySteps.filter((st) => st.type !== 'arrive').pop();
  if (last && last.type === 'walk' && last.final) tl.append(placeRow(journeyEnd(), journeyDest ? journeyDest.title : 'Destination', 'to'));
  frag.append(tl, footNote(), h('div', 'sheet-end'));
  return frag;
}
function renderBody() {
  const top = jBody.scrollTop;
  jBody.replaceChildren(buildBody());
  jBody.scrollTop = top;
}
let ticketFoot: { conn: OdConnection; tracking: boolean; arrival: HTMLElement; refresh?: () => void } | null = null;
function renderFoot() {
  if (!journeyConn || journeyList) { jFoot.replaceChildren(); ticketFoot = null; return; }
  const end = journeyEnd(), start = new Date(journeyConn.from.departure!).getTime();
  const arrival = h('span', 'actionbar-sum', h('small', null, `Arrive ${fmtTime(end)}`),
    h('b', null, kDur((end - start) / 1000)));
  const tracking = SETTINGS.prefs().fareTracking;
  if (ticketFoot?.conn === journeyConn && ticketFoot.tracking === tracking && ticketFoot.arrival.isConnected) {
    ticketFoot.arrival.replaceWith(arrival);
    ticketFoot.arrival = arrival;
    return;
  }
  const ticket = ticketLink();
  const pricing = ticketPricing(!!ticket);
  jFoot.replaceChildren(h('div', 'actionbar',
    kBtn('pill-btn start', null, startFollowing, kIcon('nav', 18), 'Start'),
    ticket,
    kBtn('round-btn', 'Share journey', shareJourney, kIcon('share', 18)),
    arrival),
    ...(pricing ? [pricing.row] : []),
    ...(pricing?.form ? [pricing.form] : []));
  ticketFoot = { conn: journeyConn, tracking, arrival, refresh: pricing?.refresh };
}
window.addEventListener('pricing-history-change', () => {
  if (!ticketFoot?.arrival.isConnected) return;
  renderFoot();
  ticketFoot?.refresh?.();
});
function renderSheet() {
  renderHead(true);
  renderBody();
  renderFoot();
  if (document.body.classList.contains('journey-mode') && sheetDetent === 'low') placeSheet('low', true); // the header's height may have changed
}
let sheetQueued = false, timesQueued = false;
// times: the trip's times have changed too, so the pill, the bar and the footer follow
function queueSheet(times?: boolean) {
  if (times) timesQueued = true;
  if (sheetQueued) return;
  sheetQueued = true;
  requestAnimationFrame(() => {
    const t = timesQueued;
    sheetQueued = timesQueued = false;
    if (!journeyConn) return;
    renderHead();
    renderBody();
    if (!t) return;
    document.getElementById('jDep')!.textContent = fmtTime(journeyConn.from.departure);
    updatePillTimes();
    renderBar();
    renderFoot();
  });
}
