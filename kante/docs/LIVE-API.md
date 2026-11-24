# Live data API

How the engine tells where vehicles are, how sure it is, and what the app and the camera can ask it.
The other endpoints are listed in `../README.md`; the parameters of all of them are in
`engine/crates/server/src/api.rs`.

Switzerland publishes no live GPS positions of vehicles. Every position here is placed from stop times:
measured ones where a vehicle has already been, the operators' forecasts for the rest, the timetable
where there is no live data. `liveInfo` says which, so a page never shows an estimate as a fact.

`GET /api/meta` lists in `features` which of the parts below this engine has (`match`, `due`, `stream`,
`extras`, `gtfs-rt`). A page checks it and falls back to what it did before when one is missing. `commit` names
the commit the engine was built from (null for a build that was not given `KANTE_COMMIT`), `release` the folder its
executable is in (for a deployed engine, the release; the same commit can be built into several).

## Where the data comes from

| Feed | Polled | What it adds |
|---|---|---|
| SIRI-ET (opentransportdata.swiss) | every 60 s | measured times at stops already served, forecasts, cancellations, platform changes, extra journeys |
| GTFS-RT TripUpdates | every 32 s | forecasts; fresher for trips it updated after SIRI-ET did |

The two are merged stop by stop, never trip against trip: SIRI-ET's measured times and platform changes
always stay; GTFS-RT only replaces SIRI-ET's *forecasts* for stops not yet reached, and only when it
updated that trip later than SIRI-ET did. Trips that only one feed knows come from that feed.

Measured on 21 Nov 2026 (`livemap/measure/compare_feeds.py`, `forecast_compare.py`): the Swiss GTFS-RT
carries no update time per trip (0 of 12,642), so in practice it **only fills in trips SIRI-ET lacks**.
That is little but real: of 3,834 vehicles under way, 85.8 % have live data with both feeds against
84.9 % with SIRI-ET alone (33 trips, most of them SNCF trains near Geneva and Basel, 16 % → 39 %, and
Fribourg's TPF buses, 93 % → 100 %). Its forecasts are not better: on 891 arrivals measured later, both
feeds' forecasts were off by 42 s on average (median 30 s). It has no measured times, no platform names
and no names for the journeys it adds. GTFS-RT on its own matches 96 % of its journeys (all but the 506 it
adds); SIRI-ET 99 %.

Keys: `data/secrets/otd.json` as `{"siri-et": "…", "gtfs-rt": "…"}` (or `KANTE_OTD_KEY` /
`KANTE_OTD_GTFS_RT_KEY`). Either one may be missing; the engine then runs with the other or on the
timetable alone.

When a feed fails: after a passing error (network, server, a broken document) it is asked again within
two minutes, so the data is fresh again soon after the feed is back; a rejected key or a quota limit waits
longer (up to 15 minutes, or what the feed asks for). Its last data stays in use, marked `stale` after
5 minutes; after 30 minutes without an answer it is dropped and the engine runs on the timetable (and the
other feed) until the feed answers again. `/api/meta` then says so: `realtime.source` names only feeds whose
data is in use (null when none), `realtime.error` and the feed's `error` say it was dropped, and with no feed
in use `updatedAt` is null and `/api/departures` answers `realtime: false`.

## `liveInfo`: how sure a trip's times are

On `/api/trip`, `/api/vehicles`, `/api/due` and the stream.

```json
"liveInfo": {
  "state": "observed",
  "source": "siri-et",
  "observedSeq": 4,
  "observedKind": "dep",
  "updatedAt": 1795262000,
  "ageS": 74,
  "inaccurate": false,
  "congestion": false
}
```

| Field | Meaning |
|---|---|
| `state` | `observed`: a time was measured at a stop of this trip. `predicted`: forecasts only. `timetable`: no live data. `stale`: no feed that contributed to this trip has been fetched in the last 5 minutes (judged by the clock, also when `t` asks about another moment) |
| `source` | `siri-et`, `gtfs-rt` or `siri-et+gtfs-rt` (forecasts from GTFS-RT on top of SIRI-ET); absent for `timetable` |
| `observedSeq` / `observedKind` | the last stop with a measured time, and whether it was the arrival (`arr`) or the departure (`dep`) there. An arrival does not mean the vehicle has left |
| `updatedAt` / `ageS` | when the source last updated this trip, and how long ago |
| `inaccurate` / `congestion` | the operator flags the forecast as unreliable / the vehicle is in a traffic jam |

## `GET /api/trip?id=&date=`

As before, plus:

- `liveInfo` (above), `extra` (`true` for a journey that is not in the timetable, e.g. a replacement bus).
- `position`: where the vehicle is at `t` (default now):

```json
"position": { "state": "between", "seq": 4, "nextSeq": 5, "from": [7.43, 46.95], "to": [7.44, 46.95], "frac": 0.37,
              "basis": "observed-stop", "t": 1795262074, "dep": 1795262040, "arr": 1795262130 }
```

`state` is `before-start`, `at` (standing at stop `seq`), `between` (left `seq`, heading for `nextSeq`,
which is later than `seq + 1` when stops are skipped) or `ended`. `dep`/`arr` are the times the position is
timed by (leaving `seq`, reaching `nextSeq`; for `at`, arriving at and leaving `seq`): to move the vehicle on
between two requests, start from `frac` at `t` and go on at the pace of `dep`→`arr`. Once a departure has been measured, the time to the next stop is what that hop usually takes
(learned from the measured times of the past two weeks, see `crates/server/src/profiles.rs`), not the
forecast; likewise how long a bus or tram stands at a stop after a measured arrival. On 4.5 M test hops
this cut the error of the arrival from 33.5 s to 10.6 s on average (`livemap/measure/IST-DATEN.md`). `basis` is `observed-stop` (timed from the last measured stop), `forecast` or `timetable`.
`from`/`to` are the stops' boarding points (the
changed one when the platform changed); the line between them is straight.

