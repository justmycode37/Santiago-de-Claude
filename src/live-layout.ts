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
export function makeOf(line: Partial<KanteLine>): Make {
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
const MOVE_UP = 6; // m/s: how fast one kept back moves up once there is room (on top of its own pace)

/** The vehicles' layout: what is shown of each, kept from frame to frame. */
export class VehicleLayout<V extends LayoutVehicle> {
  readonly shown = new Map<string, KanteShownVehicle<V>>();
  /** How far each is held back (m) and where it was (to tell how far it has gone since). */
  private held = new Map<string, { back: number; ll: LngLat }>();
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
  step(list: V[], tNow: number, ms: number) {
    for (const v of list) {
      const k = VehicleLayout.key(v);
      this.shown.set(k, KANTE_LIVE.showVehicle(this.shown.get(k), v, tNow, ms));
    }
  }
  /**
   * The vehicles of `list` drawn as bodies that `drawn` takes (where it is, what it is, how far its body reaches from
   * there, metres), after step(): each one's carriages, the one behind kept behind the one in front.
   */
  place(list: V[], ms: number, drawn: (p: LngLat, v: V, make: Make, reachM: number) => boolean): Placed<V>[] {
    const dt = Number.isFinite(this.lastMs) ? Math.max(0, Math.min(1, (ms - this.lastMs) / 1000)) : 0;
    this.lastMs = ms;
    const out: (Placed<V> & { len: number; body: LngLat[] | null; dir: [number, number]; c: LngLat })[] = [];
    let lat = 0;
    list.forEach((v, i) => {
      const k = VehicleLayout.key(v), s = this.shown.get(k);
      if (!s) return;
      const make = makeOf(v.line), len = lengthOf(make);
      if (!drawn(s.ll, v, make, len / 2 + 10)) return;
      const body = KANTE_LIVE.bodyAt(s.rec, s.f, len, s.prev, 0);
      let dir: [number, number] = [0, 0];
      if (body && body.length > 1) {
        const p = body[0], q = body[body.length - 1], kx = kxAt(p[1]), dx = (q[0] - p[0]) * kx, dy = (q[1] - p[1]) * KY, l = Math.hypot(dx, dy);
        if (l > 0) dir = [dx / l, dy / l];
      }
      lat = s.ll[1];
      out.push({ i, k, v, s, make, cars: null, len, body, dir, c: s.ll });
    });
    // two on the same track or in the same lane, the same way: the one behind behind the other's tail (by cells as
    // large as the longest of them: only those near enough to touch are compared)
    const kx = kxAt(lat), cells = new Map<string, number[]>();
    const CELLM = Math.min(400, Math.max(50, ...out.map((P) => P.len + ROOM_M)));
    out.forEach((P, n) => {
      if (!P.dir[0] && !P.dir[1]) return;
      const key = Math.floor((P.c[0] * kx) / CELLM) + ',' + Math.floor((P.c[1] * KY) / CELLM);
      (cells.get(key) || cells.set(key, []).get(key)!).push(n);
    });
    const want = new Map<string, number>();
    for (let pass = 0; pass < 2; pass++) {
      for (const [key, here] of cells) {
        const [cx, cy] = key.split(',').map(Number);
        for (const a of here) for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) for (const b of cells.get(x + ',' + y) || []) {
          if (b <= a) continue;
          const A = out[a], B = out[b];
          if (A.make.rail !== B.make.rail || (!A.make.rail && !A.make.road) || (!B.make.rail && !B.make.road)) continue;
          if (A.dir[0] * B.dir[0] + A.dir[1] * B.dir[1] < SAME_WAY) continue;
          const dx = (B.c[0] - A.c[0]) * kx, dy = (B.c[1] - A.c[1]) * KY, need = (A.len + B.len) / 2 + ROOM_M;
          const along = dx * A.dir[0] + dy * A.dir[1], side = Math.abs(-dx * A.dir[1] + dy * A.dir[0]);
          // (each held back so far reaches that much further back)
          if (side > LANE_SIDE_M || Math.abs(along) > need + 5 + (want.get(A.k) || 0) + (want.get(B.k) || 0)) continue;
          // which is in front: as it was, unless clearly the other way now; first time: the one further on, at one
          // place the one that came first (arrived earlier), then by key
          const pk = A.k < B.k ? A.k + '\n' + B.k : B.k + '\n' + A.k;
          let front = this.order.get(pk);
          if (!front || (front === A.k && along > 2) || (front === B.k && along < -2)) {
            front = Math.abs(along) > 0.5 ? (along > 0 ? B.k : A.k) : (A.v.arr !== B.v.arr ? (A.v.arr < B.v.arr ? A.k : B.k) : (A.k < B.k ? A.k : B.k));
            this.order.set(pk, front);
          }
          const [F, R] = front === A.k ? [A, B] : [B, A];
          // how far the one in front is ahead of the one behind as drawn (each held back by what it is so far)
          const gap = (front === B.k ? along : -along) + (want.get(R.k) || 0) - (want.get(F.k) || 0);
          if (gap < need) want.set(R.k, (want.get(R.k) || 0) + (need - gap));
        }
      }
    }
    // held back: never more than it has gone on since (so it never goes back), moving up gradually once there is room;
    // where it first shows, straight where it belongs
    for (const P of out) {
      const h = this.held.get(P.k), target = want.get(P.k) || 0;
      let back = target;
      if (h) {
        const gone = KANTE_LIVE.distKm(h.ll, P.c) * 1000;
        back = target > h.back ? Math.min(target, h.back + gone) : Math.max(target, h.back - MOVE_UP * dt);
      }
      this.held.set(P.k, { back, ll: P.c });
      const body = back > 0.01 ? KANTE_LIVE.bodyAt(P.s.rec, P.s.f, P.len, P.s.prev, back) : P.body;
      P.cars = body && body.length > 1 ? cut(body, P.make, P.len) : null;
    }
    return out.map(({ i, k, v, s, make, cars }) => ({ i, k, v, s, make, cars }));
  }
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
