// ---- AR camera: one for the whole journey (its button is in the journey's footer). A live camera view that goes with
//      you through the trip: on a walk or at a change it finds the stop and boarding edge of your next ride, its
//      vehicle, and the direction to go; on board it says where to get off; on the last walk it points to the
//      destination. Where you are on the trip comes from GPS (tracking.ts), else from the live timetable (a ride counts
//      as boarded only once GPS has you moving along it, or two minutes after it leaves). No shutter: it runs by
//      itself, frame after frame, until it is closed.
//      - The stop and edge: Scan's live pipeline (stopvision.ts: sign OCR + GPS + compass), with the journey's next ride
//        as its route, so it outlines the sign it read and says where your ride leaves from.
//      - Vehicles: buses, trams and trains outlined by an in-browser detector (YOLOX-nano in onnxruntime-web), each one a
//        track of its own (artrack.ts). PP-OCR (ppocr.ts) reads each vehicle's display band at the camera's full
//        resolution in turn, and a band across the road every third turn; Scan's Tesseract sweeps the whole picture.
//        What they read goes to the vehicle whose box held it when the picture was taken, through arcore.ts (RightSide's display matcher) against your ride and everything due at the stop (Kante
//        /api/due). Green ("Your bus 10 → …") and red ("Not yours: …") follow the rules of
//        docs/ar-recognition-plan.md; otherwise a vehicle shows only what its display says, or nothing.
//      - The banner: your run, found on the board by its trip (not guessed by line), when it comes and from where.
//      - The way: an arrow toward your boarding edge, from GPS + compass, only while both are fresh and good enough.
//      ?ar=0 in the page address hides the button (remembered; ?ar=1 shows it again). ?ardebug=1 adds a
//      "Save last 10 s" button for field tests (docs/ar-field-test.md); ?ardebug=0 removes it. ----
import { openScanWith, scanHooks, scanRouteOf } from './menu.ts';
import { gpsOn, userAccuracy, userLngLat } from './location.ts';
import { bearingDeg } from './map-places.ts';
import { fmtTime, lineLabel, liveMs, modeOf, stopName, stopUic } from './journey-steps.ts';
import { MODE_NAME, h, kBtn, kIcon, quayOf } from './sheet.ts';
import { distKm } from './routing.ts';
import { journeyProgress, stopKms, vehicleState } from './tracking.ts';
import { journey, tracking } from './state.ts';
import type { TimedPlace } from './tracking.ts';
import type { DeviceOrientationAsk } from './menu.ts';
import { createArSession, boardOf } from '../artrack.ts';
import { load } from '../lazy.ts';
import { pictureTime } from '../pictime.ts';
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

// ---------------------------------------------------------------- where the trip is: what AR guides you to now
/**
 * What the AR camera guides you to at this moment of the trip (arPhase()):
 * - board: to where your next ride leaves from, looking for its vehicle (on a walk, at a change, waiting at the stop);
 * - ride: on board, where to get off (nothing to look for);
 * - walk: on the last walk, the way to the destination;
 * - arrived: there.
 * `key` changes when the guidance has to start afresh (another ride, or its boarding point changed).
 */
type ArPhase =
  | { kind: 'board'; key: string; ride: JourneyRideStep; ll: LngLat; label: string; line: string; to: string }
  | { kind: 'ride'; key: string; ride: JourneyRideStep }
  | { kind: 'walk'; key: string; ll: LngLat; label: string }
  | { kind: 'arrived'; key: string; label: string };

function boardPhase(r: JourneyRideStep | null | undefined): ArPhase | null {
  if (!r || !r.depLL) return null;
  const q = quayOf(r, 'dep');
  const label = q.label ? `${q.word} ${q.label}` : (stopName(r.s.from) || 'the stop');
  return { kind: 'board', key: `board|${rideId(r)}|${r.s.from.quay.id || ''}|${label}`, ride: r, ll: r.depLL,
    label, line: lineLabel(r.s.line), to: r.s.headsign || '' };
}
/** Which ride it is, whatever step it is now (a journey planned again or switched keeps the key only for the same
 *  trip from the same stop to the same stop). */
