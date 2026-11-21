# Kante engine

The Rust journey planner from the Kante prototype (Powercoders-Hackathon, branch `nikitas-implementation`,
commit `48937e8`). It plans door-to-door trips on the national timetable with its own multi-level walking
network, ties every departure to the exact bus bay, tram edge or platform, and applies live delays from
opentransportdata.swiss.

The app in this repository does not call it yet: journeys still come from transport.opendata.ch. The
live map in `livemap/` does use it. `deploy/` hosts it and redeploys it when `main` changes; the hosted
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
`/api/vehicles`, `/api/onboard`, `/api/indoor`, and `POST /api/plan`, `/api/walk`. Any website may call it
(CORS is open). The parameters are in `engine/crates/server/src/api.rs`.

## The live-data key

Live data needs a free key for the SIRI-ET API from
[opentransportdata.swiss](https://api-manager.opentransportdata.swiss/). Put it in the environment variable
`KANTE_OTD_KEY`, or in `data/secrets/otd.json` as `{"siri-et": "…"}`. `data/` is git-ignored: never commit
the key. Without a key the engine runs on the timetable alone.

## Things to know

- The timetable in use is the 2026 one, valid to 12 December 2026. From 13 December, change the dataset
  in `scripts/fetch-data.sh` to `timetable-2027-gtfs2020`.
- Step-free routes have gaps where OpenStreetMap lacks lifts or ramps, and some walks inside stations
  are drawn wrong. The Kante README in Powercoders-Hackathon lists the known problems.
