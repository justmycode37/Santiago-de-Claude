# Walk network checks per city

The Bern measurements for any city built with `tools/build_walkgraph.py`, from its main station to ~70-85 real places
within ~1 km (Photon / OpenStreetMap): doors reached, metres drawn through buildings that follow no mapped way, route
length against the old online router (OSRM), walks that end with a guessed straight stretch, and every pair of
platforms at the main station: routed, and never across railway tracks on the ground.

```bash
cd tools/walk-eval
python3 city_dests.py zurich      # the places, and the station's tracks (once; they are checked in)
node city_eval.mjs zurich         # the measurements → city_zurich.json (OSRM's answers are kept in osrm_zurich.json)
node stops_eval.mjs zurich        # walks from the station to every stop edge within 1.5 km
python3 register_check.py         # address register points against OpenStreetMap's doors
```

Cities and their main station are in `cities.json`.

## Results (2026-11-21)

| City | Routed | Doors reached (OSM + register) | Through buildings, m per walk (OSRM) | Median length, network vs OSRM | Shorter / longer than OSRM by >5 % | Last stretch marked a guess | Platform pairs routed, across tracks | Median ms |
|---|---|---|---|---|---|---|---|---|
| Bern | 70/70 | 58/58 (51 + 7) | 0.2 (0) | 459 vs 483 m | 28 / 16 | 2 | 992/992, 0 | 14 |
| Zürich | 85/85 | 57/57 (14 + 43) | 0 (0) | 605 vs 668 m | 43 / 27 | 8 | 1104/1104, 0 | 9 |
| Basel | 68/68 | 57/57 (54 + 3) | 0.3 (0) | 685 vs 686 m | 24 / 2 | 13 | 840/840, 0 | 10 |
| Geneva | 83/83 | 65/65 (5 + 60) | 0.2 (0.2) | 574 vs 592 m | 22 / 14 | 6 | 140/140, 0 | 7 |
| Lausanne | 76/76 | 68/68 (14 + 54) | 0 (0) | 665 vs 718 m | 46 / 0 | 17 | 340/340, 0 | 40 |

- **Doors:** "doors reached" counts the places whose building has a door; without the address register only
  14 of 85 places in Zürich, 5 of 83 in Geneva and 14 of 76 in Lausanne had one (OpenStreetMap maps 0.03-0.13 doors
  per building there, against 0.8-0.95 in Bern and Basel).
- **Length:** OSRM's own distance leaves out the straight bits from the start and to the place, which it snaps to its
  streets; they are counted here, as the app draws them. The walks longer than OSRM are mostly ones that go round a
  building through its corridors or doors, where OSRM draws a line through it (Zürich HB's shops: 213 m against 72 m).
- **Guessed last stretch:** a straight line over 20 m to the door or place, or any line into a building with no door
  (counted since the router marks those too): doors and places 20-70 m from any mapped path, forecourts, yards, streets whose sidewalks
  are tagged as drawn separately but are not drawn (Basel's Solothurnerstrasse), shops inside Geneva station.
- **Platforms:** Basel SBB's Gleis 19 and one of Bern's Gleis 13 points lie on the track itself; they now reach their own
  platform across that one track (80 Basel pairs had no route before).
- **Walks to stops** (`stops_eval.mjs`, every tram, bus and train stop edge within 1.5 km of the station, boarded from
  its own bay or platform): 14 of 532 had no route, mostly tram and bus platforms OpenStreetMap draws apart from the
  street they stand in (Bern Zytglogge bay A). A last try now ignores such islands and boards from the street beside
  them: 1 of 532 left (Bern's PostAuto bay X on the station roof, which `platforms.js` gives no floor).
- **Start:** the start points in `cities.json` lie inside the station buildings, 30-45 m from the nearest mapped path,
  so every walk starts with the same short guess; it is not counted.
