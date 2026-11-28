// ---------- Places: toilets, drinking water, health, help… (map-layers.ts, map-places/) ----------
// Shown with the events button, for the groups switched on under "Events and places" in Settings.
// The data covers all of Switzerland in tiles (map-places/index.json and one file per tile, tools/build-map-places.mts):
// the map loads the tiles around what it shows, the search those around where it measures from.
import { map } from './map.ts';
import { eventsOn } from './map-events.ts';
import { showToast } from '../toast.ts';
import { showDestinationJourney } from './trip-ends.ts';
import { platformPopup } from './platforms.ts';
import { mk } from './live-vehicles.ts';
import { journey, popup } from './state.ts';
import { SETTINGS } from '../settings.ts';
import { MAP_LAYERS } from '../map-layers.ts';
import type { MapColorName, MapGroupKey } from '../map-layers.ts';
import type { Theme } from '../theme.ts';

// ---- Places: toilets, drinking water, health, help… (src/app/map-places.ts, from map-places/) ----

/**
 * The properties of a place on the map (source 'places'): i: its index in PLACES.items (which never changes), g: its group, gl: its
 * glyph, c: the group's colour, o: who gets the room where icons would overlap (lower first), n: its name.
 */
export interface PlaceDotProps { i: number; g: MapGroupKey; gl: string; c: MapColorName; o: number; n?: string }

/** What the map's 'places' source has: the places of the tiles in and around the view, not every tile loaded. */
export const PLACES_FC: GeoJSON.FeatureCollection<GeoJSON.Point, PlaceDotProps> = { type: 'FeatureCollection', features: [] };
/**
 * The places loaded so far: the index's tables, and the rows of every tile loaded, appended as the tiles come in.
 * A row keeps its index for the page's life (PlaceDotProps.i, openPlace(i)). null until the index has come.
 */
export let PLACES: MapPlaces | null = null;
let TILES: MapPlaceTile[] = [];
let VERSION = '';
let indexLoading: Promise<boolean> | null = null;
/** Tile → where its rows are in PLACES.items: [first, end) */
const tileRows = new Map<string, [number, number]>();
const tileLoading = new Map<string, Promise<boolean>>();
/** Tile → its features for the map, made the first time it is shown */
const tileFeatures = new Map<string, GeoJSON.Feature<GeoJSON.Point, PlaceDotProps>[]>();
// Even density: about the same number of icons on screen at every zoom (~70 on a phone). Each icon keeps
// PLACE_SPACING px of room around it; where icons would crowd, the higher-ranked ones (map-layers.ts) are placed
// first and the rest appear as you zoom in. The room shrinks with zoom because icons grow (0.8× → 1×), and close
// in, where few places are left to add, it lets nearly all of them show.
export const PLACE_MIN_ZOOM = 12.5;
const PLACE_SPACING: maplibregl.ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 13, 16, 17, 8, 18.5, 3];
export const PLACE_LAYERS = ['places'];
export const GROUP_BY_KEY = Object.fromEntries(MAP_LAYERS.GROUPS.map((g) => [g.key, g]));
const GROUP_ORDER = Object.fromEntries(MAP_LAYERS.GROUPS.map((g, i) => [g.key, i]));

// Place groups to draw now (none while the events button is off or a journey is on)
const placeGroupsShown = (): MapGroupKey[] => (eventsOn && !journey.dest ? SETTINGS.mapGroups().filter((k) => k !== 'events') : []);
// not the 'sign' icons (platform sector signs, station furniture): they would bury the app's own platform dots
const placeFilter = (groups: MapGroupKey[]): maplibregl.FilterSpecification => ['all', ['in', ['get', 'g'], ['literal', groups]], ['!=', ['get', 'gl'], 'sign']];

