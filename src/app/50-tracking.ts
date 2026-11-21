// ---------- Live tracking: where you and your vehicle are on the trip ----------
// Swiss operators publish no open live vehicle positions, so a vehicle is placed from its live (real-time)
// stop times; you are followed by GPS, snapped onto the trip's line. Without GPS, the live times place you.
let geoVersion = 1; // bumped whenever a step's line changes (real walking paths and tracks arrive)
let track: TrackState | null = null;   // GPS progress: { i (step), kmIn (km into it), km (into the trip), d (m off the line), off, missed, arrived }
let autoStep = 0;   // the step GPS last moved the cards to
let userPickedAt = 0;

// A step's line in travel order (a change without a walk is just the platform)
function stepLine(st: JourneyStep): LngLat[] {
  if (st._lv === geoVersion) return st._line!;
  let cs = st.type === 'ride' ? st.path : (st.lines || []).flat();
  if (!cs.length && st.type === 'change') cs = st.points.filter(Boolean).slice(-1) as LngLat[];
  st._lv = geoVersion;
  st._line = cs || [];
  return st._line;
}
let layCache: TripLayout | null = null;
function tripLayout(): TripLayout {
  if (layCache && layCache.v === geoVersion && layCache.steps === journeySteps) return layCache;
  const lens: number[] = [], km0: number[] = [];
  let total = 0;
  journeySteps.forEach((st) => { km0.push(total); const l = lengthKm(stepLine(st)); lens.push(l); total += l; });
  layCache = { v: geoVersion, steps: journeySteps, lens, km0, total };
  return layCache;
}
function cumKm(cs: LngLat[]) {
  const out = [0];
  for (let k = 1; k < cs.length; k++) out.push(out[k - 1] + distKm(cs[k - 1], cs[k]));
  return out;
}
// Closest point to p on the segment a→b (flat approximation, fine over a few km) → { d: metres, t: 0…1 }
function projectSeg(p: LngLat, a: LngLat, b: LngLat): SegProjection {
  const kx = 111320 * Math.cos(p[1] * Math.PI / 180), ky = 110540;
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky;
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / L2)) : 0;
  return { d: Math.hypot(ax + dx * t, ay + dy * t), t };
}
function pointAtKm(cs: LngLat[], km: number): LngLat | null {
  if (!cs.length) return null;
  const len = lengthKm(cs);
  return cs.length < 2 || !len ? cs[0] : splitLine(cs, Math.min(1, Math.max(0, km / len)))[2];
}
// How far along a ride's line (km) each of its stops is
function stopKms(st: JourneyRideStep): number[] {
  if (st._kmFor === st.path) return st._kms!;
  const cs = st.path, cum = cumKm(cs);
  let j0 = 0;
  st._kms = st.stops.map((p) => {
    let best: { d: number; j: number; km: number } | null = null;
    for (let j = j0; j < cs.length - 1; j++) {
      const q = projectSeg(p, cs[j], cs[j + 1]);
      if (!best || q.d < best.d) best = { d: q.d, j, km: cum[j] + q.t * (cum[j + 1] - cum[j]) };
      if (q.d < 40) break; // the line runs through every stop: take the first pass, not a later one nearby
    }
    if (!best) return cum[cum.length - 1];
    j0 = best.j;
    return best.km;
  });
  st._kmFor = cs;
  return st._kms;
}

