// Builds map-places.js (what the map shows) from data/amenities.json, data/places.json and
// data/official-places.json. Run from the repo root after refreshing those files:
//   node tools/build-map-places.mjs
// Each data category is sorted into a map group with map-layers.js's classify(). OpenStreetMap items found in
// both OSM files are kept once, and an official item is dropped when OSM has the same kind of thing within 25 m
// (its missing details are filled in from the official one).
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url)));
const sandbox = { window: {} };
vm.runInNewContext(readFileSync(new URL('../map-layers.js', import.meta.url), 'utf8'), sandbox);
const { classify, GROUPS, GLYPHS } = sandbox.window.MAP_LAYERS;

const amenities = read('data/amenities.json');
const places = read('data/places.json');
const official = read('data/official-places.json');

const SOURCES = ['OpenStreetMap', 'Stadt Bern', 'Kanton Bern', 'SBB', 'Velospot'];
const sourceIndex = (key) => (key.startsWith('stadtbern') ? 1 : key.startsWith('kantonbern') ? 2 : key.startsWith('sbb') ? 3 : key === 'velospot' ? 4 : 0);
// Same kind of thing under different names, for matching official items to OSM ones
const SAME = { bike_share: 'bicycle_rental', sports: 'sports_centre', doctor: 'doctors', charging_station: 'ev_charging' };
// Official names that only repeat the category
const GENERIC_NAME = /^(Aufmerksamkeitsfeld|akustisches Uebergangssignal.*|Billetautomat .*|Billetentwerter .*)$/i;

const clip = (s, n = 180) => {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};
const yesNo = (v) => (v == null ? null : /^(yes|designated|ja)\b/i.test(v) ? 'yes' : /^(no|nein)\b/i.test(v) ? 'no' : /^limited\b/i.test(v) ? 'limited' : null);
const fee = (v) => (v == null ? null : /^no$/i.test(v) ? 'no' : /^yes$/i.test(v) || /\d/.test(v) ? 'yes' : null);
const url = (v) => {
  const s = clip(v, 300);
  if (!s) return null;
  const u = /^https?:\/\//i.test(s) ? s : /^www\./i.test(s) ? 'https://' + s : null;
  return u && u.split(/[\s;]/)[0];
};
const addressOf = (i) => clip(i.address
  || [[i.street, i.housenumber].filter(Boolean).join(' '), [i.postcode, i.city].filter(Boolean).join(' ')].filter(Boolean).join(', '), 120);

// → { kind, cat, name, x: details } in one shape for every source
function fromOsm(i, placeGroup) {
  const access = i.access && /^(customers|private|permissive|permit)$/.test(i.access) ? i.access : null;
  return {
    id: i.id, lon: i.lon, lat: i.lat, src: 0, kind: SAME[i.category] || i.category, cat: classify(i.category, placeGroup),
    name: clip(i.name, 90),
    x: {
      a: addressOf(i), h: clip(i.opening_hours, 120), w: yesNo(i.wheelchair), f: fee(i.fee), p: clip(i.phone, 40),
      u: url(i.website), l: clip(i.level, 12), d: clip(i.description), k: access,
      c: yesNo(i.changing_table) === 'yes' ? 1 : null, tw: yesNo(i.toilets_wheelchair),
    },
  };
}
function fromOfficial(i) {
  const acc = i.wheelchair_or_accessibility;
  const w = yesNo(acc);
  const note = acc && /;/.test(acc) ? acc.split(';').slice(1).join(';').trim() : null;
  const desc = [i.description !== i.name ? i.description : null, note].filter(Boolean).join(' · ');
  return {
    id: i.id, lon: i.lon, lat: i.lat, src: sourceIndex(i.source), kind: SAME[i.category] || i.category, cat: classify(i.category),
    name: GENERIC_NAME.test(i.name || '') ? null : clip(i.name, 90),
    x: { a: clip(i.address, 120), h: clip(i.opening_hours, 120), w, p: clip(i.phone, 40), u: url(i.website), d: clip(desc) },
  };
}

const metres = (a, b) => {
  const dx = (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180), dy = (a.lat - b.lat) * 110540;
  return Math.hypot(dx, dy);
};

