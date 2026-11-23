// The 3D view of a station inside the app: the continuous model of station3d-solid.ts (one building at true heights,
// with the route as a tube and the floors above it cut open) in an overlay over the map, with the walk step by step.
// Loaded the first time a station is opened (the stand-in Station3D in station3d.ts sends its open() here), together
// with the station's model (stations3d/<key>.js), its continuous companion (stations3d/<key>.solid.js), the router
// (station-route.ts), station-view.css and three.js (the import map in index.html). docs/station3d-solid.md
//
//   StationView.open({ key, from, to, prefs, title, returnFocus })   as Station3D.open
//   StationView.close() · isOpen() · setUser(u) · on(name, fn) / off · preload(key) · has(key) after ready()
//
// Events as Station3D's (src/types/station3d.d.ts): 'opening', 'open', 'close', 'step', 'done', 'error'.
// indoornav.ts hears them through the stand-in, and feeds the position back with setUser (with the floor
// probabilities of the indoor filter).
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
  if (!rendererP) rendererP = (import('./station3d-solid.ts') as Promise<SolidModule>)
    .catch((e) => { rendererP = null; throw e; });
  return rendererP;
}
function loadStation(key: string): Promise<void> {
  const need: Promise<void>[] = [];
  if (!(window.STATION3D && window.STATION3D[key])) need.push(loadScript('stations3d/' + key + '.js'));
  if (!(window.STATION3D_SOLID && window.STATION3D_SOLID[key])) need.push(ready().then(() => loadScript(window.STATION3D_SOLID_INDEX![key].file)));
  need.push(import('./station-route.ts').then(() => {})); // the router (station3d-solid.ts routes with it)
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
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  alert: '<path d="M12 3l9.5 17H2.5z"/><path d="M12 10v4.5M12 17.5h.01"/>',
  me: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7.5"/>',
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
  notice: HTMLElement; guide: HTMLElement; state: HTMLElement; close: HTMLButtonElement;
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
  const state = el('div', 'stv-state');
  state.hidden = true;
  const mount = el('div', 'stv-canvas');
  mount.setAttribute('aria-hidden', 'true');
  const root = el('div', 'stv', mount, head, floors, el('div', 'stv-bottom', notice, guide), state);
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  return { root, mount, title, sub, you, floors, notice, guide, state, close };
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
    render();
    if (v.user) renderYou(v.user);
    emit('open', { key: opts.key, route: v.route, focus: null });
  }).catch((e: Error) => {
    console.warn(e);
    const three = /three|import|module|station3d-solid/i.test(String(e && (e.message || e)));
    fail(three ? 'three' : 'model', three ? 'Check your connection, then try again.' : 'This station\'s 3D model could not be loaded. Check your connection, then try again.');
  });
}
function close3d(fromHistory = false) {
  if (!cur && !view) return;
  seq++;
  if (view) { view.dispose(); view = null; }
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
    all.setAttribute('aria-pressed', 'false');
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
  } else {
    const s = r.steps[step];
    const row = el('div', 'stv-step' + (s.warn ? ' warn' : ''), stepIcon(s), el('div', 'stv-step-main', el('div', 'stv-text', s.text), el('div', 'stv-meta', stepMeta(s, step, n))));
    g.append(row);
    const nx = r.steps[step + 1];
    if (nx) g.append(el('div', 'stv-then', 'Then: ', el('span', null, nx.text)));
    bar.append(btn('stv-btn', 'Previous step', () => goStep(step - 1), '‹'));
    bar.append(step < n - 1 ? btn('stv-btn stv-primary', null, () => goStep(step + 1), 'Next ›')
      : btn('stv-btn stv-primary', null, () => emit('done', { route: r }), 'Done'));
  }
  bar.append(el('span', 'stv-grow'));
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
function endName(r: StationRouteResult) {
  const s = r.toStop, to = cur && cur.opts.to;
  if (s && s.mode === 'train' && s.ref) return `platform ${s.ref}${r.toSectors && r.toSectors.length ? ', sector ' + r.toSectors.join('–') : ''}`;
  if (to && to.label) return to.label;
  if (s) return `the ${s.mode === 'tram' ? 'tram' : s.mode === 'bus' ? 'bus' : ''} stop`.replace('the  stop', 'the stop');
  return 'the destination';
}

// ------------------------------------------------------------------ you
function renderYou(u: SolidUserState) {
  if (!ui || !view) return;
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
