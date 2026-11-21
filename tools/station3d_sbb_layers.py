#!/usr/bin/env python3
"""Write the SBB open-data layers of a station model: tools/station3d_data/<key>/{boards,sectors,furniture}.json.

Formats as in tools/station3d_data/README.md (local metres around the station's origin from STATIONS in
build_station3d.py; x east, y north):
  boards.json     the sector signs (data.sbb.ch "sektortafel"): ref (track), xy, front / back letters, mounting,
                  hanging (on a roof, a mast or a bridge), ref_from, fid
  sectors.json    one centre per sector of each track, { ref, name, xy }. Where the signs stand inside their sector
                  with its letter on both faces ("A|A", Zürich HB) the centre is their middle; where they stand at the
                  borders ("B|C", Wankdorf) it is midway between the two that bound the sector, and an end sector,
                  bounded by one sign only, reaches as far beyond it as its neighbour does on the other side. (The Bern and Wankdorf files were
                  made from SBB's platform-edge data instead, which data.sbb.ch no longer offers.)
  furniture.json  clocks ("haltestelle-uhr") and ticket machines ("billetautomat") inside the model's extent; level from
                  the station's 'sbb_sections' (SBB's section name, e.g. "Zurich HB Lowenstrasse") where given, else
                  none (the builder gives them one)

Usage:
  python tools/station3d_sbb_layers.py zurich              # the station's stop ids and extent from STATIONS
  python tools/station3d_sbb_layers.py zurich --refresh    # download the SBB data again (cached in tools/cache/)

Data: data.sbb.ch (open data; name "data.sbb.ch" as the source).
"""
import argparse
import gzip
import json
import math
import os
import sys
import urllib.request
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_station3d as B  # noqa: E402  (STATIONS, paths)

API = 'https://data.sbb.ch/api/explore/v2.1/catalog/datasets/{}/exports/json'


def fetch(name, refresh=False):
    path = os.path.join(B.CACHE_DIR, f'sbb-{name}.json')
    if refresh or not os.path.exists(path):
        os.makedirs(B.CACHE_DIR, exist_ok=True)
        req = urllib.request.Request(API.format(name), headers={'User-Agent': B.UA, 'Accept-Encoding': 'gzip'})
        with urllib.request.urlopen(req, timeout=300) as r:
            raw = r.read()
        if raw[:2] == bytes([0x1F, 0x8B]):
            raw = gzip.decompress(raw)
        with open(path, 'wb') as f:
            f.write(raw)
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('key', help='station key in STATIONS (build_station3d.py)')
    ap.add_argument('--refresh', action='store_true', help='download the SBB data again')
    ap.add_argument('--out', help='folder to write to (default: tools/station3d_data/<key>/)')
    args = ap.parse_args()
    cfg = B.STATIONS[args.key]
    lon0, lat0 = cfg['origin']
    kx = 111320 * math.cos(math.radians(lat0))

    def xy(g):
        return [round((g['lon'] - lon0) * kx, 2), round((g['lat'] - lat0) * 110540, 2)]

    x0, y0, x1, y1 = cfg['extent']
    inside = lambda p: x0 <= p[0] <= x1 and y0 <= p[1] <= y1
    uics = set(cfg['uics'])
    out = args.out or os.path.join(B.DATA_DIR, args.key)
    os.makedirs(out, exist_ok=True)

    # --- sector signs
    boards = []
    for s in fetch('sektortafel', args.refresh):
        g = s.get('geopos') or {}
        if str(s.get('bpuic')) not in uics or 'lon' not in g:
            continue
        p = xy(g)
        if not inside(p):
            continue
        mount = s.get('montage_an')
        boards.append({'ref': str(s.get('kundengleisnummer') or ''), 'xy': p,
                       'front': s.get('sektor_vorderseite') or '-', 'back': s.get('sektor_ruckseiter') or '-',
                       'mounting': mount, 'hanging': bool(mount) and mount.startswith(('BA-Dach', 'FS-', 'IB-')),
                       'ref_from': 'sbb', 'fid': f"fid {s.get('fid')}"})
    boards = [b for b in boards if b['ref']]
    boards.sort(key=lambda b: (len(b['ref']), b['ref'], b['xy']))

    # --- sector centres: per track, the border signs between two letters; a sector lies between its two borders
    sectors = []
    for ref in sorted({b['ref'] for b in boards}, key=lambda r: (len(r), r)):
        borders = defaultdict(list)   # frozenset of the two letters (or one, at a platform end) → positions
        for b in boards:
            if b['ref'] != ref:
                continue
            letters = frozenset(c for c in (b['front'], b['back']) if c and c != '-')
            if letters:
                borders[letters].append(b['xy'])
        at = {k: [sum(p[0] for p in v) / len(v), sum(p[1] for p in v) / len(v)] for k, v in borders.items()}
        names = sorted({c for k in at for c in k})
        for name in names:
            # signs inside the sector, its letter on both faces ("A|A", as at Zürich HB): their middle
            own = borders.get(frozenset([name]))
            if own:   # signs inside the sector win over a stray border sign ("C|B" on track 18 at Zürich HB)
                c = [sum(p[0] for p in own) / len(own), sum(p[1] for p in own) / len(own)]
                sectors.append({'ref': ref, 'name': name, 'xy': [round(c[0], 2), round(c[1], 2)]})
                continue
            sides = [at[k] for k in at if name in k]
            if len(sides) >= 2:
                a, b2 = max(((p, q) for p in sides for q in sides), key=lambda pq: math.dist(*pq))
                c = [(a[0] + b2[0]) / 2, (a[1] + b2[1]) / 2]
            elif len(sides) == 1:
                # an end sector: as far beyond its one border as the neighbour's centre is on the other side
                border = sides[0]
                key = next(k for k in at if name in k)
                nb = next((x for x in key if x != name), None)
                other = [at[k] for k in at if nb and nb in k and k != key]
                if not other:
                    continue
                far = other[0]
                half = [(border[0] - far[0]) / 2, (border[1] - far[1]) / 2]
                c = [border[0] + half[0], border[1] + half[1]]
            else:
                continue
            sectors.append({'ref': ref, 'name': name, 'xy': [round(c[0], 2), round(c[1], 2)]})

    # --- clocks and ticket machines in the extent
    furniture = []
    sections = cfg.get('sbb_sections', {})   # section of the station (bps_name) -> its level, where SBB says
    for kind, name, mount_key, src in (('clock', 'haltestelle-uhr', 'montage_an', 'SBB haltestelle-uhr'),
                                       ('ticket_machine', 'billetautomat', 'typ_text', 'SBB billetautomat')):
        for r in fetch(name, args.refresh):
            g = r.get('geopos') or {}
            if 'lon' not in g:
                continue
            p = xy(g)
            if inside(p):
                furniture.append({'kind': kind, 'xy': p, 'mounting': r.get(mount_key), 'level': sections.get(r.get('bps_name')), 'source': src,
                                  'source_id': str(r.get('fid') or r.get('id_automat'))})

    for fname, data in (('boards.json', boards), ('sectors.json', sectors), ('furniture.json', furniture)):
        with open(os.path.join(out, fname), 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=0)
            f.write('\n')
    refs = sorted({s['ref'] for s in sectors}, key=lambda r: (len(r), r))
    print(f'{args.key}: {len(boards)} sector signs, {len(sectors)} sector centres on tracks {", ".join(refs)}, '
          f'{sum(f["kind"] == "clock" for f in furniture)} clocks, '
          f'{sum(f["kind"] == "ticket_machine" for f in furniture)} ticket machines → {out}')


if __name__ == '__main__':
    main()
