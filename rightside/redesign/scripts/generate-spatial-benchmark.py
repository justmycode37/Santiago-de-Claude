#!/usr/bin/env python3
"""Independent pinhole truth generator, standard library only. No fitting/Swift solver reuse.
Seed 20261121 is held-out from tuning; this is synthetic calibrated correspondences, not camera detection.
"""
import json,math,random,hashlib,struct,zlib,datetime
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'dist/workstream-C/benchmark';OUT.mkdir(parents=True,exist_ok=True)
if json.loads((ROOT.parent/'docs/hill-climb/STATE.json').read_text()).get('stopRequested'):raise SystemExit('STOP REQUESTED')
rng=random.Random(20261121)
def pose(x,y,z,yaw,pitch):
 t=math.radians(yaw);p=math.radians(pitch)
 right=[math.cos(t),-math.sin(t),0];up=[-math.sin(t)*math.sin(p),-math.cos(t)*math.sin(p),math.cos(p)];back=[-math.sin(t)*math.cos(p),-math.cos(t)*math.cos(p),-math.sin(p)]
 return right+[0]+up+[0]+back+[0]+[x,y,z,1]
def project(point,m):
 d=[point[i]-m[12+i] for i in range(3)];c=[sum(d[i]*m[j*4+i] for i in range(3)) for j in range(3)]
 if c[2]>=-.05:return None
 return [900*c[0]/-c[2]+640,480-900*c[1]/-c[2]]
landmarks=[]
for i,(x,y) in enumerate([(-2,3),(0,3.4),(2,4)]):
 for dx,z in [(-.6,.5),(.6,.5),(-.6,1.4),(.6,1.4),(-.6,2.3),(.6,2.3)]:landmarks.append((f'board-{i}',[x+dx,y,z]))
views=[]
for i in range(120):
 x,y,z=rng.uniform(-1.5,1.5),rng.uniform(-6,-2),rng.uniform(1.2,1.9);yaw,pitch=rng.uniform(-12,12),rng.uniform(-5,5)
 truth=pose(x,y,z,yaw,pitch);observations=[]
 for ident,point in landmarks:
  pixel=project(point,truth)
  if pixel and 10<pixel[0]<1270 and 10<pixel[1]<950:
   pixel=[pixel[0]+rng.gauss(0,.55),pixel[1]+rng.gauss(0,.55)]
   observations.append({'landmarkID':ident,'sitePoint':point,'pixel':pixel})
 # Declared controlled outliers: every third view has 2 corrupt pixel matches.
 if i%3==0:
  for o in observations[:2]:o['pixel'][0]+=18;o['pixel'][1]-=12
 initial=pose(x+rng.uniform(-.15,.15),y+rng.uniform(-.15,.15),z+rng.uniform(-.08,.08),yaw+rng.uniform(-2,2),pitch+rng.uniform(-1,1))
 # Independent target points never enter the fit; registration error uses these.
 targets=[[.3,4.5,.6],[-1.1,4,2.1],[1.7,4.6,1.4]]
 views.append({'id':f'heldout-{i:03d}','truth':truth,'initial':initial,'observations':observations,'targets':targets,'truthTargetPixels':[project(p,truth) for p in targets],'hasOutliers':i%3==0})
data={'schemaVersion':1,'evidenceKind':'synthetic_known_geometry','seed':20261121,'generator':'independent Python analytic pinhole + Gaussian pixel noise; no pose solver','calibration':{'width':1280,'height':960,'fx':900,'fy':900,'cx':640,'cy':480,'imageOrientation':'raw_sensor'},'views':views}
b=(json.dumps(data,separators=(',',':'))+'\n').encode();(OUT/'heldout.json').write_bytes(b)
print('Synthetic views',len(views),'SHA256',hashlib.sha256(b).hexdigest())
# Generate an explicitly synthetic physical-reference template for authoring/import rejection tests.
site=OUT/'synthetic-survey';site.mkdir(exist_ok=True)
def png(seed):
 r=random.Random(seed);w=h=256;rows=[]
 for y in range(h):
  row=bytearray()
  for x in range(w):
   c=(25 if ((x//16+y//16)%2) else 220) if (x+y)%13 else r.randrange(256)
   row.extend([c,(c+seed*17)%256,(c+seed*31)%256])
  rows.append(b'\x00'+bytes(row))
 def chunk(k,v):return struct.pack('>I',len(v))+k+v+struct.pack('>I',zlib.crc32(k+v)&0xffffffff)
 return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(rows)))+chunk(b'IEND',b'')
refs=[]
for i in range(2):
 name=f'synthetic-reference-{i}.png';(site/name).write_bytes(png(i+1));m=[1,0,0,0,0,1,0,0,0,0,1,0,i*2,0,1,1]
 refs.append({'id':f'synthetic-{i}','imageFile':name,'imageSHA256':hashlib.sha256((site/name).read_bytes()).hexdigest(),'physicalWidthMeters':1,'pixelWidth':256,'pixelHeight':256,'siteFromImage':m,'uniqueAtSite':True})
survey={'siteID':'SYNTHETIC-NOT-BERN-FIELD','version':'1','source':'Generated geometry only, not surveyed Bern','license':'Project-generated synthetic fixtures','surveyedAt':'2026-11-21T00:00:00Z','expiresAt':'2026-11-22T00:00:00Z','originLatitude':46.948,'originLongitude':7.44,'landmarkSurveyErrorMeters':.1,'validationDeviceModels':['synthetic-hardware-only'],'maximumViewDistanceMeters':10,'landmarks':refs,'areas':[{'id':'test-only','stopID':'test-only','label':'SYNTHETIC','level':'test-floor','floorHeightMeters':0,'polygonENU':[[-4,-4],[4,-4],[4,4],[-4,4]],'surveyedClearanceMeters':1}]}
surveyBytes=(json.dumps(survey,indent=2)+'\n').encode();(site/'survey.json').write_bytes(surveyBytes)
checks={'evidenceKind':'synthetic_known_geometry','referenceSurveySHA256':hashlib.sha256(surveyBytes).hexdigest(),'usedForReferenceFitting':False,'checkpoints':[{'id':f'test-{i}','truthCameraENU':[i*.1,0,1.6],'estimatedCameraENU':[i*.1+.1,.05,1.6],'truthHeadingDegrees':0,'estimatedHeadingDegrees':.5,'heldOutRegistrationErrorPixels':1} for i in range(20)]}
(site/'checkpoints.json').write_text(json.dumps(checks,indent=2)+'\n')
