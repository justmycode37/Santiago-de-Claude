// Station3D is the page's one way into a station in 3D. Behind it is the station view (station-view.ts,
// docs/station3d-solid.md): the continuous model of the inside of the station (station3d-solid.ts) in an overlay over
// the map, with the walk step by step. It is loaded (import()) the first time it is needed, not at start-up; until
// then this stand-in keeps the listeners and the latest GPS fix for it.
// Drawing a station's walk on the 2D map does not need it: loadData() loads just the model and the router.
// The indoor position (indoorloc.ts, signloc.ts, indoornav.ts) loads at the first opening and never holds anything
// up: when it arrives it joins the opening that is showing then. If those three fail, the view works without them
// and they are tried again at the next opening.
import { showToast } from './toast.ts';
import type { INDOORLOC } from './indoorloc.ts';
import type { SIGNLOC } from './signloc.ts';
import type { INDOORNAV } from './indoornav.ts';
import type { StationView } from './station-view.ts';
import type { StationRoute } from './station-route.ts';

type Heard = [name: keyof Station3DEventMap, fn: (detail: never) => void];
type Opened = Station3DEventMap['open'];
type AnyFn = (detail: unknown) => void;

/** The indoor position's modules, each once it has loaded (Scan reads signs with signloc's parser once it is there). */
export const indoor: { loc: typeof INDOORLOC | null; sign: typeof SIGNLOC | null; nav: typeof INDOORNAV | null } = { loc: null, sign: null, nav: null };
let view: typeof StationView | null = null;   // the station view, once it has loaded and started
let router: typeof StationRoute | null = null; // the station router (station-route.ts), once it has loaded
/** The station router, once loadData() (or the view) has loaded it; null before. */
export const stationRouter = () => router;

