# Accessibility and crowding data for Bern stops

Research notes from Fri night, 20–21 Nov 2026. Everything here was checked against the live data unless it is marked **[VERIFY]**.

## TL;DR

- **"How hard is it to board?" is well covered by official data, per stop edge (Haltekante), so per side of the road.** ATLAS PRM data gives platform height, ramp/assistance needs, tactile guidance and the type of passenger information. The BfR dataset gives an official wheelchair verdict per edge. 948 of 963 Bern edges have PRM data.
- **"How hard is it to reach?" is covered by OSM, not by official data.** Bern's OSM is detailed: lowered kerbs, crossings with acoustic/vibrating signals, tactile paving, shelter, bench, lighting. OSM platforms carry `ref:sloid`, so they join 1:1 to the official edges.
- **"How crowded?" has no open data for trams or buses.** The occupancy forecasts cover trains only (SBB, BLS, SOB, Thurbo, zb). For Bernmobil we have scheduled departures per hour per stop (computed), and yearly ridership for rail stations only.
- **This links to the right-side challenge:** in Bern, **32 stops have one side step-free and another side not**. Bärenplatz, Viktoriaplatz and Inselplatz are among them. "Stand on the right side" can also mean "your side has a 0 cm kerb, so book a ramp."
- **Bonus for the edge-selection algorithm:** `compassDirection` is the **vehicle heading** at that edge. At Pestalozzi the edge toward Bahnhof is 45° (NE) and the edge toward Fischermätteli is 227° (SW). 682 of 963 Bern edges have it. 690 also have a free-text direction such as *"Tramlinie 6 Richtung Bern Bahnhof."*

## 1. Boarding difficulty: official data (ATLAS PRM + BfR)

Cookbook: https://opentransportdata.swiss/en/cookbook/accessibility-cookbook/ · Licence: opentransportdata.swiss terms of use (free use with attribution).

