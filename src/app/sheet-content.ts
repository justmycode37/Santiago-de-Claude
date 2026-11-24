// ---- 3D station view (station-view.ts through Station3D): for walks and changes in a station that has a 3D model (stations3d/) ----
import { showToast } from '../toast.ts';
import { userLngLat } from './location.ts';
import { jBody, jFoot, jHead, refreshRouteHighlight } from './journey-map.ts';
import { dayLabel, fmtTime, hasForecast, isRide, journeyEnd, journeyStart, kDur, kDurExact, lateMin, levelChange, lineVars, liveMs, modeOf, planMs, spareOf, stopName, stopUic } from './journey-steps.ts';
import { liveParts, replan } from './live-line.ts';
import { livePoll } from './live-engine.ts';
import { cap, compassWord, fmtDist, levelShort, platformOf } from './live-vehicles.ts';
import { MODE_K, STEP_K, chainIcon, h, kBadge, kBtn, kDelay, kIcon, kPlat, openDirs, openStops, placeSheet, quayOf, setDetent, sheetDetent } from './sheet.ts';
import type { KIconName } from './sheet.ts';
import { ticketPricing } from './ticket-pricing.ts';
import { focusDir, overview, shareJourney, showQuay, startFollowing, ticketLink } from './journey-actions.ts';
import { arStepButton } from './ar.ts';
import { fitJourney, goToStep, renderBar, renderJourney, retryJourney, updatePillTimes } from './pill.ts';
import { dateValue } from './time-picker.ts';
import { distKm, endJourney, refineJourney } from './routing.ts';
import type { StopTime } from './journey-steps.ts';
import { journey, searchState, sheet, tracking } from './state.ts';
import { SETTINGS } from '../settings.ts';
import { KanteJourney } from '../engine-journey.ts';
import { Station3D } from '../station3d.ts';
import type { Journey, JourneyPlatformAt } from '../engine-journey.ts';
import type { StationRouteStopRef } from '../station-route.ts';
import type { Station3DEndpoint } from '../station3d.ts';
import type { RideEnd, Station3DTrain } from '../train-formation.ts';
import type { JourneyChangeStep, JourneyDirection, JourneyRideStep, JourneyStep, JourneyWalkStep } from './journey-steps.ts';
import type { StationWalkPlan } from './routing.ts';
import type { Quay } from './sheet.ts';
import type { JourneyMoreDir, JourneyTab } from './state.ts';
const S3_NEAR_KM = 0.5; // a station model reaches about this far around its platforms
const s3Key = (stop: KanteStopCall | null | undefined) => (Station3D && stop && Station3D.has(stopUic(stop))) || null;
// A ride's boarding / alighting point for the station router: the platform, with its position as a fallback
/** What s3End() fills in: the platform, its position, or both. */
interface S3EndParts { stop?: StationRouteStopRef; ll?: LngLat; level?: number | null }
function s3End(stop: KanteStopCall, at: JourneyPlatformAt | null | undefined): Station3DEndpoint | null {
  const edge = at && at.edge, raw = platformOf(stop);
  const ref = raw !== '–' ? raw : (edge && edge.ref) || '';
  const ll = (at && at.ll) || ([stop.quay.lon, stop.quay.lat] as LngLat);
  const end: S3EndParts = {};
  if (ref) end.stop = { uic: stopUic(stop), ref };
  if (ll) end.ll = ll;
  if (edge && edge.level != null) end.level = edge.level;
  return end as Station3DEndpoint;
}
// Compass direction from a to b (degrees, 0 = north), or null when they are the same point
function bearingOf(a: LngLat | undefined, b: LngLat | undefined): number | null {
  if (!a || !b) return null;
  const dx = (b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), dy = b[1] - a[1];
  return dx || dy ? (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 : null;
}
const RIDE_MODE: Partial<Record<KanteMode, Station3DTrain['mode']>> = { rail: 'train', tram: 'tram', bus: 'bus' };
// A ride for the 3D view, at its boarding end (role 'board') or its alighting end ('alight'), with both ends and the
// walks before and after it, so that the coach is chosen once for the whole ride (coach-plan.ts). Only trains (from a
// known platform), trams and buses.
// The trains in a row with this ride: the rides before and after it reached by a change (not a walk) from train to
// train, in order. Their coaches are chosen together (coach-plan.ts).
function trainChain(ride: JourneyRideStep): JourneyRideStep[] {
  const steps = journey.steps, i = steps.indexOf(ride);
  const isTrain = (st: JourneyStep | undefined): st is JourneyRideStep => !!st && st.type === 'ride' && !!st.s.legs[0] && st.s.legs[0].line.mode === 'rail';
  if (i < 0) return [ride];
  const out = [ride];
  for (let j = i; steps[j - 1] && steps[j - 1].type === 'change' && isTrain(steps[j - 2]); j -= 2) out.unshift(steps[j - 2] as JourneyRideStep);
  for (let j = i; steps[j + 1] && steps[j + 1].type === 'change' && isTrain(steps[j + 2]); j += 2) out.push(steps[j + 2] as JourneyRideStep);
  return out;
}
function s3Ride(ride: JourneyRideStep | null | undefined, role: 'board' | 'alight', inChain = false): Station3DTrain | null {
  if (!ride) return null;
  const legs = ride.s.legs, first = legs[0], last = legs[legs.length - 1];
  const mode = first && RIDE_MODE[first.line.mode];
  if (!first || !mode) return null;
  const bc = ride.s.stops[0], ac = ride.s.stops[ride.s.stops.length - 1];
  if (!bc || !ac || (mode === 'train' && !(role === 'board' ? bc : ac).quay.label)) return null;
  const steps = journey.steps, i = steps.indexOf(ride);
  const before = i > 0 ? steps[i - 1] : null, after = i >= 0 && i + 1 < steps.length ? steps[i + 1] : null;
  const kb = s3Key(bc), ka = s3Key(ac);
  const wb = before && before.type !== 'ride' ? s3Core(before, true) : null, wa = after && after.type !== 'ride' ? s3Core(after, true) : null;
  const g0 = first.geometry || [], g1 = last.geometry || [];
  const end = (c: KanteStopCall, key: string | null, walk: Station3DEndpoint | null, ll: LngLat | null, heading: number | null): RideEnd => ({
    uic: stopUic(c), ref: c.quay.label || '', sectors: c.quay.sectors || '', name: stopName(c), key, walk, ll, heading,
  });
  const board = end(bc, kb, wb && wb.key === kb ? wb.from : null, ride.depLL, first.bearing ?? bearingOf(g0[0], g0[1]));
  const alight = end(ac, ka, wa && wa.key === ka ? wa.to : null, ride.arrLL, bearingOf(g1[g1.length - 2], g1[g1.length - 1]));
  // a change from another train: the walk to this one starts at the door of the coach you arrive in
  if (role === 'board' && before && before.type === 'change' && before.prevRide && !inChain) board.via = s3Ride(before.prevRide, 'alight', true);
  const leg = role === 'board' ? first : last, call = role === 'board' ? bc : ac;
  // trains in a row: each at its boarding end, without chains of their own
  const chain = !inChain && mode === 'train' ? trainChain(ride).map((r) => (r === ride ? null : s3Ride(r, 'board', true))) : null;
  if (chain) chain[chain.indexOf(null)] = s3Ride(ride, 'board', true);
  return {
    chain: chain && chain.length > 1 && chain.every(Boolean) ? chain as Station3DTrain[] : null,
    id: [first.tripId, first.serviceDate, board.uic].join('|'), mode, role, board, alight, through: legs.length === 1,
    number: leg.number || '', operator: leg.line.operator || '', category: leg.line.category || '', line: leg.line.name || '',
    headsign: first.headsign || '', date: first.serviceDate, dep: bc.dep ?? null, delayS: bc.depDelayS ?? null,
    uic: stopUic(call), ref: call.quay.label || '', sectors: call.quay.sectors || '',
    // where you get off: the end of its first trip (you stay seated on any after it, in the same coaches)
    toUic: stopUic(first.to), toName: stopName(first.to),
  };
}
// Where a step's walk starts and ends inside the modelled station (with the vehicles at either end: the one you
// get off, the one you get on), or null when it is not in one
export function s3Plan(st: JourneyStep): StationWalkPlan | null {
  const core = s3Core(st);
  if (!core) return null;
  const { key } = core;
  let board: Station3DTrain | null = null, alight: Station3DTrain | null = null;
  if (st.type === 'walk' && st.next) board = s3Ride(st.nextRide, 'board');
  else if (st.type === 'walk') alight = s3Ride(st.prevRide, 'alight');
  else if (st.type === 'change') {
    if (s3Key(st.next.from) === key) board = s3Ride(st.nextRide, 'board');
    if (s3Key(st.prev.to) === key) alight = s3Ride(st.prevRide, 'alight');
  }
  return { ...core, board, alight };
}
// planned: the walk as planned, from where the trip starts (not from where you are now): the coach for a ride is
// chosen from it, the same whenever it is asked for
function s3Core(st: JourneyStep, planned = false): StationWalkPlan | null {
  let key = null, from = null, to = null;
  if (st.type === 'walk' && st.next) {
    key = s3Key(st.next.from);
    const here = searchState.tripStart || planned ? null : userLngLat; // a trip from somewhere else starts there, not where you are
    const start = here || (st.lines[0] && st.lines[0][0]);
    to = s3End(st.next.from, st.nextRide && st.nextRide.depAt);
    // from further away the model only shows the last stretch: where the walk comes in, not where you are
    const far = start && to && to.ll && distKm(start, to.ll) > S3_NEAR_KM;
    from = start ? (far ? { ll: start, label: 'the way in' } : here ? { ll: start } : { ll: start, label: 'the start' }) : null;
  } else if (st.type === 'walk') {
    key = st.from ? s3Key(st.from.to) : null;
    from = key && s3End(st.from!.to, st.prevRide && st.prevRide.arrAt);
    const end = (journey.dest && journey.dest.lngLat) || (st.lines.length ? st.lines[st.lines.length - 1][1] : null);
    const far = end && from && from.ll && distKm(from.ll, end) > S3_NEAR_KM;
    to = end ? { ll: end, label: far ? `the way to ${st.toName}` : st.toName } : null;
  } else if (st.type === 'change') {
    const ka = s3Key(st.prev.to), kb = s3Key(st.next.from);
    key = kb || ka;
    from = ka === key ? s3End(st.prev.to, st.prevRide && st.prevRide.arrAt)
      : st.points[0] ? { ll: st.points[0], label: stopName(st.prev.to) } : null;
    to = kb === key ? s3End(st.next.from, st.nextRide && st.nextRide.depAt)
      : st.points[1] ? { ll: st.points[1], label: stopName(st.next.from) } : null;
  }
  return key && from && to ? { key, from, to } : null;
}
// The journey options for the station router, for the day of that step (closures in the model have dates)
export const s3Prefs = (st: JourneyStep | null | undefined) => ({ ...SETTINGS.journey(), date: st && st.t0 ? dateValue(new Date(st.t0)) : undefined });
function s3Open(st: JourneyStep, button: HTMLElement | null) {
  const plan = s3Plan(st); // now, not when the sheet was drawn: the start follows your position
  if (!plan) return;
  sheet.s3Step = st;
  Station3D.open({ ...plan, prefs: s3Prefs(st), returnFocus: button });
}

function walkTarget(st: JourneyStep) {
  const r = st.type === 'change' || !st.final ? st.nextRide : null;
  if (!r) return st.toName || (journey.dest && journey.dest.title) || 'your destination';
  const q = quayOf(r, 'dep');
  return q.label ? `${q.word} ${q.label}` : stopName(r.s.from);
}
// Metres on foot, once every part of the walk has been routed (null until then)
function walkDist(st: JourneyStep) {
  const lines = st.lines || [];
  if (!lines.length) return 0;
  const ws = st.walks || [];
  return lines.every((_, k) => ws[k] && ws[k].dist != null) ? ws.reduce((sum, w) => sum + (w ? w.dist! : 0), 0) : null;
}
const walkMinOf = (st: JourneyStep) => (st.type === 'change' ? st.walkMin || 0 : st.min || 0);
// Metres climbed on foot, as the engine counts them ("↑ 25 m" from 10 m: less is the lie of the land)
function walkClimb(st: JourneyStep) {
  const m = (st.walks || []).reduce((sum, w) => sum + ((w && w.climb) || 0), 0);
  return m >= 10 ? Math.round(m / 5) * 5 : 0;
}

// Written directions for a walk, from the engine's and the station models' directions, with the floor change in its place
export function walkDirections(st: JourneyStep) {
  if (st._dirsV === tracking.geoVersion) return st._dirs!;
  const out: JourneyDirection[] = [];
  (st.walks || []).forEach((w) => {
    // the engine's walk, or a stretch through a modelled station: its own directions, floor changes included
    if (w && w.dirs) out.push(...w.dirs);
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
  st._dirsV = tracking.geoVersion;
  return out;
}

// What to do first, and when: the verb is yours when the trip starts on foot ("Leave in 4 min"), the vehicle's otherwise
function firstAction(now: number) {
  const first = journey.steps[0], ride = journey.steps.find((st) => st.type === 'ride');
  const walkFirst = first && first.type === 'walk';
  const when = walkFirst ? first.t0 : ride ? ride.t0 : null;
  if (when == null) return { text: '', quay: ride && quayOf(ride, 'dep') };
  const s = (when - now) / 1000;
  let text = '';
  if (s < -45) text = `Left ${kDur(-s)} ago`;
  else if (s < 60) text = walkFirst ? 'Leave now' : 'Leaves now';
  else if (s < 3600) text = `${walkFirst ? 'Leave' : 'Leaves'} in ${kDur(Math.floor(s / 60) * 60)}`;
  const late = ride ? lateMin(ride.s.from, 'dep') : 0;
  const forecast = ride && hasForecast(ride.s.from, 'dep');
  return { text, gone: s < -45, state: !forecast ? 'plain' : late > 0 ? 'late' : 'ok', delay: late, quay: ride && quayOf(ride, 'dep') };
}

function legChain() {
  const rides = journey.steps.some((st) => st.type === 'ride'); // a walk-only journey keeps its walk
  const items = journey.steps.filter((st) => st.type === 'ride' || ((st.type === 'walk' || st.type === 'change') && (!rides || walkMinOf(st) > 3)));
  const max = 7, cut = items.length > max ? items.slice(0, max - 1) : items;
  const chain = h('span', 'chain');
  chain.setAttribute('aria-hidden', 'true');
  cut.forEach((st, i) => {
    if (i) chain.append(kIcon('right', 12, 'chain-sep'));
    chain.append(st.type === 'ride' ? kBadge(st.s.line, null, chainIcon(st.s.line))
      : h('span', 'chain-walk', kIcon('walk', 14), String(walkMinOf(st))));
  });
  if (cut.length < items.length) chain.append(h('span', 'chain-more', `+${items.length - cut.length}`));
  return chain;
}
// The sheet's handle moves it between the map and the list; this closes the journey
function sheetActions() {
  return h('span', 'sheet-actions', kBtn('round-btn', 'Close journey', () => endJourney(), kIcon('close', 18)));
}
// A walking direction picked: step through them, or back to the whole journey
function stepNav(): HTMLDivElement {
  const st = journey.steps[sheet.focus!.step], dirs = st ? walkDirections(st) : [], k = sheet.focus!.dir, d = dirs[k];
  if (!d) { sheet.focus = null; return buildHead(); }
  const text = h('div', 'stepnav-text', h('small', null, `${k + 1} of ${dirs.length}`), h('strong', 'trunc2', d.text));
  text.setAttribute('aria-live', 'polite');
  const prev = kBtn('round-btn', 'Previous direction', () => focusDir(sheet.focus!.step, k - 1), kIcon('back', 18));
  const next = kBtn('round-btn', 'Next direction', () => focusDir(sheet.focus!.step, k + 1), kIcon('go', 18));
  prev.disabled = k === 0;
  next.disabled = k === dirs.length - 1;
  return h('div', 'stepnav', prev, text, next, kBtn('round-btn', 'Show full journey', overview, kIcon('close', 18)));
}
// ---- The journeys to choose from (the list of the Kante app, branch nikitas-implementation): one row each with
//      its vehicles, times and first boarding point; walking all the way, when that is near enough, on a tab of
//      its own. The one shown first is drawn on the map; a tap on a row opens that journey. ----
export const optionCount = () => (journey.options ? journey.options.list.length + (journey.options.walk ? 1 : 0) : 0);
export const connStart = (c: Journey) => c.t0;
export const connEnd = (c: Journey) => c.t1;
const connSecs = (c: Journey) => Math.max(0, connEnd(c) - connStart(c)) / 1000;

function optionRow(conn: Journey, now: number) {
  const rides = conn.parts.filter(isRide), first = rides[0];
  const t0 = connStart(conn), t1 = Math.max(connEnd(conn), t0 + 60000);
  // line 1: every vehicle's badge, with the walks between them, and how long it all takes
  const chain = h('span', 'chain');
  chain.setAttribute('aria-hidden', 'true');
  let walkS = 0, over = false;
  const long = KanteJourney.longWalks(conn); // a walk longer than the maximum walk of Settings stands out
  const add = (node: HTMLElement) => { if (chain.childNodes.length) chain.append(kIcon('right', 12, 'chain-sep')); chain.append(node); };
  const addWalk = () => {
    const m = Math.round(walkS / 60);
    if (m > 3) add(h('span', 'chain-walk' + (over ? ' over' : ''), kIcon('walk', 14), String(m)));
    walkS = 0; over = false;
  };
  conn.parts.forEach((s) => {
    if (s.type === 'walk') { walkS += KanteJourney.walkSecs(s); over = over || long.has(s.kind); return; }
    addWalk();
    add(kBadge(s.line, null, chainIcon(s.line)));
  });
  addWalk();
  // line 2: the two times, and between them the rides to scale (a ring where you change)
  const bar = h('span', 'tbar', h('i', 'tbar-base'));
  bar.setAttribute('aria-hidden', 'true');
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - t0) / (t1 - t0)) * 100));
  rides.forEach((s, k) => {
    const a = pct(liveMs(s.from, 'dep')!), b = pct(liveMs(s.to, 'arr')!);
    const ride = lineVars(h('i', 'tbar-ride'), s.line);
    ride.style.left = a + '%';
    ride.style.width = Math.max(4, b - a) + '%';
    bar.append(ride);
    if (!k) return;
    const change = h('i', 'tbar-change');
    change.style.left = pct((liveMs(rides[k - 1].to, 'arr')! + liveMs(s.from, 'dep')!) / 2) + '%';
    bar.append(change);
  });
  bar.append(h('i', 'tbar-end a'), h('i', 'tbar-end b'));
  // line 3: where it leaves from, in how long, and the changes (with the time there is for the tightest)
  const walkFirst = !isRide(conn.parts[0]);
  const secs = ((walkFirst || !first ? t0 : liveMs(first.from, 'dep')!) - now) / 1000;
  const gone = secs < -45;
  const text = gone ? `Left ${kDur(-secs)} ago` : secs < 60 ? (walkFirst ? 'Leave now' : 'Leaves now')
    : secs < 3600 ? `${walkFirst ? 'Leave' : 'Leaves'} in ${kDur(Math.floor(secs / 60) * 60)}` : '';
  const late = first ? lateMin(first.from, 'dep') : 0;
  const forecast = first && hasForecast(first.from, 'dep');
  const gaps = rides.slice(1).map((s, k) => Math.max(0, Math.floor((liveMs(s.from, 'dep')! - liveMs(rides[k].to, 'arr')!) / 60000)));
  const changes = !rides.length ? ['On foot'] : !gaps.length ? ['Direct']
    : [`${gaps.length} ${gaps.length === 1 ? 'change' : 'changes'}`, `· ${gaps.length === 1 ? '' : '≥ '}${Math.min(...gaps)} min`];
  const row = kBtn('jrow' + (gone ? ' gone' : '') + (conn === journey.conn ? ' shown' : ''), null, () => openOption(conn),
    h('span', 'jrow-l1', chain, h('b', 'jrow-dur', kDur((t1 - t0) / 1000))),
    h('span', 'jrow-l2', h('b', 'jrow-time', fmtTime(conn.t0)), bar, h('b', 'jrow-time end', fmtTime(conn.t1))),
    h('span', 'jrow-l3', h('span', 'jrow-plat', first ? kPlat(quayOf({ s: first }, 'dep')) : null),
      h('span', 'jrow-mid',
        text ? h('span', 'jrow-act ' + (gone ? 'gone' : !forecast ? 'plain' : late > 0 ? 'late' : 'ok'), text, gone ? null : kDelay(late)) : null,
        h('span', 'jrow-chg', changes.map((t) => h('span', null, t))))));
  if (conn === journey.conn) row.setAttribute('aria-current', 'true'); // the one drawn on the map
  return row;
}
function walkCard(conn: Journey) {
  const m = conn.walkM;
  return kBtn('walkcard', null, () => openOption(conn),
    h('span', 'walkcard-big', h('b', null, kDur(connSecs(conn))), h('span', null, m ? fmtDist(m) : '')),
    h('span', 'walkcard-sub', `${fmtTime(conn.t0)} – ${fmtTime(conn.t1)}`),
    h('span', 'walkcard-cta', 'Walking directions', kIcon('right', 16)));
}
function listHead() {
  const o = journey.options!;
  let title = h('h2', 'trunc', 'Journeys'); // (an h1 here is a place name, which the translator leaves alone)
  if (o.walk && o.list.length) {
    // public transport (its quickest journey) · on foot
    const tab = (key: JourneyTab, icon: KIconName, secs: number, label: string) => {
      const b = kBtn(journey.tab === key ? 'on' : '', `${label}, ${kDur(secs)}`, () => setJourneyTab(key), kIcon(icon, 20), kDur(secs));
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(journey.tab === key));
      return b;
    };
    title = h('div', 'tabs', tab('pt', 'rail', Math.min(...o.list.map(connSecs)), 'Public transport'), tab('walk', 'walk', connSecs(o.walk), 'On foot'));
    title.setAttribute('role', 'tablist');
    title.setAttribute('aria-label', 'How to travel');
  }
  return h('div', 'jhead', h('div', 'sheet-title', title, sheetActions()));
}
function listBody() {
  const o = journey.options!, now = Date.now(), frag = document.createDocumentFragment();
  if (journey.tab === 'walk' && o.walk) {
    frag.append(walkCard(o.walk), h('div', 'list-end'));
    return frag;
  }
  const more = (dir: JourneyMoreDir) => {
    const b = kBtn('more', null, () => loadMoreJourneys(dir), kIcon(dir === 'earlier' ? 'up' : 'down', 16),
      journey.more === dir ? `Loading ${dir} journeys…` : cap(dir));
    b.disabled = !!journey.more;
    return b;
  };
  if (o.earlier) frag.append(more('earlier'));
  const ol = h('ol', 'journeys');
  let lastDay = 'Today';
  o.list.forEach((conn) => {
    const day = dayLabel(conn.t0);
    ol.append(h('li', null, day !== lastDay ? h('div', 'day-sep', day) : null, optionRow(conn, now)));
    lastDay = day;
  });
  frag.append(ol);
  if (o.later) frag.append(more('later'));
  frag.append(h('div', 'list-end'));
  return frag;
}
// Make one of the journeys the one on the map (and the one the sheet is about, once it is opened)
function showOption(conn: Journey) {
  if (conn === journey.conn || !journey.dest) return;
  const id = ++journey.req; // what was still being fetched for the last one is dropped
  openDirs.clear();
  openStops.clear();
  renderJourney(conn, journey.dest.title);
  refineJourney(id);
  livePoll(); // live times for its rides at once
}
// A row tapped: that journey, as before (the header gets a way back to the list)
function openOption(conn: Journey) {
  journey.list = false;
  if (conn === journey.conn) renderSheet();
  else showOption(conn);
  setDetent('low', true); // the map with that journey, its times, and Start
}
function showOptions() {
  if (optionCount() < 2) return;
  journey.list = true;
  sheet.focus = null;
  if (!journey.overview) { journey.overview = true; refreshRouteHighlight(); }
  renderSheet();
  if (sheetDetent === 'low') setDetent('mid', true);
  else fitJourney();
}
function setJourneyTab(tab: JourneyTab) {
  const o = journey.options;
  if (!o || tab === journey.tab) return;
  journey.tab = tab;
  const conn = tab === 'walk' ? o.walk : o.best !== o.walk ? o.best : o.list[0];
  if (conn && conn !== journey.conn) showOption(conn);
  else renderSheet();
}
// "Earlier" / "Later": more journeys for the same trip (from the Kante engine)
async function loadMoreJourneys(dir: JourneyMoreDir) {
  const o = journey.options;
  if (!o || journey.more) return;
  journey.more = dir;
  renderBody();
  try { await KanteJourney.more(o, dir); }
  catch (e) { showToast(`${cap(dir)} journeys could not be loaded.`); }
  if (o !== journey.options) return; // another trip has been planned meanwhile
  journey.more = null;
  if (journey.list) renderBody();
}
// The countdowns in the rows ("Leaves in 6 min") move on with the clock
export function refreshList() {
  if (!journey.list || !journey.options) return;
  const fresh = document.createElement('div');
  fresh.append(buildBody());
  if (fresh.innerHTML !== jBody.innerHTML) renderBody();
}

