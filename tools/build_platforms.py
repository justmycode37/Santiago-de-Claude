#!/usr/bin/env python3
"""Build platforms.js: the exact position of every platform (Gleis) and stop edge (Kante) in Switzerland.

Source: opentransportdata.swiss ATLAS master data (via opendata.swiss), "actual date" exports:
  - traffic-point-v2: one row per platform / stop edge, with WGS84 position, designation ("7", "H")
    and compass direction (= direction of travel of the vehicles stopping there)
  - service-point-v2: one row per stop (name, means of transport, position)

Floor levels come from OpenStreetMap (level=* on platforms that are not at street level, via Overpass).

Usage:
  python3 tools/build_platforms.py                                  # download the current data
  python3 tools/build_platforms.py TRAFFIC.csv SERVICE.csv [OSM.json]   # use already downloaded files
  python3 tools/build_platforms.py data/raw/traffic-point.csv data/raw/service-point.csv data/raw/osm-stops.json

Output format (platforms.js):
  window.PLATFORM_DATA = { date, stops: { "<uic>": [name, mode, [[lonE5, latE5, ref?, bearing?, level?, src?], ...]] } }
  mode: t = train, m = tram/metro, b = bus, s = boat, c = cable car / funicular
  level: floor of the platform when it is not street level (e.g. -4 for Zürich HB 31–34)
  src: set when a point is not fully official ATLAS data
       "o" position from OpenStreetMap   "b" direction estimated from the road beside it, not official
       "s" no boarding data at all: only the stop's own position, not a place to stand

Bus and tram stops are completed from OpenStreetMap when the OSM file from tools/extract_osm_stops.py is given:
  - a stop ATLAS has no boarding point for gets the stop poles OSM has for it (same uic_ref or name, ≤ 300 m)
  - a point without an official direction gets one from the road beside it: the direction of a one-way road,
    otherwise the direction that has the point on its right (traffic keeps right). Each build scores this
    rule against the points that do have an official direction and prints the result.
  - a stop whose points all say 0° has no direction (0° there is a placeholder)
"""
import csv
import datetime
import io
import json
import math
import os
import re
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'platforms.js')
CKAN = 'https://ckan.opendata.swiss/api/3/action/package_show?id='
UA = 'Mozilla/5.0 (platforms.js builder)'


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=300) as res:
        return res.read()


def actual_date_csv(package, suffix):
    meta = json.loads(get(CKAN + package))
    for res in meta['result']['resources']:
        url = res.get('download_url') or res.get('url') or ''
        if url.endswith(suffix):
            print('downloading', url.rsplit('/', 1)[-1], file=sys.stderr)
            return get(url).decode('utf-8-sig')
    raise SystemExit(f'{suffix} not found in {package}')


OVERPASS = 'https://overpass-api.de/api/interpreter'
LEVELS_QUERY = """[out:json][timeout:300];
area["ISO3166-1"="CH"][admin_level=2]->.ch;
(nwr(area.ch)["public_transport"="platform"]["level"]["level"!="0"];
 nwr(area.ch)["railway"="platform"]["level"]["level"!="0"];);
out tags bb;"""


def osm_levels(path=None):
    """Platforms that are not at street level: [{refs, uic, level, box}]. Empty when Overpass is unavailable."""
    try:
        if path:
            data = json.load(open(path))
        else:
            print('downloading platform levels from OpenStreetMap (about a minute)', file=sys.stderr)
            req = urllib.request.Request(OVERPASS, data=urllib.parse.urlencode({'data': LEVELS_QUERY}).encode(),
                                         headers={'User-Agent': 'swiss-platforms-builder/1.0'})
            with urllib.request.urlopen(req, timeout=330) as res:
                data = json.loads(res.read())
    except Exception as e:  # levels are a bonus: build without them rather than fail
        print(f'no OSM levels ({e})', file=sys.stderr)
        return []
    out = []
    for el in data.get('elements', []):
        t = el.get('tags', {})
        try:
            level = float(str(t['level']).split(';')[0].split(',')[0])
        except ValueError:
            continue
        b = el.get('bounds') or {'minlon': el.get('lon'), 'maxlon': el.get('lon'), 'minlat': el.get('lat'), 'maxlat': el.get('lat')}
        if b['minlon'] is None:
            continue
        refs = {key_of(r) for r in re.split(r'[;,]', f"{t.get('ref', '')};{t.get('local_ref', '')}") if r.strip()}
        out.append({'refs': refs, 'uic': t.get('uic_ref', ''), 'level': int(level) if level.is_integer() else level,
                    'box': (b['minlon'], b['minlat'], b['maxlon'], b['maxlat'])})
    return out


