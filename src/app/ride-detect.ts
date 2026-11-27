// ---- Which vehicle you are on: GPS fixes matched against the trips around you (pure; ride-switch.ts asks it) ----
// While a journey is followed, the traveller may board another vehicle than the planned one (an earlier bus that
// goes there too, the next train of the line). This tells, from the last two minutes of fixes, whether they ride a
// public-transport vehicle, and which of the candidate trips it is:
//
// - moving like a vehicle (motion()): far enough, fast enough, over long enough that GPS jitter at a stop, walking
//   or running for the bus do not count;
// - along a trip's way (match()): every fix close to the way the trip takes, going forward along it, and where the
//   trip's vehicle is by its live stop times at that moment (the vehicle positions in Switzerland come from the live
//   times, so that is the same thing as being with the vehicle, without the guesswork of drawn positions);
// - one answer only (decide()): when a planned ride fits as well, nothing is said; when two lines fit as well (they
//   share the road), nothing yet, until they part.
//
// Nothing here touches the page: tools/test_ride_detect.mts tests it on made-up tracks.

/** A GPS fix: where, when (ms) and how accurate (m). */
export interface RideFix { ll: LngLat; t: number; acc: number }
/** A stop of a candidate trip: its seq, how far along the trip's way (km), and its live times (unix s). */
export interface RideStop { seq: number; km: number; arr: number | null; dep: number | null }
/** A trip the traveller may be on. */
export interface RideCandidate {
  /** `tripId|serviceDate` */
  key: string;
  /** The line as the badges read it ("B 12"): two trips of one line are not told apart by it. */
  line: string;
  /** One of the journey's own rides. */
  planned?: boolean;
  /** Its times come from a live feed (else the timetable's: more slack). */
  live?: boolean;
  /** Its way on the roads or rails, and its stops along it (in order, km increasing). */
  path: LngLat[];
  stops: RideStop[];
}
/**
 * match(): how well the fixes fit a trip. score: the median seconds between you and its vehicle (lower is better);
 * boardSeq: the last stop behind the first fix (you boarded there or before); lastSeq / nextSeq: the stops behind and
 * ahead of the last fix; km: where the last fix is along the trip's way.
 */
export interface RideMatch { key: string; score: number; boardSeq: number; lastSeq: number; nextSeq: number | null; km: number }
/** decide(): what the fixes say. */
export type RideDecision =
  | { kind: 'still' } // not moving like a vehicle
  | { kind: 'planned'; key: string; score: number } // on one of the planned rides
  | { kind: 'none' } // moving, but on none of the trips
  | { kind: 'unsure' } // another trip fits nearly as well
  | { kind: 'ride'; cand: RideCandidate; match: RideMatch };

/** The thresholds (docs/journeys.md, "Another vehicle than planned"). */
export const RIDE = {
  /** The fixes looked at: the last two minutes, of those within 60 m. */
  windowMs: 120000,
  maxAcc: 60,
  /** Moving like a vehicle, over fixes without a gap of more than 30 s (a tunnel, GPS lost: what came before does
   *  not count): 4 fixes over 40 s at least, 300 m from the first to the last, 3.5 m/s (12.6 km/h) on average (a
   *  tram in town, its stops and red lights included), and 6.5 m/s (23 km/h) over 15 s at some point (faster than
   *  anyone runs for that long). */
  maxGapMs: 30000,
  minFixes: 4,
  minSpanMs: 40000,
  minDispM: 300,
  minSpeed: 3.5,
  peakSpeed: 6.5,
  peakMs: 15000,
  /** Standing still: 45 s within 40 m (longer than a vehicle stops on its way, as a rule). */
  stillMs: 45000,
  stillM: 40,
  /** The newest fix may be this old. */
  maxAgeMs: 20000,
  /** On the way: within the fix's accuracy plus 30 m (40 to 90 m) for 80 % of fixes, and the last one (the fixes
   *  before the first one on it, the way to the stop, left out). */
  nearShare: 0.8,
  /** Forward along it: at least 70 % of the distance covered, never more than 80 m back. */
  forwardShare: 0.7,
  maxBackKm: 0.08,
  /** With the vehicle: the median and the largest gap to where its live times put it (s); timetable times: more. */
  gapLive: [90, 180],
  gapTimetable: [150, 240],
  /** The stop you boarded at: its vehicle had left it by 90 s after the first fix on its way. */
  boardSlackS: 90,
  /** Another trip (another line, or another run of the same one bunched with it, or a planned ride) within this many
   *  seconds of the best one: unsure. */
  rivalS: 40,
  /** Confirmed by two answers on fixes at least this far apart (ms); answers further apart than that start again. */
  confirmMs: 15000,
  confirmGapMs: 90000,
};

