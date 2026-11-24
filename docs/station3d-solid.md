# The inside of a station in 3D (continuous view)

`station3d-solid.html?key=zurich` shows a station as **one building at true heights**, not as floors pulled apart:

- floors as slabs at their real heights (stretched ×2.2 upwards by default, so the floors read; ↕ switches to 1×),
  with the **wells** cut out where stairs and escalators go up or down through them;
- every **escalator** as a band with chevrons in its running direction (teal = up, orange = down, grey = unknown) and
  glass balustrades; every **stair** with a few clear steps (stairs OpenStreetMap draws steeper than 40° as a striped
  slope); **lifts** as glass shafts with a ring at each floor they stop at; ramps as slopes;
- walls where OpenStreetMap has them (doorways left open), kerbs at the edges of indoor floors, railings round the
  wells, named rooms, and **pins for shops and services** (209 at Zürich HB, all of ShopVille and the passages);
- tracks with their beds, platform numbers, sector letters, the names of the halls and passages, entrances;
- **your way** as a yellow tube through it all: through the escalators and down the lift shafts. The floors above the
  way are cut open along it (a corridor cutaway: the rest of each floor stays), and a faint copy of the tube shows
  through any floor that still hides it.

When the walk ends at a platform to board a train, that train stands at the platform as a hologram: its coaches,
their classes, where to get on (the walk is aimed at that sector) and how full each class is expected to be. See
[train-formation.md](train-formation.md).

Step by step (**Next ›**), the camera looks across each floor change so the climb shows in profile; **Whole way**
shows it all. The floor buttons lift away everything above a floor (its outlines stay, as a ghost). Labels are
limited to about 15 at a time, the way's own first.

## Data

Stations with a continuous view: all ten models (Zürich HB, Bern, Wankdorf, Europaplatz, Brünnen Westside, Bümpliz
Nord, Basel SBB, Luzern, Lausanne, Genève; `stations3d/solid-index.js`).
The Bern-area companions were built from the OpenStreetMap cache of 21 November 2026; their models are unchanged.

| File | Made by | From |
| --- | --- | --- |
| `stations3d/<key>.js` | `tools/build_station3d.py` | OpenStreetMap, ATLAS, SBB open data (see `stations3d/SCHEMA.md`) |
| `stations3d/<key>.solid.js` | `tools/station3d_solid.py <key>` | the model above + OpenStreetMap from the builder's cache (`tools/cache/<key>.osm.json`) |
| `tools/station3d_data/<key>/{boards,sectors,furniture}.json` | `tools/station3d_sbb_layers.py <key>` | data.sbb.ch (sector signs, clocks, ticket machines) |

```bash
python tools/station3d_sbb_layers.py zurich   # SBB layers (cached in tools/cache/)
python tools/build_station3d.py zurich         # the model (downloads OSM once, cached)
python tools/station3d_solid.py zurich         # the 3D companion
```

The companion file is separate on purpose: the model format stays as it is, and the router and the indoor position
read only the model.

## In the app

This is the app's only 3D view of a station. The page reaches it through `Station3D`, a small stand-in
(`src/station3d.ts`) that loads the view (`src/station-view.ts`, with `import()`) the first time a station is
opened: the view in an overlay over the map, with the walk step by step and the indoor position. The map's
platform cards and the journey's walks and changes open it. `station3d-solid.html` above is the same renderer on a
page of its own, for development. (An earlier viewer with floors pulled apart and a first-person walk,
`station3d.js`, was removed in November 2026.)

## What the data does not have yet (Zürich HB)

- **Walls below ground**: OpenStreetMap has none (its 35 indoor walls are on level 0), and the shops of ShopVille and
  the passages are points, not outlines. So underground the view shows floors, kerbs and pins, not walls; edges of
  floors the builder made from paths (their outline is a guess) get no kerb at all. Nothing is invented.
- **Real heights of each floor** come from step counts and track heights in OpenStreetMap (see the level table in
  `tools/build_station3d.py`); room heights are schematic (2.6 m).
- **SZU (tracks 21/22)** is left out while it is closed for its rebuild (until 13 December 2026); OSM has no platform.

SBB's own indoor plans (the Journey Maps tiles behind the SBB app) are for SBB applications only. More detail has to
come from better OpenStreetMap mapping; SBB's official station plan can be linked. See
[sbb-journey-maps.md](sbb-journey-maps.md).