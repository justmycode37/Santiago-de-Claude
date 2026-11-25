// Tests for where the map's live vehicles are drawn (src/live-layout.ts, src/live-lines.ts, src/vector-lines.ts and the
// gliding in src/live.ts): never back along their way, never sideways off it, buses on the roads the map draws.
// Offline; exit code 1 on any failure.
//
//   node tools/test_live_layout.mts
import { KANTE_LIVE } from '../src/live.ts';
import { DrawnLines, layRoad } from '../src/live-lines.ts';
import { VehicleLayout, mergeAnswer } from '../src/live-layout.ts';
import type { LayoutVehicle } from '../src/live-layout.ts';
import { tileLines } from '../src/vector-lines.ts';

let passed = 0, failed = 0;
const check = (ok: boolean, what: string) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };
const { showVehicle, distKm } = KANTE_LIVE;
const m = (a: LngLat, b: LngLat) => distKm(a, b) * 1000;
// metres east / north of a point near Bern, as [lon, lat]
const O: LngLat = [7.44, 46.95], KX = 111320 * Math.cos((O[1] * Math.PI) / 180), KY = 110540;
const at = (e: number, n: number): LngLat => [O[0] + e / KX, O[1] + n / KY];
const enc = (pts: LngLat[]) => {
  let out = '', pa = 0, po = 0;
  const put = (v: number) => { v = v < 0 ? ~(v << 1) : v << 1; while (v >= 0x20) { out += String.fromCharCode(((v & 0x1f) | 0x20) + 63); v >>= 5; } out += String.fromCharCode(v + 63); };
  for (const [lo, la] of pts) { const a = Math.round(la * 1e5), o = Math.round(lo * 1e5); put(a - pa); put(o - po); pa = a; po = o; }
  return out;
};

console.log('never back along its way');
{
  // shown standing at B (its arrival time has passed); the next answer was worked out a moment before it arrived
  const A = at(0, 0), B = at(500, 0), C = at(1000, 0);
  const ab = { from: A, to: B, dep: 0, arr: 60, nextSeq: 2, frac: 0.9, t: 54, hopPath: enc([A, B]), onward: { nextSeq: 3, to: C, dep: 90, arr: 150, hopPath: enc([B, C]) } };
  let s = showVehicle(null, ab, 61, 0);
  check(m(s.ll, B) < 1.5, `past its arrival it stands at the stop (${m(s.ll, B).toFixed(1)} m off)`);
  const early = { ...ab, frac: 0.99, t: 59.4 };
  let back = 0, last = s.ll;
  for (let ms = 16; ms < 3000; ms += 16) {
    s = showVehicle(s, early, 61 + ms / 1000 - 0.8, ms);
    back = Math.max(back, m(B, last) < m(B, s.ll) ? m(last, s.ll) : 0);
    last = s.ll;
  }
  check(back < 0.01, `an answer from a moment before it arrived: it stays at the stop (${back.toFixed(2)} m back)`);
  // shown on B→C; a newer answer has it still on A→B (a delay): it waits, never back to A→B
  const bc = { from: B, to: C, dep: 90, arr: 150, nextSeq: 3, frac: 0.2, t: 102, hopPath: enc([B, C]) };
  let w = showVehicle(null, bc, 102, 0);
  const shownAt = w.ll;
  const late = { ...ab, frac: 0.5, t: 103, dep: 70, arr: 130 };
  for (let ms = 16; ms < 3000; ms += 16) w = showVehicle(w, late, 103 + ms / 1000, ms);
  check(m(w.ll, shownAt) < 0.01, `a delay reported after it was shown further on: it waits there (${m(w.ll, shownAt).toFixed(2)} m)`);
  // the same hop, an answer far behind what is shown: it waits, does not jump back
  const g = KANTE_LIVE.glide(0.8, 0.1, 0.01, 0.016);
  check(g === 0.8, 'gliding: a target far behind is waited for, not jumped to');
}

console.log("the engine's clock on the page");
{
  const c = KANTE_LIVE.engineClock();
  check(Number.isNaN(c.now(0)), 'no answer yet: no time');
  c.answer(1000, 500); // the answer for second 1000 came at 0.5 s
  const a = c.now(1000);
  c.answer(1015, 15900); // a slower answer later: the clock does not step back
  const b = c.now(15950);
  check(Math.abs(a - 1000.5) < 1e-9 && b >= a + 14.9, `set by the soonest answer, never back (${a.toFixed(2)} → ${b.toFixed(2)})`);
  let prev = -Infinity, mono = true;
  for (let k = 0; k < 200; k++) { if (k % 15 === 0) c.answer(1015 + k, 15500 + k * 1000 + (k % 30 ? 900 : 100)); const t = c.now(15500 + k * 1000); mono &&= t >= prev; prev = t; }
  check(mono, 'answers with varying delays: it only goes on');
}

