// The Kante engine (kante/ in this repository; hosted at kante.omniroute.app): its JSON as this app reads it, and
// what the four scripts that work with it put on window:
//   KANTE (src/engine.ts: the client), KANTE_BOARD (src/engine-departures.ts), KanteJourney (src/engine-journey.ts),
//   KANTE_LIVE (src/live.ts: pure helpers for live data).
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

/** Which engine the page uses: `url` null = none; `ignored`: a ?kante= address in the link that was not followed. */
interface KanteEngineUrl { url: string | null; fromLink: boolean; ignored?: string }

/**
 * Why a call failed. off: the page has no engine (config.js, ?engine=off, ?kante=off); down: the request failed
 * (no answer, too slow, a server error, too many requests); refused: the engine said no to this request (`status`
 * 400, 404, 410 or 422: no route found, an unknown station), and is up.
 */
type KanteFailure = 'off' | 'down' | 'refused';
interface KanteError extends Error { reason: KanteFailure; status?: number }


// ---------------------------------------------------------------- KANTE_BOARD (src/engine-departures.ts): departure boards

/** What a board needs of a stop: an entry of PLATFORMS (src/app/30-platforms.ts). `key`: the edge's comparable name. */
interface KanteBoardStop { name: string; edges: { key: string; ll: LngLat }[] }
/** One departure of a stop's board: the engine's, with what the two lists that show it need. */
interface BoardDeparture extends KanteDeparture {
  /** Its line as the badges read it: "S7" → category S, number 7; a train without a line number by its train number. */
  shown: ShownLine;
  /** When it is expected to leave, ms: the timetable plus the live delay. */
  time: number;
  /** Whole minutes late, rounded down so that the planned time plus the delay is the time shown; 0 without live data. */
  late: number;
  /** The edges of the stop it leaves from (indices into the stop's edges); [] when the engine does not place its boarding point on one. */
  edges: number[];
}

// ---------------------------------------------------------------- KanteJourney (src/engine-journey.ts): journeys

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
/** The time picker's choice: leave at or arrive by; date "2026-11-21", time "14:05"; nothing or '' = today, now. */
type KanteTimeQuery = { mode?: 'dep' | 'arr'; date?: string | null; time?: string | null };

// ---------------------------------------------------------------- KANTE_LIVE (src/live.ts): live data, pure helpers

/** A position moved on to another moment (KANTE_LIVE.advance). */
interface KanteAdvancedPosition extends Omit<KantePosition, 'dep' | 'arr'> {
  dep?: number | null;
  arr?: number | null;
  /** Moved on from a stop only because its departure time has passed: that departure was not measured. */
  stepped?: boolean;
}
/** Where a vehicle is along the drawn ride: at a stop of the ride (index), or between two. */
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


/** GET /api/due (kante/docs/LIVE-API.md): every trip due at a boarding point, as far as the page uses it. */
interface KanteDueResponse {
  t: number;
  due: Array<{
    line?: { name: string; category?: string; mode?: string };
    headsign?: string | null;
    /** Stops on the way a display may show (LIVE-API.md). */
    vias?: string[] | null;
    quayLabel?: string | null;
    departBearing?: number | null;
    state?: 'approaching' | 'at-stop' | 'departed';
    etaS?: number | null;
    delayS?: number | null;
    cancelled?: boolean;
  }>;
}
