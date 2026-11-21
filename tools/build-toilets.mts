// Merges every toilet record we have for greater Bern into one wheelchair-focused file, data/toilets.json:
//   osm    - amenity=toilets from data/amenities.json (OSM, ODbL; run tools/enrich-addresses.mts first)
//   atlas  - ATLAS/SBB station toilets, data/raw/actual-date-toilet.csv joined to service-point.csv (tools/fetch-raw.sh)
//   nette  - Stadt Bern "Nette Toilette" programme (restaurants open their WC to everyone), 12 addresses from the
//            city flyer, geocoded with the official address register cached by tools/enrich-addresses.mts
// Records of different sources within 30 m (ATLAS: 100 m) are one toilet. OSM values win; the other source fills gaps, and a
// wheelchair disagreement is kept in `notes`. Nette restaurants also take opening hours / wheelchair from the
// matching restaurant in data/places.json (the WC is usable during business hours).
// Usage: node tools/build-toilets.mts [data/toilets.json]
import fs from "node:fs";
import assert from "node:assert/strict";

const OUT = process.argv[2] ?? "data/toilets.json";
const RAW = "data/raw";
const BBOX = { S: 46.9, W: 7.34, N: 46.99, E: 7.5 };
const MATCH_M = 30;
const ATLAS_MATCH_M = 100; // ATLAS gives the station centre, not the toilet; its WC is typically 30-80 m away
const NETTE_URL = "https://www.bern.ch/mediencenter/medienmitteilungen/aktuell_ptk/nette-toiletten-gehoeren-definitiv-zu-bern-1/dokumente/flyer-nette-toilette.pdf";
// From the flyer (press release 11.07.2018). shortcut: hand-copied list, re-check the flyer if the programme changes.
const NETTE = [
  ["Bar-Club Propeller Bar", "Aarbergergasse", "30"], ["Restaurant Schmiedstube", "Schmiedenplatz", "5"],
  ["Hotel Nydeck – Junkere Bar", "Gerechtigkeitsgasse", "1"], ["Ristorante Santa Lucia", "Bärenplatz", "7"],
  ["The Beef Steakhouse & Bar", "Kramgasse", "74"], ["Confiserie Monnier", "Schauplatzgasse", "26"],
  ["Restaurationsbetriebe Reitschule", "Neubrückstrasse", "8"], ["Restaurant Mülirad", "Gerberngasse", "4"],
  ["Hotel-Restaurant National", "Hirschengraben", "24"], ["Restaurant Brésil", "Bollwerk", "15"],
  ["Restaurant Brasserie Ringgenberg", "Kornhausplatz", "19"], ["Café Tscharni", "Waldmannstrasse", "17"],
];

interface LatLon { lat: number; lon: number }
/** A row of a CSV file of data/raw: column name → cell ("" when empty). */
type CsvRow = Record<string, string>;
/** service-point.csv (ATLAS): a station. The columns that are read. */
interface ServicePointRow { sloid: string; designationOfficial: string; businessOrganisationDescriptionDe: string; wgs84North: string; wgs84East: string }
/** actual-date-toilet.csv (ATLAS): a station toilet. */
interface AtlasToiletRow {
  sloid: string;
  parentSloidServicePoint: string;
  designation: string;
  /** YES, NO, PARTIALLY, NOT_APPLICABLE */
  wheelchairToilet: string;
  additionalInformation: string;
  /** "2026-12-31" */
  validFrom: string;
  validTo: string;
}
/** gebaeudeadressen-bern.csv: an address of the official register, in LV95 (the extract of tools/enrich-addresses.mts). */
interface RegisterRow { ADR_STATUS: string; STN_LABEL: string; ADR_NUMBER: string; ZIP_LABEL: string; ADR_EASTING: string; ADR_NORTHING: string }
/** A record of data/amenities.json, as far as it is read here: OpenStreetMap's amenity=toilets. */
interface Amenity extends LatLon {
  id: string;
  category: string;
  name: string | null;
  address: string | null;
  access: string | null;
  wheelchair: string | null;
  toilets_wheelchair: string | null;
  changing_table: string | null;
  fee: string | null;
  opening_hours: string | null;
  unisex: string | null;
  operator: string | null;
  level: string | null;
  check_date: string | null;
  description: string | null;
  tags?: Record<string, string>;
}
/** A record of data/places.json, as far as it is read here: the restaurant behind a Nette Toilette. */
interface PlaceItem extends LatLon { id: string; name: string | null; wheelchair: string | null; toilets_wheelchair: string | null; opening_hours: string | null }

