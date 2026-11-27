// The place search's data layer (src/places.ts) and the opening hours it reads (src/opening-hours.ts), offline.
// Google Places API (New) is answered by fixtures in the shape Google's reference documents (no key is used or
// needed); what is checked is what the page asks of Google and what that costs: field masks on the cheapest SKU
// that has the fields, one session token per typing session, Details only when a place is opened, every answer
// asked once, the daily budget and "quota exceeded" switching to OpenStreetMap and Google's free Embed card, and
// the key never in a log. Exit code 1 on any failure.
//
//   node tools/test_places.mts

let passed = 0, failed = 0;
const check = (ok: unknown, what: string) => { if (ok) passed++; else failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`); };
const SRC = new URL('../src/', import.meta.url);
const KEY = 'TEST-KEY-not-a-real-one';

// ---- opening hours ----
const { openState, weekLines, parseOpeningHours } = await import(new URL('opening-hours.ts', SRC).href);
const at = (iso: string) => new Date(iso); // local time: the device's clock, as in the page
console.log('opening hours (OpenStreetMap)');
const shop = 'Mo-Fr 08:00-18:30; Sa 09:00-16:00; Su off';
check(openState(shop, at('2026-11-25T10:00'))?.text === 'Open · Closes 18:30', 'Wednesday 10:00: open until 18:30');
check(openState(shop, at('2026-11-25T19:00'))?.text === 'Closed · Opens tomorrow 08:00', 'Wednesday 19:00: opens tomorrow');
check(openState(shop, at('2026-11-28T17:00'))?.text === 'Closed · Opens Mon 08:00', 'Saturday 17:00: opens on Monday');
check(openState(shop, at('2026-11-25T07:00'))?.text === 'Closed · Opens 08:00', 'early: opens today');
check(openState('24/7', at('2026-11-25T03:00'))?.text === 'Open 24 hours', '24/7');
check(openState('Mo-Su 00:00-24:00', at('2026-11-25T03:00'))?.text === 'Open 24 hours', 'every day all day');
check(openState('Fr-Sa 18:00-02:00', at('2026-11-28T01:00'))?.text === 'Open · Closes 02:00', 'past midnight: Friday night on Saturday at 01:00');
check(openState('Mo-Fr 11:30-14:00,18:00-22:00', at('2026-11-25T15:00'))?.text === 'Closed · Opens 18:00', 'lunch break');
check(openState('Mo-Fr 08:00-18:00; PH off', at('2026-11-25T10:00')) === null, 'public holidays: not understood → null, never a guess');
check(openState('sunrise-sunset', at('2026-11-25T10:00')) === null, 'sunrise: null');
check(parseOpeningHours('') === null, 'empty: null');
check(weekLines(shop)[0] === 'Monday: 08:00–18:30' && weekLines(shop)[6] === 'Sunday: Closed', 'the week written out');

// ---- the page around places.ts ----
const store = new Map<string, string>();
const warned: string[] = [];
const origWarn = console.warn;
console.warn = (...a: unknown[]) => { warned.push(a.map((x) => (x instanceof Error ? x.message + x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
interface Call { url: string; method: string; mask: string; body: Record<string, unknown> | null }
let calls: Call[] = [];
const allCalls: Call[] = []; // every request of the run, for the checks on the key
let nextStatus: number | null = null;
const g = globalThis as unknown as Record<string, unknown>;
g.window = globalThis;
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };

// Fixtures in the documented shapes (places.searchText, places.autocomplete, places.get; Photon's GeoJSON)
const SEARCH = { places: [
  { id: 'ChIJpizza1', displayName: { text: 'Pizzeria Lorenzini' }, shortFormattedAddress: 'Hotelgasse 8, Bern', location: { latitude: 46.9481, longitude: 7.4466 },
    primaryType: 'pizza_restaurant', primaryTypeDisplayName: { text: 'Pizza restaurant' }, types: ['pizza_restaurant', 'restaurant'], businessStatus: 'OPERATIONAL' },
  { id: 'ChIJgone', displayName: { text: 'Old Pizza' }, location: { latitude: 46.95, longitude: 7.44 }, businessStatus: 'CLOSED_PERMANENTLY' },
] };
const AUTOCOMPLETE = { suggestions: [
  { placePrediction: { placeId: 'ChIJeinstein', types: ['cafe', 'food'], distanceMeters: 420,
    structuredFormat: { mainText: { text: 'Einstein Kaffee' }, secondaryText: { text: 'Kramgasse 49, Bern, Schweiz' } } } },
] };
const DETAILS = {
  id: 'ChIJeinstein', displayName: { text: 'Einstein Kaffee' }, shortFormattedAddress: 'Kramgasse 49, Bern', location: { latitude: 46.9478, longitude: 7.4512 },
  primaryTypeDisplayName: { text: 'Café' }, rating: 4.4, userRatingCount: 1234, priceLevel: 'PRICE_LEVEL_MODERATE',
  priceRange: { startPrice: { currencyCode: 'CHF', units: '10' }, endPrice: { currencyCode: 'CHF', units: '20' } },
  currentOpeningHours: { openNow: true, nextCloseTime: new Date(Date.now() + 3600e3).toISOString(), weekdayDescriptions: ['Monday: 8:00 AM – 6:00 PM'] },
  nationalPhoneNumber: '031 312 28 28', websiteUri: 'https://einstein-kaffee.ch', googleMapsUri: 'https://maps.google.com/?cid=1',
  editorialSummary: { text: 'Coffee in the house where Einstein lived.' },
  photos: [{ name: 'places/ChIJeinstein/photos/AAA', googleMapsUri: 'https://maps.google.com/photo/1',
    authorAttributions: [{ displayName: 'Ana', uri: '//maps.google.com/maps/contrib/1' }, { displayName: 'Cleo', uri: 'https://maps.google.com/maps/contrib/3' }] }],
  reviews: [{ rating: 5, relativePublishTimeDescription: '2 weeks ago', text: { text: 'Great coffee.' }, googleMapsUri: 'https://www.google.com/maps/reviews/1',
    authorAttribution: { displayName: 'Ben', uri: 'https://www.google.com/maps/contrib/2', photoUri: 'https://lh3.googleusercontent.com/a/b' } }],
};
const PHOTON = { features: [
  { geometry: { coordinates: [7.447, 46.948] }, properties: { osm_type: 'N', osm_id: 1, osm_key: 'amenity', osm_value: 'pharmacy', name: 'Apotheke Zytglogge', countrycode: 'CH', street: 'Kramgasse', housenumber: '1', city: 'Bern' } },
] };
g.fetch = async (input: string, init: RequestInit = {}) => {
  const url = String(input);
  const headers = (init.headers || {}) as Record<string, string>;
  const call = { url, method: init.method || 'GET', mask: headers['X-Goog-FieldMask'] || '', body: init.body ? JSON.parse(String(init.body)) : null };
  calls.push(call);
  allCalls.push(call);
  const status = nextStatus;
  nextStatus = null;
  const answer = (data: unknown) => ({ ok: (status ?? 200) < 400, status: status ?? 200, json: async () => data });
  if (url.includes('places:searchText')) return answer(SEARCH);
  if (url.includes('/media?')) return answer({ name: url.split('?')[0].slice(36), photoUri: 'https://lh3.googleusercontent.com/place-photos/x=w640' });
  if (url.includes('places:autocomplete')) return answer(AUTOCOMPLETE);
  if (url.includes('places.googleapis.com/v1/places/')) return answer(url.includes('ChIJeinstein') ? DETAILS : { ...DETAILS, id: 'ChIJother', displayName: { text: 'Other' } });
  if (url.includes('photon.komoot.io')) return answer(PHOTON);
  if (url.includes('api.openstreetmap.org')) return answer({ elements: [{ type: 'node', id: 1, tags: { opening_hours: 'Mo-Su 08:00-20:00', phone: '+41 31 311 11 11', wheelchair: 'yes' } }] });
  if (url.includes('wikidata.org')) return answer({ entities: {} });
  return answer({});
};

const center: LngLat = [7.4474, 46.948];
const origin: LngLat = [7.44, 46.95];
const google = (c: Call) => c.url.includes('places.googleapis.com');
const ATMOSPHERE = ['reviews', 'editorialSummary'];
const ENTERPRISE = ['rating', 'userRatingCount', 'priceLevel', 'priceRange', 'currentOpeningHours', 'regularOpeningHours', 'websiteUri', 'nationalPhoneNumber', 'internationalPhoneNumber'];
const maskHas = (mask: string, fields: string[]) => fields.some((f) => mask.split(',').some((m) => m.replace(/^places\./, '').split('.')[0] === f));

// ---- with a key ----
g.APP_CONFIG = { googlePlacesKey: KEY, googleDailyLimits: { details: 2 } };
const { PlaceSearch, splitOpenNow, openFirst, googleOpen } = await import(new URL('places.ts?google', SRC).href);

console.log('Google: open state (a fixed clock)');
const wed10 = at('2026-11-25T10:00');
check(googleOpen({ openNow: true, nextCloseTime: at('2026-11-25T18:30').toISOString() }, wed10).text === 'Open · Closes 18:30', 'open, closes today');
check(googleOpen({ openNow: false, nextOpenTime: at('2026-11-26T08:00').toISOString() }, wed10).text === 'Closed · Opens tomorrow 08:00', 'closed, opens tomorrow');
check(googleOpen({ openNow: false, nextOpenTime: at('2026-11-30T09:00').toISOString() }, wed10).text === 'Closed · Opens Mon 09:00', 'closed, opens on Monday');
check(googleOpen({ openNow: true }, wed10).text === 'Open' && googleOpen(undefined, wed10) === null, 'no time known: "Open"; no hours: null');

console.log('results list: Text Search on the Pro SKU');
let a = await PlaceSearch.search('pizza', { center, origin, radiusKm: 1.5 });
const search1 = calls.filter((c) => c.url.includes('places:searchText'));
check(search1.length === 1 && calls.length === 1, 'one request, to Text Search');
check(!maskHas(search1[0].mask, [...ENTERPRISE, ...ATMOSPHERE, 'photos']), `field mask has no Enterprise/Atmosphere field and no photos: ${search1[0].mask}`);
check(search1[0].mask.includes('places.location') && search1[0].mask.includes('places.displayName'), 'it has what the list needs (name, point)');
check(a.results.length === 1 && a.results[0].title === 'Pizzeria Lorenzini', 'permanently closed places are left out');
check(a.results[0].id === 'google:ChIJpizza1' && a.results[0].kind === 'food' && a.results[0].rating == null, 'mapped: id, icon kind, no rating yet');
calls = [];
await PlaceSearch.search('pizza', { center: [center[0] + 0.001, center[1] + 0.001], origin, radiusKm: 1.6 });
check(calls.length === 0, 'the same text from nearly the same view: no second request');
a = await PlaceSearch.search('pharmacy open now', { center, origin });
const openBody = calls.find((c) => c.url.includes('places:searchText'))!.body!;
check(openBody.openNow === true && openBody.textQuery === 'pharmacy' && a.openNow, '"pharmacy open now": openNow asked of Google, the words left out');
calls = [];
a = await PlaceSearch.search('apotheke', { center, origin, google: false });
check(calls.length > 0 && calls.every((c) => c.url.includes('photon.komoot.io')), 'google: false (typing): OpenStreetMap only');

console.log('typing: Autocomplete with one session token');
calls = [];
const p1 = await PlaceSearch.suggest('Einst', { center, origin });
await PlaceSearch.suggest('Einstei', { center, origin });
const ac = calls.filter((c) => c.url.includes('places:autocomplete'));
const token = ac[0] && ac[0].body!.sessionToken;
check(ac.length === 2 && typeof token === 'string' && ac[1].body!.sessionToken === token, 'the same session token on every keystroke');
check(JSON.stringify(ac[0].body!.includedRegionCodes) === '["ch","li"]' && ac[0].body!.origin, 'Switzerland and Liechtenstein, distances from you');
check(p1.length === 1 && p1[0].title === 'Einstein Kaffee' && p1[0].subtitle === 'Kramgasse 49, Bern' && p1[0].distance === 420 && p1[0].kind === 'cafe',
  'a prediction: name, where (without the country), distance, icon');
calls = [];
check((await PlaceSearch.suggest('Ei', { center, origin })).length === 0 && calls.length === 0, 'under three letters: not asked');

console.log('opening a place: Place Details, once');
calls = [];
const d = await PlaceSearch.details({ title: 'Einstein Kaffee', googleId: 'ChIJeinstein' });
const det = calls.filter((c) => c.url.includes('/v1/places/ChIJeinstein'));
check(det.length === 1 && det[0].url.includes(`sessionToken=${token}`), 'Details ends the typing session with its token (the predictions are then free)');
check(maskHas(det[0].mask, ['reviews', 'rating', 'currentOpeningHours', 'photos']) && !det[0].mask.includes('*'), 'Details asks for what the card shows, no wildcard');
check(d.rating === 4.4 && d.ratingCount === 1234 && d.priceLevel === 2 && d.priceRange === 'CHF 10–20', 'rating, count, price level and range');
check(d.open?.open === true && /^Open · Closes (tomorrow )?\d\d:\d\d$/.test(d.open.text), `open state from nextCloseTime: ${d.open?.text}`);
check(d.reviews.length === 1 && d.reviews[0].author === 'Ben' && d.reviews[0].when === '2 weeks ago' && d.reviews[0].avatar, 'a review: author, avatar, stars, when, text');
check(d.photos[0].googleName === 'places/ChIJeinstein/photos/AAA' && JSON.stringify(d.photos[0].credits) === JSON.stringify([
  { name: 'Ana', uri: 'https://maps.google.com/maps/contrib/1' }, { name: 'Cleo', uri: 'https://maps.google.com/maps/contrib/3' }]) && d.photos[0].mapsUri === 'https://maps.google.com/photo/1',
  'photos: by name (fetched only when shown), every author credited, the photo\'s own Google Maps link');
check(d.reviews[0].mapsUri === 'https://www.google.com/maps/reviews/1' && d.reviews[0].authorUri === 'https://www.google.com/maps/contrib/2', 'a review keeps its author\'s and its own link');
check(d.embed.startsWith('https://www.google.com/maps/embed/v1/place?') && d.embed.includes('place_id%3AChIJeinstein'), 'Google\'s Embed card offered');
check(d.lngLat && d.lngLat[0] === 7.4512, 'the point (a prediction has none)');
calls = [];
await PlaceSearch.details({ title: 'Einstein Kaffee', googleId: 'ChIJeinstein' });
check(calls.length === 0, 'opened again: from the page\'s memory');
check(PlaceSearch.seen('ChIJeinstein')?.rating === 4.4, 'the list can show the rating of a place opened before');
await PlaceSearch.suggest('Kaffee', { center, origin });
const token2 = calls[0] && calls[0].body!.sessionToken;
check(token2 && token2 !== token, 'a new session after the pick');
calls = [];
await PlaceSearch.details({ title: 'Einstein Kaffee', googleId: 'ChIJeinstein' }); // picked again: known, nothing sent
await PlaceSearch.suggest('Kaffee B', { center, origin });
check(calls.length === 1 && calls[0].body!.sessionToken !== token2, 'a place picked again (from memory) ends its session too: the next keystroke is a new one');
calls = [];
const ll = await PlaceSearch.resolve('ChIJstart');
check(calls.length === 1 && calls[0].mask === 'id,location' && ll && ll[0] === 7.4512, 'a start picked from a prediction: only its point (Essentials)');
calls = [];
const ph = await PlaceSearch.photo('places/X/photos/Y', 640);
const ph2 = await PlaceSearch.photo('places/X/photos/Y', 640);
check(ph === 'https://lh3.googleusercontent.com/place-photos/x=w640' && ph2 === ph && calls.length === 1, 'a photo: its address asked once, then from memory (redrawn rows and cards fetch nothing)');
check(calls[0].url === 'https://places.googleapis.com/v1/places/X/photos/Y/media?maxWidthPx=640&skipHttpRedirect=true' && !calls[0].url.includes(KEY), 'photo media without redirect, key in the header');
check(JSON.parse(store.get('google-places-budget')!).used.photo === 1 && PlaceSearch.photoKnown('places/X/photos/Y', 640) === ph, 'counted once; known without a request');

console.log('the daily budget and Google\'s quota');
calls = [];
const over = await PlaceSearch.details({ title: 'Somewhere', googleId: 'ChIJover', id: 'osm:N1' });
const over2 = await PlaceSearch.details({ title: 'Elsewhere', googleId: 'ChIJover2' });
check(calls.filter(google).length === 1, `details budget of 2 a day: the third place is not asked of Google (${calls.filter(google).length} asked)`);
check(over2.source === 'osm' && over2.limited && over2.embed.includes('place_id%3AChIJover2') && over2.reviews.length === 0,
  'over the budget: OpenStreetMap\'s details, no reviews, Google\'s free Embed card instead');
check(over.source === 'google', 'within the budget: Google\'s');
calls = [];
nextStatus = 429;
const q1 = await PlaceSearch.search('sushi', { center, origin });
const q2 = await PlaceSearch.search('ramen', { center, origin });
check(calls.filter((c) => c.url.includes('searchText')).length === 1 && q1.results[0]?.source === 'osm' && q2.results[0]?.source === 'osm',
  '"quota exceeded" (429): OpenStreetMap now and for the rest of the day, Google not asked again');
check(JSON.parse(store.get('google-places-budget')!).out.search === true, 'remembered on this device for the day');

console.log('without Google\'s details: OpenStreetMap');
calls = [];
const osm = await PlaceSearch.details({ title: 'Apotheke Zytglogge', id: 'osm:N1', lngLat: [7.447, 46.948] });
check(osm.source === 'osm' && osm.reviews.length === 0 && osm.rating === null, 'no reviews, no rating: never made up');
check(osm.phone === '+41 31 311 11 11' && osm.weekHours[0] === 'Monday: 08:00–20:00' && osm.wheelchair === 'Wheelchair accessible' && osm.open, 'hours, open state, phone, wheelchair from its tags');
const row = await PlaceSearch.details({ title: 'Bar', info: { openingHours: 'Mo-Su 17:00-23:00 ; PH off', website: 'bar.ch' } });
check(row.weekHours.length === 0 && row.hoursText === 'Mo-Su 17:00-23:00 ; PH off' && row.open === null && row.website === 'https://bar.ch',
  'hours it cannot read: shown as mapped, not as open or closed');

console.log('"open now"');
check(JSON.stringify(splitOpenNow('Apotheke jetzt geöffnet')) === '["apotheke",true]', 'German');
check(JSON.stringify(splitOpenNow('pharmacie ouvert')) === '["pharmacie",true]', 'French, at the end');
check(JSON.stringify(splitOpenNow('Open Air Kino')) === '["Open Air Kino",false]', 'a name with "Open" in it is left alone');
check(JSON.stringify(openFirst([{ openNow: false, n: 1 }, { openNow: null, n: 2 }, { openNow: true, n: 3 }]).map((r: { n: number }) => r.n)) === '[3,2]',
  'open first, then unknown; closed left out');

check(warned.length > 0 && !warned.some((w) => w.includes(KEY)), 'the key is in no warning');
check(allCalls.filter(google).length > 10 && !allCalls.some((c) => c.url.includes(KEY)), `all ${allCalls.filter(google).length} Google requests carry the key in a header, not the address`);

// ---- Embed only ----
console.log('googlePlacesMode: embed (never the Places API)');
g.APP_CONFIG = { googlePlacesKey: KEY, googlePlacesMode: 'embed' };
store.clear();
const E = (await import(new URL('places.ts?embed', SRC).href)).PlaceSearch;
calls = [];
await E.search('pizza', { center, origin });
check(calls.length === 1 && calls[0].url.includes('photon'), 'the list from OpenStreetMap');
check((await E.suggest('Einstein', { center, origin })).length === 0 && calls.length === 1, 'no predictions, no request');
const e = await E.details({ title: 'Einstein Kaffee', address: 'Kramgasse 49, Bern', info: {} });
check(e.embed.includes('q=Einstein+Kaffee%2C+Kramgasse+49%2C+Bern') && !calls.some(google), 'Google\'s card by name and address, free');

// ---- no key ----
console.log('no key');
g.APP_CONFIG = undefined;
const N = (await import(new URL('places.ts?none', SRC).href)).PlaceSearch;
calls = [];
await N.search('pizza', { center, origin });
check(N.source === 'osm' && !N.embedAvailable && calls.every((c) => !google(c)), 'OpenStreetMap only');
check((await N.details({ title: 'X' })).embed === '', 'no Embed card without a key');

console.warn = origWarn;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
