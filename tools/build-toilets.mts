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

const metres = (a, b) => Math.hypot((a.lat - b.lat) * 111195, (a.lon - b.lon) * 111195 * Math.cos((a.lat * Math.PI) / 180));
// LV95 -> WGS84, swisstopo approximate formulas (~1 m)
function toWGS(e, n) {
  const y = (e - 2600000) / 1e6, x = (n - 1200000) / 1e6;
  const lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3;
  const lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x ** 3;
  return { lat: (lat * 100) / 36, lon: (lon * 100) / 36 };
}
const norm = (s) => (s ?? "").normalize("NFC").toLowerCase().replace(/ß/g, "ss").replace(/[^\p{L}\p{N}]/gu, "");
const GENERIC = new Set(["restaurant", "ristorante", "hotel", "bar", "cafe", "café", "club", "the", "und", "brasserie", "confiserie", "steakhouse", "betriebe"]);
// loose on purpose: accents and "h" dropped so "Mülirad" ~ "Mühlirad"
const nameTokens = (s) => new Set((s ?? "").toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length >= 4 && !GENERIC.has(w))
  .map((w) => w.normalize("NFD").replace(/\p{M}|h/gu, "")));
const sharesName = (a, b) => [...nameTokens(a)].some((w) => [...nameTokens(b)].some((v) => v.startsWith(w.slice(0, 5)) || w.startsWith(v.slice(0, 5))));
function readCsv(file) {
  const [head, ...lines] = fs.readFileSync(`${RAW}/${file}`, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  const cols = head.split(";");
  return lines.map((l) => { const v = l.split(";"); return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? ""])); });
}
for (const f of ["actual-date-toilet.csv", "service-point.csv", "gebaeudeadressen-bern.csv"])
  assert.ok(fs.existsSync(`${RAW}/${f}`), `missing ${RAW}/${f}: run tools/fetch-raw.sh and tools/enrich-addresses.mts first`);

const rt = toWGS(2600000, 1200000);
assert.ok(metres(rt, { lat: 46.951082877, lon: 7.438632495 }) < 2, "LV95 inverse");
assert.ok(sharesName("Restaurant Mülirad", "Restaurant Mühlirad") && !sharesName("Restaurant Brésil", "Restaurant Kramer"));

const inBbox = (p) => p.lat >= BBOX.S && p.lat <= BBOX.N && p.lon >= BBOX.W && p.lon <= BBOX.E;
const FIELDS = ["name", "address", "access", "wheelchair", "toilets_wheelchair", "eurokey", "changing_table", "fee", "opening_hours", "unisex", "operator", "level", "check_date"];
const blank = () => Object.fromEntries(FIELDS.map((f) => [f, null]));

// --- OSM
const osm = JSON.parse(fs.readFileSync("data/amenities.json", "utf8")).items.filter((i) => i.category === "toilets");
const items = osm.map((t) => ({
  id: t.id, lat: t.lat, lon: t.lon, ...blank(),
  name: t.name, address: t.address, access: t.access, wheelchair: t.wheelchair,
  // on a standalone toilet, wheelchair=* describes the toilet itself
  toilets_wheelchair: t.toilets_wheelchair ?? t.wheelchair,
  eurokey: t.tags?.centralkey === "eurokey" ? "yes" : null,
  changing_table: t.changing_table, fee: t.fee, opening_hours: t.opening_hours, unisex: t.unisex,
  operator: t.operator, level: t.level, check_date: t.check_date ?? t.tags?.["check_date:wheelchair"] ?? null,
  sources: [`osm:${t.id}`], notes: [t.description, t.tags?.["description:de"]].filter(Boolean),
}));
const before = { wheel: items.filter((i) => i.toilets_wheelchair != null).length, oh: items.filter((i) => i.opening_hours != null).length, n: items.length };

const stats = { atlas: 0, nette: 0, matched: { atlas: 0, nette: 0 }, nette_place: 0, conflicts: 0 };
function merge(rec, src, radius = MATCH_M) {
  const hit = items.filter((i) => !i.sources.some((s) => s.startsWith(src + ":"))).map((i) => [metres(i, rec), i])
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
const sp = new Map(readCsv("service-point.csv").map((r) => [r.sloid, r]));
const today = new Date().toISOString().slice(0, 10);
const ATLAS_WC = { YES: "yes", NO: "no", PARTIALLY: "limited" }; // NOT_APPLICABLE -> null
for (const r of readCsv("actual-date-toilet.csv")) {
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
const reg = new Map();
for (const r of readCsv("gebaeudeadressen-bern.csv"))
  if (r.ADR_STATUS === "real" && r.ZIP_LABEL.endsWith(" Bern")) reg.set(`${norm(r.STN_LABEL)}|${r.ADR_NUMBER}`, r);
const places = JSON.parse(fs.readFileSync("data/places.json", "utf8")).items;
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

for (const it of items) it.notes = it.notes.length ? it.notes.join("; ") : null;
// self-checks
assert.equal(new Set(items.map((i) => i.id)).size, items.length, "duplicate ids");
assert.ok(items.every((i) => inBbox(i) && i.sources.length), "item outside bbox or without source");
assert.equal(items.length, osm.length + stats.atlas + stats.nette - stats.matched.atlas - stats.matched.nette);
assert.ok(osm.length > 100 && stats.atlas > 0 && stats.nette === NETTE.length);

const cov = (f) => items.filter(f).length;
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
  items: items.map(({ id, lat, lon, sources, notes, ...raw }) => ({ f: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v === "unknown" ? null : v])), id, lat, lon, sources, notes }))
    .map(({ f, id, lat, lon, sources, notes }) => ({ id, lat: +lat.toFixed(6), lon: +lon.toFixed(6), name: f.name, address: f.address, access: f.access, sources,
    wheelchair: f.wheelchair, toilets_wheelchair: f.toilets_wheelchair, eurokey: f.eurokey, changing_table: f.changing_table, fee: f.fee,
    opening_hours: f.opening_hours, unisex: f.unisex, operator: f.operator, level: f.level, check_date: f.check_date, notes })),
}));
const pc = (k, n) => `${k}/${n} (${((k / n) * 100).toFixed(0)}%)`;
console.log(`sources: osm ${osm.length}, atlas ${stats.atlas} (matched ${stats.matched.atlas}), nette ${stats.nette} (matched ${stats.matched.nette}, restaurant found in places.json ${stats.nette_place})`);
console.log(`merged items: ${items.length}, wheelchair conflicts noted: ${stats.conflicts}, eurokey=yes: ${cov((i) => i.eurokey === "yes")}`);
console.log(`toilets_wheelchair known: OSM only ${pc(before.wheel, before.n)} -> merged ${pc(after.wheel, after.n)}`);
console.log(`opening_hours known:      OSM only ${pc(before.oh, before.n)} -> merged ${pc(after.oh, after.n)}`);
console.log(`wheelchair-accessible (toilets_wheelchair=yes): ${cov((i) => i.toilets_wheelchair === "yes")}`);
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1e3).toFixed(0)} kB)`);
