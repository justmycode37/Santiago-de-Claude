#!/usr/bin/env python3
"""Extract what build_platforms.py needs from an OpenStreetMap extract of Switzerland.

  - every bus / tram stop pole (highway=bus_stop, railway=tram_stop, public_transport=platform|stop_position)
  - the road and tram-track segments within ~40 m of a stop, with their one-way direction
  - platforms that are not at street level (level=*), in the Overpass format osm_levels() reads

Needs pyosmium (pip install osmium). Input: https://download.geofabrik.de/europe/switzerland-latest.osm.pbf

Usage:
  python3 tools/extract_osm_stops.py switzerland-latest.osm.pbf data/raw/traffic-point.csv data/raw/osm-stops.json

Output: { elements: [levels], stops: [[lon, lat, kind, name, ref, uic, modes], ...], roads: [[lon1, lat1, lon2, lat2, kind, oneway], ...] }
  kind (stop): p = platform / pole, s = stop_position (on the road)   modes: "b", "m" or "bm"
  kind (road): r = road, t = tram track   oneway: 1 (drawn direction), -1 (against it), 0 (both ways)
"""
import csv
import json
import math
import sys

import osmium

BUS_ROADS = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary',
             'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street',
             'service', 'busway', 'bus_guideway', 'road'}
CELL = 0.0005  # degrees, ~40 m (lat) × ~55 m (lon)


def cell(lon, lat):
    return int(math.floor(lon / CELL)), int(math.floor(lat / CELL))


def stop_modes(t):
    m = ''
    if t.get('highway') == 'bus_stop' or t.get('bus') in ('yes', 'designated') or t.get('trolleybus') == 'yes':
        m += 'b'
    if t.get('railway') == 'tram_stop' or t.get('tram') in ('yes', 'designated') or t.get('light_rail') == 'yes':
        m += 'm'
    return m


def oneway_of(t):
    if t.get('oneway:bus') == 'no' or t.get('oneway:psv') == 'no' or t.get('busway') == 'opposite_lane':
        return 0
    v = t.get('oneway', '')
    if v in ('yes', '1', 'true') or (t.get('junction') in ('roundabout', 'circular') and v != 'no'):
        return 1
    return -1 if v == '-1' else 0


def main(pbf, traffic_csv, out_path):
    interest = set()
    for r in csv.DictReader(open(traffic_csv, encoding='utf-8-sig'), delimiter=';'):
        if r['uicCountryCode'] == '85' and r['wgs84East']:
            interest.add(cell(float(r['wgs84East']), float(r['wgs84North'])))

    stops, levels = [], []
    for o in osmium.FileProcessor(pbf).with_locations().with_areas().with_filter(
            osmium.filter.KeyFilter('highway', 'railway', 'public_transport')):
        t = o.tags
        relation = o.is_area() and not o.from_way()  # platforms drawn as multipolygons (Zürich HB, Genève)
        if ((t.get('public_transport') == 'platform' or t.get('railway') == 'platform')
                and t.get('level') not in (None, '0') and (o.is_node() or o.is_way() or relation)):
            locs = ([o.location] if o.is_node() else [n.location for n in o.nodes] if o.is_way()
                    else [n.location for ring in o.outer_rings() for n in ring])
            pts = [(n.lon, n.lat) for n in locs if n.valid()] or [(0, 0)]
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            levels.append({'tags': {k: t[k] for k in ('level', 'ref', 'local_ref', 'uic_ref') if k in t},
                           'bounds': {'minlon': min(xs), 'minlat': min(ys), 'maxlon': max(xs), 'maxlat': max(ys)}})
        if not (t.get('highway') == 'bus_stop' or t.get('railway') == 'tram_stop'
                or t.get('public_transport') in ('platform', 'stop_position')):
            continue
        modes = stop_modes(t)
        if not modes:
            continue  # train platforms: ATLAS already has those
        if o.is_node():
            if not o.location.valid():
                continue
            lon, lat = o.location.lon, o.location.lat
        elif o.is_way():
            pts = [(n.lon, n.lat) for n in o.nodes if n.location.valid()]
            if not pts:
                continue
            lon, lat = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
        else:
            continue
        kind = 's' if t.get('public_transport') == 'stop_position' else 'p'
        stops.append([round(lon, 7), round(lat, 7), kind, t.get('name', ''), t.get('local_ref') or t.get('ref', ''),
                      t.get('uic_ref', ''), modes])
        if kind == 'p':
            interest.add(cell(lon, lat))
    print(f'{len(stops)} OSM stop objects, {len(levels)} platforms off street level', file=sys.stderr)

    near = {(x + dx, y + dy) for x, y in interest for dx in (-1, 0, 1) for dy in (-1, 0, 1)}
    roads = []
    for w in osmium.FileProcessor(pbf, osmium.osm.NODE | osmium.osm.WAY).with_locations().with_filter(
            osmium.filter.KeyFilter('highway', 'railway')):
        if not w.is_way():
            continue
        t = w.tags
        hw = t.get('highway')
        if t.get('railway') == 'tram':
            kind = 't'
        elif hw in BUS_ROADS or (hw == 'pedestrian' and (t.get('bus') or t.get('psv')) in ('yes', 'designated')):
            kind = 'r'
        else:
            continue
        ow = 0 if kind == 't' else oneway_of(t)
        pts = [(n.lon, n.lat) for n in w.nodes if n.location.valid()]
        for a, b in zip(pts, pts[1:]):
            steps = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / (CELL / 2)))
            if any(cell(a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps) in near
                   for i in range(steps + 1)):
                roads.append([round(a[0], 7), round(a[1], 7), round(b[0], 7), round(b[1], 7), kind, ow])
    print(f'{len(roads)} road / track segments near stops', file=sys.stderr)

    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump({'source': pbf.replace('\\', '/').rsplit('/', 1)[-1], 'elements': levels, 'stops': stops,
                   'roads': roads}, f,
                  ensure_ascii=False, separators=(',', ':'))


if __name__ == '__main__':
    main(*sys.argv[1:4])