| Dataset | Level | Useful fields |
|---|---|---|
| [platform-v2](https://data.opentransportdata.swiss/dataset/platform-v2) "Stop places – Accessibility" | **edge** | `vehicleAccess`, `height` (cm), `inclination*` (%), `wheelChairAreaLength/Width` (cm), `shuttle`, `tactileSystems`, `attentionField`, `infoOpportunities`, `dynamicAudio/Visual`, `additionalInformation` (direction text) |
| [stop-point-v2](https://data.opentransportdata.swiss/dataset/stop-point-v2) "Stops – Accessibility" | stop | `assistanceAvailability`, `ticketMachine`, `freeText` |
| [bfr-rollstuhlzuganglichkeit](https://data.opentransportdata.swiss/dataset/bfr-rollstuhlzuganglichkeit) | **edge** + vehicle | official wheelchair status, separate for rail-bound vehicles (tram) and buses, plus low-floor vehicles per line |
| [toilet-v2](https://data.opentransportdata.swiss/dataset/toilet-v2), [contact-point-v2](https://data.opentransportdata.swiss/dataset/contact-point-v2), [parking-lot-v2](https://data.opentransportdata.swiss/dataset/parking-lot-v2) | object | wheelchair toilet, accessible ticket desk, disabled parking |
| [reference-point-v2](https://data.opentransportdata.swiss/dataset/reference-point-v2) + [relation-v2](https://data.opentransportdata.swiss/dataset/relation-v2) | path | step-free / tactile path from the entrance to each platform. **Rail stations only** (26 in greater Bern, e.g. Bern, Wankdorf, Europaplatz). None at Bernmobil stops. |

**`vehicleAccess` values** (Bern edges): `PLATFORM_ACCESS_WITHOUT_ASSISTANCE` 174 · `PLATFORM_ACCESS_WITH_ASSISTANCE` 362 · `PLATFORM_NOT_WHEELCHAIR_ACCESSIBLE` 324 · `…_WHEN_NOTIFIED` (book ahead) · `TO_BE_COMPLETED` 5 · missing 15.

**BfR status legend** (from `bfr_kombinationslogik.csv`): 1 step-free · 2 ramp, no booking · 3 ramp, booking needed · 4 replacement transport · 5 not accessible · 0 no info.

**Platform height** in Bern: 0 cm on 128 edges, 1–15 cm on 454, 16–21 cm on 108, 22–26 cm on 136, 27 cm or more on 28. As a rule of thumb, 22 cm (bus) and 27 cm (tram) are the BehiG level-boarding heights. **[VERIFY]** the exact thresholds with a domain mentor before showing them as fact.

## 2. Reaching the stop: OSM

Bern's OSM data is unusually complete. Around Pestalozzi alone it has lowered kerbs (`barrier=kerb` + `kerb=lowered`), crossings with `traffic_signals:sound` / `traffic_signals:vibration` / `button_operated`, `tactile_paving`, sidewalk `width`, `surface` and `smoothness`.

Platform tags we merged into the dataset (223 Bern platforms with `ref:sloid`, 211 matched to edges): `shelter` (103 yes / 114 no), `bench` (146 / 67), `lit`, `tactile_paving`, `wheelchair` (123 yes / 95 limited / 4 no), `departures_board` (realtime/timetable), `passenger_information_display:speech_output`.

OSM `wheelchair` and ATLAS agree on 142 of 211 edges. Most disagreements are OSM `yes` vs ATLAS `WITH_ASSISTANCE` (driver ramp). That's a difference in definition, not an error. **Use ATLAS for the verdict and OSM for comfort and wayfinding.**

The walking route to the stop isn't precomputed. Options: a step-free footway route over the OSM graph (e.g. OpenRouteService `wheelchair` profile, or GraphHopper), or OJP 2.0 trip parameters for mobility needs. **[VERIFY]** which OJP 2.0 `TripParams` (e.g. level entrance, no stairs) are honoured for Bernmobil.

Overpass (overpass-api.de) returned 502 most of the night. Prefetch the data, and don't call Overpass live in the demo.

## 3. Crowding: what exists

| Source | Covers | Granularity | Verdict |
|---|---|---|---|
| [Occupancy forecast JSON/SIRI](https://data.opentransportdata.swiss/dataset/occupancy-forecast-json-dataset) | Trains of operators 11 SBB, 33 BLS, 65, 82, 86 zb | per train section, 3 days ahead (`manySeatsAvailable` / `fewSeatsAvailable` / `standingRoomOnly`) | Good for trains. **No Bernmobil.** The zip is 136 MB and unpacks to 5 GB; use the API instead |
| transport.opendata.ch `/stationboard` | same trains | `capacity1st/2nd` 1–3 | Already in the API we may use. `null` for trams and buses (checked live at Pestalozzi) |
| OJP 2.0 | same trains | `ExpectedDepartureOccupancy` | **[VERIFY]** with the key; probably trains only |
| [SBB passagierfrequenz](https://data.sbb.ch/explore/dataset/passagierfrequenz/) | rail stations | yearly averages per day, weekday and weekend (Bern 2025: 177,000/day) | Station-level context only |
| [Halte an Haltestellen](https://data.opentransportdata.swiss/dataset/halte-an-haltestellen) | **every stop incl. Bernmobil** | every scheduled trip with `FAHRTAGE` = number of days it runs | We aggregated this to **avg departures per hour per stop** (proxy for busyness and waiting time) |
| Bernmobil passenger counts | none published (only Basel BVB publishes theirs) | | Ask Parveen or mentors whether Bernmobil would share any |

**An honest crowding feature** for trams and buses would combine three things:
1. Scheduled departures/hour, as a **busyness proxy** and as **"if this one is full, the next comes in N min"**.
2. Known hubs (Bahnhof 189 dep/h, Hirschengraben 138, Zytglogge 134).
3. Rush-hour time windows.

Label the result *estimate*. Optionally add a **crowd-sourced "it's full / I couldn't board" report**. That's also a credible AI angle: the LLM explains the estimate in plain language and never claims to measure it.

## 4. Case study: Pestalozzi (the venue's stop)

| | Edge 01 → Fischermätteli | Edge 02 → Bern Bahnhof |
|---|---|---|
| Heading (`compassDirection`) | 227° (SW) | 45° (NE) |
| Pole text (ATLAS) | "Tramlinie 6, Buslinie M80 Richtung Fischermätteli." | "Tramlinie 6 Richtung Bern Bahnhof." |
| Wheelchair (ATLAS) | **not wheelchair accessible**, 0 cm kerb, shuttle needed | **not wheelchair accessible**, 0 cm kerb, shuttle needed |
| BfR status | replacement transport (tram and bus) | replacement transport |
| Shelter / bench (OSM) | none / none | yes / yes |
| Departure info | static timetable only | realtime display **with speech output** |
| Tactile paving | no | entrance only |

Trams: ~11 departures/hour (both directions) from 06:00 to 21:00. Toward town, the tram front says **"Worb Dorf"** (94 of ~100 daily departures in that direction), not "Bahnhof". The terminus trap the brief describes is confirmed.

**The whole tram 6 corridor near the venue is inaccessible.** Munzinger, Cäcilienstrasse, Brunnhof and Fischermätteli are all `PLATFORM_NOT_WHEELCHAIR_ACCESSIBLE` with 0–16 cm kerbs. The nearest step-free options, as straight-line distance from Pestalozzi:

| Distance | Stop / edge | Line → direction | Height | BfR |
|---|---|---|---|---|
| ~480 m | **Dübystrasse 02** | bus 10 / M81 → Bern Bahnhof | 22 cm | step-free |
| ~445 m | Dübystrasse 01 | bus 10 / M81 → Köniz Schliern | 22 cm | step-free |
| ~510–530 m | Loryplatz A / B | tram 7, 8 → Bahnhof / Bümpliz | 27 cm | step-free |
| ~570 m | Eigerplatz A | tram 3, bus 10 → Bern Bahnhof | 27 cm | step-free |

**Demo line:** *"The stop outside this building has a 0 cm kerb on both sides. Official data says a wheelchair user needs replacement transport. Our app tells you that before you leave home: take bus 10 from Dübystrasse, 480 m away, which is step-free toward the station."* **[VERIFY]** the walking route to Dübystrasse (kerbs, slope) on OSM or on foot. Someone should also look at both Pestalozzi kerbs in person.

## 5. Stops where the side of the road changes accessibility

32 of 385 Bern stops have at least one step-free edge and at least one edge that isn't. Busiest first:

- **Bärenplatz**: edges 01/02 at 24 cm, step-free · 04/13 at 5 cm, not accessible
- **Viktoriaplatz**: A/B at 27 cm, step-free · C (8 cm) / D (13 cm), not accessible
- **Eigerplatz**: A/B at 27 cm, step-free · C with assistance · D not accessible
- **Inselplatz** (near the hospital): A/C/D at 22 cm, step-free · **B at 0 cm, not accessible**
- **Loryplatz, Kocherpark, Köniz Brühlplatz, Europaplatz, Bethlehem Kirche, Wabern Gurtenbahn, Breitenrain, …**

Run this to get the full list:
```
node -e "const d=require('./data/bern-stop-accessibility.json');const ok=e=>e.access?.vehicle_access==='PLATFORM_ACCESS_WITHOUT_ASSISTANCE';d.stops.filter(s=>s.edges.some(ok)&&s.edges.some(e=>e.access&&!ok(e))).forEach(s=>console.log(s.name))"
```

## 6. Feature ideas this data supports

1. **Accessibility badge on the pole screen** (after edge selection): "Level boarding ✓", "Ask the driver for the ramp", or "Not accessible: book replacement transport". It comes straight from `vehicleAccess` + BfR for *your* edge.
2. **Waiting comfort:** shelter, bench, lighting and realtime display for *your* side. This matters for elderly people, people with chronic illness and pregnant users, as well as wheelchair users.
3. **Blind / low-vision mode:** read-aloud instructions, plus "this side has a talking departure board" (`speech_output`) and "the crossing before the stop has an acoustic signal" (OSM).
4. **Step-free alternative:** if your edge isn't accessible, suggest the nearest stop on the same line and direction that is.
5. **Busyness estimate and "next tram in N min"** from the frequency data, clearly labelled as an estimate.
6. **AI usage:** the LLM turns the structured fields into one plain sentence in the user's language, e.g. *"This stop has no raised kerb. The driver can't use the ramp here. The next stop, 300 m away, is step-free."* Facts stay in code.

## 7. Caveats

- PRM data quality depends on each operator's survey. `TO_BE_COMPLETED` and empty values exist. Show "no data" rather than guess.
- `additionalInformation` is free text in German. Use it for display and translation, not as a primary key.
- The frequency data is the **planned** timetable for 2026 (364 days, averaged). It hides weekday vs weekend differences, and the hourly profile is flat because it's an average.
- OSM is ODbL: attribute "© OpenStreetMap contributors".
- The City of Bern geoportal (map.bern.ch) blocked scripted access on 20 Nov; its ArcGIS REST endpoints do work (see `data/official-places.json`), and its Haltestelle layer is now used to fill missing edge coordinates.

## Files

- `data/bern-stop-accessibility.json` (rebuilt 21 Nov 2026): 387 stops / 983 edges in greater Bern (bbox 46.90–46.99 N, 7.34–7.50 E). Each edge has coords (19 provisional edges have none, see [data-transit-access.md](data-transit-access.md)), compass, direction text, the ATLAS `access` block, BfR status and OSM comfort tags.
- `data/bern-stop-frequency.json`: per stop (key = DiDok number, e.g. `8590012`): `avg_departures_per_hour[24]`, `peak_departures_per_hour`, `daily_departures_by_line` ("6 → Worb Dorf": 94).
- `tools/fetch-raw.sh`: downloads the raw sources to `data/raw/` (gitignored, ~165 MB).
- `tools/build-bern-accessibility.mjs`, `tools/build-bern-frequency.mjs`: rebuild the JSON files (commands are in each file's header).
