#!/usr/bin/env python3
"""Build a frozen private research fixture pack. No model inference or app execution."""
import hashlib,json,shutil,datetime
from pathlib import Path
import numpy as np
from PIL import Image
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'dist/ios/indoor-lab/IndoorLab'; OUT.mkdir(parents=True,exist_ok=True)
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def stage(src,dst):
 p=OUT/dst;p.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,p);return sha(p)
photos=[]
for name,kind,box,line,dest in [('bus','bus',[.055,.17,.91,.65],'12','Bern Bahnhof'),('tram','tram',[.285,.215,.49,.55],'8','Brünnen Westside Bhf')]:
 src=ROOT/f'redesign/evaluation/images/{name}.jpg';path=f'photos/{name}.jpg'
 photos.append(dict(id=name,path=path,sha256=stage(src,path),kind=kind,box=box,line=line,destination=dest))
old=ROOT/'redesign/evaluation/camera-temporal/alternative-01'
a=json.loads((old/'annotations.json').read_text()); video=[]
for f in a['frames']:
 path='video/'+Path(f['path']).name
 assert sha(old/f['path'])==f['sha256']
 video.append(dict(path=path,sha256=stage(old/f['path'],path),pts=f['sourcePTS'],boxes=[x['box'] for x in f['annotations']]))
base=ROOT/'redesign/evaluation/indoor-lab/originals/cables_2'
k=np.loadtxt(base/'calibration.txt'); gt=np.loadtxt(base/'groundtruth.txt')
def pose(t):
 i=int(np.searchsorted(gt[:,0],t));assert 0<i<len(gt)
 a,b=gt[i-1],gt[i];f=(t-a[0])/(b[0]-a[0]);q=a[4:].copy();r=b[4:].copy()
 if q@r<0:r=-r
 dot=np.clip(q@r,-1,1)
 if dot>.9995:q=q*(1-f)+r*f
 else:
  ang=np.arccos(dot);q=(np.sin((1-f)*ang)*q+np.sin(f*ang)*r)/np.sin(ang)
 q/=np.linalg.norm(q);x,y,z,w=q
 R=np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
 P=np.eye(4);P[:3,:3]=R;P[:3,3]=a[1:4]*(1-f)+b[1:4]*f;return P
rgb=[(float(l.split()[0]),l.split()[1]) for l in (base/'rgb.txt').read_text().splitlines() if l and not l.startswith('#')]
t0,p0=rgb[0];P0=pose(t0);im=np.array(Image.open(base/p0).convert('RGB'));h,w=im.shape[:2];dep=np.array(Image.open(base/'depth'/Path(p0).name))/5000
fx,fy,cx,cy=k
points=[];colors=[]
for y in range(0,h,6):
 for x in range(0,w,6):
  z=dep[y,x]
  if .1<z<5:
   p=P0@[(x-cx)*z/fx,(y-cy)*z/fy,z,1];points.append(p[:3].tolist());colors.append((im[y,x]/255).tolist())
# Fixed grid picks in first measured depth image, frozen before inference.
targets=[]
for x,y in [(w//2,h//2),(w//3,h//2),(2*w//3,h//2),(w//2,2*h//3)]:
 z=dep[y,x];assert z>.1
 targets.append((P0@[(x-cx)*z/fx,(y-cy)*z/fy,z,1])[:3].tolist())
frames=[]; flip=np.diag([1,-1,-1,1])
for t,path in rgb:
 P=pose(t);expected=[]
 for target in targets:
  v=np.linalg.inv(P)@[*target,1]
  expected.append([fx*v[0]/v[2]+cx,fy*v[1]/v[2]+cy] if v[2]>.05 else None)
 dst='geometry/'+Path(path).name
 frames.append(dict(path=dst,sha256=stage(base/path,dst),pts=t-t0,pose=(P@flip).T.flatten().tolist(),expected=expected))
geometry=dict(calibration=dict(width=w,height=h,fx=fx,fy=fy,cx=cx,cy=cy,imageOrientation='raw_sensor'),targets=targets,frames=frames,points=points,colors=colors)
(OUT/'geometry.json').write_text(json.dumps(geometry,separators=(',',':')))
attribution='''PRIVATE NONCOMMERCIAL RESEARCH FIXTURES — not app distribution assets.
ETH3D cables_2: Thomas Schöps, Torsten Sattler, Marc Pollefeys. BAD SLAM, CVPR 2019. CC BY-NC-SA 4.0 https://creativecommons.org/licenses/by-nc-sa/4.0/ . https://www.eth3d.net/slam_datasets and https://www.eth3d.net/slam_documentation . Original RGB/depth unmodified; derived point cloud at 6-pixel grid, interpolated reference poses, projection oracle. Ground-truth poses are inputs, not localization estimates.
MOTChallenge MOT17-14: benchmark contributors, camera operator unspecified. CC BY-NC-SA 3.0 https://creativecommons.org/licenses/by-nc-sa/3.0/ . https://motchallenge.net/sequenceVideos/MOT17-14-DPM-raw.mp4 . 48 unmodified sampled frames; 7 sparse annotated frames, unreadable displays. One sequence, not 48 encounters.
Bus: S5A-0043, CC BY-SA 4.0 https://commons.wikimedia.org/wiki/File:BRN_Bernmobil_218_BE-881218_12_2023-11-27.jpg . Original unmodified.
Tram: Nicolapps, CC BY 4.0 https://commons.wikimedia.org/wiki/File:Stadler_Tramlink_Bernmobil.jpg . Original unmodified.
Photographs and MOT clip previously used for development; not an unseen test. Boxes are coarse manual extents. Still photos test reading, never temporal service confirmation. Frozen before this phone run.
'''
(OUT/'ATTRIBUTION.txt').write_text(attribution)
manifest=dict(version=1,id='indoor-lab-v1',frozenAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),photos=photos,video=video,geometrySHA256=sha(OUT/'geometry.json'),attribution=attribution,thresholds=dict(vehicleIoU=.35,projectionPixels=.1),coverage='Two positive stills; one unreadable moving-camera clip with sparse boxes; one indoor calibrated RGB-D sequence. Geometry uses supplied reference poses. No geographic AR, independently estimated pose, curb, safe path, live-service or field acceptance.')
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2))
(ROOT/'redesign/evaluation/indoor-lab/frozen-contract.json').write_text(json.dumps(dict(manifestSHA256=sha(OUT/'manifest.json'),geometrySHA256=sha(OUT/'geometry.json'),photos=photos,frames=len(video),geometryFrames=len(frames),pointCount=len(points),thresholds=manifest['thresholds'],coverage=manifest['coverage']),indent=2))
print(json.dumps(dict(path=str(OUT),manifestSHA256=sha(OUT/'manifest.json'),videoFrames=len(video),geometryFrames=len(frames),points=len(points)),indent=2))
