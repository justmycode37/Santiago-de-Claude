#!/usr/bin/env python3
"""Would historical travel times place Swiss PT vehicles better than the timetable?

Uses the open "Ist-Daten" (actual data) archive of opentransportdata.swiss: one CSV per
operating day with scheduled and actual (measured / forecast) stop times.

Question: given a MEASURED departure at stop A, how well do we predict the (measured)
arrival at the next stop B using
  (a) the scheduled hop duration                         (what the live engine does now)
  (b) a learned median hop duration from past days, by (A, B, hour, day type), falling back
      to (A, B), then to (a) when there are fewer than MIN_N samples.
Same for dwell time (actual departure - actual arrival at a stop).

Usage (standard library only):
    python -I ist_daten_hops.py --days 15 --cache C:\\path\\to\\cache [--out DIR] [--keep-raw]

Stage 1 (per day, parallel): download the day's CSV (streamed to disk), reduce it to a
compact gzip file of measured hops/dwells + a stats JSON, delete the raw CSV (unless
--keep-raw). Re-runs reuse the compact files.
Stage 2: train on all days except the last 2 weekdays, evaluate on those 2.
"""
import argparse
import csv
import datetime as dt
import gzip
import json
import os
import re
import sys
import time
import urllib.request
from array import array
from collections import Counter, defaultdict
from multiprocessing import Pool

DATASET_PAGES = [
    "https://data.opentransportdata.swiss/en/dataset/ist-daten-v2",
    "https://data.opentransportdata.swiss/de/dataset/ist-daten-v2",
]
UA = "Mozilla/5.0 (research script; ist_daten_hops.py)"
FORMAT = "v3"             # bump when the compact format changes (v3: stops keyed by station UIC from SLOID)
MIN_N = 5                 # min samples for a learned profile
MAX_DUR = 7200            # drop hops/dwells longer than this many seconds (glitches / layovers)
SHORT = 120               # "short hop" = scheduled duration <= 2 min
CSV_COLS = ["BETRIEBSTAG", "FAHRT_BEZEICHNER", "BETREIBER_ABK", "PRODUKT_ID", "BPUIC",
            "ANKUNFTSZEIT", "AN_PROGNOSE", "AN_PROGNOSE_STATUS",
            "ABFAHRTSZEIT", "AB_PROGNOSE", "AB_PROGNOSE_STATUS",
            "DURCHFAHRT_TF", "FAELLT_AUS_TF", "ZUSATZFAHRT_TF", "SLOID"]
MODES = ["train", "tram", "bus", "other"]


def mode_of(prod):
    p = prod.strip().lower()
    return {"zug": "train", "tram": "tram", "bus": "bus"}.get(p, "other")


# ---------------------------------------------------------------- discovery / download
def http_get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    return urllib.request.urlopen(req, timeout=timeout)


def discover_links():
    """{date: url} scraped from the dataset page (resource ids change, so never hard-code)."""
    last = None
    for page in DATASET_PAGES:
        try:
            html = http_get(page).read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            last = e
            continue
        links = {}
        for m in re.finditer(r'https://data\.opentransportdata\.swiss/dataset/[^"\s]*?/download/'
                             r'(\d{4}-\d{2}-\d{2})_istdaten\.csv', html):
            links[m.group(1)] = m.group(0)
        if links:
            return links
    raise SystemExit(f"could not find Ist-Daten download links ({last})")


def pick_days(links, n, end=None):
    days = sorted(links)
    if end:
        days = [d for d in days if d <= end]
    days = days[-n:]
    for a, b in zip(days, days[1:]):
        if (dt.date.fromisoformat(b) - dt.date.fromisoformat(a)).days != 1:
            print(f"warning: gap between {a} and {b} in the available days", file=sys.stderr)
    return days


def download(url, dest):
    tmp = dest + ".part"
    with http_get(url, timeout=120) as r, open(tmp, "wb") as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
    os.replace(tmp, dest)


