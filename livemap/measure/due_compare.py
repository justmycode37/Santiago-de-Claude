"""How good were the arrival times /api/due gave? Compares the archive of due_archive.py with the open "Ist-Daten"
of the same days (the measured times, published the next day), docs/ar-recognition-plan.md step 2.

Each archived prediction (a run due at a station, asked at time t) is matched to the Ist-Daten row of the same
operating day, station, line and timetabled arrival minute. Reported, by how far ahead it was asked (horizon):
  - coverage: how many archived predictions found their measured row;
  - for runs whose time came from the learned profiles (`profiled`): the profiled and the forecast's own arrival,
    both said at the same instant, against the REAL arrival;
  - for all live runs: the arrival's error, as an interval (p50 / p80 / p90 of |error|) by horizon and live state:
    what a phone may use to order a banner, never to confirm a vehicle;
  - rows the archive marked estimated (GESCHAETZT) separately: they are not measurements.

    python3 -I due_compare.py ARCHIVE_DIR ISTDATEN_DIR [--days 2026-11-24,2026-11-25]

ISTDATEN_DIR holds the raw day files (YYYY-MM-DD_istdaten.csv); a missing one is downloaded with the code of
ist_daten_hops.py (about 0.7 GB each).
"""
import argparse, collections, csv, datetime as dt, gzip, importlib.util, json, os, unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
BUCKETS = [(0, 120), (120, 300), (300, 600), (600, 1200), (1200, 1800)]


