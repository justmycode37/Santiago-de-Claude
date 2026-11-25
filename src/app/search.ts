// ---------- Search (swisstopo SearchServer) ----------
import * as maplibregl from 'maplibre-gl';
import type { PlaceKind } from '../places.ts';

/** One of the trip's two fields: where it starts ('from') and where it goes ('to'). */
export type TripField = 'from' | 'to';
/** A search that filled the list or put pins on the map: what was typed, and in which field. */
export interface FieldSearch { field: TripField; text: string }
/** The round icon of a result: a glyph (the inside of a 24×24 <svg>) in white, or in `fg`, on a disc of `color`. */
export interface SearchIcon { color: string; fg?: string; svg: string }
/**
 * Which icon a result gets (a key of KIND in search.ts). 'place' is one of our own places (map-places.js): it
 * has no entry in KIND and brings its own `icon`.
 */
export type SearchKind = PlaceKind | 'address' | 'city' | 'postcode' | 'water' | 'place';
/** The icons by kind. A kind without one gets the icon of 'other'. */
export type SearchIcons = Partial<Record<SearchKind, SearchIcon>> & { other: SearchIcon };
/** The swisstopo SearchServer's sources of locations: addresses, names on the map, postcodes, municipalities. */
export type SwisstopoOrigin = 'address' | 'gazetteer' | 'zipcode' | 'gg25';
/** Where a result comes from: swisstopo, the Kante engine's search, a place (ours or one found online), or a pin put on the map by hand. */
export type SearchOrigin = SwisstopoOrigin | 'kante' | 'place' | 'pin';
/**
 * One row of the results list, whichever source it is from (swisstopo, our own places, places online), and what a
 * pin dropped on the map is made into. Choosing one makes it an end of the trip.
 */
export interface SearchResult {
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
  /** The Kante engine's id ('st:…' a station, 'poi:…', 'addr:…'): a station is planned to as the station. */
  kanteId?: string;
  /** A photo of the place (or, with photoIsLogo, its brand's logo), shown beside its row. */
  photo?: string;
  photoIsLogo?: boolean;
  /** The engine's places: what OpenStreetMap knows about them (cuisine, hours, website, Wikidata). */
  info?: KantePoiInfo;
}
/** A place, which "Show on the map" puts on the map: ours, one found online, or one of the engine's (not a town, a
 *  mountain or a lake, which are where places are rather than places to go to). */
export const isPlaceResult = (r: SearchResult) => r.origin === 'place'
  || (r.origin === 'kante' && !!r.kanteId && r.kanteId.startsWith('poi:') && !['city', 'mountain', 'water', 'nature'].includes(r.kind));
/** Anything that begins with a longitude and a latitude: a LngLat, or a row of map-places.js. */
export type LngLatFirst = readonly [lng: number, lat: number, ...rest: unknown[]];
/** What our own places (map-places.js) have for a search text. */
export interface PlaceMatches {
  /** The nearest places of the kind asked for ("pharmacy", "wc"). */
  kinds: SearchResult[];
  /** The places whose name matches ("Migros"). */
  names: SearchResult[];
  /** A toilet was asked for. */
  toilets: boolean;
}
/** One location of the swisstopo SearchServer (type=locations, sr=4326), with the attributes the page reads. */
export interface SwisstopoLocationAttrs {
  /** The name as HTML: '<b>3011 - Bern</b>', '<i>Lake</i> <b>Thunersee</b> (BE) - Thun,Spiez'. */
  label?: string;
  origin: SwisstopoOrigin;
  lon: number;
  lat: number;
  /** Gazetteer entries: the swissNAMES3D class ('TLM_SIEDLUNGSNAME', 'TLM_GEWAESSER', …). */
  objectclass?: string;
}
export interface SwisstopoSearchAnswer { results?: { attrs: SwisstopoLocationAttrs }[] }

