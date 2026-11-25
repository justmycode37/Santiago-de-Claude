// ---------- Under way: the map follows you, turned the way you go, like a navigation app ----------
// After Start (journey-actions.ts), the camera keeps your blue dot in the lower part of the free map, looking ahead,
// tilted, and turned so that up on the screen is the way you face: on foot the compass (drawn towards the direction
// you walk: heading.ts), on a ride the way the track or road goes where you are (tracking.ts), else the direction
// GPS says you go. It moves only when that changes enough to see, a few times a second at most: each camera move
// runs the map's move handlers (cards, vehicles), so it never moves frame by frame.
//
// Dragging the map or picking a step, a direction or a stop in the sheet hands the camera back to you; "Back to
// where you are" takes it up again. A pinch only zooms: the camera follows on at the zoom you chose. Without a GPS
// fix it waits and leaves the map as it is.
import type * as maplibregl from 'maplibre-gl';
import { map } from './map.ts';
import { gpsOn, userMarker } from './location.ts';
import { headingFor } from './heading.ts';
import { mapPadding } from './pill.ts';
import { tripHere, tripLive } from './tracking.ts';
import { angDiff } from '../compass.ts';

const ZOOM_WALK = 17.6, ZOOM_RIDE = 15.6;
const PITCH = 45; // tilted, as in the introduction's demo journey: the way ahead fills the screen
const MAX_PITCH = 60;
const EVERY = 250; // ms between looks at where you are
const DOT_AT = 0.7; // how far down the free map (between the top pill and the sheet) your dot sits

let state: 'off' | 'on' | 'paused' = 'off';
let timer: ReturnType<typeof setInterval> | undefined;
let lastMove = 0;
let bearing: number | null = null; // the last bearing it turned to from something that said it
let zoomBias = 0; // how much closer or further than its own zoom you have pinched it
let pinching = false;
let aim: { center: maplibregl.LngLat; bearing: number; zoom: number; ox: number; oy: number } | null = null; // where the last move goes

/** The follow camera has the map: GPS moves it, and the fits of the steps (pill.ts, sheet.ts) leave it alone. Only
 *  while the trip is on (from 30 min before it starts): a trip changed to a later time is shown, not you. */
export const followCamOn = () => state === 'on' && gpsOn() && tripLive();
/** Under way (after Start), whether or not you have taken the camera back. */
export const followCamUnderWay = () => state !== 'off';

// Where on the screen your dot should be, from the centre of the map (px; positive: lower)
function dotOffset(): [number, number] {
  const p = mapPadding(), h = map.getContainer().clientHeight;
  const free = Math.max(0, h - p.top - p.bottom);
  return [(p.left - p.right) / 2, p.top + free * DOT_AT - h / 2];
}

function step(force = false) {
  if (!followCamOn() || document.hidden || pinching) return;
  const now = Date.now();
  if (!force && now - lastMove < EVERY) return;
  const here = tripHere();
  const onRide = !!here && here.onRide;
  // on a ride, the way the line goes is steadier than the fixes; on foot the phone's compass leads
  const h = headingFor(onRide);
  // (a calmer map than the beam: it turns once the direction has clearly changed, more so the less sure it is)
  let target: number | null = null, deadband = 5;
  if (onRide && here && here.bearing != null) target = here.bearing;
  else if (h) { target = h.deg; deadband = Math.max(6, h.spread / 3); }
  else if (here && here.bearing != null) target = here.bearing;
  if (target != null) bearing = target;
  const zoom = Math.min(19.5, Math.max(12, (onRide ? ZOOM_RIDE : ZOOM_WALK) + zoomBias));
  const center = userMarker.getLngLat(); // where the dot is drawn: on the walking route when GPS is near it
  const [ox, oy] = dotOffset();
  // Measured against where the map is going while it still glides there, else against where it is: a glide under
  // way is not started again for the same place
  const gliding = map.isMoving() && aim;
  const b0 = gliding ? aim!.bearing : map.getBearing();
  const turn = bearing != null && Math.abs(angDiff(bearing, b0)) >= deadband;
  let off: boolean, reframe: boolean;
  if (gliding) {
    const a = map.project(aim!.center), b = map.project(center);
    off = Math.hypot(a.x - b.x, a.y - b.y) > 4 || Math.hypot(aim!.ox - ox, aim!.oy - oy) > 4;
    reframe = Math.abs(aim!.zoom - zoom) > 0.05;
  } else {
    const at = map.project(center), w = map.getContainer().clientWidth, h = map.getContainer().clientHeight;
    off = Math.hypot(at.x - (w / 2 + ox), at.y - (h / 2 + oy)) > 4;
    reframe = Math.abs(map.getZoom() - zoom) > 0.05 || Math.abs(map.getPitch() - PITCH) > 0.5;
  }
  if (!force && !turn && !off && !reframe) return; // nothing to see: the map stays still (and so do its handlers)
  lastMove = now;
  const to = turn || force ? (bearing ?? b0) : b0;
  aim = { center, bearing: to, zoom, ox, oy };
  map.easeTo({
    center, zoom, pitch: PITCH, bearing: to, offset: [ox, oy],
    padding: { top: 0, bottom: 0, left: 0, right: 0 }, // (the offset is from the middle of the whole map)
    duration: force ? 700 : 900, easing: (t) => t * (2 - t),
  });
}

