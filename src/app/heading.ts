// ---------- Which way you face: a beam from the blue dot, as wide as the compass is unsure ----------
// From the phone's compass (src/compass.ts), turned from magnetic to true north; without one, from the direction the
// GPS fixes say you go (CourseTracker). The follow camera (follow-cam.ts) turns the map by headingFor().
//
// iPhones send no compass readings until the page has asked (DeviceOrientationEvent.requestPermission()), and the
// question can only be put from a tap. So the page asks on Start, on a tap on the blue dot, and on your first tap
// anywhere but in a text field once you have a blue dot; a "no" is remembered, and then only Start and the dot ask
// again. Access already given is picked up without a tap as the page loads.
import { map } from './map.ts';
import { showToast } from '../toast.ts';
import { CompassFilter, CourseTracker, angDiff, compassOff, compassReading, swissDeclination } from '../compass.ts';
import type { Course, OrientationLike } from '../compass.ts';

// (absolute: also the magnetometer, which the compass needs: W3C Device Orientation; Safari and Chrome take no argument)
type AskOrientation = typeof DeviceOrientationEvent & { requestPermission?: (absolute?: boolean) => Promise<'granted' | 'denied'> };

// The compass's beam stays until iOS says the compass is off or the page is hidden: browsers send no event while the
// phone does not move (Chrome: until an angle changes by 0.1°), so a quiet compass is not a gone one.
const COURSE_FRESH = 20000; // ms: the GPS direction, from a fix taken this recently
const DENIED = 'compassDenied'; // localStorage: said no on iOS, so a tap on the map does not ask again

const beam = document.createElement('div');
beam.className = 'user-beam';
const compass = new CompassFilter();
const courses = new CourseTracker();
let source = ''; // the event type the compass readings come from
let lng = 7.44; // where you are, for the declination (Bern until the first fix)
let where: (() => LngLat | null) | null = null; // where the dot is
let frame = 0, staleTimer: ReturnType<typeof setTimeout> | undefined;

const compassOn = () => compass.deg != null && compass.at > -Infinity;
const freshCourse = (): Course | null => (courses.course && Date.now() - courses.course.at < COURSE_FRESH ? courses.course : null);

/** Where the phone faces (deg, true north) and half the angle it may be off, while the compass is on. */
export function compassHeading() {
  return compassOn() ? { deg: compass.deg!, spread: compass.spread } : null;
}

/**
 * Which way to turn the map while following a trip (follow-cam.ts). On a ride, the way the GPS fixes go (the
 * phone's compass says where it points, not where the vehicle goes). On foot, the compass, drawn towards the
 * direction you walk as much as each is sure; when the two disagree by more than 60°, you are looking elsewhere
 * than you go, and the map turns with the phone, as a navigation app does. Null: neither says.
 */
export function headingFor(onRide: boolean): { deg: number; spread: number } | null {
  const k = freshCourse(), c = compassHeading();
  if (onRide) return k;
  if (!c || !k) return c || k;
  const d = angDiff(k.deg, c.deg);
  if (Math.abs(d) > 60) return c;
  const wc = 1 / (c.spread * c.spread), wk = 1 / (k.spread * k.spread);
  return { deg: (c.deg + d * wk / (wc + wk) + 360) % 360, spread: Math.min(c.spread, k.spread) };
}

function draw() {
  frame = 0;
  let deg: number | null = null, spread = 0;
  const c = compassHeading(), k = freshCourse();
  if (c) ({ deg, spread } = c);
  else if (k) ({ deg, spread } = k);
  beam.classList.toggle('on', deg != null);
  clearTimeout(staleTimer);
  if (deg == null) return;
  beam.style.transform = `rotate(${screenAngle(deg).toFixed(1)}deg)`;
  beam.style.setProperty('--s', spread.toFixed(1) + 'deg');
  // the same light spread over a wider beam: an unsure one is fainter too
  beam.style.setProperty('--a', Math.min(1, 0.45 + 15 / spread).toFixed(2));
  if (!c) staleTimer = setTimeout(draw, 1000); // the GPS direction goes when the fixes stop saying it
}
// The direction on the screen (deg clockwise from up) of `deg` on the ground at the dot. On a flat map that is the
// heading less the map's turn; tilted (the follow camera), the ground is foreshortened, so it is measured: from the
// dot to a point 20 m that way, both as drawn.
function screenAngle(deg: number) {
  const flat = deg - map.getBearing();
  const at = where && where();
  if (!at || map.getPitch() < 1) return flat;
  const k = 20 / 111320, r = deg * Math.PI / 180;
  const to: LngLat = [at[0] + k * Math.sin(r) / Math.cos(at[1] * Math.PI / 180), at[1] + k * Math.cos(r)];
  const a = map.project(at), b = map.project(to);
  return Math.hypot(b.x - a.x, b.y - a.y) < 1 ? flat : Math.atan2(b.x - a.x, a.y - b.y) * 180 / Math.PI;
}
const dropCompass = () => { compass.at = -Infinity; redraw(); };
const redraw = () => { if (!frame) frame = requestAnimationFrame(draw); };

