import Foundation
import ARKit
import CryptoKit
import ImageIO
import CoreLocation

/// Local surveyed-image localization. No VPS/cloud request; ARKit performs calibrated image pose + VIO.
/// Only explicit user-imported site packs, continuously visible images, and validated hardware are accepted.
final class LocalLandmarkSession {
    let pack: LocalLandmarkPack
    let references: Set<ARReferenceImage>
    private var consensus = LocalPoseConsensus()
    private var pixelProgress = LocalPixelPoseProgress()
    private var pixelEpoch = UUID()
    // Whole-session invalidation is separate from an optional pixel worker reset: an expired
    // pixel job must not revoke otherwise-valid synchronous ARKit image-anchor evidence.
    private(set) var acquisitionEpoch = UUID()
    private var pixelPipeline: VisualReferencePipeline?
    private var pixelEnvelopeCache: VisualReferenceEnvelopeCache?
    private(set) var pixelAssessment: LocalPoseAssessment?
    /// Geographic fallback is only eligible with a separate detector/config-specific proof.
    private(set) var pixelValidationStatus = "Pixel reference manifest not installed."
    private(set) var assessment: LocalPoseAssessment?
    private(set) var siteFromWorld: simd_float4x4?
    private(set) var selectedValidUntil: Date?
    static var hardwareModel: String {
        var value = utsname(); uname(&value)
        let capacity = MemoryLayout.size(ofValue: value.machine)
        return withUnsafePointer(to: &value.machine) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: capacity) { String(cString: $0) }
        }
    }
    init(directory: URL, now: Date = Date()) throws {
        let data = try Self.read("site.json", directory: directory, maximumBytes: 500_000)
        let decoded = try JSONDecoder().decode(LocalLandmarkPack.self, from: data)
        guard decoded.isFieldReady(at: now, deviceModel: Self.hardwareModel) else {
            throw VisionPipelineError.unavailable("Site pack requires current independent field-checkpoint validation for this phone. Legacy or synthetic packs cannot activate geographic guidance.")
        }
        let surveyBytes = try Self.read("survey-provenance.json", directory: directory, maximumBytes: 500_000)
        let checkpointBytes = try Self.read("checkpoint-provenance.json", directory: directory, maximumBytes: 1_000_000)
        let surveyHash = SHA256.hash(data: surveyBytes).map { String(format: "%02x", $0) }.joined()
        let checkpointHash = SHA256.hash(data: checkpointBytes).map { String(format: "%02x", $0) }.joined()
        guard surveyHash == decoded.validation?.referenceSurveySHA256,
              checkpointHash == decoded.validation?.checkpointDatasetSHA256,
              try JSONDecoder().decode(LocalLandmarkSurveyEvidence.self, from: surveyBytes).validates(decoded),
              try JSONDecoder().decode(LocalLandmarkCheckpointEvidence.self, from: checkpointBytes).validates(decoded) else {
            throw VisionPipelineError.unavailable("Independent checkpoint records do not match the declared survey, errors or provenance.")
        }
        guard Set(decoded.landmarks.map(\.imageSHA256)).count == decoded.landmarks.count else {
            throw VisionPipelineError.unavailable("Site references are not unique.")
        }
        var images = Set<ARReferenceImage>()
        var decodedImages: [String: CGImage] = [:]
        var totalPixels = 0
        for landmark in decoded.landmarks {
            let bytes = try Self.read(landmark.imageFile, directory: directory, maximumBytes: 2_000_000)
            let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            guard digest == landmark.imageSHA256,
                  let source = CGImageSourceCreateWithData(bytes as CFData, nil),
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? Int,
                  let height = properties[kCGImagePropertyPixelHeight] as? Int,
                  (64...2048).contains(width), (64...2048).contains(height),
                  totalPixels + width * height <= 16_000_000,
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
                throw VisionPipelineError.unavailable("Site reference image is invalid or its checksum does not match.")
            }
            // Pack authoring contract requires EXIF orientation baked into RGB pixels.
            guard (properties[kCGImagePropertyOrientation] as? Int ?? 1) == 1 else {
                throw VisionPipelineError.unavailable("Site reference image must have upright pixels.")
            }
            let reference = ARReferenceImage(image, orientation: .up, physicalWidth: landmark.physicalWidthMeters)
            totalPixels += width * height
            reference.name = landmark.id
            images.insert(reference)
            decodedImages[landmark.id] = image
        }
        pack = decoded; references = images
        let manifestURL = directory.appendingPathComponent("pixel-references.json")
        if FileManager.default.fileExists(atPath: manifestURL.path) {
            let bytes = try Self.read("pixel-references.json", directory: directory, maximumBytes: 200_000)
            let manifest = try JSONDecoder().decode(VisualReferenceManifest.self, from: bytes)
            let dimensions = decodedImages.mapValues { SIMD2($0.width, $0.height) }
            guard manifest.matches(decoded, imageDimensions: dimensions) else {
                throw VisionPipelineError.unavailable("Pixel reference manifest does not match this site, detector configuration or explicit surveyed plane frames.")
            }
            let pixelImages = try manifest.references.map { reference -> VisualReferenceImage in
                guard let image = decodedImages[reference.plane.id],
                      abs(reference.plane.widthMeters/reference.plane.heightMeters - Double(image.width)/Double(image.height)) < 0.001 else {
                    throw VisionPipelineError.unavailable("Pixel reference physical aspect ratio does not match its uncropped pixels.")
                }
                return VisualReferenceImage(plane: reference.plane, image: image)
            }
            pixelPipeline = VisualReferencePipeline(references: pixelImages)
            pixelValidationStatus = "Pixel localization is diagnostic; detector-specific field validation is missing."
            if FileManager.default.fileExists(atPath: directory.appendingPathComponent("pixel-validation.json").path) {
                let proofBytes = try Self.read("pixel-validation.json", directory: directory, maximumBytes: 2_000_000)
                let validation = try JSONDecoder().decode(VisualReferenceValidation.self, from: proofBytes)
                pixelEnvelopeCache = VisualReferenceEnvelopeCache(validation: validation, manifest: manifest,
                    manifestSHA256: VisualReferenceValidation.sha256(bytes), pack: pack, at: now,
                    deviceModel: Self.hardwareModel, imageDimensions: dimensions)
                pixelValidationStatus = pixelEnvelope(at: now) == nil
                    ? "Pixel field validation does not qualify this detector, site, date or phone."
                    : "Detector-specific pixel field evidence imported; live multi-reference consensus still required."
            }
        }
    }
    private static func read(_ name: String, directory: URL, maximumBytes: Int) throws -> Data {
        guard !name.isEmpty, name == URL(fileURLWithPath: name).lastPathComponent, !name.contains("..") else {
            throw VisionPipelineError.unavailable("Invalid site pack path.")
        }
        let root = directory.resolvingSymlinksInPath().standardizedFileURL
        let url = root.appendingPathComponent(name)
        guard url.resolvingSymlinksInPath().deletingLastPathComponent() == root,
              let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= maximumBytes else {
            throw VisionPipelineError.unavailable("Site pack file exceeds its size or path limit.")
        }
        return try Data(contentsOf: url)
    }
    private func resetPixels() {
        pixelEpoch = UUID(); pixelPipeline?.reset(); pixelProgress.reset(); pixelAssessment = nil
    }
    func reset() { acquisitionEpoch = UUID(); consensus.reset(); assessment = nil; siteFromWorld = nil; selectedValidUntil = nil; resetPixels() }
    private func pixelEnvelope(at now: Date) -> VisualReferenceEnvelope? {
        pixelEnvelopeCache?.current(at: now)
    }
    private func reject(at: Date, reason: String) {
        acquisitionEpoch = UUID()
        assessment = consensus.invalidate(at: at, reason: reason); siteFromWorld = nil; selectedValidUntil = nil; resetPixels()
    }
    func update(frame: ARFrame, now: Date, stopID: String?, coarseFix: CLLocation?) -> (area: LocalLandmarkPack.Area, pose: simd_float4x4)? {
        guard pack.isFieldReady(at: now, deviceModel: Self.hardwareModel), case .normal = frame.camera.trackingState,
              let fix = coarseFix, fix.horizontalAccuracy >= 0, fix.horizontalAccuracy <= 25,
              now.timeIntervalSince(fix.timestamp) >= 0, now.timeIntervalSince(fix.timestamp) < 10,
              CLLocation(latitude: pack.originLatitude, longitude: pack.originLongitude).distance(from: fix) < 300 else {
            reject(at: now, reason: "site_or_tracking_context_unavailable"); return nil
        }
        let k = frame.camera.intrinsics, size = frame.camera.imageResolution
        let calibration = SpatialCameraCalibration(width: Int(size.width), height: Int(size.height), fx: Double(k[0].x), fy: Double(k[1].y),
            cx: Double(k[2].x), cy: Double(k[2].y), imageOrientation: "raw_sensor")
        guard calibration.isValid else { reject(at: now, reason: "camera_calibration_invalid"); return nil }
        let age = ProcessInfo.processInfo.systemUptime - frame.timestamp
        guard age >= 0, age < 0.5 else { reject(at: now, reason: "camera_frame_stale_or_future"); return nil }
        let capturedAt = now.addingTimeInterval(-age)
        let visible = frame.anchors.compactMap { $0 as? ARImageAnchor }.filter(\.isTracked)
        let estimates: [LocalPoseReferenceEstimate] = visible.compactMap { anchor in
            guard let reference = pack.landmarks.first(where: { $0.id == anchor.referenceImage.name }),
                  let siteFromImage = LocalLandmarkGeometry.matrix(reference.siteFromImage),
                  simd_distance(LocalLandmarkGeometry.translation(anchor.transform), LocalLandmarkGeometry.translation(frame.camera.transform)) <= Float(pack.maximumViewDistanceMeters) else { return nil }
            return LocalPoseReferenceEstimate(landmarkID: reference.id, siteFromWorld: siteFromImage * simd_inverse(anchor.transform))
        }
        let result = consensus.update(estimates: estimates, worldFromCamera: frame.camera.transform, at: capturedAt, now: now,
            trackingNormal: true, errorBoundMeters: pack.measuredErrorBound, headingBoundDegrees: min(3, max(0.1, pack.validation?.maximumHeadingError ?? 0)),
            verticalErrorBoundMeters: pack.measuredVerticalErrorBound)
        let pixelBounds = updatePixels(frame: frame, calibration: calibration, capturedAt: capturedAt, now: now)
        var selected = result
        selectedValidUntil = pack.validityDeadline
        var horizontalBound = pack.measuredErrorBound
        var verticalBound = pack.measuredVerticalErrorBound
        if result.status != .reliable, let bounds = pixelBounds, let pixel = pixelAssessment,
           bounds.supports(pixel.referenceIDs), pixel.status == .reliable, let alignment = pixel.siteFromWorld,
           now.timeIntervalSince(pixel.at) >= 0, now.timeIntervalSince(pixel.at) < 0.5 {
            // Pixel estimates refer to the captured camera. Propagate only with the current
            // same-epoch VIO camera; never place the phone at a reference/object coordinate.
            selected = LocalPoseAssessment(status: pixel.status, reason: "validated_pixel_reference_consensus", at: pixel.at,
                siteFromWorld: alignment, siteFromCamera: alignment * frame.camera.transform,
                referenceIDs: pixel.referenceIDs, maximumTranslationDisagreement: pixel.maximumTranslationDisagreement,
                maximumAngleDisagreementDegrees: pixel.maximumAngleDisagreementDegrees)
            horizontalBound = bounds.horizontalMeters; verticalBound = bounds.verticalMeters
            selectedValidUntil = pack.validityDeadline.map { min($0, bounds.expiresAt) }
        }
        assessment = selected; siteFromWorld = selected.siteFromWorld
        guard selected.status == .reliable, let pose = selected.siteFromCamera else { return nil }
        let p = LocalLandmarkGeometry.translation(pose)
        guard let index = LocalLandmarkGeometry.boardingArea(camera: SIMD3(Double(p.x), Double(p.y), Double(p.z)),
            horizontalBound: horizontalBound, verticalBound: verticalBound,
            areas: pack.areas, stopID: stopID) else { return nil }
        return (pack.areas[index], pose)
    }
    private func updatePixels(frame: ARFrame, calibration: SpatialCameraCalibration, capturedAt: Date,
                              now: Date) -> VisualReferenceEnvelope? {
        guard let pipeline = pixelPipeline else { return nil }
        guard VisualReferencePipeline.thermalAcceptable else { resetPixels(); return nil }
        let envelope = pixelEnvelope(at: now)
        if let completed = pipeline.takeResult() {
            let context = completed.context
            guard context.usable(epoch: pixelEpoch, now: now, uptime: ProcessInfo.processInfo.systemUptime,
                                 trackingNormal: true, thermalAcceptable: true),
                  frame.timestamp >= context.uptime,
                  simd_distance(LocalLandmarkGeometry.translation(frame.camera.transform),
                                LocalLandmarkGeometry.translation(context.worldFromCamera)) < 2,
                  LocalPoseConsensus.angle(frame.camera.transform, context.worldFromCamera) < 30 else {
                resetPixels(); return nil
            }
            // Diagnostic bounds are explicitly provisional; they never activate geographic output.
            // Imported detector-specific measured bounds replace them only for qualified field packs.
            let distanceLimit = min(pack.maximumViewDistanceMeters, envelope?.maximumDistanceMeters ?? 15)
            let estimates = zip(completed.estimates, completed.matches).compactMap { estimate, match in
                match.pose.planeDistanceMeters <= distanceLimit ? estimate : nil
            }
            // Field eligibility requires the exact reference configuration covered by the proof.
            // Other configurations may remain diagnostic, but cannot inherit its measured bounds.
            let supported = envelope?.supports(estimates.map(\.landmarkID)) ?? false
            if envelope != nil && !supported {
                pixelProgress.reset()
            } else {
                pixelProgress.receive(estimates: estimates, worldFromCamera: frame.camera.transform,
                    at: context.capturedAt, now: now,
                    horizontal: supported ? envelope!.horizontalMeters : 0.3,
                    vertical: supported ? envelope!.verticalMeters : 0.2,
                    heading: supported ? envelope!.headingDegrees : 3)
            }
        }
        pixelAssessment = pixelProgress.fresh(at: now)
        // The native host creates ARWorldTrackingConfiguration with default .gravity alignment;
        // its +Y is measured up. Tracking is normal here. No image-plane normal is substituted.
        let context = VisualReferenceFrameContext(epoch: pixelEpoch, calibration: calibration,
            worldFromCamera: frame.camera.transform, capturedAt: capturedAt, uptime: frame.timestamp,
            orientation: "raw_sensor", worldUp: SIMD3(0, 1, 0), gravityReliable: true, crop: [0, 0, 1, 1])
        pipeline.submit(buffer: frame.capturedImage, context: context)
        return envelope
    }
}
