// Merges every Swiss toilet record we have into one list, data/ch/toilets-ch.json (CH-wide version of tools/build-toilets.mts):
//   osm      - amenity=toilets, data/ch/osm-toilets.json (tools/build-amenities-ch.mts, ODbL)
//   official - city WC registries (zh.zueriwc, bs.wc, ge.wc, lu.wc, sg.wc, zg.stadtmobiliar) and ATLAS station toilets
//              (atlas.toilet, position = station centre), data/ch/official-ch.json (tools/build-official-ch.mts)
//   nette    - Stadt Bern "Nette Toilette" restaurants, taken from Bern's merged data/toilets.json (tools/build-toilets.mts)
// Matching is one-to-one, nearest pair first: city WC <-> OSM toilet within 30 m (same site); ATLAS <-> OSM within 100 m,
// preferring OSM toilets that look like station toilets; Nette <-> OSM by id, else within 30 m. Unmatched records stay as
// their own items. Precedence: official city data > OSM > none for paid/price/wheelchair/eurokey (disagreement -> notes);
// OSM wins for name, address, opening_hours (machine-readable), access, operator; ATLAS only fills gaps.
// `paid` is "free" | "paid" | "mixed" (site has both a free and a paying WC, by cabin or time of day) | null (unknown).
// Nothing is excluded: customers/private toilets stay, flagged by `access`.
// Usage: node tools/build-toilets-ch.mts [data/ch/toilets-ch.json] [data/toilets.json]
import fs from "node:fs";
import assert from "node:assert/strict";

const OUT = process.argv[2] ?? "data/ch/toilets-ch.json";
const BERN = process.argv[3] ?? "data/toilets.json";
const CITY_M = 30, ATLAS_M = 100, ATLAS_BONUS_M = 50; // a station-looking OSM toilet beats a closer anonymous one by up to 50 m
const CH = { S: 45.8, W: 5.9, N: 47.9, E: 10.6 };
for (const f of ["data/ch/osm-toilets.json", "data/ch/official-ch.json", BERN])
  assert.ok(fs.existsSync(f), `missing ${f}: run tools/build-amenities-ch.mts, tools/build-official-ch.mts, tools/build-toilets.mts first`);

const metres = (a, b) => Math.hypot((a.lat - b.lat) * 111195, (a.lon - b.lon) * 111195 * Math.cos((a.lat * Math.PI) / 180));
const nn = (v) => (v == null || v === "" || v === "unknown" ? null : v);
// loose on purpose: accents and "h" dropped so "Mülirad" ~ "Mühlirad" (from tools/build-toilets.mts)
const GENERIC = new Set(["restaurant", "ristorante", "hotel", "toilette", "toiletten", "toilettes", "bahnhof", "station", "public", "publique", "publics", "öffentliche"]);
const nameTokens = (s) => new Set((s ?? "").toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length >= 4 && !GENERIC.has(w))
  .map((w) => w.normalize("NFD").replace(/\p{M}|h/gu, "")));
const sharesName = (a, b) => [...nameTokens(a)].some((w) => [...nameTokens(b)].some((v) => v.startsWith(w.slice(0, 5)) || w.startsWith(v.slice(0, 5))));

