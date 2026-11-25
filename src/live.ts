// Live data from the Kante engine (kante/docs/LIVE-API.md): pure helpers for what /api/trip and /api/vehicles
// answer: measured and forecast stop times, where a vehicle is and how sure that is. The rides of a journey know
// their trips (src/engine-journey.ts) and the page polls them (src/app/live-engine.ts); the live vehicles on the
// map are src/app/live-vehicles.ts. The client that talks to the engine is src/engine.ts.
//
// The helpers are plain functions without the DOM, so tools can test them with Node (module.exports).

// ---------------------------------------------------------------- KANTE_LIVE (src/live.ts): live data, pure helpers

/** A position moved on to another moment (KANTE_LIVE.advance). */
export interface KanteAdvancedPosition extends Omit<KantePosition, 'dep' | 'arr'> {
  dep?: number | null;
  arr?: number | null;
  /** Moved on from a stop only because its departure time has passed: that departure was not measured. */
  stepped?: boolean;
}
/** Where a vehicle is along the drawn ride: at a stop of the ride (index), or between two. */
export type KanteRideKm = { km: number; at: number; from?: undefined; to?: undefined } | { km: number; at?: undefined; from: number; to: number };
/** What is known about how a position was worked out. */
export interface KanteLiveContext {
  basis?: KanteBasis | null;
  /** The stop it left, by name… */
  from?: string | null;
  /** …and the seconds since its measured departure from there. */
  leftS?: number | null;
  /** The stop with the last measured time, by name. */
  observedAt?: string | null;
}
/** The line of a vehicle as the journey object the app colours lines by. */
export interface KanteJourneyLike { category: string; number: string; operator: string; name: string }
/** A trip or a vehicle: anything that says how live it is. */
export type KanteLiveCarrier = { liveInfo?: KanteLiveInfo | null; live?: KanteLiveWord | boolean | null };
/** What places a vehicle of /api/vehicles; `t`: the time of the response it came in. */
export type KanteVehicleHop = Pick<KanteVehicle, 'from' | 'to' | 'dep' | 'arr'> & Partial<Pick<KanteVehicle, 'hopPath' | 'hopSpan' | 'hopStraight' | 'point' | 'nextSeq' | 'onward' | 'motion' | 'hopLen'>>
  & { line?: Partial<KanteLine> }
  & { frac?: number | null; t?: number | null }
  /** Driven on onto its onward hop by the page (hopAt): it goes on after this hop, though the next one is not known yet. */
  & { goesOn?: boolean };
/** A vehicle of /api/vehicles, as far as it tells whether it has left a stop; `info`: its liveInfoOf(), when already worked out. */
export type KanteVehicleSeen = Partial<Pick<KanteVehicle, 'from' | 'to' | 'nextSeq'>> & KanteLiveCarrier & { info?: KanteLiveInfo | null };
/** late: the walk is longer than the time left; tight: under three minutes to spare. */
export interface KanteRunOrWait { text: string; level: 'late' | 'tight' | 'ok' }

const MAX_BBOX_KM = 120; // the engine refuses larger boxes (diagonal)

// liveInfo from the new API, or the old API's "live" word
function liveInfoOf(x: KanteLiveCarrier | null | undefined): KanteLiveInfo | null {
  if (!x) return null;
  if (x.liveInfo && typeof x.liveInfo === 'object') return x.liveInfo;
  return typeof x.live === 'string' ? { state: x.live } : null;
}
// Live times only count when they are live and recent
/** Measured or forecast, and recent. */
const isLive = (info: KanteLiveInfo | null | undefined) => !!info && (info.state === 'observed' || info.state === 'predicted');

// A call's live times (unix s): the timetable plus the delay
/** A call's live times: the timetable plus the delay. */
const liveArr = (c: KanteStopCall | null | undefined) => (c && c.arr != null ? c.arr + (c.arrDelayS || 0) : c && c.dep != null ? c.dep + (c.depDelayS || 0) : null);
const liveDep = (c: KanteStopCall | null | undefined) => (c && c.dep != null ? c.dep + (c.depDelayS || 0) : liveArr(c));
const clamp01 = (x: number | null | undefined) => Math.min(1, Math.max(0, Number(x) || 0));

// Was the departure from stop `seq` measured (observedKind `dep` or `arr+dep`)?
/** Was the departure from stop `seq` measured? */
const depMeasured = (info: KanteLiveInfo | null | undefined, seq: number | null | undefined) => !!info && seq != null && info.observedSeq === seq && /(^|\+)dep$/.test(info.observedKind || '');
// The next call after seq that the vehicle stops at
/** The next call after `seq` that the vehicle stops at. */
const nextCall = (calls: KanteStopCall[] | null | undefined, seq: number) => (calls || []).filter((c) => c && c.seq > seq && !c.skipped).sort((x, y) => x.seq - y.seq)[0] || null;

