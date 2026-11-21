# Indoor position in stations: floor and place from the phone's sensors

The 3D station view (`station3d.js`, models in `stations3d/`, see [stations3d/SCHEMA.md](../stations3d/SCHEMA.md))
shows the walk through a station floor by floor. GPS alone cannot follow it there: it is 20–50 m off indoors, gone
underground, and knows no floor. This part works out **which floor you are on and where**, from everything the phone
has, and hands that to the viewer.

| File | What |
| --- | --- |
| `indoorloc.js` | The filter (`INDOORLOC`): station model as a graph, particle filter, browser sensors, recorder, replay |
| `signloc.js` | Signs as evidence (`SIGNLOC`): "Gleis 7 Sektor C", "Gleise 1–6 →", exits, named underpasses, shops |
| `indoornav.js` | Glue (`INDOORNAV`): runs the filter while a station is open in 3D, feeds `Station3D.setUser` |
| `indoorloc-dev.html` | Development page: live sensors, floor probabilities, "I'm here", signs, record / export / replay |
| `tools/sim_indoorloc.cts` | Simulated walks through a model with realistic sensor noise; scores and a regression check |

## How it works

**The station model is the map.** Particles (1,500 guesses of where you are) live *on* the walking graph of the
model, each on a floor. A particle can only change floor by moving along a stair, escalator, ramp or lift edge. That
single rule does most of the work: a floor change needs a connector where you are, so a pressure jump from a train
pushing air through an underground station, a heading glitch or a GPS jump cannot move you to another floor by
itself, and when you do go down the stairs, the floor follows.

Evidence, all optional, each weighed for what it is worth:

| Evidence | From | What it says | Caveats |
| --- | --- | --- | --- |
| Steps + heading | `DeviceMotionEvent` (step peaks, Weinberg length), gyro-carried heading pulled slowly to the compass | how far and which way you walked; particles follow the graph | phone in a pocket: no heading (then the graph alone); steel and trains bend the compass (the gyro carries it through) |
| Time | — | escalators carry you without steps (0.5 m/s), lifts move you while you stand | — |
| GPS | the app's fix | where, roughly; **and** that you are probably outdoors or at street level (it needs sky) | indoors 20–50 m and biased; none underground |
| Barometer | **native wrapper only** (Capacitor plugin) or `INDOORLOC.pushPressure(hPa)` | relative height: a floor is 3–9 m ≈ 0.35–1 hPa | no browser exposes it; train piston surges, doors and ventilation (held and re-anchored, readings tempered) |
| Signs | Scan's OCR (`scan:text`), or typed in | platform + sector sign = you are there (strong); a direction sign = you are near the way to it (weak); names of exits, halls, shops | a sign is evidence, never a fix; chains (several shops) are ambiguous |
| Journey | the route opened in 3D | starting on platform 7 = you just got off there | — |
| The traveller | "I'm on floor…", "I'm here" | resets the floor / place | — |

It never pretends: the estimate carries per-floor probabilities and `confident: false` until one floor clearly wins,
and the viewer then shows a wide circle without a floor.

Robustness built in (found by failing simulations and by two independent code reviews):
- no start from nothing: steps alone never place you; GPS, the journey, a sign or the traveller does;
- **augmented MCL**: when the particles explain the steps much worse than they used to (a dead end, the wrong
  corridor), some start again around the estimate and a few anywhere;
- a good GPS fix nobody explains, or a strong sign far from every particle, relocalises;
- barometer: height changes faster than a person moves (> 1.5 m/s over 4 s) are disturbances: held, then the
  reference is re-anchored; one-second readings are tempered (they are not independent).
- evidence that arrives in streams is tempered: GPS fixes a second apart count as about one per 8 s, so "it has
  sky" cannot talk the filter onto the street floor; the same sign read again within 15 s is ignored;
- particles placed by a sign, a GPS relocalisation or a recovery weigh what they are worth (a weak direction sign
  never places any) and get a barometer offset that fits the current reading;
- a particle in a lift is either riding or standing at a stop; walking out leaves from the floor it stopped at.

## Results (simulation, Bern model)

