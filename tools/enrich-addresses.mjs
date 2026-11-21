// Fills missing addresses in data/places.json and data/amenities.json from the official Swiss building
// address register (swisstopo "Amtliches Gebäudeadressverzeichnis", bulk CSV, LV95), flags OSM street
// names the register doesn't know nearby, and writes slim browser copies (*.min.json, no `tags`).
// Run after tools/build-places.mjs and tools/build-amenities.mjs. Rewrites both files in place; idempotent.
// Usage: node tools/enrich-addresses.mjs [data/places.json data/amenities.json]
// Needs `unzip` on PATH (Git Bash / macOS / Linux have it). Raw files are cached in data/raw/.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import assert from "node:assert/strict";

const FILES = process.argv.length > 2 ? process.argv.slice(2) : ["data/places.json", "data/amenities.json"];
const RAW = "data/raw";
const ZIP = `${RAW}/gebaeudeadressen_ch.csv.zip`;
const EXTRACT = `${RAW}/gebaeudeadressen-bern.csv`; // bbox-filtered cache, ~1% of the national file
const URL = "https://data.geo.admin.ch/ch.swisstopo.amtliches-gebaeudeadressverzeichnis/amtliches-gebaeudeadressverzeichnis_ch/amtliches-gebaeudeadressverzeichnis_ch_2056.csv.zip";
const FILL_M = 25, CHECK_M = 50, CELL = 50;

// WGS84 -> LV95, swisstopo approximate formulas (~1 m), so all distances below are plain metres.
function toLV95(lat, lon) {
  const p = (lat * 3600 - 169028.66) / 10000, l = (lon * 3600 - 26782.5) / 10000;
  return [
    2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3,
    1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3,
  ];
}
// Comparable street key; drops a trailing house number some OSM items put inside addr:street ("Rain 13").
const normStreet = (s) => s.normalize("NFC").replace(/\s+\d+\s*[a-z]?$/i, "").toLowerCase().replace(/ß/g, "ss")
  .replace(/str\.?(?=\s|$)/g, "strasse").replace(/[^\p{L}\p{N}]/gu, "");

assert.ok(Math.hypot(...toLV95(46.951082877, 7.438632495).map((v, i) => v - [2600000, 1200000][i])) < 2, "LV95 conversion");
assert.equal(normStreet("Flughafenstr. "), normStreet("Flughafenstrasse"));
assert.equal(normStreet("Rain 13"), normStreet("Rain"));
assert.equal(normStreet("Strasse 3a"), "strasse");
assert.notEqual(normStreet("Flughafenstrasse"), normStreet("Flugplatzstrasse"));

