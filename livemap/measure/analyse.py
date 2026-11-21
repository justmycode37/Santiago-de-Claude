"""How much do vehicles jump when the page swaps in a new snapshot?

A jump is the distance between where a vehicle is drawn the instant before a
new snapshot arrives and where it is drawn the instant after.
"""
import collections, gzip, json, math, sys

path = sys.argv[1]
polls, shapes = [], {}
try:
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            d = json.loads(line)
            if "error" in d:
                print("poll error:", d["error"]); continue
            for k, v in d["shapes"].items():
                shapes[int(k)] = v
            polls.append(d)
except EOFError:
    pass  # still being written

def decode(enc):
    xy, i, lat, lon = [], 0, 0, 0
    while i < len(enc):
        for k in (0, 1):
            sh = r = 0
            while True:
                b = ord(enc[i]) - 63; i += 1; r |= (b & 0x1F) << sh; sh += 5
                if b < 0x20: break
            v = ~(r >> 1) if r & 1 else r >> 1
            if k == 0: lat += v
            else: lon += v
        xy.append((lon / 1e5, lat / 1e5))
    return xy

M = 111195.0
def dm(a, b):
    c = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((b[0] - a[0]) * c * M, (b[1] - a[1]) * M)

dec = {}
def shape(i):
    s = dec.get(i)
    if s is None:
        xy = decode(shapes[i]); cum = [0.0]
        for j in range(1, len(xy)): cum.append(cum[-1] + dm(xy[j - 1], xy[j]))
        s = dec[i] = (xy, cum)
    return s

# row: 0 trip 1 date 2 line 3 cat 4 mode 5 op 6 headsign 7 fx 8 fy 9 tx 10 ty 11 dep 12 arr 13 next 14 live 15 shape
def frac(r, t):
    span = r[12] - r[11]
    return 1.0 if span <= 0 else min(1.0, max(0.0, (t - r[11]) / span))

def hop_len(r):
    if r[15] and r[15] in shapes: return shape(r[15])[1][-1]
    return dm((r[7], r[8]), (r[9], r[10]))

def pos(r, t):
    f = frac(r, t)
    if r[15] and r[15] in shapes:
        xy, cum = shape(r[15]); target = f * cum[-1]
        lo, hi = 0, len(xy) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if cum[mid] <= target: lo = mid
            else: hi = mid
        seg = cum[hi] - cum[lo]; u = (target - cum[lo]) / seg if seg > 0 else 0
        return (xy[lo][0] + (xy[hi][0] - xy[lo][0]) * u, xy[lo][1] + (xy[hi][1] - xy[lo][1]) * u)
    return (r[7] + (r[9] - r[7]) * f, r[8] + (r[10] - r[8]) * f)

GROUP = {"rail": "train", "rack": "train", "tram": "tram", "metro": "tram", "bus": "bus", "ondemand": "bus", "boat": "boat", "cableway": "cable", "funicular": "cable", "lift": "cable"}
THRESH = (25, 100, 500)
key = lambda r: r[0] + "|" + r[1]

def pct(xs, p):
    xs = sorted(xs); return xs[min(len(xs) - 1, int(len(xs) * p))] if xs else 0

print(f"polls {len(polls)}  span {(polls[-1]['recv'] - polls[0]['recv']) / 60:.1f} min  vehicles per poll ~{sum(len(p['vehicles']) for p in polls) // len(polls)}")
ages = [p["recv"] - p["t"] for p in polls]
print(f"snapshot age when the page receives it: median {pct(ages, .5):.1f} s, min {min(ages):.1f}, max {max(ages):.1f}")
feed_age = [p["recv"] - p["feed"] for p in polls if p["feed"]]
print(f"live feed age when received: median {pct(feed_age, .5):.0f} s, min {min(feed_age):.0f}, max {max(feed_age):.0f}")
offs = [p["t"] - p["recv"] for p in polls]
print(f"page clock offset changes between polls: median |Δ| {pct([abs(offs[i] - offs[i-1]) for i in range(1, len(offs))], .5):.2f} s, max {max(abs(offs[i] - offs[i-1]) for i in range(1, len(offs))):.2f} s")

