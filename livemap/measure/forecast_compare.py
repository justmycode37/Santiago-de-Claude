"""Whose forecasts are better, SIRI-ET's or GTFS-RT's? Takes both feeds' forecast arrival at the next stops of
a sample of trips now, waits, and compares each with the arrival SIRI-ET has measured by then.

    python3 -I forecast_compare.py <siri engine> <gtfs engine> [trips=300] [wait_s=720]

The GTFS-RT engine should have just loaded a fresh GTFS-RT document (KANTE_RT_GTFS_FILE=…), the SIRI-ET
engine polls SIRI-ET live (e.g. the hosted engine)."""
import json, random, statistics, sys, time, urllib.parse, urllib.request

SIRI, GTFS = sys.argv[1].rstrip("/"), sys.argv[2].rstrip("/")
N = int(sys.argv[3]) if len(sys.argv) > 3 else 300
WAIT = int(sys.argv[4]) if len(sys.argv) > 4 else 720


def get(base, path, **q):
    req = urllib.request.Request(base + path + "?" + urllib.parse.urlencode(q), headers={"User-Agent": "curl/8"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except Exception:
        return None


def live_arr(trip):
    """seq → live arrival (unix) for calls with live times."""
    return {c["seq"]: c["arr"] + c["arrDelayS"] for c in trip["calls"] if c.get("live") and c.get("arr") and c.get("arrDelayS") is not None}


# trips under way in a few busy regions, live in both engines
boxes = ["7.30,46.85,7.60,47.05", "8.40,47.30,8.70,47.50", "6.50,46.45,6.80,46.60", "6.05,46.15,6.25,46.30", "7.50,47.48,7.70,47.60", "8.20,46.95,8.40,47.10", "9.25,47.35,9.50,47.50"]
t0 = int(time.time())
cands = set()
for b in boxes:
    for base in (SIRI, GTFS):
        for v in (get(base, "/api/vehicles", bbox=b) or {}).get("vehicles", []):
            if not v.get("extra") and v["liveInfo"]["state"] in ("observed", "predicted"):
                cands.add((v["tripId"], v["serviceDate"]))
cands = random.Random(1).sample(sorted(cands), min(N, len(cands)))
before = []
for tid, d in cands:
    s, g = get(SIRI, "/api/trip", id=tid, date=d), get(GTFS, "/api/trip", id=tid, date=d)
    if not s or not g or s["liveInfo"]["state"] not in ("observed", "predicted") or g["liveInfo"]["state"] not in ("observed", "predicted"):
        continue
    obs = s["liveInfo"].get("observedSeq", -1)
    sa, ga = live_arr(s), live_arr(g)
    # the next stops not yet reached, arriving 2–12 min from now
    for seq in sorted(sa):
        if seq > obs and seq in ga and t0 + 120 <= sa[seq] <= t0 + WAIT - 60:
            before.append((tid, d, seq, sa[seq], ga[seq]))
print(f"{len(cands)} trips asked, {len(before)} future arrivals forecast by both; waiting {WAIT} s", flush=True)
time.sleep(WAIT)

errs_s, errs_g, same = [], [], 0
by_trip = {}
for tid, d, seq, fs, fg in before:
    if (tid, d) not in by_trip:
        by_trip[(tid, d)] = get(SIRI, "/api/trip", id=tid, date=d)
    s = by_trip[(tid, d)]
    if not s:
        continue
    li = s["liveInfo"]
    obs, kind = li.get("observedSeq", -1), li.get("observedKind", "")
    if seq > obs or (seq == obs and "arr" not in kind):
        continue  # not measured yet
    c = next((c for c in s["calls"] if c["seq"] == seq), None)
    if not c or c.get("arrDelayS") is None:
        continue
    actual = c["arr"] + c["arrDelayS"]
    errs_s.append(abs(fs - actual))
    errs_g.append(abs(fg - actual))
    same += fs == fg
n = len(errs_s)
print(f"measured since: {n} arrivals")
if n:
    q = lambda xs, p: sorted(xs)[int(p * (n - 1))]
    print(f"identical forecasts: {100 * same / n:.0f}%")
    print(f"SIRI-ET forecast error (s): mean {statistics.mean(errs_s):.0f}, median {statistics.median(errs_s):.0f}, p90 {q(errs_s, .9)}")
    print(f"GTFS-RT forecast error (s): mean {statistics.mean(errs_g):.0f}, median {statistics.median(errs_g):.0f}, p90 {q(errs_g, .9)}")
    better = sum(g < s for s, g in zip(errs_s, errs_g)); worse = sum(g > s for s, g in zip(errs_s, errs_g))
    print(f"GTFS-RT closer: {100 * better / n:.0f}%, SIRI-ET closer: {100 * worse / n:.0f}%, equal: {100 * (n - better - worse) / n:.0f}%")
