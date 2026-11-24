// The 3D view of a station inside the app: the continuous model of station3d-solid.ts (one building at true heights,
// with the route as a tube and the floors above it cut open) in an overlay over the map, with the walk step by step.
// Loaded the first time a station is opened (the stand-in Station3D in station3d.ts sends its open() here), together
// with the station's model (stations3d/<key>.js), its continuous companion (stations3d/<key>.solid.js), the router
// (station-route.ts), station-view.css and three.js (the import map in index.html). docs/station3d-solid.md
//
//   StationView.open({ key, from, to, prefs, title, returnFocus })   as Station3D.open
//   StationView.close() · isOpen() · setUser(u) · on(name, fn) / off · preload(key) · has(key) after ready()
//
// Events as Station3D's (Station3DEventMap in station3d.ts): 'opening', 'open', 'close', 'step', 'done', 'error'.
// indoornav.ts hears them through the stand-in, and feeds the position back with setUser (with the floor
// probabilities of the indoor filter).
/** The renderer (station3d-solid.ts) as this view uses it: a renderer with the indoor position also has the optional parts. */
interface SolidUserState {
  visible: boolean; outside?: boolean; far?: number; x?: number; y?: number;
  /** null: no floor observed (GPS alone, or the filter not sure enough to say one). */
  level?: number | null; levelProb?: number | null; levelProbs?: Record<string, number> | null; sure?: boolean;
  acc?: number; mode?: 'route' | 'free'; step?: number; offRouteSec?: number; follow: boolean;
}
interface SolidChange { route: StationRouteResult | null; step: number; focusLevel: number | null; playing?: boolean }
interface SolidLevel { id: number; z: number; name: string }
interface SolidView {
  model: StationModel;
  levels: SolidLevel[];
  readonly route: StationRouteResult | null;
  /** Only a renderer with the indoor position has these. */
  readonly user?: SolidUserState;
  readonly stretch: number;
  plan(from: StationRouteEndpoint | null, to: StationRouteEndpoint | null, prefs?: StationRoutePrefs | null): StationRouteResult | null;
  step(i: number): void;
  whole(): void;
  floor(id: number | null): void;
  next(): void;
  prev(): void;
  setStretch(s: number): void;
  /** true: the whole station; false: only the part the route uses (the default). */
  showAll?(on: boolean): void;
  /** Only the part of the station the route uses is drawn (false: the whole station). */
  readonly focused?: boolean;
  setUser?(u: (Station3DUser & { levelProbs?: Record<string, number>; levelProb?: number }) | null): void;
  /** The train at the platform (station3d-solid.ts). */
  setTrain?(t: SolidTrainInput): TrainLayout | null;
  clearTrain?(role?: SolidTrainInput['role']): void;
  follow?(on: boolean): void;
  locate?(): void;
  /** The play-through (a walker going the way, the camera behind it). */
  play?(): void;
  pause?(): void;
  readonly playing?: boolean;
  reset(): void;
  dispose(): void;
  _debug(): Record<string, unknown>;
}
interface SolidOpenOptions {
  mount: HTMLElement; key: string;
  from?: StationRouteEndpoint | null; to?: StationRouteEndpoint | null; prefs?: StationRoutePrefs | null;
  /** Names for the two ends of the route, where the router has none ("Platform 7" it knows). */
  fromLabel?: string; toLabel?: string;
  onChange?(c: SolidChange): void;
  onUser?(u: SolidUserState): void;
}
interface SolidModule { open(o: SolidOpenOptions): Promise<SolidView> }

import type { StationRouteEndpoint, StationRouteResult, StationRouteStep, StationRouteStopRef } from './station-route.ts';
import { load, reloadNote } from './lazy.ts';
import type { Station3DEndpoint, Station3DErrorCode, Station3DEventMap, Station3DOpenOptions, Station3DUser } from './station3d.ts';
import type { StationRoutePrefs } from './station-route.ts';
import type { SolidTrainInput } from './station3d-solid.ts';
import type { TrainCar, TrainLayout } from './train-layout.ts';
import { endOf, loadTrain, sectorList } from './train-formation.ts';
import { planCoach } from './coach-plan.ts';
import type { CoachPlan, CoachPlanContext } from './coach-plan.ts';
import { Station3D } from './station3d.ts';
import { StationRoute } from './station-route.ts';
import { KANTE } from './engine.ts';
import type { Station3DTrain, TrainCoach, TrainCrowd, TrainShown } from './train-formation.ts';
const RECENT_MS = 60e3;   // a remembered GPS fix older than this is not shown when the view opens

// ------------------------------------------------------------------ loading
const scripts = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  if (!scripts.has(src)) scripts.set(src, new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { scripts.delete(src); s.remove(); reject(new Error('Could not load ' + src)); };
    document.head.appendChild(s);
  }));
  return scripts.get(src)!;
}
let cssP: Promise<void> | null = null;
function loadCss(): Promise<void> {
  if (!cssP) cssP = new Promise<void>((resolve, reject) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'station-view.css';
    l.onload = () => resolve();
    l.onerror = () => { cssP = null; l.remove(); reject(new Error('Could not load station-view.css')); };
    document.head.appendChild(l);
  });
  return cssP;
}
let indexP: Promise<void> | null = null;
/** Loads the list of stations with a continuous model (stations3d/solid-index.js). */
function ready(): Promise<void> {
  if (!indexP) indexP = (window.STATION3D_SOLID_INDEX ? Promise.resolve() : loadScript('stations3d/solid-index.js'))
    .catch((e) => { indexP = null; throw e; });
  return indexP;
}
const has = (key: string) => !!(window.STATION3D_SOLID_INDEX && window.STATION3D_SOLID_INDEX[key]);
let rendererP: Promise<SolidModule> | null = null;
function loadRenderer(): Promise<SolidModule> {
  // three.js and its addons through the import map in index.html (the renderer imports 'three')
  if (!rendererP) rendererP = (load(import.meta.url, () => import('./station3d-solid.ts')) as Promise<SolidModule>)
    .catch((e) => { rendererP = null; throw e; });
  return rendererP;
}
function loadStation(key: string): Promise<void> {
  const need: Promise<void>[] = [];
  if (!(window.STATION3D && window.STATION3D[key])) need.push(loadScript('stations3d/' + key + '.js'));
  if (!(window.STATION3D_SOLID && window.STATION3D_SOLID[key])) need.push(ready().then(() => loadScript(window.STATION3D_SOLID_INDEX![key].file)));
  return Promise.all(need).then(() => {
    if (!(window.STATION3D && window.STATION3D[key]) || !(window.STATION3D_SOLID && window.STATION3D_SOLID[key])) throw new Error('No 3D model for ' + key);
  });
}
function webgl(): boolean {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
}

