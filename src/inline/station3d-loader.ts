// The 3D station viewer (station3d.js, ~260 KB) loads the first time it is needed, not at start-up: a tap on
// "3D view", or a journey through a station that has a model (its walk is drawn from the model, and the viewer
// is preloaded). Until then this stand-in answers has() from stations3d/index.js and passes every other call on
// once the viewer is there. station3d.js then replaces window.Station3D with itself.
// The indoor position (indoorloc.js, signloc.js, indoornav.js) loads at the viewer's first opening, however it
// opens (through this stand-in, or straight on the real viewer after a preload() or loadData() brought it), and
// never holds anything up: when it arrives it joins the opening that is showing then. If those three fail, the
// viewer works without them and they are tried again at its next opening.
(function () {
  let loading = null, indoor = null;
  let user, userAt = 0;   // the latest GPS fix and when it came (performance.now())
  let wanted = null;      // the latest open() asked for while station3d.js loads (close() cancels it)
  let lastOpen = null;    // what the real viewer last opened (for the indoor position when it arrives later)
  const listeners = [];
  const scans = [];       // text Scan read before the indoor scripts were there: { text, at }
  const onScan = (e) => { if (!window.INDOORNAV && e.detail && e.detail.text) scans.push({ text: e.detail.text, at: e.detail.at || Date.now() }); };
  window.addEventListener('scan:text', onScan);
  const script = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error('Could not load ' + src)); };
    document.head.appendChild(s);
  });
  // a remembered fix is handed on only while it is recent (u.at: when it was taken); an older one would show as
  // where you are now
  const recent = (u) => !u || u.at == null || Date.now() - u.at < 60e3;
  function loadIndoor() {
    if (!indoor) indoor = Promise.all([window.INDOORLOC ? null : script('indoorloc.js'), window.SIGNLOC ? null : script('signloc.js')])
      .then(() => (window.INDOORNAV ? null : script('indoornav.js')))
      .then(() => {
        // what the stand-in kept: the latest GPS fix (with its own time, so indoornav.js keeps a newer one it
        // may already have), and signs read before (they still count if recent)
        if (user !== undefined && recent(user) && window.INDOORNAV) window.INDOORNAV.setUser(user, userAt);
        window.removeEventListener('scan:text', onScan);
        for (const s of scans.splice(0)) window.dispatchEvent(new CustomEvent('scan:text', { detail: s }));
        // the viewer opened before these scripts were there: the indoor position joins the opening showing now
        // (the latest one: a station closed meanwhile is not attached)
        const real = window.Station3D;
        if (window.INDOORNAV && lastOpen && real && real !== stub && real.isOpen()) window.INDOORNAV.attach(lastOpen);
      })
      .catch((e) => {
        // not fatal: the viewer works without it, and the next opening tries again (see loadViewer)
        indoor = null;
        console.warn(e.message);
      });
    return indoor;
  }
  // the viewer alone (the indoor scripts come after it, and never hold up an opening)
  function loadViewer() {
    if (!loading) loading = new Promise((resolve, reject) => {
      script('station3d.js').then(() => {
        const real = window.Station3D;
        if (!real || real === stub) {
          loading = null;
          const s = document.querySelector('script[src="station3d.js"]');
          if (s) s.remove();
          reject(new Error('station3d.js did not start'));
          return;
        }
        for (const [name, fn] of listeners) real.on(name, fn);
        // every opening of the real viewer, however it came: the indoor position loads (or is tried again)
        real.on('open', (info) => { lastOpen = info; if (!window.INDOORNAV) loadIndoor(); });
        real.on('close', () => { lastOpen = null; });
        // another station on its way (it replaces the one showing without a 'close'): only its own 'open' counts
        real.on('opening', () => { lastOpen = null; });
        if (user !== undefined && recent(user)) real.setUser(user);
        // until indoornav.js is there, the page's GPS goes straight to the real viewer: keep noting the latest
        // fix, so the indoor position starts from it and not from an older one the stand-in had
        const own = real.setUser;
        real.setUser = function (u) {
          if (!window.INDOORNAV) { user = u || null; userAt = performance.now(); }
          return own.apply(this, arguments);
        };
        resolve(real);
      }, (e) => { loading = null; reject(e); });
    });
    return loading;
  }
  const stub = window.Station3D = {
    has: (uic) => (window.STATION3D_INDEX && window.STATION3D_INDEX[String(uic)]) || null,
    open: (opts) => {
      wanted = opts;
      loadViewer().then((real) => {
        // only the latest open() counts, and not if close() came meanwhile. The real viewer opens in the same
        // task as station3d.js arrives: there is no moment when it is there but not yet open (a skipped
        // onboarding demo closes it with Station3D.close(), whichever of the two answers)
        if (wanted !== opts) return;
        wanted = null;
        real.open(opts);
        loadIndoor();   // already on its way if the viewer said 'open'; this covers a viewer that says it later
      }, () => {
        if (wanted !== opts) return;   // closed or replaced meanwhile: nobody is waiting for this one
        wanted = null;
        if (window.showToast) window.showToast('The 3D view could not be loaded.');
        // as the viewer itself reports it (Station3D.on('error')): the onboarding demo then offers Continue
        const err = { code: 'three', message: 'Check your connection, then try again.' };
        for (const [name, fn] of listeners.slice()) if (name === 'error') { try { fn(err); } catch (e) { console.error(e); } }
      });
    },
    setUser: (u) => { user = u || null; userAt = performance.now(); },
    close: () => { wanted = null; },
    isOpen: () => wanted !== null,   // an opening is on its way: callers that close an open view cancel it
    on: (name, fn) => { listeners.push([name, fn]); return () => stub.off(name, fn); },
    off: (name, fn) => {
      const i = listeners.findIndex(([n, f]) => n === name && f === fn);
      if (i >= 0) listeners.splice(i, 1);
      if (window.Station3D !== stub) window.Station3D.off(name, fn);
    },
    selectStep: () => {}, setFollow: () => {}, setPov: () => {}, setPeel: () => {},
    play: () => false, pause: () => {}, isPlaying: () => false,   // nothing can be playing before the viewer is there
    enableCompass: () => loadViewer().then((real) => real.enableCompass(), () => 'unavailable'),
    // preloading fetches the indoor position too (alongside, not waited for), so it is ready when the view opens
    preload: (key) => loadViewer().then((real) => { loadIndoor(); return real.preload(key); }, () => false),
    loadData: (key) => loadViewer().then((real) => real.loadData(key), () => null),
  };
})();
