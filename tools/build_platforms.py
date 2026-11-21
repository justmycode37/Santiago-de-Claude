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

Output format (platforms.js):
  window.PLATFORM_DATA = { date, stops: { "<uic>": [name, mode, [[lonE5, latE5, ref?, bearing?, level?], ...]] } }
  mode: t = train, m = tram/metro, b = bus, s = boat, c = cable car / funicular
  level: floor of the platform when it is not street level (e.g. -4 for Zürich HB 31–34)
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


def main():
    if len(sys.argv) >= 3:
        traffic = open(sys.argv[1], encoding='utf-8-sig').read()
        service = open(sys.argv[2], encoding='utf-8-sig').read()
        levels = osm_levels(sys.argv[3] if len(sys.argv) > 3 else None)
    else:
        traffic = actual_date_csv('traffic-point-v2', 'actual-date-world-traffic-point.csv')
        service = actual_date_csv('service-point-v2', 'actual-date-swiss-service-point.csv')
        levels = osm_levels()

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

    out = {}
    n_edges = n_levels = 0
    for uic in sorted(stops):
        st = stops[uic]
        edges = st['edges']
        if not edges:
            if not st['stop']:
                continue
            edges = [{'ref': '', 'main': True, 'bearing': None, 'll': st['ll']}]  # stop without edge data
        edges.sort(key=lambda e: (e['ref'], not e['main']))
        kept = []
        for e in edges:
            # the same edge entered twice (e.g. once per operator) → one dot
            twin = next((k for k in kept if k['ref'] == e['ref'] and near(k['ll'], e['ll'], 8) and same_way(k, e)), None)
            if twin:
                twin['bearing'] = twin['bearing'] if twin['bearing'] is not None else e['bearing']
            else:
                kept.append(e)
        packed = []
        for e in kept:
            x, y = round(e['ll'][0] * 1e5), round(e['ll'][1] * 1e5)
            level = level_of(e, uic, levels)
            item = [x, y, e['ref'], e['bearing'], level]
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
    print(f'{len(out)} stops, {n_edges} platforms/edges ({n_levels} not at street level) → {OUT} ({os.path.getsize(OUT) // 1024} KB)', file=sys.stderr)


if __name__ == '__main__':
    main()
