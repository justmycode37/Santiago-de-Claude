// What src/map-layers.ts puts on window: the groups of places the events button can show on the map.

/** A colour of the app's palette (CSS: var(--navy), …). */
type MapColorName = 'navy' | 'rose' | 'sun' | 'tang';
/** A palette colour for drawing on a canvas: the disc, the glyph on it, and the same as a CSS variable. */
interface MapColor { fill: string; ink: string; css: string }

/** A switch under "Events and places" in Settings; 'events' is the community events, the others are groups of places. */
type MapGroupKey = 'events' | 'toilets' | 'water' | 'health' | 'help' | 'food' | 'shops' | 'money' | 'rest' | 'access'
  | 'transit' | 'mobility' | 'kids' | 'learn' | 'sport' | 'culture' | 'stay' | 'faith' | 'recycling' | 'business';

interface MapGroup {
  key: MapGroupKey;
  /** The switch's name: 'Drinking water'. */
  label: string;
  color: MapColorName;
  /** A key of MAP_LAYERS.GLYPHS. */
  glyph: string;
  /** The small print under the switch's name. */
  note?: string;
}

/** 1 (hospitals, stations) to 5 (benches, bike racks): where icons would crowd, the lower ranks wait until you zoom in. */
type PlaceRank = 1 | 2 | 3 | 4 | 5;
/** How one kind of place is shown: its group, its glyph (a key of MAP_LAYERS.GLYPHS), its rank, and what it is called. */
type PlaceClass = [group: MapGroupKey, glyph: string, rank: PlaceRank, label: string];

interface MapLayersApi {
  COLORS: Record<MapColorName, MapColor>;
  /** Glyph name → SVG path data, stroked on a 24×24 grid. */
  GLYPHS: Record<string, string>;
  /** The switches under "Events and places", in the order they are listed. Earlier groups win where icons would overlap. */
  GROUPS: MapGroup[];
  /** Search word (German, French, everyday English: 'apotheke', 'wc') → the words of the labels it means ('pharmacy', 'toilet'). */
  SEARCH_ALIASES: Record<string, string>;
  /**
   * Sorts a data category into a map group.
   * @param category the category in data/*.json: 'pharmacy', 'drinking_water', 'cafe'
   * @param placeGroup the "group" of a record of places.json ('food_drink', 'shopping', …); left out for the other files
   */
  classify(category: string, placeGroup?: string): PlaceClass;
}

