// Place search for the search bar: restaurants, cafés, shops, pharmacies, toilets, museums, … anything with a
// name on the map, like Google Maps. The page then plans the trip there with its own journey planner.
//
// Two sources:
// - OpenStreetMap through Photon (photon.komoot.io): free, no key. Category words ("restaurant", "Apotheke",
//   "toilet", …) list the nearest places of that kind; anything else is searched by name ("Migros", "Einstein
//   Kaffee", "Zentrum Paul Klee"), nearest first. Details (website, hours, phone, a photo) come from OpenStreetMap's
//   API and Wikidata (enrich(), details()).
// - Google Places API (New), when config.js sets a key. Built to stay inside Google's free monthly caps (per SKU:
//   Essentials 10,000, Pro 5,000, Enterprise 1,000 requests; docs/places-data.md):
//     typing        Autocomplete (New) with a session token (Essentials; free when the session ends in Details)
//     results list  Text Search with Pro fields only (name, point, kind, address): no rating, hours or photos
//     opening one   Place Details with rating, price, hours, phone, website, photos and reviews (Enterprise +
//                   Atmosphere), once per place and page; its photos load one at a time, when shown
//   A daily budget per SKU on this device (DAILY, about a 31st of each cap) and Google's own "quota exceeded"
//   switch to OpenStreetMap and to the Maps Embed API (free, no limit) for the rest of the day.
//   googlePlacesMode: 'embed' never calls the Places API: OpenStreetMap everywhere, Google's own card (Embed) on a
//   place. Anything that fails at Google falls back to OpenStreetMap.
//
// PlaceSearch.search(text, { center, origin, radiusKm, bbox, google }) → Promise<{ category, openNow, results }>;
//   `center` biases the search (the map view), `origin` is where distances are measured from (you), both [lng, lat].
//   `bbox` [west, south, east, north] keeps only places inside it ("Search this area"). google: false asks
//   OpenStreetMap only (what the search bar does while you type).
// PlaceSearch.suggest(text, { center, origin }) → Google's predictions while you type ([] without Google).
// PlaceSearch.details(place) → what the place card shows. PlaceSearch.resolve(placeId) → a prediction's point.
// PlaceSearch.reverse([lng, lat]) → Promise<{ title } | null>: what stands there ("Kramgasse 12"), for a dropped pin.
import { openState, weekLines } from './opening-hours.ts';
import type { OpenState } from './opening-hours.ts';

/** Which icon a place gets in the list and on the map. */
export type PlaceKind = 'food' | 'cafe' | 'bar' | 'shop' | 'health' | 'money' | 'toilet' | 'drink' | 'sport' | 'bed'
  | 'building' | 'mountain' | 'nature' | 'station' | 'other';
/** West, south, east, north. */
export type PlaceBbox = [west: number, south: number, east: number, north: number];
export interface PlaceSearchOptions {
  /** Where to search: the middle of the map. Without it nothing is found. */
  center?: LngLat;
  /** Where distances are measured from (you). Left out: results carry no distance. */
  origin?: LngLat | null;
  /** How far around `center` nearby places are looked for at first (1.5 when left out). */
  radiusKm?: number;
  /** Only places inside it ("Search this area"). */
  bbox?: PlaceBbox | null;
  /** false: OpenStreetMap only, even with a Google key (while typing: Google's predictions come from suggest()). */
  google?: boolean;
}
export interface PlaceSearchResult {
  title: string;
  /** Distance, category, rating, open or closed, address: '120 m · Café · Kramgasse 12, Bern'. */
  subtitle: string;
  /** In words ('Café', 'Fast food'), or ''. */
  category: string;
  address: string;
  kind: PlaceKind;
  lngLat: LngLat;
  origin: 'place';
  source: 'osm' | 'google';
  /** 'osm:N123456', 'google:ChIJ…' */
  id: string;
  /** Metres from `origin`, or null when no origin was given. */
  distance: number | null;
  /** OpenStreetMap: it is a building, not the shop or office in it. */
  building?: boolean;
  /** Google, once its details are known: stars, 1 to 5. */
  rating?: number | null;
  /** Open at this moment (Google after details, OpenStreetMap when its hours are understood); null: unknown. */
  openNow?: boolean | null;
  /** 'Open · Closes 22:00', when known. */
  openText?: string;
  /** Google, once its details are known: how many people rated it. */
  ratingCount?: number;
  /** Google, once its details are known: 1 (inexpensive) to 4 (very expensive). */
  priceLevel?: number | null;
  /** Its website, '' when none is known (Google, or OpenStreetMap after enrich()). */
  website?: string;
  /** A photo of it to show on its card, '' when there is none. */
  photo?: string;
  /** OpenStreetMap after enrich(): its opening hours as mapped ('Mo-Fr 08:00-18:00'). */
  hours?: string;
  /** OpenStreetMap after enrich(): its phone number and wheelchair access as mapped. */
  phone?: string;
  wheelchair?: string;
  /** OpenStreetMap after enrich(): how well known it is, the stand-in for a rating. */
  score?: number;
  /** Website, photo and score have been looked up (always for Google, after enrich() for OpenStreetMap). */
  details?: boolean;
}
export interface PlaceSearchAnswer {
  /** The kind of place the text asked for ('Restaurants' for "restaurant near me"), or null for a name. */
  category: string | null;
  /** "open now" was asked ("pharmacy open now", "Apotheke jetzt offen"): Google lists only open ones; for
   *  OpenStreetMap's the list keeps those open or of unknown hours, open ones first (openFirst()). */
  openNow: boolean;
  results: PlaceSearchResult[];
}
/** A prediction of Google's while typing: a name and where it is, but no point yet (resolve() or details()). */
export interface PlacePrediction {
  placeId: string;
  title: string;
  /** 'Spitalgasse 4, Bern' */
  subtitle: string;
  kind: PlaceKind;
  /** Metres from `origin`, when given. */
  distance: number | null;
}
/** A photo on the place card: from Google (`googleName`, fetched only when shown: googlePhoto()) or a free one (`url`). */
export interface PlacePhoto {
  url?: string;
  googleName?: string;
  /** Who took it, each with a link to them (Google requires the credit wherever the photo is shown large). */
  credits?: { name: string; uri: string }[];
  /** The photo on Google Maps. */
  mapsUri?: string;
  /** A brand's logo rather than a photo of the place. */
  logo?: boolean;
}
export interface PlaceReview {
  author: string;
  authorUri: string;
  avatar: string;
  /** The review on Google Maps. */
  mapsUri: string;
  rating: number;
  /** '3 weeks ago' */
  when: string;
  text: string;
}
/** What the place card shows. Every list may be empty and every text '': the card leaves those parts out. */
export interface PlaceDetails {
  source: 'google' | 'osm';
  title: string;
  category: string;
  address: string;
  /** Where it is, when the details say (a prediction's place). */
  lngLat: LngLat | null;
  rating: number | null;
  ratingCount: number;
  priceLevel: number | null;
  /** 'CHF 20–40' (Google's price range), '' when not known. */
  priceRange: string;
  open: OpenState | null;
  /** 'Monday: 08:00–18:00', … */
  weekHours: string[];
  /** OpenStreetMap's hours as mapped, when weekHours could not be written from them. */
  hoursText: string;
  phone: string;
  website: string;
  /** One line about it (Google's editorial summary). */
  summary: string;
  wheelchair: string;
  photos: PlacePhoto[];
  reviews: PlaceReview[];
  /** Its page on Google Maps. */
  mapsUri: string;
  /** Google's own card for it in an iframe (Maps Embed API: free), '' without a key. */
  embed: string;
  /** Google's details could not be had now (daily budget used, quota, failure): what is shown is OpenStreetMap's. */
  limited: boolean;
}
/** What details() is given: a place found by search, a row of the search bar, or a prediction. */
export interface PlaceRef {
  title: string;
  category?: string;
  address?: string;
  lngLat?: LngLat | null;
  /** 'osm:N123' (its OpenStreetMap tags are fetched), 'google:ChIJ…' */
  id?: string;
  /** Google's id, when known (a prediction, a Google result, or a row a Google prediction matched). */
  googleId?: string;
  /** What the row already knows (the engine's places, our own places): used as it is, without a request. */
  info?: { openingHours?: string; website?: string; phone?: string; image?: string; wikidata?: string; cuisine?: string; wheelchair?: string };
  photo?: string;
  photoIsLogo?: boolean;
}