const rideId = (r: JourneyRideStep) => {
  const leg = r.s.legs[0];
  return [leg && leg.tripId, leg && leg.serviceDate, stopUic(r.s.from), stopUic(r.s.to)].join('|');
};
const destLL = (st: JourneyStep): LngLat | null => {
  if (journey.dest) return journey.dest.lngLat;
  const ls = st.lines || [], last = ls[ls.length - 1];
  return last && last.length ? last[last.length - 1] : null;
};
const destTitle = () => (journey.dest && journey.dest.title) || 'your destination';
/** GPS follows you on the trip (not only the timetable). */
const gpsTrack = () => (tracking.track && !tracking.track.off && gpsOn() ? tracking.track : null);

/** Where on the trip you are, as AR guides it: GPS when it follows you, else the live timetable (journeyProgress()).
 *  Without GPS a ride counts as boarded only two minutes after it leaves, so someone still on the platform keeps the
 *  vehicle search; with GPS, once it has you moving along the ride. */
function arPhase(now = Date.now()): ArPhase | null {
  const steps = journey.steps;
  if (!steps.length) return null;
  const t = gpsTrack();
  // there for good once GPS has had you there (tracking.ts keeps it for this journey, also after the fix goes stale)
  if ((t && t.arrived) || tracking.arrivedAt === steps) return { kind: 'arrived', key: 'arrived', label: destTitle() };
  const p = journeyProgress() as TimedPlace | null;
  // before the trip starts: its first step; after the timetable's end (no GPS to say): its last walk, or there
  let i = p ? p.i : 0;
  if (p && p.ended && !t) {
    const fin = steps.findIndex((st) => st.type === 'walk' && st.final);
    if (fin < 0) return { kind: 'arrived', key: 'arrived', label: destTitle() };
    i = fin;
  }
  // a ride that left without you: still its stop (the banner says it has gone)
  if (t && t.missed) return boardPhase(t.missed);
  const st = steps[Math.min(i, steps.length - 1)];
  if (st.type === 'arrive') return { kind: 'arrived', key: 'arrived', label: destTitle() };
  if (st.type === 'walk' && st.final) {
    const ll = destLL(st);
    return ll ? { kind: 'walk', key: 'walk', ll, label: st.toName || destTitle() } : { kind: 'arrived', key: 'arrived', label: destTitle() };
  }
  if (st.type !== 'ride') return boardPhase(st.nextRide);
  const onBoard = t ? t.i === i && !t.missed && t.kmIn > 0.1 : st.t0 != null && now > st.t0 + 120000;
  return onBoard ? { kind: 'ride', key: `ride|${rideId(st)}`, ride: st } : boardPhase(st);
}

/** What the labels compare vehicles with: the ride, its planned trip and boarding point, and its stops before you get off. */
function arRideOf(t: Extract<ArPhase, { kind: 'board' }>): ArRide {
  const s = t.ride.s, leg = s.legs[0];
  const stops = s.stops.slice(1, -1).map((c) => stopName(c)).filter(Boolean);
  return { line: t.line, destination: t.to, mode: modeWord(t.ride), tripId: leg && leg.tripId, serviceDate: leg && leg.serviceDate,
    quayId: s.from.quay.id, quayLabel: s.from.quay.label, stopsBefore: stops,
    dep: s.from.dep != null ? s.from.dep + (s.from.depDelayS || 0) : undefined };
}

/** On board: where to get off, and how many stops are left (by GPS along the ride, else by where its vehicle is). */
function rideText(st: JourneyRideStep, now: number): [string, string] {
  const off = stopName(st.s.to) || 'your stop', at = liveMs(st.s.to, 'arr');
  const t = gpsTrack();
  const km = t && journey.steps[t.i] === st ? t.kmIn : (vehicleState(st, now) || { km: null }).km;
  let left: number | null = null;
  if (km != null) { const kms = stopKms(st); if (kms.length) left = kms.filter((k) => k > km + 0.05).length; }
  const mode = modeOf(st.s.line.category);
  return [`On ${mode === 'train' ? '' : (MODE_NAME[mode] || 'Bus') + ' '}${lineLabel(st.s.line)} → ${st.s.headsign || ''}`.trim(),
    [`Get off at ${off}`, left != null && left > 1 ? `${left} stops` : left === 1 ? 'next stop' : '', at ? fmtTime(at) : ''].filter(Boolean).join(' · ')];
}

/** The AR button of a journey (one for the whole trip), or null (feature off, or no ride to find). */
export function arTripButton(): HTMLElement | null {
  // a ride to find, or (a journey on foot) a destination to walk to
  if (!AR_ON || !journey.steps.some((st) => (st.type === 'ride' && st.depLL) || (st.type === 'walk' && st.final && !!destLL(st)))) return null;
  const b = kBtn('round-btn ar-trip', 'AR camera for the whole trip: your stop, your vehicle and the way, step by step', () => arOpen(), h('b', null, 'AR'));
  return b;
}

