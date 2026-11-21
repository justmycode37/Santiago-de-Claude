#!/usr/bin/env python3
"""Small explicit discovery requests; immutable bytes and per-request provenance."""
import argparse, datetime, hashlib, json, pathlib, urllib.parse, urllib.request
ROOT = pathlib.Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser(); p.add_argument('mode', choices=['discover', 'inventory', 'relations', 'official']); p.add_argument('--ids', default=''); p.add_argument('--refs', default='12|7|8'); p.add_argument('--endpoint', choices=['https://overpass.osm.ch/api/interpreter','https://overpass-api.de/api/interpreter','https://overpass.private.coffee/api/interpreter'], default='https://overpass.osm.ch/api/interpreter'); args = p.parse_args()
assert not json.loads((ROOT.parent/'docs/hill-climb/STATE.json').read_text())['stopRequested']
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
out = ROOT/'dist/workstream-A3'/('sources-'+stamp); out.mkdir(parents=True)
def get(name, url, limit=2_000_000, licence='source terms'):
    start = datetime.datetime.now(datetime.timezone.utc).isoformat()
    meta = {'url':url,'startedAt':start,'byteLimit':limit,'timeoutSeconds':25,'licence':licence}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent':'RightSide-local-source-audit/1.0','Accept':'application/json'}), timeout=25) as r:
            data=r.read(limit+1); assert len(data)<=limit, 'byte cap exceeded'
            meta.update(status=r.status,responseDate=r.headers.get('Date'),lastModified=r.headers.get('Last-Modified'),bytes=len(data),sha256=hashlib.sha256(data).hexdigest(),acquiredAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
            (out/(name+'.json')).write_bytes(data)
    except Exception as e: meta['error']=str(e)
    (out/(name+'-provenance.json')).write_text(json.dumps(meta,indent=2)+'\n')
    print(name,json.dumps(meta),flush=True)
if args.mode=='discover':
    get('planner', 'https://transport.opendata.ch/v1/connections?'+urllib.parse.urlencode({'from':'Bern, Länggasse','to':'Bern, Saali','date':'2026-11-21','time':'10:00','limit':'3'}), licence='https://transport.opendata.ch/docs.html')
if args.mode in ['discover','inventory']:
    assert all(x.isdigit() for x in args.refs.split('|')) and len(args.refs)<30
    query='[out:json][timeout:20];relation["type"="route"]["route"~"^(bus|trolleybus|tram)$"]["ref"~"^('+args.refs+')$"](46.87,7.33,47.02,7.55);out tags;'
    get('osm-relations', args.endpoint+'?'+urllib.parse.urlencode({'data':query}), licence='© OpenStreetMap contributors; ODbL1.0; https://www.openstreetmap.org/copyright')
elif args.mode=='official':
    ids=args.ids.split(','); assert 0<len(ids)<=4 and all(x.isdigit() for x in ids)
    for relation in ids:
        get('osm-relation-'+relation, 'https://api.openstreetmap.org/api/0.6/relation/'+relation+'/full.json', limit=8_000_000, licence='© OpenStreetMap contributors; ODbL1.0; https://www.openstreetmap.org/copyright')
else:
    ids=args.ids.split(','); assert 0<len(ids)<=8 and all(x.isdigit() for x in ids)
    query='[out:json][timeout:25];relation(id:'+','.join(ids)+');out meta;>;out meta;'
    get('osm-route-members', args.endpoint+'?'+urllib.parse.urlencode({'data':query}), limit=8_000_000, licence='© OpenStreetMap contributors; ODbL1.0; https://www.openstreetmap.org/copyright')
print('ARTIFACT',out)
