/* 3D station viewer: window.Station3D. Model format and API: stations3d/SCHEMA.md.
   Nothing heavy runs until Station3D.open(): three.js, the station model, the router and the styles
   are loaded on first use. The viewer never writes into a model: everything it derives lives in its own maps.

   Station3D.has(uic) → key | null
   Station3D.open({ key, from, to, prefs, title,      from / to as for StationRoute.route (a stop may carry sector);
                    date,                               the day closures and notices are judged for (or prefs.date)
                    season: "winter" | "summer",        detail scenes: bare or leafy trees (default: what the data says)
                    quality: "high" | "low",            detail scenes: how fine they are drawn (default: by the device)
                    peel, still, step, level, list,     how it opens: floors apart 0..1, no intro, a step, one floor, the step list
                    follow, pov, povAt, povYaw, povPitch,
                    play: true | { speed },             the walk plays by itself in the first-person view (speed: a multiplier
                                                        of walking pace, default 1.5); with prefers-reduced-motion it waits
                                                        at the first step for the Play button
                    returnFocus,                        the element that gets the focus back on close
                    arrive: { look: [x, y] },           first-person view: over the last metres the head turns to that place
                                                        (model metres), the walk brakes gently and rests looking there
                    chrome: "demo",                     only the picture, the instruction card (at the top) and the signs;
                                                        with pov it opens at eye level, without the flight down
                    modal: false,                       leave the rest of the page usable (development page)
                    mount, pickAnywhere })
     both ends: the route · only `to` (or only `from`): that place, shown and framed, ready for "route from where I am"
     · none: explore · the same place twice: "stay on platform 7" · no way in the plan: said so, the destination shown
   Station3D.setUser({ ll, accuracy, heading } | null)   live position; far outside the model it is said, not followed
     (also { xy, level, levelSure } from the indoor position, indoornav.js: levelSure = that floor is trusted)
   Station3D.close() · isOpen() · selectStep(i) · setFollow(bool) · setPov(bool) · setPeel(0..1)
   Station3D.play({ speed }?) → bool (is it walking now) · pause() · isPlaying()   the walk by itself; any touch on the
     scene, the scrubber, a step or "I'm here" pauses it; a live position with follow mode takes precedence
   Station3D.enableCompass() → Promise<'granted' | 'denied' | 'unavailable'>
   Station3D.preload(key) · loadData(key) → model | null
   Station3D.detail() → the handle of the detail scene that is built now | null · redraw() draw again (after something
     was added to that scene from outside); a handle with tick(now) → bool is called every frame and keeps the frames
     coming while it answers true · 'detail' { id } when a detail scene was built and shows
   Station3D.on(name, fn) / off: 'open' { key, route, focus } · 'close' · 'done' { route } (the Done button)
     · 'step' { index, step } · 'pick' { title, level, xy, ll, stop, area, endpoint } · 'follow' bool · 'pov' bool
     · 'arrived' { by: 'play' | 'scrub' | 'step' | 'position' } once per open, when the walk reaches the destination
     · 'progress' { along, total, step } metres walked in the first-person view, a few per second · 'play' bool
     · 'error' { code, message } */
(function () {
  'use strict';

  const THREE_URL = 'https://unpkg.com/three@0.170.0/build/three.module.min.js';
  const HASH = '#station3d';
  const me = document.currentScript as HTMLScriptElement | null;
  const SRC = (me && me.src) || '';
  const BASE = SRC.replace(/[^/]*(\?.*)?$/, '');
  const BUST = SRC.includes('?') ? SRC.slice(SRC.indexOf('?')) : ''; // a cache-busting query is passed on to what we load
  const INK = '#14161A', WARN = '#ff9500', SIGN_BLUE = '#1f3a8a';
  const FOV = 30;
  const POV_FOV = 76, EYE = 1.6;
  const HS_MODEL = .6;        // rooms and buildings are drawn at this part of their height in the model view
  const POL_FLAT = .03, POL_PEEL = 1.0; // camera angle from straight above: the flat plan, the floors fully peeled apart
  const PLATE_TOP = -1.1;     // a floor plate lies just under the track beds of its floor
  const FAR_M = 150;          // a position further than this outside the model is "not at the station"
  const WALK_MS = 1.4;        // metres per second: a person walking
  const PLAY_SPEED = 1.5;     // the walk that plays by itself is a little brisker than that (38 m in about 20 s)

  // A reload (or a restored tab) can leave our hash behind with no viewer: drop it, so the next open adds its own entry
  try { if (location.hash === HASH) history.replaceState(null, '', location.pathname + location.search); } catch (e) {}

  // ---------- small helpers ----------
  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: string | null): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const reducedMotion = () => !!((window.matchMedia as typeof matchMedia | undefined) && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const isDark = () => document.documentElement.dataset.theme === 'dark';
  const angDiff = (a: number, b: number) => { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
  // A value follows its goal without a jolt: critically damped, so its speed never jumps either, whatever the length
  // of the frame. s: roughly the time it takes (seconds); dt in seconds. → [value, speed]
  const damp = (cur: number, goal: number, vel: number, s: number, dt: number): [number, number] => {
    const om = 2 / s, x = om * dt, e = 1 / (1 + x + .48 * x * x + .235 * x * x * x), ch = cur - goal, tmp = (vel + om * ch) * dt;
    return [goal + (ch + tmp) * e, (vel - om * tmp) * e];
  };
  const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
  // an end of the route inside a sentence: "platform 7", but a stop without a number keeps its name as it is
  const lowName = (o: EndInfo) => (o && o.kind === 'stop' && !o.ref ? o.name : lowerFirst(o && o.name));

  // The app's --spring curve, cubic-bezier(.32,.72,0,1), as a function
  function bezier(x1: number, y1: number, x2: number, y2: number) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    return (x: number) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) {
        const d = (3 * ax * t + 2 * bx) * t + cx;
        if (Math.abs(d) < 1e-6) break;
        t -= (((ax * t + bx) * t + cx) * t - x) / d;
      }
      t = clamp(t, 0, 1);
      return ((ay * t + by) * t + cy) * t;
    };
  }
  const spring = bezier(.32, .72, 0, 1);
  const easeInOut = (t: number) => (t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  const ICON: Record<string, string> = {
    walk: '<circle cx="13" cy="4.2" r="1.9"/><path d="M10.5 21l1.5-5.5 2.5 2.5v3M8.5 12.5l2.5-4.5 3 1 2 3.5M12 15.5l-1.2-6.5"/>',
    stairs: '<path d="M4 20h5v-5h5v-5h5V5"/>',
    escalator: '<path d="M3 15.5h4.5L15 7h6M3 20h6.5L17 11.5h4"/>',
    ramp: '<path d="M3 18.5h18V9.5z"/>',
    elevator: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M9.3 10.3L12 7.6l2.7 2.7M9.3 13.7l2.7 2.7 2.7-2.7"/>',
    arrive: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    next: '<path d="M9 6l6 6-6 6"/>',
    prev: '<path d="M15 6l-6 6 6 6"/>',
    play: '<path d="M8.5 5.2v13.6L19.5 12z"/>',
    pause: '<rect x="6.6" y="5" width="3.8" height="14" rx="1.1"/><rect x="13.6" y="5" width="3.8" height="14" rx="1.1"/>',
    close: '<path d="M2.5 2.5l9 9M11.5 2.5l-9 9"/>',
    fit: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>',
    follow: '<path d="M20 4L3.5 10.6l6.6 2.2 2.2 6.7z"/>',
    layers: '<path d="M12 3.5l8.5 4.3-8.5 4.3-8.5-4.3zM3.5 12.2l8.5 4.3 8.5-4.3M3.5 16.4l8.5 4.3 8.5-4.3"/>',
    flat: '<path d="M12 7.5l8.5 4.5-8.5 4.5L3.5 12z"/>',
    tleft: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v5"/>',
    tright: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0-6 6v5"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    phone: '<rect x="7.5" y="3" width="9" height="18" rx="2.2"/><path d="M3 9.5a9 9 0 0 0 0 5M21 9.5a9 9 0 0 1 0 5"/>',
    centre: '<path d="M12 20V8M7 12.5l5-5 5 5M5 4h14"/>',
    here: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3.3M12 18.2v3.3M2.5 12h3.3M18.2 12h3.3"/>',
    info: '<path d="M12 11v6M12 7.2v.1"/><circle cx="12" cy="12" r="9"/>',
    warn: '<path d="M12 4.2l8.8 15.3H3.2zM12 10.2v4.3M12 17.3v.1"/>',
    closed: '<circle cx="12" cy="12" r="9"/><path d="M7.5 12h9"/>',
    check: '<path d="M5 12.8l4.4 4.4L19 7.6"/>',
    door: '<path d="M6.5 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M4 21h16M14.3 12.3v.1"/>',
    tram: '<rect x="6.5" y="5.5" width="11" height="11.5" rx="2.6"/><path d="M9.5 20.5l1.2-3.5M14.5 20.5L13.3 17M6.5 11.5h11M9 2.8h6M12 2.8v2.7"/>',
    bus: '<rect x="5" y="4.5" width="14" height="12.5" rx="2.4"/><path d="M5 11.5h14M8.2 20v-3M15.8 20v-3"/>',
    tickets: '<path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4zM14 6v12"/>',
    toilets: '<circle cx="7.5" cy="5" r="1.8"/><circle cx="16.5" cy="5" r="1.8"/><path d="M7.5 9v11M4.5 13l3-4 3 4M16.5 9v11M13.5 16h6l-3-7z"/>',
    'meeting-point': '<circle cx="12" cy="12" r="2.2"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>',
    lockers: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M5 12h14M14.5 8h.01M14.5 16h.01"/>',
  };
  const svg = (name: string, vb?: string) => `<svg viewBox="${vb || '0 0 24 24'}" aria-hidden="true">${ICON[name] || ''}</svg>`;

  const levelShort = (l: number) => { const a = String(Math.round(Math.abs(l) * 10) / 10); return l < 0 ? '−' + a : l > 0 ? '+' + a : '0'; };
  const nounOf = (mode: string) => (mode === 'train' || mode === 'cable' || mode === 'cableway' || mode === 'rack' || mode === 'funicular' ? 'Platform' : mode === 'boat' || mode === 'ship' ? 'Pier' : 'Stop');
  const fmtM = (m: number) => (m < 7.5 ? 'a few steps' : `${Math.round(m / 5) * 5} m`);
  const fmtFar = (m: number) => (m >= 950 ? `${(m / 1000).toFixed(m < 9950 ? 1 : 0)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`);
  const fmtSec = (s: number) => (s < 50 ? `${Math.max(10, Math.round(s / 10) * 10)} s` : `${Math.round(s / 60)} min`);
  const fmtMin = (s: number) => (s < 45 ? 'under 1 min' : `${Math.max(1, Math.round(s / 60))} min`);
  const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60) % 60).padStart(2, '0')}`;
  const CONN_NOUN: Record<string, string> = { stairs: 'the stairs', escalator: 'the escalator', ramp: 'the ramp', elevator: 'the lift' };
  const CONN_WORD: Record<string, string> = { stairs: 'Stairs', escalator: 'Escalator', ramp: 'Ramp', elevator: 'Lift' };
  // The one rule for comparing platform names is the router's (StationRoute.platformKey); without the router only exact names match
  const pkey = (r: string | number | null | undefined) => (window.StationRoute && window.StationRoute.platformKey ? window.StationRoute.platformKey(r) : String(r == null ? '' : r).toUpperCase().trim());

  // ---------- loading (everything is lazy) ----------
  let THREE: ThreeModule = null!;
  let threePromise: Promise<ThreeModule> | null = null;
  const scriptPromises = new Map<string, Promise<void>>();
  function loadScript(src: string) {
    if (!scriptPromises.has(src)) {
      scriptPromises.set(src, new Promise<void>((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => { scriptPromises.delete(src); s.remove(); reject(new Error('Could not load ' + src)); };
        document.head.appendChild(s);
      }));
    }
    return scriptPromises.get(src)!;
  }
  function loadThree() {
    if (!threePromise) threePromise = import(THREE_URL).then((m: ThreeModule) => (THREE = m), (e) => { threePromise = null; throw e; });
    return threePromise;
  }
  let cssPromise: Promise<void> | null = null;
  function loadCss() {
    if (cssPromise) return cssPromise;
    const have = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].some((l) => /station3d\.css/.test(l.href));
    cssPromise = have ? Promise.resolve() : new Promise<void>((resolve, reject) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = BASE + 'station3d.css' + BUST;
      l.onload = () => resolve();
      // without its styles the view would be an unstyled heap at the end of the page: fail, and let the next open try again
      l.onerror = () => { cssPromise = null; l.remove(); reject(Object.assign(new Error('Could not load station3d.css'), { s3: 'css' })); };
      document.head.appendChild(l);
    });
    return cssPromise;
  }
  function loadModel(key: string) {
    const have = () => window.STATION3D && window.STATION3D[key];
    if (have()) return Promise.resolve(have()!);
    return loadScript(BASE + 'stations3d/' + key + '.js' + BUST).then(() => {
      if (!have()) throw new Error('No model "' + key + '"');
      return have()!;
    });
  }
  function loadRouter() {
    if (window.StationRoute) return Promise.resolve(window.StationRoute);
    return loadScript(BASE + 'station-route.js' + BUST).then(() => window.StationRoute || null, () => null);
  }

  // Detail scenes (stations3d/DETAIL.md): a short stretch drawn with everything you would recognise on the spot.
  // Which stations have one is in a tiny manifest, loaded with the model (and not missed if it is not there); the
  // renderer and the scene itself are loaded only when a walk or the eye comes near.
  let detailIndexPromise: Promise<Record<string, StationDetailIndexEntry | StationDetailIndexEntry[]>> | null = null;
  function loadDetailIndex() {
    if (!detailIndexPromise) {
      detailIndexPromise = (window.STATION3D_DETAIL_INDEX ? Promise.resolve() : loadScript(BASE + 'stations3d/detail-index.js' + BUST))
        .then(() => window.STATION3D_DETAIL_INDEX || {}, () => ({}));
    }
    return detailIndexPromise;
  }
  /** One detail scene of a station: its key in STATION3D_DETAIL, its file, the bbox of its area. */
  interface DetailEntry { id: string; file: string; bbox: Box4 }
  function loadDetail(entry: DetailEntry) {
    const have = () => (window.Station3DDetail && window.STATION3D_DETAIL && window.STATION3D_DETAIL[entry.id]) || null;
    if (have()) return Promise.resolve(have());
    return Promise.all([window.Station3DDetail ? null : loadScript(BASE + 'station3d-detail.js' + BUST), loadScript(BASE + entry.file + BUST)]).then(have, () => null);
  }
  const inBB = (b: Box4, x: number, y: number, m: number) => x >= b[0] - m && x <= b[2] + m && y >= b[1] - m && y <= b[3] + m;

  // ---------- model helpers ----------
  /** A point of which only x and y are read: an XY or an XYL. */
  type Pt = readonly [x: number, y: number, ...rest: number[]];
  type Box4 = [x0: number, y0: number, x1: number, y1: number];
  /** A rectangle at any angle: its centre, the direction of its long axis, its half sizes. */
  interface Obb { cx: number; cy: number; ux: number; uy: number; hw: number; hh: number }
  interface Nearest { x: number; y: number; d: number; dx: number; dy: number; i: number; t: number }
  const toLocal = (model: StationModel, ll: LngLat): XY => {
    const [lng0, lat0] = model.origin;
    return [(ll[0] - lng0) * 111320 * Math.cos(lat0 * Math.PI / 180), (ll[1] - lat0) * 110540];
  };
  const toLngLat = (model: StationModel, xy: Pt): LngLat => {
    const [lng0, lat0] = model.origin;
    return [lng0 + xy[0] / (111320 * Math.cos(lat0 * Math.PI / 180)), lat0 + xy[1] / 110540];
  };

  function cleanRing(ring: readonly Pt[] | null | undefined, ccw: boolean) {
    const out: XY[] = [];
    for (const p of ring || []) {
      const q = out[out.length - 1];
      if (!q || Math.abs(q[0] - p[0]) > 1e-3 || Math.abs(q[1] - p[1]) > 1e-3) out.push([p[0], p[1]]);
    }
    if (out.length > 1) {
      const a = out[0], b = out[out.length - 1];
      if (Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3) out.pop();
    }
    if (out.length < 3) return null;
    let area = 0;
    for (let i = 0, j = out.length - 1; i < out.length; j = i++) area += (out[j][0] * out[i][1] - out[i][0] * out[j][1]);
    if ((area > 0) !== ccw) out.reverse();
    return out;
  }
  function inRing(ring: readonly Pt[], x: number, y: number) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function hull(points: XY[]) {
    const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o: XY, a: XY, b: XY) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: XY[] = [];
    for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
    const upper: XY[] = [];
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }
  // The smallest rectangle (at any angle) around some points: { cx, cy, ux, uy (long axis), hw, hh (half sizes) }
  function obb(points: XY[]): Obb {
    const h = hull(points);
    let best = null as { area: number; ux: number; uy: number; a0: number; a1: number; b0: number; b1: number } | null;
    const tryDir = (ux: number, uy: number) => {
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const p of h) {
        const a = p[0] * ux + p[1] * uy, b = -p[0] * uy + p[1] * ux;
        if (a < a0) a0 = a; if (a > a1) a1 = a;
        if (b < b0) b0 = b; if (b > b1) b1 = b;
      }
      const area = (a1 - a0) * (b1 - b0);
      if (!best || area < best.area - 1e-6) best = { area, ux, uy, a0, a1, b0, b1 };
    };
    if (h.length < 2) { const p = h[0] || [0, 0]; return { cx: p[0], cy: p[1], ux: 1, uy: 0, hw: 0, hh: 0 }; }
    for (let i = 0; i < h.length; i++) {
      const a = h[i], b = h[(i + 1) % h.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l > 1e-6) tryDir((b[0] - a[0]) / l, (b[1] - a[1]) / l);
    }
    if (!best) return { cx: h[0][0], cy: h[0][1], ux: 1, uy: 0, hw: 0, hh: 0 };
    let { ux, uy, a0, a1, b0, b1 } = best;
    let hw = (a1 - a0) / 2, hh = (b1 - b0) / 2;
    const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
    const cx = ca * ux - cb * uy, cy = ca * uy + cb * ux;
    if (hh > hw) { [hw, hh] = [hh, hw]; [ux, uy] = [-uy, ux]; }
    return { cx, cy, ux, uy, hw, hh };
  }
  const boxRing = (b: Obb): XY[] => { // corners, counter-clockwise
    const vx = -b.uy, vy = b.ux;
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => [b.cx + b.ux * b.hw * s + vx * b.hh * t, b.cy + b.uy * b.hw * s + vy * b.hh * t]);
  };
  const inBox = (b: Obb, x: number, y: number, m?: number) => {
    const dx = x - b.cx, dy = y - b.cy;
    return Math.abs(dx * b.ux + dy * b.uy) <= b.hw + (m || 0) && Math.abs(-dx * b.uy + dy * b.ux) <= b.hh + (m || 0);
  };
  // Distance from a point to a segment
  function segDist(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 > 1e-9 ? clamp(((x - ax) * dx + (y - ay) * dy) / l2, 0, 1) : 0;
    return Math.hypot(x - ax - dx * t, y - ay - dy * t);
  }
  // Nearest point on an open line (or a closed ring): { x, y, d, dx, dy (direction there) }
  function nearestOn(line: readonly Pt[], x: number, y: number, closed?: boolean) {
    let best: Nearest | null = null;
    const n = line.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = line[i], b = line[(i + 1) % n];
      const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      const t = l2 > 1e-9 ? clamp(((x - a[0]) * dx + (y - a[1]) * dy) / l2, 0, 1) : 0;
      const px = a[0] + dx * t, py = a[1] + dy * t, d = Math.hypot(x - px, y - py);
      if (!best || d < best.d) { const l = Math.sqrt(l2) || 1; best = { x: px, y: py, d, dx: dx / l, dy: dy / l, i, t }; }
    }
    return best;
  }
  const segsCross = (a: Pt, b: Pt, c: Pt, d: Pt) => { // do segments a-b and c-d cross?
    const o = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
    return ((o1 > 0) !== (o2 > 0)) && ((o3 > 0) !== (o4 > 0));
  };

  // Everything derived from a model once: sorted levels, cleaned polygons per level, heights.
  /** What an area was made from: an area of the model, or a deck of the shell drawn as a plaza. */
  interface AreaSrc extends Partial<StationArea> { kind: StationArea['kind']; level: number }
  /** An area as the viewer uses it: its rings cleaned, on the floor it is drawn with. */
  interface PArea {
    src: AreaSrc; kind: StationArea['kind']; ring: XY[]; holes: XY[][]; box: Box4;
    level: number; li: number; order: number; keys: string[]; top: number; topH: number;
  }
  /** A floor. `pts` is only there while prepare() runs; `box` and `hull` are filled in by it. */
  interface PLevel { id: number; z: number; name: string; i: number; areas: PArea[]; pts?: XY[]; box: Box4 | null; hull: XY[]; ceilH: number }
  interface Prepared {
    model: StationModel; levels: PLevel[]; n: number;
    zOf: (level: number) => number; levelOfZ: (z: number) => number;
    seg: (level: number) => [k: number, t: number];
    idxOf: (level: number) => number; bracket: (level: number) => [lo: number, hi: number]; floorOfZ: (z: number) => number;
    decks: Set<StationShell>; core: Obb; near: (level: number) => number;
    box: Box4; diag: number; zMin: number; zMax: number;
  }
  const prepared = new WeakMap<StationModel, Prepared>();
  const SEG: [k: number, t: number] = [0, 0]; // scratch: which piece of the level table a level falls in, and how far along it
  function prepare(model: StationModel): Prepared {
    if (prepared.has(model)) return prepared.get(model)!;
    const levels = (model.levels || []).filter((l) => isFinite(l.id) && isFinite(l.z)).slice().sort((a, b) => a.id - b.id)
      .map((l, i) => ({ id: l.id, z: l.z, name: l.name || `Level ${l.id}`, i, areas: [], pts: [] } as Partial<PLevel> as PLevel));
    if (!levels.length) levels.push({ id: 0, z: 0, name: 'Ground', i: 0, areas: [], pts: [] } as Partial<PLevel> as PLevel);
    const n = levels.length;
    const zOf = (level: number) => {
      if (n === 1) return levels[0].z + (level - levels[0].id) * 5;
      let k = 0;
      while (k < n - 2 && level > levels[k + 1].id) k++;
      const a = levels[k], b = levels[k + 1];
      return a.z + ((level - a.id) / (b.id - a.id)) * (b.z - a.z);
    };
    // the level at a real height (the inverse of zOf)
    const levelOfZ = (z: number) => {
      if (n === 1) return levels[0].id + (z - levels[0].z) / 5;
      let k = 0;
      while (k < n - 2 && z > levels[k + 1].z) k++;
      const a = levels[k], b = levels[k + 1];
      return Math.abs(b.z - a.z) < 1e-6 ? a.id : a.id + ((z - a.z) / (b.z - a.z)) * (b.id - a.id);
    };
    const seg = (level: number) => {
      if (n === 1) { SEG[0] = 0; SEG[1] = level - levels[0].id; return SEG; }
      let k = 0;
      while (k < n - 2 && level > levels[k + 1].id) k++;
      SEG[0] = k; SEG[1] = (level - levels[k].id) / (levels[k + 1].id - levels[k].id);
      return SEG;
    };
    const idxOf = (level: number) => {
      let best = 0;
      for (let k = 1; k < n; k++) if (Math.abs(levels[k].id - level) < Math.abs(levels[best].id - level)) best = k;
      return best;
    };
    // the floors a point at this (maybe fractional) level lies between
    const bracket = (level: number): [lo: number, hi: number] => {
      let lo = 0, hi = n - 1;
      for (let k = 0; k < n; k++) { if (levels[k].id <= level + .02) lo = k; }
      for (let k = n - 1; k >= 0; k--) { if (levels[k].id >= level - .02) hi = k; }
      return [Math.min(lo, hi), Math.max(lo, hi)];
    };
    // the floor at or below a real height
    const floorOfZ = (z: number) => { let k = 0; for (let i = 0; i < n; i++) if (levels[i].z <= z + .3) k = i; return k; };
    const ORDER = { plaza: 0, floor: 1, platform: 2, room: 3 };
    const wrap = (src: AreaSrc, kind: StationArea['kind'], ring: XY[], holes: XY[][], level: number) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of ring) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      const lv = levels[idxOf(level)];
      const a: PArea = { src, kind, ring, holes, box: [x0, y0, x1, y1], level: lv.id, li: lv.i, order: ORDER[kind] == null ? 1 : ORDER[kind], keys: (src.refs || []).map(pkey).filter(Boolean), top: 0, topH: 0 };
      lv.areas.push(a);
      for (const p of ring) lv.pts!.push(p);
      return a;
    };
    for (const a of model.areas || []) {
      const ring = cleanRing(a.ring, true);
      if (!ring) continue;
      wrap(a, a.kind, ring, (a.holes || []).map((h) => cleanRing(h, false)).filter(Boolean) as XY[][], a.level || 0);
    }
    // A deck in the shell (a bridge, a bus deck) is ground you walk on: draw it as the floor it belongs to
    const decks = new Set<StationShell>();
    for (const sh of model.shell || []) {
      if (sh.kind !== 'deck' || sh.top == null) continue;
      const lv = levels.slice().sort((a, b) => Math.abs(a.z - sh.top) - Math.abs(b.z - sh.top))[0];
      const ring = cleanRing(sh.ring, true);
      if (!ring || Math.abs(lv.z - sh.top) > 2) continue;
      wrap({ kind: 'plaza', name: sh.name || '', level: lv.id }, 'plaza', ring, (sh.holes || []).map((h) => cleanRing(h, false)).filter(Boolean) as XY[][], lv.id);
      decks.add(sh);
    }
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const lv of levels) {
      lv.areas.sort((a, b) => a.order - b.order);
      const h = hull(lv.pts!);
      lv.box = null;
      for (const p of h) {
        if (!lv.box) lv.box = [p[0], p[1], p[0], p[1]];
        lv.box[0] = Math.min(lv.box[0], p[0]); lv.box[1] = Math.min(lv.box[1], p[1]);
        lv.box[2] = Math.max(lv.box[2], p[0]); lv.box[3] = Math.max(lv.box[3], p[1]);
      }
      lv.hull = h;
      if (lv.box) { bx0 = Math.min(bx0, lv.box[0]); by0 = Math.min(by0, lv.box[1]); bx1 = Math.max(bx1, lv.box[2]); by1 = Math.max(by1, lv.box[3]); }
      delete lv.pts;
    }
    if (!isFinite(bx0)) [bx0, by0, bx1, by1] = model.bbox || [-50, -50, 50, 50];
    if (model.bbox && model.bbox.length === 4) { bx0 = Math.min(bx0, model.bbox[0]); by0 = Math.min(by0, model.bbox[1]); bx1 = Math.max(bx1, model.bbox[2]); by1 = Math.max(by1, model.bbox[3]); }
    // The heart of the station, for the opening view without a route: around the train platforms (or all stops)
    const stops = (model.stops || []).filter((s) => s.xy);
    const trains = stops.filter((s) => s.mode === 'train');
    const corePts = (trains.length >= 2 ? trains : stops).map((s) => s.xy);
    let core: Obb;
    if (corePts.length) {
      core = obb(corePts);
      core.hw = clamp(core.hw + 30, 60, 125);
      core.hh = clamp(core.hh + 30, 45, 85);
    } else core = { cx: (bx0 + bx1) / 2, cy: (by0 + by1) / 2, ux: 1, uy: 0, hw: Math.min(125, (bx1 - bx0) / 2), hh: Math.min(85, (by1 - by0) / 2) };
    const zs = levels.map((l) => l.z);
    const P: Prepared = {
      model, levels, n, zOf, levelOfZ, seg, idxOf, bracket, floorOfZ, decks, core,
      near: (level) => levels[idxOf(level)].id,
      box: [bx0, by0, bx1, by1], diag: Math.hypot(bx1 - bx0, by1 - by0), zMin: Math.min(...zs), zMax: Math.max(...zs),
    };
    prepared.set(model, P);
    return P;
  }

  // Which area is at (x, y) on level index li? Platforms and rooms win over the floor they stand on.
  function areaAt(P: Prepared, li: number, x: number, y: number) {
    const lv = P.levels[li];
    let hit: PArea | null = null;
    for (const a of lv.areas) {
      if (x < a.box[0] || x > a.box[2] || y < a.box[1] || y > a.box[3]) continue;
      if (!inRing(a.ring, x, y) || a.holes.some((h) => inRing(h, x, y))) continue;
      if (!hit || a.order >= hit.order) hit = a;
    }
    return hit;
  }
  const inArea = (a: PArea, x: number, y: number) => x >= a.box[0] && x <= a.box[2] && y >= a.box[1] && y <= a.box[3] && inRing(a.ring, x, y) && !a.holes.some((h) => inRing(h, x, y));

  // ---------- colours of the model, per theme ----------
  // The calm look of a 3D city map: warm cream ground, soft beige blocks with lighter tops, a pale sky, and one
  // saturated colour, kept for the route: blue. Everything the scene draws takes its colour from here.
  // level(): the plate of a floor (ground you do not walk on); [colour, amount] pairs are mixed into it.
  type Mix = [colour: string, amount: number];
  interface Theme {
    level: (id: number) => string;
    plateSide: Mix; contact: Mix; glass: Mix; shaft: Mix;
    band: [string, string];
    floor: string; plaza: string; platform: string; platformSide: string; room: string; roomSide: string;
    wall: string; wallBase: string; wallTop: string; ceil: string; lamp: string; lampGlow: string;
    shell: string; shellSide: string; ground: string; green: string; bed: string; rail: string; safety: string;
    stairs: string; riser: string; ramp: string; tread: string; cab: string; door: string; frame: string;
    strip: string; closed: string; line: string;
    route: string; casing: string; chevron: string; dim: string; done: string; glow: string;
    hemiSky: string; hemiGround: string; fogIn: string; fogOut: string; text: string;
    shellAlpha: number; lineOpacity: number; shellLine: number; plateLine: number; hemi: number; sun: number; shadow: number;
  }
  const THEME: Record<'light' | 'dark', Theme> = {
    light: {
      level: (id) => (id <= -2 ? '#D9D3C6' : id < 0 ? '#E3DED2' : id < 1 ? '#EEEAE0' : id < 2 ? '#F1EEE6' : '#F4F1EA'),
      plateSide: ['#8E8676', .5],
      floor: '#FAF7F1', plaza: '#F6F3EC', platform: '#DEDAD1', platformSide: '#C6C1B4', room: '#EFEBE1', roomSide: '#DDD7CA',
      wall: '#D6CFC0', wallBase: '#A9A190', wallTop: '#F3F0E8', ceil: '#DFDACF', lamp: '#FFFFFF', lampGlow: '#F2EEE5', contact: ['#6B6455', .24],
      shell: '#EDEAE3', shellSide: '#D6D1C6', shellAlpha: .3, ground: '#F3EFE7', green: '#CDE6B8',
      bed: '#CBC7BE', rail: '#9A968E', safety: '#FFFFFF',
      stairs: '#F2EFE8', riser: '#D2CCBF', ramp: '#ECE8DE', tread: '#BDB7AA', glass: ['#CFE3F2', .5], shaft: ['#CFE3F2', .4], cab: '#BFC3C9', door: '#D6D9DD', frame: '#8E9299',
      strip: '#F6F3EC', band: ['#FFFFFF', '#E4DFD3'], closed: '#E08A2E',
      line: '#7A7364', lineOpacity: .5, shellLine: .3, plateLine: .75,
      route: '#007AFF', casing: '#0A5FCC', chevron: '#FFFFFF', dim: '#8FC0FA', done: '#A9C7EE', glow: '#5AAEFF',
      hemiSky: '#FFFFFF', hemiGround: '#EAE3D4', hemi: 2.2, sun: 1.15, shadow: .22,
      fogIn: '#EFEBE3', fogOut: '#F4F1EA', text: '#1C1C1E',
    },
    dark: {
      level: (id) => (id <= -2 ? '#2A2C32' : id < 0 ? '#303238' : id < 1 ? '#35373E' : id < 2 ? '#393B42' : '#3D3F46'),
      plateSide: ['#000000', .38],
      floor: '#383A40', plaza: '#34363B', platform: '#4C4E56', platformSide: '#35373C', room: '#3A3C42', roomSide: '#33353A',
      wall: '#474950', wallBase: '#28292D', wallTop: '#61636B', ceil: '#222327', lamp: '#FFF1CC', lampGlow: '#3A3830', contact: ['#000000', .34],
      shell: '#3B3D43', shellSide: '#2F3136', shellAlpha: .3, ground: '#26282C', green: '#22372A',
      bed: '#1F2023', rail: '#6A6C72', safety: '#E9EBEE',
      stairs: '#5A5C63', riser: '#404248', ramp: '#4B4D53', tread: '#7C7F87', glass: ['#2B3A4A', .55], shaft: ['#5C7896', .3], cab: '#8A8F98', door: '#6E737B', frame: '#9AA0A8',
      strip: '#34363B', band: ['#5A5D65', '#3F4147'], closed: '#B5651D',
      line: '#FFFFFF', lineOpacity: .2, shellLine: .16, plateLine: .62,
      route: '#0A84FF', casing: '#0057C2', chevron: '#FFFFFF', dim: '#1F4F8F', done: '#2A4A75', glow: '#3D9BFF',
      hemiSky: '#FFFFFF', hemiGround: '#8A8E99', hemi: 2.3, sun: 1.2, shadow: .4,
      fogIn: '#1E2024', fogOut: '#1B1D22', text: '#FFFFFF',
    },
  };

  // ---------- geometry: everything is merged into a few big buffers ----------
  // A vertex is [x, y, level, yo, ho]: model x/y, the (maybe fractional) level it belongs to, a fixed offset yo in
  // metres above that level and a height ho that is scaled (rooms and buildings are lower in the model view).
  // Heights on screen come from a table with one entry per floor (the "shape"): real heights for the flat plan and
  // the first-person view, evenly spread ones when the floors are peeled apart.
  /** A vertex: model x / y, its level, metres above the level, a height that is scaled with the model. */
  type Vtx = [x: number, y: number, level: number, yo: number, ho?: number];
  type RGBA = [r: number, g: number, b: number, a: number];
  /** The shape of the model: the display height of every floor (see createViewer). */
  interface Shape { P: Prepared | null; tab: number[]; dtab: number[]; Hs: number }
  /** What build() leaves on a geometry, so that stretch() can move its heights. */
  interface GeoData { lk: Uint8Array; lt: Float32Array; yo: Float32Array; ho: Float32Array; normals: boolean }
  interface Geo {
    p: number[]; lf: number[]; ho: number[]; c: number[]; uv: number[];
    tri(a: Vtx, b: Vtx, c: Vtx, col?: RGBA | null): void;
    quad(a: Vtx, b: Vtx, c: Vtx, d: Vtx, col?: RGBA | null): void;
    quadUV(a: Vtx, b: Vtx, c: Vtx, d: Vtx, uv: number[]): void;
    quadGrad(a: Vtx, b: Vtx, c: Vtx, d: Vtx, c0: RGBA, c1: RGBA): void;
    seg(a: Vtx, b: Vtx): void;
    loop(ring: readonly Pt[], lf: number, yo: number, ho?: number): void;
    prism(ring: XY[], holes: XY[][] | null | undefined, lf0: number, y0: number, lf1: number, y1: number, top: RGBA | null, side: RGBA | null, h1?: number, down?: boolean): void;
    ribbon(line: readonly Pt[], half: number, lfs: number | number[], yo: number, col: RGBA, off?: number): void;
    box(cx: number, cy: number, half: number, lf0: number, y0: number, lf1: number, y1: number, col: RGBA, top?: RGBA): XY[];
    block(cx: number, cy: number, dx: number, dy: number, w: number, d: number, lf: number, y0: number, y1: number, col: RGBA, top?: RGBA): XY[];
    count(): number;
    build(SH: Shape, normals?: boolean): THREE.BufferGeometry;
  }
  /** Geo is a constructor function: `new (Geo as GeoCtor)()`. */
  type GeoCtor = { new (): Geo; (this: Geo): void };
  function Geo(this: Geo) { this.p = []; this.lf = []; this.ho = []; this.c = []; this.uv = []; }
  Geo.prototype.tri = function (this: Geo, a: Vtx, b: Vtx, c: Vtx, col?: RGBA | null) {
    this.p.push(a[0], a[3], -a[1], b[0], b[3], -b[1], c[0], c[3], -c[1]);
    this.lf.push(a[2], b[2], c[2]);
    this.ho.push(a[4] || 0, b[4] || 0, c[4] || 0);
    if (col) this.c.push(col[0], col[1], col[2], col[3], col[0], col[1], col[2], col[3], col[0], col[1], col[2], col[3]);
  };
  Geo.prototype.quad = function (this: Geo, a: Vtx, b: Vtx, c: Vtx, d: Vtx, col?: RGBA | null) { this.tri(a, b, c, col); this.tri(a, c, d, col); };
  // a quad with a picture on it: a bottom left, b bottom right, c top right, d top left; uv = [u0, v0, u1, v1]
  Geo.prototype.quadUV = function (this: Geo, a: Vtx, b: Vtx, c: Vtx, d: Vtx, uv: number[]) {
    this.tri(a, b, c); this.tri(a, c, d);
    this.uv.push(uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[1], uv[2], uv[3], uv[0], uv[3]);
  };
  // a quad that fades: a, b in colour c0, c and d in colour c1
  Geo.prototype.quadGrad = function (this: Geo, a: Vtx, b: Vtx, c: Vtx, d: Vtx, c0: RGBA, c1: RGBA) {
    this.tri(a, b, c); this.tri(a, c, d);
    for (const k of [c0, c0, c1, c0, c1, c1]) this.c.push(k[0], k[1], k[2], k[3]);
  };
  Geo.prototype.seg = function (this: Geo, a: Vtx, b: Vtx) { // for LineSegments
    this.p.push(a[0], a[3], -a[1], b[0], b[3], -b[1]);
    this.lf.push(a[2], b[2]);
    this.ho.push(a[4] || 0, b[4] || 0);
  };
  Geo.prototype.loop = function (this: Geo, ring: readonly Pt[], lf: number, yo: number, ho?: number) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      this.seg([a[0], a[1], lf, yo, ho], [b[0], b[1], lf, yo, ho]);
    }
  };
  function triangulate(ring: XY[], holes?: XY[][] | null) {
    const V2 = THREE.Vector2;
    const c = ring.map((p) => new V2(p[0], p[1]));
    const hs = (holes || []).map((h) => h.map((p) => new V2(p[0], p[1])));
    const all = c.concat(...hs);
    let faces: number[][];
    try { faces = THREE.ShapeUtils.triangulateShape(c, hs); } catch (e) { return []; }
    const out: [THREE.Vector2, THREE.Vector2, THREE.Vector2][] = [];
    for (const f of faces) {
      const a = all[f[0]], b = all[f[1]], d = all[f[2]];
      if (!a || !b || !d) continue;
      const cr = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
      if (Math.abs(cr) < 1e-7) continue;
      out.push(cr > 0 ? [a, b, d] : [a, d, b]);
    }
    return out;
  }
  // Extruded polygon: a top cap at (lf1, y1 [, h1]) and walls down to (lf0, y0). No bottom: the camera never goes below.
  // down = true turns the cap to face down (a ceiling).
  Geo.prototype.prism = function (this: Geo, ring: XY[], holes: XY[][] | null | undefined, lf0: number, y0: number, lf1: number, y1: number, top: RGBA | null, side: RGBA | null, h1?: number, down?: boolean) {
    if (top) {
      for (const t of triangulate(ring, holes)) {
        const A: Vtx = [t[0].x, t[0].y, lf1, y1, h1], B: Vtx = [t[1].x, t[1].y, lf1, y1, h1], C: Vtx = [t[2].x, t[2].y, lf1, y1, h1];
        if (down) this.tri(A, C, B, top); else this.tri(A, B, C, top);
      }
    }
    if (!side) return;
    const wall = (r: XY[]) => {
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length];
        this.quad([a[0], a[1], lf0, y0], [b[0], b[1], lf0, y0], [b[0], b[1], lf1, y1, h1], [a[0], a[1], lf1, y1, h1], side);
      }
    };
    wall(ring);
    (holes || []).forEach(wall);
  };
  // Flat band along a line. lfs[i] is the level at point i; off shifts it sideways (to the left of travel).
  Geo.prototype.ribbon = function (this: Geo, line: readonly Pt[], half: number, lfs: number | number[], yo: number, col: RGBA, off?: number) {
    const n = line.length;
    if (n < 2) return;
    const L: XY[] = [], R: XY[] = [];
    for (let i = 0; i < n; i++) {
      const p = line[i], a = line[Math.max(0, i - 1)], b = line[Math.min(n - 1, i + 1)];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      dx /= l; dy /= l;
      L.push([p[0] - dy * ((off || 0) + half), p[1] + dx * ((off || 0) + half)]);
      R.push([p[0] - dy * ((off || 0) - half), p[1] + dx * ((off || 0) - half)]);
    }
    const lf = (i: number) => (typeof lfs === 'number' ? lfs : lfs[i]);
    for (let i = 0; i < n - 1; i++) {
      this.quad([R[i][0], R[i][1], lf(i), yo], [R[i + 1][0], R[i + 1][1], lf(i + 1), yo], [L[i + 1][0], L[i + 1][1], lf(i + 1), yo], [L[i][0], L[i][1], lf(i), yo], col);
    }
  };
  Geo.prototype.box = function (this: Geo, cx: number, cy: number, half: number, lf0: number, y0: number, lf1: number, y1: number, col: RGBA, top?: RGBA) {
    const r: XY[] = [[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half]];
    this.prism(r, null, lf0, y0, lf1, y1, top || col, col);
    return r;
  };
  // an upright box of any footprint: centre, direction along its width, width, depth, from y0 to y1 above the level
  Geo.prototype.block = function (this: Geo, cx: number, cy: number, dx: number, dy: number, w: number, d: number, lf: number, y0: number, y1: number, col: RGBA, top?: RGBA) {
    const px = -dy, py = dx, hw = w / 2, hd = d / 2;
    const r: XY[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => [cx + dx * hw * s + px * hd * t, cy + dy * hw * s + py * hd * t]);
    this.prism(r, null, lf, y0, lf, y1, top || col, col);
    for (const t of triangulate(r, null)) this.tri([t[0].x, t[0].y, lf, y0], [t[2].x, t[2].y, lf, y0], [t[1].x, t[1].y, lf, y0], col); // underside
    return r;
  };
  Geo.prototype.count = function (this: Geo) { return this.lf.length; };
  // → BufferGeometry whose heights can be re-shaped later: y = table(level) + yo + ho × Hs
  Geo.prototype.build = function (this: Geo, SH: Shape, normals?: boolean) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(this.p);
    const n = this.lf.length;
    const lk = new Uint8Array(n), lt = new Float32Array(n), ho = new Float32Array(this.ho), yo = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = SH.P!.seg(this.lf[i]);
      lk[i] = s[0]; lt[i] = s[1];
      yo[i] = pos[i * 3 + 1];
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (this.c.length) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.c), 4));
    if (this.uv.length) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.userData = { lk, lt, yo, ho, normals: !!normals };
    stretch(g, SH, true);
    return g;
  };
  function stretch(g: THREE.BufferGeometry, SH: Shape, finish?: boolean) {
    const { lk, lt, yo, ho, normals } = g.userData as GeoData;
    const pos = g.attributes.position;
    const a = pos.array, tab = SH.tab, dtab = SH.dtab, Hs = SH.Hs;
    for (let i = 0; i < lk.length; i++) a[i * 3 + 1] = tab[lk[i]] + lt[i] * dtab[lk[i]] + yo[i] + ho[i] * Hs;
    pos.needsUpdate = true;
    if (finish) {
      if (normals) g.computeVertexNormals();
      g.computeBoundingSphere();
    }
  }

  // One staircase / escalator / ramp, following its line. Levels on the line may be fractional.
  // Each kind reads as what it is: stairs have treads and handrails, an escalator has glass sides, steps and arrows
  // the way it runs, a ramp shows its slope. glow = the one the route takes: a soft sleeve along its sides.
  type ConnCols = Record<'stairs' | 'riser' | 'ramp' | 'tread' | 'glass' | 'shaft' | 'cab' | 'door' | 'frame' | 'arrow', RGBA>;
  function addConnector(g: Geo, ln: Geo, P: Prepared, c: StationSlopeConnector, col: ConnCols, glow?: boolean) {
    const w = clamp((c.width || 2.2), 1.2, 9) / 2;
    const line = c.line;
    for (let i = 0; i < line.length - 1; i++) {
      let p = line[i], q = line[i + 1];
      if (q[2] < p[2]) [p, q] = [q, p]; // always build upwards
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len < 0.05) continue;
      const dx = (q[0] - p[0]) / len, dy = (q[1] - p[1]) / len;
      const at = (u: number, s: number, lf: number, yo: number): Vtx => [p[0] + dx * u * len - dy * s * w, p[1] + dy * u * len + dx * s * w, lf, yo];
      const lp = p[2], lq = q[2];
      const rise = P.zOf(lq) - P.zOf(lp); // metres, to tell real stairs from a flat piece
      const lAt = (u: number) => lp + (lq - lp) * u;
      ln.seg(at(0, -1, lp, .05), at(1, -1, lq, .05));
      ln.seg(at(0, 1, lp, .05), at(1, 1, lq, .05));
      const rails = () => { // a handrail on posts along both sides
        const n = Math.max(1, Math.round(len / 2.4));
        for (const s of [-1, 1]) {
          ln.seg(at(0, s, lp, .95), at(1, s, lq, .95));
          for (let k = 0; k <= n; k++) ln.seg(at(k / n, s, lAt(k / n), 0), at(k / n, s, lAt(k / n), .95));
        }
      };
      if (c.kind === 'stairs' && rise > 0.2) {
        const n = clamp(Math.round(len / 0.8), 4, 18);
        for (let k = 0; k < n; k++) {
          const u0 = k / n, u1 = (k + 1) / n, lt = lAt(u1), lb = lAt(u0);
          g.quad(at(u0, -1, lt, 0), at(u1, -1, lt, 0), at(u1, 1, lt, 0), at(u0, 1, lt, 0), col.stairs); // tread
          g.quad(at(u0, 1, lb, 0), at(u0, -1, lb, 0), at(u0, -1, lt, 0), at(u0, 1, lt, 0), col.riser); // riser
          for (const s of [-1, 1]) g.quad(at(u0, s, lb, -.45), at(u1, s, lt, -.45), at(u1, s, lt, 0), at(u0, s, lt, 0), col.riser); // cheek
          ln.seg(at(u0, -1, lt, .02), at(u0, 1, lt, .02)); // the edge of each step
        }
        rails();
      } else {
        const esc = c.kind === 'escalator';
        const top = esc ? col.tread : c.kind === 'stairs' ? col.stairs : col.ramp;
        g.quad(at(0, -1, lp, 0), at(1, -1, lq, 0), at(1, 1, lq, 0), at(0, 1, lp, 0), top);
        for (const s of [-1, 1]) g.quad(at(0, s, lp, -.4), at(1, s, lq, -.4), at(1, s, lq, 0), at(0, s, lp, 0), esc ? col.riser : top);
        if (esc) {
          for (const s of [-1, 1]) {
            g.quad(at(0, s, lp, 0), at(1, s, lq, 0), at(1, s, lq, 1.05), at(0, s, lp, 1.05), col.glass); // balustrade
            ln.seg(at(0, s, lp, 1.05), at(1, s, lq, 1.05)); // handrail
          }
          const n = clamp(Math.round(len / 1.2), 3, 14); // steps, as lines across
          for (let k = 1; k < n; k++) ln.seg(at(k / n, -1, lAt(k / n), .03), at(k / n, 1, lAt(k / n), .03));
          if (c.oneway === 'up' || c.oneway === 'down') { // arrows the way it runs
            const m = clamp(Math.round(len / 2.2), 2, 8);
            for (let k = 0; k < m; k++) {
              const a = (k + .25) / m, b = (k + .7) / m, tip = c.oneway === 'up' ? b : a, tail = c.oneway === 'up' ? a : b;
              g.tri(at(tail, -.55, lAt(tail), .06), at(tail, .55, lAt(tail), .06), at(tip, 0, lAt(tip), .06), col.arrow);
            }
          }
        } else if (c.kind === 'ramp') {
          const n = clamp(Math.round(len / 1.8), 2, 30); // lines across, so the slope shows
          for (let k = 1; k < n; k++) ln.seg(at(k / n, -1, lAt(k / n), .03), at(k / n, 1, lAt(k / n), .03));
          rails();
        }
      }
      if (glow) for (const s of [-1, 1]) g.quad(at(0, s, lp, 0), at(1, s, lq, 0), at(1, s, lq, 1.15), at(0, s, lp, 1.15), col.glass);
    }
  }
  // A lift: a glass shaft with the car inside, and on every floor a door in a frame on the side people come from.
  function addLift(g: Geo, ln: Geo, P: Prepared, c: StationElevator, col: ConnCols, faces?: Map<number, XY> | null) {
    const ls = c.levels.slice().sort((a, b) => a - b), x = c.xy[0], y = c.xy[1];
    for (const l of ls) {
      g.box(x, y, 1.0, l, 0, l, 2.3, col.cab);
      const f = (faces && faces.get(l)) || [0, -1], tx = -f[1], ty = f[0];
      const at = (a: number, d: number, yo: number): Vtx => [x + f[0] * (1.32 + d) + tx * a, y + f[1] * (1.32 + d) + ty * a, l, yo];
      g.quad(at(-1.0, 0, 0), at(1.0, 0, 0), at(1.0, 0, 2.5), at(-1.0, 0, 2.5), col.frame);
      g.quad(at(-.72, .02, 0), at(.72, .02, 0), at(.72, .02, 2.15), at(-.72, .02, 2.15), col.door);
      ln.seg(at(0, .04, 0), at(0, .04, 2.15));
      ln.seg(at(-.72, .04, 0), at(-.72, .04, 2.15)); ln.seg(at(.72, .04, 0), at(.72, .04, 2.15)); ln.seg(at(-.72, .04, 2.15), at(.72, .04, 2.15));
    }
    const r = g.box(x, y, 1.3, ls[0], 0, ls[ls.length - 1], 3.1, col.shaft);
    for (const p of r) ln.seg([p[0], p[1], ls[0], 0], [p[0], p[1], ls[ls.length - 1], 3.1]);
    ln.loop(r, ls[ls.length - 1], 3.1);
  }

  // The walking route as a tube along its points. Its width is set on screen by the shader, so only the
  // centre line, the direction around it and the distance along are stored.
  /** A point of the drawn line. o: the index of the route point it is (or -1); g: metres it is lifted onto a detail scene's ground. */
  interface SmoothPt { x: number; y: number; l: number; o: number; g?: number }
  function smoothPath(points: XYL[]) {
    const out: SmoothPt[] = [];
    const n = points.length;
    for (let i = 0; i < n; i++) {
      const c = points[i];
      const a = points[i - 1], b = points[i + 1];
      const flat = a && b && Math.abs(a[2] - c[2]) < 1e-6 && Math.abs(b[2] - c[2]) < 1e-6;
      const la = flat ? Math.hypot(a[0] - c[0], a[1] - c[1]) : 0, lb = flat ? Math.hypot(b[0] - c[0], b[1] - c[1]) : 0;
      if (!flat || la < .4 || lb < .4) { out.push({ x: c[0], y: c[1], l: c[2], o: i }); continue; }
      const cut = Math.min(2.2, la * .45, lb * .45);
      const A = [c[0] + (a[0] - c[0]) / la * cut, c[1] + (a[1] - c[1]) / la * cut];
      const B = [c[0] + (b[0] - c[0]) / lb * cut, c[1] + (b[1] - c[1]) / lb * cut];
      for (let k = 0; k <= 4; k++) {
        const t = k / 4, u = 1 - t;
        out.push({ x: u * u * A[0] + 2 * u * t * c[0] + t * t * B[0], y: u * u * A[1] + 2 * u * t * c[1] + t * t * B[1], l: c[2], o: k === 2 ? i : -1 });
      }
    }
    return out;
  }

  const ROUTE_VERT = `
    attribute vec3 aRad;
    attribute vec3 aTan;
    attribute float aD;
    uniform float uPx, uRmin, uScale, uA0, uA1, uThin, uSquash, uNear, uEye;
    varying float vDepth;
    varying float vD;
    varying float vR;
    varying float vFace;
    void main() {
      vec3 c = position;
      float depth = -(modelViewMatrix * vec4(c, 1.0)).z;
      // standing on it, the line starts as a point at your feet and reaches its width a few steps ahead
      float feet = mix(0.2, 1.0, smoothstep(0.3, 6.5, abs(aD - uEye)));
      float base = max(uRmin * mix(uNear, 1.0, smoothstep(1.5, 7.0, depth)) * feet, uPx * depth);
      float act = step(uA0 - 0.05, aD) * step(aD, uA1 + 0.05);
      float r = base * mix(uThin, 1.0, act);
      c.y += base * 0.9 * uSquash + (1.0 - uSquash) * 0.06;
      vDepth = depth;
      vec3 toCam = cameraPosition - c;
      vec3 side = toCam - aTan * dot(toCam, aTan);
      vFace = dot(aRad, normalize(side + vec3(0.0, 1e-4, 0.0)));
      vD = aD;
      vR = r;
      vec3 off = aRad * r * uScale;
      off.y *= uSquash;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(c + off, 1.0);
    }`;
  const ROUTE_FRAG = `
    uniform vec3 uCol, uInk, uDim, uDone;
    uniform float uA0, uA1, uProg, uGrow, uSpacing, uPhase, uAlpha, uFlat, uFogN, uFogF;
    varying float vDepth;
    varying float vD;
    varying float vR;
    varying float vFace;
    void main() {
      if (vD > uGrow) discard;
      vec3 col = uCol;
      if (uFlat < 0.5) {
        float act = step(uA0 - 0.05, vD) * step(vD, uA1 + 0.05);
        col = mix(uDim, uCol, act);
        if (vD < uProg - 0.01) col = uDone;
        float face = clamp(vFace, -1.0, 1.0);
        float across = sqrt(max(0.0, 1.0 - face * face));
        float f = fract(vD / uSpacing - uPhase) * uSpacing / vR;
        float q = f + across * 1.25;
        float aa = min(0.14, fwidth(q) * 1.2 + 0.02);
        float chev = smoothstep(2.0 - aa, 2.0 + aa, q) * (1.0 - smoothstep(3.1 - aa, 3.1 + aa, q)) * (1.0 - smoothstep(0.72, 0.8, across)) * step(0.0, face);
        col = mix(col, uInk, chev * mix(0.2, 0.5, act));
        col *= 0.93 + 0.07 * face;
      }
      gl_FragColor = vec4(col, uAlpha * (1.0 - 0.92 * smoothstep(uFogN, uFogF, vDepth)));
      #include <colorspace_fragment>
    }`;
  // Something that is closed: stripes across it, in model metres so they do not swim when the camera moves
  const HATCH_VERT = `
    varying vec3 vW;
    #include <clipping_planes_pars_vertex>
    void main() {
      vec4 w = modelMatrix * vec4(position, 1.0);
      vW = w.xyz;
      vec4 mvPosition = viewMatrix * w;
      gl_Position = projectionMatrix * mvPosition;
      #include <clipping_planes_vertex>
    }`;
  const HATCH_FRAG = `
    uniform vec3 uCol;
    uniform float uAlpha, uStep;
    varying vec3 vW;
    #include <clipping_planes_pars_fragment>
    void main() {
      #include <clipping_planes_fragment>
      float s = fract((vW.x + vW.z) / uStep);
      float aa = fwidth((vW.x + vW.z) / uStep) * 1.5;
      float band = smoothstep(0.5 - aa, 0.5 + aa, s) * (1.0 - smoothstep(1.0 - aa, 1.0, s)) + (1.0 - smoothstep(0.0, aa, s));
      gl_FragColor = vec4(uCol, uAlpha * mix(0.22, 1.0, clamp(band, 0.0, 1.0)));
      #include <colorspace_fragment>
    }`;

  // ---------- events for the page that embeds the viewer ----------
  type Listener<K extends keyof Station3DEventMap> = (detail: Station3DEventMap[K]) => void;
  // every list holds listeners of its own event: emit() hands them that event's detail
  const listeners: Record<string, Listener<never>[] | undefined> = {};
  function emit<K extends keyof Station3DEventMap>(name: K, detail?: Station3DEventMap[K]) {
    (listeners[name] || []).slice().forEach((fn) => { try { fn(detail as never); } catch (e) { console.error(e); } });
  }

  // The router's types (src/types/station-route.d.ts), under the short names this file uses
  type Router = StationRouteApi;
  type Route = StationRouteResult;
  type RouteStep = StationRouteStep;
  type RouteEnd = Station3DEndpoint;
  type RoutePrefs = StationRoutePrefs;
  type EndStop = StationRouteStopRef;
  /** Anything that can be closed for a while: an area, a connector, a stop, an entrance, an edge. */
  type Closable = { closed?: StationClosure | boolean | null; note?: string } | null | undefined;
  /** A plane that is taken out of a detail scene's ground: metres above the floor at (x, y) = c + a x + b y. */
  interface Tilt { a: number; b: number; c: number }
  /** The detail scene of a station: its manifest entry, its data, the renderer's handle, and how it is shown. */
  interface DetailState {
    entry: DetailEntry | null; data: StationDetailModel | null; h: Station3DDetailHandle | null;
    /** All scenes of the station (one is loaded at a time); the one the route runs through, and the route that was worked out for. */
    list: DetailEntry[]; byRoute: DetailEntry | null; byRouteOf: Route | null | undefined;
    /** The handle whose 'detail' event was sent. */
    told: Station3DDetailHandle | null;
    loading: boolean; show: boolean; bird: boolean; li: number; y0: number; add: number; k: number;
    shellBox: Box4 | null; tilt: Tilt | null;
    /** The destination marked on the scene's own ground / only a destination is shown, and it lies in the scene. */
    marks: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[]; spot: boolean;
  }
  /** A lift the walk rides: from point i to point j of the route, t = 0..1 of dur milliseconds. */
  interface LiftRide { i: number; j: number; t: number; dur: number }
  /** Something worth a look on the way: where it is, how high, how strongly it pulls the head. */
  interface Sight { x: number; y: number; h: number; w: number }
  /** The walk that plays by itself. */
  interface PlayState {
    on: boolean; speed: number; v: number; gaze: number; gazeP: number; ride: LiftRide | null; slide: number;
    by: Station3DArrivedBy; arrived: boolean; lastProg: number; lastAlong: number;
    pois: Sight[] | null; poisOf: StationDetailModel | null;
  }
  /** Something of the scene that is given back when the scene is cleared. */
  interface Tracked { geometry?: THREE.BufferGeometry; material?: THREE.Material & { map?: THREE.Texture | null }; parent?: THREE.Object3D | null }
  /** The events on() listens for. */
  type Ev = HTMLElementEventMap & DocumentEventMap & WindowEventMap & { webglcontextlost: Event; webglcontextrestored: Event };
  type StateKind = 'loading' | Station3DErrorCode;
  /** What the public API holds of the open viewer. */
  interface Viewer {
    alive: boolean; ready: boolean; opts: Station3DOpenOptions;
    boot(instant?: boolean): void;
    destroy(instant?: boolean): void;
    setUser(u: Station3DUser | null): void;
    select(i: number): void;
    setFollow(b: boolean): void;
    enableCompass(): Promise<Station3DCompass>;
    setPov(b: boolean): void;
    play(o?: Station3DPlayOptions | null): boolean;
    pause(): void;
    isPlaying(): boolean;
    setPeel(v: number): void;
    orient(e: Station3DOrientation): void;
    depth(): number;
    back(): boolean;
    detail(): Station3DDetailHandle | null;
    redraw(): void;
    debug(): Record<string, unknown>;
  }
  /** A wall segment, or a walking edge, on one floor. */
  type Seg4 = [ax: number, ay: number, bx: number, by: number];
  /** What the route uses of the model. */
  interface Analysis {
    routed: boolean; same: boolean; levels: Set<number>; shown: number[]; conn: Set<StationConnector>; areas: Set<PArea>;
    /** The plate: one box around the whole route. */
    box: Obb | null;
    /** Per piece of the route: the connector it runs on, and whether it has no floor under it. */
    segConn: (StationConnector | null)[]; float: boolean[];
  }
  /** What to call an end of the route, and what is known about it. */
  interface EndInfo {
    kind: 'free' | 'stop' | 'named' | 'entrance' | 'label'; name: string; ref: string; noun: string; sector: string;
    dist: number; far: boolean; closed: boolean; note: string;
    stop?: StationStop; mode?: string; reach?: string; assumed?: string;
  }
  /** A point on a platform edge. weak: only guessed from a stop point. */
  interface EdgePt { x: number; y: number; d: number; weak?: boolean }
  type PartKind = 'level' | 'plate' | 'conn' | 'shell' | 'foot' | 'strip';
  type PartMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  type PartLines = THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  /** One mesh with its outlines, faded as a whole. cut: not drawn, a detail scene stands in its place. */
  interface Part { mesh: PartMesh; lines: PartLines; op: number; target: number; lineBase: number; gain: number; ghost: boolean; kind: PartKind; cut?: boolean }
  interface PlatePart extends Part { kind: 'plate'; li: number }
  interface LevelPart extends Part {
    kind: 'level'; li: number; has: boolean; plate: PlatePart | null;
    ceil: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null; walls: PartMesh | null;
  }
  interface ConnPart extends Part { kind: 'conn'; lo: number; hi: number; touched: boolean }
  interface ShellPart extends Part { kind: 'shell'; shell: 'solid' | 'roof' | 'glass' }
  interface PartOpts { side?: THREE.Side; noclip?: boolean; ghost?: boolean; grid?: boolean; line?: number }
  /** Something that only exists when you stand in the model. */
  type PovThing = THREE.Mesh<THREE.BufferGeometry, THREE.Material> | THREE.LineSegments<THREE.BufferGeometry, THREE.Material>;
  // ---------- one open viewer ----------
  /** Something of the model that was tapped, or an end of the route as a place in the model. */
  interface Hit { li: number; level: number; xy: XY; area: PArea | null; stop?: StationStop | null; entrance?: StationEntrance }
  /** No route, but one place to show. why: the reason there is no route to it. */
  interface Focus { which: 'to' | 'from'; end: RouteEnd; hit: Hit | null; why: StationRouteWhy | 'no-router' | null }
  /** "Where to ride": the router's sector times for the start platform, and the sector the route starts in. */
  interface Ride { times: StationRouteSectorTimes; pick: string; chosen?: boolean }
  /** What the route takes next, shown as an object: a level change, or a doorway ('portal'). */
  interface GuideInfo { kind: StationRouteStepKind | 'portal'; step: number; entry: XYL; along0: number; along1: number; icon: string; title: string; sub: string }
  interface Guide extends GuideInfo {
    mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>; lines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>; lift: number;
  }
  /** A highlighted area or edge. uniform: its opacity is a uniform of its shader. */
  type Highlight = { li: number; base: number } & ({ mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>; uniform?: false } | { mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>; uniform: true });
  type SignStyle = 'plat' | 'closed' | 'sides' | 'exit' | 'shop' | 'sector' | 'meet' | 'clock' | 'ticket' | 'stop';
  /** A sign in the first-person view: what is on its front and its back, where it hangs and which way it faces. */
  interface Sign {
    style: SignStyle; text: string; back?: string; x: number; y: number; lf: number; yc: number; dx: number; dy: number; h: number;
    maxW?: number; thick?: number; one?: boolean; key?: string; keyBack?: string;
  }
  interface SignCell { x: number; y: number; w: number; style: SignStyle; text: string }
  /** Station furniture: boxes and poles, drawn as two instanced meshes. */
  interface InstBox { x: number; y: number; lf: number; yo: number; sx: number; sy: number; sz: number; dx: number; dy: number; col: THREE.Color }
  interface InstCyl { x: number; y: number; lf: number; yo: number; r: number; h: number; col: THREE.Color }
  type InstMesh = THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  interface Inst { boxes: InstBox[]; cyls: InstCyl[]; box: InstMesh | null; cyl: InstMesh | null }
  type RouteUniforms = Record<'uPx' | 'uRmin' | 'uA0' | 'uA1' | 'uThin' | 'uProg' | 'uGrow' | 'uSpacing' | 'uPhase' | 'uSquash' | 'uNear' | 'uEye' | 'uFogN' | 'uFogF', { value: number }>
    & Record<'uInk' | 'uDim' | 'uDone', { value: THREE.Color }>;
  /** The drawn route: one tube geometry, its three meshes, the uniforms they share. D / Dorig: the display distance at
      each point of the line / of route.points; A: metres along the route at each of route.points. */
  interface RouteDraw {
    geo: THREE.BufferGeometry; meshes: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[]; U: RouteUniforms;
    sm: SmoothPt[]; D: Float32Array; Dorig: Float32Array; total: number; K: number; A: number[];
    /** Metres along the route (as A counts them) at each point of the line: the eye walks the line itself. */
    AS: Float32Array;
    /** Where the route changes floor: metres along it, from and to. */
    steep: [number, number][];
    /** Where on the line the eye stands (eyeD), and what that was worked out for. */
    eyeKey?: number; eyeD?: number;
  }
  /** Where the camera looks from: the angle around, the distance, and the point it looks at (tx, level tl, tz). */
  interface Pose { az: number; dist: number; tx: number; tz: number; tl: number }
  /** A point in the scene (three.js axes: y up, z = -model y). */
  type P3 = [x: number, y: number, z: number];
  /** A sloping piece of the route: its direction on the ground and its length. */
  type Incline = [dx: number, dy: number, len: number];
  /** A piece of the route for framing: its points, its slopes, the way it runs. */
  interface Section { pts: P3[]; inclines: Incline[]; dir: XY | null }
  /** What bestPose() weighs: az fixes the angle; otherwise the weights say what counts. */
  interface PoseOpts {
    az?: number | null; pad: number; inclines?: Incline[]; dir?: XY | null; near?: number | null; axis?: number | null;
    wFit?: number; wSide?: number; wFront?: number; wCont?: number; wAcross?: number;
  }
  /** Something that runs from one value to another over a time (performance.now() milliseconds). */
  interface Anim { from: number; to: number; t0: number; dur: number }
  /** The first-person view: where the eye is, which way the path goes there (bearing), the head (yaw, pitch), how far
      along the route it stands. device: the phone's compass and tilt turn the head (dB, dP; orient = what it reports). */
  interface PovState {
    x: number; y: number; level: number; tx: number; ty: number; tl: number; bearing: number; tb: number; slope: number;
    yaw: number; pitch: number; along: number; walk: Anim | null; free: boolean; device: boolean; dB: number; dP: number;
    orient: { b: number; p: number } | null;
    /** wb: which way the path goes (tb = that, turned towards the arrival view); bv: how fast the bearing turns (rad/s);
        arr: 0..1 how far the arrival view has taken over. */
    wb: number; bv: number; arr: number;
    /** The eye's height above the plain floor in a detail scene, eased (lift, liftV = its speed), and what it was
        eased from: a jump of the eye or a scene that appears is taken at once. */
    lift: number; liftV: number; lx: number; ly: number; ll: number; liftShow: boolean;
    /** Called once the phone first reports which way it points. */
    waiting?: (() => void) | null;
  }
  /** The live position. sx, sy, sl, salong: the smoothed place that is drawn (null: not drawn yet). outside: too far
      from the model to be shown (then `far` says how far). x, y, level: where it is, on the route when mode is
      'route' or 'manual' (then along / pi say where on it). */
  interface UserState {
    sx: number | null; sy: number | null; sl: number | null; salong: number | null;
    snap: StationRouteSnap | null; acc: number; heading: number | null;
    outside?: boolean; far?: number; mode?: 'approx' | 'route' | 'manual';
    x?: number; y?: number; level?: number; along?: number | null; pi?: number | null;
  }
  /** "I'm here": the step the user says they are at. */
  interface ManualAt { step: number; pi: number; along: number; point: number[] }
  /** Safari asks before it reports the orientation. */
  type DeviceOrientationCtor = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> };
  type LabelKind = 'level' | 'isl' | 'stop' | 'sector' | 'ent' | 'poi' | 'shut' | 'start' | 'sign' | 'end' | 'via' | 'beacon' | 'tip' | 'user';
  /** A label pinned to the model: its element, where it is pinned (x, y, level, lift; ax / ay = the point of the
      element that sits there), how it competes for room (prio, block, yield, alts) and what kind needs beyond that.
      x, y and level are unset on the beacon and the user dot, which are placed another way, and on the tip until
      something is picked. */
  interface Label {
    el: HTMLElement; kind: LabelKind; ax: number; ay: number; prio: number; li: number; lift: number;
    shown: boolean; w: number; h: number; block: boolean; yield: boolean;
    x: number; y: number; level: number;
    /** Shown whatever the zoom and the floor / not shown until switched on / never placed off screen. */
    always?: boolean; on?: boolean; keepIn?: boolean;
    /** Not shown when a metre is fewer pixels than this. */
    minPpm?: number;
    /** Other offsets (pixels) to try when its place is taken. */
    alts?: number[][];
    /** Kept on screen, with an arrow to its place when that is out of view / hung below its point when there is no room above. */
    pin?: boolean; pinned?: boolean; flip?: boolean; below?: boolean;
    /** A floor name: where it may sit (corners of the plate, points of the floor's outline), and where that is on screen now. */
    plate?: XY[] | null; rim?: XY[]; want?: boolean; cands?: XY[];
    /** A platform island: its area, where the edges of its two numbers are, its size lying and upright, how it lies now. */
    area?: PArea; ends?: [XY, XY] | null; own?: boolean; wc?: number; hc?: number; wr?: number; hr?: number; col?: boolean; rev?: boolean;
    stop?: StationStop;
    /** A level change of the route: its step. */
    step?: number;
    /** The beacon: what it shows now. */
    key?: string;
  }
  type LabelInit = { kind: LabelKind } & Partial<Omit<Label, 'el' | 'kind'>>;
  /** What the pointers on the canvas are doing: one finger turns (and peels) or pans, two pinch. */
  type Gesture =
    | { mode: 'pan' | 'orbit'; moved: number; t0: number; lt: number; vx: number; vy: number; drift: number; peeled: boolean | null | undefined }
    | { mode: 'pinch'; moved: number; drift: number; span: number; cx: number; cy: number; peeled?: undefined };
  /** What is said about a place that was tapped. */
  interface Described { title: string; sub: string; icon: string; closed: boolean; note: string }
  /** An end chosen while exploring: the place, and what to call it. */
  interface ExploreEnd { end: RouteEnd; name: string }
  /** How a step is selected: where the selection came from, and what must not move because of it. */
  interface SelectOpts { fromScroll?: boolean; fromPov?: boolean; instant?: boolean; keepCam?: boolean; follow?: boolean; auto?: boolean }
  /** An <input type="range"> whose numbers are written as numbers (the browser turns them into strings). */
  type RangeInput = Omit<HTMLInputElement, 'min' | 'max' | 'step' | 'value'> & Record<'min' | 'max' | 'step' | 'value', string | number>;
  function createViewer(opts: Station3DOpenOptions): Viewer {
    const self = { alive: true, ready: false, opts } as Viewer;
    let model: StationModel, P: Prepared, router: Router | null, route: Route | null = null, T: Theme;
    let fromEnd: RouteEnd | null = opts.from || null, toEnd: RouteEnd | null = opts.to || null;
    let routeFromExplore = false;
    let A = { routed: false, same: false, levels: new Set(), shown: [], conn: new Set(), areas: new Set(), box: null, segConn: [] } as Partial<Analysis> as Analysis; // what the route uses
    let focus: Focus | null = null;    // no route, but one place to show: { which: 'to' | 'from', end, hit, why }
    let ride: Ride | null = null;     // "where to ride": the router's sector times for the start platform
    const day = opts.date || (opts.prefs && opts.prefs.date) || undefined; // the day closures are judged for (default: today)
    let root: HTMLElement, topEl: HTMLElement, titleEl: HTMLElement, subEl: HTMLElement, stage: HTMLElement, canvas: HTMLCanvasElement, labelsEl: HTMLElement, levelsEl: HTMLElement, toolsEl: HTMLElement, followBtn: HTMLButtonElement, fitBtn: HTMLButtonElement, northBtn: HTMLButtonElement, chipEl: HTMLElement, sheetEl: HTMLElement, stepsEl: HTMLOListElement | null | undefined, navEl: HTMLDivElement | null | undefined, stateEl: HTMLElement, toastEl: HTMLElement, liveEl: HTMLElement, creditEl: HTMLElement, peelEl: HTMLDivElement | undefined;
    let renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight, raycaster: THREE.Raycaster, ndc: THREE.Vector2, v3: THREE.Vector3, clip: THREE.Plane[] = [];
    let W = 1, H = 1;
    let theme: 'light' | 'dark' = isDark() ? 'dark' : 'light';
    // the shape of the model: display height of every floor (SH.tab), from how far the floors are peeled apart
    const SH: Shape = { P: null, tab: [0], dtab: [5], Hs: HS_MODEL };
    let Yreal = [0], Yspread = [0], tabTo = [0], peel = 0, peelTo = 0, peelAnim: Anim | null = null, peelHome = 1;
    let pov = false, lost = false;
    const cam: Pose = { az: -.6, dist: 300, tx: 0, tz: 0, tl: 0 }; // looks at (tx, level tl, tz); the angle from above follows the peel
    let tween: { from: Pose; to: Pose; daz: number; t0: number; dur: number } | null = null, maxDist = 2000;
    const spin = { az: 0, x: 0, z: 0 };
    let free = { x0: 0, y0: 0, x1: 1, y1: 1, w: 1, h: 1, cx: .5, cy: .5 };
    let parts: Part[] = [];      // everything that fades as a whole: { mesh, lines, op, target, lineBase, gain }
    let lv3: LevelPart[] = [];        // per level: its part, with .plate, .ceil, .walls
    let conns: ConnPart[] = [];      // connector groups: { mesh, lines, lo, hi, op, touched }
    let shellParts: ShellPart[] = []; // the town and the roofs: { ..., kind: 'solid' | 'roof' | 'glass' }
    let foot: Part | null = null;     // outlines of the buildings on the plates (with a route)
    let strip: Part | null = null;    // a walkway drawn under route sections that have no floor in the model
    let povOnly: PovThing[] = [];    // things that only exist when you stand in the model: ground, signs, furniture
    let R: RouteDraw | null = null;        // the route: { geo, meshes, U, D, Dorig, total, sm, steps }
    let hl: Highlight[] = [];         // highlighted areas and edges: { mesh, li, base }
    let liftFaces = new Map<StationElevator, Map<number, XY>>(); // lift → floor → the side its door is on
    const gridU = { value: 0 }; // how strongly the floor tiles show (only when you stand on them)
    let guides: Guide[] = [], activeGuide: Guide | null = null, povArriving = false, beacon: Label | null = null; // what the route takes next, shown as an object
    // the detail scene of this station, if it has one: { entry (manifest), data, h (the renderer's handle), show, bird }
    const DT: DetailState = { entry: null, list: [], byRoute: null, byRouteOf: undefined, told: null, data: null, h: null, loading: false, show: false, bird: false, li: 0, y0: 0, add: 0, k: 0, shellBox: null, tilt: null, marks: [], spot: false };
    let clipHole: THREE.Plane[] = [], clipShell: THREE.Plane[] = []; // the plain model is cut out where the scene stands
    // the walk that plays by itself: { on, speed (multiplier of WALK_MS), v (m/s now), gaze / gazeP (the head turned
    // towards something worth seeing), ride (in a lift), by (what moved the walk last), arrived (said once per open) }
    const PL: PlayState = { on: false, speed: PLAY_SPEED, v: 0, gaze: 0, gazeP: 0, ride: null, slide: 0, by: 'step', arrived: false, lastProg: 0, lastAlong: -1, pois: null, poisOf: null };
    let playBtn: HTMLButtonElement | null = null, scrubRow: HTMLDivElement | null = null;
    let los: Seg4[][] = [];        // per level: wall segments [ax, ay, bx, by] that hide labels behind them (first-person view)
    let disc: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> | null = null;     // the accuracy disc of the user
    let labels: Label[] = [], labelsDirty = false, levelLabels: Label[] = [], tip: Label | null = null, tipTimer = 0;
    let sel = -1, isolate: number | null = null, listMode = false;
    let follow = false, user: UserState | null = null, userStep = -1, manualAt: ManualAt | null = null, compassOn = false, compassHeading: number | null = null, compassAsk: Promise<Station3DCompass> | null = null;
    let picked: Hit | null = null, exploreEnds: Record<'from' | 'to', ExploreEnd | null> = { from: null, to: null };
    let raf = 0, slowTimer = 0, lastT = 0, lastActivity = 0, shadowDirty = true, grow: { t0: number; dur: number } | null = null, phase = 0;
    let ro: ResizeObserver | null = null, mo: MutationObserver | null = null, toastTimer = 0, scrollTimer = 0, progScroll = 0, openTimer = 0, orientTimer = 0;
    // first-person view: where the eye is (x, y, level), which way the path goes (bearing), the head (yaw, pitch)
    let povT = 0, povAnim: Anim | null = null, camB: THREE.PerspectiveCamera = null!, fog: THREE.Fog = null!, hudEl: HTMLElement = null!, miniEl: HTMLCanvasElement = null!, scrubEl: RangeInput | null = null, hudKey = '', indoorT = 0;
    const pv: PovState = { x: 0, y: 0, level: 0, tx: 0, ty: 0, tl: 0, bearing: 0, tb: 0, slope: 0, yaw: 0, pitch: 0, along: 0, walk: null, free: false, device: false, dB: 0, dP: 0, orient: null, wb: 0, bv: 0, arr: 0, lift: 0, liftV: 0, lx: NaN, ly: NaN, ll: NaN, liftShow: false };
    // open options: 'demo' chrome (only the picture, the card and the signs), and where to look on arrival
    const demo = opts.chrome === 'demo';
    const arriveLook: XY | null = opts.arrive && Array.isArray(opts.arrive.look) && isFinite(+opts.arrive.look[0]) && isFinite(+opts.arrive.look[1]) ? [+opts.arrive.look[0], +opts.arrive.look[1]] : null;
    const ARRIVE_M = 5; // metres before the end over which the head turns to the arrival view
    // how long frames take in the first-person view; a phone that cannot keep up draws fewer pixels (never more again)
    const PR_STEPS = [2, 1.5, 1.25, 1];
    const FT = { cap: 2, avg: 16.7, slow: 0, ring: new Float32Array(120), n: 0, last: 0, sim: false, drops: 0, chain: false };
    const pixelRatio = () => Math.min(window.devicePixelRatio || 1, FT.cap);
    const disposables: Tracked[] = [];
    const offs: (() => void)[] = [];
    const on = <K extends keyof Ev>(el: EventTarget, type: K, fn: (e: Ev[K]) => void, o?: boolean | AddEventListenerOptions) => { el.addEventListener(type, fn as EventListener, o); offs.push(() => el.removeEventListener(type, fn as EventListener, o)); };

    const isClosed = (thing: Closable) => {
      if (!thing || thing.closed == null || thing.closed === false) return false;
      if (router && router.isClosed) { try { return !!router.isClosed(thing, day); } catch (e) { return false; } }
      return thing.closed === true;
    };
    const closedNote = (thing: Closable) => (thing && ((thing.closed && (thing.closed as StationClosure).note) || thing.note)) || '';

    // ----- DOM -----
    function buildDom() {
      root = mk('section', 's3');
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-labelledby', 's3Title');
      root.innerHTML = `
        <header class="s3-top s3-glass">
          <div class="s3-title"><b id="s3Title"></b><span></span></div>
          <button class="s3-close" type="button" aria-label="Close station view">${svg('close', '0 0 14 14').replace('<svg', '<svg fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"')}</button>
        </header>
        <div class="s3-stage"><div class="s3-labels"></div></div>
        <nav class="s3-levels s3-glass" aria-label="Floors and view" hidden></nav>
        <div class="s3-tools">
          <button class="s3-fab s3-follow" type="button" aria-label="Follow my position" aria-pressed="false" hidden>${svg('follow')}</button>
          <button class="s3-fab s3-fit" type="button" aria-label="Fit to screen" hidden>${svg('fit')}</button>
        </div>
        <button class="s3-north" type="button" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path class="s3-n" d="M12 2.6l4.1 9.4H7.9z"/><path class="s3-s" d="M12 21.4L7.9 12h8.2z"/></svg><b>N</b></button>
        <div class="s3-chip" role="status" hidden></div>
        <div class="s3-callout" hidden><span class="s3-callout-ico"></span><div><b></b><span></span></div></div>
        <canvas class="s3-mini" width="208" height="208" hidden aria-hidden="true"></canvas>
        <div class="s3-credit"></div>
        <section class="s3-sheet s3-glass" aria-label="Directions" hidden></section>
        <div class="s3-toast" role="status"></div>
        <div class="s3-state" hidden></div>
        <div class="s3-sr" aria-live="polite"></div>`;
      const q = <E extends HTMLElement = HTMLElement>(s: string) => root.querySelector<E>(s)!;
      topEl = q('.s3-top'); titleEl = q('.s3-title b'); subEl = q('.s3-title span');
      stage = q('.s3-stage'); labelsEl = q('.s3-labels'); levelsEl = q('.s3-levels'); toolsEl = q('.s3-tools');
      followBtn = q('.s3-follow'); fitBtn = q('.s3-fit'); northBtn = q('.s3-north'); chipEl = q('.s3-chip');
      sheetEl = q('.s3-sheet'); stateEl = q('.s3-state');
      toastEl = q('.s3-toast'); liveEl = q('.s3-sr'); creditEl = q('.s3-credit');
      hudEl = q('.s3-callout'); miniEl = q('.s3-mini');
      titleEl.textContent = opts.title || 'Station';
      on(q('.s3-close'), 'click', () => api.close());
      on(fitBtn, 'click', () => { setFollow(false); moved = false; if (Math.abs(peelTo - peelHome) > .02) setPeel(peelHome, { dur: 700 }); flyTo(currentPose(), 800); });
      on(followBtn, 'click', () => { setFollow(!(follow || wantFollow)); if (follow || wantFollow) enableCompass(); });
      on(northBtn, 'click', () => { moved = true; flyTo(Object.assign({}, cam, { az: 0 }), 600); say('North is up'); });
      on(root, 'keydown', onKey);
      // the round buttons slide when the sheet changes height: labels keep clear of where they end up
      on(toolsEl, 'transitionend', () => { if (self.ready) { layout(); request(); } });
      root.classList.toggle('s3-dark', theme === 'dark');
      root.classList.toggle('s3--demo', demo);
      (opts.mount || document.body).appendChild(root);
    }

    function showState(kind: StateKind | null) {
      const M = {
        loading: ['', 'Loading the station…'],
        nowebgl: ['3D isn’t available here', 'This browser or device can’t draw 3D graphics. The walking route is still on the map.'],
        model: ['The station plan didn’t load', 'Check your connection, then try again.'],
        three: ['The 3D view didn’t load', 'Check your connection, then try again.'],
        css: ['The 3D view didn’t load', 'Check your connection, then try again.'],
        broken: ['This station can’t be shown', 'Something in its plan is not as the 3D view expects. The walking route is still on the map.'],
        lost: ['The 3D view is paused', 'Your device took back its graphics memory. The view returns by itself; if it doesn’t, close it and open it again.'],
      }[kind!];
      stateEl.hidden = !M;
      root.classList.toggle('s3-stateon', !!M && kind !== 'loading');
      if (!M) return;
      stateEl.innerHTML = '';
      if (kind === 'loading') {
        const f = mk('div', 's3-floors');
        f.setAttribute('aria-hidden', 'true');
        f.append(mk('i'), mk('i'), mk('i'));
        stateEl.append(f);
      }
      const p = mk('p');
      if (M[0]) p.append(mk('b', null, M[0]));
      p.append(M[1]);
      p.setAttribute('role', kind === 'loading' ? 'status' : 'alert');
      stateEl.append(p);
      if (kind === 'model' || kind === 'three' || kind === 'css') {
        const b = mk('button', null, 'Try again');
        b.type = 'button';
        b.onclick = () => { const o = self.opts; api.reopen(o); };
        stateEl.append(b);
      } else if (kind === 'broken' || kind === 'nowebgl') {
        const b = mk('button', null, 'Close');
        b.type = 'button';
        b.onclick = () => api.close();
        stateEl.append(b);
      }
      if (kind !== 'loading') emit('error', { code: kind!, message: M[1] });
    }
    function toast(text: string, ms?: number) {
      toastEl.textContent = text;
      toastEl.classList.add('s3-show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('s3-show'), ms || 3200);
    }
    const say = (text: string | null) => { liveEl.textContent = text; };

    // ----- WebGL -----
    function initGL() {
      canvas = document.createElement('canvas');
      canvas.tabIndex = 0;
      canvas.setAttribute('role', 'application');
      canvas.setAttribute('aria-label', '3D model of the station. Drag sideways to turn it, drag up or down to peel the floors apart, pinch or scroll to zoom; the arrow keys do the same. The walking steps are listed below.');
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
      renderer.setPixelRatio(pixelRatio());
      renderer.setClearColor(0x000000, 0);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.shadowMap.autoUpdate = false;
      renderer.localClippingEnabled = true;
      stage.insertBefore(canvas, labelsEl);
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(FOV, 1, 1, 6000);
      hemi = new THREE.HemisphereLight(0xffffff, 0xcccccc, 2);
      sun = new THREE.DirectionalLight(0xffffff, 1);
      sun.castShadow = true;
      scene.add(hemi, sun, sun.target);
      camB = new THREE.PerspectiveCamera(POV_FOV, 1, .2, 600);
      fog = new THREE.Fog(0xffffff, 1e6, 1e7);
      scene.fog = fog;
      raycaster = new THREE.Raycaster();
      ndc = new THREE.Vector2();
      v3 = new THREE.Vector3();
      // the four sides of the plate box: with a route only the part of each floor inside it is drawn
      clip = [0, 1, 2, 3].map(() => new THREE.Plane(new THREE.Vector3(1, 0, 0), 1e7));
      clipHole = [0, 1, 2, 3].map(() => new THREE.Plane(new THREE.Vector3(1, 0, 0), 1e7));
      clipShell = [0, 1, 2, 3].map(() => new THREE.Plane(new THREE.Vector3(1, 0, 0), 1e7));
      // The device can take the graphics memory away (a tab in the background, memory pressure). Ask for it back
      // and draw everything again when it returns.
      on(canvas, 'webglcontextlost', (e) => {
        e.preventDefault();
        lost = true;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        showState('lost');
      });
      on(canvas, 'webglcontextrestored', () => {
        if (!self.alive) return;
        lost = false;
        try { if (self.ready) rebuild({ keep: true }); } catch (e) { console.error('Station3D:', e); }
        showState(null);
        shadowDirty = true;
        request();
      });
    }
    function setClip(b: Obb | null) {
      if (!b) { for (const p of clip) { p.normal.set(1, 0, 0); p.constant = 1e7; } return; }
      const cu = b.cx * b.ux + b.cy * b.uy, cv = -b.cx * b.uy + b.cy * b.ux;
      // model (x, y) is three (x, -z): a direction (dx, dy) is the vector (dx, 0, -dy)
      clip[0].normal.set(-b.ux, 0, b.uy); clip[0].constant = cu + b.hw;
      clip[1].normal.set(b.ux, 0, -b.uy); clip[1].constant = b.hw - cu;
      clip[2].normal.set(b.uy, 0, b.ux); clip[2].constant = cv + b.hh;
      clip[3].normal.set(-b.uy, 0, -b.ux); clip[3].constant = b.hh - cv;
    }

    // ----- the detail scene -----
    const detailQuality = () => (opts.quality === 'low' || opts.quality === 'high' ? opts.quality
      : (navigator.deviceMemory && navigator.deviceMemory <= 3) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) ? 'low' : 'high');
    // is a walk, or the eye, near the scene?
    // A walk that goes through the scene (or along its edge) on the street, a destination in it, or an eye that
    // comes near on that floor. A route that passes at a distance, or underneath, does not pull the scene in.
    const streetLevel = () => P.levels[P.idxOf(P.levelOfZ(0))].id;
    // count: how much of the walk lies there (places 6 m apart), not just whether any of it does
    function routeInDetail(b: Box4, count?: boolean): number | boolean {
      const pts = route!.points, l0 = streetLevel();
      let c = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[i + 1] || p;
        const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 6));
        for (let k = 0; k < n; k++) {
          const t = k / n;
          if (Math.abs(lerp(p[2], q[2], t) - l0) < .5 && inBB(b, lerp(p[0], q[0], t), lerp(p[1], q[1], t), 12)) { if (!count) return true; c++; }
        }
      }
      return count ? c : false;
    }
    // A station with several scenes: the one the walk runs through (the one that holds most of it), else the one a
    // lone destination lies in, else the one the eye is near. One scene is loaded at a time.
    function pickDetail(): DetailEntry | null {
      const L = DT.list;
      if (L.length < 2) return L[0] || null;
      if (A.routed && route) {
        if (DT.byRouteOf !== route) {
          DT.byRouteOf = route; DT.byRoute = null;
          let best = 0;
          for (const e of L) { const c = routeInDetail(e.bbox, true) as number; if (c > best) { best = c; DT.byRoute = e; } }
        }
        if (DT.byRoute) return DT.byRoute;
      } else if (focus && focus.hit && focus.hit.xy) {
        for (const e of L) if (inBB(e.bbox, focus.hit.xy[0], focus.hit.xy[1], 10)) return e;
      }
      if (DT.entry && eyeNearDetail(DT.entry.bbox)) return DT.entry;
      for (const e of L) if (eyeNearDetail(e.bbox)) return e;
      return DT.entry && L.includes(DT.entry) ? DT.entry : L[0];
    }
    function chooseDetail() {
      const e = pickDetail();
      if (e === DT.entry) return;
      dropDetail();
      DT.entry = e; DT.data = null;
    }
    const eyeNearDetail = (b: Box4) => (pov || povT > .02) && pv.level > streetLevel() - .5 && pv.level < streetLevel() + 1.3 && inBB(b, pv.x, pv.y, 90); // not from a floor below the street
    function detailWanted() {
      const b = DT.entry && DT.entry.bbox;
      if (!b) return false;
      if (A.routed && routeInDetail(b)) return true;
      if (!A.routed && focus && focus.hit && focus.hit.xy && inBB(b, focus.hit.xy[0], focus.hit.xy[1], 10)) return true; // only a destination, and it lies there
      return eyeNearDetail(b);
    }
    function ensureDetail() {
      if (!DT.entry || DT.loading || !self.alive || !self.ready) return;
      if (DT.list.length > 1) { chooseDetail(); if (!DT.entry) return; }
      if (!detailWanted()) { if (DT.h) dropDetail(); return; } // left behind: its geometry is given back
      if (DT.h) return;
      if (DT.data) { buildDetail(); return; }
      DT.loading = true;
      const entry = DT.entry;
      loadDetail(entry).then((d) => {
        DT.loading = false;
        if (!self.alive) return;
        if (DT.entry !== entry) { request(); return; } // another scene was chosen meanwhile
        if (!d) { // no such scene (yet): the plain model shows; another scene of the station may still serve
          DT.list = DT.list.filter((e) => e !== entry);
          DT.byRouteOf = undefined;
          DT.entry = null; DT.entry = pickDetail();
          request();
          return;
        }
        DT.data = d;
        if (detailWanted()) buildDetail();
      });
    }
    function buildDetail() {
      const RD = window.Station3DDetail, d = DT.data;
      if (!RD || !d || DT.h || !self.ready || lost) return;
      DT.li = P.idxOf(P.levelOfZ(0)); // the scene's heights are metres above the model's level 0
      DT.y0 = Yc(P.levels[DT.li].id) - P.levels[DT.li].z;
      // flatten: the renderer takes the slope of the street out itself, so its ground lies on the model's level floor
      // (then no offset is wanted). featherColor / featherInside: its rim takes on the colour of the plain ground next
      // to it, so no seam shows from inside. A renderer that knows neither ignores them.
      const o: Station3DDetailOptions = { theme, quality: detailQuality(), flatten: true, zShift: 0, feather: 6, featherColor: T.ground, featherInside: 4, toScene: (x, y, z) => [x, DT.y0 + z, -y] };
      if (opts.season === 'summer' || opts.season === 'winter') o.season = opts.season;
      try {
        DT.h = RD.build(THREE, d, o);
        if (DT.h && DT.h.flattened !== true) { // it cannot: its data's own offset, and our fit of the slope (below)
          try { DT.h.dispose(); } catch (e) {}
          DT.h = RD.build(THREE, d, Object.assign({}, o, { flatten: false, zShift: true }));
        }
      } catch (e) { console.error('Station3D: the detail scene could not be drawn', e); DT.entry = null; DT.h = null; return; }
      // a renderer that does not move the scene by the offset its data asks for: we do it
      DT.add = typeof DT.h.zShift === 'number' ? 0 : (isFinite(d.zOffset!) ? +d.zOffset! : 0);
      DT.tilt = DT.h.flattened === true ? null : fitTilt(d, typeof DT.h.zShift === 'number' ? DT.h.zShift : DT.add);
      DT.h.group.visible = false;
      DT.h.group.renderOrder = 20;
      scene.add(DT.h.group);
      // where the plain model gives way: its ground and furniture inside the scene's area, its houses wherever the scene has its own
      const b = DT.entry!.bbox, s = [b[0], b[1], b[2], b[3]];
      for (const B of d.buildings || []) {
        const pos = (B.mesh && B.mesh.positions) || [];
        for (let i = 0; i + 1 < pos.length; i += 3) { s[0] = Math.min(s[0], pos[i]); s[1] = Math.min(s[1], pos[i + 1]); s[2] = Math.max(s[2], pos[i]); s[3] = Math.max(s[3], pos[i + 1]); }
        for (const p of B.ring || []) { s[0] = Math.min(s[0], p[0]); s[1] = Math.min(s[1], p[1]); s[2] = Math.max(s[2], p[0]); s[3] = Math.max(s[3], p[1]); }
      }
      DT.shellBox = [s[0] - 1.5, s[1] - 1.5, s[2] + 1.5, s[3] + 1.5];
      DT.show = false; DT.bird = false; DT.spot = false;
      buildSceneMarks();
      dropRoute(); buildRoute(); // the line now follows the real ground
      setTargets();
      syncDetail();
      request();
    }
    // The real ground falls across a scene (Hirschengraben: two metres from north to south) while the floor of the
    // plain model is level, so no single offset joins both at every edge. The plane that fits the scene's ground best
    // is taken out of it (a shear: what stands upright stays upright); what is left is kerbs, ledges and bumps.
    // → { a, b, c }: that plane, metres above the model's floor at (x, y) = c + a x + b y.
    function fitTilt(d: StationDetailModel | null, shift: number): Tilt {
      const S: number[][] = [], flat = { a: 0, b: 0, c: 0 };
      for (const sf of (d && d.surfaces) || []) {
        if (!Array.isArray(sf.ring) || !Array.isArray(sf.zs)) continue; // a flat surface (a plinth) says nothing about the street
        for (let i = 0; i < sf.ring.length && i < sf.zs.length; i++) { const p = sf.ring[i], z = sf.zs[i]; if (p && isFinite(p[0]) && isFinite(p[1]) && isFinite(z)) S.push([p[0], p[1], z + shift]); }
      }
      if (S.length < 12) return flat;
      let t = flat, use = S;
      for (let it = 0; it < 4 && use.length >= 12; it++) {
        const m = use.length;
        let mx = 0, my = 0, mz = 0, xx = 0, xy = 0, yy = 0, xz = 0, yz = 0;
        for (const q of use) { mx += q[0]; my += q[1]; mz += q[2]; }
        mx /= m; my /= m; mz /= m;
        for (const q of use) { const dx = q[0] - mx, dy = q[1] - my, dz = q[2] - mz; xx += dx * dx; xy += dx * dy; yy += dy * dy; xz += dx * dz; yz += dy * dz; }
        const det = xx * yy - xy * xy;
        if (!(Math.abs(det) > 1e-6)) return flat;
        const a = (xz * yy - yz * xy) / det, b = (yz * xx - xz * xy) / det;
        t = { a, b, c: mz - a * mx - b * my };
        use = S.filter((q) => Math.abs(q[2] - (t.c + t.a * q[0] + t.b * q[1])) < .6); // a stray point does not tip the street
      }
      return isFinite(t.a + t.b + t.c) && Math.hypot(t.a, t.b) < .12 ? t : flat; // steeper than any street: leave it alone
    }
    const tiltAt = (x: number, y: number) => (DT.tilt ? DT.tilt.c + DT.tilt.a * x + DT.tilt.b * y : 0);
    // the scene on the level it belongs to (the floors move when they are pulled apart), with the tilt taken out
    function placeDetail() {
      const g = DT.h && DT.h.group;
      if (!g) return;
      const lv = P.levels[DT.li], t = DT.tilt || { a: 0, b: 0, c: 0 };
      g.matrixAutoUpdate = false; // scene X = x, Z = -y
      g.matrix.set(1, 0, 0, 0, -t.a, 1, t.b, (Yc(lv.id) - lv.z) - DT.y0 + DT.add - t.c, 0, 0, 1, 0, 0, 0, 0, 1);
      g.matrixWorldNeedsUpdate = true;
    }
    // The destination inside a detail scene: its blue wash lies on the plain model, which is cut away there. The
    // scene's own kerb along that platform gets a blue band instead (a blue ring on the ground where it has none).
    function dropSceneMarks() {
      for (const m of DT.marks) {
        scene.remove(m);
        m.geometry.dispose(); m.material.dispose();
        const i = disposables.indexOf(m);
        if (i >= 0) disposables.splice(i, 1);
      }
      DT.marks = [];
    }
    function buildSceneMarks() {
      dropSceneMarks();
      const d = DT.data!, b = DT.entry!.bbox;
      let area: PArea | null = null, at: Pt | null = null;
      if (A.routed && !A.same) { if (!endInfo(toEnd, 'to').closed) { area = endArea('to'); at = route!.points[route!.points.length - 1]; } }
      else if (!A.routed && focus && focus.hit) { area = focus.hit.area; at = focus.hit.xy; }
      if (!at || !inBB(b, at[0], at[1], 0)) return;
      if (area && (area.li !== DT.li || area.kind !== 'platform' || isClosed(area.src))) area = null;
      const lf = P.levels[DT.li].id, g = new (Geo as GeoCtor)(), W: RGBA = [1, 1, 1, 1];
      const top = (x: number, y: number) => { const z = groundOf(x, y); return (z == null || z < -.8 ? 0 : z) + .045; };
      let made = 0;
      if (area) {
        let cx = 0, cy = 0;
        for (const p of area.ring) { cx += p[0]; cy += p[1]; }
        cx /= area.ring.length; cy /= area.ring.length;
        for (const e of d.edges || []) {
          if (!e || e.kind !== 'kerb' || !Array.isArray(e.line)) continue;
          for (let i = 0; i + 1 < e.line.length; i++) {
            const p = e.line[i], q = e.line[i + 1], mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2, len = Math.hypot(q[0] - p[0], q[1] - p[1]);
            if (len < .2 || !inBB(b, mx, my, -1) || nearestOn(area.ring, mx, my, true)!.d > 2.2) continue;
            let nx = -(q[1] - p[1]) / len, ny = (q[0] - p[0]) / len; // across the kerb, towards the platform
            if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; }
            const k = Math.max(1, Math.ceil(len / .8)), o0 = -.06, o1 = .46;
            const hAt = (v: number[]) => Math.max(top(v[0] + nx * .12, v[1] + ny * .12), top(v[0] + nx * o1, v[1] + ny * o1));
            for (let j = 0; j < k; j++) {
              const a = [lerp(p[0], q[0], j / k), lerp(p[1], q[1], j / k)], c = [lerp(p[0], q[0], (j + 1) / k), lerp(p[1], q[1], (j + 1) / k)];
              const ya = hAt(a), yc = hAt(c);
              g.quad([a[0] + nx * o0, a[1] + ny * o0, lf, ya], [c[0] + nx * o0, c[1] + ny * o0, lf, yc], [c[0] + nx * o1, c[1] + ny * o1, lf, yc], [a[0] + nx * o1, a[1] + ny * o1, lf, ya], W);
              made++;
            }
          }
        }
      }
      if (!made) { // no kerb there: a ring on the ground where the walk ends
        const y = top(at[0], at[1]), N = 40;
        for (let i = 0; i < N; i++) {
          const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2, ri = 1.05, ro = 1.4;
          g.quad([at[0] + Math.cos(a0) * ri, at[1] + Math.sin(a0) * ri, lf, y], [at[0] + Math.cos(a0) * ro, at[1] + Math.sin(a0) * ro, lf, y], [at[0] + Math.cos(a1) * ro, at[1] + Math.sin(a1) * ro, lf, y], [at[0] + Math.cos(a1) * ri, at[1] + Math.sin(a1) * ri, lf, y], W);
        }
      }
      const mesh = flatMesh(g, markMat(T.route, .92, { side: THREE.DoubleSide }), DT.li, 4);
      mesh.renderOrder = 40; // after the scene's own ground and its shadows
      mesh.visible = DT.show;
      mesh.userData.kerb = made;
      DT.marks = [mesh];
    }
    function dropDetail() {
      if (!DT.h) return;
      dropSceneMarks();
      if (DT.show) { DT.show = false; try { applyHole(false, false); } catch (e) {} }
      try { DT.h.dispose(); } catch (e) {}
      if (DT.h.group && DT.h.group.parent) DT.h.group.parent.remove(DT.h.group);
      DT.h = null; DT.bird = false; DT.told = null;
      if (R) routeFrames();
    }
    const groundOf = (x: number, y: number) => { const h = DT.h; if (!h) return null; const g = h.groundAt ? h.groundAt(x, y) : window.Station3DDetail && window.Station3DDetail.groundAt ? window.Station3DDetail.groundAt(h, x, y) : null; return g == null || !isFinite(g) ? null : g + DT.add - tiltAt(x, y); };
    // How far the scene's ground lies above the plain model's floor at (x, y), for the line and the eye. Inside the
    // hole that is cut into the plain model: the real ground. Around it a ramp of a few metres, so nothing jumps: where
    // the scene is higher the ramp lies outside (inside, it would dive under the scene's ground), where it is lower
    // the ramp lies inside (outside, the plain floor would cover it).
    const HOLE_IN = 1, HOLE_RAMP = 5;
    function liftRaw(x: number, y: number, level: number) {
      if (!DT.h || Math.abs(level - P.levels[DT.li].id) > .45) return 0;
      const b = DT.entry!.bbox, x0 = b[0] + HOLE_IN, y0 = b[1] + HOLE_IN, x1 = b[2] - HOLE_IN, y1 = b[3] - HOLE_IN;
      const cx = clamp(x, x0, x1), cy = clamp(y, y0, y1), d = Math.hypot(x - cx, y - cy); // d: how far outside the hole
      if (d >= HOLE_RAMP) return 0;
      const g = groundOf(cx, cy);
      if (g == null) return 0;
      const up = g - (P.zOf(level) - P.levels[DT.li].z);
      // an older renderer answers with its base plane, far below, where the data has no surface (under a house): no
      // ground to stand on. One that knows the street's plane (h.plane) never does: there the scene's ground counts,
      // also where the plain model climbs a ramp above it.
      if (up < -.8 && !DT.h.plane) return 0;
      let t: number;
      if (up >= 0) t = 1 - d / HOLE_RAMP;
      else if (d > 0) return 0;
      else t = clamp(Math.min(x - x0, x1 - x, y - y0, y1 - y) / HOLE_RAMP, 0, 1);
      return up * t * t * (3 - 2 * t);
    }
    const detailLift = (x: number, y: number, level: number) => (DT.show ? liftRaw(x, y, level) : 0);
    // a box cut out of whatever uses these four planes (material.clipIntersection = true): only what is inside all is dropped
    function setHole(planes: THREE.Plane[], b: Box4 | null) {
      if (!b) { for (const p of planes) { p.normal.set(1, 0, 0); p.constant = 1e7; } return; }
      planes[0].normal.set(1, 0, 0); planes[0].constant = -b[2];
      planes[1].normal.set(-1, 0, 0); planes[1].constant = b[0];
      planes[2].normal.set(0, 0, -1); planes[2].constant = -b[3];
      planes[3].normal.set(0, 0, 1); planes[3].constant = b[1];
    }
    // on: the scene is drawn. From the eye: the plain model is cut out where the scene stands. From above (bird): the
    // scene is what the plate carries, cut to the plate's box.
    function applyHole(on: boolean, bird: boolean) {
      const hole = on && !bird;
      const set = (mat: THREE.Material | null | undefined, planes: THREE.Plane[] | null, inter?: boolean) => { if (!mat) return; mat.clippingPlanes = planes; mat.clipIntersection = !!inter; mat.needsUpdate = true; };
      const b = DT.entry && DT.entry.bbox;
      setHole(clipHole, hole && b ? [b[0] + HOLE_IN, b[1] + HOLE_IN, b[2] - HOLE_IN, b[3] - HOLE_IN] : null);
      setHole(clipShell, hole ? DT.shellBox : null);
      const l = lv3[DT.li];
      if (l) {
        for (const m of [l.mesh, l.lines]) set(m.material, hole ? clipHole : clip, hole);
        l.cut = on && bird;
      }
      for (const hh of hl) if (hh.li === DT.li) set(hh.mesh.material, hole ? clipHole : clip, hole);
      for (const o of povOnly) if (o.material && !o.userData.ground) set(o.material, hole ? clipHole : null, hole);
      if (strip) for (const m of [strip.mesh, strip.lines]) set(m.material, hole ? clipHole : null, hole);
      for (const s of shellParts) for (const m of [s.mesh, s.lines]) set(m.material, hole ? clipShell : null, hole);
      if (DT.h) DT.h.group.traverse((o) => { if ((o as THREE.Mesh).material) for (const m of ([] as THREE.Material[]).concat((o as THREE.Mesh).material)) { m.clippingPlanes = on && bird ? clip : null; m.clipIntersection = false; m.needsUpdate = true; } });
      applyOpacity();
      shadowDirty = true;
    }
    // every frame: is the scene to be drawn, and how?
    function syncDetail() {
      const h = DT.h;
      if (!h) return;
      const b = DT.entry!.bbox, lv = P.levels[DT.li];
      const above = !pov && povT < .02;
      const bird = above && isolate == null && A.routed && A.shown.length === 1 && A.shown[0] === DT.li && route!.points.every((p) => inBB(b, p[0], p[1], 3));
      const eye = eyeNearDetail(b);
      // only a destination, and it lies in the scene: the whole station from above, the scene in its place
      const fx = !A.routed && focus && focus.hit && focus.hit.xy;
      const spot = !!fx && (above || eye) && (isolate == null || isolate === DT.li) && inBB(b, fx[0], fx[1], 0) && Math.abs((focus!.hit!.level || 0) - lv.id) < .45;
      const show = bird || eye || spot;
      DT.spot = spot && !eye;
      if (show !== DT.show || (show && bird !== DT.bird)) {
        DT.show = show; DT.bird = show && bird;
        h.group.visible = show;
        for (const m of DT.marks) m.visible = show;
        applyHole(show, DT.bird);
        routeFrames();
        request();
        if (show && DT.told !== h) { DT.told = h; emit('detail', { id: DT.entry!.id }); }
      }
      if (show) placeDetail();
    }
    function dropRoute() {
      if (!R) return;
      for (const m of R.meshes) { scene.remove(m); m.material.dispose(); const i = disposables.indexOf(m); if (i >= 0) disposables.splice(i, 1); }
      R.geo.dispose();
      R = null;
    }

    const track = <O extends Tracked>(o: O): O => { disposables.push(o); return o; };
    function clearScene() {
      dropDetail();
      for (const o of disposables) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
        if (o.parent) o.parent.remove(o as THREE.Object3D);
      }
      disposables.length = 0;
      lv3 = []; conns = []; parts = []; shellParts = []; foot = null; strip = null; povOnly = []; R = null; hl = []; disc = null; los = [];
      guides = []; activeGuide = null; liftFaces = new Map();
    }

    // ----- what the route is, and what of the model it uses -----
    const samePlace = (r: Route | null) => !!r && (!!r.same || !r.points || r.points.length < 2 || r.points.every((p) => Math.hypot(p[0] - r.points[0][0], p[1] - r.points[0][1]) < .05 && Math.abs(p[2] - r.points[0][2]) < .01));
    function normaliseRoute(r: Route | null): Route | null {
      if (!r || !r.points || !r.points.length) return null;
      if (r.points.length < 2) { // an older router: one point for "you are already there"
        r = Object.assign({}, r, { points: [r.points[0], r.points[0].slice()], same: true });
        r.steps = (r.steps || []).map((s) => Object.assign({}, s, { from: 0, to: 1 }));
        r.dists = [0, 0];
      }
      return r;
    }
    // Which connector (stairs, ramp, escalator, lift) does a level-changing piece of the route run on?
    function connectorOf(p: XYL, q: XYL): StationConnector | null {
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const lo = Math.min(p[2], q[2]) - .05, hi = Math.max(p[2], q[2]) + .05;
      for (const c of model.connectors || []) {
        if (c.kind === 'elevator') {
          if (c.xy && len < 1 && Math.hypot(c.xy[0] - p[0], c.xy[1] - p[1]) < 3) return c;
          continue;
        }
        const ln = c.line || [];
        const near = (pt: XYL) => ln.some((v) => Math.hypot(v[0] - pt[0], v[1] - pt[1]) < 2.5 && v[2] >= lo && v[2] <= hi);
        if (near(p) && near(q)) return c;
      }
      return null;
    }
    function analyse() {
      const a: Analysis = { routed: false, same: false, levels: new Set(), shown: [], conn: new Set(), areas: new Set(), box: null, segConn: [], float: [] };
      A = a;
      const rp = route && route.points;
      if (!rp || rp.length < 2) {
        // without a route every floor that has something on it is shown
        P.levels.forEach((lv) => { if (lv.areas.length) a.levels.add(lv.i); });
        if (!a.levels.size) a.levels.add(0);
        a.shown = [...a.levels].sort((x, y) => x - y);
        return;
      }
      a.routed = true;
      a.same = samePlace(route);
      const mark = (x: number, y: number, li: number) => { const ar = areaAt(P, li, x, y); if (ar && ar.kind === 'platform') a.areas.add(ar); return ar; };
      for (let i = 0; i < rp.length; i++) {
        const p = rp[i], q = rp[i + 1];
        const br = P.bracket(p[2]);
        a.levels.add(br[0]); a.levels.add(br[1]);
        const onFloor = br[0] === br[1];
        if (onFloor) mark(p[0], p[1], br[0]);
        if (!q) break;
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (Math.abs(q[2] - p[2]) < 1e-3) {
          let ground = onFloor && !!areaAt(P, br[0], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
          if (onFloor) for (let d = 2; d < len; d += 2) mark(lerp(p[0], q[0], d / len), lerp(p[1], q[1], d / len), br[0]);
          a.segConn.push(null);
          a.float.push(!ground && !a.same);
          continue;
        }
        const c = connectorOf(p, q);
        if (c) a.conn.add(c);
        a.segConn.push(c);
        a.float.push(!c);
      }
      a.shown = [...a.levels].sort((x, y) => x - y);
      // the plate: one box around the whole route, the same on every floor it uses
      const b = obb(rp.map((p) => [p[0], p[1]]));
      if (b.hw < 1) { // one spot: along the platform it is on
        const ar = areaAt(P, P.idxOf(rp[0][2]), rp[0][0], rp[0][1]);
        const ax = ar ? obb(ar.ring) : null;
        if (ax) { b.ux = ax.ux; b.uy = ax.uy; }
      }
      b.hw = Math.max(b.hw + 22, 58);
      b.hh = Math.max(b.hh + 22, 38);
      a.box = b;
    }

    function findStop(q: EndStop) { // by stop id and platform key; never just "some stop of this station"
      const all = model.stops || [], k = pkey(q.ref);
      if (!k) return null;
      const own = all.filter((s) => String(s.uic) === String(q.uic));
      return (own.length ? own : all).find((s) => pkey(s.ref) === k) || null;
    }
    const stopTitle = (s: StationStop) => (s.ref ? `${nounOf(s.mode)} ${s.ref}` : s.name);
    const sectorsFor = (key: string) => (model.sectors || []).filter((s) => s.xy && pkey(s.ref) === key);
    function sectorNear(ref: string | number | undefined, xy: Pt, reach?: number) {
      let best: StationSector | null = null, bd = reach || 30;
      for (const s of sectorsFor(pkey(ref))) { const d = Math.hypot(s.xy[0] - xy[0], s.xy[1] - xy[1]); if (d < bd) { bd = d; best = s; } }
      return best ? String(best.name) : '';
    }
    // What to call an end of the route, and what is known about it
    function endInfo(end: RouteEnd | null, which: 'from' | 'to') {
      const o: EndInfo = { kind: 'free', name: which === 'from' ? 'your position' : 'your destination', ref: '', noun: '', sector: '', dist: 0, far: false, closed: false, note: '' };
      if (!end) return o;
      const viaRoute = route ? (which === 'to' ? route.toStop : route.fromStop) : null;
      // with a route only the stop the router chose counts: a stop it could not find must not turn into another one
      const s = viaRoute || (!route && end.stop ? findStop(end.stop) : null);
      if (s) {
        o.kind = 'stop'; o.stop = s; o.mode = s.mode; o.ref = s.ref || ''; o.noun = s.ref ? nounOf(s.mode) : '';
        o.name = stopTitle(s) || o.name;
        o.closed = isClosed(s); o.note = closedNote(s);
        const ar = areaAt(P, P.idxOf(s.level || 0), s.xy[0], s.xy[1]);
        if (ar && ar.kind === 'platform' && isClosed(ar.src)) { o.closed = true; o.note = o.note || closedNote(ar.src); }
      } else if (end.stop && end.stop.ref && !end.label) {
        o.kind = 'named'; o.ref = String(end.stop.ref); o.noun = /^\d/.test(pkey(end.stop.ref)) ? 'Platform' : 'Stop';
        o.name = `${o.noun} ${o.ref}`;
      } else if (end.entrance) { o.kind = 'entrance'; o.name = end.entrance; }
      if (end.label) { o.name = end.label; if (o.kind === 'free') o.kind = 'label'; }
      if (route) {
        o.dist = (which === 'to' ? route.toDist : route.fromDist) || 0;
        o.far = o.kind !== 'stop' && o.dist > 60;
        if (o.far && o.kind === 'free') { o.kind = 'label'; o.name = which === 'from' ? 'the way in' : 'the way out'; }
        const as = which === 'to' ? route.toAssumed : route.fromAssumed, named = which === 'to' ? route.toSectors : route.fromSectors;
        const last = route.steps[route.steps.length - 1];
        if (o.kind === 'stop' && !A.same) {
          const pt = which === 'to' ? route.points[route.points.length - 1] : route.points[0];
          const at = as && as.sector ? String(as.sector) : which === 'to' && last && last.sector ? String(last.sector) : sectorNear(o.ref, pt, 30);
          if (named && named.length) o.sector = named.length === 1 ? String(named[0]) : `${named[0]}–${named[named.length - 1]}`;
          else if (which === 'from') o.sector = at; // the start is where the route starts: say which sector that is
          else o.reach = at;                        // the destination is the whole platform: this is only where you get onto it
          if (as && as.text && /stairs|escalator|ramp|lift|sector/.test(as.text)) o.assumed = as.text;
        }
        if (which === 'to' && route.incomplete) o.closed = true;
        const c = (route.closed || []).find((x) => (x.what === 'stop' || x.what === 'area') && o.ref && String(x.ref || '').split('/').map(pkey).includes(pkey(o.ref)));
        if (c) { o.closed = true; o.note = o.note || c.note || ''; }
      }
      return o;
    }
    const sectorTag = (s: string) => (s ? (/[–-]/.test(s) ? `sectors ${s}` : `sector ${s}`) : '');
    // The platform (area) an end of the route stands on
    function endArea(which: 'from' | 'to') {
      if (!route) return null;
      const pt = which === 'to' ? route.points[route.points.length - 1] : route.points[0];
      const st = which === 'to' ? route.toStop : route.fromStop;
      const li = P.idxOf(pt[2]);
      let a = areaAt(P, li, pt[0], pt[1]);
      if ((!a || a.kind !== 'platform') && st && st.xy) a = areaAt(P, P.idxOf(st.level || 0), st.xy[0], st.xy[1]);
      if ((!a || a.kind !== 'platform') && st && st.ref) {
        const k = pkey(st.ref);
        let bd = 40;
        for (const q of P.levels[li].areas) {
          if (q.kind !== 'platform' || !q.keys.includes(k)) continue;
          const d = nearestOn(q.ring, pt[0], pt[1], true)!.d;
          if (d < bd) { bd = d; a = q; }
        }
      }
      return a && a.kind === 'platform' ? a : null;
    }
    // Where along a platform does `ref` stop? Lines along that edge, from the best source the model has:
    // sector spans, then the track with that number (laid onto the platform edge next to it).
    const edgeCache = new Map<string, XY[][] | null>();
    function edgeLines(area: PArea, ref: string | number | undefined): XY[][] | null {
      const k = pkey(ref), id = area.li + ':' + area.box.join(',') + ':' + k;
      if (edgeCache.has(id)) return edgeCache.get(id)!;
      const lines: XY[][] = [];
      for (const s of model.sectorSpans || []) {
        if (pkey(s.ref) !== k || !s.a || !s.b) continue;
        const mx = (s.a[0] + s.b[0]) / 2, my = (s.a[1] + s.b[1]) / 2;
        if (nearestOn(area.ring, mx, my, true)!.d < 7 || inArea(area, mx, my)) lines.push([s.a, s.b]);
      }
      if (!lines.length) {
        for (const t of model.tracks || []) {
          if (t.ref == null || pkey(t.ref) !== k || !t.line || P.idxOf(t.level || 0) !== area.li) continue;
          let run: XY[] = [];
          const flush = () => { if (run.length > 1) lines.push(run); run = []; };
          const pts: XY[] = [];
          for (let i = 0; i < t.line.length; i++) { // short steps, so a long straight track still follows a curved edge
            const a = t.line[i], b = t.line[i + 1];
            pts.push(a);
            if (!b) break;
            const n = Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]) / 6);
            for (let j = 1; j <= n; j++) pts.push([lerp(a[0], b[0], j / (n + 1)), lerp(a[1], b[1], j / (n + 1))]);
          }
          for (const p of pts) {
            if (p[0] < area.box[0] - 6 || p[0] > area.box[2] + 6 || p[1] < area.box[1] - 6 || p[1] > area.box[3] + 6) { flush(); continue; }
            const e = nearestOn(area.ring, p[0], p[1], true)!;
            if (e.d > 5) { flush(); continue; }
            run.push([e.x, e.y]);
          }
          flush();
        }
      }
      const out = lines.length ? lines : null;
      edgeCache.set(id, out);
      return out;
    }
    // The point on the edge of `ref` nearest to (x, y), or null when the model does not say where that edge is
    function edgePoint(area: PArea, ref: string | number | undefined, x: number, y: number) {
      const ls = edgeLines(area, ref);
      let best: EdgePt | null = null;
      for (const l of ls || []) { const e = nearestOn(l, x, y, false)!; if (!best || e.d < best.d) best = e; }
      if (!best) { // last resort: the stop point of that number, if it is clearly off the middle
        for (const s of model.stops || []) {
          if (!s.xy || pkey(s.ref) !== pkey(ref) || !inArea(area, s.xy[0], s.xy[1])) continue;
          const d = Math.hypot(s.xy[0] - x, s.xy[1] - y);
          if (d < 60 && (!best || d < best.d)) best = { x: s.xy[0], y: s.xy[1], d, weak: true };
        }
      }
      return best;
    }
    // Looking along (dx, dy) from (x, y): is the edge of `ref` to the left or to the right?
    function sideOf(area: PArea, ref: string | number | undefined, x: number, y: number, dx: number, dy: number) {
      const e = edgePoint(area, ref, x, y);
      if (!e) return null;
      let ox = e.x - x, oy = e.y - y;
      const other = area.keys.find((k) => k !== pkey(ref));
      const e2 = other ? edgePoint(area, other, x, y) : null;
      if (e2) { ox = e.x - e2.x; oy = e.y - e2.y; }
      const cr = dx * oy - dy * ox;
      if (Math.abs(cr) < (e.weak ? 2 : 1)) return null;
      return cr > 0 ? 'left' : 'right';
    }

    // ----- the scene -----
    function buildScene() {
      T = THEME[theme];
      edgeCache.clear();
      const C = (hex: THREE.ColorRepresentation, a?: number): RGBA => { const c = new THREE.Color(hex); return [c.r, c.g, c.b, a == null ? 1 : a]; };
      const mix = (hex: string, m: Mix, a?: number): RGBA => { const c = new THREE.Color(hex).lerp(new THREE.Color(m[0]), m[1]); return [c.r, c.g, c.b, a == null ? 1 : a]; };
      const solid = (o?: PartOpts) => new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, side: (o && o.side) || THREE.FrontSide, clippingPlanes: o && o.noclip ? null! : clip });
      const lineMat = (op: number, o?: PartOpts) => new THREE.LineBasicMaterial({ color: T.line, transparent: true, opacity: op, depthWrite: false, clippingPlanes: o && o.noclip ? null! : clip });
      // a part = one mesh with its outlines, faded as a whole
      const addPart = <X extends { kind: PartKind }>(g: Geo, ln: Geo, order: number, o?: PartOpts & { extra?: X }): Part & X => {
        o = o || {};
        const mesh = track(new THREE.Mesh(g.build(SH, true), solid(o)));
        mesh.castShadow = mesh.receiveShadow = !o.ghost;
        mesh.frustumCulled = false;
        mesh.renderOrder = order;
        if (o.grid) { // large floor tiles, faint, drawn in the shader so they cost no geometry
          const m = mesh.material;
          m.onBeforeCompile = (sh) => {
            sh.uniforms.uGrid = gridU;
            sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying float vUp;')
              .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvUp = normal.y;');
            sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uGrid;\nvarying vec3 vWPos;\nvarying float vUp;')
              .replace('#include <dithering_fragment>', 'if (uGrid > 0.001 && vUp > 0.9) {\n  vec2 gq = vWPos.xz / 2.4;\n  vec2 gw = max(fwidth(gq), vec2(1e-5));\n  vec2 gd = abs(fract(gq - 0.5) - 0.5) / gw;\n  float gl = 1.0 - min(min(gd.x, gd.y) / 1.5, 1.0);\n  gl_FragColor.rgb *= 1.0 - uGrid * gl * (1.0 - smoothstep(0.08, 0.35, max(gw.x, gw.y)));\n}\n#include <dithering_fragment>');
          };
          m.customProgramCacheKey = () => 's3grid';
        }
        const lineBase = o.line || T.lineOpacity;
        const lines = track(new THREE.LineSegments(ln.build(SH, false), lineMat(lineBase, o)));
        lines.frustumCulled = false;
        lines.renderOrder = order + 1;
        scene.add(mesh, lines);
        const part = Object.assign({ mesh, lines, op: 1, target: 1, lineBase, gain: 1, ghost: !!o.ghost }, o.extra);
        parts.push(part);
        return part;
      };

      hemi.color.set(T.hemiSky); hemi.groundColor.set(T.hemiGround); hemi.intensity = T.hemi;
      sun.intensity = T.sun;
      sun.shadow.intensity = T.shadow;

      // floors
      const tracksBy = P.levels.map((): { t: StationTrack; box: Box4 }[] => []);
      for (const t of model.tracks || []) {
        if (!t.line || t.line.length < 2) continue;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of t.line) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
        tracksBy[P.idxOf(t.level || 0)].push({ t, box: [x0, y0, x1, y1] });
      }
      const flatBy = P.levels.map((): Seg4[] => []); // level walks on each floor: where the ceiling lights hang
      const edgesBy = P.levels.map((): Seg4[] => []); // walking edges that touch each floor: where they cross a wall there is an opening
      {
        const N = (model.graph && model.graph.nodes) || [];
        for (const e of (model.graph && model.graph.edges) || []) {
          const a = N[e.a], b = N[e.b];
          if (!a || !b) continue;
          for (const lv of P.levels) {
            const ua = Math.abs(a[2] - lv.id) < .35, ub = Math.abs(b[2] - lv.id) < .35;
            if (ua || ub) edgesBy[lv.i].push([a[0], a[1], b[0], b[1]]);
            if (ua && ub && e.kind === 'walk') flatBy[lv.i].push([a[0], a[1], b[0], b[1]]);
          }
        }
      }
      const cBed = C(T.bed), cRail = C(T.rail), cSafe = C(T.safety);
      const groundLi = P.idxOf(P.levelOfZ(0));
      P.levels.forEach((lv, li) => {
        const g = new (Geo as GeoCtor)(), ln = new (Geo as GeoCtor)(), cg = new (Geo as GeoCtor)(), wg = new (Geo as GeoCtor)();
        const base = T.level(lv.id);
        const cFloor = C(T.floor), cPlat = C(T.platform), cPlatSide = C(T.platformSide), cPlaza = C(T.plaza), cRoom = C(T.room), cRoomSide = C(T.roomSide), cCeil = C(T.ceil);
        const cClosed = mix(base, [T.closed, .5]);
        const next = P.levels[li + 1];
        const gapUp = next ? next.z - lv.z : 99;
        const indoor = lv.areas.some((a) => a.kind === 'floor');
        const under = lv.z < -1.5;
        lv.ceilH = gapUp <= 9 ? clamp(gapUp - .7, 2.5, 5) : 3.4;
        los[li] = [];
        const cWall = C(T.wall), cWallEnd = mix(T.wall, [T.wallBase, .4]), cWallBase = C(T.wallBase), cWallTop = C(T.wallTop);
        const cShade = C(T.contact[0], T.contact[1]), cShade0 = C(T.contact[0], 0), cLamp = C(T.lamp), cGlow = C(T.lampGlow);
        const shg = new (Geo as GeoCtor)(), lg = new (Geo as GeoCtor)();
        // where a wall meets the floor: a darker base line, a light line under the ceiling, and a soft shade on the
        // floor in front of it. (ox, oy) is the side people stand on.
        const trim = (ax: number, ay: number, bx: number, by: number, ox: number, oy: number, lf: number, h: number) => {
          if (Math.hypot(bx - ax, by - ay) < .3) return;
          const e = .03, sx0 = ax + ox * e, sy0 = ay + oy * e, sx1 = bx + ox * e, sy1 = by + oy * e;
          wg.quad([sx0, sy0, lf, 0], [sx1, sy1, lf, 0], [sx1, sy1, lf, .16], [sx0, sy0, lf, .16], cWallBase);
          wg.quad([sx0, sy0, lf, h - .12], [sx1, sy1, lf, h - .12], [sx1, sy1, lf, h], [sx0, sy0, lf, h], cWallTop);
          shg.quadGrad([ax, ay, lf, .02], [bx, by, lf, .02], [bx + ox * .9, by + oy * .9, lf, .02], [ax + ox * .9, ay + oy * .9, lf, .02], cShade, cShade0);
        };
        // a wall along the edge of a floor: it has thickness, so its end shows where a doorway cuts it. (nx, ny) points out of the floor.
        const wall = (r: Seg4, nx: number, ny: number, lf: number) => {
          const [ax, ay, bx, by] = r, hh = lv.ceilH, t = .3;
          const q = (x0: number, y0: number, x1: number, y1: number, c: RGBA) => wg.quad([x0, y0, lf, 0], [x1, y1, lf, 0], [x1, y1, lf, hh], [x0, y0, lf, hh], c);
          q(ax, ay, bx, by, cWall);
          q(bx, by, bx + nx * t, by + ny * t, cWallEnd);
          q(ax + nx * t, ay + ny * t, ax, ay, cWallEnd);
          trim(ax, ay, bx, by, -nx, -ny, lf, hh);
        };
        const rooms = lv.areas.filter((a) => a.kind === 'room'), walk = lv.areas.filter((a) => a.kind !== 'room');
        for (const a of lv.areas) {
          const lf = a.level;
          const shut = isClosed(a.src);
          const soft = (c: RGBA) => (a.src.derived ? mix(base, [new THREE.Color(c[0], c[1], c[2]).getStyle(), .55]) : c);
          a.top = 0; a.topH = 0;
          if (a.kind === 'room') { // a low block in the model, a full wall when you stand beside it
            const h = indoor ? lv.ceilH : clamp(a.src.height || 3, 2.2, 5);
            a.topH = h;
            g.prism(a.ring, a.holes, lf, 0, lf, 0, cRoom, cRoomSide, h);
            ln.loop(a.ring, lf, .03, h);
            for (let i = 0; i < a.ring.length; i++) {
              const p = a.ring[i], q = a.ring[(i + 1) % a.ring.length], l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
              los[li].push([p[0], p[1], q[0], q[1]]);
              trim(p[0], p[1], q[0], q[1], (q[1] - p[1]) / l, -(q[0] - p[0]) / l, lf, h); // a shop front is a wall too
            }
          } else if (a.kind === 'platform') {
            a.top = .05;
            g.prism(a.ring, a.holes, lf, -1.05, lf, .05, shut ? cClosed : cPlat, shut ? cClosed : cPlatSide);
            ln.loop(a.ring, lf, .08);
            a.holes.forEach((h) => ln.loop(h, lf, .08));
            if (under) cg.prism(a.ring, a.holes, lf, 0, lf, lv.ceilH, cCeil, null, 0, true);
          } else if (a.kind === 'plaza') {
            a.top = -.07;
            g.prism(a.ring, a.holes, lf, -.4, lf, -.07, shut ? cClosed : soft(cPlaza), shut ? cClosed : soft(cPlaza));
            ln.loop(a.ring, lf, -.04);
          } else {
            g.prism(a.ring, a.holes, lf, -.5, lf, 0, shut ? cClosed : soft(cFloor), shut ? cClosed : soft(cFloor));
            ln.loop(a.ring, lf, .03);
            a.holes.forEach((h) => ln.loop(h, lf, .03));
            cg.prism(a.ring, a.holes, lf, 0, lf, lv.ceilH, cCeil, null, 0, true); // indoors there is a ceiling
            // and walls where the floor ends, except where another floor, a platform or a walkway carries on
            const edges = edgesBy[li];
            const rings = [a.ring].concat(a.holes);
            for (const ring of rings) {
              for (let i = 0; i < ring.length; i++) {
                const p = ring[i], q = ring[(i + 1) % ring.length];
                const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
                if (len < .2) continue;
                const nx = (q[1] - p[1]) / len, ny = -(q[0] - p[0]) / len; // to the right of travel: out of the floor
                const n = Math.max(1, Math.round(len / 2));
                let run: Seg4 | null = null;
                const flush = () => {
                  if (!run) return;
                  wall(run, nx, ny, lf);
                  los[li].push(run);
                  run = null;
                };
                for (let k = 0; k < n; k++) {
                  const ax = lerp(p[0], q[0], k / n), ay = lerp(p[1], q[1], k / n), bx = lerp(p[0], q[0], (k + 1) / n), by = lerp(p[1], q[1], (k + 1) / n);
                  const mx = (ax + bx) / 2, my = (ay + by) / 2, ox = mx + nx * .7, oy = my + ny * .7;
                  let open = walk.some((w) => w !== a && inArea(w, ox, oy)) || rooms.some((w) => inArea(w, ox, oy));
                  if (!open) for (const e of edges) { if (segDist(mx, my, e[0], e[1], e[2], e[3]) < 1.4) { open = true; break; } }
                  if (open) flush();
                  else if (run) { run[2] = bx; run[3] = by; }
                  else run = [ax, ay, bx, by];
                }
                flush();
              }
            }
          }
        }
        // tracks: sunk beside the platforms, flush where they cross a square (trams)
        for (const { t } of tracksBy[li]) {
          const lf = t.level != null ? P.levels[li].id : lv.id;
          let run: XY[] = [], runFlush: boolean | null = null;
          const flushRun = () => {
            if (run.length < 2) return;
            if (runFlush) {
              g.ribbon(run, .1, lf, .09, cRail, .72);
              g.ribbon(run, .1, lf, .09, cRail, -.72);
            } else {
              g.ribbon(run, 1.45, lf, -1.0, cBed, 0);
              g.ribbon(run, .1, lf, -.9, cRail, .72);
              g.ribbon(run, .1, lf, -.9, cRail, -.72);
            }
          };
          for (let i = 0; i < t.line.length - 1; i++) {
            const a = t.line[i], b = t.line[i + 1];
            const hit = areaAt(P, li, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
            const flush = !!hit && hit.kind !== 'room';
            if (runFlush !== null && flush !== runFlush) { flushRun(); run = [a]; }
            if (!run.length) run.push(a);
            run.push(b);
            runFlush = flush;
          }
          flushRun();
        }
        // the white safety line along every platform edge that has a track beside it
        const trs = tracksBy[li];
        if (trs.length) {
          for (const a of lv.areas) {
            if (a.kind !== 'platform') continue;
            const near = trs.filter((r) => r.box[0] < a.box[2] + 4 && r.box[2] > a.box[0] - 4 && r.box[1] < a.box[3] + 4 && r.box[3] > a.box[1] - 4);
            if (!near.length) continue;
            for (let i = 0; i < a.ring.length; i++) {
              const p = a.ring[i], q = a.ring[(i + 1) % a.ring.length];
              const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
              if (len < 1.5) continue;
              const tx = (q[0] - p[0]) / len, ty = (q[1] - p[1]) / len, nx = ty, ny = -tx; // outwards
              const n = Math.max(1, Math.round(len / 8));
              for (let k = 0; k < n; k++) {
                const u0 = k / n, u1 = (k + 1) / n, mx = lerp(p[0], q[0], (u0 + u1) / 2) + nx * 1.8, my = lerp(p[1], q[1], (u0 + u1) / 2) + ny * 1.8;
                let beside = false;
                for (const r of near) {
                  if (mx < r.box[0] - 2 || mx > r.box[2] + 2 || my < r.box[1] - 2 || my > r.box[3] + 2) continue;
                  if (nearestOn(r.t.line, mx, my, false)!.d < 1.9) { beside = true; break; }
                }
                if (!beside) continue;
                const A0: XY = [lerp(p[0], q[0], u0) - nx * .8, lerp(p[1], q[1], u0) - ny * .8], A1: XY = [lerp(p[0], q[0], u1) - nx * .8, lerp(p[1], q[1], u1) - ny * .8];
                g.ribbon([A0, A1], .11, a.level, .065, cSafe, 0);
              }
            }
          }
        }
        // indoors the light comes from above: panels in the ceiling along the ways through
        if (indoor) {
          const seen = new Set<string>();
          for (const e of flatBy[li]) {
            const len = Math.hypot(e[2] - e[0], e[3] - e[1]);
            if (len < 1) continue;
            const dx = (e[2] - e[0]) / len, dy = (e[3] - e[1]) / len, n = Math.max(1, Math.round(len / 5));
            for (let k = 0; k < n; k++) {
              const u = (k + .5) / n, x = e[0] + dx * len * u, y = e[1] + dy * len * u, key = Math.round(x / 4.2) + ':' + Math.round(y / 4.2);
              if (seen.has(key)) continue;
              const ar = areaAt(P, li, x, y);
              if (!ar || ar.kind !== 'floor') continue;
              seen.add(key);
              const panel = (hl: number, hw: number, yo: number, c: RGBA) => { const hx = dx * hl, hy = dy * hl, wx = -dy * hw, wy = dx * hw; lg.quad([x - hx - wx, y - hy - wy, lv.id, yo], [x + hx - wx, y + hy - wy, lv.id, yo], [x + hx + wx, y + hy + wy, lv.id, yo], [x - hx + wx, y - hy + wy, lv.id, yo], c); };
              panel(1.25, .55, lv.ceilH - .04, cGlow); // the lit patch of ceiling around it
              panel(.95, .2, lv.ceilH - .07, cLamp);
            }
          }
        }
        const main = addPart(g, ln, li * 10 + 1, { grid: true, extra: { li, kind: 'level' } }) as LevelPart;
        main.ceil = main.walls = main.plate = null;
        main.has = g.count() > 0;
        if (cg.count()) {
          const m = track(new THREE.Mesh(cg.build(SH, false), new THREE.MeshBasicMaterial({ vertexColors: true }))); // its own even tone: a ceiling is not lit by the sky
          m.frustumCulled = false;
          m.visible = false;
          scene.add(m);
          main.ceil = m;
        }
        if (wg.count()) {
          const m = track(new THREE.Mesh(wg.build(SH, true), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })));
          m.frustumCulled = false;
          m.visible = false;
          scene.add(m);
          main.walls = m;
        }
        for (const [geo, mat, order] of [
          [shg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), li * 10 + 3],
          [lg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false }), li * 10 + 4],
        ] as [Geo, THREE.MeshBasicMaterial, number][]) {
          if (!geo.count()) { mat.dispose(); continue; }
          const m = track(new THREE.Mesh(geo.build(SH, false), mat));
          m.frustumCulled = false; m.visible = false; m.renderOrder = order;
          scene.add(m);
          povOnly.push(m);
        }
        // with a route: the plate this floor lies on (only the box around the route)
        if (A.routed && A.levels.has(li)) {
          const pg = new (Geo as GeoCtor)(), pl = new (Geo as GeoCtor)();
          const ring = boxRing(A.box!), th = clamp(A.box!.hh * .05, 2.2, 4.5);
          pg.prism(ring, null, lv.id, PLATE_TOP - th, lv.id, PLATE_TOP, C(base), mix(base, T.plateSide));
          pl.loop(ring, lv.id, PLATE_TOP + .02);
          pl.loop(ring, lv.id, PLATE_TOP - th);
          for (const p of ring) pl.seg([p[0], p[1], lv.id, PLATE_TOP], [p[0], p[1], lv.id, PLATE_TOP - th]);
          main.plate = addPart(pg, pl, li * 10, { noclip: true, line: T.plateLine, extra: { li, kind: 'plate' } });
        }
        lv3.push(main);
      });

      // stairs, escalators, ramps and lifts, grouped by the floors they join (and by whether the route uses them)
      const col = { stairs: C(T.stairs), riser: C(T.riser), ramp: C(T.ramp), tread: C(T.tread), glass: C(T.glass[0], T.glass[1]), shaft: C(T.shaft[0], T.shaft[1]), cab: C(T.cab), door: C(T.door), frame: C(T.frame), arrow: C(T.safety) };
      const shutCol = { stairs: C(T.closed), riser: C(T.closed), ramp: C(T.closed), tread: C(T.closed), glass: C(T.closed, .3), shaft: C(T.closed, .25), cab: C(T.closed), door: C(T.closed), frame: C(T.closed), arrow: C(T.closed) };
      interface ConnGroup { lo: number; hi: number; touched: boolean; g: Geo; ln: Geo }
      const groups = new Map<string, ConnGroup>();
      const groupFor = (lo: number, hi: number, touched: boolean) => {
        const k = lo + ':' + hi + ':' + touched;
        if (!groups.has(k)) groups.set(k, { lo, hi, touched, g: new (Geo as GeoCtor)(), ln: new (Geo as GeoCtor)() });
        return groups.get(k)!;
      };
      for (const c of model.connectors || []) {
        const touched = !A.routed || A.conn.has(c);
        const cc = isClosed(c) ? shutCol : col;
        if (c.kind === 'elevator') {
          if (!c.xy || !c.levels || !c.levels.length) continue;
          const ls = c.levels.slice().sort((a, b) => a - b);
          const idx = ls.map((l) => P.idxOf(l));
          const G = groupFor(Math.min(...idx), Math.max(...idx), touched);
          const faces = new Map<number, XY>(); // the door is on the side of the nearest way past it
          for (const l of ls) {
            let best: Nearest | null = null;
            for (const e of edgesBy[P.idxOf(l)]) {
              if (Math.min(e[0], e[2]) > c.xy[0] + 14 || Math.max(e[0], e[2]) < c.xy[0] - 14 || Math.min(e[1], e[3]) > c.xy[1] + 14 || Math.max(e[1], e[3]) < c.xy[1] - 14) continue;
              const n = nearestOn([[e[0], e[1]], [e[2], e[3]]], c.xy[0], c.xy[1], false)!;
              if (n.d > .6 && (!best || n.d < best.d)) best = n;
            }
            const fx = best ? best.x - c.xy[0] : 0, fy = best ? best.y - c.xy[1] : -1;
            faces.set(l, Math.abs(fx) > Math.abs(fy) ? [Math.sign(fx) || 1, 0] : [0, Math.sign(fy) || -1]);
          }
          liftFaces.set(c, faces);
          addLift(G.g, G.ln, P, c, cc, faces);
        } else if (c.line && c.line.length > 1) {
          const ls = c.line.map((p) => p[2]);
          const br0 = P.bracket(Math.min(...ls)), br1 = P.bracket(Math.max(...ls));
          const G = groupFor(br0[0], br1[1], touched);
          addConnector(G.g, G.ln, P, c, cc);
        }
      }
      for (const G of groups.values()) {
        if (!G.g.count()) continue;
        conns.push(addPart(G.g, G.ln, G.lo * 10 + 5, { side: THREE.DoubleSide, extra: { lo: G.lo, hi: G.hi, touched: G.touched, kind: 'conn' } }));
      }

      // the town and the roofs around it all: a ghost in the model view, solid when you stand in it.
      // Each piece hangs on the floor at or below its base, so roofs stay over their platforms when the floors spread.
      {
        const G = { solid: [new (Geo as GeoCtor)(), new (Geo as GeoCtor)()], roof: [new (Geo as GeoCtor)(), new (Geo as GeoCtor)()], glass: [new (Geo as GeoCtor)(), new (Geo as GeoCtor)()] };
        const fg = new (Geo as GeoCtor)(), fl = new (Geo as GeoCtor)();
        const cTop = C(T.shell), cs2 = C(T.shellSide), cGlass = C(T.glass[0]);
        const kindOf = (s: { kind?: string; name?: string }) => (/glass|canopy|baldachin/i.test((s.kind || '') + ' ' + (s.name || '')) ? 'glass' : /roof/i.test(s.kind || '') ? 'roof' : 'solid');
        for (const s of model.shell || []) {
          const ring = cleanRing(s.ring, true);
          if (!ring || P.decks.has(s)) continue;
          const holes = (s.holes || []).map((h) => cleanRing(h, false)).filter(Boolean) as XY[][];
          const base = s.base || 0, top = s.top == null ? base + 4 : s.top;
          const fi = P.floorOfZ(base), lf = P.levels[fi].id, y0 = base - P.levels[fi].z;
          const kd = kindOf(s), [g, ln] = G[kd];
          const c = kd === 'glass' ? cGlass : cTop;
          if (s.kind === 'building') { // lower in the model view than in reality
            const h = clamp(top - base, 3, 45);
            g.prism(ring, holes, lf, y0, lf, y0, c, cs2, h);
            ln.loop(ring, lf, y0, h);
            if (A.routed && A.levels.has(fi) && y0 < 2.5) fl.loop(ring, lf, Math.max(y0, PLATE_TOP + .05));
          } else {
            const y1 = y0 + (top - base);
            g.prism(ring, holes, lf, y0, lf, y1, c, top - base > 1.2 ? cs2 : null);
            g.prism(ring, holes, lf, y0, lf, y0, c, null, 0, true); // seen from below
            ln.loop(ring, lf, y1);
            if (top - base <= 1.2) ln.loop(ring, lf, y0);
          }
        }
        // real roof and wall shapes, where the model has them
        for (const m of model.shellMesh || []) {
          const pos = m.positions || [], idx = m.indices || [];
          if (pos.length < 9 || idx.length < 3) continue;
          let zmin = Infinity;
          for (let i = 2; i < pos.length; i += 3) zmin = Math.min(zmin, pos[i]);
          const fi = P.floorOfZ(zmin), lf = P.levels[fi].id, z0 = P.levels[fi].z;
          const kd = kindOf(m), [g, ln] = G[kd];
          const c = kd === 'glass' ? cGlass : cTop;
          const vtx = (i: number): Vtx => [pos[i * 3], pos[i * 3 + 1], lf, pos[i * 3 + 2] - z0];
          const seen = new Set<string>();
          for (let i = 0; i + 2 < idx.length; i += 3) {
            const ia = idx[i], ib = idx[i + 1], ic = idx[i + 2];
            g.tri(vtx(ia), vtx(ib), vtx(ic), c);
            for (const [u, v] of [[ia, ib], [ib, ic], [ic, ia]]) { // outline: edges used by one triangle only
              const k = u < v ? u + ':' + v : v + ':' + u;
              if (seen.has(k)) seen.delete(k); else seen.add(k);
            }
          }
          if (seen.size < 4000) for (const k of seen) { const [u, v] = k.split(':').map(Number); ln.seg(vtx(u), vtx(v)); }
        }
        for (const kind of ['solid', 'roof', 'glass'] as const) {
          const [g, ln] = G[kind];
          if (!g.count()) continue;
          const part = addPart(g, ln, 500, { ghost: true, noclip: true, side: THREE.DoubleSide, line: T.shellLine, extra: { gain: T.shellAlpha, kind: 'shell', shell: kind } });
          part.mesh.material.depthWrite = false;
          shellParts.push(part);
        }
        if (fl.count()) {
          foot = addPart(fg, fl, 490, { ghost: true, line: theme === 'dark' ? .2 : .26, extra: { kind: 'foot' } });
        }
      }

      // a walkway under the parts of the route that have no floor in the model, so it never hangs in the air
      if (A.routed && !A.same) {
        const sg = new (Geo as GeoCtor)(), sl = new (Geo as GeoCtor)();
        const rp = route!.points, cs = C(T.strip);
        let run: XYL[] = [], lfs: number[] = [];
        const flush = () => {
          if (run.length > 1) {
            sg.ribbon(run, 1.7, lfs, -.03, cs, 0);
            for (const off of [1.7, -1.7]) {
              for (let i = 0; i < run.length - 1; i++) {
                const a = run[i], b = run[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / l * off, ny = (b[0] - a[0]) / l * off;
                sl.seg([a[0] + nx, a[1] + ny, lfs[i], 0], [b[0] + nx, b[1] + ny, lfs[i + 1], 0]);
              }
            }
          }
          run = []; lfs = [];
        };
        for (let i = 0; i < rp.length - 1; i++) {
          if (!A.float[i]) { flush(); continue; }
          if (!run.length) { run.push(rp[i]); lfs.push(rp[i][2]); }
          run.push(rp[i + 1]); lfs.push(rp[i + 1][2]);
        }
        flush();
        if (sg.count()) strip = addPart(sg, sl, 480, { noclip: true, extra: { kind: 'strip' } });
      }

      // sun: fixed to the model, so the shadows only need redrawing when the model changes
      const [bx0, by0, bx1, by1] = P.box;
      const cx = (bx0 + bx1) / 2, cz = -(by0 + by1) / 2;
      const rad = Math.hypot(bx1 - bx0, by1 - by0) / 2 + (Math.max(...Yspread) - Math.min(...Yspread));
      sun.target.position.set(cx, 0, cz);
      sun.position.set(cx - rad * .55, rad * 1.5, cz + rad * .5);
      const sc = sun.shadow.camera;
      sc.left = -rad; sc.right = rad; sc.top = rad; sc.bottom = -rad; sc.near = 1; sc.far = rad * 4;
      sc.updateProjectionMatrix();
      const size = rad > 260 || (window.devicePixelRatio || 1) < 1.5 ? 2048 : 1024;
      sun.shadow.mapSize.set(size, size);
      sun.shadow.bias = -0.0006;
      sun.shadow.normalBias = (rad * 2 / size) * 2.2;
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      shadowDirty = true;

      buildRoute();
      buildGuides();
      buildMarks();
      buildUserDisc();
      buildStreetView(groundLi);
      povScene();
    }
    // What differs when you stand inside the model: floors seen from below, ceilings, walls, solid buildings, haze
    function povScene() {
      const inside = pov || povT > .02;
      for (const l of lv3) {
        const side = pov ? THREE.DoubleSide : THREE.FrontSide;
        if (l.mesh.material.side !== side) { l.mesh.material.side = side; l.mesh.material.needsUpdate = true; }
        if (l.ceil) l.ceil.visible = inside;
        if (l.walls) l.walls.visible = inside;
      }
      for (const o of povOnly) o.visible = inside;
      for (const s of shellParts) s.gain = pov ? (s.shell === 'glass' ? .34 : s.shell === 'roof' ? .6 : .96) : T.shellAlpha;
      shadowDirty = true;
    }

    // ----- what you must take next, as an object -----
    // Every staircase, escalator, ramp and lift of the route, and every named doorway it goes through, has a second
    // skin in the route's blue with a landing on the floor before it. Only the one of the step you are on and of the
    // step after it is shown (from above: of the step that is selected), so it cannot be mistaken for another.
    function buildGuides() {
      guides = []; activeGuide = null;
      if (!A.routed || A.same) return;
      const C = (hex: THREE.ColorRepresentation, a?: number): RGBA => { const c = new THREE.Color(hex); return [c.r, c.g, c.b, a == null ? 1 : a]; };
      const blue = { stairs: C(T.route), riser: C(T.casing), ramp: C(T.route, .9), tread: C(T.route), glass: C(T.glow, .3), shaft: C(T.glow, .2), cab: C(T.route), door: C(T.route), frame: C(T.casing), arrow: C('#ffffff') };
      const rp = route!.points;
      const add = (g: Geo, ln: Geo, o: GuideInfo) => {
        const mesh = track(new THREE.Mesh(g.build(SH, false), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })));
        const lines = track(new THREE.LineSegments(ln.build(SH, false), new THREE.LineBasicMaterial({ color: T.glow, transparent: true, opacity: .95, depthWrite: false })));
        for (const m of [mesh, lines]) { m.frustumCulled = false; m.visible = false; m.renderOrder = 590; scene.add(m); }
        guides.push(Object.assign({ mesh, lines, lift: 3 }, o));
      };
      const dirAt = (i: number): XY => { // the way the route runs where it reaches point i
        for (let k = i; k > 0; k--) { const a = rp[k - 1], b = rp[k], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l > .3) return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; }
        for (let k = i; k < rp.length - 1; k++) { const a = rp[k], b = rp[k + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l > .3) return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; }
        return [1, 0];
      };
      const pad = (g: Geo, p: XYL, d: XY, w: number) => { // a landing on the floor in front of it, fading back along the way you come
        const px = -d[1], py = d[0], hw = w / 2, L = 3.2;
        g.quadGrad([p[0] - px * hw, p[1] - py * hw, p[2], .04], [p[0] + px * hw, p[1] + py * hw, p[2], .04],
          [p[0] + px * hw - d[0] * L, p[1] + py * hw - d[1] * L, p[2], .04], [p[0] - px * hw - d[0] * L, p[1] - py * hw - d[1] * L, p[2], .04], C(T.glow, .6), C(T.glow, 0));
      };
      route!.steps.forEach((st, i) => {
        if (st.kind === 'walk' || st.kind === 'arrive') return;
        let c: (StationConnector & { width?: number }) | null = null;
        for (let k = st.from; k < st.to && !c; k++) c = A.segConn[k] || null;
        const g = new (Geo as GeoCtor)(), ln = new (Geo as GeoCtor)(), p0 = rp[st.from], d = dirAt(st.from);
        if (c && c.kind === 'elevator') addLift(g, ln, P, c, blue, liftFaces.get(c));
        else if (c) addConnector(g, ln, P, c, blue, true);
        if (Math.abs(p0[2] - P.near(p0[2])) < .3) pad(g, p0, d, c && c.width ? clamp(c.width, 1.6, 6) + .8 : 3);
        const up = st.dir === 'up' || (st.dir == null && st.toLevel > st.level);
        add(g, ln, {
          kind: st.kind, step: i, entry: p0, along0: R!.A[st.from], along1: R!.A[Math.min(st.to, R!.A.length - 1)], icon: st.kind,
          title: `${CONN_WORD[st.kind] || 'Way'}${st.toLevel != null && st.toLevel !== st.level ? (up ? ' up' : ' down') : ''}`, sub: st.place ? placeName(st.place) : '',
        });
      });
      // doorways: the named ways in and out that the route goes through
      for (const e of model.entrances || []) {
        if (!e.xy || !e.name) continue;
        let bi = -1, bd = 4.5;
        rp.forEach((p, i) => { const dd = Math.hypot(p[0] - e.xy[0], p[1] - e.xy[1]); if (Math.abs(p[2] - (e.level || 0)) < .35 && dd < bd) { bd = dd; bi = i; } });
        if (bi < 0) continue;
        const p = rp[bi], d = dirAt(Math.max(1, bi)), px = -d[1], py = d[0], g = new (Geo as GeoCtor)(), ln = new (Geo as GeoCtor)();
        const hgt = 3, hw = 1.9, cB = C(T.route), cD = C(T.casing);
        for (const s of [-1, 1]) g.block(p[0] + px * hw * s, p[1] + py * hw * s, px, py, .3, .3, p[2], 0, hgt, cB, cD);
        g.block(p[0], p[1], px, py, hw * 2 + .3, .3, p[2], hgt - .3, hgt, cB, cD);
        pad(g, p, d, hw * 2);
        const inAt = (q: XYL | undefined) => { const a = q && areaAt(P, P.idxOf(q[2]), q[0], q[1]); return !!a && a.kind === 'floor'; };
        const was = inAt(rp[Math.max(0, bi - 2)]), will = inAt(rp[Math.min(rp.length - 1, bi + 2)]);
        // out of doors for 8 m on both sides, on one floor: the route only passes near this door
        const indoors = (q: XYL) => { const li = P.idxOf(q[2]), a = areaAt(P, li, q[0], q[1]); return q[2] !== p[2] || (!!a && (a.kind === 'floor' || a.kind === 'room' || (a.kind === 'platform' && P.levels[li].z < -1.5))); };
        const leads = (dir: 1 | -1) => { for (let j = bi + dir; j >= 0 && j < rp.length && Math.abs(R!.A[j] - R!.A[bi]) < 8; j += dir) if (indoors(rp[j])) return true; return false; };
        if (!was && !will && !leads(-1) && !leads(1)) continue;
        let stepI = -1;
        route!.steps.forEach((st, i) => { if (stepI < 0 && st.kind !== 'arrive' && bi >= st.from && bi <= st.to) stepI = i; });
        if (stepI < 0) continue;
        add(g, ln, { kind: 'portal', step: stepI, entry: p, along0: R!.A[bi], along1: R!.A[bi], icon: 'door', title: was && !will ? 'Way out' : !was && will ? 'Way in' : 'Through', sub: e.name });
      }
      guides.sort((a, b) => a.along0 - b.along0);
    }
    function syncGuides() {
      activeGuide = null; povArriving = false;
      const fpv = pov && !pv.free && A.routed && !A.same && !!R;
      const cs = fpv ? stepAtPi(curPi()) : sel;
      for (const gd of guides) {
        const on = fpv ? (gd.step === cs || gd.step === cs + 1) && gd.along1 >= pv.along - 2 : !pov && sel >= 0 && gd.step === sel;
        if (gd.mesh.visible !== on) gd.mesh.visible = gd.lines.visible = on;
        if (on) gd.mesh.material.opacity = fpv && gd.kind !== 'portal' && pv.along > gd.along0 + .5 ? .28 : 1;
        if (on && fpv && !activeGuide) activeGuide = gd;
      }
      if (fpv) { const st = route!.steps; povArriving = st[cs].kind === 'arrive' || (!!st[cs + 1] && st[cs + 1].kind === 'arrive'); }
    }

    // ----- marks on the floors: the destination, closed things, sectors -----
    function flatMesh<M extends THREE.Material>(g: Geo, mat: M, li: number, order?: number) {
      const mesh = track(new THREE.Mesh(g.build(SH, false), mat));
      mesh.frustumCulled = false;
      mesh.renderOrder = li * 10 + (order || 3);
      scene.add(mesh);
      return mesh;
    }
    const markMat = (hex: THREE.ColorRepresentation, alpha: number, o?: THREE.MeshBasicMaterialParameters) => new THREE.MeshBasicMaterial(Object.assign({ color: hex, transparent: true, opacity: alpha, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, clippingPlanes: clip }, o));
    function highlight(area: PArea, hex: string, alpha: number) {
      const g = new (Geo as GeoCtor)();
      g.prism(area.ring, area.holes, area.level, 0, area.level, (area.top || 0) + .07, [1, 1, 1, 1], null, area.topH || 0);
      const h: Highlight = { mesh: flatMesh(g, markMat(hex, alpha), area.li), li: area.li, base: alpha };
      hl.push(h);
      return h;
    }
    function hatch(area: PArea) {
      const g = new (Geo as GeoCtor)();
      g.prism(area.ring, area.holes, area.level, 0, area.level, (area.top || 0) + .09, [1, 1, 1, 1], null, 0);
      const mat = new THREE.ShaderMaterial({
        uniforms: { uCol: { value: new THREE.Color(WARN) }, uAlpha: { value: .8 }, uStep: { value: 3.2 } },
        vertexShader: HATCH_VERT, fragmentShader: HATCH_FRAG, transparent: true, depthWrite: false, clipping: true, clippingPlanes: clip,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      });
      const h: Highlight = { mesh: flatMesh(g, mat, area.li, 4), li: area.li, base: .8, uniform: true };
      hl.push(h);
      return h;
    }
    function stripe(lines: XY[][], area: PArea, hex: string, alpha: number, half: number, yo: number) {
      const g = new (Geo as GeoCtor)();
      for (const l of lines) g.ribbon(l, half, area.level, yo, [1, 1, 1, 1], 0);
      if (!g.count()) return null;
      const h: Highlight = { mesh: flatMesh(g, markMat(hex, alpha), area.li, 4), li: area.li, base: alpha };
      hl.push(h);
      return h;
    }
    function dropHighlight(h: Highlight | null) {
      if (!h) return;
      hl = hl.filter((x) => x !== h);
      scene.remove(h.mesh);
      h.mesh.geometry.dispose(); h.mesh.material.dispose();
      const i = disposables.indexOf(h.mesh);
      if (i >= 0) disposables.splice(i, 1);
    }
    // Sector bands along the edge of a platform number: alternating, the one to ride in marked
    function sectorBands(area: PArea, ref: string | number, best?: string | null) {
      const k = pkey(ref);
      const spans = (model.sectorSpans || []).filter((s) => pkey(s.ref) === k && s.a && s.b && nearestOn(area.ring, (s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2, true)!.d < 7);
      if (!spans.length) return;
      const g = new (Geo as GeoCtor)();
      const c = [new THREE.Color(T.band[0]), new THREE.Color(T.band[1])], cb = new THREE.Color(T.route);
      spans.forEach((s, i) => {
        const l = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) || 1, nx = -(s.b[1] - s.a[1]) / l, ny = (s.b[0] - s.a[0]) / l;
        const mx = (s.a[0] + s.b[0]) / 2, my = (s.a[1] + s.b[1]) / 2;
        const off = inArea(area, mx + nx * 1.6, my + ny * 1.6) ? 1.25 : -1.25; // onto the platform, not over the track
        const col = best && String(s.name) === String(best) ? cb : c[i % 2];
        g.ribbon([s.a, s.b], 1.0, area.level, .075, [col.r, col.g, col.b, 1], off);
      });
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: .9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, clippingPlanes: clip });
      hl.push({ mesh: flatMesh(g, mat, area.li, 4), li: area.li, base: .9 });
    }
    let pickHl: Highlight | null = null;
    function buildMarks() {
      for (const lv of P.levels) for (const a of lv.areas) if (a.kind !== 'room' && isClosed(a.src)) hatch(a);
      if (A.routed) {
        const to = endInfo(toEnd, 'to'), from = endInfo(fromEnd, 'from');
        const d = endArea('to'), s = endArea('from');
        if (d && !to.closed && !isClosed(d.src)) {
          highlight(d, T.route, theme === 'dark' ? .3 : .2); // the platform you are going to: a blue wash
          const lines = to.ref ? edgeLines(d, to.ref) : null;
          if (lines) stripe(lines, d, T.route, .95, 1.1, .1); // the edge your train leaves from: a blue band
        }
        if (s && from.ref && ride) sectorBands(s, from.ref, ride.pick);
        if (d && to.ref && d !== s && !to.closed) sectorBands(d, to.ref, to.sector && to.sector.length === 1 ? to.sector : null);
      } else if (focus && focus.hit && focus.hit.area && focus.hit.area.kind !== 'plaza' && !isClosed(focus.hit.area.src)) {
        pickHl = highlight(focus.hit.area, T.route, theme === 'dark' ? .38 : .26);
        const ref = focus.hit.stop && focus.hit.stop.ref;
        const lines = ref && focus.hit.area.kind === 'platform' ? edgeLines(focus.hit.area, ref) : null;
        if (lines) stripe(lines, focus.hit.area, T.route, .95, 1.1, .1);
      }
    }

    // ----- what you only see standing in the station: ground, signs, station furniture -----
    // Signs are pictures drawn once into one texture; boxes and poles are two instanced meshes.
    let inst: Inst | null = null; // { box, cyl, boxes: [...], cyls: [...] }
    let signList: Sign[] = []; // what hangs where (for tests)
    function buildStreetView(groundLi: number) {
      inst = null;
      const dark = theme === 'dark';
      // open ground around the station, so outdoors has a floor and a horizon
      {
        const g = new (Geo as GeoCtor)();
        const [x0, y0, x1, y1] = P.box, m = 220, lf = P.levels[groundLi].id, yo = -P.levels[groundLi].z + PLATE_TOP - .12;
        const c = new THREE.Color(T.ground);
        g.quad([x0 - m, y0 - m, lf, yo], [x1 + m, y0 - m, lf, yo], [x1 + m, y1 + m, lf, yo], [x0 - m, y1 + m, lf, yo], [c.r, c.g, c.b, 1]);
        const mesh = track(new THREE.Mesh(g.build(SH, true), new THREE.MeshLambertMaterial({ vertexColors: true })));
        mesh.frustumCulled = false; mesh.renderOrder = -5; mesh.receiveShadow = true; mesh.visible = false; mesh.userData.ground = true;
        scene.add(mesh);
        povOnly.push(mesh);
      }
      const want: Sign[] = [];   // signs: { key, style, text, x, y, lf, yc, dx, dy, h, back, maxW }
      const boxes: InstBox[] = [], cyls: InstCyl[] = [];
      const N = (model.graph && model.graph.nodes) || [], E = (model.graph && model.graph.edges) || [];
      const edgesOn = P.levels.map((): [XYL, XYL][] | null => null);
      const edgesAt = (li: number) => {
        if (!edgesOn[li]) {
          const id = P.levels[li].id, out: [XYL, XYL][] = [];
          for (const e of E) { const a = N[e.a], b = N[e.b]; if (a && b && Math.abs(a[2] - id) < .35 && Math.abs(b[2] - id) < .35) out.push([a, b]); }
          edgesOn[li] = out;
        }
        return edgesOn[li]!;
      };
      // the direction of the nearest walkway (people look along it), and the point on it
      const walkway = (li: number, x: number, y: number, reach: number) => {
        let best: Nearest | null = null;
        for (const [a, b] of edgesAt(li)) {
          if (Math.min(a[0], b[0]) > x + reach || Math.max(a[0], b[0]) < x - reach || Math.min(a[1], b[1]) > y + reach || Math.max(a[1], b[1]) < y - reach) continue;
          const e = nearestOn([a, b], x, y, false)!;
          if (e.d < reach && (!best || e.d < best.d)) best = e;
        }
        return best;
      };
      const trackDir = (li: number, x: number, y: number) => {
        let best: Nearest | null = null;
        for (const t of model.tracks || []) {
          if (!t.line || P.idxOf(t.level || 0) !== li) continue;
          const e = nearestOn(t.line, x, y, false)!;
          if (e.d < 25 && (!best || e.d < best.d)) best = e;
        }
        return best;
      };
      const headingDir = (deg: number): XY => { const r = deg * Math.PI / 180; return [Math.sin(r), Math.cos(r)]; }; // the way a thing faces → its normal
      const ceilOf = (li: number) => P.levels[li].ceilH || 3.4;
      const indoorAt = (li: number, x: number, y: number) => { const a = areaAt(P, li, x, y); return !!a && (a.kind === 'floor' || (a.kind === 'platform' && P.levels[li].z < -1.5)); };
      const hangAt = (li: number, x: number, y: number, wantY: number) => (indoorAt(li, x, y) ? Math.min(wantY, ceilOf(li) - .5) : wantY);
      const hasNear = (text: string, x: number, y: number, lf: number, r: number) => want.some((w) => w.text === text && Math.abs(w.lf - lf) < .2 && Math.hypot(w.x - x, w.y - y) < r);

      // 1. platform numbers over every stair, ramp and lift that leads to a platform, and at its head on the platform
      const platAt = (x: number, y: number, level: number) => { // the platform a stair head stands on (often in a hole cut out of the platform for it)
        const li = P.idxOf(level);
        if (Math.abs(P.levels[li].id - level) > .3) return null;
        const a = areaAt(P, li, x, y);
        if (a && a.kind === 'platform' && a.keys.length) return a;
        if (a && a.kind !== 'platform') return null;
        let best: PArea | null = null, bd = 3.5;
        for (const q of P.levels[li].areas) {
          if (q.kind !== 'platform' || !q.keys.length || x < q.box[0] - 4 || x > q.box[2] + 4 || y < q.box[1] - 4 || y > q.box[3] + 4) continue;
          let d = nearestOn(q.ring, x, y, true)!.d;
          for (const h of q.holes) d = Math.min(d, nearestOn(h, x, y, true)!.d);
          if (d < bd) { bd = d; best = q; }
        }
        return best;
      };
      const refsText = (a: PArea) => (a.src.refs || []).filter(Boolean).join('   ');
      for (const c of model.connectors || []) {
        if (c.kind === 'elevator') {
          if (!c.xy || !c.levels) continue;
          const plat = c.levels.map((l) => platAt(c.xy[0], c.xy[1], l)).find(Boolean) || c.levels.map((l) => { // a lift stands beside its platform
            const li = P.idxOf(l); let b: PArea | null = null;
            for (const a of P.levels[li].areas) if (a.kind === 'platform' && a.keys.length && nearestOn(a.ring, c.xy[0], c.xy[1], true)!.d < 2.5) b = a;
            return b;
          }).find(Boolean);
          if (!plat) continue;
          for (const l of c.levels) {
            const li = P.idxOf(l);
            if (li === plat.li) continue;
            const w = walkway(li, c.xy[0], c.xy[1], 12);
            const dx = w ? -w.dy : 1, dy = w ? w.dx : 0; // across the walkway, so it faces people walking along it
            const text = refsText(plat);
            if (hasNear(text, c.xy[0], c.xy[1], P.levels[li].id, 3)) continue;
            want.push({ style: isClosed(c) || isClosed(plat.src) ? 'closed' : 'plat', text, back: text, x: c.xy[0], y: c.xy[1], lf: P.levels[li].id, yc: hangAt(li, c.xy[0], c.xy[1], 2.8), dx, dy, h: .66 });
          }
          continue;
        }
        const ln = c.line;
        if (!ln || ln.length < 2) continue;
        const ends = [[ln[0], ln[1]], [ln[ln.length - 1], ln[ln.length - 2]]];
        const pa = platAt(ln[0][0], ln[0][1], ln[0][2]), pb = platAt(ln[ln.length - 1][0], ln[ln.length - 1][1], ln[ln.length - 1][2]);
        if (!!pa === !!pb) continue; // neither end on a platform, or it joins two platforms
        const plat = pa || pb!, [pe, pin] = pa ? ends[0] : ends[1], [oe, oin] = pa ? ends[1] : ends[0];
        const shut = isClosed(c) || isClosed(plat.src);
        // the portal: over the way in, across the direction you walk into it
        {
          const l = Math.hypot(oin[0] - oe[0], oin[1] - oe[1]) || 1, ux = (oin[0] - oe[0]) / l, uy = (oin[1] - oe[1]) / l;
          const li = P.idxOf(oe[2]);
          if (Math.abs(P.levels[li].id - oe[2]) < .3) {
            const x = oe[0] + ux * .6, y = oe[1] + uy * .6, text = refsText(plat);
            // it faces the people coming towards the stairs: its front looks back out of the portal (-u)
            if (!hasNear(text, x, y, P.levels[li].id, 2.2)) want.push({ style: shut ? 'closed' : 'plat', text, back: text, x, y, lf: P.levels[li].id, yc: hangAt(li, x, y, 2.8), dx: uy, dy: -ux, h: .66, maxW: Math.max(1.6, (c.width || 2.2) + 1) });
          }
        }
        // the head on the platform: which number is on which side as you step onto it
        {
          const l = Math.hypot(pe[0] - pin[0], pe[1] - pin[1]) || 1, ux = (pe[0] - pin[0]) / l, uy = (pe[1] - pin[1]) / l; // the way you arrive
          const refs = (plat.src.refs || []).filter(Boolean);
          if (refs.length === 2 && !shut) {
            const side = sideOf(plat, refs[0], pe[0], pe[1], ux, uy);
            if (side) {
              const L = side === 'left' ? refs[0] : refs[1], Rr = side === 'left' ? refs[1] : refs[0];
              const x = pe[0] + ux * 1.6, y = pe[1] + uy * 1.6;
              // front faces the person arriving (-u): for them left is left
              want.push({ style: 'sides', text: `${L}|${Rr}`, back: `${Rr}|${L}`, x, y, lf: plat.level, yc: 2.85, dx: uy, dy: -ux, h: .66 });
            }
          }
        }
      }
      // 2. the way out, by name
      for (const e of model.entrances || []) {
        if (!e.xy || !e.name) continue;
        const li = P.idxOf(e.level || 0);
        const w = walkway(li, e.xy[0], e.xy[1], 15);
        const dx = w ? -w.dy : 1, dy = w ? w.dx : 0;
        want.push({ style: isClosed(e) ? 'closed' : 'exit', text: e.name, back: e.name, x: e.xy[0], y: e.xy[1], lf: P.levels[li].id, yc: hangAt(li, e.xy[0], e.xy[1], 2.85), dx, dy, h: .6 });
      }
      // 3. the names of shops, on the side that faces where people walk
      for (const lv of P.levels) {
        const walk = lv.areas.filter((a) => a.kind !== 'room');
        for (const a of lv.areas) {
          const name = a.kind === 'room' && a.src.name && !/^(vacant|leer)$/i.test(a.src.name) ? String(a.src.name) : '';
          if (!name) continue;
          let best: { len: number; mx: number; my: number; nx: number; ny: number } | null = null;
          for (let i = 0; i < a.ring.length; i++) {
            const p = a.ring[i], q = a.ring[(i + 1) % a.ring.length], len = Math.hypot(q[0] - p[0], q[1] - p[1]);
            if (len < 2.4 || (best && len <= best.len)) continue;
            const nx = (q[1] - p[1]) / len, ny = -(q[0] - p[0]) / len, mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
            if (!walk.some((w) => inArea(w, mx + nx * 1.2, my + ny * 1.2))) continue;
            best = { len, mx, my, nx, ny };
          }
          if (!best) continue;
          const top = a.topH || 3;
          want.push({ style: 'shop', text: name, x: best.mx + best.nx * .07, y: best.my + best.ny * .07, lf: a.level, yc: Math.min(top - .32, 2.6), dx: -best.ny, dy: best.nx, h: .4, maxW: best.len - .5 });
        }
      }
      // 4. station furniture at its surveyed place
      const cBody = new THREE.Color(dark ? '#3a3f48' : '#3c4350'), cPole = new THREE.Color(dark ? '#8d939c' : '#6f7682'), cBlue = new THREE.Color(SIGN_BLUE), cInk = new THREE.Color(INK), cWhite = new THREE.Color('#f4f5f7');
      const plate = (p: { xy: XY }, li: number, style: SignStyle, text: string, back: string, size: number, hang: boolean, dirN: XY, colr: THREE.Color) => { // a small board, hung or on a pole
        const x = p.xy[0], y = p.xy[1], lf = P.levels[li].id;
        const yc = hang ? hangAt(li, x, y, 2.8) : 2.3;
        const dx = -dirN[1], dy = dirN[0];
        boxes.push({ x, y, lf, yo: yc - size / 2 - .04, sx: size + .08, sy: size + .08, sz: .07, dx, dy, col: colr });
        if (!hang) cyls.push({ x, y, lf, yo: 0, r: .045, h: yc - size / 2, col: cPole });
        want.push({ style, text, back, x: x + dirN[0] * .045, y: y + dirN[1] * .045, lf, yc, dx, dy, h: size, thick: .09 });
      };
      for (const p of model.props || []) {
        if (!p || !p.xy) continue;
        const li = P.idxOf(p.level || 0), lf = P.levels[li].id, x = p.xy[0], y = p.xy[1];
        const hang = p.mount ? p.mount === 'hang' : indoorAt(li, x, y);
        if (p.kind === 'sector-sign') {
          const t = trackDir(li, x, y);
          const n: XY = p.heading != null ? headingDir(p.heading) : t ? [t.dx, t.dy] : [1, 0]; // it hangs across the platform and faces along it
          // "B|C": one letter per face. Walking towards sector C you see the C: it is on the face that looks away from C.
          const names = String(p.name || '').split('|').map((s) => s.trim().slice(0, 2)).filter(Boolean);
          if (!names.length) continue;
          let front = names[0], back = names[names.length - 1];
          if (names.length > 1 && p.ref != null) {
            const side = (nm: string) => { const c = sectorsFor(pkey(p.ref)).find((s) => String(s.name) === nm); return c ? (c.xy[0] - x) * n[0] + (c.xy[1] - y) * n[1] : 0; };
            if (side(names[0]) > side(names[1])) { front = names[1]; back = names[0]; }
          }
          plate(p, li, 'sector', front, back, .56, hang, n, cBlue);
        } else if (p.kind === 'meeting-point') {
          const yc = hang ? hangAt(li, x, y, 2.9) : 2.4;
          boxes.push({ x, y, lf, yo: yc - .42, sx: .84, sy: .84, sz: .84, dx: 1, dy: 0, col: cBlue });
          if (!hang) cyls.push({ x, y, lf, yo: 0, r: .06, h: yc - .42, col: cPole });
          for (const [nx, ny] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) want.push({ style: 'meet', text: '', x: x + nx * .43, y: y + ny * .43, lf, yc, dx: -ny, dy: nx, h: .8, one: true });
        } else if (p.kind === 'clock') {
          const w = walkway(li, x, y, 15);
          const n: XY = p.heading != null ? headingDir(p.heading) : w ? [w.dx, w.dy] : [1, 0];
          const yc = hang ? hangAt(li, x, y, 3.05) : 2.9;
          boxes.push({ x, y, lf, yo: yc - .5, sx: 1.0, sy: 1.0, sz: .16, dx: -n[1], dy: n[0], col: cBody });
          if (!hang) cyls.push({ x, y, lf, yo: 0, r: .06, h: yc - .5, col: cPole });
          want.push({ style: 'clock', text: '', back: '', x: x + n[0] * .085, y: y + n[1] * .085, lf, yc, dx: -n[1], dy: n[0], h: .92, thick: .17 });
        } else if (p.kind === 'ticket-machine') {
          const w = walkway(li, x, y, 12);
          let n: XY | null = p.heading != null ? headingDir(p.heading) : null;
          if (!n && w) { const l = Math.hypot(w.x - x, w.y - y); n = l > .3 ? [(w.x - x) / l, (w.y - y) / l] : [-w.dy, w.dx]; }
          if (!n) n = [0, -1];
          boxes.push({ x, y, lf, yo: 0, sx: .86, sy: 1.86, sz: .56, dx: -n[1], dy: n[0], col: cBody });
          want.push({ style: 'ticket', text: '', x: x + n[0] * .285, y: y + n[1] * .285, lf, yc: 1.25, dx: -n[1], dy: n[0], h: .74, one: true });
        }
      }
      // 5. the letter of each tram and bus stop edge, on a pole
      for (const s of model.stops || []) {
        if (!s.xy || !s.ref || s.mode === 'train') continue;
        const li = P.idxOf(s.level || 0);
        const t = trackDir(li, s.xy[0], s.xy[1]) || walkway(li, s.xy[0], s.xy[1], 15);
        const n: XY = t ? [t.dx, t.dy] : [1, 0]; // it faces along the kerb
        const ref = String(s.ref).slice(0, 3);
        plate({ xy: s.xy }, li, isClosed(s) ? 'closed' : 'stop', ref, ref, .5, false, n, cInk);
      }

      signList = want;
      // the pictures
      if (want.length) {
        const CH = 96, PAD = 2, AW = 2048;
        const cv = document.createElement('canvas'), g = cv.getContext('2d')!;
        const font = (px: number, w?: number) => `${w || 700} ${px}px -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif`;
        const cells = new Map<string, SignCell>();
        const measure = (style: SignStyle, text: string) => {
          if (style === 'sector' || style === 'meet' || style === 'clock' || style === 'stop') return CH;
          if (style === 'ticket') return CH; // drawn 1:1, shown taller
          g.font = font(style === 'shop' ? 50 : 58, style === 'shop' ? 600 : 700);
          const t = style === 'sides' ? text.replace('|', '      ') : text;
          return Math.round(clamp(g.measureText(t).width + (style === 'sides' ? 150 : 56), CH, 760));
        };
        let x = PAD, yRow = PAD;
        const need = (style: SignStyle, text: string) => {
          const key = style + '\n' + text;
          if (cells.has(key)) return key;
          const w = measure(style, text);
          if (x + w + PAD > AW) { x = PAD; yRow += CH + PAD * 2; }
          cells.set(key, { x, y: yRow, w, style, text });
          x += w + PAD * 2;
          return key;
        };
        for (const w of want) { w.key = need(w.style, w.text); if (w.back != null && !w.one) w.keyBack = need(w.style, w.back); }
        let AH = 128;
        while (AH < yRow + CH + PAD) AH *= 2;
        cv.width = AW; cv.height = AH;
        const rr = (X: number, Y: number, Wd: number, Hd: number, r: number) => { g.beginPath(); g.moveTo(X + r, Y); g.arcTo(X + Wd, Y, X + Wd, Y + Hd, r); g.arcTo(X + Wd, Y + Hd, X, Y + Hd, r); g.arcTo(X, Y + Hd, X, Y, r); g.arcTo(X, Y, X + Wd, Y, r); g.closePath(); };
        const fit = (text: string, maxW: number, px: number, wgt?: number) => { let s = px; g.font = font(s, wgt); while (s > 22 && g.measureText(text).width > maxW) { s -= 3; g.font = font(s, wgt); } };
        g.textBaseline = 'middle'; g.textAlign = 'center';
        for (const c of cells.values()) {
          const { x: X, y: Y, w: Wd, style, text } = c, cx = X + Wd / 2, cy = Y + CH / 2;
          if (style === 'plat' || style === 'exit' || style === 'sector' || style === 'sides') {
            g.fillStyle = SIGN_BLUE; rr(X, Y, Wd, CH, 10); g.fill();
            g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 3; rr(X + 4, Y + 4, Wd - 8, CH - 8, 7); g.stroke();
            g.fillStyle = '#fff';
            if (style === 'sides') {
              const [l, r] = text.split('|');
              g.font = font(58);
              g.textAlign = 'left'; g.fillText(l, X + 62, cy + 3);
              g.textAlign = 'right'; g.fillText(r, X + Wd - 62, cy + 3);
              g.textAlign = 'center';
              g.lineWidth = 7; g.lineCap = g.lineJoin = 'round'; g.strokeStyle = '#fff';
              for (const s of [-1, 1]) { const ax = s < 0 ? X + 20 : X + Wd - 20; g.beginPath(); g.moveTo(ax - s * 18, cy - 17); g.lineTo(ax, cy); g.lineTo(ax - s * 18, cy + 17); g.stroke(); }
              g.fillStyle = 'rgba(255,255,255,.5)'; g.fillRect(cx - 1.5, Y + 18, 3, CH - 36);
            } else { fit(text, Wd - 40, style === 'sector' ? 66 : 58); g.fillText(text, cx, cy + 3); }
          } else if (style === 'closed') {
            g.fillStyle = '#fff'; rr(X, Y, Wd, CH, 10); g.fill();
            g.save(); rr(X, Y, Wd, CH, 10); g.clip();
            g.fillStyle = WARN;
            for (let k = -CH; k < Wd + CH; k += 36) { g.beginPath(); g.moveTo(X + k, Y + CH); g.lineTo(X + k + 18, Y + CH); g.lineTo(X + k + 18 + CH * .35, Y + CH - 22); g.lineTo(X + k + CH * .35, Y + CH - 22); g.closePath(); g.fill(); }
            g.restore();
            g.fillStyle = INK; fit(text, Wd - 40, 50); g.fillText(text, cx, cy - 9);
          } else if (style === 'shop') {
            g.fillStyle = dark ? '#23262c' : '#f6f6f3'; rr(X, Y, Wd, CH, 6); g.fill();
            g.fillStyle = dark ? '#f1f2f4' : '#1d2026'; fit(text, Wd - 36, 50, 600); g.fillText(text, cx, cy + 2);
          } else if (style === 'stop') {
            g.fillStyle = INK; rr(X, Y, Wd, CH, 12); g.fill();
            g.fillStyle = T.route; g.fillRect(X, Y + CH - 13, Wd, 13);
            g.fillStyle = '#fff'; fit(text, Wd - 22, 60, 800); g.fillText(text, cx, cy - 3);
          } else if (style === 'meet') {
            g.fillStyle = SIGN_BLUE; g.fillRect(X, Y, Wd, CH);
            g.fillStyle = '#fff'; g.beginPath(); g.arc(cx, cy, 9, 0, 7); g.fill();
            g.strokeStyle = '#fff'; g.lineWidth = 7; g.lineCap = g.lineJoin = 'round';
            for (let k = 0; k < 4; k++) {
              const a = k * Math.PI / 2, c0 = Math.cos(a), s0 = Math.sin(a);
              g.beginPath(); g.moveTo(cx + c0 * 40, cy + s0 * 40); g.lineTo(cx + c0 * 20, cy + s0 * 20); g.stroke();
              g.beginPath(); g.moveTo(cx + c0 * 20 - s0 * 9 + c0 * 9, cy + s0 * 20 + c0 * 9 + s0 * 9); g.lineTo(cx + c0 * 20, cy + s0 * 20); g.lineTo(cx + c0 * 20 + s0 * 9 + c0 * 9, cy + s0 * 20 - c0 * 9 + s0 * 9); g.stroke();
            }
          } else if (style === 'clock') {
            g.fillStyle = '#fff'; g.beginPath(); g.arc(cx, cy, CH / 2 - 2, 0, 7); g.fill();
            g.strokeStyle = INK; g.lineWidth = 5; g.beginPath(); g.arc(cx, cy, CH / 2 - 5, 0, 7); g.stroke();
            g.lineCap = 'butt';
            for (let k = 0; k < 12; k++) { const a = k * Math.PI / 6; g.lineWidth = k % 3 ? 3 : 5; g.beginPath(); g.moveTo(cx + Math.sin(a) * 31, cy - Math.cos(a) * 31); g.lineTo(cx + Math.sin(a) * 39, cy - Math.cos(a) * 39); g.stroke(); }
            const now = new Date(), hm = (now.getHours() % 12 + now.getMinutes() / 60) * Math.PI / 6, mm = now.getMinutes() * Math.PI / 30;
            g.lineCap = 'round';
            g.lineWidth = 6; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.sin(hm) * 21, cy - Math.cos(hm) * 21); g.stroke();
            g.lineWidth = 4.5; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.sin(mm) * 32, cy - Math.cos(mm) * 32); g.stroke();
          } else if (style === 'ticket') {
            g.fillStyle = '#d6dae0'; rr(X + 8, Y + 6, Wd - 16, CH * .5, 5); g.fill();
            g.fillStyle = '#eb0000'; g.fillRect(X + 8, Y + CH * .62, Wd - 16, 10);
            g.fillStyle = '#fff'; g.font = font(17, 700); g.fillText('Tickets', cx, Y + CH * .84);
          }
        }
        const tex = new THREE.CanvasTexture(cv);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        const sg = new (Geo as GeoCtor)();
        const uvOf = (key: string) => { const c = cells.get(key)!; return [c.x / AW, 1 - (c.y + CH) / AH, (c.x + c.w) / AW, 1 - c.y / AH, c.w / CH]; };
        for (const w of want) {
          const uv = uvOf(w.key!);
          let h = w.h, wd = h * uv[4];
          if (w.maxW && wd > w.maxW) { h *= w.maxW / wd; wd = w.maxW; }
          if (h < .15) continue;
          const y0 = w.yc - h / 2, y1 = w.yc + h / 2, hx = w.dx * wd / 2, hy = w.dy * wd / 2;
          const L = [w.x - hx, w.y - hy], Rr = [w.x + hx, w.y + hy];
          sg.quadUV([L[0], L[1], w.lf, y0], [Rr[0], Rr[1], w.lf, y0], [Rr[0], Rr[1], w.lf, y1], [L[0], L[1], w.lf, y1], uv);
          if (w.keyBack) { // the other face, readable from behind (and a hair apart, so the two do not fight)
            const ub = uvOf(w.keyBack), nx = w.dy, ny = -w.dx, t = w.thick || .03;
            const bl = [Rr[0] - nx * t, Rr[1] - ny * t], br = [L[0] - nx * t, L[1] - ny * t];
            sg.quadUV([bl[0], bl[1], w.lf, y0], [br[0], br[1], w.lf, y0], [br[0], br[1], w.lf, y1], [bl[0], bl[1], w.lf, y1], ub);
          }
        }
        const mesh = track(new THREE.Mesh(sg.build(SH, false), new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: .35 })));
        mesh.frustumCulled = false; mesh.renderOrder = 560; mesh.visible = false;
        scene.add(mesh);
        povOnly.push(mesh);
      }
      // boxes and poles: one unit box and one unit cylinder, placed many times
      if (boxes.length || cyls.length) {
        inst = { boxes, cyls, box: null, cyl: null };
        const mat = () => new THREE.MeshLambertMaterial();
        if (boxes.length) {
          inst.box = track(new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat(), boxes.length));
          boxes.forEach((b, i) => inst!.box!.setColorAt(i, b.col));
        }
        if (cyls.length) {
          inst.cyl = track(new THREE.InstancedMesh(new THREE.CylinderGeometry(.5, .5, 1, 10), mat(), cyls.length));
          cyls.forEach((b, i) => inst!.cyl!.setColorAt(i, b.col));
        }
        for (const m of [inst.box, inst.cyl]) {
          if (!m) continue;
          m.frustumCulled = false; m.visible = false; m.castShadow = true;
          if (m.instanceColor) m.instanceColor.needsUpdate = true;
          scene.add(m);
          povOnly.push(m);
        }
        placeInst();
      }
    }
    let m4: THREE.Matrix4 | null = null, q4: THREE.Quaternion = null!, p4: THREE.Vector3 = null!, s4: THREE.Vector3 = null!, yAxis: THREE.Vector3 = null!;
    function placeInst() {
      if (!inst) return;
      if (!m4) { m4 = new THREE.Matrix4(); q4 = new THREE.Quaternion(); p4 = new THREE.Vector3(); s4 = new THREE.Vector3(); yAxis = new THREE.Vector3(0, 1, 0); }
      if (inst.box) {
        inst.boxes.forEach((b, i) => {
          p4.set(b.x, Yc(b.lf) + b.yo + b.sy / 2, -b.y);
          q4.setFromAxisAngle(yAxis, Math.atan2(b.dy, b.dx));
          s4.set(b.sx, b.sy, b.sz);
          inst!.box!.setMatrixAt(i, m4!.compose(p4, q4, s4));
        });
        inst.box.instanceMatrix.needsUpdate = true;
      }
      if (inst.cyl) {
        q4.identity();
        inst.cyls.forEach((b, i) => {
          p4.set(b.x, Yc(b.lf) + b.yo + b.h / 2, -b.y);
          s4.set(b.r * 2, b.h, b.r * 2);
          inst!.cyl!.setMatrixAt(i, m4!.compose(p4, q4, s4));
        });
        inst.cyl.instanceMatrix.needsUpdate = true;
      }
    }

    // ----- the route -----
    function buildRoute() {
      R = null;
      if (!A.routed) return;
      let sm = smoothPath(route!.points);
      if (DT.h) { // inside a detail scene the line lies on the real ground and steps over kerbs: it needs close points to bend there
        const b = DT.entry!.bbox, out: SmoothPt[] = [];
        for (let j = 0; j < sm.length; j++) {
          const a = sm[j], c = sm[j + 1];
          out.push(a);
          if (!c || Math.abs(c.l - a.l) > 1e-6 || !(inBB(b, a.x, a.y, HOLE_RAMP + 1) || inBB(b, c.x, c.y, HOLE_RAMP + 1))) continue;
          const n = Math.min(500, Math.floor(Math.hypot(c.x - a.x, c.y - a.y) / .28));
          for (let k = 1; k <= n; k++) { const t = k / (n + 1); out.push({ x: lerp(a.x, c.x, t), y: lerp(a.y, c.y, t), l: a.l, o: -1 }); }
        }
        sm = out;
        for (const p of sm) p.g = liftRaw(p.x, p.y, p.l);
      }
      const m = sm.length, K = 10;
      const D = new Float32Array(m);
      const Dorig = new Float32Array(route!.points.length);
      for (let j = 0; j < m; j++) {
        if (j) {
          const a = sm[j - 1], b = sm[j];
          D[j] = D[j - 1] + Math.hypot(b.x - a.x, b.y - a.y, (P.zOf(b.l) - P.zOf(a.l)) * 2.5);
        }
        if (sm[j].o >= 0) Dorig[sm[j].o] = D[j];
      }
      const nv = m * K + 2;
      const pos = new Float32Array(nv * 3), dd = new Float32Array(nv);
      for (let j = 0; j < m; j++) {
        for (let k = 0; k < K; k++) {
          const i = j * K + k;
          pos[i * 3] = sm[j].x; pos[i * 3 + 2] = -sm[j].y;
          dd[i] = D[j];
        }
      }
      for (const [i, j] of [[m * K, 0], [m * K + 1, m - 1]]) { pos[i * 3] = sm[j].x; pos[i * 3 + 2] = -sm[j].y; dd[i] = D[j]; }
      const index: number[] = [];
      for (let j = 0; j < m - 1; j++) {
        for (let k = 0; k < K; k++) {
          const a = j * K + k, b = (j + 1) * K + k, c = (j + 1) * K + (k + 1) % K, d = j * K + (k + 1) % K;
          index.push(a, c, b, a, d, c);
        }
      }
      for (let k = 0; k < K; k++) {
        index.push(m * K, (k + 1) % K, k);
        index.push(m * K + 1, (m - 1) * K + k, (m - 1) * K + (k + 1) % K);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aD', new THREE.BufferAttribute(dd, 1));
      geo.setAttribute('aRad', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
      geo.setAttribute('aTan', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
      geo.setIndex(index);
      const total = D[m - 1];
      const col = (hex: string) => new THREE.Color(hex);
      const shared = {
        uPx: { value: .01 }, uRmin: { value: .5 }, uA0: { value: -1 }, uA1: { value: 1e9 }, uThin: { value: .7 },
        uInk: { value: col(T.chevron) }, uDim: { value: col(T.dim) }, uDone: { value: col(T.done) },
        uProg: { value: -1 }, uGrow: { value: 1e9 }, uSpacing: { value: 8 }, uPhase: { value: 0 },
        uSquash: { value: 1 }, uNear: { value: 1 }, uEye: { value: -1e6 }, uFogN: { value: 1e8 }, uFogF: { value: 1e9 },
      };
      const make = (extra: Record<string, THREE.IUniform>, o: THREE.ShaderMaterialParameters) => new THREE.ShaderMaterial(Object.assign({
        uniforms: Object.assign({}, shared, extra), vertexShader: ROUTE_VERT, fragmentShader: ROUTE_FRAG, transparent: true,
      }, o));
      const mats = [
        make({ uCol: { value: col(T.casing) }, uScale: { value: 1.3 }, uAlpha: { value: 1 }, uFlat: { value: 1 } }, { side: THREE.BackSide }),
        make({ uCol: { value: col(T.route) }, uScale: { value: 1 }, uAlpha: { value: 1 }, uFlat: { value: 0 } }, {}),
        make({ uCol: { value: col(T.route) }, uScale: { value: 1 }, uAlpha: { value: .42 }, uFlat: { value: 0 } }, { depthFunc: THREE.GreaterDepth, depthWrite: false }),
      ];
      const meshes = mats.map((mat, i) => {
        const mesh = track(new THREE.Mesh(geo, mat));
        mesh.frustumCulled = false;
        mesh.renderOrder = 600 + i;
        mesh.visible = !A.same;
        scene.add(mesh);
        return mesh;
      });
      const Am = route!.dists && route!.dists.length === route!.points.length ? route!.dists : (() => {
        const d = [0];
        for (let i = 1; i < route!.points.length; i++) d.push(d[i - 1] + Math.hypot(route!.points[i][0] - route!.points[i - 1][0], route!.points[i][1] - route!.points[i - 1][1]));
        return d;
      })();
      // metres along the route at every point of the line: at the route's own points what the router says, in between
      // by the length of the line (a lift has none: by the count)
      const AS = new Float32Array(m);
      AS[0] = Am[Math.max(0, sm[0].o)] || 0;
      for (let j = 1, j0 = 0; j < m; j++) {
        if (sm[j].o < 0 && j < m - 1) continue;
        const a0 = AS[j0], a1 = sm[j].o >= 0 ? Am[sm[j].o] : Am[Am.length - 1];
        let len = 0;
        for (let k = j0 + 1; k <= j; k++) len += Math.hypot(sm[k].x - sm[k - 1].x, sm[k].y - sm[k - 1].y);
        let run = 0;
        for (let k = j0 + 1; k <= j; k++) {
          run += Math.hypot(sm[k].x - sm[k - 1].x, sm[k].y - sm[k - 1].y);
          AS[k] = Math.max(AS[k - 1], lerp(a0, a1, len > 1e-6 ? run / len : (k - j0) / (j - j0)));
        }
        j0 = j;
      }
      // where the route changes floor (stairs, a ramp, a lift): metres along it, from and to
      const steep: [number, number][] = [];
      for (let i = 0; i + 1 < route!.points.length; i++) if (Math.abs(route!.points[i + 1][2] - route!.points[i][2]) > 1e-6) steep.push([Am[i], Am[i + 1]]);
      R = { geo, meshes, U: shared, sm, D, Dorig, total, K, A: Am, AS, steep };
      routeFrames();
    }
    // The height of the line and the directions around it depend on the shape of the model
    function routeFrames() {
      if (!R) return;
      const { sm, K, geo } = R, m = sm.length;
      const pos = geo.attributes.position.array, rad = geo.attributes.aRad.array, tan = geo.attributes.aTan.array;
      const ys = new Float32Array(m);
      for (let j = 0; j < m; j++) ys[j] = Yc(sm[j].l) + (DT.show ? sm[j].g || 0 : 0);
      let bx = 1, by = 0, bz = 0, tx = 1, ty = 0, tz = 0;
      for (let j = 0; j < m; j++) {
        const a = Math.max(0, j - 1), b = Math.min(m - 1, j + 1);
        const dx = sm[b].x - sm[a].x, dy = ys[b] - ys[a], dz = -(sm[b].y - sm[a].y);
        const l = Math.hypot(dx, dy, dz);
        if (l > 1e-4) { tx = dx / l; ty = dy / l; tz = dz / l; }
        // side = t × up; keep the previous one where the path is vertical (a lift)
        const sx = -tz, sz = tx;
        const sl = Math.hypot(sx, sz);
        if (sl > .05) { bx = sx / sl; by = 0; bz = sz / sl; }
        // n = side × t
        const nx = by * tz - bz * ty, ny = bz * tx - bx * tz, nz = bx * ty - by * tx;
        for (let k = 0; k < K; k++) {
          const ang = (k / K) * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang), i = (j * K + k) * 3;
          rad[i] = nx * c + bx * s; rad[i + 1] = ny * c + by * s; rad[i + 2] = nz * c + bz * s;
          tan[i] = tx; tan[i + 1] = ty; tan[i + 2] = tz;
          pos[i + 1] = ys[j];
        }
        if (j === 0 || j === m - 1) { const i = (m * K + (j ? 1 : 0)) * 3; tan[i] = tx; tan[i + 1] = ty; tan[i + 2] = tz; pos[i + 1] = ys[j]; }
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aRad.needsUpdate = true;
      geo.attributes.aTan.needsUpdate = true;
    }
    // Where on the drawn line the eye stands (its display distance), for the taper at your feet: the nearest place on
    // the smoothed line, which has more points than the route (rounded corners, close steps in a detail scene).
    function eyeD() {
      const key = pv.along + (PL.ride ? PL.ride.t : 0);
      if (R!.eyeKey === key) return R!.eyeD!;
      if (!PL.ride) { // the eye walks the line itself
        const e = lineAt(pv.along), D = R!.D;
        R!.eyeKey = key; R!.eyeD = lerp(D[e.j], D[Math.min(D.length - 1, e.j + 1)], e.t);
        return R!.eyeD;
      }
      const pt = pointAt(curPi()), sm = R!.sm, D = R!.D;
      let best = Infinity, val = 0;
      for (let j = 0; j + 1 < sm.length; j++) {
        const a = sm[j], b = sm[j + 1], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
        const t = l2 > 1e-9 ? clamp(((pt[0] - a.x) * dx + (pt[1] - a.y) * dy) / l2, 0, 1) : 0;
        const ex = a.x + dx * t - pt[0], ey = a.y + dy * t - pt[1], el = (lerp(a.l, b.l, t) - pt[2]) * 20;
        const d = ex * ex + ey * ey + el * el;
        if (d < best) { best = d; val = lerp(D[j], D[j + 1], t); }
      }
      R!.eyeKey = key; R!.eyeD = val;
      return val;
    }
    // display distance along the route at a (fractional) index into route.points
    function distAt(pi: number) {
      const i = clamp(Math.floor(pi), 0, R!.Dorig.length - 1), j = Math.min(R!.Dorig.length - 1, i + 1);
      return lerp(R!.Dorig[i], R!.Dorig[j], clamp(pi - i, 0, 1));
    }
    function pointAt(pi: number): XYL {
      const pts = route!.points, i = clamp(Math.floor(pi), 0, pts.length - 1), j = Math.min(pts.length - 1, i + 1), t = clamp(pi - i, 0, 1);
      return [lerp(pts[i][0], pts[j][0], t), lerp(pts[i][1], pts[j][1], t), lerp(pts[i][2], pts[j][2], t)];
    }
    // Where the drawn line is at `along` metres of the route: the eye walks the line (its corners are arcs), not the
    // router's straight pieces, so the two agree. → the piece of the line (j, t) it lies on
    function lineAt(along: number) {
      const AS = R!.AS;
      let lo = 0, hi = AS.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (AS[mid] <= along) lo = mid; else hi = mid; }
      const seg = AS[hi] - AS[lo];
      return { j: lo, t: seg > 1e-9 ? clamp((along - AS[lo]) / seg, 0, 1) : along >= AS[hi] ? 1 : 0 };
    }
    function lineXYL(along: number): XYL {
      const sm = R!.sm, e = lineAt(along), a = sm[e.j], b = sm[Math.min(sm.length - 1, e.j + 1)];
      return [lerp(a.x, b.x, e.t), lerp(a.y, b.y, e.t), lerp(a.l, b.l, e.t)];
    }
    // Where the eye stands at `along` metres: on the line, with what is left of its corners taken out (the router's
    // way around a tree is a zigzag of short pieces, which the line rounds only a little): the mean of the line a
    // step and a half to either side. At the ends, and where the floor changes, it is the line itself.
    const EYE_ROUND = 1.5;
    function eyeAt(along: number): XYL {
      const c = lineXYL(along), total = R!.A[R!.A.length - 1];
      let w = Math.min(EYE_ROUND, along, total - along);
      for (const s of R!.steep) w = Math.min(w, along < s[0] ? s[0] - along : along > s[1] ? along - s[1] : 0);
      if (!(w > .05)) return c;
      let x = 0, y = 0, n = 0;
      for (let k = -4; k <= 4; k++) { const p = k ? lineXYL(along + w * k / 4) : c, wt = 5 - Math.abs(k); x += p[0] * wt; y += p[1] * wt; n += wt; }
      return [x / n, y / n, c[2]];
    }
    // which way the line goes at `along`: towards where it is a few steps ahead, so a bend is seen coming → bearing | null
    const WAY_AHEAD = 4;
    function wayAt(along: number, pt: XYL, q?: XYL) {
      q = q || eyeAt(Math.min(R!.A[R!.A.length - 1], along + WAY_AHEAD));
      return Math.hypot(q[0] - pt[0], q[1] - pt[1]) > .3 ? Math.atan2(q[0] - pt[0], q[1] - pt[1]) : null;
    }

    function buildUserDisc() {
      const mesh = track(new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({ color: 0x0a84ff, transparent: true, opacity: .16, depthTest: false, depthWrite: false })));
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 700;
      mesh.visible = false;
      scene.add(mesh);
      disc = mesh;
    }
    // ----- the shape of the model: how far the floors are peeled apart -----
    const evalTab = (tab: number[], level: number) => { const s = P.seg(level); return tab[s[0]] + s[1] * (P.n > 1 ? tab[s[0] + 1] - tab[s[0]] : 5); };
    const Yc = (level: number) => evalTab(SH.tab, level);  // height on screen now
    const Yt = (level: number) => evalTab(tabTo, level);   // height once the running animation has settled
    function levelOfY(tab: number[], y: number) {
      const n = P.n;
      if (n === 1) return P.levels[0].id + (y - tab[0]) / 5;
      let k = 0;
      while (k < n - 2 && y > tab[k + 1]) k++;
      const d = tab[k + 1] - tab[k];
      return Math.abs(d) < 1e-6 ? P.levels[k].id : P.levels[k].id + ((y - tab[k]) / d) * (P.levels[k + 1].id - P.levels[k].id);
    }
    // Real heights, and the peeled ones: the floors that are shown sit one even gap apart, whatever their real
    // distance (1 m between two decks or 12 m down to a deep station), so they never fall into one line.
    function setupShape() {
      const n = P.n, shown = A.shown;
      Yreal = P.levels.map((l) => l.z);
      const gap = A.routed ? clamp(A.box!.hh * 2 * Math.tan(Math.PI / 2 - POL_PEEL) * 1.3, 40, 110) : clamp(P.core.hh * 2 * .9 / Math.max(1, shown.length - 1), 15, 30);
      Yspread = new Array(n).fill(null);
      shown.forEach((li, r) => { Yspread[li] = r * gap; });
      const span = shown.length > 1 ? Yreal[shown[shown.length - 1]] - Yreal[shown[0]] : 0;
      const k = span > .5 ? Math.max(1, gap * (shown.length - 1) / span) : 1;
      for (let i = 0; i < n; i++) {
        if (Yspread[i] != null) continue;
        let a = -1, b = -1;
        for (const s of shown) { if (s < i) a = s; if (s > i && b < 0) b = s; }
        if (a >= 0 && b >= 0) Yspread[i] = lerp(Yspread[a], Yspread[b], (Yreal[i] - Yreal[a]) / ((Yreal[b] - Yreal[a]) || 1));
        else if (a >= 0) Yspread[i] = Yspread[a] + (Yreal[i] - Yreal[a]) * k;
        else if (b >= 0) Yspread[i] = Yspread[b] - (Yreal[b] - Yreal[i]) * k;
        else Yspread[i] = Yreal[i];
      }
      let anchor = shown.length ? shown[0] : 0; // the floor nearest street level stays where it really is
      for (const s of shown) if (Math.abs(Yreal[s]) < Math.abs(Yreal[anchor])) anchor = s;
      const off = Yreal[anchor] - Yspread[anchor];
      for (let i = 0; i < n; i++) Yspread[i] += off;
      SH.P = P;
      SH.tab = new Array(n).fill(0); SH.dtab = new Array(n).fill(5); tabTo = new Array(n).fill(0);
      calcTab(SH.tab, peel, povT);
      for (let i = 0; i < n; i++) SH.dtab[i] = i < n - 1 ? SH.tab[i + 1] - SH.tab[i] : n > 1 ? SH.tab[i] - SH.tab[i - 1] : 5;
      SH.Hs = lerp(HS_MODEL, 1, povT);
      calcTab(tabTo, peelTo, pov ? 1 : 0);
    }
    function calcTab(out: number[], p: number, e: number) {
      const k = clamp(p, 0, 1) * (1 - e);
      for (let i = 0; i < out.length; i++) out[i] = Yreal[i] + (Yspread[i] - Yreal[i]) * k;
    }
    const plateGain = (li: number) => (li === A.shown[0] ? 1 : clamp((peel - .05) / .3, 0, 1)); // in the flat plan the upper plates are glass
    function applyShape(finish?: boolean) {
      const n = P.n;
      calcTab(SH.tab, peel, povT);
      for (let i = 0; i < n; i++) SH.dtab[i] = i < n - 1 ? SH.tab[i + 1] - SH.tab[i] : n > 1 ? SH.tab[i] - SH.tab[i - 1] : 5;
      SH.Hs = lerp(HS_MODEL, 1, povT);
      for (const p of parts) { stretch(p.mesh.geometry, SH, finish); stretch(p.lines.geometry, SH, finish); }
      for (const l of lv3) {
        if (l.ceil) stretch(l.ceil.geometry, SH, finish);
        if (l.walls) stretch(l.walls.geometry, SH, finish);
        if (l.plate) l.plate.gain = plateGain(l.li);
      }
      for (const h of hl) stretch(h.mesh.geometry, SH, finish);
      for (const o of povOnly) if (o.geometry && o.geometry.userData && o.geometry.userData.lk) stretch(o.geometry, SH, finish);
      for (const gd of guides) { stretch(gd.mesh.geometry, SH, finish); stretch(gd.lines.geometry, SH, finish); }
      placeInst();
      routeFrames();
      shadowDirty = true;
    }
    function setPeel(v: number, o?: { live?: boolean; dur?: number; delay?: number }) {
      o = o || {};
      v = clamp(v, 0, 1);
      peelTo = v;
      calcTab(tabTo, peelTo, pov ? 1 : 0);
      if (o.live || o.dur === 0 || reducedMotion()) { peel = v; peelAnim = null; applyShape(!o.live); applyOpacity(); }
      else peelAnim = { from: peel, to: v, t0: performance.now() + (o.delay || 0), dur: o.dur || 900 };
      syncPeel();
      request();
    }
    function stepPeel(now: number) {
      if (!peelAnim) return false;
      const t = clamp((now - peelAnim.t0) / peelAnim.dur, 0, 1);
      peel = lerp(peelAnim.from, peelAnim.to, spring(t));
      if (t >= 1) { peel = peelAnim.to; peelAnim = null; }
      return true;
    }
    function syncPeel() {
      if (!peelEl) return;
      peelEl.style.setProperty('--s3-peel', peelTo.toFixed(3));
      peelEl.setAttribute('aria-valuenow', String(Math.round(peelTo * 100)));
      peelEl.setAttribute('aria-valuetext', peelTo < .08 ? 'Flat plan' : peelTo > .9 ? 'Floors fully apart' : `Floors ${Math.round(peelTo * 100)} percent apart`);
    }

    // ----- camera -----
    const polOf = (p: number) => lerp(POL_FLAT, POL_PEEL, clamp(p, 0, 1));
    function limit(p: Pose) {
      const [bx0, by0, bx1, by1] = P.box, m = Math.max(20, P.diag * .15);
      p.dist = clamp(p.dist, 16, maxDist);
      p.tx = clamp(p.tx, bx0 - m, bx1 + m);
      p.tz = clamp(p.tz, -by1 - m, -by0 + m);
      p.tl = clamp(p.tl, P.levels[0].id - 1, P.levels[P.n - 1].id + 1);
      return p;
    }
    function applyCam() {
      const pol = polOf(peel), sp = Math.sin(pol), cp = Math.cos(pol), ty = Yc(cam.tl);
      camera.position.set(cam.tx + cam.dist * sp * Math.sin(cam.az), ty + cam.dist * cp, cam.tz + cam.dist * sp * Math.cos(cam.az));
      camera.lookAt(cam.tx, ty, cam.tz);
      const e = povT;
      if (e > 0) {
        const b = pv.device ? pv.dB : pv.bearing + pv.yaw + PL.gaze;
        const ph = clamp(pv.device ? pv.dP : pv.pitch + pv.slope + PL.gazeP - lerp(.1, .015, DT.k), -1.25, 1.25); // in a detail scene the eye looks up from the floor: the place is the point
        camB.position.set(pv.x, Yc(pv.level) + EYE + pv.lift, -pv.y); // pv.lift: the ground of a detail scene under the eye, eased (stepLift)
        v3.set(Math.sin(b) * Math.cos(ph), Math.sin(ph), -Math.cos(b) * Math.cos(ph)).add(camB.position);
        camB.lookAt(v3);
        camera.position.lerp(camB.position, e);
        camera.quaternion.slerp(camB.quaternion, e);
      }
      camera.fov = lerp(FOV, POV_FOV, e);
      camera.near = lerp(Math.max(1, cam.dist * .04), .25, e);
      camera.far = lerp(cam.dist + P.diag * 3 + 400, 700, e);
      camera.updateProjectionMatrix();
      const f = Math.pow(e, 3);
      fog.near = lerp(1e6, lerp(42, 95, DT.k), f); // depth reads, but a wall 40 m away is still a wall;
      fog.far = lerp(1e7, lerp(320, 800, DT.k), f); // in a detail scene the houses across the square stay clear
    }
    const focal = () => H / (2 * Math.tan(FOV * Math.PI / 360));
    // The pose (looking from az / pol) that just fits the points into the free part of the screen
    function fitPose(pts: P3[], az: number, pol: number, pad: number): Pose {
      const sp = Math.sin(pol), cp = Math.cos(pol), sa = Math.sin(az), ca = Math.cos(az);
      const f = [-sp * sa, -cp, -sp * ca], r = [ca, 0, -sa], u = [-sa * cp, sp, -ca * cp];
      let r0 = Infinity, r1 = -Infinity, u0 = Infinity, u1 = -Infinity, f0 = Infinity, f1 = -Infinity;
      for (const p of pts) {
        const pr = p[0] * r[0] + p[2] * r[2], pu = p[0] * u[0] + p[1] * u[1] + p[2] * u[2], pf = p[0] * f[0] + p[1] * f[1] + p[2] * f[2];
        if (pr < r0) r0 = pr; if (pr > r1) r1 = pr;
        if (pu < u0) u0 = pu; if (pu > u1) u1 = pu;
        if (pf < f0) f0 = pf; if (pf > f1) f1 = pf;
      }
      const F = focal();
      const tx = Math.max(60, free.w) / 2 / F, ty = Math.max(60, free.h) / 2 / F;
      const dist = Math.max(((r1 - r0) / 2 + pad) / tx, ((u1 - u0) / 2 + pad) / ty) + (f1 - f0) / 2;
      const cr = (r0 + r1) / 2, cu = (u0 + u1) / 2, cf = (f0 + f1) / 2;
      const y = u[1] * cu + f[1] * cf;
      return { az, dist, tx: r[0] * cr + u[0] * cu + f[0] * cf, tz: r[2] * cr + u[2] * cu + f[2] * cf, tl: levelOfY(tabTo, y) };
    }
    // Try the view from all around and keep the best: big on screen, stairs seen from the side, walking away from the eye
    function bestPose(pts: P3[], o: PoseOpts): Pose {
      const pol = polOf(peelTo);
      if (o.az != null) return fitPose(pts, o.az, pol, o.pad);
      const cands: Pose[] = [];
      let dmin = Infinity;
      for (let k = 0; k < 24; k++) {
        const pose = fitPose(pts, k * Math.PI / 12, pol, o.pad);
        cands.push(pose);
        dmin = Math.min(dmin, pose.dist);
      }
      let best: Pose | null = null, bestScore = -Infinity;
      for (const pose of cands) {
        const fx = -Math.sin(pose.az), fy = Math.cos(pose.az); // view direction on the ground (model x/y); right = (fy, -fx)
        let side = 0, wsum = 0;
        for (const s of o.inclines || []) { side += s[2] * Math.abs(s[0] * fy - s[1] * fx); wsum += s[2]; }
        if (wsum) side /= wsum;
        const front = o.dir ? o.dir[0] * fx + o.dir[1] * fy : 0;
        const cont = o.near == null ? 0 : 1 - Math.abs(angDiff(pose.az, o.near)) / Math.PI;
        const across = o.axis == null ? 0 : Math.abs(Math.sin(pose.az - o.axis)); // looking across the short side of the plates
        const score = (o.wFit || 1) * (dmin / pose.dist) + (o.wSide || 0) * side + (o.wFront || 0) * front + (o.wCont || 0) * cont + (o.wAcross || 0) * across;
        if (score > bestScore) { bestScore = score; best = pose; }
      }
      return best!;
    }
    const dpt = (x: number, y: number, level: number, lift?: number): P3 => [x, Yt(level) + (lift || 0), -y];
    function routeSection(i0: number, i1: number): Section { // points of route.points[i0..i1] for framing, with what the scoring needs
      const pts: P3[] = [], inclines: Incline[] = [];
      const rp = route!.points;
      for (let i = i0; i <= i1; i++) {
        pts.push(dpt(rp[i][0], rp[i][1], rp[i][2], 0));
        if (i > i0 && Math.abs(rp[i][2] - rp[i - 1][2]) > 1e-3) {
          const dx = rp[i][0] - rp[i - 1][0], dy = rp[i][1] - rp[i - 1][1], l = Math.hypot(dx, dy);
          if (l > .5) inclines.push([dx / l, dy / l, l]);
        }
      }
      const a = rp[i0], b = rp[i1];
      const dl = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return { pts, inclines, dir: dl > 1 ? [(b[0] - a[0]) / dl, (b[1] - a[1]) / dl] : null };
    }
    const boxPts = (b: Obb, levels: number[], scale?: number) => {
      const k = scale || 1, bb = { cx: b.cx, cy: b.cy, ux: b.ux, uy: b.uy, hw: b.hw * k, hh: b.hh * k }, pts: P3[] = [];
      for (const l of levels) for (const p of boxRing(bb)) pts.push(dpt(p[0], p[1], l, 0));
      return pts;
    };
    function overviewPose(o?: { az?: number }) {
      o = o || {};
      if (A.routed) { // the plates the route runs over, all of them
        const s: Section = A.same ? { pts: [], inclines: [], dir: null } : routeSection(0, route!.points.length - 1);
        const pts = boxPts(A.box!, A.shown.map((li) => P.levels[li].id), .86).concat(s.pts);
        const e = route!.points[route!.points.length - 1];
        pts.push(dpt(e[0], e[1], e[2], 9)); // room for the sign
        const multi = A.shown.length > 1;
        return bestPose(pts, { az: o.az, pad: 5, inclines: s.inclines, dir: s.dir, wFit: 1, wSide: .2, wFront: .14, wAcross: multi ? 1.2 : 0, axis: Math.atan2(-A.box!.ux, A.box!.uy) });
      }
      if (focus && focus.hit) return focusPose(focus.hit, o);
      return levelPose(isolate, o);
    }
    function focusPose(hit: Hit, o?: { az?: number }) {
      const a = hit.area, r = a && a.kind === 'platform' ? 55 : 40;
      const pts: P3[] = [];
      for (const [x, y] of [[-r, -r], [r, -r], [r, r], [-r, r]]) pts.push(dpt(hit.xy[0] + x * .8, hit.xy[1] + y * .8, hit.level, 0));
      pts.push(dpt(hit.xy[0], hit.xy[1], hit.level, 9));
      return bestPose(pts, { az: o && o.az, pad: 6, wFit: 1, wCont: .2, near: tween ? tween.to.az : cam.az });
    }
    function levelPose(li: number | null, o?: { az?: number }) {
      const pts: P3[] = [];
      if (li == null) {
        // all floors: the station itself (around its train platforms), not the whole neighbourhood
        const tr = (model.stops || []).filter((s) => s.mode === 'train' && s.xy).map((s) => P.idxOf(s.level || 0));
        const lis = tr.length ? [Math.min(...tr), Math.max(...tr)] : A.shown.length ? [A.shown[0], A.shown[A.shown.length - 1]] : [0];
        for (const p of boxPts(P.core, lis.map((i) => P.levels[i].id), 1)) pts.push(p);
      } else {
        const lv = P.levels[li];
        const b = A.routed ? { cx: A.box!.cx, cy: A.box!.cy, ux: A.box!.ux, uy: A.box!.uy, hw: A.box!.hw * 1.5, hh: A.box!.hh * 1.8 } : { cx: P.core.cx, cy: P.core.cy, ux: P.core.ux, uy: P.core.uy, hw: P.core.hw * 1.5, hh: P.core.hh * 1.6 };
        const near = (lv.hull || []).filter((p) => inBox(b, p[0], p[1], 0));
        for (const a of lv.areas) for (const p of a.ring) if (inBox(b, p[0], p[1], 0)) near.push(p);
        const use = near.length >= 3 ? near : (lv.hull || []);
        const stride = Math.max(1, Math.ceil(use.length / 400));
        for (let i = 0; i < use.length; i += stride) pts.push(dpt(use[i][0], use[i][1], lv.id, 0));
      }
      if (!pts.length) pts.push([0, 0, 0]);
      return bestPose(pts, { az: o && o.az, pad: Math.max(4, P.core.hh * .04), wFit: 1, wCont: .25, near: tween ? tween.to.az : cam.az });
    }
    function stepPose(i: number) {
      const st = route!.steps[i];
      const s = routeSection(st.from, Math.max(st.from, st.to));
      const lift = st.kind === 'arrive' || i === route!.steps.length - 1;
      if (lift) { const e = route!.points[st.to]; s.pts.push(dpt(e[0], e[1], e[2], 9)); }
      const xs = s.pts.map((p) => p[0]), zs = s.pts.map((p) => p[2]);
      const ext = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
      const pad = Math.max(11, 22 - ext / 2);
      const climb = st.kind !== 'walk' && st.kind !== 'arrive';
      const near = tween ? tween.to.az : cam.az;
      if (!s.dir && i > 0) { // a lift or the arrival: keep looking the way we came
        const prev = routeSection(route!.steps[i - 1].from, route!.steps[i - 1].to);
        s.dir = prev.dir;
      }
      return bestPose(s.pts, climb
        ? { pad, inclines: s.inclines, dir: s.dir, wFit: .35, wSide: .75, wFront: .3, wCont: .2, near }
        : { pad, dir: s.dir, wFit: .5, wFront: .55, wCont: .2, near });
    }
    function currentPose() {
      if (A.routed && !A.same && sel >= 0 && isolate == null) return stepPose(sel);
      if (isolate != null) return levelPose(isolate);
      return overviewPose();
    }
    function flyTo(pose: Partial<Pose>, dur?: number) {
      pose = limit(Object.assign({}, cam, pose));
      spin.az = spin.x = spin.z = 0;
      if (reducedMotion() || dur === 0) { Object.assign(cam, pose); tween = null; }
      else tween = { from: Object.assign({}, cam), to: pose as Pose, daz: angDiff(pose.az!, cam.az), t0: performance.now(), dur: dur || 900 };
      request();
    }
    function stepTween(now: number) {
      if (!tween) return false;
      const t = clamp((now - tween.t0) / tween.dur, 0, 1), e = spring(t), a = tween.from, b = tween.to;
      cam.az = a.az + tween.daz * e;
      cam.dist = Math.exp(lerp(Math.log(a.dist), Math.log(b.dist), e));
      cam.tx = lerp(a.tx, b.tx, e); cam.tl = lerp(a.tl, b.tl, e); cam.tz = lerp(a.tz, b.tz, e);
      if (t >= 1) tween = null;
      return true;
    }
    function stepSpin(dt: number) {
      if (!spin.az && !spin.x && !spin.z) return false;
      cam.az += spin.az * dt; cam.tx += spin.x * dt; cam.tz += spin.z * dt;
      limit(cam);
      const k = Math.exp(-dt / 280);
      spin.az *= k; spin.x *= k; spin.z *= k;
      if (Math.abs(spin.az) < 2e-5) spin.az = 0;
      if (Math.abs(spin.x) < 1e-3) spin.x = 0;
      if (Math.abs(spin.z) < 1e-3) spin.z = 0;
      return true;
    }

    // ----- what is solid and what recedes -----
    function setTargets() {
      const n = P.n, routed = A.routed;
      const lvT = new Array(n).fill(1), plT = new Array(n).fill(0);
      let shellT = 1, footT = 0, top = n; // floors from `top` up are cut away
      if (pov) { /* everything is there when you stand in it */ }
      else if (isolate != null) {
        for (let i = 0; i < n; i++) lvT[i] = i === isolate ? 1 : 0;
        shellT = 0;
      } else if (routed) {
        for (let i = 0; i < n; i++) { const on = A.levels.has(i); lvT[i] = on ? 1 : 0; plT[i] = on ? 1 : 0; }
        if (sel >= 0 && !A.same) { // one step: its floors in full, the floors above it cut away so they cannot cover it
          const st = route!.steps[sel], l2 = st.toLevel == null ? st.level : st.toLevel;
          top = P.bracket(Math.max(st.level, l2))[1] + 1;
          for (let i = top; i < n; i++) { lvT[i] = 0; plT[i] = 0; }
        }
        shellT = 0; footT = 1;
      }
      setClip(routed && !pov && isolate == null ? A.box : null);
      lv3.forEach((l, i) => { l.target = lvT[i]; if (l.plate) l.plate.target = plT[i]; });
      conns.forEach((c) => {
        if (pov) c.target = 1;
        else if (isolate != null) c.target = c.lo <= isolate && c.hi >= isolate ? 1 : 0;
        else if (routed) {
          const on = A.levels.has(c.lo) && A.levels.has(c.hi);
          c.target = !on ? 0 : c.lo >= top ? 0 : c.touched ? 1 : c.hi >= top ? 0 : .3; // other stairs up into a floor that is cut away would only dangle
        } else c.target = 1;
      });
      for (const s of shellParts) s.target = shellT;
      if (foot) foot.target = footT;
      if (strip) strip.target = isolate != null && !pov ? 0 : 1;
      // the route: the selected step is bright, the rest thinner and paler
      if (R) {
        if (sel >= 0 && !pov && !A.same) {
          const st = route!.steps[sel];
          R.U.uA0.value = distAt(st.from);
          R.U.uA1.value = distAt(st.to);
        } else { R.U.uA0.value = -1; R.U.uA1.value = 1e9; }
      }
      const active = new Set<number>();
      if (routed && sel >= 0 && !A.same) {
        const st = route!.steps[sel];
        for (const i of P.bracket(st.level)) active.add(i);
        if (st.toLevel != null) for (const i of P.bracket(st.toLevel)) active.add(i);
      } else if (isolate != null) active.add(isolate);
      levelLabels.forEach((L) => L.el.classList.toggle('s3-active', active.has(L.li)));
      syncGuides();
      syncDetail();
      request();
    }
    function applyOpacity() {
      for (const p of parts) {
        const m = p.mesh.material;
        m.opacity = p.op * p.gain;
        const solid = m.opacity >= .45 && !p.ghost;
        if (m.depthWrite !== solid) { m.depthWrite = solid; shadowDirty = true; }
        p.mesh.castShadow = solid;
        p.lines.visible = p.op > .01 && !p.cut;
        p.mesh.visible = p.op * p.gain > .008 && !p.cut; // cut: a detail scene stands in its place
        p.lines.material.opacity = p.ghost ? p.lineBase * p.op * (p.kind === 'shell' ? Math.min(1, p.gain / T.shellAlpha) : 1) : p.lineBase * (.3 + .7 * p.op) * (p.op < .5 ? 1.3 : 1);
      }
      hl.forEach((h) => {
        const o = lv3[h.li].op;
        if (h.uniform) h.mesh.material.uniforms.uAlpha.value = h.base * o; else h.mesh.material.opacity = h.base * o;
        h.mesh.visible = o > .3 && !lv3[h.li].cut;
      });
    }
    function stepOpacity(dt: number) {
      let busy = false;
      const k = reducedMotion() ? 1 : 1 - Math.exp(-dt / 110);
      for (const o of parts) {
        if (o.op === o.target) continue;
        o.op += (o.target - o.op) * k;
        if (Math.abs(o.target - o.op) < .004) o.op = o.target; else busy = true;
      }
      applyOpacity();
      return busy;
    }
    const snapOpacity = () => { for (const p of parts) p.op = p.target; applyOpacity(); };
    const vis = (li: number) => (lv3[li] ? lv3[li].op : 0); // how much of a floor shows

    // ----- first-person view -----
    const stepAtPi = (pi: number) => {
      const st = route!.steps;
      for (let i = 0; i < st.length; i++) if (st[i].kind !== 'arrive' && pi < st[i].to - 1e-6) return i;
      return st.length - 1;
    };
    function walkTo(along: number) {
      along = clamp(along, 0, R!.A[R!.A.length - 1]);
      PL.ride = null;
      if (reducedMotion()) { pv.along = along; pv.walk = null; }
      else pv.walk = { from: pv.along, to: along, t0: performance.now(), dur: clamp(Math.abs(along - pv.along) * 55, 450, 3200) };
      request();
    }
    const userHere = () => !!user && !user.outside && user.sx != null;   // drawn on the plan
    const userKnown = () => !!user && !user.outside && user.x != null;   // a position at the station, drawn or not yet
    function setPov(on: boolean) {
      on = !!on;
      if (on === pov || !self.ready) return;
      pov = on;
      root.classList.toggle('s3-pov', pov);
      if (pov) {
        if (isolate != null) { isolate = null; syncLevels(); }
        if (listMode) toggleList();
        pv.yaw = pv.pitch = pv.slope = 0;
        pv.walk = null;
        if (A.routed && !A.same) {
          pv.free = false;
          pv.along = userHere() && user!.along != null ? user!.along : opts.povAt != null ? clamp(+opts.povAt, 0, R!.A[R!.A.length - 1]) : R!.A[route!.steps[Math.max(0, sel)].from];
          PL.by = userHere() && user!.along != null ? 'position' : 'step';
          opts.povAt = null;
          const pt = eyeAt(pv.along), way = wayAt(pv.along, pt);
          pv.x = pv.tx = pt[0]; pv.y = pv.ty = pt[1]; pv.level = pv.tl = pt[2];
          pv.bearing = pv.tb = pv.wb = way != null ? way : -cam.az;
        } else {
          pv.free = true;
          // a position far outside the model is no place to stand: start at what was tapped, the destination, an entrance
          const here = userHere() ? { xy: [user!.sx!, user!.sy!], level: user!.sl } : null;
          const at = picked || (focus && focus.hit) || (A.routed ? { xy: route!.points[0], level: route!.points[0][2] } : null) || here || ((model.entrances || []).find((e) => e.xy)) || { xy: [P.core.cx, P.core.cy], level: P.near(0) };
          pv.x = pv.tx = at.xy[0]; pv.y = pv.ty = at.xy[1]; pv.level = pv.tl = at.level || 0;
          pv.bearing = pv.tb = pv.wb = -cam.az;
        }
        pv.bv = 0; pv.arr = 0; pv.lx = NaN; // the eye was put there: its height is taken at once
      } else {
        pv.device = false;
        cam.tx = pv.x; cam.tz = -pv.y; cam.tl = pv.level;
        if (PL.on) setPlay(false);
      }
      povAnim = { from: povT, to: pov ? 1 : 0, t0: performance.now(), dur: reducedMotion() ? 1 : 1300 };
      calcTab(tabTo, peelTo, pov ? 1 : 0);
      if (demo && pov) { povT = 1; povAnim = null; applyShape(true); } // the demo opens at eye level: no flight down from the model
      povScene();
      setTargets();
      syncPov();
      if (!pov) flyTo(currentPose(), 1300);
      hudKey = '';
      syncPlay();
      say(pov ? 'Street-level view' : 'Model view');
      emit('pov', pov);
      touch();
      request();
    }
    function stepPov(dt: number, now: number) {
      let busy = false;
      if (povAnim) {
        const t = clamp((now - povAnim.t0) / povAnim.dur, 0, 1);
        povT = lerp(povAnim.from, povAnim.to, spring(t));
        if (t >= 1) { povT = povAnim.to; povAnim = null; povScene(); }
        busy = true;
      }
      if (DT.entry) { ensureDetail(); syncDetail(); }
      { const kt = DT.show && pov && inBB(DT.entry!.bbox, pv.x, pv.y, 4) ? 1 : 0; if (DT.k !== kt) { DT.k += (kt - DT.k) * (reducedMotion() ? 1 : 1 - Math.exp(-dt / 500)); if (Math.abs(kt - DT.k) < .01) DT.k = kt; else busy = true; } }
      if (!pov) return stepLift(dt) || busy;
      const k = (tau: number) => (reducedMotion() ? 1 : 1 - Math.exp(-dt / tau));
      pv.arr = 0;
      if (!pv.free && A.routed) {
        const total = R!.A[R!.A.length - 1];
        if (follow && userHere() && user!.salong != null) { // a live position leads; the walk by itself gives way
          if (PL.on) setPlay(false);
          pv.along = user!.salong; pv.walk = null; PL.ride = null; PL.by = 'position';
        } else if (pv.walk) {
          const t = clamp((now - pv.walk.t0) / pv.walk.dur, 0, 1);
          pv.along = lerp(pv.walk.from, pv.walk.to, easeInOut(t));
          if (t >= 1) pv.walk = null;
          busy = true;
        } else if (PL.on) { stepPlay(dt, now, total); busy = true; }
        // the eye stands on the drawn line (in a lift: in its shaft) and looks where the line is a few steps ahead
        const pi = curPi(), pt = PL.ride ? pointAt(pi) : eyeAt(pv.along);
        const q = eyeAt(Math.min(total, pv.along + WAY_AHEAD));
        const dh = Math.hypot(q[0] - pt[0], q[1] - pt[1]);
        const way = wayAt(pv.along, pt, q);
        if (way != null) pv.wb = way;
        pv.tb = pv.wb;
        // the arrival view: over the last metres the head turns towards it (not further than a walker would look aside),
        // and once the walk has stopped it turns all the way and rests there
        if (arriveLook && total - pv.along < ARRIVE_M && Math.hypot(arriveLook[0] - pt[0], arriveLook[1] - pt[1]) > .5) {
          const u = clamp(1 - (total - pv.along) / ARRIVE_M, 0, 1), stopped = total - pv.along < .06 && !PL.on && !pv.walk;
          pv.arr = Math.max(.001, u * u * (3 - 2 * u));
          const off = angDiff(Math.atan2(arriveLook[0] - pt[0], arriveLook[1] - pt[1]), pv.wb);
          pv.tb = pv.wb + (stopped ? off : clamp(off, -1.1, 1.1) * pv.arr);
        }
        pv.slope = lerp(pv.slope, Math.atan2(P.zOf(q[2]) - P.zOf(pt[2]), Math.max(2, dh)) * .55, k(300));
        pv.tx = pt[0]; pv.ty = pt[1]; pv.tl = pt[2];
        const cs = stepAtPi(pi);
        if (cs !== sel) select(cs, { fromPov: true });
        syncGuides();
        busy = stepGaze(dt) || busy;
        if (pv.along !== PL.lastAlong && !progress(false)) busy = true; // the last change is always told
        if (pv.along >= total - .05) arrive(PL.by);
      } else if (follow && userHere()) { pv.tx = user!.sx!; pv.ty = user!.sy!; pv.tl = user!.sl!; }
      const kk = k(PL.on && !pv.free ? 70 : 140); // the walk that plays is smooth by itself: the eye keeps to the line
      pv.x += (pv.tx - pv.x) * kk; pv.y += (pv.ty - pv.y) * kk; pv.level += (pv.tl - pv.level) * kk;
      const db = angDiff(pv.tb, pv.bearing), dts = Math.min(dt, 100) / 1000;
      if (pv.arr > 0 && !reducedMotion()) { // arriving: the turn has no jolt, also when the goal jumps as the walk stops
        const [turn, bv] = damp(0, db, pv.bv, .4 + .1 * Math.abs(db), dts);
        pv.bearing += turn; pv.bv = bv;
        if (Math.abs(bv) > .01) busy = true;
      } else {
        const turn = db * k(260);
        pv.bearing += turn; pv.bv = turn / dts;
      }
      busy = stepLift(dt) || busy;
      if (Math.hypot(pv.tx - pv.x, pv.ty - pv.y) > .02 || Math.abs(pv.tl - pv.level) > .003 || Math.abs(db) > .004) busy = true;
      if (pv.device && pv.orient) {
        pv.dB += angDiff(pv.orient.b, pv.dB) * k(90);
        pv.dP += (pv.orient.p - pv.dP) * k(90);
        if (Math.abs(angDiff(pv.orient.b, pv.dB)) > .003) busy = true;
      }
      // indoors the haze is the grey of a hall, outdoors the colour of the sky
      const li = P.idxOf(pv.level), ar = areaAt(P, li, pv.x, pv.y);
      const ind = ar && (ar.kind === 'floor' || ar.kind === 'room' || (ar.kind === 'platform' && P.levels[li].z < -1.5)) ? 1 : 0;
      if (indoorT !== ind) { indoorT += (ind - indoorT) * k(350); if (Math.abs(ind - indoorT) < .01) indoorT = ind; else busy = true; }
      root.classList.toggle('s3-indoor', indoorT > .5);
      updateHud();
      return busy;
    }
    // The ground of a detail scene under the eye has kerbs and folds: the eye rides over them without a jolt. A jump of
    // the eye itself (a step that was chosen, the scrubber, the start) or a scene that appears is taken at once.
    function stepLift(dt: number) {
      const goal = detailLift(pv.x, pv.y, pv.level);
      const jump = !(Math.hypot(pv.x - pv.lx, pv.y - pv.ly) <= 1.2) || !(Math.abs(pv.level - pv.ll) <= .3) || pv.liftShow !== DT.show || reducedMotion();
      pv.lx = pv.x; pv.ly = pv.y; pv.ll = pv.level; pv.liftShow = DT.show;
      if (jump) { pv.lift = goal; pv.liftV = 0; return false; }
      [pv.lift, pv.liftV] = damp(pv.lift, goal, pv.liftV, .32, Math.min(dt, 100) / 1000);
      if (Math.abs(goal - pv.lift) < .001 && Math.abs(pv.liftV) < .004) { pv.lift = goal; pv.liftV = 0; return false; }
      return true;
    }
    // ----- the walk plays by itself -----
    // where on the route the eye is: metres along it, or, in a lift (no metres), how far up the shaft
    const curPi = () => (PL.ride ? PL.ride.i + (PL.ride.j - PL.ride.i) * easeInOut(PL.ride.t) : piAt(pv.along));
    const pausePlay = () => { if (PL.on) setPlay(false); };
    function dirAt(along: number) {
      const total = R!.A[R!.A.length - 1], p = pointAt(piAt(clamp(along, 0, total))), q = pointAt(piAt(clamp(along + 1.5, 0, total)));
      return Math.hypot(q[0] - p[0], q[1] - p[1]) > .2 ? Math.atan2(q[0] - p[0], q[1] - p[1]) : null;
    }
    // o.user: the traveller pressed the button (API calls and the open option are "by itself")
    function setPlay(on: boolean, o?: { user?: boolean }) {
      on = !!on; o = o || {};
      if (on) {
        if (!self.ready || !A.routed || A.same || !R) return false;
        if (follow && userHere() && user!.along != null) { if (!o.user) return false; setFollow(false); } // a live position leads, unless the traveller says otherwise
        if (!pov) setPov(true);
        const total = R.A[R.A.length - 1];
        if (pv.along >= total - .3) { // at the end: once more from the start (a cut, not a flight back)
          pv.along = 0;
          const pt = eyeAt(0), way = wayAt(0, pt);
          pv.x = pv.tx = pt[0]; pv.y = pv.ty = pt[1]; pv.level = pv.tl = pt[2];
          if (way != null) pv.bearing = pv.tb = pv.wb = way;
          pv.bv = 0; pv.arr = 0; pv.lx = NaN;
          hudKey = '';
        }
        pv.walk = null;
        pv.yaw = angDiff(pv.yaw, 0);
        PL.on = true; PL.v = 0; PL.ride = null; PL.by = 'play';
        PL.slide = performance.now() + 1100;
      } else {
        if (!PL.on) return false;
        PL.on = false; PL.v = 0;
        if (PL.ride) { if (PL.ride.t < .5) pv.along = Math.max(0, R!.A[PL.ride.i] - .01); PL.ride = null; } // a ride that is broken off ends at the nearer door
      }
      syncPlay();
      if (root) say(PL.on ? 'The walk is playing' : 'The walk is paused');
      emit('play', PL.on);
      touch();
      request();
      return PL.on;
    }
    function syncPlay() {
      if (root) root.classList.toggle('s3-playing', PL.on);
      if (!playBtn) return;
      const end = R && A.routed && pv.along >= R.A[R.A.length - 1] - .3;
      playBtn.innerHTML = svg(PL.on ? 'pause' : 'play');
      playBtn.title = PL.on ? 'Pause' : end ? 'Play the walk again' : 'Play the walk';
      playBtn.setAttribute('aria-label', PL.on ? 'Pause the walk' : end ? 'Play the walk again from the start' : 'Play the walk: the view walks the route by itself');
    }
    function stepPlay(dt: number, now: number, total: number) {
      PL.by = 'play';
      if (povAnim && povT < .8) return; // still flying down from the model
      if (reducedMotion()) { // no gliding: one step after the other, like slides
        if (performance.now() < PL.slide) return;
        PL.slide = performance.now() + 2600;
        if (sel < route!.steps.length - 1) select(sel + 1, { auto: true });
        if (sel >= route!.steps.length - 1) setPlay(false); // the last slide: then the arrival is told, last
        return;
      }
      const dts = Math.min(dt, 120) / 1000, pts = route!.points, Ar = R!.A; // a slow phone still walks at walking pace
      if (PL.ride) { // in the lift: along stays, the floor changes
        PL.ride.t = Math.min(1, PL.ride.t + dt / PL.ride.dur);
        if (PL.ride.t >= 1) PL.ride = null;
        return;
      }
      const st = route!.steps[stepAtPi(piAt(pv.along))];
      // a natural pace: slower on stairs, a little slower through a bend, coming to rest at the end
      let vt = WALK_MS * PL.speed * (st.kind === 'stairs' ? .6 : st.kind === 'escalator' ? .7 : st.kind === 'ramp' ? .85 : 1);
      const d0 = dirAt(pv.along), d1 = dirAt(pv.along + 3.5);
      if (d0 != null && d1 != null) vt *= lerp(1, .6, clamp(Math.abs(angDiff(d1, d0)) / 1.2, 0, 1));
      // with an arrival view the walk comes to rest gently, over about the metres the head turns in
      vt = Math.min(vt, arriveLook ? Math.sqrt(.9 * Math.max(0, total - pv.along)) + .04 : Math.sqrt(1.8 * Math.max(1, PL.speed) * Math.max(0, total - pv.along)) + .12);
      PL.v += clamp(vt - PL.v, -3 * dts, 1.1 * Math.max(1, PL.speed) * dts);
      let a = pv.along + PL.v * dts;
      for (let i = Math.floor(piAt(pv.along)); i < pts.length - 1 && Ar[i] <= a + 1e-6; i++) {
        if (Ar[i] > pv.along + 1e-6 && Ar[i + 1] - Ar[i] < .005 && Math.abs(pts[i + 1][2] - pts[i][2]) > .05) { // a lift ahead
          let j = i + 1;
          while (j < pts.length - 1 && Ar[j + 1] - Ar[j] < .005) j++;
          const ls = route!.steps.find((q) => q.kind !== 'arrive' && q.from <= i && q.to >= j);
          PL.ride = { i, j, t: 0, dur: clamp(((ls && ls.seconds) || 14) / PL.speed, 3, 10) * 1000 };
          PL.v = 0;
          a = Ar[i];
          break;
        }
      }
      pv.along = Math.min(total, a);
      if (pv.along >= total - .06) { pv.along = total; setPlay(false); } // then the arrival is told, last
    }
    // What is worth a look where you walk (a detail scene's monument, fountain or clock; a row of trees pulls a
    // little): the head turns towards it while it is ahead and near, and back. → [yaw, pitch] to add
    function gazeTarget() {
      if (!DT.show || !DT.data) return [0, 0];
      if (PL.poisOf !== DT.data) {
        PL.poisOf = DT.data; PL.pois = [];
        for (const p of DT.data.props || []) if (p && p.xy && /^(statue|fountain|clock)$/.test(p.kind)) PL.pois.push({ x: p.xy[0], y: p.xy[1], h: isFinite(p.height!) ? +p.height! : 4, w: 1 });
        for (const t of DT.data.trees || []) if (t && t.xy) PL.pois.push({ x: t.xy[0], y: t.xy[1], h: isFinite(t.height!) ? +t.height! : 8, w: .14 });
      }
      const ss = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
      let sy = 0, sp = 0, sw = 0;
      for (const p of PL.pois!) {
        const dx = p.x - pv.x, dy = p.y - pv.y, d = Math.hypot(dx, dy);
        if (d > 12 || d < 1) continue;
        const rel = angDiff(Math.atan2(dx, dy), pv.bearing), ar = Math.abs(rel);
        if (ar > 2.1) continue;
        const w = p.w * (1 - ss(7, 12, d)) * (1 - ss(1.5, 2.1, ar));
        sy += w * clamp(rel, -1, 1); sp += w * Math.atan2(p.h * .55 - EYE, d); sw += w;
      }
      // never so far that the way ahead leaves the picture: on an upright phone the view is narrow
      const m = Math.max(1, sw), cap = clamp(Math.atan(Math.tan(POV_FOV * Math.PI / 360) * W / H) * .5, .08, .4);
      return [clamp(sy / m * .5, -cap, cap), clamp(sp / m * .3, 0, .16)];
    }
    function stepGaze(dt: number) {
      let ty = 0, tp = 0;
      if (PL.on && !pv.device && !PL.ride && !reducedMotion()) {
        [ty, tp] = gazeTarget();
        if (pv.arr > 0) { ty *= 1 - pv.arr; tp *= 1 - pv.arr; } // arriving: the head has its own goal
        if (pv.yaw || pv.pitch) { // the head comes back to the way after the traveller looked around
          const kk = 1 - Math.exp(-dt / 450);
          pv.yaw -= pv.yaw * kk; pv.pitch -= pv.pitch * kk;
          if (Math.abs(pv.yaw) < .003) pv.yaw = 0;
          if (Math.abs(pv.pitch) < .003) pv.pitch = 0;
        }
      }
      const k = reducedMotion() ? 1 : 1 - Math.exp(-dt / 900);
      PL.gaze += (ty - PL.gaze) * k; PL.gazeP += (tp - PL.gazeP) * k;
      if (Math.abs(ty - PL.gaze) < .002 && Math.abs(tp - PL.gazeP) < .002) { PL.gaze = ty; PL.gazeP = tp; return !!(PL.on && (pv.yaw || pv.pitch)); }
      return true;
    }
    // 'progress': how far the walk in the first-person view has come, a few times a second. → was it told?
    function progress(force: boolean) {
      const t = performance.now();
      if (!R || (!force && t - PL.lastProg < 250)) return false;
      PL.lastProg = t; PL.lastAlong = pv.along;
      emit('progress', { along: Math.round(pv.along * 10) / 10, total: Math.round(R.A[R.A.length - 1] * 10) / 10, step: stepAtPi(curPi()) });
      return true;
    }
    // 'arrived': once per open, however the walk got to the destination
    function arrive(by: Station3DArrivedBy) {
      if (PL.arrived || !A.routed || A.same || !R) return;
      PL.arrived = true;
      const total = Math.round(R.A[R.A.length - 1] * 10) / 10;
      PL.lastProg = performance.now(); PL.lastAlong = pv.along;
      emit('progress', { along: total, total, step: route!.steps.length - 1 });
      emit('arrived', { by });
    }
    const placeAt = (st?: RouteStep | null) => (st && st.place ? cap(String(st.place).replace(/^the /, '')) : levelName(st ? st.level : pv.level));
    // The sign over the path and the card below say the same thing: the banner shows what you are doing now (the step
    // on the card) and, under it, what comes after and how far that is.
    function updateHud() {
      const routed = !pv.free && A.routed;
      if (hudEl.hidden !== !routed) { hudEl.hidden = !routed; miniEl.hidden = !routed; layout(); } // labels keep clear of both
      if (!routed) { subEl.textContent = `${levelName(pv.level)} · tap the floor to walk there`; return; }
      const total = R!.A[R!.A.length - 1], pi = curPi(), cs = stepAtPi(pi), st = route!.steps[cs], n = route!.steps.length;
      const next = route!.steps[cs + 1];
      const left = Math.max(0, R!.A[Math.min(st.to, R!.A.length - 1)] - pv.along), togo = Math.max(0, total - pv.along);
      const key = cs + ':' + Math.round(left / 5) + ':' + Math.round(togo / 5);
      if (key !== hudKey) {
        hudKey = key;
        const arrived = st.kind === 'arrive' || togo < 2;
        const turn = st.turn;
        const ic = arrived ? 'arrive' : st.kind !== 'walk' ? st.kind : turn === 'left' || turn === 'bear-left' ? 'tleft' : turn === 'right' || turn === 'bear-right' ? 'tright' : 'up';
        hudEl.firstElementChild!.innerHTML = svg(ic);
        hudEl.querySelector('b')!.textContent = arrived ? arriveTitle() : st.text;
        const then = arrived ? arriveLine() : !next ? '' : `${left < 4 ? 'Next' : 'Then in ' + fmtM(left)}: ${lowerFirst(next.kind === 'arrive' ? arriveTitle(true) : next.text)}`;
        const line = hudEl.querySelector<HTMLElement>(':scope > div > span')!;
        line.textContent = then;
        line.hidden = !then;
        root.style.setProperty('--s3-hud-h', hudEl.offsetHeight + 'px');
        subEl.textContent = `${placeAt(st)} · step ${cs + 1} of ${n} · ${togo < 4 ? 'there' : fmtM(togo) + ' to go'}`;
      }
      if (scrubEl && document.activeElement !== scrubEl) scrubEl.value = pv.along;
      if (scrubEl) scrubEl.style.setProperty('--s3-p', (pv.along / total * 100).toFixed(1) + '%');
      drawMini();
    }
    function drawMini() {
      const c = miniEl, g = c.getContext('2d')!, w = c.width, r = w / 2, sc = w / 96; // 96 m across
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, w, w);
      g.save();
      g.beginPath(); g.arc(r, r, r - 2, 0, Math.PI * 2); g.clip();
      g.fillStyle = theme === 'dark' ? 'rgba(44,44,46,.92)' : 'rgba(255,255,255,.94)';
      g.fillRect(0, 0, w, w);
      const b = pv.device ? pv.dB : pv.bearing + pv.yaw + PL.gaze;
      g.translate(r, r * 1.25);
      g.rotate(-b);
      g.scale(sc, -sc);
      g.translate(-pv.x, -pv.y);
      g.lineJoin = g.lineCap = 'round';
      const rp = route!.points, lvl = P.near(pv.level);
      const stroke = (same: boolean, width: number, color: string) => {
        g.beginPath();
        for (let i = 0; i < rp.length - 1; i++) {
          const on = Math.abs((rp[i][2] + rp[i + 1][2]) / 2 - lvl) < .75;
          if (on !== same) continue;
          g.moveTo(rp[i][0], rp[i][1]); g.lineTo(rp[i + 1][0], rp[i + 1][1]);
        }
        g.lineWidth = width; g.strokeStyle = color; g.stroke();
      };
      stroke(false, 2.2, theme === 'dark' ? 'rgba(255,255,255,.28)' : 'rgba(20,22,26,.22)');
      stroke(true, 4.6, T.casing);
      stroke(true, 3, T.route);
      const e = rp[rp.length - 1];
      g.fillStyle = theme === 'dark' ? '#F2F3F5' : INK;
      g.beginPath(); g.arc(e[0], e[1], 3.2, 0, Math.PI * 2); g.fill();
      g.restore();
      // north, on the rim
      g.save();
      g.translate(r, r);
      g.rotate(-b);
      g.fillStyle = '#ff3b30';
      g.beginPath(); g.moveTo(0, -r + 5); g.lineTo(7, -r + 19); g.lineTo(-7, -r + 19); g.closePath(); g.fill();
      g.restore();
      // you: an arrow pointing the way you look
      g.save();
      g.translate(r, r * 1.25);
      g.scale(sc * 1.9, sc * 1.9);
      g.fillStyle = '#0a84ff'; g.strokeStyle = '#fff'; g.lineWidth = 1.1; g.lineJoin = 'round';
      g.beginPath(); g.moveTo(0, -4.6); g.lineTo(3.6, 3.6); g.lineTo(0, 1.9); g.lineTo(-3.6, 3.6); g.closePath(); g.fill(); g.stroke();
      g.restore();
    }
    function syncPov() {
      for (const b of levelsEl.querySelectorAll('.s3-povbtn')) b.setAttribute('aria-pressed', String(pov));
      const pb = levelsEl.querySelector<HTMLElement>('.s3-povbtn');
      if (pb) {
        pb.innerHTML = svg(pov ? 'layers' : 'eye');
        pb.title = pov ? 'Back to the model from above' : 'See it as you walk';
        pb.setAttribute('aria-label', pov ? 'Street-level view is on. Switch to the model from above' : 'Switch to street-level view');
      }
      const lb = levelsEl.querySelector('.s3-lookbtn');
      if (lb) lb.setAttribute('aria-pressed', String(pv.device));
      fitBtn.hidden = pov;
      northBtn.hidden = pov || !self.ready;
      if (!pov) { hudEl.hidden = true; miniEl.hidden = true; if (sheetEl && !sheetEl.hidden) buildSubtitle(); }
      if (scrubRow) scrubRow.hidden = !pov;
      syncPlay();
      sizeSheet();
    }
    // "Look where I'm facing": the phone's compass and tilt turn the head. Only once the phone really reports
    // which way it points; a refusal or silence is said, not left as a frozen view.
    function setDeviceLook(want: boolean) {
      clearTimeout(orientTimer);
      if (!want) {
        if (pv.device) { pv.yaw = angDiff(pv.dB, pv.bearing); pv.pitch = clamp(pv.dP + .1, -1.1, 1); }
        pv.device = false;
        syncPov(); request();
        return;
      }
      const lb = levelsEl.querySelector('.s3-lookbtn');
      if (lb) lb.setAttribute('aria-busy', 'true');
      const start = () => {
        if (lb) lb.removeAttribute('aria-busy');
        if (!self.alive || !pov) return;
        pv.dB = pv.orient!.b; pv.dP = pv.orient!.p;
        pv.device = true;
        toast('Hold the phone upright and turn around: the view turns with you.', 3500);
        syncPov(); request();
      };
      const fail = (why: string) => {
        if (lb) lb.removeAttribute('aria-busy');
        if (!self.alive) return;
        pv.device = false;
        toast(why === 'denied' ? 'Motion access is off for this site. Allow it in Settings › Safari › Motion & Orientation Access, then reload.'
          : 'This device doesn’t report which way it points. Drag to look around.', 6000);
        say('Looking around with the phone is not available');
        syncPov(); request();
      };
      enableCompass().then((state) => {
        if (!self.alive) return;
        if (state !== 'granted') { fail(state); return; }
        if (pv.orient) { start(); return; }
        pv.waiting = start;
        orientTimer = setTimeout(() => { if (pv.waiting === start) { pv.waiting = null; fail('silent'); } }, 1800);
      });
      request();
    }
    function recentre() {
      if (pv.device) setDeviceLook(false);
      pv.yaw = 0; pv.pitch = 0;
      request();
    }
    // Is a point on your floor hidden behind a wall or a shop from where you stand?
    function hiddenFromEye(x: number, y: number, level: number) {
      const li = P.idxOf(pv.level);
      if (Math.abs(P.levels[li].id - pv.level) > .45 || Math.abs(level - pv.level) > .7) return false;
      const segs = los[li];
      if (!segs || !segs.length) return false;
      const ex = pv.x, ey = pv.y;
      const x0 = Math.min(ex, x), x1 = Math.max(ex, x), y0 = Math.min(ey, y), y1 = Math.max(ey, y);
      const a: XY = [ex, ey], b: XY = [x, y];
      for (const s of segs) {
        if (Math.max(s[0], s[2]) < x0 || Math.min(s[0], s[2]) > x1 || Math.max(s[1], s[3]) < y0 || Math.min(s[1], s[3]) > y1) continue;
        if (segsCross(a, b, [s[0], s[1]], [s[2], s[3]])) return true;
      }
      return false;
    }

    // ----- frame loop: runs only while something moves -----
    function request() {
      if (!self.alive || raf || lost) return;
      clearTimeout(slowTimer); slowTimer = 0;
      raf = requestAnimationFrame(frame);
    }
    function frame(now: number) {
      raf = 0;
      if (!self.alive || !self.ready || lost) return;
      const dt = now - lastT > 250 ? 16 : Math.max(1, now - lastT);
      lastT = now;
      let busy = false;
      // how long frames take while the eye walks: a device that cannot keep up draws fewer pixels from then on
      if (!FT.sim) {
        const real = performance.now(), d = real - FT.last;
        FT.last = real;
        // only a frame that follows a busy one straight away says how fast the device is: a view that stands still
        // is drawn on a slow timer, and those gaps are not slow frames
        if (!FT.chain) FT.slow = 0;
        else if (d > 0 && d < 250) {
          FT.avg += (d - FT.avg) * .1;
          FT.ring[FT.n++ % FT.ring.length] = d;
          FT.slow = pov && povT > .98 && FT.avg > 24 ? FT.slow + 1 : 0;
          if (FT.slow >= 40) {
            FT.slow = 0;
            const cur = pixelRatio(), next = PR_STEPS.find((s) => s < cur - .01);
            if (next) { FT.cap = next; FT.drops++; renderer.setPixelRatio(pixelRatio()); renderer.setSize(W, H, false); }
          }
        }
      }
      // what moves in the detail scene by itself (a tram): the scene says while it does
      const dh = DT.show && DT.h ? DT.h as Station3DDetailHandle & { tick?: (now: number) => boolean } : null;
      if (dh && typeof dh.tick === 'function') { try { if (dh.tick(now)) busy = true; } catch (e) { console.error('Station3D: detail tick', e); } }
      busy = stepTween(now) || busy;
      busy = stepSpin(dt) || busy;
      const p0 = peel, e0 = povT;
      busy = stepPeel(now) || busy;
      busy = stepUser(dt) || busy;
      busy = stepPov(dt, now) || busy;
      if (peel !== p0 || povT !== e0) applyShape(!peelAnim && !povAnim);
      busy = stepOpacity(dt) || busy;
      if (grow && R) {
        const t = clamp((now - grow.t0) / grow.dur, 0, 1);
        R.U.uGrow.value = t >= 1 ? 1e9 : R.total * (1 - Math.pow(1 - t, 2.2));
        if (t >= 1) grow = null; else busy = true;
      }
      // the arrows on the route keep drifting for a while after the last touch, then rest
      const flowing = R && !A.same && !reducedMotion() && !document.hidden && now - lastActivity < 14000;
      if (flowing) { phase = (phase + dt * .00042) % 1; R!.U.uPhase.value = phase; }
      render();
      FT.chain = busy;
      if (busy) request();
      else if (flowing) slowTimer = setTimeout(request, 34);
    }
    const fogCol: Record<'a' | 'b' | 'c', THREE.Color | null> = { a: null, b: null, c: null };
    function render() {
      applyCam();
      if (R) {
        const px = 2 * Math.tan(camera.fov * Math.PI / 360) / H, e = povT;
        // from above: a line of fixed width on screen. Standing on it: a band about a metre wide on the floor, which
        // narrows with distance as a real one would (and never below a hair's width)
        const half = lerp(3.1, 1.1, e);
        R.U.uPx.value = half * px;
        R.U.uRmin.value = lerp(.36, .33, e);
        R.U.uNear.value = lerp(1, .45, e);
        R.U.uSquash.value = lerp(1, .1, e);
        R.U.uEye.value = e > .5 && pov && !pv.free ? eyeD() : -1e6;
        R.U.uFogN.value = fog.near; R.U.uFogF.value = fog.far * .9;
        const r = Math.max(R.U.uRmin.value, half * px * cam.dist);
        R.U.uSpacing.value = e > .5 ? 3.2 : 2 * Math.pow(2, Math.round(Math.log2(Math.max(1, r * 9) / 2)));
      }
      if (!fogCol.a) { fogCol.a = new THREE.Color(); fogCol.b = new THREE.Color(); }
      fogCol.a.set(T.fogOut); fogCol.b!.set(T.fogIn);
      fog.color.copy(fogCol.a).lerp(fogCol.b!, indoorT);
      gridU.value = povT > .5 ? (theme === 'dark' ? .3 : .13) : 0;
      if (R && R.meshes[2]) R.meshes[2].visible = !A.same && povT < .5; // seen through floors from above, never through walls when you stand inside
      if (shadowDirty) { renderer.shadowMap.needsUpdate = true; shadowDirty = false; }
      renderer.render(scene, camera);
      placeLabels();
      if (northBtn && !northBtn.hidden) northBtn.style.setProperty('--s3-north', (cam.az * 180 / Math.PI).toFixed(1) + 'deg');
    }
    let moved = false; // has the user turned or zoomed the model themselves?
    const touch = () => { lastActivity = performance.now(); };
    // ----- labels pinned to the model (HTML, so they stay sharp and are real buttons) -----
    // Every label has a priority. Higher ones are placed first and keep their place; a lower one that would touch
    // them tries its other positions and is then left out. Nothing is placed under a control or cut by the screen edge.
    let userLabel: Label | null = null, safe = { x0: 0, y0: 0, x1: 1, y1: 1 }, avoid: Box4[] = [];
    function clearLabels() {
      labelsEl.textContent = '';
      labels = []; levelLabels = []; tip = null; userLabel = null; beacon = null;
    }
    function addLabel(el: HTMLElement, o: LabelInit) {
      el.classList.add('s3-l', 's3-off');
      labelsEl.appendChild(el);
      const L = Object.assign({ el, ax: .5, ay: .5, prio: 0, li: -1, lift: 0, shown: false, w: 0, h: 0, block: true, yield: true }, o) as Label;
      labels.push(L);
      labelsDirty = true;
      return L;
    }
    function project(x: number, y: number, level: number, lift?: number): XY | null {
      v3.set(x, Yc(level) + (lift || 0) + detailLift(x, y, level), -y).project(camera);
      if (v3.z < -1 || v3.z > 1) return null;
      return [(v3.x * .5 + .5) * W, (-v3.y * .5 + .5) * H];
    }
    const modeIcon = (mode: string) => (mode === 'tram' ? 'tram' : mode === 'bus' ? 'bus' : null);
    // A point on a platform near (x, y), moved along the platform away from (tx, ty): room for a label beside the route
    function along(area: PArea, x: number, y: number, tx: number, ty: number, d: number) {
      const e = nearestOn(area.ring, x, y, true)!;
      let best: XY = [x, y], bd = -1;
      for (const s of [1, -1]) {
        const px = x + e.dx * d * s, py = y + e.dy * d * s;
        if (!inArea(area, px, py)) continue;
        const dd = Math.hypot(px - tx, py - ty);
        if (dd > bd) { bd = dd; best = [px, py]; }
      }
      return best;
    }

    function buildLabels() {
      clearLabels();
      const routed = A.routed;
      const to = endInfo(toEnd, 'to'), from = endInfo(fromEnd, 'from');
      const destA = routed ? endArea('to') : null, startA = routed ? endArea('from') : null;
      const destKey = routed && to.ref ? pkey(to.ref) : focus && focus.hit && focus.hit.stop ? pkey(focus.hit.stop.ref) : '';
      const startKey = routed && from.ref ? pkey(from.ref) : '';
      const inPlate = (x: number, y: number) => !routed || inBox(A.box!, x, y, -2);

      // floors: a name on the corner of each plate. With a route it is the place the route uses on that floor.
      const fnames = floorNames();
      // where a floor's name may sit: the corners of its plate, then points along its edges
      const plateRim: XY[] = [];
      if (routed) {
        const ring = boxRing(A.box!);
        for (const p of ring) plateRim.push(p);
        ring.forEach((p, i) => { const q = ring[(i + 1) % 4]; for (const t of [.5, .25, .75]) plateRim.push([lerp(p[0], q[0], t), lerp(p[1], q[1], t)]); });
      }
      for (const lv of P.levels) {
        if (!A.levels.has(lv.i) && !lv.areas.length) continue;
        const b = mk('button', 's3-lv');
        b.type = 'button';
        b.tabIndex = -1;
        const nm = fnames.get(lv.i) || lv.name;
        b.append(mk('i', null, levelShort(lv.id)), mk('span', null, nm));
        b.setAttribute('aria-label', `${nm}, level ${levelShort(lv.id)}: show only this floor`);
        b.onclick = () => setIsolate(isolate === lv.i ? null : lv.i);
        const full = (lv.hull || []).slice();
        for (const a of lv.areas) { const st = Math.max(1, Math.ceil(a.ring.length / 12)); for (let i = 0; i < a.ring.length; i += st) full.push(a.ring[i]); }
        levelLabels.push(addLabel(b, { kind: 'level', li: lv.i, level: lv.id, plate: routed && A.levels.has(lv.i) ? plateRim : null, rim: full.length > 500 ? full.filter((p, i) => i % Math.ceil(full.length / 500) === 0) : full, prio: routed ? 70 : 45, ax: 0, ay: .5 })); // without a route the platform numbers come first
      }

      // platforms: one label per island, both numbers on it, each on the side its edge is on
      const isl = (area: PArea, x: number, y: number, prio: number, own: boolean) => {
        const refs = (area.src.refs || []).filter(Boolean);
        if (!refs.length) return null;
        const b = mk('button', 's3-isl' + (own ? ' s3-own' : ''));
        b.type = 'button';
        b.tabIndex = -1;
        const st0 = (model.stops || []).find((s) => s.xy && area.keys.includes(pkey(s.ref)) && inArea(area, s.xy[0], s.xy[1]));
        const mode = st0 ? st0.mode : 'train';
        const ic = modeIcon(mode);
        if (ic) { b.classList.add('s3-m'); b.insertAdjacentHTML('beforeend', svg(ic)); }
        const shut = isClosed(area.src);
        refs.slice(0, 3).forEach((r) => {
          const c = mk('span', null, r);
          const k = pkey(r);
          if (k === destKey && (area === destA || (!routed && focus && focus.hit && focus.hit.area === area))) c.classList.add('s3-dest');
          if (k === startKey && area === startA) c.classList.add('s3-from');
          const st = (model.stops || []).find((s) => pkey(s.ref) === k && s.xy && inArea(area, s.xy[0], s.xy[1]));
          if (shut || (st && isClosed(st))) c.classList.add('s3-shut');
          b.append(c);
        });
        const noun = nounOf(mode);
        b.setAttribute('aria-label', `${refs.length > 1 ? noun + 's ' + refs.join(' and ') : noun + ' ' + refs[0]}${shut ? ', closed' : ''}`);
        b.onclick = (ev) => {
          const cell = (ev.target as HTMLElement).closest('span');
          const k = cell ? pkey(cell.textContent) : area.keys[0];
          const st = (model.stops || []).find((s) => pkey(s.ref) === k && s.xy && inArea(area, s.xy[0], s.xy[1]));
          showPick({ stop: st || null, li: area.li, level: area.level, xy: st ? st.xy.slice() as XY : [x, y], area });
        };
        // where each number's edge is, to put the numbers on the right sides of the label
        let ends: [XY, XY] | null = null;
        if (refs.length === 2) {
          const e0 = edgePoint(area, refs[0], x, y), e1 = edgePoint(area, refs[1], x, y);
          if (e0 && e1 && Math.hypot(e0.x - e1.x, e0.y - e1.y) > 2) ends = [[e0.x, e0.y], [e1.x, e1.y]];
          else b.classList.add('s3-any');
        }
        return addLabel(b, { kind: 'isl', area, x, y, level: area.level, li: area.li, lift: .6, prio, ends, minPpm: own ? 0 : mode === 'train' ? .55 : 1.1, own: !!own });
      };
      const placed: [PArea, number, number][] = []; // [area, x, y]
      const farFrom = (area: PArea, x: number, y: number, d: number) => !placed.some((q) => q[0] === area && Math.hypot(q[1] - x, q[2] - y) < d);
      if (routed) {
        const rp = route!.points, e = rp[rp.length - 1], a0 = rp[0];
        for (const area of A.areas) {
          let at: XY | null = null;
          if (area === destA && !A.same) at = along(area, e[0], e[1], rp[Math.max(0, rp.length - 3)][0], rp[Math.max(0, rp.length - 3)][1], 9);
          else if (area === startA) at = along(area, a0[0], a0[1], rp[Math.min(rp.length - 1, 2)][0], rp[Math.min(rp.length - 1, 2)][1], A.same ? 0 : 9);
          else { // a platform the route only crosses: where it does
            const on = rp.filter((p) => P.idxOf(p[2]) === area.li && inArea(area, p[0], p[1]));
            if (on.length) { const m = on[on.length >> 1]; at = along(area, m[0], m[1], m[0], m[1], 5); }
          }
          if (!at) continue;
          isl(area, at[0], at[1], 86, true);
          placed.push([area, at[0], at[1]]);
        }
        for (const area of [destA, startA]) { // an end that lies off its platform polygon still gets its numbers
          if (!area || placed.some((q) => q[0] === area)) continue;
          const p = area === destA ? e : a0, n = nearestOn(area.ring, p[0], p[1], true)!;
          isl(area, n.x, n.y, 86, true);
          placed.push([area, n.x, n.y]);
        }
      }
      // every other platform: at its stop points (the same number is named once per stretch)
      const seenStop: { k: string; mode: string; xy: XY }[] = [];
      for (const s of model.stops || []) {
        if (!s.xy) continue;
        const li = P.idxOf(s.level || 0), k = pkey(s.ref);
        if (!inPlate(s.xy[0], s.xy[1])) continue;
        const area = areaAt(P, li, s.xy[0], s.xy[1]);
        const onIsland = area && area.kind === 'platform' && area.keys.includes(k);
        if (onIsland && area.keys.length >= 1 && (s.mode === 'train' || area.keys.length > 1)) {
          if (routed && s.mode !== 'train') continue; // other tram and bus edges say nothing about this walk
          if (!farFrom(area, s.xy[0], s.xy[1], 70)) continue;
          isl(area, s.xy[0], s.xy[1], s.mode === 'train' ? 54 : 50, false);
          placed.push([area, s.xy[0], s.xy[1]]);
          continue;
        }
        if (!k) continue; // a stop without a letter has nothing to show as a label
        if (routed) continue;
        if (seenStop.some((q) => q.k === k && q.mode === s.mode && Math.hypot(q.xy[0] - s.xy[0], q.xy[1] - s.xy[1]) < 40)) continue;
        seenStop.push({ k, mode: s.mode, xy: s.xy });
        const b = mk('button', 's3-stop' + (isClosed(s) ? ' s3-shut' : ''));
        b.type = 'button';
        b.tabIndex = -1;
        const ic = modeIcon(s.mode);
        if (ic) b.insertAdjacentHTML('beforeend', svg(ic));
        b.append(mk('b', null, s.ref));
        b.setAttribute('aria-label', `${stopTitle(s)}, ${s.name}${isClosed(s) ? ', closed' : ''}`);
        b.onclick = () => showPick({ stop: s, li, level: P.levels[li].id, xy: s.xy.slice() as XY, area });
        addLabel(b, { kind: 'stop', stop: s, x: s.xy[0], y: s.xy[1], level: s.level || 0, li, lift: .6, prio: s.mode === 'train' ? 53 : 50, minPpm: s.mode === 'train' ? .55 : 1.15 });
      }
      // sector letters: along your own platforms always, along the others when you are close
      {
        const seen: { n: string; x: number; y: number }[] = [];
        for (const s of model.sectors || []) {
          if (!s.xy || s.name == null) continue;
          const k = pkey(s.ref);
          const st = (model.stops || []).find((q) => pkey(q.ref) === k && q.xy && Math.hypot(q.xy[0] - s.xy[0], q.xy[1] - s.xy[1]) < 600);
          const lvl = s.level != null ? s.level : st ? st.level || 0 : 0, li = P.idxOf(lvl);
          if (!inPlate(s.xy[0], s.xy[1])) continue;
          const own = routed && ((k === startKey && startA && nearestOn(startA.ring, s.xy[0], s.xy[1], true)!.d < 8) || (k === destKey && destA && nearestOn(destA.ring, s.xy[0], s.xy[1], true)!.d < 8));
          if (routed && !own) continue; // other platforms' sectors say nothing about this walk
          if (!own && seen.some((q) => q.n === String(s.name) && Math.hypot(q.x - s.xy[0], q.y - s.xy[1]) < 16)) continue;
          seen.push({ n: String(s.name), x: s.xy[0], y: s.xy[1] });
          const pickd = own && k === startKey && ride && String(ride.pick) === String(s.name);
          const el = mk('div', 's3-sector' + (pickd ? ' s3-pick' : ''), String(s.name));
          el.setAttribute('aria-hidden', 'true');
          addLabel(el, { kind: 'sector', x: s.xy[0], y: s.xy[1], level: lvl, li, lift: .6, prio: own ? (pickd ? 84 : 60) : 26, minPpm: own ? 1.25 : 3 });
        }
      }
      for (const e of model.entrances || []) {
        if (!e.xy || !e.name || !inPlate(e.xy[0], e.xy[1])) continue;
        const shut = isClosed(e);
        const el = mk('div', 's3-ent' + (shut ? ' s3-shut' : ''), shut ? `${e.name} · closed` : e.name);
        addLabel(el, { kind: 'ent', x: e.xy[0], y: e.xy[1], level: e.level || 0, li: P.idxOf(e.level || 0), lift: 1.5, prio: shut ? 40 : 30, minPpm: routed ? 2.2 : 1.4 });
      }
      for (const p of model.pois || []) {
        if (!p.xy || !ICON[p.kind] || !inPlate(p.xy[0], p.xy[1])) continue;
        const d = mk('div', 's3-poi');
        d.innerHTML = svg(p.kind);
        d.title = p.name || p.kind;
        addLabel(d, { kind: 'poi', x: p.xy[0], y: p.xy[1], level: p.level || 0, li: P.idxOf(p.level || 0), lift: 1.5, prio: p.kind === 'tickets' ? 18 : 22, minPpm: p.kind === 'tickets' ? 5 : 3 });
      }
      // closed stairs, ramps and lifts say so where they are
      for (const c of model.connectors || []) {
        if (!isClosed(c)) continue;
        const p = c.kind === 'elevator' ? (c.xy && c.levels ? [c.xy[0], c.xy[1], c.levels[0]] : null) : c.line && c.line.length ? c.line[c.line.length >> 1] : null;
        if (!p || !inPlate(p[0], p[1])) continue;
        const el = mk('div', 's3-shutmark');
        el.innerHTML = svg('closed');
        el.append(mk('span', null, `${CONN_WORD[c.kind] || 'Way'} closed`));
        const onWay = routed && (route!.closed || []).some((x) => x.what === 'connector' || x.what === 'edge');
        addLabel(el, { kind: 'shut', x: p[0], y: p[1], level: p[2], li: P.idxOf(p[2]), lift: 2.4, prio: onWay ? 88 : 42, minPpm: onWay ? 0 : routed ? 4.5 : 1.6 });
      }
      // the route's own marks
      if (routed) {
        const rp = route!.points, a = rp[0], e = rp[rp.length - 1];
        // the start: named like the destination, on its own stem
        if (!A.same) {
          const st = mk('div', 's3-start');
          const plate = mk('div', 's3-plate2');
          if (from.kind === 'stop' && from.ref) plate.append(mk('small', null, from.noun), mk('b', null, from.ref)); else plate.append(mk('b', null, cap(from.kind === 'free' ? 'Start' : from.name)));
          if (from.sector) plate.append(mk('span', null, sectorTag(from.sector)));
          st.append(plate, mk('div', 's3-stem'), mk('div', 's3-foot'), mk('i', 's3-arrow'));
          st.setAttribute('aria-hidden', 'true');
          addLabel(st, { kind: 'start', x: a[0], y: a[1], level: a[2], lift: .5, prio: 96, always: true, ax: .5, ay: 1, yield: false, flip: true });
        }
        // the destination: the app's boarding sign
        const sign = mk('div', 's3-sign' + (to.closed ? ' s3-shut' : ''));
        const plate = mk('div', 's3-plate' + (to.ref ? '' : ' s3-text'));
        if (to.ref) plate.append(mk('small', null, to.noun), mk('b', null, to.ref)); else plate.append(mk('b', null, cap(to.name)));
        if (to.closed) plate.append(mk('em', null, 'closed'));
        else if (to.sector && !A.same) plate.append(mk('span', null, to.sector));
        sign.append(plate, mk('div', 's3-stem'), mk('div', 's3-foot'), mk('i', 's3-arrow'));
        sign.setAttribute('aria-hidden', 'true');
        // a closed destination the route cannot reach: the sign stands on the platform itself, the line ends short of it
        const at = route!.incomplete && route!.toStop && route!.toStop.xy ? [route!.toStop.xy[0], route!.toStop.xy[1], route!.toStop.level || 0] : e;
        addLabel(sign, { kind: 'sign', x: at[0], y: at[1], level: at[2], lift: .5, prio: 100, always: true, ax: .5, ay: 1, yield: false, pin: true });
        if (route!.incomplete) {
          const el = mk('div', 's3-ent s3-shut', 'The route ends here');
          addLabel(el, { kind: 'end', x: e[0], y: e[1], level: e[2], lift: 1.2, prio: 94, always: true, ay: 1.3 });
        }
        route!.steps.forEach((st, i) => {
          if (st.kind === 'walk' || st.kind === 'arrive') return;
          const p = pointAt((st.from + st.to) / 2);
          const b = mk('button', 's3-via');
          b.type = 'button';
          b.tabIndex = -1;
          b.innerHTML = svg(st.kind);
          const up = st.dir === 'up' || (st.dir == null && st.toLevel > st.level);
          if (st.toLevel != null && st.toLevel !== st.level) b.append(mk('span', null, `${up ? '↑' : '↓'} ${levelShort(P.near(st.toLevel))}`));
          if (st.warn) b.classList.add('s3-warn');
          b.setAttribute('aria-label', `Step ${i + 1}: ${st.text}`);
          b.onclick = () => { setFollow(false); select(i); };
          addLabel(b, { kind: 'via', step: i, x: p[0], y: p[1], level: p[2], lift: 3.2, prio: 90, always: true, alts: [[0, -30], [0, 30], [40, 0], [-40, 0], [0, -58], [64, -24], [-64, -24], [0, 58], [70, 20], [-70, 20]] });
        });
      }
      if (routed && !A.same) {
        const b = mk('div', 's3-beacon');
        b.innerHTML = '<span class="s3-beacon-ico"></span><div><b></b><small></small></div><i class="s3-arrow"></i>';
        b.setAttribute('aria-hidden', 'true');
        beacon = addLabel(b, { kind: 'beacon', prio: 97, always: true, yield: false });
      }
      tip = addLabel(mk('div', 's3-tip'), { kind: 'tip', prio: 98, always: true, on: false, ax: .5, ay: 1.25, yield: false, block: false, keepIn: true });
      const u = mk('div', 's3-user');
      u.append(mk('i'));
      u.setAttribute('aria-hidden', 'true');
      userLabel = addLabel(u, { kind: 'user', prio: 99, always: true, yield: false, block: false });
      // focus on one place without a route: its sign
      if (!routed && focus && focus.hit) {
        const h = focus.hit, d = describe(h);
        const sign = mk('div', 's3-sign' + (d.closed ? ' s3-shut' : ''));
        const plate = mk('div', 's3-plate' + (h.stop && h.stop.ref ? '' : ' s3-text'));
        if (h.stop && h.stop.ref) plate.append(mk('small', null, nounOf(h.stop.mode)), mk('b', null, h.stop.ref)); else plate.append(mk('b', null, d.title));
        if (d.closed) plate.append(mk('em', null, 'closed'));
        sign.append(plate, mk('div', 's3-stem'), mk('div', 's3-foot'), mk('i', 's3-arrow'));
        sign.setAttribute('aria-hidden', 'true');
        addLabel(sign, { kind: 'sign', x: h.xy[0], y: h.xy[1], level: h.level, lift: .5, prio: 100, always: true, ax: .5, ay: 1, yield: false, pin: true });
      }
      labels.forEach((L) => { if (L.kind === 'via') L.el.classList.toggle('s3-active', L.step === sel); });
    }

    // With a route the plates are solid: what lies on a lower floor under a plate cannot be seen, and its label goes too
    function underPlate(x: number, y: number, level: number) {
      if (!A.routed || pov || isolate != null) return false;
      const cy = camera.position.y, cx = camera.position.x, cz = camera.position.z;
      const ly = Yc(level) + .5;
      for (const li of A.shown) {
        if (P.levels[li].id <= level + .2 || vis(li) < .5) continue;
        const py = Yc(P.levels[li].id) + PLATE_TOP;
        const t = (py - cy) / (ly - cy);
        if (!(t > 0 && t < 1)) continue;
        if (inBox(A.box!, cx + (x - cx) * t, -(cz + (-y - cz) * t), 0)) return true;
      }
      return false;
    }
    const hits: Box4[] = [];
    const REACH: Partial<Record<LabelKind, number>> = { stop: 80, isl: 80, via: 120, sign: 130, poi: 28, sector: 60, shut: 50, end: 80, tip: 1e9 };
    function placeLabels() {
      if (labelsDirty) {
        for (const L of labels) {
          if (L.w) continue;
          L.w = L.el.offsetWidth; L.h = L.el.offsetHeight;
          if (L.kind === 'isl' && L.ends) { // also its upright form
            L.el.classList.add('s3-col');
            L.wc = L.el.offsetWidth; L.hc = L.el.offsetHeight;
            L.el.classList.remove('s3-col');
            L.wr = L.w; L.hr = L.h;
          }
        }
        labels.sort((a, b) => b.prio - a.prio);
        labelsDirty = false;
      }
      const ppm = focal() / cam.dist; // pixels per metre at the point we look at
      const routed = A.routed;
      const fp = povT > .6;
      // floor names: on the leftmost corner of each plate, kept apart from each other
      for (const L of levelLabels) {
        L.want = false;
        if (fp || vis(L.li) < .5 || (routed && isolate == null && !A.levels.has(L.li))) continue;
        const pts = L.plate && isolate == null ? L.plate : L.rim!, lift = L.plate && isolate == null ? PLATE_TOP : 0;
        L.cands = [];
        for (const p of pts) {
          const s = project(p[0], p[1], L.level, lift);
          if (!s || s[0] < free.x0 - 40 || s[0] > free.x1 || s[1] < free.y0 || s[1] > free.y1) continue;
          if (L.plate && isolate == null && underPlate(p[0], p[1], L.level)) continue; // a corner hidden under the floor above
          L.cands.push(s);
        }
        if (!L.cands.length) continue;
        L.cands.sort((a, b) => a[0] - b[0]);
        if (L.cands.length > 9) L.cands.length = 9;
        L.want = true;
      }

      hits.length = 0;
      for (const r of avoid) hits.push(r);
      const clear = (x0: number, y0: number, x1: number, y1: number) => { for (const h of hits) if (x0 < h[2] && x1 > h[0] && y0 < h[3] && y1 > h[1]) return false; return true; };
      for (const L of labels) {
        let show = L.on !== false, x0 = 0, y0 = 0, pinned = false;
        if (show && fp && (L.kind === 'level' || L.kind === 'start' || L.kind === 'ent' || L.kind === 'via')) show = false;
        if (show && fp && L.kind === 'sign' && Math.abs(L.level - pv.level) > .7) show = false; // it is on another floor
        if (show && L.kind === 'level') {
          show = false;
          if (L.want) for (const s of L.cands!) { // the leftmost corner of its plate that is free
            x0 = clamp(s[0] - 4, safe.x0, safe.x1 - L.w); y0 = clamp(s[1] - L.h / 2, safe.y0, safe.y1 - L.h);
            if (clear(x0, y0, x0 + L.w, y0 + L.h)) { show = true; break; }
          }
        }
        else if (show && L.kind === 'user') {
          show = !!user && !user.outside && user.sx != null;
          if (show) {
            const s = project(user!.sx!, user!.sy!, user!.sl!, .7);
            if (!s) show = false;
            else {
              x0 = s[0] - L.w / 2; y0 = s[1] - L.h / 2;
              const hd = user!.heading != null ? user!.heading : compassHeading;
              L.el.classList.toggle('s3-heading', hd != null);
              L.el.classList.toggle('s3-approx', user!.mode === 'approx');
              if (hd != null) {
                const r = hd * Math.PI / 180;
                const s2 = project(user!.sx! + Math.sin(r) * 4, user!.sy! + Math.cos(r) * 4, user!.sl!, .7);
                if (s2) L.el.style.setProperty('--s3-heading', (Math.atan2(s2[0] - s[0], -(s2[1] - s[1])) * 180 / Math.PI).toFixed(1) + 'deg');
              }
            }
          }
        } else if (show && L.kind === 'beacon') {
          const gd = fp ? activeGuide : null;
          show = !!gd;
          if (show) {
            const left = Math.max(0, gd!.along0 - pv.along);
            const key = gd!.step + ':' + gd!.kind + ':' + Math.round(left / 5);
            if (L.key !== key) {
              L.key = key;
              L.el.querySelector('.s3-beacon-ico')!.innerHTML = svg(gd!.icon);
              L.el.querySelector('b')!.textContent = gd!.title;
              L.el.querySelector('small')!.textContent = [gd!.sub, left < 4 ? 'here' : fmtM(left)].filter(Boolean).join(' · ');
              L.w = L.el.offsetWidth; L.h = L.el.offsetHeight;
            }
            v3.set(gd!.entry[0], Yc(gd!.entry[2]) + gd!.lift, -gd!.entry[1]).applyMatrix4(camera.matrixWorldInverse);
            const behind = v3.z > -.4;
            let sx: number, sy: number;
            if (behind) { sx = v3.x < 0 ? -1e5 : 1e5; sy = H * .42; }
            else { v3.applyMatrix4(camera.projectionMatrix); sx = (v3.x * .5 + .5) * W; sy = (-v3.y * .5 + .5) * H; }
            x0 = sx - L.w / 2; y0 = sy - L.h - 11;
            let cx = clamp(x0, safe.x0, safe.x1 - L.w), cy = clamp(y0, safe.y0, safe.y1 - L.h);
            pinned = behind || Math.abs(cx - x0) > 2 || Math.abs(cy - y0) > 2;
            const offCtl = (ax: number, ay: number) => { for (const h of avoid) if (ax < h[2] && ax + L.w > h[0] && ay < h[3] && ay + L.h > h[1]) return false; return true; };
            if (!offCtl(cx, cy)) {
              find: for (let k = 1; k <= 12; k++) for (const [dx, dy] of [[0, k * 16], [-k * 16, 0], [k * 16, 0]]) {
                const ax = clamp(cx + dx, safe.x0, safe.x1 - L.w), ay = clamp(cy + dy, safe.y0, safe.y1 - L.h);
                if (offCtl(ax, ay)) { cx = ax; cy = ay; pinned = true; break find; }
              }
            }
            x0 = cx; y0 = cy;
            if (pinned !== L.pinned) { L.pinned = pinned; L.el.classList.toggle('s3-pinned', pinned); }
            if (pinned) { // the arrow sits on the rim of the pill, on the side the thing is
              const ang = Math.atan2(sx - (x0 + L.w / 2), -(sy + 11 - (y0 + L.h / 2))), s = Math.abs(Math.sin(ang)), c = Math.abs(Math.cos(ang));
              L.el.style.setProperty('--s3-to', (ang * 180 / Math.PI).toFixed(0) + 'deg');
              L.el.style.setProperty('--s3-r', Math.round(Math.min(s > .01 ? L.w / 2 / s : 1e4, c > .01 ? L.h / 2 / c : 1e4) + 12) + 'px');
            }
          }
        } else if (show) {
          if (!L.always && L.li >= 0 && vis(L.li) < .5) show = false;
          if (show && !fp && L.minPpm && ppm < L.minPpm) show = false;
          if (show && !fp && L.kind !== 'sign' && L.kind !== 'start' && L.kind !== 'via' && L.kind !== 'tip' && L.kind !== 'end' && underPlate(L.x, L.y, L.level)) show = false;
          if (show && fp) {
            const far = Math.hypot(L.x - pv.x, L.y - pv.y) > (REACH[L.kind] || 60);
            const other = L.kind !== 'via' && L.kind !== 'sign' && L.kind !== 'tip' && Math.abs(L.level - pv.level) > .7;
            const nextUp = L.kind === 'sign' && povArriving; // where you are going next is shown even round a corner
            if (far || other || (L.kind !== 'tip' && !nextUp && hiddenFromEye(L.x, L.y, L.level))) show = false;
          }
          let s: XY | null = null;
          if (show) {
            s = project(L.x, L.y, L.level, fp && (L.kind === 'stop' || L.kind === 'isl' || L.kind === 'sector') ? 2.7 : L.lift);
            if (!s) show = false;
          }
          if (show) {
            if (L.kind === 'isl' && L.ends) { // which number is on which side, as you see it now
              const a = project(L.ends[0][0], L.ends[0][1], L.level, L.lift), b = project(L.ends[1][0], L.ends[1][1], L.level, L.lift);
              if (a && b) {
                const dx = b[0] - a[0], dy = b[1] - a[1], col = Math.abs(dy) > Math.abs(dx) * 1.6, rev = col ? dy < 0 : dx < 0;
                if (col !== L.col || rev !== L.rev) {
                  L.col = col; L.rev = rev;
                  L.el.classList.toggle('s3-col', col); L.el.classList.toggle('s3-rev', rev);
                  L.w = col ? L.wc! : L.wr!; L.h = col ? L.hc! : L.hr!;
                }
                // if its place is taken it may slide along the platform (never across it: the sides must stay true)
                const l = Math.hypot(dx, dy) || 1, ux = -dy / l, uy = dx / l;
                L.alts = [[ux * 32, uy * 32], [-ux * 32, -uy * 32], [ux * 64, uy * 64], [-ux * 64, -uy * 64]];
              }
            }
            x0 = s![0] - L.ax * L.w; y0 = s![1] - L.ay * L.h;
            const inside = s![0] >= safe.x0 && s![0] <= safe.x1 && s![1] >= safe.y0 && s![1] <= safe.y1;
            if (L.pin) {
              // kept on screen: beside its place when that is in view, else on the edge with an arrow towards it
              let cx = clamp(x0, safe.x0, safe.x1 - L.w), cy = clamp(y0, safe.y0, safe.y1 - L.h);
              pinned = !inside && (Math.abs(cx - x0) > 1 || Math.abs(cy - y0) > 1);
              if (fp && pinned && !(L.kind === 'sign' && povArriving)) show = false; // the destination stays in sight when it is next
              const offCtl = (ax: number, ay: number) => { for (const h of avoid) if (ax < h[2] && ax + L.w > h[0] && ay < h[3] && ay + L.h > h[1]) return false; return true; };
              if (!pinned && !offCtl(cx, cy)) { // its place is on screen but under a control: step aside, and point back at it
                side: for (let k = 1; k <= 8; k++) for (const [dx, dy] of [[-k * 16, 0], [k * 16, 0], [0, k * 16], [0, -k * 16]]) {
                  const tx2 = clamp(cx + dx, safe.x0, safe.x1 - L.w), ty2 = clamp(cy + dy, safe.y0, safe.y1 - L.h);
                  if (offCtl(tx2, ty2)) { pinned = true; cx = tx2; cy = ty2; break side; }
                }
              } else if (pinned && !clear(cx, cy, cx + L.w, cy + L.h)) { // slide along the edge to a free spot
                search: for (let k = 1; k <= 8; k++) for (const [dx, dy] of [[0, k * 24], [0, -k * 24], [k * 24, 0], [-k * 24, 0]]) {
                  const tx2 = clamp(cx + dx, safe.x0, safe.x1 - L.w), ty2 = clamp(cy + dy, safe.y0, safe.y1 - L.h);
                  if (clear(tx2, ty2, tx2 + L.w, ty2 + L.h)) { cx = tx2; cy = ty2; break search; }
                }
              }
              x0 = cx; y0 = cy;
              if (pinned !== L.pinned) { L.pinned = pinned; L.el.classList.toggle('s3-pinned', pinned); }
              if (pinned) L.el.style.setProperty('--s3-to', (Math.atan2(s![0] - (x0 + L.w / 2), -(s![1] - (y0 + L.h / 2))) * 180 / Math.PI).toFixed(0) + 'deg');
            } else if (!inside) show = false;
            else if (L.flip) {
              let below = false;
              x0 = clamp(x0, safe.x0, safe.x1 - L.w);
              if (y0 < safe.y0 || !clear(x0, y0, x0 + L.w, y0 + L.h)) { // taken (often by the destination sign on a short route): hang it below its point
                const yb = s![1] + 5;
                if (yb + L.h <= safe.y1 && clear(x0, yb + 2, x0 + L.w, yb + L.h)) { y0 = yb; below = true; }
              }
              y0 = clamp(y0, safe.y0, safe.y1 - L.h);
              if (L.below !== below) { L.below = below; L.el.classList.toggle('s3-below', below); }
            } else { // move it in from the edge rather than cut it
              x0 = clamp(x0, safe.x0, safe.x1 - L.w); y0 = clamp(y0, safe.y0, safe.y1 - L.h);
            }
          }
        }
        if (show && L.yield && L.kind !== 'level') {
          let ok = clear(x0, y0, x0 + L.w, y0 + L.h);
          if (!ok && L.alts) {
            for (const [dx, dy] of L.alts) {
              const ax = clamp(x0 + dx, safe.x0, safe.x1 - L.w), ay = clamp(y0 + dy, safe.y0, safe.y1 - L.h);
              if (clear(ax, ay, ax + L.w, ay + L.h)) { x0 = ax; y0 = ay; ok = true; break; }
            }
          }
          if (!ok) show = false;
        }
        if (show && L.block) hits.push([x0 - 3, y0 - 3, x0 + L.w + 3, y0 + L.h + 3]);
        if (show) L.el.style.transform = `translate(${Math.round(x0)}px,${Math.round(y0)}px)`;
        if (show !== L.shown) { L.shown = show; L.el.classList.toggle('s3-off', !show); }
      }
    }

    // ----- touch, mouse, keyboard -----
    function panBy(dx: number, dy: number) {
      const wpp = cam.dist / focal(), ca = Math.cos(cam.az), sa = Math.sin(cam.az), k = 1 / Math.max(.35, Math.cos(polOf(peel)));
      cam.tx += (-ca * dx - sa * dy * k) * wpp;
      cam.tz += (sa * dx - ca * dy * k) * wpp;
    }
    function skipIntro() {
      if (!openTimer) return;
      clearTimeout(openTimer); openTimer = 0;
      setPeel(peelHome, { dur: 700 });
    }
    function buildControls() {
      const ptrs = new Map<number, { x: number; y: number }>();
      let g: Gesture | null = null, lastTap: { t: number; x: number; y: number } | null = null;
      const two = () => { const [a, b] = [...ptrs.values()]; return { span: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }; };
      on(canvas, 'pointerdown', (e) => {
        try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
        ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        touch();
        if (pov && !demo) pausePlay(); // looking around: the walk waits (the demo has no Play button to set it off again)
        skipIntro();
        moved = true;
        tween = null;
        spin.az = spin.x = spin.z = 0;
        const now = performance.now();
        if (ptrs.size === 1) g = { mode: e.button === 2 || e.button === 1 || e.shiftKey ? 'pan' : 'orbit', moved: 0, t0: now, lt: now, vx: 0, vy: 0, drift: 0, peeled: false };
        else if (ptrs.size === 2) g = Object.assign({ mode: 'pinch' as const, moved: 99, drift: 0 }, two());
        canvas.classList.add('s3-grabbing');
      });
      on(canvas, 'pointermove', (e) => {
        const p = ptrs.get(e.pointerId);
        if (!p || !g) return;
        const dx = e.clientX - p.x, dy = e.clientY - p.y, now = performance.now();
        p.x = e.clientX; p.y = e.clientY;
        touch();
        if (g.mode === 'pinch') {
          if (ptrs.size < 2) return;
          const t = two();
          if (pov) { g.span = t.span; g.cx = t.cx; g.cy = t.cy; return; }
          cam.dist *= g.span / t.span;
          panBy(t.cx - g.cx, t.cy - g.cy);
          g.drift += Math.abs(t.cx - g.cx) + Math.abs(t.cy - g.cy);
          if (g.drift > 24) setFollow(false);
          g.span = t.span; g.cx = t.cx; g.cy = t.cy;
        } else {
          g.moved += Math.abs(dx) + Math.abs(dy);
          if (g.moved <= 6) return;
          const dtm = Math.max(1, now - g.lt);
          g.vx = lerp(g.vx, dx / dtm, .6); g.vy = lerp(g.vy, dy / dtm, .6); g.lt = now;
          if (pov) {
            if (pv.device) setDeviceLook(false);
            pv.yaw -= dx * .0042; pv.pitch = clamp(pv.pitch + dy * .0036, -1.1, 1);
          } else if (g.mode === 'orbit') { // sideways turns the station, up and down peels the floors apart
            cam.az -= dx * .008;
            if (dy) { g.peeled = true; setPeel(peelTo - dy * .0042, { live: true }); }
          } else { panBy(dx, dy); setFollow(false); }
        }
        limit(cam);
        request();
      });
      const up = (e: PointerEvent) => {
        if (!ptrs.has(e.pointerId)) return;
        ptrs.delete(e.pointerId);
        const now = performance.now();
        if (ptrs.size === 1) { g = { mode: 'orbit', moved: 99, t0: now, lt: now, vx: 0, vy: 0, drift: 0, peeled: g && g.peeled }; return; }
        if (ptrs.size) return;
        canvas.classList.remove('s3-grabbing');
        if (!g) return;
        if (g.peeled) { applyShape(true); request(); }
        if (g.mode !== 'pinch' && g.moved <= 6 && now - g.t0 < 500 && e.type === 'pointerup') {
          const dbl = lastTap && now - lastTap.t < 330 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30;
          lastTap = dbl ? null : { t: now, x: e.clientX, y: e.clientY };
          onTap(e.clientX, e.clientY, dbl);
        } else if (!pov && g.mode !== 'pinch' && now - g.lt < 70 && !reducedMotion()) {
          if (g.mode === 'orbit') spin.az = clamp(-g.vx * .008, -.006, .006); // a flick turns it on, but never into a spin
          else {
            const wpp = cam.dist / focal(), ca = Math.cos(cam.az), sa = Math.sin(cam.az), k = 1 / Math.max(.35, Math.cos(polOf(peel)));
            spin.x = (-ca * g.vx - sa * g.vy * k) * wpp; spin.z = (sa * g.vx - ca * g.vy * k) * wpp;
          }
          request();
        }
        g = null;
      };
      on(canvas, 'pointerup', up);
      on(canvas, 'pointercancel', up);
      on(canvas, 'wheel', (e) => {
        e.preventDefault();
        touch();
        skipIntro();
        moved = true;
        tween = null;
        const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        if (pov) { povMove(-clamp(d, -240, 240) * .03); return; }
        cam.dist *= Math.exp(clamp(d, -240, 240) * (e.ctrlKey ? .01 : .0016));
        limit(cam);
        request();
      }, { passive: false });
      on(canvas, 'contextmenu', (e) => e.preventDefault());
    }
    // forwards / backwards on foot: along the route, or straight ahead when there is none
    function povMove(m: number) {
      pausePlay();
      if (!pv.free && A.routed) { setFollow(false); pv.walk = null; PL.by = 'scrub'; pv.along = clamp(pv.along + m, 0, R!.A[R!.A.length - 1]); }
      else {
        const b = pv.bearing + pv.yaw, x = pv.tx + Math.sin(b) * m, y = pv.ty + Math.cos(b) * m;
        if (areaAt(P, P.idxOf(pv.tl), x, y)) { pv.tx = x; pv.ty = y; }
      }
      touch();
      request();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); if (listMode) toggleList(); else api.close(); return; }
      if (demo && e.key !== 'Tab') return; // the demo plays by itself: no key walks or stops it
      if (e.key === 'Tab') { // keep the focus inside the dialog
        const f = [...root.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), [role="slider"], input, canvas')].filter((el) => el.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        const cur = (root.getRootNode() as Document | ShadowRoot).activeElement || document.activeElement;
        if (e.shiftKey && cur === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
        return;
      }
      if (e.target !== canvas || !self.ready) return;
      const k = e.key;
      let used = true;
      tween = null;
      if (pov) {
        if (k === 'ArrowLeft') pv.yaw -= .14;
        else if (k === 'ArrowRight') pv.yaw += .14;
        else if (k === 'ArrowUp') povMove(5);
        else if (k === 'ArrowDown') povMove(-5);
        else if (k === '0') recentre();
        else if (k === ' ' && A.routed && !A.same && !pv.free) { setPlay(!PL.on, { user: true }); e.preventDefault(); return; }
        else used = false;
        if (used) { e.preventDefault(); pausePlay(); touch(); request(); }
        return;
      }
      skipIntro();
      if (k === 'ArrowLeft') cam.az += .2;
      else if (k === 'ArrowRight') cam.az -= .2;
      else if (k === 'ArrowUp') setPeel(peelTo + .12, { dur: 300 });
      else if (k === 'ArrowDown') setPeel(peelTo - .12, { dur: 300 });
      else if (k === '+' || k === '=') cam.dist *= .8;
      else if (k === '-' || k === '_') cam.dist *= 1.25;
      else if (k === '0') { moved = false; flyTo(currentPose(), 700); }
      else used = false;
      if (used) { e.preventDefault(); limit(cam); touch(); request(); }
    }

    // ----- tapping the model -----
    function pick(cx: number, cy: number): Hit | null {
      const r = canvas.getBoundingClientRect();
      ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const o = raycaster.ray.origin, d = raycaster.ray.direction;
      const clipped = A.routed && !pov && isolate == null;
      let ground: Hit | null = null;
      for (let li = P.n - 1; li >= 0; li--) {
        if (vis(li) < .4) continue;
        const t = (Yc(P.levels[li].id) - o.y) / d.y;
        if (!(t > 0)) continue;
        const x = o.x + d.x * t, y = -(o.z + d.z * t);
        if (clipped && !inBox(A.box!, x, y, 0)) continue;
        const a = areaAt(P, li, x, y);
        if (a) return { li, level: P.levels[li].id, xy: [x, y], area: a };
        if (!ground && (isolate === li || clipped || (isolate == null && P.levels[li].id === P.near(0)))) ground = { li, level: P.levels[li].id, xy: [x, y], area: null };
        if (clipped) break; // a plate is solid: you cannot tap through it
      }
      return ground;
    }
    function describe(hit: Hit): Described {
      const lv = P.levels[hit.li];
      const where = `${lv.name} · level ${levelShort(lv.id)}`;
      const a = hit.area;
      const shutThing = hit.stop && isClosed(hit.stop) ? hit.stop : a && isClosed(a.src) ? a.src : null;
      const closed = !!shutThing, note = closed ? closedNote(shutThing) || closedNote(a && a.src) : '';
      const out = (o: { title: string; sub: string; icon: string }): Described => Object.assign(o, { closed, note });
      if (hit.stop) return out({ title: stopTitle(hit.stop), sub: hit.stop.ref ? `${hit.stop.name} · ${lv.name}` : where, icon: 'arrive' });
      if (hit.entrance) return out({ title: hit.entrance.name || 'Entrance', sub: where, icon: 'arrive' });
      if (!a) return out({ title: lv.name, sub: `Level ${levelShort(lv.id)}`, icon: 'layers' });
      const refs = (a.src.refs || []).filter(Boolean);
      if (a.kind === 'platform' && refs.length) {
        const st = (model.stops || []).find((s) => a.keys.includes(pkey(s.ref)) && P.idxOf(s.level || 0) === hit.li);
        const noun = nounOf(st ? st.mode : 'train');
        const title = refs.length === 1 ? `${noun} ${refs[0]}` : `${noun}s ${refs.slice(0, -1).join(', ')} and ${refs[refs.length - 1]}`;
        return out({ title, sub: a.src.name ? `${a.src.name} · ${lv.name}` : where, icon: 'arrive' });
      }
      const title = a.src.name || (a.kind === 'room' ? 'Shop or office' : a.kind === 'plaza' ? 'Open ground' : a.kind === 'platform' ? 'Platform' : lv.name);
      return out({ title, sub: where, icon: a.kind === 'room' ? 'lockers' : 'layers' });
    }
    function showPick(hit: Hit) {
      picked = hit;
      const d = describe(hit);
      tip!.el.textContent = d.closed ? `${d.title} · closed` : d.title;
      tip!.w = 0; labelsDirty = true;
      tip!.x = hit.xy[0]; tip!.y = hit.xy[1]; tip!.level = hit.level; tip!.lift = hit.area && hit.area.topH > 1 ? hit.area.topH * SH.Hs : 1;
      tip!.on = true;
      clearTimeout(tipTimer);
      labels.forEach((L) => { if (L.kind === 'stop') L.el.classList.toggle('s3-picked', !!hit.stop && L.stop === hit.stop); });
      if (!A.routed) {
        dropHighlight(pickHl);
        pickHl = hit.area && hit.area.kind !== 'plaza' && !d.closed ? highlight(hit.area, T.route, theme === 'dark' ? .38 : .26) : null;
        applyOpacity();
        fillExplore(d);
      } else {
        tipTimer = setTimeout(() => { tip!.on = false; request(); }, 2600);
        if (d.closed && d.note) toast(d.note, 4500);
      }
      say(`${d.title}${d.closed ? ', closed' : ''}. ${d.sub}`);
      emit('pick', { title: d.title, level: hit.level, xy: hit.xy.slice() as XY, ll: toLngLat(model, hit.xy), stop: hit.stop || null, area: hit.area ? hit.area.src : null, endpoint: endOf(hit) });
      touch();
      request();
    }
    const endOf = (hit: Hit): StationRouteEndpoint => (hit.stop && hit.stop.ref ? { stop: { uic: hit.stop.uic, ref: hit.stop.ref } } : hit.entrance && hit.entrance.name ? { entrance: hit.entrance.name } : { xy: hit.xy.slice() as XY, level: hit.level });
    function onTap(x: number, y: number, dbl?: boolean | null) {
      const hit = pick(x, y);
      if (pov) {
        if (pv.free && hit && hit.area && hit.area.kind !== 'room') { pv.tx = hit.xy[0]; pv.ty = hit.xy[1]; pv.tl = hit.level; touch(); request(); }
        else if (hit && hit.area) showPick(hit);
        return;
      }
      if (dbl) {
        const pose = Object.assign({}, cam, { dist: cam.dist * .5 });
        if (hit) { pose.tx = hit.xy[0]; pose.tz = -hit.xy[1]; pose.tl = hit.level; }
        flyTo(pose, 450);
        return;
      }
      if (hit && (hit.area || opts.pickAnywhere)) showPick(hit);
      else if (hit) emit('pick', { title: '', level: hit.level, xy: hit.xy.slice() as XY, ll: toLngLat(model, hit.xy), stop: null, area: null, endpoint: endOf(hit) });
      else if (tip && tip.on) { tip.on = false; request(); }
    }

    // ----- the rail: street-level view, the floors, and how far they are peeled apart -----
    function buildLevels() {
      levelsEl.textContent = '';
      const list = A.routed ? A.shown.map((i) => P.levels[i]) : P.levels.filter((lv) => lv.areas.length);
      levelsEl.hidden = false;
      const ctl = (cls: string, icon: string, label: string, fn: () => void) => {
        const b = mk('button', cls);
        b.type = 'button';
        b.innerHTML = svg(icon);
        b.title = label;
        b.setAttribute('aria-label', label);
        b.onclick = fn;
        levelsEl.append(b);
        return b;
      };
      ctl('s3-povbtn', 'eye', 'Switch to street-level view', () => setPov(!pov)).setAttribute('aria-pressed', 'false');
      ctl('s3-lookbtn s3-povonly', 'phone', 'Look where I’m facing: turn the phone to look around', () => setDeviceLook(!pv.device)).setAttribute('aria-pressed', 'false');
      ctl('s3-povonly', 'centre', 'Look the way the route goes', recentre);
      if (list.length > 1) {
        levelsEl.append(mk('hr', 's3-modelonly'));
        const box = mk('div', 's3-floorlist s3-modelonly');
        for (const lv of list.slice().reverse()) {
          const b = mk('button', A.routed ? 's3-on-route' : '', levelShort(lv.id));
          b.type = 'button';
          b.dataset.li = lv.i as unknown as string;
          b.title = lv.name;
          b.setAttribute('aria-label', `${lv.name}, level ${lv.id}: show only this floor`);
          b.setAttribute('aria-pressed', 'false');
          b.onclick = () => setIsolate(isolate === lv.i ? null : lv.i);
          box.append(b);
        }
        levelsEl.append(box);
      }
      // the peel: one control for the camera angle and the gap between the floors. Bottom = flat plan.
      levelsEl.append(mk('hr', 's3-modelonly'));
      peelEl = mk('div', 's3-peel s3-modelonly');
      peelEl.tabIndex = 0;
      peelEl.setAttribute('role', 'slider');
      peelEl.setAttribute('aria-orientation', 'vertical');
      peelEl.setAttribute('aria-label', 'Peel the floors apart');
      peelEl.setAttribute('aria-valuemin', '0');
      peelEl.setAttribute('aria-valuemax', '100');
      peelEl.title = 'Peel the floors apart, or lay them flat';
      peelEl.innerHTML = `${svg('layers')}<span class="s3-peel-track"><i></i></span>${svg('flat')}`;
      const trackEl = peelEl.querySelector('.s3-peel-track')!;
      let dragging = false;
      const at = (e: PointerEvent) => { const r = trackEl.getBoundingClientRect(); return clamp(1 - (e.clientY - r.top - 13) / Math.max(1, r.height - 26), 0, 1); };
      peelEl.onpointerdown = (e) => {
        dragging = true;
        try { peelEl!.setPointerCapture(e.pointerId); } catch (err) {}
        skipIntro(); touch();
        setPeel(at(e), { live: true });
        e.preventDefault();
      };
      peelEl.onpointermove = (e) => { if (dragging) { touch(); setPeel(at(e), { live: true }); } };
      peelEl.onpointerup = peelEl.onpointercancel = () => {
        if (!dragging) return;
        dragging = false;
        applyShape(true);
        if (!moved) flyTo(currentPose(), 600);
        say(peelEl!.getAttribute('aria-valuetext'));
        request();
      };
      peelEl.onkeydown = (e) => {
        const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? .1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -.1 : e.key === 'Home' ? -1 : e.key === 'End' ? 1 : 0;
        if (!d) return;
        e.preventDefault(); e.stopPropagation();
        skipIntro();
        setPeel(peelTo + d, { dur: 350 });
        if (!moved) flyTo(currentPose(), 500);
      };
      levelsEl.append(peelEl);
      syncPeel();
      syncLevels();
      syncPov();
    }
    function syncLevels() {
      for (const b of levelsEl.querySelectorAll<HTMLElement>('button[data-li]')) b.setAttribute('aria-pressed', String(+b.dataset.li! === isolate));
    }
    function setIsolate(li: number | null) {
      skipIntro();
      isolate = li;
      syncLevels();
      setTargets();
      setFollow(false);
      flyTo(currentPose(), 850);
      const name = li == null ? 'All floors' : P.levels[li].name;
      if (li != null) toast(`${name} only. Tap ${levelShort(P.levels[li].id)} again for all floors.`, 2600);
      say(li == null ? 'Showing all floors' : `Showing only ${name}`);
      touch();
    }
    // ----- the sheet: steps of the route, or what was tapped -----
    const levelName = (level: number) => P.levels[P.idxOf(level)].name;
    const prefs = (): RoutePrefs => Object.assign({}, opts.prefs, day ? { date: day } : null);
    const placeName = (s: string) => cap(String(s).replace(/^the /, ''));
    // What a floor is called on this walk: the place the route uses there (the model's level names are generic)
    function floorNames() {
      const names = new Map<number, string>();
      if (!A.routed) return names;
      const w = P.levels.map(() => new Map<string, number>());
      const add = (level: number, name: string, len: number) => { if (!name) return; for (const li of new Set(P.bracket(level))) { if (Math.abs(P.levels[li].id - level) > .3) continue; w[li].set(name, (w[li].get(name) || 0) + len); } };
      for (const st of route!.steps) {
        if (st.kind === 'walk' && st.place) add(st.level, placeName(st.place), Math.max(2, st.len || 0));
        else if (st.kind !== 'walk' && st.kind !== 'arrive' && st.place && st.toLevel != null) add(st.toLevel, placeName(st.place), 1);
      }
      // where the router names no place, the named ground the route crosses (a deck, a square) does
      const rp = route!.points;
      for (let i = 0; i < rp.length - 1; i++) {
        const p = rp[i], q = rp[i + 1], br = P.bracket(p[2]);
        if (br[0] !== br[1] || Math.abs(q[2] - p[2]) > 1e-3) continue;
        const ar = areaAt(P, br[0], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
        if (ar && ar.kind !== 'platform' && ar.kind !== 'room' && ar.src.name) add(p[2], placeName(ar.src.name), Math.hypot(q[0] - p[0], q[1] - p[1]) * .5);
      }
      const from = endInfo(fromEnd, 'from'), to = endInfo(toEnd, 'to');
      if (from.kind === 'stop') add(route!.points[0][2], cap(from.name), 1);
      if (to.kind === 'stop' && !route!.incomplete) add(route!.points[route!.points.length - 1][2], cap(to.name), 1);
      w.forEach((m, li) => {
        if (!m.size) return;
        const all = [...m.entries()];
        const plats = all.filter(([n]) => /^Platform \S+$/.test(n)).sort((a, b) => a[0].slice(9).localeCompare(b[0].slice(9), undefined, { numeric: true })), other = all.filter(([n]) => !/^Platform \S+$/.test(n)).sort((a, b) => b[1] - a[1]);
        if (other.length && other[0][1] > 2) names.set(li, other[0][0]); // a place the route really walks through
        else if (plats.length > 1) names.set(li, plats.length === 2 ? `Platforms ${plats[0][0].slice(9)} and ${plats[1][0].slice(9)}` : 'Platforms');
        else if (plats.length) names.set(li, plats[0][0]);
        // a stop letter alone does not name a floor: the model's own name for it is better
      });
      return names;
    }
    function buildSheet() {
      sheetEl.textContent = '';
      sheetEl.hidden = false;
      sheetEl.classList.remove('s3-list');
      listMode = false;
      stepsEl = navEl = scrubEl = playBtn = scrubRow = null;
      exploreCard = exploreActions = exploreEndsEl = exploreFrom = null;
      if (A.routed && A.same) buildSame();
      else if (A.routed) buildSteps();
      else buildExplore();
      buildSubtitle();
      sizeSheet();
    }
    // The sheet is as tall as the card that is showing, so the plan keeps the room
    function sizeSheet() {
      if (!sheetEl) return;
      if (stepsEl) {
        const cur = stepsEl.children[sel + 1];
        stepsEl.style.height = !listMode && cur && cur.firstElementChild ? (cur.firstElementChild as HTMLElement).offsetHeight + 'px' : '';
      }
      root.style.setProperty('--s3-sheet-h', (sheetEl.hidden ? 0 : sheetEl.offsetHeight) + 'px');
      if (self.ready || renderer) layout();
    }
    function buildSubtitle() {
      if (A.routed && A.same) { subEl.textContent = route!.steps[0] ? route!.steps[0].text : 'You are there'; return; }
      if (A.routed) {
        const from = endInfo(fromEnd, 'from'), to = endInfo(toEnd, 'to');
        subEl.textContent = `${cap(from.name)} to ${to.kind === 'stop' ? lowName(to) : to.name} · ${fmtMin(route!.seconds)}`;
      } else subEl.textContent = 'Station plan in 3D'; // the focus card already says what is picked
    }
    function card(iconName: string, iconCls: string, title: string, count?: string) {
      const c = mk('div', 's3-card');
      const ico = mk('span', 's3-ico ' + (iconCls || ''));
      ico.innerHTML = svg(iconName);
      const txt = mk('div', 's3-txt');
      const t = mk('div', 's3-step-title', title);
      const meta = mk('div', 's3-meta');
      txt.append(t, meta);
      c.append(ico, txt);
      if (count) c.append(mk('span', 's3-count', count));
      return { el: c, ico, title: t, meta, txt };
    }
    function tag(cls: string, iconName: string | null, text: string) {
      const t = mk('span', 's3-tag ' + (cls || ''));
      if (iconName) t.innerHTML = svg(iconName);
      t.append(mk('span', null, text));
      return t;
    }
    function note(kind: 'warn' | 'info', text: string) { // a line that must be read: orange for "not as you expect", grey for "good to know"
      const n = mk('div', 's3-note ' + (kind === 'warn' ? 's3-warnnote' : 's3-infonote'));
      n.innerHTML = svg(kind === 'warn' ? 'warn' : 'info');
      n.append(mk('span', null, text));
      if (kind === 'warn') n.setAttribute('role', 'note');
      return n;
    }
    // What the station has to announce (works, closures): said once, on the first card, folded away when it is long
    function noticesBlock(list: StationNotice[]) {
      if (!list.length) return null;
      if (list.length === 1 && list[0].text.length <= 64) return note('info', list[0].text);
      const wrap = mk('div', 's3-noticewrap');
      const b = mk('button', 's3-notices');
      b.type = 'button';
      b.innerHTML = svg('info');
      b.append(mk('span', null, list.length === 1 ? 'A notice for this station' : `${list.length} notices for this station`), mk('u', null, 'Show'));
      b.setAttribute('aria-expanded', 'false');
      const box = mk('div', 's3-noticelist');
      box.hidden = true;
      for (const n of list) box.append(note('info', n.text));
      b.onclick = (e) => {
        e.stopPropagation();
        box.hidden = !box.hidden;
        b.setAttribute('aria-expanded', String(!box.hidden));
        b.lastElementChild!.textContent = box.hidden ? 'Show' : 'Hide';
        sizeSheet();
      };
      wrap.append(b, box);
      return wrap;
    }
    const stationNotices = (): StationNotice[] => { try { return router && router.notices ? router.notices(model, day) || [] : []; } catch (e) { return []; } };
    // On an island with two numbers: which side is yours as you arrive?
    function arriveSide() {
      if (!A.routed || A.same || route!.incomplete) return '';
      const to = endInfo(toEnd, 'to'), area = endArea('to');
      if (!area || !to.ref || area.keys.length !== 2) return '';
      const rp = route!.points, e = rp[rp.length - 1];
      for (let i = rp.length - 2; i >= 0; i--) {
        const d = Math.hypot(e[0] - rp[i][0], e[1] - rp[i][1]);
        if (d < 1.5) continue;
        const s = sideOf(area, to.ref, e[0], e[1], (e[0] - rp[i][0]) / d, (e[1] - rp[i][1]) / d);
        return s ? `${to.ref} is the edge on your ${s}` : '';
      }
      return '';
    }
    function arriveTitle(inSentence?: boolean) {
      const to = endInfo(toEnd, 'to');
      if (route!.incomplete) return inSentence ? 'the route ends: the way on is closed' : 'The route ends here: the way on is closed';
      const name = to.kind === 'stop' ? lowName(to) : to.name;
      return inSentence ? `arrive at ${name}` : `You’re at ${name}`;
    }
    function arriveLine() {
      const to = endInfo(toEnd, 'to');
      return [arriveSide(), to.closed ? 'closed' : to.sector ? sectorTag(to.sector) : to.reach ? `at sector ${to.reach}` : ''].filter(Boolean).join(' · ');
    }
    const done = () => { emit('done', { route }); api.close(); };

    // "Where to ride": the walk from every sector of the platform you arrive on, and the one that is quickest
    function rideBlock() {
      if (!ride) return null;
      const t = ride.times, box = mk('div', 's3-ride');
      const best = t.sectors.find((s) => String(s.name) === String(t.best)) || t.sectors[0];
      const cur = t.sectors.find((s) => String(s.name) === String(ride!.pick));
      const off = (s: StationRouteSectorTime | undefined) => (s && s.via ? `You step off at ${CONN_NOUN[s.via] || 'the way down'}.` : 'You step off close to where you go.');
      let line: string;
      if (t.spreadSeconds < 20) line = 'Ride anywhere: every sector is about as close.';
      else if (cur && String(cur.name) !== String(best.name)) line = `From sector ${cur.name}. Sector ${best.name} is ${fmtSec(Math.max(10, cur.seconds - best.seconds))} quicker.`;
      else line = `Ride in sector ${best.name}. ${off(best)}`;
      box.append(mk('p', null, line));
      const many = t.sectors.length > 6; // two rows then, so every sector stays big enough to tap
      const row = mk('div', 's3-sectors' + (many ? '' : ' s3-stack'));
      row.style.setProperty('--s3-cols', String(many ? Math.ceil(t.sectors.length / 2) : t.sectors.length));
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', 'Walking time from each sector. Choose yours to start the route there.');
      for (const s of t.sectors) {
        const b = mk('button', (String(s.name) === String(best.name) ? 's3-best' : '') + (s.warn ? ' s3-warn' : ''));
        b.type = 'button';
        b.append(mk('b', null, String(s.name)), mk('span', null, fmtClock(s.seconds)));
        b.setAttribute('aria-pressed', String(String(s.name) === String(ride.pick)));
        b.setAttribute('aria-label', `Sector ${s.name}: ${fmtMin(s.seconds)}${String(s.name) === String(best.name) ? ', the quickest' : ''}${s.via ? ', by ' + CONN_NOUN[s.via] : ''}`);
        b.onclick = (e) => { e.stopPropagation(); chooseSector(String(s.name)); };
        row.append(b);
      }
      box.append(row);
      return box;
    }

    function buildSteps() {
      const n = route!.steps.length;
      const from = endInfo(fromEnd, 'from'), to = endInfo(toEnd, 'to');
      const grab = mk('button', 's3-grab');
      grab.type = 'button';
      grab.setAttribute('aria-label', 'Show all steps as a list');
      grab.setAttribute('aria-expanded', 'false');
      grab.onclick = toggleList;
      stepsEl = mk('ol', 's3-steps');
      stepsEl.setAttribute('aria-label', 'Walking directions');
      // overview
      {
        const li = mk('li', 's3-step');
        li.dataset.i = -1 as unknown as string;
        const c = card('walk', 's3-k-route', `To ${to.kind === 'stop' ? to.name : to.name}`);
        c.meta.append(mk('span', null, `${fmtMin(route!.seconds)} · ${fmtM(route!.length)}`));
        const seq: number[] = [];
        for (const st of route!.steps) {
          for (const l of [st.level, st.toLevel]) {
            if (l == null) continue;
            const i = P.idxOf(l);
            if (Math.abs(P.levels[i].id - l) > .3) continue; // on a slope between two floors
            if (seq[seq.length - 1] !== i) seq.push(i);
          }
        }
        if (seq.length > 1) {
          const names = floorNames();
          const flow = mk('span', 's3-flow');
          flow.setAttribute('aria-label', 'Floors: ' + seq.map((i) => names.get(i) || P.levels[i].name).join(', then '));
          seq.forEach((i, k) => {
            if (k) flow.insertAdjacentHTML('beforeend', svg(i > seq[k - 1] ? 'up' : 'down'));
            const t = tag('', null, levelShort(P.levels[i].id));
            t.title = names.get(i) || P.levels[i].name;
            flow.append(t);
          });
          c.meta.append(flow);
        }
        if (routeFromExplore) {
          const b = mk('button', 's3-tag s3-here s3-end', 'End route');
          b.type = 'button';
          b.onclick = () => { route = null; fromEnd = toEnd = null; focus = null; ride = null; routeFromExplore = false; exploreEnds = { from: null, to: null }; rebuild(); };
          c.meta.append(b);
        }
        // what the traveller has to know before setting off, most important first
        if (route!.notice) c.txt.append(note('warn', route!.notice));
        else if (to.closed && to.note) c.txt.append(note('warn', to.note));
        if (from.closed && from.note && !(route!.notice || '').includes(from.note)) c.txt.append(note('warn', from.note));
        if (from.far) c.txt.append(note('info', `${from.dist > FAR_M ? `You’re about ${fmtFar(from.dist)} from here. ` : ''}This plan shows the last stretch, from ${from.name}.`));
        else if (from.kind === 'free' && from.dist > 15) c.txt.append(note('info', `The route starts ${fmtFar(from.dist)} from where you are, at the nearest path in this plan.`));
        if (to.far) c.txt.append(note('info', `The plan ends ${fmtFar(to.dist)} before ${to.name}.`));
        const rb = rideBlock();
        if (rb) c.txt.append(rb);
        else if (from.assumed && from.kind === 'stop') c.txt.append(note('info', `${cap(from.assumed)} of ${lowName(from)}.`));
        const used = route!.notice || '';
        const nb = noticesBlock(stationNotices().filter((nt) => nt.text && !used.includes(nt.text) && !(to.note && to.note === nt.text)));
        if (nb) c.txt.append(nb);
        li.append(c.el);
        stepsEl.append(li);
      }
      route!.steps.forEach((st, i) => {
        const li = mk('li', 's3-step');
        li.dataset.i = i as unknown as string;
        const climb = st.kind !== 'walk' && st.kind !== 'arrive';
        const arrive = st.kind === 'arrive';
        const c = card(arrive && to.closed ? 'closed' : st.kind, arrive ? (to.closed ? 's3-k-warn' : 's3-k-arrive') : climb ? 's3-k-level' : '', arrive && !route!.incomplete && to.kind === 'stop' ? `Arrive at ${lowName(to)}` : arrive && route!.incomplete ? 'The route ends here: the way on is closed' : st.text, `${i + 1} of ${n}`);
        if (arrive) {
          if (to.sector && !to.closed) c.meta.append(tag('s3-tag-sector', null, sectorTag(to.sector)));
          else if (to.reach && !to.closed) c.meta.append(tag('', null, `You get onto it at sector ${to.reach}`));
          const side = arriveSide();
          if (side) c.meta.append(tag('', null, side));
          if (!to.sector && !to.reach && !side) c.meta.append(tag('', null, placeName(levelName(st.level))));
          if (to.closed) c.txt.append(note('warn', to.note || route!.notice || `${cap(to.name)} is closed.`));
        } else if (climb && st.toLevel != null && st.toLevel !== st.level) {
          c.meta.append(tag('s3-tag-level', st.dir === 'up' || (st.dir == null && st.toLevel > st.level) ? 'up' : 'down', st.place ? placeName(st.place) : levelName(st.toLevel)));
        } else c.meta.append(tag('', null, st.place ? placeName(st.place) : levelName(st.level)));
        if (st.seconds >= 8) c.meta.append(mk('span', null, fmtSec(st.seconds)));
        if (st.warn) c.meta.append(tag('s3-tag-warn', null, 'Not as you asked'));
        if (!arrive) {
          const here = mk('button', 's3-tag s3-here');
          here.type = 'button';
          here.innerHTML = svg('here') + '<span>I’m here</span>';
          here.setAttribute('aria-pressed', 'false');
          here.setAttribute('aria-label', `I’m here: step ${i + 1}`);
          c.meta.append(here);
        }
        li.append(c.el);
        stepsEl!.append(li);
      });
      // the list is thrown away with every rebuild: its handlers go with it
      stepsEl.onclick = (e) => {
        const li = (e.target as HTMLElement).closest<HTMLElement>('.s3-step');
        if (!li) return;
        const i = +li.dataset.i!;
        if ((e.target as HTMLElement).closest('.s3-here[aria-pressed]') && i >= 0) { pausePlay(); setManual(i); return; }
        if ((e.target as HTMLElement).closest('button')) return;
        pausePlay();
        setFollow(false);
        if (listMode) { toggleList(); select(i); } else select(i);
      };
      stepsEl.onscroll = () => {
        if (listMode || progScroll) return;
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
          if (listMode || progScroll || !stepsEl) return;
          const w = (stepsEl.firstElementChild as HTMLElement).offsetWidth || 1;
          const i = Math.round(stepsEl.scrollLeft / w) - 1;
          if (i !== sel) { pausePlay(); setFollow(false); select(i, { fromScroll: true }); }
        }, 90);
      };
      navEl = mk('div', 's3-nav');
      const prev = mk('button', 's3-prev');
      prev.type = 'button';
      prev.innerHTML = svg('prev');
      prev.setAttribute('aria-label', 'Previous step');
      prev.onclick = () => { pausePlay(); setFollow(false); select(sel - 1); };
      const dots = mk('div', 's3-dots');
      dots.setAttribute('aria-hidden', 'true');
      for (let i = 0; i <= n; i++) dots.append(mk('i'));
      const next = mk('button', 's3-next');
      next.type = 'button';
      next.innerHTML = '<span></span>' + svg('next');
      next.onclick = () => { if (sel >= n - 1) { done(); return; } pausePlay(); setFollow(false); select(sel + 1); };
      navEl.append(prev, dots, next);
      scrubEl = mk('input', 's3-scrub');
      scrubEl.type = 'range';
      scrubEl.min = 0; scrubEl.max = Math.round(R!.A[R!.A.length - 1] * 10) / 10; scrubEl.step = .5; scrubEl.value = 0;
      scrubEl.setAttribute('aria-label', 'Walk along the route');
      scrubEl.oninput = () => {
        pausePlay(); setFollow(false);
        pv.walk = null; PL.ride = null; PL.by = 'scrub';
        // the slider moves in half metres: its last notch is the end of the route
        pv.along = +scrubEl!.value >= +scrubEl!.max - .26 ? R!.A[R!.A.length - 1] : +scrubEl!.value;
        touch(); request();
      };
      // like a player: the walk plays by itself, or you pull it along
      scrubRow = mk('div', 's3-scrubrow');
      scrubRow.hidden = !pov;
      playBtn = mk('button', 's3-play');
      playBtn.type = 'button';
      playBtn.onclick = () => setPlay(!PL.on, { user: true });
      scrubRow.append(playBtn, scrubEl);
      sheetEl.append(grab, scrubRow, stepsEl, navEl);
      syncPlay();
      syncSteps({});
    }
    // Start and destination are one place (a change on the same platform): nothing to walk, and the card says so
    function buildSame() {
      const to = endInfo(toEnd, 'to');
      const box = mk('div', 's3-explore');
      const c = card(to.closed ? 'closed' : 'check', to.closed ? 's3-k-warn' : 's3-k-done', (route!.steps[0] && route!.steps[0].text) || `You’re at ${lowName(to)}`);
      c.meta.textContent = /^stay/i.test((route!.steps[0] && route!.steps[0].text) || '') ? 'No walk: your next departure leaves from the platform you arrive on.' : 'No walk: it is where you already are.';
      if (to.closed) c.txt.append(note('warn', to.note || route!.notice || `${cap(to.name)} is closed.`));
      else if (route!.notice) c.txt.append(note('warn', route!.notice));
      const actions = mk('div', 's3-actions s3-one');
      const ok = mk('button', 's3-primary', 'Done');
      ok.type = 'button';
      ok.onclick = done;
      actions.append(ok);
      box.append(c.el, actions);
      sheetEl.append(box);
    }
    function syncSteps(o: SelectOpts) {
      if (!stepsEl) return;
      const n = route!.steps.length, items = [...stepsEl.children] as HTMLElement[];
      items.forEach((li, k) => {
        const i = k - 1;
        if (i === sel) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
        li.classList.toggle('s3-done', i >= 0 && userStep > i);
        const here = li.querySelector('.s3-here[aria-pressed]');
        if (here) {
          const on = userStep === i;
          here.setAttribute('aria-pressed', String(on));
          here.lastElementChild!.textContent = on ? 'You’re here' : 'I’m here';
        }
      });
      [...navEl!.querySelector('.s3-dots')!.children].forEach((d, k) => { d.classList.toggle('s3-on', k === sel + 1); d.classList.toggle('s3-you', userStep >= 0 && k === userStep + 1 && k !== sel + 1); });
      const prev = navEl!.querySelector<HTMLButtonElement>('.s3-prev')!, next = navEl!.querySelector('.s3-next')!;
      prev.disabled = sel < 0;
      const last = sel >= n - 1;
      next.classList.toggle('s3-donebtn', last);
      next.firstElementChild!.textContent = sel < 0 ? 'Start' : last ? 'Done' : 'Next';
      next.setAttribute('aria-label', sel < 0 ? 'Start: first step' : last ? 'Done: close the station view' : 'Next step');
      sizeSheet();
      if (o.fromScroll) return;
      const cur = items[sel + 1];
      if (listMode) { if (cur) cur.scrollIntoView({ block: 'nearest' }); return; }
      const left = (items[0].offsetWidth || 0) * (sel + 1);
      if (Math.abs(stepsEl.scrollLeft - left) > 2) {
        progScroll++;
        const mine = progScroll;
        stepsEl.scrollTo({ left, behavior: o.instant || reducedMotion() ? 'auto' : 'smooth' });
        setTimeout(() => { if (progScroll === mine) progScroll = 0; }, o.instant ? 60 : 650);
      }
    }
    // The list of all steps is its own "page": the back gesture closes it before it closes the view
    function toggleList(fromHistory?: boolean | Event) {
      if (!stepsEl) return;
      listMode = !listMode;
      if (listMode) pausePlay();
      sheetEl.classList.toggle('s3-list', listMode);
      root.classList.toggle('s3-listopen', listMode);
      const grab = sheetEl.querySelector('.s3-grab')!;
      grab.setAttribute('aria-expanded', String(listMode));
      grab.setAttribute('aria-label', listMode ? 'Show one step at a time' : 'Show all steps as a list');
      if (fromHistory !== true) historyList(listMode);
      syncSteps({ instant: true });
    }
    function select(i: number, o?: SelectOpts) {
      if (!A.routed || A.same) return;
      o = o || {};
      skipIntro();
      const n = route!.steps.length;
      i = clamp(i, -1, n - 1);
      const changed = i !== sel;
      sel = i;
      if (isolate != null) { isolate = null; syncLevels(); }
      syncSteps(o);
      setTargets();
      labels.forEach((L) => { if (L.kind === 'via') { L.el.classList.toggle('s3-active', L.step === sel); L.prio = L.step === sel ? 92 : 90; } });
      labelsDirty = true;
      if (pov) { if (!o.fromPov && !o.follow) { setFollowQuiet(); PL.by = o.auto ? 'play' : 'step'; walkTo(R!.A[route!.steps[Math.max(0, i)].from]); } } // following: the position moves the eye, not the step
      else if (!o.fromPov && i >= 0 && route!.steps[i].kind === 'arrive') arrive(o.follow ? 'position' : 'step'); // from above there is no walk to wait for
      else if (!o.keepCam) {
        const pose = i < 0 ? overviewPose() : stepPose(i);
        if (o.follow && userHere()) {
          pose.tx = user!.sx!; pose.tl = user!.sl!; pose.tz = -user!.sy!;
          pose.dist = Math.min(pose.dist, 130);
        }
        flyTo(pose, 950);
      }
      if (changed) {
        say(i < 0 ? 'Overview of the route' : `Step ${i + 1} of ${n}: ${route!.steps[i].text}`);
        emit('step', { index: i, step: i < 0 ? null : route!.steps[i] });
      }
      touch();
    }

    const setFollowQuiet = () => { if (follow) setFollow(false); };
    let exploreCard: ReturnType<typeof card> | null = null, exploreActions: HTMLDivElement | null = null, exploreEndsEl: HTMLDivElement | null = null, exploreFrom: HTMLButtonElement | null = null;
    function buildExplore() {
      const box = mk('div', 's3-explore');
      const d = focus && focus.hit ? describe(focus.hit) : null;
      const failed = focus && focus.why;
      exploreCard = card(failed ? 'warn' : d ? d.icon : 'info', failed ? 's3-k-warn' : d ? 's3-k-route' : 's3-k-info', failed ? 'No route in this plan' : d ? d.title : 'Explore the station');
      if (failed) {
        const name = endInfo(focus!.end, focus!.which).name;
        exploreCard.meta.textContent = ({
          'not-connected': 'The plan has no walking link between these two places. That doesn’t mean there is none: follow the signs on site.',
          'unknown-stop': `${cap(name)} isn’t in this plan, so the way there can’t be shown.`,
          closed: 'Only closed ways lead there.',
          'no-router': 'Directions aren’t available right now. You can still look around.',
        } as Record<string, string | undefined>)[focus!.why!] || 'One of the two places isn’t in this plan, so the way can’t be shown. You can still look around.';
      } else if (d) exploreCard.meta.textContent = d.sub;
      else exploreCard.meta.textContent = 'Tap a platform, a stop or a shop to see what it is.';
      if (d && d.closed) exploreCard.txt.append(note('warn', d.note || `${d.title} is closed.`));
      const nb = noticesBlock(stationNotices().filter((nt) => nt.text && !(d && d.note === nt.text)));
      if (nb) exploreCard.txt.append(nb);
      exploreEndsEl = mk('div', 's3-ends');
      exploreEndsEl.hidden = true;
      exploreActions = mk('div', 's3-actions');
      exploreActions.hidden = true;
      const from = mk('button', null, 'Start here'), to = mk('button', 's3-primary', 'Go here');
      from.type = to.type = 'button';
      from.onclick = () => { if (!picked) return; exploreEnds.from = { end: endOf(picked), name: describe(picked).title }; tryExploreRoute(); };
      to.onclick = () => { if (!picked) return; exploreEnds.to = { end: endOf(picked), name: describe(picked).title }; tryExploreRoute(); };
      exploreActions.append(from, to);
      exploreFrom = mk('button', 's3-wide', 'Route from where I am');
      exploreFrom.type = 'button';
      exploreFrom.hidden = true;
      exploreFrom.onclick = () => {
        if (!userKnown()) return;
        exploreEnds.from = { end: { xy: [user!.x!, user!.y!], level: P.near(user!.level!) }, name: 'your position' };
        tryExploreRoute();
      };
      box.append(exploreCard.el, exploreEndsEl, exploreFrom, exploreActions);
      sheetEl.append(box);
      syncExplore();
    }
    // Which ends are chosen, and what can be done next
    function syncExplore() {
      if (!exploreEndsEl) return;
      const { from, to } = exploreEnds;
      exploreEndsEl.textContent = '';
      exploreEndsEl.hidden = !from && !to;
      for (const [which, e] of [['from', from], ['to', to]] as ['from' | 'to', ExploreEnd | null][]) {
        const chip = mk('span', 's3-endchip' + (e ? ' s3-set' : ''));
        if (which === 'to' || e) chip.append(mk('small', null, which === 'from' ? 'From' : 'To'));
        chip.append(mk('b', null, e ? cap(e.name) : which === 'from' ? 'Tap a place' : 'tap a place'));
        if (e) {
          const x = mk('button', null, '×');
          x.type = 'button';
          x.setAttribute('aria-label', `Clear the ${which === 'from' ? 'start' : 'destination'}`);
          x.onclick = () => { exploreEnds[which] = null; syncExplore(); };
          chip.append(x);
        }
        exploreEndsEl.append(chip);
      }
      const canRoute = !!(router && router.route);
      exploreFrom!.hidden = !(canRoute && to && !from && userKnown());
      exploreActions!.hidden = !(canRoute && picked);
      sizeSheet();
    }
    function fillExplore(d: Described) {
      if (!exploreCard) return;
      exploreCard.title.textContent = d.title;
      exploreCard.meta.textContent = d.sub;
      exploreCard.ico.innerHTML = svg(d.closed ? 'closed' : d.icon || 'info');
      exploreCard.ico.className = 's3-ico ' + (d.closed ? 's3-k-warn' : d.icon === 'arrive' ? 's3-k-route' : 's3-k-info');
      exploreCard.txt.querySelectorAll(':scope > .s3-warnnote').forEach((n) => n.remove());
      if (d.closed) exploreCard.txt.append(note('warn', d.note || `${d.title} is closed.`));
      syncExplore();
    }
    function tryExploreRoute() {
      const { from, to } = exploreEnds;
      syncExplore();
      if (from && !to) { toast('Start set. Now tap where you want to go, then “Go here”.'); return; }
      if (to && !from) { toast(userKnown() ? 'Destination set. Tap where you start, or use “Route from where I am”.' : 'Destination set. Now tap where you start, then “Start here”.'); return; }
      const r = normaliseRoute(computeRoute(from!.end, to!.end));
      if (!r) { toast(routeWhy(from!.end, to!.end) === 'not-connected' ? 'This plan has no walking link between these two places.' : 'The way between these two places can’t be shown.', 4500); return; }
      route = r;
      fromEnd = Object.assign({ label: from!.end.stop ? undefined : from!.name }, from!.end);
      toEnd = Object.assign({ label: to!.end.stop ? undefined : to!.name }, to!.end);
      focus = null;
      routeFromExplore = true;
      computeRide(false);
      rebuild();
    }
    function computeRoute(from: RouteEnd | null, to: RouteEnd | null): Route | null {
      if (!router || !router.route) return null;
      try { return router.route(model, from, to, prefs()) || null; } catch (e) { console.error('Station3D: route failed', e); return null; }
    }
    function routeWhy(from: RouteEnd | null, to: RouteEnd | null): StationRouteWhy | 'no-router' {
      if (!router || !router.route) return 'no-router';
      try { return (router.why && router.why(model, from, to, prefs())) || 'not-connected'; } catch (e) { return 'not-connected'; }
    }
    // An end of a route as a place in the model (for showing it without a route)
    function hitOfEnd(end: RouteEnd | null): Hit | null {
      if (!end) return null;
      const mkHit = (xy: Pt, level: number | null | undefined, extra: Partial<Hit>): Hit => { const li = P.idxOf(level || 0); return Object.assign({ li, level: P.levels[li].id, xy: [xy[0], xy[1]], area: areaAt(P, li, xy[0], xy[1]) }, extra); };
      if (end.stop) { const s = findStop(end.stop); if (s && s.xy) return mkHit(s.xy, s.level, { stop: s }); }
      if (end.entrance) { const e = (model.entrances || []).find((x) => x.name === end.entrance); if (e && e.xy) return mkHit(e.xy, e.level, { entrance: e }); }
      // a position the router takes for a stop without a number (stops[].at): that stop, on the level it has here
      if ((end.xy || end.ll) && router && router.resolve) {
        try { const c = (router.resolve(model, end, day) || [])[0]; if (c && c.stop && !c.stop.ref && c.stop.xy) return mkHit(c.stop.xy, c.stop.level, { stop: c.stop }); } catch (e) {}
      }
      let xy = end.xy || (end.ll ? toLocal(model, end.ll) : null), level = end.level;
      if (xy && distOutside(xy) > 40) xy = null;
      if (!xy && router && router.resolve) {
        try { const c = (router.resolve(model, end, day) || [])[0]; if (c && c.point && (!end.ll || distOutside(toLocal(model, end.ll)) < FAR_M)) { xy = c.point; level = c.point[2]; } } catch (e) {}
      }
      if (!xy) return null;
      return mkHit(xy, level == null ? guessLevel(xy[0], xy[1]) : level, {});
    }
    // The sector the route starts from, and the walk from every other one
    function startSector() {
      if (!route) return '';
      if (route.fromSectors && route.fromSectors.length === 1) return String(route.fromSectors[0]);
      if (route.fromAssumed && route.fromAssumed.sector) return String(route.fromAssumed.sector);
      return route.fromStop ? sectorNear(route.fromStop.ref, route.points[0], 30) : '';
    }
    function computeRide(mayMove: boolean) {
      ride = null;
      if (!route || !route.fromStop || samePlace(route) || !router || !router.sectorTimes || !fromEnd || !fromEnd.stop) return;
      let t: StationRouteSectorTimes | null = null;
      const whole = { stop: { uic: route.fromStop.uic, ref: pkey(route.fromStop.ref) } };
      try { t = router.sectorTimes(model, whole, toEnd, prefs()); } catch (e) { t = null; }
      if (!t || !t.sectors || t.sectors.length < 2) return;
      ride = { times: t, pick: startSector() };
      // nothing says where on the platform you are: start where it is quickest, and say so
      const named = (route.fromSectors && route.fromSectors.length) || fromEnd.stop.sector;
      if (mayMove && !named && ride.pick !== String(t.best)) {
        const r = normaliseRoute(computeRoute(withSector(String(t.best)), toEnd));
        if (r && !samePlace(r)) { route = r; ride.pick = startSector() || String(t.best); }
      }
    }
    const withSector = (name: string): RouteEnd => Object.assign({}, fromEnd, { stop: { uic: route!.fromStop!.uic, ref: pkey(route!.fromStop!.ref), sector: name } });
    function chooseSector(name: string) {
      if (!ride || !route || !route.fromStop) return;
      const end = withSector(name);
      const r = normaliseRoute(computeRoute(end, toEnd));
      if (!r) { toast('No way from that sector in this plan.'); return; }
      fromEnd = end;
      route = r;
      const t = ride.times;
      ride = { times: t, pick: startSector() || name, chosen: true };
      rebuild();
      say(`The route now starts in sector ${name}`);
    }

    // ----- you are here -----
    function piAt(along: number) {
      const Ar = R!.A;
      if (!(along > 0)) return 0;
      if (along >= Ar[Ar.length - 1]) return Ar.length - 1;
      let lo = 0, hi = Ar.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (Ar[mid] <= along) lo = mid; else hi = mid; }
      const seg = Ar[hi] - Ar[lo];
      return lo + (seg > 0 ? (along - Ar[lo]) / seg : 0);
    }
    function guessLevel(x: number, y: number) {
      const order = P.levels.map((l) => l.i).sort((a, b) => Math.abs(P.levels[a].id) - Math.abs(P.levels[b].id) || P.levels[b].id - P.levels[a].id);
      for (const li of order) if (areaAt(P, li, x, y)) return P.levels[li].id;
      return P.near(0);
    }
    // how far outside the model a point is (0 inside)
    function distOutside(xy: Pt) {
      const [x0, y0, x1, y1] = P.box;
      return Math.hypot(Math.max(x0 - xy[0], 0, xy[0] - x1), Math.max(y0 - xy[1], 0, xy[1] - y1));
    }
    function syncChip() {
      const out = !!user && user.outside;
      chipEl.hidden = !out;
      if (out) chipEl.textContent = `You’re ${fmtFar(user!.far!)} away${wantFollow ? '. Following starts when you get there.' : ''}`;
      followBtn.setAttribute('aria-pressed', follow ? 'true' : wantFollow ? 'mixed' : 'false');
      followBtn.setAttribute('aria-label', follow ? 'Stop following my position' : wantFollow ? 'Following is waiting for your position. Tap to stop' : 'Follow my position');
    }
    function setUser(u: Station3DUser | null | undefined) {
      if (!self.ready) return;
      if (!u || (!u.ll && !u.xy)) {
        user = null; manualAt = null;
        if (disc) disc.visible = false;
        if (R) R.U.uProg.value = -1;
        followBtn.hidden = true;
        if (userStep !== -1) { userStep = -1; if (stepsEl) syncSteps({ fromScroll: true }); }
        setFollow(false);
        syncChip();
        if (exploreEndsEl) syncExplore();
        layout();
        request();
        return;
      }
      const xy = u.xy || toLocal(model, u.ll!);
      const acc = isFinite(u.accuracy!) && u.accuracy! > 0 ? u.accuracy! : 15;
      const first = !user;
      const nu = user || { sx: null, sy: null, sl: null, salong: null, snap: null } as UserState;
      nu.acc = acc;
      nu.heading = isFinite(u.heading!) && u.heading != null ? ((u.heading % 360) + 360) % 360 : null;
      const out = distOutside(xy);
      if (out > FAR_M) {
        // not at the station: the dot is not drawn, nothing follows it, "you're here" stays where the traveller put it
        const was = nu.outside;
        nu.outside = true;
        nu.far = Math.hypot(xy[0] - P.core.cx, xy[1] - P.core.cy);
        nu.snap = null;
        user = nu;
        followBtn.hidden = false;
        if (disc) disc.visible = false;
        if (follow) { follow = false; wantFollow = true; emit('follow', false); }
        if (!manualAt && userStep !== -1) { userStep = -1; if (R) R.U.uProg.value = -1; if (stepsEl) syncSteps({ fromScroll: true }); }
        syncChip();
        if (!was) { say(chipEl.textContent); if (exploreEndsEl) syncExplore(); layout(); }
        request();
        return;
      }
      const wasOut = nu.outside;
      nu.outside = false;
      let mode: 'approx' | 'route' | 'manual' = 'approx', x = xy[0], y = xy[1], level = u.level != null && isFinite(u.level) ? u.level : null, alongM: number | null = null, pi: number | null = null, step = userStep;
      if (A.routed && !A.same && router && router.snap) {
        // levelSure: the floor comes from an indoor position (indoornav.js) that is sure of it: it beats the floor
        // of the previous snap, and a snap onto another floor of the route does not count
        const sureLevel = u.levelSure && level != null ? level : null;
        const hint = (sureLevel != null && nu.snap && Math.abs(nu.snap.point[2] - sureLevel) >= 0.5) ? sureLevel
          : nu.snap || (manualAt ? { along: manualAt.along, level: manualAt.point[2] } : level != null ? level : undefined);
        let sn: StationRouteSnap | null = null;
        try { sn = router.snap(model, route, xy, hint); } catch (e) { sn = null; }
        if (sn && sureLevel != null && Math.abs(sn.point[2] - sureLevel) >= 0.5) sn = null;
        // on the route while the fix could plausibly be there; GPS knows no floor, the route does
        if (sn && sn.dist <= clamp(acc * 1.5, 18, 70)) {
          mode = 'route'; alongM = sn.along; pi = sn.index + sn.t; [x, y, level] = sn.point; step = sn.step;
          nu.snap = sn; manualAt = null;
        } else if (manualAt) {
          mode = 'manual'; alongM = manualAt.along; pi = manualAt.pi; [x, y, level] = manualAt.point; step = manualAt.step;
        } else {
          nu.snap = null;
          if (sn && level == null) level = P.near(sn.point[2]);
        }
      }
      if (level == null) level = guessLevel(x, y);
      nu.mode = mode; nu.x = x; nu.y = y; nu.level = level; nu.along = alongM; nu.pi = pi;
      if (wasOut) { nu.sx = nu.sy = nu.sl = null; nu.salong = null; }
      user = nu;
      if (mode === 'route' && R && (alongM! >= R.A[R.A.length - 1] - 2 || (route!.steps[step] && route!.steps[step].kind === 'arrive'))) arrive('position');
      followBtn.hidden = false;
      // the phone's compass is only needed for the direction wedge; where it needs a tap to allow, the follow button asks
      if (nu.heading == null && !compassOn && !(window.DeviceOrientationEvent && typeof (window.DeviceOrientationEvent as DeviceOrientationCtor).requestPermission === 'function')) enableCompass();
      if (step !== userStep) {
        userStep = step;
        if (stepsEl) syncSteps({ fromScroll: true });
        if (follow && A.routed && userStep >= 0) select(userStep, { follow: true });
      }
      if (first || wasOut) { syncChip(); if (exploreEndsEl) syncExplore(); layout(); }
      if (wantFollow) setFollow(true);
      touch();
      request();
    }
    // "I'm here": the user says which step they are at; a position fix near the route takes over again
    function setManual(i: number) {
      const st = route!.steps[i];
      pausePlay();
      manualAt = { step: i, pi: st.from, along: R!.A[st.from], point: route!.points[st.from].slice() };
      const nu = user || { sx: null, sy: null, sl: null, salong: null, acc: 0, heading: null } as UserState;
      const wasOut = nu.outside;
      nu.snap = null;
      nu.outside = false;
      nu.mode = 'manual'; nu.along = manualAt.along; nu.pi = manualAt.pi;
      [nu.x, nu.y, nu.level] = manualAt.point;
      if (wasOut) { nu.sx = nu.sy = nu.sl = null; nu.salong = null; }
      user = nu;
      followBtn.hidden = false;
      userStep = i;
      syncChip();
      syncSteps({ fromScroll: true });
      if (sel !== i) select(i); else request();
      say(`You are at step ${i + 1}`);
      touch();
      // last: a listener (the indoor position) may answer with a position at once
      const pt = route!.points[st.from];
      emit('here', { step: i, xy: [pt[0], pt[1]], level: pt[2] });
    }
    function stepUser(dt: number) {
      if (!user || !disc || user.outside) return false;
      let busy = false, tx: number, ty: number, tl: number;
      const k = (tau: number) => (reducedMotion() ? 1 : 1 - Math.exp(-dt / tau));
      if (user.along != null && R) {
        if (user.salong == null) user.salong = user.along;
        const d = user.along - user.salong;
        if (Math.abs(d) > .08) { user.salong += d * k(320); busy = !reducedMotion(); } else user.salong = user.along;
        const pi = Math.abs(user.along - user.salong) <= .08 ? user.pi! : piAt(user.salong);
        [tx, ty, tl] = pointAt(pi);
        R.U.uProg.value = distAt(pi);
      } else { tx = user.x!; ty = user.y!; tl = user.level!; user.salong = null; }
      if (user.sx == null) { user.sx = tx; user.sy = ty; user.sl = tl; }
      else {
        const kk = k(150);
        user.sx += (tx - user.sx) * kk; user.sy! += (ty - user.sy!) * kk; user.sl! += (tl - user.sl!) * kk;
        if (Math.hypot(tx - user.sx, ty - user.sy!) > .04 || Math.abs(tl - user.sl!) > .004) busy = true;
        else { user.sx = tx; user.sy = ty; user.sl = tl; }
      }
      disc.visible = user.mode !== 'manual' && user.acc > 0;
      disc.position.set(user.sx, Yc(user.sl!) + .3 + detailLift(user.sx, user.sy!, user.sl!), -user.sy!);
      disc.scale.setScalar(Math.max(2.5, user.acc));
      disc.material.opacity = user.mode === 'approx' ? .1 : .16;
      if (follow) {
        if (tween) { tween.to.tx = user.sx; tween.to.tl = user.sl!; tween.to.tz = -user.sy!; }
        else {
          const kk = k(240);
          const dx = user.sx - cam.tx, dl = user.sl! - cam.tl, dz = -user.sy! - cam.tz;
          if (Math.hypot(dx, dz) > .05 || Math.abs(dl) > .002) { cam.tx += dx * kk; cam.tl += dl * kk; cam.tz += dz * kk; busy = true; }
        }
      }
      return busy;
    }
    let wantFollow = false; // asked for, and waiting for a position at the station
    function setFollow(b: boolean) {
      b = !!b;
      if (b && (!user || user.outside)) { // nothing to follow yet: wait, and say why
        wantFollow = true;
        if (follow) { follow = false; emit('follow', false); }
        syncChip(); // the standing remark says why nothing moves
        if (user && user.outside) say(chipEl.textContent);
        return;
      }
      wantFollow = false;
      if (b === follow) { syncChip(); return; }
      follow = b;
      syncChip();
      if (follow) {
        pausePlay(); // a live position leads
        if (A.routed && !A.same && userStep >= 0) select(userStep, { follow: true });
        else if (user!.sx != null) flyTo({ tx: user!.sx, tl: user!.sl!, tz: -user!.sy!, dist: Math.min(cam.dist, 140) }, 800);
      }
      emit('follow', follow);
      request();
    }
    // The phone's compass. → 'granted' | 'denied' | 'unavailable'. iOS asks once per tap; a refusal can be asked again.
    let lastOrient = 0;
    function enableCompass(): Promise<Station3DCompass> {
      if (compassAsk) return compassAsk;
      const D = window.DeviceOrientationEvent as DeviceOrientationCtor | undefined;
      if (!D) return Promise.resolve('unavailable');
      const attach = (): Station3DCompass => {
        if (self.alive && !compassOn) {
          compassOn = true;
          on(window, 'deviceorientationabsolute', onOrient, true);
          on(window, 'deviceorientation', onOrient, true);
        }
        return 'granted';
      };
      if (typeof D.requestPermission === 'function') {
        let ask: Promise<'granted' | 'denied'>;
        try { ask = D.requestPermission(); } catch (e) { return Promise.resolve('denied'); }
        compassAsk = Promise.resolve(ask).then((s) => (s === 'granted' ? attach() : 'denied'), () => 'denied');
        compassAsk.then((s) => { if (s !== 'granted') compassAsk = null; });
      } else compassAsk = Promise.resolve(attach());
      return compassAsk;
    }
    let O: { eu: THREE.Euler; q: THREE.Quaternion; q1: THREE.Quaternion; q2: THREE.Quaternion; z: THREE.Vector3; f: THREE.Vector3 } | null = null; // scratch objects for the orientation maths: nothing is allocated per event
    function onOrient(e: Station3DOrientation, force?: boolean) {
      // which way the back of the phone points: bearing and tilt, for "look where I'm facing" (only while that is wanted)
      if ((force || pv.waiting || (pov && pv.device)) && e.beta != null && (e.absolute || typeof e.webkitCompassHeading === 'number')) {
        if (!O) O = { eu: new THREE.Euler(0, 0, 0, 'YXZ'), q: new THREE.Quaternion(), q1: new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2), q2: new THREE.Quaternion(), z: new THREE.Vector3(0, 0, 1), f: new THREE.Vector3() };
        const rad = Math.PI / 180;
        const alpha = typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading) ? 360 - e.webkitCompassHeading : e.alpha || 0;
        const so = ((screen.orientation && screen.orientation.angle) || 0) * rad;
        O.eu.set(e.beta * rad, alpha * rad, -(e.gamma || 0) * rad, 'YXZ');
        O.q.setFromEuler(O.eu).multiply(O.q1).multiply(O.q2.setFromAxisAngle(O.z, -so));
        O.f.set(0, 0, -1).applyQuaternion(O.q);
        if (!pv.orient) pv.orient = { b: 0, p: 0 };
        pv.orient.b = Math.atan2(O.f.x, -O.f.z); pv.orient.p = Math.asin(clamp(O.f.y, -1, 1));
        if (pv.waiting) { const w = pv.waiting; pv.waiting = null; clearTimeout(orientTimer); w(); }
        if (pov && pv.device) request();
      }
      // the compass heading, for the wedge on the blue dot when the position fix has no direction of its own
      if (!user || user.outside || user.heading != null) return;
      let h: number | null = null;
      if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) h = e.webkitCompassHeading;
      else if (e.absolute && e.alpha != null) h = 360 - e.alpha;
      if (h == null) return;
      const so = (screen.orientation && screen.orientation.angle) || 0;
      h = (h + so + 360) % 360;
      const now = performance.now();
      if (now - lastOrient < 90) return;
      if (compassHeading != null && Math.abs(angDiff(h * Math.PI / 180, compassHeading * Math.PI / 180)) < .03) return;
      lastOrient = now;
      compassHeading = h;
      request();
    }

    // ----- layout -----
    function layout() {
      const r = root.getBoundingClientRect();
      W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
      renderer.setPixelRatio(pixelRatio());
      renderer.setSize(W, H, false);
      const top = demo ? 8 : topEl.getBoundingClientRect().bottom - r.top + 8; // the demo has no bar, sheet or rail: the picture is all
      const sr = sheetEl.hidden || demo ? null : sheetEl.getBoundingClientRect();
      const wide = sr && sr.width < W * .7;
      const bottom = sr && !wide ? r.bottom - sr.top + 8 : 10;
      free = { x0: 8, y0: top, x1: W - (levelsEl.hidden || demo ? 8 : 64), y1: H - bottom } as typeof free;
      free.w = Math.max(40, free.x1 - free.x0); free.h = Math.max(40, free.y1 - free.y0);
      free.cx = (free.x0 + free.x1) / 2; free.cy = (free.y0 + free.y1) / 2;
      // labels may use the whole stage, but never lie under a control
      safe = { x0: 6, y0: top - 2, x1: W - 6, y1: H - bottom + 2 };
      avoid = [];
      for (const el of [levelsEl, followBtn, fitBtn, northBtn, chipEl, hudEl, miniEl, toastEl.classList.contains('s3-show') ? toastEl : null]) {
        if (!el || el.hidden || el.offsetParent === null) continue;
        const b = el.getBoundingClientRect();
        if (b.width && b.height) avoid.push([b.left - r.left - 4, b.top - r.top - 4, b.right - r.left + 4, b.bottom - r.top + 4]);
      }
      camera.aspect = W / H;
      camera.setViewOffset(W, H, W / 2 - free.cx, H / 2 - free.cy, W, H);
      const [bx0, by0, bx1, by1] = P.box;
      const pts: P3[] = [];
      for (const li of [0, P.n - 1]) for (const [x, y] of [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]]) pts.push([x, tabTo[li], -y]);
      // how far out you can go: the station still fills a good part of the screen
      maxDist = 1e9;
      maxDist = Math.min(fitPose(pts, cam.az, .9, 10).dist * 1.2, Math.max(levelPose(null).dist, A.routed ? overviewPose().dist : 0) * 2.2);
    }

    // ----- start, rebuild, stop -----
    const defaultPeel = () => (opts.peel != null && isFinite(+opts.peel) ? clamp(+opts.peel, 0, 1) : A.routed && A.shown.length > 1 ? 1 : A.routed ? .5 : .62);
    function resolveRoute() {
      route = null; focus = null; ride = null;
      if (fromEnd && toEnd) {
        route = normaliseRoute(computeRoute(fromEnd, toEnd));
        if (route) computeRide(true);
        else focus = { which: 'to', end: toEnd, hit: hitOfEnd(toEnd), why: routeWhy(fromEnd, toEnd) };
      } else if (toEnd || fromEnd) { // one end only: show that place, and let the other be chosen
        const which = toEnd ? 'to' : 'from', end = toEnd || fromEnd!;
        focus = { which, end, hit: hitOfEnd(end), why: null };
        if (focus.hit) exploreEnds[which] = { end, name: describe(focus.hit).title };
        else focus = null;
      }
    }
    function rebuild(o?: { keep?: boolean }) {
      o = o || {};
      const keep = o.keep ? { sel, isolate, cam: Object.assign({}, cam), peel: peelTo } : null;
      const wasPov = pov;
      if (pov && !keep) { pov = false; povT = 0; povAnim = null; root.classList.remove('s3-pov'); if (!pv.free && R) opts.povAt = pv.along; }
      if (!keep && PL.on) { PL.on = false; emit('play', false); }
      PL.ride = null;
      clearScene();
      pickHl = null; picked = null;
      sel = -1; isolate = null;
      analyse();
      chooseDetail(); // another walk may run through another scene of the station
      setupShape();
      buildScene();
      buildLevels();
      buildSheet();
      layout();
      buildLabels();
      setTargets();
      snapOpacity();
      if (user) { user.snap = null; user.salong = null; }
      peelHome = defaultPeel();
      if (keep) {
        peel = peelTo = keep.peel; peelAnim = null;
        calcTab(tabTo, peelTo, pov ? 1 : 0);
        applyShape(true);
        if (A.routed && !A.same && keep.sel >= 0) select(keep.sel, { keepCam: true, instant: true, fromPov: true }); // the look changed, not the place
        if (keep.isolate != null && P.levels[keep.isolate]) { isolate = keep.isolate; syncLevels(); setTargets(); snapOpacity(); }
        tween = null;
        Object.assign(cam, keep.cam);
      } else {
        setPeel(peelHome, { dur: 0 });
        moved = false;
        if (A.routed && !A.same) select(-1, {}); else flyTo(overviewPose(), 900);
        if (wasPov) setPov(true);
      }
      syncPov();
      hudKey = ''; // the title line was written anew: in the first-person view it says where you are again
      DT.show = false; DT.bird = false;
      ensureDetail();
      request();
    }
    function start(m: StationModel, r: Router | null) {
      model = m; router = r; P = prepare(m);
      titleEl.textContent = opts.title || m.name || 'Station';
      creditEl.textContent = (m.attribution || []).join(' · ');
      resolveRoute();
      try { initGL(); } catch (e) { console.warn('Station3D: no WebGL', e); showState('nowebgl'); return; }
      analyse();
      DT.entry = pickDetail();
      peelHome = defaultPeel();
      peel = peelTo = 0;
      setupShape();
      layout();
      buildScene();
      buildLevels();
      buildSheet();
      layout();
      buildLabels();
      buildControls();
      setTargets();
      snapOpacity();
      const direct = reducedMotion() || opts.still || opts.step != null || opts.level != null || opts.pov || opts.follow || opts.play;
      if (direct) {
        setPeel(peelHome, { dur: 0 });
        Object.assign(cam, limit(overviewPose()));
      } else {
        // one entrance: the station lies flat like a map, then its floors peel apart, the camera settles and the
        // route draws itself
        peelTo = peelHome; calcTab(tabTo, peelTo, 0);
        const end = overviewPose();
        peelTo = 0; calcTab(tabTo, 0, 0);
        Object.assign(cam, limit(overviewPose({ az: end.az + (peelHome > .2 ? .3 : 0) })));
        applyShape(true);
        if (peelHome > 0) openTimer = setTimeout(() => { openTimer = 0; if (!self.alive) return; setPeel(peelHome, { dur: 1700 }); flyTo(currentPose(), 1700); }, 520);
        if (R && !A.same) { R.U.uGrow.value = 0; grow = { t0: performance.now() + 350, dur: 1500 }; }
      }
      self.ready = true;
      showState(null);
      fitBtn.hidden = false;
      northBtn.hidden = false;
      layout();
      ro = new ResizeObserver(() => {
        if (!self.ready) return;
        if (stepsEl) syncSteps({ instant: true }); else sizeSheet(); // the cards wrap differently at another width
        if (!moved && !pov && !openTimer) flyTo(currentPose(), 0);
        request();
      });
      ro.observe(root);
      mo = new MutationObserver(() => {
        const t = isDark() ? 'dark' : 'light';
        if (t === theme) return;
        theme = t;
        root.classList.toggle('s3-dark', theme === 'dark');
        rebuild({ keep: true });
      });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      on(document, 'visibilitychange', () => { if (!document.hidden) { touch(); request(); } });
      // the last position, unless it is a GPS fix that has gone stale meanwhile (the phone may have been in a pocket)
      if (pendingUser && !(pendingUser.at != null && Date.now() - pendingUser.at > USER_STALE_MS)) setUser(pendingUser);
      if (opts.step != null && A.routed) select(+opts.step);
      if (opts.level != null && P.levels.some((l) => l.id === +opts.level!)) setIsolate(P.idxOf(+opts.level));
      if (opts.follow) setFollow(true);
      if (opts.pov) { setPov(true); if (opts.povYaw != null) pv.yaw = +opts.povYaw * Math.PI / 180; if (opts.povPitch != null) pv.pitch = +opts.povPitch * Math.PI / 180; }
      if (opts.list && stepsEl) toggleList();
      ensureDetail();
      touch();
      request();
      emit('open', { key: m.key, route, focus: focus ? { which: focus.which, why: focus.why } : null });
      if (opts.play && A.routed && !A.same) { // after 'open' is told: the walk plays by itself; with reduced motion it waits for the Play button
        if (isFinite(+(opts.play as Station3DPlayOptions).speed!) && +(opts.play as Station3DPlayOptions).speed! > 0) PL.speed = clamp(+(opts.play as Station3DPlayOptions).speed!, .2, 8);
        if (!pov) setPov(true);
        if (!reducedMotion()) setPlay(true);
      }
    }

    // Everything else on the page is out of reach while the view is open (as in settings.js)
    let inerted: HTMLElement[] = [];
    function setInert(onOff: boolean) {
      if (!onOff) { for (const el of inerted) el.inert = false; inerted = []; return; }
      if (opts.modal === false || !root) return;
      let host: HTMLElement = root;
      for (;;) {
        const p = host.parentNode;
        if (!p || p === document.body) break;
        host = p.nodeType === 11 ? (p as ShadowRoot).host as HTMLElement : p as HTMLElement; // out of a shadow tree
        if (!host) return;
      }
      if (host.parentNode !== document.body) return;
      for (const el of document.body.children as HTMLCollectionOf<HTMLElement>) {
        if (el === host || el.inert || /^(SCRIPT|STYLE|LINK)$/.test(el.tagName)) continue;
        el.inert = true;
        inerted.push(el);
      }
    }
    // a message without the stylesheet (it is what failed to load)
    function showBare() {
      const d = mk('div');
      d.setAttribute('role', 'alertdialog');
      d.style.cssText = 'position:fixed;inset:0;z-index:60;display:grid;place-content:center;justify-items:center;gap:14px;padding:32px;text-align:center;background:#fff;color:#1c1c1e;font:16px/1.4 -apple-system,BlinkMacSystemFont,Arial,sans-serif';
      const p = mk('p', null, 'The 3D view didn’t load. Check your connection, then try again.');
      p.style.cssText = 'margin:0;max-width:30ch';
      const again = mk('button', null, 'Try again'), shutBtn = mk('button', null, 'Close');
      for (const b of [again, shutBtn]) { b.type = 'button'; b.style.cssText = 'height:46px;padding:0 22px;border:0;border-radius:14px;font:600 16px -apple-system,BlinkMacSystemFont,Arial,sans-serif;cursor:pointer'; }
      again.style.background = '#0a84ff'; again.style.color = '#fff';
      again.onclick = () => api.reopen(self.opts);
      shutBtn.onclick = () => api.close();
      d.append(p, again, shutBtn);
      (opts.mount && opts.mount.nodeType === 1 ? opts.mount : document.body).appendChild(d);
      root = d;
      emit('error', { code: 'css', message: p.textContent! });
    }

    const api = { close: () => close(), reopen: (o: Station3DOpenOptions) => open(o) };
    self.boot = function (instant) {
      loadCss().then(() => {
        if (!self.alive) return null;
        buildDom();
        setInert(true);
        showState('loading');
        if (instant) root.style.transition = 'none';
        void root.offsetWidth; // start from the closed position, also in a tab that gets no animation frames
        root.classList.add('s3-open');
        if (instant) { void root.offsetWidth; root.style.transition = ''; }
        try { root.querySelector<HTMLElement>('.s3-close')!.focus({ preventScroll: true }); } catch (e) {}
        const three = loadThree().catch((e) => { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { s3: 'three' }); });
        const mdl = loadModel(opts.key).catch((e) => { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { s3: 'model' }); });
        return Promise.all([three, mdl, loadRouter(), loadDetailIndex()]).then(([, m, r, di]) => {
          if (!self.alive) return;
          // one scene ({ file, bbox }: its data is STATION3D_DETAIL[model key]) or several ([{ id, file, bbox }])
          const raw = (di && (di[opts.key] || di[m.key])) || null;
          DT.list = (Array.isArray(raw) ? raw : raw ? [raw] : [])
            .filter((e) => e && e.bbox && e.bbox.length === 4 && e.file)
            .map((e) => ({ id: e.id || m.key, file: e.file, bbox: e.bbox }));
          DT.entry = DT.list[0] || null;
          // from here on a failure is not the connection: it is the model or this code
          try { start(m, r); } catch (e) { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { s3: 'broken' }); }
        });
      }).catch((e) => {
        if (!self.alive) return;
        console.error('Station3D:', e);
        if (root) showState(e && e.s3 ? e.s3 : 'three');
        else showBare();
      });
    };
    self.destroy = function (instant) {
      if (!self.alive) return;
      self.alive = false;
      self.ready = false;
      if (raf) cancelAnimationFrame(raf);
      [slowTimer, toastTimer, scrollTimer, tipTimer, openTimer, orientTimer].forEach(clearTimeout);
      offs.forEach((f) => f());
      offs.length = 0;
      if (ro) ro.disconnect();
      if (mo) mo.disconnect();
      setInert(false);
      const el = root, rr = renderer, light = sun;
      const kill = () => {
        clearScene();
        if (light && light.shadow && light.shadow.map) light.shadow.map.dispose();
        if (rr) { rr.dispose(); try { rr.forceContextLoss(); } catch (e) {} }
        if (el) el.remove();
      };
      if (el) el.classList.remove('s3-open');
      if (instant || reducedMotion() || !el) kill(); else setTimeout(kill, 520);
    };
    self.setUser = setUser;
    self.select = (i) => { if (self.ready && A.routed) { pausePlay(); setFollow(false); select(i); } };
    self.setFollow = (b) => { if (self.ready) { setFollow(b); if (b) enableCompass(); } };
    self.enableCompass = enableCompass;
    self.setPov = (b) => setPov(b);
    self.play = (o) => {
      if (o && isFinite(+o.speed!) && +o.speed! > 0) PL.speed = clamp(+o.speed!, .2, 8);
      if (PL.on) return true; // already walking: only the pace changes, without a new start
      if (!self.ready) { opts.play = opts.play || true; return false; } // it starts when the view is ready
      if (!A.routed || A.same) return false;
      if (!pov) setPov(true);
      return reducedMotion() ? false : setPlay(true);
    };
    self.pause = () => { opts.play = null; pausePlay(); };
    self.isPlaying = () => PL.on;
    self.setPeel = (v) => { if (self.ready) { skipIntro(); setPeel(v, { dur: 600 }); if (!moved) flyTo(currentPose(), 600); } };
    self.orient = (e) => { // a pretend phone (the development page)
      compassOn = true; compassAsk = Promise.resolve('granted');
      onOrient(e, true);
      if (pov && !pv.device) setDeviceLook(true);
    };
    self.depth = () => (listMode ? 2 : 1); // history entries this view holds
    self.back = () => { if (listMode) { toggleList(true); return true; } return false; };
    self.detail = () => DT.h;
    self.redraw = () => { if (self.ready) { touch(); request(); } };
    self.debug = () => ({
      cam: Object.assign({ pol: polOf(peel) }, cam), peel, peelTo, tab: SH.tab.slice(), sel, isolate, follow, wantFollow, user: user && Object.assign({}, user), userStep, route, model, focus, ride,
      shown: A.shown.slice(), box: A.box, levels: lv3.map((l) => l.op), plates: lv3.map((l) => (l.plate ? l.plate.op * l.plate.gain : null)),
      draws: renderer ? renderer.info.render.calls : 0, tris: renderer ? renderer.info.render.triangles : 0, geoms: renderer ? renderer.info.memory.geometries : 0,
      labels: labels.length, shownLabels: labels.filter((l) => l.shown).map((l) => ({ kind: l.kind, text: l.el.textContent, x: Math.round(parseFloat((l.el.style.transform.match(/translate\(([-\d.]+)px/) || [0, 0])[1] as string)), y: Math.round(parseFloat((l.el.style.transform.match(/,\s*([-\d.]+)px/) || [0, 0])[1] as string)), w: l.w, h: l.h, pinned: !!l.pinned })),
      free, safe, avoid, pov, povT, pv: Object.assign({}, pv), play: Object.assign({}, PL, { pois: PL.pois ? PL.pois.length : 0, poisOf: null }), listeners: offs.length, lost, inert: inerted.length, compassOn,
      pick, flyTo, request, renderer, rebuild, setPeel, select, project, boxRing, Yc, P,
      // frame times in the first-person view (milliseconds, real frames only) and the pixel ratio in use
      frames: (() => { const a = Array.from(FT.ring.subarray(0, Math.min(FT.n, FT.ring.length))).sort((x, y) => x - y); return { avg: Math.round(FT.avg * 10) / 10, p95: a.length ? Math.round(a[Math.min(a.length - 1, Math.floor(a.length * .95))] * 10) / 10 : null, n: FT.n, pixelRatio: renderer ? renderer.getPixelRatio() : null, cap: FT.cap, drops: FT.drops }; })(),
      eyeAt: (along: number) => (R ? eyeAt(along) : null), camY: () => camera.position.y, camPos: () => [camera.position.x, camera.position.y, camera.position.z],
      detail: DT.entry ? { id: DT.entry.id, scenes: DT.list.map((e) => e.id), loaded: !!DT.data, built: !!DT.h, show: DT.show, bird: DT.bird, spot: DT.spot, k: DT.k, tilt: DT.tilt, flattened: !!(DT.h && DT.h.flattened), marks: DT.marks.map((m) => ({ kerb: m.userData.kerb, visible: m.visible, tris: m.geometry.attributes.position.count / 3 })), stats: DT.h && DT.h.stats ? { triangles: DT.h.stats.triangles, drawCalls: DT.h.stats.drawCalls, buildMs: DT.h.stats.buildMs, warnings: DT.h.stats.warnings } : null, lift: liftRaw, ground: groundOf } : null,
      signs: signList.map((w) => ({ style: w.style, text: w.text, back: w.back, x: Math.round(w.x), y: Math.round(w.y), lf: w.lf })), props: inst ? { boxes: inst.boxes.length, cyls: inst.cyls.length } : null,
      // let time pass: sec seconds at hz frames a second, drawn one after the other (a tab without animation frames
      // can still watch the walk play)
      run: (sec: number, hz?: number) => {
        const step = 1000 / (hz || 60);
        let t = Math.max(performance.now(), lastT);
        FT.sim = true; // pretend frames say nothing about the device
        for (let i = 0; i < sec * (hz || 60) && self.alive; i++) {
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
          lastT = t; t += step;
          frame(t);
        }
        FT.sim = false; FT.last = 0;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        lastT = performance.now();
        request();
        return true;
      },
      // run every animation to its end and draw (for tests in a tab that gets no animation frames)
      settle: () => {
        if (openTimer) { clearTimeout(openTimer); openTimer = 0; setPeel(peelHome, { dur: 0 }); Object.assign(cam, limit(currentPose())); tween = null; }
        for (let i = 0; i < 3; i++) { if (raf) { cancelAnimationFrame(raf); raf = 0; } frame(performance.now() + 1e6 * (i + 1)); }
        for (const p of parts) p.op = p.target;
        if (stepsEl && !listMode && stepsEl.firstElementChild) stepsEl.scrollTo({ left: (stepsEl.firstElementChild as HTMLElement).offsetWidth * (sel + 1), behavior: 'auto' });
        if (user && !user.outside && user.sx != null) { user.sx = user.x!; user.sy = user.y!; user.sl = user.level!; if (follow) { cam.tx = user.sx; cam.tl = user.sl; cam.tz = -user.sy; } }
        if (pov) { pv.x = pv.tx; pv.y = pv.ty; pv.level = pv.tl; pv.bearing = pv.tb; pv.bv = 0; pv.lx = NaN; }
        indoorT = Math.round(indoorT);
        DT.k = DT.show && pov && DT.entry && inBB(DT.entry.bbox, pv.x, pv.y, 4) ? 1 : 0;
        grow = null; if (R) R.U.uGrow.value = 1e9;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        frame(performance.now() + 5e6);
        lastT = performance.now();
        return true;
      },
    });
    return self;
  }

  // ---------- public API ----------
  let V: Viewer | null = null;
  let pendingUser: Station3DUser | null = null; // the last position: also shown when it arrived before the model was ready
  const USER_STALE_MS = 60e3;                    // a GPS fix older than this (Station3DUser.at) is not shown on opening
  let lastFocus: HTMLElement | null = null;
  let skipPops = 0, skipTimer = 0; // history steps we took ourselves: their popstate is not the user's back gesture

  // The view is one history entry (URL hash #station3d), so the back gesture closes it; the list of all steps is a
  // second one, so back closes the list first. pushState rather than location.hash: a hash set while the page is
  // still loading replaces the entry instead of adding one.
  const ours = () => { try { return !!(history.state && history.state.station3d); } catch (e) { return false; } };
  function expectPop() {
    skipPops++;
    clearTimeout(skipTimer);
    skipTimer = setTimeout(() => { skipPops = 0; }, 1500); // a traversal that never came must not swallow a real one
  }
  function onPop() {
    if (skipPops > 0) {
      skipPops--;
      // a view that was opened while our own step back was still on its way has lost its entry: give it back
      if (V && location.hash !== HASH) { try { history.pushState({ station3d: true }, '', HASH); } catch (e) {} }
      return;
    }
    if (!V) return;
    if (location.hash !== HASH) { shut(); return; }
    V.back(); // still on our entry: the back gesture closed something inside the view
  }
  // the hash changed without a step through the history (another part of the app set it): the view gives way
  function onHash() { if (V && !skipPops && location.hash !== HASH) shut(); }
  function historyList(open: boolean) { // called by the viewer when the step list opens or closes by a tap
    try {
      if (open) history.pushState({ station3d: true, list: true }, '', HASH);
      else if (history.state && history.state.list) { expectPop(); history.back(); }
    } catch (e) {}
  }
  function shut(instant?: boolean) {
    if (!V) return;
    const v = V;
    V = null;
    v.destroy(instant);
    window.removeEventListener('hashchange', onHash);
    window.removeEventListener('popstate', onPop);
    emit('close');
    try { if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true }); } catch (e) {}
    lastFocus = null;
  }
  function open(opts: Station3DOpenOptions) {
    opts = Object.assign({}, opts);
    if (!opts.key) throw new Error('Station3D.open needs a key');
    emit('opening', { key: opts.key, replaces: V ? V.opts.key : null });   // a station replaced by another says no 'close'
    const again = !!V;
    let depth = 1;
    if (V) { const v = V; V = null; depth = v.depth(); v.destroy(true); }
    else lastFocus = opts.returnFocus || document.activeElement as HTMLElement | null;
    try {
      if (again && ours() && location.hash === HASH) {
        if (depth > 1) { expectPop(); history.back(); } // the old view's step list was open: drop its entry
      } else history.pushState({ station3d: true }, '', HASH); // also when a close is still on its way back (skipPops)
    } catch (e) { if (location.hash !== HASH) location.hash = HASH; }
    window.removeEventListener('hashchange', onHash);
    window.removeEventListener('popstate', onPop);
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onPop);
    V = createViewer(opts);
    V.boot(again);
  }
  function close() {
    if (!V) return;
    const depth = V.depth();
    shut();
    if (location.hash === HASH) {
      try {
        if (ours()) { expectPop(); history.go(-depth); }
        else history.replaceState(null, '', location.pathname + location.search);
      } catch (e) {}
    }
  }

  window.Station3D = {
    // SCHEMA.md
    has: (uic) => (window.STATION3D_INDEX && window.STATION3D_INDEX[String(uic)]) || null,
    open,
    setUser: (u) => { pendingUser = u || null; if (V) V.setUser(pendingUser); },
    close,
    // extras
    isOpen: () => !!V,
    on: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); return () => window.Station3D.off(name, fn); },
    off: (name, fn) => { listeners[name] = (listeners[name] || []).filter((f) => f !== fn); },
    selectStep: (i) => { if (V) V.select(i); },
    setFollow: (b) => { if (V) V.setFollow(b); },
    enableCompass: () => (V ? V.enableCompass() : Promise.resolve('unavailable')),
    setPov: (b) => { if (V) V.setPov(b); },
    play: (o) => (V ? V.play(o) : false),
    pause: () => { if (V) V.pause(); },
    isPlaying: () => !!V && V.isPlaying(),
    setPeel: (v) => { if (V) V.setPeel(v); },
    detail: () => (V ? V.detail() : null),
    redraw: () => { if (V) V.redraw(); },
    _orient: (e) => { if (V) V.orient(e); },
    preload: (key) => Promise.all([loadCss(), loadThree(), key ? loadModel(key) : null, loadRouter()]).then(() => true, () => false),
    // just the model and the router (no three.js): for drawing a station walk on the 2D map → model | null
    loadData: (key) => Promise.all([loadModel(key), loadRouter()]).then(([m, r]) => (m && r ? m : null), () => null),
    _debug: () => (V ? V.debug() : null),
  };

})();