function buildHead(): HTMLDivElement {
  if (journey.list && journey.options) return listHead();
  if (sheet.focus) return stepNav();
  const head = h('div', 'jhead');
  if (!journey.conn) {
    head.append(h('div', 'sheet-title', h('h1', 'trunc', journey.dest ? journey.dest.title : 'Journey'), sheetActions()));
    // the engine could not be reached: a way to ask it again, with the same trip
    const retry = sheet.retry && journey.dest ? kBtn('pill-btn small', null, retryJourney, kIcon('refresh', 16), 'Try again') : null;
    if (sheet.msg) head.append(h('div', 'jhead-act', h('span', 'jrow-act gone', sheet.msg), retry));
    return head;
  }
  const now = Date.now(), end = journeyEnd();
  const rides = journey.steps.filter((st) => st.type === 'ride');
  const tr = Math.max(0, rides.length - 1);
  const onFoot = () => { const d = walkDist(journey.steps[0]); return d ? `${fmtDist(d)} on foot` : 'On foot'; };
  const start = journeyStart();
  const following = document.body.classList.contains('following'); // under way: the pill at the top has the two times
  head.append(
    h('div', 'sheet-title',
      optionCount() > 1 && !following ? kBtn('round-btn', 'All journeys', showOptions, kIcon('back', 18)) : null,
      legChain(), sheetActions()));
  if (!following) head.append(
    h('div', 'jhead-times', h('b', null, `${fmtTime(start)} – ${fmtTime(end)}`),
      h('span', null, `${kDur((end - start) / 1000)} · ${!rides.length ? onFoot() : tr === 0 ? 'Direct' : `${tr} ${tr === 1 ? 'change' : 'changes'}`}`)));
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
export function renderHead(force?: boolean) {
  const node = buildHead();
  const key = node.outerHTML;
  if (!force && key === sheet.headKey) return; // unchanged: leave it alone (and its buttons pressable)
  sheet.headKey = key;
  jHead.replaceChildren(node);
}

function placeRow(t: number | null | undefined, name: string, kind: 'from' | 'to') {
  return h('li', 'tl-row tl-place ' + kind,
    h('span', 'tl-time', h('b', null, fmtTime(t))),
    h('span', 'tl-rail', h('i', kind === 'from' ? 'od-ring' : 'od-pin')),
    h('span', 'tl-name', h('strong', null, name)));
}
function spareLine(st: JourneyChangeStep) {
  const { s, level, extra, short, est, text } = spareOf(st);
  const note = short ? ` — less than your ${extra} min extra change time` : est ? ' — the walk is estimated' : '';
  return h('div', 'spare ' + level, kIcon(level === 'ok' ? 'check' : 'alert', 15),
    level === 'missed' ? h('span', null, h('b', null, est ? `Change may be missed — about ${Math.max(1, Math.round(-s / 60))} min short` : `Missed change — ${kDurExact(-s)} too late`))
      : h('span', null, h('b', null, text), note ? h('small', null, note) : null));
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
  const secs = mins ? mins * 60 : st.walkS || 0; // a walk of a few seconds (to a door) is "< 1 min", not "0 min"
  const target = walkTarget(st);
  if (transfer) {
    const pq = quayOf(st.prevRide!, 'arr'), nq = quayOf(st.nextRide!, 'dep');
    const samePlace = stopName(st.prev.to) === stopName(st.next.from);
    if (!mins && !(st.lines && st.lines.length) && samePlace && pq.label && pq.word === nq.word && pq.label === nq.label) {
      return h('li', 'tl-row tl-walk same', h('span', 'tl-time'), h('span', 'tl-rail walk'),
        h('div', 'tl-main', h('strong', null, `Change at the same ${nq.word.toLowerCase()}`), spareLine(st)));
    }
  }
  const dist = walkDist(st);
  const climb = walkClimb(st);
  const lvl = levelChange(st);
  const pq = (transfer && quayOf(st.prevRide!, 'arr')) as Quay, nq = (transfer && quayOf(st.nextRide!, 'dep')) as Quay;
  const spare = st.type === 'change' ? spareOf(st) : null;
  // (how long the walk takes is in the time column beside it)
  const meta = [
    !mins && transfer && pq.label && nq.label ? (pq.word === nq.word ? `${pq.word} ${pq.label} → ${nq.label}` : `${pq.short} ${pq.label} → ${nq.short} ${nq.label}`) : '',
    dist ? fmtDist(dist) : '',
    climb ? `↑ ${climb} m` : '',
    lvl ? lvl.text.replace(/^Go /, '') : '',
    spare && spare.easy ? spare.text : '',
  ].filter(Boolean).join(' · ');
  const active = !journey.overview && journey.step === i;
  const dirs = walkDirections(st);
  const expanded = openDirs.has(i) || (!!sheet.focus && sheet.focus.step === i);
  const title = `${transfer ? 'Change to' : 'Walk to'} ${target}`;
  const main = h('div', 'tl-main',
    kBtn('walk-sum', `${title}, ${kDur(secs)}${dist ? ', ' + fmtDist(dist) : ''}${climb ? `, ${climb} m uphill` : ''}. Show on map`, () => goToStep(i),
      h('strong', null, title), meta ? h('span', 'walk-meta', meta) : null));
  if (st.type === 'change' && !spare!.easy) main.append(spareLine(st)); // a tight or missed change gets its own line
  // a walk longer than the maximum walk of Settings: the engine takes it only where nothing nearer gets there as soon
  if (st.type === 'walk' && journey.conn && KanteJourney.longWalks(journey.conn).has(st.final ? 'egress' : 'access')) {
    main.append(h('div', 'spare tight', kIcon('alert', 15), h('span', null, h('b', null, 'Longer than your maximum walk'),
      h('small', null, ` — ${SETTINGS.prefs().maxWalkMin} min; nothing nearer gets you there as soon`))));
  }
  // The ways to see this step besides the map: the 3D station view (in a modelled station) and the AR camera
  const row = h('div', 'step-views');
  if (s3Plan(st)) row.append(kBtn('view3d', 'Show this walk in 3D, inside the station', (e) => s3Open(st, e.currentTarget as HTMLElement), kIcon('cube', 16), '3D view'));
  const ar = arStepButton(st);
  if (ar) row.append(ar);
  if (row.childNodes.length) main.append(row);
  if (dirs.length > 1) {
    const toggle = kBtn('expander', null, () => {
      if (expanded) { openDirs.delete(i); if (sheet.focus && sheet.focus.step === i) sheet.focus = null; } else openDirs.add(i);
      renderSheet();
      const again = jBody.querySelector<HTMLElement>(`.expander[data-dirs="${i}"]`);
      if (again) again.focus({ preventScroll: true });
    }, kIcon(expanded ? 'up' : 'down', 16), expanded ? 'Hide directions' : `Walking directions (${dirs.length})`);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.dataset.dirs = String(i);
    main.append(toggle);
    if (expanded) main.append(h('ol', 'steps', dirs.map((d, k) => stepRow(d, !!sheet.focus && sheet.focus.step === i && sheet.focus.dir === k, () => focusDir(i, k)))));
  }
  return h('li', 'tl-row tl-walk' + (active ? ' active' : ''),
    h('span', 'tl-time', h('small', null, kDur(secs))),
    h('span', 'tl-rail walk', kIcon('walk', 18)),
    main);
}

// Where to stand: what the boarding row above it does not say (which side of the road, the sectors, the level,
// the way the vehicle leaves). One row; a tap shows the boarding point on the map. Nothing when nothing is known.
function standCard(st: JourneyRideStep, i: number) {
  const q = quayOf(st, 'dep'), edge = q.edge;
  const bearing = q.travel;
  const side = edge && edge.side ? cap(edge.side) : ''; // the engine names the street
  const level = edge && edge.level ? `Level ${levelShort(edge.level)}` : '';
  const next = st.s.stops[1] && stopName(st.s.stops[1]);
  let compass = null;
  if (next && bearing != null) {
    compass = h('span', 'stand-compass', kIcon('arrow', 14));
    compass.style.transform = `rotate(${bearing}deg)`;
    compass.setAttribute('role', 'img');
    compass.setAttribute('aria-label', `Leaves towards the ${compassWord(bearing)}`);
  }
  const info = h('span', 'stand-info',
    side ? h('span', 'stand-side', side) : null,
    q.sectors || level ? h('span', 'stand-tags',
      q.sectors ? h('span', 'tag strong', `${q.sectors.replace(/[^A-Za-z0-9]/g, '').length === 1 ? 'Sector' : 'Sectors'} ${q.sectors}`) : null,
      level ? h('span', 'tag', level) : null) : null,
    next ? h('span', 'stand-dir', compass, h('span', null, 'Next stop: ', h('b', null, next))) : null,
    q.planned ? h('span', 'stand-note warn', kIcon('alert', 16), `Changed today: ${q.word} ${q.label} (was ${q.planned})`) : null,
    !edge ? h('span', 'stand-note', kIcon('info', 16), 'Platform or bay unknown. Map pin shows the stop.') : null);
  if (!info.childNodes.length) return null;
  const card = kBtn('stand', null, () => showQuay(i), info, kIcon('map', 18, 'stand-go'));
  card.title = 'Show on map';
  return card;
}
// Scheduled time; a delay follows as "+4 min" in the alarm colour
function callTime(stop: KanteStopCall, which: StopTime, strong?: boolean) {
  const t = planMs(stop, which) || planMs(stop, which === 'dep' ? 'arr' : 'dep');
  if (!t) return h('span', 'tl-time');
  return h('span', 'tl-time', strong ? h('b', null, fmtTime(t)) : h('span', null, fmtTime(t)), kDelay(lateMin(stop, which)));
}
// Real-time state as a word, never by colour alone
function liveTag(st: JourneyRideStep) {
  const p = hasForecast(st.s.from, 'dep') || hasForecast(st.s.to, 'arr');
  return h('span', 'live-tag ' + (p ? 'predicted' : 'timetable'), p ? h('i', 'live-dot') : kIcon('clock', 12), p ? 'Live times' : 'Timetable');
}
function rideBlock(st: JourneyRideStep, i: number) {
  const s = st.s, j = s.line, mode = modeOf(j.category);
  const list = s.stops;
  const stops = Math.max(0, list.length - 2);
  const rideS = Math.max(0, (st.t1! - st.t0!) / 1000);
  const open = openStops.has(i);
  const li = lineVars(h('li', 'tl-ride'), j);
  li.append(h('div', 'tl-row board',
    callTime(s.from, 'dep', true),
    h('span', 'tl-rail ride first', h('i', 'tl-node', kIcon(MODE_K[mode] || 'bus', 15))),
    h('span', 'tl-name', h('strong', null, stopName(s.from))),
    kPlat(quayOf(st, 'dep'))));
  li.append(h('div', 'tl-row', h('span', 'tl-time'), h('span', 'tl-rail ride'),
    h('div', 'tl-main',
      standCard(st, i),
      h('div', 'ride-line', kBadge(j, 'lg'), kIcon('go', 14), h('span', 'ride-head', s.headsign)),
      h('div', 'ride-sum',
        stops > 0 ? kBtn('expander', null, () => { if (open) openStops.delete(i); else openStops.add(i); renderBody(); }, kIcon(open ? 'up' : 'down', 16), `${stops + 1} stops · ${kDur(rideS)}`)
          : h('span', 'quiet-line', `Non-stop · ${kDur(rideS)}`),
        liveTag(st)))));
  if (open) list.slice(1, -1).forEach((stop) => li.append(h('div', 'tl-row mid',
    h('span', 'tl-time', h('span', null, fmtTime(liveMs(stop, 'arr') || liveMs(stop, 'dep')))),
    h('span', 'tl-rail ride', h('i', 'tl-stopdot')),
    h('span', 'tl-name', stopName(stop)))));
  li.append(h('div', 'tl-row alight', callTime(s.to, 'arr'), h('span', 'tl-rail ride last', h('i', 'tl-enddot')),
    h('span', 'tl-name', stopName(s.to)), kPlat(quayOf(st, 'arr'))));
  return li;
}
// How much walking the journey has in all (nothing for a journey without any)
function footNote() {
  const walks = journey.steps.filter((st) => st.type === 'walk' || st.type === 'change');
  const mins = walks.reduce((sum, st) => sum + walkMinOf(st), 0);
  if (mins <= 0) return null;
  const dists = walks.map(walkDist);
  const dist = dists.every((d) => d != null) ? dists.reduce((a, b) => a + b, 0) : null;
  return h('p', 'foot-note', `Total walking: ${kDur(mins * 60)}${dist ? ` (${fmtDist(dist)})` : ''}`);
}
function buildBody() {
  if (journey.list && journey.options) return listBody();
  const frag = document.createDocumentFragment();
  if (!journey.conn) {
    if (sheet.msg === 'Finding a connection…') for (let k = 0; k < 4; k++) frag.append(h('div', 'skeleton'));
    return frag;
  }
  // (while stepping through directions, the header's own button leads back to the whole journey)
  if (!journey.overview && !sheet.focus) frag.append(kBtn('pill-btn overview-btn', null, overview, kIcon('map', 16), 'Show full journey'));
  const tl = h('ol', 'tl');
  const first = journey.steps[0];
  if (first && first.type === 'walk') tl.append(placeRow(first.t0, journey.from, 'from'));
  journey.steps.forEach((st, i) => {
    if (st.type === 'ride') tl.append(rideBlock(st, i));
    else if (st.type === 'walk' || st.type === 'change') tl.append(walkBlock(st, i));
  });
  const last = journey.steps.filter((st) => st.type !== 'arrive').pop();
  if (last && last.type === 'walk' && last.final) tl.append(placeRow(journeyEnd(), journey.dest ? journey.dest.title : 'Destination', 'to'));
  const note = footNote();
  frag.append(tl, ...(note ? [note] : []), h('div', 'sheet-end'));
  return frag;
}
function renderBody() {
  const top = jBody.scrollTop;
  jBody.replaceChildren(buildBody());
  jBody.scrollTop = top;
}
let ticketFoot: { conn: Journey; tracking: boolean; following: boolean; bar: HTMLElement; refresh?: () => void } | null = null;
export function renderFoot() {
  if (!journey.conn || journey.list) { jFoot.replaceChildren(); ticketFoot = null; return; }
  const tracking = SETTINGS.prefs().fareTracking;
  const following = document.body.classList.contains('following');
  if (ticketFoot?.conn === journey.conn && ticketFoot.tracking === tracking && ticketFoot.following === following && ticketFoot.bar.isConnected) return;
  const ticket = ticketLink();
  const pricing = ticketPricing(!!ticket);
  // the fare sits at the end of the bar; with Trip history on it is a row of its own that opens the fare form
  const bar = h('div', 'actionbar',
    // under way already: the same button, small, brings the map back to where you are on the trip
    following ? kBtn('round-btn', 'Back to where you are', startFollowing, kIcon('nav', 18))
      : kBtn('pill-btn start', null, startFollowing, kIcon('nav', 18), 'Start'),
    ticket,
    kBtn('round-btn', 'Share journey', shareJourney, kIcon('share', 18)),
    pricing && !pricing.form ? pricing.row : null);
  jFoot.replaceChildren(bar, ...(pricing?.form ? [pricing.row, pricing.form] : []));
  ticketFoot = { conn: journey.conn, tracking, following, bar, refresh: pricing?.refresh };
}
export function renderSheet() {
  renderHead(true);
  renderBody();
  renderFoot();
  if (document.body.classList.contains('journey-mode') && sheetDetent === 'low') placeSheet('low', true); // the header's height may have changed
}
let sheetQueued = false, timesQueued = false;
// times: the trip's times have changed too, so the pill, the bar and the footer follow
export function queueSheet(times?: boolean) {
  if (times) timesQueued = true;
  if (sheetQueued) return;
  sheetQueued = true;
  requestAnimationFrame(() => {
    const t = timesQueued;
    sheetQueued = timesQueued = false;
    if (!journey.conn) return;
    renderHead();
    renderBody();
    if (!t) return;
    document.getElementById('jDep')!.textContent = fmtTime(journeyStart());
    updatePillTimes();
    renderBar();
    renderFoot();
  });
}

/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() {
  // "Done" at the end of the 3D walk: back to the journey, on the step that follows
  if (Station3D) Station3D.on('done', () => {
    const i = journey.steps.indexOf(sheet.s3Step!);
    Station3D.close();
    if (i >= 0 && i < journey.steps.length - 1) goToStep(i + 1);
  });
  window.addEventListener('pricing-history-change', () => {
    if (!ticketFoot?.bar.isConnected) return;
    renderFoot();
    ticketFoot?.refresh?.();
  });
}
