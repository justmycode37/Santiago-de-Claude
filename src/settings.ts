// Settings: a page of its own (URL #settings, so the back gesture closes it).
// The journey options are the ones from the Kante app (niknal357's branch): accessibility, walking speed,
// change time, maximum walk and transport types. "Map and display" has dark mode, the live vehicles on the map
// (live.ts) and, folded behind one row, "Events and places": what the events button shows (map-layers.ts).
// "Events for you" narrows down which community events show.
// "Adjust to how I walk" lets the app move the walking speed by itself (walk-pace.ts); "Developer options" at the very
// bottom (only with ?dev in the address) shows the tools to test that.
// "Search history" switches off (or clears) what the search remembers of your searches (search-history.ts).
// Everything is saved on this device only.
import { PRICING_HISTORY, keepTripsWhen } from './pricing-history.ts';
import { SEARCH_HISTORY, rememberWhen } from './search-history.ts';
import { showToast } from './toast.ts';
import { load, reloadNote } from './lazy.ts';
import { MAP_LAYERS } from './map-layers.ts';
import { setTheme } from './theme.ts';
import type { MapGroupKey } from './map-layers.ts';

/** A transport type the traveller can switch off in Settings. */
export type TransportMode = 'train' | 'tram' | 'bus' | 'ship' | 'cableway';
/** The settings, as they are saved on the device. */
export interface Settings {
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
  /** Hills: take a flatter way even when it is a few minutes longer… */
  avoidHills: boolean;
  /** …or the quickest way, hills or not (one of the two at most; neither: a flatter way when it is little longer). */
  ignoreHills: boolean;
  /** At a change with time to spare, walk round a hill when there is still a minute in hand. */
  flatterChanges: boolean;
  /** Minutes added to every change, on top of the walk between the two platforms. */
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
  /** The 3D station view offers the first-person walk-through (👁); off: the model, its steps and the play-through only. */
  firstPerson: boolean;
  // Events: show the ones for…
  newcomer: boolean;
  lowVision: boolean;
  freeFood: boolean;
  women: boolean;
  adaptiveSport: boolean;
  /** Show the developer options at the bottom of the Settings page. */
  devOptions: boolean;
  // the fare suggestions: are trips kept (pricing-history.ts)?
  fareTracking: boolean;
  /** Remember what you search for, for "Recent" and "Frequent" in the search (search-history.ts). */
  searchHistory: boolean;
}
/** One stop of the walking speed slider (Slow … Fast). */
export interface SpeedPreset {
  label: string;
  kmh: number;
}
/** Who changed a setting: 'auto' = the app itself (walk-pace.ts); nothing = you. */
export type SettingsChangedBy = 'auto';
/** Called after every change: what was changed, by whom, and the saved settings as they were before. */
export type SettingsChangeListener = (patch: Partial<Settings>, by: SettingsChangedBy | undefined, before: Settings) => void;
/** The journey options the 3D station view's router takes (station-route.ts). */
export type JourneySettings = Pick<Settings, 'stepFree' | 'fewerStairs' | 'noEscalators' | 'wheelchair' | 'walkKmh'>;

