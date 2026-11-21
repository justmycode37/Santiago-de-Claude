// Detail scenes (stations3d/DETAIL.md): what tools/build_detail.py writes into stations3d/<key>.detail.js, and the
// renderer that draws them (src/station3d-detail.ts → window.Station3DDetail), which the viewer (station3d.ts) calls.
// Coordinates are those of the station model (station-model.d.ts): metres around the model's origin, x = east,
// y = north. Heights are z in metres relative to the model's level 0. `heading` is a compass bearing in degrees.

// ---------- the data ----------

/** A point with its height. */
type StationDetailXYZ = [x: number, y: number, z: number];

/** On any item: where it comes from ("osm:node/123", "baumkataster:4711", "lidar", "estimate"). */
interface StationDetailItem { source?: string }

type StationDetailSurfaceKind = 'asphalt' | 'paving' | 'cobble' | 'gravel' | 'grass' | 'soil' | 'tram-track' | 'crossing' | 'water';
/** A piece of ground. Surfaces are drawn in order; later ones lie on top. */
interface StationDetailSurface extends StationDetailItem {
  kind: StationDetailSurfaceKind;
  ring: XY[];
  holes?: XY[][];
  /** The surface height when it is flat … */
  z?: number;
  /** … or one height per ring point. */
  zs?: number[];
  /** What it is used for ("road", "pavement", "square", "island" …): sets the tone. */
  use?: string;
  /** "#rrggbb": shifts the tone a little. */
  color?: string;
  /** Direction of the pattern (paving joints, cobble arcs) or, for a crossing, of walking. */
  heading?: number;
  /** Tram track: its centre line, the width of the track bed, the number of tracks and the gauge (default 1.0 m). */
  line?: XY[];
  width?: number;
  tracks?: number;
  gauge?: number;
  variant?: string;
}

type StationDetailEdgeKind = 'kerb' | 'ledge' | 'wall' | 'fence' | 'railing' | 'hedge' | 'steps';
/** A linear thing with a height you could trip over or sit on. */
interface StationDetailEdge extends StationDetailItem {
  kind: StationDetailEdgeKind;
  line: XY[];
  z?: number;
  height?: number;
  width?: number;
  /** The last point joins the first. */
  closed?: boolean;
  /** Steps: the side (seen along the line) they climb to. */
  side?: 'left' | 'right';
  /** Free text; "wood" makes a fence a wooden one. */
  variant?: string;
}

interface StationDetailTree extends StationDetailItem {
  xy: XY;
  z?: number;
  height?: number;
  /** Radius of the crown, metres. */
  crown?: number;
  /** Radius of the trunk, metres. */
  trunk?: number;
  /** Height where the crown begins. */
  crownBase?: number;
  kind?: 'broadleaf' | 'conifer' | 'columnar';
  /** Botanical name: the genus tints the crown. */
  species?: string;
  /** false: bare (winter). */
  leaves?: boolean;
  /** "pollard…": knuckles with one year's shoots instead of a crown. `pruning`, `shape` and `variant` are read the same way. */
  form?: string;
  pruning?: string;
  shape?: string;
  variant?: string;
  pollarded?: boolean;
  /** Year: sets the trunk thickness when `trunk` is missing. */
  planted?: number;
}

type StationDetailPropKind = 'bench' | 'lamp' | 'bollard' | 'bin' | 'bike-stand' | 'fountain' | 'planter' | 'hydrant' |
  'sign-post' | 'pole' | 'shelter' | 'clock' | 'statue' | 'ticket-machine';
/** Other names the renderer understands for a prop kind. */
type StationDetailPropAlias = 'street-lamp' | 'streetlamp' | 'street_lamp' | 'waste-basket' | 'waste_basket' |
  'bicycle-parking' | 'bike-rack' | 'sign' | 'signpost' | 'monument' | 'mast' | 'bus-shelter';
/** Street furniture. Sizes are what is known; the renderer has defaults. */
interface StationDetailProp extends StationDetailItem {
  kind: StationDetailPropKind | StationDetailPropAlias;
  xy: XY;
  z?: number;
  /** The way it faces. */
  heading?: number;
  /** Used when `heading` is missing. */
  axis?: number;
  height?: number;
  length?: number;
  width?: number;
  /** Free text the renderer looks for words in ("backless", "wire", "lantern", "row", "trough", "obelisk" …). */
  variant?: string;
  name?: string;
  /** Bike stand: number of bikes. */
  capacity?: number;
  /** Sign post: it is strapped to the mast beside it and has no pole of its own. */
  mount?: string | boolean;
  /** Statue. */
  plinthHeight?: number;
  plinthColor?: string;
  color?: string;
}

