#!/usr/bin/env python3
"""Build stations3d/<key>.detail.js: a detail scene of a short stretch of a station model (format: stations3d/DETAIL.md).

The scene of Bern is the north head of the Hirschengraben: the walk between platform B and platform C of the tram stop
"Bern, Hirschengraben", past the Bubenberg monument (38 m). The walk itself is asked from the app's router
(station-route.js) so that it is a real route of the app.

Sources (small extracts in tools/station3d_data/<key>/detail/, see the README.md there for licences and dates):
  osm.json             OpenStreetMap: furniture nodes, tram tracks, buildings (levels, roof tags), shelters, monument
  baumkataster.json    City of Bern tree register: position, species, planting year of every city tree
  survey.json          cadastral survey of the City of Bern: ground cover (road / pavement / square), monument and
                       shelter outlines, building footprints
  buildings3d.json.gz  swisstopo swissBUILDINGS3D 3.0: roof and wall polygons of the houses
  lidar.json.gz        swisstopo swissSURFACE3D: ground points, and the points above the ground (trees, wires, poles)
  manual.json          what was read by eye from the aerial photos (and checked against the LiDAR): which of the
                       LiDAR pole candidates are lamps, movable benches; each entry says what was seen where
  route.json           the router's answer, kept so the scene can be built without node
  visual-facts.json    optional: facts read from reference photos by another agent (colours, variants); merged with
                       source "photo:<file>"

What is measured and what is not is written on every object as `source` (and `heightSource` where a height had to be
assumed). Nothing is placed that no source shows.

Usage:
  python tools/build_detail.py                 # build stations3d/bern.detail.js
  python tools/build_detail.py --no-node       # take the walk from route.json instead of asking station-route.js
  python tools/build_detail.py --date 2026-07-01   # the day the scene is for (trees in leaf or bare)
  python tools/build_detail.py --data DIR --out FILE --facts FILE

Requires Python 3.9+ with shapely 2 (which brings numpy), and node for the route (optional).
"""
import argparse
import datetime
import gzip
import json
import math
import os
import subprocess
import sys
from collections import defaultdict

import numpy as np
import shapely
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, Polygon, box
from shapely.ops import linemerge, polygonize, unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY = 'bern'
ORIGIN = (7.4391, 46.9488)                      # the model's origin (stations3d/bern.js)
KX = 111320 * math.cos(math.radians(ORIGIN[1]))
KY = 110540

SCENE = {
    'name': 'Hirschengraben',
    'from': {'stop': {'uic': '8579896', 'ref': 'B'}},
    'to': {'stop': {'uic': '8579896', 'ref': 'C'}},
    'from_name': 'Bern, Hirschengraben, platform B',
    'to_name': 'Bern, Hirschengraben, platform C',
    'box': (-134.0, -254.0, -50.0, -178.0),     # the detailed stretch lies inside this box (model frame) ...
    'reach': 46.0,                              # ... and within this distance of the walk
    'building_reach': 34.0,                     # houses nearer than this to the detailed stretch are included
}
KERB_ASSUMED = 0.10                             # m; used where the LiDAR cannot resolve a kerb (stated on the edge)
SPECIES = {                                     # register name (German) -> botanical name
    'Rosskastanie': 'Aesculus hippocastanum',
    'Rosskastanie, gefüllte': "Aesculus hippocastanum 'Baumannii'",
    'Kobushi Magnolie': 'Magnolia kobus',
}


def r2(v):
    return round(float(v), 2)


def pt(p):
    return [r2(p[0]), r2(p[1])]


def load(folder, name):
    p = os.path.join(folder, name)
    if not os.path.exists(p):
        return None
    if name.endswith('.gz'):
        with gzip.open(p, 'rt', encoding='utf-8') as f:
            return json.load(f)
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def to_xy(lon, lat):
    return (lon - ORIGIN[0]) * KX, (lat - ORIGIN[1]) * KY


def to_ll(x, y):
    return x / KX + ORIGIN[0], y / KY + ORIGIN[1]


def bearing(dx, dy):
    """Compass bearing (0 = north, 90 = east) of the direction (dx, dy)."""
    return (math.degrees(math.atan2(dx, dy)) + 360) % 360


def ccw(ring):
    a = sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring)))
    return ring if a > 0 else ring[::-1]


def densify(coords, step):
    out = []
    for a, b in zip(coords[:-1], coords[1:]):
        n = max(1, int(math.ceil(math.hypot(b[0] - a[0], b[1] - a[1]) / step)))
        for k in range(n):
            out.append((a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n))
    out.append(tuple(coords[-1]))
    return out


# ---------------------------------------------------------------------------------------------------------------------
# LiDAR
# ---------------------------------------------------------------------------------------------------------------------
class Cloud:
    """Points with a 1 m cell index."""

    def __init__(self, x, y, z, c=None):
        self.x, self.y, self.z = np.asarray(x, float), np.asarray(y, float), np.asarray(z, float)
        self.c = np.asarray(c) if c is not None else None
        self.cells = defaultdict(list)
        for i, (cx, cy) in enumerate(zip(np.floor(self.x).astype(int), np.floor(self.y).astype(int))):
            self.cells[(cx, cy)].append(i)
        self.cells = {k: np.array(v) for k, v in self.cells.items()}

    def near(self, x, y, r):
        idx = []
        for cx in range(int(math.floor(x - r)), int(math.floor(x + r)) + 1):
            for cy in range(int(math.floor(y - r)), int(math.floor(y + r)) + 1):
                v = self.cells.get((cx, cy))
                if v is not None:
                    idx.append(v)
        if not idx:
            return np.array([], int)
        idx = np.concatenate(idx)
        return idx[np.hypot(self.x[idx] - x, self.y[idx] - y) <= r]


class Ground:
    """Ground height from the LiDAR ground points: the median of the points around a place, optionally only of the
    points that lie on one surface (so that a pavement and the road beside it keep their own heights)."""

    def __init__(self, cloud):
        self.cloud = cloud
        self.owner = np.full(len(cloud.x), -1)

    def assign(self, polys):
        """polys: list of shapely polygons; every ground point gets the index of the polygon it lies in."""
        for i, p in enumerate(polys):
            x0, y0, x1, y1 = p.bounds
            m = np.flatnonzero((self.cloud.x >= x0) & (self.cloud.x <= x1) & (self.cloud.y >= y0) & (self.cloud.y <= y1))
            if len(m):
                inside = shapely.contains_xy(p, self.cloud.x[m], self.cloud.y[m])
                self.owner[m[inside]] = i

    def at(self, x, y, owner=None, rmax=4.0):
        for r in (0.8, 1.5, 2.5, rmax):
            idx = self.cloud.near(x, y, r)
            if owner is not None:
                idx = idx[self.owner[idx] == owner]
            if len(idx) >= 4:
                return float(np.median(self.cloud.z[idx]))
        return None

    def z(self, x, y, owner=None):
        v = self.at(x, y, owner)
        if v is None:
            v = self.at(x, y, None, 8.0)
        if v is None:                                    # outside the LiDAR extract: the nearest ground points
            d = np.hypot(self.cloud.x - x, self.cloud.y - y)
            v = float(np.median(self.cloud.z[np.argsort(d)[:8]]))
        return v


# ---------------------------------------------------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------------------------------------------------
ROUTE_JS = r"""
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = process.argv[1], key = process.argv[2], job = JSON.parse(process.argv[3]);
globalThis.window = globalThis;
const SR = require(path.join(root, 'station-route.js'));
vm.runInThisContext(fs.readFileSync(path.join(root, 'stations3d', key + '.js'), 'utf8'));
const model = window.STATION3D[key];
const r = SR.route(model, job.from, job.to, { date: job.date });
if (!r) { console.error('no route'); process.exit(2); }
process.stdout.write(JSON.stringify({ built: model.built, from: job.from, to: job.to, date: job.date, length: r.length, seconds: r.seconds,
  points: r.points, nodes: r.nodes, z: r.points.map((p) => SR.z(model, p[2])),
  steps: r.steps.map((s) => ({ kind: s.kind, text: s.text, len: s.len })) }));
"""


def get_route(data_dir, date, use_node):
    cached = os.path.join(data_dir, 'route.json')
    if use_node:
        try:
            job = json.dumps({'from': SCENE['from'], 'to': SCENE['to'], 'date': date})
            out = subprocess.run(['node', '-e', ROUTE_JS, ROOT, KEY, job], capture_output=True, text=True, encoding='utf-8', timeout=120)
            if out.returncode == 0:
                route = json.loads(out.stdout)
                with open(cached, 'w', encoding='utf-8', newline='\n') as f:
                    json.dump(route, f, ensure_ascii=False, indent=1)
                    f.write('\n')
                return route, 'station-route.js'
            print('  node could not route (%s); using route.json' % out.stderr.strip()[:200])
        except (OSError, subprocess.SubprocessError) as e:
            print('  node not usable (%s); using route.json' % e)
    with open(cached, encoding='utf-8') as f:
        return json.load(f), 'route.json'


