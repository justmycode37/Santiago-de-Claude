// Settings: a page of its own (URL #settings, so the back gesture closes it).
// The journey options are the ones from the Kante app (niknal357's branch): accessibility, walking speed,
// change time, maximum walk and transport types. "On the map" picks what the events button shows (map-layers.js),
// "About you" and "Events" narrow down which community events show. "Live data" switches the live vehicles on the
// map (live.js).
// "Adjust to how I walk" lets the app move the walking speed by itself (walk-pace.js); "Developer options" at the very
// bottom shows the tools to test that.
// Everything is saved on this device only.
(function () {
  const KEY = 'app-settings';
  const MODES: TransportMode[] = ['train', 'tram', 'bus', 'ship', 'cableway']; // transport.opendata.ch "transportations"
  const DEFAULTS: Settings = {
    // Accessibility (stricter ones switch on the ones they include)
    stepFree: false,
    fewerStairs: false,
    noEscalators: false,
    wheelchair: false,
    // Walking and changing
    walkKmh: 4.7,
    autoSpeed: false, // measure how fast you walk and move the walking speed to match (walk-pace.js); off unless you turn it on
    extraChangeMin: 2,
    maxWalkMin: 20,
    modes: null, // null = every transport type
    // On the map: groups switched off (map-layers.js GROUPS keys); everything is on at first
    mapHidden: [],
    // Live data (live.js): vehicles on the map
    liveVehicles: true,
    // Guidance (a11y.ts): this phone's voice says each step of a journey; a buzz at each step
    readAloud: false,
    vibrate: false,
    // Events ("lowVision" also opens journeys as a list and names tactile guidance and sound signals: src/app)
    newcomer: false,
    lowVision: false,
    freeFood: false,
    women: false,
    adaptiveSport: false,
    fareTracking: false,
    // Developer options (bottom of the page)
    devOptions: false,
  };
  const NORMAL_KMH = 4.7; // the timetable's walking times are taken as this pace
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
  const LAYER_KEYS = window.MAP_LAYERS.GROUPS.map((g) => g.key);
  const JOURNEY_KEYS: (keyof Settings)[] = ['stepFree', 'fewerStairs', 'noEscalators', 'wheelchair', 'walkKmh', 'extraChangeMin', 'maxWalkMin', 'modes'];
  // Event tags (events.js, swiss-workshops.js) each setting shows
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
  type TimeKey = 'departure' | 'arrival';
  type StampKey = 'departureTimestamp' | 'arrivalTimestamp';

  function nearestPreset(kmh: number) {
    let best = 0;
    SPEED_PRESETS.forEach((p, i) => { if (Math.abs(p.kmh - kmh) < Math.abs(SPEED_PRESETS[best].kmh - kmh)) best = i; });
    return best;
  }

  function clean(saved: Record<string, unknown>) {
    const s = { ...DEFAULTS };
    for (const k in DEFAULTS) if (typeof DEFAULTS[k as keyof Settings] === 'boolean' && typeof saved[k] === 'boolean') s[k as FlagKey] = saved[k];
    if (typeof saved.walkKmh === 'number' && saved.walkKmh > 0) s.walkKmh = SPEED_PRESETS[nearestPreset(saved.walkKmh)].kmh;
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
    if (saved && typeof saved === 'object') state = clean(saved);
    else {
      // Carry over the old event-preference checkboxes
      const old = JSON.parse(localStorage.getItem('event-preferences')!);
      if (Array.isArray(old)) for (const k in EVENT_TAGS) state[k as EventKey] = EVENT_TAGS[k as EventKey].some((t) => old.includes(t));
    }
  } catch { /* Settings still work for this visit. */ }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* not saved, still applied */ }
  }

  function effective() {
    const stepFree = state.stepFree || state.wheelchair;
    return { ...state, stepFree, fewerStairs: state.fewerStairs || stepFree, noEscalators: state.noEscalators || stepFree };
  }
  const impliedBy: Partial<Record<FlagKey, () => boolean>> = {
    stepFree: () => state.wheelchair,
    fewerStairs: () => state.stepFree || state.wheelchair,
    noEscalators: () => state.stepFree || state.wheelchair,
  };

  // ---- What the settings change ----
  const eventTags = () => (Object.keys(EVENT_TAGS) as EventKey[]).filter((k) => state[k]).flatMap((k) => EVENT_TAGS[k]);
  // Map groups the events button shows, e.g. ['events', 'toilets', …]
  const mapGroups = () => LAYER_KEYS.filter((k) => !state.mapHidden.includes(k));

  // Valhalla pedestrian costing for walks, or null for the normal walking router.
  // OpenStreetMap maps escalators as moving steps, so avoiding escalators means avoiding steps.
  function walkCosting(): WalkCosting | null {
    const s = effective();
    if (s.stepFree) return { type: 'wheelchair' };
    if (s.fewerStairs || s.noEscalators) return { step_penalty: 120 };
    return null;
  }

  // transport.opendata.ch "transportations[]" values, or [] for all
  const transportations = () => state.modes || [];

  const pad = (n: number) => String(n).padStart(2, '0');
  const secOf = (cp: OdCheckpoint, which: TimeKey) => (cp[which + 'Timestamp' as StampKey] != null ? cp[which + 'Timestamp' as StampKey] : cp[which] ? Date.parse(cp[which]) / 1000 : null);
  function setTime(cp: OdCheckpoint, which: TimeKey, sec: number) {
    cp[which + 'Timestamp' as StampKey] = sec;
    cp[which] = new Date(sec * 1000).toISOString();
  }

  // Walking speed: stretch or shrink every walk. Walks before the first ride end as it leaves
  // (so you set off earlier or later); walks after the last ride start when it arrives.
  function retime(conn: OdConnection) {
    const f = NORMAL_KMH / state.walkKmh;
    const secs = conn.sections || [];
    const rides = secs.map((s, i) => (s.journey ? i : -1)).filter((i) => i >= 0);
    if (Math.abs(f - 1) < 0.01 || !rides.length) return conn;
    const dur = (s: OdSection) => (s.walk && s.walk.duration) || 0;
    secs.forEach((s) => { if (!s.journey && s.walk && s.walk.duration) s.walk.duration = Math.round(s.walk.duration * f); });
    let t = secOf(secs[rides[0]].departure, 'departure');
    for (let i = rides[0] - 1; i >= 0 && t != null; i--) {
      setTime(secs[i].arrival, 'arrival', t);
      t -= dur(secs[i]);
      setTime(secs[i].departure, 'departure', t);
    }
    if (t != null && conn.from) setTime(conn.from, 'departure', t);
    let u = secOf(secs[rides[rides.length - 1]].arrival, 'arrival');
    for (let i = rides[rides.length - 1] + 1; i < secs.length && u != null; i++) {
      setTime(secs[i].departure, 'departure', u);
      u += dur(secs[i]);
      setTime(secs[i].arrival, 'arrival', u);
    }
    if (u != null && conn.to) setTime(conn.to, 'arrival', u);
    if (t != null && u != null) {
      const m = Math.round((u - t) / 60);
      conn.duration = `${pad(Math.floor(m / 1440))}d${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}:00`;
    }
    return conn;
  }

  // Does a (retimed) connection fit: no single walk longer than the maximum, and at every change
  // enough time for the walk plus the extra change time (at least 7 min step-free, 10 min wheelchair)?
  function connectionFits(conn: OdConnection) {
    const accessMin = state.wheelchair ? 10 : effective().stepFree ? 7 : 0;
    let walk = 0, lastRide: OdSection | null = null;
    for (const s of conn.sections || []) {
      if (!s.journey) {
        walk += (s.walk && s.walk.duration) || 0;
        if (walk > state.maxWalkMin * 60) return false;
        continue;
      }
      if (lastRide) {
        const arr = secOf(lastRide.arrival, 'arrival'), dep = secOf(s.departure, 'departure');
        const need = Math.max(walk + state.extraChangeMin * 60, accessMin * 60);
        if (arr != null && dep != null && dep - arr < need) return false;
      }
      walk = 0;
      lastRide = s;
    }
    return true;
  }

  // ---- Page ----
  const page = document.getElementById('settingsPage')!;
  const closeBtn = document.getElementById('settingsClose')!;
  // "On the map": one switch per group in map-layers.js
  const { GROUPS, GLYPHS } = window.MAP_LAYERS;
  const layerGroup = document.getElementById('setMapGroup')!;
  const layerAll = document.getElementById('setMapAll')!;
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

  window.openFareSuggestions = async (trigger) => {
    if (!state.fareTracking) return;
    try {
      const { openSuggestions } = await import('./pricing-panel.js');
      if (state.fareTracking && trigger?.isConnected) {
        openSuggestions({ history: PRICING_HISTORY, trigger, onChange: () => {
          renderPricing();
          window.dispatchEvent(new Event('pricing-history-change'));
        } });
      }
    } catch {
      const message = 'Fare suggestions could not load. Please try again.';
      if (!isOpen && typeof window.showToast === 'function') window.showToast(message);
      else {
        pricingStorageStatus.hidden = false;
        pricingStorageStatus.textContent = message;
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
  pricingSuggestions.addEventListener('click', () => window.openFareSuggestions(pricingSuggestions));
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

  pricingClearPaused.addEventListener('click', () => {
    if (!window.confirm('Clear all confirmed trips saved in this browser?')) return;
    const cleared = PRICING_HISTORY.clear();
    pricingStorageStatus.hidden = false;
    pricingStorageStatus.textContent = cleared ? 'Trip history cleared.' : 'Could not clear trip history.';
    renderPricing();
  });

  function render() {
    renderPricing();
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

  // by: 'auto' when the app changed the setting itself (walk-pace.js), otherwise it was you
  function update(patch: Partial<Settings>, by?: SettingsChangedBy) {
    if ('fareTracking' in patch) pricingStorageStatus.hidden = true;
    const before = state;
    state = { ...state, ...patch };
    save();
    render();
    changeListeners.forEach((fn) => fn(patch, by, before));
  }

  // Guidance switches only show where the phone can do it (iOS Safari has no vibration)
  const aloudRow = document.getElementById('setAloudRow'), vibrateRow = document.getElementById('setVibrateRow');
  if (aloudRow && !window.speechSynthesis) aloudRow.hidden = true;
  if (vibrateRow && !navigator.vibrate) vibrateRow.hidden = true;

  page.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.setting) {
      update({ [t.dataset.setting]: t.checked });
      // switched on: say so with the voice (this tap is also what lets the page speak later, on iOS), or buzz once
      if (t.checked && window.A11Y) {
        if (t.dataset.setting === 'readAloud') { A11Y.unlock(); A11Y.say('Read aloud is on.'); }
        if (t.dataset.setting === 'vibrate') A11Y.buzz(false);
      } else if (!t.checked && t.dataset.setting === 'readAloud' && window.A11Y) A11Y.hush();
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
    madeInert = ([...document.body.children] as HTMLElement[]).filter((el) => el !== page && el.id !== 'paceNote' && el.id !== 'toast' && !el.classList.contains('sr-live') && el.tagName !== 'SCRIPT' && !el.inert);
    madeInert.forEach((el) => { el.inert = true; });
    themeBefore = themeMeta.getAttribute('content')!;
    themeMeta.setAttribute('content', getComputedStyle(page).getPropertyValue('--sp-bg').trim());
    page.scrollTop = 0;
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
    } else if (isOpen && event.key === 'pricing-trip-history-v1') renderPricing();
    if (event.key === 'pricing-profile-v1' || event.key === null) {
      renderPricing();
      window.dispatchEvent(new Event('pricing-history-change'));
    }
  });
  closeBtn.addEventListener('click', close);
  page.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  window.SETTINGS = {
    open,
    close,
    eventTags,
    mapGroups,
    walkCosting,
    transportations,
    prefs: () => ({ ...effective() }), // walking speed, extra change time, step-free…
    retime,
    connectionFits,
    // the journey options as the 3D station view's router wants them (station-route.js)
    journey: () => { const s = effective(); return { stepFree: s.stepFree, fewerStairs: s.fewerStairs, noEscalators: s.noEscalators, wheelchair: s.wheelchair, walkKmh: s.walkKmh }; },
    speedPresets: SPEED_PRESETS.map((p) => ({ ...p })), // the five stops of the walking speed slider
    set: (patch, by) => update(patch, by),
    onChange: (fn) => changeListeners.push(fn), // fn(patch, by, settingsBefore)
    onClose: (fn) => closeListeners.push(fn),
  };

  render();
  sync(); // a #settings link opens straight on the page
})();
