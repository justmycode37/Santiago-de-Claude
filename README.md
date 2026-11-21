# Santiago de Claude

A Swiss community event map and public transport journey planner. Team project for the Powercoders Hackathon.

[Open the live app](https://justmycode37.github.io/Santiago-de-Claude/) · [Watch the demo](https://justmycode37.github.io/Santiago-de-Claude/demo/)

## Features

- **Journey planner & live tracking**: Plans Swiss public transport and walking trips via the team's [Kante engine](kante/README.md) (`transport.opendata.ch` fallback) with route alternatives, exact train platforms (Gleis) and bus/tram stop edges (Kante), live vehicle tracking, delay/platform updates, GPS route following, and SBB ticket links.
- **3D station navigation**: Interactive 3D models for Bern, Europaplatz, Wankdorf, Brünnen Westside, and Bümpliz Nord with bird's-eye and first-person indoor transfer routes.
- **Walking routes**: Walks to the stop, between platforms and to the door follow a pedestrian network from OpenStreetMap and swisstopo: right door, arcades and passages, floors, step-free settings ([details](docs/walking-routes.md)).
- **Place & address search**: Search by category (e.g. "restaurant", "Apotheke", "toilet"), place name, or Swiss address/stop (OpenStreetMap via Photon + swisstopo), with draggable start/destination map pins.
- **Events & amenities**: Shows community events alongside public toilets across Switzerland and Bern's public amenities and local places.
- **Camera stop scan**: Menu › **Scan** identifies nearby Swiss stops and shows next departures using sign OCR, GPS/compass, and reference-photo fingerprints (requires HTTPS on phones).
- **Multilingual UI**: Settings › **Language** translates the interface into any of Google Translate's 249 languages.

## Getting started

```bash
git clone https://github.com/justmycode37/Santiago-de-Claude.git
cd Santiago-de-Claude
python3 -m http.server 8000
```

Open `http://localhost:8000`.

For testing on a phone, run `python3 tools/serve.py` instead (serves gzipped, cached assets) behind HTTPS (e.g. `tailscale serve`) so GPS, camera, and compass work.

### Optional configuration

Copy `config.example.js` to `config.js` (gitignored) to switch place search from OpenStreetMap/Photon to Google Places (**Places API (New)** key restricted to your origin) or point `kanteUrl` at a local Kante engine instead of `https://kante.omniroute.app` (or pass `?kante=http://127.0.0.1:8080` / `?kante=off` in the URL).

## Rebuilding data

- **Platforms & stop edges (`platforms.js`)** from opentransportdata.swiss ATLAS + OSM floor levels:
  ```bash
  python3 tools/build_platforms.py
  ```
- **Places & amenities (`map-places.js`)** from `data/` (see [docs/places-data.md](docs/places-data.md)):
  ```bash
  node tools/build-map-places.mjs
  ```
- **3D station models (`stations3d/`)** from OSM + ATLAS (requires `pip install shapely`):
  ```bash
  python3 tools/build_station3d.py
  ```
- **Stop scan database (`stop-images/`)** from GTFS + open photo sources (requires `pip install onnxruntime pillow numpy`; optional `MAPILLARY_TOKEN`):
  ```bash
  python3 tools/build_stop_images.py --area bern     # or --all --fast --resume
  python3 tools/build_stop_images.py --gtfs GTFS.zip # lines & destinations per stop edge
  ```
- **Walking network (`walkgraph/`)** from OpenStreetMap + swisstopo swissTLM3D (see [docs/walking-routes.md](docs/walking-routes.md)):
  ```bash
  python3 tools/build_walkgraph.py --area bern
  ```

## Other components

- [`kante/`](kante/README.md) & [`deploy/`](deploy/README.md) — Rust journey planner and live-tracking engine ([live API docs](kante/docs/LIVE-API.md)) and server deployment setup.
- [`livemap/`](livemap/README.md) — Separate prototype showing live Swiss vehicles on the map.
- [`docs/`](docs/places-data.md) — Detailed documentation for place and amenity datasets.
- [`.github/workflows/pages.yml`](.github/workflows/pages.yml) — Publishes the static site to GitHub Pages on pushes to `main`.