def norm_line(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return "".join(c for c in s if c.isalnum())


def swiss_offset(utc):
    """Hours ahead of UTC in Switzerland: CEST from the last Sunday of March to the last Sunday of October (01:00 UTC)."""
    def last_sunday(y, m):
        d = dt.datetime(y, m + 1, 1, tzinfo=dt.timezone.utc) - dt.timedelta(days=1)
        return d - dt.timedelta(days=(d.weekday() + 1) % 7)
    y = utc.year
    start, end = last_sunday(y, 3).replace(hour=1), last_sunday(y, 10).replace(hour=1)
    return 2 if start <= utc < end else 1


def local_minute(unix):
    """'dd.mm.yyyy HH:MM' as Ist-Daten writes timetabled times."""
    u = dt.datetime.fromtimestamp(unix, dt.timezone.utc)
    return (u + dt.timedelta(hours=swiss_offset(u))).strftime("%d.%m.%Y %H:%M")


def unix_of(local):
    """Ist-Daten local 'dd.mm.yyyy HH:MM[:SS]' -> unix seconds."""
    fmt = "%d.%m.%Y %H:%M:%S" if len(local) > 16 else "%d.%m.%Y %H:%M"
    naive = dt.datetime.strptime(local, fmt)
    for off in (1, 2):  # the one that maps back to itself
        u = naive.replace(tzinfo=dt.timezone(dt.timedelta(hours=off)))
        if swiss_offset(u.astimezone(dt.timezone.utc)) == off:
            return int(u.timestamp())
    return int(naive.replace(tzinfo=dt.timezone(dt.timedelta(hours=1))).timestamp())


def station_of_quay(quay, fallback):
    p = (quay or "").split("sloid:")
    if len(p) == 2 and p[1].split(":")[0].isdigit():
        return 8500000 + int(p[1].split(":")[0])
    return fallback


def load_archive(path, days):
    """key (day, station, line, timetabled minute) -> list of predictions."""
    preds = collections.defaultdict(list)
    for name in sorted(os.listdir(path)):
        if not name.startswith("due-") or (days and name[4:14] not in days):
            continue
        with gzip.open(os.path.join(path, name), "rt", encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue  # a line cut short when the archiver stopped
                if "due" not in rec:
                    continue
                for d in rec["due"]:
                    if not d.get("aimedArr") or not d.get("arr") or d.get("cancelled") or d.get("live") not in ("observed", "predicted"):
                        continue
                    if d.get("seq") == 0:
                        continue  # where a run starts there is no arrival to compare (Ist-Daten has none either)
                    key = (d["serviceDate"], station_of_quay(d.get("quayId"), rec.get("uic")), norm_line(d.get("line")), local_minute(d["aimedArr"]))
                    preds[key].append({"t": rec["t"], "arr": d["arr"], "raw": d.get("forecastArr") or d["arr"], "profiled": bool(d.get("profiled")),
                                       "live": d["live"], "mode": d.get("mode") or "other"})
    return preds


def istdaten_file(cache, day):
    p = os.path.join(cache, f"{day}_istdaten.csv")
    if not os.path.exists(p):
        spec = importlib.util.spec_from_file_location("ist_daten_hops", os.path.join(HERE, "ist_daten_hops.py"))
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        links = mod.discover_links()
        if day not in links:
            raise SystemExit(f"Ist-Daten for {day} is not published (yet)")
        mod.download(links[day], p)
    return p


def measured(cache, day, keys):
    """key -> (status, unix arrival) for the archive's keys of that day."""
    want = {k for k in keys if k[0] == day}
    if not want:
        return {}
    out = {}
    with open(istdaten_file(cache, day), encoding="utf-8", newline="") as f:
        rd = csv.reader(f, delimiter=";")
        head = next(rd)
        ix = {c: i for i, c in enumerate(head)}
        for r in rd:
            if r[ix["FAELLT_AUS_TF"]].lower() == "true" or not r[ix["ANKUNFTSZEIT"]]:
                continue
            sloid, bpuic = r[ix["SLOID"]], r[ix["BPUIC"]]
            st = station_of_quay(sloid, int(bpuic[:7]) if bpuic[:7].isdigit() else None)
            k = (day, st, norm_line(r[ix["LINIEN_TEXT"]]), r[ix["ANKUNFTSZEIT"]][:16])
            if k in want and r[ix["AN_PROGNOSE"]]:
                out[k] = (r[ix["AN_PROGNOSE_STATUS"]] or "UNBEKANNT", unix_of(r[ix["AN_PROGNOSE"]]))
    return out


def q(xs, p):
    s = sorted(xs)
    return s[min(len(s) - 1, int(p * (len(s) - 1) + 0.5))] if s else float("nan")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("archive")
    ap.add_argument("istdaten")
    ap.add_argument("--days", default="")
    a = ap.parse_args()
    days = [d for d in a.days.split(",") if d]
    preds = load_archive(a.archive, days)
    days = days or sorted({k[0] for k in preds})
    truth = {}
    for d in days:
        truth.update(measured(a.istdaten, d, preds.keys()))
    n_pred = sum(len(v) for v in preds.values())
    real = {k: v for k, v in truth.items() if v[0] == "REAL"}
    est = {k: v for k, v in truth.items() if v[0] == "GESCHAETZT"}
    print(f"# /api/due arrivals against Ist-Daten, {days[0]} … {days[-1]}\n")
    print(f"archived predictions of live runs: {n_pred:,} ({len(preds):,} runs at a station); runs found in Ist-Daten: "
          f"{len(truth):,} ({100 * len(truth) / max(1, len(preds)):.1f}%), of which measured (REAL) {len(real):,}, estimated {len(est):,}\n")

    def bucket(h):
        return next((f"{lo // 60}–{hi // 60} min" for lo, hi in BUCKETS if lo <= h < hi), None)

    prof = collections.defaultdict(lambda: ([], []))
    allerr = collections.defaultdict(list)
    esterr = collections.defaultdict(list)
    for k, ps in preds.items():
        for p in ps:
            for src, store in ((real, None), (est, esterr)):
                if k not in src:
                    continue
                actual = src[k][1]
                b = bucket(actual - p["t"])
                if not b:
                    continue
                if store is not None:
                    store[b].append(abs(p["arr"] - actual))
                    continue
                allerr[(b, p["live"])].append(abs(p["arr"] - actual))
                allerr[(b, "mode:" + p["mode"])].append(abs(p["arr"] - actual))
                if p["profiled"]:
                    prof[b][0].append(abs(p["arr"] - actual))
                    prof[b][1].append(abs(p["raw"] - actual))
    print("## Profiled vs the forecast's own time, said at the same instant (|error| s, against REAL)\n")
    print("| horizon | n | profiled MAE / p50 / p90 | forecast MAE / p50 / p90 | profiled closer |")
    print("|---|---:|---|---|---:|")
    for lo, hi in BUCKETS:
        b = f"{lo // 60}–{hi // 60} min"
        pe, re_ = prof[b]
        if pe:
            closer = sum(x < y for x, y in zip(pe, re_)) / len(pe)
            print(f"| {b} | {len(pe):,} | {sum(pe) / len(pe):.0f} / {q(pe, .5):.0f} / {q(pe, .9):.0f} | "
                  f"{sum(re_) / len(re_):.0f} / {q(re_, .5):.0f} / {q(re_, .9):.0f} | {100 * closer:.0f}% |")
    print("\n## Arrival error of every live run, as an interval (|error| s: p50 / p80 / p90, against REAL)\n")
    groups = sorted({g for _, g in allerr})
    print("| horizon | " + " | ".join(groups) + " |")
    print("|---|" + "---|" * len(groups))
    for lo, hi in BUCKETS:
        b = f"{lo // 60}–{hi // 60} min"
        cells = []
        for g in groups:
            xs = allerr.get((b, g), [])
            cells.append(f"{q(xs, .5):.0f} / {q(xs, .8):.0f} / {q(xs, .9):.0f} (n {len(xs):,})" if xs else "-")
        print(f"| {b} | " + " | ".join(cells) + " |")
    print("\n## Against rows Ist-Daten marks estimated (GESCHAETZT): not measurements, shown apart\n")
    for lo, hi in BUCKETS:
        b = f"{lo // 60}–{hi // 60} min"
        xs = esterr.get(b, [])
        if xs:
            print(f"- {b}: n {len(xs):,}, p50 {q(xs, .5):.0f} s, p90 {q(xs, .9):.0f} s")


if __name__ == "__main__":
    main()
