# Where walks start and end

A walk from a place (an address, a pin, the user) or to one leaves the walking network somewhere near it. The engine
decides where in one function, `kante_link::ends::End::sources`, which both the stop search of a journey
(`reach_costs`, `/api/plan`, `/api/reach`) and the walk drawn (`walk` and `draw`, `/api/walk` and a journey's
walking legs) take their starting points from, so the two cannot choose differently.

## The rules

**The point itself is always a candidate**, by several straight lines onto the network (`point_candidates`): onto
the way `main`'s engine snaps it to (`snap_main`: the nearest within 60 m that is not a main road, else within 250
m), onto the nearest way on the ground (`snap_point`: not into an underpass below or onto a bridge above, covered or
not, unless the point is right on it, 3 m, and nothing on the ground is within 10 m), and onto up to six more ways
within 40 m (or 20 m beyond the nearest). A line onto a way in a tunnel or on a bridge that the point is not right
on counts 40 m more in route choice. A snap from which the other end cannot be reached is then simply not taken. A
station asked for by its id is entered at street level from the nearest five ways on its ground floor within 120 m
that are not platforms (`station_candidates`, the first the one `main` takes).

**A building's doors** are candidates next to them when the point is in a building: inside to the door, then out of
it along one of its ways out. Every door is tried. The line inside to a door is through a wall (a guess) when it
runs through another building, or leaves this one on the way: somewhere, at points every 5 cm, more than 0.3 m
outside its outline (across a U's open side, round a corner, through a jog in the wall; `DoorIndex::leaves`). This
building's own outline is not otherwise a wall to it: a point near the wall and the door on it would both touch it. A step-free walker may not use a `wheelchair=no` door and
prefers (by 5 m) one known to be step-free. Back doors, garages and register points carry the penalties of
`DoorKind::penalty_m` (route choice only), and so do (`ends::DOOR_*_M`): another mapped door than the main entrance,
3 m; a door that looks onto another street than its address's (`Door::faces`), 15 m; when the place was asked for
by an address that a door of its building has (its name, `End::place_at`), every other door of it, 20 m.

**Reached when some walk gets there within the limit** (`reach_costs`). The limit is the journey's longest walk less
the 30 s buffer, as before, and a walk is within it when, rounded up to the whole second as `/api/reach` reports it,
it is. Preferences (route choice penalties on the way, and those of the candidates) only choose among the walks
within it: the walk the router finds best from all candidates, if it is within the limit; else, for a stop some walk
reaches in time (one search by walked time alone, `WalkRouter::quickest_many`: what the walker cannot use stays
out, nothing else counts), the cheapest with its penalties of each candidate's best walk among those within it, or
that quickest walk. Only the nearest eight candidates of each doubt (by their line onto the network) have their own
best walk tried, one search each (`PREFER_AT_MOST`; a building can have a hundred doors); the others keep the
quickest walk, which is always a true answer. On the national samples this changes no stop and no time. So the doors and the other lines only add stops to what `main`'s own line reaches, and a penalty
never loses a stop some walk reaches in time. The route-choice preferences of the network (`docs/walking-routes.md`,
"Which way": sidewalks drawn apart, turns, busy roads crossed where no crossing is mapped, car-only roads, footways,
closed hours) are penalties of the same kind: the quickest walk leaves them out. Only `crossing=no` is not crossed by
the quickest walk either (the walker may not cross there; along the road is still walked). On the national samples
(24 000 points, nine profiles and limits) no stop is lost or gained against `main`; a stop is reached later on its
preferred walk (median 3–8 s, 95 % within 22–53 s).

**Lines are tried by how much of a guess they are** (`Join::doubt`): first the short lines onto a way at hand (doubt
0); then lines longer than 20 m, across ground with no mapped way (1); then lines through a building, across a
railway track on the ground, or onto a way in a tunnel or on a bridge the point is not right on (2; for a point right
on a bridge with no ground near, any line longer than 3 m, which leaves the bridge sideways). Each doubt is a
candidate only for the stops no less doubtful line reaches in time, and each end of a walk is tried from its least
doubtful lines; so more time never loses a stop, for any walker. A boarding point keeps `main`'s link, but its
straight line to the link is a guess in the same way (not a railway platform's point, which often lies on the
track). A walk with a guessed end (any doubt, a line longer than 20 m) is drawn as a guess (`approxStart` /
`approxEnd`) and is never step-free; in the step-free and wheelchair profiles a journey's walk with one (first,
last, change, or the walk-only answer) carries an alert saying so.