// ------------------------------------------------------------------ events
type Fn = (d: unknown) => void;
const listeners = new Map<string, Set<Fn>>();
function on(name: string, fn: Fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name)!.add(fn);
  return () => off(name, fn);
}
function off(name: string, fn: Fn) { const s = listeners.get(name); if (s) s.delete(fn); }
function emit(name: string, detail?: unknown) {
  for (const fn of [...(listeners.get(name) || [])]) { try { fn(detail); } catch (e) { console.error(e); } }
}

// ------------------------------------------------------------------ small DOM helpers
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k != null && k !== false) e.append(k);
  return e;
}
function btn(cls: string, label: string | null, onClick: (e: MouseEvent) => void, ...kids: (Node | string | null)[]) {
  const b = el('button', cls, ...kids);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}
const ICON: Record<string, string> = {
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  walk: '<circle cx="13" cy="4.5" r="1.8"/><path d="M10 21l2.2-6.5L15 17v4M12.2 14.5L13 9l-3.5 2V14M13 9l2.5 3H18"/>',
  stairs: '<path d="M3 20h5v-4h4v-4h4V8h5"/>',
  escalator: '<path d="M3 19h4l10-12h4"/><path d="M7 19l-1.5-3M11 14l-1.5-3M15 9.5L13.5 6.5"/>',
  elevator: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9.5 10l2.5-3 2.5 3M9.5 14l2.5 3 2.5-3"/>',
  ramp: '<path d="M3 19h18L3 11z"/>',
  arrive: '<path d="M6 21V4M6 4h11l-2.5 4L17 12H6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  whole: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  alert: '<path d="M12 3l9.5 17H2.5z"/><path d="M12 10v4.5M12 17.5h.01"/>',
  me: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7.5"/>',
  train: '<rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 11h14M9 21l-2-4M15 21l2-4"/><path d="M9 14h.01M15 14h.01"/>',
  wheelchair: '<circle cx="11" cy="4" r="1.6"/><path d="M11 7v6h5l2 5"/><path d="M8 10.5a5.5 5.5 0 1 0 7.5 6.5"/>',
  bike: '<circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16l4-7h5l3 7M10 9l3 7h-7"/>',
  family: '<circle cx="8" cy="5" r="2"/><circle cx="16.5" cy="9" r="1.6"/><path d="M8 8v13M5 12h6M16.5 12v9"/>',
  food: '<path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M16 3c-2 1-3 4-3 7h3v11"/>',
  tram: '<rect x="6" y="5" width="12" height="13" rx="2.5"/><path d="M6 12h12M9 2h6M12 2v3M9 21l1.5-3M15 21l-1.5-3"/>',
  bus: '<rect x="4" y="4" width="16" height="13" rx="2.5"/><path d="M4 11h16M7 20v-3M17 20v-3M8 14h.01M16 14h.01"/>',
};
function icon(name: string, size = 18): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="stv-ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ''}</svg>`;
  return t.content.firstChild as SVGSVGElement;
}
const levelTag = (l: number) => (Math.round(l) > 0 ? '+' : Math.round(l) < 0 ? '−' : '') + Math.abs(Math.round(l));
const kindName = (k: string) => ({ escalator: 'Escalator', stairs: 'Stairs', elevator: 'Lift', ramp: 'Ramp', walk: 'Walk', arrive: 'Arrive' } as Record<string, string>)[k] || k;

// ------------------------------------------------------------------ the overlay
interface Ui {
  root: HTMLElement; mount: HTMLElement; title: HTMLElement; sub: HTMLElement; you: HTMLElement; floors: HTMLElement;
  notice: HTMLElement; train: HTMLElement; trainLive: HTMLElement; guide: HTMLElement; state: HTMLElement; close: HTMLButtonElement;
}
let ui: Ui | null = null;
let view: SolidView | null = null;
let cur: { key: string; opts: Station3DOpenOptions; returnFocus: HTMLElement | null } | null = null;
let seq = 0;                     // the latest open(): an older one that finishes loading later is dropped
let user: Station3DUser | null = null, userAt = 0;
let listOpen = false;
let lastChange: SolidChange = { route: null, step: -1, focusLevel: null };
let historyState = false;        // a history entry of ours: the phone's back button closes the view

