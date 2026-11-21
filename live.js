// Live data from the Kante engine (kante/docs/LIVE-API.md): measured and forecast stop times, where a vehicle is
// and how sure that is. The journey itself is still planned with transport.opendata.ch; this only makes the live
// part better, and index.html keeps doing what it did before when the engine (or one of its features) is missing.
//
// Engine address: ?kante=<url> in the page address (for testing; ?kante=off switches it off), else
// APP_CONFIG.kanteUrl (config.js; '' switches it off), else the hosted engine.
//
// The helpers below are plain functions without the DOM, so tools can test them with Node (module.exports).
(function (root) {
  const DEFAULT_URL = 'https://kante.omniroute.app';
  const MAX_BBOX_KM = 120; // the engine refuses larger boxes (diagonal)

  // → { url (null = off), fromLink }
  function engineUrl(search, config) {
    const q = new URLSearchParams(search || '').get('kante');
    if (q != null) {
      if (/^(|off|none|0)$/i.test(q.trim())) return { url: null, fromLink: true };
      if (/^https?:\/\/[^/\s]+/i.test(q)) return { url: q.trim().replace(/\/+$/, ''), fromLink: true };
    }
    const c = config && config.kanteUrl;
    if (c === '' || c === false || c === null) return { url: null, fromLink: false };
    return { url: (typeof c === 'string' && /^https?:\/\//i.test(c) ? c : DEFAULT_URL).replace(/\/+$/, ''), fromLink: false };
  }
  const isLocalUrl = (u) => /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(u || '');

  // ---- Talking to the engine: /api/meta once, then GET/POST with a timeout; any failure is just null ----
  function client(search, config) {
    const { url, fromLink } = engineUrl(search, config);
    let meta = null, features = new Set(), metaP = null;
    const href = (path, params) => {
      const qs = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString() : '';
      return url + path + (qs ? '?' + qs : '');
    };
    async function call(path, params, init, ms) {
      if (!url) return null;
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctl && setTimeout(() => ctl.abort(), ms || 8000);
      try {
        const res = await fetch(href(path, params), { ...init, signal: ctl && ctl.signal });
        return res.ok ? await res.json() : null;
      } catch (e) {
        return null; // offline, refused, timed out, not JSON: as if there were no engine
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    function ready() {
      if (!metaP) {
        metaP = call('/api/meta', null, {}, 4000).then((m) => {
          meta = m && typeof m === 'object' ? m : null;
          features = new Set((meta && Array.isArray(meta.features) && meta.features) || []);
          return meta;
        });
      }
      return metaP;
    }
    return {
      url,
      fromLink,
      // your position (on-board checks and reports) only goes to the configured engine, or one on this machine:
      // never to one a link picked
      trusted: !!url && (!fromLink || isLocalUrl(url)),
      ready,
      ok: () => !!meta,
      has: (f) => features.has(f),
      href,
      get: (path, params, ms) => call(path, params, {}, ms),
      post: (path, body) => call(path, null, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 8000),
    };
  }

  // ---- Matching a ride planned with transport.opendata.ch (a "section") to the engine's trip ----
  const unixOf = (stop, which) => {
    if (!stop) return null;
    if (stop[which + 'Timestamp'] != null) return Number(stop[which + 'Timestamp']);
    const t = stop[which] ? Date.parse(stop[which]) : NaN;
    return Number.isFinite(t) ? Math.round(t / 1000) : null;
  };
  // label: the line as the app shows it ("S1", "IC 8", "10"); train: whether it is a train (its journey "name"
  // is then the train number, e.g. "015249")
  function matchParams(s, label, train) {
    const j = s.journey || {};
    const p = { from: s.departure.station.id, dep: unixOf(s.departure, 'departure'), to: s.arrival.station.id, arr: unixOf(s.arrival, 'arrival') };
    if (label) p.line = label;
    if (train && /^\d+$/.test(j.name || '')) p.number = String(j.name).replace(/^0+(?=\d)/, '');
    return p;
  }

  // liveInfo from the new API, or the old API's "live" word
  function liveInfoOf(x) {
    if (!x) return null;
    if (x.liveInfo && typeof x.liveInfo === 'object') return x.liveInfo;
    return typeof x.live === 'string' ? { state: x.live } : null;
  }
  // Live times only count when they are live and recent
  const isLive = (info) => !!info && (info.state === 'observed' || info.state === 'predicted');

  // A call's live times (unix s): the timetable plus the delay
  const liveArr = (c) => (c && c.arr != null ? c.arr + (c.arrDelayS || 0) : c && c.dep != null ? c.dep + (c.depDelayS || 0) : null);
  const liveDep = (c) => (c && c.dep != null ? c.dep + (c.depDelayS || 0) : liveArr(c));
  const iso = (sec) => new Date(sec * 1000).toISOString();
  const platNum = (p) => { const m = /^\s*(\d+)/.exec(p || ''); return m ? m[1] : String(p || '').trim().toUpperCase(); };
  const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

  // The calls of the ride, by place in the journey's passList (null where it can't be told)
  function callsForPassList(trip, match, passList) {
    const calls = new Map((trip.calls || []).map((c) => [c.seq, c]));
    const n = match.toSeq - match.fromSeq + 1;
    const list = passList || [];
    if (list.length === n) return list.map((_, k) => calls.get(match.fromSeq + k) || null);
    // a different number of stops: pair them by name, in order
    let next = match.fromSeq;
    return list.map((x) => {
      const name = norm(x.station && x.station.name);
      for (let q = next; q <= match.toSeq; q++) {
        const c = calls.get(q);
        if (c && c.quay && norm(c.quay.stationName) === name) { next = q + 1; return c; }
      }
      return null;
    });
  }

  // Write the engine's live times and platform into the section's "prognosis", the way transport.opendata.ch
  // gives them, so the rest of the app reads them as it always has. Nothing is written without live data.
  // → true when the engine had live data for it
  function applyTrip(s, trip, match) {
    const info = liveInfoOf(trip);
    if (!trip || !isLive(info)) return false;
    const calls = new Map((trip.calls || []).map((c) => [c.seq, c]));
    const set = (stop, c, which) => {
      if (!stop || !c) return;
      const p = { ...(stop.prognosis || {}) };
      const delay = which === 'departure' ? c.depDelayS : c.arrDelayS;
      const t = which === 'departure' ? liveDep(c) : liveArr(c);
      if (delay != null && t != null) { p[which] = iso(t); stop.delay = Math.round(delay / 60); }
      // a changed platform; only when its number differs too ("7" and "7AB" are the same platform)
      if (c.plannedLabel && c.quay && c.quay.label && platNum(c.quay.label) !== platNum(stop.platform)) p.platform = c.quay.label;
      stop.prognosis = p;
    };
    set(s.departure, calls.get(match.fromSeq), 'departure');
    set(s.arrival, calls.get(match.toSeq), 'arrival');
    const list = (s.journey && s.journey.passList) || [];
    callsForPassList(trip, match, list).forEach((c, k) => {
      if (!c) return;
      const x = list[k], p = { ...(x.prognosis || {}) };
      if (c.arrDelayS != null && c.arr != null) p.arrival = iso(liveArr(c));
      if (c.depDelayS != null && c.dep != null) p.departure = iso(liveDep(c));
      x.prognosis = p;
    });
    return true;
  }

  // ---- Where the vehicle is now, from the engine's position at time t: carried forward by the live times
  //      between its stops, so it keeps moving between two answers. now in unix seconds. ----
  function advance(pos, calls, now) {
    if (!pos || pos.seq == null) return null;
    const by = new Map((calls || []).map((c) => [c.seq, c]));
    const seg = (seq) => {
      const d = liveDep(by.get(seq)), a = liveArr(by.get(seq + 1));
      return d != null && a != null ? { d, a } : null;
    };
    if (pos.state === 'between') {
      const g = seg(pos.seq), dt = now - (pos.t != null ? pos.t : now);
      let frac = Number(pos.frac) || 0;
      if (g && g.a > g.d) frac += dt / (g.a - g.d);
      return { ...pos, frac: Math.min(1, Math.max(0, frac)) };
    }
    if (pos.state === 'at') {
      const g = seg(pos.seq);
      if (g && now > g.d && g.a > g.d) return { ...pos, state: 'between', frac: Math.min(1, (now - g.d) / (g.a - g.d)) };
      return { ...pos };
    }
    return { ...pos };
  }
  // …as km along the drawn ride: kms = each drawn stop's km, stopIdx = each drawn stop's place in the passList.
  // → { km, at } (index into the passList) or { km, from, to }, or null when it isn't on this part of the trip
  function rideKm(p, match, kms, stopIdx) {
    if (!p || !match || (p.state !== 'at' && p.state !== 'between')) return null;
    const k = p.seq - match.fromSeq, last = match.toSeq - match.fromSeq;
    if (k < 0 || k > last || (p.state === 'between' && k >= last)) return null;
    const m = stopIdx.indexOf(k);
    if (m < 0 || kms[m] == null) return null;
    if (p.state === 'at') return { km: kms[m], at: k };
    const m2 = stopIdx.indexOf(k + 1);
    if (m2 < 0 || kms[m2] == null) return null;
    return { km: kms[m] + (kms[m2] - kms[m]) * Math.min(1, Math.max(0, p.frac || 0)), from: k, to: k + 1 };
  }

  // ---- Saying honestly how a position was worked out. ctx: { basis, from, leftS (seconds since a measured
  //      departure from `from`), observedAt (stop with the last measured time) } → { text, dim } ----
  const ago = (s) => (s < 60 ? 'just now' : `${Math.round(s / 60)} min ago`);
  function liveText(info, ctx) {
    const c = ctx || {}, state = (info && info.state) || 'timetable';
    let text;
    if (state === 'stale') text = 'Live data is out of date: estimated from older times';
    else if (c.basis === 'timetable' || state === 'timetable') text = 'Timetable only, no live data';
    else if (c.basis === 'crowd') text = 'Corrected by reports from passengers on board';
    else if (state === 'observed' || c.basis === 'observed-stop') {
      text = c.leftS != null && c.from ? `Left ${c.from} ${ago(c.leftS)} (measured)`
        : c.observedAt ? `Estimated from a time measured at ${c.observedAt}` : 'Estimated from a measured time';
    } else text = 'Estimated from forecasts';
    const notes = [];
    if (info && info.inaccurate) notes.push('the operator says this forecast is unreliable');
    if (info && info.congestion) notes.push('in a traffic jam');
    return { text: notes.length ? `${text} · ${notes.join(' · ')}` : text, dim: state === 'stale' || state === 'timetable' };
  }

  // ---- On board: is the traveller on the planned vehicle? cands: /api/onboard's, best first.
  //      mine: { tripId (null without a match), line ("S1"), headsign }. → { ours, byTrip, top, clear } ----
  const sameLine = (a, b) => !!a && !!b && norm(a) === norm(b);
  function onboardVerdict(cands, mine) {
    const list = cands || [];
    const isMine = (c) => (mine.tripId ? c.tripId === mine.tripId : sameLine(c.line && c.line.name, mine.line));
    const ours = list.some(isMine);
    const top = list[0] || null;
    if (ours || !top) return { ours, byTrip: ours && !!mine.tripId, top: null, clear: false };
    // another line, or the same line the other way
    const other = !sameLine(top.line && top.line.name, mine.line) || (!!mine.headsign && !!top.headsign && norm(top.headsign) !== norm(mine.headsign));
    const twin = (c) => c.tripId === top.tripId || (sameLine(c.line && c.line.name, top.line && top.line.name) && norm(c.headsign) === norm(top.headsign));
    const second = list.slice(1).find((c) => !twin(c));
    const clear = other && (!second || second.distM >= top.distM * 2 + 150);
    return { ours: false, byTrip: false, top, clear };
  }

  // ---- Run or wait: seconds until it leaves, seconds of walking left → { text, level } ----
  function runOrWait(leftS, walkS) {
    const spare = leftS - walkS;
    if (spare < 0) return { text: `Hurry: about ${Math.max(1, Math.round(-spare / 60))} min short`, level: 'late' };
    const m = Math.floor(spare / 60);
    if (spare < 180) return { text: `Hurry: ${m < 1 ? 'less than 1 min' : m + ' min'} to spare`, level: 'tight' };
    return { text: `Take your time: ${m} min to spare`, level: 'ok' };
  }

  // ---- Vehicles on the map ----
  // The engine's line ({ name: "IR15", category: "IR", operator }) as the journey object the app colours lines by
  function journeyLike(line) {
    const l = line || {}, cat = String(l.category || ''), name = String(l.name || '');
    const num = cat && name.toUpperCase().startsWith(cat.toUpperCase()) ? name.slice(cat.length).trim() : name;
    return { category: cat, number: num || name, operator: l.operator || '', name };
  }
  // Where it is at `now` (unix s): from `from` to `to` in proportion to time between dep and arr
  function vehicleAt(v, now) {
    const span = v.arr - v.dep;
    const f = span > 0 ? Math.min(1, Math.max(0, (now - v.dep) / span)) : now >= v.arr ? 1 : 0;
    return [v.from[0] + (v.to[0] - v.from[0]) * f, v.from[1] + (v.to[1] - v.from[1]) * f];
  }
  function distKm(a, b) {
    const R = 6371, r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLng = (b[0] - a[0]) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  // [w, s, e, n] grown by a share of its size on every side, kept within the engine's limit
  function padBbox(b, share) {
    let [w, s, e, n] = b;
    const dx = (e - w) * share, dy = (n - s) * share;
    w -= dx; e += dx; s -= dy; n += dy;
    for (let k = 0; k < 20 && distKm([w, s], [e, n]) > MAX_BBOX_KM * 0.95; k++) {
      const cx = (w + e) / 2, cy = (s + n) / 2;
      w = cx - (cx - w) * 0.8; e = cx + (e - cx) * 0.8; s = cy - (cy - s) * 0.8; n = cy + (n - cy) * 0.8;
    }
    return [w, s, e, n];
  }
  const bboxContains = (o, i) => !!o && i[0] >= o[0] && i[1] >= o[1] && i[2] <= o[2] && i[3] <= o[3];
  const bboxOk = (b) => distKm([b[0], b[1]], [b[2], b[3]]) <= MAX_BBOX_KM;
  const bboxParam = (b) => b.map((x) => x.toFixed(5)).join(',');

  const KANTE = {
    DEFAULT_URL, MAX_BBOX_KM, engineUrl, isLocalUrl, client, unixOf, matchParams, liveInfoOf, isLive, liveArr, liveDep,
    callsForPassList, applyTrip, advance, rideKm, liveText, onboardVerdict, runOrWait, journeyLike, vehicleAt,
    padBbox, bboxContains, bboxOk, bboxParam, distKm, norm,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = KANTE;
  else root.KANTE = KANTE;
})(typeof window !== 'undefined' ? window : this);
