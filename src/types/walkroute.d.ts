// The pedestrian network's files, which src/walkroute.ts routes on (docs/walking-routes.md).

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
declare var WALKGRAPH_INDEX: WalkGraphIndex | undefined;
declare var WALKGRAPH_TILE: ((key: string, data: WalkGraphTile) => void) | undefined;

