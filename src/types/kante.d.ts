// The Kante engine (kante/ in this repository; hosted at kante.omniroute.app): its JSON as this app reads it, and
// what the four scripts that talk to it put on window:
//   KANTE (src/engine.ts), KANTE_BOARD (src/engine-departures.ts), KanteJourney (src/engine-journey.ts),
//   KANTE_LIVE (src/live.ts).
// The JSON mirrors kante/engine/crates/server/src/json.rs; the live parts are described in kante/docs/LIVE-API.md.
// Times are unix seconds, durations seconds, distances metres, positions [longitude, latitude] unless said otherwise.

// ---------------------------------------------------------------- the engine's JSON

type KanteMode = 'rail' | 'tram' | 'bus' | 'metro' | 'boat' | 'funicular' | 'cableway' | 'rack' | 'lift' | 'ondemand' | 'other';

/** A line: name "IC61" or "10" ('' for a cable car without one), category "IC" or "T". */
interface KanteLine { name: string; category: string; mode: KanteMode; operator: string }

/** A station, an address, a point of interest or a bare coordinate. */
interface KantePlace {
  id: string;
  kind: 'station' | 'address' | 'poi' | 'coord';
  name: string;
  detail?: string;
  lat: number;
  lon: number;
  modes?: KanteMode[];
  distM?: number;
}

/** Which side of the street (or of the tracks) a boarding point is on. */
interface KanteQuaySide {
  street: string;
  side: 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';
  of: 'road' | 'tram-track' | 'rail-track';
  /** In words: "north side of Bundesgasse". */
  text: string;
}

/** A boarding point: a platform, a bay, a pier, or the stop as a whole. */
interface KanteQuay {
  id: string;
  sloid: string;
  /** "st:Parentch:1:sloid:7000"; KANTE.uicOf() gives the UIC number. */
  stationId: string;
  stationName: string;
  /** "7", "H"; '' when it has no name. */
  label: string;
  /** "AB": the sectors of the platform the train stops in. */
  sectors?: string;
  noun: 'stop' | 'edge' | 'track' | 'pier' | 'bay';
  lat: number;
  lon: number;
  /** edge: its own position; edge-at-station: named, but placed at the station; station: only the stop is known. */
  precision: 'edge' | 'edge-at-station' | 'station';
  /** The floor (0 = street level). */
  level?: number;
  side?: KanteQuaySide;
  access?: 'autonomous' | 'assisted' | 'assisted-on-notice' | 'not-accessible';
  modes: KanteMode[];
}

/** One stop of a trip. */
interface KanteStopCall {
  seq: number;
  quay: KanteQuay;
  /** As timetabled; the live time is `arr` + `arrDelayS`. */
  arr?: number;
  dep?: number;
  arrDelayS?: number;
  depDelayS?: number;
  /** Set when the platform has changed: the timetable's one (`quay` is then the one in use). */
  plannedLabel?: string;
  skipped?: boolean;
  onRequest?: boolean;
  /** The times come from a live feed, not from the timetable. */
  live?: boolean;
}

/** How sure a trip's times are (LIVE-API.md). */
interface KanteLiveInfo {
  state: 'observed' | 'predicted' | 'timetable' | 'stale';
  source?: 'siri-et' | 'gtfs-rt' | 'siri-et+gtfs-rt';
  /** The last stop with a measured time, and what was measured there. */
  observedSeq?: number;
  observedKind?: 'arr' | 'dep' | 'arr+dep';
  updatedAt?: number;
  ageS?: number;
  inaccurate?: boolean;
  congestion?: boolean;
}
/** The older engines' word for it, still sent beside `liveInfo`. */
type KanteLiveWord = 'observed' | 'predicted' | 'timetable';
/** How a position was worked out. */
type KanteBasis = 'observed-stop' | 'forecast' | 'timetable';

/** Where a vehicle is at `t`: standing at stop `seq`, or `frac` of the way from `seq` to `nextSeq`. */
interface KantePosition {
  state: 'before-start' | 'at' | 'between' | 'ended';
  seq: number;
  from: LngLat;
  to: LngLat;
  frac: number;
  basis: KanteBasis;
  t: number;
  nextSeq?: number;
  /** The times the position is timed by: leaving `seq` and reaching `nextSeq`; `at`: arriving at and leaving `seq`. */
  dep?: number;
  arr?: number;
}

