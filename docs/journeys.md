# Journeys, departures and live data

Everything the app knows about public transport comes from the team's Kante engine (`kante/`, hosted at
`https://kante.omniroute.app`; its API is in `kante/engine/crates/server/src/json.rs` and
[`kante/docs/LIVE-API.md`](../kante/docs/LIVE-API.md)). There is no second timetable behind it: when the engine is
switched off or cannot be reached, the app says so where a journey or a departure board would be, and the map,
search, events and places go on working.

## The engine's client: `src/engine.ts` (`window.KANTE`)

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

## The journey model: `src/engine-journey.ts` (`window.KanteJourney`)

A `Journey` (types in `src/types/app-journey.d.ts`) is the engine's journey from `POST /api/plan`, with the fields
the app adds:

| Field | What it is |
| --- | --- |
| everything of `KanteJourney` | `id`, `dep`, `arr`, `transfers`, `walkM`, `legs`, `alerts` as the engine sent them |
| `parts` | the legs as the trip is shown: `JourneyRide`s and the engine's own walk legs (`KanteWalkLeg`); a change at the very same boarding point has no walk |
| `t0`, `t1` | when it starts and arrives as timetabled, ms (the walking network may move them for a walk drawn longer or shorter) |
| `accessS` | the walk to the first ride as the walking network drew it, for the list's row |

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

## Live data: `src/app/live-engine.ts`

Every ride knows its trips, so while a journey is on (from 30 minutes before to 30 minutes after) each trip of each
ride still to come is asked of `GET /api/trip` every 30 s and when the tab comes back. `KanteJourney.applyTrip()`
writes the answer into the ride's stop calls (times, delays, boarding point); `KanteJourney.requay()` then moves the
boarding points and the walks to them when the platform has changed. The trip's `position` places the vehicle on the
map (`tracking.ts`), its `liveInfo` says how sure that is, and a cancelled trip offers "Replan".

`src/live.ts` (`KANTE_LIVE`) holds the pure helpers this uses, and that the live vehicles on the map
(`live-vehicles.ts`, `/api/stream` or `/api/vehicles`) use: positions moved on in time, km along the drawn ride,
the honest wording of how a position was worked out, and the bounding boxes.

## Departure boards: `src/engine-departures.ts` (`window.KANTE_BOARD`)

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
