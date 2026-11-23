// Walking pace. With "Adjust to how I walk" on (Settings; off unless you turn it on), the app measures how fast you
// walk from the location fixes it gets anyway while it is open. At the next start it moves the walking speed to the
// stop of the slider (Slow … Fast) that fits your usual pace, and says so in a notice that stays until you close it.
// Privacy: all that is kept is each stretch's day, length and duration, in this browser's storage on this device.
// No positions are kept and nothing is sent anywhere. Turning the setting off deletes it.
// Also here: the developer tools at the bottom of Settings, which log made-up walks to test all this.
import { SETTINGS } from './settings.ts';
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

/** A walked stretch as the tracker measures it, and as it is kept (with its day number). */
interface Stretch { s: number; m: number }
interface Walk extends Stretch { d: number }
/** The reading in progress, and the stretch being walked (from a to b). */
interface Reading { t: number; ll: LngLat; speeds: number[] }
interface Bout extends Stretch { a: LngLat; b: LngLat }
/** What the notice says: the speed changed from → to (km/h). sample: shown from the developer options. */
interface PaceNotice { from: number; to: number; sample?: boolean }
interface PaceData { walks: Walk[]; notice: PaceNotice | null; dev: boolean }
/** What the start-up check did: changed the speed, or why not. kmh = the usual pace, when there is one. */
type CheckResult =
  | { changed: true; kmh: number; why?: undefined }
  | { changed?: undefined; why: 'off'; kmh?: undefined }
  | { changed?: undefined; why: 'few'; kmh?: undefined }
  | { changed?: undefined; why: 'same'; kmh: number };

// metres between two [lng, lat]
function dist(a: LngLat, b: LngLat) {
  const k = Math.PI / 180;
  return Math.hypot((b[0] - a[0]) * k * Math.cos((a[1] + b[1]) / 2 * k), (b[1] - a[1]) * k) * 6371000;
}

