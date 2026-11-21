// The indoor position in the 3D station view (indoornav.js, loaded with station3d.js by the stand-in in index.html;
// details in docs/indoor-positioning.md): what the page calls. indoorloc.js and signloc.js are plain scripts in the
// repository root and not called from TypeScript.

/** `INDOORNAV.state()`. */
interface IndoorNavState {
  active: boolean; open: boolean; away: boolean; key: string | null;
  /** Something says the traveller is really there (a recent GPS fix near the station, a sign, "I am here"): only then is a position shown. */
  live: boolean;
  sensors: Record<string, string> | null;
  estimate: { state: string; level?: number; levelProb?: number; sigma?: number; confident?: boolean } | null;
}

interface IndoorNavApi {
  /**
   * GPS from the page, as for `Station3D.setUser`: goes through the indoor filter while a station is open in 3D.
   * `at` (performance.now()) is for a fix handed on later: it is dropped if a newer one is already there.
   */
  setUser(u: Station3DUser | null, at?: number): void;
  /** Text read on a sign (Scan dispatches `scan:text` instead). */
  sign(text: string): unknown;
  /** The traveller says where they are. */
  here(o: { level: number; xy?: XY }): void;
  state(): IndoorNavState;
  /** The viewer opened before indoornav.js had loaded: join the opening that is showing (the stand-in in index.html calls this). */
  attach(opened: Station3DEventMap['open']): void;
}

declare var INDOORNAV: IndoorNavApi | undefined;
/** indoorloc.js and signloc.js, once loaded. The stand-in in index.html only asks whether they are there. */
declare var INDOORLOC: object | undefined;
declare var SIGNLOC: object | undefined;

/** `window.dispatchEvent(new CustomEvent('scan:text', { detail }))`: text Scan read (indoornav.js listens). */
interface ScanTextDetail { text: string; tap?: boolean; at?: number }
