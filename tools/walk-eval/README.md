# Walk network checks per city (work in progress)

The Bern measurements for any city built with `tools/build_walkgraph.py`: doors reached, metres drawn through
buildings that follow no mapped way, route length against the old online router (OSRM), and platform changes at the
main station that cross railway tracks on the ground.

```bash
cd tools/walk-eval
python3 city_dests.py zurich      # ~70 Photon places within ~1 km of the main station + the station's tracks
node city_eval.mjs zurich         # the measurements (asks OSRM for the comparison)
```

Cities and their main station are in `cities.json`. Status: tiles built for Zürich, Basel, Geneva and Lausanne;
destinations fetched; only Bern measured so far (51/51 doors, 0 of 992 platform changes across tracks, median
462 m against OSRM's 481 m).
