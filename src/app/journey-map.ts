// ---------- Journey (public transport and walks, planned by the Kante engine: src/engine-journey.ts) ----------
import { map } from './map.ts';
import { journey } from './state.ts';
export const ROUTE_FC: RouteCollection = { type: 'FeatureCollection', features: [] };
export const journeyEl = document.getElementById('journey')!;
export const jHead = document.getElementById('jHead')!;
export const jBody = document.getElementById('jBody')!;
export const jFoot = document.getElementById('jFoot')!;
export const jHandle = document.getElementById('jHandle')!;

// ---- The journey on the map, drawn like the Kante app (nikitas-implementation): rides in their line colour
//      with a casing, a stop circle at every stop, walks as a yellow band with arrows, a sign where you board ----
export const WALK = '#FFD34B';
const WALK_EDGE = '#14161A';
const stepOpacity = (dim: number, on = 1): number | maplibregl.ExpressionSpecification => (journey.overview ? on : ['case', ['==', ['get', 'step'], journey.step], on, dim]);
// …and the part of the trip already behind you fades
const routeOpacity = (dim: number, on = 1): maplibregl.ExpressionSpecification => ['*', ['case', ['==', ['get', 'done'], true], .35, 1], stepOpacity(dim, on)];

// → { below: lines (under the map's labels), above: points and signs }
export function routeLayers(theme: Theme): RouteLayers {
  const dark = theme === 'dark';
  const casing = dark ? '#0B0D10' : '#FFFFFF';
  const zoomW = (a: number, b: number): maplibregl.ExpressionSpecification => ['interpolate', ['linear'], ['zoom'], 10, a, 17, b];
  const kind = (k: RouteFeatureProps['kind']): maplibregl.FilterSpecification => ['==', ['get', 'kind'], k];
  // walks drawn as routed paths, and the straight lines no router found a way for (drawn dashed, without arrows)
  const walkRouted: maplibregl.FilterSpecification = ['all', ['==', ['get', 'kind'], 'walk'], ['!', ['has', 'approx']]];
  const walkGuess: maplibregl.FilterSpecification = ['all', ['==', ['get', 'kind'], 'walk'], ['has', 'approx']];
  const round: maplibregl.LineLayerSpecification['layout'] = { 'line-cap': 'round', 'line-join': 'round' };
  const img: maplibregl.ExpressionSpecification = ['concat', ['get', 'img'], '|' + theme];
  const fixed = { 'icon-allow-overlap': true, 'icon-ignore-placement': true };
  return {
    below: [
      { id: 'route-ride-casing', type: 'line', source: 'route', filter: kind('ride'), layout: round,
        paint: { 'line-color': casing, 'line-width': zoomW(5, 10), 'line-opacity': routeOpacity(.5) } },
      { id: 'route-ride', type: 'line', source: 'route', filter: kind('ride'), layout: round,
        paint: { 'line-color': ['get', dark ? 'dcolor' : 'color'], 'line-width': zoomW(3, 6), 'line-opacity': routeOpacity(.4) } },
      { id: 'route-walk-casing', type: 'line', source: 'route', filter: walkRouted, layout: round,
        paint: { 'line-color': WALK_EDGE, 'line-width': zoomW(5, 10.5), 'line-opacity': routeOpacity(.3, .75) } },
      { id: 'route-walk', type: 'line', source: 'route', filter: walkRouted, layout: round,
        paint: { 'line-color': WALK, 'line-width': zoomW(3.5, 8), 'line-opacity': routeOpacity(.4) } },
      // no walking route found: a straight line, dashed, so it does not look like a path to follow
      { id: 'route-walk-approx', type: 'line', source: 'route', filter: walkGuess,
        paint: { 'line-color': WALK, 'line-width': zoomW(3.5, 8), 'line-dasharray': [1, 1.2], 'line-opacity': routeOpacity(.4) } },
      // under arcades, through passages and underpasses, indoors: a dashed line down the middle of the walk
      { id: 'route-walk-covered', type: 'line', source: 'route', filter: kind('wcov'), minzoom: 15, layout: { 'line-join': 'round' },
        paint: { 'line-color': WALK_EDGE, 'line-width': zoomW(1, 2.2), 'line-dasharray': [2, 2], 'line-opacity': routeOpacity(.3, .8) } },
    ],
    above: [
      { id: 'route-walk-arrows', type: 'symbol', source: 'route', filter: walkRouted, minzoom: 14.5,
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
      // the door the walk ends at
      { id: 'route-door', type: 'circle', source: 'route', filter: kind('door'), minzoom: 15,
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 15, 3.5, 18, 7], 'circle-color': WALK,
                 'circle-stroke-color': WALK_EDGE, 'circle-stroke-width': 2.5, 'circle-opacity': routeOpacity(.4), 'circle-stroke-opacity': routeOpacity(.4) } },
      // "Platform 7" / "Bay C" where you board
      { id: 'route-signs', type: 'symbol', source: 'route', filter: kind('sign'), minzoom: 13,
        layout: { ...fixed, 'icon-image': img, 'symbol-sort-key': ['get', 'sort'],
                  'icon-size': ['interpolate', ['linear'], ['zoom'], 14, .85, 16.6, 1, 18.5, 1.15] } },
    ],
  };
}

export function refreshRouteHighlight() {
  if (!map.getLayer('route-ride')) return;
  map.setPaintProperty('route-ride-casing', 'line-opacity', routeOpacity(.5));
  map.setPaintProperty('route-ride', 'line-opacity', routeOpacity(.4));
  map.setPaintProperty('route-walk-casing', 'line-opacity', routeOpacity(.3, .75));
  map.setPaintProperty('route-walk', 'line-opacity', routeOpacity(.4));
  map.setPaintProperty('route-walk-approx', 'line-opacity', routeOpacity(.4));
  map.setPaintProperty('route-walk-covered', 'line-opacity', routeOpacity(.3, .8));
  map.setPaintProperty('route-door', 'circle-opacity', routeOpacity(.4));
  map.setPaintProperty('route-door', 'circle-stroke-opacity', routeOpacity(.4));
  map.setPaintProperty('route-walk-arrows', 'icon-opacity', routeOpacity(.4));
  map.setPaintProperty('route-stops', 'circle-opacity', routeOpacity(.4));
  map.setPaintProperty('route-stops', 'circle-stroke-opacity', routeOpacity(.4));
}

export function setRoute(features: RouteFeature[]) {
  ROUTE_FC.features = features;
  const src = map.getSource<maplibregl.GeoJSONSource>('route');
  if (src) src.setData(ROUTE_FC);
}
