// The 3D station viewer (src/station3d.ts → window.Station3D): what the page script and the development page call.
// The model it shows is in station-model.d.ts, the route it draws in station-route.d.ts.

// TEMPORARY, until station-route.d.ts exists: the router's types under placeholder names.
type S3TmpRouter = any;
type S3TmpRoute = any;
type S3TmpStep = any;
type S3TmpEnd = any;
type S3TmpPrefs = any;

/** `Station3D.open(options)`. Numbers may also come as strings (the development page reads them from the URL). */
interface Station3DOpenOptions {
  /** The model: a key of STATION3D_INDEX (see `Station3D.has`). */
  key: string;
  /** Both ends: the route. One end: that place, shown and framed. None: explore. */
  from?: S3TmpEnd | null;
  to?: S3TmpEnd | null;
  prefs?: S3TmpPrefs | null;
  title?: string;
  /** The day closures and notices are judged for (default: `prefs.date`, then today). */
  date?: string | Date;
  /** Detail scenes: bare or leafy trees (default: what the data says). */
  season?: 'winter' | 'summer';
  /** Detail scenes: how fine they are drawn (default: by the device). */
  quality?: 'high' | 'low';
  /** How far the floors are apart when it opens, 0..1. */
  peel?: number | string;
  /** No intro animation. */
  still?: boolean;
  /** Open at this step of the route. */
  step?: number | string;
  /** Open with only this floor (a level id). */
  level?: number | string;
  /** Open with the list of all steps. */
  list?: boolean;
  follow?: boolean;
  /** Open in the first-person view; povAt = metres along the route, povYaw / povPitch = the head, in degrees. */
  pov?: boolean;
  povAt?: number | string;
  povYaw?: number | string;
  povPitch?: number | string;
  /** The element that gets the focus back on close (default: the one that has it now). */
  returnFocus?: HTMLElement | null;
  /** false: leave the rest of the page usable (development page). */
  modal?: boolean;
  /** Where the view is put (default: document.body). */
  mount?: HTMLElement | null;
  /** A tap anywhere on the model is a 'pick', not only on something with a name. */
  pickAnywhere?: boolean;
}

/** `Station3D.setUser(position)`: the live position. */
interface Station3DUser {
  ll: LngLat;
  /** Metres. */
  accuracy?: number;
  /** Compass bearing in degrees. */
  heading?: number | null;
}

type Station3DErrorCode = 'nowebgl' | 'model' | 'three' | 'css' | 'broken' | 'lost';
/** What `Station3D.on(name, fn)` hands to fn. */
interface Station3DEventMap {
  open: { key: string; route: S3TmpRoute | null; focus: { which: 'from' | 'to'; why: string | null } | null };
  close: undefined;
  /** The Done button. */
  done: { route: S3TmpRoute | null };
  /** index −1, step null: the overview. */
  step: { index: number; step: S3TmpStep | null };
  pick: Station3DPick;
  follow: boolean;
  pov: boolean;
  error: { code: Station3DErrorCode; message: string };
}
/** Something of the model that was tapped. */
interface Station3DPick {
  title: string;
  level: number;
  xy: XY;
  ll: LngLat;
  stop: StationStop | null;
  area: Partial<StationArea> | null;
  /** The place as an end of a route (for `open({ from, to })`). */
  endpoint: S3TmpEnd;
}
type Station3DCompass = 'granted' | 'denied' | 'unavailable';

interface Station3DApi {
  /** A stop id → the key of the model that has it. */
  has(uic: string | number): string | null;
  open(opts: Station3DOpenOptions): void;
  setUser(user: Station3DUser | null | undefined): void;
  close(): void;
  isOpen(): boolean;
  /** Returns a function that removes the listener again. */
  on<K extends keyof Station3DEventMap>(name: K, fn: (detail: Station3DEventMap[K]) => void): () => void;
  off<K extends keyof Station3DEventMap>(name: K, fn: (detail: Station3DEventMap[K]) => void): void;
  selectStep(index: number): void;
  setFollow(on: boolean): void;
  enableCompass(): Promise<Station3DCompass>;
  setPov(on: boolean): void;
  /** How far the floors are apart, 0..1. */
  setPeel(v: number): void;
  /** Loads the styles, three.js, the router and (with a key) the model ahead of an open. → did everything load? */
  preload(key?: string | null): Promise<boolean>;
  /** Just the model and the router (no three.js): for drawing a station walk on the 2D map. */
  loadData(key: string): Promise<StationModel | null>;
  /** Development page: a pretend phone compass. */
  _orient(e: Station3DOrientation): void;
  /** Development page and tests: the state of the open viewer. */
  _debug(): Record<string, unknown> | null;
}
/** What the viewer reads of a `deviceorientation` event. */
interface Station3DOrientation {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  absolute?: boolean;
  /** Safari: the compass bearing itself. */
  webkitCompassHeading?: number;
}

declare var Station3D: Station3DApi;

/** Device Memory API (Chromium): gigabytes of RAM, rounded. */
interface Navigator { readonly deviceMemory?: number }
