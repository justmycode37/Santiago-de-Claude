"""How close are the official building address points (tools/gebaeudeadressen.py) to the doors OpenStreetMap maps?
Per city around the main station: the share of address points on a building outline, and for OSM doors that carry an
address, the distance to that address's register point, as given and snapped onto the outline.
usage: python register_check.py   (after tools/build_walkgraph.py has built the cities)"""
import sys, os, json, math, glob
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')); sys.path.insert(0, os.path.join(REPO, 'tools'))
import gebaeudeadressen
AREAS = {'bern': (7.36, 46.92, 7.50, 46.98), 'zurich': (8.45, 47.32, 8.62, 47.44), 'basel': (7.54, 47.52, 7.64, 47.59),
         'geneva': (6.08, 46.17, 6.20, 46.24), 'lausanne': (6.57, 46.50, 6.68, 46.56)}
C = {'bern': (7.43935, 46.94884), 'zurich': (8.54035, 47.37790), 'basel': (7.58945, 47.54800), 'geneva': (6.14240, 46.21010), 'lausanne': (6.62900, 46.51700)}
pts = {}
for c, (cx, cy) in C.items():
    pts[c] = [(lon, lat, addr) for lon, lat, _, addr in gebaeudeadressen.points((cx - 0.02, cy - 0.015, cx + 0.02, cy + 0.015))]
def tiles_near(c):
    cx, cy = C[c]
    for fn in glob.glob(os.path.join(REPO, 'walkgraph/t/*.js')):
        k = os.path.basename(fn)[:-3]; y, x = map(int, k.split('_'))
        if abs(x / 100 + .005 - cx) < 0.03 and abs(y / 100 + .005 - cy) < 0.025:
            t = open(fn, encoding='utf-8').read(); yield json.loads(t[t.index(',') + 1:t.rindex(')')])
for c in AREAS:
    blds = {}; ents = []
    for t in tiles_near(c):
        ox, oy = t['o']; nodes = []; i = x = y = 0
        for k in range(0, len(t['n']), 3):
            i += t['n'][k]; x += t['n'][k + 1]; y += t['n'][k + 2]; nodes.append(((ox + x) / 1e6, (oy + y) / 1e6))
        for row in t['b']:
            x, y = ox + row[1], oy + row[2]; ring = [(x / 1e6, y / 1e6)]
            for j in range(3, len(row), 2): x += row[j]; y += row[j + 1]; ring.append((x / 1e6, y / 1e6))
            blds[row[0]] = ring
        for e in t['e']:
            if e[2] != 'addr': ents.append((nodes[e[0]], e[4]))  # OSM doors only
    kx = 111320 * math.cos(math.radians(C[c][1])); ky = 110540
    grid = {}
    for bid, ring in blds.items():
        xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
        for gx in range(int(min(xs) / .0005), int(max(xs) / .0005) + 1):
            for gy in range(int(min(ys) / .0005), int(max(ys) / .0005) + 1): grid.setdefault((gx, gy), []).append(bid)
    def near(lon, lat):  # the buildings in the point's grid cell and the eight around it
        gx, gy = int(lon / .0005), int(lat / .0005)
        return {b for x in (gx - 1, gx, gx + 1) for y in (gy - 1, gy, gy + 1) for b in grid.get((x, y), ())}
    def inside(p, ring):
        cc = False
        for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
            if (y1 > p[1]) != (y2 > p[1]) and p[0] < (x2 - x1) * (p[1] - y1) / (y2 - y1) + x1: cc = not cc
        return cc
    def snap(p, ring):
        best = (1e9, p)
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            ax, ay = (x1 - p[0]) * kx, (y1 - p[1]) * ky; dx, dy = (x2 - x1) * kx, (y2 - y1) * ky
            L = dx * dx + dy * dy; tt = max(0, min(1, -(ax * dx + ay * dy) / L)) if L else 0
            d = math.hypot(ax + dx * tt, ay + dy * tt)
            if d < best[0]: best = (d, (x1 + (x2 - x1) * tt, y1 + (y2 - y1) * tt))
        return best
    def edge_d(p, ring):
        best = 1e9
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            ax, ay = (x1 - p[0]) * kx, (y1 - p[1]) * ky; dx, dy = (x2 - x1) * kx, (y2 - y1) * ky
            L = dx * dx + dy * dy; tt = max(0, min(1, -(ax * dx + ay * dy) / L)) if L else 0
            best = min(best, math.hypot(ax + dx * tt, ay + dy * tt))
        return best
    dins, dout, none = [], [], 0
    for lon, lat, _ in pts[c]:
        cand = near(lon, lat)
        ds = [(edge_d((lon, lat), blds[b]), inside((lon, lat), blds[b])) for b in cand]
        if not ds: none += 1; continue
        d, ins = min(ds)
        (dins if ins else dout).append(d)
    n = len(pts[c]); q = lambda xs, p: sorted(xs)[int(len(xs) * p)] if xs else None
    within = sum(1 for d in dins + dout if d <= 2)
    print(f"{c:9} register points {n:5}: inside a building {len(dins)} (depth median {q(dins,.5):.1f} m, p90 {q(dins,.9):.1f}), outside {len(dout)} (median {q(dout,.5):.1f} m), no building near {none}; within 2 m of an outline {within / n:.0%}")
    # against OSM entrances with an address
    reg = {}
    for lon, lat, a in pts[c]: reg.setdefault(a, []).append((lon, lat))
    dd = []; ds = []
    def snapped(p):
        cand = near(*p)
        best = min((snap(p, blds[b]) for b in cand), default=(1e9, p))
        return best[1] if best[0] < 12 else p
    for (lon, lat), a in ents:
        if a in reg:
            dd.append(min(math.hypot((lon - p[0]) * kx, (lat - p[1]) * ky) for p in reg[a]))
            ds.append(min(math.hypot((lon - q[0]) * kx, (lat - q[1]) * ky) for q in map(snapped, reg[a])))
    if ds: print(f"          snapped to the outline: median {q(ds,.5):.1f} m, p75 {q(ds,.75):.1f}, p90 {q(ds,.9):.1f}; within 5 m {sum(d<=5 for d in ds)/len(ds):.0%}")
    if dd: print(f"          OSM entrances with address {len(dd)}: register point at median {q(dd,.5):.1f} m, p75 {q(dd,.75):.1f}, p90 {q(dd,.9):.1f}; within 5 m {sum(d<=5 for d in dd)/len(dd):.0%}")
