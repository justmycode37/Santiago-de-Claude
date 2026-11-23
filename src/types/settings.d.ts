// What src/settings.ts puts on window: the Settings page, and what its switches mean for the rest of the app.

/** A transport type the traveller can switch off in Settings. */
type TransportMode = 'train' | 'tram' | 'bus' | 'ship' | 'cableway';

/** The settings, as they are saved on the device. */
interface Settings {
  // Accessibility. The stricter ones include the others: prefs() and journey() give them with that worked out.
  stepFree: boolean;
  fewerStairs: boolean;
  noEscalators: boolean;
  wheelchair: boolean;
  // Walking and changing
  /** Walking speed, one of five: 3, 4, 4.7 (what the timetable assumes), 5.5, 6.5. */
  walkKmh: number;
  /** "Adjust to how I walk": measure the walking pace and move the walking speed to match (walk-pace.ts). */
  autoSpeed: boolean;
  /** Minutes added to every change. */
  extraChangeMin: number;
  /** The longest single walk, in minutes. */
  maxWalkMin: number;
  /** The transport types to travel with; null = all of them. */
  modes: TransportMode[] | null;
  /** Events and places: the groups switched off. */
  mapHidden: MapGroupKey[];
  // Live data
  /** Show the vehicles on the map. */
  liveVehicles: boolean;
  // Events: show the ones for…
  newcomer: boolean;
  lowVision: boolean;
  freeFood: boolean;
  women: boolean;
  adaptiveSport: boolean;
  /** Show the developer options at the bottom of the Settings page. */
  devOptions: boolean;
}

/** One stop of the walking speed slider (Slow … Fast). */
interface SpeedPreset {
  label: string;
  kmh: number;
}

/** Who changed a setting: 'auto' = the app itself (walk-pace.ts); nothing = you. */
type SettingsChangedBy = 'auto';

/** Called after every change: what was changed, by whom, and the saved settings as they were before. */
type SettingsChangeListener = (patch: Partial<Settings>, by: SettingsChangedBy | undefined, before: Settings) => void;

/** The journey options the 3D station view's router takes (station-route.ts). */
type JourneySettings = Pick<Settings, 'stepFree' | 'fewerStairs' | 'noEscalators' | 'wheelchair' | 'walkKmh'>;

/** Valhalla pedestrian costing options: route for a wheelchair, or keep away from steps. */
type WalkCosting = { type: 'wheelchair' } | { step_penalty: number };


