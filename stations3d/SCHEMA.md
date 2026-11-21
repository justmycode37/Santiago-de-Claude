# Station 3D models

For stations with several floors, the app can show a 3D model with the walking route through it
(`station3d.js`). The models live here, one file per station complex, built by `tools/build_station3d.py`.

Three pieces share this format. Change it only together with all three:

| Piece | File | Role |
| --- | --- | --- |
| Builder | `tools/build_station3d.py` | OpenStreetMap + ATLAS (+ open-data layers in `tools/station3d_data/<key>/`) → `stations3d/<key>.js` and `stations3d/index.js` |
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
  escalators a point can have a fractional level (−0.5 = halfway between −1 and 0). So can a point on a street that
  slopes: its level is its real height read off the level table (3.4 = 40 % of the way from level 3 to level 4).
  Where OpenStreetMap has no `level`, the builder derives it: a train platform is on the level of its track (0
  unless tagged), a footbridge or underpass is the first level of the station's table that clears the tracks it
  crosses, and everything else follows from the steps counted on the stairs and from measured heights.
- Height: `z(level)` is the piecewise linear interpolation through `model.levels[].z` (metres relative to level 0,
  real heights, not exaggerated; the viewer may exaggerate).

## model

```js
{
  key: "bern", name: "Bern", built: "2026-11-21",
  attribution: ["© OpenStreetMap contributors", "opentransportdata.swiss"],   // + "© swisstopo", "Geodaten Stadt Bern",
                                                  //   "data.sbb.ch" when those sources are in the model
  // optional: things the app should say about this station; from / until optional, as in "Closures" below
  notices: [{ text: "Construction in the main underpass: follow the signs on site", from: "2026-12-13", until: "2029-03-01" }],
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
    // optional on any area:
    //   derived: true   the builder made it from the paths (a strip along them) or from a deck outline, because
    //                   OpenStreetMap has no area there. Draw it a little lighter; its width is a guess.
    //   closed: { ... } see "Closures"
  ],

  tracks: [{ level: 0, line: [[x, y], ...], ref: "7" }],          // rail / tram centre lines; ref optional;
                                                  //   kind: "narrow_gauge" | "tram" | "light_rail" when not standard gauge

  // Things that change level, for drawing. The graph has the same links as edges.
  connectors: [
    { kind: "stairs" | "escalator" | "ramp", line: [[x, y, level], ...], width: 2.4, oneway: "up" | "down" | undefined },
    { kind: "elevator", xy: [x, y], levels: [-1, 0, 1] },
    // optional on any connector: closed: { ... } (the edges of the connector carry the same)
    // An escalator OpenStreetMap draws steeper than 35° is drawn longer here (30°); its graph edge keeps its ends.
  ],

  // Massing for context: station building, platform roofs, neighbours. base/top in metres relative to level 0.
  shell: [{ kind: "building" | "roof" | "deck", ring, holes, base: 0, top: 18, name: "" }],
  // optional: real roofs and walls of the key structures (swissBUILDINGS3D), as triangles. positions = flat
  // [x, y, z, ...] in local metres, z up in metres relative to level 0 (not a level number); indices = flat triangle
  // corners. The shell prisms of the same structures are left out of `shell`, so nothing is drawn twice.
  shellMesh: [{ name: "Welle", kind: "building" | "roof" | "deck" | "canopy", positions: [x, y, z, ...], indices: [i, j, k, ...] }],

  // Every platform / stop edge of the complex from platforms.js (ATLAS), tied to the graph.
  // One stop per stop id and platform number (ATLAS often has several points for one track: merged).
  //   node    where the stop is shown: the graph node nearest the ATLAS position (of the ATLAS point that fits the
  //           platform best). No two stops share a node.
  //   nodes   every graph node along that platform (its centre line every 10 m, and where stairs, ramps and lifts
  //           land): a route may start or end at any of them. Just [node] for a stop without a platform area.
  //   level   a whole level, except for a stop on a street that slopes (see "Level")
  //   name    stops without a ref that share a name are told apart: "Bern, Obergericht (north side)"
  //   closed: { ... } optional, see "Closures"; note: "..." optional, a remark that does not close the stop
  //   at: [x, y]  on stops without a ref: where the timetable data (platforms.js) has this stop edge. An endpoint
  //           given as a position within 3 m of it is this stop, on the stop's level (the app has no other way to
  //           name such a stop, and the level in the timetable data can be wrong)
  stops: [{ uic: "8507000", ref: "7", mode: "train", name: "Bern", level: 0, xy: [x, y], node: 412, nodes: [412, 413, ...] }],
  // Sectors of a platform edge (SBB open data), when known. xy = the middle of the sector on the platform;
  // node (optional) = the graph node of that platform nearest to it.
  sectors: [{ ref: "7", name: "A", xy: [x, y], node: 431 }],
  // optional: the stretch of the platform edge each sector covers, from a to b, for drawing sector bands.
  // line (optional) = the kerb between a and b where the platform curves and the straight line would leave it
  sectorSpans: [{ ref: "7", name: "A", a: [x, y], b: [x, y], line: [[x, y], ...] }],
  // optional: station furniture, for the first-person view. heading = compass bearing (0 = north, clockwise) of the
  // platform edge at a sector sign, which hangs or stands across it; name = the letters on its two faces.
  props: [{ kind: "sector-sign" | "clock" | "ticket-machine" | "meeting-point", xy: [x, y], level: 0,
            ref: "7", name: "B|C", mount: "hang" | "stand", heading: 69 }],

  entrances: [{ name: "Bahnhofplatz", level: 0, xy: [x, y], node: 12 }],   // closed: { ... } optional
  pois: [{ kind: "tickets" | "toilets" | "info" | "meeting-point" | "lockers", name: "", level: 0, xy: [x, y] }],

  // Walking graph. Everything a route can use, including the pavements and squares between the stop edges.
  graph: {
    nodes: [[x, y, level], ...],
    edges: [
      // len = horizontal length in metres. Undirected unless oneway is set (then only a → b).
      { a: 0, b: 1, kind: "walk", len: 12.4 },
      { a: 1, b: 2, kind: "stairs" | "escalator" | "ramp" | "elevator", len: 8, oneway: true, name: "" },
      // optional on any edge: outdoor: true, covered: true, wheelchair: false, closed: { ... },
      //   inferred: true the builder added this link: OpenStreetMap has no path there (a platform or a lift
      //                  stop nobody mapped a way to, joined to the nearest path; a crossing given in the
      //                  builder's station table)
      //   incline: 0.1   the real slope (rise / length) of a ramp, and of a walk that follows a sloping street
    ],
  },
}
```

