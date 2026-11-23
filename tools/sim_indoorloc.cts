#!/usr/bin/env node
// Simulated walks through a station model, to test the logic of the indoor Filter (indoorloc.ts) and compare sensor
// setups. A virtual person walks real routes of the model (street → underground platform, platform changes, lifts),
// and the script produces the sensor data a phone would: steps with a biased, noisy compass (and magnetic
// disturbances near trains), GPS that degrades indoors and vanishes underground, barometric pressure with weather
// drift, a ventilation step and train piston-effect surges, and signs read on the way.
//
// The station is a 3D model from stations3d/ (stations3d/SCHEMA.md) and the walks are routes of station-route.ts.
// It tests the logic, not the sensor assumptions: those need real recordings (INDOORNAV.record() in the app, then
// `node tools/sim_indoorloc.cts --replay log.json`). Numbers here are only as good as the noise models below.
//
//   node tools/sim_indoorloc.cts                      all scenarios, 8 seeds each, on Bern
//   node tools/sim_indoorloc.cts --seeds 4 --only lift --verbose
//   node tools/sim_indoorloc.cts --only lift --trace --traceseed 2    print truth vs estimate every 10 s
//   node tools/sim_indoorloc.cts --only rbs-baro --seeds 1 --export walk.json   a log in the recording format (IndoorLog)
//   node tools/sim_indoorloc.cts --check               regression test: exit 1 if a scenario got worse
//   node tools/sim_indoorloc.cts --replay recording.json [--key bern]
import type { IndoorEstimateTracking, IndoorLandmark, IndoorLog, IndoorLogEvent, IndoorPrior, IndoorRandom } from '../src/indoorloc.ts';
import type { StationRouteEndpoint, StationRoutePrefs, StationRouteResult } from '../src/station-route.ts';
'use strict';
const path = require('path') as typeof import('path');
const fs = require('fs') as typeof import('fs');
const ROOT = path.join(__dirname, '..');
// the modules as the page has them (ES modules: require() gives their exports)
const I = require(path.join(ROOT, 'src', 'indoorloc.ts')).INDOORLOC as typeof import('../src/indoorloc.ts').INDOORLOC;
const S = require(path.join(ROOT, 'src', 'signloc.ts')).SIGNLOC as typeof import('../src/signloc.ts').SIGNLOC;

const args = process.argv.slice(2);
const arg = <D = undefined,>(k: string, d?: D): string | D => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d as D; };
const flag = (k: string) => args.includes('--' + k);
const KEY = arg('key', 'bern');
const SEEDS = +arg('seeds', 8);
const ONLY = arg('only', null);
const VERBOSE = flag('verbose');
const TRACE = flag('trace');

Object.assign(globalThis, { window: globalThis }); // the station model puts itself on window
require(path.join(ROOT, 'stations3d', KEY + '.js'));
const RAW = globalThis.STATION3D![KEY];
const SR = require(path.join(ROOT, 'src', 'station-route.ts')).StationRoute as typeof import('../src/station-route.ts').StationRoute;
const M = new I.Model(RAW);

// ------------------------------------------------------------------------------------------- replay a recording
if (arg('replay')) {
  const log: IndoorLog = JSON.parse(fs.readFileSync(arg('replay')!, 'utf8'));
  const r = I.replay(log, M, { every: true });
  console.log(`${log.events.length} events, ${r.checkpoints.length} checkpoints`);
  for (const c of r.checkpoints) console.log(`  t=${c.t.toFixed(0)}s  floor ${c.levelOk ? 'right' : 'WRONG'} (p=${c.prob.toFixed(2)})  error ${c.d == null ? '—' : c.d.toFixed(1) + ' m'}`);
  process.exit(0);
}

// ------------------------------------------------------------------------------------------- ground truth walks
const uic = RAW.uics[0];
const P = (ref: string) => ({ stop: { uic, ref } });
const E = (name: string) => ({ entrance: name });

