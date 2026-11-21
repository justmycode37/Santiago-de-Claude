#!/usr/bin/env python3
"""Immutable SDK integration compile, never hosted tests/install or whole-app build."""
import pathlib,datetime,json,hashlib,shutil,subprocess,os,time
root=pathlib.Path(__file__).resolve().parents[1]
assert not json.load(open(root.parent/'docs/hill-climb/STATE.json'))['stopRequested']
out=root/'dist/workstream-C/C2'/datetime.datetime.now(datetime.timezone.utc).strftime('ios-%Y%m%dT%H%M%SZ');out.mkdir(parents=True)
start=time.monotonic();record={'startUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'maxSeconds':300,'scope':'immutable full production Swift module plus four relevant test files, SDK compile only','commands':[],'exit':1};manifest=[]
sources=sorted((root/'apps/ios/RightSide').rglob('*.swift'));tests=[root/f'apps/ios/RightSideTests/{name}.swift'for name in ['VisualReferenceTests','SpatialReferenceTests','LocalPoseFrameTests','CameraEvidenceLifecycleTests']]
for source in sources+tests:
 relative=source.relative_to(root);target=out/'snapshot'/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target);manifest.append({'path':str(relative),'sha256':hashlib.sha256(target.read_bytes()).hexdigest()})
xcode=pathlib.Path('/Applications/Xcode.app/Contents/Developer');env={**os.environ,'DEVELOPER_DIR':str(xcode)}
sdk=subprocess.check_output(['xcrun','--sdk','iphonesimulator','--show-sdk-path'],env=env,text=True,timeout=10).strip()
common=['xcrun','swiftc','-target','arm64-apple-ios17.0-simulator','-sdk',sdk,'-swift-version','5','-strict-concurrency=complete','-warnings-as-errors']
commands=[common+['-emit-module','-enable-testing','-module-name','RightSide']+[str(out/'snapshot'/p.relative_to(root))for p in sources]+['-emit-module-path',str(out/'RightSide.swiftmodule')],common+['-typecheck','-F',str(xcode/'Platforms/iPhoneSimulator.platform/Developer/Library/Frameworks'),'-I',str(xcode/'Platforms/iPhoneSimulator.platform/Developer/usr/lib'),'-I',str(out)]+[str(out/'snapshot'/p.relative_to(root))for p in tests]]
try:
 for i,cmd in enumerate(commands):
  assert not json.load(open(root.parent/'docs/hill-climb/STATE.json'))['stopRequested']
  record['commands'].append(cmd)
  with open(out/f'{i}.log','w')as log:p=subprocess.run(cmd,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=max(1,300-(time.monotonic()-start)))
  print(out/f'{i}.log',p.returncode,flush=True)
  if p.returncode:record['exit']=p.returncode;break
 else:record['exit']=0
finally:
 record['endUTC']=datetime.datetime.now(datetime.timezone.utc).isoformat();record['seconds']=time.monotonic()-start
 (out/'operation.json').write_text(json.dumps(record,indent=2)+'\n');(out/'source-manifest.json').write_text(json.dumps({'sourceCommit':None,'files':manifest},indent=2)+'\n')
raise SystemExit(record['exit'])
