// The introduction for a first visit: a welcome page, the demo (a short journey: a walk, a tram ride, a walk),
// then two short questions that set existing settings (walking speed, access needs), then the map.
// Whether it shows is decided in the <head> of index.html (localStorage 'onboarding', ?intro), which also holds back
// the location prompt until it is over. Settings › "Show the introduction again" opens it once more.
// Nothing is kept here: every answer goes straight into settings.js (window.SETTINGS).
(function () {
  'use strict';

  /** The access needs asked for: switches of the settings page. */
  type NeedKey = 'wheelchair' | 'stepFree' | 'fewerStairs' | 'noEscalators' | 'lowVision';
  interface Need { key: NeedKey; color: string; title: string; note: string; icon: string }
  /** What the demo reports while it runs, and how it ended. */
  type Act = 1 | 2 | 3;
  type DemoState = Act | 'arrived' | 'error' | 'playing';
  type DemoEnd = 'finished' | 'skipped' | 'unavailable';
  interface Demo { over: Promise<DemoEnd>; close(): void; /** Reduced motion: on to the next act; false when there is none. */ next(): boolean }
  /** A listener for one of the viewer's events, kept to take it off again. */
  type Heard = [name: keyof Station3DEventMap, fn: (detail: never) => void];
  type PageName = 'welcome' | 'demo' | 'speed' | 'access';

  const KEY = 'onboarding';
  const html = document.documentElement;
  const me = document.currentScript as HTMLScriptElement | null;
  const BASE = ((me && me.src) || '').replace(/[^/]*(\?.*)?$/, '');
  const SETTINGS = window.SETTINGS;
  const reducedMotion = () => !!((window.matchMedia as typeof matchMedia | undefined) && matchMedia('(prefers-reduced-motion: reduce)').matches);

  // The five stops of the walking speed slider: settings.js exports them once the walking-speed-auto branch is in
  // (SETTINGS.speedPresets); until then this is the same list
  const SPEED_NOTES = ['A careful pace, or with small children', 'A stroll', 'The pace timetables assume', 'Walking with a purpose', 'Almost a jog'];
  const SPEEDS = ((SETTINGS && SETTINGS.speedPresets) || [
    { label: 'Slow', kmh: 3 },
    { label: 'Relaxed', kmh: 4 },
    { label: 'Normal', kmh: 4.7 },
    { label: 'Brisk', kmh: 5.5 },
    { label: 'Fast', kmh: 6.5 },
  ]).map((s, i, all) => ({ label: s.label, kmh: s.kmh, note: all.length === SPEED_NOTES.length ? SPEED_NOTES[i] : '' }));
  // Access needs → the switches of the settings page (same keys, icons and colours)
  const NEEDS: Need[] = [
    { key: 'wheelchair', color: 'navy', title: 'I use a wheelchair', note: 'Step-free routes that also avoid barriers a wheelchair can’t pass.',
      icon: '<circle cx="10" cy="4.5" r="1.7" fill="currentColor" stroke="none" /><path d="M10 8v6h5.5l2.5 5M10 10.8h4.5M7.3 12.2a5 5 0 1 0 5.9 7" />' },
    { key: 'stepFree', color: 'sun', title: 'I can’t take stairs or escalators', note: 'For example with a pushchair, a walking aid or heavy luggage.',
      icon: '<path d="M3 18.5h18V9.5z" />' },
    { key: 'fewerStairs', color: 'tang', title: 'Stairs are hard for me', note: 'Takes a lift or ramp when the detour is small.',
      icon: '<path d="M4 20h5v-5h5v-5h5V5" />' },
    { key: 'noEscalators', color: 'rose', title: 'I avoid escalators', note: '',
      icon: '<path d="M3 15.5h4.5L15 7h6M3 20h6.5L17 11.5h4" />' },
    { key: 'lowVision', color: 'rose', title: 'I’m blind or have low vision', note: 'For now this adds events and groups for blind and low-vision people to the map. It doesn’t change routes yet.',
      icon: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" />' },
  ];
  // A stricter need includes the milder ones (settings.js, effective()): those show as on and can't be switched off
  const impliedBy: Partial<Record<NeedKey, (p: Settings) => boolean>> = {
    stepFree: (p) => p.wheelchair,
    fewerStairs: (p) => p.stepFree,
    noEscalators: (p) => p.stepFree,
  };

  // ---------- The demo: the one seam to the showcase ----------
  // A short journey in Bern, played by itself in three acts (docs/onboarding.md):
  //   1  a first-person walk across Hirschengraben to tram platform B (the 3D station view, detail scene),
  //   2  the ride to Bern, Bahnhof on a tilted map: the app notices that you are on the tram and follows it,
  //   3  a first-person walk from the tram stop to the main entrance of the station.
  // It is a fixed script: no timetable request, the same at any time of day. Nothing else in this file depends on
  // what the demo is; `startDemo` is the only place that knows.
  const UIC_HG = '8579896', UIC_BHF = '8576646';
  const WALK_1: Station3DOpenOptions = {
    key: 'bern', title: 'Bern, Hirschengraben',
    from: { stop: { uic: UIC_HG, ref: 'C' } }, to: { stop: { uic: UIC_HG, ref: 'B' } },
    arrive: { look: [-105.5, -222] },             // along the platform, to where the tram comes from
  };
  const WALK_3: Station3DOpenOptions = {
    key: 'bern', title: 'Bern, Bahnhof',
    from: { stop: { uic: UIC_BHF, ref: 'B' } }, to: { xy: [75.8, -38.9], level: 0, label: 'the main station' },
    arrive: { look: [72, -22] },                  // the station's main entrance
    povYaw: -86,                                  // it opens looking back at the tram you got off; the head turns to the way as you set off
  };
  const SPEED_1 = 1.5, SPEED_3 = 1.9;             // of a normal walking pace (the viewer's own default is 1.5)
  // The tram track from the south end of Hirschengraben past platform B to the stop at the station and on
  // (stations3d/bern.js, tracks 3, 238, 139, 187), in the model's metres: x east, y north
  type XY = [x: number, y: number];
  const TRACK: XY[] = [[-124.94, -292.28], [-101.92, -209.02], [-98.92, -201.22], [-96.81, -197.73], [-93.51, -193.85], [-88.1, -189.5],
    [-81.77, -185.81], [-68.47, -179.57], [-60.85, -176.88], [-51.79, -174.12], [-32.43, -169.1], [6.48, -159.55], [45.36, -150.04],
    [61.27, -145.76], [75.1, -141.14], [141.57, -117.85], [181.2, -104.6]];
  const MODEL_ORIGIN = [7.4391, 46.9488], KX = 111320 * Math.cos(MODEL_ORIGIN[1] * Math.PI / 180), KY = 110540;
  const toLngLat = (p: XY): [number, number] => [MODEL_ORIGIN[0] + p[0] / KX, MODEL_ORIGIN[1] + p[1] / KY];
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const smooth = (t: number) => { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };
  // A line by its length: the point and the compass bearing at s metres, and the s nearest to a point
  function byLength(line: XY[]) {
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
    const total = cum[cum.length - 1];
    const seg = (s: number) => { let i = 1; while (i < cum.length - 1 && cum[i] < s) i++; return i; };
    const at = (s: number): XY => {
      s = clamp(s, 0, total);
      const i = seg(s), t = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
      return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
    };
    const bearing = (s: number) => { const a = at(s - 4), b = at(s + 4); return Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI; };
    const nearest = (p: XY) => {
      let best = 0, bd = Infinity;
      for (let i = 1; i < line.length; i++) {
        const ax = line[i - 1][0], ay = line[i - 1][1], dx = line[i][0] - ax, dy = line[i][1] - ay;
        const t = clamp(((p[0] - ax) * dx + (p[1] - ay) * dy) / ((dx * dx + dy * dy) || 1), 0, 1);
        const d = Math.hypot(p[0] - ax - dx * t, p[1] - ay - dy * t);
        if (d < bd) { bd = d; best = cum[i - 1] + (cum[i] - cum[i - 1]) * t; }
      }
      return best;
    };
    return { total, at, bearing, nearest };
  }
  const track = byLength(TRACK);
  const TRAM_LEN = 42;
  const S_HG = track.nearest([-102.4, -207.2]);    // where the tram's front stops at Hirschengraben B: just past the end of the walk
  const S_BHF = track.nearest([113, -127.9]);      // …and at Bern, Bahnhof B: just before the place where the walk crosses the track
  const LINE = '9';

  // What the detail renderer offers for a tram, once it has it (station3d-detail.ts); everything here copes without
  interface Tram {
    place(s: number): void;
    run(o: { from: number; to: number; seconds: number; ease?: 'arrive' | 'depart' | 'linear' }): Promise<void>;
    doors(open: boolean): void;
    show(v: boolean): void;
    remove(): void;
  }
  interface TramScene { addVehicle?(spec: { kind: 'tram'; line?: string; path: XY[]; length?: number }): Tram }

  // The demo's own clock: everything in it that waits or glides asks this clock, so that holding the picture down
  // runs the whole journey faster
  const FAST = 3;
  interface Clock { rate(): number; set(rate: number): void; wait(ms: number): Promise<void>; stop(): void }
  function makeClock(): Clock {
    const waits = new Set<{ left: number; ok: () => void }>();
    let rate = 1, dead = false, last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now(), dt = Math.min(250, now - last) * rate;
      last = now;
      for (const w of [...waits]) { w.left -= dt; if (w.left <= 0) { waits.delete(w); w.ok(); } }
    }, 40);
    return {
      rate: () => rate,
      set(r) { rate = r; },
      wait: (ms) => new Promise<void>((ok) => { if (!dead) waits.add({ left: ms, ok }); }),
      stop() { dead = true; clearInterval(id); waits.clear(); },
    };
  }

  // ----- Before act 1: the trip at a glance, while the street is being built behind it -----
  const ICON_WALK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12.5" cy="4.6" r="1.8" fill="currentColor" stroke="none" /><path d="M12.5 8.2l-2.6 5 3.1 2.6.6 5M9.9 13.2l-1.2 3.6-2.4 3M12.5 8.2l3.2 2.6 2.8.6M12.3 8.4l-3.6 1.4-.9 3" /></svg>';
  interface Plan { hide(): void; destroy(): void }
  function makePlan(host: HTMLElement): Plan {
    const box = document.createElement('div');
    box.className = 'ob-plan on';
    box.innerHTML = `<div class="ob-plan-in">
        <p class="ob-plan-k">Your trip</p>
        <h2>Hirschengraben to Bern main station</h2>
        <ol class="ob-legs">
          <li class="walk"><i>${ICON_WALK}</i><span><b>Walk to the tram</b><small>Across Hirschengraben to platform B, 40 m</small></span></li>
          <li class="tram"><i>${ICON_TRAM}</i><span><b>Tram ${LINE}</b><small>One stop to Bern, Bahnhof</small></span></li>
          <li class="walk"><i>${ICON_WALK}</i><span><b>Walk to the station</b><small>Under the Baldachin to the main entrance, 100 m</small></span></li>
        </ol>
        <div class="ob-plan-bar"><i></i></div>
      </div>`;
    host.appendChild(box);
    return {
      hide() { box.classList.remove('on'); },
      destroy() { box.remove(); },
    };
  }

  // ----- Act 2: the ride, on a map of its own inside the demo's box -----
  interface Ride { ready: Promise<boolean>; show(): void; hide(): void; play(hold: Promise<unknown>): Promise<void>; still(): void; destroy(): void }
  const ICON_TRAM = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5.5" y="5" width="13" height="12.5" rx="3" /><path d="M5.5 11.5h13M9 20.5l1.5-3M15 20.5l-1.5-3M9 5l3-2.5L15 5" /><circle cx="9" cy="14.5" r=".9" fill="currentColor" stroke="none" /><circle cx="15" cy="14.5" r=".9" fill="currentColor" stroke="none" /></svg>';
  const ICON_WAIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>';
  const ICON_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z" /><circle cx="12" cy="10.5" r="2.4" /></svg>';

  function makeRide(host: HTMLElement, clock: Clock): Ride {
    const box = document.createElement('div');
    box.className = 'ob-ride';
    box.innerHTML = `<div class="ob-ride-map"></div>
      <div class="ob-card" role="status"><span class="ob-card-ic"></span><span class="ob-card-t"><b></b><small></small></span></div>`;
    host.appendChild(box);
    const card = box.querySelector<HTMLElement>('.ob-card')!;
    const say = (icon: string, title: string, sub: string, kind: 'wait' | 'tram' | 'off') => {
      card.dataset.kind = kind;
      card.querySelector('.ob-card-ic')!.innerHTML = icon;
      card.querySelector('b')!.textContent = title;
      card.querySelector('small')!.textContent = sub;
    };
    const waiting = () => say(ICON_WAIT, `Waiting for tram ${LINE}`, 'Bern, Hirschengraben, platform B', 'wait');
    const riding = () => say(ICON_TRAM, `You’re on tram ${LINE}`, 'The app noticed that you got on. Next stop: Bern, Bahnhof', 'tram');
    const there = () => say(ICON_OFF, 'Bern, Bahnhof: get off here', 'Then a short walk to the main entrance of the station', 'off');
    waiting();

    const S0 = S_HG - 9, S1 = S_BHF - 9;          // where you are in the tram: at its first door
    let map: maplibregl.Map | null = null, puck: maplibregl.Marker | null = null, puckEl: HTMLElement | null = null;
    let raf = 0, dead = false;
    const wait = clock.wait;
    const view = (s: number, zoom: number, bearing: number) => {
      if (!map) return;
      if (puck) puck.setLngLat(toLngLat(track.at(s)));
      map.jumpTo({ center: toLngLat(track.at(s + 16)), zoom, bearing, pitch: 54 });
    };

    const ready = new Promise<boolean>((ok) => { try {
      const gl = (window as { maplibregl?: typeof maplibregl }).maplibregl;
      if (!gl) return ok(false);
      const dark = html.dataset.theme === 'dark';
      // The app's own map style (light, or its dark variant): already loaded behind the introduction, else fetched
      const style = (): Promise<maplibregl.StyleSpecification> => {
        try {
          const have = STYLES[dark ? 'dark' : 'light'];
          if (have) return Promise.resolve(have);
        } catch (e) {}
        try { return fetch(STYLE_URL).then((r) => r.json()).then((base) => { try { return dark ? makeDarkStyle(base) : base; } catch (e) { return base; } }); }
        catch (e) { return Promise.reject(e); }
      };
      style().then((st) => {
        if (dead) return ok(false);
        map = new gl.Map({
          container: box.querySelector<HTMLElement>('.ob-ride-map')!, style: st, interactive: false, attributionControl: false,
          center: toLngLat(track.at(S0 + 16)), zoom: 17.7, bearing: track.bearing(S0 + 10), pitch: 54, maxPitch: 60,
          pixelRatio: Math.min(window.devicePixelRatio || 1, 2), fadeDuration: 0, refreshExpiredTiles: false,
        });
        map.on('error', () => {});
        map.once('load', () => {
          if (dead || !map) return ok(false);
          // houses stand up from the map, so the tilted picture reads as a place (the style draws them flat)
          try {
            const flat = st.layers.find((l) => l.type === 'fill' && (l as { 'source-layer'?: string })['source-layer'] === 'building') as { source: string } | undefined;
            if (flat) map.addLayer({
              id: 'ob-ride-houses', type: 'fill-extrusion', source: flat.source, 'source-layer': 'building', minzoom: 15,
              paint: {
                'fill-extrusion-color': dark ? '#3a3d47' : '#e9e6e0', 'fill-extrusion-opacity': .94,
                'fill-extrusion-height': ['coalesce', ['get', 'render_height'], ['get', 'height'], 15],
              },
            });
          } catch (e) {}
          const coords: [number, number][] = [];
          for (let s = S0 - 30; s <= S1 + 26; s += 2) coords.push(toLngLat(track.at(s)));
          map.addSource('ob-ride', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } } });
          map.addLayer({ id: 'ob-ride-case', type: 'line', source: 'ob-ride', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': dark ? '#1c1c1e' : '#ffffff', 'line-width': 11 } });
          map.addLayer({ id: 'ob-ride-line', type: 'line', source: 'ob-ride', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#d6001c', 'line-width': 6.5 } });
          const stop = (s: number, name: string, side: 'left' | 'right') => {
            const e = document.createElement('div');
            e.className = 'ob-stop ' + side;
            e.innerHTML = `<i></i><span>${name}</span>`;
            new gl.Marker({ element: e, anchor: 'center' }).setLngLat(toLngLat(track.at(s))).addTo(map!);
          };
          stop(S0, 'Hirschengraben', 'left');
          stop(S1, 'Bern, Bahnhof', 'right');
          puckEl = document.createElement('div');
          puckEl.className = 'ob-puck';
          puckEl.innerHTML = `<span class="ob-puck-you"></span><span class="ob-puck-tram">${ICON_TRAM}<b>${LINE}</b></span>`;
          puck = new gl.Marker({ element: puckEl, anchor: 'center' }).setLngLat(toLngLat(track.at(S0))).addTo(map);
          ok(true);
        });
      }).catch(() => ok(false));
    } catch (e) { ok(false); } });
    // a map that is not there in time (no network, a style that never loads) must not hold the journey up
    const soon = () => Promise.race([ready, wait(4000).then(() => false)]);

    return {
      ready,
      show() { box.classList.add('on'); if (map) map.resize(); },
      hide() { box.classList.remove('on'); },
      // The whole ride: you wait, the tram is recognised, it glides to the station. `hold` is what has to be over
      // before the map starts to move (the next 3D scene being built would make it stutter).
      async play(hold) {
        await soon();
        waiting();
        view(S0, 17.7, track.bearing(S0 + 10));
        await wait(900);
        if (dead) return;
        if (puckEl) puckEl.classList.add('tram');
        riding();
        await Promise.race([Promise.all([hold, wait(1700)]), wait(5000)]);
        if (dead) return;
        const T = 9000;
        let went = 0, bearing = track.bearing(S0 + 10), last = 0;
        await new Promise<void>((done) => {
          const tick = (now: number) => {
            if (dead) return done();
            if (!last) last = now;
            went += Math.min(100, now - last) * clock.rate();
            const u = clamp(went / T, 0, 1), s = S0 + (S1 - S0) * smooth(u);
            // the map turns with the tram, a little behind it
            let d = track.bearing(s + 22) - bearing;
            d = ((d + 540) % 360) - 180;
            bearing += d * (1 - Math.exp(-(now - last) / 900));
            last = now;
            view(s, 17.7 - .55 * Math.sin(Math.PI * u), bearing);
            if (u < 1) raf = requestAnimationFrame(tick); else done();
          };
          raf = requestAnimationFrame(tick);
        });
        if (dead) return;
        there();
        await wait(1500);
      },
      // Reduced motion: the end of the ride as a still picture
      still() {
        soon().then(() => {
          if (dead) return;
          if (puckEl) puckEl.classList.add('tram');
          there();
          view(S1, 17.5, track.bearing(S1 - 20));
        });
      },
      destroy() {
        dead = true;
        cancelAnimationFrame(raf);
        try { if (map) map.remove(); } catch (e) {}
        map = null;
        box.remove();
      },
    };
  }

  // Starts the demo inside `host`. `onState` hears the act that begins (1, 2, 3), 'arrived' (the journey is at its
  // end; the last view stays open), 'error' (it could not be shown; the 3D view says why and offers "Try again") and
  // 'playing' (it runs after all). `over` resolves once it has gone: 'finished' (after arriving), 'skipped'
  // (before) or 'unavailable'. close() ends it from outside. With prefers-reduced-motion nothing moves by itself:
  // `next()` steps to the following act and returns false once there is none.
  // While the picture is held down (anywhere on it, or on the button at its right edge), everything runs FAST times
  // as fast.
  function startDemo(host: HTMLElement, onState: (state: DemoState, act: Act) => void): Demo {
    // Always window.Station3D as it is now: the viewer may be loaded on first use and replace a stand-in object
    const S = () => window.Station3D;
    const none: Demo = { over: Promise.resolve('unavailable'), close() {}, next: () => false };
    if (!S() || !SETTINGS) return none;
    const still = reducedMotion();
    let end: (how: DemoEnd) => void, act: Act = 1, arrived = false, failed = false, ended = false, switching = false;
    let tram: Tram | null = null, tramOn: unknown = null, tramIn: Promise<void> | null = null;
    let built1: () => void = () => {}, built3: () => void = () => {}, walking1 = false, walking3 = false, fast = false;
    const over = new Promise<DemoEnd>((resolve) => { end = resolve; });
    const clock = makeClock(), wait = clock.wait;
    const ride = makeRide(host, clock);
    const plan = makePlan(host);
    const heard: Heard[] = [];
    const hear = <K extends keyof Station3DEventMap>(name: K, fn: (detail: Station3DEventMap[K]) => void) => { heard.push([name, fn]); S().on(name, fn); };
    const deaf = () => { for (const [name, fn] of heard.splice(0)) S().off(name, fn as (detail: unknown) => void); };

    // ----- hold to go faster -----
    const pace = (base: number) => base * (fast ? FAST : 1);
    const hold = document.createElement('button');
    hold.type = 'button';
    hold.className = 'ob-fast';
    hold.setAttribute('aria-label', `Hold to play ${FAST} times as fast`);
    hold.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5l7 5.5-7 5.5zM13 6.5l7 5.5-7 5.5z" /></svg><span><b>Hold</b><em>' + FAST + '×</em></span>';
    if (!still) host.appendChild(hold);
    const setFast = (on: boolean) => {
      if (fast === on || still || ended) return;
      fast = on;
      clock.set(on ? FAST : 1);
      host.classList.toggle('ob-fasting', on);
      try { if (S().isOpen() && S().isPlaying()) S().play({ speed: pace(act === 3 ? SPEED_3 : SPEED_1) }); } catch (e) {}
    };
    const down = (e: Event) => { if (!(e.target as HTMLElement).closest('.s3-state, a')) setFast(true); };
    const up = () => setFast(false);
    const key = (e: KeyboardEvent) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setFast(e.type === 'keydown'); } };
    const noMenu = (e: Event) => e.preventDefault();
    host.addEventListener('pointerdown', down);
    host.addEventListener('contextmenu', noMenu);
    hold.addEventListener('keydown', key);
    hold.addEventListener('keyup', key);
    for (const n of ['pointerup', 'pointercancel', 'blur'] as const) window.addEventListener(n, up);

    const finish = () => {
      if (ended) return;
      setFast(false);
      ended = true;
      deaf();
      clock.stop();
      host.removeEventListener('pointerdown', down);
      host.removeEventListener('contextmenu', noMenu);
      for (const n of ['pointerup', 'pointercancel', 'blur'] as const) window.removeEventListener(n, up);
      host.classList.remove('ob-fasting');
      hold.remove();
      try { if (tram) tram.remove(); } catch (e) {}
      if (S().isOpen()) S().close();
      ride.destroy();
      plan.destroy();
      end(failed ? 'unavailable' : arrived ? 'finished' : 'skipped');
    };
    // Both walks are opened waiting at their start, out of sight, and set off when their cover has gone
    const walk = (w: Station3DOpenOptions) =>
      S().open({ ...w, pov: true, play: false, chrome: 'demo', prefs: SETTINGS.journey(), mount: host });
    // A tram in the detail scene, if the renderer has one
    const addTram = (): Tram | null => {
      try {
        const h = (S().detail ? S().detail() : null) as TramScene | null;
        return h && h.addVehicle ? h.addVehicle({ kind: 'tram', line: LINE, path: TRACK, length: TRAM_LEN }) : null;
      } catch (e) { return null; }
    };
    const redraw = () => { try { if (S().redraw) S().redraw(); } catch (e) {} };

    // Act 1: the trip at a glance covers the view until the street is built (and for long enough to be read),
    // then the walk sets off
    const setOff1 = async () => {
      if (walking1 || ended) return;
      walking1 = true;
      await wait(350);                               // a few frames of the finished street, behind the cover
      if (ended) return;
      plan.hide();
      if (still || failed) return;
      await wait(700);
      if (!ended && !failed && S().isOpen()) S().play({ speed: pace(SPEED_1) });
    };
    // Act 1 → 2 → 3
    const toRide = async () => {
      if (act !== 1 || ended) return;
      act = 2;
      if (tramIn) await Promise.race([tramIn, wait(9000)]);
      if (tram && !ended) { try { tram.doors(true); redraw(); } catch (e) {} await wait(1100); }
      else await wait(900);
      if (ended) return;
      onState(2, 2);
      ride.show();
      await wait(650);                               // the map has faded in over the 3D view
      if (ended) return;
      // the first walk goes and the second is built, out of sight; it waits at its start
      switching = true;
      try { if (tram) tram.remove(); } catch (e) {}
      tram = null; tramIn = null; tramOn = null;
      const built = new Promise<void>((ok) => { built3 = ok; });
      if (S().isOpen()) S().close();
      await wait(60);
      if (ended) return;
      try { walk(WALK_3); } catch (e) { failed = true; }
      switching = false;
      await ride.play(Promise.race([built, wait(3500)]));   // the scene of the second walk is built before the map moves
      if (ended) return;
      act = 3;
      onState(3, 3);
      ride.hide();
      if (failed) return onState('error', 3);
      setOff3();
    };
    // The second walk sets off, and the tram you came on shuts its doors and drives on
    const setOff3 = async () => {
      if (walking3 || ended) return;
      walking3 = true;
      const t = tram;
      if (t) { try { t.doors(false); redraw(); } catch (e) {} }
      await wait(1700);
      if (ended) return;
      if (S().isOpen()) S().play({ speed: pace(SPEED_3) });
      if (!t) return;
      await wait(2500);                              // …once you are clear of the track
      if (ended || tram !== t) return;
      t.run({ from: S_BHF, to: track.total + 30, seconds: 9, ease: 'depart' }).then(() => { try { t.remove(); } catch (e) {} if (tram === t) tram = null; }, () => {});
      redraw();
    };
    const arrive = () => {
      if (arrived || ended) return;
      arrived = true;
      setFast(false);
      hold.remove();
      onState('arrived', 3);
    };
    const walked = () => { if (act === 1) toRide(); else if (act === 3) arrive(); };

    hear('arrived', () => { if (!still) walked(); });
    hear('step', (e) => { if (e && e.step && e.step.kind === 'arrive' && !still) walked(); });
    hear('progress', (e) => {                        // the tram pulls in as you reach the platform
      if (act !== 1 || !tram || tramIn || e.total - e.along > 15) return;
      tram.show(true);
      tramIn = tram.run({ from: S_HG - 62, to: S_HG, seconds: fast ? 3.5 : 7, ease: 'arrive' }).catch(() => {});
      redraw();
    });
    hear('detail', () => {
      if (act === 1) built1(); else if (act === 2) built3();
      const scene = S().detail ? S().detail() : null;
      if (ended || still || (tram && scene === tramOn)) return;   // (reduced motion: nothing that moves by itself)
      // a scene that was built anew (a change of theme) has lost its tram: it comes back where it was
      const came = !!tram && !!tramIn;
      tram = addTram();
      tramOn = scene;
      tramIn = null;
      if (!tram) return;
      if (act === 1 && !came) { tram.place(S_HG - 62); tram.show(false); }
      else if (act === 1) { tram.place(S_HG); tramIn = Promise.resolve(); }
      else if (!walking3) { tram.place(S_BHF); tram.doors(true); }
      else { tram.remove(); tram = null; }
      redraw();
    });
    hear('error', (e) => {
      if (e && e.code === 'lost') return;             // the drawing surface was lost (the app in the background): the view comes back by itself
      failed = true;
      built1();                                       // the cover goes, so that what the view says can be read
      if (act !== 2) onState('error', act);
    });
    hear('close', () => { if (!switching) finish(); });   // the view's own way out (the back gesture)
    hear('open', () => {                                 // also after the view's "Try again"
      if (act === 1) wait(5000).then(() => built1());     // a street that is not built by then is not coming: the plain model shows
      // the cover has gone already (the viewer came late, or after "Try again"): the walk sets off now
      if (act === 1 && walking1 && !still) wait(600).then(() => { if (!ended && !failed && S().isOpen() && !S().isPlaying()) S().play({ speed: pace(SPEED_1) }); });
      if (!failed) return;
      failed = false;
      if (act !== 2) onState('playing', act);
      if (act === 3) setOff3();                         // "Try again" worked: the second walk was opened waiting
    });
    try {
      onState(1, 1);
      const built = new Promise<void>((ok) => { built1 = ok; });
      walk(WALK_1);
      Promise.all([wait(still ? 400 : 3800), Promise.race([built, wait(12000)])]).then(setOff1);
    } catch (e) {
      ended = true;
      deaf();
      clock.stop();
      hold.remove();
      ride.destroy();
      plan.destroy();
      return none;
    }
    // Reduced motion: nothing walks or glides; each press shows the next act as a still picture
    const next = () => {
      if (!still || ended || arrived || failed) return false;
      if (act === 1) {
        act = 2;
        onState(2, 2);
        plan.hide();
        ride.show();
        ride.still();
        switching = true;
        if (S().isOpen()) S().close();
        wait(60).then(() => { if (ended) return; try { walk(WALK_3); } catch (e) { failed = true; } switching = false; });
      } else if (act === 2) {
        act = 3;
        onState(3, 3);
        ride.hide();
        if (failed) onState('error', 3); else arrive();
      } else return false;
      return true;
    };
    return { over, close: finish, next };
  }

  // ---------- Page ----------
  const ART = `
    <svg class="ob-art" viewBox="0 0 340 190" aria-hidden="true">
      <path class="a-block" d="M0 0h118l-14 52H0zM150 0h190v38H140zM0 118h62l-20 72H0zM214 142h126v48H200z" />
      <rect class="a-mon" x="96" y="76" width="18" height="18" rx="5" />
      <path class="a-case" d="M62 150C84 112 118 108 150 118s62 4 84-22 26-40 46-48" />
      <path class="a-way" d="M62 150C84 112 118 108 150 118M234 96C256 70 260 56 280 48" />
      <path class="a-tram" d="M150 118C182 128 212 122 234 96" />
      <path class="a-chev" d="M100 124l8-5-2 9" />
      <circle class="a-stop" cx="150" cy="118" r="6.5" /><circle class="a-stop" cx="234" cy="96" r="6.5" />
      <path class="a-you" d="M62 136l11 26-11-6-11 6z" transform="rotate(32 62 150)" />
      <circle class="a-pin" cx="280" cy="48" r="9" />
      <rect class="a-bay" x="136" y="134" width="26" height="26" rx="7" /><text class="a-bay-t" x="149" y="153">B</text>
      <rect class="a-line" x="184" y="92" width="26" height="22" rx="7" /><text class="a-bay-t" x="197" y="109">9</text>
    </svg>`;

  const speedRows = SPEEDS.map((s, i) => `
        <label class="set-row">
          <span class="set-text"><b id="obSpeedT${i}">${s.label}</b>${s.note ? `<small id="obSpeedD${i}">${s.note}</small>` : ''}</span>
          <span class="ob-kmh" id="obSpeedK${i}">${s.kmh} km/h</span>
          <input class="ob-pick" type="radio" name="obSpeed" value="${s.kmh}" aria-labelledby="obSpeedT${i}" aria-describedby="obSpeedK${i}${s.note ? ` obSpeedD${i}` : ''}" />
        </label>`).join('');

  const needRows = NEEDS.map((n) => `
        <label class="set-row">
          <span class="set-ic" style="--c:var(--${n.color})${n.color === 'sun' ? ';--f:#344D77' : ''}" aria-hidden="true"><svg viewBox="0 0 24 24">${n.icon}</svg></span>
          <span class="set-text"><b id="obNeedT-${n.key}">${n.title}</b>${n.note ? `<small id="obNeedD-${n.key}">${n.note}</small>` : ''}</span>
          <input class="switch" type="checkbox" role="switch" data-need="${n.key}" aria-labelledby="obNeedT-${n.key}"${n.note ? ` aria-describedby="obNeedD-${n.key}"` : ''} />
        </label>`).join('');

  const MARKUP = `
    <div class="ob-page ob-welcome" data-page="welcome" hidden>
      <div class="ob-scroll"><div class="ob-inner">
        ${ART}
        <h1 id="obT-welcome" tabindex="-1">Want to see what the app can do for you?</h1>
        <p class="ob-lead">Take a short trip in Bern: walk across Hirschengraben to the tram, ride one stop, and walk to the main station, seen the way the app guides you there. It takes about a minute and a half.</p>
      </div></div>
      <div class="ob-actions">
        <button class="ob-btn primary" type="button" data-go="demo">Yes, show me</button>
        <button class="ob-btn quiet" type="button" data-go="speed">Not now</button>
      </div>
    </div>

    <div class="ob-demo" data-page="demo" hidden>
      <h1 class="ob-sr" id="obT-demo" tabindex="-1">The demo: a walk, a tram ride and a walk in Bern</h1>
      <div id="obDemoHost"></div>
      <div class="ob-actions">
        <ol class="ob-acts" id="obActs" aria-hidden="true"><li>Walk to the stop</li><li>Tram 9</li><li>Walk to the station</li></ol>
        <button class="ob-btn soft" id="obSkip" type="button">Skip the demo</button>
      </div>
      <p class="ob-sr" id="obDemoSay" role="status"></p>
    </div>

    <div class="ob-page" data-page="speed" hidden>
      <div class="ob-scroll"><div class="ob-inner">
        <p class="ob-step">Question 1 of 2</p>
        <h1 id="obT-speed" tabindex="-1">How fast do you walk?</h1>
        <p class="ob-lead">The app uses this for every walk: to the stop, between vehicles and to the door. If you are not sure, leave it on Normal.</p>
        <div class="set-group" role="radiogroup" aria-labelledby="obT-speed">${speedRows}
        </div>
        <div class="set-group" id="obAutoGroup" hidden>
          <label class="set-row">
            <span class="set-text"><b id="obAutoT">Adjust to how I walk</b><small id="obAutoD">The app measures your walking pace and sets the speed above for you. The pace is kept only on this device and never sent anywhere.</small></span>
            <input class="switch" type="checkbox" role="switch" id="obAuto" aria-labelledby="obAutoT" aria-describedby="obAutoD" />
          </label>
        </div>
        <p class="set-foot">You can change this at any time in Settings.</p>
      </div></div>
      <div class="ob-actions">
        <button class="ob-btn primary" type="button" data-go="access">Continue</button>
        <button class="ob-btn quiet" type="button" data-go="welcome">Back</button>
      </div>
    </div>

    <div class="ob-page" data-page="access" hidden>
      <div class="ob-scroll"><div class="ob-inner">
        <p class="ob-step">Question 2 of 2</p>
        <h1 id="obT-access" tabindex="-1">Is there anything the app should plan around?</h1>
        <p class="ob-lead">Switch on what applies to you. If nothing does, leave everything off.</p>
        <div class="set-group" role="group" aria-labelledby="obT-access">${needRows}
        </div>
        <p class="set-foot">Your answers stay on this device. You can change them at any time in Settings.</p>
        <p class="set-foot" id="obGeoNote" hidden>Next, your browser asks whether the app may use your location. The app uses it to show where you are and to start journeys from there.</p>
      </div></div>
      <div class="ob-actions">
        <button class="ob-btn primary" type="button" data-go="done">Open the map</button>
        <button class="ob-btn quiet" type="button" data-go="speed">Back</button>
      </div>
    </div>`;

  let el: HTMLElement | null = null;        // the layer, built on first use
  let isOpen = false;
  let demo: Demo | null = null;      // the running demo
  let madeInert: HTMLElement[] = [];
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const $ = <E extends HTMLElement = HTMLElement>(sel: string) => el!.querySelector<E>(sel)!;

  let cssPromise: Promise<unknown> | null = null;
  function loadCss() {
    if (!cssPromise) cssPromise = new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = BASE + 'onboarding.css';
      link.onload = resolve;
      link.onerror = reject;
      document.head.appendChild(link);
    });
    return cssPromise;
  }

  function build() {
    el = document.createElement('section');
    el.className = 'ob';
    el.id = 'onboarding';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.hidden = true;
    el.innerHTML = MARKUP;
    document.body.appendChild(el);

    el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-go]');
      if (b) go(b.dataset.go as PageName | 'done');
      else if ((e.target as HTMLElement).closest('#obSkip') && demo && !demo.next()) demo.close();
    });
    el.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.name === 'obSpeed') SETTINGS.set({ walkKmh: +t.value });
      else if (t.dataset.need) SETTINGS.set({ [t.dataset.need]: t.checked });
      else if (t.id === 'obAuto') SETTINGS.set({ autoSpeed: t.checked });
    });
  }

  // The answers as the settings have them now
  function render() {
    if (!el || !SETTINGS) return;
    const p = SETTINGS.prefs();
    let best = 0;
    SPEEDS.forEach((s, i) => { if (Math.abs(s.kmh - p.walkKmh) < Math.abs(SPEEDS[best].kmh - p.walkKmh)) best = i; });
    el.querySelectorAll<HTMLInputElement>('input[name="obSpeed"]').forEach((input, i) => { input.checked = i === best; });
    el.querySelectorAll<HTMLInputElement>('input[data-need]').forEach((input) => {
      const k = input.dataset.need as NeedKey;
      input.checked = !!p[k];
      input.disabled = impliedBy[k] ? !!impliedBy[k](p) : false;
    });
    // "Adjust to how I walk" exists once the walking-speed-auto branch is in
    const auto = 'autoSpeed' in p;
    $('#obAutoGroup').hidden = !auto;
    if (auto) $<HTMLInputElement>('#obAuto').checked = !!p.autoSpeed;
  }

  function setInert() {
    for (const n of document.body.children as HTMLCollectionOf<HTMLElement>) {
      if (n === el || n.inert || /^(SCRIPT|STYLE|LINK)$/.test(n.tagName)) continue;
      n.inert = true;
      madeInert.push(n);
    }
  }
  const paintChrome = () => { if (themeMeta && isOpen) themeMeta.setAttribute('content', getComputedStyle(el!).getPropertyValue('--sp-bg').trim()); };
  // The app is still starting behind a first visit: what it adds or sets after us is covered too
  const again = () => { if (isOpen) { setInert(); paintChrome(); } };
  document.addEventListener('DOMContentLoaded', again);
  window.addEventListener('load', again);

  function page(name: PageName) {
    for (const p of el!.querySelectorAll<HTMLElement>('[data-page]')) p.hidden = p.dataset.page !== name;
    el!.setAttribute('aria-labelledby', 'obT-' + name);
    const sc = el!.querySelector(`[data-page="${name}"] .ob-scroll`);
    if (sc) sc.scrollTop = 0;
    const h = document.getElementById('obT-' + name);
    if (h) h.focus({ preventScroll: true });
  }

  function go(name: PageName | 'done') {
    if (name === 'demo') return runDemo();
    if (name === 'done') return finish();
    render();
    page(name);
  }

  function runDemo() {
    const skip = $('#obSkip'), say = $('#obDemoSay'), acts = $('#obActs');
    const ACT_SAYS = ['', 'Walking across Hirschengraben to the tram stop.', 'On tram 9 to Bern, Bahnhof. The app noticed that you got on.', 'Walking from the tram stop to the main entrance of the station.'];
    const still = reducedMotion();
    const waiting = () => {
      skip.textContent = still ? 'Next' : 'Skip the demo';
      skip.className = 'ob-btn soft';
    };
    waiting();
    say.textContent = '';
    page('demo');
    const mine = demo = startDemo($('#obDemoHost'), (state, act) => {
      acts.dataset.act = String(act);
      if (state === 'playing') return waiting();
      if (typeof state === 'number') { say.textContent = ACT_SAYS[state]; return; }
      skip.textContent = 'Continue';
      skip.className = 'ob-btn primary go';
      say.textContent = state === 'error' ? 'The demo can’t be shown here. Continue to the questions.' : 'You have arrived at the main station. Continue to the questions.';
      if (state === 'arrived') skip.focus({ preventScroll: true });
    });
    mine.over.then(() => {
      if (demo !== mine) return;
      demo = null;
      if (isOpen) go('speed');
    });
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    if (!html.dataset.onboarding) html.dataset.onboarding = 'again'; // the cover (index.html)
    loadCss().then(() => {
      if (!el) build();
      el!.classList.remove('leaving');
      el!.hidden = false;
      setInert();
      paintChrome();
      // Say on the last page that the location prompt comes next, if it does
      const note = $('#obGeoNote');
      note.hidden = true;
      const geo = window.EARLY_GEO;
      if (geo && !geo.started && window.isSecureContext && navigator.geolocation) {
        if (navigator.permissions && navigator.permissions.query) navigator.permissions.query({ name: 'geolocation' }).then((s) => { note.hidden = s.state !== 'prompt'; }, () => { note.hidden = false; });
        else note.hidden = false;
      }
      go('welcome');
    }).catch(abort);
  }

  // Give the app back: the cover and the layer go, the location prompt comes
  function release() {
    isOpen = false;
    delete html.dataset.onboarding;
    madeInert.forEach((n) => { n.inert = false; });
    madeInert = [];
    if (themeMeta) themeMeta.setAttribute('content', getComputedStyle(html).getPropertyValue('--page-bg').trim());
    if (window.EARLY_GEO && window.EARLY_GEO.start) window.EARLY_GEO.start();
  }

  function finish() {
    try { localStorage.setItem(KEY, 'done'); } catch (e) {}
    // ?intro has done its work: a reload shows the app
    try {
      const u = new URL(location.href);
      if (u.searchParams.has('intro')) { u.searchParams.delete('intro'); history.replaceState(history.state, '', u); }
    } catch (e) {}
    if (demo) { const d = demo; demo = null; d.close(); }
    const layer = el!;
    layer.classList.add('leaving');
    setTimeout(() => { if (!isOpen) layer.hidden = true; }, reducedMotion() ? 0 : 380);
    release();
    const menu = document.getElementById('menuBtn');
    if (menu) menu.focus({ preventScroll: true });
  }

  // Something of ours failed: the app must still start
  function abort() {
    if (el) el.hidden = true;
    release();
  }

  // ---------- Settings › "Show the introduction again" ----------
  let replay = false;
  const reset = document.getElementById('settingsReset');
  if (reset && reset.parentElement && SETTINGS) {
    const group = document.createElement('div');
    group.className = 'set-group set-gap';
    const b = document.createElement('button');
    b.className = 'set-reset';
    b.id = 'settingsIntro';
    b.type = 'button';
    b.textContent = 'Show the introduction again';
    group.append(b);
    reset.parentElement.before(group);
    b.addEventListener('click', () => { replay = true; SETTINGS.close(); });
    SETTINGS.onClose(() => { if (replay) { replay = false; open(); } });
  }
  if (SETTINGS) SETTINGS.onChange(render);

  window.ONBOARDING = { open, isOpen: () => isOpen };

  if (html.dataset.onboarding) {
    if (SETTINGS) open();
    else abort();
  }
})();
