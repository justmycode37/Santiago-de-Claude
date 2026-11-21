# Source extracts for the detail scene of Bern (Hirschengraben)

`tools/build_detail.py` reads these files and writes `stations3d/bern.detail.js` (format: `stations3d/DETAIL.md`)
and the manifest `stations3d/detail-index.js` (which station has a scene, and the bounding box of its `area`).

The scene is the whole Hirschengraben with the streets around it: model x −150 … −38, y −338 … −160, from the north
pavement of Bubenbergplatz to the south side of Bundesgasse, with the houses within 26 m of that area. The walk it
is made for is the one from platform B to platform C of the tram stop "Bern, Hirschengraben", past the Bubenberg
monument (38 m), asked from the app's router.

**Heights.** Every height in the scene is a real height in metres above level 0 of the station model (540.74 m above
sea level, LN02). The real ground slopes: it falls 2.4 cm per metre to the south and 0.8 cm per metre to the west.
The station model draws this square flat on level 0. The scene carries the plane that fits its ground
(`groundPlane`: `z = 0.594 + 0.00793·(x + 85.43) + 0.02448·(y + 203.97)`, rms 0.24 m; `groundPlane.nearWalk` is the
plane within 40 m of the walk, rms 0.20 m) and `zOffset = −0.80 m`, the one number that sets the scene on the model
at the walk. With `zOffset` the two ends of the walk come to −0.15 m (platform B) and −0.05 m (platform C) relative
to the model floor. The first entry of the scene's `notes` says the same.

All files except `osm.json.gz` are already in the frame of the station model (`stations3d/SCHEMA.md`): metres around
`[7.4391, 46.9488]`, x east, y north. `osm.json.gz` is in longitude / latitude; the builder converts it.

| File | What | Source | Date | Licence / attribution |
| --- | --- | --- | --- | --- |
| `osm.json.gz` | every tagged node, way and multipolygon in the box x −195 … 0, y −390 … −100: furniture, tram tracks, shelters, the monument, the fountain, buildings with levels and roof tags, shops | OpenStreetMap, Overpass API (`overpass-api.de`) | data of 2026-11-21 12:07 UTC | ODbL 1.0, "© OpenStreetMap contributors" |
| `baumkataster.json` | the city trees in the box: number, position, genus, German name, planting year | Baumkataster der Stadt Bern (Stadtgrün Bern), WFS `map.bern.ch/arcgis/services/Geoportal/Baumkataster/MapServer/WFSServer` | dataset modified 2026-11-19 | opendata.swiss "terms_open" (free use), "Geodaten Stadt Bern" |
| `survey.json.gz` | ground cover polygons (55), building footprints (50, each with the LiDAR 2023 returns inside it), one projected building, single objects (monument, shelters, fountain, walls, stairs) | Amtliche Vermessung der Stadt Bern (geodatabase from the city geoportal) | dataset modified 2026-11-18 | Nutzungsbedingungen Geodaten Stadt Bern 1.0 / opendata.swiss "terms_open", "Geodaten Stadt Bern" |
| `buildings3d.json.gz` | roof, wall and ground polygons of the houses in the box (LoD2) | swisstopo swissBUILDINGS3D 3.0 Beta, CityGML tile 1166-42 (tile 1166-24 has nothing here) | model state 2021 | swisstopo open data, "© swisstopo" |
| `lidar.json.gz` | ground returns in x −162 … −26, y −348 … −148 (every return within 50 m of the walk, one point per 0.5 m cell elsewhere: 111,627 points) and 33,989 returns above the ground (unclassified and vegetation), in centimetres | swisstopo swissSURFACE3D, tiles 2599-1199 and 2600-1199 | flown 2023, leaf-off, about 13 returns per m² | swisstopo open data, "© swisstopo" |
| `manual.json` | what was read by eye, each entry with what was seen on which picture: which groups of LiDAR returns are hanging lamps, tram masts and posts (and which were looked at and rejected), one span wire, which way the statue looks, two movable benches, storeys and names of five houses, details of six house fronts, 16 ground markings | Orthofoto 2026 der Stadt Bern (WMS `Geoportal/Orthofoto_2026`, flown March/April 2026, 10 cm), swisstopo SWISSIMAGE 10 cm 2024, Wikimedia Commons photos of 2022 and 2024, two web pages about the new Bubenbergzentrum | 2026-11-21 | facts and positions only |
| `visual-facts.json` | copy of `Santiago-de-Claude-research/showcase/imagery/visual-facts.json`: colours, shop fronts, lamp and bench types read from reference photos by another agent, each with its photo and a confidence | Wikimedia Commons photos and the two aerial photos (see `CREDITS.md` in that folder) | 2026-11-21 | facts only; merged with `source: "photo:<file>"` |
| `route.json` | the answer of `StationRoute.route(bern, {stop B}, {stop C})`, rewritten on every build that has node; used with `--no-node` | `station-route.js` on `stations3d/bern.js` | model built 2026-11-21 | – |

