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
  (cd kante/engine && CARGO_TARGET_DIR="$ROOT/target" cargo build --release --locked -p kante-server)
  mkdir -p "$rel/data"
  cp "$ROOT/target/release/kante" "$rel/kante"
  cp -r kante/engine/playground "$rel/playground"
  echo "$commit" > "$rel/COMMIT"
  ln -s "$ROOT/raw" "$rel/data/raw"
  ln -s "$ROOT/secrets" "$rel/data/secrets"
  "$rel/kante" build --data "$rel/data"
}

healthy() { # the engine answers and has a timetable and a search index
  local i
  for i in $(seq 1 90); do
    if curl -fsS -m 5 "http://127.0.0.1:$PORT/api/meta" 2>/dev/null \
        | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin)["counts"]["trips"] > 0 else 1)' 2>/dev/null \
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
  flock -n 9 || { log "another deploy is running"; exit 0; }

  cd "$ROOT/repo"
  git fetch --quiet origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
  local new seen tree cur
  new=$(git rev-parse "origin/$BRANCH")
  seen=$(cat "$ROOT/state/seen" 2>/dev/null || true)
  if (( ! force )) && [[ $new == "$seen" ]]; then exit 0; fi

  git checkout --quiet --force --detach "$new"
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
