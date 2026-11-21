# Transit accessibility, stop frequency and help services (Bern)

Three JSON files in `data/`, ported from the Powercoders hackathon repo and refreshed on 21 Nov 2026. None of them is wired into the map yet. For background and feature ideas, see [accessibility-data.md](accessibility-data.md). The research behind `offices.json` is in [research/](research/README.md).

| File | Size | Content | Rebuild |
|---|---|---|---|
| `data/bern-stop-accessibility.json` | 387 stops, 983 edges | every stop edge (Haltekante) in greater Bern, with ATLAS accessibility (PRM), BfR wheelchair status and OSM comfort tags | `tools/build-bern-accessibility.mjs` |
| `data/bern-stop-frequency.json` | 381 stops | scheduled departures per hour per stop (2026 timetable) | `tools/build-bern-frequency.mjs` |
| `data/offices.json` | 59 rows | offices, help services and hotlines for newcomers, hand-curated | edit by hand |

Bbox for both transit files: S,W,N,E = 46.90, 7.34, 46.99, 7.50 (same as `data/places.json`).

## `data/bern-stop-accessibility.json`

```
{ generated, bbox: {minLat, maxLat, minLon, maxLon}, sources: string[], stops: Stop[] }

Stop = {
  sloid: "ch:1:sloid:7060", didok: 8507060, name: "Bern, Helvetiaplatz", operator,
  means: ["TRAM", "BUS"],             // ATLAS stop-point meansOfTransport
  note, assistance,                   // ATLAS stop-point freeText / assistanceAvailability
  bfr: { rail, bus } | null,          // BfR status at stop level, see legend below
  toilets: [{ designation, wheelchair: bool|null, info }],
  lat?, lon?, coord_source?,          // only on stops without any edge (Bern Matte, Bern Münsterplattform)
  edges: Edge[]
}

Edge = {
  sloid: "ch:1:sloid:7060:0:2369", label: "A",   // label = designation or designationOperational
  lat: number|null, lon: number|null,
  coord_source?: string|null,          // present only on edges ATLAS has no coordinates for
  compass: number|null,                // vehicle heading at the edge, degrees
  direction_text: string|null,         // ATLAS free text, e.g. "Tramlinien 6, 7, 8 Richtung Bern Bahnhof."
  access: {                            // ATLAS platform-v2, null when there is no PRM record
    vehicle_access, level_access_wheelchair, platform_height_cm, inclination_pct,
    inclination_longitudinal_pct, inclination_width_pct, wheelchair_area_cm: [len, width]|null,
    shuttle_needed, tactile_system, attention_field, contrasting_areas, dynamic_audio, dynamic_visual,
    info: string[], boarding_device, advice
  } | null,
  bfr: { rail, bus } | null,
  osm: { osm_id, lat, lon, shelter, bench, lit, tactile_paving, wheelchair, departures_board,
         speech_output, width_m } | null   // raw OSM tag values (strings)
}
```

BfR status values (`rail` = tram/train, `bus` = bus): `step_free`, `ramp_no_booking`, `ramp_with_booking`, `replacement_transport`, `not_accessible`, `no_info`, or `null`.

### Missing coordinates

ATLAS (traffic-point-v2) has 20 boarding edges at Bern stops without coordinates. The build fills them in this order and records the result in `edge.coord_source`:

1. `osm:<type>/<id>`: an OSM platform tagged `ref:sloid` = the edge's SLOID (exact). Today none of the 20 is in OSM.
2. `stadtbern.Haltestelle (Kante)`: the city geoportal point with the same edge letter.
3. `stadtbern.Haltestelle (direction text)`: the city point whose termini (`Nummer_nach`) the edge's ATLAS direction text names. It must be the single best match, and no edge with coordinates may match it as well. Position is not used, because city points sit 5–25 m from the ATLAS points.

Result on 21 Nov 2026: **1 filled** (Bern, Untermattweg 02). **19 still have `lat: null`**, with `coord_source: null`. They are provisional, detour or dispatch edges ("Provisorium für Moonliner", "Für Fahrwegdispo", detour edges at Luisenstrasse/Thunplatz, Schliern provisional stops). Most have no PRM record and no direction text, and the city layer has no separate point for them. Treat them as "not a pole a passenger is sent to" and skip them on the map.

The two Mattelift stations, **Bern Matte (8500249)** and **Bern Münsterplattform (8500258)**, have no boarding edge in ATLAS. They are included as stops with `edges: []` and a stop-level `lat/lon` from the ATLAS service point (`coord_source: "atlas:service-point"`). Both points are the same, because the lift is vertical.

