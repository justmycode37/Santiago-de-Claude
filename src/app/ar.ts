// ---- AR camera: on the next step of a journey, a live camera view that finds the stop and its boarding edge, the
//      vehicles, and the direction to go. No shutter: it runs by itself, frame after frame, until it is closed.
//      - The stop and edge: Scan's live pipeline (stopvision.js: sign OCR + GPS + compass), with the journey's next ride
//        as its route, so it outlines the sign it read and says where your ride leaves from.
//      - Vehicles: buses, trams and trains outlined by an in-browser detector (COCO-SSD, TensorFlow.js). The words Scan
//        reads on the biggest one (scan:words) go through arcore.js (RightSide's display matcher) against your ride and
//        everything due at the stop (Kante /api/due): "Your tram 10 → …" or "Not yours: …". Until a display is read,
//        the label says only what the engine has due now, and asks you to check the display.
//      - The way: an arrow toward your boarding edge, from GPS + compass, only while both are fresh and good enough.
//      ?ar=0 in the page address hides the button (remembered; ?ar=1 shows it again). ----
import { openScanWith, scanHooks } from './menu.ts';
import { userAccuracy, userLngLat } from './location.ts';
import { bearingDeg } from './map-places.ts';
import { lineLabel, modeOf, stopName, stopUic } from './journey-steps.ts';
import { h, kBtn, kIcon, quayOf } from './sheet.ts';
import { distKm } from './routing.ts';
import type { DeviceOrientationAsk } from './menu.ts';

