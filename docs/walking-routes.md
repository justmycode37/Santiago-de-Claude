# Walking routes

Every walk in a journey (to the stop, between platforms, to the destination's door, and walking all the way) is the
Kante engine's: its path, metres, time, written directions and floor changes come with each walking leg of
`POST /api/plan`, and from `POST /api/walk` when a walk has to be asked for again (a live platform change, the
stretches before and after a station model). The engine routes on one pedestrian network for the whole of
Switzerland, built from OpenStreetMap (`kante/engine/crates/osm`, `walk`, `link`; the doors in
`kante/engine/crates/link/src/doors.rs`). Inside the ten stations with a 3D
model the model's own router (`src/station-route.ts`) draws the part inside, so the map shows the way the 3D view
does. When the engine answers that it has no path at all (`approximate`: the place is outside its map, which ends
at the border), the walk is asked of OSRM's foot profile (`routing.openstreetmap.de/routed-foot`, `footWalk()` in
`src/app/routing.ts`), as the site asked it before the engine routed walks: its line, metres and street-by-street
directions. Its times stay the engine's, so a journey opened keeps the times of its row. This is the one fallback; it is never asked for a walk the engine routed,
guessed ends included. When OSRM has no way either, or the engine cannot be reached, the walk is a dashed straight
line, timed by the engine when it answered. A walk asked for again that gets no answer is timed as the engine times a straight line, the time to
spare at a change says so ("About 3 min to spare — the walk is estimated"), and it is asked again with the next live
update.

## What the network knows

- **Doors**: a walk to a place in a building ends at one of its doors, the one that makes the walk best (back doors,
  garages and emergency exits only when there is nothing else), and a walk from a building starts at one; a yellow
  dot marks it, and the directions end "In at the entrance, Bundesgasse 3". Doors are OpenStreetMap's entrances on
  the building's outline; a building without one gets a door at each point of the official building address register
  that belongs to it, put on the stretch of outline facing the open (never a wall shared with the house next door).
  A door is joined to the nearest ways by straight lines that cross no building (its own included) and no railway
  track on the ground; a door with no other way out (a house whose road is behind it, no path mapped) is joined
  through its own house as a guess, and any door with a real way out is preferred. Step-free: only doors not tagged
  `wheelchair=no`, joined to ways a wheelchair may use; when there is none, the walk goes straight into the building
  (dashed, not step-free) and the directions say so. A courtyard is not part of its building.
- **Sidewalks, crossings, arcades, passages, underpasses**: followed, and drawn with a dashed line down the middle
  where covered ("Walk 180 m under the arcades").
- **Along a road, at its edge**: where no sidewalk is drawn beside a road, the walk follows the road's own line
  (its centre in OpenStreetMap), and is drawn at the road's edge instead: half the carriageway's width from its
  line (`width`, else `lanes`, else by the road's size), a metre further on a sidewalk tagged on that side. The side
  is the one with the road's only sidewalk, else the side the walk comes onto the road from and leaves it by (a
  stop, a door, a footway), else the inside of its bends; it changes only at a mapped crossing with points of the
  road within 20 m either side of it. Roundabouts, one-way main roads and living streets (unless a sidewalk is
  tagged on one side only), tunnels, roads under a roof, service roads and stretches under 8 m stay on the line, and
  so does any point that would put the line through a building (a narrow street). Only the line moves: the walk,
  its metres and times, its directions are the same (`kante/engine/crates/walk/src/kerb.rs`).
- **Floors**: station underpasses, stairs, escalators and lifts by level, with directions such as "Take the stairs
  down to level −1". A lift drawn as one outline per floor (outlines of one floor each that overlap or touch) is one
  lift. Step-free, fewer-stairs and no-escalator
  settings avoid steps, escalators and kerbs; a step-free walk never changes floor where the map joins two floors
  without stairs, a ramp or a lift.
- **Platforms by number**: a train or bus is boarded from the platform the engine attaches its boarding point to
  (`kante-link`), on its floor; a boarding point given on the track itself is left from the platform beside it.
- **Squares and platforms** are crossed in a straight line, round buildings standing in a square. A path that ends
  inside one (the head of the stairs up to a platform) is joined to it, and a long island platform is crossed every
  20 m, so the two tracks of one platform are a few metres apart, not round its far end.
