# Station 3D models

For stations with several floors, the app can show a 3D model with the walking route through it
(`station3d.js`). The models live here, one file per station complex, built by `tools/build_station3d.py`.

Three pieces share this format. Change it only together with all three:

| Piece | File | Role |
| --- | --- | --- |
| Builder | `tools/build_station3d.py` | OpenStreetMap + ATLAS → `stations3d/<key>.js` and `stations3d/index.js` |
| Router | `station-route.js` (`window.StationRoute`) | shortest walk through the model's graph, with instructions |
| Viewer | `station3d.js` (`window.Station3D`) | draws the model and the route with three.js |

## Files

- `stations3d/index.js` sets `window.STATION3D_INDEX = { "<uic>": "<key>", ... }`: every stop id
  (as in `platforms.js` and transport.opendata.ch) that belongs to a modelled complex. Tiny, loaded at start-up.
- `stations3d/<key>.js` does `(window.STATION3D = window.STATION3D || {})["<key>"] = model;`. Loaded on demand,
  as a script (so it also works from `file://`). Target size: under 1.5 MB.
- `stations3d/_fixture.js` is a small made-up station (`key: "_fixture"`) in this format, for tests and development.

## Coordinates

- Local frame in metres around `model.origin = [lng, lat]`: **x = east, y = north**.
  `x = (lng - lng0) * 111320 * cos(lat0)`, `y = (lat - lat0) * 110540` (same constants as `tools/build_platforms.py`).
  Round to 0.01 m.
- **Level** is the OpenStreetMap `level` number (0 = the main track level; negative = below). On stairs, ramps and
  escalators a point can have a fractional level (−0.5 = halfway between −1 and 0).
- Height: `z(level)` is the piecewise linear interpolation through `model.levels[].z` (metres relative to level 0,
  real heights, not exaggerated; the viewer may exaggerate).

## model

```js
{
  key: "bern", name: "Bern", built: "2026-11-21",
  attribution: ["© OpenStreetMap contributors", "opentransportdata.swiss"],
  origin: [7.4391, 46.9488],
  bbox: [minX, minY, maxX, maxY],
  uics: ["8507000", "8576646"],                  // every stop id of the complex (same ids as in index.js)

  levels: [                                        // bottom to top
    { id: -2, z: -9.5, name: "RBS station" },
    { id: -1, z: -4.8, name: "Underpass" },
    { id:  0, z:  0,   name: "Platforms" },
  ],

  // Flat surfaces, one polygon each. ring = outer ring [[x, y], ...] (not closed, counter-clockwise), holes optional.
  areas: [
    { level: 0,  kind: "platform", ring, holes, refs: ["7", "8"], name: "" },
    { level: -1, kind: "floor",    ring, name: "Underpass" },   // public indoor floor you walk on
    { level: -1, kind: "room",     ring, name: "Kiosk", height: 3 },   // closed off: shops, offices (drawn as a block)
    { level: 0,  kind: "plaza",    ring, name: "Bahnhofplatz" }, // outdoor ground you walk on
  ],

  tracks: [{ level: 0, line: [[x, y], ...], ref: "7" }],          // rail / tram centre lines; ref optional

  // Things that change level, for drawing. The graph has the same links as edges.
  connectors: [
    { kind: "stairs" | "escalator" | "ramp", line: [[x, y, level], ...], width: 2.4, oneway: "up" | "down" | undefined },
    { kind: "elevator", xy: [x, y], levels: [-1, 0, 1] },
  ],

  // Massing for context: station building, platform roofs, neighbours. base/top in metres relative to level 0.
  shell: [{ kind: "building" | "roof" | "deck", ring, holes, base: 0, top: 18, name: "" }],

  // Every platform / stop edge of the complex from platforms.js (ATLAS), tied to the graph.
  stops: [{ uic: "8507000", ref: "7", mode: "train", name: "Bern", level: 0, xy: [x, y], node: 412 }],
  sectors: [{ ref: "7", name: "A", xy: [x, y] }],                  // sector signs along a platform, when known

  entrances: [{ name: "Bahnhofplatz", level: 0, xy: [x, y], node: 12 }],
  pois: [{ kind: "tickets" | "toilets" | "info" | "meeting-point" | "lockers", name: "", level: 0, xy: [x, y] }],

  // Walking graph. Everything a route can use, including the pavements and squares between the stop edges.
  graph: {
    nodes: [[x, y, level], ...],
    edges: [
      // len = horizontal length in metres. Undirected unless oneway is set (then only a → b).
      { a: 0, b: 1, kind: "walk", len: 12.4 },
      { a: 1, b: 2, kind: "stairs" | "escalator" | "ramp" | "elevator", len: 8, oneway: true, name: "" },
      // optional on any edge: outdoor: true, covered: true, wheelchair: false, incline: 0.1
    ],
  },
}
```

Rules the builder guarantees:

- Every `stops[].node` and `entrances[].node` is in one connected part of the graph (routes exist between all of them).
- An edge whose ends are on different levels is never `kind: "walk"`.
- An elevator is one node per level it serves, joined by `elevator` edges (`len: 0`).
- Escalators are `oneway` when OpenStreetMap says which way they run; `a → b` is the direction of travel.

## Router: `window.StationRoute`

```js
StationRoute.toLocal(model, [lng, lat])  → [x, y]
StationRoute.toLngLat(model, [x, y])     → [lng, lat]
StationRoute.z(model, level)             → metres
StationRoute.route(model, from, to, prefs) → route | null
```

`from` / `to` are one of: `{ stop: { uic, ref } }`, `{ node: i }`, `{ entrance: "name" }`,
`{ xy: [x, y], level }`, `{ ll: [lng, lat], level }` (level optional: nearest walkable node on any level,
preferring outdoor / level 0).

`prefs` are the app's journey settings: `{ stepFree, fewerStairs, noEscalators, wheelchair, walkKmh }`.

```js
route = {
  points: [[x, y, level], ...],        // the whole path
  nodes: [i, ...],                      // graph nodes along it
  length: 214,                          // metres
  seconds: 205,
  steps: [                              // consecutive, covering all points
    { kind: "walk" | "stairs" | "escalator" | "ramp" | "elevator" | "arrive",
      from: 0, to: 7,                   // indices into points
      level: 0, toLevel: -1, dir: "down" | "up" | null,
      len: 38, seconds: 30,
      text: "Take the escalator down to the underpass" },
  ],
}
```

## Viewer: `window.Station3D`

```js
Station3D.has(uic)                      → key | null   (from STATION3D_INDEX)
Station3D.open({ key, from, to, prefs, title })   // from / to as for the router; both optional (then: explore mode)
Station3D.setUser({ ll: [lng, lat], accuracy, heading })   // live position; null hides it
Station3D.close()
```
