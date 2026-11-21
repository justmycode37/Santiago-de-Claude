// ---------- Accurate route shapes ----------
// Timetables only give stop coordinates, so the lines between them are routed:
//   walking → OSM foot routing (routing.openstreetmap.de), trains → BRouter rail profile (brouter.de),
//   buses/trams → OSM road routing. Anything implausible falls back to the straight line.
const routeCache = new Map();
function getJSON(url) {
  if (!routeCache.has(url)) routeCache.set(url, fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return routeCache.get(url);
}
function distKm(a, b) {
  const R = 6371, toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad, dLng = (b[0] - a[0]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const lengthKm = (cs) => cs.reduce((sum, c, i) => (i ? sum + distKm(cs[i - 1], c) : 0), 0);
const plausible = (route, straight) => route && route.length > 1 && lengthKm(route) <= Math.max(lengthKm(straight) * 2.5, lengthKm(straight) + 0.4);
const ll = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;

// → { coords, steps (OSRM turn-by-turn, or null), dist (m, or null) }
async function routeWalk(a, b) {
  if (distKm(a, b) < 0.02) return { coords: [a, b], steps: null, dist: Math.round(distKm(a, b) * 1000) };
  const costing = SETTINGS.walkCosting();
  if (costing) return routeWalkAccessible(a, b, costing);
  const d = await getJSON(`https://routing.openstreetmap.de/routed-foot/route/v1/foot/${ll(a)};${ll(b)}?overview=full&geometries=geojson&steps=true`);
  const r = d && d.code === 'Ok' && d.routes[0];
  const g = r && r.geometry.coordinates;
  return plausible(g, [a, b]) ? { coords: [a, ...g, b], steps: r.legs[0].steps, dist: r.distance } : { coords: [a, b], steps: null, dist: null };
}

// Step-free / fewer-stairs walks (Settings › Journeys): Valhalla on the FOSSGIS server can avoid steps
// and route for wheelchairs. One request at a time, to go easy on the free server.
function decodePolyline6(str) {
  const out = [];
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
let valhallaQueue = Promise.resolve();
async function routeWalkAccessible(a, b, costing) {
  const q = {
    locations: [{ lon: a[0], lat: a[1] }, { lon: b[0], lat: b[1] }],
    costing: 'pedestrian', costing_options: { pedestrian: costing }, directions_type: 'none',
  };
  const url = 'https://valhalla1.openstreetmap.de/route?json=' + encodeURIComponent(JSON.stringify(q));
  const d = await (valhallaQueue = valhallaQueue.then(() => getJSON(url)));
  const t = d && d.trip;
  const g = t && t.legs && t.legs[0] && decodePolyline6(t.legs[0].shape);
  // step-free paths can detour more than normal walks; when none is found, show only the straight line
  const direct = distKm(a, b);
  const ok = g && g.length > 1 && lengthKm(g) <= Math.max(direct * 4, direct + 0.8);
  return ok ? { coords: [a, ...g, b], steps: null, dist: Math.round(t.summary.length * 1000) } : { coords: [a, b], steps: null, dist: null };
}

async function routeRide(path, mode) {
  if (path.length < 2) return path;
  let g = null;
  if (mode === 'train') {
    const d = await getJSON(`https://brouter.de/brouter?lonlats=${path.map(ll).join('|')}&profile=rail&alternativeidx=0&format=geojson`);
    g = d && d.features && d.features[0] && d.features[0].geometry.coordinates.map((c) => [c[0], c[1]]);
  } else if (mode === 'bus' || mode === 'tram') {
    const d = await getJSON(`https://routing.openstreetmap.de/routed-car/route/v1/driving/${path.map(ll).join(';')}?overview=full&geometries=geojson`);
    g = d && d.code === 'Ok' && d.routes[0] && d.routes[0].geometry.coordinates;
  }
  return plausible(g, path) ? [path[0], ...g, path[path.length - 1]] : path;
}

// A walk that passes through a station with a 3D model: the model's route for the part inside it, the street
// router for what lies before and after. Falls back to the street router alone when the model has no route.
async function stationWalk(st, plan) {
  const lines = st.lines.map((l) => l.slice());
  const a = lines[0][0], last = lines[lines.length - 1], b = last[last.length - 1];
  const street = async () => {
    const walks = await Promise.all(lines.map((l) => routeWalk(l[0], l[l.length - 1])));
    return { lines: walks.map((w) => w.coords), walks, floors: null };
  };
  let model = null, route = null;
  try {
    model = await Station3D.loadData(plan.key);
    route = model && StationRoute.route(model, plan.from, plan.to, s3Prefs(st));
  } catch (e) { route = null; }
  // no path in the model: the street router, or for a walk the Kante engine has routed, the engine's own path
  if (!route || route.points.length < 2 || route.same) return st.kanteWalk ? null : street();
  const inside = route.points.map((p) => StationRoute.toLngLat(model, p));
  const parts = [], walks = [];
  const join = async (p, q) => { // the stretch between the walk's end and where the model's paths begin
    if (distKm(p, q) < 0.03) return;
    const w = await routeWalk(p, q);
    parts.push(w.coords);
    walks.push(w);
  };
  // only for free positions: a route from a platform starts wherever it is best to leave that platform
  if (!route.fromStop) await join(a, inside[0]);
  const whole = (x) => Math.round(x);
  // the station's own written directions, in the shape walkDirections() lists them
  const dirs = route.steps.filter((s) => s.kind !== 'arrive').map((s, k) => {
    const change = s.kind !== 'walk' && whole(s.toLevel) !== whole(s.level);
    const d = { kind: change ? (s.toLevel < s.level ? 'stairs-down' : 'stairs-up') : k === 0 && !parts.length ? 'depart' : 'walk',
      text: s.text, coords: inside.slice(s.from, s.to + 1) };
    if (change) { d.from = whole(s.level); d.to = whole(s.toLevel); }
    return d;
  });
  parts.push(inside);
  walks.push({ coords: inside, steps: null, dist: route.length, dirs });
  if (!route.toStop) await join(inside[inside.length - 1], b);
  const floors = dirs.filter((d) => d.from != null).map((d) => ({ at: d.coords[0], from: d.from, to: d.to }));
  return { lines: parts, walks, floors };
}

function refineJourney(id) {
  let pending = 0, scheduled = false;
  const redraw = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; if (id === journeyReq) { routeKey = ''; updateProgress(); } });
  };
  const task = (promise, apply) => {
    pending++;
    promise.then((res) => { if (id !== journeyReq) return; apply(res); geoVersion++; redraw(); });
  };
  const keys3d = new Set(journeySteps.map((st) => (s3Plan(st) || {}).key).filter(Boolean));
  // get the 3D view ready in the background, so "3D view" opens at once
  if (keys3d.size) setTimeout(() => { if (id === journeyReq) keys3d.forEach((k) => Station3D.preload(k)); }, 2500);
  journeySteps.forEach((st) => {
    const plan = (st.lines || []).length ? s3Plan(st) : null;
    const lines = plan || st.kanteWalk ? [] : st.lines || []; // a walk the Kante engine has routed is already drawn
    if (plan) {
      // through a station with a 3D model: its own paths (right underpass, stairs, lifts), not the street router
      // or the engine's path, so the map shows the same way as the 3D view
      task(stationWalk(st, plan), (res) => {
        if (!res) return;
        st.lines = res.lines;
        st.walks = res.walks;
        st.floors = res.floors;
        queueSheet();
      });
    } else lines.forEach((line, k) => task(routeWalk(line[0], line[line.length - 1]), (res) => {
      st.lines[k] = res.coords;
      (st.walks || (st.walks = []))[k] = res;
      queueSheet(); // metres and written directions
    }));
    if (st.type === 'ride') task(routeRide(st.path, modeOf(st.s.journey.category)), (res) => { st.path = res; });
  });
}

// Timetable data: transport.opendata.ch (the official Swiss timetable, incl. SBB, PostBus, city transport)
const OPENDATA = 'https://transport.opendata.ch/v1/';
const coordParam = (ll) => `${ll[1].toFixed(6)},${ll[0].toFixed(6)}`; // lat,lng
async function nearestStation(ll) {
  const res = await fetch(`${OPENDATA}locations?` + new URLSearchParams({ x: ll[1], y: ll[0], type: 'station' }));
  const data = await res.json();
  const st = (data.stations || []).find((x) => x.id);
  return st ? st.id : null;
}
async function connections(from, to) {
  if (!from || !to) return null;
  const q = { from, to, limit: '5' };
  const { mode, date, time } = journeyQuery;
  if (date) q.date = date;
  if (time) q.time = time;
  if (mode === 'arr' && (date || time)) q.isArrivalTime = '1';
  const params = new URLSearchParams(q);
  SETTINGS.transportations().forEach((t) => params.append('transportations[]', t));
  const res = await fetch(`${OPENDATA}connections?` + params);
  const data = await res.json();
  // Settings: walks retimed to your walking speed; prefer connections whose walks and changes fit
  const all = (data.connections || []).map(SETTINGS.retime);
  const fits = all.filter(SETTINGS.connectionFits);
  const list = fits.length ? fits : all;
  if (!list.length) return null;
  if (mode === 'arr' && (date || time)) {
    // latest connection that still arrives by the chosen time
    const target = new Date(`${date || dateValue(new Date())}T${time || timeValue(new Date())}`).getTime();
    const ok = list.filter((c) => new Date(c.to.arrival).getTime() <= target + 60000);
    return (ok.length ? ok : list).reduce((best, c) => (new Date(c.to.arrival) > new Date(best.to.arrival) ? c : best));
  }
  const after = date || time
    ? new Date(`${date || dateValue(new Date())}T${time || timeValue(new Date())}`).getTime() - 60000
    : Date.now() - 60000;
  return list.find((c) => new Date(c.from.departure).getTime() >= after) || list[0];
}
// Exact coordinates can fail when a point is far from any stop (e.g. a municipality's centre in the fields),
// so fall back to the place name and then to the nearest stations at either end.
async function findConnection(fromLL, r) {
  // the team's own Kante engine first (engine-journey.js); without an answer from it, the public timetable below
  const own = window.KanteJourney ? await KanteJourney.find(fromLL, r, journeyQuery) : null;
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

function endJourney() {
  journeyReq++;
  wrap.classList.remove('journey-open');
  document.body.classList.remove('journey-mode');
  clearInterval(progressTimer);
  clearInterval(liveTimer);
  clearInterval(kanteTimer);
  journeyConn = null;
  journeyDest = null;
  onboard = null;
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
  destMarker.remove();
  input.value = '';
  results = [];
  clearBtn.classList.remove('show');
  render();
  if (userLngLat) map.flyTo({ center: userLngLat, zoom: 15 });
}
