#!/usr/bin/env python3
"""Find the way across ground no map has a path for, on swisstopo's aerial photo (SWISSIMAGE).

For the last stretch of a walk that leaves every mapped path (a farm reached by an unmapped track, a yard, a hilltop),
walkroute.js can only draw a straight dashed line. This looks at the aerial photo instead:

  1. SWISSIMAGE around the stretch, 0.25 m per pixel (swisstopo's open WMS).
  2. DINOv2-small (the image model Scan already uses) describes every 3.5 m patch of the photo with 384 numbers.
  3. A small classifier learns, from this photo alone, what walkable ground looks like here: patches on paths and
     roads the map already has are "walkable", patches far from any are "other". No hand labels; every photo teaches
     itself, so light, season and region do not matter.
  4. A cost map: cheap where the photo looks like a path or track, dear across fields and forest, impossible through
     buildings and across railway tracks on the ground (both from the walk graph).
  5. The cheapest way from the destination to the mapped network (Dijkstra on the patch grid), smoothed.

The model never draws coordinates itself: it only scores the ground; the path is found by search. The answer says how
much of it runs over ground that looks like a path ("seen on the aerial photo"), and how much is a plain guess.

Under trees the photo shows crowns, not paths: those patches never teach the model and never count as seen.

Status: a prototype, not used by the app yet. Tried on six walks that end off every mapped path: it finds an unmapped
farm track and a yard's access road, follows a field edge, and can do nothing in forest. Needs numpy, scipy,
onnxruntime, pillow, and the DINOv2 file Scan downloads (~/.cache/stopvision/model_quantized.onnx). About 2-10 s per
walk on a laptop at 0.25 m per pixel with two passes; cheaper settings (AERIAL_MPP=0.35 AERIAL_PASSES=1) are faster but
choose worse ways.

  python3 tools/aerial_path.py --dest 7.0012,47.1234 [--from lon,lat] [--graph walkgraph] [--png out.png]
"""
import argparse, heapq, json, math, os, sys, urllib.parse, urllib.request

import numpy as np
from PIL import Image, ImageDraw

MODEL = os.path.join(os.path.expanduser('~'), '.cache', 'stopvision', 'model_quantized.onnx')  # DINOv2-small, int8
CACHE = os.path.join(os.path.expanduser('~'), '.cache', 'walkgraph', 'aerial')
UA = {'User-Agent': 'santiago-de-claude-aerial/1.0 (SWISSIMAGE, cached)'}
MPP = float(os.environ.get('AERIAL_MPP', 0.25))  # metres per pixel of the photo
PASSES = int(os.environ.get('AERIAL_PASSES', 2))  # 2: a second pass with the windows shifted by half (no seams)
PATCH = 14          # DINOv2 patch, pixels → 3.5 m
WIN = 518           # model window, pixels (37 × 37 patches)
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


# ------------------------------------------------------------------ the photo

def fetch_ortho(box, mpp=MPP):
    """SWISSIMAGE for box = (lon0, lat0, lon1, lat1) at about mpp metres per pixel → PIL image (cached)."""
    lat = (box[1] + box[3]) / 2
    w = round((box[2] - box[0]) * 111320 * math.cos(math.radians(lat)) / mpp)
    h = round((box[3] - box[1]) * 110540 / mpp)
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, 'o_%.6f_%.6f_%.6f_%.6f_%d.jpg' % (*box, w))
    if not os.path.exists(path):
        q = {'SERVICE': 'WMS', 'VERSION': '1.3.0', 'REQUEST': 'GetMap', 'LAYERS': 'ch.swisstopo.swissimage', 'STYLES': '',
             'CRS': 'EPSG:4326', 'BBOX': f'{box[1]},{box[0]},{box[3]},{box[2]}', 'WIDTH': w, 'HEIGHT': h, 'FORMAT': 'image/jpeg'}
        req = urllib.request.Request('https://wms.geo.admin.ch/?' + urllib.parse.urlencode(q), headers=UA)
        data = urllib.request.urlopen(req, timeout=180).read()
        with open(path + '.part', 'wb') as f:
            f.write(data)
        os.replace(path + '.part', path)
    return Image.open(path).convert('RGB')


_session = None


