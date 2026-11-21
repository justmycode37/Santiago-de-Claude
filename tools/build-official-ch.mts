// Usage: node tools/build-official-ch.mts [data/ch/official-ch.json]
// Official (non-OSM) open data for basic amenities across Switzerland: ATLAS station toilets, city toilet / fountain /
// AED / hospital datasets (Zürich, Basel, Geneva, Luzern, St.Gallen, Zug, Biel), Kanton Bern AED + hospitals, the
// national hospital-site list (Kanton Solothurn), BAZL hospital helipads, BABS emergency meeting points, SBB station
// amenities, pharmacies (BL, GE), Geneva post offices, Luzern libraries. See docs/data-ch-official.md.
// A failed source is recorded in `sources` (fetched_ok:false) and the build continues.
// Helpers copied from tools/build-official-places.mts / build-services.mts (importing those runs their builds).
import { writeFileSync, readFileSync, mkdtempSync, rmSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { inflateRawSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";

const OUT = process.argv[2] ?? "data/ch/official-ch.json";
const inCH = (lat: number, lon: number) => lat >= 45.8 && lat <= 47.9 && lon >= 5.9 && lon <= 10.6;
const TERMS_OPEN = "opendata.swiss terms_open (https://opendata.swiss/terms-of-use#terms_open)";
const TERMS_BY = "opendata.swiss terms_by: free use, source must be cited (https://opendata.swiss/terms-of-use#terms_by)";
const TERMS_BY_ASK = "opendata.swiss terms_by_ask: non-commercial use free with attribution, commercial use needs the publisher's permission (https://opendata.swiss/terms-of-use#terms_by_ask)";
const CC_BY = "CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)";
const GEOADMIN_TERMS = "geo.admin.ch federal geodata, free use with source attribution (https://www.geo.admin.ch/en/general-terms-of-use-fsdi)";
const TODAY = new Date().toISOString().slice(0, 10);

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
type LV95 = [e: number, n: number];
// swisstopo approximate LV03 -> WGS84 (~1 m).
function lv03ToWgs(y: number, x: number): LonLat {
  const Y = (y - 600000) / 1e6, X = (x - 200000) / 1e6;
  const lon = 2.6779094 + 4.728982 * Y + 0.791484 * Y * X + 0.1306 * Y * X * X - 0.0436 * Y ** 3;
  const lat = 16.9023892 + 3.238272 * X - 0.270978 * Y * Y - 0.002528 * X * X - 0.0447 * Y * Y * X - 0.014 * X ** 3;
  return [(lon * 100) / 36, (lat * 100) / 36];
}
const lv95ToWgs = (e: number, n: number) => lv03ToWgs(e - 2000000, n - 1000000); // [lon, lat]
const metres = (lat1: number, lon1: number, lat2: number, lon2: number) => Math.hypot((lat1 - lat2) * 111320, (lon1 - lon2) * 111320 * Math.cos((lat1 * Math.PI) / 180));

const blank = (v: unknown) => v == null || (typeof v === "string" && ["", "-", "n.a.", "unbekannt"].includes(v.trim()));
const pick = <T,>(...vs: T[]) => vs.find((v) => !blank(v)) ?? null;
const clean = (v: unknown) => (blank(v) ? null : String(v).replace(/<br\s*\/?>/gi, "; ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || null);
const join_ = (sep: string, ...vs: unknown[]) => vs.filter((v) => !blank(v)).join(sep) || null;
const web = (u: string | null | undefined) => (blank(u) ? null : /^https?:/.test(u!) ? u!.replace("https://https://", "https://") : `https://${u!.trim()}`);
// "Rue Caroline 1, 1227 Les Acacias" / "26 route de chêne 1207 genève" -> postcode + city
const plzOrt = (s: unknown) => { const m = clean(s)?.match(/(?:^|[\s,])(\d{4})\s+([^\d,]+)$/); return m ? { postcode: m[1], city: m[2].trim() } : {}; };

type OfficialCategory = "toilets" | "shower" | "drinking_water" | "fountain" | "aed" | "hospital" | "hospital_helipad" | "emergency_department"
  | "emergency_meeting_point" | "wifi" | "ticket_machine" | "waiting_room" | "pharmacy" | "post_office" | "library";
type Wheelchair = "yes" | "limited" | "no";
// A source record as it was read (a GeoJSON feature's properties, a row of a JSON export, of a CSV or of a GPKG table).
// Each source's interface (above its function) names the columns that are read.
interface Props { [column: string]: unknown }
// The fee fields of an item: the raw text, what it says about paying, and the amount as written.
interface Fee { fee: string | null; paid: "free" | "paid" | null; price: string | null }
// One row of `items` in data/ch/official-ch.json (docs/data-ch-official.md).
interface OfficialItem extends Fee {
  id: string; // "<source>/<native id>"
  source: string; // "zh.zueriwc", "atlas.toilet", ...
  category: OfficialCategory;
  lat: number;
  lon: number;
  name: string | null;
  address: string | null;
  postcode: string | null;
  city: string | null;
  canton: string | null;
  opening_hours: string | null;
  wheelchair: Wheelchair | null;
  phone: string | null;
  website: string | null;
  props: Props; // the source record, trimmed
}
// What a source gives item() for one place; the fields left out become null.
interface ItemFields {
  category: OfficialCategory;
  name?: string | null;
  address?: string | null;
  postcode?: string | number | null;
  city?: string | null;
  canton?: string | null;
  opening_hours?: string | null;
  fee?: string | null;
  wheelchair?: Wheelchair | null;
  phone?: string | null;
  website?: string | null;
  props: Props;
}
// One row of `sources` in data/ch/official-ch.json.
interface SourceRecord {
  key: string;
  name: string;
  url: string | null;
  licence: string | null;
  count: number;
  fetched_ok: boolean;
  error?: string;
}
// What a source's run() resolves to: an item is null when its point is missing or outside Switzerland.
interface SourceResult { key: string; name: string; url: string; licence: string; items: (OfficialItem | null)[] }

// Toilet fee text -> paid "free"|"paid"|null + price. "free" = some WC at the site is usable without paying, even if
// another cabin or time slot costs (Zürich "Behinderten-WC Fr. 1.-- oder Eurokey, Multifunktions-WC gratis"); `price`
// then names that charge. Free-only-with-Eurokey or free-pissoir-only does not count as free. Raw text stays in `fee`.
const FREE = /gebührenfrei|kostenlos|gratis|gratuit|gratuito|unentgeltlich|\bfree\b/i;
const NOT_FREE = /(?:eurokey|pissoir)\s*(?:gratis|kostenlos)|(?:gratis|kostenlos)\s*mit\s*eurokey/gi;
const PAID = /kostenpflichtig|payant|a pagamento|gebühr(?!enfrei)|münz|kreditkart|franken|\b(?:fr|chf|sfr)\.?\s*\d|\d\s*(?:chf|fr\.|rp\.?)(?!\w)/i;
const PRICE = /(?:CHF|SFr\.?|Fr\.)\s*\d+(?:[.,]\d+)?(?:\.?[-–]+)?|\d+(?:[.,]\d+)?\s*(?:CHF|Fr\.|Rp\.?|Franken)(?!\w)/i;
function feeOf(raw: unknown): Fee {
  const t = clean(raw);
  if (!t) return { fee: null, paid: null, price: null };
  return { fee: t, paid: FREE.test(t.replace(NOT_FREE, "")) ? "free" : PAID.test(t) ? "paid" : null, price: t.match(PRICE)?.[0] ?? null };
}

// Never ship private persons' data or secrets: these keys are removed from every props object.
const PRIVATE = new Set(["editor", "vorname", "name", "mobile", "ccmail", "name_verantw_person", "vorname_verantw_person",
  "CODE_DEBLOQUAGE_BOITIER", "TYPE_DEBLOQUAGE_BOITIER", "TELEPHONE_CONTACT", "TELEPHONE_ENTREPRISE", "telefon_aed"]);
function trim(p: Props, keepName = false) {
  const o: Props = {};
  for (const [k, v] of Object.entries(p)) {
    if ((PRIVATE.has(k) && !(keepName && k === "name")) || blank(v) || ["geo_shape", "geometry", "geo_point_2d", "geopos", "gx_media_links"].includes(k)) continue;
    o[k] = typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}…` : v;
  }
  return o;
}

const YN: Record<string, Wheelchair> = { yes: "yes", limited: "limited", no: "no" };
let dropped = 0;
function item(source: string, nativeId: string | number, lat: number | undefined, lon: number | undefined, f: ItemFields): OfficialItem | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inCH(lat!, lon!)) { dropped++; return null; }
  const { fee, paid, price } = f.category === "toilets" || f.category === "shower" ? feeOf(f.fee) : { fee: clean(f.fee), paid: null, price: null };
  const pc = plzOrt(f.address);
  return {
    id: `${source}/${nativeId}`, source, category: f.category, lat: +lat!.toFixed(6), lon: +lon!.toFixed(6),
    name: clean(f.name), address: clean(f.address), postcode: f.postcode != null ? String(f.postcode) : pc.postcode ?? null,
    city: clean(f.city) ?? pc.city ?? null, canton: f.canton ?? null, opening_hours: clean(f.opening_hours),
    fee, paid, price, wheelchair: YN[f.wheelchair!] ?? null, phone: clean(f.phone), website: web(f.website), props: f.props,
  };
}

// ---------- zip / GeoPackage ----------
// Minimal zip reader (deflate/store, zip64 sizes via the 0x0001 extra field): entry whose name passes `want`.
function unzip(buf: Buffer, want: (name: string) => boolean) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (want(name)) {
      let size = buf.readUInt32LE(p + 20), lh = buf.readUInt32LE(p + 42);
      const usize = buf.readUInt32LE(p + 24), method = buf.readUInt16LE(p + 10);
      for (let x = p + 46 + nameLen; x < p + 46 + nameLen + extraLen; x += 4 + buf.readUInt16LE(x + 2)) {
        if (buf.readUInt16LE(x) !== 1) continue;
        let o = x + 4;
        if (usize === 0xffffffff) o += 8;
        if (size === 0xffffffff) { size = Number(buf.readBigUInt64LE(o)); o += 8; }
        if (lh === 0xffffffff) lh = Number(buf.readBigUInt64LE(o));
      }
      const data = buf.subarray(lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28)).subarray(0, size);
      return method === 8 ? inflateRawSync(data) : data;
    }
    p += 46 + nameLen + extraLen + buf.readUInt16LE(p + 32);
  }
  throw new Error("wanted entry not in zip");
}
// GPKG blob: 'GP' header (+ optional envelope) then WKB. Points -> x,y; anything else -> envelope centre.
function gpkgXY(b: Buffer) {
  const envType = (b[3] >> 1) & 7, o = 8 + [0, 32, 48, 48, 64][envType], le = b[o] === 1;
  const type = le ? b.readUInt32LE(o + 1) : b.readUInt32BE(o + 1);
  if (type % 1000 === 1) return le ? [b.readDoubleLE(o + 5), b.readDoubleLE(o + 13)] : [b.readDoubleBE(o + 5), b.readDoubleBE(o + 13)];
  assert(envType >= 1, `non-point geometry (WKB ${type}) without envelope`);
  const d = (i: number) => (b[3] & 1 ? b.readDoubleLE(8 + 8 * i) : b.readDoubleBE(8 + 8 * i));
  return [(d(0) + d(1)) / 2, (d(2) + d(3)) / 2];
}
// rows of one GPKG table as { lat, lon, lv95, props } (all our GPKGs are LV95 / EPSG:2056)
interface GpkgRow<P> { lat: number; lon: number; lv95: LV95; props: P }
async function gpkgRows<P extends Props>(url: string, table: string) {
  const dir = mkdtempSync(join(tmpdir(), "ch-gpkg-")), file = join(dir, "x.gpkg");
  try {
    writeFileSync(file, unzip(await get(url, "buf"), (n) => n.endsWith(".gpkg")));
    const db = new DatabaseSync(file, { readOnly: true });
    const { column_name: col, srs_id } = db.prepare("select column_name, srs_id from gpkg_geometry_columns where table_name = ?").get(table) as { column_name: string; srs_id: number };
    assert.equal(srs_id, 2056, `${table}: unexpected SRS ${srs_id}`);
    const rows = db.prepare(`select * from "${table}"`).all().map(({ [col]: g, ...props }): GpkgRow<P> => {
      const [e, n] = gpkgXY(Buffer.from(g as Uint8Array)), [lon, lat] = lv95ToWgs(e, n);
      return { lat, lon, lv95: [+e.toFixed(1), +n.toFixed(1)], props: { ...props } as P };
    });
    db.close();
    return rows;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------- 1. ATLAS station toilets (data/raw, see tools/fetch-raw.sh) ----------
type CsvRow = Record<string, string>;
type LvCheck = [lat: number, lon: number, e: number, n: number];
function readCsv(file: string): CsvRow[] {
  const [head, ...lines] = readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  const cols = head.split(";");
  return lines.map((l) => { const v = l.split(";"); return Object.fromEntries(cols.map((c, i) => [c, v[i] ?? ""])); });
}
const validToday = (r: CsvRow) => r.validFrom <= TODAY && r.validTo >= TODAY;
const lvCheck: LvCheck[] = []; // [lat, lon, E, N] published by ATLAS in both systems: checks our LV95 formula
async function atlas() {
  const sp = new Map(readCsv("data/raw/service-point.csv").filter(validToday).map((r) => [r.sloid, r]));
  for (const p of [...sp.values()].filter((p) => p.isoCountryCode === "CH" && p.lv95East).slice(0, 2000))
    lvCheck.push([+p.wgs84North, +p.wgs84East, +p.lv95East, +p.lv95North]);
  const WC: Record<string, Wheelchair> = { YES: "yes", NO: "no", PARTIALLY: "limited" }; // NOT_APPLICABLE -> null
  const items = readCsv("data/raw/actual-date-toilet.csv").filter(validToday)
    .filter((r) => !/keine? (toilette|wc)/i.test(r.additionalInformation)) // "Keine Toiletten verfügbar" rows are not toilets
    .map((r) => {
      const p = sp.get(r.parentSloidServicePoint);
      if (!p) return null;
      return item("atlas.toilet", r.sloid, +p.wgs84North, +p.wgs84East, {
        category: "toilets", name: `${p.designationOfficial} – ${r.designation}`, city: pick(p.localityName, p.municipalityName),
        canton: pick(p.cantonAbbreviation), wheelchair: WC[r.wheelchairToilet],
        props: trim({ ...r, operator: p.businessOrganisationDescriptionDe, position_note: "station centre, ATLAS has no toilet coordinates" }),
      });
    });
  return { key: "atlas.toilet", name: "ATLAS toilets (BAV/SBB) joined to ATLAS service points, valid today", url: "https://opentransportdata.swiss/de/dataset/toilet-v2", licence: "opentransportdata.swiss terms of use (free, attribution)", items };
}

// ---------- 2. Stadt Zürich WFS (GeoJSON, WGS84) ----------
interface PointGeometry { type: "Point"; coordinates: [x: number, y: number] }
interface PointFeature<P> { geometry: PointGeometry; properties: P }
interface FeatureCollection<P> { features: PointFeature<P>[] }
// Zürich's WFS and Geneva's SITG also send features without geometry: those are dropped first.
interface LooseFeatureCollection<P> { features: (PointFeature<P> | { geometry: null; properties: P })[] }
// The columns the Zürich POI layers share, and those of the WC and fountain layers.
interface ZhPoi extends Props {
  poi_id?: string;
  objectid: number;
  name: string | null;
  namenzus: string | null;
  adresse: string | null;
  plz: string | null;
  ort: string | null;
  tel: string | null;
  www: string | null;
  kategorie: string;
  bemerkung: string | null;
  hindernisfreiheit: string | null; // "1_..." = barrier-free
}
interface ZhWc extends ZhPoi { poi_id: string; oeffnungsz: string | null; gebuehren: string | null }
interface ZhBrunnen extends Props {
  objectid: number;
  art: string; // "privat" | ...
  wasserart: string;
  brunnennummer: string;
  standort: string | null;
  ortsbezeichnung: string | null;
  abgestellt: string; // "ja" | "nein"
  grund_abstellung: string | null;
}
const zhWfs = async <P extends Props>(svc: string, layer: string) => (await get<LooseFeatureCollection<P>>(`https://www.ogd.stadt-zuerich.ch/wfs/geoportal/${svc}?service=WFS&version=1.1.0&request=GetFeature&outputFormat=GeoJSON&srsName=EPSG:4326&typename=${layer}`)).features.filter((f) => f.geometry) as PointFeature<P>[];
const zhPoi = (p: ZhPoi) => ({ name: join_(" – ", p.name, p.namenzus), address: p.adresse, postcode: p.plz, city: p.ort ?? "Zürich", canton: "ZH", phone: p.tel, website: p.www });
async function zhWc() {
  const layers = ["poi_zueriwc_view", "poi_zueriwc_rs_view", "poi_zueriwc_mobil_view", "poi_zueriwc_mobil_rs_view"];
  const items = (await Promise.all(layers.map((l) => zhWfs<ZhWc>("Zueri_WC", l)))).flat().map(({ geometry: g, properties: p }) => item("zh.zueriwc", p.poi_id, g.coordinates[1], g.coordinates[0], {
    ...zhPoi(p), category: "toilets", opening_hours: pick(p.oeffnungsz, p.bemerkung), fee: pick(p.gebuehren, /gebühr|kostenlos|fr\.\s*\d/i.test(p.bemerkung ?? "") ? p.bemerkung : null),
    // the category says "rollstuhlgängig" even when the remark says access is difficult ("Zufahrt erschwert")
    wheelchair: /nicht rollstuhlgängig/.test(p.kategorie) ? "no" : /\(rollstuhlgängig\)/.test(p.kategorie) ? (/erschwert/i.test(p.bemerkung ?? "") ? "limited" : "yes") : null,
    props: trim(Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith("oeffnungszeiten_")))),
  }));
  return { key: "zh.zueriwc", name: "Stadt Zürich: Züri WC (fixed and mobile public toilets)", url: "https://www.ogd.stadt-zuerich.ch/wfs/geoportal/Zueri_WC", licence: TERMS_OPEN, items };
}
async function zhBrunnen() {
  const items = (await zhWfs<ZhBrunnen>("Brunnen", "wvz_brunnen")).filter((f) => f.properties.art !== "privat").map(({ geometry: g, properties: p }) => item("zh.brunnen", p.objectid, g.coordinates[1], g.coordinates[0], {
    // Züriwasser/Quellwasser = mains or spring drinking water; "eigene Versorgung"/"Grundwasser" are not guaranteed potable
    category: /Züriwasser|Quellwasser/.test(p.wasserart) ? "drinking_water" : "fountain",
    name: join_(" – ", p.standort, p.ortsbezeichnung) ?? `Brunnen ${p.brunnennummer}`, city: "Zürich", canton: "ZH",
    opening_hours: p.abgestellt === "ja" ? `abgestellt (${p.grund_abstellung ?? "?"})` : null,
    props: trim(Object.fromEntries(Object.entries(p).filter(([k]) => k !== "foto"))), // foto points to an intranet host
  }));
  return { key: "zh.brunnen", name: "Stadt Zürich Wasserversorgung: Brunnen (public, non-private fountains)", url: "https://www.ogd.stadt-zuerich.ch/wfs/geoportal/Brunnen", licence: TERMS_OPEN, items };
}
async function zhSpital(svc: string, layer: string, category: OfficialCategory) {
  const key = `zh.${svc.toLowerCase()}`;
  const items = (await zhWfs<ZhPoi>(svc, layer)).map(({ geometry: g, properties: p }) => item(key, p.poi_id ?? p.objectid, g.coordinates[1], g.coordinates[0], {
    ...zhPoi(p), category, wheelchair: /^1_/.test(p.hindernisfreiheit!) ? "yes" : null, // "1_..." = barrier-free, "0__" = no statement
    props: trim(Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith("oeffnungszeiten_")))),
  }));
  return { key, name: `Stadt Zürich: ${svc}`, url: `https://www.ogd.stadt-zuerich.ch/wfs/geoportal/${svc}`, licence: TERMS_OPEN, items };
}

// ---------- 3. Opendatasoft portals (data.bs.ch, daten.stadt.sg.ch, data.bl.ch): exports/json ----------
interface LatLon { lat: number; lon: number }
// A row of an Opendatasoft export: the point is in geo_point_2d (data.bl.ch: koordinaten).
interface OdsRow extends Props { geo_point_2d?: LatLon | null; koordinaten?: LatLon | null }
interface BsWc extends OdsRow {
  id: string;
  typ: string; // "Dusche", "rollstuhlgängig", "nicht rollstuhlgängig", "Pissoir", ...
  status: string;
  bezeichnung: string | null;
  strasse: string | null;
  plz: string | null;
  ort: string | null;
  gebuehr: string | null;
  link: string | null;
}
interface BsBrunnen extends OdsRow { name: string | null; desc: string | null; picture_link: string | null }
interface BsAed extends OdsRow {
  id: number;
  standort: string | null;
  strasse: string | null;
  hausnummer: string | null;
  plz: string | null;
  ort: string | null;
  kanton: string | null;
  verfuegbarkeit: string | null;
}
interface BsSpital extends Props { ID: number; Name: string; Adresse: string | null; Telefon: string | null; Homepage: string | null; Notfallstation: boolean | null }
interface SgPoi extends OdsRow {
  kategorie: string;
  bezeichnun: string | null;
  adresse: string | null;
  plz: string | null;
  ort: string | null;
  oeffnungsz: string | null;
  informatio: string | null;
  telefon: string | null;
}
interface SgBrunnen extends OdsRow { name: string; trinkwasse: string | null }
interface BlApotheke extends OdsRow { gln_betrieb: number; betriebsname: string; strasse: string | null; hausnummer: string | null; plz: string | null; ort: string | null }
const ods = <R extends OdsRow>(host: string, id: string) => get<R[]>(`https://${host}/api/v2/catalog/datasets/${id}/exports/json`);
const ll = (r: OdsRow): Partial<LatLon> => r.geo_point_2d ?? r.koordinaten ?? {};
async function bsWc() {
  const rows = (await ods<BsWc>("data.bs.ch", "100031")).filter((r) => r.status !== "geschlossen");
  const items = rows.map((r) => item("bs.wc", r.id, ll(r).lat, ll(r).lon, {
    category: r.typ === "Dusche" ? "shower" : "toilets", name: r.bezeichnung, address: r.strasse, postcode: r.plz, city: r.ort, canton: "BS",
    fee: r.gebuehr, wheelchair: r.typ === "rollstuhlgängig" ? "yes" : /nicht rollstuhlgängig|Pissoir/.test(r.typ) ? "no" : null,
    opening_hours: r.status === "saisonal geschlossen" ? "saisonal geschlossen" : null, website: r.link, props: trim(r),
  }));
  return { key: "bs.wc", name: "Kanton Basel-Stadt: Sanitäre Anlagen (public toilets, pissoirs, showers)", url: "https://data.bs.ch/explore/dataset/100031/", licence: CC_BY, items };
}
async function bsBrunnen() {
  const items = (await ods<BsBrunnen>("data.bs.ch", "100008")).map((r, i) => item("bs.brunnen", i + 1, ll(r).lat, ll(r).lon, {
    // shortcut: no id and no potable flag in the source (it mixes drinking fountains, decorative fountains and paddling
    // pools): ids are row numbers, so they change if rows are added; everything is "fountain".
    category: "fountain", name: r.name, address: clean(r.desc)?.replace(/\s*\(Foto[^)]*\)/, ""), city: "Basel", canton: "BS", props: trim({ name: r.name, desc: r.desc, picture_link: r.picture_link }, true),
  }));
  return { key: "bs.brunnen", name: "Kanton Basel-Stadt: Bade-, Trinkwasser- und Zierbrunnen", url: "https://data.bs.ch/explore/dataset/100008/", licence: TERMS_BY_ASK, items };
}
async function bsAed() {
  const items = (await ods<BsAed>("data.bs.ch", "100019")).map((r) => item("bs.aed", r.id, ll(r).lat, ll(r).lon, {
    category: "aed", name: r.standort, address: join_(" ", r.strasse, r.hausnummer), postcode: r.plz, city: r.ort, canton: r.kanton ?? "BS",
    opening_hours: r.verfuegbarkeit, props: trim(r),
  }));
  return { key: "bs.aed", name: "Kanton Basel-Stadt: Defibrillatoren", url: "https://data.bs.ch/explore/dataset/100019/", licence: CC_BY, items };
}
async function bsSpital() {
  const url = "https://api.geo.bs.ch/stac/v1/download/SPTL/latest/geojson";
  const fc: FeatureCollection<BsSpital> = JSON.parse(unzip(await get(url, "buf"), (n) => n.endsWith(".geojson")).toString("utf8"));
  const items = fc.features.map(({ geometry: g, properties: p }) => item("bs.spital", p.ID, g.coordinates[1], g.coordinates[0], {
    category: "hospital", name: p.Name, address: p.Adresse, canton: "BS", phone: p.Telefon, website: p.Homepage,
    props: trim({ ...p, emergency_department: p.Notfallstation }),
  }));
  return { key: "bs.spital", name: "Kanton Basel-Stadt: Spitäler (with Notfallstation flag)", url, licence: TERMS_BY, items };
}
async function sgWc() {
  const rows = (await ods<SgPoi>("daten.stadt.sg.ch", "points-of-interest-")).filter((r) => r.kategorie === "Öffentliche WC");
  const items = rows.map((r, i) => item("sg.wc", `${i + 1}`, ll(r).lat, ll(r).lon, {
    // shortcut: no id in the source, ids are row numbers within the WC category; stable only while the export order is.
    category: "toilets", name: r.bezeichnun, address: r.adresse, postcode: r.plz, city: r.ort ?? "St.Gallen", canton: "SG",
    opening_hours: r.oeffnungsz, fee: /gebühr|kosten|gratis|fr\./i.test(r.informatio ?? "") ? r.informatio : null, phone: r.telefon, props: trim(r),
  }));
  return { key: "sg.wc", name: "Stadt St.Gallen: Points of Interest, category Öffentliche WC", url: "https://daten.stadt.sg.ch/explore/dataset/points-of-interest-/", licence: CC_BY, items };
}
async function sgBrunnen() {
  const items = (await ods<SgBrunnen>("daten.stadt.sg.ch", "brunnenkataster")).map((r) => item("sg.brunnen", r.name.split(",")[0].trim(), ll(r).lat, ll(r).lon, {
    category: r.trinkwasse === "Ja" ? "drinking_water" : "fountain", name: r.name, city: "St.Gallen", canton: "SG", props: trim(r, true),
  }));
  return { key: "sg.brunnen", name: "Stadt St.Gallen: Brunnenkataster", url: "https://daten.stadt.sg.ch/explore/dataset/brunnenkataster/", licence: CC_BY, items };
}
async function blApotheken() {
  const items = (await ods<BlApotheke>("data.bl.ch", "10320")).map((r) => item("bl.apotheken", r.gln_betrieb, ll(r).lat, ll(r).lon, {
    category: "pharmacy", name: r.betriebsname, address: join_(" ", r.strasse, r.hausnummer), postcode: r.plz, city: r.ort, canton: "BL", props: trim(r),
  }));
  return { key: "bl.apotheken", name: "Kanton Basel-Landschaft: Apotheken mit Betriebsbewilligung", url: "https://data.bl.ch/explore/dataset/10320/", licence: TERMS_BY, items };
}