/** A place found, before search() writes its subtitle. */
type Found = Omit<PlaceSearchResult, 'subtitle'> & { subtitle?: string };
type Origin = LngLat | null | undefined;
type Bbox = PlaceBbox | null | undefined;
/** Photon (photon.komoot.io): GeoJSON features with OpenStreetMap's tag as osm_key and osm_value. */
interface PhotonProperties {
  osm_type: string;
  osm_id: number;
  osm_key: string;
  osm_value: string;
  name?: string;
  countrycode?: string;
  street?: string;
  housenumber?: string;
  city?: string;
  town?: string;
  village?: string;
  locality?: string;
  district?: string;
}
interface PhotonFeature { geometry: { coordinates: LngLat }; properties?: PhotonProperties }
interface PhotonAnswer { features?: PhotonFeature[] }
/** Google Places (New): the fields asked for in SEARCH_FIELDS (Text Search) and DETAILS_FIELDS (Place Details). */
interface GoogleAuthor { displayName?: string; uri?: string; photoUri?: string }
interface GoogleMoney { currencyCode?: string; units?: string }
interface GooglePlace {
  id: string;
  displayName?: { text?: string };
  shortFormattedAddress?: string;
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  primaryType?: string;
  primaryTypeDisplayName?: { text?: string };
  types?: string[];
  businessStatus?: string;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  priceRange?: { startPrice?: GoogleMoney; endPrice?: GoogleMoney };
  websiteUri?: string;
  googleMapsUri?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  editorialSummary?: { text?: string };
  photos?: { name: string; authorAttributions?: GoogleAuthor[]; googleMapsUri?: string }[];
  currentOpeningHours?: { openNow?: boolean; nextOpenTime?: string; nextCloseTime?: string; weekdayDescriptions?: string[] };
  regularOpeningHours?: { weekdayDescriptions?: string[] };
  reviews?: { rating?: number; relativePublishTimeDescription?: string; text?: { text?: string }; originalText?: { text?: string }; authorAttribution?: GoogleAuthor;
    googleMapsUri?: string }[];
  accessibilityOptions?: { wheelchairAccessibleEntrance?: boolean };
}
interface GoogleAnswer { places?: GooglePlace[] }
interface GoogleSuggestions {
  suggestions?: { placePrediction?: { placeId: string; types?: string[]; distanceMeters?: number;
    structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } }; text?: { text?: string } } }[];
}

const CONFIG = window.APP_CONFIG || {};
const GOOGLE_KEY = (CONFIG.googlePlacesKey || '').trim();
/** The Places API (web service) is asked: a key, and not the Embed-only mode. */
const GOOGLE_API = !!GOOGLE_KEY && CONFIG.googlePlacesMode !== 'embed';
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
  { label: 'Town halls & migration offices', words: ['town hall', 'townhall', 'town halls', 'immigration office', 'migration office', 'immigration',
    'migrationsamt', 'migrationsdienst', 'einwohnerdienste', 'einwohnerkontrolle', 'gemeindeverwaltung', 'residence permit', 'permit', 'mairie',
    'municipio', 'integration office'], tags: ['amenity:townhall', 'office:government'],
    // office:government is any office: keep the ones newcomers deal with
    names: /migra|einwohner|bev[oö]lkerung|population|integration|gemeinde|stadtverwaltung|commune|ausl[aä]nder|zivilstand|etat civil|state secretariat|sem\b/i },
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

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const NEARBY = /\s*\b(near me|nearby|near by|around me|close by|close to me|in der nahe|in meiner nahe|pres de moi|vicino)\s*$/;

function matchCategory(text: string) {
  const q = fold(text).replace(NEARBY, '').replace(/^(the |a |an |some )/, '').replace(/^(closest|nearest|next|nachste[rsn]?|naechste[rsn]?) /, '');
  if (!q) return null;
  for (const c of CATEGORIES) if (c.words.some((w) => fold(w) === q)) return c;
  // while typing: "restau" → Restaurants (a word long enough not to be the start of a name by chance)
  if (q.length >= 4) for (const c of CATEGORIES) if (c.words.some((w) => w.length > q.length && fold(w).startsWith(q))) return c;
  return null;
}

