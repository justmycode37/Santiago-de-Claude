#!/usr/bin/env python3
"""Build stations3d/<key>.solid.js: the inside of a station as one continuous 3D building, for station3d-solid.js.

The station model (stations3d/<key>.js, SCHEMA.md) is made for routing: walkable areas, a graph, connectors as lines.
This step adds what it takes to *see* the inside of the building at true heights, as an architectural cutaway:

  slabs      per level, the floor you stand on: the union of the model's walkable areas (floors, plazas, platforms,
             rooms) at the level's real height, with the wells cut out where stairs and escalators go up or down
             through it (so you look down an escalator into the floor below)
  walls      OSM indoor=wall lines (doorways left open); the edges of indoor floors only as kerbs (OSM has no walls
             below ground, and floors the builder derived from paths have guessed outlines); railings round the wells
  rooms      named shops, kiosks, toilets, ticket offices, ... mapped as outlines; pins for those mapped as points
  connectors every stair (real steps: step count from OSM, else rise / 0.17 m), escalator (direction), ramp and lift
             (the levels it serves) with true heights
  tracks, labels (platforms, sectors, named halls and passages, entrances), building shells

Sources: the station model, and OpenStreetMap from the builder's cache (tools/cache/<key>.osm.json, made by
tools/build_station3d.py). Nothing is downloaded here.

Usage:
  python tools/station3d_solid.py zurich        # needs stations3d/zurich.js and tools/cache/zurich.osm.json

Output: stations3d/<key>.solid.js sets (window.STATION3D_SOLID = window.STATION3D_SOLID || {})[key] = {
  key, levels: [{ id, z, name }],               z = floor height (m, level 0 = 0)
  slabs: [{ level, z, rings: [outer, hole, …] }], rings as [[x, y], …] in the model's local metres
  walls: [{ level, z, line: [[x, y], …], kind: 'edge' | 'wall' | 'rail' }]   wall = OSM indoor=wall (doorways open);
             edge = the edge of an indoor floor (a kerb, not a wall: OSM has no walls below ground); rail = round a well
  rooms: [{ level, z, ring, name, kind, height }]   named rooms only, schematic height
  pins: [{ level, z, x, y, name, kind }]            shops and services OSM has as points (all of ShopVille)
  connectors: [{ kind, pts: [[x, y, z], …], width, levels: [lo, hi], dir?, steps?, steep? }]  (lifts: { kind: 'elevator', xy, zs: [z, …] }),
  tracks: [{ z, line, kind? }] (kind 'tram': in the street, metre gauge), labels: [{ kind, text, x, y, z }], shell: (as in the model) }
"""
import json
import math
import os
import re
import sys

from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import polygonize, unary_union

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import build_station3d as B  # noqa: E402

STEP_RISE = 0.17          # m per step where OSM gives no step count
WALL_GAP = 0.6            # an edge this close to an outdoor area or a track is not a wall
ROOM_REACH = 3.0          # a room counts when it is this close to the walkable floor of its level
SHOP_KINDS = {
    'food': {'restaurant', 'fast_food', 'cafe', 'bar', 'pub', 'ice_cream', 'bakery', 'confectionery', 'pastry',
             'deli', 'food_court', 'biergarten'},
    'shop': None,  # any shop=*
    'service': {'ticket', 'travel_agency', 'information', 'bureau_de_change', 'bank', 'atm', 'post_office',
                'pharmacy', 'luggage_locker', 'left_luggage', 'police', 'lost_property_office', 'office'},
    'toilets': {'toilets', 'shower'},
}


def load_model(key):
    path = os.path.join(B.OUT_DIR, f'{key}.js')
    with open(path, encoding='utf-8') as f:
        txt = f.read()
    return json.loads(txt[txt.index('] = ') + 4:].rstrip().rstrip(';'))


def polys(geom):
    if geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    return [g for g in getattr(geom, 'geoms', []) if isinstance(g, Polygon)]


def rnd(pts, z=None):
    return [[round(p[0], 2), round(p[1], 2)] + ([round(z, 2)] if z is not None else []) for p in pts]


