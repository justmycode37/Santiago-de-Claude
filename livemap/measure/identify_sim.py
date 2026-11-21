"""Simulate a camera at real stops: at the moment a real vehicle is there, read (some of) its display and ask
/api/identify. Counts correct / wrong / ambiguous / none per reading quality. Usage: python -I identify_sim.py [engine]"""
import json, random, sys, time, urllib.parse, urllib.request, collections, math
from concurrent.futures import ThreadPoolExecutor

B = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080"
rnd = random.Random(7)
CITIES = {  # w,s,e,n of city centres
    "Bern": (7.425, 46.940, 7.455, 46.955), "Zürich": (8.525, 47.365, 8.555, 47.385), "Basel": (7.575, 47.545, 7.605, 47.565),
    "Genève": (6.130, 46.195, 6.160, 46.215), "Lausanne": (6.620, 46.510, 6.650, 46.525), "Luzern": (8.295, 47.040, 8.320, 47.055),
    "St. Gallen": (9.360, 47.415, 9.385, 47.430), "Winterthur": (8.715, 47.495, 8.735, 47.505), "Lugano": (8.940, 46.000, 8.965, 46.015),
    "Biel": (7.235, 47.130, 7.255, 47.140), "Thun": (7.615, 46.750, 7.635, 46.760), "Chur": (9.520, 46.845, 9.540, 46.860),
}

def get(path, **q):
    with urllib.request.urlopen(B + path + "?" + urllib.parse.urlencode(q), timeout=120) as r:
        return json.load(r)

def misread(s):
    """One OCR-like error: a letter swapped for a look-alike, or dropped."""
    if len(s) < 4:
        return s
    i = rnd.randrange(len(s))
    swap = {"i": "1", "o": "0", "s": "5", "e": "c", "u": "v", "n": "m", "a": "o", "l": "1", "ü": "u", "ä": "a", "ö": "o"}
    c = s[i].lower()
    return s[:i] + (swap.get(c, "") if c in swap else "") + s[i + 1:]

def offset(lat, lon, m):
    a = rnd.uniform(0, 2 * math.pi)
    return lat + m * math.cos(a) / 111320, lon + m * math.sin(a) / (111320 * math.cos(math.radians(lat)))

# 1. real situations: a vehicle due at a boarding point
now = int(time.time())
cases = []
for city, (w, s, e, n) in CITIES.items():
    quays = [q for q in get("/api/quays", bbox=f"{w},{s},{e},{n}")["quays"] if q["precision"] != "station"]
    rnd.shuffle(quays)
    for q in quays[:12]:
        due = [d for d in get("/api/due", quay=q["id"], t=now, before=0, after=1200, limit=20)["due"] if not d["cancelled"] and (d.get("arr") or d.get("dep"))]
        for d in rnd.sample(due, min(2, len(due))):
            cases.append((city, q, d))
print(f"{len(cases)} real situations in {len(CITIES)} cities")

SCEN = {
    "line+destination": lambda d: dict(line=d["line"]["name"], headsign=d["headsign"]),
    "line+destination, misread": lambda d: dict(line=d["line"]["name"], headsign=misread(d["headsign"])),
    "line+destination+direction": lambda d: dict(line=d["line"]["name"], headsign=d["headsign"], **({"bearing": (d.get("departBearing") or d.get("approachBearing") or 0) + rnd.uniform(-25, 25)} if (d.get("departBearing") or d.get("approachBearing")) is not None else {})),
    "line only": lambda d: dict(line=d["line"]["name"]),
    "line+direction": lambda d: dict(line=d["line"]["name"], **({"bearing": (d.get("departBearing") or d.get("approachBearing") or 0) + rnd.uniform(-25, 25)} if (d.get("departBearing") or d.get("approachBearing")) is not None else {})),
    "destination only": lambda d: dict(headsign=d["headsign"]),
}

def run(args):
    name, (city, q, d) = args
    at = d.get("arr") or d.get("dep")
    lat, lon = offset(q["lat"], q["lon"], rnd.uniform(5, 30))  # camera a few metres from the stop
    params = dict(lat=f"{lat:.6f}", lon=f"{lon:.6f}", t=at + 10, **SCEN[name](d))
    r = get("/api/identify", **params)
    top = r["candidates"][0] if r["candidates"] else None
    truth = (d["tripId"], d["serviceDate"])
    if r["result"] == "match":
        if (top["tripId"], top["serviceDate"]) == truth:
            return name, "correct"
        # the same line and destination a few minutes apart is the same thing to a camera
        same = top["line"]["name"] == d["line"]["name"] and top["headsign"] == d["headsign"]
        return name, "wrong (same line+destination)" if same else "WRONG"
    if r["result"] == "ambiguous":
        return name, "ambiguous (truth listed)" if any((c["tripId"], c["serviceDate"]) == truth for c in r["candidates"]) else "ambiguous (truth missing)"
    return name, "none"

jobs = [(n, c) for n in SCEN for c in cases]
t0 = time.time()
with ThreadPoolExecutor(4) as ex:
    results = list(ex.map(run, jobs))
print(f"{len(jobs)} identify calls in {time.time() - t0:.0f} s ({1000 * (time.time() - t0) / len(jobs):.0f} ms each with 4 at once)\n")
by = collections.defaultdict(collections.Counter)
for n, o in results:
    by[n][o] += 1
for n in SCEN:
    c = by[n]; tot = sum(c.values())
    print(f"{n:30s} " + ", ".join(f"{k} {100 * v / tot:.0f}%" for k, v in c.most_common()))
