// Round-2 tests for station-route.js: closures by date, closed endpoints, naming by where you arrive, sloping streets,
// sectors and sectorTimes, why(), free-position snapping limits, platform keys, same-platform routes.
// Run: node tools/test_station_route2.mts  (plain assertions; uses the fixture, a synthetic two-level station built
// here, and stations3d/bern.js when it exists, for printed sample routes).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

declare global {
  // The router is a browser script: it puts its API on `window`, which here is the global object itself.
  var window: typeof globalThis;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.window = globalThis;
const require = createRequire(import.meta.url);
const SR = require(path.join(ROOT, 'src', 'station-route.ts')) as StationRouteApi;
const loadModel = (file: string, key: string) => {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'stations3d', file), 'utf8'), { filename: file });
  return window.STATION3D![key];
};

let passed = 0, failed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok    ${name}`); }
  catch (e) { failed++; failures.push(name); console.log(`  FAIL  ${name}\n        ${String((e as Error).stack || (e as Error).message).split('\n').slice(0, 3).join('\n        ')}`); }
}
function assert(cond: unknown, msg?: string): asserts cond { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a: unknown, b: unknown, msg?: string) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg || 'not equal'}\n        got:      ${sa}\n        expected: ${sb}`);
}
const near = (a: number, b: number, tol: number, msg?: string) => assert(Math.abs(a - b) <= tol, `${msg || 'not near'}: ${a} vs ${b} (±${tol})`);
const kinds = (r: StationRouteResult) => r.steps.map((s) => s.kind);
const texts = (r: StationRouteResult) => r.steps.map((s) => s.text);
const usesKind = (r: StationRouteResult, k: StationRouteStepKind) => r.steps.some((s) => s.kind === k);
const dump = (r: StationRouteResult | null) => (r ? r.steps.map((s) => `${s.kind}${s.dir ? ' ' + s.dir : ''}: ${s.text}`).join(' | ') : 'null');
const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));

// Route shape (as SCHEMA.md, plus the round-2 rules: fractional levels allowed on walks)
function checkShape(r: StationRouteResult | null, label = ''): asserts r is StationRouteResult {
  assert(r && Array.isArray(r.points) && r.points.length >= 2, `${label} fewer than two points`);
  assert(r.steps.length >= 1 && r.steps[0].from === 0, `${label} first step`);
  for (let i = 1; i < r.steps.length; i++) assert(r.steps[i].from === r.steps[i - 1].to, `${label} steps ${i - 1}/${i} not consecutive`);
  const last = r.steps[r.steps.length - 1];
  assert(last.kind === 'arrive' && last.to === r.points.length - 1, `${label} last step is not arrive at the end`);
  for (const s of r.steps) {
    assert(s.text && s.text[0] === s.text[0].toUpperCase(), `${label} bad text "${s.text}"`);
    assert(s.level === r.points[s.from][2] && s.toLevel === r.points[s.to][2], `${label} step levels`);
    if (s.kind === 'walk') assert(!/take the (ramp|stairs|lift|escalator)/i.test(s.text), `${label} walk text "${s.text}"`);
  }
  near(r.steps.reduce((a, s) => a + s.len, 0), r.length, r.steps.length, `${label} lengths`);
  near(r.steps.reduce((a, s) => a + s.seconds, 0), r.seconds, r.steps.length, `${label} seconds`);
  assert(r.dists.length === r.points.length && r.edges.length === r.points.length - 1, `${label} dists / edges`);
}

