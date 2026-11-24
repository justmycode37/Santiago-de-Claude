"""Timetable ambiguity audit for the AR camera (docs/ar-recognition-plan.md, step 2): how often is the rider's run
the only one a vehicle display could stand for, and when it is not, could taking the wrong one harm the rider?

For sampled boarding points in Swiss cities at several times of a weekday, every run leaving there soon is taken as
a rider's run, with a real later stop of it as the rider's destination. Its rivals are the other runs at the same
station within a time window that a display cannot tell from it:
  - same display: the same line and destination (what a matched display shows);
  - destination only: the same destination under another line (a display whose number was not read).
Each run is then one of
  - unique: no same-display rival in the window;
  - all safe: every same-display rival can be boarded here and takes the rider to their stop (green is right for any);
  - unsafe rival: some same-display rival cannot be boarded here or does not serve the rider's stop (an express and
    a local, a short working, a set-down-only call). These are where a wrong pick could harm the rider; for them the
    report says whether the boarding point (quay) or the timetable direction (the next stop) would tell them apart.

Runs on the timetable of a local engine (no live data needed):
    kante serve --data DIR --port 8091 --app none
    python -I -X utf8 ambiguity_audit.py [engine=http://127.0.0.1:8091] [date=2026-11-25] [per_station=3] [stations_per_city=8]
"""
import collections, datetime as dt, json, random, sys, unicodedata, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

B = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8091"
DAY = dt.date.fromisoformat(sys.argv[2] if len(sys.argv) > 2 else "2026-11-25")
PER = int(sys.argv[3]) if len(sys.argv) > 3 else 3
rnd = random.Random(11)
CITIES = {  # w,s,e,n of city centres (as identify_sim.py)
    "Bern": (7.425, 46.940, 7.455, 46.955), "Zürich": (8.525, 47.365, 8.555, 47.385), "Basel": (7.575, 47.545, 7.605, 47.565),
    "Genève": (6.130, 46.195, 6.160, 46.215), "Lausanne": (6.620, 46.510, 6.650, 46.525), "Luzern": (8.295, 47.040, 8.320, 47.055),
    "St. Gallen": (9.360, 47.415, 9.385, 47.430), "Winterthur": (8.715, 47.495, 8.735, 47.505), "Lugano": (8.940, 46.000, 8.965, 46.015),
    "Biel": (7.235, 47.130, 7.255, 47.140), "Thun": (7.615, 46.750, 7.635, 46.760), "Chur": (9.520, 46.845, 9.540, 46.860),
}
HOURS = [(7, 30), (12, 0), (17, 30), (21, 0)]
WINDOWS = [300, 600, 1200]
STATIONS_PER_CITY = int(sys.argv[4]) if len(sys.argv) > 4 else 8


