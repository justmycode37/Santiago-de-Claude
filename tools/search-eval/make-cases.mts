// Makes the search evaluation's queries (cases.json) from data that is not what the search asks: the stops and
// platforms of ATLAS (platforms.js) and OpenStreetMap's amenities of all of Switzerland (data/ch/osm-*.json,
// toilets-ch.json). Each case is a text typed with the map at some place, and the points any one of which a right
// answer lies within `m` metres of. Seeded, so the same data always gives the same cases:
//   node tools/search-eval/make-cases.mts            (writes tools/search-eval/cases.json)
// See tools/search-eval/README.md.
import fs from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('../../', import.meta.url);
const OUT = new URL('cases.json', import.meta.url);
const SEED = 20261124;

/** One query of the evaluation. */
export interface EvalCase {
  /** 'stop-exact/0001' */
  id: string;
  group: string;
  /** What is typed. */
  q: string;
  /** Where the map is centred, which is also where the search measures distances from. */
  at: LngLat;
  /** Half of the map's diagonal, km (1.5 ≈ a phone at zoom 14). */
  viewKm: number;
  /** A result is right when it lies within `m` metres of one of these. */
  ll: LngLat[];
  m: number;
  /** Where the answer comes from: 'ATLAS 8507000', 'osm node/123'. */
  src: string;
}

// ---- seeded randomness ----
let seed = SEED;
const rand = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rand() * a.length)];
const shuffle = <T,>(a: T[]): T[] => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const chance = (p: number) => rand() < p;

// ---- geometry ----
const distM = (a: LngLat, b: LngLat) => {
  const r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLng = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
};
/** A point somewhere up to `maxM` metres from `p` (at least `minM`). */
const around = (p: LngLat, maxM: number, minM = 0): LngLat => {
  const d = minM + Math.sqrt(rand()) * (maxM - minM), a = rand() * 2 * Math.PI;
  return [+(p[0] + (d * Math.cos(a)) / (111195 * Math.cos((p[1] * Math.PI) / 180))).toFixed(5), +(p[1] + (d * Math.sin(a)) / 111195).toFixed(5)];
};
const r5 = (p: LngLat): LngLat => [+p[0].toFixed(5), +p[1].toFixed(5)];

// ---- the data ----
const sandbox: { window: { PLATFORM_DATA?: PlatformData } } = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL('platforms.js', ROOT), 'utf8'), sandbox);
const STOPS = Object.entries(sandbox.window.PLATFORM_DATA!.stops).map(([uic, [name, mode, edges]]) => {
  const pts = edges.map(([x, y, ref]) => ({ ll: [x / 1e5, y / 1e5] as LngLat, ref: ref ? String(ref) : '' }));
  const c: LngLat = [pts.reduce((s, p) => s + p.ll[0], 0) / pts.length, pts.reduce((s, p) => s + p.ll[1], 0) / pts.length];
  return { uic, name, mode, edges: pts, ll: r5(c) };
});
const stopByName = new Map(STOPS.map((s) => [s.name, s]));

interface OsmRow { id: string; lat: number; lon: number; name: string | null; address: string | null; postcode: string | null; city: string | null; canton: string | null }
const readItems = (file: string): OsmRow[] => JSON.parse(fs.readFileSync(new URL(file, ROOT), 'utf8')).items;
const osm = (cat: string) => readItems(`data/ch/osm-${cat}.json`);
const KINDS: Record<string, OsmRow[]> = {};
for (const f of fs.readdirSync(new URL('data/ch/', ROOT)).filter((f) => /^osm-.*\.json$/.test(f))) KINDS[f.slice(4, -5)] = osm(f.slice(4, -5));
KINDS.toilets = readItems('data/ch/toilets-ch.json'); // the merged toilets: OpenStreetMap, stations, the cities' own lists
const ALL = Object.values(KINDS).flat();

