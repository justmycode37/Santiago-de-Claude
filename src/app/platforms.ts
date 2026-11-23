// ---------- Platforms & stop edges ----------
// Exact position of every platform (Gleis) and bus/tram stop edge (Kante) in Switzerland, from the
// official ATLAS data (platforms.js, built by tools/build_platforms.py). Always drawn on the map from
// zoom 17, and used to put journey boarding/alighting points on the right platform.
import { map } from './map.ts';
import { userLngLat } from './location.ts';
import { pinTap } from './pins.ts';
import { PLACE_LAYERS, loadPlaces, openPlace } from './map-places.ts';
import { fmtTime } from './journey-steps.ts';
import { badge, levelShort, mk, nounOf } from './live-vehicles.ts';
import { kIcon } from './sheet.ts';
import { distKm } from './routing.ts';
import { popup, sheet } from './state.ts';
import { KANTE_BOARD } from '../engine-departures.ts';
import { KANTE } from '../engine.ts';
import { SETTINGS } from '../settings.ts';
import { WALK_PACE } from '../walk-pace.ts';
import { Station3D } from '../station3d.ts';
import type { StationRouteStopRef } from '../station-route.ts';
import type { Theme } from '../theme.ts';

// ---- Platforms and stop edges: the PLATFORMS index (src/app/platforms.ts, made from platforms.js) ----

/** How a stop is served, in words (platforms.js has it as a letter: PlatformModeCode). */
export type PlatformMode = 'train' | 'tram' | 'bus' | 'boat' | 'cable';
/** One platform or stop edge of a stop. */
export interface PlatformEdge {
  /** Its name as signed: "7", "H"; '' when it has none. */
  ref: string;
  /** The comparable form of the name (platformKey()): "7A-D" → "7", "Kante H" → "H"; '' when it has none. */
  key: string;
  /** The compass direction the vehicles that stop there travel in; null when the data does not say. */
  bearing: number | null;
  /** The floor when it is not at street level, else null. */
  level: number | null;
  ll: LngLat;
}
/** A stop of PLATFORMS (by UIC number, "8507000"): its name, how it is served, its edges (at least one). */
export interface PlatformStop { name: string; mode: PlatformMode; edges: PlatformEdge[] }
/** The properties of a dot on the map (source 'platforms'): the stop's UIC number, the edge's index and name. */
export interface PlatformDotProps { id: string; i: number; ref: string }
/** A dot as the map gives it back for a tap (queryRenderedFeatures). */
export type PlatformDotFeature = maplibregl.MapGeoJSONFeature & { properties: PlatformDotProps };
/** What openPlatform() reads of a tapped dot. i null: the stop as a whole (Scan knows the stop, not the edge). */
export interface PlatformTap { properties: { id: string; i: number | null } }

export const PLATFORM_FC: GeoJSON.FeatureCollection<GeoJSON.Point, PlatformDotProps> = { type: 'FeatureCollection', features: [] };
export const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
// The ~52,000 dots are only handed to the map the first time it comes near the zoom where they show:
// indexing them occupies a map worker, which would otherwise hold up the base map tiles.
export let platformsOnMap = false;
function showPlatformsIfNeeded() {
  if (platformsOnMap || !PLATFORM_FC.features.length || map.getZoom() < PLATFORM_MIN_ZOOM - 1.5) return;
  platformsOnMap = true;
  const src = map.getSource('platforms') as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(PLATFORM_FC);
}
export const PLATFORMS = new Map<string, PlatformStop>(); // station id (UIC) → { name, mode, edges: [{ ref, key, bearing, ll }] }
const PLATFORM_MODES: Record<PlatformModeCode, PlatformMode> = { t: 'train', m: 'tram', b: 'bus', s: 'boat', c: 'cable' };

// Comparable platform name: "7A-D" → "7", "Kante H" → "H", "K1" → "K1", "–" → ""
export function platformKey(p: string | number | null | undefined) {
  const s = String(p || '').toUpperCase().replace(/^(GLEIS|GL\.|KANTE|QUAI|VOIE|BINARIO|STEG|PERRON)\s*/, '').trim();
  const digits = /^\d+/.exec(s);
  return digits ? digits[0] : s.replace(/[^0-9A-Z]/g, '');
}

