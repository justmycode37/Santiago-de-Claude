// The indoor position in the 3D station view (indoornav.ts, loaded at the first opening by the stand-in in index.html;
// details in docs/indoor-positioning.md): what the page calls. Below it, what indoorloc.ts (`INDOORLOC`: the filter,
// the phone's sensors, recordings) and signloc.ts (`SIGNLOC`: signs as evidence) give; tools/sim_indoorloc.cts
// loads those two in Node.

/** `INDOORNAV.state()`. */
interface IndoorNavState {
  active: boolean; open: boolean; away: boolean; key: string | null;
  /** Something says the traveller is really there (a recent GPS fix near the station, a sign, "I am here"): only then is a position shown. */
  live: boolean;
  sensors: IndoorSensorState | null;
  estimate: IndoorEstimate | null;
}

/** `INDOORNAV.sign()`: what the sign matched. `repeated`: the same text within 15 s, not counted again. */
interface IndoorNavSign extends SignLocMatch { repeated?: boolean }



/** `window.dispatchEvent(new CustomEvent('scan:text', { detail }))`: text Scan read (indoornav.ts listens). */
interface ScanTextDetail { text: string; tap?: boolean; at?: number }
/** `window.dispatchEvent(new CustomEvent('indoorloc:pressure', { detail }))`: a barometer reading (`INDOORLOC.pushPressure`). */
interface IndoorPressureDetail { hPa: number; t?: number }
interface WindowEventMap {
  'scan:text': CustomEvent<ScanTextDetail>;
  'indoorloc:pressure': CustomEvent<IndoorPressureDetail>;
}

// ---------------------------------------------------------------------------------------------- INDOORLOC.Model

/** Not in the schema: how sure a level's height is (± m). The indoor filter reads it when a level has one (else 0.5). */
interface StationLevel { sh?: number }

/** A floor as the filter needs it. h: metres above level 0; sh: how sure (± m). */
interface IndoorLevel { id: number; h: number; sh: number; name: string }

type IndoorLandmarkKind = 'platform' | 'sector' | 'exit' | 'passage' | 'shop' | 'amenity' | 'prop';
/** Something a sign can name, on its floor. */
interface IndoorLandmark {
  /** Index into `levels`. */
  li: number;
  x: number;
  y: number;
  kind: IndoorLandmarkKind;
  /** platform: the stop's ref; sector: "7:BC" (platform:letters); else the name. */
  text: string;
  /** platform: the mode; sector: how the sign is mounted, or 'centre'; else the model's own kind. */
  extra: string;
  /** platform: the stop's graph node. */
  node?: number;
  /** The points spread through one named floor or plaza share this. */
  group?: string;
}

/** A place on the walking network: edge `e`, `s` metres from its a end. */
interface IndoorEdgePlace { e: number; s: number }
/** … found near a point, `d` metres from it. */
interface IndoorEdgeHit extends IndoorEdgePlace { d: number }
/** `Model.at()`: a point on an edge. t: 0..1 from a to b; li: the floor of the nearer end. */
interface IndoorEdgePoint { x: number; y: number; z: number; level: number; li: number; t: number }

interface IndoorModelOptions {
  /** The day closures are judged for ("YYYY-MM-DD"; default today). */
  date?: string | null;
}

