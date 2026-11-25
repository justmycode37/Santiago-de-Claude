#!/usr/bin/env python3
"""The cadastral survey (Amtliche Vermessung, AV) inside a station: measured outlines for the first-person view.

OpenStreetMap has the floors of a station's underground passages but hardly any of their walls. The cantonal
cadastral survey has, as open data, the measured outlines of what is built below ground (its "Einzelobjekte":
underground buildings, tunnels, underpasses and galleries), of the platform canopies and of the pillars. This tool
fetches them round a station and turns them into a layer of its continuous 3D companion:

  walls     per level below ground: the stretches of a measured outline within 1.5 m of that floor's edge (and not
            deep inside the floor). The viewer puts them where it would otherwise raise the floor's edge to a
            schematic wall
  fills     per level below ground: the floor between the edge OpenStreetMap draws and such a wall (at most 1.5 m;
            never over a track)
  pillars   on the floor they stand on (one that contains them; the top one at the platforms' level first)
  canopies  over the platforms, at the height of a building or roof of the model that covers them, else 4.6 m

Usage:
  python tools/station3d_av.py zurich            # fetch (cached) and merge into stations3d/zurich.solid.js
  python tools/station3d_av.py all               # every station of a canton that publishes the survey openly
  python tools/station3d_av.py bern --refetch    # fetch again

Data: geodienste.ch, WFS of the AV (layer ms:SOSF, LV95), cached as tools/station3d_data/<key>/av_objects.geojson in
the model's local metres. Terms (geodienste.ch, 24 Nov 2026, ZH, BE, BS, GE): "Freie Nutzung. Quellenangabe ist
Pflicht": the canton is credited in the companion's attribution. Vaud (Lausanne) and Luzern do not publish it there.
Fair use: at most 10 requests a minute (the tool waits 7 s between pages).

tools/station3d_solid.py reads the cached file too, so a full rebuild of the companion keeps the layer.
"""
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'stations3d')
DATA_DIR = os.path.join(ROOT, 'tools', 'station3d_data')
WFS = 'https://geodienste.ch/db/av_0/deu'
# the canton of each station (whose survey and terms apply), and its credit
CANTON = {'zurich': 'ZH', 'bern': 'BE', 'wankdorf': 'BE', 'europaplatz': 'BE', 'bruennen': 'BE', 'buempliz-nord': 'BE',
          'basel': 'BS', 'geneve': 'GE'}
CREDIT = {'ZH': 'Amtliche Vermessung Kanton Zürich', 'BE': 'Amtliche Vermessung Kanton Bern',
          'BS': 'Amtliche Vermessung Kanton Basel-Stadt', 'GE': 'Mensuration officielle Canton de Genève'}
MARGIN = 60          # m round the model's extent
BAND = 1.5           # m: a measured outline this near a floor's edge is its wall (further out: a shop, a plant room
                     #   may lie between, and the floor's edge stays as it is)
DEEP = 1.0           # m: not where it runs this far inside the floor (an outline across a passage is not a wall)
TRACK = 2.6          # m: half the width of a track bed (no floor is filled over it)
TRACK_WALL = 4.5     # m: no measured wall this near a track (it would close a platform's edge; as the viewer's rule)
CANOPY_TOP = 4.6     # m over the platforms, where the model has no height for a canopy


def kind_of(art):
    a = (art or '').lower().replace('ä', 'ae').replace('ü', 'ue').replace('ö', 'oe')
    if 'unterirdisch' in a:
        return 'underground'
    if 'tunnel' in a or 'unterfuehrung' in a or 'galerie' in a:
        return 'tunnel'
    if 'unterstand' in a:
        return 'canopy'
    if 'pfeiler' in a:
        return 'pillar'
    return None


def load_js(path):
    with open(path, encoding='utf-8') as f:
        txt = f.read()
    i = txt.index('] = ') + 4
    return txt[:i], json.loads(txt[i:].rstrip().rstrip(';'))


