// config.js: the site's own settings (optional and not committed; config.example.js says what goes in it).

interface AppConfig {
  /** A Google Maps Platform key: switches the place search (places.ts) from OpenStreetMap to Google Places. */
  googlePlacesKey?: string;
  /** Address of the Kante engine (engine.ts, live.ts). Left out: the hosted engine. '': no engine. */
  kanteUrl?: string;
}

/** Undefined when the site has no config.js. */
declare var APP_CONFIG: AppConfig | undefined;
