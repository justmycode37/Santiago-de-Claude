// ---------- Accurate route shapes ----------
// Timetables only give stop coordinates, so the lines between them are routed:
//   walking → OSM foot routing (routing.openstreetmap.de), trains → BRouter rail profile (brouter.de),
//   buses/trams → OSM road routing. Anything implausible falls back to the straight line.
const routeCache = new Map<string, Promise<unknown>>();
function getJSON<T>(url: string) {
  if (!routeCache.has(url)) routeCache.set(url, fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return routeCache.get(url) as Promise<T | null>;
}
function distKm(a: LngLatFirst, b: LngLatFirst) {
  const R = 6371, toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad, dLng = (b[0] - a[0]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const lengthKm = (cs: LngLat[]) => cs.reduce((sum, c, i) => (i ? sum + distKm(cs[i - 1], c) : 0), 0);
const plausible = (route: LngLat[] | false | null | undefined, straight: LngLat[]) => route && route.length > 1 && lengthKm(route) <= Math.max(lengthKm(straight) * 2.5, lengthKm(straight) + 0.4);
const ll = (c: LngLat) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;

// What the routers answer, as far as it is read: OSRM (routing.openstreetmap.de), Valhalla, BRouter
interface OsrmRoute { geometry: { coordinates: LngLat[] }; distance: number; legs: { steps: OsrmStep[] }[] }
interface OsrmAnswer { code: string; routes: OsrmRoute[] }
interface ValhallaAnswer { trip?: { legs?: { shape: string }[]; summary: { length: number } } }
interface BrouterAnswer { features?: { geometry: { coordinates: number[][] } }[] }
// → { coords, steps (OSRM turn-by-turn, or null), dist (m, or null), approx (a straight line, not a route),
//     and from the pedestrian network (walkroute.js): covered (arcades, passages, …), door (the entrance it ends at),
//     via, cues, and the written directions and floor changes netDirections() makes of them }
// ends: [from, to], what each end is (WalkEnd): your position, a platform on its floor by its number, an exact point,
//   or a place (the walk then ends at its door). netOnly: only the pedestrian network (null where it has no tiles).
async function routeWalk(a: LngLat, b: LngLat, ends?: [WalkEnd, WalkEnd], netOnly?: false): Promise<RoutedWalk>;
async function routeWalk(a: LngLat, b: LngLat, ends: [WalkEnd, WalkEnd] | undefined, netOnly: true): Promise<RoutedWalk | null>;
async function routeWalk(a: LngLat, b: LngLat, ends?: [WalkEnd, WalkEnd], netOnly?: boolean): Promise<RoutedWalk | null> {
  const costing = SETTINGS.walkCosting();
  const [from, to] = ends || [{}, {}];
  const side = (e: WalkEnd, gps?: boolean) => ({ level: e.level, platform: !!e.platform, ref: e.ref || null, exact: !!e.exact,
    accuracy: gps && e.gps && userLngLat ? userAccuracy : null });
  // 1. the pedestrian network (walkgraph/): doors, sidewalks, arcades, passages, floors, squares crossed straight
  const net = window.WALKROUTE;
  if (net) {
    const { stepFree, fewerStairs, noEscalators } = SETTINGS.journey();
    const r = await Promise.race([net.route(a, b, { stepFree, fewerStairs, noEscalators, from: side(from, true), to: side(to) })
      .catch(() => null), new Promise<null>((ok) => setTimeout(() => ok(null), 8000))]); // tiles slow to load: go online
    if (r) return { ...r, steps: null, ...netDirections(r) };
  }
  if (netOnly) return null;
  // 2. online routers, where the network has no tiles
  if (distKm(a, b) < 0.02 && !costing) return { coords: [a, b], steps: null, dist: Math.round(distKm(a, b) * 1000), approx: true };
  if (costing) return routeWalkAccessible(a, b, costing);
  const d = await getJSON<OsrmAnswer>(`https://routing.openstreetmap.de/routed-foot/route/v1/foot/${ll(a)};${ll(b)}?overview=full&geometries=geojson&steps=true`);
  const r = d && d.code === 'Ok' && d.routes[0];
  const g = r && r.geometry.coordinates;
  return plausible(g, [a, b]) ? { coords: [a, ...g as LngLat[], b], steps: (r as OsrmRoute).legs[0].steps, dist: (r as OsrmRoute).distance }
    : { coords: [a, b], steps: null, dist: null, approx: true };
}

// A route on the pedestrian network → written directions in the shape walkDirections() lists them (each moment worth
// a word, and how far it goes on from there), and its floor changes for the map
function netDirections(r: WalkRouteResult): { dirs?: KanteWalkDir[]; floors: KanteFloorChange[] } {
  const cum = [0];
  for (let i = 1; i < r.coords.length; i++) cum.push(cum[i - 1] + distKm(r.coords[i - 1], r.coords[i]) * 1000);
  const slice = (m0: number, m1: number) => r.coords.filter((_, i) => cum[i] >= m0 - 0.5 && cum[i] <= m1 + 0.5);
  const total = cum[cum.length - 1];
  const dirs: KanteWalkDir[] = [], floors: KanteFloorChange[] = [];
  const level = (t: string) => { const m = /(street level|level\s+([\u2212-]?\d+))$/.exec(t); return m ? (m[2] ? +m[2].replace('\u2212', '-') : 0) : null; };
  const marks = r.cues.filter((c, i, all) => !i || c.m - all[i - 1].m >= 3 || c.kind !== all[i - 1].kind);
  const first = marks.length ? marks[0].m : total;
  if (first >= 10) dirs.push({ kind: 'depart', text: `Walk ${fmtDist(first)}`, coords: slice(0, first) });
  let lastLevel: number | null = null;
  marks.forEach((c, k) => {
    const next = k + 1 < marks.length ? marks[k + 1].m : total, on = next - c.m;
    const to = level(c.text);
    const vertical = to != null && (c.kind === 'steps' || c.kind === 'escalator' || c.kind === 'lift' || c.kind === 'ramp');
    // the floor it starts on: as the router saw it, else where the last floor change ended
    const known = c.from != null ? c.from : lastLevel;
    const down = known != null && known !== to ? to! < known : /down/i.test(c.text) || (/^lift/i.test(c.text) && to! < 0);
    const d: KanteWalkDir = { kind: vertical ? (down ? 'stairs-down' : 'stairs-up') : 'walk',
      text: on >= 15 ? `${c.text}, then ${fmtDist(on)}` : c.text, coords: slice(c.m, next) };
    if (vertical) {
      const from = known != null && known !== to ? known : down ? to! + 1 : to! - 1;
      Object.assign(d, { from, to });
      floors.push({ at: c.at, from, to: to! });
      lastLevel = to;
    }
    dirs.push(d);
  });
  // paths only swisstopo's map has (swissTLM3D), not OpenStreetMap: say where the way comes from
  if (r.swisstopo >= 20) dirs.push({ kind: 'walk', text: `${fmtDist(r.swisstopo)} of this is on paths from swisstopo's map (© swisstopo)`, coords: [] });
  if (r.noStepFreeDoor) dirs.push({ kind: 'walk', text: 'No step-free entrance is mapped for this building', coords: [] });
  if (r.door) dirs.push({ kind: 'walk', text: r.door.addr ? `In at the entrance, ${r.door.addr}` : r.door.type === 'main' ? 'In at the main entrance' : 'In at the door marked on the map', coords: [r.door.ll] });
  return dirs.length ? { dirs, floors } : { floors };
}

// Step-free / fewer-stairs walks (Settings › Journeys): Valhalla on the FOSSGIS server can avoid steps
// and route for wheelchairs. One request at a time, to go easy on the free server.
function decodePolyline6(str: string) {
  const out: LngLat[] = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (let k = 0; k < 2; k++) {
      let b, shift = 0, v = 0;
      do { b = str.charCodeAt(i++) - 63; v |= (b & 31) << shift; shift += 5; } while (b >= 32);
      const d = v & 1 ? ~(v >> 1) : v >> 1;
      if (k) lng += d; else lat += d;
    }
    out.push([lng / 1e6, lat / 1e6]);
  }
  return out;
}
let valhallaQueue: Promise<unknown> = Promise.resolve();
async function routeWalkAccessible(a: LngLat, b: LngLat, costing: WalkCosting): Promise<RoutedWalk> {
  const q = {
    locations: [{ lon: a[0], lat: a[1] }, { lon: b[0], lat: b[1] }],
    costing: 'pedestrian', costing_options: { pedestrian: costing }, directions_type: 'none',
  };
  const url = 'https://valhalla1.openstreetmap.de/route?json=' + encodeURIComponent(JSON.stringify(q));
  const d = await (valhallaQueue = valhallaQueue.then(() => getJSON<ValhallaAnswer>(url))) as ValhallaAnswer | null;
  const t = d && d.trip;
  const g = t && t.legs && t.legs[0] && decodePolyline6(t.legs[0].shape);
  // step-free paths can detour more than normal walks; when none is found, show only the straight line
  const direct = distKm(a, b);
  const ok = g && g.length > 1 && lengthKm(g) <= Math.max(direct * 4, direct + 0.8);
  return ok ? { coords: [a, ...g as LngLat[], b], steps: null, dist: Math.round(t!.summary.length * 1000) } : { coords: [a, b], steps: null, dist: null, approx: true };
}

async function routeRide(path: LngLat[], mode: LineMode): Promise<LngLat[]> {
  if (path.length < 2) return path;
  let g: LngLat[] | false | null | undefined = null;
  if (mode === 'train') {
    const d = await getJSON<BrouterAnswer>(`https://brouter.de/brouter?lonlats=${path.map(ll).join('|')}&profile=rail&alternativeidx=0&format=geojson`);
    g = d && d.features && d.features[0] && d.features[0].geometry.coordinates.map((c): LngLat => [c[0], c[1]]);
  } else if (mode === 'bus' || mode === 'tram') {
    const d = await getJSON<OsrmAnswer>(`https://routing.openstreetmap.de/routed-car/route/v1/driving/${path.map(ll).join(';')}?overview=full&geometries=geojson`);
    g = d && d.code === 'Ok' && d.routes[0] && d.routes[0].geometry.coordinates;
  }
  return plausible(g, path) ? [path[0], ...g as LngLat[], path[path.length - 1]] : path;
}

// A walk that passes through a station with a 3D model: the model's route for the part inside it, the street
// router for what lies before and after. Falls back to the street router alone when the model has no route.
async function stationWalk(st: JourneyWalkStep | JourneyChangeStep, plan: StationWalkPlan): Promise<StationWalkParts | null> {
  const lines = st.lines.map((l) => l.slice());
  const a = lines[0][0], last = lines[lines.length - 1], b = last[last.length - 1];
  const ends = st.ends || [];
  const street = async (): Promise<StationWalkParts> => {
    const walks = await Promise.all(lines.map((l, k) => routeWalk(l[0], l[l.length - 1], ends[k])));
    const floors = walks.flatMap((w) => w.floors || []);
    return { lines: walks.map((w) => w.coords), walks, floors: floors.length ? floors : null };
  };
  let model = null, route = null;
  try {
    model = await Station3D.loadData(plan.key);
    route = model && StationRoute!.route(model, plan.from, plan.to, s3Prefs(st));
  } catch (e) { route = null; }
  // no path in the model: the street router, or for a walk the Kante engine has routed, the engine's own path
  if (!route || route.points.length < 2 || route.same) return st.kanteWalk ? null : street();
  const inside = route.points.map((p) => StationRoute!.toLngLat(model!, p));
  const parts: LngLat[][] = [], walks: RoutedWalk[] = [];
  const join = async (p: LngLat, q: LngLat, end: [WalkEnd, WalkEnd]) => { // the stretch between the walk's end and where the model's paths begin
    if (distKm(p, q) < 0.03) return;
    const w = await routeWalk(p, q, end);
    parts.push(w.coords);
    walks.push(w);
  };
  // only for free positions: a route from a platform starts wherever it is best to leave that platform
  if (!route.fromStop) await join(a, inside[0], [(ends[0] || [])[0] || {}, { exact: true }]);
  const whole = (x: number) => Math.round(x);
  // the station's own written directions, in the shape walkDirections() lists them
  const dirs = route.steps.filter((s) => s.kind !== 'arrive').map((s, k) => {
    const change = s.kind !== 'walk' && whole(s.toLevel) !== whole(s.level);
    const d: KanteWalkDir = { kind: change ? (s.toLevel < s.level ? 'stairs-down' : 'stairs-up') : k === 0 && !parts.length ? 'depart' : 'walk',
      text: s.text, coords: inside.slice(s.from, s.to + 1) };
    if (change) { d.from = whole(s.level); d.to = whole(s.toLevel); }
    return d;
  });
  parts.push(inside);
  walks.push({ coords: inside, steps: null, dist: route.length, dirs });
  if (!route.toStop) await join(inside[inside.length - 1], b, [{ exact: true }, (ends[ends.length - 1] || [])[1] || {}]);
  // the model's floor changes, and any on the street parts before and after it
  const floors = dirs.filter((d) => d.from != null).map((d) => ({ at: d.coords[0], from: d.from!, to: d.to! }))
    .concat(walks.flatMap((w) => w.floors || []));
  return { lines: parts, walks, floors };
}

// Walks only, again (after a live platform change): every walk whose line is no longer the one its last answer drew
function refineWalks(id: number, onlyMoved?: boolean) {
  let scheduled = false;
  const redraw = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; if (id === journeyReq) { routeKey = ''; updateProgress(); } });
  };
  const task: WalkTask = (promise, apply) => { promise.then((res) => { if (id !== journeyReq) return; apply(res); geoVersion++; redraw(); }); };
  journeySteps.forEach((st) => {
    if (st.type !== 'walk' && st.type !== 'change') return;
    if (onlyMoved && st._netFor === st.lines && st._netSig === walkSig(st)) return;
    // no walk any more (both rides at the same point now): an answer still on its way must not bring it back
    if (!(st.lines || []).length) { newWalkRev(st); return; }
    const plan = s3Plan(st);
    if (plan) refineStationWalk(st, plan, task); else refineWalk(st, task);
  });
}
type WalkTask = <T>(promise: Promise<T>, apply: (res: T) => void) => void;
// What a walk was routed for besides its line: what its ends are and the platforms it leaves from and goes to (a
// platform can change without its point moving, and a station model routes to the platform by its name)
const walkSig = (st: JourneyWalkStep | JourneyChangeStep) => {
  const stops = st.type === 'change' ? [st.prev.arrival, st.next.departure] : [st.from && st.from.arrival, st.next && st.next.departure];
  return JSON.stringify([st.ends || [], stops.map((s) => (s ? platformOf(s) : ''))]);
};
// A new revision of a walk's route: answers for older ones (it has been moved or rerouted since) are dropped
function newWalkRev(st: JourneyWalkStep | JourneyChangeStep) {
  const rev = (st.walkRev = (st.walkRev || 0) + 1), sig = walkSig(st);
  const current = () => st.walkRev === rev && journeySteps.includes(st);
  // the answer is in: this line, for these ends and platforms, has its route
  const done = () => { st._netFor = st.lines; st._netSig = sig; };
  return Object.assign(current, { done });
}
// Through a station with a 3D model: its own paths (right underpass, stairs, lifts), not the street router or the
// engine's path, so the map shows the same way as the 3D view
function refineStationWalk(st: JourneyWalkStep | JourneyChangeStep, plan: StationWalkPlan, task: WalkTask) {
  const current = newWalkRev(st);
  task(stationWalk(st, plan), (res) => {
    if (!current()) return;
    if (res) {
      st.lines = res.lines;
      st.walks = res.walks;
      st.floors = res.floors;
      queueSheet();
    }
    current.done();
  });
}
const walkKmh = () => Number(SETTINGS.prefs && SETTINGS.prefs().walkKmh) || 4.7;