// ---- GET /api/meta
interface KanteFeedStatus { name: string; updatedAt?: number; polledAt?: number; journeys?: number; matched?: number; error?: string }
interface KanteMeta {
  feedVersion: string;
  validFrom: string;
  validTo: string;
  walkBbox: KanteBbox;
  realtime: { enabled: boolean; source?: string; updatedAt?: number; trips?: number; extras?: number; error?: string; feeds?: KanteFeedStatus[] };
  /** The optional parts this engine has: 'match', 'due', 'stream', 'extras', 'gtfs-rt'. */
  features: string[];
  counts: { stations: number; quays: number; trips: number; walkEdges: number };
  attribution: string[];
}

// ---- GET /api/search, /api/reverse (answers a KantePlace)
interface KanteSearchResponse { results: KantePlace[] }
/** `bbox`: "west,south,east,north" (KANTE_LIVE.bboxParam). */
type KanteBboxParams = { bbox: string; t?: number };

// ---- GET /api/departures
/** One of `station` (the engine's id or a UIC number) and `quay`. */
type KanteDeparturesParams = { station?: string; quay?: string; time?: number; limit?: number };
interface KanteDeparture {
  line: KanteLine;
  headsign: string;
  /** The train number. */
  number?: string;
  tripId: string;
  serviceDate: string;
  seq: number;
  /** As timetabled; with `live`, `dep` + `delayS` is the time expected. */
  dep: number;
  live: boolean;
  delayS?: number;
  cancelled?: boolean;
  /** The boarding point in use. */
  quayId: string;
  /** Set when it leaves from another boarding point than planned: the planned one's name. */
  plannedLabel?: string;
  towards?: string;
  /** The compass direction it leaves in. */
  bearing?: number;
  headwayS?: number;
}
interface KanteDeparturesResponse { station: KantePlace; quays: KanteQuay[]; departures: KanteDeparture[]; realtime: boolean }

// ---- GET /api/trip
interface KanteTrip {
  tripId: string;
  /** The operating day, "2026-11-21". */
  serviceDate: string;
  line: KanteLine;
  headsign: string;
  number?: string;
  calls: KanteStopCall[];
  geometry: LngLat[];
  live: KanteLiveWord;
  cancelled?: boolean;
  headwayS?: number;
  liveInfo: KanteLiveInfo;
  position?: KantePosition;
  /** A journey that is not in the timetable (a replacement bus, an extra train). */
  extra?: boolean;
}

// ---- GET /api/vehicles, and the 'vehicles' events of /api/stream
interface KanteVehicle {
  tripId: string;
  serviceDate: string;
  line: KanteLine;
  headsign: string;
  /** The hop it is on: the two stops' boarding points and the times it leaves one and reaches the other. */
  from: LngLat;
  to: LngLat;
  dep: number;
  arr: number;
  nextStop: string;
  nextSeq: number;
  live: KanteLiveWord;
  /** How far along the hop it is at the response's `t`. */
  frac: number;
  basis: KanteBasis;
  liveInfo: KanteLiveInfo;
  extra?: boolean;
}
interface KanteVehiclesResponse { t: number; vehicles: KanteVehicle[] }

// ---- GET /api/match: the engine's trip for a ride planned elsewhere
/** What is left empty is not sent. */
type KanteMatchParams = {
  from: string | null | undefined;
  dep: number | null;
  to: string | null | undefined;
  arr: number | null;
  line?: string;
  number?: string;
};
interface KanteMatch {
  tripId: string;
  serviceDate: string;
  fromSeq: number;
  /** Missing when the ride ends on a trip this one continues as (`then`). */
  toSeq?: number;
  then?: { tripId: string; serviceDate: string; toSeq?: number }[];
}
interface KanteMatchResponse { match: KanteMatch | null; candidates: number; reason: 'unique' | 'ambiguous' | 'none' }