Each call in `calls` has `live: true` where its times come from a feed (reported, or carried on from an
earlier report); elsewhere they are the timetable's, and a page should keep any forecast it has from
elsewhere. A trip that does not run on `date` is a 404.

Extra journeys have ids `extra:<journey ref>` and are only valid while the feed carries them (and only
with their own operating day as `date`).

## `GET /api/vehicles?bbox=w,s,e,n`

As before; every vehicle also has `liveInfo`, `extra`, `frac` and `basis`. `from`, `to`, `dep`, `arr`,
`nextSeq` and `frac` all come from the vehicle's `position`, so they always describe the same hop.
Cancelled trips are left out; extra journeys are included. The lists are computed a few at a time; a
request may wait briefly when many arrive at once.

Times outside about a year from now (`t`, `dep`, `arr`) are refused with 400.

## `GET /api/match` — find the engine's trip for a ride planned elsewhere

For pages that plan with transport.opendata.ch and want this engine's live data for the ride.

| Parameter | |
|---|---|
| `from` | boarding station: UIC number (`8507000`) or engine station id (`st:…`) |
| `dep` | scheduled departure there, unix seconds |
| `to`, `arr` | alighting station and scheduled arrival (optional, but they make the answer much safer) |
| `line` | line as shown (`S1`, `10`, `IC 8`, `S 1`); optional |
| `number` | train or course number (`21234`); optional |

```json
{ "match": { "tripId": "…", "serviceDate": "2026-11-21", "fromSeq": 3, "toSeq": 9 }, "candidates": 1, "reason": "unique" }
```

`reason` is `unique`, `ambiguous` (several trips fit: `match` is null, never a guess) or `none`.

When the ride stays seated into another trip, `toSeq` is absent and `then` lists the trips it rides on in
order, the last one with `toSeq`: `"then": [{ "tripId": "…", "serviceDate": "…", "toSeq": 7 }]`. Such a
trip is one the timetable links to this one, or — for a train that divides, which the timetable does not
link (RhB RE13/RE24 at Klosters) — the one trip that leaves the same platform within ten minutes of this
one's arrival towards one of the parts the arriving train names in its destination ("St. Moritz | Davos
Platz"), and reaches the ride's destination at the ride's arrival time. Only for trains, only when `arr` is
given, and when not exactly one trip fits, nothing is assumed.

