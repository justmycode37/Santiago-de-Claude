"""Replay a recording second by second under different drawing strategies.

Every vehicle's position is a single number: metres along its trip's path.
For each strategy we rebuild what the page would have drawn each second and
count teleports, backward moves and stalls, plus the distance from the best
later estimate of where the vehicle was.
"""
import bisect, collections, gzip, json, math, sys

rec, tripsf = sys.argv[1], sys.argv[2]
polls = []
with gzip.open(rec, "rt", encoding="utf-8") as f:
    for line in f:
        d = json.loads(line)
        if "error" not in d: polls.append(d)
trips_raw = json.load(gzip.open(tripsf, "rt", encoding="utf-8"))

feeds = []
for p in polls:
    if not feeds or feeds[-1] != p["feed"]: feeds.append(p["feed"])
    p["e"] = len(feeds) - 1
NE = len(feeds)

M = 111195.0
def dm(a, b):
    c = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((b[0] - a[0]) * c * M, (b[1] - a[1]) * M)

def shape_len(enc):
    i, lat, lon, prev, total = 0, 0, 0, None, 0.0
    while i < len(enc):
        for k in (0, 1):
            sh = r = 0
            while True:
                b = ord(enc[i]) - 63; i += 1; r |= (b & 0x1F) << sh; sh += 5
                if b < 0x20: break
            v = ~(r >> 1) if r & 1 else r >> 1
            if k == 0: lat += v
            else: lon += v
        cur = (lon / 1e5, lat / 1e5)
        if prev: total += dm(prev, cur)
        prev = cur
    return total

r5 = lambda x: math.floor(x * 1e5 + 0.5) / 1e5
GROUP = {"rail": "train", "rack": "train", "tram": "tram", "metro": "tram", "bus": "bus", "ondemand": "bus", "boat": "boat", "cableway": "cable", "funicular": "cable", "lift": "cable"}
VMAX = {"bus": 28.0, "tram": 22.0, "train": 65.0, "boat": 20.0, "cable": 15.0, "other": 30.0}   # m/s, fastest believable
VFLOOR = {"bus": 12.0, "tram": 10.0, "train": 30.0, "boat": 8.0, "cable": 6.0, "other": 10.0}   # m/s, catch-up speed always allowed
TAU = 10.0   # glide: seconds over which a gap is closed

class Trip:
    __slots__ = ("S", "coords", "sarr", "sdep", "idx", "n")
    def __init__(self, tr):
        calls = tr["calls"]; self.n = n = len(calls)
        self.coords = [(r5(c[0]), r5(c[1])) for c in calls]
        self.S = [0.0]
        for j in range(n - 1):
            seg = tr["segs"][j]
            self.S.append(self.S[-1] + (shape_len(seg) if seg else dm(self.coords[j], self.coords[j + 1])))
        self.sarr = [c[2] if c[2] is not None else c[3] for c in calls]
        self.sdep = [c[3] if c[3] is not None else c[2] for c in calls]
        self.idx = collections.defaultdict(list)
        for j, c in enumerate(self.coords): self.idx[c].append(j)

    def match(self, r):
        f, t = (r[7], r[8]), (r[9], r[10])
        if f == t:
            c = self.idx.get(f) or [j for j in range(self.n) if dm(self.coords[j], f) < 150]
            if not c: return None
            return (min(c, key=lambda j: abs(self.sdep[j] - r[12])), True)
        c = [j for j in self.idx.get(f, []) if j + 1 < self.n and self.coords[j + 1] == t]
        if not c: c = [j for j in range(self.n - 1) if dm(self.coords[j], f) < 150 and dm(self.coords[j + 1], t) < 150]
        if not c: return None
        return (min(c, key=lambda j: abs(self.sdep[j] - r[11])), False)

key = lambda r: r[0] + "|" + r[1]
trips = {k: Trip(v) for k, v in trips_raw.items() if "calls" in v and len(v["calls"]) >= 2}

# rows[vehicle][k] = (stop index, dwelling?, dep, arr)
rows = collections.defaultdict(dict); group = {}; unmatched = total_rows = 0
for k, p in enumerate(polls):
    for r in p["vehicles"]:
        kk = key(r); T = trips.get(kk); total_rows += 1
        m = T.match(r) if T else None
        if not m: unmatched += 1; continue
        rows[kk][k] = (m[0], m[1], r[11], r[12]); group[kk] = GROUP.get(r[4], "other")
