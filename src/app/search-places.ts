// ---- Places in the search (map-places.js: Bern, toilets everywhere): a kind of place ("pharmacy", "wc", "apotheke", "closest toilet")
//      lists the nearest ones; a name ("Migros", "Amavita") lists the places called that, nearest first ----
import { map } from './map.ts';
import { gpsOn, userLngLat } from './location.ts';
import { KIND, isPlaceResult, list, parseResult } from './search.ts';
import { render } from './search-pins.ts';
import { GROUP_BY_KEY, PLACES, loadPlaces } from './map-places.ts';
import { fmtDist } from './live-vehicles.ts';
import { distKm } from './routing.ts';
import { searchState } from './state.ts';
import { PlaceSearch, wikidataImages } from '../places.ts';
import { openState } from '../opening-hours.ts';
import { KANTE } from '../engine.ts';
import { PLATFORMS, platformKey } from './platforms.ts';
import { MAP_LAYERS } from '../map-layers.ts';
import type { PlaceBbox, PlacePrediction, PlaceSearchAnswer, PlaceSearchResult } from '../places.ts';
import type { LngLatFirst, PlaceMatches, SearchIcon, SearchResult, SwisstopoSearchAnswer } from './search.ts';
export const fold = (s: string | number) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss');
const stem = (w: string) => (w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y'
  : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const wordsOf = (s: string) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);
// "closest pharmacy", "nächste Apotheke", "toilet near me" → pharmacy, apotheke, toilet
const NEAR_WORDS = new Set(['closest', 'nearest', 'near', 'nearby', 'me', 'next', 'the', 'a', 'an', 'find', 'where', 'is',
  'around', 'here', 'my', 'nachste', 'nachster', 'nachstes', 'nachsten', 'in', 'der', 'die', 'das', 'nahe', 'wo', 'ist',
  'ein', 'eine', 'mir', 'bei', 'plus', 'proche', 'le', 'la']);
export const NEAR_PHRASE = /^(closest|nearest|next|n[aä]chste[rsn]?)\s+|\s+(near me|nearby|in der n[aä]he)$/gi;
const SEARCH_ALIASES = Object.fromEntries(Object.entries(MAP_LAYERS.SEARCH_ALIASES).map(([k, v]) => [stem(fold(k)), v]));
const NAMED_BY_PLACE = new Set(['Info stand / kiosk', 'Mobile recycling point', 'Recycling', 'Bike pump', 'Bike parking',
  'Disabled parking', 'Taxi rank', 'Car sharing', 'EV parking', 'Tactile paving', 'Acoustic crossing signal']);
