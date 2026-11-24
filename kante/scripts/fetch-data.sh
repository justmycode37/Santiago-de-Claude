#!/usr/bin/env bash
# Download the raw inputs into data/raw (or into $KANTE_RAW). Safe to re-run:
# existing files are kept unless you pass --refresh.
#
#   scripts/fetch-data.sh [--refresh]
#   scripts/fetch-data.sh --register   only the building address register, if it is not there yet
#   scripts/fetch-data.sh --elevation  only the terrain model (10 GB), if it is not there yet
#
# Sources (all open, no key needed):
#   - National GTFS timetable   opentransportdata.swiss (updated Mon + Thu; the
#                               timetable year in force today, see timetable_year)
#   - atlas boarding points      opentransportdata.swiss (daily)
#   - OpenStreetMap Switzerland  download.geofabrik.de   (daily)
#   - Building address register  data.geo.admin.ch (swisstopo, weekly; optional: the doors of
#                                buildings OpenStreetMap maps without one)
#   - Terrain model              data.geo.admin.ch (swisstopo swissALTIRegio, 10 m, yearly; optional,
#                                --elevation only: the hills walks climb. Without it walks are timed as
#                                if flat. Never fetched again once there, not even with --refresh)
set -euo pipefail
cd "$(dirname "$0")/.."

refresh=0
[[ "${1:-}" == "--refresh" ]] && refresh=1
only_register=0
[[ "${1:-}" == "--register" ]] && only_register=1
only_elevation=0
[[ "${1:-}" == "--elevation" ]] && only_elevation=1

OTD=https://data.opentransportdata.swiss
RAW=${KANTE_RAW:-data/raw}
UA="kante-prototype/0.1"

fetch() { # fetch <url> <dest> [check [max seconds]]: check is a command run on the downloaded file before it replaces <dest>
  local url=$1 dest=$2 check=${3:-} max=${4:-}
  if [[ -s "$dest" && $refresh -eq 0 ]]; then
    echo "have  $dest"
    return
  fi
  mkdir -p "$(dirname "$dest")"
  echo "fetch $dest"
  # -L: the timetable permalink redirects to a signed storage URL.
  # Explicit returns: this runs inside `if`, where `set -e` does not stop a failed command.
  # max seconds (the register only, which is not worth holding up a build or the timetable for): each try, and the retries together.
  if ! curl -fSL --retry 3 ${max:+--max-time "$max" --retry-max-time "$max"} -A "$UA" -o "$dest.part" "$url"; then
    rm -f "$dest.part"
    return 1
  fi
  if [[ $dest == *.zip ]] && ! python3 -I -c 'import sys, zipfile; sys.exit(0 if zipfile.ZipFile(sys.argv[1]).testzip() is None else 1)' "$dest.part" 2>/dev/null; then
    echo "error: $url gave a broken zip" >&2
    rm -f "$dest.part"
    return 1
  fi
  if [[ -n $check ]] && ! $check "$dest.part"; then
    echo "error: $url is not what the engine reads; keeping the file there is" >&2
    rm -f "$dest.part"
    return 1
  fi
  mv "$dest.part" "$dest"
}

# The official building address register (~140 MB): an entrance point per building address. Optional: without it
# the engine knows OpenStreetMap's doors only; a failed download keeps the file there is.
REGISTER_URL=https://data.geo.admin.ch/ch.swisstopo.amtliches-gebaeudeadressverzeichnis/amtliches-gebaeudeadressverzeichnis_ch/amtliches-gebaeudeadressverzeichnis_ch_2056.csv.zip
# The register's CSV must have the columns kante-link/src/register.rs reads, or the build would quietly fall back
# to OpenStreetMap's doors.
register_ok() { # the right columns, and over a million real addresses with coordinates in Switzerland
  python3 -I -c '
import io, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = [n for n in z.namelist() if n.endswith(".csv")]
if not names: sys.exit(1)
f = io.TextIOWrapper(z.open(names[0]), encoding="utf-8-sig")
head = f.readline().rstrip("\r\n").split(";")
need = ["ADR_STATUS", "ADR_NUMBER", "ADR_EASTING", "ADR_NORTHING", "STN_LABEL"]
if not set(need) <= set(head): sys.exit(1)
st, nb, e, n = (head.index(c) for c in need[:4])
ok = 0
for line in f:
    r = line.rstrip("\r\n").split(";")
    if len(r) != len(head) or r[st] != "real" or not r[nb]: continue
    try: x, y = float(r[e]), float(r[n])
    except ValueError: continue
    if 2480000 <= x <= 2840000 and 1070000 <= y <= 1300000:
        ok += 1
        if ok >= 1000000: sys.exit(0)
sys.exit(1)' "$1"
}
register() {
  if ! fetch "$REGISTER_URL" "$RAW"/register/adr.csv.zip register_ok 1200; then
    if [[ -s "$RAW"/register/adr.csv.zip ]]; then echo "keep  $RAW/register/adr.csv.zip (could not fetch a new one)"
    else echo "warning: no building address register; the engine will have OpenStreetMap's doors only" >&2; fi
  fi
  return 0
}
if (( only_register )); then
  register
  exit 0
