// ---------- Platforms & stop edges ----------
// Exact position of every platform (Gleis) and bus/tram stop edge (Kante) in Switzerland, from the
// official ATLAS data (platforms.js, built by tools/build_platforms.py). Always drawn on the map from
// zoom 17, and used to put journey boarding/alighting points on the right platform.
const PLATFORM_FC: GeoJSON.FeatureCollection<GeoJSON.Point, PlatformDotProps> = { type: 'FeatureCollection', features: [] };
const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
// The ~52,000 dots are only handed to the map the first time it comes near the zoom where they show:
// indexing them occupies a map worker, which would otherwise hold up the base map tiles.
let platformsOnMap = false;
function showPlatformsIfNeeded() {
  if (platformsOnMap || !PLATFORM_FC.features.length || map.getZoom() < PLATFORM_MIN_ZOOM - 1.5) return;
  platformsOnMap = true;
  const src = map.getSource('platforms') as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(PLATFORM_FC);
}
map.on('zoomend', showPlatformsIfNeeded);
const PLATFORMS = new Map<string, PlatformStop>(); // station id (UIC, as in transport.opendata.ch) → { name, mode, edges: [{ ref, key, bearing, ll }] }
const PLATFORM_MODES: Record<PlatformModeCode, PlatformMode> = { t: 'train', m: 'tram', b: 'bus', s: 'boat', c: 'cable' };

// Comparable platform name: "7A-D" → "7", "Kante H" → "H", "K1" → "K1", "–" → ""
function platformKey(p: string | number | null | undefined) {
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
let startPlatforms!: () => void;
const platformsReady = new Promise<void>((resolve) => {
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
setTimeout(startPlatforms, 8000);

// Neutral white dots that only appear when zoomed in close (street level)
const PLATFORM_MIN_ZOOM = 17;
const PLATFORM_TEXT_NUDGE = 0.135; // em down: the font sits high in its line box (measured)
function platformLayers(theme: Theme): maplibregl.LayerSpecification[] {
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
const platformPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'pf-pop', maxWidth: 'none', offset: 16 });
let popupReq = 0;
let popupPlace: MapGroupKey | null = null; // the place (toilet, pharmacy…) whose card is open
// Forgiving tap: the nearest dot or place icon within ~16 px, so small dots are easy to hit on a phone
map.on('click', (e) => {
  if (WALK_PACE.drawing()) return; // the taps draw a path (developer options)
  if (pinTap(e.lngLat.toArray())) return; // placing a pin, or closing the "From here / To here" menu
  const r = 16;
  const layers = ['platform-dot', ...PLACE_LAYERS].filter((id) => map.getLayer(id));
  const hits = layers.length
    ? map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers }) : [];
  if (!hits.length) { popupReq++; popupPlace = null; platformPopup.remove(); return; }
  const dist = (f: maplibregl.MapGeoJSONFeature) => map.project((f.geometry as GeoJSON.Point).coordinates as LngLat).dist(e.point);
  const hit = hits.reduce((a, b) => (dist(b) < dist(a) ? b : a));
  if (hit.layer.id === 'platform-dot') openPlatform(hit as PlatformDotFeature);
  else openPlace(hit.properties.i);
});
async function openPlatform(f: PlatformTap) {
  popupPlace = null;
  const st = PLATFORMS.get(String(f.properties.id));
  // i = null: the stop as a whole (e.g. recognised by Scan without knowing which edge), all its departures
  const whole = st && f.properties.i == null;
  const edge = whole
    ? { ref: '', level: null, ll: st.edges.reduce<LngLat>((s, e) => [s[0] + e.ll[0] / st.edges.length, s[1] + e.ll[1] / st.edges.length], [0, 0]) }
    : st && st.edges[f.properties.i!];
  if (!edge) return;
  const req = ++popupReq;
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
  const key3d = window.Station3D && Station3D.has(f.properties.id);
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
      s3Step = null;
      Station3D.open({ key: key3d, from: near ? { ll: userLngLat! } : undefined, to, prefs: SETTINGS.journey(), returnFocus: view3d });
    });
    box.append(view3d);
  }
  platformPopup.setLngLat(edge.ll).setDOMContent(box).addTo(map);
  try {
    // The Kante engine knows the edge of every departure (engine-departures.js: d.edges). Without it,
    // transport.opendata.ch and the rule below.
    const exact = window.KANTE_BOARD ? await KANTE_BOARD!.load(f.properties.id, st, platformLL, f.properties.i) : null;
    const res = exact || await fetch(`${OPENDATA}stationboard?` + new URLSearchParams({ id: f.properties.id, limit: '40' }));
    const all: OdStationboardEntry[] = exact || ((await (res as Response).json() as OdStationboardResponse).stationboard || []).filter((d) => d.stop && d.stop.departure);
    if (req !== popupReq) return;
    // a departure leaves from this edge if it is where we would board it (same rule as for journeys)
    const here = whole ? all : all.filter((d) => (d.edges ? d.edges.includes(f.properties.i!) : platformLL(d.stop, null, d.passList && d.passList[1] ? coordOf(d.passList[1]) : null) === edge.ll));
    note.textContent = !all.length ? 'No departures in the next hours.' : here.length ? '' : `All departures from ${st!.name}:`;
    list.replaceChildren(...(here.length ? here : all).slice(0, 6).map((d) => {
      const li = mk('li');
      li.append(mk('time', null, fmtTime(d.stop.prognosis && d.stop.prognosis.departure || d.stop.departure)), badge(d), mk('span', 'pf-to', d.to));
      if (d.stop.delay! > 0) li.append(mk('span', 'j-delay', `+${d.stop.delay}′`));
      return li;
    }));
    platformPopup.setLngLat(edge.ll); // re-fit now that the card is taller
  } catch {
    if (req === popupReq) note.textContent = 'Departures could not be loaded.';
  }
}
map.on('mouseenter', 'platform-dot', () => { map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'platform-dot', () => { map.getCanvas().style.cursor = ''; });