// ---- Where the vehicle is at tNow (unix s), from the engine's position at pos.t: from `frac`, going on at the
//      pace of its `dep`→`arr`. A vehicle standing at a stop past its departure is moved on towards the next stop
//      it serves, marked `stepped` (that departure was not measured). ----
/** Where the vehicle is at tNow, going on from the engine's position. */
function advance(pos: KantePosition | null | undefined, calls: KanteStopCall[] | null | undefined, tNow: number): KanteAdvancedPosition | null {
  if (!pos || pos.seq == null) return null;
  const span = (d: number | null | undefined, a: number | null | undefined) => (d != null && a != null && a > d ? a - d : null);
  if (pos.state === 'between') {
    const nx = pos.nextSeq != null ? pos.nextSeq : (nextCall(calls, pos.seq) || {}).seq;
    let d: number | null | undefined = pos.dep, a: number | null | undefined = pos.arr;
    if (d == null || a == null) { // an older engine: time it by the calls
      const by = new Map<number | undefined, KanteStopCall>((calls || []).map((c) => [c.seq, c]));
      d = liveDep(by.get(pos.seq)); a = liveArr(by.get(nx));
    }
    const g = span(d, a), t0 = pos.t != null ? pos.t : tNow;
    return { ...pos, nextSeq: nx, dep: d, arr: a, frac: clamp01((Number(pos.frac) || 0) + (g ? (tNow - t0) / g : 0)) };
  }
  if (pos.state === 'at') {
    const leave = pos.dep != null ? pos.dep : liveDep((calls || []).find((c) => c.seq === pos.seq));
    const nc = nextCall(calls, pos.seq), a = liveArr(nc), g = span(leave, a);
    if (nc && g && tNow > leave!) return { ...pos, state: 'between', nextSeq: nc.seq, dep: leave, arr: a, frac: clamp01((tNow - leave!) / g), stepped: true };
    return { ...pos };
  }
  return { ...pos };
}
// …as km along the drawn ride: seqIdx = the trip's seq → the stop's place in the ride, kms = each drawn stop's km,
// stopIdx = each drawn stop's place in the ride.
// → { km, at } (index into the ride's stops) or { km, from, to }, or null when it isn't on this part of the trip
/**
 * …as km along the drawn ride. seqIdx: the trip's seq → the stop's place in the ride; kms: each drawn stop's km;
 * stopIdx: each drawn stop's place in the ride. null when it is not on this part of the trip.
 */
function rideKm(p: KanteAdvancedPosition | null | undefined, seqIdx: Map<number, number> | null | undefined, kms: (number | null | undefined)[], stopIdx: number[]): KanteRideKm | null {
  if (!p || !seqIdx || (p.state !== 'at' && p.state !== 'between')) return null;
  const place = (seq: number) => {
    const k = seqIdx.get(seq), m = k == null ? -1 : stopIdx.indexOf(k);
    return m < 0 || kms[m] == null ? null : { k, km: kms[m] } as { k: number; km: number };
  };
  const a = place(p.seq);
  if (!a) return null;
  if (p.state === 'at') return { km: a.km, at: a.k };
  const b = place(p.nextSeq != null ? p.nextSeq : p.seq + 1);
  if (!b || b.k <= a.k) return null;
  // speeding up away from the stop and braking into the next, as the engine has it (its `motion`)
  const t = p.dep != null && p.arr != null ? p.arr - p.dep : 0;
  return { km: a.km + (b.km - a.km) * wayShare(p.motion, p.hopLen, t, p.frac), from: a.k, to: b.k };
}

// ---- Saying honestly how a position was worked out. ctx: { basis, from, leftS (seconds since a measured
//      departure from `from`), observedAt (stop with the last measured time) } → { text, dim } ----
const ago = (s: number) => (s < 60 ? 'just now' : `${Math.round(s / 60)} min ago`);
/** Says how a position was worked out. dim: it is not live. */
function liveText(info: Pick<KanteLiveInfo, 'state' | 'inaccurate' | 'congestion'> | null | undefined, ctx?: KanteLiveContext | null) {
  const c = ctx || {}, state = (info && info.state) || 'timetable';
  let text;
  if (state === 'stale') text = 'Live data is out of date: estimated from older times';
  else if (c.basis === 'timetable' || state === 'timetable') text = 'Timetable only, no live data';
  else if (state === 'observed' || c.basis === 'observed-stop') {
    text = c.leftS != null && c.from ? `Left ${c.from} ${ago(c.leftS)} (measured)`
      : c.observedAt ? `Estimated from a time measured at ${c.observedAt}` : 'Estimated from a measured time';
  } else text = 'Estimated from forecasts';
  const notes = [];
  if (info && info.inaccurate) notes.push('the operator says this forecast is unreliable');
  if (info && info.congestion) notes.push('in a traffic jam');
  return { text: notes.length ? `${text} · ${notes.join(' · ')}` : text, dim: state === 'stale' || state === 'timetable' };
}

