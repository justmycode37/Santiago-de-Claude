// ---------- Accurate route shapes ----------
// Walks are the Kante engine's (its path comes with every walk of a journey, and from /api/walk). The engine's rides
// only give stop coordinates, so the lines between them are routed: trains → BRouter rail profile (brouter.de),
// buses/trams → OSM road routing. Anything implausible falls back to the straight line.
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

// What the ride routers answer, as far as it is read: OSRM (routing.openstreetmap.de), BRouter
interface OsrmRoute { geometry: { coordinates: LngLat[] }; distance: number }
interface OsrmAnswer { code: string; routes: OsrmRoute[] }
interface BrouterAnswer { features?: { geometry: { coordinates: number[][] } }[] }
// A walk between two points, by the Kante engine (/api/walk): its path, metres, written directions, floor changes, the
// door it ends at, its stretches under a roof and its guessed ends. ends: [from, to], what each end is (WalkEnd): a
// boarding point (by the engine's id), a point taken as it is, or a place (the walk then ends at its door). Without an
// answer (no path, or the engine is off or down): the straight line.
async function routeWalk(a: LngLat, b: LngLat, ends?: [WalkEnd, WalkEnd]): Promise<RoutedWalk> {
  const [from, to] = ends || [{}, {}];
  const place = (p: LngLat, e: WalkEnd): KantePlaceRef => ({ lat: p[1], lon: p[0], ...(e.quay ? { quay: e.quay } : {}), ...(e.exact ? { exact: true } : {}) });
  try {
    const leg = window.KANTE && (await window.KANTE.walk({ from: place(a, from), to: place(b, to), options: KanteJourney.options() }));
    const r = leg && KanteJourney.routed(leg);
    if (r) return r;
  } catch (e) { /* the straight line */ }
  return { coords: [a, b], steps: null, dist: null, approx: true };
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
    const walks = await Promise.all(lines.map((l, k) => routeWalk(l[0], k === lines.length - 1 ? walkGoal(st, l[l.length - 1]) : l[l.length - 1], ends[k])));
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
  // to the destination: to the place itself, so that the engine picks its door
  if (!route.toStop) await join(inside[inside.length - 1], walkGoal(st, b), [{ exact: true }, (ends[ends.length - 1] || [])[1] || {}]);
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
    const sig = walkSig(st);
    // routed for these lines, ends and platforms already, or asked for and the answer still on its way
    if (onlyMoved && ((st._netFor === st.lines && st._netSig === sig) || (st._askFor === st.lines && st._askSig === sig))) return;
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
  const stops = st.type === 'change' ? [st.prev.to, st.next.from] : [st.from && st.from.to, st.next && st.next.from];
  return JSON.stringify([st.ends || [], stops.map((s) => (s ? platformOf(s) : ''))]);
};
// A new revision of a walk's route: answers for older ones (it has been moved or rerouted since) are dropped
function newWalkRev(st: JourneyWalkStep | JourneyChangeStep) {
  const rev = (st.walkRev = (st.walkRev || 0) + 1), sig = walkSig(st);
  st._askFor = st.lines;
  st._askSig = sig;
  const current = () => st.walkRev === rev && journeySteps.includes(st);
  // the answer is in: this line, for these ends and platforms, has its route
  const done = () => { st._netFor = st.lines; st._netSig = sig; };
  return Object.assign(current, { done });
}
// Through a station with a 3D model: its own paths (right underpass, stairs, lifts), not the street router or the
// engine's path, so the map shows the same way as the 3D view
function refineStationWalk(st: JourneyWalkStep | JourneyChangeStep, plan: StationWalkPlan, task: WalkTask) {
  const first = st.walkRev == null;
  const current = newWalkRev(st);
  // moved since the plan: the engine's time for the walk as it now stands (the model draws its way)
  const all = (st.lines || []).flat();
  if (!first && all.length > 1) {
    const ends = st.ends || [];
    task(routeWalk(all[0], walkGoal(st, all[all.length - 1]), [(ends[0] || [])[0] || {}, (ends[ends.length - 1] || [])[1] || {}]), (res) => { if (current()) walkTime(st, res); });
  }
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
// One walk (or change). As planned it has the engine's walk already; moved since, or at another platform at the same
// point (a live platform change), the engine is asked again between its ends. Each request carries the walk's revision:
// an answer for an older revision (the walk has been moved or rerouted since) is dropped.
function refineWalk(st: JourneyWalkStep | JourneyChangeStep, task: WalkTask) {
  const first = st.walkRev == null;
  const current = newWalkRev(st);
  if (first) { current.done(); return; } // the engine's walk as the plan came (a walk it found no path for stays straight)
  const lines = st.lines || [];
  lines.forEach((line, k) => task(routeWalk(line[0], k === lines.length - 1 ? walkGoal(st, line[line.length - 1]) : line[line.length - 1], st.ends && st.ends[k]), (res) => {
    if (!current()) return;
    st.lines[k] = res.coords;
    (st.walks || (st.walks = []))[k] = res;
    if (lines.length === 1) { st.kanteWalk = !res.approx; walkTime(st, res); }
    // floor changes where the walk actually takes them (else the platform levels imply one)
    const floors = st.walks.flatMap((w) => (w && w.floors) || []);
    st.floors = floors.length ? floors : null;
    current.done();
    queueSheet(); // metres and written directions
  }));
}

// The engine's time for a walk routed again: its time on foot, its minutes, and for the walk to the first ride when
// to leave (so as to be at the stop at the same time)
function walkTime(st: JourneyWalkStep | JourneyChangeStep, res: RoutedWalk) {
  if (res.walkS == null) return;
  st.walkS = res.walkS;
  const min = Math.round((res.shownS != null ? res.shownS : res.walkS) / 60);
  if (st.type === 'change') st.walkMin = min; else st.min = min;
  if (st.type === 'walk' && !st.final && st.t1 != null) st.t0 = st.t1 - res.walkS * 1000;
}

// Where a walk leads: for the walk to the destination the place itself, not the door its last route ended at (which
// the router would take for a point on the building's wall)
const walkGoal = (st: JourneyWalkStep | JourneyChangeStep, end: LngLat) => (st.type === 'walk' && st.final && st.toLL) || end;

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
    if (st.type === 'ride') task(routeRide(st.path, modeOf(st.s.line.category)), (res) => { st.path = res; });
  });
}

// keepPlan: only the destination goes (its field was cleared); the card and the start stay for another one
function endJourney(keepPlan?: boolean) {
  const had = !!journeyDest;
  journeyReq++;
  document.body.classList.remove('journey-mode');
  setFollowing(false);
  clearInterval(progressTimer);
  clearInterval(liveTimer);
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
  sheetRetry = false;
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
