// Usage: node tools/build-official-places.mts [data/official-places.json]
// Pulls official (non-OSM) Bern places: Stadt Bern geoportal layers, Kanton Bern GPKG downloads (AED, hospitals,
// elderly/disability care), SBB data.sbb.ch point datasets and the Velospot GBFS feed. See research/amenities.md.
// A failed source is recorded in `sources` (fetched_ok:false) and the build continues.
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";
import assert from "node:assert/strict";

const OUT = process.argv[2] ?? "data/official-places.json";
const [S, W, N, E] = [46.9, 7.34, 46.99, 7.5];
const inBbox = (lat: number, lon: number) => lat >= S && lat <= N && lon >= W && lon <= E;
const TERMS_OPEN = "opendata.swiss terms_open (https://opendata.swiss/terms-of-use#terms_open)";

// map.bern.ch answers plain clients with an "Access Denied" page, so every request sends a browser UA.
function get(url: string, as: "buf"): Promise<Buffer>;
function get<T>(url: string, as?: "json"): Promise<T>;
async function get(url: string, as = "json"): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (bern-access-hackathon)" }, signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (as === "buf") return Buffer.from(await res.arrayBuffer());
      const j = (await res.json()) as { error?: unknown };
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j;
    } catch (e) {
      if (attempt === 3) throw new Error(`${url}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

type LonLat = [lon: number, lat: number];
// swisstopo approximate LV03 -> WGS84 (~1 m), copied from tools/build-sbb-plan.mts (importing it runs its build).
function lv03ToWgs(y: number, x: number): LonLat {
  const Y = (y - 600000) / 1e6, X = (x - 200000) / 1e6;
  const lon = 2.6779094 + 4.728982 * Y + 0.791484 * Y * X + 0.1306 * Y * X * X - 0.0436 * Y ** 3;
  const lat = 16.9023892 + 3.238272 * X - 0.270978 * Y * Y - 0.002528 * X * X - 0.0447 * Y * Y * X - 0.014 * X ** 3;
  return [(lon * 100) / 36, (lat * 100) / 36];
}
const lv95ToWgs = (e: number, n: number) => lv03ToWgs(e - 2000000, n - 1000000); // [lon, lat]

const blank = (v: unknown) => v == null || (typeof v === "string" && ["", "-"].includes(v.trim()));
const pick = <T,>(...vs: T[]) => vs.find((v) => !blank(v)) ?? null;
const join_ = (sep: string, ...vs: unknown[]) => vs.filter((v) => !blank(v)).join(sep) || null;
const metres = (lat1: number, lon1: number, lat2: number, lon2: number) => Math.hypot((lat1 - lat2) * 111320, (lon1 - lon2) * 111320 * Math.cos((lat1 * Math.PI) / 180));

// One row of `items` in data/official-places.json (docs/places-data.md): a place of a list of the city, the canton, SBB or Velospot.
interface OfficialPlace {
  id: string; // "<source key>/<native id>"
  source: string; // "stadtbern.Sportanlage", "kantonbern.…", "sbb.…", "velospot"
  lat: number;
  lon: number;
  category: string;
  name: string | null;
  address: string | null;
  opening_hours: string | null;
  wheelchair_or_accessibility: string | null;
  phone: string | null;
  website: string | null;
  email: string | null;
  description: string | null;
  geometry_type: string; // of the source geometry: lat/lon is its centre when it is not a Point
  props: Record<string, unknown>; // the raw source attributes
}
// What a source gives item() for one place; the fields left out become null.
interface PlaceFields {
  category: string;
  name?: string | null;
  address?: string | null;
  opening_hours?: string | null;
  access?: string | null;
  phone?: string | null;
  website?: string | null;
  email?: string | null;
  description?: string | null;
  geometry_type?: string;
  props: Record<string, unknown>;
}
// One row of `sources` in data/official-places.json.
interface SourceRecord {
  key: string;
  name: string;
  url: string | null;
  licence: string | null;
  count: number;
  fetched_ok: boolean;
  error?: string;
}
// What a source's run() resolves to.
interface SourceResult { key: string; name: string; url: string; licence: string; items: OfficialPlace[] }

function item(source: string, nativeId: string | number | null, lat: number, lon: number, f: PlaceFields): OfficialPlace {
  return {
    id: `${source}/${nativeId}`, source, lat: +lat.toFixed(7), lon: +lon.toFixed(7), category: f.category,
    name: f.name ?? null, address: f.address ?? null, opening_hours: f.opening_hours ?? null,
    wheelchair_or_accessibility: f.access ?? null, phone: f.phone ?? null, website: f.website ?? null,
    email: f.email ?? null, description: f.description ?? null, geometry_type: f.geometry_type ?? "Point", props: f.props,
  };
}

type Position = number[]; // [lon, lat]
type Geometry =
  | { type: "Point"; coordinates: Position }
  | { type: "MultiPoint"; coordinates: Position[] }
  | { type: "LineString"; coordinates: Position[] }
  | { type: "MultiLineString"; coordinates: Position[][] }
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] };
// Point for any GeoJSON geometry: polygons -> area-weighted centroid of outer rings, lines/multipoints -> vertex mean.
function center(g: Geometry) {
  const rings = g.type === "Polygon" ? [g.coordinates[0]] : g.type === "MultiPolygon" ? g.coordinates.map((p) => p[0]) : null;
  if (rings) {
    let a = 0, cx = 0, cy = 0;
    for (const r of rings) for (let i = 0; i < r.length - 1; i++) {
      const [x0, y0] = r[i], [x1, y1] = r[i + 1], k = x0 * y1 - x1 * y0;
      a += k; cx += (x0 + x1) * k; cy += (y0 + y1) * k;
    }
    if (a) return [cx / (3 * a), cy / (3 * a)];
  }
  const pts = g.type === "Point" ? [g.coordinates] : g.coordinates.flat(3).reduce<Position[]>((acc, v, i, arr) => (i % 2 ? acc : [...acc, [v, arr[i + 1]]]), []);
  return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
}
function bboxOf(g: Geometry) {
  const c = JSON.stringify(g.coordinates).match(/-?\d+(\.\d+)?(e-?\d+)?/g)!.map(Number);
  const xs = c.filter((_, i) => i % 2 === 0), ys = c.filter((_, i) => i % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; // [W,S,E,N]
}

// ---------- 1. Stadt Bern geoportal (ArcGIS REST query; same layers as the WFS, but WGS84 via outSR and pageable) ----------
// [service, layerId, category]. Velopumpen, Velomiete, Berufsschulen, Kunst_im_oeffentlichen_Raum and Parkhaeuser have
// no WFS (GetCapabilities = ArcGIS error page), the REST endpoint works for all, so REST is used throughout.
type CityLayer = [service: string, layerId: number, category: string];
// ArcGIS REST: a layer's description (?f=json) and a query answer (f=geojson), as far as they are read.
interface ArcgisLayer { name: string; copyrightText?: string }
interface ArcgisFeature { id?: number; geometry: Geometry | null; properties: Record<string, unknown> }
type LvCheck = [lat: number, lon: number, e: number, n: number, from?: string];
const CITY: CityLayer[] = [
  ["Sportanlagen", 0, "sports"], ["Spielplaetze", 0, "playground"], ["Schwimmbaeder", 0, "swimming_pool"],
  ["Kunsteisbahnen", 0, "ice_rink"], ["Touristeninformation", 0, "tourist_info"], ["Quartierangebote", 0, "community_centre"],
  ["Maerkte", 0, "market"], ["Velopumpenstandorte", 0, "bicycle_pump"], ["Velomiete", 0, "bicycle_rental"],
  ["Schlauchautomate", 0, "bicycle_tube_vending"], ["Parkanlagen", 1, "park"], ["Kindertagesstaetten", 0, "childcare"],
  ["Infostaende_und_Kastanienkioske", 0, "info_stand_kiosk"], ["Abfallsammelstellen", 0, "recycling"],
  ["OekoInfoMobil", 0, "recycling_mobile"], ["Akustische_Uebergangssignale", 0, "acoustic_crossing_signal"],
  ["Taktil_visuelle_Markierungen", 1, "tactile_paving"], ["Haltestellen", 0, "transit_stop"], ["Bahnhoefe", 0, "railway_station"],
  ["Parkplaetze_oeffentlich", 5, "disabled_parking"], ["Parkplaetze_oeffentlich", 4, "bicycle_station"],
  ["Parkplaetze_oeffentlich", 3, "bicycle_parking"], ["Parkplaetze_oeffentlich", 2, "taxi"],
  ["Parkplaetze_oeffentlich", 6, "car_sharing"], ["Parkplaetze_oeffentlich", 7, "ev_parking"], ["Parkhaeuser", 0, "parking_garage"],
  ["Stadtverwaltungen", 0, "city_office"], ["Kantonsverwaltungen", 0, "cantonal_office"], ["Bundesverwaltungen", 0, "federal_office"],
  ["Stimmlokale", 0, "polling_station"], ["Kindesschutz", 0, "child_protection"], ["Kinderangebote", 0, "children_services"],
  ["Jugendangebote", 0, "youth_services"], ["Kindergaerten", 0, "kindergarten"], ["Volksschulen", 0, "school"],
  ["Mittelschulen", 0, "secondary_school"], ["Berufsschulen", 0, "vocational_school"], ["Hochschulen", 0, "university"],
  ["Sehenswuerdigkeiten", 0, "attraction"], ["Kunst_im_oeffentlichen_Raum", 0, "public_art"], ["Messegelaende", 0, "exhibition_centre"],
  ["Friedhoefe", 1, "cemetery"], ["Krematorium", 0, "crematorium"], ["Familiengaerten", 1, "allotments"],
];
const HOURS = /\b\d{1,2}[.:]\d{2}\s*(-|–|bis)\s*\d{1,2}[.:]?\d{0,2}|\b(Mo|Di|Mi|Do|Fr|Sa|So)[a-z]*\b.*\d/;
const lvCheck: LvCheck[] = []; // [lat, lon, E, N] for the LV95 conversion self-check

async function city([svc, layer, category]: CityLayer) {
  const base = `https://map.bern.ch/arcgis/rest/services/Geoportal/${svc}/MapServer/${layer}`;
  const meta = await get<ArcgisLayer>(`${base}?f=json`);
  const env = `geometry=${W},${S},${E},${N}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects`;
  const feats = [];
  for (let off = 0; ; off += 1000) {
    const fc = await get<{ features: ArcgisFeature[] }>(`${base}/query?where=1%3D1&${env}&outFields=*&outSR=4326&f=geojson&resultOffset=${off}&resultRecordCount=1000`);
    feats.push(...fc.features);
    if (fc.features.length < 1000) break;
  }
  const key = `stadtbern.${meta.name}`;
  const items = [];
  for (const f of feats) {
    if (!f.geometry) continue;
    const p = f.properties, g = <T = string,>(k: string) => p[Object.keys(p).find((x) => x.toLowerCase() === k.toLowerCase()) as string] as T | null | undefined;
    const [lon, lat] = center(f.geometry);
    if (!inBbox(lat, lon)) continue;
    const h = pick(g<number>("H_coord"), g<number>("Hkoord")), v = pick(g<number>("V_coord"), g<number>("Vkoord"));
    if (f.geometry.type === "Point" && h! > 2e6) lvCheck.push([lat, lon, h!, v!]);
    const divHours = ["Divattr1", "Divattr2", "Divattr3", "Divattr4"].map(g).find((x) => typeof x === "string" && HOURS.test(x));
    items.push(item(key, pick(g<number>("Objectid"), f.id), lat, lon, {
      category,
      name: pick(g("Punktname"), g("Name"), g("Name_grundflaeche"), g("Werktitel"), g("Gebaeudename"),
        g("Nummer") != null ? `${meta.name.replace(/_/g, " ")} ${g("Nummer")}` : null, g("Art_beschrieb"), g("Rubrik_Desc")),
      address: join_(", ", join_(" ", g("Strasse"), g("Hausnummer")), join_(" ", g("PLZ"), g("Ort"))),
      opening_hours: pick(g("Haltezeiten"), divHours),
      access: join_("; ", g("Zugang_hindernisfrei_Desc"), g("Zugang_Bemerkung")),
      phone: pick(g("Telefon")), email: pick(g("Email")), website: pick(g("URL"), g("Url1"), g("Spaziergang_URL")),
      description: pick(g("Beschrieb"), g("Kurztext"), g("Material"), g("Art_beschrieb"), g("Flaeche_art_beschrieb")),
      geometry_type: f.geometry.type,
      props: f.geometry.type === "Point" ? p : { ...p, geometry_bbox: bboxOf(f.geometry) },
    }));
  }
  return { key, name: `Stadt Bern geoportal: ${svc}${layer ? ` / ${meta.name}` : ""}`, url: `${base}/query`, licence: `${TERMS_OPEN}; © ${meta.copyrightText || "Geodaten Stadt Bern"}`, items };
}

// ---------- 2/3. Kanton Bern GPKG downloads (geofiles.be.ch) ----------
// Minimal zip reader (deflate/store, no zip64): returns the named entry's bytes.
function unzip(buf: Buffer, wanted: string) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
    const nameLen = buf.readUInt16LE(p + 28), name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const lh = buf.readUInt32LE(p + 42), size = buf.readUInt32LE(p + 20), method = buf.readUInt16LE(p + 10);
      const data = buf.subarray(lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28)).subarray(0, size);
      return method === 8 ? inflateRawSync(data) : data;
    }
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  throw new Error(`${wanted} not in zip`);
}
// GPKG point blob: 'GP' header (+ optional envelope) then WKB point x,y in the table SRS (LV95 here).
function gpkgPoint(b: Buffer) {
  const env = [0, 32, 48, 48, 64][(b[3] >> 1) & 7], o = 8 + env, le = b[o] === 1;
  const type = le ? b.readUInt32LE(o + 1) : b.readUInt32BE(o + 1);
  assert(type % 1000 === 1, `not a point (WKB type ${type})`);
  return le ? [b.readDoubleLE(o + 5), b.readDoubleLE(o + 13)] : [b.readDoubleBE(o + 5), b.readDoubleBE(o + 13)];
}
// The columns of one GPKG row, the geometry aside. Each table's interface (further down) names the columns its source reads.
interface GpkgProps { [column: string]: SQLOutputValue; objectid: number }
async function canton<P extends GpkgProps>(code: string, table: string, map: (r: P) => Omit<PlaceFields, "props">) {
  const url = `https://geofiles.be.ch/geoportal/pub/download/${code}/${code.toLowerCase()}.gpkg.zip`;
  const dir = mkdtempSync(join(tmpdir(), "be-gpkg-")), file = join(dir, `${code}.gpkg`);
  writeFileSync(file, unzip(await get(url, "buf"), `${code}.gpkg`));
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare(`select * from "geodb.${table}"`).all();
  db.close(); rmSync(dir, { recursive: true, force: true });
  const key = `kantonbern.${table.replace(/_vw$/, "")}`;
  const items = [];
  for (const r of rows) {
    const { geometry, ...props } = r;
    const [e, n] = gpkgPoint(Buffer.from(geometry as Uint8Array));
    const [lon, lat] = lv95ToWgs(e, n);
    if (!inBbox(lat, lon)) continue;
    if (props.lat_deg) lvCheck.push([props.lat_deg as number, props.long_deg as number, e, n, "aed"]); // AED ships WGS84 too: cross-check
    items.push(item(key, props.objectid as number, lat, lon, { ...map(props as P), props: { ...props, lv95: [e, n] } }));
  }
  return { key, url, licence: `${TERMS_OPEN}; terms_of_use_de.pdf inside the zip`, items };
}
const yn = (v: SQLOutputValue | undefined) => (v === 1 ? "Ja" : v === 0 ? "Nein" : null);
const flags = (r: GpkgProps, labels: Record<string, string>) => Object.entries(labels).map(([k, l]) => `${l}: ${yn(r[k])}`).join("; ");
const addr = (r: GpkgProps) => join_(", ", r.adresse ?? r.lokalisat, join_(" ", r.plz, r.ortschaft));
const web = (u: string | null | undefined) => (blank(u) ? null : /^https?:/.test(u!) ? u! : `https://${u!.replace(/^www,/, "www.")}`);

