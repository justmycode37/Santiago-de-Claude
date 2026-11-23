// window.Station3D, the page's way into a station in 3D (the stand-in src/inline/station3d-loader.ts, which hands
// every open() to the station view, station-view.d.ts). The model it shows is in station-model.d.ts, the route it
// draws in station-route.d.ts.

/** An end of the route as `open()` takes it: an endpoint of the router, which may carry the name to show for it. */
type Station3DEndpoint = StationRouteEndpoint & { label?: string };

/** `Station3D.open(options)`. */
interface Station3DOpenOptions {
  /** The model: a key of STATION3D_INDEX (see `Station3D.has`). */
  key: string;
  /** Both ends: the route. One end: that place's floor, framed. None: the whole station. */
  from?: Station3DEndpoint | null;
  to?: Station3DEndpoint | null;
  /** The router's options; `prefs.date` is the day closures and notices are judged for (default: today). */
  prefs?: StationRoutePrefs | null;
  title?: string;
  /** The element that gets the focus back on close (default: the one that has it now). */
  returnFocus?: HTMLElement | null;
}

/** `Station3D.setUser(position)`: the live position. */
interface Station3DUser {
  ll?: LngLat;
  /** Instead of ll: the position in the model's own metres. */
  xy?: XY;
  /** The floor, when it is known. */
  level?: number | null;
  /** Metres. */
  accuracy?: number;
  /** Compass bearing in degrees. */
  heading?: number | null;
  /** What the indoor position thinks of every floor, and of `level` (indoornav.ts): the station view shows it. */
  levelProbs?: Record<string, number>;
  levelProb?: number;
  /** The floor comes from an indoor position that is sure of it (indoornav.ts): it beats the floor of the route snap. */
  levelSure?: boolean;
  /** When the GPS fix was taken (ms since 1970): a remembered fix older than a minute is not shown at the next opening. */
  at?: number;
}

/** 'none': the station has no 3D view (no continuous model in stations3d/solid-index.js). */
type Station3DErrorCode = 'nowebgl' | 'model' | 'three' | 'none';
/** What `Station3D.on(name, fn)` hands to fn. */
interface Station3DEventMap {
  open: { key: string; route: StationRouteResult | null; focus: { which: 'from' | 'to'; why: StationRouteWhy | 'no-router' | null } | null };
  close: undefined;
  /** open() was called: before the model loads, and also when it replaces a station that is showing (which says no 'close'). */
  opening: { key: string; replaces: string | null };
  /** The Done button. */
  done: { route: StationRouteResult | null };
  /** index −1, step null: the overview. */
  step: { index: number; step: StationRouteStep | null };
  error: { code: Station3DErrorCode; message: string };
}

interface Station3DApi {
  /** A stop id → the key of the model that has it. */
  has(uic: string | number): string | null;
  open(opts: Station3DOpenOptions): void;
  setUser(user: Station3DUser | null | undefined): void;
  close(): void;
  /** Also true while an opening is on its way. */
  isOpen(): boolean;
  /** Returns a function that removes the listener again. */
  on<K extends keyof Station3DEventMap>(name: K, fn: (detail: Station3DEventMap[K]) => void): () => void;
  off<K extends keyof Station3DEventMap>(name: K, fn: (detail: Station3DEventMap[K]) => void): void;
  /** Loads the station view, its styles, three.js, the router and the model ahead of an open. → did everything load? */
  preload(key?: string | null): Promise<boolean>;
  /** Just the model and the router (no three.js): for drawing a station walk on the 2D map. */
  loadData(key: string): Promise<StationModel | null>;
}


/** Device Memory API (Chromium): gigabytes of RAM, rounded. */
interface Navigator { readonly deviceMemory?: number }