// ---------- 4. Geneva SITG ArcGIS REST (WGS84 via outSR) ----------
// The attributes every SITG layer has; each layer's interface (above SOURCES) names the ones its source reads.
interface SitgProps extends Props { OBJECTID: number; ID_LOM?: number }
async function sitg<P extends SitgProps>(svc: string) {
  const feats: PointFeature<P>[] = [];
  for (let off = 0; ; off += 1000) {
    const fc = await get<LooseFeatureCollection<P>>(`https://vector.sitg.ge.ch/arcgis/rest/services/${svc}/MapServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson&resultOffset=${off}&resultRecordCount=1000`);
    feats.push(...fc.features.filter((f) => f.geometry) as PointFeature<P>[]);
    if (fc.features.length < 1000) break;
  }
  return feats;
}
const SITG = <P extends SitgProps>(svc: string, key: string, name: string, licence: string, map: (p: P) => Omit<ItemFields, "props">) => ({ key, run: async () => ({
  key, name, url: `https://vector.sitg.ge.ch/arcgis/rest/services/${svc}/MapServer/0`, licence,
  items: (await sitg<P>(svc)).map(({ geometry: g, properties: p }) => item(key, p.ID_LOM ?? p.OBJECTID, g.coordinates[1], g.coordinates[0], { canton: "GE", ...map(p), props: trim(p) })),
}) });

