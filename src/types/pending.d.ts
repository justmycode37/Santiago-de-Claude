// Globals that have no real type yet. Whoever types the script that makes one moves its declaration into
// that script's own file in src/types/ with the real type, and deletes the line here.

declare var SETTINGS: any;        // src/settings.ts
declare var EVENTS: any;          // src/events.ts
declare var MAP_LAYERS: any;      // src/map-layers.ts
declare var PlaceSearch: any;     // src/places.ts
declare var APP_LANG: any;        // src/translate.ts
declare var KANTE: any;           // src/engine.ts
declare var KANTE_LIVE: any;      // src/live.ts
declare var KANTE_BOARD: any;     // src/engine-departures.ts
declare var KanteJourney: any;    // src/engine-journey.ts
declare var StationRoute: any;    // src/station-route.ts (loaded on demand: may be undefined)
declare var Station3D: any;       // src/station3d.ts
declare var Station3DDetail: any; // src/station3d-detail.ts (loaded on demand)
declare var STATION3D_DETAIL: any;        // stations3d/<key>.detail.js
declare var STATION3D_DETAIL_INDEX: any;  // stations3d/detail-index.js
declare var STOPVISION: any;      // src/stopvision.ts (loaded on demand)
declare var STOP_IMAGES_TILE: any;  // src/stopvision.ts
declare var STOP_IMAGES_INDEX: any; // stop-images/index.js
declare var APP_CONFIG: any;      // config.js (optional)
declare var PLATFORM_DATA: any;   // platforms.js (loaded on demand)
declare var MAP_PLACES: any;      // map-places.js (loaded on demand)
declare var BERN_EVENTS: any;     // bern-events.js
declare var SWISS_WORKSHOPS: any; // swiss-workshops.js
declare var SWISS_EVENT_SERIES: any;
declare var COMMUNITY_PROGRAMMES: any; // community-programmes.js
declare var EARLY_GEO: any;       // the first <script> in index.html
declare var EARLY_STYLE: any;
declare var BUILD: any;           // version.js, written when the site is published
declare var Tesseract: any;       // tesseract.js, loaded by stopvision.ts
declare var ort: any;             // onnxruntime-web, loaded by stopvision.ts
/** CommonJS `module`, when a script is loaded by Node for a test (never in the browser). */
declare var module: { exports: unknown } | undefined;