const KEY = 'app-settings';
const MODES: TransportMode[] = ['train', 'tram', 'bus', 'ship', 'cableway'];
const LAYER_KEYS = MAP_LAYERS.GROUPS.map((g) => g.key);
// What the events button shows on a device that has not chosen yet: the rest waits to be switched on
const FIRST_LAYERS: MapGroupKey[] = ['events', 'toilets', 'water'];
const DEFAULTS: Settings = {
  // Accessibility (stricter ones switch on the ones they include)
  stepFree: false,
  fewerStairs: false,
  noEscalators: false,
  wheelchair: false,
  // Walking and changing
  walkKmh: 4.7,
  autoSpeed: false, // measure how fast you walk and move the walking speed to match (walk-pace.ts); off unless you turn it on
  avoidHills: false,
  ignoreHills: false,
  flatterChanges: true,
  extraChangeMin: 0, // a change takes the walk between the two platforms; minutes here are added to it
  maxWalkMin: 20,
  modes: null, // null = every transport type
  // Events and places: groups switched off (map-layers.ts GROUPS keys); only FIRST_LAYERS are on at first
  mapHidden: LAYER_KEYS.filter((k) => !FIRST_LAYERS.includes(k)),
  // Live data (live.ts): vehicles on the map; off unless you turn it on (a journey shows its own vehicle either way)
  liveVehicles: false,
  // 3D station view: the first-person walk-through is offered only when switched on
  firstPerson: false,
  // Events
  newcomer: false,
  lowVision: false,
  freeFood: false,
  women: false,
  adaptiveSport: false,
  fareTracking: false,
  searchHistory: true,
  // Developer options (bottom of the page)
  devOptions: false,
};
const SPEED_PRESETS = [
  { label: 'Slow', kmh: 3 },
  { label: 'Relaxed', kmh: 4 },
  { label: 'Normal', kmh: 4.7 },
  { label: 'Brisk', kmh: 5.5 },
  { label: 'Fast', kmh: 6.5 },
];
const STEPPERS = {
  extraChangeMin: { min: 0, max: 15, step: 1 },
  maxWalkMin: { min: 5, max: 60, step: 5 },
};
const JOURNEY_KEYS: (keyof Settings)[] = ['stepFree', 'fewerStairs', 'noEscalators', 'wheelchair', 'walkKmh', 'avoidHills', 'ignoreHills', 'flatterChanges', 'extraChangeMin', 'maxWalkMin', 'modes'];
// Event tags (events.ts, swiss-workshops.js) each setting shows
const EVENT_TAGS = {
  newcomer: ['newcomers', 'language'],
  lowVision: ['blind-low-vision'],
  freeFood: ['free-food'],
  women: ['women'],
  adaptiveSport: ['adaptive-sport'],
};

/** The settings that are a switch, the two with a − and a + button, and the ones that pick events. */
type FlagKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];
type StepperKey = keyof typeof STEPPERS;
type EventKey = keyof typeof EVENT_TAGS;

function nearestPreset(kmh: number) {
  let best = 0;
  SPEED_PRESETS.forEach((p, i) => { if (Math.abs(p.kmh - kmh) < Math.abs(SPEED_PRESETS[best].kmh - kmh)) best = i; });
  return best;
}

function clean(saved: Record<string, unknown>) {
  const s = { ...DEFAULTS };
  for (const k in DEFAULTS) if (typeof DEFAULTS[k as keyof Settings] === 'boolean' && typeof saved[k] === 'boolean') s[k as FlagKey] = saved[k];
  if (typeof saved.walkKmh === 'number' && saved.walkKmh > 0) s.walkKmh = SPEED_PRESETS[nearestPreset(saved.walkKmh)].kmh;
  if (s.avoidHills && s.ignoreHills) s.ignoreHills = false;
  for (const k in STEPPERS) {
    const v = saved[k] as number, r = STEPPERS[k as StepperKey];
    if (Number.isInteger(v) && v >= r.min && v <= r.max) s[k as StepperKey] = v;
  }
  if (Array.isArray(saved.mapHidden)) s.mapHidden = LAYER_KEYS.filter((k) => (saved.mapHidden as unknown[]).includes(k));
  if (Array.isArray(saved.modes)) {
    const m = MODES.filter((x) => (saved.modes as unknown[]).includes(x));
    s.modes = m.length && m.length < MODES.length ? m : null;
  }
  return s;
}

let state = { ...DEFAULTS };
try {
  const saved = JSON.parse(localStorage.getItem(KEY)!);
  if (saved && typeof saved === 'object') {
    state = clean(saved);
    // Settings saved when two minutes were added to every change unless the traveller said otherwise (they have no
    // `walkChanges`): those two minutes were the default, not a wish. A change takes the walk now; whoever wants
    // minutes on top sets them again.
    if (!saved.walkChanges && state.extraChangeMin === 2) state.extraChangeMin = 0;
  } else {
    // Carry over the old event-preference checkboxes
    const old = JSON.parse(localStorage.getItem('event-preferences')!);
    if (Array.isArray(old)) for (const k in EVENT_TAGS) state[k as EventKey] = EVENT_TAGS[k as EventKey].some((t) => old.includes(t));
  }
} catch { /* Settings still work for this visit. */ }

function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ ...state, walkChanges: true })); } catch { /* not saved, still applied */ }
}

