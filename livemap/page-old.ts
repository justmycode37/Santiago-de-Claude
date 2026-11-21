"use strict";
// MapLibre comes from the page's <script> tag; this file is checked as a module, where a global from a script must be declared.
declare const maplibregl: typeof import("maplibre-gl");
type ModeRow = [key: LiveMapGroup, label: string, colour: string, members: LiveMapMode[]];
const MODES: ModeRow[] = [
  // key, label, colour, members
  ["rail", "Trains", "#d6001c", ["rail", "rack"]],
  ["tram", "Trams", "#0a8f4d", ["tram", "metro"]],
  ["bus", "Buses", "#1d63d8", ["bus", "ondemand"]],
  ["boat", "Boats", "#0891b2", ["boat"]],
  ["cable", "Cable cars", "#c2620a", ["cableway", "funicular", "lift"]],
  ["other", "Other", "#6b7280", ["other"]],
];
const GROUP_OF: Partial<Record<LiveMapMode, LiveMapGroup>> = {}; MODES.forEach(([k, , , ms]) => ms.forEach((m) => (GROUP_OF[m] = k)));
const COLOR = Object.fromEntries(MODES.map(([k, , c]) => [k, c]));
const REFRESH_MS = 10_000;
const hidden = new Set<LiveMapGroup>();
try { JSON.parse(localStorage.getItem("hiddenModes") || "[]").forEach((k: LiveMapGroup) => hidden.add(k)); } catch {}

const map = new maplibregl.Map({
  container: "map",
  style: "https://vectortiles.geo.admin.ch/styles/ch.swisstopo.lightbasemap.vt/style.json",
  center: [8.23, 46.82], zoom: 7.4, minZoom: 6, maxZoom: 18,
  dragRotate: false, pitchWithRotate: false, touchPitch: false, attributionControl: false,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: "Timetable and real-time data: opentransportdata.swiss · Base map © swisstopo" }), "bottom-right");
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), "bottom-right");

const canvas = document.getElementById("dots") as HTMLCanvasElement, ctx = canvas.getContext("2d")!;
const $status = document.getElementById("status")!, $chips = document.getElementById("chips")!, $panel = document.getElementById("panel")!;

/** A decoded path: flat [lon, lat, …], the running length at each of its `n` points. */
interface Path { xy: number[]; cum: Float64Array; n: number }
type LonLat = [lon: number, lat: number];
/** A vehicle on its current hop: from (fx, fy), left at `dep`, to (tx, ty), reached at `arr`. `shape`: the path's id, 0 for none. */
interface Vehicle {
  key: string; tripId: string; date: string;
  line: string; category: string; mode: LiveMapMode; group: LiveMapGroup; operator: string; headsign: string;
  fx: number; fy: number; tx: number; ty: number; dep: number; arr: number; nextStop: string;
  live: LiveMapLiveCode; shape: number;
}
let vehicles: Vehicle[] = [];          // parsed rows
let byKey = new Map<string, Vehicle>();
let clockOffset = 0;        // server seconds minus client seconds
let clockSynced = false;
let feedUpdatedAt: number | null | undefined = null, fetchedAt = 0, fetchError: string | null = null;
let selectedKey: string | null = null, trip: LiveMapTrip | null = null, following = false;
let shapeCache = new Map<number, Path>(); // shape id → decoded path along the rails or road
let shapeEpoch = 0, shapesLoading = false;
let hits: (number | Vehicle)[] = [];              // [x, y, vehicle] of what is on screen
let dirty = true, lastDraw = 0;

