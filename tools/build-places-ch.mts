// Usage: node tools/build-places-ch.mts [outDir=data/ch] [--cache <dir>]
// Switzerland-wide version of everything the Bern map has that data/ch/osm-<category>.json lacks: the places of
// tools/build-places.mts (restaurants, shops, hotels, culture, sport, services, health, worship) and the amenities of
// tools/build-amenities.mts that tools/build-amenities-ch.mts leaves out (benches, post boxes, banks, bike parking,
// recycling, EV charging, ticket machines, …). Same categorize() as the Bern builds (tools/osm-categories.mts).
// Writes <outDir>/osm-places-<group>.json.gz (one per places group) and <outDir>/osm-places-amenities.json.gz,
// slim records without raw tags (docs/data-ch-osm.md). --cache keeps each Overpass answer, so a run that fails
// half-way picks up where it stopped. Data: (c) OpenStreetMap contributors, ODbL.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import assert from "node:assert/strict";
import {
  AMENITY_SAME, CH_BASIC, CULTURE_AMENITY, FOOD_AMENITY, FOOD_SHOP, HEALTH_AMENITY, LEISURE, SERVICE_AMENITY, UNNAMED_OK,
  categorizeAmenity, categorizePlace, rx,
} from "./osm-categories.mts";
import type { OsmTags, PlaceGroup } from "./osm-categories.mts";

const args = process.argv.slice(2);
const cacheAt = args.indexOf("--cache");
const CACHE = cacheAt >= 0 ? args.splice(cacheAt, 2)[1] : null;
const OUT = args[0] ?? "data/ch";
const OVERPASS = "https://overpass.osm.ch/api/interpreter";
const CH = { S: 45.8, W: 5.95, N: 47.81, E: 10.5 };
const BERN = { S: 46.9, W: 7.34, N: 46.99, E: 7.5 };
// One query per canton area (the area filter drops Büsingen/Campione/Liechtenstein and gives each item its canton)
const CANTONS = ["AG", "AI", "AR", "BE", "BL", "BS", "FR", "GE", "GL", "GR", "JU", "LU", "NE", "NW", "OW", "SG", "SH", "SO", "SZ", "TG", "TI", "UR", "VD", "VS", "ZG", "ZH"];
// The amenities of the Bern build that data/ch/osm-*.json lacks (CH_BASIC): these are fetched unnamed too
const EXTRA_AMENITY = [...AMENITY_SAME.filter((a) => !CH_BASIC.has(a) && a !== "bench"), "charging_station", "changing_table"];

// Per canton, one query per group so none times out. Named only where categorize() would drop the unnamed anyway:
// every place but parking, fuel and EV charging needs a name (UNNAMED_OK).
const QUERIES: Record<string, string> = {
  food: `nwr[amenity~${rx(FOOD_AMENITY)}][name](area.a); nwr[shop~${rx(FOOD_SHOP)}][name](area.a);`,
  shops: `nwr[shop][name](area.a); nwr[amenity=marketplace][name](area.a);`,
  culture: `nwr[tourism][name](area.a); nwr[historic][name](area.a); nwr[amenity~${rx(CULTURE_AMENITY)}][name](area.a);`,
  leisure_health: `nwr[leisure~${rx(LEISURE)}][name](area.a); nwr[amenity~${rx(HEALTH_AMENITY)}][name](area.a);
  nwr[amenity=place_of_worship][name](area.a); nwr[healthcare][name](area.a);`,
  services: `nwr[amenity~${rx(SERVICE_AMENITY)}][name](area.a); nwr[amenity~"^(fuel|charging_station)$"](area.a);
  nwr[amenity=parking][~"^(name|capacity)$"~"."](area.a); nwr[amenity~"^(recycling|coworking_space|embassy)$"][name](area.a);
  nwr[office][name](area.a); nwr[craft][name](area.a);`,
  amenities: `nwr[amenity~${rx(EXTRA_AMENITY)}](area.a); nwr[amenity=vending_machine][vending~"public_transport_tickets"](area.a);
  nwr[office=diplomatic](area.a);`,
  benches: `nwr[amenity=bench](area.a);`,
};
const query = (canton: string, body: string, nonce: string) => `[out:json][timeout:600];
// nonce ${nonce}
area["ISO3166-2"="CH-${canton}"][admin_level=4]->.a;
(
  ${body}
);
out center tags;`;

