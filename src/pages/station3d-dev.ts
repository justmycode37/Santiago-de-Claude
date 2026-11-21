// station3d.js is loaded with a fresh query each time, so the plain http.server never serves a stale copy
(function () {
  const s = document.createElement('script');
  s.src = 'station3d.js?v=' + Date.now();
  s.onload = boot;
  document.head.appendChild(s);
})();

/** A place as the URL names it ("stop:8507000:7", "node:12", "ll:7.44,46.95", "far"): an end of a route, or
    "far" (for user=): a position well outside the model. */
type DevPlace = (Station3DEndpoint & { far?: undefined }) | { far: true; ll?: undefined; xy?: undefined };
/** The journey settings prefs= switches on. */
type DevPrefFlag = 'stepFree' | 'fewerStairs' | 'noEscalators' | 'wheelchair';
/** The walk along the route that the page feeds in as live positions: metres walked, and its timer. */
interface DevSim { along: number; timer: number }
/** What the walk that plays by itself told the page, as DEV.events keeps it (t = ms since the page loaded). */
type DevWalkEvent = 'arrived' | 'progress' | 'play';
interface DevEvent { t: number; name: DevWalkEvent; e: Station3DEventMap[DevWalkEvent] }
/** `DEV.reload(over)`: options of open() to change (from / to also as in the URL), the theme, and the wait after 'open' in ms. */
interface DevReload extends Partial<Omit<Station3DOpenOptions, 'from' | 'to'>> {
  from?: Station3DEndpoint | string | null;
  to?: Station3DEndpoint | string | null;
  theme?: string;
  wait?: number;
}
/** The options by name: reload() copies whatever it is given. */
type DevOptionsByName = Station3DOpenOptions & Record<string, unknown>;
/** window.DEV: what the page offers to the console and to the scripts that drive it. */
interface Dev {
  options: Station3DOpenOptions;
  startSim(): void;
  stopSim(): void;
  reload(over?: DevReload): Promise<'error' | void>;
  face(bearing: number, tilt?: number): void;
  events: DevEvent[];
  shadow?: ShadowRoot;
}
type DevWindow = typeof window & { DEV: Dev };
/** window, with the orientation event class as something the page may take away or replace. */
interface DevMotionWindow { DeviceOrientationEvent?: unknown }

