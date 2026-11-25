# The inside of a station in 3D (continuous view)

`station3d-solid.html?key=zurich` shows a station as **one building at true heights**, not as floors pulled apart:

- floors as slabs at their real heights (stretched ×2.2 upwards by default, so the floors read; ↕ switches to 1×),
  with the **wells** cut out where stairs and escalators go up or down through them;
- every **escalator** as a band with chevrons in its running direction (teal = up, orange = down, grey = unknown) on a
  closed truss, with glass balustrades and a handrail; every **stair** as a solid flight: all its steps (from
  OpenStreetMap, else its rise; never treads under 28 cm in plan, finer ones alias from afar), the strings along its
  sides down to a sloping underside, and handrails (stairs OpenStreetMap draws steeper than 40° as a striped slope);
  **lifts** as glass shafts between the floors shown, with a quiet ring at each floor they stop at — the lift the way
  rides keeps its shaft in view (the cut does not take it) and has rings in the way's colour where you get on and off;
  ramps as slopes; a landing where a stair ends on no floor of the model (a street bridge, a pavement);
- walls where OpenStreetMap has them (doorways left open), kerbs at the edges of indoor floors, railings round the
  wells, named rooms as low opaque blocks (their height is schematic: they mark the shop without hiding the way), and
  **pins for shops and services** (209 at Zürich HB, all of ShopVille and the passages);
- tracks with their beds, platform numbers, sector letters, the names of the halls and passages, entrances;
- **round the way**: tickets, toilets, information, meeting points and lockers within 35 m of it are named on it, and
  the buildings within 130 m are drawn as faint footprints, the named ones (Sihlpost, KKL, the main hall) as quiet
  landmarks for the way out;
