// ---------- Which way the phone faces: the compass, from the device orientation ----------
// No page state here, so the tests can run it (tools/test_compass.mts). The map's beam (src/app/heading.ts) uses it.

/** The parts of a DeviceOrientationEvent read here (iOS adds the webkit ones). */
export interface OrientationLike {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  absolute?: boolean;
  webkitCompassHeading?: number | null;
  /** ± degrees; negative: the compass needs calibrating. */
  webkitCompassAccuracy?: number | null;
}

/** One compass reading: where you face (deg, clockwise from north) and how sure the phone is of it. */
export interface CompassReading {
  deg: number;
  /** ± degrees as the phone reports it; null: it does not say (Android). */
  acc: number | null;
}

const R = Math.PI / 180;
export const angDiff = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;
const norm = (d: number) => ((d % 360) + 360) % 360;

/** iOS says it has no usable compass heading (accuracy −1: unavailable or needing calibration, heading then 0). */
export const compassOff = (e: OrientationLike) => typeof e.webkitCompassAccuracy === 'number' && e.webkitCompassAccuracy < 0;

/**
 * Where you face, from one orientation event; `screenAngle` is how the screen is turned (screen.orientation.angle).
 * Flat, it is where the top of the screen points; upright, where the back camera looks; in between, a blend of the
 * two weighted by how flat the screen lies, so tilting the phone never flips it and a roll of the wrist barely moves
 * it. Null when the phone cannot tell: no compass relative to north (iOS's alpha is not), the screen facing the
 * ground, or tilted about 55° away from you (top down, screen up), where you could be on either side of it.
 */
export function compassReading(e: OrientationLike, screenAngle = 0): CompassReading | null {
  if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
    if (compassOff(e)) return null;
    // iOS: the compass heading of the phone's top, corrected for how the screen is turned
    const acc = typeof e.webkitCompassAccuracy === 'number' ? e.webkitCompassAccuracy : null;
    return { deg: norm(e.webkitCompassHeading + screenAngle), acc };
  }
  // W3C angles (R = Rz(α)·Rx(β)·Ry(γ), x east, y north, z up), only when relative to north
  if (e.absolute !== true || ![e.alpha, e.beta, e.gamma].every(Number.isFinite)) return null;
  const cA = Math.cos(e.alpha! * R), sA = Math.sin(e.alpha! * R), cB = Math.cos(e.beta! * R), sB = Math.sin(e.beta! * R);
  const cG = Math.cos(e.gamma! * R), sG = Math.sin(e.gamma! * R);
  const up = cB * cG; // how much the screen faces the sky: 1 flat, 0 upright, below 0 past it
  if (up < -0.7) return null; // the screen faces the ground
  // the top of the screen: the device's +y, or its +x / −x / −y when the screen is turned
  const sT = Math.sin(screenAngle * R), cT = Math.cos(screenAngle * R);
  const xE = cA * cG - sA * sB * sG, xN = sA * cG + cA * sB * sG; // device +x
  const yE = -sA * cB, yN = cA * cB; // device +y
  const camE = -cA * sG - sA * sB * cG, camN = -sA * sG + cA * sB * cG; // device −z: the back camera
  // the screen's top as much as the screen lies flat, the camera as much as it stands up
  const top = Math.max(up, 0), cam = 1 - up;
  const east = top * (sT * xE + cT * yE) + cam * camE;
  const north = top * (sT * xN + cT * yN) + cam * camN;
  if (Math.hypot(east, north) < 0.25) return null;
  return { deg: norm(Math.atan2(east, north) / R), acc: null };
}

/**
 * How far true north lies east of magnetic north in Switzerland (deg), at a longitude and a time (ms). The phones'
 * compasses point to magnetic north (iOS's webkitCompassHeading, as Apple documents it; the absolute angles of the
 * W3C event, whose frame is magnetic north), GPS's course and the map to true north. Fitted to NOAA's World Magnetic
 * Model 2025 (Geneva 3.1°, Bern 3.4°, Zürich 3.7°, St. Gallen 3.8° in late 2026; +0.13° a year): within 0.1° of it
 * across the country, against the model's own ±0.4°. The model holds until 2030.
 */
