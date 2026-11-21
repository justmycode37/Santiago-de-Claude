// window.Station3D is the page's one way into a station in 3D. Two viewers stand behind it, both loaded the first time
// they are needed, not at start-up:
//   - the station view (station-view.js, docs/station-view.md): the continuous model of the inside of the station
//     (station3d-solid.js) in an overlay over the map, with the walk step by step. Every open() goes there when the
//     station has a continuous model (stations3d/solid-index.js);
//   - the first 3D viewer (station3d.js, ~260 KB), for what only it does: the onboarding demo's first-person walk in a
//     box of its own (open({ mount, pov, play })), and stations without a continuous model.
// Drawing a station's walk on the 2D map needs neither: loadData() loads just the model and the router.
// Until station3d.js is there this stand-in answers for it; once it is, station3d.js replaces window.Station3D with
// itself, and its open(), close(), isOpen(), on(), off(), setUser(), preload() and loadData() are wrapped so that they
// still reach the station view.
// The indoor position (indoorloc.js, signloc.js, indoornav.js) loads at the first opening of either viewer and never
// holds anything up: when it arrives it joins the opening that is showing then. If those three fail, the viewers work
// without them and they are tried again at the next opening.
(function () {
  /** What the stand-in answers itself; `_orient` and `_debug` only the real viewer has. */
  type Station3DStandIn = Omit<Station3DApi, '_orient' | '_debug'>;
  type Heard = [name: keyof Station3DEventMap, fn: (detail: never) => void];
  type Opened = Station3DEventMap['open'];
  type AnyFn = (detail: unknown) => void;
  /** What both viewers answer: their events and the position. */
  interface Viewer {
    on(name: string, fn: AnyFn): unknown;
    off(name: string, fn: AnyFn): void;
    setUser(u: Station3DUser | null | undefined): void;
    isOpen(): boolean;
  }
  let loading: Promise<Station3DApi> | null = null, indoor: Promise<void> | null = null, svLoading: Promise<StationViewApi> | null = null;
  let legacyOpen: Station3DApi['open'] | null = null;   // station3d.js's own open(), before it is wrapped
  let user: Station3DUser | null | undefined, userAt = 0;   // the latest GPS fix and when it came (performance.now())
  let wanted: Station3DOpenOptions | null = null;      // the latest open() asked for while a viewer loads (close() cancels it)
  let lastOpen: Opened | null = null;    // what a viewer last opened (for the indoor position when it arrives later)
  const listeners: Heard[] = [];         // every listener, for whichever viewer loads (and for both)
  const scans: ScanTextDetail[] = [];    // text Scan read before the indoor scripts were there: { text, at }
  const onScan = (e: CustomEvent<ScanTextDetail>) => { if (!window.INDOORNAV && e.detail && e.detail.text) scans.push({ text: e.detail.text, at: e.detail.at || Date.now() }); };
  window.addEventListener('scan:text', onScan as EventListener);
  const script = (src: string) => new Promise<unknown>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error('Could not load ' + src)); };
    document.head.appendChild(s);
  });
  const once = new Map<string, Promise<unknown>>();
  const scriptOnce = (src: string) => {
    if (!once.has(src)) once.set(src, script(src).catch((e) => { once.delete(src); throw e; }));
    return once.get(src)!;
  };
  // a remembered fix is handed on only while it is recent (u.at: when it was taken); an older one would show as
  // where you are now
  const recent = (u: Station3DUser | null) => !u || u.at == null || Date.now() - u.at < 60e3;
  const legacy = () => (loading && window.Station3D !== stub ? window.Station3D : null);
  const svOpen = () => !!(window.StationView && window.StationView.isOpen());
  // what goes to the station view: everything but the onboarding demo's walk in a box of its own
  const forView = (o: Station3DOpenOptions) => !(o && (o.mount || o.pov || o.play || o.modal === false));
  function loadIndoor() {
    if (!indoor) indoor = Promise.all([window.INDOORLOC ? null : script('indoorloc.js'), window.SIGNLOC ? null : script('signloc.js')])
      .then(() => (window.INDOORNAV ? null : script('indoornav.js')))
      .then(() => {
        // what the stand-in kept: the latest GPS fix (with its own time, so indoornav.js keeps a newer one it
        // may already have), and signs read before (they still count if recent)
        if (user !== undefined && recent(user) && window.INDOORNAV) window.INDOORNAV.setUser(user, userAt);
        window.removeEventListener('scan:text', onScan as EventListener);
        for (const s of scans.splice(0)) window.dispatchEvent(new CustomEvent('scan:text', { detail: s }));
        // a viewer opened before these scripts were there: the indoor position joins the opening showing now
        // (the latest one: a station closed meanwhile is not attached)
        const real = legacy();
        if (window.INDOORNAV && lastOpen && (svOpen() || (real && real.isOpen()))) window.INDOORNAV.attach(lastOpen);
      })
      .catch((e) => {
        // not fatal: the viewer works without it, and the next opening tries again
        indoor = null;
        console.warn(e.message);
      });
    return indoor;
  }
  // both viewers say what they open the same way: the indoor position follows whichever is showing
  function track(v: Viewer) {
    v.on('open', (info) => { lastOpen = info as Opened; if (!window.INDOORNAV) loadIndoor(); });
    v.on('close', () => { lastOpen = null; });
    // another station on its way (it replaces the one showing without a 'close'): only its own 'open' counts
    v.on('opening', () => { lastOpen = null; });
  }
  // the station view (station-view.js)
  function loadView(): Promise<StationViewApi> {
    if (!svLoading) svLoading = scriptOnce('station-view.js').then(() => {
      const sv = window.StationView;
      if (!sv) throw new Error('station-view.js did not start');
      const v = sv as unknown as Viewer;
      for (const [name, fn] of listeners) v.on(name, fn as AnyFn);
      track(v);
      if (user !== undefined && recent(user)) sv.setUser(user);
      return sv;
    }, (e) => { svLoading = null; throw e; });
    return svLoading;
  }
  function addListener(name: keyof Station3DEventMap, fn: (detail: never) => void, toLegacy: boolean) {
    listeners.push([name, fn]);
    if (window.StationView && svLoading) (window.StationView as unknown as Viewer).on(name, fn as AnyFn);
    const real = legacy();
    if (toLegacy && real) (real as unknown as Viewer).on(name, fn as AnyFn);
  }
  function dropListener(name: keyof Station3DEventMap, fn: (detail: never) => void) {
    const i = listeners.findIndex(([n, f]) => n === name && f === fn);
    if (i >= 0) listeners.splice(i, 1);
    if (window.StationView) (window.StationView as unknown as Viewer).off(name, fn as AnyFn);
  }
  // the first viewer alone (the indoor scripts come after it, and never hold up an opening)
  function loadViewer() {
    if (!loading) loading = new Promise<Station3DApi>((resolve, reject) => {
      script('station3d.js').then(() => {
        const real = window.Station3D;
        if (!real || real === stub) {
          loading = null;
          const s = document.querySelector('script[src="station3d.js"]');
          if (s) s.remove();
          reject(new Error('station3d.js did not start'));
          return;
        }
        for (const [name, fn] of listeners) real.on(name, fn as (detail: unknown) => void);
        track(real as unknown as Viewer);
        if (user !== undefined && recent(user)) real.setUser(user);
        // from now on the page calls station3d.js itself: what it is asked goes on to the station view too
        const own = { open: real.open, close: real.close, isOpen: real.isOpen, on: real.on, off: real.off, setUser: real.setUser };
        legacyOpen = own.open;
        real.open = (opts) => { if (forView(opts)) stub.open(opts); else { stub.close(); own.open.call(real, opts); } };
        real.close = () => { stub.close(); own.close.call(real); };
        real.isOpen = () => own.isOpen.call(real) || wanted !== null || svOpen();
        real.on = ((name: keyof Station3DEventMap, fn: (detail: never) => void) => {
          own.on.call(real, name, fn as never); addListener(name, fn, false); return () => real.off(name, fn as never);
        }) as Station3DApi['on'];
        real.off = ((name: keyof Station3DEventMap, fn: (detail: never) => void) => { own.off.call(real, name, fn as never); dropListener(name, fn); }) as Station3DApi['off'];
        // until indoornav.js is there, the page's GPS goes straight to the viewers: keep noting the latest fix, so
        // the indoor position starts from it and not from an older one the stand-in had
        real.setUser = function (u) {
          if (!window.INDOORNAV) { user = u || null; userAt = performance.now(); }
          if (window.StationView) window.StationView.setUser(u);
          return own.setUser.call(real, u);
        };
        ownPreload = real.preload;
        real.preload = (key) => stub.preload(key);
        real.loadData = (key) => stub.loadData(key);
        resolve(real);
      }, (e) => { loading = null; reject(e); });
    });
    return loading;
  }
  function failed(opts: Station3DOpenOptions) {
    if (wanted !== opts) return;   // closed or replaced meanwhile: nobody is waiting for this one
    wanted = null;
    if (window.showToast) window.showToast('The 3D view could not be loaded.');
    // as the viewer itself reports it (Station3D.on('error')): the onboarding demo then offers Continue
    const err = { code: 'three', message: 'Check your connection, then try again.' };
    for (const [name, fn] of listeners.slice()) if (name === 'error') { try { fn(err as never); } catch (e) { console.error(e); } }
  }
  function openLegacy(opts: Station3DOpenOptions) {
    loadViewer().then((real) => {
      // only the latest open() counts, and not if close() came meanwhile. The real viewer opens in the same task as
      // station3d.js arrives: there is no moment when it is there but not yet open (a skipped onboarding demo closes
      // it with Station3D.close(), whichever of the two answers)
      if (wanted !== opts) return;
      wanted = null;
      if (svOpen()) window.StationView!.close();
      legacyOpen!.call(real, opts);
      loadIndoor();   // already on its way if the viewer said 'open'; this covers a viewer that says it later
    }, () => failed(opts));
  }
  const stub: Station3DApi = window.Station3D = {
    has: (uic) => (window.STATION3D_INDEX && window.STATION3D_INDEX[String(uic)]) || null,
    open: (opts) => {
      wanted = opts;
      if (!forView(opts)) { openLegacy(opts); return; }
      loadView().then((sv) => sv.ready().then(() => sv)).then((sv) => {
        if (wanted !== opts) return;
        if (!sv.has(opts.key)) { openLegacy(opts); return; }   // no continuous model: the first viewer
        wanted = null;
        const real = legacy();
        if (real && real.isOpen()) real.close();
        sv.open(opts);
        loadIndoor();
      }, () => openLegacy(opts));
    },
    setUser: (u) => { user = u || null; userAt = performance.now(); if (window.StationView) window.StationView.setUser(u); },
    close: () => { wanted = null; if (svOpen()) window.StationView!.close(); },
    isOpen: () => wanted !== null || svOpen(),   // an opening is on its way: callers that close an open view cancel it
    on: (name, fn) => { addListener(name, fn as (detail: never) => void, true); return () => stub.off(name, fn); },
    off: (name, fn) => {
      dropListener(name, fn as (detail: never) => void);
      const real = legacy();
      if (real) real.off(name, fn);
    },
    selectStep: () => {}, setFollow: () => {}, setPov: () => {}, setPeel: () => {},
    play: () => false, pause: () => {}, isPlaying: () => false,   // nothing can be playing before the viewer is there
    detail: () => null, redraw: () => {},                         // …and no detail scene is built
    enableCompass: () => loadViewer().then((real) => real.enableCompass(), () => 'unavailable'),
    // ahead of an open: the station view with this station (or the first viewer, for a station without a continuous
    // model), and the indoor position alongside (not waited for), so it is ready when the view opens
    preload: (key) => {
      loadIndoor();
      return loadView().then((sv) => sv.ready().then(() => (key && sv.has(key) ? sv.preload(key) : loadViewer().then((real) => legacyPreload(real, key)))), () => false);
    },
    // the model and the router (no 3D): for a station's walk on the 2D map
    loadData: (key) => {
      if (!/^[a-z0-9-]+$/.test(String(key))) return Promise.resolve(null);
      const have = () => window.STATION3D && window.STATION3D[key];
      return Promise.all([have() ? null : scriptOnce('stations3d/' + key + '.js'), window.StationRoute ? null : scriptOnce('station-route.js')])
        .then(() => (have() && window.StationRoute ? have()! : null), () => null);
    },
  } satisfies Station3DStandIn as Station3DStandIn as Station3DApi;
  // station3d.js's own preload (real.preload is wrapped to come back here)
  let ownPreload: Station3DApi['preload'] | null = null;
  function legacyPreload(real: Station3DApi, key: string | null | undefined) {
    if (!ownPreload) return Promise.resolve(false);
    return ownPreload.call(real, key);
  }
})();
