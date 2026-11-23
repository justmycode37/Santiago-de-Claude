import { root } from '../theme.ts';
// ---------- Map ----------
export const CH_BOUNDS: [LngLat, LngLat] = [[5.7, 45.6], [10.7, 48.0]];
const FALLBACK: LngLat = [7.4474, 46.9480]; // Bern
// Where the user was last time: the map opens there straight away (and loads those tiles) instead of in Bern
// and then jumping once GPS answers. Only kept on this device.
const SAVED_LOC = ((): LngLat | null => {
  try {
    const v = JSON.parse(localStorage.getItem('lastLocation')!);
    return Array.isArray(v) && v.length === 2 && v.every(Number.isFinite)
      && v[0] >= CH_BOUNDS[0][0] && v[0] <= CH_BOUNDS[1][0] && v[1] >= CH_BOUNDS[0][1] && v[1] <= CH_BOUNDS[1][1] ? v as LngLat : null;
  } catch (e) { return null; }
})();

// Performance on phones. Safari reports few cores, so MapLibre would decode every vector tile on a single
// worker thread; swisstopo tiles are large (up to ~220 KB each in cities), so panning waits on that one
// thread. Use three, as MapLibre's own cap for Safari allows.
const IS_WEBKIT_MOBILE = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_SAFARI = IS_WEBKIT_MOBILE || /^((?!chrome|chromium|android|edg).)*safari/i.test(navigator.userAgent);
if (IS_SAFARI) maplibregl.setWorkerCount(3);

export const map = new maplibregl.Map({
  container: 'map',
  // iPhones have 3× screens: drawing the map at 2× is about half the pixels per frame and looks the same
  pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  // Plain background until the swisstopo style (light or dark) is ready
  style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': getComputedStyle(root).getPropertyValue('--page-bg').trim() } }] },
  center: SAVED_LOC || FALLBACK,
  zoom: SAVED_LOC ? 15 : 13,
  minZoom: 6,
  maxZoom: 20,
  maxBounds: [[4.5, 44.9], [12.2, 48.6]],
  attributionControl: false,
  dragRotate: false,
  pitchWithRotate: false,
  touchPitch: false,
  maxPitch: 0,
  fadeDuration: 120,
  refreshExpiredTiles: false,
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();
