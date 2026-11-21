// What index.html itself gives the scripts: the things its first <script> starts before anything else has
// loaded, and version.js.

/** Location fixes that came in before the page's script was ready wait here (the first <script> in index.html). */
interface EarlyGeo {
  fixes: GeolocationPosition[];
  errors: GeolocationPositionError[];
  on: { onFix(position: GeolocationPosition): void; onError(error: GeolocationPositionError): void } | null;
  /** Hand over every fix and error so far, and all that follow. */
  attach(onFix: (position: GeolocationPosition) => void, onError: (error: GeolocationPositionError) => void): void;
}
declare var EARLY_GEO: EarlyGeo;
/** The light base map style, fetched since the <head>. Rejects when it could not be loaded. */
declare var EARLY_STYLE: Promise<maplibregl.StyleSpecification> | undefined;

/** version.js, written when the site is published: the commit it was built from. Not there in local builds. */
declare var BUILD: { commit: string; committed: string; repo: string } | undefined;

/** CommonJS `module`, when a script is loaded by Node for a test (never in the browser). */
declare var module: { exports: unknown } | undefined;
