interface Settings {
  fareTracking: boolean;
}

interface FareSection {
  departure: OdCheckpoint;
  arrival: OdCheckpoint;
  journey: Partial<OdLine>;
}

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
}

declare var PRICING_HISTORY: PricingHistoryApi;

interface Window {
  openFareSuggestions(trigger: HTMLElement): Promise<void>;
}