/** An element of an Overpass answer (`out center tags`): a node has its own position, a way or relation its center. */
interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: OsmTags;
}
interface OverpassAnswer {
  elements: OverpassElement[];
  /** Set when the query timed out or ran out of memory: the elements are then only a part */
  remark?: string;
}
interface LatLon { lat: number; lon: number }
/**
 * A record of data/ch/osm-places-<group>.json.gz: the fields of data/places.json (docs/places-data.md) without the raw
 * tags, plus the canton. A field that is not tagged is left out (so every field but id, lat, lon, group, category,
 * canton may be missing).
 */
interface ChPlace {
  id: string;
  lat: number;
  lon: number;
  group: PlaceGroup;
  category: string;
  canton: string;
  name?: string;
  brand?: string;
  operator?: string;
  /** "Neuengasse 15, 3011 Bern" */
  address?: string;
  street?: string;
  housenumber?: string;
  postcode?: string;
  city?: string;
  phone?: string;
  email?: string;
  website?: string;
  opening_hours?: string;
  wheelchair?: string;
  wheelchair_description?: string;
  toilets_wheelchair?: string;
  cuisine?: string;
  diet?: Record<string, string>;
  outdoor_seating?: string;
  takeaway?: string;
  delivery?: string;
  payment?: Record<string, string>;
  level?: string;
  internet_access?: string;
  wikidata?: string;
  description?: string;
  check_date?: string;
}
/** A record of data/ch/osm-places-amenities.json.gz: the fields of data/amenities.json without the raw tags, plus the canton; untagged fields left out. */
interface ChAmenity {
  id: string;
  lat: number;
  lon: number;
  category: string;
  canton: string;
  name?: string;
  /** "Neuengasse 15, 3011 Bern" */
  address?: string;
  opening_hours?: string;
  fee?: string;
  access?: string;
  wheelchair?: string;
  website?: string;
  operator?: string;
  phone?: string;
  level?: string;
  description?: string;
  changing_table?: string;
  covered?: string;
  backrest?: string;
  capacity?: string;
  check_date?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function fetchQuery(canton: string, key: string): Promise<OverpassElement[]> {
  const cached = CACHE && `${CACHE}/${canton}-${key}.json.gz`;
  if (cached && existsSync(cached)) return JSON.parse(gunzipSync(readFileSync(cached)).toString()) as OverpassElement[];
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(OVERPASS, {
        method: "POST",
        headers: { "User-Agent": "bern-access-hackathon/1.0 (AI for Access demo)", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query(canton, QUERIES[key], `${Date.now()}-${attempt}`) }),
        signal: AbortSignal.timeout(660_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text(); // overload/rate-limit errors come back as HTTP 200 with an XHTML page
      if (body.startsWith("<")) throw new Error(body.match(/<strong[^>]*>Error<\/strong>:([^<]*)/)?.[1]?.trim() ?? "non-JSON response");
      const json = JSON.parse(body) as OverpassAnswer;
      if (!Array.isArray(json.elements)) throw new Error("no elements");
      if (json.remark) throw new Error(`remark: ${json.remark}`); // timeout/out-of-memory => partial result
      if (cached) { mkdirSync(CACHE!, { recursive: true }); writeFileSync(cached, gzipSync(JSON.stringify(json.elements))); }
      return json.elements;
    } catch (e) {
      console.error(`${canton} ${key} attempt ${attempt} failed: ${(e as Error).message}`);
      if (attempt === 6) throw e;
      await sleep(20_000 * attempt);
    }
  }
  throw new Error("unreachable");
}

// Two queries at a time (the Swiss instance takes that), 2 s between the starts of a worker's queries
const jobs = CANTONS.flatMap((canton) => Object.keys(QUERIES).map((key) => ({ canton, key })));
const byId = new Map<string, OverpassElement & { canton: string }>(); // ways crossing a canton border: the first canton wins
const answers = new Map<string, OverpassElement[]>();
let next = 0, done = 0;
const started = Date.now();
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const els = await fetchQuery(job.canton, job.key);
    answers.set(`${job.canton}|${job.key}`, els);
    done++;
    console.error(`[${done}/${jobs.length} ${((Date.now() - started) / 60000).toFixed(1)} min] ${job.canton} ${job.key}: ${els.length}`);
    await sleep(2000);
  }
}
await Promise.all([worker(), worker()]);
for (const { canton, key } of jobs) for (const el of answers.get(`${canton}|${key}`)!) {
  const id = `${el.type}/${el.id}`;
  const had = byId.get(id);
  if (!had) byId.set(id, { ...el, canton });
  else if (had.canton === canton && !had.tags && el.tags) had.tags = el.tags;
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const metres = (a: LatLon, b: LatLon) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180));
const ORDER = { node: 0, way: 1, relation: 2 };
const prefixed = (t: OsmTags, p: string) => {
  const o = Object.fromEntries(Object.entries(t).filter(([k]) => k.startsWith(p)).map(([k, v]) => [k.slice(p.length), v]));
  return Object.keys(o).length ? o : undefined;
};
/** The record without its untagged fields. */
const slim = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== "")) as T;

