# Journeys, departures and live data

Everything the app knows about public transport comes from the team's Kante engine (`kante/`, hosted at
`https://kante.omniroute.app`; its API is in `kante/engine/crates/server/src/json.rs` and
[`kante/docs/LIVE-API.md`](../kante/docs/LIVE-API.md)). There is no second timetable behind it: when the engine is
switched off or cannot be reached, the app says so where a journey or a departure board would be, and the map,
search, events and places go on working.

## The engine's client: `src/engine.ts` (`KANTE`)

The one place that knows where the engine is and whether it is up.

- **Address.** `APP_CONFIG.kanteUrl` in `config.js` (`''` switches the engine off), else the hosted engine.
  `?engine=off` or `?kante=off` in the page address switches it off; `?kante=<url>` points the page at an engine on
  this machine (`localhost`, `127.x`, `[::1]`). Any other `?kante=<url>` is ignored (and logged): the engine learns
  where the traveller is and where they are going, so a link may not choose who receives that.
- **Availability.** A failed request (no answer, too slow — the timeout covers the body too —, a 5xx, a 429)
  marks the engine down; any answer, a refusal included, marks it up. Nothing is held back while it is down: each
  caller asks at its own pace (live trips every 30 s, vehicles every 15 s, Scan every 15 s, the meta every 30 s while
  it is not known), so every attempt is a real request.
- **Features.** `/api/meta` is asked once the engine answers; `KANTE.has('stream' | 'due' | …)` reads its list.
- **Errors.** Every call returns the engine's JSON or throws a `KanteError` whose `reason` is `off`, `down` or
  `refused`. Only 400, 404, 410 and 422 are `refused` (no route, unknown station, no further page); only a refusal
  is taken as "none" (no journey, no departures, no earlier or later page). `KANTE.failure(e)` reads it.

## The journey model: `src/engine-journey.ts` (`KanteJourney`)

A `Journey` (its type is in `src/engine-journey.ts`) is the engine's journey from `POST /api/plan`, with the fields
the app adds:

| Field | What it is |
| --- | --- |
| everything of `KanteJourney` | `id`, `dep`, `arr`, `transfers`, `walkM`, `legs`, `alerts` as the engine sent them |
| `parts` | the legs as the trip is shown: `JourneyRide`s and the engine's own walk legs (`KanteWalkLeg`); a change at the very same boarding point has no walk |
| `t0`, `t1` | when it starts and arrives as timetabled, ms |

A `JourneyRide` is one of the engine's ride legs, or several when you stay seated while the vehicle goes on as
another trip:

| Field | What it is |
| --- | --- |
| `legs` | the engine's ride legs (`tripId`, `serviceDate`, `line`, `bearing`, …) |
| `stops`, `from`, `to` | the engine's stop calls (`KanteStopCall`: boarding point `quay`, `arr`/`dep`, delays, `plannedLabel`) at every stop it stops at; one call at the stop where the trip changes |
| `seqIdx` | for each leg, its call's `seq` → the stop's place in `stops` |
| `line`, `headsign` | the first leg's line as the badges read it (`ShownLine`: category and number), and where it goes |
| `live` | for each leg, the last `/api/trip` answer and when it came in |

The journey sheet, the map, the pill, tracking, the AR camera, the SBB link and the fare all read these directly:
`stopName()`, `stopUic()`, `liveMs()`, `lateMin()`, `hasForecast()` and `platformOf()` (`src/app/journey-steps.ts`,
`live-vehicles.ts`) are thin readers of a `KanteStopCall`. Boarding points are always the engine's
(`KanteJourney.at()`); the app no longer guesses an edge from a platform name and the direction of travel.

`KanteJourney.plans()` asks the engine and answers `JourneyOptions`: the journeys by departure, walking all the way
when the engine offers it, the one to show first, and the engine's pages for "Earlier" and "Later"
(`KanteJourney.more()`). It answers `null` when the engine finds no route and throws when the engine is off or down.

## What the engine looks for

- **Changes.** A change takes the walk between the two platforms or stop edges, on the engine's walking network at
  the traveller's pace, and the *Extra change time* of Settings on top (0 unless the traveller sets it). The
  timetable's own minimum change times are not used for this; the sheet says how much time a change leaves.
