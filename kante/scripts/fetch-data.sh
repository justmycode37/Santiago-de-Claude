#!/usr/bin/env bash
# Download the raw inputs into data/raw (or into $KANTE_RAW). Safe to re-run:
# existing files are kept unless you pass --refresh.
#
#   scripts/fetch-data.sh [--refresh]
#
# Sources (all open, no key needed):
#   - National GTFS timetable   opentransportdata.swiss (updated Mon + Thu)
#   - atlas boarding points      opentransportdata.swiss (daily)
#   - OpenStreetMap Switzerland  download.geofabrik.de   (daily)
set -euo pipefail
cd "$(dirname "$0")/.."

refresh=0
[[ "${1:-}" == "--refresh" ]] && refresh=1

OTD=https://data.opentransportdata.swiss
RAW=${KANTE_RAW:-data/raw}
UA="kante-prototype/0.1"

fetch() { # fetch <url> <dest>
  local url=$1 dest=$2
  if [[ -s "$dest" && $refresh -eq 0 ]]; then
    echo "have  $dest"
    return
  fi
  mkdir -p "$(dirname "$dest")"
  echo "fetch $dest"
  # -L: the timetable permalink redirects to a signed storage URL.
  curl -fSL --retry 3 -A "$UA" -o "$dest.part" "$url"
  mv "$dest.part" "$dest"
}

# Timetable year 2026 (valid 2025-12-14 .. 2026-12-12). From 13 December 2026
# switch the dataset slug to timetable-2027-gtfs2020.
fetch "$OTD/en/dataset/timetable-2026-gtfs2020/permalink" "$RAW"/gtfs/gtfs.zip

# atlas registry: boarding points, sectors, boarding accessibility ("actual date" variants).
fetch "$OTD/dataset/b06d90be-91c6-440e-ab97-09f579d2fad0/resource/c2cda870-8f8e-4463-984b-7351d7107228/download/actual-date-world-traffic-point.csv" "$RAW"/atlas/traffic-point.csv
fetch "$OTD/dataset/52c157d0-e6bc-406b-8e7d-63713aa28585/resource/be07f0bd-96c5-44d3-9896-cd46b32857c6/download/actual-date-sectors-and-sector-groups.csv" "$RAW"/atlas/sectors.csv
fetch "$OTD/dataset/8e5931a6-b4aa-456a-9be4-498f28168861/resource/19c170d0-b0a1-4837-8bbd-9c2704dc9131/download/actual-date-platform.csv" "$RAW"/atlas/prm-platform.csv

fetch "https://download.geofabrik.de/europe/switzerland-latest.osm.pbf" "$RAW"/osm/switzerland-latest.osm.pbf

echo
echo "Raw data ready in $RAW."
