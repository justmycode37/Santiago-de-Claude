// ---------- Toast ----------
const toast = document.getElementById('toast')!;
let toastTimer: number | undefined;
function showToast(text: string, ms = 4000) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), ms);
}

// ---------- Top-right menu ----------
const menu = document.getElementById('menu')!;
const menuBtn = document.getElementById('menuBtn')!;
const menuItems = menu.querySelectorAll<HTMLElement>('.menu-item');
function setMenu(open: boolean) {
  menu.classList.toggle('open', open);
  menuBtn.setAttribute('aria-expanded', String(open));
  menuItems.forEach((b) => (b.tabIndex = open ? 0 : -1));
}
menuBtn.addEventListener('click', () => setMenu(!menu.classList.contains('open')));
const eventsBtn = document.getElementById('eventsBtn')!;
// Shows or hides everything switched on under "Events and places" in Settings
eventsBtn.addEventListener('click', () => {
  setEventsOn(!eventsOn);
  setMenu(false);
  menuBtn.focus();
  if (!eventsOn) return;
  if (journeyDest) { showToast('Events and places return after the journey.'); return; }
  const groups = SETTINGS.mapGroups();
  const wantPlaces = groups.some((k) => k !== 'events');
  if (!groups.length) showToast('Switch on events or places in Settings.');
  else if (!wantPlaces && !visibleEvents().length) showToast('No events match your settings.');
  else if (map.getZoom() < (groups.includes('events') ? EVENT_MIN_ZOOM : PLACE_MIN_ZOOM)) showToast('Zoom in to see events and places.');
  else if (wantPlaces && !viewNearBern()) {
    // toilets are mapped everywhere, the other groups only for Bern
    const others = groups.some((k) => k !== 'events' && k !== 'toilets');
    if (!groups.includes('toilets')) showToast('Only toilets are mapped outside Bern so far.');
    else if (others) showToast('Outside Bern, only Swiss toilets are mapped.');
  }
});
document.getElementById('settingsBtn')!.addEventListener('click', () => {
  setMenu(false);
  SETTINGS.open();
});
SETTINGS.onChange(() => { updateCards(); updatePlaces(); vehUpdate(); });
// Accessibility options changed during a journey → plan it again with them
SETTINGS.onClose((journeyChanged) => {
  if (journeyConn) renderFoot();
  if (journeyChanged && journeyDest) startJourney(journeyDest, true);
  else menuBtn.focus();
});

/** iOS Safari: the compass has to be asked for, from a tap. */
type DeviceOrientationAsk = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> };
// ---------- Scan: recognise the stops around you with the camera (stopvision.js, loaded on first use) ----------
document.getElementById('scanBtn')!.addEventListener('click', () => {
  setMenu(false);
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('The camera needs HTTPS. Open the app via https:// or localhost.', 6000);
  }
  // Both permissions are asked right here, while the tap still counts as a user gesture (iOS needs that)
  const camera = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    ? navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
    : Promise.reject(new Error('no camera API'));
  const orientation = window.DeviceOrientationEvent && typeof (DeviceOrientationEvent as DeviceOrientationAsk).requestPermission === 'function'
    ? (DeviceOrientationEvent as DeviceOrientationAsk).requestPermission!() : Promise.resolve('granted');
  camera.catch(() => {}); orientation.catch(() => {});
  const hooks: StopVisionHooks = {
    PLATFORMS, OPENDATA, platformLL, coordOf, badge,
    position: () => (userLngLat ? { ll: userLngLat, acc: userAccuracy, age: fixAge() } : null),
    openStop: (id, i) => {
      const st = PLATFORMS.get(String(id));
      if (!st) return;
      const ll = i != null && st.edges[i] ? st.edges[i].ll : st.edges[0].ll;
      map.flyTo({ center: ll, zoom: Math.max(map.getZoom(), 18) });
      openPlatform({ properties: { id: String(id), i } });
    },
    toast: (t) => showToast(t),
    onClose: () => menuBtn.focus(),
  };
  startPlatforms(); // the stop positions are needed straight away
  const go = () => platformsReady.then(() => window.STOPVISION!.open(hooks, camera, orientation));
  if (window.STOPVISION) go();
  else {
    const s = document.createElement('script');
    s.src = 'stopvision.js';
    s.onload = go;
    s.onerror = () => {
      showToast('Scan could not be loaded.');
      camera.then((st) => st.getTracks().forEach((t) => t.stop()), () => {}); // don't leave the camera on
    };
    document.head.appendChild(s);
  }
});
