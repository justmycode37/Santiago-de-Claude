#!/usr/bin/env python3
"""Build walkgraph/: a pedestrian network for exact walking routes between and around buildings.

Every walk in the app (to the stop, between platforms, to the door) is routed on this network in the browser by
walkroute.js. It holds what a car-style router leaves out: sidewalks, crossings, steps, elevators, arcades (Bern's
Lauben), passages through buildings, underpasses, station corridors and their floor levels, the entrances of every
building, building outlines, and straight lines across pedestrian squares and platforms (so routes cross a square
instead of going round its edge).

Source: OpenStreetMap through Overpass, fetched once per 0.02° block and cached in ~/.cache/walkgraph, so a run that
stops can simply be started again. This is a build step; the app itself never calls Overpass.

Usage:
  python3 tools/build_walkgraph.py --area bern            # bern, zurich, basel, geneva, lausanne, luzern, ...
  python3 tools/build_walkgraph.py --bbox 7.43,46.94,7.46,46.96
  python3 tools/build_walkgraph.py --area bern --refresh  # fetch OSM again instead of using the cache

Output: walkgraph/index.js (which tiles exist) and walkgraph/t/<lat*100>_<lon*100>.js, one per 0.01° tile:
  window.WALKGRAPH_TILE(key, {
    o: [lon0E6, lat0E6],                 tile origin; coordinates below are integers in 1e-6° from it
    n: [id, x, y, id, x, y, ...],        nodes by OSM id (so tiles join where they share nodes), each value a
                                         difference from the node before (ids ascending)
    a: [{k, c?, l?, n?, i?, w?}, ...],   way attributes: k kind, c covered, l level, n name, i incline, w wheelchair=no
    w: [[wayId, attr, n0, n1, ...]],     walkable ways as node indices into n
    v: [[n0, n1, attr], ...],            straight lines across pedestrian areas (squares, platforms, station halls)
    b: [[bldId, x0, y0, dx, dy, ...]],   building outlines (first point absolute, then deltas)
    e: [[node, bldId, type, wheelchair, "addr"]],  entrances (bldId 0 when on no building)
    x: [node, ...],                      nodes you cannot pass (locked or private gates)
    r: [node, ...],                      raised kerbs (no wheelchair)
    l: [node, ...],                      elevators on the network
    z: [[x0, y0, x1, y1, ...]],          railway tracks on the ground: no straight line onto the network crosses them
  })
"""
import argparse
import hashlib
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'walkgraph')
CACHE = os.path.join(os.path.expanduser('~'), '.cache', 'walkgraph')
OVERPASS = ['https://overpass.osm.ch/api/interpreter', 'https://overpass-api.de/api/interpreter']  # Swiss instance first
UA = 'santiago-de-claude-walkgraph/1.0 (build-time OSM extract, cached)'
TILE = 0.01   # tile size in degrees (~1.1 km × 0.75 km)
BLOCK = 0.02  # Overpass request size in degrees

AREAS = {  # lon_min, lat_min, lon_max, lat_max (same areas as build_stop_images.py)
    'bern': (7.36, 46.92, 7.50, 46.98),
    'zurich': (8.45, 47.32, 8.62, 47.44),
    'basel': (7.54, 47.52, 7.64, 47.59),
    'geneva': (6.08, 46.17, 6.20, 46.24),
    'lausanne': (6.57, 46.50, 6.68, 46.56),
    'luzern': (8.26, 47.03, 8.34, 47.07),
    'winterthur': (8.68, 47.48, 8.77, 47.52),
    'stgallen': (9.33, 47.40, 9.42, 47.45),
    'lugano': (8.92, 45.98, 8.98, 46.03),
}

QUERY = """[out:json][timeout:240];
(
  way["highway"]({bb});
  way["railway"="platform"]({bb});
  way["public_transport"="platform"]({bb});
  way["area:highway"]({bb});
  relation["railway"="platform"]({bb});
  relation["public_transport"="platform"]({bb});
  relation["area:highway"]({bb});
  relation["highway"="pedestrian"]({bb});
  way["building"]({bb});
  way["barrier"~"^(wall|fence|retaining_wall|city_wall|hedge|handrail|guard_rail)$"]({bb});
  way["railway"~"^(rail|narrow_gauge|light_rail)$"]({bb});
  node["entrance"]({bb});
  node["barrier"]({bb});
  node["highway"="elevator"]({bb});
  node["kerb"]({bb});
);
out body geom qt;"""


