// Usage: node tools/build-services.mjs [data/services.json]
// Official service locations for newcomers/refugees in canton Bern: Kanton Bern GPKG downloads (geofiles.be.ch),
// BABS emergency meeting points and SEM federal asylum centres (geo.admin.ch). See docs/data-services.md.
// A failed source is recorded in `sources` (fetched_ok:false) and the build continues.
// Helpers copied from tools/build-official-places.mjs (importing it runs its build).
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";

const OUT = process.argv[2] ?? "data/services.json";
const [S, W, N, E] = [46.9, 7.34, 46.99, 7.5];
const inBbox = (lat, lon) => lat >= S && lat <= N && lon >= W && lon <= E;
const TERMS_OPEN = "opendata.swiss terms_open (https://opendata.swiss/terms-of-use#terms_open)";
const GEOADMIN_TERMS = "geo.admin.ch federal geodata, free use with source attribution (https://www.geo.admin.ch/en/general-terms-of-use-fsdi)";

async function get(url, as = "json") {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (bern-access-hackathon)" }, signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (as === "buf") return Buffer.from(await res.arrayBuffer());
      const j = await res.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j;
    } catch (e) {
      if (attempt === 3) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

// swisstopo approximate LV03 -> WGS84 (~1 m).
function lv03ToWgs(y, x) {
  const Y = (y - 600000) / 1e6, X = (x - 200000) / 1e6;
  const lon = 2.6779094 + 4.728982 * Y + 0.791484 * Y * X + 0.1306 * Y * X * X - 0.0436 * Y ** 3;
  const lat = 16.9023892 + 3.238272 * X - 0.270978 * Y * Y - 0.002528 * X * X - 0.0447 * Y * Y * X - 0.014 * X ** 3;
  return [(lon * 100) / 36, (lat * 100) / 36];
}
const lv95ToWgs = (e, n) => lv03ToWgs(e - 2000000, n - 1000000); // [lon, lat]
const metres = (lat1, lon1, lat2, lon2) => Math.hypot((lat1 - lat2) * 111320, (lon1 - lon2) * 111320 * Math.cos((lat1 * Math.PI) / 180));

const blank = (v) => v == null || (typeof v === "string" && ["", "-"].includes(v.trim()));
const pick = (...vs) => vs.find((v) => !blank(v)) ?? null;
const clean = (v) => (blank(v) ? null : String(v).replace(/\s+/g, " ").trim());
const join_ = (sep, ...vs) => vs.filter((v) => !blank(v)).join(sep) || null;
const web = (u) => (blank(u) ? null : /^https?:/.test(u) ? u : `https://${u.trim()}`);
const plzOrt = (s) => { const m = clean(s)?.match(/^(\d{4})\s+(.*)$/); return m ? [m[1], m[2]] : [null, clean(s)]; };

function item(source, nativeId, lat, lon, f) {
  return {
    id: `${source}/${nativeId}`, source, category: f.category, name: clean(f.name), address: clean(f.address),
    postcode: f.postcode == null ? null : String(f.postcode), city: clean(f.city), lat: +lat.toFixed(7), lon: +lon.toFixed(7),
    phone: clean(f.phone), email: clean(f.email), website: web(f.website), opening_hours: f.opening_hours ?? null,
    languages: f.languages ?? null, description: clean(f.description), in_bern_bbox: inBbox(lat, lon), props: f.props,
  };
}

// ---------- Kanton Bern GPKG downloads (geofiles.be.ch) ----------
function unzip(buf, wanted) {
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
// GPKG blob: 'GP' header (+ optional envelope) then WKB. Points -> x,y; anything else -> envelope [minx,maxx,miny,maxy].
function gpkgGeom(b) {
  const envType = (b[3] >> 1) & 7, o = 8 + [0, 32, 48, 48, 64][envType], le = b[o] === 1;
  const type = le ? b.readUInt32LE(o + 1) : b.readUInt32BE(o + 1);
  if (type % 1000 === 1) return { point: le ? [b.readDoubleLE(o + 5), b.readDoubleLE(o + 13)] : [b.readDoubleBE(o + 5), b.readDoubleBE(o + 13)] };
  assert(envType >= 1, `non-point geometry (WKB ${type}) without envelope`);
  const d = (i) => (b[3] & 1 ? b.readDoubleLE(8 + 8 * i) : b.readDoubleBE(8 + 8 * i));
  return { envelope: [d(0), d(1), d(2), d(3)] };
}
const gpkgCache = new Map();
function gpkgRows(code, table) {
  if (!gpkgCache.has(code)) gpkgCache.set(code, (async () => {
    const url = `https://geofiles.be.ch/geoportal/pub/download/${code}/${code.toLowerCase()}.gpkg.zip`;
    const dir = mkdtempSync(join(tmpdir(), "be-gpkg-")), file = join(dir, `${code}.gpkg`);
    writeFileSync(file, unzip(await get(url, "buf"), `${code}.gpkg`));
    return { url, dir, file };
  })());
  return gpkgCache.get(code).then(({ url, file }) => {
    const db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare(`select * from "geodb.${table}"`).all().map(({ geometry, ...props }) => ({ ...gpkgGeom(Buffer.from(geometry)), props: { ...props } }));
    db.close();
    return { url, rows };
  });
}

// Region tables (polygons) only carry the office address as text: geocode it with the geo.admin.ch address search.
const lvCheck = []; // [lat, lon, E, N] from the geocoder, which returns both WGS84 and LV95
const geoCache = new Map();
// d = SearchServer "detail" ("poststrasse 25 3072 ostermundigen 363 ostermundigen ch be"). Accept only canton BE hits with
// our postcode plus the same house number or street word, or (Postfach postcodes: 3071 Ostermundigen, 2501 Biel, 3602 Thun)
// the same house number (8D -> 8) in the same town.
function addrMatch(d, plz, town, num, word) {
  const sameNum = !!num && d.match(/ (\d+)\w* \d{4} /)?.[1] === num, sameWord = !!word && d.includes(word);
  return / ch be$/.test(d) && ((d.includes(` ${plz} `) && (sameNum || sameWord)) || (sameNum && d.includes(town)));
}
assert(addrMatch("poststrasse 25 3072 ostermundigen 363 ostermundigen ch be", 3071, "ostermundigen", "25", "poststrasse"));
assert(addrMatch("chemin du coin / eckweg 8 2504 biel/bienne 371 biel/bienne ch be", 2501, "biel", "8", "eckweg"));
assert(addrMatch("amthausgasse 1 3714 frutigen 563 frutigen ch be", 3714, "frutigen", undefined, "amthaus"));
assert(!addrMatch("scheibenstrasse 15 3600 thun 942 thun ch be", 3602, "thun", "5", "scheibenstrasse"));
assert(!addrMatch("route de la scheulte 13 2827 mervelier 6716 mervelier ch ju", 2827, "la", "13", "schulhaus"));
assert(!addrMatch("dammstrasse # 2575 hagneck 736 hagneck ch be", 2575, "hagneck", undefined, ""));
async function geocode(street, plz, ort) {
  // "Amthaus, Stadtplatz 33" / "Schloss 5, Postfach 637" -> the part with a house number, without Postfach
  // "Mühlebrücke 5 / Pont-du-Moulin 5" (bilingual) -> first language
  const parts = String(street ?? "").split(/[,\n]| \/ /).map((s) => s.trim()).filter((s) => s && !/^Postfach/i.test(s));
  const line = parts.find((s) => /\d/.test(s)) ?? parts[0] ?? "";
  const town = String(ort ?? "").replace(/\s+\d+$/, "").split(/[\s/]/)[0].toLowerCase(), num = line.match(/\d+/)?.[0];
  const word = line.split(" ")[0].toLowerCase(), ok = (d) => addrMatch(d, plz, town, num, word); // retry below drops the postcode
  const key = `${line}|${plz}|${ort}`;
  if (!geoCache.has(key)) geoCache.set(key, (async () => {
    for (const q of [`${line} ${plz} ${ort}`, `${line} ${town}`]) {
      const j = await get(`https://api3.geo.admin.ch/rest/services/api/SearchServer?type=locations&origins=address&limit=5&sr=2056&searchText=${encodeURIComponent(q.replace(/\s+/g, " ").trim())}`);
      const hit = j.results.find((r) => ok(r.attrs.detail));
      if (!hit) continue;
      lvCheck.push([hit.attrs.lat, hit.attrs.lon, hit.attrs.y, hit.attrs.x]);
      return { lat: hit.attrs.lat, lon: hit.attrs.lon, matched: hit.attrs.label.replace(/<\/?b>/g, ""), query: q };
    }
    return null;
  })());
  return geoCache.get(key);
}
async function pool(xs, n, fn) {
  const out = new Array(xs.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < xs.length) { const k = i++; out[k] = await fn(xs[k]); } }));
  return out;
}