// --- fee text -> paid. Same regexes as tools/build-official-ch.mts feeOf(), but there "free" also covers sites where one WC is
// free and another costs; here that is "mixed". `\d.-` added so "Nachts 1.-" counts as paid.
const FREE = /gebührenfrei|kostenlos|gratis|gratuit|gratuito|unentgeltlich|\bfree\b/i;
const NOT_FREE = /(?:eurokey|pissoir)\s*(?:gratis|kostenlos)|(?:gratis|kostenlos)\s*mit\s*eurokey/gi;
const PAID = /kostenpflichtig|payant|a pagamento|gebühr(?!enfrei)|münz|kreditkart|franken|\b(?:fr|chf|sfr)\.?\s*\d|\d\s*(?:chf|fr\.|rp\.?)(?!\w)|\d\.[-–]/i;
function paidOf(t) {
  if (!t) return null;
  const free = FREE.test(t.replace(NOT_FREE, "")), paid = PAID.test(t);
  return free && paid ? "mixed" : free ? "free" : paid ? "paid" : null;
}
// fee/charge text -> "CHF 1.00" (CHF amount preferred over EUR; Rp. = cents; a bare number is CHF)
const num = (s) => +s.replace(",", ".");
function priceOf(t) {
  if (!t) return null;
  let m = t.match(/(?:CHF|SFr\.?|Fr\.?)\s*(\d+(?:[.,]\d+)?)/i) ?? t.match(/(\d+(?:[.,]\d+)?)\s*(?:CHF|Fr\.|Franken|\.[-–])/i) ?? t.match(/^\s*(\d+(?:[.,]\d+)?)\s*$/);
  if (m) return `CHF ${num(m[1]).toFixed(2)}`;
  if ((m = t.match(/(\d+)\s*Rp\.?/i))) return `CHF ${(num(m[1]) / 100).toFixed(2)}`;
  if ((m = t.match(/(\d+(?:[.,]\d+)?)\s*(?:EUR|€|Euro)|(?:EUR|€)\s*(\d+(?:[.,]\d+)?)/i))) return `EUR ${num(m[1] ?? m[2]).toFixed(2)}`;
  return null;
}
assert.equal(paidOf("Gebührenfrei"), "free");
assert.equal(paidOf("kostenlos"), "free");
assert.equal(paidOf("kostenpflichtig"), "paid");
assert.equal(paidOf("Behinderten-WC Fr. 1.-- oder Eurokey, Multifunktions-WC gratis"), "mixed");
assert.equal(paidOf("Rollstuhlgängiges-WC: CHF 1.-- / 1 Euro (Kreditkartenzahlung möglich) oder kostenlos mit Eurokey. Multifunktions-WC: kostenlos."), "mixed");
assert.equal(paidOf("Gebührenfrei. Behinderten-WC mit Eurokey oder Fr. 1.--."), "mixed");
assert.equal(paidOf("06:00-22:00 Gratis. Nachts 1.- oder Eurokey"), "mixed");
assert.equal(paidOf("Gratuit de 8h à 20h, payant de 20h à 8h"), "mixed");
assert.equal(paidOf("Gebührenfrei, Behinderten-WC nur mit Eurokey"), "free");
assert.equal(paidOf("Fr. 1.-, Eurokey Gratis"), "paid");
assert.equal(paidOf("Fr. 1.-, mit Eurokey gratis"), "paid");
assert.equal(paidOf("Gebühr Fr. 1.--. Pissoir gratis."), "paid");
assert.equal(paidOf("Geöffnet 24h. Behinderten-WC ohne Eurokey von 06.00-22.00 Uhr."), null);
for (const [t, p] of [["Fr. 1.--", "CHF 1.00"], ["1 Franken", "CHF 1.00"], ["Nachts 1.- oder Eurokey", "CHF 1.00"], ["0,5 CHF", "CHF 0.50"],
  ["1EUR / 1CHF", "CHF 1.00"], ["1.50 CHf", "CHF 1.50"], ["0.5", "CHF 0.50"], ["1 EUR", "EUR 1.00"], ["50 Rp.", "CHF 0.50"],
  ["Fr. 1/Eurokey", "CHF 1.00"], ["Gebührenfrei", null], ["06:00-22:00 Gratis", null]]) assert.equal(priceOf(t), p, t);
assert.ok(sharesName("Bahnhof Wattwil", "WC Bahnhof Wattwil") && !sharesName("Bahnhof Baar", "Bahnhof Zug"));

const ADDR = ["address", "postcode", "city", "address_source", "address_distance_m"]; // merged as one unit
const FIELDS = ["name", ...ADDR, "canton", "access", "paid", "price", "wheelchair", "toilets_wheelchair", "eurokey",
  "changing_table", "unisex", "opening_hours", "operator", "level", "check_date", "address_source", "address_distance_m"];
const OFFICIAL_WINS = new Set(["paid", "price", "wheelchair", "toilets_wheelchair", "eurokey"]); // city data only, ATLAS just fills
const NOTE_CONFLICT = new Set(["paid", "wheelchair", "toilets_wheelchair"]);
const blank = () => Object.fromEntries(FIELDS.map((f) => [f, null]));