let indoorP: Promise<void> | null = null, svLoading: Promise<typeof StationView> | null = null;
let user: Station3DUser | null | undefined, userAt = 0;   // the latest GPS fix and when it came (performance.now())
let wanted: Station3DOpenOptions | null = null;      // the latest open() asked for while the view loads (close() cancels it)
let lastOpen: Opened | null = null;    // what the view last opened (for the indoor position when it arrives later)
const listeners: Heard[] = [];         // every listener, for the view once it has loaded
const scans: ScanTextDetail[] = [];    // text Scan read before the indoor modules were there: { text, at }
const onScan = (e: CustomEvent<ScanTextDetail>) => { if (!indoor.nav && e.detail && e.detail.text) scans.push({ text: e.detail.text, at: e.detail.at || Date.now() }); };
window.addEventListener('scan:text', onScan as EventListener);
// the station models (generated data): plain scripts that put themselves on window
const script = (src: string) => new Promise<unknown>((resolve, reject) => {
  const s = document.createElement('script');
  s.src = src;
  s.onload = resolve;
  s.onerror = () => { s.remove(); reject(new Error('Could not load ' + src)); };
  document.head.appendChild(s);
});
const once = new Map<string, Promise<unknown>>();
const scriptOnce = (src: string) => {
  if (!once.has(src)) once.set(src, script(src).catch((e) => { once.delete(src); throw e; }));
  return once.get(src)!;
};
const loadRouter = () => import('./station-route.ts').then((m) => { router = m.StationRoute; });
// a remembered fix is handed on only while it is recent (u.at: when it was taken); an older one would show as
// where you are now
const recent = (u: Station3DUser | null) => !u || u.at == null || Date.now() - u.at < 60e3;
const svOpen = () => !!(view && view.isOpen());
function loadIndoor() {
  if (!indoorP) indoorP = Promise.all([indoor.loc ? null : import('./indoorloc.ts').then((m) => { indoor.loc = m.INDOORLOC; }),
    indoor.sign ? null : import('./signloc.ts').then((m) => { indoor.sign = m.SIGNLOC; })])
    .then(() => (indoor.nav ? null : import('./indoornav.ts').then((m) => { indoor.nav = m.INDOORNAV; })))
    .then(() => {
      // what the stand-in kept: the latest GPS fix (with its own time, so indoornav.ts keeps a newer one it
      // may already have), and signs read before (they still count if recent)
      if (user !== undefined && recent(user) && indoor.nav) indoor.nav.setUser(user, userAt);
      window.removeEventListener('scan:text', onScan as EventListener);
      for (const s of scans.splice(0)) window.dispatchEvent(new CustomEvent('scan:text', { detail: s }));
      // the view opened before these modules were there: the indoor position joins the opening showing now
      // (the latest one: a station closed meanwhile is not attached)
      if (indoor.nav && lastOpen && svOpen()) indoor.nav.attach(lastOpen);
    })
    .catch((e) => {
      // not fatal: the view works without it, and the next opening tries again
      indoorP = null;
      console.warn(e.message);
    });
  return indoorP;
}
function loadView(): Promise<typeof StationView> {
  if (!svLoading) svLoading = import('./station-view.ts').then((m) => {
    const sv = view = m.StationView;
    for (const [name, fn] of listeners) sv.on(name, fn as AnyFn);
    // the indoor position follows what the view shows
    sv.on('open', (info) => { lastOpen = info; if (!indoor.nav) loadIndoor(); });
    sv.on('close', () => { lastOpen = null; });
    // another station on its way (it replaces the one showing without a 'close'): only its own 'open' counts
    sv.on('opening', () => { lastOpen = null; });
    if (user !== undefined && recent(user)) sv.setUser(user);
    return sv;
  }).catch((e) => { svLoading = null; throw e; });
  return svLoading;
}
function failed(opts: Station3DOpenOptions, err: Station3DEventMap['error'] = { code: 'three', message: 'Check your connection, then try again.' }) {
  if (wanted !== opts) return;   // closed or replaced meanwhile: nobody is waiting for this one
  wanted = null;
  showToast(err.code === 'none' ? 'There is no 3D view of this station.' : 'The 3D view could not be loaded.');
  // as the view itself reports it (Station3D.on('error'))
  for (const [name, fn] of listeners.slice()) if (name === 'error') { try { fn(err as never); } catch (e) { console.error(e); } }
}
export const Station3D = {
  /** A stop id → the key of the model that has it. */
  has: (uic: string | number): string | null => (window.STATION3D_INDEX && window.STATION3D_INDEX[String(uic)]) || null,
  open: (opts: Station3DOpenOptions): void => {
    wanted = opts;
    loadView().then((sv) => sv.ready().then(() => sv)).then((sv) => {
      if (wanted !== opts) return;
      if (!sv.has(opts.key)) { failed(opts, { code: 'none', message: 'There is no 3D view of this station.' }); return; }
      wanted = null;
      sv.open(opts);
      loadIndoor();
    }, () => failed(opts));
  },
  setUser: (u: Station3DUser | null | undefined): void => { user = u || null; userAt = performance.now(); if (view) view.setUser(u); },
  close: (): void => { wanted = null; if (svOpen()) view!.close(); },
  /** Also true while an opening is on its way. */
  isOpen: (): boolean => wanted !== null || svOpen(),   // an opening is on its way: callers that close an open view cancel it
  /** Returns a function that removes the listener again. */
  on: <K extends keyof Station3DEventMap>(name: K, fn: (detail: Station3DEventMap[K]) => void): () => void => {
    listeners.push([name, fn as (detail: never) => void]);
    if (view && svLoading) view.on(name, fn);
    return () => Station3D.off(name, fn);
  },
  off: <K extends keyof Station3DEventMap>(name: K, fn: (detail: Station3DEventMap[K]) => void): void => {
    const i = listeners.findIndex(([n, f]) => n === name && f === fn);
    if (i >= 0) listeners.splice(i, 1);
    if (view) view.off(name, fn);
  },
  // ahead of an open: the station view with this station, and the indoor position alongside (not waited for), so
  // it is ready when the view opens
  preload: (key?: string | null): Promise<boolean> => {
    loadIndoor();
    return loadView().then((sv) => sv.ready().then(() => (key && sv.has(key) ? sv.preload(key) : false))).catch(() => false);
  },
  // the model and the router (no 3D): for a station's walk on the 2D map
  loadData: (key: string): Promise<StationModel | null> => {
    if (!/^[a-z0-9-]+$/.test(String(key))) return Promise.resolve(null);
    const have = () => window.STATION3D && window.STATION3D[key];
    return Promise.all([have() ? null : scriptOnce('stations3d/' + key + '.js'), router ? null : loadRouter()])
      .then(() => (have() && router ? have()! : null), () => null);
  },
};
