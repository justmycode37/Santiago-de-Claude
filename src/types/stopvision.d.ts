// Scan (src/stopvision.ts, loaded on demand): its API on window, what the page hands it, the photo database it
// reads (stop-images/, written by tools/build_stop_images.py) and the two libraries it loads from a CDN.

// ---- what the page gives Scan (src/app/14-menu.ts) ----

type StopVisionMode = 'train' | 'tram' | 'bus' | 'boat' | 'cable';
/** One edge of a stop as Scan reads it: its name on the sign ("7", "H", '' = none), the comparable form, the place. */
interface StopVisionEdge { ref: string; key: string; ll: LngLat; /** compass direction of travel of the vehicles stopping there */ bearing?: number | null }
/** A stop of the page's PLATFORMS map (src/app/30-platforms.ts): the fields Scan reads. */
interface StopVisionStop { name: string; mode: StopVisionMode; edges: StopVisionEdge[] }
/** Where the user is: the place, its accuracy in metres and the age of the fix in ms. */
interface StopVisionPosition { ll: LngLat; acc: number; age: number }

/** The page's functions and data Scan works with. */
interface StopVisionHooks {
  /** Every stop by UIC number ("8507000"). */
  PLATFORMS: Map<string, StopVisionStop>;
  /** The line's badge as the page draws it; without it Scan writes the line number itself. */
  badge?(line: LineLike): HTMLElement;
  /** null = no position (yet, or location is off). */
  position(): StopVisionPosition | null;
  /** Close Scan and show the stop on the map; edge: index into the stop's edges, null = the stop as a whole. */
  openStop(uic: string, edge: number | null): void;
  toast(text: string): void;
  onClose?(): void;
  /** The next ride of the journey under way (null: no journey): where it leaves from, for "this side / across the road". */
  route?(): StopVisionRoute | null;
  /** What is about to stop at a place, from the Kante engine's /api/due; null without the engine or the feature. */
  due?(params: Record<string, string | number | undefined>): Promise<KanteDueResponse | null>;
}

interface StopVisionRoute {
  uic: string;
  name: string;
  /** index into the stop's edges; null when only the stop is known */
  edge: number | null;
  /** the edge is the timetable's (named platform), not inferred from the direction of travel */
  exact: boolean;
  line: string;
  to?: string;
  /** ISO time, live where known */
  time?: string;
  /** what the Kante engine says about this ride now (/api/due) */
  live?: StopVisionRouteLive;
}

/** The engine's view of the ride (checkRoute): found at the stop, its edge, and how far away it is. */
interface StopVisionRouteLive {
  key: string;
  at: number;
  found: boolean;
  edge?: number | null;
  exact?: boolean;
  state?: 'approaching' | 'at-stop' | 'departed';
  etaS?: number | null;
  delayS?: number | null;
}

/** A box in picture pixels. */
interface ScanBox { x0: number; y0: number; x1: number; y1: number }
/** A word OCR read: normalised (n: glued, toks: its words), where, how tall, on which line, how sure (0–100). */
interface ScanWord { /** as read */ text: string; n: string; toks: string[]; box: ScanBox; h: number; block: number; line: number; conf: number }
/** The 'scan:words' event: every word of one reading, its box in picture pixels (width × height) and its confidence (0–100). */
interface ScanWordsDetail { words: Array<{ text: string; box: ScanBox; conf: number }>; width: number; height: number; tap: boolean }
/** The words of one reading, by line, with the typical and the biggest text height of the confident ones. */
interface ScanLayout { words: ScanWord[]; lines: ScanWord[][]; medianH: number; maxH: number; confident: number }
/** A stop whose name was read: how well (0–1), which of its names, where and how big. */
interface ScanNameHit { c: StopVisionCandidate; best: number; what: string; box?: ScanBox; h: number }
/** The sign outlined in the picture. h0: the heading when it was read; ok: recognised; warn: a sign/GPS conflict. */
interface ScanHighlight { box: ScanBox; name?: ScanBox | null; label: string; at: number; h0: number | null; ok?: boolean; warn?: boolean }
/** A stop name read clearly, far from the GPS position. */
interface ScanConflict { c: StopVisionCandidate; what: string; dist: number; at: number }
/** Two edges facing each other across one road, and which one you are at: mine/other, how clear (|offset| / GPS accuracy). */
interface ScanSide { mine: number; other: number; conf: number; across: number; near: number }
/** The edge you stand at (i null: not clear; pair: the two it is between). */
interface ScanStand { i: number | null; other?: number | null; why?: string; maybe?: boolean; unsure?: boolean; pair?: [number, number] }

// ---- what Scan knows while it runs (seen from outside through STOPVISION._debug) ----