- **Guesses are shown as guesses**: a straight bit over 20 m onto or off the paths, through a house to its door, or
  into a building where no door could be used, is drawn dashed and written as one ("Walk about 30 m where no way is
  mapped", "Then about 60 m …"); the engine's own directions start where the paths do. A lift between two guesses
  (two points at one place on two floors) is routed, and said. GPS on a guessed stretch counts where you are (the
  distance left, the bar, boarding the next ride and arriving go by it), but the walk is drawn as walked only up to
  where the guess begins, except within 25 m of the walk's end. A walk with no path at all (a straight line) counts
  as a guess throughout.
- **Your position and addresses** are on the street, not in the underpass below them, unless they are right on a way
  of another floor (3 m) with no way on the street within 10 m.

On a routed walk the blue dot sits on the path while GPS is within its accuracy (never on a guessed stretch, at its
end or before its first point included).

You have arrived within 25 m of the trip's end along its line (when the trip ends on foot, only once you are past its
last ride), or on a fix that is itself there: within the GPS accuracy of the destination, counted as 20 to 40 m, or
within 25 m (or that accuracy, up to 40 m) of the point where the trip's line ends. That one counts once you are past
the last ride, or from a minute before the last ride gets to its stop (live): a last walk that doubles back beside
the ride's line puts you on the ride. Before then a ride passing the destination is just passing, and in that minute
a fix on the ride within 25 m of its stop is the vehicle pulling in. Only an arrival on a fix that is itself there is
kept for good. A fix that is only snapped onto the end from further off (one stray fix) shows "You have
arrived" for that fix alone. Arrived for good, you stay arrived, through walking on into the building and through a
gap in GPS, until another trip is opened.

## Leaving the walk's way

Following a journey, a walk is rerouted from where you are when you take another way to where it leads
(`src/app/walk-reroute.ts`, tested by `tools/test_walkreroute.mts`), as a navigation app does:

- **When**: GPS at most 30 m accurate puts you more than `max(20, accuracy) + 12` m off the walk's way (32–42 m,
  under the 45 m and more that is "Off the route" on foot): two fixes at least 2 s apart beyond the off-route
  tolerance, or three over 3 s that have moved 10 m; a gap of over 10 s starts the count again, and a fix within
  `max(15, accuracy)` of the way ends it. Not on a guessed stretch, not within 30 m of the walk's end, not on a walk a
  station model draws or whose route is still on its way. While this is being made sure of (15 s at most, by the
  clock) and asked for, "Off the route" waits; once it is said, a retry does not take it back.
- **What**: the engine's `/api/walk` from your position to the walk's end (its boarding point, or the destination's
  place), at the time it is asked and within the time until the next ride leaves; never OSRM. A walk whose start is a
  guess (no way within 20 m of you) or that has no way is not taken: you are off the route, as before. No answer: the
  walk stays as it was. One request at a time; the next no sooner than 10 s after a reroute, 20 s after a refusal (5 s
  once you have gone 30 m on), 30 s after no answer. An answer that comes after the walk was routed again, after you
  boarded or arrived, when you are back on the old way or GPS is no longer sure enough, is dropped.
- **Drawn**: the part already walked stays drawn as walked (`walked` on the step: the planned way up to where you left
  it, then a dashed line to where the new way begins); the new way is the step's line, and GPS is followed on it, not
  back onto the part walked. A delay alone does not ask for it again; a platform change asks only for the way on
  (from where it begins, at that time, within the time until the ride leaves).
- **Timed**: when you get to the walk's end is the latest fix plus the way left at the engine's pace for it (its
  stairs and hills), worked out again with each fix and kept once you are past it: the walk's end, the arrival, the
  time to spare at a change and "Hurry" on the way to a ride follow it. The rides after it are not planned again:
  "Hurry: about 2 min short" says when the new way is too long for the next ride, and "Missed …?" with Replan once it
  has left.

## Which way