# ------------------------------------------------------------------ download

def overpass(bb, refresh):
    """All the OSM data of one block (s, w, n, e), cached."""
    os.makedirs(CACHE, exist_ok=True)
    q = QUERY.replace('{bb}', ','.join(f'{v:.4f}' for v in bb))
    path = os.path.join(CACHE, hashlib.sha1(q.encode()).hexdigest() + '.json')
    if os.path.exists(path) and not refresh:
        with open(path, encoding='utf-8') as f:
            return json.load(f)['elements']
    for attempt in range(8):
        url = OVERPASS[attempt % len(OVERPASS)]
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode({'data': q}).encode(), headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=300) as res:
                body = res.read().decode('utf-8')
            data = json.loads(body)
            if 'remark' in data and 'runtime error' in data['remark']:
                raise RuntimeError(data['remark'])
            with open(path, 'w', encoding='utf-8') as f:
                f.write(body)
            return data['elements']
        except Exception as e:  # rate limits and timeouts: wait and try again (other server on odd attempts)
            wait = 10 * (attempt + 1)
            print(f'  overpass {url.split("/")[2]}: {e}; retrying in {wait}s', file=sys.stderr)
            time.sleep(wait)
    raise SystemExit('Overpass keeps failing; run again later (finished blocks are cached)')


# ------------------------------------------------------------------ which ways can you walk on, and how

FOOT_OK = {'yes', 'designated', 'permissive', 'destination', 'official'}
NO_WALK = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'construction', 'proposed', 'raceway', 'bus_guideway',
           'abandoned', 'disused', 'razed', 'escape', 'emergency_bay', 'rest_area', 'services', 'via_ferrata', 'busway'}
MAJOR = {'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link'}
MINOR = {'residential', 'unclassified', 'service', 'track', 'road', 'living_street'}
AREA_KINDS = {'pedestrian', 'footway', 'platform', 'path', 'corridor'}


def separate_sidewalks(t):
    return any(t.get(k) == 'separate' for k in ('sidewalk', 'sidewalk:both', 'sidewalk:left', 'sidewalk:right')) \
        and not any(t.get(k) in ('yes', 'both', 'left', 'right') for k in ('sidewalk',))


def walk_attrs(t):
    """Attributes of a walkable way, or None when you cannot (or should not) walk on it."""
    hw = t.get('highway')
    platform = t.get('railway') == 'platform' or t.get('public_transport') == 'platform' or hw == 'platform'
    if not hw and not platform:
        return None
    if hw in NO_WALK and t.get('foot') not in FOOT_OK:
        return None
    foot = t.get('foot')
    if foot in ('no', 'private', 'use_sidepath', 'discouraged') and hw not in ('footway', 'pedestrian', 'steps'):
        return None
    if foot in ('no', 'private'):
        return None
    if t.get('access') in ('no', 'private', 'customers', 'delivery') and foot not in FOOT_OK:
        return None
    if hw in ('cycleway', 'bridleway') and foot not in FOOT_OK and t.get('segregated') != 'yes' and hw == 'bridleway':
        return None

    if hw == 'steps':
        k = 'es' if t.get('conveying') and t.get('conveying') != 'no' else 'st'
    elif hw == 'elevator':
        k = 'el'
    elif hw == 'corridor':
        k = 'co'
    elif platform:
        k = 'pl'
    elif t.get('footway') == 'crossing' or t.get('cycleway') == 'crossing' or t.get('path') == 'crossing':
        k = 'cr'
    elif t.get('footway') in ('sidewalk', 'traffic_island'):
        k = 'sw'
    elif hw in ('footway', 'path', 'pedestrian', 'living_street'):
        k = 'fw'
    elif hw == 'cycleway':
        k = 'cy'
    elif hw in MAJOR or hw in MINOR:
        if separate_sidewalks(t):
            k = 'sep'   # the sidewalks are drawn as their own footways: walk there, not on the road
        elif hw in MAJOR and t.get('sidewalk') in ('no', 'none') and foot not in FOOT_OK:
            k = 'mr'
        else:
            k = 'rd'
    else:
        return None

    a = {'k': k}
    tunnel, covered = t.get('tunnel'), t.get('covered')
    if tunnel == 'building_passage':
        a['c'] = 'p'
    elif covered == 'arcade':
        a['c'] = 'a'
    elif t.get('indoor') in ('yes', 'corridor', 'room', 'area') or hw == 'corridor':
        a['c'] = 'i'
    elif tunnel in ('yes', 'culvert'):
        a['c'] = 't'
    elif covered in ('yes', 'colonnade', 'roof'):
        a['c'] = 'c'
    level = t.get('level') or t.get('level:ref')
    if level is not None:
        a['l'] = level.replace(' ', '')
    elif t.get('layer') and a.get('c') in ('t', 'i') and t['layer'].lstrip('-').isdigit() and int(t['layer']) < 0:
        a['l'] = t['layer']   # an underpass with only a layer: below ground, floor unknown
    elif t.get('layer', '0').lstrip('-').isdigit() and int(t.get('layer', '0')) != 0 and t.get('bridge', 'no') != 'no' or a.get('c') == 't':
        # a bridge or tunnel without a floor: not on the ground, so not where a street-level point can step on
        lay = t.get('layer', '')
        a['y'] = int(lay) if lay.lstrip('-').isdigit() and int(lay) != 0 else (-1 if a.get('c') == 't' else 1)
    if k == 'es' and t.get('conveying') in ('forward', 'backward'):
        a['d'] = 'f' if t['conveying'] == 'forward' else 'b'  # an escalator runs one way only
    if t.get('name'):
        a['n'] = t['name']
    if k == 'pl':
        # which tracks / bays the platform serves ("3;4" → 3;4), so a train or bus is boarded from its own platform
        ref = t.get('ref') or t.get('local_ref') or t.get('railway:track_ref') or ''
        refs = re.findall(r'\d+[A-Z]?|(?<![A-Z])[A-Z](?![A-Z])', ref.upper())
        if refs:
            a['r'] = ';'.join(refs)
    if t.get('incline') in ('up', 'down'):
        a['i'] = 'u' if t['incline'] == 'up' else 'd'
    if t.get('wheelchair') == 'no' or (k in ('st',) and t.get('ramp:wheelchair') != 'yes'):
        a['w'] = 1
    return a


