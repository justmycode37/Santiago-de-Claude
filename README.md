# Santiago de Claude

A Swiss community event map and public transport journey planner. Team project for the Powercoders Hackathon.

[Open the live app](https://santiago-de-claude.vercel.app/)

## Getting started

```bash
git clone https://github.com/justmycode37/Santiago-de-Claude.git
cd Santiago-de-Claude
python3 -m http.server 8000
```

Open `http://localhost:8000` in your browser.

For a phone, use `python3 tools/serve.py` instead: it sends the files gzipped (platforms.js 2.2 MB → 0.8 MB)
and lets the browser cache them, so the app opens much faster. The phone needs HTTPS for GPS, for example
through `tailscale serve`.

## Search: places, food, shops, anything

The search bar finds places the way Google Maps does, not only addresses and stops (`places.js`):

- **A kind of place**, in English, German, French or Italian: "restaurant", "coffee", "Apotheke", "toilet near me",
  "supermarket", "ATM", "museum", … lists the nearest ones around the part of the map you are looking at, with the
  distance from you. Enter, or **Show on the map**, puts them all on the map as pins.
- **A name**: "Migros", "Einstein Kaffee", "Zentrum Paul Klee", … lists the matching places, nearest first.
- Addresses, towns, postcodes, mountains and lakes still come from swisstopo, in the same list.

Tap a result or a pin and the app plans the trip there with its own journey planner, as for any destination.

By default the places come from OpenStreetMap through [Photon](https://photon.komoot.io), which is free and needs no
key. The public Photon server is meant for light use: for many users, run your own Photon or switch to Google.
To use **Google Places** instead (Google's places, with ratings and open/closed), copy `config.example.js` to
`config.js`, enable "Places API (New)" in Google Cloud, and put the API key there. `config.js` is not committed.
Restrict the key to your site's address: the page sends it from the browser. Each search is a paid Google
request (Text Search, with the rating and opening-hours fields), so the search waits a little longer for you to stop typing.

## Platforms and stop edges

The map shows the exact position of every train platform (Gleis) and bus/tram stop edge (Kante) in
Switzerland as small white dots once you zoom in close (zoom 17+). Tap one to see its next departures. Journeys start and end on the platform
the timetable gives, or, when it gives none, on the edge for the direction of travel.

The journey sheet has one card per step, swiped sideways. Ride cards show where to stand (sectors or
side of the road, floor level, next stop). Change cards show the time to spare, the walk and any change of
floor. The bar at the top shows the whole trip: each ride is a solid line with its name above it, and
walking, changing and waiting are rows of dots. The part already travelled fades.

On the map, the Kante journey design shows each ride in its line colour, a circle at every stop, walks as a yellow band with arrows, a
"Platform 7" / "Bay C" sign where you board, and a marker where a walk changes floor. The base map and its
dark variant are the same as in that prototype, rebuilt to run in this page without a server.

The data comes from the official ATLAS master data on [opentransportdata.swiss](https://opentransportdata.swiss)
(service points + traffic points), with floor levels from OpenStreetMap, and is stored in `platforms.js`.
To refresh it:

```bash
python3 tools/build_platforms.py
```

## Live tracking

During a trip the app follows you along the route:

- **Your position** is the blue dot (GPS). Each fix is matched to the nearest point on the route, so the app knows
  which step you are on and how far along it you are. The cards move on by themselves, the part of the route
  you have travelled fades on the map and in the top bar, and a status line shows what is next, for example
  "120 m to Platform 7 · S1 in 4 min" or "On S1 · 3 stops to Bern", with the distance left. If you leave the
  route, or a ride leaves without you, the status line offers **Replan**.
- **Real-time data** comes from the operators' forecasts on transport.opendata.ch (delays, platform changes), fetched
  again every minute while the trip is on. Departure, arrival and change times use these live times.
- **Vehicles:** Switzerland has no open live feed of vehicle GPS positions, so the vehicle of the ride
  under way is placed using its live stop times. When GPS shows you are on board, your blue dot stands in for the vehicle.
- **Without GPS**, a fainter blue dot shows where the live timetable puts you.

## Live map of every vehicle (prototype)

`livemap/` is a separate prototype: a map of every bus, tram and train running in Switzerland, moving along
the real rails and roads. It needs its own server and the Kante engine, so it is not part of the deployed
site. See [livemap/README.md](livemap/README.md).

## Kante engine (not used by the app yet)

`kante/` holds the Rust journey planner from the Kante prototype: its own routing on the national timetable,
a multi-level walking network, exact boarding points and live data from opentransportdata.swiss. The app
still plans journeys with transport.opendata.ch; switching it to the engine is the next step. `deploy/`
hosts the engine and redeploys it when `main` changes. See [kante/README.md](kante/README.md) and
[deploy/README.md](deploy/README.md).

## Places and amenities data

`data/` holds Bern toilets, drinking water, benches, AEDs and other public amenities, plus Google-Maps-style places (restaurants, shops, hotels, services) from OpenStreetMap and official city, canton and SBB layers. See [docs/places-data.md](docs/places-data.md).

The events button in the ••• menu shows them on the map as icons, together with the community events. Settings › On the map picks which groups it shows (all of them at first). The map uses `map-places.js`, built from `data/` with:

```bash
node tools/build-map-places.mjs
```

## Scan: recognise stops with the camera

Menu › **Scan** opens the rear camera. Point it at your surroundings: the stops around you appear as labels at
their real direction, and the sheet at the bottom shows the stop you are looking at with its next departures
(for the exact side of the street when that is known). **Show on map** opens it on the map. Tap a sign in
the picture to read it straight away. Without a camera (or on a desktop), the camera button takes a photo instead.

The stop is found from three kinds of evidence, strongest first:

1. **Signs** (tesseract.js, in the browser): the stop name on the pole, matched to the stops around you (or, without
   GPS, to all ~30,000 stops). A "Kante C" / "Gleis 7" next to it, or a destination that only leaves from one edge
   (compared with the live departures), tells the edges apart. Tested on real photos of Swiss stop signs: 5 of 6
   recognised, no wrong answers.
2. **Position and compass**: the exact position of every stop edge (`platforms.js`) against your GPS position and
   the direction the camera points. On their own they only say "Nearby · ahead", never "Recognised".
3. **Reference photos** (`stop-images/`): the camera picture is compared with photos of the stops around you. On its
   own, photo similarity picks the right stop only about 40–55 % of the time (neighbouring stops look alike and
   share photos), so it only breaks ties, and only counts as recognition when the position agrees.

The phone downloads the sign reader (~6 MB) and the image model (24 MB) once, when Scan is first used. Camera
and compass need HTTPS (or localhost); on iPhone, allow motion access when asked.

### The stop photo database

`stop-images/` holds, for each stop, links to photos of it from open sources and a fingerprint of each photo
(DINOv2-small, 768 numbers as int8). No photos are stored or downloaded on the phone, only fingerprints, in
0.1° tiles loaded for where you are. Every photo keeps its author, licence and link.

| Source | What it gives | Tied to the stop by |
| --- | --- | --- |
| Wikidata (P18, P373) | Photos and Commons categories of stations | UIC/IBNR number, or position + name |
| Wikimedia Commons | Category photos; geotagged photos near the stop that name it or a transit word | Category / place + words |
| SBB open data | Official station photos (20 stations) | UIC number |
| OpenStreetMap | `image=` / `wikimedia_commons=` / `panoramax=` / `mapillary=` on stops | The stop itself |
| Panoramax | Street-level photos 3–35 m away that face the stop edge | Position + viewing direction |
| Mapillary (optional) | Street-level photos 3–35 m away that face the stop edge | Position + viewing direction |

To build or extend it (results are cached in `~/.cache/stopvision`, so runs can be stopped and continued):

```bash
pip install onnxruntime pillow numpy
python3 tools/build_stop_images.py --area bern          # bern, zurich, basel, geneva, lausanne, luzern, ...
python3 tools/build_stop_images.py --all --modes t      # every train station in Switzerland
python3 tools/build_stop_images.py --all                # everything (many hours)
python3 tools/build_stop_images.py --calibrate          # how well photos alone tell nearby stops apart
```

Mapillary has by far the most street-level photos of bus and tram stops. To use it, register an app at
[mapillary.com/dashboard/developers](https://www.mapillary.com/dashboard/developers) with the **Read** permission and
run with `MAPILLARY_TOKEN=MLY|...` (or `--mapillary-token-file`). The token is only used by the build script; it is
not stored in the database or the app. Google Street View is not used: its terms do not allow this.