export function placeLayers(theme: Theme): maplibregl.LayerSpecification[] {
  const dark = theme === 'dark';
  const groups = placeGroupsShown();
  return [{
    id: 'places', type: 'symbol', source: 'places', minzoom: PLACE_MIN_ZOOM, filter: placeFilter(groups),
    layout: {
      visibility: groups.length ? 'visible' : 'none',
      'icon-image': ['concat', 'pl|', ['get', 'gl'], '|', ['get', 'c'], '|' + theme],
      'icon-size': ['interpolate', ['linear'], ['zoom'], PLACE_MIN_ZOOM, .8, 17, 1],
      'icon-padding': PLACE_SPACING,
      'symbol-sort-key': ['get', 'o'],
      // names once you are close in, under the icon, dropped where there is no room
      'text-field': ['step', ['zoom'], '', 18, ['coalesce', ['get', 'n'], '']],
      'text-font': ['Frutiger Neue Regular'],
      'text-size': 12,
      'text-anchor': 'top',
      'text-offset': [0, 1.15],
      'text-max-width': 9,
      'text-optional': true,
    },
    paint: {
      'icon-opacity': ['interpolate', ['linear'], ['zoom'], PLACE_MIN_ZOOM, 0, PLACE_MIN_ZOOM + .4, 1],
      'text-color': dark ? '#E5E5EA' : '#1C1C1E',
      'text-halo-color': dark ? '#1C1C1E' : '#FFFFFF',
      'text-halo-width': 1.4,
    },
  }];
}

/** [west, south, east, north] */
type Box = [number, number, number, number];
const boxAround = (ll: LngLat, km: number): Box => {
  const dLat = km / 111, dLng = km / (111 * Math.cos(ll[1] * Math.PI / 180));
  return [ll[0] - dLng, ll[1] - dLat, ll[0] + dLng, ll[1] + dLat];
};

function loadIndex(): Promise<boolean> {
  // no-cache: asked again (an unchanged file is not downloaded again), so the index and the tiles are of one build
  indexLoading ||= fetch('map-places/index.json', { cache: 'no-cache' }).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<MapPlacesIndex>;
  }).then((index) => {
    PLACES = { generated: index.generated, sources: index.sources, cats: index.cats, items: [] };
    TILES = index.tiles;
    VERSION = index.version;
    return true;
  }, () => {
    indexLoading = null; // tried again on the next call
    showToast('Places could not be loaded.');
    return false;
  });
  return indexLoading;
}
let failedToast = 0;
function loadTile(key: string): Promise<boolean> {
  if (tileRows.has(key)) return Promise.resolve(true);
  let loading = tileLoading.get(key);
  if (!loading) {
    loading = fetch(`map-places/${key}.json`, { cache: 'no-cache' }).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<MapPlaceTileFile>;
    }).then((file) => {
      // a tile of a newer build than the index (the site was updated meanwhile) has other categories
      if (file.v !== VERSION) { showToast('Places have been updated: reload the page to see them.'); return false; }
      const items = PLACES!.items, first = items.length;
      for (const r of file.rows) items.push(r);
      tileRows.set(key, [first, items.length]);
      return true;
    }, () => {
      if (Date.now() - failedToast > 30000) { failedToast = Date.now(); showToast('Some places could not be loaded.'); }
      return false;
    }).finally(() => tileLoading.delete(key));
    tileLoading.set(key, loading);
  }
  return loading;
}
/** Loads the tiles that touch the box; → their keys (also of those that could not be loaded) */
async function loadBox(box: Box): Promise<string[]> {
  if (!await loadIndex()) return [];
  const keys = TILES.filter((t) => t[1] < box[2] && t[3] > box[0] && t[2] < box[3] && t[4] > box[1]).map((t) => t[0]);
  await Promise.all(keys.map(loadTile));
  return keys;
}

/** Loads the places within about km of a point (for the search); true once they are there. */
export async function ensurePlacesNear(ll: LngLat, km: number): Promise<boolean> {
  await loadBox(boxAround(ll, km));
  return !!PLACES;
}
/**
 * Loads the places in the part of the map in view (at most 15 km from its middle) and within 10 km of its middle:
 * for the categories, and ahead of the first search. `area` ([west, south, east, north]): "Search this area" asks for
 * all of what is in view, up to 30 km from its middle (a whole canton would be tens of megabytes).
 */