**A journey's first and last walks are timed by the walk drawn**, in travel order (the stop search runs from the
place outwards; a longer drawn walk first takes the 30 s wait at the stop); an arrive-by journey that then arrives
after the time asked is dropped. Such a walk may differ from `/api/walk` for the same ends: when the less doubtful
line does not get there within the walking limit, the journey takes the more doubtful one (and marks it), while
`/api/walk`, which has no limit, takes the less doubtful one however long (nationally, 2 of 22 803 wheelchair walks
take a way out a door gained since, 1.6 and 4 times as long, rather than a guess). When the preferences make a long
walk feel longer than the search gives itself (four times the beeline and half an hour), the quickest one is drawn.

**Through a building** is geometry (`doors::through_building`): the straight line is cut where it meets each
building outline (every building of OpenStreetMap, courtyards excluded); a piece inside a building that somewhere
is more than 0.2 m from its outline runs through it (its middle, else points every 25 cm and every 5 cm within 60
cm of an end on the outline; within half a metre of such an end, a door a few centimetres off it, a point counts
only when more than 0.25 m in). Not counted: a building the line stays in (both ends in it or
on its outline, not both on it, and no piece outside it — inside to the building's own door, from its door to its
own corridor; across the open side of a U-shaped building it does count), and, for a line to a way under an arcade,
the last 5 m (the walkway under the building's front; the rest of the line is still tested). Such a line counts four
times its length plus 200 m in route choice (as an emergency exit: only when nothing has a real way out), and a walk
that takes it is drawn as a guess (`approxStart` / `approxEnd`) and is not step-free. A line onto a main road walked
on the carriageway, or onto a carriageway whose sidewalks are drawn apart, counts four times. A line that walks over
a carriageway on the ground to reach another way, more than half a metre from its ends (the sidewalk across the
street; `doors::crosses_carriageway`), counts twice over a busy one (tertiary and up, or one whose sidewalks are drawn
apart) and 1.5 times over another: the near side is taken unless it is twice as far.

## Doors (`kante build`, `doors.bin`)

- A building's doors are its mapped entrances. A building with none gets a door at each address of the official
  building address register that belongs to it (the point is in it, or its outline is the nearest within 8 m),
  on the nearest stretch of outline (within 12 m) that faces the open — 1 m out is neither this building nor
  another — and has a way out that does not run through a building (of the nearest four such stretches; else the
  nearest). Two addresses within 2 m are one door ("Bahnhofstrasse 12, 12a").
- Ways out: straight lines of up to 80 m from the door to walkable edges (no stairs, escalators, lifts,
  underpasses), never across a railway track on the ground however short the line (a track in a tunnel, on a
  bridge, or on another layer or floor does not count). The three cheapest, each onto another way, are kept, and
  the cheapest when a line over a carriageway counts more (see above), if it is another one: no door loses a way out
  it had (1.38 million of 8.27 million ways out walk over a carriageway).
- Whether a door looks onto its address's street (`Door::faces`): the nearest named carriageway within 30 m, the
  line to it through no building, has the street of its address (1 422 601 doors) or another one (273 947); not
  known without an address or a named street near.
- Every building is kept, with doors or not, so that a line through any of them is seen.
- `kante build` needs the building address register (`raw/register/adr.csv.zip`, `scripts/fetch-data.sh
  --register`): without it, or with one it cannot read or that gives fewer than a million doors, the build fails;
  `--without-register` builds with OpenStreetMap's doors only (a regional extract, a test).
- `doors.bin` also keeps the railway tracks on the ground, for the doubt of a line across one.
- `doors.bin` names the walk graph it was built for (`graph_fingerprint`: every node, edge and point of geometry),
  and `links.bin` the walk graph and the timetable (`Timetable::stops_fingerprint`): the server ignores one built
  for another, and `kante build` builds it again whenever its inputs were built again, are another build, or it has
  another schema.

Nationally (November 2026 data): 2,782,877 buildings, 2,902,150 doors (156,434 mapped, 2,745,716 from the
register), 21,212 doors with no way out within 80 m, 55,341 joined only through a building (1.9 %: mostly sheds and
annexes behind a house, a third of them register sub-addresses such as "5.1"). The index takes about 330 MB in the
server.

## Lifts

A lift drawn once per floor (Zürich HB) is one lift. Joined are only outlines each drawn for one floor (an outline
with several levels is a lift of its own; one without a level is never joined: its floor is not known), of the same
access, whose polygons overlap or lie within 0.5 m of each other, closest pairs first, and never so that one lift
would get two outlines on one floor — two shafts side by side that serve a common floor stay two lifts, also through
a third outline. A lift shaft drawn as a hole in a platform or hall is walked as that area's edge and is a lift too.
A lift tagged with one level more than its levelled ports name puts its unlevelled ports there only when they are
all on one layer; on several layers they stay apart, unlevelled.

## Measured against `main`

`kante/tools/compare` builds nothing itself: build both engines from the same raw data, start them, and run it (its
README). The numbers for this change are in the pull request that made it. Whether a walk is the one a person would
take is measured on the reference walks (`kante/tools/refwalks`).
