// ---------- Theme helpers ----------
const root = document.documentElement;
const themeMeta = document.querySelector('meta[name="theme-color"]');
const currentTheme = () => root.dataset.theme === 'dark' ? 'dark' : 'light';

// ---------- Map ----------
const STYLE_URL = 'https://vectortiles.geo.admin.ch/styles/ch.swisstopo.lightbasemap.vt/style.json';
const CH_BOUNDS = [[5.7, 45.6], [10.7, 48.0]];
const FALLBACK = [7.4474, 46.9480]; // Bern
// Where the user was last time: the map opens there straight away (and loads those tiles) instead of in Bern
// and then jumping once GPS answers. Only kept on this device.
const SAVED_LOC = (() => {
  try {
    const v = JSON.parse(localStorage.getItem('lastLocation'));
    return Array.isArray(v) && v.length === 2 && v.every(Number.isFinite)
      && v[0] >= CH_BOUNDS[0][0] && v[0] <= CH_BOUNDS[1][0] && v[1] >= CH_BOUNDS[0][1] && v[1] <= CH_BOUNDS[1][1] ? v : null;
  } catch (e) { return null; }
})();

// Performance on phones. Safari reports few cores, so MapLibre would decode every vector tile on a single
// worker thread; swisstopo tiles are large (up to ~220 KB each in cities), so panning waits on that one
// thread. Use three, as MapLibre's own cap for Safari allows.
const IS_WEBKIT_MOBILE = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_SAFARI = IS_WEBKIT_MOBILE || /^((?!chrome|chromium|android|edg).)*safari/i.test(navigator.userAgent);
if (IS_SAFARI) maplibregl.setWorkerCount(3);

const map = new maplibregl.Map({
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

// swisstopo has no dark vector basemap. Same as the Kante app: a dark variant of the light base map,
// made by remapping the lightness of every colour in the style (ground, roads, casings and text separately).
const STYLES = { light: null, dark: null };

function parseColor(c) {
  const s = String(c).trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
    const n = parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1];
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length >= 3 && p.every((x) => !Number.isNaN(x))) return [p[0], p[1], p[2], p[3] ?? 1];
  }
  m = /^hsla?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map((x) => parseFloat(x));
    if (p.length >= 3) return [...fromHsl(p[0], p[1] / 100, p[2] / 100), p[3] ?? 1];
  }
  return null;
}
function toHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function fromHsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round((l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))) * 255);
  return [f(0), f(8), f(4)];
}
// land, water, buildings: lightness inverted into a narrow dark range with a cool tint
const darkGround = (h, s, l) => (s < 0.1 ? [222, 0.2, 0.075 + (1 - l) * 0.5] : [h, s * 0.55, 0.08 + (1 - l) * 0.62]);
// road surfaces: lighter than the land so the network stays readable
const darkRoad = (h, s, l) => [s < 0.1 ? 222 : h, s < 0.1 ? 0.16 : s * 0.5, 0.2 + l * 0.12];
const darkRoadCasing = (h, s, l) => [s < 0.1 ? 222 : h, s < 0.1 ? 0.18 : s * 0.5, 0.1 + (1 - l) * 0.12];
const darkText = (h, s, l) => [s < 0.1 ? 222 : h, s < 0.1 ? 0.12 : s * 0.7, Math.min(0.86, 0.5 + (1 - l) * 0.4)];
const darkHalo = () => [222, 0.25, 0.08];
function remapColors(v, f) {
  if (typeof v === 'string') {
    const p = parseColor(v);
    if (!p) return v;
    const [r, g, b] = fromHsl(...f(...toHsl(p[0], p[1], p[2])));
    return `rgba(${r},${g},${b},${p[3]})`;
  }
  if (Array.isArray(v)) return v.map((x) => remapColors(x, f));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k in v) o[k] = remapColors(v[k], f);
    return o;
  }
  return v;
}
const DARK_HIDE = /^(hillshade|scree|hachure|pattern_landcover|contour_line)/;
function makeDarkStyle(base) {
  const style = structuredClone(base);
  for (const layer of style.layers) {
    if (DARK_HIDE.test(layer.id)) {
      layer.layout = { ...(layer.layout || {}), visibility: 'none' };
      continue;
    }
    const paint = layer.paint;
    if (!paint) continue;
    const isRoadFill = /(^|_)fill$/.test(layer.id) && layer.type === 'line';
    const isRoadCasing = /road_casing|tunnel_road|pedestrian|footway|parking/.test(layer.id);
    for (const key of Object.keys(paint)) {
      if (!key.endsWith('-color')) continue;
      const f = key === 'text-halo-color' || key === 'icon-halo-color' ? darkHalo
        : key === 'text-color' || key === 'icon-color' ? darkText
        : isRoadFill ? darkRoad : isRoadCasing ? darkRoadCasing : darkGround;
      paint[key] = remapColors(paint[key], f);
    }
  }
  return style;
}
