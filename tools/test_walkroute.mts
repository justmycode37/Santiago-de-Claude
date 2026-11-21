// Tests for walkroute.js on the built walkgraph/ tiles (Bern). Offline; exit code 1 on any failure.
//
//   node tools/test_walkroute.mts           # all
//   node tools/test_walkroute.mts --quick   # without the 992 platform pairs
//
// 1. Places around Bern station (tools/test_walkroute_cases.json): every one is routed; where its building has a
//    mapped door, the walk ends at one; no straight connector of a walk cuts through another building.
// 2. Every pair of platforms at Bern station (normal and step-free): routed, and never across railway tracks on the
//    ground (the tracks are in the tiles).
// 3. Cases that once went wrong: Gleis 2 → 4 across the tracks, the RBS platforms two floors down, step-free,
//    a door 50 m from any path, approximate stretches.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { transformSync } from 'amaro'; // npm install
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const quick = process.argv.includes('--quick');
let passed = 0, failed = 0;
const check = (ok: unknown, what: string) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };

// the page the router's script runs in: the globals handed to it, and the WALKROUTE it leaves there
interface RouterPage { [name: string]: unknown; globalThis?: RouterPage; WALKROUTE?: WalkRouteApi }
function router() {
  const ctx: RouterPage = { console, setTimeout, Promise, Math, JSON, Map, Set, Array, Object, Number, String, Infinity, isFinite };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(transformSync(fs.readFileSync(path.join(ROOT, 'src', 'walkroute.ts'), 'utf8'), { mode: 'strip-only' }).code, ctx); // the script as the browser gets it: types taken out
  ctx.WALKROUTE!.configure({ loader: async (k: string) => {
    const s = fs.readFileSync(path.join(ROOT, 'walkgraph', k === 'index' ? 'index.js' : `t/${k}.js`), 'utf8');
    return k === 'index' ? JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)) : JSON.parse(s.slice(s.indexOf(',') + 1, s.lastIndexOf(')')));
  } });
  return ctx.WALKROUTE!;
}
const W = router();
const { buildings, distM } = W._debug;
const inside = (p: LngLat, ring: LngLat[]) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [x1, y1] = ring[i], [x2, y2] = ring[j];
  if ((y1 > p[1]) !== (y2 > p[1]) && p[0] < (x2 - x1) * (p[1] - y1) / (y2 - y1) + x1) c = !c; } return c; };
const bldAt = (p: LngLat) => [...buildings.values()].filter((b) => p[0] >= b.bb[0] && p[0] <= b.bb[2] && p[1] >= b.bb[1] && p[1] <= b.bb[3] && inside(p, b.ring));
const crosses = (p1: LngLat, p2: LngLat, q1: LngLat, q2: LngLat) => { const c = (o: LngLat, a: LngLat, b: LngLat) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const d1 = c(q1, q2, p1), d2 = c(q1, q2, p2), d3 = c(p1, p2, q1), d4 = c(p1, p2, q2); return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)); };
// the straight connectors of a walk: from where it starts to the first stretch of path, and from the last one to its end
function connectors(r: WalkRouteResult) {
  return [r.coords.slice(0, Math.max(2, r.approxTo != null ? r.approxTo + 2 : 2)), r.coords.slice(r.approxFrom != null ? r.approxFrom : r.coords.length - 2)];
}

// ---------------------------------------------------------------- 1. places around Bern station
console.log('1. places around Bern station');
interface WalkCases { start: LngLat; places: { name: string; ll: LngLat }[] }
const cases: WalkCases = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'test_walkroute_cases.json'), 'utf8'));
let routed = 0, withDoors = 0, atDoor = 0, cut: string[] = [];
for (const p of cases.places) {
  const r = await W.route(cases.start, p.ll, { from: { accuracy: 10 }, to: {} });
  if (!r) continue;
  routed++;
  const own = new Set(bldAt(p.ll).concat(bldAt(cases.start)));
  const doors = bldAt(p.ll).flatMap((b) => b.entrances);
  if (doors.length) { withDoors++; if (r.door && doors.some((d) => d.node.ll === r.door!.ll)) atDoor++; else if (!r.door && r.coords.length > 2) atDoor++; } // indoors (a shop in the station): reached by its corridors
  for (const seg of connectors(r)) for (let i = 1; i < seg.length; i++) {
    const L = distM(seg[i - 1], seg[i]);
    for (let j = 1; j < L; j += 1) {
      const t = j / L, q: LngLat = [seg[i - 1][0] + (seg[i][0] - seg[i - 1][0]) * t, seg[i - 1][1] + (seg[i][1] - seg[i - 1][1]) * t];
      if (bldAt(q).some((b) => !own.has(b))) { cut.push(p.name); break; }
    }
  }
}
check(routed === cases.places.length, `${routed} of ${cases.places.length} places routed`);
check(atDoor === withDoors, `${atDoor} of ${withDoors} places with a mapped door: the walk ends at one (or reaches the shop indoors)`);
check(cut.length === 0, `no straight connector cuts through another building${cut.length ? ': ' + [...new Set(cut)].join(', ') : ''}`);