# ---------------------------------------------------------------- stage 1: reduce a day
_base = {}


def tsec(s):
    """'20.11.2026 06:35[:00]' -> naive local seconds (ordinal*86400 + time of day)."""
    if not s:
        return None
    b = _base.get(s[:10])
    if b is None:
        b = _base[s[:10]] = dt.date(int(s[6:10]), int(s[3:5]), int(s[:2])).toordinal() * 86400
    return b + int(s[11:13]) * 3600 + int(s[14:16]) * 60 + (int(s[17:19]) if len(s) > 16 else 0)


def station_uic(sloid, bpuic):
    """The stop's station as its 7-digit UIC number. BPUIC comes in several
    lengths in this archive (7, 8 and 9 digits); the SLOID ("ch:1:sloid:7000:4:7")
    names the station unambiguously, so it is preferred."""
    if sloid.startswith("ch:1:sloid:"):
        num = sloid.split(":")[3]
        if num.isdigit() and int(num) < 100000:
            return str(8500000 + int(num))
    return bpuic[:7] if len(bpuic) == 9 else bpuic


def reduce_day(args):
    day, url, cache, keep_raw = args
    comp = os.path.join(cache, f"{day}.{FORMAT}.tsv.gz")
    statf = os.path.join(cache, f"{day}.{FORMAT}.stats.json")
    if os.path.exists(comp) and os.path.exists(statf):
        return day, "cached"
    rawdir = os.path.join(cache, "raw")
    os.makedirs(rawdir, exist_ok=True)
    raw = os.path.join(rawdir, f"{day}_istdaten.csv")
    t0 = time.time()
    if not os.path.exists(raw):
        download(url, raw)
    t1 = time.time()

    ev = defaultdict(lambda: [0, 0, 0, 0])      # (mode, op) -> arr_total, arr_real, dep_total, dep_real
    hopst = defaultdict(lambda: [0, 0, 0, 0, 0])  # mode -> pairs, zero_sched, both_measured, zero_and_measured, neg_sched
    status = Counter()
    prods = Counter()
    skip = Counter()
    seen_ids = set()
    reappear = 0
    hours_ev = defaultdict(lambda: [0, 0])      # hour -> total, real (all modes)

    out = gzip.open(comp + ".tmp", "wt", encoding="utf-8", compresslevel=6)

    def flush(rows):
        """rows: list of tuples for one journey, in file order."""
        mode, op = rows[0][0], rows[0][1]
        # sort by scheduled time (dep else arr); stable
        rows.sort(key=lambda r: (r[6] if r[6] is not None else r[4] if r[4] is not None else 0))
        prev = None
        for r in rows:
            (_m, _o, bp, cancelled, sa, aa, sd, ad, pa, pd) = r[:10]
            if prev is not None and not prev[3] and not cancelled:
                pbp, psd, pad = prev[2], prev[6], prev[7]
                # hop prev -> r: needs scheduled dep at A and scheduled arr at B
                if psd is not None and sa is not None:
                    sdur = sa - psd
                    hs = hopst[mode]
                    hs[0] += 1
                    if sdur == 0:
                        hs[1] += 1
                    if sdur < 0:
                        hs[4] += 1
                    if pad is not None and aa is not None:
                        adur = aa - pad
                        hs[2] += 1
                        if sdur == 0:
                            hs[3] += 1
                        if 0 <= sdur <= MAX_DUR and 0 <= adur <= MAX_DUR:
                            out.write(f"H\t{mode}\t{pbp}\t{bp}\t{(psd % 86400) // 3600}\t{sdur}\t{adur}\n")
                        else:
                            skip["hop_out_of_range"] += 1
            # dwell at r: needs a next stop -> done when next row arrives; handled below via prev2
            prev = r
        # dwell: stop i with next stop i+1 (non-cancelled), both arr and dep scheduled+measured
        for i in range(len(rows) - 1):
            r, n = rows[i], rows[i + 1]
            if r[3] or n[3]:
                continue
            sa, aa, sd, ad = r[4], r[5], r[6], r[7]
            if None in (sa, aa, sd, ad):
                continue
            sdw, adw = sd - sa, ad - aa
            if 0 <= sdw <= MAX_DUR and 0 <= adw <= MAX_DUR:
                out.write(f"D\t{mode}\t{r[2]}\t{n[2]}\t{(sa % 86400) // 3600}\t{sdw}\t{adw}\n")
            else:
                skip["dwell_out_of_range"] += 1

    nrows = 0
    cur_id, cur_rows, cur_cancel_all, cur_extra = None, [], True, False
    with open(raw, encoding="utf-8", newline="") as f:
        rd = csv.reader(f, delimiter=";")
        header = next(rd)
        ix = {c: header.index(c) for c in CSV_COLS}
        iBT, iFB, iOP, iPR, iBP = (ix[c] for c in ("BETRIEBSTAG", "FAHRT_BEZEICHNER", "BETREIBER_ABK",
                                                  "PRODUKT_ID", "BPUIC"))
        iSA, iAA, iAS = ix["ANKUNFTSZEIT"], ix["AN_PROGNOSE"], ix["AN_PROGNOSE_STATUS"]
        iSD, iAD, iDS = ix["ABFAHRTSZEIT"], ix["AB_PROGNOSE"], ix["AB_PROGNOSE_STATUS"]
        iPT, iCX, iXT = ix["DURCHFAHRT_TF"], ix["FAELLT_AUS_TF"], ix["ZUSATZFAHRT_TF"]
        iSL = ix["SLOID"]
        for row in rd:
            nrows += 1
            if len(row) <= iXT:
                skip["short_row"] += 1
                continue
            jid = row[iBT] + "|" + row[iFB]
            if jid != cur_id:
                if cur_rows:
                    flush(cur_rows)
                cur_rows = []
                if jid in seen_ids:
                    reappear += 1
                seen_ids.add(jid)
                cur_id = jid
            bp = station_uic(row[iSL] if len(row) > iSL else "", row[iBP])
            if not bp.startswith("85"):
                skip["non_swiss_stop"] += 1
                continue
            if row[iPT] == "true":
                skip["pass_through"] += 1
                continue
            if row[iXT] == "true":
                skip["extra_journey_row"] += 1
                # extra journeys are dropped from hops and from the measured share
                continue
            cancelled = row[iCX] == "true"
            if cancelled:
                skip["cancelled_row"] += 1
            mode, op = mode_of(row[iPR]), row[iOP]
            prods[row[iPR]] += 1
            sa, sd = tsec(row[iSA]), tsec(row[iSD])
            a_stat, d_stat = row[iAS], row[iDS]
            aa = tsec(row[iAA]) if a_stat == "REAL" else None
            ad = tsec(row[iAD]) if d_stat == "REAL" else None
            if sa is not None:
                status[("arr", a_stat)] += 1
            if sd is not None:
                status[("dep", d_stat)] += 1
            if not cancelled:
                e = ev[(mode, op)]
                if sa is not None:
                    e[0] += 1
                    e[1] += aa is not None
                    h = hours_ev[(sa % 86400) // 3600]
                    h[0] += 1
                    h[1] += aa is not None
                if sd is not None:
                    e[2] += 1
                    e[3] += ad is not None
                    h = hours_ev[(sd % 86400) // 3600]
                    h[0] += 1
                    h[1] += ad is not None
            cur_rows.append((mode, op, bp, cancelled, sa, aa, sd, ad, None, None))
        if cur_rows:
            flush(cur_rows)
    out.close()
    os.replace(comp + ".tmp", comp)
    stats = {
        "day": day, "rows": nrows, "journey_chunks_reappearing": reappear,
        "events": {f"{m}|{o}": v for (m, o), v in ev.items()},
        "hops": dict(hopst), "skip": dict(skip),
        "status": {f"{k[0]}|{k[1]}": v for k, v in status.items()},
        "products": dict(prods), "hours": {str(k): v for k, v in hours_ev.items()},
        "download_s": round(t1 - t0, 1), "reduce_s": round(time.time() - t1, 1),
    }
    with open(statf, "w", encoding="utf-8") as f:
        json.dump(stats, f)
    if not keep_raw:
        os.remove(raw)
    return day, f"ok {nrows} rows, dl {t1 - t0:.0f}s, reduce {time.time() - t1:.0f}s"


# ---------------------------------------------------------------- stage 2: train / evaluate
def day_type(day):
    wd = dt.date.fromisoformat(day).weekday()
    return 0 if wd < 5 else (1 if wd == 5 else 2)   # weekday / Saturday / Sunday


def coarse(h):
    return 0 if h < 6 else 1 if h < 9 else 2 if h < 16 else 3 if h < 19 else 4


def read_lines(cache, day, kind):
    p = os.path.join(cache, f"{day}.{FORMAT}.tsv.gz")
    with gzip.open(p, "rt", encoding="utf-8") as f:
        for line in f:
            if line[0] == kind:
                yield line.rstrip("\n").split("\t")[1:]


def keys(a, b, h, d):
    k2 = int(a) * 100000000 + int(b)
    return k2 * 72 + d * 24 + h, k2 * 15 + d * 5 + coarse(h), k2   # hourly, coarse, pair


class Profile:
    """Collects samples then freezes to {key: median} for keys with >= MIN_N samples."""

    def __init__(self):
        self.raw = [defaultdict(lambda: array("h")) for _ in range(3)]
        self.med = None
        self.n = None

    def add(self, ks, dur):
        for r, k in zip(self.raw, ks):
            r[k].append(dur)

    def freeze(self):
        self.med = [{}, {}, {}]
        self.n = [{}, {}, {}]
        for i, r in enumerate(self.raw):
            for k in list(r):
                a = r.pop(k)
                n = len(a)
                if n < MIN_N:
                    continue
                s = sorted(a)
                m = s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2
                self.med[i][k] = round(m)
                self.n[i][k] = n
        self.raw = None

    def predict(self, ks, fallback, scheme):
        """scheme 'hourly' -> hourly, pair, fallback ; 'coarse' -> coarse, pair, fallback.
        Returns (value, level) level 0=bucket, 1=pair, 2=fallback."""
        if scheme != "pair":
            i = 0 if scheme == "hourly" else 1
            v = self.med[i].get(ks[i])
            if v is not None:
                return v, 0
        v = self.med[2].get(ks[2])
        if v is not None:
            return v, 1
        return fallback, 2


class Acc:
    """error accumulators by group"""

    def __init__(self):
        self.abs = defaultdict(lambda: array("i"))
        self.sgn = defaultdict(float)
        self.cnt = Counter()

    def add(self, groups, e):
        for g in groups:
            self.abs[g].append(abs(e))
            self.sgn[g] += e
            self.cnt[g] += 1

    @staticmethod
    def pct(sorted_arr, p):
        n = len(sorted_arr)
        return sorted_arr[min(n - 1, int(p * (n - 1) + 0.5))] if n else float("nan")

    def summary(self, g):
        a = sorted(self.abs[g])
        n = len(a)
        if not n:
            return None
        return {"n": n, "mae": sum(a) / n, "median": self.pct(a, 0.5), "p90": self.pct(a, 0.9),
                "within30": sum(1 for x in a if x <= 30) / n, "bias": self.sgn[g] / n}


def evaluate(kind, train_days, test_days, cache):
    """kind 'H' (hops) or 'D' (dwell)."""
    prof = Profile()
    t0 = time.time()
    ntrain = 0
    for day in train_days:
        d = day_type(day)
        for _m, a, b, h, sdur, adur in read_lines(cache, day, kind):
            prof.add(keys(a, b, int(h), d), int(adur))
            ntrain += 1
    prof.freeze()
    print(f"[{kind}] trained on {ntrain} samples, keys hourly={len(prof.med[0])} "
          f"coarse={len(prof.med[1])} pair={len(prof.med[2])} ({time.time() - t0:.0f}s)", flush=True)

    schemes = ["sched", "hourly", "coarse", "pair"]
    acc = {s: Acc() for s in schemes}
    levels = {s: Counter() for s in ("hourly", "coarse", "pair")}
    ntest = 0
    for day in test_days:
        d = day_type(day)
        for mode, a, b, h, sdur, adur in read_lines(cache, day, kind):
            h, sdur, adur = int(h), int(sdur), int(adur)
            ks = keys(a, b, h, d)
            if kind == "H":
                sz = "short" if sdur <= SHORT else "long"
            else:
                sz = "zero" if sdur == 0 else "pos"
            groups = ["all", "mode:" + mode, sz, f"mode:{mode}|{sz}"]
            if sdur == 0:
                groups.append("sched=0s")
                groups.append(f"mode:{mode}|sched=0s")
            acc["sched"].add(groups, sdur - adur)
            for s in ("hourly", "coarse", "pair"):
                p, lv = prof.predict(ks, sdur, s)
                levels[s][lv] += 1
                acc[s].add(groups, p - adur)
            ntest += 1
    print(f"[{kind}] evaluated {ntest} test samples", flush=True)
    return prof, acc, levels, ntrain, ntest


def fmt_table(acc, kind):
    rows = []
    groups = ["all"] + [f"mode:{m}" for m in MODES]
    groups += ["short", "long"] if kind == "H" else ["zero", "pos"]
    groups += ["sched=0s"] if kind == "H" else []
    for m in MODES:
        groups += [f"mode:{m}|short", f"mode:{m}|long", f"mode:{m}|sched=0s"] if kind == "H" else [f"mode:{m}|zero", f"mode:{m}|pos"]
    rows.append("| group | n | scheduled MAE / med / p90 | learned (hourly) MAE / med / p90 "
                "| learned (coarse) MAE / med / p90 | learned (pair only) MAE / med / p90 "
                "| within 30 s sched → hourly → pair |")
    rows.append("|---|---:|---|---|---|---|---|")
    for g in groups:
        s = {k: acc[k].summary(g) for k in acc}
        if not s["sched"]:
            continue

        def f(x):
            return f"{x['mae']:.1f} / {x['median']:.0f} / {x['p90']:.0f}"
        rows.append(f"| {g} | {s['sched']['n']} | {f(s['sched'])} | {f(s['hourly'])} | {f(s['coarse'])} "
                    f"| {f(s['pair'])} | {100 * s['sched']['within30']:.0f}% → {100 * s['hourly']['within30']:.0f}% "
                    f"→ {100 * s['pair']['within30']:.0f}% |")
    return "\n".join(rows)


def write_profile(prof, path_prefix, kind, pair_only=False):
    """compact CSV.gz: a,b,daytype,hour,n,median (daytype/hour '*' for pair-level rows)."""
    path = f"{path_prefix}_{'hop' if kind == 'H' else 'dwell'}{'_paironly' if pair_only else ''}.csv.gz"
    with gzip.open(path, "wt", encoding="utf-8", compresslevel=9) as f:
        f.write("a,b,daytype,hour,n,median_s\n")
        for k, m in sorted(prof.med[2].items()):
            f.write(f"{k // 100000000},{k % 100000000},*,*,{prof.n[2][k]},{m}\n")
        for k, m in ([] if pair_only else sorted(prof.med[0].items())):
            k2, r = divmod(k, 72)
            f.write(f"{k2 // 100000000},{k2 % 100000000},{r // 24},{r % 24},{prof.n[0][k]},{m}\n")
    return path, os.path.getsize(path)


def share_report(days, cache):
    tot = defaultdict(lambda: [0, 0, 0, 0])
    hopst = defaultdict(lambda: [0, 0, 0, 0, 0])
    skip, status, hours, perday = Counter(), Counter(), defaultdict(lambda: [0, 0]), {}
    reappear = 0
    for d in days:
        with open(os.path.join(cache, f"{d}.{FORMAT}.stats.json"), encoding="utf-8") as f:
            s = json.load(f)
        reappear += s["journey_chunks_reappearing"]
        t = [0, 0]
        for k, v in s["events"].items():
            m, o = k.split("|", 1)
            for i in range(4):
                tot[(m, o)][i] += v[i]
            t[0] += v[0] + v[2]
            t[1] += v[1] + v[3]
        perday[d] = t
        for m, v in s["hops"].items():
            for i in range(5):
                hopst[m][i] += v[i]
        skip.update(s["skip"])
        status.update(s["status"])
        for h, v in s["hours"].items():
            hours[int(h)][0] += v[0]
            hours[int(h)][1] += v[1]
    lines = []

    def share(v):
        return f"{100 * (v[1] + v[3]) / max(1, v[0] + v[2]):.1f}%"
    bymode = defaultdict(lambda: [0, 0, 0, 0])
    byop = defaultdict(lambda: [0, 0, 0, 0])
    for (m, o), v in tot.items():
        for i in range(4):
            bymode[m][i] += v[i]
            byop[o][i] += v[i]
    lines.append("| mode | stop events | measured | arrivals measured | departures measured |")
    lines.append("|---|---:|---:|---:|---:|")
    for m in MODES:
        v = bymode[m]
        if v[0] + v[2]:
            lines.append(f"| {m} | {v[0] + v[2]:,} | {share(v)} | {100 * v[1] / max(1, v[0]):.1f}% "
                         f"| {100 * v[3] / max(1, v[2]):.1f}% |")
    v = [sum(x[i] for x in bymode.values()) for i in range(4)]
    lines.append(f"| **all** | {v[0] + v[2]:,} | {share(v)} | {100 * v[1] / max(1, v[0]):.1f}% "
                 f"| {100 * v[3] / max(1, v[2]):.1f}% |")
    modes_tbl = "\n".join(lines)
    lines = ["| operator | stop events | measured | arrivals | departures |", "|---|---:|---:|---:|---:|"]
    for o, v in sorted(byop.items(), key=lambda kv: -(kv[1][0] + kv[1][2]))[:10]:
        lines.append(f"| {o} | {v[0] + v[2]:,} | {share(v)} | {100 * v[1] / max(1, v[0]):.1f}% "
                     f"| {100 * v[3] / max(1, v[2]):.1f}% |")
    ops_tbl = "\n".join(lines)
    lines = ["| mode | consecutive scheduled stop pairs | scheduled duration 0 s | "
             "pairs with both ends measured | …of those scheduled 0 s |", "|---|---:|---:|---:|---:|"]
    tt = [0] * 5
    for m in MODES:
        v = hopst[m]
        if v[0]:
            lines.append(f"| {m} | {v[0]:,} | {v[1]:,} ({100 * v[1] / v[0]:.1f}%) | {v[2]:,} | "
                         f"{v[3]:,} ({100 * v[3] / max(1, v[2]):.1f}%) |")
        for i in range(5):
            tt[i] += v[i]
    lines.append(f"| **all** | {tt[0]:,} | {tt[1]:,} ({100 * tt[1] / max(1, tt[0]):.1f}%) | {tt[2]:,} | "
                 f"{tt[3]:,} ({100 * tt[3] / max(1, tt[2]):.1f}%) |")
    hops_tbl = "\n".join(lines)
    day_tbl = "\n".join(f"| {d} | {dt.date.fromisoformat(d).strftime('%a')} | {v[0]:,} | "
                        f"{100 * v[1] / max(1, v[0]):.1f}% |" for d, v in perday.items())
    day_tbl = "| day | | stop events | measured |\n|---|---|---:|---:|\n" + day_tbl
    st = "\n".join(f"| {k.replace('|', ' ')} | {v:,} |" for k, v in sorted(status.items()))
    st = "| field / status | count (non-cancelled & cancelled, non-extra, Swiss stops) |\n|---|---:|\n" + st
    return {"modes": modes_tbl, "ops": ops_tbl, "hops": hops_tbl, "perday": day_tbl, "status": st,
            "skip": dict(skip), "reappear": reappear}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=15)
    ap.add_argument("--cache", required=True, help="directory for downloads/compact files (outside the repo)")
    ap.add_argument("--out", default=None, help="where to write results / profile (default CACHE/out)")
    ap.add_argument("--end", default=None, help="last day YYYY-MM-DD (default: latest available)")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--test-days", type=int, default=2)
    ap.add_argument("--keep-raw", action="store_true")
    ap.add_argument("--write-profile", action="store_true", help="always write the profile tables")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    cache = os.path.abspath(args.cache)
    out = os.path.abspath(args.out or os.path.join(cache, "out"))
    os.makedirs(cache, exist_ok=True)
    os.makedirs(out, exist_ok=True)

    links = discover_links()
    days = pick_days(links, args.days, args.end)
    print("days:", days[0], "…", days[-1], f"({len(days)})", flush=True)

    jobs = [(d, links[d], cache, args.keep_raw) for d in days]
    with Pool(args.workers) as pool:
        for d, msg in pool.imap_unordered(reduce_day, jobs):
            print(d, msg, flush=True)

    weekdays = [d for d in days if dt.date.fromisoformat(d).weekday() < 5]
    test_days = weekdays[-args.test_days:]
    train_days = [d for d in days if d not in test_days]
    print("train:", train_days, "\ntest:", test_days, flush=True)

    rep = share_report(days, cache)
    res = ["# computed results", f"days: {days[0]} … {days[-1]} ({len(days)}); test: {test_days}; "
           f"train: {len(train_days)} days", ""]
    res += ["## Measured share of stop events (all days)", rep["modes"], "", rep["ops"], "", rep["perday"], "",
            "## Hops with 0 s scheduled duration", rep["hops"], "", "## Status values", rep["status"], "",
            f"skipped rows: {rep['skip']}; journeys appearing in >1 block: {rep['reappear']}", ""]

    helped = False
    for kind, title in (("H", "Hop travel time (departure A → arrival B)"),
                        ("D", "Dwell time (arrival → departure at a stop)")):
        prof, acc, levels, ntrain, ntest = evaluate(kind, train_days, test_days, cache)
        res += [f"## {title}", f"train samples {ntrain:,}; test samples {ntest:,}; "
                f"abs error of predicted minus actual, seconds", "", fmt_table(acc, kind), "",
                f"prediction level used (hourly): { {k: f'{100 * v / max(1, ntest):.1f}%' for k, v in sorted(levels['hourly'].items())} } "
                f"(0=bucket, 1=pair, 2=schedule fallback); coarse: "
                f"{ {k: f'{100 * v / max(1, ntest):.1f}%' for k, v in sorted(levels['coarse'].items())} }; "
                f"pair only: { {k: f'{100 * v / max(1, ntest):.1f}%' for k, v in sorted(levels['pair'].items())} }", ""]
        s0, s1 = acc["sched"].summary("all"), acc["hourly"].summary("all")
        if s1["mae"] < 0.8 * s0["mae"] or args.write_profile:
            helped = True
            p, size = write_profile(prof, os.path.join(out, "profile"), kind)
            p2, size2 = write_profile(prof, os.path.join(out, "profile"), kind, pair_only=True)
            res += [f"profile written: {p} ({size:,} bytes); pair-only: {p2} ({size2:,} bytes)", ""]
        del prof
    text = "\n".join(res)
    with open(os.path.join(out, "results.md"), "w", encoding="utf-8") as f:
        f.write(text)
    print(text)
    if not helped:
        print("(profile not written: learned profile did not improve MAE by >20%)")


if __name__ == "__main__":
    main()
