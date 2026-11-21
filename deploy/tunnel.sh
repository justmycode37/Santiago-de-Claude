#!/usr/bin/env bash
# Run the Cloudflare tunnel in front of the engine. Three ways, first match wins:
#   ~/kante-host/cloudflared.yml       a named tunnel set up with `cloudflared tunnel login` (fixed address)
#   ~/kante-host/secrets/tunnel-token  a tunnel made in the Cloudflare dashboard (fixed address)
#   neither                            a quick tunnel: no account needed, but the address changes at every start
set -euo pipefail
ROOT=$HOME/kante-host
# shellcheck disable=SC1091
[[ -f $ROOT/config.env ]] && . "$ROOT/config.env"
PORT=${KANTE_PORT:-8080}
CF=$ROOT/bin/cloudflared

if [[ -f $ROOT/cloudflared.yml ]]; then
  exec "$CF" tunnel --no-autoupdate --config "$ROOT/cloudflared.yml" run
elif [[ -s $ROOT/secrets/tunnel-token ]]; then
  exec "$CF" tunnel --no-autoupdate run --token-file "$ROOT/secrets/tunnel-token"
else
  # status.sh reads the address from the metrics port
  exec "$CF" tunnel --no-autoupdate --metrics 127.0.0.1:20248 --url "http://127.0.0.1:$PORT"
fi