def features(img):
    """DINOv2 features of every 14-pixel patch → array (rows, cols, 384), L2-normalised.

    Run twice, the second time with the windows shifted by half a window, and averaged: a patch near the edge of one
    window is in the middle of the other, so there are no seams where windows meet."""
    global _session
    if _session is None:
        import onnxruntime as ort
        _session = ort.InferenceSession(MODEL, providers=['CPUExecutionProvider'])
    a = (np.asarray(img, np.float32) / 255 - MEAN) / STD
    H, W = a.shape[:2]
    rows, cols = H // PATCH, W // PATCH
    n = WIN // PATCH
    out = np.zeros((rows, cols, 384), np.float32)
    cnt = np.zeros((rows, cols, 1), np.float32)
    for shift in (0, n // 2)[:PASSES]:
        starts_y = sorted({0, *range(shift, rows, n)} - {rows})
        starts_x = sorted({0, *range(shift, cols, n)} - {cols})
        for y0 in starts_y:
            for x0 in starts_x:
                r1, c1 = min(rows, y0 + n), min(cols, x0 + n)
                win = a[y0 * PATCH:r1 * PATCH, x0 * PATCH:c1 * PATCH]
                tok = _session.run(None, {_session.get_inputs()[0].name: win.transpose(2, 0, 1)[None]})[0][0, 1:]
                out[y0:r1, x0:c1] += tok.reshape(r1 - y0, c1 - x0, 384)
                cnt[y0:r1, x0:c1] += 1
    out /= np.maximum(cnt, 1)
    out /= np.linalg.norm(out, axis=2, keepdims=True) + 1e-6
    return out


def canopy(img, rows, cols):
    """Patches that look like tree crowns (dark, green above red and blue, rough): a path under them cannot be seen."""
    a = np.asarray(img, np.float32)[:rows * PATCH, :cols * PATCH] / 255
    blk = a.reshape(rows, PATCH, cols, PATCH, 3)
    m = blk.mean(axis=(1, 3))
    rough = blk.mean(axis=3).std(axis=(1, 3))
    bright = m.mean(axis=2)
    greenish = (m[..., 1] > m[..., 0] + 0.02) & (m[..., 1] >= m[..., 2])
    return greenish & (bright < 0.30) & (rough > 0.035)


# ------------------------------------------------------------------ the walk graph (tiles from tools/build_walkgraph.py)

def read_graph(folder, box):
    """Walkable ways [(coords, attrs)], building outlines, ground-level tracks in the tiles that meet box."""
    ways, blds, rails, seen = [], [], [], set()
    for f in os.listdir(os.path.join(folder, 't')):
        ty, tx = map(int, f[:-3].split('_'))
        if (tx + 1) / 100 < box[0] or tx / 100 > box[2] or (ty + 1) / 100 < box[1] or ty / 100 > box[3]:
            continue
        s = open(os.path.join(folder, 't', f), encoding='utf-8').read()
        d = json.loads(s[s.index(',') + 1:s.rindex(')')])
        ox, oy = d['o']
        i = x = y = 0
        ll = []
        for k in range(0, len(d['n']), 3):
            i += d['n'][k]; x += d['n'][k + 1]; y += d['n'][k + 2]
            ll.append(((ox + x) / 1e6, (oy + y) / 1e6))
        ids = []
        i = 0
        for k in range(0, len(d['n']), 3):
            i += d['n'][k]
            ids.append(i)
        for w in d['w']:
            if w[0] not in seen:
                seen.add(w[0])
                ways.append(([ll[n] for n in w[2:]], d['a'][w[1]], [ids[n] for n in w[2:]]))
        for b in d['b']:
            x, y = ox + b[1], oy + b[2]
            ring = [(x / 1e6, y / 1e6)]
            for k in range(3, len(b), 2):
                x += b[k]; y += b[k + 1]
                ring.append((x / 1e6, y / 1e6))
            blds.append(ring)
        for fl in d.get('z', []):
            rails.append([((ox + fl[k]) / 1e6, (oy + fl[k + 1]) / 1e6) for k in range(0, len(fl), 2)])
    return ways, blds, rails


# ------------------------------------------------------------------ learning what walkable ground looks like here

def train_probe(F, pos, neg, iters=400, lam=1e-3):
    """Logistic regression on patch features (numpy, class-balanced) → weights, bias."""
    X = np.concatenate([F[pos], F[neg]])
    y = np.concatenate([np.ones(pos.sum()), np.zeros(neg.sum())]).astype(np.float32)
    wts = np.where(y == 1, 0.5 / max(1, pos.sum()), 0.5 / max(1, neg.sum())).astype(np.float32)
    w = np.zeros(X.shape[1], np.float32)
    b = 0.0
    lr = 4.0
    for _ in range(iters):
        p = 1 / (1 + np.exp(-(X @ w + b)))
        g = p - y
        w -= lr * ((X.T @ (g * wts)) + lam * w)
        b -= lr * float((g * wts).sum())
    return w, b


# ------------------------------------------------------------------ the search

def find_path(dest, graph='walkgraph', half=None, net_hint=None, debug_png=None):
    """The cheapest way from dest = (lon, lat) to the mapped network across the aerial photo.

    net_hint: (lon, lat) where the router's walk leaves the network now (the area is chosen to hold both).
    → { coords: [(lon, lat)...] from the network to dest, join: (lon, lat), metres, seen: metres over ground that looks
        like a path, guess: metres over other ground, score } or None.
    """
    lon, lat = dest
    kx, ky = 111320 * math.cos(math.radians(lat)), 110540
    reach = 300 if net_hint is None else max(80, math.hypot((net_hint[0] - lon) * kx, (net_hint[1] - lat) * ky) * 1.6 + 60)
    half = half or min(450, reach)
    box = (lon - half / kx, lat - half / ky, lon + half / kx, lat + half / ky)
    img = fetch_ortho(box)
    F = features(img)
    rows, cols = F.shape[:2]
    trees = canopy(img, rows, cols)
    W, H = img.size
    # patch centres in lon/lat and local metres
    cx = box[0] + (np.arange(cols) + .5) * PATCH / W * (box[2] - box[0])
    cy = box[3] - (np.arange(rows) + .5) * PATCH / H * (box[3] - box[1])
    to_cell = lambda p: (int((box[3] - p[1]) / (box[3] - box[1]) * H / PATCH), int((p[0] - box[0]) / (box[2] - box[0]) * W / PATCH))

    ways, blds, rails = read_graph(graph, box)
    # mapped paths on the patch grid: distance (in metres) from each patch centre to the nearest walkable way
    cell_m = PATCH * MPP
    to_m = cell_m  # metres per grid step
    on_way = np.zeros((rows, cols), bool)
    ground_ways = [(cs, a, ids) for cs, a, ids in ways if not a.get('c') and not a.get('y') and a.get('k') not in ('ar', 'el', 'es')]
    # the network the walk can reach: the connected piece of the graph nearest where the route leaves it now (or the
    # largest piece); a path that joins nothing (a swisstopo fragment) teaches the model but is no place to arrive at
    parent = {}
    def find(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for cs, a, ids in ways:
        for u in ids[1:]:
            parent[find(u)] = find(ids[0])
    size = {}
    for cs, a, ids in ways:
        size[find(ids[0])] = size.get(find(ids[0]), 0) + len(ids)
    main = None
    if net_hint is not None:
        near = min(ways, key=lambda w: min(math.hypot((p[0] - net_hint[0]) * kx, (p[1] - net_hint[1]) * ky) for p in w[0]))
        main = find(near[2][0])
    reach_cell = np.zeros((rows, cols), bool)
    piece_cells = {}  # without a hint: the piece with the most of its ways in this area
    for cs, a, ids in ground_ways:
        reachable = main is None or find(ids[0]) == main
        piece = find(ids[0])
        for p, q in zip(cs, cs[1:]):
            L = math.hypot((q[0] - p[0]) * kx, (q[1] - p[1]) * ky)
            for k in range(int(L / 1.0) + 1):
                t = k / max(1, int(L / 1.0))
                r, c = to_cell((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
                if 0 <= r < rows and 0 <= c < cols:
                    on_way[r, c] = True
                    if reachable:
                        piece_cells.setdefault(piece, []).append((r, c))
    if piece_cells:
        best = main if main is not None else max(piece_cells, key=lambda k: len(set(piece_cells[k])))
        for r, c in piece_cells.get(best, ()):
            reach_cell[r, c] = True
    # near a way (for negatives: far from every way)
    from scipy.ndimage import distance_transform_edt  # noqa
    dist = distance_transform_edt(~on_way) * cell_m
    blocked = np.zeros((rows, cols), bool)
    mask = Image.new('L', (cols, rows), 0)
    md = ImageDraw.Draw(mask)
    def inside(pt, ring):
        c = False
        for i in range(len(ring)):
            (x1, y1), (x2, y2) = ring[i], ring[i - 1]
            if (y1 > pt[1]) != (y2 > pt[1]) and pt[0] < (x2 - x1) * (pt[1] - y1) / (y2 - y1) + x1:
                c = not c
        return c
    for ring in blds:
        if inside(dest, ring):
            continue  # the building you are going to: you walk into it
        pts = [(to_cell(p)[1] + .5, to_cell(p)[0] + .5) for p in ring]
        if len(pts) > 2:
            md.polygon(pts, fill=1)
    blocked |= np.asarray(mask, bool)
    rmask = Image.new('L', (cols, rows), 0)
    rd = ImageDraw.Draw(rmask)
    for line in rails:
        rd.line([(to_cell(p)[1] + .5, to_cell(p)[0] + .5) for p in line], fill=1, width=2)
    blocked |= np.asarray(rmask, bool)
    # learn: on mapped ways = walkable; 15 m or more from any way, and not a building = other ground
    pos = on_way & ~blocked & ~trees  # a mapped path under trees shows the trees, not the path: not a lesson
    neg = (dist >= 15) & ~blocked
    if os.environ.get('AERIAL_DEBUG'):
        print(f'  grid {rows}x{cols}, walkable cells {int(pos.sum())}, other {int(neg.sum())}, reachable network cells '
              f'{int(reach_cell.sum())}, blocked {int(blocked.sum())}', file=sys.stderr)
    if pos.sum() < 20 or neg.sum() < 20:
        return None
    w, b = train_probe(F, pos, neg)
    p = 1 / (1 + np.exp(-(F @ w + b)))
    p[trees] = np.minimum(p[trees], 0.35)  # under trees the photo cannot show a path
    p[on_way] = np.maximum(p[on_way], 0.9)  # mapped ways are walkable whatever the photo says
    # cost per metre: 1 on path-like ground, up to 8 across fields and forest
    cost = 1 + 7 * (1 - p) ** 2
    cost[blocked] = np.inf
    # Dijkstra from the destination's cell to the first cell on a mapped way (8 neighbours)
    sr, sc = to_cell(dest)
    if not (0 <= sr < rows and 0 <= sc < cols):
        return None
    cost[max(0, sr - 1):sr + 2, max(0, sc - 1):sc + 2] = np.minimum(cost[max(0, sr - 1):sr + 2, max(0, sc - 1):sc + 2], 8)  # you leave the place itself
    D = np.full((rows, cols), np.inf)
    prev = {}
    D[sr, sc] = 0
    heap = [(0.0, sr, sc)]
    end = None
    steps = [(-1, 0, 1), (1, 0, 1), (0, -1, 1), (0, 1, 1), (-1, -1, 1.414), (-1, 1, 1.414), (1, -1, 1.414), (1, 1, 1.414)]
    while heap:
        d, r, c = heapq.heappop(heap)
        if d > D[r, c]:
            continue
        if reach_cell[r, c] and (r, c) != (sr, sc):
            end = (r, c)
            break
        for dr, dc, k in steps:
            rr, cc = r + dr, c + dc
            if 0 <= rr < rows and 0 <= cc < cols and np.isfinite(cost[rr, cc]):
                nd = d + k * cell_m * (cost[r, c] + cost[rr, cc]) / 2
                if nd < D[rr, cc]:
                    D[rr, cc] = nd
                    prev[(rr, cc)] = (r, c)
                    heapq.heappush(heap, (nd, rr, cc))
    if end is None:
        if os.environ.get('AERIAL_DEBUG'):
            print(f'  no way out: dest cell ({sr}, {sc}) blocked={bool(blocked[sr, sc])}, reached {int(np.isfinite(D).sum())} cells', file=sys.stderr)
        return None
    cells = [end]
    while cells[-1] != (sr, sc):
        cells.append(prev[cells[-1]])
    pts = [(float(cx[c]), float(cy[r])) for r, c in cells]
    pts[-1] = tuple(dest)
    pts = chaikin(simplify(pts, kx, ky, 3.0), 2)
    mapped = seen = guess = shaded = 0.0
    for (r0, c0), (r1, c1) in zip(cells, cells[1:]):
        m = math.hypot(r1 - r0, c1 - c0) * cell_m
        if on_way[r0, c0] and on_way[r1, c1]:
            mapped += m
        elif (p[r0, c0] + p[r1, c1]) / 2 >= 0.5:
            seen += m
        else:
            guess += m
            if trees[r0, c0] or trees[r1, c1]:
                shaded += m
    # the line in stretches by what the photo says about them: 'mapped' (a path the map has), 'seen' (looks like a path
    # on the photo), 'guess' (open ground or under trees) — each smoothed on its own
    kind = lambda r, c: 'mapped' if on_way[r, c] else 'seen' if p[r, c] >= 0.5 else 'guess'
    parts, cur = [], None
    for k, (r, c) in enumerate(cells):
        kd = kind(r, c)
        pt = (float(cx[c]), float(cy[r])) if k < len(cells) - 1 else tuple(dest)
        if cur and cur[0] == kd:
            cur[1].append(pt)
        else:
            if cur:
                cur[1].append(pt)  # stretches meet
            cur = (kd, [pt] if not cur else [cur[1][-1]])
            parts.append(cur)
    parts = [{'kind': kd, 'coords': chaikin(simplify(cs, kx, ky, 3.0), 2)} for kd, cs in parts if len(cs) > 1]
    res = {'coords': pts, 'parts': parts, 'join': pts[0], 'metres': round(mapped + seen + guess), 'mapped': round(mapped), 'seen': round(seen),
           'guess': round(guess), 'under_trees': round(shaded),
           'score': round(float(np.mean([p[r, c] for r, c in cells])), 2)}
    if debug_png:
        draw_debug(img, p, cells, trees, blocked, debug_png)
    return res


def chaikin(pts, rounds):
    """Round off the corners of a line (keeping its ends)."""
    for _ in range(rounds):
        if len(pts) < 3:
            return pts
        out = [pts[0]]
        for a, b in zip(pts, pts[1:]):
            out += [(a[0] * .75 + b[0] * .25, a[1] * .75 + b[1] * .25), (a[0] * .25 + b[0] * .75, a[1] * .25 + b[1] * .75)]
        out.append(pts[-1])
        pts = out
    return pts


def simplify(pts, kx, ky, tol):
    if len(pts) < 3:
        return pts
    keep = [0, len(pts) - 1]
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        ax, ay = pts[i][0] * kx, pts[i][1] * ky
        bx, by = pts[j][0] * kx, pts[j][1] * ky
        best, bi = 0, None
        for k in range(i + 1, j):
            px, py = pts[k][0] * kx, pts[k][1] * ky
            L = math.hypot(bx - ax, by - ay)
            d = math.hypot(px - ax, py - ay) if not L else abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / L
            if d > best:
                best, bi = d, k
        if bi is not None and best > tol:
            keep.append(bi)
            stack += [(i, bi), (bi, j)]
    return [pts[k] for k in sorted(keep)]


def draw_debug(img, p, cells, on_way, blocked, out):
    """The photo | the model's 'looks walkable' map with the path."""
    W, H = img.size
    heat = (np.clip(p, 0, 1) * 255).astype(np.uint8)
    hm = Image.fromarray(heat, 'L').resize((W, H), Image.NEAREST).convert('RGB')
    hm = Image.blend(img, Image.merge('RGB', (hm.getchannel(0), hm.getchannel(0), Image.new('L', (W, H), 0))), 0.65)
    for im in (img.copy(), hm):
        pass
    a = img.copy()
    for canvas in (a, hm):
        dr = ImageDraw.Draw(canvas)
        dr.line([((c + .5) * PATCH, (r + .5) * PATCH) for r, c in cells], fill=(255, 40, 40), width=5)
    sheet = Image.new('RGB', (W * 2 + 10, H), 'white')
    sheet.paste(a, (0, 0))
    sheet.paste(hm, (W + 10, 0))
    sheet.save(out)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dest', required=True, help='lon,lat')
    ap.add_argument('--from', dest='hint', help='lon,lat where the walk leaves the network now')
    ap.add_argument('--graph', default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'walkgraph'))
    ap.add_argument('--png')
    a = ap.parse_args()
    dest = tuple(float(v) for v in a.dest.split(','))
    hint = tuple(float(v) for v in a.hint.split(',')) if a.hint else None
    print(json.dumps(find_path(dest, a.graph, net_hint=hint, debug_png=a.png)))