/** A record of data/toilets.json (docs/data-enrichment.md). The values are OpenStreetMap-style strings; null = unknown. */
interface ToiletRecord extends LatLon {
  /** The OpenStreetMap id ("node/123"), or "atlas/<sloid>", "nette/<n>" for a toilet OpenStreetMap lacks */
  id: string;
  name: string | null;
  address: string | null;
  /** OpenStreetMap's access=*: "yes", "customers", "private" */
  access: string | null;
  /** "osm:node/123", "atlas:<sloid> (40 m)", "nette:3 (2 m)", "osm-place:node/456 (2 m)" */
  sources: string[];
  /** Step-free access to the place */
  wheelchair: string | null;
  /** There is a toilet for wheelchair users: "yes", "no", "limited" */
  toilets_wheelchair: string | null;
  /** "yes" or unknown */
  eurokey: string | null;
  changing_table: string | null;
  fee: string | null;
  opening_hours: string | null;
  unisex: string | null;
  operator: string | null;
  level: string | null;
  check_date: string | null;
  /** The sources' remarks and their disagreements, joined with "; " */
  notes: string | null;
}
/** A toilet while its sources are merged: the notes still one by one. */
type Toilet = Omit<ToiletRecord, "notes"> & { notes: string[] };
/** A toilet at the moment its notes are joined. */
type NotesSlot = { notes: string[] | string | null };
/** The fields a toilet is merged by (FIELDS). */
type Field = Exclude<keyof ToiletRecord, "id" | "lat" | "lon" | "sources" | "notes">;

const metres = (a: LatLon, b: LatLon) => Math.hypot((a.lat - b.lat) * 111195, (a.lon - b.lon) * 111195 * Math.cos((a.lat * Math.PI) / 180));
// LV95 -> WGS84, swisstopo approximate formulas (~1 m)
function toWGS(e: number, n: number) {
  const y = (e - 2600000) / 1e6, x = (n - 1200000) / 1e6;
  const lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3;
  const lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x ** 3;
  return { lat: (lat * 100) / 36, lon: (lon * 100) / 36 };
}
const norm = (s: string | null | undefined) => (s ?? "").normalize("NFC").toLowerCase().replace(/ß/g, "ss").replace(/[^\p{L}\p{N}]/gu, "");
const GENERIC = new Set(["restaurant", "ristorante", "hotel", "bar", "cafe", "café", "club", "the", "und", "brasserie", "confiserie", "steakhouse", "betriebe"]);
// loose on purpose: accents and "h" dropped so "Mülirad" ~ "Mühlirad"
const nameTokens = (s: string | null | undefined) => new Set((s ?? "").toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length >= 4 && !GENERIC.has(w))
  .map((w) => w.normalize("NFD").replace(/\p{M}|h/gu, "")));
const sharesName = (a: string | null | undefined, b: string | null | undefined) => [...nameTokens(a)].some((w) => [...nameTokens(b)].some((v) => v.startsWith(w.slice(0, 5)) || w.startsWith(v.slice(0, 5))));
function readCsv<Row = CsvRow>(file: string): Row[] {
  const [head, ...lines] = fs.readFileSync(`${RAW}/${file}`, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  const cols = head.split(";");
  return lines.map((l) => { const v = l.split(";"); return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? ""])) as Row; });
}
for (const f of ["actual-date-toilet.csv", "service-point.csv", "gebaeudeadressen-bern.csv"])
  assert.ok(fs.existsSync(`${RAW}/${f}`), `missing ${RAW}/${f}: run tools/fetch-raw.sh and tools/enrich-addresses.mts first`);

const rt = toWGS(2600000, 1200000);
assert.ok(metres(rt, { lat: 46.951082877, lon: 7.438632495 }) < 2, "LV95 inverse");
assert.ok(sharesName("Restaurant Mülirad", "Restaurant Mühlirad") && !sharesName("Restaurant Brésil", "Restaurant Kramer"));

const inBbox = (p: LatLon) => p.lat >= BBOX.S && p.lat <= BBOX.N && p.lon >= BBOX.W && p.lon <= BBOX.E;
const FIELDS: Field[] = ["name", "address", "access", "wheelchair", "toilets_wheelchair", "eurokey", "changing_table", "fee", "opening_hours", "unisex", "operator", "level", "check_date"];
const blank = () => Object.fromEntries(FIELDS.map((f) => [f, null])) as Record<Field, null>;