function effective() {
  const stepFree = state.stepFree || state.wheelchair;
  // avoiding hills walks the flatter way at changes anyway; not minding them, never
  const flatterChanges = state.avoidHills || (state.flatterChanges && !state.ignoreHills);
  return { ...state, stepFree, fewerStairs: state.fewerStairs || stepFree, noEscalators: state.noEscalators || stepFree, flatterChanges };
}
const impliedBy: Partial<Record<FlagKey, () => boolean>> = {
  stepFree: () => state.wheelchair,
  fewerStairs: () => state.stepFree || state.wheelchair,
  noEscalators: () => state.stepFree || state.wheelchair,
  flatterChanges: () => state.avoidHills || state.ignoreHills,
};
// Switches of which at most one is on: turning one on turns the other off
const EXCLUSIVE: Partial<Record<FlagKey, FlagKey>> = { avoidHills: 'ignoreHills', ignoreHills: 'avoidHills' };

// ---- What the settings change ----
const eventTags = () => (Object.keys(EVENT_TAGS) as EventKey[]).filter((k) => state[k]).flatMap((k) => EVENT_TAGS[k]);
// Map groups the events button shows, e.g. ['events', 'toilets', …]
const mapGroups = () => LAYER_KEYS.filter((k) => !state.mapHidden.includes(k));

// The transport types to travel with, or [] for all (engine-journey.ts turns them into the engine's modes)
const transportations = () => state.modes || [];

// ---- Page ----
const page = document.getElementById('settingsPage')!;
const closeBtn = document.getElementById('settingsClose')!;
// "Events and places": one switch per group in map-layers.ts
const { GROUPS, GLYPHS } = MAP_LAYERS;
const layerGroup = document.getElementById('setMapGroup')!;
const layerAll = document.getElementById('setMapAll')!;
// The switches stay folded away behind one row that says how many are on
const layerMore = document.getElementById('setMapMore')!;
const layerBox = document.getElementById('setMapBox')!;
const layerCount = document.getElementById('setMapCount')!;
layerMore.addEventListener('click', () => {
  layerBox.hidden = !layerBox.hidden;
  layerMore.setAttribute('aria-expanded', String(!layerBox.hidden));
});
// Dark mode: the app follows the system until this is used (setTheme is the page's own, in src/app)
const darkSwitch = document.getElementById('setDark') as HTMLInputElement;
// Developer options: only with ?dev in the address, or once they have been switched on
document.getElementById('devSwitch')!.hidden = !(/[?&]dev(=|&|$)/.test(location.search) || state.devOptions);
for (const g of GROUPS) {
  const row = document.createElement('label');
  row.className = 'set-row';
  const ic = document.createElement('span');
  ic.className = 'set-ic';
  ic.setAttribute('aria-hidden', 'true');
  ic.style.setProperty('--c', `var(--${g.color})`);
  if (g.color === 'sun') ic.style.setProperty('--f', '#344D77');
  ic.innerHTML = `<svg viewBox="0 0 24 24"><path d="${GLYPHS[g.glyph]}" /></svg>`;
  const text = document.createElement('span');
  text.className = 'set-text';
  const b = document.createElement('b');
  b.id = 'setLayer-' + g.key;
  b.textContent = g.label;
  text.append(b);
  if (g.note) {
    const small = document.createElement('small');
    small.textContent = g.note;
    text.append(small);
  }
  const input = document.createElement('input');
  input.className = 'switch';
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.dataset.layer = g.key;
  input.setAttribute('aria-labelledby', b.id);
  row.append(ic, text, input);
  layerGroup.append(row);
}
const pricingHalfFare = document.getElementById('pricingHalfFare') as HTMLInputElement;
const pricingSuggestions = document.getElementById('pricingSuggestions')!;
const pricingSummary = document.getElementById('pricingSummary')!;
const pricingClearPaused = document.getElementById('pricingClearPaused')!;
const pricingStorageStatus = document.getElementById('pricingStorageStatus')!;
const devDummyTrips = document.getElementById('devDummyTrips') as HTMLInputElement;
const searchHistoryClear = document.getElementById('searchHistoryClear')!;
const searchHistoryStatus = document.getElementById('searchHistoryStatus')!;
const layerSwitches = [...layerGroup.querySelectorAll<HTMLInputElement>('input[data-layer]')];
const switches = [...page.querySelectorAll<HTMLInputElement>('input[data-setting]')];
const modeSwitches = [...page.querySelectorAll<HTMLInputElement>('input[data-mode]')];
const slider = document.getElementById('speedSlider')!;
const speedLabel = document.getElementById('speedName')!;
const LAST = SPEED_PRESETS.length - 1;
const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!;
const changeListeners: SettingsChangeListener[] = [];
const closeListeners: ((journeyChanged: boolean) => void)[] = [];
let isOpen = false;
let pushed = false;
let scrollTo = ''; // id of the heading to open the page at
let journeyBefore = '';
let madeInert: HTMLElement[] = [];
let themeBefore = '';

