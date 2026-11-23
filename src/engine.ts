// Client for the Kante engine (kante/ in this repository): the team's own journey planner, with exact
// boarding points, a multi-level walking network and live data. It is hosted at kante.omniroute.app.
// Journeys, departure boards and live data all come from here; there is no other timetable behind it.
//
// This is the one place that knows where the engine is and whether it is up:
//   - The address: APP_CONFIG.kanteUrl (config.js; '' switches it off), else the hosted engine. ?kante=off or
//     ?engine=off in the page address switches it off; ?kante=<url> picks an engine on this machine (localhost,
//     127.x, [::1]) for testing. Any other ?kante=<url> is ignored: what the page sends the engine says where you
//     look and where you are going, so a link must not choose who gets it.
//   - Whether it is up: a failed request (no answer, too slow, a server error, too many requests) marks it down;
//     any answer marks it up again. Nothing is held back while it is down: every caller asks at its own pace (the
//     live trips every 30 s, the vehicles every 15 s, the meta every RETRY_MS), so each attempt is a real request.
//   - What it has: /api/meta, asked once it can be reached, lists its optional features ('due', 'stream', …).
//
// Every call returns the engine's JSON, or throws a KanteError: off (no engine), down (the request failed) or
// refused (the engine answered no: 400, 404, 410 or 422, e.g. no route found or an unknown station). The responses
// are described in kante/engine/crates/server/src/json.rs and kante/docs/LIVE-API.md.
const DEFAULT_URL = 'https://kante.omniroute.app';
const RETRY_MS = 30000;

// A URL's origin (scheme, host, port), or null when it is not an http(s) URL
function originOf(u: string | null | undefined) {
  try {
    const x = new URL(String(u || '').trim());
    return /^https?:$/.test(x.protocol) ? x.origin : null;
  } catch (e) {
    return null;
  }
}
const isLocalUrl = (u: string | null | undefined) => /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(u || '');

// → { url (null = off), fromLink, ignored (a ?kante= link that was not followed) }
// A link may only switch the engine off, or point it at one on this machine (or the configured one): the engine
// learns where you are looking and where you are going, so a link must not pick someone else's.
function engineUrl(search?: string | null, config?: { kanteUrl?: unknown } | null): KanteEngineUrl {
  const sp = new URLSearchParams(search || '');
  if (sp.get('engine') === 'off') return { url: null, fromLink: true };
  const c = config && config.kanteUrl;
  const configured = c === '' || c === false || c === null ? null
    : (typeof c === 'string' && /^https?:\/\//i.test(c) ? c.trim() : DEFAULT_URL).replace(/\/+$/, '');
  const q = sp.get('kante');
  if (q != null) {
    if (/^(|off|none|0)$/i.test(q.trim())) return { url: null, fromLink: true };
    const o = originOf(q);
    if (o && isLocalUrl(o)) return { url: o, fromLink: true };
    if (o && configured && o === originOf(configured)) return { url: configured, fromLink: false };
    return { url: configured, fromLink: false, ignored: q };
  }
  return { url: configured, fromLink: false };
}

const { url, fromLink, ignored } = engineUrl(location.search, window.APP_CONFIG);
const BASE = url || '';
if (ignored) console.warn('Kante engine: ?kante= only accepts an engine on this machine; ignored', ignored);
let down = false;
let meta: KanteMeta | null = null, metaP: Promise<KanteMeta | null> | null = null, metaBusy = false, features = new Set<string>();

const available = () => !!BASE && !down;
const fail = (reason: KanteFailure, message: string, status?: number): KanteError => Object.assign(new Error(message), { reason, status });
const href = (path: string, params?: KanteParams | null) => {
  const qs = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '') as string[][]).toString() : '';
  return BASE + path + (qs ? '?' + qs : '');
};
// The statuses that mean the engine says no to this request; any other failure is a failed request
const NO = new Set([400, 404, 410, 422]);
// The engine answered (a refusal included): it is up, and its features are asked for if they are not known yet
function answered() {
  down = false;
  if (!meta && !metaBusy) setTimeout(ready, 0);
}