// --- OSM
const osm = (JSON.parse(fs.readFileSync("data/amenities.json", "utf8")) as { items: Amenity[] }).items.filter((i) => i.category === "toilets");
const items: Toilet[] = osm.map((t) => ({
  id: t.id, lat: t.lat, lon: t.lon, ...blank(),
  name: t.name, address: t.address, access: t.access, wheelchair: t.wheelchair,
  // on a standalone toilet, wheelchair=* describes the toilet itself
  toilets_wheelchair: t.toilets_wheelchair ?? t.wheelchair,
  eurokey: t.tags?.centralkey === "eurokey" ? "yes" : null,
  changing_table: t.changing_table, fee: t.fee, opening_hours: t.opening_hours, unisex: t.unisex,
  operator: t.operator, level: t.level, check_date: t.check_date ?? t.tags?.["check_date:wheelchair"] ?? null,
  sources: [`osm:${t.id}`], notes: [t.description, t.tags?.["description:de"]].filter(Boolean) as string[],
}));
const before = { wheel: items.filter((i) => i.toilets_wheelchair != null).length, oh: items.filter((i) => i.opening_hours != null).length, n: items.length };

const stats = { atlas: 0, nette: 0, matched: { atlas: 0, nette: 0 }, nette_place: 0, conflicts: 0 };
function merge(rec: Toilet, src: "atlas" | "nette", radius = MATCH_M) {
  const hit = items.filter((i) => !i.sources.some((s) => s.startsWith(src + ":"))).map((i): [number, Toilet] => [metres(i, rec), i])
    .filter(([d]) => d <= radius).sort((a, b) => a[0] - b[0])[0];
  if (!hit) { items.push(rec); return false; }
  const [d, it] = hit;
  stats.matched[src]++;
  for (const f of FIELDS) {
    if (it[f] == null) it[f] = rec[f];
    else if (rec[f] != null && f.includes("wheelchair") && rec[f] !== it[f]) {
      it.notes.push(`${src} says ${f}=${rec[f]}`);
      stats.conflicts++;
    }
  }
  it.sources.push(...rec.sources.map((s) => `${s} (${d.toFixed(0)} m)`));
  it.notes.push(...rec.notes);
  return true;
}

// --- ATLAS / SBB
const sp = new Map(readCsv<ServicePointRow>("service-point.csv").map((r) => [r.sloid, r]));
const today = new Date().toISOString().slice(0, 10);
const ATLAS_WC: Record<string, string> = { YES: "yes", NO: "no", PARTIALLY: "limited" }; // NOT_APPLICABLE -> null
for (const r of readCsv<AtlasToiletRow>("actual-date-toilet.csv")) {
  const p = sp.get(r.parentSloidServicePoint);
  if (!p || r.validTo < today || r.validFrom > today) continue;
  const pos = { lat: +p.wgs84North, lon: +p.wgs84East };
  if (!inBbox(pos)) continue;
  stats.atlas++;
  const rec = {
    id: `atlas/${r.sloid}`, ...pos, ...blank(),
    name: `${p.designationOfficial} – ${r.designation}`,
    toilets_wheelchair: ATLAS_WC[r.wheelchairToilet] ?? null,
    operator: p.businessOrganisationDescriptionDe || null, // editionDate is a bulk-edit date, not a survey: no check_date
    sources: [`atlas:${r.sloid}`],
    notes: [r.additionalInformation].filter(Boolean),
  };
  if (!merge(rec, "atlas", ATLAS_MATCH_M)) rec.notes.unshift("position is the station centre (ATLAS has no toilet coordinates)");
}

// --- Stadt Bern "Nette Toilette"
const reg = new Map<string, RegisterRow>();
for (const r of readCsv<RegisterRow>("gebaeudeadressen-bern.csv"))
  if (r.ADR_STATUS === "real" && r.ZIP_LABEL.endsWith(" Bern")) reg.set(`${norm(r.STN_LABEL)}|${r.ADR_NUMBER}`, r);
