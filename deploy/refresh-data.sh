#!/usr/bin/env bash
# Keep the engine's data fresh. Run daily by kante-data.timer (early morning).
#
#   deploy/refresh-data.sh            what the timer runs
#   deploy/refresh-data.sh --now      refresh the timetable and rebuild now, whatever the day
#
# - Timetable, stop registry and map: fetched again on Mondays and Thursdays (when the national timetable
#   is updated) and whenever a new timetable year starts (second Sunday of December), then a new release
#   is built from them with deploy.sh --force. Without this the engine would keep the timetable it was
#   installed with, and stop knowing any trips when that timetable year ends.
# - The terrain model (swisstopo swissALTIRegio, 10 GB: the hills walks climb): fetched once when it is missing (a
#   download cut short goes on the next day), and a release is built with it whenever the running engine has no
#   slopes while the model is there (the first night after it was added, or after a deploy that could not read it).
# - Learned travel and dwell times (kante/engine/crates/server/src/profiles.rs): rebuilt on Mondays from
#   the last 15 days of the open "Ist-Daten" archive (about 0.7 GB a day; days already reduced are kept in
#   ~/kante-host/ist-daten, so a weekly run downloads about 7 of them). The engine picks the new files up
#   by itself within ten minutes; no restart.
set -euo pipefail

ROOT=$HOME/kante-host
log() { echo "refresh-data: $*"; }

now=0
[[ "${1:-}" == "--now" ]] && now=1
dow=$(date +%u)   # 1 = Monday … 7 = Sunday
repo=$ROOT/repo

# shellcheck disable=SC1091
[[ -f $ROOT/config.env ]] && . "$ROOT/config.env"
PORT=${KANTE_PORT:-8080}
failed=0  # a release failed this run

# --- timetable, stop registry, map
# Compared with the timetable of the release that is running, not with the last download, so a
# failed download or build is tried again the next day (and the year change is not missed).
running=$(cat "$ROOT/current/DATASET" 2>/dev/null || true)
want=$(source <(sed -n '/^timetable_year()/,/^}/p' "$repo/kante/scripts/fetch-data.sh"); echo "timetable-$(timetable_year)-gtfs2020")
if (( now )) || [[ $dow == 1 || $dow == 4 || $running != "$want" ]]; then
  log "fetching the timetable ($want, running: ${running:-unknown}) and the map"
  if KANTE_RAW=$ROOT/raw "$repo/kante/scripts/fetch-data.sh" --refresh; then
    log "building a release with the new data"
    KANTE_DEPLOY_WAIT=1 "$repo/deploy/deploy.sh" --force || { failed=1; log "the release with the new data failed; the running engine is untouched"; }
  else
    log "download failed; keeping the data there is"
  fi
fi

# --- terrain model (an optional input, so never a reason to stop, and after the timetable, which is not: without it
# walks are timed as if flat)
dem=$ROOT/raw/dem/swissaltiregio.tif
sloped() { curl -fsS -m 5 "http://127.0.0.1:$PORT/api/meta" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["counts"].get("slopedEdges", 0))' 2>/dev/null || echo unknown; }
if grep -q -- '--elevation' "$repo/kante/scripts/fetch-data.sh" 2>/dev/null; then
  # one the build could not read was removed: fetched again after a week (the marker's time), not every night
  if [[ ! -s $dem ]] && ! [[ -n $(find "$dem.rejected" -mtime -7 2>/dev/null) ]]; then
    rm -f "$dem.rejected"
    log "fetching the terrain model (10 GB)"
    # curl's own deadline (the script cleans up after it); `timeout` only as a backstop
    KANTE_RAW=$ROOT/raw KANTE_DEM_MAX_TIME=5400 timeout 5700 "$repo/kante/scripts/fetch-data.sh" --elevation || log "terrain model download failed; trying again tomorrow"
  fi
  # the model is there and the running engine has no slopes: a release with it, unless a release failed tonight (a
  # release that failed is not tried again right after)
  if [[ -s $dem && $(sloped) == 0 ]] && (( ! failed )); then
    log "the running engine has no slopes: building a release with the terrain model"
    if KANTE_DEPLOY_WAIT=1 "$repo/deploy/deploy.sh" --force; then
      # running, and still no slopes: the build could not read it (`kante build` says why in the deploy log).
      # Removed (10 GB), so that it is not built with again every night, and a marker left so that it is fetched
      # again in a week, not tomorrow
      if [[ -s $dem && $(sloped) == 0 ]]; then
        log "the engine built with the terrain model has no slopes: removing $dem, fetching it again in a week"
        rm -f "$dem" && touch "$dem.rejected" || true
      fi
    else
      log "the release with the terrain model failed; the running engine is untouched"
    fi
  fi
fi

# --- learned travel and dwell times
if (( now )) || [[ $dow == 1 ]] || [[ ! -s $ROOT/profiles/hop.csv.gz ]]; then
  log "rebuilding the travel-time profiles"
  mkdir -p "$ROOT/profiles" "$ROOT/ist-daten"
  out=$ROOT/ist-daten/out
  # days older than the window are no longer needed (about 50 MB each, reduced)
  find "$ROOT/ist-daten" -maxdepth 1 -type f -name '20*' -mtime +30 -delete 2>/dev/null || true
  rm -rf "$ROOT/ist-daten/raw"
  if python3 -I "$repo/livemap/measure/ist_daten_hops.py" --days 15 --cache "$ROOT/ist-daten" --out "$out" --write-profile; then
    for k in hop dwell; do
      cp "$out/profile_${k}_paironly.csv.gz" "$ROOT/profiles/$k.csv.gz.part"
      mv "$ROOT/profiles/$k.csv.gz.part" "$ROOT/profiles/$k.csv.gz"
    done
    log "profiles updated"
  else
    log "profile build failed; keeping the ones there are"
  fi
fi
