#!/usr/bin/env python3
"""Build stop-images/: a reference-image database of what Swiss stops look like, for the camera Scan mode.

For every stop in platforms.js (ATLAS: trains, trams, buses, boats, cable cars) it collects photos of the stop from
open sources, records where each photo comes from and how sure we are that it shows that stop, and stores a compact
image fingerprint (embedding) of each photo. The phone then only has to fingerprint its own camera frame and compare
it with the fingerprints of the stops around it: no photos are downloaded on the phone.

Sources (provenance code → how the photo is tied to the stop):
  wd   Wikidata: the image (P18) of the item with this stop's UIC/IBNR number              identity link
  cat  Wikimedia Commons: in the stop's own category (Wikidata P373, or a "... (tram stop)" category found
       on photos near the stop whose name matches the stop)                                identity link
  sbb  SBB open data "Images of train stations" (data.sbb.ch), by UIC number              identity link
  osm  OpenStreetMap: image= / wikimedia_commons= / panoramax= / mapillary= on the stop    identity link
  geo  Commons: photo taken within ~40 m whose title, description or categories name the stop or a
       transit word (tram, bus, Haltestelle, Bahnhof, gare, fermata, ...)                  candidate
  pnx  Panoramax street-level photo taken 3–35 m away and facing the stop edge             candidate (by geometry)
  mly  Mapillary street-level photo taken 3–35 m away and facing the stop edge
       (only with a Mapillary client token: MAPILLARY_TOKEN env var or --mapillary-token-file)
Photos are capped per stop and per edge so heavily photographed stations do not win by numbers.

Fingerprints: DINOv2-small (onnx-community/dinov2-small, int8 ONNX, pinned revision), the same model file the
browser runs. Preprocessing (both sides): RGB, shortest edge → 224 px (bilinear), centre crop 224×224,
ImageNet mean/std. Descriptor = [CLS token, mean of patch tokens], each L2-normalised, concatenated (768 values),
stored as int8 (base64).

Output (script files, so the app also works when opened as a file):
  stop-images/index.js          window.STOP_IMAGES_INDEX = { v, date, model, tile, tiles: {key: count}, sources }
  stop-images/t/<key>.js        STOP_IMAGES_TILE("<key>", { "<uic>": [[src, prov, edge, lonE5, latE5, heading,
                                    thumb, page, credit, licence, emb_b64], ...] })
  key = "<floor(lat*10)>_<floor(lon*10)>" (0.1° tiles, ~11 × 8 km)

Usage:
  pip install onnxruntime pillow numpy
  python3 tools/build_stop_images.py --area bern                 # one city (see AREAS)
  python3 tools/build_stop_images.py --bbox 7.38,46.92,7.50,46.98
  python3 tools/build_stop_images.py --all                       # all of Switzerland (hours; resumable)
  python3 tools/build_stop_images.py --area zurich --modes m,b   # only tram + bus stops
Downloads and API answers are cached in ~/.cache/stopvision, so a run that stops can simply be started again.
Areas built earlier are kept: each run merges into the existing tiles.
"""
import argparse
import base64
import csv
import concurrent.futures as cf
import datetime
import hashlib
import html
import io
import json
import math
import os
import re
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'stop-images')
CACHE = os.path.join(os.path.expanduser('~'), '.cache', 'stopvision')
UA = 'santiago-de-claude-stop-images/1.0 (open-source transit app; https://github.com/justmycode37/Santiago-de-Claude)'

MODEL_REPO = 'onnx-community/dinov2-small'
MODEL_REV = '8b1f705a3a7f6f062f6bdd21986c1583d3ef105d'
MODEL_FILE = 'onnx/model_quantized.onnx'
INPUT = 224
MEAN = (0.485, 0.456, 0.406)
STD = (0.229, 0.224, 0.225)

