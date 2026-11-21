// The live map's JSON, declared once for both sides: server.mts makes it (Node), page.ts and page-old.ts read it
// (browser). Plain global declarations, in the `include` of tsconfig.json and of tsconfig.page.json.
// Times are unix seconds, positions degrees, lengths metres.

/** A line's mode, as the engine names it. */
type LiveMapMode = 'rail' | 'tram' | 'bus' | 'metro' | 'boat' | 'funicular' | 'cableway' | 'rack' | 'lift' | 'ondemand' | 'other';
/** How sure a vehicle's times are: 0 timetable only, 1 forecast, 2 the feed has reported it at a stop. */
type LiveMapLiveCode = 0 | 1 | 2;
/** The page's groups of modes: one chip, one colour each. */
type LiveMapGroup = 'rail' | 'tram' | 'bus' | 'boat' | 'cable' | 'other';

// ---- GET /state?since=<rev>&epoch=<epoch>: the fleet with its coming stops (page.ts)

/**
 * One vehicle. `stops` is flat, three numbers per stop from stop `base` of the trip on: longitude, latitude and
 * the shape id of the path to the next stop (0: none known). `anchors` is flat, two numbers each: a time and the
 * index in `stops` of the stop the vehicle is at then.
 */
type LiveMapFleetRecord = [
  id: number, tripId: string, serviceDate: string, line: string, category: string, mode: LiveMapMode,
  operator: string, headsign: string, live: LiveMapLiveCode, base: number, stops: number[], anchors: number[],
];
interface LiveMapState {
  /** Changes when the server restarts: shape ids and `rev` are only valid within one. */
  epoch: number;
  rev: number;
  /** Everything was sent, not only what changed since `since`. */
  full: boolean;
  /** When the live feed was made; null without a live feed, left out before the first one has arrived. */
  feedUpdatedAt?: number | null;
  count: number;
  changed: LiveMapFleetRecord[];
  /** The ids of the vehicles that have finished. */
  gone: number[];
}

// ---- GET /vehicles: every vehicle on its current hop (page-old.ts)

/** One vehicle: the hop from (fx, fy) to (tx, ty), left at `dep` and reached at `arr`. `shape`: 0 when no path is known. */
type LiveMapVehicleRow = [
  tripId: string, serviceDate: string, line: string, category: string, mode: LiveMapMode, operator: string,
  headsign: string, fx: number, fy: number, tx: number, ty: number, dep: number, arr: number, nextStop: string,
  live: LiveMapLiveCode, shape: number,
];
interface LiveMapVehicles {
  /** When the snapshot was built. */
  t: number;
  epoch: number;
  feedUpdatedAt?: number | null;
  feedSource: string | null;
  buildMs: number;
  vehicles: LiveMapVehicleRow[];
}

// ---- GET /trip?id=<trip>&date=<service date>: the selected vehicle's stops

/** One stop. The times are as timetabled; the live time is `arr` + `arrDelayS`. */
interface LiveMapTripCall {
  name: string;
  /** The platform or bay: "7", "H"; '' when it has no name. */
  label: string;
  /** What `label` names: "track", "bay", … */
  noun: string;
  lat: number;
  lon: number;
  arr: number | null;
  dep: number | null;
  arrDelayS: number | null;
  depDelayS: number | null;
}
interface LiveMapTrip {
  /** The train number. */
  number: string | null;
  calls: LiveMapTripCall[];
  /** One encoded path (polyline, precision 5) per hop between consecutive stops; null where none is known. */
  segments: (string | null)[];
}

// ---- POST /shapes: the paths for these shape ids

type LiveMapShapesRequest = number[];
interface LiveMapShapes {
  epoch: number;
  /** Shape id → encoded path (polyline, precision 5, latitude first). */
  shapes: Record<string, string>;
}

// ---- page.ts with ?trace=1 → measure/browser_run.mts

/** Where the page drew one vehicle. `s` is flat, four numbers a second: time, stop index in the trip, fraction of the hop, metres moved. */
interface LiveMapTrace { g: LiveMapGroup; s: number[] }

// ---------------------------------------------------------------- the engine's JSON, as far as server.mts reads it
// (The app's full description is src/types/kante.d.ts; that file needs the app's other types.)

interface LiveMapEngineLine { name: string; category: string; mode: LiveMapMode; operator: string }
type LiveMapEngineLive = 'observed' | 'predicted' | 'timetable';

/** GET /api/vehicles?bbox=w,s,e,n */
interface LiveMapEngineVehicle {
  tripId: string;
  serviceDate: string;
  line: LiveMapEngineLine;
  headsign: string;
  /** The hop it is on: the two stops and the times it leaves one and reaches the other. */
  from: [lon: number, lat: number];
  to: [lon: number, lat: number];
  dep: number;
  arr: number;
  nextStop: string;
  nextSeq: number;
  live: LiveMapEngineLive;
}
interface LiveMapEngineVehicles { vehicles: LiveMapEngineVehicle[] }

/** GET /api/trip?id=&date= */
interface LiveMapEngineCall {
  quay: { stationName: string; label: string; noun: string; lat: number; lon: number };
  /** As timetabled; the live time is `arr` + `arrDelayS`. */
  arr?: number;
  dep?: number;
  arrDelayS?: number;
  depDelayS?: number;
}
interface LiveMapEngineTrip {
  line: LiveMapEngineLine;
  number?: string;
  calls: LiveMapEngineCall[];
}

/** GET /api/meta */
interface LiveMapEngineMeta {
  realtime: { enabled: boolean; source?: string; updatedAt?: number };
}
