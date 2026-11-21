// What src/settings.ts puts on window: the Settings page, and what its switches mean for the rest of the app.

/** A transport type as transport.opendata.ch's "transportations[]" names it. */
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
  /** On the map: the groups switched off. */
  mapHidden: MapGroupKey[];
  // Live data
  /** Show the vehicles on the map. */
  liveVehicles: boolean;
  // Guidance (src/a11y.ts)
  /** This phone's own voice says each step of a journey. Off for people who use a screen reader. */
  readAloud: boolean;
  /** A buzz at each new step (Android). */
  vibrate: boolean;
  // Events: show the ones for…
  newcomer: boolean;
  /** Also: journeys open as a list, the screen stays on during guidance, tactile guidance and sound signals are named. */
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

interface SettingsApi {
  /** Opens the Settings page (URL #settings); `anchor` = id of a heading on the page to open it at. */
  open(anchor?: string): void;
  close(): void;
  /** The event tags switched on under "About you" and "Events"; none = show every event. */
  eventTags(): string[];
  /** The map groups the events button shows, in the order of MAP_LAYERS.GROUPS. */
  mapGroups(): MapGroupKey[];
  /** How walks are to be routed, or null for the normal walking router. */
  walkCosting(): WalkCosting | null;
  /** transport.opendata.ch "transportations[]" values; [] = all. */
  transportations(): TransportMode[];
  /** The settings with the accessibility options worked out (wheelchair → step-free → fewer stairs, no escalators). */
  prefs(): Settings;
  /** Stretches or shrinks the walks of a transport.opendata.ch connection to the walking speed. Changes `conn` and returns it. */
  retime(conn: OdConnection): OdConnection;
  /** Does a (retimed) connection fit the maximum walk and leave enough time at every change? */
  connectionFits(conn: OdConnection): boolean;
  journey(): JourneySettings;
  /** The five stops of the walking speed slider, slow to fast (a copy). */
  speedPresets: SpeedPreset[];
  /** Changes settings, saves them and tells the listeners. `by`: 'auto' when the app changes a setting by itself. */
  set(patch: Partial<Settings>, by?: SettingsChangedBy): void;
  /** `fn` is called after every change of a setting. Returns the number of listeners. */
  onChange(fn: SettingsChangeListener): number;
  /** `fn` is called when the page closes, with whether a journey option was changed while it was open. */
  onClose(fn: (journeyChanged: boolean) => void): number;
}

declare var SETTINGS: SettingsApi;
