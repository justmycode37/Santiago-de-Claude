"""Destinations for a city's door test: Photon places within ~1 km of the main station (same queries as Bern),
plus the ground-level railway tracks around the station for the platform test. usage: python city_dests.py CITY"""
import json, sys, time, urllib.parse, urllib.request

C = json.load(open('cities.json', encoding='utf-8'))[sys.argv[1]]
UA = {'User-Agent': 'santiago-de-claude-eval/1.0'}
lon, lat = C['start']
dx, dy = 0.010, 0.007  # ~ 750 m × 780 m each side
w, s, e, n = lon - dx, lat - dy, lon + dx, lat + dy
seen, out = set(), []
for q in C['q']:
    url = 'https://photon.komoot.io/api/?' + urllib.parse.urlencode({'q': q, 'lat': lat, 'lon': lon, 'limit': 8, 'bbox': f'{w},{s},{e},{n}'})
    for f in json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read())['features']:
        c = tuple(f['geometry']['coordinates']); name = f['properties'].get('name')
        if not name or c in seen or not (w < c[0] < e and s < c[1] < n):
            continue
        seen.add(c)
        out.append({'q': q, 'name': name, 'll': list(c)})
    time.sleep(1.0)
json.dump({'results': out}, open(f'dests_{sys.argv[1]}.json', 'w', encoding='utf-8'), ensure_ascii=False)
q = f'[out:json];way["railway"~"^(rail|light_rail|narrow_gauge|subway|tram)$"]({lat - 0.004},{lon - 0.006},{lat + 0.004},{lon + 0.006});out geom;'
req = urllib.request.Request('https://overpass.osm.ch/api/interpreter', data=urllib.parse.urlencode({'data': q}).encode(), headers=UA)
open(f'rails_{sys.argv[1]}.json', 'wb').write(urllib.request.urlopen(req, timeout=180).read())
print(sys.argv[1], len(out), 'destinations')
