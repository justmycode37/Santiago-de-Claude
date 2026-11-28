// The search evaluation: every case of cases.json (build-cases.mts) through the page's own search (search() in
// src/app/search-places.ts, with swisstopo and our own places (map-places/) as the page has them; Photon only with --photon) and
// through the Kante engine's /api/search on its own, scored by where the first right answer is in the list.
// The sources' answers are replayed from answers.json.gz, so a run is offline and gives the same numbers every
// time; --record asks the sources for the answers that are missing (a few minutes for swisstopo and Kante) and adds
// them.
//
//   node --experimental-test-module-mocks tools/search-eval/eval.mts [options]
//     --record            ask the sources for answers not recorded yet
//     --shard k/n         only every n-th case from the k-th; with --record, n such runs record side by side
//     --photon            the page's search with Photon too (its public server shuts out a client asking more than
//                         about once a second: recording all of it takes hours)
//     --pace <ms>         with --record --photon: the time between two requests to Photon (3000)
//     --group <g>         only the cases of group g (stop, address, …)
//     --style <s>         with --show: only cases typed in style s (typo, descriptive, …)
//     --show <n>          list n cases the page gets wrong (first right answer not in the 3 rows shown)
//     --system <s>        with --show: 'site' (the default) or 'kante'
//     --judge-out <file>  write the result lists not judged yet (judged/*.jsonl) for the judges to grade (JSONL)
//     --update-baseline   write these ranks to baseline.json, which later runs are compared with
//     --check             exit 1 when the page's top-3 score falls below the baseline's
// See tools/search-eval/README.md.
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { mock } from 'node:test';
import type { EvalCase } from './build-cases.mts';

const HERE = new URL('./', import.meta.url);
const ROOT = new URL('../../', import.meta.url);
const SRC = new URL('src/', ROOT);
const ANSWERS = new URL('answers.json.gz', HERE);
const BASELINE = new URL('baseline.json', HERE);
const JUDGED = new URL('judged/', HERE);
const KANTE = 'https://kante.omniroute.app';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const RECORD = args.includes('--record');
const PHOTON = args.includes('--photon');
const GROUP = opt('--group');
const STYLE = opt('--style');
const SHOW = Number(opt('--show') || 0);
const SHOW_SYSTEM = (opt('--system') || 'site') as SystemName;

