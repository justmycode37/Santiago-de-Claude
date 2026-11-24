import SwiftUI
import Combine
import SceneKit
import ARKit
import AVFoundation
import CryptoKit
import ImageIO
import Vision
import CoreImage
import simd

/// Fixtures live outside the application bundle. This lab never receives a JourneyStore,
/// LocationController, VisualLocationStore or a live observation publication callback.
private enum IndoorLabFiles {
    static var root: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("IndoorLab") }
    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func read(_ path: String, hash: String? = nil) throws -> Data {
        guard !path.hasPrefix("/"), !path.split(separator: "/").contains("..") else { throw LabError.invalid("Invalid fixture path") }
        let url = root.appendingPathComponent(path).resolvingSymlinksInPath()
        guard url.path.hasPrefix(root.resolvingSymlinksInPath().path + "/") else { throw LabError.invalid("Invalid fixture path") }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0, size < 30_000_000 else { throw LabError.invalid("Fixture size outside limit") }
        let data = try Data(contentsOf: url)
        if let hash, Self.hash(data) != hash { throw LabError.invalid("Fixture hash mismatch: \(path)") }
        return data
    }
    static func save(_ report: [String: Any]) throws -> URL {
        let url = root.appendingPathComponent("latest-report.json")
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: url, options: .atomic)
        return url
    }
}
private enum LabError: LocalizedError { case invalid(String); var errorDescription: String? { if case .invalid(let s) = self { return s }; return nil } }
private struct LabPhoto: Decodable { let id, path, sha256, kind, line, destination: String; let box: [Double] }
private struct LabVideoFrame: Decodable { let path, sha256: String; let pts: Double; let boxes: [[Double]] }
private struct LabManifest: Decodable {
    let version: Int
    let id, coverage, attribution, geometrySHA256: String
    let photos: [LabPhoto]
    let video: [LabVideoFrame]
    let thresholds: Thresholds
    struct Thresholds: Decodable { let vehicleIoU, projectionPixels: Double }
}
private struct LabGeometry: Decodable {
    let calibration: SpatialCameraCalibration
    let targets, points, colors: [[Double]]
    let frames: [Frame]
    struct Frame: Decodable {
        let path, sha256: String
        let pts: Double
        let pose: [Double]
        let expected: [[Double]?]
        var matrix: simd_double4x4 {
            simd_double4x4(columns: (SIMD4(pose[0],pose[1],pose[2],pose[3]), SIMD4(pose[4],pose[5],pose[6],pose[7]),
                                    SIMD4(pose[8],pose[9],pose[10],pose[11]), SIMD4(pose[12],pose[13],pose[14],pose[15])))
        }
    }
    func validate() throws {
        guard calibration.isValid, (1...200).contains(frames.count), (1...20).contains(targets.count),
              points.count <= 12000, points.count == colors.count,
              (targets + points + colors).allSatisfy({ $0.count == 3 && $0.allSatisfy(\.isFinite) }),
              frames.allSatisfy({ $0.pose.count == 16 && $0.pose.allSatisfy(\.isFinite) && CalibratedPoseGeometry.rigid($0.matrix)
                  && $0.expected.count == targets.count && $0.expected.allSatisfy({ $0 == nil || ($0!.count == 2 && $0!.allSatisfy(\.isFinite)) }) })
        else { throw LabError.invalid("Invalid calibrated recording") }
    }
}

/// Shared by live geographic AR and the explicitly simulated indoor rehearsal.
enum JourneyReferenceMarker {
    static func make(label: String) -> SCNNode {
        let root = SCNNode(), ball = SCNSphere(radius: 0.8)
        ball.firstMaterial?.diffuse.contents = UIColor.systemTeal
        let marker = SCNNode(geometry: ball); marker.position.y = 3; root.addChildNode(marker)
        let text = SCNText(string: label, extrusionDepth: 0)
        text.font = .systemFont(ofSize: 0.6, weight: .bold); text.firstMaterial?.diffuse.contents = UIColor.white
        let caption = SCNNode(geometry: text); caption.position = SCNVector3(0,4.2,0)
        caption.constraints = [SCNBillboardConstraint()]; root.addChildNode(caption)
        return root
    }
}