`node tools/sim_indoorloc.cts` walks 15 scenarios × 8 runs through the Bern model on routes of `station-route.js`:
Bahnhofplatz → RBS platform 21 (level −2) by stairs and by lift, → platform 7 through the underpass, platform 7 → 21,
21 → the bus terminal on the Welle (level 2), lost with only signs, phone in pocket, strong magnetic disturbance.

| | right floor (whole walk) | floor change followed after (median) | confident and wrong | position error (median / 90 %) |
| --- | --- | --- | --- | --- |
| Main walks, with barometer | 97–99 % | 1–2 s | 0 % | 0.4–0.8 m / 1–5 m |
| Main walks, browser only (no barometer) | 91–98 % | 1–13 s | 0 % | 0.4–0.7 m / 1–5 m |
| Lost underground, reads one sector sign | 95 % | 1 s | 0 % | 0.8 / 15 m |
| Phone in pocket (no heading) | 91 % | 7 s | 0.1 % | 20 / 72 m |
| Compass only, no gyro (worst case) | 63 % | 2 s | 4.7 % | 31 / 65 m |
| Stress: everything a bit off at once (below) | 93–98 % | 0–4 s | 0–1.4 % | 1–4 m / 4–18 m |

The stress scenarios use escalator and lift speeds the filter does not assume, level heights off by up to ±1 m,
compass offsets of 25° for a minute at a time, 5 % missed and 5 % phantom steps, indoor GPS fixes that claim 12 m
but are 60 m off (10 %), and sector letters misread one time in three.

**These numbers test the logic, not the world.** The noise models (compass bias 12°, step length ±8 %, GPS 6–10 m
outdoors and 25–55 m biased indoors, pressure noise 0.03 hPa) are assumptions. Real walks will be worse, the
barometer likely matters more than here (the simulated heading is too kind), and the only way to know is to record
real walks (below). Steps and headings in the simulation come from the route geometry with modelled noise; the
phone adapter (`Sensors`: step detection, gyro/compass fusion) is only exercised by replaying real recordings.
`--check` is a regression test against these numbers (it also fails when a scenario's route disappears).

## Testing on a phone

1. Serve over HTTPS (`python3 tools/serve.py` behind `tailscale serve`) and open `indoorloc-dev.html?key=bern`.
2. **Start sensors** (iOS asks for motion access), then **Record**.
3. Walk a route. Every so often tap **I'm here…** and then your place on the model: that is the ground truth.
4. **Stop**, **Export**. Replay it with **Import & replay** (animated in the 3D view) or
   `node tools/sim_indoorloc.cts --replay file.json`.

In the app nothing is needed: opening a station in 3D starts it (iOS: the first tap in the 3D view asks for motion
access). The station session outlives the 3D view by 10 minutes, so you can close it, read a sign with Scan (which
counts), and open it again where you are. GPS fixes more than 300 m outside the model pass straight to the viewer
(which then says you are not at the station), and the journey's starting platform is only assumed when GPS does
not say otherwise. The journey's start alone never shows a position (the trip may be tomorrow, or location may be
off): the dot appears once a recent GPS fix near the station, a sign or the traveller's own "I am here" says they
are there (`INDOORNAV.state().live`).

`station3d.js` got a few small additions for this:
- `setUser` takes `levelSure: true` from the indoor position, so a floor the filter is sure of beats the floor of the
  viewer's previous route snap; and `at` (when the GPS fix was taken, ms since 1970). The app passes it, a fix older
  than a minute does not count as "here" for the indoor position, and a remembered fix that old is not shown when the
  view opens.
- `'opening'` (`{ key, replaces }`) at every `open()`: a station that replaces another one says no `'close'`, so the
  indoor position ends the old station's showing there and the stand-in in `index.html` forgets the old opening.
- `'here'` (`{ step, xy, level }`) when the traveller taps "I'm here" at a step: the indoor position takes it like
  `INDOORNAV.here()`, so later steps move the dot even without GPS.

## Research behind the choices (November 2026)