// ---- POST /api/plan, POST /api/walk
/** Routing options. The engine has a default for each (PlanOptions in json.rs). */
type KantePlanOptions = {
  /** m/s */
  walkSpeed?: number;
  stairs?: 'ok' | 'avoid' | 'never';
  escalators?: boolean;
  wheelchair?: boolean;
  /** Seconds added to every change. */
  transferMarginS?: number;
  maxWalkMin?: number;
  /** The modes to travel with; left out: all. */
  modes?: KanteMode[];
  maxTransfers?: number;
};
/** The options as the app sends them, from the traveller's settings (KanteJourney.options()). */
type KanteRoutingOptions = KantePlanOptions & Required<Pick<KantePlanOptions, 'walkSpeed' | 'stairs' | 'escalators' | 'wheelchair' | 'transferMarginS' | 'maxWalkMin'>>;
/** A place by the engine's id, or by coordinate. */
type KantePlaceRef = { id?: string; lat?: number; lon?: number; name?: string };
type KantePlanRequest = {
  from?: KantePlaceRef;
  to: KantePlaceRef;
  /** Leave at (or with `arriveBy`: be there by); left out: now. */
  time?: number;
  arriveBy?: boolean;
  onboard?: { tripId: string; serviceDate: string; nextSeq?: number };
  options?: KantePlanOptions;
  page?: string;
};
/** A plan request as the app sends it: always with the traveller's routing options. */
type KantePlanBody = KantePlanRequest & { options: KanteRoutingOptions };
type KanteWalkRequest = { from: KantePlaceRef; to: KantePlaceRef; options?: KantePlanOptions };

/** One written direction of a walk; `from`..`to` are its part of the walk's `geometry` (indices). */
interface KanteWalkStep {
  kind: 'depart' | 'walk' | 'cross' | 'stairs-up' | 'stairs-down' | 'escalator-up' | 'escalator-down' | 'lift' | 'ramp-up' | 'ramp-down'
    | 'enter' | 'exit' | 'platform' | 'arrive';
  text: string;
  distM: number;
  durS: number;
  name?: string;
  /** The floor it starts on, and for a floor change the one it ends on. */
  level?: number;
  toLevel?: number;
  from: number;
  to: number;
}
interface KanteWalkPoint { name: string; lat: number; lon: number; quay?: KanteQuay }
/** A walk, as /api/walk answers it. */
interface KanteWalk {
  /** access: to the first stop; transfer: a change; egress: from the last stop; direct: all the way on foot. */
  kind: 'access' | 'transfer' | 'egress' | 'direct';
  from: KanteWalkPoint;
  to: KanteWalkPoint;
  dep: number;
  arr: number;
  durationS: number;
  distanceM: number;
  stairsUp: number;
  stairsDown: number;
  lifts: number;
  escalators: number;
  stepFree: boolean;
  unmappedLevelChanges?: number;
  slackS?: number;
  officialMinS?: number;
  /** No path was found in the walking network: a straight line, timed by its length. */
  approximate?: boolean;
  geometry: LngLat[];
  /** The floor at each point of `geometry`. */
  levels: (number | null)[];
  steps: KanteWalkStep[];
}
/** A walk as a leg of a journey. */
interface KanteWalkLeg extends KanteWalk { type: 'walk' }
/** A ride on one trip, as a leg of a journey. */
interface KanteRideLeg {
  type: 'ride';
  line: KanteLine;
  headsign: string;
  number?: string;
  tripId: string;
  serviceDate: string;
  from: KanteStopCall;
  to: KanteStopCall;
  intermediate: KanteStopCall[];
  geometry: LngLat[];
  /** The vehicle goes on as this trip: you stay seated from the leg before. */
  stayOnBoard?: boolean;
  onboard?: boolean;
  headwayS?: number;
  cancelled?: boolean;
  live: KanteLiveWord;
  towards?: string;
  /** The compass direction it leaves in. */
  bearing?: number;
}
type KanteLeg = KanteRideLeg | KanteWalkLeg;
interface KanteJourneyAlert {
  severity: 'info' | 'warning' | 'severe';
  kind: 'missed-connection' | 'tight-change' | 'cancelled' | 'delay' | 'platform-change' | 'other';
  /** The leg it is about (index into `legs`). */
  leg?: number;
  text: string;
}
interface KanteJourney {
  id: string;
  dep: number;
  arr: number;
  durationS: number;
  transfers: number;
  walkS: number;
  walkM: number;
  legs: KanteLeg[];
  alerts?: KanteJourneyAlert[];
}
interface KantePlanResponse {
  from: KantePlace;
  to: KantePlace;
  journeys: KanteJourney[];
  /** Walking all the way, when that is possible. */
  walkOnly?: KanteJourney;
  /** Where to ask on for journeys before and after these: sent back as the request's `page`. */
  earlier?: string;
  later?: string;
  tookMs: number;
  realtime: boolean;
}

