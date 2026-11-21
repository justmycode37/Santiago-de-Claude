# Source extracts for the detail scene of Bern (Hirschengraben)

`tools/build_detail.py` reads these files and writes `stations3d/bern.detail.js` (format: `stations3d/DETAIL.md`).
The scene is the north head of the Hirschengraben: the walk from platform B to platform C of the tram stop
"Bern, Hirschengraben", past the Bubenberg monument (38 m), with everything within about 45 m of it.

All files except `osm.json` are already in the frame of the station model (`stations3d/SCHEMA.md`): metres around
`[7.4391, 46.9488]`, x east, y north; heights in metres relative to level 0 = 540.74 m above sea level (LN02).
`osm.json` is in longitude / latitude; the builder converts it with the formula of the schema.

| File | What | Source | Date | Licence / attribution |
| --- | --- | --- | --- | --- |
| `osm.json` | every tagged node, way and multipolygon in the box x −150 … −35, y −275 … −160 (222 elements): furniture, tram tracks, platforms, shelters, the monument, buildings with levels and roof tags, shops | OpenStreetMap, Overpass API (`overpass-api.de`) | data of 2026-11-21 12:07 UTC | ODbL 1.0, "© OpenStreetMap contributors" |
| `baumkataster.json` | the 20 city trees in the box: number, position, genus, German name, planting year | Baumkataster der Stadt Bern (Stadtgrün Bern), WFS `map.bern.ch/arcgis/services/Geoportal/Baumkataster/MapServer/WFSServer` | dataset modified 2026-11-19, downloaded 2026-11-21 | opendata.swiss "terms_open" (free use), "Geodaten Stadt Bern" |
| `survey.json` | ground cover polygons (road, pavement, traffic island, other paved area), building footprints, single objects (monument, shelters, walls, stairs) | Amtliche Vermessung der Stadt Bern (geodatabase from the city geoportal) | dataset modified 2026-11-18; the polygons used here were last changed between 2015 and 2026 | Nutzungsbedingungen Geodaten Stadt Bern 1.0 / opendata.swiss "terms_open", "Geodaten Stadt Bern" |
| `buildings3d.json.gz` | roof, wall and ground polygons of the 12 houses around the square (LoD2) | swisstopo swissBUILDINGS3D 3.0 Beta, CityGML tiles 1166-42 and 1166-24 | model state 2021 | swisstopo open data, "© swisstopo" |
| `lidar.json.gz` | 51,995 ground returns and 11,603 returns above the ground (unclassified and vegetation) in x −140 … −44, y −262 … −172, in centimetres | swisstopo swissSURFACE3D, tiles 2599-1199 and 2600-1199 | flown 2023, leaf-off, about 13 returns per m² | swisstopo open data, "© swisstopo" |
| `manual.json` | what was read by eye: which groups of LiDAR returns are hanging lamps and tram masts, which way the statue looks, two movable benches seen only on the aerial photo. Every entry says what was seen on which picture | Orthofoto 2026 der Stadt Bern (WMS `Geoportal/Orthofoto_2026`, flown March/April 2026, 10 cm), swisstopo SWISSIMAGE 10 cm 2024, Wikimedia Commons photo "Bern Hirschengraben 2024.jpg" | 2026-11-21 | the photos are used for checking only; nothing of them is in the scene |
| `visual-facts.json` | copy of `Santiago-de-Claude-research/showcase/imagery/visual-facts.json`: colours, storeys, shop fronts, lamp and bench types read from reference photos by another agent, each with its photo and a confidence | Wikimedia Commons photos and the two aerial photos (see `CREDITS.md` in that folder) | 2026-11-21 | facts only; merged with `source: "photo:<file>"` |
| `route.json` | the answer of `StationRoute.route(bern, {stop B}, {stop C})`, rewritten on every build that has node; used with `--no-node` | `station-route.js` on `stations3d/bern.js` | model built 2026-11-21 | – |

Not used: Google Maps, Street View or Google 3D tiles.

## How the extracts were made

`Santiago-de-Claude-research/showcase/scripts/extract_detail.py` cuts the raw downloads (in
`Santiago-de-Claude-research/sources/` and `showcase/data/`) to the box, converts LV95 to the model frame with pyproj
and writes the files here. To build a scene somewhere else, change the boxes at the top of that script and `SCENE` in
`tools/build_detail.py`.

Things to know about the sources:

- The tree register's WFS returns point geometries in WGS84 that lie 72 m east and 147 m north of the trees. The
  attributes `HKOORD` / `VKOORD` (LV95) are right; the extract uses those. The register has no heights or crowns.
- The LiDAR was flown without leaves: a tree gives 60 to 320 returns from its branches. Height is the highest return,
  the crown radius holds 90 % of the returns, the crown base is their 5th percentile. Trams, a lorry and skips that
  stood on the street during the flight are in the cloud; the builder only takes groups of returns that a photo
  confirms (see `manual.json`).
- swissBUILDINGS3D is the state of 2021. The houses on the square have not changed since; the Bubenberg-Zentrum north
  of Bubenbergplatz was rebuilt (finished 2025) and is outside the scene.
- The cadastral survey has no kerb heights. A kerb is the line where a pavement, island or square polygon meets a
  road polygon; its height is the difference of the LiDAR ground on both sides.

## What the builder measures, and what it does not know

Measured: ground heights (every surface from the ground returns on that surface), kerb heights (58 of 65 pieces; the
other 7 take the height of their neighbours on the same kerb because a tram or a skip covered them), tree heights,
crown radii and crown bases, the monument (plinth outline from the survey; height, plinth height and the step of its
base from the LiDAR), shelter heights, lamp heights, house footprints, eaves, ridges and roof shapes.

From tags or photos: surface materials (OpenStreetMap, photos), species and planting year (register), storeys
(OpenStreetMap; where a photo count of high or medium confidence differs, the photo count is used and the
OpenStreetMap value is kept as `floorsOsm`), shop ground floors (OpenStreetMap shop nodes, photos), colours (photos).

Left out because no source gives them: trunk diameters, bench sizes on the platform, the sizes of bins, hydrants and
ticket machines, house colours on the east side north of Hirschengraben 7, window bays, the poster stands and bike
racks around the monument, the overhead wires themselves.
