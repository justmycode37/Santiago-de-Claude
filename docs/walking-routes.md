# Walking routes

Walks in a journey (to the stop, between platforms, to the destination's door) are routed in the browser by
`walkroute.js` on a pedestrian network built ahead of time (`walkgraph/`) for Bern, Zürich, Basel, Geneva and
Lausanne. Inside Bern, Europaplatz and Wankdorf the 3D station models' own router (`station-route.js`) takes over;
where there are no tiles, the online routers are used.

## What the network knows

- **Doors**: a walk ends at a door of the destination building, the one that makes the walk shortest (back doors,
  garages and emergency exits only when there is nothing else). A yellow dot marks it. Where OpenStreetMap maps no
  door for a building (most buildings in Zürich, Geneva and Lausanne), its doors come from the official building
  address register: each address point, put on the stretch of outline facing the street (type `addr`).
- **Sidewalks, crossings, arcades, passages, underpasses**: followed, and drawn with a dashed line down the middle
  where covered.
- **Floors**: station underpasses, stairs, escalators and lifts by level, with directions such as "Stairs down to
  level −2, then 80 m". Step-free, fewer-stairs and no-escalator settings avoid steps, escalators and raised kerbs.
- **Platforms by number**: a train or bus is boarded from the platform OpenStreetMap gives for its track or bay
  (`ref=3;4`), never from the island next to it. A stop position given on the track itself reaches its platform
  across that one track; a platform drawn apart from every street is reached from the street beside it.
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
only the ones around a walk are loaded, and once more than 24 are built into the network (walks in two cities) it is
rebuilt from the tiles of the walk at hand, so a phone holds about 40-100 MB of network at most. The tile format is
described in the builder's docstring.

Doors from the address register (`tools/gebaeudeadressen.py`, swisstopo's "Amtliches Gebäudeadressverzeichnis",
~140 MB once): the rules place an address point at the building's entrance. Against OpenStreetMap's doors with the
same address, the point snapped onto the outline is a median 0.8 m (Bern), 0.9 m (Basel), 1.7 m (Lausanne), 2.4 m
(Geneva) and 5.8 m (Zürich, where points sit a few metres inside or in front of the façade) from the mapped door
(`tools/walk-eval/register_check.py`). Only buildings without an OSM door get them; `--no-register` leaves them out.

| Area | Tiles | Size (gzip) | OSM doors | Register doors |
|---|---|---|---|---|
| Bern | 84 | 9.2 MB (3.5 MB) | 15,500 | 25,900 |
| Zürich | 215 | 20.6 MB (7.5 MB) | 7,000 | 76,200 |
| Basel | 70 | 8.7 MB (3.1 MB) | 17,500 | 30,000 |
| Geneva | 81 | 10.2 MB (3.7 MB) | 530 | 44,800 |
| Lausanne | 62 | 6.9 MB (2.5 MB) | 820 | 28,200 |

`tools/test_walkroute.mts` checks the built tiles (doors reached, no building or track crossings, platform changes).
`tools/walk-eval/` measures any built city the same way (results in its README).

## Aerial photo (prototype)

`tools/aerial_path.py` looks for the way across unmapped ground on swisstopo's aerial photo (DINOv2 patch features, a
classifier trained on the mapped paths of that photo, cheapest path through the cost map). Not used by the app.

Sources: © OpenStreetMap contributors (ODbL), © swisstopo (swissTLM3D, SWISSIMAGE, building address register).
