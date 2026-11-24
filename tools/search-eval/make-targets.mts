// Picks the search evaluation's targets (targets.json): real things from data the search does not ask, so where the
// right answer lies is known. The stops and platforms of ATLAS (platforms.js), OpenStreetMap's amenities across
// Switzerland (data/ch/osm-*.json, toilets-ch.json). Subagents then write the queries people would type for each
// (queries/*.jsonl), and build-cases.mts makes cases.json from the two. Seeded: the same data gives the same targets.
//   node tools/search-eval/make-targets.mts [--batches 10]   (also writes the subagents' batches to --out <dir>)
// See tools/search-eval/README.md.
import fs from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('../../', import.meta.url);
const SEED = 20261124;
const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

/** One target: what the subagents are told about it, and where a right answer lies. */
export interface Target {
  /** 'T001' */
  id: string;
  type: 'stop' | 'station' | 'platform' | 'address' | 'place' | 'category' | 'town' | 'postcode';
  /** What the query writers know: its name, the town, the kind, the language spoken there. */
  facts: Record<string, string>;
  /** A right answer lies within `m` metres of one of these. */
  ll: LngLat[];
  m: number;
  /** Where the map is for a query that only makes sense on the spot ("Zytglogge", "closest pharmacy")… */
  near: LngLat;
  /** …and for one that says where ("Bern, Zytglogge"): in another town. */
  far: LngLat;
  /** Where the answer comes from: 'ATLAS 8507000', 'osm node/123'. */
  src: string;
}

// ---- seeded randomness, geometry ----
let seed = SEED;
const rand = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rand() * a.length)];
export const distM = (a: LngLat, b: LngLat) => {
  const r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLng = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
};
const r5 = (p: LngLat): LngLat => [+p[0].toFixed(5), +p[1].toFixed(5)];
/** A point somewhere between `minM` and `maxM` metres from `p`. */
const around = (p: LngLat, maxM: number, minM = 0): LngLat => {
  const d = minM + Math.sqrt(rand()) * (maxM - minM), a = rand() * 2 * Math.PI;
  return r5([p[0] + (d * Math.cos(a)) / (111195 * Math.cos((p[1] * Math.PI) / 180)), p[1] + (d * Math.sin(a)) / 111195]);
};

// ---- the data ----
const sandbox: { window: { PLATFORM_DATA?: PlatformData } } = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL('platforms.js', ROOT), 'utf8'), sandbox);
const STOPS = Object.entries(sandbox.window.PLATFORM_DATA!.stops).map(([uic, [name, mode, edges]]) => {
  const pts = edges.map(([x, y, ref]) => ({ ll: [x / 1e5, y / 1e5] as LngLat, ref: ref ? String(ref) : '' }));
  const c: LngLat = [pts.reduce((s, p) => s + p.ll[0], 0) / pts.length, pts.reduce((s, p) => s + p.ll[1], 0) / pts.length];
  return { uic, name, mode, edges: pts, ll: r5(c) };
});
type Stop = typeof STOPS[number];
const stopByName = new Map(STOPS.map((s) => [s.name, s]));
interface OsmRow { id: string; lat: number; lon: number; name: string | null; address: string | null; postcode: string | null; city: string | null }
const readItems = (file: string): OsmRow[] => JSON.parse(fs.readFileSync(new URL(file, ROOT), 'utf8')).items;
const KINDS: Record<string, OsmRow[]> = {};
for (const f of fs.readdirSync(new URL('data/ch/', ROOT)).filter((f) => /^osm-.*\.json$/.test(f))) KINDS[f.slice(4, -5)] = readItems(`data/ch/${f}`);
KINDS.toilets = readItems('data/ch/toilets-ch.json');
const ALL = Object.values(KINDS).flat();

// The towns the map can be in, at their main station, and the language spoken there
const TOWNS: [station: string, lang: string][] = [
  ['Bern', 'de'], ['Zürich HB', 'de'], ['Basel SBB', 'de'], ['Genève', 'fr'], ['Lausanne', 'fr'], ['Luzern', 'de'], ['St. Gallen', 'de'],
  ['Lugano', 'it'], ['Winterthur', 'de'], ['Biel/Bienne', 'de'], ['Thun', 'de'], ['Fribourg/Freiburg', 'fr'], ['Chur', 'de'], ['Sion', 'fr'],
  ['Neuchâtel', 'fr'], ['Schaffhausen', 'de'], ['Zug', 'de'], ['Aarau', 'de'], ['Olten', 'de'], ['Solothurn', 'de'], ['Bellinzona', 'it'],
  ['Interlaken Ost', 'de'], ['Montreux', 'fr'], ['Yverdon-les-Bains', 'fr'], ['Baden', 'de'], ['Burgdorf', 'de'], ['La Chaux-de-Fonds', 'fr'],
  ['Uster', 'de'], ['Wil SG', 'de'], ['Locarno', 'it'], ['Vevey', 'fr'], ['Brig', 'de'], ['Rapperswil SG', 'de'], ['Frauenfeld', 'de'],
];
const ANCHORS = TOWNS.flatMap(([name, lang]) => { const s = stopByName.get(name); return s ? [{ name, lang, ll: s.ll }] : []; });
const nearestAnchor = (p: LngLat) => ANCHORS.reduce((a, b) => (distM(a.ll, p) <= distM(b.ll, p) ? a : b));
const langAt = (p: LngLat) => { const a = nearestAnchor(p); return distM(a.ll, p) < 40000 ? a.lang : 'de'; };
const farFrom = (p: LngLat): LngLat => around(pick(ANCHORS.filter((a) => distM(a.ll, p) > 30000)).ll, 1500);
/** Where a stop is: its town, the part of its name before the comma ("Bern, Zytglogge" → Bern). */
const townOf = (s: Stop) => (s.name.includes(',') ? s.name.split(',')[0].trim() : '');

