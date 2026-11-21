# Santiago de Claude

A Swiss community event map and public transport journey planner. Team project for the Powercoders Hackathon.

[Open the live app](https://santiago-de-claude.vercel.app/)

## Features

- **Journey planner & live tracking**: Plans Swiss public transport trips (`transport.opendata.ch`) to exact train platforms (Gleis) and bus/tram stop edges (Kante), with live delay/platform updates and GPS route tracking.
- **Place & address search**: Search by category (e.g. "restaurant", "Apotheke", "toilet"), place name, or Swiss address/stop (OpenStreetMap via Photon + swisstopo).
- **Events & amenities**: Shows community events on the map alongside public toilets all over Switzerland and Bern's public amenities and local places.
- **Camera stop scan**: Menu › **Scan** identifies nearby stops and shows next departures using sign OCR, GPS/compass, and reference-photo fingerprints (requires HTTPS on phones).

## Getting started

```bash
git clone https://github.com/justmycode37/Santiago-de-Claude.git
cd Santiago-de-Claude
python3 -m http.server 8000
```

Open `http://localhost:8000`.

For testing on a phone, run `python3 tools/serve.py` instead (serves gzipped, cached assets) behind HTTPS (e.g. `tailscale serve`) so GPS, camera, and compass work.

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
  python3 tools/build_stop_images.py --area bern     # or --all --resume
  python3 tools/build_stop_images.py --gtfs GTFS.zip # lines & destinations per stop edge
  ```

## Other components

- [`kante/`](kante/README.md) & [`deploy/`](deploy/README.md) — Rust journey planner engine (not wired into the main app yet) and deployment setup.
- [`livemap/`](livemap/README.md) — Separate prototype showing live Swiss vehicles on the map.
- [`docs/`](docs/places-data.md) — Detailed documentation for place and amenity datasets.
