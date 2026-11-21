// The search and the two ends of the trip (src/app/20-search.ts … 24-pins.ts): the types those parts share with
// each other and with the rest of the page's script.

/** One of the trip's two fields: where it starts ('from') and where it goes ('to'). */
type TripField = 'from' | 'to';

/** A search that filled the list or put pins on the map: what was typed, and in which field. */
interface FieldSearch { field: TripField; text: string }

/** The round icon of a result: a glyph (the inside of a 24×24 <svg>) in white, or in `fg`, on a disc of `color`. */
interface SearchIcon { color: string; fg?: string; svg: string }

/**
 * Which icon a result gets (a key of KIND in 20-search.ts). 'place' is one of our own places (map-places.js): it
 * has no entry in KIND and brings its own `icon`.
 */
type SearchKind = PlaceKind | 'address' | 'city' | 'postcode' | 'water' | 'place';
/** The icons by kind. A kind without one gets the icon of 'other'. */
type SearchIcons = Partial<Record<SearchKind, SearchIcon>> & { other: SearchIcon };

/** The swisstopo SearchServer's sources of locations: addresses, names on the map, postcodes, municipalities. */
type SwisstopoOrigin = 'address' | 'gazetteer' | 'zipcode' | 'gg25';
/** Where a result comes from: swisstopo, a place (ours or one found online), or a pin put on the map by hand. */
type SearchOrigin = SwisstopoOrigin | 'place' | 'pin';

/**
 * One row of the results list, whichever source it is from (swisstopo, our own places, places online), and what a
 * pin dropped on the map is made into. Choosing one makes it an end of the trip.
 */
interface SearchResult {
  title: string;
  /** The grey line under the title: 'Municipality · Bern', 'Pharmacy · 120 m · Neuengasse 15'; '' for a pin. */
  subtitle: string;
  kind: SearchKind;
  origin: SearchOrigin;
  lngLat: LngLat;
  /** Places: metres from where the search measures from; null when an online place came without one. */
  distance?: number | null;
  /** Our own places: their icon (the others get the one of their `kind`). */
  icon?: SearchIcon;
  /** Places found online (places.ts): who knows them. */
  source?: 'osm' | 'google';
}

/** Anything that begins with a longitude and a latitude: a LngLat, or a row of map-places.js. */
type LngLatFirst = readonly [lng: number, lat: number, ...rest: unknown[]];

/** What our own places (map-places.js) have for a search text. */
interface PlaceMatches {
  /** The nearest places of the kind asked for ("pharmacy", "wc"). */
  kinds: SearchResult[];
  /** The places whose name matches ("Migros"). */
  names: SearchResult[];
  /** A toilet was asked for. */
  toilets: boolean;
}

/** One location of the swisstopo SearchServer (type=locations, sr=4326), with the attributes the page reads. */
interface SwisstopoLocationAttrs {
  /** The name as HTML: '<b>3011 - Bern</b>', '<i>Lake</i> <b>Thunersee</b> (BE) - Thun,Spiez'. */
  label?: string;
  origin: SwisstopoOrigin;
  lon: number;
  lat: number;
  /** Gazetteer entries: the swissNAMES3D class ('TLM_SIEDLUNGSNAME', 'TLM_GEWAESSER', …). */
  objectclass?: string;
}
interface SwisstopoSearchAnswer { results?: { attrs: SwisstopoLocationAttrs }[] }