// ---------- A small two-level station ----------
// Level 0: Bahnhofstrasse (outdoor street, west–east at y = −40), Bahnhofplatz (plaza, outdoor), island platform 7/8
// (y = 20, x −60 … 70) with sectors A–D. Level −1: the main underpass (x = 0, y −10 … 10, then west to the lift at
// x = −20). Stairs plaza ↔ underpass, stairs underpass ↔ platform, lift underpass ↔ platform. Level 1: an upper
// terrace reached by a sloping street (walk edges between fractional levels) or a lift.
// Models as these tests build them: without what the router does not read, and with the old forms it still accepts.
type TestEdge = Omit<StationEdge, 'closed'> & { closed?: StationRouteClosedValue };
type TestLevel = Omit<StationLevel, 'name'> & { name?: string };
interface BareModel {
  origin: LngLat;
  levels: TestLevel[];
  stops: Omit<StationStop, 'nodes'>[];
  areas: StationArea[];
  graph: { nodes: XYL[]; edges: TestEdge[] };
}
interface TestModel extends BareModel, Omit<StationModel, keyof BareModel | 'built' | 'attribution' | 'notices'> {
  notices?: (StationNotice | string)[];
}
// [a, b, kind (default walk), more fields of the edge]
type TestLink = [a: number, b: number, kind?: StationEdgeKind, extra?: Partial<StationEdge>];
interface TestOpts { terraceZ?: number; edit?: (m: TestModel) => void }
function station(opts: TestOpts = {}) {
  const nodes: XYL[] = [
    [-60, -40, 0], [0, -40, 0], [60, -40, 0],          // 0-2 Bahnhofstrasse
    [0, -25, 0], [0, -18, 0],                          // 3 entrance on the plaza, 4 top of the stairs
    [0, -10, -1], [0, 0, -1], [0, 10, -1],             // 5-7 main underpass
    [10, 20, 0],                                       // 8 platform, top of the stairs (stop 7 / 8)
    [-60, 20, 0], [-20, 20, 0], [40, 20, 0], [70, 20, 0], // 9-12 platform (10 = lift top)
    [-20, 20, -1], [-20, 10, -1],                      // 13 lift bottom, 14 underpass west
    [100, -40, 0.5], [140, -40, 1], [140, -30, 1],     // 15-16 sloping street, 17 terrace
    [120, -45, 0], [120, -45, 1],                      // 18-19 lift to the terrace
  ];
  const S = { outdoor: true, name: 'Bahnhofstrasse' };
  const links: TestLink[] = [
    [0, 1, 'walk', S], [1, 2, 'walk', S], [1, 3, 'walk', { outdoor: true }], [3, 4, 'walk', { outdoor: true }],
    [4, 5, 'stairs'], [5, 6], [6, 7], [7, 8, 'stairs'],
    [9, 10], [10, 8], [8, 11], [11, 12],
    [7, 14], [14, 13], [13, 10, 'elevator'],
    [2, 15, 'walk', { outdoor: true, name: 'Schanzenstrasse' }], [15, 16, 'walk', { outdoor: true, name: 'Schanzenstrasse' }], [16, 17, 'walk', { outdoor: true }],
    [2, 18, 'walk', { outdoor: true }], [18, 19, 'elevator'], [19, 17, 'walk', { outdoor: true, name: 'Schanzenweg' }],
  ];
  const edges = links.map(([a, b, kind, extra]) => Object.assign({
    a, b, kind: kind || 'walk',
    len: kind === 'elevator' ? 0 : Math.round(Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1]) * 100) / 100,
  }, extra || {}));
  const rect = (x0: number, y0: number, x1: number, y1: number): XY[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const m: TestModel = {
    key: 'twolevel', name: 'Teststadt', origin: [7.44, 46.95], bbox: [-100, -60, 160, 40], uics: ['1', '2'],
    levels: [{ id: -1, z: -5, name: 'Lower level' }, { id: 0, z: 0, name: 'Platforms' }, { id: 1, z: opts.terraceZ || 6, name: 'Terrace level' }],
    areas: [
      { level: 0, kind: 'plaza', ring: rect(-30, -35, 30, -15), name: 'Bahnhofplatz' },
      { level: 0, kind: 'platform', ring: rect(-80, 15, 80, 25), refs: ['7', '8'] },
      { level: -1, kind: 'floor', ring: rect(-25, -12, 5, 22), name: 'Main underpass' },
      { level: 1, kind: 'plaza', ring: rect(130, -35, 150, -20), name: 'Upper terrace' },
    ],
    tracks: [], shell: [], pois: [],
    connectors: [
      { kind: 'stairs', line: [[0, -18, 0], [0, -10, -1]], width: 4 },
      { kind: 'stairs', line: [[0, 10, -1], [10, 20, 0]], width: 2.4 },
      { kind: 'elevator', xy: [-20, 20], levels: [-1, 0] },
      { kind: 'elevator', xy: [120, -45], levels: [0, 1] },
    ],
    stops: [
      { uic: '1', ref: '7', mode: 'train', name: 'Teststadt', level: 0, xy: [10, 22], node: 8 },
      { uic: '1', ref: '8', mode: 'train', name: 'Teststadt', level: 0, xy: [10, 18], node: 8 },
      { uic: '2', ref: 'A', mode: 'bus', name: 'Teststadt, Bahnhof', level: 0, xy: [60, -42], node: 2 },
      { uic: '2', ref: 'K1', mode: 'bus', name: 'Teststadt, Bahnhof', level: 0, xy: [-60, -42], node: 0 },
    ],
    sectors: [
      { ref: '7', name: 'A', xy: [-60, 22] }, { ref: '7', name: 'B', xy: [-20, 22] },
      { ref: '7', name: 'C', xy: [20, 22] }, { ref: '7', name: 'D', xy: [60, 22] },
    ],
    entrances: [{ name: 'Bahnhofplatz', level: 0, xy: [0, -25], node: 3 }],
    graph: { nodes, edges },
  };
  if (opts.edit) opts.edit(m);
  return m as StationModel;
}
const T7 = { stop: { uic: '1', ref: '7' } }, T8 = { stop: { uic: '1', ref: '8' } }, BUS = { stop: { uic: '2', ref: 'A' } };
const ENT = { entrance: 'Bahnhofplatz' };

// ======================================================================
console.log('\nNaming by where a level change arrives');
const M = station();
test('entrance → platform 7: "down to the main underpass", "through the main underpass", "up to platform 7"', () => {
  const r = SR.route(M, ENT, T7);
  checkShape(r);
  eq(kinds(r), ['stairs', 'walk', 'stairs', 'arrive'], dump(r));
  eq(r.steps[0].text, 'Take the stairs down to the main underpass');
  eq(r.steps[1].text, 'Walk 20 m through the main underpass');
  assert(/take the stairs up to platform 7$/i.test(r.steps[2].text), r.steps[2].text);
  eq(r.steps[3].text, 'Platform 7');
});
test('up from the underpass onto the square: named after Bahnhofplatz, not after level 0 ("Platforms")', () => {
  const r = SR.route(M, { node: 6 }, ENT);
  checkShape(r);
  const up = r.steps.find((s) => s.kind === 'stairs')!;
  eq(up.text, 'Take the stairs up to Bahnhofplatz');
  assert(!texts(r).some((t) => /platforms/i.test(t)), dump(r));
});
test('outdoors the street name comes first; a square is "across"', () => {
  const r = SR.route(M, BUS, ENT);
  checkShape(r);
  eq(r.steps[0].text, 'Walk 60 m along Bahnhofstrasse');
  assert(/^Turn right and walk 20 m across Bahnhofplatz$/.test(r.steps[1].text), dump(r));
});
test('a walk under the platform is named after the underpass, never after the platform above it', () => {
  const r = SR.route(M, { node: 5 }, { node: 13 });
  checkShape(r);
  eq(kinds(r), ['walk', 'walk', 'arrive'], dump(r));
  eq(r.steps[0].text, 'Walk 20 m through the main underpass');
  eq(r.steps[1].text, 'Turn left and walk 30 m', 'the same place is not repeated after a bend');
  eq(r.steps[1].place, 'the main underpass');
});
test('a level change with no area at its top is named after the edges that follow, then after the level', () => {
  // steep street (terrace 8 m up, 10 %): wheelchair takes the lift at x = 120, whose top has no area
  const S8 = station({ terraceZ: 8 });
  const r = SR.route(S8, BUS, { node: 17 }, { wheelchair: true });
  checkShape(r);
  eq(r.steps.find((s) => s.kind === 'elevator')!.text, 'Take the lift up to Schanzenweg');
  const S9 = station({ terraceZ: 8, edit: (m) => { delete m.graph.edges[20].name; } });
  const r2 = SR.route(S9, BUS, { node: 17 }, { wheelchair: true })!;
  eq(r2.steps.find((s) => s.kind === 'elevator')!.text, 'Take the lift up to the terrace level');
});

