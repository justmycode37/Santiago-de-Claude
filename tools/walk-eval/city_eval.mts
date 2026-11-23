// The Bern measurements for any built city: doors reached, metres through buildings following no mapped way, route
// length against OSRM (from the main station to ~70 Photon places), and platform pairs crossing ground-level tracks.
// usage: node city_eval.mts CITY
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
/** cities.json: where a city's walks start (its main station), and that station's UIC number. */
interface EvalCity { start: LngLat; uic: string }
/** dests_CITY.json (city_dests.py): the places walked to. */
interface EvalDest { name: string; ll: LngLat }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const city = process.argv[2];
const C: EvalCity = JSON.parse(fs.readFileSync(HERE + '/cities.json', 'utf8'))[city];
const dests: EvalDest[] = JSON.parse(fs.readFileSync(`${HERE}/dests_${city}.json`, 'utf8')).results;
// the router as the page has it (a specifier TypeScript does not follow: it is checked with the page's modules)
type Router = typeof import('../../src/walkroute.ts').WALKROUTE;
const W: Router = (await import(new URL('../../src/walkroute.ts', import.meta.url).href)).WALKROUTE;
W.configure({ loader: async (k: string) => { const s = fs.readFileSync(REPO + '/walkgraph/' + (k === 'index' ? 'index.js' : 't/' + k + '.js'), 'utf8');
  return k === 'index' ? JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)) : JSON.parse(s.slice(s.indexOf(',') + 1, s.lastIndexOf(')'))); } });
const { buildings, nodes, distM } = W._debug;
const START = C.start;
const inside = (p: LngLat, ring: LngLat[]) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [x1, y1] = ring[i], [x2, y2] = ring[j];
  if ((y1 > p[1]) !== (y2 > p[1]) && p[0] < (x2 - x1) * (p[1] - y1) / (y2 - y1) + x1) c = !c; } return c; };
const bldAt = (p: LngLat) => [...buildings.values()].filter((b) => p[0] >= b.bb[0] && p[0] <= b.bb[2] && p[1] >= b.bb[1] && p[1] <= b.bb[3] && inside(p, b.ring));
/** The mapped stretches of the network (not the lines across areas), and the network they were taken from. */
interface MappedSegs extends Array<[LngLat, LngLat]> { n?: string }
let mapped: MappedSegs | null = null;
const graphKey = () => [...W._debug.inGraph].sort().join() + '|' + nodes.size; // the network is rebuilt per area
const mappedSegs = () => { if (mapped && mapped.n === graphKey()) return mapped; mapped = []; mapped.n = graphKey(); const seen = new Set<WalkNetEdge>();
  nodes.forEach((n) => n.adj.forEach((e) => { if (e.attr.k !== 'ar' && !seen.has(e)) { seen.add(e); mapped!.push([e.a.ll, e.b.ll]); } })); return mapped; };
const nearMapped = (p: LngLat) => { const k = 111320 * Math.cos(p[1] * Math.PI / 180);
  for (const [a, b] of mappedSegs()) { // only segments whose box comes within ~40 m of p (a long one may pass by p)
    if (Math.min(a[0], b[0]) > p[0] + 0.0005 || Math.max(a[0], b[0]) < p[0] - 0.0005 || Math.min(a[1], b[1]) > p[1] + 0.0004 || Math.max(a[1], b[1]) < p[1] - 0.0004) continue;
    const ax = (a[0] - p[0]) * k, ay = (a[1] - p[1]) * 110540, dx = (b[0] - a[0]) * k, dy = (b[1] - a[1]) * 110540;
    const L2 = dx * dx + dy * dy, t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0; if (Math.hypot(ax + dx * t, ay + dy * t) < 3) return true; } return false; };