/** A station model as the filter needs it. Nodes and edges are numbered as in `raw.graph`, less the closed edges. */
interface IndoorModel {
  raw: StationModel;
  key: string;
  name: string;
  uics: string[];
  origin: LngLat;
  /** Metres per degree of longitude / latitude at the origin. */
  mx: number;
  my: number;
  /** Bottom to top. */
  levels: IndoorLevel[];
  /** Level id → index into `levels`. */
  levelIndex: Map<number, number>;
  /** Nodes: position, level number, floor (index into `levels`), height (m). */
  n: number;
  x: Float64Array;
  y: Float64Array;
  lv: Float64Array;
  li: Int16Array;
  z: Float64Array;
  /** Edges: both ends, kind (index into `INDOORLOC.KIND`), flags (`INDOORLOC.flags`), walking length (m), bearing a → b (deg). */
  ne: number;
  ea: Int32Array;
  eb: Int32Array;
  ek: Int8Array;
  ef: Int8Array;
  elen: Float64Array;
  ebear: Float64Array;
  /** Per node, the edges you can leave it by: [edge, +1 (a → b) | −1 (b → a)]. */
  out: [edge: number, dir: number][][];
  /** The spatial index: edges per floor and cell ("li:gx:gy"), cells of `cell` metres. */
  cell: number;
  grid: Map<string, number[]>;
  landmarks: IndoorLandmark[];
  /** Height (m above level 0) of a level number, fractional ones included. */
  zOf(level: number): number;
  /** The floor (index into `levels`) a level number belongs to: the nearest whole level. */
  floorOf(level: number): number;
  /** null: no such floor. */
  levelId(li: number): number | null;
  toLngLat(x: number, y: number): LngLat;
  fromLngLat(lon: number, lat: number): XY;
  kind(e: number): StationEdgeKind;
  at(e: number, s: number): IndoorEdgePoint;
  /** The closest point on edge e to (x, y). */
  project(e: number, x: number, y: number): { d: number; s: number };
  /** Edges within r metres of (x, y) on floor li (null: every floor), nearest first. */
  nearEdges(x: number, y: number, li: number | null | undefined, r: number): IndoorEdgeHit[];
  nearestOnLevel(x: number, y: number, li: number | null | undefined, r?: number): IndoorEdgeHit | null;
}

// ---------------------------------------------------------------------------------------------- INDOORLOC.Filter

/** `INDOORLOC.rng(seed)`: uniform 0..1; `gauss()`: standard normal. */
interface IndoorRandom { (): number; gauss(): number }

/** The filter's settings (the defaults are in indoorloc.ts). */
interface IndoorFilterOptions {
  particles?: number;
  /** Metres per step, and its spread. */
  stepLength?: number;
  stepSigma?: number;
  /** Degrees the measured walking heading may be from the path. */
  headingSigma?: number;
  /** m/s along an escalator when standing on it; m/s vertical in a lift. */
  escalatorSpeed?: number;
  liftSpeed?: number;
  /** Per second: the chance a particle at a lift starts a ride while you stand. */
  liftRate?: number;
  /** Metres of height mismatch tolerated; the floor of the barometer's likelihood; m/s above which a height change is a disturbance. */
  baroSigma?: number;
  baroOutlier?: number;
  baroJump?: number;
  gpsMinSigma?: number;
  gpsOutlier?: number;
  /** Resample when the effective sample size falls below this share of the particles. */
  resampleEss?: number;
  /** For repeatable runs (default: the time). */
  seed?: number;
}

/** `Filter.init(where)`: around a point (r metres, default 20) and / or on these floors (indices); nothing: anywhere. */
interface IndoorWhere { x?: number | null; y?: number; r?: number; levels?: number[] | null }
/** A step was taken. heading: the walking direction (deg); stairs: the step was on stairs, when that is known. */
interface IndoorStep { t: number; length?: number; heading?: number | null; headingSigma?: number | null; stairs?: boolean | null }
/** Relative barometric height: hPa, or z in metres. Only changes matter. */
interface IndoorPressure { t: number; hPa?: number; z?: number | null }
interface IndoorGps { t: number; lon: number; lat: number; acc?: number }
/** What the body did: a lift started moving. */
interface IndoorMotion { t: number; kind: 'lift'; dir?: 'up' | 'down' | null }
/** A place something seen can be. li null: any floor; sigma: metres (default 10); w: weight among the candidates. */
interface IndoorCandidate { x: number; y: number; li?: number | null; sigma?: number; w?: number; label?: string }
/** Something seen. Several candidates: an ambiguous sign. strength 0..1 (default 0.8). */
interface IndoorSighting { t: number; candidates?: IndoorCandidate[]; strength?: number | null }
/** The traveller (or the journey) says: on this floor (li: index, level: id), maybe near this spot (local, or lon / lat). */
interface IndoorPrior { li?: number | null; level?: number | null; x?: number; y?: number; r?: number; lon?: number | null; lat?: number }