def fetch(key, model):
    """The survey's objects round the station, in the model's local metres: [{ kind, art, rings }]."""
    from pyproj import Transformer   # only for fetching (station3d_solid.py uses the layer without it)
    lng0, lat0 = model['origin']
    kx = 111320 * math.cos(math.radians(lat0))
    to_ll = lambda x, y: (lng0 + x / kx, lat0 + y / 110540)
    b = model['bbox']
    ll = [to_ll(b[0] - MARGIN, b[1] - MARGIN), to_ll(b[2] + MARGIN, b[3] + MARGIN)]
    fwd = Transformer.from_crs('EPSG:4326', 'EPSG:2056', always_xy=True)
    back = Transformer.from_crs('EPSG:2056', 'EPSG:4326', always_xy=True)
    (e0, n0), (e1, n1) = fwd.transform(*ll[0]), fwd.transform(*ll[1])
    out, start, page = [], 0, 1000
    while True:
        q = {'SERVICE': 'WFS', 'VERSION': '2.0.0', 'REQUEST': 'GetFeature', 'TYPENAMES': 'ms:SOSF', 'OUTPUTFORMAT': 'geojson',
             'BBOX': f'{e0:.0f},{n0:.0f},{e1:.0f},{n1:.0f},urn:ogc:def:crs:EPSG::2056', 'COUNT': page, 'STARTINDEX': start}
        req = urllib.request.Request(WFS + '?' + urllib.parse.urlencode(q), headers={'User-Agent': 'station3d-av (open-data build tool)'})
        with urllib.request.urlopen(req, timeout=120) as r:
            fc = json.load(r)
        feats = fc.get('features') or []
        matched = fc.get('numberMatched')
        for f in feats:
            p, g = f.get('properties') or {}, f.get('geometry') or {}
            k = kind_of(p.get('Art'))
            if not k or p.get('Gueltigkeit') not in (None, 'gueltig'):
                continue
            polys = [g['coordinates']] if g.get('type') == 'Polygon' else g.get('coordinates', []) if g.get('type') == 'MultiPolygon' else []
            for poly in polys:
                rings = []
                for ring in poly:
                    pts = []
                    for e, n in ring:
                        lng, lat = back.transform(e, n)
                        pts.append([round((lng - lng0) * kx, 2), round((lat - lat0) * 110540, 2)])
                    rings.append(pts)
                out.append({'kind': k, 'art': p.get('Art'), 'rings': rings})
        print(f'  {key}: {len(feats)} objects from {start}')
        start += len(feats)
        # the server may send fewer than asked for: it says how many there are
        if not feats or (isinstance(matched, int) and start >= matched) or (not isinstance(matched, int) and len(feats) < page):
            break
        time.sleep(7)   # geodienste.ch fair use: 10 requests a minute
    return out


def polys_of(g):
    if g.is_empty:
        return []
    if g.geom_type == 'Polygon':
        return [g]
    return [x for x in getattr(g, 'geoms', []) if x.geom_type == 'Polygon']


def lines_of(g):
    if g.is_empty:
        return []
    if g.geom_type in ('LineString', 'LinearRing'):
        return [LineString(g.coords)]
    return [x for x in getattr(g, 'geoms', []) if x.geom_type in ('LineString', 'LinearRing')] + \
        [y for x in getattr(g, 'geoms', []) if x.geom_type == 'MultiLineString' for y in x.geoms]


def rnd(coords):
    return [[round(x, 2), round(y, 2)] for x, y in coords]