function indexPlatforms(data: PlatformData | undefined) {
  if (!data || !data.stops) return;
  const features: GeoJSON.Feature<GeoJSON.Point, PlatformDotProps>[] = [];
  for (const [id, [name, m, raw]] of Object.entries(data.stops)) {
    const mode = PLATFORM_MODES[m] || 'bus';
    const edges = raw.map(([x, y, ref = '', bearing = null, level = null]): PlatformEdge =>
      ({ ref: ref || '', key: platformKey(ref), bearing, level, ll: [x / 1e5, y / 1e5] }));
    PLATFORMS.set(id, { name, mode, edges });
    edges.forEach((e, i) => {
      features.push({ type: 'Feature', properties: { id, i, ref: e.ref }, geometry: { type: 'Point', coordinates: e.ll } });
    });
  }
  PLATFORM_FC.features = features;
  showPlatformsIfNeeded();
  delete window.PLATFORM_DATA;
}

// Loaded after the first map view (it is ~2 MB), as a script so it also works when index.html is opened
// as a file. startPlatforms() runs on the first map idle, when a journey needs it, or after 8 s at the latest.
export let startPlatforms!: () => void;
export const platformsReady = new Promise<void>((resolve) => {
  let started = false;
  startPlatforms = () => {
    if (started) return;
    started = true;
    const s = document.createElement('script');
    s.src = 'platforms.js';
    s.async = true;
    s.onload = () => {
      indexPlatforms(window.PLATFORM_DATA);
      resolve();
      // Then the places the search looks through (map-places.js), so the first search needn't wait for them
      setTimeout(loadPlaces, 1000);
    };
    s.onerror = () => resolve(); // journeys fall back to station positions
    document.head.appendChild(s);
  };
});

// Neutral white dots that only appear when zoomed in close (street level)
export const PLATFORM_MIN_ZOOM = 17;
const PLATFORM_TEXT_NUDGE = 0.135; // em down: the font sits high in its line box (measured)
export function platformLayers(theme: Theme): maplibregl.LayerSpecification[] {
  const labelled: maplibregl.ExpressionSpecification = ['!=', ['get', 'ref'], ''];
  const fadeIn: maplibregl.ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], PLATFORM_MIN_ZOOM, 0, PLATFORM_MIN_ZOOM + 0.4, 1];
  return [
    { id: 'platform-dot', type: 'circle', source: 'platforms', minzoom: PLATFORM_MIN_ZOOM,
      paint: {
        'circle-color': '#ffffff',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], PLATFORM_MIN_ZOOM, ['case', labelled, 7, 4], 19, ['case', labelled, 11, 6]],
        'circle-opacity': fadeIn,
      } },
    // Platform / edge name inside the dot ("7", "H"); in crowded stations some only appear when zooming in further
    { id: 'platform-ref', type: 'symbol', source: 'platforms', minzoom: PLATFORM_MIN_ZOOM, filter: labelled,
      layout: {
        'text-field': ['get', 'ref'],
        'text-font': ['Frutiger Neue Bold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], PLATFORM_MIN_ZOOM, 10, 19, 14],
        'text-offset': [0, PLATFORM_TEXT_NUDGE], // the font sits a little off-centre in its line box
        'text-padding': 0,
        'text-ignore-placement': true,
      },
      // a halo in the text colour makes the strokes heavier than the font's own bold
      paint: { 'text-color': '#1c1c1e', 'text-halo-color': '#1c1c1e', 'text-halo-width': 0.6, 'text-opacity': fadeIn } },
  ];
}

