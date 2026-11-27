// ---- Following one vehicle: the one of a journey's ride (a tap on the ride in the sheet or in the bar at the top), one
//      of a line found in the search (line-search.ts), or one tapped on the map ("Follow" on its card). The camera
//      keeps it in the middle of the free map as it moves; a card at the top says what is followed and how its
//      position is known, with "Stop".
//
//      Where it is: as the live layer draws it (live-vehicles.ts vehFocusNow(), moved on every frame), else the
//      engine's /api/trip answer for its trip (the journey's own, or asked here every 30 s), placed on the trip's way
//      (also before your stop), else nowhere: then the card says so and the map shows your stop. A trip not on its way
//      yet shows where it starts and when; once the live layer has it, the camera takes it up by itself.
//
//      The camera: read every frame from where the vehicle is drawn, an ease a little ahead of it (where it will be,
//      at the speed it is shown going) every EVERY ms, each started before the last ends, so the map glides along
//      without a stop and in step with the vehicles' canvas. Not frame by frame through jumpTo: every camera move runs
//      the map's moveend handlers (cards, places, vehicles). Dragging the map stops following; a pinch or the wheel
//      only zooms (it follows on at that zoom); a tap on the ride again, or "Stop", stops it. ----
import * as maplibregl from 'maplibre-gl';
import { map } from './map.ts';
import { onFollowVehicle, vehAnswered, vehFocus, vehFocusNow, vehLine, vehShown } from './live-vehicles.ts';
import type { LiveVehicle } from './live-vehicles.ts';
import { MODE_NAME, h, kBadge, kBtn, setDetent, sheetDetent } from './sheet.ts';
import { queueSheet } from './sheet-content.ts';
import { goToStep, mapPadding, renderBar } from './pill.ts';
import { pauseFollowCam } from './follow-cam.ts';
import { fmtDist } from './live-vehicles.ts';
import { fmtTime, lineLabel, liveMs, modeOf, planMs, stopName } from './journey-steps.ts';
import type { LineLike } from './journey-steps.ts';
import { gpsOn, userLngLat } from './location.ts';
import { journey } from './state.ts';
import { KANTE } from '../engine.ts';
import { KANTE_LIVE } from '../live.ts';
import { legNow, lineKey, nearestVehicle, tripPoint } from '../vehicle-pick.ts';
import type { LineGroup } from '../vehicle-pick.ts';
import type { JourneyRide } from '../engine-journey.ts';

const ZOOM = 16; // close enough to see it as itself (from 15) with its line number (16)
const EVERY = 300, EASE_MS = 520; // ms between eases, and how long each is (longer: they overlap, the map never stops)
const ASK_MS = 30000; // its trip asked again while the live layer does not have it
const GRACE_MS = 1500; // the live layer's moment to draw it (at the start, back from the background) before anything else is tried
/** The camera's moves made here carry this: any other move (another part of the page taking the camera) stops following. */
const OURS = { vehicleFollow: true };

/** What is followed: a trip (a journey's ride follows its trips in turn, when you stay seated). */
interface Followed {
  /** A journey's ride, and its step: then the leg that runs now. */
  ride: JourneyRide | null;
  step: number;
  tripId: string;
  serviceDate: string;
  line: LineLike;
  headsign: string;
}
let cur: Followed | null = null;
const keyOf = (f: { tripId: string; serviceDate: string }) => f.tripId + '|' + f.serviceDate;
/** The trip asked here (when the journey's own answer is not fresh): the answer, or why there is none. */
let own: { key: string; trip: KanteTrip | null; at: number; askedAt: number; busy: boolean; fail: string | null } | null = null;
/** A line chosen in the search: its vehicles on the map, to pick one from. */
let lineSess: { group: LineGroup<KanteVehicle>; label: string } | null = null;

