#!/usr/bin/env python3
"""Execute preserved pre-B2 local reset statements with real SceneKit nodes.
The AR delegate/context trigger is supplied by the harness; no AR capture/field claim.
Passing-after acceptance is the actual lifecycle + consensus native XCTest suite.
"""
import hashlib, json, os, subprocess, tempfile
from pathlib import Path
root=Path(__file__).resolve().parent.parent
os.chdir(root)
assert not json.loads((root.parent/'docs/hill-climb/STATE.json').read_text())['stopRequested']
p=root/'dist/hill-climb-b2/before/LiveCameraGuidance.swift'
source=p.read_text()
out=Path(tempfile.mkdtemp(prefix='before-native.',dir=root/'dist/hill-climb-b2'))
methods=[]
regions=[('context','    func updateContext(', '        let previous = targetAnchor'),
         ('stop','    func stop()', '    func session(_ session: ARSession, didChange geoTrackingStatus'),
         ('tracking','    func session(_ session: ARSession, cameraDidChangeTrackingState', '    func sessionWasInterrupted'),
         ('restart','    private func runWorldCamera()', '    func importLocalSite')]
for name,start,end in regions:
    body=source[source.index(start):source.index(end,source.index(start))]
    statements=[]
    for line in body.splitlines():
        stripped=line.strip()
        if 'localAreaNode?.removeFromParentNode()' in line or 'if localSite != nil { visual?.observation = nil }' in line:
            statements.append(stripped)
        elif stripped=='localSite.reset()': statements.append('if let localSite { '+stripped+' }')
        elif 'visual?.observation = nil' in stripped: statements.append(stripped)
    assert statements,name
    methods.append('func '+name+'() {\n'+'\n'.join(statements)+'\n}')
harness='''import Foundation
import SceneKit
import simd
final class Site { var pose: simd_float4x4? = matrix_identity_float4x4; func reset() { pose=nil } }
final class Visual { var observation: Date? = Date() }
@MainActor final class ControllerSlice {
 var localized = true
 var localSite: Site? = Site()
 var visual: Visual? = Visual()
 var localAreaNode: SCNNode? = SCNNode()
 var localSiteStatus = "Within surveyed area A. Check current obstacles and signs."
 let root=SCNNode()
 init() { root.addChildNode(localAreaNode!) }
'''+ '\n'.join(methods)+'''\n}
@main struct Repro {
 @MainActor static func main() {
  var failures=0
  for event in ["context","stop","tracking","restart"] {
   let c=ControllerSlice()
   switch event { case "context": c.context(); case "stop": c.stop(); case "tracking": c.tracking(); default: c.restart() }
   let cleared = c.localAreaNode == nil && c.localSite?.pose == nil && c.visual?.observation == nil && !c.localSiteStatus.contains("Within surveyed area")
   print("\\(cleared ? "PASS" : "FAIL") \\(event): node=\\(c.localAreaNode != nil), pose=\\(c.localSite?.pose != nil), map=\\(c.visual?.observation != nil), affirmative=\\(c.localSiteStatus.contains("Within surveyed area"))")
   if !cleared { failures += 1 }
  }
  print("\\(4-failures)/4 reset paths clear complete local presentation; expected pre-fix failure")
  exit(failures == 0 ? 0 : 1)
 }
}
'''
(out/'repro.swift').write_text(harness)
with (out/'check.log').open('w') as log:
    log.write('Original controller SHA256 '+hashlib.sha256(p.read_bytes()).hexdigest()+'\n');log.flush()
    subprocess.run(['xcrun','swiftc','-parse-as-library','-swift-version','5','-strict-concurrency=complete','-warnings-as-errors',str(out/'repro.swift'),'-o',str(out/'repro')],stdout=log,stderr=log,check=True,timeout=180)
    result=subprocess.run([str(out/'repro')],stdout=log,stderr=log,timeout=30)
print('Output:',out)
print((out/'check.log').read_text())
raise SystemExit(result.returncode)
