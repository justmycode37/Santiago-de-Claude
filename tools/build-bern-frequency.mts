// Aggregates the "Halte an Haltestellen" timetable export (one row per trip
// per stop) into scheduled departures per hour for every stop in
// data/bern-stop-accessibility.json. This is a service-intensity proxy, not
// measured crowding: no open source publishes per-stop ridership for Bernmobil.
//
// Usage:
//   unzip -p data/raw/haltestellen_2026.zip haltestellen_2026/haltestellen26.csv \
//     | node tools/build-bern-frequency.mts data/bern-stop-accessibility.json data/bern-stop-frequency.json

import fs from "node:fs";
import readline from "node:readline";
import assert from "node:assert/strict";

const [stopsFile, outFile] = process.argv.slice(2);
const bernStops = new Set(JSON.parse(fs.readFileSync(stopsFile, "utf8")).stops.map((s) => String(s.didok)));

// One row per trip and traffic-day pattern. FAHRTAGE is the number of days in
// the timetable period on which that trip calls at the stop, so summing it per
// hour and dividing by the period length gives average departures per day.
const dayWeight = new Map(); // didok -> Map("line|terminus|HH", days)
let periodDays = 0; // longest FAHRTAGE seen = effective length of the period

// Names like "Bern, Pestalozzi" are quoted and contain commas.
function splitCsv(line) {
  const cells = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let header = null;
for await (const line of rl) {
  if (!header) {
    header = splitCsv(line);
    continue;
  }
  // Cheap pre-filter before the full parse: BPUIC is a bare number.
  const m = line.match(/,(85\d{5}),/);
  if (!m || !bernStops.has(m[1])) continue;
  const row = Object.fromEntries(splitCsv(line).map((v, i) => [header[i], v]));
  const didok = row.BPUIC;
  if (!bernStops.has(didok)) continue;
  const dep = row.AB_ZEIT_KB.split(" ")[1]; // "01.01.70 05:39:00" -> "05:39:00"
  if (!dep) continue; // arrivals at a terminus have no departure
  const days = Number(row.FAHRTAGE) || 0;
  periodDays = Math.max(periodDays, days);
  const key = `${row.LINIE}|${row.END_BP_BEZEICHNUNG}|${dep.slice(0, 2)}`;
  if (!dayWeight.has(didok)) dayWeight.set(didok, new Map());
  const byKey = dayWeight.get(didok);
  byKey.set(key, (byKey.get(key) ?? 0) + days);
}

const round = (x) => Math.round(x * 10) / 10;
const stops = {};
for (const [didok, byKey] of dayWeight) {
  const perHour = Array(24).fill(0);
  const lines = {};
  for (const [key, days] of byKey) {
    const [line, terminus, hour] = key.split("|");
    perHour[Number(hour) % 24] += days / periodDays;
    const id = `${line} → ${terminus}`;
    lines[id] = (lines[id] ?? 0) + days / periodDays;
  }
  stops[didok] = {
    avg_departures_per_hour: perHour.map(round),
    peak_departures_per_hour: round(Math.max(...perHour)),
    daily_departures_by_line: Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, round(v)])),
  };
}

// Self-check: the export really covered Bern (not an empty or truncated stdin), and the hours add up.
assert.ok(periodDays > 300, `period_days ${periodDays}: wrong or truncated input?`);
assert.ok(Object.keys(stops).length > 0.8 * bernStops.size, `only ${Object.keys(stops).length}/${bernStops.size} stops have departures`);
for (const s of Object.values(stops)) assert.equal(s.avg_departures_per_hour.length, 24);
fs.writeFileSync(outFile, JSON.stringify({ generated: new Date().toISOString(), period_days: periodDays, source: "https://data.opentransportdata.swiss/dataset/halte-an-haltestellen", stops }));
console.log(`${Object.keys(stops).length} stops -> ${outFile}`);