// ---- Run or wait: seconds until it leaves, seconds of walking left → { text, level } ----
function runOrWait(leftS: number, walkS: number): KanteRunOrWait {
  const spare = leftS - walkS;
  if (spare < 0) return { text: `Hurry: about ${Math.max(1, Math.round(-spare / 60))} min short`, level: 'late' };
  const m = Math.floor(spare / 60);
  if (spare < 180) return { text: `Hurry: ${m < 1 ? 'less than 1 min' : m + ' min'} to spare`, level: 'tight' };
  return { text: `${m} min to spare`, level: 'ok' };
}

// ---- Vehicles on the map ----
// The engine's line ({ name: "IR15", category: "IR", operator }) as the journey object the app colours lines by
function journeyLike(line: Partial<KanteLine> | null | undefined) {
  const l = line || {}, cat = String(l.category || ''), name = String(l.name || '');
  const num = cat && name.toUpperCase().startsWith(cat.toUpperCase()) ? name.slice(cat.length).trim() : name;
  return { category: cat, number: num || name, operator: l.operator || '', name };
}
// ---- The way a vehicle takes between two stops (the engine's `hopPath`): Google's encoded polyline, decoded once ----
interface HopLine { pts: LngLat[]; cum: number[] }
const hopLines = new Map<string, HopLine>();
/** An encoded polyline (precision 5) → [lon, lat] points. */
function decodePolyline(s: string): LngLat[] {
  const out: LngLat[] = [];
  let i = 0, lat = 0, lon = 0;
  const next = () => {
    let r = 0, sh = 0, b;
    do { b = s.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20 && i < s.length);
    return r & 1 ? ~(r >> 1) : r >> 1;
  };
  while (i < s.length) {
    lat += next();
    lon += next();
    out.push([lon / 1e5, lat / 1e5]);
  }
  return out;
}
// The map lays the ways of buses onto the roads it draws (setLineRefiner(): live-vehicles.ts with live-lines.ts, the
// base map's roads); vehicles on rails keep the engine's way, which runs on the drawn rails already (within 0.3 m in
// Bern, half of the time). A laid way keeps the engine's way's length as its measure (`cum`): the same share of it
// is as far along on either.
/** A way laid onto the map's own lines: its points, km along the engine's way at each; complete: every tile it crosses was there. */
export interface LaidWay { pts: LngLat[]; cum: number[]; complete: boolean }
/** Lays a way onto the map's own lines; null: the way as it is. */
export type LineRefiner = (pts: LngLat[]) => LaidWay | null;
let refiner: LineRefiner | null = null;
/** A laid line: `complete` (every tile it crosses was there), `drawn` (a vehicle has been drawn on it: it stays as it is). */
type LaidLine = HopLine & { complete: boolean; drawn?: boolean; version?: number };
/** How many times more of the map's lines have come (linesCame()): a way laid before is laid again once. */
let linesVersion = 0;
const refinedLines = new Map<string, LaidLine>();
/** Sets (or, null, drops) the refiner. */
function setLineRefiner(f: LineRefiner | null) {
  refiner = f;
  refinedLines.clear();
}
/**
 * More of the map's lines have come: the ways laid without them are laid again, for up to `budgetMs` (then true: more
 * to do). Those laid in full stay as they are, and so do those a vehicle has been drawn on (laid again under it, it
 * would move sideways; its next hop is laid with them).
 */