// Tap a platform: its name and the next departures from exactly that platform / edge (live)
export const platformPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'pf-pop', maxWidth: 'none', offset: 16 });
export async function openPlatform(f: PlatformTap) {
  popup.place = null;
  const st = PLATFORMS.get(String(f.properties.id));
  // i = null: the stop as a whole (e.g. recognised by Scan without knowing which edge), all its departures
  const whole = st && f.properties.i == null;
  const edge = whole
    ? { ref: '', level: null, ll: st.edges.reduce<LngLat>((s, e) => [s[0] + e.ll[0] / st.edges.length, s[1] + e.ll[1] / st.edges.length], [0, 0]) }
    : st && st.edges[f.properties.i!];
  if (!edge) return;
  const req = ++popup.req;
  const word = edge.ref ? nounOf(st!.mode) : 'Stop';
  const dot = mk('span', 'pf-dot', edge.ref);
  const name = mk('div', 'pf-name');
  const kind = (edge.ref ? `${word} ${edge.ref}` : word) + (edge.level ? ` · Level ${levelShort(edge.level)}` : '');
  name.append(mk('b', null, st!.name), mk('small', null, kind));
  const head = mk('div', 'pf-head');
  head.append(dot, name);
  const note = mk('p', 'pf-note', 'Loading departures…');
  const list = mk('ul', 'pf-list');
  const box = mk('div');
  box.append(head, note, list);
  // a station with a 3D model: show this platform in it, with the way there when you are nearby
  const key3d = Station3D && Station3D.has(f.properties.id);
  if (key3d) {
    const view3d = mk('button', 'pf-3d');
    view3d.type = 'button';
    view3d.append(kIcon('cube', 16), '3D view');
    view3d.addEventListener('click', (e) => {
      e.stopPropagation();
      const to: { ll: LngLat; stop?: StationRouteStopRef; level?: number } = { ll: edge.ll };
      if (edge.ref) to.stop = { uic: String(f.properties.id), ref: edge.ref };
      if (edge.level != null) to.level = edge.level;
      const near = userLngLat && distKm(userLngLat, edge.ll) < 0.8;
      sheet.s3Step = null;
      Station3D.open({ key: key3d, from: near ? { ll: userLngLat! } : undefined, to, prefs: SETTINGS.journey(), returnFocus: view3d });
    });
    box.append(view3d);
  }
  platformPopup.setLngLat(edge.ll).setDOMContent(box).addTo(map);
  // The Kante engine knows the edge of every departure (engine-departures.ts: d.edges)
  const load = async () => {
    note.textContent = 'Loading departures…';
    list.replaceChildren();
    box.querySelector('.pf-retry')?.remove();
    try {
      const all = await KANTE_BOARD!.load(f.properties.id, st!, f.properties.i);
      if (req !== popup.req) return;
      const here = whole ? all : all.filter((d) => d.edges.includes(f.properties.i!));
      note.textContent = !all.length ? 'No departures in the next hours.' : here.length ? '' : 'From other platforms:';
      list.replaceChildren(...(here.length ? here : all).slice(0, 6).map((d) => {
        const li = mk('li');
        li.append(mk('time', null, fmtTime(d.time)), badge(d.shown), mk('span', 'pf-to', d.headsign || d.towards || ''));
        if (d.late > 0) li.append(mk('span', 'j-delay', `+${d.late}′`));
        return li;
      }));
    } catch (e) {
      if (req !== popup.req) return;
      const why = engineFailure(e);
      note.textContent = why ? engineMessage(why, 'Departures') : 'Departures could not be loaded.';
      if (why !== 'off') {
        const again = mk('button', 'pf-3d pf-retry', 'Try again');
        again.type = 'button';
        again.addEventListener('click', (ev) => { ev.stopPropagation(); load(); });
        note.after(again);
      }
    }
    platformPopup.setLngLat(edge.ll); // re-fit now that the card is taller
  };
  load();
}
// Why a call to the Kante engine failed: off (the page has none), down (it cannot be reached), or null for anything else
export const engineFailure = (e: unknown): 'off' | 'down' | null => {
  const why = KANTE ? KANTE.failure(e) : 'off';
  return why === 'off' || why === 'down' ? why : null;
};
// What a journey or a board says instead, when the engine cannot answer. Journeys, departures and live data all come
// from it; the map, search, events and places do not need it.
export const engineMessage = (why: 'off' | 'down', what: string) => (why === 'off'
  ? `${what} come from the Kante engine, which is switched off for this page.`
  : `${what} come from the Kante engine, which isn't answering right now.`);

/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() {
  map.on('zoomend', showPlatformsIfNeeded);
  setTimeout(startPlatforms, 8000);
  // Forgiving tap: the nearest dot or place icon within ~16 px, so small dots are easy to hit on a phone
  map.on('click', (e) => {
    if (WALK_PACE.drawing()) return; // the taps draw a path (developer options)
    if (pinTap(e.lngLat.toArray())) return; // placing a pin, or closing the "From here / To here" menu
    const r = 16;
    const layers = ['platform-dot', ...PLACE_LAYERS].filter((id) => map.getLayer(id));
    const hits = layers.length
      ? map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers }) : [];
    if (!hits.length) { popup.req++; popup.place = null; platformPopup.remove(); return; }
    const dist = (f: maplibregl.MapGeoJSONFeature) => map.project((f.geometry as GeoJSON.Point).coordinates as LngLat).dist(e.point);
    const hit = hits.reduce((a, b) => (dist(b) < dist(a) ? b : a));
    if (hit.layer.id === 'platform-dot') openPlatform(hit as PlatformDotFeature);
    else openPlace(hit.properties.i);
  });
  map.on('mouseenter', 'platform-dot', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'platform-dot', () => { map.getCanvas().style.cursor = ''; });
}
