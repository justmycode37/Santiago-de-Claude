// The lines the base map draws (swisstopo's rails and roads, src/vector-lines.ts), for the live vehicles on the map:
// a bus is laid onto the road the map draws (its way from the engine runs within a metre or two of it, OpenStreetMap
// against swisstopo's own survey) and keeps to its lane there; a vehicle on rails is drawn dashed where its track
// runs in a tunnel. Pure (no DOM): Node tests and tools use it as the page does.
//
// Laying a way onto the drawn roads (layRoad): every few metres along it, the drawn roads beside it running its way
// are candidates, each as a sideways offset; one is chosen for the whole way at once (as a map matcher does: Viterbi
// over the samples), so the bus stays on the road it is on and changes only where that road ends or turns off; and
// where it does change, it moves across gradually (a lane change over some 20 m), never in a step. The laid way keeps
// the engine's way's length as its measure, so a vehicle a share of the way along is as far along on it as on the
// engine's way, whichever part of the way was sent (`hopSpan`).
import type { TileLine } from './vector-lines.ts';

/** A way as drawn: its points and, per point, km along the engine's way; per point, whether it is in a tunnel. */
export interface LaidLine { pts: LngLat[]; cum: number[]; tunnel: Uint8Array | null; complete: boolean }

const CELL = 0.0005; // about 38 × 55 m
const cellKey = (x: number, y: number) => x * 65536 + y;
/** The road classes a bus is laid onto, and half their drawn width (metres, as the base map draws them at zoom 18). */
export const ROAD_HALF: Record<string, number> = {
  motorway: 3.6, trunk: 3.5, primary: 3.2, secondary: 3.0, tertiary: 2.8, minor: 2.55, service: 2.55, busway: 2.55,
  track: 1.2, path: 1.2, footway: 1.2,
};
export const ROAD_CLASSES = new Set(Object.keys(ROAD_HALF));
export const RAIL_CLASSES = new Set(['rail', 'transit']);

/** The drawn lines of some tiles, by cells: segments as [lon, lat] pairs, each with its class, tunnel and one way. */
export class DrawnLines {
  private cells = new Map<number, number[]>();
  private xy: number[] = []; // ax, ay, bx, by per segment
  private half: number[] = []; // per segment: half the drawn width (roads), 0 on rails
  private flags: number[] = []; // per segment: 1 tunnel, 2 one way
  /** Tiles taken in ("x/y" at zoom 14). */
  readonly tiles = new Set<string>();
  get size() { return this.half.length; }
  /** Takes in a tile's lines (once per tile). */
  add(tile: string, lines: TileLine[]) {
    if (this.tiles.has(tile)) return;
    this.tiles.add(tile);
    for (const l of lines) {
      const half = ROAD_HALF[l.cls] || 0, fl = (l.tunnel ? 1 : 0) | (l.oneway ? 2 : 0);
      for (let k = 1; k < l.pts.length; k++) {
        const a = l.pts[k - 1], b = l.pts[k], i = this.half.length;
        if (a[0] === b[0] && a[1] === b[1]) continue;
        this.xy.push(a[0], a[1], b[0], b[1]);
        this.half.push(half);
        this.flags.push(fl);
        for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++)
          for (let y = Math.floor(Math.min(a[1], b[1]) / CELL); y <= Math.floor(Math.max(a[1], b[1]) / CELL); y++) {
            const key = cellKey(x, y), list = this.cells.get(key);
            if (list) list.push(i); else this.cells.set(key, [i]);
          }
      }
    }
  }
  /** Whether the tile with point p (zoom 14) has been taken in. */
  covers(p: LngLat): boolean { return this.tiles.has(tileKey(p)); }
  /** Calls f with each segment in the cells around p (a segment can come more than once). */
  near(p: LngLat, f: (ax: number, ay: number, bx: number, by: number, half: number, flags: number) => void) {
    const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL), xy = this.xy;
    for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
      const list = this.cells.get(cellKey(x, y));
      if (list) for (const i of list) f(xy[4 * i], xy[4 * i + 1], xy[4 * i + 2], xy[4 * i + 3], this.half[i], this.flags[i]);
    }
  }
  /**
   * Whether the drawn line nearest p (within `within` metres) running the way from `a` to `b` (within 45°: not one it
   * crosses, over or under it) runs in a tunnel.
   */
  tunnelAt(p: LngLat, a: LngLat, b: LngLat, within = 8): boolean {
    const kx = 111320 * Math.cos((p[1] * Math.PI) / 180), ky = 110540;
    const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky, dl = Math.hypot(dx, dy);
    let best = within, tunnel = false;
    this.near(p, (ax, ay, bx, by, _h, fl) => {
      const sx = (bx - ax) * kx, sy = (by - ay) * ky, l2 = sx * sx + sy * sy;
      if (dl > 0 && l2 > 0 && Math.abs(sx * dx + sy * dy) < 0.7 * Math.sqrt(l2) * dl) return;
      const u = l2 ? Math.max(0, Math.min(1, ((p[0] - ax) * kx * sx + (p[1] - ay) * ky * sy) / l2)) : 0;
      const d = Math.hypot((ax - p[0]) * kx + u * sx, (ay - p[1]) * ky + u * sy);
      if (d < best) { best = d; tunnel = (fl & 1) !== 0; }
    });
    return tunnel;
  }
}
/** The zoom 14 tile with point p, as "x/y". */
export function tileKey(p: LngLat): string {
  const n = 16384, s = Math.sin((p[1] * Math.PI) / 180);
  return Math.floor(((p[0] + 180) / 360) * n) + '/' + Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
}

