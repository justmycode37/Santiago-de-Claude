// Live data from the Kante engine (kante/docs/LIVE-API.md): measured and forecast stop times, where a vehicle is
// and how sure that is. The journey itself is still planned with transport.opendata.ch; this only makes the live
// part better, and index.html keeps doing what it did before when the engine (or one of its features) is missing.
//
// Engine address: APP_CONFIG.kanteUrl (config.js; '' switches it off), else the hosted engine. ?kante=off or
// ?engine=off in the page address switches it off; ?kante=<url> picks an engine on this machine (localhost, 127.x,
// [::1]) for testing. Any other ?kante=<url> is ignored: what the page sends the engine says where you look and
// where you are going, so a link must not choose who gets it.
//
// The helpers below are plain functions without the DOM, so tools can test them with Node (module.exports).
(function (root) {
  const DEFAULT_URL = 'https://kante.omniroute.app';
  const MAX_BBOX_KM = 120; // the engine refuses larger boxes (diagonal)

  // A URL's origin (scheme, host, port), or null when it is not an http(s) URL
  function originOf(u) {
    try {
      const x = new URL(String(u || '').trim());
      return /^https?:$/.test(x.protocol) ? x.origin : null;
    } catch (e) {
      return null;
    }
  }
  const isLocalUrl = (u) => /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(u || '');

  // → { url (null = off), fromLink, ignored (a ?kante= link that was not followed) }
  // A link may only switch the engine off, or point it at one on this machine (or the configured one): the engine
  // learns where you are looking and where you are going, so a link must not pick someone else's.
  function engineUrl(search, config) {
    const sp = new URLSearchParams(search || '');
    if (sp.get('engine') === 'off') return { url: null, fromLink: true }; // engine.js's switch, honoured here too
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

  // ---- Talking to the engine: /api/meta (again after RETRY_MS while it fails), then GET/POST with a timeout;
  //      any failure is just null ----
  const RETRY_MS = 30000;
  function client(search, config) {
    const { url, fromLink, ignored } = engineUrl(search, config);
    let meta = null, features = new Set(), metaP = null, busy = false, failedAt = 0;
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
    // Resolves to the meta (null while the engine can't be reached). A failure is asked again once RETRY_MS have
    // passed (force: at once), so an engine that was down when the page loaded is picked up later.
    function ready(force) {
      if (!url) return Promise.resolve(null);
      if (meta || busy || (metaP && failedAt && !force && Date.now() - failedAt < RETRY_MS)) return metaP;
      busy = true;
      metaP = call('/api/meta', null, {}, 4000).then((m) => {
        busy = false;
        meta = m && typeof m === 'object' ? m : null;
        features = new Set((meta && Array.isArray(meta.features) && meta.features) || []);
        failedAt = meta ? 0 : Date.now();
        return meta;
      });
      return metaP;
    }
    return {
      url,
      fromLink,
      ignored,
      // a link can only pick an engine on this machine (or the configured one), so whatever engine is used is trusted
      trusted: !!url,
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
  const clamp01 = (x) => Math.min(1, Math.max(0, Number(x) || 0));

  // Station ids: the engine's "st:Parentch:1:sloid:7000" is UIC 8507000 (engine.js has the same; used when loaded)
  const ownUicOf = (stationId) => {
    const m = /^st:Parentch:1:sloid:(\d{1,5})$/.exec(stationId || '');
    return m ? String(8500000 + Number(m[1])) : null;
  };
  const uicOf = (id) => ((root && root.KANTE && typeof root.KANTE.uicOf === 'function') ? root.KANTE.uicOf : ownUicOf)(id);
  // Is the passList stop x (transport.opendata.ch) the station of the engine's call c? By UIC number when both
  // have one, else by name.
  function sameStation(x, c) {
    const st = x && x.station;
    if (!st || !c || !c.quay) return false;
    const uic = uicOf(c.quay.stationId), id = st.id != null ? String(st.id) : '';
    if (uic && /^\d+$/.test(id)) return Number(uic) === Number(id);
    return !!st.name && norm(st.name) === norm(c.quay.stationName);
  }

  // The engine's call for each stop of the ride's passList (null where it has none): the first and last are the
  // match's fromSeq and toSeq, the ones between are paired by station, in order. Calls the engine skips are left out.
  function alignCalls(trip, match, passList) {
    const list = passList || [], out = list.map(() => null);
    if (!trip || !match || !list.length) return out;
    const all = (trip.calls || []).filter((c) => c && !c.skipped);
    const first = all.find((c) => c.seq === match.fromSeq) || null;
    const last = match.toSeq != null ? all.find((c) => c.seq === match.toSeq) || null : null;
    const mid = all.filter((c) => c.seq > match.fromSeq && (match.toSeq == null || c.seq < match.toSeq)).sort((x, y) => x.seq - y.seq);
    out[0] = first;
    if (list.length > 1) out[list.length - 1] = last;
    let next = 0;
    for (let k = 1; k < list.length - 1; k++) {
      for (let q = next; q < mid.length; q++) {
        if (sameStation(list[k], mid[q])) { out[k] = mid[q]; next = q + 1; break; }
      }
    }
    return out;
  }
  // engine seq → place in the passList, from alignCalls
  const seqIndex = (aligned) => new Map((aligned || []).map((c, k) => (c ? [c.seq, k] : null)).filter(Boolean));

  // Write the engine's live times and platform into the section's "prognosis", the way transport.opendata.ch
  // gives them, so the rest of the app reads them as it always has. Only calls with live times (`live: true`) are
  // written: a timetable time never replaces a forecast from elsewhere. A platform change the engine wrote is taken
  // back (to what was there before) once the engine no longer reports it. → true when the trip has live data
  function applyTrip(s, trip, match) {
    const info = liveInfoOf(trip);
    if (!trip || !isLive(info) || !match || match.toSeq == null) return false;
    const bySeq = new Map((trip.calls || []).map((c) => [c.seq, c]));
    const set = (stop, c, which) => {
      if (!stop || !c) return;
      const p = { ...(stop.prognosis || {}) };
      if (c.live) {
        const t = which === 'departure' ? liveDep(c) : liveArr(c);
        const plan = which === 'departure' ? (c.dep != null ? c.dep : c.arr) : (c.arr != null ? c.arr : c.dep);
        if (t != null) { p[which] = iso(t); if (plan != null) stop.delay = Math.round((t - plan) / 60); }
      }
      // a changed platform; only when its number differs too ("7" and "7AB" are the same platform)
      const moved = c.plannedLabel && c.quay && c.quay.label && platNum(c.quay.label) !== platNum(stop.platform) ? c.quay.label : null;
      if (moved) {
        if (!('_kPlatform' in p)) p._kPrev = p.platform != null ? p.platform : null; // what was there before
        p.platform = moved;
        p._kPlatform = moved;
      } else if ('_kPlatform' in p) {
        if (p.platform === p._kPlatform) { if (p._kPrev != null) p.platform = p._kPrev; else delete p.platform; }
        delete p._kPlatform;
        delete p._kPrev;
      }
      stop.prognosis = p;
    };
    set(s.departure, bySeq.get(match.fromSeq), 'departure');
    set(s.arrival, bySeq.get(match.toSeq), 'arrival');
    const list = (s.journey && s.journey.passList) || [];
    alignCalls(trip, match, list).forEach((c, k) => {
      if (!c || !c.live) return;
      const x = list[k], p = { ...(x.prognosis || {}) };
      if (c.arr != null) p.arrival = iso(liveArr(c));
      if (c.dep != null) p.departure = iso(liveDep(c));
      x.prognosis = p;
    });
    return true;
  }

  // Was the departure from stop `seq` measured (observedKind `dep` or `arr+dep`)?
  const depMeasured = (info, seq) => !!info && seq != null && info.observedSeq === seq && /(^|\+)dep$/.test(info.observedKind || '');
  // The next call after seq that the vehicle stops at
  const nextCall = (calls, seq) => (calls || []).filter((c) => c && c.seq > seq && !c.skipped).sort((x, y) => x.seq - y.seq)[0] || null;

  // ---- Where the vehicle is at tNow (unix s), from the engine's position at pos.t: from `frac`, going on at the
  //      pace of its `dep`→`arr`. A vehicle standing at a stop past its departure is moved on towards the next stop
  //      it serves, marked `stepped` (that departure was not measured). ----
  function advance(pos, calls, tNow) {
    if (!pos || pos.seq == null) return null;
    const span = (d, a) => (d != null && a != null && a > d ? a - d : null);
    if (pos.state === 'between') {
      const nx = pos.nextSeq != null ? pos.nextSeq : (nextCall(calls, pos.seq) || {}).seq;
      let d = pos.dep, a = pos.arr;
      if (d == null || a == null) { // an older engine: time it by the calls
        const by = new Map((calls || []).map((c) => [c.seq, c]));
        d = liveDep(by.get(pos.seq)); a = liveArr(by.get(nx));
      }
      const g = span(d, a), t0 = pos.t != null ? pos.t : tNow;
      return { ...pos, nextSeq: nx, dep: d, arr: a, frac: clamp01((Number(pos.frac) || 0) + (g ? (tNow - t0) / g : 0)) };
    }
    if (pos.state === 'at') {
      const leave = pos.dep != null ? pos.dep : liveDep((calls || []).find((c) => c.seq === pos.seq));
      const nc = nextCall(calls, pos.seq), a = liveArr(nc), g = span(leave, a);
      if (nc && g && tNow > leave) return { ...pos, state: 'between', nextSeq: nc.seq, dep: leave, arr: a, frac: clamp01((tNow - leave) / g), stepped: true };
      return { ...pos };
    }
    return { ...pos };
  }
  // …as km along the drawn ride: seqIdx = engine seq → place in the passList (seqIndex), kms = each drawn stop's km,
  // stopIdx = each drawn stop's place in the passList.
  // → { km, at } (index into the passList) or { km, from, to }, or null when it isn't on this part of the trip
  function rideKm(p, seqIdx, kms, stopIdx) {
    if (!p || !seqIdx || (p.state !== 'at' && p.state !== 'between')) return null;
    const place = (seq) => {
      const k = seqIdx.get(seq), m = k == null ? -1 : stopIdx.indexOf(k);
      return m < 0 || kms[m] == null ? null : { k, km: kms[m] };
    };
    const a = place(p.seq);
    if (!a) return null;
    if (p.state === 'at') return { km: a.km, at: a.k };
    const b = place(p.nextSeq != null ? p.nextSeq : p.seq + 1);
    if (!b || b.k <= a.k) return null;
    return { km: a.km + (b.km - a.km) * clamp01(p.frac), from: a.k, to: b.k };
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
  // Where a vehicle of /api/vehicles is at tNow (unix s): from its `frac` at the response's time `t` (copied onto
  // it), going on at the pace of its dep→arr. Standing at a stop (from = to) it stays there.
  function vehicleAt(v, tNow) {
    const span = v.arr - v.dep;
    let f;
    if (v.frac != null && v.t != null) f = Number(v.frac) + (span > 0 ? (tNow - v.t) / span : 0);
    else f = span > 0 ? (tNow - v.dep) / span : tNow >= v.arr ? 1 : 0;
    f = clamp01(f);
    return [v.from[0] + (v.to[0] - v.from[0]) * f, v.from[1] + (v.to[1] - v.from[1]) * f];
  }
  // Under way (not standing at a stop) after a measured departure from the stop before `nextSeq`. With stops
  // skipped in between this can't be told from the vehicle alone, and nothing is claimed.
  const vehicleLeftMeasured = (v) => !!v && !!v.from && !!v.to && (v.from[0] !== v.to[0] || v.from[1] !== v.to[1])
    && v.nextSeq != null && depMeasured(v.info || liveInfoOf(v), v.nextSeq - 1);
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
  // Coordinates as sent to the engine: 5 decimals (about 1 m), no more than a position needs
  const roundLL = (x) => Math.round(Number(x) * 1e5) / 1e5;

  const KANTE = {
    DEFAULT_URL, MAX_BBOX_KM, engineUrl, isLocalUrl, client, unixOf, matchParams, liveInfoOf, isLive, liveArr, liveDep,
    alignCalls, seqIndex, sameStation, uicOf, applyTrip, depMeasured, nextCall, advance, rideKm, liveText, onboardVerdict,
    runOrWait, journeyLike, vehicleAt, vehicleLeftMeasured, padBbox, bboxContains, bboxOk, bboxParam, distKm, norm,
    originOf, roundLL, RETRY_MS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = KANTE;
  else root.KANTE_LIVE = KANTE; // window.KANTE is engine.js, the general engine client
})(typeof window !== 'undefined' ? window : this);
