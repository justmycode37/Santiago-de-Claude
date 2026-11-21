// ---------- Current location ----------
const accEl = document.createElement('div');
accEl.className = 'user-accuracy';
const accMarker = new maplibregl.Marker({ element: accEl });
const dotEl = document.createElement('div');
dotEl.className = 'user-dot';
const userMarker = new maplibregl.Marker({ element: dotEl });
let userLngLat = null;
let userAccuracy = 0;
let lastFixAt = 0;
const recentFixes = [];
let centeredOnUser = false;
const fixAge = () => (lastFixAt ? Date.now() - lastFixAt : Infinity);
// A recent, usable GPS fix (watchPosition can stay quiet while you stand still, so allow a while)
const gpsOn = () => !!userLngLat && fixAge() < 90000 && userAccuracy < 400;

const inSwitzerland = ([lng, lat]) =>
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
map.on('zoom', updateAccuracy);

let lastSavedAt = 0;
function onPosition(pos) {
  const lngLat = [pos.coords.longitude, pos.coords.latitude];
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
  // the last minute of fixes, to tell whether you are moving (on board) or standing
  recentFixes.push({ ll: lngLat, t: takenAt, speed: pos.coords.speed });
  while (recentFixes.length && recentFixes[0].t < takenAt - 60000) recentFixes.shift();
  if (now - lastSavedAt > 30000) {
    lastSavedAt = now;
    try { localStorage.setItem('lastLocation', JSON.stringify(lngLat.map((x) => +x.toFixed(4)))); } catch (e) {}
  }
  accMarker.setLngLat(lngLat);
  userMarker.setLngLat(lngLat);
  if (!userMarker._map) { accMarker.addTo(map); userMarker.addTo(map); }
  updateAccuracy();
  if (window.Station3D) Station3D.setUser({ ll: lngLat, accuracy: userAccuracy, heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : undefined });
  if (!centeredOnUser && !destMarker._map) {
    centeredOnUser = true;
    map.jumpTo({ center: lngLat, zoom: 15 });
  }
  if (journeyConn) scheduleProgress(); // follow the trip with every fix
}

function onPositionError(err) {
  if (userLngLat) return; // keep the last known position
  const msg = err.code === 1
    ? 'Location access is off. Allow it in Settings › Safari › Location.'
    : 'Your location could not be found.';
  showToast(msg, 6000);
}

if (!window.isSecureContext) {
  showToast('Location needs HTTPS. Open the app via https:// or localhost.', 8000);
} else if (!('geolocation' in navigator)) {
  showToast('This browser does not support location.');
} else {
  // The quick coarse fix and the precise live updates were already asked for in the <head> (EARLY_GEO)
  // (after this script has run: onPosition uses things declared further down)
  setTimeout(() => EARLY_GEO.attach(onPosition, onPositionError), 0);
}
