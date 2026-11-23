// ---------- Current location ----------
import { CH_BOUNDS, map } from './map.ts';
import { showToast } from './menu.ts';
import { destMarker, inputs, startMarker } from './search.ts';
import { scheduleProgress } from './live-line.ts';
import { journey } from './state.ts';
const accEl = document.createElement('div');
accEl.className = 'user-accuracy';
const accMarker = new maplibregl.Marker({ element: accEl });
const dotEl = document.createElement('div');
dotEl.className = 'user-dot';
export const userMarker = new maplibregl.Marker({ element: dotEl });
export let userLngLat: LngLat | null = null;
export let userAccuracy = 0;
let lastFixAt = 0;
let centeredOnUser = false;
export const fixAge = () => (lastFixAt ? Date.now() - lastFixAt : Infinity);
// A recent, usable GPS fix (watchPosition can stay quiet while you stand still, so allow a while)
export const gpsOn = () => !!userLngLat && fixAge() < 90000 && userAccuracy < 400;

export const inSwitzerland = ([lng, lat]: LngLat) =>
  lng >= CH_BOUNDS[0][0] && lng <= CH_BOUNDS[1][0] &&
  lat >= CH_BOUNDS[0][1] && lat <= CH_BOUNDS[1][1];

// Size the light-blue accuracy halo in metres, like Apple Maps
function updateAccuracy() {
  if (!userLngLat) return;
  const mPerPx = 40075016.686 * Math.cos(userLngLat[1] * Math.PI / 180) / (512 * 2 ** map.getZoom());
  const d = Math.min(2 * userAccuracy / mPerPx, 4000);
  // No size animation while zooming: it would lay the page out again on every frame of a pinch
  accEl.style.transition = map.isZooming() ? 'none' : '';
  accEl.style.width = accEl.style.height = d + 'px';
  accEl.style.display = d < 40 ? 'none' : '';
}

let lastSavedAt = 0;
let lastRealPos: PositionFix | null = null; // the newest fix from the phone itself, to come back to after a simulated walk
export function onPosition(pos: PositionFix) {
  if (!pos.simulated) lastRealPos = pos;
  const lngLat: LngLat = [pos.coords.longitude, pos.coords.latitude];
  if (!inSwitzerland(lngLat)) {
    showToast('You are outside Switzerland');
    return;
  }
  // When the fix was taken: a cached one can be minutes old, and may arrive after a newer precise one
  const now = Date.now();
  const takenAt = pos.timestamp > now - 864e5 ? Math.min(pos.timestamp, now) : now;
  if (takenAt < lastFixAt) return;
  userLngLat = lngLat;
  userAccuracy = pos.coords.accuracy || 0;
  lastFixAt = takenAt;
  // "Adjust to how I walk" (Settings) measures your pace from these fixes; it does nothing while switched off
  if (!pos.simulated) WALK_PACE.fix({ ll: lngLat, acc: userAccuracy, speed: pos.coords.speed, t: takenAt });
  if (!pos.simulated && now - lastSavedAt > 30000) {
    lastSavedAt = now;
    try { localStorage.setItem('lastLocation', JSON.stringify(lngLat.map((x) => +x.toFixed(4)))); } catch (e) {}
  }
  accMarker.setLngLat(lngLat);
  userMarker.setLngLat(lngLat);
  if (!userMarker._map) { accMarker.addTo(map); userMarker.addTo(map); }
  updateAccuracy();
  // through the indoor filter (indoornav.js) while a station is open in 3D: it adds the floor and the phone's steps
  if (window.Station3D) (window.INDOORNAV || Station3D).setUser({ ll: lngLat, accuracy: userAccuracy, heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : undefined, at: takenAt });
  inputs.from.placeholder = 'Your location';
  if (!centeredOnUser && !destMarker._map && !startMarker._map) {
    centeredOnUser = true;
    map.jumpTo({ center: lngLat, zoom: 15 });
  }
  if (journey.conn) scheduleProgress(); // follow the trip with every fix
}

export function onPositionError(err: GeolocationPositionError) {
  if (userLngLat) return; // keep the last known position
  const msg = err.code === 1
    ? 'Location access is off. Allow it in Settings › Safari › Location.'
    : 'Your location could not be found.';
  showToast(msg, 6000);
}

/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() {
  map.on('zoom', updateAccuracy);
  if (!window.isSecureContext) {
    showToast('Open this page over HTTPS to use your location.', 8000);
  } else if (!('geolocation' in navigator)) {
    showToast('This browser does not support location.');
  } else {
    // The quick coarse fix and the precise live updates were already asked for in the <head> (EARLY_GEO)
    // (after this script has run: onPosition uses things declared further down)
    setTimeout(() => EARLY_GEO.attach(onPosition, onPositionError), 0);
  }
  // Developer options: walking a path drawn on the map puts your position at its end
  WALK_PACE.attach({
    map,
    position: (pos) => { centeredOnUser = true; onPosition(pos); }, // (don't jump the map to the first made-up fix)
    restore: () => {
      if (!lastRealPos) return; // no real position: you stay where the walk ended
      lastFixAt = 0;
      onPosition(lastRealPos);
    },
  });
}