// ---- the sources' answers: recorded, or (--record) asked for and recorded ----
interface Answer { s: number; b: unknown }
// --shard k/n: only every n-th case from the k-th (0 … n-1), its new answers in answers.k.json.gz: n of these
// record side by side, and the next run without --shard adds their files to answers.json.gz
const SHARD = opt('--shard') ? opt('--shard')!.split('/').map(Number) : null;
const readAnswers = (file: URL): Record<string, Answer> => (fs.existsSync(file) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString()) : {});
const shardFiles = fs.readdirSync(HERE).filter((f) => /^answers\.\d+\.json\.gz$/.test(f)).map((f) => new URL(f, HERE));
const store: Record<string, Answer> = readAnswers(ANSWERS);
let missing = 0, asked = 0, dirty = false;
if (SHARD) for (const f of shardFiles.filter((f) => f.pathname.endsWith(`answers.${SHARD[0]}.json.gz`))) Object.assign(store, readAnswers(f));
else if (shardFiles.length) { for (const f of shardFiles) Object.assign(store, readAnswers(f)); dirty = true; }
function saveAnswers() {
  if (!dirty) return;
  const sorted = Object.fromEntries(Object.keys(store).sort().map((k) => [k, store[k]]));
  fs.writeFileSync(SHARD ? new URL(`answers.${SHARD[0]}.json.gz`, HERE) : ANSWERS, zlib.gzipSync(JSON.stringify(sorted), { level: 9 }));
  if (!SHARD) for (const f of shardFiles) fs.rmSync(f, { force: true });
  dirty = false;
}
// Only the fields the page reads are kept (the file stays small)
const pickKeys = <T extends object>(o: T, keys: string[]) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, (o as Record<string, unknown>)[k]]));
const PHOTON_KEYS = ['osm_type', 'osm_id', 'osm_key', 'osm_value', 'name', 'countrycode', 'street', 'housenumber', 'city', 'town', 'village', 'locality', 'district'];
function trim(url: string, body: unknown): unknown {
  const b = body as { results?: { attrs: object }[]; features?: { geometry: { coordinates: unknown }; properties?: object }[] };
  if (url.includes('api3.geo.admin.ch')) return { results: (b.results || []).map((r) => ({ attrs: pickKeys(r.attrs, ['label', 'origin', 'lon', 'lat', 'objectclass']) })) };
  if (url.includes('photon.komoot.io')) return { features: (b.features || []).map((f) => ({ geometry: { coordinates: f.geometry.coordinates }, properties: pickKeys(f.properties || {}, PHOTON_KEYS) })) };
  return body;
}
// One request at a time per server, this far apart (ms)
// (--pace <ms> for Photon's public server, which shuts out a client that asks too often: 3000 is safe)
const GAP: Record<string, number> = { 'photon.komoot.io': Number(opt('--pace') || 3000), 'api3.geo.admin.ch': 120, 'kante.omniroute.app': 120 };
const nextAt = new Map<string, Promise<void>>();
function paced(host: string) {
  const prev = nextAt.get(host) || Promise.resolve();
  const mine = prev.then(() => new Promise<void>((ok) => setTimeout(ok, GAP[host] ?? 200)));
  nextAt.set(host, mine);
  return prev;
}
const netFetch = globalThis.fetch; // the page's fetch is replaced below by replayFetch
async function ask(url: string, init?: RequestInit): Promise<Answer> {
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    await paced(host);
    asked++;
    try {
      const headers = { ...(init?.headers as Record<string, string> | undefined), 'User-Agent': 'santiago-de-claude-search-eval/1.0' };
      const res = await netFetch(url, { ...init, headers, signal: AbortSignal.timeout(20000) });
      if ((res.status === 429 || res.status >= 500) && attempt < 2) throw new Error(`HTTP ${res.status}`);
      return { s: res.status, b: res.ok ? trim(url, await res.json()) : null };
    } catch (e) {
      if (attempt >= 2) return { s: 599, b: null };
      console.warn(`  ${host}: ${(e as Error).message}, again in ${2 ** attempt * 3} s`);
      await new Promise((ok) => setTimeout(ok, 2 ** attempt * 3000));
    }
  }
}
const failures = new Map<string, number>();
/** The answers this run asked for: a full --record keeps only those. */
const used = new Set<string>();
const respond = (a: Answer) => ({ ok: a.s >= 200 && a.s < 300, status: a.s, json: async () => structuredClone(a.b) });
async function replayFetch(input: string | URL, init?: RequestInit) {
  const url = String(input);
  if (!PHOTON && url.startsWith('https://photon.komoot.io/')) return respond({ s: 599, b: null }); // as if Photon were down
  const key = init && init.body ? `${url} ${init.body}` : url;
  used.add(key);
  if (!store[key]) {
    if (!RECORD) { missing++; return respond({ s: 599, b: null }); }
    const host = new URL(url).host;
    // No answer at all is not kept: the next --record asks again. A server that has not answered 5 times in a row
    // is down: it is not asked again in this run.
    if ((failures.get(host) || 0) >= 5) { missing++; return respond({ s: 599, b: null }); }
    const a = await ask(url, init);
    if (a.s === 599) {
      failures.set(host, (failures.get(host) || 0) + 1);
      if (failures.get(host) === 5) console.error(`  ${host} has not answered 5 times in a row: not asked again in this run (run --record again later)`);
      missing++;
      return respond(a);
    }
    failures.set(host, 0);
    store[key] = a;
    dirty = true;
  }
  return respond(store[key]);
}

// ---- the page around search-places.ts, stubbed (as in tools/test_walkguess.mts) ----
const APP = new URL('app/', SRC);
const [major, minor] = process.versions.node.split('.').map(Number);
const hasExports = major > 25 || (major === 25 && minor >= 9) || (major === 24 && minor >= 15);
const fake = (file: string, exports: Record<string, unknown>) => mock.module(new URL(file, APP).href,
  (hasExports ? { exports } : { namedExports: exports }) as Parameters<typeof mock.module>[1]);
