// The 3D station viewer (station3d.js, ~260 KB) loads the first time it is needed, not at start-up: a tap on
// "3D view", or a journey through a station that has a model (its walk is drawn from the model, and the viewer
// is preloaded). Until then this stand-in answers has() from stations3d/index.js and passes every other call on
// once the viewer is there. station3d.js then replaces window.Station3D with itself.
(function () {
  let loading = null;
  let user;
  let wanted = null;      // the latest open() asked for while loading; close() cancels it
  const listeners = [];
  function load() {
    if (!loading) loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'station3d.js';
      s.onload = () => {
        const real = window.Station3D;
        if (!real || real === stub) { loading = null; s.remove(); reject(new Error('station3d.js did not start')); return; }
        for (const [name, fn] of listeners) real.on(name, fn);
        if (user !== undefined) real.setUser(user);
        resolve(real);
      };
      s.onerror = () => { loading = null; s.remove(); reject(new Error('Could not load station3d.js')); };
      document.head.appendChild(s);
    });
    return loading;
  }
  const stub = window.Station3D = {
    has: (uic) => (window.STATION3D_INDEX && window.STATION3D_INDEX[String(uic)]) || null,
    open: (opts) => {
      wanted = opts;
      load().then((real) => {
        if (wanted !== opts) return; // a later open() or a close() came while it loaded
        wanted = null;
        real.open(opts);
      }, (e) => {
        if (wanted !== opts) return;
        wanted = null;
        // the listeners hear it as from the viewer (onboarding's demo is behind an overlay the toast cannot reach)
        for (const [name, fn] of listeners.slice()) if (name === 'error') { try { fn({ message: e.message }); } catch (err) {} }
        if (window.showToast) window.showToast('The 3D view could not be loaded.');
      });
    },
    setUser: (u) => { user = u || null; },
    close: () => { wanted = null; },
    isOpen: () => wanted !== null, // "opening" counts as open, so whoever closes it cancels the pending open
    on: (name, fn) => { listeners.push([name, fn]); return () => stub.off(name, fn); },
    off: (name, fn) => {
      const i = listeners.findIndex(([n, f]) => n === name && f === fn);
      if (i >= 0) listeners.splice(i, 1);
      if (window.Station3D !== stub) window.Station3D.off(name, fn);
    },
    selectStep: () => {}, setFollow: () => {}, setPov: () => {}, setPeel: () => {},
    play: () => false, pause: () => {}, isPlaying: () => false,
    enableCompass: () => load().then((real) => real.enableCompass(), () => 'unavailable'),
    preload: (key) => load().then((real) => real.preload(key), () => false),
    loadData: (key) => load().then((real) => real.loadData(key), () => null),
  };
})();
