// Where each live vehicle on the map is drawn, frame by frame (src/app/live-vehicles.ts draws them; the replay
// tools/vehicle_replay.mts measures them): what is shown of it (KANTE_LIVE.showVehicle: glided to each newer answer),
// its body along its way, cut into its rigid carriages, and kept behind the one in front where two share a track or
// a lane. Pure (no DOM, no map): everything in [lon, lat].
//
// Nothing here moves a drawn vehicle back along its way or sideways off it: being kept behind another only ever holds
// a vehicle where it is (it waits until there is room, then moves up), never pulls it back.
import { KANTE_LIVE } from './live.ts';
import type { KanteShownVehicle, KanteVehicleHop } from './live.ts';

/** How a vehicle of a kind is made up, metres: its parts' lengths, width, cabs at both ends, gap between parts. */
export interface Make { parts: number[]; width: number; cabs: 1 | 2; gap: number; rail: boolean; road: boolean }
// Swiss trams 36–43 m in five sections (Combino, Flexity, Cobra), city buses articulated (18 m), PostAuto's 12 m,
// regional trains about 100 m (FLIRT, KISS in pairs), long-distance ones 300 m in coaches of 25 m
const LONG_DISTANCE = /^(IC|ICE|ICN|IR|IRE|EC|EN|NJ|TGV|RJ|RJX|PE|EXT)$/;
const repeat = (n: number, len: number) => Array.from({ length: n }, () => len);
const makes = new Map<string, Make>();
export function makeOf(line: Partial<KanteLine>): Make {
  const key = line.mode + '|' + (line.category || '') + '|' + (line.operator || '');
  let m = makes.get(key);
  if (!m) { m = makeOfLine(line); if (makes.size > 500) makes.clear(); makes.set(key, m); }
  return m;
}
function makeOfLine(line: Partial<KanteLine>): Make {
  const cat = (line.category || '').toUpperCase();
  switch (line.mode) {
    case 'tram': return { parts: [9.5, 5.5, 9, 5.5, 9.5], width: 2.4, cabs: 2, gap: 0.5, rail: true, road: false };
    case 'bus': case 'ondemand':
      return { parts: /PostAuto|CarPostal|AutoPostale/i.test(line.operator || '') ? [12] : [10.5, 7.2], width: 2.55, cabs: 1, gap: 0.6, rail: false, road: true };
    case 'rail': return { parts: LONG_DISTANCE.test(cat) ? repeat(12, 25) : repeat(4, 25), width: 2.9, cabs: 2, gap: 0.9, rail: true, road: false };
    case 'metro': return { parts: repeat(3, 20), width: 2.7, cabs: 2, gap: 0.8, rail: true, road: false };
    case 'rack': return { parts: repeat(2, 24), width: 2.65, cabs: 2, gap: 0.8, rail: true, road: false };
    case 'funicular': return { parts: [25], width: 2.6, cabs: 2, gap: 0, rail: true, road: false };
    case 'cableway': return { parts: [8], width: 3, cabs: 2, gap: 0, rail: false, road: false };
    case 'boat': return { parts: [50], width: 9, cabs: 1, gap: 0, rail: false, road: false };
    default: return { parts: [12], width: 2.5, cabs: 1, gap: 0.6, rail: false, road: true };
  }
}
export const lengthOf = (m: Make) => m.parts.reduce((a, x) => a + x, 0) + m.gap * (m.parts.length - 1);

/** A vehicle the layout takes: a vehicle of /api/vehicles with the time of its answer. */
export type LayoutVehicle = KanteVehicleHop & { tripId: string; serviceDate: string; line: Partial<KanteLine>; t: number };
/** A vehicle as drawn: its carriages back to front, each from where its back is to where its front is. */
export interface Placed<V extends LayoutVehicle> {
  /** Its index in the list. */
  i: number; k: string; v: V; s: KanteShownVehicle<V>; make: Make;
  /** Null: its way is not known (drawn as a disc at s.ll). */
  cars: [LngLat, LngLat][] | null;
  /** Per carriage: in a tunnel. */
  tunnel: boolean[];
}

const KY = 110540;
const kxAt = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);
/** The point m metres along a line given with its cumulative metres (a binary search). */
function at(pts: LngLat[], cum: number[], m: number): LngLat {
  let lo = 1, hi = cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < m) lo = mid + 1; else hi = mid; }
  const k = lo, l = cum[k] - cum[k - 1], t = l > 0 ? Math.max(0, Math.min(1, (m - cum[k - 1]) / l)) : 0;
  return [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * t, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * t];
}