// One source per GPKG table. map(props) -> item fields (+ street/postcode/city used for geocoding region tables).
async function canton(code, table, name, map, keep = () => true) {
  const { url, rows } = await gpkgRows(code, table);
  const key = `kantonbern.${table.replace(/_vw$/, "")}`;
  const notes = [];
  const items = (await pool(rows.filter((r) => keep(r.props)), 8, async ({ point, envelope, props }) => {
    const f = map(props);
    let lat, lon, extra = {};
    if (point) {
      [lon, lat] = lv95ToWgs(...point);
      extra.lv95 = point;
    } else if (f.locate === "envelope_centre") {
      [lon, lat] = lv95ToWgs((envelope[0] + envelope[1]) / 2, (envelope[2] + envelope[3]) / 2);
      extra = { point_is: "centre of the service-area bounding box (no office address in source)", region_bbox_lv95: envelope };
    } else {
      const g = await geocode(f.address, f.postcode, f.city);
      if (!g) { notes.push(`${f.name}: address not geocoded`); return null; }
      ({ lat, lon } = g);
      extra = { point_is: "geocoded office address", geocode: g, region_bbox_lv95: envelope };
    }
    const { locate, props: p = props, ...rest } = f;
    return item(key, props.objectid, lat, lon, { ...rest, props: { ...p, ...extra } });
  })).filter(Boolean);
  return { key, name, url, licence: `${TERMS_OPEN}; terms_of_use_de.pdf inside the zip`, items, note: notes.join("; ") || undefined };
}
const po = (r, k = "plz_ort") => { const [postcode, city] = plzOrt(r[k]); return { postcode, city }; };

