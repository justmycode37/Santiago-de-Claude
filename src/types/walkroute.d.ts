// The pedestrian network router (walkroute.js, data in walkgraph/; docs/walking-routes.md) and what the journey
// keeps of it: what each end of a walk is, and the walk it routes.

/** What an end of a walk is, for the walking router. */
interface WalkEnd {
  /** Your position (GPS): its accuracy sets how far the walk may start from a path. */
  gps?: boolean;
  /** A platform or stop edge, on its floor (0: street level), boarded by its number ("7", "C"). */
  platform?: boolean;
  level?: number | null;
  ref?: string | null;
  /** A point taken as it is (where a station model's own paths begin), not the building around it. */
  exact?: boolean;
}
/** The options of WALKROUTE.route(): settings, and what each end is (with GPS accuracy in metres). */
interface WalkRouteOptions {
  stepFree?: boolean;
  fewerStairs?: boolean;
  noEscalators?: boolean;
  from?: WalkEnd & { accuracy?: number | null; wide?: boolean };
  to?: WalkEnd & { wide?: boolean };
}
/** A moment of a walk worth a word ("Stairs down to level −2", "Under the arcades of Kramgasse"). */
interface WalkCue { at: LngLat; kind: string; text: string; m: number; /** A floor change: the floor it starts on, when known. */ from?: number }
/** A walk on the pedestrian network. */
interface WalkRouteResult {
  net: true;
  coords: LngLat[];
  /** Metres. */
  dist: number;
  /** The way leading to each point's level tag (null where the floor is not stated). */
  levels: (string | null)[];
  /** Coordinate indices: the straight bit from the start to the first path (0…approxTo) and from the last path to the end
   *  (approxFrom…), when they are long guesses across open ground; approx: no path at all. */
  approxTo: number | null;
  approxFrom: number | null;
  approx?: boolean;
  /** Stretches under arcades, through passages and underpasses, indoors. */
  covered: { kind: string; coords: LngLat[] }[];
  /** The door the walk ends at, and the one it starts from. */
  door: { ll: LngLat; type: string; addr: string } | null;
  startDoor: { ll: LngLat; type: string } | null;
  cues: WalkCue[];
  /** "under the arcades of Kramgasse · main entrance". */
  via: string;
  /** Metres on paths only swisstopo's map has (swissTLM3D). */
  swisstopo: number;
  /** Step-free: the building has doors, but none is step-free (the walk ends at its wall, approximately). */
  noStepFreeDoor?: boolean;
}
interface WalkRouteApi {
  route(a: LngLat, b: LngLat, opt?: WalkRouteOptions): Promise<WalkRouteResult | null>;
  covers(ll: LngLat): Promise<boolean>;
  configure(o: { loader?: (key: string) => Promise<unknown>; base?: string; index?: unknown }): void;
}
declare var WALKROUTE: WalkRouteApi | undefined;
interface Window { WALKROUTE?: WalkRouteApi }

/** A routed walk (routeWalk()) may come from the pedestrian network: then it has these too. */
interface RoutedWalk {
  net?: boolean;
  /** A straight line, not a route (no router found a way). */
  approx?: boolean;
  approxTo?: number | null;
  approxFrom?: number | null;
  covered?: { kind: string; coords: LngLat[] }[];
  door?: { ll: LngLat; type: string; addr: string } | null;
  cues?: WalkCue[];
  via?: string;
  swisstopo?: number;
  floors?: KanteFloorChange[];
}

/** A walk or change: what its ends are, the revision of its route, the lines its last answer drew (a walk moved
 *  since has new ones), and for the walk to the destination the place it leads to. */
interface JourneyFootStep {
  ends?: [WalkEnd, WalkEnd][];
  walkRev?: number;
  _netFor?: LngLat[][];
  /** …and the ends and platforms it was routed for (walkSig()). */
  _netSig?: string;
  toLL?: LngLat;
}

/** A trip walked all the way: the network metres its times were set by (retimeWalkConn()). */
interface OdConnection { _netMetres?: number }
