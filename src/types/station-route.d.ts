// The indoor router (src/station-route.ts): what window.StationRoute gives to the viewer and the page script.
// The header comment of station-route.ts says what everything means; stations3d/SCHEMA.md ("Router") has the summary.

/** A position in a model's local frame. A third number (the level, as in route.points) is allowed and ignored. */
type StationRouteXY = XY | XYL;
/** The day closures are evaluated for: "YYYY-MM-DD" or a Date. Anything else means today (local). */
type StationRouteDate = string | Date;

/** The stop of a `{ stop }` endpoint: a stop id and / or a platform name ("7", "7A-D", "Kante H"). */
interface StationRouteStopRef {
  uic?: string | number | null;
  /** Compared by platformKey; sectors in it ("7A-D", "7 B") are aimed at. */
  ref?: string | number | null;
  /** "B" or "A-D": aim at these sectors of the platform instead of the whole platform. */
  sector?: string | null;
}
/** What the router reads of a stop besides station-model.d.ts's fields (stations3d/SCHEMA.md, `stops`). */
interface StationStop {
  /** On a stop without a ref: where the timetable data (platforms.js) has this stop edge. */
  at?: XY;
}
/**
 * Where a route starts or ends. A `{ stop }` may also carry a position (xy / ll, level), used when the model has no
 * such stop. `level` is optional on a position: without it, outdoor street level is preferred. A position within 3 m
 * of where the timetable data has a stop without a ref (`stops[].at`) is that stop, on the level the model has it on.
 */
type StationRouteEndpoint =
  | { stop: StationRouteStopRef; xy?: StationRouteXY; ll?: LngLat; level?: number | null; node?: undefined; entrance?: undefined }
  | { node: number; stop?: undefined; entrance?: undefined; xy?: undefined; ll?: undefined; level?: undefined }
  | { entrance: string; stop?: undefined; node?: undefined; xy?: undefined; ll?: undefined; level?: undefined }
  | { xy: StationRouteXY; level?: number | null; stop?: undefined; node?: undefined; entrance?: undefined; ll?: undefined }
  | { ll: LngLat; level?: number | null; stop?: undefined; node?: undefined; entrance?: undefined; xy?: undefined };

/** The journey settings the router reads. The stricter ones imply the others (wheelchair → stepFree → the rest). */
interface StationRoutePrefs {
  stepFree?: boolean;
  fewerStairs?: boolean;
  noEscalators?: boolean;
  wheelchair?: boolean;
  /** Default 4.7. */
  walkKmh?: number;
  /** Default today. */
  date?: StationRouteDate | null;
}

type StationRouteStepKind = StationEdgeKind | 'arrive';
type StationRouteTurn = 'left' | 'right' | 'bear-left' | 'bear-right' | 'straight' | 'around';
/** A level change without the walk: what `via` and the closure sentences name. */
type StationRouteConnectorKind = Exclude<StationEdgeKind, 'walk'>;

interface StationRouteStep {
  kind: StationRouteStepKind;
  /** Indices into route.points: the step covers points[from] … points[to]. */
  from: number;
  to: number;
  level: number;
  toLevel: number;
  dir: 'up' | 'down' | null;
  /** Metres, rounded. */
  len: number;
  seconds: number;
  text: string;
  /** When the path bends where this step starts. */
  turn?: StationRouteTurn;
  /** What a walk goes through or along, or where a level change arrives ("platform 7", "the underpass"). */
  place?: string;
  /** This step breaks a preference (see route.relaxed). */
  warn?: true;
  /** On the arrive step: the sectors aimed at, "B" or "A–D". */
  sector?: string;
}

/** A preference the route could not keep. */
type StationRouteRelaxed = 'wheelchair' | 'stepFree' | 'noEscalators';

/** A closure that matters for a route: a closed endpoint, one the route goes around, or the one that cuts it off. */
interface StationRouteClosure {
  what: 'stop' | 'entrance' | 'edge' | 'connector' | 'area';
  /** Of an edge or a connector: its kind; of an area: the area's kind. */
  kind?: StationEdgeKind | StationArea['kind'];
  name?: string;
  /** Of a stop: its ref; of an area: its platform refs joined with "/". */
  ref?: string;
  /** Of a stop. */
  uic?: string;
  mode?: StationMode;
  note?: string;
  from?: string;
  until?: string;
}