// a route of station-route.ts → a timeline of positions: [{ t, x, y, z, li, mode: 'walk'|'stairs'|'escalator'|'lift'|'wait' }]
type SimWalkMode = 'walk' | 'stairs' | 'escalator' | 'lift' | 'wait';
/** A moment of a walk: where the person really is. (_prev: read by --trace, never set.) */
interface SimWalkPoint { t: number; x: number; y: number; z: number; li: number; mode: SimWalkMode; _prev?: number }
/** How the person takes a route. inLift: timeline()'s own note between two lift edges. */
interface SimWalkOptions { liftWait: number; walkEscalator?: boolean; stress?: boolean; inLift?: boolean }
function timeline(route: StationRouteResult, o: SimWalkOptions) {
  const out: SimWalkPoint[] = [];
  const pts = route.points, eidx = route.edges || [];
  let t = 0;
  const push = (x: number, y: number, level: number, mode: SimWalkMode) => out.push({ t: +t.toFixed(2), x, y, z: M.zOf(level), li: M.floorOf(level), mode });
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay, al] = pts[i], [bx, by, bl] = pts[i + 1];
    const edge = eidx[i] >= 0 ? RAW.graph.edges[eidx[i]] : null;
    const kind = edge ? edge.kind : 'walk';
    const L = Math.hypot(bx - ax, by - ay);
    const dz = M.zOf(bl) - M.zOf(al);
    if (kind === 'elevator') {
      // lift: wait for it, ride (vertical only), no steps
      if (!o.inLift) for (let k = 0; k < o.liftWait; k++) { push(ax, ay, al, 'wait'); t += 1; }
      const dur = Math.max(3, Math.abs(dz) / (o.stress ? 1.4 : 1.0));
      for (let k = 0; k < dur; k++) { const f = k / dur; push(ax, ay, al + (bl - al) * f, 'lift'); t += 1; }
      o.inLift = true;
      continue;
    }
    o.inLift = false;
    const mode = kind === 'escalator' ? (o.walkEscalator ? 'stairs' : 'escalator') : kind === 'stairs' ? 'stairs' : 'walk';
    const v = mode === 'escalator' ? (o.stress ? 0.62 : 0.5) : mode === 'stairs' ? 0.6 : 1.3;
    const dist = Math.hypot(L, dz);
    const n = Math.max(1, Math.ceil(dist / v / 0.25));
    for (let k = 0; k < n; k++) {
      const f = k / n;
      push(ax + (bx - ax) * f, ay + (by - ay) * f, al + (bl - al) * f, mode);
      t += dist / v / n;
    }
  }
  const last = pts[pts.length - 1];
  push(last[0], last[1], last[2], 'walk');
  return out;
}
// where a route starts, as a prior ("you got off at platform 7")
const startOf = (route: StationRouteResult, r = 40) => { const [x, y, level] = route.points[0]; return { level: M.levelId(M.floorOf(level)), x, y, r }; };

// ------------------------------------------------------------------------------------------- sensor model
/** A walk and what the phone has on it. */
interface SimScenario {
  id: string;
  name: string;
  from: StationRouteEndpoint;
  to: StationRouteEndpoint;
  routeOpts?: StationRoutePrefs;
  /** What the filter starts from: the start of the route, a given place, or nothing. */
  prior?: 'start' | IndoorPrior;
  gps?: boolean;
  baro?: boolean;
  /** The phone is in a pocket: no heading. */
  pocket?: boolean;
  magnetic?: boolean;
  rawCompass?: boolean;
  /** Seconds at which a train pushes air through the station. */
  piston?: number[];
  drift?: boolean;
  hvac?: boolean;
  stress?: boolean;
  walkEscalator?: boolean;
  /** Signs read on the way. at: the share of the walk (0..1); text: what it says, or 'sector' / 'nearest' for what is in sight. */
  signs?: { at: number; text: string }[];
  particles?: number;
}
/** What the phone's sensors give on a walk. */
type SimEvent =
  | { t: number; type: 'step'; length: number; heading: number | null; headingSigma: number | null }
  | { t: number; type: 'tick' }
  | { t: number; type: 'pressure'; hPa: number }
  | { t: number; type: 'gps'; lon: number; lat: number; acc: number }
  | { t: number; type: 'sign'; text: string };
