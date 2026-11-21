# Kante engine

The Rust journey planner from the Kante prototype (Powercoders-Hackathon, branch `nikitas-implementation`,
commit `48937e8`). It plans door-to-door trips on the national timetable with its own multi-level walking
network, ties every departure to the exact bus bay, tram edge or platform, and applies live delays from
opentransportdata.swiss.

The app in this repository plans journeys with transport.opendata.ch and uses this engine for live data:
it finds each ride's trip here (`/api/match`), follows it (`/api/trip`) and shows the vehicles around you
(`/api/stream`). The live map in `livemap/` uses it too. What the live endpoints say and how sure they are:
[docs/LIVE-API.md](docs/LIVE-API.md). `deploy/` hosts it and redeploys it when `main` changes; the hosted
engine is at https://kante.omniroute.app.

| Path | What |
|---|---|
| `engine/crates/` | The engine. `docs/ARCHITECTURE.md` explains the crates |
| `engine/playground/` | One-page debug UI on the API, served at `/playground/` |
| `scripts/fetch-data.sh` | Downloads the timetable, the stop registry and OpenStreetMap Switzerland (about 900 MB) |
| `scripts/plan.py` | Plans a trip from the command line |

## Running it

Needs Rust, about 6 GB of disk and 4 GB of memory.

```sh
cd kante
scripts/fetch-data.sh                                   # → data/raw
(cd engine && cargo build --release -p kante-server)
engine/target/release/kante build --data data           # data/raw → data/built, under a minute
engine/target/release/kante serve --data data --port 8080 --app none
scripts/plan.py "Zürich HB" "Ostermundigen, Rüti" 2026-11-23T08:00 steps=1
```

## API

`GET /api/meta`, `/api/search`, `/api/nearby`, `/api/reverse`, `/api/quays`, `/api/departures`, `/api/trip`,
`/api/vehicles`, `/api/onboard`, `/api/indoor`, `/api/due`, `/api/match`, `/api/stream`, and `POST /api/plan`,
`/api/walk`, `/api/observe`. Any website may call it
(CORS is open). The parameters are in `engine/crates/server/src/api.rs`.

## The live-data key

Live data needs a free key from [opentransportdata.swiss](https://api-manager.opentransportdata.swiss/),
subscribed to SIRI-ET and, for fresher forecasts, GTFS-RT. Put it in `data/secrets/otd.json` as
`{"siri-et": "…", "gtfs-rt": "…"}` (or the environment variables `KANTE_OTD_KEY` and `KANTE_OTD_GTFS_RT_KEY`);
without a GTFS-RT key the SIRI-ET one is tried for both. `data/` is git-ignored: never commit the key. Without
a key the engine runs on the timetable alone.

Learned travel times (optional): `data/profiles/hop.csv.gz` and `dwell.csv.gz`, made by
`python3 -I livemap/measure/ist_daten_hops.py --days 15 --cache DIR --write-profile` (files
`profile_*_paironly.csv.gz`). The hosted engine rebuilds them weekly (`deploy/refresh-data.sh`).

## Things to know

- `scripts/fetch-data.sh` takes the timetable year in force on the day it runs (a new one starts on the
  second Sunday of December); the hosted engine fetches it again twice a week (`deploy/refresh-data.sh`).
- Step-free routes have gaps where OpenStreetMap lacks lifts or ramps, and some walks inside stations
  are drawn wrong. The Kante README in Powercoders-Hackathon lists the known problems.
