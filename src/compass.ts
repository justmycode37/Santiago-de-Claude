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