// Turns location fixes ({ ll: [lng, lat], acc: metres, speed: m/s or nothing, t: ms }) into walked stretches
// ({ s: seconds, m: metres }), each handed to commit.
function makeTracker(commit: (w: Stretch) => void) {
  let from: Reading | null = null;    // where the current reading began: { t, ll, speeds }
  let bout: Bout | null = null;    // the stretch being walked: { s, m, a, b }
  let riding = false; // a reading was too fast for walking and there was no standstill since
  function end() {
    const w = bout;
    bout = null;
    if (w && w.s >= MIN_S && w.m >= MIN_M && dist(w.a, w.b) >= STRAIGHT * w.m) commit({ s: w.s, m: w.m });
  }
  return {
    fix({ ll, acc, speed, t }: WalkPaceFix) {
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
    stop() { end(); from = null; riding = false; }, // the fixes end here (app in the background)
    drop() { from = bout = null; riding = false; },
  };
}

// ---- What is kept: { walks: [{ d: day number, s, m }], notice: { from: km/h, to: km/h } or null, dev } ----
// dev: the walks were logged in the developer options, so they count however few or short they are.
const data: PaceData = { walks: [], notice: null, dev: false };
const isStop = (kmh: number) => STOPS.some((p) => p.kmh === kmh);
try {
  const saved: Partial<PaceData> | null = JSON.parse(localStorage.getItem(KEY)!);
  if (saved && Array.isArray(saved.walks)) data.walks = saved.walks.filter((w) => w && w.s > 0 && w.m > 0 && Number.isFinite(w.d));
  if (saved && saved.notice && isStop(saved.notice.from) && isStop(saved.notice.to)) data.notice = saved.notice;
  if (saved && saved.dev === true && data.walks.length) data.dev = true;
} catch { /* starts empty */ }
function save() {
  try {
    if (data.walks.length || data.notice) localStorage.setItem(KEY, JSON.stringify(data));
    else localStorage.removeItem(KEY);
  } catch { /* not saved, still applied for this visit */ }
}
const on = () => SETTINGS.prefs().autoSpeed;
const today = () => Math.floor(Date.now() / 864e5);
function keep(w: Stretch) {
  data.dev = false; // a real stretch: the usual rules apply again
  data.walks.push({ d: today(), s: Math.round(w.s), m: Math.round(w.m) });
  data.walks = data.walks.filter((x) => x.d > today() - KEEP_DAYS).slice(-KEEP);
  save();
}

// Your usual pace in km/h: the middle one of the stretches, each counted by how long it was. null = too little walking yet
// (a walk logged in the developer options counts however short it is).
function usualKmh(walks: Walk[]) {
  const total = walks.reduce((n, w) => n + w.s, 0);
  if (!total || (!data.dev && (walks.length < NEED_WALKS || total < NEED_S))) return null;
  const byPace = walks.map((w) => ({ kmh: w.m / w.s * 3.6, s: w.s })).sort((a, b) => a.kmh - b.kmh);
  let seen = 0;
  for (const w of byPace) {
    seen += w.s;
    if (seen >= total / 2) return w.kmh;
  }
  return null;
}

const stopIndex = (kmh: number) => STOPS.reduce((best, p, i) => (Math.abs(p.kmh - kmh) < Math.abs(STOPS[best].kmh - kmh) ? i : best), 0);
const labelOf = (kmh: number) => STOPS[stopIndex(kmh)].label;
// The stop a usual pace belongs to, seen from the stop in use. It only moves on when the pace is clearly past the
// halfway point to the next stop, so a pace near a boundary doesn't flip the setting back and forth.
function stopFor(kmh: number, cur: number) {
  let i = cur;
  while (i < STOPS.length - 1 && kmh > (STOPS[i].kmh + STOPS[i + 1].kmh) / 2 + MARGIN) i++;
  while (i > 0 && kmh < (STOPS[i].kmh + STOPS[i - 1].kmh) / 2 - MARGIN) i--;
  return i;
}

// ---- The notice. What it says is saved with the change and only cleared when you close it, so it shows on
// every start until then, whatever else happens first. ----
const note = document.getElementById('paceNote')!;
function showNotice() {
  const n = data.notice;
  if (!n) return;
  note.hidden = false;
  document.getElementById('paceNoteTitle')!.textContent = `Walking speed set to ${labelOf(n.to)}`;
  document.getElementById('paceNoteBody')!.textContent =
    `Was ${labelOf(n.from)}. Based on how you walk.`;
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
document.getElementById('paceNoteClose')!.addEventListener('click', closeNotice);
document.getElementById('paceNoteGo')!.addEventListener('click', () => {
  closeNotice();
  SETTINGS.open('setSpeedHead');
});

// The check made at every start: does your usual pace fit another stop than the one in use? Then change it and say so.
function check(): CheckResult {
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
  data.dev = false;
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
// Nothing is measured here: a developer walk is logged straight away as walked at the set speed, so the start-up
// check has something to work with at once.
const devTools = document.getElementById('devTools')!;
const devState = document.getElementById('devPaceState')!;
const devResult = document.getElementById('devPaceResult')!;
const many = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : (word.endsWith('ch') ? 'es' : 's')}`;
const span = (s: number) => {
  s = Math.round(s);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
};
const NEEDS = `at least ${span(NEED_S)} of walking in ${many(NEED_WALKS, 'stretch')}`;

function stateText() {
  if (!on()) return 'Off. Turn on “Adjust to how I walk”, or log a walk below (that turns it on).';
  if (!data.walks.length) return 'Nothing recorded yet.';
  const head = `${span(data.walks.reduce((n, w) => n + w.s, 0))} of walking in ${many(data.walks.length, 'stretch')}`
    + (data.dev ? ' (logged here)' : '');
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

// The speed developer walks are logged at: one value, set here or in the path panel
const DEV_KEY = 'walk-pace-dev';
const speedInputs = [document.getElementById('devSpeed') as HTMLInputElement, document.getElementById('simSpeed') as HTMLInputElement];
const speedLabels = [document.getElementById('devSpeedVal')!, document.getElementById('simSpeedVal')!];
let simKmh = 5;
try {
  const v: { kmh: number } | null = JSON.parse(localStorage.getItem(DEV_KEY)!);
  if (v && v.kmh >= 2 && v.kmh <= 8) simKmh = v.kmh;
} catch { /* 5 km/h */ }
function setSimKmh(v: number, store: boolean) {
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

// Logs a walk of this many metres at the set speed. It replaces what was recorded and counts however short it is
// (data.dev), and turns "Adjust to how I walk" on if it was off. Says what happens at the next start.
function logWalk(metres: number) {
  if (!(metres > 0)) return 'Nothing logged: the walk has no length.';
  const kmh = simKmh, s = metres / (kmh / 3.6);
  const turnedOn = !on();
  if (turnedOn) SETTINGS.set({ autoSpeed: true });
  const parts = Math.ceil(s / MAX_S), d = today();
  const r1 = (x: number) => Math.max(0.1, Math.round(x * 10) / 10);
  live.drop();
  data.walks = Array.from({ length: parts }, () => ({ d, s: r1(s / parts), m: r1(metres / parts) }));
  data.dev = true;
  save();
  renderDev();
  const avg = usualKmh(data.walks)!;
  const cur = stopIndex(SETTINGS.prefs().walkKmh), to = stopFor(avg, cur);
  return `Logged ${Math.round(metres)} m in ${span(s)}: average ${avg.toFixed(1)} km/h. `
    + (turnedOn ? 'Turned on “Adjust to how I walk”. ' : '')
    + (to === cur ? `That fits ${STOPS[cur].label}, the speed in use, so nothing changes.`
      : `Reload the app and the speed changes from ${STOPS[cur].label} to ${STOPS[to].label}.`);
}

devTools.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-dev]');
  if (!b) return;
  const say = (text: string) => { devResult.textContent = text; };
  switch (b.dataset.dev) {
    case 'draw':
      if (!hooks) return;
      SETTINGS.close();
      openDraw();
      break;
    case 'walk':
      say(logWalk(simKmh / 3.6 * 600));
      break;
    case 'check': {
      const r = check();
      say(r.changed ? `Changed from ${labelOf(data.notice!.from)} to ${labelOf(data.notice!.to)} (usual pace ${r.kmh.toFixed(1)} km/h). The notice is showing.`
        : r.why === 'off' ? 'Nothing to do: “Adjust to how I walk” is off.'
        : r.why === 'few' ? `No change: too little walking recorded. It needs ${NEEDS}, or a walk logged here.`
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
      data.dev = false;
      live.drop();
      save();
      renderDev();
      say('Recorded walks deleted.');
      break;
  }
});

// ---- Developer options: draw a path on the map and walk it ----
// "Walk it" is instant: your position jumps to the end of the path and the walk is logged at the set speed.
const panel = document.getElementById('simPanel')!;
const simStatus = document.getElementById('simStatus')!;
const simUndo = document.getElementById('simUndo') as HTMLButtonElement;
const simClear = document.getElementById('simClear') as HTMLButtonElement;
const simGo = document.getElementById('simGo') as HTMLButtonElement;
let hooks: WalkPaceHooks | null = null;   // { map, position(pos), restore() } from the main script
let svg: SVGSVGElement | null = null, svgLine: SVGPolylineElement | null = null, svgDots: SVGGElement | null = null;
let drawOpen = false;
let pts: LngLat[] = [];       // the path: [lng, lat] points
let lastResult = '';

const pathMetres = () => pts.reduce((n, p, i) => (i ? n + dist(pts[i - 1], p) : 0), 0);
function drawPath() {
  if (!svg) return;
  const px = pts.map((p) => hooks!.map.project(p));
  svgLine!.setAttribute('points', px.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
  svgDots!.innerHTML = px.map((p, i) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${i === 0 || i === px.length - 1 ? 7 : 4.5}" />`).join('');
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
function closeDraw() {
  drawOpen = false;
  pts = [];
  panel.hidden = true;
  document.body.classList.remove('sim-mode');
  drawPath();
  hooks!.restore(); // your real position again
}
simGo.addEventListener('click', () => {
  if (pts.length < 2) return;
  const [lng, lat] = pts[pts.length - 1];
  hooks!.position({ coords: { longitude: lng, latitude: lat, accuracy: 8 }, timestamp: Date.now(), simulated: true });
  lastResult = 'Arrived. ' + logWalk(pathMetres());
  drawPath();
});
simUndo.addEventListener('click', () => { pts.pop(); lastResult = ''; drawPath(); });
simClear.addEventListener('click', () => { pts = []; lastResult = ''; drawPath(); });
document.getElementById('simClose')!.addEventListener('click', closeDraw);

export const WALK_PACE: WalkPaceApi = {
  // every real location fix: { ll: [lng, lat], acc: metres, speed: m/s or nothing, t: ms }
  fix(f) { if (on()) live.fix(f); },
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
      if (!drawOpen) return;
      pts.push([e.lngLat.lng, e.lngLat.lat]);
      lastResult = '';
      drawPath();
    });
  },
  drawing: () => drawOpen,   // taps on the map draw the path
};

// ---- Start ----
// A notice still waiting that no longer fits (the setting went off, or the speed is another one by now) is dropped
if (data.notice && !data.notice.sample && (!on() || SETTINGS.prefs().walkKmh !== data.notice.to)) { data.notice = null; save(); }
check();
showNotice(); // also one from an earlier start that was never closed
setSimKmh(simKmh, false);
renderDev();
