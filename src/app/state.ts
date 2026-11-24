// The page's state that more than one part of it changes. A module's own `let` can only be assigned inside that
// module, so what several parts set lives here, as properties of a few objects (journey.conn = …). State that
// only one part sets stays in that part (and is exported from there when others read it).
// Nothing here touches the page: the tests import it as it is.
import type { SearchCategory } from './categories.ts';
import type { Journey, JourneyOptions } from '../engine-journey.ts';
import type { EventFeature } from '../events.ts';
import type { MapGroupKey } from '../map-layers.ts';
import type { JourneyStep } from './journey-steps.ts';
import type { FieldSearch, SearchResult, TripField } from './search.ts';
import type { JourneyFocus } from './sheet.ts';
import type { JourneyQuery } from './time-picker.ts';
import type { TrackState } from './tracking.ts';

// ---------------------------------------------------------------- the two ends

/**
 * Where a trip goes to, or starts: a search result, a place or an event picked on the map, or a dropped pin.
 * This is what the journey reads of it; a search result (SearchResult) has more.
 */
export interface JourneyDest {
  title: string;
  lngLat: LngLat;
  /** Where a search result comes from ('address', 'gg25', 'gazetteer', 'place', 'pin', …); a place or event of the map has none. */
  origin?: string;
}
/** Where a plan starts from (startJourney()): the place, and its name in the sheet ("Your location", "Map centre", a start). */
export interface JourneyOrigin { ll: LngLat; label: string }
/** The list's two tabs: by public transport, or on foot all the way. */
export type JourneyTab = 'pt' | 'walk';
/** Which way the list is being extended (`journeyMore`). */
export type JourneyMoreDir = 'earlier' | 'later';


/** The journey on show, and the plan it came from. */
export const journey = {
  /** The step the cards show. */
  step: 0,
  steps: [] as JourneyStep[],
  /** Bumped for every new plan, and when the journey ends: answers for an older one are dropped. */
  req: 0,
  /** The journey on show. */
  conn: null as Journey | null,
  /** Where the trip starts: your position, or the map centre without one. */
  from: 'Your location',
  /** …and its place, as the last plan asked for it. */
  origin: null as JourneyOrigin | null,
  dest: null as JourneyDest | null,
  /** Empty date and time: now. */
  query: { mode: 'dep', date: '', time: '' } as JourneyQuery,
  /** Every way on offer to make the trip: { list, walk, best, earlier, later }. */
  options: null as JourneyOptions | null,
  /** The sheet lists them to choose from (not the journey itself). */
  list: false,
  /** …those by public transport, or 'walk': on foot all the way. */
  tab: 'pt' as JourneyTab,
  /** 'earlier' | 'later' while more of them are being fetched. */
  more: null as JourneyMoreDir | null,
  progressTimer: null as number | null,
  liveTimer: null as number | null,
  /** The whole journey at once on the map: nothing dimmed until a step is picked. */
  overview: true,
  /** What the progress on the map was last drawn for (live-line.ts): '' draws it again. */
  routeKey: '',
  /** The live times and platforms the journey was last timed with (live-engine.ts). */
  platKey: '',
};

/** What the journey sheet says. */
export const sheet = {
  /** "Finding a connection…" and the like, while there is no trip to show. */
  msg: '',
  /** …with "Try again" beside it: the engine could not be reached. */
  retry: false,
  /** { step, dir }: a walking direction picked in the list; the header then steps through them. */
  focus: null as JourneyFocus | null,
  /** Where the sheet's top is (px from the top of the screen). */
  y: 0,
  /** What the header was last drawn for: '' draws it again. */
  headKey: '',
  /** The journey step the 3D view was opened from. */
  s3Step: null as JourneyStep | null,
};

/** Following the journey by GPS (tracking.ts). */
export const tracking = {
  /** Bumped whenever a step's line changes (real walking paths and tracks arrive). */
  geoVersion: 1,
  /** GPS progress: { i (step), kmIn (km into it), km (into the trip), d (m off the line), off, missed, arrived }. */
  track: null as TrackState | null,
  /** The steps of the trip you have arrived at for good (trackOnce()): kept through a gap in GPS, until another trip
   *  is opened (its steps are new ones). */
  arrivedAt: null as JourneyStep[] | null,
  /** The step GPS last moved the cards to. */
  autoStep: 0,
  /** When a step was last picked by hand. */
  userPickedAt: 0,
};

/** The search: its two fields and its list of results. */
export const searchState = {
  /** The field being searched in. */
  field: 'to' as TripField,
  /** Where the trip starts: null = where you are, else a search result or a dropped pin ({ title, lngLat }). */
  tripStart: null as JourneyDest | null,
  results: [] as SearchResult[],
  /** "Restaurants" when the query names a kind of place: the nearest ones are listed. */
  placeCategory: null as string | null,
  /** The list shows all its results, not only the first few. */
  expanded: false,
  debounce: undefined as number | undefined,
  /** Bumped for every search: answers for an older one are dropped. */
  reqId: 0,
  /** { field, text }: what the list was last filled for. */
  last: null as FieldSearch | null,
  /** The category picked in the search (categories.ts): its events or its places are the cards on the map. */
  category: null as SearchCategory | null,
};

/** The card open on the map. */
export const popup = {
  /** Bumped for every card opened: answers for an older one are dropped. */
  req: 0,
  /** The place (toilet, pharmacy…) whose card is open. */
  place: null as MapGroupKey | null,
  /** The events of the pin whose card was opened last (the event page lists them). */
  eventsAtPin: [] as EventFeature[],
};
