// The continuous 3D view of a station's inside (station3d-solid.html, docs/station3d-solid.md): which stations have
// its companion file. stations3d/solid-index.js is written by tools/station3d_solid.py and loaded on demand.

/** stations3d/solid-index.js: model key → its companion file (stations3d/<key>.solid.js). */
declare var STATION3D_SOLID_INDEX: Record<string, { file: string }> | undefined;

// The companion file itself (stations3d/<key>.solid.js), as tools/station3d_solid.py writes it and
// src/station3d-solid.ts reads it. Positions are in the model's local frame (XY, metres); every `z` is in true
// metres above level 0 (not a level number).

/** A point of a connector's course: local x, y and its height in metres. */
type StationSolidXYZ = [x: number, y: number, z: number];

/** A piece of walkable floor of one level. rings[0] is the outline, the others are holes (wells, pillars). */
interface StationSolidSlab { level: number; z: number; rings: XY[][] }
/** 'wall': an indoor wall of OpenStreetMap; 'edge': the kerb at the edge of a floor; 'rail': the railing round a well. */
interface StationSolidWall { level: number; z: number; line: XY[]; kind: 'wall' | 'edge' | 'rail' }
type StationSolidPinKind = 'shop' | 'food' | 'service' | 'toilets';
/** A named room, drawn as a block. `name` may be empty. */
interface StationSolidRoom { level: number; z: number; ring: XY[]; name: string; kind: StationSolidPinKind | 'room'; height: number }
/** A shop or a service mapped as a point. `name` may be empty. */
interface StationSolidPin { level: number; z: number; x: number; y: number; name: string; kind: StationSolidPinKind }

interface StationSolidSlopeConnector {
  kind: 'stairs' | 'escalator' | 'ramp';
  pts: StationSolidXYZ[];
  width: number;
  /** The way it runs, when it runs one way only. */
  dir?: 'up' | 'down';
  /** The lowest and the highest level number it touches. */
  levels: [min: number, max: number];
  /** Drawn steeper than 40° in OpenStreetMap: shown as a striped slope, not as steps. */
  steep?: true;
  /** On stairs: how many steps. */
  steps?: number;
}
/** `zs`: the height of each floor it stops at. */
interface StationSolidElevator { kind: 'elevator'; xy: XY; zs: number[] }
type StationSolidConnector = StationSolidSlopeConnector | StationSolidElevator;

/** `z`: the height of the track bed (1.1 m under its level's floor; a tram track lies in the floor). */
interface StationSolidTrack { z: number; line: XY[]; kind?: StationTrack['kind'] }
interface StationSolidLabel {
  kind: 'platform' | 'place' | 'sector' | 'entrance' | 'room';
  text: string;
  x: number;
  y: number;
  z: number;
  /** On a sector: its platform. */
  ref?: string;
}

interface StationSolid {
  key: string;
  name: string;
  origin: LngLat;
  built: string;
  attribution: string[];
  levels: StationLevel[];
  slabs: StationSolidSlab[];
  walls: StationSolidWall[];
  rooms: StationSolidRoom[];
  pins: StationSolidPin[];
  connectors: StationSolidConnector[];
  tracks: StationSolidTrack[];
  labels: StationSolidLabel[];
  shell: StationShell[];
}

/** stations3d/<key>.solid.js adds its data here when it is loaded. */
declare var STATION3D_SOLID: Record<string, StationSolid> | undefined;
/** station3d-solid.html: resolves with the station's key once its data scripts and the router are loaded. */
declare var SOLID_READY: Promise<string>;