// the camera
let raf = 0;
const cam = {
  first: true, // the first move there
  nextAt: 0, // when the next ease may start (performance.now())
  vel: [0, 0] as LngLat, // degrees a ms, as it is shown going
  last: null as { ll: LngLat; t: number } | null,
  gesture: false, // a pinch, rotate or wheel under way: the camera waits
  still: '', // what is shown standing (a trip not on its way, your stop): fitted once
};
function resetCam() { cam.first = true; cam.nextAt = 0; cam.vel = [0, 0]; cam.last = null; cam.still = ''; cam.gesture = false; startedAt = performance.now(); textAt = 0; }

/** A vehicle is followed. */
export const vehicleFollowing = () => !!cur;
/** This ride's vehicle is followed. */
export const followsRide = (ride: JourneyRide) => !!cur && cur.ride === ride;

// ---------------------------------------------------------------- start and stop

/** Follow this trip's vehicle. */
export function followTrip(t: Omit<Followed, 'ride' | 'step'> & { ride?: JourneyRide | null; step?: number }) {
  pauseFollowCam(); // (under way: the map stops following you)
  cur = { ride: t.ride || null, step: t.step ?? -1, tripId: t.tripId, serviceDate: t.serviceDate, line: t.line, headsign: t.headsign };
  own = null;
  shownText = '';
  focusSent = '';
  resetCam();
  vehFocus(keyOf(cur));
  renderCard();
  changed();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(frame);
}
// The leg of a ride that runs now (by the live departures where its trips change)
function rideLeg(s: JourneyRide, now = Date.now()) {
  return s.legs[legNow(s.legs.map((l, x) => { const k = s.seqIdx[x].get(l.from.seq); return k == null ? null : liveMs(s.stops[k], 'dep'); }), now)];
}
/** Follow the vehicle of the journey's ride at step i (a tap on it in the sheet or in the bar); a second tap stops. */
export function toggleRide(i: number) {
  const st = journey.steps[i];
  if (!st || st.type !== 'ride') return;
  if (followsRide(st.s)) { stopFollowing(); return; }
  const leg = rideLeg(st.s);
  goToStep(i, false, true); // that ride on the map, the camera left to this
  followTrip({ tripId: leg.tripId, serviceDate: leg.serviceDate, line: st.s.line, headsign: st.s.headsign, ride: st.s, step: i });
  // the map above the sheet: room to see it (on a wide screen the sheet is beside the map)
  if (window.innerWidth < 700 && sheetDetent !== 'low') setDetent('low');
}
/** Follow no vehicle (a line chosen in the search stays on the map, to pick another). */
export function stopFollowing() {
  if (!cur) return;
  cur = null;
  own = null;
  focusSent = '';
  vehFocus(null);
  cancelAnimationFrame(raf);
  raf = 0;
  renderCard();
  changed();
}
// The sheet and the bar show which ride is followed
function changed() {
  if (!journey.conn) return;
  queueSheet();
  renderBar();
}

// ---------------------------------------------------------------- a line chosen in the search

/** A line found in the search (line-search.ts): only its vehicles on the map, around where they were found, and the
 *  card to pick one (or the nearest). */