AREAS = {  # lon_min, lat_min, lon_max, lat_max
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

MAX_PER_STOP = 10        # all sources together
MAX_GEO_PER_STOP = 4     # Commons photos linked only by place + words
MAX_STREET_PER_EDGE = 3  # Panoramax / Mapillary per stop edge

TRANSIT_WORDS = ('tram', 'bus', 'haltestelle', 'station', 'bahnhof', 'gare', 'stazione', 'fermata', 'arret', 'arrêt',
                 'perron', 'gleis', 'platform', 'quai', 'binario', 'kante', 'trolleybus', 'postauto', 'sbb', 'cff',
                 'ffs', 'bls', 'rhb', 'vbz', 'bernmobil', 'tpg', 'bvb', 'tl ', 'metro', 'funicular', 'standseilbahn',
                 'ferry', 'schiff', 'debarcadere', 'débarcadère', 'landungssteg', 'stop')
REJECT_WORDS = ('map', 'karte', 'plan ', 'logo', 'diagram', 'fahrplan', 'timetable', 'coat of arms', 'wappen',
                'interior', 'innenraum', 'cab ', 'führerstand', 'model', 'modell', 'museum', 'historic', 'history of',
                'postcard', 'postkarte', 'drawing', 'zeichnung', 'aerial', 'luftbild', 'night sky')


# ---------------------------------------------------------------- helpers
def log(*a):
    print(*a, file=sys.stderr, flush=True)


_last = {}
_lock = threading.Lock()


def polite(host, gap):
    """At most one request per `gap` seconds per host."""
    with _lock:
        wait = _last.get(host, 0) + gap - time.time()
        _last[host] = max(time.time(), _last.get(host, 0) + gap)
    if wait > 0:
        time.sleep(wait)


GAPS = {'tiles.mapillary.com': 0.1, 'commons.wikimedia.org': 0.25, 'upload.wikimedia.org': 0.25, 'query.wikidata.org': 1.0, 'api.panoramax.xyz': 0.2,
        'graph.mapillary.com': 0.02, 'overpass-api.de': 5.0, 'data.sbb.ch': 0.5}


def fetch(url, data=None, headers=None, cache=True, binary=False, tries=5):
    key = hashlib.sha1((url + (data.decode() if data else '')).encode()).hexdigest()
    path = os.path.join(CACHE, 'http', key[:2], key + ('.bin' if binary else '.json'))
    if cache and os.path.exists(path):
        with open(path, 'rb') as f:
            body = f.read()
        return body if binary else json.loads(body)
    host = urllib.parse.urlsplit(url).hostname or ''
    for attempt in range(tries):
        polite(host, GAPS.get(host, 0.05))
        try:
            req = urllib.request.Request(url, data=data, headers={'User-Agent': UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=90) as res:
                body = res.read()
            if not binary:
                json.loads(body)  # only cache valid answers
            if cache:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                tmp = f'{path}.{os.getpid()}.{threading.get_ident()}.tmp'
                with open(tmp, 'wb') as f:
                    f.write(body)
                safe_replace(tmp, path)
            return body if binary else json.loads(body)
        except urllib.error.HTTPError as e:
            if e.code in (400, 401, 403, 404, 410):
                raise
            time.sleep(min(60, 2 ** attempt * 2))  # 429 / 5xx: back off
        except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError):
            time.sleep(min(60, 2 ** attempt * 2))
    raise RuntimeError(f'gave up on {url[:120]}')


_stop_state = threading.local()  # per worker thread: did a request fail while collecting the current stop?


def safe_replace(tmp, path, keep_theirs=True):
    """Swap a finished temporary file in. On Windows that fails while another process reads the file (two builds
    side by side): try again briefly; for caches (keep_theirs), the other process's identical copy will do."""
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if keep_theirs and os.path.exists(path):
                break
            time.sleep(0.1 * (attempt + 1))
    try:
        os.remove(tmp)
    except OSError:
        pass
    if not (keep_theirs and os.path.exists(path)):
        raise PermissionError(f'could not write {path}')


def try_fetch(*a, **k):
    try:
        return fetch(*a, **k)
    except Exception as e:  # one failing request must not stop a national build
        if not (isinstance(e, urllib.error.HTTPError) and e.code == 404):
            _stop_state.failed = True  # a source that did not answer: this stop is incomplete, not "no photos"
        log('  !', str(e)[:160])
        return None


def norm(s):
    s = unicodedata.normalize('NFKD', str(s)).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()


def name_tokens(name):
    """Distinctive words of a stop name: 'Bern, Zytglogge' → {'zytglogge'}; keeps the town for 'Bern Bahnhof'."""
    parts = [p.strip() for p in str(name).split(',')]
    local = parts[-1] if len(parts) > 1 else parts[0]
    generic = {'bahnhof', 'station', 'gare', 'stazione', 'post', 'dorf', 'zentrum', 'centre', 'centro', 'nord', 'sud',
               'ost', 'west', 'platz', 'strasse', 'bhf', 'sbb', 'cff', 'ffs', 'ch', 'de', 'la', 'le', 'les', 'du', 'des',
               'am', 'an', 'im', 'bei', 'via', 'b', 'st'}
    toks = {t for t in norm(local).split() if len(t) >= 4 and t not in generic}
    if not toks:  # 'Bahnhof' alone: use the town
        toks = {t for t in norm(parts[0]).split() if len(t) >= 4 and t not in generic}
    return toks


def dist_m(a, b):
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111320


def bearing(a, b):
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    return (math.degrees(math.atan2((b[0] - a[0]) * k, b[1] - a[1])) + 360) % 360


def angle_diff(a, b):
    return abs((a - b + 540) % 360 - 180)


def strip_html(s):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', s or ''))).strip()


TILE = 0.02  # degrees


def tile_key(lon, lat):
    return f'{math.floor(lat / TILE + 1e-9)}_{math.floor(lon / TILE + 1e-9)}'


# ---------------------------------------------------------------- stops
def load_stops():
    with open(os.path.join(ROOT, 'platforms.js'), encoding='utf-8') as f:
        text = f.read()
    data = json.loads(text[text.index('{'):text.rindex('}') + 1])
    stops = {}
    for uic, (name, mode, raw) in data['stops'].items():
        edges = [(x / 1e5, y / 1e5) for x, y, *_ in raw]
        c = (sum(e[0] for e in edges) / len(edges), sum(e[1] for e in edges) / len(edges))
        r = max(dist_m(c, e) for e in edges)
        stops[uic] = {'uic': uic, 'name': name, 'mode': mode, 'edges': edges, 'c': c, 'r': r}
    return stops


# ---------------------------------------------------------------- sources
COMMONS = 'https://commons.wikimedia.org/w/api.php?'
II = dict(prop='imageinfo|categories|coordinates', iiprop='url|extmetadata|size|mime', iiurlwidth='500',
          iiextmetadatafilter='Artist|LicenseShortName|DateTimeOriginal|ImageDescription', clshow='!hidden',
          cllimit='max', colimit='max', format='json', formatversion='2')


def commons_pages(params):
    out, cont = [], {}
    for _ in range(10):
        d = try_fetch(COMMONS + urllib.parse.urlencode({'action': 'query', **II, **params, **cont}))
        if not d:
            break
        out += (d.get('query') or {}).get('pages', [])
        if 'continue' not in d:
            break
        cont = d['continue']
    # with continuation, prop data of one page can arrive in several parts: merge them by title
    merged = {}
    for p in out:
        m = merged.setdefault(p['title'], {'title': p['title']})
        for k, v in p.items():
            if isinstance(v, list):
                m.setdefault(k, [])
                m[k] += [x for x in v if x not in m[k]]
            else:
                m.setdefault(k, v)
    return list(merged.values())


def commons_ref(p, prov, edge=None):
    ii = (p.get('imageinfo') or [{}])[0]
    if not ii.get('thumburl') or ii.get('mime') not in ('image/jpeg', 'image/png', 'image/webp'):
        return None
    if min(ii.get('width', 0), ii.get('height', 0)) < 300:
        return None
    md = ii.get('extmetadata') or {}
    lic = strip_html(md.get('LicenseShortName', {}).get('value', ''))
    if not re.match(r'(?i)(cc[ -]?by|cc[ -]?by[ -]?sa|cc0|cc[ -]zero|public domain|pd\b|attribution)', lic) \
            or re.search(r'(?i)\b(nc|nd)\b', lic):
        return None
    co = (p.get('coordinates') or [{}])[0]
    thumb = ii['thumburl'].split('?')[0]
    return {'src': 'commons', 'prov': prov, 'edge': edge, 'lon': co.get('lon'), 'lat': co.get('lat'), 'heading': None,
            'thumb': thumb, 'page': ii.get('descriptionurl', '').split('?')[0],
            'credit': strip_html(md.get('Artist', {}).get('value', ''))[:80] or 'Wikimedia Commons',
            'licence': strip_html(md.get('LicenseShortName', {}).get('value', ''))[:40],
            'date': strip_html(md.get('DateTimeOriginal', {}).get('value', ''))[:10],
            'text': ' '.join([p['title'], strip_html(md.get('ImageDescription', {}).get('value', ''))[:300]]
                             + [c['title'] for c in p.get('categories', [])])}


def wikidata(stops):
    """UIC → {'images': [file titles], 'cats': [category names]} for stations Wikidata knows by UIC/IBNR."""
    q = """SELECT ?id ?img ?cat WHERE {
      { ?item wdt:P954 ?id } UNION { ?item wdt:P722 ?id }
      OPTIONAL { ?item wdt:P18 ?img } OPTIONAL { ?item wdt:P373 ?cat } }"""
    d = try_fetch('https://query.wikidata.org/sparql?' + urllib.parse.urlencode({'query': q, 'format': 'json'}),
                  headers={'Accept': 'application/sparql-results+json'})
    out = {}
    for b in (d or {}).get('results', {}).get('bindings', []):
        uic = re.sub(r'\D', '', b['id']['value'])
        if len(uic) == 7 and uic.startswith('85') and uic in stops:
            e = out.setdefault(uic, {'images': set(), 'cats': set()})
            if 'img' in b:
                e['images'].add('File:' + urllib.parse.unquote(b['img']['value'].rsplit('/', 1)[-1]).replace('_', ' '))
            if 'cat' in b:
                e['cats'].add(b['cat']['value'])
    # Many tram and bus stop items have no UIC/IBNR: tie them to a stop by position (< 80 m) and name
    q2 = """SELECT ?item ?coord ?img ?cat ?label WHERE {
      VALUES ?cls { wd:Q55488 wd:Q548662 wd:Q2175765 wd:Q953806 wd:Q928830 wd:Q1793804 wd:Q2298537 }
      ?item wdt:P31 ?cls; wdt:P17 wd:Q39; wdt:P625 ?coord.
      FILTER NOT EXISTS { ?item wdt:P954 [] }
      { ?item wdt:P18 ?img } UNION { ?item wdt:P373 ?cat }
      ?item rdfs:label ?label. FILTER(LANG(?label) IN ("de", "fr", "it", "en")) }"""
    d = try_fetch('https://query.wikidata.org/sparql?' + urllib.parse.urlencode({'query': q2, 'format': 'json'}),
                  headers={'Accept': 'application/sparql-results+json'})
    grid = {}
    for s in stops.values():
        grid.setdefault((round(s['c'][0], 2), round(s['c'][1], 2)), []).append(s)
    by_pos = 0
    for b in (d or {}).get('results', {}).get('bindings', []):
        m = re.match(r'Point\(([-\d.]+) ([-\d.]+)\)', b['coord']['value'])
        if not m:
            continue
        ll = (float(m.group(1)), float(m.group(2)))
        near = [s for dx in (-0.01, 0, 0.01) for dy in (-0.01, 0, 0.01)
                for s in grid.get((round(ll[0] + dx, 2), round(ll[1] + dy, 2)), [])]
        words = set(norm(b['label']['value']).split())
        best = min((s for s in near if name_tokens(s['name']) & words), default=None,
                   key=lambda s: min(dist_m(ll, e) for e in s['edges']))
        if not best or min(dist_m(ll, e) for e in best['edges']) > 80:
            continue
        e = out.setdefault(best['uic'], {'images': set(), 'cats': set()})
        if 'img' in b:
            e['images'].add('File:' + urllib.parse.unquote(b['img']['value'].rsplit('/', 1)[-1]).replace('_', ' '))
        if 'cat' in b:
            e['cats'].add(b['cat']['value'])
        by_pos += 1
    log(f'wikidata: {len(out)} stops with an item ({by_pos} links by position + name)')
    return out


def sbb_images():
    d = try_fetch('https://data.sbb.ch/api/explore/v2.1/catalog/datasets/bilder-von-bahnhofen/records?limit=100')
    out = {}
    for r in (d or {}).get('results', []):
        f = r.get('file') or {}
        if r.get('nummer') and f.get('url'):
            out.setdefault(str(r['nummer']), []).append(
                {'src': 'sbb', 'prov': 'sbb', 'edge': None, 'lon': None, 'lat': None, 'heading': None,
                 'thumb': f['url'], 'page': 'https://data.sbb.ch/explore/dataset/bilder-von-bahnhofen/',
                 'credit': 'SBB CFF FFS', 'licence': 'SBB open data', 'date': '', 'text': r.get('name', '')})
    log(f'sbb: {len(out)} stations')
    return out


def osm_tagged(bbox):
    """Stops in OSM that link a photo themselves: uic_ref / name → list of (kind, value, lon, lat)."""
    q = f"""[out:json][timeout:180];
    nwr["public_transport"]({bbox[1]},{bbox[0]},{bbox[3]},{bbox[2]})->.s;
    (nwr.s["image"]; nwr.s["wikimedia_commons"]; nwr.s["panoramax"]; nwr.s["mapillary"];);
    out tags center;"""
    d = try_fetch('https://overpass-api.de/api/interpreter', data=urllib.parse.urlencode({'data': q}).encode())
    out = []
    for el in (d or {}).get('elements', []):
        t = el.get('tags', {})
        ll = (el.get('lon') or el.get('center', {}).get('lon'), el.get('lat') or el.get('center', {}).get('lat'))
        for k in ('wikimedia_commons', 'image', 'panoramax', 'mapillary'):
            for v in str(t.get(k, '')).split(';'):
                if v.strip():
                    out.append({'kind': k, 'value': v.strip(), 'll': ll, 'uic': re.sub(r'\D', '', t.get('uic_ref', '')),
                                'name': t.get('name', '')})
    log(f'osm: {len(out)} photo links on stops')
    return out


def panoramax_facing(stop, ei, edge):
    q = urllib.parse.urlencode({'place_position': f'{edge[0]},{edge[1]}', 'place_distance': '3-35',
                                'place_fov_tolerance': '50', 'limit': '12'})
    d = try_fetch('https://api.panoramax.xyz/api/search?' + q)
    refs = []
    for f in (d or {}).get('features', []):
        props, assets = f.get('properties', {}), f.get('assets', {})
        sd = (assets.get('sd') or assets.get('thumb') or {}).get('href')
        lon, lat = f['geometry']['coordinates'][:2]
        if not sd or (props.get('pers:interior_orientation') or {}).get('field_of_view') == 360:
            continue  # 360° panoramas would need re-projection; skip
        lic = next((l.get('title', '') for l in f.get('links', []) if l.get('rel') == 'license'), 'CC-BY-SA-4.0')
        who = ', '.join(p.get('name', '') for p in f.get('providers', []) if p.get('name')) or 'Panoramax'
        refs.append({'src': 'panoramax', 'prov': 'pnx', 'edge': ei, 'lon': lon, 'lat': lat,
                     'heading': props.get('view:azimuth'), 'thumb': sd,
                     'page': f'https://api.panoramax.xyz/#focus=pic&pic={f["id"]}', 'credit': who[:80],
                     'cache_key': f'pnx-{f["id"]}',
                     'dist': dist_m((lon, lat), edge),
                     'licence': lic.replace('License for this object (', '').rstrip(')')[:40],
                     'date': (props.get('datetime') or '')[:10], 'text': ''})
    return refs


# Mapillary's image search by area returns nothing in practice, so read its coverage vector tiles (zoom 14, layer
# "image": every photo with position, compass angle and date) and look photos up by id afterwards.
def _varint(b, i):
    r = s = 0
    while True:
        c = b[i]; i += 1
        r |= (c & 0x7f) << s; s += 7
        if c < 0x80:
            return r, i


def _fields(b):
    i = 0
    while i < len(b):
        key, i = _varint(b, i)
        f, t = key >> 3, key & 7
        if t == 0:
            v, i = _varint(b, i)
        elif t == 2:
            n, i = _varint(b, i); v = b[i:i + n]; i += n
        elif t == 5:
            v = b[i:i + 4]; i += 4
        elif t == 1:
            v = b[i:i + 8]; i += 8
        else:
            raise ValueError('bad protobuf')
        yield f, t, v


def _packed(b):
    out, i = [], 0
    while i < len(b):
        v, i = _varint(b, i); out.append(v)
    return out


def _zz(n):
    return (n >> 1) ^ -(n & 1)


def mvt_points(data, z, x, y, layer_name='image'):
    """Points of one layer of a Mapbox vector tile → [(lon, lat, {props})]."""
    import struct
    out = []
    for f, _, layer in _fields(data):
        if f != 3:
            continue
        name, keys, values, feats, extent = '', [], [], [], 4096
        for lf, lt, lv in _fields(layer):
            if lf == 1: name = lv.decode()
            elif lf == 2: feats.append(lv)
            elif lf == 3: keys.append(lv.decode())
            elif lf == 4:
                val = None
                for vf, vt, vv in _fields(lv):
                    val = vv.decode() if vf == 1 else struct.unpack('<f', vv)[0] if vf == 2 else \
                        struct.unpack('<d', vv)[0] if vf == 3 else _zz(vv) if vf == 6 else \
                        (vv - (1 << 64) if vv >= 1 << 63 else vv) if vf == 4 else bool(vv) if vf == 7 else vv
                values.append(val)
            elif lf == 5: extent = lv
        if name != layer_name:
            continue
        for feat in feats:
            tags, geom = [], []
            for ff, ft, fv in _fields(feat):
                if ff == 2: tags = _packed(fv)
                elif ff == 4: geom = _packed(fv)
            if len(geom) < 3 or geom[0] & 7 != 1:
                continue
            px, py = _zz(geom[1]), _zz(geom[2])
            n = 2 ** z
            lon = (x + px / extent) / n * 360 - 180
            lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + py / extent) / n))))
            out.append((lon, lat, {keys[tags[k]]: values[tags[k + 1]] for k in range(0, len(tags) - 1, 2)}))
    return out


