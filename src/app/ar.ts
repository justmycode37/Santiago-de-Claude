// ---- AR camera: on the next step of a journey, a live camera view that finds the stop and its boarding edge, the
//      vehicles, and the direction to go. No shutter: it runs by itself, frame after frame, until it is closed.
//      - The stop and edge: Scan's live pipeline (stopvision.ts: sign OCR + GPS + compass), with the journey's next ride
//        as its route, so it outlines the sign it read and says where your ride leaves from.
//      - Vehicles: buses, trams and trains outlined by an in-browser detector (COCO-SSD, TensorFlow.js), each one a
//        track of its own (artrack.ts). PP-OCR (ppocr.ts) reads each vehicle's display band at the camera's full
//        resolution in turn, and a band across the road every third turn; Scan's Tesseract sweeps the whole picture.
//        What they read goes to the vehicle whose box held it when the picture was taken, through arcore.ts (RightSide's display matcher) against your ride and everything due at the stop (Kante
//        /api/due). Green ("Your bus 10 → …") and red ("Not yours: …") follow the rules of
//        docs/ar-recognition-plan.md; otherwise a vehicle shows only what its display says, or nothing.
//      - The banner: your run, found on the board by its trip (not guessed by line), when it comes and from where.
//      - The way: an arrow toward your boarding edge, from GPS + compass, only while both are fresh and good enough.
//      ?ar=0 in the page address hides the button (remembered; ?ar=1 shows it again). ?ardebug=1 adds a
//      "Save last 10 s" button for field tests (docs/ar-field-test.md); ?ardebug=0 removes it. ----
import { openScanWith, scanHooks } from './menu.ts';
import { userAccuracy, userLngLat } from './location.ts';
import { bearingDeg } from './map-places.ts';
import { lineLabel, modeOf, stopName, stopUic } from './journey-steps.ts';
import { h, kBtn, kIcon, quayOf } from './sheet.ts';
import { distKm } from './routing.ts';
import type { DeviceOrientationAsk } from './menu.ts';
import { createArSession, boardOf } from '../artrack.ts';
import { load } from '../lazy.ts';
import { ORT_DIST } from '../ort-dist.ts';
import type { OcrModels, OcrRuntime } from '../ppocr.ts';
import type { ArBox, ArDet, ArRide, ArSession, ArShift, ArText } from '../artrack.ts';
import type { ScanWordsDetail } from '../stopvision.ts';
import type { JourneyRideStep, JourneyStep, LineMode } from './journey-steps.ts';

const AR_ON = (() => { // on unless switched off with ?ar=0 (remembered; ?ar=1 switches it on again)
  try {
    const q = new URLSearchParams(location.search).get('ar');
    if (q === '0') localStorage.setItem('arOff', '1');
    if (q === '1') localStorage.removeItem('arOff');
    return localStorage.getItem('arOff') !== '1';
  } catch (e) { return true; }
})();

const AR_DEBUG = (() => { // the field-test capture button: ?ardebug=1 (remembered), ?ardebug=0
  try {
    const q = new URLSearchParams(location.search).get('ardebug');
    if (q === '1') localStorage.setItem('arDebug', '1');
    if (q === '0') localStorage.removeItem('arDebug');
    return localStorage.getItem('arDebug') === '1';
  } catch (e) { return false; }
})();

/** The camera resolution asked for: displays are read from full-resolution crops, so more pixels reach further. 1080p
 *  by default; ?arres=max asks for 4K (remembered; ?arres=0 goes back), to compare cost and reach in a field test. */
const AR_RESOLUTION = (() => {
  let max = false;
  try {
    const q = new URLSearchParams(location.search).get('arres');
    if (q === 'max') localStorage.setItem('arRes', 'max');
    if (q === '0') localStorage.removeItem('arRes');
    max = localStorage.getItem('arRes') === 'max';
  } catch (e) { /* storage blocked: the default */ }
  return max ? { width: { ideal: 3840 }, height: { ideal: 2160 } } : { width: { ideal: 1920 }, height: { ideal: 1080 } };
})();