fi

# swisstopo's terrain model, swissALTIRegio (10 m, a cloud-optimised GeoTIFF of 10 GB): what kante build's
# `elevation` step reads. Downloaded once; a download cut short is resumed, but only from the same edition (its
# ETag), and the file is used only when it has the size the server gives.
DEM_URL=https://data.geo.admin.ch/ch.swisstopo.swissaltiregio/swissaltiregio/swissaltiregio_2056_5728.tif
dem_ok() { # a little-endian BigTIFF of at least 5 GB
  [[ -s $1 ]] && [[ $(head -c 4 "$1" | od -An -tx1 | tr -d ' \n') == 49492b00 ]] && (( $(stat -c %s "$1") > 5000000000 ))
}
if (( only_elevation )); then
  dest=$RAW/dem/swissaltiregio.tif
  if dem_ok "$dest"; then
    echo "have  $dest"
    exit 0
  fi
  mkdir -p "$RAW/dem"
  head=$(curl -fsSIL --retry 3 -A "$UA" "$DEM_URL") || { echo "error: $DEM_URL does not answer" >&2; exit 1; }
  # the headers of the last answer only (a redirect's come first)
  head=$(awk '/^HTTP\//{b=""} {b=b $0 "\n"} END{printf "%s", b}' <<<"$head")
  size=$(grep -i '^content-length:' <<<"$head" | tail -n 1 | tr -dc '0-9' || true)
  etag=$(grep -i '^etag:' <<<"$head" | tail -n 1 | cut -d: -f2- | tr -d ' \r' || true)
  [[ $etag == W/* ]] && etag=''   # a weak one cannot vouch for the bytes of a range: no resuming
  if [[ -z $size ]] || (( size <= 0 )); then
    echo "error: $DEM_URL gives no size: not fetching 10 GB that cannot be checked" >&2
    exit 1
  fi
  # a part of another edition (or of one without an ETag), or longer than the file, is not resumed; one that is all
  # there needs no more (resuming it would be refused, 416, every time)
  have=$(stat -c %s "$dest.part" 2>/dev/null || echo 0)
  if [[ -e $dest.part ]] && { [[ -z $etag ]] || [[ "$(cat "$dest.part.etag" 2>/dev/null)" != "$etag" ]] || (( have > size )); }; then
    rm -f "$dest.part"
    have=0
  fi
  echo "$etag" > "$dest.part.etag"
  # room for the rest of it, and beside it for what the timetable, the map and a release need (KANTE_DEM_RESERVE
  # bytes, 20 GB unless said): an optional input never fills the disk the engine needs
  reserve=${KANTE_DEM_RESERVE:-20000000000}
  avail=$(df --output=avail -B1 "$RAW/dem" 2>/dev/null | tail -n 1 | tr -dc '0-9' || true)
  if (( have < size )) && [[ -z $avail ]]; then
    echo "error: cannot tell how much room there is in $RAW/dem: not fetching 10 GB" >&2
    [[ -e $dest.part ]] || rm -f "$dest.part.etag"
    exit 1
  fi
  if (( have < size )) && (( avail < size - have + reserve )); then
    echo "error: $(( (size - have) / 1000000000 )) GB more for the terrain model and $(( reserve / 1000000000 )) GB beside it do not fit in the $(( avail / 1000000000 )) GB free: not fetching it" >&2
    [[ -e $dest.part ]] || rm -f "$dest.part.etag"
    exit 1
  fi
  if (( have < size )); then
    echo "fetch $dest (10 GB)"
    # resumed only from an edition its ETag vouches for: the server refuses the range (412) when the file is another
    # one. One answer, never more than what is missing (curl 8.4 and later stop at it, 63), so what it writes stays
    # within the room checked above and the reserve; no retries inside curl (each would be allowed as much again):
    # the next night goes on. Within KANTE_DEM_MAX_TIME seconds (curl 28), so that a deadline still cleans up.
    rc=0
    code=$(curl -fSL ${etag:+-C -} --max-filesize "$(( size - have ))" ${KANTE_DEM_MAX_TIME:+--max-time "$KANTE_DEM_MAX_TIME"} -A "$UA" ${etag:+-H "If-Match: $etag"} -w '%{http_code}' -o "$dest.part" "$DEM_URL") || rc=$?
    if (( rc )); then
      # another edition (412), a range that cannot be resumed (416), a server that ignores ranges (curl 33), more than
      # the file (63), or no ETag to resume by: start again next time; the disk full (curl 23): the part removed, so
      # that it does not keep the space
      if [[ -z $etag || $code == 412 || $code == 416 ]] || (( rc == 33 || rc == 23 || rc == 63 )); then rm -f "$dest.part" "$dest.part.etag"; fi
      exit 1
    fi
  fi
  got=$(stat -c %s "$dest.part" 2>/dev/null || echo 0)
  if [[ $got != "$size" ]] || ! dem_ok "$dest.part"; then
    echo "error: $DEM_URL gave $got bytes of $size, not the terrain model the engine reads" >&2
    rm -f "$dest.part" "$dest.part.etag"
    exit 1
  fi
  mv "$dest.part" "$dest"
  rm -f "$dest.part.etag"
  exit 0
fi

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
# The timetable is downloaded next to the one in use and only replaces it once it is complete, so a
# build that runs meanwhile never finds it missing. A new timetable year is fetched even without --refresh.
have=$(cat "$RAW"/gtfs/DATASET 2>/dev/null || true)
if [[ $have != "$dataset" || $refresh -eq 1 || ! -s "$RAW"/gtfs/gtfs.zip ]]; then
  [[ $have != "$dataset" ]] && echo "timetable: ${have:-none} -> $dataset"
  rm -f "$RAW"/gtfs/gtfs.next.zip
  if fetch "$OTD/en/dataset/$dataset/permalink" "$RAW"/gtfs/gtfs.next.zip; then
    mv "$RAW"/gtfs/gtfs.next.zip "$RAW"/gtfs/gtfs.zip
    echo "$dataset" > "$RAW"/gtfs/DATASET
  elif [[ -s "$RAW"/gtfs/gtfs.zip ]]; then
    # Not published yet, or a hiccup: keep the timetable there is (DATASET still names it).
    echo "warning: could not fetch $dataset; keeping ${have:-the timetable there is}" >&2
  else
    exit 1
  fi
else
  echo "have  $RAW/gtfs/gtfs.zip ($dataset)"
fi

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
  if [[ -z "$url" ]] || ! fetch "$url" "$3"; then
    if [[ -s "$3" ]]; then echo "keep  $3 (could not fetch $2)"; return 0; fi
    echo "error: could not fetch $2 from $OTD/dataset/$1" >&2
    return 1
  fi
}
atlas b06d90be-91c6-440e-ab97-09f579d2fad0 actual-date-world-traffic-point.csv "$RAW"/atlas/traffic-point.csv
atlas 52c157d0-e6bc-406b-8e7d-63713aa28585 actual-date-sectors-and-sector-groups.csv "$RAW"/atlas/sectors.csv
atlas 8e5931a6-b4aa-456a-9be4-498f28168861 actual-date-platform.csv "$RAW"/atlas/prm-platform.csv

# A map download that fails keeps the map there is: a Geofabrik hiccup must not hold up a new timetable.
if ! fetch "https://download.geofabrik.de/europe/switzerland-latest.osm.pbf" "$RAW"/osm/switzerland-latest.osm.pbf; then
  [[ -s "$RAW"/osm/switzerland-latest.osm.pbf ]] || exit 1
  echo "keep  $RAW/osm/switzerland-latest.osm.pbf (could not fetch a new one)"
fi

register

echo
echo "Raw data ready in $RAW."