- **your way** as a yellow tube through it all, with small arrowheads every 9 m in the direction you walk; thinner on
  stairs, escalators and ramps so the steps under it show; through the escalators and down the lift shafts. The
  floors above the way are cut open along it (a corridor cutaway: the rest of each floor stays), and a faint copy of
  the tube shows through any floor that still hides it. In a step, the play-through and while following you, whatever
  stands above the floor in focus between the camera and it is cut out too (a round see-through hole), so no floor or
  shop hides the step. Stairs, escalators and ramps are cut or kept whole by where they start (cutaway's `base`): one
  that starts at or below the floor in view shows all the way up to the floor it reaches, not just its first steps.
  On walks the tube follows the same path as the walker and the eye (below), in the open part of a passage.

## The card

The step at hand, the train and the notices are one **sheet** at the bottom. It opens at its smallest (the step in a
line and its buttons first, then where to get on), is dragged up by its grip (or anywhere on it that is not a button) to half the
screen (the coaches, the legend) or to all of it (with the list of steps), and remembers the size. In first person and
while the way plays it drops to its smallest by itself and comes back after. The view frames the way in what the sheet
leaves free (the camera's centre is moved up by an off-centre projection, `setInsets`; not in first person, so the
horizon stays put), and labels under the sheet are not shown.

## Guidance in the model

Labels stay few on purpose. With the whole way shown, each change of floor is a small chip ("Lift ↓ −4"). Once you
go step by step, play the way through or walk it, **one sign** names the manoeuvre at hand: the step's own stair,
escalator, ramp or lift, or on a walk the next change of floor, with the distance to it ("In 25 m **Lift ↓** −4
Löwenstrasse"); in a lift or on an escalator it rides along. The piece of the way the step covers is drawn thicker
with a white casing. The full sentence ("Take the lift down to platform 32") is in the card, with what comes next.

- **Play-through** (▶ in the card): a walker goes the way at about six times walking pace and the camera follows
  behind and above it; the card and the sign change as it reaches each step. The timeline is made of the router's
  seconds per step, so a lift ride (no metres) takes its time too. A drag, a step button or a floor pauses it. With
  reduced motion it goes step by step (every 3.5 s) instead.
- **Where you are** (`setUser`, fed by the app's GPS and the indoor position of `indoornav.ts`): a blue puck with its
  accuracy and heading. On the way (within 25 m, accuracy 40 m or better) it also sets the step at hand: after two
  fixes on a new step or 3 m into it, never within 20 s of you stepping through the way yourself, and without moving
  the camera. The ◎ button follows you (a drag stops it).

- **First person** (👁 in the card, then ▶): the play-through at eye height (1.65 m) and true heights (1×), with fog
  for what is far; below ground the distance is dark (a tunnel, a hall's far end), at street level it is the sky. The
  model is closed and dressed for it (small canvas textures drawn once, `surfaces()`):
  - **walls** as high as the room (to the floor that lies over it, at most 3.4 m — not merely the next level of the
    table: Zürich's −3 is 1.8 m above −4, elsewhere): below ground the walls the **cadastral survey** measured (where
    its outline of an underground building or underpass runs within 1.5 m of the floor's edge; the floor is drawn on up
    to them) and every other edge of a floor except the platform edges along the tracks, at street level and above the
    edges of the indoor floors, and OpenStreetMap's own walls. They are schematic (OpenStreetMap has the outline, not
    the wall; the card says so), in panels with a skirting and soft shade at the foot and under the ceiling. Each wall
    **opens where you walk**: wherever the way, a path of the walking graph, a stair, an escalator or a ramp crosses it,
    so the way never runs through a wall; openings less than 1.2 m apart are one, and what is left between them under
    1 m (a blade) goes;
  - **floors** of stone tiles, open where a stair or an escalator passes under them within head height (so the eye
    never goes through a floor on the way down); a floor with tracks is drawn thick enough to reach below their bed;
  - **ceilings** below ground at the room's height with panels and light strips, open over every stair, escalator,
    ramp and lift that passes through and over the wells of the floor above, seen from below only;
  - **tracks** in a trough: concrete bed, rails, the white safety line 1.2 m in from every platform edge; below ground
    a ceiling over the tracks 4.1 m up (a double-deck coach fits), the drop to it along the platform edge, and a wall
    along the outer side of the outer tracks, so past a platform's edge there is a station, not the void;
  - **shops** as fronts to the ceiling in the colour of their kind (a plinth, glazing between mullions lit from
    inside, a fascia): a room of OpenStreetMap all round its outline, a shop mapped only as a point (all of Zürich's
    ShopVille) as a front 4 m wide on the wall nearest it (within 5 m). A room the way walks through is not drawn
    (OpenStreetMap's path runs through it). Names come from the labels: only of your floor, not behind a wall or a shop
    (tested in the floor's plan, four times a second);
  - **stairs** with closed strings, a balustrade and a handrail on each side; escalators with their handrails;
  - the survey's **pillars** (to the ceiling, or up to the canopy over them) and **platform canopies** (at the height
    of a building or roof of the model over them, else 4.6 m);
  - the eye, the yellow line on the floor (and the walker of the play-through, and the tube in the model) follow one
    smoothed copy of the way: on walks averaged over ±2.5 m (OpenStreetMap's corners and zig-zags rounded; stairs,
    escalators and lifts keep their own line), then moved **into the open**: OpenStreetMap often draws a passage's path
    along one side of it, or a hall's along its wall, so at each point the place square to the way (up to 4 m either
    side, on a floor, not across a wall) with the most room up to 2.8 m round it is taken: the middle of a narrow
    passage, 2.8 m off the walls of a wide one (`centre`, smoothed over ±6 m; it tapers off over 4 m to the ends of a
    walk and to where the way goes through a doorway, so it meets the stairs, lifts and doors where they are). Then it
    is kept 0.65 m off walls, pillars, railings, lift shafts and shops (a point inside a shop is moved out through its
    nearest side), and wherever the result would cross any of them the way keeps its own line.

  First person's shader programs are compiled ahead, while the view is idle (`prewarm`), and the trains' skins are
  uploaded when they are made: entering first person and a train coming into view do not stop the view.

  The eye looks where the way goes 7 m ahead (2.5 m on stairs and escalators, pitch at most 20°), turning by yaw and
  pitch. In a lift you stand in its car, drawn round the eye: steel doors with glass in them, glass sides (the floors
  go by), a handrail, a light in the ceiling, and over the doors its display (the way it goes, the floor it passes);
  the lens widens to 64° in the car, and a small chip at the top says where it goes. Out of a lift at the end the eye
  turns along the platform, or to the door of your coach when a train is there. Paused, a drag looks round; ‹ › go to the start of a
  step; a floor, ⌂, ◎ or 👁 again leave it.

What it does not have: inner walls (the survey has only the outer outlines of what is built below ground, and no
heights), signs at eye level, the survey at Lausanne and Luzern (Vaud and Luzern do not publish it openly). Where such data
could come from (the cadastral survey's underground outlines are open data and the most promising; Google's and
Apple's indoor data cannot be used) is in [station3d-interior-data.md](station3d-interior-data.md); more open data and
covering every Swiss station in [station3d-research.md](station3d-research.md).

When the walk ends at a platform to board a train, that train stands at the platform as a hologram: its coaches,
their classes, where to get on (the walk is aimed at that sector) and how full each class is expected to be. See
[train-formation.md](train-formation.md). It stands on its rails (on the track bed, under the platform's edge) and fades into the
fog in first person. When the journey gives no train there (the view opened from a platform, the presets of the
development page), a **typical train** stands at the platform the way ends or starts at: four plain coaches round where
the way arrives, quieter, with no classes and no boarding zone, single-deck on narrow-gauge track; without sectors in the
model (Bern's RBS platforms) it stands along the platform's own walkway. The shimmer redraws the view only while a train
is in view. Trains at other platforms are not drawn: they would read as yours.

Step by step (**Next ›**), the camera looks across each floor change so the climb shows in profile, a stair or an
escalator close up; **Whole way** shows it all. The floor buttons lift away everything above a floor (its outlines stay, as a ghost). Labels are
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
| `tools/station3d_data/<key>/av_objects.geojson`, the `av` layer of `stations3d/<key>.solid.js` | `tools/station3d_av.py <key>` | the cantons' cadastral survey (Amtliche Vermessung, Einzelobjekte) via geodienste.ch: ZH, BE, BS, GE |
| the walking graph of `stations3d/<key>.js`, repaired | `tools/station3d_clear.py <key>` | the companion: wells, lift shafts, railings, walls |

```bash
python tools/station3d_sbb_layers.py zurich   # SBB layers (cached in tools/cache/)
python tools/build_station3d.py zurich         # the model (downloads OSM once, cached)
python tools/station3d_solid.py zurich         # the 3D companion
python tools/station3d_av.py zurich            # the cadastral survey's layer (also merged into an existing companion)
python tools/station3d_clear.py zurich         # the walking graph kept out of wells, lift shafts and walls (last)
```

**Walls and the way.** OpenStreetMap's paths and the builder's links across open floors are straight lines, and some
ran across the well of a stair or an escalator, through its railing or through a lift's glass shaft (a third of the
routes at Zürich HB, a tenth at Bern): the way went through them, and in first person so did you.
`tools/station3d_clear.py` repairs the model's graph with the companion's geometry: a node standing in a well or a
shaft is moved out onto the floor; a link through an obstacle is dropped where the graph already has a way round no
longer than 1.6 times it (+25 m) in each direction it goes and as usable (not closed, step-free where it is), else
bent round it inside a corridor along it (never to another platform); the step onto a stair, an escalator or into a
lift's own door is allowed. It writes nothing if any node of a stop or an entrance would reach less than before
(walking or step-free, with or without the edges that have closures) and lists what it left (a few short links at stair heads where the platform is
nearly all well). In first person the smoothed line and the eye keep off railings and the shafts of lifts you do not
ride as off walls, a smoothed corner that would cut through any of them keeps the way's own line, and the eye looks
less far ahead where the way turns round a wall. A link the builder made up (`inferred`) no longer opens a doorway in
a wall.

The companion file is separate on purpose: the model format stays as it is, and the router and the indoor position
read only the model.

On the development page, `&simulate=4` walks a made-up position along the way at four times walking pace (a fix a
second, 3 m of noise), as the indoor position would feed it, and `&follow=1` has the camera follow it.

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