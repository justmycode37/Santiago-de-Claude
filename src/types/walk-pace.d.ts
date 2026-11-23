// What src/walk-pace.ts puts on window: "Adjust to how I walk" (Settings) measures your walking pace from the
// location fixes the page hands it, and the developer options walk a path drawn on the map.

/** A location fix as the pace measurement takes it. */
interface WalkPaceFix {
  ll: LngLat;
  /** Accuracy in metres. */
  acc: number;
  /** The device's own speed in m/s, when it gives one. */
  speed?: number | null;
  /** When the fix was taken (ms). */
  t: number;
}

/**
 * A made-up position: the end of a path walked in the developer options. It has what the page reads of the
 * browser's GeolocationPosition, and `simulated` to tell the two apart.
 */
interface SimulatedPosition {
  coords: { longitude: number; latitude: number; accuracy: number; speed?: undefined; heading?: undefined };
  timestamp: number;
  simulated: true;
}

/** What the page's script hands over (`WALK_PACE.attach`) so that a path can be drawn on the map and walked. */
interface WalkPaceHooks {
  map: maplibregl.Map;
  /** Puts you at a made-up position. */
  position(pos: SimulatedPosition): void;
  /** Puts you back at your real position, when there is one. */
  restore(): void;
}