// OSM: amenities first; places.json repeats some of the same OSM objects with more detail
const byId = new Map();
const merge = (into, from) => { for (const k in from.x) if (into.x[k] == null && from.x[k] != null) into.x[k] = from.x[k]; if (!into.name) into.name = from.name; };
for (const i of amenities.items) byId.set(i.id, fromOsm(i));
for (const i of places.items) {
  const p = fromOsm(i, i.group);
  const had = byId.get(i.id);
  if (had) merge(had, p);
  else byId.set(i.id, p);
}
// The same named place mapped twice in OSM (e.g. a shop as a point and as a building): keep it once
const fold = (t) => String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const items = [];
const byName = new Map();
let mergedTwins = 0;
for (const it of byId.values()) {
  if (it.name) {
    const key = it.kind + '|' + fold(it.name);
    const twin = (byName.get(key) || []).find((o) => metres(o, it) <= 60);
    if (twin) { merge(twin, it); mergedTwins++; continue; }
    (byName.get(key) || byName.set(key, []).get(key)).push(it);
  }
  items.push(it);
}

// Official items: skip when OSM already has the same kind within 25 m
const CELL = 0.0005; // ~40-55 m grid for the lookup
const grid = new Map();
const cellKey = (lon, lat) => `${Math.floor(lon / CELL)},${Math.floor(lat / CELL)}`;
for (const it of items) {
  const k = cellKey(it.lon, it.lat);
  (grid.get(k) || grid.set(k, []).get(k)).push(it);
}
let mergedOfficial = 0;
for (const i of official.items) {
  if (i.lat == null || i.lon == null) continue;
  const o = fromOfficial(i);
  const cx = Math.floor(o.lon / CELL), cy = Math.floor(o.lat / CELL);
  let twin = null;
  for (let dx = -1; dx <= 1 && !twin; dx++) for (let dy = -1; dy <= 1 && !twin; dy++) {
    for (const it of grid.get(`${cx + dx},${cy + dy}`) || []) {
      if (it.src === 0 && it.kind === o.kind && metres(it, o) <= 25) { twin = it; break; }
    }
  }
  if (twin) { merge(twin, o); mergedOfficial++; continue; }
  items.push(o);
}

// Compact output: a category table and one short array per item
const groupKeys = new Set(GROUPS.map((g) => g.key));
const cats = [];
const catIndex = new Map();
const out = [];
for (const it of items) {
  const [group, glyph, rank, label] = it.cat;
  if (!groupKeys.has(group) || !GLYPHS[glyph]) throw new Error(`Unknown group/glyph ${group}/${glyph} for ${it.id}`);
  if (![1, 2, 3, 4, 5].includes(rank)) throw new Error(`Rank ${rank} for ${it.id} is not 1–5`);
  const ck = `${group}|${glyph}|${rank}|${label}`;
  if (!catIndex.has(ck)) { catIndex.set(ck, cats.length); cats.push([group, glyph, rank, label]); }
  const x = {};
  for (const k in it.x) if (it.x[k] != null) x[k] = it.x[k];
  if (it.src) x.s = it.src;
  const row = [+it.lon.toFixed(6), +it.lat.toFixed(6), catIndex.get(ck), it.name || 0];
  if (Object.keys(x).length) row.push(x);
  out.push(row);
}
// Stable order, so a rebuild from the same data gives the same file
out.sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);

const generated = [amenities.generated, places.generated, official.generated].sort().pop();
const js = `// Generated by tools/build-map-places.mjs from data/*.json (${generated}). Do not edit by hand.
// Sources: OpenStreetMap contributors (ODbL); Stadt Bern geoportal, Kanton Bern (opendata.swiss terms_open);
// SBB (data.sbb.ch); Velospot (GBFS). Rows: [lon, lat, category, name or 0, details?]
// Details: a address, h opening hours, w wheelchair, f fee, p phone, u website, l level, d description,
// k access, c changing table, tw wheelchair toilet, s source (index into sources, 0 = OpenStreetMap).
window.MAP_PLACES = ${JSON.stringify({ generated, sources: SOURCES, cats, items: out })};
`;
writeFileSync(new URL('../map-places.js', import.meta.url), js);

const perGroup = {};
for (const r of out) { const g = cats[r[2]][0]; perGroup[g] = (perGroup[g] || 0) + 1; }
console.log(`map-places.js: ${out.length} places (${mergedTwins} OSM doubles and ${mergedOfficial} official items merged into OSM ones), ${(js.length / 1e6).toFixed(2)} MB`);
console.log(perGroup);
