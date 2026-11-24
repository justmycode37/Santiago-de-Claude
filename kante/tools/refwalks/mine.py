#!/usr/bin/env python3
"""Candidates for the reference walks: walks in ten city centres between addresses of the official building address
register (and from the main station), asked of two engines, each walk's line measured by `compare metrics`.

    python3 -I mine.py --a http://127.0.0.1:8091 --b http://127.0.0.1:8092 --data DATA --bin compare --out DIR

DATA is a data dir with raw/register/adr.csv.zip and the built graph and walkattr.bin (`compare metrics` reads them).
Writes DIR/candidates.json: per walk its ends, profile and both engines' answers with their metrics.
"""
import argparse, concurrent.futures as cf, csv, io, json, math, random, subprocess, sys, urllib.request, zipfile

# (south, west, north, east), main station (lat, lon)
CITIES = {
    'bern': ((46.935, 7.420, 46.962, 7.462), (46.9490, 7.4391)),
    'zurich': ((47.362, 8.520, 47.392, 8.556), (47.3779, 8.5403)),
    'basel': ((47.540, 7.575, 47.567, 7.607), (47.5476, 7.5897)),
    'geneva': ((46.193, 6.130, 46.215, 6.160), (46.2102, 6.1424)),
    'lausanne': ((46.510, 6.617, 46.528, 6.646), (46.5167, 6.6291)),
    'luzern': ((47.040, 8.293, 47.058, 8.322), (47.0502, 8.3102)),
    'winterthur': ((47.492, 8.715, 47.508, 8.740), (47.5003, 8.7237)),
    'stgallen': ((47.418, 9.357, 47.432, 9.385), (47.4232, 9.3700)),
    'lugano': ((45.995, 8.942, 46.012, 8.962), (46.0054, 8.9469)),
    'biel': ((47.128, 7.233, 47.146, 7.258), (47.1325, 7.2430)),
}
PROFILES = {'normal': {}, 'stepfree': {'stairs': 'never', 'escalators': False, 'wheelchair': True}}


def lv95_to_wgs84(e, n):
    """swisstopo's approximate formulas (about 1 m)."""
    y, x = (e - 2600000) / 1e6, (n - 1200000) / 1e6
    lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3
    lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.0140 * x ** 3
    return lat * 100 / 36, lon * 100 / 36


def addresses(path):
    out = {c: [] for c in CITIES}
    z = zipfile.ZipFile(path)
    name = [n for n in z.namelist() if n.endswith('.csv')][0]
    f = io.TextIOWrapper(z.open(name), encoding='utf-8-sig')
    r = csv.reader(f, delimiter=';')
    head = next(r)
    st, nb, e, n, street = (head.index(c) for c in ['ADR_STATUS', 'ADR_NUMBER', 'ADR_EASTING', 'ADR_NORTHING', 'STN_LABEL'])
    for row in r:
        if len(row) != len(head) or row[st] != 'real' or not row[nb]:
            continue
        try:
            lat, lon = lv95_to_wgs84(float(row[e]), float(row[n]))
        except ValueError:
            continue
        for c, ((s, w, no, ea), _) in CITIES.items():
            if s <= lat <= no and w <= lon <= ea:
                out[c].append((round(lat, 6), round(lon, 6), f'{row[street]} {row[nb]}'))
    return out


def dist(a, b):
    k = math.cos(math.radians(a[0]))
    return math.hypot((a[0] - b[0]) * 111195, (a[1] - b[1]) * 111195 * k)


def post(base, path, body, timeout=60):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers={'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception as ex:  # an error is an answer too
        return {'error': str(ex)}


def walk_body(w, at=None):
    b = {'from': {'lat': w['from'][0], 'lon': w['from'][1]}, 'to': {'lat': w['to'][0], 'lon': w['to'][1]}, 'options': PROFILES[w['profile']]}
    if at is not None:
        b['time'] = at
    return b


def slim(r):
    if 'error' in r:
        return r
    keep = ['distanceM', 'durationS', 'approximate', 'approxStart', 'approxEnd', 'door', 'startDoor', 'stepFree', 'geometry']
    return {k: r.get(k) for k in keep}


def measure(bin_, data, walks):
    """`compare metrics` for every answer with a line: key 'i/a' or 'i/b'."""
    lines = []
    for i, w in enumerate(walks):
        for side in 'ab':
            g = (w.get(side) or {}).get('geometry')
            if g:
                lines.append(json.dumps({'key': f'{i}/{side}', 'geometry': g}))
    p = subprocess.run([bin_, 'metrics', data], input='\n'.join(lines) + '\n', capture_output=True, text=True, check=True)
    out = {}
    for line in p.stdout.splitlines():
        m = json.loads(line)
        out[m.pop('key')] = m
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--a', required=True)
    ap.add_argument('--b', required=True)
    ap.add_argument('--data', required=True)
    ap.add_argument('--bin', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--per-city', type=int, default=90)
    ap.add_argument('--seed', type=int, default=11)
    args = ap.parse_args()
    rnd = random.Random(args.seed)
    adr = addresses(f'{args.data}/raw/register/adr.csv.zip')
    walks = []
    for c, ((s, w, n, e), station) in CITIES.items():
        pool = adr[c]
        print(f'{c}: {len(pool)} addresses', file=sys.stderr)
        got = 0
        while got < args.per_city and pool:
            to = rnd.choice(pool)
            # a third from the main station, the rest from another address
            fr = (station[0], station[1], 'station') if rnd.random() < 0.33 else rnd.choice(pool)
            d = dist(fr, to)
            if not 200 <= d <= 1500:
                continue
            prof = 'stepfree' if rnd.random() < 0.3 else 'normal'
            walks.append({'city': c, 'profile': prof, 'from': [fr[0], fr[1]], 'from_name': fr[2], 'to': [to[0], to[1]], 'to_name': to[2], 'beeline_m': round(d)})
            got += 1

    def ask(i):
        w = walks[i]
        return i, slim(post(args.a, '/api/walk', walk_body(w))), slim(post(args.b, '/api/walk', walk_body(w)))

    with cf.ThreadPoolExecutor(8) as ex:
        for i, a, b in ex.map(ask, range(len(walks))):
            walks[i]['a'], walks[i]['b'] = a, b
    m = measure(args.bin, args.data, walks)
    for i, w in enumerate(walks):
        for side in 'ab':
            if f'{i}/{side}' in m:
                w[side]['metrics'] = m[f'{i}/{side}']
    with open(f'{args.out}/candidates.json', 'w', encoding='utf-8') as f:
        json.dump(walks, f)
    print(f'{len(walks)} candidates', file=sys.stderr)


if __name__ == '__main__':
    main()
