// Live map prototype: one national snapshot of every running vehicle, built by
// tiling the Kante engine's /api/vehicles (which caps the bbox size and the
// number of vehicles per call). No API keys here: the engine holds them and
// does the SIRI-ET polling.
//
// Each stop-to-stop hop is put on the real rails or roads by the `shaper`
// child process (OpenStreetMap path finder, see shaper/src/main.rs).
//
//   node server.mjs            → http://127.0.0.1:8090
//   KANTE_URL, PORT, HOST      override the engine address and the listener
//   OSM_PBF                    the OpenStreetMap extract the shaper routes on

import http from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ENGINE = process.env.KANTE_URL || "http://127.0.0.1:8080";
const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || "127.0.0.1";
const INDEX = here("./index.html");
const SHAPER = here("./shaper/target/release/shaper");
const OSM_PBF = process.env.OSM_PBF || `${homedir()}/Powercoders-Hackathon/kante/data/raw/osm/switzerland-latest.osm.pbf`;
const SHAPE_CACHE = here("./data/shapes-v1.tsv"); // bump the version when the shaper's rules change

// Switzerland plus a margin; cross-border segments that touch it come along.
const WEST = 5.7, EAST = 10.7, SOUTH = 45.7, NORTH = 47.95;
const TILE_LON = 0.4, TILE_LAT = 0.3; // about 30 × 33 km, well under the engine's 120 km diagonal
const ENGINE_CAP = 1500; // the engine stops at this many per call
const MAX_AGE_MS = 10_000;
const LIVE_CODE = { timetable: 0, predicted: 1, observed: 2 };
// Which path-finding profile each engine mode uses. Cable cars and lifts fly straight.
const PROFILE = { rail: "rail", rack: "rail", tram: "tram", metro: "metro", bus: "bus", ondemand: "bus", boat: "boat", funicular: "funi" };
const EPOCH = Date.now(); // shape ids are only valid for this server process

const r5 = (x) => Math.round(x * 1e5) / 1e5;

// ---------------------------------------------------------------- shapes

const shapes = [null];      // id → encoded polyline (precision 5); id 0 means "no shape"
const shapeOf = new Map();  // key → id, or 0 when the shaper found no believable path
const pending = new Map();  // key → Promise<id>
const waiting = new Map();  // request number → resolve
let shaper = null, shaperReady = false, nextRequest = 1;

async function loadShapeCache() {
  await mkdir(here("./data"), { recursive: true });
  let text = "";
  try { text = await readFile(SHAPE_CACHE, "utf8"); } catch { return; }
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const enc = line.slice(tab + 1);
    shapeOf.set(line.slice(0, tab), enc === "-" ? 0 : shapes.push(enc) - 1);
  }
  console.log(`shapes: ${shapeOf.size} cached`);
}

function startShaper() {
  if (!existsSync(SHAPER) || !existsSync(OSM_PBF)) {
    console.error("shapes: shaper binary or OSM file missing, vehicles will move in straight lines");
    return;
  }
  const child = spawn(SHAPER, [OSM_PBF], { stdio: ["pipe", "pipe", "inherit"] });
  shaper = child;
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.startsWith("READY")) { shaperReady = true; console.log("shapes:", line); return; }
    const sp = line.indexOf(" ");
    const resolve = waiting.get(Number(line.slice(0, sp)));
    if (resolve) { waiting.delete(Number(line.slice(0, sp))); resolve(line.slice(sp + 1)); }
  });
  child.on("error", (e) => console.error("shapes:", e.message));
  child.on("exit", (code) => {
    console.error(`shapes: shaper exited (${code}), restarting in 5 s`);
    shaper = null; shaperReady = false;
    for (const resolve of waiting.values()) resolve(undefined);
    waiting.clear();
    setTimeout(startShaper, 5000);
  });
}

/** The shape id for one hop if it is known, else 0 (and the hop is queued for the shaper). */
function shapeFor(profile, fx, fy, tx, ty) {
  if (!profile || (fx === tx && fy === ty)) return 0;
  const key = `${profile}|${fx},${fy}|${tx},${ty}`;
  const known = shapeOf.get(key);
  if (known !== undefined) return known;
  if (shaperReady && !pending.has(key)) {
    const n = nextRequest++;
    const done = new Promise((resolve) => waiting.set(n, resolve)).then((enc) => {
      pending.delete(key);
      if (enc === undefined) return 0; // the shaper died; ask again later
      const id = enc === "-" ? 0 : shapes.push(enc) - 1;
      shapeOf.set(key, id);
      appendFile(SHAPE_CACHE, `${key}\t${enc}\n`).catch(() => {});
      return id;
    });
    pending.set(key, done);
    shaper.stdin.write(`${n} ${profile} ${fx} ${fy} ${tx} ${ty}\n`);
  }
  return 0;
}

