import Foundation
import CoreImage
import CryptoKit

/// Real extracted frames only; labels are evaluation inputs, never recognition inputs.
@main struct TemporalCameraReplay {
    struct Annotation: Decodable {
        let id: String
        let box: [Double]
        let line: String?
        let destination: String?
        let requiresPositive: Bool
        var rectangle: CGRect { CGRect(x:box[0],y:box[1],width:box[2],height:box[3]) }
    }
    struct Frame: Decodable {
        let path: String
        let sha256: String
        let sourcePTS: Double
        let annotations: [Annotation]
    }
    struct Manifest: Decodable {
        let schemaVersion: Int
        let evaluationRole: String
        let originalPath: String
        let originalSHA256: String
        let licenceURL: String
        let author: String
        let annotationMethod: String
        let selectedLine: String
        let selectedDestination: String
        let expectedChecks: Int
        let frames: [Frame]
    }
    static func digest(_ data:Data) -> String { SHA256.hash(data:data).map { String(format:"%02x",$0) }.joined() }
    static func main() throws {
        let args = CommandLine.arguments
        guard args.count == 6 else { exit(2) }
        let manifestURL = URL(fileURLWithPath:args[2]),root = manifestURL.deletingLastPathComponent()
        let manifestData = try Data(contentsOf:manifestURL)
        let manifest = try JSONDecoder().decode(Manifest.self,from:manifestData)
        let negativeOnly = manifest.evaluationRole == "unreadable-negative-only"
        // Validate all provenance and inputs before loading either model. Empty placeholders
        // cannot produce a passing run. Frames must come from the named, retained original.
        guard manifest.schemaVersion == 1,!manifest.author.isEmpty,!manifest.licenceURL.isEmpty,
              manifest.annotationMethod == "manual-before-inference",(3...48).contains(manifest.frames.count),
              manifest.frames.allSatisfy({ $0.sourcePTS.isFinite && $0.sourcePTS>=0 }),
              let first = manifest.frames.first,let last = manifest.frames.last,last.sourcePTS-first.sourcePTS<=12,
              zip(manifest.frames,manifest.frames.dropFirst()).allSatisfy({ pair in pair.0.sourcePTS<pair.1.sourcePTS }),
              digest(try Data(contentsOf:root.appendingPathComponent(manifest.originalPath))) == manifest.originalSHA256,
              ["positive-utility","unreadable-negative-only"].contains(manifest.evaluationRole),
              manifest.expectedChecks == manifest.frames.reduce(1,{ $0 + (negativeOnly ? 7+$1.annotations.count*2:1+$1.annotations.count*8) }),
              negativeOnly ? !manifest.frames.contains(where: { $0.annotations.contains(where: { $0.requiresPositive }) }):manifest.frames.contains(where: { $0.annotations.contains(where: { $0.requiresPositive }) }) else { exit(3) }
        for frame in manifest.frames {
            guard digest(try Data(contentsOf:root.appendingPathComponent(frame.path))) == frame.sha256,
                  Set(frame.annotations.map(\.id)).count == frame.annotations.count,
                  frame.annotations.allSatisfy({ a in
                      a.box.count==4 && a.box.allSatisfy(\.isFinite) && a.box[2]>0 && a.box[3]>0
                          && CGRect(x:0,y:0,width:1,height:1).contains(a.rectangle)
                          && (!a.requiresPositive || (a.line != nil && a.destination != nil))
                  }) else { exit(3) }
        }
        let pipeline = LocalVehiclePipeline(modelURL:URL(fileURLWithPath:args[1]),
            displayModelURL:URL(fileURLWithPath:args[4]),displayCharactersURL:URL(fileURLWithPath:args[5]))
        let clock = Date(timeIntervalSince1970:1_800_000_000)
        var state = CameraEvidenceLifecycle();state.start(at:clock)
        var available = first.sourcePTS,checks = 0,failures:[String] = [],rows:[[String:Any]] = []
        var dropped = 0,gateRejected = 0,positiveFrames = 0,firstPositive:Double?
        func check(_ condition:Bool,_ label:String) { checks += 1;if !condition { failures.append(label) } }
        func expectation(_ line:String,_ destination:String) -> VehicleServiceExpectation {
            .init(line:line,destination:destination,boardingStopID:"evaluation-board",alightingStopID:"evaluation-alight",
                validUntil:clock.addingTimeInterval(30),requiresRouteContext:true,revision:1,observedAt:clock,
                boardingCallID:"board",alightingCallID:"alight",
                downstreamCalls:[.init(id:"alight",stopID:"evaluation-alight",name:destination)])
        }
        let selected = expectation(manifest.selectedLine,manifest.selectedDestination)
        for (index,frame) in manifest.frames.enumerated() {
            guard let statePath = ProcessInfo.processInfo.environment["CAMERA_REPLAY_STATE"],
                  let authorization = try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:statePath))) as? [String:Any],
                  authorization["stopRequested"] as? Bool == false,
                  authorization["operatingMode"] as? String == "FINISH_CURRENT_ONLY" else { exit(130) }
            let captured = clock.addingTimeInterval(frame.sourcePTS-first.sourcePTS)
            if state.feedbackExpired(at:captured) { state.invalidate(.expired,at:captured) }
            if frame.sourcePTS<available {
                dropped += 1
                // A busy frame still occupies its frozen utility denominator; it is never
                // silently removed, processed late, or counted as a fresh observation.
                for annotation in frame.annotations { for control in 0..<(negativeOnly ? 2:8) {
                    check(false,"frame\(index) \(annotation.id) unavailable control\(control)")
                } }
                if negativeOnly { for control in 0..<6 { check(false,"frame\(index) busy frame unobserved context\(control)") } }
                check(state.candidateID == nil,"frame\(index) skipped-frame highlight unverified")
                rows.append(["index":index,"PTS":frame.sourcePTS,"droppedBusy":true]);continue
            }
            let started = ProcessInfo.processInfo.systemUptime
            guard let image = CIImage(contentsOf:root.appendingPathComponent(frame.path)),
                  image.extent.width>0,image.extent.height>0,max(image.extent.width,image.extent.height)<=2560 else { exit(3) }
            let token = state.epoch
            let result = try pipeline.process(upright:image,at:captured,epoch:state.trackingEpoch)
            let elapsed = ProcessInfo.processInfo.systemUptime-started
            available = frame.sourcePTS+elapsed
            let delivered = captured.addingTimeInterval(elapsed)
            if state.feedbackExpired(at:delivered) { state.invalidate(.expired,at:delivered) }
            let overlays = result.tracks.map { track in
                CameraVehicleOverlay(id:track.id,box:track.detection.box,maskRuns:track.detection.mask.runs,
                    title:track.detection.kind.rawValue,decision:VehicleServiceMatcher.decide(track,expected:selected,now:delivered),
                    displayText:track.readings.last?.displayText,capturedAt:track.readings.last?.at)
            }
            let published = state.publish(vehicles:overlays,matches:[],token:token,capturedAt:captured,now:delivered,routeValidUntil:selected.validUntil,displayIssues:result.displayIssues)
            if elapsed>=0.7 { gateRejected += 1 }
            let associations = frame.annotations.map { a in result.tracks.filter { VehicleTracker.iou($0.detection.box,a.rectangle)>=0.3 } }
            var allowedPositiveIDs = Set<UUID>()
            for (annotationIndex,annotation) in frame.annotations.enumerated() {
                let matches = associations[annotationIndex]
                let unique = matches.count==1 && associations.filter { $0.contains(where: { $0.id==matches[0].id }) }.count==1
                let track = unique ? matches.first:nil
                check(unique,"frame\(index) \(annotation.id) unique actual instance")
                let observed = track?.readings.last
                let correct = annotation.line != nil && annotation.destination != nil && observed?.line == annotation.line.map(VehicleTextRules.normalize)
                    && observed?.destination == annotation.destination.map(VehicleTextRules.normalize)
                let positive = track.map { t in state.vehicles.contains { $0.id==t.id && $0.decision.state == .visualCandidate } } ?? false
                check(annotation.requiresPositive ? (correct && positive):(!positive || correct),"frame\(index) \(annotation.id) utility and attribution")
                if correct,let track { allowedPositiveIDs.insert(track.id) }
                if negativeOnly { continue }
                let line = annotation.line ?? manifest.selectedLine,destination = annotation.destination ?? manifest.selectedDestination
                for variant in ["wrong-line","opposite","short-turn","stale","future","cancelled-alighting"] {
                    var invalid = expectation(line,destination)
                    if variant == "wrong-line" { invalid = expectation("evaluation-wrong-line",destination) }
                    if variant == "opposite" || variant == "short-turn" { invalid = expectation(line,"Evaluation Opposite Terminus") }
                    if variant == "short-turn" { invalid.downstreamCalls.insert(.init(id:"earlier",stopID:"earlier",name:destination),at:0) }
                    if variant == "stale" { invalid.validUntil = captured.addingTimeInterval(-1) }
                    if variant == "future" { invalid.latestObservedAt = delivered.addingTimeInterval(1) }
                    if variant == "cancelled-alighting" { invalid.alightingUnavailable = true }
                    let decision = track.map { VehicleServiceMatcher.decide($0,expected:invalid,now:delivered) }
                    check(decision != nil && decision?.state != .visualCandidate && decision?.state != .verifiedService,
                          "frame\(index) \(annotation.id) \(variant)")
                }
            }
            if negativeOnly {
                // Fixed synthetic expectation controls. They are never supplied to either recognizer.
                // No matching service was independently readable in this sequence.
                for variant in ["other-service","wrong-line","opposite","stale","future","cancelled-alighting"] {
                    var invalid = expectation(manifest.selectedLine,manifest.selectedDestination)
                    if variant == "other-service" { invalid = expectation("8","Brünnen Westside Bhf") }
                    if variant == "wrong-line" { invalid = expectation("evaluation-wrong-line",manifest.selectedDestination) }
                    if variant == "opposite" { invalid = expectation(manifest.selectedLine,"Evaluation Opposite Terminus") }
                    if variant == "stale" { invalid.validUntil = captured.addingTimeInterval(-1) }
                    if variant == "future" { invalid.latestObservedAt = delivered.addingTimeInterval(1) }
                    if variant == "cancelled-alighting" { invalid.alightingUnavailable = true }
                    check(result.tracks.allSatisfy {
                        let d = VehicleServiceMatcher.decide($0,expected:invalid,now:delivered)
                        return d.state != .visualCandidate && d.state != .verifiedService
                    },"frame\(index) negative-only \(variant)")
                }
            }
            check(state.vehicles.filter { $0.decision.state == .visualCandidate || $0.decision.state == .verifiedService }
                .allSatisfy { allowedPositiveIDs.contains($0.id) && $0.decision.state != .verifiedService },"frame\(index) no unannotated/wrong/authoritative positive")
            if state.candidateID != nil { positiveFrames += 1;if firstPositive == nil { firstPositive = available-first.sourcePTS } }
            rows.append(["index":index,"PTS":frame.sourcePTS,"droppedBusy":false,"deliveryMS":elapsed*1000,
                "displayIssues":Dictionary(uniqueKeysWithValues:result.displayIssues.map { ($0.key.uuidString,$0.value.rawValue) }),
                "recognition":state.recognition,"published":published,"candidateID":state.candidateID?.uuidString as Any? ?? NSNull(),
                "lostIDs":result.lost.map(\.uuidString),"tracks":result.tracks.map { t -> [String:Any] in
                    let diagnostic = result.recognitionDiagnostics.first { $0.trackID==t.id }
                    let alternatives = [diagnostic?.alternative].compactMap { $0 }+(diagnostic?.additionalAlternatives ?? [])
                    return ["id":t.id.uuidString,"box":[t.detection.box.minX,t.detection.box.minY,t.detection.box.width,t.detection.box.height],
                     "raw":t.readings.last?.raw ?? [],"display":t.readings.last?.displayText as Any? ?? NSNull(),
                     "capturedAt":t.readings.last?.at.timeIntervalSince1970 as Any? ?? NSNull(),
                     "decision":overlays.first { $0.id==t.id }?.decision.state.rawValue as Any? ?? NSNull(),
                     "vision":diagnostic?.visionTexts.map { ["text":$0.text,"score":$0.score] as [String:Any] } ?? [],
                     "alternative":alternatives.map { o -> [String:Any] in
                         ["text":o.text,"scores":o.characterScores,"engine":o.engineID,"model":o.modelID,"config":o.configID,
                          "frame":o.frameID.uuidString,"capturedAt":o.capturedAt.timeIntervalSince1970,"sampling":o.samplingID]
                     },
                     "maskRuns":t.detection.mask.runs.map { [$0.minX,$0.minY,$0.width,$0.height] }]
                }])
        }
        if negativeOnly { check(positiveFrames==0,"negative-only sequence must not publish positive") }
        else { check(positiveFrames>0,"useful positive required; universal abstention fails") }
        let report:[String:Any] = ["schemaVersion":1,"contract":"real-PTS-temporal-v2", "evaluationRole":manifest.evaluationRole,
            "positiveUtilityAssessed":!negativeOnly,"positiveAndMixedRecognitionAvailable":!negativeOnly && failures.isEmpty,"manifestSHA256":digest(manifestData),
            "checks":checks,"expectedChecks":manifest.expectedChecks,"failures":failures,"frames":rows,
            "droppedBusy":dropped,"rejectedBy700msGate":gateRejected,"positiveFrames":positiveFrames,
            "timeToStableFeedback":firstPositive as Any? ?? NSNull(),"physicalDevice":false,
            "compute":"Serial production pipeline; detector CoreML computeUnits.all, alternative recognizer CPU-only; one application worker, system framework thread count not asserted.",
            "timing":"First frame includes lazy detector/model load; following frame times separate in rows. Model-load time alone is not instrumented.",
            "clock":"Original source PTS plus measured Mac execution duration; busy source frames dropped, no wall-time sleep or queued stale frame."]
        try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:URL(fileURLWithPath:args[3]))
        exit(failures.isEmpty && checks==manifest.expectedChecks ? 0:1)
    }
}