console.log('\nSloping streets');
test('a street between fractional levels is plain walking: no ramp step, slower uphill', () => {
  const r = SR.route(M, BUS, { node: 17 });
  checkShape(r);
  assert(r.steps.every((s) => s.kind === 'walk' || s.kind === 'arrive'), dump(r));
  eq(r.steps[0].text, 'Walk 90 m along Schanzenstrasse'); // 80 m of street, then 10 m onto the terrace (too short for a step)
  assert(r.steps[0].toLevel === 1 || r.steps[0].toLevel % 1 !== 0 || r.steps.length > 2, 'reaches the terrace level');
  const down = SR.route(M, { node: 17 }, BUS)!;
  assert(r.seconds > down.seconds && r.seconds > 90 / (4.7 / 3.6), `up ${r.seconds} s, down ${down.seconds} s`);
});
test('wheelchair: a gentle street (7.5 %) is fine, a steep one (10 %) is avoided for the lift', () => {
  const gentle = SR.route(M, BUS, { node: 17 }, { wheelchair: true })!;
  assert(!usesKind(gentle, 'elevator') && !gentle.relaxed, dump(gentle));
  const steep = SR.route(station({ terraceZ: 8 }), BUS, { node: 17 }, { wheelchair: true })!;
  assert(usesKind(steep, 'elevator') && !steep.relaxed, dump(steep));
});

console.log('\nClosures by date');
test('isClosed: true, open-ended bounds, from inclusive, until exclusive, Date input', () => {
  eq(SR.isClosed({ closed: true }), true);
  eq(SR.isClosed({}), false);
  eq(SR.isClosed({ closed: false }), false);
  const c = { closed: { from: '2026-12-01', until: '2026-12-14' } };
  eq(['2026-11-30', '2026-12-01', '2026-12-13', '2026-12-14'].map((d) => SR.isClosed(c, d)), [false, true, true, false]);
  eq(SR.isClosed({ closed: { from: '2026-12-01' } }, '2030-01-01'), true);
  eq(SR.isClosed({ closed: { until: '2026-12-01' } }, '2020-01-01'), true);
  eq(SR.isClosed({ closed: { until: '2026-12-01' } }, '2026-12-01'), false);
  eq(SR.isClosed(c, new Date(2026, 11, 5)), true);
  eq(SR.isClosed(c.closed, '2026-12-05'), true, 'the closure object itself');
  eq(SR.isClosed(true), true);
});
test('notices(model, date): strings always, dated ones in their window', () => {
  const m = station({ edit: (x) => { x.notices = ['Lifts are checked every Monday', { text: 'Works on platform 7', from: '2026-12-01', until: '2026-12-14' }]; } });
  eq(SR.notices(m, '2026-11-30').map((n) => n.text), ['Lifts are checked every Monday']);
  eq(SR.notices(m, '2026-12-01').map((n) => n.text), ['Lifts are checked every Monday', 'Works on platform 7']);
  eq(SR.notices(m, '2026-12-14').length, 1);
  eq(SR.notices(station(), '2026-12-01'), []);
});
const STAIRS_CLOSED = { from: '2026-12-01', until: '2026-12-14', note: 'The stairs to platform 7 are closed for works.' };
const MC = station({ edit: (m) => { m.connectors[1].closed = STAIRS_CLOSED; } });
test('a closed staircase (connector) is not used inside its dates; the route says what it goes around', () => {
  const at = (date: StationRouteDate) => SR.route(MC, { node: 6 }, T7, { date })!;
  const before = at('2026-11-30'), first = at('2026-12-01'), last = at('2026-12-13'), after = at('2026-12-14');
  for (const r of [before, first, last, after]) checkShape(r);
  assert(usesKind(before, 'stairs') && !before.closed && !before.notice, dump(before));
  for (const r of [first, last]) {
    assert(!usesKind(r, 'stairs') && usesKind(r, 'elevator'), dump(r));
    eq(r.closed!.map((c) => [c.what, c.kind, c.note]), [['connector', 'stairs', STAIRS_CLOSED.note]]);
    eq(r.closed![0].until, '2026-12-14');
    assert(r.notice!.includes(STAIRS_CLOSED.note), r.notice);
    assert(!r.incomplete);
  }
  assert(usesKind(after, 'stairs') && !after.closed, dump(after));
  // the model cache does not keep a date: back and forth gives the same answers
  eq(at('2026-11-30').nodes, before.nodes); eq(at('2026-12-05').nodes, first.nodes); eq(at('2026-11-30').nodes, before.nodes);
  // a Date works as prefs.date
  assert(usesKind(SR.route(MC, { node: 6 }, T7, { date: new Date(2026, 11, 5) })!, 'elevator'));
});
test('closed: true on an edge (old style) always closes it; without a reason the notice says what is closed', () => {
  const m = station({ edit: (x) => { x.graph.edges[14].closed = true; } }); // the lift underpass ↔ platform
  const r = SR.route(m, T7, { node: 6 }, { stepFree: true, date: '2026-11-21' });
  checkShape(r);
  assert(!usesKind(r, 'elevator') && r.relaxed && r.relaxed.includes('stepFree'), dump(r));
  eq(r.closed![0].what, 'edge');
  assert(/the lift on the way is closed/i.test(r.notice!), r.notice);
});
test('a closed stop that open ways still reach: routed to it, with its note', () => {
  const m = station({ edit: (x) => { x.stops[0].closed = { from: '2026-12-01', until: '2026-12-14', note: 'Platform 7: no trains, use platform 8.' }; } });
  const r = SR.route(m, ENT, T7, { date: '2026-12-02' });
  checkShape(r);
  eq(r.nodes[r.nodes.length - 1], 8);
  assert(!r.incomplete);
  eq(r.closed![0].what, 'stop'); eq(r.closed![0].ref, '7');
  assert(r.notice!.includes('use platform 8'), r.notice);
  eq(SR.why(m, ENT, T7, { date: '2026-12-02' }), null);
  assert(!SR.route(m, ENT, T7, { date: '2026-12-20' })!.closed, 'not after the dates');
});
test('a destination reachable only through closed parts: as close as possible, said, why = "closed"', () => {
  const m = station({ edit: (x) => { x.areas[1].closed = { until: '2026-12-14', note: 'Platform 7/8 is closed.' }; } });
  const r = SR.route(m, ENT, T7, { date: '2026-12-02' });
  checkShape(r);
  assert(r.incomplete === true, 'incomplete');
  assert(r.toDist > 5, `toDist ${r.toDist}`);
  assert(r.closed!.some((c) => c.what === 'area' && c.note === 'Platform 7/8 is closed.'), JSON.stringify(r.closed));
  assert(/closed/.test(r.notice!) && /as close as it can/.test(r.notice!), r.notice);
  eq(r.steps[r.steps.length - 1].text, 'As close as the route can get');
  eq(SR.why(m, ENT, T7, { date: '2026-12-02' }), 'closed');
  eq(SR.why(m, ENT, T7, { date: '2026-12-14' }), null);
});
test('starting on a closed platform: the way out goes through the closure, said so', () => {
  const m = station({ edit: (x) => { x.areas[1].closed = { note: 'Platform 7/8 is closed.' }; } });
  const r = SR.route(m, T7, ENT);
  checkShape(r);
  assert(r.length > 20 && r.throughClosed === true && !r.incomplete, dump(r));
  assert(/through the closed part/.test(r.notice!), r.notice);
  eq(SR.why(m, T7, ENT), 'closed');
});
test('a closed entrance: you cannot go in there, but it still resolves as a start', () => {
  const m = station({ edit: (x) => { x.entrances[0].closed = { note: 'Entrance Bahnhofplatz is closed tonight.' }; } });
  const r = SR.route(m, ENT, BUS);
  checkShape(r);
  eq(r.closed![0].what, 'entrance');
  assert(r.notice!.includes('closed tonight'), r.notice);
});