# ---------------------------------------------------------------------------------------------------------------------
# Triangles of a planar polygon in space (ear clipping)
# ---------------------------------------------------------------------------------------------------------------------
def triangulate3d(poly):
    p = np.array(poly, float)
    if len(p) > 1 and np.allclose(p[0], p[-1]):
        p = p[:-1]
    keep = [0]
    for i in range(1, len(p)):
        if np.linalg.norm(p[i] - p[keep[-1]]) > 1e-4:
            keep.append(i)
    p = p[keep]
    n = len(p)
    if n < 3:
        return p, []
    nrm = np.zeros(3)
    for i in range(n):
        a, b = p[i], p[(i + 1) % n]
        nrm += [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]
    ln = np.linalg.norm(nrm)
    if ln < 1e-9:
        return p, []
    nrm /= ln
    u = np.cross(nrm, [0, 0, 1.0])
    if np.linalg.norm(u) < 1e-6:
        u = np.array([1.0, 0, 0])
    u /= np.linalg.norm(u)
    v = np.cross(nrm, u)
    q = np.stack([p @ u, p @ v], 1)                      # counter-clockwise seen along -normal
    idx = list(range(n))
    tris = []

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    guard = 0
    while len(idx) > 3 and guard < 4 * n * n:
        guard += 1
        done = False
        for k in range(len(idx)):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            c = cross(q[i0], q[i1], q[i2])
            if c <= 1e-10:
                continue
            ok = True
            for j in idx:
                if j in (i0, i1, i2):
                    continue
                if cross(q[i0], q[i1], q[j]) >= -1e-10 and cross(q[i1], q[i2], q[j]) >= -1e-10 and cross(q[i2], q[i0], q[j]) >= -1e-10:
                    ok = False
                    break
            if ok:
                tris.append((i0, i1, i2))
                idx.pop(k)
                done = True
                break
        if not done:                                     # degenerate rest: drop the flattest corner
            k = min(range(len(idx)), key=lambda k: abs(cross(q[idx[k - 1]], q[idx[k]], q[idx[(k + 1) % len(idx)]])))
            idx.pop(k)
    if len(idx) == 3 and cross(q[idx[0]], q[idx[1]], q[idx[2]]) > 1e-10:
        tris.append(tuple(idx))
    return p, tris


