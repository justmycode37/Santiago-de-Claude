// The Kante engine (kante/ in this repository; hosted at kante.omniroute.app): its JSON as this app reads it. The
// modules that work with it have their own types: src/engine.ts (the client), src/engine-departures.ts,
// src/engine-journey.ts, src/live.ts.
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
  /** /api/search: what to draw ('station', 'address', or a place's: 'restaurant', 'cafe', 'museum' …; kante/docs/SEARCH.md). */
  icon?: string;
  /** /api/search, places: the category ('Restaurant'), also the first part of `detail`. */
  category?: string;
  /** /api/search, places: what OpenStreetMap knows about them, when anything. */
  info?: KantePoiInfo;
}

/** What a map shows about a place besides its name (/api/search). Every field may be missing. */
interface KantePoiInfo {
  /** 'Italian, Pizza' */
  cuisine?: string;
  /** 'Vegan options', 'Vegetarian' */
  diet?: string;
  /** OpenStreetMap's opening_hours, as mapped */
  openingHours?: string;
  website?: string;
  phone?: string;
  /** A photo: an https URL of an image */
  image?: string;
  /** Its Wikidata item ('Q72'): the photo there (P18) when there is no `image` */
  wikidata?: string;
  /** Its brand's Wikidata item: the brand's logo (P154) */
  brandWikidata?: string;
  stars?: string;
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

/** Where a vehicle is at `t`: standing at stop `seq`, or `frac` of the time from leaving `seq` to reaching `nextSeq`. */
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
  /** `between`: the way from `from` to `to` on the rails and roads (Google encoded polyline, precision 5), from where
   *  the vehicle stands at one stop to where it stands at the next. Absent where only the straight line is known. */
  hopPath?: string;
  /** Some of `hopPath` is a straight line (a stop off the map). */
  hopStraight?: boolean;
  /** When `hopPath` is only part of the hop's way (/api/vehicles, near the window asked about): the shares of the
   *  whole way's length it starts and ends at. */
  hopSpan?: [number, number];
  /** Where the vehicle is at `t` on its track or road (`between`: as far as `motion` takes it in `frac` of the time; otherwise where it
   *  stands at `seq`). */
  point?: LngLat;
  /** `between`: the direction it drives in at `point`, degrees from north. */
  heading?: number;
  /** How it moves on the hop: [accel, brake, cruise] (m/s², m/s², m/s), from `dep` to `arr`; absent: at an even pace. */
  motion?: [number, number, number];
  /** The hop's length on its way, metres (with `motion`). */
  hopLen?: number;
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
  /** The commit the engine was built from; null for a build without KANTE_COMMIT. Older engines send neither. */
  commit?: string | null;
  /** The release the engine runs from (the folder of its executable); null if unknown. */
  release?: string | null;
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
  /** The way the vehicle takes on the rails and roads (`geometry` is the straight line through the stops), from where
   *  it stands at the first call to where it stands at the last; absent from an engine without its shapes. */
  path?: LngLat[];
  /** Per call: its vertex in `path`. */
  pathAt?: number[];
  /** The hops (by the index of the call they start at) where `path` is a straight line: a stop off the map. */
  straightHops?: number[];
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
  /** `between`: the way from `from` to `to` on the rails and roads (Google encoded polyline, precision 5), from where
   *  the vehicle stands at one stop to where it stands at the next. Absent where only the straight line is known. */
  hopPath?: string;
  /** Some of `hopPath` is a straight line (a stop off the map). */
  hopStraight?: boolean;
  /** When `hopPath` is only part of the hop's way (/api/vehicles, near the window asked about): the shares of the
   *  whole way's length it starts and ends at. */
  hopSpan?: [number, number];
  /** Where the vehicle is at `t` on its track or road (`between`: as far as `motion` takes it in `frac` of the time; otherwise where it
   *  stands at `seq`). */
  point?: LngLat;
  /** `between`: the direction it drives in at `point`, degrees from north. */
  heading?: number;
  /** How it moves on the hop: [accel, brake, cruise] (m/s², m/s², m/s), from `dep` to `arr`; absent: at an even pace. */
  motion?: [number, number, number];
  /** The hop's length on its way, metres (with `motion`). */
  hopLen?: number;
  /** The hop after this one, so a page can drive the vehicle on through the stop until the next answer. */
  onward?: KanteOnward;
  /** The hop before: the way it came along into the stop it stands at (or has left), for its tail. */
  behind?: { hopPath: string; hopSpan?: [number, number] };
}
/** The hop a vehicle drives after the one it is on: from the stop it stands at (or is heading for) to the next. */
interface KanteOnward {
  nextSeq: number;
  to: LngLat;
  /** When it leaves that stop, and reaches `nextSeq`. */
  dep: number;
  arr: number;
  hopPath?: string;
  hopStraight?: boolean;
  hopSpan?: [number, number];
  /** How it moves on the hop: [accel, brake, cruise] (m/s², m/s², m/s), from `dep` to `arr`; absent: at an even pace. */
  motion?: [number, number, number];
  /** The hop's length on its way, metres (with `motion`). */
  hopLen?: number;
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
  /** How much hills matter for the way taken (walking times count them whatever this says): ignore = the quickest
   *  way, hills or not; normal = a flatter way when it is little longer; avoid = a flatter way even a few minutes
   *  longer. An engine without a terrain model ignores it. */
  hills?: 'ignore' | 'normal' | 'avoid';
  /** At a change with time to spare, walk the flatter way when it still leaves a minute in hand (with hills: normal). */
  flatterChanges?: boolean;
  /** Seconds added to every change, on top of the walk between the two platforms (the engine's default: 0). */
  transferMarginS?: number;
  /** The longest walk to the first stop and from the last. A journey with a longer one (up to twice as long) is
   *  offered beside the others where it has half an hour on them (arriving sooner, leaving later), or where there
   *  is none; it carries a `long-walk` alert. */
  maxWalkMin?: number;
  /** The modes to travel with; left out: all. */
  modes?: KanteMode[];
  /** The most changes; left out: as many as the engine can follow (14). */
  maxTransfers?: number;
};
/** The options as the app sends them, from the traveller's settings (KanteJourney.options()). */
type KanteRoutingOptions = KantePlanOptions & Required<Pick<KantePlanOptions, 'walkSpeed' | 'stairs' | 'escalators' | 'wheelchair' | 'hills' | 'flatterChanges' | 'transferMarginS' | 'maxWalkMin'>>;
/** A place by the engine's id, or by coordinate. */
/** `quay` (/api/walk only): a boarding point by its id, walked from or to on its own platform and floor; `exact`
 *  (/api/walk only): the point as it is, not the door of the building it lies in. An older engine ignores both. */