/** Where on a whole platform a route was taken to start or end. */
interface StationRouteAssumed {
  /** The sector there (its span of platform, else the nearest sign). */
  sector?: string;
  xy: XY;
  /** "from the stairs at sector B", "to the lift", "from sector A". */
  text: string;
}

/** The part of a route that snap() and pointAt() read. */
interface StationRoutePath {
  points: XYL[];
  dists?: number[];
  steps?: StationRouteStep[];
}

interface StationRouteResult {
  /** The whole path. Two equal points when `same`. */
  points: XYL[];
  /** Graph nodes along it. */
  nodes: number[];
  /** Metres. */
  length: number;
  seconds: number;
  /** Consecutive, covering all points; the last one is the arrive step. */
  steps: StationRouteStep[];
  /** Metres from the start at each point (stairs and ramps along the slope, lifts 0). */
  dists: number[];
  /** Graph edge index for each piece points[i] → points[i + 1] (-1 for none). */
  edges: number[];
  /** Metres between the position asked for and the route's first / last point (0 for stops, nodes, entrances). */
  fromDist: number;
  toDist: number;
  /** Start and end are the same place. */
  same?: true;
  /** Set only when no route meets the preferences: the ones this route breaks. */
  relaxed?: StationRouteRelaxed[];
  closed?: StationRouteClosure[];
  /** The destination can only be reached through something closed: the route ends as near as it can (see toDist). */
  incomplete?: true;
  /** The start is shut in by a closure: the route takes the way out through it. */
  throughClosed?: true;
  fromAssumed?: StationRouteAssumed;
  toAssumed?: StationRouteAssumed;
  /** One or two sentences for the user when relaxed / closed is set. */
  notice?: string;
  /** The model.stops entry chosen for a `{ stop }` endpoint. */
  fromStop?: StationStop;
  toStop?: StationStop;
  /** When the endpoint's ref names sectors ("7A-D", "7 B"). */
  fromSectors?: string[];
  toSectors?: string[];
}

/** The nearest position on a route to a position fix. */
interface StationRouteSnap {
  /** The piece points[index] → points[index + 1] … */
  index: number;
  /** … and where on it, 0..1. */
  t: number;
  point: XYL;
  /** Horizontal metres from the fix. */
  dist: number;
  /** Metres of route before / after the position. */
  along: number;
  remaining: number;
  /** Index into route.steps. */
  step: number;
  /** The furthest along reached so far. (Missing on a route of one point.) */
  progress?: number;
}
/**
 * The hint for snap(), when it is not just the level number: the previous snap() result (or at least its `along`),
 * which keeps the position continuous, and / or the level the user is known to be on.
 */
interface StationRouteSnapHint {
  along?: number;
  index?: number;
  t?: number;
  progress?: number;
  level?: number;
}

interface StationRouteSectorTime {
  /** The sector's name: "A". */
  name: string;
  seconds: number;
  /** Metres. */
  length: number;
  /** The first level change used. */
  via: StationRouteConnectorKind | null;
  /** The walk from this sector breaks a preference. */
  warn?: true;
}
interface StationRouteSectorTimes {
  /** The name of the sector with the best route for these preferences. */
  best: string;
  sectors: StationRouteSectorTime[];
  /** Slowest − quickest. */
  spreadSeconds: number;
}

/** Why route() gives no (complete) route. 'closed': it gives an incomplete one, or one through a closure. */
type StationRouteWhy = 'unknown-stop' | 'unknown-entrance' | 'unknown-node' | 'unknown-position' | 'not-connected' | 'closed';

