#!/usr/bin/env python3
"""Pictures for checking the reference walks by eye: each walk of two engines (A red, B blue) over swisstopo's
aerial image (SWISSIMAGE, wmts.geo.admin.ch) with the mapped ways, crossings and doors of OpenStreetMap.

    python3 -I render.py --set refwalks.json --a URL --b URL --data DATA --bin compare --out DIR [--only ID,ID]

Writes DIR/<id>.png and DIR/walks.json (both engines' answers). Tiles are kept in DIR/tiles.
Key: magenta = carriageway whose sidewalks are drawn apart; white = other carriageway (thicker: busy);
yellow = footway or sidewalk; orange = crossing way; green dot = crossing node (cyan: with signals);
grey outline = building; white square = door; A's door ringed red, B's blue; S start, E end.
"""
import argparse, concurrent.futures as cf, io, json, math, os, subprocess, sys, urllib.request
from PIL import Image, ImageDraw, ImageFont

TILE = 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg'
PROFILES = {'normal': {}, 'stepfree': {'stairs': 'never', 'escalators': False, 'wheelchair': True}}


def post(base, path, body):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def ask(base, w):
    try:
        return post(base, '/api/walk', {'from': {'lat': w['from'][0], 'lon': w['from'][1]}, 'to': {'lat': w['to'][0], 'lon': w['to'][1]}, 'options': PROFILES[w['profile']]})
    except Exception as ex:
        return {'error': str(ex)}


def world(lon, lat, z):
    n = 256 * 2 ** z
    x = (lon + 180) / 360 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def tile(cache, z, x, y):
    p = os.path.join(cache, f'{z}_{x}_{y}.jpeg')
    if not os.path.exists(p):
        req = urllib.request.Request(TILE.format(z=z, x=x, y=y), headers={'User-Agent': 'kante-refwalks/0.1'})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
        except Exception:
            return Image.new('RGB', (256, 256), (60, 60, 60))
        with open(p, 'wb') as f:
            f.write(data)
    return Image.open(p).convert('RGB')


def clusters(pts, size_m=200.0, keep=3):
    """Points in walk order split into runs whose box stays within size_m; the `keep` runs with most points."""
    runs, cur = [], []
    for p in pts:
        if cur:
            la = [q[1] for q in cur] + [p[1]]
            lo = [q[0] for q in cur] + [p[0]]
            if (max(la) - min(la)) * 111195 > size_m or (max(lo) - min(lo)) * 76000 > size_m:
                runs.append(cur)
                cur = []
        cur.append(p)
    if cur:
        runs.append(cur)
    runs = [r for r in runs if len(r) >= 2]
    return sorted(runs, key=len, reverse=True)[:keep]


def apart(g, h, tol=3.0):
    """The points of line g (densified every 5 m) more than tol metres from line h."""
    def segd(p, u, v):
        k = math.cos(math.radians(p[1])) * 111195
        px_, py_ = (p[0] - u[0]) * k, (p[1] - u[1]) * 111195
        dx, dy = (v[0] - u[0]) * k, (v[1] - u[1]) * 111195
        L = dx * dx + dy * dy
        t = 0 if L == 0 else max(0, min(1, (px_ * dx + py_ * dy) / L))
        return math.hypot(px_ - t * dx, py_ - t * dy)
    out = []
    for u, v in zip(g, g[1:]):
        n = max(1, int(math.hypot((v[0] - u[0]) * 76000, (v[1] - u[1]) * 111195) / 5))
        for i in range(n + 1):
            p = [u[0] + (v[0] - u[0]) * i / n, u[1] + (v[1] - u[1]) * i / n]
            if all(segd(p, a, b) > tol for a, b in zip(h, h[1:])):
                out.append(p)
    return out