console.log('\nSectors');
const pointNear = (r: StationRouteResult, x: number, y: number, tol = 1.5) => { const p = r.points[r.points.length - 1]; return Math.hypot(p[0] - x, p[1] - y) <= tol; };
test('a ref with one sector aims at it: "Platform 7, sector B"', () => {
  for (const ref of ['7B', '7 B', 'Gleis 7B', '7 Sektor B']) {
    const r = SR.route(M, ENT, { stop: { uic: '1', ref } });
    checkShape(r, ref);
    assert(pointNear(r, -20, 20), `${ref}: ends at ${r.points[r.points.length - 1]}`);
    eq(r.steps[r.steps.length - 1].text, 'Platform 7, sector B', ref);
    eq(r.toSectors, ['B']);
    eq(r.steps[r.steps.length - 1].sector, 'B');
  }
});
test('a sector range aims at its middle: "7A-D", "7BC"', () => {
  const r = SR.route(M, ENT, { stop: { uic: '1', ref: '7A-D' } })!;
  assert(pointNear(r, 0, 20), String(r.points[r.points.length - 1]));
  eq(r.steps[r.steps.length - 1].text, 'Platform 7, sectors A–D');
  eq(r.steps[r.steps.length - 1].sector, 'A–D');
  const bc = SR.route(M, ENT, { stop: { uic: '1', ref: '7BC' } })!;
  assert(pointNear(bc, 0, 20)); eq(bc.toSectors, ['B', 'C']);
  // sectors the data does not have: the stop's own node, no sector text
  const z = SR.route(M, ENT, { stop: { uic: '1', ref: '7X' } })!;
  eq(z.nodes[z.nodes.length - 1], 8); eq(z.steps[z.steps.length - 1].text, 'Platform 7');
  // "K1" is a name, not platform K with sector 1
  eq(SR.resolve(M, { stop: { uic: '2', ref: 'K1' } })[0].node, 0);
});
test('a walk along the platform to the aimed sector says so', () => {
  const r = SR.route(M, ENT, { stop: { uic: '1', ref: '7A' } })!;
  const w = r.steps[r.steps.length - 2];
  assert(/along platform 7 to sector A$/.test(w.text), dump(r));
});
test('sectorTimes matches a separate search from each sector (one backward search)', () => {
  for (const [to, prefs] of [[ENT, {}], [ENT, { stepFree: true }], [BUS, {}], [{ node: 13 }, { wheelchair: true }], [{ node: 17 }, {}]] satisfies [StationRouteEndpoint, StationRoutePrefs][]) {
    const st = SR.sectorTimes(M, T7, to, prefs);
    assert(st && st.sectors.length === 4, 'four sectors');
    const brute = st.sectors.map((s) => SR.route(M, { stop: { uic: '1', ref: '7' + s.name } }, to, prefs)!);
    st.sectors.forEach((s, i) => {
      near(s.seconds, brute[i].seconds, 1, `${JSON.stringify(to)} ${JSON.stringify(prefs)} sector ${s.name} seconds`);
      near(s.length, brute[i].length, 1, `sector ${s.name} length`);
      const conn = brute[i].steps.find((x) => !['walk', 'arrive'].includes(x.kind));
      eq(s.via, conn ? conn.kind : null, `sector ${s.name} via`);
    });
    const secs = st.sectors.map((s) => s.seconds);
    eq(st.spreadSeconds, Math.max(...secs) - Math.min(...secs));
    assert(st.sectors.some((s) => s.name === st.best), 'best is one of them');
  }
  const st = SR.sectorTimes(M, T7, ENT, {})!;
  eq(st.sectors.map((s) => s.name), ['A', 'B', 'C', 'D']);
  eq(st.best, 'C', 'C is next to the stairs');
  eq(st.sectors.find((s) => s.name === 'C')!.via, 'stairs');
  // step-free: the lift at sector B
  const sf = SR.sectorTimes(M, T7, ENT, { stepFree: true })!;
  eq(sf.best, 'B'); eq(sf.sectors.find((s) => s.name === 'B')!.via, 'elevator');
});
test('sectorTimes: null without sectors, or without a stop', () => {
  eq(SR.sectorTimes(M, T8, ENT, {}), null);
  eq(SR.sectorTimes(M, { node: 8 }, ENT, {}), null);
  const F = loadModel('_fixture.js', '_fixture');
  const st = SR.sectorTimes(F, { stop: { uic: '0000001', ref: '1' } }, { entrance: 'Station square' }, {});
  assert(st && st.sectors.length === 3, 'fixture platform 1 has sectors A–C');
});