const now = () => Date.now() / 1000 + clockOffset;
const esc = (s: string | null | undefined) => String(s ?? "").replace(/[&<>"]/g, (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[c]));
const hhmm = new Intl.DateTimeFormat("de-CH", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich" });
const clock = (t: number | null | undefined) => (t ? hhmm.format(new Date(t * 1000)) : "");

function position(v: Vehicle, t: number): LonLat {
  const span = v.arr - v.dep;
  const f = span <= 0 ? 1 : Math.min(1, Math.max(0, (t - v.dep) / span));
  const s = v.shape && shapeCache.get(v.shape);
  if (s) return along(s, f);
  return [v.fx + (v.tx - v.fx) * f, v.fy + (v.ty - v.fy) * f]; // no path known: straight line
}

// Encoded polyline (precision 5, latitude first) → flat [lon, lat, …] plus running length.
function decodeShape(enc: string): Path {
  const xy: number[] = []; let i = 0, lat = 0, lon = 0;
  while (i < enc.length) {
    for (let k = 0; k < 2; k++) {
      let shift = 0, result = 0, b;
      do { b = enc.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    xy.push(lon / 1e5, lat / 1e5);
  }
  const n = xy.length / 2, cum = new Float64Array(Math.max(n, 1)), c = Math.cos((xy[1] || 47) * Math.PI / 180);
  for (let j = 1; j < n; j++) cum[j] = cum[j - 1] + Math.hypot((xy[2 * j] - xy[2 * j - 2]) * c, xy[2 * j + 1] - xy[2 * j - 1]);
  return { xy, cum, n };
}

// The point a fraction f of the way along a decoded path.
function along(s: Path, f: number): LonLat {
  const target = f * s.cum[s.n - 1];
  let lo = 0, hi = s.n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (s.cum[mid] <= target) lo = mid; else hi = mid; }
  const seg = s.cum[hi] - s.cum[lo], u = seg > 0 ? (target - s.cum[lo]) / seg : 0;
  return [s.xy[2 * lo] + (s.xy[2 * hi] - s.xy[2 * lo]) * u, s.xy[2 * lo + 1] + (s.xy[2 * hi + 1] - s.xy[2 * lo + 1]) * u];
}

async function fetchShapes() {
  if (shapesLoading) return;
  const inUse = new Set(vehicles.map((v) => v.shape).filter(Boolean));
  if (shapeCache.size > 3 * inUse.size + 500) for (const id of shapeCache.keys()) if (!inUse.has(id)) shapeCache.delete(id);
  const need = [...inUse].filter((id) => !shapeCache.has(id));
  if (!need.length) return;
  shapesLoading = true;
  try {
    const res = await fetch("/shapes", { method: "POST", body: JSON.stringify(need satisfies LiveMapShapesRequest) });
    const d: LiveMapShapes = await res.json();
    if (d.epoch === shapeEpoch) for (const [id, enc] of Object.entries(d.shapes)) { const s = decodeShape(enc); if (s.n >= 2) shapeCache.set(Number(id), s); }
    dirty = true;
  } catch { /* straight lines until the next try */ } finally { shapesLoading = false; }
}

let loading = false;
async function load() {
  if (loading) return;
  loading = true;
  try {
    const res = await fetch("/vehicles");
    if (!res.ok) throw new Error("server answered " + res.status);
    const d: LiveMapVehicles = await res.json();
    // Server time now, not the snapshot's build time: the snapshot can be 0–25 s old, and
    // resetting the clock from it made every vehicle lurch on each update.
    const est = (Number(res.headers.get("x-server-time")) || d.t) - Date.now() / 1000;
    if (clockSynced === false || Math.abs(est - clockOffset) > 5) clockOffset = est; else clockOffset = Math.max(clockOffset, est);
    clockSynced = true;
    feedUpdatedAt = d.feedUpdatedAt;
    vehicles = d.vehicles.map((r) => ({
      key: r[0] + "|" + r[1], tripId: r[0], date: r[1], line: r[2], category: r[3], mode: r[4],
      group: GROUP_OF[r[4]] || "other", operator: r[5], headsign: r[6],
      fx: r[7], fy: r[8], tx: r[9], ty: r[10], dep: r[11], arr: r[12], nextStop: r[13], live: r[14], shape: r[15] || 0,
    }));
    if (d.epoch !== shapeEpoch) { shapeEpoch = d.epoch; shapeCache = new Map(); } // server restarted: its shape ids changed
    fetchShapes();
    byKey = new Map(vehicles.map((v) => [v.key, v]));
    fetchedAt = Date.now(); fetchError = null;
    if (selectedKey && !byKey.has(selectedKey)) { renderPanel(null, "This vehicle has finished its journey."); selectedKey = null; trip = null; following = false; setTripLine(null); }
    else if (selectedKey) renderPanel(byKey.get(selectedKey));
    renderChips();
  } catch (e) {
    fetchError = (e as Error).message;
  } finally { loading = false; }
  renderStatus(); dirty = true;
}

function renderStatus() {
  if (!fetchedAt && !fetchError) return;
  const shown = vehicles.filter((v) => !hidden.has(v.group));
  const live = shown.filter((v) => v.live > 0).length;
  const age = feedUpdatedAt ? Math.max(0, Math.round(now() - feedUpdatedAt)) : null;
  $status.innerHTML =
    `<b>${shown.length.toLocaleString("en")}</b> vehicles · <b>${live.toLocaleString("en")}</b> with live data` +
    `<div class="sub">${age === null ? "No live feed, timetable only" : `Live feed generated ${age} s ago`} · estimated positions, not GPS` +
    (fetchError ? ` · <span id="err">update failed: ${esc(fetchError)}</span>` : "") + `</div>`;
}

function renderChips() {
  const counts: Record<string, number> = {};
  for (const v of vehicles) counts[v.group] = (counts[v.group] || 0) + 1;
  $chips.innerHTML = MODES.filter(([k]) => counts[k]).map(([k, label, c]) =>
    `<div class="chip ${hidden.has(k) ? "off" : ""}" data-k="${k}"><i style="background:${c}"></i>${label} ${counts[k].toLocaleString("en")}</div>`).join("");
}
$chips.addEventListener("click", (e) => {
  const k = (e.target as HTMLElement).closest<HTMLElement>(".chip")?.dataset.k as LiveMapGroup | undefined; if (!k) return;
  hidden.has(k) ? hidden.delete(k) : hidden.add(k);
  try { localStorage.setItem("hiddenModes", JSON.stringify([...hidden])); } catch {}
  renderChips(); renderStatus(); dirty = true;
});

// ---------------------------------------------------------------- drawing

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr); canvas.height = Math.round(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); dirty = true;
}
window.addEventListener("resize", resize); resize();
map.on("move", () => (dirty = true));

function draw() {
  const W = canvas.clientWidth, H = canvas.clientHeight, z = map.getZoom(), t = now();
  ctx.clearRect(0, 0, W, H);
  const b = map.getBounds(), pad = 0.02;
  const w = b.getWest() - pad, e = b.getEast() + pad, s = b.getSouth() - pad, n = b.getNorth() + pad;
  const r = z < 8 ? 1.6 : z < 10 ? 2.4 : z < 12 ? 3.6 : z < 14 ? 5.5 : 7.5;
  const groups: Record<string, (number | Vehicle)[]> = {};
  hits = [];
  for (const v of vehicles) {
    if (hidden.has(v.group)) continue;
    const [lon, lat] = position(v, t);
    if (lon < w || lon > e || lat < s || lat > n) continue;
    const p = map.project([lon, lat]);
    (groups[v.group] ||= []).push(p.x, p.y, v);
    hits.push(p.x, p.y, v);
  }
  // Buses first so the rarer trams and trains stay visible on top.
  for (const k of ["other", "bus", "cable", "boat", "tram", "rail"]) {
    const g = groups[k]; if (!g) continue;
    const big = k === "rail" ? r * 1.25 : r;
    // Timetable-only vehicles: hollow ring. Vehicles with live data: solid.
    ctx.fillStyle = COLOR[k]; ctx.beginPath();
    for (let i = 0; i < g.length; i += 3) if ((g[i + 2] as Vehicle).live > 0) { ctx.moveTo((g[i] as number) + big, g[i + 1] as number); ctx.arc(g[i] as number, g[i + 1] as number, big, 0, 6.2832); }
    ctx.fill();
    if (z >= 10) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.strokeStyle = COLOR[k]; ctx.lineWidth = Math.max(1, r * 0.35); ctx.fillStyle = "#fff"; ctx.beginPath();
    for (let i = 0; i < g.length; i += 3) if ((g[i + 2] as Vehicle).live === 0) { ctx.moveTo((g[i] as number) + big, g[i + 1] as number); ctx.arc(g[i] as number, g[i + 1] as number, big * 0.8, 0, 6.2832); }
    ctx.fill(); ctx.stroke();
  }
  if (z >= 12.5) {
    ctx.font = "600 11px system-ui, sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    for (let i = 0; i < hits.length; i += 3) {
      const v = hits[i + 2] as Vehicle, x = (hits[i] as number) + r + 4, y = hits[i + 1] as number, tw = ctx.measureText(v.line).width;
      ctx.fillStyle = "#ffffffd9"; ctx.fillRect(x - 2, y - 7, tw + 4, 14);
      ctx.fillStyle = COLOR[v.group]; ctx.fillText(v.line, x, y + 0.5);
    }
  }
  const sel = selectedKey && byKey.get(selectedKey);
  if (sel) {
    const pos = position(sel, t), p = map.project(pos);
    ctx.strokeStyle = "#16181d"; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y, r + 6, 0, 6.2832); ctx.stroke();
    if (following && !map.isMoving()) map.jumpTo({ center: pos });
  }
}