/** Like shapeFor, but waits (briefly) for the shaper's answer. */
async function shapeForAwait(profile, fx, fy, tx, ty) {
  const id = shapeFor(profile, fx, fy, tx, ty);
  if (id) return id;
  const p = pending.get(`${profile}|${fx},${fy}|${tx},${ty}`);
  if (!p) return 0;
  return Promise.race([p, new Promise((resolve) => setTimeout(() => resolve(0), 4000))]);
}

// ---------------------------------------------------------------- vehicles

async function engineJson(path) {
  const res = await fetch(ENGINE + path, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`engine ${res.status} for ${path}`);
  return res.json();
}

async function tile(w, s, e, n, into, depth = 0) {
  const d = await engineJson(`/api/vehicles?bbox=${w},${s},${e},${n}`);
  if (d.vehicles.length >= ENGINE_CAP && depth < 4) {
    // Truncated: split into four and ask again.
    const mx = (w + e) / 2, my = (s + n) / 2;
    await Promise.all([
      tile(w, s, mx, my, into, depth + 1), tile(mx, s, e, my, into, depth + 1),
      tile(w, my, mx, n, into, depth + 1), tile(mx, my, e, n, into, depth + 1),
    ]);
    return;
  }
  for (const v of d.vehicles) into.set(v.tripId + "|" + v.serviceDate, v);
}

/** Every vehicle the engine has under way right now, keyed by trip and service date. */
async function tileAll() {
  const all = new Map();
  const jobs = [];
  for (let w = WEST; w < EAST - 1e-9; w += TILE_LON)
    for (let s = SOUTH; s < NORTH - 1e-9; s += TILE_LAT)
      jobs.push([w, s, Math.min(w + TILE_LON, EAST), Math.min(s + TILE_LAT, NORTH)]);
  let next = 0;
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (next < jobs.length) await tile(...jobs[next++], all);
  }));
  return all;
}

async function buildSnapshot() {
  const started = Date.now();
  const all = await tileAll();
  const meta = await engineJson("/api/meta");
  // Queue every hop that has no path yet and give the shaper a moment, so a
  // vehicle is on its rails or road from the first snapshot that shows the hop.
  for (const v of all.values()) shapeFor(PROFILE[v.line.mode], r5(v.from[0]), r5(v.from[1]), r5(v.to[0]), r5(v.to[1]));
  if (pending.size) await Promise.race([Promise.all([...pending.values()]), new Promise((resolve) => setTimeout(resolve, 3000))]);
  const rows = [];
  for (const v of all.values()) {
    const fx = r5(v.from[0]), fy = r5(v.from[1]), tx = r5(v.to[0]), ty = r5(v.to[1]);
    rows.push([
      v.tripId, v.serviceDate, v.line.name, v.line.category, v.line.mode, v.line.operator, v.headsign,
      fx, fy, tx, ty, v.dep, v.arr, v.nextStop,
      LIVE_CODE[v.live] ?? 0,
      shapeFor(PROFILE[v.line.mode], fx, fy, tx, ty),
    ]);
  }
  const body = {
    t: Date.now() / 1000,
    epoch: EPOCH,
    feedUpdatedAt: meta.realtime?.enabled ? meta.realtime.updatedAt : null,
    feedSource: meta.realtime?.source ?? null,
    buildMs: Date.now() - started,
    vehicles: rows,
  };
  return { at: Date.now(), gz: gzipSync(JSON.stringify(body)), count: rows.length };
}

let snapshot = null;
let building = null;
function refresh() {
  building ??= buildSnapshot()
    .then((s) => { snapshot = s; return s; })
    .finally(() => { building = null; });
  return building;
}

async function vehicles(res) {
  // Rebuild only when someone is looking; serve the previous snapshot meanwhile.
  if (!snapshot) await refresh();
  else if (Date.now() - snapshot.at > MAX_AGE_MS) refresh().catch((e) => console.error("refresh:", e.message));
  // The snapshot may be several seconds old; the page needs the time now, not the build time.
  res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "cache-control": "no-store", "x-server-time": String(Date.now() / 1000) });
  res.end(snapshot.gz);
}

// ---------------------------------------------------------------- fleet with look-ahead
//
// The page gets each vehicle's coming stops with their live times, so it can carry on past a
// stop without waiting for us, and only re-reads a vehicle when its timeline changes.

const GROUP = { rail: "train", rack: "train", tram: "tram", metro: "tram", bus: "bus", ondemand: "bus", boat: "boat", cableway: "cable", funicular: "cable", lift: "cable" };
const VMAX = { train: 65, tram: 22, bus: 28, boat: 20, cable: 15, other: 30 }; // m/s, fastest believable
const WINDOW_STEP = 4, WINDOW_LEN = 28;  // stops sent per vehicle; the window moves on every 4 stops
const FLEET_EVERY_MS = 5000;

