"""For every trip seen in a recording, fetch its stops, scheduled times and hop paths."""
import gzip, json, sys, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

rec, out = sys.argv[1], sys.argv[2]
keys = {}
with gzip.open(rec, "rt", encoding="utf-8") as f:
    for line in f:
        d = json.loads(line)
        for r in d.get("vehicles", []):
            keys[r[0] + "|" + r[1]] = (r[0], r[1])

def get(item):
    key, (tid, date) = item
    url = "http://127.0.0.1:8090/trip?" + urllib.parse.urlencode({"id": tid, "date": date})
    for attempt in range(3):
        try:
            d = json.loads(urllib.request.urlopen(url, timeout=30).read())
            calls = [[c["lon"], c["lat"], c["arr"], c["dep"]] for c in d["calls"]]
            return key, {"calls": calls, "segs": d["segments"]}
        except Exception as e:
            err = str(e)
    return key, {"error": err}

with ThreadPoolExecutor(12) as ex:
    res = dict(ex.map(get, keys.items()))
bad = sum(1 for v in res.values() if "error" in v)
with gzip.open(out, "wt", encoding="utf-8") as f:
    json.dump(res, f)
nseg = sum(len(v["segs"]) for v in res.values() if "segs" in v); npath = sum(sum(1 for s in v["segs"] if s) for v in res.values() if "segs" in v)
print(f"trips {len(res)}  failed {bad}  hops {nseg}  with a path {npath} ({100 * npath / max(1, nseg):.0f}%)")
