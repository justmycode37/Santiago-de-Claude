# Street hazards, holidays and station lifts (Bern)

Four files in `data/`, bbox S,W,N,E = 46.9, 7.34, 46.99, 7.5. Not wired into the map yet.

Rebuild all four (Node 24, no npm deps, ~1 min): `node tools/build-streets.mts`. Each part is built independently; a failed part is reported, the others are still written, exit code 1. Every part runs `assert` self-checks (all coordinates inside the bbox, required properties present, privacy check on construction sites).

| File | Items (2026-11-21) | Size | Source | Licence |
|---|---|---|---|---|
| `data/street-slopes.geojson` | 4,569 LineStrings (3,981 of 4,013 source segments; 32 lie west of 7.34) | 1.4 MB | Stadt Bern geoportal `Strassensteigungen/MapServer/0` | opendata.swiss terms_open, © Geodaten Stadt Bern |
| `data/construction-sites.geojson` | 111 (40 construction sites + 71 installation areas) | 74 KB | Stadt Bern geoportal `Baustellen_2/MapServer/2` + `/1` | opendata.swiss terms_open, © Geodaten Stadt Bern |
| `data/holidays.json` | 20 public, 20 school | 4 KB | [OpenHolidays API](https://openholidaysapi.org), subdivision `CH-BE` | ODbL 1.0 |
| `data/station-lifts.json` | 163 (101 lifts, 35 escalators, 27 ramps) | 44 KB | OpenStreetMap via overpass.osm.ch | ODbL 1.0, © OpenStreetMap contributors |

## Street slopes

`FeatureCollection`, each feature a `LineString` (MultiLineStrings in the source are split, id gets `-0`, `-1`, ...), coordinates rounded to 6 decimals, Z dropped.
Properties: `{ id: "strassensteigung/<Objectid>", street, slope_pct (absolute, number), direction: "up_along_line" | "down_along_line" | null, class }`.
`direction` is the sign of the source's signed `Steigung` along the LineString's coordinate order.
`class`: `flat` < 3 %, `moderate` 3 to 6 %, `steep` > 6 to 10 %, `very_steep` > 10 %. Anything above 6 % is hard for a manual wheelchair.
Counts: flat 3,480, moderate 725, steep 258, very_steep 106.
The city says the slopes are computed automatically and have to be checked case by case. One value per street section, so a short steep ramp inside a long section is averaged away.

## Construction sites

`FeatureCollection` of `Polygon` / `MultiPolygon`. The task asked for points (layer 2) plus areas (layer 1), but both layers are polygons: layer 2 `Baustelle` is the construction site, layer 1 `Installationsplatz` is the site installation area (containers, cranes, storage) that also blocks pavements. `properties.center = [lon, lat]` gives a marker position.
Properties: `{ id: "baustelle/<permit no.>", kind: "construction_site" | "installation_area", title, description, street, start, end, end_unknown, status, impact_pedestrians, impact_traffic, center }`. Dates are `YYYY-MM-DD` in Europe/Zurich.
Kept: sites whose `end` is today or later. A site without an end date is kept with `end_unknown: true` (there are none today). 102 + 16 sites that already ended are dropped.
The source has no description and no pedestrian or traffic impact fields, so `description`, `impact_pedestrians` and `impact_traffic` are always `null`.

Privacy: the layers publish names, phone numbers and e-mail addresses of the client, site manager and inspector (`Bauherrschaft_*`, `Bauleitung_*`, `Baukontrolleur_*`). The script never requests those fields (`outFields` is an allowlist: `Objectid, Locality, Project, Startdate, Enddate, Displaynumber, Statustxt`). The client organisation (`Bauherrschaft_name`, e.g. "ewb", "SBB") is also left out, because some entries are private companies or people. Free-text title and street are scrubbed for e-mail addresses and Swiss phone numbers, and an assert fails the build if a personal field name or an e-mail address is in the output.

## Holidays

`{ generated, source, licence, note, public: [{ date, name_en, name_de }], school: [{ start, end, name, name_de, group }] }`, 2026-01-01 to 2027-12-31, dates inclusive.
`school[].group`: `CH-BE-VS` = Volksschulen (German-speaking public schools, the one that applies to Stadt Bern), `CH-BE-EO` = Écoles obligatoires (French-speaking part of the canton). A query for the City of Bern subdivision (`CH-BE-BM-BE`) gives the same list, so the API has no city-specific dates. The English school-holiday names come from the API as is (for example the winter break is called "Christmas").
Public holidays include the Federal Day of Prayer (always a Sunday) and Berchtold's Day (Berchtoldstag, a holiday in canton Bern).

## Station lifts, escalators and ramps

`{ generated, sources, counts, coverage, items: [{ id: "osm/<type>/<id>", kind: "lift" | "escalator" | "ramp", lat, lon, level, levels_connected, station_name, station_distance_m, wheelchair, operator, conveying, incline, indoor, source }] }`.
- OSM tags used: `highway=elevator` (lift), `conveying=*` (escalator or moving walkway), `ramp:wheelchair=yes` or `ramp=yes` on anything except `highway=steps` (ramp). Plain `ramp=yes` on steps is usually a pram or bicycle channel, so it is left out.
- Only features within 150 m of a stop are kept. Stops come from `data/official-places.json` (Stadt Bern `Haltestelle` + `Bahnhof`) plus OSM stations, platforms and bus stops for Köniz, Ostermundigen and Ittigen. `station_name` is the nearest stop, which is often a bus or tram stop next to the station (e.g. lifts at Bern main station are labelled "Schanzenstrasse" or "Bern Bahnhof").
- `levels_connected` is the raw OSM `level` split on `;` (strings, e.g. `["0","-1"]`). It is empty when OSM has no level. `wheelchair` is the raw OSM value, set on only 33 of the 101 lifts.
- `railway=platform` + `level` was not used: the output has no platform kind and the lift `level` already says which floors it connects.

Coverage (in `coverage`): **11 of 29 rail stations have at least one lift within 150 m**: Bern, Bern Europaplatz, Brünnen Westside, Bümpliz Nord, Felsenau, Ittigen RBS, Köniz, Tiefenau, Wabern, Wankdorf, Worblaufen. Stations are the Stadt Bern `Bahnhof` layer plus OSM `railway=station|halt`. Stations within 300 m of each other count as one (Europaplatz BLS and SBB are one). 38 of 477 distinct stop names have a lift nearby. Having no lift tells you nothing either way about step-free access. Weissenbühl and Bümpliz Süd have no lift but are step-free (`bfr.rail = step_free`). Liebefeld needs a booked boarding ramp. For step-free status per stop, use `data/bern-stop-accessibility.json`.

### SBB / opentransportdata.swiss lift data and lift status

Checked on 2026-11-21:
- data.sbb.ch (61 datasets): no lift, elevator, escalator or "Aufzug" dataset. A catalog search for `lift`, `aufzug`, `elevator`, `ascenseur`, `rolltreppe` and `escalator` returns 0 results.
- opentransportdata.swiss: no lift dataset in the catalog (searches for `aufzug`, `elevator` and `lift` only return OJP and cable cars). The ATLAS PRM datasets (stop point, platform, toilet, ...) have no lift objects.
- Lift outages: **we found no open, keyless lift-outage or elevator-status feed**. The SBB app shows lift outages, but its API is not published. OJP and the realtime APIs on opentransportdata.swiss need an API key and have no lift status. Lift status has to be treated as unknown, with a "lift may be out of service" warning.

## Known gaps

- Slopes and construction sites cover the City of Bern only. Köniz, Ostermundigen and Ittigen inside the bbox are not covered.
- Construction sites give no detour, pedestrian or traffic impact information.
- Lift coverage is only as good as OSM. Missing OSM lifts look the same as stations with no lift.
- overpass.osm.ch sometimes answers `duplicate_query` right after an aborted identical query. The script retries 3 times with a growing wait; if it still fails, wait a minute and rerun.