const targets: Target[] = [];
function add(t: Omit<Target, 'id' | 'near' | 'far'> & { near?: LngLat; far?: LngLat }) {
  if (targets.some((x) => x.type === t.type && JSON.stringify(x.facts) === JSON.stringify(t.facts))) return false;
  const p = t.ll[0];
  targets.push({ id: `T${String(targets.length + 1).padStart(3, '0')}`, near: around(p, 1500, 150), far: farFrom(p), ...t, ll: t.ll.map(r5), m: Math.round(t.m) });
  return true;
}
const fill = (n: number, make: () => boolean) => { for (let made = 0, i = 0; made < n && i < n * 50; i++) if (make()) made++; };
const MODE: Record<string, string> = { t: 'train station', m: 'tram stop', b: 'bus stop', s: 'boat landing', c: 'cable car station' };
const RADIUS: Record<string, number> = { t: 250, m: 120, b: 120, s: 150, c: 150 };
const byMode = (m: string) => STOPS.filter((s) => s.mode === m && s.name.length >= 3);
const stopFacts = (s: Stop) => ({ name: s.name, kind: MODE[s.mode], ...(townOf(s) ? { town: townOf(s) } : {}), lang: langAt(s.ll) });

// ---- stops of every kind; most in towns (where people search for them), some anywhere ----
const inTown = (s: Stop) => distM(nearestAnchor(s.ll).ll, s.ll) < 8000;
for (const [mode, n] of [['b', 55], ['m', 40], ['t', 25], ['s', 10], ['c', 10]] as const) {
  fill(n, () => { const pool = byMode(mode).filter((s) => mode === 's' || mode === 'c' || rand() < 0.25 || inTown(s)); const s = pick(pool);
    return add({ type: 'stop', facts: stopFacts(s), ll: [s.ll, ...s.edges.map((e) => e.ll)], m: RADIUS[mode], src: `ATLAS ${s.uic}` }); });
}
// ---- stations as such ("Bahnhof Thun", "Zürich HB", "Geneva station"): the big ones and some small ----
for (const a of ANCHORS) { const s = stopByName.get(a.name)!; add({ type: 'station', facts: { name: s.name, kind: 'main train station of the town', lang: a.lang }, ll: [s.ll, ...s.edges.map((e) => e.ll)], m: 300, src: `ATLAS ${s.uic}` }); }
fill(10, () => { const s = pick(byMode('t').filter((x) => !x.name.includes(','))); return add({ type: 'station', facts: { name: s.name, kind: 'train station', lang: langAt(s.ll) }, ll: [s.ll, ...s.edges.map((e) => e.ll)], m: 300, src: `ATLAS ${s.uic}` }); });

// ---- platforms and stop edges, each far enough from the others of its stop to be told apart ----
fill(40, () => {
  const train = rand() < 0.55;
  const s = pick(train ? byMode('t').filter((x) => x.edges.length >= 3 && inTown(x)) : STOPS.filter((x) => (x.mode === 'b' || x.mode === 'm') && x.edges.length >= 2 && inTown(x)));
  const edges = s.edges.filter((e) => (train ? /^\d+$/.test(e.ref) : /^[A-Z]$/.test(e.ref))
    && s.edges.every((o) => o === e || o.ref === e.ref || distM(o.ll, e.ll) >= 25));
  if (!edges.length) return false;
  const e = pick(edges);
  const gap = Math.min(...s.edges.filter((o) => o.ref !== e.ref).map((o) => distM(o.ll, e.ll)));
  return add({ type: 'platform', facts: { stop: s.name, platform: e.ref, kind: train ? 'train platform (Gleis / voie / binario)' : 'bus or tram stop edge (Kante)', lang: langAt(s.ll) },
    ll: [e.ll], m: Math.max(15, Math.min(40, gap / 2)), src: `ATLAS ${s.uic} ${e.ref}` });
});