def summarise(name, jumps):
    """jumps: list of (metres, group)."""
    n = len(jumps)
    ms = [j[0] for j in jumps]
    line = f"{name:44} n={n:6}  " + "  ".join(f">{t} m: {100 * sum(1 for m in ms if m > t) / n:5.2f}%" for t in THRESH) + f"  p99 {pct(ms, .99):6.0f} m  max {max(ms):6.0f} m"
    print(line)

# Scenario A: the page as first built (its clock is reset from each snapshot's build time).
# B: true clock, snapshots as stale as they were served.
# C: true clock, each snapshot applied the moment it was built (no stale copy).
A, B, C = [], [], []
causes = collections.defaultdict(list)      # scenario C, by cause
cause_feed = collections.Counter()          # (cause, feed changed) → jumps over 25 m
shift_s = collections.defaultdict(list)     # seconds of schedule shift behind each jump over 25 m
overrun_B = collections.Counter()
by_group = collections.defaultdict(list)    # scenario C
by_feed = {True: [], False: []}
overrun = collections.Counter(); seen = 0
signed = []                                  # along-path signed jump for same-hop revisions
appear = disappear = 0
veh_minutes = 0.0
for k in range(1, len(polls)):
    p0, p1 = polls[k - 1], polls[k]
    r0 = {key(r): r for r in p0["vehicles"]}; r1 = {key(r): r for r in p1["vehicles"]}
    appear += len(r1.keys() - r0.keys()); disappear += len(r0.keys() - r1.keys())
    off0, off1 = p0["t"] - p0["recv"], p1["t"] - p1["recv"]
    tA0, tA1 = p1["recv"] + off0, p1["recv"] + off1
    tB = p1["recv"]                 # true time at the swap
    tC = p1["t"]                    # swap at the moment the new snapshot was built
    feed_changed = p1["feed"] != p0["feed"]
    veh_minutes += len(r1) * (p1["recv"] - p0["recv"]) / 60
    for kk, a in r0.items():
        b = r1.get(kk)
        if not b: continue
        g = GROUP.get(a[4], "other")
        A.append((dm(pos(a, tA0), pos(b, tA1)), g))
        B.append((dm(pos(a, tB), pos(b, tB)), g))
        j = dm(pos(a, tC), pos(b, tC))
        C.append((j, g)); by_group[g].append((j, g)); by_feed[feed_changed].append((j, g))
        seen += 1
        moving_a = (a[7], a[8]) != (a[9], a[10])
        if moving_a and tC > a[12]: overrun[g] += 1
        if moving_a and tB > a[12]: overrun_B[g] += 1
        same_hop = a[7:11] == b[7:11]
        if same_hop:
            if a[11] == b[11] and a[12] == b[12]:
                cause = "same hop, shape changed" if a[15] != b[15] else "no change"
            else:
                cause = "same hop, times revised"
                if moving_a: signed.append(((frac(b, tC) - frac(a, tC)) * hop_len(a), g))
        elif (b[7], b[8]) == (a[9], a[10]):
            cause = "moved on to the next hop or stop"
        elif (b[9], b[10]) == (a[7], a[8]):
            cause = "sent back to the previous hop or stop"
        else:
            cause = "skipped ahead or re-routed"
        causes[cause].append((j, g))
        if j > 25:
            cause_feed[(cause, feed_changed)] += 1
            ref = b if (b[7], b[8]) != (b[9], b[10]) else a
            span = ref[12] - ref[11]; L = hop_len(ref)
            if span > 0 and L > 1: shift_s[cause].append(j / (L / span))

print(f"\nvehicle-updates compared: {seen}   appeared {appear}  disappeared {disappear}")
print("\nShare of updates where the vehicle jumps, by how the page handles time")
summarise("A  page as built (clock from snapshot)", A)
summarise("B  true clock, snapshots as served (stale)", B)
summarise("C  true clock, snapshot applied when built", C)

print("\nScenario C by vehicle type")
for g, js in sorted(by_group.items(), key=lambda x: -len(x[1])): summarise("  " + g, js)
print("\nScenario C: polls where the live feed had just changed vs not")
summarise("  feed changed", by_feed[True]); summarise("  feed unchanged", by_feed[False])