private enum IndoorLabRunner {
    static func rect(_ a: [Double]) -> CGRect { CGRect(x: a[0], y: a[1], width: a[2], height: a[3]) }
    static func run(progress: @escaping @Sendable (String) async -> Void) async throws -> [String: Any] {
        let data = try IndoorLabFiles.read("manifest.json")
        let manifest = try JSONDecoder().decode(LabManifest.self, from: data)
        guard manifest.version == 1, manifest.photos.count <= 30, (1...100).contains(manifest.video.count),
              manifest.thresholds.vehicleIoU == 0.35, manifest.thresholds.projectionPixels == 0.1,
              manifest.photos.allSatisfy({ $0.box.count == 4 }),
              manifest.video.allSatisfy({ $0.pts.isFinite && $0.pts >= 0 && $0.boxes.allSatisfy({ $0.count == 4 }) }),
              zip(manifest.video, manifest.video.dropFirst()).allSatisfy({ $0.pts < $1.pts }) else { throw LabError.invalid("Unsupported fixture contract") }
        let geometry = try JSONDecoder().decode(LabGeometry.self, from: IndoorLabFiles.read("geometry.json", hash: manifest.geometrySHA256))
        try geometry.validate()
        await progress("Verifying frozen media…")
        for p in manifest.photos { try Task.checkCancellation(); _ = try IndoorLabFiles.read(p.path, hash: p.sha256) }
        for f in manifest.video { try Task.checkCancellation(); _ = try IndoorLabFiles.read(f.path, hash: f.sha256) }
        for f in geometry.frames { try Task.checkCancellation(); _ = try IndoorLabFiles.read(f.path, hash: f.sha256) }
        var report: [String: Any] = ["schemaVersion": 1, "fixture": manifest.id, "manifestSHA256": IndoorLabFiles.hash(data),
            "geometrySHA256": manifest.geometrySHA256, "startedAt": ISO8601DateFormatter().string(from: Date()), "coverage": manifest.coverage,
            "deviceOS": ProcessInfo.processInfo.operatingSystemVersionString,
            "appVersion": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"]
        if let executable = Bundle.main.executableURL { report["executableSHA256"] = IndoorLabFiles.hash(try Data(contentsOf: executable)) }
        var photoRows: [[String: Any]] = []
        let pipeline = LocalVehiclePipeline()
        let clock = Date(timeIntervalSince1970: 1_800_000_000)
        for p in manifest.photos {
            try Task.checkCancellation(); await progress("Reading actual \(p.kind) photo…")
            let row: [String: Any] = try autoreleasepool {
                guard let image = CIImage(data: try IndoorLabFiles.read(p.path)) else { throw LabError.invalid("Photo decode failed") }
                let result = try pipeline.process(upright: image, at: clock, epoch: UUID())
                let candidates = result.tracks.filter { $0.detection.kind.rawValue == p.kind }
                let track = candidates.max { VehicleTracker.iou($0.detection.box, rect(p.box)) < VehicleTracker.iou($1.detection.box, rect(p.box)) }
                let iou = track.map { VehicleTracker.iou($0.detection.box, rect(p.box)) } ?? 0
                let reading = track?.readings.last
                let correct = iou >= manifest.thresholds.vehicleIoU && reading?.line == VehicleTextRules.normalize(p.line)
                    && reading?.destination == VehicleTextRules.normalize(p.destination)
                return ["id": p.id, "detected": iou >= manifest.thresholds.vehicleIoU, "iou": iou,
                        "readingCorrect": correct, "expectedLine": p.line, "expectedDestination": p.destination,
                        "observedLine": reading?.line ?? "", "observedDestination": reading?.destination ?? "",
                        "raw": reading?.raw ?? [], "latencyMS": result.latencyMS,
                        "diagnostics": diagnostics(result),
                        "scope": "single still image; no temporal service-confirmation claim"]
            }
            photoRows.append(row)
        }
        report["photos"] = photoRows
        // Predeclared sampling experiment. Same original pixels and confidence/mask rules;
        // only the scene OCR downsample cap changes. Never feeds a real journey.
        let detailed = LocalVehiclePipeline(sceneDetail: .high)
        var experiments: [[String: Any]] = []
        for p in manifest.photos {
            try Task.checkCancellation(); await progress("Inspecting higher-detail \(p.kind) reading…")
            let row: [String: Any] = try autoreleasepool {
                guard let image = CIImage(data: try IndoorLabFiles.read(p.path, hash: p.sha256)) else { throw LabError.invalid("Photo decode failed") }
                let result = try detailed.process(upright: image, at: clock, epoch: UUID())
                let track = result.tracks.filter { $0.detection.kind.rawValue == p.kind }.max { VehicleTracker.iou($0.detection.box, rect(p.box)) < VehicleTracker.iou($1.detection.box, rect(p.box)) }
                let iou = track.map { VehicleTracker.iou($0.detection.box, rect(p.box)) } ?? 0
                let reading = track?.readings.last
                let correct = iou >= manifest.thresholds.vehicleIoU && reading?.line == VehicleTextRules.normalize(p.line)
                    && reading?.destination == VehicleTextRules.normalize(p.destination)
                return ["id": p.id, "sceneMaximumDimension": 1920, "iou": iou, "readingCorrect": correct,
                        "observedLine": reading?.line ?? "", "observedDestination": reading?.destination ?? "", "raw": reading?.raw ?? [],
                        "latencyMS": result.latencyMS, "diagnostics": diagnostics(result),
                        "glyphRereadProbes": try glyphProbes(result, image: image),
                        "scope": "Sampling experiment only; not enabled in the live camera; development photos, not held-out validation"]
            }
            experiments.append(row)
        }
        report["photoSamplingExperiments"] = experiments
        var rows: [[String: Any]] = [], availablePTS = 0.0, missedBoxes = 0, foundBoxes = 0, unsupported = 0, candidates = 0, dropped = 0
        var lifecycle = CameraEvidenceLifecycle(); lifecycle.start(at: clock)
        let epoch = UUID()
        for (index, f) in manifest.video.enumerated() {
            try Task.checkCancellation()
            if f.pts < availablePTS {
                dropped += 1; missedBoxes += f.boxes.count
                rows.append(["index": index, "sourcePTS": f.pts, "droppedBusy": true, "annotatedBoxes": f.boxes.count]); continue
            }
            await progress("Moving-camera video \(index + 1)/\(manifest.video.count)…")
            let captured = clock.addingTimeInterval(f.pts)
            if lifecycle.feedbackExpired(at: captured) { lifecycle.invalidate(.expired, at: captured) }
            let token = lifecycle.epoch, started = ProcessInfo.processInfo.systemUptime
            let result: VehicleFrameResult = try autoreleasepool {
                guard let image = CIImage(data: try IndoorLabFiles.read(f.path)) else { throw LabError.invalid("Video frame decode failed") }
                return try pipeline.process(upright: image, at: captured, epoch: epoch)
            }
            let elapsed = ProcessInfo.processInfo.systemUptime - started
            availablePTS = f.pts + elapsed
            let now = captured.addingTimeInterval(elapsed)
            var trackRows: [[String: Any]] = [], overlays: [CameraVehicleOverlay] = []
            for t in result.tracks {
                let decision = VehicleServiceMatcher.decide(t, expected: VehicleServiceExpectation(line: "12", destination: "Bern Bahnhof"), now: now)
                let reading = t.readings.last
                if reading?.line != nil && reading?.destination != nil { unsupported += 1 }
                if decision.state == .visualCandidate || decision.state == .verifiedService { candidates += 1 }
                trackRows.append(["id": t.id.uuidString, "kind": t.detection.kind.rawValue,
                                  "box": [t.detection.box.minX,t.detection.box.minY,t.detection.box.width,t.detection.box.height],
                                  "line": reading?.line ?? "", "destination": reading?.destination ?? "", "raw": reading?.raw ?? [],
                                  "decision": decision.state.rawValue, "reason": decision.reason])
                overlays.append(CameraVehicleOverlay(id: t.id, box: t.detection.box, maskRuns: [], title: t.detection.kind.rawValue,
                                                     decision: decision, displayText: reading?.displayText, capturedAt: reading?.at))
            }
            // Sparse annotations: one-to-one matching. Unlabelled objects are not false positives.
            var used = Set<UUID>(), found = 0
            for b in f.boxes {
                let t = result.tracks.filter { !used.contains($0.id) }.max { VehicleTracker.iou($0.detection.box, rect(b)) < VehicleTracker.iou($1.detection.box, rect(b)) }
                if let t, VehicleTracker.iou(t.detection.box, rect(b)) >= manifest.thresholds.vehicleIoU { used.insert(t.id); found += 1 }
            }
            foundBoxes += found; missedBoxes += f.boxes.count - found
            let published = lifecycle.publish(vehicles: overlays, matches: [], token: token, capturedAt: captured, now: now, displayIssues: result.displayIssues)
            rows.append(["index": index, "sourcePTS": f.pts, "droppedBusy": false, "processingMS": elapsed * 1000,
                         "annotatedBoxes": f.boxes.count, "foundBoxes": found, "publishedFresh": published, "tracks": trackRows])
        }
        report["video"] = ["frames": rows, "totalFrames": manifest.video.count, "droppedFrames": dropped,
                           "foundAnnotatedBoxes": foundBoxes, "missedAnnotatedBoxesIncludingDrops": missedBoxes,
                           "unsupportedCompleteReadings": unsupported, "falseServiceCandidates": candidates,
                           "timing": "Original PTS plus measured on-phone decode/inference time; busy frames dropped. Accelerated replay clock, not display playback FPS.",
                           "scope": "one negative-only development clip; sparse boxes; no positive temporal utility"]
        await progress("Checking calibrated 3D projection…")
        var maximum = 0.0, failed = 0, checked = 0, behindPassed = 0
        for f in geometry.frames {
            try Task.checkCancellation()
            for (i,p) in geometry.targets.enumerated() {
                let actual = CalibratedPoseGeometry.project(SIMD3(p[0],p[1],p[2]), siteFromCamera: f.matrix, calibration: geometry.calibration)
                checked += 1
                if let expected = f.expected[i], let actual {
                    let error = simd_length(actual - SIMD2(expected[0],expected[1])); maximum = max(maximum,error)
                    if !error.isFinite || error > manifest.thresholds.projectionPixels { failed += 1 }
                } else if (actual == nil) != (f.expected[i] == nil) { failed += 1 }
            }
            let behind = f.matrix * SIMD4<Double>(0,0,1,1)
            if CalibratedPoseGeometry.project(SIMD3(behind.x,behind.y,behind.z), siteFromCamera: f.matrix, calibration: geometry.calibration) == nil { behindPassed += 1 }
        }
        report["samplingExperimentVideo"] = try await experimentVideo(manifest.video, pipeline: detailed, progress: progress)
        report["geometry"] = ["projections": checked, "failed": failed, "maxPixelDifferenceFromIndependentOracle": maximum,
                              "behindCameraRejections": behindPassed, "behindCameraCases": geometry.frames.count,
                              "scope": "Reference poses supplied to production projection; does not measure estimated localization or ARKit accuracy."]
        report["vehicleV2"] = try await vehicleV2(manifest, progress: progress)
        report["evidenceLifecycle"] = lifecycleChecks()
        report["completedAt"] = ISO8601DateFormatter().string(from: Date())
        return report
    }
    /// Diagnostic only: four predeclared rereads of an already observed route ROI.
    /// Never feeds the tracker, service matcher or real camera. No expected text enters.
    static func glyphProbes(_ result: VehicleFrameResult, image: CIImage) throws -> [[String: Any]] {
        let context = CIContext(options: [.cacheIntermediates: false])
        var rows: [[String: Any]] = []
        for d in result.recognitionDiagnostics.prefix(3) {
            guard let track = result.tracks.first(where: { $0.id == d.trackID }), track.readings.last?.line == nil else { continue }
            let others = result.tracks.filter { $0.id != track.id }.map { $0.detection.box }
            guard let region = VehicleTextRules.refinementRegion(d.visionTexts, detection: track.detection, otherBoxes: others)
                    ?? VehicleDisplayRecognitionPolicy.glyphRefinementRegion(d.visionTexts, detection: track.detection, otherBoxes: others) else {
                rows.append(["trackID": track.id.uuidString, "status": "no_eligible_observed_route_region"]); continue
            }
            let pixels = CGRect(x: region.minX * image.extent.width, y: (1-region.maxY)*image.extent.height,
                                width: region.width*image.extent.width, height: region.height*image.extent.height).integral.intersection(image.extent)
            guard pixels.width >= 4, pixels.height >= 4 else { continue }
            let scale = min(2,384/max(pixels.width,pixels.height))
            let native = image.cropped(to: pixels).transformed(by: CGAffineTransform(scaleX: scale,y: scale))
            let gray = native.applyingFilter("CIColorControls",parameters: [kCIInputSaturationKey:0])
            let modes: [(String, CIImage, VNRequestTextRecognitionLevel)] = [
                ("color-accurate",native,.accurate), ("gray-accurate",gray,.accurate),
                ("inverted-gray-accurate",gray.applyingFilter("CIColorInvert"),.accurate), ("color-fast",native,.fast)]
            for (name,input,level) in modes {
                try Task.checkCancellation()
                guard let cg = context.createCGImage(input,from:input.extent) else { continue }
                let start = ProcessInfo.processInfo.systemUptime
                let request = VNRecognizeTextRequest();request.recognitionLevel = level;request.usesLanguageCorrection = false
                request.recognitionLanguages = ["de-DE","fr-FR","en-US"];request.minimumTextHeight = 0.05
                try VNImageRequestHandler(cgImage:cg).perform([request])
                let texts = (request.results ?? []).compactMap { observation -> [String: Any]? in
                    guard let candidate = observation.topCandidates(1).first else { return nil }
                    let b = observation.boundingBox
                    let mapped = CGRect(x:(pixels.minX+b.minX*pixels.width)/image.extent.width,
                                        y:1-(pixels.minY+b.maxY*pixels.height)/image.extent.height,
                                        width:b.width*pixels.width/image.extent.width,height:b.height*pixels.height/image.extent.height)
                    return ["text":candidate.string,"score":candidate.confidence,"meetsExistingVisionThreshold":candidate.confidence>=0.7,
                            "exclusivelyInsideVehicle":VehicleDisplayRecognitionPolicy.associated(mapped,detection:track.detection,otherBoxes:others),
                            "box":[mapped.minX,mapped.minY,mapped.width,mapped.height]]
                }
                rows.append(["trackID":track.id.uuidString,"mode":name,"region":[region.minX,region.minY,region.width,region.height],
                             "processingMS":(ProcessInfo.processInfo.systemUptime-start)*1000,"observations":texts,
                             "scope":"Diagnostic only; correlated rereads are not independent temporal evidence; no output promoted"])
            }
        }
        return rows
    }
    static func diagnostics(_ result: VehicleFrameResult) -> [[String: Any]] {
        result.recognitionDiagnostics.map { d in
            let t = result.tracks.first { $0.id == d.trackID }
            let others = result.tracks.filter { $0.id != d.trackID }.map { $0.detection.box }
            func alternative(_ o: AlternativeDisplayObservation) -> [String: Any] {
                ["engine": o.engineID, "model": o.modelID, "sampling": o.samplingID, "text": o.text, "characterScores": o.characterScores]
            }
            return ["trackID": d.trackID.uuidString,
                    "visionTexts": d.visionTexts.map { text -> [String: Any] in
                        ["text": text.text, "score": text.score,
                         "box": [text.box.minX,text.box.minY,text.box.width,text.box.height],
                         "exclusivelyInsideVehicle": t.map { VehicleDisplayRecognitionPolicy.associated(text.box, detection: $0.detection, otherBoxes: others) } ?? false]
                    },
                    "proposalRejectionReason": d.proposalRejectionReason ?? "", "fallbackFailure": d.fallbackFailure ?? "",
                    "displayIssue": d.displayIssue?.rawValue ?? "",
                    "alternatives": ([d.alternative].compactMap { $0 } + d.additionalAlternatives).map(alternative)]
        }
    }
    static func experimentVideo(_ frames: [LabVideoFrame], pipeline: LocalVehiclePipeline,
                                progress: @escaping @Sendable (String) async -> Void) async throws -> [String: Any] {
        let clock = Date(timeIntervalSince1970: 1_800_000_000), epoch = UUID()
        var available = 0.0, dropped = 0, unsupported = 0, candidates = 0
        var rows: [[String: Any]] = []
        for (i,f) in frames.enumerated() {
            try Task.checkCancellation()
            if f.pts < available { dropped += 1; rows.append(["index": i, "droppedBusy": true]); continue }
            await progress("Candidate negative video \(i+1)/\(frames.count)…")
            let start = ProcessInfo.processInfo.systemUptime, captured = clock.addingTimeInterval(f.pts)
            let result: VehicleFrameResult = try autoreleasepool {
                guard let image = CIImage(data: try IndoorLabFiles.read(f.path, hash: f.sha256)) else { throw LabError.invalid("Video decode failed") }
                return try pipeline.process(upright: image, at: captured, epoch: epoch)
            }
            let elapsed = ProcessInfo.processInfo.systemUptime - start; available = f.pts + elapsed
            let now = captured.addingTimeInterval(elapsed)
            var observations: [[String: Any]] = []
            for track in result.tracks {
                let reading = track.readings.last
                let decision = VehicleServiceMatcher.decide(track, expected: VehicleServiceExpectation(line: "12", destination: "Bern Bahnhof"), now: now)
                if reading?.line != nil && reading?.destination != nil { unsupported += 1 }
                if decision.state == .visualCandidate || decision.state == .verifiedService { candidates += 1 }
                observations.append(["line": reading?.line ?? "", "destination": reading?.destination ?? "", "state": decision.state.rawValue])
            }
            rows.append(["index": i, "sourcePTS": f.pts, "droppedBusy": false, "processingMS": elapsed*1000, "observations": observations])
        }
        return ["totalFrames": frames.count, "droppedFrames": dropped,
                "unsupportedCompleteReadings": unsupported, "falseServiceCandidates": candidates, "frames": rows,
                "scope": "Negative-only sampling experiment, not temporal positive validation; not enabled in live camera"]
    }
    static func lifecycleChecks() -> [[String: Any]] {
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        func candidate() -> CameraVehicleOverlay {
            CameraVehicleOverlay(id: UUID(), box: CGRect(x: 0.2,y: 0.2,width: 0.5,height: 0.5),maskRuns: [],title: "Synthetic check",
                decision: VehicleDecision(state: .visualCandidate, reason: "synthetic_state_test"), capturedAt: at)
        }
        var checks: [[String: Any]] = []
        for reason in CameraEvidenceLifecycle.Invalidation.allCases {
            var state = CameraEvidenceLifecycle(); state.start(at: at)
            let token = state.epoch
            let first = state.publish(vehicles: [candidate()], matches: [], token: token, capturedAt: at, now: at)
            state.invalidate(reason, at: at.addingTimeInterval(0.1))
            let late = state.publish(vehicles: [candidate()], matches: [], token: token, capturedAt: at, now: at.addingTimeInterval(0.2))
            checks.append(["name": "invalidation_\(reason)", "passed": first && !late && state.vehicles.isEmpty && state.candidateID == nil])
        }
        var state = CameraEvidenceLifecycle(); state.start(at: at)
        let late = state.publish(vehicles: [candidate()], matches: [], token: state.epoch, capturedAt: at, now: at.addingTimeInterval(0.71))
        checks.append(["name": "700ms_stale_frame", "passed": !late && state.candidateID == nil])
        // Throttled to 1.2 s (hot phone): a 0.9 s old frame still publishes, and its overlay outlives the gap to the next.
        state.start(at: at)
        let throttled = state.publish(vehicles: [candidate()], matches: [], token: state.epoch, capturedAt: at, now: at.addingTimeInterval(0.9), cadence: 1.2)
        checks.append(["name": "throttled_cadence_publishes", "passed": throttled && (state.expiresAt.map { $0 > at.addingTimeInterval(1.2) } ?? false)])
        // A small movement clears the overlay but keeps the tracks; a big turn resets them.
        state.start(at: at)
        let tracking = state.trackingEpoch
        state.invalidate(.moved, at: at)
        let keptOnMove = state.trackingEpoch == tracking && state.vehicles.isEmpty
        state.invalidate(.turned, at: at)
        checks.append(["name": "moved_keeps_tracks_turned_resets", "passed": keptOnMove && state.trackingEpoch != tracking])
        state.start(at: at)
        let multiple = state.publish(vehicles: [candidate(),candidate()], matches: [], token: state.epoch, capturedAt: at, now: at)
        checks.append(["name": "ambiguous_two_matches", "passed": multiple && state.candidateID == nil && state.vehicles.allSatisfy { $0.decision.state == .unknown }])
        state.start(at: at)
        let expiredRoute = state.publish(vehicles: [candidate()], matches: [], token: state.epoch, capturedAt: at, now: at, routeValidUntil: at)
        checks.append(["name": "expired_route", "passed": !expiredRoute && state.candidateID == nil])
        return checks
    }
}

@MainActor private final class IndoorLabModel: ObservableObject {
    @Published var status = "Ready for indoor research checks"
    @Published var summary = ""
    @Published var running = false
    @Published var reportURL: URL?
    @Published var geometry: LabGeometry?
    @Published var attribution = ""
    private var work: Task<Data, Error>?
    private var task: Task<Void, Never>?
    func load() async {
        do {
            let result = try await Task.detached { () -> (LabGeometry, String) in
                let m = try JSONDecoder().decode(LabManifest.self, from: IndoorLabFiles.read("manifest.json"))
                let g = try JSONDecoder().decode(LabGeometry.self, from: IndoorLabFiles.read("geometry.json", hash: m.geometrySHA256))
                try g.validate(); return (g,m.attribution)
            }.value
            geometry = result.0; attribution = result.1
        } catch { status = "Research pack unavailable: \(error.localizedDescription)" }
    }
    func cancel() { work?.cancel(); task?.cancel(); if running { status = "Cancelling current frame…" } }
    func run() {
        guard !running else { return }
        running = true; summary = ""; reportURL = nil
        task = Task {
            do {
                let owner = self
                let worker = Task.detached(priority: .userInitiated) {
                    let result = try await IndoorLabRunner.run { message in await owner.progress(message) }
                    return try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
                }
                work = worker
                let reportData = try await worker.value
                guard var report = try JSONSerialization.jsonObject(with: reportData) as? [String: Any] else { throw LabError.invalid("Invalid report") }
                try Task.checkCancellation()
                status = "Checking actual journey engine…"
                report["journey"] = try await journeyChecks()
                try Task.checkCancellation()
                report["status"] = "completed"
                reportURL = try IndoorLabFiles.save(report)
                let photos = report["photos"] as? [[String: Any]] ?? []
                let video = report["video"] as? [String: Any] ?? [:]
                let geo = report["geometry"] as? [String: Any] ?? [:]
                let life = report["evidenceLifecycle"] as? [[String: Any]] ?? []
                let journey = report["journey"] as? [String: Any] ?? [:]
                let experiments = report["photoSamplingExperiments"] as? [[String: Any]] ?? []
                summary = "Original baseline photo readings: \(photos.filter { $0["readingCorrect"] as? Bool == true }.count)/\(photos.count)\nVideo annotated vehicles: \(video["foundAnnotatedBoxes"] ?? 0)/\((video["foundAnnotatedBoxes"] as? Int ?? 0) + (video["missedAnnotatedBoxesIncludingDrops"] as? Int ?? 0))\nDropped frames: \(video["droppedFrames"] ?? 0)\nUnsupported display readings: \(video["unsupportedCompleteReadings"] ?? 0)\nFalse service candidates: \(video["falseServiceCandidates"] ?? 0)\nProjection failures: \(geo["failed"] ?? 0)/\(geo["projections"] ?? 0)\nEvidence checks: \(life.filter { $0["passed"] as? Bool == true }.count)/\(life.count)\nJourney replay: \(journey["passed"] as? Bool == true ? "passed" : "failed")"
                summary += "\nHigher-detail photo experiment: \(experiments.filter { $0["readingCorrect"] as? Bool == true }.count)/\(experiments.count)"
                if let comparison = report["vehicleV2"] as? [String: Any], let variants = comparison["variants"] as? [[String: Any]] {
                    for variant in variants {
                        let rows = variant["photos"] as? [[String: Any]] ?? []
                        let labelled = rows.filter { $0["destinationStatus"] as? String == "readable" }
                        summary += "\nVehicle \(variant["name"] ?? "comparison"): \(labelled.filter { $0["readingCorrect"] as? Bool == true }.count)/\(labelled.count) complete displays"
                    }
                }
                status = "Checks finished · inspect results below"
            } catch {
                if Task.isCancelled { status = "Cancelled · no complete result" }
                else {
                    status = "Checks stopped: \(error.localizedDescription)"
                    reportURL = try? IndoorLabFiles.save(["status": "error", "error": error.localizedDescription, "at": ISO8601DateFormatter().string(from: Date())])
                }
            }
            running = false; work = nil
        }
    }
    private func progress(_ message: String) { status = message }
    private func journeyChecks() async throws -> [String: Any] {
        let bridge = try DomainBridge(), fixture = try bridge.fixture()
        var replay = try bridge.call("createReplay", .object(["fixture": fixture])), events: [[String: Any]] = []
        var applied = 0, outboundArrived = false
        for _ in 0..<40 {
            try Task.checkCancellation()
            if replay["navigation"]["phase"].string == "arrived", replay["direction"].string == "outbound" {
                outboundArrived = true; replay = try bridge.call("returnReplay", .object(["replay": replay]))
            }
            if applied >= 26 { break }
            let cursor = replay["cursor"].double ?? 0
            replay = try bridge.call("nextReplay", .object(["replay": replay]))
            let delta = Int((replay["cursor"].double ?? 0) - cursor)
            events.append(["phase": replay["navigation"]["phase"].string ?? "missing", "direction": replay["direction"].string ?? "missing", "delta": delta])
            guard delta > 0 else { break }
            applied += delta
            await Task.yield()
        }
        let passed = applied == 26 && outboundArrived && replay["navigation"]["phase"].string == "arrived" && replay["direction"].string == "return"
        return ["passed": passed, "appliedEvents": applied, "events": events, "scope": "Production JavaScriptCore journey engine; bundled simulated outbound/return events. Separate state; no real trip progress."]
    }
}

struct IndoorReplayLabView: View {
    @StateObject private var model = IndoorLabModel()
    @Environment(\.scenePhase) private var phase
    @State private var practice = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Label("Indoor test lab", systemImage: "viewfinder").font(.title2.bold())
                Text("Research replay · separate from your real journey").font(.headline).foregroundStyle(.secondary)
                Button { practice = true } label: { Label("Automatic reference test", systemImage: "arkit").frame(maxWidth: .infinity).padding(.vertical, 8) }
                    .buttonStyle(.borderedProminent).disabled(model.running)
                Text("Show the reference board on your Mac. The camera recognizes both images and places the marker automatically. Vehicle-recognition checks below still use original pixels directly.")
                if model.running { ProgressView().accessibilityLabel("Checks running") }
                Text(model.status).font(.headline).accessibilityIdentifier("indoor-lab-status")
                Button(model.running ? "Cancel checks" : "Run recorded checks") { if model.running { model.cancel() } else { model.run() } }
                    .buttonStyle(.borderedProminent).controlSize(.large).disabled(model.geometry == nil && !model.running)
                    .accessibilityIdentifier("run-indoor-lab")
                if !model.summary.isEmpty { Text(model.summary).font(.body.monospacedDigit()).textSelection(.enabled) }
                if let url = model.reportURL { ShareLink("Share full results", item: url) }
                if let geometry = model.geometry {
                    NavigationLink { RecordedGeometryView(recording: geometry) } label: { Label("Explore recorded 3D motion", systemImage: "cube.transparent").padding(.vertical, 10) }.disabled(model.running)
                }
                Text("This checks display reading, evidence expiry, journey replay and projection math. Recorded camera poses are supplied as reference inputs. It cannot certify outdoor localization, boarding positions or live vehicle identity.").font(.callout)
                DisclosureGroup("Sources & research licences") { Text(model.attribution).font(.caption).textSelection(.enabled) }
            }.padding()
        }.task { await model.load() }
            .onDisappear { model.cancel() }
            .onChange(of: phase) { _, value in if value != .active { model.cancel() } }
            .fullScreenCover(isPresented: $practice) { IndoorPracticeView() }
    }
}