function distance(a: LngLat, b: LngLat) {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
}
const formatDistance = (m: number) => (m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : m < 9950 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 1000)} km`);

// OpenStreetMap / Google place types → icon kind (index.html draws one icon per kind)
const KIND_BY_TYPE: Record<string, PlaceKind> = {
  restaurant: 'food', fast_food: 'food', food_court: 'food', meal_takeaway: 'food', meal_delivery: 'food',
  cafe: 'cafe', coffee_shop: 'cafe', ice_cream: 'cafe', bakery: 'cafe', ice_cream_shop: 'cafe', confectionery: 'cafe', pastry: 'cafe', tea_house: 'cafe',
  bar: 'bar', pub: 'bar', biergarten: 'bar', nightclub: 'bar', night_club: 'bar', wine_bar: 'bar',
  supermarket: 'shop', convenience: 'shop', kiosk: 'shop', mall: 'shop', department_store: 'shop', clothes: 'shop', shoes: 'shop',
  grocery_store: 'shop', shopping_mall: 'shop', clothing_store: 'shop', store: 'shop', newsagent: 'shop', chemist: 'health',
  pharmacy: 'health', hospital: 'health', doctors: 'health', doctor: 'health', clinic: 'health', dentist: 'health', drugstore: 'health',
  atm: 'money', bank: 'money', bureau_de_change: 'money',
  toilets: 'toilet', drinking_water: 'drink', fountain: 'drink', public_bath: 'sport',
  hotel: 'bed', hostel: 'bed', guest_house: 'bed', motel: 'bed', lodging: 'bed', apartment: 'bed', camp_site: 'bed',
  museum: 'building', gallery: 'building', art_gallery: 'building', theatre: 'building', cinema: 'building', movie_theater: 'building',
  arts_centre: 'building', library: 'building', place_of_worship: 'building', church: 'building', university: 'building',
  school: 'building', college: 'building', attraction: 'building', tourist_attraction: 'building', townhall: 'building',
  city_hall: 'building', post_office: 'building', police: 'building', viewpoint: 'mountain',
  park: 'nature', garden: 'nature', playground: 'nature', nature_reserve: 'nature',
  fitness_centre: 'sport', sports_centre: 'sport', swimming_pool: 'sport', water_park: 'sport', gym: 'sport', stadium: 'sport', pitch: 'sport',
  station: 'station', halt: 'station', train_station: 'station', transit_station: 'station', bus_station: 'station', subway_station: 'station',
};
const kindFor = (...types: (string | undefined)[]): PlaceKind => { for (const t of types) if (t && KIND_BY_TYPE[t]) return KIND_BY_TYPE[t]; return 'other'; };
const LABELS: Record<string, string> = { fast_food: 'Fast food', cafe: 'Café', toilets: 'Toilets', doctors: 'Doctor', atm: 'Cash machine', chemist: 'Drugstore',
  place_of_worship: 'Place of worship', fitness_centre: 'Gym', sports_centre: 'Sports centre', drinking_water: 'Drinking water',
  convenience: 'Convenience store', kiosk: 'Kiosk', department_store: 'Department store', mall: 'Shopping centre', clothes: 'Clothes shop',
  hairdresser: 'Hairdresser', townhall: 'Town hall', government: 'Public office', yes: '' };
const humanize = (v: string) => (v in LABELS ? LABELS[v] : (v || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()));

// Photon features that are not destinations (paths, signposts, platforms: the stop search covers those)
const SKIP_KEYS = new Set(['highway', 'information', 'boundary', 'place', 'landuse', 'natural', 'waterway', 'power', 'barrier', 'route']);

function fromPhoton(f: PhotonFeature, origin: Origin): Found | null {
  const p = f.properties || {} as PhotonProperties;
  if (!p.name || !COUNTRIES.has(p.countrycode!) || SKIP_KEYS.has(p.osm_key)) return null;
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

function subtitle(r: Found) {
  const parts = [];
  if (r.category) parts.push(r.category);
  if (r.distance != null) parts.push(formatDistance(r.distance));
  if (r.rating) parts.push(`★ ${r.rating.toFixed(1)}`);
  if (r.openText) parts.push(r.openText.split(' · ')[0]);
  else if (r.openNow === true) parts.push('Open');
  else if (r.openNow === false) parts.push('Closed');
  if (r.address) parts.push(r.address);
  return parts.join(' · ');
}

// The same place often comes twice (the shop and its building, a node and an area): keep one per name and spot
function dedupe(list: Found[]) {
  const out: Found[] = [];
  for (const r of list) {
    const twin = out.find((o) => fold(o.title) === fold(r.title) && distance(o.lngLat, r.lngLat) < 80);
    if (!twin) out.push(r);
    else if (twin.building && !r.building) out[out.indexOf(twin)] = r;
  }
  return out;
}

const cache = new Map<string, unknown>();
async function getJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const key = init ? url + init.body : url;
  if (cache.has(key)) return cache.get(key) as T;
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  cache.set(key, data);
  return data;
}

const round = (x: number) => x.toFixed(3); // ~100 m: nearby searches from almost the same spot share a cached answer

// Nearest places of one kind, widening the circle when there are few
async function photonNearby(cat: (typeof CATEGORIES)[number], center: LngLat, origin: Origin, radiusKm: number, bbox: Bbox) {
  let found: Found[] = [];
  for (const r of bbox ? [radiusKm] : [radiusKm, Math.max(radiusKm * 4, 5)]) { // an area asked for is not widened
    const params = new URLSearchParams({ lat: round(center[1]), lon: round(center[0]), radius: String(Math.min(r, 25)), limit: '40', lang: (window.APP_LANG?.pick(['de', 'fr', 'en']) ?? 'en') });
    cat.tags.forEach((t) => params.append('osm_tag', t));
    const data = await getJSON<PhotonAnswer>(`${PHOTON}reverse?${params}`);
    found = dedupe((data.features || []).map((f) => fromPhoton(f, origin)).filter(Boolean) as Found[])
      .filter((r) => !cat.names || r.category === 'Town hall' || cat.names.test(r.title));
    if (found.length >= 6 || r >= 25) break;
  }
  const from = origin || center;
  return found.sort((a, b) => distance(from, a.lngLat) - distance(from, b.lngLat));
}

// Places by name, the ones near the map first
async function photonByName(text: string, center: LngLat, origin: Origin, bbox: Bbox) {
  const params = new URLSearchParams({ q: text, lat: round(center[1]), lon: round(center[0]), zoom: '16',
    location_bias_scale: '0.1', limit: '40', lang: (window.APP_LANG?.pick(['de', 'fr', 'en']) ?? 'en') });
  if (bbox) params.set('bbox', bbox.map(round).join(','));
  const data = await getJSON<PhotonAnswer>(`${PHOTON}api/?${params}`);
  const list = dedupe((data.features || []).map((f) => fromPhoton(f, origin)).filter(Boolean) as Found[]);
  // Photon's order is by how well the name matches; nearer places move up (300 m ≈ one place in the list), nearer
  // to you when you are on the map
  const from = origin || center;
  return list.map((r, i) => ({ r, score: i * 0.3 + distance(from, r.lngLat) / 1000 }))
    .sort((a, b) => a.score - b.score).map((x) => x.r);
}

// ---- Google Places API (New), called straight from the page (restrict the key to the site's address) ----

/** The SKUs the page uses, by what they are billed as. */
export type GoogleSku = 'autocomplete' | 'search' | 'details' | 'resolve' | 'photo';
// Requests per day on this device, about a 31st of each free monthly cap: autocomplete (Autocomplete Requests,
// Essentials 10,000), search (Text Search Pro, 5,000), details (Place Details Enterprise + Atmosphere, 1,000),
// resolve (Place Details Essentials, 10,000), photo (Place Details Photos, Enterprise, 1,000). config.js may lower
// them (googleDailyLimits). The project's own quotas in the Cloud console are the hard stop (docs/places-data.md).
const DAILY: Record<GoogleSku, number> = { autocomplete: 300, search: 150, details: 30, resolve: 300, photo: 30, ...(CONFIG.googleDailyLimits || {}) };
interface Budget { day: string; used: Partial<Record<GoogleSku, number>>; out: Partial<Record<GoogleSku, boolean>> }
const BUDGET_KEY = 'google-places-budget';
const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
let budget: Budget | null = null;
function budgetNow(): Budget {
  if (!budget || budget.day !== today()) {
    try { budget = JSON.parse(localStorage.getItem(BUDGET_KEY) || 'null'); } catch { budget = null; }
    if (!budget || budget.day !== today()) budget = { day: today(), used: {}, out: {} };
  }
  return budget;
}
function saveBudget() { try { localStorage.setItem(BUDGET_KEY, JSON.stringify(budget)); } catch { /* counted for this page only */ } }
/** A request of this SKU may still be made today (Google, budget left, no "quota exceeded" today). */
const canAsk = (sku: GoogleSku) => { const b = budgetNow(); return GOOGLE_API && !b.out[sku] && (b.used[sku] || 0) < DAILY[sku]; };
function spend(sku: GoogleSku) { const b = budgetNow(); b.used[sku] = (b.used[sku] || 0) + 1; saveBudget(); }
function exhausted(sku: GoogleSku) { budgetNow().out[sku] = true; saveBudget(); }

class GoogleError extends Error {
  status: number;
  constructor(status: number) { super(`Google Places HTTP ${status}`); this.status = status; }
}
// Google's answers are kept for the page's life (Places content may not be stored beyond that; place ids may):
// the same text, area or place is never asked twice. The key of a request leaves out the session token.
const googleCache = new Map<string, unknown>();
async function google<T>(sku: GoogleSku, cacheKey: string, url: string, init: RequestInit): Promise<T> {
  if (googleCache.has(cacheKey)) return googleCache.get(cacheKey) as T;
  if (!canAsk(sku)) throw new GoogleError(0);
  spend(sku);
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_KEY, ...init.headers } });
  // over a quota (the project's, or a cap set in the console): nothing more of this kind today
  if (res.status === 429 || res.status === 403) exhausted(sku); // 403: key not allowed here, API off: no use retrying
  if (!res.ok) throw new GoogleError(res.status);
  const data = await res.json();
  if (googleCache.size > 300) googleCache.delete(googleCache.keys().next().value!);
  googleCache.set(cacheKey, data);
  return data;
}
const lang = () => window.APP_LANG?.pick(['de', 'fr', 'it', 'en']) ?? 'en';
const coarse = (x: number) => x.toFixed(2); // ~1 km: searches from nearly the same view share one answer

// Results list: Text Search with Pro fields only (5,000 free a month). Rating, price, hours and photos are
// Enterprise fields: details() asks for them when a place is opened.
const SEARCH_FIELDS = ['places.id', 'places.displayName', 'places.shortFormattedAddress', 'places.location', 'places.primaryType',
  'places.primaryTypeDisplayName', 'places.types', 'places.businessStatus'].join(',');
async function googleSearch(text: string, center: LngLat, origin: Origin, radiusKm: number, bbox: Bbox, openNow: boolean) {
  const where = bbox
    ? { locationRestriction: { rectangle: { low: { latitude: +round(bbox[1]), longitude: +round(bbox[0]) }, high: { latitude: +round(bbox[3]), longitude: +round(bbox[2]) } } } }
    : { locationBias: { circle: { center: { latitude: +coarse(center[1]), longitude: +coarse(center[0]) }, radius: Math.round(Math.min(radiusKm, 50)) * 1000 || 1000 } } };
  const body = JSON.stringify({ textQuery: text, languageCode: lang(), regionCode: 'CH', pageSize: 15, ...(openNow ? { openNow: true } : {}), ...where });
  const data = await google<GoogleAnswer>('search', 'search:' + fold(text) + body, 'https://places.googleapis.com/v1/places:searchText', {
    method: 'POST', headers: { 'X-Goog-FieldMask': SEARCH_FIELDS }, body });
  return (data.places || []).filter((p) => p.location && p.businessStatus !== 'CLOSED_PERMANENTLY').map((p): Found => {
    const lngLat: LngLat = [p.location!.longitude, p.location!.latitude];
    const known = detailsSeen.get(p.id); // opened before: its rating and hours are known
    return {
      title: (p.displayName && p.displayName.text) || '',
      category: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || '',
      address: p.shortFormattedAddress || '',
      kind: kindFor(p.primaryType, ...(p.types || [])),
      lngLat,
      origin: 'place',
      source: 'google',
      id: `google:${p.id}`,
      rating: known ? known.rating : null,
      ratingCount: known ? known.ratingCount : 0,
      priceLevel: known ? known.priceLevel : null,
      openNow: known && known.open ? known.open.open : null,
      openText: known && known.open ? known.open.text : '',
      details: true,
      distance: origin ? distance(origin, lngLat) : null,
    };
  }).filter((r) => r.title);
}

// Typing: Autocomplete (New). One session token from the first keystroke to a pick: the Place Details that ends it
// makes the session's predictions free. A session with no pick is billed per request (10,000 free a month).
// includedRegionCodes keeps it to Switzerland and Liechtenstein (it also means no query predictions: the search
// bar has its own "search for …" rows).
let session: string | null = null;
const newToken = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
/** Ends the typing session without a pick (the search field closed or cleared, another field, a list asked for). */
function endSession() { session = null; }
async function suggest(text: string, { center, origin }: PlaceSearchOptions = {}): Promise<PlacePrediction[]> {
  const q = text.trim();
  if (q.length < 3 || !center || !canAsk('autocomplete')) return [];
  session ||= newToken();
  const base = { input: q, languageCode: lang(), regionCode: 'CH', includedRegionCodes: ['ch', 'li'],
    locationBias: { circle: { center: { latitude: +coarse(center[1]), longitude: +coarse(center[0]) }, radius: 20000 } },
    ...(origin ? { origin: { latitude: +round(origin[1]), longitude: +round(origin[0]) } } : {}) };
  try {
    const data = await google<GoogleSuggestions>('autocomplete', 'ac:' + fold(q) + JSON.stringify(base), 'https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST', body: JSON.stringify({ ...base, sessionToken: session }),
      headers: { 'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.types,suggestions.placePrediction.distanceMeters' } });
    return (data.suggestions || []).flatMap((s) => {
      const p = s.placePrediction;
      if (!p || !p.placeId) return [];
      const title = p.structuredFormat?.mainText?.text || p.text?.text || '';
      return title ? [{ placeId: p.placeId, title, subtitle: (p.structuredFormat?.secondaryText?.text || '').replace(/, (Switzerland|Schweiz|Suisse|Svizzera)$/, ''),
        kind: kindFor(...(p.types || [])), distance: p.distanceMeters ?? null }] : [];
    });
  } catch (e) {
    if (!(e instanceof GoogleError && e.status === 0)) console.warn('Google Autocomplete failed', e instanceof GoogleError ? e.status : e);
    return [];
  }
}

// A prediction picked for the start of a trip: only its point (Place Details Essentials, 10,000 free), which also
// ends the typing session (a session ended by an Essentials request still bills its first 12 predictions, as
// Autocomplete Requests: 10,000 free).
async function resolve(placeId: string): Promise<LngLat | null> {
  const token = session;
  endSession(); // a pick ends the typing session (one known already sends nothing: its predictions are then billed each)
  const known = detailsSeen.get(placeId);
  if (known && known.lngLat) return known.lngLat;
  try {
    const p = await google<GooglePlace>('resolve', 'resolve:' + placeId, `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}${token ? `?sessionToken=${token}` : ''}`,
      { headers: { 'X-Goog-FieldMask': 'id,location' } });
    return p.location ? [p.location.longitude, p.location.latitude] : null;
  } catch { return null; }
}

// Opening a place: one Place Details request with everything the card shows (Enterprise + Atmosphere: 1,000 free
// a month), once per place and page.
const DETAILS_FIELDS = ['id', 'displayName', 'shortFormattedAddress', 'location', 'primaryTypeDisplayName', 'rating', 'userRatingCount',
  'priceLevel', 'priceRange', 'currentOpeningHours', 'regularOpeningHours', 'nationalPhoneNumber', 'internationalPhoneNumber', 'websiteUri',
  'googleMapsUri', 'editorialSummary', 'accessibilityOptions', 'photos', 'reviews'].join(',');
const PRICE: Record<string, number> = { PRICE_LEVEL_FREE: 0, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 };
const hhmm = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
/** Google's open state: 'Open · Closes 22:00', 'Closed · Opens 11:30' (another day: 'Opens Mon 11:30'). */
export function googleOpen(h: GooglePlace['currentOpeningHours'], now = new Date()): OpenState | null {
  if (!h || h.openNow == null) return null;
  const at = h.openNow ? h.nextCloseTime : h.nextOpenTime;
  let when = at ? hhmm(at) : '';
  if (at && when) {
    const d = new Date(at), days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 864e5);
    if (days === 1) when = 'tomorrow ' + when;
    else if (days > 1) when = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' + when;
  }
  return h.openNow ? { open: true, text: when ? `Open · Closes ${when}` : 'Open' } : { open: false, text: when ? `Closed · Opens ${when}` : 'Closed' };
}
const money = (m?: GoogleMoney) => (m && m.units ? `${m.currencyCode === 'CHF' || !m.currencyCode ? 'CHF' : m.currencyCode} ${m.units}` : '');
/** Places opened on this page: Google id → its details (so a list shows the rating of those you have seen). */
const detailsSeen = new Map<string, PlaceDetails>();
function fromGoogleDetails(p: GooglePlace): PlaceDetails {
  const range = p.priceRange ? [money(p.priceRange.startPrice), (p.priceRange.endPrice && p.priceRange.endPrice.units) || ''].filter(Boolean).join('–') : '';
  return {
    source: 'google',
    title: (p.displayName && p.displayName.text) || '',
    category: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || '',
    address: p.shortFormattedAddress || p.formattedAddress || '',
    lngLat: p.location ? [p.location.longitude, p.location.latitude] : null,
    rating: p.rating || null,
    ratingCount: p.userRatingCount || 0,
    priceLevel: p.priceLevel && p.priceLevel in PRICE ? PRICE[p.priceLevel] : null,
    priceRange: range,
    open: googleOpen(p.currentOpeningHours),
    weekHours: (p.currentOpeningHours && p.currentOpeningHours.weekdayDescriptions) || (p.regularOpeningHours && p.regularOpeningHours.weekdayDescriptions) || [],
    hoursText: '',
    phone: p.nationalPhoneNumber || p.internationalPhoneNumber || '',
    website: p.websiteUri || '',
    summary: (p.editorialSummary && p.editorialSummary.text) || '',
    wheelchair: p.accessibilityOptions && p.accessibilityOptions.wheelchairAccessibleEntrance != null
      ? (p.accessibilityOptions.wheelchairAccessibleEntrance ? 'Wheelchair accessible entrance' : 'No wheelchair accessible entrance') : '',
    photos: (p.photos || []).slice(0, 6).map((ph) => ({
      googleName: ph.name,
      credits: (ph.authorAttributions || []).filter((a) => a.displayName).map((a) => ({ name: a.displayName!, uri: https(a.uri) })),
      mapsUri: ph.googleMapsUri || '',
    })),
    reviews: (p.reviews || []).slice(0, 5).map((r) => ({
      author: (r.authorAttribution && r.authorAttribution.displayName) || 'A Google user',
      authorUri: https(r.authorAttribution && r.authorAttribution.uri),
      avatar: https(r.authorAttribution && r.authorAttribution.photoUri),
      mapsUri: r.googleMapsUri || '',
      rating: r.rating || 0,
      when: r.relativePublishTimeDescription || '',
      text: (r.text && r.text.text) || (r.originalText && r.originalText.text) || '',
    })).filter((r) => r.rating || r.text),
    mapsUri: p.googleMapsUri || '',
    embed: embedUrl({ title: '', googleId: p.id }),
    limited: false,
  };
}

/** Google's addresses come as '//maps.google.com/…' at times. */
const https = (u?: string) => (u ? (u.startsWith('//') ? 'https:' + u : u) : '');

// Google's photos: each one fetched is a billed request (Place Details Photos, 1,000 free a month), so it is asked
// for its short-lived address once (skipHttpRedirect) and that address is shown again from memory for the page's
// life, however often the card, the row or the map card is drawn. Counted when asked; '' over budget or on failure.
const photoUris = new Map<string, string>();
const photoAsks = new Map<string, Promise<string>>();
function googlePhoto(name: string, px: number): Promise<string> {
  const key = `${name}@${px}`;
  const asked = photoAsks.get(key);
  if (asked) return asked;
  if (!canAsk('photo')) return Promise.resolve('');
  spend('photo');
  const ask = fetch(`https://places.googleapis.com/v1/${name}/media?maxWidthPx=${px}&skipHttpRedirect=true`, { headers: { 'X-Goog-Api-Key': GOOGLE_KEY } })
    .then((res) => {
      if (res.status === 429 || res.status === 403) exhausted('photo');
      return res.ok ? res.json() as Promise<{ photoUri?: string }> : null;
    })
    .then((j) => { const uri = (j && j.photoUri) || ''; if (uri) photoUris.set(key, uri); else photoAsks.delete(key); return uri; })
    .catch(() => { photoAsks.delete(key); return ''; });
  photoAsks.set(key, ask);
  return ask;
}
/** Google's own card of a place (Maps Embed API: free and without limit; needs the key and the Embed API enabled). */
function embedUrl(r: PlaceRef): string {
  if (!GOOGLE_KEY) return '';
  const q = r.googleId ? `place_id:${r.googleId}` : [r.title, r.address].filter(Boolean).join(', ');
  return q ? `https://www.google.com/maps/embed/v1/place?${new URLSearchParams({ key: GOOGLE_KEY, q, language: lang() })}` : '';
}

