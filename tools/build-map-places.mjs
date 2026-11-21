// Builds map-places.js (what the map shows) from data/amenities.json, data/places.json,
// data/official-places.json (all three Bern only) and data/ch/toilets-ch.json (all of Switzerland). Run from the
// repo root after refreshing those files:
//   node tools/build-map-places.mjs
// Toilets come from data/ch/toilets-ch.json (tools/build-toilets-ch.mjs: OpenStreetMap merged with station
// toilets, the cities' own lists and the Nette Toilette restaurants), not from the raw OpenStreetMap ones in
// amenities.json. data/toilets.json (Bern) adds the notes the Swiss file leaves out.
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
const toilets = read('data/ch/toilets-ch.json');
const bernToilets = read('data/toilets.json');
const osmToiletsCh = read('data/ch/osm-toilets.json');

const SOURCES = ['OpenStreetMap', 'Stadt Bern', 'Kanton Bern', 'SBB', 'Velospot'];
// Who a toilet record comes from, by the key its sources start with (docs/data-ch-toilets.md)
const TOILET_SOURCES = {
  osm: 'OpenStreetMap', 'osm-place': 'OpenStreetMap', nette: 'Stadt Bern', atlas: 'opentransportdata.swiss', 'atlas.toilet': 'opentransportdata.swiss',
  'zh.zueriwc': 'Stadt Zürich', 'bs.wc': 'Kanton Basel-Stadt', 'ge.wc': 'Ville de Genève', 'lu.wc': 'Stadt Luzern',
  'sg.wc': 'Stadt St.Gallen', 'zg.stadtmobiliar': 'Stadt Zug',
};
const sourceId = (label) => (SOURCES.includes(label) ? SOURCES.indexOf(label) : SOURCES.push(label) - 1);
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
const yesNo = (v) => (v == null ? null : /^(yes|designated|only|ja)\b/i.test(v) ? 'yes' : /^(no|nein)\b/i.test(v) ? 'no' : /^limited\b/i.test(v) ? 'limited' : null);
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
// A record of data/ch/toilets-ch.json. A toilet nobody but the owner may use is left off the map, one for
// customers is marked as such, and a Nette Toilette (a restaurant or shop that lets everyone use its toilet)
// says so. The notes carry the builder's own remarks too ("OSM says paid=free"), which are not for the card.
const NETTE_NOTE = /^nette toilette\b/i;
const NETTE_NAME = /^nette toilette( im restaurant)?$/i;
const CENTRE_NOTE = /^position is the station centre\b/i;
const FEE_NOTE = /^fee \([^)]*\):\s*/;
const BUILD_NOTE = /^(OSM|atlas) (says\b|[\w:]+=)/;
const FREE_FOR_CUSTOMERS = /\bOSM (fee:conditional|charge)=.*customers/i; // "OSM charge=2 CHF; Gratis @ customers"
const CUSTOMERS_NOTE = /^\S+ *@ *customers$/i;
const NOT_PUBLIC = /^(private|no|military|employees)$/;
const TOILET_ACCESS = { customers: 'customers', guests: 'customers', permissive: 'permissive', permit: 'permit', key: 'key', centralkey: 'key', wheelchair: 'wheelchair' };
// A city lists only the toilets it opens to the public; the station list (ATLAS) says less about who may go in
const CITY_LIST = /^(zh|bs|ge|lu|sg|zg)\./;
// Notes that say the toilet is locked or shut ("Der Schlüssel muss am Billettschalter abgeholt werden",
// "Non ouverte au public"). A Eurokey is its own tag.
const LOCKED_NOTE = /nicht öffentlich|non ouverte au public|schl[üu]s+el|clé à disposition|vorübergehend geschlossen|momentan (wegen .* )?(ab)?geschlossen|ist geschlossen|abgeschlossen/i;
const EUROKEY_NOTE = /euro-?\s?key|eurokey|euroschlüssel|chiave europea/i;
function fromToilet(t, extraNotes = []) {
  const keys = [...new Set(t.sources.map((s) => s.split(/[:/]/)[0]).filter((k) => TOILET_SOURCES[k]))];
  const official = keys.some((k) => CITY_LIST.test(k)) ? 'city' : keys.some((k) => /^atlas/.test(k)) ? 'station' : null;
  const shut = NOT_PUBLIC.test(t.access || '');
  if (shut && !official) return null;
  // a value of an OpenStreetMap tag can hold a ";" of its own ("Gratis / customers;1CHF/ EUR"): the notes are joined with "; "
  const notes = (t.notes || '').split(/;\s+/).filter(Boolean);
  for (const n of extraNotes) if (!notes.some((m) => m.toLowerCase() === n.toLowerCase())) notes.push(n);
  const nette = keys.includes('nette') || notes.some((n) => NETTE_NOTE.test(n)) || NETTE_NOTE.test(t.name || '');
  const about = notes.filter((n) => ![NETTE_NOTE, CENTRE_NOTE, FEE_NOTE, BUILD_NOTE, CUSTOMERS_NOTE].some((re) => re.test(n)));
  // k: who may use it. Where OpenStreetMap says nobody but a city lists the toilet as public, the city is believed;
  // where only the station list disagrees, or a note says it is locked, the card warns ("unsure").
  const access = nette || official === 'city' ? null
    : shut ? 'unsure'
    : TOILET_ACCESS[t.access] || (t.wheelchair === 'only' || t.toilets_wheelchair === 'only' ? 'wheelchair' : null)
    || (about.some((n) => LOCKED_NOTE.test(n) && !EUROKEY_NOTE.test(n)) ? 'unsure' : null);
  if (nette) about.unshift('Anyone may use this toilet without buying anything while the business is open.');
  if (/^atlas/.test(keys[0])) about.push('Shown at the middle of the station, the exact spot is not recorded.');
  const fees = notes.filter((n) => FEE_NOTE.test(n)).map((n) => n.replace(FEE_NOTE, '').replace(/\.+$/, '.'));
  if (!nette && FREE_FOR_CUSTOMERS.test(t.notes || '')) fees.push('Free for customers.');
  // "Forchstr. 396, Zollikon" + 8702 Zollikon → "Forchstr. 396, 8702 Zollikon"; no street → "8702 Zollikon"
  const town = [t.postcode, t.city].filter(Boolean).join(' ');
  let street = t.address || '';
  if (t.city && street.endsWith(`, ${t.city}`)) street = street.slice(0, -t.city.length - 2);
  const address = !town || (t.postcode && street.includes(t.postcode)) ? street : [street, town].filter(Boolean).join(', ');
  // a Nette Toilette that OpenStreetMap only calls "Nette Toilette" is named after the business
  const name = nette && (!t.name || NETTE_NAME.test(t.name)) ? t.operator || t.name : t.name;
  return {
    id: t.id, lon: t.lon, lat: t.lat, src: sourceId([...new Set(keys.map((k) => TOILET_SOURCES[k]))].join(', ')), kind: 'toilets',
    cat: classify(nette ? 'toilets_nette' : access === 'customers' ? 'toilets_customers' : 'toilets'),
    name: clip(name, 90),
    x: {
      a: clip(address, 120), h: clip(/^24 ?h$/i.test(t.opening_hours || '') ? '24/7' : t.opening_hours, 120), w: yesNo(t.wheelchair),
      // f: no = free, yes = you pay, mixed = the site has a free and a paying toilet (by cabin or by time of day)
      f: nette || t.paid === 'free' ? 'no' : t.paid === 'paid' ? 'yes' : t.paid === 'mixed' ? 'mixed' : null,
      pr: nette || t.paid === 'free' ? null : clip(t.price, 12), ft: clip(fees.join(' '), 300),
      l: clip(t.level, 12), d: clip(about.join(' · '), 400), k: access,
      c: /^(yes|room)$/.test(t.changing_table || '') ? 1 : null, tw: yesNo(t.toilets_wheelchair), e: yesNo(t.eurokey) === 'yes' ? 1 : null,
      o: t.operator && fold(t.operator) !== fold(name || '') ? clip(t.operator, 60) : null,
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
const osmToilets = new Map(); // the toilets go in from data/ch/toilets-ch.json below
for (const i of amenities.items) {
  if (i.category === 'toilets') osmToilets.set(i.id, i);
  else byId.set(i.id, fromOsm(i));
}
for (const i of places.items) {
  const p = fromOsm(i, i.group);
  const had = byId.get(i.id);
  if (had) merge(had, p);
  else byId.set(i.id, p);
}
// The same named place mapped twice in OSM (e.g. a shop as a point and as a building): keep it once
function fold(t) { return String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
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

// Toilets: already merged across their sources, so they skip the step above. The OpenStreetMap record adds
// what the toilet file leaves out (website, phone), and Bern's own toilet file its notes ("Pissoir", "Nur im
// Sommer", a Nette Toilette only OpenStreetMap knows), under the same id.
const bernNotes = new Map(bernToilets.items.map((t) => [t.id.replace(/^atlas\//, 'atlas.toilet/'), (t.notes || '').split(/;\s+/).filter(Boolean)]));
for (const i of osmToiletsCh.items) if (!osmToilets.has(i.id)) osmToilets.set(i.id, i);
let toiletsHidden = 0;
const toiletIds = new Set();
for (const t of toilets.items) {
  toiletIds.add(t.id);
  const it = fromToilet(t, bernNotes.get(t.id));
  if (!it) { toiletsHidden++; continue; }
  const osm = osmToilets.get(t.id);
  if (osm) { const o = fromOsm(osm); for (const k of ['p', 'u']) if (it.x[k] == null) it.x[k] = o.x[k]; }
  items.push(it);
}
// Every Bern toilet has to be in the Swiss file, or it would drop off the map unnoticed
const lost = [...bernNotes.keys()].filter((id) => !toiletIds.has(id));
if (lost.length) throw new Error(`data/toilets.json has toilets that data/ch/toilets-ch.json lacks: ${lost.join(', ')}`);

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

const generated = [amenities.generated, places.generated, official.generated, toilets.generated].sort().pop();
const js = `// Generated by tools/build-map-places.mjs from data/*.json (${generated}). Do not edit by hand.
// Sources: OpenStreetMap contributors (ODbL); Stadt Bern geoportal, Kanton Bern (opendata.swiss terms_open);
// SBB (data.sbb.ch); Velospot (GBFS). Toilets, all of Switzerland: OpenStreetMap, station toilets from ATLAS
// (opentransportdata.swiss), Stadt Zürich, Kanton Basel-Stadt (CC BY 4.0), Ville de Genève, Stadt Luzern,
// Stadt St.Gallen (CC BY 4.0), Stadt Zug, Stadt Bern. Addresses that the sources lack: swisstopo, Amtliches
// Gebäudeadressverzeichnis. The records are merged across sources and shortened.
// Rows: [lon, lat, category, name or 0, details?]
// Details: a address, h opening hours, w wheelchair, f fee (no, yes, mixed), pr price, ft what the fee is for,
// p phone, u website, l level, d description, k access (unsure = may be shut or locked), c changing table,
// tw wheelchair toilet, e Eurokey,
// o run by, s source (index into sources, 0 = OpenStreetMap).
window.MAP_PLACES = ${JSON.stringify({ generated, sources: SOURCES, cats, items: out })};
`;
writeFileSync(new URL('../map-places.js', import.meta.url), js);

const perGroup = {};
for (const r of out) { const g = cats[r[2]][0]; perGroup[g] = (perGroup[g] || 0) + 1; }
console.log(`map-places.js: ${out.length} places (${mergedTwins} OSM doubles and ${mergedOfficial} official items merged into OSM ones), ${(js.length / 1e6).toFixed(2)} MB`);
console.log(perGroup);
console.log(`toilets: ${toilets.items.length - toiletsHidden} from data/ch/toilets-ch.json (${toiletsHidden} that are not for the public left out)`);
const k = {};
for (const r of out) if (cats[r[2]][0] === 'toilets' && r[4] && r[4].k) k[r[4].k] = (k[r[4].k] || 0) + 1;
console.log('toilets with limited access:', k);
