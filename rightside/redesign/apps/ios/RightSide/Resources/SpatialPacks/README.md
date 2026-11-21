# Bern spatial reference pack

`bern-spatial.json` is a derived reference/candidate database, not surveyed pedestrian/floor truth. It contains original Atlas SLOIDs/labels and OSM path/entrance/level tags. Unknown levels remain null. Source hashes, acquisition time, expiry, licence and attribution are embedded. OSM database timestamp supplied by the regional server was malformed; acquisition time is known but source database age remains unknown. Four SWISSIMAGE catalogue IDs are metadata discovery only (2018 imagery), not a current camera reference.

Regenerate offline with `python3 scripts/build-spatial-pack.py` after verifying the acquisition manifest in `dist/workstream-C/snapshots`. Obtain bounded snapshots with `python3 scripts/acquire-spatial-references.py`; cached inputs retain their original ages. An explicit official public Atlas CSV URL may be supplied with `--atlas-url`; no credential acquisition is implemented.

Attribution: opentransportdata.swiss / atlas (SKI); © OpenStreetMap contributors (ODbL1.0, https://www.openstreetmap.org/copyright); © swisstopo catalogue metadata (https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices). The raw OSM snapshot and reproducible extraction query accompany development evidence. Respect derived-database obligations when distributing this pack. No data or app was published by this workstream.

See `docs/hill-climb/evidence/C-spatial-protocol.md` in the parent RightSide workspace for calibration, independent field gates and full provenance. No field-ready AR image pack is bundled.