// ---------- 5. Biel / Zug / Luzern single-file downloads ----------
interface BielBrunnen extends Props { ident: number; potable: number; remarque: string | null }
interface ZgMobiliar extends Props { id: string; kategorie: string; invnummer: number }
interface LuWc extends Props { GlobalID: string; NAME: string | null; PLZ: string | null; IN_BETRIEB: number; HINDERNISFREI: number | null }
interface LuBibliothek extends Props {
  GlobalID: string;
  NAME: string | null;
  ADRESSE: string | null;
  PLZ: string | null;
  ORT: string | null;
  TELEFON: string | null;
  WEBSITE: string | null;
}
async function bielBrunnen() {
  const url = "https://sig.biel-bienne.ch/datastore/E322_Brunnen-Fontaines/e322_brunnen.json";
  const items = (await get<{ brunnen: FeatureCollection<BielBrunnen> }>(url)).brunnen.features.map(({ geometry: g, properties: p }) => {
    const [lon, lat] = lv95ToWgs(...g.coordinates);
    return item("biel.brunnen", p.ident, lat, lon, {
      category: p.potable === 1 ? "drinking_water" : "fountain", name: p.remarque ?? `Brunnen ${p.ident}`, city: "Biel/Bienne", canton: "BE",
      props: trim({ ...p, lv95: g.coordinates.map((v) => +v.toFixed(1)) }),
    });
  });
  return { key: "biel.brunnen", name: "Stadt Biel/Bienne: Brunnen / Fontaines (potable + gourde flags)", url, licence: TERMS_OPEN, items };
}
async function zgMobiliar() {
  const url = "https://data.zg.ch/store/13/resource/105";
  const CAT: Record<string, OfficialCategory> = { "WC-Anlagen": "toilets", "Wasserzapfstellen und Brunnen": "fountain" };
  const items = (await get<FeatureCollection<ZgMobiliar>>(url)).features.filter((f) => CAT[f.properties.kategorie]).map(({ geometry: g, properties: p }) => item("zg.stadtmobiliar", p.id, g.coordinates[1], g.coordinates[0], {
    category: CAT[p.kategorie], name: `${p.kategorie === "WC-Anlagen" ? "WC-Anlage" : "Wasserzapfstelle/Brunnen"} ${p.invnummer}`, city: "Zug", canton: "ZG", props: trim(p),
  }));
  return { key: "zg.stadtmobiliar", name: "Stadt Zug: Stadtmobiliar (WC-Anlagen, Wasserzapfstellen und Brunnen)", url, licence: TERMS_BY, items };
}
async function luWc() {
  const url = "https://map.stadtluzern.ch/ogd/ogddownload/gis/toilette/toilette/toilette_gpkg.zip";
  const items = (await gpkgRows<LuWc>(url, "TOILETTE")).filter((r) => r.props.IN_BETRIEB === 1).map(({ lat, lon, lv95, props: p }) => item("lu.wc", p.GlobalID.replace(/[{}]/g, ""), lat, lon, {
    category: "toilets", name: p.NAME, postcode: p.PLZ, city: "Luzern", canton: "LU", wheelchair: p.HINDERNISFREI === 1 ? "yes" : p.HINDERNISFREI === 0 ? "no" : null,
    props: trim({ ...p, lv95 }),
  }));
  return { key: "lu.wc", name: "Stadt Luzern: WC-Anlagen (in Betrieb; incl. Nette Toilette)", url, licence: TERMS_OPEN, items };
}
async function luBibliothek() {
  const url = "https://map.stadtluzern.ch/ogd/ogddownload/gis/citymaps/citymaps_poi/citymaps_bibliothek_gpkg.zip";
  const items = (await gpkgRows<LuBibliothek>(url, "CITYMAPS_BIBLIOTHEK")).map(({ lat, lon, lv95, props: p }) => item("lu.bibliothek", p.GlobalID.replace(/[{}]/g, ""), lat, lon, {
    category: "library", name: p.NAME, address: p.ADRESSE, postcode: p.PLZ, city: p.ORT, canton: "LU", phone: p.TELEFON, website: p.WEBSITE, props: trim({ ...p, lv95 }),
  }));
  return { key: "lu.bibliothek", name: "Stadt Luzern: Bibliotheken", url, licence: TERMS_OPEN, items };
}

