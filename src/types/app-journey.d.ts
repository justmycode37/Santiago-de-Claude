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

// ---------------------------------------------------------------- the journeys to choose from

/**
 * Every way on offer to make the trip (`journeyOptions`): what KanteJourney.plans() answers, or connections()
 * (70-routing.ts) from the public timetable, which has no walking all the way and no earlier / later.
 */
interface JourneyOptions {
  /** By public transport, in order of departure. */
  list: OdConnection[];
  /** On foot all the way, when that is near enough; else null. */
  walk: OdConnection | null;
  /** The one shown first: one of `list`, or `walk`. */
  best: OdConnection;
  /** Whether there are earlier and later ones to fetch (KanteJourney.more()). */
  earlier: boolean;
  later: boolean;
}
/** The list's two tabs: by public transport, or on foot all the way. */
type JourneyTab = 'pt' | 'walk';
/** Which way the list is being extended (`journeyMore`). */
type JourneyMoreDir = 'earlier' | 'later';

// ---------------------------------------------------------------- lines

/** How a line runs, as far as its timetable category tells (modeOf()). */
type LineMode = 'train' | 'tram' | 'bus' | 'boat' | 'cable';
/** What tells a line apart: a ride's journey, a departure of a board, or the engine's line made to look like one. */
interface LineLike { category?: string | null; number?: string | null; operator?: string | null }
/** A line's colour, one of the app's palette: badge background and text on the light theme, and on the dark one. */
interface LineColor { name: string; bg: string; fg: string; dbg: string; dfg: string }

// ---------------------------------------------------------------- where a ride stops

/** A platform or stop edge a ride is boarded at: an edge of PLATFORMS (30-platforms.ts), or the engine's boarding point. */
interface JourneyEdge {
  /** Its name ("7", "H"); '' when it has none. */
  ref: string;
  /** The compass direction vehicles stop in. */
  bearing: number | null;
  /** The floor; null (or 0) at street level, or when it is not known. */
  level: number | null;
  ll: LngLat;
  /** PLATFORMS: the comparable name (platformKey()). */
  key?: string;
  /** The engine: "north side of Bundesgasse", or ''. */
  side?: string;
}
/** Where a stop of a ride is, as platformAt() (32-places.ts) gives it. */
interface JourneyPlatformAt {
  /** null: neither the platform nor the station has a position. */
  ll: LngLat | null;
  /** null: only the stop is known, not the platform or edge. */
  edge: JourneyEdge | null;
  /** The compass direction the vehicle leaves in. */
  travel: number | null;
}

// ---------------------------------------------------------------- walks

/** One turn-by-turn step of the OSM walking router (OSRM, routing.openstreetmap.de), as far as it is read. */
interface OsrmStep {
  /** Metres. */
  distance?: number;
  /** The street. */
  name?: string;
  maneuver?: { type?: string; modifier?: string };
  geometry?: { coordinates: LngLat[] };
}
/**
 * A routed walk (routeWalk(), stationWalk(), and the engine's): its line, its metres (null when no router found a
 * way and it is the straight line), and its directions: a street router's `steps`, or `dirs` already written out
 * (a station model's, the engine's).
 */
interface RoutedWalk {
  coords: LngLat[];
  steps: OsrmStep[] | null;
  dist: number | null;
  dirs?: KanteWalkDir[];
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

/** A section that is a ride. */
interface RideSection extends OdSection { journey: OdJourney }

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
  // An engine journey (KanteJourney.decorate() and requay()):
  /** The engine's walk. */
  kante?: KanteWalk;
  /** Its time on foot, to the second. */
  walkS?: number;
  /** The engine has routed it: `lines`, `walks` and `floors` are its path, directions and floor changes. */
  kanteWalk?: boolean;
}