// ---------- 4. SBB data.sbb.ch (Opendatasoft v2.1) ----------
// A dataset's description, as far as it is read.
interface OdsDataset { metas: { default: { title: string; license?: string | null } } }
// A row of a data.sbb.ch export. Each dataset's interface (further down) names the columns its source reads.
interface SbbRow { [column: string]: unknown; geopos?: { lat: number; lon: number } | null }
// How a dataset's rows R become places: `group` first turns them into the things G that are placed (default: the rows themselves).
interface SbbMap<R, G> {
  group?: (rows: R[]) => G[];
  id: (r: G) => string | number | null;
  f: (r: G) => Omit<PlaceFields, "props">;
}
async function sbb<R extends SbbRow, G extends SbbRow = R>(id: string, map: SbbMap<R, G>) {
  const base = `https://data.sbb.ch/api/explore/v2.1/catalog/datasets/${id}`;
  const meta = await get<OdsDataset>(base);
  const rows = await get<R[]>(`${base}/exports/json`);
  const key = `sbb.${id}`;
  const items = [], seen: Record<string, number> = {};
  for (const r of (map.group ? map.group(rows) : rows) as G[]) {
    if (!r.geopos) continue;
    // shortcut: mobiliar-im-bahnhof ships geopos with lat/lon swapped; detect by value range (Swiss lat > lon always).
    const [lat, lon] = r.geopos.lat < r.geopos.lon ? [r.geopos.lon, r.geopos.lat] : [r.geopos.lat, r.geopos.lon];
    if (!inBbox(lat, lon)) continue;
    // billetautomat id_automat and wartehallen sloid are not unique per row (null, "BLS", one sloid per station): add #n.
    const id = map.id(r) as string | number, n = (seen[id] = (seen[id] ?? 0) + 1);
    items.push(item(key, n > 1 ? `${id}#${n}` : id, lat, lon, { ...map.f(r), props: r }));
  }
  return { key, name: `SBB data.sbb.ch: ${meta.metas.default.title}`, url: `${base}/exports/json`, licence: meta.metas.default.license ?? "not stated on dataset (portal licence https://data.sbb.ch/page/licence)", items };
}