export async function loadPlaces(area?: Box): Promise<boolean> {
  const c = map.getCenter().toArray() as LngLat, near = boxAround(c, area ? 30 : 15), b = map.getBounds();
  const a: Box = area || [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const view: Box = [Math.max(a[0], near[0]), Math.max(a[1], near[1]), Math.min(a[2], near[2]), Math.min(a[3], near[3])];
  await Promise.all([loadBox(view), loadBox(boxAround(c, 10))]);
  return !!PLACES;
}

function featuresOf(key: string) {
  let features = tileFeatures.get(key);
  if (features) return features;
  const [first, end] = tileRows.get(key)!;
  features = [];
  for (let i = first; i < end; i++) {
    const [lon, lat, ci, name] = PLACES!.items[i];
    const [g, gl, rank] = PLACES!.cats[ci];
    // o: who gets the room where icons would overlap: higher rank, then earlier group, then named before unnamed
    const properties: PlaceDotProps = { i, g, gl, c: GROUP_BY_KEY[g].color, o: rank * 100 + GROUP_ORDER[g] * 2 + (name ? 0 : 1) };
    if (name) properties.n = name;
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties });
  }
  tileFeatures.set(key, features);
  return features;
}
// The places only go to the map (where building and indexing them keeps the page and a map worker busy) once
// they are to be shown, and only those of the tiles in and around the view: once the map has settled, its tiles are
// loaded and the source gets them in one go (a view the map has left before its tiles came is not drawn).
export let placesOnMap = false;
let viewReq = 0, shownTiles = '';
async function showPlacesIfNeeded() {
  const id = ++viewReq; // (also when nothing is to be shown: a load still on its way is dropped)
  if (!placeGroupsShown().length || map.getZoom() < PLACE_MIN_ZOOM - .5) return;
  const b = map.getBounds(), w = b.getEast() - b.getWest(), h = b.getNorth() - b.getSouth();
  const keys = await loadBox([b.getWest() - w / 4, b.getSouth() - h / 4, b.getEast() + w / 4, b.getNorth() + h / 4]);
  if (id !== viewReq || !placeGroupsShown().length) return; // the map has moved on, or places were switched off, meanwhile
  const shown = keys.filter((k) => tileRows.has(k));
  const src = map.getSource('places') as maplibregl.GeoJSONSource | undefined;
  if (shown.join() === shownTiles && src) return;
  PLACES_FC.features = shown.flatMap(featuresOf);
  placesOnMap = true;
  // remembered only once the map has them: a style being rebuilt now (theme, satellite) takes PLACES_FC with it, and
  // the next settle sets them again rather than taking the view as shown
  shownTiles = src ? shown.join() : '';
  if (src) src.setData(PLACES_FC);
}

export function updatePlaces() {
  const groups = placeGroupsShown();
  showPlacesIfNeeded();
  for (const id of PLACE_LAYERS) {
    if (!map.getLayer(id)) continue;
    map.setLayoutProperty(id, 'visibility', groups.length ? 'visible' : 'none');
    map.setFilter(id, placeFilter(groups));
  }
  if (popup.place && !groups.includes(popup.place)) { popup.place = null; platformPopup.remove(); }
}

const WHEELCHAIR = { yes: 'Wheelchair accessible', limited: 'Partly wheelchair accessible', no: 'Not wheelchair accessible' };
const ACCESS = { customers: 'Customers only', private: 'Private', permit: 'Permit needed', key: 'Key needed', permissive: 'Open to the public',
  wheelchair: 'Wheelchair users only', unsure: 'May be closed or locked' };