/** A place on the graph: a node, or a point on an edge (s = 0..1 from the edge's a to its b). */
type StationRouteGraphPlace = { node: number; edge?: undefined; s?: undefined } | { edge: number; s: number; node?: undefined };
interface StationRouteCandidateInfo {
  point: XYL;
  /** Metres from the position asked for (0 for stops, nodes and entrances). */
  dist: number;
  /** The model's stop, for a `{ stop }` endpoint (or a position that is a stop's `at`), and whether it is closed that day. */
  stop?: StationStop;
  closedStop?: boolean;
  /** One of several nodes along the stop's platform. */
  onPlatform?: boolean;
  entrance?: StationEntrance;
  closedEntrance?: boolean;
  /** The sectors aimed at. */
  sectors?: string[];
}
/** What resolve() gives for an endpoint: every place on the graph it can mean (the route picks the best). */
type StationRouteCandidate = StationRouteGraphPlace & StationRouteCandidateInfo;

/** `closed` as the router reads it: the schema's object, or (old style) true for "closed, no dates". */
type StationRouteClosedValue = StationClosure | boolean | null;

/** StationRoute.TIME: the numbers of the time model (seconds, metres, m/s; see the header of station-route.ts). */
interface StationRouteTime {
  walkKmh: number;
  stairsUpVert: number;
  stairsDownVert: number;
  stairsRun: number;
  escalatorSpeed: number;
  escalatorBoard: number;
  escalatorSlope: number;
  liftWait: number;
  liftPerEdge: number;
  liftSpeed: number;
  levelChange: number;
  stairsUpEffort: number;
  stairsDownEffort: number;
  climbEffort: number;
  turnFrom: number;
  turnMax: number;
  outdoorSwitch: number;
  fewerStairsFactor: number;
  fewerStairsEntry: number;
  steepIncline: number;
  violation: { stairs: number; escalator: number; wheelchair: number; steep: number };
  snapNear: number;
}

interface StationRouteApi {
  toLocal(model: StationModel, ll: LngLat): XY;
  toLngLat(model: StationModel, xy: StationRouteXY): LngLat;
  /** Metres above level 0 for a level number (piecewise linear through model.levels[].z). */
  z(model: StationModel, level: number): number;
  /** null when an endpoint cannot be found, or the two are not connected even ignoring closures (why() says which). */
  route(model: StationModel, from: StationRouteEndpoint | null | undefined, to: StationRouteEndpoint | null | undefined, prefs?: StationRoutePrefs | null): StationRouteResult | null;
  /** `xy`: local, or `{ ll }` for GPS. `hint`: the current level, or the previous result. null for a route without points. */
  snap(model: StationModel, route: StationRoutePath | null | undefined, xy: StationRouteXY | { ll: LngLat }, hint?: number | StationRouteSnapHint | null): StationRouteSnap | null;
  /** The point that many metres along the route (clamped to it). null for a route without points. */
  pointAt(route: StationRoutePath, metres: number): XYL | null;
  /** `from` = a platform stop. null when the platform has no sectors or the destination is not reachable. */
  sectorTimes(model: StationModel, from: StationRouteEndpoint | null | undefined, to: StationRouteEndpoint | null | undefined, prefs?: StationRoutePrefs | null): StationRouteSectorTimes | null;
  /** null: route() gives a complete route. */
  why(model: StationModel, from: StationRouteEndpoint | null | undefined, to: StationRouteEndpoint | null | undefined, prefs?: StationRoutePrefs | null): StationRouteWhy | null;
  /** `thing`: anything with a `closed` field (a stop, an area, a connector, an entrance, an edge), or that field itself. */
  isClosed(thing: { closed?: StationRouteClosedValue } | StationRouteClosedValue | undefined, date?: StationRouteDate | null): boolean;
  /** The model's notices that are active on that date. */
  notices(model: StationModel | null | undefined, date?: StationRouteDate | null): StationNotice[];
  /** Every place on the graph an endpoint can mean on that date (open ones first); empty when it is unknown. */
  resolve(model: StationModel, endpoint: StationRouteEndpoint | null | undefined, date?: StationRouteDate | null): StationRouteCandidate[];
  /** The comparable form of a platform / stop edge name: "Gleis 7" → "7", "7A-D" → "7", "Kante H" → "H". */
  platformKey(ref: string | number | null | undefined): string;
  /** The name of the nearest whole level, as it reads in a sentence: "the underpass", "level −3". */
  levelName(model: StationModel, level: number): string;
  TIME: StationRouteTime;
}

/** Made by station-route.js, which is loaded on demand: check that it is there. */
declare var StationRoute: StationRouteApi | undefined;