console.log('\nwhy(), same platform, refs, snapping');
test('why: unknown stop / entrance / node, not connected, null when fine', () => {
  eq(SR.why(M, { stop: { uic: '1', ref: '99' } }, T7), 'unknown-stop');
  eq(SR.why(M, { entrance: 'Nowhere' }, T7), 'unknown-entrance');
  eq(SR.why(M, { node: 999 }, T7), 'unknown-node');
  eq(SR.why(M, ENT, T7), null);
  const cut = station({ edit: (m) => { m.graph.edges.splice(4, 1); } }); // no stairs plaza ↔ underpass
  eq(SR.route(cut, ENT, T7), null);
  eq(SR.why(cut, ENT, T7), 'not-connected');
});
test('platform numbers match exactly: "11" is not platform 1, and falls back to the position given with it', () => {
  const F = loadModel('_fixture.js', '_fixture');
  eq(SR.resolve(F, { stop: { uic: '0000001', ref: '11' } }), []);
  eq(SR.resolve(F, { stop: { uic: '0000001', ref: '31' } }), []);
  eq(SR.route(F, { entrance: 'Station square' }, { stop: { uic: '0000001', ref: '11' } }), null);
  const withLL = SR.resolve(F, { stop: { uic: '0000001', ref: '11' }, ll: SR.toLngLat(F, [-30, 14]) });
  eq(withLL.length, 1); assert(!withLL[0].stop, 'not a stop');
  // letter forms still match by prefix: "K" finds "K1"
  eq(SR.resolve(M, { stop: { uic: '2', ref: 'K' } })[0].stop!.ref, 'K1');
  eq(SR.resolve(M, { stop: { uic: '1', ref: '7A-D' } })[0].stop!.ref, '7');
});
test('same platform: two equal points, length 0, one arrive step, same: true', () => {
  const r = SR.route(M, T7, T7)!;
  eq(r.points.length, 2); eq(r.points[0], r.points[1]); eq(r.length, 0); eq(r.same, true);
  eq(r.steps.length, 1); eq(r.steps[0].kind, 'arrive'); eq([r.steps[0].from, r.steps[0].to], [0, 1]);
  eq(r.steps[0].text, 'Stay on platform 7');
  eq(r.dists, [0, 0]);
  const x = SR.route(M, T7, T8)!;
  eq(x.same, true); eq(x.steps[0].text, 'Platform 8 is across the same platform');
  const b = SR.route(M, BUS, BUS)!;
  eq(b.steps[0].text, 'Stay at bay A');
  // different sectors of the same platform are a real walk
  const s = SR.route(M, { stop: { uic: '1', ref: '7A' } }, { stop: { uic: '1', ref: '7D' } })!;
  assert(!s.same && s.length > 100, dump(s));
});
test('platformKey is the reference rule', () => {
  const cases = { Steg: 'STEG', 'Steg 3': '3', 'Gleis 7': '7', 'Gl. 12': '12', 'GL12': '12', '7A-D': '7', '12 Sektor B': '12',
    'Kante H': 'H', K1: 'K1', 'K 1': 'K1', '–': '', '': '', Kante: 'KANTE', 'Platform 9': '9', 'voie 3': '3', 7: '7', 'Perron 2': '2' };
  for (const [k, v] of Object.entries(cases)) eq(SR.platformKey(k), v, `platformKey(${JSON.stringify(k)})`);
  eq(SR.platformKey(null), '');
});
test('far free positions come in from the street: never mid-ramp, on a platform or a deck; fromDist says how far', () => {
  const ll = SR.toLngLat(M, [30, 900]); // 900 m north, beyond the platform
  for (const level of [undefined, -1, 0]) {
    const r = SR.route(M, { ll, level }, T7);
    checkShape(r);
    const p = r.points[0], e = M.graph.edges[SR.resolve(M, { ll, level })[0].edge!];
    eq(p[2], 0, 'street level');
    assert(e.outdoor && e.kind === 'walk', `starts on an outdoor walk, not ${JSON.stringify(e)}`);
    assert(p[1] < 0, 'not on the platform (y = 20)');
    near(r.fromDist, Math.hypot(30 - p[0], 900 - p[1]), 0.5, 'fromDist');
    assert(r.fromDist > 900, `fromDist ${r.fromDist}`);
    eq(r.toDist, 0);
  }
  // near the station (5 m from the plaza path): ordinary snapping
  const r = SR.route(M, { xy: [5, -25] }, T7)!;
  near(r.fromDist, 5, 0.01); eq(r.points[0], [0, -25, 0]);
  // with a level and near: that floor
  const u = SR.resolve(M, { xy: [3, 2], level: -1 })[0];
  eq(u.point[2], -1); near(u.dist, 3, 0.01);
});

test('snap after a lift: the floor below and the deck above overlap in plan; no jumping ahead, no creeping back', () => {
  // walk east 40 m on level −1 to a lift, up to level 2, then walk back west 40 m right above the way you came
  const m = { origin: [7.44, 46.95], levels: [{ id: -1, z: -5 }, { id: 0, z: 0 }, { id: 2, z: 10 }], stops: [], areas: [],
    graph: { nodes: [[0, 0, -1], [40, 0, -1], [40, 0, 2], [0, 1, 2]], edges: [{ a: 0, b: 1, kind: 'walk', len: 40 }, { a: 1, b: 2, kind: 'elevator', len: 0 }, { a: 2, b: 3, kind: 'walk', len: 40.01 }] } } as BareModel as StationModel;
  const r = SR.route(m, { node: 0 }, { node: 3 })!;
  let rng = 3;
  const rand = () => ((rng = (rng * 16807) % 2147483647) / 2147483647 - 0.5);
  const total = r.dists[r.dists.length - 1];
  let prev: StationRouteSnap | null = null, wrong = 0, worst = 0;
  for (let k = 0; k <= total; k += 1.5) {
    const p = SR.pointAt(r, k)!, s: StationRouteSnap = SR.snap(m, r, [p[0] + 3 * rand(), p[1] + 3 * rand()], prev)!;
    if (Math.abs(s.point[2] - p[2]) > 0.5) wrong++;
    if (prev) worst = Math.min(worst, s.along - prev.along);
    prev = s;
  }
  assert(wrong <= 3, `${wrong} fixes on the wrong floor`);
  assert(worst > -4, `went back ${-worst} m`);
  near(prev!.along, total, 4, 'reaches the end');
  assert(prev!.progress! >= prev!.along, 'progress is the furthest point reached');
});

