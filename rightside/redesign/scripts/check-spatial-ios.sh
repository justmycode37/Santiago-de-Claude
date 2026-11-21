#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
python3 - <<'PY'
from pathlib import Path
import datetime,hashlib,json,os,shutil,subprocess
assert not json.loads(Path('../docs/hill-climb/STATE.json').read_text())['stopRequested']
start=datetime.datetime.now(datetime.timezone.utc)
out=Path('dist/workstream-C')/('ios-check-'+start.strftime('%Y%m%dT%H%M%SZ'));out.mkdir(parents=True)
manifest={};sources=[]
for p in sorted(Path('apps/ios/RightSide').rglob('*.swift')):
 target=out/'source'/p.relative_to('apps/ios/RightSide');target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,target);sources.append(str(target));manifest[str(p)]=hashlib.sha256(target.read_bytes()).hexdigest()
(out/'sources.json').write_text(json.dumps(manifest,indent=2)+'\n')
sdk=subprocess.check_output(['xcrun','--sdk','iphonesimulator','--show-sdk-path'],text=True).strip()
common=['xcrun','swiftc','-target','arm64-apple-ios17.0-simulator','-sdk',sdk,'-swift-version','5','-strict-concurrency=complete','-warnings-as-errors']
cmd=common+['-emit-module','-enable-testing','-module-name','RightSide',*sources,'-emit-module-path',str(out/'RightSide.swiftmodule')]
(out/'command.txt').write_text(' '.join(cmd)+'\n')
with (out/'compile.log').open('w') as log:r=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT)
if r.returncode==0:
 dev=Path(os.environ['DEVELOPER_DIR'])/'Platforms/iPhoneSimulator.platform/Developer'
 cmd=common+['-typecheck','-F',str(dev/'Library/Frameworks'),'-I',str(dev/'usr/lib'),'-I',str(out),'apps/ios/RightSideTests/SpatialReferenceTests.swift']
 with (out/'tests-typecheck.log').open('w') as log:r=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT)
end=datetime.datetime.now(datetime.timezone.utc)
(out/'operation.json').write_text(json.dumps({'computeStart':start.isoformat(),'computeEnd':end.isoformat(),'seconds':(end-start).total_seconds(),'exit':r.returncode},indent=2)+'\n')
print('C iOS source/test typecheck',out,'exit',r.returncode)
if r.returncode:
 print((out/'compile.log').read_text()[-8000:]);print((out/'tests-typecheck.log').read_text()[-8000:] if (out/'tests-typecheck.log').exists() else '')
raise SystemExit(r.returncode)
PY