private struct RecordedGeometryView: View {
    let recording: LabGeometry
    @State private var index = 0.0
    @State private var image: UIImage?
    @State private var showCloud = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Recorded camera motion").font(.title2.bold())
                Text("ETH3D · \(Int(index) + 1)/\(recording.frames.count) · \(recording.frames[Int(index)].pts, specifier: "%.2f") s")
                if showCloud { RecordedCloudView(recording: recording, frame: Int(index)).frame(height: 320) }
                else if let image {
                    Image(uiImage: image).resizable().aspectRatio(contentMode: .fit).overlay {
                        GeometryReader { geo in
                            ForEach(recording.targets.indices, id: \.self) { i in
                                let p = recording.targets[i]
                                if let pixel = CalibratedPoseGeometry.project(SIMD3(p[0],p[1],p[2]), siteFromCamera: recording.frames[Int(index)].matrix, calibration: recording.calibration) {
                                    Circle().stroke(.green, lineWidth: 3).frame(width: 16, height: 16)
                                        .position(x: (pixel.x + 0.5) / Double(recording.calibration.width) * geo.size.width,
                                                  y: (pixel.y + 0.5) / Double(recording.calibration.height) * geo.size.height)
                                }
                            }
                        }.clipped()
                    }
                }
                Slider(value: $index, in: 0...Double(recording.frames.count - 1), step: 1).accessibilityLabel("Recorded frame")
                Toggle("View measured 3D points", isOn: $showCloud)
                Text("Green rings mark fixed points sampled from the first depth image. The 3D view uses those measured depths and the shared journey marker, scaled for this tabletop scene. Scrub to move the recorded camera.")
                Text("Reference poses drive this replay. Alignment here checks geometry and rendering; it is not a localization estimate. Depth holes and occlusion are not filled in.").font(.callout).foregroundStyle(.secondary)
            }.padding()
        }.navigationTitle("3D replay").task(id: Int(index)) {
            let frame = recording.frames[Int(index)]
            let loaded = await Task.detached { try? IndoorLabFiles.read(frame.path, hash: frame.sha256) }.value
            guard !Task.isCancelled else { return }; image = loaded.flatMap(UIImage.init(data:))
        }
    }
}

