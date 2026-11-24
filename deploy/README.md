# Hosting the Kante engine

Scripts that run the engine in `kante/` on a Linux machine, put it on the internet through a Cloudflare
tunnel, and redeploy it when `main` changes. Everything runs as systemd user services of one user and
lives in `~/kante-host`.

| Service | What it does |
|---|---|
| `kante-engine.service` | The engine, on `127.0.0.1:8080` only |
| `kante-tunnel.service` | `cloudflared`, which gives the engine a public HTTPS address without opening a port |
| `kante-deploy.timer` | Every two minutes, runs `deploy.sh` |
| `kante-data.timer` | Daily at 02:30 Swiss time, runs `refresh-data.sh`: new timetable (Mondays, Thursdays and when a timetable year starts), learned travel times (Mondays), the terrain model (once, and a release with it when the running one has no slopes; one the build cannot read is removed and fetched again after a week) |

## The running instance

The engine is at **https://kante.omniroute.app** (try `/api/meta`). It runs behind the
Cloudflare tunnel `kante-lapdell1`, made the dashboard way: the hostname is set in Cloudflare and the host
only holds the tunnel's token. Cloudflare turns away some non-browser clients on this address, among them
Python's default `urllib` (HTTP 403); browsers, `curl` and Node are fine.

## Setting up a machine

Use a user made only for this. The watcher builds and runs whatever is on `main`, so anyone who can push
to `main` can run code as that user.

```sh
sudo useradd --system --create-home --home-dir /var/lib/kante --shell /bin/bash kante
sudo loginctl enable-linger kante          # its services start at boot
sudo -iu kante
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
export XDG_RUNTIME_DIR=/run/user/$(id -u)  # needed for `systemctl --user` after `sudo -iu`
git clone https://github.com/justmycode37/Santiago-de-Claude ~/kante-host/repo
~/kante-host/repo/deploy/install.sh
```

`install.sh` downloads `cloudflared` and the data (about 900 MB), builds the first release and starts the
services. `kante-data` adds swisstopo's terrain model the first night (10 GB, once; a download cut short goes on the
next night) and builds a release with it; until then walks are timed as if flat. For live data, put the opentransportdata.swiss key in `~/kante-host/secrets/otd.json` as
`{"siri-et": "…"}` (mode 600) before running it, or add it later and restart `kante-engine`.

## What a deploy does

`deploy.sh` fetches `main`. If `kante/engine` has not changed it does nothing. Otherwise it:

1. builds the engine (told its commit, which `/api/meta` then names),
2. builds the data caches with the new engine, in a new folder under `~/kante-host/releases/` (the building
   address register, the doors of most buildings, is fetched first if the host has no valid one; without one it
   warns and goes on),
3. points `~/kante-host/current` at the new folder and restarts the engine,
4. checks that the engine answers, has a timetable and can search. If not, it goes back to the release
   before.

A commit is tried once. If its build fails, the running engine stays as it is and the next commit is
tried. The deploy and data services run with `OOMScoreAdjust=900`, so when memory runs out the kernel kills a
build, not the engine. The two newest releases are kept. A deploy takes about 2 minutes on a
12-core machine, and the engine is down for a few seconds at the restart.

## The public address

`tunnel.sh` picks one of three ways:

| If this exists | Tunnel | Address |
|---|---|---|
| `~/kante-host/cloudflared.yml` | named tunnel, set up with `cloudflared tunnel login` | fixed, on your own domain |
| `~/kante-host/secrets/tunnel-token` | tunnel made in the Cloudflare dashboard or with its API | fixed, on your own domain |
| neither | quick tunnel, no Cloudflare account | `https://….trycloudflare.com`, new at every start |

A fixed address needs a domain on a Cloudflare account. For the token way, make a tunnel under Zero Trust ›
Networks › Tunnels, add a public hostname that points to `http://127.0.0.1:8080`, and save the token it
shows to `~/kante-host/secrets/tunnel-token` (mode 600). For the other way:

```sh
~/kante-host/bin/cloudflared tunnel login                 # open the link, pick the domain
~/kante-host/bin/cloudflared tunnel create kante          # prints the tunnel id
~/kante-host/bin/cloudflared tunnel route dns kante kante.example.org
cat > ~/kante-host/cloudflared.yml <<END
tunnel: <tunnel id>
credentials-file: $HOME/.cloudflared/<tunnel id>.json
ingress:
  - hostname: kante.example.org
    service: http://127.0.0.1:8080
  - service: http_status:404
END
rm ~/.cloudflared/cert.pem                                # only needed to create the tunnel
systemctl --user restart kante-tunnel
```

## Day to day

Run these as the service user, with `XDG_RUNTIME_DIR` set as above.

```sh
~/kante-host/repo/deploy/status.sh                 # release, engine, live data, public address
~/kante-host/repo/deploy/deploy.sh --force         # build and switch now
ln -sfn ~/kante-host/releases/<older> ~/kante-host/current && systemctl --user restart kante-engine   # go back
```

The logs are in the system journal, so read them from an account with `sudo`:

```sh
sudo journalctl _SYSTEMD_USER_UNIT=kante-deploy.service -n 50    # what the last deploys did
sudo journalctl _SYSTEMD_USER_UNIT=kante-engine.service -f       # engine log
```

`deploy.sh` and `status.sh` are used straight from the checkout, so they follow `main`. The unit files
and a running tunnel do not: after changing `deploy/units/` or `tunnel.sh`, copy the units to
`~/.config/systemd/user/`, run `systemctl --user daemon-reload` and restart the service.

To watch another branch or use another port, put `KANTE_BRANCH=…` or `KANTE_PORT=…` in
`~/kante-host/config.env`.

The downloaded data is not refreshed by itself. To refresh it, run
`KANTE_RAW=~/kante-host/raw ~/kante-host/repo/kante/scripts/fetch-data.sh --refresh`, then
`deploy.sh --force`.

## Keeping the data fresh

`refresh-data.sh` (daily, `kante-data.timer`):

- **Timetable.** The national timetable is fetched again on Mondays and Thursdays, when it is updated, and a
  new release is built from it with `deploy.sh --force`. A timetable year ends on the second Sunday of
  December (13 December 2026); `kante/scripts/fetch-data.sh` then switches to the next year's dataset by
  itself, so the engine keeps knowing trips after that day. The 02:30 run on that Sunday does the switch,
  before the first trains. `refresh-data.sh` compares the timetable of the *running* release with the one in
  force, so a failed download or build is tried again the next night, and a release is only kept when its
  timetable is valid today (`deploy.sh` checks `validTo`).
- **Learned travel times.** On Mondays the last 15 days of the open "Ist-Daten" archive are reduced to how
  long each hop and each stop usually takes (`livemap/measure/ist_daten_hops.py`, about 0.5 MB each in
  `~/kante-host/profiles`). The engine reads them within ten minutes, no restart. Days already reduced stay in
  `~/kante-host/ist-daten`, so a weekly run downloads about seven days of 0.7 GB.
- `deploy.sh` copies new or changed units from `deploy/units` and enables `kante-data.timer`, so a host set up
  before this script existed gets it with the next deploy.

## Live data keys

`~/kante-host/secrets/otd.json`: `{"siri-et": "…", "gtfs-rt": "…"}`. One opentransportdata.swiss key can be
subscribed to both products; without `"gtfs-rt"` the SIRI-ET key is tried for GTFS-RT too. `"formation"`: a key
subscribed to the Train Formation Service, for the coaches of a train in the 3D station view (`/api/formation`,
[docs/train-formation.md](../docs/train-formation.md)); without it the view shows only the sectors a train stops in. After a deploy,
`deploy.sh` notes in its log whether live data is coming in; `/api/meta` → `realtime.feeds` shows each feed.