export function showLine(g: LineGroup<KanteVehicle>, box: KanteBbox) {
  stopFollowing();
  const j = KANTE_LIVE.journeyLike(g.line);
  lineSess = { group: g, label: lineName(j) };
  vehLine({ key: g.key, match: (l) => lineKey(l) === g.key, box });
  renderCard();
  const pts = g.vehicles.map((v) => v.point || v.from);
  if (pts.length) {
    const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    map.fitBounds(b, { padding: cardPadding(), maxZoom: 15.5, duration: 800 }, OURS);
  }
  clearInterval(lineTimer);
  lineTimer = setInterval(() => { if (lineSess && !cur) refreshLine(); }, 3000); // the nearest change as they move
}
let lineTimer: ReturnType<typeof setInterval> | undefined;
/** The line's vehicles off the map again (all of them come back as Settings has them). */
export function closeLine() {
  if (!lineSess) return;
  lineSess = null;
  clearInterval(lineTimer);
  stopFollowing();
  vehLine(null);
  renderCard();
}
const lineName = (j: LineLike) => {
  const mode = modeOf(j.category), label = lineLabel(j);
  return mode === 'train' ? label : `${MODE_NAME[mode] || 'Bus'} ${label}`;
};
// The line's vehicles now (the map's, once it has answered for the line; until then those the search found)
function lineVehicles(): KanteVehicle[] {
  if (vehAnswered()) return [...vehShown()];
  return lineSess ? lineSess.group.vehicles : [];
}
// Where "nearest" is measured from: you, while the map shows where you are; else the middle of the map
function measureFrom(): { at: LngLat; you: boolean } {
  const you = gpsOn() && !!userLngLat && map.getBounds().contains(userLngLat);
  return { at: you ? userLngLat! : map.getCenter().toArray(), you };
}
function followVehicle(v: KanteVehicle) {
  followTrip({ tripId: v.tripId, serviceDate: v.serviceDate, line: KANTE_LIVE.journeyLike(v.line), headsign: v.headsign });
}

// ---------------------------------------------------------------- the card at the top

// (made on first use: the helpers it is made with may not be there yet while the page's parts load)
let cardEl: HTMLDivElement | null = null;
function cardOf() {
  if (!cardEl) {
    cardEl = h('div', 'kj follow-card');
    cardEl.setAttribute('role', 'region');
    cardEl.setAttribute('aria-label', 'Following a vehicle');
    cardEl.addEventListener('pointerdown', () => { touchedAt = performance.now(); });
    cardEl.hidden = true;
    document.body.append(cardEl);
  }
  return cardEl;
}
let shownText = '';
function renderCard() {
  const card = cardOf();
  if (cur) {
    const label = lineName(cur.line);
    const stop = kBtn('pill-btn small', `Stop following ${label}`, stopFollowing, 'Stop');
    card.replaceChildren(kBadge(cur.line, 'lg'),
      h('div', 'fc-text', h('b', null, `to ${cur.headsign}`), status(shownText || 'Looking for it…')), stop);
  } else if (lineSess) {
    const vs = lineVehicles(), from = measureFrom();
    const pick = nearestVehicle(vs, from.at, from.you);
    const near = (v: KanteVehicle) => KANTE_LIVE.distKm(from.at, v.point || v.from);
    const nearest = [...vs].sort((a, b) => near(a) - near(b)).slice(0, 3);
    const rows = nearest.map((v) =>
      kBtn('fc-row', `Follow ${lineSess!.label} to ${v.headsign}`, () => followVehicle(v),
        h('span', 'fc-row-to', `to ${v.headsign}`), h('small', null, `Next stop: ${v.nextStop} · ${fmtDist(near(v) * 1000)}`)));
    card.replaceChildren(
      h('div', 'fc-top', kBadge(KANTE_LIVE.journeyLike(lineSess.group.line), 'lg'),
        h('div', 'fc-text', h('b', null, lineSess.label),
          h('small', null, vs.length ? `${vs.length} on the way nearby · tap one on the map, or here` : 'None on the way nearby right now')),
        kBtn('pill-btn small', `Close ${lineSess.label}`, closeLine, 'Close')),
      ...(pick ? [kBtn('pill-btn small fc-nearest', null, () => followVehicle(pick.v),
        pick.coming ? 'Follow the nearest coming your way' : from.you ? 'Follow the nearest' : 'Follow the nearest to the map centre')] : []),
      ...rows);
  }
  card.hidden = !cur && !lineSess;
  card.classList.toggle('line', !cur && !!lineSess);
}
// The line's card again as they move (others may be nearest now), but not just after a finger or the mouse came down
// on it, nor while the keyboard is in it: a row must not be swapped under a tap or the focus
let touchedAt = 0;
function refreshLine() {
  if (cardEl && performance.now() - touchedAt > 2500 && !cardEl.contains(document.activeElement)) renderCard();
}
// How it is placed: read out when it changes (not the whole card)
function status(text: string) {
  const e = h('small', null, text);
  e.setAttribute('role', 'status');
  return e;
}
function setText(text: string) {
  if (text === shownText) return;
  shownText = text;
  const small = cardEl && cardEl.querySelector('.fc-text small');
  if (small && cur) small.textContent = text;
}
// The middle of the free map (between the card or the top of the screen and the sheet), as an offset from the middle of
// the whole map: an ease given padding would keep it on the map, and every fit after it would count it twice (so
// follow-cam.ts does the same)
function aimAt(): { offset: [number, number]; padding: { top: number; bottom: number; left: number; right: number } } {
  const p = cardPadding();
  return { offset: [(p.left - p.right) / 2, (p.top - p.bottom) / 2], padding: { top: 0, bottom: 0, left: 0, right: 0 } };
}
// The map's padding with the card's room at the top
function cardPadding() {
  const p = mapPadding();
  if (cardEl && !cardEl.hidden && cardEl.offsetHeight) p.top = Math.max(p.top, cardEl.offsetTop + cardEl.offsetHeight + 24);
  return p;
}