private struct RecordedCloudView: UIViewRepresentable {
    let recording: LabGeometry
    let frame: Int
    func makeUIView(context: Context) -> SCNView {
        let view = SCNView(); view.backgroundColor = .black; view.scene = SCNScene(); view.preferredFramesPerSecond = 30
        let vertices = recording.points.map { SCNVector3($0[0],$0[1],$0[2]) }
        let source = SCNGeometrySource(vertices: vertices)
        let indices = (0..<vertices.count).map(Int32.init)
        let element = SCNGeometryElement(indices: indices, primitiveType: .point); element.pointSize = 3; element.minimumPointScreenSpaceRadius = 1; element.maximumPointScreenSpaceRadius = 3
        let geometry = SCNGeometry(sources: [source], elements: [element]); geometry.firstMaterial?.diffuse.contents = UIColor.lightGray; geometry.firstMaterial?.lightingModel = .constant
        view.scene?.rootNode.addChildNode(SCNNode(geometry: geometry))
        let camera = SCNNode(); camera.camera = SCNCamera(); camera.camera?.zNear = 0.02; camera.camera?.zFar = 30
        camera.camera?.fieldOfView = CGFloat(2 * atan(Double(recording.calibration.height) / (2 * recording.calibration.fy)) * 180 / .pi)
        view.scene?.rootNode.addChildNode(camera); view.pointOfView = camera
        let p = recording.targets[0], marker = JourneyReferenceMarker.make(label: "Replay target")
        marker.scale = SCNVector3(0.04,0.04,0.04); marker.position = SCNVector3(p[0],p[1] - 0.12,p[2])
        view.scene?.rootNode.addChildNode(marker)
        return view
    }
    func updateUIView(_ view: SCNView, context: Context) { view.pointOfView?.simdTransform = simd_float4x4((0..<4).map { c in SIMD4<Float>((0..<4).map { r in Float(recording.frames[frame].matrix[c][r]) }) }) }
}

private struct IndoorReferenceLayout: Decodable {
    let version: Int
    let id: String
    let widthPixels, heightPixels: Double
    let nominalWidthMeters: Double
    let targetPixels: [Double]
    let references: [Reference]
    struct Reference: Decodable { let id, path, sha256: String; let rectPixels: [Double] }
}

