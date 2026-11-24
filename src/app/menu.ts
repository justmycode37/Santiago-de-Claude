import { map } from './map.ts';
import { showToast } from '../toast.ts';
import { load, reloadNote } from '../lazy.ts';
import type { STOPVISION } from '../stopvision.ts';
import { EVENT_MIN_ZOOM, eventsOn, setEventsOn, setMapView, updateCards, visibleEvents } from './map-events.ts';
import type { MapView } from './map-events.ts';
import { fixAge, userAccuracy, userLngLat } from './location.ts';
import { PLATFORMS, openPlatform, platformKey, platformsReady, startPlatforms } from './platforms.ts';
import { PLACE_MIN_ZOOM, updatePlaces, viewNearBern } from './map-places.ts';
import { lineLabel, liveMs, stopName, stopUic } from './journey-steps.ts';
import { badge, platformOf, vehUpdate } from './live-vehicles.ts';
import { renderFoot } from './sheet-content.ts';
import { startJourney } from './pill.ts';
import { distKm } from './routing.ts';
import { journey } from './state.ts';
import { KANTE } from '../engine.ts';
import { SETTINGS } from '../settings.ts';
import type { StopVisionHooks } from '../stopvision.ts';
import { KANTE_BOARD } from '../engine-departures.ts';
import { indoor } from '../station3d.ts';
// ---------- Top-right menu ----------
export const menu = document.getElementById('menu')!;
const menuBtn = document.getElementById('menuBtn')!;
const menuItems = menu.querySelectorAll<HTMLElement>('.menu-item');
export function setMenu(open: boolean) {
  menu.classList.toggle('open', open);
  menuBtn.setAttribute('aria-expanded', String(open));
  menuItems.forEach((b) => (b.tabIndex = open ? 0 : -1));
  if (!open) setViewPick(false);
}
// Views: the Normal / Satellite choice beside the Views button
function setViewPick(open: boolean) {
  menu.classList.toggle('views-open', open);
  viewsBtn.setAttribute('aria-expanded', String(open));
  viewOptions.forEach((b) => (b.tabIndex = open ? 0 : -1));
}
export const eventsBtn = document.getElementById('eventsBtn')!;
export const viewsBtn = document.getElementById('viewsBtn')!;
export const viewOptions = document.querySelectorAll<HTMLButtonElement>('#viewPick button');

/** iOS Safari: the compass has to be asked for, from a tap. */
export type DeviceOrientationAsk = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> };
// Scan's screen with these hooks, once stopvision.ts and the stop positions are loaded (the AR camera, ar.ts, opens it)
let scan: typeof STOPVISION | null = null;
export function openScanWith(hooks: StopVisionHooks, camera: Promise<MediaStream>, orientation: Promise<unknown>, then?: () => void) {
  startPlatforms(); // the stop positions are needed straight away
  const go = () => platformsReady.then(() => scan!.open(hooks, camera, orientation)).then(() => { if (then) then(); });
  if (scan) go();
  else {
    load(import.meta.url, () => import('../stopvision.ts')).then((m) => { scan = m.STOPVISION; }).then(go, (e) => {
      showToast(reloadNote(e, 'to use Scan') || 'Scan could not be loaded.');
      camera.then((st) => st.getTracks().forEach((t) => t.stop()), () => {}); // don't leave the camera on
    });
  }
}
// What Scan (the AR camera's screen) gets from the page
export function scanHooks(): StopVisionHooks {
  return {
    PLATFORMS, badge,
    position: () => (userLngLat ? { ll: userLngLat, acc: userAccuracy, age: fixAge() } : null),
    openStop: (id, i) => {
      const st = PLATFORMS.get(String(id));
      if (!st) return;
      const ll = i != null && st.edges[i] ? st.edges[i].ll : st.edges[0].ll;
      map.flyTo({ center: ll, zoom: Math.max(map.getZoom(), 18) });
      openPlatform({ properties: { id: String(id), i } });
    },
    toast: (t) => showToast(t),
    board: KANTE_BOARD,
    signs: () => indoor.sign,
    onClose: () => menuBtn.focus(),
    // What is about to stop at a place, from the Kante engine (/api/due, kante/docs/LIVE-API.md); null without it
    due: (params) => (KANTE && KANTE.base
      ? KANTE.ready().then((m) => (m && KANTE!.has('due') ? KANTE!.due(params).catch(() => null) : null))
      : Promise.resolve(null)),
    // The next ride of the journey under way, for Scan to say "your bus leaves from this side / across the road".
    // exact: the engine names the platform, and it is that edge of the stop (not only a boarding point nearby).
    route: () => {
      if (!journey.steps || !journey.steps.length) return null;
      const r = journey.steps.find((st) => st.type === 'ride' && (st.t0 || 0) > Date.now() - 60000);
      if (!r || r.type !== 'ride') return null;
      const id = stopUic(r.s.from);
      const pst = PLATFORMS.get(id);
      const e = r.depAt && r.depAt.edge;
      // the stop's edge with the same letter at the engine's boarding point
      let i = -1;
      if (pst && e && e.ll) {
        const k = platformKey(e.ref);
        const near = pst.edges.map((x, n): [number, number] => [distKm(x.ll, e.ll), n])
          .filter(([d, n]) => d < 0.012 && (!k || pst.edges[n].key === k)).sort((x, y) => x[0] - y[0]);
        if (near.length) i = near[0][1];
      }
      const key = platformKey(platformOf(r.s.from)), t = liveMs(r.s.from, 'dep');
      return { uic: id, name: stopName(r.s.from), edge: i >= 0 ? i : null,
               exact: !!pst && i >= 0 && ((!!key && pst.edges[i].key === key) || !!(e && e.ref && platformKey(e.ref) === pst.edges[i].key)),
               line: lineLabel(r.s.line), to: r.s.headsign || undefined,
               time: t != null ? new Date(t).toISOString() : undefined }; // live time
    },
  };
}

