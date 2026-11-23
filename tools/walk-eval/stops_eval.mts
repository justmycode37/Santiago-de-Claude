// Walks to stops: from a city's main station to every tram, bus and train stop edge (platforms.js) within 1.5 km,
// boarding from that edge's own platform or bay. Counts the walks the network finds no route for.
// usage: node stops_eval.mts CITY [--list]
import fs from 'node:fs'; import vm from 'node:vm'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { transformSync } from 'amaro'; // npm install
/** cities.json: where a city's walks start (its main station), and that station's UIC number. */
interface EvalCity { start: LngLat; uic: string }
// the page the router's script runs in: the globals handed to it, and the WALKROUTE it leaves there
interface RouterPage { [name: string]: unknown; globalThis?: RouterPage; WALKROUTE?: WalkRouteApi }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const city = process.argv[2];
const C: EvalCity = JSON.parse(fs.readFileSync(HERE + '/cities.json', 'utf8'))[city];
const ctx: RouterPage = { console, setTimeout, Promise, Math, JSON, Map, Set, Array, Object, Number, String, Infinity, isFinite };
ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(transformSync(fs.readFileSync(REPO + '/src/walkroute.ts', 'utf8'), { mode: 'strip-only' }).code, ctx); // the script as the browser gets it: types taken out
const W = ctx.WALKROUTE!;
W.configure({ loader: async (k: string) => { const s = fs.readFileSync(REPO + '/walkgraph/' + (k === 'index' ? 'index.js' : 't/' + k + '.js'), 'utf8');
  return k === 'index' ? JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)) : JSON.parse(s.slice(s.indexOf(',') + 1, s.lastIndexOf(')'))); } });
const pd = fs.readFileSync(REPO + '/platforms.js', 'utf8'); const PD: PlatformData = JSON.parse(pd.slice(pd.indexOf('{'), pd.lastIndexOf('}') + 1));
/** A stop edge near the main station: its stop, and what the walk to it is told about it. */
interface StopEdge { uic: string; name: string; ll: LngLat; ref: string; level: number }
const edges: StopEdge[] = [];
for (const [uic, st] of Object.entries(PD.stops)) for (const e of st[2] || []) {
  const ll: LngLat = [e[0] / 1e5, e[1] / 1e5];
  if (e[2] && W._debug.distM(ll, C.start) < 1500 && uic !== C.uic) edges.push({ uic, name: st[0], ll, ref: e[2], level: e[4] || 0 });
}
let none = 0; const fails: string[] = [];
for (const e of edges) {
  const r = await W.route(C.start, e.ll, { from: { accuracy: 10 }, to: { platform: true, ref: e.ref, level: e.level } });
  if (!r) { none++; fails.push(`${e.name} ${e.ref} ${e.ll.join(',')}`); }
}
console.log(JSON.stringify({ city, stopEdges: edges.length, noRoute: none }));
if (process.argv.includes('--list')) console.log(fails.join('\n'));
