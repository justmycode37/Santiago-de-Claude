// ---------- Which way you face: a beam from the blue dot, as wide as the compass is unsure ----------
// From the phone's compass (src/compass.ts); without one, while you move, from the direction GPS says you go.
// iPhones ask before a page may read the compass, and only on a tap: the first tap on the map once you have a blue
// dot asks (if you say no, it does not ask again), and tapping the blue dot always does.
import { map } from './map.ts';
import { showToast } from '../toast.ts';
import { CompassFilter, compassOff, compassReading } from '../compass.ts';
import type { OrientationLike } from '../compass.ts';

type AskOrientation = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> };

// The compass's beam stays until iOS says the compass is off or the page is hidden: browsers send no event while the
// phone does not move (Chrome: until an angle changes by 0.1°), so a quiet compass is not a gone one.
const COURSE_FRESH = 10000; // ms: the GPS direction, from a fix taken this recently (about one a second while moving)
const COURSE_SPREAD = 30; // half-angle for the GPS direction: where you go, not quite where you face
const DENIED = 'compassDenied'; // localStorage: said no on iOS, so a tap on the map does not ask again

const beam = document.createElement('div');
beam.className = 'user-beam';
const compass = new CompassFilter();
let course: { deg: number; at: number } | null = null;
let frame = 0, staleTimer: ReturnType<typeof setTimeout> | undefined;

function draw() {
  frame = 0;
  const now = Date.now();
  let deg: number | null = null, spread = 0;
  if (compassOn()) { deg = compass.deg; spread = compass.spread; }
  else if (course && now - course.at < COURSE_FRESH) { deg = course.deg; spread = COURSE_SPREAD; }
  beam.classList.toggle('on', deg != null);
  clearTimeout(staleTimer);
  if (deg == null) return;
  beam.style.transform = `rotate(${(deg - map.getBearing()).toFixed(1)}deg)`;
  beam.style.setProperty('--s', spread.toFixed(1) + 'deg');
  // the same light spread over a wider beam: an unsure one is fainter too
  beam.style.setProperty('--a', Math.min(1, 0.45 + 15 / spread).toFixed(2));
  if (!compassOn()) staleTimer = setTimeout(draw, 1000); // the GPS direction goes when the fixes stop saying it
}
const compassOn = () => compass.deg != null && compass.at > -Infinity;
const dropCompass = () => { compass.at = -Infinity; redraw(); };
const redraw = () => { if (!frame) frame = requestAnimationFrame(draw); };

function onOrientation(ev: Event) {
  const e = ev as DeviceOrientationEvent & OrientationLike;
  const r = compassReading(e, (screen.orientation && screen.orientation.angle) || 0);
  if (!r) {
    // iOS says its compass is off, or the sensor is gone (an event without angles); else held at an angle that
    // cannot tell: the last direction stays
    if (compassOff(e) || (e.alpha == null && e.webkitCompassHeading == null)) dropCompass();
    return;
  }
  compass.update(r, Date.now());
  redraw();
}

/** A GPS fix's direction of travel, for when there is no compass (location.ts passes each fix, `at` when taken). */
export function noteCourse(heading: number | null | undefined, speed: number | null | undefined, at: number) {
  if (course && at < course.at) return;
  // slower than walking pace: GPS has no direction (a fix saying nothing about speed keeps the last one)
  if (Number.isFinite(speed) && speed! < 1) course = null;
  else if (heading != null && Number.isFinite(heading) && speed! >= 1) course = { deg: heading, at };
  else return;
  redraw();
}

function listen() {
  // Android: the absolute event is the one relative to north; iOS has only the other, with its compass heading
  const type = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
  window.removeEventListener(type, onOrientation);
  window.addEventListener(type, onOrientation);
}

let asking = false;
function askCompass(fromDot: boolean) {
  const Ask = window.DeviceOrientationEvent as AskOrientation | undefined;
  if (!Ask || typeof Ask.requestPermission !== 'function' || asking) return;
  if (compassOn()) return; // it is already on
  let denied = false;
  try { denied = localStorage.getItem(DENIED) === '1'; } catch (e) {}
  if (denied && !fromDot) return;
  asking = true;
  const off = () => { if (fromDot) showToast('Compass access is off, so the map cannot show which way you face.', 6000); };
  Ask.requestPermission!().then((s) => {
    try { if (s === 'granted') localStorage.removeItem(DENIED); else localStorage.setItem(DENIED, '1'); } catch (e) {}
    if (s === 'granted') listen(); // WebKit starts the sensor for a listener added once access is granted
    else off();
  }, off).finally(() => { asking = false; });
}

/** What this part of the page does when it starts: `dot` is the blue dot's element (location.ts). */
export function startHeading(dot: HTMLElement) {
  dot.append(beam); // between the dot's pulse (::before) and the dot itself (::after)
  map.on('rotate', redraw);
  if (!window.DeviceOrientationEvent) return;
  listen();
  // (as the tap goes down to its target: pins and cards stop it on the way back up)
  map.getCanvasContainer().addEventListener('click', (e) => {
    const onDot = !!(e.target as Element).closest('.user-dot');
    if (onDot || dot.isConnected) askCompass(onDot);
  }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) dropCompass(); });
}
