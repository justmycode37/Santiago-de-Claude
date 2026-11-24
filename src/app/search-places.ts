// ---- Places in the search (map-places.js: Bern, toilets everywhere): a kind of place ("pharmacy", "wc", "apotheke", "closest toilet")
//      lists the nearest ones; a name ("Migros", "Amavita") lists the places called that, nearest first ----
import { map } from './map.ts';
import { gpsOn, userLngLat } from './location.ts';
import { parseResult } from './search.ts';
import { render } from './search-pins.ts';
import { GROUP_BY_KEY, PLACES, loadPlaces } from './map-places.ts';
import { fmtDist } from './live-vehicles.ts';
import { distKm } from './routing.ts';
import { searchState } from './state.ts';
import { PlaceSearch } from '../places.ts';
import { KANTE } from '../engine.ts';
import { PLATFORMS, platformKey } from './platforms.ts';
import { MAP_LAYERS } from '../map-layers.ts';
import type { PlaceBbox, PlaceSearchAnswer, PlaceSearchResult } from '../places.ts';
import type { LngLatFirst, PlaceMatches, SearchResult, SwisstopoSearchAnswer } from './search.ts';
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
  return {
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
async function searchKante(text: string): Promise<SearchResult[] | null> {
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
    // a place: "Pharmacy · Spitalgasse 4, Bern" → "Pharmacy · 120 m · Spitalgasse 4, Bern"
    const [what, ...where] = (p.detail || '').split(' · ');
    const kind = (POI_KIND.find(([re]) => re.test(what)) || [null, 'other'])[1];
    return { ...base, kind, subtitle: [what, dist, where.join(' · ')].filter(Boolean).join(' · ') };
  })];
}

// Restaurants, shops, cafés, … anything with a name, all over Switzerland (places.ts: OpenStreetMap, or Google
// with a key): around the part of the map in view, with distances from you (or from the middle of the map once it
// shows somewhere else). bbox [west, south, east, north]: only places inside it ("Search this area")
export function searchPlacesOnline(text: string, bbox?: PlaceBbox): Promise<PlaceSearchAnswer | null> {
  if (!PlaceSearch) return Promise.resolve(null);
  const center = map.getCenter().toArray();
  const corner = map.getBounds().getNorthEast().toArray();
  const viewKm = Math.hypot((corner[0] - center[0]) * 76, (corner[1] - center[1]) * 111); // km at Swiss latitudes
  const radiusKm = Math.min(Math.max(viewKm, 1), 10);
  const timeout = new Promise<never>((_, fail) => setTimeout(() => fail(new Error('timeout')), 4000));
  return Promise.race([PlaceSearch.search(text, { center, origin: searchOrigin(), radiusKm, bbox }), timeout]);
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
  const kindAsked = local.kinds.length > 0 || !!searchState.placeCategory;
  if (kindAsked) {
    // the places of that kind from all sources, nearest first; then the rest
    const fresh = kante.filter((k) => !rest.some((r) => sameAs(k, r)));
    const isPlace = (r: SearchResult) => r.kind !== 'station' && r.kind !== 'address' && r.distance != null;
    const near = [...rest.filter((r) => r.origin === 'place'), ...fresh.filter(isPlace)]
      .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    return [...near, ...rest.filter((r) => r.origin !== 'place'), ...fresh.filter((k) => !isPlace(k))];
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
  const onlineReq = searchPlacesOnline(remoteText).catch(() => null).then((v) => { online = v; onlineDone = true; });
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
    render(!final ? 'Searching…' : swiss || online || kante ? 'No results' : 'Search unavailable');
  };
  // Addresses and Bern places at once; places from the web join the list when they arrive, so a slow
  // answer from one source never holds up the others
  if (!onlineDone) await Promise.race([onlineReq, new Promise((ok) => setTimeout(ok, 250))]);
  if (id !== searchState.reqId) return;
  searchState.expanded = false;
  show(onlineDone);
  if (onlineDone) return;
  await onlineReq;
  if (id === searchState.reqId) show(true);
}