type StationDetailRoof = 'flat' | 'gabled' | 'hipped' | 'mansard';
type StationDetailGroundFloor = 'shop' | 'arcade' | 'plain';
/** Real geometry: positions = flat [x, y, z, …], indices = flat triangle corners (missing: every three points are one). */
interface StationDetailMesh { positions: number[]; indices?: number[] }
/** What one wall looks like: the wall of the building that runs from a to b. */
interface StationDetailFace {
  a: XY;
  b: XY;
  bays?: number;
  floors?: number;
  groundFloor?: StationDetailGroundFloor;
  color?: string;
  /** The way the wall looks, for buildings without a ring. */
  heading?: number;
}
/** A house at its real size: a prism (ring + heights) or a mesh. */
interface StationDetailBuilding extends StationDetailItem {
  name?: string;
  ring?: XY[];
  holes?: XY[][];
  base?: number;
  eaves?: number;
  ridge?: number;
  roof?: StationDetailRoof;
  /** Bearing of the ridge line. */
  ridgeDir?: number;
  mesh?: StationDetailMesh;
  floors?: number;
  groundFloor?: StationDetailGroundFloor;
  color?: string;
  roofColor?: string;
  faces?: StationDetailFace[];
  arcade?: 'arches' | 'pillars';
  /** Metres from the front to the back wall of the arcade (default 3.2). */
  arcadeDepth?: number;
  /** true, or their colour "#rrggbb". */
  shutters?: boolean | string;
  /** Floors in the roof: dormers on a mesh roof. */
  roofFloors?: number;
}

interface StationDetailModel {
  key: string;
  name: string;
  built: string;
  attribution: string[];
  /** Outline of the detailed stretch. */
  area: XY[];
  /** The showcase walk itself. */
  path: StationDetailXYZ[];
  /** Metres the scene is to be moved up (+) or down (-) to meet the station model (`zShift: true`). */
  zOffset?: number;
  surfaces?: StationDetailSurface[];
  edges?: StationDetailEdge[];
  trees?: StationDetailTree[];
  props?: StationDetailProp[];
  buildings?: StationDetailBuilding[];
}

/** One station of stations3d/detail-index.js: where its scene is loaded from and the bbox of its area (model metres). */
interface StationDetailIndexEntry { file: string; bbox: [minX: number, minY: number, maxX: number, maxY: number] }

// ---------- the renderer ----------

type Station3DDetailTheme = 'light' | 'dark';
type Station3DDetailQuality = 'high' | 'low';
type Station3DDetailSeason = 'winter' | 'summer';

/** The default colours of a theme ("#RRGGBB"), as `Station3DDetail.palette(theme)` gives them. */
interface Station3DDetailPalette {
  sky: string; horizon: string; ground: string;
  paving: string; asphalt: string; cobble: string; gravel: string; grass: string; soil: string; water: string;
  tram: string; kerb: string; stone: string; marking: string; rail: string;
  wall: string; wallShade: string; trim: string; roof: string; roofTile: string;
  glass: string; glassLit: string; pane: string; door: string;
  crown: string; crownDark: string; crownLight: string; hedge: string; conifer: string;
  trunk: string; metal: string; steel: string; wood: string;
  lamp: string; lens: string; bronze: string; sign: string; hydrant: string;
  shadow: string;
  /** 0..1: how dark the shadows on the ground are. */
  shadowAlpha: number;
  awnings: string[]; shutters: string[]; flowers: string[];
}
/** A colour given to the renderer: "#rgb" / "#rrggbb", or sRGB [r, g, b] with 0..1 each. */
type Station3DDetailColor = string | [r: number, g: number, b: number];
/** `opts.palette`: overrides single colours of the theme's palette. */
type Station3DDetailPaletteOverride = {
  [K in keyof Station3DDetailPalette]?: Station3DDetailPalette[K] extends number ? number
    : Station3DDetailPalette[K] extends string[] ? Station3DDetailColor[] : Station3DDetailColor;
};

