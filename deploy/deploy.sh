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

build_release() { # build_release <commit> <release dir>
  local commit=$1 rel=$2
  # the engine names the commit in /api/meta
  (cd kante/engine && KANTE_COMMIT=$commit CARGO_TARGET_DIR="$ROOT/target" cargo build --release --locked -p kante-server)
  mkdir -p "$rel/data"
  cp "$ROOT/target/release/kante" "$rel/kante"
  echo "$commit" > "$rel/COMMIT"
  ln -s "$ROOT/raw" "$rel/data/raw"
  ln -s "$ROOT/secrets" "$rel/data/secrets"
  mkdir -p "$ROOT/profiles"
  ln -s "$ROOT/profiles" "$rel/data/profiles"
  # which timetable this release was built from (refresh-data.sh compares it with the one in force)
  cp "$ROOT/raw/gtfs/DATASET" "$rel/DATASET" 2>/dev/null || true
  register
  "$rel/kante" build --data "$rel/data"
}

# The building address register (the doors of most buildings): an input added after the host was set up. Without a
# valid one (fetch-data.sh's register_ok), it is fetched into a folder of its own and replaces the file there is
# only if valid. If none can be had, the build goes on, with a warning: whether an engine builds without it is the
# engine's to say.
register() {
  local reg=$ROOT/raw/register/adr.csv.zip tmp
  # a checkout whose fetch-data.sh knows no register (one from before it): nothing to do
  grep -q '^register_ok()' kante/scripts/fetch-data.sh 2>/dev/null || return 0
  # fetch-data.sh's own check; quiet, as a missing or broken file is the case this handles, not a traceback for the log
  reg_valid() {
    [[ -s $1 ]] && (unset -f register_ok; source <(sed -n '/^register_ok()/,/^}/p' kante/scripts/fetch-data.sh); declare -F register_ok >/dev/null && register_ok "$1") 2>/dev/null
  }
  reg_valid "$reg" && return 0
  tmp=$(mktemp -d "$ROOT/raw/.register.XXXXXX") || { log "warning: no valid building address register, and no room to fetch one"; return 0; }
  KANTE_RAW=$tmp timeout 1200 kante/scripts/fetch-data.sh --register || true
  if reg_valid "$tmp/register/adr.csv.zip" && mkdir -p "$ROOT/raw/register" && mv -f "$tmp/register/adr.csv.zip" "$reg"; then
    log "fetched the building address register"
  else
    log "warning: no valid building address register in $ROOT/raw/register, and none could be fetched"
  fi
  rm -rf "$tmp" || true   # never a reason to stop the build
  return 0
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
  local new seen tree cur
  new=$(git rev-parse "origin/$BRANCH")
  seen=$(cat "$ROOT/state/seen" 2>/dev/null || true)
  if (( ! force )) && [[ $new == "$seen" ]]; then exit 0; fi

  git checkout --quiet --force --detach "$new"
  sync_units
  tree=$(git rev-parse "$new:kante/engine")
  cur=$(cat "$ROOT/state/tree" 2>/dev/null || true)
  if (( ! force )) && [[ $tree == "$cur" ]]; then
    log "${new:0:7}: kante/engine is unchanged, nothing to build"
    echo "$new" > "$ROOT/state/seen"
    exit 0
  fi

  # A commit is tried once. If it fails, the next commit (or --force) tries again.
  echo "$new" > "$ROOT/state/seen"
  local rel rc prev
  rel=$ROOT/releases/$(date +%Y%m%d-%H%M%S)-${new:0:7}
  log "building ${new:0:7} into $rel"
  set +e
  ( set -e; build_release "$new" "$rel" )
  rc=$?
  set -e
  if (( rc )); then
    log "build of ${new:0:7} failed; the running engine is untouched"
    rm -rf "$rel"
    exit 1
  fi

  prev=$(readlink "$ROOT/current" 2>/dev/null || true)
  ln -sfn "$rel" "$ROOT/current"
  systemctl --user restart kante-engine.service
  if healthy; then
    echo "$tree" > "$ROOT/state/tree"
    log "${new:0:7} is live"
    live_note
    # keep this release and the one before it
    find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d | sort | head -n -2 | xargs -r rm -rf
  else
    log "${new:0:7} did not come up healthy"
    if [[ -n $prev && -d $prev ]]; then
      ln -sfn "$prev" "$ROOT/current"
      systemctl --user restart kante-engine.service
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
