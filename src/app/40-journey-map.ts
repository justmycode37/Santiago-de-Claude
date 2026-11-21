// ---------- Journey (public transport via transport.opendata.ch) ----------
const ROUTE_FC = { type: 'FeatureCollection', features: [] };
let journeyStep = 0;
let journeySteps = [];
let journeyReq = 0;
const journeyEl = document.getElementById('journey');
const jHead = document.getElementById('jHead');
const jBody = document.getElementById('jBody');
const jFoot = document.getElementById('jFoot');
const jHandle = document.getElementById('jHandle');
let journeyConn = null;
let journeyFrom = 'Your location'; // where the trip starts: your position, or the map centre without one
let sheetMsg = '';                 // "Finding a connection…" and the like, while there is no trip to show
let journeyDest = null;
let journeyQuery: JourneyQuery = { mode: 'dep', date: '', time: '' }; // empty date/time = now
let progressTimer = null;
let liveTimer = null;

// ---- The journey on the map, drawn like the Kante app (nikitas-implementation): rides in their line colour
//      with a casing, a stop circle at every stop, walks as a yellow band with arrows, a sign where you board ----
const WALK = '#FFD34B';
const WALK_EDGE = '#14161A';
let routeOverview = true; // the whole journey at once: nothing dimmed until a step is picked
const stepOpacity = (dim, on = 1) => (routeOverview ? on : ['case', ['==', ['get', 'step'], journeyStep], on, dim]);
// …and the part of the trip already behind you fades
const routeOpacity = (dim, on = 1) => ['*', ['case', ['==', ['get', 'done'], true], .35, 1], stepOpacity(dim, on)];

// → { below: lines (under the map's labels), above: points and signs }
function routeLayers(theme) {
  const dark = theme === 'dark';
  const casing = dark ? '#0B0D10' : '#FFFFFF';
  const zoomW = (a, b) => ['interpolate', ['linear'], ['zoom'], 10, a, 17, b];
  const kind = (k) => ['==', ['get', 'kind'], k];
  const round = { 'line-cap': 'round', 'line-join': 'round' };
  const img = ['concat', ['get', 'img'], '|' + theme];
  const fixed = { 'icon-allow-overlap': true, 'icon-ignore-placement': true };
  return {
    below: [
      { id: 'route-ride-casing', type: 'line', source: 'route', filter: kind('ride'), layout: round,
        paint: { 'line-color': casing, 'line-width': zoomW(5, 10), 'line-opacity': routeOpacity(.5) } },
      { id: 'route-ride', type: 'line', source: 'route', filter: kind('ride'), layout: round,
        paint: { 'line-color': ['get', dark ? 'dcolor' : 'color'], 'line-width': zoomW(3, 6), 'line-opacity': routeOpacity(.4) } },
      { id: 'route-walk-casing', type: 'line', source: 'route', filter: kind('walk'), layout: round,
        paint: { 'line-color': WALK_EDGE, 'line-width': zoomW(5, 10.5), 'line-opacity': routeOpacity(.3, .75) } },
      { id: 'route-walk', type: 'line', source: 'route', filter: kind('walk'), layout: round,
        paint: { 'line-color': WALK, 'line-width': zoomW(3.5, 8), 'line-opacity': routeOpacity(.4) } },
    ],
    above: [
      { id: 'route-walk-arrows', type: 'symbol', source: 'route', filter: kind('walk'), minzoom: 14.5,
        layout: { ...fixed, 'symbol-placement': 'line', 'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 14.5, 18, 18, 30],
                  'icon-image': 'arr|k|' + theme, 'icon-size': ['interpolate', ['linear'], ['zoom'], 14.5, .6, 17, 1],
                  'icon-rotation-alignment': 'map', 'icon-padding': 0 },
        paint: { 'icon-opacity': routeOpacity(.4) } },
      { id: 'route-stops', type: 'circle', source: 'route', filter: kind('stop'),
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, ['case', ['get', 'end'], 3, 0], 13, ['case', ['get', 'end'], 5, 2.5], 17, ['case', ['get', 'end'], 7, 4.5]],
                 'circle-color': casing, 'circle-stroke-color': ['get', dark ? 'dcolor' : 'color'], 'circle-stroke-width': ['case', ['get', 'end'], 3, 2],
                 'circle-opacity': routeOpacity(.4), 'circle-stroke-opacity': routeOpacity(.4) } },
      // where the walk changes floor: which way, and to which level
      { id: 'route-lvl', type: 'symbol', source: 'route', filter: kind('lvl'), minzoom: 16,
        layout: { ...fixed, 'icon-image': img, 'icon-anchor': 'left', 'icon-offset': [8, 0] } },
      { id: 'route-pins', type: 'symbol', source: 'route', filter: kind('pin'), layout: { ...fixed, 'icon-image': img } },
      // "Platform 7" / "Bay C" where you board
      { id: 'route-signs', type: 'symbol', source: 'route', filter: kind('sign'),
        layout: { ...fixed, 'icon-image': img, 'symbol-sort-key': ['get', 'sort'],
                  'icon-size': ['interpolate', ['linear'], ['zoom'], 14, .85, 16.6, 1, 18.5, 1.15] } },
    ],
  };
}

function refreshRouteHighlight() {
  if (!map.getLayer('route-ride')) return;
  map.setPaintProperty('route-ride-casing', 'line-opacity', routeOpacity(.5));
  map.setPaintProperty('route-ride', 'line-opacity', routeOpacity(.4));
  map.setPaintProperty('route-walk-casing', 'line-opacity', routeOpacity(.3, .75));
  map.setPaintProperty('route-walk', 'line-opacity', routeOpacity(.4));
  map.setPaintProperty('route-walk-arrows', 'icon-opacity', routeOpacity(.4));
  map.setPaintProperty('route-stops', 'circle-opacity', routeOpacity(.4));
  map.setPaintProperty('route-stops', 'circle-stroke-opacity', routeOpacity(.4));
}

function setRoute(features) {
  ROUTE_FC.features = features;
  const src = map.getSource('route');
  if (src) src.setData(ROUTE_FC);
}
