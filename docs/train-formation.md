# The vehicles at the platform (3D station view)

The 3D station view shows the vehicles of the journey where the walk meets them: the train (tram, bus) the walk
leads to, the one it starts from when you arrive, and both at a change. For a train:

- the train as a **hologram on its track**: double-deck coaches (the IC 2000 / Twindexx / KISS shape most SBB trains
  have) and locomotives, each at its real length, with windows, doors, the yellow band of 1st class, the red one of a
  dining car and the class numerals by the doors;
- **which coach**: one coach chosen for the whole ride (below), drawn in the way's yellow with its stretch of
  platform lit: "Get on here · sector C" where you board, "You get off here" where you arrive. The walk leads to its
  door and on into the coach (a short stretch of the way drawn through the door), and where you arrive it starts
  inside the coach;
- **how full**: the occupancy forecast for each class (few, some, many people), as a coloured strip under each coach
  and as bars on the labels and in the card;
- a **card** with the coaches in a row as they stand (sector A on the left), wheelchair, bike and family coaches,
  closed coaches struck through, and where the train splits.

## Which coach

Chosen once per ride (and class and access settings), the same at every station of it (`src/coach-plan.ts`): among
the coaches that suit you (below), the one with the shortest walk **to its door** where you get on plus **from its
door** where you get off: to the next platform or the way out at a change or at the end. Each walk is the station
router's, to the door itself (the router aims at the point of that platform's walkway in front of the door, `{ stop:
{ at } }`; where the door is not near the walkway, at its sector). A walk is weighed only where the station has a 3D
model; the card says which were. A ride on which you stay seated across trips (another train number) is chosen at
the boarding end only.

**Trains in a row** (a change from train to train, without a walk out of the station between) are chosen together,
for the shortest walk over all of it: to the first train, from coach door to coach door at each change, and from the
last train (dynamic programming over the coaches of each train; `planChain` in `coach-plan.ts`). So the coach of the
first train can be one nearer the stairs to the next platform rather than nearer the way in. A change that cannot be
weighed (a station without a model) counts as nothing; a train that cannot take part (no formation, no coach of your
class) leaves the others to be chosen on their own, each from the door of the coach before.

When the train you arrive in and the one you take stop at the **same track** (or the same tram or bus stop), they are
there one after the other: the view draws the one you take, and the card of the other has a button to show it
instead.