print(f"polls {len(polls)}, live-feed versions {NE}, vehicles {len(rows)}, rows not placed on their trip {100 * unmatched / total_rows:.2f}%")

T0 = math.ceil(polls[0]["recv"]); T1 = math.floor(polls[-1]["recv"])
grid = list(range(T0, T1 + 1))
recvs = [p["recv"] for p in polls]; builds = [p["t"] for p in polls]
k_served = [bisect.bisect_right(recvs, t) - 1 for t in grid]            # snapshot the page holds at t
k_fresh = [bisect.bisect_right(builds, t) - 1 for t in grid]            # snapshot it would hold if delivered when built
tau5 = [T0 + 5 * ((t - T0) // 5) for t in grid]
k_tau5 = [bisect.bisect_right(builds, t) - 1 for t in tau5]
# The reference is only trusted where a later feed version has had a chance to correct it.
last_epoch_start = next(p["t"] for p in polls if p["e"] == NE - 1)
REF_CUT = last_epoch_start - 30

def ev(times, ss, t):
    i = bisect.bisect_right(times, t)
    if i == 0: return ss[0]
    if i == len(times): return ss[-1]
    return ss[i - 1] + (ss[i] - ss[i - 1]) * (t - times[i - 1]) / (times[i] - times[i - 1])

def timeline(T, vrows, e, vmax, spread):
    """The engine's schedule for one vehicle under feed version e: (times, metres)."""
    a = set()
    for k, (i, dwell, dep, arr) in vrows.items():
        if polls[k]["e"] != e: continue
        if dwell: a.add((dep, T.S[i], i, 0)); a.add((arr, T.S[i], i, 1))       # kind 0 = arrived, 1 = departed
        else: a.add((dep, T.S[i], i, 1)); a.add((arr, T.S[i + 1], i + 1, 0))
    if not a: return None
    a = sorted(a)
    t_a, _, j, kind = a[-1]
    pts = [(x[0], x[1]) for x in a]
    # Beyond what was seen: the timetable, shifted by the delay at the last known point.
    delta = t_a - (T.sdep[j] if kind else T.sarr[j]); t_run = t_a
    if not kind:
        t_run = max(t_run, T.sdep[j] + delta); pts.append((t_run, T.S[j]))
    for m in range(j + 1, min(T.n, j + 30)):
        t_run = max(t_run, T.sarr[m] + delta); pts.append((t_run, T.S[m]))
        t_run = max(t_run, T.sdep[m] + delta); pts.append((t_run, T.S[m]))
    if spread:
        # Remedy: no hop faster than believable. Borrow time from what came before it.
        out = [pts[0]]
        for q in pts[1:]:
            while len(out) >= 2 and q[1] - out[-1][1] > 1 and (q[1] - out[-1][1]) > vmax * (q[0] - out[-1][0]): out.pop()
            out.append(q)
        pts = out
    times, ss = [], []
    for t, s in pts:
        if times and t == times[-1] and s == ss[-1]: continue
        times.append(t); ss.append(s)
    return times, ss

def reference(T, vrows):
    """Best later estimate: for every stop, the times from the newest feed version that mentions it."""
    arr, dep = {}, {}
    for k in sorted(vrows):
        i, dwell, d, a = vrows[k]
        if dwell: arr[i] = d; dep[i] = a
        else: dep[i] = d; arr[i + 1] = a
    pts = []
    for j in sorted(set(arr) | set(dep)):
        if j in arr: pts.append((arr[j], T.S[j]))
        if j in dep: pts.append((dep[j], T.S[j]))
    times, ss, run = [], [], -1e18
    for t, s in pts:
        run = max(run, t)
        if times and run == times[-1] and s == ss[-1]: continue
        times.append(run); ss.append(s)
    return times, ss

def rowpos(T, row, t):
    i, dwell, dep, arr = row
    if dwell: return T.S[i]
    f = 1.0 if arr <= dep else min(1.0, max(0.0, (t - dep) / (arr - dep)))
    return T.S[i] + f * (T.S[i + 1] - T.S[i])

def glide(target, g):
    """Chase the target: close gaps over TAU seconds, never reverse, snap only when hopeless."""
    out, d, prev = [], None, None
    floor = VFLOOR[g]; vmax = VMAX[g]; snap = 60 * floor
    for x in target:
        if x is None: out.append(None); d = prev = None; continue
        if d is None: d = x
        else:
            gap = x - d
            if abs(gap) > snap: d = x
            else:
                vt = min(vmax, max(0.0, x - prev))
                v = min(max(0.0, vt + gap / TAU), max(2 * vt, floor))
                d += v
        out.append(d); prev = x
    return out

NAMES = [
    ("built",        "Page as first built (clock bug)"),
    ("now",          "Page now"),
    ("fresh10",      "Fresh snapshots, every 10 s"),
    ("fresh5",       "Fresh snapshots, every 5 s"),
    ("glide",        "Glide to corrections"),
    ("ahead",        "Next hops sent ahead"),
    ("ahead+spread", "Next hops + no impossible hops"),
    ("ahead+glide",  "Next hops + glide"),
    ("all",          "Next hops + glide + no impossible hops + fresh"),
]
stat = {n: collections.Counter() for n, _ in NAMES}
errs = {n: [] for n, _ in NAMES}; signed = {n: 0.0 for n, _ in NAMES}
by_group = {n: collections.Counter() for n, _ in NAMES}
check = []   # reconstruction check: schedule-based "now" against the row-based one

for kk, vrows in rows.items():
    T = trips[kk]; g = group[kk]; vmax = VMAX[g]
    G = [timeline(T, vrows, e, vmax, False) for e in range(NE)]
    Gs = [timeline(T, vrows, e, vmax, True) for e in range(NE)]
    ref_t, ref_s = reference(T, vrows)
    S = T.S
    tr = {n: [] for n, _ in NAMES}
    for n, t in enumerate(grid):
        ks, kf, k5 = k_served[n], k_fresh[n], k_tau5[n]
        row = vrows.get(ks)
        if row is None:
            for name in ("built", "now", "ahead", "ahead+spread"): tr[name].append(None)
        else:
            tr["built"].append(rowpos(T, row, t + builds[ks] - recvs[ks]))
            tr["now"].append(rowpos(T, row, t))
            ge = G[polls[ks]["e"]]; gse = Gs[polls[ks]["e"]]
            tr["ahead"].append(ev(ge[0], ge[1], t)); tr["ahead+spread"].append(ev(gse[0], gse[1], t))
            if n % 7 == 0:   # schedule-based redraw of "now": hold at the next stop after the snapshot's build time
                g0 = ev(ge[0], ge[1], builds[ks]); stop = S[min(len(S) - 1, bisect.bisect_left(S, g0 - 0.5))]
                check.append(abs(min(ev(ge[0], ge[1], t), stop) - tr["now"][-1]))
        rowf = vrows.get(kf) if kf >= 0 else None
        tr["fresh10"].append(None if rowf is None else rowpos(T, rowf, t))
        if rowf is None: tr["all"].append(None)
        else:
            gse = Gs[polls[kf]["e"]]; tr["all"].append(ev(gse[0], gse[1], t))
        if k5 < 0 or k5 not in vrows: tr["fresh5"].append(None)
        else:
            ge = G[polls[k5]["e"]]; g0 = ev(ge[0], ge[1], tau5[n])
            stop = S[min(len(S) - 1, bisect.bisect_left(S, g0 - 0.5))]
            tr["fresh5"].append(min(ev(ge[0], ge[1], t), stop))
    tr["glide"] = glide(tr["now"], g)
    tr["ahead+glide"] = glide(tr["ahead"], g)
    tr["all"] = glide(tr["all"], g)
    ref = [ev(ref_t, ref_s, t) if ref_t and ref_t[0] <= t <= ref_t[-1] and t <= REF_CUT else None for t in grid]
    for name, _ in NAMES:
        d = tr[name]; st = stat[name]; bg = by_group[name]
        for n in range(1, len(d)):
            a, b = d[n - 1], d[n]
            if a is None or b is None: continue
            step = b - a; st["steps"] += 1; bg[g + " steps"] += 1
            if abs(step) > vmax + 25:
                st["tele25"] += 1; bg[g] += 1
                if abs(step) > vmax + 100: st["tele100"] += 1
            if step < -5: st["back"] += 1
            r0, r1 = ref[n - 1], ref[n]
            if r1 is not None and r0 is not None:
                st["refsteps"] += 1
                if abs(step) < 0.3 and r1 - r0 > 3: st["stalled"] += 1
                if n % 5 == 0: errs[name].append(abs(b - r1)); signed[name] += b - r1

pct = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(len(xs) * p))] if xs else float("nan")
print(f"reconstruction check ('page now' rebuilt from the schedule vs the recorded rows): median {pct(check, .5):.1f} m, p90 {pct(check, .9):.1f} m, p99 {pct(check, .99):.0f} m")
print(f"\n{'strategy':48} {'jumps>25m':>10} {'>100m':>8} {'backward':>9} {'stalled':>8} {'off by':>8} {'p90':>7} {'bias':>7}")
print(f"{'':48} {'/veh-hour':>10} {'/veh-h':>8} {'/veh-h':>9} {'% time':>8} {'median m':>8} {'m':>7} {'m':>7}")
out = {}
for name, label in NAMES:
    st = stat[name]; h = st["steps"] / 3600
    e = errs[name]
    row = (st["tele25"] / h, st["tele100"] / h, st["back"] / h, 100 * st["stalled"] / max(1, st["refsteps"]), pct(e, .5), pct(e, .9), signed[name] / max(1, len(e)))
    out[name] = row
    print(f"{label:48} {row[0]:10.1f} {row[1]:8.1f} {row[2]:9.1f} {row[3]:8.1f} {row[4]:8.0f} {row[5]:7.0f} {row[6]:7.0f}")
