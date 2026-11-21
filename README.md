# Santiago de Claude

A Swiss community event map and public transport journey planner. Team project for the Powercoders Hackathon.

[Open the live app](https://justmycode37.github.io/Santiago-de-Claude/)

## Features

- **Journey planner & live tracking**: Plans Swiss public transport trips with the team's own Kante engine (`kante/`; `transport.opendata.ch` when it is unreachable) to exact train platforms (Gleis) and bus/tram stop edges (Kante), with live delay/platform updates and GPS route tracking.
- **Place & address search**: Search by category (e.g. "restaurant", "Apotheke", "toilet"), place name, or Swiss address/stop (OpenStreetMap via Photon + swisstopo).
- **Start & destination pins**: The search bar at the top has a field for where the trip starts and one for where it goes. Both search the same way, and each has a pin you can drag onto the map (or tap, then tap the map; or long-press the map for "From here / To here"). Pins on the map can be dragged to move them. "Show on the map" puts the places of a search on the map as pins, and "Search this area" repeats it for the part of the map you have moved to.
- **Events & amenities**: Shows community events on the map alongside public toilets all over Switzerland and Bern's public amenities and local places.
- **Any language**: Settings › **Language** translates the app into any of Google Translate's 249 languages (`translate.js`); English is the default. The text on screen is sent to Google to translate it; stop, line and place names stay as written on the signs.
- **Camera stop scan**: Menu › **Scan** identifies nearby stops and shows next departures using sign OCR, GPS/compass, and reference-photo fingerprints (requires HTTPS on phones).

## Live tracking

During a trip the app refetches the connection from `transport.opendata.ch` every minute for forecasts, follows you by GPS along the planned route, and places your vehicle from its live stop times. When the [Kante engine](kante/docs/LIVE-API.md) is reachable (`live.js`), it adds:

- **Measured times**: each ride is matched to the engine's trip (`/api/match`, only when the match is unique) and polled every 30 s (`/api/trip`) for measured and forecast times and platform changes. Only stops whose times come from a live feed (`live: true`) are taken over; elsewhere the `transport.opendata.ch` forecast stays. A ride that stays seated into another trip (`then`), or whose engine stops answering, keeps the minute-by-minute refetch.
- **Honest vehicle positions**: the vehicle is drawn along the ride from the engine's position (its stops paired with the planned ones by station); tap it to see how it was placed ("Left Zytglogge 1 min ago (measured)", "Estimated from forecasts", "Timetable only"). Switzerland publishes no vehicle GPS, so positions are always worked out from stop times.
- **Changes**: a warning with Replan when live times make a change impossible, "Hurry" or "Take your time" while you walk to the next ride, and "Platform 7 → 5" (with the walk re-routed) when a platform changes.
- **On board** (only with **Settings › Live data › Send my position while I ride** switched on; off by default): while you ride, the app sends your position (5 decimals, about 1 m) to the engine every 20 s to check which vehicles you could be on, and asks "On the 12 instead of the 10?" when it is clearly another one; while you are on the planned vehicle it also reports it (`/api/observe`, at most every 10 s, only with GPS accuracy of 50 m or better). With the setting off, nothing about your position is sent.
- **Live vehicles on the map** from zoom 14 (not during a journey), via the engine's stream, or every 15 s when the stream is refused (503) or fails. Vehicles not updated for 45 s are faded, after 2 min removed.

The engine is `https://kante.omniroute.app` by default. Set `kanteUrl` in `config.js` (see `config.example.js`), or add `?kante=http://127.0.0.1:8080` to the page address for a local engine (`?kante=off` switches it off). `?kante=` only accepts an engine on this machine; any other address there is ignored, so a link cannot send your map area or your journey to someone else's server. Features the engine lacks (`/api/meta` → `features`) are skipped, and without the engine the app works as before; when it can't be reached at load it is asked again every 30 s.

## Getting started

Needs [Node.js](https://nodejs.org) 22.18 or newer.

```bash
git clone https://github.com/justmycode37/Santiago-de-Claude.git
cd Santiago-de-Claude
npm install
npm run dev
```

Open `http://localhost:8000`. `npm run dev` builds the site into `dist/`, serves it and rebuilds when you save a file.

For testing on a phone, run `python3 tools/serve.py` next to it (serves `dist/` gzipped and cached) behind HTTPS (e.g. `tailscale serve`) so GPS, camera, and compass work.

### Where the code is

The app is written in TypeScript. The browser still gets plain scripts with the names it always had: the build only takes the types out, so `dist/live.js` is `src/live.ts` line for line.

| Source | Becomes |
| --- | --- |
| `src/<name>.ts` | `<name>.js`, a script the page loads (`src/live.ts` → `live.js`) |
| `src/app/*.ts` | the page's own script, joined in file name order and put into `index.html` |
| `index.html`, `*.css`, and the `.js` files in the repository root (generated data) | copied as they are |

The files in `src/app` share one scope, like the single script they are joined into, so the number in a file's name is its place in that script. A new script in `src/` needs its `<script src="name.js">` tag in `index.html`, as before.

```bash
npm run check   # check the types
npm test        # the station router's tests
npm run build   # dist/ once, without the dev server
```

### Optional: Google Places search

Place search uses free OpenStreetMap/Photon by default. To switch to Google Places (with ratings and opening hours), copy `config.example.js` to `config.js` (gitignored) and add an API key with **Places API (New)** enabled and restricted to your site's origin.

## Rebuilding data

- **Platforms & stop edges (`platforms.js`)** from opentransportdata.swiss ATLAS + OSM floor levels:
  ```bash
  python3 tools/build_platforms.py
  ```
- **Places & amenities (`map-places.js`)** from `data/` (Bern) and the Swiss toilets in `data/ch/toilets-ch.json` (see [docs/places-data.md](docs/places-data.md)):
  ```bash
  node tools/build-map-places.mjs
  ```
- **Stop scan database (`stop-images/`)** from GTFS + open photo sources (requires `pip install onnxruntime pillow numpy`; optional `MAPILLARY_TOKEN` client token):
  ```bash
  python3 tools/build_stop_images.py --area bern     # one city
  python3 tools/build_stop_images.py --all --fast --resume  # all of Switzerland, per 2 km tile (~1 h)
  python3 tools/build_stop_images.py --gtfs GTFS.zip # lines & destinations per stop edge
  ```

## Deployment

Every push to `main` builds the site and publishes it to GitHub Pages ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)). The workflow publishes only the files the app serves (`node scripts/build.mts --release`) and writes `version.js` with the commit it was built from. The engine is deployed separately, see [`deploy/`](deploy/README.md).

## Other components

- [`kante/`](kante/README.md) & [`deploy/`](deploy/README.md) — Rust journey planner engine (plans the app's journeys through `engine.js` and `engine-journey.js`) and deployment setup.
- [`livemap/`](livemap/README.md) — Separate prototype showing live Swiss vehicles on the map.
- [`docs/`](docs/places-data.md) — Detailed documentation for place and amenity datasets.