/** What this part of the page does when it starts (main.ts calls it, in the order the parts start). */
export function start() {
  menuBtn.addEventListener('click', () => setMenu(!menu.classList.contains('open')));
  // Shows or hides everything switched on under "Events and places" in Settings
  eventsBtn.addEventListener('click', () => {
    setEventsOn(!eventsOn);
    setMenu(false);
    menuBtn.focus();
    if (!eventsOn) return;
    if (journey.dest) { showToast('Events and places come back when you end the journey.'); return; }
    const groups = SETTINGS.mapGroups();
    const wantPlaces = groups.some((k) => k !== 'events');
    if (!groups.length) showToast('Nothing is switched on under “Events and places” in Settings.');
    else if (!wantPlaces && !visibleEvents().length) showToast('No events match your settings.');
    else if (map.getZoom() < (groups.includes('events') ? EVENT_MIN_ZOOM : PLACE_MIN_ZOOM)) showToast('Zoom into a town or neighbourhood to see events and places.');
    else if (wantPlaces && !viewNearBern()) {
      // toilets are mapped everywhere, the other groups only for Bern
      const others = groups.some((k) => k !== 'events' && k !== 'toilets');
      if (!groups.includes('toilets')) showToast('Places other than toilets are only mapped for Bern so far.');
      else if (others) showToast('Outside Bern, only toilets in Switzerland are mapped so far.');
    }
  });
  document.getElementById('settingsBtn')!.addEventListener('click', () => {
    setMenu(false);
    SETTINGS.open();
  });
  SETTINGS.onChange(() => { updateCards(); updatePlaces(); vehUpdate(); });
  // Accessibility options changed during a journey → plan it again with them
  SETTINGS.onClose((journeyChanged) => {
    if (journey.conn) renderFoot();
    if (journeyChanged && journey.dest) startJourney(journey.dest, true);
    else menuBtn.focus();
  });
  // Views: Normal (the plain map) or Satellite (aerial photos with roads and names)
  viewsBtn.addEventListener('click', () => {
    const open = !menu.classList.contains('views-open');
    setViewPick(open);
    if (open) viewOptions[0].focus();
  });
  viewOptions.forEach((b) => b.addEventListener('click', () => {
    setMenu(false);
    menuBtn.focus();
    setMapView(b.dataset.view as MapView).catch(() => showToast('The satellite view could not be loaded.'));
  }));
}