def render(w, a, b, geo, cache, path, focus=None):
    lines = [x['geometry'] for x in (a, b) if x.get('geometry')]
    pts = focus or ([p for g in lines for p in g] + [[w['from'][1], w['from'][0]], [w['to'][1], w['to'][0]]])
    lo0, lo1 = min(p[0] for p in pts), max(p[0] for p in pts)
    la0, la1 = min(p[1] for p in pts), max(p[1] for p in pts)
    m = 40 / 111195
    la0, la1, lo0, lo1 = la0 - m, la1 + m, lo0 - m / math.cos(math.radians(la0)), lo1 + m / math.cos(math.radians(la0))
    z = 20
    while z > 14:
        x0, y0 = world(lo0, la1, z)
        x1, y1 = world(lo1, la0, z)
        if x1 - x0 <= (1000 if focus else 1400) and y1 - y0 <= (1000 if focus else 1400):
            break
        z -= 1
    x0, y0 = world(lo0, la1, z)
    x1, y1 = world(lo1, la0, z)
    tx0, ty0, tx1, ty1 = int(x0 // 256), int(y0 // 256), int(x1 // 256), int(y1 // 256)
    img = Image.new('RGB', ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256))
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            img.paste(tile(cache, z, tx, ty), ((tx - tx0) * 256, (ty - ty0) * 256))
    img = img.crop((int(x0) - tx0 * 256, int(y0) - ty0 * 256, int(x1) - tx0 * 256, int(y1) - ty0 * 256))
    # darken a little so the lines stand out
    img = Image.blend(img, Image.new('RGB', img.size, (0, 0, 0)), 0.25)
    d = ImageDraw.Draw(img, 'RGBA')

    def px(p):
        x, y = world(p[0], p[1], z)
        return (x - x0, y - y0)

    for o in geo['buildings']:
        if len(o) >= 3:
            d.polygon([px(p) for p in o], outline=(170, 170, 170, 200))
    for kind, road, apart, side, name, g in geo['edges']:
        xy = [px(p) for p in g]
        if kind in ('Road', 'RoadBusy'):
            col = (255, 0, 255, 230) if apart else (255, 255, 255, 200)
            d.line(xy, fill=col, width=3 if road >= 3 else 2)
        elif kind == 'Crossing':
            d.line(xy, fill=(255, 140, 0, 230), width=2)
        elif kind in ('Footway', 'Sidewalk', 'Path', 'Pedestrian', 'Steps'):
            d.line(xy, fill=(255, 230, 0, 200), width=1)
        else:
            d.line(xy, fill=(160, 220, 160, 180), width=1)
    for lon, lat, sig in geo['crossings']:
        x, y = px([lon, lat])
        d.ellipse((x - 4, y - 4, x + 4, y + 4), fill=(0, 255, 255, 230) if sig else (0, 230, 0, 230))
    for lon, lat, kind, faces in geo['doors']:
        x, y = px([lon, lat])
        d.rectangle((x - 2, y - 2, x + 2, y + 2), fill=(255, 255, 255, 230))
    for g, col, wd in [(a.get('geometry'), (255, 40, 40, 170), 7), (b.get('geometry'), (40, 120, 255, 190), 4)]:
        if g:
            d.line([px(p) for p in g], fill=col, width=wd, joint='curve')
    for r, col in [(a, (255, 40, 40, 255)), (b, (40, 120, 255, 255))]:
        door = r.get('door')
        if door:
            x, y = px([door['lon'], door['lat']])
            d.ellipse((x - 9, y - 9, x + 9, y + 9), outline=col, width=3)
    font = ImageFont.load_default()
    for p, t in [(w['from'], 'S'), (w['to'], 'E')]:
        x, y = px([p[1], p[0]])
        d.ellipse((x - 8, y - 8, x + 8, y + 8), fill=(0, 0, 0, 220), outline=(255, 255, 255, 255), width=2)
        d.text((x - 3, y - 6), t, fill=(255, 255, 255, 255), font=font)
    head = ("DETAIL " if focus else "") + f"{w['id']} {w['profile']}  A(red): {a.get('distanceM')} m {a.get('durationS')} s   B(blue): {b.get('distanceM')} m {b.get('durationS')} s   {w['from_name']} -> {w['to_name']}"
    d.rectangle((0, 0, img.size[0], 14), fill=(0, 0, 0, 200))
    d.text((3, 1), head, fill=(255, 255, 255, 255), font=font)
    # scale bar: 50 m
    k = 256 * 2 ** z / (40075016.7 * math.cos(math.radians((la0 + la1) / 2)))
    d.line((10, img.size[1] - 12, 10 + 50 * k, img.size[1] - 12), fill=(255, 255, 255, 255), width=3)
    d.text((14 + 50 * k, img.size[1] - 18), '50 m', fill=(255, 255, 255, 255), font=font)
    img.save(path)
    return (lo0, la0, lo1, la1)