// Where the map can be: the towns, at their main station
const TOWNS: [station: string, lang: 'de' | 'fr' | 'it'][] = [
  ['Bern', 'de'], ['Zürich HB', 'de'], ['Basel SBB', 'de'], ['Genève', 'fr'], ['Lausanne', 'fr'], ['Luzern', 'de'], ['St. Gallen', 'de'],
  ['Lugano', 'it'], ['Winterthur', 'de'], ['Biel/Bienne', 'de'], ['Thun', 'de'], ['Fribourg/Freiburg', 'fr'], ['Chur', 'de'], ['Sion', 'fr'],
  ['Neuchâtel', 'fr'], ['Schaffhausen', 'de'], ['Zug', 'de'], ['Aarau', 'de'], ['Olten', 'de'], ['Solothurn', 'de'], ['Bellinzona', 'it'],
  ['Interlaken Ost', 'de'], ['Montreux', 'fr'], ['Yverdon-les-Bains', 'fr'], ['Baden', 'de'], ['Burgdorf', 'de'], ['La Chaux-de-Fonds', 'fr'],
  ['Uster', 'de'], ['Wil SG', 'de'], ['Locarno', 'it'], ['Vevey', 'fr'], ['Brig', 'de'], ['Rapperswil SG', 'de'], ['Frauenfeld', 'de'],
];
const ANCHORS = TOWNS.flatMap(([name, lang]) => {
  const s = stopByName.get(name);
  if (!s) { console.warn(`no station called ${name} in platforms.js`); return []; }
  return [{ name, lang, ll: s.ll }];
});
const anchorNear = (p: LngLat) => ANCHORS.reduce((a, b) => (distM(a.ll, p) <= distM(b.ll, p) ? a : b));
/** The language people near p speak, crudely: the nearest town's, or German more than 40 km from all of them. */
const langAt = (p: LngLat) => { const a = anchorNear(p); return distM(a.ll, p) < 40000 ? a.lang : 'de'; };
/** A map somewhere else: in a town at least `minKm` away. */
const farFrom = (p: LngLat, minKm = 30): LngLat => around(pick(ANCHORS.filter((a) => distM(a.ll, p) > minKm * 1000)).ll, 1500);

const cases: EvalCase[] = [];
const counts: Record<string, number> = {};
function add(group: string, c: Omit<EvalCase, 'id' | 'group' | 'viewKm'> & { viewKm?: number }) {
  if (!c.q.trim() || cases.some((x) => x.group === group && x.q === c.q && distM(x.at, c.at) < 5000)) return false;
  counts[group] = (counts[group] || 0) + 1;
  cases.push({ id: `${group}/${String(counts[group]).padStart(4, '0')}`, group, viewKm: 1.5, ...c, q: c.q.trim(), ll: c.ll.map(r5), m: Math.round(c.m) });
  return true;
}
function fill(n: number, make: () => boolean, limit = n * 50) { let made = 0; for (let i = 0; made < n && i < limit; i++) if (make()) made++; }

// ---- stops (ATLAS) ----
const MODE_RADIUS: Record<string, number> = { t: 250, m: 120, b: 120, s: 150, c: 150 };
const stopTruth = (s: typeof STOPS[number]) => ({ ll: [s.ll, ...s.edges.map((e) => e.ll)], m: MODE_RADIUS[s.mode] || 120, src: `ATLAS ${s.uic}` });
const byMode = (m: string) => STOPS.filter((s) => s.mode === m && s.name.length >= 3);
const STOP_MIX: [mode: string, n: number][] = [['t', 90], ['m', 60], ['b', 150], ['s', 25], ['c', 25]];
/** Where the map is for a stop: around it (you are in that town) or in another town. */
const stopView = (s: typeof STOPS[number], nearP: number) => (chance(nearP) ? around(s.ll, 3000, 200) : farFrom(s.ll));

for (const [mode, n] of STOP_MIX) fill(n, () => { const s = pick(byMode(mode)); return add('stop-exact', { q: s.name, at: stopView(s, 0.5), ...stopTruth(s) }); });

const UMLAUT: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue' };
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
// a stop's own name, without the town before the comma, when it says more than a kind of place
const GENERIC = /^(bahnhof|dorf|post|kirche|schulhaus|schule|zentrum|gemeindehaus|gare|poste|centre|village|eglise|église|stazione|paese|chiesa|piazza|station|dorfplatz|bahnhofplatz|oberdorf|unterdorf|mitte)$/i;
fill(250, () => {
  const s = pick(chance(0.5) ? byMode('b') : chance(0.5) ? byMode('m') : byMode('t'));
  const [town, own] = s.name.includes(',') ? s.name.split(/,\s*/, 2) : [s.name, ''];
  const ways: [string, string, boolean][] = [['lowercase', s.name.toLowerCase().replace(/,/g, ''), false]];
  if (own && own.length >= 4 && !GENERIC.test(own) && town) ways.push(['own name', own, true]);
  if (/[äöüÄÖÜ]/.test(s.name)) ways.push(['ae oe ue', s.name.replace(/[äöüÄÖÜ]/g, (c) => UMLAUT[c]), false]);
  if (plain(s.name) !== s.name) ways.push(['no accents', plain(s.name).toLowerCase(), false]);
  const [, q, mustBeNear] = pick(ways);
  return add('stop-casual', { q, at: mustBeNear ? around(s.ll, 2000, 200) : stopView(s, 0.5), ...stopTruth(s) });
});