const places: (ChPlace & { tagCount: number })[] = [];
const amenitySeen = new Set<string>(); // category + rounded point (~1 m)
const amenityNamed = new Map<string, LatLon[]>(); // category|name -> kept points, for node+way duplicates within 15 m
const amenities: ChAmenity[] = [];
let outside = 0;
for (const [id, el] of [...byId].sort((a, b) => ORDER[a[1].type] - ORDER[b[1].type])) { // nodes first, so the node wins
  const t = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) continue;
  // a way along the border can have its centre outside (as the Bern build drops centres outside its box)
  if (lat < CH.S || lat > CH.N || lon < CH.W || lon > CH.E) { outside++; continue; }
  const street = t["addr:street"] ?? t["addr:place"], housenumber = t["addr:housenumber"], postcode = t["addr:postcode"], city = t["addr:city"];
  const line1 = [street, housenumber].filter(Boolean).join(" "), line2 = [postcode, city].filter(Boolean).join(" ");
  const address = [line1, line2].filter(Boolean).join(", ");
  const phone = t.phone ?? t["contact:phone"], website = t.website ?? t["contact:website"];
  // a place (tools/build-places.mts)
  const pc = categorizePlace(t);
  if (pc && (t.name || UNNAMED_OK.has(pc[1]))) {
    places.push({
      ...slim<ChPlace>({
        id, lat: r6(lat), lon: r6(lon), group: pc[0], category: pc[1], canton: el.canton,
        name: t.name, brand: t.brand, operator: t.operator, address, street, housenumber, postcode, city,
        phone: phone ?? t["contact:mobile"], email: t.email ?? t["contact:email"], website: website ?? t.url,
        opening_hours: t.opening_hours, wheelchair: t.wheelchair, wheelchair_description: t["wheelchair:description"],
        toilets_wheelchair: t["toilets:wheelchair"], cuisine: t.cuisine, diet: prefixed(t, "diet:"),
        outdoor_seating: t.outdoor_seating, takeaway: t.takeaway, delivery: t.delivery, payment: prefixed(t, "payment:"),
        level: t.level, internet_access: t.internet_access, wikidata: t.wikidata, description: t.description, check_date: t.check_date,
      }),
      tagCount: Object.keys(t).length,
    });
  }
  // an amenity of the Bern build that data/ch/osm-*.json lacks (tools/build-amenities.mts)
  const ac = categorizeAmenity(t);
  if (ac && !CH_BASIC.has(ac)) {
    const k = `${ac},${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (amenitySeen.has(k)) continue;
    amenitySeen.add(k);
    if (t.name) {
      const nk = `${ac}|${t.name}`;
      const same = amenityNamed.get(nk) ?? [];
      if (same.some((o) => metres(o, { lat, lon }) < 15)) continue;
      amenityNamed.set(nk, [...same, { lat, lon }]);
    }
    amenities.push(slim<ChAmenity>({
      id, lat: r6(lat), lon: r6(lon), category: ac, canton: el.canton, name: t.name, address,
      opening_hours: t.opening_hours, fee: t.fee, access: t.access, wheelchair: t.wheelchair, website, operator: t.operator, phone,
      level: t.level, description: t.description, changing_table: t.changing_table, covered: t.covered, backrest: t.backrest,
      capacity: t.capacity, check_date: t.check_date,
    }));
  }
}

// Node + way of the same place (a shop's point inside its building): same name + category within 25 m → keep the one with more tags
const buckets = new Map<string, (ChPlace & { tagCount: number })[]>();
for (const p of places) if (p.name) {
  const k = `${p.category}|${p.name}`;
  (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(p);
}
const dropped = new Set<ChPlace>();
for (const list of buckets.values()) {
  if (list.length < 2) continue;
  list.sort((a, b) => a.lat - b.lat);
  for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length && list[y].lat - list[x].lat < 0.0003; y++) {
    const [p, q] = [list[x], list[y]];
    if (dropped.has(p) || dropped.has(q) || metres(p, q) > 25) continue;
    dropped.add(p.tagCount >= q.tagCount ? q : p);
  }
}
const keptPlaces: ChPlace[] = places.filter((p) => !dropped.has(p)).map(({ tagCount, ...p }) => p);

// Self-check: a bad build fails loudly instead of shipping an empty or broken layer
const inside = (i: LatLon, b: typeof CH) => i.lat >= b.S && i.lat <= b.N && i.lon >= b.W && i.lon <= b.E;
for (const list of [keptPlaces, amenities] as LatLon[][]) {
  assert.equal(new Set(list.map((i) => (i as ChPlace).id)).size, list.length, "duplicate ids");
  for (const i of list) assert(inside(i, CH), `${(i as ChPlace).id} outside Switzerland bbox`);
}
const count = (list: { category: string }[], c: string) => list.filter((i) => i.category === c).length;
for (const [c, min] of [["restaurant", 8000], ["cafe", 2000], ["hotel", 2000], ["bakery", 1000], ["hairdresser", 2000], ["school", 2000], ["place_of_worship", 3000]] as const) {
  assert(count(keptPlaces, c) >= min, `only ${count(keptPlaces, c)} ${c} (expected ${min}+)`);
}
for (const [c, min] of [["bench", 50000], ["bicycle_parking", 8000], ["recycling", 4000], ["post_box", 3000], ["ev_charging", 1000]] as const) {
  assert(count(amenities, c) >= min, `only ${count(amenities, c)} ${c} (expected ${min}+)`);
}
// Bern: about what the Bern build (data/places.json) has in its box
const bernPlaces = JSON.parse(readFileSync(new URL("../data/places.json", import.meta.url), "utf8")) as { items: { category: string }[] };
for (const c of ["restaurant", "cafe", "hairdresser"]) {
  const ours = keptPlaces.filter((p) => p.category === c && inside(p, BERN)).length, theirs = count(bernPlaces.items, c);
  assert(ours >= theirs * 0.8, `${c} in the Bern box: ${ours}, the Bern build has ${theirs}`);
}

mkdirSync(OUT, { recursive: true });
const generated = new Date().toISOString();
const write = (name: string, extra: object, items: object[]) => {
  const json = JSON.stringify({ generated, source: "OpenStreetMap contributors via overpass.osm.ch", licence: "ODbL", ...extra, count: items.length, items });
  const mb = Buffer.byteLength(json) / 1e6;
  assert(mb < 60, `${name} is ${mb} MB`);
  const gz = gzipSync(json, { level: 9 });
  writeFileSync(`${OUT}/${name}.json.gz`, gz);
  console.log(`${name}\t${items.length}\t${mb.toFixed(2)} MB\t${(gz.length / 1e6).toFixed(2)} MB gz`);
};
const groups = [...new Set(keptPlaces.map((p) => p.group))].sort();
for (const g of groups) {
  const items = keptPlaces.filter((p) => p.group === g);
  const counts: Record<string, number> = {};
  for (const i of items) counts[i.category] = (counts[i.category] ?? 0) + 1;
  write(`osm-places-${g}`, { group: g, counts }, items);
}
const amenityCounts: Record<string, number> = {};
for (const i of amenities) amenityCounts[i.category] = (amenityCounts[i.category] ?? 0) + 1;
write("osm-places-amenities", { counts: amenityCounts }, amenities);
console.log(`outside the Switzerland bbox: ${outside}; places ${keptPlaces.length} (${dropped.size} node/way doubles dropped), amenities ${amenities.length}:`, amenityCounts);
