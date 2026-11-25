# Live map of every vehicle (prototype)

A map of every bus, tram, train, boat and cable car running in Switzerland right now, moving along the
real rails and roads.

**Positions are estimates, not GPS.** Switzerland has no open feed of vehicle positions. Each vehicle is
placed from the live arrival and departure times at its stops (SIRI-ET from
[opentransportdata.swiss](https://opentransportdata.swiss)), which are typically one to two minutes old.

This is not part of the static site: it needs a server, so `livemap/` is left out of the GitHub Pages deploy.

## How it fits together

| Part | What it does |
|---|---|
| Kante engine (`kante/` in this repository) | Holds the timetable, polls the live feed once a minute with the API key, answers "which vehicles are under way" and "this trip's stops and delays" |
| `server.mts` | Asks the engine for every running vehicle, builds each one's coming stops with live times, and serves the page. Holds no API keys |
| `shaper/` | Small Rust program. Finds the path between two consecutive stops on OpenStreetMap rails, roads or ferry lines. Started by `server.mts`; only for hops the engine sends no way for (an engine built without `shapes.bin`, a long hop of which it sends only part): the engine lays each line onto the network as a whole ([LIVE-API.md](../kante/docs/LIVE-API.md#the-way-vehicles-take)) |
| `index.html` | The map. Draws each vehicle along its path and glides to corrections instead of jumping |
| `index-old.html` | The first version of the page (current hop only, no gliding), served at `/old` for comparison |
| `measure/` | Scripts that measured how much vehicles jump around |

## Running it

Needs Node 22+, Rust, and the Kante engine running on port 8080 with a SIRI-ET key (see
[kante/README.md](../kante/README.md)). The path finder reads the OpenStreetMap extract of Switzerland that Kante downloads.

```sh
cd livemap
(cd shaper && cargo build --release)
node server.mts            # http://127.0.0.1:8090
```

| Variable | Default | Meaning |
|---|---|---|
| `KANTE_URL` | `http://127.0.0.1:8080` | Where the engine is |
| `OSM_PBF` | `~/Powercoders-Hackathon/kante/data/raw/osm/switzerland-latest.osm.pbf` | Map extract for the path finder |
| `PORT`, `HOST` | `8090`, `127.0.0.1` | Where the page is served |

The server uses about 1.5 GB of memory, because the path finder keeps the Swiss road and rail network
loaded. Paths are cached in `data/` (git-ignored).

## What the page does to stay smooth

- **Coming stops are sent ahead.** Each vehicle carries up to 28 stops with live times, so it runs on past
  a stop without waiting for new data.
- **It glides to corrections.** When the feed revises a time, the gap is closed over 10 seconds, never by
  reversing and at no more than twice the scheduled speed. Only a gap of more than a minute of travel is
  jumped.
- **No impossible hops.** A hop faster than the vehicle's top speed borrows time from the one before it
  (timetable times are whole minutes, so some hops have zero seconds).
- **Fresh data.** The server rebuilds every 5 seconds while someone is watching; the page only re-reads
  vehicles whose timeline changed.

## Measured on 21 November 2026

A jump is a move of more than 25 m beyond what the vehicle's top speed allows in one second. Five-minute
runs, about 3,900 vehicles, Saturday late morning.

| | First version, replayed on the same five minutes | This version, measured in a headless browser |
|---|---|---|
| Jumps over 25 m per vehicle-hour | 42.6 | 0.5 |
| Backward moves per vehicle-hour | 12.4 | 0.3 |
| Stalled while it should be moving | 17.7% of the time | 8.9% |
| Median distance from the feed's later view | 31 m | 39 m |
| 90th-percentile distance | 393 m | 419 m |
| Median time offset from the feed's later view | 6.0 s | 7.3 s |

Smoothness costs a little accuracy. Against the same page without gliding (replayed: 4.9 s median), gliding
adds about 2.4 seconds to the typical offset, because the dot holds instead of snapping back when the feed
corrects a forecast. When it is off, it is ahead far more often than behind (50% of the time against 4%).
"The feed's later view" is where newer feed data says the vehicle was, not where it really was.

Path finding: every hop inside the core of Switzerland got a path (0 failures in a test box of 934 hops).
About 88% of moving vehicles other than cable cars have one; the rest are cross-border hops outside the map
extract, which fall back to a straight line.

## Limits

- The path is the path finder's best guess, not the operator's official route. Where two streets or two
  rail lines join the same pair of stops it can pick the wrong one. Not measured.
- Speed between stops is uniform: no acceleration or braking.
- The server asks the engine for every live trip each time the feed changes (about 3,200 local requests a
  minute).
- Tested in headless Chrome only, not on a phone.

## Repeating the measurements

Playwright is borrowed from the Kante app; set `PLAYWRIGHT_PACKAGE_JSON` to any `package.json` that has it.

```sh
cd livemap/measure
python3 log.py recordings/run.jsonl.gz 5 &                    # log the raw data for 5 minutes
node browser_run.mts recordings/run-browser.json.gz 300       # what the page draws, once a second
wait
python3 fetch_trips.py recordings/run.jsonl.gz recordings/trips.json.gz
python3 simulate.py recordings/run.jsonl.gz recordings/trips.json.gz recordings/run-browser.json.gz
python3 crosscheck.py recordings/trips.json.gz recordings/run-browser.json.gz
python3 lag.py recordings/run.jsonl.gz recordings/trips.json.gz recordings/run-browser.json.gz
```

`simulate.py` replays the logged data under each drawing strategy and scores the browser run with the
same measures; `crosscheck.py` recounts the browser's jumps from the drawn positions; `lag.py` gives the
offsets in seconds. `analyse.py` is the
earlier, simpler count of jumps at each data update. The recordings behind the numbers above are in
`measure/recordings/` on the machine that made them (git-ignored).