print("\nScenario C by cause (share of all updates, and jumps within the cause)")
tot_big = sum(1 for j in C if j[0] > 25)
for cause, js in sorted(causes.items(), key=lambda x: -len(x[1])):
    big = sum(1 for j in js if j[0] > 25)
    ms = [j[0] for j in js]
    print(f"  {cause:40} {100 * len(js) / seen:5.1f}% of updates   >25 m: {big:6} ({100 * big / max(1, tot_big):4.1f}% of all >25 m jumps)   median {pct(ms, .5):5.0f} m  p90 {pct(ms, .9):6.0f} m  max {max(ms):6.0f} m")

print("\nJumps over 25 m (scenario C) by cause and whether the live feed had just changed")
for cause in causes:
    y, n = cause_feed[(cause, True)], cause_feed[(cause, False)]
    if y + n: print(f"  {cause:40} feed changed {y:6}   feed unchanged {n:6}   time-equivalent median {pct(shift_s[cause], .5):4.0f} s  p90 {pct(shift_s[cause], .9):4.0f} s")
fw = [s for s in signed if s[0] > 25]; bw = [s for s in signed if s[0] < -25]
print(f"\nTime revisions on the same hop: {len(signed)}; forward >25 m: {len(fw)}, backward >25 m: {len(bw)}")
if bw: print(f"  backward: median {pct([-s[0] for s in bw], .5):.0f} m, p90 {pct([-s[0] for s in bw], .9):.0f} m")
if fw: print(f"  forward:  median {pct([s[0] for s in fw], .5):.0f} m, p90 {pct([s[0] for s in fw], .9):.0f} m")

print(f"\nJumps over 25 m per vehicle per hour:  A {60 * sum(1 for j in A if j[0] > 25) / veh_minutes:.1f}   B {60 * sum(1 for j in B if j[0] > 25) / veh_minutes:.1f}   C {60 * sum(1 for j in C if j[0] > 25) / veh_minutes:.1f}")
print(f"Jumps over 100 m per vehicle per hour: A {60 * sum(1 for j in A if j[0] > 100) / veh_minutes:.1f}   B {60 * sum(1 for j in B if j[0] > 100) / veh_minutes:.1f}   C {60 * sum(1 for j in C if j[0] > 100) / veh_minutes:.1f}")
print("Waiting at the end of a hop when the swap comes (scenario B): " + ", ".join(f"{g} {100 * n / max(1, len(by_group[g])):.1f}%" for g, n in overrun_B.most_common()))
print("Waiting at the end of a hop for new data when the swap comes (scenario C): " + ", ".join(f"{g} {100 * n / max(1, len(by_group[g])):.1f}%" for g, n in overrun.most_common()))

# Hops whose own times are implausible, whatever the page does.
hops = {}
for p in polls:
    for r in p["vehicles"]:
        if (r[7], r[8]) != (r[9], r[10]): hops[(key(r), r[7], r[8], r[9], r[10], r[11], r[12])] = r
LIMIT = {"bus": 28, "tram": 22, "train": 65, "boat": 20, "cable": 15}
zero = collections.Counter(); fast = collections.Counter(); n_by = collections.Counter(); minute = collections.Counter()
for r in hops.values():
    g = GROUP.get(r[4], "other"); st = ("live" if r[14] else "timetable")
    n_by[(g, st)] += 1
    span = r[12] - r[11]
    if span % 60 == 0: minute[(g, st)] += 1
    if span <= 0: zero[(g, st)] += 1
    elif g in LIMIT and hop_len(r) / span > LIMIT[g]: fast[(g, st)] += 1
print("\nHops with impossible timing (distinct hop × timing seen)")
for (g, st), n in sorted(n_by.items(), key=lambda x: -x[1]):
    print(f"  {g:6} {st:9} n={n:6}  zero or negative duration {100 * zero[(g, st)] / n:5.1f}%   faster than {LIMIT.get(g, 0) * 3.6:.0f} km/h {100 * fast[(g, st)] / n:5.1f}%   whole-minute duration {100 * minute[(g, st)] / n:5.1f}%")