console.log('\nStairs time and landings');
type BareLink = [a: number, b: number, kind?: StationEdgeKind, len?: number];
const mk = (nodes: XYL[], links: BareLink[], levels?: TestLevel[]) => ({
  origin: [7.44, 46.95], levels: levels || [{ id: -1, z: -4.8 }, { id: 0, z: 0 }], stops: [], areas: [],
  graph: { nodes, edges: links.map(([a, b, kind, len]) => ({ a, b, kind: kind || 'walk', len: len != null ? len : Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1]) })) },
}) as BareModel as StationModel;
test('stairs are timed by rise, plus the horizontal length beyond the flights', () => {
  const short = mk([[0, 0, 0], [8.16, 0, -1]], [[0, 1, 'stairs']]);
  const up = SR.route(short, { node: 1 }, { node: 0 })!.seconds;
  near(up, 4.8 / 0.34, 1, 'one floor up');
  const long = mk([[0, 0, 0], [30, 0, -1]], [[0, 1, 'stairs']]);
  near(SR.route(long, { node: 1 }, { node: 0 })!.seconds, 4.8 / 0.34 + (30 - 4.8 * 1.7) / (4.7 / 3.6), 1, 'with a landing corridor');
});
test('a landing between two flights is one run of stairs (counted once when relaxing step-free)', () => {
  // A: flight – 3 m landing – flight. B: one flight, but 60 m more walking. Both break step-free.
  const nodes: XYL[] = [[0, 0, 0], [5, 0, -0.5], [5, 3, -0.5], [0, 3, -1], [0, 40, 0], [40, 40, 0], [40, 3, -1]];
  const m = mk(nodes, [[0, 1, 'stairs'], [1, 2], [2, 3, 'stairs'], [0, 4], [4, 5], [5, 6, 'stairs', 8], [6, 3]]);
  const r = SR.route(m, { node: 0 }, { node: 3 }, { stepFree: true })!;
  eq(r.nodes, [0, 1, 2, 3], dump(r));
  eq(r.relaxed, ['stepFree']);
  eq(kinds(r), ['stairs', 'arrive'], 'one stairs step');
});

