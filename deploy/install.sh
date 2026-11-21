#!/usr/bin/env bash
# One-time setup on the host. Run it as the user that will own the service; a user made only for
# this is best, because the watcher builds and runs whatever is on main. Safe to run again.
#
#   KANTE_BRANCH=main deploy/install.sh
#
# Needs: git, curl, cc, python3, flock, and Rust (https://rustup.rs).
set -euo pipefail
ROOT=$HOME/kante-host
REPO_URL=${KANTE_REPO:-https://github.com/justmycode37/Santiago-de-Claude}
BRANCH=${KANTE_BRANCH:-main}
export PATH="$HOME/.cargo/bin:$PATH"

for c in git curl cc python3 flock cargo; do
  command -v "$c" >/dev/null || { echo "missing: $c"; exit 1; }
done

mkdir -p "$ROOT"/{raw,secrets,releases,state,bin}
chmod 700 "$ROOT/secrets"
[[ $BRANCH == main ]] || echo "KANTE_BRANCH=$BRANCH" > "$ROOT/config.env"
[[ -d $ROOT/repo/.git ]] || git clone --quiet --branch "$BRANCH" "$REPO_URL" "$ROOT/repo"

if [[ ! -x $ROOT/bin/cloudflared ]]; then
  curl -fsSL -o "$ROOT/bin/cloudflared.part" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x "$ROOT/bin/cloudflared.part"
  mv "$ROOT/bin/cloudflared.part" "$ROOT/bin/cloudflared"
fi

KANTE_RAW=$ROOT/raw "$ROOT/repo/kante/scripts/fetch-data.sh"
[[ -s $ROOT/secrets/otd.json ]] || echo "note: no $ROOT/secrets/otd.json, so the engine will run without live data"

mkdir -p "$HOME/.config/systemd/user"
cp "$ROOT/repo/deploy/units/"* "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable kante-engine.service kante-tunnel.service kante-deploy.timer

"$ROOT/repo/deploy/deploy.sh" --force   # first release: a few minutes
systemctl --user start kante-tunnel.service kante-deploy.timer
loginctl enable-linger "$USER" 2>/dev/null || echo "to start at boot, run: sudo loginctl enable-linger $USER"
"$ROOT/repo/deploy/status.sh"
