// Tests for station-route.js (window.StationRoute). Run: node tools/test_station_route.mjs
// Plain assertions, no framework. Uses stations3d/_fixture.js, small made-up graphs built here, and
// stations3d/bern.js when it exists (then also prints sample routes and outliers for a human to judge).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;
const require = createRequire(import.meta.url);
const SR = require(path.join(ROOT, 'station-route.js'));
const loadModel = (file, key) => {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'stations3d', file), 'utf8'), { filename: file });
  return window.STATION3D[key];
};

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; failures.push(name); console.log(`  FAIL  ${name}\n        ${e.message.split('\n').join('\n        ')}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg || 'not equal'}\n        got:      ${sa}\n        expected: ${sb}`);
}
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg || 'not near'}: ${a} vs ${b} (±${tol})`);
const kinds = (r) => r.steps.map((s) => s.kind);
const dirs = (r) => r.steps.map((s) => s.dir);
const usesKind = (r, k) => r.steps.some((s) => s.kind === k);
const dump = (r) => (r ? r.steps.map((s) => `${s.kind}${s.dir ? ' ' + s.dir : ''}: ${s.text}`).join(' | ') : 'null');

// Route shape that every route must have, whatever the model
function checkShape(model, r, label = '') {
  assert(r && Array.isArray(r.points) && r.points.length >= 1, `${label} no points`);
  assert(Array.isArray(r.steps) && r.steps.length >= 1, `${label} no steps`);
  const last = r.steps[r.steps.length - 1];
  assert(last.kind === 'arrive' && last.from === r.points.length - 1 && last.to === last.from, `${label} last step is not arrive at the end`);
  assert(r.steps[0].from === 0, `${label} first step does not start at point 0`);
  for (let i = 1; i < r.steps.length; i++) assert(r.steps[i].from === r.steps[i - 1].to, `${label} steps ${i - 1}/${i} not consecutive`);
  for (const s of r.steps) {
    assert(typeof s.text === 'string' && s.text.length > 0 && s.text[0] === s.text[0].toUpperCase(), `${label} bad text "${s.text}"`);
    assert(s.level === r.points[s.from][2] && s.toLevel === r.points[s.to][2], `${label} step levels do not match points`);
    assert(['walk', 'stairs', 'escalator', 'ramp', 'elevator', 'arrive'].includes(s.kind), `${label} bad kind ${s.kind}`);
    if (s.kind !== 'arrive') assert(s.to > s.from, `${label} empty step`);
  }
  for (let i = 0; i + 1 < r.steps.length; i++) {
    const s = r.steps[i];
    const lc = Math.round(s.level) !== Math.round(s.toLevel);
    if (lc) assert(s.kind !== 'walk', `${label} a walk step changes level`);
  }
  const sumLen = r.steps.reduce((a, s) => a + s.len, 0), sumSec = r.steps.reduce((a, s) => a + s.seconds, 0);
  near(sumLen, r.length, r.steps.length, `${label} step lengths vs route length`);
  near(sumSec, r.seconds, r.steps.length, `${label} step seconds vs route seconds`);
  assert(r.dists.length === r.points.length && r.edges.length === r.points.length - 1, `${label} dists / edges length`);
  for (const n of r.nodes) assert(n >= 0 && n < model.graph.nodes.length, `${label} bad node ${n}`);
}

// Small graphs for single behaviours: nodes [[x, y, level]], links [a, b, kind, extra]
function mk(nodes, links, more = {}) {
  const edges = links.map(([a, b, kind, extra]) => Object.assign({
    a, b, kind: kind || 'walk',
    len: kind === 'elevator' ? 0 : Math.round(Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1]) * 100) / 100,
  }, extra || {}));
  return Object.assign({
    key: 'test', name: 'Test', origin: [7.44, 46.95], bbox: [-100, -100, 100, 100], uics: ['1'],
    levels: [{ id: -2, z: -9.6, name: 'Lower hall' }, { id: -1, z: -4.8, name: 'Underpass' }, { id: 0, z: 0, name: 'Platforms' }, { id: 1, z: 6, name: 'Overpass' }],
    areas: [], tracks: [], connectors: [], shell: [], stops: [], sectors: [], entrances: [], pois: [],
    graph: { nodes, edges },
  }, more);
}

// ======================================================================
console.log('\nFixture (stations3d/_fixture.js)');
const F = loadModel('_fixture.js', '_fixture');
const P1 = { stop: { uic: '0000001', ref: '1' } }, P3 = { stop: { uic: '0000001', ref: '3' } };
const ENT = { entrance: 'Station square' };

test('entrance → platform 1: down to the underpass, through it, up the stairs', () => {
  const r = SR.route(F, ENT, P1);
  checkShape(F, r);
  eq(kinds(r), ['stairs', 'walk', 'stairs', 'arrive']);
  eq(dirs(r), ['down', null, 'up', null]);
  eq(r.nodes, [0, 2, 3, 4, 5, 6, 10]);
  eq(r.steps[0].text, 'Take the stairs down to the underpass');
  eq(r.steps[1].text, 'Walk 40 m through the underpass');
  assert(/take the stairs up to platform 1$/i.test(r.steps[2].text), r.steps[2].text);
  eq(r.steps[3].text, 'Platform 1');
  assert(!r.relaxed, 'nothing relaxed');
});

test('platform 3 → platform 1 and back: same way, mirrored turns', () => {
  const a = SR.route(F, P3, P1), b = SR.route(F, P1, P3);
  checkShape(F, a); checkShape(F, b);
  eq(a.nodes, [7, 4, 5, 6, 10]);
  eq(b.nodes, [10, 6, 5, 4, 7]);
  eq(kinds(a), ['stairs', 'walk', 'stairs', 'arrive']);
  eq(a.steps[1].turn, 'right'); eq(b.steps[1].turn, 'left');
  eq(a.length, b.length);
});

test('ref matching is forgiving: "Gleis 1", "1A-C", "1 ", bus "Kante A" / "a"', () => {
  for (const ref of ['Gleis 1', '1A-C', '1 ', 1]) {
    const r = SR.route(F, ENT, { stop: { uic: '0000001', ref } });
    assert(r && r.nodes[r.nodes.length - 1] === 10, `ref ${ref}`);
  }
  for (const ref of ['Kante A', 'a', 'A']) {
    const r = SR.route(F, P3, { stop: { uic: '0000002', ref } });
    assert(r && r.nodes[r.nodes.length - 1] === 1, `ref ${ref}`);
    eq(r.steps[r.steps.length - 1].text, 'Bay A');
  }
  eq(SR.platformKey('7A-D'), '7'); eq(SR.platformKey('Kante H'), 'H'); eq(SR.platformKey('K1'), 'K1');
});

test('unknown endpoints → null; node / entrance endpoints work', () => {
  eq(SR.route(F, ENT, { stop: { uic: '0000001', ref: '99' } }), null);
  eq(SR.route(F, { entrance: 'Nowhere' }, P1), null);
  eq(SR.route(F, { node: 999 }, P1), null);
  const r = SR.route(F, { node: 0 }, { node: 1 });
  checkShape(F, r);
  eq(kinds(r), ['walk', 'arrive']);
  eq(r.steps[1].text, 'Bay A'); // node 1 is the bus stop
  const same = SR.route(F, { node: 5 }, { node: 5 });
  checkShape(F, same);
  eq(kinds(same), ['arrive']); eq(same.length, 0);
});

test('one-way escalator: taken up, never down (lift instead)', () => {
  const up = SR.route(F, { node: 14 }, { node: 18 });
  checkShape(F, up);
  eq(kinds(up), ['escalator', 'walk', 'arrive']);
  eq(up.steps[0].text, 'Take the escalator up to the overpass');
  const down = SR.route(F, { node: 18 }, { node: 14 });
  checkShape(F, down);
  assert(!usesKind(down, 'escalator'), dump(down));
  eq(down.nodes, [18, 17, 20, 19, 14]);
  eq(down.steps[1].text, 'Take the lift down to platform 1/2');
});

test('noEscalators: lift instead of the escalator, nothing relaxed', () => {
  const r = SR.route(F, { node: 14 }, { node: 18 }, { noEscalators: true });
  checkShape(F, r);
  assert(!usesKind(r, 'escalator') && usesKind(r, 'elevator'), dump(r));
  assert(!r.relaxed);
});

test('stepFree: platform 3 → 1 by lift and ramp, no stairs', () => {
  const r = SR.route(F, P3, P1, { stepFree: true });
  checkShape(F, r);
  eq(kinds(r), ['walk', 'elevator', 'walk', 'ramp', 'walk', 'arrive']);
  eq(r.steps[1].text, 'Take the lift down to the underpass');
  assert(/ramp up to platform 1$/.test(r.steps[3].text), r.steps[3].text);
  assert(!r.relaxed, 'step-free is possible here');
  assert(r.seconds > SR.route(F, P3, P1).seconds, 'the step-free way is slower');
});

test('wheelchair: also avoids steep ramps; when none is left, relaxed says so', () => {
  // The fixture ramp climbs 5 m over 30 m (17 %): the only step-free way to platform 1, so it is used and reported.
  const r = SR.route(F, P3, P1, { wheelchair: true });
  checkShape(F, r);
  assert(usesKind(r, 'ramp') && !usesKind(r, 'stairs'), dump(r));
  eq(r.relaxed, ['wheelchair']);
  assert(/wheelchair/.test(r.notice) && /steep/.test(r.notice), r.notice);
  assert(r.steps.find((s) => s.kind === 'ramp').warn === true, 'ramp step flagged');
});

test('relaxation: stepFree from the entrance needs one staircase, then the lift', () => {
  const r = SR.route(F, ENT, P3, { stepFree: true });
  checkShape(F, r);
  eq(r.relaxed, ['stepFree']);
  eq(r.steps.filter((s) => s.kind === 'stairs').length, 1);
  assert(usesKind(r, 'elevator'), 'uses the lift for the second level change: ' + dump(r));
  eq(r.notice, 'No step-free way here: this route has stairs.');
  const w = SR.route(F, ENT, P1, { wheelchair: true });
  eq(w.relaxed, ['wheelchair', 'stepFree']);
});

test('fewerStairs: lift when it is a small detour, stairs when nothing else, never relaxed', () => {
  const plain = SR.route(F, { node: 7 }, { node: 5 });
  assert(usesKind(plain, 'stairs') && !usesKind(plain, 'elevator'), dump(plain));
  const fewer = SR.route(F, { node: 7 }, { node: 5 }, { fewerStairs: true });
  assert(usesKind(fewer, 'elevator') && !usesKind(fewer, 'stairs'), dump(fewer));
  const only = SR.route(F, ENT, { node: 5 }, { fewerStairs: true });
  assert(usesKind(only, 'stairs') && !only.relaxed, dump(only));
  // stairs beside a lift that is 300 m away: the stairs win even with fewerStairs
  const M = mk([[0, 0, 0], [10, 0, -1], [300, 0, 0], [300, 0, -1], [310, 0, -1], [0, 0, -1]],
    [[0, 1, 'stairs'], [0, 2], [2, 3, 'elevator'], [3, 4], [4, 1]]);
  const far = SR.route(M, { node: 0 }, { node: 1 }, { fewerStairs: true });
  assert(usesKind(far, 'stairs'), dump(far));
  // ... and a lift 25 m away wins
  const M2 = mk([[0, 0, 0], [10, 0, -1], [25, 0, 0], [25, 0, -1]], [[0, 1, 'stairs'], [0, 2], [2, 3, 'elevator'], [3, 1]]);
  assert(usesKind(SR.route(M2, { node: 0 }, { node: 1 }, { fewerStairs: true }), 'elevator'));
  assert(usesKind(SR.route(M2, { node: 0 }, { node: 1 }), 'stairs'));
});

test('wheelchair: never wheelchair: false edges when there is another way; steep incline avoided', () => {
  const nodes = [[0, 0, 0], [20, 0, 0], [10, 8, 0], [10, -30, 0]];
  const M = mk(nodes, [[0, 1, 'walk', { wheelchair: false }], [0, 2], [2, 1], [0, 3], [3, 1]]);
  const plain = SR.route(M, { node: 0 }, { node: 1 });
  eq(plain.nodes, [0, 1]);
  const w = SR.route(M, { node: 0 }, { node: 1 }, { wheelchair: true });
  eq(w.nodes, [0, 2, 1]); assert(!w.relaxed);
  // the short detour is steep now (12 %): take the long flat one. (Models are cached: build a new one.)
  const M2 = mk(nodes, [[0, 1, 'walk', { wheelchair: false }], [0, 2, 'walk', { incline: 0.12 }], [2, 1], [0, 3], [3, 1]]);
  const w2 = SR.route(M2, { node: 0 }, { node: 1 }, { wheelchair: true });
  eq(w2.nodes, [0, 3, 1]); assert(!w2.relaxed);
  eq(SR.route(M2, { node: 0 }, { node: 1 }, { stepFree: true }).nodes, [0, 1], 'only wheelchair users avoid them');
});

test('disconnected → null; one-way only → null the wrong way', () => {
  const M = mk([[0, 0, 0], [10, 0, 0], [50, 0, 0], [60, 0, 0]], [[0, 1], [2, 3]]);
  eq(SR.route(M, { node: 0 }, { node: 3 }), null);
  const M2 = mk([[0, 0, 0], [10, 0, 1]], [[0, 1, 'escalator', { oneway: true }]]);
  assert(SR.route(M2, { node: 0 }, { node: 1 }));
  eq(SR.route(M2, { node: 1 }, { node: 0 }), null);
  eq(SR.route(M2, { node: 1 }, { node: 0 }, { stepFree: true }), null);
});

test('free positions snap onto an edge, on the right floor', () => {
  const a = SR.resolve(F, { xy: [0, 7], level: -1 })[0];
  assert(a.edge != null, 'on an edge, not a node');
  eq(a.point.map((v) => Math.round(v * 100) / 100), [0, 7, -1]);
  // Above the underpass, on level 0: not through the floor into the underpass, which is 0 m away in plan
  const b = SR.resolve(F, { xy: [0, -20], level: 0 })[0];
  eq(b.point[2], 0);
  // No level: level 0 / outdoor first
  const c = SR.resolve(F, { xy: [-2, -14] })[0];
  eq(c.point[2], 0);
  const d = SR.resolve(F, { xy: [-2, -14], level: -1 })[0];
  eq(d.point[2], -1);
  // Stays on its floor although another floor is nearer in plan (underpass 25 m away, platform edge 14 m) ...
  eq(SR.resolve(F, { xy: [25, 0], level: -1 })[0].point[2], -1);
  // ... but not when nothing on that floor is anywhere near (underpass 60 m away)
  assert(SR.resolve(F, { xy: [60, 0], level: -1 })[0].point[2] !== -1, 'falls back to another floor when this one is far');
  eq(SR.resolve(F, { xy: [44, 0], level: 1 })[0].point, [44, 0, 1]);
  // ll endpoints
  const ll = SR.toLngLat(F, [0, 7]);
  const g = SR.resolve(F, { ll, level: -1 })[0];
  near(g.point[1], 7, 0.01);
});

test('route between two free positions on one edge, and from a free position', () => {
  const r = SR.route(F, { xy: [0.5, -10], level: -1 }, { xy: [-0.5, 5], level: -1 });
  checkShape(F, r);
  eq(kinds(r), ['walk', 'arrive']); near(r.length, 15, 0.5);
  eq(r.nodes, [5]);
  const r2 = SR.route(F, { xy: [0, 7], level: -1 }, { xy: [0, -10], level: -1 });
  near(r2.length, 17, 0.5);
  const r3 = SR.route(F, { xy: [20, -13], level: 0 }, P1);
  checkShape(F, r3);
  eq(r3.points[0], [20, -14, 0]);
  eq(r3.steps[r3.steps.length - 1].text, 'Platform 1');
});

test('tiny fragments merge: landing between flights, short walk to the stairs', () => {
  const M = mk([[0, 0, 0], [6, 0, -0.5], [6, 3, -0.5], [0, 3, -1], [-40, 3, -1], [-2, 0, 0], [-40, 0, 0]],
    [[6, 5], [5, 0], [0, 1, 'stairs'], [1, 2, 'walk'], [2, 3, 'stairs'], [3, 4]]);
  const r = SR.route(M, { node: 6 }, { node: 4 });
  checkShape(M, r);
  eq(kinds(r), ['walk', 'stairs', 'walk', 'arrive'], dump(r));
  eq(r.steps[1].text, 'Take the stairs down to the underpass');
  // starting 2 m before the stairs: no "walk 2 m" step
  const r2 = SR.route(M, { node: 5 }, { node: 4 });
  eq(kinds(r2), ['stairs', 'walk', 'arrive']);
});

test('turn hints from the geometry; long walks split at a clear bend', () => {
  const M = mk([[0, 0, 0], [40, 0, 0], [40, 40, 0], [15, 60, 0]], [[0, 1], [1, 2], [2, 3]]);
  const r = SR.route(M, { node: 0 }, { node: 3 });
  checkShape(M, r);
  eq(kinds(r), ['walk', 'walk', 'walk', 'arrive']);
  eq(r.steps.map((s) => s.turn || null), [null, 'left', 'bear-left', null]);
  eq(r.steps[0].text, 'Walk 40 m'); eq(r.steps[1].text, 'Turn left and walk 40 m');
  const back = SR.route(M, { node: 3 }, { node: 0 });
  eq(back.steps.map((s) => s.turn || null), [null, 'bear-right', 'right', null]);
  // gentle curve: one step
  const C = mk([[0, 0, 0], [20, 2, 0], [40, 6, 0], [60, 12, 0]], [[0, 1], [1, 2], [2, 3]]);
  eq(kinds(SR.route(C, { node: 0 }, { node: 3 })), ['walk', 'arrive']);
});

test('no zig-zag: a grid gives the path with the fewest turns', () => {
  const nodes = [], links = [], id = (i, j) => i * 5 + j;
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) nodes.push([i * 10, j * 10, 0]);
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) { if (i < 4) links.push([id(i, j), id(i + 1, j)]); if (j < 4) links.push([id(i, j), id(i, j + 1)]); }
  const r = SR.route(mk(nodes, links), { node: id(0, 0) }, { node: id(4, 4) });
  let turns = 0;
  for (let k = 2; k < r.points.length; k++) {
    const a = r.points[k - 2], b = r.points[k - 1], c = r.points[k];
    if (Math.sign(b[0] - a[0]) !== Math.sign(c[0] - b[0]) || Math.sign(b[1] - a[1]) !== Math.sign(c[1] - b[1])) turns++;
  }
  eq(turns, 1, 'turns');
  near(r.length, 80, 0.01);
});

test('no pointless level change: stay on the level for a few metres more', () => {
  // flat way 104 m, or 100 m through an underpass (down and up again)
  const M = mk([[0, 0, 0], [100, 0, 0], [0, 26, 0], [100, 26, 0], [5, 0, -1], [95, 0, -1]],
    [[0, 2], [2, 3], [3, 1], [0, 4, 'stairs', { len: 5 }], [4, 5], [5, 1, 'stairs', { len: 5 }]]);
  M.graph.edges[0].len = 2; M.graph.edges[2].len = 2; M.graph.edges[1].len = 100; // 104 m
  const r = SR.route(M, { node: 0 }, { node: 1 });
  assert(!usesKind(r, 'stairs'), dump(r));
});

test('lift: one wait per ride, also over several floors', () => {
  const M = mk([[0, 0, -2], [0, 0, -1], [0, 0, 0], [10, 0, 0], [-10, 0, -2]],
    [[0, 1, 'elevator'], [1, 2, 'elevator'], [2, 3], [4, 0]]);
  const r = SR.route(M, { node: 4 }, { node: 3 });
  checkShape(M, r);
  eq(kinds(r), ['walk', 'elevator', 'walk', 'arrive']);
  eq(r.steps[1].text, 'Take the lift up to the platforms');
  const T = SR.TIME, lift = r.steps[1].seconds;
  near(lift, T.liftWait + 2 * T.liftPerEdge + 9.6 / T.liftSpeed, 1, 'lift seconds');
});

test('time model: walking speed, stairs slower up than down', () => {
  const M = mk([[0, 0, 0], [100, 0, 0]], [[0, 1]]);
  near(SR.route(M, { node: 0 }, { node: 1 }).seconds, 100 / (4.7 / 3.6), 1);
  near(SR.route(M, { node: 0 }, { node: 1 }, { walkKmh: 3 }).seconds, 120, 1);
  const S = mk([[0, 0, 0], [8, 0, -1]], [[0, 1, 'stairs']]);
  const down = SR.route(S, { node: 0 }, { node: 1 }).seconds, up = SR.route(S, { node: 1 }, { node: 0 }).seconds;
  assert(up > down && up >= 12 && up <= 20 && down >= 8 && down <= 15, `up ${up} down ${down}`);
});

test('coordinates and heights', () => {
  const ll = SR.toLngLat(F, [123.4, -56.7]);
  const xy = SR.toLocal(F, ll);
  near(xy[0], 123.4, 1e-6); near(xy[1], -56.7, 1e-6);
  eq(SR.toLocal(F, F.origin), [0, 0]);
  near(SR.toLngLat(F, [0, 110.54])[1], F.origin[1] + 0.001, 1e-9);
  eq(SR.z(F, 0), 0); eq(SR.z(F, -1), -5); eq(SR.z(F, -0.5), -2.5); eq(SR.z(F, 1), 6); eq(SR.z(F, 0.5), 3);
  eq(SR.levelName(F, -1), 'the underpass');
});

test('pointAt and snap agree; snap gives index, t, step, remaining', () => {
  const r = SR.route(F, ENT, P1);
  eq(SR.pointAt(r, 0), r.points[0]);
  eq(SR.pointAt(r, 1e9), r.points[r.points.length - 1]);
  const total = r.dists[r.dists.length - 1];
  for (let m = 0; m <= total; m += total / 37) {
    const p = SR.pointAt(r, m), s = SR.snap(F, r, p, p[2]);
    near(s.along, m, 0.05, `along at ${m}`);
    near(s.along + s.remaining, total, 0.01);
    assert(s.step >= 0 && s.step < r.steps.length - 1, 'step index');
    assert(s.index >= r.steps[s.step].from && s.index < r.steps[s.step].to, 'step contains the piece');
  }
  const s = SR.snap(F, r, { ll: SR.toLngLat(F, [3, 0]) }, -1);
  near(s.dist, 3, 0.01); eq(s.point[2], -1);
});

test('snap is monotonic along a route, also where floors overlap in plan', () => {
  // corridor east on level 0, stairs down, back west right under it on level -1
  const M = mk([[0, 0, 0], [60, 0, 0], [70, 0, -1], [70, -1, -1], [0, -1, -1]],
    [[0, 1], [1, 2, 'stairs'], [2, 3], [3, 4]]);
  const r = SR.route(M, { node: 0 }, { node: 4 });
  checkShape(M, r);
  let rng = 7;
  const rand = () => ((rng = (rng * 16807) % 2147483647) / 2147483647 - 0.5);
  const total = r.dists[r.dists.length - 1];
  let prev = null, worst = 0, wrongFloor = 0;
  for (let m = 0; m <= total; m += 1.5) {
    const p = SR.pointAt(r, m);
    const fix = [p[0] + 3 * rand(), p[1] + 3 * rand()]; // GPS noise (±1.5 m), no level
    const s = SR.snap(M, r, fix, prev);
    if (prev) worst = Math.min(worst, s.along - prev.along);
    if (Math.abs(s.point[2] - p[2]) > 0.5) wrongFloor++;
    prev = s;
  }
  assert(worst > -4, `went back ${-worst} m`); // a few metres back is the GPS noise itself; a jump to the other floor would be ~70 m
  eq(wrongFloor, 0, 'fixes snapped to the other floor');
  near(prev.along, total, 4, 'reaches the end');
  // without any hint the overlap is ambiguous; a level hint decides
  near(SR.snap(M, r, [30, -0.5], -1).along, r.dists[2] + 1 + 40, 1);
  near(SR.snap(M, r, [30, -0.5], 0).along, 30, 1);
  // fixture route too, with noise and the previous result
  const fr = SR.route(F, P3, P1, { stepFree: true });
  prev = null; worst = 0;
  const ft = fr.dists[fr.dists.length - 1];
  for (let m = 0; m <= ft; m += 1) {
    const p = SR.pointAt(fr, m), s = SR.snap(F, fr, [p[0] + 2 * rand(), p[1] + 2 * rand()], prev);
    if (prev) worst = Math.min(worst, s.along - prev.along);
    prev = s;
  }
  assert(worst > -4, `fixture: went back ${-worst} m`);
});

// ======================================================================
const bernFile = path.join(ROOT, 'stations3d', 'bern.js');
if (fs.existsSync(bernFile)) {
  console.log('\nBern (stations3d/bern.js)');
  let B;
  test('loads', () => {
    B = loadModel('bern.js', 'bern');
    assert(B && B.graph && B.graph.nodes.length > 0, 'no graph');
  });
  if (B) bernTests(B);
} else {
  console.log('\nstations3d/bern.js not there yet: Bern tests skipped');
}

function bernTests(B) {
  const g = B.graph;
  const kindCount = {};
  for (const e of g.edges) kindCount[e.kind] = (kindCount[e.kind] || 0) + 1;
  console.log(`  ${g.nodes.length} nodes, ${g.edges.length} edges ${JSON.stringify(kindCount)}, ${B.stops.length} stops, ${(B.entrances || []).length} entrances, levels ${B.levels.map((l) => `${l.id} ${l.name}`).join(' / ')}`);

  test('data: edges are valid (from the routing side)', () => {
    const bad = [];
    g.edges.forEach((e, i) => {
      const a = g.nodes[e.a], b = g.nodes[e.b];
      if (!a || !b) return bad.push(`edge ${i}: missing node`);
      if (e.kind === 'walk' && a[2] !== b[2]) bad.push(`edge ${i}: walk between levels ${a[2]} and ${b[2]}`);
      const geo = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (e.kind !== 'elevator' && Math.abs((e.len || 0) - geo) > Math.max(1, geo * 0.05)) bad.push(`edge ${i}: len ${e.len} but ${geo.toFixed(1)} m between nodes`);
      if (e.kind === 'elevator' && geo > 2) bad.push(`edge ${i}: lift nodes ${geo.toFixed(1)} m apart`);
      if (['stairs', 'escalator'].includes(e.kind) && a[2] === b[2] && e.len > 15) bad.push(`edge ${i}: ${e.kind} ${e.len} m long on one level ${a[2]}`);
    });
    if (bad.length) console.log(`        ${bad.length} odd edges, e.g.\n        ` + bad.slice(0, 12).join('\n        '));
    assert(!bad.some((s) => /missing|walk between/.test(s)), 'broken edges (see above)');
  });

  // a sample of stops: every train platform, plus a spread of the others, one per node
  const seen = new Set();
  const stops = B.stops.filter((s) => { const k = s.node; if (seen.has(k)) return false; seen.add(k); return true; });
  const trains = stops.filter((s) => s.mode === 'train'), others = stops.filter((s) => s.mode !== 'train');
  const sample = trains.concat(others.filter((s, i) => i % Math.max(1, Math.ceil(others.length / 25)) === 0)).slice(0, 50);
  const label = (s) => `${s.mode} ${s.ref || '?'} (${s.uic}${s.name ? ' ' + s.name : ''})`;

  test(`every pair of ${sample.length} stops is routable, with and without step-free, nothing absurd`, () => {
    const out = [], fails = [];
    let n = 0, relaxed = 0, ms = 0, maxMs = 0;
    for (const prefs of [{}, { stepFree: true }]) {
      for (const a of sample) for (const b of sample) {
        if (a === b) continue;
        const t0 = performance.now();
        const r = SR.route(B, { stop: { uic: a.uic, ref: a.ref } }, { stop: { uic: b.uic, ref: b.ref } }, prefs);
        const dt = performance.now() - t0;
        ms += dt; maxMs = Math.max(maxMs, dt); n++;
        if (!r) { fails.push(`${label(a)} → ${label(b)} ${JSON.stringify(prefs)}`); continue; }
        try { checkShape(B, r, `${label(a)} → ${label(b)}`); } catch (e) { fails.push(e.message); continue; }
        if (r.relaxed) relaxed++;
        const p = r.points[0], q = r.points[r.points.length - 1];
        const straight = Math.hypot(p[0] - q[0], p[1] - q[1]);
        const ratio = r.length / Math.max(straight, 30);
        const changes = r.steps.filter((s) => ['stairs', 'escalator', 'elevator', 'ramp'].includes(s.kind) && Math.round(s.level) !== Math.round(s.toLevel)).length;
        const minChanges = Math.abs(Math.round(p[2]) - Math.round(q[2]));
        if (ratio > 2.5 || changes > minChanges + 2) out.push({ a, b, prefs, ratio, changes, minChanges, r, straight });
      }
    }
    console.log(`        ${n} routes, ${(ms / n).toFixed(1)} ms each on average, slowest ${maxMs.toFixed(0)} ms; step-free relaxed in ${relaxed}`);
    // Outliers, grouped by the stop pair (both directions, one line each) so a human can judge them
    const show = (list, title, max) => {
      if (!list.length) return;
      list.sort((x, y) => y.ratio - x.ratio);
      const shown = new Set(), lines = [];
      for (const o of list) {
        const k = [o.a.node, o.b.node].sort().join('-') + JSON.stringify(o.prefs);
        if (shown.has(k)) continue;
        shown.add(k);
        lines.push(o);
      }
      console.log(`        ${list.length} ${title} (length > 2.5 × straight line, or 2+ extra level changes); worst ${Math.min(max, lines.length)} of ${lines.length} pairs:`);
      for (const o of lines.slice(0, max)) {
        console.log(`        ${label(o.a)} → ${label(o.b)}${o.prefs.stepFree ? ' step-free' : ''}: ${o.r.length} m vs ${o.straight.toFixed(0)} m straight, ${o.changes} level changes (min ${o.minChanges})${o.r.relaxed ? ', relaxed ' + o.r.relaxed : ''}`);
        console.log(`          ${dump(o.r)}`);
      }
    };
    show(out.filter((o) => !o.r.relaxed), 'outliers with all preferences met', 12);
    show(out.filter((o) => o.r.relaxed), 'outliers where step-free had to be relaxed', 4);
    const unreach = new Map();
    for (const o of out) if (o.r.relaxed) unreach.set(label(o.a), (unreach.get(label(o.a)) || 0) + 1);
    if (fails.length) throw new Error(`${fails.length} failed:\n` + fails.slice(0, 15).join('\n'));
  });

  test('free positions snap and route (each entrance; random points on each level)', () => {
    let rng = 11;
    const rand = () => ((rng = (rng * 16807) % 2147483647) / 2147483647);
    const target = trains[0];
    for (const en of B.entrances || []) assert(SR.route(B, { entrance: en.name }, { stop: { uic: target.uic, ref: target.ref } }), `entrance ${en.name}`);
    const [x0, y0, x1, y1] = B.bbox;
    for (const l of B.levels) for (let k = 0; k < 5; k++) {
      const xy = [x0 + rand() * (x1 - x0), y0 + rand() * (y1 - y0)];
      const c = SR.resolve(B, { xy, level: l.id })[0];
      assert(c, 'snapped');
      const r = SR.route(B, { xy, level: l.id }, { stop: { uic: target.uic, ref: target.ref } });
      assert(r, `route from ${xy.map((v) => v.toFixed(0))} on ${l.id}`);
    }
  });

  test('snap is monotonic along real routes', () => {
    let rng = 5;
    const rand = () => ((rng = (rng * 16807) % 2147483647) / 2147483647 - 0.5);
    let worstAll = 0, fixes = 0, wrongFloor = 0, routes = 0;
    for (let k = 0; k < sample.length; k++) {
      const a = sample[k], b = sample[(k * 7 + 3) % sample.length];
      if (a === b) continue;
      const r = SR.route(B, { stop: { uic: a.uic, ref: a.ref } }, { stop: { uic: b.uic, ref: b.ref } });
      routes++;
      const total = r.dists[r.dists.length - 1];
      let prev = null, worst = 0;
      for (let m = 0; m <= total; m += 2) {
        const p = SR.pointAt(r, m);
        // ±1.5 m GPS noise, no level; the first fix knows its level, later ones carry the previous result
        const s = SR.snap(B, r, [p[0] + 3 * rand(), p[1] + 3 * rand()], prev || p[2]);
        if (prev) worst = Math.min(worst, s.along - prev.along);
        if (Math.abs(s.point[2] - p[2]) > 0.5) wrongFloor++;
        fixes++;
        prev = s;
      }
      worstAll = Math.min(worstAll, worst);
    }
    console.log(`        ${routes} routes, ${fixes} fixes: worst step back ${(-worstAll).toFixed(1)} m, ${wrongFloor} on another floor than the truth (at lifts, where both floors are in the same spot)`);
    assert(worstAll > -5, `went back ${-worstAll} m`);
    assert(wrongFloor < fixes * 0.01, 'too many fixes on the wrong floor');
  });

  // ---- Sample routes, printed in full ----
  const find = (mode, ref, nameRe) => {
    const key = SR.platformKey(ref);
    const c = B.stops.filter((s) => (!mode || s.mode === mode) && SR.platformKey(s.ref) === key && (!nameRe || nameRe.test(s.name || '')));
    return c[0] || null;
  };
  const mainEntrance = (B.entrances || []).find((e) => /haupt|main|bahnhofplatz/i.test(e.name || '')) || (B.entrances || [])[0];
  const ep = (s) => (s ? { stop: { uic: s.uic, ref: s.ref } } : null);
  const samples = [
    ['Platform 7 → tram edge B', ep(find('train', '7')), ep(find('tram', 'B'))],
    ['Platform 3 → RBS platform 22', ep(find('train', '3', /^(?!.*RBS)/)), ep(find(null, '22'))],
    ['PostAuto bay T → platform 12', ep(find('bus', 'T')), ep(find('train', '12'))],
    [`Entrance ${mainEntrance ? mainEntrance.name : '?'} → platform 13`, mainEntrance ? { entrance: mainEntrance.name } : null, ep(find('train', '13'))],
    ['Platform 1 → platform 9', ep(find('train', '1')), ep(find('train', '9'))],
  ];
  console.log('\n  Sample routes (for review):');
  for (const [title, a, b] of samples) {
    if (!a || !b) { console.log(`\n  ${title}: endpoint not in the model (${JSON.stringify(a)} → ${JSON.stringify(b)})`); continue; }
    for (const prefs of [{}, { stepFree: true }]) {
      const r = SR.route(B, a, b, prefs);
      console.log(`\n  ${title}${prefs.stepFree ? ' (step-free)' : ''}: ${r ? `${r.length} m, ${Math.round(r.seconds / 6) / 10} min${r.relaxed ? ', relaxed ' + r.relaxed.join(', ') + ' — ' + r.notice : ''}` : 'NO ROUTE'}`);
      if (r) for (const s of r.steps) console.log(`    ${String(s.kind).padEnd(9)} ${String(s.len).padStart(4)} m ${String(s.seconds).padStart(4)} s  L${s.level}→${s.toLevel}  ${s.text}`);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed${failed ? ': ' + failures.join('; ') : ''}`);
process.exitCode = failed ? 1 : 0;