// ---------- 5. Velospot GBFS v3 ----------
// GBFS 3.0 station_information and station_status, as far as they are read.
interface GbfsStation {
  station_id: string;
  name?: { text: string; language?: string }[];
  lat: number;
  lon: number;
  address?: string;
  post_code?: string;
  capacity?: number;
  is_virtual_station?: boolean;
  rental_uris?: { web?: string };
}
interface GbfsStationInfo { data: { stations: GbfsStation[] } }
interface GbfsStationStatus { last_updated: string; data: { stations: { station_id: string }[] } }
async function velospot() {
  const base = "https://api.mobidata-bw.de/sharing/gbfs/v3/velospot_ch";
  const [info, status] = await Promise.all([get<GbfsStationInfo>(`${base}/station_information`), get<GbfsStationStatus>(`${base}/station_status`)]);
  const st = new Map(status.data.stations.map((s) => [s.station_id, s]));
  const items = info.data.stations.filter((s) => inBbox(s.lat, s.lon)).map((s) => item("velospot", s.station_id, s.lat, s.lon, {
    // some names embed hours: "Open from 05:00 to 21:15 - Velostation Schanzenbrücke - Bern"
    category: "bike_share", name: s.name?.[0]?.text?.replace(/^Open from \S+ to \S+ - /, ""), opening_hours: s.name?.[0]?.text?.match(/^Open from (\S+) to (\S+) - /)?.slice(1).join("-") ?? null, address: join_(", ", s.address, s.post_code),
    description: join_("; ", s.capacity != null && `capacity ${s.capacity}`, s.is_virtual_station && "virtual station (no dock)"),
    website: s.rental_uris?.web, props: { ...s, status_snapshot: st.get(s.station_id) ?? null, status_last_updated: status.last_updated },
  }));
  return { key: "velospot", name: "Velospot (ex-PubliBike) GBFS 3.0 via MobiData BW", url: `${base}/gbfs`, licence: "not stated in the feed (system_information has no license_url)", items };
}