// ---------------------------------------------------------------- the live view
const loadScript = (src: string) => new Promise<void>((ok, fail) => {
  const s = document.createElement('script');
  s.src = src; s.onload = () => ok(); s.onerror = () => { s.remove(); fail(new Error(src)); };
  document.head.appendChild(s);
});
// onnxruntime-web for both models below. Scan's photo model (DINOv2) stays unloaded in AR, so the page's ort is free.
let arOrtLoad: Promise<OcrRuntime> | null = null;
function arOrt(): Promise<OcrRuntime> {
  if (!arOrtLoad) {
    arOrtLoad = (async () => {
      if (!window.ort) await loadScript(ORT_DIST + 'ort.wasm.min.js');
      const rt = window.ort!;
      rt.env.wasm.wasmPaths = ORT_DIST;
      rt.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      return rt as unknown as OcrRuntime;
    })().catch((e) => { arOrtLoad = null; throw e; });
  }
  return arOrtLoad;
}

/** Which vehicle detector: YOLOX-tiny (8-bit) by default, nano when the phone is too slow for it; ?ardet=nano or
 *  ?ardet=tiny fixes one for a field test (remembered; ?ardet=0 goes back to choosing). */
const AR_DET = (() => {
  try {
    const q = new URLSearchParams(location.search).get('ardet');
    if (q === 'nano' || q === 'tiny') localStorage.setItem('arDet', q);
    if (q === '0') localStorage.removeItem('arDet');
    return localStorage.getItem('arDet') || 'auto';
  } catch (e) { return 'auto'; }
})();
/** Detections slower than this on average (over the first DET_PROBE of them) switch tiny for nano. */
const DET_SLOW_MS = 220, DET_PROBE = 8;

// The vehicle detector: YOLOX (Megvii, Apache-2.0; src/yolox.ts), off the shelf. It replaced COCO-SSD, which on the
// reading-range bench found a third of the vehicles whose displays were already readable (docs/ar-reading-range.md);
// tiny rather than nano finds more far vehicles and merges fewer side by side (docs/ar-labels-bench.md). The site
// serves the models (models/yolox/), checked against their SHA-256.
type ArDetector = { name: string; detect(video: HTMLVideoElement): Promise<{ box: ArBox; score: number; cls: string }[]> };
let arModel: Promise<ArDetector | null> | null = null;
/** YOLOX-tiny is too slow here or failed to run (three detections in a row): nano from then on (unless ?ardet=tiny). */
let detBroken = false;
function arDetector(which: 'nano' | 'tiny_int8' = AR_DET === 'tiny' ? 'tiny_int8' : AR_DET === 'nano' || detBroken ? 'nano' : 'tiny_int8'): Promise<ArDetector | null> {
  if (!arModel) {
    arModel = (async () => {
      const [rt, yx] = await Promise.all([arOrt(), load(import.meta.url, () => import('../yolox.ts'))]);
      const r = await fetch(new URL(yx.YOLOX_MODELS[which].file, document.baseURI).href);
      if (!r.ok) throw new Error(`yolox_${which}.onnx: HTTP ${r.status}`);
      const session = await yx.loadYolox(rt, await r.arrayBuffer(), which);
      const side = yx.YOLOX_SIDE, canvas = document.createElement('canvas');
      canvas.width = canvas.height = side;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; // a 1080p frame shrinks about 4 times
      const took: number[] = [];
      return {
        name: which === 'nano' ? 'nano' : 'tiny',
        async detect(video: HTMLVideoElement) {
          const t0 = performance.now();
          const vw = video.videoWidth, vh = video.videoHeight, s = Math.min(side / vw, side / vh);
          // the frame into the top-left corner of a grey 416 x 416 square, scaled by the browser
          ctx.fillStyle = 'rgb(114,114,114)'; ctx.fillRect(0, 0, side, side);
          ctx.drawImage(video, 0, 0, Math.round(vw * s), Math.round(vh * s));
          const px = ctx.getImageData(0, 0, side, side).data;
          const found = (await yx.yoloxDetectLetterboxed(rt, session, px, s, vw, vh, 0.3)).map((b) => ({ box: b.box as ArBox, score: b.score, cls: b.cls }));
          // too slow on this phone (fewer than about 5 pictures a second): nano from the next detection on
          if (which !== 'nano' && AR_DET === 'auto' && took.length < DET_PROBE) {
            took.push(performance.now() - t0);
            if (took.length === DET_PROBE && took.slice(2).reduce((a, b) => a + b, 0) / (DET_PROBE - 2) > DET_SLOW_MS) {
              console.info('AR: YOLOX-tiny too slow here, switching to nano');
              detBroken = true; arModel = null; arDetector('nano');
              (session as { release?: () => Promise<void> }).release?.().catch(() => {}); // one detection at a time: this was the last
            }
          }
          return found;
        },
      };
    })().catch((e) => {
      console.warn(`AR: no vehicle detector (${which})`, e);
      arModel = null;
      if (which === 'nano') return null;
      detBroken = true; // tiny failed to load: nano
      return arDetector('nano');
    });
  }
  return arModel;
}

