// Fills missing addresses Switzerland-wide from the official building address register (swisstopo "Amtliches
// Gebäudeadressverzeichnis", national CSV, LV95) - CH version of tools/enrich-addresses.mts. Every item with a null address
// takes the nearest register address within 25 m: address = "Street Nr", postcode, city (locality of ZIP_LABEL),
// address_source = "derived:gwr", address_distance_m. Rewrites the files in place; idempotent (derived values are redone).
// Run after tools/build-amenities-ch.mts, tools/build-official-ch.mts and tools/build-toilets-ch.mts.
// Usage: node tools/enrich-addresses-ch.mts [files...]   (default: data/ch/osm-*.json, official-ch.json, toilets-ch.json)
// Needs `unzip` on PATH once, to build the compact cache data/raw/gebaeudeadressen-ch.csv.gz from the 469 MB national CSV.
import fs from "node:fs";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import assert from "node:assert/strict";

const FILES = process.argv.length > 2 ? process.argv.slice(2)
  : [...fs.readdirSync("data/ch").filter((f) => /^osm-.*\.json$/.test(f)).sort().map((f) => `data/ch/${f}`), "data/ch/official-ch.json", "data/ch/toilets-ch.json"];
const RAW = "data/raw";
const ZIP = `${RAW}/gebaeudeadressen_ch.csv.zip`;
const CACHE = `${RAW}/gebaeudeadressen-ch.csv.gz`; // E;N;street;nr;zip label - real addresses only, ~10% of the zip's CSV
const URL = "https://data.geo.admin.ch/ch.swisstopo.amtliches-gebaeudeadressverzeichnis/amtliches-gebaeudeadressverzeichnis_ch/amtliches-gebaeudeadressverzeichnis_ch_2056.csv.zip";
const FILL_M = 25, CELL = 50;

/** An address of the register (a line of the cache), in LV95 metres. */
interface RegAddress {
  e: number;
  n: number;
  /** Street and number: "Neuengasse 15" */
  address: string;
  postcode: string;
  city: string;
}
/** A record of a data/ch file, as far as it is read and changed here (docs/data-ch-toilets.md). */
interface Item {
  id: string;
  lat: number;
  lon: number;
  /** Street and number */
  address: string | null;
  postcode: string | null;
  city: string | null;
  /** Set when the address is the register's nearest one, not the source's */
  address_source?: "derived:gwr";
  /** How far away that register address is, in metres */
  address_distance_m?: number;
}
/** What the run did to one file. */
interface FileSummary { file: string; n: number; before: number; after: number; derived: number; median: number | null }

// WGS84 -> LV95, swisstopo approximate formulas (~1 m), so all distances below are plain metres.
function toLV95(lat: number, lon: number): [e: number, n: number] {
  const p = (lat * 3600 - 169028.66) / 10000, l = (lon * 3600 - 26782.5) / 10000;
  return [
    2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3,
    1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3,
  ];
}
assert.ok(Math.hypot(...toLV95(46.951082877, 7.438632495).map((v, i) => v - [2600000, 1200000][i])) < 2, "LV95 conversion");
const cellKey = (e: number, n: number) => `${Math.floor(e / CELL)},${Math.floor(n / CELL)}`;

async function ensureCache() {
  if (fs.existsSync(CACHE)) return;
  assert.ok(fs.existsSync(ZIP), `missing ${ZIP}: download ${URL}`);
  const unzip = spawn("unzip", ["-p", ZIP], { stdio: ["ignore", "pipe", "inherit"] });
  const gz = zlib.createGzip({ level: 6 });
  const done = gz.pipe(fs.createWriteStream(CACHE + ".part"));
  let H: Record<string, number> | undefined, kept = 0, bad = 0, buf: string[] = [];
  const flush = async () => { if (!gz.write(buf.join(""))) await once(gz, "drain"); buf = []; };
  for await (const line of createInterface({ input: unzip.stdout })) {
    if (!H) { H = Object.fromEntries(line.replace(/^﻿/, "").split(";").map((c, i) => [c, i])); continue; }
    const c = line.split(";");
    if (c.length !== Object.keys(H).length) { bad++; continue; } // shortcut: ~4 rows with ";" inside a field are skipped, parse quotes if that grows
    if (c[H.ADR_STATUS] !== "real" || !c[H.STN_LABEL] || !c[H.ADR_NUMBER] || !(+c[H.ADR_EASTING] > 0)) continue; // skip planned/outdated
    buf.push(`${(+c[H.ADR_EASTING]).toFixed(1)};${(+c[H.ADR_NORTHING]).toFixed(1)};${c[H.STN_LABEL]};${c[H.ADR_NUMBER]};${c[H.ZIP_LABEL]}\n`);
    if (++kept % 20000 === 0) await flush();
  }
  await flush();
  gz.end();
  await once(done, "finish");
  assert.ok(kept > 2_500_000, `register cache too small (${kept} rows) - is unzip installed?`);
  assert.ok(bad < 100, `${bad} malformed register rows`);
  fs.renameSync(CACHE + ".part", CACHE);
  console.log(`cached ${kept} real addresses in ${CACHE} (${(fs.statSync(CACHE).size / 1e6).toFixed(1)} MB), skipped ${bad} malformed rows`);
}

