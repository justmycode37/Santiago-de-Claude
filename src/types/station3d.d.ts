// The 3D station viewer (src/station3d.ts → window.Station3D): what the page script and the development page call.
// The model it shows is in station-model.d.ts, the route it draws in station-route.d.ts.

/** An end of the route as `open()` takes it: an endpoint of the router, which may carry the name to show for it. */
type Station3DEndpoint = StationRouteEndpoint & { label?: string };

/** `Station3D.open(options)`. Numbers may also come as strings (the development page reads them from the URL). */
interface Station3DOpenOptions {
  /** The model: a key of STATION3D_INDEX (see `Station3D.has`). */
  key: string;
  /** Both ends: the route. One end: that place, shown and framed. None: explore. */
  from?: Station3DEndpoint | null;
  to?: Station3DEndpoint | null;
  prefs?: StationRoutePrefs | null;
  title?: string;
  /** The day closures and notices are judged for (default: `prefs.date`, then today). */
  date?: StationRouteDate;
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
  povAt?: number | string | null;
  povYaw?: number | string;
  povPitch?: number | string;
  /** The walk plays by itself in the first-person view (with prefers-reduced-motion it waits at the first step for the Play button). */
  play?: boolean | Station3DPlayOptions | null;
  /** The element that gets the focus back on close (default: the one that has it now). */
  returnFocus?: HTMLElement | null;
  /** false: leave the rest of the page usable (development page). */
  modal?: boolean;
  /** Where the view is put (default: document.body). */
  mount?: HTMLElement | null;
  /** A tap anywhere on the model is a 'pick', not only on something with a name. */
  pickAnywhere?: boolean;
  /** The end of the walk in the first-person view: over the last metres the head turns to `look` (model metres x, y),
      the walk brakes gently, and the view comes to rest looking there. Without it: facing the way of the last piece. */
  arrive?: { look?: [x: number, y: number] | null } | null;
  /** 'demo': only the picture, the instruction card (at the top) and the signs: no title bar, close button, sheet,
      mini-map or rail; with `pov` it opens at eye level straight away (no flight down from the model). */
  chrome?: 'demo' | null;
}

/** `Station3D.play(options)` and `open({ play })`. */
interface Station3DPlayOptions {
  /** A multiplier of walking pace (default 1.5). */
  speed?: number | string;
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
}

type Station3DErrorCode = 'nowebgl' | 'model' | 'three' | 'css' | 'broken' | 'lost';
/** What `Station3D.on(name, fn)` hands to fn. */
interface Station3DEventMap {
  open: { key: string; route: StationRouteResult | null; focus: { which: 'from' | 'to'; why: StationRouteWhy | 'no-router' | null } | null };
  close: undefined;
  /** The Done button. */
  done: { route: StationRouteResult | null };
  /** index −1, step null: the overview. */
  step: { index: number; step: StationRouteStep | null };
  pick: Station3DPick;
  follow: boolean;
  pov: boolean;
  /** Once per open, when the walk reaches the destination. */
  arrived: { by: Station3DArrivedBy };
  /** Metres walked in the first-person view, a few times a second; step = the index of the step it is in. */
  progress: { along: number; total: number; step: number };
  /** The walk started or stopped playing by itself. */
  play: boolean;
  /** A detail scene (stations3d/DETAIL.md) was built and is showing; id = its key in STATION3D_DETAIL. */
  detail: { id: string };
  error: { code: Station3DErrorCode; message: string };
}
/** What brought the walk to the destination: it played by itself, the scrubber (or the keys), a step that was chosen, the live position. */
type Station3DArrivedBy = 'play' | 'scrub' | 'step' | 'position';
/** Something of the model that was tapped. */
interface Station3DPick {
  title: string;
  level: number;
  xy: XY;
  ll: LngLat;
  stop: StationStop | null;
  area: Partial<StationArea> | null;
  /** The place as an end of a route (for `open({ from, to })`). */
  endpoint: StationRouteEndpoint;
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
  /** The walk plays by itself. → is it walking now? */
  play(o?: Station3DPlayOptions | null): boolean;
  pause(): void;
  isPlaying(): boolean;
  /** How far the floors are apart, 0..1. */
  setPeel(v: number): void;
  /** Loads the styles, three.js, the router and (with a key) the model ahead of an open. → did everything load? */
  preload(key?: string | null): Promise<boolean>;
  /** Just the model and the router (no three.js): for drawing a station walk on the 2D map. */
  loadData(key: string): Promise<StationModel | null>;
  /** The handle of the detail scene that is built now (`Station3DDetail.build`), or null. */
  detail(): Station3DDetailHandle | null;
  /** Draw again (after something was added to the detail scene from outside). */
  redraw(): void;
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