# ---------------------------------------------------------------------------------------------------------------------
class Builder:
    def __init__(self, data_dir, date, use_node, facts_path):
        self.dir = data_dir
        self.date = date
        self.report = []
        self.osm = load(data_dir, 'osm.json')
        self.reg = load(data_dir, 'baumkataster.json')
        self.av = load(data_dir, 'survey.json')
        self.b3d = load(data_dir, 'buildings3d.json.gz')
        self.lidar = load(data_dir, 'lidar.json.gz')
        self.manual = load(data_dir, 'manual.json') or {}
        self.facts = None
        for p in ([facts_path] if facts_path else []) + [os.path.join(data_dir, 'visual-facts.json')]:
            if p and os.path.exists(p):
                with open(p, encoding='utf-8') as f:
                    self.facts = json.load(f)
                self.facts_file = p
                break
        g = self.lidar['ground']
        self.ground = Ground(Cloud(np.array(g['x']) / 100, np.array(g['y']) / 100, np.array(g['z']) / 100))
        o = self.lidar['objects']
        self.obj = Cloud(np.array(o['x']) / 100, np.array(o['y']) / 100, np.array(o['z']) / 100, np.array(o['c']))
        self.route, self.route_from = get_route(data_dir, date, use_node)
        self.path2d = LineString([(p[0], p[1]) for p in self.route['points']])
        self.area = box(*SCENE['box']).intersection(self.path2d.buffer(SCENE['reach'], resolution=6)).simplify(0.8)
        self.detail = None

    def say(self, s):
        self.report.append(s)
        print(s)

    # ---- OSM helpers ----
    def osm_nodes(self, pred):
        for e in self.osm['elements']:
            if e['type'] == 'node' and pred(e['tags']):
                yield e, to_xy(e['lon'], e['lat'])

    def osm_ways(self, pred):
        for e in self.osm['elements']:
            if e['type'] == 'way' and pred(e['tags']):
                yield e, [to_xy(lon, lat) for lon, lat in e['geometry']]

    # ---- ground cover -> surfaces ----
    def cover(self):
        """Survey ground cover polygons, cut to the area, with the kind of surface they are."""
        osm_ped = [(e, Polygon(c)) for e, c in self.osm_ways(lambda t: t.get('highway') == 'pedestrian' and t.get('area') == 'yes') if len(c) > 3]
        out = []
        for f in self.av['cover']:
            if len(f['ring']) < 4:
                continue
            poly = Polygon(f['ring'], [h for h in f['holes'] if len(h) >= 4])
            if not poly.is_valid:
                poly = poly.buffer(0)
            cut = poly.intersection(self.area)
            art = f['art'].split('] ')[-1]
            for g in getattr(cut, 'geoms', [cut]):
                if g.geom_type != 'Polygon' or g.area < 0.5:
                    continue
                src = 'survey (AV Stadt Bern): %s' % art
                if art == 'Strasse, Weg':
                    kind, use = 'asphalt', 'road'
                    src += '; surface asphalt: osm (street ways)'
                elif art == 'Trottoir':
                    kind, use = 'asphalt', 'pavement'
                    src += '; surface asphalt: osm (footways and pedestrian area)'
                elif art == 'Verkehrsinsel':
                    kind, use = 'asphalt', 'island'
                    src += '; material not in the data, asphalt assumed'
                elif art == 'Übrige befestigte Fläche':
                    kind, use = 'asphalt', 'square'
                    best = max(osm_ped, key=lambda t: t[1].intersection(g).area, default=None)
                    if best and best[1].intersection(g).area > 0.5 * g.area:
                        s = best[0]['tags'].get('surface')
                        kind = {'pebblestone': 'gravel', 'gravel': 'gravel', 'fine_gravel': 'gravel', 'compacted': 'gravel', 'sett': 'cobble',
                                'paving_stones': 'paving', 'asphalt': 'asphalt'}.get(s, kind)
                        src += '; surface %s: osm:way/%d' % (s, best[0]['id'])
                    else:
                        src += '; material not in the data, asphalt assumed'
                elif art in ('Gartenanlage', 'Übrige humusierte Fläche', 'Acker, Wiese, Weide'):
                    kind, use = 'grass', 'green'
                elif art == 'Wasserbecken':
                    kind, use = 'water', 'basin'
                else:
                    kind, use = 'asphalt', 'other'
                out.append({'poly': g, 'kind': kind, 'use': use, 'source': src, 'art': art, 'changed': f['changed']})
        order = {'road': 0, 'other': 0, 'pavement': 1, 'island': 1, 'green': 1, 'basin': 1, 'square': 2}
        out.sort(key=lambda s: (order[s['use']], -s['poly'].area))
        return out

    def ring_out(self, poly, owner):
        """A polygon as ring / holes / zs. Heights come from the ground points on this very surface."""
        poly = shapely.geometry.polygon.orient(poly.simplify(0.04), 1.0)

        def one(r):
            c = densify(list(r.coords), 3.0)[:-1]
            return [pt(p) for p in c]

        ring = one(poly.exterior)
        zs = [r2(self.ground.z(p[0], p[1], owner)) for p in ring]
        holes = [one(i) for i in poly.interiors if Polygon(i).area > 0.3]
        return ring, holes, zs

    def build_surfaces(self):
        cov = self.cover()
        self.cov = cov
        self.ground.assign([s['poly'].buffer(-0.12) for s in cov])
        self.road = unary_union([s['poly'] for s in cov if s['use'] == 'road'])
        surfaces = []
        for i, s in enumerate(cov):
            ring, holes, zs = self.ring_out(s['poly'], i)
            d = {'kind': s['kind'], 'use': s['use'], 'ring': ring, 'zs': zs, 'source': s['source'] + '; heights: lidar (swissSURFACE3D 2023 ground points)'}
            if holes:
                d['holes'] = holes
            surfaces.append(d)
        # tram tracks: a strip as wide as the track along each OSM tram way
        tracks = []
        for e, c in self.osm_ways(lambda t: t.get('railway') == 'tram'):
            ls = LineString(c).intersection(self.area)
            for g in getattr(ls, 'geoms', [ls]):
                if g.geom_type == 'LineString' and g.length > 2:
                    tracks.append((e, g))
        self.tracks = tracks
        for e, g in tracks:
            gauge = float(e['tags'].get('gauge', 1000)) / 1000
            strip = g.buffer(gauge / 2 + 0.07, cap_style='flat', join_style='round').intersection(self.area)
            for sg in getattr(strip, 'geoms', [strip]):
                if sg.geom_type != 'Polygon' or sg.area < 1:
                    continue
                poly = shapely.geometry.polygon.orient(sg.simplify(0.05), 1.0)
                ring = [pt(p) for p in densify(list(poly.exterior.coords), 3.0)[:-1]]
                zs = [r2(self.ground.z(p[0], p[1]) + 0.0) for p in ring]
                surfaces.append({'kind': 'tram-track', 'use': 'tram', 'ring': ring, 'zs': zs, 'gauge': gauge,
                                 'line': [pt(p) for p in g.simplify(0.05).coords],
                                 'source': 'osm:way/%d (centre line, gauge %d mm); strip = gauge + rail heads; heights: lidar' % (e['id'], gauge * 1000)})
        self.say('surfaces: %d (%s)' % (len(surfaces), ', '.join('%d %s' % (sum(1 for s in surfaces if s['use'] == u), u) for u in sorted({s['use'] for s in surfaces}))))
        return surfaces

    # ---- kerbs ----
    def build_kerbs(self):
        edges = []
        cl = self.ground.cloud
        road_buf = self.road.buffer(0.08)
        stats = []
        borrowed = 0
        for i, s in enumerate(self.cov):
            if s['use'] == 'road':
                continue
            shared = s['poly'].boundary.intersection(road_buf)
            parts = [g for g in getattr(shared, 'geoms', [shared]) if g.geom_type == 'LineString' and g.length > 0.3]
            if not parts:
                continue
            merged = linemerge(MultiLineString(parts)) if len(parts) > 1 else parts[0]
            for line in getattr(merged, 'geoms', [merged]):
                if line.length < 1.5:
                    continue
                # chunks of about 6 m, so that a sloping kerb keeps its height
                n = max(1, int(round(line.length / 6.0)))
                pieces = []
                for k in range(n):
                    a, b = line.length * k / n, line.length * (k + 1) / n
                    seg = shapely.ops.substring(line, a, b).simplify(0.03)
                    hs, zr = [], []
                    for d in np.arange(0.5, seg.length, 1.0):
                        p = seg.interpolate(d)
                        q = seg.interpolate(min(seg.length, d + 0.3))
                        tx, ty = q.x - p.x, q.y - p.y
                        ln = math.hypot(tx, ty)
                        if ln < 1e-6:
                            continue
                        tx, ty = tx / ln, ty / ln
                        nx, ny = -ty, tx
                        side = 1 if self.road.contains(Point(p.x + nx * 0.6, p.y + ny * 0.6)) else -1 if self.road.contains(Point(p.x - nx * 0.6, p.y - ny * 0.6)) else 0
                        if not side:
                            continue
                        idx = cl.near(p.x, p.y, 2.0)
                        if not len(idx):
                            continue
                        al = (cl.x[idx] - p.x) * tx + (cl.y[idx] - p.y) * ty
                        ac = ((cl.x[idx] - p.x) * nx + (cl.y[idx] - p.y) * ny) * side      # positive = road side
                        m = np.abs(al) < 1.5
                        zroad = cl.z[idx][m & (ac > 0.35) & (ac < 1.2)]
                        zpave = cl.z[idx][m & (ac < -0.35) & (ac > -1.2)]
                        if len(zroad) >= 4 and len(zpave) >= 4:
                            hs.append(float(np.median(zpave) - np.median(zroad)))
                            zr.append(float(np.median(zroad)))
                    coords = [pt(p) for p in seg.coords]
                    pieces.append({'line': coords, 'h': float(np.median(hs)) if len(hs) >= 2 else None, 'n': len(hs),
                                   'zr': float(np.median(zr)) if zr else None})
                # a piece the LiDAR cannot resolve (a tram or a skip stood on it, or too few points), or one that comes
                # out flat between pieces with a clear step, takes the height of its measured neighbours
                good = [q['h'] for q in pieces if q['h'] is not None]
                line_med = float(np.median(good)) if good else None
                for k, q in enumerate(pieces):
                    e = {'kind': 'kerb', 'line': q['line']}
                    mid = q['line'][len(q['line']) // 2]
                    base = 'survey (AV Stadt Bern): edge of %s against the road; ' % s['art']
                    odd = q['h'] is not None and line_med is not None and line_med > 0.07 and q['h'] < 0.03
                    if q['h'] is not None and not odd:
                        e['z'] = r2(q['zr'])
                        e['height'] = r2(max(0.0, q['h']))
                        e['heightSource'] = 'lidar'
                        e['source'] = base + 'height: lidar, median of %d cross-sections (ground points 0.35-1.2 m each side)' % q['n']
                        stats.append(q['h'])
                    else:
                        nb = [pieces[j]['h'] for j in sorted(range(len(pieces)), key=lambda j: abs(j - k))
                              if j != k and pieces[j]['h'] is not None and pieces[j]['h'] >= 0.03][:2]
                        e['z'] = r2(q['zr'] if q['zr'] is not None and not odd else self.ground.z(mid[0], mid[1]))
                        if nb:
                            e['height'] = r2(float(np.mean(nb)))
                            e['heightSource'] = 'lidar, neighbouring pieces of the same kerb'
                            e['source'] = base + 'height not resolvable in the LiDAR here (something stood on it): mean of the two nearest measured pieces of this kerb'
                            borrowed += 1
                        else:
                            e['height'] = KERB_ASSUMED
                            e['heightSource'] = 'assumed'
                            e['source'] = base + 'height not resolvable in the LiDAR here: %.2f m assumed' % KERB_ASSUMED
                    edges.append(e)
        if stats:
            self.say('kerbs: %d pieces, %d with a measured height (min %.2f, median %.2f, max %.2f m), %d taken from neighbouring pieces, %d assumed' % (
                len(edges), len(stats), min(stats), float(np.median(stats)), max(stats), borrowed, len(edges) - len(stats) - borrowed))
        return edges

    # ---- trees ----
    def build_trees(self):
        every = self.reg['trees']
        keep_area = self.area.buffer(6)
        T = np.array([[t['x'], t['y']] for t in every])
        ob = self.obj
        month = int(self.date[5:7])
        bare = month in (11, 12, 1, 2, 3)
        osm_trees = [(e, xy) for e, xy in self.osm_nodes(lambda t: t.get('natural') == 'tree')]
        trees, self.tree_checks = [], []
        d_all = np.hypot(ob.x[:, None] - T[None, :, 0], ob.y[:, None] - T[None, :, 1])
        nearest = d_all.argmin(1)
        dmin = d_all.min(1)
        self.tree_pts = np.zeros(len(ob.x), bool)
        reg = []
        for i, t in enumerate(every):
            if not keep_area.contains(Point(t['x'], t['y'])):
                continue
            reg.append(t)
            gz = self.ground.z(t['x'], t['y'])
            m = (nearest == i) & (dmin < 5.5) & (ob.z - gz > 1.5)
            mv = m & (ob.c == 3)
            d = {'xy': [t['x'], t['y']], 'z': r2(gz), 'kind': 'conifer' if 'Nadel' in t['type_de'] else 'broadleaf'}
            src = ['baumkataster:%d (position, species, planting year)' % t['nr']]
            lid_off = None
            if mv.sum() >= 20:
                h = ob.z[mv] - gz
                cx, cy = ob.x[mv].mean(), ob.y[mv].mean()
                rad = np.hypot(ob.x[mv] - cx, ob.y[mv] - cy)
                d['height'] = round(float(h.max()), 1)
                d['crown'] = round(float(np.percentile(rad, 90)), 1)
                d['crownBase'] = round(float(np.percentile(h, 5)), 1)
                lid_off = math.hypot(cx - t['x'], cy - t['y'])
                self.tree_pts |= m & (np.hypot(ob.x - cx, ob.y - cy) <= d['crown'] + 1.0)
                if lid_off > 1.5:
                    # the register has the tree clearly beside its crown: it stands where the LiDAR has it
                    d['xy'] = pt((cx, cy))
                    d['z'] = r2(self.ground.z(cx, cy))
                    src[0] = 'baumkataster:%d (species, planting year)' % t['nr']
                    src.append('position: centre of the LiDAR returns, the register has the tree %.1f m from there' % lid_off)
                src.append('lidar (swissSURFACE3D 2023, %d vegetation returns, leaf-off: height = highest return, crown = 90 %% of the returns lie within this radius of their centre, crownBase = 5th percentile)' % int(mv.sum()))
            else:
                src.append('too few LiDAR returns for height and crown')
            sp = SPECIES.get(t['name_de'])
            if sp:
                d['species'] = sp
            else:
                d['species'] = t['genus']
            d['speciesDe'] = t['name_de']
            if t.get('planted'):
                d['planted'] = t['planted']
            d['leaves'] = not bare
            d['source'] = '; '.join(src)
            trees.append(d)
            od = min((math.hypot(xy[0] - t['x'], xy[1] - t['y']), e['id']) for e, xy in osm_trees) if osm_trees else (None, None)
            self.tree_checks.append({'nr': t['nr'], 'register_vs_lidar_m': None if lid_off is None else round(lid_off, 2),
                                     'register_vs_osm_m': None if od[0] is None or od[0] > 4 else round(od[0], 2), 'osm': od[1] if od[0] is not None and od[0] <= 4 else None,
                                     'placed': 'lidar' if d['xy'] != [t['x'], t['y']] else 'register',
                                     'to_path_m': round(self.path2d.distance(Point(d['xy'])), 2)})
        self.reg_used = reg
        self.trees_out = trees
        lone = [(e, xy) for e, xy in osm_trees if self.area.contains(Point(xy)) and min(math.hypot(xy[0] - t['x'], xy[1] - t['y']) for t in reg) > 4]
        self.say('trees: %d from the register (%d with LiDAR height and crown); OSM trees in the area without a register tree within 4 m: %d' % (
            len(trees), sum(1 for t in trees if 'height' in t), len(lone)))
        a = [c['register_vs_lidar_m'] for c in self.tree_checks if c['register_vs_lidar_m'] is not None]
        b = [c['register_vs_osm_m'] for c in self.tree_checks if c['register_vs_osm_m'] is not None]
        if a:
            self.say('  register vs LiDAR crown centre: median %.2f m, max %.2f m' % (float(np.median(a)), max(a)))
        if b:
            self.say('  register vs OSM tree node:      median %.2f m, max %.2f m (%d of %d trees have an OSM node within 4 m)' % (float(np.median(b)), max(b), len(b), len(reg)))
        return trees

    # ---- survey single objects ----
    def av_polys(self, art):
        lines = [LineString(o['line']) for o in self.av['objects'] if o['art'] == art and len(o['line']) > 1]
        lines = [l for l in lines if l.intersects(self.area)]
        if not lines:
            return []
        return [p for p in polygonize(unary_union(lines)) if p.area > 0.5]

    def rect(self, poly):
        """Centre, length, width and the bearing of the long axis of a polygon's smallest rectangle."""
        r = poly.minimum_rotated_rectangle
        c = list(r.exterior.coords)
        e1 = (c[1][0] - c[0][0], c[1][1] - c[0][1])
        e2 = (c[2][0] - c[1][0], c[2][1] - c[1][1])
        l1, l2 = math.hypot(*e1), math.hypot(*e2)
        long, ln, wd = (e1, l1, l2) if l1 >= l2 else (e2, l2, l1)
        return (r.centroid.x, r.centroid.y), ln, wd, bearing(*long)

    def facing(self, xy, axis):
        """Of the two bearings across `axis`, the one that looks at the nearest tram track."""
        best = None
        for e, g in self.tracks:
            d = g.distance(Point(xy))
            if best is None or d < best[0]:
                q = g.interpolate(g.project(Point(xy)))
                best = (d, bearing(q.x - xy[0], q.y - xy[1]))
        if best is None:
            return (axis + 90) % 360, None
        a, b = (axis + 90) % 360, (axis + 270) % 360
        diff = lambda u, v: abs((u - v + 180) % 360 - 180)
        return (a if diff(a, best[1]) < diff(b, best[1]) else b), best[0]

    def build_props(self):
        props, edges, surfaces = [], [], []
        ob = self.obj
        area = self.area

        def gz(x, y):
            return self.ground.z(x, y)

        # -- monument: survey outlines + LiDAR heights --
        mon = sorted(self.av_polys('Denkmal'), key=lambda p: p.area)
        osm_mon = [e for e, c in self.osm_ways(lambda t: t.get('historic') == 'memorial')]
        if mon:
            plinth, base = mon[0], unary_union(mon)
            c, ln, wd, axis = self.rect(plinth)
            g0 = gz(c[0], c[1])
            ring_out = base.buffer(1.2).difference(base.buffer(0.3))
            idx = np.flatnonzero(shapely.contains_xy(ring_out, self.ground.cloud.x, self.ground.cloud.y))
            g_out = float(np.median(self.ground.cloud.z[idx])) if len(idx) > 10 else g0
            inner = base.buffer(-0.3).difference(plinth.buffer(0.4))
            idx = np.flatnonzero(shapely.contains_xy(inner, self.ground.cloud.x, self.ground.cloud.y))
            g_base = float(np.median(self.ground.cloud.z[idx])) if len(idx) > 10 else None
            m = shapely.contains_xy(plinth.buffer(0.6), ob.x, ob.y)
            h = ob.z[m] - g_out
            d = {'kind': 'statue', 'xy': pt(c), 'z': r2(g_out), 'variant': 'figure on a plinth', 'ring': [pt(p) for p in ccw(list(plinth.exterior.coords)[:-1])],
                 'length': r2(ln), 'width': r2(wd), 'axis': round(axis)}
            src = ['survey (AV Stadt Bern, single object "Denkmal"): plinth outline']
            if len(h) >= 5:
                top = float(h.max())
                hist, edges_h = np.histogram(h, bins=np.arange(0, math.ceil(top) + 0.5, 0.25))
                # top of the plinth: the highest level with many returns below the figure
                lv = [edges_h[i] for i in range(len(hist)) if hist[i] >= max(4, 0.08 * len(h)) and edges_h[i] < top - 1.0]
                d['height'] = round(top, 1)
                if lv:
                    d['plinthHeight'] = round(float(np.percentile(h[(h >= lv[-1] - 0.25) & (h < lv[-1] + 0.5)], 75)), 1)
                src.append('lidar (%d returns): height = highest return above the ground beside the base; plinthHeight = uppermost level with many returns' % len(h))
            if osm_mon:
                t = osm_mon[0]['tags']
                d['name'] = t.get('name', '')
                d['material'] = t.get('material')
                d['year'] = t.get('start_date')
                d['artist'] = t.get('artist_name')
                src.append('osm:way/%d (name, material, year, artist)' % osm_mon[0]['id'])
            face = self.manual.get('statue_faces')
            if face:
                sides = [axis % 360, (axis + 90) % 360, (axis + 180) % 360, (axis + 270) % 360]
                d['heading'] = round(min(sides, key=lambda a: abs((a - face['bearing'] + 180) % 360 - 180)))
                src.append('heading: the side of the plinth nearest to %s; %s' % (face['towards'], face['seen']))
            d['source'] = '; '.join(src)
            props.append(d)
            if base.area > plinth.area * 1.3:
                hb = None if g_base is None else g_base - g_out
                e = {'kind': 'ledge', 'closed': True, 'line': [pt(p) for p in ccw(list(base.exterior.simplify(0.03).coords)[:-1])], 'z': r2(g_out), 'width': 0.3}
                if hb is not None and hb > 0.04:
                    e['height'] = r2(hb)
                    e['heightSource'] = 'lidar'
                    e['source'] = 'survey (AV Stadt Bern, "Denkmal"): outline of the base around the plinth; height: lidar (ground returns on the base minus those beside it)'
                    surfaces.append({'kind': 'paving', 'use': 'monument-base', 'ring': e['line'], 'z': r2(g_base),
                                     'holes': [[pt(p) for p in list(plinth.exterior.coords)[:-1]]],
                                     'source': 'survey (AV Stadt Bern, "Denkmal"): base around the plinth; height: lidar; material not in the data (stone slabs assumed)'})
                else:
                    e['heightSource'] = 'unknown'
                    e.pop('z')
                    e['source'] = 'survey (AV Stadt Bern, "Denkmal"): outline of the base around the plinth; no step measurable in the LiDAR (%s m)' % ('n/a' if hb is None else '%.2f' % hb)
                edges.append(e)
            self.say('monument: plinth %.1f x %.1f m, height %s m (plinth %s m), base step %s' % (ln, wd, d.get('height'), d.get('plinthHeight'),
                                                                                                'n/a' if g_base is None else '%.2f m' % (g_base - g_out)))
            self.monument = base

        # -- tram shelters: survey outline, LiDAR roof height, OSM height tag --
        osm_sh = [(e, Polygon(c)) for e, c in self.osm_ways(lambda t: t.get('amenity') == 'shelter') if len(c) > 3]
        for poly in self.av_polys('Unterstand'):
            if not area.contains(poly.centroid):
                continue
            c, ln, wd, axis = self.rect(poly)
            g0 = gz(c[0], c[1])
            m = shapely.contains_xy(poly.buffer(-0.2), ob.x, ob.y)
            h = ob.z[m] - g0
            head, dist = self.facing(c, axis)
            d = {'kind': 'shelter', 'xy': pt(c), 'z': r2(g0), 'heading': round(head), 'length': r2(ln), 'width': r2(wd), 'variant': 'tram stop shelter',
                 'ring': [pt(p) for p in ccw(list(poly.exterior.coords)[:-1])]}
            src = ['survey (AV Stadt Bern, single object "Unterstand"): outline; heading: the side towards the tram track']
            o = [e for e, p in osm_sh if p.intersects(poly)]
            if len(h) >= 8:
                d['height'] = round(float(np.median(h)), 1)
                src.append('lidar: height = median of %d roof returns' % len(h) + (' (osm:way/%d says height=%s)' % (o[0]['id'], o[0]['tags'].get('height')) if o else ''))
            elif o and o[0]['tags'].get('height'):
                d['height'] = float(o[0]['tags']['height'])
                src.append('osm:way/%d height' % o[0]['id'])
            d['source'] = '; '.join(src)
            props.append(d)

        # -- furniture mapped in OpenStreetMap --
        KINDS = [
            ('bench', lambda t: t.get('amenity') == 'bench'),
            ('bin', lambda t: t.get('amenity') in ('waste_basket', 'recycling')),
            ('hydrant', lambda t: t.get('emergency') == 'fire_hydrant'),
            ('ticket-machine', lambda t: t.get('amenity') == 'vending_machine' and t.get('vending') == 'public_transport_tickets'),
            ('sign-post', lambda t: t.get('tourism') == 'information' and t.get('information') in ('guidepost', 'map', 'board')),
            ('bike-stand', lambda t: t.get('amenity') == 'bicycle_parking'),
            ('bollard', lambda t: t.get('barrier') == 'bollard'),
            ('fountain', lambda t: t.get('amenity') in ('fountain', 'drinking_water')),
            ('planter', lambda t: t.get('man_made') == 'planter'),
            ('clock', lambda t: t.get('amenity') == 'clock'),
            ('lamp', lambda t: t.get('highway') == 'street_lamp'),
        ]
        for e, xy in self.osm_nodes(lambda t: True):
            if not area.contains(Point(xy)):
                continue
            t = e['tags']
            kind = next((k for k, f in KINDS if f(t)), None)
            if not kind:
                continue
            d = {'kind': kind, 'xy': pt(xy), 'z': r2(gz(*xy))}
            src = 'osm:node/%d' % e['id']
            if kind == 'bench':
                v = [t['material']] if t.get('material') else []
                if t.get('backrest') == 'yes':
                    v.append('with backrest')
                elif t.get('backrest') == 'no':
                    v.append('backless')
                d['variant'] = ', '.join(v)
                if t.get('direction', '').replace('.', '').isdigit():
                    d['heading'] = round(float(t['direction']))
                else:
                    sh = [p for p in props if p['kind'] == 'shelter' and Polygon(p['ring']).buffer(1.0).contains(Point(xy))]
                    if sh:
                        d['heading'] = sh[0]['heading']
                        src += ' (position, material, backrest); heading: not mapped, taken from the shelter it stands in (faces the track)'
            elif kind == 'bin':
                d['variant'] = 'recycling station' if t.get('amenity') == 'recycling' else ', '.join(v for v in (t.get('colour'), t.get('material')) if v)
            elif kind == 'hydrant':
                d['variant'] = t.get('fire_hydrant:type', '')
            elif kind == 'sign-post':
                d['variant'] = {'guidepost': 'guidepost (cycling routes)', 'map': 'info map board', 'board': 'info board'}[t['information']]
            elif kind == 'bike-stand':
                d['variant'] = t.get('bicycle_parking', '')
                if t.get('capacity'):
                    d['capacity'] = int(t['capacity'])
                if 'construction' in t.get('bicycle_parking', '').lower():
                    d['temporary'] = True
            if not d.get('variant'):
                d.pop('variant', None)
            d['source'] = src
            props.append(d)

        # -- lamps and poles: LiDAR clusters above the street that are no tree, confirmed by eye on the aerial photos --
        cand = self.lidar_poles()
        self.pole_candidates = cand
        used = set()
        self.masts = []
        for mnl in self.manual.get('lidar_objects', []):
            if mnl.get('column'):
                # a mast: every return within 1.2 m of the place that is no tree; it stands where the upper returns are
                nx, ny = mnl['near']
                g0 = gz(nx, ny)
                idx = ob.near(nx, ny, 1.2)
                idx = idx[(~self.tree_pts[idx]) & (ob.z[idx] - g0 > 1.8)]
                if len(idx) < 3:
                    self.say('  manual entry near %s: no LiDAR returns there (left out)' % mnl['near'])
                    continue
                h = ob.z[idx] - g0
                up = idx[h >= min(4.0, float(np.max(h)) - 0.5)]
                mx, my = float(np.median(ob.x[up])), float(np.median(ob.y[up]))
                for c in cand:
                    if math.hypot(c['x'] - nx, c['y'] - ny) < 1.5:
                        used.add(id(c))
                d = {'kind': mnl['kind'], 'xy': pt((mx, my)), 'z': r2(g0), 'height': round(float(h.max()), 1), 'variant': mnl.get('variant', ''),
                     'heightSource': 'lidar, highest return; a thin mast top can be missed, so it may be higher'}
                d['source'] = 'lidar (swissSURFACE3D 2023): %d returns from %.1f to %.1f m above the ground within 1.2 m (%d of them below 4.5 m: boards and boxes fixed to it); %s' % (
                    len(idx), float(h.min()), float(h.max()), int((h < 4.5).sum()), mnl['seen'])
                props.append(d)
                self.masts.append((mx, my, h))
                continue
            best = min(cand, key=lambda c: math.hypot(c['x'] - mnl['near'][0], c['y'] - mnl['near'][1]), default=None)
            if best is None or math.hypot(best['x'] - mnl['near'][0], best['y'] - mnl['near'][1]) > 1.5:
                self.say('  manual entry near %s: no LiDAR cluster there (left out)' % mnl['near'])
                continue
            used.add(id(best))
            g0 = gz(best['x'], best['y'])
            d = {'kind': mnl['kind'], 'xy': pt((best['x'], best['y'])), 'z': r2(g0), 'height': round(best['top'], 1), 'variant': mnl.get('variant', '')}
            if mnl.get('heightIsMinimum'):
                d['heightSource'] = 'lidar, highest return; the top may be higher'
            d['source'] = 'lidar (swissSURFACE3D 2023): %d returns between %.1f and %.1f m above the ground, within %.1f m; %s' % (
                best['n'], best['low'], best['top'], best['extent'], mnl['seen'])
            props.append(d)
        for d in props:
            if d['kind'] != 'sign-post':
                continue
            for mx, my, h in self.masts:
                if math.hypot(d['xy'][0] - mx, d['xy'][1] - my) < 1.5:
                    low = h[h < 4.5]
                    d['mount'] = 'on the mast beside it'
                    if len(low) >= 3 and 'guidepost' in d.get('variant', ''):
                        d['height'] = round(float(low.max()), 1)
                        d['source'] += '; fixed to the mast at this place; height: lidar (top of the %d returns from the boards on the mast, %.1f to %.1f m)' % (len(low), float(low.min()), float(low.max()))
                    else:
                        d['source'] += '; fixed to the mast at this place'
        rest = [c for c in cand if id(c) not in used and area.contains(Point(c['x'], c['y']))]
        self.say('lamps / poles: %d placed (%d lamps, %d masts; each a group of LiDAR returns confirmed by eye on a photo); %d other small LiDAR groups in the area left out' % (
            sum(1 for d in props if d['kind'] in ('lamp', 'pole')), sum(1 for d in props if d['kind'] == 'lamp'), sum(1 for d in props if d['kind'] == 'pole'), len(rest)))

        # -- furniture read from the aerial photo only --
        for mnl in self.manual.get('photo_objects', []):
            d = {k: v for k, v in mnl.items() if k not in ('seen',)}
            d['xy'] = pt(d['xy'])
            d['z'] = r2(gz(*d['xy']))
            d['source'] = mnl['seen']
            props.append(d)
        return props, edges, surfaces

    def lidar_poles(self):
        """Small clusters of LiDAR returns high above the ground that belong to no tree and no house."""
        ob = self.obj
        bld = unary_union([Polygon(b['ring']) for b in self.av['buildings'] if len(b['ring']) > 3]).buffer(1.2)
        g = np.array([self.ground.z(x, y) for x, y in zip(ob.x, ob.y)])
        h = ob.z - g
        keep = (~self.tree_pts) & (h > 1.8) & ~shapely.contains_xy(bld, ob.x, ob.y)
        # not the trees' outer twigs
        for t, tr in zip(self.reg_used, self.trees_out):
            keep &= np.hypot(ob.x - t['x'], ob.y - t['y']) > tr.get('crown', 3.0) + 1.5
        idx = np.flatnonzero(keep)
        cell = 0.6
        cells = defaultdict(list)
        for i in idx:
            cells[(int(math.floor(ob.x[i] / cell)), int(math.floor(ob.y[i] / cell)))].append(i)
        seen, out = set(), []
        for k in cells:
            if k in seen:
                continue
            stack, comp = [k], []
            seen.add(k)
            while stack:
                c = stack.pop()
                comp.extend(cells[c])
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        n = (c[0] + dx, c[1] + dy)
                        if n in cells and n not in seen:
                            seen.add(n)
                            stack.append(n)
            comp = np.array(comp)
            ext = max(np.ptp(ob.x[comp]), np.ptp(ob.y[comp]))
            if len(comp) >= 3 and ext < 1.6 and h[comp].max() > 2.5:
                out.append({'x': float(ob.x[comp].mean()), 'y': float(ob.y[comp].mean()), 'top': float(h[comp].max()), 'low': float(h[comp].min()),
                            'n': int(len(comp)), 'extent': float(ext)})
        return out

    # ---- houses ----
    def build_buildings(self):
        osm_b = []
        for e, c in self.osm_ways(lambda t: 'building' in t or 'building:part' in t):
            if len(c) > 3:
                osm_b.append((e, Polygon(c).buffer(0)))
        shops = [(e, xy) for e, xy in self.osm_nodes(lambda t: ('shop' in t or t.get('amenity') in ('restaurant', 'cafe', 'bar', 'fast_food', 'bank', 'pharmacy', 'pub'))
                                                    and t.get('level', '0') in ('0', '0;1'))]
        av_b = [(b, Polygon(b['ring']).buffer(0)) for b in self.av['buildings'] if len(b['ring']) > 3]
        out = []
        near = self.area.buffer(SCENE['building_reach'])
        all_fp = []
        items = []
        for b in self.b3d['buildings']:
            gs = [Polygon([(p[0], p[1]) for p in poly]) for t, poly in b['surfaces'] if t == 'GroundSurface' and len(poly) >= 4]
            gs = [g.buffer(0) for g in gs if g.area > 0.2]
            if not gs:
                continue
            fp = unary_union(gs).buffer(0.25).buffer(-0.25)
            if fp.is_empty or not fp.intersects(near) or fp.distance(self.area) > SCENE['building_reach']:
                continue
            if fp.geom_type == 'MultiPolygon':
                fp = max(fp.geoms, key=lambda g: g.area)
            items.append((b, fp))
            all_fp.append(fp)
        for b, fp in items:
            ring = [pt(p) for p in ccw(list(fp.exterior.simplify(0.15).coords)[:-1])]
            # ground at the foot of the house: LiDAR ground points in a 2.5 m band around it
            band = fp.buffer(2.5).difference(fp.buffer(0.3))
            idx = np.flatnonzero(shapely.contains_xy(band, self.ground.cloud.x, self.ground.cloud.y))
            base = float(np.percentile(self.ground.cloud.z[idx], 5)) if len(idx) > 30 else b['terrain']
            base_src = 'lidar (lowest ground beside the house, 5th percentile)' if len(idx) > 30 else 'swissBUILDINGS3D terrain point'
            roofs = [np.array(poly, float) for t, poly in b['surfaces'] if t == 'RoofSurface']
            walls = [np.array(poly, float) for t, poly in b['surfaces'] if t == 'WallSurface']
            # mesh
            pos, ind, vid = [], [], {}

            def add(poly, clamp):
                p, tris = triangulate3d(poly)
                if clamp:
                    p = p.copy()
                    p[:, 2] = np.maximum(p[:, 2], base)
                for tr in tris:
                    tri = [p[i] for i in tr]
                    if np.linalg.norm(np.cross(tri[1] - tri[0], tri[2] - tri[0])) < 1e-3:
                        continue
                    for v in tri:
                        k = (r2(v[0]), r2(v[1]), r2(v[2]))
                        if k not in vid:
                            vid[k] = len(vid)
                            pos.extend(k)
                        ind.append(vid[k])

            for p in walls:
                add(p, True)
            for p in roofs:
                add(p, False)
            # roof numbers: eaves = where the roof planes start, ridge = their top
            area_w, slopes, azim, zlo = [], [], [], []
            for p in roofs:
                q, tris = triangulate3d(p)
                for tr in tris:
                    a, bb, c = q[tr[0]], q[tr[1]], q[tr[2]]
                    n = np.cross(bb - a, c - a)
                    ar = np.linalg.norm(n) / 2
                    if ar < 0.05:
                        continue
                    n = n / (2 * ar)
                    if n[2] < 0:
                        n = -n
                    area_w.append(ar)
                    slopes.append(math.degrees(math.acos(min(1.0, n[2]))))
                    azim.append(bearing(n[0], n[1]))
                    zlo.append(min(a[2], bb[2], c[2]))
            area_w, slopes, azim, zlo = map(np.array, (area_w, slopes, azim, zlo))
            ridge = max(float(p[:, 2].max()) for p in roofs)
            flat_share = area_w[slopes < 8].sum() / area_w.sum()
            big = area_w > 4
            sloped = (slopes >= 8) & big
            if flat_share > 0.75 or not sloped.any():
                roof, eaves = 'flat', float(np.average(np.array([p[:, 2].max() for p in roofs]), weights=[max(0.1, Polygon(p[:, :2]).area) if len(p) >= 4 else 0.1 for p in roofs]))
                ridge_dir = None
            else:
                eaves = float(np.percentile(zlo[sloped], 10))
                steep = area_w[(slopes > 55) & big].sum() / area_w[sloped].sum()
                # main slope directions, on 90 degree sectors relative to the strongest one
                w = area_w[sloped]
                a0 = azim[sloped][np.argmax(w)]
                sector = np.round(((azim[sloped] - a0) % 360) / 90).astype(int) % 4
                share = np.array([w[sector == k].sum() for k in range(4)]) / w.sum()
                roof = 'mansard' if steep > 0.3 and steep < 0.85 else 'hipped' if (share > 0.12).sum() >= 3 else 'gabled'
                ridge_dir = round((a0 + 90) % 180)
            d = {'ring': ring, 'base': r2(base), 'eaves': r2(eaves), 'ridge': r2(ridge), 'roof': roof}
            if ridge_dir is not None:
                d['ridgeDir'] = ridge_dir
            src = ['swisstopo swissBUILDINGS3D 3.0 (%s, LoD2): footprint, roof and wall mesh, eaves, ridge, roof form from the roof planes' % b['year'], 'base: ' + base_src]
            if b.get('egid'):
                d['egid'] = b['egid']
            # OSM: levels, name, address
            hits = sorted(((p.intersection(fp).area, e) for e, p in osm_b if p.intersects(fp)), key=lambda t: -t[0])
            hits = [(a, e) for a, e in hits if a > 0.2 * min(fp.area, 1e9) or a > 40]
            lv = [(a, e) for a, e in hits if e['tags'].get('building:levels')]
            if lv:
                e = lv[0][1]
                try:
                    f = float(e['tags']['building:levels'])
                    d['floors'] = int(f) if f == int(f) else f
                    if e['tags'].get('roof:levels'):
                        rl = float(e['tags']['roof:levels'])
                        d['roofFloors'] = int(rl) if rl == int(rl) else rl
                    src.append('osm:way/%d (building:levels%s)' % (e['id'], ', roof:levels' if 'roofFloors' in d else ''))
                except ValueError:
                    pass
            nm = [e for a, e in hits if e['tags'].get('name')]
            if nm:
                d['name'] = nm[0]['tags']['name']
            sh = [e for e, xy in shops if fp.buffer(1.5).contains(Point(xy))]
            if sh:
                d['groundFloor'] = 'shop'
                src.append('ground floor: %d shop / restaurant nodes in OpenStreetMap (%s)' % (len(sh), ', '.join('osm:node/%d' % e['id'] for e in sh[:4])))
            # faces towards the open street, where something is known about them
            others = unary_union([f for f in all_fp if f is not fp])
            faces = []
            c = ring + [ring[0]]
            chain = []
            for a, bb in zip(c[:-1], c[1:]):
                ln = math.hypot(bb[0] - a[0], bb[1] - a[1])
                if ln < 0.5:
                    continue
                mx, my = (a[0] + bb[0]) / 2, (a[1] + bb[1]) / 2
                nx, ny = (bb[1] - a[1]) / ln, -(bb[0] - a[0]) / ln          # outward for a counter-clockwise ring
                probe = Point(mx + nx * 2.0, my + ny * 2.0)
                open_side = not others.contains(probe) and not fp.contains(probe) and self.area.buffer(8).contains(probe)
                br = bearing(nx, ny)
                if open_side and chain and abs((chain[-1]['br'] - br + 180) % 360 - 180) < 12 and chain[-1]['b'] == a:
                    chain[-1]['b'] = bb
                    chain[-1]['len'] += ln
                elif open_side:
                    chain.append({'a': a, 'b': bb, 'br': br, 'len': ln})
            for f in chain:
                if f['len'] < 6 or ('floors' not in d and 'groundFloor' not in d):
                    continue
                face = {'a': f['a'], 'b': f['b'], 'heading': round(f['br'])}
                if 'floors' in d:
                    face['floors'] = d['floors']
                if 'groundFloor' in d:
                    near_shop = [e for e in sh if LineString([f['a'], f['b']]).distance(Point(to_xy(e['lon'], e['lat']))) < 6]
                    if near_shop:
                        face['groundFloor'] = 'shop'
                faces.append(face)
            if faces:
                d['faces'] = faces
            d['mesh'] = {'positions': pos, 'indices': ind}
            d['source'] = '; '.join(src)
            d['_tris'] = len(ind) // 3
            out.append(d)
        self.say('buildings: %d (%d triangles; roofs: %s; %d with floors from OpenStreetMap, %d with a shop ground floor)' % (
            len(out), sum(b['_tris'] for b in out), ', '.join('%d %s' % (sum(1 for b in out if b['roof'] == r), r) for r in sorted({b['roof'] for b in out})),
            sum(1 for b in out if 'floors' in b), sum(1 for b in out if b.get('groundFloor') == 'shop')))
        for b in out:
            b.pop('_tris')
        return out

    # ---- photo facts from the other agent ----
    def merge_facts(self, detail):
        """Facts another agent read from reference photos (visual-facts.json): colours, storeys, variants. They never
        move anything: a fact about a house goes to the measured houses at its position (the positions in that file
        are good to 2-5 m and often stand for a row of houses)."""
        import re
        place = None
        if isinstance(self.facts, dict):
            place = next((v for v in self.facts.values() if isinstance(v, dict) and v.get('key') == SCENE['name'].lower()), None)
        if not place:
            self.say('visual facts: no file for this place (colours and variants from photos are not in the scene)')
            return
        n = [0]
        hexre = re.compile(r'#[0-9a-fA-F]{6}')

        def first(v):
            return v[0] if isinstance(v, list) and v else v

        def photo(f, key=None):
            src = first(f.get(key)) if key and f.get(key) else first(f.get('source'))
            return 'photo:%s (confidence %s)' % (src, str(f.get('confidence', 'not stated')).split(' ')[0].split(';')[0])

        def put(o, k, v, src):
            o[k] = v
            o['source'] += '; %s: %s' % (k, src)
            n[0] += 1

        # houses
        todo = defaultdict(list)
        skipped = []
        norm = lambda v: re.sub(r'[^a-z0-9]', '', v.lower())
        named = [(e, xy) for e, xy in self.osm_nodes(lambda t: t.get('name') and ('shop' in t or 'amenity' in t))]
        for f in place.get('buildings', []):
            pos = f.get('position') or {}
            if 'lon' not in pos:
                continue
            xy = to_xy(pos['lon'], pos['lat'])
            text = norm(str(f.get('name', '')) + ' ' + str(f.get('ground_floor', '')))
            shop = next(((e, sxy) for e, sxy in named if len(norm(e['tags']['name'])) >= 6 and norm(e['tags']['name']) in text), None)
            if shop:
                moved = math.hypot(shop[1][0] - xy[0], shop[1][1] - xy[1])
                self.say('  %s names the shop "%s": placed at that shop in OpenStreetMap (osm:node/%d), %.0f m from the position in the file' % (
                    f.get('id'), shop[0]['tags']['name'], shop[0]['id'], moved))
                xy = shop[1]
                f = dict(f, _anchor='osm:node/%d' % shop[0]['id'])
            if str(f.get('confidence', '')).split(' ')[0] not in ('high', 'medium'):
                skipped.append(f.get('id'))
                continue
            reach = 10 if 'row' in str(f.get('name', '')).lower() else 0.5
            hit = [(Polygon(b['ring']).distance(Point(xy)), b) for b in detail['buildings']]
            if not any(d <= reach for d, b in hit):
                hit = [min(hit, key=lambda t: t[0])] if hit and min(hit, key=lambda t: t[0])[0] <= 6 else []
                reach = 6
            for d, b in hit:
                if d <= reach:
                    todo[id(b)].append((d, f, b))
        for lst in todo.values():
            d, f, b = min(lst, key=lambda t: t[0])
            conf = str(f.get('confidence', '')).split(' ')[0]
            b['photoRef'] = f.get('id')
            if f.get('_anchor'):
                b['source'] += '; photo facts %s matched through the shop %s' % (f.get('id'), f['_anchor'])
            m = hexre.search(str(f.get('wall_colour', '')))
            if m:
                extra = ' (assumed the same as the neighbouring row)' if 'assum' in str(f.get('wall_colour')) else ''
                put(b, 'color', m.group(0).lower(), photo(f, 'wall_colour_source') + extra)
            m = hexre.search(str(f.get('roof_colour_est', '')))
            if m:
                put(b, 'roofColor', m.group(0).lower(), photo(f) + ' (estimate, typical weathered clay tile)')
            m = re.match(r'\s*(\d+)(?:\s*(?:full|\+|$))', str(f.get('storeys', '')))
            if m and conf in ('high', 'medium'):
                fl = int(m.group(1))
                if b.get('floors') != fl:
                    if 'floors' in b:
                        b['floorsOsm'] = b['floors']
                    put(b, 'floors', fl, photo(f) + ' (counted on the photo: "%s"%s)' % (f['storeys'], '; OpenStreetMap says %s' % b['floorsOsm'] if 'floorsOsm' in b else ''))
                    for fc in b.get('faces', []):
                        fc['floors'] = fl
            gf = str(f.get('ground_floor', '')).lower()
            if 'estimate' not in gf and ('shop' in gf or 'arcade' in gf) and conf in ('high', 'medium'):
                kind = 'arcade' if 'arcade' in gf and 'no arcade' not in gf else 'shop'
                if b.get('groundFloor') != kind:
                    put(b, 'groundFloor', kind, photo(f))
                else:
                    b['source'] += '; groundFloor confirmed: ' + photo(f)
            note = '; '.join(str(f[k]) for k in ('roof', 'distinctive', 'ground_floor') if f.get(k))
            if note:
                put(b, 'facadeNote', note, photo(f))
        ob = place.get('objects', {})
        # monument
        mon = ob.get('monument')
        st = next((p for p in detail['props'] if p['kind'] == 'statue'), None)
        if mon and st:
            pos = mon.get('position') or {}
            if 'lon' in pos:
                xy = to_xy(pos['lon'], pos['lat'])
                self.say('  monument: the photo agent has it %.1f m from the centre of the surveyed plinth' % math.hypot(xy[0] - st['xy'][0], xy[1] - st['xy'][1]))
            c = mon.get('colours', {})
            m = hexre.search(str(c.get('bronze', '')))
            if m:
                put(st, 'color', m.group(0).lower(), photo(mon) + ' (bronze figure)')
            m = hexre.search(str(c.get('plinth', '')))
            if m:
                put(st, 'plinthColor', m.group(0).lower(), photo(mon) + ' (granite plinth, estimate from overcast photos)')
            put(st, 'variant', 'bronze figure in armour on a tall stepped granite plinth', photo(mon))
            for s in detail['surfaces']:
                if s.get('use') == 'monument-base':
                    s['source'] = s['source'].replace('material not in the data (stone slabs assumed)', 'material: raised granite step platform, ' + photo(mon))
                    if m:
                        s['color'] = m.group(0).lower()
                    n[0] += 1
        # trees
        tr = ob.get('trees')
        if tr and 'pollard' in str(tr.get('shape', '')):
            for t in detail['trees']:
                if t['species'].startswith('Aesculus'):
                    put(t, 'form', 'pollarded', photo(tr))
        # lamps, poles, signs
        lw = ob.get('lamps_and_wires')
        if lw:
            for p in detail['props']:
                if p['kind'] == 'lamp' and 'suspended' in p.get('variant', ''):
                    p['source'] += '; photos agree that the street lighting hangs on span wires, lamp type not clearly visible: photo:%s (confidence low for the lamp type)' % first(lw['source'])
                    n[0] += 1
                if p['kind'] == 'pole':
                    p['source'] += '; tram poles here are tall grey steel masts with banding rings on a concrete foot: photo:%s (confidence medium)' % first(lw['source'])
                    n[0] += 1
        sg = ob.get('signs')
        if sg:
            for p in detail['props']:
                if p['kind'] == 'sign-post' and 'guidepost' in p.get('variant', ''):
                    put(p, 'variant', 'guidepost: red-brown Swiss cycle-route signs (Thun/Belp, Biel/Aarberg, Neuchatel/Kerzers, Konolfingen), mounted on a tram pole', photo(sg))
        # ground
        for f in place.get('surfaces', []):
            what = str(f.get('surface', '')).lower()
            m = hexre.search(str(f.get('material', '')) + ' ' + str(f.get('colour', '')))
            for s in detail['surfaces']:
                hit = (('roadway' in what and s.get('use') == 'road') or ('under the trees' in what and s['kind'] == 'gravel')
                       or ('sidewalk' in what and s.get('use') == 'pavement') or ('tram track' in what and s.get('use') == 'tram'))
                if not hit:
                    continue
                if m and s.get('use') in ('road', 'square'):
                    s['color'] = m.group(0).lower()
                s['source'] += '; material%s: %s' % (' and colour' if 'color' in s and m else '', photo(f))
                if 'under the trees' in what:
                    s['variant'] = 'water-bound gravel (Mergel), pale grey-beige, with a granite edging strip'
                if 'tram track' in what:
                    s['variant'] = 'rails set in asphalt'
                n[0] += 1
            if f.get('kerb'):
                for e in detail['edges']:
                    if e['kind'] == 'kerb':
                        e['variant'] = 'granite'
                        e['source'] += '; granite kerb, low (the photo agent estimates 6-10 cm): ' + photo(f)
                        n[0] += 1
        self.say('visual facts: %d values merged from %s (%d houses matched; house facts of low confidence left out: %s)' % (
            n[0], os.path.basename(self.facts_file), len(todo), ', '.join(str(v) for v in skipped) or 'none'))

    # ---- all together ----
    def build(self):
        self.say('route: %s -> %s, %d m, %d points (from %s)' % (SCENE['from_name'], SCENE['to_name'], self.route['length'], len(self.route['points']), self.route_from))
        surfaces = self.build_surfaces()
        edges = self.build_kerbs()
        trees = self.build_trees()
        props, e2, s2 = self.build_props()
        edges += e2
        surfaces += s2
        buildings = self.build_buildings()
        path = [[r2(p[0]), r2(p[1]), r2(self.ground.z(p[0], p[1]))] for p in self.route['points']]
        zreal = [p[2] for p in path]
        zmodel = self.route['z']
        detail = {
            'key': KEY, 'name': SCENE['name'], 'built': self.date,
            'attribution': ['© OpenStreetMap contributors', 'Geodaten Stadt Bern', '© swisstopo'],
            'area': [pt(p) for p in ccw(list(self.area.exterior.coords)[:-1])],
            'path': path,
            'route': {'from': SCENE['from'], 'to': SCENE['to'], 'fromName': SCENE['from_name'], 'toName': SCENE['to_name'],
                      'length': self.route['length'], 'seconds': self.route['seconds'], 'nodes': self.route['nodes'],
                      'points': self.route['points'], 'modelBuilt': self.route.get('built'),
                      'source': 'station-route.js: StationRoute.route(model, from, to) on stations3d/%s.js' % KEY},
            'zOffset': r2(float(np.mean(zmodel)) - float(np.mean(zreal))),
            'surfaces': surfaces, 'edges': edges, 'trees': trees, 'props': props, 'buildings': buildings,
            'sources': [
                {'name': 'OpenStreetMap', 'licence': self.osm['licence'], 'date': self.osm['timestamp_osm_base'][:10]},
                {'name': 'Baumkataster der Stadt Bern', 'licence': self.reg['licence'], 'date': self.reg['dataset_modified']},
                {'name': 'Amtliche Vermessung der Stadt Bern', 'licence': self.av['licence'], 'date': self.av['dataset_modified']},
                {'name': 'swisstopo swissBUILDINGS3D 3.0', 'licence': self.b3d['licence'], 'date': str(self.b3d['data_year'])},
                {'name': 'swisstopo swissSURFACE3D (LiDAR)', 'licence': self.lidar['licence'], 'date': str(self.lidar['data_year'])},
                {'name': 'Orthofoto 2026 der Stadt Bern, swisstopo SWISSIMAGE 2024 (checks by eye, see manual.json)', 'licence': 'open use', 'date': '2026 / 2024'},
            ],
        }
        self.merge_facts(detail)
        self.check(detail)
        self.detail = detail
        return detail

    def check(self, detail):
        notes = []
        for t, c in zip(detail['trees'], self.tree_checks):
            if c['to_path_m'] < 1.0:
                notes.append('tree %s stands %.2f m from the centre line of the walk (the router follows the edge of the square there)' % (t['source'].split(' ')[0], c['to_path_m']))
        for p in detail['props']:
            d = self.path2d.distance(Polygon(p['ring']) if p.get('ring') else Point(p['xy']))
            if d < 0.6:
                notes.append('%s %s is %.2f m from the centre line of the walk' % (p['kind'], p.get('name') or p['xy'], d))
        if getattr(self, 'monument', None) is not None:
            d = self.path2d.distance(self.monument)
            notes.append('the walk passes %.2f m from the base of the monument' % d if d > 0 else 'the centre line of the walk crosses the base of the monument for %.1f m (the router follows the outline of the square there)' % self.path2d.intersection(self.monument).length)
        for b in detail['buildings']:
            if Polygon(b['ring']).distance(self.path2d) < 0.5:
                notes.append('the walk touches a house (%s)' % b.get('egid'))
        zr = [p[2] for p in detail['path']]
        notes.append('real ground along the walk is %.2f to %.2f m above level 0, while the station model has the walk on level 0 (z = 0); '
                     'zOffset = %.2f m is what a viewer adds to the heights of this scene to set it on the ground of the model' % (min(zr), max(zr), detail['zOffset']))
        detail['notes'] = notes
        for n in notes:
            self.say('note: ' + n)
        counts = defaultdict(int)
        for p in detail['props']:
            counts[p['kind']] += 1
        self.say('props: ' + ', '.join('%d %s' % (v, k) for k, v in sorted(counts.items())))
        self.say('edges: ' + ', '.join('%d %s' % (sum(1 for e in detail['edges'] if e['kind'] == k), k) for k in sorted({e['kind'] for e in detail['edges']})))
        for key in ('trees', 'props', 'edges', 'surfaces', 'buildings'):
            for o in detail[key]:
                assert o.get('source'), (key, o)


def main():
    ap = argparse.ArgumentParser(description='Build the detail scene stations3d/%s.detail.js.' % KEY)
    ap.add_argument('--data', default=os.path.join(ROOT, 'tools', 'station3d_data', KEY, 'detail'), help='folder with the source extracts')
    ap.add_argument('--out', default=os.path.join(ROOT, 'stations3d', KEY + '.detail.js'))
    ap.add_argument('--date', default=datetime.date.today().isoformat(), help='the day the scene is for (default: today)')
    ap.add_argument('--no-node', action='store_true', help='take the walk from route.json')
    ap.add_argument('--facts', help='visual-facts.json of the reference photos (default: <data>/visual-facts.json when it exists)')
    ap.add_argument('--report', help='also write the build report and the checks as JSON here')
    a = ap.parse_args()
    b = Builder(a.data, a.date, not a.no_node, a.facts)
    detail = b.build()
    head = ('// Generated by tools/build_detail.py. Sources: OpenStreetMap (%s), Baumkataster and Amtliche Vermessung der Stadt Bern (%s), '
            'swisstopo swissBUILDINGS3D 3.0 (2021) and swissSURFACE3D (2023). Format: stations3d/DETAIL.md\n'
            '(window.STATION3D_DETAIL = window.STATION3D_DETAIL || {})[%s] = ' % (b.osm['timestamp_osm_base'][:10], b.reg['dataset_modified'], json.dumps(KEY)))
    with open(a.out, 'w', encoding='utf-8', newline='\n') as f:
        f.write(head)
        json.dump(detail, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')
    print('wrote %s (%d KB)' % (a.out, os.path.getsize(a.out) // 1024))
    if a.report:
        with open(a.report, 'w', encoding='utf-8', newline='\n') as f:
            json.dump({'report': b.report, 'trees': b.tree_checks, 'pole_candidates': b.pole_candidates}, f, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