// ---------------------------------------------------------------- KANTE (src/engine.ts): the engine's client

/** [west, south, east, north] in degrees. */
type KanteBbox = [w: number, s: number, e: number, n: number];
/** Query parameters; the ones that are null, undefined or '' are not sent. */
type KanteParams = Record<string, string | number | boolean | null | undefined>;

/**
 * Every call answers with the engine's JSON, or throws when the engine is switched off, cannot be reached, takes
 * too long or says no (the error then has `status`, the HTTP status). After a failure the engine counts as down
 * for a minute.
 */
interface KanteApi {
  /** The engine's address without a trailing slash; '' when it is switched off. */
  base: string;
  /** Switched on, and not down just now. */
  available(): boolean;
  /** "st:Parentch:1:sloid:7000" → "8507000"; null for anything but a Swiss station. */
  uicOf(stationId: string | null | undefined): string | null;
  /** 8507000 → "st:Parentch:1:sloid:7000"; null for anything but a Swiss UIC number. */
  stationIdOf(uic: string | number): string | null;
  meta(): Promise<KanteMeta>;
  search(q: string, near?: { lat: number; lon: number } | null): Promise<KanteSearchResponse>;
  reverse(lat: number, lon: number): Promise<KantePlace>;
  departures(params: KanteDeparturesParams): Promise<KanteDeparturesResponse>;
  /** date: the trip's operating day, "2026-11-21". */
  trip(id: string, date: string): Promise<KanteTrip>;
  vehicles(params: KanteBboxParams): Promise<KanteVehiclesResponse>;
  plan(body: KantePlanRequest): Promise<KantePlanResponse>;
  walk(body: KanteWalkRequest): Promise<KanteWalk>;
}
/** Missing where engine.js is not loaded (the tests under Node). */
declare var KANTE: KanteApi | undefined;

// ---------------------------------------------------------------- KANTE_BOARD (src/engine-departures.ts): departure boards

/** What a board needs of a stop: an entry of PLATFORMS (src/app/30-platforms.ts). `key`: the edge's comparable name. */
interface KanteBoardStop { name: string; edges: { key: string; ll: LngLat }[] }
/**
 * The app's rule for where a stop is boarded when only its platform name and the way the vehicle goes are known
 * (platformLL() in src/app/32-places.ts): the position of one of the stop's edges (that very array), or null.
 */
type KantePlatformLL = (stop: OdCheckpoint, prev: LngLat | null, next: LngLat | null) => LngLat | null;
/**
 * Where a boarding point is among a stop's edges. `edges`: their indices ([] = the map has no dot for it). Without
 * `edges` only the direction of travel can tell (`guess`); with `free` it may then only choose an edge no other
 * boarding point has.
 */
interface KanteQuayEdges { edges?: number[]; guess?: boolean; free?: boolean }
/** A departure in the shape of transport.opendata.ch's stationboard, with the edges it leaves from. */
interface KanteBoardEntry extends OdStationboardEntry {
  name: string;
  category: string;
  number: string;
  operator: string;
  to: string;
  edges: number[];
}
interface KanteBoardApi {
  /**
   * The next departures of a stop, soonest first; null when the engine is off, cannot be reached or has none.
   * uic: the stop's UIC number; st: its entry in PLATFORMS; platformLL: the app's rule for a boarding point the
   * engine cannot place; edge: the edge the board is for (index; left out: the stop as a whole), which gets more
   * departures of its own when the stop's board has few.
   */
  load(uic: string | number, st: KanteBoardStop | null | undefined, platformLL?: KantePlatformLL | null, edge?: number | null): Promise<KanteBoardEntry[] | null>;
  /** The engine's answer as a board. Cancelled departures are left out. */
  toBoard(uic: string, st: KanteBoardStop, data: KanteDeparturesResponse, platformLL?: KantePlatformLL | null): KanteBoardEntry[];
  /** Which edges of the stop each boarding point is, by its id. */
  edgesOfQuays(st: KanteBoardStop, quays: KanteQuay[]): Map<string, KanteQuayEdges>;
}
/** Missing on pages that do not load engine-departures.js (scan-bench.html). */
declare var KANTE_BOARD: KanteBoardApi | undefined;