// --- OSM (Bern's merged file knows OSM centralkey=eurokey, which the slim CH files dropped)
const bern = JSON.parse(fs.readFileSync(BERN, "utf8")).items;
const bernEurokey = new Set(bern.filter((i) => i.eurokey === "yes").map((i) => i.id));
const osm = JSON.parse(fs.readFileSync("data/ch/osm-toilets.json", "utf8")).items;
const items = osm.map((t) => {
  const paid = t.fee === "donation" ? "free" : nn(t.paid);
  return {
    id: t.id, lat: t.lat, lon: t.lon, ...blank(),
    ...Object.fromEntries(["name", "address", "postcode", "city", "canton", "access", "wheelchair", "changing_table", "unisex", "opening_hours",
      "operator", "level", "check_date", "address_source", "address_distance_m"].map((f) => [f, nn(t[f])])),
    paid, price: paid === "paid" ? priceOf(t.charge) : null,
    toilets_wheelchair: nn(t.toilets_wheelchair) ?? nn(t.wheelchair), // on a standalone toilet, wheelchair=* describes the toilet itself
    eurokey: bernEurokey.has(t.id) || t.access === "centralkey" ? "yes" : null,
    sources: [`osm:${t.id}`],
    notes: [t.fee === "donation" && "OSM fee=donation", t.fee_conditional && `OSM fee:conditional=${t.fee_conditional}`,
      t.charge && !priceOf(t.charge) && `OSM charge=${t.charge}`, t.charge && /customers/i.test(t.charge) && `OSM charge=${t.charge}`].filter(Boolean),
  };
});
const osmById = new Map(items.map((i) => [i.id, i]));

// --- official records -> toilet records
const officialDoc = JSON.parse(fs.readFileSync("data/ch/official-ch.json", "utf8"));
const official = officialDoc.items.filter((i) => i.category === "toilets");
const TRIVIAL_FEE = /^(gebührenfrei|kostenlos|kostenpflichtig)\.?$/i;
function fromOfficial(o) {
  const p = o.props ?? {}, atlas = o.source === "atlas.toilet";
  const nette = p.ART_resolved === "Nette Toilette" || /nette toilette/i.test(p.typ ?? "");
  const eurokey = p.eurokey === true || p.EUROKEY_resolved === "Ja" || /eurokey/i.test(o.fee ?? "") ? "yes" : null;
  const paid = paidOf(o.fee) ?? (nette ? "free" : null);
  return {
    id: o.id, lat: o.lat, lon: o.lon, ...blank(),
    ...Object.fromEntries(ADDR.map((f) => [f, o[f] ?? null])), name: o.name, canton: o.canton,
    access: atlas ? null : "yes", // city registries list public WCs; Nette = open to everyone
    paid, price: paid === "paid" || paid === "mixed" ? priceOf(o.fee) : null,
    wheelchair: atlas ? null : o.wheelchair, toilets_wheelchair: o.wheelchair, eurokey,
    opening_hours: o.opening_hours, operator: atlas ? p.operator ?? null : null,
    sources: [o.id], atlas, station: atlas ? o.name.split(" – ")[0] : null,
    notes: [o.fee && !TRIVIAL_FEE.test(o.fee) && `fee (${o.source}): ${o.fee}`, nette && "Nette Toilette: free to use without buying anything, during the business's opening hours",
      atlas && p.additionalInformation].filter(Boolean),
  };
}
const offRecs = official.filter((o) => !/keine toiletten/i.test(o.name)).map(fromOfficial);
const droppedNoToilet = official.length - offRecs.length;

// --- Nette Toilette (Bern): every record of data/toilets.json that has a nette source
const netteRecs = bern.filter((i) => i.sources.some((s) => s.startsWith("nette:"))).map((i) => {
  const id = `nette/${i.sources.find((s) => s.startsWith("nette:")).match(/nette:(\d+)/)[1]}`;
  return {
    ...blank(), ...Object.fromEntries(FIELDS.map((f) => [f, nn(i[f])])),
    id, osmId: i.id.startsWith("nette/") ? null : i.id, lat: i.lat, lon: i.lon, canton: "BE", paid: "free", price: null,
    // Bern writes "Street Nr, PLZ City"; split into the CH fields
    address: i.address?.replace(/, \d{4} .*$/, "") ?? null, postcode: i.address?.match(/, (\d{4}) /)?.[1] ?? null, city: i.address?.match(/, \d{4} (.*)$/)?.[1] ?? null,
    address_source: null, address_distance_m: null,
    sources: [id, ...i.sources.filter((s) => s.startsWith("osm-place:"))],
    notes: ["Nette Toilette (Stadt Bern): free to use without buying anything, during the business's opening hours"],
  };
});