function sensors(tl: SimWalkPoint[], sc: SimScenario, R: IndoorRandom) {
  const ev: SimEvent[] = [];
  const magBias = 12 * R.gauss();              // the compass is off by a constant amount (phone, building)
  const scale = 1 + 0.08 * R.gauss();          // this person's steps vs the assumed length
  let stepAcc = 0, lastT = 0, lp = 0;
  const p0 = 965 + 3 * R.gauss();
  const phoneBias = 0.4 * R.gauss();           // absolute offset of this phone's barometer (hPa)
  // --stress: the model's level heights are off by up to ±1 m (the true floors are not where the model says)
  const levelErr = M.levels.map(() => (sc.stress ? (R() * 2 - 1) : 0));
  for (let i = 1; i < tl.length; i++) {
    const a = tl[i - 1], b = tl[i];
    const dt = b.t - a.t;
    const moving = b.mode === 'walk' || b.mode === 'stairs';
    if (moving) {
      stepAcc += Math.hypot(b.x - a.x, b.y - a.y, (b.z - a.z) * 0.3);
      while (stepAcc > 0.7 * scale) {
        stepAcc -= 0.7 * scale;
        if (sc.stress && R() < 0.05) continue;                       // a step the phone missed
        let heading = (Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI + 360) % 360;
        // magnetic disturbance near trains / steel: the compass swings for a while. The phone's heading is carried
        // by the gyro and only pulled slowly towards the compass (Sensors in indoorloc.ts), so a disturbance
        // arrives low-passed (~30 s); with --raw-compass it arrives as is (worst case).
        const disturbed = sc.magnetic && Math.sin(b.t / 23) > 0.7;
        const dist = disturbed ? 60 * Math.sin(b.t / 3) : 0;
        lp += (dist - lp) * (sc.rawCompass ? 1 : Math.min(1, dt / 30 * 4));
        heading += magBias + lp + (sc.rawCompass ? 10 : 5) * R.gauss();
        // --stress: near steel structures the compass is off by 25° for a minute at a time (not zero-mean)
        if (sc.stress && Math.floor(b.t / 60) % 2 === 1) heading += 25;
        ev.push({ t: b.t, type: 'step', length: 0.7, heading: sc.pocket ? null : (heading + 360) % 360, headingSigma: sc.pocket ? null : 30 });
        if (sc.stress && R() < 0.05) ev.push({ t: b.t + 0.2, type: 'step', length: 0.7, heading: sc.pocket ? null : (heading + 360) % 360, headingSigma: 30 }); // phantom
      }
    }
    // once a second: tick, pressure, GPS
    if (Math.floor(b.t) > Math.floor(lastT)) {
      const t = Math.floor(b.t);
      ev.push({ t, type: 'tick' });
      if (sc.baro) {
        let hPa = p0 + phoneBias - (b.z + levelErr[b.li]) / 8.78 + 0.03 * R.gauss();
        hPa += sc.drift ? 0.5 * t / 3600 : 0;                        // weather: +0.5 hPa per hour
        if (sc.hvac && t > tl[tl.length - 1].t * 0.4) hPa += 0.15;   // a door / ventilation step
        if (sc.piston) {                                             // trains arriving underground
          for (const t0 of sc.piston) if (t >= t0 && t < t0 + 25) hPa += 2.5 * Math.sin(Math.PI * (t - t0) / 25);
        }
        ev.push({ t, type: 'pressure', hPa });
      }
      if (sc.gps) {
        const outdoor = Math.abs(b.z) < 1 && !M.nearEdges(b.x, b.y, b.li, 8).some((c) => M.ef[c.e] & 1);
        const deep = b.z < -4;
        if (!deep && (outdoor || R() < 0.3)) {
          let acc = outdoor ? 6 + 4 * R() : 25 + 30 * R();
          let ex = acc * 0.7 * R.gauss() + (outdoor ? 0 : 15), ey = acc * 0.7 * R.gauss();
          // --stress: indoors, now and then a multipath fix that claims 12 m but is 60 m off
          if (sc.stress && !outdoor && R() < 0.1) { acc = 12; ex = 60 * Math.cos(t); ey = 60 * Math.sin(t); }
          const [lon, lat] = M.toLngLat(b.x + ex, b.y + ey);
          ev.push({ t, type: 'gps', lon, lat, acc });
        }
      }
      lastT = b.t;
    }
  }
  for (const s of sc.signs || []) {
    const idx = Math.min(tl.length - 1, Math.floor(tl.length * s.at));
    const p = tl[idx];
    let text = s.text;
    if (text === 'sector') {
      // the sector sign in sight (same floor, ≤ 30 m): "Gleis 7 Sektor C"
      const near = M.landmarks.filter((l) => l.li === p.li && l.kind === 'sector').map((l): [number, IndoorLandmark] => [Math.hypot(l.x - p.x, l.y - p.y), l]).filter(([d]) => d < 60).sort((u, v) => u[0] - v[0]);
      if (!near.length) continue;
      const [ref, letters] = near[0][1].text.split(':');
      // --stress: OCR misreads the letter (the neighbouring sector) one time in three
      const letter = sc.stress && R() < 0.33 ? String.fromCharCode(((letters[0] || 'A').charCodeAt(0) - 64) % 6 + 65) : (letters[0] || '');
      text = `Gleis ${ref} Sektor ${letter}`;
    } else if (text === 'nearest') {
      // whatever named thing is in sight from the true position (same floor, ≤ 30 m)
      const near = M.landmarks.filter((l) => l.li === p.li && l.text && ['passage', 'shop', 'amenity', 'exit'].includes(l.kind))
        .map((l): [number, IndoorLandmark] => [Math.hypot(l.x - p.x, l.y - p.y), l]).filter(([d]) => d < 30).sort((u, v) => u[0] - v[0]);
      if (!near.length) continue;
      text = near[0][1].text;
    }
    ev.push({ t: p.t, type: 'sign', text });
  }
  return ev.sort((a, b) => a.t - b.t);
}