def key_of(ref):
    """Same as platformKey() in index.html: "7A-D" → "7", "Kante H" → "H"."""
    s = PREFIX.sub('', ref.strip()).upper()
    m = re.match(r'\d+', s)
    return m.group(0) if m else re.sub(r'[^0-9A-Z]', '', s)


def box_dist(ll, box):
    """Metres from a point to a bounding box (0 inside)."""
    x = min(max(ll[0], box[0]), box[2])
    y = min(max(ll[1], box[1]), box[3])
    dx = (ll[0] - x) * 111320 * math.cos(math.radians(ll[1]))
    dy = (ll[1] - y) * 110540
    return math.hypot(dx, dy)


def level_of(edge, uic, levels):
    """The OSM floor level of an edge: the nearest non-street-level platform within 20 m that is the same one."""
    best = None
    for p in levels:
        if p['uic'] and p['uic'] != uic:
            continue
        if p['refs'] and edge['ref'] and key_of(edge['ref']) not in p['refs']:
            continue  # another platform of the same station (e.g. platform 3 above 31–34)
        d = box_dist(edge['ll'], p['box'])
        if d <= 20 and (best is None or d < best[0]):
            best = (d, p['level'])
    return best[1] if best else None


def rows(text):
    return csv.DictReader(io.StringIO(text), delimiter=';')


def mode_of(means):
    m = means.upper()
    if 'TRAIN' in m or 'RACK_RAILWAY' in m:
        return 't'
    if 'TRAM' in m or 'METRO' in m:
        return 'm'
    if 'BOAT' in m:
        return 's'
    if 'CABLE' in m or 'CHAIRLIFT' in m or 'ELEVATOR' in m:
        return 'c'
    return 'b'


TEMPORARY = re.compile(r'ersatz|umleitung|remplacement|sostitut', re.I)
PREFIX = re.compile(r'^(gleis|gl\.|kante|quai|voie|binario|steg|perron)\s+', re.I)


def ref_of(designation):
    ref = PREFIX.sub('', designation.strip())
    return ref if len(ref) <= 4 else ''  # long texts ("Strandbad", "PARKPL") are notes, not platform names


def near(a, b, metres):
    dx = (a[0] - b[0]) * 111320 * math.cos(math.radians(a[1]))
    dy = (a[1] - b[1]) * 110540
    return dx * dx + dy * dy <= metres * metres


def same_way(a, b):
    if a['bearing'] is None or b['bearing'] is None:
        return True
    return abs((a['bearing'] - b['bearing'] + 180) % 360 - 180) <= 30


def offset_m(ll, origin):
    """(east, north) in metres from origin."""
    return ((ll[0] - origin[0]) * 111320 * math.cos(math.radians(origin[1])), (ll[1] - origin[1]) * 110540)


def angle_diff(a, b):
    return abs((a - b + 180) % 360 - 180)


GRID = 0.0005  # degrees, ~40-55 m
SIDE_MIN = 1.5  # metres from the road's centre line below which the side of the road is unclear


def grid_of(ll):
    return int(math.floor(ll[0] / GRID)), int(math.floor(ll[1] / GRID))


def index_points(items, ll_of):
    grid = {}
    for it in items:
        grid.setdefault(grid_of(ll_of(it)), []).append(it)
    return grid


def around(grid, ll, rings=1):
    x, y = grid_of(ll)
    for dx in range(-rings, rings + 1):
        for dy in range(-rings, rings + 1):
            yield from grid.get((x + dx, y + dy), ())