// ---------------------------------------------------------------- KanteJourney (src/engine-journey.ts): journeys

/** Which stop of a ride's passList shows which call of which trip (for the live refresh). */
interface KanteCallBinding {
  leg: KanteRideLeg;
  seq: number;
  stop: OdCheckpoint;
  /** Whether the stop's arrival, and its departure, are this trip's (at a stop where the trip changes: one each). */
  arr: boolean;
  dep: boolean;
}
/** A boarding point the engine names, in the shape of an edge of PLATFORMS. */
interface KanteQuayEdge {
  ref: string;
  bearing: null;
  /** The floor; null when the engine does not know it. */
  level: number | null;
  ll: LngLat;
  /** "north side of Bundesgasse", or ''. */
  side: string;
}
/** Where a stop of an engine journey is, as platformAt() (src/app/32-places.ts) gives it. */
interface KantePlatformAt {
  ll: LngLat;
  /** null when the engine only knows the stop, not the boarding point. */
  edge: KanteQuayEdge | null;
  /** The compass direction the vehicle leaves in, where the engine gave it. */
  travel: number | null;
}
/** One written direction of a walk, as walkDirections() (src/app/62-sheet-content.ts) lists them. */
interface KanteWalkDir {
  kind: 'depart' | 'walk' | 'stairs-up' | 'stairs-down';
  text: string;
  coords: LngLat[];
  /** A floor change: the floors it leads from and to. */
  from?: number;
  to?: number;
}
/** A walk as the app keeps a routed one. `steps` are a street router's; the engine's walk has `dirs` instead. */
interface KanteRoutedWalk { coords: LngLat[]; steps: null; dist: number | null; dirs: KanteWalkDir[] }
/** Where a walk changes floor, and between which floors. */
interface KanteFloorChange { at: LngLat; from: number; to: number }
/** The engine's walk in the three fields a step keeps a routed walk in. */
interface KanteWalkParts { lines: LngLat[][]; walks: KanteRoutedWalk[]; floors: KanteFloorChange[] }
/**
 * A step of the journey (buildSteps() in src/app/44-journey-steps.ts), as far as engine-journey.ts reads it and
 * sets it field by field. Which fields a step has depends on its `type`.
 *
 * decorate() and requay() also write, all at once (Object.assign): on a walk or change the engine has routed, a
 * KanteWalkParts (`lines`, `walks`, `floors`); on one whose end has moved, `lines` (the straight line), `walks` and
 * `floors` undefined, `kanteWalk` false; on a ride whose boarding points have moved, `depAt` and `arrAt`
 * (KantePlatformAt) with `depLL` and `arrLL`.
 */
