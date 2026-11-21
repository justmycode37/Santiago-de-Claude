// Departure boards from the Kante engine (engine.js), for the two places that show them: the card of a tapped
// platform / stop edge (index.html) and Scan (stopvision.js).
//
// The engine knows the boarding point ("quay") of every departure, so the edge no longer has to be guessed from
// a platform name and the direction of travel. KANTE_BOARD.load() answers in the shape of transport.opendata.ch's
// stationboard, which both places already read, and adds `edges` to every departure: the edges of the stop
// (platforms.js, by index) it leaves from. It gives null when the engine is off, cannot be reached or has nothing
// for the stop; the caller then asks transport.opendata.ch as before.
(function () {
  const LIMIT = 200;      // one board for the whole stop: ~80 min at Bern Bahnhof, a day at a street stop
  const FEW = 6;          // an edge with fewer departures than this on the board is asked for by itself
  const ONE_DOT_M = 9;    // tools/build_platforms.py draws one dot for same-named edges within 8 m (+ rounding)
  const APART_M = 25;     // edges of the same name count as separate places when every quay lies this close to one

  // Comparable edge name, same rule as platformKey() in index.html: "7A-D" → "7", "Kante H" → "H"
  function keyOf(p: string | null | undefined) {
    const s = String(p || '').toUpperCase().replace(/^(GLEIS|GL\.|KANTE|QUAI|VOIE|BINARIO|STEG|PERRON)\s*/, '').trim();
    const digits = /^\d+/.exec(s);
    return digits ? digits[0] : s.replace(/[^0-9A-Z]/g, '');
  }
  const toRad = Math.PI / 180;
  function distM(a: LngLat, b: LngLat) {
    const k = Math.cos((a[1] + b[1]) / 2 * toRad);
    return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111320;
  }
  const llOf = (q: KanteQuay): LngLat => [q.lon, q.lat];
  const nearest = <T>(list: T[], dist: (x: T) => number) => list.reduce((a, b) => (dist(b) < dist(a) ? b : a));

  // Which edges of the stop is each quay? → Map: quay id → { edges: [index…] } when that is known ([] = a boarding
  // point the map has no dot for), or { guess, free } when only the direction of travel can tell.
  function edgesOfQuays(st: KanteBoardStop, quays: KanteQuay[]) {
    const out = new Map<string, KanteQuayEdges>();
    const edges = st.edges.map((e, i) => ({ i, key: e.key, ll: e.ll }));
    const exact = (q: KanteQuay) => q.precision === 'edge'; // the quay has a position of its own
    const named = new Map<string, KanteQuay[]>(); // edge name → the quays that carry it
    const loose: KanteQuay[] = [];        // quays without a name, or with one the map does not have
    for (const q of quays) {
      // the timetable only names the stop: the direction of travel has to tell, as for transport.opendata.ch
      if (q.precision === 'station') { out.set(q.id, { guess: true }); continue; }
      const key = keyOf(q.label);
      if (key && edges.some((e) => e.key === key)) {
        if (!named.has(key)) named.set(key, []);
        named.get(key)!.push(q);
      } else loose.push(q);
    }
    // Those are matched by position, with the unnamed edges. Both data sets come from the same registry, so a quay
    // sits on its edge (measured: < 1 m), or within the few metres in which platforms.js draws one dot for
    // several entries. A quay that is nowhere near is a boarding point the map has no dot for; the direction of
    // travel may then only choose among the edges no quay matched (`free`).
    for (const q of loose) {
      const pool = exact(q) ? edges.filter((e) => !e.key).map((e) => ({ e, d: distM(e.ll, llOf(q)) })).sort((a, b) => a.d - b.d) : [];
      const on = pool.filter((p) => p.d <= ONE_DOT_M && p.d <= pool[0].d + 1.5); // edges entered on one spot share it
      out.set(q.id, on.length ? { edges: on.map((p) => p.e.i) } : { guess: true, free: exact(q) });
    }
    for (const [key, qs] of named) {
      const same = edges.filter((e) => e.key === key);
      const home = (q: KanteQuay) => nearest(same, (e) => distM(e.ll, llOf(q)));
      // Several edges of one name are either separate places (a bay "A" per direction: each quay sits on its own
      // edge) or dots along one platform (Bern track 2 and its sectors: the quays are spread out), which share
      // everything. An edge without a quay of its own is taken with its nearest namesake that has one.
      const apart = same.length > 1 && qs.every((q) => exact(q) && distM(home(q).ll, llOf(q)) <= APART_M);
      const served = apart ? same.filter((e) => qs.some((q) => home(q) === e)) : same;
      for (const q of qs) {
        const mine = apart ? same.filter((e) => (served.includes(e) ? e : nearest(served, (s) => distM(s.ll, e.ll))) === home(q)) : same;
        out.set(q.id, { edges: mine.map((e) => e.i) });
      }
    }
    return out;
  }

  // A point ~300 m ahead in the direction of travel, standing in for the next stop
  function ahead(ll: LngLat, bearing: number): LngLat {
    const d = 300 / 111320;
    return [ll[0] + d * Math.sin(bearing * toRad) / Math.cos(ll[1] * toRad), ll[1] + d * Math.cos(bearing * toRad)];
  }
  const iso = (unix: number) => new Date(unix * 1000).toISOString();

  // The engine's answer → stationboard entries with `edges`
  function toBoard(uic: string, st: KanteBoardStop, data: KanteDeparturesResponse, platformLL?: KantePlatformLL | null): KanteBoardEntry[] {
    const quays = new Map<string, KanteQuay>((data.quays || []).map((q) => [q.id, q]));
    const where = edgesOfQuays(st, data.quays || []);
    const taken = new Set<number>(); // edges that have a quay of their own
    for (const w of where.values()) (w.edges || []).forEach((i) => taken.add(i));
    const real = (d: KanteDeparture) => d.dep + (d.live && d.delayS || 0);
    return (data.departures || [])
      .filter((d) => !d.cancelled) // the lists have no way to show a cancelled ride: leave it out
      .sort((a, b) => real(a) - real(b))
      .map((d) => {
        const q = quays.get(d.quayId);
        const line = d.line || {};
        const cat = line.category || '', name = line.name || '';
        // "S7" → S + 7 and "IC1" → IC + 1, as transport.opendata.ch names them; a train without a line number
        // goes by its train number ("IC 1345"). Bus and tram lines keep their name ("101", "M80").
        const road = line.mode === 'bus' || line.mode === 'tram';
        const rest = !road && cat && name.toUpperCase().startsWith(cat.toUpperCase()) ? name.slice(cat.length).trim() : name;
        const moved = d.plannedLabel != null; // leaves from another quay than planned (quayId is the actual one)
        const stop = {
          station: { id: uic, name: st.name, coordinate: q ? { x: q.lat, y: q.lon } : null },
          departure: iso(d.dep),
          // whole minutes late, rounded down so that planned time + delay is the time shown
          delay: d.live && d.delayS != null ? Math.floor(d.delayS / 60) : null,
          platform: (moved ? d.plannedLabel : q && q.label) || null,
          prognosis: { departure: d.live ? iso(real(d)) : null, platform: moved && q && q.label || null },
        };
        const w = where.get(d.quayId) || { edges: [] };
        let on = w.edges;
        if (!on) {
          // the rule the app uses for transport.opendata.ch: named platform, else the edge facing the way we go
          const ll = platformLL && q ? platformLL({ station: stop.station, platform: q.label || null }, null, d.bearing == null ? null : ahead(llOf(q), d.bearing)) : null;
          const i = st.edges.findIndex((e) => e.ll === ll);
          on = i < 0 || w.free && taken.has(i) ? [] : [i];
        }
        return { stop, category: cat, number: rest || (road ? '' : d.number) || '', name: d.number || '', operator: line.operator || '',
                 to: d.headsign || d.towards || '', edges: on };
      });
  }

  // The engine's id of a stop, once known: a stop that is no part of a larger station goes without "Parent" there,
  // and some stops it does not have under their own number at all (null). Asked once, because the browser logs
  // every "unknown station" answer as an error.
  const stationOf = new Map<string, string | null>();

  // More departures of one edge than the stop's board holds (a bay served twice an hour at a busy station, or
  // only at night): the next ones of its own quays, within a day, added to `data`.
  async function addOwn(K: KanteApi, st: KanteBoardStop, data: KanteDeparturesResponse, edge: number) {
    const own: string[] = [];
    for (const [id, w] of edgesOfQuays(st, data.quays || [])) if (w.edges && w.edges.includes(edge)) own.push(id);
    const have = new Set(data.departures.map((d) => d.tripId + '|' + d.serviceDate + '|' + d.seq));
    const until = Date.now() / 1000 + 86400;
    const more = await Promise.all(own.slice(0, 4).map((quay) => K.departures({ quay, limit: FEW }).catch(() => null)));
    for (const m of more) {
      for (const d of (m && m.departures) || []) {
        // asked by planned quay: one that now leaves from elsewhere is not ours
        if (!own.includes(d.quayId) || d.dep > until || have.has(d.tripId + '|' + d.serviceDate + '|' + d.seq)) continue;
        have.add(d.tripId + '|' + d.serviceDate + '|' + d.seq);
        data.departures.push(d);
      }
    }
  }

  // uic: the stop's id in PLATFORMS, st: its entry there, platformLL: index.html's rule for an unknown edge,
  // edge: the edge the list is for (index; leave it out for the stop as a whole)
  async function load(uic: string | number, st: KanteBoardStop | null | undefined, platformLL?: KantePlatformLL | null, edge?: number | null) {
    const K = window.KANTE;
    const id = K && K.available() && st ? K.stationIdOf(uic) : null;
    if (!id || stationOf.get(id) === null) return null;
    try {
      let data: KanteDeparturesResponse | null = null;
      for (const station of stationOf.has(id) ? [stationOf.get(id)!] : [id, id.replace('Parent', '')]) {
        try {
          data = await K!.departures({ station, limit: LIMIT });
          stationOf.set(id, station);
          break;
        } catch (e) {
          if ((e as { status?: number }).status !== 400) throw e; // 400: no station of that id
        }
      }
      if (!data) stationOf.set(id, null);
      let board = data ? toBoard(String(uic), st!, data, platformLL) : [];
      if (edge != null && board.length && board.filter((d) => d.edges.includes(edge)).length < FEW) {
        await addOwn(K!, st!, data!, edge);
        board = toBoard(String(uic), st!, data!, platformLL);
      }
      return board.length ? board : null;
    } catch {
      return null; // the engine cannot be reached: the caller asks transport.opendata.ch
    }
  }

  window.KANTE_BOARD = { load, toBoard, edgesOfQuays };
})();