def area_polygon(t):
    """Is this closed way a walkable area (square, platform, station hall)?"""
    if t.get('building') and not t.get('highway') and t.get('public_transport') != 'platform':
        return False
    if t.get('access') in ('no', 'private') and t.get('foot') not in FOOT_OK:
        return False
    if t.get('area:highway') in AREA_KINDS:
        return True
    if t.get('area') == 'yes' and t.get('highway') in AREA_KINDS:
        return True
    if t.get('railway') == 'platform' or t.get('public_transport') == 'platform':
        return t.get('area') != 'no'
    if t.get('highway') == 'pedestrian' and t.get('area') == 'yes':
        return True
    return False


# ------------------------------------------------------------------ geometry (local metres, fine over a few km)

class Proj:
    def __init__(self, lat):
        self.kx = 111320 * math.cos(math.radians(lat))
        self.ky = 110540

    def xy(self, lon, lat):
        return (lon * self.kx, lat * self.ky)


def cross(o, a, b):
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def segments_cross(p1, p2, q1, q2):
    """Proper crossing (touching at an end point does not count)."""
    d1, d2 = cross(q1, q2, p1), cross(q1, q2, p2)
    d3, d4 = cross(p1, p2, q1), cross(p1, p2, q2)
    eps = 1e-6
    return ((d1 > eps and d2 < -eps) or (d1 < -eps and d2 > eps)) and ((d3 > eps and d4 < -eps) or (d3 < -eps and d4 > eps))


def point_in(pt, ring):
    x, y = pt
    c = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def dist_seg(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L2 = dx * dx + dy * dy
    t = 0 if not L2 else max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2))
    return math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1])


def on_or_in(pt, ring, tol=0.3):
    if point_in(pt, ring):
        return True
    return any(dist_seg(pt, ring[i - 1], ring[i]) <= tol for i in range(len(ring)))


