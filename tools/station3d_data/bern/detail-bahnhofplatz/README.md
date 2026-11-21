# Source extracts for the detail scene of Bern (Bahnhofplatz)

`tools/build_detail.py --scene bahnhofplatz` reads these files and writes `stations3d/bern.bahnhofplatz.detail.js`
(scene id `bern.bahnhofplatz`, format: `stations3d/DETAIL.md`). `--scene all --index-form array` also writes the
manifest `stations3d/detail-index.js` with both scenes of Bern. The files are made like those of the first scene
(`../detail/README.md`); only what differs is written here.

The scene is the tram stop "Bern, Bahnhof" under the Baldachin, the Heiliggeistkirche, the east front of the
Burgerspital and the square in front of the station: model x 30 … 170, y −175 … −33, with the houses within 26 m of
that area. The walk it is made for goes from tram platform B under the Baldachin and over the yellow pedestrian
crossing to the pavement in front of the main entrance of the station (104 m), asked from the app's router
(`{stop: {uic: '8576646', ref: 'B'}}` to `{xy: [75.8, −38.9], level: 0}`).

**The station front.** The area ends at y −33, 0.6 m south of the southernmost corner of the station building
(y −33.58). The station building is not in the scene (`skip_buildings` in `SCENES`): it stays the plain station
model's, whose shell is the front the walk arrives at. Between y −33 and the station front (8 m at the end of the
walk) the ground is the plain model's.

**Heights.** As in the first scene: real heights in metres above level 0 of the station model. The ground rises
0.9 cm per metre to the south. `groundPlane`: `z = 0.934 + 0.00083·(x − 95.74) − 0.00860·(y + 86.17)`, rms 0.21 m;
`groundPlane.nearWalk` (within 40 m of the walk) rms 0.18 m; `zOffset = −1.10 m`. The walk falls 1.1 m from the tram
platform (1.43 m) to the pavement in front of the station (0.33 m).

| File | What | Source | Date | Licence / attribution |
| --- | --- | --- | --- | --- |
| `osm.json.gz` | every tagged node, way and multipolygon in the box x 0 … 205, y −205 … 0 | OpenStreetMap, Overpass API | data of 2026-11-21 | ODbL 1.0, "© OpenStreetMap contributors" |
| `baumkataster.json` | the city trees in the box | Baumkataster der Stadt Bern, WFS | dataset modified 2026-11-19 | opendata.swiss "terms_open", "Geodaten Stadt Bern" |
| `survey.json.gz` | ground cover polygons, building footprints with the LiDAR returns inside them, single objects (the outline of the Baldachin and of three shelters as "Unterstand", 80 pillars "Pfeiler", stairs, walls) | Amtliche Vermessung der Stadt Bern (geodatabase) | dataset modified 2026-11-18 | Nutzungsbedingungen Geodaten Stadt Bern 1.0, "Geodaten Stadt Bern" |
| `buildings3d.json.gz` | roof, wall and ground polygons of the houses in the box (LoD2) | swisstopo swissBUILDINGS3D 3.0 Beta, CityGML tile 1166-42 | model state 2021 | swisstopo open data, "© swisstopo" |
| `lidar.json.gz` | ground returns in x 18 … 182, y −187 … −14 (every return within 50 m of the walk, one per 0.5 m cell elsewhere: 127,442 points), 21,166 returns above the ground (unclassified and vegetation), and `roofs`: the 14,490 returns of any class on the roofs of the survey's "Unterstand" outlines (the glass of the Baldachin is classified as building) | swisstopo swissSURFACE3D, tiles 2599-1199 and 2600-1199 | flown 2023 | swisstopo open data, "© swisstopo" |
| `manual.json` | read by eye: 6 ground markings (the two yellow pedestrian crossings, a white guide line, a bicycle symbol with its arrow), each with what was seen on which picture | Orthofoto 2026 der Stadt Bern (10 cm crop and 25 cm overview) | 2026-11-21 | facts and positions only |
| `route.json` | the router's answer for the walk, rewritten on every build that has node | `station-route.js` on `stations3d/bern.js` | 2026-11-21 | – |