interface PlaceSearchIndex {
  /** Per kind of place (PLACES.cats): the words of its label, and of its group's name. */
  cat: string[][];
  group: string[][];
  /** Per place (PLACES.items): its name, folded; '' when it has none. */
  names: string[];
  toilets: MapPlaceRow[];
}
let placeIndex: PlaceSearchIndex | null = null;
function placeSearchIndex() {
  if (!placeIndex && PLACES) {
    const labelWords = (s: string) => wordsOf(s).map(stem);
    placeIndex = {
      cat: PLACES.cats.map(([, , , label]) => labelWords(label)),
      group: PLACES.cats.map(([g]) => labelWords(GROUP_BY_KEY[g].label)),
      names: PLACES.items.map((r) => (r[3] ? fold(r[3]) : '')),
      toilets: PLACES.items.filter((r) => PLACES!.cats[r[2]][0] === 'toilets'),
    };
  }
  return placeIndex;
}
function placeResult(row: MapPlaceRow, km: number): SearchResult {
  const [g, glyph, , label] = PLACES!.cats[row[2]];
  const group = GROUP_BY_KEY[g];
  const x = row[4] || {};
  const open = openState(x.h);
  return {
    // what the place card shows of it, without a request
    category: label,
    address: x.a || '',
    info: { openingHours: x.h, phone: x.p, website: x.u },
    openNow: open ? open.open : null,
    openText: open ? open.text : '',
    title: row[3] || label,
    // "Pharmacy · 120 m · Neuengasse 15": the street tells apart branches with the same name
    subtitle: [row[3] ? label : '', fmtDist(km * 1000), row[4] && row[4].a && /\d/.test(row[4].a.split(',')[0]) ? row[4].a.split(',')[0] : ''].filter(Boolean).join(' · '),
    kind: 'place',
    origin: 'place',
    distance: km * 1000,
    icon: { color: `var(--${group.color})`, fg: group.color === 'sun' ? '#344D77' : '', svg: `<path d="${MAP_LAYERS.GLYPHS[glyph]}"/>` },
    lngLat: [row[0], row[1]],
  };
}
// → { kinds: nearest places of the kind asked for, names: places whose name matches, toilets: a toilet was asked for }
// Where a search measures from: you, while the map shows where you are; the middle of the map once you have moved
// it somewhere else (looking for a Coop in another part of town)
export const searchOrigin = (): LngLat => (gpsOn() && map.getBounds().contains(userLngLat!) ? userLngLat! : map.getCenter().toArray());
// many: for "Search this area", which keeps the ones in view (the list only needs the nearest few)
export function searchPlaces(text: string, many?: boolean): PlaceMatches {
  const idx = placeSearchIndex();
  const plain = wordsOf(text).filter((w) => !NEAR_WORDS.has(w));
  if (!idx || !plain.length) return { kinds: [], names: [], toilets: false };
  const from = searchOrigin();
  const near = (rows: MapPlaceRow[], n: number) => rows.map((r): [MapPlaceRow, number] => [r, distKm(from, r)]).sort((a, b) => a[1] - b[1]).slice(0, n);

  // a kind of place: every word of the query (after aliases) starts a word of its label or of its group's name
  // ("health" → pharmacies, doctors, hospitals…)
  const tokens = plain.map(stem).flatMap((w) => (SEARCH_ALIASES[w] ? wordsOf(SEARCH_ALIASES[w]).map(stem) : [w]));
  const fits = (label: string[]) => tokens.every((t) => label.some((w) => w === t || (t.length >= 3 && w.startsWith(t))));
  let cats = idx.cat.map((label, i) => (fits(label) || fits(idx.group[i]) ? i : -1)).filter((i) => i >= 0);
  // A word that only starts a kind ("coop" → Cooperative) but is the whole name of places (Coop) asks for
  // those places: the kind needs a word of its own then ("cooperative")
  const whole = (label: string[]) => tokens.every((t) => label.some((w) => w === t));
  if (cats.length && !cats.some((i) => whole(idx.cat[i]) || whole(idx.group[i]))
    && idx.names.some((name) => name && plain.every((w) => wordsOf(name).includes(w)))) cats = [];
  const catSet = new Set(cats);
  // "closest toilet" is asked by someone who needs one now: not the ones for customers, with a key or a permit,
  // or that may be locked. "customer toilet" still lists those for customers.
  const toilets = cats.length > 0 && cats.every((i) => PLACES!.cats[i][0] === 'toilets');
  const customerAsked = cats.length > 0 && cats.every((i) => PLACES!.cats[i][3] === 'Customer toilet');
  const forAll = (r: MapPlaceRow) => !(r[4] && r[4].k && r[4].k !== 'permissive' && PLACES!.cats[r[2]][0] === 'toilets')
    || (customerAsked && r[4].k === 'customers');
  // Bern's places (all but the toilets) say nothing about elsewhere: the nearest of a kind count within 10 km
  const kinds = cats.length ? near(PLACES!.items.filter((r) => catSet.has(r[2]) && forAll(r)), many ? 40 : 6).filter(([, km]) => km <= 10) : [];

  // a name: every word appears in it. Stops and stations come from the swisstopo search instead, and some official
  // items are only named after where they stand ("Bahnhofplatz 1"), so they don't count as names.
  const names: [MapPlaceRow, number][] = [];
  if (plain.join('').length >= 3) {
    const shown = new Set(kinds.map(([r]) => r));
    const rows: MapPlaceRow[] = [];
    idx.names.forEach((name, i) => {
      const r = PLACES!.items[i];
      if (!name || shown.has(r) || catSet.has(r[2]) || !plain.every((w) => name.includes(w))) return;
      const [g, , , label] = PLACES!.cats[r[2]];
      if (g === 'transit' || NAMED_BY_PLACE.has(label) || (r[4] && r[4].a && fold(r[4].a).startsWith(name))) return;
      rows.push(r);
    });
    const starts = (r: MapPlaceRow) => (fold(r[3]).startsWith(plain[0]) ? 0 : 1);
    names.push(...rows.map((r): [MapPlaceRow, number] => [r, distKm(from, r)]).sort((a, b) => starts(a[0]) - starts(b[0]) || a[1] - b[1]).slice(0, many ? 40 : 5));
  }
  return { kinds: kinds.map(([r, km]) => placeResult(r, km)), names: names.map(([r, km]) => placeResult(r, km)), toilets };
}