// The columns each Kanton Bern table's source reads.
interface AedRow extends GpkgProps { titel: string; telefon: string | null; beschreib: string | null; zugzeit: string | null; zugang: string | null }
interface SpitalRow extends GpkgProps { bez_sto: string | null; bez_firma: string | null; url: string | null }
interface IlvRow extends GpkgProps { iname: string; trname: string | null; telefon: string | null; email: string | null; url: string | null }
type IlvTable = [table: string, category: string, labels: Record<string, string>];
// The columns each SBB dataset's source reads.
interface WifiRow extends SbbRow { bpuic: number; standort: string }
interface TicketMachineRow extends SbbRow { id_automat: string | null; bps_name: string; typ_text: string | null; eigentumer: string | null; sprache: string | null }
interface ValidatorRow extends SbbRow { ipid: number; bps_name: string; befestigungsart: string | null; bemerkung: string | null }
interface WaitingRoomRow extends SbbRow {
  globalid: string | null;
  sloid: string | null;
  gebaudename: string | null;
  bezeichnung_offiziell: string | null;
  strasse: string | null;
  plz: string | null;
  ort: string | null;
  gebaudetyp: string | null;
  status: string | null;
}
interface SectorSignRow extends SbbRow {
  fid: number;
  bps_name: string;
  kundengleisnummer: string | null;
  sektor_vorderseite: string | null;
  sektor_ruckseiter: string | null;
  montage_an: string | null;
}
interface LoudspeakerRow extends SbbRow { uuid: string; bps_name: string; typ_auswahl: string | null; montage_an: string | null; bemerkung: string | null }
interface SafetyLineRow extends SbbRow { sloid: string | null; bpuic: number; bezeichnung_offiziell: string; tsli_am_01_01_2018: string | null; bemerkungen: string | null }
interface FurnitureRow extends SbbRow { bpuic: string; bezeichnung_offiziell: string; bezeichnung: string; flame2: number | null }
/** Object.groupBy (ES2024, in Node since 21), which this project's "es2023" lib does not declare. Every key that occurs has a list. */
type ObjectWithGroupBy = ObjectConstructor & { groupBy<K extends PropertyKey, T>(items: Iterable<T>, keyOf: (item: T, index: number) => K): Record<K, T[]> };