const badMetres = (line: LngLat[], dest: LngLat) => { const own = new Set(bldAt(dest).concat(bldAt(START))); let bad = 0;
  for (let i = 1; i < line.length; i++) { const a = line[i - 1], b = line[i], L = distM(a, b), n = Math.max(1, Math.round(L));
    for (let j = 0; j < n; j++) { const t = (j + .5) / n, p: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (bldAt(p).some((x) => !own.has(x)) && !nearMapped(p)) bad += L / n; } } return bad; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const med = (xs: (number | null)[]) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const mean = (xs: (number | null)[]) => { const v = xs.filter((x) => x != null); return v.length ? +(v.reduce((t, x) => t + x, 0) / v.length).toFixed(1) : null; };

// OSRM's answers are kept in osrm_CITY.json: the server is slow at times, and a rerun compares against the same routes
/** OSRM's answer to a route request: code 'Ok' and the routes, or another code and none. */
interface OsrmAnswer { code: string; routes?: { geometry: { coordinates: LngLat[] }; distance: number }[] }
const OSRM_FILE = `${HERE}/osrm_${city}.json`;
const osrmCache: Record<string, OsrmAnswer> = fs.existsSync(OSRM_FILE) ? JSON.parse(fs.readFileSync(OSRM_FILE, 'utf8')) : {};
async function osrm(ll: LngLat): Promise<OsrmAnswer | null> {
  const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${START.join(',')};${ll.join(',')}?overview=full&geometries=geojson`;
  if (osrmCache[url]) return osrmCache[url];
  for (let i = 0; i < 4; i++) {
    const o = await fetch(url, { signal: AbortSignal.timeout(45000) }).then((x) => x.json() as Promise<OsrmAnswer>).catch(() => null);
    await sleep(400 + i * 2000);
    if (o && o.code) { osrmCache[url] = o; fs.writeFileSync(OSRM_FILE, JSON.stringify(osrmCache)); return o; }
  }
  return null;
}

// ---- doors, buildings, length
/** One destination: the walk the network gives to it, and OSRM's. */
interface EvalRow {
  name: string; hasDoors: boolean; osmDoors: boolean; net: boolean; ms: number;
  offPathEnd: boolean; swisstopoM: number;
  doorOwn: boolean; doorType: string | null; inStationOrIndoor: boolean;
  netBad: number | null; osrmBad: number | null;
  netLen: number | null; osrmLen: number | null;
  osrmLenRaw: number | null;
}
const rows: EvalRow[] = [];
for (const d of dests) {
  const t0 = performance.now();
  const net = await W.route(START, d.ll, { from: { accuracy: 10 }, to: {} });
  const ms = performance.now() - t0;
  const o = await osrm(d.ll);
  const og = o && o.code === 'Ok' ? [START, ...o.routes![0].geometry.coordinates, d.ll] : null;
  const doors = bldAt(d.ll).flatMap((b) => b.entrances);
  const reached = net && net.door && doors.find((x) => x.node.ll === net.door!.ll);
  rows.push({ name: d.name, hasDoors: doors.length > 0, osmDoors: doors.some((x) => x.type !== 'addr'), net: !!net, ms,
    // the last bit, from the paths to the place (or its door), is a straight line over 20 m of ground no path crosses
    offPathEnd: !!(net && net.approxFrom != null), swisstopoM: net ? net.swisstopo : 0,
    doorOwn: !!reached, doorType: reached ? reached.type : null, inStationOrIndoor: !!(net && !net.door && doors.length),
    netBad: net ? badMetres(net.coords, d.ll) : null, osrmBad: og ? badMetres(og, d.ll) : null,
    // OSRM's distance leaves out the straight bits from the start and to the place (it snaps both to its streets): the
    // line the app draws has them, so they count here
    netLen: net && net.dist, osrmLen: og ? Math.round(og.reduce((t, c, i) => (i ? t + distM(og[i - 1], c) : 0), 0)) : null,
    osrmLenRaw: o && o.routes && o.routes[0] ? Math.round(o.routes[0].distance) : null });
}
const n = rows.length, cnt = (f: (r: EvalRow) => boolean) => rows.filter(f).length, wd = rows.filter((r) => r.hasDoors);
const both = rows.filter((r) => r.netLen != null && r.osrmLen != null);
// ---- platform pairs at the main station
/** A platform edge of the main station, and a railway line of rails_CITY.json (Overpass: ways with their geometry). */
interface EvalEdge { ll: LngLat; ref?: string; level: number }
interface OverpassWay { tags: { railway: string; tunnel?: string; bridge?: string; layer?: string }; geometry: { lon: number; lat: number }[] }
const pd = fs.readFileSync(REPO + '/platforms.js', 'utf8'); const PD: PlatformData = JSON.parse(pd.slice(pd.indexOf('{'), pd.lastIndexOf('}') + 1));
const edges = (PD.stops[C.uic] ? PD.stops[C.uic][2] : []).map((e): EvalEdge => ({ ll: [e[0] / 1e5, e[1] / 1e5], ref: e[2], level: e[4] || 0 }));
const rails: LngLat[][] = JSON.parse(fs.readFileSync(`${HERE}/rails_${city}.json`, 'utf8')).elements
  .filter((w: OverpassWay) => /^(rail|light_rail|narrow_gauge)$/.test(w.tags.railway) && !w.tags.tunnel && !w.tags.bridge && !(+w.tags.layer!)).map((w: OverpassWay) => w.geometry.map((p) => [p.lon, p.lat]));
const cr = (p1: LngLat, p2: LngLat, q1: LngLat, q2: LngLat) => { const c = (o: LngLat, a: LngLat, b: LngLat) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); const d1 = c(q1, q2, p1), d2 = c(q1, q2, p2), d3 = c(p1, p2, q1), d4 = c(p1, p2, q2); return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)); };
let pairs = 0, none = 0, bad = 0; const ex: string[] = [];
for (const sf of [false, true]) for (const a of edges) for (const b of edges) {
  if (a === b || a.ref === b.ref) continue; pairs++;
  const r = await W.route(a.ll, b.ll, { stepFree: sf, from: { platform: true, level: a.level, ref: a.ref }, to: { platform: true, level: b.level, ref: b.ref } });
  if (!r) { none++; continue; }
  let x = 0; for (let i = 1; i < r.coords.length; i++) { const l = r.levels[i]; if (l != null && l !== '0') continue; for (const w of rails) for (let j = 1; j < w.length; j++) if (cr(r.coords[i - 1], r.coords[i], w[j - 1], w[j])) x++; }
  if (x) { bad++; if (ex.length < 4) ex.push(`${sf ? 'SF ' : ''}${a.ref}->${b.ref} ${r.dist} m`); }
}
const wo = rows.filter((r) => r.osmDoors);
const out = { city, destinations: n, routed: cnt((r) => r.net), withDoors: wd.length, doorReached: wd.filter((r) => r.doorOwn).length,
  withOsmDoors: wo.length, osmDoorReached: wo.filter((r) => r.doorOwn && r.doorType !== 'addr').length,
  registerDoorOnly: wd.length - wo.length, registerDoorReached: wd.filter((r) => !r.osmDoors && r.doorOwn).length,
  doorViaIndoor: wd.filter((r) => r.inStationOrIndoor).length,
  // per walk that has a route (a missing route is not a walk with 0 m through buildings)
  netBadMean: mean(rows.map((r) => r.netBad)), netBad3: cnt((r) => r.netBad! >= 3),
  osrmBadMean: mean(rows.map((r) => r.osrmBad)), osrmBad3: cnt((r) => r.osrmBad! >= 3),
  offPathEnd: cnt((r) => r.offPathEnd), withSwisstopo: cnt((r) => r.swisstopoM > 0),
  medianNet: med(both.map((r) => r.netLen)), medianOsrm: med(both.map((r) => r.osrmLen)),
  shorter: both.filter((r) => r.netLen! < r.osrmLen! * 0.95).length, longer: both.filter((r) => r.netLen! > r.osrmLen! * 1.05).length, compared: both.length,
  medianMs: Math.round(med(rows.map((r) => r.ms))), platforms: edges.length, pairs, pairsNoRoute: none, pairsCrossingTracks: bad, crossingExamples: ex };
fs.writeFileSync(`${HERE}/city_${city}.json`, JSON.stringify({ summary: out, rows }, null, 1));
console.log(JSON.stringify(out));