class Roads:
    """Road and tram-track segments near stops, from tools/extract_osm_stops.py."""

    def __init__(self, segments):
        self.grid = {}
        for seg in segments:
            a, b = (seg[0], seg[1]), (seg[2], seg[3])
            steps = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / (GRID / 2)))
            for c in {grid_of((a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps))
                      for i in range(steps + 1)}:
                self.grid.setdefault(c, []).append(seg)

    def bearing_at(self, ll, kinds):
        """Direction of travel of vehicles stopping at ll, or None when the road beside it is not clear."""
        found = []
        for seg in {id(s): s for s in around(self.grid, ll)}.values():
            if seg[4] not in kinds:
                continue
            ax, ay = offset_m((seg[0], seg[1]), ll)
            bx, by = offset_m((seg[2], seg[3]), ll)
            dx, dy = bx - ax, by - ay
            n = dx * dx + dy * dy
            if n == 0:
                continue
            t = max(0, min(1, -(ax * dx + ay * dy) / n))
            fx, fy = ax + t * dx, ay + t * dy  # nearest point of the segment (ll is the origin)
            found.append((math.hypot(fx, fy), math.degrees(math.atan2(dx, dy)) % 360, seg[5], -fx, -fy))
        if not found:
            return None
        found.sort()
        d, heading, oneway, px, py = found[0]
        if d > 25 or (d < SIDE_MIN and not oneway):
            return None  # no road nearby, or the point is on the centre line: no side to tell
        for d2, h2, *_ in found[1:]:
            # another road just as close that runs another way (a junction): don't guess
            if d2 - d < 3 and min(angle_diff(h2, heading), angle_diff(h2, heading + 180)) > 30:
                return None
        if oneway:
            return round(heading if oneway > 0 else heading + 180) % 360
        hx, hy = math.sin(math.radians(heading)), math.cos(math.radians(heading))
        on_right = px * hy - py * hx > 0  # the point is right of the road's drawn direction
        return round(heading if on_right else heading + 180) % 360


def norm_name(name):
    return re.sub(r'[^0-9a-zäöüéèàâêîôûç]+', ' ', name.lower()).strip()


def osm_poles(st, uic, osm_grid, taken):
    """OSM stop poles of a stop that ATLAS has no boarding point for: [(lon, lat), ...]."""
    full = norm_name(st['name'])
    short = norm_name(st['name'].split(',', 1)[-1])
    poles = []
    for lon, lat, kind, name, ref, uic_ref, modes in around(osm_grid, st['ll'], rings=7):
        if kind != 'p' or (st['mode'] == 'b' and 'b' not in modes):
            continue
        if not near((lon, lat), st['ll'], 300) or (uic_ref != uic and norm_name(name) not in (full, short)):
            continue
        if any(near((lon, lat), q, 20) for q in around(taken, (lon, lat))):
            continue  # a boarding point of another stop is right there
        if not any(near((lon, lat), q, 12) for q in poles):  # pole node and platform drawn for the same pole
            poles.append((lon, lat))
    return poles if len(poles) <= 6 else []


