"""Archive what /api/due says, as it says it, for later comparison with what was measured (due_compare.py and
docs/ar-recognition-plan.md, step 2). Runs next to the engine on the server (deploy/units/kante-due-archive.service).

Every POLL_S seconds, for the stations inside the city boxes below (the first STATIONS of each, in a fixed order),
asks /api/due for the next 30 minutes and appends one gzip JSON line per station to DIR/due-YYYY-MM-DD.jsonl.gz:
{"t": engine time, "recv": wall clock, "station": "<id>", "uic": 85xxxxx, "due": [...]}, each entry cut to what the
comparison needs. Only runs with live data are kept unless --all is given. Files older than KEEP_DAYS are deleted.

    python3 -I due_archive.py DIR [--engine http://127.0.0.1:8080] [--poll 60] [--stations 12] [--keep 28] [--all] [--once]
"""
import argparse, datetime as dt, gzip, json, os, time, urllib.parse, urllib.request

CITIES = {  # w,s,e,n (as identify_sim.py): bus and tram stops of the city centres
    "Bern": (7.425, 46.940, 7.455, 46.955), "Zürich": (8.525, 47.365, 8.555, 47.385), "Basel": (7.575, 47.545, 7.605, 47.565),
    "Genève": (6.130, 46.195, 6.160, 46.215), "Lausanne": (6.620, 46.510, 6.650, 46.525), "Luzern": (8.295, 47.040, 8.320, 47.055),
}
KEEP = ("tripId", "serviceDate", "seq", "headsign", "quayId", "aimedArr", "aimedDep", "arr", "dep", "forecastArr",
        "forecastDep", "profiled", "delayS", "cancelled", "extra", "state")


def get(base, path, **q):
    req = urllib.request.Request(base + path + "?" + urllib.parse.urlencode(q), headers={"User-Agent": "curl/8"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


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


def cut(d):
    out = {k: d.get(k) for k in KEEP if d.get(k) is not None}
    out["line"] = (d.get("line") or {}).get("name")
    out["mode"] = (d.get("line") or {}).get("mode")
    li = d.get("liveInfo") or {}
    out["live"] = li.get("state")
    if li.get("observedSeq") is not None:
        out["observedSeq"], out["observedKind"] = li["observedSeq"], li.get("observedKind")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--engine", default="http://127.0.0.1:8080")
    ap.add_argument("--poll", type=int, default=60)
    ap.add_argument("--stations", type=int, default=12, help="stations per city")
    ap.add_argument("--keep", type=int, default=28, help="days of files kept")
    ap.add_argument("--all", action="store_true", help="keep timetable-only runs too")
    ap.add_argument("--once", action="store_true", help="one poll, then stop (a check)")
    a = ap.parse_args()
    os.makedirs(a.dir, exist_ok=True)
    stations = []
    for box in CITIES.values():
        stations += [str(u) for u in stations_in(lambda path, **q: get(a.engine, path, **q), box)[: a.stations]]
    print(f"due_archive: {len(stations)} stations every {a.poll} s -> {a.dir}", flush=True)
    while True:
        start = time.time()
        day = dt.date.today().isoformat()
        n = kept = 0
        with gzip.open(os.path.join(a.dir, f"due-{day}.jsonl.gz"), "at", encoding="utf-8") as f:
            for sid in stations:
                try:
                    d = get(a.engine, "/api/due", station=sid, before=0, after=1800, limit=200)
                except Exception as e:  # a gap is itself a finding: written down
                    f.write(json.dumps({"recv": time.time(), "station": sid, "error": str(e)}) + "\n")
                    continue
                due = [cut(x) for x in d.get("due", []) if a.all or (x.get("liveInfo") or {}).get("state") in ("observed", "predicted")]
                f.write(json.dumps({"t": d["t"], "recv": time.time(), "station": sid, "uic": int(sid),
                                    "complete": d.get("complete"), "due": due}, ensure_ascii=False) + "\n")
                n += 1
                kept += len(due)
        cutoff = (dt.date.today() - dt.timedelta(days=a.keep)).isoformat()
        for name in os.listdir(a.dir):
            if name.startswith("due-") and name[4:14] < cutoff:
                os.remove(os.path.join(a.dir, name))
        if a.once:
            print(f"due_archive: {n} stations, {kept} runs kept", flush=True)
            return
        time.sleep(max(1, a.poll - (time.time() - start)))


if __name__ == "__main__":
    main()