private final class IndoorReferenceRenderState: @unchecked Sendable {
    private let lock = NSLock()
    private var pose: simd_float4x4?
    private var label = "Practice target"
    private var width: Float = 0.4
    private var node: SCNNode?
    private var lastLabel = ""
    private var lastWidth: Float = 0
    func publish(_ pose: simd_float4x4?, label: String, width: Float) {
        lock.lock(); defer { lock.unlock() }; self.pose = pose; self.label = label; self.width = width
    }
    func render(in scene: SCNScene) {
        lock.lock(); let pose = self.pose, label = self.label, width = self.width; lock.unlock()
        if node == nil || node?.parent !== scene.rootNode || lastLabel != label || lastWidth != width {
            node?.removeFromParentNode()
            let root = SCNNode()
            let torus = SCNTorus(ringRadius: CGFloat(width * 0.025), pipeRadius: CGFloat(width * 0.003))
            torus.firstMaterial?.diffuse.contents = UIColor.green; torus.firstMaterial?.lightingModel = .constant
            root.addChildNode(SCNNode(geometry: torus))
            let marker = JourneyReferenceMarker.make(label: label)
            let scale = width * 0.01875
            marker.scale = SCNVector3(scale,scale,scale)
            // Shared floating cue above the reference plane; the ring is the positional witness.
            root.addChildNode(marker); root.isHidden = true; scene.rootNode.addChildNode(root)
            node = root; lastLabel = label; lastWidth = width
        }
        node?.isHidden = pose == nil
        if let pose { node?.simdTransform = pose }
    }
}