/** A stop around the user (or, without a position, one whose name was read), with how well it fits. */
interface StopVisionCandidate {
  uic: string;
  st: StopVisionStop;
  /** Metres to its nearest edge; 0 without a position. */
  dist: number;
  /** Index of that edge. */
  nearEdge: number;
  /** The names a sign could show, normalised: "Bern, Zytglogge" → ["bern zytglogge", "zytglogge"]. */
  variants: string[];
  // set by score():
  /** Is one of its edges in front of the camera; null = no compass. */
  ahead?: boolean | null;
  /** The edge nearest to where the camera points. */
  aheadEdge?: number;
  /** Score from location and compass alone. */
  geo?: number;
  /** The best stop by location and compass, clearly. */
  geoTop?: boolean;
  score?: number;
}

/** A reference photo of a stop, decoded from a tile. */
interface StopVisionPhoto {
  src: StopImagesSource;
  prov: StopImagesProvenance;
  /** The edge it shows, when that is known. */
  edge: number | null;
  /** Compass direction it was taken in. */
  head: number | null;
  ref: string;
  credit: string;
  licence: string;
  /** Address of a small picture (Mapillary has none) and of the photo's page. */
  thumb: string | null;
  page: string;
  /** The fingerprint and its length. */
  emb: { v: Int8Array; n: number };
}

/** One departure on the sheet. */
interface StopVisionDeparture {
  /** When it is expected to leave, ms. */
  time: number;
  /** Minutes late. */
  delay: number;
  line: string;
  cat: string;
  to: string;
  /** The edge it leaves from (index), null = unknown. */
  edge: number | null;
  /** Every edge it leaves from ([] = the engine does not place it on one). */
  edges: number[];
  raw: BoardDeparture;
}

/** What has been found out about one stop. Every part is missing until it has been looked at. */
interface StopVisionEvidence {
  /** How well the stop's name fits the text read (0–1), when, and which of its names. */
  ocr?: number;
  ocrAt?: number;
  ocrWhat?: string;
  /** Not just one of several names read at once (signs also list destinations). */
  ocrUnique?: boolean;
  /** The name read is more than a word like "Bahnhof". */
  ocrStrong?: boolean;
  /** Edge named on a sign ("Kante C"). */
  edgeOcr?: number;
  edgeOcrAt?: number;
  /** Edge that a destination read on a sign leaves from. */
  edgeDest?: number | null;
  edgeDestAt?: number;
  destWhat?: string;
  /** How many of the stop's line numbers were read (0 when fewer than two), and when. */
  lines?: number;
  linesAt?: number;
  /** The edge from destinations was found without the stop's name on the same sign: a guess. */
  edgeDestWeak?: boolean;
  /** Where its name and sign were read in the picture (picture pixels). */
  signBox?: ScanBox | null;
  nameBox?: ScanBox | null;
  /** Photo similarity of the best reference photo, that photo, and how far above the median of the stops around. */
  vis?: number;
  visRef?: StopVisionPhoto;
  visRel?: number;
  visAt?: number;
  /** Frames in a row in which the photos clearly favoured this stop. */
  visStreak?: number;
  /** Live departures: null = could not be loaded. */
  departures?: StopVisionDeparture[] | null;
  depBusy?: boolean;
  depFailed?: boolean;
  /** Why the departures could not be loaded: the engine is switched off for the page, or cannot be reached. */
  depWhy?: KanteFailure | null;
  /** When departures were asked last (ms), and when they last came in. */
  depAt?: number;
  depOkAt?: number;
}

/** Which edge of a stop the camera looks at and how that is known; maybe = a guess. */
interface StopVisionEdgeGuess { i: number; why: string; maybe?: boolean }

/** A photo tile in memory: its data, the photos decoded so far, when it was last needed. */
interface StopVisionTile {
  s: Record<string, StopImagesPhoto[]>;
  d: Record<string, StopImagesLines[]>;
  refs: Map<string, StopVisionPhoto[]>;
  at: number;
}

/** What bench() measured (scan-bench.html). Times in ms. */
interface StopVisionBenchResult {
  ocrLoadMs: number;
  modelLoadMs: number;
  /** Where the image model ran: in a worker or on the page. */
  engine: '-' | 'worker' | 'page';
  /** The text read last; missing with 0 runs. */
  text?: string;
  photoMs: { p50: number; p95: number };
  ocrMs: { p50: number; p95: number };
}

interface StopVisionDebug {
  evidence: Map<string, StopVisionEvidence>;
  candidates(): StopVisionCandidate[];
  tiles: Map<string, StopVisionTile>;
  matchIn(tokens: string[], variant: string): number;
  nameVariants(name: string): string[];
  norm(s: string | null | undefined): string;
  distinctive(variant: string): boolean;
  useText(text: string, wasTap: boolean): Promise<void>;
  setApp(hooks: StopVisionHooks): void;
  recognised(c: StopVisionCandidate): 'sign' | 'photo' | null;
  findCandidates(): void;
  score(): void;
  edgeOf(c: StopVisionCandidate): StopVisionEdgeGuess | null;
}