// ---- addresses ----
const ADDRS = ALL.filter((r) => r.address && r.city && r.postcode && /^\D.*\s\d{1,4}[a-zA-Z]?$/.test(r.address));
fill(60, () => { const r = pick(ADDRS); return add({ type: 'address', facts: { street_and_number: r.address!, postcode: r.postcode!, town: r.city!, lang: langAt([r.lon, r.lat]) }, ll: [[r.lon, r.lat]], m: 75, src: `osm ${r.id}` }); });

// ---- places by name: right when it is that one, or one of the same name nearer to the map's middle (a chain) ----
const NAMED_KINDS: Record<string, string> = { pharmacy: 'pharmacy', supermarket: 'supermarket', library: 'library', hospital: 'hospital', police: 'police station',
  post_office: 'post office', community_centre: 'community centre', clinic: 'clinic', social_facility: 'social facility' };
const key = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const NAMED = Object.keys(NAMED_KINDS).flatMap((k) => KINDS[k].filter((r) => r.name && r.name.length >= 4 && /\p{L}{3}/u.test(r.name) && r.city).map((r) => ({ ...r, kind: k })));
fill(60, () => {
  const r = pick(NAMED.filter((x) => rand() < 0.3 || distM(nearestAnchor([x.lon, x.lat]).ll, [x.lon, x.lat]) < 8000));
  const p: LngLat = [r.lon, r.lat];
  const near = around(p, 1500, 100);
  const twins = NAMED.filter((t) => key(t.name!) === key(r.name!) && (t.city === r.city || distM([t.lon, t.lat], near) <= distM(p, near)));
  return add({ type: 'place', facts: { name: r.name!, kind: NAMED_KINDS[r.kind], town: r.city!, ...(r.address ? { address: r.address } : {}), lang: langAt(p) },
    ll: twins.map((t) => [t.lon, t.lat] as LngLat), m: 100, near, src: `osm ${r.id}` });
});

// ---- kinds of place, asked for where you are: right when it is one of the ten nearest of that kind ----
const CATEGORY: Record<string, string> = { pharmacy: 'pharmacy', toilets: 'public toilet', atm: 'cash machine (ATM)', supermarket: 'supermarket', hospital: 'hospital',
  police: 'police station', post_office: 'post office', drinking_water: 'drinking water fountain', library: 'library', playground: 'playground', doctors: 'doctor (GP)',
  dentist: 'dentist', aed: 'defibrillator (AED)', shelter: 'shelter', social_facility: 'social services / help centre' };
fill(50, () => {
  const k = pick(Object.keys(CATEGORY));
  const a = pick(ANCHORS);
  const at = around(a.ll, 2500);
  const nearest = KINDS[k].map((r) => [r, distM([r.lon, r.lat], at)] as const).sort((x, y) => x[1] - y[1]).slice(0, 10);
  if (!nearest.length || nearest[0][1] > 4000) return false;
  return add({ type: 'category', facts: { kind: CATEGORY[k], town: a.name.replace(/ (HB|SBB|Ost)$/, ''), lang: a.lang }, ll: nearest.map(([r]) => [r.lon, r.lat] as LngLat), m: 60, near: at, far: at, src: `osm-${k}` });
});

// ---- towns and postcodes: right near the middle of their addresses ----
const groupBy = (f: (r: OsmRow) => string | null) => {
  const g = new Map<string, LngLat[]>();
  for (const r of ADDRS) { const k = f(r); if (k) g.set(k, [...(g.get(k) || []), [r.lon, r.lat]]); }
  return [...g].map(([k, pts]) => ({ k, n: pts.length, ll: [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length] as LngLat }));
};
fill(20, () => { const t = pick(groupBy((r) => r.city).filter((x) => x.n >= 15)); return add({ type: 'town', facts: { town: t.k, lang: langAt(t.ll) }, ll: [t.ll], m: 3000, src: `osm addresses (${t.n})` }); });
fill(10, () => { const t = pick(groupBy((r) => r.postcode).filter((x) => x.n >= 8)); return add({ type: 'postcode', facts: { postcode: t.k, lang: langAt(t.ll) }, ll: [t.ll], m: 2500, src: `osm addresses (${t.n})` }); });

fs.writeFileSync(new URL('targets.json', import.meta.url), '[\n' + targets.map((t) => JSON.stringify(t)).join(',\n') + '\n]\n');
const counts: Record<string, number> = {};
for (const t of targets) counts[t.type] = (counts[t.type] || 0) + 1;
console.log(`${targets.length} targets:`, counts);

// The subagents' batches: what each is told about its targets (no coordinates), spread over the kinds
const out = opt('--out');
if (out) {
  const n = Number(opt('--batches') || 10);
  fs.mkdirSync(out, { recursive: true });
  for (let b = 0; b < n; b++) {
    const mine = targets.filter((_, i) => i % n === b).map((t) => ({ id: t.id, type: t.type, ...t.facts }));
    fs.writeFileSync(`${out}/batch-${String(b + 1).padStart(2, '0')}.jsonl`, mine.map((t) => JSON.stringify(t)).join('\n') + '\n');
  }
  console.log(`${n} batches → ${out}`);
}