/** Where the AR camera guides you: the boarding point of the step's next ride. */
interface ArTarget { ll: LngLat; label: string; line: string; to: string; ride: JourneyRideStep }
function arTargetOf(st: JourneyStep): ArTarget | null {
  const r = st.type === 'ride' ? st : st.nextRide;
  if (!r || r.type !== 'ride' || !r.depLL) return null;
  if (st.type === 'walk' && st.final) return null;
  const q = quayOf(r, 'dep');
  return { ll: r.depLL, label: q.label ? `${q.word} ${q.label}` : (stopName(r.s.from) || 'the stop'),
    line: lineLabel(r.s.line), to: r.s.headsign || '', ride: r };
}

/** What the vehicle labels compare with: the ride, its planned trip and boarding point, and its stops before you get off. */
function arRideOf(t: ArTarget): ArRide {
  const s = t.ride.s, leg = s.legs[0];
  const stops = s.stops.slice(1, -1).map((c) => stopName(c)).filter(Boolean);
  return { line: t.line, destination: t.to, mode: modeWord(t), tripId: leg && leg.tripId, serviceDate: leg && leg.serviceDate,
    quayId: s.from.quay.id, quayLabel: s.from.quay.label, stopsBefore: stops,
    dep: s.from.dep != null ? s.from.dep + (s.from.depDelayS || 0) : undefined };
}

/** The AR button for a journey step, or null (feature off, or nothing to board next). */
export function arStepButton(st: JourneyStep): HTMLElement | null {
  if (!AR_ON || !arTargetOf(st)) return null;
  return kBtn('view3d ar-btn', 'Find the stop, your vehicle and the way with the camera', () => arOpen(st), kIcon('nav', 16), 'AR');
}

// ---------------------------------------------------------------- the live view
type CocoBox = { bbox: [number, number, number, number]; class: string; score: number };
type CocoModel = { detect(el: HTMLVideoElement, max?: number, minScore?: number): Promise<CocoBox[]> };
let arModel: Promise<CocoModel | null> | null = null;
const loadScript = (src: string) => new Promise<void>((ok, fail) => {
  const s = document.createElement('script');
  s.src = src; s.onload = () => ok(); s.onerror = () => { s.remove(); fail(new Error(src)); };
  document.head.appendChild(s);
});
function arDetector(): Promise<CocoModel | null> {
  if (!arModel) {
    arModel = loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js')
      .then(() => loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js'))
      .then(() => (window as unknown as { cocoSsd: { load(o: object): Promise<CocoModel> } }).cocoSsd.load({ base: 'lite_mobilenet_v2' }))
      .catch((e) => { console.warn('AR: no vehicle detector', e); arModel = null; return null; });
  }
  return arModel;
}

// The display reader: PP-OCRv5 det + rec in onnxruntime-web (ppocr.ts), loaded on first use. Scan's photo model
// (DINOv2) stays unloaded in AR, so the page's ort is free for it.
type ArReader = { m: OcrModels; read: typeof import('../ppocr.ts').readRegion };
let arReader: Promise<ArReader | null> | null = null;
function arDisplayReader(): Promise<ArReader | null> {
  if (!arReader) {
    arReader = (async () => {
      const mod = await load(import.meta.url, () => import('../ppocr.ts'));
      if (!window.ort) await loadScript(ORT_DIST + 'ort.wasm.min.js');
      const rt = window.ort!;
      rt.env.wasm.wasmPaths = ORT_DIST;
      rt.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      return { m: await mod.loadModels(rt as unknown as OcrRuntime, arModelBytes), read: mod.readRegion };
    })().catch((e) => {
      console.warn('AR: no display reader', e);
      try { caches.delete('ar-models-v1').catch(() => {}); } catch (x) { /* no Cache Storage */ } // a bad copy is not kept
      arReader = null; return null;
    });
  }
  return arReader;
}

/** A model's bytes, kept in Cache Storage under its fixed-revision address: Hugging Face redirects to a signed address
 *  that changes every time, so the browser's own cache would fetch the 13 MB again for every AR session. ppocr.ts
 *  checks the SHA-256 of whatever comes back, cached or not; a mismatch fails the load (and is not kept). */
async function arModelBytes(url: string): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try { cache = await caches.open('ar-models-v1'); const hit = await cache.match(url); if (hit) return await hit.arrayBuffer(); } catch (e) { cache = null; }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const bytes = await r.arrayBuffer();
  if (cache) cache.put(url, new Response(bytes.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
  return bytes;
}

let arSession = 0;
let arMotion = 'unknown'; // what iOS answered to the motion permission (shown in the debug line)
function arOpen(st: JourneyStep) {
  const target = arTargetOf(st);
  if (!target) return;
  // both permissions here, while the tap still counts as a user gesture (iOS)
  const camera = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    ? navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, ...AR_RESOLUTION }, audio: false })
    : Promise.reject(new Error('no camera API'));
  const orientation = window.DeviceOrientationEvent && typeof (DeviceOrientationEvent as DeviceOrientationAsk).requestPermission === 'function'
    ? (DeviceOrientationEvent as DeviceOrientationAsk).requestPermission!() : Promise.resolve('granted');
  // the gyro (devicemotion) keeps vehicle boxes on their tracks while the phone turns; iOS Safari asks for it separately
  const DM = window.DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> } | undefined;
  const motion = DM && typeof DM.requestPermission === 'function' ? DM.requestPermission() : Promise.resolve('granted');
  camera.catch(() => {}); orientation.catch(() => {});
  motion.then((r) => { arMotion = r; }, () => { arMotion = 'denied'; });
  const mine = ++arSession;
  const hooks = scanHooks();
  hooks.ar = true; // Scan keeps its photo model (DINOv2) unloaded: the CPU is the detector's and the OCR's
  // the camera gets the whole screen: the journey sheet and its bar step aside until AR closes (CSS: body.ar-open)
  document.body.classList.add('ar-open');
  const done = () => { document.body.classList.remove('ar-open'); if (arSession === mine) arSession++; };
  // and come back whenever the camera screen is gone: closed, or never opened (Scan failed to load)
  let seen = false, waited = 0;
  const watch = setInterval(() => {
    const open = !!document.querySelector('.sv');
    seen = seen || open;
    if ((seen && !open) || (!seen && ++waited > 20) || arSession !== mine) { clearInterval(watch); if (!document.querySelector('.sv')) document.body.classList.remove('ar-open'); }
  }, 500);
  hooks.onClose = done;
  openScanWith(hooks, camera, orientation, () => { if (arSession === mine) arLayer(mine, target); });
  arDetector(); // start loading while the camera starts
  arDisplayReader();
}