def lines_of(geom):
    if geom.is_empty:
        return []
    if geom.geom_type == 'LineString':
        return [geom]
    if geom.geom_type == 'LinearRing':
        return [LineString(geom.coords)]
    return [g for g in getattr(geom, 'geoms', []) if g.geom_type in ('LineString', 'LinearRing')]


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    key = sys.argv[1]
    cfg = B.STATIONS[key]
    m = load_model(key)
    levels = sorted(m['levels'], key=lambda l: l['id'])
    zs = [(l['id'], l['z']) for l in levels]

    def z_of(level):
        if level <= zs[0][0]:
            return zs[0][1] + (level - zs[0][0]) * 4.0
        for (a, za), (b, zb) in zip(zs, zs[1:]):
            if level <= b:
                return za + (zb - za) * (level - a) / (b - a)
        return zs[-1][1] + (level - zs[-1][0]) * 4.0

    ids = [l['id'] for l in levels]
    ceiling = {}
    for i, l in enumerate(levels):
        gap = (levels[i + 1]['z'] - l['z']) if i + 1 < len(levels) else 5.0
        ceiling[l['id']] = round(max(2.4, min(gap - 0.4, 5.0)), 2)

    # ---------------------------------------------------------------- slabs: walkable areas, minus the wells
    outdoor = {l: [] for l in ids}
    walk = {l: [] for l in ids}
    open_floor = {l: [] for l in ids}   # the same without the model's rooms (for telling a hall from a shop below)
    derived = {l: [] for l in ids}   # floors the builder made from paths: their outline is a guess, never a wall
    for a in m['areas']:
        lv = a['level']
        if lv not in walk:
            continue
        try:
            P = Polygon(a['ring'], a.get('holes') or []).buffer(0)
        except Exception:
            continue
        walk[lv].append(P)
        if a['kind'] != 'room':
            open_floor[lv].append(P)
        if a.get('derived'):
            derived[lv].append(P)
        if a['kind'] == 'plaza' or (a['kind'] == 'platform' and lv >= 0):
            outdoor[lv].append(P)
    walk = {l: unary_union(v).buffer(0.05).buffer(-0.05) if v else Polygon() for l, v in walk.items()}
    open_floor = {l: unary_union(v) if v else Polygon() for l, v in open_floor.items()}
    outdoor = {l: unary_union(v) if v else Polygon() for l, v in outdoor.items()}
    derived = {l: unary_union(v) if v else Polygon() for l, v in derived.items()}

    # the part of a stair / escalator that is below floor L passes through L's slab: cut it out (the well)
    wells = {l: [] for l in ids}
    for c in m['connectors']:
        if c['kind'] == 'elevator':
            continue
        pts = c['line']
        w = max(c.get('width') or 1.5, 1.0) / 2 + 0.35
        lo, hi = min(p[2] for p in pts), max(p[2] for p in pts)
        for L in ids:
            if not (lo < L <= hi + 0.01) or L - lo < 0.3:
                continue
            below = []
            for (x1, y1, l1), (x2, y2, l2) in zip(pts, pts[1:]):
                cut = L - 0.02   # up to the landing: the opening reaches the floor edge where you step off
                if l1 < cut or l2 < cut:
                    t1 = 0.0 if l1 < cut else (cut - l1) / (l2 - l1)
                    t2 = 1.0 if l2 < cut else (cut - l1) / (l2 - l1)
                    t1, t2 = max(0.0, min(1.0, t1)), max(0.0, min(1.0, t2))
                    a = (x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1)
                    b = (x1 + (x2 - x1) * t2, y1 + (y2 - y1) * t2)
                    if math.dist(a, b) > 0.3:
                        below.append(LineString([a, b]))
            for seg in below:
                wells[L].append(seg.buffer(w, cap_style='flat', join_style='mitre'))
    # where a stair / escalator arrives on a floor: no railing across it
    landings = {l: [] for l in ids}
    for c in m['connectors']:
        if c['kind'] == 'elevator':
            continue
        w = max(c.get('width') or 1.5, 1.0) / 2 + 0.9
        for (x, y, lv) in (c['line'][0], c['line'][-1]):
            if lv in landings:
                landings[lv].append(Point(x, y).buffer(w + 0.6))
    landings = {l: unary_union(v) if v else None for l, v in landings.items()}
    slabs, rails = [], []
    for L in ids:
        S = walk[L]
        if S.is_empty:
            continue
        holes = unary_union(wells[L]) if wells[L] else Polygon()
        S2 = S.difference(holes).buffer(0) if not holes.is_empty else S
        for P in polys(S2.simplify(0.15)):
            if P.area < 2:
                continue
            slabs.append({'level': L, 'z': z_of(L), 'rings': [rnd(P.exterior.coords)] + [rnd(r.coords) for r in P.interiors]})
        # railings round the wells (where a well cuts into the floor)
        if not holes.is_empty:
            ring = holes.boundary.intersection(S.buffer(-0.2))
            if landings[L] is not None:
                ring = ring.difference(landings[L])
            for g in lines_of(ring):
                if g.length > 1:
                    rails.append({'level': L, 'z': z_of(L), 'line': rnd(g.simplify(0.1).coords), 'kind': 'rail'})

    # ---------------------------------------------------------------- walls
    osm = json.load(open(os.path.join(B.CACHE_DIR, f'{key}.osm.json'), encoding='utf-8'))['elements']
    lon0, lat0 = cfg['origin']
    kx = 111320 * math.cos(math.radians(lat0))
    to_xy = lambda g: ((g['lon'] - lon0) * kx, (g['lat'] - lat0) * 110540)
    tracks_by_level = {l: [] for l in ids}
    for t in m['tracks']:
        if t['level'] in tracks_by_level:
            tracks_by_level[t['level']].append(LineString(t['line']))
    tracks_union = {l: unary_union(v) if v else None for l, v in tracks_by_level.items()}
    walls = list(rails)
    for L in ids:
        S = walk[L]
        if S.is_empty:
            continue
        indoor = S.difference(outdoor[L].buffer(WALL_GAP)) if not outdoor[L].is_empty else S
        edge = S.boundary
        if not outdoor[L].is_empty:
            edge = edge.difference(outdoor[L].buffer(WALL_GAP))
        if tracks_union[L] is not None:
            edge = edge.difference(tracks_union[L].buffer(4.0))   # along the tracks: a platform edge, not a wall
        if not derived[L].is_empty:
            edge = edge.difference(derived[L].buffer(WALL_GAP))
        if indoor.is_empty:
            continue
        edge = edge.intersection(indoor.buffer(WALL_GAP))
        for g in lines_of(edge):
            if g.length > 1.5:
                walls.append({'level': L, 'z': z_of(L), 'line': rnd(g.simplify(0.15).coords), 'kind': 'edge'})
    doors = {l: [] for l in ids}
    for e in osm:
        t = e.get('tags', {})
        if e['type'] == 'node' and (t.get('door') or t.get('entrance')) and t.get('level'):
            for L in (B.parse_levels(t) or []):
                if L in doors:
                    doors[L].append(Point(to_xy(e)).buffer(0.9))
    doors = {l: unary_union(v) if v else None for l, v in doors.items()}
    rooms, pins = [], []
    for e in osm:
        t = e.get('tags', {})
        if e['type'] == 'node' or not t.get('level'):
            continue
        lv = B.parse_levels(t)
        if not lv or len(lv) != 1 or lv[0] not in walk:
            continue
        L = lv[0]
        geom = e.get('geometry') or []
        rel_poly = None
        if e['type'] == 'relation':
            outer = [LineString([to_xy(p) for p in mem['geometry'] if p]) for mem in e.get('members', [])
                     if mem.get('role') == 'outer' and len(mem.get('geometry') or []) >= 2]
            rel_poly = unary_union(list(polygonize(outer))) if outer else None
            geom = [p for mem in e.get('members', []) if mem.get('role') == 'outer' for p in (mem.get('geometry') or [])]
        pts = [to_xy(p) for p in geom if p]
        if len(pts) < 2:
            continue
        near = walk[L].buffer(ROOM_REACH)
        if t.get('indoor') == 'wall':
            g = LineString(pts)
            if g.intersects(near):
                for q in lines_of(g.difference(doors[L]) if doors[L] is not None else g):   # doorways stay open
                    if q.length > 0.5:
                        walls.append({'level': L, 'z': z_of(L), 'line': rnd(q.coords), 'kind': 'wall'})
            continue
        is_room = t.get('indoor') in ('room', 'area') or 'shop' in t or t.get('amenity') in \
            set().union(*(v for v in SHOP_KINDS.values() if v))
        if not is_room or len(pts) < 4 or t.get('indoor') in ('corridor', 'level'):
            continue
        try:
            P = rel_poly if rel_poly is not None else Polygon(pts).buffer(0)
        except Exception:
            continue
        if P is None or P.is_empty or P.area < 3 or P.area > 1500 or not P.intersects(near):
            continue
        # a "room" that is mostly walkable floor is a hall or a concourse (Halle Landesmuseum, Plaza): not a block
        # (a shop the station model has as a room of its own is part of walk[L]: it is measured against the
        # floor without the rooms)
        if P.intersection(open_floor[L]).area > 0.3 * P.area:
            continue
        if not (t.get('shop') or t.get('amenity') or t.get('name')):
            continue   # an unnamed room (offices, plant rooms) is not drawn: it would only block the view
        if t.get('access') in ('private', 'no'):
            continue
        am, sh = t.get('amenity', ''), t.get('shop', '')
        kind = ('toilets' if am in SHOP_KINDS['toilets'] else 'food' if am in SHOP_KINDS['food'] or sh in SHOP_KINDS['food']
                else 'service' if am in SHOP_KINDS['service'] or t.get('office') else 'shop' if sh else 'room')
        for Q in polys(P.simplify(0.15)):
            rooms.append({'level': L, 'z': z_of(L), 'ring': rnd(Q.exterior.coords), 'name': t.get('name') or t.get('brand') or '',
                          'kind': kind, 'height': 2.6})   # schematic: OSM has no room heights

    for e in osm:
        t = e.get('tags', {})
        if e['type'] != 'node' or not t.get('level') or not (t.get('shop') or t.get('amenity')):
            continue
        am, sh = t.get('amenity', ''), t.get('shop', '')
        if am and not sh and not any(am in v for v in SHOP_KINDS.values() if v):
            continue   # benches, bins, vending machines, ...
        lv = B.parse_levels(t)
        if not lv or len(lv) != 1 or lv[0] not in walk:
            continue
        L = lv[0]
        x, y = to_xy(e)
        if walk[L].distance(Point(x, y)) > 12:
            continue
        kind = ('toilets' if am in SHOP_KINDS['toilets'] else 'food' if am in SHOP_KINDS['food'] or sh in SHOP_KINDS['food']
                else 'service' if am in SHOP_KINDS['service'] else 'shop')
        pins.append({'level': L, 'z': round(z_of(L), 2), 'x': round(x, 1), 'y': round(y, 1),
                     'name': t.get('name') or t.get('brand') or '', 'kind': kind})

    # ---------------------------------------------------------------- connectors with true heights
    step_counts = []
    for e in osm:
        t = e.get('tags', {})
        if e['type'] == 'way' and t.get('highway') == 'steps' and t.get('step_count') and e.get('geometry'):
            try:
                n = int(re.sub(r'\D', '', t['step_count']))
            except ValueError:
                continue
            step_counts.append((LineString([to_xy(p) for p in e['geometry']]).centroid, n))
    conns = []
    for c in m['connectors']:
        if c['kind'] == 'elevator':
            conns.append({'kind': 'elevator', 'xy': rnd([c['xy']])[0], 'zs': [round(z_of(l), 2) for l in c['levels']]})
            continue
        pts = [[p[0], p[1], z_of(p[2])] for p in c['line']]
        item = {'kind': c['kind'], 'pts': rnd([(p[0], p[1]) for p in pts]), 'width': c.get('width') or 1.5}
        for i, p in enumerate(pts):
            item['pts'][i].append(round(p[2], 2))
        if c.get('oneway'):
            item['dir'] = c['oneway']
        item['levels'] = [round(min(p[2] for p in c['line']), 2), round(max(p[2] for p in c['line']), 2)]
        run = LineString([(p[0], p[1]) for p in pts]).length
        rise = abs(pts[-1][2] - pts[0][2])
        if run > 0 and math.degrees(math.atan2(rise, run)) > 40:
            item['steep'] = True    # OSM draws it shorter than it is: shown as a striped slope, not as steps
        if c['kind'] == 'stairs':
            rise = abs(pts[-1][2] - pts[0][2])
            mid = LineString([(p[0], p[1]) for p in pts]).centroid
            osm_n = min(((mid.distance(q), n) for q, n in step_counts), default=(99, 0))
            item['steps'] = osm_n[1] if osm_n[0] < 3 and abs(osm_n[1] * STEP_RISE - rise) < 2.5 else max(1, round(rise / STEP_RISE))
        conns.append(item)

    # ---------------------------------------------------------------- tracks, labels
    tracks = [{'z': round(z_of(t['level']) - (0.0 if t.get('kind') == 'tram' else 1.1), 2), 'line': rnd(t['line']),
               **({'kind': t['kind']} if t.get('kind') else {})} for t in m['tracks'] if t['level'] in walk]
    labels = []
    seen = set()
    for a in m['areas']:
        if a['kind'] == 'platform' and a.get('refs'):
            P = Polygon(a['ring']).representative_point()
            txt = ' / '.join(a['refs'])
            if (txt, a['level']) in seen:
                continue
            seen.add((txt, a['level']))
            labels.append({'kind': 'platform', 'text': txt, 'x': round(P.x, 1), 'y': round(P.y, 1), 'z': round(z_of(a['level']), 2)})
        elif a.get('name') and a['kind'] in ('floor', 'plaza'):
            if (a['name'], a['level']) in seen:
                continue
            seen.add((a['name'], a['level']))
            P = Polygon(a['ring']).representative_point()
            labels.append({'kind': 'place', 'text': a['name'], 'x': round(P.x, 1), 'y': round(P.y, 1), 'z': round(z_of(a['level']), 2)})
    for s in m.get('sectors', []):
        lv = next((st['level'] for st in m['stops'] if st.get('ref') == s['ref']), 0)
        labels.append({'kind': 'sector', 'text': s['name'], 'ref': s['ref'], 'x': s['xy'][0], 'y': s['xy'][1], 'z': round(z_of(lv), 2)})
    for e in m.get('entrances', []):
        labels.append({'kind': 'entrance', 'text': e['name'], 'x': e['xy'][0], 'y': e['xy'][1], 'z': round(z_of(e['level']), 2)})
    for r in rooms:
        if r['name']:
            P = Polygon(r['ring']).representative_point()
            labels.append({'kind': 'room', 'text': r['name'], 'x': round(P.x, 1), 'y': round(P.y, 1), 'z': round(r['z'] + r['height'], 2)})

    out = {'key': key, 'name': m['name'], 'origin': m['origin'], 'built': m['built'], 'attribution': m['attribution'],
           'levels': [{'id': l['id'], 'z': l['z'], 'name': l.get('name', '')} for l in levels],
           'slabs': slabs, 'walls': walls, 'rooms': rooms, 'pins': pins, 'connectors': conns, 'tracks': tracks, 'labels': labels,
           'shell': m.get('shell', [])}
    path = os.path.join(B.OUT_DIR, f'{key}.solid.js')
    with open(path, 'w', encoding='utf-8') as f:
        f.write('// Generated by tools/station3d_solid.py from stations3d/%s.js and OpenStreetMap. Read by station3d-solid.js.\n' % key)
        f.write('(window.STATION3D_SOLID = window.STATION3D_SOLID || {})[%s] = ' % json.dumps(key))
        f.write(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
        f.write(';\n')
    # which stations have a companion: stations3d/solid-index.js (the app offers the inside view only for these)
    keys = sorted(f[:-len('.solid.js')] for f in os.listdir(B.OUT_DIR) if f.endswith('.solid.js'))
    with open(os.path.join(B.OUT_DIR, 'solid-index.js'), 'w', encoding='utf-8') as f:
        f.write('// Generated by tools/station3d_solid.py: station models with a continuous 3D view (station3d-solid.html).\n')
        f.write('window.STATION3D_SOLID_INDEX = ' + json.dumps({k: {'file': f'stations3d/{k}.solid.js'} for k in keys}) + ';\n')
    kinds = {}
    for r in rooms:
        kinds[r['kind']] = kinds.get(r['kind'], 0) + 1
    print(f'{key}: {len(slabs)} slabs, {sum(1 for w in walls if w["kind"] == "edge")} wall edges, '
          f'{sum(1 for w in walls if w["kind"] == "wall")} OSM walls, {len(rails)} railings, {len(rooms)} rooms {kinds}, '
          f'{len(pins)} shop pins, {len(conns)} connectors ({sum(1 for c in conns if c.get("steep"))} steep), {len(labels)} labels → {path} ({os.path.getsize(path) // 1024} KB)')


if __name__ == '__main__':
    main()