// Where a ride's vehicle is now → { km, at } or { km, from, to } (+ engine: the Kante engine's position, when it
// placed it), or null when it is not on this part of its route
function vehicleState(st: JourneyRideStep, now: number): VehicleState | null { return engineVehicle(st, now) || timedVehicle(st, now); }
// The engine's position (timed from measured stops, forecasts or on-board reports), laid onto the drawn ride
function engineVehicle(st: JourneyRideStep, now: number): EngineVehiclePlace | null {
  const k = st.s._k, trip = k && k.trip, pos = trip && trip.position;
  if (!pos || !engineFresh(st.s) || !k.seqIdx) return null;
  const list = st.s.journey.passList || [];
  // the engine's "now": the position's t plus the time since that answer came in (so a wrong phone clock doesn't matter)
  const tNow = (pos.t != null ? pos.t : k.at / 1000) + (now - k.at) / 1000;
  const p = KANTE_LIVE.advance(pos, trip.calls, tNow);
  // the engine's stops laid onto ours by station (k.seqIdx); a stop we can't pair leaves the timetable placing below
  const r = KANTE_LIVE.rideKm(p, k.seqIdx, stopKms(st), st.stopIdx || []);
  if (!r) return null;
  const name = (x: number) => list[x] && list[x].station && list[x].station.name;
  return r.at != null ? { km: r.km, at: name(r.at), engine: p!, tNow } : { km: r.km, from: name(r.from), to: name(r.to), engine: p!, tNow };
}
// From its live stop times: at a stop while it is due there, else between two stops in proportion to time
function timedVehicle(st: JourneyRideStep, now: number): TimedVehiclePlace | null {
  interface TimedStop { km: number; a: number; d: number; name: string | null | undefined }
  const list = st.s.journey.passList, last = list.length - 1, kms = stopKms(st);
  const pts = (st.stopIdx || []).map((k, m) => {
    const stop = k === 0 ? st.s.departure : k === last ? st.s.arrival : list[k];
    const a = liveMs(stop, 'arrival'), d = liveMs(stop, 'departure');
    return { km: kms[m], a: a != null ? a : d, d: d != null ? d : a, name: stop.station && stop.station.name };
  }).filter((x): x is TimedStop => x.a != null && x.km != null);
  if (pts.length < 2 || now < pts[0].d || now > pts[pts.length - 1].a) return null;
  for (let n = 0; n < pts.length - 1; n++) {
    const p = pts[n], q = pts[n + 1];
    if (now <= p.d) return { km: p.km, at: p.name };
    if (now < q.a) return { km: p.km + (q.km - p.km) * ((now - p.d) / Math.max(1, q.a - p.d)), from: p.name, to: q.name };
  }
  const z = pts[pts.length - 1];
  return { km: z.km, at: z.name };
}

// Where the live timetable says you are → { i, kmIn, ended }, or null before the trip starts
function timeProgress(now = Date.now()): TimedPlace | null {
  let last: TimedPlace | null = null;
  for (let i = 0; i < journeySteps.length; i++) {
    const st = journeySteps[i];
    if (st.t0 == null || st.t1 == null) continue;
    if (now < st.t0) return last; // between steps: waiting where the last one ended
    const len = tripLayout().lens[i];
    if (now >= st.t1) { last = { i, kmIn: len }; continue; }
    let k = null;
    if (st.type === 'ride') { const v = vehicleState(st, now); k = v && v.km; }
    else if (st.type === 'change' && st.walkMin > 0) k = Math.min(1, (now - st.t0) / (st.walkMin * 60000)) * len;
    if (k == null) k = ((now - st.t0) / Math.max(1, st.t1 - st.t0)) * len;
    return { i, kmIn: k };
  }
  return last && { ...last, ended: true };
}

// The trip is under way (or about to be): only then does GPS move you along it, so a trip planned for later is left alone
function journeyEnd() {
  const a = journeySteps[journeySteps.length - 1];
  return a && a.time != null ? new Date(a.time).getTime() : new Date(journeyConn!.to.arrival!).getTime();
}
function tripLive(now = Date.now()) {
  const first = journeySteps.find((st) => st.t0 != null);
  return !!first && now >= first.t0! - 30 * 60000 && now <= journeyEnd() + 30 * 60000;
}

// Snap a GPS position onto the trip. Ties go to the earlier step (waiting at the stop, not yet riding);
// going backwards and boarding before the vehicle has left are penalised, so loops and parallel lines stay right.
// near: how far you are from the step you are counted on or one of its neighbours. It decides "off the route":
// on the platform before your train leaves, the step you are counted on is still the walk there, whose drawn
// line can end well short of the platform, and that distance must not make you off the route.
function snapToTrip(p: LngLat, ref: number, now: number): TripSnap | null {
  const lay = tripLayout();
  let best: Omit<TripSnap, 'near'> | null = null;
  const off: number[] = []; // metres to each step's line
  journeySteps.forEach((st, i) => {
    const cs = stepLine(st);
    if (!cs.length) return;
    const early = st.type === 'ride' && st.t0 != null && now < st.t0 - 60000 ? 150 : 0;
    const consider = (d: number, kmIn: number) => {
      const km = lay.km0[i] + kmIn;
      const cost = d + early + (km < ref ? (ref - km) * 500 : (km - ref) * 20);
      if (off[i] == null || d < off[i]) off[i] = d;
      if (!best || cost < best.cost) best = { cost, d, i, kmIn, km };
    };
    if (cs.length === 1) { consider(distKm(p, cs[0]) * 1000, 0); return; }
    const cum = cumKm(cs);
    for (let j = 0; j < cs.length - 1; j++) {
      const q = projectSeg(p, cs[j], cs[j + 1]);
      consider(q.d, cum[j] + q.t * (cum[j + 1] - cum[j]));
    }
  });
  const snap = best as Omit<TripSnap, 'near'> | null; // (assigned inside consider(), which the compiler does not follow)
  if (!snap) return null;
  // the step you are counted on, the one before and the one after: a later part of the trip that happens to
  // pass by does not hide that you have left this one
  const near = Math.min(...[snap.i - 1, snap.i, snap.i + 1].map((k) => (off[k] == null ? Infinity : off[k])));
  return { ...snap, near };
}