function onOrientation(ev: Event) {
  const e = ev as DeviceOrientationEvent & OrientationLike;
  const r = compassReading(e, (screen.orientation && screen.orientation.angle) || 0);
  if (!r) {
    // iOS says its compass is off, or the sensor is gone (an event without angles); else held at an angle that
    // cannot tell, or an event not relative to north: the last direction stays. Only the stream the readings come
    // from can say it is gone (Chrome sends both kinds, and one without angles at first on a computer).
    if (compassOff(e) || (ev.type === source && e.alpha == null && e.webkitCompassHeading == null)) dropCompass();
    return;
  }
  source = ev.type;
  const now = Date.now();
  compass.update({ deg: (r.deg + swissDeclination(lng, now) + 360) % 360, acc: r.acc }, now);
  redraw();
}

/** A GPS fix (location.ts passes each real one, `at` when taken): where you are, and which way you go. */
export function noteFix(ll: LngLat, acc: number, heading: number | null | undefined, speed: number | null | undefined, at: number) {
  lng = ll[0];
  const before = courses.course;
  courses.fix(ll, acc, heading, speed, at);
  if (courses.course !== before) redraw();
}

function listen() {
  // Android: the absolute event is the one relative to north; iOS has only the other, with its compass heading.
  // Both are listened to: the reading decides which one says where north is (compassReading()).
  for (const type of ['deviceorientationabsolute', 'deviceorientation']) {
    window.removeEventListener(type, onOrientation);
    window.addEventListener(type, onOrientation);
  }
}

const askFn = () => {
  const Ask = window.DeviceOrientationEvent as AskOrientation | undefined;
  return Ask && typeof Ask.requestPermission === 'function' ? Ask : null;
};
let asking: Promise<boolean> | null = null;
/**
 * Asks for the compass, from a tap (iOS asks only then). explicit: Start or the blue dot, which ask even after a
 * "no" and say when it stays off; else only when no "no" has been given. Resolves whether access is given.
 */
export function askForCompass(explicit: boolean): Promise<boolean> {
  const Ask = askFn();
  if (!Ask) return Promise.resolve(!!window.DeviceOrientationEvent); // nothing to ask (Android, computers)
  if (compassOn()) return Promise.resolve(true);
  const off = () => {
    if (explicit) showToast('Compass access is off, so the map cannot show which way you face.', 6000);
    return false;
  };
  if (asking) return explicit ? asking.then((ok) => ok || off()) : asking; // (a tap that asks twice: Start)
  let denied = false;
  try { denied = localStorage.getItem(DENIED) === '1'; } catch (e) {}
  if (denied && !explicit) return Promise.resolve(false);
  asking = Ask.requestPermission!(true).then((s) => {
    try { if (s === 'granted') localStorage.removeItem(DENIED); else localStorage.setItem(DENIED, '1'); } catch (e) {}
    if (s !== 'granted') return off();
    listen(); // WebKit starts the sensor for a listener added once access is granted
    return true;
  }, off).finally(() => { asking = null; });
  return asking;
}

/** What this part of the page does when it starts: `dot` is the blue dot's element, `at` where it is (location.ts). */
export function startHeading(dot: HTMLElement, at: () => LngLat | null) {
  where = at;
  dot.append(beam); // between the dot's pulse (::before) and the dot itself (::after)
  map.on('rotate', redraw);
  map.on('pitch', redraw);
  if (!window.DeviceOrientationEvent) return;
  listen();
  const Ask = askFn();
  if (Ask) {
    // Access given before (iOS keeps it a while): the answer comes without a tap. When it has not been given, the
    // call fails without a prompt (no tap), and the taps below ask.
    try { Ask.requestPermission!(true).then((s) => { if (s === 'granted') listen(); }, () => {}); } catch (e) {}
    // the first tap anywhere once there is a blue dot (as the tap goes down to its target: buttons, pins and cards
    // stop it on the way back up), but not into a text field (iOS's question would take the keyboard away), and
    // every tap on the dot
    document.addEventListener('click', (e) => {
      const t = e.target as Element;
      const onDot = !!t.closest?.('.user-dot');
      if (!onDot && t.closest?.('input, textarea, select, [contenteditable]')) return;
      if (onDot || dot.isConnected) void askForCompass(onDot);
    }, true);
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) dropCompass(); });
}