/** What the last evidence did, for a read-out. */
interface IndoorEvidence {
  baro?: 'ok' | 'disturbed' | 're-anchored';
  sign?: { candidates: number; strength: number };
  /** Particles put back around the estimate (they explained the steps badly). */
  recovered?: number;
  relocalised?: 'gps';
  /** Nothing fitted any more: started again (after this kind of evidence). */
  reset?: string;
}
/** Nothing has placed the traveller yet. (li, levelProbs: never there; named so that any estimate can be asked for them.) */
interface IndoorEstimateUnknown { state: 'unknown'; confident: false; li?: undefined; levelProbs?: undefined }
interface IndoorEstimateTracking {
  state: 'tracking';
  /** On the most likely floor, snapped to the walking network. */
  x: number;
  y: number;
  lon: number;
  lat: number;
  /** The most likely floor: index into the model's levels, its id, how likely. */
  li: number;
  level: number;
  levelProb: number;
  /** Level id → probability (floors under 0.5 % left out). */
  levelProbs: Record<number, number>;
  /** Spread of the particles on that floor (m). */
  sigma: number;
  /** One floor clearly wins and the spread is small. */
  confident: boolean;
  z: number;
  t: number | null;
  evidence: IndoorEvidence;
}
type IndoorEstimate = IndoorEstimateUnknown | IndoorEstimateTracking;
/** `Filter.cloud()`: a particle for drawing. w: its weight × the number of particles. */
type IndoorParticle = [x: number, y: number, li: number, w: number];

/** The particle filter. Every evidence method returns the new estimate. */
interface IndoorFilter {
  M: IndoorModel;
  /** The number of particles; the arrays have one entry each. */
  N: number;
  /** Edge; metres from its a end; direction of travel along it (+1 a → b, −1 b → a). */
  e: Int32Array;
  s: Float64Array;
  d: Int8Array;
  /** Step length scale; heading bias (deg); barometer offset (m); > 0: riding a lift; weight. */
  k: Float64Array;
  hb: Float64Array;
  bo: Float64Array;
  ride: Float64Array;
  w: Float64Array;
  /** Time of the last update (s). */
  t: number | null;
  /** Something has placed the traveller (a GPS fix, the journey, a sign, their own word). */
  initialised: boolean;
  /** Effective sample size after the last evidence. */
  ess?: number;
  /** fn is called with every new estimate. */
  on(fn: (est: IndoorEstimate) => void): this;
  /** Start (or restart) from what is known. */
  init(where?: IndoorWhere): IndoorEstimate;
  step(ev: IndoorStep): IndoorEstimate;
  /** Nothing but time (every second or so). */
  tick(t: number): IndoorEstimate;
  pressure(ev: IndoorPressure): IndoorEstimate;
  gps(ev: IndoorGps): IndoorEstimate;
  motion(ev: IndoorMotion): IndoorEstimate;
  landmark(ev: IndoorSighting): IndoorEstimate;
  prior(ev: IndoorPrior): IndoorEstimate;
  /** The screen was off for dt seconds. */
  gap(t: number, dt: number): IndoorEstimate;
  estimate(): IndoorEstimate;
  cloud(max?: number): IndoorParticle[];
}

// ---------------------------------------------------------------------------- INDOORLOC.Sensors, Recorder, replay

type IndoorSensorStatus = 'off' | 'on' | 'denied' | 'unavailable' | 'error';
type IndoorSensorState = Record<'motion' | 'orientation' | 'gps' | 'pressure', IndoorSensorStatus>;