// ---------------------------------------------------------------- every frame

let textAt = 0, legAt = 0, focusSent = '', startedAt = 0;
function frame() {
  raf = requestAnimationFrame(frame);
  if (!cur || document.hidden) return;
  // the journey it is of has gone (another plan, or the journey ended)
  if (cur.ride && !(journey.conn && journey.conn.parts.includes(cur.ride))) { stopFollowing(); return; }
  const now = Date.now(), t = performance.now();
  // a ride you stay seated on: the trip that runs now
  if (cur.ride && t - legAt > 1000) {
    legAt = t;
    const leg = rideLeg(cur.ride, now);
    if (keyOf(leg) !== keyOf(cur)) {
      // (the vehicle goes on as another trip: its line and where it goes may change with it)
      const first = leg === cur.ride.legs[0];
      cur.tripId = leg.tripId; cur.serviceDate = leg.serviceDate; own = null; shownText = ''; focusSent = '';
      cur.line = first ? cur.ride.line : KANTE_LIVE.journeyLike(leg.line);
      cur.headsign = first ? cur.ride.headsign : leg.headsign;
      vehFocus(keyOf(cur));
      renderCard();
    }
  }
  const s = vehFocusNow(), text = t - textAt > 1000;
  if (text) textAt = t;
  if (s && t - s.at < 1000) {
    // drawn by the live layer: followed as drawn
    if (cam.still) { cam.still = ''; cam.first = true; }
    follow(s.ll, t);
    if (text) setText(liveWords(s.v, s.old));
    return;
  }
  if (t - startedAt < GRACE_MS) { if (text) setText('Looking for it…'); return; }
  const w = elsewhere(now);
  // (the journey's vehicles are asked for around where it is said to be, too: it may be coming from far)
  const sendAt = w.at ? w.at.map((x) => x.toFixed(3)).join() : '';
  if (sendAt !== focusSent) { focusSent = sendAt; vehFocus(keyOf(cur), w.at); }
  if (w.ll) { if (cam.still) { cam.still = ''; cam.first = true; } follow(w.ll, t); }
  else if (w.fit && w.fit.length) showStill(w.fit);
  if (text) setText(w.text);
  ask(now);
}
// How its drawn position is known, honestly (as the vehicle's card on the map says it)
function liveWords(v: LiveVehicle, old: number) {
  if (old) return `Not updated for ${Math.max(1, Math.round(old / 60000))} min: the live data is not coming through`;
  const how = KANTE_LIVE.liveText(v.info, { basis: v.basis });
  return `${how.text} · next stop: ${v.nextStop}`;
}
const ll = (c: KanteStopCall | undefined): LngLat | null => (c ? [c.quay.lon, c.quay.lat] : null);
/** Where it is when the live layer does not draw it: a place to follow (ll), or places to show (fit), and what to say. */
function elsewhere(now: number): { ll?: LngLat | null; fit?: LngLat[]; at?: LngLat | null; text: string } {
  const f = cur!, key = keyOf(f);
  // the freshest answer for its trip: the journey's (live-engine.ts) or the one asked here
  let ans: { trip: KanteTrip; at: number } | null = null;
  if (f.ride) { const n = f.ride.legs.findIndex((l) => keyOf(l) === key), k = n >= 0 ? f.ride.live[n] : null; if (k && k.trip) ans = { trip: k.trip, at: k.at }; }
  if (own && own.key === key && own.trip && (!ans || own.at > ans.at)) ans = { trip: own.trip, at: own.at };
  const board = f.ride && keyOf(f.ride.legs[0]) === key ? f.ride.from : null, boardLL = ll(board || undefined);
  const atBoard = board ? `; at ${stopName(board)} ${fmtTime(liveMs(board, 'dep'))}` : '';
  if (ans) {
    const tr = ans.trip, pos = tr.position, age = now - ans.at;
    if (tr.cancelled) return { fit: boardLL ? [boardLL] : [], text: 'Cancelled today' };
    // (an old answer says nothing about now: below)
    if (pos && age >= 120000) return { fit: boardLL ? [boardLL] : [], text: `No live position: the last answer is ${Math.round(age / 60000)} min old${atBoard}` };
    if (pos && pos.state === 'before-start') {
      const first = tr.calls[0], dep = first ? KANTE_LIVE.liveDep(first) : null;
      return { fit: [ll(first), boardLL].filter((x): x is LngLat => !!x), at: ll(first),
        text: `Not on its way yet: due to start at ${first ? first.quay.stationName : 'its first stop'}${dep ? ' at ' + fmtTime(dep * 1000) : ''}${atBoard}` };
    }
    if (pos && pos.state === 'ended') { const last = ll(tr.calls[tr.calls.length - 1]); return { fit: last ? [last] : [], text: 'This trip has ended' }; }
    if (pos) {
      const tNow = (pos.t != null ? pos.t : ans.at / 1000) + (now - ans.at) / 1000;
      const p = KANTE_LIVE.advance(pos, tr.calls, tNow), here = tripPoint(tr, p);
      if (here) {
        const how = KANTE_LIVE.liveText(KANTE_LIVE.liveInfoOf(tr), { basis: p!.basis });
        return { ll: here, at: tripPoint(tr, pos), text: `${how.text} · placed by its times, not seen on the live map` };
      }
    }
    return { fit: boardLL ? [boardLL] : [], text: `No position for it in the live data${atBoard}` };
  }
  // no answer: why, and when it leaves your stop by the timetable
  const fail = own && own.key === key ? own.fail : null;
  const why = !KANTE.base || fail === 'off' ? 'Live data is switched off for this page' : fail === 'down' ? 'The live data isn’t answering'
    : fail === 'refused' ? 'No live data for this trip' : 'Looking for it…';
  const plan = board ? planMs(board, 'dep') : null;
  if (why === 'Looking for it…') return { text: why }; // (the map stays where it is meanwhile)
  return { fit: boardLL ? [boardLL] : [], text: board && plan ? `${why}; leaves ${stopName(board)} at ${fmtTime(plan)} by the timetable` : why };
}
// Its trip asked of the engine while the live layer does not have it and the journey's answer is not fresh
function ask(now: number) {
  const f = cur!, key = keyOf(f);
  if (!KANTE.base) return;
  if (f.ride) { const n = f.ride.legs.findIndex((l) => keyOf(l) === key), k = n >= 0 ? f.ride.live[n] : null; if (k && k.trip && now - k.at < ASK_MS) return; }
  if (own && own.key === key && (own.busy || now - own.askedAt < ASK_MS)) return;
  const req = { key, trip: own && own.key === key ? own.trip : null, at: own && own.key === key ? own.at : 0, askedAt: now, busy: true, fail: null as string | null };
  own = req;
  KANTE.trip(f.tripId, f.serviceDate).then((tr) => {
    if (own !== req) return; // stopped, or another trip since
    req.trip = tr; req.at = Date.now(); req.busy = false; req.fail = null;
  }).catch((e) => {
    if (own !== req) return;
    req.busy = false; req.fail = KANTE.failure(e) || 'down';
  });
}