if len(sys.argv) > 3:
    # The same measures on what a real browser drew: samples of (time, stop index, fraction of hop, odometer).
    trace = json.load(gzip.open(sys.argv[3], "rt", encoding="utf-8"))
    st = collections.Counter(); e = []; sg = 0.0; bg = collections.Counter(); placed = 0
    for kk, a in trace.items():
        g = {"rail": "train"}.get(a["g"], a["g"]); vmax = VMAX.get(g, 30.0); smp = a["s"]
        T = trips.get(kk); vrows = rows.get(kk)
        ref_t, ref_s = reference(T, vrows) if T and vrows else ([], [])
        def ref(t): return ev(ref_t, ref_s, t) if ref_t and ref_t[0] <= t <= ref_t[-1] and t <= REF_CUT else None
        for i in range(4, len(smp), 4):
            t0, t1 = smp[i - 4], smp[i]; dt = t1 - t0
            if not 0.4 < dt < 2.6: continue
            step = smp[i + 3] - smp[i - 1]; st["steps"] += dt; bg[g + " steps"] += dt
            if abs(step) > vmax * dt + 25:
                st["tele25"] += 1; bg[g] += 1
                if abs(step) > vmax * dt + 100: st["tele100"] += 1
            if step < -5: st["back"] += 1
            r0, r1 = ref(t0), ref(t1)
            if r0 is not None and r1 is not None:
                st["refsteps"] += 1
                if abs(step) < 0.3 and r1 - r0 > 3 * dt: st["stalled"] += 1
                pk, pf = smp[i + 1], smp[i + 2]
                if (i // 4) % 5 == 0 and T and 0 <= pk < T.n - 1:
                    sdraw = T.S[pk] + pf * (T.S[pk + 1] - T.S[pk]); e.append(abs(sdraw - r1)); sg += sdraw - r1
    h = st["steps"] / 3600
    row = (st["tele25"] / h, st["tele100"] / h, st["back"] / h, 100 * st["stalled"] / max(1, st["refsteps"]), pct(e, .5), pct(e, .9), sg / max(1, len(e)))
    label = "MEASURED IN THE BROWSER: all four"
    print(f"{label:48} {row[0]:10.1f} {row[1]:8.1f} {row[2]:9.1f} {row[3]:8.1f} {row[4]:8.0f} {row[5]:7.0f} {row[6]:7.0f}")
    print(f"  browser: {len(trace)} vehicles, {h:.0f} vehicle-hours, {st['tele25']} jumps over 25 m, {st['tele100']} over 100 m, {st['back']} backward moves, {len(e)} reference samples")
    print("  browser jumps over 25 m per vehicle-hour by type: " + "  ".join(f"{g} {3600 * bg[g] / max(1, bg[g + ' steps']):6.1f}" for g in ("bus", "tram", "train")))
    out["browser"] = row
print("\njumps over 25 m per vehicle-hour by type")
for name, label in NAMES:
    bg = by_group[name]
    print(f"  {label:48} " + "  ".join(f"{g} {3600 * bg[g] / max(1, bg[g + ' steps']):6.1f}" for g in ("bus", "tram", "train")))
print(f"\nvehicle-hours replayed {stat['now']['steps'] / 3600:.0f}; reference samples {len(errs['now'])}")
json.dump({"names": NAMES, "rows": out}, open(rec.replace(".jsonl.gz", "-sim.json"), "w"))