Of the ways there are, the walk takes the one a careful local walker would. These preferences only choose among
ways: a walk's time is always the time it takes, and whether a stop can be reached in time never depends on them
(`kante/docs/WALK-ENDS.md`). What the engine reads beyond a way's kind is in `walkattr.bin` (`kante build`,
`kante/engine/crates/osm/src/attrs.rs`); each preference can be switched off to measure it
(`KANTE_WALK_RULES_OFF=separate,cross,turns,car,favoured,hours,doors,lines`; `kerb` draws walks along roads on
the road's line again, as `compare metrics` needs to match them to the graph).

- **On the sidewalk, not in the road**: a road whose sidewalks OpenStreetMap draws as ways of their own
  (`sidewalk[:both|:left|:right]=separate` with none on the road itself, or `foot=use_sidepath`; 3 695 km
  nationally) is walked on its carriageway only as a last resort: each metre counts 2.5 (it stays in the network,
  so a walk still goes where a drawn sidewalk has a gap). ×4, as a line through a building, was measured too: no
  better on the checked walks, and walks out of town went round 1.5 to 3 times the length of a gap in the sidewalk.
- **Over a busy road where a crossing is**: from a footway or sidewalk over a tertiary, secondary or primary road at
  a junction where no crossing is mapped counts 15, 30 or 45 s per carriageway (more than the 18 s wait at lights,
  so lights 20–35 m away are taken); which side of the road each way is on comes from their directions at the
  junction. `crossing=no` there: not crossed at all, by any walk (56 such nodes on the network); along the road and
  onto the footway beside it is still walked.
- **Few turns**: 2 s for a turn of 35–145° at a junction of three or more ways, 4 s for turning back. The search
  keeps one label per way into such a junction (about a million of them), so these are exact, not estimated.
- **Footways and parks, not driveways**: footways (not cycleways), pedestrian streets and squares, and paths in a
  park or garden count 5 % less; parking aisles, driveways and service roads with limited access (303 000 edges)
  at least 30 % more.
- **Closed at night**: a way with `opening_hours`, or `access:conditional` / `foot:conditional` `no @ (…)`, and the
  paths of a park or the corridors of a mall with opening hours (5 983 edges, 319 of 404 hours readable) count 20
  times while closed at the walk's time: a journey's walks at the journey's time asked (or the page's), `/api/walk` at its `time`
  (without one every way is open). Only what can be read for certain counts: an hour of a public holiday, sunrise,
  week numbers or a comment make the hours unreadable, and unreadable is open. A walk that still has to go through
  one says so (`closedM`). Of 900 walks in ten city centres, 12 are walked otherwise at 23:30 than at noon.
- **The front door**: a building's main entrance is preferred to its other mapped doors (by 3 m), a door that looks
  onto another street than its address's (a side or back door; 270 000 doors) counts 15 m more, and when the place
  asked for is an address one of its doors has, the others count 20 m more. A straight line onto the network that
  walks over a carriageway to reach the sidewalk across it counts twice (a busy one) or 1.5 times; a door keeps the
  ways out it had and gets the one on its own side as well.

Measured on 149 reference walks in ten city centres checked by eye on aerial images (`kante/tools/refwalks`): of the
24 where one walk was judged right, `main` takes the right one in 2, the engine now in 19; on all 149, metres on
carriageways whose sidewalks are drawn apart 5 941 → 399, busy roads walked over from a footway without a crossing
56 → 6, walks 1.6 % longer in time. Each preference alone (switched off, the others on): sidewalks 13 of 24,
turns 14, footways 14, car-only 18, lines 18, doors 19 (but 33 → 10 walks of 900 ending at another door),
crossings 20 (busy roads walked over 6 → 26; the one walk lost is a sidewalk the wrong walk also used).

## Map gaps

`walk-quality <data dir> [--bbox s,w,n,e] [--out DIR]` (`kante/engine/crates/osm/src/bin/walk-quality.rs`) lists
what makes walks wrong in the map itself, as counts and GeoJSON. Nationally (November 2026): 34 drawn sidewalks
loose at both ends and 5 475 at one (366 km), 57 small pieces of network with sidewalks, 275 stretches (53 km) of
roads tagged as having their sidewalks drawn apart where none is drawn beside them (Schaffhauserstrasse in Zürich
1.5 km), 2 955 stretches of busy roads with sidewalks and no crossing for more than 300 m (1 509 km), and roads with
sidewalks tagged on the road (where the side of the street is not known): 2 539 km minor, 2 259 km tertiary and up.

## Hills

Walks climb and descend the land: the engine reads swisstopo's terrain model (swissALTIRegio, 10 m) and knows how
much each way climbs, in each direction (`kante/engine/crates/elevation`; the model of what a slope costs is
`kante/engine/crates/core/src/slope.rs`).