type KantePlaceRef = { id?: string; lat?: number; lon?: number; name?: string; quay?: string; exact?: boolean };
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
/** `limitS`: the walk this walker prefers when it takes at most that long, else the quickest (a change, re-asked). */
/** time: when the walk sets out (Unix seconds): ways closed then are avoided; without it every way is open. */
type KanteWalkRequest = { from: KantePlaceRef; to: KantePlaceRef; options?: KantePlanOptions; limitS?: number; time?: number };

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
  /** Metres climbed and descended on the way (left out when 0, and by an engine without a terrain model). */
  climbM?: number;
  descentM?: number;
  /** A change walked a flatter way than the quickest, because there is time for it: how much longer, how much less
   *  climbing. */
  flatter?: { extraS: number; lessClimbM: number };
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
  // From engines that know buildings' doors (all optional: an older engine sends none of these)
  /** The door of the destination building the walk ends at (its last point), and the one it starts from. */
  door?: KanteWalkDoor;
  startDoor?: KanteWalkDoor;
  /** Stretches under a roof, as ranges of `geometry`. */
  covered?: { kind: 'arcade' | 'passage' | 'underpass' | 'indoors'; from: number; to: number }[];
  /** Points 0…approxStart and approxEnd… of `geometry` are a guess (a straight line across open ground, or into or
   *  out of a building through no known door, possibly through a wall). Older engines send neither. */
  approxStart?: number;
  approxEnd?: number;
  /** Points network[0]…network[1] are on the walking network; the others are the straight lines to and from it. */
  network?: [number, number];
  /** Step-free: the destination building has doors, but none is step-free. */
  noStepFreeDoor?: boolean;
  /** Metres on ways closed at the walk's time (opening hours), taken because no open way would do. */
  closedM?: number;
}
/** A door of a building: OSM's `entrance=*` (main, yes, shop, service, …), or `addr` for a point of the official
 *  building address register. */
interface KanteWalkDoor { lat: number; lon: number; kind: string; addr?: string; wheelchair?: 'yes' | 'no' | 'limited' }
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
  /** The way the vehicle takes on the rails and roads (`geometry` is the straight line through the stops), from where
   *  it stands at the first call to where it stands at the last; absent from an engine without its shapes. */
  path?: LngLat[];
  /** Per call: its vertex in `path`. */
  pathAt?: number[];
  /** The hops (by the index of the call they start at) where `path` is a straight line: a stop off the map. */
  straightHops?: number[];
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
  /** long-walk: the walk to the first stop or from the last (`leg`) is longer than `maxWalkMin`; the engine offers
   *  such a journey beside those that keep to it where it has half an hour on them, or where there is none. */
  kind: 'missed-connection' | 'tight-change' | 'cancelled' | 'delay' | 'platform-change' | 'long-walk' | 'other';
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

/** GET /api/due (kante/docs/LIVE-API.md): every trip due at a boarding point, as far as the page uses it. */
interface KanteDueResponse {
  t: number;
  /** Nothing is missing: the list was not cut at `limit` and the live feed is not stale (LIVE-API.md). */
  complete?: boolean;
  /** More trips were due than `limit`. */
  truncated?: boolean;
  due: Array<{
    tripId?: string;
    serviceDate?: string;
    line?: { name: string; category?: string; mode?: string };
    headsign?: string | null;
    /** Stops on the way a display may show (LIVE-API.md). */
    vias?: string[] | null;
    quayId?: string | null;
    quayLabel?: string | null;
    /** Live departure here, unix seconds; null where it only sets down. */
    dep?: number | null;
    /** With `to=`: whether it calls there after this stop. */
    servesTo?: boolean | null;
    /** arr/dep come from the learned hop and dwell profiles after a measured stop. */
    profiled?: boolean;
    /** Riders may board here (false: it only sets down, or is skipped today). */
    pickup?: boolean;
    /** Boarding points of the stops before and after this one. */
    prevStop?: LngLat | null;
    nextStop?: LngLat | null;
    departBearing?: number | null;
    state?: 'approaching' | 'at-stop' | 'departed';
    etaS?: number | null;
    delayS?: number | null;
    cancelled?: boolean;
  }>;
}
