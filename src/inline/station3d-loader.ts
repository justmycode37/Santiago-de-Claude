// window.Station3D is the page's one way into a station in 3D. Behind it is the station view (station-view.js,
// docs/station3d-solid.md): the continuous model of the inside of the station (station3d-solid.js) in an overlay over
// the map, with the walk step by step. It is loaded the first time it is needed, not at start-up; until then this
// stand-in keeps the listeners and the latest GPS fix for it.
// Drawing a station's walk on the 2D map does not need it: loadData() loads just the model and the router.
// The indoor position (indoorloc.js, signloc.js, indoornav.js) loads at the first opening and never holds anything
// up: when it arrives it joins the opening that is showing then. If those three fail, the view works without them
// and they are tried again at the next opening.
(function () {
  type Heard = [name: keyof Station3DEventMap, fn: (detail: never) => void];
  type Opened = Station3DEventMap['open'];
  type AnyFn = (detail: unknown) => void;
  let indoor: Promise<void> | null = null, svLoading: Promise<StationViewApi> | null = null;
  let user: Station3DUser | null | undefined, userAt = 0;   // the latest GPS fix and when it came (performance.now())
  let wanted: Station3DOpenOptions | null = null;      // the latest open() asked for while the view loads (close() cancels it)
  let lastOpen: Opened | null = null;    // what the view last opened (for the indoor position when it arrives later)
  const listeners: Heard[] = [];         // every listener, for the view once it has loaded
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
  const svOpen = () => !!(window.StationView && window.StationView.isOpen());
  function loadIndoor() {
    if (!indoor) indoor = Promise.all([window.INDOORLOC ? null : script('indoorloc.js'), window.SIGNLOC ? null : script('signloc.js')])
      .then(() => (window.INDOORNAV ? null : script('indoornav.js')))
      .then(() => {
        // what the stand-in kept: the latest GPS fix (with its own time, so indoornav.js keeps a newer one it
        // may already have), and signs read before (they still count if recent)
        if (user !== undefined && recent(user) && window.INDOORNAV) window.INDOORNAV.setUser(user, userAt);
        window.removeEventListener('scan:text', onScan as EventListener);
        for (const s of scans.splice(0)) window.dispatchEvent(new CustomEvent('scan:text', { detail: s }));
        // the view opened before these scripts were there: the indoor position joins the opening showing now
        // (the latest one: a station closed meanwhile is not attached)
        if (window.INDOORNAV && lastOpen && svOpen()) window.INDOORNAV.attach(lastOpen);
      })
      .catch((e) => {
        // not fatal: the view works without it, and the next opening tries again
        indoor = null;
        console.warn(e.message);
      });
    return indoor;
  }
  function loadView(): Promise<StationViewApi> {
    if (!svLoading) svLoading = scriptOnce('station-view.js').then(() => {
      const sv = window.StationView;
      if (!sv) throw new Error('station-view.js did not start');
      for (const [name, fn] of listeners) sv.on(name, fn as AnyFn);
      // the indoor position follows what the view shows
      sv.on('open', (info) => { lastOpen = info; if (!window.INDOORNAV) loadIndoor(); });
      sv.on('close', () => { lastOpen = null; });
      // another station on its way (it replaces the one showing without a 'close'): only its own 'open' counts
      sv.on('opening', () => { lastOpen = null; });
      if (user !== undefined && recent(user)) sv.setUser(user);
      return sv;
    }, (e) => { svLoading = null; throw e; });
    return svLoading;
  }
  function failed(opts: Station3DOpenOptions) {
    if (wanted !== opts) return;   // closed or replaced meanwhile: nobody is waiting for this one
    wanted = null;
    if (window.showToast) window.showToast('The 3D view could not be loaded.');
    // as the view itself reports it (Station3D.on('error'))
    const err = { code: 'three', message: 'Check your connection, then try again.' };
    for (const [name, fn] of listeners.slice()) if (name === 'error') { try { fn(err as never); } catch (e) { console.error(e); } }
  }
  const stub: Station3DApi = window.Station3D = {
    has: (uic) => (window.STATION3D_INDEX && window.STATION3D_INDEX[String(uic)]) || null,
    open: (opts) => {
      wanted = opts;
      loadView().then((sv) => sv.ready().then(() => sv)).then((sv) => {
        if (wanted !== opts) return;
        if (!sv.has(opts.key)) { console.warn('No continuous 3D model for ' + opts.key); failed(opts); return; }
        wanted = null;
        sv.open(opts);
        loadIndoor();
      }, () => failed(opts));
    },
    setUser: (u) => { user = u || null; userAt = performance.now(); if (window.StationView) window.StationView.setUser(u); },
    close: () => { wanted = null; if (svOpen()) window.StationView!.close(); },
    isOpen: () => wanted !== null || svOpen(),   // an opening is on its way: callers that close an open view cancel it
    on: (name, fn) => {
      listeners.push([name, fn as (detail: never) => void]);
      if (window.StationView && svLoading) window.StationView.on(name, fn);
      return () => stub.off(name, fn);
    },
    off: (name, fn) => {
      const i = listeners.findIndex(([n, f]) => n === name && f === fn);
      if (i >= 0) listeners.splice(i, 1);
      if (window.StationView) window.StationView.off(name, fn);
    },
    // ahead of an open: the station view with this station, and the indoor position alongside (not waited for), so
    // it is ready when the view opens
    preload: (key) => {
      loadIndoor();
      return loadView().then((sv) => sv.ready().then(() => (key && sv.has(key) ? sv.preload(key) : false)), () => false);
    },
    // the model and the router (no 3D): for a station's walk on the 2D map
    loadData: (key) => {
      if (!/^[a-z0-9-]+$/.test(String(key))) return Promise.resolve(null);
      const have = () => window.STATION3D && window.STATION3D[key];
      return Promise.all([have() ? null : scriptOnce('stations3d/' + key + '.js'), window.StationRoute ? null : scriptOnce('station-route.js')])
        .then(() => (have() && window.StationRoute ? have()! : null), () => null);
    },
  };
})();