console.log('kept behind the one in front');
{
  // two trams heading east on one track, the second arriving at the stop where the first stands
  const S = at(0, 0), N = at(400, 0), P = at(-400, 0);
  const line = { mode: 'tram' as KanteMode, name: '9', category: 'T' };
  const first: LayoutVehicle = { tripId: 'a', serviceDate: 'd', line, t: 0, from: S, to: S, dep: 200, arr: 0, nextSeq: 5, point: S, hopPath: undefined,
    onward: { nextSeq: 6, to: N, dep: 200, arr: 260, hopPath: enc([S, N]) } };
  const second = (tt: number): LayoutVehicle => ({ tripId: 'b', serviceDate: 'd', line, t: tt, from: P, to: S, dep: 0, arr: 60, nextSeq: 5, frac: tt / 60, hopPath: enc([P, S]),
    onward: { nextSeq: 6, to: N, dep: 300, arr: 360, hopPath: enc([S, N]) } });
  const L = new VehicleLayout<LayoutVehicle>();
  let lastFront: LngLat | null = null, back = 0, gap = Infinity;
  for (let ms = 0; ms < 70000; ms += 50) {
    const tt = ms / 1000, list = [first, second(Math.min(60, tt))];
    L.step(list, tt, ms);
    const placed = L.place(list, ms, () => true), b = placed.find((x) => x.k === 'b|d')!, a = placed.find((x) => x.k === 'a|d')!;
    const front = b.cars![b.cars!.length - 1][1], tail = a.cars![0][0];
    if (lastFront && front[0] < lastFront[0]) back = Math.max(back, m(front, lastFront));
    lastFront = front;
    if (tt > 50) gap = Math.min(gap, (tail[0] - front[0]) * KX);
  }
  check(back < 0.01, `the one arriving behind never goes back (${back.toFixed(2)} m)`);
  check(gap > 0, `…and stops behind the other's tail (${gap.toFixed(1)} m apart)`);
  // an answer that lacks a vehicle keeps it for two answers
  const v1 = second(10), v2 = { ...second(10), tripId: 'c' };
  let list = mergeAnswer<LayoutVehicle & { missed?: number }>([], [v1, v2]);
  list = mergeAnswer(list, [v1]);
  check(list.length === 2 && list[1].missed === 1, 'a vehicle an answer lacks is kept');
  list = mergeAnswer(mergeAnswer(list, [v1]), [v1]);
  check(list.length === 1, '…for two answers');
}

console.log('a bus on the road the map draws');
{
  // the map draws a road 2 m north of the engine's way (east–west), then turning north; another road 9 m south
  const lines = new DrawnLines();
  lines.add('t', [
    { cls: 'secondary', tunnel: false, oneway: false, pts: [at(-50, 2), at(200, 2), at(200, 200)] },
    { cls: 'minor', tunnel: false, oneway: false, pts: [at(-50, -9), at(300, -9)] },
  ]);
  const raw = [at(0, 0), at(198, 0), at(198, 150)];
  const laid = layRoad(raw, lines);
  const offsets = laid.pts.slice(3, 30).map((p) => (p[1] - O[1]) * KY);
  check(offsets.every((o) => o > 1.1 && o < 1.3), `laid onto the drawn road, 0.8 m right of its middle (${Math.min(...offsets).toFixed(2)}–${Math.max(...offsets).toFixed(2)} m north)`);
  const cum = laid.cum[laid.cum.length - 1] * 1000;
  check(Math.abs(cum - 348) < 1, `measured along the engine's way (${cum.toFixed(1)} m)`);
  let step = 0;
  for (let k = 1; k < laid.pts.length; k++) {
    const d = m(laid.pts[k - 1], laid.pts[k]), along = (laid.cum[k] - laid.cum[k - 1]) * 1000;
    step = Math.max(step, Math.abs(d - along));
  }
  check(step < 2, `no step sideways anywhere along it (at most ${step.toFixed(2)} m more than it goes on)`);
  check(laid.complete === false, 'a way crossing tiles not yet in is laid again later');
  // no drawn road near: the engine's way as it is
  const far = layRoad([at(0, 500), at(100, 500)], lines);
  check(far.pts.length === 2 && far.pts[0] === raw[0] || m(far.pts[0], at(0, 500)) < 0.01, 'no drawn road near: its own way');
}

console.log("the base map's tiles");
{
  // a hand-made tile: one layer "transportation", one line of class "rail" from (100,100) to (200,4196) in 4096 units,
  // running past the tile's edge (as tiles do around their edge): cut at it
  const bytes: number[] = [];
  const varint = (v: number, out: number[]) => { while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); } out.push(v); };
  const field = (f: number, wire: number, out: number[]) => varint((f << 3) | wire, out);
  const lenField = (f: number, body: number[], out: number[]) => { field(f, 2, out); varint(body.length, out); out.push(...body); };
  const str = (s: string) => [...Buffer.from(s)];
  const zz = (n: number) => (n << 1) ^ (n >> 31);
  const geom: number[] = [];
  for (const v of [(1 << 3) | 1, zz(100), zz(100), (1 << 3) | 2, zz(100), zz(4096)]) varint(v, geom);
  const feat: number[] = [];
  const tags: number[] = []; varint(0, tags); varint(0, tags);
  lenField(2, tags, feat); field(3, 0, feat); varint(2, feat); lenField(4, geom, feat);
  const val: number[] = []; lenField(1, str('rail'), val);
  const layer: number[] = [];
  lenField(1, str('transportation'), layer); lenField(2, feat, layer); lenField(3, str('class'), layer); lenField(4, val, layer); field(5, 0, layer); varint(4096, layer);
  lenField(3, layer, bytes);
  const ls = tileLines(new Uint8Array(bytes), 14, 8530, 5766, 'transportation', new Set(['rail']));
  const whole = tileLines(new Uint8Array(bytes), 14, 8530, 5766, 'transportation', new Set(['rail']), false);
  check(ls.length === 1 && ls[0].cls === 'rail' && ls[0].pts.length === 2, 'a line of the class asked for is read');
  const len = (l: LngLat[]) => m(l[0], l[l.length - 1]);
  check(len(ls[0].pts) < len(whole[0].pts) - 30, `cut at the tile's edge (${len(ls[0].pts).toFixed(0)} of ${len(whole[0].pts).toFixed(0)} m)`);
  check(tileLines(new Uint8Array(bytes), 14, 8530, 5766, 'transportation', new Set(['primary'])).length === 0, 'other classes are left out');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
