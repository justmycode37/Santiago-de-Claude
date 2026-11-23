#!/usr/bin/env bash
# Build the engine from origin/main and switch to it, if it has changed.
#
#   deploy/deploy.sh           what the timer runs: does nothing unless main moved and kante/engine changed
#   deploy/deploy.sh --force   build and switch even if nothing changed
#
# Each release has its own folder with the binary and the data caches that binary built, so a bad
# release cannot damage the running one, and going back is one symlink.
set -euo pipefail

ROOT=$HOME/kante-host
log() { echo "deploy: $*"; }
# This script as it was when it started: after checking out a commit that changes it, it starts again as the new one
# (bash would otherwise go on with the old one, which it has read already).
SELF=$(cat "${BASH_SOURCE[0]}")

build_release() { # build_release <commit> <release dir>
  local commit=$1 rel=$2
  (cd kante/engine && CARGO_TARGET_DIR="$ROOT/target" cargo build --release --locked -p kante-server)
  mkdir -p "$rel/data"
  cp "$ROOT/target/release/kante" "$rel/kante"
  echo "$commit" > "$rel/COMMIT"
  ln -s "$ROOT/raw" "$rel/data/raw"
  ln -s "$ROOT/secrets" "$rel/data/secrets"
  mkdir -p "$ROOT/profiles"
  ln -s "$ROOT/profiles" "$rel/data/profiles"
  # which timetable this release was built from (refresh-data.sh compares it with the one in force)
  cp "$ROOT/raw/gtfs/DATASET" "$rel/DATASET" 2>/dev/null || true
  # an input added after the host was set up (the building address register): fetched if missing; the build works
  # without it, and the release says whether it had it (see register_catch_up)
  [[ -s $ROOT/raw/register/adr.csv.zip ]] || KANTE_RAW=$ROOT/raw timeout 1200 kante/scripts/fetch-data.sh --register || true
  local with_register=0
  [[ -s $ROOT/raw/register/adr.csv.zip ]] && with_register=1
  "$rel/kante" build --data "$rel/data"
  (( with_register )) && touch "$rel/REGISTER"
  return 0
}

# The release in use was built without the building address register (by a deploy.sh from before it, or when the
# download failed): fetch it, and if that works build again (force=1), even though the commit is not new. Once per
# release, so a register that cannot be had does not rebuild every few minutes: the attempt counts once the fetch
# failed or the build with it has finished (one that was killed, say for memory, is tried again).
register_catch_up() {
  local cur tried=$ROOT/state/register-tried
  cur=$(readlink "$ROOT/current" 2>/dev/null) || return 0
  [[ -e $cur/REGISTER || $(cat "$tried" 2>/dev/null) == "$cur" ]] && return 0
  log "the engine in use was built without the building address register"
  [[ -s $ROOT/raw/register/adr.csv.zip ]] || KANTE_RAW=$ROOT/raw timeout 1200 kante/scripts/fetch-data.sh --register || true
  if [[ -s $ROOT/raw/register/adr.csv.zip ]]; then
    log "building again with the building address register"
    force=1
    catch_up_for=$cur
  else
    echo "$cur" > "$tried"
    log "warning: could not fetch the building address register; doors from OpenStreetMap only"
  fi
}

# A build needs about 6 GB of memory next to the running engine (KANTE_BUILD_MEM_MB): with less free, it is not
# started (the commit is tried again by the next run), so the kernel does not have to pick a process to kill.
enough_memory() {
  local need=${KANTE_BUILD_MEM_MB:-6000} free
  free=$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null || echo 0)
  if (( free < need )); then
    log "only ${free} MB of memory free, a build needs about ${need} MB: not building now (KANTE_BUILD_MEM_MB)"
    return 1
  fi
}

healthy() { # the engine answers, has a timetable that is valid today, and a search index
  local i
  for i in $(seq 1 90); do
    if curl -fsS -m 5 "http://127.0.0.1:$PORT/api/meta" 2>/dev/null \
        | python3 -c 'import datetime,json,sys; m=json.load(sys.stdin); sys.exit(0 if m["counts"]["trips"] > 0 and m["validTo"] >= datetime.date.today().isoformat() else 1)' 2>/dev/null \
      && curl -fsS -m 10 "http://127.0.0.1:$PORT/api/search?q=Bern" 2>/dev/null \
        | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin)["results"] else 1)' 2>/dev/null; then
      return 0
    fi
    # it keeps dying at start: no point in waiting
    if (( $(systemctl --user show kante-engine.service -p NRestarts --value) > 2 )); then return 1; fi
    sleep 2
  done
  return 1
}