function shell(): Ui {
  const close = btn('stv-close', 'Close the 3D view', () => close3d(), icon('close', 20)) as HTMLButtonElement;
  const title = el('b', 'stv-title'), sub = el('small', 'stv-sub'), you = el('div', 'stv-you');
  you.setAttribute('aria-live', 'polite');
  const head = el('header', 'stv-top', close, el('div', 'stv-head', title, sub, you));
  const floors = el('nav', 'stv-floors');
  floors.setAttribute('aria-label', 'Floors');
  const notice = el('div', 'stv-notice');
  notice.setAttribute('role', 'note');
  notice.hidden = true;
  const guide = el('section', 'stv-guide');
  guide.setAttribute('aria-live', 'polite');
  const train = el('section', 'stv-train');
  train.setAttribute('aria-label', 'Your train');
  train.hidden = true;
  const trainLive = el('div', 'stv-sr');
  trainLive.setAttribute('aria-live', 'polite');
  const state = el('div', 'stv-state');
  state.hidden = true;
  const mount = el('div', 'stv-canvas');
  mount.setAttribute('aria-hidden', 'true');
  const root = el('div', 'stv', mount, head, floors, el('div', 'stv-bottom', notice, train, guide), state, trainLive);
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  return { root, mount, title, sub, you, floors, notice, train, trainLive, guide, state, close };
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); close3d(); return; }
  if (!view || e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target as HTMLElement;
  if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
  if (e.key === 'ArrowRight' && view.route) { e.preventDefault(); goStep(lastChange.step + 1); }
  else if (e.key === 'ArrowLeft' && view.route) { e.preventDefault(); goStep(lastChange.step - 1); }
  else if (e.key === 'Tab') trapTab(e);
}
function trapTab(e: KeyboardEvent) {
  if (!ui) return;
  const f = [...ui.root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
function onPop() { if (historyState) { historyState = false; close3d(true); } }

function showState(kind: 'loading' | 'error', message?: string, retry?: () => void) {
  if (!ui) return;
  ui.state.textContent = '';
  ui.state.hidden = false;
  ui.state.className = 'stv-state stv-' + kind;
  if (kind === 'loading') { ui.state.append(el('span', 'stv-spin'), el('span', null, 'Loading the station…')); return; }
  ui.state.append(icon('alert', 28), el('b', null, 'The 3D view could not be shown'), el('span', null, message || ''),
    el('div', 'stv-state-bar', retry ? btn('stv-btn stv-primary', null, retry, 'Try again') : null, btn('stv-btn', null, () => close3d(), 'Close')));
}

// ------------------------------------------------------------------ open / close
function open(opts: Station3DOpenOptions) {
  const id = ++seq;
  const replaces = cur ? cur.key : null;
  emit('opening', { key: opts.key, replaces });
  if (view) { view.dispose(); view = null; }
  const returnFocus = (cur && cur.returnFocus) || opts.returnFocus || (document.activeElement as HTMLElement | null);
  cur = { key: opts.key, opts, returnFocus };
  if (!ui) ui = shell();
  if (!ui.root.isConnected) {
    document.body.appendChild(ui.root);
    if (!historyState) { try { history.pushState({ stationView: true }, ''); historyState = true; } catch (e) {} }
    window.addEventListener('popstate', onPop);
    document.addEventListener('keydown', onKey);   // on the page: a button that re-renders takes the focus with it
  }
  document.documentElement.classList.add('stv-open');
  const model0 = window.STATION3D && window.STATION3D[opts.key];
  ui.title.textContent = opts.title || (model0 && model0.name) || 'Station';
  ui.sub.textContent = '';
  ui.you.textContent = '';
  ui.floors.textContent = '';
  ui.guide.textContent = '';
  ui.notice.hidden = true;
  ui.train.textContent = '';
  ui.train.hidden = true;
  ui.trainLive.textContent = '';
  trainStates = [];
  ui.root.setAttribute('aria-label', '3D view of the station');
  listOpen = false;
  showState('loading');
  requestAnimationFrame(() => { if (ui && cur && cur.opts === opts) ui.close.focus({ preventScroll: true }); });

  const fail = (code: Station3DErrorCode, message: string) => {
    if (id !== seq) return;
    showState('error', message, () => open(opts));
    emit('error', { code, message });
  };
  if (!webgl()) { fail('nowebgl', 'This browser or device cannot draw 3D graphics (WebGL is off or missing).'); return; }
  Promise.all([loadCss(), loadStation(opts.key), loadRenderer()]).then(async ([, , mod]) => {
    if (id !== seq || !ui) return;
    const model = window.STATION3D![opts.key];
    ui.title.textContent = opts.title || model.name;
    ui.root.setAttribute('aria-label', '3D view of ' + model.name);
    const from = opts.from || null, to = opts.to || null;
    const v = await mod.open({
      mount: ui.mount, key: opts.key, from: from && to ? from : null, to: from && to ? to : null, prefs: opts.prefs || null,
      fromLabel: from && from.label ? from.label : undefined, toLabel: to && to.label ? to.label : undefined,
      onChange: (c) => { lastChange = c; render(); },
      onUser: (u) => renderYou(u),
    });
    if (id !== seq) { v.dispose(); return; }
    view = v;
    ui.state.hidden = true;
    floorsRail();
    // one end only (a platform from the map): that floor, framed
    if (!v.route && (from || to)) { const lv = levelOf(model, (to || from)!); if (lv != null) v.floor(lv); }
    if (v.setUser && user && (user.at == null || Date.now() - user.at < RECENT_MS) && performance.now() - userAt < 10 * RECENT_MS) v.setUser(user);
    if ((opts.board || opts.alight) && v.setTrain) startTrains(v, opts, id);
    render();
    if (v.user) renderYou(v.user);
    emit('open', { key: opts.key, route: v.route, focus: null });
  }).catch((e: Error) => {
    console.warn(e);
    const reload = reloadNote(e, 'to open the 3D view');
    if (reload) { fail('updated', reload); return; }
    const three = /three|import|module|station3d-solid/i.test(String(e && (e.message || e)));
    fail(three ? 'three' : 'model', three ? 'Check your connection, then try again.' : 'This station\'s 3D model could not be loaded. Check your connection, then try again.');
  });
}
function close3d(fromHistory = false) {
  if (!cur && !view) return;
  seq++;
  if (view) { view.dispose(); view = null; }
  trainStates = [];
  const back = cur && cur.returnFocus;
  cur = null;
  if (ui) ui.root.remove();
  document.documentElement.classList.remove('stv-open');
  window.removeEventListener('popstate', onPop);
  document.removeEventListener('keydown', onKey);
  if (historyState && !fromHistory) { historyState = false; try { history.back(); } catch (e) {} }
  emit('close');
  if (back && back.isConnected) { try { back.focus({ preventScroll: true }); } catch (e) {} }
}
// the floor of a route end given alone: its level, its stop's level, or none
function levelOf(model: StationModel, e: StationRouteEndpoint): number | null {
  const any = e as { level?: number | null; stop?: StationRouteStopRef };
  if (any.level != null) return Math.round(any.level);
  if (any.stop) {
    const s = (model.stops || []).find((x) => String(x.uic) === String(any.stop!.uic) && (!any.stop!.ref || x.ref === any.stop!.ref));
    if (s && s.level != null) return Math.round(s.level);
  }
  return null;
}

// ------------------------------------------------------------------ floors
function floorsRail() {
  if (!ui || !view) return;
  const v = view;
  const used = new Set((v.route ? v.route.points : []).map((p) => Math.round(p[2])));
  // with a route: its floors (the others are one tap away under ⌂); without: all of them
  const shown = v.levels.slice().reverse().filter((l) => !v.route || used.has(l.id));
  ui.floors.textContent = '';
  for (const l of shown) {
    const b = btn('stv-floor' + (used.has(l.id) ? ' used' : ''), `Level ${levelTag(l.id)}${l.name ? ', ' + l.name : ''}`, () => {
      if (lastChange.focusLevel === l.id) v.whole(); else v.floor(l.id);
    }, el('span', 'stv-pb'), levelTag(l.id));
    b.dataset.l = String(l.id);
    b.title = l.name || '';
    ui.floors.append(b);
  }
  ui.floors.append(btn('stv-floor stv-all', v.route ? 'The whole way' : 'The whole station', () => v.whole(), icon('whole', 18)));
  // only the part of the station the route uses is drawn; this shows (or hides again) the rest of it
  if (v.route && v.showAll) {
    const all = btn('stv-floor stv-station', 'Show the whole station', () => {
      const on = all.getAttribute('aria-pressed') !== 'true';
      all.setAttribute('aria-pressed', on ? 'true' : 'false');
      all.classList.toggle('on', on);
      v.showAll!(on);
    }, 'All');
    // as the renderer has it (a new way drawn while the whole station shows keeps showing it)
    const whole = v.focused === false;
    all.setAttribute('aria-pressed', whole ? 'true' : 'false');
    all.classList.toggle('on', whole);
    all.title = 'The whole station';
    ui.floors.append(all);
  }
}
function syncFloors() {
  if (!ui) return;
  for (const b of ui.floors.querySelectorAll<HTMLButtonElement>('.stv-floor:not(.stv-station)')) {
    const on = b.classList.contains('stv-all') ? (lastChange.step < 0 && lastChange.focusLevel == null) : lastChange.focusLevel === +b.dataset.l!;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

// ------------------------------------------------------------------ guidance
function goStep(i: number) {
  if (!view || !view.route) return;
  const n = view.route.steps.length;
  if (i < 0) { view.whole(); return; }
  view.step(Math.min(n - 1, i));
}
function stepMeta(s: StationRouteStep, i: number, n: number) {
  const parts = [`Step ${i + 1} of ${n}`];
  if (Math.round(s.toLevel) !== Math.round(s.level)) parts.push(`level ${levelTag(s.level)} → ${levelTag(s.toLevel)}`);
  else parts.push(`level ${levelTag(s.level)}`);
  if (s.len) parts.push(`${s.len} m`);
  return parts.join(' · ');
}
function stepIcon(s: StationRouteStep) {
  const k = s.kind === 'walk' || s.kind === 'arrive' ? s.kind : s.kind;
  const wrap = el('span', 'stv-kind stv-k-' + k, icon(ICON[k] ? k : 'walk', 20));
  if (s.dir) wrap.append(el('span', 'stv-dir', icon(s.dir, 12)));
  return wrap;
}
function render() {
  if (!ui || !view) return;
  const v = view, r = v.route, { step, focusLevel } = lastChange;
  syncFloors();
  emit('step', { index: step, step: r && step >= 0 ? r.steps[step] : null });
  // the notice: preferences the route could not keep, closures, a route that stops short
  const notes: string[] = [];
  if (r && r.notice) notes.push(r.notice);
  if (r && r.incomplete && !r.notice) notes.push('The way there is closed: this route ends as near as it can get.');
  ui.notice.textContent = '';
  if (notes.length) ui.notice.append(icon('alert', 16), el('span', null, notes.join(' ')));
  ui.notice.hidden = !notes.length;

  const g = ui.guide;
  g.textContent = '';
  if (!r) {
    const lv = focusLevel != null ? v.levels.find((l) => l.id === focusLevel) : null;
    ui.sub.textContent = lv ? `Level ${levelTag(lv.id)}${lv.name ? ' · ' + lv.name : ''}` : 'Drag to turn, pinch to zoom';
    if (cur && (cur.opts.from || cur.opts.to) && !(cur.opts.from && cur.opts.to)) {
      g.append(el('div', 'stv-text', lv ? `Level ${levelTag(lv.id)}${lv.name ? ', ' + lv.name : ''}` : v.model.name));
    } else if (cur && cur.opts.from && cur.opts.to) {
      g.append(el('div', 'stv-text', 'No way found inside the station for this walk.'), el('div', 'stv-meta', 'Its steps are in the journey.'));
    } else g.append(el('div', 'stv-text', v.model.name));
    return;
  }
  const changes = r.steps.filter((s) => s.kind !== 'walk' && s.kind !== 'arrive' && Math.round(s.toLevel) !== Math.round(s.level));
  ui.sub.textContent = `${Math.round(r.length)} m · ${Math.max(1, Math.round(r.seconds / 60))} min · ${changes.length ? changes.length + ' change' + (changes.length === 1 ? '' : 's') + ' of floor' : 'all on one floor'}`;
  const n = r.steps.length;
  const bar = el('div', 'stv-bar');
  if (focusLevel != null) {
    const lv = v.levels.find((l) => l.id === focusLevel);
    g.append(el('div', 'stv-text', `Level ${levelTag(focusLevel)}${lv && lv.name ? ', ' + lv.name : ''}`),
      el('div', 'stv-meta', 'The floors above are lifted away. ⌂ shows the whole way.'));
    bar.append(btn('stv-btn stv-primary', null, () => goStep(0), 'Start ›'));
  } else if (step < 0) {
    const chips = el('div', 'stv-chips');
    for (const s of changes) chips.append(el('span', 'stv-chip stv-k-' + s.kind, stepIcon(s), `${kindName(s.kind)} ${s.dir === 'down' ? 'down' : 'up'} to ${levelTag(s.toLevel)}`));
    g.append(el('div', 'stv-text', r.same ? 'You are already there.' : `The way to ${endName(r)}`), changes.length ? chips : el('div', 'stv-meta', 'All on one floor.'));
    // what the colours in the model mean (escalators run the way their arrows point)
    g.append(el('div', 'stv-legend', ...([['stv-lg-up', 'Escalator up'], ['stv-lg-down', 'Escalator down'], ['stv-lg-stairs', 'Stairs'], ['stv-lg-lift', 'Lift'], ['stv-lg-route', 'Your way']] as const)
      .map(([c, t]) => el('span', null, el('i', c), t))));
    bar.append(btn('stv-btn stv-primary', null, () => goStep(0), 'Start ›'));
    if (!r.same) bar.append(playBtn(v, false));
  } else {
    const s = r.steps[step];
    const row = el('div', 'stv-step' + (s.warn ? ' warn' : ''), stepIcon(s), el('div', 'stv-step-main', el('div', 'stv-text', s.text), el('div', 'stv-meta', stepMeta(s, step, n))));
    g.append(row);
    const nx = r.steps[step + 1];
    if (nx) g.append(el('div', 'stv-then', 'Then: ', el('span', null, nx.text)));
    bar.append(btn('stv-btn', 'Previous step', () => goStep(step - 1), '‹'));
    bar.append(step < n - 1 ? btn('stv-btn stv-primary', null, () => goStep(step + 1), 'Next ›')
      : btn('stv-btn stv-primary', null, () => emit('done', { route: r }), 'Done'));
    if (step < n - 1 || lastChange.playing) bar.append(playBtn(v, !!lastChange.playing));
  }
  bar.append(el('span', 'stv-grow'));
  // where you are: shown when the position is known; a tap follows you (and again stops following)
  if (v.locate && v.follow) {
    const me = btn('stv-btn stv-icon stv-me', 'Follow my position', () => {
      const on = !(v.user && v.user.follow);
      v.follow!(on);
      if (on) v.locate!();
    }, icon('me', 18));
    me.hidden = !(v.user && v.user.visible);
    me.setAttribute('aria-pressed', v.user && v.user.follow ? 'true' : 'false');
    me.classList.toggle('on', !!(v.user && v.user.follow));
    bar.append(me);
  }
  const lb = btn('stv-btn stv-icon', listOpen ? 'Hide all steps' : 'All steps', () => { listOpen = !listOpen; render(); }, icon('list', 18));
  lb.setAttribute('aria-expanded', listOpen ? 'true' : 'false');
  bar.append(lb);
  g.append(bar);
  if (listOpen) {
    const ol = el('ol', 'stv-list');
    r.steps.forEach((s, i) => {
      const b = btn('stv-li' + (i === step ? ' on' : '') + (s.warn ? ' warn' : ''), null, () => goStep(i), stepIcon(s), el('span', null, s.text));
      if (i === step) b.setAttribute('aria-current', 'step');
      ol.append(el('li', null, b));
    });
    g.append(ol);
  }
}
// ▶ plays the way through (a walker, the camera behind it, the steps as it reaches them); ❚❚ stops it where it is
function playBtn(v: SolidView, on: boolean) {
  const b = btn('stv-btn stv-icon stv-play', on ? 'Pause the play-through' : 'Play the way through', () => { if (v.playing) v.pause!(); else v.play!(); }, icon(on ? 'pause' : 'play', 18));
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  if (!v.play) b.hidden = true;
  return b;
}
function endName(r: StationRouteResult) {
  const s = r.toStop, to = cur && cur.opts.to;
  if (s && s.mode === 'train' && s.ref) return `platform ${s.ref}${r.toSectors && r.toSectors.length ? ', sector ' + r.toSectors.join('–') : ''}`;
  if (to && to.label) return to.label;
  if (s) return `the ${s.mode === 'tram' ? 'tram' : s.mode === 'bus' ? 'bus' : ''} stop`.replace('the  stop', 'the stop');
  return 'the destination';
}

// ------------------------------------------------------------------ the vehicles
// The vehicle the walk leads to (board) and the one it starts from (alight; at a change, both). At once: a train
// where the timetable says it stops (its sectors), a tram or bus of a typical shape at its stop. Then a train's
// coaches from the formation data, and the coach chosen for the whole ride (coach-plan.ts): the walk leads through its
// door into it, or out of it. train-formation.ts loads the data, the renderer draws it; docs/train-formation.md.
interface TrainState {
  train: Station3DTrain; shown: TrainShown | null; layout: TrainLayout | null; target: number[];
  /** The coach chosen for the ride (null: none, or not a train); `planned`: the choice has been made. */
  plan: CoachPlan | null; planned: boolean;
  /** Not drawn now: the vehicle you arrive in and the one you take use the same track or stop (one at a time). */
  hidden: boolean;
}
let trainStates: TrainState[] = [];
/** The ends the way was last aimed at (a coach door), so that it is planned again only when they change. */
let aimedKey = '';
const CLASS_KEY = 'stv-class';
function myClass(): 1 | 2 { try { return localStorage.getItem(CLASS_KEY) === '1' ? 1 : 2; } catch (e) { return 2; } }
function setClass(c: 1 | 2) { try { localStorage.setItem(CLASS_KEY, String(c)); } catch (e) { /* kept for this opening only */ } }
let classNow: 1 | 2 = 2;
const planCtx = (): CoachPlanContext => ({
  engine: KANTE, cls: classNow, prefs: (cur && cur.opts.prefs) || null,
  loadModel: (key) => (view && view.model.key === key ? Promise.resolve(view.model) : Station3D.loadData(key)),
  router: () => StationRoute,
});
const vehicleTitle = (t: Station3DTrain) => `${t.mode === 'tram' ? 'Tram' : t.mode === 'bus' ? 'Bus' : ''} ${t.line || t.category}`.trim();
function startTrains(v: SolidView, opts: Station3DOpenOptions, id: number) {
  classNow = myClass();
  aimedKey = '';
  trainStates = [opts.alight, opts.board].filter((t): t is Station3DTrain => !!t).map((t) => ({ train: t, shown: null, layout: null, target: [], plan: null, planned: t.mode !== 'train', hidden: false }));
  // the same track or stop for both (they are there one after the other): the one you take, until asked
  if (sameBerth()) trainStates[0].hidden = true;
  for (const st of trainStates) draw(v, st);
  overviewAgain(v);
  renderTrain();
  for (const st of trainStates) {
    if (st.train.mode !== 'train') continue;
    loadTrain(st.train, KANTE).then((shown) => {
      if (id !== seq || view !== v || !trainStates.includes(st)) return;
      st.shown = shown;
      applyTrains(false);
    });
    choose(v, st, id, false);
  }
}
// the coach for this ride (once per ride and class: the same at every station of it)
function choose(v: SolidView, st: TrainState, id: number, asked: boolean) {
  const cls = classNow;
  planCoach(st.train, planCtx()).then((plan) => {
    if (id !== seq || view !== v || !trainStates.includes(st) || cls !== classNow) return;
    st.plan = plan; st.planned = true;
    applyTrains(asked);
  });
}
function draw(v: SolidView, st: TrainState) {
  const t = st.train, end = endOf(t), s = st.shown, p = st.plan;
  const mine = p && (t.role === 'board' ? p.board : p.alight);
  st.target = mine ? [mine.idx] : [];
  const door = mine && mine.door;
  st.layout = v.setTrain!({
    role: t.role, kind: t.mode === 'train' ? 'train' : t.mode === 'tram' ? 'tram' : 'bus', ref: t.ref,
    coaches: s ? s.coaches : null, sectors: s ? s.sectors : sectorList(t.sectors), target: st.target, sector: door ? door.sector : null,
    crowd: s ? s.crowd : null, cls: classNow, door: door ? { xy: door.xy, inside: door.inside } : null,
    pose: t.mode === 'train' ? null : { uic: end.uic, ref: end.ref, ll: end.ll, heading: end.heading }, title: vehicleTitle(t),
  });
  // laid out for the card, not drawn
  if (st.hidden && v.clearTrain) v.clearTrain(t.role);
}
/** The vehicle you arrive in and the one you take stop at the same track (or tram or bus stop): drawn together, they
 *  would stand in each other. */
function sameBerth(): boolean {
  const a = trainStates.find((x) => x.train.role === 'alight'), b = trainStates.find((x) => x.train.role === 'board');
  if (!a || !b || a.train.mode !== b.train.mode) return false;
  const ea = a.train.alight, eb = b.train.board, pk = StationRoute.platformKey;
  if (a.train.mode === 'train') return !!ea.key && ea.key === eb.key && !!ea.ref && pk(ea.ref) === pk(eb.ref);
  return ea.uic === eb.uic && pk(ea.ref) === pk(eb.ref);
}
// draws every vehicle as it now is, and aims the way at the chosen doors: while you look at the whole way (not a
// floor you picked, and not in the middle of the steps unless you changed your class)
function applyTrains(asked: boolean) {
  const v = view;
  if (!v || !cur) return;
  for (const st of trainStates) draw(v, st);
  const at = (role: 'board' | 'alight') => {
    const st = trainStates.find((x) => x.train.role === role), p = st && st.plan;
    const mine = p && (role === 'board' ? p.board : p.alight), door = mine && mine.door;
    return st && door ? { stop: { uic: st.train.uic, ref: st.train.ref, at: door.xy, sector: door.sector } } : null;
  };
  const toDoor = at('board'), fromDoor = at('alight');
  const key = JSON.stringify([fromDoor, toDoor]);
  const from = cur.opts.from, to = cur.opts.to;
  if (key !== aimedKey && (toDoor || fromDoor) && from && to && lastChange.focusLevel == null && (lastChange.step < 0 || asked)) {
    aimedKey = key;
    // the ends keep their positions (a fallback for the router), the stop gains the door
    const aim = (e: Station3DEndpoint, door: { stop: StationRouteStopRef } | null) => (door ? ({ ...(e as object), ...door } as StationRouteEndpoint) : e);
    v.plan(aim(from, fromDoor), aim(to, toDoor), cur.opts.prefs || null);
    floorsRail();
    syncFloors();
  } else overviewAgain(v);
  renderTrain();
}
// the whole way framed again with the vehicles in it (the view framed the way alone when it opened)
function overviewAgain(v: SolidView) {
  if (trainStates.some((s) => s.layout && s.layout.cars.length) && v.route && lastChange.step < 0 && lastChange.focusLevel == null) v.whole();
}
const CROWD_TEXT: Record<TrainCrowd, string> = { 1: 'few people', 2: 'some people', 3: 'many people' };
function crowdPips(level: TrainCrowd, label: string) {
  const i = el('i', 'stv-crowd stv-crowd-' + level, el('s'), el('s'), el('s'));
  i.title = label;
  i.setAttribute('aria-hidden', 'true');
  return i;
}
function coachName(c: TrainCoach) {
  if (c.kind === 'loco') return 'Locomotive';
  if (c.kind === 'restaurant') return 'Restaurant';
  if (c.kind === 'sleeper') return 'Sleeping car';
  if (c.kind === 'luggage' || c.kind === 'other') return 'No seats';
  return c.cls === 12 ? '1st and 2nd class' : c.cls === 1 ? '1st class' : '2nd class';
}
const mins = (s: number) => (s < 45 ? 'under a minute' : `${Math.round(s / 60)} min`);
function classSwitch() {
  const seg = el('div', 'stv-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Your class');
  for (const c of [1, 2] as const) {
    const b = btn('stv-seg-b' + (classNow === c ? ' on' : ''), c === 1 ? '1st class' : '2nd class', () => {
      if (classNow === c || !view) return;
      classNow = c; setClass(c);
      // the coaches are chosen again for this class (each ride once); the walk follows
      for (const st of trainStates) if (st.train.mode === 'train') { st.planned = false; choose(view, st, seq, true); }
      renderTrain();
      // the card was drawn anew: the focus goes back to this button
      if (ui) { const again = ui.train.querySelector<HTMLButtonElement>(`.stv-seg-b[data-c="${c}"]`); if (again) again.focus({ preventScroll: true }); }
    }, c === 1 ? '1st' : '2nd');
    b.dataset.c = String(c);
    b.setAttribute('aria-pressed', classNow === c ? 'true' : 'false');
    seg.append(b);
  }
  return seg;
}
function renderTrain() {
  if (!ui) return;
  const box = ui.train;
  box.textContent = '';
  const cards = trainStates.map((st, i) => trainCard(st, i === trainStates.findIndex((x) => x.train.mode === 'train'))).filter(Boolean) as { el: HTMLElement; said: string }[];
  box.hidden = !cards.length;
  for (const c of cards) box.append(c.el);
  // for screen readers: what the cards now say (they are drawn anew each time)
  const said = cards.map((c) => c.said).join(' ');
  if (ui.trainLive.textContent !== said) ui.trainLive.textContent = said;
}
function trainCard(st: TrainState, withClass: boolean): { el: HTMLElement; said: string } | null {
  const t = st.train, s = st.shown, L = st.layout, p = st.plan, end = endOf(t), board = t.role === 'board';
  const card = el('div', 'stv-vehicle' + (board ? '' : ' alight'));
  const when = t.dep != null && board ? new Date((t.dep + (t.delayS || 0)) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '';
  const where = t.mode === 'train' ? `platform ${t.ref}` : t.ref ? `stop ${t.ref}` : end.name;
  card.append(el('div', 'stv-train-head', el('span', 'stv-kind stv-k-train', icon(t.mode === 'bus' ? 'bus' : t.mode === 'tram' ? 'tram' : 'train', 18)),
    el('div', 'stv-train-name', el('b', null, `${board ? '' : 'Arriving: '}${t.mode === 'train' ? (t.line || t.category) + (t.number ? ' · ' + t.number : '') : vehicleTitle(t)}`),
      el('small', null, `${t.headsign ? 'to ' + t.headsign + ' · ' : ''}${where}${when ? ' · ' + when : ''}`)),
    withClass ? classSwitch() : null));
  // one at a time on a shared track: this one is shown, or a button shows it instead of the other
  if (trainStates.length > 1 && trainStates.some((x) => x.hidden)) {
    const other = board ? 'the train you arrive in' : 'the one you take';
    const row = el('div', 'stv-berth', el('span', null, st.hidden ? `Same ${t.mode === 'train' ? 'track' : 'stop'} as ${other}: not drawn now.` : `Shown here; ${other} uses the same ${t.mode === 'train' ? 'track' : 'stop'}.`));
    if (st.hidden) row.append(btn('stv-btn stv-berth-b', `Show ${board ? 'the vehicle you take' : 'the vehicle you arrive in'} here`, () => {
      for (const x of trainStates) x.hidden = x !== st;
      applyTrains(false);
    }, 'Show it'));
    card.append(row);
  }
  const lines: (Node | string)[] = [];
  if (t.mode !== 'train') {
    lines.push(L && L.cars.length ? `A typical ${t.mode} is drawn at its stop: its shape and the exact place it stops are approximate.`
      : `Where the ${t.mode} stops is not known here (no direction of travel, or the stop is not in this station’s model).`);
    card.append(el('div', 'stv-train-text', ...lines));
    return { el: card, said: lines.join('') };
  }
  // the coaches as they stand, sector A on the left (coaches the model cannot place: in the formation's order)
  let cars: TrainCar[] = L ? L.cars.slice() : [];
  const unplaced = !cars.length && !!(s && s.coaches);
  if (unplaced) cars = s!.coaches!.map((c, idx) => ({ coach: c, idx, s0: 0, s1: 0, a: [0, 0], b: [0, 0], noseA: false, noseB: false }));
  const names = L ? L.sectors.map((x) => x.name) : [];
  if (names.length > 1 && names[0] > names[names.length - 1]) cars.reverse();
  const secOf = (s0: number, s1: number) => {
    const m = (s0 + s1) / 2, x = L && L.sectors.find((q) => m >= Math.min(q.s0, q.s1) && m <= Math.max(q.s0, q.s1));
    return x ? x.name : '';
  };
  const strip = el('div', 'stv-cars');
  strip.setAttribute('role', 'list');
  const tg = new Set(st.target);
  let lastSec = '';
  for (const car of cars) {
    const c = car.coach, on = !!c && tg.has(car.idx);
    const sec = c && c.sectors.length ? c.sectors[0] : secOf(car.s0, car.s1);
    const kids: (Node | string)[] = [];
    if (c && c.kind === 'coach') kids.push(c.cls === 12 ? '1|2' : String(c.cls));
    else if (c && c.kind === 'restaurant') kids.push(icon('food', 13));
    if (c && !c.closed && c.wheelchair) kids.push(icon('wheelchair', 11));
    else if (c && !c.closed && c.bike) kids.push(icon('bike', 11));
    else if (c && !c.closed && c.family) kids.push(icon('family', 11));
    const cls = 'stv-car' + (c ? ' k-' + c.kind + (c.cls ? ' c' + c.cls : '') + (c.closed ? ' closed' : '') : ' k-unknown')
      + (on ? ' on' : '') + (cars.indexOf(car) === 0 ? ' end-l' : '') + (cars.indexOf(car) === cars.length - 1 ? ' end-r' : '');
    const item = el('span', 'stv-car-w', el('span', cls, ...kids), el('small', 'stv-car-sec', sec !== lastSec ? sec : ''));
    item.setAttribute('role', 'listitem');
    const said = c ? [coachName(c), c.number ? 'coach ' + c.number : '', c.closed ? 'closed' : '', c.declassed && !c.closed ? 'open to all classes today' : '',
      c.wheelchair ? 'wheelchair spaces' : '', c.bike ? 'bikes' : '', c.family ? 'family zone' : '', c.goesTo ? 'goes to ' + c.goesTo : '',
      c.sectors.length ? 'sector ' + c.sectors.join(' and ') : '', on ? (board ? 'get on here' : 'you arrive in this coach') : '']
      : ['Coach', sec ? 'sector ' + sec : ''];
    item.setAttribute('aria-label', said.filter(Boolean).join(', '));
    lastSec = sec;
    strip.append(item);
  }
  if (cars.length) card.append(strip);
  // what it means
  const mine = p && (board ? p.board : p.alight);
  const coach = mine && s && s.coaches ? s.coaches[mine.idx] : null;
  const k = classNow === 1 ? '1st' : '2nd';
  if (!s || !st.planned) lines.push('Looking up the order of the coaches…');
  else if (coach && mine) {
    const sector = mine.door && mine.door.sector ? `sector ${mine.door.sector}` : coach.sectors.length ? `sector ${coach.sectors.join('–')}` : '';
    const name = coach.number ? `coach ${coach.number}` : 'this coach';
    if (board) {
      lines.push(el('b', null, `Get on ${name}${sector ? ' · ' + sector : ''}`), `: ${k} class${p!.board && coach.wheelchair && cur && cur.opts.prefs && cur.opts.prefs.wheelchair ? ', with wheelchair spaces' : ''}.`);
      const walk = [p!.board && p!.board.seconds != null ? `${mins(p!.board.seconds)} to its door here` : '',
        p!.alight && p!.alight.seconds != null ? `${mins(p!.alight.seconds)} from it at ${t.alight.name}` : ''].filter(Boolean);
      if (walk.length) lines.push(` The shortest walk: ${walk.join(' and ')}.`);
      if (coach.goesTo) lines.push(` The train splits on the way: this coach goes to ${coach.goesTo}.`);
    } else {
      lines.push(el('b', null, `You arrive in ${name}${sector ? ' · ' + sector : ''}`), ', the coach suggested where you got on' + (p!.alight && p!.alight.seconds != null ? `: ${mins(p!.alight.seconds)} from its door to where you go next.` : '.'));
    }
  } else if (p && p.missing && board) {
    const parts = [...new Set((s.coaches || []).map((c) => c.goesTo).filter(Boolean))];
    lines.push(el('b', null, 'No coach to suggest'), '. ' + (
      p.missing === 'portion' ? `The train splits on the way (to ${parts.join(' and ')}) and its data does not say which part stops at ${t.alight.name}: check the signs on the platform.`
        : p.missing === 'class' ? `No open ${k} class coach is listed for this train.`
          : p.missing === 'wheelchair' ? `No ${k} class coach with wheelchair spaces is listed for this train: ask the staff on the platform.`
            : p.missing === 'unmatched' ? `None of its ${k} class coaches is listed both here and at ${t.alight.name}.`
              : 'There is no way here to the doors of its coaches.') + ' The way leads to the platform.');
  } else if (unplaced) {
    lines.push('This station’s model does not have the sectors of this platform, so the coaches cannot be shown where they stop.');
  } else if (s.sectors.length) {
    const r = s.sectors.length > 1 ? `sectors ${s.sectors[0]}–${s.sectors[s.sectors.length - 1]}` : `sector ${s.sectors[0]}`;
    lines.push(el('b', null, `${board ? 'Stops' : 'Arrives'} in ${r}`), '. ' + (s.missing === 'nokey' ? 'The order of its coaches is not available here (the formation data needs a key on the engine).'
      : s.missing === 'failed' ? 'The order of its coaches could not be loaded.'
        : s.missing === 'unplaced' ? 'Its coaches are listed, but not where they stop at this platform.'
          : !board && s.coaches ? 'Which coach you are in is known only for a ride on one train from where you got on.' : 'No order of its coaches is published for this train.'));
  } else if (!cars.length) lines.push('Where on the platform it stops is not known.');
  if (lines.length) card.append(el('div', 'stv-train-text', ...lines));
  if (s && s.crowd) {
    const row = el('div', 'stv-train-crowd');
    for (const [kk, v] of [[1, s.crowd.first], [2, s.crowd.second]] as const) {
      if (!v) continue;
      row.append(el('span', 'stv-crowd-item' + (kk === classNow ? ' mine' : ''), crowdPips(v, CROWD_TEXT[v]), `${kk === 1 ? '1st' : '2nd'}: ${CROWD_TEXT[v]}`));
    }
    // one figure per class for the whole train: it cannot tell coaches apart, so the choice is by the walk alone
    row.append(el('small', null, board ? 'expected from here, for the whole train' : 'expected on this ride'));
    card.append(row);
  }
  card.append(el('div', 'stv-train-src', [s && s.coaches ? 'Coaches: Train Formation Service, opentransportdata.swiss' : 'Sectors: timetable',
    s && s.crowd ? 'occupancy forecast via transport.opendata.ch' : ''].filter(Boolean).join(' · ')));
  return { el: card, said: lines.map((x) => (typeof x === 'string' ? x : x.textContent || '')).join('') };
}

// ------------------------------------------------------------------ you
function renderYou(u: SolidUserState) {
  if (!ui || !view) return;
  const me = ui.guide.querySelector<HTMLButtonElement>('.stv-me');
  if (me) { me.hidden = !(u && u.visible); me.setAttribute('aria-pressed', u && u.follow ? 'true' : 'false'); me.classList.toggle('on', !!(u && u.follow)); }
  const probs = (u && u.visible && u.levelProbs) || {};
  for (const b of ui.floors.querySelectorAll<HTMLButtonElement>('.stv-floor[data-l]')) {
    const id = +b.dataset.l!, p = (probs as Record<string, number>)[id] || 0;
    b.style.setProperty('--p', p.toFixed(3));
    b.classList.toggle('here', !!(u && u.visible && u.level != null && Math.round(u.level) === id));
  }
  const t = ui.you;
  t.className = 'stv-you';
  if (!u || (!u.visible && !u.outside)) { t.textContent = ''; return; }
  if (u.outside) {
    t.className = 'stv-you off';
    t.textContent = `You’re about ${u.far! > 1500 ? (u.far! / 1000).toFixed(1) + ' km' : Math.round(u.far! / 50) * 50 + ' m'} from this station.`;
    return;
  }
  const acc = `±${Math.round(u.acc || 0)} m`;
  const top = Object.entries(probs).sort((a, b) => b[1] - a[1]).slice(0, 2).filter(([, p]) => p >= 0.05);
  if (u.level == null) {
    t.className = 'stv-you unsure';
    t.textContent = top.length > 1 ? `Floor unsure: ${top.map(([id, p]) => `${levelTag(+id)} ${Math.round(p * 100)} %`).join(' or ')} · ${acc}` : `Floor unknown · ${acc}`;
  } else if (u.levelProb != null && u.levelProb <= 0.6) {
    t.className = 'stv-you unsure';
    t.textContent = `Probably level ${levelTag(u.level)} (${Math.round(u.levelProb * 100)} %) · ${acc}`;
  } else t.textContent = `You: level ${levelTag(u.level)} · ${acc}${u.mode === 'route' ? ' · on the way' : ''}`;
}

export const StationView = {
  /** Is there a continuous model for this station key? (after `ready()`; false before) */
  has, ready,
  open,
  close: (): void => close3d(),
  isOpen: (): boolean => !!cur,
  setUser: (u: Station3DUser | null | undefined): void => {
    user = u || null; userAt = performance.now();
    if (view && view.setUser) view.setUser(user);
  },
  /** fn(detail) at every 'opening', 'open', 'close', 'step', 'done', 'error' of the view; returns what takes it off. */
  on: on as <K extends keyof Station3DEventMap>(name: K, fn: (detail: Station3DEventMap[K]) => void) => () => void,
  off: off as <K extends keyof Station3DEventMap>(name: K, fn: (detail: Station3DEventMap[K]) => void) => void,
  /** The model, its continuous companion, the router, the styles and three.js, ahead of an open. */
  preload: (key: string): Promise<boolean> => Promise.all([loadCss(), loadStation(key), loadRenderer()]).then(() => true, () => false),
  /** Tests: the open view. */
  _view: (): SolidView | null => view,
};