// ---------- 6. Kanton Bern GPKG (whole canton) ----------
interface BeAed extends Props {
  objectid: number;
  sto_id: number | null;
  titel: string | null;
  adresse: string | null;
  plz: number | null;
  ortschaft: string | null;
  zugzeit: string | null;
  zugang: string | null;
  lat_deg: number | null; // the AED table ships WGS84 too
  long_deg: number | null;
}
interface BeSpital extends Props {
  objectid: number;
  bez_sto: string | null;
  bez_firma: string | null;
  lokalisat: string | null;
  plz: number | null;
  ortschaft: string | null;
  url: string | null;
}
const beUrl = (code: string) => `https://geofiles.be.ch/geoportal/pub/download/${code}/${code.toLowerCase()}.gpkg.zip`;
async function beAed() {
  const rows = await gpkgRows<BeAed>(beUrl("AEDSTO"), "geodb.aedsto_aedsto_vw");
  for (const r of rows.slice(0, 500)) if (r.props.lat_deg) lvCheck.push([r.props.lat_deg, r.props.long_deg!, ...r.lv95]);
  const items = rows.map(({ lat, lon, lv95, props: p }) => item("kantonbern.aed", p.sto_id ?? p.objectid, lat, lon, {
    // telefon dropped: the AED host may be a private household
    category: "aed", name: p.titel, address: p.adresse, postcode: p.plz, city: p.ortschaft, canton: "BE",
    opening_hours: join_(": ", p.zugzeit, p.zugang), props: trim({ ...p, telefon: null, lv95 }),
  }));
  return { key: "kantonbern.aed", name: "Kanton Bern: AED-Standorte (AEDSTO), whole canton", url: beUrl("AEDSTO"), licence: TERMS_OPEN, items };
}
async function beSpital() {
  const flags = (r: BeSpital) => Object.entries({ akut: "Akutspital", geburt: "Geburtshilfe", psychklin: "Psychiatrische Klinik", rehaklin: "Rehaklinik" }).filter(([k]) => r[k] === 1).map(([, l]) => l).join(", ");
  const items = (await gpkgRows<BeSpital>(beUrl("SPITAL"), "geodb.spital_spitklin_vw")).map(({ lat, lon, lv95, props: p }) => item("kantonbern.spital", p.objectid, lat, lon, {
    category: "hospital", name: pick(p.bez_sto, p.bez_firma), address: p.lokalisat, postcode: p.plz, city: p.ortschaft, canton: "BE", website: p.url,
    props: trim({ ...p, types: flags(p), lv95 }),
  }));
  return { key: "kantonbern.spital", name: "Kanton Bern: Spitäler und Kliniken (SPITAL), whole canton", url: beUrl("SPITAL"), licence: TERMS_OPEN, items };
}