export const wrap = document.getElementById('searchWrap')!;
export const form = document.getElementById('searchForm') as HTMLFormElement;
// Two fields share one search and one results list: where the trip starts (empty = where you are) and where it goes
export const FIELDS: TripField[] = ['from', 'to'];
export const inputs = { from: document.getElementById('qFrom') as HTMLInputElement, to: document.getElementById('q') as HTMLInputElement };
export const clears = { from: form.querySelector<HTMLButtonElement>('[data-clear="from"]')!, to: form.querySelector<HTMLButtonElement>('[data-clear="to"]')! };
export const toks = { from: form.querySelector<HTMLButtonElement>('[data-pin="from"]')!, to: form.querySelector<HTMLButtonElement>('[data-pin="to"]')! };
export const list = document.getElementById('results')!;
export const PIN_ART = (kind: TripField) => `<svg class="pin-art ${kind}" viewBox="-2 -2 30 38" aria-hidden="true"><path d="M13 34C10 25 0 20 0 13A13 13 0 0 1 26 13C26 20 16 25 13 34Z"/><circle cx="13" cy="13" r="5"/></svg>`;
// Start and destination on the map. Both can be dragged; the tip sits 2 px above the bottom of the box (room for the outline).
const tripPin = (kind: TripField) => {
  const el = document.createElement('div');
  el.className = 'trip-pin';
  el.innerHTML = PIN_ART(kind);
  return new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, 2], draggable: true });
};
export const destMarker = tripPin('to');
export const startMarker = tripPin('from');