**Crowding does not take part.** SBB forecasts coach-level occupancy for some trains for its own displays, but no
open feed publishes it: the open forecast is one figure per class for the whole train, which cannot tell two coaches
of your class apart. A rule such as "coaches near the stairs fill first" would steer you away from the stairs you
need, without any observation behind it. So the card shows the forecast per class as it is ("expected from here,
for the whole train"), and the coach is chosen by the walk alone.

## Trams and buses

No open data says which tram or bus runs, nor where exactly it stops. The view draws a **typical shape**: a tram of
36 m in four parts (Bern's, Basel's, Zürich's and Geneva's are 32–43 m), an articulated bus of 18 m, with its front at
the stop and pointing the way it travels (from the ride's direction: its departure bearing, or its last stretch on
arrival): a tram on the nearest tram track of the model, a bus in the lane beside the stop (on its right). The label
and the card say the shape and place are approximate. Without the direction of travel it is not drawn. The walk
leads to the stop as before.

## Without the order of the coaches: the nearest door

When no coach of your class can be chosen (no formation: the engine has no key, or the train has none; or none suits),
the way still leads into the train (`planNearestDoor` in `src/coach-plan.ts`): the train is laid over the sectors the
timetable gives it ("7A-D"), each coach a usual 26.5 m, and of all their doors the one with the shortest walk is
chosen. That coach is drawn in the way's colour ("Nearest door · sector C"), the walk goes through its door, and the
card says why it is not a coach of your class ("Where its 1st class coaches are isn't published for this train", with
how to tell them on the platform). Without the timetable's sectors either, four coaches stand round where the way
reaches the platform and the card says the stopping place is not known. When the formation is known but none of its
coaches suits (no open coach of your class, none with wheelchair spaces), it is the nearest door of an open coach
with seats of the train as it stands (never a locomotive, a closed coach or the part of a splitting train that goes
elsewhere); when the data cannot say which part goes on, none. Where the model has no sectors at that
platform, nothing is planned (where the train stands would be a guess). No keyless source has the coaches' positions
at a platform, so it cannot be the nearest coach of your class.

A coach chosen after you started the steps, first person or the play-through (the formation arrives late) does not
throw you back to the start: the way is aimed anew and you stay at the step nearest where you were
(`reaim` in `src/station3d-solid.ts`).

## Who may get on

Only coaches that fit are suggested: open, of your class, with wheelchair spaces when a wheelchair is set in
Settings, and, on a train that splits on the way, in the part that stops where you get off. When the data cannot
confirm one of these, the card says which, and the walk leads to the platform as before.

## Where the data comes from

| What | Source | Key |
| --- | --- | --- |
| The coaches, their order, the sectors each stands in at each stop, classes, wheelchair / bike / family spaces, closed coaches, where the train splits | [Train Formation Service](https://opentransportdata.swiss/de/cookbook/formationsdaten/) of opentransportdata.swiss, `formation/v2/formations_full` (SBB, BLS, SOB, Thurbo, RhB, zb, TPF, transN, MBC, ÖBB, SZU) | yes |
| How full, per class | the occupancy forecast (SBB, BLS, SOB, Thurbo, zb), as [transport.opendata.ch](https://transport.opendata.ch/docs.html)'s station board passes it on (`capacity1st` / `capacity2nd`) | no |
| Where it stops, without the formation | the sectors the timetable gives the train's platform ("7A-D") | no |
| The platform's sectors in 3D | the station model (`sectorSpans`, else `sectors`; SBB open data) | — |

The occupancy forecast is **one figure per class for the train** (from this stop to the next), not per coach: no
open source has the crowding of single coaches. The view says "expected" next to it.

The formation says which sectors a coach is in, not where in them. The coaches are laid end to end at their real
lengths and the whole train slid along the track to where it fits the sectors best (`src/train-layout.ts`).
Where the model has no sectors for the platform (Bern's RBS platforms 21–24, many narrow-gauge and smaller
platforms), the 3D view still draws the train, along the platform's own walkway (`layoutTrain(…, { approx: true })`:
centred on it, or filling it), single-deck on narrow-gauge track; such a layout is `guessed`, so no door is planned
from it.

### The key

The formation service needs a key, and a key cannot go into a public page. So the app asks the Kante engine,
`GET /api/formation?evu=SBBP&date=2026-11-24&train=1083`, which holds it and passes the service's answer on
(`kante/engine/crates/server/src/formation.rs`): answers are kept three minutes (ten when there is none),
requests for the same train at once share one call, and no more than 30 calls a minute and 18,000 a day go out
(the plan allows 50 a minute, 20,000 a day).

On the server: subscribe the key to **Train Formation Service** in the
[API manager](https://api-manager.opentransportdata.swiss/) and add it to `secrets/otd.json` as `"formation"`
(`{"siri-et": "…", "formation": "…"}`), or set `KANTE_OTD_FORMATION_KEY`. Without it `/api/formation` answers 503,
and the view lays the train over the timetable's sectors (coaches without classes) and leads the way to its
**nearest door** instead of a coach of your class (below).

To try it on your own machine without an engine that has a key, put the key in `config.js` as `formationKey`: the
page then asks the service itself. Never on a public site.

The service has today and up to three days ahead.

## Code

| File | Does |
| --- | --- |
| `src/train-formation.ts` | loads the formation and the forecast, reads the formation's answer, picks the coaches for your class |
| `src/coach-plan.ts` | the coach for the whole ride: the walks to and from its doors at both ends |
| `src/station-route.ts` | `{ stop: { at } }`: the router's endpoint at a point of a platform (a coach door) |
| `src/train-layout.ts` | lays the coaches along the platform's track of the station model; a tram or bus at its stop |
| `src/station3d-solid.ts` | draws the hologram, the boarding zone and the labels (`setTrain`) |
| `src/station-view.ts` | the card, your class, aims the walk at the sector |
| `src/app/sheet-content.ts` | `s3Plan()` hands the vehicles of the rides before and after the walk to the view, with both ends of each ride |
| `tools/test_train_formation.mts`, `tools/test_coach_plan.mts` | tests (made-up answers in the service's shape; real station models) |

`station3d-solid.html?key=bern&from=entrance:Bahnhofplatz%20(main%20hall)&to=stop:8507000:7&train=demo` shows a
made-up IC 2000 at Bern platform 7 (`&train=sectors&sectors=A-C`: the timetable's sectors alone; `&step=last`: the
last step, close up).