const nothing = () => {};
/** Where the map is: its middle, and half of its diagonal in km. */
const view = { at: [7.4474, 46.9480] as LngLat, km: 1.5 };
const bounds = () => {
  const dLat = view.km / Math.SQRT2 / 111.195, dLng = dLat / Math.cos((view.at[1] * Math.PI) / 180);
  const [w, s, e, n] = [view.at[0] - dLng, view.at[1] - dLat, view.at[0] + dLng, view.at[1] + dLat];
  return { getWest: () => w, getSouth: () => s, getEast: () => e, getNorth: () => n, getNorthEast: () => ({ toArray: () => [e, n] }),
    contains: (ll: LngLat) => ll[0] >= w && ll[0] <= e && ll[1] >= s && ll[1] <= n };
};
const map = { getCenter: () => ({ toArray: () => [...view.at] }), getBounds: bounds };
const distKm = (a: readonly number[], b: readonly number[]) => {
  const r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLng = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};
const element = (): Record<string, unknown> => ({ querySelector: element, addEventListener: nothing, appendChild: nothing, setAttribute: nothing,
  classList: { add: nothing, remove: nothing, contains: () => false }, style: {} });
// Our own places as src/app/map-places.ts loads them: the index, then the tiles around a point or the view, their
// rows appended to PLACES.items as they come
const PLACES_DIR = new URL('map-places/', ROOT);
const placesIndex = JSON.parse(fs.readFileSync(new URL('index.json', PLACES_DIR), 'utf8')) as MapPlacesIndex;
const PLACES: MapPlaces = { generated: placesIndex.generated, sources: placesIndex.sources, cats: placesIndex.cats, items: [] };
const tilesLoaded = new Set<string>();
const loadBox = (w: number, s: number, e: number, n: number) => {
  for (const [key, tw, ts, te, tn] of placesIndex.tiles) {
    if (tilesLoaded.has(key) || !(tw < e && te > w && ts < n && tn > s)) continue;
    tilesLoaded.add(key);
    const file = JSON.parse(fs.readFileSync(new URL(`${key}.json`, PLACES_DIR), 'utf8')) as MapPlaceTileFile;
    for (const r of file.rows) PLACES.items.push(r);
  }
};
const loadAround = (ll: readonly number[], km: number) => {
  const dLat = km / 111, dLng = km / (111 * Math.cos((ll[1] * Math.PI) / 180));
  loadBox(ll[0] - dLng, ll[1] - dLat, ll[0] + dLng, ll[1] + dLat);
};
const { MAP_LAYERS } = await import(new URL('map-layers.ts', SRC).href);
fake('map.ts', { map });
fake('location.ts', { gpsOn: () => false, userLngLat: null });
fake('search-pins.ts', { render: nothing });
fake('map-places.ts', { PLACES,
  ensurePlacesNear: (ll: LngLat, km: number) => { loadAround(ll, km); return Promise.resolve(true); },
  loadPlaces: () => { const b = bounds(); loadBox(b.getWest(), b.getSouth(), b.getEast(), b.getNorth()); loadAround(view.at, 10); return Promise.resolve(true); },
  GROUP_BY_KEY: Object.fromEntries(MAP_LAYERS.GROUPS.map((g: { key: string }) => [g.key, g])) });
