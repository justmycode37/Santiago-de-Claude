#!/usr/bin/env bash
# Show what is deployed, whether the engine answers, and the public address.
ROOT=$HOME/kante-host
# shellcheck disable=SC1091
[[ -f $ROOT/config.env ]] && . "$ROOT/config.env"
PORT=${KANTE_PORT:-8080}

echo "release:  $(basename "$(readlink "$ROOT/current" 2>/dev/null)" 2>/dev/null || echo none)"
echo "watching: ${KANTE_BRANCH:-main}, last commit looked at $(cut -c1-7 "$ROOT/state/seen" 2>/dev/null || echo none)"
meta=$(curl -fsS -m 5 "http://127.0.0.1:$PORT/api/meta" 2>/dev/null)
[[ -n $meta ]] && echo "$meta" | python3 -c '
import json, sys, time
m = json.load(sys.stdin); r = m["realtime"]
live = "off"
if r.get("enabled"):
    live = "on, %s trips, updated %d s ago" % (r.get("trips"), time.time() - r["updatedAt"]) if r.get("updatedAt") else "on, waiting for the first update"
    if r.get("error"): live += " (error: %s)" % r["error"]
print("engine:   up, timetable %s to %s, %d trips" % (m["validFrom"], m["validTo"], m["counts"]["trips"]))
print("live:     " + live)' || echo "engine:   not answering on port $PORT"

if [[ -f $ROOT/cloudflared.yml ]]; then
  echo "address:  https://$(awk '/hostname:/ {print $NF; exit}' "$ROOT/cloudflared.yml")"
elif [[ -s $ROOT/secrets/tunnel-token ]]; then
  echo "address:  the hostname set for this tunnel in the Cloudflare dashboard"
else
  url=$(curl -fsS -m 3 http://127.0.0.1:20248/quicktunnel 2>/dev/null | python3 -c 'import json,sys; print("https://" + json.load(sys.stdin)["hostname"])' 2>/dev/null)
  echo "address:  ${url:-none yet} (quick tunnel: changes when the tunnel restarts)"
fi
systemctl --user --no-pager list-timers kante-deploy.timer 2>/dev/null | sed -n 2p | awk '{print "next check: " $1, $2, $3}'
