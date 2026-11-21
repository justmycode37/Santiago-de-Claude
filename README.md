# Santiago de Claude

A Swiss community event map and public transport journey planner. Team project for the Powercoders Hackathon.

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

## Scan: recognise stops with the camera

Menu › **Scan** opens the rear camera. Point it at your surroundings: the stops around you appear as labels at
their real direction, and the sheet at the bottom shows the stop you are looking at with its next departures
(for the exact side of the street when that is known). **Show on map** opens it on the map. Tap a sign in
the picture to read it straight away. Without a camera (or on a desktop), the camera button takes a photo instead.

The stop is found from three kinds of evidence, strongest first:

1. **Signs** (tesseract.js, in the browser): the stop name on the pole, matched to the stops around you (or, without
   GPS, to all ~27,000 stops, and then only a name that fits one stop counts). A "Kante C" / "Gleis 7" next to it,
   or a destination that only leaves from one edge, tells the edges apart: destinations and line numbers come from
   the timetable (offline, for every stop) and the live departures. Tested on real photos of Swiss stop signs:
   5 of 6 recognised, no wrong answers; a bare "Bahnhof" or a destination listed on the sign never counts as the stop.
2. **Position and compass**: the exact position of every stop edge (`platforms.js`) against your GPS position and
   the direction the camera points. On their own they only say "Nearby · ahead", never "Recognised".
3. **Reference photos** (`stop-images/`): the camera picture is compared with photos of the stops around you. On its
   own a photo match is not reliable enough (neighbouring stops look alike and share photos), so it only breaks
   ties, and only counts as recognition when the position agrees.

The phone downloads the sign reader (~6 MB) and the image model (24 MB) once, when Scan is first used. Camera
and compass need HTTPS (or localhost); on iPhone, allow motion access when asked.

### Speed on a phone

Both engines run outside the page (the sign reader in its own worker, the image model in a Web Worker), so the
camera picture and the labels keep moving while they work; only one of the two runs at a time, a tapped sign goes
first, and photos are only compared while they can still change the answer. The sign image is prepared with the
browser's own (GPU) canvas filters and handed over as a JPEG, so the page never loops over the pixels itself.
Measured in Chrome on a desktop PC (single-threaded WebAssembly, as on a phone with static hosting): sign reading
~0.1 s on a sign photo and ~0.5 s on a busy street scene, photo fingerprint ~0.25 s, 59–60 fps during a scan. A phone
is typically 2–3× slower, so expect a sign to be read in well under 2 s and a photo compared in about 0.5–0.7 s.

To measure it on your phone, open **`scan-bench.html`** (same server as the app). It times both engines on a real
Swiss stop sign and checks that the screen keeps drawing. During a scan, open the app with `?scandebug` (or tap the
status text three times) for live numbers: fps, slow frames, ms per sign reading and photo, tiles loaded, GPS and
compass accuracy.

### The stop database

`stop-images/` holds, per stop, links to photos of it from open sources with a fingerprint of each photo, and the
lines and destinations of each edge. No photos are stored or downloaded on the phone: only fingerprints (DINOv2-small,
reduced to 128 numbers, int8) in 0.02° tiles (~2 km), loaded for where you are and dropped when you walk away. Every
photo keeps its author, licence and link.

| Source | What it gives | Tied to the stop by |
| --- | --- | --- |
| Swiss timetable GTFS (opentransportdata.swiss) | Lines and destinations of every stop edge (26,000 stops, ~4 MB) | Platform SLOID + position (≤ 3 m) |
| Wikidata (P18, P373) | Photos and Commons categories of stations | UIC/IBNR number, or position + name |
| Wikimedia Commons | Category photos; geotagged photos near the stop that name it or a transit word | Stop's own category / place + words |
| SBB open data | Official station photos (20 stations) | UIC number |
| OpenStreetMap | `image=` / `wikimedia_commons=` on stops | The stop itself |
| Panoramax | Street-level photos 3–35 m away that face the stop edge | Position + viewing direction |
| Mapillary (optional) | Street-level photos 3–35 m away that face the stop edge | Position + viewing direction |

Only freely licensed photos are used (CC BY, CC BY-SA, CC0, public domain; no NC/ND).

To build or extend it (downloads and fingerprints are cached in `~/.cache/stopvision`, so runs can be stopped and
continued with `--resume`):

```bash
pip install onnxruntime pillow numpy
python3 tools/build_stop_images.py --area bern          # bern, zurich, basel, geneva, lausanne, luzern, ...
python3 tools/build_stop_images.py --all --resume       # all of Switzerland (many hours; continue with --resume)
python3 tools/build_stop_images.py --gtfs GTFS.zip      # lines + destinations of every stop edge
python3 tools/build_stop_images.py --calibrate          # how well photos alone tell nearby stops apart
```

The GTFS zip is the current "Fahrplan GTFS" of the year on [opentransportdata.swiss](https://opentransportdata.swiss)
(e.g. `timetable-2027-gtfs2020` from mid-December 2026); run `--gtfs` again with each new timetable.

Mapillary has by far the most street-level photos of bus and tram stops. To use it, register an app at
[mapillary.com/dashboard/developers](https://www.mapillary.com/dashboard/developers) with the **Read** permission and
run with `MAPILLARY_TOKEN=MLY|...` (or `--mapillary-token-file`). Use the app's **Client token** (open it with
"View" in the Client token column), not the client secret: both start with `MLY|`, but the secret cannot read photos.
The token is only used by the build script; it is not stored in the database or the app. Google Street View is not
used: its terms do not allow this.