// ---- Walking speed slider: moves freely while dragged, snaps to the nearest of five stops ----
let dragging = false;
let dragAt = 0; // stop the thumb is nearest to while dragging
function drawSlider(pos: number, snap: boolean) {
  slider.classList.toggle('snap', snap);
  slider.style.setProperty('--f', String(pos / LAST));
  speedLabel.textContent = SPEED_PRESETS[Math.round(pos)].label;
}
// The knob's centre runs from h/2 to width − h/2 (h = the pill's height, --h in the CSS)
const posAt = (e: PointerEvent) => {
  const r = slider.getBoundingClientRect();
  const h = parseFloat(getComputedStyle(slider).getPropertyValue('--h')) || 0;
  return Math.min(LAST, Math.max(0, ((e.clientX - r.left - h / 2) / (r.width - h)) * LAST));
};
slider.addEventListener('pointerdown', (e) => {
  if (e.button) return;
  slider.setPointerCapture(e.pointerId);
  dragging = true;
  slider.classList.add('dragging');
  const pos = posAt(e);
  dragAt = Math.round(pos);
  drawSlider(pos, true); // a tap glides the thumb to the finger
});
slider.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const pos = posAt(e);
  if (Math.round(pos) !== dragAt) {
    dragAt = Math.round(pos);
    if (navigator.vibrate) navigator.vibrate(6);
  }
  drawSlider(pos, false);
});
const endDrag = () => {
  if (!dragging) return;
  dragging = false;
  slider.classList.remove('dragging');
  update({ walkKmh: SPEED_PRESETS[dragAt].kmh });
};
slider.addEventListener('pointerup', endDrag);
slider.addEventListener('pointercancel', endDrag);
slider.addEventListener('keydown', (e) => {
  const i = nearestPreset(state.walkKmh);
  const to = ({ ArrowRight: i + 1, ArrowUp: i + 1, PageUp: i + 1, ArrowLeft: i - 1, ArrowDown: i - 1, PageDown: i - 1, Home: 0, End: LAST } as Record<string, number | undefined>)[e.key];
  if (to === undefined) return;
  e.preventDefault();
  update({ walkKmh: SPEED_PRESETS[Math.min(LAST, Math.max(0, to))].kmh });
});

function renderPricing() {
  pricingHalfFare.checked = PRICING_HISTORY.profile().hasHalfFare === true;
  devDummyTrips.checked = PRICING_HISTORY.hasDummy();
  const count = PRICING_HISTORY.list().length;
  pricingSuggestions.hidden = !state.fareTracking;
  pricingClearPaused.hidden = state.fareTracking || !count;
  pricingSummary.textContent = count
    ? `${count} saved ${count === 1 ? 'trip' : 'trips'}`
    : 'See how your saved trips compare';
}