Tested on 106 rides between 21 pairs of places planned with transport.opendata.ch (21 Nov 2026), including
the RhB trains that divide: 106 unique, none ambiguous, none missing. Example: RE24 1053 Landquart → Scuol-Tarasp
is `then` RE4 1253 from Klosters Platz platform 3; RE13 1055 → Zernez is `then` RE3 1355.

## `GET /api/departures`

As before; `station` may also be a UIC number. Extra journeys leaving in the same window are included.

## `GET /api/due` — what is about to stop here (for the camera)

Every trip due at a boarding point in a time window, with what a vehicle's display would show and where
the vehicle comes from. Meant for matching a bus seen by a camera against the services that can actually
be there.

| Parameter | |
|---|---|
| `quay`, or `station`, or `lat`+`lon` (+`radius`, metres, ≤ 400, default 150) | where |
| `t` | default now |
| `before`, `after` | seconds before/after `t` to include (defaults 120 and 900) |
| `limit` | default 30 |
| `to` | the rider's stop, as `station`: each entry then has `servesTo` |

`quay` is the engine's quay id or the **ATLAS SLOID** of the boarding edge (what a journey from `/api/plan`
gives as `quay.sloid`, and what the app's stop data knows). The two are the same string for nearly every
boarding point; a platform whose sectors the timetable splits has extra quays for its parts
(`ch:1:sloid:7000_gen:ch:1:sloid:7000:3:5_pf:5A-C` for Bern platform 5), and its SLOID covers all of them.
`/api/departures?quay=` takes the same. Example: `GET /api/due?quay=ch:1:sloid:7000:3:5` — Bern, platform 5;
`GET /api/due?quay=ch:1:sloid:76646:0:13` — Bern, Bahnhof, bay E.

```json
{ "t": 1795262074, "complete": true, "truncated": false, "due": [ {
  "tripId": "…", "serviceDate": "2026-11-21", "seq": 5,
  "line": { "name": "10", "category": "T", "mode": "tram", "operator": "BERNMOBIL" },
  "headsign": "Ostermundigen, Rüti", "number": null,
  "vias": ["Zytglogge", "Kursaal", "Brunnadernstrasse"],
  "quayId": "…", "quayLabel": "C", "plannedLabel": null,
  "arr": 1795262100, "dep": 1795262130, "delayS": 60, "cancelled": false,
  "approachBearing": 92, "departBearing": 110,
  "state": "approaching", "etaS": 26,
  "liveInfo": { … }, "extra": false,
  "profiled": true, "servesTo": true, "prevStop": [7.4391, 46.9484], "nextStop": [7.4474, 46.9479]
} ] }
```

`complete`: nothing is missing from the list. It is false when more trips were due than `limit` (`truncated`)
or when a live feed the engine reads has not answered for 5 minutes (a replacement bus or a changed platform could
be missing). The AR camera never calls a vehicle "yours" on an incomplete board.

`profiled`: after a measured stop, `arr`/`dep` (and `etaS`, `state`) come from the learned hop and dwell
profiles, as `position` does on `/api/trip`, not from the forecast. `servesTo` (with `to=`): whether the run
calls at that station after this stop, not skipped today; an express and a local with the same display differ
here. `prevStop`/`nextStop`: the boarding points of the stops before and after, where it comes from and goes to.

`state`: `approaching` (not yet there), `at-stop` (between live arrival and departure), `departed`.

Included: departures from the asked boarding points, counting the platform in use (a train moved from 4 to
5 shows at 5, not at 4); vehicles already under way that only set down here (e.g. at the end of their run;
`dep` is null); extra journeys. Not included: a vehicle that only sets down here and has not started yet.
`delayS` is only given where the time is live.
`approachBearing` is the direction the vehicle drives in when it arrives (from the stop before);
`departBearing` when it leaves (to the next stop). Either is null where there is no such stop.