fake('live-vehicles.ts', { fmtDist: (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`) });
fake('routing.ts', { distKm });
// the stops' platforms as src/app/platforms.ts indexes platforms.js (platformKey() copied from there)
const platformKey = (p: string | number | null | undefined) => {
  const s = String(p || '').toUpperCase().replace(/^(GLEIS|GL\.|KANTE|QUAI|VOIE|BINARIO|STEG|PERRON)\s*/, '').trim();
  const digits = /^\d+/.exec(s);
  return digits ? digits[0] : s.replace(/[^0-9A-Z]/g, '');
};
const pf: { window: { PLATFORM_DATA?: PlatformData } } = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL('platforms.js', ROOT), 'utf8'), pf);
const PLATFORM_MODES: Record<string, string> = { t: 'train', m: 'tram', b: 'bus', s: 'boat', c: 'cable' };
const PLATFORMS = new Map(Object.entries(pf.window.PLATFORM_DATA!.stops).map(([id, [name, m, raw]]) => [id, { name, mode: PLATFORM_MODES[m] || 'bus',
  edges: raw.map(([x, y, ref = '']) => ({ ref: ref || '', key: platformKey(ref), ll: [x / 1e5, y / 1e5] as LngLat })) }]));
fake('platforms.ts', { PLATFORMS, platformKey });
Object.assign(globalThis, {
  window: globalThis, APP_CONFIG: {}, fetch: replayFetch, location: { search: '' }, // the engine's client (src/engine.ts) reads the page's address
  document: { getElementById: element, createElement: element, head: element() },
});
// the map library, which the modules import (src/app/search.ts: its markers)
const maplibre = { Marker: class { setLngLat() { return this; } addTo() { return this; } remove() { return this; } } };
mock.module('maplibre-gl', (hasExports ? { exports: maplibre } : { namedExports: maplibre }) as Parameters<typeof mock.module>[1]);

interface Row { title: string; subtitle: string; kind: string; ll: LngLat }
interface PageResult { title: string; subtitle: string; kind: string; lngLat: LngLat }
const page: { search(text: string): Promise<void> } = await import(new URL('search-places.ts', APP).href);
const state: { searchState: { field: string; results: PageResult[] } } = await import(new URL('state.ts', APP).href);

// ---- the systems scored: the page's search, and the engine's /api/search on its own ----
type SystemName = 'site' | 'kante';
const SYSTEMS: Record<SystemName, (c: EvalCase) => Promise<Row[]>> = {
  async site(c) {
    view.at = c.at;
    view.km = c.viewKm;
    state.searchState.field = 'to';
    await page.search(c.q);
    return state.searchState.results.map((r) => ({ title: r.title, subtitle: r.subtitle, kind: r.kind, ll: r.lngLat }));
  },
  async kante(c) {
    const url = `${KANTE}/api/search?` + new URLSearchParams({ q: c.q, lat: c.at[1].toFixed(5), lon: c.at[0].toFixed(5), limit: '10' });
    const res = await replayFetch(url);
    if (!res.ok) return [];
    const body = (await res.json()) as KanteSearchResponse;
    return body.results.map((p) => ({ title: p.name, subtitle: p.detail || (p.modes || []).join(', '), kind: p.kind, ll: [p.lon, p.lat] }));
  },
};

const distM = (a: LngLat, b: LngLat) => distKm(a, b) * 1000;
const isRight = (c: EvalCase, r: Row) => c.ll.some((p) => distM(p, r.ll) <= c.m);
/** Where the first right answer is (1 = the top row), within the first ten; null when none of them is. */
const rankOf = (c: EvalCase, rows: Row[]) => { const i = rows.slice(0, 10).findIndex((r) => isRight(c, r)); return i < 0 ? null : i + 1; };

// ---- run ----
const all: EvalCase[] = JSON.parse(fs.readFileSync(new URL('cases.json', HERE), 'utf8'));
const cases = all.filter((c, i) => (!GROUP || c.group === GROUP) && (!SHARD || i % SHARD[1] === SHARD[0]));
if (!cases.length) { console.error(`no cases${GROUP ? ` in group ${GROUP}` : ''}`); process.exit(2); }
process.on('SIGINT', () => { saveAnswers(); process.exit(130); });
const ranks: Record<SystemName, Record<string, number | null>> = { site: {}, kante: {} };
const empty: Record<SystemName, Record<string, boolean>> = { site: {}, kante: {} };
const rows: Record<SystemName, Record<string, Row[]>> = { site: {}, kante: {} };
const t0 = Date.now();
for (const [i, c] of cases.entries()) {
  // side by side: the two share nothing (the page's own search runs one case at a time: its state is global)
  await Promise.all((Object.keys(SYSTEMS) as SystemName[]).map(async (s) => {
    const r = await SYSTEMS[s](c);
    ranks[s][c.id] = rankOf(c, r);
    empty[s][c.id] = !r.length;
    rows[s][c.id] = r;
  }));
  if (RECORD && (i + 1) % 25 === 0) {
    saveAnswers();
    const min = (Date.now() - t0) / 60000;
    console.log(`  ${i + 1}/${cases.length} cases, ${asked} requests, ${min.toFixed(1)} min (about ${((min / (i + 1)) * (cases.length - i - 1)).toFixed(0)} min to go)`);
  }
}
// A full recording keeps only the answers its cases ask for (old cases' answers go)
if (RECORD && !GROUP && !SHARD) for (const k of Object.keys(store)) if (!used.has(k) && (PHOTON || !k.startsWith('https://photon.komoot.io/'))) { delete store[k]; dirty = true; }
saveAnswers();

// ---- report ----
interface Score { n: number; top1: number; top3: number; top10: number; mrr: number; empty: number }
function score(s: SystemName, list: EvalCase[]): Score {
  const r = list.map((c) => ranks[s][c.id]);
  const share = (f: (x: number | null) => boolean) => r.filter(f).length / (list.length || 1);
  return { n: list.length, top1: share((x) => x === 1), top3: share((x) => x != null && x <= 3), top10: share((x) => x != null),
    mrr: r.reduce<number>((a, x) => a + (x ? 1 / x : 0), 0) / (list.length || 1), empty: list.filter((c) => empty[s][c.id]).length / (list.length || 1) };
}
const groups = [...new Set(cases.map((c) => c.group))];
const pct = (x: number) => (x * 100).toFixed(1).padStart(5);
interface Baseline { photon?: boolean; systems: Record<SystemName, Record<string, number | null>> }
const saved: Baseline | null = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;
// compared only with a baseline made the same way (with or without Photon)
const base = saved && !!saved.photon === PHOTON ? saved : null;
/** The baseline's top-3 share of these cases, as the change since then: ' +2.1' */
const delta = (s: SystemName, list: EvalCase[]) => {
  if (!base || !base.systems[s] || list.some((c) => !(c.id in base.systems[s]))) return '';
  const was = list.filter((c) => { const x = base.systems[s][c.id]; return x != null && x <= 3; }).length / list.length;
  const d = (score(s, list).top3 - was) * 100;
  return Math.abs(d) < 0.05 ? '     ' : `${d > 0 ? '+' : ''}${d.toFixed(1)}`.padStart(5);
};
const line = (name: string, list: EvalCase[]) => {
  const a = score('site', list), k = score('kante', list);
  return `${name.padEnd(14)}${String(a.n).padStart(5)} │ ${pct(a.top1)} ${pct(a.top3)} ${delta('site', list).padStart(5)} ${pct(a.top10)} ${a.mrr.toFixed(3)} ${pct(a.empty)} │ ${pct(k.top1)} ${pct(k.top3)} ${pct(k.top10)} ${k.mrr.toFixed(3)}`;
};
console.log(`\n${cases.length} cases${missing ? `, ${missing} answers not recorded (run with --record)` : ''}\n`);
console.log(`${''.padEnd(14)}      │ the page's search (%)                    │ Kante /api/search alone (%)`);
console.log(`${'group'.padEnd(14)}${'n'.padStart(5)} │  top1  top3     Δ top10   MRR  empty │  top1  top3 top10   MRR`);
console.log('─'.repeat(97));
for (const g of groups) console.log(line(g, cases.filter((c) => c.group === g)));
console.log('─'.repeat(97));
for (const st of [...new Set(cases.map((c) => c.style))].sort()) console.log(line(`  ${st}`, cases.filter((c) => c.style === st)));
console.log('─'.repeat(97));
console.log(line('all', cases));
const macro = (s: SystemName) => groups.reduce((a, g) => a + score(s, cases.filter((c) => c.group === g)).top3, 0) / groups.length;
console.log(`\ntop3: the first right answer is in the 3 rows the list shows before "Show more". Δ: top3 since baseline.json.`);
console.log(`The page's search ${PHOTON ? 'with' : 'without'} Photon${PHOTON ? '' : ' (--photon to include it): its place names and kinds of place come mostly from Photon'}.`);
console.log(`Mean of the groups' top3: page ${pct(macro('site'))}, Kante ${pct(macro('kante'))}`);

// ---- the judges' grades of the top three rows (judged/*.jsonl: {"k": list key, "g": 0…3, "why"}) ----
// A list is what the person sees: the query, what they wanted, where the map is, the first three rows. Its key
// changes when any of that does, so a change to the search only needs its changed lists judged.
const judged: Record<string, { g: number; why?: string }> = {};
for (const f of fs.existsSync(JUDGED) ? fs.readdirSync(JUDGED).filter((f) => f.endsWith('.jsonl')).sort() : []) {
  for (const line of fs.readFileSync(new URL(f, JUDGED), 'utf8').split('\n')) {
    try { const j = JSON.parse(line); if (typeof j.k === 'string' && [0, 1, 2, 3].includes(j.g)) judged[j.k] = { g: j.g, why: j.why }; } catch { /* a blank or broken line */ }
  }
}
const shown = (c: EvalCase, r: Row) => { const d = distM(c.at, r.ll); return `${r.title} — ${r.subtitle} [${r.kind}] · ${d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`} from the map's middle`; };
const listOf = (c: EvalCase, s: SystemName) => ({ q: c.q, want: c.want, map: c.local ? 'near what they want' : 'in another town', results: rows[s][c.id].slice(0, 3).map((r) => shown(c, r)) });
const keyOf = (l: ReturnType<typeof listOf>) => crypto.createHash('sha1').update(JSON.stringify(l)).digest('hex').slice(0, 16);
const grades = (s: SystemName, list: EvalCase[]) => list.map((c) => judged[keyOf(listOf(c, s))]?.g).filter((g): g is number => g != null);
if (Object.keys(judged).length) {
  console.log(`\nThe judges' grade of the top three rows (0 nothing useful … 3 what was wanted, first), mean of those judged:`);
  for (const g of [...groups, 'all']) {
    const list = g === 'all' ? cases : cases.filter((c) => c.group === g);
    const [a, k] = [grades('site', list), grades('kante', list)];
    const mean = (x: number[]) => (x.length ? (x.reduce((p, q) => p + q, 0) / x.length).toFixed(2) : '  – ');
    console.log(`  ${g.padEnd(12)} page ${mean(a)} (${a.length}/${list.length})   Kante ${mean(k)} (${k.length}/${list.length})`);
  }
}
const judgeOut = opt('--judge-out');
if (judgeOut) {
  const todo = new Map<string, ReturnType<typeof listOf>>();
  for (const c of cases) for (const s of ['site', 'kante'] as SystemName[]) { const l = listOf(c, s); const k = keyOf(l); if (!judged[k]) todo.set(k, l); }
  fs.writeFileSync(judgeOut, [...todo].map(([k, l]) => JSON.stringify({ k, ...l })).join('\n') + (todo.size ? '\n' : ''));
  console.log(`\n${todo.size} lists to judge → ${judgeOut}`);
}

if (base) {
  const moved = (s: SystemName, better: boolean) => cases.filter((c) => {
    if (!(c.id in (base.systems[s] || {}))) return false;
    const was = base.systems[s][c.id], now = ranks[s][c.id];
    const top = (x: number | null) => x != null && x <= 3;
    return better ? !top(was) && top(now) : top(was) && !top(now);
  });
  const up = moved('site', true), down = moved('site', false);
  if (up.length || down.length) {
    console.log(`\nSince the baseline: ${up.length} cases into the top 3, ${down.length} out of it.`);
    for (const c of down.slice(0, 15)) console.log(`  worse  ${c.id.padEnd(18)} ${JSON.stringify(c.q)}  ${base.systems.site[c.id]} → ${ranks.site[c.id] ?? '–'}`);
  }
}

if (SHOW) {
  const wrong = cases.filter((c) => { const x = ranks[SHOW_SYSTEM][c.id]; return (!STYLE || c.style === STYLE) && (x == null || x > 3); }).slice(0, SHOW);
  console.log(`\n${wrong.length} cases ${SHOW_SYSTEM === 'site' ? 'the page' : 'Kante'} gets wrong:`);
  for (const c of wrong) {
    console.log(`\n  ${c.id}  ${JSON.stringify(c.q)}  (right within ${c.m} m of ${c.src}; map at ${c.at.join(', ')})  rank ${ranks[SHOW_SYSTEM][c.id] ?? '–'}`);
    for (const r of rows[SHOW_SYSTEM][c.id].slice(0, 5)) {
      const d = Math.min(...c.ll.map((p) => distM(p, r.ll)));
      console.log(`      ${isRight(c, r) ? '✓' : ' '} ${r.title}  ·  ${r.subtitle}  [${r.kind}]  ${d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`} off`);
    }
    if (!rows[SHOW_SYSTEM][c.id].length) console.log('      (no results)');
  }
}

if (args.includes('--update-baseline')) {
  if (GROUP || SHARD || missing) { console.error('\n--update-baseline needs all the cases, all recorded (no --group, --shard)'); process.exit(2); }
  const out: Baseline & { note: string } = { note: 'Ranks of the first right answer per case (null: not in the first 10), written by eval.mts --update-baseline.', photon: PHOTON, systems: ranks };
  fs.writeFileSync(BASELINE, JSON.stringify(out, null, 0).replace(/,"(?=[a-z]+\/T\d+-\d+")/g, ',\n"') + '\n');
  console.log(`\nbaseline.json written`);
}
if (args.includes('--check') && base) {
  const was = cases.filter((c) => { const x = base.systems.site[c.id]; return x != null && x <= 3; }).length / cases.length;
  if (score('site', cases).top3 < was - 1e-9) { console.error(`\nThe page's top3 fell from ${pct(was)} % to ${pct(score('site', cases).top3)} %`); process.exit(1); }
}
process.exit(0);