export const openFareSuggestions = async (trigger: HTMLElement): Promise<void> => {
  if (!state.fareTracking) return;
  try {
    const { openSuggestions } = await load(import.meta.url, () => import('./pricing-panel.ts'));
    if (pricingStorageStatus.dataset.loadFailed) { pricingStorageStatus.hidden = true; delete pricingStorageStatus.dataset.loadFailed; } // loaded now
    if (state.fareTracking && trigger?.isConnected) {
      openSuggestions({ history: PRICING_HISTORY, trigger, onChange: () => {
        renderPricing();
        window.dispatchEvent(new Event('pricing-history-change'));
      } });
    }
  } catch (e) {
    const message = reloadNote(e, 'to see the fare suggestions') || 'Fare suggestions could not load. Please try again.';
    if (!isOpen) showToast(message);
    else {
      pricingStorageStatus.hidden = false;
      pricingStorageStatus.textContent = message;
      pricingStorageStatus.dataset.loadFailed = '1';
    }
  }
};
pricingHalfFare.addEventListener('change', () => {
  const saved = PRICING_HISTORY.setHalfFare(pricingHalfFare.checked);
  pricingStorageStatus.hidden = saved;
  if (!saved) pricingStorageStatus.textContent = 'Could not save your ticket preference.';
  renderPricing();
  window.dispatchEvent(new Event('pricing-history-change'));
});
pricingSuggestions.addEventListener('click', () => openFareSuggestions(pricingSuggestions));
// Developer options: dummy trips need trip history on, or the suggestions ignore them
devDummyTrips.addEventListener('change', () => {
  const on = devDummyTrips.checked; // read first: update() re-renders the switch from storage
  if (on && !state.fareTracking) update({ fareTracking: true });
  const saved = PRICING_HISTORY.setDummy(on);
  pricingStorageStatus.hidden = saved;
  if (!saved) pricingStorageStatus.textContent = 'Could not save the dummy trips.';
  renderPricing();
  window.dispatchEvent(new Event('pricing-history-change'));
});

// "Clear search history": there whenever something is kept, also with the switch off
function renderSearchHistory() {
  const n = SEARCH_HISTORY.count();
  searchHistoryClear.hidden = !n;
  if (n && searchHistoryStatus.textContent === 'Search history cleared.') searchHistoryStatus.hidden = true; // kept again since
}
searchHistoryClear.addEventListener('click', () => {
  if (!window.confirm('Clear your recent and frequent searches on this device?')) return;
  const cleared = SEARCH_HISTORY.clear();
  searchHistoryStatus.hidden = false;
  searchHistoryStatus.textContent = cleared ? 'Search history cleared.' : 'Could not clear the search history.';
  renderSearchHistory();
});

pricingClearPaused.addEventListener('click', () => {
  if (!window.confirm('Clear all confirmed trips saved in this browser?')) return;
  const cleared = PRICING_HISTORY.clear();
  pricingStorageStatus.hidden = false;
  pricingStorageStatus.textContent = cleared ? 'Trip history cleared.' : 'Could not clear trip history.';
  renderPricing();
});

function render() {
  renderPricing();
  renderSearchHistory();
  const eff = effective();
  for (const input of switches) {
    const k = input.dataset.setting as FlagKey;
    input.checked = eff[k];
    input.disabled = impliedBy[k] ? impliedBy[k]() : false;
  }
  const on = state.modes || MODES;
  for (const input of modeSwitches) {
    input.checked = on.includes(input.dataset.mode as TransportMode);
    input.disabled = input.checked && on.length === 1; // keep at least one
  }
  for (const input of layerSwitches) input.checked = !state.mapHidden.includes(input.dataset.layer as MapGroupKey);
  layerAll.textContent = state.mapHidden.length ? 'Show all' : 'Hide all';
  layerCount.textContent = `${LAYER_KEYS.length - state.mapHidden.length} of ${LAYER_KEYS.length}`;
  darkSwitch.checked = document.documentElement.dataset.theme === 'dark';
  const speed = nearestPreset(state.walkKmh);
  if (!dragging) drawSlider(speed, true);
  slider.setAttribute('aria-valuenow', String(speed));
  slider.setAttribute('aria-valuetext', SPEED_PRESETS[speed].label);
  for (const k in STEPPERS) {
    const r = STEPPERS[k as StepperKey];
    document.getElementById(k + 'Val')!.textContent = `${state[k as StepperKey]} min`;
    page.querySelector<HTMLButtonElement>(`[data-stepper="${k}"][data-dir="-1"]`)!.disabled = state[k as StepperKey] <= r.min;
    page.querySelector<HTMLButtonElement>(`[data-stepper="${k}"][data-dir="1"]`)!.disabled = state[k as StepperKey] >= r.max;
  }
}