_mly_tiles = {}
_mly_lock = threading.Lock()


def mapillary_points(lon, lat, token):
    dx, dy = 40 / (111320 * math.cos(math.radians(lat))), 40 / 111320
    tiles = {_mly_tile(lon + a, lat + b) for a in (-dx, dx) for b in (-dy, dy)}
    return [p for x, y in sorted(tiles) for p in _mly_near(x, y, lon, lat, token)]


def _mly_tile(lon, lat, z=14):
    return (int((lon + 180) / 360 * 2 ** z), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2 ** z))


_mly_tile_locks = {}


def _mly_near(x, y, lon, lat, token, z=14):
    with _mly_lock:
        lock = _mly_tile_locks.setdefault((x, y), threading.Lock())
    with lock:  # one download per coverage tile; other tiles download at the same time
        grid = _mly_tiles.get((x, y))
        if grid is None:
            body = try_fetch(f'https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}?access_token={token}',
                             binary=True)
            pts = mvt_points(body, z, x, y) if body else []
            grid = {}
            for p in pts:  # bucket by ~100 m for quick lookups
                grid.setdefault((round(p[0] * 1000), round(p[1] * 1000)), []).append(p)
            _mly_tiles[(x, y)] = grid
    return [p for dx in (-1, 0, 1) for dy in (-1, 0, 1) for p in grid.get((round(lon * 1000) + dx, round(lat * 1000) + dy), [])]


MLY = {'ok': None}  # None = not checked yet


_mly_check = threading.Lock()


def mapillary_usable(token):
    """Image lookups need an app with the READ permission; the coverage tiles work without it."""
    with _mly_check:
        return _mapillary_usable(token)


def _mapillary_usable(token):
    if MLY['ok'] is None:
        try:
            pts = mapillary_points(7.4478, 46.9480, token)  # Bern old town: always has photos
            fetch(f'https://graph.mapillary.com/{pts[0][2]["id"]}?' + urllib.parse.urlencode(
                {'access_token': token, 'fields': 'id'}), cache=False, tries=2)
            MLY['ok'] = True
        except Exception as e:
            MLY['ok'] = False
            log(f'Mapillary: image lookups refused ({str(e)[:60]}). Enable the READ permission of your app at '
                'mapillary.com/dashboard/developers; continuing without Mapillary.')
    return MLY['ok']


def mapillary_facing(stop, ei, edge, token):
    if not mapillary_usable(token):
        return []
    picks = []
    for lon, lat, pr in mapillary_points(edge[0], edge[1], token):
        head = pr.get('compass_angle')
        if pr.get('is_pano') or head is None:
            continue
        dist = dist_m((lon, lat), edge)
        if 3 <= dist <= 35 and angle_diff(bearing((lon, lat), edge), head) <= 35:
            picks.append((-(pr.get('captured_at') or 0) / 3.15e10 + dist / 10, lon, lat, head, pr))
    picks.sort(key=lambda x: x[0])  # recent and close first
    refs, seqs = [], set()
    for _, lon, lat, head, pr in picks:
        seq = pr.get('sequence_id')
        if seq and seq in seqs:
            continue  # one photo per drive/walk: the next frames look the same
        seqs.add(seq)
        d = try_fetch(f'https://graph.mapillary.com/{pr["id"]}?' + urllib.parse.urlencode(
            {'access_token': token, 'fields': 'thumb_1024_url,creator'}))  # cached: the photo is saved on first use
        if not d or not d.get('thumb_1024_url'):
            continue
        refs.append({'src': 'mapillary', 'prov': 'mly', 'edge': ei, 'lon': lon, 'lat': lat, 'heading': head,
                     'thumb': d['thumb_1024_url'], 'page': f'https://www.mapillary.com/app/?pKey={pr["id"]}',
                     'credit': ((d.get('creator') or {}).get('username') or 'Mapillary')[:80],
                     'licence': 'CC-BY-SA-4.0', 'date': datetime.datetime.fromtimestamp(
                         (pr.get('captured_at') or 0) / 1000, datetime.UTC).strftime('%Y-%m-%d'),
                     'text': '', 'dist': dist_m((lon, lat), edge), 'cache_key': f'mly-{pr["id"]}'})
        if len(refs) >= MAX_STREET_PER_EDGE:
            break
    return refs


