// The station 3D model format (stations3d/SCHEMA.md): what tools/build_station3d.py writes into
// stations3d/<key>.js, and what the router (station-route.ts) and the viewer (station3d.ts) read.

/** A point in the model's local frame, metres around `model.origin`: x = east, y = north. */
type XY = [x: number, y: number];
/** A point with its level (the OpenStreetMap `level` number; fractional on stairs, ramps and sloping streets). */
type XYL = [x: number, y: number, level: number];
type LngLat = [lng: number, lat: number];

/** Closed when `from <= today < until`; a missing bound is open-ended. */
interface StationClosure { from?: string; until?: string; note?: string }
interface StationNotice { text: string; from?: string; until?: string }

interface StationLevel { id: number; z: number; name: string }

interface StationArea {
  level: number;
  kind: 'platform' | 'floor' | 'room' | 'plaza';
  /** Outer ring, not closed, counter-clockwise. */
  ring: XY[];
  holes?: XY[][];
  /** Platform numbers, on a platform. */
  refs?: string[];
  name?: string;
  /** Metres, on a room (drawn as a block). */
  height?: number;
  /** Made by the builder from the paths or a deck outline: its width is a guess. */
  derived?: boolean;
  closed?: StationClosure;
}

interface StationTrack { level: number; line: XY[]; ref?: string; kind?: 'narrow_gauge' | 'tram' | 'light_rail' }

interface StationSlopeConnector {
  kind: 'stairs' | 'escalator' | 'ramp';
  line: XYL[];
  width: number;
  oneway?: 'up' | 'down';
  closed?: StationClosure;
}
interface StationElevator { kind: 'elevator'; xy: XY; levels: number[]; closed?: StationClosure }
type StationConnector = StationSlopeConnector | StationElevator;

/** Massing for context. base / top in metres relative to level 0. */
interface StationShell { kind: 'building' | 'roof' | 'deck'; ring: XY[]; holes?: XY[][]; base: number; top: number; name?: string }
/** Real roofs and walls as triangles: positions = flat [x, y, z, …] (z up, metres), indices = flat triangle corners. */
interface StationShellMesh { name?: string; kind: 'building' | 'roof' | 'deck' | 'canopy'; positions: number[]; indices: number[] }

type StationMode = string;
interface StationStop {
  uic: string;
  ref?: string;
  mode: StationMode;
  name: string;
  level: number;
  xy: XY;
  /** Where the stop is shown: the graph node nearest its ATLAS position. */
  node: number;
  /** Every graph node along that platform: a route may start or end at any of them. */
  nodes: number[];
  closed?: StationClosure;
  /** A remark that does not close the stop. */
  note?: string;
}
/** `level`: not in the schema; the viewer reads it when a sector has one (else the level of the platform's stop). */
interface StationSector { ref: string; name: string; xy: XY; node?: number; level?: number }
interface StationSectorSpan { ref: string; name: string; a: XY; b: XY; line?: XY[] }
interface StationProp {
  kind: 'sector-sign' | 'clock' | 'ticket-machine' | 'meeting-point';
  xy: XY;
  level: number;
  ref?: string;
  name?: string;
  mount?: 'hang' | 'stand';
  /** Compass bearing (0 = north, clockwise). */
  heading?: number;
}
interface StationEntrance { name: string; level: number; xy: XY; node: number; closed?: StationClosure }
interface StationPoi { kind: 'tickets' | 'toilets' | 'info' | 'meeting-point' | 'lockers'; name?: string; level: number; xy: XY }

type StationEdgeKind = 'walk' | 'stairs' | 'escalator' | 'ramp' | 'elevator';
interface StationEdge {
  a: number;
  b: number;
  kind: StationEdgeKind;
  /** Horizontal length in metres. */
  len: number;
  /** Only a → b. */
  oneway?: boolean;
  name?: string;
  outdoor?: boolean;
  covered?: boolean;
  wheelchair?: boolean;
  closed?: StationClosure;
  /** The builder added this link: OpenStreetMap has no path there. */
  inferred?: boolean;
  /** Rise / length of a ramp or a sloping street. */
  incline?: number;
}
interface StationGraph { nodes: XYL[]; edges: StationEdge[] }

interface StationModel {
  key: string;
  name: string;
  built: string;
  attribution: string[];
  notices?: StationNotice[];
  origin: LngLat;
  bbox: [minX: number, minY: number, maxX: number, maxY: number];
  /** Every stop id of the complex. */
  uics: string[];
  /** Bottom to top. */
  levels: StationLevel[];
  areas: StationArea[];
  tracks: StationTrack[];
  connectors: StationConnector[];
  shell: StationShell[];
  shellMesh?: StationShellMesh[];
  stops: StationStop[];
  sectors?: StationSector[];
  sectorSpans?: StationSectorSpan[];
  props?: StationProp[];
  entrances: StationEntrance[];
  pois: StationPoi[];
  graph: StationGraph;
}

/** stations3d/index.js: stop id → model key. */
declare var STATION3D_INDEX: Record<string, string>;
/** stations3d/<key>.js adds its model here when it is loaded. */
declare var STATION3D: Record<string, StationModel> | undefined;
