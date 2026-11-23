// Client for the Kante engine (kante/ in this repository): the team's own journey planner, with exact
// boarding points, a multi-level walking network and live data. It is hosted at kante.omniroute.app.
// Journeys, departure boards and live data all come from here; there is no other timetable behind it.
//
// This is the one place that knows where the engine is and whether it is up:
//   - The address: APP_CONFIG.kanteUrl (config.js; '' switches it off), else the hosted engine. ?kante=off or
//     ?engine=off in the page address switches it off; ?kante=<url> picks an engine on this machine (localhost,
//     127.x, [::1]) for testing. Any other ?kante=<url> is ignored: what the page sends the engine says where you
//     look and where you are going, so a link must not choose who gets it.
//   - Whether it is up: after a failed call (no answer, a server error, too slow) it counts as down for RETRY_MS,
//     so what runs by itself (live data, vehicles, the meta) does not keep asking. What the traveller asks for
//     (a journey, a departure board, a walk) still tries; any answer brings the engine back up, and ready(true) does.
//   - What it has: /api/meta, asked once it can be reached, lists its optional features ('due', 'stream', …).
//
// Every call returns the engine's JSON, or throws a KanteError (reason off, down or refused). The responses are
// described in kante/engine/crates/server/src/json.rs and kante/docs/LIVE-API.md.
(function () {
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
  let downUntil = 0;
  let meta: KanteMeta | null = null, metaP: Promise<KanteMeta | null> | null = null, metaBusy = false, features = new Set<string>();

  const available = () => !!BASE && Date.now() >= downUntil;
  const fail = (reason: KanteFailure, message: string, status?: number): KanteError => Object.assign(new Error(message), { reason, status });
  const href = (path: string, params?: KanteParams | null) => {
    const qs = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '') as string[][]).toString() : '';
    return BASE + path + (qs ? '?' + qs : '');
  };

  // asked: the traveller is waiting for this answer (a journey, a board), so it is tried even while the engine
  // counts as down; everything else gives up at once then
  interface CallOptions { params?: KanteParams | null; body?: object; timeout?: number; asked?: boolean }
  async function call(path: string, { params, body, timeout = 8000, asked }: CallOptions = {}) {
    if (!BASE) throw fail('off', 'engine switched off');
    if (!asked && !available()) throw fail('down', 'engine unavailable');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    let res: Response;
    try {
      res = await fetch(href(path, params), {
        signal: ctl.signal,
        ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      downUntil = Date.now() + RETRY_MS; // offline, refused or too slow
      throw fail('down', 'engine: ' + ((e as Error).message || 'no answer'));
    } finally {
      clearTimeout(timer);
    }
    // 4xx is the engine saying no to this request (for example no route found): it is still up
    if (res.status >= 500) { downUntil = Date.now() + RETRY_MS; throw fail('down', 'engine: HTTP ' + res.status, res.status); }
    if (!res.ok) throw fail('refused', 'engine: HTTP ' + res.status, res.status);
    let data;
    try {
      data = await res.json();
    } catch (e) {
      downUntil = Date.now() + RETRY_MS;
      throw fail('down', 'engine: not JSON');
    }
    const wasDown = !available();
    downUntil = 0; // it answers: up
    if (wasDown || !meta) setTimeout(ready, 0); // its features, if they are not known yet
    return data;
  }

  // The meta, once it has answered (null while the engine is off or can't be reached). A failure is asked again
  // once RETRY_MS have passed, or at once with force (the engine then no longer counts as down).
  function ready(force?: boolean): Promise<KanteMeta | null> {
    if (!BASE) return Promise.resolve(null);
    if (force) downUntil = 0;
    if (meta) return Promise.resolve(meta);
    if (metaBusy || (metaP && !force && !available())) return metaP!;
    metaBusy = true;
    metaP = call('/api/meta', { timeout: 4000 }).then((m: KanteMeta) => {
      meta = m && typeof m === 'object' ? m : null;
      features = new Set((meta && Array.isArray(meta.features) && meta.features) || []);
      return meta;
    }, () => null).finally(() => { metaBusy = false; });
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

  window.KANTE = {
    base: BASE,
    fromLink,
    ignored,
    RETRY_MS,
    available,
    ok: () => !!meta && available(),
    ready,
    has: (f) => features.has(f),
    failure: (e) => (e && typeof e === 'object' && 'reason' in e ? (e as KanteError).reason : null),
    href,
    uicOf,
    stationIdOf,
    meta: () => call('/api/meta'),
    departures: (params) => call('/api/departures', { params, asked: true }), // { station | quay, time, limit }
    trip: (id, date) => call('/api/trip', { params: { id, date } }),
    vehicles: (params) => call('/api/vehicles', { params }),
    due: (params, ms) => call('/api/due', { params, timeout: ms || 6000 }),
    plan: (body) => call('/api/plan', { body, timeout: 15000, asked: true }),
    walk: (body) => call('/api/walk', { body }),
  };
  ready();
})();