function frame(ts: number) {
  const z = map.getZoom();
  // Motion is invisible when zoomed out, so redraw rarely there.
  const every = z < 9 ? 2000 : z < 11 ? 500 : z < 13 ? 120 : 0;
  if (dirty || ts - lastDraw >= every) { draw(); dirty = false; lastDraw = ts; }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- selection

map.on("click", (ev) => {
  let best: Vehicle | null = null, bd = 22 * 22;
  for (let i = 0; i < hits.length; i += 3) {
    const dx = (hits[i] as number) - ev.point.x, dy = (hits[i + 1] as number) - ev.point.y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = hits[i + 2] as Vehicle; }
  }
  if (best) select(best); else deselect();
});

function select(v: Vehicle) {
  selectedKey = v.key; trip = null; following = false; setTripLine(null);
  renderPanel(v); loadTrip(v); dirty = true;
}
function deselect() {
  selectedKey = null; trip = null; following = false; setTripLine(null);
  $panel.style.display = "none"; document.body.classList.remove("sel"); dirty = true;
}

async function loadTrip(v: Vehicle) {
  try {
    const res = await fetch(`/trip?id=${encodeURIComponent(v.tripId)}&date=${v.date}`);
    if (!res.ok) throw new Error(res.status as unknown as string);
    const d: LiveMapTrip = await res.json();
    if (selectedKey !== v.key) return;
    trip = d; setTripLine(d.calls, d.segments); renderPanel(byKey.get(v.key) || v);
  } catch { /* the panel still shows the basics */ }
}
setInterval(() => { const v = selectedKey && byKey.get(selectedKey); if (v) loadTrip(v); }, 30_000);