def get(path, **q):
    req = urllib.request.Request(B + path + "?" + urllib.parse.urlencode(q), headers={"User-Agent": "curl/8"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def norm(s):
    s = unicodedata.normalize("NFKD", (s or "").replace("ß", "ss")).encode("ascii", "ignore").decode().lower()
    return " ".join("".join(c if c.isalnum() else " " for c in s).split())


def line_key(name):
    k = norm(name).replace(" ", "")
    for p in ("bus", "tram", "nfb", "nft"):
        if k.startswith(p) and k[len(p):][:1].isdigit():
            return k[len(p):]
    return k


def unix(day, h, m):
    # Swiss local time; November is CET (UTC+1)
    return int(dt.datetime(day.year, day.month, day.day, h, m, tzinfo=dt.timezone(dt.timedelta(hours=1))).timestamp())


def when(d):
    return d.get("dep") or d.get("arr")


def mode_of(d):
    m = {"rail": "train"}.get((d.get("line") or {}).get("mode"), (d.get("line") or {}).get("mode")) or "other"
    return m if m in ("bus", "tram", "train") else "other"


def stations_in(get, box, t=None):
    """UIC numbers of the stations with boarding points in a box: /api/due around a 3 x 3 grid of points, each
    boarding point's SLOID ("ch:1:sloid:7000:1:2") naming its station."""
    w, s, e, n = box
    found = set()
    for i in range(3):
        for j in range(3):
            lat, lon = s + (n - s) * (i + 0.5) / 3, w + (e - w) * (j + 0.5) / 3
            q = dict(lat=f"{lat:.5f}", lon=f"{lon:.5f}", radius=400, before=0, after=3600, limit=200)
            if t:
                q["t"] = t
            for d in get("/api/due", **q)["due"]:
                p = (d.get("quayId") or "").split("sloid:")
                if len(p) == 2 and p[1].split(":")[0].isdigit():
                    found.add(8500000 + int(p[1].split(":")[0]))
    return sorted(found)


# 1. stations
stations = []
for city, box in CITIES.items():
    ids = stations_in(get, box, unix(DAY, 12, 0))
    rnd.shuffle(ids)
    stations += [(city, str(sid)) for sid in ids[:STATIONS_PER_CITY]]
print(f"{len(stations)} stations in {len(CITIES)} cities, {len(HOURS)} times of {DAY} ({DAY.strftime('%A')})", flush=True)


def situation(args):
    """All rider runs at one station and time: list of result rows."""
    (city, sid), (h, m) = args
    t = unix(DAY, h, m)
    try:
        board = get("/api/due", station=sid, t=t, before=1200, after=2700, limit=200)["due"]
    except Exception:
        return []
    riders = [d for d in board if d.get("pickup", True) and d.get("dep") and t <= d["dep"] <= t + 900 and not d["cancelled"]
              and d.get("line") and d.get("headsign")]
    out = []
    for r in rnd.sample(riders, min(PER, len(riders))):
        try:
            trip = get("/api/trip", id=r["tripId"], date=r["serviceDate"])
        except Exception:
            continue
        later = [c for c in trip["calls"] if c["seq"] > r["seq"] and not c.get("skipped")]
        if not later:
            continue
        dest = rnd.choice(later[: min(len(later), 15)])
        p = (dest["quay"].get("sloid") or dest["quay"].get("id") or "").split("sloid:")
        if len(p) != 2 or not p[1].split(":")[0].isdigit():
            continue
        to = str(8500000 + int(p[1].split(":")[0]))
        if to == sid:
            continue
        try:
            served = get("/api/due", station=sid, t=t, before=1200, after=2700, limit=200, to=to)["due"]
        except Exception:
            continue
        me = next((d for d in served if d["tripId"] == r["tripId"] and d["seq"] == r["seq"]), None)
        if not me or me.get("servesTo") is False:
            continue  # the rider's own run must take them there (it was picked from its own later stops)
        row = {"city": city, "mode": mode_of(r), "hour": h, "w": {}, "dest_only": {}, "board_complete": None}
        for W in WINDOWS:
            same = [d for d in served if d is not me and not d["cancelled"] and d.get("line") and d.get("headsign")
                    and line_key(d["line"]["name"]) == line_key(me["line"]["name"]) and norm(d["headsign"]) == norm(me["headsign"])
                    and abs(when(d) - when(me)) <= W]
            dest_only = [d for d in served if d is not me and not d["cancelled"] and d.get("line") and d.get("headsign")
                         and line_key(d["line"]["name"]) != line_key(me["line"]["name"]) and norm(d["headsign"]) == norm(me["headsign"])
                         and abs(when(d) - when(me)) <= W]
            unsafe = [d for d in same if d.get("pickup") is False or d.get("dep") is None or d.get("servesTo") is not True]
            if not same:
                kind = "unique"
            elif not unsafe:
                kind = "all safe"
            else:
                kind = "unsafe rival"
            other_quay = all(d.get("quayId") != me.get("quayId") for d in unsafe) if unsafe else None
            nb = me.get("departBearing")
            other_dir = (all(d.get("departBearing") is not None and nb is not None
                             and abs(((d["departBearing"] - nb + 540) % 360) - 180) > 45 for d in unsafe) if unsafe else None)
            # a same-display rival that leaves for another next stop: a variant of the line (safe here only because
            # it happens to serve the rider's stop too)
            other_route = any(d.get("nextStop") != me.get("nextStop") for d in same)
            row["w"][W] = {"kind": kind, "other_route": other_route, "quay_tells": other_quay, "direction_tells": other_dir,
                           "why": sorted({"cannot board" if (d.get("pickup") is False or d.get("dep") is None) else "skips your stop" for d in unsafe})}
            row["dest_only"][W] = bool(dest_only)
        out.append(row)
    return out


jobs = [(s, hm) for s in stations for hm in HOURS]
with ThreadPoolExecutor(4) as ex:
    rows = [r for rs in ex.map(situation, jobs) for r in rs]
print(f"{len(rows)} rider runs\n")


def pct(a, n):
    return f"{100 * a / n:.1f}%" if n else "-"


def table(group_of, title):
    print(f"### {title}\n")
    print("| group | runs | window | unique | all safe | …a rival on another route | unsafe rival | …quay tells | …direction tells | …neither | destination shared by another line |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    groups = collections.defaultdict(list)
    for r in rows:
        for g in group_of(r):
            groups[g].append(r)
    for g in sorted(groups, key=lambda g: (g != "all", g)):
        rs = groups[g]
        for W in WINDOWS:
            c = collections.Counter(r["w"][W]["kind"] for r in rs)
            uns = [r for r in rs if r["w"][W]["kind"] == "unsafe rival"]
            q = sum(1 for r in uns if r["w"][W]["quay_tells"])
            d = sum(1 for r in uns if r["w"][W]["direction_tells"])
            neither = sum(1 for r in uns if not r["w"][W]["quay_tells"] and not r["w"][W]["direction_tells"])
            dest = sum(1 for r in rs if r["dest_only"][W])
            route = sum(1 for r in rs if r["w"][W]["kind"] == "all safe" and r["w"][W]["other_route"])
            print(f"| {g} | {len(rs)} | ±{W // 60} min | {pct(c['unique'], len(rs))} | {pct(c['all safe'], len(rs))} | {pct(route, c['all safe'])} | "
                  f"{pct(c['unsafe rival'], len(rs))} | {pct(q, len(uns))} | {pct(d, len(uns))} | {pct(neither, len(uns))} | {pct(dest, len(rs))} |")
    print()


table(lambda r: ["all", "mode: " + r["mode"]], "By mode")
table(lambda r: [r["city"]], "By city")
table(lambda r: [f"{r['hour']:02d}:xx"], "By time of day")
why = collections.Counter(w for r in rows for w in r["w"][600]["why"])
print("Why a rival is unsafe (±10 min):", dict(why))
n_uns = sum(1 for r in rows if r["w"][1200]["kind"] == "unsafe rival")
print(f"Unsafe rivals within ±20 min: {n_uns} of {len(rows)} rider runs"
      + (f" (95 % upper bound on the rate with none seen: {300 / len(rows):.2f} %)" if not n_uns and rows else ""))