// The camera after a place that moves: an ease a little ahead of it every EVERY ms (see the top)
function follow(p: LngLat, t: number) {
  if (cam.last) {
    const dt = t - cam.last.t;
    if (dt > 0) {
      // (a jump — another answer, another source — is no speed)
      if (KANTE_LIVE.distKm(cam.last.ll, p) > 0.3) cam.vel = [0, 0];
      else {
        const a = Math.min(1, dt / 250), vx = (p[0] - cam.last.ll[0]) / dt, vy = (p[1] - cam.last.ll[1]) / dt;
        cam.vel = [cam.vel[0] + (vx - cam.vel[0]) * a, cam.vel[1] + (vy - cam.vel[1]) * a];
      }
    }
  }
  cam.last = { ll: p, t };
  if (cam.gesture) return;
  if (cam.first) {
    cam.first = false;
    cam.nextAt = t + 950;
    map.easeTo({ center: p, zoom: Math.max(map.getZoom(), ZOOM), ...aimAt(), duration: 900 }, OURS);
    return;
  }
  if (t < cam.nextAt) return;
  cam.nextAt = t + EVERY;
  const ahead: LngLat = [p[0] + cam.vel[0] * EASE_MS, p[1] + cam.vel[1] * EASE_MS];
  // standing and in the middle already: the map stays still (and its handlers with it)
  const aim = aimAt(), el = map.getContainer(), q = map.project(ahead);
  if (Math.hypot(el.clientWidth / 2 + aim.offset[0] - q.x, el.clientHeight / 2 + aim.offset[1] - q.y) < 0.75) return;
  map.easeTo({ center: ahead, ...aim, duration: EASE_MS, easing: (k) => k }, OURS);
}
// Places that do not move (where a trip will start, your stop): shown once
function showStill(pts: LngLat[]) {
  const key = pts.map((p) => p.join()).join();
  if (cam.still === key || cam.gesture) return;
  cam.still = key;
  cam.last = null;
  const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
  map.fitBounds(b, { padding: cardPadding(), maxZoom: 16, duration: 800 }, OURS);
}