@MainActor private final class IndoorPracticeController: NSObject, ObservableObject, @preconcurrency ARSessionDelegate, @preconcurrency ARSCNViewDelegate {
    let view = ARSCNView()
    @Published var status = "Show the reference board on your Mac, then start."
    @Published var placed = false
    @Published var title = "Automatic practice journey"
    @Published var instruction = ""
    @Published var started = false
    @Published var visibleReferences = Set<String>()
    private var bridge: DomainBridge?
    private var replay: JSONValue?
    private var startup: Task<Void, Never>?
    private var expiry: Task<Void, Never>?
    private var active = false
    private var layout: IndoorReferenceLayout?
    private var referencePoses: [String: simd_float4x4] = [:]
    private var target = matrix_identity_float4x4
    private var consensus = LocalPoseConsensus()
    private var width: Double = 0.4
    private var measuredWidth = false
    private var layoutHash = ""
    private var firstFrameUptime: Double?
    private var firstPairSeconds: Double?
    private var firstReliableSeconds: Double?
    private var firstSeenSeconds: [String: Double] = [:]
    private var cameraResolution = [Int]()
    private var configuredVideoFormat = [String: Int]()
    private var lastFrameUptime = 0.0
    private var lastStatusUptime = 0.0
    private var lastSaveUptime = 0.0
    private var lastSampleUptime = 0.0
    private var began: Date?
    private var cameraFrames = 0, pairFrames = 0, reliableFrames = 0
    private var samples: [[String: Any]] = []
    private let reportQueue = DispatchQueue(label: "rightside.indoor-reference-report", qos: .utility)
    nonisolated private let renderState = IndoorReferenceRenderState()
    nonisolated private let renderTiming = SpatialRenderTiming()
    func start(measuredWidthCM: Double?) {
        guard !active else { return }
        active = true; started = true; placed = false; consensus.reset(); referencePoses = [:]
        cameraFrames = 0; pairFrames = 0; reliableFrames = 0; samples = []; began = Date()
        firstFrameUptime = nil; firstPairSeconds = nil; firstReliableSeconds = nil; firstSeenSeconds = [:]; cameraResolution = []; visibleReferences = []
        lastFrameUptime = 0; lastStatusUptime = 0; lastSaveUptime = 0; lastSampleUptime = 0
        renderTiming.reset(); view.scene = SCNScene(); view.session.delegate = self; view.session.delegateQueue = .main
        view.delegate = self; view.preferredFramesPerSecond = 60; view.antialiasingMode = .none
        view.automaticallyUpdatesLighting = false
        status = "Loading the two reference images…"
        startup = Task { [weak self] in
            let allowed: Bool
            if AVCaptureDevice.authorizationStatus(for: .video) == .authorized { allowed = true }
            else { allowed = await AVCaptureDevice.requestAccess(for: .video) }
            guard let self, self.active, !Task.isCancelled else { return }
            guard allowed, ARWorldTrackingConfiguration.isSupported else { self.status = "Camera or AR tracking unavailable."; self.active = false; self.started = false; return }
            do {
                let bytes = try await Task.detached { try IndoorLabFiles.read("reference-layout.json") }.value
                try Task.checkCancellation()
                let layout = try JSONDecoder().decode(IndoorReferenceLayout.self, from: bytes)
                guard layout.version == 1, layout.widthPixels == 1600, layout.heightPixels == 1000,
                      layout.references.count == 2, layout.targetPixels.count == 2,
                      layout.references.allSatisfy({ $0.rectPixels.count == 4 }) else { throw LabError.invalid("Invalid reference layout") }
                self.layout = layout; self.layoutHash = IndoorLabFiles.hash(bytes)
                self.measuredWidth = measuredWidthCM != nil; self.width = measuredWidthCM.map { $0 / 100 } ?? layout.nominalWidthMeters
                guard (0.15...1.5).contains(self.width) else { throw LabError.invalid("Board width must be 15–150 cm") }
                let scale = self.width / layout.widthPixels
                var references = Set<ARReferenceImage>()
                for r in layout.references {
                    let data = try await Task.detached { try IndoorLabFiles.read(r.path, hash: r.sha256) }.value
                    try Task.checkCancellation()
                    guard let source = CGImageSourceCreateWithData(data as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw LabError.invalid("Reference image could not be decoded") }
                    let reference = ARReferenceImage(image, orientation: .up, physicalWidth: r.rectPixels[2] * scale)
                    reference.name = r.id; references.insert(reference)
                    var pose = matrix_identity_float4x4
                    // ARKit image frame: x right, y normal out of image, z down the image.
                    pose.columns.3 = SIMD4(Float((r.rectPixels[0] + r.rectPixels[2]/2 - layout.widthPixels/2) * scale),0,
                                           Float((r.rectPixels[1] + r.rectPixels[3]/2 - layout.heightPixels/2) * scale),1)
                    self.referencePoses[r.id] = pose
                }
                self.target = matrix_identity_float4x4
                self.target.columns.3 = SIMD4(Float((layout.targetPixels[0] - layout.widthPixels/2)*scale),0,
                                             Float((layout.targetPixels[1] - layout.heightPixels/2)*scale),1)
                if self.replay == nil {
                    let engine = try DomainBridge(); self.bridge = engine
                    self.replay = try engine.call("createReplay", .object(["fixture": try engine.fixture()]))
                    self.updateGuidance()
                }
                let config = ARWorldTrackingConfiguration(); config.detectionImages = references; config.maximumNumberOfTrackedImages = 2; config.automaticImageScaleEstimationEnabled = false
                // Image localization needs detail. The mesh scanner's smallest 60 Hz format
                // sacrifices reference features. Keep a bounded <=3 MP, 60 Hz image stream.
                let formats = ARWorldTrackingConfiguration.supportedVideoFormats.filter {
                    $0.framesPerSecond == 60 && $0.imageResolution.width * $0.imageResolution.height <= 3_000_000
                }
                if let format = formats.max(by: { $0.imageResolution.width * $0.imageResolution.height < $1.imageResolution.width * $1.imageResolution.height }) { config.videoFormat = format }
                self.configuredVideoFormat = ["width": Int(config.videoFormat.imageResolution.width), "height": Int(config.videoFormat.imageResolution.height), "fps": config.videoFormat.framesPerSecond]
                self.view.session.run(config, options: [.resetTracking,.removeExistingAnchors])
                self.status = "Find both pictures on the board. Keep the whole board visible."
                self.expiry = Task { [weak self] in
                    while !Task.isCancelled {
                        do { try await Task.sleep(for: .milliseconds(150)) } catch { return }
                        guard let self, self.active else { return }
                        if self.lastFrameUptime > 0, ProcessInfo.processInfo.systemUptime - self.lastFrameUptime >= 0.5 {
                            self.hide("Camera frames expired. Find both pictures again.")
                        }
                    }
                }
            } catch {
                if !Task.isCancelled { self.status = "Reference test unavailable: \(error.localizedDescription)"; self.active = false; self.started = false }
            }
        }
    }
    func next() {
        guard let bridge, var state = replay else { return }
        do {
            if state["navigation"]["phase"].string == "arrived" {
                if state["direction"].string == "outbound" { state = try bridge.call("returnReplay", .object(["replay": state])) }
                else { state = try bridge.call("createReplay", .object(["fixture": try bridge.fixture()])) }
            } else { state = try bridge.call("nextReplay", .object(["replay": state])) }
            replay = state; updateGuidance()
        } catch { status = "Practice event failed: \(error.localizedDescription)" }
    }
    private func updateGuidance() {
        guard let replay else { return }
        let snapshot = NavigationSnapshot(raw: replay["navigation"])
        guard snapshot.journey.legs.indices.contains(snapshot.legIndex) else { return }
        let leg = snapshot.currentLeg
        let ride = snapshot.journey.legs.dropFirst(snapshot.legIndex).first { $0.kind == "ride" }
        let guidance = JourneyGuidance(language: .selected, phase: JourneyGuidancePhase(snapshot.phase), stop: leg.from.name,
            destination: leg.to.name, line: ride?.line ?? "", headsign: ride?.headsign ?? "", canReturn: replay["direction"].string == "outbound")
        title = guidance.title; instruction = guidance.instruction
    }
    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard active, layout != nil else { return }
        cameraFrames += 1; lastFrameUptime = frame.timestamp
        if firstFrameUptime == nil { firstFrameUptime = frame.timestamp; cameraResolution = [Int(frame.camera.imageResolution.width), Int(frame.camera.imageResolution.height)] }
        let elapsed = frame.timestamp - (firstFrameUptime ?? frame.timestamp)
        let now = Date(), age = ProcessInfo.processInfo.systemUptime - frame.timestamp
        let normal: Bool; if case .normal = frame.camera.trackingState { normal = true } else { normal = false }
        let anchors = frame.anchors.compactMap { $0 as? ARImageAnchor }.filter(\.isTracked)
        let estimates = anchors.compactMap { anchor -> LocalPoseReferenceEstimate? in
            guard let id = anchor.referenceImage.name, let siteFromImage = referencePoses[id] else { return nil }
            return LocalPoseReferenceEstimate(landmarkID: id, siteFromWorld: siteFromImage * simd_inverse(anchor.transform))
        }
        for estimate in estimates where firstSeenSeconds[estimate.landmarkID] == nil { firstSeenSeconds[estimate.landmarkID] = elapsed }
        if estimates.count == 2 { pairFrames += 1; if firstPairSeconds == nil { firstPairSeconds = elapsed } }
        let result = consensus.update(estimates: estimates, worldFromCamera: frame.camera.transform,
            at: now.addingTimeInterval(-age), now: now, trackingNormal: normal && age >= 0 && age < 0.5,
            errorBoundMeters: max(0.01,0.05 * width / 0.4), headingBoundDegrees: 3, verticalErrorBoundMeters: max(0.01,0.05 * width / 0.4))
        let reliable = result.status == .reliable
        if reliable, let alignment = result.siteFromWorld {
            reliableFrames += 1
            if firstReliableSeconds == nil { firstReliableSeconds = elapsed }
            renderState.publish(simd_inverse(alignment) * target, label: title, width: Float(width))
        } else { renderState.publish(nil, label: title, width: Float(width)) }
        if placed != reliable { placed = reliable }
        if frame.timestamp - lastStatusUptime > 0.5 {
            lastStatusUptime = frame.timestamp
            let visible = Set(estimates.map(\.landmarkID))
            if visibleReferences != visible { visibleReferences = visible }
            let message: String
            if reliable { message = "Automatically aligned · green ring should surround the purple target" }
            else if !normal { message = "Tracking limited · hold steady in good light" }
            else if estimates.count < 2 {
                if elapsed > 8 { message = "Keep BOTH pictures visible and larger in the camera. Face the screen straight on; avoid glare. Restart if the board width changed." }
                else { message = "Show both pictures together · hold the phone steady" }
            } else if result.reason == "landmark_geometry_disagrees" { message = "Pictures found, but alignment disagrees. Check the board width and avoid a steep viewing angle." }
            else { message = "Both pictures found · hold steady to establish alignment" }
            if status != message { status = message }
        }
        if frame.timestamp - lastSampleUptime > 0.1, samples.count < 1200 {
            lastSampleUptime = frame.timestamp
            samples.append(["uptime": frame.timestamp, "references": estimates.map(\.landmarkID), "normalTracking": normal,
                            "status": result.status.rawValue, "reason": result.reason,
                            "referenceDisagreementInConfiguredMeters": result.maximumTranslationDisagreement,
                            "referenceAngularDisagreementDegrees": result.maximumAngleDisagreementDegrees])
        }
        if frame.timestamp - lastSaveUptime > 3 { lastSaveUptime = frame.timestamp; save(ended: false) }
    }
    private func hide(_ message: String) {
        consensus.reset(); visibleReferences = []; renderState.publish(nil, label: title, width: Float(width)); if placed { placed = false }; if status != message { status = message }
    }
    func sessionWasInterrupted(_ session: ARSession) { hide("Interrupted · restart reference test.") }
    func session(_ session: ARSession, didFailWithError error: Error) { hide("Tracking failed · restart reference test.") }
    nonisolated func renderer(_ renderer: SCNSceneRenderer, updateAtTime time: TimeInterval) {
        renderTiming.frame(time)
        if let scene = renderer.scene { renderState.render(in: scene) }
    }
    private func save(ended: Bool) {
        guard let began else { return }
        let report: [String: Any] = ["startedAt": WireClock.string(began), "sampledAt": WireClock.string(), "sessionEnded": ended,
            "layoutSHA256": layoutHash, "boardWidthMeters": width, "widthMeasuredByUser": measuredWidth,
            "cameraResolution": cameraResolution, "configuredVideoFormat": configuredVideoFormat,
            "firstSeenSeconds": firstSeenSeconds, "firstPairSeconds": firstPairSeconds as Any? ?? NSNull(),
            "firstReliableSeconds": firstReliableSeconds as Any? ?? NSNull(),
            "cameraFrames": cameraFrames, "twoReferenceFrames": pairFrames, "reliableFrames": reliableFrames,
            "samples": samples, "renderTiming": renderTiming.snapshot(),
            "scope": "Actual ARKit two-image recognition and production LocalPoseConsensus; synthetic board site. Nominal-scale values are not physical accuracy. Agreement is not independent ground-truth error. No geographic output or field acceptance."]
        guard let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted,.sortedKeys]) else { return }
        let destination = IndoorLabFiles.root.appendingPathComponent("automatic-reference-report.json")
        reportQueue.async { try? data.write(to: destination, options: .atomic) }
    }
    func stop() {
        if active { save(ended: true) }
        active = false; started = false; startup?.cancel(); expiry?.cancel(); hide("Reference test stopped. Tap Start to try again."); view.session.pause(); view.scene = SCNScene()
    }
}
private struct IndoorPracticeSurface: UIViewRepresentable {
    let controller: IndoorPracticeController
    func makeUIView(context: Context) -> ARSCNView { controller.view }
    func updateUIView(_ view: ARSCNView, context: Context) {}
    static func dismantleUIView(_ view: ARSCNView, coordinator: ()) { view.session.pause() }
}
private struct IndoorPracticeView: View {
    @StateObject private var controller = IndoorPracticeController()
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    @State private var widthText = ""
    @FocusState private var widthFocused: Bool
    var body: some View {
        NavigationStack {
            VStack(spacing: 10) {
                Text("PRACTICE · automatic image alignment").font(.headline).padding(.top)
                if !controller.started {
                    Text("Display reference-board.png on your Mac. Keep both photos visible. The green ring should appear on the purple checkpoint without placing it by hand.")
                    TextField("Optional: full board width in cm", text: $widthText).keyboardType(.decimalPad).textFieldStyle(.roundedBorder).focused($widthFocused)
                    Text("Leave width blank for visual alignment only. For metric scale, measure the full board's outer border.").font(.caption)
                    Button("Start automatic placement") { widthFocused = false; controller.start(measuredWidthCM: Double(widthText.replacingOccurrences(of: ",", with: "."))) }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                        .disabled(!widthText.isEmpty && Double(widthText.replacingOccurrences(of: ",", with: ".")).map { (15...150).contains($0) } != true)
                }
                Text(controller.title).font(.title3.bold())
                Text(controller.instruction).font(.callout)
                IndoorPracticeSurface(controller: controller).clipShape(RoundedRectangle(cornerRadius: 18))
                Text(controller.status).font(.callout)
                if controller.started {
                    HStack(spacing: 20) {
                        ForEach(["bus", "tram"], id: \.self) { name in
                            Label(name.capitalized + (controller.visibleReferences.contains(name) ? " found" : " missing"),
                                  systemImage: controller.visibleReferences.contains(name) ? "checkmark.circle.fill" : "viewfinder")
                                .foregroundStyle(controller.visibleReferences.contains(name) ? Color.green : Color.primary)
                        }
                    }.font(.callout.bold())
                    HStack {
                        Button("Restart") { controller.stop() }
                        Button("Next simulated event") { controller.next() }.disabled(!controller.placed)
                    }.buttonStyle(.borderedProminent)
                }
                Text("No real stop or live journey is inferred. Some simulated events update data without changing the instruction.").font(.caption)
            }.padding(.horizontal).padding(.bottom)
                .navigationTitle("Automatic reference").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.onDisappear { controller.stop() }
            .onChange(of: phase) { _, value in if value != .active { controller.stop() } }
    }
}

private struct VehicleLabManifest: Decodable {
    let version: Int
    let id, attribution, sampling, limitation: String
    let photos: [Photo]
    struct Photo: Decodable {
        let id, path, sha256, encounter, split, kind, line, destinationStatus: String
        let destination: String?
        let box: [Double]
    }
}
private extension IndoorLabRunner {
    static func vehicleV2(_ regression: LabManifest, progress: @escaping @Sendable (String) async -> Void) async throws -> [String: Any] {
        let bytes = try IndoorLabFiles.read("vehicle-v2.json", hash: "6fb69405a429b003e1e15792a895549ad8b0e31ce9f180a5695b1bc4f8881133")
        let pack = try JSONDecoder().decode(VehicleLabManifest.self, from: bytes)
        guard pack.version == 1, pack.photos.count == 24, pack.photos.allSatisfy({ p in
            p.box.count == 4 && p.box.allSatisfy(\.isFinite) && CGRect(x: 0, y: 0, width: 1, height: 1).contains(rect(p.box))
        }) else { throw LabError.invalid("Unsupported vehicle comparison") }
        for p in pack.photos { _ = try IndoorLabFiles.read(p.path, hash: p.sha256) }
        let reserveBytes = try IndoorLabFiles.read("vehicle-reserve.json", hash: "7472de7a0f881d89f63a0868bd4e3e476872004cc71a4b83cd1e429fb2a993e2")
        let reserve = try JSONDecoder().decode(VehicleLabManifest.self, from: reserveBytes)
        guard reserve.version == 1, reserve.photos.count == 8,
              reserve.photos.allSatisfy({ $0.box.count == 4 && $0.box.allSatisfy(\.isFinite)
                  && CGRect(x:0,y:0,width:1,height:1).contains(rect($0.box)) }) else { throw LabError.invalid("Invalid reserved encounter") }
        for p in reserve.photos { _ = try IndoorLabFiles.read(p.path, hash: p.sha256) }
        let clock = Date(timeIntervalSince1970: 1_800_000_000)
        var variants: [[String: Any]] = []
        for name in ["baseline", "bounded-layout", "bounded-layout-route-engine"] {
            try Task.checkCancellation()
            let pipeline = LocalVehiclePipeline(sceneDetail: name == "bounded-layout-route-engine" ? .adaptive : .standard,
                displayLayout: name == "baseline" ? .routeFirst : .eitherSide, routeReread: name == "bounded-layout-route-engine")
            var rows: [[String: Any]] = []
            let photos = pack.photos + regression.photos.map {
                VehicleLabManifest.Photo(id: $0.id, path: $0.path, sha256: $0.sha256, encounter: $0.id,
                    split: "existing-development", kind: $0.kind, line: $0.line, destinationStatus: "readable", destination: $0.destination, box: $0.box)
            } + reserve.photos
            for (i,p) in photos.enumerated() {
                try Task.checkCancellation(); await progress("Vehicle comparison · \(name) · \(i+1)/\(photos.count)…")
                let row: [String: Any] = try autoreleasepool {
                    guard let image = CIImage(data: try IndoorLabFiles.read(p.path, hash: p.sha256)) else { throw LabError.invalid("Vehicle frame decode failed") }
                    // Labels are used only after inference; each still resets temporal tracking.
                    let result = try pipeline.process(upright: image, at: clock, epoch: UUID())
                    let track = result.tracks.filter { $0.detection.kind.rawValue == p.kind }.max {
                        VehicleTracker.iou($0.detection.box, rect(p.box)) < VehicleTracker.iou($1.detection.box, rect(p.box))
                    }
                    let iou = track.map { VehicleTracker.iou($0.detection.box, rect(p.box)) } ?? 0
                    let reading = iou >= 0.35 ? track?.readings.last : nil
                    let complete = reading?.line != nil && reading?.destination != nil
                    let correct = p.destination.map { reading?.line == VehicleTextRules.normalize(p.line)
                        && reading?.destination == VehicleTextRules.normalize($0) } ?? false
                    let wrong = track.map { VehicleServiceMatcher.decide($0,
                        expected: VehicleServiceExpectation(line: "999", destination: "Unrelated terminus"), now: clock).state.rawValue } ?? "unknown"
                    let same = track.map { VehicleServiceMatcher.decide($0,
                        expected: VehicleServiceExpectation(line: p.line, destination: p.destination ?? ""), now: clock).state.rawValue } ?? "unknown"
                    return ["id": p.id, "encounter": p.encounter, "split": p.split, "iou": iou,
                        "detected": iou >= 0.35, "destinationStatus": p.destinationStatus, "expectedLine": p.line,
                        "expectedDestination": p.destination ?? "", "observedLine": reading?.line ?? "",
                        "observedDestination": reading?.destination ?? "", "complete": complete,
                        "readingCorrect": correct, "incorrectComplete": p.destinationStatus == "readable" && complete && !correct,
                        "unsupportedComplete": p.destinationStatus == "absent" && complete,
                        "wrongServiceDecision": wrong, "singleFrameDecision": same,
                        "latencyMS": result.latencyMS, "coldPipeline": i == 0, "diagnostics": diagnostics(result)]
                }
                rows.append(row)
            }
            var variant: [String: Any] = ["name": name, "photos": rows]
            if name != "baseline" {
                variant["negativeVideo"] = try await experimentVideo(regression.video, pipeline: pipeline, progress: progress)
            }
            variant["positiveVideo"] = try await temporalVehicleReplay(pipeline: pipeline, progress: progress)
            variants.append(variant)
        }
        return ["manifestSHA256": IndoorLabFiles.hash(bytes), "reserveManifestSHA256": IndoorLabFiles.hash(reserveBytes),
            "variants": variants, "policyChecks": vehiclePolicyChecks(),
            "attribution": pack.attribution, "sampling": pack.sampling, "limitation": pack.limitation,
            "scope": "Regression stills plus one actual positive video encounter. Previously withheld Singapore encounters are now development evidence after inspection. Candidate modes remain disabled in live camera."]
    }