// One walk (or change) on the pedestrian network. Each request carries the walk's revision: an answer for an older
// revision (the walk has been moved or rerouted since, by a platform change or the engine) is dropped.
function refineWalk(st: JourneyWalkStep | JourneyChangeStep, task: WalkTask) {
  const current = newWalkRev(st);
  if (st.kanteWalk) {
    // a walk the Kante engine has routed: where the pedestrian network covers it, its path is drawn and its
    // directions listed instead (the right door, arcades, floors, never through a building); elsewhere the
    // engine's path stays. Times: see netWalkFits()
    const all = st.lines.flat(), ends = st.ends || [];
    if (all.length < 2) return;
    const end: [WalkEnd, WalkEnd] = [(ends[0] || [])[0] || {}, (ends[ends.length - 1] || [])[1] || {}];
    task(routeWalk(all[0], walkGoal(st, all[all.length - 1]), end, true), (res) => {
      if (!current() || !st.kanteWalk) return;
      if (res && netWalkFits(st, res)) {
        st.lines = [res.coords];
        st.walks = [res];
        st.floors = res.floors && res.floors.length ? res.floors : null;
        queueSheet();
      }
      current.done(); // routed, or the engine's path kept: either way this line has its answer
    });
    return;
  }
  const lines = st.lines || [];
  lines.forEach((line, k) => task(routeWalk(line[0], k === lines.length - 1 ? walkGoal(st, line[line.length - 1]) : line[line.length - 1], st.ends && st.ends[k]), (res) => {
    if (!current()) return;
    st.lines[k] = res.coords;
    (st.walks || (st.walks = []))[k] = res;
    // floor changes where the walking route actually takes them (else the platform levels imply one)
    const floors = st.walks.flatMap((w) => (w && w.floors) || []);
    st.floors = floors.length ? floors : null;
    current.done();
    // walking all the way: timed by the whole walk on the network, once every stretch of it is in
    const ws = st.walks.filter(Boolean);
    if (!journeySteps.some((x) => x.type === 'ride') && ws.length === lines.length && ws.every((w) => w.net && w.dist != null)) {
      retimeWalkConn(journeyConn, ws.reduce((m, w) => m + w.dist!, 0));
    }
    queueSheet(); // metres and written directions
  }));
}

