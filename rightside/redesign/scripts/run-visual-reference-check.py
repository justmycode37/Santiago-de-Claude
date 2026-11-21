#!/usr/bin/env python3
"""Single bounded operation; freezes exact compiled sources and actual input fixtures."""
import pathlib,json,subprocess,datetime,time,os,hashlib,shutil
root=pathlib.Path(__file__).resolve().parents[1]
assert not json.load(open(root.parent/'docs/hill-climb/STATE.json'))['stopRequested']
out=root/'dist/workstream-C/C2'/datetime.datetime.now(datetime.timezone.utc).strftime('matrix-%Y%m%dT%H%M%SZ');out.mkdir(parents=True)
start=time.monotonic();record={'startUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'one serial native compile,32 tests,11 single-plane and3 two-plane actual-pixel cases plus5 repeated native buffer deliveries','maxSeconds':300,'threads':'one serial inference worker; Apple internal thread count uncontrolled','commands':[],'exit':1}
sources=sorted(root.glob('apps/ios/RightSide/Spatial/*.swift'))+[root/'apps/ios/RightSide/Sensors/LocalLandmarkGeometry.swift']+[root/f'apps/ios/RightSideTests/{name}.swift'for name in ['VisualReferenceTests','SpatialReferenceTests','LocalPoseFrameTests']]+[root/'scripts/check-visual-reference.swift',root/'scripts/check-visual-reference-capture.swift']
snapshot=out/'snapshot';files=[]
for source in sources+[root/f'scripts/{name}'for name in ['generate-visual-reference-benchmark.py','run-visual-reference-check.py','evaluate-visual-reference.py']]:
 relative=source.relative_to(root);target=snapshot/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target);files.append({'path':str(relative),'sha256':hashlib.sha256(target.read_bytes()).hexdigest()})
xcode=pathlib.Path('/Applications/Xcode.app/Contents/Developer');frameworks=xcode/'Platforms/MacOSX.platform/Developer/Library/Frameworks';libraries=xcode/'Platforms/MacOSX.platform/Developer/usr/lib'
commands=[['python3',str(snapshot/'scripts/generate-visual-reference-benchmark.py')],['xcrun','swiftc','-O','-swift-version','5','-strict-concurrency=complete','-warnings-as-errors','-D','SPATIAL_HARNESS','-F',str(frameworks),'-I',str(libraries),'-L',str(libraries),'-Xlinker','-rpath','-Xlinker',str(frameworks),'-Xlinker','-rpath','-Xlinker',str(libraries)]+[str(snapshot/p.relative_to(root))for p in sources]+['-o',str(out/'replay')],[str(out/'replay'),str(out/'fixtures')]]
# Generator uses its repository-relative stop/root; execute working generator, frozen copy retained.
commands[0]=['python3',str(root/'scripts/generate-visual-reference-benchmark.py')]
env={**os.environ,'DEVELOPER_DIR':str(xcode),'SPATIAL_PACK_PATH':str(root/'apps/ios/RightSide/Resources/SpatialPacks/bern-spatial.json'),'SPATIAL_BUNDLE_PATH':str(root/'dist/workstream-C/SpatialResources.bundle'),'SPATIAL_SYNTHETIC_SITE':str(root/'dist/workstream-C/benchmark/synthetic-site/site.json')}
try:
 for i,cmd in enumerate(commands):
  assert not json.load(open(root.parent/'docs/hill-climb/STATE.json'))['stopRequested']
  record['commands'].append(cmd)
  with open(out/f'{i}.log','w')as log:p=subprocess.run(cmd,cwd=root,stdout=log,stderr=subprocess.STDOUT,timeout=max(1,300-(time.monotonic()-start)),env=env)
  print(out/f'{i}.log',p.returncode,flush=True)
  if i==0:
   shutil.copytree(root/'dist/workstream-C/C2/fixtures',out/'fixtures')
   for file in sorted((out/'fixtures').iterdir()):files.append({'path':str(file.relative_to(out)),'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
  if p.returncode:record['exit']=p.returncode;break
 else:record['exit']=0
finally:
 record['endUTC']=datetime.datetime.now(datetime.timezone.utc).isoformat();record['seconds']=time.monotonic()-start;(out/'operation.json').write_text(json.dumps(record,indent=2)+'\n');(out/'source-manifest.json').write_text(json.dumps({'sourceCommit':None,'files':files},indent=2)+'\n')
 if (out/'2.log').exists():
  subprocess.run(['python3',str(snapshot/'scripts/evaluate-visual-reference.py'),str(out/'fixtures/manifest.json'),str(out/'2.log'),str(out/'evaluation.json')],cwd=root,timeout=10)
raise SystemExit(record['exit'])