    static func vehiclePolicyChecks() -> [[String: Any]] {
        let at = Date(timeIntervalSince1970: 1_800_000_000), frame = UUID(), trackID = UUID()
        let detection = VehicleDetection(kind: .bus, box: CGRect(x: 0.05,y: 0.05,width: 0.9,height: 0.9), score: 1,
            mask: VehicleMask(width: 100,height: 100,pixels: Array(repeating: 1,count: 10_000)))
        let route = VehicleText(text: "74",box: CGRect(x: 0.62,y: 0.2,width: 0.08,height: 0.06),score: 1)
        let destination = VehicleText(text: "Buona Vista",box: CGRect(x: 0.25,y: 0.2,width: 0.35,height: 0.06),score: 1)
        func read(_ texts: [VehicleText], others: [CGRect] = []) -> DisplayReading {
            VehicleTextRules.read(texts,detection:detection,otherBoxes:others,at:at,frameID:frame,layout:.eitherSide)
        }
        var checks: [[String: Any]] = []
        func check(_ name: String, _ result: Bool) { checks.append(["name": name, "passed": result, "scope": "synthetic policy regression; not vision accuracy"]) }
        let right = read([route,destination]); check("right_route_pair",right.line == "74" && right.destination == "buona vista")
        let left = read([VehicleText(text:"12",box:CGRect(x:0.1,y:0.2,width:0.05,height:0.06),score:1),
            VehicleText(text:"Bern Bahnhof",box:CGRect(x:0.17,y:0.2,width:0.35,height:0.06),score:1)])
        check("left_route_pair",left.line == "12" && left.destination == "bern bahnhof")
        check("duplicate_rows",read([route,destination,destination]).line == "74")
        check("other_vehicle_veto",read([route,destination],others:[destination.box]).line == nil)
        check("separate_row_veto",read([route,VehicleText(text:destination.text,box:destination.box.offsetBy(dx:0,dy:0.2),score:1)]).line == nil)
        check("weak_route_not_promoted",read([VehicleText(text:route.text,box:route.box,score:0.5),destination]).line == nil)
        check("conflicting_pairs",read([route,destination,VehicleText(text:"73",box:route.box,score:1)]).ambiguous)
        check("number_at_both_ends_abstains",read([VehicleText(text:"12 Street 74",box:route.box.union(destination.box),score:1)]).ambiguous)
        check("printed_number_only",read([route]).destination == nil)
        check("street_suffix_cannot_create_route",read([VehicleText(text:"HOUGANG AVE 8",box:destination.box,score:1)]).line == nil)
        check("street_suffix_with_separate_route",read([route,VehicleText(text:"HOUGANG AVE 8",box:destination.box.offsetBy(dx:0,dy:-0.1),score:1)]).line == nil)
        check("adaptive_preserves_camera_sampling",VehicleOCRSceneDetail.adaptive.maximumDimension(for:CGSize(width:1920,height:1080)) == 1280)
        check("adaptive_preserves_large_source_detail",VehicleOCRSceneDetail.adaptive.maximumDimension(for:CGSize(width:4032,height:3024)) == 1920)
        let weakDestination = VehicleText(text:destination.text,box:destination.box,score:0.5)
        if let proposal = VehicleDisplayRecognitionPolicy.proposal([route,weakDestination],detection:detection,otherBoxes:[],layout:.eitherSide) {
            var scores = Array(repeating:Float(0.99),count:destination.text.count); scores[2] = 0.67
            let observation = AlternativeDisplayObservation(engineID:VehicleDisplayRecognitionPolicy.engineID,
                modelID:VehicleDisplayRecognitionPolicy.modelID,configID:VehicleDisplayRecognitionPolicy.configID,
                frameID:frame,capturedAt:at,trackID:trackID,text:destination.text,characterScores:scores,
                region:destination.box,samplingID:"native")
            let rejected = VehicleDisplayRecognitionPolicy.reading([observation],proposal:proposal,
                visionTexts:[route,weakDestination],detection:detection,otherBoxes:[],trackID:trackID,frameID:frame,at:at,layout:.eitherSide)
            check("right_headsign_weak_character_veto",rejected == nil)
        } else { check("right_headsign_weak_character_veto",false) }
        let weak = VehicleText(text:route.text,box:route.box,score:0.5), texts = [weak,destination]
        if let p = VehicleRouteRecognitionPolicy.proposal(texts,detection:detection,otherBoxes:[]) {
            func o(_ text: String = "74",score: Float = 0.99,otherTrack: Bool = false) -> AlternativeDisplayObservation {
                AlternativeDisplayObservation(engineID:VehicleDisplayRecognitionPolicy.engineID,modelID:VehicleDisplayRecognitionPolicy.modelID,
                    configID:VehicleDisplayRecognitionPolicy.configID,frameID:frame,capturedAt:at,trackID:otherTrack ? UUID():trackID,
                    text:text,characterScores:Array(repeating:score,count:text.count),region:route.box,samplingID:"route-native")
            }
            func r(_ observations: [AlternativeDisplayObservation]) -> DisplayReading? {
                VehicleRouteRecognitionPolicy.reading(observations,proposal:p,texts:texts,detection:detection,otherBoxes:[],trackID:trackID,frameID:frame,at:at)
            }
            check("route_engine_agreement",r([o()])?.line == "74")
            check("route_engine_low_character_veto",r([o(score:0.97)]) == nil)
            check("route_engine_disagreement_veto",r([o("73")]) == nil)
            check("route_engine_cross_track_veto",r([o(otherTrack:true)]) == nil)
            check("route_engine_correlated_conflict",r([o(),o("73")]) == nil)
        } else { check("route_proposal_exists",false) }
        let t = VehicleTrack(id:trackID,detection:detection,lastSeen:at,readings:[right])
        check("single_frame_never_candidate",VehicleServiceMatcher.decide(t,expected:VehicleServiceExpectation(line:"74",destination:"Buona Vista"),now:at).state == .unknown)
        check("wrong_service_rejected",VehicleServiceMatcher.decide(t,expected:VehicleServiceExpectation(line:"12",destination:"Bern Bahnhof"),now:at).state == .conflicting)
        return checks
    }
}

private struct VehicleTemporalManifest: Decodable {
    let version: Int
    let id, sourceSHA256, expectedLine, expectedDestination, attribution, scope: String
    let frames: [Frame]
    struct Frame: Decodable { let path, sha256: String; let pts: Double; let box: [Double]? }
}
private extension IndoorLabRunner {
    static func temporalVehicleReplay(pipeline: LocalVehiclePipeline,
        progress: @escaping @Sendable (String) async -> Void) async throws -> [String: Any] {
        let bytes = try IndoorLabFiles.read("vehicle-temporal.json", hash: "2d09eae73fe67faa6b678878a4d2c6b116f3e3b246a0249c1ecd18e471d246a5")
        let recording = try JSONDecoder().decode(VehicleTemporalManifest.self, from: bytes)
        guard recording.version == 1, recording.frames.count == 80,
              recording.frames.allSatisfy({ f in f.pts.isFinite && f.pts >= 24 && f.pts < 44
                  && (f.box == nil || (f.box!.count == 4 && f.box!.allSatisfy(\.isFinite)
                      && CGRect(x:0,y:0,width:1,height:1).contains(rect(f.box!)))) }),
              zip(recording.frames,recording.frames.dropFirst()).allSatisfy({ $0.pts < $1.pts })
        else { throw LabError.invalid("Invalid temporal vehicle contract") }
        let origin = recording.frames[0].pts, clock = Date(timeIntervalSince1970: 1_800_000_000)
        let expectation = VehicleServiceExpectation(line:recording.expectedLine,destination:recording.expectedDestination)
        let wrongExpectation = VehicleServiceExpectation(line:"999",destination:"Unrelated terminus")
        var lifecycle = CameraEvidenceLifecycle(); lifecycle.start(at:clock)
        var available = 0.0, dropped = 0, candidateFrames = 0, wrongCandidates = 0, unsupportedVerified = 0
        var annotatedDetected = 0, annotatedCorrect = 0, annotatedIncorrect = 0, annotatedDropped = 0
        var firstCandidate: Double?, rows: [[String:Any]] = []
        for (i,f) in recording.frames.enumerated() {
            try Task.checkCancellation(); await progress("Actual moving-bus replay \(i+1)/\(recording.frames.count)…")
            let relative = f.pts-origin, captured = clock.addingTimeInterval(relative)
            if lifecycle.feedbackExpired(at:captured) { lifecycle.invalidate(.expired,at:captured) }
            if relative < available {
                dropped += 1; if f.box != nil { annotatedDropped += 1 }
                rows.append(["index":i,"sourcePTS":f.pts,"droppedBusy":true,"annotated":f.box != nil]); continue
            }
            let token = lifecycle.epoch, started = ProcessInfo.processInfo.systemUptime
            let result: VehicleFrameResult = try autoreleasepool {
                guard let image = CIImage(data:try IndoorLabFiles.read(f.path,hash:f.sha256)) else { throw LabError.invalid("Temporal frame decode failed") }
                // Expected service stays outside detection/OCR; only the matcher receives it below.
                return try pipeline.process(upright:image,at:captured,epoch:lifecycle.trackingEpoch)
            }
            let elapsed = ProcessInfo.processInfo.systemUptime-started
            available = relative+elapsed
            let now = captured.addingTimeInterval(elapsed)
            var overlays: [CameraVehicleOverlay] = [], tracks: [[String:Any]] = []
            for track in result.tracks {
                let reading = track.readings.last
                let decision = VehicleServiceMatcher.decide(track,expected:expectation,now:now)
                let wrong = VehicleServiceMatcher.decide(track,expected:wrongExpectation,now:now)
                if wrong.state == .visualCandidate || wrong.state == .verifiedService { wrongCandidates += 1 }
                if decision.state == .verifiedService { unsupportedVerified += 1 }
                overlays.append(CameraVehicleOverlay(id:track.id,box:track.detection.box,maskRuns:[],title:track.detection.kind.rawValue,
                    decision:decision,displayText:reading?.displayText,capturedAt:reading?.at))
                tracks.append(["id":track.id.uuidString,"kind":track.detection.kind.rawValue,
                    "box":[track.detection.box.minX,track.detection.box.minY,track.detection.box.width,track.detection.box.height],
                    "line":reading?.line ?? "","destination":reading?.destination ?? "", "state":decision.state.rawValue,
                    "reason":decision.reason,"wrongServiceState":wrong.state.rawValue,
                    "readingAgeSeconds":reading.map { now.timeIntervalSince($0.at) } ?? -1])
            }
            let published = lifecycle.publish(vehicles:overlays,matches:[],token:token,capturedAt:captured,now:now,displayIssues:result.displayIssues)
            if published, lifecycle.candidateID != nil {
                candidateFrames += 1
                if firstCandidate == nil { firstCandidate = f.pts }
            }
            var row: [String:Any] = ["index":i,"sourcePTS":f.pts,"droppedBusy":false,"processingMS":elapsed*1000,
                "publishedFresh":published,"candidateTrackID":lifecycle.candidateID?.uuidString ?? "","tracks":tracks,
                "annotated":f.box != nil]
            if let box = f.box {
                let track = result.tracks.filter { $0.detection.kind == .bus }.max {
                    VehicleTracker.iou($0.detection.box,rect(box)) < VehicleTracker.iou($1.detection.box,rect(box))
                }
                let iou = track.map { VehicleTracker.iou($0.detection.box,rect(box)) } ?? 0
                let reading = iou >= 0.35 ? track?.readings.last : nil
                let current = reading?.at == captured
                let correct = current && reading?.line == VehicleTextRules.normalize(recording.expectedLine)
                    && reading?.destination == VehicleTextRules.normalize(recording.expectedDestination)
                let incorrect = current && reading?.line != nil && reading?.destination != nil && !correct
                if iou >= 0.35 { annotatedDetected += 1 }
                if correct { annotatedCorrect += 1 }
                if incorrect { annotatedIncorrect += 1 }
                row["annotation"] = ["iou":iou,"trackID":track?.id.uuidString ?? "","currentReading":current,
                    "correct":correct,"incorrectComplete":incorrect,
                    "targetIsPublishedCandidate":published && track?.id == lifecycle.candidateID && lifecycle.candidateID != nil]
                row["diagnostics"] = diagnostics(result)
            }
            rows.append(row)
        }
        // Explicit clock-expiry seam after the recording; no fabricated camera frame or absent-vehicle label.
        let hadCandidateAtEnd = lifecycle.candidateID != nil
        let expiryTime = clock.addingTimeInterval(available+0.81)
        if lifecycle.feedbackExpired(at:expiryTime) { lifecycle.invalidate(.expired,at:expiryTime) }
        return ["manifestSHA256":IndoorLabFiles.hash(bytes),"sourceSHA256":recording.sourceSHA256,
            "scope":recording.scope,"attribution":recording.attribution,"frames":rows,"totalFrames":recording.frames.count,
            "droppedFrames":dropped,"annotatedFrames":recording.frames.filter { $0.box != nil }.count,
            "annotatedDetected":annotatedDetected,"annotatedCorrectReadings":annotatedCorrect,
            "annotatedIncorrectCompleteReadings":annotatedIncorrect,"annotatedDropped":annotatedDropped,
            "publishedCandidateFrames":candidateFrames,"firstAnyCandidateSourcePTS":firstCandidate as Any? ?? NSNull(),
            "wrongServiceCandidates":wrongCandidates,"unsupportedVerifiedService":unsupportedVerified,
            "hadCandidateAtEnd":hadCandidateAtEnd,"clearedAfterClockExpiry":lifecycle.candidateID == nil,
            "timing":"Original media PTS plus measured file hash/decode/inference time. Busy frames skipped, no queue. Accelerated replay, not AR camera FPS. Non-annotated candidate frames require manual review."]
    }
}
