// Builds map-places/ (what the map shows and the search looks through: an index and one file per tile) from
// data/amenities.json, data/places.json, data/official-places.json (Bern), the Switzerland-wide OpenStreetMap files
// data/ch/osm-<category>.json and data/ch/osm-places-<group>.json.gz, the official points of data/ch/official-ch.json
// and the toilets of data/ch/toilets-ch.json. Run from the repo root after refreshing any of them:
//   node tools/build-map-places.mts
// Toilets come from data/ch/toilets-ch.json (tools/build-toilets-ch.mts: OpenStreetMap merged with station
// toilets, the cities' own lists and the Nette Toilette restaurants), not from the raw OpenStreetMap ones in
// amenities.json. data/toilets.json (Bern) adds the notes the Swiss file leaves out.
// Each data category is sorted into a map group with map-layers.ts's classify(). An OpenStreetMap object found in
// several files is kept once (Bern's record first, the others fill in what it lacks), and an official item is
// dropped when OSM has the same kind of thing within 25 m (its missing details are filled in from the official one).
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { MAP_LAYERS } from '../src/map-layers.ts';
import type { MapGroupKey, PlaceClass } from '../src/map-layers.ts';

// ---- The types: what this script reads from data/ (the fields it uses), and the one shape it brings every source into ----
// What it writes is the page's MapPlaces (src/types/data.d.ts); classify(), GROUPS and GLYPHS are the app's (src/map-layers.ts).

/** A data file: when it was fetched, and its records. */
interface DataFile<T> { generated: string; items: T[] }
/** A record of data/amenities.json or data/places.json (docs/places-data.md): an OpenStreetMap object, its tags as OpenStreetMap writes them. */
interface OsmItem {
  /** 'node/123', 'way/456' */
  id: string;
  lat: number;
  lon: number;
  /** 'pharmacy', 'drinking_water', 'cafe' */
  category: string;
  /** places.json only: 'food_drink', 'shopping', … */
  group?: string;
  name: string | null;
  /** 'Neuengasse 15, 3011 Bern'; in data/ch/osm-toilets.json the street and number only */
  address: string | null;
  /** The parts of the address: places.json has all four, data/ch/osm-toilets.json the postcode and the city */
  street?: string | null;
  housenumber?: string | null;
  postcode?: string | null;
  city?: string | null;
  opening_hours: string | null;
  wheelchair: string | null;
  toilets_wheelchair: string | null;
  phone: string | null;
  website: string | null;
  level: string | null;
  /** Not in data/ch/osm-toilets.json */
  description?: string | null;
  /** The next three: not in places.json */
  fee?: string | null;
  access?: string | null;
  changing_table?: string | null;
}
/** A record of data/ch/osm-toilets.json (docs/data-ch-osm.md): the same, but the category is the file's, not the record's. */
type OsmToiletCh = Omit<OsmItem, 'category'>;
/** A record of data/ch/toilets-ch.json (docs/data-ch-toilets.md): one toilet, merged from its sources by tools/build-toilets-ch.mts. */
interface ToiletRecord {
  /** The OpenStreetMap id, or the source's own: 'zh.zueriwc/wc041', 'atlas.toilet/ch:1:sloid:…', 'nette/1' */
  id: string;
  lat: number;
  lon: number;
  name: string | null;
  /** Street and number */
  address: string | null;
  postcode: string | null;
  city: string | null;
  /** 'osm:node/1', 'zh.zueriwc/wc041 (8 m)', 'nette/3 (12 m)', 'osm-place:node/2' */
  sources: string[];
  /** OpenStreetMap's access=*: 'yes', 'customers', 'private', … */
  access: string | null;
  /** 'mixed' = the site has a free and a paying toilet */
  paid: 'free' | 'paid' | 'mixed' | null;
  /** 'CHF 1.00' */
  price: string | null;
  wheelchair: string | null;
  toilets_wheelchair: string | null;
  eurokey: string | null;
  changing_table: string | null;
  opening_hours: string | null;
  operator: string | null;
  level: string | null;
  /** The sources' remarks and the builder's own, joined with '; ' */
  notes: string | null;
}
/** A record of data/toilets.json (Bern, tools/build-toilets.mts): only its notes are taken. */
interface BernToilet { id: string; notes: string | null }
/** A record of data/official-places.json (tools/build-official-places.mts): an item of a list of the city, the canton, SBB or Velospot. */
interface OfficialPlace {
  id: string;
  /** The list it is from: 'stadtbern.Sportanlage', 'kantonbern.…', 'sbb.…', 'velospot' */
  source: string;
  lat: number;
  lon: number;
  category: string;
  name: string;
  address: string | null;
  opening_hours: string | null;
  /** 'yes', or 'limited; Lift auf Anfrage': the verdict, then the source's note */
  wheelchair_or_accessibility: string | null;
  phone: string | null;
  website: string | null;
  description: string | null;
}
/** A record of data/ch/official-ch.json (docs/data-ch-official.md): a point of a city's, a canton's or SBB's own list, all of Switzerland. */
interface OfficialChPlace {
  id: string;
  /** 'zh.brunnen', 'kantonbern.aed', 'sbb.billetautomat', … */
  source: string;
  lat: number;
  lon: number;
  category: string;
  name: string | null;
  /** Street and number */
  address: string | null;
  postcode: string | null;
  city: string | null;
  opening_hours: string | null;
  /** 'yes' | 'limited' | 'no' */
  wheelchair: string | null;
  phone: string | null;
  website: string | null;
}

