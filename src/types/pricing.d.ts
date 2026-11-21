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
  departure: string;
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

interface PricingHistoryApi {
  profile(): PricingProfile;
  list(): SavedPricingTrip[];
  dateKey(date: Date): string;
  findConfirmed(trip: PricingTrip): SavedPricingTrip | null;
  confirm(trip: PricingTrip): 'saved' | 'duplicate' | 'updated' | 'unavailable';
  routeFare(from: string, to: string): (TicketFare & { date: string }) | null;
  setProfile(patch: Partial<PricingProfile>): boolean;
  setHalfFare(confirmed: boolean): boolean;
  update(id: string, fare: TicketFare): boolean;
  remove(id: string): boolean;
  clear(): boolean;
}

declare var PRICING_HISTORY: PricingHistoryApi;

interface Window {
  openFareSuggestions(trigger: HTMLElement): Promise<void>;
}
