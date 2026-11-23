// The journey sheet and its controls (src/app/60-sheet.ts … 66-pill.ts): the types these parts share with each
// other and with the rest of the page's script.

/**
 * A child of h(): an element (or any other node) or text; a number is written as text; null, undefined, false
 * and '' are skipped; arrays are flattened, however deep.
 */
type HChild = Node | string | number | false | null | undefined | HChild[];
/** What is left of the children once the arrays are flattened. */
type HLeaf = Exclude<HChild, HChild[]>;

/** Where the sheet rests: fitted to its header, half the screen, or up to the top bar. */
type SheetDetent = 'low' | 'mid' | 'full';
/** The sheet's top edge (px from the top of the window) at each detent, and the window's height. */
interface SheetPositions { full: number; mid: number; low: number; h: number }

/** A walking direction picked in the sheet: the journey step and which of its directions. */
interface JourneyFocus { step: number; dir: number }

/**
 * What quayOf() (60-sheet.ts) reads of a ride's step: its ride, and where it stops once the step has been
 * placed. A row of the list of journeys (optionRow() in 62-sheet-content.ts) has only the ride.
 */
type QuayRide = Pick<JourneyRideStep, 's'> & Partial<Pick<JourneyRideStep, 'depAt' | 'arrAt'>>;

/** Where a ride stops, as quayOf() (60-sheet.ts) reads it of the ride's step. */
interface Quay {
  /** The platform's or bay's name as signed ("7", "C"); '' at a stop without signed ones. */
  label: string;
  /** "A–D"; '' when the platform is given without sectors. */
  sectors: string;
  /** Its noun, and the noun as it is written in the narrow column. */
  word: 'Platform' | 'Bay' | 'Pier';
  short: 'Pl.' | 'Bay' | 'Pier';
  /** The edge on the map; null when only the stop is known. */
  edge: JourneyEdge | null;
  /** The compass direction the vehicle travels in there, when it is known. */
  travel: number | null | undefined;
  /** The timetable's platform when today's is another one, else null. */
  planned: string | null;
  /** The stop's name. */
  station: string | null | undefined;
}
