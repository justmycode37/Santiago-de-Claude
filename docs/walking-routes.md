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

## The engine's walk

The fields of a walking leg are in `KanteWalk` (`src/types/kante.d.ts`, `kante/engine/crates/server/src/json.rs`):
`geometry`, `levels`, `steps`, `distanceM`, `durationS`, and from engines that know doors `door`, `startDoor`,
`covered` (vertex ranges), `approxStart` / `approxEnd` and `noStepFreeDoor`. An engine without them still gives the
path; the page then draws it without a door. `/api/walk` takes, for each end, a boarding point (`quay`: its id or
SLOID), a point taken as it is (`exact`: where a station model's paths begin) or a coordinate.
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
  walks; the engine has no swissTLM3D paths.

Sources: © OpenStreetMap contributors (ODbL), © swisstopo (building address register).
