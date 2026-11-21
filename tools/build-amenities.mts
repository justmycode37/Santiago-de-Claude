// Usage: node tools/build-amenities.mts data/amenities.json
// Fetches Bern amenities from OSM (Swiss Overpass instance) and writes the contract's Amenity[] file. Data: (c) OpenStreetMap contributors, ODbL.
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const OUT = process.argv[2] ?? "data/amenities.json";
const URL = "https://overpass.osm.ch/api/interpreter";
const BBOX = "46.9,7.34,46.99,7.5"; // S,W,N,E
// amenity=<value> that becomes category <value> as-is
const SAME = ["bench", "shelter", "shower", "post_office", "post_box", "bank", "bureau_de_change", "money_transfer", "police", "townhall",
  "social_facility", "place_of_worship", "dentist", "veterinary", "telephone", "public_bookcase", "bicycle_repair_station", "bicycle_parking",
  "recycling", "water_point", "internet_cafe", "car_sharing", "taxi", "bicycle_rental", "food_sharing", "give_box", "embassy"];
const LOCKERS = ["locker", "lockers", "luggage_locker"];

/** The tags of an OpenStreetMap object, key → value ("amenity" → "toilets"); a tag the object lacks reads as undefined. */
type OsmTags = Record<string, string>;
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
/** A record of data/amenities.json (docs/places-data.md). The values are OpenStreetMap's own strings; null = not tagged. */
interface Amenity {
  /** "node/123", "way/456" */
  id: string;
  lat: number;
  lon: number;
  /** What categorize() makes of the tags: "toilets", "drinking_water", "wifi", … */
  category: string;
  name: string | null;
  opening_hours: string | null;
  fee: string | null;
  wheelchair: string | null;
  website: string | null;
  /** "Neuengasse 15, 3011 Bern" */
  address: string | null;
  level: string | null;
  access: string | null;
  operator: string | null;
  phone: string | null;
  description: string | null;
  changing_table: string | null;
  unisex: string | null;
  male: string | null;
  female: string | null;
  toilets_wheelchair: string | null;
  toilets_disposal: string | null;
  drinking_water: string | null;
  covered: string | null;
  backrest: string | null;
  capacity: string | null;
  indoor: string | null;
  check_date: string | null;
  /** All tags but the mappers' own notes (source, note, fixme, created_by) */
  tags: OsmTags;
}
const QUERY = (nonce: string) => `[out:json][timeout:180][bbox:${BBOX}];
// nonce ${nonce}
(
  nwr[amenity=toilets];
  nwr[amenity=drinking_water];
  nwr[amenity=fountain][drinking_water=yes];
  nwr[man_made=water_tap][drinking_water=yes];
  nwr[amenity=pharmacy];
  nwr[amenity~"^(hospital|clinic|doctors|library|atm|community_centre)$"];
  nwr[internet_access=wlan]["internet_access:fee"=no];
  nwr[shop=supermarket];
  nwr[amenity~"^(${[...SAME, ...LOCKERS, "device_charging_station", "charging_station", "changing_table"].join("|")})$"];
  nwr[amenity=vending_machine][vending~"public_transport_tickets"];
  nwr[amenity=parking_space][parking_space=disabled];
  nwr[amenity=parking]["capacity:disabled"];
  nwr[office=diplomatic];
  nwr[emergency~"^(defibrillator|phone)$"];
  nwr[leisure=playground];
  nwr[highway=elevator];
);
out center tags;`;