function distKm(a: LngLat, b: LngLat) {
  const R = 6371, r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLng = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const STEP_M = 5; // a sample every 5 m along the way
const SNAP_M = 6; // drawn roads further off than this are not the one it is on
const MIN_COS = Math.cos((35 * Math.PI) / 180); // …nor one crossing it
const NONE_COST = 10; // staying on the engine's way where a drawn road is near: only to stay on the road it is on
const SWITCH = 2.5; // changing to another road (or off the drawn ones)
const SLOPE = 0.25; // moving across at most 25 cm per metre along (a lane's width over some 12 m)
const BUS_HALF_W = 1.275, LANE_MARGIN = 0.4, LANE_MAX = 0.8;
/**
 * How far right of a drawn road's middle a bus keeps: to its side, well within what is drawn (measured on Bern's buses: 1.6 m
 * right put a side of 44 % of them off the drawn road, 0.8 m 1.8 %); in the middle of a one-way road.
 */
const laneOf = (half: number, flags: number) => ((flags & 2) || !half ? 0 : Math.max(0, Math.min(LANE_MAX, half - BUS_HALF_W - LANE_MARGIN)));

/**
 * A road vehicle's way (the engine's, [lon, lat]) laid onto the drawn roads, in its lane. `complete`: every tile it
 * crosses was in `lines` (else lay it again when they are).
 */
export function layRoad(raw: LngLat[], lines: DrawnLines): LaidLine {
  // the samples: the way's points, and every STEP_M between; km along it
  const kx = 111320 * Math.cos((raw[0][1] * Math.PI) / 180), ky = 110540;
  const pts: LngLat[] = [raw[0]], cum = [0];
  for (let k = 1; k < raw.length; k++) {
    const a = raw[k - 1], b = raw[k], len = distKm(a, b), n = Math.max(1, Math.ceil((len * 1000) / STEP_M));
    for (let s = 1; s <= n; s++) {
      pts.push(s === n ? b : [a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
      cum.push(cum[cum.length - 1] + len / n);
    }
  }
  const n = pts.length;
  // per sample: its right-hand normal (planar metres, x east, y north) and the candidates as offsets along it
  const nx = new Float64Array(n), ny = new Float64Array(n);
  const cand: { o: number; lane: number; tunnel: boolean }[][] = [];
  let complete = true;
  for (let k = 0; k < n; k++) {
    const p0 = pts[Math.max(0, k - 1)], p1 = pts[Math.min(n - 1, k + 1)], q = pts[k];
    const dx = (p1[0] - p0[0]) * kx, dy = (p1[1] - p0[1]) * ky, dl = Math.hypot(dx, dy);
    const list: { o: number; lane: number; tunnel: boolean; d: number }[] = [];
    if (dl > 0) {
      nx[k] = dy / dl; ny[k] = -dx / dl;
      if (complete && (k % 20 === 0 || k === n - 1) && !lines.covers(q)) complete = false; // (every 100 m: a tile is 1.6 km)
      lines.near(q, (ax, ay, bx, by, half, fl) => {
        if (!half) return;
        const sx = (bx - ax) * kx, sy = (by - ay) * ky, sl = Math.hypot(sx, sy);
        if (!sl || Math.abs((sx * dx + sy * dy) / (sl * dl)) < MIN_COS) return;
        const t = Math.max(0, Math.min(1, ((q[0] - ax) * kx * sx + (q[1] - ay) * ky * sy) / (sl * sl)));
        const ex = (ax - q[0]) * kx + t * sx, ey = (ay - q[1]) * ky + t * sy, d = Math.hypot(ex, ey);
        if (d > SNAP_M) return;
        // the road's middle as an offset to the right of the way (along it, the nearest point is beside the sample)
        const o = ex * nx[k] + ey * ny[k];
        // one way roads drawn twice (a carriageway each way) come once, the same line from two tiles once
        const same = list.find((c) => Math.abs(c.o - o) < 0.5);
        const lane = laneOf(half, fl);
        if (!same) list.push({ o, lane, tunnel: (fl & 1) !== 0, d });
        else if (d < same.d) Object.assign(same, { o, lane, tunnel: (fl & 1) !== 0, d });
      });
    } else if (k) { nx[k] = nx[k - 1]; ny[k] = ny[k - 1]; }
    list.sort((a, b) => a.d - b.d);
    cand.push(list.slice(0, 4));
  }
  // Viterbi: state j < cand[k].length is that road, the last state the engine's way (offset 0)
  const cost: Float64Array[] = [], from: Int8Array[] = [];
  const emit = (k: number, j: number) => (j < cand[k].length ? 0.5 * Math.abs(cand[k][j].o) : NONE_COST);
  const off = (k: number, j: number) => (j < cand[k].length ? cand[k][j].o : 0);
  for (let k = 0; k < n; k++) {
    const m = cand[k].length + 1, c = new Float64Array(m), f = new Int8Array(m);
    for (let j = 0; j < m; j++) {
      if (!k) { c[j] = emit(k, j); continue; }
      const prev = cost[k - 1], pm = prev.length;
      let best = Infinity, bi = 0;
      for (let i = 0; i < pm; i++) {
        const jump = Math.abs(off(k, j) - off(k - 1, i)), noneSwap = (i === pm - 1) !== (j === m - 1);
        const x = prev[i] + jump + (jump > 0.75 || noneSwap ? SWITCH : 0);
        if (x < best) { best = x; bi = i; }
      }
      c[j] = best + emit(k, j);
      f[j] = bi;
    }
    cost.push(c);
    from.push(f);
  }
  const pick = new Int8Array(n);
  {
    const last = cost[n - 1];
    let j = 0;
    for (let i = 1; i < last.length; i++) if (last[i] < last[j]) j = i;
    for (let k = n - 1; k >= 0; k--) { pick[k] = j; j = from[k][j]; }
  }
  // the offset to draw at each sample: the road's middle plus its lane; changes spread over SLOPE (forwards and
  // backwards, averaged: centred on where it changes)
  const want = new Float64Array(n), tunnel = new Uint8Array(n);
  let any = false;
  for (let k = 0; k < n; k++) {
    const c = cand[k][pick[k]];
    if (c) { want[k] = c.o + c.lane; tunnel[k] = c.tunnel ? 1 : 0; any = true; }
  }
  if (!any) return { pts: raw, cum: rawCum(raw), tunnel: null, complete };
  const fw = new Float64Array(n), bw = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const step = k ? (cum[k] - cum[k - 1]) * 1000 * SLOPE : 0;
    fw[k] = k ? Math.max(fw[k - 1] - step, Math.min(fw[k - 1] + step, want[k])) : want[k];
  }
  for (let k = n - 1; k >= 0; k--) {
    const step = k < n - 1 ? (cum[k + 1] - cum[k]) * 1000 * SLOPE : 0;
    bw[k] = k < n - 1 ? Math.max(bw[k + 1] - step, Math.min(bw[k + 1] + step, want[k])) : want[k];
  }
  const out: LngLat[] = pts.map((q, k) => {
    const o = (fw[k] + bw[k]) / 2;
    return [q[0] + (nx[k] * o) / kx, q[1] + (ny[k] * o) / ky];
  });
  roundCorners(out);
  return { pts: out, cum, tunnel: tunnel.some((x) => x) ? tunnel : null, complete };
}
/**
 * A road's corners as a bus drives them: rounded (a way turning at one point, as mapped, turns over some metres), so
 * its rigid parts swing round the corner instead of across it. In place; the ends stay.
 */
const ROUND_PASSES = 2;
function roundCorners(pts: LngLat[]) {
  const n = pts.length;
  if (n < 3) return;
  const x = pts.map((p) => p[0]), y = pts.map((p) => p[1]);
  for (let pass = 0; pass < ROUND_PASSES; pass++) {
    let px = x[0], py = y[0];
    for (let k = 1; k < n - 1; k++) {
      const cx = x[k], cy = y[k];
      x[k] = (px + 2 * cx + x[k + 1]) / 4;
      y[k] = (py + 2 * cy + y[k + 1]) / 4;
      px = cx; py = cy;
    }
  }
  for (let k = 1; k < n - 1; k++) pts[k] = [x[k], y[k]];
}
function rawCum(pts: LngLat[]): number[] {
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + distKm(pts[k - 1], pts[k]));
  return cum;
}