Not used: Google Maps, Street View or Google 3D tiles.

## How the extracts were made

In `Santiago-de-Claude-research/showcase/scripts/`: `av_ext.py` (cuts the survey geodatabase), `prep_lidar_ext.py`
(cuts the LiDAR tiles), `scripts/citygml_clip.py` + `scripts/enrich/parse_citygml.py` (cut and parse the building
model), then `extract_detail.py` converts everything to the model frame and writes the files here. To build a scene
somewhere else, change the boxes at the top of those scripts and `SCENE` in `tools/build_detail.py`.

Things to know about the sources:

- The tree register's WFS returns point geometries in WGS84 that lie 72 m east and 147 m north of the trees. The
  attributes `HKOORD` / `VKOORD` (LV95) are right; the extract uses those. The register has no heights or crowns.
- The LiDAR was flown without leaves. Height is the highest return of a tree, the crown radius holds 90 % of its
  returns, the crown base is their 5th percentile. Trams, lorries and skips that stood on the street during the
  flight are in the cloud; the builder only places groups of returns that a photo confirms (`manual.json`).
- swissBUILDINGS3D is the state of 2021. The house at Bubenbergplatz 10–12 was pulled down and rebuilt since
  (finished 2025): the LiDAR of 2023 shows a pit there. The scene has the new house as a prism with the outline and
  the height (22.5 m, roof at 564.85 m) the survey gives for the projected building; its number of floors (8) is
  from a web page and its front is not known.
- The survey has no kerb heights. A kerb is the line where a pavement, island or square polygon meets a road
  polygon; its height is the difference of the LiDAR ground on both sides.

## What is measured, estimated and left out

Measured: ground heights, kerb heights (190 of 202 pieces; 12 take the height of their neighbours on the same kerb
because a vehicle covered them), tree heights and crowns (43 of 45), the monument, the fountain roof and the
shelters, lamp and mast heights, house footprints, eaves, ridges and roof shapes (27 houses with their roof mesh).

Estimated, and marked so in the scene: the new Bubenbergzentrum (height as projected, floors from a web page), four
houses far from the walk drawn as prisms, the level height of the one span wire (given level with its lamp), the
width of the lane lines, the extent of one pedestrian crossing a bus stood on, the heading of three bicycle
symbols without a readable arrow, the white of one awning.

From tags or photos: materials (OpenStreetMap, photos), species and planting year (register), storeys
(OpenStreetMap; for five houses counted on a photo, see `manual.json` — the storey counts of `visual-facts.json`
are not used because they include the mansard), shop ground floors, colours.

Left out because no source gives them: trunk diameters, sizes of benches, bins, hydrants and machines, window bays
of all but one front, colours of most houses, poster stands and bike racks, the overhead tram wires and all span
wires but one, lane lines and arrows on the roadways away from the head of the square, 36 small groups of LiDAR
returns that no photo explains.

## Fields beyond `stations3d/DETAIL.md`

Top level: `route`, `zOffset`, `groundPlane { origin, z, dzdx, dzdy, rms, nearWalk { within, z, dzdx, dzdy, rms } }`,
`markings` (the renderer's shapes: `bike-symbol` / `arrow` with `xy`, `heading`; `lane-line` with `line`, `width`,
`dash`, `color`; `crossing` with `ring`, `heading`), `sources`, `notes`.
Surfaces: `use`, `color`, `variant`, `gauge`, `line`. Edges: `heightSource`, `variant`.
Trees: `speciesDe`, `planted`, `form`. Props: kind `ticket-machine`; `ring`, `axis`, `plinthHeight`, `plinthColor`,
`color`, `material`, `year`, `artist`, `mount`, `capacity`, `temporary`, `heightSource`, and on a hanging lamp
`wire: [[x, y, z], [x, y, z]]`.
Buildings: `egid`, `roofFloors`, `floorsOsm`, `floorsSource`, `heightSource`, `rebuilt`, `photoRef`, `facadeNote`;
a building without `mesh` is a prism (`ring`, `base`, `eaves`, `ridge`, `roof`).
Faces: `heading`, `windows { bays, floors }`, `bayWindows [{ bay, floors: [first, last] }]`,
`balconies [{ bay | at, floor }]`, `style: "townhouse"`, `awnings { color, pattern }`,
`signs [{ text, orientation, at, colors }]`, `gable`, `flags`, `source`.