def main():
    ap = argparse.ArgumentParser()
    for k in ['set', 'a', 'b', 'data', 'bin', 'out']:
        ap.add_argument('--' + k, required=True)
    ap.add_argument('--only', default='')
    args = ap.parse_args()
    S = json.load(open(args.set, encoding='utf-8'))['walks']
    if args.only:
        keep = set(args.only.split(','))
        S = [w for w in S if w['id'] in keep]
    os.makedirs(os.path.join(args.out, 'tiles'), exist_ok=True)
    with cf.ThreadPoolExecutor(8) as ex:
        ans = list(ex.map(lambda w: (ask(args.a, w), ask(args.b, w)), S))
    # the boxes for the map data
    boxes = []
    for w, (a, b) in zip(S, ans):
        pts = [p for r in (a, b) for p in (r.get('geometry') or [])] + [[w['from'][1], w['from'][0]], [w['to'][1], w['to'][0]]]
        m = 60 / 111195
        boxes.append(f"{w['id']} {min(p[1] for p in pts) - m} {min(p[0] for p in pts) - 1.5 * m} {max(p[1] for p in pts) + m} {max(p[0] for p in pts) + 1.5 * m}")
    out = subprocess.run([args.bin, 'geo', args.data], input='\n'.join(boxes) + '\n', capture_output=True, text=True, check=True).stdout
    geos = {g['key']: g for g in map(json.loads, out.splitlines())}
    record = {}
    for w, (a, b) in zip(S, ans):
        render(w, a, b, geos[w['id']], os.path.join(args.out, 'tiles'), os.path.join(args.out, w['id'] + '.png'))
        # where the two walks part, close up (and the last 40 m of a walk to a door)
        ga, gb = a.get('geometry') or [], b.get('geometry') or []
        parts = (clusters(apart(ga, gb)) + clusters(apart(gb, ga))) if ga and gb else []
        # one picture per place: a run of A's and one of B's that overlap are drawn once
        shown = []
        for run in sorted(parts, key=len, reverse=True):
            c = (sum(p[0] for p in run) / len(run), sum(p[1] for p in run) / len(run))
            if any(abs(c[0] - s[0]) * 76000 < 120 and abs(c[1] - s[1]) * 111195 < 120 for s in shown):
                continue
            shown.append(c)
        focus_sets = []
        for c in shown[:3]:
            focus_sets.append([p for run in parts for p in run if abs(p[0] - c[0]) * 76000 < 150 and abs(p[1] - c[1]) * 111195 < 150])
        if w['category'] == 'door' or not focus_sets:
            end = [p for p in ga[-8:] + gb[-8:]]
            if end and (w['category'] == 'door' or ga != gb):
                focus_sets.append(end)
        for k, focus in enumerate(focus_sets):
            render(w, a, b, geos[w['id']], os.path.join(args.out, 'tiles'), os.path.join(args.out, f"{w['id']}-detail{k + 1}.png"), focus)
        record[w['id']] = {'a': a, 'b': b}
        print(w['id'], file=sys.stderr)
    with open(os.path.join(args.out, 'walks.json'), 'w', encoding='utf-8') as f:
        json.dump(record, f)


if __name__ == '__main__':
    main()