def layer(model, solid, objs):
    """The companion's `av` layer from the survey's objects (see the module's text)."""
    levels = sorted(l['id'] for l in solid['levels'])
    poly = lambda o: Polygon(o['rings'][0], o['rings'][1:]).buffer(0)
    under = unary_union([poly(o) for o in objs if o['kind'] in ('underground', 'tunnel')])
    floors = {L: unary_union([Polygon(s['rings'][0]).buffer(0) for s in solid['slabs'] if s['level'] == L]) for L in levels}
    # the floor you can stand on: without its openings (stairs and lifts going down through it)
    solid_floor = {L: unary_union([Polygon(s['rings'][0], s['rings'][1:]).buffer(0) for s in solid['slabs'] if s['level'] == L]) for L in levels}
    nodes = model['graph']['nodes']
    paths = {L: unary_union([LineString([nodes[e['a']][:2], nodes[e['b']][:2]]) for e in model['graph']['edges']
                             if abs(nodes[e['a']][2] - L) < 0.3 and abs(nodes[e['b']][2] - L) < 0.3 and nodes[e['a']][:2] != nodes[e['b']][:2]])
             for L in levels}
    tracks = {L: unary_union([LineString(t['line']) for t in model['tracks'] if t['level'] == L and len(t['line']) > 1]) for L in levels}
    walls, fills, pillars, canopies = [], [], [], []
    for L in levels:
        F = floors[L]
        if L >= 0 or F.is_empty or under.is_empty:
            continue
        T = tracks[L].buffer(TRACK) if not tracks[L].is_empty else Polygon()
        near = F.buffer(BAND).difference(F.buffer(-DEEP))
        if not tracks[L].is_empty:
            near = near.difference(tracks[L].buffer(TRACK_WALL))   # never along a platform's edge
        got = []
        for g in lines_of(under.boundary.intersection(near)):
            g = g.simplify(0.1)
            if g.length > 1.0:
                walls.append({'level': L, 'line': rnd(g.coords)})
                got.append(g)
        if not got:
            continue
        # the floor only between the drawn edge and a measured wall
        band = F.buffer(BAND).intersection(under).difference(F).intersection(unary_union(got).buffer(BAND + 0.1))
        if not T.is_empty:
            band = band.difference(T)
        for p in polys_of(band.buffer(-0.05).buffer(0.05)):
            if p.area > 1.0:
                fills.append({'level': L, 'ring': rnd(p.simplify(0.1).exterior.coords)})
    shells = [Polygon(s['ring']).buffer(0) for s in solid.get('shell', []) if s.get('kind') in ('building', 'roof') and len(s['ring']) > 2]
    tops = [s['top'] for s in solid.get('shell', []) if s.get('kind') in ('building', 'roof') and len(s['ring']) > 2]
    # the survey maps what stands at the surface: a pillar goes on a floor at or above street level, the platforms'
    # (a level with tracks) first
    track_levels = {L for L in levels if not tracks[L].is_empty}
    pillar_objs = []
    for o in objs:
        if o['kind'] == 'pillar':
            P = poly(o)
            if P.is_empty or P.area > 30:
                continue
            c = P.representative_point()
            on = [L for L in levels if L >= 0 and not solid_floor[L].is_empty and solid_floor[L].buffer(0.3).contains(c)]
            if not on:
                continue
            L = next((x for x in on if x in track_levels), min(on))
            # one on a path of the walking graph is on another floor than it seems (or the path is wrong): left out
            if not paths[L].is_empty and P.buffer(0.2).intersects(paths[L]):
                continue
            pillar_objs.append((L, P))
        elif o['kind'] == 'canopy':
            P = poly(o)
            if P.is_empty or P.area < 4 or P.area > 60000:
                continue
            best, lv = 0, None
            for L in levels:
                if L < 0 or floors[L].is_empty:
                    continue
                a = P.intersection(floors[L]).area
                if a > best:
                    best, lv = a, L
            if lv is None or best < 0.3 * P.area:
                continue
            # the height of a building or roof of the model covering it (most of it), else a usual canopy's
            top = None
            for S, t in zip(shells, tops):
                if t and S.intersection(P).area > 0.5 * P.area:
                    top = t if top is None else min(top, t)
            z = next(l['z'] for l in solid['levels'] if l['id'] == lv)
            top = top if top is not None and top > z + 2.5 else z + CANOPY_TOP
            canopies.append({'level': lv, 'ring': rnd(P.simplify(0.1).exterior.coords), 'top': round(top, 2)})
    # a pillar reaches up to the canopy over most of it (above ground)
    for L, P in pillar_objs:
        p = {'level': L, 'ring': rnd(P.simplify(0.05).exterior.coords)}
        over = [k for k in canopies if k['level'] == L and Polygon(k['ring']).buffer(0).intersection(P).area > 0.5 * P.area]
        if over and L >= 0:
            p['top'] = min(k['top'] for k in over)
        pillars.append(p)
    return {'walls': walls, 'fills': fills, 'pillars': pillars, 'canopies': canopies}