Not used: Google Maps, Street View or Google 3D tiles. There is no `visual-facts.json` here: the facts another agent
read from photos of this place (`also_collected_bahnhofplatz` in the research folder) are not merged.

## How the extracts were made

In `Santiago-de-Claude-research/showcase/scripts/`: `av_ext_bahnhofplatz.py` (cuts the survey geodatabase to LV95
2600030 … 2600245 / 1199535 … 1199750), then `extract_detail_bahnhofplatz.py <this folder>` (a copy of
`extract_detail.py` with the boxes of this scene; it reads the LiDAR and the building model of the whole station
area, `cache/lidar_local.npz` and `cache/sb3d.pkl`). `crop_model.py` cuts an aerial photo to a box in model
coordinates and draws a model grid on it; the markings were read from such crops.

## What is measured, estimated and left out

Measured: ground heights (robust plane through the LiDAR returns on each surface, see the builder), kerb heights
(168 of 211 pieces, up to 0.17 m; along the walk the tram platforms stand 0.15 to 0.26 m above the tracks), the outline of the Baldachin (survey), the height
of its edge and top (LiDAR on the glass: 3.6 to 9.6 m at the edge, 10.3 m at the top, above the ground under it),
its 12 columns (the survey's pillars under the roof), the three shelters, 12 trees with height and crown, house
footprints, eaves, ridges and roofs (18 houses with their roof mesh, among them the Heiliggeistkirche with its tower
and the Burgerspital).

Estimated, and marked so in the scene: the lift house under the Baldachin (outline: the larger of the two parts the
survey draws as "übriger Gebäudeteil"; that it is a house, its height of 3 m and "red" are OpenStreetMap tags, the
LiDAR does not see it under the glass; the exact red is assumed); 34 kerb pieces take the height of their neighbours and 9 are assumed 0.10 m
(under the Baldachin and under vehicles the LiDAR has too few ground returns); 15 houses far from the walk are
prisms (16 with the lift house); where the LiDAR has no ground return at all (the middle of the Baldachin) the ground is the plane of the
returns within 15 m, so the tram platforms there lie level with the roadway and only their kerbs show the step; the
underside of the glass roof is not measured (the returns are from its surface); the north half of the crossing on
the walk is read from the 25 cm photo (0.8 m); the white guide line is drawn as one band.

From tags: materials, storeys and shop ground floors (OpenStreetMap), species and planting years (register).

Left out:
- the station building (the plain model has it) and everything north of y −33;
- **lamps, tram masts, span wires and the overhead wires**: 65 small groups of LiDAR returns in the area were not
  looked at on the photos (no time), so none is placed;
- **the stairs and escalators down to the Christoffel underpass under the Baldachin**: the survey has the stairs as
  lines and the LiDAR shows the openings (184 "ground" returns more than 1 m under the street are not used for the
  ground); the scene has closed ground there, and no glass fence around them. The plain station model has these
  stairs, and they lie inside the box of the scene;
- benches, bins and ticket machines further than 40 m from the walk; the stop posts and departure boards;
- lane lines, stop lines and the "BUS" lettering on the roadways, the cycle lane lines;
- colours, storeys and fronts read from photos (no `visual-facts.json`, no house entries in `manual.json`): the
  church and the Burgerspital have the builder's default wall and roof colours;
- sizes of benches, bins and machines, trunk diameters.

## Fields beyond `../detail/README.md`

Props: kind `canopy` with `ring`, `z` (ground under it), `height` (median height of the roof edge above the ground),
`rise` (top above that), `columns` `[[x, y], …]`, and, beyond what the renderer needs: `edgeHeights` (height of the
roof edge above the ground at every point of `ring`), `columnHeights` (roof above each column), `name`, `variant`,
`heightSource`.
