// Live tracking (src/app/50-tracking.ts … 58-live-vehicles.ts): where you and your vehicle are on the trip, the
// live line in the sheet's header, live data from the Kante engine, live vehicles on the map. The types these
// parts share with each other and with the rest of the page's script.

// ---------------------------------------------------------------- your place on the trip

/** A place on the trip: the step (its index in journeySteps) and how many km into that step's line. */
interface TripPlace { i: number; kmIn: number }

/** Where the live timetable says you are (timeProgress()). ended: the last timed step is over. */
interface TimedPlace extends TripPlace { ended?: boolean }

/** A GPS position snapped onto the trip (snapToTrip()). */
interface TripSnap extends TripPlace {
  /** What the snap was chosen by: metres off the line, plus the penalties for going backwards and boarding early. */
  cost: number;
  /** Metres off the line. */
  d: number;
  /** km into the whole trip. */
  km: number;
}

/** GPS progress (`track`): the last fix snapped onto the trip. */
interface TrackState extends TripSnap {
  /** The geoVersion its km were measured on. */
  v: number;
  /** Fixes in a row that were off the line; two make it `off`. */
  offCount: number;
  off: boolean;
  /** The ride that has left without you (missedRide()). */
  missed?: JourneyRideStep | null;
  /** Within 25 m of the trip's end, or 40 m of the destination. */
  arrived?: boolean;
}

/** The trip's steps laid end to end (tripLayout()): each step's length and where it starts, in km. */
interface TripLayout {
  /** The geoVersion and the steps it was measured for. */
  v: number;
  steps: JourneyStep[];
  lens: number[];
  km0: number[];
  total: number;
}

/** The closest point of a segment to a position (projectSeg()): metres away, and 0…1 along the segment. */
interface SegProjection { d: number; t: number }

// ---------------------------------------------------------------- the vehicle of a ride

/** Where a ride's vehicle is along the ride's line: at a stop (its name), or between two. */
interface VehiclePlace {
  km: number;
  at?: string | null;
  from?: string | null;
  to?: string | null;
}
/** …placed by the Kante engine: its position moved on to `tNow` (the engine's clock, unix seconds). */
interface EngineVehiclePlace extends VehiclePlace { engine: KanteAdvancedPosition; tNow: number }
/** …placed from the ride's live stop times. */
interface TimedVehiclePlace extends VehiclePlace { engine?: undefined; tNow?: undefined }
/** vehicleState() */
type VehicleState = EngineVehiclePlace | TimedVehiclePlace;

// ---------------------------------------------------------------- the live line in the sheet's header

/** One piece of the live line: text, or an element (a line badge, a delay, a platform change); null is skipped. */
type LiveLinePart = string | HTMLElement | null;
/** liveParts(): the live line. */
interface LiveLine {
  /** off: something is wrong (off the route, a ride missed or cancelled); gps: from your position; est: from the live timetable. */
  kind: 'off' | 'gps' | 'est';
  parts: LiveLinePart[];
  /** Offer "Replan". */
  replan?: boolean;
  /** The second half: what is left of the trip, or whether to hurry. */
  rest?: string;
  restLevel?: KanteRunOrWait['level'] | null;
}

// ---------------------------------------------------------------- live data from the Kante engine

/**
 * A ride's link to the engine's trip (56-live-engine.ts), kept on its section as `_k`.
 * matching: /api/match is being asked; error: it could not be reached (asked again, three times at most);
 * none: no sure match; chain: the ride stays seated over several trips (not polled here);
 * ok: matched, and polled while the trip is on.
 */
type KanteRideLink = KanteRideMatched | KanteRideUnmatched;
/** Matched: /api/trip is asked for it every 30 s while the trip is on. */
interface KanteRideMatched {
  state: 'ok';
  /** The engine's trip and the stops you ride between. */
  match: KanteMatch;
  /** When `trip` came in (ms; 0 = not yet). */
  at: number;
  /** The last answer of /api/trip. */
  trip?: KanteTrip;
  /** The engine's seq → the stop's place in the passList (KANTE_LIVE.seqIndex()). */
  seqIdx?: Map<number, number>;
  /** A request for the trip is under way. */
  busy?: boolean;
  /** Polls in a row without an answer. */
  fails?: number;
  /** The engine is no longer the ride's source, and transport.opendata.ch has been asked instead. */
  handedBack?: boolean;
  /** How often /api/match was asked, and when last (ms); a ride of an engine journey was never asked for. */
  tries?: number;
  tried?: number;
}
/** Not matched (yet), or a chain: nothing of a trip is kept. */
interface KanteRideUnmatched {
  state: 'matching' | 'chain' | 'error' | 'none';
  tries?: number;
  tried?: number;
  /** chain: the first trip, as /api/match gave it. */
  match?: KanteMatch;
  at?: number;
  trip?: undefined;
  seqIdx?: undefined;
  fails?: undefined;
}

interface OdSection {
  /** 56-live-engine.ts: the engine's trip for this ride. */
  _k?: KanteRideLink;
  /** 54-live-timetable.ts: when transport.opendata.ch's forecasts for this ride were last refreshed (ms). */
  _liveAt?: number;
}

/** The last on-board check (`onboard`): which vehicle the engine thinks you are on. */
interface OnboardState {
  /** The step you were on. */
  step: number;
  /** The planned vehicle is among the candidates, and was recognised by its trip. */
  ours: boolean;
  byTrip: boolean;
  /** Clearly another vehicle: that one. */
  top: KanteOnboardCandidate | null;
  /** How many checks in a row gave the same other vehicle. */
  streak: number;
  /** When (ms). */
  at: number;
}

// ---------------------------------------------------------------- live vehicles on the map

/** A vehicle of /api/vehicles as the map keeps it: with the response's time, its line as a journey, and how live it is. */
interface LiveVehicle extends KanteVehicle {
  t: number;
  j: KanteJourneyLike;
  info: KanteLiveInfo | null;
}
/** What the map's 'kveh' source says about a vehicle. i: its index in the list. */
interface LiveVehicleProps {
  i: number;
  label: string;
  /** The line's colour on the light and on the dark map. */
  bg: string;
  dfg: string;
  /** Not in the timetable. */
  extra: boolean;
  /** Not live (or not updated for a while): drawn faded. */
  dim: boolean;
}
type LiveVehicleCollection = GeoJSON.FeatureCollection<GeoJSON.Point, LiveVehicleProps>;

// ---------------------------------------------------------------- small helpers (the end of 58-live-vehicles.ts)

/** A platform as the timetable writes it, taken apart: "7A-D" → num "7", sectors "A–D". */
interface PlatformParts { num: string; sectors: string }