async function ensureExtract() {
  if (fs.existsSync(EXTRACT)) return;
  fs.mkdirSync(RAW, { recursive: true });
  if (!fs.existsSync(ZIP)) {
    console.log("downloading", URL);
    const res = await fetch(URL);
    assert.ok(res.ok, `download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(ZIP + ".part"));
    fs.renameSync(ZIP + ".part", ZIP);
  }
  const corners = [[46.9, 7.34], [46.9, 7.5], [46.99, 7.34], [46.99, 7.5]].map(([a, b]) => toLV95(a, b));
  const [minE, maxE, minN, maxN] = [0, 1].flatMap((i) => [Math.min(...corners.map((c) => c[i])) - 300, Math.max(...corners.map((c) => c[i])) + 300]);
  const unzip = spawn("unzip", ["-p", ZIP], { stdio: ["ignore", "pipe", "inherit"] });
  const out = [];
  let cols;
  for await (const line of createInterface({ input: unzip.stdout })) {
    if (!cols) { cols = line.replace(/^﻿/, "").split(";"); out.push(cols.join(";")); continue; }
    const c = line.split(";"), e = +c[cols.indexOf("ADR_EASTING")], n = +c[cols.indexOf("ADR_NORTHING")];
    if (e >= minE && e <= maxE && n >= minN && n <= maxN) out.push(line);
  }
  assert.ok(out.length > 10000, `register extract too small (${out.length} lines) - is unzip installed?`);
  fs.writeFileSync(EXTRACT, out.join("\n") + "\n");
}

await ensureExtract();
const [head, ...lines] = fs.readFileSync(EXTRACT, "utf8").trim().split("\n");
const H = Object.fromEntries(head.split(";").map((c, i) => [c, i]));
const grid = new Map();
let regCount = 0;
for (const line of lines) {
  const c = line.split(";");
  if (c[H.ADR_STATUS] !== "real" || !c[H.STN_LABEL] || !c[H.ADR_NUMBER]) continue; // skip planned/outdated
  const [postcode, ...city] = c[H.ZIP_LABEL].split(" ");
  const a = { e: +c[H.ADR_EASTING], n: +c[H.ADR_NORTHING], street: c[H.STN_LABEL], nr: c[H.ADR_NUMBER], postcode, city: city.join(" ") };
  a.norm = normStreet(a.street);
  a.label = `${a.street} ${a.nr}, ${c[H.ZIP_LABEL]}`;
  const k = `${Math.floor(a.e / CELL)},${Math.floor(a.n / CELL)}`;
  (grid.get(k) ?? grid.set(k, []).get(k)).push(a);
  regCount++;
}
console.log("register addresses in bbox:", regCount);

// All register addresses within r metres, nearest first.
function near(lat, lon, r) {
  const [e, n] = toLV95(lat, lon), gx = Math.floor(e / CELL), gy = Math.floor(n / CELL), s = Math.ceil(r / CELL);
  const hits = [];
  for (let x = gx - s; x <= gx + s; x++) for (let y = gy - s; y <= gy + s; y++)
    for (const a of grid.get(`${x},${y}`) ?? []) { const d = Math.hypot(a.e - e, a.n - n); if (d <= r) hits.push([d, a]); }
  return hits.sort((p, q) => p[0] - q[0]);
}

const ADDR_FIELDS = ["street", "housenumber", "postcode", "city"]; // places.json only
for (const file of FILES) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const items = doc.items;
  let osm = 0, derived = 0, mismatches = [], checked = 0;
  for (const it of items) {
    if (it.address_source === "derived:gwr") { // undo a previous run
      it.address = null;
      for (const f of ADDR_FIELDS) if (f in it) it[f] = null;
    }
    delete it.address_source; delete it.address_distance_m; delete it.address_check; delete it.address_official;
    const hits = near(it.lat, it.lon, CHECK_M);
    if (it.address) {
      osm++;
      const street = it.street ?? it.tags?.["addr:street"] ?? it.tags?.["addr:place"];
      if (!street || !hits.length) continue; // nothing to compare against
      checked++;
      if (!hits.some(([, a]) => a.norm === normStreet(street))) {
        it.address_check = "street_mismatch";
        it.address_official = hits[0][1].label;
        mismatches.push(`${it.id} "${it.name}": OSM "${it.address}" -> register "${it.address_official}" (${hits[0][0].toFixed(0)} m)`);
      }
    } else if (hits.length && hits[0][0] <= FILL_M) {
      const [d, a] = hits[0];
      it.address = a.label;
      it.address_source = "derived:gwr";
      it.address_distance_m = Math.round(d * 10) / 10;
      if ("street" in it) Object.assign(it, { street: a.street, housenumber: a.nr, postcode: a.postcode, city: a.city });
      derived++;
    }
  }
  // self-checks
  assert.ok(items.filter((i) => i.address_source === "derived:gwr").every((i) => i.address && i.address_distance_m <= FILL_M));
  assert.ok(items.filter((i) => i.address_check).every((i) => i.address && i.address_official && !i.address_source));
  for (const it of items.slice(0, 300)) { // grid lookup agrees with brute force
    const [e, n] = toLV95(it.lat, it.lon);
    let best = Infinity;
    for (const cell of grid.values()) for (const a of cell) best = Math.min(best, Math.hypot(a.e - e, a.n - n));
    const h = near(it.lat, it.lon, CHECK_M);
    assert.equal(h.length ? h[0][0] : Infinity, best <= CHECK_M ? best : Infinity);
  }
  fs.writeFileSync(file, JSON.stringify(doc));
  const min = file.replace(/\.json$/, ".min.json");
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  fs.writeFileSync(min, JSON.stringify({ ...doc, items: items.map(({ tags, ...i }) => ({ ...i, lat: r6(i.lat), lon: r6(i.lon) })) }));
  const pct = (k) => `${k} (${((k / items.length) * 100).toFixed(1)}%)`;
  const mb = (f) => (fs.statSync(f).size / 1e6).toFixed(2) + " MB";
  console.log(`\n${file}: ${items.length} items`);
  console.log(`  address before: ${pct(osm)}  after: ${pct(osm + derived)}  (+${derived} derived:gwr)`);
  console.log(`  OSM addresses checked: ${checked}, street_mismatch: ${mismatches.length}`);
  for (const m of mismatches.slice(0, 10)) console.log("   ", m);
  console.log(`  size: ${file} ${mb(file)}, ${min} ${mb(min)}`);
}