- **As many rides as it takes.** A journey may have up to fifteen rides: from a village to a mountain valley, two
  town buses, three trains and three valley buses are no exception. Of the journeys offered, the one shown first is
  the one that arrives first, where one change less is worth three minutes (`pick()` in `src/engine-journey.ts`).
- **How far ahead.** The journeys leaving in the next four hours; where that gives fewer than three, in the next
  sixteen; where nothing leaves in sixteen hours (a bus that does not run on Sundays), the first ones after that,
  as far as the day after next.
- **The maximum walk** of Settings holds for the walk to the first stop and from the last. A longer walk is
  offered where it is far better: the stops up to twice as far (an hour and a half at most) are searched too, and a
  journey that walks to or from one is listed beside the others where it gets there half an hour sooner than
  those within the maximum, or lets you leave that much later. The list tints its walk, and the walk says "Longer
  than your maximum walk". The journeys within the maximum are all still listed. Not for step-free or wheelchair
  routing, and not for a search that arrives by a time (nor its earlier and later pages).
- **Rather a long walk than no journey.** Where even that leaves nothing — no stop, or only stops nothing calls
  at these days — the engine takes the stops within twice the maximum walk as if within it, then those within an
  hour, before it answers that there is no journey.

`kante/tools/compare/fastest.py` checks all this on random trips against SBB's planner
([how](../kante/tools/compare/README.md#does-it-find-the-fastest-journey)).

## Live data: `src/app/live-engine.ts`

Every ride knows its trips, so while a journey is on (from 30 minutes before to 30 minutes after) each trip of each
ride still to come is asked of `GET /api/trip` every 30 s and when the tab comes back. `KanteJourney.applyTrip()`
writes the answer into the ride's stop calls (times, delays, boarding point); `KanteJourney.requay()` then moves the
boarding points and the walks to them when the platform has changed. The trip's `position` places the vehicle on the
map (`tracking.ts`), its `liveInfo` says how sure that is, and a cancelled trip offers "Replan". A change the live
times make impossible says "Not enough time to change" with "Replan", also when the next ride has already left
while you are still on the one before.

A journey's live times never go back: the engine drops live times that cannot be true (a vehicle logged onto the
wrong run, a frozen clock) and keeps every trip's times running forward
([what it leaves out](../kante/docs/LIVE-API.md#what-is-not-taken-from-the-feeds)), and the app does not offer a
journey whose times would go back all the same (`runsForward()` in `src/engine-journey.ts`).

`src/live.ts` (`KANTE_LIVE`) holds the pure helpers this uses, and that the live vehicles on the map
(`live-vehicles.ts`, `/api/stream` or `/api/vehicles`) use: positions moved on in time, km along the drawn ride,
the honest wording of how a position was worked out, and the bounding boxes. Where each vehicle on the map is drawn,
frame by frame, is `src/live-layout.ts` (its body as rigid carriages, kept behind the one in front without ever going
back); buses are laid onto the roads the base map draws (`src/live-lines.ts`, from the base map's own tiles read by
`src/vector-lines.ts`, in a worker: `src/app/lines-worker.ts`); vehicles on rails keep the engine's way, which runs on
the drawn rails already, and are drawn dashed in a tunnel by the drawn track they are matched to. Once a journey's route
is chosen, the vehicles of its rides show at any zoom, whether Settings has live vehicles on or not.

## Another vehicle than planned

Travellers sometimes board another vehicle than the planned one (an earlier bus that goes there too, the next run
of the line). `src/app/ride-switch.ts` notices it and offers the journey from on board it, never switching by itself:
"Looks like you're on bus 10 to Wankdorf · Update the route? Arrive 14:32", "Looks like you're on an earlier 12 ·
Update the times?" (the same line, to the same stop, the rest as planned) or "Still on 12?" (stayed on past the
planned stop). Closing it leaves that vehicle alone for the rest of the trip; it goes by itself once the vehicle has
not fitted for a minute.

What decides is the pure `src/app/ride-detect.ts` (tested on made-up tracks: `tools/test_ride_detect.mts`), on the
fixes of the last two minutes since the last gap of more than 30 s and since you last stood still for 45 s (waiting
at the stop), each within 60 m:

- **Moving like a vehicle**: 4 fixes over 40 s at least, 300 m from the first to the last, 3.5 m/s on average and
  6.5 m/s over 15 s at some point. Waiting at the stop, walking and running for the bus do not count.
- **On a trip**: 80 % of the fixes (and the last) within their accuracy plus 30 m (40–90 m) of the trip's way, going
  forward along it (on a way that passes the same place twice, along whichever pass fits), and where its vehicle is by its live stop times when each was taken: a median gap of 90 s at most
  (150 s on timetable times), none over 180 s (240 s). The vehicle positions in Switzerland come from those times, so
  this is being with the vehicle. The fixes before the first one on its way (the walk to the stop) are left out.
- **One answer**: when a planned ride fits best, or another trip fits within 40 s of the best (another line on the same
  road, a bus bunched with the next one), nothing is said; and only when the same trip is named twice, on fixes at
  least 15 s apart.

The journey's own rides are checked first, without asking the engine anything. Only when none fits are the vehicles
around you asked for (`GET /api/vehicles`, a box that grows with your speed; at most every 20 s, every 60 s while none
fits) and the trips of up to six going your way within 400 m of their way between the stops around where they are
drawn (`GET /api/trip`). The journey offered is the engine's from
on board (`onboard` in `POST /api/plan`, from the stop ahead of you while the vehicle has still to get there),
`KanteJourney.onboard()`: not one with a cancelled ride or a missed change, nor one that has you get off where you have
been, its first ride drawn from the stop you passed last (`tools/test_onboard.mts`). It is offered when it gets there no
more than half an hour after the journey on show (or after now), and not when it has you get off at the next stop to
ride back further from the destination. "Update route" asks again before it shows the new journey.

## Which way you face, and the map following you

The blue dot's beam (`src/app/heading.ts`) shows which way the phone faces, from its compass (`src/compass.ts`) turned
from magnetic to true north (Swiss declination, fitted to NOAA's WMM2025: about 3.4° in Bern). Without a compass it
shows the direction you go: the course the phone gives with a fix, else the line between two fixes once you have
moved clearly further than both may be off. iPhones (and recent Chrome) give a page compass readings only once it
has asked from a tap: the page asks on Start, on a tap on the dot, and on the first tap outside a text field once
there is a dot; access given before is picked up as the page loads.

After Start, `src/app/follow-cam.ts` keeps you low in the free part of the map, tilted 45° and turned so that up is
the way you go: on foot the compass, drawn towards the direction you walk (unless the two differ by more than 60°,
when you are looking elsewhere); on a ride the way the track or road goes where GPS puts you on it (`tripHere()`,
`tracking.ts`). It moves only when that changes enough to see, a few times a second at most, since every camera move
runs the map's move handlers. Dragging the map or picking a step, direction or stop hands the camera back (a pinch
only changes how close it follows); "Back to where you are" takes it up again, and the north button turns the map
north up. Leaving the trip puts the map back north up and flat.

## Departure boards: `src/engine-departures.ts` (`KANTE_BOARD`)

The card of a tapped platform and Scan both read `KANTE_BOARD.load()`: the engine's departures for the stop
(`GET /api/departures`), each with the edges of `platforms.js` it leaves from. A departure whose boarding point the
engine does not place on an edge has none (`[]`) and is listed under "From other platforms" on an edge's card.

## When the engine cannot answer

| Where | What it says |
| --- | --- |
| Journey sheet | "Journeys come from the Kante engine, which isn't answering right now." with **Try again** (from the same start as the plan that failed); "… which is switched off for this page." without it |
| Platform card | the same for departures, with **Try again** |
| Scan | the same for departures, with **Try again** (it also asks again by itself every 15 s); rows already shown stay, marked "Not updated since …" |
| Live data, live vehicles, `/api/due` | nothing: the journey keeps its last times, the map shows no vehicles |

## The fare

The fare in the journey's footer comes from transport.opendata.ch's fare service (`POST /v1/fare`,
`src/app/ticket-pricing.ts`), the only call the app makes there. That service prices a connection of its own
timetable and names operators its own way ("SBB" where the engine says "Schweizerische Bundesbahnen SBB"), so the
engine's rides are first found among its connections by their stops and times; only an exact match is priced.
Without an answer the footer shows no price and the SBB ticket link still works.