const LANE_SIDE_M = 1.5; // two going the same way less than this apart across: the same track or lane
const SAME_WAY = 0.9; // …and facing the same way (cos)
const ROOM_M = 2; // the room kept between one and the one in front
const MOVE_UP = 6; // m/s: how fast one kept back moves up once there is room (on top of its own pace) at most
const GLIDE_UP_S = 3; // …closing what it is behind in about this many seconds
const LOOK_M = 60; // how far ahead the one in front is looked for (it is braked for in good time)
const HOLD_BRAKE = 1.2, HOLD_ACCEL = 1.2; // m/s²: how it slows down for the one in front and moves up again

/** The vehicles' layout: what is shown of each, kept from frame to frame. */
export class VehicleLayout<V extends LayoutVehicle> {
  readonly shown = new Map<string, KanteShownVehicle<V>>();
  /** How far each is held back (m) and where it was (to tell how far it has gone since). */
  private held = new Map<string, { back: number; ll: LngLat; u: number }>();
  /** Which of two is in front, by pair ("a|b" with a < b): the one in front's key. */
  private order = new Map<string, string>();
  private lastMs = NaN;
  static key(v: { tripId: string; serviceDate: string }) { return v.tripId + '|' + v.serviceDate; }

  /** Forgets the vehicles not in `keep`. */
  forget(keep: Set<string>) {
    for (const k of this.shown.keys()) if (!keep.has(k)) this.shown.delete(k);
    for (const k of this.held.keys()) if (!keep.has(k)) this.held.delete(k);
    for (const k of this.order.keys()) { const [a, b] = k.split('\n'); if (!keep.has(a) || !keep.has(b)) this.order.delete(k); }
  }
  /** Moves what is shown of each vehicle on to tNow (the engine's clock) at ms (the page's clock). */
  step(list: V[], tNow: number, ms: number, near?: (p: LngLat) => boolean) {
    this.frame++;
    for (let i = 0; i < list.length; i++) {
      const v = list[i], k = VehicleLayout.key(v), s = this.shown.get(k);
      // far from the view: every eighth frame (each its own), enough to keep it going on
      if (s && near && (i + this.frame) % 8 && !near(s.ll)) continue;
      this.shown.set(k, KANTE_LIVE.showVehicle(s, v, tNow, ms));
    }
  }
  private frame = 0;
  /**
   * The vehicles of `list` drawn as bodies that `drawn` takes (where it is, what it is, how far its body reaches from
   * there, metres), after step(): each one's carriages, the one behind kept behind the one in front.
   */
  place(list: V[], ms: number, drawn: (p: LngLat, v: V, make: Make, reachM: number) => boolean | 'near'): Placed<V>[] {
    const dt = Number.isFinite(this.lastMs) ? Math.max(0, Math.min(1, (ms - this.lastMs) / 1000)) : 0;
    this.lastMs = ms;
    // (those `drawn` calls 'near': laid out with the others, not drawn: kept apart from them before they come into view)
    const out: (Placed<V> & { len: number; body: LngLat[] | null; dir: [number, number]; c: LngLat; near: boolean })[] = [];
    let lat = 0;
    list.forEach((v, i) => {
      const k = VehicleLayout.key(v), s = this.shown.get(k);
      if (!s) return;
      const make = makeOf(v.line), len = lengthOf(make);
      const d = drawn(s.ll, v, make, len / 2 + 10);
      if (!d) return;
      const body = KANTE_LIVE.bodyAt(s.rec, s.f, len, s.prev, 0);
      let dir: [number, number] = [0, 0];
      if (body && body.length > 1) {
        const p = body[0], q = body[body.length - 1], kx = kxAt(p[1]), dx = (q[0] - p[0]) * kx, dy = (q[1] - p[1]) * KY, l = Math.hypot(dx, dy);
        if (l > 0) dir = [dx / l, dy / l];
      }
      lat = s.ll[1];
      out.push({ i, k, v, s, make, cars: null, tunnel: [], len, body, dir, c: s.ll, near: d === 'near' });
    });
    // two on the same track or in the same lane, the same way: the one behind behind the other's tail (by cells as
    // large as the longest of them: only those near enough to touch are compared)
    const kx = kxAt(lat), cells = new Map<string, number[]>();
    const CELLM = Math.min(400, Math.max(50, ...out.map((P) => P.len + ROOM_M + LOOK_M)));
    out.forEach((P, n) => {
      if (!P.dir[0] && !P.dir[1]) return;
      const key = Math.floor((P.c[0] * kx) / CELLM) + ',' + Math.floor((P.c[1] * KY) / CELLM);
      (cells.get(key) || cells.set(key, []).get(key)!).push(n);
    });
    // per vehicle behind another: the room it has before it is too near the one in front (as drawn), and how fast
    // that one is drawn going
    const room = new Map<string, number>(), aheadGoes = new Map<string, number>();
    const backOf = (k: string) => this.held.get(k)?.back || 0;
    for (const [key, here] of cells) {
      const [cx, cy] = key.split(',').map(Number);
      for (const a of here) for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) for (const b of cells.get(x + ',' + y) || []) {
        if (b <= a) continue;
        const A = out[a], B = out[b];
        // on rails or on the road (a tram and a bus in one street's lane too)
        if ((!A.make.rail && !A.make.road) || (!B.make.rail && !B.make.road)) continue;
        const need = (A.len + B.len) / 2 + ROOM_M;
        // heading for (or standing at) the same boarding point: one after the other into it, by how far each still has
        // to go along its own way (two lines coming in from two branches queue before they meet)
        const sa = stopAhead(A), sb = stopAhead(B);
        if (sa && sb && sa.key === sb.key) {
          // (which is first by where they are; how far apart by where they are drawn)
          const ra = sa.left, rb = sb.left;
          if (Math.abs(ra - rb) < need + LOOK_M + backOf(A.k) + backOf(B.k)) {
            const pk = A.k < B.k ? A.k + '\n' + B.k : B.k + '\n' + A.k;
            let front = this.order.get(pk);
            if (!front || (front === A.k && ra > rb + 2) || (front === B.k && rb > ra + 2)) {
              front = Math.abs(ra - rb) > 0.5 ? (ra < rb ? A.k : B.k) : first(A, B);
              this.order.set(pk, front);
            }
            const [F, R, gap] = front === A.k ? [A, B, rb + backOf(B.k) - ra - backOf(A.k)] : [B, A, ra + backOf(A.k) - rb - backOf(B.k)];
            if (gap - need < (room.get(R.k) ?? Infinity)) { room.set(R.k, gap - need); aheadGoes.set(R.k, this.held.get(F.k)?.u ?? 0); }
            continue;
          }
        }
        if (A.dir[0] * B.dir[0] + A.dir[1] * B.dir[1] < SAME_WAY) continue;
        const dx = (B.c[0] - A.c[0]) * kx, dy = (B.c[1] - A.c[1]) * KY;
        const along = dx * A.dir[0] + dy * A.dir[1], side = Math.abs(-dx * A.dir[1] + dy * A.dir[0]);
        if (side > LANE_SIDE_M || Math.abs(along) > need + LOOK_M + backOf(A.k) + backOf(B.k)) continue;
        // which is in front: as it was, unless clearly the other way now; first time: the one further on, at one
        // place the one that came first (arrived earlier), then by key
        const pk = A.k < B.k ? A.k + '\n' + B.k : B.k + '\n' + A.k;
        let front = this.order.get(pk);
        if (!front || (front === A.k && along > 2) || (front === B.k && along < -2)) {
          front = Math.abs(along) > 0.5 ? (along > 0 ? B.k : A.k) : first(A, B);
          this.order.set(pk, front);
        }
        const [F, R] = front === A.k ? [A, B] : [B, A];
        // how far the one in front is ahead of the one behind as drawn
        const gap = (front === B.k ? along : -along) + backOf(R.k) - backOf(F.k);
        if (gap - need < (room.get(R.k) ?? Infinity)) { room.set(R.k, gap - need); aheadGoes.set(R.k, this.held.get(F.k)?.u ?? 0); }
      }
    }
    // each drawn going at a speed of its own: its vehicle's, slower where the one in front is near (braking for it in
    // good time, never harder than a vehicle brakes), catching up once there is room again; held back by what it has
    // not gone since, never pulled back. Where it first shows, straight where it belongs.
    for (const P of out) {
      const h = this.held.get(P.k), r = room.get(P.k) ?? Infinity;
      let back: number, u: number;
      if (!h) { back = Math.max(0, -r); u = P.s.v || 0; } else {
        // (its vehicle's own speed as shown: where its point is drawn can step a little where a hop ends)
        const v = P.s.v || 0, gone = v * dt;
        // what it may go: up to its own place (and its speed), not into the one ahead (its speed, and what it can
        // still brake for in the room left)
        // (braking for it at a little less than it can, so it stops in time though it starts braking a frame late)
        // (over it already, as two can come into view: it stands until the one in front has drawn away)
        const free = !Number.isFinite(r) ? Infinity : r < 0 ? 0 : (aheadGoes.get(P.k) || 0) + Math.sqrt(2 * HOLD_BRAKE * 0.8 * Math.max(0, r - 0.5));
        const target = Math.min(v + Math.min(MOVE_UP, h.back / GLIDE_UP_S), free);
        u = Math.max(0, h.u + Math.max(-HOLD_BRAKE * 2 * dt, Math.min(HOLD_ACCEL * dt, target - h.u)));
        back = Math.max(0, h.back + gone - u * dt);
        if (back === 0) u = v;
      }
      this.held.set(P.k, { back, ll: P.c, u });
      if (P.near) continue;
      const body = back > 0.01 ? KANTE_LIVE.bodyAt(P.s.rec, P.s.f, P.len, P.s.prev, back) : P.body;
      P.cars = body && body.length > 1 ? cut(body, P.make, P.len) : null;
      if (P.cars) {
        const mids: number[] = [];
        let at = 0;
        for (const pl of P.make.parts) { mids.push(at + pl / 2); at += pl + P.make.gap; }
        P.tunnel = KANTE_LIVE.bodyTunnels(P.s.rec, P.s.f, P.len, P.s.prev, back, mids);
      }
    }
    return out.filter((P) => !P.near).map(({ i, k, v, s, make, cars, tunnel }) => ({ i, k, v, s, make, cars, tunnel }));
  }
}

