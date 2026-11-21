import Foundation
import CoreImage
import Darwin

/// Actual elapsed Mac pipeline/publication clock on repeated DEVELOPMENT photographs.
/// Excludes camera capture, motion/ARKit, iPhone hardware, field recall and independent encounters.
@main struct MultimodalLiveClock {
    static func main() throws {
        let a = CommandLine.arguments
        guard a.count==4 else { exit(2) }
        let model = URL(fileURLWithPath:a[1]),images = URL(fileURLWithPath:a[2]),out = URL(fileURLWithPath:a[3])
        var reports:[[String:Any]] = [],failures:[String] = []
        for (sample,line,destination,maximum) in [("bus","12","Bern Bahnhof",1280.0),("tram","8","Brünnen Westside Bhf",1280.0),
            ("bus","12","Bern Bahnhof",2560.0),("tram","8","Brünnen Westside Bhf",2560.0)] {
            try autoreleasepool {
                let original = CIImage(contentsOf:images.appendingPathComponent(sample+".jpg"))!
                let scale = min(1,maximum/max(original.extent.width,original.extent.height))
                let image = original.transformed(by:CGAffineTransform(scaleX:scale,y:scale))
                let pipeline = LocalVehiclePipeline(modelURL:model,
                    displayModelURL:ProcessInfo.processInfo.environment["CAMERA_DISPLAY_MODEL"].map { URL(fileURLWithPath:$0) },
                    displayCharactersURL:ProcessInfo.processInfo.environment["CAMERA_DISPLAY_CHARACTERS"].map { URL(fileURLWithPath:$0) })
                let start = Date(),monotonic = ProcessInfo.processInfo.systemUptime
                let expected = VehicleServiceExpectation(line:line,destination:destination,boardingStopID:"synthetic-board",alightingStopID:"synthetic-alight",
                    validUntil:start.addingTimeInterval(30),requiresRouteContext:true,revision:1,observedAt:start,
                    boardingCallID:"board",alightingCallID:"alight",downstreamCalls:[.init(id:"alight",stopID:"synthetic-alight",name:destination)])
                var state = CameraEvidenceLifecycle();state.start(at:start)
                var previous:Double?,firstPositive:Double?,rows:[[String:Any]] = [],rejected = 0,positives = 0,wrongPositives = 0
                for frame in 0..<18 {
                    if let previous { Thread.sleep(forTimeInterval:max(0,0.4-(ProcessInfo.processInfo.systemUptime-previous))) }
                    previous = ProcessInfo.processInfo.systemUptime
                    let captured = Date()
                    if state.feedbackExpired(at:captured) { state.invalidate(.expired,at:captured) }
                    let token = state.epoch
                    let result = try pipeline.process(upright:image,at:captured,epoch:state.trackingEpoch)
                    let delivered = Date()
                    // Observe the same expiry policy at delivery even if inference occupied this
                    // synchronous replay worker. Production expiry runs independently on main.
                    if state.feedbackExpired(at:delivered) { state.invalidate(.expired,at:delivered) }
                    let overlays = result.tracks.map { track in
                        CameraVehicleOverlay(id:track.id,box:track.detection.box,maskRuns:track.detection.mask.runs,title:track.detection.kind.rawValue,
                            decision:VehicleServiceMatcher.decide(track,expected:expected,now:delivered),displayText:track.readings.last?.displayText,capturedAt:track.readings.last?.at)
                    }
                    let accepted = state.publish(vehicles:overlays,matches:[],token:token,capturedAt:captured,now:delivered,routeValidUntil:expected.validUntil)
                    let age = delivered.timeIntervalSince(captured)
                    if age>=0.7 { rejected += 1 }
                    if let id = state.candidateID {
                        positives += 1
                        if firstPositive==nil { firstPositive = ProcessInfo.processInfo.systemUptime-monotonic }
                        if !result.tracks.contains(where: { $0.id==id && $0.readings.last?.line==VehicleTextRules.normalize(line)
                            && $0.readings.last?.destination==VehicleTextRules.normalize(destination) }) { wrongPositives += 1 }
                    }
                    rows.append(["frame":frame,"captureOffset":captured.timeIntervalSince(start),"deliveryAgeMS":age*1000,
                        "pipelineMS":result.latencyMS,"accepted":accepted,"candidateID":state.candidateID?.uuidString as Any? ?? NSNull(),
                        "observedDisplays":overlays.compactMap(\.displayText),"reasons":overlays.map { $0.decision.reason }])
                }
                let warm = rows.dropFirst().compactMap { $0["deliveryAgeMS"] as? Double }.sorted()
                let name = sample+"-"+String(Int(maximum))
                if positives==0 { failures.append(name+" no actual-time stable positive") }
                if wrongPositives>0 { failures.append(name+" wrong or stale positive") }
                reports.append(["sample":name,"perPipelineFirstCallMS":rows.first?["pipelineMS"] ?? NSNull(),
                    "warmMedianMS":warm[warm.count/2],"warmMaximumMS":warm.last!,"rejectedBy700msGate":rejected,
                    "acceptedPositiveFrames":positives,"wrongOrStalePositiveFrames":wrongPositives,
                    "timeToStableFeedbackSeconds":firstPositive as Any? ?? NSNull(),"frames":rows])
                print("ACTUAL CLOCK \(name): positiveFrames=\(positives),700msRejected=\(rejected),wrong=\(wrongPositives),firstStable=\(firstPositive ?? -1)s")
                fflush(stdout)
            }
        }
        try JSONSerialization.data(withJSONObject:["scenarios":reports,"failures":failures,
            "uniqueOriginalDevelopmentPhotos":2,"newHeldoutPhotos":0,"fieldEncounters":0,"physicalDevice":false,
            "limitations":"18 repeats per resolution, actual Mac clock at nominal0.4s cadence. Per-pipeline first-call timing is not guaranteed cold OS model cache. Excludes physical capture, ARKit/motion and iPhone. Contexts synthetic; no expected words enter recognition."],options:[.prettyPrinted,.sortedKeys])
            .write(to:out.appendingPathComponent("actual-time-report.json"))
        exit(failures.isEmpty ? 0:1)
    }
}