// ---------- 7. National: hospital sites (SO), BAZL helipads, BABS meeting points ----------
interface SoSpital extends Props {
  T_Id: number;
  institut: string | null;
  aname: string | null;
  strasse_hausnummer: string | null;
  plz_ortschaft: string | null; // "4500 Solothurn"
  kanton: string | null;
}
// api3.geo.admin.ch identify answer for the BAZL layer (geojson geometry in LV95), as far as it is read.
interface BazlIdentifyAnswer {
  results: { featureId: string | number; geometry: PointGeometry; properties: Props & { name: string | null; location: string | null; canton: string } }[];
}
// data.geo.admin.ch STAC collection and its items, as far as they are read.
interface StacCollection { license?: string }
interface StacItems { features: { assets: Record<string, { href: string }> }[] }
// An emergency meeting point of the BABS geojson (a Point in LV95).
interface BabsProps extends Props {
  "ntp-id": string;
  kanton: string;
  gemeinde: string;
  gebbezeichnung: string | null;
  strasse: string | null;
  nummer: string | null;
  plz: number;
  ort: string;
  linkkanton: string | null;
  linkbabs: string | null;
}
async function soSpital() {
  const url = "https://files.geo.so.ch/ch.so.gesa.leistungserbringerstandorte_erreichbarkeitsanalyse/aktuell/ch.so.gesa.leistungserbringerstandorte_erreichbarkeitsanalyse.gpkg.zip";
  const items = (await gpkgRows<SoSpital>(url, "standort")).map(({ lat, lon, lv95, props: p }) => {
    const [postcode, ...city] = (p.plz_ortschaft ?? "").split(" ");
    return item("so.spitalstandorte", p.T_Id, lat, lon, {
      category: "hospital", name: join_(" – ", p.institut, p.aname), address: p.strasse_hausnummer, postcode: /^\d{4}$/.test(postcode) ? postcode : null,
      city: city.join(" ") || null, canton: p.kanton, props: trim({ ...p, erreichbarkeit_aggregiert: null, lv95 }),
    });
  });
  return { key: "so.spitalstandorte", name: "Kanton Solothurn: Leistungserbringerstandorte Spitäler und Kliniken (all of CH, 2023)", url, licence: TERMS_OPEN, items };
}
async function bazl() {
  const ch = "2480000,1070000,2850000,1300000";
  const url = `https://api3.geo.admin.ch/rest/services/api/MapServer/identify?layers=all:ch.bazl.spitallandeplaetze&geometryType=esriGeometryEnvelope&geometry=${ch}&mapExtent=${ch}&imageDisplay=1000,1000,96&tolerance=0&sr=2056&geometryFormat=geojson&returnGeometry=true&lang=de&limit=200`;
  const res = (await get<BazlIdentifyAnswer>(url)).results;
  assert(res.length < 200, "BAZL identify hit its 200 limit: page it");
  const items = res.filter((r) => r.properties.canton !== "FL").map((r) => {
    const [lon, lat] = lv95ToWgs(...r.geometry.coordinates);
    return item("bazl.spitallandeplaetze", r.featureId, lat, lon, { category: "hospital_helipad", name: r.properties.name, city: r.properties.location, canton: r.properties.canton, props: trim(r.properties) });
  });
  return { key: "bazl.spitallandeplaetze", name: "BAZL Spitallandeplätze (hospital helipads; proxy for emergency hospitals)", url, licence: GEOADMIN_TERMS, items };
}
async function babs() {
  const coll = await get<StacCollection>("https://data.geo.admin.ch/api/stac/v0.9/collections/ch.babs.notfalltreffpunkte");
  const stac = await get<StacItems>("https://data.geo.admin.ch/api/stac/v0.9/collections/ch.babs.notfalltreffpunkte/items");
  const url = Object.values(stac.features[0].assets).find((a) => a.href.endsWith(".geojson"))!.href;
  const items = (await get<FeatureCollection<BabsProps>>(url)).features.filter((f) => !["FL", "DE"].includes(f.properties.kanton)).map(({ properties: p, geometry: g }) => {
    const [lon, lat] = lv95ToWgs(...g.coordinates);
    return item("babs.notfalltreffpunkte", p["ntp-id"], lat, lon, {
      category: "emergency_meeting_point", name: `Notfalltreffpunkt ${pick(p.gebbezeichnung, p.gemeinde)}`, address: join_(" ", p.strasse, p.nummer),
      postcode: p.plz, city: p.ort, canton: p.kanton, website: pick(p.linkkanton, p.linkbabs), props: trim(p),
    });
  });
  return { key: "babs.notfalltreffpunkte", name: "BABS Notfalltreffpunkte (emergency meeting points), all cantons", url, licence: coll.license ? `${coll.license}; ${GEOADMIN_TERMS}` : GEOADMIN_TERMS, items };
}