// ---------- BABS Notfalltreffpunkte (STAC geojson, LV95) ----------
async function babs() {
  const coll = await get("https://data.geo.admin.ch/api/stac/v0.9/collections/ch.babs.notfalltreffpunkte");
  const stac = await get("https://data.geo.admin.ch/api/stac/v0.9/collections/ch.babs.notfalltreffpunkte/items");
  const url = Object.values(stac.features[0].assets).find((a) => a.href.endsWith(".geojson")).href;
  const fc = await get(url);
  const items = fc.features.filter((f) => f.properties.kanton === "BE").map(({ properties: p, geometry: g }) => {
    const [lon, lat] = lv95ToWgs(...g.coordinates);
    return item("babs.notfalltreffpunkte", p["ntp-id"], lat, lon, {
      category: "emergency_meeting_point", name: `Notfalltreffpunkt ${join_(" ", p.gebbezeichnung) ?? p.gemeinde}`,
      address: join_(" ", p.strasse, p.nummer), postcode: p.plz, city: p.ort, website: pick(p.linkkanton, p.linkbabs),
      description: join_("; ", "Emergency meeting point: where to go for help and information in a disaster or a long power/phone outage", p.bemerkungen),
      props: { ...p, lv95: g.coordinates },
    });
  });
  return { key: "babs.notfalltreffpunkte", name: "BABS Notfalltreffpunkte (emergency meeting points), canton BE", url, licence: coll.license ? `${coll.license}; ${GEOADMIN_TERMS}` : GEOADMIN_TERMS, items };
}

