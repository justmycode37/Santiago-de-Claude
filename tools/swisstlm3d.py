#!/usr/bin/env python3
"""swissTLM3D roads and paths (swisstopo) for tools/build_walkgraph.py: download, read, convert to WGS84.

swissTLM3D is swisstopo's topographic landscape model: every road, track and footpath in Switzerland, drawn by
swisstopo from its own aerial images and field work. Free to use (open government data), with the source named:
"© swisstopo". https://www.swisstopo.admin.ch/en/landscape-model-swisstlm3d

Only the roads-and-paths layer is needed (TLM_STRASSE, about 525 MB to download), so instead of the whole 4.8 GB
release it is fetched straight out of swisstopo's shapefile zip with HTTP range requests, once, into
~/.cache/walkgraph/tlm/<release>/. No GIS libraries: the shapefile and dBase readers below are plain Python.

  python3 tools/swisstlm3d.py            # download the current release's roads-and-paths layer (resumable)
  python3 tools/swisstlm3d.py --fields   # list its attribute columns and the values of the type column
"""
import io, json, math, os, struct, sys, urllib.request, zipfile

STAC = 'https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.swisstlm3d/items?limit=100'
CACHE = os.path.join(os.path.expanduser('~'), '.cache', 'walkgraph', 'tlm')
UA = {'User-Agent': 'santiago-de-claude-walkgraph/1.0 (build-time download, cached)'}
LAYER = 'TLM_STRASSEN/swissTLM3D_TLM_STRASSE'


# ------------------------------------------------------------------ download

class HttpFile(io.RawIOBase):
    """A remote file read with HTTP range requests: enough for zipfile to read the members it is asked for."""

    def __init__(self, url):
        self.url, self.pos = url, 0
        req = urllib.request.Request(url, method='HEAD', headers=UA)
        self.size = int(urllib.request.urlopen(req, timeout=60).headers['Content-Length'])

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def readinto(self, b):
        n = min(len(b), self.size - self.pos)
        if n <= 0:
            return 0
        data = b''
        for attempt in range(6):
            try:
                req = urllib.request.Request(self.url, headers={**UA, 'Range': f'bytes={self.pos}-{self.pos + n - 1}'})
                with urllib.request.urlopen(req, timeout=300) as res:
                    # a server that ignores Range would send the whole 3.6 GB file: accept only the part asked for
                    cr = res.headers.get('Content-Range', '')
                    if res.status != 206 or not cr.startswith(f'bytes {self.pos}-'):
                        raise OSError(f'no range answer (HTTP {res.status}, Content-Range {cr!r})')
                    data = res.read(n)
                break
            except OSError as e:
                if attempt == 5:
                    raise
                print(f'  retrying ({e})', file=sys.stderr)
        b[:len(data)] = data
        self.pos += len(data)
        return len(data)


def latest_release():
    items = json.loads(urllib.request.urlopen(urllib.request.Request(STAC, headers=UA), timeout=60).read())['features']
    item = max(items, key=lambda f: f['properties']['datetime'])
    url = next(a['href'] for a in item['assets'].values() if a['href'].endswith('.shp.zip'))
    return item['id'], url


def fetch(release=None):
    """Download the roads-and-paths layer (once) → path prefix of the local .shp/.dbf/.shx files."""
    rel, url = latest_release() if release is None else (release, None)
    folder = os.path.join(CACHE, rel)
    base = os.path.join(folder, os.path.basename(LAYER))
    if all(os.path.exists(base + ext) for ext in ('.shp', '.dbf', '.shx', '.prj')):
        return base, rel
    if url is None:
        rel, url = latest_release()
    os.makedirs(folder, exist_ok=True)
    z = zipfile.ZipFile(io.BufferedReader(HttpFile(url), buffer_size=1 << 22))
    for ext in ('.prj', '.shx', '.dbf', '.shp'):
        out = base + ext
        if os.path.exists(out):
            continue
        info = z.getinfo(LAYER + ext)
        print(f'downloading {LAYER}{ext} ({info.compress_size / 1e6:.0f} MB) from swisstopo', file=sys.stderr)
        with z.open(info) as src, open(out + '.part', 'wb') as dst:
            while True:
                chunk = src.read(1 << 22)
                if not chunk:
                    break
                dst.write(chunk)
        os.replace(out + '.part', out)
    return base, rel


