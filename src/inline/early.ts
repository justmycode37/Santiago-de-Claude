// Start the two slow things before the map library and the event data (about 1.5 MB) have downloaded:
// finding the user's location and fetching the base map style. On a phone each takes a second or more.
import { fetchStyleWithTiles } from '../tilejson.ts';

(function () {
  // Location: fixes that come in early wait here until the main script attaches to them
  const geo = window.EARLY_GEO = {
    fixes: [], errors: [], on: null,
    attach(onFix, onError) {
      this.on = { onFix, onError };
      this.fixes.splice(0).forEach(onFix);
      this.errors.splice(0).forEach(onError);
    },
  } as Omit<EarlyGeo, 'start'> as EarlyGeo;
  geo.start = () => {
    if (geo.started || !window.isSecureContext || !navigator.geolocation) return;
    geo.started = true;
    const fix = (p: GeolocationPosition) => (geo.on ? geo.on.onFix(p) : geo.fixes.push(p));
    const fail = (e: GeolocationPositionError) => (geo.on ? geo.on.onError(e) : geo.errors.push(e));
    try {
      // A position the phone already has (up to 10 min old) comes back at once; the precise one follows
      navigator.geolocation.getCurrentPosition(fix, () => {}, { enableHighAccuracy: false, maximumAge: 600000, timeout: 4000 });
      navigator.geolocation.watchPosition(fix, fail, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    } catch (e) {}
  };
  // On a first visit the introduction asks first: it holds the prompt back (EARLY_GEO.held) and calls
  // EARLY_GEO.start() when it ends (onboarding.ts). If the page's script never opened it (the script did not load,
  // or failed before it got that far; modules have run by DOMContentLoaded), the cover goes and the location is
  // asked for, as without the introduction: the app must still be reachable.
  const html = document.documentElement;
  if (!html.dataset.onboarding) geo.start();
  else document.addEventListener('DOMContentLoaded', () => { if (!geo.held) { delete html.dataset.onboarding; geo.start(); } });

  // Base map style with its two tile sets written in (src/tilejson.ts): saves two round trips before the first tile
  window.EARLY_STYLE = fetchStyleWithTiles('https://vectortiles.geo.admin.ch/styles/ch.swisstopo.lightbasemap.vt/style.json');
  window.EARLY_STYLE.catch(() => {}); // handled where it is used
})();