function arLayer(mine: number, target: ArTarget) {
  const root = document.querySelector<HTMLElement>('[aria-label="Scan for stops"]');
  const video = root && root.querySelector('video');
  if (!root || !video) return;
  root.classList.add('ar-mode');
  root.setAttribute('aria-label', 'AR camera');
  const layer = h('div', 'ar-layer');
  const boxes = h('div', 'ar-boxes');
  const arrow = h('div', 'ar-arrow', kIcon('arrow', 64));
  const info = h('div', 'ar-info');
  layer.append(boxes, arrow, info);
  root.append(layer);

  // compass: where the camera looks (same rules as Scan), smoothed
  let heading: number | null = null, headingAt = 0;
  const onOri = (ev: Event) => {
    const e = ev as DeviceOrientationEvent & { webkitCompassHeading?: number };
    let hd: number | null = null;
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
      const turn = (screen.orientation && screen.orientation.angle) || 0;
      hd = (e.webkitCompassHeading + turn + 360) % 360;
    } else if (e.absolute && e.alpha != null) {
      const r = Math.PI / 180, a = e.alpha * r, b = (e.beta || 0) * r, g = (e.gamma || 0) * r;
      const east = -(Math.cos(a) * Math.sin(g) + Math.sin(a) * Math.sin(b) * Math.cos(g));
      const north = -(Math.sin(a) * Math.sin(g) - Math.cos(a) * Math.sin(b) * Math.cos(g));
      if (Math.hypot(east, north) < 0.35) return;
      hd = (Math.atan2(east, north) / r + 360) % 360;
    }
    if (hd == null) return;
    if (heading == null || Date.now() - headingAt > 2000) heading = hd;
    else heading = (heading + (((hd - heading + 540) % 360) - 180) * 0.25 + 360) % 360;
    headingAt = Date.now();
  };
  window.addEventListener('deviceorientationabsolute', onOri);
  window.addEventListener('deviceorientation', onOri);

  // the vehicles: tracks, reads and labels (artrack.ts)
  const ride = arRideOf(target);
  const ses: ArSession = createArSession(ride);
  const nowS = () => Date.now() / 1000;
  // what is due at the boarding stop, every 15 s (Kante /api/due); a failed poll changes nothing now, and the board
  // goes stale on its own after AR_LIMITS.BOARD_STALE_S (no green or red without a fresh one)
  const stopId = stopUic(target.ride.s.from);
  const toId = stopUic(target.ride.s.to);
  // before: 300, so a late vehicle timed as departed is still on the board (and still blocks green for a twin display).
  // Answers that come back out of order are dropped: an older board must never replace a newer one.
  let dueAsked = 0, dueApplied = 0;
  const loadDue = () => {
    const hooks = scanHooks();
    if (!hooks.due || !stopId) return;
    const n = ++dueAsked;
    hooks.due({ station: String(stopId), after: 900, before: 300, to: toId ? String(toId) : undefined, limit: 80 })
      .then((d) => {
        if (n < dueApplied) return;
        if (d) { dueApplied = n; ses.board(boardOf(d, nowS())); } else ses.boardFailed(nowS());
      }, () => ses.boardFailed(nowS()));
  };
  loadDue();
  const dueTimer = setInterval(loadDue, 15000);

  // the gyro: how far the picture moved between two detections (portrait only; elsewhere the boxes match unshifted).
  // Field of view of a phone's main camera in portrait video, about 42° across and 69° down (not measured per phone:
  // artrack.ts stops using the shift by itself when unshifted boxes match better).
  const HFOV = 42, VFOV = 69;
  // pan: how far it turned in any orientation (degrees / the narrower field of view), for revoking labels on a jerk
  let turn: ArShift = { dx: 0, dy: 0 }, pan = 0, motionAt = 0;
  const onMotion = (ev: Event) => {
    const r = (ev as DeviceMotionEvent).rotationRate, t = performance.now();
    const dt = motionAt ? Math.min(0.1, (t - motionAt) / 1000) : 0;
    motionAt = t;
    if (!r) return;
    pan += (Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0) * dt) / HFOV;
    if (((screen.orientation && screen.orientation.angle) || 0) !== 0) return;
    turn = { dx: turn.dx + ((r.gamma || 0) * dt) / HFOV, dy: turn.dy + ((r.beta || 0) * dt) / VFOV };
  };
  window.addEventListener('devicemotion', onMotion);

  // the words Scan reads, stamped with the moment their picture was taken: artrack.ts gives each vehicle its own
  const ocrAge: number[] = [];
  const onWords = (ev: Event) => {
    const d = (ev as CustomEvent<ScanWordsDetail>).detail;
    if (!d || !d.width || d.tap) return;
    const at = (d.capturedAt || 0) / 1000;
    if (!at) return; // without the capture time a read cannot be put on the right vehicle
    const texts: ArText[] = d.words.filter((w) => w.text && w.text.trim()).map((w) => ({ text: w.text,
      box: [w.box.x0 / d.width, w.box.y0 / d.height, (w.box.x1 - w.box.x0) / d.width, (w.box.y1 - w.box.y0) / d.height] as ArBox,
      // Tesseract gives big lettering a low confidence, so a sure-enough word counts at least 0.5; a word it was not
      // even 30 % sure of is left out (it would otherwise pass the matcher's own 0.3 floor as noise)
      score: Math.max(0.5, Math.min(1, w.conf / 100)), conf: w.conf })).filter((w) => w.conf >= 30)
      .map(({ conf: _c, ...w }) => w);
    const now = nowS();
    ocrAge.push(now - at); if (ocrAge.length > 20) ocrAge.shift();
    ses.words(texts, at, now);
  };
  window.addEventListener('scan:words', onWords);

  // picture (0–1) → screen (the video fills the screen with object-fit: cover)
  const toScreen = (b: ArBox) => {
    const vw = video.videoWidth, vh = video.videoHeight, W = root.clientWidth, H = root.clientHeight;
    const s = Math.max(W / vw, H / vh), ox = (W - vw * s) / 2, oy = (H - vh * s) / 2;
    return [ox + b[0] * vw * s, oy + b[1] * vh * s, b[2] * vw * s, b[3] * vh * s];
  };

  // field-test capture (?ardebug=1): the last 10 s of events, plus small crops of each vehicle's display band
  const crops: { at: number; track: number; box: ArBox; jpeg: string }[] = [];
  const detectMs: number[] = [];
  let dbgText: HTMLElement | null = null;
  if (AR_DEBUG) {
    const save = h('button', null, 'Save last 10 s');
    save.addEventListener('click', () => saveCapture());
    dbgText = h('div', null, '');
    layer.append(h('div', 'ar-dbg', dbgText, save));
  }
  const cropCanvas = AR_DEBUG ? document.createElement('canvas') : null;
  const keepCrops = (now: number) => {
    if (!cropCanvas) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    for (const t of ses.tracks()) {
      const [x, y, w, hh] = t.box;
      const sw = w * vw, sh = hh * vh * 0.45; // the upper part: where the display is
      if (sw < 8 || sh < 8) continue;
      cropCanvas.width = Math.min(240, Math.round(sw)); cropCanvas.height = Math.max(1, Math.round(sh * cropCanvas.width / sw));
      cropCanvas.getContext('2d')!.drawImage(video, x * vw, y * vh, sw, sh, 0, 0, cropCanvas.width, cropCanvas.height);
      crops.push({ at: now, track: t.id, box: t.box, jpeg: cropCanvas.toDataURL('image/jpeg', 0.7) });
    }
    while (crops.length && crops[0].at < now - 10) crops.shift();
  };
  const saveCapture = () => {
    const now = nowS();
    const data = { format: 'ar-capture/1', savedAt: now, ua: navigator.userAgent, video: [video.videoWidth, video.videoHeight],
      motion: arMotion, ride, derotation: ses.derotation(), labels: ses.labels(now), banner: ses.banner(now),
      detectMs: detectMs.slice(), ocrAgeS: ocrAge.slice(), ppocrMs: ocrMs.slice(), log: ses.log(), crops: crops.slice() };
    const name = `ar-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
    const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
    if (nav.canShare && nav.canShare({ files: [file] })) { navigator.share({ files: [file] }).catch(() => {}); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };

  // display reads: PP-OCR on one vehicle's display band at a time, at the camera's full resolution, round robin
  // (never by how likely a vehicle is to be yours, so a late real bus is not starved); every third turn, or with no
  // vehicle in view, a band across the road for one the detector missed. Paced by how long a read takes.
  const ocrCanvas = document.createElement('canvas');
  const ocrMs: number[] = [];
  let ocrBusy = false, ocrTurn = 0, trackTurn = 0, ocrNext = 0, ocrState = 'loading';
  const readDisplays = async () => {
    if (ocrBusy || Date.now() < ocrNext || !video.videoWidth) return;
    ocrBusy = true;
    try {
      const reader = await arDisplayReader();
      ocrState = reader ? 'ready' : 'unavailable';
      if (!reader || arSession !== mine) { ocrNext = Date.now() + 5000; return; }
      const vw = video.videoWidth, vh = video.videoHeight, now = nowS();
      const shown = ses.tracks().filter((t) => now - t.seen <= 0.5);
      const turn = ocrTurn++;
      let r: ArBox = [0, 0.2, 1, 0.5]; // the road band
      if (shown.length && turn % 3 !== 2) {
        const b = shown[trackTurn++ % shown.length].box; // the next vehicle in turn
        r = [b[0] - b[2] * 0.04, b[1], b[2] * 1.08, b[3] * 0.55]; // its upper part, where the display is
      }
      const x0 = Math.max(0, Math.round(r[0] * vw)), y0 = Math.max(0, Math.round(r[1] * vh));
      const w = Math.min(vw - x0, Math.round(r[2] * vw)), hh = Math.min(vh - y0, Math.round(r[3] * vh));
      if (w < 24 || hh < 12) return;
      ocrCanvas.width = w; ocrCanvas.height = hh;
      const ctx = ocrCanvas.getContext('2d', { willReadFrequently: true })!;
      const capturedAt = Date.now() / 1000;
      ctx.drawImage(video, x0, y0, w, hh, 0, 0, w, hh);
      const px = ctx.getImageData(0, 0, w, hh);
      const t0 = performance.now();
      const words = await reader.read(reader.m, { data: px.data, width: w, height: hh }, { width: vw, height: vh, x: x0, y: y0 });
      const ms = performance.now() - t0;
      ocrMs.push(ms); if (ocrMs.length > 20) ocrMs.shift();
      ocrNext = Date.now() + Math.max(200, ms); // as much rest as the read took: the detector and Scan need the CPU too
      if (arSession === mine) ses.words(words.map((x) => ({ text: x.text, box: x.box, score: x.score })), capturedAt, nowS());
    } catch (e) { ocrNext = Date.now() + 1000; } finally { ocrBusy = false; }
  };

  const draw = (now: number) => {
    boxes.replaceChildren(...ses.labels(now).map((l) => {
      const [x, y, w, hh] = toScreen(l.box);
      const el = h('div', 'ar-box' + (l.kind === 'green' ? ' ok' : l.kind === 'red' ? ' no' : ''), l.text ? h('span', null, l.text) : null);
      el.style.cssText += `left:${x}px;top:${y}px;width:${w}px;height:${hh}px`;
      return el;
    }));
  };

  let busy = false, lastDetect = 0;
  const frame = async () => {
    if (arSession !== mine || !root.isConnected) { cleanup(); return; }
    // the way: an arrow toward the boarding point while GPS and compass are both good
    const fresh = heading != null && Date.now() - headingAt < 3000;
    const gpsOk = !!userLngLat && userAccuracy != null && userAccuracy <= 30;
    const dist = userLngLat ? Math.round(distKm(userLngLat, target.ll) * 1000) : null;
    if (fresh && gpsOk && dist != null && dist > 8) {
      const turnDeg = ((bearingDeg(userLngLat!, target.ll) - heading! + 540) % 360) - 180;
      arrow.style.display = '';
      arrow.style.transform = `translateX(-50%) perspective(400px) rotateX(55deg) rotate(${turnDeg}deg)`;
    } else arrow.style.display = 'none';
    const where = dist == null ? 'Turn on location for the way' : dist <= 8 ? `You're at ${target.label}` : `${target.label} · ${dist} m${fresh ? '' : ' · compass not ready'}`;
    const now = nowS();
    info.textContent = `${ses.banner(now).text} — ${where}`;
    draw(now); // labels expire and are revoked between detections too
    readDisplays();
    if (dbgText) {
      const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
      const ls = ses.labels(now);
      dbgText.textContent = `video ${video.videoWidth}×${video.videoHeight} · detect ${Math.round(avg(detectMs))} ms · Tesseract age ${avg(ocrAge).toFixed(1)} s`
        + ` · PP-OCR ${ocrState}${ocrMs.length ? ' ' + Math.round(avg(ocrMs)) + ' ms' : ''}`
        + ` · motion ${arMotion}${ses.derotation().on ? '' : ' (gyro shift off)'}\n`
        + (ls.length ? ls.map((l) => `#${l.track} ${l.kind} ${l.reason}`).join(' · ') : 'no vehicles');
    }
    // vehicles, about 3 times a second
    if (busy || Date.now() - lastDetect < 330 || !video.videoWidth) return;
    busy = true; // before any await: one detection at a time, also while the model loads
    try {
      const model = await arDetector();
      if (!model || arSession !== mine) return;
      lastDetect = Date.now();
      const t0 = performance.now(), at = nowS();
      const shift = turn, panned = pan; turn = { dx: 0, dy: 0 }; pan = 0;
      const found = (await model.detect(video, 6, 0.5)).filter((b) => b.class === 'bus' || b.class === 'train');
      detectMs.push(performance.now() - t0); if (detectMs.length > 20) detectMs.shift();
      if (arSession !== mine) return;
      const vw = video.videoWidth, vh = video.videoHeight;
      const dets: ArDet[] = found.map((b) => ({ box: [b.bbox[0] / vw, b.bbox[1] / vh, b.bbox[2] / vw, b.bbox[3] / vh] as ArBox, score: b.score, cls: b.class }));
      ses.detections(dets, at, motionAt ? shift : null, motionAt ? panned : null); // the picture the detector read was taken at `at`
      keepCrops(at);
      draw(nowS());
    } catch (e) { /* a frame the detector could not read */ } finally { busy = false; }
  };
  const cleanup = () => {
    stopTick();
    clearInterval(dueTimer);
    window.removeEventListener('scan:words', onWords);
    window.removeEventListener('devicemotion', onMotion);
    window.removeEventListener('deviceorientationabsolute', onOri);
    window.removeEventListener('deviceorientation', onOri);
    layer.remove();
    if (arSession !== mine) document.body.classList.remove('ar-open');
  };
  const tick = setInterval(frame, 100); // ~10 updates a second; also runs where animation frames are held back
  const stopTick = () => clearInterval(tick);
}
const modeWord = (t: ArTarget) => ({ train: 'train', tram: 'tram', bus: 'bus', boat: 'boat', cable: 'cable car' } as Record<LineMode, string>)[modeOf(t.ride.s.line.category)];