def commons_near(stop):
    r = int(min(300, max(40, stop['r'] + 35)))
    pages = commons_pages({'generator': 'geosearch', 'ggsnamespace': '6', 'ggscoord': f'{stop["c"][1]}|{stop["c"][0]}',
                           'ggsradius': str(r), 'ggslimit': '100' if stop['mode'] == 't' else '40'})  # stations: many photos
    return commons_filter(stop, pages)


def commons_filter(stop, pages):
    """Which geotagged Commons photos near a stop show it → (refs, the stop's own categories found on them)."""
    toks = name_tokens(stop['name'])
    # "Zürich HB", "Bern": the only distinctive word is the town, which half the photos of the town mention
    town_only = ',' not in stop['name'] or not ({t for t in norm(stop['name'].split(',')[-1]).split()} & toks)
    station_word = re.compile(r'\b(bahnhof|hauptbahnhof|station|gare|stazione|hb|railway station|train station)\b')
    cats_found, refs = set(), []
    for p in pages:
        ref = commons_ref(p, 'geo')
        if not ref or ref['lon'] is None:
            continue
        text = norm(ref['text'])
        named = any(t in text.split() for t in toks) and (not town_only or bool(station_word.search(text)))
        transit = any(w in ' ' + text + ' ' for w in (' ' + norm(x) + ' ' for x in TRANSIT_WORDS))
        if any(w in ' ' + text + ' ' for w in (' ' + norm(x) + ' ' for x in REJECT_WORDS)):
            continue
        if ref['date'][:4].isdigit() and int(ref['date'][:4]) < 2008:
            continue  # stops change: keep recent photos
        # a "<name> (tram stop)" style category on a nearby photo = the stop's own category. It has to name this
        # stop (all its distinctive words) and one kind of stop; collections like "Trams in Zürich" do not count
        for c in p.get('categories', []):
            ct = norm(c['title'][9:])
            words = set(ct.split())
            if (toks <= words
                    and re.search(r'\b(tram stop|bus stop|stop|station|bahnhof|haltestelle|gare|stazione|arret|fermata)\b', ct)
                    and not re.search(r'\b(trams|buses|stops|stations|lines?|in|of|network|vehicles|rolling|history)\b', ct)
                    and (not town_only or station_word.search(ct))):
                cats_found.add(c['title'][9:])
        min_edge = min(dist_m((ref['lon'], ref['lat']), e) for e in stop['edges'])
        if (named and (transit or min_edge < 60)) or (transit and min_edge < 30):
            ref['score'] = (2 if named else 0) + (1 if transit else 0) - min_edge / 60
            refs.append(ref)
    refs.sort(key=lambda x: -x['score'])
    return refs[:MAX_GEO_PER_STOP], cats_found


def commons_category(cat, limit=12):
    pages = commons_pages({'generator': 'categorymembers', 'gcmtitle': 'Category:' + cat, 'gcmtype': 'file',
                           'gcmlimit': str(limit)})
    return [r for r in (commons_ref(p, 'cat') for p in pages) if r]


def commons_files(titles, prov):
    refs = []
    titles = list(titles)
    for i in range(0, len(titles), 40):
        pages = commons_pages({'titles': '|'.join(titles[i:i + 40])})
        refs += [r for r in (commons_ref(p, prov) for p in pages) if r]
    return refs


# ---------------------------------------------------------------- collection
def collect(stop, wd, sbb, osm, token):
    refs = []
    uic = stop['uic']
    refs += sbb.get(uic, [])
    w = wd.get(uic)
    if w:
        refs += commons_files(w['images'], 'wd')
    geo, cats = commons_near(stop)
    for cat in sorted((w['cats'] if w else set()) | cats)[:2]:
        refs += commons_category(cat)[:6]
    for o in osm:
        if o['uic'] == uic or (o['ll'][0] and min(dist_m(o['ll'], e) for e in stop['edges']) < 25
                               and name_tokens(stop['name']) & set(norm(o['name']).split())):
            m = re.search(r'(?:^|/wiki/)File:([^?#]+)$', o['value']) if o['kind'] in ('wikimedia_commons', 'image') else None
            if m:
                refs += commons_files(['File:' + urllib.parse.unquote(m.group(1)).replace('_', ' ')], 'osm')
    refs += geo
    street = []
    for ei, edge in enumerate(stop['edges'][:12]):
        if stop['mode'] in ('t',) and len(stop['edges']) > 6:
            break  # big stations: street-level photos rarely show a given platform
        got = panoramax_facing(stop, ei, edge)
        if token:
            got += mapillary_facing(stop, ei, edge, token)
        got.sort(key=lambda x: (x['src'] != 'mapillary', x.get('dist', 20)))
        street += got[:MAX_STREET_PER_EDGE]
    refs += street
    # de-duplicate (same file through several sources), identity links first
    order = {'sbb': 0, 'wd': 1, 'osm': 2, 'cat': 3, 'mly': 4, 'pnx': 5, 'geo': 6}
    seen, out = set(), []
    for r in sorted(refs, key=lambda r: order[r['prov']]):
        k = r.get('cache_key') or r['thumb'].rsplit('/', 1)[-1]
        if k not in seen:
            seen.add(k)
            out.append(r)
    return out[:MAX_PER_STOP]


# ---------------------------------------------------------------- fingerprints
class Embedder:
    def __init__(self):
        import numpy as np
        import onnxruntime as ort
        self.np = np
        path = os.path.join(CACHE, 'model', MODEL_REV, os.path.basename(MODEL_FILE))
        if not os.path.exists(path):
            log('downloading', MODEL_REPO, MODEL_FILE)
            body = fetch(f'https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REV}/{MODEL_FILE}', binary=True, cache=False)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'wb') as f:
                f.write(body)
        self.sess = ort.InferenceSession(path, providers=['CPUExecutionProvider'])

    def prep(self, data):
        from PIL import Image, ImageOps
        np = self.np
        im = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert('RGB')
        w, h = im.size
        s = INPUT / min(w, h)
        nw, nh = max(INPUT, round(w * s)), max(INPUT, round(h * s))
        im = im.resize((nw, nh), Image.BILINEAR)
        l, t = (nw - INPUT) // 2, (nh - INPUT) // 2
        a = np.asarray(im.crop((l, t, l + INPUT, t + INPUT)), dtype=np.float32) / 255.0
        a = (a - np.array(MEAN, dtype=np.float32)) / np.array(STD, dtype=np.float32)
        return a.transpose(2, 0, 1)

    def embed(self, arrays):
        """→ 768-value descriptors: [CLS, mean of patch tokens], each L2-normalised (the phone does the same)."""
        np = self.np
        out = self.sess.run(None, {'pixel_values': np.stack(arrays).astype(np.float32)})[0]
        cls, mean = out[:, 0], out[:, 1:].mean(axis=1)
        cls /= np.linalg.norm(cls, axis=1, keepdims=True)
        mean /= np.linalg.norm(mean, axis=1, keepdims=True)
        return np.concatenate([cls, mean], axis=1) / math.sqrt(2)


def photo_key(r):
    return r.get('cache_key') or hashlib.sha1(r['thumb'].encode()).hexdigest()


def image_bytes(ref):
    key = photo_key(ref)
    path = os.path.join(CACHE, 'img', key[-2:], key + '.jpg')
    if os.path.exists(path):
        with open(path, 'rb') as f:
            return f.read()
    body = try_fetch(ref['thumb'], binary=True, cache=False)
    if body:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f'{path}.{os.getpid()}.{threading.get_ident()}.tmp'
        with open(tmp, 'wb') as f:
            f.write(body)
        safe_replace(tmp, path)
    return body


# Full 768-value fingerprints of every photo, kept on this machine only (not shipped): a photo is fingerprinted
# once, and the shipped 128-value version can be recomputed from these if the projection ever changes.
EMB_CACHE = os.path.join(CACHE, 'emb768.tsv')  # read: emb768*.tsv; each running build appends to its own file
EMB_OUT = os.path.join(CACHE, f'emb768.{os.getpid()}.tsv')
_emb, _emb_lock = None, threading.Lock()


