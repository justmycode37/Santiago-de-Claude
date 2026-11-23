// The journey (src/app/40-journey-map.ts, 44-journey-steps.ts, 70-routing.ts): the trip that is on show, the steps
// it is made of, its line on the map and the routers that draw it. The types those parts share with the rest of
// the page's script.
//
// JourneyStep is a union of the four kinds of step, so `st.type === 'ride'` narrows it. A field only another kind
// has reads as undefined, so `st.lines || []` works on any step. To add a field to every step from another
// declaration file, merge it into JourneyStepBase (`interface JourneyStepBase { … }`), or into the kind it belongs to.

// ---------------------------------------------------------------- the two ends

/**
 * Where a trip goes to, or starts: a search result, a place or an event picked on the map, or a dropped pin.
 * This is what the journey reads of it; a search result (SearchResult) has more.
 */
interface JourneyDest {
  title: string;
  lngLat: LngLat;
  /** Where a search result comes from ('address', 'gg25', 'gazetteer', 'place', 'pin', …); a place or event of the map has none. */
  origin?: string;
}

/** Where a plan starts from (startJourney()): the place, and its name in the sheet ("Your location", "Map centre", a start). */
interface JourneyOrigin { ll: LngLat; label: string }

// ---------------------------------------------------------------- a journey

/**
 * A journey as the app keeps it: the engine's journey (POST /api/plan, kante/engine/crates/server/src/json.rs),
 * with its legs laid out as the trip is shown (`parts`) and the times the app shows for it. KanteJourney.plans()
 * (src/engine-journey.ts) makes them.
 */
interface Journey extends KanteJourney {
  /**
   * The legs as the trip is shown, in order: rides (each one or more of the engine's ride legs) and the engine's
   * walk legs. A change at the very same boarding point has no walk.
   */
  parts: JourneyPart[];
  /** When it starts, ms: the engine's `dep`. */
  t0: number;
  /** When it arrives as timetabled, ms: the last ride's arrival plus the walk after it (a later live arrival is the steps'). */
  t1: number;
}
type JourneyPart = JourneyRide | KanteWalkLeg;

/** A line as the badges, colours and modes read it (lineLabel(), lineColor(), modeOf()): category "IC", number "8". */
interface ShownLine { name: string; category: string; number: string; operator: string }

/**
 * One ride: the trips of the engine you ride (more than one when you stay seated while the vehicle goes on as
 * another trip; it is shown under the line you board), and every stop it stops at.
 */
interface JourneyRide {
  type: 'ride';
  /** The engine's ride legs, in order. */
  legs: KanteRideLeg[];
  /** The first leg's line, as shown. */
  line: ShownLine;
  /** Where it goes (the first leg's headsign). */
  headsign: string;
  /**
   * The engine's calls at every stop it stops at, where you board and where you get off included (stops it skips
   * today are left out). At a stop where the trip changes there is one, with the arrival of the trip before and
   * the departure of the next. Live data (applyTrip()) is written into these objects, so they stay the same ones.
   */
  stops: KanteStopCall[];
  /** stops[0] and the last of them: where you board and where you get off. */
  from: KanteStopCall;
  to: KanteStopCall;
  /** For each leg: its call's seq → the stop's place in `stops`. */
  seqIdx: Map<number, number>[];
  /** For each leg: what the engine said last about its trip (56-live-engine.ts). */
  live: RideTripLive[];
}
/** What the engine said last about one trip of a ride: GET /api/trip, asked every 30 s while the trip is on. */
interface RideTripLive {
  /** The last answer. */
  trip?: KanteTrip;
  /** When it came in (ms; 0 = not yet). */
  at: number;
  /** Polls in a row without an answer. */
  fails: number;
  /** A request is under way. */
  busy?: boolean;
}

// ---------------------------------------------------------------- the journeys to choose from