export function swissDeclination(lng: number, t: number) {
  const year = 1970 + t / 31557600000;
  return 3.28 + 0.234 * (lng - 7.44) + 0.126 * (Math.min(2030, Math.max(2026, year)) - 2026);
}

/** Which way b lies from a (deg clockwise from north; flat, fine over the few hundred metres it is used for). */
export function bearingDeg(a: readonly [number, number], b: readonly [number, number]) {
  const kx = Math.cos(((a[1] + b[1]) / 2) * R);
  return norm(Math.atan2((b[0] - a[0]) * kx, b[1] - a[1]) / R);
}
const metres = (a: readonly [number, number], b: readonly [number, number]) =>
  Math.hypot((b[0] - a[0]) * 111320 * Math.cos(((a[1] + b[1]) / 2) * R), (b[1] - a[1]) * 110540);

/** The direction you go, as the GPS fixes say it: deg, half the angle it may be off (deg), when (ms). */
export interface Course { deg: number; spread: number; at: number }

/**
 * The direction you go, from the GPS fixes: the one the phone reports with a fix (iOS does while you move, Android
 * often does not), else the line from an earlier fix to this one, once you have gone clearly further than both
 * fixes may be off. Standing still (a fix saying under 0.5 m/s) forgets it.
 */
export class CourseTracker {
  course: Course | null = null;
  private anchor: { ll: [number, number]; acc: number; t: number } | null = null;

  fix(ll: [number, number], acc: number, heading: number | null | undefined, speed: number | null | undefined, t: number) {
    if (this.course && t < this.course.at) return this.course;
    const here = { ll, acc, t };
    const good = acc <= 30 ? here : null; // (a rough fix is no place to measure the next one from)
    if (Number.isFinite(speed) && speed! < 0.5) { this.course = null; this.anchor = good; return null; }
    if (heading != null && Number.isFinite(heading) && heading >= 0 && Number.isFinite(speed) && speed! >= 1) {
      this.course = { deg: norm(heading), spread: 25, at: t };
      this.anchor = good;
      return this.course;
    }
    if (!(acc <= 30)) return this.course; // too rough to say which way
    const a = this.anchor;
    if (!a || t - a.t > 30000 || t <= a.t) { this.anchor = here; return this.course; }
    const d = metres(a.ll, ll), noise = a.acc + acc;
    if (d < Math.max(8, noise)) return this.course; // not yet clearly further than the fixes may be off
    this.course = { deg: bearingDeg(a.ll, ll), spread: Math.min(45, Math.max(12, Math.atan2(noise, d) / R)), at: t };
    this.anchor = here;
    return this.course;
  }
}

/** Narrowest and widest the beam gets (half its angle, deg). */
export const SPREAD_MIN = 15, SPREAD_MAX = 70;
/** Half-angle for a phone that does not say how sure it is, when it holds steady. */
const SPREAD_UNKNOWN = 22;

/**
 * Smooths the readings into the beam's direction and its width: half the angle it covers (deg), the uncertainty.
 * The width is what the phone reports (iOS), at least how much the readings jump about, never under SPREAD_MIN.
 */
export class CompassFilter {
  deg: number | null = null;
  spread = SPREAD_MAX;
  at = -Infinity;
  private jitter = 0; // mean squared jump between a reading and the smoothed direction (deg²)

  update(r: CompassReading, t: number) {
    const gap = t - this.at > 2000;
    this.at = t;
    if (this.deg == null || gap) {
      this.deg = r.deg;
      this.jitter = 15 * 15;
    } else {
      const d = angDiff(r.deg, this.deg);
      this.deg = norm(this.deg + d * 0.25);
      this.jitter = 0.92 * this.jitter + 0.08 * d * d;
    }
    const reported = r.acc != null ? r.acc : SPREAD_UNKNOWN;
    const target = Math.min(SPREAD_MAX, Math.max(SPREAD_MIN, reported, 1.5 * Math.sqrt(this.jitter)));
    this.spread = gap ? target : this.spread + (target - this.spread) * 0.1;
    return this;
  }
}
