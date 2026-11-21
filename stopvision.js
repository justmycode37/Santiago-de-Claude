// Scan: point the phone at your surroundings and see which stops are there.
//
// Loaded by index.html only when Scan is opened. Three kinds of evidence, used in this order:
//   1. Where you are and where the camera points (GPS + compass) against the exact position of every stop edge
//      (platforms.js). This finds the stops around you and which of them are in front of the camera, but on its
//      own it only says "nearby", never "recognised".
//   2. Reading signs (tesseract.js OCR): the stop name on the pole, and also a Kante / Gleis / Quai letter or
//      number, line numbers and destinations, which are compared with the stop's live departures to tell the
//      edges of a stop apart. A clearly read name is the strongest evidence.
//   3. Comparing the camera picture with reference photos of the stops around you (stop-images/, built by
//      tools/build_stop_images.py from Wikimedia Commons, Wikidata, SBB, OpenStreetMap, Panoramax and Mapillary).
//      Only the photos' fingerprints are stored; the phone fingerprints its own camera frame with the same model
//      (DINOv2-small) and compares. Photo similarity only breaks ties: stops without photos are not penalised.
// A stop is shown as recognised when a sign was read, or when the photo match clearly and repeatedly favours it.
(function () {
  'use strict';

  const ORT_DIST = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
  const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js';
  const INPUT = 224;
  const MEAN = [0.485, 0.456, 0.406];
  const STD = [0.229, 0.224, 0.225];
  const IDENTITY = { wd: 1, cat: 1, sbb: 1, osm: 1 }; // photos tied to the stop by identity, not just by place
  // Photo similarity (cosine of the stored fingerprints). Measured on 1,200 photos of 313 Bern + Zürich stops
  // (python3 tools/build_stop_images.py --calibrate): photos of the same stop have a median similarity of 0.48,
  // photos of other stops within 600 m 0.30; picking the stop by photo alone is right only ~50–55 % of the time,
  // whatever the threshold. So a photo match only counts as recognition when the location agrees with it.
  const VIS_MIN = 0.6;     // below this nothing in the picture looks like any reference photo
  const VIS_MARGIN = 0.05; // best stop must beat the runner-up by this much…
  const VIS_FRAMES = 3;    // …in this many frames in a row

  let app = null;          // hooks from index.html
  let ui = null;           // DOM
  let stream = null;
  let running = false;
  let heading = null;      // degrees, where the camera looks; null = unknown
  let headingAcc = 30;     // degrees
  let headingAt = 0;
  let candidates = [];     // stops around you, scored
  const evidence = new Map(); // uic → { ocr, ocrAt, ocrWhat, edgeOcr, vis, visRef, visStreak, departures }
  const tiles = new Map();    // photo tiles loaded: key → { uic: refs }
  let model = null, modelState = 'idle';
  let ocr = null, ocrState = 'idle', ocrLang = '', ocrFailedAt = 0;
  let lastOcr = 0, lastVis = 0, ocrInvert = false;
  let tapRead = null;      // { x, y } in video pixels: read the sign there next
  let stillImage = null;   // a photo taken with the file input instead of the live camera
  let stillFrames = 0;     // photo comparisons done on that photo (one is enough: it does not change)
  let stillReads = 0;      // sign readings done on it

  // ---------------------------------------------------------------- small helpers
  const $ = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const toRad = Math.PI / 180;
  const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  function distM(a, b) {
    const k = Math.cos((a[1] + b[1]) / 2 * toRad);
    return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111320;
  }
  function bearing(a, b) {
    const k = Math.cos((a[1] + b[1]) / 2 * toRad);
    return (Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) / toRad + 360) % 360;
  }
  const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  function lev(a, b) {
    if (a === b) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }
  const ratio = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve; s.onerror = () => reject(new Error('could not load ' + src));
      document.head.appendChild(s);
    });
  }
  const GENERIC = new Set(['bahnhof', 'station', 'gare', 'stazione', 'post', 'dorf', 'zentrum', 'centre', 'centro', 'nord', 'sud', 'ost', 'west', 'bhf', 'sbb', 'cff', 'ffs']);
  // What a sign would show: "Bern, Zytglogge" → "zytglogge" (and the full name); "Muri bei Bern" → itself
  function nameVariants(name) {
    const parts = String(name).split(',').map((p) => norm(p)).filter(Boolean);
    const out = new Set([parts.join(' ')]);
    if (parts.length > 1) out.add(parts[parts.length - 1]);
    return [...out].filter((v) => v.replace(/ /g, '').length >= 4);
  }
  const distinctive = (v) => v.split(' ').some((t) => t.length >= 4 && !GENERIC.has(t));

  // Best fuzzy match of a name in OCR text: compare with every run of words of about the same length
  function matchIn(tokens, variant) {
    const want = variant.replace(/ /g, '');
    const k = variant.split(' ').length;
    let best = 0;
    for (let n = Math.max(1, k - 1); n <= k + 1; n++) {
      for (let i = 0; i + n <= tokens.length; i++) {
        const got = tokens.slice(i, i + n).join('');
        if (Math.abs(got.length - want.length) > want.length * 0.4) continue;
        best = Math.max(best, ratio(got, want));
        if (best === 1) return 1;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- styles + screen
  const CSS = `
  .sv { position: fixed; inset: 0; z-index: 100; background: #000; color: #fff; overflow: hidden; touch-action: manipulation;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif; }
  .sv video, .sv .sv-still { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .sv .sv-still { display: none; }
  .sv.still .sv-still { display: block; }
  .sv.still video { visibility: hidden; }
  .sv-top { position: absolute; left: 0; right: 0; top: 0; padding: calc(env(safe-area-inset-top) + 12px) 12px 28px;
            display: flex; gap: 10px; align-items: flex-start; background: linear-gradient(rgba(0,0,0,.55), transparent); }
  .sv-btn { flex: none; width: 44px; height: 44px; border-radius: 50%; border: 0; display: grid; place-items: center;
            background: rgba(28,28,30,.72); color: #fff; backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); cursor: pointer; }
  .sv-btn svg { width: 22px; height: 22px; }
  .sv-status { flex: 1; min-width: 0; padding-top: 4px; font-size: 13px; line-height: 1.35; text-shadow: 0 1px 3px rgba(0,0,0,.6); }
  .sv-status b { display: block; font-size: 16px; font-weight: 600; }
  .sv-ar { position: absolute; inset: 0; pointer-events: none; }
  .sv-tag { position: absolute; left: 0; top: 0; transform: translate(-50%, -100%); display: flex; flex-direction: column; align-items: center;
            transition: opacity .25s ease; will-change: transform; }
  .sv-tag span { display: flex; align-items: center; gap: 6px; max-width: 44vw; padding: 6px 10px 6px 6px; border-radius: 18px;
                 background: rgba(28,28,30,.78); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
                 font-size: 13px; font-weight: 600; white-space: nowrap; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
  .sv-tag span em { font-style: normal; overflow: hidden; text-overflow: ellipsis; }
  .sv-tag small { font-weight: 500; color: #c7c7cc; }
  .sv-tag i { width: 2px; height: 26px; background: rgba(255,255,255,.75); }
  .sv-tag.hit span { background: var(--navy, #344D77); outline: 2px solid #fff; }
  .sv-ic { flex: none; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; background: #fff; color: #1c1c1e; }
  .sv-ic svg { width: 15px; height: 15px; }
  .sv-ref { flex: none; min-width: 22px; height: 22px; padding: 0 5px; border-radius: 11px; display: grid; place-items: center;
            background: #fff; color: #1c1c1e; font-size: 12px; font-weight: 700; }
  .sv-ring { position: absolute; width: 64px; height: 64px; margin: -32px 0 0 -32px; border: 2px solid #fff; border-radius: 12px;
             pointer-events: none; opacity: 0; transition: opacity .3s ease; }
  .sv-ring.on { opacity: 1; animation: sv-pulse 1s ease infinite; }
  @keyframes sv-pulse { 50% { transform: scale(1.12); } }
  .sv-sheet { position: absolute; left: 0; right: 0; bottom: 0; padding: 14px 16px calc(env(safe-area-inset-bottom) + 14px);
              max-height: 58vh; overflow-y: auto; border-radius: 22px 22px 0 0; background: rgba(28,28,30,.86);
              backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); }
  .sv-hint { margin: 0; font-size: 14px; color: #c7c7cc; }
  .sv-main { display: flex; gap: 12px; align-items: center; }
  .sv-main .sv-ic { width: 40px; height: 40px; }
  .sv-main .sv-ic svg { width: 24px; height: 24px; }
  .sv-main div { min-width: 0; flex: 1; }
  .sv-main b { display: block; font-size: 19px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-main small { display: block; font-size: 13px; color: #c7c7cc; }
  .sv-state { display: inline-block; margin-bottom: 8px; padding: 3px 9px; border-radius: 10px; font-size: 12px; font-weight: 700;
              letter-spacing: .02em; text-transform: uppercase; background: rgba(255,255,255,.14); }
  .sv-state.ok { background: #2f9e5b; }
  .sv-why { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 0; padding: 0; list-style: none; }
  .sv-why li { padding: 4px 9px; border-radius: 10px; background: rgba(255,255,255,.1); font-size: 12px; color: #e5e5ea; }
  .sv-why li.on { background: rgba(47,158,91,.35); color: #fff; }
  .sv-deps { list-style: none; margin: 10px 0 0; padding: 0; }
  .sv-deps li { display: flex; align-items: center; gap: 8px; padding: 7px 0; border-top: 1px solid rgba(255,255,255,.1); font-size: 15px; }
  .sv-deps time { flex: none; width: 44px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .sv-deps .sv-line { flex: none; min-width: 30px; padding: 2px 6px; border-radius: 6px; background: #fff; color: #1c1c1e; font-size: 13px; font-weight: 700; text-align: center; }
  .sv-deps .sv-to { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-deps .sv-late { color: #ff9fbf; font-size: 13px; font-weight: 600; }
  .sv-actions { display: flex; gap: 8px; margin-top: 12px; }
  .sv-actions button { flex: 1; height: 44px; border: 0; border-radius: 12px; font-size: 15px; font-weight: 600; cursor: pointer;
                       background: var(--navy, #344D77); color: #fff; }
  .sv-actions button.sec { background: rgba(255,255,255,.14); }
  .sv-photo { display: flex; gap: 10px; align-items: center; margin-top: 12px; font-size: 12px; color: #aeaeb2; }
  .sv-photo img { flex: none; width: 56px; height: 42px; object-fit: cover; border-radius: 6px; background: #333; }
  .sv-photo a { color: #c7c7cc; }
  .sv-alt { list-style: none; margin: 12px 0 0; padding: 0; }
  .sv-alt li { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid rgba(255,255,255,.1); font-size: 14px; cursor: pointer; }
  .sv-alt li span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-alt li small { color: #aeaeb2; }
  .sv-file { display: none; }
  `;

  const ICONS = {
    train: '<path d="M7 3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM4 10h16M8 17l-2 4M16 17l2 4"/>',
    tram: '<path d="M8 2h8M12 2v3M7 5h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM5 12h14M9 18l-2 4M15 18l2 4"/>',
    bus: '<path d="M6 3h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM4 11h16M7 18v3M17 18v3M8 14.5h.01M16 14.5h.01"/>',
    boat: '<path d="M3 17l2 4h14l2-4zM6 17V9h12v8M12 3v6M9 6h6"/>',
    cable: '<path d="M2 4l20 4M12 6v4M7 10h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM5 15h14"/>',
  };
  const icon = (mode) => {
    const s = $('span', 'sv-ic');
    s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[mode] || ICONS.bus}</svg>`;
    return s;
  };
  const MODE_WORD = { train: 'Train station', tram: 'Tram stop', bus: 'Bus stop', boat: 'Boat pier', cable: 'Cable car' };
  const EDGE_WORD = (mode) => (mode === 'train' || mode === 'cable' ? 'Platform' : mode === 'boat' ? 'Pier' : 'Bay');

  function buildUI() {
    if (!document.getElementById('sv-css')) {
      const st = document.createElement('style');
      st.id = 'sv-css'; st.textContent = CSS;
      document.head.appendChild(st);
    }
    const root = $('section', 'sv');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Scan for stops');
    const video = $('video');
    video.setAttribute('playsinline', ''); video.muted = true; video.autoplay = true;
    const still = $('img', 'sv-still');
    still.alt = '';
    const ar = $('div', 'sv-ar');
    const ring = $('div', 'sv-ring');
    const top = $('div', 'sv-top');
    const close = $('button', 'sv-btn');
    close.type = 'button'; close.setAttribute('aria-label', 'Close scan');
    close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';
    const status = $('div', 'sv-status');
    status.setAttribute('role', 'status');
    const shoot = $('button', 'sv-btn');
    shoot.type = 'button'; shoot.setAttribute('aria-label', 'Use a photo instead');
    shoot.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
    const file = $('input', 'sv-file');
    file.type = 'file'; file.accept = 'image/*'; file.setAttribute('capture', 'environment');
    top.append(close, status, shoot);
    const sheet = $('div', 'sv-sheet');
    sheet.setAttribute('aria-live', 'polite');
    root.append(video, still, ar, ring, top, sheet, file);
    document.body.appendChild(root);
    close.addEventListener('click', closeScan);
    shoot.addEventListener('click', () => file.click());
    file.addEventListener('change', () => { if (file.files[0]) useStill(file.files[0]); file.value = ''; });
    // Tap the picture to read the sign there
    root.addEventListener('click', (e) => {
      if (e.target !== video && e.target !== still && e.target !== ar) return;
      const src = stillImage ? still : video;
      const p = toSourcePx(src, e.clientX, e.clientY);
      if (!p) return;
      tapRead = p;
      ring.style.left = e.clientX + 'px'; ring.style.top = e.clientY + 'px';
      ring.classList.add('on');
      lastOcr = 0;
    });
    document.addEventListener('keydown', onKey);
    return { root, video, still, ar, ring, status, sheet, tags: new Map(), shownKey: '' };
  }
  const onKey = (e) => { if (e.key === 'Escape') closeScan(); };

  // Screen point → pixel in the video/photo (object-fit: cover)
  function toSourcePx(el, cx, cy) {
    const w = el.videoWidth || el.naturalWidth, h = el.videoHeight || el.naturalHeight;
    if (!w || !h) return null;
    const r = el.getBoundingClientRect();
    const s = Math.max(r.width / w, r.height / h);
    return { x: (cx - r.left - (r.width - w * s) / 2) / s, y: (cy - r.top - (r.height - h * s) / 2) / s };
  }

  function setStatus(title, detail) {
    ui.status.replaceChildren($('b', null, title), document.createTextNode(detail || ''));
  }

  // ---------------------------------------------------------------- compass
  // Where the back camera points, from the device orientation (W3C: R = Rz(α)·Rx(β)·Ry(γ); camera = −z axis).
  function onOrientation(e) {
    let h = null, acc = 25;
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
      // iOS: compass heading of the device, corrected for how the screen is turned
      const turn = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
      h = (e.webkitCompassHeading + turn + 360) % 360;
      acc = e.webkitCompassAccuracy > 0 ? Math.max(10, e.webkitCompassAccuracy) : 30;
      if (e.beta != null && Math.abs(e.beta) < 25) acc = 60; // lying flat: the camera looks at the ground
    } else if (e.absolute && e.alpha != null) {
      const a = e.alpha * toRad, b = e.beta * toRad, g = (e.gamma || 0) * toRad;
      const east = -(Math.cos(a) * Math.sin(g) + Math.sin(a) * Math.sin(b) * Math.cos(g));
      const north = -(Math.sin(a) * Math.sin(g) - Math.cos(a) * Math.sin(b) * Math.cos(g));
      const up = -Math.cos(b) * Math.cos(g);
      if (Math.hypot(east, north) < 0.35 || up < -0.85) return; // pointing at the ground or the sky
      h = (Math.atan2(east, north) / toRad + 360) % 360;
      acc = 25;
    }
    if (h == null) return;
    // smooth over the jitter of the magnetometer (circular average)
    if (heading == null || Date.now() - headingAt > 2000) heading = h;
    else {
      const d = ((h - heading + 540) % 360) - 180;
      heading = (heading + d * 0.25 + 360) % 360;
    }
    headingAcc = acc;
    headingAt = Date.now();
  }
  const headingOk = () => heading != null && Date.now() - headingAt < 3000;

  // Horizontal field of view of what is on screen (≈ 75° diagonal phone camera, cropped by object-fit: cover)
  function screenFov() {
    const el = stillImage ? ui.still : ui.video;
    const w = el.videoWidth || el.naturalWidth || 3, h = el.videoHeight || el.naturalHeight || 4;
    const full = 2 * Math.atan(Math.tan(37.5 * toRad) * w / Math.hypot(w, h)) / toRad;
    const sw = ui.root.clientWidth, sh = ui.root.clientHeight;
    const visible = Math.min(1, (sw / sh) / (w / h));
    return 2 * Math.atan(Math.tan(full / 2 * toRad) * visible) / toRad;
  }

  // ---------------------------------------------------------------- candidates (geometry)
  function position() {
    const p = app.position();
    return p && p.ll && p.age < 120000 && p.acc < 500 ? p : null;
  }

  function findCandidates() {
    const pos = position();
    if (!pos) { candidates = []; return; }
    const radius = Math.min(600, Math.max(150, 3 * pos.acc + 60));
    const out = [];
    for (const [uic, st] of app.PLATFORMS) {
      let best = Infinity, bestI = 0;
      st.edges.forEach((e, i) => { const d = distM(pos.ll, e.ll); if (d < best) { best = d; bestI = i; } });
      if (best <= radius) out.push({ uic, st, dist: best, nearEdge: bestI, variants: nameVariants(st.name) });
    }
    out.sort((a, b) => a.dist - b.dist);
    candidates = out.slice(0, 40);
    loadTilesAround(pos.ll);
  }

  // How well each candidate fits what the camera sees → candidates sorted by score, with the reasons
  function score() {
    const pos = position();
    const fov = screenFov();
    const useHeading = headingOk() && pos && !stillImage;
    for (const c of candidates) {
      const ev = evidence.get(c.uic) || {};
      const acc = pos ? pos.acc : 50;
      let s = -c.dist / (40 + acc);              // distance prior
      c.ahead = null;
      if (useHeading) {
        // is any of its edges in front of the camera? (bearing from you to the edge, not the edge's own direction)
        const slack = fov / 2 + Math.min(40, headingAcc);
        let bestOff = 180;
        c.st.edges.forEach((e, i) => {
          const off = angleDiff(bearing(pos.ll, e.ll), heading);
          if (off < bestOff) { bestOff = off; c.aheadEdge = i; }
        });
        c.ahead = bestOff <= slack;
        s += c.ahead ? 0.8 : -Math.min(1.5, (bestOff - slack) / 40); // soft: compasses can be off by tens of degrees
      }
      c.geo = s; // location + compass only
      if (ev.ocrAt && Date.now() - ev.ocrAt < 12000 && ev.ocr >= 0.72) s += 6 * (ev.ocr - 0.6) / 0.4; // a read name dominates
      if (ev.lines) s += Math.min(1, 0.4 * ev.lines);
      if (ev.vis != null && ev.visRel != null) s += Math.max(-0.5, Math.min(1.5, ev.visRel * 12)); // tie-breaker
      c.score = s;
    }
    const byGeo = candidates.slice().sort((a, b) => b.geo - a.geo);
    candidates.forEach((c) => { c.geoTop = c === byGeo[0] && (byGeo.length < 2 || byGeo[0].geo - byGeo[1].geo > 0.15); });
    candidates.sort((a, b) => b.score - a.score);
    // keep the stop shown unless another one is clearly better (no flicker between two close scores)
    const keep = prevTop && candidates.includes(prevTop) && candidates[0] !== prevTop && candidates[0].score - prevTop.score < 0.3;
    if (keep) candidates.splice(0, 0, ...candidates.splice(candidates.indexOf(prevTop), 1));
    prevTop = candidates[0] || null;
  }

  // ---------------------------------------------------------------- reading signs
  function ocrLanguage(ll) {
    if (!ll) return 'deu+fra';
    const [lon, lat] = ll;
    if (lat < 46.45 && lon > 8.38) return 'ita';
    if (lon < 6.95 || (lat < 46.4 && lon < 7.55)) return 'fra';
    if (lon < 7.35 && lat < 47.25) return 'fra+deu'; // Fribourg, Biel/Bienne, Valais border
    return 'deu';
  }

  async function ensureOcr() {
    const lang = ocrLanguage(position() && position().ll);
    if (ocr && ocrLang === lang) return ocr;
    if (ocrState === 'loading' || (ocrState === 'failed' && Date.now() - ocrFailedAt < 30000)) return null;
    ocrState = 'loading';
    try {
      if (!window.Tesseract) await loadScript(TESSERACT);
      if (ocr) await ocr.terminate();
      ocr = await window.Tesseract.createWorker(lang.split('+'), 1); // LSTM engine; language data from jsDelivr
      await ocr.setParameters({ tessedit_pageseg_mode: '11' });     // sparse text: signs scattered in a street scene
      ocrLang = lang;
      ocrState = 'ready';
      return ocr;
    } catch (err) {
      ocrState = 'failed';
      ocrFailedAt = Date.now();
      console.warn('Scan: OCR unavailable', err);
      return null;
    }
  }

  // Sharpness of a grey frame (variance of the Laplacian): skip blurred frames
  function sharpness(ctx, w, h) {
    const d = ctx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
    let sum = 0, sum2 = 0, n = 0;
    for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x;
      const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      sum += l; sum2 += l * l; n++;
    }
    return sum2 / n - (sum / n) ** 2;
  }

  function source() { return stillImage ? ui.still : ui.video; }
  function sourceSize() { const s = source(); return [s.videoWidth || s.naturalWidth, s.videoHeight || s.naturalHeight]; }

  // A frame (or the part around a tap) for OCR: grey, contrast stretched, optionally inverted (white on blue signs)
  function ocrCanvas(region, invert) {
    const [w, h] = sourceSize();
    const r = region || { x: w * 0.05, y: h * 0.05, w: w * 0.9, h: h * 0.75 }; // signs are rarely at the bottom
    const scale = Math.min(1, 1400 / r.w);
    const c = document.createElement('canvas');
    c.width = Math.round(r.w * scale); c.height = Math.round(r.h * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source(), r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 16) { const v = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; if (v < lo) lo = v; if (v > hi) hi = v; }
    const k = 255 / Math.max(40, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      let v = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11 - lo) * k;
      if (invert) v = 255 - v;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  async function readSigns() {
    const worker = await ensureOcr();
    if (!worker) return;
    const [w, h] = sourceSize();
    if (!w) return;
    let region = null;
    const tap = tapRead;
    if (tap) {
      const rw = w * 0.7, rh = h * 0.28;
      region = { x: Math.max(0, Math.min(w - rw, tap.x - rw / 2)), y: Math.max(0, Math.min(h - rh, tap.y - rh / 2)), w: rw, h: rh };
    } else if (stillImage && stillReads >= 2) return; // a photo does not change: read it twice (normal + inverted)
    if (stillImage && !tap) stillReads++;
    const canvas = ocrCanvas(region, ocrInvert);
    if (!region && !stillImage) {
      const small = document.createElement('canvas');
      small.width = 160; small.height = Math.round(160 * canvas.height / canvas.width);
      const sctx = small.getContext('2d', { willReadFrequently: true });
      sctx.drawImage(canvas, 0, 0, small.width, small.height);
      if (sharpness(sctx, small.width, small.height) < 30) return; // blurred: the phone is moving
    }
    ocrInvert = !ocrInvert; // alternate dark-on-light and light-on-dark signs
    const mine = session;
    const { data } = await worker.recognize(canvas);
    if (!running || mine !== session) return;
    if (tap && tapRead === tap) { tapRead = null; ui.ring.classList.remove('on'); }
    useText(data.text || '', !!tap);
  }

  // Compare read text with the stops around (or, without a position, all stops)
  function useText(text, wasTap) {
    const all = norm(text).split(' ').filter(Boolean);
    const tokens = all.filter((t) => t.length >= 2 || /^\d$/.test(t));
    if (!tokens.length) { if (wasTap) app.toast('No text found there. Move closer to the sign.'); return; }
    const now = Date.now();
    let pool = candidates;
    if (!position()) pool = allStopsMatching(tokens);
    const hits = [];
    const located = !!position();
    for (const c of pool) {
      let best = 0, what = '';
      for (const v of c.variants) {
        let m = matchIn(tokens, v);
        if (!distinctive(v)) m *= 0.85; // "Bahnhof" alone proves little
        // without a position, "Rathaus" fits dozens of towns: the town has to be on the sign too
        if (!located && v !== c.variants[0]) m = m * 0.8 + 0.2 * matchIn(tokens, c.variants[0].slice(0, c.variants[0].length - v.length).trim() || v);
        if (m > best) { best = m; what = v; }
      }
      const ev = evidence.get(c.uic) || {};
      if (best >= 0.72 && (!ev.ocrAt || now - ev.ocrAt > 12000 || best >= ev.ocr)) {
        Object.assign(ev, { ocr: best, ocrAt: now, ocrWhat: what, ocrUnique: true, ocrStrong: distinctive(what) });
        evidence.set(c.uic, ev);
        hits.push({ c, best });
      }
      // platform letter / number written next to a word like Kante, Gleis, Quai (e.g. "Kante C", "Gleis 7")
      const refs = [];
      for (let i = 0; i < all.length - 1; i++) {
        if (/^(kante|gleis|gl|steig|quai|voie|binario|perron|bay|platform)$/.test(all[i]) && /^[a-z0-9]{1,3}$/.test(all[i + 1])) refs.push(all[i + 1].toUpperCase());
      }
      if (refs.length) {
        const ei = c.st.edges.findIndex((e) => e.key && refs.includes(e.key));
        if (ei >= 0) { ev.edgeOcr = ei; ev.edgeOcrAt = now; evidence.set(c.uic, ev); }
      }
      // line numbers and destinations from its live departures
      if (ev.departures) {
        const lines = new Set(ev.departures.map((d) => norm(d.line)));
        const hit = tokens.filter((t) => /^\d{1,3}[a-z]?$/.test(t) && lines.has(t));
        ev.lines = new Set(hit).size >= 2 ? new Set(hit).size : 0;
        const dests = new Map(); // destination → edges it leaves from
        for (const d of ev.departures) if (d.edge != null) dests.set(norm(d.to), (dests.get(norm(d.to)) || new Set()).add(d.edge));
        for (const [dest, edges] of dests) {
          if (edges.size !== 1) continue;
          const edge = [...edges][0];
          const words = dest.split(' ').filter((t) => t.length >= 4 && !GENERIC.has(t));
          if (words.length && words.every((wd) => tokens.some((t) => ratio(t, wd) >= 0.85))) { ev.edgeDest = edge; ev.edgeDestAt = now; ev.destWhat = dest; }
        }
        evidence.set(c.uic, ev);
      }
    }
    hits.sort((a, b) => b.best - a.best);
    if (located && hits.length > 1) {
      // Signs also list destinations, which are names of other stops: of the stops read at once, the nearest
      // one is where you are; the others only count as "read", not as recognised
      const near = hits.reduce((a, b) => (b.c.dist < a.c.dist ? b : a));
      for (const h of hits) if (h !== near && h.c.dist > near.c.dist + 40) evidence.get(h.c.uic).ocrUnique = false;
    }
    if (!located && hits.length) {
      // no GPS: list the stops whose name was read; only a clear single winner counts as recognised
      const clear = hits.length === 1 || hits[0].best - hits[1].best >= 0.1;
      hits.forEach((h, i) => { evidence.get(h.c.uic).ocrUnique = clear && i === 0; });
      candidates = hits.slice(0, 8).map((h) => h.c);
      if (!clear) app.toast('Several stop names fit what was read (signs also list destinations). Turn on location to know which one is here.');
    }
    const bestHit = hits[0];
    if (wasTap && !bestHit) app.toast('Read: “' + text.replace(/\s+/g, ' ').trim().slice(0, 60) + '” – no stop nearby has that name.');
  }

  let nameIndex = null;
  function allStopsMatching(tokens) {
    if (!nameIndex) nameIndex = [...app.PLATFORMS].map(([uic, st]) => ({ uic, st, dist: 0, nearEdge: 0, variants: nameVariants(st.name) }));
    const long = tokens.filter((t) => t.length >= 4);
    if (!long.length) return [];
    // cheap pre-filter: share a 3-letter start with a read word
    const starts = new Set(long.map((t) => t.slice(0, 3)));
    return nameIndex.filter((c) => c.variants.some((v) => v.split(' ').some((t) => starts.has(t.slice(0, 3)))));
  }

  // ---------------------------------------------------------------- live departures (for lines/destinations + display)
  async function departures(c) {
    const ev = evidence.get(c.uic) || {};
    if (!depDue(ev)) return ev.departures;
    ev.depBusy = true;
    evidence.set(c.uic, ev);
    try {
      const res = await fetch(app.OPENDATA + 'stationboard?' + new URLSearchParams({ id: c.uic, limit: '30' }));
      const all = ((await res.json()).stationboard || []).filter((d) => d.stop && d.stop.departure);
      ev.departures = all.map((d) => {
        const next = d.passList && d.passList[1] ? app.coordOf(d.passList[1]) : null;
        const ll = app.platformLL(d.stop, null, next);
        const edge = c.st.edges.findIndex((e) => e.ll === ll);
        return { time: (d.stop.prognosis && d.stop.prognosis.departure) || d.stop.departure, delay: d.stop.delay || 0,
                 line: (d.number || d.name || '').replace(/^\D+\s/, ''), cat: d.category || '', to: d.to || '', edge: edge >= 0 ? edge : null, raw: d };
      });
      ev.depFailed = false;
      ev.depAt = Date.now();
    } catch {
      ev.departures = ev.departures || null;
      ev.depFailed = true;
      ev.depAt = Date.now() - 45000; // try again in 15 s
    }
    ev.depBusy = false;
    if (ui) ui.shownKey = '';
    return ev.departures;
  }

  // ---------------------------------------------------------------- photo fingerprints
  function loadIndex() {
    if (window.STOP_IMAGES_INDEX) return Promise.resolve(window.STOP_IMAGES_INDEX);
    return loadScript('stop-images/index.js').then(() => window.STOP_IMAGES_INDEX).catch(() => null);
  }

  function decode(b64) {
    const bin = atob(b64);
    const v = new Int8Array(bin.length);
    for (let i = 0; i < bin.length; i++) v[i] = (bin.charCodeAt(i) << 24) >> 24;
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    return { v, n: Math.sqrt(n) || 1 };
  }

  window.STOP_IMAGES_TILE = (key, data) => {
    const t = {};
    for (const [uic, refs] of Object.entries(data)) {
      t[uic] = refs.map(([src, prov, edge, lon, lat, head, thumb, page, credit, licence, emb]) =>
        ({ src, prov, edge, ll: lon != null ? [lon / 1e5, lat / 1e5] : null, head, thumb, page, credit, licence, emb: decode(emb) }));
    }
    tiles.set(key, t);
  };

  async function loadTilesAround(ll) {
    const index = await loadIndex();
    if (!index) return;
    const la = Math.floor(ll[1] * 10), lo = Math.floor(ll[0] * 10);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const key = `${la + dy}_${lo + dx}`;
      if (!index.tiles[key] || tiles.has(key)) continue;
      tiles.set(key, {}); // loading
      loadScript(`stop-images/t/${key}.js`).catch(() => tiles.delete(key));
    }
  }

  function refsOf(uic) {
    for (const t of tiles.values()) if (t[uic]) return t[uic];
    return null;
  }

  async function ensureModel() {
    if (model || modelState === 'loading' || modelState === 'failed') return model;
    const index = await loadIndex();
    if (!index) { modelState = 'failed'; return null; }
    modelState = 'loading';
    try {
      if (!window.ort) await loadScript(ORT_DIST + 'ort.wasm.min.js');
      window.ort.env.wasm.wasmPaths = ORT_DIST;
      window.ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      const m = index.model;
      const url = `https://huggingface.co/${m.repo}/resolve/${m.rev}/${m.file}`;
      let buf = null;
      try { // keep the 24 MB model on the phone after the first time
        const cache = await caches.open('stopvision-model');
        let res = await cache.match(url);
        if (!res) { res = await fetch(url); if (res.ok) await cache.put(url, res.clone()); }
        buf = await res.arrayBuffer();
      } catch { buf = await (await fetch(url)).arrayBuffer(); }
      model = await window.ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: ['wasm'] });
      modelState = 'ready';
    } catch (err) {
      modelState = 'failed';
      console.warn('Scan: image model unavailable', err);
    }
    return model;
  }

  // Fingerprint of the picture: same preprocessing as the database (shortest side → 224, centre crop, ImageNet norm)
  async function embedFrame() {
    const [w, h] = sourceSize();
    if (!w) return null;
    const side = Math.min(w, h);
    const c = document.createElement('canvas');
    c.width = c.height = INPUT;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source(), (w - side) / 2, (h - side) / 2, side, side, 0, 0, INPUT, INPUT);
    const d = ctx.getImageData(0, 0, INPUT, INPUT).data;
    const n = INPUT * INPUT;
    const x = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) for (let ch = 0; ch < 3; ch++) x[ch * n + i] = (d[i * 4 + ch] / 255 - MEAN[ch]) / STD[ch];
    const out = await model.run({ pixel_values: new window.ort.Tensor('float32', x, [1, 3, INPUT, INPUT]) });
    const hs = out.last_hidden_state.data; // [1, 1 + patches, 384]
    const dim = 384, tokens = hs.length / dim;
    const cls = hs.slice(0, dim), mean = new Float32Array(dim);
    for (let t = 1; t < tokens; t++) for (let k = 0; k < dim; k++) mean[k] += hs[t * dim + k];
    const unit = (v) => { let s = 0; for (const a of v) s += a * a; s = Math.sqrt(s) || 1; return v.map((a) => a / s); };
    const q = new Float32Array(2 * dim);
    q.set(unit(cls), 0); q.set(unit(mean), dim);
    return q.map((a) => a / Math.SQRT2);
  }

  async function comparePhotos() {
    const withRefs = candidates.filter((c) => refsOf(c.uic));
    if (!withRefs.length || (stillImage && stillFrames > 0) || !(await ensureModel())) return;
    if (stillImage) stillFrames++;
    // a photo linked to several of these stops (e.g. a view of the whole square) cannot tell them apart
    const shared = new Map();
    for (const c of withRefs) for (const r of refsOf(c.uic)) shared.set(r.page, (shared.get(r.page) || 0) + 1);
    const q = await embedFrame();
    if (!q || !running) return;
    const best = [];
    for (const c of withRefs) {
      let top = -1, topRef = null;
      for (const r of refsOf(c.uic)) {
        if (shared.get(r.page) > 1) continue;
        let dot = 0;
        for (let i = 0; i < q.length; i++) dot += q[i] * r.emb.v[i];
        let sim = dot / r.emb.n;
        if (!IDENTITY[r.prov] && r.prov === 'geo') sim -= 0.02; // photos tied only by place count a bit less
        if (r.head != null && headingOk() && angleDiff(r.head, heading) < 45) sim += 0.02; // taken looking the same way
        if (sim > top) { top = sim; topRef = r; }
      }
      if (topRef) best.push({ c, sim: top, ref: topRef });
    }
    if (!best.length) return;
    best.sort((a, b) => b.sim - a.sim);
    const sims = best.map((b) => b.sim);
    const median = sims[Math.floor(sims.length / 2)];
    best.forEach((b, i) => {
      const ev = evidence.get(b.c.uic) || {};
      ev.vis = b.sim;
      ev.visRef = b.ref;
      ev.visRel = b.sim >= VIS_MIN && best.length > 1 ? b.sim - median : 0;
      const margin = i === 0 && best.length > 1 ? b.sim - best[1].sim : 0;
      ev.visAt = Date.now();
      ev.visStreak = !stillImage && i === 0 && b.sim >= VIS_MIN && best.length > 1 && margin >= VIS_MARGIN ? (ev.visStreak || 0) + 1 : 0;
      evidence.set(b.c.uic, ev);
    });
  }

  // ---------------------------------------------------------------- what is shown
  // Which edge of a recognised stop you are looking at, and how we know (null = only the stop is known)
  function edgeOf(c) {
    const ev = evidence.get(c.uic) || {};
    const now = Date.now();
    if (ev.edgeOcr != null && now - ev.edgeOcrAt < 20000) return { i: ev.edgeOcr, why: 'Platform sign read' };
    if (ev.edgeDest != null && now - ev.edgeDestAt < 20000) return { i: ev.edgeDest, why: 'Destination read' };
    if (ev.visRef && ev.visRef.edge != null && ev.visStreak >= VIS_FRAMES) return { i: ev.visRef.edge, why: 'Matches a photo of this side', maybe: true };
    if (c.st.edges.length === 1) return { i: 0, why: '' };
    // the camera points at one edge and the others are well outside the picture
    const pos = position();
    if (headingOk() && pos && headingAcc <= 30) {
      const fov = screenFov();
      const offs = c.st.edges.map((e) => angleDiff(bearing(pos.ll, e.ll), heading));
      const inView = offs.map((o, i) => [o, i]).filter(([o]) => o <= fov / 2);
      if (inView.length === 1 && offs.every((o, i) => i === inView[0][1] || o > fov / 2 + 25)) return { i: inView[0][1], why: 'Only side in view', maybe: true };
    }
    return null;
  }

  function recognised(c) {
    const ev = evidence.get(c.uic) || {};
    if (ev.ocrAt && Date.now() - ev.ocrAt < 12000 && ev.ocr >= 0.8 && ev.ocrUnique && ev.ocrStrong) return 'sign';
    // photo match only together with the location: the stop that position + compass favour on their own
    if (ev.visStreak >= VIS_FRAMES && Date.now() - ev.visAt < 6000 && c.geoTop && c.ahead !== false) return 'photo';
    return null;
  }

  function placeTags() {
    const pos = position();
    const seen = new Set();
    if (pos && headingOk() && !stillImage) {
      const fov = screenFov();
      const W = ui.root.clientWidth, H = ui.root.clientHeight;
      const top = candidates[0];
      const shown = candidates.slice(0, 12);
      shown.forEach((c, n) => {
        const e = c.st.edges[c.aheadEdge != null ? c.aheadEdge : c.nearEdge];
        const off = ((bearing(pos.ll, e.ll) - heading + 540) % 360) - 180;
        if (Math.abs(off) > fov / 2 + 4) return;
        const x = W / 2 + Math.tan(off * toRad) / Math.tan(fov / 2 * toRad) * W / 2;
        const y = H * (0.42 - Math.min(0.2, distM(pos.ll, e.ll) / 1000)) - (n % 3) * 30; // nearer = lower
        let tag = ui.tags.get(c.uic);
        if (!tag) {
          tag = $('div', 'sv-tag');
          const pill = $('span');
          tag.append(pill, $('i'));
          ui.ar.appendChild(tag);
          ui.tags.set(c.uic, tag);
        }
        const pill = tag.firstChild;
        const label = c.st.name.split(',').pop().trim();
        const key = label + e.ref + Math.round(distM(pos.ll, e.ll) / 5);
        if (tag.dataset.key !== key) {
          tag.dataset.key = key;
          pill.replaceChildren(icon(c.st.mode), $('em', null, label));
          if (e.ref) pill.append($('span', 'sv-ref', e.ref));
          pill.append($('small', null, Math.round(distM(pos.ll, e.ll)) + ' m'));
        }
        tag.classList.toggle('hit', c === top && !!recognised(c));
        tag.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
        tag.style.opacity = '1';
        seen.add(c.uic);
      });
    }
    for (const [uic, tag] of ui.tags) if (!seen.has(uic)) { tag.remove(); ui.tags.delete(uic); }
  }

  function chip(text, on) { const li = $('li', on ? 'on' : null, text); return li; }

  function renderSheet() {
    const pos = position();
    const c = candidates[0];
    if (!c) {
      const msg = !pos
        ? (app.position() ? 'Waiting for a precise location…' : 'Location is off: point the camera at a stop sign and tap it to read the name.')
        : 'No stops within a few hundred metres.';
      if (ui.shownKey !== msg) { ui.shownKey = msg; ui.sheet.replaceChildren($('p', 'sv-hint', msg)); }
      return;
    }
    const ev = evidence.get(c.uic) || {};
    const how = recognised(c);
    const edge = edgeOf(c);
    const e = edge ? c.st.edges[edge.i] : null;
    const deps = ev.departures ? ev.departures.filter((d) => !e || d.edge === edge.i || d.edge == null && c.st.edges.length === 1) : null;
    const key = [c.uic, how, edge && edge.i, ev.depAt, ev.departures && ev.departures.length, ev.depFailed, ev.visRef && ev.visRef.page, ev.ocrAt, c.ahead, candidates.slice(1, 4).map((x) => x.uic).join()].join('|');
    if (key === ui.shownKey) return;
    ui.shownKey = key;

    const state = $('span', 'sv-state' + (how ? ' ok' : ''), how ? 'Recognised' : c.ahead ? 'Nearby · ahead' : 'Nearby');
    const main = $('div', 'sv-main');
    const txt = $('div');
    const sub = [MODE_WORD[c.st.mode] || 'Stop'];
    if (e && e.ref) sub.push(`${EDGE_WORD(c.st.mode)} ${e.ref}${edge.maybe ? ' (probably)' : ''}`);
    if (pos) sub.push(Math.round(c.dist) + ' m');
    txt.append($('b', null, c.st.name), $('small', null, sub.join(' · ')));
    main.append(icon(c.st.mode), txt);

    const why = $('ul', 'sv-why');
    if (ev.ocrAt && Date.now() - ev.ocrAt < 12000 && ev.ocr >= 0.72) why.append(chip(`Sign read “${ev.ocrWhat}”`, true));
    if (edge && edge.why) why.append(chip(edge.why + (ev.destWhat && edge.why === 'Destination read' ? ` “${ev.destWhat}”` : ''), !edge.maybe));
    if (ev.visStreak >= VIS_FRAMES) why.append(chip('Looks like its photos', how === 'photo'));
    else if (ev.vis != null && ev.visRel > 0.02) why.append(chip('Similar to its photos', false));
    if (c.ahead) why.append(chip('In front of the camera', false));
    if (pos && c === candidates.slice().sort((a, b) => a.dist - b.dist)[0]) why.append(chip('Closest stop', false));
    if (!refsOf(c.uic)) why.append(chip('No reference photos yet', false));

    const nodes = [state, main, why];
    if (deps && deps.length) {
      const ul = $('ul', 'sv-deps');
      for (const d of deps.slice(0, 4)) {
        const li = $('li');
        li.append($('time', null, new Date(d.time).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })),
          app.badge ? app.badge(d.raw) : $('span', 'sv-line', d.line || d.cat), $('span', 'sv-to', d.to));
        if (d.delay > 0) li.append($('span', 'sv-late', `+${d.delay}′`));
        ul.appendChild(li);
      }
      nodes.push(ul);
    } else if (deps) nodes.push($('p', 'sv-hint', 'No departures in the next hours.'));
    else {
      if (depDue(ev)) departures(c).catch(() => {});
      nodes.push($('p', 'sv-hint', ev.depFailed ? 'Departures could not be loaded.' : 'Loading departures…'));
    }

    const actions = $('div', 'sv-actions');
    const show = $('button', null, 'Show on map');
    show.type = 'button';
    show.addEventListener('click', () => { const uic = c.uic, i = edge ? edge.i : null; closeScan(); app.openStop(uic, i); });
    actions.append(show);
    nodes.push(actions);

    const ref = ev.visRef && ev.vis >= VIS_MIN ? ev.visRef : null;
    if (ref) {
      const p = $('div', 'sv-photo');
      if (ref.thumb) { const img = $('img'); img.src = ref.thumb; img.alt = 'Reference photo'; img.loading = 'lazy'; p.append(img); }
      const a = $('a', null, `Closest reference photo: ${ref.credit}${ref.licence ? ', ' + ref.licence : ''}`);
      if (ref.page) { a.href = ref.page; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      p.append(a);
      nodes.push(p);
    }
    const alts = candidates.slice(1, 4);
    if (alts.length) {
      const ul = $('ul', 'sv-alt');
      for (const a of alts) {
        const li = $('li');
        li.append(icon(a.st.mode), $('span', null, a.st.name), $('small', null, pos ? Math.round(a.dist) + ' m' : ''));
        li.addEventListener('click', () => { closeScan(); app.openStop(a.uic, null); });
        ul.appendChild(li);
      }
      nodes.push(ul);
    }
    ui.sheet.replaceChildren(...nodes);
  }

  function renderStatus() {
    const busy = [];
    if (ocrState === 'loading') busy.push('loading the sign reader');
    if (modelState === 'loading') busy.push('loading the image model (24 MB, once)');
    const pos = position();
    const title = stillImage ? 'Photo' : !pos ? 'Point at a stop sign' : headingOk() ? 'Look around' : 'Point at a stop';
    let detail = busy.length ? busy.join(', ') + '…' : 'Tap a sign to read it.';
    if (pos && !headingOk() && !stillImage) detail = 'No compass: using distance only. ' + detail;
    if (pos && pos.acc > 60) detail = `Location ±${Math.round(pos.acc)} m. ` + detail;
    setStatus(title, detail);
  }

  // ---------------------------------------------------------------- loop
  let lastCand = 0, lastStatus = 0;
  let prevTop = null;
  const depDue = (ev) => !ev.depBusy && (!ev.depAt || Date.now() - ev.depAt > 60000);

  function loop(mine) {
    let busyOcr = false, busyVis = false;
    const frame = () => {
      if (!running || mine !== session) return;
      const now = Date.now();
      if (now - lastCand > 3000 && position()) { lastCand = now; findCandidates(); }
      score();
      placeTags();
      renderSheet();
      if (!busyOcr && (tapRead || now - lastOcr > 1500)) {
        busyOcr = true;
        // the next reading waits 1.5 s after this one ends, so photo matching gets its turn in between
        readSigns().catch((e) => console.warn(e)).finally(() => { busyOcr = false; lastOcr = Date.now(); });
      }
      if (!busyVis && !busyOcr && now - lastVis > 1500 && candidates.length) {
        busyVis = true; lastVis = now;
        comparePhotos().catch((e) => console.warn(e)).finally(() => { busyVis = false; });
      }
      if (candidates[0] && depDue(evidence.get(candidates[0].uic) || {})) departures(candidates[0]).catch(() => {});
      if (now - lastStatus > 1000) { lastStatus = now; renderStatus(); }
      requestAnimationFrame(frame);
    };
    renderStatus();
    requestAnimationFrame(frame);
  }

  function useStill(file) {
    if (stillImage) URL.revokeObjectURL(stillImage);
    evidence.clear(); // what the live camera saw does not apply to this photo
    stillFrames = 0;
    stillReads = 0;
    if (!position()) candidates = [];
    stillImage = URL.createObjectURL(file);
    ui.still.src = stillImage;
    ui.root.classList.add('still');
    ui.still.onload = () => { if (!ui) return; lastOcr = 0; lastVis = 0; renderStatus(); };
  }

  // ---------------------------------------------------------------- open / close
  const stopStream = (st) => { if (st) st.getTracks().forEach((t) => t.stop()); };
  let session = 0;

  async function openScan(hooks, cameraPromise, orientationPromise) {
    if (running) { cameraPromise.then(stopStream, () => {}); return; } // already open: drop the second camera
    const mine = ++session;
    app = hooks;
    ui = buildUI();
    running = true;
    evidence.clear();
    findCandidates();
    renderStatus();
    window.addEventListener('deviceorientationabsolute', onOrientation);
    window.addEventListener('deviceorientation', onOrientation);
    if (orientationPromise) orientationPromise.catch(() => {});
    loop(mine);
    try {
      const got = await cameraPromise;
      if (mine !== session || !running) { stopStream(got); return; } // closed (or reopened) while asking
      stream = got;
      ui.video.srcObject = got;
      await ui.video.play().catch(() => {});
    } catch (err) {
      if (mine !== session) return;
      console.warn('Scan: no camera', err);
      setStatus('No camera', 'Allow camera access, or take a photo with the camera button.');
    }
    if (mine !== session) return;
    ensureOcr();
    loadIndex().then((idx) => { if (idx) setTimeout(() => { if (running && mine === session) ensureModel(); }, 1500); }); // after the sign reader
  }

  function closeScan() {
    if (!running) return;
    running = false;
    session++;
    stopStream(stream);
    stream = null;
    window.removeEventListener('deviceorientationabsolute', onOrientation);
    window.removeEventListener('deviceorientation', onOrientation);
    document.removeEventListener('keydown', onKey);
    if (stillImage) URL.revokeObjectURL(stillImage);
    stillImage = null;
    tapRead = null;
    ui.root.remove();
    ui = null;
    if (app && app.onClose) app.onClose();
  }

  window.STOPVISION = { open: openScan, close: closeScan, _debug: { evidence, candidates: () => candidates, tiles, matchIn, nameVariants, norm, distinctive, useText, setApp: (a) => { app = a; }, recognised, findCandidates, score, edgeOf } };
})();
