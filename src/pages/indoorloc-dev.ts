(function () {
  'use strict';
  /** The page's elements, by id. */
  interface PageElements {
    viewer: HTMLElement; panel: HTMLElement; key: HTMLSelectElement; min: HTMLButtonElement; sensors: HTMLElement;
    est: HTMLElement; why: HTMLElement; bars: HTMLElement; start: HTMLButtonElement; here: HTMLButtonElement;
    floor: HTMLSelectElement; sign: HTMLInputElement; read: HTMLButtonElement; signout: HTMLElement;
    rec: HTMLButtonElement; export: HTMLButtonElement; import: HTMLInputElement; importBtn: HTMLElement;
    replayRow: HTMLElement; play: HTMLButtonElement; seek: HTMLInputElement; rt: HTMLElement; err: HTMLElement;
  }
  /** A recording being played. i: the next event; t / T: seconds played / in all; errs: one per checkpoint so far. */
  interface Replay {
    log: IndoorLog; f: IndoorFilter; ev: IndoorLogEvent[]; i: number; t: number; T: number; speed: number; playing: boolean;
    truth: IndoorCheckpoint | null; errs: { d: number; ok: boolean }[]; raf?: number;
  }
  /** The page's own GPS watch. */
  type DevWindow = typeof window & { _geo?: number };
  const $ = <K extends keyof PageElements>(id: K) => document.getElementById(id) as PageElements[K];
  const q = new URLSearchParams(location.search);
  const keys = [...new Set(Object.values(window.STATION3D_INDEX || {}))];
  keys.forEach((k) => { const o = document.createElement('option'); o.value = k; o.textContent = k; $('key').appendChild(o); });
  let key = q.get('key') || keys[0] || 'bern';
  $('key').value = key;
  let model: IndoorModel | null = null, picking = false, replay: Replay | null = null, lastRec: IndoorRecorder | null = null;

  function open() {
    Station3D.open({ key, modal: false, pickAnywhere: true, mount: $('viewer'), title: 'Indoor position' });
  }
  Station3D.on('open', async () => {
    model = await INDOORLOC!.load(key);
    $('floor').innerHTML = '<option value="">I\'m on floor…</option>' + (model ? model.levels.map((l) => `<option value="${l.id}">${l.id} · ${l.name || ''}</option>`).join('') : '');
  });
  Station3D.on('pick', (p) => {
    if (!picking) return;
    picking = false; $('here').textContent = "I'm here…";
    INDOORNAV!.here({ level: p.level, xy: p.xy });
    // while recording, "I'm here" is the ground truth of the walk
    if (lastRec && $('rec').textContent === 'Stop') lastRec.checkpoint({ x: p.xy[0], y: p.xy[1], level: p.level });
  });
  $('key').onchange = () => { stopReplay(); key = $('key').value; Station3D.close(); setTimeout(open, 50); };
  $('min').onclick = () => { $('panel').classList.toggle('min'); $('min').textContent = $('panel').classList.contains('min') ? '+' : '–'; };
  $('start').onclick = async () => {
    const st = await INDOORNAV!.startSensors();
    // in the browser the app normally sends GPS; here the page does it
    if (navigator.geolocation && !(window as DevWindow)._geo) (window as DevWindow)._geo = navigator.geolocation.watchPosition((p) => INDOORNAV!.setUser({ ll: [p.coords.longitude, p.coords.latitude], accuracy: p.coords.accuracy }), () => {}, { enableHighAccuracy: true });
    show();
    return st;
  };
  $('here').onclick = () => { picking = !picking; $('here').textContent = picking ? 'Tap the model…' : "I'm here…"; };
  $('floor').onchange = () => { if ($('floor').value !== '') INDOORNAV!.here({ level: +$('floor').value }); $('floor').value = ''; };
  const readSign = () => {
    const r = INDOORNAV!.sign($('sign').value);
    $('signout').textContent = r ? r.explain : 'Open a station first';
  };
  $('read').onclick = readSign;
  $('sign').onkeydown = (e) => { if (e.key === 'Enter') readSign(); };
  $('rec').onclick = () => {
    if (lastRec && $('rec').textContent === 'Stop') { INDOORNAV!.stopRecording(); $('rec').textContent = 'Record'; $('export').disabled = false; return; }
    lastRec = INDOORNAV!.record(); $('rec').textContent = 'Stop'; $('export').disabled = true;
  };
  $('export').onclick = () => {
    if (!lastRec) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(INDOORNAV!.exportLog(lastRec));
    a.download = `indoor-${key}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`;
    a.click();
  };
  $('importBtn').onclick = () => $('import').click();
  $('importBtn').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') $('import').click(); };
  $('import').onchange = async () => {
    const file = $('import').files![0];
    if (!file || !model) return;
    const log: IndoorLog = JSON.parse(await file.text());
    startReplay(log);
    $('import').value = '';
  };

  // ---- replay: feed the log into a fresh filter at 4× speed, show its estimate in the 3D view
  function startReplay(log: IndoorLog) {
    stopReplay();
    const f = new INDOORLOC!.Filter(model!, { seed: 1 });
    const prior = log.meta && log.meta.prior;
    if (prior) f.prior(prior);
    const ev = log.events, T = ev.length ? ev[ev.length - 1][0] : 0;
    replay = { log, f, ev, i: 0, t: 0, T, speed: 4, playing: true, truth: null, errs: [] };
    $('replayRow').hidden = false; $('play').textContent = 'Pause';
    let last = performance.now();
    const loop = (now: number) => {
      if (!replay) return;
      const dt = (now - last) / 1000; last = now;
      if (replay.playing) advance(replay.t + dt * replay.speed);
      replay.raf = requestAnimationFrame(loop);
    };
    replay.raf = requestAnimationFrame(loop);
  }
  function advance(t: number) {
    const R = replay!, f = R.f;
    while (R.i < R.ev.length && R.ev[R.i][0] <= t) {
      const [et, type, d] = R.ev[R.i++];
      if (type === 'step') f.step({ t: et, length: d.length, heading: d.heading, headingSigma: d.headingSigma || d.sigma, stairs: d.stairs });
      else if (type === 'gps') f.gps({ t: et, lon: d.lon, lat: d.lat, acc: d.acc });
      else if (type === 'pressure') f.pressure({ t: et, hPa: d.hPa });
      else if (type === 'tick') f.tick(et);
      else if (type === 'sign') { const r = SIGNLOC!.match(d.text, model!); SIGNLOC!.apply(f, r, et); $('signout').textContent = `t=${et.toFixed(0)} s “${d.text}” → ${r.explain}`; }
      else if (type === 'truth' || type === 'checkpoint') {
        R.truth = d;
        const e = f.estimate();
        if (e.state === 'tracking') R.errs.push({ d: Math.hypot(e.x - d.x!, e.y - d.y!), ok: e.level === d.level });
      }
    }
    R.t = Math.min(t, R.T);
    const e = f.estimate();
    if (e.state === 'tracking') Station3D.setUser({ xy: [e.x, e.y], level: e.levelProb > 0.6 ? e.level : undefined, accuracy: Math.max(3, e.sigma * 1.5) });
    render(e);
    $('seek').value = Math.round(1000 * R.t / (R.T || 1)) as unknown as string;
    $('rt').textContent = `${R.t.toFixed(0)} / ${R.T.toFixed(0)} s`;
    if (R.truth && e.state === 'tracking') {
      const ok = R.errs.filter((x) => x.ok).length;
      const dd = R.errs.filter((x) => x.ok).map((x) => x.d).sort((a, b) => a - b);
      $('err').textContent = `Truth: level ${R.truth.level}${R.truth.mode ? ' (' + R.truth.mode + ')' : ''} · right floor ${Math.round(100 * ok / Math.max(1, R.errs.length))}% of checkpoints · median error ${dd.length ? dd[Math.floor(dd.length / 2)].toFixed(1) : '—'} m`;
    }
    if (R.i >= R.ev.length) R.playing = false;
  }
  function stopReplay() { if (replay) cancelAnimationFrame(replay.raf!); replay = null; $('replayRow').hidden = true; }
  $('play').onclick = () => { if (!replay) return; replay.playing = !replay.playing; $('play').textContent = replay.playing ? 'Pause' : 'Play'; };
  $('seek').oninput = () => {
    if (!replay) return;
    // restart and run up to the chosen time (the filter only goes forward)
    const target = replay.T * ($('seek').value as unknown as number) / 1000;
    startReplay(replay.log); replay.playing = false; $('play').textContent = 'Play'; advance(target);
  };

  // ---- live read-out
  function render(e: IndoorEstimate | null) {
    if (!e || e.state !== 'tracking') { $('est').textContent = 'No position yet'; $('bars').innerHTML = ''; return; }
    const lv = model && model.levels[e.li];
    $('est').textContent = `${e.confident ? '' : 'Probably '}level ${e.level}${lv && lv.name ? ' · ' + lv.name : ''} · ±${Math.round(e.sigma)} m`;
    const ev = e.evidence || {};
    $('why').textContent = [ev.baro && 'barometer ' + ev.baro, ev.sign && `sign (${ev.sign.candidates} places)`, ev.recovered && 'relocalising', ev.relocalised && 'relocalised by GPS'].filter(Boolean).join(' · ');
    const probs = Object.entries(e.levelProbs).sort((a, b) => (b[0] as unknown as number) - (a[0] as unknown as number));
    $('bars').innerHTML = probs.map(([l, p]) => `<span>${l}</span><span class="bar"><i style="width:${(100 * p).toFixed(0)}%"></i></span><span>${(100 * p).toFixed(0)}%</span>`).join('');
  }
  function show() {
    const st = INDOORNAV!.state();
    const s: Partial<Record<string, string>> = st.sensors || {};
    $('sensors').innerHTML = ['motion', 'orientation', 'gps', 'pressure'].map((k) => `<span class="${s[k] === 'on' ? 'on' : 'off'}">${k}: ${s[k] || (k === 'gps' && (window as DevWindow)._geo != null ? 'on' : 'off')}</span>`).join('');
    if (!replay) render(st.estimate);
  }
  setInterval(show, 500);
  open();
})();
