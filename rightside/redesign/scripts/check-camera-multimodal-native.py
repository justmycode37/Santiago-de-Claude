#!/usr/bin/env python3
"""Granted sequential native runtime/preprocessing parity; fixed original tensor gates."""
import datetime,hashlib,json,os,resource,shutil,subprocess,tempfile,time
from pathlib import Path
root=Path(__file__).resolve().parents[1]
assert not json.loads((root.parent/'docs/hill-climb/STATE.json').read_text())['stopRequested']
parent=root/'dist/hill-climb-b3';original=parent/'conversion.zhizqi_c'
out=Path(tempfile.mkdtemp(prefix='swift-parity.',dir=parent))
source_names=['VehicleEvidence','VehicleDisplayRecognition','VehicleDisplayRuntime']
sources=[root/'apps/ios/RightSide/Sensors'/(n+'.swift') for n in source_names]+[root/'scripts/check-camera-multimodal-native-parity.swift']
manifest={'started':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sources':{},'originalModelParity':str(original),'capSecondsPerOperation':300,'threads':1}
for p in sources:
 shutil.copyfile(p,out/p.name);manifest['sources'][p.name]=hashlib.sha256(p.read_bytes()).hexdigest()
manifest['load']=subprocess.check_output(['uptime'],text=True).strip()
manifest['swap']=subprocess.check_output(['sysctl','vm.swapusage'],text=True).strip()
print(out,flush=True)
env=dict(os.environ,OMP_NUM_THREADS='1',VECLIB_MAXIMUM_THREADS='1')
def run(command,label):
 assert not json.loads((root.parent/'docs/hill-climb/STATE.json').read_text())['stopRequested']
 at=time.monotonic();manifest[label]={'command':list(map(str,command)),'started':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 (out/'manifest.json').write_text(json.dumps(manifest,indent=2))
 with (out/(label+'.log')).open('w') as log:
  result=subprocess.run(command,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=300)
 manifest[label].update(exitCode=result.returncode,seconds=time.monotonic()-at)
 manifest['childPeakResidentBytes']=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
 (out/'manifest.json').write_text(json.dumps(manifest,indent=2));print((out/(label+'.log')).read_text()[-8000:],flush=True)
 if result.returncode:raise SystemExit(result.returncode)
# Frozen tensor inputs are never regenerated/replaced. Reconstruct only their source pixels
# with the exact original crop recipe so Swift's preprocessing can be measured against them.
prepare='''import cv2,json,math,numpy as np,sys
from pathlib import Path
root,out=map(Path,sys.argv[1:]);rows=json.loads((root/'dist/hill-climb-b3/paddle.e0qch6nx/report.json').read_text())['rows'];result=[]
for row in rows:
 if row.get('padding')!=0:continue
 image=cv2.imread(str(root/'evaluation/images'/(row['sample']+'.jpg')))
 scale=min(1,row['sceneLongestSide']/max(image.shape[:2]));image=cv2.resize(image,(round(image.shape[1]*scale),round(image.shape[0]*scale)))
 x,y,w,h=row['cropPixels'];crop=image[y:y+h,x:x+w];index=len(result)
 crop.tofile(out/('crop-'+str(index)+'.bgr'));result.append({'index':index,'width':w,'height':h})
(out/'crop-manifest.json').write_text(json.dumps(result,indent=2))
'''
(out/'prepare.py').write_text(prepare)
run([str(root/'.venv-vision/bin/python'),str(out/'prepare.py'),str(root),str(out)],'prepare')
run(['xcrun','swiftc','-O','-whole-module-optimization','-target','arm64-apple-macos14.0','-swift-version','5','-strict-concurrency=complete','-warnings-as-errors',*[str(out/p.name) for p in sources],'-o',str(out/'experiment')],'compile')
run([str(out/'experiment'),str(original),str(out)],'parity')