/** Start (or take up again) following you: journey-actions.ts on Start and "Back to where you are". */
export function followCam() {
  if (state === 'off') { bearing = null; zoomBias = 0; }
  state = 'on';
  map.setMaxPitch(MAX_PITCH);
  clearInterval(timer);
  timer = setInterval(() => step(), EVERY);
  lastMove = 0;
  step(true);
}
/** You have taken the camera back (a gesture, or a step, direction or stop picked in the sheet). */
export function pauseFollowCam() {
  if (state === 'on') state = 'paused';
  clearInterval(timer);
}
/** No longer under way: the map stands north up and flat again. */
export function stopFollowCam() {
  const was = state;
  state = 'off';
  clearInterval(timer);
  if (was === 'off') return;
  flatten();
}
// North up and flat (the map is made flat: map.ts), then no tilt allowed again
function flatten() {
  if (!map.getBearing() && !map.getPitch()) { map.setMaxPitch(0); return; }
  map.easeTo({ bearing: 0, pitch: 0, duration: 500 }); // (a flight started straight after takes it over: it flattens too)
}

// The north button: while the map is turned and the camera is not following you, a tap turns it north up and flat
const northBtn = document.getElementById('northBtn')!;
const needle = northBtn.querySelector('svg')!;
function showNorth() {
  const turned = Math.abs(map.getBearing()) > 0.5 || map.getPitch() > 0.5;
  if (turned && northBtn.hidden && map.isMoving()) return; // (not while the map turns north up by itself)
  northBtn.hidden = !turned || state === 'on';
  if (!northBtn.hidden) needle.style.transform = `rotate(${-map.getBearing()}deg)`;
}

/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() {
  // dragging the map hands the camera back (the follow camera's own moves, and other code's, have no DOM event); a
  // pinch or the wheel sets how close it follows
  // (MapLibre pans along with a pinch whose fingers' middle moves: a drag with two fingers is a pinch)
  const twoFingers = (e: { originalEvent?: Event }) => !!e.originalEvent && 'touches' in e.originalEvent && (e.originalEvent as TouchEvent).touches.length > 1;
  map.on('dragstart', (e) => {
    if (!e.originalEvent || state !== 'on') return;
    if (twoFingers(e)) { pinching = true; return; }
    pauseFollowCam();
    showNorth();
  });
  map.on('zoomstart', (e) => { if (e.originalEvent && state === 'on') pinching = true; });
  // the gesture is over (and the glide after it, if any)
  map.on('moveend', () => {
    if (!pinching) return;
    pinching = false;
    const here = tripHere();
    zoomBias = map.getZoom() - (here && here.onRide ? ZOOM_RIDE : ZOOM_WALK);
    lastMove = 0; // and back to your dot at once
  });
  map.on('rotate', showNorth);
  map.on('pitch', showNorth);
  map.on('moveend', showNorth);
  // flat again once off: no tilt allowed (map.ts) when it has come down to none, not by cutting a flight short
  map.on('moveend', () => { if (state === 'off' && map.getPitch() < 0.5 && map.getMaxPitch() > 0) map.setMaxPitch(0); });
  northBtn.addEventListener('click', () => {
    pauseFollowCam();
    map.easeTo({ bearing: 0, pitch: 0, duration: 500 });
  });
  // back from another app or the lock screen: straight to where you are now
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state === 'on') step(true); });
}
