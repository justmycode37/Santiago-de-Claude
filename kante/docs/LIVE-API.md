# Live data API

How the engine tells where vehicles are, how sure it is, and what the app and the camera can ask it.
The other endpoints are listed in `../README.md`; the parameters of all of them are in
`engine/crates/server/src/api.rs`.

Switzerland publishes no live GPS positions of vehicles. Every position here is placed from stop times:
measured ones where a vehicle has already been, the operators' forecasts for the rest, the timetable
where there is no live data. `liveInfo` says which, so a page never shows an estimate as a fact.

`GET /api/meta` lists in `features` which of the parts below this engine has (`match`, `due`, `stream`,
`extras`, `gtfs-rt`). A page checks it and falls back to what it did before when one is missing.

## Where the data comes from

| Feed | Polled | What it adds |
|---|---|---|
| SIRI-ET (opentransportdata.swiss) | every 60 s | measured times at stops already served, forecasts, cancellations, platform changes, extra journeys |
| GTFS-RT TripUpdates | every 32 s | forecasts; fresher for trips it updated after SIRI-ET did |

The two are merged stop by stop, never trip against trip: SIRI-ET's measured times and platform changes
always stay; GTFS-RT only replaces SIRI-ET's *forecasts* for stops not yet reached, and only when it
updated that trip later than SIRI-ET did. Trips that only one feed knows come from that feed.

Keys: `data/secrets/otd.json` as `{"siri-et": "…", "gtfs-rt": "…"}` (or `KANTE_OTD_KEY` /
`KANTE_OTD_GTFS_RT_KEY`). Either one may be missing; the engine then runs with the other or on the
timetable alone.

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

When the ride stays seated into a trip this one continues as (the timetable links them), `toSeq` is absent
and `then` lists those trips in order, the last one with `toSeq`:
`"then": [{ "tripId": "…", "serviceDate": "…", "toSeq": 7 }]`.

Tested on 74 rides between 15 pairs of places planned with transport.opendata.ch (21 Nov 2026): 67 unique,
none ambiguous, 7 `none`. All 7 are RhB trains that divide on the way (RE13, RE24 at Klosters), which the
timetable has as separate trips without a link; the page then keeps its own refresh for that ride.

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

```json
{ "t": 1795262074, "due": [ {
  "tripId": "…", "serviceDate": "2026-11-21", "seq": 5,
  "line": { "name": "10", "category": "T", "mode": "tram", "operator": "BERNMOBIL" },
  "headsign": "Ostermundigen, Rüti", "number": null,
  "vias": ["Zytglogge", "Kursaal", "Brunnadernstrasse"],
  "quayId": "…", "quayLabel": "C", "plannedLabel": null,
  "arr": 1795262100, "dep": 1795262130, "delayS": 60, "cancelled": false,
  "approachBearing": 92, "departBearing": 110,
  "state": "approaching", "etaS": 26,
  "liveInfo": { … }, "extra": false
} ] }
```

`state`: `approaching` (not yet there), `at-stop` (between live arrival and departure), `departed`.

Included: departures from the asked boarding points, counting the platform in use (a train moved from 4 to
5 shows at 5, not at 4); vehicles already under way that only set down here (e.g. at the end of their run;
`dep` is null); extra journeys. Not included: a vehicle that only sets down here and has not started yet.
`delayS` is only given where the time is live.
`approachBearing` is the direction the vehicle drives in when it arrives (from the stop before);
`departBearing` when it leaves (to the next stop). Either is null where there is no such stop.

## `GET /api/stream?bbox=w,s,e,n` — vehicles as server-sent events

`event: vehicles` with the same body as `/api/vehicles`, sent at once, whenever the live data changes, and
at least every 15 s. At most 200 streams are open at once; beyond that the answer is 503 and a page should
poll `/api/vehicles` instead. Streams end when the engine shuts down. A `: ping` comment every 15 s keeps proxies from closing the connection. Reconnect
when it closes (the browser's `EventSource` does this by itself); each event is complete, so nothing
needs to be pieced together.
