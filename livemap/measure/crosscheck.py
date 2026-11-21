"""Second opinion on the browser run: recompute every step from the drawn stop index and
fraction (not the page's own odometer), using the trip's hop lengths."""
import collections, gzip, json, math, sys
trips_raw = json.load(gzip.open(sys.argv[1], "rt", encoding="utf-8"))   # from fetch_trips.py
trace = json.load(gzip.open(sys.argv[2], "rt", encoding="utf-8"))       # from browser_run.mjs
M = 111195.0
def dm(a, b):
    c = math.cos(math.radians((a[1] + b[1]) / 2)); return math.hypot((b[0] - a[0]) * c * M, (b[1] - a[1]) * M)
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
VMAX = {"bus": 28.0, "tram": 22.0, "rail": 65.0, "boat": 20.0, "cable": 15.0, "other": 30.0}
st = collections.Counter(); disagree = []; sizes = []; first_seen = []; spans = []
for kk, a in trace.items():
    tr = trips_raw.get(kk)
    if not tr or "calls" not in tr: st["no trip"] += 1; continue
    calls = tr["calls"]; S = [0.0]
    for j in range(len(calls) - 1):
        seg = tr["segs"][j]; S.append(S[-1] + (shape_len(seg) if seg else dm(calls[j], calls[j + 1])))
    vmax = VMAX.get(a["g"], 30.0); smp = a["s"]
    spans.append(smp[-4] - smp[0])
    def s_of(i):
        pk, pf = smp[i + 1], smp[i + 2]
        if not 0 <= pk < len(S) - 1: return S[min(max(pk, 0), len(S) - 1)]
        return S[pk] + pf * (S[pk + 1] - S[pk])
    for i in range(4, len(smp), 4):
        dt = smp[i] - smp[i - 4]
        if not 0.4 < dt < 2.6: st["gaps"] += 1; continue
        st["steps"] += dt
        a_step = smp[i + 3] - smp[i - 1]; b_step = s_of(i) - s_of(i - 4)
        if abs(b_step) > vmax * dt + 25:
            st["tele25 by position"] += 1; sizes.append(abs(b_step))
            if abs(b_step) > vmax * dt + 100: st["tele100 by position"] += 1
            if abs(a_step) <= vmax * dt + 25: st["missed by odometer"] += 1
        if abs(a_step) > vmax * dt + 25: st["tele25 by odometer"] += 1
        if b_step < -5: st["backward by position"] += 1
        if abs(b_step) < 0.3: st["not moving"] += dt
h = st["steps"] / 3600
print(f"vehicle-hours {h:.0f}; sampling gaps {st['gaps']}; vehicles without a trip {st['no trip']}")
print(f"jumps over 25 m per vehicle-hour: by drawn position {st['tele25 by position'] / h:.2f} ({st['tele25 by position']}), by the page's odometer {st['tele25 by odometer'] / h:.2f} ({st['tele25 by odometer']}); missed by the odometer {st['missed by odometer']}")
print(f"over 100 m: {st['tele100 by position'] / h:.2f}/veh-hour; backward moves over 5 m: {st['backward by position'] / h:.2f}/veh-hour ({st['backward by position']})")
sizes.sort()
if sizes: print(f"jump sizes: median {sizes[len(sizes) // 2]:.0f} m, max {sizes[-1]:.0f} m")
print(f"share of time a vehicle is not moving: {100 * st['not moving'] / st['steps']:.1f}%")