// First match wins, so a library with free wifi stays a library (shortcut: one category per element).
// New categories come after wifi so every element categorized by the old build keeps its category.
function categorize(t: OsmTags) {
  const a = t.amenity;
  if (a === "toilets") return "toilets";
  if (a === "drinking_water" || ((a === "fountain" || t.man_made === "water_tap") && t.drinking_water === "yes")) return "drinking_water";
  if (["pharmacy", "hospital", "clinic", "doctors", "library", "atm", "community_centre"].includes(a)) return a;
  if (t.shop === "supermarket") return "supermarket";
  if (t.internet_access === "wlan" && t["internet_access:fee"] === "no") return "wifi";
  if (t.emergency === "defibrillator") return "aed";
  if (t.emergency === "phone") return "emergency_phone";
  if (SAME.includes(a)) return a;
  if (t.office === "diplomatic") return "embassy";
  if (LOCKERS.includes(a)) return "lockers";
  if (a === "device_charging_station") return "phone_charging";
  if (a === "charging_station") return "ev_charging";
  if (a === "changing_table") return "baby_changing";
  if (a === "vending_machine" && /public_transport_tickets/.test(t.vending ?? "")) return "ticket_machine";
  if (a === "parking_space" && t.parking_space === "disabled") return "disabled_parking";
  if (a === "parking" && t["capacity:disabled"] && !["no", "0"].includes(t["capacity:disabled"])) return "disabled_parking";
  if (t.leisure === "playground") return "playground";
  if (t.highway === "elevator") return "elevator";
  return null;
}

async function fetchOverpass() {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: { "User-Agent": "bern-access-hackathon/1.0 (AI for Access demo)", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: QUERY(`${Date.now()}-${attempt}`) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as OverpassAnswer;
      if (!Array.isArray(json.elements)) throw new Error("no elements");
      if (json.remark && /timed out|runtime error/i.test(json.remark)) throw new Error(json.remark); // partial result
      return json.elements;
    } catch (e) {
      console.error(`attempt ${attempt} failed: ${(e as Error).message}`);
      if (attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

const join = (sep: string, ...xs: (string | null | undefined)[]) => xs.filter(Boolean).join(sep) || null;
const metres = (a: LatLon, b: LatLon) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180));
const ORDER = { node: 0, way: 1, relation: 2 };

const seen = new Set<string>(); // category + rounded point (~1 m)
const named = new Map<string, LatLon[]>(); // category|name -> kept items, for node+way duplicates within 15 m
const items: Amenity[] = [];
for (const el of (await fetchOverpass())!.sort((a, b) => ORDER[a.type] - ORDER[b.type])) { // nodes first, so the node wins
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
  items.push({
    id: `${el.type}/${el.id}`, lat, lon, category,
    name: t.name ?? null, opening_hours: t.opening_hours ?? null, fee: t.fee ?? null,
    wheelchair: t.wheelchair ?? null, website: t.website ?? t["contact:website"] ?? null,
    address: join(", ", join(" ", t["addr:street"], t["addr:housenumber"]), join(" ", t["addr:postcode"], t["addr:city"])),
    level: t.level ?? null, access: t.access ?? null, operator: t.operator ?? null,
    phone: t.phone ?? t["contact:phone"] ?? null, description: t.description ?? null,
    changing_table: t.changing_table ?? null, unisex: t.unisex ?? null, male: t.male ?? null, female: t.female ?? null,
    toilets_wheelchair: t["toilets:wheelchair"] ?? null, toilets_disposal: t["toilets:disposal"] ?? null,
    drinking_water: t.drinking_water ?? null, covered: t.covered ?? null, backrest: t.backrest ?? null,
    capacity: t.capacity ?? null, indoor: t.indoor ?? null, check_date: t.check_date ?? null,
    tags: Object.fromEntries(Object.entries(t).filter(([key]) => !/^(source|note|fixme|created_by)/i.test(key))),
  });
}

// Self-check: a bad build fails loudly instead of shipping an empty or broken map layer.
const [S, W, N, E] = BBOX.split(",").map(Number);
assert(items.length > 955, `only ${items.length} items, expected more than the old build`);
assert.equal(new Set(items.map((i) => i.id)).size, items.length, "duplicate ids");
for (const i of items) {
  assert(Number.isFinite(i.lat) && Number.isFinite(i.lon) && i.lat >= S && i.lat <= N && i.lon >= W && i.lon <= E, `${i.id} outside bbox`);
  assert(typeof i.category === "string" && i.category, `${i.id} has no category`);
}

writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), source: "OpenStreetMap contributors (ODbL) via overpass.osm.ch", items }));
const counts: Record<string, number> = {};
for (const i of items) counts[i.category] = (counts[i.category] ?? 0) + 1;
console.log(items.length, "items", counts);