const fleet = new Map();      // key → { id, rev, rec, sig }
const tombs = [];             // [rev, id] of vehicles that have gone
const tripCache = new Map();  // key → { feed, calls: [{ lon, lat, arr, dep }] } with live times
const shapeMetres = [0];
let fleetRev = 0, nextVehicleId = 1, fleetFeed = null, fleetBuilding = null, fleetTimer = null, lastAsk = 0, fleetBuiltAt = 0;

const metres = (aLon, aLat, bLon, bLat) => {
  const c = Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
  return Math.hypot((bLon - aLon) * c * 111195, (bLat - aLat) * 111195);
};

function lengthOf(id) {
  if (shapeMetres[id] !== undefined) return shapeMetres[id];
  const enc = shapes[id];
  let i = 0, lat = 0, lon = 0, total = 0, pLat = 0, pLon = 0, first = true;
  while (i < enc.length) {
    for (let k = 0; k < 2; k++) {
      let shift = 0, result = 0, b;
      do { b = enc.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    if (!first) total += metres(pLon / 1e5, pLat / 1e5, lon / 1e5, lat / 1e5);
    first = false; pLat = lat; pLon = lon;
  }
  return (shapeMetres[id] = total);
}

/** A trip's stops with live arrival and departure times, never running backwards in time. */
function liveCalls(d) {
  let run = -Infinity;
  return d.calls.map((c) => {
    const a = c.arr != null ? c.arr + (c.arrDelayS ?? 0) : null, b = c.dep != null ? c.dep + (c.depDelayS ?? 0) : null;
    const arr = (run = Math.max(run, a ?? b)), dep = (run = Math.max(run, b ?? a));
    return { lon: r5(c.quay.lon), lat: r5(c.quay.lat), arr, dep };
  });
}

async function buildFleet() {
  const feedOf = (m) => (m.realtime?.enabled ? m.realtime.updatedAt : null);
  const feed = feedOf(await engineJson("/api/meta"));
  const all = await tileAll();

  // Live timelines change only when the engine has taken in a new feed; timetable ones never.
  const need = [];
  for (const [key, v] of all) {
    const want = v.live === "timetable" ? "static" : feed;
    if (tripCache.get(key)?.feed !== want) need.push([key, v, want]);
  }
  let next = 0;
  await Promise.all(Array.from({ length: 24 }, async () => {
    while (next < need.length) {
      const [key, v, want] = need[next++];
      try {
        const d = await engineJson(`/api/trip?id=${encodeURIComponent(v.tripId)}&date=${encodeURIComponent(v.serviceDate)}`);
        tripCache.set(key, { feed: want, calls: liveCalls(d) });
      } catch { /* keep the previous timeline */ }
    }
  }));
  // If the feed changed while we were reading, some of those are from the older one: read them again next time.
  if (feedOf(await engineJson("/api/meta")) !== feed) for (const [key, , want] of need) if (want !== "static" && tripCache.has(key)) tripCache.get(key).feed = undefined;

  const windowOf = (v, n) => {
    const base = Math.max(0, Math.min(n - 2, Math.floor((v.nextSeq - 2) / WINDOW_STEP) * WINDOW_STEP));
    return [base, Math.min(n, base + WINDOW_LEN)];
  };
  for (const [key, v] of all) {
    const tc = tripCache.get(key); if (!tc || tc.calls.length < 2) continue;
    const [base, end] = windowOf(v, tc.calls.length), profile = PROFILE[v.line.mode];
    for (let j = base; j + 1 < end; j++) shapeFor(profile, tc.calls[j].lon, tc.calls[j].lat, tc.calls[j + 1].lon, tc.calls[j + 1].lat);
  }
  if (pending.size) await Promise.race([Promise.all([...pending.values()]), new Promise((resolve) => setTimeout(resolve, 3000))]);

  for (const [key, v] of all) {
    const tc = tripCache.get(key); if (!tc || tc.calls.length < 2) continue;
    const calls = tc.calls, [base, end] = windowOf(v, calls.length), profile = PROFILE[v.line.mode];
    const stops = [], S = [0];
    for (let j = base; j < end; j++) {
      const c = calls[j], n = calls[j + 1];
      const sid = j + 1 < end ? shapeFor(profile, c.lon, c.lat, n.lon, n.lat) : 0;
      stops.push(c.lon, c.lat, sid);
      if (j + 1 < end) S.push(S[S.length - 1] + (sid ? lengthOf(sid) : metres(c.lon, c.lat, n.lon, n.lat)));
    }
    // Anchors (time, stop). No hop faster than believable: borrow the time from what came before it.
    const vmax = VMAX[GROUP[v.line.mode] ?? "other"], pts = [];
    for (let j = base; j < end; j++) {
      const q = [[calls[j].arr, j - base], [calls[j].dep, j - base]];
      for (const a of q) {
        while (pts.length >= 2 && S[a[1]] - S[pts.at(-1)[1]] > 1 && S[a[1]] - S[pts.at(-1)[1]] > vmax * (a[0] - pts.at(-1)[0])) pts.pop();
        const last = pts.at(-1);
        if (!last || last[0] !== a[0] || last[1] !== a[1]) pts.push(a);
      }
    }
    const tail = [LIVE_CODE[v.live] ?? 0, base, stops, pts.flat()];
    const sig = JSON.stringify(tail);
    let f = fleet.get(key);
    if (!f) fleet.set(key, (f = { id: nextVehicleId++, rev: 0, rec: null, sig: null }));
    if (f.sig !== sig) {
      f.sig = sig; f.rev = ++fleetRev;
      f.rec = [f.id, v.tripId, v.serviceDate, v.line.name, v.line.category, v.line.mode, v.line.operator, v.headsign, ...tail];
    }
  }
  for (const [key, f] of fleet) if (!all.has(key)) { tombs.push([++fleetRev, f.id]); fleet.delete(key); tripCache.delete(key); }
  while (tombs.length > 20000) tombs.shift();
  fleetFeed = feed; fleetBuiltAt = Date.now();
}

function refreshFleet() {
  fleetBuilding ??= buildFleet().finally(() => { fleetBuilding = null; });
  return fleetBuilding;
}

async function state(url, res) {
  lastAsk = Date.now();
  if (!fleetBuiltAt) await refreshFleet();
  // Keep rebuilding while someone is watching, so nobody is ever handed an old copy.
  fleetTimer ??= setInterval(() => {
    if (Date.now() - lastAsk > 30_000) { clearInterval(fleetTimer); fleetTimer = null; fleetBuiltAt = 0; return; }
    refreshFleet().catch((e) => console.error("fleet:", e.message));
  }, FLEET_EVERY_MS);
  const since = Number(url.searchParams.get("epoch")) === EPOCH ? Number(url.searchParams.get("since")) || 0 : 0;
  const changed = [];
  for (const f of fleet.values()) if (f.rev > since) changed.push(f.rec);
  const gone = since ? tombs.filter(([r]) => r > since).map(([, id]) => id) : [];
  const body = { epoch: EPOCH, rev: fleetRev, full: since === 0, feedUpdatedAt: fleetFeed, count: fleet.size, changed, gone };
  res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "cache-control": "no-store", "x-server-time": String(Date.now() / 1000) });
  res.end(gzipSync(JSON.stringify(body)));
}

