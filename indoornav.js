// Indoor position for the 3D station view: ties indoorloc.js (the filter and the phone's sensors) and signloc.js
// (signs read by Scan) to station3d.js. Loaded by index.html; does nothing until a station is opened in 3D.
//
//   - When Station3D opens a station, the station's model is loaded and an indoor Filter starts. If the route starts
//     on a platform (you just got off a train there) and GPS does not say you are elsewhere, it starts there too.
//   - GPS fixes go through INDOORNAV.setUser(...) instead of Station3D.setUser(...): near the station they are evidence
//     for the filter (weak indoors), and the filter's estimate is what the viewer shows, with its floor. Fixes far
//     from the station go to the viewer unchanged (it then says you are not there).
//   - The phone's motion sensors (steps, heading) and, in a native wrapper, the barometer start with the view on
//     Android; on iOS with the first tap in the view (the user gesture iOS needs to ask for motion access).
//   - The station session outlives the 3D view by 10 minutes: close it, read a sign with Scan, open it again, and
//     the sign has counted and the steps in between too. Text that Scan reads ('scan:text' events from
//     stopvision.js) is matched against the station: a platform sign with its sector letter, an exit, a named
//     underpass or hall, a shop.
//   - INDOORNAV.record() / stopRecording() keep a raw sensor log for tuning (export with .exportLog()).
//
// INDOORNAV.state() → { active, open, away, key, sensors, estimate } for a debug panel.
(function () {
  'use strict';

  const PUSH_MS = 250;          // at most 4 updates a second to the viewer
  const RETAIN_MS = 10 * 60e3;  // a closed station's session stays this long (Scan, a quick look at the map)
  const FAR_M = 300;            // a fix this far outside the model: not at this station
  const SIGN_REPEAT_MS = 15e3;  // the same text read again within this time is the same sign

  let ses = null;               // { key, model, filter, sensors, open, closedAt, retainTimer }
  let recorder = null, lastGps = null, away = false;
  let lastPush = 0, pushTimer = null;
  const recentSigns = new Map();
  const PENDING_SIGN_MS = 120e3; // a sign read before a station is open still counts when it opens within this time
  let pendingSigns = [];          // [{ text, at }] (at: Date.now() of the reading)

  const S3 = () => window.Station3D;
  const nowS = () => performance.now() / 1000;

  // metres a local point lies outside the model's bounding box (0 inside)
  function outside(model, x, y) {
    const b = model.raw.bbox;
    if (!b) return 0;
    return Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - y, 0, y - b[3]));
  }

  // the estimate → the viewer (only while it shows this station and GPS does not say we are elsewhere)
  function push() {
    if (!ses || !ses.filter || !ses.open || away || !S3()) return;
    const go = () => {
      lastPush = performance.now(); pushTimer = null;
      if (!ses || !ses.filter || !ses.open || away) return;
      const e = ses.filter.estimate();
      if (!e || e.state !== 'tracking') return;
      // a hesitant estimate shows as a wide circle: the floor is said only when one floor clearly wins
      const acc = Math.max(3, e.sigma * (e.confident ? 1.5 : 2.5));
      const heading = ses.sensors && ses.sensors.heading != null ? ses.sensors.heading : lastGps && lastGps.heading;
      S3().setUser({ xy: [e.x, e.y], level: e.levelProb > 0.6 ? e.level : undefined, levelSure: e.confident, accuracy: acc, heading });
    };
    const wait = PUSH_MS - (performance.now() - lastPush);
    if (wait <= 0) go();
    else if (!pushTimer) pushTimer = setTimeout(go, wait);
  }

  function end() {
    if (!ses) return;
    if (ses.sensors) { try { ses.sensors.stop(); } catch (e) {} }
    clearTimeout(ses.retainTimer);
    ses = null;
    away = false;
    clearTimeout(pushTimer); pushTimer = null;
  }

  // the journey: a route that starts on a platform means you are standing on it (unless GPS says otherwise)
  function journeyPrior(route) {
    if (!ses || !ses.filter || away || !route || !route.fromStop || !route.points || !route.points.length) return;
    const k = route.fromStop.uic + ':' + route.fromStop.ref;
    if (k === ses.fromKey) return;       // the same start as before: we have moved on from it since
    ses.fromKey = k;
    const est = ses.filter.estimate();
    const [x, y, level] = route.points[0];
    const li = ses.model.floorOf(level);
    // a sure estimate elsewhere wins over a new route's start (the traveller may plan ahead); otherwise start there
    if (est.state === 'tracking' && est.confident && (est.li !== li || Math.hypot(est.x - x, est.y - y) > 80)) return;
    ses.filter.prior({ x, y, r: 60, li });
  }

  async function opened(info) {
    if (!info || !info.key || !window.INDOORLOC) return;
    if (ses && ses.key === info.key) {          // the same station again: carry on (a new journey start counts)
      clearTimeout(ses.retainTimer); ses.open = true; ses.closedAt = null;
      if (ses.filter) { journeyPrior(info.route); push(); } else ses.pendingRoute = info.route;
      return;
    }
    end();
    const mine = (ses = { key: info.key, model: null, filter: null, sensors: null, open: true, closedAt: null });
    const model = await window.INDOORLOC.load(info.key);
    if (ses !== mine || !model) { if (ses === mine) ses = null; return; }
    mine.model = model;
    mine.filter = new window.INDOORLOC.Filter(model);
    mine.filter.on(push);
    const fresh = lastGps && performance.now() - lastGps.at < 60e3 ? lastGps : null;
    if (fresh) setUser(fresh.u, true);           // what GPS knows now (also decides whether we are here at all)
    journeyPrior(mine.pendingRoute || info.route);
    mine.pendingRoute = null;
    // signs Scan read before the station was open (even before this script loaded): recent ones count now
    const keep = pendingSigns.filter((p) => Date.now() - p.at < PENDING_SIGN_MS);
    pendingSigns = [];
    for (const p of keep) sign(p.text);
    // no permission to ask (Android, desktop): start the sensors now; iOS asks on the first tap in the view
    const D = window.DeviceMotionEvent, O = window.DeviceOrientationEvent;
    if (!(D && typeof D.requestPermission === 'function') && !(O && typeof O.requestPermission === 'function')) startSensors();
  }

  function closed() {
    if (!ses) return;
    ses.open = false; ses.closedAt = performance.now();
    clearTimeout(pushTimer); pushTimer = null;
    clearTimeout(ses.retainTimer);
    ses.retainTimer = setTimeout(end, RETAIN_MS);
    // the viewer keeps the last position for its next opening: give it back the plain GPS fix (not this station's
    // local coordinates, which would be wrong in another station)
    if (S3()) S3().setUser(lastGps ? lastGps.u : null);
  }

  // called from a tap on iOS: motion + orientation permission (GPS is fed by the app)
  function startSensors() {
    if (!ses || !ses.filter || ses.sensors) return Promise.resolve(ses && ses.sensors && ses.sensors.state);
    ses.sensors = new window.INDOORLOC.Sensors(ses.filter, { onRaw: (type, d) => { if (recorder) recorder.add(type, d); }, noGeo: true });
    return ses.sensors.start();
  }

  // GPS from the app (same argument as Station3D.setUser: { ll, accuracy, heading })
  function setUser(u, replay) {
    if (!hook.done) hook();   // the viewer may load after the page (lazy loading): hook in as soon as it is there
    if (u && u.ll && !replay) lastGps = { u, at: performance.now(), heading: u.heading };
    if (!ses || !ses.filter || !u || !u.ll) { if (S3() && !(ses && ses.open && ses.filter)) S3().setUser(u); return; }
    const [x, y] = ses.model.fromLngLat(u.ll[0], u.ll[1]);
    const wasAway = away;
    away = outside(ses.model, x, y) - (u.accuracy || 0) > FAR_M;
    if (away || !ses.open) { if (S3()) S3().setUser(u); } // not here (the viewer says so), or the viewer is closed
    if (away) return;
    if (recorder) recorder.add('gps', { lon: u.ll[0], lat: u.ll[1], acc: u.accuracy });
    ses.filter.gps({ t: nowS(), lon: u.ll[0], lat: u.ll[1], acc: u.accuracy || 30 });
    if (wasAway) lastPush = 0;
    push();
  }

  // a sign read by Scan (or typed in) → evidence; the same text again within 15 s is the same sign
  function sign(text, at) {
    if (!text) return null;
    if (!ses || !ses.filter || !window.SIGNLOC) {
      pendingSigns = pendingSigns.filter((p) => Date.now() - p.at < PENDING_SIGN_MS).concat([{ text, at: at || Date.now() }]).slice(-5);
      return null;
    }
    const key = window.SIGNLOC.norm(text);
    const t = performance.now();
    for (const [k, at] of recentSigns) if (t - at > SIGN_REPEAT_MS) recentSigns.delete(k);
    const r = window.SIGNLOC.match(text, ses.model);
    if (recentSigns.has(key)) return Object.assign(r, { repeated: true });
    recentSigns.set(key, t);
    if (recorder) recorder.add('sign', { text, explain: r.explain });
    if (r.observations.length) { window.SIGNLOC.apply(ses.filter, r, nowS()); push(); }
    return r;
  }

  function hook() {
    const s3 = S3();
    if (!s3 || hook.done) return;
    hook.done = true;
    s3.on('open', opened);
    s3.on('close', closed);
  }
  // iOS: motion access may only be asked from a tap. The first tap while a station is open is that tap (the
  // viewer's own compass request, for its heading, comes from a tap too, so the traveller sees one prompt).
  // Only a tap inside the 3D view counts, and not its close button.
  document.addEventListener('click', (e) => {
    if (!ses || !ses.open || !ses.filter || ses.sensors) return;
    const path = e.composedPath ? e.composedPath() : [e.target];
    const has = (cls) => path.some((n) => n && n.classList && n.classList.contains(cls));
    if (has('s3') && !has('s3-close')) startSensors();
  }, true);
  window.addEventListener('scan:text', (e) => sign(e.detail && e.detail.text, e.detail && e.detail.at));
  if (S3()) hook(); else window.addEventListener('load', hook);

  window.INDOORNAV = {
    setUser: (u) => setUser(u, false), sign: (text) => sign(text), startSensors,
    // a viewer that was already opening when this script arrived (a late load): start with that opening
    attach: (info) => { hook(); return opened(info); },
    // the traveller says where they are: { level } (a floor), and maybe { xy } (a tap on the model)
    here: (o) => { if (ses && ses.filter) { ses.filter.prior({ level: o.level, x: o.xy && o.xy[0], y: o.xy && o.xy[1], r: o.xy ? 15 : 60 }); push(); } },
    record: () => { recorder = new window.INDOORLOC.Recorder({ key: ses && ses.key }); return recorder; },
    stopRecording: () => { const r = recorder; recorder = null; return r; },
    exportLog: (r) => new Blob([JSON.stringify((r || recorder).toJSON())], { type: 'application/json' }),
    state: () => ({ active: !!(ses && ses.filter), open: !!(ses && ses.open), away, key: ses && ses.key,
      sensors: ses && ses.sensors && ses.sensors.state, estimate: ses && ses.filter && ses.filter.estimate() }),
    _filter: () => ses && ses.filter,
  };
})();