class Grid:
    """Segments in 25 m cells, for fast 'does this straight line cross a wall?' checks."""
    def __init__(self, cell=25.0):
        self.cell, self.cells = cell, {}

    def add(self, a, b, tag):
        c = self.cell
        for gx in range(int(min(a[0], b[0]) // c), int(max(a[0], b[0]) // c) + 1):
            for gy in range(int(min(a[1], b[1]) // c), int(max(a[1], b[1]) // c) + 1):
                self.cells.setdefault((gx, gy), []).append((a, b, tag))

    def hits(self, a, b, skip=()):
        c = self.cell
        seen = set()
        for gx in range(int(min(a[0], b[0]) // c), int(max(a[0], b[0]) // c) + 1):
            for gy in range(int(min(a[1], b[1]) // c), int(max(a[1], b[1]) // c) + 1):
                for s in self.cells.get((gx, gy), ()):
                    if id(s) in seen or s[2] in skip:
                        continue
                    seen.add(id(s))
                    if segments_cross(a, b, s[0], s[1]):
                        return True
        return False


# ------------------------------------------------------------------ build

def levels_of(a):
    """Set of floor levels a way is on (None: not stated)."""
    l = a.get('l')
    if l is None:
        return None
    out = set()
    for part in l.split(';'):
        try:
            if '-' in part[1:]:  # a range like -2-0 or 0-2
                i = part.index('-', 1)
                lo, hi = sorted((float(part[:i]), float(part[i + 1:])))
                out.update(x for x in range(int(math.floor(lo)), int(math.ceil(hi)) + 1))
            else:
                out.add(float(part))
        except ValueError:
            pass
    return out or None


def build(bbox, refresh):
    w0, s0, e0, n0 = bbox
    proj = Proj((s0 + n0) / 2)
    nodes = {}      # id → (lon, lat)
    ways = {}       # id → (tags, [node ids])
    pnodes = {}     # id → tags (entrances, barriers, elevators, kerbs)
    rels = {}       # id → (tags, outer rings, inner rings) as [(lon, lat)]: platforms and squares drawn as multipolygons
    blocks = [(s, w, min(s + BLOCK, n0), min(w + BLOCK, e0))
              for s in frange(s0, n0, BLOCK) for w in frange(w0, e0, BLOCK)]
    for i, bb in enumerate(blocks):
        print(f'block {i + 1}/{len(blocks)} {bb}', file=sys.stderr)
        for el in overpass(bb, refresh):
            if el['type'] == 'node':
                nodes[el['id']] = (el['lon'], el['lat'])
                if el.get('tags'):
                    pnodes[el['id']] = el['tags']
            elif el['type'] == 'way' and el.get('geometry'):
                for nid, g in zip(el['nodes'], el['geometry']):
                    if g:
                        nodes[nid] = (g['lon'], g['lat'])
                ways[el['id']] = (el.get('tags', {}), el['nodes'])
            elif el['type'] == 'relation' and el['id'] not in rels:
                ring_of = lambda role: [[(g['lon'], g['lat']) for g in m.get('geometry') or [] if g]
                                        for m in el.get('members', []) if m['type'] == 'way' and m.get('role') in role]
                rels[el['id']] = (el.get('tags', {}), join_rings([o for o in ring_of(('outer', '')) if len(o) >= 2]),
                                  join_rings([o for o in ring_of(('inner',)) if len(o) >= 2]))
    print(f'{len(ways)} ways, {len(nodes)} nodes', file=sys.stderr)

    walk = {}       # way id → (attrs, nodes)
    areas = []      # (id, attrs, ring [(lon, lat)], own way id or None, holes [ring, ...])
    shafts = []     # lift shafts drawn as one outline per floor: (way id, levels, centre, a ring node)
    buildings = {}  # way id → ring node ids
    rails = []      # railway tracks at ground level, as [(lon, lat)]
    walls = Grid()
    for wid, (t, nds) in ways.items():
        nds = [n for n in nds if n in nodes]
        if len(nds) < 2:
            continue
        closed = nds[0] == nds[-1] and len(nds) >= 4
        if t.get('building') and closed and t.get('building') not in ('roof', 'no', 'construction') \
                and t.get('location') != 'underground' and not t.get('layer', '0').startswith('-'):
            buildings[wid] = nds
        if t.get('railway') in ('rail', 'narrow_gauge', 'light_rail') and not t.get('tunnel') and not t.get('bridge') \
                and t.get('layer', '0') == '0' and t.get('level', '0') == '0':
            # tracks on the ground: no straight line may cross them (only a mapped level crossing, bridge or underpass)
            rails.append([nodes[n] for n in nds])
            for a, b in zip(nds, nds[1:]):
                walls.add(proj.xy(*nodes[a]), proj.xy(*nodes[b]), ('r', wid))
        if t.get('barrier') in ('wall', 'fence', 'retaining_wall', 'city_wall', 'hedge', 'handrail', 'guard_rail'):
            for a, b in zip(nds, nds[1:]):
                walls.add(proj.xy(*nodes[a]), proj.xy(*nodes[b]), ('w', wid))
        if closed and t.get('highway') == 'elevator':
            # a lift shaft outline on one floor: walk round it on that floor; the floors are joined below
            lv = t.get('level')
            # one outline for several floors ("-2;-1") is the lift itself; one per floor is walked round on that floor
            multi = len(levels_of({'l': lv}) or ()) > 1
            walk[wid] = ({'k': 'el' if multi else 'fw', 'c': 'i', **({'l': lv} if lv else {}),
                          **({'w': 1} if t.get('wheelchair') == 'no' else {})}, nds)
            ring = [proj.xy(*nodes[n]) for n in nds[:-1]]
            shafts.append((wid, levels_of({'l': lv}) or {0.0}, (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)), nds[0], lv or '0'))
            continue
        if closed and area_polygon(t):
            # an area you may not walk on (foot=no, private) gets no straight lines across it
            aa = walk_attrs({**t, 'highway': t.get('highway') or t.get('area:highway') or 'footway'})
            if aa:
                areas.append((wid, aa, [nodes[n] for n in nds], wid, []))
            # the outline of a square or platform is walkable too (a platform's edge is where you board); as its own
            # way ('o' + id), so its corners can be joined straight across the area like any path that enters it
            if not t.get('highway') or t.get('highway') == 'platform':
                if aa:
                    walk[f'o{wid}'] = (aa, nds)
                continue
        a = walk_attrs(t)
        if a:
            walk[wid] = (a, nds)

    for rid, (t, rings, holes) in rels.items():
        if area_polygon({**t, 'area': t.get('area', 'yes')}):
            a = walk_attrs({**t, 'highway': t.get('highway') or t.get('area:highway') or 'footway'})
            if a:
                areas.extend((f'r{rid}.{i}', a, ring, None, holes) for i, ring in enumerate(rings))
                # its outline, walkable like a closed way's; the relation gives coordinates only, so its corners get
                # ids made from their position (negative: never an OSM id; the same point always gets the same id)
                for i, ring in enumerate(rings):
                    ids = []
                    for lon, lat in ring:
                        nid = -(round(lat * 1e6) * 10_000_000 + round(lon * 1e6))
                        nodes.setdefault(nid, (lon, lat))
                        ids.append(nid)
                    walk[f'o{rid}.{i}'] = (a, ids)

    # lifts: the shaft outlines of one lift on different floors stand on top of each other; join them
    lifts, shaft_nodes = [], set()
    for i in range(len(shafts)):
        for j in range(i + 1, len(shafts)):
            a, b = shafts[i], shafts[j]
            if a[1] != b[1] and math.hypot(a[2][0] - b[2][0], a[2][1] - b[2][1]) < 2.5:
                shared = set(walk[a[0]][1]) & set(walk[b[0]][1])
                if shared:
                    shaft_nodes.update(shared)  # the outlines share a corner: that corner is where the lift is
                else:
                    lifts.append((a[3], b[3], {'k': 'el', 'c': 'i', 'l': f'{a[4]};{b[4]}'}))

    # buildings block straight lines across squares (but a building that is itself the square's hall doesn't)
    bxy = {}
    for bid, nds in buildings.items():
        ring = [proj.xy(*nodes[n]) for n in nds]
        bxy[bid] = ring
        for a, b in zip(ring, ring[1:]):
            walls.add(a, b, ('b', bid))

    # ---- straight lines across walkable areas, between the points where paths meet them
    on_net = {}  # node id → [(way id, attrs)] of the walkable ways through it
    for wid, (a, nds) in walk.items():
        for n in nds:
            on_net.setdefault(n, []).append((wid, a))
    ngrid = {}
    for n in on_net:
        x, y = proj.xy(*nodes[n])
        ngrid.setdefault((int(x // 50), int(y // 50)), []).append((n, (x, y)))
    shortcuts = []
    for wid, a, ring_ll, _, holes_ll in areas:
        ring = [proj.xy(*p) for p in ring_ll]
        holes = [[proj.xy(*p) for p in h] for h in holes_ll]
        xs, ys = [p[0] for p in ring], [p[1] for p in ring]
        if max(xs) - min(xs) > 600 or max(ys) - min(ys) > 600:
            continue
        lv_area = levels_of(a) or {0.0}
        cand = []
        for gx in range(int(min(xs) // 50), int(max(xs) // 50) + 1):
            for gy in range(int(min(ys) // 50), int(max(ys) // 50) + 1):
                for n, p in ngrid.get((gx, gy), ()):
                    others = [x for w, x in on_net[n] if w != wid]
                    if not others or not on_or_in(p, ring):
                        continue
                    # stay on the area's floor: a path on another level only passes above or below it
                    if lv_area & set().union(*[levels_of(x) or {0.0} for x in others]):
                        cand.append((n, p))
        if len(cand) > 90:  # big squares: keep the ends and junctions of paths
            cand = sorted(cand, key=lambda c: -len(on_net[c[0]]))[:90]
        # a hall the area lies in (a station concourse) does not block it; a building standing in the square does
        skip_walls = set()
        for bid, br in bxy.items():
            if br[0][0] < min(xs) - 400 or br[0][0] > max(xs) + 400 or br[0][1] < min(ys) - 400 or br[0][1] > max(ys) + 400:
                continue
            if sum(1 for p in ring[:-1] if on_or_in(p, br, 1.0)) >= 0.8 * (len(ring) - 1):
                skip_walls.add(('b', bid))
        ring_segs = list(zip(ring, ring[1:])) + [s for h in holes for s in zip(h, h[1:])]  # holes are walls too
        for i in range(len(cand)):
            for j in range(i + 1, len(cand)):
                (na, pa), (nb, pb) = cand[i], cand[j]
                L = math.hypot(pa[0] - pb[0], pa[1] - pb[1])
                if L < 3 or L > 350:
                    continue
                if any(segments_cross(pa, pb, q1, q2) for q1, q2 in ring_segs):
                    continue
                mids = [(pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f) for f in (.25, .5, .75)]
                if not all(on_or_in(m, ring) for m in mids) or any(point_in(m, h) for m in mids for h in holes):
                    continue
                if walls.hits(pa, pb, skip_walls):
                    continue
                shortcuts.append((na, nb, {'k': 'ar', **{f: a[f] for f in ('l', 'c', 'n', 'w', 'r') if f in a}}))
    print(f'{len(walk)} walkable ways, {len(areas)} walkable areas ({len(rels)} multipolygons) → {len(shortcuts)} straight '
          f'lines, {len(lifts)} lift links, {len(buildings)} buildings', file=sys.stderr)
    shortcuts += lifts

    # ---- entrances, gates, kerbs, elevators
    node_bld = {}
    for bid, nds in buildings.items():
        for n in nds:
            node_bld.setdefault(n, bid)
    entrances, blocked, kerbs, lift_nodes = [], set(), set(), set(shaft_nodes)
    for nid, t in pnodes.items():
        if nid not in nodes:
            continue
        if (t.get('entrance') or t.get('door')) and t.get('entrance') != 'no' and t.get('door') != 'no':
            typ = t.get('entrance', 'yes')
            if t.get('access') in ('private', 'no') and typ not in ('main',):
                typ = 'private'
            addr = ' '.join(x for x in (t.get('addr:street'), t.get('addr:housenumber')) if x)
            entrances.append((nid, node_bld.get(nid, 0), typ, t.get('wheelchair', ''), addr))
        if t.get('barrier') and (t.get('access') in ('no', 'private') or t.get('locked') == 'yes') \
                and t.get('foot') not in FOOT_OK:
            blocked.add(nid)
        if t.get('kerb') == 'raised' or t.get('barrier') == 'kerb' and t.get('kerb') in ('raised', 'yes', None):
            kerbs.add(nid)
        if t.get('highway') == 'elevator':
            lift_nodes.add(nid)
    return {'nodes': nodes, 'walk': walk, 'shortcuts': shortcuts, 'buildings': buildings, 'rails': rails,
            'entrances': entrances, 'blocked': blocked, 'kerbs': kerbs, 'lifts': lift_nodes}


def simplify(pts, tol):
    """Douglas-Peucker on integer 1e-6° points (tol in the same units; a closed ring keeps its ends)."""
    if len(pts) <= 4:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        a, b = pts[i], pts[j]
        best, bi = -1, -1
        for k in range(i + 1, j):
            p = pts[k]
            dx, dy = b[0] - a[0], b[1] - a[1]
            L = math.hypot(dx, dy)
            d = math.hypot(p[0] - a[0], p[1] - a[1]) if not L else abs(dx * (a[1] - p[1]) - dy * (a[0] - p[0])) / L
            if d > best:
                best, bi = d, k
        if best > tol:
            keep[bi] = True
            stack += [(i, bi), (bi, j)]
    out = [p for p, k in zip(pts, keep) if k]
    return out if len(out) >= 4 else pts


def join_rings(parts):
    """Join the outer ways of a multipolygon into closed rings."""
    parts = [list(p) for p in parts]
    rings = []
    while parts:
        ring = parts.pop()
        while ring[0] != ring[-1]:
            for i, p in enumerate(parts):
                if p[0] == ring[-1]:
                    ring += p[1:]
                elif p[-1] == ring[-1]:
                    ring += p[-2::-1]
                elif p[-1] == ring[0]:
                    ring = p[:-1] + ring
                elif p[0] == ring[0]:
                    ring = p[:0:-1] + ring
                else:
                    continue
                parts.pop(i)
                break
            else:
                break  # not closed: an incomplete relation at the edge of the download
        if ring[0] == ring[-1] and len(ring) >= 4:
            rings.append(ring)
    return rings


def frange(a, b, step):
    out, x = [], a
    while x < b - 1e-9:
        out.append(round(x, 6))
        x += step
    return out


def tile_key(lon, lat):
    return f'{math.floor(lat / TILE + 1e-9)}_{math.floor(lon / TILE + 1e-9)}'


def write_atomic(path, text):
    """Write via a temporary file, so a failed write never leaves half a tile (retried: Windows can hold a lock)."""
    for attempt in range(5):
        try:
            with open(path + '.tmp', 'w', encoding='utf-8') as f:
                f.write(text)
            os.replace(path + '.tmp', path)
            return
        except OSError:
            if attempt == 4:
                raise
            time.sleep(1 + attempt)


def write_tiles(g, bbox):
    nodes = g['nodes']
    tiles = {}

    def tile(key):
        if key not in tiles:
            tiles[key] = {'nodes': {}, 'attrs': {}, 'w': [], 'v': [], 'b': [], 'e': [], 'x': [], 'r': [], 'l': [], 'z': []}
        return tiles[key]

    def keys_of(ids):
        lons = [nodes[n][0] for n in ids]
        lats = [nodes[n][1] for n in ids]
        out = []
        for ty in range(math.floor(min(lats) / TILE), math.floor(max(lats) / TILE) + 1):
            for tx in range(math.floor(min(lons) / TILE), math.floor(max(lons) / TILE) + 1):
                out.append(f'{ty}_{tx}')
        return out

    def idx(t, n):  # placeholder index; renumbered by id when the tile is written
        m = t['nodes']
        if n not in m:
            m[n] = len(m)
        return m[n]

    def attr(t, a):
        s = json.dumps(a, sort_keys=True, ensure_ascii=False)
        if s not in t['attrs']:
            t['attrs'][s] = len(t['attrs'])
        return t['attrs'][s]

    w0, s0, e0, n0 = bbox
    inside = lambda key: key in want
    want = {f'{ty}_{tx}' for ty in range(math.floor(s0 / TILE), math.ceil(n0 / TILE))
            for tx in range(math.floor(w0 / TILE), math.ceil(e0 / TILE))}

    for wid, (a, nds) in g['walk'].items():
        for key in keys_of(nds):
            if inside(key):
                t = tile(key)
                t['w'].append([wid, attr(t, a)] + [idx(t, n) for n in nds])
    for na, nb, a in g['shortcuts']:
        for key in set(keys_of([na, nb])):
            if inside(key):
                t = tile(key)
                t['v'].append([idx(t, na), idx(t, nb), attr(t, a)])
    for bid, nds in g['buildings'].items():
        for key in keys_of(nds):
            if inside(key):
                tile(key)['b'].append((bid, nds))
    for e in g['entrances']:
        key = tile_key(*nodes[e[0]])
        if inside(key):
            t = tile(key)
            t['e'].append([idx(t, e[0])] + list(e[1:]))
    # gates, kerbs and lifts in every tile that has their node (a way crossing a tile border is in both tiles)
    for field, ids in (('x', g['blocked']), ('r', g['kerbs']), ('l', g['lifts'])):
        for n in ids:
            for t in tiles.values():
                if n in t['nodes']:
                    t[field].append(t['nodes'][n])
    for line in g['rails']:
        lons, lats = [p[0] for p in line], [p[1] for p in line]
        for ty in range(math.floor(min(lats) / TILE), math.floor(max(lats) / TILE) + 1):
            for tx in range(math.floor(min(lons) / TILE), math.floor(max(lons) / TILE) + 1):
                if inside(f'{ty}_{tx}'):
                    tile(f'{ty}_{tx}')['z'].append(line)

    os.makedirs(os.path.join(OUT, 't'), exist_ok=True)
    index_path = os.path.join(OUT, 'index.js')
    index = {}
    if os.path.exists(index_path):
        with open(index_path, encoding='utf-8') as f:
            txt = f.read()
        index = json.loads(txt[txt.index('{'):txt.rindex('}') + 1]).get('tiles', {})
    total = 0
    for key, t in sorted(tiles.items()):
        ty, tx = map(int, key.split('_'))
        ox, oy = round(tx * TILE * 1e6), round(ty * TILE * 1e6)
        q = lambda n: (round(nodes[n][0] * 1e6) - ox, round(nodes[n][1] * 1e6) - oy)
        q_ll = lambda p: (round(p[0] * 1e6) - ox, round(p[1] * 1e6) - oy)
        # nodes sorted by id and delta-coded (neighbouring ids lie along the same way): about half the size
        order = sorted(t['nodes'], key=int)
        renum = {t['nodes'][n]: i for i, n in enumerate(order)}
        flat, last = [], (0, 0, 0)
        for n in order:
            x, y = q(n)
            flat += [n - last[0], x - last[1], y - last[2]]
            last = (n, x, y)
        R = lambda i: renum[i]
        t['w'] = [[w[0], w[1]] + [R(i) for i in w[2:]] for w in t['w']]
        t['v'] = [[R(a), R(b), c] for a, b, c in t['v']]
        t['e'] = [[R(e[0])] + e[1:] for e in t['e']]
        for f in ('x', 'r', 'l'):
            t[f] = [R(i) for i in t[f]]
        blds = []
        for bid, nds in t['b']:
            pts = simplify([q(n) for n in nds], 3)  # 0.3 m: plenty to tell inside from outside
            row = [bid, pts[0][0], pts[0][1]]
            for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
                row += [x2 - x1, y2 - y1]
            blds.append(row)
        data = {'o': [ox, oy], 'n': flat, 'a': [json.loads(s) for s, _ in sorted(t['attrs'].items(), key=lambda kv: kv[1])],
                'w': t['w'], 'v': t['v'], 'b': blds, 'e': t['e'], 'x': t['x'], 'r': t['r'], 'l': t['l'],
                'z': [[c for p in line for c in q_ll(p)] for line in t['z']]}
        body = f'window.WALKGRAPH_TILE({json.dumps(key)},{json.dumps(data, separators=(",", ":"), ensure_ascii=False)});\n'
        write_atomic(os.path.join(OUT, 't', key + '.js'), body)
        index[key] = 1
        total += len(body)
    write_atomic(index_path, '// Generated by tools/build_walkgraph.py: the 0.01° tiles of the pedestrian network (walkgraph/t/).\n'
                 + 'window.WALKGRAPH_INDEX = ' + json.dumps({'tile': TILE, 'built': time.strftime('%Y-%m-%d'),
                                                           'tiles': dict(sorted(index.items()))}, separators=(',', ':')) + ';\n')
    print(f'wrote {len(tiles)} tiles, {total / 1e6:.1f} MB (before gzip)', file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--area', choices=sorted(AREAS))
    ap.add_argument('--bbox', help='lon_min,lat_min,lon_max,lat_max')
    ap.add_argument('--refresh', action='store_true', help='fetch OSM again instead of using the cache')
    args = ap.parse_args()
    if args.bbox:
        bbox = tuple(float(v) for v in args.bbox.split(','))
    elif args.area:
        bbox = AREAS[args.area]
    else:
        ap.error('give --area or --bbox')
    # fetch a margin around the area, so ways and squares on its edge are complete
    m = 0.004
    g = build((bbox[0] - m, bbox[1] - m, bbox[2] + m, bbox[3] + m), args.refresh)
    write_tiles(g, bbox)


if __name__ == '__main__':
    main()
