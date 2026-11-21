// Walking pace. With "Adjust to how I walk" on (Settings; off unless you turn it on), the app measures how fast you
// walk from the location fixes it gets anyway while it is open. At the next start it moves the walking speed to the
// stop of the slider (Slow … Fast) that fits your usual pace, and says so in a notice that stays until you close it.
// Privacy: all that is kept is each stretch's day, length and duration, in this browser's storage on this device.
// No positions are kept and nothing is sent anywhere. Turning the setting off deletes it.
// Also here: the developer tools at the bottom of Settings, which test all this with simulated walks.
(function () {
  const KEY = 'walk-pace';
  const STOPS = SETTINGS.speedPresets; // [{ label, kmh }], slow to fast

  // ---- Measuring ----
  const READ_S = 12;     // one pace reading spans at least this long, so the scatter of single fixes evens out
  const GAP_S = 45;      // fixes further apart than this don't belong to one stretch
  const MAX_ACC = 25;    // m: a less accurate fix can't measure a pace
  const WALK_MIN = 0.5;  // m/s: slower than this is standing (people who walk very slowly still count)
  const WALK_MAX = 2.3;  // m/s: faster than this is running or riding
  const MIN_S = 45;      // a stretch counts from this long…
  const MIN_M = 50;      // …and this far,
  const STRAIGHT = 0.5;  // …and when it led somewhere: start to end at least half its length (a drifting fix wanders on the spot)
  const MAX_S = 180;     // a longer walk is kept as several stretches
  // ---- Deciding ----
  const KEEP = 40;       // stretches kept, newest
  const KEEP_DAYS = 60;
  const NEED_WALKS = 3;  // nothing changes before this many stretches…
  const NEED_S = 480;    // …and this much walking
  const MARGIN = 0.15;   // km/h past the halfway point between two stops before the speed moves on

  // metres between two [lng, lat]
  function dist(a, b) {
    const k = Math.PI / 180;
    return Math.hypot((b[0] - a[0]) * k * Math.cos((a[1] + b[1]) / 2 * k), (b[1] - a[1]) * k) * 6371000;
  }

  // Turns location fixes ({ ll: [lng, lat], acc: metres, speed: m/s or nothing, t: ms }) into walked stretches
  // ({ s: seconds, m: metres }), each handed to commit.
  function makeTracker(commit) {
    let from = null;    // where the current reading began: { t, ll, speeds }
    let bout = null;    // the stretch being walked: { s, m, a, b }
    let riding = false; // a reading was too fast for walking and there was no standstill since
    function end() {
      const w = bout;
      bout = null;
      if (w && w.s >= MIN_S && w.m >= MIN_M && dist(w.a, w.b) >= STRAIGHT * w.m) commit({ s: w.s, m: w.m });
    }
    return {
      fix({ ll, acc, speed, t }) {
        if (!(acc <= MAX_ACC)) { end(); from = null; return; }
        if (!from || t < from.t || t - from.t > GAP_S * 1000) {
          end();
          riding = false;
          from = { t, ll, speeds: [] };
          return;
        }
        if (typeof speed === 'number' && speed >= 0) from.speeds.push(speed);
        const dt = (t - from.t) / 1000;
        if (dt < READ_S) return;
        // The phone's own speed (measured from the satellite signal) when it gives one, else distance over time
        const v = from.speeds.length >= 3 ? from.speeds.reduce((a, b) => a + b) / from.speeds.length : dist(from.ll, ll) / dt;
        const a = from.ll;
        from = { t, ll, speeds: [] };
        if (v > WALK_MAX) { bout = null; riding = true; return; } // also drops the stretch so far: a tram that crawled, then sped up
        if (v < WALK_MIN) { end(); riding = false; return; }
        if (riding) return; // a vehicle slowing down or crawling
        if (!bout) bout = { s: 0, m: 0, a, b: ll };
        bout.s += dt;
        bout.m += v * dt;
        bout.b = ll;
        if (bout.s >= MAX_S) end();
      },
      stop() { end(); from = null; riding = false; }, // the fixes end here (app in the background, end of a simulation)
      drop() { from = bout = null; riding = false; },
    };
  }

  // ---- What is kept: { walks: [{ d: day number, s, m }], notice: { from: km/h, to: km/h } or null } ----
  const data = { walks: [], notice: null };
  const isStop = (kmh) => STOPS.some((p) => p.kmh === kmh);
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && Array.isArray(saved.walks)) data.walks = saved.walks.filter((w) => w && w.s > 0 && w.m > 0 && Number.isFinite(w.d));
    if (saved && saved.notice && isStop(saved.notice.from) && isStop(saved.notice.to)) data.notice = saved.notice;
  } catch { /* starts empty */ }
  function save() {
    try {
      if (data.walks.length || data.notice) localStorage.setItem(KEY, JSON.stringify(data));
      else localStorage.removeItem(KEY);
    } catch { /* not saved, still applied for this visit */ }
  }
  const on = () => SETTINGS.prefs().autoSpeed;
  const today = () => Math.floor(Date.now() / 864e5);
  function keep(w) {
    data.walks.push({ d: today(), s: Math.round(w.s), m: Math.round(w.m) });
    data.walks = data.walks.filter((x) => x.d > today() - KEEP_DAYS).slice(-KEEP);
    save();
  }

  // Your usual pace in km/h: the middle one of the stretches, each counted by how long it was. null = too little walking yet.
  function usualKmh(walks) {
    const total = walks.reduce((n, w) => n + w.s, 0);
    if (walks.length < NEED_WALKS || total < NEED_S) return null;
    const byPace = walks.map((w) => ({ kmh: w.m / w.s * 3.6, s: w.s })).sort((a, b) => a.kmh - b.kmh);
    let seen = 0;
    for (const w of byPace) {
      seen += w.s;
      if (seen >= total / 2) return w.kmh;
    }
    return null;
  }

  const stopIndex = (kmh) => STOPS.reduce((best, p, i) => (Math.abs(p.kmh - kmh) < Math.abs(STOPS[best].kmh - kmh) ? i : best), 0);
  const labelOf = (kmh) => STOPS[stopIndex(kmh)].label;
  // The stop a usual pace belongs to, seen from the stop in use. It only moves on when the pace is clearly past the
  // halfway point to the next stop, so a pace near a boundary doesn't flip the setting back and forth.
  function stopFor(kmh, cur) {
    let i = cur;
    while (i < STOPS.length - 1 && kmh > (STOPS[i].kmh + STOPS[i + 1].kmh) / 2 + MARGIN) i++;
    while (i > 0 && kmh < (STOPS[i].kmh + STOPS[i - 1].kmh) / 2 - MARGIN) i--;
    return i;
  }

  // ---- The notice. What it says is saved with the change and only cleared when you close it, so it shows on
  // every start until then, whatever else happens first. ----
  const note = document.getElementById('paceNote');
  function showNotice() {
    const n = data.notice;
    if (!n) return;
    note.hidden = false;
    document.getElementById('paceNoteTitle').textContent = `Walking speed set to ${labelOf(n.to)}`;
    document.getElementById('paceNoteBody').textContent =
      `Based on how you walk, it changed from ${labelOf(n.from)} to ${labelOf(n.to)}. You can change it back in Settings.`;
    document.body.style.setProperty('--pace-note-h', note.offsetHeight + 'px'); // other messages show below it
    document.body.classList.add('pace-note-on');
  }
  function closeNotice() {
    note.hidden = true;
    document.body.classList.remove('pace-note-on');
    if (!data.notice) return;
    data.notice = null;
    save();
  }
  document.getElementById('paceNoteClose').addEventListener('click', closeNotice);
  document.getElementById('paceNoteGo').addEventListener('click', () => {
    closeNotice();
    SETTINGS.open('setSpeedHead');
  });

  // The check made at every start: does your usual pace fit another stop than the one in use? Then change it and say so.
  function check() {
    if (!on()) return { why: 'off' };
    const kmh = usualKmh(data.walks);
    if (kmh == null) return { why: 'few' };
    const cur = stopIndex(SETTINGS.prefs().walkKmh);
    const to = stopFor(kmh, cur);
    if (to === cur) return { why: 'same', kmh };
    data.notice = { from: STOPS[cur].kmh, to: STOPS[to].kmh };
    save();
    SETTINGS.set({ walkKmh: STOPS[to].kmh }, 'auto');
    showNotice();
    return { changed: true, kmh };
  }

  const live = makeTracker((w) => {
    if (!on()) return;
    keep(w);
    renderDev();
  });
  function forget() {
    data.walks = [];
    live.drop();
    closeNotice();
    save();
  }
  SETTINGS.onChange((patch, by, before) => {
    if (by !== 'auto' && before) {
      if (before.autoSpeed && !on()) forget(); // switched off: delete what was measured
      else if (SETTINGS.prefs().walkKmh !== before.walkKmh) forget(); // you set the speed yourself: measure afresh from here
    }
    renderDev();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) live.stop(); });
  window.addEventListener('pagehide', () => live.stop());

  // ---- Developer options (bottom of Settings) ----
  const devTools = document.getElementById('devTools');
  const devState = document.getElementById('devPaceState');
  const devResult = document.getElementById('devPaceResult');
  const many = (n, word) => `${n} ${word}${n === 1 ? '' : (word.endsWith('ch') ? 'es' : 's')}`;
  const span = (s) => {
    s = Math.round(s);
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  };
  const NEEDS = `at least ${span(NEED_S)} of walking in ${many(NEED_WALKS, 'stretch')}`;

  function stateText() {
    if (!on()) return 'Off. Turn on “Adjust to how I walk” to record walks.';
    if (!data.walks.length) return 'Nothing recorded yet.';
    const head = `${span(data.walks.reduce((n, w) => n + w.s, 0))} of walking in ${many(data.walks.length, 'stretch')}`;
    const kmh = usualKmh(data.walks);
    if (kmh == null) return `${head}. A change needs ${NEEDS}.`;
    const cur = stopIndex(SETTINGS.prefs().walkKmh), to = stopFor(kmh, cur);
    return `${head}, usual pace ${kmh.toFixed(1)} km/h. ` + (to === cur
      ? `That fits ${STOPS[cur].label}, the speed in use.`
      : `At the next start the speed changes from ${STOPS[cur].label} to ${STOPS[to].label}.`);
  }
  function renderDev() {
    devTools.hidden = !SETTINGS.prefs().devOptions;
    devState.textContent = stateText();
  }

  // The speed simulated walks are walked at: one value, set here or in the path panel
  const DEV_KEY = 'walk-pace-dev';
  const speedInputs = [document.getElementById('devSpeed'), document.getElementById('simSpeed')];
  const speedLabels = [document.getElementById('devSpeedVal'), document.getElementById('simSpeedVal')];
  let simKmh = 5;
  try {
    const v = JSON.parse(localStorage.getItem(DEV_KEY));
    if (v && v.kmh >= 2 && v.kmh <= 8) simKmh = v.kmh;
  } catch { /* 5 km/h */ }
  function setSimKmh(v, store) {
    simKmh = Math.round(v * 10) / 10;
    speedInputs.forEach((el) => { el.value = String(simKmh); });
    speedLabels.forEach((el) => { el.textContent = `${simKmh.toFixed(1)} km/h`; });
    if (store) try { localStorage.setItem(DEV_KEY, JSON.stringify({ kmh: simKmh })); } catch { /* kept for this visit */ }
    drawPath();
  }
  speedInputs.forEach((el) => el.addEventListener('input', () => {
    lastResult = ''; // the path panel shows the path's length and time again
    setSimKmh(+el.value, true);
  }));

  // ---- Simulated walks: made-up location fixes, one a second, measured by the same tracker as real ones ----
  // legs: [{ kmh, s }] walked one after the other along path ([lng, lat] points). Gives the place at any second.
  function simulate(path, legs) {
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + dist(path[i - 1], path[i]));
    const total = legs.reduce((n, l) => n + l.s, 0);
    const metresAt = (t) => {
      let d = 0;
      for (const l of legs) {
        const u = Math.min(l.s, t);
        d += l.kmh / 3.6 * u;
        t -= u;
        if (t <= 0) break;
      }
      return d;
    };
    const along = (d) => {
      let i = 1;
      while (i < path.length - 1 && cum[i] < d) i++;
      const f = Math.min(1, Math.max(0, (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1)));
      return [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * f, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * f];
    };
    return { total, metresAt, at: (t) => along(metresAt(Math.min(t, total))) };
  }
  // The fix at second t, a metre or two off like a real one
  function fixAt(sim, t0, t) {
    const [lng, lat] = sim.at(t);
    const off = () => (Math.random() + Math.random() - 1) * 3;
    return { ll: [lng + off() / (111320 * Math.cos(lat * Math.PI / 180)), lat + off() / 110540], acc: 8, t: t0 + t * 1000 };
  }
  // What a simulation measured; kept like real stretches when the setting is on
  function record(got) {
    const s = got.reduce((n, w) => n + w.s, 0), m = got.reduce((n, w) => n + w.m, 0);
    const kept = on();
    if (kept) got.forEach(keep);
    renderDev();
    return { n: got.length, s, m, kmh: s ? m / s * 3.6 : 0, kept };
  }
  function resultText(r, setKmh) {
    if (!r.n) return `Nothing was measured. A stretch only counts from ${MIN_S} s and ${MIN_M} m of steady walking.`;
    return `Measured ${Math.round(r.m)} m of walking in ${span(r.s)}: average ${r.kmh.toFixed(1)} km/h (set: ${setKmh.toFixed(1)} km/h). `
      + (r.kept ? `Recorded as ${many(r.n, 'stretch')}.` : 'Not recorded, because “Adjust to how I walk” is off.');
  }
  // A whole walk at once, on a straight line east out of Bern
  const LINE = [[7.4391, 46.948], [7.74, 46.948]];
  function simulateNow(legs) {
    const sim = simulate(LINE, legs), got = [];
    const tracker = makeTracker((w) => got.push(w));
    const t0 = Date.now() - sim.total * 1000;
    for (let t = 0; t <= Math.ceil(sim.total); t++) tracker.fix(fixAt(sim, t0, Math.min(t, sim.total)));
    tracker.stop();
    return record(got);
  }

  devTools.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dev]');
    if (!b) return;
    const v = simKmh;
    const say = (text) => { devResult.textContent = text; };
    const walk = (s) => ({ kmh: v, s }), stand = (s) => ({ kmh: 0, s });
    switch (b.dataset.dev) {
      case 'draw':
        if (!hooks) return;
        SETTINGS.close();
        openDraw();
        break;
      case 'walk':
        say(resultText(simulateNow([walk(600)]), v));
        break;
      case 'stops': // four blocks with a red light after each
        say(resultText(simulateNow([walk(150), stand(30), walk(150), stand(30), walk(150), stand(30), walk(150)]), v));
        break;
      case 'tram': // to the stop, a tram that first crawls and then runs at 30 km/h, on from the stop: only the walking may count
        say(resultText(simulateNow([walk(240), stand(20), { kmh: 7, s: 40 }, { kmh: 30, s: 200 }, stand(30), walk(120)]), v));
        break;
      case 'check': {
        const r = check();
        say(r.changed ? `Changed from ${labelOf(data.notice.from)} to ${labelOf(data.notice.to)} (usual pace ${r.kmh.toFixed(1)} km/h). The notice is showing.`
          : r.why === 'off' ? 'Nothing to do: “Adjust to how I walk” is off.'
          : r.why === 'few' ? `No change: too little walking recorded. It needs ${NEEDS}.`
          : `No change: the usual pace of ${r.kmh.toFixed(1)} km/h fits ${labelOf(SETTINGS.prefs().walkKmh)}, the speed in use.`);
        break;
      }
      case 'notice': {
        const cur = stopIndex(SETTINGS.prefs().walkKmh);
        data.notice = { from: STOPS[cur].kmh, to: STOPS[cur < STOPS.length - 1 ? cur + 1 : cur - 1].kmh, sample: true };
        save();
        showNotice();
        say('The notice is showing with sample text; the speed itself was not changed. It stays until it is closed, also after a reload.');
        break;
      }
      case 'clear':
        data.walks = [];
        live.drop();
        save();
        renderDev();
        say('Recorded walks deleted.');
        break;
    }
  });

  // ---- Developer options: draw a path on the map and walk it ----
  // Your position moves along the path at the set speed (played back faster), and the fixes go through the tracker.
  const PLAY_S = 12; // a simulated walk plays back in about this long, however long the walk
  const panel = document.getElementById('simPanel');
  const simStatus = document.getElementById('simStatus');
  const simUndo = document.getElementById('simUndo');
  const simClear = document.getElementById('simClear');
  const simGo = document.getElementById('simGo');
  let hooks = null;   // { map, position(pos), restore() } from the main script
  let svg = null, svgLine = null, svgDots = null;
  let drawOpen = false;
  let pts = [];       // the path: [lng, lat] points
  let run = null;     // the walk being played: { raf }
  let lastResult = '';

  const pathMetres = () => pts.reduce((n, p, i) => (i ? n + dist(pts[i - 1], p) : 0), 0);
  function drawPath() {
    if (!svg) return;
    const px = pts.map((p) => hooks.map.project(p));
    svgLine.setAttribute('points', px.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
    svgDots.innerHTML = px.map((p, i) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${i === 0 || i === px.length - 1 ? 7 : 4.5}" />`).join('');
    if (run) return;
    simUndo.disabled = simClear.disabled = !pts.length;
    simGo.disabled = pts.length < 2;
    const m = pathMetres();
    simStatus.textContent = lastResult
      || (pts.length === 0 ? 'Tap the map where the walk starts.'
        : pts.length === 1 ? 'Tap again for the next point. Add as many as you like.'
        : `${many(pts.length, 'point')}, ${Math.round(m)} m: ${span(m / (simKmh / 3.6))} at ${simKmh.toFixed(1)} km/h.`);
  }
  function openDraw() {
    drawOpen = true;
    lastResult = '';
    panel.hidden = false;
    document.body.classList.add('sim-mode');
    drawPath();
  }
  function stopWalk() {
    if (!run) return;
    cancelAnimationFrame(run.raf);
    run = null;
    simGo.textContent = 'Walk it';
    speedInputs[1].disabled = false;
  }
  function closeDraw() {
    stopWalk();
    drawOpen = false;
    pts = [];
    panel.hidden = true;
    document.body.classList.remove('sim-mode');
    drawPath();
    hooks.restore(); // your real position again
  }
  function startWalk() {
    const kmh = simKmh, metres = pathMetres();
    const sim = simulate(pts, [{ kmh, s: metres / (kmh / 3.6) }]), got = [];
    const tracker = makeTracker((w) => got.push(w));
    const rate = Math.max(1, sim.total / PLAY_S);
    const t0 = Date.now(), began = performance.now();
    let fed = -1;
    live.drop(); // real fixes are set aside while this runs
    lastResult = '';
    simGo.textContent = 'Stop';
    simUndo.disabled = simClear.disabled = speedInputs[1].disabled = true; // the walk keeps the speed it started with
    const frame = (now) => {
      const t = Math.min(sim.total, (now - began) / 1000 * rate);
      while (fed + 1 <= t) tracker.fix(fixAt(sim, t0, ++fed)); // one fix for every second of the walk
      const [lng, lat] = sim.at(t);
      hooks.position({ coords: { longitude: lng, latitude: lat, accuracy: 8 }, timestamp: Date.now(), simulated: true });
      simStatus.textContent = `Walking at ${kmh.toFixed(1)} km/h: ${Math.round(sim.metresAt(t))} of ${Math.round(metres)} m.`;
      if (t < sim.total) { run.raf = requestAnimationFrame(frame); return; }
      tracker.fix(fixAt(sim, t0, sim.total));
      tracker.stop();
      stopWalk();
      lastResult = 'Arrived. ' + resultText(record(got), kmh);
      drawPath();
    };
    run = { raf: requestAnimationFrame(frame) };
  }
  simGo.addEventListener('click', () => {
    if (!run) return startWalk();
    stopWalk();
    lastResult = 'Stopped. Nothing was recorded.';
    drawPath();
  });
  simUndo.addEventListener('click', () => { pts.pop(); lastResult = ''; drawPath(); });
  simClear.addEventListener('click', () => { pts = []; lastResult = ''; drawPath(); });
  document.getElementById('simClose').addEventListener('click', closeDraw);

  window.WALK_PACE = {
    // every real location fix: { ll: [lng, lat], acc: metres, speed: m/s or nothing, t: ms }
    fix(f) { if (on() && !run) live.fix(f); },
    // the main script hands over the map, a way to set your position, and one to put the real one back
    attach(h) {
      hooks = h;
      const NS = 'http://www.w3.org/2000/svg';
      svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'sim-svg');
      svg.setAttribute('aria-hidden', 'true');
      svgLine = svg.appendChild(document.createElementNS(NS, 'polyline'));
      svgDots = svg.appendChild(document.createElementNS(NS, 'g'));
      h.map.getCanvasContainer().appendChild(svg);
      h.map.on('move', drawPath);
      h.map.on('resize', drawPath);
      h.map.on('click', (e) => {
        if (!drawOpen || run) return;
        pts.push([e.lngLat.lng, e.lngLat.lat]);
        lastResult = '';
        drawPath();
      });
    },
    drawing: () => drawOpen,   // taps on the map draw the path
    simulating: () => !!run,   // a simulated walk has your position for now
  };

  // ---- Start ----
  // A notice still waiting that no longer fits (the setting went off, or the speed is another one by now) is dropped
  if (data.notice && !data.notice.sample && (!on() || SETTINGS.prefs().walkKmh !== data.notice.to)) { data.notice = null; save(); }
  check();
  showNotice(); // also one from an earlier start that was never closed
  setSimKmh(simKmh, false);
  renderDev();
})();