// ---------- 8. SBB data.sbb.ch (Opendatasoft v2.1) ----------
// A dataset's description, as far as it is read.
interface OdsDataset { metas: { default: { title: string; license?: string | null } } }
// A row of a data.sbb.ch export. Each dataset's interface (above SOURCES) names the columns its source reads.
interface SbbRow { [column: string]: unknown; geopos?: { lat: number; lon: number } | null }
// How a dataset's rows become items: the native id (repeats get "#n") and the item fields.
interface SbbMap<R> {
  id: (r: R) => string | number | null | undefined;
  f: (r: R) => Omit<ItemFields, "category" | "props">;
}
async function sbb<R extends SbbRow>(id: string, category: OfficialCategory, map: SbbMap<R>) {
  const base = `https://data.sbb.ch/api/explore/v2.1/catalog/datasets/${id}`;
  const meta = await get<OdsDataset>(base);
  const key = `sbb.${id}`, seen: Record<string, number> = {};
  const items = ((await get<R[]>(`${base}/exports/json`)).filter((r) => r.geopos) as (R & { geopos: LatLon })[]).map((r) => {
    // some SBB datasets ship geopos with lat/lon swapped; Swiss lat > lon always
    const [lat, lon] = r.geopos.lat < r.geopos.lon ? [r.geopos.lon, r.geopos.lat] : [r.geopos.lat, r.geopos.lon];
    const id = map.id(r) ?? "x", n = (seen[id] = (seen[id] ?? 0) + 1); // ids repeat (null, one sloid per station): add #n
    return item(key, n > 1 ? `${id}#${n}` : id, lat, lon, { category, ...map.f(r), props: trim(r) });
  });
  return { key, name: `SBB data.sbb.ch: ${meta.metas.default.title}`, url: `${base}/exports/json`, licence: meta.metas.default.license ?? "https://data.sbb.ch/page/licence", items };
}