const ZOOM_BY_ORIGIN = { address: 17, gazetteer: 15, zipcode: 13, gg25: 13 };
// Result kinds → icon + colour (Apple Maps style: white glyph on a coloured circle)
export const KIND: SearchIcons = {
  address:  { color: 'var(--tang)', svg: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>' },
  city:     { color: 'var(--navy)', svg: '<path d="M3 21h18M5 21V11l5-3v13M10 21V5l9 4v12M14 10h2M14 14h2M14 18h2"/>' },
  postcode: { color: 'var(--navy)', svg: '<path d="M4 6h16v12H4zM4 7l8 6 8-6"/>' },
  mountain: { color: 'var(--rose)', svg: '<path d="M2.5 19.5l6.5-12 4 7 2.5-3.5 6 8.5z"/>' },
  water:    { color: 'var(--navy)', svg: '<path d="M3 9.5c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 15.5c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/>' },
  building: { color: 'var(--rose)', svg: '<path d="M5 21V4h14v17M3 21h18M9 8h2M13 8h2M9 12h2M13 12h2M10 21v-4h4v4"/>' },
  station:  { color: 'var(--navy)', svg: '<path d="M7 3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM4 10h16M8 17l-2 4M16 17l2 4"/>' },
  nature:   { color: 'var(--sun)', fg: '#344D77', svg: '<path d="M12 3l6 8.5h-3.5L19 17H5l4.5-5.5H6zM12 17v4"/>' },
  // Places (places.ts)
  food:     { color: 'var(--tang)', svg: '<path d="M7 3v7a2 2 0 0 0 2 2v9M11 3v7a2 2 0 0 1-2 2M9 3v5M17 21V3c-2 1-3 4-3 8h3"/>' },
  cafe:     { color: 'var(--tang)', svg: '<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5zM16 10h1.5a2.5 2.5 0 0 1 0 5H16M8 3c0 1.5 1 1.5 1 3M12 3c0 1.5 1 1.5 1 3"/>' },
  bar:      { color: 'var(--rose)', svg: '<path d="M5 4h14l-7 8zM12 12v8M8 20h8"/>' },
  shop:     { color: 'var(--sun)', fg: '#344D77', svg: '<path d="M5 8h14l-1 13H6zM9 8V6a3 3 0 0 1 6 0v2"/>' },
  health:   { color: 'var(--rose)', svg: '<path d="M9.5 4h5v5.5H20v5h-5.5V20h-5v-5.5H4v-5h5.5z"/>' },
  money:    { color: 'var(--navy)', svg: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6.5 9.5v5M17.5 9.5v5"/>' },
  toilet:   { color: 'var(--navy)', svg: '<circle cx="7.5" cy="5" r="1.6"/><circle cx="16.5" cy="5" r="1.6"/><path d="M5.5 21v-6H4.5l1.5-6h3l1.5 6h-1v6M14.5 21V9h4v12M12 3v18"/>' },
  drink:    { color: 'var(--navy)', svg: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>' },
  bed:      { color: 'var(--navy)', svg: '<path d="M3 19V6M3 15h18v4M21 15v-3a3 3 0 0 0-3-3h-7v6"/><circle cx="7" cy="11" r="2"/>' },
  sport:    { color: 'var(--navy)', svg: '<path d="M6.5 7v10M17.5 7v10M3.5 10v4M20.5 10v4M6.5 12h11"/>' },
  other:   { color: 'var(--navy)', svg: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>' },
};
const CANTONS: Record<string, string> = { AG: 'Aargau', AI: 'Appenzell I.Rh.', AR: 'Appenzell A.Rh.', BE: 'Bern', BL: 'Basel-Landschaft', BS: 'Basel-Stadt',
  FR: 'Fribourg', GE: 'Geneva', GL: 'Glarus', GR: 'Graubünden', JU: 'Jura', LU: 'Lucerne', NE: 'Neuchâtel', NW: 'Nidwalden',
  OW: 'Obwalden', SG: 'St. Gallen', SH: 'Schaffhausen', SO: 'Solothurn', SZ: 'Schwyz', TG: 'Thurgau', TI: 'Ticino', UR: 'Uri',
  VD: 'Vaud', VS: 'Valais', ZG: 'Zug', ZH: 'Zurich' };
const cantonName = (c: string) => CANTONS[c] || c || '';

function gazetteerKind(type: string, oc: string): [kind: SearchKind, label: string] {
  const t = type.toLowerCase();
  if (/local name|field name/.test(t)) return ['nature', 'Area'];
  if (/SIEDLUNG/.test(oc) || /populated|settlement|place|quarter|district/.test(t)) return ['city', 'Place'];
  if (/GEWAESSER/.test(oc) || /lake|pond|reservoir/.test(t)) return ['water', /river|stream|brook/.test(t) ? 'River' : 'Lake'];
  if (/river|stream|brook|waterfall/.test(t)) return ['water', type];
  if (/peak|summit|mountain|hill|pass|viewpoint|ridge|rock|glacier/.test(t)) return ['mountain', type];
  if (/\bstation\b|\bstop\b/.test(t)) return ['station', type];
  if (/forest|wood|park|meadow|nature/.test(t)) return ['nature', type];
  if (/GEBAEUDE/.test(oc) || /building/.test(t)) return ['building', 'Building'];
  return ['other', type];
}

// swisstopo labels → a short main name + a grey detail line
export function parseResult(attrs: SwisstopoLocationAttrs): Pick<SearchResult, 'title' | 'subtitle' | 'kind'> {
  const label = attrs.label || '';
  const bold = stripTags((label.match(/<b>(.*?)<\/b>/i) || [])[1] || '');
  const italic = stripTags((label.match(/<i>(.*?)<\/i>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const canton = ((label.match(/\(([A-Z]{2})\)/) || [])[1]) || '';
  switch (attrs.origin) {
    case 'address': {
      const street = stripTags(label.replace(/<b>.*?<\/b>/i, '')).replace(/\s*#\s*$/, '');
      return { title: street || bold, subtitle: bold, kind: 'address' };
    }
    case 'gg25':
      return { title: bold.replace(/\s*\([A-Z]{2}\)\s*$/, ''), subtitle: ['Municipality', cantonName(canton)].filter(Boolean).join(' · '), kind: 'city' };
    case 'zipcode': {
      const [, zip, name] = bold.match(/^(\d{4})\s*-\s*(.+)$/) || [null, '', bold];
      return { title: name, subtitle: `Postcode ${zip}`.trim(), kind: 'postcode' };
    }
    default: { // gazetteer: "<i>Type</i> <b>Name</b> (BE) - Municipality,Municipality,…"
      const munis = (stripTags(label).split(' - ')[1] || '').split(',').map((x) => x.trim()).filter(Boolean);
      const [kind, typeLabel] = gazetteerKind(italic, attrs.objectclass || '');
      let where = munis[0] && munis[0] !== bold ? munis[0] + (munis.length > 1 ? ` +${munis.length - 1}` : '') : '';
      where = [...new Set([where, cantonName(canton)])].filter(Boolean).join(', '); // not "Bern, Bern"
      return { title: bold, subtitle: [typeLabel, where].filter(Boolean).join(' · '), kind };
    }
  }
}

export const COLLAPSED_COUNT = 3;

const stripTags = (s: string) => s.replace(/<[^>]*>/g, '').trim();