// ---- What a place card shows ----
async function details(r: PlaceRef): Promise<PlaceDetails> {
  const googleId = r.googleId || (r.id && r.id.startsWith('google:') ? r.id.slice(7) : '');
  // A pick ends the typing session. A place opened before sends nothing (that session's predictions are then billed
  // each, as Autocomplete Requests); over today's budget the session is left to resolve(), which may still end it.
  if (googleId && detailsSeen.has(googleId)) { endSession(); return detailsSeen.get(googleId)!; }
  if (googleId && canAsk('details')) {
    const token = session;
    endSession();
    try {
      const p = await google<GooglePlace>('details', 'details:' + googleId, `https://places.googleapis.com/v1/places/${encodeURIComponent(googleId)}?${new URLSearchParams({
        languageCode: lang(), regionCode: 'CH', ...(token ? { sessionToken: token } : {}) })}`, { headers: { 'X-Goog-FieldMask': DETAILS_FIELDS } });
      const d = fromGoogleDetails(p);
      if (!d.title) d.title = r.title;
      detailsSeen.set(googleId, d);
      return d;
    } catch (e) {
      if (!(e instanceof GoogleError && e.status === 0)) console.warn('Google Place Details failed, using OpenStreetMap', e instanceof GoogleError ? e.status : e);
    }
  }
  const d = await osmDetails(r);
  d.embed = embedUrl({ ...r, googleId });
  d.limited = !!googleId && GOOGLE_API;
  return d;
}