def emb_cache():
    global _emb
    import numpy as np
    with _emb_lock:
        if _emb is None:
            _emb = {}
            import glob
            for path in sorted(glob.glob(os.path.join(CACHE, 'emb768*.tsv'))):
                with open(path, encoding='utf-8') as f:
                    for line in f:
                        k, _, b = line.rstrip('\n').partition('\t')
                        if b and len(b) == 1024:  # 768 bytes in base64; anything else is a broken line
                            _emb[k] = b
        return _emb


def emb_get(key):
    import numpy as np
    b = emb_cache().get(key)
    if not b:
        return None
    v = np.frombuffer(base64.b64decode(b), dtype=np.int8).astype(np.float32)
    return v / np.linalg.norm(v)


def emb_put(items):
    import numpy as np
    cache = emb_cache()
    os.makedirs(CACHE, exist_ok=True)
    with _emb_lock, open(EMB_OUT, 'a', encoding='utf-8') as f:
        for key, v in items:
            b = base64.b64encode(np.round(v / np.abs(v).max() * 127).astype(np.int8).tobytes()).decode()
            cache[key] = b
            f.write(f'{key}\t{b}\n')


def safe_image_bytes(ref):
    try:
        return image_bytes(ref)
    except Exception as e:  # one photo that cannot be saved: its stop is retried later, the build goes on
        log(f'  ! photo {photo_key(ref)}: {type(e).__name__}: {str(e)[:100]}')
        return None


def fingerprint(refs_by_stop, embedder):
    jobs = [(uic, r) for uic, refs in refs_by_stop.items() for r in refs if 'v' not in r]
    for _, r in jobs:
        v = emb_get(photo_key(r))
        if v is not None:
            r['v'] = v
    jobs = [j for j in jobs if 'v' not in j[1]]
    log(f'fingerprinting {len(jobs)} new photos')
    done = 0
    with cf.ThreadPoolExecutor(16) as pool:
        for i in range(0, len(jobs), 64):
            chunk = jobs[i:i + 64]
            datas = list(pool.map(lambda j: safe_image_bytes(j[1]), chunk))
            arrays, keep = [], []
            for (uic, r), d in zip(chunk, datas):
                try:
                    arrays.append(embedder.prep(d))
                    keep.append(r)
                except Exception:
                    r['bad'] = True
            if arrays:
                vs = embedder.embed(arrays)
                for r, v in zip(keep, vs):
                    r['v'] = v
                emb_put([(photo_key(r), v) for r, v in zip(keep, vs)])
            done += len(chunk)
            if done % 320 < 32:
                log(f'  {done}/{len(jobs)}')
    failed = {uic for uic, refs in refs_by_stop.items() if any(r.get('v') is None for r in refs)}
    for uic in refs_by_stop:
        refs_by_stop[uic] = [r for r in refs_by_stop[uic] if r.get('v') is not None]
    return failed  # stops with a photo that could not be downloaded or read this time


# ---------------------------------------------------------------- projection (768 → 128 values)
PCA_K = 128
_pca = None


def pca():
    """mean (768), W (768 × K, dequantised from the int8 the phone gets) — from index.js, so builds stay comparable."""
    global _pca
    import numpy as np
    if _pca is None:
        idx = read_index()
        p = idx.get('pca')
        if p:
            mean = np.frombuffer(base64.b64decode(p['mean']), dtype=np.float32)
            scale = np.frombuffer(base64.b64decode(p['scale']), dtype=np.float32)
            w = np.frombuffer(base64.b64decode(p['w']), dtype=np.int8).astype(np.float32).reshape(768, p['k']) * scale
            _pca = (mean, w, p)
    return _pca


def fit_pca(vectors):
    """Principal components of the photo fingerprints; the int8 version is what both sides use."""
    global _pca
    import numpy as np
    if len(vectors) < 2 * PCA_K:
        raise SystemExit(f'only {len(vectors)} photos: build a larger area first (the projection needs ≥ {2 * PCA_K})')
    X = np.stack(vectors).astype(np.float32)
    mean = X.mean(0)
    _, _, vt = np.linalg.svd(X - mean, full_matrices=False)
    w = vt[:PCA_K].T.astype(np.float32)  # 768 × K (K = actual number of components)
    scale = (np.abs(w).max(0) / 127).astype(np.float32)
    wq = np.round(w / scale).astype(np.int8)
    p = {'k': int(w.shape[1]), 'n': len(vectors), 'mean': base64.b64encode(mean.tobytes()).decode(),
         'w': base64.b64encode(wq.tobytes()).decode(), 'scale': base64.b64encode(scale.tobytes()).decode()}
    _pca = (mean, wq.astype(np.float32) * scale, p)
    log(f'fitted the {PCA_K}-value projection on {len(vectors)} photos')
    return _pca


def project(v):
    """768 → K values, int8, base64 (what the tiles store)."""
    import numpy as np
    mean, w, _ = pca()
    y = (v - mean) @ w
    y /= np.linalg.norm(y) or 1
    return base64.b64encode(np.round(y / np.abs(y).max() * 127).astype(np.int8).tobytes()).decode()


# ---------------------------------------------------------------- output (format 2)
# Tile file: STOP_IMAGES_TILE("<key>", { s: { "<uic>": [[src, prov, edge, heading, ref, credit, licence, emb], …] },
#                                       d: { "<uic>": [[edge, "lines", "destination|destination|…"], …] } })
# ref: "c:<Commons thumb path>" | "p:<Panoramax picture URL>" | "m:<Mapillary id>" | "u:<other image URL>"
# key = "<floor(lat / 0.02)>_<floor(lon / 0.02)>" (0.02° tiles, ~2.2 × 1.5 km)
def compact_ref(r):
    if r['src'] == 'commons' and '/commons/thumb/' in (r.get('thumb') or ''):
        return 'c:' + r['thumb'].split('/commons/thumb/', 1)[1]
    if r['src'] == 'panoramax':
        return 'p:' + r['thumb']
    if r['src'] == 'mapillary':
        return 'm:' + r['page'].rsplit('=', 1)[-1]
    return 'u:' + (r.get('thumb') or r.get('page') or '')


def read_index():
    path = os.path.join(OUT, 'index.js')
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as f:
        t = f.read()
    return json.loads(t[t.index('{'):t.rindex('}') + 1])


def read_tile(path):
    with open(path, encoding='utf-8') as f:
        t = f.read()
    d = json.loads(t[t.index('{'):t.rindex('}') + 1])
    return d if 's' in d or 'd' in d else {'s': d, 'd': {}}  # format 1 tiles: photos only


def write_tile(path, key, tile):
    tile = {'s': {k: v for k, v in tile.get('s', {}).items() if v}, 'd': {k: v for k, v in tile.get('d', {}).items() if v}}
    atomic_write(path, f'STOP_IMAGES_TILE({json.dumps(key)},{json.dumps(tile, ensure_ascii=False, separators=(",", ":"))});\n')


def atomic_write(path, text):
    """Write next to the file, then swap it in: a build stopped half-way never leaves a broken tile."""
    tmp = f'{path}.{os.getpid()}.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    safe_replace(tmp, path, keep_theirs=False)


def write(refs_by_stop, stops, keep_srcs=(), lines_by_stop=None, keep_all=()):
    """Merge photos (and/or timetable lines) of some stops into their tiles, then rewrite index.js.
    keep_srcs: sources not queried this run (their old photos stay); keep_all: stops whose collection was incomplete
    (all their old photos stay, the new ones are added)."""
    os.makedirs(os.path.join(OUT, 't'), exist_ok=True)
    vectors = [r['v'] for refs in refs_by_stop.values() for r in refs]
    if pca() is None and vectors:
        fit_pca(vectors)
    by_tile = {}
    for uic in set(refs_by_stop) | set(lines_by_stop or {}):
        by_tile.setdefault(tile_key(*stops[uic]['c']), []).append(uic)
    for key, uics in by_tile.items():
        path = os.path.join(OUT, 't', key + '.js')
        tile = read_tile(path) if os.path.exists(path) else {'s': {}, 'd': {}}
        for uic in uics:
            if uic in refs_by_stop:
                refs = [[r['src'], r['prov'], r['edge'], round(r['heading']) if r['heading'] is not None else None,
                         compact_ref(r), r['credit'], r['licence'], project(r['v'])] for r in refs_by_stop[uic]]
                refs_new = {x[4] for x in refs}
                kept = [x for x in tile['s'].get(uic, [])
                        if (uic in keep_all or x[0] in keep_srcs) and x[4] not in refs_new]
                tile['s'][uic] = refs + kept
            if lines_by_stop and uic in lines_by_stop:
                tile['d'][uic] = lines_by_stop[uic]
        write_tile(path, key, tile)
    write_index()
    log(f'wrote {len(by_tile)} tiles')