interface KanteStep {
  type: 'walk' | 'change' | 'ride' | 'arrive';
  /** When it starts and ends, ms. */
  t0?: number | null;
  t1?: number | null;
  /** walk: the last one, to the destination. */
  final?: boolean;
  /** walk, change: the ride that follows. */
  next?: OdSection | null;
  /** walk (the last one), arrive: the ride before. */
  from?: OdSection | null;
  /** walk, change: the lines drawn on the map. */
  lines?: LngLat[][];
  /** walk (the last one): the place it leads to (its line may end at the door found for it). */
  toLL?: LngLat;
  /** change: where you get off and where you board. */
  points?: (LngLat | null | undefined)[];
  /** walk: where you board, or where you got off. */
  board?: LngLat | null;
  alight?: LngLat | null;
  /** walk: minutes; change: minutes on foot. */
  min?: number;
  walkMin?: number;
  /** arrive: where the last ride ends. */
  end?: LngLat | null;
  /** ride: its section, the stops drawn, and the line between them (the same array until a router has drawn it in). */
  s?: OdSection;
  stops?: LngLat[];
  path?: LngLat[];
  depLL?: LngLat | null;
  arrLL?: LngLat | null;
  // What decorate() and requay() add to a walk or change of an engine journey:
  /** The engine's walk. */
  kante?: KanteWalk;
  /** Its time on foot, to the second. */
  walkS?: number;
  /** The engine has routed it: `lines`, `walks` and `floors` are its path, directions and floor changes. */
  kanteWalk?: boolean;
}
/** The time picker's choice: leave at or arrive by; date "2026-11-21", time "14:05"; nothing or '' = today, now. */
type KanteTimeQuery = { mode?: 'dep' | 'arr'; date?: string | null; time?: string | null };
/** What more() needs to ask on: the request plans() sent, and the engine's pages before and after (null: none left). */
interface KantePlansState { body: KantePlanBody; earlier?: string | null; later?: string | null }
/**
 * Every way to make a trip, for the list to choose from (KanteJourney.plans()). The page makes the same from
 * transport.opendata.ch's answer when the engine has none: without `kante`, `walk` null, `earlier` and `later` false.
 */
interface KantePlans {
  /** The journeys as connections, by departure. */
  list: OdConnection[];
  /** Walking all the way, when the engine offers it (up to about 3.5 km and 50 minutes). */
  walk: OdConnection | null;
  /** The one to show first: one of `list`, or `walk`. */
  best: OdConnection;
  /** Whether more() has earlier, and later, journeys to add. */
  earlier: boolean;
  later: boolean;
  kante?: KantePlansState;
}
interface KanteJourneyApi {
  /**
   * The engine's journey to show first, as a transport.opendata.ch connection (with `kante` on it, its sections and
   * its stops); null when the engine is off, cannot be reached or finds none. fromLL: where from; dest: a search result.
   */
  find(fromLL: LngLat | null | undefined, dest: { lngLat?: LngLat | null } | null | undefined, query?: KanteTimeQuery | null): Promise<OdConnection | null>;
  /** Every journey the engine offers for the trip; null as find(). */
  plans(fromLL: LngLat | null | undefined, dest: { lngLat?: LngLat | null } | null | undefined, query?: KanteTimeQuery | null): Promise<KantePlans | null>;
  /**
   * Adds the earlier or later journeys for the same trip to plans()'s answer (`list`, `earlier`, `later`).
   * → false when there was no page to ask for. Throws when the engine cannot be reached.
   */
  more(p: KantePlans | null | undefined, dir: 'earlier' | 'later'): Promise<boolean>;
  /** Where exactly a stop of an engine journey is; null for any other stop. */
  at(stop: OdCheckpoint | null | undefined): KantePlatformAt | null;
  /** Hands every walk and change of an engine journey its engine leg: time, path, directions, floor changes. */
  decorate(steps: KanteStep[], conn: OdConnection): void;
  /** Fresh forecasts (delays, platform changes) for the rides of an engine journey, written into the sections. */
  refresh(sections: OdSection[]): Promise<void>;
  /** Writes an answer of /api/trip into the section; leg: the trip's leg, found by the trip's id when left out. */
  applyTrip(s: OdSection, trip: KanteTrip, leg?: KanteRideLeg | null): void;
  /**
   * After a refresh: moves the rides' ends, and the walks to and from them, to the boarding points now in use.
   * changed() is called whenever a line on the map has moved (also later, when a walk has been routed again).
   */
  requay(steps: KanteStep[], changed: () => void): void;
  /** The traveller's settings as routing options. */
  options(): KanteRoutingOptions;
}
declare var KanteJourney: KanteJourneyApi;

// ---------------------------------------------------------------- KANTE_LIVE (src/live.ts): live data

/** Which engine the page uses: `url` null = none; `ignored`: a ?kante= address in the link that was not followed. */
interface KanteEngineUrl { url: string | null; fromLink: boolean; ignored?: string }