// ------------------------------------------------------------------------------------------- one run
/** The score of one run. The last four are set when the walk is over (_lastTrace: by --trace). */
interface SimRunStats {
  n: number; floorOk: number; wrongConfident: number; err: number[]; endErr: number | null; endFloorOk: boolean; ms: number;
  nAll: number; floorOkAll: number; lag: number[];
  endConfident?: boolean; duration?: number; legs?: string; _lastTrace?: number;
}
function run(sc: SimScenario, seed: number) {
  const R = I.rng(seed * 7919 + 13);
  const route = SR.route(RAW, sc.from, sc.to, Object.assign({ date: '2026-11-21' }, sc.routeOpts || {}));
  if (!route) return null;
  const tl = timeline(route, { liftWait: 15, walkEscalator: sc.walkEscalator, stress: sc.stress });
  const ev = sensors(tl, sc, R);
  const f = new I.Filter(M, { particles: sc.particles || 1500, seed });
  if (sc.prior) f.prior(sc.prior === 'start' ? startOf(route) : sc.prior);
  else if (!sc.gps) f.init({});
  let k = 0;
  const changes = tl.filter((p, i) => i && tl[i - 1].li !== p.li).map((p) => p.t);
  const stats: SimRunStats = { n: 0, floorOk: 0, wrongConfident: 0, err: [], endErr: null, endFloorOk: false, ms: 0, nAll: 0, floorOkAll: 0, lag: [] };
  let pending: { t: number; li: number } | null = null; // a true floor change the estimate has not followed yet: { t, li }
  const t0 = Date.now();
  for (const p of tl) {
    while (k < ev.length && ev[k].t <= p.t) {
      const e = ev[k++];
      if (e.type === 'step') f.step(e);
      else if (e.type === 'tick') f.tick(e.t);
      else if (e.type === 'pressure') f.pressure(e);
      else if (e.type === 'gps') f.gps(e);
      else if (e.type === 'sign') { const mr = S.match(e.text, M); if (TRACE && seed === +arg('traceseed', 1)) console.log(`    sign at t=${e.t.toFixed(0)}: "${e.text}" → ${mr.explain} (${mr.candidates.length} places, strength ${mr.strength.toFixed(2)})`); S.apply(f, mr, e.t); }
    }
    if (!f.initialised) continue;
    const est = f.estimate() as IndoorEstimateTracking;
    if (TRACE && seed === +arg('traceseed', 1) && Math.floor(p.t / 10) !== Math.floor((p._prev || -10) / 10) && Math.floor(p.t) % 10 === 0 && p.t - (stats._lastTrace ?? -99) >= 10) {
      stats._lastTrace = p.t;
      const lp = Object.entries(est.levelProbs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l, v]) => `${l}:${v.toFixed(2)}`).join(' ');
      const kinds: Partial<Record<StationEdgeKind, number>> = {}; for (let q = 0; q < f.N; q += 10) { const kk = I.KIND[M.ek[f.e[q]]]; kinds[kk] = (kinds[kk] || 0) + 1; }
      if (flag("kinds")) { let mx = 0, mi = 0, ss = 0; for (let q = 0; q < f.N; q++) { ss += f.w[q]; if (f.w[q] > mx) { mx = f.w[q]; mi = q; } } const pp = M.at(f.e[mi], f.s[mi]); console.log("      wmax", mx.toExponential(2), "sum", ss.toFixed(3), "ess", (f.ess || 0).toFixed(0), "top at", pp.x.toFixed(0), pp.y.toFixed(0), "edge kind", I.KIND[M.ek[f.e[mi]]], "bo", f.bo[mi].toFixed(1)); }
      if (flag("kinds")) console.log("      particles on", JSON.stringify(kinds), "e0", f.e[0], "s", f.s[0].toFixed(2), "len", M.elen[f.e[0]].toFixed(2), "d", f.d[0], "out", JSON.stringify(M.out[M.eb[f.e[0]]].map(([e, d]) => [I.KIND[M.ek[e]], d])), JSON.stringify(M.out[M.ea[f.e[0]]].map(([e, d]) => [I.KIND[M.ek[e]], d])));
      console.log(`    t=${p.t.toFixed(0).padStart(3)} ${p.mode.padEnd(9)} true L${M.levelId(p.li)} (${p.x.toFixed(0)},${p.y.toFixed(0)})  est L${est.level} (${est.x.toFixed(0)},${est.y.toFixed(0)}) err ${Math.hypot(est.x - p.x, est.y - p.y).toFixed(0)}m σ${est.sigma.toFixed(0)} [${lp}]${est.confident ? ' conf' : ''} ${JSON.stringify(est.evidence)}`);
    }
    // every moment counts here; the main score below leaves out a few seconds around each real floor change
    stats.nAll++;
    if (est.li === p.li) stats.floorOkAll++;
    if (changes.some((c) => Math.abs(c - p.t) < 0.13)) pending = { t: p.t, li: p.li };
    if (pending && est.li === pending.li) { stats.lag.push(p.t - pending.t); pending = null; }
    else if (pending && p.li !== pending.li) pending = null;
    if (changes.some((c) => Math.abs(c - p.t) < 6)) continue;
    stats.n++;
    const ok = est.li === p.li;
    if (ok) { stats.floorOk++; stats.err.push(Math.hypot(est.x - p.x, est.y - p.y)); }
    if (!ok && est.confident) stats.wrongConfident++;
  }
  stats.ms = Date.now() - t0;
  if (arg('export') && seed === 1) {
    // a Recorder-format log (indoorloc.ts) with the true position as checkpoints every 5 s
    const events = ev.map((e): IndoorLogEvent => {
      const d: Partial<SimEvent> = Object.assign({}, e); delete d.t; delete d.type;
      return [+e.t.toFixed(2), e.type, d] as IndoorLogEvent;
    });
    for (const p of tl) if (Math.abs(p.t - Math.round(p.t / 5) * 5) < 0.13) events.push([+p.t.toFixed(2), 'truth', { x: +p.x.toFixed(2), y: +p.y.toFixed(2), level: M.levelId(p.li), mode: p.mode }]);
    events.sort((a, b) => a[0] - b[0]);
    const prior = sc.prior === 'start' ? startOf(route) : sc.prior || null;
    fs.writeFileSync(arg('export')!, JSON.stringify({ meta: { v: 1, key: KEY, scenario: sc.id, name: sc.name, simulated: true, prior }, events } satisfies IndoorLog));
    console.log(`  wrote ${arg('export')} (${events.length} events)`);
  }
  const est = f.estimate() as IndoorEstimateTracking, end = tl[tl.length - 1];
  stats.endFloorOk = est.li === end.li;
  stats.endErr = Math.hypot(est.x - end.x, est.y - end.y);
  stats.endConfident = est.confident;
  stats.duration = end.t;
  stats.legs = route.steps.filter((st) => st.kind !== 'walk' && st.kind !== 'arrive').map((st) => `${st.kind} ${st.level}→${st.toLevel}`).join(', ');
  return stats;
}

