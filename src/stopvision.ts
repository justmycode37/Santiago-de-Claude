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
  const IDENTITY: Partial<Record<StopImagesProvenance, number>> = { wd: 1, cat: 1, sbb: 1, osm: 1 }; // photos tied to the stop by identity, not just by place
  // Photo similarity (cosine of the stored fingerprints). Measured on 1,200 photos of 313 Bern + Zürich stops
  // (python3 tools/build_stop_images.py --calibrate): photos of the same stop have a median similarity of 0.48,
  // photos of other stops within 600 m 0.30; picking the stop by photo alone is right only ~50–55 % of the time,
  // whatever the threshold. So a photo match only counts as recognition when the location agrees with it.
  const VIS_MIN = 0.6;     // below this nothing in the picture looks like any reference photo
  const VIS_MARGIN = 0.05; // best stop must beat the runner-up by this much…
  const VIS_FRAMES = 3;    // …in this many frames in a row

  type LoadState = 'idle' | 'loading' | 'ready' | 'failed';
  interface ScanUI {
    root: HTMLElement; video: HTMLVideoElement; still: HTMLImageElement; ar: HTMLDivElement; ring: HTMLDivElement;
    status: HTMLDivElement; sheet: HTMLDivElement; debug: HTMLPreElement; tags: Map<string, HTMLDivElement>; shownKey: string;
    // For screen readers: the live region a recognised stop is said through, what the status last showed, and
    // which stop has been said (pending: at the top since `since`; said: stop → 'name' or 'all'; last: said last)
    say: HTMLDivElement; statusKey: string;
    spoken: { pending: string; since: number; said: Map<string, 'name' | 'all'>; last: string };
  }
  // The live camera or the photo taken instead: a video has the one pair of sizes, a picture the other
  interface FrameSize { videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number }
  type Frame = (HTMLVideoElement | HTMLImageElement) & FrameSize;
  interface Region { x: number; y: number; w: number; h: number }
  // iOS Safari's compass, next to the standard event
  interface CompassEvent extends DeviceOrientationEvent { webkitCompassHeading?: number; webkitCompassAccuracy?: number }
  type Canvas2DNoFilter = Omit<CanvasRenderingContext2D, 'filter'>; // browsers without canvas filters
  interface ServedLine { edge: number | null; line: string | null; to: string | null }
  interface ScanPca { k: number; mean: Float32Array; w: Int8Array; scale: Float32Array }
  // what the model worker answers
  interface EmbedReply { type: 'emb'; id: number; v: Float32Array; ms: number }
  type ModelReply = { type: 'ready' } | EmbedReply | { type: 'error'; id?: number; message: string };
  interface PendingEmbed { resolve: (m: EmbedReply) => void; reject: (e: Error) => void }
  interface PhotoMatch { c: StopVisionCandidate; sim: number; ref: StopVisionPhoto }
  interface ScanStats {
    frames: number[]; ocr: number[]; photo: number[]; engine: StopVisionBenchResult['engine'];
    modelLoadMs: number; ocrLoadMs: number; longFrames: number;
  }

  let app: StopVisionHooks | null = null;          // hooks from index.html
  let ui: ScanUI | null = null;           // DOM
  let stream: MediaStream | null = null;
  let running = false;
  let heading: number | null = null;      // degrees, where the camera looks; null = unknown
  let headingAcc = 30;     // degrees
  let headingAt = 0;
  let candidates: StopVisionCandidate[] = [];     // stops around you, scored
  let candidatesBy = '';   // 'gps' (around you) or 'sign' (no position: stops whose name was read)
  const evidence = new Map<string, StopVisionEvidence>(); // uic → { ocr, ocrAt, ocrWhat, edgeOcr, vis, visRef, visStreak, departures }
  const tiles = new Map<string, StopVisionTile>();    // photo tiles loaded: key → { uic: refs }
  let modelState: LoadState = 'idle';
  let ocr: TesseractWorker | null = null, ocrState: LoadState = 'idle', ocrLang = '', ocrFailedAt = 0;
  let lastOcr = 0, lastVis = 0, ocrPass = 0;
  let tapRead: { x: number; y: number } | null = null;      // { x, y } in video pixels: read the sign there next
  let debugOn = typeof location !== 'undefined' && /[?&]scandebug(&|$)/.test(location.search);
  let stillImage: string | null = null;   // a photo taken with the file input instead of the live camera
  let stillFrames = 0;     // photo comparisons done on that photo (one is enough: it does not change)
  let stillReads = 0;      // sign readings done on it

  // ---------------------------------------------------------------- small helpers
  const $ = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: string | null) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const toRad = Math.PI / 180;
  const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
  // Is a reading still current? With the live camera it fades after a while (you have moved on); a photo does not change.
  const fresh = (at: number | undefined, ms: number) => !!at && (!!stillImage || Date.now() - at < ms);
  function distM(a: LngLat, b: LngLat) {
    const k = Math.cos((a[1] + b[1]) / 2 * toRad);
    return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111320;
  }
  function bearing(a: LngLat, b: LngLat) {
    const k = Math.cos((a[1] + b[1]) / 2 * toRad);
    return (Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) / toRad + 360) % 360;
  }
  const norm = (s: string | null | undefined) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  function lev(a: string, b: string) {
    if (a === b) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }
  const ratio = (a: string, b: string) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);
  function loadScript(src: string) {
    return new Promise<Event>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve; s.onerror = () => reject(new Error('could not load ' + src));
      document.head.appendChild(s);
    });
  }
  const GENERIC = new Set(['bahnhof', 'station', 'gare', 'stazione', 'post', 'dorf', 'zentrum', 'centre', 'centro', 'nord', 'sud', 'ost', 'west', 'bhf', 'sbb', 'cff', 'ffs']);
  // What a sign would show: "Bern, Zytglogge" → "zytglogge" (and the full name); "Muri bei Bern" → itself
  function nameVariants(name: string) {
    const parts = String(name).split(',').map((p) => norm(p)).filter(Boolean);
    const out = new Set([parts.join(' ')]);
    if (parts.length > 1) out.add(parts[parts.length - 1]);
    return [...out].filter((v) => v.replace(/ /g, '').length >= 4);
  }
  const distinctive = (v: string) => v.split(' ').some((t) => t.length >= 4 && !GENERIC.has(t));

  // Best fuzzy match of a name in OCR text: compare with every run of words of about the same length
  function matchIn(tokens: string[], variant: string) {
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
  .sv-tag > span { display: flex; align-items: center; gap: 6px; max-width: 44vw; padding: 6px 10px 6px 6px; border-radius: 18px;
                 background: rgba(28,28,30,.78); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
                 font-size: 13px; font-weight: 600; white-space: nowrap; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
  .sv-tag > span em { font-style: normal; overflow: hidden; text-overflow: ellipsis; }
  .sv-tag small { font-weight: 500; color: #c7c7cc; }
  .sv-tag i { width: 2px; height: 26px; background: rgba(255,255,255,.75); }
  .sv-tag.hit > span { background: var(--navy, #344D77); outline: 2px solid #fff; }
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
  .sv-alt li { border-top: 1px solid rgba(255,255,255,.1); }
  .sv-alt button { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 0; border: 0; background: none; color: inherit;
                   font: inherit; font-size: 14px; text-align: left; cursor: pointer; }
  .sv-alt button span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-alt button small { color: #aeaeb2; }
  .sv :focus-visible { outline: 3px solid #0a84ff; outline-offset: 2px; }
  .sv:focus { outline: none; }
  /* said to screen readers, not shown */
  .sv-say, .sv-sr { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .sv-file { display: none; }
  .sv-debug { position: absolute; left: 12px; top: calc(env(safe-area-inset-top) + 64px); margin: 0; padding: 8px 10px; border-radius: 10px;
              background: rgba(0,0,0,.66); color: #9f9; font: 11px/1.45 ui-monospace, Menlo, Consolas, monospace; white-space: pre; pointer-events: none; display: none; }
  .sv.debug .sv-debug { display: block; }
  `;

  const ICONS = {
    train: '<path d="M7 3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM4 10h16M8 17l-2 4M16 17l2 4"/>',
    tram: '<path d="M8 2h8M12 2v3M7 5h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM5 12h14M9 18l-2 4M15 18l2 4"/>',
    bus: '<path d="M6 3h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM4 11h16M7 18v3M17 18v3M8 14.5h.01M16 14.5h.01"/>',
    boat: '<path d="M3 17l2 4h14l2-4zM6 17V9h12v8M12 3v6M9 6h6"/>',
    cable: '<path d="M2 4l20 4M12 6v4M7 10h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM5 15h14"/>',
  };
  const icon = (mode: StopVisionMode) => {
    const s = $('span', 'sv-ic');
    s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[mode] || ICONS.bus}</svg>`;
    return s;
  };
  const MODE_WORD = { train: 'Train station', tram: 'Tram stop', bus: 'Bus stop', boat: 'Boat pier', cable: 'Cable car' };
  const EDGE_WORD = (mode: StopVisionMode) => (mode === 'train' || mode === 'cable' ? 'Platform' : mode === 'boat' ? 'Pier' : 'Bay');

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
    root.tabIndex = -1; // focus goes here when Scan opens, so a screen reader starts in it
    const video = $('video');
    video.setAttribute('playsinline', ''); video.muted = true; video.autoplay = true;
    const still = $('img', 'sv-still');
    still.alt = '';
    const ar = $('div', 'sv-ar');
    const ring = $('div', 'sv-ring');
    // the camera picture and what is drawn over it say nothing to a screen reader: what is found is put in words below
    for (const el of [video, still, ar, ring]) el.setAttribute('aria-hidden', 'true');
    const top = $('div', 'sv-top');
    const close = $('button', 'sv-btn');
    close.type = 'button'; close.setAttribute('aria-label', 'Close scan');
    close.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';
    const status = $('div', 'sv-status'); // read when moved to; what happens by itself is said through `say` below
    const shoot = $('button', 'sv-btn');
    shoot.type = 'button'; shoot.setAttribute('aria-label', 'Use a photo instead');
    shoot.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
    const file = $('input', 'sv-file');
    file.type = 'file'; file.accept = 'image/*'; file.setAttribute('capture', 'environment');
    top.append(close, status, shoot);
    const sheet = $('div', 'sv-sheet');
    // One sentence when a stop is recognised ("Recognised: Zytglogge, Bay C, 15 metres ahead. Next: …"): the whole
    // card as a live region would be read out again at every small change
    const say = $('div', 'sv-say');
    say.setAttribute('role', 'status');
    say.setAttribute('aria-live', 'polite');
    say.setAttribute('translate', 'no'); // put in already in the app's language (a11y.js), so it is not read out twice
    const debug = $('pre', 'sv-debug');
    root.append(video, still, ar, ring, top, sheet, say, file, debug);
    // diagnostics: open the app with ?scandebug, or tap the status text three times
    let taps = 0, tapAt = 0;
    status.addEventListener('click', () => {
      taps = Date.now() - tapAt < 600 ? taps + 1 : 1; tapAt = Date.now();
      if (taps >= 3) { debugOn = !debugOn; root.classList.toggle('debug', debugOn); taps = 0; }
    });
    if (debugOn) root.classList.add('debug');
    document.body.appendChild(root);
    close.addEventListener('click', closeScan);
    shoot.addEventListener('click', () => file.click());
    file.addEventListener('change', () => { if (file.files![0]) useStill(file.files![0]); file.value = ''; });
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
    // a dialog: the app behind it is out of reach while Scan is open (a11y.js; scan-bench.html has none)
    if (window.A11Y) window.A11Y.openDialog(root);
    else root.focus({ preventScroll: true });
    return { root, video, still, ar, ring, status, sheet, say, debug, tags: new Map(), shownKey: '', statusKey: '', spoken: { pending: '', since: 0, said: new Map(), last: '' } };
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeScan(); };

  // Screen point → pixel in the video/photo (object-fit: cover)
  function toSourcePx(el: Frame, cx: number, cy: number) {
    const w = el.videoWidth || el.naturalWidth, h = el.videoHeight || el.naturalHeight;
    if (!w || !h) return null;
    const r = el.getBoundingClientRect();
    const s = Math.max(r.width / w, r.height / h);
    return { x: (cx - r.left - (r.width - w * s) / 2) / s, y: (cy - r.top - (r.height - h * s) / 2) / s };
  }

  function setStatus(title: string, detail: string) {
    const key = title + '|' + (detail || '');
    if (ui!.statusKey === key) return; // unchanged: leave it, a screen reader may be on it
    ui!.statusKey = key;
    ui!.status.replaceChildren($('b', null, title), document.createTextNode(' ' + (detail || '')));
  }

  // ---------------------------------------------------------------- said to screen readers (and Read aloud)
  function announce(text: string) {
    if (!ui || !ui.say || !text) return;
    if (window.A11Y) window.A11Y.say(text, { region: ui.say });
    else ui.say.textContent = text;
  }
  const clock = (t: string) => new Date(t).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
  const lineWords = (d: StopVisionDeparture) => (app!.lineName ? app!.lineName(d.raw) : d.line || d.cat || 'Departure');
  const depWords = (d: StopVisionDeparture) => `${lineWords(d)} to ${d.to} at ${clock(d.time)}${d.delay > 0 ? `, ${d.delay} ${d.delay === 1 ? 'minute' : 'minutes'} late` : ''}`;
  const depsWords = (deps: StopVisionDeparture[] | null) => (!deps ? '' : deps.length ? `Next: ${deps.slice(0, 3).map(depWords).join('; ')}.` : 'No departures in the next hours.');
  // The stop at the top, once it has held for a moment, and its departures when they are in: each said once
  function speakTop(c: StopVisionCandidate, how: 'sign' | 'photo' | null, edge: StopVisionEdgeGuess | null, e: StopVisionEdge | null,
    deps: StopVisionDeparture[] | null, pos: StopVisionPosition | null, failed: boolean | undefined) {
    const sp = ui!.spoken, now = Date.now();
    const k = `${c.uic}|${edge ? edge.i : ''}|${how ? 1 : 0}`;
    if (k !== sp.pending) { sp.pending = k; sp.since = now; }
    if (now - sp.since < 1500) return; // a stop that only flickers to the top is not read out
    const had = sp.said.get(k); // undefined, 'name' (said without departures) or 'all'
    if (had === 'all' || (had === 'name' && !deps)) return;
    if (had === 'name') { sp.said.set(k, 'all'); if (sp.last === k) announce(depsWords(deps)); return; }
    if (!deps && !failed && now - sp.since < 4500) return; // a little patience, to say the stop and its departures in one go
    const parts = [`${how ? 'Recognised' : !pos ? 'Possible match' : 'Nearest stop'}: ${c.st.name}`];
    if (e && e.ref) parts.push(`${EDGE_WORD(c.st.mode)} ${e.ref}${edge!.maybe ? ', probably' : ''}`);
    if (pos) parts.push(`${Math.max(5, Math.round(c.dist / 5) * 5)} metres${c.ahead ? ' ahead' : ''}`);
    sp.said.set(k, deps ? 'all' : 'name');
    sp.last = k;
    announce(`${parts.join(', ')}. ${depsWords(deps)}`.trim());
  }

  // ---------------------------------------------------------------- compass
  // Where the back camera points, from the device orientation (W3C: R = Rz(α)·Rx(β)·Ry(γ); camera = −z axis).
  function onOrientation(e: CompassEvent) {
    let h: number | null = null, acc = 25;
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
      // iOS: compass heading of the device, corrected for how the screen is turned
      const turn = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
      h = (e.webkitCompassHeading + turn + 360) % 360;
      acc = e.webkitCompassAccuracy! > 0 ? Math.max(10, e.webkitCompassAccuracy!) : 30;
      if (e.beta != null && Math.abs(e.beta) < 25) acc = 60; // lying flat: the camera looks at the ground
    } else if (e.absolute && e.alpha != null) {
      const a = e.alpha * toRad, b = e.beta! * toRad, g = (e.gamma || 0) * toRad;
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
    const el: Frame = stillImage ? ui!.still : ui!.video;
    const w = el.videoWidth || el.naturalWidth || 3, h = el.videoHeight || el.naturalHeight || 4;
    const full = 2 * Math.atan(Math.tan(37.5 * toRad) * w / Math.hypot(w, h)) / toRad;
    const sw = ui!.root.clientWidth, sh = ui!.root.clientHeight;
    const visible = Math.min(1, (sw / sh) / (w / h));
    return 2 * Math.atan(Math.tan(full / 2 * toRad) * visible) / toRad;
  }

  // ---------------------------------------------------------------- candidates (geometry)
  function position() {
    const p = app!.position();
    return p && p.ll && p.age < 120000 && p.acc < 500 ? p : null;
  }

  function findCandidates() {
    const pos = position();
    if (!pos) { if (candidatesBy === 'gps') { candidates = []; candidatesBy = ''; } return; }
    const radius = Math.min(600, Math.max(150, 3 * pos.acc + 60));
    const out: StopVisionCandidate[] = [];
    for (const [uic, st] of app!.PLATFORMS) {
      let best = Infinity, bestI = 0;
      st.edges.forEach((e, i) => { const d = distM(pos.ll, e.ll); if (d < best) { best = d; bestI = i; } });
      if (best <= radius) out.push({ uic, st, dist: best, nearEdge: bestI, variants: nameVariants(st.name) });
    }
    out.sort((a, b) => a.dist - b.dist);
    candidates = out.slice(0, 40);
    candidatesBy = 'gps';
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
          const off = angleDiff(bearing(pos.ll, e.ll), heading!);
          if (off < bestOff) { bestOff = off; c.aheadEdge = i; }
        });
        c.ahead = bestOff <= slack;
        s += c.ahead ? 0.8 : -Math.min(1.5, (bestOff - slack) / 40); // soft: compasses can be off by tens of degrees
      }
      c.geo = s; // location + compass only
      if (fresh(ev.ocrAt, 12000) && ev.ocr! >= 0.72) s += 6 * (ev.ocr! - 0.6) / 0.4; // a read name dominates
      if (ev.lines) s += Math.min(1, 0.4 * ev.lines);
      if (ev.vis != null && ev.visRel != null) s += Math.max(-0.5, Math.min(1.5, ev.visRel * 12)); // tie-breaker
      c.score = s;
    }
    const byGeo = candidates.slice().sort((a, b) => b.geo! - a.geo!);
    candidates.forEach((c) => { c.geoTop = c === byGeo[0] && (byGeo.length < 2 || byGeo[0].geo! - byGeo[1].geo! > 0.15); });
    candidates.sort((a, b) => b.score! - a.score!);
    // keep the stop shown unless another one is clearly better (no flicker between two close scores)
    const keep = prevTop && candidates.includes(prevTop) && candidates[0] !== prevTop && candidates[0].score! - prevTop.score! < 0.3;
    if (keep) candidates.splice(0, 0, ...candidates.splice(candidates.indexOf(prevTop!), 1));
    prevTop = candidates[0] || null;
  }

  // ---------------------------------------------------------------- reading signs
  function ocrLanguage(ll: LngLat | null) {
    if (!ll) return 'deu+fra';
    const [lon, lat] = ll;
    if (lat < 46.45 && lon > 8.38) return 'ita';
    if (lon < 6.95 || (lat < 46.4 && lon < 7.55)) return 'fra';
    if (lon < 7.35 && lat < 47.25) return 'fra+deu'; // Fribourg, Biel/Bienne, Valais border
    return 'deu';
  }

  async function ensureOcr() {
    const lang = ocrLanguage(position() && position()!.ll);
    if (ocr && ocrLang === lang) return ocr;
    if (ocrState === 'loading' || (ocrState === 'failed' && Date.now() - ocrFailedAt < 30000)) return null;
    ocrState = 'loading';
    const t0 = performance.now();
    const mine = session;
    try {
      if (!window.Tesseract) await loadScript(TESSERACT);
      if (ocr) { const old = ocr; ocr = null; await old.terminate(); }
      const reader = await window.Tesseract!.createWorker(lang.split('+'), 1); // LSTM engine; language data from jsDelivr
      if (mine !== session || !running) { reader.terminate(); ocrState = 'idle'; return null; } // closed meanwhile
      ocr = reader;
      await ocr.setParameters({ tessedit_pageseg_mode: '11' });     // sparse text: signs scattered in a street scene
      ocrLang = lang;
      ocrState = 'ready';
      stats.ocrLoadMs = Math.round(performance.now() - t0);
      return ocr;
    } catch (err) {
      ocrState = 'failed';
      ocrFailedAt = Date.now();
      console.warn('Scan: OCR unavailable', err);
      return null;
    }
  }

  // Sharpness of a grey frame (variance of the Laplacian): skip blurred frames
  function sharpness(ctx: CanvasRenderingContext2D, w: number, h: number) {
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

  function source(): Frame { return stillImage ? ui!.still : ui!.video; }
  function sourceSize() { const s = source(); return [s.videoWidth || s.naturalWidth, s.videoHeight || s.naturalHeight] as [w: number, h: number]; }

  // A frame (or the part around a tap) for OCR: grey, contrast stretched, optionally inverted (white on blue signs)
  // The frame (or the part around a tap) for OCR, as a JPEG: grey, more contrast, inverted for light-on-dark signs.
  // The browser's own canvas filters do the pixel work (no JS loop over a million pixels on the page), and the
  // JPEG is encoded asynchronously; browsers without canvas filters fall back to a JS loop.
  let ocrCanvasEl: HTMLCanvasElement | null = null, lumaCanvas: HTMLCanvasElement | null = null;
  function isDark(region: Region) {
    if (!lumaCanvas) { lumaCanvas = document.createElement('canvas'); lumaCanvas.width = lumaCanvas.height = 24; }
    const g = lumaCanvas.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(source(), region.x, region.y, region.w, region.h, 0, 0, 24, 24);
    const d = g.getImageData(0, 0, 24, 24).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
    return sum / 576 < 100; // mostly dark: the text is probably light
  }
  async function ocrImage(region: Region | null, invert: boolean | ((dark: boolean) => boolean)) {
    const [w, h] = sourceSize();
    const r = region || { x: w * 0.05, y: h * 0.05, w: w * 0.9, h: h * 0.75 }; // signs are rarely at the bottom
    const flip = typeof invert === 'function' ? invert(isDark(r)) : invert;
    const scale = Math.min(1, 1400 / r.w);
    if (!ocrCanvasEl) ocrCanvasEl = document.createElement('canvas');
    const c = ocrCanvasEl;
    c.width = Math.round(r.w * scale); c.height = Math.round(r.h * scale);
    const ctx: CanvasRenderingContext2D | Canvas2DNoFilter = c.getContext('2d', { willReadFrequently: true })!;
    if ('filter' in ctx) {
      ctx.filter = `grayscale(1) contrast(1.35)${flip ? ' invert(1)' : ''}`;
      ctx.drawImage(source(), r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
      ctx.filter = 'none';
    } else {
      ctx.drawImage(source(), r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
        d[i] = d[i + 1] = d[i + 2] = flip ? 255 - v : v;
      }
      ctx.putImageData(img, 0, 0);
    }
    const blob = await new Promise<Blob | null>((resolve) => (c.toBlob ? c.toBlob(resolve, 'image/jpeg', 0.92) : resolve(null)));
    return blob || c;
  }

  let gateCanvas: HTMLCanvasElement | null = null;
  async function readSigns() {
    const mine = session;
    const reader = await ensureOcr();
    if (!reader || !running || !ui || mine !== session) return;
    const [w, h] = sourceSize();
    if (!w) return;
    if (!tapRead && !stillImage) {
      // cheap check on a 160 px copy first: a blurred frame (phone moving) is not worth reading
      if (!gateCanvas) gateCanvas = document.createElement('canvas');
      gateCanvas.width = 160; gateCanvas.height = Math.round(160 * h / w);
      const g = gateCanvas.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(source(), 0, 0, gateCanvas.width, gateCanvas.height);
      if (sharpness(g, gateCanvas.width, gateCanvas.height) < 30) return;
    }
    let region: Region | null = null;
    const tap = tapRead;
    if (tap) {
      const rw = w * 0.7, rh = h * 0.28;
      region = { x: Math.max(0, Math.min(w - rw, tap.x - rw / 2)), y: Math.max(0, Math.min(h - rh, tap.y - rh / 2)), w: rw, h: rh };
    } else if (stillImage && stillReads >= 2) return; // a photo does not change: read it twice (normal + inverted)
    if (stillImage && !tap) stillReads++;
    ocrPass++;
    // polarity follows the picture (dark crop → light text); every 4th reading, and the second reading of a photo,
    // tries the other one, for signs that fool the guess
    const other = stillImage && !tap ? stillReads === 2 : ocrPass % 4 === 0;
    const image = await ocrImage(region, (dark) => (other ? !dark : dark));
    if (!running || !ui || mine !== session) return;
    const t0 = performance.now();
    const { data } = await reader.recognize(image);
    stats.ocr.push(performance.now() - t0);
    if (!running || mine !== session) return;
    if (tap && tapRead === tap) { tapRead = null; ui.ring.classList.remove('on'); }
    await useText(data.text || '', !!tap);
  }

  // Compare read text with the stops around (or, without a position, all stops)
  async function useText(text: string, wasTap: boolean) {
    const all = norm(text).split(' ').filter(Boolean);
    const tokens = all.filter((t) => t.length >= 2 || /^\d$/.test(t));
    if (!tokens.length) { if (wasTap) app!.toast('No text found there. Move closer to the sign.'); return; }
    const now = Date.now();
    let pool = candidates;
    if (!position()) pool = allStopsMatching(tokens);
    const hits: { c: StopVisionCandidate; best: number }[] = [];
    const located = !!position();
    let sliceAt = performance.now();
    const mine = session;
    for (const c of pool) {
      if (pool.length > 200 && performance.now() - sliceAt > 8) { // long list: let the screen draw in between
        await new Promise((r) => setTimeout(r, 0));
        sliceAt = performance.now();
        if (mine !== session) return; // Scan closed meanwhile
      }
      let best = 0, what = '';
      for (const v of c.variants) {
        let m = matchIn(tokens, v);
        if (!distinctive(v)) m *= 0.85; // "Bahnhof" alone proves little
        // without a position, "Rathaus" fits dozens of towns: the town has to be on the sign too
        if (!located && v !== c.variants[0]) m = m * 0.8 + 0.2 * matchIn(tokens, c.variants[0].slice(0, c.variants[0].length - v.length).trim() || v);
        if (m > best) { best = m; what = v; }
      }
      const ev = evidence.get(c.uic) || {};
      if (best >= 0.72 && (!ev.ocrAt || now - ev.ocrAt > 12000 || best >= ev.ocr!)) {
        Object.assign(ev, { ocr: best, ocrAt: now, ocrWhat: what, ocrUnique: true, ocrStrong: distinctive(what) });
        evidence.set(c.uic, ev);
        hits.push({ c, best });
      }
      // platform letter / number written next to a word like Kante, Gleis, Quai (e.g. "Kante C", "Gleis 7")
      const refs: string[] = [];
      for (let i = 0; i < all.length - 1; i++) {
        if (/^(kante|gleis|gl|steig|quai|voie|binario|perron|bay|platform)$/.test(all[i]) && /^[a-z0-9]{1,3}$/.test(all[i + 1])) refs.push(all[i + 1].toUpperCase());
      }
      if (refs.length) {
        const ei = c.st.edges.findIndex((e) => e.key && refs.includes(e.key));
        if (ei >= 0) { ev.edgeOcr = ei; ev.edgeOcrAt = now; evidence.set(c.uic, ev); }
      }
      // line numbers and destinations: from the timetable (offline, tools/build_stop_images.py --gtfs) and the
      // live departures. They only confirm a stop and pick its edge; on their own they never recognise a stop.
      const served: ServedLine[] = []; // [{ edge, line, to }]
      for (const l of linesOf(c.uic) || []) {
        for (const line of l.lines) served.push({ edge: l.edge, line, to: null });
        for (const to of l.dests) served.push({ edge: l.edge, line: null, to });
      }
      for (const d of ev.departures || []) served.push({ edge: d.edge, line: norm(d.line), to: d.to });
      if (served.length) {
        const lines = new Set(served.filter((d) => d.line).map((d) => d.line));
        const hit = new Set(tokens.filter((t) => /^\d{1,3}[a-z]?$/.test(t) && lines.has(t)));
        ev.lines = hit.size >= 2 ? hit.size : 0;
        const dests = new Map<string, Set<number | null>>(); // destination → edges it leaves from
        for (const d of served) if (d.to) dests.set(norm(d.to.split(',').pop()), (dests.get(norm(d.to.split(',').pop())) || new Set()).add(d.edge));
        for (const [dest, edges] of dests) {
          if (edges.size !== 1 || edges.has(null)) continue; // goes from several edges: says nothing about which
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
      for (const h of hits) if (h !== near && h.c.dist > near.c.dist + 40) evidence.get(h.c.uic)!.ocrUnique = false;
    }
    if (!located && hits.length) {
      // no GPS: list the stops whose name was read; only a clear single winner counts as recognised
      const clear = hits.length === 1 || hits[0].best - hits[1].best >= 0.1;
      hits.forEach((h, i) => { evidence.get(h.c.uic)!.ocrUnique = clear && i === 0; });
      candidates = hits.slice(0, 8).map((h) => h.c);
      candidatesBy = 'sign';
      if (!clear) app!.toast('Several stop names fit what was read (signs also list destinations). Turn on location to know which one is here.');
    }
    const bestHit = hits[0];
    if (wasTap && !bestHit) app!.toast('Read: “' + text.replace(/\s+/g, ' ').trim().slice(0, 60) + '” – no stop nearby has that name.');
  }

  let nameIndex: StopVisionCandidate[] | null = null;
  function allStopsMatching(tokens: string[]) {
    if (!nameIndex) nameIndex = [...app!.PLATFORMS].map(([uic, st]) => ({ uic, st, dist: 0, nearEdge: 0, variants: nameVariants(st.name) }));
    const long = tokens.filter((t) => t.length >= 4);
    if (!long.length) return [];
    // cheap pre-filter: share a 3-letter start with a read word
    const starts = new Set(long.map((t) => t.slice(0, 3)));
    return nameIndex.filter((c) => c.variants.some((v) => v.split(' ').some((t) => starts.has(t.slice(0, 3)))));
  }

  // ---------------------------------------------------------------- live departures (for lines/destinations + display)
  async function departures(c: StopVisionCandidate) {
    const ev = evidence.get(c.uic) || {};
    if (!depDue(ev)) return ev.departures;
    ev.depBusy = true;
    evidence.set(c.uic, ev);
    try {
      // The Kante engine knows the edge of every departure (engine-departures.js: d.edges, the first one is the
      // edge the rule below would name). Without it, transport.opendata.ch and that rule.
      const exact = window.KANTE_BOARD ? await window.KANTE_BOARD.load(c.uic, c.st, app!.platformLL) : null;
      const res = exact || await fetch(app!.OPENDATA + 'stationboard?' + new URLSearchParams({ id: c.uic, limit: '30' }));
      const all = exact || ((await (res as Response).json() as OdStationboardResponse).stationboard || []).filter((d) => d.stop && d.stop.departure);
      ev.departures = all.map((d) => {
        const next = d.passList && d.passList[1] ? app!.coordOf(d.passList[1]) : null;
        const ll = d.edges ? null : app!.platformLL(d.stop, null, next);
        const edge = d.edges ? (d.edges.length ? d.edges[0] : -1) : c.st.edges.findIndex((e) => e.ll === ll);
        return { time: (d.stop.prognosis && d.stop.prognosis.departure) || d.stop.departure!, delay: d.stop.delay || 0,
                 line: (d.number || d.name || '').replace(/^\D+\s/, ''), cat: d.category || '', to: d.to || '', edge: edge >= 0 ? edge : null, edges: d.edges, raw: d };
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
  // Database format 2 (tools/build_stop_images.py): 0.02° tiles with, per stop, its reference photos
  // [src, prov, edge, heading, ref, credit, licence, fingerprint] and its timetable lines per edge [edge, lines, dests].
  // Fingerprints are 128 int8 values: DINOv2 [CLS, mean patch] (768), centred and projected with index.pca.
  let index: StopImagesIndex | null = null;
  function loadIndex() {
    if (window.STOP_IMAGES_INDEX) return Promise.resolve(index = window.STOP_IMAGES_INDEX);
    return loadScript('stop-images/index.js').then(() => (index = window.STOP_IMAGES_INDEX || null)).catch(() => null);
  }

  function b64bytes(b64: string) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function decodeEmb(b64: string) {
    const v = new Int8Array(b64bytes(b64).buffer);
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    return { v, n: Math.sqrt(n) || 1 };
  }
  // Compact photo reference → picture + page links (see build_stop_images.py compact_ref)
  function refLinks(ref: string): { thumb: string | null; page: string } {
    const kind = ref.slice(0, 2), rest = ref.slice(2);
    if (kind === 'c:') return { thumb: 'https://upload.wikimedia.org/wikipedia/commons/thumb/' + rest, page: 'https://commons.wikimedia.org/wiki/File:' + rest.split('/')[2] };
    if (kind === 'p:') {
      const m = /\/derivat\w*\/(\w\w)\/(\w\w)\/(\w\w)\/(\w\w)\/([\w-]+)\//.exec(rest);
      return { thumb: rest, page: m ? `https://api.panoramax.xyz/#focus=pic&pic=${m[1]}${m[2]}${m[3]}${m[4]}-${m[5]}` : '' };
    }
    if (kind === 'm:') return { thumb: null, page: 'https://www.mapillary.com/app/?pKey=' + rest };
    return { thumb: rest, page: rest };
  }

  const tileBytes = new Map<string, number>(); // key → size of its script (diagnostics)
  window.STOP_IMAGES_TILE = (key, data) => {
    const t = (data.s || data.d ? data : { s: data, d: {} }) as StopImagesTile;
    tiles.set(key, { s: t.s || {}, d: t.d || {}, refs: new Map(), at: Date.now() });
  };

  async function loadTilesAround(ll: LngLat) {
    if (!(await loadIndex())) return;
    const size = index!.tile || 0.1;
    // every tile that can hold a stop with an edge within the candidate radius (+ a margin for spread-out stops)
    const pos = position();
    const r = Math.min(600, Math.max(150, 3 * (pos ? pos.acc : 50) + 60)) + 300;
    const dLat = r / 111320, dLon = r / (111320 * Math.cos(ll[1] * toRad));
    const want = new Set<string>();
    for (let la = Math.floor((ll[1] - dLat) / size); la <= Math.floor((ll[1] + dLat) / size); la++) {
      for (let lo = Math.floor((ll[0] - dLon) / size); lo <= Math.floor((ll[0] + dLon) / size); lo++) {
        const key = `${la}_${lo}`;
        if (!Object.prototype.hasOwnProperty.call(index!.tiles, key)) continue; // 0 photos can still mean lines
        want.add(key);
        if (tiles.has(key)) { tiles.get(key)!.at = Date.now(); continue; }
        tiles.set(key, { s: {}, d: {}, refs: new Map(), at: Date.now() }); // loading
        const src = `stop-images/t/${key}.js`;
        loadScript(src).then(() => {
          const s = [...document.querySelectorAll('script')].find((e) => e.src.endsWith(src));
          if (s) s.remove(); // the data is in memory now
          const entry = performance.getEntriesByName(new URL(src, location.href).href).pop() as PerformanceResourceTiming | undefined;
          if (entry) tileBytes.set(key, entry.transferSize || entry.encodedBodySize || 0);
        }).catch(() => tiles.delete(key));
      }
    }
    // keep memory bounded: forget the tiles you walked away from
    if (tiles.size > 24) {
      [...tiles].filter(([k]) => !want.has(k)).sort((a, b) => a[1].at - b[1].at)
        .slice(0, tiles.size - 24).forEach(([k]) => { tiles.delete(k); tileBytes.delete(k); });
    }
  }

  // Photos of a stop, decoded on first use
  function refsOf(uic: string): StopVisionPhoto[] | null {
    for (const t of tiles.values()) {
      if (t.refs.has(uic)) return t.refs.get(uic)!;
      const raw = t.s[uic];
      if (raw) {
        const refs = raw.map(([src, prov, edge, head, ref, credit, licence, emb]) =>
          ({ src, prov, edge, head, ref, credit, licence, ...refLinks(ref), emb: decodeEmb(emb) }));
        t.refs.set(uic, refs);
        return refs;
      }
    }
    return null;
  }
  // Timetable lines and destinations per edge of a stop (offline): [{ edge, lines: Set, dests: [] }]
  function linesOf(uic: string) {
    for (const t of tiles.values()) {
      const raw = t.d[uic];
      if (raw) return raw.map(([edge, lines, dests]) => ({ edge, lines: new Set(lines.split(' ').filter(Boolean).map(norm)), dests: dests ? dests.split('|') : [] }));
    }
    return null;
  }

  // ---- the image model runs in a worker, so the camera picture and the labels never wait for it
  // Shared by the worker and the main-thread fallback: last_hidden_state → 128-value fingerprint
  function describe(hs: Float32Array, dim: number, pca: ScanPca | null) {
    const tokens = hs.length / dim;
    const cls = hs.slice(0, dim), mean = new Float32Array(dim);
    for (let t = 1; t < tokens; t++) for (let k = 0; k < dim; k++) mean[k] += hs[t * dim + k];
    const unit = (v: Float32Array) => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; s = Math.sqrt(s) || 1; for (let i = 0; i < v.length; i++) v[i] /= s; return v; };
    unit(cls); unit(mean);
    const v = new Float32Array(2 * dim);
    for (let i = 0; i < dim; i++) { v[i] = cls[i] / Math.SQRT2; v[dim + i] = mean[i] / Math.SQRT2; }
    if (!pca) return v;
    const k = pca.k, y = new Float32Array(k);
    for (let i = 0; i < v.length; i++) {
      const c = v[i] - pca.mean[i];
      const row = i * k;
      for (let j = 0; j < k; j++) y[j] += c * pca.w[row + j];
    }
    for (let j = 0; j < k; j++) y[j] *= pca.scale[j];
    return unit(y);
  }
  function toTensor(rgba: Uint8ClampedArray, n: number) {
    const x = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) for (let ch = 0; ch < 3; ch++) x[ch * n + i] = (rgba[i * 4 + ch] / 255 - MEAN[ch]) / STD[ch];
    return x;
  }
  const WORKER_SRC = `
    const MEAN = ${JSON.stringify(MEAN)}, STD = ${JSON.stringify(STD)};
    ${describe.toString()}
    ${toTensor.toString()}
    let session = null, pca = null;
    onmessage = async (e) => {
      const m = e.data;
      try {
        if (m.type === 'init') {
          importScripts(m.ortDist + 'ort.wasm.min.js');
          ort.env.wasm.wasmPaths = m.ortDist;
          ort.env.wasm.numThreads = m.threads;
          session = await ort.InferenceSession.create(new Uint8Array(m.model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
          pca = m.pca;
          postMessage({ type: 'ready' });
        } else if (m.type === 'embed') {
          const t0 = performance.now();
          const size = m.size, x = toTensor(new Uint8ClampedArray(m.rgba), size * size);
          const out = await session.run({ pixel_values: new ort.Tensor('float32', x, [1, 3, size, size]) });
          const v = describe(out.last_hidden_state.data, 384, pca);
          postMessage({ type: 'emb', id: m.id, v, ms: performance.now() - t0 }, [v.buffer]);
        }
      } catch (err) {
        postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
      }
    };`;

  let worker: Worker | null = null, workerUrl: string | null = null, mainSession: OrtSession | null = null, pcaData: ScanPca | null = null, embedId = 0;
  const pending = new Map<number, PendingEmbed>();
  function pcaFromIndex(): ScanPca | null {
    const p = index && index.pca;
    if (!p) return null;
    return { k: p.k, mean: new Float32Array(b64bytes(p.mean).buffer), w: new Int8Array(b64bytes(p.w).buffer), scale: new Float32Array(b64bytes(p.scale).buffer) };
  }
  async function modelBytes() {
    const m = index!.model;
    const url = `https://huggingface.co/${m.repo}/resolve/${m.rev}/${m.file}`;
    try { // keep the 24 MB model on the phone after the first time
      const cache = await caches.open('stopvision-model');
      let res = await cache.match(url);
      if (!res) { res = await fetch(url); if (res.ok) await cache.put(url, res.clone()); }
      return await res.arrayBuffer();
    } catch { return (await fetch(url)).arrayBuffer(); }
  }

  async function ensureModel() {
    if (modelState === 'ready') return true;
    if (modelState === 'loading' || modelState === 'failed') return false;
    if (!(await loadIndex())) { modelState = 'failed'; return false; }
    modelState = 'loading';
    const t0 = performance.now();
    const mine = session;
    try {
      const buf = await modelBytes();
      if (mine !== session || !running) { modelState = 'idle'; return false; } // closed while downloading
      pcaData = pcaFromIndex();
      const threads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      try {
        workerUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
        worker = new Worker(workerUrl);
        await new Promise<void>((resolve, reject) => {
          worker!.onmessage = (e: MessageEvent<ModelReply>) => {
            const m = e.data;
            if (m.type === 'ready') resolve();
            else if (m.type === 'emb') { const p = pending.get(m.id); pending.delete(m.id); if (p) p.resolve(m); }
            else if (m.type === 'error') {
              if (m.id == null) reject(new Error(m.message));
              const p = pending.get(m.id!); pending.delete(m.id!); if (p) p.reject(new Error(m.message));
            }
          };
          worker!.onerror = (e) => reject(new Error(e.message || 'worker failed'));
          worker!.postMessage({ type: 'init', ortDist: ORT_DIST, threads, model: buf, pca: pcaData }, [buf]);
        });
        if (mine !== session || !running) { releaseModel(); return false; }
        // from now on a crash fails what is waiting (the scan carries on with signs) instead of hanging it
        worker.onerror = () => { const w = worker; releaseModel(); modelState = 'failed'; if (w) w.terminate(); };
        stats.engine = 'worker';
      } catch (err) {
        // no worker (old browser, blocked importScripts): run on the page, less smooth but the same results
        console.warn('Scan: model worker unavailable, using the page', err);
        if (worker) worker.terminate();
        worker = null;
        if (!window.ort) await loadScript(ORT_DIST + 'ort.wasm.min.js');
        window.ort!.env.wasm.wasmPaths = ORT_DIST;
        window.ort!.env.wasm.numThreads = threads;
        mainSession = await window.ort!.InferenceSession.create(new Uint8Array(await modelBytes()), { executionProviders: ['wasm'] });
        stats.engine = 'page';
        if (mine !== session || !running) { releaseModel(); return false; }
      }
      stats.modelLoadMs = Math.round(performance.now() - t0);
      modelState = 'ready';
      return true;
    } catch (err) {
      modelState = 'failed';
      console.warn('Scan: image model unavailable', err);
      return false;
    }
  }

  // Fingerprint of the picture: same preprocessing as the database (shortest side → 224, centre crop, ImageNet norm)
  let frameCanvas: HTMLCanvasElement | null = null;
  async function embedFrame() {
    const [w, h] = sourceSize();
    if (!w) return null;
    const side = Math.min(w, h);
    if (!frameCanvas) { frameCanvas = document.createElement('canvas'); frameCanvas.width = frameCanvas.height = INPUT; }
    const ctx = frameCanvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source(), (w - side) / 2, (h - side) / 2, side, side, 0, 0, INPUT, INPUT);
    const rgba = ctx.getImageData(0, 0, INPUT, INPUT).data;
    if (worker) {
      const id = ++embedId;
      const res = await new Promise<EmbedReply>((resolve, reject) => {
        // never wait forever: a stuck worker would block sign reading too (one job at a time)
        const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error('photo model timed out')); }, 15000);
        pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        worker!.postMessage({ type: 'embed', id, size: INPUT, rgba: rgba.buffer }, [rgba.buffer]);
      });
      stats.photo.push(res.ms);
      return res.v;
    }
    const t0 = performance.now();
    const out = await mainSession!.run({ pixel_values: new window.ort!.Tensor('float32', toTensor(rgba, INPUT * INPUT), [1, 3, INPUT, INPUT]) });
    const v = describe(out.last_hidden_state.data, 384, pcaData);
    stats.photo.push(performance.now() - t0);
    return v;
  }

  function releaseModel() {
    if (worker) worker.terminate();
    for (const p of pending.values()) p.reject(new Error('closed'));
    pending.clear();
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    if (mainSession && mainSession.release) mainSession.release().catch(() => {});
    worker = null; workerUrl = null; mainSession = null; modelState = 'idle';
  }

  async function comparePhotos() {
    const withRefs = candidates.filter((c) => refsOf(c.uic));
    const owner = session;
    if (!withRefs.length || (stillImage && stillFrames > 0) || !(await ensureModel())) return;
    if (!running || !ui || owner !== session) return;
    if (stillImage) stillFrames++;
    // a photo linked to several of these stops (e.g. a view of the whole square) cannot tell them apart
    const shared = new Map<string, number>();
    for (const c of withRefs) for (const r of refsOf(c.uic)!) shared.set(r.ref, (shared.get(r.ref) || 0) + 1);
    const mine = session;
    const q = await embedFrame();
    if (!q || !running || mine !== session) return;
    const best: PhotoMatch[] = [];
    for (const c of withRefs) {
      let top = -1, topRef: StopVisionPhoto | null = null;
      for (const r of refsOf(c.uic)!) {
        if (shared.get(r.ref)! > 1 || r.emb.v.length !== q.length) continue;
        let dot = 0;
        for (let i = 0; i < q.length; i++) dot += q[i] * r.emb.v[i];
        let sim = dot / r.emb.n;
        if (!IDENTITY[r.prov] && r.prov === 'geo') sim -= 0.02; // photos tied only by place count a bit less
        if (r.head != null && headingOk() && !stillImage && angleDiff(r.head, heading!) < 45) sim += 0.02; // taken looking the same way
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

  // ---------------------------------------------------------------- diagnostics (?scandebug, or tap the status 3×)
  const stats: ScanStats = { frames: [], ocr: [], photo: [], engine: '-', modelLoadMs: 0, ocrLoadMs: 0, longFrames: 0 };
  const pctl = (a: number[], p: number) => { if (!a.length) return 0; const s = a.slice(-30).sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
  function diagnostics() {
    const f = stats.frames.slice(-60);
    const fps = f.length > 1 ? Math.round(1000 * (f.length - 1) / (f[f.length - 1] - f[0])) : 0;
    const kb = [...tileBytes.values()].reduce((a, b) => a + b, 0) / 1024;
    const pos = position();
    return [
      `${fps} fps · frames >50 ms: ${stats.longFrames}`,
      `signs: ${pctl(stats.ocr, 0.5)} ms (p95 ${pctl(stats.ocr, 0.95)}) · loaded in ${stats.ocrLoadMs} ms · ${ocrLang || '-'}`,
      `photos: ${pctl(stats.photo, 0.5)} ms (p95 ${pctl(stats.photo, 0.95)}) · ${stats.engine} · loaded in ${stats.modelLoadMs} ms`,
      `tiles: ${tiles.size} (${Math.round(kb)} KB) · stops near: ${candidates.length}`,
      `GPS ±${pos ? Math.round(pos.acc) : '-'} m · compass ${headingOk() ? Math.round(heading!) + '° ±' + Math.round(headingAcc) : 'off'}`,
    ].join('\n');
  }

  // ---------------------------------------------------------------- what is shown
  // Which edge of a recognised stop you are looking at, and how we know (null = only the stop is known)
  function edgeOf(c: StopVisionCandidate): StopVisionEdgeGuess | null {
    const ev = evidence.get(c.uic) || {};
    const now = Date.now();
    if (ev.edgeOcr != null && fresh(ev.edgeOcrAt, 20000)) return { i: ev.edgeOcr, why: 'Platform sign read' };
    if (ev.edgeDest != null && fresh(ev.edgeDestAt, 20000)) return { i: ev.edgeDest, why: 'Destination read' };
    if (ev.visRef && ev.visRef.edge != null && ev.visStreak! >= VIS_FRAMES) return { i: ev.visRef.edge, why: 'Matches a photo of this side', maybe: true };
    if (c.st.edges.length === 1) return { i: 0, why: '' };
    // the camera points at one edge and the others are well outside the picture
    const pos = position();
    if (headingOk() && pos && headingAcc <= 30) {
      const fov = screenFov();
      const offs = c.st.edges.map((e) => angleDiff(bearing(pos.ll, e.ll), heading!));
      const inView = offs.map((o, i) => [o, i]).filter(([o]) => o <= fov / 2);
      if (inView.length === 1 && offs.every((o, i) => i === inView[0][1] || o > fov / 2 + 25)) return { i: inView[0][1], why: 'Only side in view', maybe: true };
    }
    return null;
  }

  function recognised(c: StopVisionCandidate) {
    const ev = evidence.get(c.uic) || {};
    if (fresh(ev.ocrAt, 12000) && ev.ocr! >= 0.8 && ev.ocrUnique && ev.ocrStrong) return 'sign';
    // photo match only together with the location: the stop that position + compass favour on their own
    if (ev.visStreak! >= VIS_FRAMES && Date.now() - ev.visAt! < 6000 && c.geoTop && c.ahead !== false && position()) return 'photo';
    return null;
  }

  function placeTags() {
    const pos = position();
    const seen = new Set<string>();
    if (pos && headingOk() && !stillImage) {
      const fov = screenFov();
      const W = ui!.root.clientWidth, H = ui!.root.clientHeight;
      const top = candidates[0];
      const shown = candidates.slice(0, 12);
      shown.forEach((c, n) => {
        const e = c.st.edges[c.aheadEdge != null ? c.aheadEdge : c.nearEdge];
        const off = ((bearing(pos.ll, e.ll) - heading! + 540) % 360) - 180;
        if (Math.abs(off) > fov / 2 + 4) return;
        const x = W / 2 + Math.tan(off * toRad) / Math.tan(fov / 2 * toRad) * W / 2;
        const y = H * (0.42 - Math.min(0.2, distM(pos.ll, e.ll) / 1000)) - (n % 3) * 30; // nearer = lower
        let tag = ui!.tags.get(c.uic);
        if (!tag) {
          tag = $('div', 'sv-tag');
          const pill = $('span');
          tag.append(pill, $('i'));
          ui!.ar.appendChild(tag);
          ui!.tags.set(c.uic, tag);
        }
        const pill = tag.firstChild as HTMLSpanElement;
        const label = c.st.name.split(',').pop()!.trim();
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
    for (const [uic, tag] of ui!.tags) if (!seen.has(uic)) { tag.remove(); ui!.tags.delete(uic); }
  }

  function chip(text: string, on: boolean) { const li = $('li', on ? 'on' : null, text); return li; }

  function renderSheet() {
    const pos = position();
    const c = candidates[0];
    if (!c) {
      const msg = !pos
        ? (app!.position() ? 'Waiting for a precise location…' : 'Location is off: point the camera at a stop sign and tap it to read the name.')
        : 'No stops within a few hundred metres.';
      if (ui!.shownKey !== msg) {
        ui!.shownKey = msg;
        ui!.sheet.replaceChildren($('p', 'sv-hint', msg));
        // a screen reader can't tap the picture: signs in view are read by themselves every few seconds
        announce(!pos && !app!.position() ? 'Location is off. Point the camera at a stop sign: its name is read by itself.' : msg);
      }
      return;
    }
    const ev = evidence.get(c.uic) || {};
    const how = recognised(c);
    const edge = edgeOf(c);
    const e = edge ? c.st.edges[edge.i] : null;
    const deps = ev.departures ? ev.departures.filter((d) => !e || (d.edges ? d.edges.includes(edge!.i) : d.edge === edge!.i) || d.edge == null && c.st.edges.length === 1) : null;
    speakTop(c, how, edge, e, deps, pos, ev.depFailed);
    const key = [c.uic, how, edge && edge.i, ev.depAt, ev.departures && ev.departures.length, ev.depFailed, ev.visRef && ev.visRef.page, ev.ocrAt, c.ahead, candidates.slice(1, 4).map((x) => x.uic).join()].join('|');
    if (key === ui!.shownKey) return;
    ui!.shownKey = key;
    // the card is drawn again: a screen reader that was on one of its buttons goes to the new copy of it
    const focused = ui!.sheet.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const focusKey = focused && focused.dataset.k;

    const state = $('span', 'sv-state' + (how ? ' ok' : ''), how ? 'Recognised' : !pos ? 'Possible match' : c.ahead ? 'Nearby · ahead' : 'Nearby');
    const main = $('div', 'sv-main');
    const txt = $('div');
    const sub = [MODE_WORD[c.st.mode] || 'Stop'];
    if (e && e.ref) sub.push(`${EDGE_WORD(c.st.mode)} ${e.ref}${edge!.maybe ? ' (probably)' : ''}`);
    if (pos) sub.push(Math.round(c.dist) + ' m');
    txt.append($('b', null, c.st.name), $('small', null, sub.join(' · ')));
    main.append(icon(c.st.mode), txt);

    const why = $('ul', 'sv-why');
    if (fresh(ev.ocrAt, 12000) && ev.ocr! >= 0.72) why.append(chip(`Sign read “${ev.ocrWhat}”`, true));
    if (edge && edge.why) why.append(chip(edge.why + (ev.destWhat && edge.why === 'Destination read' ? ` “${ev.destWhat}”` : ''), !edge.maybe));
    if (ev.visStreak! >= VIS_FRAMES) why.append(chip('Looks like its photos', how === 'photo'));
    else if (ev.vis != null && ev.visRel! > 0.02) why.append(chip('Similar to its photos', false));
    if (c.ahead) why.append(chip('In front of the camera', false));
    if (pos && c === candidates.slice().sort((a, b) => a.dist - b.dist)[0]) why.append(chip('Closest stop', false));
    if (!refsOf(c.uic)) why.append(chip('No reference photos yet', false));

    const nodes: HTMLElement[] = [state, main, why];
    if (deps && deps.length) {
      const ul = $('ul', 'sv-deps');
      for (const d of deps.slice(0, 4)) {
        const li = $('li');
        li.append($('time', null, clock(d.time)),
          app!.badge ? app!.badge(d.raw) : $('span', 'sv-line', d.line || d.cat), $('span', 'sv-to', d.to));
        if (d.delay > 0) {
          const late = $('span', 'sv-late', `+${d.delay}′`);
          late.setAttribute('aria-hidden', 'true'); // drawn "+3′", read out "3 minutes late"
          li.append(late, $('span', 'sv-sr', `${d.delay} ${d.delay === 1 ? 'minute' : 'minutes'} late`));
        }
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
    show.dataset.k = 'show';
    show.addEventListener('click', () => { const uic = c.uic, i = edge ? edge.i : null; closeScan(); app!.openStop(uic, i); });
    actions.append(show);
    nodes.push(actions);

    const ref = ev.visRef && ev.vis! >= VIS_MIN ? ev.visRef : null;
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
        // a button, so it can be picked with a screen reader too
        const li = $('li'), b = $('button');
        b.type = 'button';
        b.dataset.k = 'alt' + a.uic;
        b.setAttribute('aria-label', `${a.st.name}${pos ? `, ${Math.round(a.dist)} metres` : ''}. Show its departures on the map`);
        b.append(icon(a.st.mode), $('span', null, a.st.name), $('small', null, pos ? Math.round(a.dist) + ' m' : ''));
        b.addEventListener('click', () => { closeScan(); app!.openStop(a.uic, null); });
        li.appendChild(b);
        ul.appendChild(li);
      }
      nodes.push(ul);
    }
    ui!.sheet.replaceChildren(...nodes);
    if (focusKey) { const again = ui!.sheet.querySelector<HTMLElement>(`[data-k="${focusKey}"]`); if (again) again.focus({ preventScroll: true }); }
  }

  function renderStatus() {
    const busy: string[] = [];
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
  let prevTop: StopVisionCandidate | null = null;
  const depDue = (ev: StopVisionEvidence) => !ev.depBusy && (!ev.depAt || Date.now() - ev.depAt > 60000);

  function loop(mine: number) {
    // One heavy job at a time (reading signs or comparing photos), so a phone never runs both at once:
    // a tap goes first, otherwise whichever is more overdue. Frames keep drawing while a job runs in its worker.
    let busy = false, lastFrame = 0, lastWork = 0;
    const run = (job: () => Promise<void>, done: (t: number) => void) => {
      busy = true;
      job().catch((e) => console.warn(e)).finally(() => { busy = false; done(Date.now()); });
    };
    const frame = (t: number) => {
      if (!running || mine !== session) return;
      if (lastFrame && t - lastFrame > 50) stats.longFrames++;
      lastFrame = t;
      stats.frames.push(t);
      if (stats.frames.length > 120) stats.frames.splice(0, 60);
      const now = Date.now();
      if (t - lastWork < 50) { requestAnimationFrame(frame); return; } // ~20 updates a second are plenty, and cooler
      lastWork = t;
      if (now - lastCand > 3000 && position()) { lastCand = now; findCandidates(); }
      else if (!position() && candidatesBy === 'gps') { candidates = []; candidatesBy = ''; }
      score();
      placeTags();
      renderSheet();
      if (!busy) {
        const ocrDue = tapRead ? Infinity : now - lastOcr - 1500;
        // comparing photos only helps while it can still change the answer: not once a sign has settled it,
        // and not when fewer than two stops around have photos
        const settled = candidates[0] && recognised(candidates[0]) === 'sign';
        const photoStops = candidates.reduce((n, c) => n + (refsOf(c.uic) ? 1 : 0), 0);
        const visDue = !settled && (photoStops >= 2 || stillImage) && modelState !== 'failed' ? now - lastVis - 1200 : -Infinity;
        if (ocrDue >= 0 && ocrDue >= visDue) run(readSigns, (t2) => { lastOcr = t2; });
        else if (visDue >= 0) run(comparePhotos, (t2) => { lastVis = t2; });
      }
      if (candidates[0] && depDue(evidence.get(candidates[0].uic) || {})) departures(candidates[0]).catch(() => {});
      if (now - lastStatus > 1000) { lastStatus = now; renderStatus(); if (debugOn) ui!.debug.textContent = diagnostics(); }
      requestAnimationFrame(frame);
    };
    renderStatus();
    requestAnimationFrame(frame);
  }

  function useStill(file: File) {
    if (stillImage) URL.revokeObjectURL(stillImage);
    evidence.clear(); // what the live camera saw does not apply to this photo
    stillFrames = 0;
    stillReads = 0;
    if (!position()) candidates = [];
    stillImage = URL.createObjectURL(file);
    ui!.still.src = stillImage;
    ui!.root.classList.add('still');
    ui!.still.onload = () => { if (!ui) return; lastOcr = 0; lastVis = 0; renderStatus(); };
  }

  // ---------------------------------------------------------------- open / close
  const stopStream = (st: MediaStream | null) => { if (st) st.getTracks().forEach((t) => t.stop()); };
  let session = 0;

  async function openScan(hooks: StopVisionHooks, cameraPromise: Promise<MediaStream>, orientationPromise?: Promise<unknown>) {
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
    // free the memory: both engines (the model stays in the browser cache), photo tiles, decoded fingerprints
    releaseModel();
    if (ocr) ocr.terminate().catch(() => {});
    ocr = null; ocrState = 'idle'; ocrLang = '';
    tiles.clear(); tileBytes.clear(); nameIndex = null;
    candidates = []; candidatesBy = ''; prevTop = null;
    if (window.A11Y) window.A11Y.closeDialog(ui!.root, { restore: false }); // the app behind is in reach again
    ui!.root.remove();
    ui = null;
    if (app && app.onClose) app.onClose();
  }

  // Benchmark (scan-bench.html): load both engines, then time sign reading and photo fingerprints on an image
  async function bench(img: HTMLImageElement, runs = 8, log: (text: string, sofar?: Partial<StopVisionBenchResult>) => void = () => {}) {
    const fake = { videoWidth: 0, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
    ui = { still: img, video: fake, ring: { classList: { remove() {} } }, root: { clientWidth: 390, clientHeight: 844 } } as unknown as ScanUI;
    stillImage = 'bench'; running = true; app = app || { position: () => null, PLATFORMS: new Map(), toast() {} } as Partial<StopVisionHooks> as StopVisionHooks;
    const out = {} as StopVisionBenchResult;
    let t = performance.now();
    await ensureOcr(); out.ocrLoadMs = Math.round(performance.now() - t); log('sign reader ready', out);
    t = performance.now();
    await ensureModel(); out.modelLoadMs = Math.round(performance.now() - t); out.engine = stats.engine; log('image model ready', out);
    for (let i = 0; i < runs; i++) { await embedFrame(); log(`photo ${i + 1}/${runs}`); }
    for (let i = 0; i < Math.min(3, runs); i++) {
      const img2 = await ocrImage(null, i % 2 === 1);
      const t0 = performance.now(); const { data } = await ocr!.recognize(img2); stats.ocr.push(performance.now() - t0);
      out.text = (data.text || '').replace(/\s+/g, ' ').trim().slice(0, 80); log(`signs ${i + 1}/3`);
    }
    out.photoMs = { p50: pctl(stats.photo, 0.5), p95: pctl(stats.photo, 0.95) };
    out.ocrMs = { p50: pctl(stats.ocr, 0.5), p95: pctl(stats.ocr, 0.95) };
    running = false; stillImage = null; ui = null;
    return out;
  }

  window.STOPVISION = { open: openScan, close: closeScan, bench, _debug: { evidence, candidates: () => candidates, tiles, matchIn, nameVariants, norm, distinctive, useText, setApp: (a) => { app = a; }, recognised, findCandidates, score, edgeOf } };
})();
