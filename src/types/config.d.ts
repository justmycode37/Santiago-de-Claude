// config.js: the site's own settings (optional and not committed; config.example.js says what goes in it).

interface AppConfig {
  /** A Google Maps Platform key: switches the place search (places.ts) from OpenStreetMap to Google Places. */
  googlePlacesKey?: string;
  /** Address of the Kante engine (engine.ts, live.ts). Left out: the hosted engine. '': no engine. */
  kanteUrl?: string;
  /** An opentransportdata.swiss key for the Train Formation Service, for a test on your own machine: the 3D view then
   *  asks the service itself for a train's coaches instead of the engine (train-formation.ts). Never on a public site. */
  formationKey?: string;
}

/** Undefined when the site has no config.js. */
declare var APP_CONFIG: AppConfig | undefined;