// ---------------------------------------------------------------- 2. platform pairs at Bern station
const pd = fs.readFileSync(path.join(ROOT, 'platforms.js'), 'utf8');
const PD: PlatformData = JSON.parse(pd.slice(pd.indexOf('{'), pd.lastIndexOf('}') + 1));
const P = (x: number, y: number): LngLat => [x / 1e5, y / 1e5];
const edges = PD.stops['8507000'][2].map((e) => ({ ll: P(e[0], e[1]), ref: e[2], level: e[4] || 0 }));
const rails: [LngLat, LngLat][] = [];
for (const f of fs.readdirSync(path.join(ROOT, 'walkgraph', 't'))) {
  const [ty, tx] = f.slice(0, -3).split('_').map(Number);
  if (ty < 4693 || ty > 4696 || tx < 742 || tx > 745) continue;
  const s = fs.readFileSync(path.join(ROOT, 'walkgraph', 't', f), 'utf8');
  const d: WalkGraphTile = JSON.parse(s.slice(s.indexOf(',') + 1, s.lastIndexOf(')')));
  (d.z || []).forEach((fl) => { for (let i = 2; i < fl.length; i += 2) rails.push([[(d.o[0] + fl[i - 2]) / 1e6, (d.o[1] + fl[i - 1]) / 1e6], [(d.o[0] + fl[i]) / 1e6, (d.o[1] + fl[i + 1]) / 1e6]]); });
}
const acrossTracks = (r: WalkRouteResult) => { for (let i = 1; i < r.coords.length; i++) { const l = r.levels[i]; if (l != null && l !== '0') continue;
  for (const [a, b] of rails) if (crosses(r.coords[i - 1], r.coords[i], a, b)) return true; } return false; };
if (!quick) {
  console.log('2. every pair of platforms at Bern station');
  let pairs = 0, none = 0, across: string[] = [];
  for (const stepFree of [false, true]) for (const a of edges) for (const b of edges) {
    if (a === b || a.ref === b.ref) continue;
    pairs++;
    const r = await W.route(a.ll, b.ll, { stepFree, from: { platform: true, level: a.level, ref: a.ref }, to: { platform: true, level: b.level, ref: b.ref } });
    if (!r) none++;
    else if (acrossTracks(r)) across.push(`${stepFree ? 'step-free ' : ''}${a.ref} → ${b.ref}`);
  }
  check(none === 0, `${pairs - none} of ${pairs} platform changes routed`);
  check(across.length === 0, `no platform change crosses railway tracks on the ground${across.length ? ': ' + across.slice(0, 5).join(', ') : ''}`);
}

// ---------------------------------------------------------------- 3. cases that once went wrong
console.log('3. cases that once went wrong');
const plat = (ref: string, level: number) => ({ platform: true, level, ref });
let r = await W.route(P(743754, 4694836), P(743725, 4694845), { from: plat('2', 0), to: plat('4', 0) });
check(r && !acrossTracks(r) && r.dist > 60, `Gleis 2 → Gleis 4 does not cross the tracks (${r && r.dist} m)`);
r = await W.route(P(743683, 4694857), P(743985, 4694956), { from: plat('7', 0), to: plat('22', -2) });
check(r && r.cues.some((c) => /level −2/.test(c.text)), `Gleis 7 → RBS Gleis 22: down to level −2 (${r && r.cues.map((c) => c.text).join(', ')})`);
r = await W.route(P(743683, 4694857), P(743985, 4694956), { stepFree: true, from: plat('7', 0), to: plat('22', -2) });
check(r && !r.cues.some((c) => /^Stairs|Escalator/.test(c.text)), `the same step-free: no stairs or escalators (${r && r.dist} m)`);
await W.route([7.4095, 46.9215], [7.41238, 46.92051], {}); // loads that corner
const farDoor = [...W._debug.entrances.values()].find((e) => /Schwarzenburgstrasse 326/.test(e.addr));
if (farDoor) {
  const b = W._debug.buildings.get(farDoor.bld)!;
  const c: LngLat = [b.ring.reduce((s, p) => s + p[0], 0) / b.ring.length, b.ring.reduce((s, p) => s + p[1], 0) / b.ring.length];
  r = await W.route([c[0] - 0.003, c[1] + 0.001], c, { to: {} });
  check(r && r.door && r.door.ll === farDoor.node.ll, 'a main door 50 m from any path is still where the walk ends');
  check(r && r.approxFrom != null, 'the stretch across open ground to that door is marked approximate');
} else check(false, 'Schwarzenburgstrasse 326 in the tiles');
// step-free to a building whose only door is mapped wheelchair=no: no door, the end marked approximate, and said
await W.route([7.4358, 46.948], [7.4359, 46.9481], {}); // loads that corner
const noWc = [...W._debug.entrances.values()].find((e) => /Mühlemattstrasse 70/.test(e.addr));
if (noWc) {
  const b = W._debug.buildings.get(noWc.bld)!;
  const c: LngLat = [b.ring.reduce((s, p) => s + p[0], 0) / b.ring.length, b.ring.reduce((s, p) => s + p[1], 0) / b.ring.length];
  r = await W.route([7.4358, 46.948], c, { stepFree: true, to: {} });
  check(r && !r.door && r.approxFrom != null && r.noStepFreeDoor, `step-free to Mühlemattstrasse 70 (door wheelchair=${noWc.wc}): no door, approximate end, "no step-free entrance"`);
  r = await W.route([7.4358, 46.948], c, { to: {} });
  check(r && r.door && !r.noStepFreeDoor, 'the same without step-free ends at its door');
} else check(false, 'Mühlemattstrasse 70 in the tiles');
// a straight connector that has to cross a building is marked approximate, however short
r = await W.route([7.442453, 46.950341], [7.44293, 46.95039], {});
check(r && (r.approx || r.approxTo != null || r.approxFrom != null), `a connector through a building is marked approximate (${r && r.dist} m)`);
r = await W.route([7.43935, 46.94884], [7.4475, 46.948], { from: { accuracy: 10 }, to: {} });
check(r && r.coords.length > 5 && r.dist < 1200, `Bahnhofplatz → Zytglogge area routed (${r && r.dist} m, ${r && r.via})`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
