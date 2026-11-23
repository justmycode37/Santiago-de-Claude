// Live data from the Kante engine (kante/docs/LIVE-API.md): pure helpers for what /api/trip and /api/vehicles
// answer: measured and forecast stop times, where a vehicle is and how sure that is. The rides of a journey know
// their trips (src/engine-journey.ts) and the page polls them (src/app/56-live-engine.ts); the live vehicles on the
// map are src/app/58-live-vehicles.ts. The client that talks to the engine is src/engine.ts.
//
// The helpers are plain functions without the DOM, so tools can test them with Node (module.exports).
(function (root) {
  const MAX_BBOX_KM = 120; // the engine refuses larger boxes (diagonal)

  // liveInfo from the new API, or the old API's "live" word
  function liveInfoOf(x: KanteLiveCarrier | null | undefined): KanteLiveInfo | null {
    if (!x) return null;
    if (x.liveInfo && typeof x.liveInfo === 'object') return x.liveInfo;
    return typeof x.live === 'string' ? { state: x.live } : null;
  }
  // Live times only count when they are live and recent
  const isLive = (info: KanteLiveInfo | null | undefined) => !!info && (info.state === 'observed' || info.state === 'predicted');

  // A call's live times (unix s): the timetable plus the delay
  const liveArr = (c: KanteStopCall | null | undefined) => (c && c.arr != null ? c.arr + (c.arrDelayS || 0) : c && c.dep != null ? c.dep + (c.depDelayS || 0) : null);
  const liveDep = (c: KanteStopCall | null | undefined) => (c && c.dep != null ? c.dep + (c.depDelayS || 0) : liveArr(c));
  const clamp01 = (x: number | null | undefined) => Math.min(1, Math.max(0, Number(x) || 0));

  // Was the departure from stop `seq` measured (observedKind `dep` or `arr+dep`)?
  const depMeasured = (info: KanteLiveInfo | null | undefined, seq: number | null | undefined) => !!info && seq != null && info.observedSeq === seq && /(^|\+)dep$/.test(info.observedKind || '');
  // The next call after seq that the vehicle stops at
  const nextCall = (calls: KanteStopCall[] | null | undefined, seq: number) => (calls || []).filter((c) => c && c.seq > seq && !c.skipped).sort((x, y) => x.seq - y.seq)[0] || null;

  // ---- Where the vehicle is at tNow (unix s), from the engine's position at pos.t: from `frac`, going on at the
  //      pace of its `dep`→`arr`. A vehicle standing at a stop past its departure is moved on towards the next stop
  //      it serves, marked `stepped` (that departure was not measured). ----
  function advance(pos: KantePosition | null | undefined, calls: KanteStopCall[] | null | undefined, tNow: number): KanteAdvancedPosition | null {
    if (!pos || pos.seq == null) return null;
    const span = (d: number | null | undefined, a: number | null | undefined) => (d != null && a != null && a > d ? a - d : null);
    if (pos.state === 'between') {
      const nx = pos.nextSeq != null ? pos.nextSeq : (nextCall(calls, pos.seq) || {}).seq;
      let d: number | null | undefined = pos.dep, a: number | null | undefined = pos.arr;
      if (d == null || a == null) { // an older engine: time it by the calls
        const by = new Map<number | undefined, KanteStopCall>((calls || []).map((c) => [c.seq, c]));
        d = liveDep(by.get(pos.seq)); a = liveArr(by.get(nx));
      }
      const g = span(d, a), t0 = pos.t != null ? pos.t : tNow;
      return { ...pos, nextSeq: nx, dep: d, arr: a, frac: clamp01((Number(pos.frac) || 0) + (g ? (tNow - t0) / g : 0)) };
    }
    if (pos.state === 'at') {
      const leave = pos.dep != null ? pos.dep : liveDep((calls || []).find((c) => c.seq === pos.seq));
      const nc = nextCall(calls, pos.seq), a = liveArr(nc), g = span(leave, a);
      if (nc && g && tNow > leave!) return { ...pos, state: 'between', nextSeq: nc.seq, dep: leave, arr: a, frac: clamp01((tNow - leave!) / g), stepped: true };
      return { ...pos };
    }
    return { ...pos };
  }
  // …as km along the drawn ride: seqIdx = the trip's seq → the stop's place in the ride, kms = each drawn stop's km,
  // stopIdx = each drawn stop's place in the ride.
  // → { km, at } (index into the ride's stops) or { km, from, to }, or null when it isn't on this part of the trip
  function rideKm(p: KanteAdvancedPosition | null | undefined, seqIdx: Map<number, number> | null | undefined, kms: (number | null | undefined)[], stopIdx: number[]): KanteRideKm | null {
    if (!p || !seqIdx || (p.state !== 'at' && p.state !== 'between')) return null;
    const place = (seq: number) => {
      const k = seqIdx.get(seq), m = k == null ? -1 : stopIdx.indexOf(k);
      return m < 0 || kms[m] == null ? null : { k, km: kms[m] } as { k: number; km: number };
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
  const ago = (s: number) => (s < 60 ? 'just now' : `${Math.round(s / 60)} min ago`);
  function liveText(info: Pick<KanteLiveInfo, 'state' | 'inaccurate' | 'congestion'> | null | undefined, ctx?: KanteLiveContext | null) {
    const c = ctx || {}, state = (info && info.state) || 'timetable';
    let text;
    if (state === 'stale') text = 'Live data is out of date: estimated from older times';
    else if (c.basis === 'timetable' || state === 'timetable') text = 'Timetable only, no live data';
    else if (state === 'observed' || c.basis === 'observed-stop') {
      text = c.leftS != null && c.from ? `Left ${c.from} ${ago(c.leftS)} (measured)`
        : c.observedAt ? `Estimated from a time measured at ${c.observedAt}` : 'Estimated from a measured time';
    } else text = 'Estimated from forecasts';
    const notes = [];
    if (info && info.inaccurate) notes.push('the operator says this forecast is unreliable');
    if (info && info.congestion) notes.push('in a traffic jam');
    return { text: notes.length ? `${text} · ${notes.join(' · ')}` : text, dim: state === 'stale' || state === 'timetable' };
  }

  // ---- Run or wait: seconds until it leaves, seconds of walking left → { text, level } ----
  function runOrWait(leftS: number, walkS: number): KanteRunOrWait {
    const spare = leftS - walkS;
    if (spare < 0) return { text: `Hurry: about ${Math.max(1, Math.round(-spare / 60))} min short`, level: 'late' };
    const m = Math.floor(spare / 60);
    if (spare < 180) return { text: `Hurry: ${m < 1 ? 'less than 1 min' : m + ' min'} to spare`, level: 'tight' };
    return { text: `${m} min to spare`, level: 'ok' };
  }

  // ---- Vehicles on the map ----
  // The engine's line ({ name: "IR15", category: "IR", operator }) as the journey object the app colours lines by
  function journeyLike(line: Partial<KanteLine> | null | undefined) {
    const l = line || {}, cat = String(l.category || ''), name = String(l.name || '');
    const num = cat && name.toUpperCase().startsWith(cat.toUpperCase()) ? name.slice(cat.length).trim() : name;
    return { category: cat, number: num || name, operator: l.operator || '', name };
  }
  // Where a vehicle of /api/vehicles is at tNow (unix s): from its `frac` at the response's time `t` (copied onto
  // it), going on at the pace of its dep→arr. Standing at a stop (from = to) it stays there.
  function vehicleAt(v: KanteVehicleHop, tNow: number): LngLat {
    const span = v.arr - v.dep;
    let f;
    if (v.frac != null && v.t != null) f = Number(v.frac) + (span > 0 ? (tNow - v.t) / span : 0);
    else f = span > 0 ? (tNow - v.dep) / span : tNow >= v.arr ? 1 : 0;
    f = clamp01(f);
    return [v.from[0] + (v.to[0] - v.from[0]) * f, v.from[1] + (v.to[1] - v.from[1]) * f];
  }
  // Under way (not standing at a stop) after a measured departure from the stop before `nextSeq`. With stops
  // skipped in between this can't be told from the vehicle alone, and nothing is claimed.
  const vehicleLeftMeasured = (v: KanteVehicleSeen | null | undefined) => !!v && !!v.from && !!v.to && (v.from[0] !== v.to[0] || v.from[1] !== v.to[1])
    && v.nextSeq != null && depMeasured(v.info || liveInfoOf(v), v.nextSeq - 1);
  function distKm(a: LngLat, b: LngLat) {
    const R = 6371, r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLng = (b[0] - a[0]) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  // [w, s, e, n] grown by a share of its size on every side, kept within the engine's limit
  function padBbox(b: KanteBbox, share: number): KanteBbox {
    let [w, s, e, n] = b;
    const dx = (e - w) * share, dy = (n - s) * share;
    w -= dx; e += dx; s -= dy; n += dy;
    for (let k = 0; k < 20 && distKm([w, s], [e, n]) > MAX_BBOX_KM * 0.95; k++) {
      const cx = (w + e) / 2, cy = (s + n) / 2;
      w = cx - (cx - w) * 0.8; e = cx + (e - cx) * 0.8; s = cy - (cy - s) * 0.8; n = cy + (n - cy) * 0.8;
    }
    return [w, s, e, n];
  }
  const bboxContains = (o: KanteBbox | null | undefined, i: KanteBbox) => !!o && i[0] >= o[0] && i[1] >= o[1] && i[2] <= o[2] && i[3] <= o[3];
  const bboxOk = (b: KanteBbox) => distKm([b[0], b[1]], [b[2], b[3]]) <= MAX_BBOX_KM;
  const bboxParam = (b: KanteBbox) => b.map((x) => x.toFixed(5)).join(',');

  const KANTE: KanteLiveApi = {
    MAX_BBOX_KM, liveInfoOf, isLive, liveArr, liveDep, depMeasured, nextCall, advance, rideKm, liveText,
    runOrWait, journeyLike, vehicleAt, vehicleLeftMeasured, padBbox, bboxContains, bboxOk, bboxParam, distKm,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = KANTE;
  else root.KANTE_LIVE = KANTE; // window.KANTE is engine.js, the engine's client
})(typeof window !== 'undefined' ? window : this);