interface Station3DDetailOptions {
  /** "dark": night, lamps and windows lit. Default "light". */
  theme?: Station3DDetailTheme;
  /** Crown, branch, facade and texture detail. Default "high". */
  quality?: Station3DDetailQuality;
  /** All trees bare / all in leaf, whatever the data says. Default: the data (`tree.leaves`). */
  season?: Station3DDetailSeason;
  /** Draw all broadleaf trees pollarded / none. Default: the data (`tree.form`). */
  pollard?: boolean;
  /** Model metres (x east, y north, z up, relative to level 0) to scene coordinates. Default: [x, z, -y]. */
  toScene?: (x: number, y: number, z: number) => [X: number, Y: number, Z: number];
  /** Metres the whole scene is moved up (+) or down (-) before toScene; true: by `detail.zOffset`. Default 0. */
  zShift?: number | boolean;
  palette?: Station3DDetailPaletteOverride;
  /** Where the light comes from (compass bearing and height, degrees). Default: the direction of the viewer's sun. */
  sun?: { azimuth?: number; elevation?: number };
  /** true: add a sky dome to the group. */
  sky?: boolean;
  /** Metres the ground fades out over beyond `detail.area` (default 5; 0: no fade). */
  feather?: number;
  /** Metres of free height kept under crowns that reach over `detail.path` (default 2.7). */
  clearance?: number;
}
interface Station3DDetailSkyOptions { theme?: Station3DDetailTheme; palette?: Station3DDetailPaletteOverride; radius?: number }

/** One merged mesh of the scene: unlit, the lighting is baked into the vertex colours. */
type Station3DDetailMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
type Station3DDetailSky = THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
/** The meshes by role, so the viewer can fade or hide one. null: nothing of that kind in the scene. */
interface Station3DDetailParts {
  /** One per ground texture and layer. */
  ground: Station3DDetailMesh[];
  decals: Station3DDetailMesh | null;
  solid: Station3DDetailMesh | null;
  buildings: Station3DDetailMesh | null;
  crowns: Station3DDetailMesh | null;
  feather: Station3DDetailMesh | null;
  shadows: Station3DDetailMesh | null;
  pools: Station3DDetailMesh | null;
  glass: Station3DDetailMesh | null;
  /** Lamp glows: only at night, when there is a lamp. */
  glows?: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** Only with `opts.sky`. */
  sky?: Station3DDetailSky;
}
interface Station3DDetailCounts { surfaces: number; edges: number; trees: number; props: number; buildings: number }
interface Station3DDetailStats {
  triangles: number;
  drawCalls: number;
  vertices: number;
  textures: number;
  buildMs: number;
  /** Items of the data that were drawn. */
  counts: Station3DDetailCounts;
  /** Triangles per mesh, by its name without "detail-" ("solid", "ground-paving-0" …). */
  parts: Record<string, number>;
  /** What could not be drawn (at most 40). */
  warnings: string[];
}
/** Where a lamp is: model coordinates, z shifted; height = that of its light above z. */
interface Station3DDetailLamp { xy: XY; z: number; height: number }

/** What `build` returns. */
interface Station3DDetailHandle {
  /** To add to the scene. All positions are already in scene coordinates. */
  group: THREE.Group;
  detail: Partial<StationDetailModel>;
  /** The options in use (those of `build`, with every `update` merged in). */
  opts: Station3DDetailOptions;
  theme: Station3DDetailTheme;
  quality: Station3DDetailQuality;
  /** The shift that was applied. */
  zShift: number;
  stats: Station3DDetailStats;
  parts: Station3DDetailParts;
  lamps: Station3DDetailLamp[];
  /** Same as `Station3DDetail.groundAt(h, x, y)`. */
  groundAt(x: number, y: number): number | null;
  /** Removes the group from its parent and frees geometries, materials and textures. */
  dispose(): void;
}

interface Station3DDetailApi {
  build(THREE: ThreeModule, detail: StationDetailModel | null | undefined, opts?: Station3DDetailOptions): Station3DDetailHandle;
  /** Changes the look without a new handle: the contents of `h.group` are built again in place. Returns `h`. */
  update(h: Station3DDetailHandle, change?: Station3DDetailOptions): Station3DDetailHandle;
  /** z of what you stand on at (x, y): model metres relative to level 0, plus zShift. null outside the scene. */
  groundAt(h: Station3DDetailHandle | null | undefined, x: number, y: number): number | null;
  /** A sky dome (Y-up scene), for pages without one. */
  sky(THREE: ThreeModule, o?: Station3DDetailSkyOptions): Station3DDetailSky;
  /** A copy of the default colours. */
  palette(theme?: Station3DDetailTheme): Station3DDetailPalette;
  version: number;
}

/** src/station3d-detail.ts, loaded on demand. */
declare var Station3DDetail: Station3DDetailApi | undefined;
/** stations3d/<key>.detail.js adds its scene here when it is loaded. */
declare var STATION3D_DETAIL: Record<string, StationDetailModel> | undefined;
/** stations3d/detail-index.js (loaded on demand): model key → where its detail scene is. */
declare var STATION3D_DETAIL_INDEX: Record<string, StationDetailIndexEntry> | undefined;
