// config.js: the site's own settings (optional and not committed; config.example.js says what goes in it).

interface AppConfig {
  /** A Google Maps Platform key: switches the place search (places.ts) from OpenStreetMap to Google Places. */
  googlePlacesKey?: string;
  /** Address of the Kante engine (engine.ts, live.ts). Left out: the hosted engine. '': no engine. */
  kanteUrl?: string;
  /** Where the AR camera's "Save last 10 s" sends its capture (tools/ar-test.mts sets it); left out: shared or downloaded. */
  arCaptureUrl?: string;
}

/** Undefined when the site has no config.js. */
declare var APP_CONFIG: AppConfig | undefined;