// Where a walk leads: for the walk to the destination the place itself, not the door its last route ended at (which
// the router would take for a point on the building's wall)
const walkGoal = (st: JourneyWalkStep | JourneyChangeStep, end: LngLat) => (st.type === 'walk' && st.final && st.toLL) || end;

// May the network's path replace the engine's for this walk, and with which times?
//  - walking all the way: yes; the trip is timed by the network walk at your walking speed (retimeWalkConn)
//  - a change: the engine's times decide; if the network walk no longer fits between the two rides, the engine's
//    path stays (with its time); otherwise the time to spare is counted on the walk drawn
//  - to the first ride: you leave so as to be at the stop at the same time; to the door: the engine's arrival
//    stays. Either way only while the network walk is at most 2 minutes longer than the engine's
function netWalkFits(st: JourneyWalkStep | JourneyChangeStep, res: RoutedWalk) {
  if (res.dist == null) return false;
  const netS = res.dist / (walkKmh() / 3.6);
  if (!journeySteps.some((x) => x.type === 'ride')) { retimeWalkConn(journeyConn, res.dist); return true; }
  const engS = st.walkS != null ? st.walkS : ((st.type === 'change' ? st.walkMin : st.min) || 0) * 60;
  if (st.type === 'change') {
    const wait = ((liveMs(st.next.departure, 'departure') || 0) - (liveMs(st.prev.arrival, 'arrival') || 0)) / 1000;
    if (!(netS <= wait)) return false;
    st.walkS = netS;
    st.walkMin = Math.max(1, Math.round(netS / 60));
    if (st.t0 != null) st.t1 = st.t0 + netS * 1000;
    return true;
  }
  if (netS > engS + 120) return false;
  if (!st.final && st.t1 != null) {
    st.t0 = st.t1 - netS * 1000;
    st.min = Math.max(1, Math.round(netS / 60));
    if (journeySteps[0] === st && journeyConn) {
      journeyConn.from.departure = new Date(st.t0).toISOString();
      // the option's row lists the walks in minutes: this one as it is drawn (the walks before the first ride)
      const before = journeyConn.sections.slice(0, journeyConn.sections.findIndex((x) => x.journey));
      before.forEach((x, k) => { x._netWalkS = k ? 0 : netS; });
      queueSheet(true);
    }
  }
  return true;
}