/** Every way on offer to make the trip (`journeyOptions`), as KanteJourney.plans() answers. */
interface JourneyOptions {
  /** By public transport, in order of departure. */
  list: Journey[];
  /** On foot all the way, when that is near enough (up to about 3.5 km and 50 minutes); else null. */
  walk: Journey | null;
  /** The one shown first: one of `list`, or `walk`. */
  best: Journey;
  /** Whether there are earlier and later ones to fetch (KanteJourney.more()). */
  earlier: boolean;
  later: boolean;
  /** What more() asks on with: the request plans() sent, and the engine's pages before and after (null: none left). */
  request: { body: KantePlanBody; earlier?: string | null; later?: string | null };
}
/** The list's two tabs: by public transport, or on foot all the way. */
type JourneyTab = 'pt' | 'walk';
/** Which way the list is being extended (`journeyMore`). */
type JourneyMoreDir = 'earlier' | 'later';

// ---------------------------------------------------------------- lines

/** How a line runs, as far as its timetable category tells (modeOf()). */
type LineMode = 'train' | 'tram' | 'bus' | 'boat' | 'cable';
/** What tells a line apart: a ride's line, a departure of a board, or a live vehicle's line. */
interface LineLike { category?: string | null; number?: string | null; operator?: string | null }
/** A line's colour, one of the app's palette: badge background and text on the light theme, and on the dark one. */
interface LineColor { name: string; bg: string; fg: string; dbg: string; dfg: string }

// ---------------------------------------------------------------- where a ride stops

/** The platform or stop edge a ride is boarded at, as the engine names it (KanteJourney.at()). */
interface JourneyEdge {
  /** Its name ("7", "H"); '' when it has none. */
  ref: string;
  /** The floor; null (or 0) at street level, or when it is not known. */
  level: number | null;
  ll: LngLat;
  /** "north side of Bundesgasse", or ''. */
  side: string;
}
/** Where a stop of a ride is (KanteJourney.at()). */
interface JourneyPlatformAt {
  ll: LngLat;
  /** The engine's boarding point (its quay id). */
  quay?: string;
  /** null: the engine only knows the stop, not the platform or edge. */
  edge: JourneyEdge | null;
  /** The compass direction the vehicle leaves in. */
  travel: number | null;
}

// ---------------------------------------------------------------- walks

/**
 * A routed walk (routeWalk(), stationWalk(), and the engine's): its line, its metres (null when no router found a
 * way and it is the straight line), and its directions written out in `dirs` (a station model's, the engine's).
 */
interface RoutedWalk {
  coords: LngLat[];
  steps: null;
  dist: number | null;
  dirs?: KanteWalkDir[];
  /** Routed on a walking network (the engine's): the blue dot may sit on it. */
  net?: boolean;
  /** A straight line, not a route (no router found a way). */
  approx?: boolean;
  /** Coordinate indices: the guessed straight bits from the start (0…approxTo) and to the end (approxFrom…). */
  approxTo?: number | null;
  approxFrom?: number | null;
  /** Stretches under arcades, through passages and underpasses, indoors. */
  covered?: { kind: string; coords: LngLat[] }[];
  /** The door the walk ends at. */
  door?: { ll: LngLat; type: string; addr: string } | null;
  floors?: KanteFloorChange[];
  /** The engine's time for it, seconds, and as the trip shows it (at least half a minute when it has a way to go). */
  walkS?: number;
  shownS?: number;
}
/** What an end of a walk is: your position (GPS), a boarding point (on its floor, by its number and the engine's
 *  `quay` id), a point taken as it is (where a station model's own paths begin), or a place (the walk ends at its door). */
interface WalkEnd {
  gps?: boolean;
  platform?: boolean;
  level?: number | null;
  ref?: string | null;
  quay?: string;
  exact?: boolean;
}
/** What a routed walk through a station puts on its step (stationWalk()); `floors` null: routed along the streets. */
interface StationWalkParts { lines: LngLat[][]; walks: RoutedWalk[]; floors: KanteFloorChange[] | null }
/** A walk's place in a station with a 3D model (s3Plan() in 62-sheet-content.ts): the model and the two ends. */
interface StationWalkPlan { key: string; from: Station3DEndpoint; to: Station3DEndpoint }
/**
 * One written direction of a walk as the sheet lists them (walkDirections() in 62-sheet-content.ts): a router's,
 * the floor change the platforms imply, and at the end "Arrive at …".
 */
