// The introduction for a first visit: a welcome page, the demo (a short journey: a walk, a tram ride, a walk),
// then two short questions that set existing settings (walking speed, access needs), then the map.
// Whether it shows is decided in the <head> of index.html (localStorage 'onboarding', ?intro), which also holds back
// the location prompt until it is over. Settings › "Show the introduction again" opens it once more.
// Nothing is kept here: every answer goes straight into settings.ts (SETTINGS).
import { SETTINGS } from './settings.ts';
import { STYLES, STYLE_URL, makeDarkStyle } from './map-style.ts';
/** The access needs asked for: switches of the settings page. */
type NeedKey = 'wheelchair' | 'stepFree' | 'fewerStairs' | 'noEscalators' | 'lowVision';
interface Need { key: NeedKey; color: string; title: string; note: string; icon: string }
/** What the demo reports while it runs, and how it ended. */
type Act = 1 | 2 | 3;
type DemoState = Act | 'arrived' | 'error';
type DemoEnd = 'finished' | 'skipped' | 'unavailable';
interface Demo { over: Promise<DemoEnd>; close(): void; /** Reduced motion: on to the next act; false when there is none. */ next(): boolean }
type PageName = 'welcome' | 'demo' | 'speed' | 'access';

const KEY = 'onboarding';
const html = document.documentElement;
const me = document.currentScript as HTMLScriptElement | null;
const BASE = ((me && me.src) || '').replace(/[^/]*(\?.*)?$/, '');
const reducedMotion = () => !!((window.matchMedia as typeof matchMedia | undefined) && matchMedia('(prefers-reduced-motion: reduce)').matches);

// The five stops of the walking speed slider: settings.ts exports them once the walking-speed-auto branch is in
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
  { key: 'lowVision', color: 'rose', title: 'I’m blind or have low vision', note: 'Shows events and groups for you. Doesn’t change routes yet.',
    icon: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" />' },
];
// A stricter need includes the milder ones (settings.ts, effective()): those show as on and can't be switched off
const impliedBy: Partial<Record<NeedKey, (p: Settings) => boolean>> = {
  stepFree: (p) => p.wheelchair,
  fewerStairs: (p) => p.stepFree,
  noEscalators: (p) => p.stepFree,
};

// ---------- The demo: the one seam to the showcase ----------
// A short journey in Bern, played by itself in three acts on a tilted map of its own (docs/onboarding.md):
//   1  the walk across Hirschengraben to tram platform B,
//   2  the ride to Bern, Bahnhof: the app notices that you are on the tram and follows it,
//   3  the walk from the tram stop to the main entrance of the station.
// It is a fixed script: no timetable request, the same at any time of day. Nothing else in this file depends on
// what the demo is; `startDemo` is the only place that knows.
type XY = [x: number, y: number];
// The two walks as the station router finds them in stations3d/bern.js (Hirschengraben stop C → stop B; Bern,
// Bahnhof stop B → in front of the main entrance), and the tram track from the south end of Hirschengraben past
// platform B to the stop at the station and on (tracks 3, 238, 139, 187): in the model's metres, x east, y north
const WALK_1: XY[] = [[-68.8, -200.8], [-78.4, -198.5], [-85.7, -204.2], [-93, -202.3], [-94.1, -202.8], [-98.6, -207.9], [-99.9, -210.4]];
const WALK_3: XY[] = [[120.3, -126.7], [118.7, -120.3], [117.6, -116.1], [116.8, -113.1], [116.6, -112.4], [116.4, -108.7], [103.6, -104.1],
  [100, -93.2], [94.9, -84.9], [94.9, -83.1], [94.3, -81.3], [93.3, -80.1], [86, -66], [79.4, -53.1], [75.8, -38.9]];
const TRACK: XY[] = [[-124.94, -292.28], [-101.92, -209.02], [-98.92, -201.22], [-96.81, -197.73], [-93.51, -193.85], [-88.1, -189.5],
  [-81.77, -185.81], [-68.47, -179.57], [-60.85, -176.88], [-51.79, -174.12], [-32.43, -169.1], [6.48, -159.55], [45.36, -150.04],
  [61.27, -145.76], [75.1, -141.14], [141.57, -117.85], [181.2, -104.6]];