/** What a GET answers, by path. */
interface KanteGetPaths {
  '/api/meta': KanteMeta;
  '/api/search': KanteSearchResponse;
  '/api/reverse': KantePlace;
  '/api/departures': KanteDeparturesResponse;
  '/api/trip': KanteTrip;
  '/api/vehicles': KanteVehiclesResponse;
  '/api/due': KanteDueResponse;
  '/api/match': KanteMatchResponse;
}
/** The live data's connection to the engine. Nothing here throws: a call that fails answers null. */
interface KanteLiveClient {
  /** The engine's address without a trailing slash; null = switched off. */
  url: string | null;
  /** The address came from the page's link (?kante=, ?engine=off). */
  fromLink: boolean;
  ignored: string | undefined;
  /** The engine's /api/meta, asked once; while it fails, again after RETRY_MS (force: now). null: not reachable, or off. */
  ready(force?: boolean): Promise<KanteMeta | null>;
  /** The engine has answered. */
  ok(): boolean;
  /** Whether the engine has an optional part ('match', 'stream', …). */
  has(feature: string): boolean;
  /** The full address of a path, e.g. for an EventSource. Only with an engine (`url`). */
  href(path: string, params?: KanteParams | null): string;
  /** ms: the timeout, 8000 when left out. */
  get<P extends keyof KanteGetPaths>(path: P, params?: KanteParams | null, ms?: number): Promise<KanteGetPaths[P] | null>;
}

/** A position moved on to another moment (KANTE_LIVE.advance). */
interface KanteAdvancedPosition extends Omit<KantePosition, 'dep' | 'arr'> {
  dep?: number | null;
  arr?: number | null;
  /** Moved on from a stop only because its departure time has passed: that departure was not measured. */
  stepped?: boolean;
}
/** Where a vehicle is along the drawn ride: at a stop of the passList (index), or between two. */
type KanteRideKm = { km: number; at: number; from?: undefined; to?: undefined } | { km: number; at?: undefined; from: number; to: number };
/** What is known about how a position was worked out. */
interface KanteLiveContext {
  basis?: KanteBasis | null;
  /** The stop it left, by name… */
  from?: string | null;
  /** …and the seconds since its measured departure from there. */
  leftS?: number | null;
  /** The stop with the last measured time, by name. */
  observedAt?: string | null;
}
/** The line of a vehicle as the journey object the app colours lines by. */
interface KanteJourneyLike { category: string; number: string; operator: string; name: string }
/** A trip or a vehicle: anything that says how live it is. */
type KanteLiveCarrier = { liveInfo?: KanteLiveInfo | null; live?: KanteLiveWord | boolean | null };
/** What places a vehicle of /api/vehicles; `t`: the time of the response it came in. */
type KanteVehicleHop = Pick<KanteVehicle, 'from' | 'to' | 'dep' | 'arr'> & { frac?: number | null; t?: number | null };
/** A vehicle of /api/vehicles, as far as it tells whether it has left a stop; `info`: its liveInfoOf(), when already worked out. */
type KanteVehicleSeen = Partial<Pick<KanteVehicle, 'from' | 'to' | 'nextSeq'>> & KanteLiveCarrier & { info?: KanteLiveInfo | null };
/** late: the walk is longer than the time left; tight: under three minutes to spare. */
interface KanteRunOrWait { text: string; level: 'late' | 'tight' | 'ok' }