def write_index():
    index = read_index()
    tiles, counts, n_stops, n_lines, size = {}, {}, 0, 0, 0
    for name in sorted(os.listdir(os.path.join(OUT, 't'))):
        if not name.endswith('.js'):
            continue
        tile = read_tile(os.path.join(OUT, 't', name))
        size += os.path.getsize(os.path.join(OUT, 't', name))
        if tile['s'] or tile['d']:
            tiles[name[:-3]] = len(tile['s'])
        n_stops += len(tile['s'])
        n_lines += len(tile['d'])
        for refs in tile['s'].values():
            for r in refs:
                counts[r[1]] = counts.get(r[1], 0) + 1
    index.update({'v': 2, 'date': datetime.date.today().isoformat(), 'tile': TILE, 'tiles': tiles,
                  'model': {'repo': MODEL_REPO, 'rev': MODEL_REV, 'file': MODEL_FILE, 'input': INPUT,
                            'mean': MEAN, 'std': STD, 'desc': 'cls+meanpatch l2, /sqrt2, minus pca.mean, x pca.w*scale, l2'},
                  'pca': pca()[2] if pca() else None, 'photos': counts, 'stops': n_stops, 'stops_with_lines': n_lines,
                  'bytes': size})
    atomic_write(os.path.join(OUT, 'index.js'),
                 '// Generated by tools/build_stop_images.py: photo fingerprints and timetable lines of Swiss stops, '
                 'per 0.02° tile.\n' + 'window.STOP_IMAGES_INDEX = ' + json.dumps(index, separators=(',', ':')) + ';\n')
    log(f'database: {n_stops} stops with photos ({sum(counts.values())} photos: {counts}), '
        f'{n_lines} stops with lines, {size / 1e6:.1f} MB')


def migrate(stops):
    """Format 1 (0.1° tiles, 768-value fingerprints) → format 2. Keeps every photo; fills the local fingerprint cache."""
    import numpy as np
    tdir = os.path.join(OUT, 't')
    old = []
    for name in os.listdir(tdir):
        if name.endswith('.js'):
            t = read_tile(os.path.join(tdir, name))
            if any(refs and len(refs[0]) == 11 for refs in t['s'].values()):  # format 1: 11 fields per photo
                old.append(name)
    if not old:
        return log('nothing to migrate: the database is already in format 2')
    refs_by_stop, vecs = {}, []
    for name in old:
        tile = read_tile(os.path.join(tdir, name))
        for uic, refs in tile['s'].items():
            if uic not in stops or not refs or len(refs[0]) != 11:
                continue
            out = []
            for src, prov, edge, lon, lat, head, thumb, page, credit, licence, emb in refs:
                r = {'src': src, 'prov': prov, 'edge': edge, 'heading': head, 'thumb': thumb, 'page': page,
                     'credit': credit, 'licence': licence}
                if src == 'mapillary':
                    r['cache_key'] = 'mly-' + page.rsplit('=', 1)[-1]
                elif src == 'panoramax':
                    r['cache_key'] = 'pnx-' + page.rsplit('=', 1)[-1]
                v = np.frombuffer(base64.b64decode(emb), dtype=np.int8).astype(np.float32)
                r['v'] = v / np.linalg.norm(v)
                out.append(r)
                vecs.append(r['v'])
            refs_by_stop[uic] = out
    log(f'migrating {len(old)} format-1 tiles: {len(refs_by_stop)} stops, {len(vecs)} photos')
    emb_put([(photo_key(r), r['v']) for refs in refs_by_stop.values() for r in refs])
    if pca() is None or 'pca' not in read_index():
        fit_pca(vecs)
    write(refs_by_stop, stops)  # the new tiles first; only then remove the old ones
    new_keys = {tile_key(*stops[u]['c']) + '.js' for u in refs_by_stop}
    for name in old:
        if name not in new_keys:
            os.remove(os.path.join(tdir, name))
    write_index()



# ---------------------------------------------------------------- fast mode: one 0.02° tile at a time
# The same sources and the same rules as collect(), but asked once per area instead of once per stop:
# Commons geotagged files by bounding box (split while an area has more than 500), their details 50 at a time;
# Panoramax pictures by bounding box, "faces the edge" checked here from each picture's direction; Mapillary
# photos from its coverage tiles, their links 50 at a time. A few requests per tile instead of several per stop.
def _quarters(b):
    mx, my = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    return [(b[0], b[1], mx, my), (mx, b[1], b[2], my), (b[0], my, mx, b[3]), (mx, my, b[2], b[3])]


def commons_in_box(box, depth=0):
    d = try_fetch(COMMONS + urllib.parse.urlencode({'action': 'query', 'list': 'geosearch', 'gsnamespace': '6',
                  'gsbbox': f'{box[3]}|{box[0]}|{box[1]}|{box[2]}', 'gslimit': '500', 'format': 'json'}))
    rows = ((d or {}).get('query') or {}).get('geosearch', [])
    if len(rows) >= 500 and depth < 4:
        return [r for q in _quarters(box) for r in commons_in_box(q, depth + 1)]
    return rows


def commons_pages_by_title(titles):
    out, titles = {}, sorted(set(titles))
    for i in range(0, len(titles), 50):
        for pg in commons_pages({'titles': '|'.join(titles[i:i + 50])}):
            out[pg['title']] = pg
    return out


def panoramax_in_box(box, depth=0):
    d = try_fetch('https://api.panoramax.xyz/api/search?' + urllib.parse.urlencode(
        {'bbox': f'{box[0]},{box[1]},{box[2]},{box[3]}', 'limit': '1000'}))
    feats = (d or {}).get('features', [])
    if len(feats) >= 1000 and depth < 3:
        return [f for q in _quarters(box) for f in panoramax_in_box(q, depth + 1)]
    return feats


def panoramax_ref(f, ei, edge):
    props, assets = f.get('properties', {}), f.get('assets', {})
    sd = (assets.get('sd') or assets.get('thumb') or {}).get('href')
    lon, lat = f['geometry']['coordinates'][:2]
    head = props.get('view:azimuth')
    if not sd or head is None or (props.get('pers:interior_orientation') or {}).get('field_of_view') == 360:
        return None
    dist = dist_m((lon, lat), edge)
    if not 3 <= dist <= 35 or angle_diff(bearing((lon, lat), edge), head) > 50:  # as place_fov_tolerance=50
        return None
    lic = next((l.get('title', '') for l in f.get('links', []) if l.get('rel') == 'license'), 'CC-BY-SA-4.0')
    who = ', '.join(p.get('name', '') for p in f.get('providers', []) if p.get('name')) or 'Panoramax'
    return {'src': 'panoramax', 'prov': 'pnx', 'edge': ei, 'lon': lon, 'lat': lat, 'heading': head, 'thumb': sd,
            'page': f'https://api.panoramax.xyz/#focus=pic&pic={f["id"]}', 'credit': who[:80],
            'cache_key': f'pnx-{f["id"]}', 'dist': dist,
            'licence': lic.replace('License for this object (', '').rstrip(')')[:40],
            'date': (props.get('datetime') or '')[:10], 'text': ''}


def mapillary_candidates(ei, edge, token):
    """Mapillary photos taken 3–35 m from the edge and facing it, best first (no requests: coverage tiles)."""
    picks = []
    for lon, lat, pr in mapillary_points(edge[0], edge[1], token):
        head = pr.get('compass_angle')
        if pr.get('is_pano') or head is None:
            continue
        dist = dist_m((lon, lat), edge)
        if 3 <= dist <= 35 and angle_diff(bearing((lon, lat), edge), head) <= 35:
            picks.append((-(pr.get('captured_at') or 0) / 3.15e10 + dist / 10, lon, lat, head, pr, dist))
    picks.sort(key=lambda x: x[0])
    out, seqs = [], set()
    for _, lon, lat, head, pr, dist in picks:
        seq = pr.get('sequence_id')
        if seq and seq in seqs:
            continue
        seqs.add(seq)
        out.append({'src': 'mapillary', 'prov': 'mly', 'edge': ei, 'lon': lon, 'lat': lat, 'heading': head,
                    'id': str(pr['id']), 'page': f'https://www.mapillary.com/app/?pKey={pr["id"]}',
                    'licence': 'CC-BY-SA-4.0', 'date': datetime.datetime.fromtimestamp(
                        (pr.get('captured_at') or 0) / 1000, datetime.UTC).strftime('%Y-%m-%d'),
                    'text': '', 'dist': dist, 'cache_key': f'mly-{pr["id"]}'})
        if len(out) >= MAX_STREET_PER_EDGE:
            break
    return out


