// What src/events.ts puts on window: the community events, and the shape of the listings they are made from.

type EventCategory = 'language' | 'food' | 'legal' | 'jobs' | 'workshop' | 'community' | 'sport' | 'kids' | 'health';

/** A community event or programme as its organizer lists it (events.ts and the data files in data.d.ts). */
interface EventListing {
  id: string;
  cat: EventCategory;
  title: string;
  coordinates: LngLat;
  city: string;
  /** Name and street: 'PBZ Oerlikon, Hofwiesenstrasse 379'. */
  venue: string;
  /** In words: 'Tuesdays, 09:30–11:30', '23 Nov 2026 · 14 - 19 Uhr'. */
  when: string;
  /** ISO date and time after which it is over and no longer shown. Left out: it goes on. */
  through?: string;
  cost?: string;
  attendance?: string;
  about: string;
  audience: string;
  /** Who it is for and what it offers: 'newcomers', 'language', 'free-food', 'women', … (Settings shows events by these). */
  tags: string[];
  /** The organizer's page. */
  url: string;
  /** A picture: a file of this site (event-images/…) or an address. */
  image?: string;
  /** Where the picture was taken from, shown when the site's own copy does not load. */
  imageSource?: string;
  /** Only the town is known: `coordinates` is a point in the town, not the venue. */
  areaOnly?: boolean;
}

/** One date of an event that takes place several times: what differs from date to date. */
interface EventSession {
  id: string;
  when: string;
  url: string;
  through?: string;
  cost?: string;
  attendance?: string;
}
/** An event with its dates (swiss-workshops.js): each session, with the rest of the series, is one EventListing. */
type EventSeries = Omit<EventListing, keyof EventSession> & { sessions: EventSession[] };

/** A listing as the map and the event page read it. */
interface EventProperties extends Omit<EventListing, 'coordinates'> {
  cost: string;
  attendance: string;
  /** The category's colour ('#C55A82') and the colour of the glyph on it. */
  color: string;
  ink: string;
  /** The category's name: 'Community meal'. */
  category: string;
}
/** A GeoJSON point feature. */
interface EventFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: LngLat };
  properties: EventProperties;
}

interface EventsApi {
  /** Category → SVG path data of its glyph, stroked on a 24×24 grid. */
  GLYPHS: Record<EventCategory, string>;
  /** Every event, past ones included (matches() leaves those out). */
  features: EventFeature[];
  /**
   * Is the event still on, and does it have one of the tags asked for?
   * @param preferences tags (SETTINGS.eventTags()); none = every event
   * @param now ms since 1970; left out: the present moment
   */
  matches(event: EventFeature, preferences: string[], now?: number): boolean;
}