// The display reader: PP-OCRv5 det + rec in onnxruntime-web (ppocr.ts), loaded on first use.
type ArReader = { m: OcrModels; read: typeof import('../ppocr.ts').readRegion };
let arReader: Promise<ArReader | null> | null = null;
function arDisplayReader(): Promise<ArReader | null> {
  if (!arReader) {
    arReader = (async () => {
      const [rt, mod] = await Promise.all([arOrt(), load(import.meta.url, () => import('../ppocr.ts'))]);
      return { m: await mod.loadModels(rt, arModelBytes), read: mod.readRegion };
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
/** What AR guides you to now (arLayer() moves it on as the trip goes); Scan's route() follows it. */
let arNow: ArPhase | null = null;
function arOpen() {
  arNow = arPhase();
  if (!arNow) return;
  // already open: asking for a second camera would black out the first one on iOS
  if (document.querySelector('.sv')) return;
  // both permissions here, while the tap still counts as a user gesture (iOS); they last the whole trip
  const askCamera = () => (navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    ? navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, ...AR_RESOLUTION }, audio: false })
    : Promise.reject(Object.assign(new Error('no camera API'), { name: 'NoApiError' })));
  const camera = askCamera();
  const orientation = window.DeviceOrientationEvent && typeof (DeviceOrientationEvent as DeviceOrientationAsk).requestPermission === 'function'
    ? (DeviceOrientationEvent as DeviceOrientationAsk).requestPermission!() : Promise.resolve('granted');
  // the gyro (devicemotion) keeps vehicle boxes on their tracks while the phone turns; iOS Safari asks for it separately
  const DM = window.DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> } | undefined;
  const motion = DM && typeof DM.requestPermission === 'function' ? DM.requestPermission() : Promise.resolve('granted');
  camera.catch(() => {}); orientation.catch(() => {});
  motion.then((r) => { arMotion = r; }, () => { arMotion = 'denied'; });
  const mine = ++arSession;
  const hooks = scanHooks();
  hooks.ar = true; // Scan keeps its photo model (DINOv2) unloaded: the CPU is the detector's and the OCR's; no photo button
  hooks.camera = askCamera; // the camera again, the same way, when it stopped or was refused (Scan's camera watch)
  // Scan's "your ride leaves from this side" and the one stop tag it shows: the ride AR guides you to now (none on board
  // or on the last walk)
  hooks.route = () => (arNow && arNow.kind === 'board' ? scanRouteOf(arNow.ride) : null);
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
  openScanWith(hooks, camera, orientation, () => { if (arSession === mine) arLayer(mine); });
  if (arNow.kind === 'board') { arDetector(); arDisplayReader(); } // start loading while the camera starts (else when a ride is next)
}

