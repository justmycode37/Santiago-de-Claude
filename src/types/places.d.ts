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
  /** Google: how many people rated it. */
  ratingCount?: number;
  /** Its website, '' when none is known (Google, or OpenStreetMap after enrich()). */
  website?: string;
  /** A photo of it to show on its card, '' when there is none. */
  photo?: string;
  /** OpenStreetMap after enrich(): its opening hours as mapped ('Mo-Fr 08:00-18:00'). */
  hours?: string;
  /** OpenStreetMap after enrich(): how well known it is, the stand-in for a rating. */
  score?: number;
  /** Website, photo and score have been looked up (always for Google, after enrich() for OpenStreetMap). */
  details?: boolean;
}

interface PlaceSearchAnswer {
  /** The kind of place the text asked for ('Restaurants' for "restaurant near me"), or null for a name. */
  category: string | null;
  results: PlaceSearchResult[];
}