const stats = { matched: {}, conflicts: 0 };
function absorb(it, rec, d, src, officialWins) {
  stats.matched[src] = (stats.matched[src] ?? 0) + 1;
  // address: a stated one beats one derived from the register (tools/enrich-addresses-ch.mts); OSM's beats the other source's
  const stated = (x) => x.address != null && x.address_source == null;
  if (rec.address != null && (it.address == null || (!stated(it) && stated(rec)))) for (const f of ADDR) it[f] = rec[f];
  for (const f of FIELDS) {
    if (rec[f] == null || ADDR.includes(f)) continue;
    if (it[f] == null) { it[f] = rec[f]; continue; }
    if (rec[f] === it[f] || (f.includes("wheelchair") && [rec[f], it[f]].every((v) => v === "yes" || v === "designated"))) continue;
    if (NOTE_CONFLICT.has(f)) { it.notes.push(`${officialWins ? "OSM" : src} says ${f}=${officialWins ? it[f] : rec[f]}`); stats.conflicts++; }
    if (officialWins && OFFICIAL_WINS.has(f)) it[f] = rec[f];
  }
  if (officialWins && rec.paid != null) it.price = rec.price; // price belongs to the paid verdict that won
  it.sources.push(...rec.sources.map((s, k) => (k === 0 ? `${s} (${d.toFixed(0)} m)` : s)));
  it.notes.push(...rec.notes);
}
// One-to-one matching, best (lowest score) pair first. An OSM toilet takes at most one record per group.
function matchAll(recs, radius, score, src, officialWins) {
  const pairs = [];
  for (const r of recs) for (const o of osm) {
    const d = metres(r, o);
    if (d <= radius) pairs.push([score(r, osmById.get(o.id), d), d, r, osmById.get(o.id)]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const usedR = new Set(), usedO = new Set();
  for (const [, d, r, o] of pairs) {
    if (usedR.has(r) || usedO.has(o)) continue;
    usedR.add(r); usedO.add(o);
    absorb(o, r, d, src, officialWins);
  }
  return recs.filter((r) => !usedR.has(r));
}

const city = offRecs.filter((r) => !r.atlas), atlas = offRecs.filter((r) => r.atlas);
const STATIONY = /bahnhof|\bbf\b|station|gare|stazione|sbb|cff|ffs|bls|rhb|sob|\bzb\b|mgb|bahn|perron|gleis|quai|binario|unterführung/i;
const unCity = matchAll(city, CITY_M, (r, o, d) => d, "official", true);
const unAtlas = matchAll(atlas, ATLAS_M, (r, o, d) => d - (STATIONY.test(`${o.name ?? ""} ${o.operator ?? ""}`) || sharesName(o.name, r.station) || o.level != null ? ATLAS_BONUS_M : 0), "atlas", false);
for (const r of unAtlas) r.notes.unshift("position is the station centre (ATLAS has no toilet coordinates)");
const netteById = netteRecs.filter((r) => r.osmId && osmById.has(r.osmId));
for (const r of netteById) absorb(osmById.get(r.osmId), r, metres(r, osmById.get(r.osmId)), "nette", true);
const unNette = matchAll(netteRecs.filter((r) => !netteById.includes(r)), CITY_M, (r, o, d) => d, "nette", true);
items.push(...unCity, ...unAtlas, ...unNette);

const out = items.map((i) => ({
  id: i.id, lat: +i.lat.toFixed(6), lon: +i.lon.toFixed(6), name: i.name, address: i.address, postcode: i.postcode, city: i.city, canton: i.canton,
  sources: i.sources, access: i.access, paid: i.paid, price: i.price, wheelchair: i.wheelchair, toilets_wheelchair: i.toilets_wheelchair,
  eurokey: i.eurokey, changing_table: i.changing_table, unisex: i.unisex, opening_hours: i.opening_hours, operator: i.operator, level: i.level,
  check_date: i.check_date, notes: i.notes.length ? [...new Set(i.notes)].join("; ") : null,
  ...(i.address_source ? { address_source: i.address_source, address_distance_m: i.address_distance_m } : {}),
}));

// self-checks
assert.equal(new Set(out.map((i) => i.id)).size, out.length, "duplicate ids");
assert.ok(out.every((i) => i.lat >= CH.S && i.lat <= CH.N && i.lon >= CH.W && i.lon <= CH.E && i.sources.length), "item outside CH or without source");
assert.ok(out.every((i) => [null, "free", "paid", "mixed"].includes(i.paid)), "bad paid value");
assert.ok(out.every((i) => i.price == null || (/^(CHF|EUR) \d+\.\d\d$/.test(i.price) && i.paid !== "free")), "bad price");
assert.ok(out.every((i) => i.canton && /^[A-Z]{2}$/.test(i.canton)), "missing canton");
const nMatched = Object.values(stats.matched).reduce((a, b) => a + b, 0);
assert.equal(out.length, osm.length + offRecs.length + netteRecs.length - nMatched, "item count");
assert.ok(osm.length > 5000 && city.length > 400 && atlas.length > 500 && netteRecs.length === 12);
assert.ok(out.filter((i) => i.paid === "mixed").length > 30, "Zürich mixed sites not detected");
const enc = JSON.stringify({
  generated: new Date().toISOString(),
  sources: [
    { key: "osm", name: "OpenStreetMap amenity=toilets (data/ch/osm-toilets.json)", url: "https://www.openstreetmap.org", licence: "ODbL 1.0", count: osm.length },
    ...[...new Set(offRecs.map((r) => r.id.split("/")[0]))].map((k) => ({ key: k, name: `${k} via data/ch/official-ch.json (see docs/data-ch-official.md)`,
      licence: officialDoc.sources.find((s) => s.key === k)?.licence ?? null, count: offRecs.filter((r) => r.id.startsWith(k + "/")).length })),
    { key: "nette", name: "Stadt Bern, Nette Toilette flyer (2018), via data/toilets.json", licence: "public city information (facts)", count: netteRecs.length },
  ],
  items: out,
});
assert.ok(enc.length < 40e6, "file too large");
fs.writeFileSync(OUT, enc);

// --- report
const pc = (k, n) => `${k} (${((k / n) * 100).toFixed(0)}%)`;
const paidRow = (a) => ["free", "paid", "mixed", null].map((p) => a.filter((i) => i.paid === p).length).join(" / ");
console.log(`inputs: osm ${osm.length}, city WC ${city.length}, atlas ${atlas.length} (dropped "Keine Toiletten": ${droppedNoToilet}), nette ${netteRecs.length}`);
console.log(`matched: city->OSM ${stats.matched.official ?? 0}, atlas->OSM ${stats.matched.atlas ?? 0}, nette->OSM ${stats.matched.nette ?? 0}; conflicts noted ${stats.conflicts}`);
console.log(`merged items: ${out.length}; paid free/paid/mixed/unknown: ${paidRow(out)}; price known ${out.filter((i) => i.price).length}`);
console.log(`toilets_wheelchair known ${pc(out.filter((i) => i.toilets_wheelchair).length, out.length)}, =yes|designated ${out.filter((i) => /yes|designated/.test(i.toilets_wheelchair ?? "")).length}, eurokey=yes ${out.filter((i) => i.eurokey).length}`);
console.log(`access: ${Object.entries(out.reduce((c, i) => ((c[i.access] = (c[i.access] ?? 0) + 1), c), {})).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log("\nper source (items containing it): free / paid / mixed / unknown | wheelchair known");
for (const k of ["osm", ...new Set(offRecs.map((r) => r.id.split("/")[0])), "nette"]) {
  const a = out.filter((i) => i.sources.some((s) => s.startsWith(k === "osm" ? "osm:" : k + "/")));
  console.log(`  ${k.padEnd(18)} ${String(a.length).padStart(5)}: ${paidRow(a)} | ${pc(a.filter((i) => i.toilets_wheelchair).length, a.length)}`);
}
console.log("\nper canton: n: free / paid / mixed / unknown | wheelchair known");
for (const c of [...new Set(out.map((i) => i.canton))].sort()) {
  const a = out.filter((i) => i.canton === c);
  console.log(`  ${c} ${String(a.length).padStart(5)}: ${paidRow(a)} | ${pc(a.filter((i) => i.toilets_wheelchair).length, a.length)}`);
}
console.log(`\nwrote ${OUT} (${(enc.length / 1e6).toFixed(2)} MB)`);