// Walking all the way: the trip's times, its card and its place among the options follow the walk drawn
// (network metres at your walking speed) instead of the engine's estimate
function retimeWalkConn(conn: OdConnection | null | undefined, metres: number | null) {
  if (!conn || metres == null) return;
  const secs = metres / (walkKmh() / 3.6);
  const arriveBy = journeyQuery.mode === 'arr' && !!(journeyQuery.date || journeyQuery.time);
  const t0 = new Date(conn.from.departure!).getTime(), t1 = new Date(conn.to.arrival!).getTime();
  const a = arriveBy ? t1 - secs * 1000 : t0, b = arriveBy ? t1 : t0 + secs * 1000;
  // the trip itself, once per distance; its steps every time (a trip opened again is built with the engine's times)
  const fresh = conn._netMetres !== Math.round(metres);
  if (fresh) {
    conn.from.departure = new Date(a).toISOString();
    conn.to.arrival = new Date(b).toISOString();
    const sec = conn.sections && conn.sections[0];
    if (sec && !sec.journey) {
      conn.sections.slice(1).forEach((x) => { if (!x.journey && x.walk) x.walk.duration = 0; }); // all of it is on the first
      if (sec.walk) sec.walk.duration = Math.round(secs);
      if (sec.kante) (sec.kante as KanteWalkLeg).durationS = Math.round(secs); // decorate() times the walk by it
      if (sec.departure) sec.departure.departure = conn.from.departure;
      if (sec.arrival) sec.arrival.arrival = conn.to.arrival;
    }
    if (conn.kante) conn.kante.walkM = Math.round(metres);
    conn._netMetres = Math.round(metres);
  }
  if (conn === journeyConn) {
    const steps = journeySteps.filter((st) => st.type === 'walk' || st.type === 'arrive');
    const stale = steps.some((st) => (st.type === 'walk' ? st.t0 !== a || st.t1 !== b : st.type === 'arrive' && st.time !== conn.to.arrival));
    steps.forEach((st) => {
      if (st.type === 'walk') { st.t0 = a; st.t1 = b; st.min = Math.max(1, Math.round(secs / 60)); st.walkS = secs; }
      if (st.type === 'arrive') st.time = conn.to.arrival;
    });
    if (fresh || stale) queueSheet(true);
  }
  if (!fresh) return;
  // its place among the options: the quicker way first (as the engine ranks them, one change worth 3 minutes)
  const o = journeyOptions;
  if (o && o.walk === conn && o.list && o.list.length) {
    // as KanteJourney.pick(): the best by transport, unless walking is no slower and within your longest walk
    const cost = (c: OdConnection) => (arriveBy ? -connStart(c) : connEnd(c)) + (c.kante ? (c.kante.transfers || 0) * 180000 : 0);
    const pt = o.list.reduce((x: OdConnection, y: OdConnection) => (cost(x) <= cost(y) ? x : y));
    const noSlower = arriveBy ? connStart(conn) >= connStart(pt) : connEnd(conn) <= connEnd(pt);
    const maxWalk = Number(SETTINGS.prefs && SETTINGS.prefs().maxWalkMin) || Infinity;
    o.best = noSlower && secs <= maxWalk * 60 ? conn : pt;
  }
  queueSheet(conn === journeyConn);
}
// The "On foot" option before it is opened: its walk on the network, so its tab and card already show those times
// (kept while these options are on offer, also when another of them has been opened meanwhile)
function netWalkOption(conn: OdConnection, from: LngLat, dest: JourneyDest) {
  if (!conn || !window.WALKROUTE) return;
  routeWalk(from, dest.lngLat, [tripStart ? {} : { gps: true }, {}], true).then((r) => {
    if (journeyOptions && journeyOptions.walk === conn && r && r.net) retimeWalkConn(conn, r.dist);
  });
}

