// What src/places.ts puts on window: the search for places with a name (OpenStreetMap through Photon, or Google Places).

/** Which icon a place gets in the list and on the map. */
type PlaceKind = 'food' | 'cafe' | 'bar' | 'shop' | 'health' | 'money' | 'toilet' | 'drink' | 'sport' | 'bed'
  | 'building' | 'mountain' | 'nature' | 'station' | 'other';

/** West, south, east, north. */
type PlaceBbox = [west: number, south: number, east: number, north: number];

interface PlaceSearchOptions {
  /** Where to search: the middle of the map. Without it nothing is found. */
  center?: LngLat;
  /** Where distances are measured from (you). Left out: results carry no distance. */
  origin?: LngLat | null;
  /** How far around `center` nearby places are looked for at first (1.5 when left out). */
  radiusKm?: number;
  /** Only places inside it ("Search this area"). */
  bbox?: PlaceBbox | null;
}

interface PlaceSearchResult {
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
  /** Google: stars, 1 to 5. */
  rating?: number | null;
  /** Google: open at this moment. */
  openNow?: boolean | null;
}

interface PlaceSearchAnswer {
  /** The kind of place the text asked for ('Restaurants' for "restaurant near me"), or null for a name. */
  category: string | null;
  results: PlaceSearchResult[];
}

interface PlaceSearchApi {
  /** Places for what was typed: the nearest of a kind for a category word, else places with that name. */
  search(text: string, options?: PlaceSearchOptions): Promise<PlaceSearchAnswer>;
  /** What stands at a point ('Kramgasse 12', 'Near Bärenpark'), or null when nothing is known there. */
  reverse(lngLat: LngLat): Promise<{ title: string } | null>;
  /** The kind of place a text asks for ('Pharmacies' for "apotheke"), or null. */
  matchCategory(text: string): string | null;
  source: 'osm' | 'google';
  /** The credit line to show with results. */
  attribution: string;
  /** Metres in words: '120 m', '1.4 km', '12 km'. */
  formatDistance(m: number): string;
}

declare var PlaceSearch: PlaceSearchApi;