const places = (JSON.parse(fs.readFileSync("data/places.json", "utf8")) as { items: PlaceItem[] }).items;
NETTE.forEach(([name, street, nr], k) => {
  const a = reg.get(`${norm(street)}|${nr}`);
  assert.ok(a, `Nette Toilette address not in register: ${street} ${nr}`);
  const pos = toWGS(+a.ADR_EASTING, +a.ADR_NORTHING);
  const rec = {
    id: `nette/${k + 1}`, ...pos, ...blank(), name, address: `${a.STN_LABEL} ${a.ADR_NUMBER}, ${a.ZIP_LABEL}`, access: "yes", fee: "no", operator: name,
    sources: [`nette:${k + 1}`], notes: ["Nette Toilette (Stadt Bern): free to use without buying anything, during the business's opening hours"],
  };
  const place = places.filter((p) => metres(p, pos) <= MATCH_M && sharesName(p.name, name)).sort((p, q) => metres(p, pos) - metres(q, pos))[0];
  if (place) {
    Object.assign(rec, { wheelchair: place.wheelchair, toilets_wheelchair: place.toilets_wheelchair, opening_hours: place.opening_hours });
    rec.sources.push(`osm-place:${place.id}`);
    stats.nette_place++;
  }
  stats.nette++;
  merge(rec, "nette");
});

for (const it of items) (it as NotesSlot).notes = it.notes.length ? it.notes.join("; ") : null;
// self-checks
assert.equal(new Set(items.map((i) => i.id)).size, items.length, "duplicate ids");
assert.ok(items.every((i) => inBbox(i) && i.sources.length), "item outside bbox or without source");
assert.equal(items.length, osm.length + stats.atlas + stats.nette - stats.matched.atlas - stats.matched.nette);
assert.ok(osm.length > 100 && stats.atlas > 0 && stats.nette === NETTE.length);

const cov = (f: (i: Toilet) => boolean) => items.filter(f).length;
const after = { wheel: cov((i) => i.toilets_wheelchair != null), oh: cov((i) => i.opening_hours != null), n: items.length };
fs.writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString(),
  bbox: "46.9,7.34,46.99,7.5",
  sources: [
    { key: "osm", name: "OpenStreetMap amenity=toilets", url: "https://www.openstreetmap.org", licence: "ODbL 1.0", count: osm.length },
    { key: "atlas", name: "ATLAS toilets (BAV/SBB) via opentransportdata.swiss", url: "https://opentransportdata.swiss/de/dataset/toilet-v2", licence: "opentransportdata.swiss terms of use (free, attribution)", count: stats.atlas },
    { key: "nette", name: "Stadt Bern, Nette Toilette flyer (2018)", url: NETTE_URL, licence: "public city information (facts)", count: stats.nette },
  ],
  // access kept so customers-only/private toilets are not shown as public; OSM "unknown" means no data
  items: (items as unknown as ToiletRecord[]).map(({ id, lat, lon, sources, notes, ...raw }) => ({ f: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v === "unknown" ? null : v])), id, lat, lon, sources, notes }))
    .map(({ f, id, lat, lon, sources, notes }): ToiletRecord => ({ id, lat: +lat.toFixed(6), lon: +lon.toFixed(6), name: f.name, address: f.address, access: f.access, sources,
    wheelchair: f.wheelchair, toilets_wheelchair: f.toilets_wheelchair, eurokey: f.eurokey, changing_table: f.changing_table, fee: f.fee,
    opening_hours: f.opening_hours, unisex: f.unisex, operator: f.operator, level: f.level, check_date: f.check_date, notes })),
}));
const pc = (k: number, n: number) => `${k}/${n} (${((k / n) * 100).toFixed(0)}%)`;
console.log(`sources: osm ${osm.length}, atlas ${stats.atlas} (matched ${stats.matched.atlas}), nette ${stats.nette} (matched ${stats.matched.nette}, restaurant found in places.json ${stats.nette_place})`);
console.log(`merged items: ${items.length}, wheelchair conflicts noted: ${stats.conflicts}, eurokey=yes: ${cov((i) => i.eurokey === "yes")}`);
console.log(`toilets_wheelchair known: OSM only ${pc(before.wheel, before.n)} -> merged ${pc(after.wheel, after.n)}`);
console.log(`opening_hours known:      OSM only ${pc(before.oh, before.n)} -> merged ${pc(after.oh, after.n)}`);
console.log(`wheelchair-accessible (toilets_wheelchair=yes): ${cov((i) => i.toilets_wheelchair === "yes")}`);
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1e3).toFixed(0)} kB)`);