/** On foot to the first stop, or (final) from the last stop to the destination. A trip without a ride is one final walk. */
interface JourneyWalkStep extends JourneyFootStep,
  JourneyStepWithout<'prev' | 'walkMin' | 'points' | 's' | 'path' | 'stops' | 'stopIdx' | 'depLL' | 'arrLL' | 'depAt' | 'arrAt' | 'destTitle' | 'time' | 'end'> {
  type: 'walk';
  /** Minutes. */
  min: number;
  /** When the timetable starts the walk (ISO 8601), if it says. */
  start: string | null | undefined;
  /** Where it leads: the first stop, or the destination. */
  toName: string;
  /** The last walk, to the destination. */
  final?: boolean;
  /** To the first stop: the ride that follows, and where it is boarded. */
  next?: RideSection;
  board?: LngLat | null;
  /** The last walk: the ride before (null: there is none), and where you got off. */
  from?: RideSection | null;
  alight?: LngLat | null;
}

/** Between two rides. */
interface JourneyChangeStep extends JourneyFootStep,
  JourneyStepWithout<'min' | 'start' | 'toName' | 'final' | 'from' | 'board' | 'alight' | 's' | 'path' | 'stops' | 'stopIdx' | 'depLL' | 'arrLL' | 'depAt' | 'arrAt' | 'destTitle' | 'time' | 'end'> {
  type: 'change';
  prev: RideSection;
  next: RideSection;
  /** Minutes on foot; 0: same platform, or the timetable has no walk. */
  walkMin: number;
  /** Where you get off and where you board. */
  points: [off: LngLat | null, on: LngLat | null];
}

interface JourneyRideStep extends JourneyStepBase,
  JourneyStepWithout<'min' | 'start' | 'toName' | 'final' | 'from' | 'board' | 'alight' | 'prev' | 'next' | 'walkMin' | 'points' | 'lines' | 'walks' | 'floors' | 'kante' | 'walkS' | 'kanteWalk' | 'destTitle' | 'time' | 'end'> {
  type: 'ride';
  /** When it leaves and arrives, ms (by the live forecasts; null where the stop has no time). */
  t0: number | null;
  t1: number | null;
  s: RideSection;
  /** The line on the map: through the stops at first (the same array as `stops`), then the track or road. */
  path: LngLat[];
  /** The stops that have a position, and each one's place in the ride's passList. */
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
  JourneyStepWithout<'t0' | 't1' | 'min' | 'start' | 'toName' | 'final' | 'board' | 'alight' | 'prev' | 'next' | 'walkMin' | 'points' | 'lines' | 'walks' | 'floors' | 'kante' | 'walkS' | 'kanteWalk' | 's' | 'path' | 'stops' | 'stopIdx' | 'depLL' | 'arrLL' | 'depAt' | 'arrAt'> {
  type: 'arrive';
  destTitle: string;
  /** When: the timetable's arrival (ISO 8601), or ms once the live forecasts have timed the trip. */
  time: string | number | null | undefined;
  /** The last ride (null: there is none), and where it ends. */
  from: RideSection | null;
  end: LngLat | null;
}

/** A step of the journey on show (buildSteps()): walk → ride → change → ride → … → walk → arrive. */
type JourneyStep = JourneyWalkStep | JourneyChangeStep | JourneyRideStep | JourneyArriveStep;

// ---------------------------------------------------------------- the route on the map

/** What a feature of the 'route' source says: the layers of routeLayers() filter and paint by it. */
interface RouteFeatureProps {
  /** ride, walk: a line; stop: a stop of a ride; sign: where a ride is boarded; lvl: a floor change; pin: the start. */
  kind: 'ride' | 'walk' | 'stop' | 'sign' | 'lvl' | 'pin';
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
}
type RouteFeature = GeoJSON.Feature<GeoJSON.LineString | GeoJSON.Point, RouteFeatureProps>;
type RouteCollection = GeoJSON.FeatureCollection<GeoJSON.LineString | GeoJSON.Point, RouteFeatureProps>;
/** The journey's map layers: the lines go under the map's labels, the points and signs on top. */
interface RouteLayers { below: maplibregl.LayerSpecification[]; above: maplibregl.LayerSpecification[] }

// ---------------------------------------------------------------- timers

// The page's timers start as null, and the browser takes null (it clears nothing).
declare function clearInterval(id: number | null | undefined): void;
declare function clearTimeout(id: number | null | undefined): void;
