// ---- Live vehicles on the map, from zoom 14: the engine's stream when it has one, else every 15 s. Not during
//      a journey (the trip's own vehicle is shown on it), not while the page is hidden. ----
const VEH_MIN_ZOOM = 14;
const VEH_FC: LiveVehicleCollection = { type: 'FeatureCollection', features: [] };
const VEH_MAX = 300; // enough for a city centre, light enough for a phone
let vehList: LiveVehicle[] = [], vehBox: KanteBbox | null = null, vehES: EventSource | null = null, vehPollTimer: number | null = null, vehDrawTimer: number | null = null, vehBusy = false, vehReq = 0;
// When the vehicles' data came in (vehAt, ms) and the engine's time it is for (vehT, unix s). Older than VEH_DIM_MS
// (the stream stalled, polls fail) they are drawn faded; older than VEH_DROP_MS they are taken off the map.
let vehAt = 0, vehT = 0;
const VEH_DIM_MS = 45000, VEH_DROP_MS = 120000;
// The engine's "now" for the vehicles: their t plus the time since they came (so a wrong phone clock doesn't matter)
const vehNow = () => vehT + (Date.now() - vehAt) / 1000;
function vehLayers(theme: Theme): maplibregl.LayerSpecification[] {
  const dark = theme === 'dark';
  const fade: maplibregl.ExpressionSpecification = ['case', ['get', 'dim'], .45, 1];
  return [
    { id: 'kveh-dot', type: 'circle', source: 'kveh', minzoom: VEH_MIN_ZOOM,
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], VEH_MIN_ZOOM, 5, 18, 8],
               'circle-color': ['get', dark ? 'dfg' : 'bg'],
               // extra journeys (not in the timetable, e.g. replacement buses) get a yellow ring
               'circle-stroke-color': ['case', ['get', 'extra'], WALK, dark ? '#0B0D10' : '#FFFFFF'],
               'circle-stroke-width': ['case', ['get', 'extra'], 3, 1.5],
               'circle-opacity': fade, 'circle-stroke-opacity': fade } },
    { id: 'kveh-label', type: 'symbol', source: 'kveh', minzoom: VEH_MIN_ZOOM + .5,
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Frutiger Neue Bold'],
                'text-size': ['interpolate', ['linear'], ['zoom'], VEH_MIN_ZOOM + .5, 10, 18, 12.5],
                'text-anchor': 'left', 'text-offset': [.75, 0], 'text-padding': 1, 'text-optional': true },
      paint: { 'text-color': ['get', dark ? 'dfg' : 'bg'], 'text-halo-color': dark ? '#0B0D10' : '#FFFFFF', 'text-halo-width': 1.6, 'text-opacity': fade } },
  ];
}
const vehWanted = () => kante.ok() && !journeyDest && !document.hidden && map.getZoom() >= VEH_MIN_ZOOM
  && SETTINGS.prefs().liveVehicles !== false;
