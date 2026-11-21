#!/usr/bin/env python3
"""Execute exact controller context/priority/expiry source slices without AR capture.
The pre-change source is supplied explicitly; policy tests are not a simulated camera.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
os.chdir(root)
assert not json.loads((root.parent / 'docs/hill-climb/STATE.json').read_text())['stopRequested']
parser = argparse.ArgumentParser()
parser.add_argument('--source', default='apps/ios/RightSide/Sensors/LiveCameraGuidance.swift')
parser.add_argument('--wire-source', default='apps/ios/RightSide/Sensors/VehicleWireAdapter.swift')
args = parser.parse_args()
source = Path(args.source).read_text()
legacy = 'private var visionEpoch = UUID()' in source
out = Path(tempfile.mkdtemp(prefix='source-before.' if legacy else 'source-after.', dir=root / 'dist/hill-climb-m3'))
context = source[source.index('    func updateContext('):source.index('        let previous = targetAnchor?.coordinate')]+ '    }\n'
if legacy:
    priority = source[source.index('                    self.recognition = decisions.first(where:'):source.index('                self.expiry?.cancel()')]
    # The final brace belongs to the outer else; preserve every statement inside it.
    priority = priority.rsplit('                }', 1)[0]
    expiry = source[source.index('                    self?.matches = [];'):source.index('\n                }\n            }\n        }', source.index('                    self?.matches = [];'))]
    fields = '''var visionEpoch = UUID()
    var token: UUID { visionEpoch }
    var vehicles: [CameraVehicleOverlay] = []
    var matches: [CameraTextMatch] = []
    var recognition = ""
    func seed(signOnly: Bool) {
        vehicles = signOnly ? [] : [positive]
        matches = signOnly ? [sign] : []
        recognition = signOnly ? "Stop text · check sign: Bern" : "Display matches · verify service"
    }
    func expireNow() {
        let callback = { [weak self] in
    ''' + expiry + '''
        }
        callback()
    }
    func conflict() {
        let decisions = [VehicleDecision(state: .conflicting, reason: "out_of_service")]
        let result = Result(tracks: [positive])
        matches = [sign]
    ''' + priority + '\n    }\n'
else:
    invalidation = source[source.index('    private func invalidateCameraEvidence('):source.index('    private func invalidateLocalCameraEvidence(') if '    private func invalidateLocalCameraEvidence(' in source else source.index('    func stop()')]
    fields = '''var cameraEvidence = CameraEvidenceLifecycle()
    var token: UUID { cameraEvidence.epoch }
    var vehicles: [CameraVehicleOverlay] { cameraEvidence.vehicles }
    var matches: [CameraTextMatch] { cameraEvidence.matches }
    var recognition: String { cameraEvidence.recognition }
    var expiry: Task<Void, Never>?
    func seed(signOnly: Bool) {
        cameraEvidence.start(at: stamp)
        cameraEvidence.publish(vehicles: signOnly ? [] : [positive], matches: signOnly ? [sign] : [],
                               token: token, capturedAt: stamp, now: stamp)
    }
    func expireNow() { cameraEvidence.expire(cameraEvidence.feedbackID!, at: stamp.addingTimeInterval(0.5)) }
    func conflict() {
        cameraEvidence.publish(vehicles: [CameraVehicleOverlay(id: UUID(), box: .zero, maskRuns: [], title: "Bus",
            decision: VehicleDecision(state: .conflicting, reason: "out_of_service"))], matches: [sign],
            token: token, capturedAt: stamp, now: stamp)
    }
    ''' + invalidation
    required = ['self.cameraEvidence.publish(vehicles: overlays', 'self.cameraEvidence.epoch == visionToken',
                'epoch: trackingToken', 'self.cameraEvidence.candidateID', 'self.cameraEvidence.expire(feedbackID, at: Date())',
                'invalidateCameraEvidence(.trackingLost)', 'invalidateCameraEvidence(.thermal)',
                'invalidateCameraEvidence(.failed)', 'invalidateCameraEvidence(.moved)',
                'invalidateCameraEvidence(.stopped)', 'coordinator.stop()',
                'if scenePhase == .active && !photoReader']
    for text in required:
        assert text in source, 'Controller wiring missing: ' + text

harness = '''import Foundation
import CoreGraphics
final class Stub { func reset() {} ; func removeFromParentNode() {} }
struct Result { let tracks: [CameraVehicleOverlay] }
func journey(line: String = "6", destination: String = "Fischermätteli", board: String = "Bern", point: String = "A") -> CameraJourneyContext {
    CameraJourneyContext(id: "leg", title: "Journey", line: line, destination: destination, stop: "Bern", target: nil,
                         targetLabel: "Bern", simulated: false, boardingStopID: board, boardingPointID: point)
}
final class Probe {
    let stamp = Date()
    var running = true
    var context: CameraJourneyContext? = journey()
    var localSite: Stub?
    var localAreaNode: Stub?
    var renderedPose: Int?
    func invalidateLocalCameraEvidence(_ reason: CameraEvidenceLifecycle.Invalidation) {}
    let positive = CameraVehicleOverlay(id: UUID(), box: .zero, maskRuns: [], title: "Bus",
                                      decision: VehicleDecision(state: .visualCandidate, reason: "stable_display"))
    let sign = CameraTextMatch(box: .zero, text: "Bern", label: "Stop text · check sign")
''' + fields + context + '''}
var failures = 0
func check(_ ok: Bool, _ name: String) {
    print("\\(ok ? "PASS" : "FAIL") \\(name)")
    if !ok { failures += 1 }
}
for (label, changed) in [("line",journey(line:"7")), ("destination",journey(destination:"Worb Dorf")),
                         ("boarding stop",journey(board:"Other")), ("boarding point",journey(point:"B"))] {
    let candidate = Probe(); candidate.seed(signOnly: false); candidate.updateContext(changed)
    check(candidate.vehicles.isEmpty && !candidate.recognition.contains("Display matches"), label + " clears candidate and instruction")
    let sign = Probe(); sign.seed(signOnly: true); sign.updateContext(changed)
    check(sign.matches.isEmpty && !sign.recognition.contains("Stop text"), label + " clears sign and instruction")
}
let priority = Probe(); priority.seed(signOnly: false); priority.conflict()
check(!priority.recognition.contains("Stop text"), "conflict instruction outranks generic sign (combined synthetic result)")
let expiry = Probe(); expiry.seed(signOnly: false); let pending = expiry.token; expiry.expireNow()
check(expiry.token != pending, "expiry rejects pending generation")
let old = Date(timeIntervalSince1970: 1800000000)
let fresh = old.addingTimeInterval(0.4)
let track = VehicleTrack(id: UUID(), detection: VehicleDetection(kind: .bus, box: CGRect(x:0.1,y:0.1,width:0.3,height:0.5), score:0.9,
    mask:VehicleMask(width:1,height:1,pixels:[1])), lastSeen:fresh,
    readings:[DisplayReading(frameID:UUID(),at:old,line:"6",destination:"Fischermätteli",outOfService:false,ambiguous:false,raw:["6 Fischermätteli"])])
let observation: JSONValue? = VehicleWireAdapter.observation(track,at:fresh,imageSize:CGSize(width:1000,height:1000))
check(observation == nil, "refreshed box cannot re-date previous OCR")
print("\\(11 - failures)/11 source regression checks passed; \\(failures) failures")
exit(failures == 0 ? 0 : 1)
'''
(out / 'main.swift').write_text(harness)
(out / 'LiveCameraGuidance.tested.swift').write_text(source)
(out / 'VehicleWireAdapter.tested.swift').write_text(Path(args.wire_source).read_text())
env = dict(os.environ, DEVELOPER_DIR=os.environ.get('DEVELOPER_DIR', '/Applications/Xcode.app/Contents/Developer'))
files = ['apps/ios/RightSide/Core/JSONValue.swift'] + [f'apps/ios/RightSide/Sensors/{name}.swift' for name in
    ['SensorEvidence','CameraGuidanceModels','VehicleEvidence','CameraEvidenceLifecycle','TransportDataPacks']]
with (out / 'check.log').open('w') as log:
    def report(text):
        print(text, flush=True); log.write(text + '\n'); log.flush()
    report('Output: ' + str(out))
    report('Controller source SHA256: ' + hashlib.sha256(source.encode()).hexdigest())
    command = ['xcrun','swiftc','-swift-version','5','-warnings-as-errors'] + files + [args.wire_source, str(out/'main.swift'), '-o', str(out/'source-checks')]
    compiled = subprocess.run(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    report(compiled.stdout)
    if compiled.returncode:
        raise SystemExit(compiled.returncode)
    result = subprocess.run([str(out/'source-checks')], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    report(result.stdout)
    raise SystemExit(result.returncode)