- **Time**: uphill takes longer, from the large GPS studies of walkers rather than the hiking rules (which overstate
  short climbs): under 2 % nothing, +6 % about 6 % longer, +10 % 13 %, +15 % 24 %; down a hill nothing to −8 %, then a
  little slower (−15 %: 10 %). The walk from Lausanne station up to the Cathédrale (1 km, 87 m up) takes 15.7 minutes instead
  of the 14.2 it would on the flat, and 14.9 back down (steep in places).
- **The way taken** (Settings › Changes and walking): a hill also costs effort that only the choice of way sees, worth
  about 2 m of flat walking per metre climbed at 6 %, 4 m at 10 %, 6 m at 15 % (steep descents a little). By default
  the engine walks round a hill when that costs about a minute at most for a short one. **Avoid hills** triples the
  effort: a flatter way even when it is a few minutes longer. **Hills don't bother me** leaves it out: the quickest
  way, uphill or not (its time still counts the climb). In a wheelchair grades over 6 % cost more on top, up or down
  (SN 640 075's limit for footways), unless hills don't matter.
- **Flatter way at changes** (on unless hills don't matter): a change with time to spare is walked the way a walker who
  avoids hills takes, when it climbs at least 5 m less and the connection still has a minute in hand beyond the extra
  change time; the walk says so first ("There is time for a flatter way: 20 m less uphill, 1 min longer"). With
  Avoid hills a change is walked the flatter way whenever it fits, and the quicker one when it does not.
- **Shown**: a walk that climbs 10 m or more says so beside its metres ("↑ 25 m").
- Bridges and tunnels climb evenly between their two ends on the ground (not down to the river under a bridge or over
  the hill above a tunnel); indoor ways, platforms, lifts and escalators are flat; outdoor stairs climb the height
  between their two ends, as effort (their time is the stairs' own).
- Checked against the City of Bern's street slopes (`data/street-slopes.geojson`, 3 382 segments of 30 m or more): the
  grade from the terrain model is within 0.35 % of the city's on the median segment (90 %: within 1.3 %), on 98 % it
  climbs the same way, and on 91 % it falls in the same class (flat, moderate, steep, very steep).
- Without the terrain model (`kante/scripts/fetch-data.sh --elevation`, 10 GB) walks are timed as if flat and the hills
  settings change nothing; `/api/meta` counts `slopedEdges`.

## The engine's walk

The fields of a walking leg are in `KanteWalk` (`src/types/kante.d.ts`, `kante/engine/crates/server/src/json.rs`):
`geometry`, `levels`, `steps`, `distanceM`, `durationS`, `climbM` / `descentM` and `flatter` (a change walked round a hill), and from engines that know doors `door`, `startDoor`,
`covered` (vertex ranges), `approxStart` / `approxEnd`, `noStepFreeDoor` and `closedM` (metres on ways closed at the
walk's time). An engine without them still gives the
path; the page then draws it without a door. `/api/walk` takes, for each end, a boarding point (`quay`: its id or
SLOID), a point taken as it is (`exact`: where a station model's paths begin) or a coordinate, and `time` (when the
walk sets out, Unix seconds: ways closed then are avoided; without it every way is open).
`KanteJourney.routed()` turns a walk into the shape the page draws (`src/engine-journey.ts`; an `approximate` one is
the straight line with the engine's time, metres and "Walk about …" direction); `routeWalk()` in `src/app/routing.ts` asks for one. A walk moved since the
plan through a station whose model has no route (or does not load) is asked for once, along the streets. A walk the
model draws takes the time of the way drawn: the model's for its part, the engine's for the stretches before and
after it. Between the start and the model only a stretch under 2 m is left out; the stretch from the model to
the destination is asked for however short it is, so the engine leads the last metres to its door. A walk to the
destination of a few seconds stays in the trip when it ends at a door ("< 1 min").

## Data

`kante build` (see `kante/README.md`) reads OpenStreetMap and, when it is there, the official building address register
(swisstopo's "Amtliches Gebäudeadressverzeichnis", `data/raw/register/adr.csv.zip`, ~140 MB, fetched by
`kante/scripts/fetch-data.sh`, which keeps the file there is when a download is cut short or has another layout).
Nationally: 2.78 million buildings, 156 000 mapped entrances, 2.75 million register doors; 2.91 million doors on 2.44
million buildings, 69 000 of them with no way onto the network (`doors.bin`, 308 MB in the server: outlines 107,
doors 67, ways out 53, addresses 46, grid 35). The `buildings` and `doors` steps take about 13 s on 32 cores, and the
walking graph has 8 % more edges than without the joins across platforms and squares. `/api/meta` counts the doors;
`deploy.sh` logs a warning when there are fewer than a million (the register missing).

## Measured against the browser's own router (2026-11-23)

Until this change the page drew walks with its own router on a network built for five cities (`walkgraph/`, 55 MB).
Both were run on the same walks: from each city's main station to its ~70–85 places within ~1 km
(the places of `tools/walk-eval/` at the time), normal and step-free (stairs never, no escalators), and between all
numbered platforms of the station (both ways, normal and step-free), against the buildings, doors and ground-level
tracks of the browser's tiles. "Engine before" is the engine on `main` before this change.

| | Bern | Zürich | Basel | Geneva | Lausanne |
|---|---|---|---|---|---|
| Doors reached: browser / engine before / engine | 58 / 2 / 57 of 58 | 57 / 4 / 56 of 57 | 57 / 4 / 56 of 57 | 65 / 4 / 64 of 65 | 68 / 6 / 68 of 68 |
| Walks with ≥ 3 m through a building at street level | 0 / 4 / 0 | 0 / 0 / 0 | 1 / 2 / 0 | 1 / 2 / 1 | 0 / 2 / 2 |
| Median length (m) | 459 / 457 / 457 | 606 / 510 / 555 | 685 / 696 / 696 | 574 / 583 / 602 | 665 / 718 / 687 |
| Walks ending with a guess (dashed; before: a last straight bit over 20 m) | 2 / 7 / 4 | 8 / 7 / 7 | 13 / 8 / 5 | 6 / 5 / 5 | 17 / 4 / 8 |
| Platform changes across tracks on the ground | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 84 / 0 | 0 / 0 / 0 | 0 / 32 / 0 |
| Platform changes with no route (of all, both profiles) | 132 / 0 / 0 of 612 | 0 / 168 / 46 of 1104 | 0 / 0 / 0 of 924 | 0 / 0 / 0 of 112 | 32 / 0 / 0 of 144 |
| Platform changes: median engine ÷ browser length; pairs over 1.5 × | – / 1.01, 16 / 0.98, 8 | – / 1.32, 242 / 0.56, 3 | – / 1.02, 69 / 1.00, 20 | – / 1.00, 14 / 0.98, 0 | – / 1.00, 2 / 0.97, 0 |

- Walks ending with a guess: door lines over 20 m (a sidewalk farther away is preferred to a main road), doors joined
  only through their own house, and buildings with no usable door, all drawn dashed; none of these walks is longer or
  crosses a building.
- A change at Renens VD, platform 5 → 1: 200 m on the browser's network, 764 m on the engine before (along both
  platforms and round by Place de la Gare), 189 m now (the near ramp and underpass); 3 → 2 (one island): 423 → 11 m.
- One place in each of four cities ends without a door on the engine where the browser found one; these were not
  examined one by one.
- Zürich's 46 step-free changes without a route are those to and from tracks 41/42 (Museumstrasse): the browser's
  "step-free" way there joined two floors where only stairs and escalators are mapped.
- The start points lie inside the station buildings, mostly right on an underground corridor, so the engine starts
  there and more walks take stairs up than the browser's (which started on the street level); step-free walks have
  none.
- The browser router's paths from swissTLM3D (paths outside towns OpenStreetMap lacks) were used on 1 of these 382
  walks; the engine has no swissTLM3D paths. Not added (November 2026): its paths come as a 3.6 GB (SHP) or 4.8 GB
  (GPKG) download, about 0.5 GB of it roads and paths, once a year; reading it needs a shapefile or SQLite reader
  the engine does not have, and joining it to OpenStreetMap without doubling the paths both have is the work of
  days (the browser's tool dropped TLM lines within 12 m of an OSM way); swisstopo's open-data terms do not name
  swissTLM3D explicitly. Worth it only if long walks out of town become a goal.

Sources: © OpenStreetMap contributors (ODbL), © swisstopo (building address register, swissALTIRegio).
