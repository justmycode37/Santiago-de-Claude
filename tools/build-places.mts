// Usage: node tools/build-places.mts data/places.json
// Fetches Google-Maps-style places (food, shops, hotels, culture, sport, services, health, worship) in Bern from OSM
// (Swiss Overpass instance) and writes data/places.json. Data: (c) OpenStreetMap contributors, ODbL.
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { CULTURE_AMENITY, FOOD_AMENITY, HEALTH_AMENITY, LEISURE, SERVICE_AMENITY, UNNAMED_OK, categorizePlace as categorize, rx } from "./osm-categories.mts";
import type { OsmTags, PlaceGroup } from "./osm-categories.mts";

const OUT = process.argv[2] ?? "data/places.json";
const URL = "https://overpass.osm.ch/api/interpreter";
const BBOX = "46.9,7.34,46.99,7.5"; // S,W,N,E
const [S, W, N, E] = BBOX.split(",").map(Number);
const MAX_BYTES = 15e6;

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
  /** Set when the query timed out or failed: the elements are then only a part */
  remark?: string;
}
interface LatLon { lat: number; lon: number }
/** A record of data/places.json (docs/places-data.md). The values are OpenStreetMap's own strings; null = not tagged. */
interface Place {
  /** "node/123", "way/456" */
  id: string;
  lat: number;
  lon: number;
  group: PlaceGroup;
  /** The value of the tag that put it in its group: "restaurant", "bakery", "museum" */
  category: string;
  name: string | null;
  brand: string | null;
  operator: string | null;
  /** "Neuengasse 15, 3011 Bern": the four parts below in one line */
  address: string | null;
  street: string | null;
  housenumber: string | null;
  postcode: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  opening_hours: string | null;
  wheelchair: string | null;
  wheelchair_description: string | null;
  toilets_wheelchair: string | null;
  cuisine: string | null;
  /** The diet:* tags without the prefix: { vegan: "yes" } */
  diet: Record<string, string> | null;
  outdoor_seating: string | null;
  takeaway: string | null;
  delivery: string | null;
  /** The payment:* tags without the prefix: { cash: "yes", twint: "yes" } */
  payment: Record<string, string> | null;
  level: string | null;
  internet_access: string | null;
  wikidata: string | null;
  description: string | null;
  check_date: string | null;
  /** All tags but the mappers' own notes; left out for the big categories when the file would pass MAX_BYTES */
  tags?: OsmTags;
}

// One query per group so none times out; regexes mirror the sets above (categorize() does the real filtering).
const QUERIES = {
  food_drink: `nwr[amenity~${rx(FOOD_AMENITY)}];`,
  shopping: `nwr[shop]; nwr[amenity=marketplace];`,
  lodging_culture: `nwr[tourism]; nwr[historic][name]; nwr[amenity~${rx(CULTURE_AMENITY)}];`,
  leisure_sport: `nwr[leisure~${rx(LEISURE)}];`,
  services: `nwr[amenity~${rx(SERVICE_AMENITY)}]; nwr[amenity~"^(parking|recycling|coworking_space|embassy)$"]; nwr[office]; nwr[craft];`,
  health_worship: `nwr[amenity~${rx(HEALTH_AMENITY)}]; nwr[amenity=place_of_worship]; nwr[healthcare];`,
};
const query = (body: string, nonce: string) => `[out:json][timeout:180][bbox:${BBOX}];
// nonce ${nonce}
(
${body}
);
out center tags;`;