// typing it: the last word cut short ("Bern, Zytgl")
fill(150, () => {
  const s = pick(chance(0.6) ? byMode('b') : chance(0.5) ? byMode('m') : byMode('t'));
  const words = s.name.split(' ');
  const last = words[words.length - 1];
  if (last.length < 5 || s.name.length < 8) return false;
  const q = [...words.slice(0, -1), last.slice(0, Math.max(3, Math.ceil(last.length * 0.6)))].join(' ');
  return add('stop-prefix', { q, at: stopView(s, 0.7), ...stopTruth(s) });
});

// one slip of the finger in a word of five letters or more
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
function typo(w: string) {
  const i = 1 + Math.floor(rand() * (w.length - 2));
  switch (Math.floor(rand() * 4)) {
    case 0: return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2); // swapped
    case 1: return w.slice(0, i) + w.slice(i + 1); // left out
    case 2: return w.slice(0, i) + pick([...LETTERS]) + w.slice(i + 1); // wrong letter
    default: return w.slice(0, i) + pick([...LETTERS]) + w.slice(i); // one too many
  }
}
fill(100, () => {
  const s = pick(chance(0.5) ? byMode('b') : chance(0.5) ? byMode('m') : byMode('t'));
  const words = s.name.split(' ');
  const long = words.map((w, i) => [w, i] as const).filter(([w]) => /^\p{L}{5,}$/u.test(w));
  if (!long.length) return false;
  const [w, i] = pick(long);
  const t = typo(w);
  if (t.toLowerCase() === w.toLowerCase()) return false;
  words[i] = t;
  return add('stop-typo', { q: words.join(' '), at: stopView(s, 0.6), ...stopTruth(s) });
});

// ---- stations as people name them ----
const trains = byMode('t').filter((s) => !s.name.includes(',') && s.edges.length >= 2);
fill(150, () => {
  const s = pick(trains);
  const lang = langAt(s.ll);
  const hb = /\s(HB|SBB)$/.exec(s.name);
  const base = hb ? s.name.slice(0, hb.index) : s.name;
  const forms = hb ? [`${base} HB`, `${base} Hauptbahnhof`, `${base} Bahnhof`, `${base} station`, `Bahnhof ${base}`]
    : lang === 'fr' ? [`Gare de ${base}`, `${base} gare`, `gare ${base}`, `${base} station`]
    : lang === 'it' ? [`Stazione ${base}`, `${base} stazione`, `${base} station`]
    : [`Bahnhof ${base}`, `${base} Bahnhof`, `${base} Bhf`, `${base} station`, `Bhf ${base}`];
  return add('station-alias', { q: pick(forms), at: stopView(s, 0.4), ll: [s.ll, ...s.edges.map((e) => e.ll)], m: 300, src: `ATLAS ${s.uic}` });
});
// other languages' names of the towns: right anywhere in the town (2.5 km around its station)
const EXONYMS: [q: string, station: string][] = [
  ['Geneva', 'Genève'], ['Genf', 'Genève'], ['Ginevra', 'Genève'], ['Geneve', 'Genève'], ['Berne', 'Bern'], ['Lucerne', 'Luzern'], ['Lucerna', 'Luzern'],
  ['Zurich', 'Zürich HB'], ['Zuerich', 'Zürich HB'], ['Zurigo', 'Zürich HB'], ['Basle', 'Basel SBB'], ['Bâle', 'Basel SBB'], ['Basilea', 'Basel SBB'],
  ['Neuenburg', 'Neuchâtel'], ['Freiburg', 'Fribourg/Freiburg'], ['Fribourg', 'Fribourg/Freiburg'], ['Bienne', 'Biel/Bienne'], ['Biel', 'Biel/Bienne'],
  ['Sitten', 'Sion'], ['Coire', 'Chur'], ['Soleure', 'Solothurn'], ['Schaffhouse', 'Schaffhausen'], ['Saint-Gall', 'St. Gallen'],
  ['Sankt Gallen', 'St. Gallen'], ['St Gallen', 'St. Gallen'], ['San Gallo', 'St. Gallen'], ['Winterthour', 'Winterthur'], ['Bellinzone', 'Bellinzona'],
  ['Lausanne gare', 'Lausanne'], ['Zurich main station', 'Zürich HB'], ['Geneva station', 'Genève'], ['Bern main station', 'Bern'],
  ['Zurich airport', 'Zürich Flughafen'], ['Geneva airport', 'Genève-Aéroport'], ['Basel station', 'Basel SBB'], ['Lugano station', 'Lugano'],
];
for (const [q, name] of EXONYMS) {
  const s = stopByName.get(name);
  if (!s) { console.warn(`no station called ${name}`); continue; }
  const m = /station|gare|airport/.test(q) ? 400 : 2500;
  add('exonym', { q, at: farFrom(s.ll), ll: [s.ll], m, src: `ATLAS ${s.uic}` });
  add('exonym', { q: q.toLowerCase(), at: around(s.ll, 2000, 300), ll: [s.ll], m, src: `ATLAS ${s.uic}` });
}

