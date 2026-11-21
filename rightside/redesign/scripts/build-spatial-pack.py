#!/usr/bin/env python3
"""Deterministic bounded normalization; provenance time belongs to acquisition, not this build."""
import argparse,csv,hashlib,json,math
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
BBOX=[7.37,46.91,7.51,46.99]
def sha(data):return hashlib.sha256(data).hexdigest()
def main():
 p=argparse.ArgumentParser();p.add_argument('--snapshots',type=Path,default=ROOT/'dist/workstream-C/snapshots');p.add_argument('--output',type=Path,default=ROOT/'apps/ios/RightSide/Resources/SpatialPacks/bern-spatial.json');a=p.parse_args()
 state=ROOT.parent/'docs/hill-climb/STATE.json'
 if state.exists() and json.loads(state.read_text()).get('stopRequested'):raise SystemExit('STOP REQUESTED')
 manifest=json.loads((a.snapshots/'manifest.json').read_text());features=[];sources=[];catalogues=[]
 for source in sorted(manifest['sources'],key=lambda s:s['id']):
  file=ROOT/source['path'] if 'path' in source else a.snapshots/source['file'];raw=file.read_bytes()
  if sha(raw)!=source['sha256']:raise ValueError('Source checksum mismatch: '+str(file))
  normalized={k:source[k] for k in ['id','url','sha256','fetchedAt','expiresAt','license','attribution']}
  normalized['contentTimestamp']=source.get('osmBaseTimestamp');sources.append(normalized)
  if source['id']=='atlas-traffic-points':
   for row in csv.DictReader(raw.decode('utf-8-sig').splitlines(),delimiter=';'):
    if row['trafficPointElementType']!='BOARDING_PLATFORM' or row['status']!='VALIDATED':continue
    try:lat,lon=float(row['wgs84North']),float(row['wgs84East'])
    except ValueError:continue
    if not (BBOX[0]<=lon<=BBOX[2] and BBOX[1]<=lat<=BBOX[3]):continue
    # Exact source column 'number' is the official service-point number, retained namespaced and raw for provider IDs.
    aliases=[row['number'],'uic:'+row['number']] if row.get('number') else []
    bearing=float(row['compassDirection']) if row.get('compassDirection') else None
    if bearing is not None and (not math.isfinite(bearing) or not 0<=bearing<=360):bearing=None
    features.append({'id':row['sloid'],'kind':'boardingReference','name':row['designationOfficial'],'sourceID':source['id'],
     'geometry':[{'latitude':lat,'longitude':lon}],'precision':'boardingReference','parentStopID':row['parentSloidServicePoint'],
     'parentStopAliases':aliases,'signLabel':row['designation'] or row['designationOperational'] or None,'level':None,
     'validFrom':row['validFrom'],'validUntil':row['validTo'],'directionDegrees':bearing,'sourceEditedAt':row['editionDate'],
     'tags':{'atlas:status':row['status'],'atlas:parent':row['parentSloid']},'accuracyMeters':None})
  elif source['id']=='osm-bern-pedestrian':
   osm=json.loads(raw)
   for element in osm['elements']:
    tags=element.get('tags',{});geometry=[]
    if element['type']=='node':geometry=[{'latitude':element['lat'],'longitude':element['lon']}]
    elif element['type']=='way':geometry=[{'latitude':v['lat'],'longitude':v['lon']} for v in element.get('geometry',[]) if v]
    else:continue # Multipolygon members need topological assembly, never flatten into a fabricated path.
    if not geometry:continue
    kind='entrance' if 'entrance' in tags else 'platform' if tags.get('public_transport')=='platform' else 'crossing' if tags.get('highway')=='crossing' else 'elevator' if tags.get('highway')=='elevator' else 'pedestrianPath'
    keep={k:v for k,v in tags.items() if k in ['highway','entrance','level','layer','indoor','access','foot','wheelchair','surface','incline','tactile_paving','crossing','lit','covered','public_transport','ref','name']}
    features.append({'id':f"osm:{element['type']}:{element['id']}",'kind':kind,'name':tags.get('name',tags.get('ref','')),'sourceID':source['id'],
     'geometry':geometry,'precision':'mappedCandidate','parentStopAliases':[],'level':tags.get('level') or None,'sourceEditedAt':element.get('timestamp'),'tags':keep,
     'signLabel':tags.get('ref'),'accuracyMeters':None})
  elif source['id']=='swissimage-catalogue':
   catalogues=[item['id'] for item in json.loads(raw).get('features',[])]
 features.sort(key=lambda f:f['id'])
 if len({f['id'] for f in features})!=len(features):
  # Atlas multiple validity periods for same SLOID are legitimate. Keep dated stable record IDs, raw SLOID remains explicit in tags.
  from collections import Counter
  counts=Counter(f['id'] for f in features)
  for f in features:
   if counts[f['id']]>1: f['tags']['atlas:sloid']=f['id']; f['id']+='@'+f.get('validFrom','')+'_'+f.get('validUntil','')
  if len({f['id'] for f in features})!=len(features):raise ValueError('Duplicate identity/version rows; require review, never take first')
 payload={'schemaVersion':1,'id':'bern-spatial-reference-v1','bbox':BBOX,'sources':sources,'features':features,'referenceCatalogues':catalogues}
 payload['version']=sha(json.dumps(payload,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode())[:16]
 data=(json.dumps(payload,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n').encode();a.output.parent.mkdir(parents=True,exist_ok=True);temporary=a.output.with_suffix('.json.tmp');temporary.write_bytes(data);temporary.replace(a.output)
 from collections import Counter
 summary={'features':dict(Counter(f['kind'] for f in features)),'total':len(features),'explicitLevels':sum(f.get('level') is not None for f in features),'surveyedAreas':0,'packSHA256':sha(data),'bytes':len(data),'sources':[{'id':s['id'],'sha256':s['sha256'],'fetchedAt':s['fetchedAt']} for s in sources]}
 (a.snapshots.parent/'pack-summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2))
if __name__=='__main__':main()
