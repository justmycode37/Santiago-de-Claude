// ---- Places in the search (map-places.js: Bern, toilets everywhere): a kind of place ("pharmacy", "wc", "apotheke", "closest toilet")
//      lists the nearest ones; a name ("Migros", "Amavita") lists the places called that, nearest first ----
const fold = (s: string | number) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss');
const stem = (w: string) => (w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y'
  : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const wordsOf = (s: string) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);
// "closest pharmacy", "nächste Apotheke", "toilet near me" → pharmacy, apotheke, toilet
const NEAR_WORDS = new Set(['closest', 'nearest', 'near', 'nearby', 'me', 'next', 'the', 'a', 'an', 'find', 'where', 'is',
  'around', 'here', 'my', 'nachste', 'nachster', 'nachstes', 'nachsten', 'in', 'der', 'die', 'das', 'nahe', 'wo', 'ist',
  'ein', 'eine', 'mir', 'bei', 'plus', 'proche', 'le', 'la']);
const NEAR_PHRASE = /^(closest|nearest|next|n[aä]chste[rsn]?)\s+|\s+(near me|nearby|in der n[aä]he)$/gi;
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
    generic: !row[3],
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
const searchOrigin = (): LngLat => (gpsOn() && map.getBounds().contains(userLngLat!) ? userLngLat! : map.getCenter().toArray());
// many: for "Search this area", which keeps the ones in view (the list only needs the nearest few)
function searchPlaces(text: string, many?: boolean): PlaceMatches {
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
  const kinds = cats.length ? near(PLACES!.items.filter((r) => catSet.has(r[2]) && forAll(r)), many ? 40 : 6) : [];

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

// Community events (events.ts): on the map they are cards you have to see, so the search lists them too.
// "events" (or "Events near you", offered while the destination field is empty) → the nearest ones that match
// your settings; with more words ("free food events") those among them. Any other query → events with every
// word in their title, category or tags.
const EVENT_WORDS = new Set(['event', 'events', 'veranstaltung', 'veranstaltungen', 'anlass', 'anlasse', 'evenement', 'evenements',
  'evento', 'eventi', 'meetup', 'meetups']);
const EVENT_FILLER = new Set([...NEAR_WORDS, 'you', 'for', 'on', 'what', 'whats', 's', 'today', 'this', 'week', 'community', 'local', 'all']);
function eventResult(f: EventFeature, km: number, all: EventFeature[] = [f]): SearchResult {
  const p = f.properties, dates = all.length;
  return {
    series: all, // every date of it, to choose from on its page
    title: p.title,
    // "300 m · 23 Nov 2026 · 14:00–15:00 · 4 more dates · Language": what tells two events apart comes first
    subtitle: [fmtDist(km * 1000) + (p.areaOnly ? ' (town area)' : ''), p.when, dates > 1 ? `${dates - 1} more ${dates === 2 ? 'date' : 'dates'}` : '', p.category].filter(Boolean).join(' · '),
    kind: 'place', // (brings its own icon)
    origin: 'event',
    eventId: p.id,
    distance: km * 1000,
    icon: { color: p.color, fg: p.ink && p.ink !== '#FFFFFF' ? p.ink : '', svg: `<path d="${EVENTS.GLYPHS[p.cat]}"/>` },
    lngLat: f.geometry.coordinates,
  };
}
// → { asked: the query asks for events, list: results nearest first }
function searchEvents(text: string): { asked: boolean; list: SearchResult[] } {
  const words = wordsOf(text);
  const asked = words.some((w) => EVENT_WORDS.has(w));
  const plain = words.filter((w) => !EVENT_WORDS.has(w) && !(asked ? EVENT_FILLER : NEAR_WORDS).has(w)).map(stem);
  if (!asked && (!plain.length || plain.join('').length < 3)) return { asked, list: [] };
  const from = gpsOn() ? userLngLat! : map.getCenter().toArray();
  const fits = (f: EventFeature) => {
    const p = f.properties;
    const hay = wordsOf([p.title, p.category, p.tags.join(' '), asked ? [p.city, p.audience, p.venue].join(' ') : ''].join(' ')).map(stem);
    return plain.every((w) => hay.some((x) => x === w || (w.length >= 3 && x.startsWith(w))));
  };
  // an event held on several dates is listed once, with its next date; its page lets you choose the others
  const series = new Map<string, EventFeature[]>();
  const until = (f: EventFeature) => (f.properties.through ? Date.parse(f.properties.through) : Infinity);
  for (const f of visibleEvents().filter(fits)) {
    const key = f.properties.title + '|' + f.geometry.coordinates.join(',');
    if (!series.has(key)) series.set(key, []);
    series.get(key)!.push(f);
  }
  const list = [...series.values()].map((all) => all.sort((a, b) => until(a) - until(b)))
    .map((all): [EventFeature[], number] => [all, distKm(from, all[0].geometry.coordinates)])
    .sort((a, b) => a[1] - b[1]).slice(0, asked ? 30 : 3).map(([all, km]) => eventResult(all[0], km, all));
  return { asked, list };
}

// Addresses, towns, postcodes, mountains, lakes: swisstopo
async function searchSwisstopo(text: string): Promise<SearchResult[]> {
  const url = 'https://api3.geo.admin.ch/rest/services/api/SearchServer?' + new URLSearchParams({
    searchText: text,
    type: 'locations',
    origins: 'zipcode,gg25,gazetteer,address',
    sr: '4326',
    limit: '15',
    lang: APP_LANG.pick(['de', 'fr', 'it', 'rm', 'en']),
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

// Restaurants, shops, cafés, … anything with a name, all over Switzerland (places.js: OpenStreetMap, or Google
// with a key): around the part of the map in view, with distances from you (or from the middle of the map once it
// shows somewhere else). bbox [west, south, east, north]: only places inside it ("Search this area")
function searchPlacesOnline(text: string, bbox?: PlaceBbox): Promise<PlaceSearchAnswer | null> {
  if (!window.PlaceSearch) return Promise.resolve(null);
  const center = map.getCenter().toArray();
  const corner = map.getBounds().getNorthEast().toArray();
  const viewKm = Math.hypot((corner[0] - center[0]) * 76, (corner[1] - center[1]) * 111); // km at Swiss latitudes
  const radiusKm = Math.min(Math.max(viewKm, 1), 10);
  const timeout = new Promise<never>((_, fail) => setTimeout(() => fail(new Error('timeout')), 4000));
  return Promise.race([PlaceSearch.search(text, { center, origin: searchOrigin(), radiusKm, bbox }), timeout]);
}

const nearM = (a: LngLatFirst, b: LngLatFirst, m: number) => Math.hypot((a[0] - b[0]) * 76000, (a[1] - b[1]) * 111000) < m;

// One list from the three sources: our own places (map-places.js), places online (places.js), swisstopo
function combineResults(text: string, swiss: SearchResult[] | null, online: PlaceSearchAnswer | null, local: PlaceMatches): SearchResult[] {
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
  placeCategory = (online && online.category) || null;
  // Places first for "restaurant", "Migros", "Einstein Kaffee"; swisstopo first for "Bern", "3011", "Kramgasse 1":
  // whichever top result has more of the typed words in its name, swisstopo on a tie if its name is the query
  const qw = wordsOf(text);
  const matched = (r: SearchResult | undefined) => {
    if (!r) return 0;
    const tw = wordsOf(r.title);
    return qw.filter((w) => tw.some((t) => t.startsWith(w) || (t.length >= 3 && w.startsWith(t)))).length / (qw.length || 1);
  };
  const pm = matched(places[0]), sm = matched(s[0]);
  const placesFirst = kinds.length > 0 || !!placeCategory || (!/\d/.test(text) && places.length > 0
    && (pm > sm || (pm === sm && pm > 0 && fold(s[0] ? s[0].title : '') !== fold(text))));
  return placesFirst ? [...places, ...s] : [...s, ...places];
}

let lastSearch: FieldSearch | null = null; // { field, text }: what the list was last filled for
async function search(text: string) {
  const id = ++reqId, field = activeField;
  lastSearch = { field, text };
  const remoteText = text.replace(NEAR_PHRASE, '').trim() || text;
  let online: PlaceSearchAnswer | null = null;
  let onlineDone = false;
  const onlineReq = searchPlacesOnline(text).catch(() => null).then((v) => { online = v; onlineDone = true; });
  const [swiss] = await Promise.all([
    searchSwisstopo(remoteText).catch(() => null),
    loadPlaces(), // usually loaded already (downloaded after the first map view)
  ]);
  if (id !== reqId) return; // a newer query is in flight
  const local = searchPlaces(text);
  // events are somewhere to go, so they are offered for the destination only
  const events = field === 'to' ? searchEvents(text) : { asked: false, list: [] };
  eventsAsked = events.asked && events.list.length > 0;
  const show = (final: boolean) => {
    if (field !== activeField) return; // the other field has been picked meanwhile
    results = combineResults(text, swiss, online, local);
    // asked for: the events alone. Otherwise the ones that match by name join after the top results.
    if (eventsAsked) { results = events.list; placeCategory = null; }
    else if (events.list.length) results.splice(Math.min(2, results.length), 0, ...events.list);
    render(!final ? 'Searching…' : swiss || online ? 'No results' : 'Search unavailable');
  };
  // Addresses and Bern places at once; places from the web join the list when they arrive, so a slow
  // answer from one source never holds up the others
  if (!onlineDone) await Promise.race([onlineReq, new Promise((ok) => setTimeout(ok, 250))]);
  if (id !== reqId) return;
  expanded = false;
  show(onlineDone);
  if (onlineDone) return;
  await onlineReq;
  if (id === reqId) show(true);
}