function refineJourney(id: number) {
  let pending = 0, scheduled = false;
  const redraw = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; if (id === journeyReq) { routeKey = ''; updateProgress(); } });
  };
  const task = <T>(promise: Promise<T>, apply: (res: T) => void) => {
    pending++;
    promise.then((res) => { if (id !== journeyReq) return; apply(res); geoVersion++; redraw(); });
  };
  const keys3d = new Set(journeySteps.map((st) => (s3Plan(st) || {}).key).filter(Boolean));
  // get the 3D view ready in the background, so "3D view" opens at once
  if (keys3d.size) setTimeout(() => { if (id === journeyReq) keys3d.forEach((k) => Station3D.preload(k)); }, 2500);
  journeySteps.forEach((st) => {
    const plan = (st.lines || []).length ? s3Plan(st) : null;
    if (plan) refineStationWalk(st as JourneyWalkStep | JourneyChangeStep, plan, task);
    else if (st.type === 'walk' || st.type === 'change') refineWalk(st, task);
    if (st.type === 'ride') task(routeRide(st.path, modeOf(st.s.journey.category)), (res) => { st.path = res; });
  });
}

// Timetable data: transport.opendata.ch (the official Swiss timetable, incl. SBB, PostBus, city transport)
const OPENDATA = 'https://transport.opendata.ch/v1/';
const coordParam = (ll: LngLat) => `${ll[1].toFixed(6)},${ll[0].toFixed(6)}`; // lat,lng
async function nearestStation(ll: LngLat) {
  const res = await fetch(`${OPENDATA}locations?` + new URLSearchParams({ x: ll[1], y: ll[0], type: 'station' } as {} as Record<string, string>));
  const data: OdLocationsResponse = await res.json();
  const st = (data.stations || []).find((x) => x.id);
  return st ? st.id! : null;
}
// → { list, best, … } as KanteJourney.plans() gives it (no walking all the way, no earlier / later), or null
async function connections(from: string | null, to: string | null): Promise<JourneyOptions | null> {
  if (!from || !to) return null;
  const q: Record<string, string> = { from, to, limit: '5' };
  const { mode, date, time } = journeyQuery;
  if (date) q.date = date;
  if (time) q.time = time;
  if (mode === 'arr' && (date || time)) q.isArrivalTime = '1';
  const params = new URLSearchParams(q);
  SETTINGS.transportations().forEach((t) => params.append('transportations[]', t));
  const res = await fetch(`${OPENDATA}connections?` + params);
  const data: OdConnectionsResponse = await res.json();
  // Settings: walks retimed to your walking speed; prefer connections whose walks and changes fit
  const all = (data.connections || []).map(SETTINGS.retime);
  const fits = all.filter(SETTINGS.connectionFits);
  const list = (fits.length ? fits : all).sort((a, b) => (new Date(a.from.departure!) as unknown as number) - (new Date(b.from.departure!) as unknown as number));
  if (!list.length) return null;
  const offer = (shown: OdConnection[], best: OdConnection) => ({ list: shown, best, walk: null, earlier: false, later: false });
  if (mode === 'arr' && (date || time)) {
    // those that still arrive by the chosen time; first the one that leaves last
    const target = new Date(`${date || dateValue(new Date())}T${time || timeValue(new Date())}`).getTime();
    const ok = list.filter((c) => new Date(c.to.arrival!).getTime() <= target + 60000);
    const shown = ok.length ? ok : list;
    return offer(shown, shown.reduce((best, c) => (new Date(c.to.arrival!) > new Date(best.to.arrival!) ? c : best)));
  }
  const after = date || time
    ? new Date(`${date || dateValue(new Date())}T${time || timeValue(new Date())}`).getTime() - 60000
    : Date.now() - 60000;
  const ahead = list.filter((c) => new Date(c.from.departure!).getTime() >= after);
  const shown = ahead.length ? ahead : list;
  return offer(shown, shown[0]);
}
// Exact coordinates can fail when a point is far from any stop (e.g. a municipality's centre in the fields),
// so fall back to the place name and then to the nearest stations at either end.
// → every way on offer: { list, walk, best, earlier, later }, or null
async function findOptions(fromLL: LngLat, r: JourneyDest): Promise<JourneyOptions | null> {
  // the team's own Kante engine first (engine-journey.js); without an answer from it, the public timetable below
  const own = window.KanteJourney ? await KanteJourney.plans(fromLL, r, journeyQuery) : null;
  if (own) return own;
  const from = coordParam(fromLL), to = coordParam(r.lngLat);
  let c = await connections(from, to);
  if (c) return c;
  if (r.origin === 'gg25' || r.origin === 'gazetteer') {
    c = await connections(from, r.title.replace(/\s*\([A-Z]{2}\)\s*$/, ''));
    if (c) return c;
  }
  const toStation = await nearestStation(r.lngLat);
  c = await connections(from, toStation);
  if (c) return c;
  const fromStation = await nearestStation(fromLL);
  return connections(fromStation, toStation);
}

