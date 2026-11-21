// Journeys from the Kante engine (engine.js), in the shape the rest of the app already reads.
//
// index.html draws a transport.opendata.ch "connection" (sections, journey.passList, prognosis, platform…).
// An engine journey is turned into that shape here, so the journey sheet, the map and live tracking work on
// both. The engine's own data stays attached (conn.kante, section.kante, stop.kante) for what it knows
// better: the exact boarding point, the walking paths with their directions and floor changes, live delays.
//
// Walking speed, step-free, extra change time, maximum walk and transport types go in as routing options:
// the engine only offers changes that work with them. Nothing is retimed or filtered afterwards
// (SETTINGS.retime / SETTINGS.connectionFits are for the transport.opendata.ch fallback only).
//
// find() gives null when the engine is off, unreachable or has no journey; the caller then asks
// transport.opendata.ch as before.
(function () {
  const K = window.KANTE;
  const iso = (sec) => new Date(sec * 1000).toISOString();
  const pad2 = (n) => String(n).padStart(2, '0');

  // ---- Settings → routing options (kante/engine/crates/server/src/json.rs, PlanOptions) ----
  // The app's transport types (settings.js) → the engine's modes
  const ENGINE_MODES = { train: ['rail', 'rack'], tram: ['tram', 'metro'], bus: ['bus', 'ondemand', 'other'], ship: ['boat'], cableway: ['cableway', 'funicular', 'lift'] };
  function options() {
    const p = window.SETTINGS.prefs();
    const o = {
      walkSpeed: Math.round((p.walkKmh / 3.6) * 1000) / 1000, // m/s
      stairs: p.stepFree ? 'never' : p.fewerStairs ? 'avoid' : 'ok',
      escalators: !p.noEscalators,
      wheelchair: !!p.wheelchair,
      transferMarginS: p.extraChangeMin * 60,
      maxWalkMin: p.maxWalkMin,
    };
    const modes = window.SETTINGS.transportations();
    if (modes.length) o.modes = modes.flatMap((m) => ENGINE_MODES[m] || []);
    return o;
  }

  // ---- Lines ----
  // index.html tells a ride's mode from its category (modeOf) and builds its label from category + number
  // (lineLabel). The engine names the mode itself; its line name often repeats the category ("IC61", "S1").
  const APP_MODE = { rail: 'train', rack: 'train', tram: 'tram', metro: 'tram', boat: 'boat', funicular: 'cable', cableway: 'cable', lift: 'cable' };
  const CATEGORY_MODE = [
    [/^(IC|ICE|ICN|IR|IRE|EC|EN|EXT|NJ|RE|R|RB|S|SN|PE|TGV|RJX|TER)$/, 'train'],
    [/^(T|TRAM|M)$/, 'tram'],
    [/^(BAT|FAE|BAV)$/, 'boat'],
    [/^(FUN|PB|GB|SL|LB|ASC)$/, 'cable'],
  ];
  const PLAIN_CATEGORY = { train: 'R', tram: 'T', bus: 'B', boat: 'BAT', cable: 'FUN' };
  function lineOf(line) {
    const mode = APP_MODE[line.mode] || 'bus';
    const name = line.name || '';
    let category = (line.category || '').toUpperCase();
    let number = name.toUpperCase().startsWith(category) ? name.slice(category.length).trim() : name;
    const known = CATEGORY_MODE.find(([re]) => re.test(category));
    // a category the app would take for another mode: a plain one of the right mode, the full name as its number
    if ((known ? known[1] : 'bus') !== mode) { category = PLAIN_CATEGORY[mode]; number = name; }
    return { name: `${category} ${number}`.trim(), category, number, operator: line.operator || '' };
  }

  // ---- Stops ----
  // One stop of a ride in the shape of a transport.opendata.ch checkpoint. "platform" is the timetable's,
  // "prognosis" what is expected today (live times, and the platform when it has changed).
  function setCall(stop, call, arr = true, dep = true) {
    const q = call.quay;
    const p = stop.prognosis || (stop.prognosis = { platform: null, arrival: null, departure: null });
    stop.kante = call;
    if (arr) {
      stop.arrival = call.arr != null ? iso(call.arr) : null;
      p.arrival = call.arr != null && call.arrDelayS != null ? iso(call.arr + call.arrDelayS) : null;
    }
    if (dep) {
      stop.departure = call.dep != null ? iso(call.dep) : null;
      p.departure = call.dep != null && call.depDelayS != null ? iso(call.dep + call.depDelayS) : null;
    }
    const label = (q.label || '') + (q.sectors || ''); // "7" + "AB": index.html splits it again (splitPlatform)
    const changed = call.plannedLabel != null;
    stop.platform = changed ? call.plannedLabel : label;
    p.platform = changed ? label : null;
  }
  const stationOf = (q) => ({ id: K.uicOf(q.stationId) || q.stationId, name: q.stationName, coordinate: { x: q.lat, y: q.lon } });

  // Where exactly a stop of an engine journey is → { ll, edge, travel } as platformAt() in index.html gives it,
  // or null for any other stop. edge is null when the engine only knows the stop, not the boarding point.
  function at(stop) {
    const call = stop && stop.kante, q = call && call.quay;
    if (!q) return null;
    const ll = [q.lon, q.lat];
    const exact = q.precision === 'edge' || (q.precision === 'edge-at-station' && !!q.label);
    const edge = exact ? { ref: q.label || '', bearing: null, level: q.level == null ? null : q.level, ll, side: q.side ? q.side.text : '' } : null;
    return { ll, edge, travel: stop.kanteBearing == null ? null : stop.kanteBearing };
  }

  // ---- Sections ----
  // One ride. More than one leg when you stay seated while the vehicle goes on as another trip: that is shown
  // as one ride, under the line you board.
  function rideSection(legs) {
    const first = legs[0];
    const passList = [], calls = []; // calls: which stop shows which call of which trip (for the live refresh)
    legs.forEach((leg, n) => {
      const list = [leg.from, ...leg.intermediate, leg.to];
      list.forEach((call, k) => {
        const end = k === 0 || k === list.length - 1;
        if (call.skipped && !end) return; // the vehicle does not stop there today
        const joins = n > 0 && k === 0;                       // the stop where the trip changes: one stop,
        const goesOn = k === list.length - 1 && n < legs.length - 1; // arriving on one trip, leaving on the next
        const stop = joins ? passList[passList.length - 1] : { station: stationOf(call.quay) };
        if (!joins) passList.push(stop);
        const bind = { leg, seq: call.seq, stop, arr: !joins, dep: !goesOn };
        calls.push(bind);
        setCall(stop, call, bind.arr, bind.dep);
      });
    });
    if (first.bearing != null) passList[0].kanteBearing = first.bearing; // the way the vehicle leaves
    return { journey: { ...lineOf(first.line), to: first.headsign, passList }, walk: null,
      departure: passList[0], arrival: passList[passList.length - 1], kante: first, kanteLegs: legs, kanteCalls: calls };
  }

  // A walk shorter than half a minute would round to "0 min" and drop out of the trip; one that has a way
  // to go still counts as a walk
  const shownSecs = (leg) => (leg.distanceM >= 10 ? Math.max(30, leg.durationS) : leg.durationS);
  function walkSection(leg) {
    const end = (p, which, t) => {
      const coordinate = { x: p.lat, y: p.lon };
      const stop = p.quay ? { station: { ...stationOf(p.quay), coordinate } } : { location: { coordinate } };
      stop[which] = iso(t);
      return stop;
    };
    return { journey: null, walk: { duration: shownSecs(leg) }, departure: end(leg.from, 'departure', leg.dep), arrival: end(leg.to, 'arrival', leg.arr), kante: leg };
  }

  // An engine journey → a connection as transport.opendata.ch gives it
  function adapt(j) {
    const parts = [];
    let ride = null;
    j.legs.forEach((leg) => {
      if (leg.type === 'ride') {
        if (leg.stayOnBoard && ride) { ride.push(leg); return; }
        ride = [leg];
        parts.push(ride);
        return;
      }
      ride = null;
      if (leg.kind === 'transfer' && !(leg.distanceM > 0)) return; // changing at the same boarding point: no walk
      parts.push(leg);
    });
    const sections = parts.map((p) => (Array.isArray(p) ? rideSection(p) : walkSection(p)));
    // the arrival as timetabled (the pill marks a later live arrival): the last ride's, plus the walk after it
    let arrival = j.arr;
    const last = sections.map((s) => !!s.journey).lastIndexOf(true);
    if (last >= 0) {
      arrival = sections[last].arrival.kante.arr;
      sections.slice(last + 1).forEach((s) => { arrival += Math.round(s.walk.duration / 60) * 60; });
    }
    return { kante: j, from: { departure: iso(j.dep) }, to: { arrival: iso(arrival) }, transfers: j.transfers, sections };
  }

  // ---- Planning ----
  // Which of the engine's journeys to show. Leaving now or at a set time: the one that gets there first;
  // "arrive by": the one that leaves last. One change less is worth three minutes. Walking all the way
  // wins when it is no slower and within the maximum walk.
  function pick(res, body) {
    const sound = (j) => !j.legs.some((l) => l.cancelled) && !(j.alerts || []).some((a) => a.kind === 'missed-connection');
    let list = (res.journeys || []).filter((j) => j.legs && j.legs.length);
    if (list.some(sound)) list = list.filter(sound);
    const cost = (j) => (body.arriveBy ? -j.dep : j.arr) + j.transfers * 180;
    const best = list.reduce((a, b) => (a && cost(a) <= cost(b) ? a : b), null);
    let walk = res.walkOnly && res.walkOnly.legs && res.walkOnly.legs.length === 1 ? res.walkOnly : null;
    if (walk && body.arriveBy && body.time) {
      // the engine starts this walk when its last journey leaves: move it to end at the chosen time
      const dep = body.time - walk.durationS;
      walk = { ...walk, dep, arr: body.time, legs: [{ ...walk.legs[0], dep, arr: body.time }] };
    }
    if (!walk || !best) return best || walk;
    const noSlower = body.arriveBy ? walk.dep >= best.dep : walk.arr <= best.arr;
    return noSlower && walk.durationS <= body.options.maxWalkMin * 60 ? walk : best;
  }

  // fromLL: [lng, lat]; dest: a search result ({ lngLat }); query: the time picker ({ mode: 'dep' | 'arr', date, time })
  async function find(fromLL, dest, query) {
    if (!K || !K.available() || !fromLL || !dest || !dest.lngLat) return null;
    const body = { from: { lat: fromLL[1], lon: fromLL[0] }, to: { lat: dest.lngLat[1], lon: dest.lngLat[0] }, options: options() };
    const { mode, date, time } = query || {};
    if (date || time) {
      const now = new Date();
      const day = date || `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
      const t = new Date(`${day}T${time || `${pad2(now.getHours())}:${pad2(now.getMinutes())}`}`).getTime();
      if (!Number.isFinite(t)) return null;
      body.time = Math.floor(t / 1000);
      if (mode === 'arr') body.arriveBy = true;
    }
    try {
      const j = pick(await K.plan(body), body);
      return j ? adapt(j) : null;
    } catch (e) {
      return null; // unreachable, too slow, or no route (HTTP 400)
    }
  }

  // ---- Walks ----
  // The engine's walking leg as index.html keeps a routed walk: its line, metres, and written directions
  // with the floor changes ({ kind, text, coords, from, to } as walkDirections() lists them).
  function walkParts(leg) {
    const coords = leg.geometry;
    const whole = (x) => Math.round(x || 0);
    const dirs = [];
    (leg.steps || []).forEach((s) => {
      if (s.kind === 'arrive') return; // index.html ends the list with its own "Arrive at …"
      const vertical = /^(stairs|escalator|ramp)-|^lift$/.test(s.kind);
      const change = vertical && s.toLevel != null && whole(s.toLevel) !== whole(s.level);
      const down = /-down$/.test(s.kind) || (change && s.toLevel < (s.level || 0));
      const up = /-up$/.test(s.kind) || (change && !down);
      const d = { kind: down ? 'stairs-down' : up ? 'stairs-up' : !dirs.length ? 'depart' : 'walk', text: s.text, coords: coords.slice(s.from, s.to + 1) };
      if (change) { d.from = whole(s.level); d.to = whole(s.toLevel); }
      dirs.push(d);
    });
    // A change with an official minimum change time is timed by that, while the engine's path runs between the
    // platforms' registry points and can be far longer than what people walk there (long platforms, V-shaped
    // stations; cap_by_official in the engine). Metres that contradict the minutes are left out.
    const pathS = (leg.steps || []).reduce((sum, s) => sum + (s.durS || 0), 0);
    const dist = leg.kind === 'transfer' && pathS > leg.durationS + 150 ? null : leg.distanceM;
    return { lines: [coords], walks: [{ coords, steps: null, dist, dirs }],
      floors: dirs.filter((d) => d.from != null && d.coords.length).map((d) => ({ at: d.coords[0], from: d.from, to: d.to })) };
  }
  function setWalk(st, leg) {
    st.kante = leg;
    st.walkS = leg.durationS; // to the second, for the time to spare at a change
    st.kanteWalk = !leg.approximate && !!leg.geometry && leg.geometry.length > 1;
    if (st.kanteWalk) Object.assign(st, walkParts(leg)); // else not mapped: left to the app's own walking routers
  }

  // Called by buildSteps() in index.html: hand every walk and change of an engine journey its engine leg
  function decorate(steps, conn) {
    const secs = conn.sections;
    const before = (ride) => secs[secs.indexOf(ride) - 1];
    steps.forEach((st) => {
      if (st.type !== 'walk' && st.type !== 'change') return;
      const s = st.type === 'walk' && st.final ? secs[secs.length - 1] : before(st.next);
      if (!s || s.journey || !s.kante) return;
      setWalk(st, s.kante);
      if (st.type === 'walk' && st.t0 != null) st.t1 = st.t0 + s.kante.durationS * 1000;
    });
  }

  // ---- Live ----
  // Fresh forecasts for the rides of an engine journey: each trip again from the engine (delays, platform
  // changes). A trip that cannot be fetched keeps its last forecast.
  async function refresh(sections) {
    await Promise.all(sections.flatMap((s) => (s.kanteLegs || []).map(async (leg) => {
      let trip;
      try { trip = await K.trip(leg.tripId, leg.serviceDate); } catch (e) { return; }
      applyTrip(s, trip, leg);
    })));
  }
  // An answer of /api/trip for one of the section's trips (also used by live.js's polling in index.html)
  function applyTrip(s, trip, leg) {
    leg = leg || (s.kanteLegs || []).find((l) => l.tripId === trip.tripId && l.serviceDate === trip.serviceDate);
    if (!leg) return;
    const bySeq = new Map((trip.calls || []).map((c) => [c.seq, c]));
    s.kanteCalls.forEach((b) => {
      const call = b.leg === leg && bySeq.get(b.seq);
      if (call) setCall(b.stop, call, b.arr, b.dep);
    });
  }

  // After a refresh: a platform change moves the boarding (or alighting) point. Put the ride's ends, and the
  // walks that lead to and from them, on the new one. changed() is called whenever a line on the map has moved.
  function requay(steps, changed) {
    const same = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
    const lastOf = (st) => { const l = st.lines && st.lines[st.lines.length - 1]; return l && l[l.length - 1]; };
    const rewalk = new Map(); // step → [from, to]
    let moved = false;
    steps.forEach((st, i) => {
      if (st.type !== 'ride') return;
      const d = at(st.s.departure), a = at(st.s.arrival);
      if (!d || !a || (same(d.ll, st.depLL) && same(a.ll, st.arrLL))) return;
      const prev = steps[i - 1], next = steps[i + 1], final = steps[steps.length - 1];
      moved = true;
      if (!same(d.ll, st.depLL) && prev && prev.type !== 'ride') {
        const from = prev.type === 'change' ? prev.points[0] : prev.lines[0] && prev.lines[0][0];
        if (prev.type === 'change') prev.points[1] = d.ll; else prev.board = d.ll;
        if (from) rewalk.set(prev, [(rewalk.get(prev) || [from])[0], d.ll]);
      }
      if (!same(a.ll, st.arrLL) && next && next.type !== 'ride') {
        const to = next.type === 'change' ? next.points[1] : lastOf(next);
        if (next.type === 'change') next.points[0] = a.ll;
        else if (next.type === 'walk') next.alight = a.ll;
        if (final.type === 'arrive' && final.from === st.s) final.end = a.ll;
        if (to && next.type !== 'arrive') rewalk.set(next, [a.ll, (rewalk.get(next) || [null, to])[1]]);
      }
      const routed = st.path !== st.stops; // the track or road between the stops has been drawn in
      st.stops[0] = d.ll;
      st.stops[st.stops.length - 1] = a.ll;
      st.path = routed ? [d.ll, ...st.path.slice(1, -1), a.ll] : st.stops;
      Object.assign(st, { depAt: d, depLL: d.ll, arrAt: a, arrLL: a.ll });
    });
    rewalk.forEach(([a, b], st) => {
      // straight to the new point at once, then the engine's way there when it has one
      Object.assign(st, { lines: same(a, b) ? [] : [[a, b]], walks: undefined, floors: undefined, kanteWalk: false });
      if (same(a, b) || !K || !K.available()) return;
      K.walk({ from: { lat: a[1], lon: a[0] }, to: { lat: b[1], lon: b[0] }, options: options() }).then((leg) => {
        if (!steps.includes(st) || !st.lines.length || !same(st.lines[0][0], a) || !same(lastOf(st), b)) return; // moved again since
        setWalk(st, leg);
        const min = Math.round(shownSecs(leg) / 60);
        if (st.type === 'change') st.walkMin = min; else st.min = min;
        if (st.type === 'walk' && !st.final && st.t1 != null) st.t0 = st.t1 - leg.durationS * 1000; // be there at the same time
        changed();
      }).catch(() => {});
    });
    if (moved) changed();
  }

  window.KanteJourney = { find, at, decorate, refresh, applyTrip, requay, options };
})();