// OpenStreetMap: what the row knows (the engine's places, ours), else its tags fetched by id (Photon's places)
async function osmDetails(r: PlaceRef): Promise<PlaceDetails> {
  const info = { ...(r.info || {}) };
  let photo = r.photo || info.image || '';
  let logo = !!(r.photoIsLogo && photo);
  if (r.id && /^osm:[NWR]\d+$/.test(r.id)) {
    const [found] = await enrich([{ title: r.title, subtitle: '', category: r.category || '', address: r.address || '', kind: 'other',
      lngLat: r.lngLat || [0, 0], origin: 'place', source: 'osm', id: r.id, distance: null }]).catch(() => [null]);
    if (found) {
      info.openingHours ||= found.hours;
      info.website ||= found.website;
      info.phone ||= found.phone;
      info.wheelchair ||= found.wheelchair;
      if (!photo && found.photo) photo = found.photo;
    }
  } else if (!photo && info.wikidata) {
    const pics = await wikidataImages([[info.wikidata, 'P18']]);
    photo = pics.get(`${info.wikidata}:P18`) || '';
    logo = false;
  }
  const week = weekLines(info.openingHours);
  const WHEEL: Record<string, string> = { yes: 'Wheelchair accessible', limited: 'Partly wheelchair accessible', no: 'Not wheelchair accessible' };
  return {
    source: 'osm',
    title: r.title,
    category: r.category || '',
    address: r.address || '',
    lngLat: r.lngLat || null,
    rating: null,
    ratingCount: 0,
    priceLevel: null,
    priceRange: '',
    open: openState(info.openingHours),
    weekHours: week,
    hoursText: week.length ? '' : (info.openingHours || ''),
    phone: info.phone || '',
    website: info.website ? (/^https?:\/\//.test(info.website) ? info.website : 'https://' + info.website) : '',
    summary: info.cuisine ? info.cuisine[0].toUpperCase() + info.cuisine.slice(1) : '',
    wheelchair: (info.wheelchair && WHEEL[info.wheelchair]) || '',
    photos: photo ? [{ url: photo, logo }] : [],
    reviews: [],
    mapsUri: '',
    embed: '',
    limited: false,
  };
}

// "open now" in the words people type: asked of Google (openNow), and the list keeps open places first
const OPEN_NOW = /(^|\s)(open now|opened now|open right now|jetzt offen|jetzt geoffnet|offen jetzt|geoffnet jetzt|ouvert maintenant|ouvert en ce moment|aperto ora|aperto adesso)(\s|$)|\s(geoffnet|offen|ouvert|aperto)$/;
/** The text without "open now", and whether it was there ("pharmacy open now" → ['pharmacy', true]). */
export function splitOpenNow(text: string): [string, boolean] {
  const f = fold(text);
  const m = OPEN_NOW.exec(f);
  if (!m) return [text, false];
  const rest = (f.slice(0, m.index) + ' ' + f.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
  return rest ? [rest, true] : [text, false]; // "Offen" alone may be a name
}
/** Open ones first, then the ones whose hours are unknown; the closed ones are left out. */
export function openFirst<T extends { openNow?: boolean | null }>(list: T[]): T[] {
  return [...list.filter((r) => r.openNow === true), ...list.filter((r) => r.openNow == null)];
}

async function search(text: string, { center, origin, radiusKm = 1.5, bbox, google: useGoogle = true }: PlaceSearchOptions = {}): Promise<PlaceSearchAnswer> {
  const [q, openNow] = splitOpenNow(text.trim());
  if (q.length < 2 || !center) return { category: null, openNow, results: [] };
  const cat = matchCategory(q);
  let list: Found[] | null = null;
  if (useGoogle && canAsk('search')) {
    // "near me" is already said by the location bias
    const query = NEARBY.test(fold(q)) ? fold(q).replace(NEARBY, '') || q : q;
    try { list = await googleSearch(query, center, origin, radiusKm, bbox, openNow); }
    catch (e) { if (!(e instanceof GoogleError && e.status === 0)) console.warn('Google Places failed, using OpenStreetMap', e instanceof GoogleError ? e.status : e); }
  }
  if (!list) list = cat ? await photonNearby(cat, center, origin, radiusKm, bbox) : await photonByName(q, center, origin, bbox);
  for (const r of list) r.subtitle = subtitle(r);
  return { category: cat ? cat.label : null, openNow, results: list as PlaceSearchResult[] };
}

// ---- Details for the best places of a category (OpenStreetMap has no ratings or photos of its own) ----
// OpenStreetMap's API gives the tags of the places found (website, opening hours, a photo on Wikimedia Commons,
// a Wikidata entry); a second one asks Wikidata for the photo of those that only have an entry there.
// How well known a place is stands in for its rating: it ranks the places of a category.
interface OsmTags { [k: string]: string | undefined }
type WikidataClaim = { mainsnak?: { datavalue?: { value?: string } } }[];
interface WikidataClaims { entities?: Record<string, { claims?: { P18?: WikidataClaim; P154?: WikidataClaim } }> }
const commonsFile = (file: string) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.replace(/^File:/i, ''))}?width=400`;

// ---- Pictures from Wikidata: a place's photo (P18), a brand's logo (P154) ----
/** 'Q72:P18' → the picture's URL, '' when the item has none. Kept for the page's life: typing asks for the same ones. */
const wikidataSeen = new Map<string, string>();
/** Pictures of Wikidata items: 'Q72:P18' → URL for those that have one. At most 40 items are asked for at a time. */
export async function wikidataImages(wanted: [qid: string, prop: 'P18' | 'P154'][]): Promise<Map<string, string>> {
  const ask = [...new Set(wanted.map(([q]) => q).filter((q) => /^Q\d+$/.test(q) && !wikidataSeen.has(`${q}:P18`)))].slice(0, 40);
  if (ask.length) {
    try {
      const data = await getJSON<WikidataClaims>(
        `https://www.wikidata.org/w/api.php?action=wbgetentities&props=claims&format=json&origin=*&ids=${ask.join('|')}`, { signal: AbortSignal.timeout(5000) });
      for (const q of ask) {
        const claims = data.entities?.[q]?.claims;
        for (const prop of ['P18', 'P154'] as const) {
          const file = claims?.[prop]?.[0]?.mainsnak?.datavalue?.value;
          wikidataSeen.set(`${q}:${prop}`, file ? commonsFile(file) : '');
        }
      }
    } catch (e) { /* no pictures from Wikidata this time */ }
  }
  const found = new Map<string, string>();
  for (const [q, prop] of wanted) {
    const url = wikidataSeen.get(`${q}:${prop}`);
    if (url) found.set(`${q}:${prop}`, url);
  }
  return found;
}
const OSM_TYPES = { N: 'node', W: 'way', R: 'relation' } as const;
async function enrich(list: PlaceSearchResult[]): Promise<PlaceSearchResult[]> {
  const osm = list.filter((r) => r.source === 'osm' && /^osm:[NWR]\d+$/.test(r.id) && !r.details);
  if (!osm.length) return list;
  const ids: Record<keyof typeof OSM_TYPES, string[]> = { N: [], W: [], R: [] };
  for (const r of osm) ids[r.id[4] as keyof typeof OSM_TYPES].push(r.id.slice(5));
  type Elements = { elements?: { type: string; id: number; tags?: OsmTags }[] };
  const types = (Object.keys(OSM_TYPES) as (keyof typeof OSM_TYPES)[]).filter((t) => ids[t].length);
  const tagsById = new Map<string, OsmTags>();
  const keep = (data: Elements) => { for (const e of data.elements || []) tagsById.set(`osm:${e.type[0].toUpperCase()}${e.id}`, e.tags || {}); };
  try {
    // OpenStreetMap's own API: fast, one request per type (nodes, ways, relations)
    const answers = await Promise.all(types.map((t) => getJSON<Elements>(
      `https://api.openstreetmap.org/api/0.6/${OSM_TYPES[t]}s.json?${OSM_TYPES[t]}s=${ids[t].join(',')}`, { signal: AbortSignal.timeout(5000) })));
    answers.forEach(keep);
  } catch (e) {
    // one of them deleted since Photon's copy (the API then answers nothing at all): Overpass skips those
    const query = encodeURIComponent(`[out:json][timeout:8];(${types.map((t) => `${OSM_TYPES[t]}(id:${ids[t].join(',')});`).join('')});out tags;`);
    try { keep(await getJSON<Elements>(`https://overpass-api.de/api/interpreter?data=${query}`, { signal: AbortSignal.timeout(6000) })); }
    catch (err) { console.warn('No details for the places found', err); }
  }
  const wikidata: Record<string, PlaceSearchResult[]> = {};
  for (const r of osm) {
    const t = tagsById.get(r.id) || {};
    const site = t.website || t['contact:website'] || '';
    r.website = /^https?:\/\//.test(site) ? site : site ? 'https://' + site : '';
    r.hours = t.opening_hours || '';
    r.phone = t.phone || t['contact:phone'] || '';
    r.wheelchair = t.wheelchair || '';
    const open = openState(r.hours);
    r.openNow = open ? open.open : null;
    r.openText = open ? open.text : '';
    const image = t.image && /^https?:\/\/.+\.(jpe?g|png|webp)$/i.test(t.image) ? t.image : '';
    r.photo = image || (t.wikimedia_commons && /^File:/i.test(t.wikimedia_commons) ? commonsFile(t.wikimedia_commons) : '');
    if (!r.photo && t.wikidata) (wikidata[t.wikidata] ||= []).push(r);
    const extra = t.cuisine ? t.cuisine.split(';')[0].replace(/_/g, ' ') : t.stars ? `${t.stars}★ hotel` : '';
    if (extra && !r.category.toLowerCase().includes(extra.toLowerCase())) r.category = r.category ? `${r.category}, ${extra}` : extra;
    // well known: on Wikidata, with a photo, a website, its opening hours, more of its details mapped
    r.score = (t.wikidata ? 3 : 0) + (r.photo ? 2 : 0) + (r.website ? 1.5 : 0) + (r.hours ? 1 : 0)
      + (t.stars ? (+t.stars || 0) * 0.4 : 0) + Math.min(Object.keys(t).length, 25) / 10;
    r.details = true;
  }
  const photos = await wikidataImages(Object.keys(wikidata).map((q) => [q, 'P18']));
  for (const [key, url] of photos) for (const r of wikidata[key.split(':')[0]]) { r.photo = url; r.score = (r.score || 0) + 2; }
  return list;
}