// ---- stop-images/ (tools/build_stop_images.py): photo fingerprints and timetable lines of stops ----

/** Where a photo was found. */
type StopImagesSource = 'commons' | 'sbb' | 'panoramax' | 'mapillary';
/**
 * What ties a photo to the stop: SBB's own picture, Wikidata, OpenStreetMap, a Commons category (identity), or
 * only the place it was taken at: Mapillary, Panoramax, Commons by coordinates.
 */
type StopImagesProvenance = 'sbb' | 'wd' | 'osm' | 'cat' | 'mly' | 'pnx' | 'geo';
/**
 * One reference photo. edge: index into the stop's edges; heading: compass degrees; ref: 'c:…' Commons,
 * 'p:…' Panoramax, 'm:…' Mapillary, else an address; fingerprint: base64 of 128 int8 values.
 */
type StopImagesPhoto = [src: StopImagesSource, prov: StopImagesProvenance, edge: number | null, heading: number | null,
  ref: string, credit: string, licence: string, fingerprint: string];
/** The timetable of one edge (null = the stop as a whole): line numbers separated by spaces, destinations by '|'. */
type StopImagesLines = [edge: number | null, lines: string, dests: string];
/** A tile file, stop-images/t/<lat>_<lon>.js: photos (s) and lines (d) by UIC number. */
interface StopImagesTile {
  s?: Record<string, StopImagesPhoto[]>;
  d?: Record<string, StopImagesLines[]>;
}
/** Database format 1: photos only. */
type StopImagesTileV1 = Record<string, StopImagesPhoto[]>;
/** Every tile file is one call of this; src/stopvision.ts defines it. */
declare var STOP_IMAGES_TILE: (key: string, data: StopImagesTile | StopImagesTileV1) => void;

/** stop-images/index.js. */
interface StopImagesIndex {
  /** Database format. */
  v: number;
  /** The day it was built, "2026-11-21". */
  date: string;
  /** Tile size in degrees. */
  tile: number;
  /** Tile "<lat / tile>_<lon / tile>" (rounded down) → number of stops with photos in it (0: timetable lines only). */
  tiles: Record<string, number>;
  /** The image model the fingerprints were made with, on huggingface.co. */
  model: { repo: string; rev: string; file: string; input: number; mean: number[]; std: number[]; desc: string };
  /** 768 model values → k fingerprint values. Base64: mean = 768 float32, w = 768 × k int8, scale = k float32. */
  pca?: { k: number; n: number; mean: string; w: string; scale: string } | null;
  /** Photos per provenance. */
  photos: Partial<Record<StopImagesProvenance, number>>;
  stops: number;
  stops_with_lines: number;
  bytes: number;
}
/** Loaded on demand by src/stopvision.ts. */
declare var STOP_IMAGES_INDEX: StopImagesIndex | undefined;

// ---- tesseract.js 6 and onnxruntime-web 1.20, loaded from jsDelivr: the parts Scan uses ----

interface TesseractBBox { x0: number; y0: number; x1: number; y1: number }
interface TesseractWord { text: string; confidence: number; bbox: TesseractBBox }
/** With output { blocks: true }: blocks → paragraphs → lines → words, each with its box in image pixels. */
interface TesseractBlock { bbox: TesseractBBox; paragraphs?: Array<{ lines?: Array<{ words?: TesseractWord[] }> }> }
interface TesseractPage { text: string; blocks?: TesseractBlock[] | null }
interface TesseractWorker {
  setParameters(params: Record<string, string>): Promise<unknown>;
  recognize(image: Blob | HTMLCanvasElement, options?: Record<string, unknown>, output?: Record<string, boolean>): Promise<{ data: TesseractPage }>;
  terminate(): Promise<unknown>;
}
interface TesseractGlobal {
  /** oem 1 = the LSTM engine. */
  createWorker(langs: string | string[], oem?: number): Promise<TesseractWorker>;
}
declare var Tesseract: TesseractGlobal | undefined;

interface OrtTensor { data: Float32Array }
interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release(): Promise<void>;
}
interface OrtGlobal {
  env: { wasm: { wasmPaths: string; numThreads: number } };
  InferenceSession: {
    create(model: Uint8Array, options?: { executionProviders?: string[]; graphOptimizationLevel?: string }): Promise<OrtSession>;
  };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => OrtTensor;
}
declare var ort: OrtGlobal | undefined;
