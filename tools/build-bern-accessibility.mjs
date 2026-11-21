// Joins the official Swiss stop-edge (Haltekante) data with the ATLAS PRM
// accessibility data and the BfR wheelchair status for every stop edge in the
// Bern area, and writes one compact JSON the app can load directly.
//
// Usage: node tools/build-bern-accessibility.mjs data/raw data/bern-stop-accessibility.json [data/official-places.json]
// Run tools/fetch-raw.sh first to download the raw files into data/raw.
// ATLAS has some stop edges without coordinates; those get one from OSM (ref:sloid) or the city's
// Haltestelle layer in data/official-places.json, recorded in edge.coord_source. Edges still
// without a source keep lat/lon null. Stops with no edge at all (the Mattelift) get stop-level
// lat/lon from the ATLAS service point.

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const [rawDir, outFile, cityFile = "data/official-places.json"] = process.argv.slice(2);
if (!rawDir || !outFile) {
  console.error("usage: node build-bern-accessibility.mjs <raw-dir> <out.json>");
  process.exit(1);
}

// Greater Bern: city, Köniz, Ostermundigen, Muri, Ittigen, Bremgarten.
const BBOX = { minLat: 46.9, maxLat: 46.99, minLon: 7.34, maxLon: 7.5 };

const RAW = {
  trafficPoint: "traffic-point.csv",
  servicePoint: "service-point.csv",
  platform: "actual-date-platform.csv",
  stopPoint: "actual-date-stop-point.csv",
  toilet: "actual-date-toilet.csv",
  bfr: "bfr_haltestellendaten.csv",
};

