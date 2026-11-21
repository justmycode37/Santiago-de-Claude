// Usage: node tools/build-amenities-ch.mjs [outDir=data/ch]
// Switzerland-wide basic-needs amenities from OSM (Swiss Overpass instance), one file per category: <outDir>/osm-<category>.json.
// Same query/categorize/dedupe logic as tools/build-amenities.mjs (Bern), minus non-basic categories. Data: (c) OpenStreetMap contributors, ODbL.
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import assert from "node:assert/strict";

const OUT = process.argv[2] ?? "data/ch";
const URL = "https://overpass.osm.ch/api/interpreter";
const CH = { S: 45.8, W: 5.95, N: 47.81, E: 10.5 };
// One query per canton area: the area filter drops Büsingen/Campione/Liechtenstein and gives each item its canton exactly.
const CANTONS = ["AG", "AI", "AR", "BE", "BL", "BS", "FR", "GE", "GL", "GR", "JU", "LU", "NE", "NW", "OW", "SG", "SH", "SO", "SZ", "TG", "TI", "UR", "VD", "VS", "ZG", "ZH"];
// amenity=<value> that becomes category <value> as-is
const SAME = ["shelter", "shower", "post_office", "bureau_de_change", "money_transfer", "police", "social_facility", "dentist",
  "public_bookcase", "bicycle_repair_station", "food_sharing", "give_box"];
const LOCKERS = ["locker", "lockers", "luggage_locker"];
const QUERY = (canton, nonce) => `[out:json][timeout:600];
// nonce ${nonce}
area["ISO3166-2"="CH-${canton}"][admin_level=4]->.a;
(
  nwr[amenity=toilets](area.a);
  nwr[amenity=drinking_water](area.a);
  nwr[amenity=fountain][drinking_water=yes](area.a);
  nwr[man_made=water_tap][drinking_water=yes](area.a);
  nwr[amenity~"^(pharmacy|hospital|clinic|doctors|library|atm|community_centre)$"](area.a);
  nwr[internet_access=wlan]["internet_access:fee"=no](area.a);
  nwr[shop=supermarket](area.a);
  nwr[amenity~"^(${[...SAME, ...LOCKERS, "device_charging_station"].join("|")})$"](area.a);
  nwr[amenity=parking_space][parking_space=disabled](area.a);
  nwr[amenity=parking]["capacity:disabled"](area.a);
  nwr[emergency~"^(defibrillator|phone)$"](area.a);
  nwr[leisure=playground](area.a);
  nwr[highway=elevator](area.a);
);
out center tags;`;

// Copied from the Bern build (same order, first match wins), with non-basic branches removed.
function categorize(t) {
  const a = t.amenity;
  if (a === "toilets") return "toilets";
  if (a === "drinking_water" || ((a === "fountain" || t.man_made === "water_tap") && t.drinking_water === "yes")) return "drinking_water";
  if (["pharmacy", "hospital", "clinic", "doctors", "library", "atm", "community_centre"].includes(a)) return a;
  if (t.shop === "supermarket") return "supermarket";
  if (t.internet_access === "wlan" && t["internet_access:fee"] === "no") return "wifi";
  if (t.emergency === "defibrillator") return "aed";
  if (t.emergency === "phone") return "emergency_phone";
  if (SAME.includes(a)) return a;
  if (LOCKERS.includes(a)) return "lockers";
  if (a === "device_charging_station") return "phone_charging";
  if (a === "parking_space" && t.parking_space === "disabled") return "disabled_parking";
  if (a === "parking" && t["capacity:disabled"] && !["no", "0"].includes(t["capacity:disabled"])) return "disabled_parking";
  if (t.leisure === "playground") return "playground";
  if (t.highway === "elevator") return "elevator";
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchCanton(canton) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: { "User-Agent": "bern-access-hackathon/1.0 (AI for Access demo)", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: QUERY(canton, `${Date.now()}-${attempt}`) }),
        signal: AbortSignal.timeout(660_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text(); // overload/rate-limit errors come back as HTTP 200 with an XHTML page
      if (body.startsWith("<")) throw new Error(body.match(/<strong[^>]*>Error<\/strong>:([^<]*)/)?.[1]?.trim() ?? "non-JSON response");
      const json = JSON.parse(body);
      if (!Array.isArray(json.elements)) throw new Error("no elements");
      if (json.remark) throw new Error(`remark: ${json.remark}`); // timeout/out-of-memory => partial result
      return json.elements;
    } catch (e) {
      console.error(`${canton} attempt ${attempt} failed: ${e.message}`);
      if (attempt === 6) throw e;
      await sleep(20_000 * attempt);
    }
  }
}