function relayLines(budgetMs = Infinity): boolean {
  if (!refiner) return false;
  const t0 = performance.now();
  for (const [k, h] of refinedLines) {
    if (h.complete || h.drawn || (h.version || 0) >= linesVersion) continue;
    if (performance.now() - t0 > budgetMs) return true;
    const laid = refiner(decodePolyline(k));
    h.version = linesVersion;
    if (laid) { h.pts = laid.pts; h.cum = laid.cum; h.complete = laid.complete; } else h.complete = true;
  }
  return false;
}
/** More of the map's lines have come (then relayLines()). */
function linesCame() { linesVersion++; }
/** Laid onto the drawn roads: road vehicles. */
const ROAD_MODES = new Set(['bus', 'ondemand']);
// How long laying ways may take within one frame (layBudget()): past it, a way not laid yet is the engine's for this
// frame (not kept); the page draws a road vehicle only once its ways are laid (isLaid()), so none is seen moving across
let layUntil = Infinity;
let layLeft = false;
/** Ways may be laid for `ms` from now (Infinity: as many as asked for). Returns whether some were left unlaid since the last call. */
function layBudget(ms: number): boolean { layUntil = performance.now() + ms; const left = layLeft; layLeft = false; return left; }
function hopLine(s: string, refine?: boolean): HopLine | null {
  let cache = refine && refiner ? refinedLines : hopLines;
  let h = cache.get(s);
  if (!h && cache === refinedLines && performance.now() > layUntil) { cache = hopLines; h = cache.get(s); layLeft = true; }
  if (!h) {
    const raw = decodePolyline(s);
    if (raw.length < 2) return null;
    const laid = cache === refinedLines ? refiner!(raw) : null;
    let cum = laid && laid.cum;
    if (!cum) {
      cum = [0];
      for (let k = 1; k < raw.length; k++) cum.push(cum[k - 1] + distKm(raw[k - 1], raw[k]));
    }
    if (cache.size > 3000) cache.clear(); // the vehicles of one window are far fewer (laid again, they come out the same)
    h = { pts: laid ? laid.pts : raw, cum, complete: laid ? laid.complete : true, version: linesVersion } as LaidLine;
    cache.set(s, h);
  }
  return h;
}
/** Whether the ways vehicle v is drawn on (its hop and the next) are laid where they are to be (road vehicles). */
function isLaid(v: KanteVehicleHop): boolean {
  if (!onRoad(v) || !refiner) return true;
  const o = v.onward;
  return (!v.hopPath || refinedLines.has(v.hopPath)) && (!o || !o.hopPath || refinedLines.has(o.hopPath));
}
/** The segment of line h that km `goal` is on: k with cum[k - 1] ≤ goal ≤ cum[k] (a binary search). */
function segAt(h: HopLine, goal: number): number {
  let lo = 1, hi = h.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (h.cum[mid] < goal) lo = mid + 1; else hi = mid;
  }
  return lo;
}
/** The point a share f (0…1) of the way along a line. */
function alongLine(h: HopLine, f: number): LngLat {
  const goal = clamp01(f) * h.cum[h.cum.length - 1], k = segAt(h, goal);
  const a = h.pts[k - 1], b = h.pts[k], l = h.cum[k] - h.cum[k - 1], t = l > 0 ? clamp01((goal - h.cum[k - 1]) / l) : 0;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// Where a vehicle of /api/vehicles is at tNow (unix s): from its `frac` at the response's time `t` (copied onto
// it), going on at the pace of its dep→arr, along the way it takes on the rails and roads (`hopPath`; only the part
// near the window asked about, `hopSpan`) where the engine knows it, else on the straight line between the stops.
// Standing at a stop (from = to) it stays there: beside the boarding point, on its track or road (`point`).
/** Where a vehicle of /api/vehicles is at tNow. */
function vehicleAt(v: KanteVehicleHop, tNow: number): LngLat {
  return hopPointAt(v, hopFrac(v, tNow));
}
/** How far along its hop (0…1, by time) a vehicle of /api/vehicles is at tNow. */
function hopFrac(v: KanteVehicleHop, tNow: number): number {
  const span = v.arr - v.dep;
  let f;
  if (v.frac != null && v.t != null) f = Number(v.frac) + (span > 0 ? (tNow - v.t) / span : 0);
  else f = span > 0 ? (tNow - v.dep) / span : tNow >= v.arr ? 1 : 0;
  return clamp01(f);
}
// How far along its way (a share of the length) a vehicle is a share f of the time into its hop: speeding up away
// from the stop, running, braking into the next (the engine's `motion`, kante/engine/crates/server/src/motion.rs);
// at an even pace without one
/** The share of the way a vehicle has gone a share f of the time into its hop. */
function wayShare(m: [number, number, number] | null | undefined, len: number | null | undefined, t: number, f: number): number {
  f = clamp01(f);
  if (!m || !len || len <= 0 || t <= 0) return f;
  const [accel, brake, v] = m, tau = f * t, t1 = v / accel, t3 = v / brake;
  const d = tau < t1 ? 0.5 * accel * tau * tau : tau < t - t3 ? 0.5 * v * t1 + v * (tau - t1) : len - 0.5 * brake * (t - tau) ** 2;
  return clamp01(d / len);
}
/** The point a share f (of the time) along a vehicle's hop: on its way on the rails and roads where known. */
function hopPointAt(v: KanteVehicleHop, f: number): LngLat {
  return pointAtShare(v, wayShare(v.motion, v.hopLen, v.arr - v.dep, f));
}
/** The point a share f of the way (of its length) along a vehicle's hop. */
function pointAtShare(v: KanteVehicleHop, f: number): LngLat {
  f = clamp01(f);
  const h = v.hopPath ? hopLine(v.hopPath, onRoad(v)) : null;
  if (h) {
    // the same share of the way's length as of the time; on the part sent, where it starts and ends in the whole way
    // (a vehicle that has run off the part sent stays at its end, outside the window, until the next answer)
    const [a, b] = v.hopSpan || [0, 1];
    return alongLine(h, b > a ? (f - a) / (b - a) : 0);
  }
  if (v.point && v.from[0] === v.to[0] && v.from[1] === v.to[1]) return v.point;
  return [v.from[0] + (v.to[0] - v.from[0]) * f, v.from[1] + (v.to[1] - v.from[1]) * f];
}
// ---- The vehicle's body: the stretch of its way it covers, `len` metres long, centred where it is (where it stands at
//      a stop is its platform's middle). Ahead it runs on along its next hop; behind, along the hop it came along
//      (`prev`). Where that is not known: a vehicle on rails carries on straight back (a platform is straight), one on
//      the road is moved forward onto its own way, so it never sticks out across what is beside the road. ----
const RAIL_MODES = new Set(['rail', 'tram', 'metro', 'funicular', 'rack']);
const railish = (v: KanteVehicleHop) => !!v.line && RAIL_MODES.has(String(v.line.mode));
const onRoad = (v: KanteVehicleHop) => !!v.line && ROAD_MODES.has(String(v.line.mode));
const lineEnd = (line: HopLine) => line.cum[line.cum.length - 1];
/** The point km along line h (beyond its ends: straight on). */
function pointOn(h: HopLine, km: number): LngLat {
  const t = lineEnd(h);
  if (km <= 0 || t <= 0) {
    const [p, q] = [h.pts[0], h.pts[1]], l = distKm(p, q) || 1e-9;
    return [p[0] - (q[0] - p[0]) * (-km / l), p[1] - (q[1] - p[1]) * (-km / l)];
  }
  if (km >= t) {
    const n = h.pts.length, [p, q] = [h.pts[n - 2], h.pts[n - 1]], l = distKm(p, q) || 1e-9;
    return [q[0] + (q[0] - p[0]) * ((km - t) / l), q[1] + (q[1] - p[1]) * ((km - t) / l)];
  }
  return alongLine(h, km / t);
}
/** The points of line h from km a to km b: before its start along `before` (its end), past its end along `next`. */
function stretch(h: HopLine, a: number, b: number, next: HopLine | null, before: HopLine | null = null): LngLat[] {
  const total = lineEnd(h), out: LngLat[] = [];
  // all of it before the line's start, or past its end: on the line before, or the next
  if (b <= 0 && before) return stretch(before, lineEnd(before) + a, lineEnd(before) + b, h);
  if (a >= total && next) return stretch(next, a - total, b - total, null, h);
  if (a < 0 && before) {
    const bt = lineEnd(before), from = bt + a; // before its start: straight on back (the body keeps its length)
    out.push(pointOn(before, from));
    for (let k = 1; k < before.pts.length - 1; k++) if (before.cum[k] > from) out.push(before.pts[k]);
    out.push(h.pts[0]);
  } else out.push(pointOn(h, a));
  for (let k = 1; k < h.pts.length - 1; k++) if (h.cum[k] > a && h.cum[k] < b) out.push(h.pts[k]);
  if (b <= total || !next) out.push(pointOn(h, b));
  else {
    out.push(h.pts[h.pts.length - 1]);
    const rest = b - total;
    for (let k = 1; k < next.pts.length - 1; k++) if (next.cum[k] < rest) out.push(next.pts[k]);
    out.push(pointOn(next, rest));
  }
  return out;
}
/**
 * The stretch of its way a vehicle shown a share f along its hop covers, `lenM` metres long, its middle `backM` metres
 * back from where it is (to keep it behind the one in front); `prev`: the hop it came along. Back to front; null where
 * its way is not known.
 */
function bodyAt(v: KanteVehicleHop, f: number, lenM: number, prev?: KanteVehicleHop | null, backM = 0): LngLat[] | null {
  const half = lenM / 2000, o = v.onward, rail = railish(v), road = onRoad(v);
  const next = o && o.hopPath && (!o.hopSpan || o.hopSpan[0] <= 0) ? hopLine(o.hopPath, road) : null;
  const behind = prev && prev.hopPath && (!prev.hopSpan || prev.hopSpan[1] >= 1) ? hopLine(prev.hopPath, onRoad(prev)) : null;
  // where its middle is on line h at km; on the road with nothing known behind: not past the line's start; nothing
  // known ahead: not past its end (a bus never sticks out straight beyond its way, across what is beside the road)
  const place = (h: HopLine, km: number, onward: HopLine | null) => {
    let c = km - backM / 1000;
    if (!rail && !behind) c = Math.max(c, half);
    if (!rail && !onward && !v.goesOn) c = Math.min(c, Math.max(half, lineEnd(h) - half));
    return stretch(h, c - half, c + half, onward, behind);
  };
  for (const x of [next, behind]) if (x) (x as LaidLine).drawn = true;
  if (standingAt(v)) {
    if (next) return place(next, 0, null);
    if (!behind) return null;
    // at the end of its run: where its way ends (a road vehicle with all of it on its way, as it came in)
    let c = lineEnd(behind) - backM / 1000;
    if (!rail) c = Math.min(c, Math.max(half, lineEnd(behind) - half));
    return stretch(behind, c - half, c + half, null);
  }
  const h = v.hopPath ? hopLine(v.hopPath, road) : null;
  if (!h) return null;
  (h as LaidLine).drawn = true;
  const [a, b] = v.hopSpan || [0, 1], total = lineEnd(h);
  const km = (b > a ? (clamp01(f) - a) / (b - a) : 0) * total;
  // on the hop's last part sent, the onward hop goes on from where it ends
  return place(h, km, b >= 1 ? next : null);
}

// ---- Gliding: what is shown moves smoothly towards where the data puts the vehicle, along its way. A newer answer that
//      puts it a little ahead or behind is not jumped to: the shown place goes on at up to twice the vehicle's pace to
//      catch up, or slows down (never backwards) to let it come; a gap of more than JUMP_S of travel is jumped. ----
const GLIDE_S = 3; // a gap is closed in about this many seconds
const JUMP_S = 60;
/**
 * One step of a shown place towards its target (a share of a hop, or km along a ride): `rate` is how fast the target
 * moves (per second, ≥ 0), `dt` the seconds since the last step, `jump` the gap that is jumped rather than closed
 * (default: JUMP_S of travel at `rate`). The shown place never moves backwards, and moves on at no more than twice
 * the rate (a vehicle standing still: what closes the gap in about GLIDE_S).
 */
function glide(shown: number | null | undefined, target: number, rate: number, dt: number, jump?: number): number {
  if (shown == null || !Number.isFinite(shown)) return target;
  const err = target - shown, r = Math.max(0, rate);
  // far behind: jumped to; far ahead of where it is: it waits there (never back)
  if (err > (jump != null ? jump : JUMP_S * r)) return target;
  if (dt <= 0) return shown;
  const v = Math.min(r > 0 ? 2 * r : Math.abs(err) / GLIDE_S, Math.max(0, r + err / GLIDE_S));
  return shown + v * Math.min(dt, 1);
}

/**
 * What is shown of a vehicle of /api/vehicles: the answer (`rec`) whose hop it is shown on, how far along it (`f`, a
 * share of the way's length) and where that is (`ll`), as of `at` (ms, the page's monotonic clock: performance.now()).
 */
export interface KanteShownVehicle<V extends KanteVehicleHop = KanteVehicleHop> {
  rec: V; f: number; at: number; ll: LngLat;
  /** The hop it was shown on before this one (it came along it): its body's tail is on it. */
  prev?: V | null;
}
const sameLL = (a: LngLat, b: LngLat) => a[0] === b[0] && a[1] === b[1];
const standingAt = (v: KanteVehicleHop) => sameLL(v.from, v.to);
// The hop a vehicle is on at tNow by its own times, when that is later than its answer: past the end of its hop it
// stands at the stop it was heading for (where its way ends), and from the onward hop's departure it drives that one
/** The hop vehicle v is on at tNow by its times (its `onward` hop taken once it is due). */
function hopAt<V extends KanteVehicleHop>(v: V, tNow: number): V {
  const o = v.onward, standing = standingAt(v);
  if (!o || (!standing && tNow < v.arr)) return v;
  const stop = standing ? v.from : v.to;
  if (tNow < o.dep) {
    return standing ? v : { ...v, from: stop, to: stop, point: v.hopPath ? hopPointAt(v, 1) : stop, frac: null, t: null, hopPath: undefined, hopSpan: undefined,
      motion: undefined, hopLen: undefined };
  }
  return { ...v, from: stop, to: o.to, nextSeq: o.nextSeq, dep: o.dep, arr: o.arr, frac: null, t: null, hopPath: o.hopPath, hopSpan: o.hopSpan,
    hopStraight: o.hopStraight, point: undefined, onward: undefined, motion: o.motion, hopLen: o.hopLen, goesOn: true };
}
// How far along its trip a vehicle shown on hop `x` a share f along is: heading for stop n, n − ½ … n; standing at n, n
const progress = (x: KanteVehicleHop, f: number) => (x.nextSeq != null ? x.nextSeq : 0) - (standingAt(x) ? 0 : 0.5 * (1 - f));
// A newer answer is glided to (glide()), not jumped to: on the same hop; into the stop at the end of the hop it is
// shown on; out of the stop it is shown at (or has just come into) onto the next hop. Anything else ahead is jumped to;
// anything behind what is shown (a delay, an answer worked out a moment earlier than the one before) is waited for: a
// vehicle shown never goes back along its way.
/** Where vehicle v (the newest answer) is shown at tNow (the engine's clock), ms (the page's clock), after `s`. */
function showVehicle<V extends KanteVehicleHop>(s: KanteShownVehicle<V> | null | undefined, answer: V, tNow: number, ms: number): KanteShownVehicle<V> {
  const dt = s ? Math.max(0, (ms - s.at) / 1000) : 0, v = hopAt(answer, tNow);
  // shares of the way's length (so a newer answer with other times or motion for the same hop moves nothing by itself),
  // and how fast that share grows (a second on); a minute of travel is jumped rather than glided
  const share = (x: V, t: number) => wayShare(x.motion, x.hopLen, x.arr - x.dep, hopFrac(x, t));
  const rate = (x: V) => Math.max(0, share(x, tNow + 1) - share(x, tNow));
  const pace = (x: V) => (x.arr > x.dep ? 1 / (x.arr - x.dep) : 0); // on average
  const jump = (x: V) => JUMP_S * Math.max(rate(x), pace(x));
  const sameHop = (a: V, b: V) => a.nextSeq === b.nextSeq && sameLL(a.from, b.from) && sameLL(a.to, b.to);
  let rec = v, f: number;
  if (!s) f = standingAt(v) ? 0 : share(v, tNow);
  else if (sameHop(s.rec, v)) {
    f = standingAt(v) ? 0 : glide(s.f, share(v, tNow), rate(v), dt, jump(v));
    // the way as it was first sent while it still reaches well past the vehicle (another part sent for another box
    // is the same way, give or take a metre: none of that shows)
    if (s.rec.hopPath && v.hopPath !== s.rec.hopPath && wayLeft(s.rec, f) > 0.4) rec = keepWay(v, s.rec);
  } else if (!standingAt(s.rec) && s.f < 1 && (standingAt(v) ? s.rec.nextSeq === v.nextSeq : sameLL(s.rec.to, v.from))) {
    rec = s.rec; // the answer has it at (or already past) the stop its shown hop leads to: drive on into it first,
    // braking (at most twice its average pace; the last stretch slower and slower)
    f = Math.min(1, s.f + Math.min(2 * pace(rec), Math.max((1 - s.f) / GLIDE_S, 0.1 * pace(rec))) * Math.min(dt, 1));
  } else if (!standingAt(v) && (standingAt(s.rec) || s.f >= 1) && sameLL(s.rec.to, v.from)) {
    f = glide(0, share(v, tNow), rate(v), dt, jump(v)); // it has left the stop it is shown at: drive out of it
  } else if (standingAt(v) && !standingAt(s.rec) && sameLL(s.rec.from, v.from)) {
    rec = s.rec; // shown leaving a stop that a newer answer has it still standing at (a delay): it waits where it is
    f = s.f;
  } else f = standingAt(v) ? 0 : share(v, tNow);
  f = clamp01(f);
  // never back along its way: an answer behind what is shown is waited for where it is
  if (s && progress(rec, f) < progress(s.rec, s.f) - 1e-9) { rec = s.rec; f = s.f; }
  // the hop it came along: kept while on the same hop, the one it was shown on when it went on from its end
  const prev = !s ? null : s.rec === rec || sameHop(s.rec, rec) ? s.prev : sameLL(s.rec.to, rec.from) && !standingAt(s.rec) ? s.rec
    : standingAt(s.rec) && sameLL(s.rec.from, rec.from) ? s.prev : null;
  return { rec, f, at: ms, ll: standingAt(rec) ? standPoint(rec, prev) : pointAtShare(rec, f), prev };
}

// km of its way sent (`hopPath`) left beyond share f (the way's whole length unknown: as if it were 1 km)
function wayLeft(v: KanteVehicleHop, f: number): number {
  const h = v.hopPath ? hopLine(v.hopPath, onRoad(v)) : null;
  if (!h) return 0;
  const [a, b] = v.hopSpan || [0, 1];
  if (f < a) return 0;
  if (b >= 1) return Infinity;
  return b > a ? ((b - f) / (b - a)) * lineEnd(h) : 0;
}
// The newer answer v with the way of the hop as it was first sent (`was`): its times and onward hop are the newer ones
const kept = new WeakMap<object, { was: object; v: KanteVehicleHop }>();
function keepWay<V extends KanteVehicleHop>(v: V, was: V): V {
  const k = kept.get(v);
  if (k && k.was === was) return k.v as V;
  const out = { ...v, hopPath: was.hopPath, hopSpan: was.hopSpan };
  kept.set(v, { was, v: out });
  return out;
}
// Where a vehicle standing at a stop is: on the way it leaves on (a road vehicle: as laid onto the drawn road), else at
// the end of the way it came along, else its place beside the boarding point
function standPoint(v: KanteVehicleHop, prev: KanteVehicleHop | null | undefined): LngLat {
  if (onRoad(v)) {
    const o = v.onward, next = o && o.hopPath && (!o.hopSpan || o.hopSpan[0] <= 0) ? hopLine(o.hopPath, true) : null;
    if (next) return next.pts[0];
    const behind = prev && prev.hopPath && (!prev.hopSpan || prev.hopSpan[1] >= 1) ? hopLine(prev.hopPath, true) : null;
    if (behind) return behind.pts[behind.pts.length - 1];
  }
  return v.point || v.from;
}

// ---- The engine's clock on the page: its time (unix s) at a moment of performance.now(). Each answer says the second
//      it was worked out for (`t`, whole seconds) and comes a little later: the clock is set by the answer that came
//      soonest after its second (the least delay seen), and never goes back. ----
/** The engine's clock: answer(t, ms) for each answer as it comes; now(ms). */
function engineClock() {
  let off = Infinity, last = -Infinity;
  const seen: number[] = [];
  return {
    /** An answer for second t came at ms (performance.now()). */
    answer(t: number, ms: number) {
      seen.push(ms / 1000 - t);
      if (seen.length > 20) seen.shift();
      off = Math.min(...seen);
    },
    /** The engine's time at ms; NaN before any answer. */
    now(ms: number) {
      if (!Number.isFinite(off)) return NaN;
      last = Math.max(last, ms / 1000 - off);
      return last;
    },
    reset() { off = Infinity; last = -Infinity; seen.length = 0; },
  };
}

// Under way (not standing at a stop) after a measured departure from the stop before `nextSeq`. With stops
// skipped in between this can't be told from the vehicle alone, and nothing is claimed.
/** Under way after a measured departure from the stop before. */
const vehicleLeftMeasured = (v: KanteVehicleSeen | null | undefined) => !!v && !!v.from && !!v.to && (v.from[0] !== v.to[0] || v.from[1] !== v.to[1])
  && v.nextSeq != null && depMeasured(v.info || liveInfoOf(v), v.nextSeq - 1);
function distKm(a: LngLat, b: LngLat) {
  const R = 6371, r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLng = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// [w, s, e, n] grown by a share of its size on every side, kept within the engine's limit
/** The box grown by a share of its size on every side, kept within the engine's limit. */
function padBbox(b: KanteBbox, share: number): KanteBbox {
  let [w, s, e, n] = b;
  const dx = (e - w) * share, dy = (n - s) * share;
  w -= dx; e += dx; s -= dy; n += dy;
  for (let k = 0; k < 20 && distKm([w, s], [e, n]) > MAX_BBOX_KM * 0.95; k++) {
    const cx = (w + e) / 2, cy = (s + n) / 2;
    w = cx - (cx - w) * 0.8; e = cx + (e - cx) * 0.8; s = cy - (cy - s) * 0.8; n = cy + (n - cy) * 0.8;
  }
  return [w, s, e, n];
}
const bboxContains = (o: KanteBbox | null | undefined, i: KanteBbox) => !!o && i[0] >= o[0] && i[1] >= o[1] && i[2] <= o[2] && i[3] <= o[3];
/** Small enough for the engine. */
const bboxOk = (b: KanteBbox) => distKm([b[0], b[1]], [b[2], b[3]]) <= MAX_BBOX_KM;
/** "w,s,e,n" with 5 decimals. */
const bboxParam = (b: KanteBbox) => b.map((x) => x.toFixed(5)).join(',');

export const KANTE_LIVE = {
  /** The largest box the engine answers /api/vehicles for (its diagonal, km). */
  MAX_BBOX_KM, liveInfoOf, isLive, liveArr, liveDep, depMeasured, nextCall, advance, rideKm, liveText,
  /** Seconds until it leaves, seconds of walking left. */
  runOrWait, journeyLike, vehicleAt, hopFrac, hopPointAt, pointAtShare, bodyAt, hopAt, wayShare, glide, showVehicle, setLineRefiner, relayLines, linesCame, layBudget, isLaid, engineClock, decodePolyline, vehicleLeftMeasured, padBbox, bboxContains, bboxOk, bboxParam, distKm,
};