function readCsv(file) {
  const text = fs.readFileSync(path.join(rawDir, file), "utf8").replace(/^﻿/, "");
  const [head, ...lines] = text.split(/\r?\n/).filter(Boolean);
  const cols = head.split(";");
  return lines.map((line) => {
    const cells = line.split(";");
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
}

const num = (v) => (v === "" || v == null ? null : Number(v));
const list = (v) => (v ? v.split("|") : []);
const yesNo = (v) => (v === "YES" ? true : v === "NO" ? false : null);

// BfR status per the legend in bfr_kombinationslogik.csv. sg = rail-bound
// (tram/train), ug = not rail-bound (bus).
const BFR_STATUS = [
  ["Autonomie", "step_free"],
  ["Rampeneinsatz", "ramp_no_booking"],
  ["Voranmeldung", "ramp_with_booking"],
  ["Ersatztransport", "replacement_transport"],
  ["keinZugang", "not_accessible"],
  ["keineInfo", "no_info"],
];
function bfrStatus(row, prefix) {
  const hit = BFR_STATUS.find(([col]) => row[`${prefix}_${col}`] === "1");
  return hit ? hit[1] : null;
}

const inBbox = (lat, lon) =>
  lat >= BBOX.minLat && lat <= BBOX.maxLat && lon >= BBOX.minLon && lon <= BBOX.maxLon;

const servicePoints = new Map(readCsv(RAW.servicePoint).map((r) => [r.sloid, r]));
const spInBbox = (sloid) => {
  const s = servicePoints.get(sloid);
  return !!s && inBbox(Number(s.wgs84North), Number(s.wgs84East));
};
const allEdges = readCsv(RAW.trafficPoint).filter((r) => r.trafficPointElementType === "BOARDING_PLATFORM");
// Edges with coordinates in the bbox, plus edges without coordinates whose stop is in the bbox.
const edges = allEdges.filter((r) =>
  r.wgs84North ? inBbox(Number(r.wgs84North), Number(r.wgs84East)) : spInBbox(r.parentSloidServicePoint),
);
const stopSloids = new Set(edges.map((e) => e.parentSloidServicePoint));
// Stops in the bbox that have no boarding edge at all in ATLAS (e.g. the Mattelift).
const withEdges = new Set(allEdges.map((r) => r.parentSloidServicePoint));
const edgelessStops = [...servicePoints.values()].filter(
  (s) => s.meansOfTransport && !withEdges.has(s.sloid) && spInBbox(s.sloid),
);
for (const s of edgelessStops) stopSloids.add(s.sloid);

const platformBySloid = new Map(
  readCsv(RAW.platform).filter((r) => stopSloids.has(r.parentSloidServicePoint)).map((r) => [r.sloid, r]),
);
const stopBySloid = new Map(
  readCsv(RAW.stopPoint).filter((r) => stopSloids.has(r.sloid)).map((r) => [r.sloid, r]),
);
const bfrBySloid = new Map(
  readCsv(RAW.bfr).filter((r) => stopSloids.has(r.sloid.split(":").slice(0, 4).join(":"))).map((r) => [r.sloid, r]),
);
const toiletsByStop = new Map();
for (const t of readCsv(RAW.toilet)) {
  if (!stopSloids.has(t.parentSloidServicePoint)) continue;
  const arr = toiletsByStop.get(t.parentSloidServicePoint) ?? [];
  arr.push({ designation: t.designation, wheelchair: yesNo(t.wheelchairToilet), info: t.additionalInformation || null });
  toiletsByStop.set(t.parentSloidServicePoint, arr);
}

// Optional: OSM platforms (Overpass JSON) tagged with ref:sloid. OSM has what
// ATLAS lacks: shelter, bench, lighting, and spoken departure info.
const osmBySloid = new Map();
const osmFile = path.join(rawDir, "osm-bern-platforms.json");
if (fs.existsSync(osmFile)) {
  for (const el of JSON.parse(fs.readFileSync(osmFile, "utf8")).elements) {
    const t = el.tags;
    for (const sloid of (t["ref:sloid"] ?? "").split(";")) {
      osmBySloid.set(sloid.trim(), {
        osm_id: `${el.type}/${el.id}`,
        lat: el.lat ?? el.center?.lat ?? null,
        lon: el.lon ?? el.center?.lon ?? null,
        shelter: t.shelter ?? null,
        bench: t.bench ?? null,
        lit: t.lit ?? null,
        tactile_paving: t.tactile_paving ?? null,
        wheelchair: t.wheelchair ?? null,
        departures_board: t.departures_board ?? null,
        speech_output: t["passenger_information_display:speech_output"] ?? t["departures_board:speech_output"] ?? null,
        width_m: t.width ? Number(t.width) : null,
      });
    }
  }
}

// City of Bern "Haltestelle" layer: one point per stop edge, keyed by DiDok number,
// mostly without the edge letter (props.Kante), with the termini served ("27 Weyermannshaus Bad").
const cityByDidok = new Map();
if (fs.existsSync(cityFile)) {
  for (const it of JSON.parse(fs.readFileSync(cityFile, "utf8")).items) {
    if (it.source !== "stadtbern.Haltestelle") continue;
    const termini = [...(it.props.Nummer_nach ?? "").matchAll(/<li>\S+ ([^<]+)<\/li>/g)].map((m) => m[1].trim());
    const arr = cityByDidok.get(it.props.Id_opendata) ?? [];
    arr.push({ lat: it.lat, lon: it.lon, kante: it.props.Kante, termini });
    cityByDidok.set(it.props.Id_opendata, arr);
  }
}
const pick = (c) => ({ lat: c.lat, lon: c.lon });
const edgesByStop = Map.groupBy(edges, (e) => e.parentSloidServicePoint);
// How many of a city point's termini an edge's ATLAS direction text names.
const score = (edgeRow, c) => {
  const text = platformBySloid.get(edgeRow.sloid)?.additionalInformation ?? "";
  return c.termini.filter((t) => text.includes(t)).length;
};

// Coordinate for an edge ATLAS has none for. Order: OSM point tagged with the edge's SLOID
// (exact); the city point with the same edge letter; the city point whose termini the edge's
// direction text names, if it is the single best match and no edge with coordinates matches it
// as well. Position is not used: city points sit 5-25 m from the ATLAS points.
function fillCoord(e, stopEdges) {
  const osm = osmBySloid.get(e.sloid);
  if (osm?.lat != null) return { lat: osm.lat, lon: osm.lon, coord_source: `osm:${osm.osm_id}` };
  const city = cityByDidok.get(e.number) ?? [];
  const label = e.designation || e.designationOperational;
  const byLetter = city.filter((c) => c.kante && c.kante === label);
  if (byLetter.length === 1) return { ...pick(byLetter[0]), coord_source: "stadtbern.Haltestelle (Kante)" };
  const [best, next] = city.map((c) => [c, score(e, c)]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (best && !(next && next[1] === best[1]) && !stopEdges.some((x) => x.wgs84North && score(x, best[0]) >= best[1]))
    return { ...pick(best[0]), coord_source: "stadtbern.Haltestelle (direction text)" };
  return { lat: null, lon: null, coord_source: null };
}

const stops = new Map();
for (const s of edgelessStops) {
  const sp = stopBySloid.get(s.sloid);
  const bfr = bfrBySloid.get(s.sloid);
  stops.set(s.sloid, {
    sloid: s.sloid,
    didok: Number(s.number),
    name: s.designationOfficial,
    operator: s.businessOrganisationDescriptionDe,
    means: list(s.meansOfTransport),
    note: sp?.freeText || null,
    assistance: sp?.assistanceAvailability || null,
    bfr: bfr ? { rail: bfrStatus(bfr, "sg"), bus: bfrStatus(bfr, "ug") } : null,
    toilets: toiletsByStop.get(s.sloid) ?? [],
    lat: Number(s.wgs84North),
    lon: Number(s.wgs84East),
    coord_source: "atlas:service-point",
    edges: [],
  });
}
for (const e of edges) {
  const stopSloid = e.parentSloidServicePoint;
  if (!stops.has(stopSloid)) {
    const sp = stopBySloid.get(stopSloid);
    const bfr = bfrBySloid.get(stopSloid);
    stops.set(stopSloid, {
      sloid: stopSloid,
      didok: Number(e.number),
      name: e.designationOfficial,
      operator: e.servicePointBusinessOrganisationDescriptionDe,
      means: sp ? list(sp.meansOfTransport) : [],
      note: sp?.freeText || null,
      assistance: sp?.assistanceAvailability || null,
      bfr: bfr ? { rail: bfrStatus(bfr, "sg"), bus: bfrStatus(bfr, "ug") } : null,
      toilets: toiletsByStop.get(stopSloid) ?? [],
      edges: [],
    });
  }
  const p = platformBySloid.get(e.sloid);
  const bfr = bfrBySloid.get(e.sloid);
  stops.get(stopSloid).edges.push({
    sloid: e.sloid,
    label: e.designation || e.designationOperational || null,
    ...(e.wgs84North
      ? { lat: Number(e.wgs84North), lon: Number(e.wgs84East) }
      : fillCoord(e, edgesByStop.get(stopSloid))),
    compass: num(e.compassDirection),
    // Free text, often "Tramlinie 6 Richtung Bern Bahnhof." Useful for both the
    // side-of-road logic and for showing the user what the pole says.
    direction_text: p?.additionalInformation || null,
    access: p
      ? {
          vehicle_access: p.vehicleAccess || null, // PLATFORM_ACCESS_WITHOUT_ASSISTANCE etc.
          level_access_wheelchair: p.levelAccessWheelchair || null,
          platform_height_cm: num(p.height),
          inclination_pct: num(p.inclination),
          inclination_longitudinal_pct: num(p.inclinationLongitudinal),
          inclination_width_pct: num(p.inclinationWidth),
          wheelchair_area_cm: p.wheelChairAreaLength ? [num(p.wheelChairAreaLength), num(p.wheelChairAreaWidth)] : null,
          shuttle_needed: yesNo(p.shuttle),
          tactile_system: yesNo(p.tactileSystems),
          attention_field: yesNo(p.attentionField),
          contrasting_areas: yesNo(p.contrastingAreas),
          dynamic_audio: yesNo(p.dynamicAudio),
          dynamic_visual: yesNo(p.dynamicVisual),
          info: list(p.infoOpportunities), // STATIC_VISUAL_INFORMATION, TEXT_TO_SPEECH_COMPLETE, ...
          boarding_device: p.boardingDevice || null,
          advice: p.adviceAccessInfo || null,
        }
      : null,
    bfr: bfr ? { rail: bfrStatus(bfr, "sg"), bus: bfrStatus(bfr, "ug") } : null,
    osm: osmBySloid.get(e.sloid) ?? null,
  });
}

const out = {
  generated: new Date().toISOString(),
  bbox: BBOX,
  sources: [
    "https://data.opentransportdata.swiss/dataset/traffic-point-v2",
    "https://data.opentransportdata.swiss/dataset/service-point-v2",
    "https://data.opentransportdata.swiss/dataset/platform-v2",
    "https://data.opentransportdata.swiss/dataset/stop-point-v2",
    "https://data.opentransportdata.swiss/dataset/toilet-v2",
    "https://data.opentransportdata.swiss/dataset/bfr-rollstuhlzuganglichkeit",
    "OpenStreetMap contributors (ODbL), via Overpass: platforms with ref:sloid",
    "Stadt Bern geoportal, Haltestelle layer (via data/official-places.json): coordinates for edges ATLAS has none for",
  ],
  stops: [...stops.values()].sort((a, b) => a.name.localeCompare(b.name)),
};
const outEdges = out.stops.flatMap((s) => s.edges);
const noCoord = outEdges.filter((e) => e.lat == null);
const filled = outEdges.filter((e) => e.coord_source);
// Self-check before writing: nothing lost, every stop locatable, unfilled edges are marked.
assert.equal(outEdges.length, edges.length);
assert.ok(out.stops.length > 300, `only ${out.stops.length} stops: raw files incomplete?`);
assert.ok(out.stops.every((s) => s.edges.length || s.lat != null), "stop without edges and without coordinates");
assert.ok(noCoord.every((e) => e.coord_source === null));
assert.ok(filled.every((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon)));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(`${out.stops.length} stops (${edgelessStops.length} without edges), ${edges.length} edges, ` +
  `${filled.length} coordinates filled, ${noCoord.length} still without -> ${outFile}`);
for (const e of noCoord) console.log(`  no coordinate: ${e.sloid} ${e.label ?? ""}`);