// ------------------------------------------------------------------------------------------- scenarios
const street = { node: 17 };   // on Bahnhofplatz, 55 m in front of the main hall
const scenarios: SimScenario[] = KEY === 'bern' ? [
  { id: 'rbs-baro', name: 'Bahnhofplatz → RBS platform 21 (−2), barometer', from: street, to: P('21'), gps: true, baro: true },
  { id: 'rbs-nobaro', name: 'Bahnhofplatz → RBS platform 21 (−2), browser only (no barometer)', from: street, to: P('21'), gps: true },
  { id: 'rbs-sign', name: 'Same, no barometer, reads one name in sight halfway', from: street, to: P('21'), gps: true, signs: [{ at: 0.5, text: 'nearest' }] },
  { id: 'p7-baro', name: 'Bahnhofplatz → platform 7 via the underpass, barometer', from: street, to: P('7'), gps: true, baro: true },
  { id: 'p7-nobaro', name: 'Bahnhofplatz → platform 7 via the underpass, no barometer', from: street, to: P('7'), gps: true },
  { id: 'lift-baro', name: 'Bahnhofplatz → 21 step-free (lifts), barometer', from: street, to: P('21'), routeOpts: { stepFree: true }, gps: true, baro: true },
  { id: 'lift-nobaro', name: 'Bahnhofplatz → 21 step-free (lifts), no barometer', from: street, to: P('21'), routeOpts: { stepFree: true }, gps: true },
  { id: 'change-baro', name: 'Platform 7 → 21, journey prior, barometer, trains, drift, ventilation', from: P('7'), to: P('21'), prior: 'start', baro: true, piston: [20, 90], drift: true, hvac: true },
  { id: 'change-nobaro', name: 'Platform 7 → 21, journey prior, no barometer', from: P('7'), to: P('21'), prior: 'start' },
  { id: 'bus-baro', name: 'Platform 21 (−2) → bus terminal on the Welle, barometer', from: P('21'), to: { stop: { uic: '8507785', ref: 'U' } }, prior: 'start', baro: true },
  { id: 'bus-nobaro', name: 'Platform 21 (−2) → bus terminal on the Welle, no barometer', from: P('21'), to: { stop: { uic: '8507785', ref: 'U' } }, prior: 'start' },
  { id: 'lost-sign', name: 'Lost (no GPS, no prior) → reads the sector sign in sight, later two names in sight', from: { stop: { uic, ref: '7', sector: 'C' } }, to: P('21'), signs: [{ at: 0.01, text: 'sector' }, { at: 0.4, text: 'nearest' }, { at: 0.7, text: 'nearest' }] },
  { id: 'pocket', name: 'Phone in pocket (no heading), Bahnhofplatz → 21, barometer', from: street, to: P('21'), gps: true, baro: true, pocket: true },
  { id: 'magnetic', name: 'Bahnhofplatz → 21, strong magnetic disturbance (gyro-fused heading), no barometer', from: street, to: P('21'), gps: true, magnetic: true },
  { id: 'rawcompass', name: 'Same, compass only (no gyro fusion): worst case', from: street, to: P('21'), gps: true, magnetic: true, rawCompass: true },
  // stress: everything a bit off at once (speeds, level heights ±1 m, 25° compass offsets for a minute, 5 % missed and
  // 5 % phantom steps, 10 % overconfident indoor GPS outliers, sector letters misread one time in three)
  { id: 'stress-baro', name: 'Stress: Bahnhofplatz → 21 step-free, barometer', from: street, to: P('21'), routeOpts: { stepFree: true }, gps: true, baro: true, stress: true },
  { id: 'stress-nobaro', name: 'Stress: Bahnhofplatz → 21, no barometer', from: street, to: P('21'), gps: true, stress: true },
  { id: 'stress-sign', name: 'Stress: lost, reads a sector sign (maybe misread), platform 7 → 21, barometer', from: { stop: { uic, ref: '7', sector: 'C' } }, to: P('21'), baro: true, stress: true, signs: [{ at: 0.01, text: 'sector' }, { at: 0.5, text: 'nearest' }] },
] : [
  { id: 'generic-baro', name: `${M.name}: first → last stop, barometer`, from: { node: RAW.stops[0].node }, to: { node: RAW.stops[RAW.stops.length - 1].node }, prior: 'start', baro: true },
  { id: 'generic-nobaro', name: `${M.name}: first → last stop, no barometer`, from: { node: RAW.stops[0].node }, to: { node: RAW.stops[RAW.stops.length - 1].node }, prior: 'start' },
];