// ---------- SEM Sachplan Asyl (federal asylum centres) via api3.geo.admin.ch identify ----------
async function sem() {
  const layer = "ch.sem.sachplan-asyl_kraft", ch = "2480000,1070000,2850000,1300000";
  const url = `https://api3.geo.admin.ch/rest/services/api/MapServer/identify?layers=all:${layer}&geometryType=esriGeometryEnvelope&geometry=${ch}&mapExtent=${ch}&imageDisplay=1000,1000,96&tolerance=0&sr=2056&geometryFormat=geojson&returnGeometry=true&lang=de&limit=200`;
  const feats = (await get(url)).results.filter((r) => r.geometry?.type === "Point" && r.properties.facname_de);
  const items = (await pool(feats, 4, async (r) => {
    const [e, n] = r.geometry.coordinates;
    const kt = (await get(`https://api3.geo.admin.ch/rest/services/api/MapServer/identify?layers=all:ch.swisstopo.swissboundaries3d-kanton-flaeche.fill&geometryType=esriGeometryPoint&geometry=${e},${n}&tolerance=0&sr=2056&returnGeometry=false`)).results[0]?.attributes.ak;
    if (kt !== "BE") return null;
    const p = r.properties, [lon, lat] = lv95ToWgs(e, n);
    return item("sem.sachplan-asyl", r.featureId, lat, lon, {
      category: "federal_asylum_centre", name: `${p.fackind_text_de} ${p.facname_de}`, city: p.facname_de,
      website: p.document_web?.split("###")[0],
      description: join_("; ", p.fackind_text_de, `Sachplan status: ${p.facstatus_text_de}`, p.description_text_de, "point is the site from the federal sectoral plan, not a visitor address"),
      props: { ...p, canton: kt, lv95: [e, n] },
    });
  })).filter(Boolean);
  return { key: "sem.sachplan-asyl", name: "SEM Sachplan Asyl (federal asylum centres), canton BE", url, licence: GEOADMIN_TERMS, items };
}

