// What index.html itself gives the scripts: the things its first <script> starts before anything else has
// loaded, and version.js.

/** Location fixes that came in before the page's script was ready wait here (the first <script> in index.html). */
interface EarlyGeo {
  fixes: GeolocationPosition[];
  errors: GeolocationPositionError[];
  on: { onFix(position: GeolocationPosition): void; onError(error: GeolocationPositionError): void } | null;
  /** Set once the browser has been asked for the location. */
  started?: boolean;
  /** Set by the introduction as it opens on a first visit: it asks for the location when it ends. */
  held?: boolean;
  /** Asks the browser for the location (once). On a first visit the introduction calls it when it ends (onboarding.ts). */
  start(): void;
  /** Hand over every fix and error so far, and all that follow. */
  attach(onFix: (position: GeolocationPosition) => void, onError: (error: GeolocationPositionError) => void): void;
}
declare var EARLY_GEO: EarlyGeo;
/** The page's script did not load: reloads once if its file is gone because the site was updated (src/inline/updated.ts). */
declare var scriptFailed: (src: string) => void;
/** The light base map style, fetched since the <head>. Rejects when it could not be loaded. */
declare var EARLY_STYLE: Promise<maplibregl.StyleSpecification> | undefined;

/** version.js, written when the site is published: the commit it was built from. Not there in local builds. */
declare var BUILD: { commit: string; committed: string; repo: string } | undefined;