// What stands at a point, for a pin dropped on the map: the place it is on, else the nearest address
// ("Kramgasse 12"), "Near …" when that is some way off
async function reverse(lngLat: LngLat) {
  const params = new URLSearchParams({ lat: lngLat[1].toFixed(5), lon: lngLat[0].toFixed(5), lang: (window.APP_LANG?.pick(['de', 'fr', 'en']) ?? 'en') });
  const data = await getJSON<PhotonAnswer>(`${PHOTON}reverse?${params}`);
  const f = (data.features || [])[0];
  const p = f && f.properties;
  if (!p) return null;
  const far = distance(lngLat, f.geometry.coordinates);
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const town = p.city || p.town || p.village || p.locality || p.district || '';
  const named = p.name && !SKIP_KEYS.has(p.osm_key) && far < 30 ? p.name : '';
  const label = named || street || p.name || town;
  return label ? { title: far > 80 ? `Near ${label}` : label } : null;
}

export const PlaceSearch = {
  /** Places for what was typed: the nearest of a kind for a category word, else places with that name. */
  search,
  /** Google's predictions while typing ([] without Google, under 3 letters, or once today's budget is used). */
  suggest,
  /** Ends a typing session without a pick (field closed or cleared): the next keystroke starts a new one. */
  endSession,
  /** A prediction's point, for the start of a trip (the cheapest Place Details). */
  resolve,
  /** What the place card shows: Google's details for a Google place (asked once), else OpenStreetMap's. */
  details,
  /** A Google photo's address to show, `px` wide: fetched (and counted) once per page, '' over budget or on failure. */
  photo: googlePhoto,
  /** A Google photo's address if it has been fetched already (no request), else ''. */
  photoKnown: (name: string, px: number): string => photoUris.get(`${name}@${px}`) || '',
  /** Google's details of a place opened on this page, if any (what the list then shows of it). */
  seen: (googleId: string): PlaceDetails | null => detailsSeen.get(googleId) || null,
  /** What stands at a point ('Kramgasse 12', 'Near Bärenpark'), or null when nothing is known there. */
  reverse,
  /** OpenStreetMap places: adds website, opening hours, a photo and a score from OpenStreetMap and Wikidata (in place). */
  enrich,
  /** The kind of place a text asks for ('Pharmacies' for "apotheke"), or null. */
  matchCategory: (t: string): string | null => { const c = matchCategory(t); return c ? c.label : null; },
  /** Where search() looks first: 'google' with a key (not in the Embed-only mode), else 'osm'. */
  source: GOOGLE_API ? 'google' : 'osm',
  /** A Google key is set: place cards can show Google's own card (Embed), even in the Embed-only mode. */
  embedAvailable: !!GOOGLE_KEY,
  /** The credit line to show with results. */
  attribution: GOOGLE_API ? 'Google Maps' : 'Places © OpenStreetMap contributors',
  /** Metres in words: '120 m', '1.4 km', '12 km'. */
  formatDistance,
};