console.log('\nA platform is the whole platform');
// Two island platforms: 7/8 at y = 20 and 12/13 at y = 60, x −100 … 100. West end (x = −80): stairs up to an overpass
// ("Welle", level 1, 7 m up). East end (x = 80): stairs down to an underpass (level −1, 4 m down). Each stop's own
// node is at the west end, next to the Welle. Sectors A–D along platform 7, west to east.
function twoPlatforms(opts: TestOpts = {}) {
  const nodes: XYL[] = [
    [-100, 20, 0], [-80, 20, 0], [-40, 20, 0], [0, 20, 0], [40, 20, 0], [80, 20, 0], [100, 20, 0], // 0-6 platform 7/8
    [-100, 60, 0], [-80, 60, 0], [-40, 60, 0], [0, 60, 0], [40, 60, 0], [80, 60, 0], [100, 60, 0], // 7-13 platform 12/13
    [-80, 30, 1], [-80, 50, 1], // 14-15 Welle
    [80, 30, -1], [80, 50, -1], // 16-17 underpass
  ];
  const links: TestLink[] = [];
  for (let i = 0; i < 6; i++) { links.push([i, i + 1]); links.push([7 + i, 8 + i]); }
  links.push([1, 14, 'stairs'], [14, 15], [15, 8, 'stairs'], [5, 16, 'stairs'], [16, 17], [17, 12, 'stairs']);
  const edges = links.map(([a, b, kind]) => ({ a, b, kind: kind || 'walk', len: Math.round(Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1]) * 100) / 100 }));
  const rect = (x0: number, y0: number, x1: number, y1: number): XY[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const m: TestModel = {
    key: 'two', name: 'Zweigleis', origin: [7.44, 46.95], bbox: [-110, 0, 110, 70], uics: ['1'],
    levels: [{ id: -1, z: -4, name: 'Underpass' }, { id: 0, z: 0, name: 'Platforms' }, { id: 1, z: 7, name: 'Welle' }],
    areas: [
      { level: 0, kind: 'platform', ring: rect(-105, 15, 105, 25), refs: ['7', '8'] },
      { level: 0, kind: 'platform', ring: rect(-105, 55, 105, 65), refs: ['12', '13'] },
      { level: 1, kind: 'floor', ring: rect(-85, 25, -75, 55), name: 'Welle' },
      { level: -1, kind: 'floor', ring: rect(75, 25, 85, 55), name: 'Underpass' },
    ],
    stops: [
      { uic: '1', ref: '7', mode: 'train', name: 'Zweigleis', level: 0, xy: [-90, 22], node: 1 },
      { uic: '1', ref: '8', mode: 'train', name: 'Zweigleis', level: 0, xy: [-90, 18], node: 1 },
      { uic: '1', ref: '12', mode: 'train', name: 'Zweigleis', level: 0, xy: [-90, 62], node: 8 },
    ],
    sectors: [{ ref: '7', name: 'A', xy: [-80, 22] }, { ref: '7', name: 'B', xy: [-30, 22] }, { ref: '7', name: 'C', xy: [30, 22] }, { ref: '7', name: 'D', xy: [80, 22] }],
    entrances: [], connectors: [], tracks: [], shell: [], pois: [],
    graph: { nodes, edges },
  };
  if (opts.edit) opts.edit(m);
  return m as StationModel;
}
const TP = twoPlatforms();
const P7 = { stop: { uic: '1', ref: '7' } }, P12 = { stop: { uic: '1', ref: '12' } };
test('7 → 12: the quicker way (the underpass at the east end), not the one next to the stops\' own nodes', () => {
  const r = SR.route(TP, P7, P12);
  checkShape(r);
  eq(r.nodes, [5, 16, 17, 12], dump(r));
  eq(kinds(r), ['stairs', 'walk', 'stairs', 'arrive']);
  eq(r.steps[0].text, 'Take the stairs down to the underpass');
  eq(r.fromAssumed, { xy: [80, 20], sector: 'D', text: 'from the stairs at sector D' });
  eq(r.toAssumed, { xy: [80, 60], text: 'to the stairs' });
  eq(r.steps[r.steps.length - 1].text, 'Platform 12', 'no sector named at a whole-platform destination');
  // the old single-node behaviour would have gone over the Welle
  const fixed = SR.route(TP, { node: 1 }, { node: 8 })!;
  assert(fixed.nodes.includes(14), dump(fixed));
  assert(r.seconds < fixed.seconds, `${r.seconds} s vs ${fixed.seconds} s from the fixed nodes`);
});
test('an explicit sector overrides it: sector A goes over the Welle', () => {
  for (const ep of [{ stop: { uic: '1', ref: '7A' } }, { stop: { uic: '1', ref: '7', sector: 'A' } }]) {
    const r = SR.route(TP, ep, P12);
    checkShape(r);
    assert(r.nodes.includes(14) && !r.nodes.includes(16), dump(r));
    assert(!r.fromAssumed, 'nothing assumed');
    eq(r.fromSectors, ['A']);
  }
  const d = SR.route(TP, { stop: { uic: '1', ref: '7', sector: 'D' } }, P12)!;
  assert(d.nodes.includes(16), dump(d));
});
test('destination: the route ends where it first reaches the platform', () => {
  const fromUnder = SR.route(TP, { node: 16 }, P12)!;
  eq(fromUnder.nodes, [16, 17, 12]); eq(fromUnder.toAssumed!.text, 'to the stairs');
  const fromWelle = SR.route(TP, { node: 14 }, P12)!;
  eq(fromWelle.nodes, [14, 15, 8]);
  // a free position on the platform keeps its exact point
  const r = SR.route(TP, { xy: [20, 21], level: 0 }, P12)!;
  eq(r.points[0], [20, 20, 0]); assert(!r.fromAssumed);
});
test('the whole-platform start agrees with sectorTimes', () => {
  for (const prefs of [{}, { fewerStairs: true }]) {
    const st = SR.sectorTimes(TP, P7, P12, prefs)!;
    const r = SR.route(TP, P7, P12, prefs)!;
    eq(r.fromAssumed!.sector, st.best, JSON.stringify(prefs));
    const min = Math.min(...st.sectors.map((s) => s.seconds));
    assert(r.seconds <= min + 1, `route ${r.seconds} s, best sector ${min} s`);
    eq(st.sectors.find((s) => s.name === 'A')!.via, 'stairs');
  }
  // the Welle end is quicker when the underpass is closed
  const closedU = twoPlatforms({ edit: (m) => { m.graph.edges.find((e) => e.a === 16 && e.b === 17)!.closed = true; } });
  const r = SR.route(closedU, P7, P12)!;
  eq(r.fromAssumed!.sector, 'A'); eq(SR.sectorTimes(closedU, P7, P12, {})!.best, 'A');
});
test('snap, dists and steps hold with a start away from the stop\'s own node; 7 → 8 is the same platform', () => {
  const r = SR.route(TP, P7, P12)!;
  const total = r.dists[r.dists.length - 1];
  let prev: StationRouteSnap | null = null;
  for (let m = 0; m <= total; m += 1) {
    const p = SR.pointAt(r, m)!, s: StationRouteSnap = SR.snap(TP, r, p, prev)!;
    near(s.along, m, 0.6, `along at ${m}`);
    prev = s;
  }
  const x = SR.route(TP, P7, { stop: { uic: '1', ref: '8' } })!;
  eq(x.same, true); eq(x.steps[0].text, 'Platform 8 is across the same platform'); eq(x.points.length, 2);
  eq(SR.route(TP, P7, P7)!.steps[0].text, 'Stay on platform 7');
  // a bus bay with one node is as before
  const b = SR.route(M, BUS, ENT)!;
  eq(b.nodes[0], 2); assert(!b.fromAssumed);
});