interface KanteLiveApi {
  DEFAULT_URL: string;
  /** The largest box the engine answers /api/vehicles for (its diagonal, km). */
  MAX_BBOX_KM: number;
  /** ms after which a failed /api/meta is asked again. */
  RETRY_MS: number;
  /** search: the page's query string; config: APP_CONFIG. */
  engineUrl(search?: string | null, config?: { kanteUrl?: unknown } | null): KanteEngineUrl;
  /** Is this an origin on this machine (localhost, 127.x, [::1])? */
  isLocalUrl(u: string | null | undefined): boolean;
  client(search?: string | null, config?: { kanteUrl?: unknown } | null): KanteLiveClient;
  /** A stop's planned time, unix seconds. */
  unixOf(stop: OdCheckpoint | null | undefined, which: 'departure' | 'arrival'): number | null;
  /** The parameters of /api/match for a ride. label: the line as shown; train: its `name` is a train number. */
  matchParams(s: OdSection, label?: string | null, train?: boolean): KanteMatchParams;
  liveInfoOf(x: KanteLiveCarrier | null | undefined): KanteLiveInfo | null;
  /** Measured or forecast, and recent. */
  isLive(info: KanteLiveInfo | null | undefined): boolean;
  /** A call's live times: the timetable plus the delay. */
  liveArr(c: KanteStopCall | null | undefined): number | null;
  liveDep(c: KanteStopCall | null | undefined): number | null;
  /** The engine's call for each stop of the passList (null where it has none). */
  alignCalls(trip: Pick<KanteTrip, 'calls'> | null | undefined, match: Pick<KanteMatch, 'fromSeq' | 'toSeq'> | null | undefined,
    passList: OdCheckpoint[] | null | undefined): (KanteStopCall | null)[];
  /** The engine's seq → the place in the passList, from alignCalls(). */
  seqIndex(aligned: (KanteStopCall | null)[] | null | undefined): Map<number, number>;
  sameStation(x: OdCheckpoint | null | undefined, c: KanteStopCall | null | undefined): boolean;
  uicOf(id: string | null | undefined): string | null;
  /** Writes the trip's live times and platform into the section's prognosis. → whether the trip has live data. */
  applyTrip(s: OdSection, trip: KanteTrip | null | undefined, match: KanteMatch | null | undefined): boolean;
  /** Was the departure from stop `seq` measured? */
  depMeasured(info: KanteLiveInfo | null | undefined, seq: number | null | undefined): boolean;
  /** The next call after `seq` that the vehicle stops at. */
  nextCall(calls: KanteStopCall[] | null | undefined, seq: number): KanteStopCall | null;
  /** Where the vehicle is at tNow, going on from the engine's position. */
  advance(pos: KantePosition | null | undefined, calls: KanteStopCall[] | null | undefined, tNow: number): KanteAdvancedPosition | null;
  /**
   * …as km along the drawn ride. seqIdx: seqIndex(); kms: each drawn stop's km; stopIdx: each drawn stop's place
   * in the passList. null when it is not on this part of the trip.
   */
  rideKm(p: KanteAdvancedPosition | null | undefined, seqIdx: Map<number, number> | null | undefined, kms: (number | null | undefined)[], stopIdx: number[]): KanteRideKm | null;
  /** Says how a position was worked out. dim: it is not live. */
  liveText(info: Pick<KanteLiveInfo, 'state' | 'inaccurate' | 'congestion'> | null | undefined, ctx?: KanteLiveContext | null): { text: string; dim: boolean };
  /** Seconds until it leaves, seconds of walking left. */
  runOrWait(leftS: number, walkS: number): KanteRunOrWait;
  journeyLike(line: Partial<KanteLine> | null | undefined): KanteJourneyLike;
  /** Where a vehicle of /api/vehicles is at tNow. */
  vehicleAt(v: KanteVehicleHop, tNow: number): LngLat;
  /** Under way after a measured departure from the stop before. */
  vehicleLeftMeasured(v: KanteVehicleSeen | null | undefined): boolean;
  /** The box grown by a share of its size on every side, kept within the engine's limit. */
  padBbox(b: KanteBbox, share: number): KanteBbox;
  bboxContains(outer: KanteBbox | null | undefined, inner: KanteBbox): boolean;
  /** Small enough for the engine. */
  bboxOk(b: KanteBbox): boolean;
  /** "w,s,e,n" with 5 decimals. */
  bboxParam(b: KanteBbox): string;
  distKm(a: LngLat, b: LngLat): number;
  /** For comparing names: lower case, no accents, letters and digits only. */
  norm(t: string | null | undefined): string;
  /** A URL's origin, or null when it is not an http(s) URL. */
  originOf(u: string | null | undefined): string | null;
}
declare var KANTE_LIVE: KanteLiveApi;

/** GET /api/due (kante/docs/LIVE-API.md): every trip due at a boarding point, as far as the page uses it. */
interface KanteDueResponse {
  t: number;
  due: Array<{
    line?: { name: string; category?: string; mode?: string };
    headsign?: string | null;
    quayLabel?: string | null;
    departBearing?: number | null;
    state?: 'approaching' | 'at-stop' | 'departed';
    etaS?: number | null;
    delayS?: number | null;
    cancelled?: boolean;
  }>;
}