function setTripLine(calls: LiveMapTripCall[] | null, segments?: LiveMapTrip["segments"]) {
  const src = map.getSource<maplibregl.GeoJSONSource>("trip"); if (!src) return;
  const stops = (calls || []).map((c) => [c.lon, c.lat]);
  // Each hop follows its path where one is known, else a straight line between the stops.
  const line: number[][] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const s = segments?.[i] && decodeShape(segments[i]!);
    if (s && s.n >= 2) for (let j = 0; j < s.n; j++) line.push([s.xy[2 * j], s.xy[2 * j + 1]]);
    else line.push(stops[i], stops[i + 1]);
  }
  src.setData({ type: "FeatureCollection", features: line.length < 2 ? [] : [
    { type: "Feature", properties: { kind: "line" }, geometry: { type: "LineString", coordinates: line } },
    ...stops.map((c): GeoJSON.Feature => ({ type: "Feature", properties: { kind: "stop" }, geometry: { type: "Point", coordinates: c } })),
  ] });
}
map.on("load", () => {
  map.addSource("trip", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "trip-line", type: "line", source: "trip", filter: ["==", ["get", "kind"], "line"], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#16181d", "line-width": 3.5, "line-opacity": 0.6 } });
  map.addLayer({ id: "trip-stops", type: "circle", source: "trip", filter: ["==", ["get", "kind"], "stop"], paint: { "circle-radius": 3.5, "circle-color": "#fff", "circle-stroke-color": "#16181d", "circle-stroke-width": 1.5 } });
  if (trip) setTripLine(trip.calls, trip.segments);
});

function delayCell(sec: number | null | undefined) {
  if (sec === null || sec === undefined) return "";
  const m = Math.round(sec / 60);
  return m >= 1 ? `<span class="late">+${m} min</span>` : m <= -1 ? `<span class="ok">${m} min</span>` : `<span class="ok">on time</span>`;
}

function renderPanel(v: Vehicle | null | undefined, message?: string) {
  document.body.classList.add("sel"); $panel.style.display = "block";
  if (!v) { $panel.innerHTML = `<div>${esc(message)}</div>`; return; }
  const state = v.live === 2 ? "Live: the feed has reported this vehicle at a stop on this journey."
    : v.live === 1 ? "Live forecast only: the feed has not yet reported this vehicle at a stop."
    : "Timetable only: no live data for this journey.";
  let rows = "";
  if (trip) {
    const t = now();
    // Times from the engine are scheduled; the delay comes separately.
    const leaves = (c: LiveMapTripCall) => (c.dep ?? c.arr)! + (c.depDelayS ?? c.arrDelayS ?? 0);
    const upcoming = trip.calls.findIndex((c) => leaves(c) >= t);
    const first = Math.max(0, (upcoming < 0 ? trip.calls.length : upcoming) - 1);
    rows = "<table>" + trip.calls.slice(first, first + 8).map((c) => {
      const when = c.arr ?? c.dep, past = leaves(c) < t;
      return `<tr class="${past ? "past" : ""}"><td class="t">${clock(when)}</td><td>${esc(c.name)}${c.label ? ` <span style="color:#646b78">· ${esc(c.noun)} ${esc(c.label)}</span>` : ""}</td><td class="d">${delayCell(c.arrDelayS ?? c.depDelayS)}</td></tr>`;
    }).join("") + "</table>";
  }
  $panel.innerHTML =
    `<div class="btns"><button id="follow" class="${following ? "on" : ""}">Follow</button><button id="close">Close</button></div>` +
    `<h2><span class="badge" style="background:${COLOR[v.group]}">${esc(v.line || v.category)}</span>${esc(v.headsign)}</h2>` +
    `<div class="op">${esc(v.operator)}${trip?.number ? ` · journey ${esc(trip.number)}` : ""}</div>` +
    `<div class="state">${state}<br>Next stop: <b>${esc(v.nextStop)}</b> at ${clock(v.arr)}</div>` + rows;
  document.getElementById("close")!.onclick = deselect;
  document.getElementById("follow")!.onclick = () => { following = !following; renderPanel(byKey.get(selectedKey!) || v); if (following && map.getZoom() < 14) map.easeTo({ center: position(v, now()), zoom: 15 }); dirty = true; };
}
map.on("dragstart", () => { if (following) { following = false; const v = byKey.get(selectedKey!); if (v) renderPanel(v); } });

load(); setInterval(load, REFRESH_MS); setInterval(renderStatus, 1000);
requestAnimationFrame(frame);
