// The in-app 3D station view (src/station-view.ts → station-view.js, docs/station3d-solid.md): the continuous model of
// station3d-solid.js in an overlay, with step-by-step guidance and the indoor position. The page reaches it through
// Station3D (the stand-in in index.html, src/inline/station3d-loader.ts, sends every open() here).

/** The renderer, station3d-solid.js (an ES module): what station-view.ts uses of it. */
interface SolidUserState {
  visible: boolean; outside?: boolean; far?: number; x?: number; y?: number;
  /** null: no floor observed (GPS alone, or the filter not sure enough to say one). */
  level?: number | null; levelProb?: number | null; levelProbs?: Record<string, number> | null; sure?: boolean;
  acc?: number; mode?: 'route' | 'free'; step?: number; offRouteSec?: number; follow: boolean;
}
interface SolidChange { route: StationRouteResult | null; step: number; focusLevel: number | null }
interface SolidLevel { id: number; z: number; name: string }
interface SolidView {
  model: StationModel;
  levels: SolidLevel[];
  readonly route: StationRouteResult | null;
  /** Only a renderer with the indoor position has these. */
  readonly user?: SolidUserState;
  readonly stretch: number;
  plan(from: StationRouteEndpoint | null, to: StationRouteEndpoint | null, prefs?: StationRoutePrefs | null): StationRouteResult | null;
  step(i: number): void;
  whole(): void;
  floor(id: number | null): void;
  next(): void;
  prev(): void;
  setStretch(s: number): void;
  /** true: the whole station; false: only the part the route uses (the default). */
  showAll?(on: boolean): void;
  setUser?(u: (Station3DUser & { levelProbs?: Record<string, number>; levelProb?: number }) | null): void;
  follow?(on: boolean): void;
  locate?(): void;
  reset(): void;
  dispose(): void;
  _debug(): Record<string, unknown>;
}
interface SolidOpenOptions {
  mount: HTMLElement; key: string;
  from?: StationRouteEndpoint | null; to?: StationRouteEndpoint | null; prefs?: StationRoutePrefs | null;
  /** Names for the two ends of the route, where the router has none ("Platform 7" it knows). */
  fromLabel?: string; toLabel?: string;
  onChange?(c: SolidChange): void;
  onUser?(u: SolidUserState): void;
}
interface SolidModule { open(o: SolidOpenOptions): Promise<SolidView> }

interface StationViewApi {
  /** Is there a continuous model for this station key? (after `ready()`; false before) */
  has(key: string): boolean;
  /** Loads the list of stations with a continuous model (stations3d/solid-index.js). */
  ready(): Promise<void>;
  open(opts: Station3DOpenOptions): void;
  close(): void;
  isOpen(): boolean;
  setUser(user: Station3DUser | null | undefined): void;
  on<K extends keyof Station3DEventMap>(name: K, fn: (detail: Station3DEventMap[K]) => void): () => void;
  off<K extends keyof Station3DEventMap>(name: K, fn: (detail: Station3DEventMap[K]) => void): void;
  /** The model, its continuous companion, the router, the styles and three.js, ahead of an open. */
  preload(key: string): Promise<boolean>;
  /** Tests: the open view. */
  _view(): SolidView | null;
}

declare var StationView: StationViewApi | undefined;
/** stations3d/<key>.solid.js */
declare var STATION3D_SOLID: Record<string, unknown> | undefined;