// ---------------------------------------------------------------- geometry (flat, fine over a few km)

// (km a degree on the sphere tracking.ts measures the rides' stops on: routing.ts distKm(), R = 6371 km)
const KY = 111195, KX = (lat: number) => KY * Math.cos(lat * Math.PI / 180);
/** Metres between two points. */
export function metres(a: LngLat, b: LngLat) {
  return Math.hypot((b[0] - a[0]) * KX((a[1] + b[1]) / 2), (b[1] - a[1]) * KY);
}
/** A way's cumulative lengths, km. */
export function cumKm(cs: LngLat[]) {
  const out = [0];
  for (let k = 1; k < cs.length; k++) out.push(out[k - 1] + metres(cs[k - 1], cs[k]) / 1000);
  return out;
}
/** Where p is along the way: km, and metres off it. from: only from this km on (a way that passes a place twice). */
export function project(cs: LngLat[], cum: number[], p: LngLat, from = -Infinity): { km: number; d: number } | null {
  let best: { km: number; d: number } | null = null;
  const kx = KX(p[1]);
  for (let j = 0; j < cs.length - 1; j++) {
    if (cum[j + 1] < from) continue;
    const a = cs[j], b = cs[j + 1];
    const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * KY, dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * KY;
    const L2 = dx * dx + dy * dy;
    let t = L2 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / L2)) : 0;
    let km = cum[j] + t * (cum[j + 1] - cum[j]);
    if (km < from) { km = from; t = cum[j + 1] > cum[j] ? (from - cum[j]) / (cum[j + 1] - cum[j]) : 0; }
    const d = Math.hypot(ax + dx * t, ay + dy * t);
    if (!best || d < best.d - 1e-9) best = { km, d };
  }
  if (!best && cs.length === 1) best = { km: 0, d: metres(p, cs[0]) };
  return best;
}

// ---------------------------------------------------------------- the fixes

/**
 * The fixes worth looking at, oldest first: of the last two minutes, those accurate enough, and of those only the ones
 * since the last gap of more than 30 s (after a tunnel or GPS lost a while, only fresh fixes count), and since the last
 * time you stood still for 45 s (waiting at the stop: from the last fix there, when the vehicle left; a vehicle's stop
 * on the way is shorter).
 */
export function recentFixes(fixes: RideFix[], now: number): RideFix[] {
  let win = fixes.filter((f) => f.t > now - RIDE.windowMs && f.t <= now + 5000 && f.acc <= RIDE.maxAcc).sort((a, b) => a.t - b.t);
  let k = win.length - 1;
  while (k > 0 && win[k].t - win[k - 1].t <= RIDE.maxGapMs) k--;
  win = win.slice(Math.max(0, k)).filter((f, i, a) => !i || f.t > a[i - 1].t); // (one fix per moment)
  for (let z = win.length - 1; z > 0; z--) {
    let j = z;
    while (j > 0 && metres(win[j - 1].ll, win[z].ll) <= RIDE.stillM) j--;
    if (win[z].t - win[j].t >= RIDE.stillMs) return win.slice(z);
  }
  return win;
}
/** Moving like a vehicle → how far (m) and how fast (m/s, from the first fix to the last), else null. */
export function motion(win: RideFix[], now: number): { dispM: number; speed: number; spanMs: number } | null {
  if (win.length < RIDE.minFixes) return null;
  const a = win[0], z = win[win.length - 1], spanMs = z.t - a.t;
  if (spanMs < RIDE.minSpanMs || now - z.t > RIDE.maxAgeMs) return null;
  const dispM = metres(a.ll, z.ll), speed = dispM / (spanMs / 1000);
  if (dispM < RIDE.minDispM || speed < RIDE.minSpeed) return null;
  // somewhere a stretch of 10 s or more at vehicle speed (over 10 s, GPS jitter of a few metres is no speed)
  let peak = 0;
  for (let i = 0, j = 0; i < win.length; i++) {
    while (j < win.length && win[j].t - win[i].t < RIDE.peakMs) j++;
    if (j >= win.length) break;
    peak = Math.max(peak, metres(win[i].ll, win[j].ll) / ((win[j].t - win[i].t) / 1000));
  }
  return peak >= RIDE.peakSpeed ? { dispM, speed, spanMs } : null;
}