const AR_ON = (() => { // on unless switched off with ?ar=0 (remembered; ?ar=1 switches it on again)
  try {
    const q = new URLSearchParams(location.search).get('ar');
    if (q === '0') localStorage.setItem('arOff', '1');
    if (q === '1') localStorage.removeItem('arOff');
    return localStorage.getItem('arOff') !== '1';
  } catch (e) { return true; }
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

let arSession = 0;
function arOpen(st: JourneyStep) {
  const target = arTargetOf(st);
  if (!target) return;
  // both permissions here, while the tap still counts as a user gesture (iOS)
  const camera = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    ? navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
    : Promise.reject(new Error('no camera API'));
  const orientation = window.DeviceOrientationEvent && typeof (DeviceOrientationEvent as DeviceOrientationAsk).requestPermission === 'function'
    ? (DeviceOrientationEvent as DeviceOrientationAsk).requestPermission!() : Promise.resolve('granted');
  camera.catch(() => {}); orientation.catch(() => {});
  const mine = ++arSession;
  const hooks = scanHooks();
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

  // what is due at the boarding stop, every 15 s (Kante /api/due)
  let due: KanteDueResponse | null = null;
  const stopId = stopUic(target.ride.s.from);
  const loadDue = () => {
    const hooks = scanHooks();
    if (!hooks.due || !stopId) return;
    hooks.due({ station: String(stopId), after: 900, before: 60 }).then((d) => { due = d; }, () => {});
  };
  loadDue();
  const dueTimer = setInterval(loadDue, 15000);
  // what the display of the vehicle in view says: the words Scan reads (scan:words) that lie on the biggest detected
  // vehicle, through arcore.js (RightSide's matcher) against the ride you want and everything due here (/api/due)
  let vehicle: { box: ArBox; score: number; others: ArBox[]; at: number } | null = null;
  let readings: ArReading[] = [];
  let display: { ours: boolean; text: string; at: number } | null = null;
  let frameNo = 0;
  const onWords = (ev: Event) => {
    const d = (ev as CustomEvent<ScanWordsDetail>).detail;
    const A = window.ARCORE;
    if (!A || !d || !d.width || !vehicle || Date.now() - vehicle.at > 1500) return;
    const texts: ArText[] = d.words.filter((w) => w.text && w.text.trim()).map((w) => ({ text: w.text,
      box: [w.box.x0 / d.width, w.box.y0 / d.height, (w.box.x1 - w.box.x0) / d.width, (w.box.y1 - w.box.y0) / d.height] as ArBox,
      score: Math.max(0.5, Math.min(1, w.conf / 100)) })); // Tesseract gives big lettering a low confidence
    const now = Date.now() / 1000;
    const r = A.read(texts, { box: vehicle.box, score: vehicle.score }, vehicle.others, now, `w${frameNo++}`);
    readings = [...readings.filter((x) => now - x.at <= 2), r];
    const board: ArCandidate[] = ((due && due.due) || []).filter((x) => x.line && x.headsign)
      .map((x) => ({ line: x.line!.name, destination: x.headsign!, vias: x.vias || undefined }));
    const dec = A.decide(readings, now, { line: target.line, destination: target.to, board }, now);
    if (dec.state === 'match') display = { ours: true, text: `${target.line} → ${target.to}`, at: Date.now() };
    else if (dec.state === 'wrong') display = { ours: false, text: dec.other ? `${dec.other.line} → ${dec.other.destination}` : 'another service', at: Date.now() };
  };
  window.addEventListener('scan:words', onWords);
  const mineDue = () => {
    const list = (due && due.due) || [];
    const key = window.ARCORE ? window.ARCORE.lineKey(target.line) : target.line;
    return list.find((d) => d.line && (window.ARCORE ? window.ARCORE.lineKey(d.line.name) : d.line.name) === key
      && (!target.to || !window.ARCORE || window.ARCORE.destinationSimilarity(d.headsign || '', target.to) >= 0.6)) || null;
  };

  // picture pixels → screen (the video fills the screen with object-fit: cover)
  const toScreen = (x: number, y: number, w: number, hgt: number) => {
    const vw = video.videoWidth, vh = video.videoHeight, W = root.clientWidth, H = root.clientHeight;
    const s = Math.max(W / vw, H / vh), ox = (W - vw * s) / 2, oy = (H - vh * s) / 2;
    return [ox + x * s, oy + y * s, w * s, hgt * s];
  };

  let busy = false, lastDetect = 0;
  const frame = async () => {
    if (arSession !== mine || !root.isConnected) { cleanup(); return; }
    // the way: an arrow toward the boarding point while GPS and compass are both good
    const fresh = heading != null && Date.now() - headingAt < 3000;
    const gpsOk = !!userLngLat && userAccuracy != null && userAccuracy <= 30;
    const dist = userLngLat ? Math.round(distKm(userLngLat, target.ll) * 1000) : null;
    if (fresh && gpsOk && dist != null && dist > 8) {
      const turn = ((bearingDeg(userLngLat!, target.ll) - heading! + 540) % 360) - 180;
      arrow.style.display = '';
      arrow.style.transform = `translateX(-50%) perspective(400px) rotateX(55deg) rotate(${turn}deg)`;
    } else arrow.style.display = 'none';
    const where = dist == null ? 'Turn on location for the way' : dist <= 8 ? `You're at ${target.label}` : `${target.label} · ${dist} m${fresh ? '' : ' · compass not ready'}`;
    const m = mineDue();
    const when = m ? (m.state === 'at-stop' ? 'at the stop now' : m.etaS != null ? `in ${Math.max(0, Math.round(m.etaS / 60))} min` : '') : '';
    info.textContent = `${target.line} to ${target.to}${when ? ' · ' + when : ''} — ${where}`;
    // vehicles, about 3 times a second
    if (busy || Date.now() - lastDetect < 330 || !video.videoWidth) return;
    const model = await arDetector();
    if (!model || arSession !== mine) return;
    busy = true; lastDetect = Date.now();
    try {
      const found = (await model.detect(video, 6, 0.5)).filter((b) => b.class === 'bus' || b.class === 'train');
      const vw = video.videoWidth, vh = video.videoHeight;
      const norm = (b: CocoBox): ArBox => [b.bbox[0] / vw, b.bbox[1] / vh, b.bbox[2] / vw, b.bbox[3] / vh];
      const big = found.reduce<CocoBox | null>((x, b) => (!x || b.bbox[3] > x.bbox[3] ? b : x), null);
      if (big) vehicle = { box: norm(big), score: big.score, others: found.filter((b) => b !== big).map(norm), at: Date.now() };
      const atStop = ((due && due.due) || []).filter((d) => d.state === 'at-stop' || (d.etaS != null && d.etaS < 60));
      boxes.replaceChildren(...found.map((b) => {
        const [x, y, w, hh] = toScreen(...b.bbox);
        const read = display && Date.now() - display.at < 6000 && b === big ? display : null;
        const ours = read ? read.ours : !!m && atStop.length === 1 && atStop[0] === m;
        const other = !ours && !read && atStop.length === 1 && atStop[0].line ? atStop[0] : null;
        const label = read ? (read.ours ? `Your ${modeWord(target)} ${read.text}` : `Not yours: ${read.text}`)
          : ours ? `Probably your ${target.line} (due now) · check the display`
          : other ? `Probably the ${other.line!.name} to ${other.headsign} · not yours`
          : m && m.etaS != null && m.etaS > 120 ? `Not yours: your ${target.line} comes in ${Math.round(m.etaS / 60)} min`
          : b.class === 'bus' ? 'Bus or tram · check the display' : 'Train · check the display';
        const el = h('div', 'ar-box' + (ours ? ' ok' : other || (read && !read.ours) || (m && m.etaS != null && m.etaS > 120) ? ' warn' : ''), h('span', null, label));
        el.style.cssText += `left:${x}px;top:${y}px;width:${w}px;height:${hh}px`;
        return el;
      }));
    } catch (e) { /* a frame the detector could not read */ }
    busy = false;
  };
  const cleanup = () => {
    stopTick();
    clearInterval(dueTimer);
    window.removeEventListener('scan:words', onWords);
    window.removeEventListener('deviceorientationabsolute', onOri);
    window.removeEventListener('deviceorientation', onOri);
    layer.remove();
    if (arSession !== mine) document.body.classList.remove('ar-open');
  };
  const tick = setInterval(frame, 100); // ~10 updates a second; also runs where animation frames are held back
  const stopTick = () => clearInterval(tick);
}
const modeWord = (t: ArTarget) => ({ train: 'train', tram: 'tram', bus: 'bus', boat: 'boat', cable: 'cable car' } as Record<LineMode, string>)[modeOf(t.ride.s.line.category)];