## `GET /api/identify` — which trip is the vehicle a camera sees?

For a camera (or a person) that sees a bus, tram or train and could read some of its display. The answer is
chosen among the vehicles that can actually be there at that moment — those due at the boarding points
around (as `/api/due`) and those under way nearby (as `/api/vehicles`) — so a reading only has to tell them
apart, not find the trip in the whole country.

| Parameter | |
|---|---|
| `lat`, `lon` | where the camera is |
| `t` | when it saw the vehicle, default now |
| `line` | the line number as read (`10`, `S1`, `S 1`, `IC 8`, `EV`); optional |
| `headsign` | the destination text as read (any part of it, may contain misread letters); optional |
| `bearing` | the direction the vehicle drives in, degrees from north; optional |
| `radius` | how far away the vehicle can be, metres (20–400, default 120): boarding points within it, and vehicles between stops whose estimated position is within it |
| `quay` | only vehicles due at this boarding point (engine quay id or ATLAS SLOID); then no vehicle between stops is considered; optional |

```json
GET /api/identify?lat=46.94886&lon=7.43979&line=10&headsign=Ostermundigen%20R%C3%BCti&bearing=95
{ "t": 1795262074, "result": "match", "confidence": 0.93,
  "candidates": [ { "tripId": "…", "serviceDate": "2026-11-21", "score": 0.93,
    "line": { "name": "10", "category": "T", "mode": "tram", "operator": "BERNMOBIL" },
    "headsign": "Ostermundigen, Rüti", "seq": 5, "quayId": "ch:1:sloid:76646:0:13",
    "downstream": [ { "seq": 5, "station": "Bern, Bahnhof", "quayId": "…", "arr": 1795262040 },
                    { "seq": 6, "station": "Bern, Zytglogge", "quayId": "…", "arr": 1795262160 } ],
    "evidence": { "line": "exact", "text": 1.0, "distanceM": 18, "timeOffS": 0, "bearingDiff": 7 },
    "liveInfo": { … } } ] }
```

`result` is `match` (the first candidate, clearly ahead of every other), `ambiguous` (several fit about as
well — the candidates are listed, best first; read more of the display, or add the direction) or `none`.
`confidence` is the winner's score: a ranking (0–1), not a probability.

How a candidate is scored: the line read (`exact`, `confusable` — O/0, I/1, S/5, B/8, Z/2, G/6 —, or
`unseen`), how well the destination text fits its destination or one of its next stops (accents and
digit-for-letter readings folded), how close it is in place and time, and how well its direction of travel
fits `bearing`. Ruled out: another line read, or driving the other way (more than 120° off). A destination
that was read and does not fit is never a match. Each candidate carries `downstream` (its next stops with
boarding points), so a page can bind the vehicle to the trip and check it serves where the traveller goes.

Tested by a simulated camera at 186 real situations in 12 cities (a vehicle due at a boarding point, read at
its arrival time a few metres away, timetable data, 21 Nov 2026):

| What was read | correct match | ambiguous (right trip listed) | wrong match |
|---|---|---|---|
| line + destination | 98 % | 2 % | 0 |
| line + destination with a misread letter | 99 % | 1 % | 0 |
| line + destination + direction | 99 % | 1 % | 0 |
| line + direction | 96 % | 4 % | 0 |
| destination only | 85 % | 15 % | 0 |
| line only | 60 % | 40 % (same line both ways) | 0 |

The script: `livemap/measure/identify_sim.py` (`python3 -I identify_sim.py [engine]`).

## `GET /api/stream?bbox=w,s,e,n` — vehicles as server-sent events

`event: vehicles` with the same body as `/api/vehicles`, sent at once, whenever the live data changes, and
at least every 15 s. At most 200 streams are open at once; beyond that the answer is 503 and a page should
poll `/api/vehicles` instead. Streams end when the engine shuts down. A `: ping` comment every 15 s keeps proxies from closing the connection. Reconnect
when it closes (the browser's `EventSource` does this by itself); each event is complete, so nothing
needs to be pieced together.