// ======================================================================
const bernFile = path.join(ROOT, 'stations3d', 'bern.js');
if (fs.existsSync(bernFile)) {
  console.log('\nBern (stations3d/bern.js)');
  const B = loadModel('bern.js', 'bern');
  const fmtR = (r: StationRouteResult | null) => (r ? `${r.length} m, ${Math.round(r.seconds / 6) / 10} min${r.relaxed ? ', relaxed ' + r.relaxed.join(', ') : ''}${r.incomplete ? ', INCOMPLETE' : ''}${r.same ? ', same' : ''}` : 'NO ROUTE');
  const show = (title: string, a: StationRouteEndpoint | null, b: StationRouteEndpoint | null, prefs: StationRoutePrefs = {}) => {
    const r = SR.route(B, a, b, prefs);
    console.log(`\n  ${title}: ${fmtR(r)}${r ? '' : ' — why: ' + SR.why(B, a, b, prefs)}`);
    if (!r) return;
    if (r.notice) console.log(`    notice: ${r.notice}`);
    if (r.fromAssumed || r.toAssumed) console.log(`    assumed: ${r.fromAssumed ? 'start ' + r.fromAssumed.text : ''}${r.fromAssumed && r.toAssumed ? '; ' : ''}${r.toAssumed ? 'end ' + r.toAssumed.text : ''}`);
    if (r.closed) console.log(`    closed: ${JSON.stringify(r.closed)}`);
    for (const s of r.steps) console.log(`    ${String(s.kind).padEnd(9)} ${String(s.len).padStart(4)} m ${String(s.seconds).padStart(4)} s  L${+s.level.toFixed(2)}→${+s.toLevel.toFixed(2)}  ${s.text}`);
  };
  const find = (mode: string | null, ref: string, nameRe?: RegExp) => B.stops.find((s) => (!mode || s.mode === mode) && SR.platformKey(s.ref) === SR.platformKey(ref) && (!nameRe || nameRe.test(s.name || ''))) || null;
  const ep = (s: StationStop | null, ref?: string) => (s ? { stop: { uic: s.uic, ref: ref || s.ref } } : null);
  const mainEnt = (B.entrances || []).find((e) => /bahnhofplatz|haupt|main/i.test(e.name || '')) || (B.entrances || [])[0];
  console.log(`  built ${B.built}; ${B.graph.nodes.length} nodes, ${B.graph.edges.length} edges, ${(B.sectors || []).length} sectors, ` +
    `${(B.notices || []).length} notices, closed: ${['stops', 'areas', 'connectors', 'entrances'].map((k) => `${k} ${(B[k as 'stops' | 'areas' | 'connectors' | 'entrances'] || []).filter((x) => x && x.closed).length}`).join(', ')}, edges ${B.graph.edges.filter((e) => e.closed).length}`);
  for (const d of ['2026-11-21', '2026-12-14']) console.log(`  notices on ${d}: ${JSON.stringify(SR.notices(B, d))}`);
  test('Bern: all sample endpoints resolve', () => {
    for (const s of [find('train', '7'), find('tram', 'B'), find('train', '3'), find(null, '22'), find('bus', 'T'), find('train', '12'), find('train', '13'), find('train', '4')]) assert(s, 'stop missing');
  });
  type SampleRoute = [title: string, from: StationRouteEndpoint | null, to: StationRouteEndpoint | null];
  const samples: SampleRoute[] = [
    ['Platform 7 → tram edge B', ep(find('train', '7')), ep(find('tram', 'B'))],
    ['Platform 3 → RBS platform 22', ep(find('train', '3')), ep(find(null, '22'))],
    ['PostAuto bay T → platform 12', ep(find('bus', 'T')), ep(find('train', '12'))],
    [`Entrance ${mainEnt ? mainEnt.name : '?'} → platform 13`, mainEnt ? { entrance: mainEnt.name } : null, ep(find('train', '13'))],
    ['Platform 1 → platform 9', ep(find('train', '1')), ep(find('train', '9'))],
  ];
  for (const [t, a, b] of samples) {
    if (!a || !b) { console.log(`\n  ${t}: endpoint not in the model`); continue; }
    show(t, a, b); show(t + ' (step-free)', a, b, { stepFree: true });
  }
  const bplatz = mainEnt ? { entrance: mainEnt.name } : null;
  for (const date of ['2026-11-21', '2026-12-14']) show(`Platform 4 → ${mainEnt ? mainEnt.name : '?'} on ${date}`, ep(find('train', '4')), bplatz, { date });
  show('From Zürich (no level) → platform 7', { ll: [8.5402, 47.3782] }, ep(find('train', '7')));
  show('Platform 7 → platform 7', ep(find('train', '7')), ep(find('train', '7')));
  show('Platform 7, sectors A–D → platform 12', ep(find('train', '7'), '7A-D'), ep(find('train', '12')));
  console.log(`\n  "11" at Bern Hbf: resolve → ${SR.resolve(B, { stop: { uic: '8507000', ref: '11' } }).length} candidates, why: ${SR.why(B, { stop: { uic: '8507000', ref: '11' } }, ep(find('train', '7')))}`);
  const table = (title: string, from: StationRouteEndpoint | null, to: StationRouteEndpoint | null) => {
    for (const prefs of [{}, { stepFree: true }]) {
      const st = SR.sectorTimes(B, from, to, prefs);
      console.log(`\n  sectorTimes ${title}${prefs.stepFree ? ' (step-free)' : ''}: ${st ? `best ${st.best}, spread ${st.spreadSeconds} s` : 'null (no sectors for this platform in the model)'}`);
      if (st) for (const s of st.sectors) console.log(`    sector ${String(s.name).padEnd(3)} ${String(s.seconds).padStart(4)} s ${String(s.length).padStart(4)} m  via ${s.via}${s.warn ? '  (breaks a preference)' : ''}`);
    }
  };
  table('platform 7 → RBS 23', ep(find('train', '7')), ep(find(null, '23')));
  table('platform 7 → PostAuto bay R', ep(find('train', '7')), ep(find('bus', 'R')));
  test('Bern: sectorTimes agrees with per-sector routes (when the model has sectors)', () => {
    const from = ep(find('train', '7')), to = ep(find(null, '23'));
    const st = SR.sectorTimes(B, from, to, {});
    if (!st) return;
    for (const s of st.sectors) near(s.seconds, SR.route(B, { stop: { uic: from!.stop.uic, ref: '7' + s.name } }, to)!.seconds, 1, `sector ${s.name}`);
  });
  test('Bern: the whole-platform start agrees with sectorTimes (platform 7 → RBS 23, → bay R)', () => {
    for (const to of [ep(find(null, '23')), ep(find('bus', 'R'))]) for (const prefs of [{}, { stepFree: true }]) {
      const st = SR.sectorTimes(B, ep(find('train', '7')), to, prefs);
      if (!st) return;
      const r = SR.route(B, ep(find('train', '7')), to, prefs)!;
      const min = Math.min(...st.sectors.map((s) => s.seconds));
      assert(r.seconds <= min + 2, `route ${r.seconds} s, best sector ${min} s`);
      eq(r.fromAssumed!.sector, st.best, 'the start is labelled with sectorTimes().best');
      console.log(`        7 → ${to!.stop.ref}${prefs.stepFree ? ' step-free' : ''}: start ${r.fromAssumed && r.fromAssumed.text}, ${r.seconds} s; sectorTimes best ${st.best} (${min} s)`);
    }
  });
  test('Bern: from Zürich the route starts on a street at street level', () => {
    const r = SR.route(B, { ll: [8.5402, 47.3782] }, ep(find('train', '7')));
    assert(r && Math.abs(r.points[0][2]) <= 0.6, `starts at ${r && r.points[0]}`);
    assert(r.fromDist > 90000, `fromDist ${r.fromDist}`);
  });
} else console.log('\nstations3d/bern.js not there: Bern part skipped');

console.log(`\n${passed} passed, ${failed} failed${failed ? ': ' + failures.join('; ') : ''}`);
process.exitCode = failed ? 1 : 0;