const RELIGION_PRIVATE = ["telefon", "email", "adresse_k", "plz_ort_k"];
const SOURCES = [
  { key: "babs.notfalltreffpunkte", run: babs },
  { key: "sem.sachplan-asyl", run: sem },
  { key: "kantonbern.religion_relstaet", run: () => canton("RELIGION", "religion_relstaet_vw", "Kanton Bern Religionslandkarte (RELIGION)", (r) => {
    // kontakt "privat" = contact is a private person (mobile, personal e-mail, c/o name): drop those fields everywhere.
    const priv = r.kontaktt_kontakt_de === "privat", props = { ...r };
    if (priv) for (const k of RELIGION_PRIVATE) delete props[k];
    return {
      category: "place_of_worship", name: r.name_staet, address: r.adresse, ...po(r), website: r.url,
      phone: priv ? null : r.telefon, email: priv || !/@/.test(r.email ?? "") ? null : r.email,
      description: join_("; ", r.reltrat_reltra_de, r.nkennt_nkenn_de, r.jurt_jur_de), props,
    };
  }) },
  { key: "kantonbern.kibeags_betrstd", run: () => canton("KIBEAGS", "kibeags_betrstd_vw", "Kanton Bern Betreuungsangebote im Gutscheinsystem (KIBEAGS), Kitas only", (r) => ({
    category: "childcare", name: r.name, address: r.strasse, postcode: r.plz, city: r.ort, phone: r.tel, email: r.email, website: r.url,
    description: join_("; ", r.betrartt_art_de, "accepts Betreuungsgutscheine (childcare vouchers)", r.gs_ab && `in voucher system since ${r.gs_ab.slice(0, 10)}`),
  }), (r) => r.art_code === "kita") }, // tfo (Tagesfamilienorganisation) rows can be a coordinator's home: excluded
  { key: "kantonbern.admrav_ravzp", run: () => canton("ADMRAV", "admrav_ravzp_vw", "Kanton Bern AVA/RAV offices (ADMRAV)", (r) => ({
    category: "job_centre", name: r.ravzname, address: r.adresse, ...po(r), phone: r.telefon, website: r.kontaktf,
    description: "Regional employment office (RAV) / unemployment insurance (AVA): register as job-seeker, unemployment benefits",
  })) },
  { key: "kantonbern.admbiz_bizp", run: () => canton("ADMBIZ", "admbiz_bizp_vw", "Kanton Bern Berufsberatungs- und Informationszentren (ADMBIZ)", (r) => ({
    category: "career_info_centre", name: r.bizname, address: r.adresse, ...po(r), phone: r.telefon, email: r.email?.split(/\s+/)[0],
    description: join_("; ", "Career guidance and information centre (BIZ): vocational, study and career counselling", `region ${r.regname}`, r.bemerkung && `also: ${r.bemerkung}`),
  })) },
  { key: "kantonbern.admeb_ebp", run: () => canton("ADMEB", "admeb_ebp_vw", "Kanton Bern Erziehungsberatung (ADMEB)", (r) => ({
    category: "family_counselling", name: r.ebstelle, address: r.adresse, postcode: r.plz, city: r.ort, phone: r.telefon, email: r.email, website: r.url,
    languages: /^Service psychologique/.test(r.ebstelle) ? ["fr"] : null,
    description: "Erziehungsberatung: free counselling for parents, children and adolescents (upbringing, school, development)",
  })) },
  { key: "kantonbern.admrsb_rsb", run: () => canton("ADMRSB", "admrsb_rsb_vw", "Kanton Bern Regionale Schlichtungsbehörden (ADMRSB)", (r) => ({
    category: "conciliation_office", name: join_(", ", r.rsbname, r.asname), address: r.adresse, ...po(r), phone: r.telefon, email: r.email,
    description: "Conciliation authority: first stop for rent (tenancy) and employment disputes, free or low-cost",
  })) },
  { key: "kantonbern.admbaka_bads", run: () => canton("ADMBAKA", "admbaka_bads_vw", "Kanton Bern Betreibungsämter, Dienststellen (ADMBAKA)", (r) => ({
    category: "debt_collection_office", name: join_(", ", r.bakaname, r.dsname), address: r.adresse, ...po(r), phone: r.telefon, email: r.email,
    description: "Betreibungsamt: debt collection; issues the Betreibungsregisterauszug (debt record extract) often required to rent a flat",
  })) },
  { key: "kantonbern.admbaka_kads", run: () => canton("ADMBAKA", "admbaka_kads_vw", "Kanton Bern Konkursämter, Dienststellen (ADMBAKA)", (r) => ({
    category: "bankruptcy_office", name: join_(", ", r.bakaname, r.dsname), address: r.adresse, ...po(r), phone: r.telefon, email: r.email,
    description: "Konkursamt: bankruptcy office",
  })) },
  { key: "kantonbern.admrsta_rsta", run: () => canton("ADMRSTA", "admrsta_rsta_vw", "Kanton Bern Regierungsstatthalterämter (ADMRSTA)", (r) => ({
    category: "district_office", name: `Regierungsstatthalteramt ${r.rsta_de}`, address: r.adresse, postcode: r.plz, city: r.ortschaft, website: pick(r.url_de, r.url_fr),
    description: "Regierungsstatthalteramt: cantonal district office (permits, supervision of municipalities, appeals)",
  })) },
  { key: "kantonbern.admkesb_kreis", run: () => canton("ADMKESB", "admkesb_kreis_vw", "Kanton Bern KESB Kindes- und Erwachsenenschutzbehörden (ADMKESB)", (r) => ({
    category: "child_adult_protection", name: `KESB ${r.name_de}`, address: r.strasse, postcode: r.plz, city: r.ort, email: r.mail, website: pick(r.url_de, r.url_fr),
    description: "KESB: child and adult protection authority",
  })) },
  { key: "kantonbern.nffs_sozd", run: () => canton("NFFS", "nffs_sozd_vw", "Kanton Bern Sozialdienste (NFFS service areas)", (r) => ({
    category: "social_services_area", name: `Sozialdienst ${r.sozd_bez}`, locate: "envelope_centre",
    description: join_("; ", "Social services (Sozialdienst) service area; ask your municipality for the office address", r.gemname && `municipalities: ${r.gemname}`),
  })) },
  { key: "kantonbern.admgde_gdedat", run: () => canton("ADMGDE", "admgde_gdedat_vw", "Kanton Bern Gemeindedaten: Gemeindeverwaltungen (ADMGDE)", (r) => ({
    category: "municipal_office", name: r.verwalt ?? `Gemeindeverwaltung ${r.gemname}`, address: r.strname, postcode: r.plz, city: r.ort,
    phone: r.telefon, email: r.email, website: r.url,
    description: `Municipal administration of ${r.gemname} (residents' registration / Einwohnerdienste on arrival)`,
  })) },
];
const CATEGORIES = new Set(["emergency_meeting_point", "federal_asylum_centre", "place_of_worship", "childcare", "job_centre", "career_info_centre",
  "family_counselling", "conciliation_office", "debt_collection_office", "bankruptcy_office", "district_office", "child_adult_protection",
  "social_services_area", "municipal_office"]);