const metres = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180));
const ORDER = { node: 0, way: 1, relation: 2 };
const r6 = (x) => Math.round(x * 1e6) / 1e6;
// "free" / "paid" / null from fee + charge, so toilets and showers can be filtered by cost. fee wins over charge.
function paid(t) {
  const fee = t.fee?.trim().toLowerCase();
  if (fee === "no" || fee === "0") return "free";
  if (fee === "yes") return "paid";
  const n = t.charge?.match(/\d+(?:[.,]\d+)?/)?.[0];
  return n == null ? null : Number(n.replace(",", ".")) > 0 ? "paid" : "free";
}
assert.equal(paid({ fee: "no", charge: "1 CHF" }), "free");
assert.equal(paid({ fee: "yes" }), "paid");
assert.equal(paid({ charge: "0.50 CHF" }), "paid");
assert.equal(paid({ charge: "CHF 0" }), "free");
assert.equal(paid({ fee: "donation" }), null);
assert.equal(paid({}), null);

const byId = new Map(); // ways crossing a canton border come back from both cantons; first canton wins
for (const canton of CANTONS) {
  const els = await fetchCanton(canton);
  for (const el of els) if (!byId.has(`${el.type}/${el.id}`)) byId.set(`${el.type}/${el.id}`, { ...el, canton });
  console.error(`${canton}: ${els.length} elements`);
  await sleep(3000);
}

const seen = new Set(); // category + rounded point (~1 m)
const named = new Map(); // category|name -> kept points, for node+way duplicates within 15 m
const byCat = {};
for (const el of [...byId.values()].sort((a, b) => ORDER[a.type] - ORDER[b.type])) { // nodes first, so the node wins
  const t = el.tags ?? {};
  const category = categorize(t);
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (!category || lat == null || lon == null) continue;
  const k = `${category},${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (seen.has(k)) continue;
  seen.add(k);
  if (t.name) {
    const nk = `${category}|${t.name}`;
    const same = named.get(nk) ?? [];
    if (same.some((o) => metres(o, { lat, lon }) < 15)) continue;
    named.set(nk, [...same, { lat, lon }]);
  }
  (byCat[category] ??= []).push({
    id: `${el.type}/${el.id}`, lat: r6(lat), lon: r6(lon),
    name: t.name ?? null,
    address: [t["addr:street"] ?? t["addr:place"], t["addr:housenumber"]].filter(Boolean).join(" ") || null,
    postcode: t["addr:postcode"] ?? null, city: t["addr:city"] ?? null, canton: el.canton,
    opening_hours: t.opening_hours ?? null, fee: t.fee ?? null, access: t.access ?? null, wheelchair: t.wheelchair ?? null,
    toilets_wheelchair: t["toilets:wheelchair"] ?? null, changing_table: t.changing_table ?? null, unisex: t.unisex ?? null,
    operator: t.operator ?? null, phone: t.phone ?? t["contact:phone"] ?? null, website: t.website ?? t["contact:website"] ?? null,
    level: t.level ?? null, indoor: t.indoor ?? null, drinking_water: t.drinking_water ?? null, check_date: t.check_date ?? null,
    ...(category === "toilets" || category === "shower"
      ? { charge: t.charge ?? null, fee_conditional: t["fee:conditional"] ?? null, payment_coins: t["payment:coins"] ?? null, paid: paid(t) }
      : {}),
  });
}

// Self-check: a bad build fails loudly instead of shipping an empty or broken layer.
const all = Object.values(byCat).flat();
assert.equal(new Set(all.map((i) => i.id)).size, all.length, "duplicate ids");
for (const i of all) assert(i.lat >= CH.S && i.lat <= CH.N && i.lon >= CH.W && i.lon <= CH.E, `${i.id} outside Switzerland bbox`);
for (const c of ["toilets", "drinking_water", "pharmacy"]) assert(byCat[c]?.length > 0, `no ${c}`);
const bern = byCat.toilets.filter((i) => i.lat >= 46.9 && i.lat <= 46.99 && i.lon >= 7.34 && i.lon <= 7.5).length;
assert(bern > 100, `only ${bern} toilets in the Bern bbox`); // Bern build had ~165

mkdirSync(OUT, { recursive: true });
const generated = new Date().toISOString();
for (const [category, items] of Object.entries(byCat).sort()) {
  const json = JSON.stringify({ generated, source: "OpenStreetMap contributors via overpass.osm.ch", licence: "ODbL", category, count: items.length, items });
  const mb = Buffer.byteLength(json) / 1e6;
  assert(mb < 40, `${category} is ${mb} MB`);
  writeFileSync(`${OUT}/osm-${category}.json`, json);
  console.log(`${category}\t${items.length}\t${mb.toFixed(2)} MB\t${(gzipSync(json).length / 1e6).toFixed(2)} MB gz`);
}
const cost = {}; for (const i of byCat.toilets) cost[i.paid] = (cost[i.paid] ?? 0) + 1;
console.log(`total ${all.length}; toilets in Bern bbox: ${bern}; toilets paid:`, cost);
