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

// ---- the network's files: walkgraph/index.js and walkgraph/t/<key>.js (tools/build_walkgraph.py) ----

/** walkgraph/index.js: the size of a tile in degrees, and the tiles there are, by key ("<lat cell>_<lon cell>"). */
interface WalkGraphIndex { tile: number; built?: string; tiles: Record<string, 1> }
/** What a way is to walk on: footway, sidewalk, crossing, platform, corridor, a straight line across an area, road,
 *  cycleway, main road without a sidewalk, road whose sidewalks are drawn separately, steps, escalator, lift. */
type WalkGraphKind = 'fw' | 'sw' | 'cr' | 'pl' | 'co' | 'ar' | 'rd' | 'cy' | 'mr' | 'sep' | 'st' | 'es' | 'el';
/** What a way runs under: an arcade, a passage through a building, a tunnel or underpass, indoors, a roof. */
type WalkGraphCover = 'a' | 'p' | 't' | 'i' | 'c';
/** The attributes of a way (the ways of a tile share them). */
interface WalkGraphAttr {
  k: WalkGraphKind;
  c?: WalkGraphCover;
  /** Its level tag: "0", "-1;0", "0-2". */
  l?: string;
  /** A bridge or tunnel whose floor is not stated: its layer (not on the ground). */
  y?: number;
  n?: string;
  /** A platform: the tracks or bays it serves ("3;4"). */
  r?: string;
  /** Incline, in the direction the way is drawn: up or down. */
  i?: 'u' | 'd';
  /** An escalator runs one way only: forward or backward along the way. */
  d?: 'f' | 'b';
  /** wheelchair=no (and steps without a wheelchair ramp). */
  w?: 1;
  /** 't': a path only swisstopo's map (swissTLM3D) has. */
  s?: 't';
}
/** A tile, as its file hands it to WALKGRAPH_TILE(key, tile). Coordinates are integers in 1e-6° from `o`. */
interface WalkGraphTile {
  o: [lonE6: number, latE6: number];
  /** Nodes: id, x, y, id, x, y, … each value the difference from the node before. */
  n: number[];
  a: WalkGraphAttr[];
  /** Ways: after the id (swisstopo's are strings) and the attribute index, node indices into `n`. */
  w: [id: number | string, attr: number, ...nodes: number[]][];
  /** Straight lines across pedestrian areas. */
  v: [from: number, to: number, attr: number][];
  /** Building outlines: id, x0, y0, then dx, dy, … */
  b: number[][];
  /** Entrances (building 0: on no building; wheelchair: "", "yes", "no", "limited"). */
  e: [node: number, building: number, type: string, wheelchair: string, addr: string][];
  /** Node indices: gates you cannot pass, raised kerbs, lifts. */
  x: number[];
  r: number[];
  l: number[];
  /** Railway tracks on the ground: x0, y0, x1, y1, … */
  z?: number[][];
}
/** Reads the network's files where there is no page to load them as scripts (Node): 'index', or a tile by its key. */
interface WalkGraphLoader {
  (key: 'index'): Promise<WalkGraphIndex | null | undefined>;
  (key: string): Promise<WalkGraphTile>;
}
declare var WALKGRAPH_INDEX: WalkGraphIndex | undefined;
declare var WALKGRAPH_TILE: ((key: string, data: WalkGraphTile) => void) | undefined;

// ---- the network in memory, built from the tiles loaded so far (seen from outside through WALKROUTE._debug) ----

/** A way's attributes with its level tag read: the floors it is on (null: not stated). */
interface WalkNetAttr extends WalkGraphAttr { lv: number[] | null }
interface WalkNetNode { id: number; ll: LngLat; adj: WalkNetEdge[]; blocked?: boolean; kerb?: boolean; lift?: boolean }
/** A stretch of path between two nodes, `len` metres long. */
interface WalkNetEdge { a: WalkNetNode; b: WalkNetNode; attr: WalkNetAttr; len: number }
interface WalkNetBuilding { id: number; ring: LngLat[]; bb: [w: number, s: number, e: number, n: number]; entrances: WalkNetEntrance[] }
interface WalkNetEntrance { node: WalkNetNode; bld: number; type: string; wc: string; addr: string }
/** An end of a walk as the search takes it: what it is, and how it may be joined to the network. */
interface WalkNetEnd extends WalkEnd {
  accuracy?: number | null;
  /** Metres within which the paths are looked for (from the GPS accuracy). */
  radius?: number;
  /** A platform: any path near it, not only its own. */
  wide?: boolean;
  /** A platform: only the paths of its own track or bay. */
  onlyOwn?: boolean;
  /** Not onto a path only swisstopo's map has. */
  osmOnly?: boolean;
  /** Not onto a piece of network that is joined to nothing else. */
  noIslands?: boolean;
  stepFree?: boolean;
}
/** A way into (or out of) the network at an end of a walk: at a node (a door standing on a path), or at a point on a
 *  stretch of path (t: 0…1 along it) reached by a straight line of d metres (cuts: through a building). */
type WalkNetAccess = (
  | { n: WalkNetNode; e?: undefined; t?: undefined; q?: undefined; d?: undefined; cuts?: undefined }
  | { n?: undefined; e: WalkNetEdge; t: number; q: LngLat; d: number; cuts: boolean }
) & {
  cost: number;
  door: WalkNetEntrance | null;
  /** Where the straight line (or the path, at a door) starts. */
  from: LngLat;
  /** Through the wall of a building without a door there: a guess. */
  guess?: boolean;
  /** A stop position given on the track itself: the walk starts or ends on the platform beside it. */
  onTrack?: boolean;
  noStepFreeDoor?: boolean;
};
interface WalkRouteDebug {
  nodes: Map<number, WalkNetNode>;
  buildings: Map<number, WalkNetBuilding>;
  entrances: Map<number, WalkNetEntrance>;
  /** Keys of the tiles in the network. */
  inGraph: Set<string>;
  endpoint(p: LngLat, o: WalkNetEnd): WalkNetAccess[];
  buildingsAt(p: LngLat, rM: number): WalkNetBuilding[];
  cutsBuilding(p: LngLat, q: LngLat, allow: Set<WalkNetBuilding>): boolean;
  search(a: LngLat, b: LngLat, opt: WalkRouteOptions): WalkRouteResult | null;
  distM(a: LngLat, b: LngLat): number;
}

interface WalkRouteApi {
  route(a: LngLat, b: LngLat, opt?: WalkRouteOptions): Promise<WalkRouteResult | null>;
  covers(ll: LngLat): Promise<boolean>;
  configure(o: { loader?: WalkGraphLoader; base?: string; index?: WalkGraphIndex }): void;
  /** For the tests (tools/test_walkroute.mts). */
  _debug: WalkRouteDebug;
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
