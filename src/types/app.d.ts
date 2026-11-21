// Types the parts of the page's own script (src/app/*.ts) share. Those files are joined into one script, so
// what one of them declares at its top level all the others see; the types they have in common are here.

type Theme = 'light' | 'dark';

/** A colour as parseColor() reads it: red, green, blue 0–255 and alpha 0–1. */
type Rgba = [r: number, g: number, b: number, a: number];
/** Hue in degrees, saturation and lightness 0–1. */
type Hsl = [h: number, s: number, l: number];
/** How the dark map style changes one colour of the light style. */
type HslRemap = (h: number, s: number, l: number) => Hsl;

/** A map symbol drawn on a canvas (42-sprites.ts), as map.addImage() takes it. */
interface MapSprite { data: ImageData; ratio: number }

/**
 * A position as onPosition() (16-location.ts) takes it: the browser's GeolocationPosition, or the made-up one at
 * the end of a path walked in the developer options (walk-pace.ts), which says `simulated`.
 */
interface PositionFix {
  coords: { longitude: number; latitude: number; accuracy: number; speed?: number | null; heading?: number | null };
  /** When it was taken (ms). */
  timestamp: number;
  simulated?: boolean;
}

/** When the trip should be: leave at ('dep') or arrive by ('arr') a date and time; both empty = now. */
type TimeMode = 'dep' | 'arr';
interface JourneyQuery { mode: TimeMode; date: string; time: string }