**Station structure.** No open source gives floor heights inside Swiss stations. The best open structure is
OpenStreetMap indoor tagging (Simple Indoor Tagging), which SBB's own mapping team (ROKAS) maintains at the big
stations: walking network per floor with levels, stairs, escalators with direction, lifts with the floors they
serve. An extract of the Swiss OSM data around six stations found 430–1,750 indoor-tagged objects each (Zürich HB:
levels −4…+5, 188 stairs, 107 escalators, 72 lifts); `ele` on stop positions gives some real heights (Zürich HB:
level 0 at 408 m, −4 at 392 m). SBB open data adds 5,087 sector signs with position and letters (`sektortafel`),
platforms, clocks and ticket machines (data.sbb.ch); SBB's Journey Maps tiles (`rokas_indoor`) have per-floor indoor
geometry but need a key and their terms of reuse are unknown. swisstopo (swissBUILDINGS3D, swissSURFACE3D) gives
the outer shells and ground heights, nothing inside. The Bern model in `stations3d/` combines all of these with
measured heights. A connectivity check of OSM found real gaps worth fixing there, e.g. at Bern platforms 3–8 had no
step-free path in OSM (lifts not joined to the paths), and the RBS platforms only 2 path nodes.

**Sensors.** Verified: no browser exposes a barometer (the W3C Barometer draft never shipped; the "Compute Pressure
API" is about CPU load). Capacitor plugins (`@capawesome-team/capacitor-barometer`, `@capgo/capacitor-barometer`)
give it in a native wrapper; every iPhone since the 6 and most Android flagships have one. A phone barometer resolves
±0.03 hPa (≈ 25 cm) relative but is ±0.5 hPa (≈ 4 m) absolute, so floors are tracked relative to a known start.
Published barometric floor detection: 85–99 % (Ye 2014 B-Loc, Yu 2019, Marjasz 2024, Lin 2022). Train piston effects
in underground stations are an order of magnitude larger than one floor. MeteoSwiss publishes 10-minute station
pressure for free with CORS (`data.geo.admin.ch/ch.meteoschweiz.messwerte-aktuell/VQHA80.csv`, barometer heights in
`ogd-smn_meta_stations.csv`): usable later to remove weather drift and give an absolute height. Map-matched particle
filters with pedestrian dead reckoning reach ~1–3 m in the literature (Ai 2025, Harder 2022, Wang 2020). WebXR
`immersive-ar` with camera access gives 6-DoF visual-inertial tracking in Chrome on Android (ARCore), not on iOS.

**Camera.** Signs are the strongest cheap cue in stations, which repeat themselves (TextInPlace, 2025; Zimmerman et
al., room numbers in a particle filter). SBB signage is pictogram-heavy; the reliably readable text is platform
numbers, sector letters, exits and named places, which is what `signloc.js` uses. PaddleOCR.js (PP-OCRv5 mobile,
~12 MB) should read scene text much better than tesseract.js and is worth benchmarking. Full camera pose (≈ 1 m / 5°
for ~70 % of queries in Seoul's Gangnam station, NAVER LABS dataset) needs a reference map of each station: walk it
with a phone video, reconstruct with COLMAP/GLOMAP or ACE0 (hloc pipeline), georeference with the sector signs, and
match on the device (LightGlue/XFeat ONNX). No such map of a Swiss station is public. Immersal's VPS for Web is the
paid shortcut. Datasets to benchmark on: NAVER LABS indoor (Gangnam station), ETH LaMAR.

## Next steps, in order

1. **Record real walks** in Bern (hand and pocket, stairs, escalators standing, lifts, rush hour, iOS and Android)
   and tune the noise models on them. Nothing else is worth more.
2. **Native wrapper with the barometer** (Capacitor), feeding `INDOORLOC.pushPressure`; then MeteoSwiss drift
   correction.
3. **Motion classes** from the accelerometer (stairs vs. flat steps, a lift starting): the filter already takes
   `step.stairs` and `motion({ kind: 'lift', dir })`.
4. **Better sign reading**: PaddleOCR.js benchmark on real station photos; departure boards (line + destination
   against the live departures, already in `SIGNLOC.match(text, model, { departures })`).
5. **More stations**: Zürich HB has the richest OSM indoor data of all; building its model with
   `tools/build_station3d.py` gives it the 3D view and indoor position at once.
6. **Visual positioning** where it pays: a reference map of one station from a video walk, matched on the phone.