// keepPlan: only the destination goes (its field was cleared); the card and the start stay for another one
function endJourney(keepPlan?: boolean) {
  const had = !!journeyDest;
  journeyReq++;
  document.body.classList.remove('journey-mode');
  setFollowing(false);
  clearInterval(progressTimer);
  clearInterval(liveTimer);
  clearInterval(kanteTimer);
  journeyConn = null;
  journeyDest = null;
  journeyOptions = null;
  journeyList = false;
  journeyMore = null;
  vehUpdate(); // live vehicles come back (from zoom 14)
  updateCards(); // events and places come back if they were on
  updatePlaces();
  track = null;
  jFocus = null;
  sheetMsg = '';
  headKey = '';
  jHead.replaceChildren();
  jBody.replaceChildren();
  jFoot.replaceChildren();
  sheetY = window.innerHeight;
  nowMarker.remove();
  vehMarker.remove();
  closeTimeSheet();
  setRoute([]);
  journeySteps = [];
  placeUserDot(); // back to plain GPS
  destMarker.remove();
  clearPlacePins();
  armPin(null);
  pinMenu.remove();
  setField('to', '');
  results = [];
  lastSearch = null;
  updateWhenChip();
  render();
  if (keepPlan === true) return;
  tripStart = null;
  startMarker.remove();
  setField('from', '');
  blurSearch();
  setPlanOpen(false);
  if (had && userLngLat) map.flyTo({ center: userLngLat, zoom: 15 });
}