async function fetchOverpass(body: string) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: { "User-Agent": "bern-access-hackathon/1.0 (AI for Access demo)", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query(body, `${Date.now()}-${attempt}`) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as OverpassAnswer;
      if (!Array.isArray(json.elements)) throw new Error("no elements");
      if (json.remark && /error|timed out/i.test(json.remark)) throw new Error(json.remark);
      return json.elements;
    } catch (e) {
      console.error(`attempt ${attempt} failed: ${(e as Error).message}`);
      if (attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

const prefixed = (t: OsmTags, p: string) => {
  const o = Object.fromEntries(Object.entries(t).filter(([k]) => k.startsWith(p)).map(([k, v]) => [k.slice(p.length), v]));
  return Object.keys(o).length ? o : null;
};
const DROP = /^(source|note$|fixme$|FIXME$|created_by$)/;

const byId = new Map<string, OverpassElement>();
for (const [name, body] of Object.entries(QUERIES)) {
  const els = await fetchOverpass(body) as OverpassElement[];
  console.log(name, els.length, "elements");
  for (const el of els) byId.set(`${el.type}/${el.id}`, el);
  await new Promise((r) => setTimeout(r, 3000));
}

let items: Place[] = [];
for (const [id, el] of byId) {
  const t = el.tags ?? {};
  const cat = categorize(t);
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (!cat || lat == null || lon == null) continue;
  if (lat < S || lat > N || lon < W || lon > E) continue; // ways crossing the bbox edge can have their center outside
  const [group, category] = cat;
  if (!t.name && !UNNAMED_OK.has(category)) continue;
  const street = t["addr:street"] ?? t["addr:place"] ?? null;
  const city = t["addr:city"] ?? null, postcode = t["addr:postcode"] ?? null, housenumber = t["addr:housenumber"] ?? null;
  const line1 = [street, housenumber].filter(Boolean).join(" "), line2 = [postcode, city].filter(Boolean).join(" ");
  items.push({
    id, lat, lon, group, category,
    name: t.name ?? null, brand: t.brand ?? null, operator: t.operator ?? null,
    address: [line1, line2].filter(Boolean).join(", ") || null, street, housenumber, postcode, city,
    phone: t.phone ?? t["contact:phone"] ?? t["contact:mobile"] ?? null,
    email: t.email ?? t["contact:email"] ?? null,
    website: t.website ?? t["contact:website"] ?? t.url ?? null,
    opening_hours: t.opening_hours ?? null,
    wheelchair: t.wheelchair ?? null, wheelchair_description: t["wheelchair:description"] ?? null,
    toilets_wheelchair: t["toilets:wheelchair"] ?? null,
    cuisine: t.cuisine ?? null, diet: prefixed(t, "diet:"),
    outdoor_seating: t.outdoor_seating ?? null, takeaway: t.takeaway ?? null, delivery: t.delivery ?? null,
    payment: prefixed(t, "payment:"), level: t.level ?? null, internet_access: t.internet_access ?? null,
    wikidata: t.wikidata ?? null, description: t.description ?? null, check_date: t.check_date ?? null,
    tags: Object.fromEntries(Object.entries(t).filter(([k]) => !DROP.test(k))),
  });
}

// Node + way of the same place (e.g. shop point inside its building): same name+category within 25 m -> keep the richer one.
const metres = (a: LatLon, b: LatLon) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180));
const buckets = new Map<string, Place[]>();
for (const i of items) {
  if (!i.name) continue;
  const k = `${i.category}|${i.name}`;
  buckets.set(k, [...(buckets.get(k) ?? []), i]);
}
const dropped = new Set<Place>();
for (const list of buckets.values()) {
  for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
    const [p, q] = [list[x], list[y]];
    if (dropped.has(p) || dropped.has(q) || metres(p, q) > 25) continue;
    dropped.add(Object.keys(p.tags!).length >= Object.keys(q.tags!).length ? q : p);
  }
}
items = items.filter((i) => !dropped.has(i));

const counts: Record<string, Record<string, number>> = {}, catTotals: Record<string, number> = {};
for (const i of items) {
  (counts[i.group] ??= {})[i.category] = (counts[i.group][i.category] ?? 0) + 1;
  catTotals[i.category] = (catTotals[i.category] ?? 0) + 1;
}

const out = { generated: new Date().toISOString(), source: "OpenStreetMap contributors (ODbL) via overpass.osm.ch", bbox: BBOX, counts, items };
let json = JSON.stringify(out);
if (Buffer.byteLength(json) > MAX_BYTES) { // keep the file loadable in a browser: big categories lose their raw tags
  const big = Object.keys(catTotals).filter((c) => catTotals[c] > 1000);
  for (const i of items) if (big.includes(i.category)) delete i.tags;
  json = JSON.stringify(out);
  console.log("over 15 MB: dropped tags for", big);
}

// Self-check: a bad build fails loudly instead of shipping a broken file.
const ids = new Set<string>();
for (const i of items) {
  assert.ok(Number.isFinite(i.lat) && i.lat >= S && i.lat <= N, `lat out of bbox: ${i.id}`);
  assert.ok(Number.isFinite(i.lon) && i.lon >= W && i.lon <= E, `lon out of bbox: ${i.id}`);
  assert.ok(i.group && i.category, `missing group/category: ${i.id}`);
  assert.ok(!ids.has(i.id), `duplicate id: ${i.id}`);
  ids.add(i.id);
}
assert.ok(items.length > 1000, `suspiciously few items: ${items.length}`);

writeFileSync(OUT, json);
console.log(items.length, "items,", dropped.size, "node/way duplicates dropped,", (Buffer.byteLength(json) / 1e6).toFixed(1), "MB");
for (const [g, c] of Object.entries(counts)) console.log(g, Object.values(c).reduce((a, b) => a + b, 0));
