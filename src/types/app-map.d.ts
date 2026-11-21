// What is on the map besides the journey (src/app/12-events.ts, 14-menu.ts, 30-platforms.ts, 32-places.ts,
// 80-event-page.ts): the types these parts share with each other, with the rest of the page and with the scripts
// the page hands its stops to (Scan, the departure boards).

// ---- Platforms and stop edges: the PLATFORMS index (src/app/30-platforms.ts, made from platforms.js) ----

/** How a stop is served, in words (platforms.js has it as a letter: PlatformModeCode). */
type PlatformMode = 'train' | 'tram' | 'bus' | 'boat' | 'cable';

/** One platform or stop edge of a stop. */
interface PlatformEdge {
  /** Its name as signed: "7", "H"; '' when it has none. */
  ref: string;
  /** The comparable form of the name (platformKey()): "7A-D" → "7", "Kante H" → "H"; '' when it has none. */
  key: string;
  /** The compass direction the vehicles that stop there travel in; null when the data does not say. */
  bearing: number | null;
  /** The floor when it is not at street level, else null. */
  level: number | null;
  ll: LngLat;
}
/** A stop of PLATFORMS (by UIC number, "8507000"): its name, how it is served, its edges (at least one). */
interface PlatformStop { name: string; mode: PlatformMode; edges: PlatformEdge[] }

/** The properties of a dot on the map (source 'platforms'): the stop's UIC number, the edge's index and name. */
interface PlatformDotProps { id: string; i: number; ref: string }
/** A dot as the map gives it back for a tap (queryRenderedFeatures). */
type PlatformDotFeature = maplibregl.MapGeoJSONFeature & { properties: PlatformDotProps };
/** What openPlatform() reads of a tapped dot. i null: the stop as a whole (Scan knows the stop, not the edge). */
interface PlatformTap { properties: { id: string; i: number | null } }

// What platformAt() (src/app/32-places.ts) answers is JourneyPlatformAt, in app-journey.d.ts: the rides keep it.

// ---- Places: toilets, drinking water, health, help… (src/app/32-places.ts, from map-places.js) ----

/**
 * The properties of a place on the map (source 'places'): i: its index in PLACES.items, g: its group, gl: its
 * glyph, c: the group's colour, o: who gets the room where icons would overlap (lower first), n: its name.
 */
interface PlaceDotProps { i: number; g: MapGroupKey; gl: string; c: MapColorName; o: number; n?: string }
