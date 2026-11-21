#!/usr/bin/env python3
"""One scheduled bounded acquisition + frozen native real-capture replay. No full archive."""
import pathlib,json,hashlib,datetime,subprocess,shutil,time,os,sys
root=pathlib.Path(__file__).resolve().parents[1]
assert not json.load(open(root.parent/'docs/hill-climb/STATE.json'))['stopRequested']
out=root/'dist/workstream-C/C2'/datetime.datetime.now(datetime.timezone.utc).strftime('public-%Y%m%dT%H%M%SZ');out.mkdir(parents=True)
priorCompute=8.881368875 if '--resume' in sys.argv else 0
start=time.monotonic();record={'startUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'maxSeconds':300,'priorComputeSeconds':priorCompute,'maxNetworkBytes':20000000,'scope':'3 real captures,2 homographies by HTTP range then one serial native registration replay','commands':[],'exit':1};manifest=[]
sources=[root/f'apps/ios/RightSide/Spatial/{name}.swift'for name in ['CalibratedPoseGeometry','VisualReferenceGeometry','VisualReferenceMatcher','VisualReferenceRefinement','VisualReferenceProposals','VisualReferenceFeatures']]+[root/'scripts/check-visual-reference-public.swift']
for source in sources+[root/f'scripts/{name}'for name in ['acquire-visual-reference-captures.py','run-visual-reference-public.py','evaluate-visual-reference-public.py','resume-visual-reference-captures.py']]+[root/'research/visual-reference/C2-public-replay-contract.json']:
 relative=source.relative_to(root);target=out/'snapshot'/relative;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target);manifest.append({'path':str(relative),'sha256':hashlib.sha256(target.read_bytes()).hexdigest()})
public=root/'dist/workstream-C/C2/public-hpatches'
commands=[['python3',str(root/('scripts/resume-visual-reference-captures.py' if '--resume'in sys.argv else 'scripts/acquire-visual-reference-captures.py'))],['xcrun','swiftc','-O','-swift-version','5','-strict-concurrency=complete','-warnings-as-errors']+[str(out/'snapshot'/p.relative_to(root))for p in sources]+['-o',str(out/'replay')],[str(out/'replay'),str(out/'captures')],['python3',str(out/'snapshot/scripts/evaluate-visual-reference-public.py'),str(out/'captures'),str(out/'2.log'),str(out/'evaluation.json')]]
try:
 for i,cmd in enumerate(commands):
  assert not json.load(open(root.parent/'docs/hill-climb/STATE.json'))['stopRequested']
  record['commands'].append(cmd)
  with open(out/f'{i}.log','w')as log:p=subprocess.run(cmd,cwd=root,stdout=log,stderr=subprocess.STDOUT,timeout=max(1,300-priorCompute-(time.monotonic()-start)),env={**os.environ,'DEVELOPER_DIR':'/Applications/Xcode.app/Contents/Developer'})
  print(out/f'{i}.log',p.returncode,flush=True)
  if i==0:
   shutil.copytree(public,out/'captures')
   for file in sorted((out/'captures').iterdir()):manifest.append({'path':str(file.relative_to(out)),'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
   if json.load(open(public/'provenance.json'))['status']!='acquired':record['exit']=2;break
  if p.returncode:record['exit']=p.returncode;break
 else:record['exit']=0
finally:
 record['endUTC']=datetime.datetime.now(datetime.timezone.utc).isoformat();record['seconds']=time.monotonic()-start;record['cumulativeComputeSeconds']=record['seconds']+priorCompute
 (out/'operation.json').write_text(json.dumps(record,indent=2)+'\n');(out/'source-manifest.json').write_text(json.dumps({'sourceCommit':None,'algorithmFrozenBeforeAcquisition':True,'files':manifest},indent=2)+'\n')
raise SystemExit(record['exit'])