The old docs mention "34 edges without coordinates". Today's ATLAS export has 20 at Bern stops. Everything else is outside the bbox.

### Join with `platforms.js`

`platforms.js` (`window.PLATFORM_DATA.stops`, keyed by DiDok number, built by `tools/build_platforms.py` from the same ATLAS traffic-point export) joins on `String(stop.didok)`:

- stops: **387 / 387 (100%)** have an entry, including the two Mattelift stations (mode `c`);
- edges: **963 / 983** match a platforms.js edge, 328 by `ref` == `label` and 635 by position (< 10 m). The 20 that don't match are the 19 edges without coordinates plus Untermattweg 02, whose coordinate comes from the city layer (platforms.js only has ATLAS coordinates).

## `data/bern-stop-frequency.json`

```
{ generated, period_days: 364, source, stops: { "<didok>": {
    avg_departures_per_hour: number[24],   // index = hour of day, averaged over the timetable period
    peak_departures_per_hour: number,
    daily_departures_by_line: { "6 → Worb Dorf": 94, ... }
} } }
```

Keyed by DiDok number, like `platforms.js`. This counts scheduled departures, which is a proxy for service intensity. It is not measured crowding: no open source publishes per-stop ridership for Bernmobil. 381 of the 387 stops have departures. The other 6 have no regular timetable service: shuttles and replacement-bus stops (Europaplatz Süd, Kunstmuseum, Gümligen Seidenberg), the Gurten stops and Bern Fischermätteli (which has no means of transport in ATLAS).

## `data/offices.json`

```
{ generated, checked: "2026-11-21", source, items: Office[] }
Office = { id, name, category: "office"|"help"|"hotline", subtype, address, lat, lon, url, phone, note,
           verified: bool, checked: "2026-11-21", check_status, check_url? }
```

`check_status`: `ok` (the official page confirms the row), `updated` (changed to match the official page), `redirect` (the URL redirects to a page without the details), `blocked_403` (the site refuses scripted access), `not_checked` (no URL). `check_url` is the page actually used when it differs from `url`. Domestic-violence rows are hotlines only: **never add shelter addresses**.

On 21 Nov 2026, all 24 rows with a URL were fetched with a browser User-Agent. 23 returned HTTP 200 (4 of them after a redirect: be.ch/ava-kontakt, taxme.ch, isabern.ch) and 1 returned 403 (eda.admin.ch, IBWD). The result was 19 `ok`, 9 `updated`, 1 `redirect`, 1 `blocked_403` and 29 `not_checked`. Main changes:

- the victim-support hotline is also reachable as **142** since June 2026 (hallo-bern.ch);
- the RAV links now lead to a contact form, not opening hours;
- the Caritas-Markt address is confirmed;
- brocki.ch: phone and hours added; SVSA and Caritas Bern: hours added;
- Pluto: phone added.

## Rebuild

Node 24, no npm dependencies. bash with curl and unzip (Git Bash works).

```sh
bash tools/fetch-raw.sh        # ~165 MB into data/raw/ (gitignored); resolves current URLs via the opendata.swiss catalogue
node tools/build-bern-accessibility.mjs data/raw data/bern-stop-accessibility.json [data/official-places.json]
unzip -p data/raw/haltestellen_2026.zip haltestellen_2026/haltestellen26.csv \
  | node tools/build-bern-frequency.mjs data/bern-stop-accessibility.json data/bern-stop-frequency.json   # ~1 min
```

Both scripts assert on their output before writing (stop counts, period length, every stop locatable, unfilled edges marked). For a new timetable year, change `haltestellen_2026` in `fetch-raw.sh` and in the command above. The Overpass step falls back to `overpass.osm.ch` when `overpass-api.de` fails. Without `osm-bern-platforms.json`, the build still runs, but `edge.osm` is `null`.

## Sources and licences

- **opentransportdata.swiss** (ATLAS traffic-point-v2, service-point-v2, platform-v2, stop-point-v2, toilet-v2; BfR Rollstuhlzugänglichkeit; Halte an Haltestellen). Terms of use: https://opentransportdata.swiss/en/terms-of-use/. Free use, but attribution is required: **"Source: opentransportdata.swiss"**.
- **OpenStreetMap** platforms with `ref:sloid` (via Overpass). ODbL: credit **"© OpenStreetMap contributors"**.
- **Stadt Bern geoportal**, Haltestelle layer (via `data/official-places.json`). opendata.swiss terms_open: credit **"© Geodaten Stadt Bern"**.
- **`offices.json`**: facts are taken from the official pages listed in `url`/`check_url`. Coordinates come from the swisstopo SearchServer.
