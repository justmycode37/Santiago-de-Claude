// What Scan (src/stopvision.ts) reads besides the page: the photo database (stop-images/, written by
// tools/build_stop_images.py) and the two libraries it loads from a CDN.

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
