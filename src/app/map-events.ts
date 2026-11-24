// ---------- Community events ----------
// Which events show is set on the Settings page (settings.ts). Language courses and other events for newcomers only
// show for those who said they are new to Switzerland; anyone can still pick them as a category in the search.
import { map } from './map.ts';
import { SATELLITE_STYLE_URL, STYLES, STYLE_URL, makeDarkStyle } from '../map-style.ts';
import { currentTheme, onThemeChange, root, setTheme, themeMeta } from '../theme.ts';
import { eventsBtn, viewOptions, viewsBtn } from './menu.ts';
import { showToast } from '../toast.ts';
import { CATEGORY_CARDS } from './categories.ts';
import { EMPTY_FC, PLATFORM_FC, PLATFORM_MIN_ZOOM, platformLayers, platformsOnMap, startPlatforms } from './platforms.ts';
import { PLACES_FC, placeLayers, placesOnMap, updatePlaces } from './map-places.ts';
import { ROUTE_FC, routeLayers } from './journey-map.ts';
import { VEH_FC, vehLayers } from './live-vehicles.ts';
import { openEvent } from './event-page.ts';
import type { SearchCategory } from './categories.ts';
import { journey, popup, searchState } from './state.ts';
import { SETTINGS } from '../settings.ts';
import { EVENTS } from '../events.ts';
import type { EventFeature, EventProperties } from '../events.ts';
const NEWCOMER_TAGS = ['newcomers', 'language'];
export function visibleEvents() {
  const preferences = SETTINGS.eventTags();
  const newcomer = SETTINGS.prefs().newcomer;
  return EVENTS.features.filter((event) => EVENTS.matches(event, preferences)
    && (newcomer || !event.properties.tags.some((tag) => NEWCOMER_TAGS.includes(tag))));
}

export const EVENT_MIN_ZOOM = 12.5;
// Cards on the map, by venue + events shown. Cards that stay on screen after a move are kept as they are
// (no rebuild, no reloaded photo, no pop-in animation); only cards that change are added or removed.
export const eventMarkers = new Map<string, maplibregl.Marker>();
/** A place with events, where its card goes on the screen. */
interface EventVenue { point: maplibregl.Point; coordinates: LngLat; features: EventFeature[] }
export let eventsOn = false;

function clearCards() {
  for (const marker of eventMarkers.values()) marker.remove();
  eventMarkers.clear();
}

export function updateCards() {
  // during a journey the map shows only the trip and the destination
  const categoryEvents = searchState.category && searchState.category.events;
  if (searchState.category && !categoryEvents) { clearCards(); return; } // a kind of place: only its cards
  if (!(eventsOn || categoryEvents) || journey.dest || (!categoryEvents && !SETTINGS.mapGroups().includes('events'))
    || map.getZoom() < EVENT_MIN_ZOOM) { clearCards(); return; }

  const { clientWidth, clientHeight } = map.getContainer();
  const venues = new Map<string, EventVenue>();
  const features = categoryEvents ? EVENTS.features.filter((f) => EVENTS.matches(f, []) && categoryEvents(f.properties)) : visibleEvents();
  for (const feature of features) {
    const coordinates = feature.geometry.coordinates;
    const key = coordinates.join(',');
    let venue = venues.get(key);
    if (!venue) {
      const point = map.project(coordinates);
      // the card's middle on screen (no half-cards at the sides); a card above an off-screen point still shows
      if (point.x < 0 || point.x > clientWidth || point.y < 0 || point.y > clientHeight + 186) continue;
      venue = { point, coordinates, features: [] };
      venues.set(key, venue);
    }
    venue.features.push(feature);
  }

  // Give local support programmes first pick of the available map space.
  const supportTags = ['newcomers', 'language', 'free-food', 'blind-low-vision', 'deaf', 'wheelchair', 'adaptive-sport'];
  function compareEvents(a: EventFeature, b: EventFeature) {
    const first = a.properties;
    const second = b.properties;
    const support = (event: EventProperties) => event.tags.some(tag => supportTags.includes(tag));
    const deadline = (event: EventProperties) => event.through ? Date.parse(event.through) : Infinity;
    return Number(support(second)) - Number(support(first))
      || Number(Boolean(first.areaOnly)) - Number(Boolean(second.areaOnly))
      || deadline(first) - deadline(second)
      || first.id.localeCompare(second.id);
  }
  const candidates = Array.from(venues.values());
  for (const venue of candidates) venue.features.sort(compareEvents);
  candidates.sort((a, b) => compareEvents(a.features[0], b.features[0]));

  const shown: EventVenue[] = [];
  for (const venue of candidates) {
    const overlap = shown.find(other => Math.abs(other.point.x - venue.point.x) < 158
      && Math.abs(other.point.y - venue.point.y) < 202);
    if (!overlap) { if (!categoryEvents || shown.length < CATEGORY_CARDS) shown.push(venue); }
    // At maximum zoom, keep even adjacent doors accessible from the event details.
    else if (map.getZoom() >= map.getMaxZoom() - 0.01) overlap.features.push(...venue.features);
  }
  const next = new Map<string, maplibregl.Marker>();
  for (const venue of shown) {
    const key = venue.coordinates.join(',') + '|' + venue.features.map((f) => f.properties.id).join(',');
    let marker = eventMarkers.get(key);
    if (marker) eventMarkers.delete(key);
    else marker = new maplibregl.Marker({ element: makeVenueCard(venue.features), anchor: 'bottom' })
      .setLngLat(venue.coordinates).addTo(map);
    next.set(key, marker);
  }
  clearCards(); // the cards no longer shown
  for (const [key, marker] of next) eventMarkers.set(key, marker);
}