sync_units() { # new or changed systemd units from the repository (e.g. a new timer) take effect without a reinstall
  local d=$HOME/.config/systemd/user f changed=0
  mkdir -p "$d"
  [[ -d deploy/units ]] || return 0
  for f in deploy/units/*; do
    cmp -s "$f" "$d/$(basename "$f")" || { cp "$f" "$d/"; changed=1; }
  done
  if (( changed )); then
    systemctl --user daemon-reload
    log "updated the systemd units"
  fi
  # also when an earlier attempt failed
  if ! systemctl --user is-active --quiet kante-data.timer 2>/dev/null; then
    systemctl --user enable --now kante-data.timer >/dev/null 2>&1 && log "started kante-data.timer"
  fi
  return 0
}

doors_note() { # buildings' doors: about 2.9 million, 2.7 million of them from the address register (/api/meta)
  local d r
  read -r d r < <(curl -fsS -m 5 "http://127.0.0.1:$PORT/api/meta" 2>/dev/null \
    | python3 -c 'import json,sys; c=json.load(sys.stdin)["counts"]; print(c.get("doors", 0), c.get("registerDoors", 0))' 2>/dev/null || echo 0 0)
  if (( ${r:-0} < 1000000 )); then
    log "warning: ${d:-0} doors, only ${r:-0} from the building address register (is $ROOT/raw/register/adr.csv.zip missing?)"
  else
    log "${d} doors, ${r} from the building address register"
  fi
}

live_note() { # not a reason to go back (the key may be missing or the feed down), but worth a line in the log
  local i
  [[ -s $ROOT/secrets/otd.json ]] || return 0
  for i in $(seq 1 18); do
    if curl -fsS -m 5 "http://127.0.0.1:$PORT/api/meta" 2>/dev/null         | python3 -c 'import json,sys; sys.exit(0 if (json.load(sys.stdin)["realtime"].get("trips") or 0) > 0 else 1)' 2>/dev/null; then
      log "live data is coming in"
      return 0
    fi
    sleep 10
  done
  log "warning: no live data three minutes after the start (see /api/meta realtime.feeds)"
}

main() {
  local force=0
  [[ "${1:-}" == "--force" ]] && force=1
  # shellcheck disable=SC1091
  [[ -f $ROOT/config.env ]] && . "$ROOT/config.env"
  BRANCH=${KANTE_BRANCH:-main}
  PORT=${KANTE_PORT:-8080}
  export PATH="$HOME/.cargo/bin:$PATH"
  mkdir -p "$ROOT/state" "$ROOT/releases"
  exec 9>"$ROOT/state/lock"
  if [[ -n ${KANTE_DEPLOY_WAIT:-} ]]; then
    flock 9   # refresh-data.sh waits its turn instead of giving up
  else
    flock -n 9 || { log "another deploy is running"; exit 0; }
  fi

  cd "$ROOT/repo"
  # Also on the fast path: a host whose release came from an older deploy.sh catches up here.
  sync_units
  [[ -d $ROOT/current/data && ! -e $ROOT/current/data/profiles ]] && mkdir -p "$ROOT/profiles" && ln -s "$ROOT/profiles" "$ROOT/current/data/profiles"
  git fetch --quiet origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
  local new seen tree cur catch_up_for=""
  new=$(git rev-parse "origin/$BRANCH")
  seen=$(cat "$ROOT/state/seen" 2>/dev/null || true)
  # (this script as checked out by the last deploy: a newer one than the deploy that built the release in use)
  register_catch_up
  if (( ! force )) && [[ $new == "$seen" ]]; then exit 0; fi

  git checkout --quiet --force --detach "$new"
  if [[ -z ${KANTE_DEPLOY_REEXEC:-} && "$(cat deploy/deploy.sh)" != "$SELF" ]]; then
    log "deploy.sh changed in ${new:0:7}: starting it again"
    exec 9>&- # the lock: the new one takes it again
    exec env KANTE_DEPLOY_REEXEC=1 KANTE_DEPLOY_WAIT=1 bash deploy/deploy.sh "$@"
  fi
  sync_units
  tree=$(git rev-parse "$new:kante/engine")
  cur=$(cat "$ROOT/state/tree" 2>/dev/null || true)
  if (( ! force )) && [[ $tree == "$cur" ]]; then
    log "${new:0:7}: kante/engine is unchanged, nothing to build"
    echo "$new" > "$ROOT/state/seen"
    exit 0
  fi

  enough_memory || exit 0
  # A commit is tried once: a build that fails is not tried again until the next commit (or --force). One that was
  # killed (a signal: out of memory, a reboot) is tried again, up to three times.
  local rel rc prev tries
  tries=$(( $(cat "$ROOT/state/tries-$new" 2>/dev/null || echo 0) + 1 ))
  echo "$tries" > "$ROOT/state/tries-$new"
  rel=$ROOT/releases/$(date +%Y%m%d-%H%M%S)-${new:0:7}
  # never the folder of a release there is (the one in use, built the same second)
  local n=2 base=$rel
  while [[ -e $rel ]]; do rel=$base-$n; n=$((n + 1)); done
  log "building ${new:0:7} into $rel"
  set +e
  ( set -e; build_release "$new" "$rel" )
  rc=$?
  set -e
  if (( rc >= 128 && tries < 3 )); then
    log "build of ${new:0:7} was killed (signal $(( rc - 128 ))); the running engine is untouched; trying again next time ($tries of 3)"
    rm -rf "$rel"
    exit 1
  fi
  echo "$new" > "$ROOT/state/seen"
  rm -f "$ROOT/state/tries-$new"
  [[ -n $catch_up_for ]] && echo "$catch_up_for" > "$ROOT/state/register-tried"
  if (( rc )); then
    log "build of ${new:0:7} failed; the running engine is untouched"
    rm -rf "$rel"
    exit 1
  fi

  prev=$(readlink "$ROOT/current" 2>/dev/null || true)
  ln -sfn "$rel" "$ROOT/current"
  # a restart that fails is found by the health check, which goes back to the release before
  systemctl --user restart kante-engine.service || log "restarting the engine failed"
  if healthy; then
    echo "$tree" > "$ROOT/state/tree"
    log "${new:0:7} is live"
    doors_note
    live_note
    # keep this release and the one before it
    find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d | sort | head -n -2 | xargs -r rm -rf
  else
    log "${new:0:7} did not come up healthy"
    if [[ -n $prev && -d $prev ]]; then
      ln -sfn "$prev" "$ROOT/current"
      systemctl --user restart kante-engine.service || log "restarting the engine failed"
      if healthy; then
        log "went back to $(basename "$prev")"
      else
        log "went back to $(basename "$prev"), but it does not answer either"
      fi
    fi
    rm -rf "$rel"
    exit 1
  fi
}

# The checkout above can replace this file while it runs, so bash must have read all of it first.
main "$@"; exit
