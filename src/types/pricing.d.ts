interface Settings {
  fareTracking: boolean;
}

// The fare service (transport.opendata.ch's POST /v1/fare, 63-ticket-pricing.ts): what it is sent and answers.
// It prices a connection of its own timetable, so the engine's rides are first found there (GET /v1/connections).
/** One end of a ride as the fare service reads it: the station's UIC number and the time (ISO 8601). */
interface FareCheckpoint { station: { id?: string | null; name?: string | null }; departure?: string | null; arrival?: string | null }
/** A ride as the fare service reads it: its two ends and its line (`operator` as that timetable names it, "SBB"). */
interface FareSection {
  departure: FareCheckpoint;
  arrival: FareCheckpoint;
  journey: { name?: string | null; category?: string | null; number?: string | null; operator?: string | null } | null;
}
/** A connection of the fare service's timetable, as far as it is read and sent back to be priced. */
interface FareConnection { sections: FareSection[] }

interface TicketFare {
  fare?: number | null;
  halfFare?: number | null;
}

interface PricingTrip extends TicketFare {
  from: string;
  to: string;
  departure?: string | null;
  rides: (string | null | undefined)[][];
}

interface SavedPricingTrip extends TicketFare {
  id: string;
  from: string;
  to: string;
  date: string;
  /** Missing in a record of the first version when its id does not give it (pricing-history.ts, list()). */
  departure?: string;
  /** Not written by this version. A record with false is neither listed nor counted. */
  confirmed?: boolean;
  dummy?: boolean;
}

interface PricingProfile {
  age?: number;
  months?: number;
  groupSize?: number;
  hasHalfFare?: boolean;
  covered?: boolean;
  allUnder25?: boolean;
  seniorEligibility?: boolean;
  saver?: { full: number | null; half: number | null };
}

/** What `setProfile` takes: an empty number field of the form is null. Values that are not valid are left out. */
type PricingProfilePatch = { [K in keyof PricingProfile]?: PricingProfile[K] | null };

interface PricingHistoryApi {
  profile(): PricingProfile;
  list(): SavedPricingTrip[];
  dateKey(date: Date): string;
  findConfirmed(trip: PricingTrip): SavedPricingTrip | null;
  confirm(trip: PricingTrip): 'saved' | 'duplicate' | 'updated' | 'unavailable';
  routeFare(from: string, to: string): (TicketFare & { date: string }) | null;
  setProfile(patch: PricingProfilePatch): boolean;
  setHalfFare(confirmed: boolean): boolean;
  update(id: string, fare: TicketFare): boolean;
  remove(id: string): boolean;
  clear(): boolean;
  setDummy(on: boolean): boolean;
  hasDummy(): boolean;
}

declare var PRICING_HISTORY: PricingHistoryApi;

interface Window {
  openFareSuggestions(trigger: HTMLElement): Promise<void>;
}