/** The page's MapPlaceDetails while a place is put together: a field without a value is null, and is left out of the row. */
type PlaceDetails = { [K in keyof MapPlaceDetails]: MapPlaceDetails[K] | null };
type PlaceAccess = NonNullable<MapPlaceDetails['k']>;
/** A place of any source in one shape, before it becomes a MapPlaceRow. */
interface Place {
  id: string;
  lon: number;
  lat: number;
  /** Index into SOURCES */
  src: number;
  /** The data category, the same thing under one name ('doctor' → 'doctors'): what official items are matched to OSM ones by */
  kind: string;
  cat: PlaceClass;
  name: string | null;
  x: PlaceDetails;
}
/** What merge() needs of a place: it copies the details key by key, whatever they are. */
interface Mergeable { name: string | null; x: Record<string, unknown> }
interface LonLat { lon: number; lat: number }

const read = (f: string) => {
  const raw = readFileSync(new URL(`../${f}`, import.meta.url));
  return JSON.parse((f.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
};
const { classify, GROUPS, GLYPHS } = MAP_LAYERS;

const amenities = read('data/amenities.json') as DataFile<OsmItem>;
const places = read('data/places.json') as DataFile<OsmItem>;
const official = read('data/official-places.json') as DataFile<OfficialPlace>;
const toilets = read('data/ch/toilets-ch.json') as DataFile<ToiletRecord>;
const bernToilets = read('data/toilets.json') as DataFile<BernToilet>;
const osmToiletsCh = read('data/ch/osm-toilets.json') as DataFile<OsmToiletCh>;
// All of Switzerland: the basic amenities (one file per category, the category is the file's), then the places
// and the other amenities of tools/build-places-ch.mts. The toilets come from toilets-ch.json instead.
const chFiles = readdirSync(new URL('../data/ch/', import.meta.url)).sort();
const osmCh = chFiles.filter((f) => /^osm-(?!places-)[\w]+\.json$/.test(f) && f !== 'osm-toilets.json')
  .map((f) => read(`data/ch/${f}`) as DataFile<Omit<OsmItem, 'category'>> & { category: string });
const placesCh = chFiles.filter((f) => /^osm-places-[\w]+\.json\.gz$/.test(f)).map((f) => read(`data/ch/${f}`) as DataFile<OsmItem>);
if (!placesCh.length) throw new Error('data/ch/osm-places-*.json.gz missing: run node tools/build-places-ch.mts first');
const officialCh = read('data/ch/official-ch.json') as DataFile<OfficialChPlace>;

const SOURCES = ['OpenStreetMap', 'Stadt Bern', 'Kanton Bern', 'SBB', 'Velospot'];
// data/ch/official-ch.json: the categories the map shows from it (toilets come from toilets-ch.json, which has
// these lists merged already; fountains whose water may not be drinkable, hospitals listed per department, helipads
// and emergency meeting points are left out), and who each source is
const OFFICIAL_CH_KINDS = new Set(['drinking_water', 'aed', 'ticket_machine', 'waiting_room', 'wifi', 'pharmacy', 'post_office', 'library']);
const OFFICIAL_CH_SOURCES: Record<string, string> = {
  zh: 'Stadt Zürich', bs: 'Kanton Basel-Stadt', ge: 'Canton de Genève', lu: 'Stadt Luzern', sg: 'Stadt St.Gallen', zg: 'Stadt Zug',
  biel: 'Stadt Biel', kantonbern: 'Kanton Bern', bl: 'Kanton Basel-Landschaft', sbb: 'SBB',
};
// Staffed places have their point on the building or at the door: an official one this close to OSM's is the same
const OFFICIAL_NEAR_M: Record<string, number> = { pharmacy: 75, post_office: 75, library: 75 };
// Who a toilet record comes from, by the key its sources start with (docs/data-ch-toilets.md)
const TOILET_SOURCES: Record<string, string> = {
  osm: 'OpenStreetMap', 'osm-place': 'OpenStreetMap', nette: 'Stadt Bern', atlas: 'opentransportdata.swiss', 'atlas.toilet': 'opentransportdata.swiss',
  'zh.zueriwc': 'Stadt Zürich', 'bs.wc': 'Kanton Basel-Stadt', 'ge.wc': 'Ville de Genève', 'lu.wc': 'Stadt Luzern',
  'sg.wc': 'Stadt St.Gallen', 'zg.stadtmobiliar': 'Stadt Zug',
};
const sourceId = (label: string) => (SOURCES.includes(label) ? SOURCES.indexOf(label) : SOURCES.push(label) - 1);
const sourceIndex = (key: string) => (key.startsWith('stadtbern') ? 1 : key.startsWith('kantonbern') ? 2 : key.startsWith('sbb') ? 3 : key === 'velospot' ? 4 : 0);
// Same kind of thing under different names, for matching official items to OSM ones
const SAME: Record<string, string> = { bike_share: 'bicycle_rental', sports: 'sports_centre', doctor: 'doctors', charging_station: 'ev_charging' };
// Official names that only repeat the category
const GENERIC_NAME = /^(Aufmerksamkeitsfeld|akustisches Uebergangssignal.*|Billetautomat .*|Billetentwerter .*)$/i;

const clip = (s: string | null | undefined, n = 180) => {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};
const yesNo = (v: string | null | undefined) => (v == null ? null : /^(yes|designated|only|ja)\b/i.test(v) ? 'yes' : /^(no|nein)\b/i.test(v) ? 'no' : /^limited\b/i.test(v) ? 'limited' : null);
const fee = (v: string | null | undefined) => (v == null ? null : /^no$/i.test(v) ? 'no' : /^yes$/i.test(v) || /\d/.test(v) ? 'yes' : null);
const url = (v: string | null | undefined) => {
  const s = clip(v, 300);
  if (!s) return null;
  const u = /^https?:\/\//i.test(s) ? s : /^www\./i.test(s) ? 'https://' + s : null;
  return u && u.split(/[\s;]/)[0];
};
const addressOf = (i: OsmItem) => clip(i.address
  || [[i.street, i.housenumber].filter(Boolean).join(' '), [i.postcode, i.city].filter(Boolean).join(' ')].filter(Boolean).join(', '), 120);

// → { kind, cat, name, x: details } in one shape for every source
function fromOsm(i: OsmItem, placeGroup?: string): Place {
  const access = i.access && /^(customers|private|permissive|permit)$/.test(i.access) ? i.access as PlaceAccess : null;
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
const TOILET_ACCESS: Record<string, PlaceAccess> = { customers: 'customers', guests: 'customers', permissive: 'permissive', permit: 'permit', key: 'key', centralkey: 'key', wheelchair: 'wheelchair' };
// A city lists only the toilets it opens to the public; the station list (ATLAS) says less about who may go in
const CITY_LIST = /^(zh|bs|ge|lu|sg|zg)\./;
// Notes that say the toilet is locked or shut ("Der Schlüssel muss am Billettschalter abgeholt werden",
// "Non ouverte au public"). A Eurokey is its own tag.
const LOCKED_NOTE = /nicht öffentlich|non ouverte au public|schl[üu]s+el|clé à disposition|vorübergehend geschlossen|momentan (wegen .* )?(ab)?geschlossen|ist geschlossen|abgeschlossen/i;
const EUROKEY_NOTE = /euro-?\s?key|eurokey|euroschlüssel|chiave europea/i;
function fromToilet(t: ToiletRecord, extraNotes: string[] = []): Place | null {
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
    : TOILET_ACCESS[t.access!] || (t.wheelchair === 'only' || t.toilets_wheelchair === 'only' ? 'wheelchair' : null)
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
function fromOfficial(i: OfficialPlace): Place {
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
function fromOfficialCh(i: OfficialChPlace): Place {
  const town = [i.postcode, i.city].filter(Boolean).join(' ');
  const o = fromOfficial({ id: i.id, source: i.source, lat: i.lat, lon: i.lon, category: i.category, name: i.name || '',
    address: [i.address, i.address && i.postcode && i.address.includes(i.postcode) ? '' : town].filter(Boolean).join(', ') || null,
    opening_hours: i.opening_hours, wheelchair_or_accessibility: i.wheelchair, phone: i.phone, website: i.website, description: null });
  o.src = sourceId(OFFICIAL_CH_SOURCES[i.source.split('.')[0]] || i.source);
  return o;
}
// data/ch/osm-<category>.json has the street and the town apart: "Neuengasse 15" + 3011 Bern → "Neuengasse 15, 3011 Bern"
const chAddress = (i: Omit<OsmItem, 'category'>) => [i.address, [i.postcode, i.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null;

const metres = (a: LonLat, b: LonLat) => {
  const dx = (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180), dy = (a.lat - b.lat) * 110540;
  return Math.hypot(dx, dy);
};

// OSM: amenities first; places.json repeats some of the same OSM objects with more detail
const byId = new Map<string, Place>();
const merge = (into: Mergeable, from: Mergeable) => { for (const k in from.x) if (into.x[k] == null && from.x[k] != null) into.x[k] = from.x[k]; if (!into.name) into.name = from.name; };
const osmToilets = new Map<string, OsmItem | OsmToiletCh>(); // the toilets go in from data/ch/toilets-ch.json below
for (const i of amenities.items) {
  if (i.category === 'toilets') osmToilets.set(i.id, i);
  else byId.set(i.id, fromOsm(i));
}
const add = (p: Place) => {
  const had = byId.get(p.id);
  if (had) merge(had, p);
  else byId.set(p.id, p);
};
for (const i of places.items) add(fromOsm(i, i.group));
// The rest of Switzerland, in the same order (amenities, then places): an object Bern's files have keeps Bern's
// record, which gets what it lacks from these
let chAmenities = 0, chPlaces = 0;
for (const f of osmCh) for (const i of f.items) { add(fromOsm({ ...i, category: f.category, address: chAddress(i) })); chAmenities++; }
for (const f of placesCh) for (const i of f.items) {
  if (i.category === 'toilets') continue;
  add(fromOsm(i, i.group));
  if (i.group) chPlaces++; else chAmenities++;
}
// The same named place mapped twice in OSM (e.g. a shop as a point and as a building): keep it once
function fold(t: string) { return String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
const items: Place[] = [];
const byName = new Map<string, Place[]>();
let mergedTwins = 0;
for (const it of byId.values()) {
  if (it.name) {
    const key = it.kind + '|' + fold(it.name);
    const twin = (byName.get(key) || []).find((o) => metres(o, it) <= 60);
    if (twin) { merge(twin, it); mergedTwins++; continue; }
    (byName.get(key) || byName.set(key, []).get(key)!).push(it);
  }
  items.push(it);
}

// Toilets: already merged across their sources, so they skip the step above. The OpenStreetMap record adds
// what the toilet file leaves out (website, phone), and Bern's own toilet file its notes ("Pissoir", "Nur im
// Sommer", a Nette Toilette only OpenStreetMap knows), under the same id.
const bernNotes = new Map<string, string[]>(bernToilets.items.map((t) => [t.id.replace(/^atlas\//, 'atlas.toilet/'), (t.notes || '').split(/;\s+/).filter(Boolean)]));
for (const i of osmToiletsCh.items) if (!osmToilets.has(i.id)) osmToilets.set(i.id, i);
let toiletsHidden = 0;
const toiletIds = new Set<string>();
for (const t of toilets.items) {
  toiletIds.add(t.id);
  const it = fromToilet(t, bernNotes.get(t.id));
  if (!it) { toiletsHidden++; continue; }
  const osm = osmToilets.get(t.id);
  if (osm) { const o = fromOsm(osm as OsmItem); for (const k of ['p', 'u'] as const) if (it.x[k] == null) it.x[k] = o.x[k]; }
  items.push(it);
}
// Every Bern toilet has to be in the Swiss file, or it would drop off the map unnoticed
const lost = [...bernNotes.keys()].filter((id) => !toiletIds.has(id));
if (lost.length) throw new Error(`data/toilets.json has toilets that data/ch/toilets-ch.json lacks: ${lost.join(', ')}`);

// Official items: skip when OSM already has the same kind within 25 m
const CELL = 0.0005; // ~40-55 m grid for the lookup
const grid = new Map<string, Place[]>();
const cellKey = (lon: number, lat: number) => `${Math.floor(lon / CELL)},${Math.floor(lat / CELL)}`;
for (const it of items) {
  const k = cellKey(it.lon, it.lat);
  (grid.get(k) || grid.set(k, []).get(k)!).push(it);
}
let mergedOfficial = 0;
const twinOf = (o: Place, m: number, any: boolean) => {
  const r = Math.ceil(m / 40); // cells to look through on each side
  const cx = Math.floor(o.lon / CELL), cy = Math.floor(o.lat / CELL);
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
    for (const it of grid.get(`${cx + dx},${cy + dy}`) || []) {
      if ((any || it.src === 0) && it.kind === o.kind && metres(it, o) <= m) return it;
    }
  }
  return null;
};
const keep = (o: Place) => {
  items.push(o);
  const k = cellKey(o.lon, o.lat);
  (grid.get(k) || grid.set(k, []).get(k)!).push(o);
};
for (const i of official.items) {
  if (i.lat == null || i.lon == null) continue;
  const o = fromOfficial(i);
  const twin = twinOf(o, 25, false);
  if (twin) { merge(twin, o); mergedOfficial++; continue; }
  keep(o);
}
// The official lists of the rest of Switzerland: also the same as one of Bern's official items nearby (the canton's
// defibrillators are in both, under other ids)
let officialChKept = 0;
for (const i of officialCh.items) {
  if (!OFFICIAL_CH_KINDS.has(i.category) || i.lat == null || i.lon == null) continue;
  const o = fromOfficialCh(i);
  const twin = twinOf(o, OFFICIAL_NEAR_M[o.kind] || 25, true);
  if (twin) { merge(twin, o); mergedOfficial++; continue; }
  keep(o);
  officialChKept++;
}

// Compact output: a category table and one short array per item
const groupKeys = new Set(GROUPS.map((g) => g.key));
const cats: PlaceClass[] = [];
const catIndex = new Map<string, number>();
const out: MapPlaceRow[] = [];
for (const it of items) {
  const [group, glyph, rank, label] = it.cat;
  if (!groupKeys.has(group) || !GLYPHS[glyph]) throw new Error(`Unknown group/glyph ${group}/${glyph} for ${it.id}`);
  if (![1, 2, 3, 4, 5].includes(rank)) throw new Error(`Rank ${rank} for ${it.id} is not 1–5`);
  const ck = `${group}|${glyph}|${rank}|${label}`;
  if (!catIndex.has(ck)) { catIndex.set(ck, cats.length); cats.push([group, glyph, rank, label]); }
  const x: MapPlaceDetails = {};
  for (const k in it.x) if (it.x[k as keyof PlaceDetails] != null) (x as Record<string, unknown>)[k] = it.x[k as keyof PlaceDetails];
  if (it.src) x.s = it.src;
  const row: MapPlaceRow = [+it.lon.toFixed(6), +it.lat.toFixed(6), catIndex.get(ck)!, it.name || 0];
  if (Object.keys(x).length) row.push(x);
  out.push(row);
}
// Stable order, so a rebuild from the same data gives the same file
out.sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);

// Tiles: a grid of 1/8° (about 9.5 × 14 km), a tile with more than MAX_ROWS places cut into four, again and again
// (down to 1/128°), so a city centre comes in several small files and the countryside in a few big ones. A tile's
// file name is its level and its column and row on that level's grid: 4-123-750 = west 123/16°, south 750/16°.
const BASE_LEVEL = 3, MAX_LEVEL = 7, MAX_ROWS = 5000;
const tiles: { key: string; level: number; x: number; y: number; rows: MapPlaceRow[] }[] = [];
function cut(rows: MapPlaceRow[], level: number, x: number, y: number) {
  if (rows.length <= MAX_ROWS || level >= MAX_LEVEL) { tiles.push({ key: `${level}-${x}-${y}`, level, x, y, rows }); return; }
  const n = 2 ** (level + 1), kids = new Map<string, MapPlaceRow[]>();
  for (const r of rows) { const k = `${Math.floor(r[0] * n)},${Math.floor(r[1] * n)}`; (kids.get(k) || kids.set(k, []).get(k)!).push(r); }
  for (const [k, kidRows] of kids) { const [kx, ky] = k.split(',').map(Number); cut(kidRows, level + 1, kx, ky); }
}
const base = new Map<string, MapPlaceRow[]>();
for (const r of out) { // in the stable order above, which every tile keeps
  const k = `${Math.floor(r[0] * 2 ** BASE_LEVEL)},${Math.floor(r[1] * 2 ** BASE_LEVEL)}`;
  (base.get(k) || base.set(k, []).get(k)!).push(r);
}
for (const [k, rows] of base) { const [x, y] = k.split(',').map(Number); cut(rows, BASE_LEVEL, x, y); }
tiles.sort((a, b) => (a.key < b.key ? -1 : 1));

const generated = [amenities.generated, places.generated, official.generated, toilets.generated, officialCh.generated,
  ...osmCh.map((f) => f.generated), ...placesCh.map((f) => f.generated)].sort().pop()!;
const about = `Generated by tools/build-map-places.mts from data/*.json and data/ch/* (${generated}). Do not edit by hand. `
  + 'Sources: OpenStreetMap contributors (ODbL); Stadt Bern geoportal, Kanton Bern (opendata.swiss terms_open); SBB (data.sbb.ch); '
  + 'Velospot (GBFS); official lists of Stadt Zürich, Kanton Basel-Stadt (CC BY 4.0), Kanton Basel-Landschaft (CC BY), Canton and Ville de Genève, '
  + 'Stadt Luzern, Stadt St.Gallen (CC BY 4.0), Stadt Zug, Stadt Biel; station toilets from ATLAS (opentransportdata.swiss). '
  + 'Addresses that the sources lack: swisstopo, Amtliches Gebäudeadressverzeichnis. The records are merged across sources and shortened. '
  + 'tiles: [file name in map-places/, west, south, east, north, places]. A tile file is { v: version, rows }, a row [lon, lat, category (index into cats), name or 0, details?]. '
  + 'Details: a address, h opening hours, w wheelchair, f fee (no, yes, mixed), pr price, ft what the fee is for, p phone, u website, l level, '
  + 'd description, k access (unsure = may be shut or locked), c changing table, tw wheelchair toilet, e Eurokey, o run by, s source (index into sources, 0 = OpenStreetMap).';
const dir = new URL('../map-places/', import.meta.url);
rmSync(dir, { recursive: true, force: true }); // tiles of an earlier build that this one cuts differently
mkdirSync(dir, { recursive: true });
// v: the tables the rows point into (cats, sources). A tile from another build with other tables (a cached one) is
// told apart by it, and not read with the wrong categories.
const version = createHash('sha1').update(JSON.stringify([cats, SOURCES])).digest('hex').slice(0, 10);
let bytes = 0, gz = 0, biggest = 0;
const save = (name: string, json: string) => {
  writeFileSync(new URL(name, dir), json);
  bytes += Buffer.byteLength(json);
  gz += gzipSync(json).length;
};
for (const t of tiles) {
  const json = JSON.stringify({ v: version, rows: t.rows } satisfies MapPlaceTileFile);
  biggest = Math.max(biggest, Buffer.byteLength(json));
  save(`${t.key}.json`, json);
}
const index: MapPlacesIndex = { generated, version, about, sources: SOURCES, cats, tiles: tiles.map((t) => {
  const n = 2 ** t.level;
  return [t.key, t.x / n, t.y / n, (t.x + 1) / n, (t.y + 1) / n, t.rows.length];
}) };
save('index.json', JSON.stringify(index));
rmSync(new URL('../map-places.js', import.meta.url), { force: true }); // the single file of the builds before the tiles

const perGroup: Partial<Record<MapGroupKey, number>> = {};
for (const r of out) { const g = cats[r[2]][0]; perGroup[g] = (perGroup[g] || 0) + 1; }
console.log(`map-places/: ${out.length} places (${mergedTwins} OSM doubles and ${mergedOfficial} official items merged into OSM ones, ${officialChKept} official points of data/ch kept), `
  + `${tiles.length} tiles, ${(bytes / 1e6).toFixed(1)} MB (${(gz / 1e6).toFixed(1)} MB gzipped), biggest tile ${(biggest / 1e6).toFixed(2)} MB`);
console.log(`read: ${chAmenities} Swiss amenities and ${chPlaces} Swiss places from data/ch`);
console.log(perGroup);
console.log(`toilets: ${toilets.items.length - toiletsHidden} from data/ch/toilets-ch.json (${toiletsHidden} that are not for the public left out)`);
const k: Partial<Record<PlaceAccess, number>> = {};
for (const r of out) if (cats[r[2]][0] === 'toilets' && r[4] && r[4].k) k[r[4].k] = (k[r[4].k] || 0) + 1;
console.log('toilets with limited access:', k);
