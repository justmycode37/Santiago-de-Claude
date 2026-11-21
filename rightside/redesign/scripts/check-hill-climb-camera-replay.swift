import Foundation
import CoreML
import CoreImage
import ImageIO
import Darwin

/// Frozen-photo inputs through the ACTUAL native inference/OCR/tracker/matcher/display policy.
/// Repeated photos are controlled synthetic timing, not independent video frames or encounters.
@main struct CameraRecordedReplay {
    static func main() throws {
        guard (4...5).contains(CommandLine.arguments.count) else { exit(2) }
        let model = URL(fileURLWithPath: CommandLine.arguments[1])
        let images = URL(fileURLWithPath: CommandLine.arguments[2])
        let output = URL(fileURLWithPath: CommandLine.arguments[3])
        if CommandLine.arguments.count == 5 {
            try actualClock(model: model, images: images, output: output)
            return
        }
        let pipeline = LocalVehiclePipeline(modelURL: model,
            displayModelURL: ProcessInfo.processInfo.environment["CAMERA_DISPLAY_MODEL"].map { URL(fileURLWithPath:$0) },
            displayCharactersURL: ProcessInfo.processInfo.environment["CAMERA_DISPLAY_CHARACTERS"].map { URL(fileURLWithPath:$0) })
        if ProcessInfo.processInfo.environment["CAMERA_TRACE"] == "1" { pipeline.trace = { print($0) } }
        let context = CIContext(options: [.cacheIntermediates: false])
        let base = Date(timeIntervalSince1970: 1_800_000_000)
        var rows: [[String: Any]] = []
        var assertions = 0, failures: [String] = []
        func check(_ condition: Bool, _ name: String) {
            assertions += 1
            if !condition { failures.append(name) }
            print("\(condition ? "PASS" : "FAIL") \(name)")
        }
        for (sampleIndex, name) in ["bus", "bus-native", "tram", "train", "tram-holdout"].enumerated() {
            try autoreleasepool {
                guard let original = CIImage(contentsOf: images.appendingPathComponent((name == "bus-native" ? "bus" : name) + ".jpg")) else {
                    throw VisionPipelineError.unavailable("Missing declared replay image " + name)
                }
                let scale = min(1, (name == "bus-native" ? 2560 : 1280) / max(original.extent.width, original.extent.height))
                let image = original.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
                let clock = base.addingTimeInterval(Double(sampleIndex) * 10)
                var state = CameraEvidenceLifecycle(); state.start(at: clock)
                let epoch = state.trackingEpoch
                var finalResult: VehicleFrameResult?
                for frame in 0..<3 {
                    let offset = [0.0, 0.4, 0.85][frame]
                    let at = clock.addingTimeInterval(offset)
                    let result = try pipeline.process(upright: image, at: at, epoch: epoch)
                    // Independently read from the existing bus photograph before this experiment:
                    // "12 Bern Bahnhof". Other photographs are comparison/abstention smoke inputs.
                    let expected = expectation(at: clock)
                    let decisions = result.tracks.map { VehicleServiceMatcher.decide($0, expected: expected, now: at) }
                    let overlays = zip(result.tracks, decisions).map { track, decision in
                        CameraVehicleOverlay(id: track.id, box: track.detection.box, maskRuns: track.detection.mask.runs,
                            title: track.detection.kind.rawValue, decision: decision, displayText: track.readings.last?.displayText,
                            capturedAt: track.readings.last?.at)
                    }
                    // Replay delivery clock is deterministic and intentionally excludes Mac runtime.
                    // The measured inference duration is reported separately, never sold as iPhone latency.
                    check(state.publish(vehicles: overlays, matches: [], token: state.epoch, capturedAt: at, now: at), name + " replay frame \(frame) published")
                    rows.append(["sample": name, "controlledRepeatIndex": frame, "syntheticCaptureOffsetSeconds": offset,
                        "actualInputPixels": [image.extent.width, image.extent.height], "actualMacPipelineMS": result.latencyMS, "fitsExisting700msLiveResultGateOnThisMac": result.latencyMS < 700,
                        "candidateCount": state.candidateID == nil ? 0 : 1, "instruction": state.recognition,
                        "tracks": zip(result.tracks, state.vehicles).enumerated().map { index, pair -> [String: Any] in
                            let (track, overlay) = pair
                            return ["indexInFrame": index, "class": track.detection.kind.rawValue,
                                "rawModelScore": track.detection.score,
                                "maskPixels": track.detection.mask.pixels.filter { $0 != 0 }.count,
                                "box": [track.detection.box.minX, track.detection.box.minY, track.detection.box.width, track.detection.box.height],
                                "observedText": track.readings.last?.raw ?? [], "observedDisplay": overlay.displayText ?? "",
                                "state": overlay.decision.state.rawValue, "reason": overlay.decision.reason, "badge": overlay.badge]
                        }])
                    check(!state.vehicles.contains(where: { $0.decision.state == .verifiedService }), name + " no manufactured authoritative binding \(frame)")
                    finalResult = result
                }
                if let result = finalResult {
                    try drawMasks(image: image, overlays: state.vehicles, context: context, url: output.appendingPathComponent(name + "-actual-masks.png"))
                    let at = clock.addingTimeInterval(0.85)
                    let wrong = VehicleServiceExpectation(line: "999", destination: "Not a displayed destination")
                    check(result.tracks.allSatisfy { let decision = VehicleServiceMatcher.decide($0, expected: wrong, now: at); return decision.state != .visualCandidate && decision.state != .verifiedService }, name + " deliberate wrong expectation refuses positive")
                    if name == "bus" || name == "bus-native" {
                        let vehicle = result.tracks.first!
                        check(state.candidateID == vehicle.id && vehicle.readings.last?.line == "12"
                              && vehicle.readings.last?.destination == "bern bahnhof", name + " DEVELOPMENT actual pixels recover12+Bern Bahnhof and unique display match")
                        var wrongLine = expectation(at: clock); wrongLine = VehicleServiceExpectation(line: "13", destination: wrongLine.destination)
                        check(VehicleServiceMatcher.decide(vehicle, expected: wrongLine, now: at).state == .conflicting,
                              "same raw bus image different selected line conflicts")
                        let wrongDirection = VehicleServiceExpectation(line: "12", destination: "Zentrum Paul Klee")
                        check(VehicleServiceMatcher.decide(vehicle, expected: wrongDirection, now: at).state == .conflicting,
                              "same raw bus image opposite selected destination conflicts")
                        var shortTurn = expectation(at: clock, destination: "Later Terminus")
                        shortTurn.downstreamCalls.insert(.init(id: "intermediate", stopID: "station", name: "Bern Bahnhof"), at: 0)
                        check(VehicleServiceMatcher.decide(vehicle, expected: shortTurn, now: at).reason == "display_short_turn_before_alighting",
                              "same raw bus image ends before synthetic selected alighting call")
                        var stale = expectation(at: clock); stale.validUntil = clock
                        check(VehicleServiceMatcher.decide(vehicle, expected: stale, now: at).state == .unknown,
                              "same raw bus image expired selected context abstains")
                        // Synthetic display occlusion on development pixels, not a separate encounter.
                        // Region derived from detected vehicle's upper display/body band, no OCR injected.
                        let box = vehicle.detection.box
                        let obscured = CGRect(x: box.minX*image.extent.width,
                            y: (1-box.minY-box.height*0.55)*image.extent.height,
                            width: box.width*image.extent.width, height: box.height*0.55*image.extent.height)
                        let occlusion = CIImage(color: .black).cropped(to: obscured).composited(over: image)
                        let hidden = try pipeline.process(upright: occlusion, at: at.addingTimeInterval(0.4), epoch: epoch)
                        check(hidden.tracks.allSatisfy {
                            let d = VehicleServiceMatcher.decide($0, expected: expectation(at: clock), now: at.addingTimeInterval(0.4))
                            return d.state != .visualCandidate && d.state != .verifiedService
                        }, "display occlusion cannot reuse prior real positive")
                        try drawMasks(image: occlusion, overlays: [], context: context, url: output.appendingPathComponent(name + "-synthetic-display-occlusion.png"))
                    } else {
                        check(state.candidateID == nil, name + " unreadable comparison never supplies missing service identity")
                    }
                    let old = state.epoch
                    state.invalidate(.contextChanged, at: at.addingTimeInterval(0.01))
                    check(!state.publish(vehicles: [CameraVehicleOverlay(id: UUID(), box: .zero, maskRuns: [], title: "late", decision: .init(state: .visualCandidate, reason: "late"))], matches: [], token: old, capturedAt: at, now: at.addingTimeInterval(0.02)), name + " delayed old-context result refused")
                    check(state.vehicles.isEmpty && state.candidateID == nil, name + " invalidation cleared actual input display")
                    let black = CIImage(color: .black).cropped(to: image.extent)
                    let lost = try pipeline.process(upright: black, at: at.addingTimeInterval(0.8), epoch: epoch)
                    check(lost.tracks.isEmpty, name + " controlled full occlusion removes tracks")
                }
            }
        }
        let report: [String: Any] = ["schemaVersion": 2, "platform": ProcessInfo.processInfo.operatingSystemVersionString,
            "inputKind": "four licensed historical still photographs; controlled repeats, synthetic context comparisons and occlusions; bus photo is DEVELOPMENT data",
            "uniquePhotographs": 4, "developmentResolutionVariants": 2, "previousPromptSelectionHoldoutPhotographs": 1,
            "newHeldoutPhotographsAcquired": 0, "fieldEncounters": 0, "physicalDeviceRun": false,
            "assertions": assertions, "failures": failures, "frames": rows, "syntheticContextComparisons": ["correct12 Bern Bahnhof", "wrong13", "wrong destination", "Bern Bahnhof before synthetic later alighting", "expired context"],
            "limitations": "Actual Mac CoreML/Vision inference. Synthetic replay clock bypasses physical capture latency; actual Mac duration and 700ms eligibility are separately recorded. The bus is tested at1280 and up to2560 input pixels; resolution variants and repeated photos are not video tracking validation or extra encounters. No mask ground truth, no precision/recall claim. Two new held-out original downloads are pending HTTP429; excluded from all counts. Observed IDs are intentionally frame-local in this report; synthetic tracker identity tests cover ID isolation separately.",
            "attribution": "See copied image-sources.json and model-manifest.json. Generated mask overlays retain each input photograph's license; bus and tram-holdout use CC BY-SA 4.0."]
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: output.appendingPathComponent("report.json"))
        print("\(assertions - failures.count)/\(assertions) checks passed; 4 unique historical photographs, 0 field encounters.")
        exit(failures.isEmpty ? 0 : 1)
    }

    /// Real elapsed Mac inference and production publication deadlines, still using a repeated
    /// development photograph. No ARKit motion, camera capture, or physical device is simulated.
    static func actualClock(model: URL, images: URL, output: URL) throws {
        guard let original = CIImage(contentsOf: images.appendingPathComponent("bus.jpg")) else { exit(2) }
        let scale = min(1, (CommandLine.arguments.last == "live-clock-native" ? 2560 : 1280) / max(original.extent.width, original.extent.height))
        let image = original.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let pipeline = LocalVehiclePipeline(modelURL: model,
            displayModelURL: ProcessInfo.processInfo.environment["CAMERA_DISPLAY_MODEL"].map { URL(fileURLWithPath:$0) },
            displayCharactersURL: ProcessInfo.processInfo.environment["CAMERA_DISPLAY_CHARACTERS"].map { URL(fileURLWithPath:$0) })
        if ProcessInfo.processInfo.environment["CAMERA_TRACE"] == "1" { pipeline.trace = { print($0) } }
        let started = Date(), monotonicStart = ProcessInfo.processInfo.systemUptime
        var state = CameraEvidenceLifecycle(); state.start(at: started)
        let selected = expectation(at: started)
        var rows: [[String: Any]] = [], firstPositive: Double?, firstWarmCapture: Double?
        var acceptedPositives = 0, rejectedPublications = 0, rejectedByLatency = 0
        var previousStart: Double?
        for index in 0..<18 {
            try autoreleasepool {
                // Match the nominal controller's minimum0.4s capture interval; never queue work.
                if let previousStart {
                    Thread.sleep(forTimeInterval: max(0, 0.4 - (ProcessInfo.processInfo.systemUptime - previousStart)))
                }
                let captureUptime = ProcessInfo.processInfo.systemUptime
                previousStart = captureUptime
                let capturedAt = Date()
                if index == 1 { firstWarmCapture = captureUptime - monotonicStart }
                if state.feedbackExpired(at: capturedAt) { state.invalidate(.expired, at: capturedAt) }
                let token = state.epoch
                let result = try pipeline.process(upright: image, at: capturedAt, epoch: state.trackingEpoch)
                let deliveredAt = Date()
                let overlays = result.tracks.map { track in
                    CameraVehicleOverlay(id: track.id, box: track.detection.box, maskRuns: track.detection.mask.runs,
                        title: track.detection.kind.rawValue,
                        decision: VehicleServiceMatcher.decide(track, expected: selected, now: deliveredAt),
                        displayText: track.readings.last?.displayText, capturedAt: track.readings.last?.at)
                }
                let accepted = state.publish(vehicles: overlays, matches: [], token: token, capturedAt: capturedAt,
                    now: deliveredAt, routeValidUntil: selected.validUntil)
                let deliveryAge = deliveredAt.timeIntervalSince(capturedAt)
                if !accepted { rejectedPublications += 1 }
                if deliveryAge >= 0.7 { rejectedByLatency += 1 }
                if state.candidateID != nil {
                    acceptedPositives += 1
                    if firstPositive == nil { firstPositive = ProcessInfo.processInfo.systemUptime - monotonicStart }
                }
                rows.append(["frame": index, "captureOffsetSeconds": captureUptime-monotonicStart,
                    "actualMacPipelineMS": result.latencyMS, "deliveryAgeMS": deliveryAge*1000,
                    "published": accepted, "candidateCount": state.candidateID == nil ? 0 : 1,
                    "decisions": overlays.map { $0.decision.reason }, "observedDisplays": overlays.compactMap(\.displayText)])
                print("ACTUAL CLOCK frame\(index) \(Int(result.latencyMS))ms published=\(accepted) candidate=\(state.candidateID != nil)")
                fflush(stdout)
            }
        }
        let warm = rows.dropFirst().compactMap { $0["deliveryAgeMS"] as? Double }.sorted()
        var load = [Double](repeating: 0, count: 3); _ = getloadavg(&load, 3)
        let report: [String: Any] = ["schemaVersion": 1, "input": "bus development photograph,18 repeats, nominal0.4s cadence",
            "actualInputPixels": [image.extent.width,image.extent.height], "physicalCameraCapture": false,
            "uniquePhotographs": 1, "fieldEncounters": 0, "operatingSystem": ProcessInfo.processInfo.operatingSystemVersionString,
            "physicalMemoryBytes": ProcessInfo.processInfo.physicalMemory, "processorCount": ProcessInfo.processInfo.processorCount,
            "loadAveragesAtEnd": load, "coldFirstInvocationMS": rows.first?["actualMacPipelineMS"] ?? NSNull(),
            "warmMedianDeliveryMS": warm[warm.count/2], "warmMaximumDeliveryMS": warm.last!,
            "rejectedBy700msGate": rejectedByLatency, "rejectedPublicationsAllReasons": rejectedPublications,
            "acceptedPositiveFrames": acceptedPositives, "timeToFirstStableFeedbackSecondsIncludingCold": firstPositive as Any? ?? NSNull(),
            "timeToFirstStableFeedbackSecondsFromWarmCapture": firstPositive.flatMap { first in firstWarmCapture.map { first-$0 } } as Any? ?? NSNull(),
            "frames": rows,
            "limitations": "Actual elapsed Mac inference through real matcher/lifecycle deadline, repeated development still image. Selected context synthetic. Fixed image excludes ARKit pose/motion rejection and capture cost. Load may include other development; see resource snapshots.18 repeats are not18 encounters, steady statistics not physical iPhone p95. No authoritative binding or field accuracy claim."]
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted,.sortedKeys]).write(to: output.appendingPathComponent("actual-time-report.json"))
        print("ACTUAL CLOCK \(acceptedPositives) positive frames, \(rejectedByLatency) rejected by700ms gate; physical iPhone pending.")
    }

    // Test-selected itinerary, explicitly synthetic. It cannot supply a vehicle binding.
    static func expectation(at clock: Date, destination: String = "Bern Bahnhof") -> VehicleServiceExpectation {
        VehicleServiceExpectation(line: "12", destination: destination, boardingStopID: "replay-origin", alightingStopID: "replay-alight",
            validUntil: clock.addingTimeInterval(30), requiresRouteContext: true, revision: 1, observedAt: clock,
            boardingCallID: "replay-board", alightingCallID: "replay-alight-call",
            downstreamCalls: [.init(id: "replay-alight-call", stopID: "replay-alight", name: destination)])
    }

    static func drawMasks(image: CIImage, overlays: [CameraVehicleOverlay], context: CIContext, url: URL) throws {
        let width = Int(image.extent.width), height = Int(image.extent.height)
        guard let source = context.createCGImage(image, from: image.extent),
              let canvas = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw VisionPipelineError.unavailable("Cannot render evaluation mask") }
        canvas.draw(source, in: CGRect(x: 0, y: 0, width: width, height: height))
        for overlay in overlays {
            let conflict = overlay.decision.state == .conflicting, positive = overlay.decision.state == .visualCandidate
            let color = CGColor(red: conflict || positive ? 1 : 0.6, green: conflict ? 0.15 : positive ? 0.65 : 0.6, blue: conflict || positive ? 0.1 : 0.6, alpha: 0.35)
            canvas.setFillColor(color)
            for run in overlay.maskRuns {
                canvas.fill(CGRect(x: run.minX * Double(width), y: (1 - run.maxY) * Double(height), width: run.width * Double(width), height: run.height * Double(height)))
            }
            canvas.setStrokeColor(color.copy(alpha: 1)!); canvas.setLineWidth(3)
            let b = overlay.box
            canvas.stroke(CGRect(x: b.minX * Double(width), y: (1-b.maxY) * Double(height), width: b.width * Double(width), height: b.height * Double(height)))
        }
        guard let raster = canvas.makeImage(), let writer = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { throw VisionPipelineError.unavailable("Cannot save evaluation mask") }
        CGImageDestinationAddImage(writer, raster, nil)
        guard CGImageDestinationFinalize(writer) else { throw VisionPipelineError.unavailable("Cannot finish evaluation mask") }
    }
}