async function trip(url, res) {
  const id = url.searchParams.get("id") ?? "", date = url.searchParams.get("date") ?? "";
  const d = await engineJson(`/api/trip?id=${encodeURIComponent(id)}&date=${encodeURIComponent(date)}`);
  const calls = d.calls.map((c) => ({
    name: c.quay.stationName, label: c.quay.label, noun: c.quay.noun, lat: c.quay.lat, lon: c.quay.lon,
    arr: c.arr ?? null, dep: c.dep ?? null, arrDelayS: c.arrDelayS ?? null, depDelayS: c.depDelayS ?? null,
  }));
  // One encoded path per hop between consecutive stops; null where there is none.
  const profile = PROFILE[d.line?.mode];
  const segments = await Promise.all(calls.slice(1).map(async (b, i) => {
    const a = calls[i];
    const sid = await shapeForAwait(profile, r5(a.lon), r5(a.lat), r5(b.lon), r5(b.lat));
    return sid ? shapes[sid] : null;
  }));
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ number: d.number ?? null, calls, segments }));
}

async function shapesFor(req, res) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 2_000_000) throw new Error("request too large");
  }
  const out = {};
  for (const id of JSON.parse(text)) if (Number.isInteger(id) && id > 0 && id < shapes.length) out[id] = shapes[id];
  res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "cache-control": "no-store" });
  res.end(gzipSync(JSON.stringify({ epoch: EPOCH, shapes: out })));
}

await loadShapeCache();
startShaper();

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/vehicles") return await vehicles(res);
    if (url.pathname === "/trip") return await trip(url, res);
    if (url.pathname === "/shapes" && req.method === "POST") return await shapesFor(req, res);
    if (url.pathname === "/state") return await state(url, res);
    if (url.pathname === "/old") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(await readFile(here("./index-old.html")));
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(await readFile(INDEX));
    }
    res.writeHead(404).end("not found");
  } catch (e) {
    console.error(url.pathname, e.message);
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, HOST, () => console.log(`live map on http://${HOST}:${PORT} (engine ${ENGINE})`));