// Addresses, towns, postcodes, mountains, lakes: swisstopo
async function searchSwisstopo(text: string): Promise<SearchResult[]> {
  const url = 'https://api3.geo.admin.ch/rest/services/api/SearchServer?' + new URLSearchParams({
    searchText: text,
    type: 'locations',
    origins: 'zipcode,gg25,gazetteer,address',
    sr: '4326',
    limit: '15',
    lang: (window.APP_LANG?.pick(['de', 'fr', 'it', 'rm', 'en']) ?? 'en'),
  });
  const res = await fetch(url);
  const data: SwisstopoSearchAnswer = await res.json();
  const seen = new Set<string>();
  return (data.results || []).map((r): SearchResult => ({
    ...parseResult(r.attrs),
    origin: r.attrs.origin,
    lngLat: [r.attrs.lon, r.attrs.lat],
  })).filter((r) => {
    const key = (r.title + '|' + r.subtitle).toLowerCase();
    if (!r.title || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Stops and stations, streets and house numbers, places: the Kante engine's own search (kante/engine/crates/search),
// which knows every stop of the timetable and ranks them by how much is served there, reads "HB", "Bhf", "Genf",
// ae/oe/ue and one typo, and puts nearer ones first among equals. null while the engine is off or does not answer.
const MODE_WORD: Partial<Record<KanteMode, string>> = { rail: 'Train', tram: 'Tram', bus: 'Bus', metro: 'Metro', boat: 'Boat',
  funicular: 'Funicular', cableway: 'Cable car', rack: 'Rack railway', lift: 'Lift' };
// The engine's icon for a place (cats::icon in kante/engine/crates/search) → the map's glyph and colour for that
// kind of place, and the kind of result it is
const ICON_PATH: Record<string, string> = {
  plane: 'M10.5 4.5a1.5 1.5 0 0 1 3 0V9l7.5 4.5v2L13.5 13v4.5l2 1.5v1.5L12 19.5l-3.5 1V19l2-1.5V13L3 15.5v-2L10.5 9z',
  castle: 'M4 21V8h3v2.5h2V8h2v2.5h2V8h2v2.5h2V8h3v13zM10 21v-3.5a2 2 0 0 1 4 0V21',
  scissors: 'M3.5 6a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M3.5 18a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M8 7.5L20 18M8 16.5L20 6',
  tent: 'M2.5 20h19M12 4L3.5 20M12 4l8.5 16M12 13l-3 7M12 13l3 7',
  mask: 'M4 5h16v7a8 8 0 0 1-16 0zM8.5 10h.01M15.5 10h.01M9 14.5a4 4 0 0 0 6 0',
  bread: 'M5 11a7 4.5 0 0 1 14 0v8H5zM9 9.5v3M12 9v3M15 9.5v3',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM9.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0',
};
const ENGINE_ICON: Record<string, [glyph: string, color: 'navy' | 'rose' | 'sun' | 'tang', kind: SearchResult['kind']]> = {
  restaurant: ['fork', 'tang', 'food'], fast_food: ['fork', 'tang', 'food'], cafe: ['cup', 'tang', 'cafe'], bar: ['glass', 'rose', 'bar'],
  ice_cream: ['icecream', 'tang', 'cafe'], bakery: ['bread', 'tang', 'cafe'], grocery: ['cart', 'rose', 'shop'], mall: ['bag', 'rose', 'shop'],
  shop: ['bag', 'rose', 'shop'], hairdresser: ['scissors', 'rose', 'shop'], pharmacy: ['cross', 'tang', 'health'],
  hospital: ['hospital', 'tang', 'health'], doctor: ['cross', 'tang', 'health'], dentist: ['tooth', 'tang', 'health'],
  hotel: ['bed', 'rose', 'bed'], hut: ['shelter', 'rose', 'bed'], camping: ['tent', 'rose', 'bed'], museum: ['building', 'rose', 'building'],
  theatre: ['mask', 'rose', 'building'], zoo: ['tree', 'sun', 'other'], castle: ['castle', 'rose', 'building'], sight: ['star', 'rose', 'building'],
  viewpoint: ['eye', 'sun', 'other'], worship: ['worship', 'navy', 'building'], school: ['school', 'navy', 'building'],
  library: ['book', 'navy', 'building'], civic: ['building', 'navy', 'building'], police: ['shield', 'navy', 'building'],
  post: ['mail', 'navy', 'building'], bank: ['cash', 'sun', 'money'], parking: ['parking', 'navy', 'other'], car: ['car', 'rose', 'other'],
  bike: ['bike', 'rose', 'other'], taxi: ['car', 'rose', 'other'], airport: ['plane', 'navy', 'building'], info: ['info', 'navy', 'other'],
  sport: ['ball', 'sun', 'sport'], swim: ['swim', 'sun', 'sport'], park: ['tree', 'sun', 'other'], office: ['briefcase', 'navy', 'building'],
};
const NATURAL_ICON: Record<string, SearchResult['kind']> = { city: 'city', village: 'city', mountain: 'mountain', water: 'water', nature: 'nature' };
function engineIcon(icon: string | undefined): { icon?: SearchIcon; kind?: SearchResult['kind'] } {
  if (!icon) return {};
  if (NATURAL_ICON[icon]) return { kind: NATURAL_ICON[icon], icon: KIND[NATURAL_ICON[icon]] };
  const e = ENGINE_ICON[icon];
  if (!e) return {};
  const color = MAP_LAYERS.COLORS[e[1]];
  return { kind: e[2], icon: { color: color.css, fg: e[1] === 'sun' ? color.ink : '', svg: `<path d="${ICON_PATH[e[0]] || MAP_LAYERS.GLYPHS[e[0]]}"/>` } };
}
const POI_KIND: [RegExp, SearchResult['kind']][] = [[/pharm|hospital|doctor|clinic|dentist/i, 'health'], [/restaurant|fast food|food/i, 'food'],
  [/caf[eé]|bakery|ice cream/i, 'cafe'], [/bar|pub/i, 'bar'], [/shop|supermarket|store|market|kiosk/i, 'shop'], [/hotel|hostel|guest/i, 'bed'],
  [/atm|cash|bank/i, 'money'], [/toilet/i, 'toilet'], [/peak|summit|mountain|viewpoint/i, 'mountain'], [/park|forest|lake|nature/i, 'nature']];
// Words that say a stop is meant ("bus stop Zytglogge", "Haltestelle Rössliplatz", "arrêt Rieu"): the engine
// wants every word to be in the name, so they are left out, and its stops go first. ("Bahnhof", "gare", "Bhf",
// "HB" stay: the engine knows them as a town's station.)
const STOP_WORDS = /\b(bus ?stop|tram ?stop|train ?station|railway station|stop|station|bushaltestelle|tramhaltestelle|haltestelle|arr[eê]t|fermata)\b/giu;
// A platform or stop edge asked for at the end: "Bern Gleis 7", "lausanne voie 70", "Zytglogge Kante B", "bern 7"
// (bare: a number or a letter alone, which may also be a house number: then the text is searched as it is too)
const PLATFORM_WORDS = /^(.+?)[\s,]+(?:(?:train|tram|bus)\s+)?(?:gleis|gl\.?|track|platform|plattform|quai|voie|v\.|binario|bin\.|kante|perron|bay|steig)\s*(\d{1,2}[a-z]?|[a-z])$/iu;
const BARE_REF = /^(.{3,}?)[\s,]+(\d{1,2}|[a-z])$/iu;
const PLATFORM_MODE: Record<string, string> = { train: 'Train', tram: 'Tram', bus: 'Bus', boat: 'Boat', cable: 'Cable car' };
export async function searchKante(text: string): Promise<SearchResult[] | null> {
  if (!KANTE.available()) return null;
  const from = searchOrigin();
  const ask = (q: string) => KANTE.search({ q, lat: from[1].toFixed(4), lon: from[0].toFixed(4), limit: 10 }).then((r) => r.results);
  const named = PLATFORM_WORDS.exec(text.trim()), bareRef = named ? null : BARE_REF.exec(text.trim());
  const platform = named || bareRef;
  const plain = (named ? named[1] : text).replace(STOP_WORDS, ' ').replace(/\s+/g, ' ').trim();
  const stopAsked = !!plain && plain !== text.replace(/\s+/g, ' ').trim();
  const slow = new Promise<null>((ok) => setTimeout(() => ok(null), 1500)); // a slow engine does not hold up the list
  const [res, stopRes] = await Promise.race([Promise.all([
    ask(stopAsked ? plain : text),
    bareRef ? ask(bareRef[1]) : Promise.resolve(null), // "bern 7": Bern's platform 7, or a house number 7
  ]), slow]) || [null, null];
  if (!res) return null;
  const results = stopAsked ? [...res.filter((p) => p.kind === 'station'), ...res.filter((p) => p.kind !== 'station')] : res;
  // the platform of the first stop found that has one of that name
  const platforms: SearchResult[] = [];
  if (platform) {
    const key = platformKey(platform[2]);
    for (const p of (stopRes || results).filter((x) => x.kind === 'station').slice(0, 2)) {
      const st = PLATFORMS.get(KANTE.uicOf(p.id) || '');
      const e = st && st.edges.find((x) => x.key === key);
      if (!st || !e) continue;
      const km = distKm(from, e.ll);
      platforms.push({ title: `${st.name}, platform ${e.ref}`, subtitle: [PLATFORM_MODE[st.mode] || 'Stop', fmtDist(km * 1000)].join(' · '),
        kind: 'station', origin: 'kante', lngLat: e.ll, distance: km * 1000 });
      break;
    }
  }
  return [...platforms, ...results.map((p): SearchResult => {
    const dist = p.distM != null ? fmtDist(p.distM) : '';
    const base = { title: p.name, origin: 'kante' as const, lngLat: [p.lon, p.lat] as LngLat, distance: p.distM ?? null, kanteId: p.id };
    if (p.kind === 'station') {
      const modes = [...new Set((p.modes || []).map((m) => MODE_WORD[m]).filter(Boolean))];
      return { ...base, kind: 'station', subtitle: [modes.join(', ') || 'Stop', dist].filter(Boolean).join(' · ') };
    }
    if (p.kind === 'address') return { ...base, kind: 'address', subtitle: p.detail || '' };
    // a place: "Restaurant · Spitalgasse 4, Bern" → "Restaurant · Italian · 120 m · Spitalgasse 4, Bern", with the
    // icon of its kind and the photo OpenStreetMap links (or, later, Wikidata's: fillPhotos)
    const [what, ...where] = (p.detail || '').split(' · ');
    const known = engineIcon(p.icon);
    const kind = known.kind || (POI_KIND.find(([re]) => re.test(what)) || [null, 'other'])[1];
    const info = p.info || {};
    // what it serves: its first cuisine, else "Vegan" / "Vegetarian" for a place that serves nothing else; not when
    // that is what it is anyway (an ice cream parlour serving ice cream)
    const dish = (info.cuisine || '').split(', ')[0] || (info.diet === 'Vegan' || info.diet === 'Vegetarian' ? info.diet : '');
    const serves = fold(dish) === fold(what) ? '' : dish;
    const open = openState(info.openingHours);
    return { ...base, kind, icon: known.icon, info: p.info, photo: info.image || undefined,
      category: [what, serves].filter(Boolean).join(', '), address: where.join(' · '), openNow: open ? open.open : null, openText: open ? open.text : '',
      subtitle: [what, serves, dist, where.join(' · ')].filter(Boolean).join(' · ') };
  })];
}

// Photos for the engine's places that OpenStreetMap only links to Wikidata: the place's own photo, else its brand's
// logo (a Migros, a Coop). Fills `photo` in place; true when it found any.
export async function fillPhotos(results: SearchResult[] | null): Promise<boolean> {
  const want = (results || []).filter((r) => !r.photo && r.info && (r.info.wikidata || r.info.brandWikidata)).slice(0, 12);
  if (!want.length) return false;
  const pics = await wikidataImages(want.flatMap((r): [string, 'P18' | 'P154'][] =>
    [...(r.info!.wikidata ? [[r.info!.wikidata, 'P18'] as [string, 'P18']] : []), ...(r.info!.brandWikidata ? [[r.info!.brandWikidata, 'P154'] as [string, 'P154']] : [])]));
  let any = false;
  for (const r of want) {
    const own = r.info!.wikidata && pics.get(`${r.info!.wikidata}:P18`);
    const logo = r.info!.brandWikidata && pics.get(`${r.info!.brandWikidata}:P154`);
    if (own) { r.photo = own; any = true; } else if (logo) { r.photo = logo; r.photoIsLogo = true; any = true; }
  }
  return any;
}

// Restaurants, shops, cafés, … anything with a name, all over Switzerland (places.ts: OpenStreetMap, or Google
// with a key): around the part of the map in view, with distances from you (or from the middle of the map once it
// shows somewhere else). bbox [west, south, east, north]: only places inside it ("Search this area").
// google: false asks OpenStreetMap only, even with a Google key (typing: Google's predictions are cheaper, suggest()).
export function searchPlacesOnline(text: string, bbox?: PlaceBbox, google = true): Promise<PlaceSearchAnswer | null> {
  if (!PlaceSearch) return Promise.resolve(null);
  const center = map.getCenter().toArray();
  const corner = map.getBounds().getNorthEast().toArray();
  const viewKm = Math.hypot((corner[0] - center[0]) * 76, (corner[1] - center[1]) * 111); // km at Swiss latitudes
  const radiusKm = Math.min(Math.max(viewKm, 1), 10);
  const timeout = new Promise<never>((_, fail) => setTimeout(() => fail(new Error('timeout')), 4000));
  return Promise.race([PlaceSearch.search(text, { center, origin: searchOrigin(), radiusKm, bbox, google }), timeout]);
}

// Google's predictions while typing: one that is a row of the list already (the same name, about as far away) gives
// that row its Google id (its card then shows Google's details); the others are listed after the rows.
export function attachPredictions(results: SearchResult[], predictions: PlacePrediction[]): PlacePrediction[] {
  const rest: PlacePrediction[] = [];
  for (const p of predictions) {
    const t = fold(p.title);
    const twins = results.filter((r) => {
      if (!isPlaceResult(r) || (r.googleId && r.googleId !== p.placeId)) return false;
      const n = fold(r.title);
      return (n === t || (Math.min(n.length, t.length) >= 4 && (n.startsWith(t) || t.startsWith(n))))
        && p.distance != null && r.distance != null && Math.abs(p.distance - r.distance) < 100;
    });
    // only when it can be no other row: two branches of the same name about as far away are not told apart
    // (the card then checks that Google's point is the row's: place-sheet.ts)
    const sameName = results.filter((r) => isPlaceResult(r) && fold(r.title) === fold(twins[0] ? twins[0].title : '')).length;
    if (twins.length === 1 && sameName <= 1) twins[0].googleId = p.placeId;
    else rest.push(p);
  }
  return rest.slice(0, 5);
}

const nearM = (a: LngLatFirst, b: LngLatFirst, m: number) => Math.hypot((a[0] - b[0]) * 76000, (a[1] - b[1]) * 111000) < m;

// The same thing from two sources: the same name at the same spot, or the same address
const sameAs = (a: SearchResult, b: SearchResult) => (fold(a.title) === fold(b.title) && nearM(a.lngLat, b.lngLat, 200))
  || (a.kind === 'address' && b.kind === 'address' && nearM(a.lngLat, b.lngLat, 30));

// One list from the sources: the engine's search (Kante), our own places (map-places.js), places online
// (places.ts), swisstopo. The engine's list leads, ranked as it ranks it, except for a kind of place ("pharmacy",
// "toilet"), where the nearest of that kind lead; what another source has as well is left out of the others.
export function combineResults(text: string, swiss: SearchResult[] | null, online: PlaceSearchAnswer | null, local: PlaceMatches,
  kante: SearchResult[] | null = null): SearchResult[] {
  const rest = combineOthers(text, swiss, online, local);
  if (!kante || !kante.length) return rest;
  // a Google place the engine has too: the engine's row is kept, with Google's id (its card shows Google's details)
  for (const r of rest) {
    if (r.source !== 'google' || !r.id) continue;
    const twin = kante.find((k) => sameAs(k, r));
    if (twin && !twin.googleId) twin.googleId = r.id.slice(7);
  }
  const kindAsked = local.kinds.length > 0 || !!searchState.placeCategory;
  if (kindAsked) {
    // the places of that kind from all sources, nearest first; then the rest. A place found online (Photon,
    // Google) that the engine has too keeps the engine's row, which has its cuisine, icon and photo.
    const kept = rest.filter((r) => !(r.source && kante.some((k) => sameAs(k, r))));
    const fresh = kante.filter((k) => !kept.some((r) => sameAs(k, r)));
    const isPlace = (r: SearchResult) => isPlaceResult(r) && r.distance != null;
    const near = [...kept.filter((r) => r.origin === 'place'), ...fresh.filter(isPlace)]
      .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    return [...near, ...kept.filter((r) => r.origin !== 'place'), ...fresh.filter((k) => !isPlace(k))];
  }
  return [...kante, ...rest.filter((r) => !kante.some((k) => sameAs(k, r)))];
}

// The others, as the page had them before the engine's search: our own places, places online, swisstopo
function combineOthers(text: string, swiss: SearchResult[] | null, online: PlaceSearchAnswer | null, local: PlaceMatches): SearchResult[] {
  const { kinds, names } = local;
  const bern = [...kinds, ...names];
  // a place in both the Bern data and online keeps the Bern entry
  // Toilets: ours cover Switzerland and know which are for customers only or locked, so an online toilet that
  // is one of ours (within 50 m) is left out, whatever it is called there. The others (Liechtenstein, a new one)
  // stay, and are listed with ours by distance.
  const ownToilet = (p: PlaceSearchResult) => local.toilets && placeSearchIndex()!.toilets.some((r) => nearM(r, p.lngLat, 50));
  const found = (online ? online.results : [])
    .filter((p) => !ownToilet(p) && !bern.some((b) => fold(b.title) === fold(p.title) && nearM(b.lngLat, p.lngLat, 150)));
  const byDistance = local.toilets && !!online && online.category === 'Toilets' && found.every((p) => p.distance != null);
  // A name ("Coop", "Migros"): ours and those found online are the same kind of match, so all of them nearest first
  const namesByDistance = !kinds.length && names.length > 0 && found.every((p) => p.distance != null);
  const places: SearchResult[] = byDistance ? [...[...kinds, ...found].sort((a, b) => a.distance! - b.distance!), ...names]
    : namesByDistance ? [...found, ...names].sort((a, b) => a.distance! - b.distance!)
    : [...kinds, ...found, ...names];
  // a place swisstopo also knows keeps the place (it has the category and the distance)
  const s = (swiss || []).filter((r) => !places.some((p) => fold(p.title) === fold(r.title) && nearM(p.lngLat, r.lngLat, 150)));
  searchState.placeCategory = (online && online.category) || null;
  // Places first for "restaurant", "Migros", "Einstein Kaffee"; swisstopo first for "Bern", "3011", "Kramgasse 1":
  // whichever top result has more of the typed words in its name, swisstopo on a tie if its name is the query
  const qw = wordsOf(text);
  const matched = (r: SearchResult | undefined) => {
    if (!r) return 0;
    const tw = wordsOf(r.title);
    return qw.filter((w) => tw.some((t) => t.startsWith(w) || (t.length >= 3 && w.startsWith(t)))).length / (qw.length || 1);
  };
  const pm = matched(places[0]), sm = matched(s[0]);
  const placesFirst = kinds.length > 0 || !!searchState.placeCategory || (!/\d/.test(text) && places.length > 0
    && (pm > sm || (pm === sm && pm > 0 && fold(s[0] ? s[0].title : '') !== fold(text))));
  return placesFirst ? [...places, ...s] : [...s, ...places];
}

export async function search(text: string) {
  const id = ++searchState.reqId, field = searchState.field;
  searchState.last = { field, text };
  const remoteText = text.replace(NEAR_PHRASE, '').trim() || text;
  let online: PlaceSearchAnswer | null = null;
  let onlineDone = false;
  // while typing, places online come from OpenStreetMap (free); with a Google key, Google's predictions join them
  const onlineReq = searchPlacesOnline(remoteText, undefined, false).catch(() => null).then((v) => { online = v; onlineDone = true; });
  const google = !!PlaceSearch && PlaceSearch.source === 'google';
  let predictions: PlacePrediction[] = [];
  let predictionsDone = !google;
  const predictionsReq = google ? PlaceSearch.suggest(remoteText, { center: map.getCenter().toArray(), origin: searchOrigin() })
    .catch(() => []).then((v) => { predictions = v; predictionsDone = true; }) : Promise.resolve();
  const [swiss, , kante] = await Promise.all([
    searchSwisstopo(remoteText).catch(() => null),
    loadPlaces(), // usually loaded already (downloaded after the first map view)
    searchKante(remoteText).catch(() => null),
  ]);
  if (id !== searchState.reqId) return; // a newer query is in flight
  const local = searchPlaces(text);
  const show = (final: boolean) => {
    if (field !== searchState.field) return; // the other field has been picked meanwhile
    searchState.results = combineResults(text, swiss, online, local, kante);
    searchState.predictions = attachPredictions(searchState.results, predictions);
    render(!final ? 'Searching…' : swiss || online || kante || predictions.length ? 'No results' : 'Search unavailable');
  };
  // Addresses and Bern places at once; places from the web join the list when they arrive, so a slow
  // answer from one source never holds up the others
  const web = Promise.all([onlineReq, predictionsReq]);
  if (!onlineDone || !predictionsDone) await Promise.race([web, new Promise((ok) => setTimeout(ok, 250))]);
  if (id !== searchState.reqId) return;
  searchState.expanded = false;
  show(onlineDone && predictionsDone);
  // Photos from Wikidata join the engine's rows when they arrive (the rows are the same objects), while this
  // search's list is still open: not over the map once a result is picked or the places are on the map
  fillPhotos(kante).then((found) => {
    if (found && id === searchState.reqId && field === searchState.field && list.classList.contains('open')
      && searchState.results.some((r) => kante!.includes(r))) render();
  }).catch(() => {});
  if (onlineDone && predictionsDone) return;
  await web;
  if (id === searchState.reqId) show(true);
}
