"""How many seconds out of date is each drawn position?

Two questions:
 1. Smoothing alone: how far, in seconds, is the glided dot from the timeline it is chasing?
 2. Overall: how far, in seconds, is the dot from where newer feed data later says the vehicle was?
Positive = behind (the dot is where the vehicle was N seconds ago); negative = ahead.
"""
import os, sys
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "simulate.py")).read()
exec(src[:src.index("NAMES = [")])   # loading, trip geometry, timeline() and reference() from simulate.py

def when(times, ss, s, t):
    """Seconds between t and the moment the timeline (times, ss) is at s. None if it never is."""
    if s < ss[0] - 0.5 or s > ss[-1] + 0.5: return None
    lo = bisect.bisect_left(ss, s - 0.5); hi = bisect.bisect_right(ss, s + 0.5) - 1
    if lo <= hi:                                  # s is at a known point, possibly a dwell
        if times[lo] <= t <= times[hi]: return 0.0
        return t - times[hi] if t > times[hi] else t - times[lo]
    a, b = hi, lo                                 # s lies between two points
    if ss[b] == ss[a]: return t - times[a]
    return t - (times[a] + (times[b] - times[a]) * (s - ss[a]) / (ss[b] - ss[a]))

smooth_s, smooth_m = [], []          # question 1 (replay of the glide)
ref = {"old page (replayed)": [], "no smoothing (replayed)": [], "smoothed (replayed)": []}
trace = json.load(gzip.open(sys.argv[3], "rt", encoding="utf-8"))
browser = []
for kk, vrows in rows.items():
    T = trips[kk]; g = group[kk]; vmax = VMAX[g]
    Gs = [timeline(T, vrows, e, vmax, True) for e in range(NE)]
    ref_t, ref_s = reference(T, vrows)
    mono = all(ref_s[i] <= ref_s[i + 1] for i in range(len(ref_s) - 1))
    tgt, old, tl = [], [], []
    for n, t in enumerate(grid):
        kf, ks = k_fresh[n], k_served[n]
        rowf = vrows.get(kf) if kf >= 0 else None
        if rowf is None: tgt.append(None); tl.append(None)
        else: ge = Gs[polls[kf]["e"]]; tgt.append(ev(ge[0], ge[1], t)); tl.append(ge)
        row = vrows.get(ks); old.append(None if row is None else rowpos(T, row, t))
    d = glide(tgt, g)
    for n, t in enumerate(grid):
        if n % 3: continue
        if d[n] is not None:
            w = when(tl[n][0], tl[n][1], d[n], t)
            if w is not None and all(tl[n][1][i] <= tl[n][1][i + 1] for i in range(len(tl[n][1]) - 1)):
                smooth_s.append(w); smooth_m.append(tgt[n] - d[n])
        if mono and ref_t and ref_t[0] <= t <= ref_t[-1] and t <= REF_CUT:
            for name, series in (("old page (replayed)", old), ("no smoothing (replayed)", tgt), ("smoothed (replayed)", d)):
                if series[n] is not None:
                    w = when(ref_t, ref_s, series[n], t)
                    if w is not None: ref[name].append(w)
    a = trace.get(kk)
    if a and mono and ref_t:
        smp = a["s"]
        for i in range(0, len(smp), 12):
            t, pk, pf = smp[i], smp[i + 1], smp[i + 2]
            if not (ref_t[0] <= t <= ref_t[-1] and t <= REF_CUT and 0 <= pk < T.n - 1): continue
            w = when(ref_t, ref_s, T.S[pk] + pf * (T.S[pk + 1] - T.S[pk]), t)
            if w is not None: browser.append(w)

def line(name, xs):
    n = len(xs); ab = sorted(abs(x) for x in xs)
    q = lambda p: ab[min(n - 1, int(n * p))]
    print(f"{name:34} n={n:7}  within 5 s: {100 * sum(1 for x in xs if abs(x) <= 5) / n:5.1f}%   behind >5 s: {100 * sum(1 for x in xs if x > 5) / n:5.1f}%   ahead >5 s: {100 * sum(1 for x in xs if x < -5) / n:5.1f}%   median |offset| {q(.5):5.1f} s   p90 {q(.9):5.1f} s   p99 {q(.99):5.0f} s")

print("1. Smoothing alone: the glided dot against the timeline it is chasing")
line("  smoothed vs its own timeline", smooth_s)
am = sorted(abs(x) for x in smooth_m); print(f"     in metres: median {am[len(am) // 2]:.0f} m, p90 {am[int(len(am) * .9)]:.0f} m, p99 {am[int(len(am) * .99)]:.0f} m")
big = [x for x in smooth_s if abs(x) > 5]
print(f"     when it is more than 5 s off: median {sorted(abs(x) for x in big)[len(big) // 2]:.0f} s")
print("\n2. Overall: against where newer feed data later says the vehicle was")
for name, xs in ref.items(): line("  " + name, xs)
line("  smoothed (measured in browser)", browser)
