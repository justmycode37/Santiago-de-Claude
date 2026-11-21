#!/usr/bin/env python3
"""Bounded public reference acquisition. No authentication, retries or bulk tile crawl.
Existing Atlas bytes are verified against their original manifest, never restamped.
OSM raw snapshot remains ODbL; generated pack is a derived database with attribution.
"""
import argparse, datetime as dt, hashlib, json, urllib.request, urllib.parse
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
BBOX=[7.425,46.938,7.455,46.957]
UA='RightSide-spatial-research/1.0 (+https://github.com/justmycode37/Powercoders-Hackathon)'
def sha(b): return hashlib.sha256(b).hexdigest()
def stop():
    p=ROOT.parent/'docs/hill-climb/STATE.json'
    if p.exists() and json.loads(p.read_text()).get('stopRequested'): raise SystemExit('STOP REQUESTED')
def fetch(url, limit, body=None):
    stop()
    req=urllib.request.Request(url,data=body,headers={'User-Agent':UA,'Accept':'application/json'})
    with urllib.request.urlopen(req,timeout=55) as r:
        b=r.read(limit+1)
        if len(b)>limit: raise ValueError('Response exceeded byte cap')
        return b,dict(r.headers)
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,default=ROOT/'dist/workstream-C/snapshots');parser.add_argument('--refresh',action='store_true');parser.add_argument('--atlas-url',help='Explicit official public CSV URL; bounded 30 MB refresh, no API-key use');a=parser.parse_args()
    a.out.mkdir(parents=True,exist_ok=True);stop()
    manifest_path=a.out/'manifest.json'
    manifest=json.loads(manifest_path.read_text()) if manifest_path.exists() else {'schemaVersion':1,'bbox':BBOX,'sources':[],'accessFailures':[]}
    if a.atlas_url:
        parsed=urllib.parse.urlparse(a.atlas_url)
        if parsed.scheme!='https' or parsed.hostname!='data.opentransportdata.swiss':raise ValueError('Use the official public Atlas CSV host')
        raw,headers=fetch(a.atlas_url,30_000_000)
        if not raw.decode('utf-8-sig').startswith('sloid;'):raise ValueError('Not an Atlas CSV; metadata/error page rejected')
        stamp=dt.datetime.now(dt.timezone.utc);filename='atlas-traffic-points-'+stamp.strftime('%Y%m%dT%H%M%SZ')+'.csv';(a.out/filename).write_bytes(raw)
        atlas={'id':'atlas-traffic-points','file':filename,'url':a.atlas_url,'sha256':sha(raw),'bytes':len(raw),'fetchedAt':stamp.isoformat(),'expiresAt':(stamp+dt.timedelta(days=1)).isoformat(),'license':'https://opentransportdata.swiss/en/terms-of-use/','attribution':'Source: opentransportdata.swiss / atlas (SKI). Bern subset prepared by RightSide.','status':'downloaded','serverDate':headers.get('Date')}
    else:
        retained=next((s for s in manifest['sources'] if s['id']=='atlas-traffic-points' and s.get('status')=='downloaded'),None)
        if retained:
            raw=(a.out/retained['file']).read_bytes()
            if sha(raw)!=retained['sha256']:raise ValueError('Retained Atlas source checksum mismatch')
            atlas=retained
        else:
            old=json.loads((ROOT/'apps/ios/RightSide/Resources/TransportPacks/bern-boarding.json').read_text());csv=ROOT/'research/traffic-points.csv';raw=csv.read_bytes()
            if sha(raw)!=old['sourceSHA256']: raise ValueError('Existing Atlas CSV does not match historical snapshot hash; supply --atlas-url for an actual fresh download')
            atlas={'id':'atlas-traffic-points','path':str(csv.relative_to(ROOT)),'url':old['source'],'sha256':sha(raw),'bytes':len(raw),'fetchedAt':old['fetchedAt'],'expiresAt':old['expiresAt'],'license':old['license'],'attribution':old['attribution'],'status':'historical_verified_snapshot'}
    manifest['sources']=[s for s in manifest['sources'] if s['id']!=atlas['id']]+[atlas]
    west,south,east,north=BBOX;box=f'{south},{west},{north},{east}'
    query=f'[out:json][timeout:40][maxsize:8000000];(way[highway~"^(footway|pedestrian|path|steps)$"]({box});nwr[entrance]({box});nwr[public_transport=platform]({box});node[highway=crossing]({box});node[highway=elevator]({box}););out meta geom;'
    specs=[('osm-bern-pedestrian','https://overpass.osm.ch/api/interpreter?'+urllib.parse.urlencode({'data':query}),None,8000000,30,'https://www.openstreetmap.org/copyright','© OpenStreetMap contributors, ODbL 1.0'),
           ('swissimage-catalogue','https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo.swissimage-dop10/items?'+urllib.parse.urlencode({'bbox':','.join(map(str,BBOX)),'limit':4}),None,1000000,365,'https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices','© swisstopo; catalogue metadata only, not ground-camera pose references')]
    for ident,url,body,cap,days,license,credit in specs:
        existing=next((s for s in manifest['sources'] if s['id']==ident),None)
        if existing and not a.refresh:
            p=a.out/existing['file']
            if p.exists() and sha(p.read_bytes())==existing['sha256']: print('Retained snapshot',ident);continue
        try:
            raw,headers=fetch(url,cap,body);decoded=json.loads(raw)
            if ident.startswith('osm') and ('elements' not in decoded or 'remark' in decoded): raise ValueError('Incomplete Overpass response')
            stamp=dt.datetime.now(dt.timezone.utc);filename=ident+'-'+stamp.strftime('%Y%m%dT%H%M%SZ')+'.json';(a.out/filename).write_bytes(raw)
            source={'id':ident,'file':filename,'url':url,'request':query if ident.startswith('osm') else None,'sha256':sha(raw),'bytes':len(raw),'fetchedAt':stamp.isoformat(),'expiresAt':(stamp+dt.timedelta(days=days)).isoformat(),'license':license,'attribution':credit,'status':'downloaded','serverDate':headers.get('Date'),'osmBaseTimestamp':decoded.get('osm3s',{}).get('timestamp_osm_base')}
            manifest['sources']=[s for s in manifest['sources'] if s['id']!=ident]+[source];print('Fetched',ident,len(raw),'bytes')
        except Exception as e:
            failure={'id':ident,'url':url,'at':dt.datetime.now(dt.timezone.utc).isoformat(),'error':str(e)};manifest['accessFailures'].append(failure);print('Unavailable',ident,str(e))
        manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    print(manifest_path)
if __name__=='__main__':main()
