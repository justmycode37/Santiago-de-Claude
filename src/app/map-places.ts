// ---------- Places: toilets, drinking water, health, help… (map-layers.ts, map-places.js) ----------
// Shown with the events button, for the groups switched on under "Events and places" in Settings.
// The data (~2.5 MB: Bern, and the toilets of all of Switzerland) is loaded the first time it is needed.
import { map } from './map.ts';
import { eventsOn } from './map-events.ts';
import { showToast } from '../toast.ts';
import { showDestinationJourney } from './trip-ends.ts';
import { platformPopup } from './platforms.ts';
import { mk } from './live-vehicles.ts';
import { journey, popup } from './state.ts';
import { SETTINGS } from '../settings.ts';
import { MAP_LAYERS } from '../map-layers.ts';
export const PLACES_FC: GeoJSON.FeatureCollection<GeoJSON.Point, PlaceDotProps> = { type: 'FeatureCollection', features: [] };
export let PLACES: MapPlaces | null = null;
let placesLoading: Promise<boolean> | null = null;
// Even density: about the same number of icons on screen at every zoom (~70 on a phone). Each icon keeps
// PLACE_SPACING px of room around it; where icons would crowd, the higher-ranked ones (map-layers.ts) are placed
// first and the rest appear as you zoom in. The room shrinks with zoom because icons grow (0.8× → 1×), and close
// in, where few places are left to add, it lets nearly all of them show.
export const PLACE_MIN_ZOOM = 12.5;
const PLACE_SPACING: maplibregl.ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 13, 16, 17, 8, 18.5, 3];
export const PLACE_LAYERS = ['places'];
export const GROUP_BY_KEY = Object.fromEntries(MAP_LAYERS.GROUPS.map((g) => [g.key, g]));
const BERN_BOX = [[7.34, 46.9], [7.5, 46.99]];

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

export function loadPlaces() {
  if (!placesLoading) placesLoading = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'map-places.js';
    s.async = true;
    s.onload = () => { indexPlaces(window.MAP_PLACES); resolve(true); };
    s.onerror = () => { placesLoading = null; s.remove(); showToast('Places could not be loaded.'); resolve(false); };
    document.head.appendChild(s);
  });
  return placesLoading;
}
function indexPlaces(data: MapPlaces | undefined) {
  if (!data) return;
  PLACES = data;
  delete window.MAP_PLACES;
  showPlacesIfNeeded();
}
// The places only go to the map (where building and indexing them keeps the page and a map worker busy) once
// they are to be shown; the search uses PLACES directly.
export let placesOnMap = false;
function showPlacesIfNeeded() {
  if (placesOnMap || !PLACES || !placeGroupsShown().length) return;
  placesOnMap = true;
  const order = Object.fromEntries(MAP_LAYERS.GROUPS.map((g, i) => [g.key, i]));
  PLACES_FC.features = PLACES.items.map(([lon, lat, ci, name], i) => {
    const [g, gl, rank] = PLACES!.cats[ci];
    // o: who gets the room where icons would overlap: higher rank, then earlier group, then named before unnamed
    const properties: PlaceDotProps = { i, g, gl, c: GROUP_BY_KEY[g].color, o: rank * 100 + order[g] * 2 + (name ? 0 : 1) };
    if (name) properties.n = name;
    return { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties };
  });
  const src = map.getSource('places') as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(PLACES_FC);
}

export function updatePlaces() {
  const groups = placeGroupsShown();
  if (groups.length && !PLACES) loadPlaces();
  showPlacesIfNeeded();
  for (const id of PLACE_LAYERS) {
    if (!map.getLayer(id)) continue;
    map.setLayoutProperty(id, 'visibility', groups.length ? 'visible' : 'none');
    map.setFilter(id, placeFilter(groups));
  }
  if (popup.place && !groups.includes(popup.place)) { popup.place = null; platformPopup.remove(); }
}

export const viewNearBern = () => {
  const b = map.getBounds();
  return b.getEast() > BERN_BOX[0][0] && b.getWest() < BERN_BOX[1][0] && b.getNorth() > BERN_BOX[0][1] && b.getSouth() < BERN_BOX[1][1];
};

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
  for (const id of PLACE_LAYERS) {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
}