# ------------------------------------------------------------------ reading

def dbf_fields(path):
    with open(path, 'rb') as f:
        head = f.read(32)
        n, hlen, rlen = struct.unpack('<IHH', head[4:12])
        fields, off = [], 1  # each record starts with a deletion flag
        while True:
            d = f.read(32)
            if d[0] == 0x0D:
                break
            name = d[:11].split(b'\0')[0].decode('latin-1')
            fields.append((name, chr(d[11]), d[16], off))
            off += d[16]
    return n, hlen, rlen, fields


class Dbf:
    """Random access to some columns of a dBase file (records are fixed-length)."""

    def __init__(self, path, columns):
        self.f = open(path, 'rb')
        self.n, self.hlen, self.rlen, fields = dbf_fields(path)
        cp = path[:-4] + '.cpg'
        self.enc = open(cp).read().strip() if os.path.exists(cp) else 'utf-8'
        by = {f[0].upper(): f for f in fields}
        self.cols = [(c, by[c.upper()]) for c in columns if c.upper() in by]

    def row(self, i):
        self.f.seek(self.hlen + i * self.rlen)
        rec = self.f.read(self.rlen)
        out = {}
        for c, (_, typ, size, off) in self.cols:
            v = rec[off:off + size].decode(self.enc, 'replace').strip()
            out[c] = (int(float(v)) if v else None) if typ in 'NF' and v.replace('.', '', 1).lstrip('-').isdigit() else v
        return out


_boxes = {}  # base → (offsets, bounding boxes) of every line, read once per process


def _index(base):
    if base not in _boxes:
        from array import array
        offs, boxes = array('q'), array('d')
        with open(base + '.shx', 'rb') as shx:
            shx.seek(100)
            index = shx.read()
        with open(base + '.shp', 'rb') as shp:
            for i in range(len(index) // 8):
                off = struct.unpack('>i', index[i * 8:i * 8 + 4])[0] * 2
                shp.seek(off + 8)
                head = shp.read(36)
                if struct.unpack('<i', head[:4])[0] not in (3, 13, 23):  # PolyLine, PolyLineZ, PolyLineM
                    offs.append(-1)
                    boxes.extend((0, 0, 0, 0))
                    continue
                offs.append(off)
                boxes.extend(struct.unpack('<4d', head[4:36]))
        _boxes[base] = (offs, boxes)
    return _boxes[base]


def lines_in(base, box_lv95):
    """(record index, [(E, N), ...] per part) for every line whose bounding box meets box_lv95 = (E0, N0, E1, N1)."""
    E0, N0, E1, N1 = box_lv95
    offs, boxes = _index(base)
    with open(base + '.shp', 'rb') as shp:
        for i in range(len(offs)):
            xmin, ymin, xmax, ymax = boxes[4 * i:4 * i + 4]
            if offs[i] < 0 or xmax < E0 or xmin > E1 or ymax < N0 or ymin > N1:
                continue
            shp.seek(offs[i] + 8 + 36)
            nparts, npts = struct.unpack('<2i', shp.read(8))
            parts = struct.unpack(f'<{nparts}i', shp.read(4 * nparts))
            xy = struct.unpack(f'<{2 * npts}d', shp.read(16 * npts))
            pts = list(zip(xy[0::2], xy[1::2]))
            bounds = list(parts) + [npts]
            yield i, [pts[bounds[k]:bounds[k + 1]] for k in range(nparts)]


# ------------------------------------------------------------------ coordinates (swisstopo's approximate formulas, ~1 m)

def lv95_to_wgs84(E, N):
    y, x = (E - 2600000) / 1e6, (N - 1200000) / 1e6
    lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3
    lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.0140 * x ** 3
    return lon * 100 / 36, lat * 100 / 36


def wgs84_to_lv95(lon, lat):
    p, l = (lat * 3600 - 169028.66) / 10000, (lon * 3600 - 26782.5) / 10000
    E = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3
    N = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3
    return E, N


if __name__ == '__main__':
    base, rel = fetch()
    print('swissTLM3D', rel, '→', base)
    if '--fields' in sys.argv:
        n, _, _, fields = dbf_fields(base + '.dbf')
        print(n, 'records;', ', '.join(f'{f[0]}({f[1]}{f[2]})' for f in fields))