### Closures

`closed: { from?: "YYYY-MM-DD", until?: "YYYY-MM-DD", note?: "..." }` on a stop, an area, a connector, an entrance or
a graph edge: the thing is closed when `from <= today < until`; a missing bound is open-ended. The router evaluates
it when a route is asked for (no rebuild on the day). A closed platform carries it on its stops, its area and every
stair, escalator, ramp and lift that lands on it. Something OpenStreetMap has under construction with an opening date
is in the model as `closed: { until, note }`, so it opens on that day; what has no known date is not in the model.

Rules the builder guarantees:

- Every `stops[].node` and `entrances[].node` is in one connected part of the graph (routes exist between all of
  them, counting closed edges as open), and so is every node in `stops[].nodes`.
- An edge between two different whole levels is never `kind: "walk"`, and indoors a walk never changes level. Outdoors
  a walk may slope with the street (`outdoor: true`, its ends on fractional levels, `incline` set). `ramp` is something
  built: indoors, or mapped between two floors. A path steeper than 35 % is `stairs`, whatever OpenStreetMap calls it.
- Every `stairs` / `escalator` / `ramp` / `elevator` edge belongs to a connector that is drawn, and the other way
  round (except stairs that leave the model's extent).
- An elevator is one node per level it serves, joined by `elevator` edges (`len: 0`).
- Escalators are `oneway` when OpenStreetMap says which way they run; `a → b` is the direction of travel.
- A train stop stands on a platform area that carries its number, on that area's level.

## Router: `window.StationRoute`

```js
StationRoute.toLocal(model, [lng, lat])  → [x, y]
StationRoute.toLngLat(model, [x, y])     → [lng, lat]
StationRoute.z(model, level)             → metres
StationRoute.route(model, from, to, prefs) → route | null
```

`from` / `to` are one of: `{ stop: { uic, ref, sector? } }` (the whole platform, or the named sector of it), `{ node: i }`, `{ entrance: "name" }`,
`{ xy: [x, y], level }`, `{ ll: [lng, lat], level }` (level optional: nearest walkable node on any level,
preferring outdoor / level 0).

`prefs` are the app's journey settings: `{ stepFree, fewerStairs, noEscalators, wheelchair, walkKmh, date }`
(`date`: the day closures are evaluated for; default today).

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

Beyond that the router returns (the header comment of `station-route.js` is the reference):

- on a route: `dists` (metres along the path at each point), `edges`, `relaxed` (the preferences that could not be
  met, e.g. `["stepFree"]`) and `notice` (a sentence for the user about that or about a closure), `closed`
  (the closures that matter for this route), `incomplete` / `throughClosed`, `same` (start and end are one place),
  `fromDist` / `toDist`, `fromAssumed` / `toAssumed` (where on the platform the route starts or ends),
  `fromSectors` / `toSectors`, `fromStop` / `toStop`;
- on a step: `turn` (`"left" | "right" | "bear-left" | "bear-right" | "around" | "straight"`), `place` (the name of
  where it goes), `warn: true` (a preference is not met on this step), and `sector` on the arrive step;
- `StationRoute.snap(model, route, xy, hint?)` → `{ index, t, point, dist, along, remaining, step, progress }`,
  `StationRoute.pointAt(route, metres)` → `[x, y, level]`, `StationRoute.resolve(model, endpoint)`,
  `StationRoute.sectorTimes(model, from, to, prefs)`, `StationRoute.why(model, from, to, prefs)`,
  `StationRoute.isClosed(thing, date?)`, `StationRoute.notices(model, date?)`, `StationRoute.platformKey(ref)`,
  `StationRoute.levelName(model, level)`, `StationRoute.TIME`.

## Viewer: `window.Station3D`

```js
Station3D.has(uic)                      → key | null   (from STATION3D_INDEX)
Station3D.open({ key, from, to, prefs, title })   // from / to as for the router; both optional (then: explore mode)
Station3D.setUser({ ll: [lng, lat], accuracy, heading })   // live position; null hides it
Station3D.close()
```