interface CallOptions { params?: KanteParams | null; body?: object; timeout?: number }
// The timeout covers the whole answer, its body included
async function call(path: string, { params, body, timeout = 8000 }: CallOptions = {}) {
  if (!BASE) throw fail('off', 'engine switched off');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    let res: Response;
    try {
      res = await fetch(href(path, params), {
        signal: ctl.signal,
        ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw fail('down', 'engine: ' + ((e as Error).message || 'no answer')); // offline, refused or too slow
    }
    if (NO.has(res.status)) { answered(); throw fail('refused', 'engine: HTTP ' + res.status, res.status); }
    if (!res.ok) throw fail('down', 'engine: HTTP ' + res.status, res.status); // 5xx, 429, …: failed, not a no
    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw fail('down', 'engine: ' + (ctl.signal.aborted ? 'too slow' : 'not JSON'));
    }
    answered();
    return data;
  } catch (e) {
    if ((e as KanteError).reason === 'down') down = true;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// The meta, once it has answered (null while the engine is off or can't be reached). Asked again by whoever
// calls this while it is not known (src/app/56-live-engine.ts: every RETRY_MS); force: also when it is known.
function ready(force?: boolean): Promise<KanteMeta | null> {
  if (!BASE) return Promise.resolve(null);
  if (meta && !force) return Promise.resolve(meta);
  if (metaBusy) return metaP!;
  metaBusy = true;
  metaP = call('/api/meta', { timeout: 4000 }).then((m: KanteMeta) => {
    meta = m && typeof m === 'object' ? m : meta;
    features = new Set((meta && Array.isArray(meta.features) && meta.features) || []);
    return meta;
  }, () => meta).finally(() => { metaBusy = false; });
  return metaP;
}

// Station ids: the engine uses "st:Parentch:1:sloid:7000", the rest of the app the UIC number 8507000.
// Swiss stations only; anything else gives null.
const uicOf = (stationId: string | null | undefined) => {
  const m = /^st:Parentch:1:sloid:(\d{1,5})$/.exec(stationId || '');
  return m ? String(8500000 + Number(m[1])) : null;
};
const stationIdOf = (uic: string | number) => {
  const n = Number(uic);
  return n > 8500000 && n < 8600000 ? 'st:Parentch:1:sloid:' + (n - 8500000) : null;
};

export const KANTE = {
  /** The engine's address without a trailing slash; '' when it is switched off. */
  base: BASE,
  /** The address came from the page's link (?kante=, ?engine=off). */
  fromLink,
  /** A ?kante= address in the link that was not followed (only an engine on this machine is). */
  ignored,
  /** ms between two tries of /api/meta while it cannot be reached (src/app/56-live-engine.ts). */
  RETRY_MS,
  /** Switched on, and its last request did not fail. */
  available,
  /** /api/meta has answered once (its features are known). */
  ok: (): boolean => !!meta,
  /** The engine's /api/meta: asked when it is not known yet (or with force), else the one it gave. null: off, or not reachable. */
  ready,
  /** Whether the engine has an optional part ('due', 'stream', …), by its /api/meta. */
  has: (f: string): boolean => features.has(f),
  /** Why a call threw: one of KanteFailure, or null for an error that did not come from a call. */
  failure: (e: unknown): KanteFailure | null => (e && typeof e === 'object' && 'reason' in e ? (e as KanteError).reason : null),
  /** The full address of a path, e.g. for an EventSource. Only with an engine (`base`). */
  href,
  /** "st:Parentch:1:sloid:7000" → "8507000"; null for anything but a Swiss station. */
  uicOf,
  /** 8507000 → "st:Parentch:1:sloid:7000"; null for anything but a Swiss UIC number. */
  stationIdOf,
  meta: (): Promise<KanteMeta> => call('/api/meta'),
  departures: (params: KanteDeparturesParams): Promise<KanteDeparturesResponse> => call('/api/departures', { params }), // { station | quay, time, limit }
  /** date: the trip's operating day, "2026-11-21". */
  trip: (id: string, date: string): Promise<KanteTrip> => call('/api/trip', { params: { id, date } }),
  vehicles: (params: KanteBboxParams): Promise<KanteVehiclesResponse> => call('/api/vehicles', { params }),
  /** What is about to stop at a place (kante/docs/LIVE-API.md); ms: the timeout. */
  due: (params: KanteParams, ms?: number): Promise<KanteDueResponse> => call('/api/due', { params, timeout: ms || 6000 }),
  plan: (body: KantePlanRequest): Promise<KantePlanResponse> => call('/api/plan', { body, timeout: 15000 }),
  walk: (body: KanteWalkRequest): Promise<KanteWalk> => call('/api/walk', { body }),
};
ready();