def mapillary_links(refs, token):
    """Picture links and authors for Mapillary photos, 50 per request (256 px is plenty for a fingerprint)."""
    ids = sorted({r['id'] for r in refs})
    info = {}
    for i in range(0, len(ids), 50):
        d = try_fetch('https://graph.mapillary.com/images?' + urllib.parse.urlencode(
            {'access_token': token, 'image_ids': ','.join(ids[i:i + 50]), 'fields': 'id,thumb_256_url,creator'}))
        for im in (d or {}).get('data', []):
            info[str(im['id'])] = im
    out = []
    for r in refs:
        im = info.get(r['id'])
        if im and im.get('thumb_256_url'):
            r['thumb'] = im['thumb_256_url']
            r['credit'] = ((im.get('creator') or {}).get('username') or 'Mapillary')[:80]
            out.append(r)
    return out


def collect_tile(group, wd, sbb, token):
    """Photos for all stops of one tile → ({uic: refs}, complete)."""
    _stop_state.failed = False
    try:
        pad = max(40, max(min(300, s['r'] + 35) for s in group)) / 111320
        lons = [e[0] for s in group for e in s['edges']] + [s['c'][0] for s in group]
        lats = [e[1] for s in group for e in s['edges']] + [s['c'][1] for s in group]
        k = math.cos(math.radians(sum(lats) / len(lats)))
        box = (min(lons) - pad / k, min(lats) - pad, max(lons) + pad / k, max(lats) + pad)
        # Commons: what geosearch would give each stop (nearest within its radius), details fetched once
        rows = commons_in_box(box)
        want, near = set(), {}
        for st in group:
            r = min(300, max(40, st['r'] + 35))
            close = sorted((dist_m(st['c'], (row['lon'], row['lat'])), row['title']) for row in rows)
            near[st['uic']] = [t for d, t in close if d <= r][:100 if st['mode'] == 't' else 40]
            want.update(near[st['uic']])
            if wd.get(st['uic']):
                want.update(wd[st['uic']]['images'])
        pages = commons_pages_by_title(want)
        pnx = panoramax_in_box(box)
        mly_all, per_stop = [], {}
        for st in group:
            uic = st['uic']
            refs = list(sbb.get(uic, []))
            w = wd.get(uic)
            if w:
                refs += [x for x in (commons_ref(pages[t], 'wd') for t in w['images'] if t in pages) if x]
            geo, cats = commons_filter(st, [pages[t] for t in near[uic] if t in pages])
            for cat in sorted((w['cats'] if w else set()) | cats)[:2]:
                refs += commons_category(cat)[:6]
            refs += geo
            street = []
            for ei, edge in enumerate(st['edges'][:12]):
                if st['mode'] == 't' and len(st['edges']) > 6:
                    break  # big stations: street-level photos rarely show a given platform
                got = [x for x in (panoramax_ref(f, ei, edge) for f in pnx) if x]
                got.sort(key=lambda x: x['dist'])
                mly = mapillary_candidates(ei, edge, token) if token and MLY['ok'] else []
                street.append((got, mly))
                mly_all += mly
            per_stop[uic] = (refs, street)
        linked = {id(r) for r in mapillary_links(mly_all, token)} if mly_all else set()
        out = {}
        order = {'sbb': 0, 'wd': 1, 'osm': 2, 'cat': 3, 'mly': 4, 'pnx': 5, 'geo': 6}
        for uic, (refs, street) in per_stop.items():
            for got, mly in street:
                both = [r for r in mly if id(r) in linked] + got  # Mapillary first, then the nearest Panoramax
                refs += both[:MAX_STREET_PER_EDGE]
            seen, keep = set(), []
            for r in sorted(refs, key=lambda r: order[r['prov']]):
                key = r.get('cache_key') or r['thumb'].rsplit('/', 1)[-1]
                if key not in seen:
                    seen.add(key)
                    keep.append(r)
            out[uic] = keep[:MAX_PER_STOP]
        return out, not _stop_state.failed
    except Exception as e:
        log(f'  ! tile {tile_key(*group[0]["c"])}: {type(e).__name__}: {str(e)[:120]}')
        return {}, False


def run_fast(todo, wd, sbb, token, embedder, ckpt, workers):
    groups = {}
    for st in todo:
        groups.setdefault(tile_key(*st['c']), []).append(st)
    keys = sorted(groups)
    log(f'fast mode: {len(todo)} stops in {len(keys)} tiles')
    t0, done_stops = time.time(), 0
    if token:
        mapillary_usable(token)
    def finish(part, got, upto):
        nonlocal done_stops
        chunk, incomplete = {}, set()
        for g, (refs, ok) in zip(part, got):
            for st in g:
                if st['uic'] in refs:
                    chunk[st['uic']] = refs[st['uic']]
                if not ok:
                    incomplete.add(st['uic'])
        incomplete |= fingerprint(chunk, embedder)
        write(chunk, stops_global, keep_srcs=() if token and MLY['ok'] else ('mapillary',), keep_all=incomplete)
        with open(ckpt, 'a') as f:
            f.writelines(f'{u}\n' for u in chunk if u not in incomplete)
        done_stops += sum(len(g) for g in part)
        rate = (time.time() - t0) / done_stops
        log(f'{done_stops}/{len(todo)} stops ({upto}/{len(keys)} tiles), '
            f'{sum(1 for v in chunk.values() if v)} of this batch with photos, '
            f'{rate:.2f} s/stop, about {rate * (len(todo) - done_stops) / 60:.0f} min left')

    # collect batch n+1 while batch n is fingerprinted and written (one writer at a time: no lost tile updates)
    with cf.ThreadPoolExecutor(1) as writer, cf.ThreadPoolExecutor(workers) as pool:
        pending = None
        for i in range(0, len(keys), 64):
            part = [groups[k] for k in keys[i:i + 64]]
            got = list(pool.map(lambda g: collect_tile(g, wd, sbb, token), part))
            if pending:
                pending.result()
            pending = writer.submit(finish, part, got, i + len(part))
            if len(_mly_tiles) > 120:
                with _mly_lock:  # coverage tiles of areas already done
                    for key in list(_mly_tiles)[:60]:
                        _mly_tiles.pop(key, None)
        if pending:
            pending.result()


stops_global = {}

# ---------------------------------------------------------------- timetable: lines + destinations per stop edge
def build_lines(stops, zip_path, max_lines=10, max_dests=6):
    """From the Swiss GTFS (opentransportdata.swiss): which lines leave from each stop edge and where they go.
    A sign that shows "4 · 19 → Bern Brünnen" can then be tied to one edge of the stop, offline, for every stop.
    GTFS platforms carry the ATLAS SLOID and the same coordinates as platforms.js, so each one is matched to the
    edge at its position (≤ 3 m); platforms that match no single edge count for the stop as a whole (edge null)."""
    import zipfile
    from collections import Counter, defaultdict
    z = zipfile.ZipFile(zip_path)

    def rows(name):
        with z.open(name) as f:
            r = csv.reader(io.TextIOWrapper(f, encoding='utf-8-sig'))
            hdr = next(r)
            for row in r:
                yield dict(zip(hdr, row))

    where = {}  # GTFS stop_id → (uic, edge index or None)
    for row in rows('stops.txt'):
        uic = row.get('didok', '')
        st = stops.get(uic)
        if not st or row.get('location_type') == '1':
            continue
        ll = (float(row['stop_lon']), float(row['stop_lat']))
        d = [dist_m(ll, e) for e in st['edges']]
        i = min(range(len(d)), key=d.__getitem__)
        where[row['stop_id']] = (uic, i if d[i] <= 3 and sorted(d)[1:2] != [d[i]] else None)
    log(f'gtfs: {len(where)} platforms/stops matched to {len({u for u, _ in where.values()})} stops')
    line_of = {row['route_id']: row['route_short_name'] for row in rows('routes.txt')}
    pairs, trip = {}, {}
    for row in rows('trips.txt'):
        pr = (line_of.get(row['route_id'], ''), row.get('trip_headsign', ''))
        trip[row['trip_id']] = pairs.setdefault(pr, len(pairs))
    pair_list = list(pairs)
    log(f'gtfs: {len(trip)} trips, {len(pairs)} line/destination pairs; reading stop_times (a few minutes)')
    counts = defaultdict(Counter)  # (uic, edge) → Counter(pair index)
    n = 0
    with z.open('stop_times.txt') as f:
        hdr = [h.strip('"') for h in f.readline().decode('utf-8-sig').strip().split(',')]
        ti, si = hdr.index('trip_id'), hdr.index('stop_id')
        pi = hdr.index('pickup_type') if 'pickup_type' in hdr else None
        for raw in f:
            parts = raw.decode('utf-8').rstrip().split(',')
            sid = parts[si].strip('"')
            w = where.get(sid)
            if w and (pi is None or parts[pi].strip('"') != '1'):  # 1 = no boarding here (drop-off only)
                p = trip.get(parts[ti].strip('"'))
                if p is not None:
                    counts[w][p] += 1
            n += 1
            if n % 20_000_000 == 0:
                log(f'  {n // 1_000_000} M stop times')
    out = defaultdict(list)
    for (uic, edge), c in counts.items():
        lines, dests = Counter(), Counter()
        here = {norm(stops[uic]['name']), norm(stops[uic]['name'].split(',')[-1])}
        for p, k in c.items():
            line, dest = pair_list[p]
            if dest and (norm(dest) in here or norm(dest.split(',')[-1]) in here):
                continue  # trips that end here: nobody boards them towards "here"
            if line:
                lines[line] += k
            if dest:
                dests[dest] += k
        out[uic].append([edge, ' '.join(l for l, _ in lines.most_common(max_lines)),
                         '|'.join(d for d, _ in dests.most_common(max_dests))])
    log(f'gtfs: lines for {len(out)} stops')
    write({}, stops, lines_by_stop=out)