// ---- platforms and stop edges: "Bern Gleis 7", "Bern, Bahnhof Kante H" ----
const distinctEdges = (s: typeof STOPS[number]) => s.edges.filter((e) => e.ref && s.edges.every((o) => o === e || o.ref === e.ref || distM(o.ll, e.ll) >= 25));
fill(100, () => {
  const train = chance(0.5);
  const s = pick(train ? byMode('t').filter((x) => x.edges.length >= 3) : STOPS.filter((x) => (x.mode === 'b' || x.mode === 'm') && x.edges.length >= 2));
  const edges = distinctEdges(s).filter((e) => (train ? /^\d+$/.test(e.ref) : /^[A-Z]$/.test(e.ref)));
  if (!edges.length) return false;
  const e = pick(edges);
  const others = s.edges.filter((o) => o.ref !== e.ref).map((o) => distM(o.ll, e.ll));
  const m = Math.max(15, Math.min(40, Math.min(...others) / 2));
  const lang = langAt(s.ll);
  const word = train ? pick(lang === 'fr' ? ['voie', 'quai', 'platform'] : lang === 'it' ? ['binario', 'platform'] : ['Gleis', 'Gl.', 'platform', 'track'])
    : pick(['Kante', 'platform', '']);
  return add('platform', { q: `${s.name} ${word} ${e.ref}`.replace(/\s+/g, ' '), at: stopView(s, 0.6), ll: [e.ll], m, src: `ATLAS ${s.uic} ${e.ref}` });
});

// ---- addresses (OpenStreetMap amenities with a street, number and town) ----
const ADDRS = ALL.filter((r) => r.address && r.city && r.postcode && /^\D.*\s\d{1,4}[a-zA-Z]?$/.test(r.address));
fill(300, () => {
  const r = pick(ADDRS);
  const p: LngLat = [r.lon, r.lat];
  const truth = { ll: [p], m: 75, src: `osm ${r.id}` };
  const way = rand();
  if (way < 0.45) return add('address', { q: `${r.address}, ${r.city}`, at: farFrom(p, 20), ...truth });
  if (way < 0.7) return add('address', { q: r.address!, at: around(p, 1500), ...truth });
  if (way < 0.85) return add('address', { q: `${r.address}, ${r.postcode} ${r.city}`, at: farFrom(p, 20), ...truth });
  if (!/strasse\s/i.test(r.address!)) return false;
  return add('address', { q: `${r.address!.replace(/strasse\s/i, (m) => (m[0] === 'S' ? 'Str. ' : 'str. '))}, ${r.city}`, at: farFrom(p, 20), ...truth });
});

