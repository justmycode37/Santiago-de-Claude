# Santiago de Claude

A Swiss community event map and public transport journey planner. Team project for the Powercoders Hackathon.

[Open the live app](https://justmycode37.github.io/Santiago-de-Claude/) · [Watch the demo](https://justmycode37.github.io/Santiago-de-Claude/demo/)

## Features

- **Journey planner & live tracking**: Plans Swiss public transport and walking trips via the team's [Kante engine](kante/README.md) ([details](docs/journeys.md)) with route alternatives, exact train platforms (Gleis) and bus/tram stop edges (Kante), live vehicle tracking, delay/platform updates, GPS route following, and SBB ticket links.
- **3D station navigation**: Interactive 3D models for Bern, Europaplatz, Wankdorf, Brünnen Westside, Bümpliz Nord, Zürich HB, Basel SBB, Luzern, Lausanne and Genève with bird's-eye and first-person indoor transfer routes, plus a continuous inside view at true heights ([details](docs/station3d-solid.md)).
- **Indoor position**: in the 3D station view, which floor you are on and where, from the phone's sensors, GPS and signs read by Scan ([details](docs/indoor-positioning.md)).
- **Walking routes**: Walks to the stop, between platforms and to the door follow a pedestrian network from OpenStreetMap and swisstopo: right door, arcades and passages, floors, step-free settings ([details](docs/walking-routes.md)).
- **Place & address search**: Search by category (e.g. "restaurant", "Apotheke", "toilet"), place name, or Swiss address/stop (OpenStreetMap via Photon + swisstopo), with draggable start/destination map pins. An empty search offers categories (Restaurants, Hotels, Supermarkets, …; language courses and migration offices with *New to Switzerland* on) that put the best-rated places nearby on the map as cards with photo and website.
- **Events & amenities**: Shows community events alongside public toilets across Switzerland and Bern's public amenities and local places.
- **Camera stop scan**: Menu › **Scan** identifies nearby Swiss stops and shows next departures using sign OCR, GPS/compass, and reference-photo fingerprints (requires HTTPS on phones). Details: [docs/scan.md](docs/scan.md).
- **First-visit introduction**: A welcome page, a short 3D demo walk and two questions (walking speed, access needs) before the map; details and status in [docs/onboarding.md](docs/onboarding.md).
- **Multilingual UI**: Settings › **Language** translates the interface into any of Google Translate's 249 languages.

## Getting started

Needs [Node.js](https://nodejs.org) 22.18 or newer.

```bash
git clone https://github.com/justmycode37/Santiago-de-Claude.git
cd Santiago-de-Claude
npm install
npm run dev
```

Open `http://localhost:8000`. `npm run dev` builds the site into `dist/`, serves it and rebuilds when you save a file. The code is TypeScript in `src/`; see [docs/development.md](docs/development.md) for the layout, the build and the checks.

For testing on a phone, run `python3 tools/serve.py` next to it (serves `dist/` gzipped and cached) behind HTTPS (e.g. `tailscale serve`) so GPS, camera, and compass work.

### Optional configuration

Copy `config.example.js` to `config.js` (gitignored) to switch place search from OpenStreetMap/Photon to Google Places (**Places API (New)** key restricted to your origin) or point `kanteUrl` at a local Kante engine instead of `https://kante.omniroute.app` (or pass `?kante=http://127.0.0.1:8080` / `?kante=off` in the URL).

## Rebuilding data

- **Platforms & stop edges (`platforms.js`)** from opentransportdata.swiss ATLAS + OSM floor levels:
  ```bash
  python3 tools/build_platforms.py
  ```
- **Places & amenities (`map-places.js`)** from `data/` (see [docs/places-data.md](docs/places-data.md)):
  ```bash
  node tools/build-map-places.mts
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
  python3 tools/build_walkgraph.py --area bern     # built: bern, zurich, basel, geneva, lausanne
  ```

## Other components

- [`kante/`](kante/README.md) & [`deploy/`](deploy/README.md) — Rust journey planner and live-tracking engine ([live API docs](kante/docs/LIVE-API.md)) and server deployment setup.
- [`livemap/`](livemap/README.md) — Separate prototype showing live Swiss vehicles on the map.
- [`rightside/`](rightside/README.md) — Native iPhone companion (SwiftUI/ARKit): reads bus/tram displays and shows AR guidance to the boarding point; built with Xcode, not part of the site.
- [`docs/`](docs/places-data.md) — Detailed documentation for place and amenity datasets.
- [`.github/workflows/pages.yml`](.github/workflows/pages.yml) — Builds the site and publishes it to GitHub Pages on pushes to `main`.
