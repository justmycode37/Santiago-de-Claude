// config.js: the site's own settings (optional and not committed; config.example.js says what goes in it).

interface AppConfig {
  /** A Google Maps Platform key: switches the place search (places.ts) from OpenStreetMap to Google Places. */
  googlePlacesKey?: string;
  /** 'full' (left out): the Places API within its free caps (places.ts). 'embed': never the Places API, only Google's
   *  own card of a place (Maps Embed API, free); the search and the list use OpenStreetMap. */
  googlePlacesMode?: 'full' | 'embed';
  /** Lower daily limits per SKU on each device than places.ts's DAILY ({ details: 10 }). */
  googleDailyLimits?: Partial<Record<'autocomplete' | 'search' | 'details' | 'resolve' | 'photo', number>>;
  /** Address of the Kante engine (engine.ts, live.ts). Left out: the hosted engine. '': no engine. */
  kanteUrl?: string;
  /** Where the AR camera's "Save last 10 s" sends its capture (tools/ar-test.mts sets it); left out: shared or downloaded. */
  arCaptureUrl?: string;
  /** An opentransportdata.swiss key for the Train Formation Service, for a test on your own machine: the 3D view then
   *  asks the service itself for a train's coaches instead of the engine (train-formation.ts). Never on a public site. */
  formationKey?: string;
}

/** Undefined when the site has no config.js. */
declare var APP_CONFIG: AppConfig | undefined;