await ensureCache();

// Load all files first, so only the register cells near items that need an address are kept in memory.
const docs = FILES.map((file) => ({ file, doc: JSON.parse(fs.readFileSync(file, "utf8")) as { items: Item[] } }));
const need = (it: Item) => it.address == null || it.address_source === "derived:gwr";
const wanted = new Set<string>();
for (const { doc } of docs) for (const it of doc.items) if (need(it)) {
  const [e, n] = toLV95(it.lat, it.lon), gx = Math.floor(e / CELL), gy = Math.floor(n / CELL);
  for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) wanted.add(`${x},${y}`); // CELL >= FILL_M, so +-1 cell suffices
}
const grid = new Map<string, RegAddress[]>();
let regCount = 0, regKept = 0;
for await (const line of createInterface({ input: fs.createReadStream(CACHE).pipe(zlib.createGunzip()) })) {
  regCount++;
  const c = line.split(";"), e = +c[0], n = +c[1], k = cellKey(e, n);
  if (!wanted.has(k)) continue;
  const [postcode, ...city] = c[4].split(" ");
  (grid.get(k) ?? grid.set(k, []).get(k)!).push({ e, n, address: `${c[2]} ${c[3]}`, postcode, city: city.join(" ") });
  regKept++;
}
console.log(`register: ${regCount} real addresses, ${regKept} near items needing one`);
assert.ok(regCount > 2_500_000, "register cache truncated");

function nearest(lat: number, lon: number): [d: number, a: RegAddress] | null {
  const [e, n] = toLV95(lat, lon), gx = Math.floor(e / CELL), gy = Math.floor(n / CELL);
  let best: RegAddress | null = null, bd = Infinity;
  for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++)
    for (const a of grid.get(`${x},${y}`) ?? []) { const d = Math.hypot(a.e - e, a.n - n); if (d < bd) { bd = d; best = a; } }
  return bd <= FILL_M ? [bd, best!] : null;
}

const all = [...grid.values()].flat();
const summary: FileSummary[] = [];
for (const { file, doc } of docs) {
  const items = doc.items;
  const before = items.filter((i) => i.address != null && i.address_source !== "derived:gwr").length;
  let derived = 0;
  const dists: number[] = [];
  for (const it of items) {
    if (!need(it)) continue;
    if (it.address_source === "derived:gwr") { it.address = null; delete it.address_source; delete it.address_distance_m; } // undo a previous run
    const hit = nearest(it.lat, it.lon);
    if (!hit) continue;
    const [d, a] = hit;
    Object.assign(it, { address: a.address, postcode: a.postcode, city: a.city, address_source: "derived:gwr", address_distance_m: Math.round(d * 10) / 10 });
    derived++;
    dists.push(d);
  }
  // self-checks
  assert.ok(items.filter((i) => i.address_source === "derived:gwr").every((i) => i.address && i.address_distance_m! <= FILL_M && /^\d{4}$/.test(i.postcode!)));
  for (const it of items.filter((i) => i.address_source === "derived:gwr").slice(0, 5)) { // grid lookup agrees with brute force
    const [e, n] = toLV95(it.lat, it.lon);
    let best = Infinity;
    for (const a of all) best = Math.min(best, Math.hypot(a.e - e, a.n - n));
    assert.ok(Math.abs(best - it.address_distance_m!) <= 0.05, `grid vs brute force ${it.id}`);
  }
  fs.writeFileSync(file, JSON.stringify(doc));
  dists.sort((a, b) => a - b);
  summary.push({ file, n: items.length, before, after: before + derived, derived, median: dists.length ? dists[dists.length >> 1] : null });
}
const pct = (k: number, n: number) => `${k} (${n ? ((k / n) * 100).toFixed(1) : 0}%)`;
console.log("\nfile | items | address before | after | derived | median m");
for (const s of summary) console.log(`${s.file} | ${s.n} | ${pct(s.before, s.n)} | ${pct(s.after, s.n)} | +${s.derived} | ${s.median?.toFixed(1) ?? "-"}`);
const tot = summary.reduce((t, s) => ({ n: t.n + s.n, before: t.before + s.before, after: t.after + s.after }), { n: 0, before: 0, after: 0 });
console.log(`total | ${tot.n} | ${pct(tot.before, tot.n)} | ${pct(tot.after, tot.n)}`);