const MODEL_ORIGIN = [7.4391, 46.9488], KX = 111320 * Math.cos(MODEL_ORIGIN[1] * Math.PI / 180), KY = 110540;
const toLngLat = (p: XY): [number, number] => [MODEL_ORIGIN[0] + p[0] / KX, MODEL_ORIGIN[1] + p[1] / KY];
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (t: number) => { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };
const gentle = (t: number) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
// A line by its length: the point and the compass bearing at s metres, and the s nearest to a point
interface Line { total: number; at(s: number): XY; bearing(s: number): number; nearest(p: XY): number }
function byLength(line: XY[]): Line {
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
const track = byLength(TRACK), walk1 = byLength(WALK_1), walk3 = byLength(WALK_3);
const S_HG = track.nearest([-102.4, -207.2]);    // where the tram's front stops at Hirschengraben B: just past the end of the walk
const S_BHF = track.nearest([113, -127.9]);      // …and at Bern, Bahnhof B: just before the place where the walk crosses the track
const LINE = '9';
const WALK_MS = 1.3;                              // a normal walking pace, metres a second…
const SPEED_1 = 1.5, SPEED_3 = 1.9;               // …and how much faster each walk plays it
const Z_WALK = 18.6, Z_RIDE = 17.7;              // the map's zoom while walking and riding
const LOAD_MS = 12000;                           // a map that has not come by then is not coming
const COLOR_WALK = '#FFD34B', COLOR_WALK_EDGE = '#14161A';   // walks as the journey map draws them (40-journey-map.ts)

// The demo's own clock: everything in it that walks, waits or glides asks this clock. The journey plays at PACE
// times the pace it was made at, and FAST times that again while the picture is held down. What has its own fixed
// length on the screen (a fade, the trip at a glance) and what waits for something to load uses `real`, which no
// pace changes.
const PACE = 3, FAST = 2;
interface Clock { rate(): number; set(rate: number): void; wait(ms: number): Promise<void>; real(ms: number): Promise<void>; stop(): void }
function makeClock(): Clock {
  const waits = new Set<{ left: number; ok: () => void }>();
  const timers: number[] = [];
  let rate = PACE, dead = false, last = performance.now();
  const id = window.setInterval(() => {
    const now = performance.now(), dt = Math.min(250, now - last) * rate;
    last = now;
    for (const w of [...waits]) { w.left -= dt; if (w.left <= 0) { waits.delete(w); w.ok(); } }
  }, 40);
  return {
    rate: () => rate,
    set(r) { rate = r; },
    wait: (ms) => new Promise<void>((ok) => { if (!dead) waits.add({ left: ms, ok }); }),
    real: (ms) => new Promise<void>((ok) => { if (!dead) timers.push(window.setTimeout(ok, ms)); }),
    stop() { dead = true; clearInterval(id); waits.clear(); timers.forEach(clearTimeout); },
  };
}

// ----- Before act 1: the trip at a glance, while the map loads behind it -----
const ICON_WALK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12.5" cy="4.6" r="1.8" fill="currentColor" stroke="none" /><path d="M12.5 8.2l-2.6 5 3.1 2.6.6 5M9.9 13.2l-1.2 3.6-2.4 3M12.5 8.2l3.2 2.6 2.8.6M12.3 8.4l-3.6 1.4-.9 3" /></svg>';
interface Plan { hide(): void; fail(): void; destroy(): void }
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
        <p class="ob-plan-err" hidden>The map for the demo could not be loaded.</p>
      </div>`;
  host.appendChild(box);
  return {
    hide() { box.classList.remove('on'); },
    // the trip at a glance stays: it is all the demo can show now
    fail() { box.classList.add('on'); box.querySelector<HTMLElement>('.ob-plan-bar')!.hidden = true; box.querySelector<HTMLElement>('.ob-plan-err')!.hidden = false; },
    destroy() { box.remove(); },
  };
}

// ----- The journey, on a map of its own inside the demo's box -----
const ICON_TRAM = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5.5" y="5" width="13" height="12.5" rx="3" /><path d="M5.5 11.5h13M9 20.5l1.5-3M15 20.5l-1.5-3M9 5l3-2.5L15 5" /><circle cx="9" cy="14.5" r=".9" fill="currentColor" stroke="none" /><circle cx="15" cy="14.5" r=".9" fill="currentColor" stroke="none" /></svg>';
const ICON_WAIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>';
const ICON_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z" /><circle cx="12" cy="10.5" r="2.4" /></svg>';
interface Trip {
  /** The map is there (false: it could not be loaded). */
  ready: Promise<boolean>;
  walk1(): Promise<void>;
  ride(): Promise<void>;
  walk3(): Promise<void>;
  /** Reduced motion: the end of that act as a still picture. */
  still(act: Act): void;
  destroy(): void;
}

function makeTrip(host: HTMLElement, clock: Clock): Trip {
  const box = document.createElement('div');
  box.className = 'ob-trip';
  box.innerHTML = `<div class="ob-trip-map"></div>
      <div class="ob-card" role="status"><span class="ob-card-ic"></span><span class="ob-card-t"><b></b><small></small></span></div>`;
  host.appendChild(box);
  const card = box.querySelector<HTMLElement>('.ob-card')!;
  const say = (icon: string, title: string, sub: string, kind: 'walk' | 'wait' | 'tram' | 'off') => {
    card.dataset.kind = kind;
    card.querySelector('.ob-card-ic')!.innerHTML = icon;
    card.querySelector('b')!.textContent = title;
    card.querySelector('small')!.textContent = sub;
  };
  const walking1 = () => say(ICON_WALK, 'Walk to tram platform B', `Across Hirschengraben, 40 m. Tram ${LINE} comes in 1 min`, 'walk');
  const waiting = () => say(ICON_WAIT, `Waiting for tram ${LINE}`, 'Bern, Hirschengraben, platform B', 'wait');
  const riding = () => say(ICON_TRAM, `You’re on tram ${LINE}`, 'The app noticed that you got on. Next stop: Bern, Bahnhof', 'tram');
  const there = () => say(ICON_OFF, 'Bern, Bahnhof: get off here', 'Then a short walk to the main entrance of the station', 'off');
  const walking3 = () => say(ICON_WALK, 'Walk to the main entrance', 'Across Bahnhofplatz and under the Baldachin, 100 m', 'walk');
  const done = () => say(ICON_OFF, 'You have arrived', 'Bern main station, main entrance', 'off');
  walking1();

  const S0 = S_HG - 9, S1 = S_BHF - 9;          // where you are in the tram: at its first door
  let map: maplibregl.Map | null = null, puck: maplibregl.Marker | null = null, puckEl: HTMLElement | null = null;
  let raf = 0, dead = false;
  const wait = clock.wait;
  let cam: { c: XY; b: number } | null = null;   // where the map looks now: its centre and bearing
  const place = (you: XY, center: XY, zoom: number, bearing: number) => {
    if (!map) return;
    if (puck) puck.setLngLat(toLngLat(you));
    map.jumpTo({ center: toLngLat(center), zoom, bearing, pitch: 54 });
    cam = { c: center, b: bearing };
  };
  // you at s on the line; the map looks a little ahead of you
  const view = (line: Line, s: number, ahead: number, zoom: number, bearing: number) => place(line.at(s), line.at(s + ahead), zoom, bearing);
  const asTram = (on: boolean) => { if (puckEl) puckEl.classList.toggle('tram', on); };

  // The map is there once its style has loaded and the first tiles of the base map have come. One that is not there
  // within LOAD_MS (no network, no WebGL, no tiles) has failed, and then nothing more of it is built
  let settled = false, loaded = false, tiled = false, timer = 0;
  let settle: (ok: boolean) => void = () => {};
  const ready = new Promise<boolean>((resolve) => {
    settle = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) { try { if (map) map.remove(); } catch (e) {} map = null; puck = null; puckEl = null; }
      resolve(ok);
    };
  });
  timer = window.setTimeout(() => settle(false), LOAD_MS);
  const ok = (v: boolean) => settle(v);
  const both = () => { if (loaded && tiled) ok(true); };
  try {
    const gl = (window as { maplibregl?: typeof maplibregl }).maplibregl;
    if (!gl) ok(false);
    else {
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
      if (dead || settled) return ok(false);
      map = new gl.Map({
        container: box.querySelector<HTMLElement>('.ob-trip-map')!, style: st, interactive: false, attributionControl: false,
        center: toLngLat(walk1.at(8)), zoom: Z_WALK, bearing: walk1.bearing(4), pitch: 54, maxPitch: 60,
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2), fadeDuration: 0, refreshExpiredTiles: false,
      });
      map.on('error', () => {});
      // a tile of the base map (not of the demo's own lines) has come: there is something to see
      map.on('sourcedata', (e) => {
        if (tiled || !(e as { tile?: unknown }).tile || String(e.sourceId).startsWith('ob-')) return;
        tiled = true;
        both();
      });
      map.once('load', () => {
        if (dead || settled || !map) return ok(false);
        // houses stand up from the map, so the tilted picture reads as a place (the style draws them flat)
        try {
          const flat = st.layers.find((l) => l.type === 'fill' && (l as { 'source-layer'?: string })['source-layer'] === 'building') as { source: string } | undefined;
          if (flat) map.addLayer({
            id: 'ob-trip-houses', type: 'fill-extrusion', source: flat.source, 'source-layer': 'building', minzoom: 15,
            paint: {
              'fill-extrusion-color': dark ? '#3a3d47' : '#e9e6e0', 'fill-extrusion-opacity': .94,
              'fill-extrusion-height': ['coalesce', ['get', 'render_height'], ['get', 'height'], 15],
            },
          });
        } catch (e) {}
        const line = (id: string, coords: [number, number][], paint: { color: string; width: number; edge: string; edgeWidth: number }) => {
          map!.addSource(id, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } } });
          const layout = { 'line-cap': 'round', 'line-join': 'round' } as const;
          map!.addLayer({ id: id + '-case', type: 'line', source: id, layout, paint: { 'line-color': paint.edge, 'line-width': paint.edgeWidth } });
          map!.addLayer({ id: id + '-line', type: 'line', source: id, layout, paint: { 'line-color': paint.color, 'line-width': paint.width } });
        };
        const ride: [number, number][] = [];
        for (let s = S0 - 30; s <= S1 + 26; s += 2) ride.push(toLngLat(track.at(s)));
        line('ob-ride', ride, { color: '#d6001c', width: 6.5, edge: dark ? '#1c1c1e' : '#ffffff', edgeWidth: 11 });
        for (const [id, w] of [['ob-walk1', WALK_1], ['ob-walk3', WALK_3]] as const) line(id, w.map(toLngLat), { color: COLOR_WALK, width: 7, edge: COLOR_WALK_EDGE, edgeWidth: 10 });
        const stop = (at: XY, name: string, side: 'left' | 'right') => {
          const e = document.createElement('div');
          e.className = 'ob-stop ' + side;
          e.innerHTML = `<i></i><span>${name}</span>`;
          new gl.Marker({ element: e, anchor: 'center' }).setLngLat(toLngLat(at)).addTo(map!);
        };
        stop(track.at(S0), 'Hirschengraben', 'left');
        stop(track.at(S1), 'Bern, Bahnhof', 'right');
        stop(walk3.at(walk3.total), 'Main entrance', 'right');
        puckEl = document.createElement('div');
        puckEl.className = 'ob-puck';
        puckEl.innerHTML = `<span class="ob-puck-you"></span><span class="ob-puck-tram">${ICON_TRAM}<b>${LINE}</b></span>`;
        puck = new gl.Marker({ element: puckEl, anchor: 'center' }).setLngLat(toLngLat(walk1.at(0))).addTo(map);
        view(walk1, 0, 8, Z_WALK, walk1.bearing(4));
        loaded = true;
        both();
      });
    }).catch(() => ok(false));
    }
  } catch (e) { ok(false); }

  // Along `line` from s0 to s1 in T ms of the demo's clock. The map looks `ahead` metres in front of you and turns
  // towards `aim` (default: the way the line goes), both a little behind, so that nothing jumps from one part of
  // the journey to the next
  const glide = (line: Line, s0: number, s1: number, T: number, ease: (t: number) => number, ahead: number, zoom: (u: number) => number,
    aim = (s: number) => line.bearing(s + ahead * 1.4)) => {
    let went = 0, last = 0;
    return new Promise<void>((finished) => {
      const tick = (now: number) => {
        if (dead) return finished();
        const dt = last ? Math.min(100, now - last) : 0;
        last = now;
        went += dt * clock.rate();
        const u = clamp(went / T, 0, 1), s = s0 + (s1 - s0) * ease(u);
        const to = line.at(s + ahead), c = cam ? cam.c : to, b = cam ? cam.b : aim(s);
        const kc = 1 - Math.exp(-dt / 350), kb = 1 - Math.exp(-dt / 900);
        let d = aim(s) - b;
        d = ((d + 540) % 360) - 180;
        place(line.at(s), [c[0] + (to[0] - c[0]) * kc, c[1] + (to[1] - c[1]) * kc], zoom(u), b + d * kb);
        if (u < 1) raf = requestAnimationFrame(tick); else finished();
      };
      raf = requestAnimationFrame(tick);
    });
  };
  // a few steps from one line to the next (onto the tram, off it)
  const hop = (from: XY, to: XY, T: number, zoom: (u: number) => number, aim: number) => {
    const step = byLength([from, to]);
    return glide(step, 0, step.total, T, smooth, 0, zoom, () => aim);
  };
  const walkTime = (line: Line, speed: number) => line.total / (WALK_MS * speed) * 1000;

  return {
    ready,
    async walk1() {
      walking1();
      asTram(false);
      await glide(walk1, 0, walk1.total, walkTime(walk1, SPEED_1), gentle, 8, () => Z_WALK);
    },
    // You wait, the tram is recognised, it glides to the station
    async ride() {
      waiting();
      // from the end of the walk to the tram's door, while the map draws back a little
      await hop(walk1.at(walk1.total), track.at(S0), 900, (u) => Z_WALK + (Z_RIDE - Z_WALK) * smooth(u), track.bearing(S0 + 22));
      await wait(2400);                       // a moment to read that the app knows you are waiting
      if (dead) return;
      asTram(true);
      riding();
      await wait(1700);
      if (dead) return;
      await glide(track, S0, S1, 9000, smooth, 16, (u) => Z_RIDE - .55 * Math.sin(Math.PI * u));
      if (dead) return;
      there();
      await wait(1500);
    },
    async walk3() {
      asTram(false);
      walking3();
      await hop(track.at(S1), walk3.at(0), 900, () => Z_RIDE, walk3.bearing(14));
      if (dead) return;
      await glide(walk3, 0, walk3.total, walkTime(walk3, SPEED_3), gentle, 10, (u) => Z_RIDE + (Z_WALK - Z_RIDE) * smooth(u * 4));
      if (dead) return;
      done();
    },
    still(act) {
      ready.then((ok) => {
        if (!ok || dead) return;
        if (act === 1) { asTram(false); waiting(); view(walk1, walk1.total, 8, Z_WALK, walk1.bearing(walk1.total - 6)); }
        else if (act === 2) { asTram(true); there(); view(track, S1, -10, Z_RIDE, track.bearing(S1 - 20)); }
        else { asTram(false); done(); view(walk3, walk3.total, -14, Z_WALK - .3, walk3.bearing(walk3.total - 10)); }
      });
    },
    destroy() {
      dead = true;
      settle(false);
      cancelAnimationFrame(raf);
      try { if (map) map.remove(); } catch (e) {}
      map = null;
      box.remove();
    },
  };
}

// history.back() for the entry of a demo that has ended arrives later, as a 'popstate'. Until it has, `leaving`
// holds back the entry of a new demo.
let leaving: Promise<void> | null = null;
function leaveEntry() {
  leaving = new Promise<void>((done) => {
    const gone = () => { window.removeEventListener('popstate', gone); leaving = null; done(); };
    window.addEventListener('popstate', gone);
    try { history.back(); } catch (e) { gone(); }
  });
}

// Starts the demo inside `host`. `onState` hears the act that begins (1, 2, 3), 'arrived' (the journey is at its
// end; the last picture stays) and 'error' (the map could not be shown). `over` resolves once it has gone:
// 'finished' (after arriving), 'skipped' (before) or 'unavailable'. close() ends it from outside; so does the
// back gesture. With prefers-reduced-motion nothing moves by itself: `next()` steps to the following act and
// returns false once there is none.
// While the picture is held down (anywhere on it, or on the button at its right edge), everything runs FAST times
// as fast as it does otherwise.
function startDemo(host: HTMLElement, onState: (state: DemoState, act: Act) => void): Demo {
  const still = reducedMotion();
  let end: (how: DemoEnd) => void, act: Act = 1, arrived = false, failed = false, ended = false, fast = false;
  const over = new Promise<DemoEnd>((resolve) => { end = resolve; });
  const clock = makeClock(), real = clock.real;
  const trip = makeTrip(host, clock);
  const plan = makePlan(host);

  // ----- hold to go faster -----
  const hold = document.createElement('button');
  hold.type = 'button';
  hold.className = 'ob-fast';
  hold.setAttribute('aria-label', `Hold to play ${FAST === 2 ? 'twice' : FAST + ' times'} as fast`);
  hold.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5l7 5.5-7 5.5zM13 6.5l7 5.5-7 5.5z" /></svg><span><b>Hold</b><em>' + FAST + '×</em></span>';
  if (!still) host.appendChild(hold);
  const setFast = (on: boolean) => {
    if (fast === on || still || ended) return;
    fast = on;
    clock.set(on ? PACE * FAST : PACE);
    host.classList.toggle('ob-fasting', on);
  };
  const down = (e: Event) => { if (!(e.target as HTMLElement).closest('a')) setFast(true); };
  const up = () => setFast(false);
  const key = (e: KeyboardEvent) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setFast(e.type === 'keydown'); } };
  const noMenu = (e: Event) => e.preventDefault();
  host.addEventListener('pointerdown', down);
  host.addEventListener('contextmenu', noMenu);
  hold.addEventListener('keydown', key);
  hold.addEventListener('keyup', key);
  for (const n of ['pointerup', 'pointercancel', 'blur'] as const) window.addEventListener(n, up);

  // ----- the back gesture leads on, as the button does: the demo has an entry in the history while it runs -----
  // (added once the entry of an earlier demo has gone: its 'popstate' must not end this one)
  let pushed = false;
  const onPop = () => { if (pushed) { pushed = false; finish(); } };
  (leaving || Promise.resolve()).then(() => {
    if (ended) return;
    try {
      // without ?intro: going forward to this entry after the introduction must not bring it back
      const u = new URL(location.href);
      u.searchParams.delete('intro');
      history.pushState({ onboardingDemo: true }, '', u);
      pushed = true;
      window.addEventListener('popstate', onPop);
    } catch (e) {}
  });

  const finish = () => {
    if (ended) return;
    setFast(false);
    ended = true;
    clock.stop();
    host.removeEventListener('pointerdown', down);
    host.removeEventListener('contextmenu', noMenu);
    for (const n of ['pointerup', 'pointercancel', 'blur'] as const) window.removeEventListener(n, up);
    window.removeEventListener('popstate', onPop);
    if (pushed) { pushed = false; leaveEntry(); }
    host.classList.remove('ob-fasting');
    hold.remove();
    trip.destroy();
    plan.destroy();
    end(failed ? 'unavailable' : arrived ? 'finished' : 'skipped');
  };
  const arrive = () => {
    if (arrived || ended) return;
    arrived = true;
    setFast(false);
    hold.remove();
    onState('arrived', 3);
  };
  // The map has not come: the trip at a glance stays with a line that says so, and nothing more is built or run
  const fail = () => {
    if (ended || arrived || failed) return;
    failed = true;
    setFast(false);
    clock.stop();
    trip.destroy();
    hold.remove();
    plan.fail();
    onState('error', act);
  };

  // The trip at a glance covers the map until it is there (and for long enough to be read), then the walk sets off
  onState(1, 1);
  let shown = false;                               // the map is there and the cover has gone
  Promise.all([real(still ? 400 : 3800), trip.ready]).then(async ([, ok]) => {
    if (ended) return;
    if (!ok) return fail();
    await real(350);                               // a few frames of the finished map, behind the cover
    if (ended) return;
    plan.hide();
    shown = true;
    if (still) { trip.still(act); return; }
    await real(700);                               // the cover has faded
    if (ended) return;
    await trip.walk1();
    if (ended) return;
    act = 2;
    onState(2, 2);
    await trip.ride();
    if (ended) return;
    act = 3;
    onState(3, 3);
    await trip.walk3();
    if (ended) return;
    await real(400);
    arrive();
  });
  // Reduced motion: nothing walks or glides; each press shows the next act as a still picture
  const next = () => {
    if (!still || ended || arrived || failed) return false;
    if (!shown) return true;                       // nothing to show yet: the trip at a glance stays until the map is there
    if (act === 3) return false;
    act = act === 1 ? 2 : 3;
    onState(act, act);
    trip.still(act);
    if (act === 3) arrive();
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
        <p class="ob-lead">Walk to the tram, ride one stop and walk to Bern main station, guided by the app. About half a minute.</p>
      </div></div>
      <div class="ob-actions">
        <button class="ob-btn primary" type="button" data-go="demo">Yes, show me</button>
        <button class="ob-btn quiet" type="button" data-go="speed">Skip demo</button>
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
        <p class="ob-lead">Used for every walk. Not sure? Leave it on Normal.</p>
        <div class="set-group" role="radiogroup" aria-labelledby="obT-speed">${speedRows}
        </div>
        <div class="set-group" id="obAutoGroup" hidden>
          <label class="set-row">
            <span class="set-text"><b id="obAutoT">Adjust to how I walk</b><small id="obAutoD">Measures your pace and sets the speed for you. Stays on this device.</small></span>
            <input class="switch" type="checkbox" role="switch" id="obAuto" aria-labelledby="obAutoT" aria-describedby="obAutoD" />
          </label>
        </div>
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
        <p class="ob-lead">Switch on what applies to you.</p>
        <div class="set-group" role="group" aria-labelledby="obT-access">${needRows}
        </div>
        <p class="set-foot">Stays on this device. Change it anytime in Settings.</p>
        <p class="set-foot" id="obGeoNote" hidden>Next, your browser asks for your location, to show where you are and start journeys there.</p>
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
const paintChrome = () => { if (themeMeta && isOpen && el) themeMeta.setAttribute('content', getComputedStyle(el).getPropertyValue('--sp-bg').trim()); };
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
  skip.textContent = still ? 'Next' : 'Skip the demo';
  skip.className = 'ob-btn soft';
  say.textContent = '';
  page('demo');
  const mine = demo = startDemo($('#obDemoHost'), (state, act) => {
    acts.dataset.act = String(act);
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
if (reset && SETTINGS) {
  const b = document.createElement('button');
  b.className = 'set-reset';
  b.id = 'settingsIntro';
  b.type = 'button';
  b.textContent = 'Show the introduction again';
  reset.classList.add('set-line');
  reset.before(b);
  b.addEventListener('click', () => { replay = true; SETTINGS.close(); });
  SETTINGS.onClose(() => { if (replay) { replay = false; open(); } });
}
if (SETTINGS) SETTINGS.onChange(render);

export const ONBOARDING: OnboardingApi = { open, isOpen: () => isOpen };

if (html.dataset.onboarding) {
  if (SETTINGS) open();
  else abort();
}