/** Of two at one place, the one in front: the one leaving first (standing), or arriving first (coming in); then by key. */
function first(A: { k: string; s: KanteShownVehicle<LayoutVehicle> }, B: { k: string; s: KanteShownVehicle<LayoutVehicle> }): string {
  const when = (x: KanteShownVehicle<LayoutVehicle>) => (x.rec.from[0] === x.rec.to[0] && x.rec.from[1] === x.rec.to[1] ? x.rec.dep : x.rec.arr);
  const a = when(A.s), b = when(B.s);
  return a !== b ? (a < b ? A.k : B.k) : A.k < B.k ? A.k : B.k;
}
/** The boarding point a vehicle is heading for, or standing at, and how far it still has to go there (m). */
function stopAhead(P: { s: KanteShownVehicle<LayoutVehicle>; make: Make }): { key: string; left: number } | null {
  if (!P.make.rail && !P.make.road) return null;
  const r = P.s.rec, standing = r.from[0] === r.to[0] && r.from[1] === r.to[1];
  if (standing) return { key: r.from[0] + ',' + r.from[1], left: 0 };
  return { key: r.to[0] + ',' + r.to[1], left: (1 - P.s.f) * KANTE_LIVE.wayLenM(r) };
}
/** A body (its stretch of way, back to front) cut into its carriages: each straight from its back to its front. */
function cut(body: LngLat[], make: Make, len: number): [LngLat, LngLat][] {
  const kx = kxAt(body[0][1]), cum = [0];
  for (let j = 1; j < body.length; j++) cum.push(cum[j - 1] + Math.hypot((body[j][0] - body[j - 1][0]) * kx, (body[j][1] - body[j - 1][1]) * KY));
  const scale = cum[cum.length - 1] / len || 1, cars: [LngLat, LngLat][] = [];
  let from = 0;
  for (const pl of make.parts) {
    cars.push([at(body, cum, from * scale), at(body, cum, (from + pl) * scale)]);
    from += pl + make.gap;
  }
  return cars;
}

/**
 * The vehicles of a newer answer, and those of the list before that it lacks, kept for `misses` answers (an answer for
 * another box, or one a moment off, can lack a vehicle briefly: dropped and back, it would start its gliding again).
 */
export function mergeAnswer<V extends LayoutVehicle & { missed?: number }>(prev: V[], next: V[], misses = 2): V[] {
  const keys = new Set(next.map((v) => VehicleLayout.key(v)));
  const kept = prev.filter((v) => !keys.has(VehicleLayout.key(v)) && (v.missed || 0) < misses).map((v) => ({ ...v, missed: (v.missed || 0) + 1 }));
  return kept.length ? next.concat(kept) : next;
}
