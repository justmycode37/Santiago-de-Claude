// The page's script (index.html loads it as a module, after the scripts and data above it).
//
// The parts of the page (src/app/) import from each other what they use, so they come in the order their imports
// ask for, not in a fixed one, and they import each other both ways. That is why no part does anything as it is
// loaded beyond making its own elements and objects: what each does when the page starts (listeners, the first
// requests) is in its start(), and here they are called one after the other, in the order the page has always
// started them. The map comes first: map.ts imports nothing of the page and makes the map as it loads.
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
import { STYLES, STYLE_URL, makeDarkStyle, map } from './app/map.ts';
import { setTheme } from './app/map-events.ts';
import { showToast } from './app/menu.ts';
import { showDestinationJourney } from './app/trip-ends.ts';

declare global {
  interface Window {
    /** The map, and a journey to a place: for the screen recordings (demo/pitch-video/capture/). */
    map: maplibregl.Map;
    showDestinationJourney: typeof showDestinationJourney;
    /** A message at the bottom of the screen: for the scripts outside this one (settings.js, the 3D view's loader). */
    showToast: typeof showToast;
  }
  // for the scripts outside this one that use them (onboarding.js: the map's style; settings.js: the theme)
  var STYLES: typeof import('./app/map.ts').STYLES;
  var STYLE_URL: string;
  var makeDarkStyle: typeof import('./app/map.ts').makeDarkStyle;
  var setTheme: typeof import('./app/map-events.ts').setTheme;
}

window.map = map;
window.showDestinationJourney = showDestinationJourney;
window.showToast = showToast;
Object.assign(window, { STYLES, STYLE_URL, makeDarkStyle, setTheme });

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
