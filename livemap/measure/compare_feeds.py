"""What does GTFS-RT add to SIRI-ET? Compares, trip by trip, two engines asked at the same moment for every
vehicle under way in Switzerland: one running on SIRI-ET only (e.g. the hosted engine) and one on GTFS-RT
only (a local engine started with KANTE_RT_GTFS_FILE=<a saved GTFS-RT document>, or a GTFS-RT key alone).

    python3 -I compare_feeds.py <siri engine> <gtfs engine>

Prints, per operator: vehicles under way, how many have live data from SIRI-ET, from GTFS-RT, from GTFS-RT
only, and from either; then how fresh each feed's data is for the trips both cover."""
import collections, json, statistics, sys, time, urllib.parse, urllib.request

SIRI, GTFS = sys.argv[1].rstrip("/"), sys.argv[2].rstrip("/")


def get(base, path, **q):
    req = urllib.request.Request(base + path + "?" + urllib.parse.urlencode(q), headers={"User-Agent": "curl/8"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


# Switzerland in tiles small enough for the engine's box limit and its 1,500 vehicles per answer
W, S, E, N, STEP = 5.95, 45.82, 10.50, 47.82, 0.25
t = int(time.time())
seen = {}  # (tripId, date) → {"op", "siri", "gtfs"}
for i in range(int((E - W) / STEP) + 1):
    for j in range(int((N - S) / STEP) + 1):
        box = f"{W + i * STEP:.2f},{S + j * STEP:.2f},{W + (i + 1) * STEP:.2f},{S + (j + 1) * STEP:.2f}"
        for name, base in (("siri", SIRI), ("gtfs", GTFS)):
            for v in get(base, "/api/vehicles", bbox=box, t=t)["vehicles"]:
                if v.get("extra"):
                    continue
                k = (v["tripId"], v["serviceDate"])
                row = seen.setdefault(k, {"op": v["line"]["operator"] or "?", "mode": v["line"]["mode"]})
                li = v["liveInfo"]
                row[name] = li if li["state"] in ("observed", "predicted", "stale") else None
meta = {n: get(b, "/api/meta")["realtime"] for n, b in (("siri", SIRI), ("gtfs", GTFS))}

per = collections.defaultdict(collections.Counter)
for row in seen.values():
    for key in ("ALL", row["op"]):
        c = per[key]
        c["under way"] += 1
        s, g = bool(row.get("siri")), bool(row.get("gtfs"))
        c["SIRI-ET"] += s
        c["GTFS-RT"] += g
        c["GTFS-RT only"] += g and not s
        c["SIRI-ET only"] += s and not g
        c["either"] += s or g
print(f"vehicles under way at {time.strftime('%H:%M', time.localtime(t))}: {len(seen)}\n")
print(f"{'operator':45s} {'under way':>9s} {'SIRI-ET':>8s} {'GTFS-RT':>8s} {'GTFS only':>9s} {'SIRI only':>9s} {'either':>7s}")
rows = sorted(per.items(), key=lambda kv: -kv[1]["under way"])
for op, c in rows[:1] + [r for r in rows[1:] if r[1]["GTFS-RT only"] >= 3 or r[1]["under way"] >= 80][:25]:
    u = c["under way"]
    pct = lambda x: f"{100 * c[x] / u:5.1f}%"
    print(f"{op[:45]:45s} {u:9d} {pct('SIRI-ET'):>8s} {pct('GTFS-RT'):>8s} {c['GTFS-RT only']:9d} {c['SIRI-ET only']:9d} {pct('either'):>7s}")

# Freshness: when each feed last updated the trips both have
both = [r for r in seen.values() if r.get("siri") and r.get("gtfs")]
sa = [t - r["siri"]["updatedAt"] for r in both if r["siri"].get("updatedAt")]
ga = [t - r["gtfs"]["updatedAt"] for r in both if r["gtfs"].get("updatedAt")]
newer = sum(1 for r in both if r["gtfs"].get("updatedAt", 0) > r["siri"].get("updatedAt", 0))
print(f"\ntrips in both feeds: {len(both)}")
if sa and ga:
    q = lambda xs, p: sorted(xs)[int(p * (len(xs) - 1))]
    print(f"age of each trip's last update (s), median / p90:  SIRI-ET {statistics.median(sa):.0f} / {q(sa, .9)}   GTFS-RT {statistics.median(ga):.0f} / {q(ga, .9)}")
    print(f"GTFS-RT updated the trip later than SIRI-ET: {100 * newer / len(both):.0f}% of them")
for n, m in meta.items():
    f = (m.get("feeds") or [{}])[0]
    print(f"{n}: document {f.get('polledAt', 0) - f.get('updatedAt', 0)} s old when fetched; {f.get('matched')} of {f.get('journeys')} journeys matched")
