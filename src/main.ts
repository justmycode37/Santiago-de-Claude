// The page's script: index.html loads it as a module, after the plain scripts above it (translate.js, maplibre,
// the event data, config.js, the station index), which it uses through window.
//
// 1. The modules beside the page's own, in the order they have always run. Each does its work as it loads (the
//    settings page builds itself, the introduction opens on a first visit…), so the order matters: each of them
//    imports only modules above it, or modules that do nothing as they load (toast.ts, theme.ts, map-style.ts).
import './events.ts';
import './map-layers.ts';
import './pricing-history.ts';
import './settings.ts';
import './walk-pace.ts';
import './onboarding.ts';
import './engine.ts';
import './engine-departures.ts';
import './engine-journey.ts';
import './live.ts';
import './arcore.ts';
import './places.ts';
import './station3d.ts';
// 2. The parts of the page (src/app/). They import from each other what they use, both ways, so they load in the
//    order their imports ask for, not in a fixed one. That is why none of them does anything as it loads beyond
//    making its own elements and objects: what each does when the page starts (listeners, the first requests) is
//    in its start(), called below one after the other in the order the page has always started them. The map
//    comes first: map.ts imports nothing of the page and makes the map as it loads.
import './app/map.ts';
import * as mapEvents from './app/map-events.ts';
import * as menu from './app/menu.ts';
import * as location from './app/location.ts';
import * as searchPins from './app/search-pins.ts';
import * as tripEnds from './app/trip-ends.ts';
import * as pins from './app/pins.ts';
import * as categories from './app/categories.ts';
import * as platforms from './app/platforms.ts';
import * as mapPlaces from './app/map-places.ts';
import * as sprites from './app/sprites.ts';
import * as liveEngine from './app/live-engine.ts';
import * as liveVehicles from './app/live-vehicles.ts';
import * as sheet from './app/sheet.ts';
import * as sheetContent from './app/sheet-content.ts';
import * as pill from './app/pill.ts';
import * as timePicker from './app/time-picker.ts';
import * as eventPage from './app/event-page.ts';
import * as keyboard from './app/keyboard.ts';
import { map } from './app/map.ts';
import { showDestinationJourney } from './app/trip-ends.ts';

declare global {
  interface Window {
    /** The map, and a journey to a place: for the screen recordings (demo/pitch-video/capture/), which call them. */
    map: maplibregl.Map;
    showDestinationJourney: typeof showDestinationJourney;
  }
}
window.map = map;
window.showDestinationJourney = showDestinationJourney;

mapEvents.start();
menu.start();
location.start();
searchPins.start();
tripEnds.start();
pins.start();
categories.start();
platforms.start();
mapPlaces.start();
sprites.start();
liveEngine.start();
liveVehicles.start();
sheet.start();
sheetContent.start();
pill.start();
timePicker.start();
eventPage.start();
keyboard.start();