def safe_collect(stop, *a):
    """One stop that fails must not stop a national build. → (refs, complete); refs None = keep what it had."""
    _stop_state.failed = False
    try:
        refs = collect(stop, *a)
        return refs, not _stop_state.failed
    except Exception as e:
        log(f'  ! {stop["uic"]} {stop["name"]}: {type(e).__name__}: {str(e)[:120]}')
        return None, False


def calibrate(stops):
    """How well photo fingerprints alone tell nearby stops apart: leave one photo out, find the stop (within 300 m)
    whose photos are most similar, and count how often that is the right stop."""
    import numpy as np
    db = {}
    for name in os.listdir(os.path.join(OUT, 't')):
        if name.endswith('.js'):
            db.update(read_tile(os.path.join(OUT, 't', name))['s'])
    vecs = {}
    for uic, refs in db.items():
        vs = [np.frombuffer(base64.b64decode(r[7]), dtype=np.int8).astype(np.float32) for r in refs]
        vecs[uic] = [(r[1], v / np.linalg.norm(v)) for r, v in zip(refs, vs)]
    same, other, res = [], [], []
    uics = [u for u in vecs if u in stops]
    for u in uics:
        near = [w for w in uics if dist_m(stops[u]['c'], stops[w]['c']) <= 300]
        for i, (prov, a) in enumerate(vecs[u]):
            best = {}
            for w in near:
                sims = [float(a @ b) for j, (_, b) in enumerate(vecs[w]) if not (w == u and j == i)]
                if sims:
                    best[w] = max(sims)
                    (same if w == u else other).extend(sims)
            if len(best) >= 2 and u in best:
                r = sorted(best.items(), key=lambda x: -x[1])
                res.append((r[0][0] == u, r[0][1], r[0][1] - r[1][1]))
    pct = lambda x: ' / '.join(f'{np.percentile(x, p):.2f}' for p in (25, 50, 75)) if x else '-'
    log(f'{len(vecs)} stops, {sum(map(len, vecs.values()))} photos')
    log(f'similarity, same stop (p25/p50/p75):        {pct(same)}')
    log(f'similarity, other stop < 300 m (p25/50/75): {pct(other)}')
    log(f'photo alone picks the right stop: {np.mean([x[0] for x in res]):.0%} of {len(res)} photos')
    for smin, m in ((0.6, 0.05), (0.7, 0.1)):
        sel = [x for x in res if x[1] >= smin and x[2] >= m]
        if sel:
            log(f'  with similarity >= {smin} and margin >= {m}: {len(sel)} answers, {np.mean([x[0] for x in sel]):.0%} right')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--area', choices=sorted(AREAS))
    ap.add_argument('--bbox', help='lon_min,lat_min,lon_max,lat_max')
    ap.add_argument('--all', action='store_true', help='all of Switzerland')
    ap.add_argument('--modes', default='t,m,b,s,c', help='t=train m=tram b=bus s=boat c=cable (default all)')
    ap.add_argument('--limit', type=int, default=0, help='only the first N stops (testing)')
    ap.add_argument('--mapillary-token-file')
    ap.add_argument('--workers', type=int, default=12,
                    help='stops collected at once; each website still gets at most one request per its own interval')
    ap.add_argument('--calibrate', action='store_true', help='measure how well photos alone tell nearby stops apart')
    ap.add_argument('--fast', action='store_true', help='ask the sources per 0.02° tile instead of per stop (much faster)')
    ap.add_argument('--migrate', action='store_true', help='convert format-1 tiles (0.1°, 768 values) to format 2')
    ap.add_argument('--gtfs', metavar='ZIP', help='add the lines and destinations of every stop edge from a Swiss GTFS zip '
                    '(opentransportdata.swiss "Fahrplan GTFS"), for all stops')
    ap.add_argument('--resume', action='store_true',
                    help='skip stops finished by an earlier run with the same area/modes (checkpoint in ~/.cache/stopvision)')
    a = ap.parse_args()
    if a.calibrate:
        return calibrate(load_stops())
    if a.migrate:
        return migrate(load_stops())
    if a.gtfs:
        return build_lines(load_stops(), a.gtfs)
    bbox = AREAS.get(a.area) if a.area else tuple(map(float, a.bbox.split(','))) if a.bbox else \
        (5.9, 45.8, 10.5, 47.85) if a.all else None
    if not bbox:
        ap.error('give --area, --bbox or --all')
    token = os.environ.get('MAPILLARY_TOKEN', '')
    if a.mapillary_token_file:
        with open(a.mapillary_token_file) as f:
            token = f.read().strip()
    log('Mapillary:', 'on' if token else 'off (set MAPILLARY_TOKEN for street-level photos of bus stops)')

    stops = load_stops()
    modes = set(a.modes.split(','))
    todo = [s for s in stops.values() if s['mode'] in modes and bbox[0] <= s['c'][0] <= bbox[2]
            and bbox[1] <= s['c'][1] <= bbox[3]]
    todo.sort(key=lambda s: (s['mode'] != 't', s['uic']))
    if a.limit:
        todo = todo[:a.limit]
    ckpt = os.path.join(CACHE, 'done-' + hashlib.sha1(f'{bbox}|{a.modes}|{bool(token)}'.encode()).hexdigest()[:12] + '.txt')
    done_before = set()
    if a.resume:  # stops finished by any earlier run (e.g. an all-Switzerland run, now split into halves)
        import glob
        for path in glob.glob(os.path.join(CACHE, 'done-*.txt')):
            with open(path) as f:
                done_before |= set(f.read().split())
        todo = [s for s in todo if s['uic'] not in done_before]
        log(f'resuming: {len(done_before)} stops done before')
    log(f'{len(todo)} stops in the area')
    wd, sbb = wikidata(stops), sbb_images()
    osm = osm_tagged(bbox) if not (a.all or a.fast) else []  # Overpass would time out on big areas
    embedder = Embedder()
    if a.fast:
        stops_global.update(stops)
        return run_fast(todo, wd, sbb, token, embedder, ckpt, a.workers)

    refs_by_stop, done = {}, 0
    batch = 200  # write results every 200 stops, so a long run can be stopped and continued
    for i in range(0, len(todo), batch):
        part = todo[i:i + batch]
        with cf.ThreadPoolExecutor(a.workers) as pool:
            got = list(pool.map(lambda s: safe_collect(s, wd, sbb, osm, token), part))
        # complete stops replace what they had (that is how wrong photos from earlier runs go away); incomplete ones
        # (a source did not answer, a photo did not download) only add, and are not checkpointed, so --resume retries
        chunk = {s['uic']: refs for s, (refs, _) in zip(part, got) if refs is not None}
        incomplete = {s['uic'] for s, (refs, ok) in zip(part, got) if not ok}
        incomplete |= fingerprint(chunk, embedder)
        write(chunk, stops, keep_srcs=() if token and MLY['ok'] else ('mapillary',), keep_all=incomplete)
        refs_by_stop.update(chunk)
        os.makedirs(CACHE, exist_ok=True)
        with open(ckpt, 'a') as f:
            f.writelines(f'{u}\n' for u in chunk if u not in incomplete)
        done += len(part)
        log(f'{done}/{len(todo)} stops, {sum(1 for v in refs_by_stop.values() if v)} with photos')


if __name__ == '__main__':
    main()