// Still at (or on the way to) the stop of a ride that has left without you?
function missedRide(t: TripPlace, now: number): JourneyRideStep | null {
  if (fixAge() > 20000) return null;
  const st = journeySteps[t.i];
  const r = st.type === 'ride' ? st : st.nextRide;
  if (!r || r.t0 == null || now < r.t0 + 90000) return null;
  if (st === r && t.kmIn > 0.1) return null; // moving along it: on board
  const v = vehicleState(r, now);
  return !v || v.km > 0.4 ? r : null;
}

// On a walk, the blue dot sits on the walking route while GPS puts you within its accuracy of it (the halo stays
// where GPS says), so it does not wander through walls; on a ride, or away from the route, it shows GPS as it is.
function placeUserDot() {
  if (!userLngLat) return;
  let at: LngLat = userLngLat;
  const st = track && !track.off && !track.arrived ? journeySteps[track.i] : null;
  const routed = !!st && st.type !== 'ride' && (st.walks || []).some((w) => w && w.net && !w.approx); // only onto real paths, never a straight guess
  if (routed && track && track.d <= Math.max(12, Math.min(userAccuracy, 40))) at = pointAtKm(stepLine(st!), track.kmIn) || at;
  userMarker.setLngLat(at);
}
function trackJourney() {
  trackOnce();
  placeUserDot();
}
function trackOnce() {
  if (!journeySteps.length || !gpsOn() || !tripLive()) { track = null; return; }
  const now = Date.now(), lay = tripLayout(), tp = timeProgress(now);
  // where you were at the last fix (measured on today's lines), else where the timetable puts you
  const ref = track && !track.off && track.v === geoVersion ? track.km : tp ? lay.km0[tp.i] + tp.kmIn : 0;
  const s = snapToTrip(userLngLat!, ref, now);
  if (!s) { track = null; return; }
  // walks follow exact footpaths now, so leaving one shows sooner than leaving a ride's line
  const here = journeySteps[s.i];
  const onFoot = here.type !== 'ride' && (here.walks || []).some((w) => w && w.net && !w.approx);
  const tol = onFoot ? Math.max(25, Math.min(userAccuracy, 150)) + 20 : Math.max(35, Math.min(userAccuracy, 150)) + 30;
  // A trip that starts somewhere else: you are not "off the route" before you have been on it
  // (once you have been on it, leaving it again is "off the route", however long that lasts)
  const onRoute = !!(track && track.onRoute) || s.near <= tol;
  if (tripStart && !onRoute) { track = null; return; }
  const offCount = s.near > tol ? ((track && track.offCount) || 0) + 1 : 0;
  track = { ...s, v: geoVersion, offCount, off: offCount >= 2, onRoute }; // two fixes in a row, so one stray fix doesn't count
  if (track.off) return;
  const dest = destMarker._map && destMarker.getLngLat().toArray();
  if (lay.total - s.km < 0.025 || (dest && distKm(userLngLat!, dest) < Math.min(0.04, Math.max(0.02, userAccuracy / 1000)))) {
    Object.assign(track, { i: journeySteps.length - 1, kmIn: 0, km: lay.total, arrived: true });
  }
  track.missed = track.arrived ? null : missedRide(track, now);
  // move the cards along with you, unless you have just picked a step yourself
  if (!track.missed && track.i !== autoStep) {
    autoStep = track.i;
    if (now - userPickedAt > 20000 && !journeyList) goToStep(track.i, true);
  }
}

// Your place on the trip: GPS when it is following you, else the live timetable
function journeyProgress(): TripPlace | null {
  if (track && !track.off && gpsOn()) return track;
  return journeySteps.length ? timeProgress() : null;
}
// …as a moment of the trip, for the bar at the top
function progressTime() {
  const t = track && !track.off && gpsOn() ? track : null;
  if (!t) return { t: Date.now(), gps: false };
  if (t.arrived) return { t: Infinity, gps: true };
  const st = journeySteps[t.i], len = tripLayout().lens[t.i];
  if (st.t0 == null || st.t1 == null) return { t: Date.now(), gps: false };
  return { t: st.t0 + (st.t1 - st.t0) * (len ? Math.min(1, t.kmIn / len) : 1), gps: true };
}