// by: 'auto' when the app changed the setting itself (walk-pace.ts), otherwise it was you
function update(patch: Partial<Settings>, by?: SettingsChangedBy) {
  if ('fareTracking' in patch) pricingStorageStatus.hidden = true;
  if ('searchHistory' in patch) searchHistoryStatus.hidden = true;
  const before = state;
  state = { ...state, ...patch };
  save();
  render();
  changeListeners.forEach((fn) => fn(patch, by, before));
}

// The browser bar takes the settings page's colour while it is open, and the map's again when it closes
function themeChanged() {
  themeBefore = themeMeta.getAttribute('content')!;
  themeMeta.setAttribute('content', getComputedStyle(page).getPropertyValue('--sp-bg').trim());
  darkSwitch.checked = document.documentElement.dataset.theme === 'dark';
}
page.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  if (t === darkSwitch) { setTheme(t.checked ? 'dark' : 'light', true); themeChanged(); }
  else if (t.dataset.setting) {
    const other = EXCLUSIVE[t.dataset.setting as FlagKey];
    update({ [t.dataset.setting]: t.checked, ...(t.checked && other ? { [other]: false } : {}) });
  }
  else if (t.dataset.layer) {
    const hidden = state.mapHidden.filter((k) => k !== t.dataset.layer);
    if (!t.checked) hidden.push(t.dataset.layer as MapGroupKey);
    update({ mapHidden: LAYER_KEYS.filter((k) => hidden.includes(k)) });
  }
  else if (t.dataset.mode) {
    const cur = new Set(state.modes || MODES);
    t.checked ? cur.add(t.dataset.mode as TransportMode) : cur.delete(t.dataset.mode as TransportMode);
    update({ modes: cur.size === MODES.length || !cur.size ? null : MODES.filter((m) => cur.has(m)) });
  }
});
page.addEventListener('click', (e) => {
  const step = (e.target as HTMLElement).closest<HTMLElement>('[data-stepper]');
  if (step) {
    const k = step.dataset.stepper as StepperKey, r = STEPPERS[k];
    return update({ [k]: Math.min(r.max, Math.max(r.min, state[k] + r.step * +step.dataset.dir!)) });
  }
  if ((e.target as HTMLElement).closest('#setMapAll')) return update({ mapHidden: state.mapHidden.length ? [] : [...LAYER_KEYS] });
  if ((e.target as HTMLElement).closest('#settingsReset')) {
    if (pricingHalfFare.checked) PRICING_HISTORY.setHalfFare(false);
    // the theme follows the system again
    try { localStorage.removeItem('theme'); } catch { /* it stays as it is */ }
    try { localStorage.removeItem('timeMode'); } catch { /* the time sheet's last mode (time-picker.ts) stays */ }
    setTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light', false);
    themeChanged();
    update({ ...DEFAULTS });
    window.dispatchEvent(new Event('pricing-history-change'));
  }
});

const journeySnapshot = () => JSON.stringify(JOURNEY_KEYS.map((k) => state[k]));

function show() {
  isOpen = true;
  journeyBefore = journeySnapshot();
  render();
  // (the walking-speed notice stays usable: it can show on top of this page)
  madeInert = ([...document.body.children] as HTMLElement[]).filter((el) => el !== page && el.id !== 'paceNote' && el.tagName !== 'SCRIPT' && !el.inert);
  madeInert.forEach((el) => { el.inert = true; });
  themeBefore = themeMeta.getAttribute('content')!;
  themeMeta.setAttribute('content', getComputedStyle(page).getPropertyValue('--sp-bg').trim());
  page.scrollTop = 0;
  layerBox.hidden = true;
  layerMore.setAttribute('aria-expanded', 'false');
  reveal();
  page.classList.add('open');
  page.setAttribute('aria-hidden', 'false');
  closeBtn.focus({ preventScroll: true });
}

function hide() {
  isOpen = false;
  page.classList.remove('open');
  page.setAttribute('aria-hidden', 'true');
  madeInert.forEach((el) => { el.inert = false; });
  madeInert = [];
  themeMeta.setAttribute('content', themeBefore);
  const journeyChanged = journeySnapshot() !== journeyBefore;
  closeListeners.forEach((fn) => fn(journeyChanged));
}

