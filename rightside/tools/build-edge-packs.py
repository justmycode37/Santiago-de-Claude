#!/usr/bin/env python3
"""Build RightSide's stop-edge and station-level packs from the web app's data.

Inputs (repository root):
  platforms.js      every Swiss platform / stop edge (ATLAS): position, ref ("A", "7"), compass direction of the
                    vehicles stopping there, OSM floor level where not at street level (tools/build_platforms.py)
  stations3d/*.js   3D models of multi-level stations: real floor heights and the floor of every platform edge
                    (tools/build_station3d.py, format in stations3d/SCHEMA.md)

Outputs (redesign/apps/ios/RightSide/Resources/TransportPacks/):
  stop-edges.json      {"version", "date", "source", "stops": {"<uic>": [mode, [[lonE5, latE5, ref, bearing, level], ...]]}}
                       bus, tram and train stops only (no boats or cable cars); names dropped to keep it small.
  station-levels.json  {"version", "built", "stations": [{"key", "name", "origin": [lon, lat],
                        "levels": [[id, z, name], ...], "stops": [[uic, ref, level, x, y], ...]}]}

Usage: python3 rightside/tools/build-edge-packs.py [--stations DIR]   (DIR defaults to stations3d/ in the repository)
"""
import argparse, glob, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(HERE, '..', 'redesign', 'apps', 'ios', 'RightSide', 'Resources', 'TransportPacks')


def script_json(path, marker='='):
    text = open(path, encoding='utf-8').read()
    start = text.index('{', text.index(marker))
    return json.loads(text[start:text.rindex('}') + 1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--stations', default=os.path.join(ROOT, 'stations3d'))
    args = ap.parse_args()
    platforms = script_json(os.path.join(ROOT, 'platforms.js'), 'PLATFORM_DATA')
    stops = {}
    for uic, (name, mode, edges) in platforms['stops'].items():
        if mode not in ('b', 'm', 't'):  # bus, tram/metro, train
            continue
        rows = []
        for e in edges:
            x, y = e[0], e[1]
            ref = e[2] if len(e) > 2 and e[2] else ''
            bearing = e[3] if len(e) > 3 else None
            level = e[4] if len(e) > 4 else None
            rows.append([x, y, ref, bearing, level])
        stops[uic] = [mode, rows]
    edges_pack = {'version': 1, 'date': platforms.get('date'),
                  'source': 'platforms.js (opentransportdata.swiss ATLAS traffic points; levels from OpenStreetMap)',
                  'stops': stops}
    stations = []
    for path in sorted(glob.glob(os.path.join(args.stations, '*.js'))):
        key = os.path.basename(path)[:-3]
        if key.startswith('_') or key in ('index', 'detail-index') or key.endswith('.detail'):
            continue
        text = open(path, encoding='utf-8').read()
        model = json.loads(text[text.index('{', text.index('] =')):text.rindex('}') + 1])
        stations.append({
            'key': model['key'], 'name': model.get('name', key), 'origin': model['origin'],
            'levels': [[l['id'], l['z'], l.get('name', '')] for l in model['levels']],
            'stops': [[s['uic'], s.get('ref') or '', s['level'], round(s['xy'][0], 1), round(s['xy'][1], 1)]
                      for s in model.get('stops', []) if 'xy' in s],
        })
    levels_pack = {'version': 1, 'built': platforms.get('date'),
                   'source': 'stations3d/ (OpenStreetMap, opentransportdata.swiss, swisstopo, Geodaten Stadt Bern)',
                   'stations': stations}
    os.makedirs(OUT, exist_ok=True)
    for name, pack in (('stop-edges.json', edges_pack), ('station-levels.json', levels_pack)):
        path = os.path.join(OUT, name)
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(pack, f, ensure_ascii=False, separators=(',', ':'))
        print(name, os.path.getsize(path), 'bytes')
    print(len(stops), 'stops,', sum(len(v[1]) for v in stops.values()), 'edges;', len(stations), 'station models')


if __name__ == '__main__':
    main()
