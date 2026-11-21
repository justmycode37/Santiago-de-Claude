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
| `<key>/furniture.json` | clocks and ticket machines (no level in the source) | `props` (`clock`, `ticket-machine`) | SBB open data | `data.sbb.ch` |

Licences: all three sources are open data that may be used in a public app when the source is named with the
strings in the last column (as recorded in the README of the research folder the files come from). Check the terms
of use of swisstopo, the City of Bern and data.sbb.ch before using the files for anything else.

Where they come from in this project: `heights.json` and `shell_mesh.json` are copies of the files in
`Santiago-de-Claude-research/enrich/` (its README has fields, methods and known problems; built 2026-11-21 by
`scripts/enrich/`). The sector, span, board and furniture files are copies of
`Santiago-de-Claude-research/reuse/<key>.*.json` (built by `reuse/tools/extract_sectors.py` and
`extract_furniture.py` with the origins `7.4391, 46.9488` for `bern` and `7.4655, 46.9672` for `wankdorf`).

Known problems that matter here:

- Not measurable from these sources, so estimates in the level table: the underpass floor, today's RBS platforms and
  the walking floor of the Welle.
- The deck walls of the mesh reach down to −3.5 m; the builder clips the mesh at −1 m.
- Sector boards without a track number in the SBB data were assigned to the nearest edge (nine, all track 3).
- Furniture has no level: the builder puts a piece on level 0 when it lies on a platform, else on the level of the
  nearest walkable area within 15 m, else leaves it out.

## Zürich HB (`zurich/`)

`boards.json`, `sectors.json` and `furniture.json` are made by `tools/station3d_sbb_layers.py zurich` straight from
data.sbb.ch (`sektortafel`, `haltestelle-uhr`, `billetautomat`), for the stop ids and extent in `STATIONS`:

- The sector signs of tracks 3-18 carry their own sector's letter on both faces ("A|A"), about two per sector; the
  sector centre is their middle. (At stations whose signs mark the border between two sectors, "B|C", the script puts
  a centre midway between the two borders; checked on Wankdorf against the centres there: median 3 m, at most 7 m.)
- data.sbb.ch has no sector signs for Löwenstrasse (31-34) and Museumstrasse (41-44), and no platform-edge lines any
  more (`perronkante` was withdrawn), so Zürich has no `spans.json` and no `platform_edges.geojson`.
- Clocks and ticket machines are all those inside the model's extent; the builder gives them a level.
