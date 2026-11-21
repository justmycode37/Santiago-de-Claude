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

# --- timetable, stop registry, map
# Compared with the timetable of the release that is running, not with the last download, so a
# failed download or build is tried again the next day (and the year change is not missed).
running=$(cat "$ROOT/current/DATASET" 2>/dev/null || true)
want=$(source <(sed -n '/^timetable_year()/,/^}/p' "$repo/kante/scripts/fetch-data.sh"); echo "timetable-$(timetable_year)-gtfs2020")
if (( now )) || [[ $dow == 1 || $dow == 4 || $running != "$want" ]]; then
  log "fetching the timetable ($want, running: ${running:-unknown}) and the map"
  if KANTE_RAW=$ROOT/raw "$repo/kante/scripts/fetch-data.sh" --refresh; then
    log "building a release with the new data"
    KANTE_DEPLOY_WAIT=1 "$repo/deploy/deploy.sh" --force || log "the release with the new data failed; the running engine is untouched"
  else
    log "download failed; keeping the data there is"
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