// The attributes each Geneva layer's source reads.
interface GeWc extends SitgProps { INTITULE: string | null; ADRESSE: string | null; REMARQUES: string | null; OUVERTURE: string | null; USAGER: string | null }
interface GeAed extends SitgProps { TYPE_DE_LIEU: string | null; POSITION: string | null; ADRESSE: string | null; H24: string | null; HORAIRE: string | null }
interface GeHopital extends SitgProps { NOM_ETABLISSEMENT: string | null; ADRESSE: string | null; TELEPHONE: string | null; SITE_WEB: string | null }
interface GePharmacie extends SitgProps { NOM_SITE: string | null; ADRESSE: string | null; CONTACT: string | null }
interface GePoste extends SitgProps { DESCRIPTION1: string | null; NO_POSTAL: number | null; NOM: string | null; LIEN_WWW: string | null }
// The columns each SBB dataset's source reads.
interface WifiRow extends SbbRow { bpuic: number; standort: string }
interface TicketMachineRow extends SbbRow { id_automat: string | null; bps_name: string }
interface WaitingRoomRow extends SbbRow {
  globalid: string | null;
  sloid: string | null;
  gebaudename: string | null;
  bezeichnung_offiziell: string | null;
  strasse: string | null;
  plz: string | null;
  ort: string | null;
}
/** Object.groupBy (ES2024, in Node since 21), which this project's "es2023" lib does not declare. Every key that occurs has a list. */
type ObjectWithGroupBy = ObjectConstructor & { groupBy<K extends PropertyKey, T>(items: Iterable<T>, keyOf: (item: T, index: number) => K): Record<K, T[]> };