def cache_path(key):
    return os.path.join(DATA_DIR, key, 'av_objects.geojson')


def load_cached(key):
    """The cached objects of a station (None: not fetched)."""
    p = cache_path(key)
    if not os.path.exists(p):
        return None
    with open(p, encoding='utf-8') as f:
        fc = json.load(f)
    return [{'kind': f['properties']['kind'], 'art': f['properties'].get('art'), 'rings': f['geometry']['coordinates']} for f in fc['features']]


def save_cached(key, objs):
    os.makedirs(os.path.dirname(cache_path(key)), exist_ok=True)
    fc = {'type': 'FeatureCollection',
          'note': f'Amtliche Vermessung (Einzelobjekte, layer SOSF) via geodienste.ch, {time.strftime("%Y-%m-%d")}, '
                  f'in the local metres of stations3d/{key}.js (x east, y north). Credit: {CREDIT[CANTON[key]]}.',
          'features': [{'type': 'Feature', 'properties': {'kind': o['kind'], 'art': o['art']},
                        'geometry': {'type': 'Polygon', 'coordinates': o['rings']}} for o in objs]}
    with open(cache_path(key), 'w', encoding='utf-8') as f:
        json.dump(fc, f, ensure_ascii=False, separators=(',', ':'))


def credit(key):
    return CREDIT[CANTON[key]] if key in CANTON else None


def merge(key, refetch=False):
    _, model = load_js(os.path.join(OUT_DIR, f'{key}.js'))
    spath = os.path.join(OUT_DIR, f'{key}.solid.js')
    head, solid = load_js(spath)
    objs = None if refetch else load_cached(key)
    if objs is None:
        objs = fetch(key, model)
        save_cached(key, objs)
    solid['av'] = layer(model, solid, objs)
    c = credit(key)
    if c and c not in solid['attribution']:
        solid['attribution'].append(c)
    with open(spath, 'w', encoding='utf-8', newline='\n') as f:
        f.write(head)   # the generator's comment and the assignment, as they were
        f.write(json.dumps(solid, ensure_ascii=False, separators=(',', ':')))
        f.write(';\n')
    a = solid['av']
    kinds = {}
    for o in objs:
        kinds[o['kind']] = kinds.get(o['kind'], 0) + 1
    print(f'{key}: {kinds} -> {len(a["walls"])} measured walls ({sum(LineString(w["line"]).length for w in a["walls"]):.0f} m), '
          f'{len(a["fills"])} floor fills ({sum(Polygon(x["ring"]).area for x in a["fills"]):.0f} m²), '
          f'{len(a["pillars"])} pillars, {len(a["canopies"])} canopies')


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if not args:
        raise SystemExit(__doc__)
    keys = sorted(CANTON) if args[0] == 'all' else args
    refetch, fetched = '--refetch' in sys.argv, False
    for k in keys:
        if k not in CANTON:
            print(f'{k}: its canton does not publish the cadastral survey openly on geodienste.ch; skipped')
            continue
        need = refetch or load_cached(k) is None
        if fetched and need:
            time.sleep(7)   # fair use between stations too
        fetched = fetched or need
        merge(k, refetch)


if __name__ == '__main__':
    main()
