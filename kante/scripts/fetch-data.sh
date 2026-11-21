#!/usr/bin/env bash
# Download the raw inputs into data/raw (or into $KANTE_RAW). Safe to re-run:
# existing files are kept unless you pass --refresh.
#
#   scripts/fetch-data.sh [--refresh]
#
# Sources (all open, no key needed):
#   - National GTFS timetable   opentransportdata.swiss (updated Mon + Thu; the
#                               timetable year in force today, see timetable_year)
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

# The timetable year in force on a date: a new one starts on the second Sunday of
# December (13 Dec 2026, 12 Dec 2027). KANTE_GTFS_DATASET overrides the dataset.
timetable_year() { # timetable_year [YYYY-MM-DD]
  local d=${1:-$(date +%F)} y dow first
  y=${d:0:4}
  dow=$(date -d "$y-12-01" +%u)     # 1 = Monday … 7 = Sunday
  first=$(( (7 - dow) % 7 + 1 ))    # day of December's first Sunday
  if [[ ! $d < $(printf '%s-12-%02d' "$y" $((first + 7))) ]]; then echo $((y + 1)); else echo "$y"; fi
}
dataset=${KANTE_GTFS_DATASET:-timetable-$(timetable_year)-gtfs2020}
# A new timetable year is a different file: fetch it even without --refresh.
if [[ -s "$RAW"/gtfs/gtfs.zip && "$(cat "$RAW"/gtfs/DATASET 2>/dev/null)" != "$dataset" ]]; then
  echo "timetable: $(cat "$RAW"/gtfs/DATASET 2>/dev/null || echo unknown) -> $dataset"
  mv "$RAW"/gtfs/gtfs.zip "$RAW"/gtfs/gtfs.previous.zip
fi
if ! fetch "$OTD/en/dataset/$dataset/permalink" "$RAW"/gtfs/gtfs.zip; then
  # Not published yet, or a hiccup: keep the timetable there was.
  if [[ -s "$RAW"/gtfs/gtfs.previous.zip ]]; then
    echo "warning: could not fetch $dataset; keeping the previous timetable" >&2
    mv "$RAW"/gtfs/gtfs.previous.zip "$RAW"/gtfs/gtfs.zip
    dataset=$(cat "$RAW"/gtfs/DATASET 2>/dev/null || echo unknown)
  else
    exit 1
  fi
fi
rm -f "$RAW"/gtfs/gtfs.previous.zip
echo "$dataset" > "$RAW"/gtfs/DATASET

# atlas registry: boarding points, sectors, boarding accessibility ("actual date" variants).
# The portal gives each upload a new resource id, so the current link is read from the dataset page.
atlas_url() { # atlas_url <dataset id> <file name>
  local page
  page=$(curl -fsSL --retry 3 -A "$UA" "$OTD/dataset/$1") || return 1
  grep -oE "https://[^\"']*/dataset/$1/resource/[^\"']*/download/$2" <<<"$page" | head -n 1
}
atlas() { # atlas <dataset id> <file name> <dest>
  local url
  url=$(atlas_url "$1" "$2") || true
  if [[ -z "$url" ]]; then
    if [[ -s "$3" ]]; then echo "keep  $3 (no link found for $2)"; return; fi
    echo "error: no download link for $2 on $OTD/dataset/$1" >&2
    return 1
  fi
  fetch "$url" "$3"
}
atlas b06d90be-91c6-440e-ab97-09f579d2fad0 actual-date-world-traffic-point.csv "$RAW"/atlas/traffic-point.csv
atlas 52c157d0-e6bc-406b-8e7d-63713aa28585 actual-date-sectors-and-sector-groups.csv "$RAW"/atlas/sectors.csv
atlas 8e5931a6-b4aa-456a-9be4-498f28168861 actual-date-platform.csv "$RAW"/atlas/prm-platform.csv

fetch "https://download.geofabrik.de/europe/switzerland-latest.osm.pbf" "$RAW"/osm/switzerland-latest.osm.pbf

echo
echo "Raw data ready in $RAW."