// Map markers: the vehicle of the ride under way, and (without GPS) where the timetable says you are
const nowEl = document.createElement('div');
nowEl.className = 'route-now';
nowEl.title = 'Estimated from the live timetable (no GPS)';
const nowMarker = new maplibregl.Marker({ element: nowEl });
const vehEl = document.createElement('div');
vehEl.className = 'route-veh';
vehEl.setAttribute('role', 'img');
vehEl.title = 'Position estimated from live departure times';
vehEl.addEventListener('click', () => showToast(vehEl.title, 5000)); // phones have no hover: a tap says how it was placed
const vehMarker = new maplibregl.Marker({ element: vehEl });
// How the vehicle was placed, honestly: measured, forecast or timetable → { text, dim }
function vehicleHonesty(st: JourneyRideStep, v: VehicleState, now: number) {
  const k = st.s._k, trip = k && engineFresh(st.s, true) ? k.trip : null, info = trip && KANTE_LIVE.liveInfoOf(trip);
  // the engine had this ride but has stopped answering, and transport.opendata.ch has not refreshed it since
  if (k && k.trip && !trip && k.fails! >= 2 && !(st.s._liveAt! > k.at)) return KANTE_LIVE.liveText({ state: 'stale' });
  if (v.engine) {
    const p = v.engine, calls = new Map((trip!.calls || []).map((c) => [c.seq, c]));
    // "Left Zytglogge 1 min ago (measured)" only when that departure itself was measured: not when the vehicle was
    // only moved on from a stop because its departure time had passed (p.stepped)
    const measuredHere = p.state === 'between' && !p.stepped && KANTE_LIVE.depMeasured(info, p.seq);
    const dep = measuredHere ? (p.dep != null ? p.dep : KANTE_LIVE.liveDep(calls.get(p.seq))) : null;
    const obs = info && info.observedSeq != null ? calls.get(info.observedSeq) : null;
    return KANTE_LIVE.liveText(info, { basis: p.basis, from: v.from,
      leftS: dep != null ? Math.max(0, v.tNow - dep) : null, observedAt: obs && obs.quay && obs.quay.stationName });
  }
  if (info && info.state === 'stale') return KANTE_LIVE.liveText(info);
  const forecast = [st.s.departure, st.s.arrival, ...(st.s.journey.passList || [])].some((x) => x && x.prognosis && (x.prognosis.departure || x.prognosis.arrival));
  return forecast ? { text: 'Estimated from forecasts', dim: false } : KANTE_LIVE.liveText({ state: 'timetable' });
}
function updateNowMarker() {
  const now = Date.now();
  const ride = journeySteps.find((st): st is JourneyRideStep => st.type === 'ride' && st.t0 != null && now >= st.t0 && now <= st.t1!);
  const gps = !!track && !track.off && gpsOn();
  // once GPS shows you on board, your blue dot is the vehicle
  const v = ride && !(gps && journeySteps[track!.i] === ride && !track!.missed) ? vehicleState(ride, now) : null;
  if (v && ride!.path.length > 1) {
    const j = ride!.s.journey, key = lineLabel(j) + '|' + j.category;
    if (vehEl.dataset.key !== key) {
      vehEl.dataset.key = key;
      vehEl.innerHTML = icon(modeOf(j.category));
      vehEl.appendChild(document.createTextNode(lineLabel(j)));
      lineVars(vehEl, j);
    }
    const how = vehicleHonesty(ride!, v, now);
    if (vehEl.title !== how.text) {
      vehEl.title = how.text;
      vehEl.setAttribute('aria-label', `${MODE_NAME[modeOf(j.category)] || 'Vehicle'} ${lineLabel(j)}: ${how.text}`);
    }
    vehEl.classList.toggle('dim', how.dim);
    vehMarker.setLngLat(pointAtKm(ride!.path, v.km)!);
    if (!vehMarker._map) vehMarker.addTo(map);
  } else vehMarker.remove();
  const tp = !gpsOn() && !ride ? timeProgress(now) : null;
  const pos = tp && !tp.ended ? pointAtKm(stepLine(journeySteps[tp.i]), tp.kmIn) : null;
  if (pos) { nowMarker.setLngLat(pos); if (!nowMarker._map) nowMarker.addTo(map); }
  else nowMarker.remove();
}
