// Place search for the search bar: restaurants, cafés, shops, pharmacies, toilets, museums, … anything with a
// name on the map, like Google Maps. The page then plans the trip there with its own journey planner.
//
// Two sources:
// - OpenStreetMap through Photon (photon.komoot.io): free, no key. Category words ("restaurant", "Apotheke",
//   "toilet", …) list the nearest places of that kind; anything else is searched by name ("Migros", "Einstein
//   Kaffee", "Zentrum Paul Klee"), nearest first.
// - Google Places (Text Search, New), when config.js sets a key: Google's own places, ratings and opening state.
//   Falls back to OpenStreetMap if Google fails.
//
// PlaceSearch.search(text, { center, origin, radiusKm }) → Promise<[{ title, subtitle, kind, lngLat, origin: 'place',
//   source, distance, category }]>; `center` biases the search (the map view), `origin` is where distances are
//   measured from (you), both [lng, lat].
(function () {
  const CONFIG = window.APP_CONFIG || {};
  const GOOGLE_KEY = (CONFIG.googlePlacesKey || '').trim();
  const PHOTON = 'https://photon.komoot.io/';
  const COUNTRIES = new Set(['CH', 'LI']); // the timetable covers Switzerland and Liechtenstein

  // Category words (English, German, French, Italian) → OpenStreetMap tags. Photon's reverse search with these
  // tags returns the nearest places of that kind.
  const CATEGORIES = [
    { label: 'Restaurants', words: ['restaurant', 'restaurants', 'ristorante', 'gaststatte', 'beiz', 'dinner', 'lunch'], tags: ['amenity:restaurant'] },
    { label: 'Food', words: ['food', 'eat', 'essen', 'manger', 'mangiare', 'hungry'], tags: ['amenity:restaurant', 'amenity:fast_food', 'amenity:cafe', 'amenity:food_court'] },
    { label: 'Fast food', words: ['fast food', 'fastfood', 'takeaway', 'take away', 'imbiss', 'snack'], tags: ['amenity:fast_food'] },
    { label: 'Cafés', words: ['cafe', 'cafes', 'coffee', 'kaffee', 'cafeteria', 'tea room', 'tearoom', 'breakfast', 'fruhstuck'], tags: ['amenity:cafe'] },
    { label: 'Bars', words: ['bar', 'bars', 'pub', 'pubs', 'beer', 'bier', 'drinks', 'biergarten'], tags: ['amenity:bar', 'amenity:pub', 'amenity:biergarten'] },
    { label: 'Bakeries', words: ['bakery', 'bakeries', 'backerei', 'beck', 'boulangerie', 'panetteria', 'bread', 'brot'], tags: ['shop:bakery'] },
    { label: 'Ice cream', words: ['ice cream', 'gelato', 'glace', 'glacé', 'eis', 'gelateria'], tags: ['amenity:ice_cream', 'shop:ice_cream'] },
    { label: 'Supermarkets', words: ['supermarket', 'supermarkets', 'supermarkt', 'grocery', 'groceries', 'lebensmittel', 'einkaufen', 'epicerie', 'supermarche', 'supermercato'], tags: ['shop:supermarket', 'shop:convenience'] },
    { label: 'Kiosks', words: ['kiosk', 'kiosks', 'convenience', 'tabak'], tags: ['shop:kiosk', 'shop:convenience', 'shop:newsagent'] },
    { label: 'Shopping', words: ['shopping', 'mall', 'shopping centre', 'shopping center', 'einkaufszentrum', 'department store', 'warenhaus'], tags: ['shop:mall', 'shop:department_store'] },
    { label: 'Clothes', words: ['clothes', 'clothing', 'kleider', 'fashion', 'vetements'], tags: ['shop:clothes', 'shop:shoes'] },
    { label: 'Pharmacies', words: ['pharmacy', 'pharmacies', 'apotheke', 'pharmacie', 'farmacia', 'drugstore', 'drogerie', 'chemist'], tags: ['amenity:pharmacy', 'shop:chemist'] },
    { label: 'Hospitals', words: ['hospital', 'hospitals', 'spital', 'krankenhaus', 'hopital', 'ospedale', 'emergency', 'notfall', 'urgences'], tags: ['amenity:hospital'] },
    { label: 'Doctors', words: ['doctor', 'doctors', 'arzt', 'medecin', 'medico', 'clinic', 'klinik', 'praxis', 'gp'], tags: ['amenity:doctors', 'amenity:clinic'] },
    { label: 'Dentists', words: ['dentist', 'dentists', 'zahnarzt', 'dentiste', 'dentista'], tags: ['amenity:dentist'] },
    { label: 'Toilets', words: ['toilet', 'toilets', 'wc', 'restroom', 'restrooms', 'bathroom', 'toilette', 'toiletten', 'gabinetto'], tags: ['amenity:toilets'] },
    { label: 'Drinking water', words: ['drinking water', 'water fountain', 'fountain', 'brunnen', 'trinkwasser', 'fontaine'], tags: ['amenity:drinking_water', 'amenity:fountain'] },
    { label: 'Cash machines', words: ['atm', 'atms', 'cash', 'bancomat', 'geldautomat', 'cash machine', 'postomat'], tags: ['amenity:atm'] },
    { label: 'Banks', words: ['bank', 'banks', 'banque', 'banca'], tags: ['amenity:bank'] },
    { label: 'Post offices', words: ['post office', 'post', 'poste', 'posta', 'postfiliale'], tags: ['amenity:post_office'] },
    { label: 'Police', words: ['police', 'polizei', 'polizia'], tags: ['amenity:police'] },
    { label: 'Hotels', words: ['hotel', 'hotels', 'hostel', 'hostels', 'accommodation', 'unterkunft', 'albergo', 'b&b', 'guest house'], tags: ['tourism:hotel', 'tourism:hostel', 'tourism:guest_house', 'tourism:motel'] },
    { label: 'Museums', words: ['museum', 'museums', 'musee', 'museo', 'gallery', 'galerie'], tags: ['tourism:museum', 'tourism:gallery'] },
    { label: 'Sights', words: ['sights', 'attraction', 'attractions', 'sightseeing', 'sehenswurdigkeit', 'viewpoint', 'aussicht'], tags: ['tourism:attraction', 'tourism:viewpoint'] },
    { label: 'Parks', words: ['park', 'parks', 'parc', 'parco', 'garden', 'garten'], tags: ['leisure:park', 'leisure:garden'] },
    { label: 'Playgrounds', words: ['playground', 'playgrounds', 'spielplatz', 'place de jeux'], tags: ['leisure:playground'] },
    { label: 'Libraries', words: ['library', 'libraries', 'bibliothek', 'bibliotheque', 'biblioteca'], tags: ['amenity:library'] },
    { label: 'Gyms', words: ['gym', 'gyms', 'fitness', 'fitnesscenter', 'sport centre', 'sports centre'], tags: ['leisure:fitness_centre', 'leisure:sports_centre'] },
    { label: 'Swimming', words: ['swimming', 'swimming pool', 'pool', 'schwimmbad', 'hallenbad', 'freibad', 'badi', 'piscine', 'piscina'], tags: ['leisure:swimming_pool', 'leisure:water_park', 'amenity:public_bath'] },
    { label: 'Cinemas', words: ['cinema', 'cinemas', 'kino', 'movies', 'cinema'], tags: ['amenity:cinema'] },
    { label: 'Theatres', words: ['theatre', 'theater', 'theatres', 'concert', 'konzert'], tags: ['amenity:theatre', 'amenity:arts_centre'] },
    { label: 'Schools', words: ['school', 'schools', 'schule', 'ecole', 'scuola'], tags: ['amenity:school'] },
    { label: 'Universities', words: ['university', 'universities', 'uni', 'universitat', 'universite', 'college', 'hochschule'], tags: ['amenity:university', 'amenity:college'] },
    { label: 'Churches', words: ['church', 'churches', 'kirche', 'eglise', 'chiesa', 'mosque', 'moschee', 'synagogue', 'temple', 'place of worship'], tags: ['amenity:place_of_worship'] },
    { label: 'Hairdressers', words: ['hairdresser', 'hairdressers', 'barber', 'coiffeur', 'friseur', 'haircut'], tags: ['shop:hairdresser'] },
    { label: 'Laundry', words: ['laundry', 'laundrette', 'waschsalon', 'laverie'], tags: ['shop:laundry', 'shop:dry_cleaning'] },
    { label: 'Parking', words: ['parking', 'car park', 'parkhaus', 'parkplatz'], tags: ['amenity:parking'] },
    { label: 'Charging stations', words: ['charging', 'ev charging', 'charging station', 'ladestation', 'e-tankstelle'], tags: ['amenity:charging_station'] },
    { label: 'Petrol stations', words: ['petrol', 'gas station', 'fuel', 'tankstelle', 'station service'], tags: ['amenity:fuel'] },
    { label: 'Bike rental', words: ['bike rental', 'bike sharing', 'publibike', 'velo', 'veloverleih', 'bicycle rental'], tags: ['amenity:bicycle_rental'] },
  ];

  const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const NEARBY = /\s*\b(near me|nearby|near by|around me|close by|close to me|in der nahe|in meiner nahe|pres de moi|vicino)\s*$/;

  function matchCategory(text) {
    const q = fold(text).replace(NEARBY, '').replace(/^(the |a |an |some )/, '');
    if (!q) return null;
    for (const c of CATEGORIES) if (c.words.some((w) => fold(w) === q)) return c;
    // while typing: "restau" → Restaurants (a word long enough not to be the start of a name by chance)
    if (q.length >= 4) for (const c of CATEGORIES) if (c.words.some((w) => w.length > q.length && fold(w).startsWith(q))) return c;
    return null;
  }

  function distance(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(h));
  }
  const formatDistance = (m) => (m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : m < 9950 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000)} km`);

  // OpenStreetMap / Google place types → icon kind (index.html draws one icon per kind)
  const KIND_BY_TYPE = {
    restaurant: 'food', fast_food: 'food', food_court: 'food', meal_takeaway: 'food', meal_delivery: 'food',
    cafe: 'cafe', coffee_shop: 'cafe', ice_cream: 'cafe', bakery: 'cafe', ice_cream_shop: 'cafe', confectionery: 'cafe', pastry: 'cafe', tea_house: 'cafe',
    bar: 'bar', pub: 'bar', biergarten: 'bar', nightclub: 'bar', night_club: 'bar', wine_bar: 'bar',
    supermarket: 'shop', convenience: 'shop', kiosk: 'shop', mall: 'shop', department_store: 'shop', clothes: 'shop', shoes: 'shop',
    grocery_store: 'shop', shopping_mall: 'shop', clothing_store: 'shop', store: 'shop', newsagent: 'shop', chemist: 'health',
    pharmacy: 'health', hospital: 'health', doctors: 'health', doctor: 'health', clinic: 'health', dentist: 'health', drugstore: 'health',
    atm: 'money', bank: 'money', bureau_de_change: 'money',
    toilets: 'toilet', drinking_water: 'water', fountain: 'water', public_bath: 'sport',
    hotel: 'bed', hostel: 'bed', guest_house: 'bed', motel: 'bed', lodging: 'bed', apartment: 'bed', camp_site: 'bed',
    museum: 'building', gallery: 'building', art_gallery: 'building', theatre: 'building', cinema: 'building', movie_theater: 'building',
    arts_centre: 'building', library: 'building', place_of_worship: 'building', church: 'building', university: 'building',
    school: 'building', college: 'building', attraction: 'building', tourist_attraction: 'building', townhall: 'building',
    city_hall: 'building', post_office: 'building', police: 'building', viewpoint: 'mountain',
    park: 'nature', garden: 'nature', playground: 'nature', nature_reserve: 'nature',
    fitness_centre: 'sport', sports_centre: 'sport', swimming_pool: 'sport', water_park: 'sport', gym: 'sport', stadium: 'sport', pitch: 'sport',
    station: 'station', halt: 'station', train_station: 'station', transit_station: 'station', bus_station: 'station', subway_station: 'station',
  };
  const kindFor = (...types) => { for (const t of types) if (t && KIND_BY_TYPE[t]) return KIND_BY_TYPE[t]; return 'other'; };
  const LABELS = { fast_food: 'Fast food', cafe: 'Café', toilets: 'Toilets', doctors: 'Doctor', atm: 'Cash machine', chemist: 'Drugstore',
    place_of_worship: 'Place of worship', fitness_centre: 'Gym', sports_centre: 'Sports centre', drinking_water: 'Drinking water',
    convenience: 'Convenience store', kiosk: 'Kiosk', department_store: 'Department store', mall: 'Shopping centre', clothes: 'Clothes shop',
    hairdresser: 'Hairdresser', yes: '' };
  const humanize = (v) => (v in LABELS ? LABELS[v] : (v || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()));

  // Photon features that are not destinations (paths, signposts, platforms: the stop search covers those)
  const SKIP_KEYS = new Set(['highway', 'information', 'boundary', 'place', 'landuse', 'natural', 'waterway', 'power', 'barrier', 'route']);

  function fromPhoton(f, origin) {
    const p = f.properties || {};
    if (!p.name || !COUNTRIES.has(p.countrycode) || SKIP_KEYS.has(p.osm_key)) return null;
    if (p.osm_key === 'railway' && p.osm_value !== 'station' && p.osm_value !== 'halt') return null;
    const lngLat = f.geometry.coordinates;
    const street = [p.street, p.housenumber].filter(Boolean).join(' ');
    const town = p.city || p.town || p.village || p.locality || p.district || '';
    const where = [street, town].filter(Boolean).join(', ');
    const category = p.osm_key === 'building' ? '' : humanize(p.osm_value);
    return {
      title: p.name,
      category,
      address: where,
      kind: kindFor(p.osm_value),
      lngLat,
      origin: 'place',
      source: 'osm',
      id: `osm:${p.osm_type}${p.osm_id}`,
      building: p.osm_key === 'building',
      distance: origin ? distance(origin, lngLat) : null,
    };
  }

  function subtitle(r) {
    const parts = [];
    if (r.distance != null) parts.push(formatDistance(r.distance));
    if (r.category) parts.push(r.category);
    if (r.rating) parts.push(`★ ${r.rating.toFixed(1)}`);
    if (r.openNow === true) parts.push('Open');
    else if (r.openNow === false) parts.push('Closed');
    if (r.address) parts.push(r.address);
    return parts.join(' · ');
  }

  // The same place often comes twice (the shop and its building, a node and an area): keep one per name and spot
  function dedupe(list) {
    const out = [];
    for (const r of list) {
      const twin = out.find((o) => fold(o.title) === fold(r.title) && distance(o.lngLat, r.lngLat) < 80);
      if (!twin) out.push(r);
      else if (twin.building && !r.building) out[out.indexOf(twin)] = r;
    }
    return out;
  }

  const cache = new Map();
  async function getJSON(url, init) {
    const key = init ? url + init.body : url;
    if (cache.has(key)) return cache.get(key);
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    cache.set(key, data);
    return data;
  }

  const round = (x) => x.toFixed(3); // ~100 m: nearby searches from almost the same spot share a cached answer

  // Nearest places of one kind, widening the circle when there are few
  async function photonNearby(cat, center, origin, radiusKm) {
    let found = [];
    for (const r of [radiusKm, Math.max(radiusKm * 4, 5)]) {
      const params = new URLSearchParams({ lat: round(center[1]), lon: round(center[0]), radius: String(Math.min(r, 25)), limit: '40', lang: 'en' });
      cat.tags.forEach((t) => params.append('osm_tag', t));
      const data = await getJSON(`${PHOTON}reverse?${params}`);
      found = dedupe((data.features || []).map((f) => fromPhoton(f, origin)).filter(Boolean));
      if (found.length >= 6 || r >= 25) break;
    }
    const from = origin || center;
    return found.sort((a, b) => distance(from, a.lngLat) - distance(from, b.lngLat));
  }

  // Places by name, the ones near the map first
  async function photonByName(text, center, origin) {
    const params = new URLSearchParams({ q: text, lat: round(center[1]), lon: round(center[0]), zoom: '16',
      location_bias_scale: '0.1', limit: '40', lang: 'en' });
    const data = await getJSON(`${PHOTON}api/?${params}`);
    const list = dedupe((data.features || []).map((f) => fromPhoton(f, origin)).filter(Boolean));
    // Photon's order is by how well the name matches; nearer places move up (300 m ≈ one place in the list)
    return list.map((r, i) => ({ r, score: i * 0.3 + distance(center, r.lngLat) / 1000 }))
      .sort((a, b) => a.score - b.score).map((x) => x.r);
  }

  // Google Places Text Search (New). Called straight from the page; restrict the key to your site's address.
  const GOOGLE_FIELDS = ['places.id', 'places.displayName', 'places.shortFormattedAddress', 'places.formattedAddress',
    'places.location', 'places.primaryType', 'places.primaryTypeDisplayName', 'places.types', 'places.rating',
    'places.currentOpeningHours.openNow', 'places.businessStatus'].join(',');
  async function google(text, center, origin, radiusKm) {
    const body = JSON.stringify({
      textQuery: text,
      languageCode: 'en',
      regionCode: 'CH',
      pageSize: 20,
      locationBias: { circle: { center: { latitude: +round(center[1]), longitude: +round(center[0]) }, radius: Math.min(radiusKm * 1000, 50000) } },
    });
    const data = await getJSON('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_KEY, 'X-Goog-FieldMask': GOOGLE_FIELDS },
      body,
    });
    return (data.places || []).filter((p) => p.location && p.businessStatus !== 'CLOSED_PERMANENTLY').map((p) => {
      const lngLat = [p.location.longitude, p.location.latitude];
      return {
        title: (p.displayName && p.displayName.text) || '',
        category: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || '',
        address: p.shortFormattedAddress || p.formattedAddress || '',
        kind: kindFor(p.primaryType, ...(p.types || [])),
        lngLat,
        origin: 'place',
        source: 'google',
        id: `google:${p.id}`,
        rating: p.rating || null,
        openNow: p.currentOpeningHours ? p.currentOpeningHours.openNow : null,
        distance: origin ? distance(origin, lngLat) : null,
      };
    }).filter((r) => r.title);
  }

  async function search(text, { center, origin, radiusKm = 1.5 } = {}) {
    const q = text.trim();
    if (q.length < 2 || !center) return { category: null, results: [] };
    const cat = matchCategory(q);
    let list = null;
    if (GOOGLE_KEY) {
      // "near me" is already said by the location bias
      const query = NEARBY.test(fold(q)) ? fold(q).replace(NEARBY, '') || q : q;
      try { list = await google(query, center, origin, radiusKm); }
      catch (e) { console.warn('Google Places failed, using OpenStreetMap', e); }
    }
    if (!list) list = cat ? await photonNearby(cat, center, origin, radiusKm) : await photonByName(q, center, origin);
    for (const r of list) r.subtitle = subtitle(r);
    return { category: cat ? cat.label : null, results: list };
  }

  window.PlaceSearch = {
    search,
    matchCategory: (t) => { const c = matchCategory(t); return c ? c.label : null; },
    source: GOOGLE_KEY ? 'google' : 'osm',
    attribution: GOOGLE_KEY ? 'Google Maps' : 'Places © OpenStreetMap contributors',
    formatDistance,
  };
})();
