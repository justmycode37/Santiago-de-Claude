#!/usr/bin/env bash
# Downloads the raw open-data files the build scripts need into data/raw/.
# ~165 MB in total (the timetable-frequency zip is ~90 MB). Not committed (.gitignore).
# Usage: bash tools/fetch-raw.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/raw && cd data/raw

# opentransportdata.swiss returns 403 without a browser-like User-Agent.
UA="Mozilla/5.0"
CKAN="https://ckan.opendata.swiss/api/3/action/package_show?id="

# The "actual date" resource IDs change when the data is republished, so look the
# current download URL up in the opendata.swiss catalogue instead of hardcoding it.
# get <out-file> <package> <url-suffix>
get() {
  local url
  url=$(curl -fsSL -A "$UA" "$CKAN$2" | node -e '
    let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
      const r = JSON.parse(s).result.resources.map((x) => x.download_url || x.url).find((u) => u.endsWith(process.argv[1]));
      if (!r) process.exit(1); console.log(r);
    });' "$3")
  curl -fsSL -A "$UA" -o "$1" "$url" && echo "ok  $1"
}

get traffic-point.csv          traffic-point-v2            actual-date-world-traffic-point.csv
get service-point.csv          service-point-v2            actual-date-swiss-service-point.csv
get actual-date-platform.csv   platform-v2                 actual-date-platform.csv
get actual-date-stop-point.csv stop-point-v2               actual-date-stop-point.csv
get actual-date-toilet.csv     toilet-v2                   actual-date-toilet.csv
get bfr_haltestellendaten.csv  bfr-rollstuhlzuganglichkeit bfr_haltestellendaten.csv
get bfr_kombinationslogik.csv  bfr-rollstuhlzuganglichkeit bfr_kombinationslogik.csv
get haltestellen_2026.zip      halte-an-haltestellen       haltestellen_2026.zip

# OSM platforms with a SLOID in greater Bern. The public Overpass server is
# often overloaded (502); retry a few times, then fall back to the Swiss instance.
Q='[out:json][timeout:90];nwr["public_transport"="platform"]["ref:sloid"](46.90,7.34,46.99,7.50);out tags center;'
for i in 1 2 3 4 5; do
  [ "$i" -le 3 ] && api=https://overpass-api.de/api/interpreter || api=https://overpass.osm.ch/api/interpreter
  code=$(curl -s -m 150 -A "SantiagoDeClaude/0.1" --data-urlencode "data=$Q" \
    "$api" -o osm-bern-platforms.json -w "%{http_code}") || true
  [ "$code" = 200 ] && echo "ok  osm-bern-platforms.json" && break
  echo "overpass $code, retry $i"; sleep $((i * 10))
done