interface JourneyDirection {
  kind: KanteWalkDir['kind'] | 'arrive';
  text: string;
  /** Its part of the walk's line (a single point for a floor change or the arrival); may be missing. */
  coords?: LngLat[] | null;
  /** A floor change: the floors it leads from and to. */
  from?: number;
  to?: number;
}
/** A floor change on a walk between platforms on different floors (levelChange()); `at`: where to show it. */
interface JourneyLevelChange { from: number; to: number; at: LngLat | null | undefined; text: string }

// ---------------------------------------------------------------- steps

/** The fields a kind of step does not have. */
type JourneyStepWithout<K extends string> = { [P in K]?: undefined };

/** What every step has. */
interface JourneyStepBase {
  /** The last ride before this step and the first one after it. */
  prevRide?: JourneyRideStep;
  nextRide?: JourneyRideStep;
  /** stepLine() (50-tracking.ts): the step's line in travel order, and the geoVersion it was made for. */
  _line?: LngLat[];
  _lv?: number;
  /** walkDirections() (62-sheet-content.ts): the directions, and the geoVersion they were written for. */
  _dirs?: JourneyDirection[];
  _dirsV?: number;
}

/** What a walk and a change share: the way on foot. */
interface JourneyFootStep extends JourneyStepBase {
  /** When it starts and ends, ms (by the live forecasts; null where a ride has no time). */
  t0: number | null;
  t1: number | null;
  /** The lines drawn on the map: straight ones at first, then each replaced by its routed path. */
  lines: LngLat[][];
  /** The routed walks, one for each of `lines` (a place stays empty until its walk is routed). */
  walks?: RoutedWalk[];
  /** Where the walk changes floor, when its router says so (a station model, the engine). */
  floors?: KanteFloorChange[] | null;
  // The engine's walk (KanteJourney.setWalk() and requay()):
  /** Its time on foot, to the second. */
  walkS?: number;
  /** The engine has routed it: `lines`, `walks` and `floors` are its path, directions and floor changes. */
  kanteWalk?: boolean;
  /** What each of `lines` was routed between, the revision of its route, the lines and the ends and platforms its
   *  last answer was for (walkSig()), and for the walk to the destination the place it leads to. */
  ends?: [WalkEnd, WalkEnd][];
  walkRev?: number;
  _netFor?: LngLat[][];
  _netSig?: string;
  /** …and what the last request was for (an answer may still be on its way). */
  _askFor?: LngLat[][];
  _askSig?: string;
  toLL?: LngLat;
}

/** On foot to the first stop, or (final) from the last stop to the destination. A trip without a ride is one final walk. */
interface JourneyWalkStep extends JourneyFootStep,
  JourneyStepWithout<'prev' | 'walkMin' | 'points' | 's' | 'path' | 'stops' | 'stopIdx' | 'depLL' | 'arrLL' | 'depAt' | 'arrAt' | 'destTitle' | 'time' | 'end'> {
  type: 'walk';
  /** Minutes. */
  min: number;
  /** When the engine starts the walk, ms. */
  start: number | null;
  /** Where it leads: the first stop, or the destination. */
  toName: string;
  /** The last walk, to the destination. */
  final?: boolean;
  /** To the first stop: the ride that follows, and where it is boarded. */
  next?: JourneyRide;
  board?: LngLat | null;
  /** The last walk: the ride before (null: there is none), and where you got off. */
  from?: JourneyRide | null;
  alight?: LngLat | null;
}

/** Between two rides. */
interface JourneyChangeStep extends JourneyFootStep,
  JourneyStepWithout<'min' | 'start' | 'toName' | 'final' | 'from' | 'board' | 'alight' | 's' | 'path' | 'stops' | 'stopIdx' | 'depLL' | 'arrLL' | 'depAt' | 'arrAt' | 'destTitle' | 'time' | 'end'> {
  type: 'change';
  prev: JourneyRide;
  next: JourneyRide;
  /** Minutes on foot; 0: same platform, or the timetable has no walk. */
  walkMin: number;
  /** Where you get off and where you board. */
  points: [off: LngLat | null, on: LngLat | null];
}