function vehStop() {
  vehReq++;
  if (vehES) { vehES.close(); vehES = null; }
  clearInterval(vehPollTimer);
  clearInterval(vehDrawTimer);
  vehPollTimer = vehDrawTimer = null;
  vehBox = null;
  vehList = [];
  vehAt = vehT = 0;
  vehPopup.remove();
  vehDraw();
}
function vehUpdate() {
  if (!vehWanted()) { if (vehBox || vehList.length) vehStop(); return; }
  const b = map.getBounds(), view: KanteBbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  if (vehBox && KANTE_LIVE.bboxContains(vehBox, view)) return; // still covered: keep the stream / poll as it is
  vehStop();
  vehBox = KANTE_LIVE.padBbox(view, .35);
  if (!KANTE_LIVE.bboxOk(vehBox)) { vehBox = null; return; }
  const bbox = KANTE_LIVE.bboxParam(vehBox), id = vehReq;
  if (kante.has('stream') && window.EventSource) {
    vehES = new EventSource(kante.href('/api/stream', { bbox }));
    vehES.addEventListener('vehicles', (e) => { try { vehSet(JSON.parse(e.data)); } catch (err) { /* skip a bad event */ } });
    // closed for good (not a reconnect; e.g. 503 when the engine has too many streams open): poll instead
    vehES.onerror = () => {
      if (vehES && vehES.readyState === 2 && id === vehReq) { vehES = null; vehPollTimer = setInterval(() => vehFetch(bbox, id), 15000); vehFetch(bbox, id); }
    };
  } else {
    vehFetch(bbox, id);
    vehPollTimer = setInterval(() => vehFetch(bbox, id), 15000);
  }
  vehDrawTimer = setInterval(vehDraw, 1000); // glide between stops
}
async function vehFetch(bbox: string, id: number) {
  if (vehBusy || document.hidden) return;
  vehBusy = true;
  const data = await kante.get('/api/vehicles', { bbox });
  vehBusy = false;
  if (data && id === vehReq) vehSet(data);
}
function vehSet(data: KanteVehiclesResponse) {
  vehAt = Date.now();
  vehT = data && Number.isFinite(data.t) ? data.t : vehAt / 1000;
  // each vehicle is placed from its frac at the response's t
  vehList = ((data && data.vehicles) || []).slice(0, VEH_MAX).map((v) => ({ ...v, t: vehT, j: KANTE_LIVE.journeyLike(v.line), info: KANTE_LIVE.liveInfoOf(v) }));
  vehDraw();
}
function vehDraw() {
  const age = Date.now() - vehAt;
  if (vehList.length && age > VEH_DROP_MS) { vehList = []; vehPopup.remove(); }
  const now = vehNow(), old = age > VEH_DIM_MS;
  VEH_FC.features = vehList.map((v, i) => {
    const c = lineColor(v.j), st = v.info && v.info.state;
    return { type: 'Feature', geometry: { type: 'Point', coordinates: KANTE_LIVE.vehicleAt(v, now) },
      properties: { i, label: v.line.name, bg: c.bg, dfg: c.dfg, extra: !!v.extra, dim: old || st === 'stale' || st === 'timetable' } };
  });
  const src = map.getSource<maplibregl.GeoJSONSource>('kveh');
  if (src) src.setData(VEH_FC);
}
const vehPopup = new maplibregl.Popup({ closeButton: false, className: 'pf-pop vh-pop', maxWidth: 'none', offset: 12 });
map.on('click', (e) => {
  if (!vehList.length || !map.getLayer('kveh-dot')) return;
  const r = 14; // forgiving tap, as for platforms
  const hits = map.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers: ['kveh-dot'] });
  const dist = (x: maplibregl.MapGeoJSONFeature) => map.project((x.geometry as GeoJSON.Point).coordinates as LngLat).dist(e.point);
  const f = hits.length ? hits.reduce((a, b) => (dist(b) < dist(a) ? b : a)) : null, v = f && vehList[f.properties.i];
  if (!v) return;
  const now = vehNow(), old = Date.now() - vehAt > VEH_DIM_MS;
  // "Left its last stop … (measured)" only when under way after a measured departure from that stop
  const measured = !old && KANTE_LIVE.vehicleLeftMeasured(v);
  const how = old ? { text: `Not updated for ${Math.round((Date.now() - vehAt) / 60000) || 1} min: the live data is not coming through` }
    : KANTE_LIVE.liveText(v.info, { basis: v.basis, from: measured ? 'its last stop' : null, leftS: measured ? Math.max(0, now - v.dep) : null });
  const body = h('div', null,
    h('div', 'pf-head', kBadge(v.j), h('span', 'pf-name', h('b', null, `to ${v.headsign}`), h('small', null, `Next stop: ${v.nextStop}`))),
    v.extra ? h('p', 'pf-note vh-extra', 'Extra journey, not in the timetable') : null,
    h('p', 'vh-how', how.text));
  platformPopup.remove();
  vehPopup.setLngLat((f!.geometry as GeoJSON.Point).coordinates as LngLat).setDOMContent(body).addTo(map);
});
map.on('mouseenter', 'kveh-dot', () => { map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'kveh-dot', () => { map.getCanvas().style.cursor = ''; });
map.on('moveend', vehUpdate);

const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: string | null): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const badge = (j: LineLike) => lineVars(mk('span', 'j-badge', lineLabel(j)), j);
// Platform (rail, cable cars) · Bay (bus and tram edges, "Kante") · Pier (boats)
const nounOf = (mode: LineMode) => (mode === 'train' || mode === 'cable' ? 'Platform' : mode === 'boat' ? 'Pier' : 'Bay');
const platformWord = (j: LineLike) => nounOf(modeOf(j.category));
const platformOf = (stop: OdCheckpoint) => (stop.prognosis && stop.prognosis.platform) || stop.platform || '–';

const COMPASS8 = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const compassWord = (deg: number) => COMPASS8[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const levelShort = (l: number) => (l < 0 ? '−' + -l : String(l));
const fmtDist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`);

// "7A-D" → { num: '7', sectors: 'A–D' }; "H" → { num: 'H', sectors: '' }
function splitPlatform(p: string | null | undefined): PlatformParts {
  const m = /^(\d+)\s*([A-Z](?:\s*-\s*[A-Z])?|[A-Z]{2,})$/i.exec(p || '');
  if (!m) return { num: p || '', sectors: '' };
  let s = m[2].toUpperCase().replace(/\s*-\s*/, '–');
  if (!s.includes('–') && s.length > 1) s = `${s[0]}–${s[s.length - 1]}`;
  return { num: m[1], sectors: s };
}