// ---- places by name: the one meant, or a nearer one of the same name (a chain's nearest branch) ----
const NAMED_KINDS = ['pharmacy', 'supermarket', 'library', 'hospital', 'police', 'post_office', 'community_centre', 'clinic', 'dentist', 'doctors', 'social_facility', 'atm'];
const key = (s: string) => plain(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const NAMED = NAMED_KINDS.flatMap((k) => KINDS[k].filter((r) => r.name && r.name.length >= 4 && /\p{L}{3}/u.test(r.name)));
const sameName = new Map<string, OsmRow[]>();
for (const r of NAMED) { const k = key(r.name!); sameName.set(k, [...(sameName.get(k) || []), r]); }
fill(250, () => {
  const r = pick(NAMED);
  const p: LngLat = [r.lon, r.lat];
  const twins = sameName.get(key(r.name!))!;
  if (chance(0.7)) {
    const at = around(p, 2000, 100);
    const nearer = twins.filter((t) => distM([t.lon, t.lat], at) <= distM(p, at));
    return add('place-name', { q: r.name!, at, ll: nearer.map((t) => [t.lon, t.lat] as LngLat), m: 100, src: `osm ${r.id}` });
  }
  if (!r.city || key(r.name!).includes(key(r.city))) return false;
  const inTown = twins.filter((t) => t.city === r.city);
  return add('place-name', { q: `${r.name} ${r.city}`, at: farFrom(p, 20), ll: inTown.map((t) => [t.lon, t.lat] as LngLat), m: 100, src: `osm ${r.id}` });
});

// ---- kinds of place: right when it is one of the ten nearest of that kind ----
const CATEGORY_WORDS: Record<string, string[]> = {
  pharmacy: ['pharmacy', 'Apotheke', 'pharmacie', 'farmacia', 'closest pharmacy', 'apotheke in der nähe'],
  toilets: ['toilet', 'WC', 'toilette', 'public toilet', 'closest toilet', 'toilets near me', 'restroom'],
  atm: ['ATM', 'Bancomat', 'Geldautomat', 'cash machine', 'atm near me'],
  supermarket: ['supermarket', 'Supermarkt', 'supermarché', 'grocery store', 'lebensmittel'],
  hospital: ['hospital', 'Spital', 'hôpital', 'ospedale', 'Krankenhaus'],
  police: ['police', 'Polizei', 'polizia', 'police station'],
  post_office: ['post office', 'Post', 'Poste', 'Postfiliale'],
  drinking_water: ['drinking water', 'Trinkwasser', 'Brunnen', 'water fountain'],
  library: ['library', 'Bibliothek', 'bibliothèque', 'biblioteca'],
  playground: ['playground', 'Spielplatz', 'place de jeux'],
  doctors: ['doctor', 'Arzt', 'médecin', 'Hausarzt', 'GP'],
  dentist: ['dentist', 'Zahnarzt', 'dentiste'],
  aed: ['defibrillator', 'AED', 'Defi'],
};
const cats = Object.keys(CATEGORY_WORDS);
fill(300, () => {
  const kind = pick(cats);
  const at = around(pick(ANCHORS).ll, 2500);
  const nearest = KINDS[kind].map((r) => [r, distM([r.lon, r.lat], at)] as const).sort((a, b) => a[1] - b[1]).slice(0, 10);
  if (!nearest.length || nearest[0][1] > 5000) return false;
  return add('category', { q: pick(CATEGORY_WORDS[kind]), at, ll: nearest.map(([r]) => [r.lon, r.lat] as LngLat), m: 60, src: `osm-${kind}` });
});

// ---- towns and postcodes: right anywhere near the middle of their addresses ----
const groupBy = (f: (r: OsmRow) => string | null) => {
  const g = new Map<string, LngLat[]>();
  for (const r of ADDRS) { const k = f(r); if (k) g.set(k, [...(g.get(k) || []), [r.lon, r.lat]]); }
  return [...g].map(([k, pts]) => ({ k, n: pts.length, ll: [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length] as LngLat }));
};
const towns = groupBy((r) => r.city).filter((t) => t.n >= 15);
const postcodes = groupBy((r) => r.postcode).filter((t) => t.n >= 8);
fill(60, () => { const t = pick(towns); return add('town', { q: chance(0.3) ? t.k.toLowerCase() : t.k, at: farFrom(t.ll, 15), ll: [t.ll], m: 3000, src: `osm addresses (${t.n})` }); });
fill(40, () => { const t = pick(postcodes); return add('postcode', { q: t.k, at: farFrom(t.ll, 15), ll: [t.ll], m: 2500, src: `osm addresses (${t.n})` }); });

shuffle(cases); // ids keep their group's order; the file is sorted back below
cases.sort((a, b) => a.id.localeCompare(b.id));
fs.writeFileSync(OUT, '[\n' + cases.map((c) => JSON.stringify(c)).join(',\n') + '\n]\n');
console.log(`${cases.length} cases → ${OUT.pathname}`);
for (const [g, n] of Object.entries(counts)) console.log(`  ${g.padEnd(14)} ${n}`);