function boot() {
  const q = new URLSearchParams(location.search);
  const num = (name: string, d: number) => (q.has(name) && isFinite(+q.get(name)!) ? +q.get(name)! : d);
  const endpoint = (text: string | null): DevPlace | null => {
    if (!text) return null;
    const i = text.indexOf(':');
    const kind = text.slice(0, i), rest = text.slice(i + 1);
    if (kind === 'stop') {
      const j = rest.indexOf(':');
      let ref = j < 0 ? '' : rest.slice(j + 1), sector;
      if (ref.includes('@')) { sector = ref.slice(ref.indexOf('@') + 1); ref = ref.slice(0, ref.indexOf('@')); }
      const stop: StationRouteStopRef = { uic: j < 0 ? rest : rest.slice(0, j), ref };
      if (sector) stop.sector = sector;
      return { stop };
    }
    if (text === 'far') return { far: true };
    if (kind === 'node') return { node: +rest };
    if (kind === 'entrance') return { entrance: rest };
    const n = rest.split(',').map(Number);
    const o: Station3DEndpoint = kind === 'll' ? { ll: [n[0], n[1]] } : { xy: [n[0], n[1]] };
    if (n.length > 2 && isFinite(n[2])) o.level = n[2];
    return o;
  };
  const prefs: StationRoutePrefs = {};
  (q.get('prefs') || '').split(',').filter(Boolean).forEach((p) => { prefs[p as DevPrefFlag] = true; });
  if (q.has('walkKmh')) prefs.walkKmh = +q.get('walkKmh')!;
  if (q.has('date')) prefs.date = q.get('date');
  // a phone that refuses motion access, or grants it and then stays silent, or has no sensor at all
  const motion = q.get('motion');
  if (motion === 'none') { try { delete (window as DevMotionWindow).DeviceOrientationEvent; (window as DevMotionWindow).DeviceOrientationEvent = undefined; } catch (e) {} }
  else if (motion) {
    const F = function () {};
    F.requestPermission = () => Promise.resolve(motion === 'denied' ? 'denied' : 'granted');
    try { Object.defineProperty(window, 'DeviceOrientationEvent', { value: F, configurable: true }); } catch (e) { (window as DevMotionWindow).DeviceOrientationEvent = F; }
  }
  const options: Station3DOpenOptions = {
    key: q.get('key') || 'bern', from: endpoint(q.get('from')) as Station3DEndpoint | null, to: endpoint(q.get('to')) as Station3DEndpoint | null, prefs,
    title: q.get('title') || undefined,
    step: q.has('step') ? +q.get('step')! : undefined,
    level: q.has('level') ? +q.get('level')! : undefined,
    peel: q.has('peel') ? +q.get('peel')! : undefined,
    still: q.get('still') === '1',
    season: q.get('season') as Station3DDetailSeason | null || undefined,
    quality: q.get('quality') as Station3DDetailQuality | null || undefined,
    list: q.get('list') === '1',
    modal: q.get('ui') === '0', // with this page's own buttons showing, they must stay usable
    follow: q.get('follow') === '1',
    pickAnywhere: true,
    pov: q.get('pov') === '1',
    povAt: q.has('at') ? +q.get('at')! : undefined,
    povYaw: q.has('yaw') ? +q.get('yaw')! : undefined,
    povPitch: q.has('pitch') ? +q.get('pitch')! : undefined,
    play: q.get('play') === '1' ? (q.has('speed') && isFinite(+q.get('speed')!) ? { speed: +q.get('speed')! } : true) : undefined,
  };
  // a pretend phone: face=<compass bearing the back of the phone points to>, tilt=<degrees up>
  const face = (bearing: number, tilt?: number) => Station3D._orient({ absolute: true, alpha: (360 - bearing) % 360, beta: 90 + (tilt || 0), gamma: 0 });

  const dev = document.getElementById('dev')!, out = document.getElementById('dOut')!;
  dev.hidden = q.get('ui') === '0';
  const acc = num('acc', 8), noise = num('noise', 0);
  let placing = q.get('place') === '1';
  let sim: DevSim | null = null, route: StationRouteResult | null = null, model: StationModel | null = null;
  const headingParam = q.get('heading');
  const fixedHeading = headingParam != null && isFinite(+headingParam) ? +headingParam : null;

  const press = (id: string, on: boolean) => document.getElementById(id)!.setAttribute('aria-pressed', String(on));
  press('dPlace', placing);

  // GPS error: wanders slowly instead of jumping around independently at every fix
  let ex = 0, ey = 0;
  function jitter() {
    if (!noise) return [0, 0];
    ex = ex * .8 + (Math.random() - .5) * noise * .9;
    ey = ey * .8 + (Math.random() - .5) * noise * .9;
    return [ex, ey];
  }
  function stopSim() { if (sim) { clearInterval(sim.timer); sim = null; } press('dWalk', false); }
  function startSim() {
    stopSim();
    if (!route || !window.StationRoute) { out.textContent = 'no route to walk'; return; }
    const speed = q.get('play') === '1' ? 1.35 : num('speed', 1.35), rate = num('rate', 3), tick = 250;
    const total = route.dists ? route.dists[route.dists.length - 1] : route.length;
    sim = { along: num('start', 0), timer: 0 };
    press('dWalk', true);
    const step = () => {
      const p = StationRoute!.pointAt(route!, sim!.along)!;
      const p2 = StationRoute!.pointAt(route!, Math.min(total, sim!.along + 1.5))!;
      const [jx, jy] = jitter();
      const ll = StationRoute!.toLngLat(model!, [p[0] + jx, p[1] + jy]);
      let heading;
      if (fixedHeading != null) heading = fixedHeading;
      else if (headingParam !== 'none' && Math.hypot(p2[0] - p[0], p2[1] - p[1]) > .2) heading = (Math.atan2(p2[0] - p[0], p2[1] - p[1]) * 180 / Math.PI + 360) % 360;
      Station3D.setUser({ ll, accuracy: acc, heading });
      out.textContent = `${Math.round(sim!.along)} / ${Math.round(total)} m`;
      if (sim!.along >= total) { stopSim(); return; }
      sim!.along = Math.min(total, sim!.along + speed * rate * tick / 1000);
    };
    step();
    sim.timer = setInterval(step, tick);
  }

  function wire() {
    Station3D.on('open', (e) => {
      route = e.route;
      model = window.STATION3D![options.key];
      const u = endpoint(q.get('user'));
      if (u) {
        const ll = u.far ? StationRoute!.toLngLat(model, [2000, 2000]) : u.ll || StationRoute!.toLngLat(model, u.xy!);
        Station3D.setUser({ ll, accuracy: acc, heading: fixedHeading == null ? undefined : fixedHeading });
      }
      if (q.get('sim') === 'walk') startSim();
      if (q.has('face')) face(+q.get('face')!, +q.get('tilt')! || 0);
    });
    Station3D.on('pick', (e) => {
      out.textContent = `${e.title || 'ground'} · L${e.level} · ${e.xy.map((v) => v.toFixed(1)).join(', ')}`;
      if (placing) Station3D.setUser({ ll: e.ll, accuracy: acc, heading: fixedHeading == null ? undefined : fixedHeading });
    });
    Station3D.on('step', (e) => { if (!sim) out.textContent = e.index < 0 ? 'overview' : `step ${e.index + 1}`; });
    Station3D.on('close', () => { stopSim(); out.textContent = 'closed'; });
    // the walk that plays by itself: what it tells the page
    for (const name of ['arrived', 'progress', 'play'] as const) {
      Station3D.on(name, (e) => {
        events.push({ t: Math.round(performance.now()), name, e });
        if (events.length > 600) events.shift();
        if (name === 'progress') return;
        console.log('Station3D', name, e);
        out.textContent = name === 'arrived' ? `arrived by ${(e as Station3DEventMap['arrived']).by}` : e ? 'playing' : 'paused';
      });
    }
  }
  const events: DevEvent[] = [];
  wire();
  // DEV.reload({ key, from, to, theme, … }): load the current station3d.js / .css again and reopen, without
  // reloading the page. from / to as in the URL ("stop:8507000:7"); null clears one.
  let shadow: ShadowRoot | null = null;
  function reload(over?: DevReload) {
    over = over || {};
    stopSim();
    if (window.Station3D && Station3D.isOpen()) Station3D.close();
    Station3D.setUser(null);
    for (const k of Object.keys(over)) {
      if (k === 'theme') document.documentElement.dataset.theme = over.theme;
      else if (k === 'from' || k === 'to') options[k] = typeof over[k] === 'string' ? endpoint(over[k]) as Station3DEndpoint | null : over[k];
      else (options as DevOptionsByName)[k] = (over as Record<string, unknown>)[k];
    }
    const v = Date.now();
    return new Promise<'error' | void>((resolve) => {
      const fresh = () => {
        document.querySelectorAll('script[data-s3]').forEach((n) => n.remove());
        const sc = document.createElement('script');
        sc.dataset.s3 = '1';
        sc.src = 'station3d.js?v=' + v;
        sc.onload = () => {
          wire();
          Station3D.on('open', () => setTimeout(resolve, over.wait == null ? 2200 : over.wait));
          Station3D.on('error', () => resolve('error'));
          Station3D.open(options);
        };
        document.head.appendChild(sc);
      };
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'station3d.css?v=' + v;
      link.onload = link.onerror = () => setTimeout(fresh, 600); // let the closing view finish first
      const where = shadow || document.head;
      where.querySelectorAll('link[href*="station3d.css"]').forEach((n) => n.remove());
      document.head.querySelectorAll('link[href*="station3d.css"]').forEach((n) => n.remove());
      where.appendChild(link);
    });
  }

  document.getElementById('dTheme')!.onclick = () => {
    const r = document.documentElement;
    r.dataset.theme = r.dataset.theme === 'dark' ? 'light' : 'dark';
  };
  document.getElementById('dWalk')!.onclick = () => (sim ? stopSim() : startSim());
  document.getElementById('dPlace')!.onclick = () => { placing = !placing; press('dPlace', placing); };
  document.getElementById('dNoUser')!.onclick = () => { stopSim(); Station3D.setUser(null); };
  document.getElementById('dReopen')!.onclick = () => Station3D.open(options);
  document.getElementById('dFar')!.onclick = () => { stopSim(); if (model) Station3D.setUser({ ll: StationRoute!.toLngLat(model, [2000, 2000]), accuracy: 30 }); };
  // take the graphics memory away, then give it back (what a phone does to a tab in the background)
  let glExt: WEBGL_lose_context | null = null;
  document.getElementById('dGl')!.onclick = () => {
    const d = Station3D._debug();
    if (!d || !d.renderer) return;
    if (!glExt) { glExt = (d.renderer as THREE.WebGLRenderer).getContext().getExtension('WEBGL_lose_context'); if (glExt) glExt.loseContext(); press('dGl', true); }
    else { glExt.restoreContext(); glExt = null; press('dGl', false); }
  };

  (window as DevWindow).DEV = { options, startSim, stopSim, reload, face, events };
  if (q.get('quiet') === '1') {
    // The viewer goes into a closed shadow tree: automated snapshots then show the picture without listing
    // every label and step. Styles have to be loaded inside it as well.
    document.querySelector('main')!.hidden = true;
    const host = document.createElement('div');
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: 'closed' });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'station3d.css?v=' + Date.now();
    link.onload = () => Station3D.open(options);
    shadow.appendChild(link);
    options.mount = shadow;
    (window as DevWindow).DEV.shadow = shadow;
  } else Station3D.open(options);
}