export function openPlace(i: number) {
  const row = PLACES && PLACES.items[i];
  if (!row) return;
  popup.req++;
  const [lon, lat, ci, name, x = {}] = row;
  const [g, glyph, , label] = PLACES!.cats[ci];
  const group = GROUP_BY_KEY[g];
  popup.place = g;

  const dot = mk('span', 'pl-dot');
  dot.style.setProperty('--c', `var(--${group.color})`);
  if (group.color === 'sun') dot.style.setProperty('--f', '#344D77');
  dot.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${MAP_LAYERS.GLYPHS[glyph]}"/></svg>`;
  const title = mk('div', 'pf-name');
  title.append(mk('b', null, name || label));
  if (name) title.append(mk('small', null, label)); // unnamed: the group would only repeat the kind ("Public toilet" / "Toilets")
  const head = mk('div', 'pf-head');
  head.append(dot, title);
  const body = mk('div', 'pl-body');
  body.append(head);

  const tags = [];
  if (x.f === 'no') tags.push('Free');
  if (x.f === 'yes') tags.push(x.pr ? 'Fee ' + x.pr : 'Fee');
  if (x.f === 'mixed') tags.push('Partly free'); // a free and a paying toilet, by cabin or by time of day
  // w: getting to the place, tw: the toilet itself. Station toilets only say the second.
  // (a toilet that is all that is known about the place says so once, not as "Wheelchair accessible" too)
  if (x.w || (x.tw && x.tw !== 'yes')) tags.push(WHEELCHAIR[x.w || x.tw!]);
  if (x.tw === 'yes') tags.push('Wheelchair toilet');
  if (x.tw === 'no' && x.w && x.w !== 'no') tags.push('No wheelchair toilet');
  if (x.e) tags.push('Eurokey');
  if (x.c) tags.push('Baby changing');
  if (x.k && ACCESS[x.k]) tags.push(ACCESS[x.k]);
  if (tags.length) {
    const t = mk('div', 'pl-tags');
    t.append(...tags.map((s) => mk('span', null, s)));
    body.append(t);
  }

  const rows = mk('ul', 'pl-rows');
  const addRow = (what: string, content: Node) => {
    const li = mk('li');
    li.append(mk('small', null, what), content);
    rows.append(li);
  };
  const link = (href: string, text: string) => {
    const a = mk('a', null, text);
    a.href = href;
    if (/^https?:/.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    return a;
  };
  if (x.a) addRow('Address', document.createTextNode(x.a));
  if (x.h) addRow(x.h === '24/7' ? 'Open' : 'Opening hours', document.createTextNode(x.h === '24/7' ? 'Day and night' : x.h));
  if (x.ft || (x.f === 'mixed' && x.pr)) addRow('Fee', document.createTextNode(x.ft || `${x.pr} for some of the toilets`));
  if (x.l) addRow('Floor', document.createTextNode(x.l));
  if (x.d) addRow('About', document.createTextNode(x.d));
  if (x.o) addRow('Run by', document.createTextNode(x.o));
  if (x.p) addRow('Phone', link('tel:' + x.p.replace(/[^\d+]/g, ''), x.p));
  if (x.u) {
    let host = x.u;
    try { host = new URL(x.u).hostname.replace(/^www\./, ''); } catch { /* show it as it is */ }
    addRow('Website', link(x.u, host));
  }
  if (rows.children.length) body.append(rows);

  const go = mk('button', 'pl-go', 'Directions');
  go.type = 'button';
  go.addEventListener('click', () => {
    popup.place = null;
    platformPopup.remove();
    showDestinationJourney({ title: name || label, lngLat: [lon, lat] });
  });
  body.append(go, mk('p', 'pl-src', 'Source: ' + PLACES!.sources[x.s || 0]));
  platformPopup.setLngLat([lon, lat]).setDOMContent(body).addTo(map);
}

export function bearingDeg(a: LngLat, b: LngLat) {
  const toRad = Math.PI / 180;
  const dLng = (b[0] - a[0]) * toRad;
  const y = Math.sin(dLng) * Math.cos(b[1] * toRad);
  const x = Math.cos(a[1] * toRad) * Math.sin(b[1] * toRad) - Math.sin(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.cos(dLng);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() {
  map.on('moveend', () => { showPlacesIfNeeded(); });
  // a style rebuilt (theme, satellite) while tiles came in: they go onto the new source once it is there
  map.on('styledata', () => { if (placesOnMap && !shownTiles && map.getSource('places')) showPlacesIfNeeded(); });
  for (const id of PLACE_LAYERS) {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
}