function arLayer(mine: number) {
  const root = document.querySelector<HTMLElement>('[aria-label="Scan for stops"]');
  const video = root && root.querySelector('video');
  if (!root || !video || root.classList.contains('ar-mode')) return;
  root.classList.add('ar-mode');
  root.setAttribute('aria-label', 'AR camera');
  const layer = h('div', 'ar-layer');
  const boxes = h('div', 'ar-boxes');
  const arrow = h('div', 'ar-arrow', kIcon('arrow', 64));
  const infoMain = h('b', null, ''), infoSub = h('span', null, '');
  const info = h('div', 'ar-info', infoMain, infoSub);
  info.setAttribute('role', 'status');
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
  const nowS = () => Date.now() / 1000;

  // ---- the target: what the trip needs now. A new one (another ride to board, its boarding point changed, on board,
  // the last walk) starts afresh: a new vehicle session, a new board of what is due, no labels of the last one. Every
  // answer that comes back (a board, a read, a detection) is for the generation it was asked in, or it is dropped.
  let phase: ArPhase | null = null, gen = 0, phaseAt = 0, phaseChecked = 0;
  let ses: ArSession | null = null, ride: ArRide | null = null, dueTimer = 0;
  const setPhase = (ph: ArPhase | null) => {
    arNow = ph;
    if (ph && phase && ph.key === phase.key) { phase = ph; return; } // the same guidance (its times may be newer)
    gen++; phase = ph; phaseAt = nowS();
    clearInterval(dueTimer); dueTimer = 0;
    ses = null; ride = null;
    boxes.replaceChildren();
    if (!ph || ph.kind !== 'board') return; // on board, the last walk, there: no vehicle to look for
    arDetector(); arDisplayReader(); // (loaded once; here when the first ride to find comes up)
    ride = arRideOf(ph);
    const s = createArSession(ride);
    ses = s;
    // what is due at the boarding stop, every 15 s (Kante /api/due); a failed poll changes nothing now, and the board
    // goes stale on its own after AR_LIMITS.BOARD_STALE_S (no green or red without a fresh one). before: 300, so a late
    // vehicle timed as departed is still on the board (and still blocks green for a twin display). Answers that come
    // back out of order are dropped: an older board must never replace a newer one.
    const g = gen, stopId = stopUic(ph.ride.s.from), toId = stopUic(ph.ride.s.to);
    let dueAsked = 0, dueApplied = 0;
    const loadDue = () => {
      const hooks = scanHooks();
      if (!hooks.due || !stopId || g !== gen) return;
      const n = ++dueAsked;
      hooks.due({ station: String(stopId), after: 900, before: 300, to: toId ? String(toId) : undefined, limit: 80 })
        .then((d) => {
          if (g !== gen || n < dueApplied) return;
          if (d) { dueApplied = n; s.board(boardOf(d, nowS())); } else s.boardFailed(nowS());
        }, () => { if (g === gen) s.boardFailed(nowS()); });
    };
    loadDue();
    dueTimer = window.setInterval(loadDue, 15000);
  };
  setPhase(arPhase());

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
  // (only pictures taken since the target began count for it)
  const ocrAge: number[] = [];
  const onWords = (ev: Event) => {
    const d = (ev as CustomEvent<ScanWordsDetail>).detail;
    if (!d || !d.width || d.tap || !ses) return;
    const at = (d.capturedAt || 0) / 1000;
    if (!at || at < phaseAt) return; // without the capture time a read cannot be put on the right vehicle
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
  let detName = '', detRetry = 0, detFails = 0;
  let dbgText: HTMLElement | null = null, saveBtn: HTMLElement | null = null;
  if (AR_DEBUG) {
    const save = saveBtn = h('button', null, 'Save last 10 s');
    save.addEventListener('click', () => saveCapture());
    dbgText = h('div', null, '');
    layer.append(h('div', 'ar-dbg', dbgText, save));
  }
  const cropCanvas = AR_DEBUG ? document.createElement('canvas') : null;
  const keepCrops = (now: number) => {
    if (!cropCanvas || !ses) return;
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
      motion: arMotion, ride, phase: phase && phase.kind, derotation: ses && ses.derotation(), labels: ses ? ses.labels(now) : [],
      banner: ses && ses.banner(now), detectMs: detectMs.slice(), ocrAgeS: ocrAge.slice(), ppocrMs: ocrMs.slice(), log: ses ? ses.log() : [],
      crops: crops.slice() };
    const name = `ar-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const body = JSON.stringify(data);
    const file = new File([body], name, { type: 'application/json' });
    const upload = window.APP_CONFIG && window.APP_CONFIG.arCaptureUrl; // the field-test server (tools/ar-test.mts)
    if (upload) {
      const said = (t: string) => { if (saveBtn) { saveBtn.textContent = t; setTimeout(() => { if (saveBtn) saveBtn.textContent = 'Save last 10 s'; }, 3000); } };
      said('Saving…');
      fetch(`${upload}?name=${encodeURIComponent(name)}`, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
        .then((r) => { if (!r.ok) throw new Error(String(r.status)); said('Saved ✓'); })
        .catch(() => { said('Upload failed: downloaded'); offerFile(file, name, false); });
      return;
    }
    offerFile(file, name, true);
  };
  const offerFile = (file: File, name: string, share: boolean) => {
    const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
    if (share && nav.canShare && nav.canShare({ files: [file] })) { navigator.share({ files: [file] }).catch(() => {}); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };

  // display reads: PP-OCR on one vehicle's display band at a time, at the camera's full resolution, in the order
  // ses.readTarget() gives. Paced by how long a read takes. Only while there is a vehicle to find.
  const ocrCanvas = document.createElement('canvas');
  const ocrMs: number[] = [];
  let ocrBusy = false, ocrNext = 0, ocrState = 'loading';
  const readDisplays = async () => {
    if (!ses || ocrBusy || Date.now() < ocrNext || !video.videoWidth) return;
    ocrBusy = true;
    const g = gen, s = ses;
    try {
      const reader = await arDisplayReader();
      ocrState = reader ? 'ready' : 'unavailable';
      if (!reader || arSession !== mine) { ocrNext = Date.now() + 5000; return; }
      if (g !== gen) return;
      const vw = video.videoWidth, vh = video.videoHeight, now = nowS();
      const target = s.readTarget(now); // a vehicle in turn, or the road band (src/artrack.ts)
      let r: ArBox = [0, 0.2, 1, 0.5]; // the road band
      if (target !== 'road') {
        const b = target;
        r = [b[0] - b[2] * 0.04, b[1], b[2] * 1.08, b[3] * 0.55]; // its upper part, where the display is
      }
      const x0 = Math.max(0, Math.round(r[0] * vw)), y0 = Math.max(0, Math.round(r[1] * vh));
      const w = Math.min(vw - x0, Math.round(r[2] * vw)), hh = Math.min(vh - y0, Math.round(r[3] * vh));
      if (w < 24 || hh < 12) return;
      ocrCanvas.width = w; ocrCanvas.height = hh;
      const ctx = ocrCanvas.getContext('2d', { willReadFrequently: true })!;
      const capturedAt = pictureTime(video) / 1000; // the moment this picture was shown: a stalled video reads one picture
      ctx.drawImage(video, x0, y0, w, hh, 0, 0, w, hh);
      const px = ctx.getImageData(0, 0, w, hh);
      const t0 = performance.now();
      const words = await reader.read(reader.m, { data: px.data, width: w, height: hh }, { width: vw, height: vh, x: x0, y: y0 });
      const ms = performance.now() - t0;
      ocrMs.push(ms); if (ocrMs.length > 20) ocrMs.shift();
      ocrNext = Date.now() + Math.max(200, ms); // as much rest as the read took: the detector and Scan need the CPU too
      if (arSession === mine && g === gen) s.words(words.map((x) => ({ text: x.text, box: x.box, score: x.score })), capturedAt, nowS());
    } catch (e) { ocrNext = Date.now() + 1000; } finally { ocrBusy = false; }
  };

  // The vehicles: only what tells you something. Green (yours) and red (not yours) stand out; a vehicle whose display
  // was read shows it quietly; one with nothing read is not outlined at all.
  const draw = (now: number) => {
    if (!ses) { if (boxes.childNodes.length) boxes.replaceChildren(); return; }
    boxes.replaceChildren(...ses.labels(now).filter((l) => l.kind === 'green' || l.kind === 'red' || !!l.text).map((l) => {
      const [x, y, w, hh] = toScreen(l.box);
      const el = h('div', 'ar-box' + (l.kind === 'green' ? ' ok' : l.kind === 'red' ? ' no' : ' faint'), l.text ? h('span', null, l.text) : null);
      el.style.cssText += `left:${x}px;top:${y}px;width:${w}px;height:${hh}px`;
      return el;
    }));
  };

  // The card at the bottom: what to do now, in two short lines
  const say = (main: string, sub: string) => {
    if (infoMain.textContent !== main) infoMain.textContent = main;
    if (infoSub.textContent !== sub) infoSub.textContent = sub;
    infoSub.hidden = !sub;
  };
  let busy = false, lastDetect = 0;
  const frame = async () => {
    if (arSession !== mine || !root.isConnected) { cleanup(); return; }
    if (Date.now() - phaseChecked > 1000) { phaseChecked = Date.now(); setPhase(arPhase()); } // where the trip is now
    const now = nowS(), ph = phase;
    // the way: an arrow toward the boarding point (or the destination) while GPS and compass are both good
    const to = ph && (ph.kind === 'board' || ph.kind === 'walk') ? ph : null;
    const fresh = heading != null && Date.now() - headingAt < 3000;
    // (a fix that has gone stale gives no distance and no arrow: it would point from where you were)
    const fix = gpsOn() ? userLngLat : null;
    const gpsOk = !!fix && userAccuracy != null && userAccuracy <= 30;
    const dist = to && fix ? Math.round(distKm(fix, to.ll) * 1000) : null;
    if (to && fresh && gpsOk && dist != null && dist > 8) {
      const turnDeg = ((bearingDeg(fix!, to.ll) - heading! + 540) % 360) - 180;
      arrow.style.display = '';
      arrow.style.transform = `translateX(-50%) perspective(400px) rotateX(55deg) rotate(${turnDeg}deg)`;
    } else arrow.style.display = 'none';
    const where = !to ? '' : dist == null ? to.label : dist <= 8 ? `You're at ${to.label}` : `${to.label} · ${dist} m`;
    if (!ph) say('No journey', 'Plan a journey to use the AR camera.');
    else if (ph.kind === 'board') say(ses ? ses.banner(now).text : `${ph.line} → ${ph.to}`, where);
    else if (ph.kind === 'ride') { const [a, b] = rideText(ph.ride, Date.now()); say(a, b); }
    else if (ph.kind === 'walk') say(`Walk to ${ph.label}`, dist == null ? 'Turn on location for the way' : where);
    else say("You're there", ph.label);
    draw(now); // labels expire and are revoked between detections too
    readDisplays();
    if (dbgText) {
      const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
      const ls = ses ? ses.labels(now) : [];
      dbgText.textContent = `${ph ? ph.kind : 'none'} · video ${video.videoWidth}×${video.videoHeight} · detect ${detName} ${Math.round(avg(detectMs))} ms · Tesseract age ${avg(ocrAge).toFixed(1)} s`
        + ` · PP-OCR ${ocrState}${ocrMs.length ? ' ' + Math.round(avg(ocrMs)) + ' ms' : ''}`
        + ` · motion ${arMotion}${!ses || ses.derotation().on ? '' : ' (gyro shift off)'}${fresh ? '' : ' · compass not ready'}\n`
        + (ls.length ? ls.map((l) => `#${l.track} ${l.kind} ${l.reason}`).join(' · ') : 'no vehicles');
    }
    // vehicles, about 3 times a second, only while there is one to find
    if (!ses || busy || Date.now() - lastDetect < 330 || !video.videoWidth) return;
    if (Date.now() < detRetry) return; // no detector, or it kept failing: try again later
    busy = true; // before any await: one detection at a time, also while the model loads
    const g = gen, s = ses;
    try {
      const model = await arDetector();
      if (!model) { detRetry = Date.now() + 15000; return; }
      if (arSession !== mine || g !== gen) return;
      lastDetect = Date.now();
      const t0 = performance.now(), at = nowS();
      const shift = turn, panned = pan;
      const dets: ArDet[] = await model.detect(video);
      detName = model.name;
      // only now taken: if the detector throws, the turn counts towards the next detection (a jerk still revokes)
      turn = { dx: turn.dx - shift.dx, dy: turn.dy - shift.dy }; pan -= panned;
      detectMs.push(performance.now() - t0); if (detectMs.length > 20) detectMs.shift();
      if (arSession !== mine || g !== gen) return;
      s.detections(dets, at, motionAt ? shift : null, motionAt ? panned : null); // the picture the detector read was taken at `at`
      keepCrops(at);
      draw(nowS());
      detFails = 0;
    } catch (e) {
      // a frame the detector could not read; three in a row: the model itself fails here (tiny: nano instead)
      if (++detFails >= 3) {
        console.warn('AR: the vehicle detector keeps failing', e);
        detRetry = Date.now() + (detBroken ? 15000 : 2000); // nano failing too: try again now and then
        detFails = 0; arModel = null; detBroken = true;
      }
    } finally { busy = false; }
  };
  const cleanup = () => {
    stopTick();
    clearInterval(dueTimer);
    gen++; ses = null;
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
const modeWord = (r: JourneyRideStep) => ({ train: 'train', tram: 'tram', bus: 'bus', boat: 'boat', cable: 'cable car' } as Record<LineMode, string>)[modeOf(r.s.line.category)];