function makeVenueCard(features: EventFeature[]) {
  const event = features[0].properties;
  const card = document.createElement('div');
  card.className = 'ev-card';
  const inner = document.createElement('div');
  inner.className = 'ev-inner';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ev-body';
  const photo = document.createElement('img');
  photo.loading = 'lazy';
  photo.alt = '';
  photo.addEventListener('error', () => {
    const original = event.imageSource;
    if (original && photo.src !== original) photo.src = original;
    else button.classList.add('no-photo');
  });
  const caption = document.createElement('span');
  caption.className = 'ev-caption';
  const title = document.createElement('strong');
  const time = document.createElement('small');
  caption.append(title, time);
  button.append(photo, caption);
  inner.append(button);
  card.append(inner);
  button.classList.toggle('no-photo', !event.image);
  if (event.image) photo.src = event.image;
  title.textContent = event.title;
  time.textContent = (event.areaOnly ? 'Town area · ' : '') + event.when;
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    popup.eventsAtPin = features;
    openEvent(event.id);
  });
  return card;
}

export function setEventsOn(enabled: boolean) {
  eventsOn = enabled;
  eventsBtn.setAttribute('aria-pressed', String(enabled));
  eventsBtn.classList.toggle('active', enabled);
  updateCards();
  updatePlaces();
}

// ---------- Views: Normal (the plain map) or Satellite (••• › Views), remembered on this device ----------
export type MapView = 'map' | 'satellite';
const VIEW_KEY = 'mapView';
export let mapView: MapView = (() => {
  try { return localStorage.getItem(VIEW_KEY) === 'satellite' ? 'satellite' : 'map'; } catch (e) { return 'map'; }
})();
// The satellite style is the same in light and dark (photos); fetched the first time it is shown
let satelliteStyle: maplibregl.StyleSpecification | null = null;
let satelliteLoad: Promise<maplibregl.StyleSpecification> | null = null;
function loadSatellite(): Promise<maplibregl.StyleSpecification> {
  satelliteLoad ||= fetch(SATELLITE_STYLE_URL)
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<maplibregl.StyleSpecification>; })
    .then((st) => (satelliteStyle = st))
    .catch((e: unknown) => { satelliteLoad = null; throw e; }); // try again on the next tap
  return satelliteLoad;
}
function showView() {
  viewsBtn.classList.toggle('active', mapView === 'satellite');
  viewOptions.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === mapView)));
}
/** Switches between the plain map and the satellite view and remembers the choice. Resolves once it is drawn in. */
export function setMapView(view: MapView): Promise<void> {
  mapView = view;
  try { localStorage.setItem(VIEW_KEY, view); } catch (e) {}
  showView();
  if (view === 'map') { applyMapTheme(true); return Promise.resolve(); }
  return loadSatellite().then(() => { if (mapView === 'satellite') applyMapTheme(true); }, (e: unknown) => {
    if (mapView === 'satellite') setMapView('map');
    throw e;
  });
}

function applyMapTheme(diff: boolean) {
  const theme = currentTheme();
  const base = mapView === 'satellite' && satelliteStyle ? satelliteStyle : STYLES[theme];
  if (!base) return;
  const style = structuredClone(base);
  // Dots only show from zoom 17, so tiles past 17 are scaled up from 17 instead of being cut again
  style.sources.platforms = { type: 'geojson', data: platformsOnMap ? PLATFORM_FC : EMPTY_FC, maxzoom: PLATFORM_MIN_ZOOM };
  style.sources.route = { type: 'geojson', data: ROUTE_FC };
  style.sources.places = { type: 'geojson', data: placesOnMap ? PLACES_FC : EMPTY_FC };
  style.sources.kveh = { type: 'geojson', data: VEH_FC };
  const route = routeLayers(theme);
  const firstSymbol = style.layers.findIndex((l) => l.type === 'symbol');
  style.layers.splice(firstSymbol < 0 ? style.layers.length : firstSymbol, 0, ...route.below);
  style.layers.push(...placeLayers(theme), ...platformLayers(theme), ...vehLayers(theme), ...route.above);
  map.setStyle(style, { diff });
}


/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() {
  onThemeChange(() => applyMapTheme(true)); // a new theme from Settings or the system: the map's style follows
  showView();
  if (mapView === 'satellite') setMapView('satellite').catch(() => showToast('The satellite view could not be loaded.'));
  map.on('moveend', updateCards);
  map.on('zoom', () => {
    if (eventMarkers.size && map.getZoom() < EVENT_MIN_ZOOM) updateCards();
  });
  map.on('resize', updateCards);
  // Usually already on its way since the <head> (EARLY_STYLE)
  (window.EARLY_STYLE || fetch(STYLE_URL).then((r) => r.json()))
    .then((style: maplibregl.StyleSpecification) => {
      STYLES.light = style;
      STYLES.dark = makeDarkStyle(style);
      applyMapTheme(false);
      // Start the 2 MB platform data once the first map view has drawn, not while it is still loading
      map.once('idle', () => { updateCards(); startPlatforms(); });
    })
    .catch(() => { showToast('Map could not be loaded'); startPlatforms(); });
  themeMeta.setAttribute('content', getComputedStyle(root).getPropertyValue('--page-bg').trim());
  // Follow the system setting until the user picks a theme themselves
  if (window.matchMedia as typeof matchMedia | undefined) {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      let saved = null;
      try { saved = localStorage.getItem('theme'); } catch (err) {}
      if (!saved) setTheme(e.matches ? 'dark' : 'light', false);
    });
  }
}
