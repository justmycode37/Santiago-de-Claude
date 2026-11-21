// ---------- Community events ----------
// Which events show is set on the Settings page (settings.js)
function visibleEvents() {
  const preferences = SETTINGS.eventTags();
  return EVENTS.features.filter((event) => EVENTS.matches(event, preferences));
}

const EVENT_MIN_ZOOM = 12.5;
// Cards on the map, by venue + events shown. Cards that stay on screen after a move are kept as they are
// (no rebuild, no reloaded photo, no pop-in animation); only cards that change are added or removed.
const eventMarkers = new Map<string, maplibregl.Marker>();
/** A place with events, where its card goes on the screen. */
interface EventVenue { point: maplibregl.Point; coordinates: LngLat; features: EventFeature[] }
let eventsOn = false;

function clearCards() {
  for (const marker of eventMarkers.values()) marker.remove();
  eventMarkers.clear();
}

function updateCards() {
  // during a journey the map shows only the trip and the destination
  if (!eventsOn || journeyDest || !SETTINGS.mapGroups().includes('events') || map.getZoom() < EVENT_MIN_ZOOM) { clearCards(); return; }

  const { clientWidth, clientHeight } = map.getContainer();
  const venues = new Map<string, EventVenue>();
  for (const feature of visibleEvents()) {
    const coordinates = feature.geometry.coordinates;
    const key = coordinates.join(',');
    let venue = venues.get(key);
    if (!venue) {
      const point = map.project(coordinates);
      if (point.x < -75 || point.x > clientWidth + 75 || point.y < 0 || point.y > clientHeight + 186) continue;
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
    if (!overlap) shown.push(venue);
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
  A11Y.inLang(title, A11Y.textLang(event.title));
  time.textContent = (event.areaOnly ? 'Town area · ' : '') + event.when;
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    eventsAtPin = features;
    eventBack = () => button;
    openEvent(event.id);
  });
  return card;
}
map.on('moveend', updateCards);
map.on('zoom', () => {
  if (eventMarkers.size && map.getZoom() < EVENT_MIN_ZOOM) updateCards();
});
map.on('resize', updateCards);

function setEventsOn(enabled: boolean) {
  eventsOn = enabled;
  eventsBtn.setAttribute('aria-pressed', String(enabled));
  eventsBtn.classList.toggle('active', enabled);
  updateCards();
  updatePlaces();
}

function applyMapTheme(diff: boolean) {
  const theme = currentTheme();
  if (!STYLES[theme]) return;
  const style = structuredClone(STYLES[theme]);
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

function setTheme(theme: Theme, persist: boolean) {
  root.dataset.theme = theme;
  themeMeta.setAttribute('content', getComputedStyle(root).getPropertyValue('--page-bg').trim());
  if (persist) { try { localStorage.setItem('theme', theme); } catch (e) {} }
  applyMapTheme(true);
}
themeMeta.setAttribute('content', getComputedStyle(root).getPropertyValue('--page-bg').trim());

// Follow the system setting until the user picks a theme themselves
if (window.matchMedia as typeof matchMedia | undefined) {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    let saved = null;
    try { saved = localStorage.getItem('theme'); } catch (err) {}
    if (!saved) setTheme(e.matches ? 'dark' : 'light', false);
  });
}
