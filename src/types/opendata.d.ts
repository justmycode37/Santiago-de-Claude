// transport.opendata.ch (the public Swiss timetable API, https://transport.opendata.ch/docs.html): the parts of its
// answers this app reads. Journeys from the Kante engine are turned into the same shapes (src/engine-journey.ts,
// src/engine-departures.ts), so the fields that only the API gives are optional.
//
// The app also hangs its own data onto these objects. The fields the engine scripts set are declared here; a
// script that sets others adds them from its own declaration file (interfaces of the same name merge).

/** WGS84. Mind the names: x is the latitude, y the longitude. */
interface OdCoordinate { type?: string; x: number | null; y: number | null }

/** A station, or another place a walk starts or ends at. */
interface OdLocation {
  /** A station's UIC number ("8507000"); for a stop the engine has no number for, the engine's own station id. */
  id?: string | null;
  name?: string | null;
  score?: number | null;
  coordinate?: OdCoordinate | null;
  distance?: number | null;
}

/** What is expected today: live times (ISO 8601) and the platform when it has changed. */
interface OdPrognosis {
  platform?: string | null;
  arrival?: string | null;
  departure?: string | null;
  capacity1st?: number | null;
  capacity2nd?: number | null;
  /** src/live.ts: the platform the engine wrote into `platform`, and what was there before. */
  _kPlatform?: string;
  _kPrev?: string | null;
}

/** A stop of a ride, or one end of a section or of the whole connection. Times are ISO 8601, timestamps unix seconds. */
interface OdCheckpoint {
  /** Missing at the free end of a walk of an engine journey (that one has `location`). */
  station?: OdLocation | null;
  location?: OdLocation | null;
  arrival?: string | null;
  arrivalTimestamp?: number | null;
  departure?: string | null;
  departureTimestamp?: number | null;
  /** Minutes late. */
  delay?: number | null;
  /** The platform as timetabled ("7", "7AB", "H"). */
  platform?: string | null;
  prognosis?: OdPrognosis | null;
  /** src/engine-journey.ts: the engine's call at this stop (its boarding point, times, delays). */
  kante?: KanteStopCall;
  /** src/engine-journey.ts: the compass direction the vehicle leaves in, on the first stop of a ride. */
  kanteBearing?: number;
}

/** A line as the timetable names it: category "IC", number "8", name "IC 8" (for trains: the train number). */
interface OdLine {
  name: string | null;
  category: string | null;
  number: string | null;
  operator: string | null;
  /** Where it goes (the headsign). */
  to: string | null;
}

/** One ride: its line and every stop it passes, the boarding and alighting stops included. */
interface OdJourney extends OdLine {
  passList: OdCheckpoint[];
}

interface OdWalk {
  /** Seconds. */
  duration: number | null;
}

/** A part of a connection: a ride (`journey`) or a walk (`journey` is null). */
interface OdSection {
  journey: OdJourney | null;
  walk: OdWalk | null;
  departure: OdCheckpoint;
  arrival: OdCheckpoint;
  /** src/engine-journey.ts: the engine's leg (of a ride over several trips: the first one). */
  kante?: KanteLeg;
  /** src/engine-journey.ts, rides: every trip of the ride, in order (more than one when you stay seated). */
  kanteLegs?: KanteRideLeg[];
  /** src/engine-journey.ts, rides: which stop of the passList shows which call of which trip. */
  kanteCalls?: KanteCallBinding[];
}

interface OdConnection {
  from: OdCheckpoint;
  to: OdCheckpoint;
  /** "00d00:43:00"; an engine journey has none. */
  duration?: string | null;
  transfers?: number;
  products?: string[];
  sections: OdSection[];
  /** src/engine-journey.ts: the engine's journey this connection was made from. */
  kante?: KanteJourney;
}

/** One departure of a stop's board: the line, and the stop with its time and platform. */
interface OdStationboardEntry extends OdLine {
  stop: OdCheckpoint;
  /** The API's boards have it; the engine's do not. */
  passList?: OdCheckpoint[];
  /** src/engine-departures.ts: the edges of the stop it leaves from (indices into the stop's edges; [] = none on the map). */
  edges?: number[];
}

/** GET /v1/connections */
interface OdConnectionsResponse { connections?: OdConnection[] }
/** GET /v1/stationboard */
interface OdStationboardResponse { station?: OdLocation; stationboard?: OdStationboardEntry[] }
/** GET /v1/locations */
interface OdLocationsResponse { stations?: OdLocation[] }
