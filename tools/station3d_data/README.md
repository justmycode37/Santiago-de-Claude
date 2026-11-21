# Open-data layers for the station models

`tools/build_station3d.py` reads these files when it builds `stations3d/<key>.js` (one folder per station key).
A model is built without a layer that is missing; the builder prints which. `--data DIR` points it at another folder.

All files are in the frame of the model (`stations3d/SCHEMA.md`): local metres around the station's origin, x east,
y north. Heights are metres relative to level 0.

| File | What | Used for | Source | Attribution in the model |
| --- | --- | --- | --- | --- |
| `bern/heights.json` | 52 measured heights around Bern station; zero = surface of the SBB platforms, 540.74 m above sea level (LN02) | level table (in the builder's station table) and the spot heights of the streets | swisstopo swissSURFACE3D and swissBUILDINGS3D 3.0; cadastral survey of the City of Bern (fixed points) | `© swisstopo`, `Geodaten Stadt Bern` |
| `bern/shell_mesh.json` | roofs and walls of 9 key structures, 2,541 triangles | `shellMesh` | swisstopo swissBUILDINGS3D 3.0 (LoD2) | `© swisstopo` |
| `bern/shell.geojson` | footprints with base and top of 45 buildings and structures (WGS84) | heights of the neighbouring buildings in `shell` | swisstopo swissBUILDINGS3D 3.0, LiDAR | `© swisstopo` |
| `bern/platform_edges.geojson` | one line per track along the platform kerb, 1 m points (WGS84); track 3 coarse, track 4 only its western 179 m, no 11 and 21–24 | check of the platform outlines, sector spans along curved kerbs, extending platforms that OSM draws short | SBB open data | `data.sbb.ch` |
| `<key>/sectors.json` | sector centres per track: `{ ref, name, xy }` | `sectors` | SBB open data (sector boards, platform edges) | `data.sbb.ch` |
| `<key>/spans.json` | from–to of each sector along the platform edge | `sectorSpans`, heading of the sector signs | SBB open data | `data.sbb.ch` |
| `<key>/boards.json` | the sector boards themselves (position, letters on both faces, how they are mounted) | `props` (`sector-sign`) | SBB open data | `data.sbb.ch` |
| `<key>/furniture.json` | clocks and ticket machines (no level in the source; `level` is set by hand in the files of `bruennen` and `buempliz-nord`, see below) | `props` (`clock`, `ticket-machine`) | SBB open data | `data.sbb.ch` |

Licences: all three sources are open data that may be used in a public app when the source is named with the
strings in the last column (as recorded in the README of the research folder the files come from). Check the terms
of use of swisstopo, the City of Bern and data.sbb.ch before using the files for anything else.

Where they come from in this project: `heights.json` and `shell_mesh.json` are copies of the files in
`Santiago-de-Claude-research/enrich/` (its README has fields, methods and known problems; built 2026-11-21 by
`scripts/enrich/`). The sector, span, board and furniture files are copies of
`Santiago-de-Claude-research/reuse/<key>.*.json` (built by `reuse/tools/extract_sectors.py` and
`extract_furniture.py` with the origins `7.4391, 46.9488` for `bern` and `7.4655, 46.9672` for `wankdorf`).

`bruennen/furniture.json` (2 clocks, 2 ticket machines) and `buempliz-nord/furniture.json` (4 clocks, 2 ticket
machines) were made on 2026-11-21 with the same `extract_furniture.py` from the station files of
`Santiago-de-Claude-research/bern-transit-3d/bern-research/stations/data/focus/` (origins `7.3752, 46.9440` and
`7.3900, 46.9459`). Neither station has sector boards in the SBB data. Their `level` was then set by hand, because
the rule below picks the wrong floor for two of the ten pieces: at Brünnen Westside all four are on the train
platforms (level 1; both ticket machines are BLS machines and lie within 3.5 m of the two BLS machines OSM has on
platforms 1 and 2, and both clocks lie on the outlines of the train platforms; one machine also lies on the outline
of the tram platform drawn below platform 1), at Bümpliz Nord all six are on the platforms, in the station building
or on the forecourt (level 0; one clock on the building is nearer to the floor of the underpass than to any
level-0 area of the model).

Known problems that matter here:

- Not measurable from these sources, so estimates in the level table: the underpass floor, today's RBS platforms and
  the walking floor of the Welle.
- The deck walls of the mesh reach down to −3.5 m; the builder clips the mesh at −1 m.
- Sector boards without a track number in the SBB data were assigned to the nearest edge (nine, all track 3).
- Furniture has no level in the source: the builder takes `level` from the file when it is set there by hand (a
  level the model does not have leaves the piece out rather than putting it on 0), else puts a piece on the level of
  the train platforms (0 at most stations) when it lies on one of them, else on the level of the nearest walkable area within 15 m, else leaves it out. A level that
  came from SBB's section name (`"level_from": "sbb_section"`, Zürich HB) is only a hint, see below.
## Zürich HB (`zurich/`)

`boards.json`, `sectors.json` and `furniture.json` are made by `tools/station3d_sbb_layers.py zurich` straight from
data.sbb.ch (`sektortafel`, `haltestelle-uhr`, `billetautomat`), for the stop ids and extent in `STATIONS`:

- The sector signs of tracks 3-18 carry their own sector's letter on both faces ("A|A"), about two per sector; the
  sector centre is their middle. (At stations whose signs mark the border between two sectors, "B|C", the script puts
  a centre midway between the two borders; checked on Wankdorf against the centres there: median 3 m, at most 7 m.)
- data.sbb.ch has no sector signs for Löwenstrasse (31-34) and Museumstrasse (41-44), and no platform-edge lines any
  more (`perronkante` was withdrawn), so Zürich has no `spans.json` and no `platform_edges.geojson`.
- Clocks and ticket machines are all those inside the model's extent. Where SBB files one under the section
  "Zurich HB Lowenstrasse" or "Zurich HB Museumstrasse" (`sbb_sections` in `STATIONS`), the script writes −4 or −3
  with `"level_from": "sbb_section"`. These sections are operating areas, not floors: SBB files many street-level
  clocks under them, among them clocks hung from the hall roofs (`BA-Dach_BE Langshalle`, `Alte Haupthalle`) and from
  catenary masts (`FS-Mast`). So the builder keeps a section's level only for a piece within 15 m of a walkable area
  on that floor and not hung from a roof or mast (`BA-Dach…`, `FS-…`: it goes on the highest floor walkable within
  15 m). The rest are placed like any other furniture. With the 2026-11-21 data the model has 8 clocks and 7 ticket
  machines on −4 and 17 clocks and 3 ticket machines on −3; 42 of the section-filed pieces went to street level. The Museumstrasse clocks
  without a mounting (`montage_an` empty) stay on −3: nothing in the data says where they hang, and they lie over
  that floor's platforms.

## Basel SBB (`basel/`) and Luzern (`luzern/`)

`boards.json`, `sectors.json` and `furniture.json` are made by `tools/station3d_sbb_layers.py basel` and
`... luzern` from data.sbb.ch, like Zürich's (2026-11-21):

- **Basel SBB**: 86 sector signs on tracks 1-4, 6-11, 14-16, 18-20 and the French tracks 30-35 (data.sbb.ch has 106 in
  the extent; 20 carry no track number and are left out). Most carry their own sector's letter on both faces
  ("A|A"); on tracks 14-20 there are also signs at the borders ("E|D", "C|B", 27 of them), which the script only uses
  where a sector has no sign of its own. No signs for tracks 5 and 12. 79 sector centres: median 0.0 m from the OSM
  platform of their track (76 on it, at most 6.6 m off). 81 clocks and 19 ticket machines; SBB files them all under
  one section ("Basel SBB"), so the builder gives them their level (one clock lies near no walkable area and is left
  out).
- **Luzern**: 60 sector signs on tracks 2-15, all "A|A" style, 54 of them hanging; 60 sector centres, median 0.5 m
  from their platform (30 on it, at most 5.2 m off; the builder moves the others onto it). 52 clocks (11 of them filed
  under the section "Luzern Cargo") and 14 ticket machines.
- Neither station has platform-edge lines (`perronkante` was withdrawn) or measured heights here: no `spans.json`,
  no `heights.json`. The level heights in the builder's station table come from OSM step counts, ATLAS platform
  heights and swisstopo terrain (see the comments there).

## Lausanne (`lausanne/`) and Genève (`geneve/`)

Made by `tools/station3d_sbb_layers.py lausanne` and `... geneve` (2026-11-21), as for Zürich HB.

- **Signs at the borders.** At both stations the sector signs mark the border between two sectors ("B|A", "G|H"),
  so the script puts each centre midway between the two borders, and an end sector as far beyond its one border
  as its neighbour reaches on the other side. A few signs carry their own letter on both faces ("F|F" and "G|G"
  on track 1 at Lausanne, "A|A" on 70, on 2 and 3 at Genève) or one face only, at the platform ends ("A|-").
  About nine in ten hang from the platform roofs.
- **Lausanne:** 56 signs, 54 sector centres: A-G on tracks 1, 3, 4 and 8, A-H on 5, 6 and 7, A-B on 70. 49 centres
  lie on their OSM platform, the median distance is 0 m. The worst is 7H, 34 m past the west end of the OSM outline
  of platform 7/8 (the builder snaps it to that end). 14 clocks and 15 ticket machines.
- **Genève:** 60 signs, 55 sector centres: A-G on track 1, A-H on 2-7. Track 10 has one sign under "10" and one
  under "010" and no centres. 54 centres lie on their platform, the median distance is 0 m, the worst is 1 m.
  27 clocks and 21 ticket machines.
- **Furniture levels.** SBB lists all the furniture of each station in one section ("Lausanne", "Geneve"), so
  `sbb_sections` cannot place any of it below ground. The builder sets the level. At Genève the train platforms
  are level 2, and the sector signs and the furniture standing on a platform go on that level.
- **Not available.** There is no `spans.json` and no `platform_edges.geojson`: data.sbb.ch no longer offers its
  platform-edge lines.