/** Where the traveller really was (a tap on the model, or the simulator's truth): local or lon / lat, and the floor. */
interface IndoorCheckpoint { x?: number; y?: number; lon?: number | null; lat?: number; level?: number | null; li?: number; mode?: string }
/** What each kind of recorded event carries besides its time. `sigma` on a step: headingSigma as Sensors logs it. */
interface IndoorLogData {
  step: { length?: number; heading?: number | null; headingSigma?: number | null; sigma?: number | null; stairs?: boolean | null };
  gps: { lon: number; lat: number; acc?: number; alt?: number | null; altAcc?: number | null };
  pressure: { hPa?: number; z?: number };
  tick: {};
  /** The compass: h = heading (deg), acc = its accuracy (iOS), a / b / g = the event's angles. */
  orient: { h: number; acc?: number | null; a: number | null; b: number | null; g: number | null };
  /** Every other motion event: av = vertical acceleration, r = rotation rate, u = the direction of gravity. */
  imu: { av: number; r: number[] | null; u: number[] };
  hidden: {};
  visible: { dt: number };
  sign: { text: string; explain?: string };
  landmark: Omit<IndoorSighting, 't'>;
  motion: Omit<IndoorMotion, 't'>;
  prior: IndoorPrior;
  checkpoint: IndoorCheckpoint;
  truth: IndoorCheckpoint;
}
type IndoorLogType = keyof IndoorLogData;
/** An event as it goes to a Recorder: its data, and maybe its time (s; default now). */
type IndoorRaw<K extends IndoorLogType> = IndoorLogData[K] & { t?: number };
/** [seconds since the first event, what, its data]. */
type IndoorLogEvent = { [K in IndoorLogType]: [t: number, type: K, data: IndoorLogData[K]] }[IndoorLogType];
interface IndoorLogMeta {
  v?: number;
  ua?: string;
  start?: string;
  /** The station model. */
  key?: string | null;
  /** Where the walk starts, when that is known: replay begins with it. */
  prior?: IndoorPrior | null;
  /** tools/sim_indoorloc.cts --export. */
  scenario?: string;
  name?: string;
  simulated?: boolean;
}
/** A recording: `INDOORNAV.exportLog()`, `Recorder.toJSON()`; tools/sim_indoorloc.cts --replay reads it. */
interface IndoorLog { meta?: IndoorLogMeta; events: IndoorLogEvent[] }

interface IndoorSensorsOptions {
  /** Gets every raw event before it is interpreted (for a Recorder). */
  onRaw?: (<K extends IndoorLogType>(type: K, data: IndoorRaw<K>) => void) | null;
  /** The app feeds GPS itself (Filter.gps). */
  noGeo?: boolean;
}
/** The phone's sensors, feeding a filter. */
interface IndoorSensors {
  state: IndoorSensorState;
  /** Fused heading of the phone (deg), and how sure. */
  heading: number | null;
  headingSigma: number;
  /** Call from a tap (iOS asks for motion and orientation access then). */
  start(): Promise<IndoorSensorState>;
  stop(): void;
}

interface IndoorRecorder {
  meta: IndoorLogMeta;
  events: IndoorLogEvent[];
  add<K extends IndoorLogType>(type: K, data: IndoorRaw<K>): void;
  /** "I am here": ground truth for evaluation. */
  checkpoint(where: IndoorRaw<'checkpoint'>): void;
  toJSON(): IndoorLog;
}

interface IndoorReplayOptions extends IndoorFilterOptions {
  /** Where the walk starts (default: the recording's `meta.prior`). */
  prior?: IndoorPrior | null;
  /** Keep the estimate after every event. */
  every?: boolean;
}
/** At a checkpoint: d = metres off (null: no position yet), prob = the probability given to the right floor. */
interface IndoorReplayCheckpoint { t: number; d: number | null; levelOk: boolean; prob: number; est: IndoorEstimate }
interface IndoorReplayResult { estimates: [t: number, est: IndoorEstimate][]; checkpoints: IndoorReplayCheckpoint[] }

/** A constructor of indoorloc.ts: `new` may be left out. */
type IndoorCtor<A extends unknown[], T> = { new (...args: A): T; (...args: A): T };


// ---------------------------------------------------------------------------------------------- SIGNLOC

/** What a sign says. platforms: as written ("7", "H"); ranges: "Gleis 3–18"; sectors: capital letters. */
interface SignLocParse {
  /** The text, normalised. */
  text: string;
  words: string[];
  platforms: string[];
  ranges: [from: number, to: number][];
  sectors: string[];
  exit: boolean;
  arrows: boolean;
  /** A word like Gleis / Voie / Kante was read. */
  platformWord: boolean;
  /** A sector sign without words: "7 A". */
  bare?: boolean;
}
type SignLocKind = IndoorLandmarkKind | 'direction' | 'board';
/** One thing a sign says about where you are. */
interface SignLocObservation { kind: SignLocKind; label: string; candidates: IndoorCandidate[]; strength: number }
/** `SIGNLOC.match()`. candidates / strength: those of the strongest observation. */
interface SignLocMatch {
  parsed: SignLocParse;
  /** Strongest first. */
  observations: SignLocObservation[];
  candidates: IndoorCandidate[];
  strength: number;
  explain: string;
}
/** A live departure at the station, to read departure boards. */
interface SignLocDeparture { platform?: string | number | null; line?: string | null; to?: string | null }
interface SignLocOptions { departures?: SignLocDeparture[] | null }