const SOURCES: { key: string; run: () => Promise<SourceResult> }[] = [
  { key: "atlas.toilet", run: atlas },
  { key: "zh.zueriwc", run: zhWc },
  { key: "bs.wc", run: bsWc },
  SITG("VDG_WC_PUBLIC", "ge.wc", "Ville de Genève: WC publics (SITG)", TERMS_OPEN, (p: GeWc) => ({
    category: "toilets", name: p.INTITULE, address: p.ADRESSE, city: "Genève", fee: /gratuit|payant/i.test(p.REMARQUES ?? "") ? p.REMARQUES : null,
    opening_hours: join_("; ", p.OUVERTURE, /ouvert|h\b|\dh/i.test(p.REMARQUES ?? "") ? p.REMARQUES : null),
    wheelchair: /Handicap/.test(p.USAGER ?? "") ? "yes" : p.USAGER ? "no" : null, // USAGER lists "Handicapés" when there is a PMR WC
  })),
  { key: "lu.wc", run: luWc },
  { key: "sg.wc", run: sgWc },
  { key: "zg.stadtmobiliar", run: zgMobiliar },
  { key: "zh.brunnen", run: zhBrunnen },
  { key: "bs.brunnen", run: bsBrunnen },
  { key: "sg.brunnen", run: sgBrunnen },
  { key: "biel.brunnen", run: bielBrunnen },
  { key: "kantonbern.aed", run: beAed },
  { key: "bs.aed", run: bsAed },
  SITG("DEAS_144_DEFIBRILLATEURS", "ge.aed", "Canton de Genève: Défibrillateurs en libre accès (SITG)", TERMS_OPEN, (p: GeAed) => ({
    category: "aed", name: join_(" – ", p.TYPE_DE_LIEU, p.POSITION), address: p.ADRESSE,
    opening_hours: p.H24 === "OUI" ? "24/7" : p.HORAIRE, // unlock codes / contact phones are dropped in trim()
  })),
  { key: "so.spitalstandorte", run: soSpital },
  { key: "bazl.spitallandeplaetze", run: bazl },
  { key: "kantonbern.spital", run: beSpital },
  { key: "zh.spital", run: () => zhSpital("Spital", "poi_spital_view", "hospital") },
  { key: "zh.spitalnotaufnahme", run: () => zhSpital("Spitalnotaufnahme", "poi_spitalnotaufnahmen_view", "emergency_department") },
  { key: "bs.spital", run: bsSpital },
  SITG("DAS_HOPITAUX_CLINIQUES", "ge.hopitaux", "Canton de Genève: Hôpitaux et cliniques (SITG)", TERMS_OPEN, (p: GeHopital) => ({
    category: "hospital", name: p.NOM_ETABLISSEMENT, address: p.ADRESSE, phone: p.TELEPHONE, website: p.SITE_WEB,
  })),
  { key: "babs.notfalltreffpunkte", run: babs },
  { key: "sbb.wifistation", run: () => sbb("wifistation", "wifi", { id: (r: WifiRow) => r.bpuic, f: (r) => ({ name: `SBB Wifi@Station ${r.standort}` }) }) },
  { key: "sbb.billetautomat", run: () => sbb("billetautomat", "ticket_machine", { id: (r: TicketMachineRow) => r.id_automat, f: (r) => ({ name: `Billetautomat ${r.bps_name}` }) }) },
  { key: "sbb.haltestelle-wartehallen", run: () => sbb("haltestelle-wartehallen", "waiting_room", { id: (r: WaitingRoomRow) => r.globalid ?? r.sloid, f: (r) => ({
    name: join_(" ", r.gebaudename, r.bezeichnung_offiziell), address: r.strasse, postcode: r.plz, city: r.ort }) }) },
  { key: "bl.apotheken", run: blApotheken },
  SITG("GEO_SANTE_VACCINATION_PHARM", "ge.pharmacies", "Canton de Genève: Lieux de vaccination (pharmacies) (SITG)", TERMS_OPEN, (p: GePharmacie) => ({
    category: "pharmacy", name: p.NOM_SITE, address: p.ADRESSE, phone: p.CONTACT?.replace(/^Tel\s*:\s*/i, ""),
  })),
  SITG("GEO_POSTE_PT", "ge.poste", "Canton de Genève: Offices postaux (SITG)", TERMS_OPEN, (p: GePoste) => ({
    category: "post_office", name: p.DESCRIPTION1, postcode: p.NO_POSTAL, city: p.NOM, website: p.LIEN_WWW,
  })),
  { key: "lu.bibliothek", run: luBibliothek },
];

// ---------- self-checks of the pure helpers ----------
assert.deepEqual(feeOf("Gebührenfrei"), { fee: "Gebührenfrei", paid: "free", price: null });
assert.deepEqual(feeOf("Rollstuhlgängiges-WC Fr. 1.--, Eurokey oder Kreditkartenzahlung möglich, Multifunktions-WC kostenlos benutzbar"),
  { fee: "Rollstuhlgängiges-WC Fr. 1.--, Eurokey oder Kreditkartenzahlung möglich, Multifunktions-WC kostenlos benutzbar", paid: "free", price: "Fr. 1.--" });
assert.equal(feeOf("Fr. 1.-, Eurokey Gratis").paid, "paid");
assert.equal(feeOf("Gebühr Fr. 1.--. Pissoir gratis.").paid, "paid");
assert.deepEqual(feeOf("Behinderten- und Familienmodul 1 Franken"), { fee: "Behinderten- und Familienmodul 1 Franken", paid: "paid", price: "1 Franken" });
assert.equal(feeOf("kostenpflichtig").paid, "paid");
assert.equal(feeOf("Gratuit de 8h à 20h, payant de 20h à 8h").paid, "free");
assert.equal(feeOf("CHF 0.50").price, "CHF 0.50");
assert.equal(feeOf(null).paid, null);
assert.deepEqual(plzOrt("26 route de chêne 1207 genève"), { postcode: "1207", city: "genève" });

const sources: SourceRecord[] = [], items: OfficialItem[] = [];
for (const s of SOURCES) {
  try {
    const r = await s.run();
    const ok = r.items.filter(Boolean) as OfficialItem[];
    sources.push({ key: r.key, name: r.name, url: r.url, licence: r.licence, count: ok.length, fetched_ok: true });
    items.push(...ok);
    console.log(`${r.key}: ${ok.length}`);
  } catch (e) {
    sources.push({ key: s.key, name: s.key, url: null, licence: null, count: 0, fetched_ok: false, error: (e as Error).message });
    console.error(`FAILED ${s.key}: ${(e as Error).message}`);
  }
}

// ---------- self-check on the output ----------
assert.equal(new Set(items.map((i) => i.id)).size, items.length, "ids unique");
for (const i of items) assert(inCH(i.lat, i.lon), `bad coords ${i.id}`);
for (const i of items) assert(i.paid === null || ((i.category === "toilets" || i.category === "shower") && ["free", "paid"].includes(i.paid)), `paid ${i.id}`);
const worst = lvCheck.length ? Math.max(...lvCheck.map(([lat, lon, e, n]) => { const [lo, la] = lv95ToWgs(e, n); return metres(lat, lon, la, lo); })) : Infinity;
assert(lvCheck.length > 100 && worst < 5, `LV95 check: ${lvCheck.length} pts, worst ${worst} m`);
const bernNtp = items.find((i) => i.source === "babs.notfalltreffpunkte" && i.city === "Bern");
if (bernNtp) assert(metres(bernNtp.lat, bernNtp.lon, 46.95, 7.44) < 8000, "BABS Bern position");

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), sources, items }));
const mb = statSync(OUT).size / 1e6;
assert(mb < 40, `${OUT} is ${mb.toFixed(1)} MB: split per category`);
const by = (f: (i: OfficialItem) => string) => Object.entries((Object as ObjectWithGroupBy).groupBy(items, f)).map(([k, v]) => `${k} ${v.length}`).join(", ");
console.log(`categories: ${by((i) => i.category)}`);
for (const [src, v] of Object.entries((Object as ObjectWithGroupBy).groupBy(items.filter((i) => i.category === "toilets" || i.category === "shower"), (i) => i.source)))
  console.log(`paid ${src}: free ${v.filter((i) => i.paid === "free").length}, paid ${v.filter((i) => i.paid === "paid").length}, unknown ${v.filter((i) => i.paid == null).length}`);
console.log(`wrote ${OUT}: ${items.length} items (${mb.toFixed(2)} MB) from ${sources.filter((s) => s.fetched_ok).length}/${sources.length} sources; dropped outside CH ${dropped}; LV95 check ${lvCheck.length} pts, worst ${worst.toFixed(2)} m`);