const pct = (a: number[], q: number) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
console.log(`${M.name}: ${M.n} nodes, ${M.ne} edges, levels ${M.levels.map((l) => l.id).join(' ')}; ${SEEDS} seeds per scenario\n`);
console.log('scenario'.padEnd(13), 'floor ok'.padStart(8), 'all'.padStart(5), 'lag'.padStart(5), 'conf.wrong'.padStart(10), 'err50'.padStart(6), 'err90'.padStart(6), 'end floor'.padStart(9), 'end err'.padStart(8), '  ms/run');
/** A scenario's line of the table. */
interface SimSummaryRow {
  id: string; name: string; floor: number; floorAll: number; lag50: number; wrongConfident: number; err50: number; err90: number;
  endFloor: number; endErr: number; duration?: number; legs?: string; ms: number; noRoute?: undefined;
}
const summary: (SimSummaryRow | { id: string; noRoute: true })[] = [];
for (const sc of scenarios) {
  if (ONLY && !sc.id.includes(ONLY)) continue;
  const rs: SimRunStats[] = [];
  for (let s = 1; s <= SEEDS; s++) { const r = run(sc, s); if (r) rs.push(r); }
  if (!rs.length) { console.log(sc.id.padEnd(13), 'no route'); summary.push({ id: sc.id, noRoute: true }); continue; }
  const floor = rs.reduce((a, r) => a + r.floorOk / r.n, 0) / rs.length;
  const wc = rs.reduce((a, r) => a + r.wrongConfident / r.n, 0) / rs.length;
  const errs = rs.flatMap((r) => r.err);
  const endFloor = rs.filter((r) => r.endFloorOk).length / rs.length;
  const endErr = pct(rs.map((r) => r.endErr!), 0.5);
  const ms = rs.reduce((a, r) => a + r.ms, 0) / rs.length;
  const floorAll = rs.reduce((a, r) => a + r.floorOkAll / r.nAll, 0) / rs.length;
  const lags = rs.flatMap((r) => r.lag);
  const row = { id: sc.id, name: sc.name, floor, floorAll, lag50: pct(lags, 0.5), wrongConfident: wc, err50: pct(errs, 0.5), err90: pct(errs, 0.9), endFloor, endErr, duration: rs[0].duration, legs: rs[0].legs, ms };
  summary.push(row);
  console.log(sc.id.padEnd(13), (100 * floor).toFixed(0).padStart(7) + '%', ((100 * floorAll).toFixed(0) + '%').padStart(5),
    (isFinite(row.lag50) ? row.lag50.toFixed(0) + 's' : '—').padStart(5), (100 * wc).toFixed(1).padStart(9) + '%', row.err50.toFixed(1).padStart(6), row.err90.toFixed(1).padStart(6),
    (100 * endFloor).toFixed(0).padStart(8) + '%', endErr.toFixed(1).padStart(8), ms.toFixed(0).padStart(8));
  if (VERBOSE) console.log('   ', sc.name, '|', rs[0].legs, '|', rs[0].duration!.toFixed(0) + ' s');
}
console.log('\nfloor ok: share of time on the right floor, leaving out 6 s around each real floor change · all: the whole walk');
console.log('lag: median seconds from a real floor change until the estimate follows · conf.wrong: share of time confident AND on the wrong floor');
console.log('Steps and headings come from the route geometry with modelled noise, not through the phone adapter (Sensors): replay real');
console.log('recordings (--replay) to test that part.');
console.log('err50/err90: position error (m) while on the right floor · end: at the destination · ms/run: filter time for the whole walk');
if (arg('json')) fs.writeFileSync(arg('json')!, JSON.stringify(summary, null, 1));
// --check: fail (exit 1) when a scenario falls below what it reached when the filter was tuned (2026-11-21, Bern,
// 8 seeds). The worst cases (pocket: no heading at all; raw compass) only have to keep the floor most of the time.
if (flag('check')) {
  const bad = [];
  for (const r of summary) {
    if (r.noRoute) { bad.push(`${r.id}: no route (the model or the router changed)`); continue; }
    const hard = r.id === 'pocket' || r.id === 'rawcompass' || r.id.startsWith('stress');
    if (!hard && r.floorAll < 0.85) bad.push(`${r.id}: right floor over the whole walk ${(100 * r.floorAll).toFixed(0)}%`);
    if (!hard && !(r.err90 <= 20)) bad.push(`${r.id}: 90 % position error ${r.err90.toFixed(1)} m`);
    if (!hard && !(r.endErr <= 5)) bad.push(`${r.id}: error at the destination ${r.endErr.toFixed(1)} m`);
    if (r.floor < (hard ? 0.65 : 0.9)) bad.push(`${r.id}: right floor ${(100 * r.floor).toFixed(0)}%`);
    if (r.wrongConfident > (hard ? 0.08 : 0.03)) bad.push(`${r.id}: confidently wrong ${(100 * r.wrongConfident).toFixed(1)}%`);
    if (!hard && r.endFloor < 0.85) bad.push(`${r.id}: right floor at the end in ${(100 * r.endFloor).toFixed(0)}% of runs`);
  }
  console.log(bad.length ? '\nCHECK FAILED\n  ' + bad.join('\n  ') : '\ncheck passed');
  process.exit(bad.length ? 1 : 0);
}