interface JourneyRideStep extends JourneyStepBase,
  JourneyStepWithout<'min' | 'start' | 'toName' | 'final' | 'from' | 'board' | 'alight' | 'prev' | 'next' | 'walkMin' | 'points' | 'lines' | 'walks' | 'floors' | 'walkS' | 'kanteWalk' | 'destTitle' | 'time' | 'end'> {
  type: 'ride';
  /** When it leaves and arrives, ms (by the live forecasts; null where the stop has no time). */
  t0: number | null;
  t1: number | null;
  s: JourneyRide;
  /** The line on the map: through the stops at first (the same array as `stops`), then the track or road. */
  path: LngLat[];
  /** The stops that have a position, and each one's place in the ride's stops. */
  stops: LngLat[];
  stopIdx: number[];
  /** Where it is boarded and left: the position, and what is known of the platform. */
  depLL: LngLat | null;
  arrLL: LngLat | null;
  depAt: JourneyPlatformAt;
  arrAt: JourneyPlatformAt;
  /** stopKms() (50-tracking.ts): the km of each of `stops` along `path`, and the `path` they were measured on. */
  _kms?: number[];
  _kmFor?: LngLat[];
}

/** The last step: being there. */
interface JourneyArriveStep extends JourneyStepBase,
  JourneyStepWithout<'t0' | 't1' | 'min' | 'start' | 'toName' | 'final' | 'board' | 'alight' | 'prev' | 'next' | 'walkMin' | 'points' | 'lines' | 'walks' | 'floors' | 'walkS' | 'kanteWalk' | 's' | 'path' | 'stops' | 'stopIdx' | 'depLL' | 'arrLL' | 'depAt' | 'arrAt'> {
  type: 'arrive';
  destTitle: string;
  /** When, ms: the timetable's arrival, then the live times'. */
  time: number | null | undefined;
  /** The last ride (null: there is none), and where it ends. */
  from: JourneyRide | null;
  end: LngLat | null;
}

/** A step of the journey on show (buildSteps()): walk → ride → change → ride → … → walk → arrive. */
type JourneyStep = JourneyWalkStep | JourneyChangeStep | JourneyRideStep | JourneyArriveStep;

// ---------------------------------------------------------------- the route on the map

/** What a feature of the 'route' source says: the layers of routeLayers() filter and paint by it. */
interface RouteFeatureProps {
  /** ride, walk: a line; stop: a stop of a ride; sign: where a ride is boarded; lvl: a floor change; pin: the start;
   *  wcov: a covered stretch of a walk (arcade, passage, underpass, indoors); door: the door a walk ends at. */
  kind: 'ride' | 'walk' | 'stop' | 'sign' | 'lvl' | 'pin' | 'wcov' | 'door';
  /** The step it belongs to (its index in journeySteps). */
  step: number;
  /** Already behind you: drawn faded. */
  done?: boolean;
  /** ride, stop: the line's colour on the light and on the dark map. */
  color?: string;
  dcolor?: string;
  /** stop: the last one of its ride. */
  end?: boolean;
  /** sign, lvl, pin: the sprite (42-sprites.ts), without the theme. */
  img?: string;
  sort?: number;
  /** walk: a straight line, not a routed path (drawn dashed, without arrows). */
  approx?: boolean;
}
type RouteFeature = GeoJSON.Feature<GeoJSON.LineString | GeoJSON.Point, RouteFeatureProps>;
type RouteCollection = GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.Point, RouteFeatureProps>;
/** The journey's map layers: the lines go under the map's labels, the points and signs on top. */
interface RouteLayers { below: maplibregl.LayerSpecification[]; above: maplibregl.LayerSpecification[] }

// ---------------------------------------------------------------- timers

// The page's timers start as null, and the browser takes null (it clears nothing).
declare function clearInterval(id: number | null | undefined): void;
declare function clearTimeout(id: number | null | undefined): void;