def main():
    if len(sys.argv) >= 3:
        traffic = open(sys.argv[1], encoding='utf-8-sig').read()
        service = open(sys.argv[2], encoding='utf-8-sig').read()
        levels = osm_levels(sys.argv[3] if len(sys.argv) > 3 else None)
        osm = json.load(open(sys.argv[3], encoding='utf-8')) if len(sys.argv) > 3 else {}
    else:
        traffic = actual_date_csv('traffic-point-v2', 'actual-date-world-traffic-point.csv')
        service = actual_date_csv('service-point-v2', 'actual-date-swiss-service-point.csv')
        levels = osm_levels()
        osm = {}
    roads = Roads(osm.get('roads', []))
    osm_grid = index_points(osm.get('stops', []), lambda s: (s[0], s[1]))

    stops = {}
    for r in rows(service):
        if r['uicCountryCode'] != '85' or not r['wgs84East']:
            continue
        stops[r['number']] = {
            'name': r['designationOfficial'],
            'mode': mode_of(r['meansOfTransport']),
            'stop': r['stopPoint'] == 'true',
            'll': (float(r['wgs84East']), float(r['wgs84North'])),
            'edges': [],
        }

    for r in rows(traffic):
        if r['trafficPointElementType'] != 'BOARDING_PLATFORM' or r['uicCountryCode'] != '85' or not r['wgs84East']:
            continue
        if TEMPORARY.search(r['designation']):
            continue  # replacement / diversion stops only used during works
        st = stops.setdefault(r['number'], {
            'name': r['designationOfficial'], 'mode': 'b', 'stop': True,
            'll': (float(r['wgs84East']), float(r['wgs84North'])), 'edges': [],
        })
        st['edges'].append({
            'ref': ref_of(r['designation']),
            # several entries can share a designation (platform sections); the "main" one goes first
            'main': r['designation'] == r['designationOperational'],
            'bearing': round(float(r['compassDirection'])) % 360 if r['compassDirection'] else None,
            'll': (float(r['wgs84East']), float(r['wgs84North'])),
        })

    taken = index_points([e['ll'] for st in stops.values() for e in st['edges']], lambda ll: ll)
    out = {}
    n_edges = n_levels = 0
    n = {'stops filled from OSM': 0, 'OSM poles': 0, 'stops without data': 0, 'stops with 0° only': 0,
         'directions from the road': 0}
    score = []  # (official direction, direction from the road) for every point that has an official one
    for uic in sorted(stops):
        st = stops[uic]
        edges = st['edges']
        street = st['mode'] in 'bm'
        if edges and all(e['bearing'] == 0 for e in edges):
            n['stops with 0° only'] += 1
            for e in edges:
                e['bearing'] = None  # 0° everywhere is a placeholder, not a direction
        if not edges:
            if not st['stop']:
                continue
            poles = osm_poles(st, uic, osm_grid, taken) if street else []
            n['stops filled from OSM'] += bool(poles)
            n['OSM poles'] += len(poles)
            n['stops without data'] += not poles
            # without edge data: the OSM poles, or else only the stop's own position (not a place to stand)
            edges = [{'ref': '', 'main': True, 'bearing': None, 'll': ll, 'src': 'o'} for ll in poles] or \
                    [{'ref': '', 'main': True, 'bearing': None, 'll': st['ll'], 'src': 's'}]
        edges.sort(key=lambda e: (e['ref'], not e['main']))
        kept = []
        for e in edges:
            # the same edge entered twice (e.g. once per operator) → one dot
            twin = next((k for k in kept if k['ref'] == e['ref'] and near(k['ll'], e['ll'], 8) and same_way(k, e)), None)
            if twin:
                twin['bearing'] = twin['bearing'] if twin['bearing'] is not None else e['bearing']
            else:
                kept.append(e)
        for e in kept:
            if not street or e.get('src') == 's':
                continue
            guess = roads.bearing_at(e['ll'], 'rt' if st['mode'] == 'm' else 'r')
            if e['bearing'] is not None:
                score.append((e['bearing'], guess))
            elif guess is not None:
                e['bearing'] = guess
                e['src'] = e.get('src', '') + 'b'
                n['directions from the road'] += 1
        guessed = [e for e in kept if 'b' in e.get('src', '')]
        if len(kept) == 2 and guessed and kept[0]['bearing'] is not None and kept[1]['bearing'] is not None \
                and angle_diff(kept[0]['bearing'], kept[1]['bearing']) < 60:
            for e in guessed:  # two points facing the same way: the guess contradicts the other point, drop it
                e['bearing'], e['src'] = None, e['src'].replace('b', '')
                n['directions from the road'] -= 1
                n['dropped: contradict the other point'] = n.get('dropped: contradict the other point', 0) + 1
        packed = []
        for e in kept:
            x, y = round(e['ll'][0] * 1e5), round(e['ll'][1] * 1e5)
            level = level_of(e, uic, levels)
            item = [x, y, e['ref'], e['bearing'], level, e.get('src', '')]
            while len(item) > 2 and item[-1] in (None, ''):
                item.pop()  # drop empty trailing fields
            n_levels += level is not None
            packed.append(item)
        out[uic] = [st['name'], st['mode'], packed]
        n_edges += len(packed)

    data = {'date': datetime.date.today().isoformat(), 'stops': out}
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write('// Generated by tools/build_platforms.py. Source: opentransportdata.swiss (ATLAS service + traffic points).\n')
        f.write('window.PLATFORM_DATA = ')
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')
    tried = [(a, b) for a, b in score if b is not None]
    if tried:
        good = sum(angle_diff(a, b) <= 60 for a, b in tried)
        print(f'self-check, direction from the road vs official direction: {len(tried)} of {len(score)} points '
              f'get one, {good} ({100 * good / len(tried):.1f} %) within 60°', file=sys.stderr)
    print(n, file=sys.stderr)
    print(f'{len(out)} stops, {n_edges} platforms/edges ({n_levels} not at street level) → {OUT} ({os.path.getsize(OUT) // 1024} KB)', file=sys.stderr)


if __name__ == '__main__':
    main()
