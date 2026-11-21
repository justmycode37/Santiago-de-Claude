# Walking routes

Walks in a journey (to the stop, between platforms, to the destination's door) are routed in the browser by
`walkroute.js` on a pedestrian network built ahead of time (`walkgraph/`). Inside Bern, Europaplatz and Wankdorf the
3D station models' own router (`station-route.js`) takes over; where there are no tiles, the online routers are used.

## What the network knows

- **Doors**: a walk ends at a door of the destination building, the one that makes the walk shortest (back doors,
  garages and emergency exits only when there is nothing else). A yellow dot marks it.
- **Sidewalks, crossings, arcades, passages, underpasses**: followed, and drawn with a dashed line down the middle
  where covered.
- **Floors**: station underpasses, stairs, escalators and lifts by level, with directions such as "Stairs down to
  level −2, then 80 m". Step-free, fewer-stairs and no-escalator settings avoid steps, escalators and raised kerbs.
- **Platforms by number**: a train or bus is boarded from the platform OpenStreetMap gives for its track or bay
  (`ref=3;4`), never from the island next to it.
- **Squares and platforms** are crossed in a straight line; railway tracks on the ground are never crossed.
- **Paths outside towns** that OpenStreetMap lacks come from swisstopo's swissTLM3D (marked `s: 't'`).
- **Guesses are shown as guesses**: a straight bit across open ground longer than 20 m at either end of a walk, or a
  walk with no route at all, is drawn dashed and without arrows.

On a routed walk the blue dot sits on the path while GPS is within its accuracy, leaving the route is noticed
sooner, and arrival depends on the accuracy.

## Using it

`window.WALKROUTE.route(a, b, opts)` → `{ coords, dist, door, covered, cues, via, levels, approxTo, approxFrom,
swisstopo }` or `null` (no tiles, or no plausible route). `opts`: `stepFree`, `fewerStairs`, `noEscalators`, and for
each end (`from`, `to`) what it is: `{ accuracy }` (a GPS position), `{ platform, level, ref }` (a platform on its
floor, by number), `{ exact }` (a point as it is, e.g. where another router's path begins) or `{}` (a place: the walk
ends at its door). `WALKROUTE.covers(ll)` says whether there are tiles; `WALKROUTE.configure({ loader, base })` loads
tiles from elsewhere (Node).

## Building the network

```bash
python3 tools/build_walkgraph.py --area bern     # bern, zurich, basel, geneva, lausanne, luzern, ...
python3 tools/build_walkgraph.py --bbox 7.43,46.94,7.46,46.96
python3 tools/build_walkgraph.py --area bern --no-tlm   # OpenStreetMap only
```

OpenStreetMap comes from the Swiss Overpass server (cached in `~/.cache/walkgraph`). swissTLM3D's roads-and-paths
layer (~525 MB) is fetched once out of swisstopo's release with HTTP range requests (`tools/swisstlm3d.py`). A
swisstopo line more than 12 m from every OSM way is added and joined to the street-level OSM way it meets; motorways,
closed tracks, climbing passages, ferries and lines in or under buildings are left out. Tiles are 0.01° (about 1 km);
only the ones around a walk are loaded. The tile format is described in the builder's docstring.

`tools/test_walkroute.mjs` checks the built tiles (doors reached, no building or track crossings, platform changes).

## Aerial photo (prototype)

`tools/aerial_path.py` looks for the way across unmapped ground on swisstopo's aerial photo (DINOv2 patch features, a
classifier trained on the mapped paths of that photo, cheapest path through the cost map). Not used by the app.

Sources: © OpenStreetMap contributors (ODbL), © swisstopo (swissTLM3D, SWISSIMAGE).
