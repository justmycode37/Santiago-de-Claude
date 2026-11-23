// The listings the community events are made from: the event data files (data.d.ts) and src/events.ts's own.

/** A community event or programme as its organizer lists it (events.ts and the data files in data.d.ts). */
interface EventListing {
  id: string;
  cat: import('../events.ts').EventCategory;
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