const sources = [], items = [];
for (const s of SOURCES) {
  try {
    const r = await s.run();
    sources.push({ key: r.key, name: r.name, url: r.url, licence: r.licence, count: r.items.length, fetched_ok: true, ...(r.note && { note: r.note }) });
    items.push(...r.items);
    console.log(`${r.key}: ${r.items.length}${r.note ? ` (${r.note})` : ""}`);
  } catch (e) {
    sources.push({ key: s.key, name: s.key, url: null, licence: null, count: 0, fetched_ok: false, error: e.message });
    console.error(`FAILED ${s.key}: ${e.message}`);
  }
}
for (const { dir } of await Promise.all([...gpkgCache.values()].map((p) => p.catch(() => ({}))))) if (dir) rmSync(dir, { recursive: true, force: true });

// ---------- self-check ----------
assert.equal(new Set(items.map((i) => i.id)).size, items.length, "ids unique");
for (const i of items) {
  assert(Number.isFinite(i.lat) && Number.isFinite(i.lon) && i.lat > 45.8 && i.lat < 47.9 && i.lon > 5.9 && i.lon < 10.6, `bad coords ${i.id}`);
  assert(CATEGORIES.has(i.category), `unknown category ${i.category} (${i.id})`);
  assert.equal(i.in_bern_bbox, inBbox(i.lat, i.lon));
  if (i.source === "kantonbern.religion_relstaet" && i.props.kontaktt_kontakt_de === "privat") assert(!i.phone && !i.email && !("telefon" in i.props), `private contact leaked ${i.id}`);
  if (i.source === "kantonbern.kibeags_betrstd") assert.equal(i.props.art_code, "kita", `non-Kita childcare row ${i.id}`);
}
// Our LV95 formula vs the geocoder's own WGS84/LV95 pairs.
const worst = Math.max(0, ...lvCheck.map(([lat, lon, e, n]) => { const [lo, la] = lv95ToWgs(e, n); return metres(lat, lon, la, lo); }));
assert(!lvCheck.length || worst < 5, `LV95 check: ${lvCheck.length} pts, worst ${worst} m`);

writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), sources, items }));
console.log(`wrote ${OUT}: ${items.length} items (${items.filter((i) => i.in_bern_bbox).length} in Bern bbox) from ${sources.filter((s) => s.fetched_ok).length}/${sources.length} sources; LV95 check ${lvCheck.length} pts, worst ${worst.toFixed(2)} m`);