const SOURCES: { key: string; run: () => Promise<SourceResult> }[] = [
  ...CITY.map((c) => ({ key: `stadtbern.${c[0]}/${c[1]}`, run: () => city(c) })),
  { key: "kantonbern.aedsto", run: () => canton("AEDSTO", "aedsto_aedsto_vw", (r: AedRow) => ({
    category: "aed", name: r.titel, address: addr(r), phone: r.telefon, description: r.beschreib,
    opening_hours: join_(": ", r.zugzeit, r.zugang),
  })).then((s) => ({ ...s, name: "Kanton Bern AED-Standorte (AEDSTO)" })) },
  { key: "kantonbern.spital", run: () => canton("SPITAL", "spital_spitklin_vw", (r: SpitalRow) => ({
    category: "hospital", name: pick(r.bez_sto, r.bez_firma), address: addr(r), website: web(r.url),
    description: join_("; ", r.bez_firma, flags(r, { akut: "Akutspital", geburt: "Geburtshilfe", psychklin: "Psychiatrische Klinik", rehaklin: "Rehaklinik" })),
  })).then((s) => ({ ...s, name: "Kanton Bern Spitäler und Kliniken (SPITAL)" })) },
  ...([["ilv_stoalter_vw", "elderly_care", { altersheim: "Alters-/Pflegeheim", tagestbeta: "Tagesstätte", wohnmitdl: "Wohnen mit Dienstleistungen" }],
    ["ilv_stoerwb_vw", "disability_services", { tagstemb: "Tagesstätte", werkstemb: "Werkstätte", wheimemb: "Wohnheim" }]] satisfies IlvTable[]).map(([t, category, labels]) => ({
    key: `kantonbern.${t.replace(/_vw$/, "")}`, run: () => canton("ILV", t, (r: IlvRow) => ({
      category, name: r.iname, address: addr(r), phone: r.telefon, email: r.email, website: web(r.url),
      description: join_("; ", r.trname && `Träger: ${r.trname}`, flags(r, labels)),
    })).then((s) => ({ ...s, name: `Kanton Bern Leistungserbringung Alter und Behinderung (ILV / ${t})` })),
  })),
  { key: "sbb.wifistation", run: () => sbb("wifistation", { id: (r: WifiRow) => r.bpuic, f: (r) => ({ category: "wifi", name: `SBB Wifi@Station ${r.standort}` }) }) },
  { key: "sbb.billetautomat", run: () => sbb("billetautomat", { id: (r: TicketMachineRow) => r.id_automat, f: (r) => ({ category: "ticket_machine", name: `Billetautomat ${r.bps_name}`, description: join_("; ", r.typ_text, r.eigentumer, r.sprache) }) }) },
  { key: "sbb.billetentwerter", run: () => sbb("billetentwerter", { id: (r: ValidatorRow) => r.ipid, f: (r) => ({ category: "ticket_validator", name: `Billetentwerter ${r.bps_name}`, description: join_("; ", r.befestigungsart, r.bemerkung) }) }) },
  { key: "sbb.haltestelle-wartehallen", run: () => sbb("haltestelle-wartehallen", { id: (r: WaitingRoomRow) => r.globalid ?? r.sloid, f: (r) => ({ category: "waiting_room", name: join_(" ", r.gebaudename, r.bezeichnung_offiziell), address: join_(", ", r.strasse, join_(" ", r.plz, r.ort)), description: join_("; ", r.gebaudetyp, r.status) }) }) },
  { key: "sbb.sektortafel", run: () => sbb("sektortafel", { id: (r: SectorSignRow) => r.fid, f: (r) => ({ category: "platform_sector_sign", name: `${r.bps_name} Gleis ${r.kundengleisnummer ?? "?"} Sektor ${join_("/", r.sektor_vorderseite, r.sektor_ruckseiter)}`, description: r.montage_an }) }) },
  { key: "sbb.12093_lautsprecher-akkustikbox", run: () => sbb("12093_lautsprecher-akkustikbox", { id: (r: LoudspeakerRow) => r.uuid, f: (r) => ({ category: "acoustic_info_box", name: `${r.typ_auswahl} ${r.bps_name}`, description: join_("; ", r.montage_an, r.bemerkung) }) }) },
  { key: "sbb.haltestelle-visuell-taktile-sicherheitslinie", run: () => sbb("haltestelle-visuell-taktile-sicherheitslinie", { id: (r: SafetyLineRow) => r.sloid ?? r.bpuic, f: (r) => ({ category: "tactile_safety_line", name: r.bezeichnung_offiziell, access: `visuell-taktile Sicherheitslinie (Stand 01.01.2018): ${r.tsli_am_01_01_2018}`, description: r.bemerkungen }) }) },
  // One row per (station, item type); collapse to one place per station with an inventory summary.
  { key: "sbb.mobiliar-im-bahnhof", run: () => sbb("mobiliar-im-bahnhof", {
    group: (rows: FurnitureRow[]) => Object.values((Object as ObjectWithGroupBy).groupBy(rows, (r) => r.bpuic)).map((rs) => ({ bpuic: rs[0].bpuic, bezeichnung_offiziell: rs[0].bezeichnung_offiziell, geopos: rs[0].geopos,
      inventory: Object.fromEntries(Object.entries((Object as ObjectWithGroupBy).groupBy(rs, (r) => r.bezeichnung)).map(([k, v]) => [k, v.reduce((s, r) => s + (r.flame2 ?? 0), 0)])), rows: rs })),
    id: (r) => r.bpuic,
    f: (r) => ({ category: "station_inventory", name: `${r.bezeichnung_offiziell} (SBB station furniture)`, description: Object.entries(r.inventory).map(([k, v]) => `${k}: ${v}`).join("; ") }),
  }) },
  { key: "velospot", run: velospot },
];