/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() {
  onFollowVehicle((v) => followVehicle(v));
  // dragging the map with one finger (or the mouse) stops following; a pinch, a turn or the wheel only waits
  const twoFingers = (e: { originalEvent?: Event }) => !!e.originalEvent && 'touches' in e.originalEvent && (e.originalEvent as TouchEvent).touches.length > 1;
  map.on('dragstart', (e) => {
    if (!cur || !e.originalEvent) return;
    if (twoFingers(e)) { cam.gesture = true; return; }
    stopFollowing();
  });
  const wait = (e: { originalEvent?: Event }) => { if (cur && e.originalEvent) cam.gesture = true; };
  map.on('zoomstart', wait);
  map.on('rotatestart', wait);
  map.on('pitchstart', wait);
  map.on('moveend', () => { if (cam.gesture) { cam.gesture = false; cam.nextAt = 0; } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && cur) { cam.nextAt = 0; cam.last = null; startedAt = performance.now(); } });
  // another part of the page moved the camera (a category, a stop, the whole journey, your first position…): it has it now
  // (not the map being resized — the address bar, the keyboard —, which fires its movestart just before its resize)
  let resizedAt = -1;
  map.on('resize', () => { resizedAt = performance.now(); });
  map.on('movestart', (e: { originalEvent?: Event; vehicleFollow?: boolean }) => {
    if (!cur || e.originalEvent || e.vehicleFollow) return;
    const at = performance.now();
    setTimeout(() => { if (resizedAt < at) stopFollowing(); }, 0);
  });
}
