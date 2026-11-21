// Client for the Kante engine (kante/ in this repository): the team's own journey planner, with exact
// boarding points, a multi-level walking network and live data. It is hosted at kante.omniroute.app.
//
// Every call returns the engine's JSON, or throws when the engine cannot be reached, answers with an
// error or takes too long. Callers catch that and fall back to what the app used before
// (transport.opendata.ch, the public OpenStreetMap routers), so the app keeps working without the engine.
// After a failure the engine counts as down for a minute, so the fallback does not wait each time.
//
// The address comes from config.js (window.APP_CONFIG.kanteUrl); '' switches the engine off, and so
// does opening the app with ?engine=off. The responses are described in kante/engine/crates/server/src/json.rs.
(function () {
  const cfg = window.APP_CONFIG || {};
  const off = new URLSearchParams(location.search).get('engine') === 'off';
  const BASE = off ? '' : String(cfg.kanteUrl == null ? 'https://kante.omniroute.app' : cfg.kanteUrl).replace(/\/+$/, '');
  const RETRY_MS = 60000;
  let downUntil = 0;

  const available = () => !!BASE && Date.now() >= downUntil;

  interface CallOptions { params?: KanteParams; body?: object; timeout?: number }
  async function call(path: string, { params, body, timeout = 8000 }: CallOptions = {}) {
    if (!available()) throw new Error('engine unavailable');
    const qs = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '') as string[][]) : '';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(BASE + path + qs, {
        signal: ctl.signal,
        ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      // 4xx is the engine saying no to this request (for example no route found): it is still up
      if (res.status >= 500) downUntil = Date.now() + RETRY_MS;
      if (!res.ok) throw Object.assign(new Error('engine: HTTP ' + res.status), { status: res.status });
      return await res.json();
    } catch (e) {
      if (!(e as { status?: number }).status) downUntil = Date.now() + RETRY_MS; // network error or timeout
      throw e;
    } finally {
      clearTimeout(timer);
    }
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
    available,
    uicOf,
    stationIdOf,
    meta: () => call('/api/meta'),
    search: (q, near) => call('/api/search', { params: { q, lat: near && near.lat, lon: near && near.lon } }),
    nearby: (lat, lon, opts) => call('/api/nearby', { params: { lat, lon, ...opts } }),
    reverse: (lat, lon) => call('/api/reverse', { params: { lat, lon } }),
    quays: (params) => call('/api/quays', { params }),
    departures: (params) => call('/api/departures', { params }), // { station | quay, time, limit }
    trip: (id, date) => call('/api/trip', { params: { id, date } }),
    vehicles: (params) => call('/api/vehicles', { params }),
    onboard: (params) => call('/api/onboard', { params }),
    indoor: (params) => call('/api/indoor', { params }),
    plan: (body) => call('/api/plan', { body, timeout: 15000 }),
    walk: (body) => call('/api/walk', { body }),
  };
})();