const sources: SourceRecord[] = [], items: OfficialPlace[] = [];
for (const s of SOURCES) {
  try {
    const r = await s.run();
    sources.push({ key: r.key, name: r.name, url: r.url, licence: r.licence, count: r.items.length, fetched_ok: true });
    items.push(...r.items);
    console.log(`${r.key}: ${r.items.length}`);
  } catch (e) {
    sources.push({ key: s.key, name: s.key, url: null, licence: null, count: 0, fetched_ok: false, error: (e as Error).message });
    console.error(`FAILED ${s.key}: ${(e as Error).message}`);
  }
}

// ---------- self-check ----------
assert.equal(new Set(items.map((i) => i.id)).size, items.length, "ids unique");
for (const i of items) assert(Number.isFinite(i.lat) && Number.isFinite(i.lon) && inBbox(i.lat, i.lon), `bad coords ${i.id}`);
// Our LV95 formula vs coordinates the publisher computed (city: server-side reprojection; AED: lat_deg/long_deg).
const worst = Math.max(...lvCheck.map(([lat, lon, e, n]) => { const [lo, la] = lv95ToWgs(e, n); return metres(lat, lon, la, lo); }));
assert(lvCheck.length > 100 && worst < 5, `LV95 check: ${lvCheck.length} pts, worst ${worst} m`);
const bahnhof = items.find((i) => i.source === "stadtbern.Bahnhof" && i.name === "Bern");
if (bahnhof) assert(metres(bahnhof.lat, bahnhof.lon, 46.949, 7.4392) < 150, "Bern Bahnhof position");

writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), sources, items }));
console.log(`wrote ${OUT}: ${items.length} items from ${sources.filter((s) => s.fetched_ok).length}/${sources.length} sources; LV95 check ${lvCheck.length} pts, worst ${worst.toFixed(2)} m; Bahnhof ${bahnhof?.lat},${bahnhof?.lon}`);