// ---------------------------------------------------------------- one trip

/**
 * When a trip's vehicle is at `km` of its way, by its live times: [from, to] (unix s; a span while it stands at a
 * stop), moving at an even pace between two stops. null outside its stops.
 */
export function vehicleTimeAt(stops: RideStop[], km: number): [number, number] | null {
  const s = stops.filter((x) => x.arr != null || x.dep != null);
  if (s.length < 2 || km < s[0].km - 0.03 || km > s[s.length - 1].km + 0.03) return null;
  const arr = (x: RideStop) => (x.arr != null ? x.arr : x.dep!), dep = (x: RideStop) => (x.dep != null ? x.dep : x.arr!);
  const at = s.find((x) => Math.abs(km - x.km) <= 0.03);
  if (at) return [arr(at), dep(at)]; // at a stop (also just before it: it stands there for its time)
  for (let i = 0; i < s.length; i++) {
    const n = s[i + 1];
    if (n && km < n.km) {
      const f = n.km > s[i].km ? (km - s[i].km) / (n.km - s[i].km) : 0, t = dep(s[i]) + (arr(n) - dep(s[i])) * f;
      return [t, t];
    }
  }
  return null;
}
// Each pass of the way near p (within tol metres), in order along it: the nearest place of each stretch of the way
// that comes that near
function passes(cs: LngLat[], cum: number[], p: LngLat, tol: number): { km: number; d: number }[] {
  const out: { km: number; d: number }[] = [];
  let cur: { km: number; d: number } | null = null;
  for (let j = 0; j < cs.length - 1; j++) {
    const q = project([cs[j], cs[j + 1]], [cum[j], cum[j + 1]], p);
    if (q && q.d <= tol) { if (!cur || q.d < cur.d) cur = q; }
    else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Do the fixes (recentFixes(), moving at `now`) fit this trip: along its way, forward, with its vehicle? */
export function match(all: RideFix[], c: RideCandidate, now: number): RideMatch | null {
  if (c.path.length < 2 || c.stops.length < 2 || all.length < 2) return null;
  const cum = cumKm(c.path);
  const tol = (f: RideFix) => Math.min(90, Math.max(40, f.acc + 30));
  // the way to the stop (off the trip's way) is left out: from the first fix on it, if what is left still moves like a
  // vehicle
  const k0 = all.findIndex((f) => { const q = project(c.path, cum, f.ll); return !!q && q.d <= tol(f); });
  if (k0 < 0) return null;
  const win = all.slice(k0);
  if (k0 > 0 && !motion(win, now)) return null;
  // along the way, each fix from where the one before was, unless that leaves it far off the way (it is then where it
  // is nearest, and the check for going forward fails). Where the way passes the first fix's place more than once (out
  // and back along one street, a loop), from each of those passes: the one that goes on forward.
  const chain = (first: { km: number; d: number }) => {
    const pr = [first];
    for (const f of win.slice(1)) {
      const prev = pr[pr.length - 1].km - RIDE.maxBackKm;
      let q = project(c.path, cum, f.ll, prev);
      if (!q || q.d > tol(f)) { const any = project(c.path, cum, f.ll); if (any && (!q || any.d < q.d)) q = any; }
      if (!q) return null;
      pr.push(q);
    }
    return pr;
  };
  const dispKm = metres(win[0].ll, win[win.length - 1].ll) / 1000;
  const fits = (pr: { km: number; d: number }[]) => {
    const near = pr.filter((q, k) => q.d <= tol(win[k])).length;
    if (near < RIDE.nearShare * win.length || pr[pr.length - 1].d > tol(win[win.length - 1])) return false;
    if (pr[pr.length - 1].km - pr[0].km < RIDE.forwardShare * dispKm) return false; // forward along the way
    let top = -Infinity;
    for (const q of pr) { if (q.km < top - RIDE.maxBackKm) return false; top = Math.max(top, q.km); }
    return true;
  };
  const chains = passes(c.path, cum, win[0].ll, tol(win[0])).map(chain).filter((x): x is { km: number; d: number }[] => !!x && fits(x));
  const found = chains.map((pr) => withVehicle(win, c, pr, tol)).filter((m): m is RideMatch => !!m).sort((x, y) => x.score - y.score);
  return found[0] || null;
}
// The fixes along the trip's way (pr): with its vehicle, where its live times put it when each fix was taken?
function withVehicle(win: RideFix[], c: RideCandidate, pr: { km: number; d: number }[], tol: (f: RideFix) => number): RideMatch | null {
  // with its vehicle: where its live times put it when each fix was taken
  const gaps: number[] = [];
  for (let k = 0; k < win.length; k++) {
    if (pr[k].d > tol(win[k])) continue;
    const span = vehicleTimeAt(c.stops, pr[k].km);
    if (!span) return null; // before its first stop or past its last: not on this trip
    const t = win[k].t / 1000;
    gaps.push(t < span[0] ? span[0] - t : t > span[1] ? t - span[1] : 0);
  }
  const [medMax, maxMax] = c.live ? RIDE.gapLive : RIDE.gapTimetable;
  const score = median(gaps);
  if (!gaps.length || score > medMax || Math.max(...gaps) > maxMax) return null;
  // the stop you boarded at: the last one behind the first fix; its vehicle had left it when you started moving
  const km0 = pr[0].km, board = [...c.stops].reverse().find((s) => s.km <= km0 + 0.05) || c.stops[0];
  const left = board.dep != null ? board.dep : board.arr;
  if (left != null && left > win[0].t / 1000 + RIDE.boardSlackS) return null;
  const kz = pr[pr.length - 1].km, next = c.stops.find((s) => s.km > kz + 0.03);
  const last = [...c.stops].reverse().find((s) => s.km <= kz + 0.03) || board;
  return { key: c.key, score, boardSeq: board.seq, lastSeq: last.seq, nextSeq: next ? next.seq : null, km: kz };
}

// ---------------------------------------------------------------- all of them

/** What the fixes say about the candidates (the journey's own rides marked `planned`). */
export function decide(fixes: RideFix[], cands: RideCandidate[], now: number): RideDecision {
  const win = recentFixes(fixes, now);
  if (!motion(win, now)) return { kind: 'still' };
  let fits = cands.map((cand) => ({ cand, match: match(win, cand, now) })).filter((x): x is { cand: RideCandidate; match: RideMatch } => !!x.match);
  // a planned ride that fits, and the same trip found around you (all of it): the planned ride
  const plannedKeys = new Set(fits.filter((x) => x.cand.planned).map((x) => x.cand.key));
  fits = fits.filter((x) => x.cand.planned || !plannedKeys.has(x.cand.key));
  if (!fits.length) return { kind: 'none' };
  fits.sort((a, b) => a.match.score - b.match.score);
  const best = fits[0];
  // the best fit is a planned ride: you are on the plan
  if (best.cand.planned) return { kind: 'planned', key: best.cand.key, score: best.match.score };
  // anything else that fits nearly as well (a planned ride, another line on the same road, another run of the same
  // line bunched with it): not sure which, so nothing is said yet
  if (fits.some((x) => x !== best && x.cand.key !== best.cand.key && x.match.score - best.match.score < RIDE.rivalS)) return { kind: 'unsure' };
  return { kind: 'ride', cand: best.cand, match: best.match };
}

/** confirm(): the trip seen last, since when (its first fix's time, ms) and how many answers in a row named it. */
export interface RideSeen { key: string; at: number; n: number }
/**
 * Two answers in a row (the second on fixes at least RIDE.confirmMs newer) that name the same trip: only then is it
 * believed. → the state to keep, and whether it is confirmed now.
 */
export function confirm(seen: RideSeen | null, d: RideDecision, fixAt: number): { seen: RideSeen | null; sure: boolean } {
  if (d.kind !== 'ride') return { seen: null, sure: false };
  const key = d.cand.key;
  if (!seen || seen.key !== key || fixAt - seen.at > RIDE.confirmGapMs) return { seen: { key, at: fixAt, n: 1 }, sure: false };
  if (fixAt - seen.at < RIDE.confirmMs) return { seen, sure: seen.n >= 2 };
  const next = { key, at: fixAt, n: seen.n + 1 };
  return { seen: next, sure: next.n >= 2 };
}

export const RIDE_DETECT = { recentFixes, motion, match, decide, confirm, vehicleTimeAt, cumKm, metres, project };
