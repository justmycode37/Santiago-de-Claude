"""Doors from the official building address register (swisstopo "Amtliches Gebäudeadressverzeichnis").

Every Swiss building address has a point, and the rules for placing it say: at the building's entrance. Measured
against OpenStreetMap's mapped doors with the same address, the point is a median 1.4 m from the door in Bern and Basel
and 3 to 6 m in Zürich, Geneva and Lausanne (there often a few metres inside the building or in front of it). Snapped
onto the building's outline it is a median 0.8 m (Bern), 0.9 m (Basel), 1.7 m (Lausanne), 2.4 m (Geneva) and 5.8 m
(Zürich) from the mapped door.

OpenStreetMap has doors for most buildings in Bern and Basel but few elsewhere (0.03 per building in central Geneva),
so build_walkgraph.py adds a door at each register point of a building that has no OSM door.

    points(bbox)  → [(lon, lat, egaid, "Street 12")] of the real (not planned or retired) addresses in bbox

The national CSV (~140 MB zipped) is downloaded once into ~/.cache/walkgraph/gwr and cut down to a compact cache.
"""
import gzip
import io
import os
import sys
import urllib.request
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import swisstlm3d  # noqa: E402  (LV95 → WGS84)

URL = ('https://data.geo.admin.ch/ch.swisstopo.amtliches-gebaeudeadressverzeichnis/'
       'amtliches-gebaeudeadressverzeichnis_ch/amtliches-gebaeudeadressverzeichnis_ch_2056.csv.zip')
CACHE = os.path.join(os.path.expanduser('~'), '.cache', 'walkgraph', 'gwr')
ZIP = os.path.join(CACHE, 'adr.csv.zip')
POINTS = os.path.join(CACHE, 'points.tsv.gz')  # lon, lat, egaid, "street number" of real addresses
UA = {'User-Agent': 'santiago-de-claude-walkgraph/1.0 (build-time download, cached)'}


def _download():
    os.makedirs(CACHE, exist_ok=True)
    print('downloading the building address register from swisstopo (~140 MB)', file=sys.stderr)
    with urllib.request.urlopen(urllib.request.Request(URL, headers=UA), timeout=120) as src, \
            open(ZIP + '.part', 'wb') as dst:
        while True:
            b = src.read(1 << 20)
            if not b:
                break
            dst.write(b)
    os.replace(ZIP + '.part', ZIP)


def _cache():
    if os.path.exists(POINTS):
        return
    if not os.path.exists(ZIP):
        _download()
    z = zipfile.ZipFile(ZIP)
    member = next(i for i in z.infolist() if i.filename.endswith('.csv'))
    kept = 0
    with io.TextIOWrapper(z.open(member), encoding='utf-8-sig') as f, \
            gzip.open(POINTS + '.part', 'wt', encoding='utf-8') as out:
        H = {c: i for i, c in enumerate(f.readline().rstrip('\n').split(';'))}
        for line in f:
            r = line.rstrip('\n').split(';')
            # a few rows have ";" inside a field: skipped (they would need a real CSV parser)
            if len(r) != len(H) or r[H['ADR_STATUS']] != 'real' or not r[H['ADR_EASTING']] or not r[H['ADR_NUMBER']]:
                continue
            lon, lat = swisstlm3d.lv95_to_wgs84(float(r[H['ADR_EASTING']]), float(r[H['ADR_NORTHING']]))
            addr = f"{r[H['STN_LABEL']]} {r[H['ADR_NUMBER']]}".strip().replace('\t', ' ')
            out.write(f'{lon:.7f}\t{lat:.7f}\t{r[H["ADR_EGAID"]]}\t{addr}\n')
            kept += 1
    if kept < 2_000_000:
        raise SystemExit(f'address register too small ({kept} addresses): delete {ZIP} and run again')
    os.replace(POINTS + '.part', POINTS)
    print(f'{kept} addresses cached in {POINTS}', file=sys.stderr)


def points(bbox):
    """The real addresses inside bbox (lon_min, lat_min, lon_max, lat_max)."""
    _cache()
    w, s, e, n = bbox
    out = []
    with gzip.open(POINTS, 'rt', encoding='utf-8') as f:
        for line in f:
            lon, lat, egaid, addr = line.rstrip('\n').split('\t')
            lon, lat = float(lon), float(lat)
            if w <= lon <= e and s <= lat <= n:
                out.append((lon, lat, int(egaid), addr))
    return out
