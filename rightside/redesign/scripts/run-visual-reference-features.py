#!/usr/bin/env python3
import pathlib,json,hashlib,datetime,subprocess,shutil,time,os
root=pathlib.Path(__file__).resolve().parents[1]
assert not json.load(open(root.parent/'docs/hill-climb/STATE.json'))['stopRequested']
out=root/'dist/workstream-C/C2'/datetime.datetime.now(datetime.timezone.utc).strftime('features-%Y%m%dT%H%M%SZ');out.mkdir(parents=True)
start=time.monotonic();record={'startUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'maxSeconds':300,'scope':'one strict compiler then serial frozen10 synthetic and2 exposed real-development pairs; no network','commands':[],'exit':1};manifest=[]
sources=[root/f'apps/ios/RightSide/Spatial/{name}.swift'for name in ['CalibratedPoseGeometry','VisualReferenceGeometry','VisualReferenceMatcher','VisualReferenceRefinement','VisualReferenceProposals','VisualReferenceFeatures']]+[root/'scripts/check-visual-reference-features.swift']
for source in sources+[root/f'scripts/{name}'for name in ['run-visual-reference-features.py','evaluate-visual-reference.py','evaluate-visual-reference-public.py']]+[root/'research/visual-reference/C2-feature-proposal-contract.json']:
 relative=source.relative_to(root);target=out/'snapshot'/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target);manifest.append({'path':str(relative),'sha256':hashlib.sha256(target.read_bytes()).hexdigest()})
synthetic=root/'dist/workstream-C/C2/matrix-20261121T053504Z/fixtures';public=root/'dist/workstream-C/C2/public-20261121T054230Z/captures'
commands=[['xcrun','swiftc','-O','-swift-version','5','-strict-concurrency=complete','-warnings-as-errors']+[str(out/'snapshot'/p.relative_to(root))for p in sources]+['-o',str(out/'replay')],[str(out/'replay'),'synthetic',str(synthetic)],[str(out/'replay'),'public',str(public)]]
try:
 for i,cmd in enumerate(commands):
  assert not json.load(open(root.parent/'docs/hill-climb/STATE.json'))['stopRequested'];record['commands'].append(cmd)
  with open(out/f'{i}.log','w')as log:p=subprocess.run(cmd,cwd=root,stdout=log,stderr=subprocess.STDOUT,timeout=max(1,300-(time.monotonic()-start)),env={**os.environ,'DEVELOPER_DIR':'/Applications/Xcode.app/Contents/Developer'})
  print(out/f'{i}.log',p.returncode,flush=True)
  if p.returncode:record['exit']=p.returncode;break
 else:record['exit']=0
finally:
 record['endUTC']=datetime.datetime.now(datetime.timezone.utc).isoformat();record['seconds']=time.monotonic()-start
 (out/'operation.json').write_text(json.dumps(record,indent=2)+'\n');(out/'source-manifest.json').write_text(json.dumps({'sourceCommit':None,'inputSnapshots':[str(synthetic),str(public)],'files':manifest},indent=2)+'\n')
raise SystemExit(record['exit'])