// #settings, or one of its own pages (#settings/language)
const onSettings = () => location.hash === '#settings' || location.hash.startsWith('#settings/');

function sync() {
  const want = onSettings();
  if (want !== isOpen) (want ? show : hide)();
}

function reveal() {
  const el = scrollTo && document.getElementById(scrollTo);
  scrollTo = '';
  if (el) el.scrollIntoView({ block: 'start' });
}

// anchor: id of a heading on the page to open it at (optional)
function open(anchor?: string) {
  scrollTo = anchor || '';
  if (isOpen) return reveal();
  if (onSettings()) return sync();
  pushed = true;
  location.hash = 'settings';
}

function close() {
  if (pushed) { pushed = false; history.back(); return; }
  history.replaceState(null, '', location.pathname + location.search);
  sync();
}

window.addEventListener('hashchange', () => {
  if (!onSettings()) pushed = false;
  sync();
});
// Keep consent in sync when another tab pauses tracking or clears settings.
window.addEventListener('storage', (event) => {
  if (event.storageArea !== localStorage) return;
  if (event.key === KEY || event.key === null) {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { /* Treat unreadable consent as off. */ }
    const enabled = saved?.fareTracking === true;
    if (state.fareTracking !== enabled) {
      state = { ...state, fareTracking: enabled };
      if (!enabled) document.querySelector<HTMLDialogElement>('dialog[data-fare-suggestions][open]')?.close();
      render();
      window.dispatchEvent(new Event('pricing-history-change'));
    }
    // the search history switched off there is off here too (and this tab's next save does not switch it back on)
    // (unreadable: as it was here; missing: on, the default)
    const remember = saved === undefined ? state.searchHistory : saved?.searchHistory !== false;
    if (state.searchHistory !== remember) {
      state = { ...state, searchHistory: remember };
      render();
    }
  } else if (isOpen && event.key === 'pricing-trip-history-v1') renderPricing();
  if (event.key === SEARCH_HISTORY.KEY || event.key === null) renderSearchHistory();
  if (event.key === 'pricing-profile-v1' || event.key === null) {
    renderPricing();
    window.dispatchEvent(new Event('pricing-history-change'));
  }
});
closeBtn.addEventListener('click', close);
page.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

// the trips for fare suggestions are kept while it is on (pricing-history.ts)
keepTripsWhen(() => effective().fareTracking);
// searches are remembered while "Search history" is on (search-history.ts)
rememberWhen(() => state.searchHistory);

export const SETTINGS = {
  /** Opens the Settings page (URL #settings); `anchor` = id of a heading on the page to open it at. */
  open,
  close,
  /** The event tags switched on under "About you" and "Events"; none = show every event. */
  eventTags,
  /** The map groups the events button shows, in the order of MAP_LAYERS.GROUPS. */
  mapGroups,
  /** The transport types to travel with (KanteJourney.options() turns them into the engine's modes); [] = all. */
  transportations,
  /** The settings with the accessibility options worked out (wheelchair → step-free → fewer stairs, no escalators). */
  prefs: (): Settings => ({ ...effective() }), // walking speed, extra change time, step-free…
  // the journey options as the 3D station view's router wants them (station-route.ts)
  journey: (): JourneySettings => { const s = effective(); return { stepFree: s.stepFree, fewerStairs: s.fewerStairs, noEscalators: s.noEscalators, wheelchair: s.wheelchair, walkKmh: s.walkKmh }; },
  /** The five stops of the walking speed slider, slow to fast (a copy). */
  speedPresets: SPEED_PRESETS.map((p) => ({ ...p })), // the five stops of the walking speed slider
  /** Changes settings, saves them and tells the listeners. `by`: 'auto' when the app changes a setting by itself. */
  set: (patch: Partial<Settings>, by?: SettingsChangedBy): void => update(patch, by),
  /** `fn` is called after every change of a setting. Returns the number of listeners. */
  onChange: (fn: SettingsChangeListener): number => changeListeners.push(fn), // fn(patch, by, settingsBefore)
  /** `fn` is called when the page closes, with whether a journey option was changed while it was open. */
  onClose: (fn: (journeyChanged: boolean) => void): number => closeListeners.push(fn),
};

render();
sync(); // a #settings link opens straight on the page
