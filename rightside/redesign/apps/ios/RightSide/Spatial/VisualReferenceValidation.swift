import Foundation
import CryptoKit
import simd

struct VisualReferenceManifest: Codable {
    struct Reference: Codable {
        let imageSHA256: String
        let plane: VisualReferencePlane
    }
    let schemaVersion: Int
    let siteID: String
    let siteVersion: String
    let detectorConfiguration: String
    let planeConvention: String
    let references: [Reference]
    /// Apple's ARImageAnchor is XZ; an upright XY image plane is rotated -pi/2 around X.
    /// https://developer.apple.com/documentation/arkit/detecting-images-in-an-ar-experience
    static let imageAnchorFromPlane = simd_double4x4(columns:(
        SIMD4(1,0,0,0),SIMD4(0,0,-1,0),SIMD4(0,1,0,0),SIMD4(0,0,0,1)))
    func matches(_ pack: LocalLandmarkPack, imageDimensions:[String:SIMD2<Int>]) -> Bool {
        schemaVersion == 1 && siteID == pack.siteID && siteVersion == pack.version
        && detectorConfiguration == VisualReferenceMatcher.configurationID
        && planeConvention == "centered_X_right_Y_up_Z_out_meters"
        && (2...8).contains(references.count)
        && Set(references.map { $0.plane.id }).count == references.count
        && references.allSatisfy { ref in
            guard let original=pack.landmarks.first(where:{$0.id == ref.plane.id}),
                  let declared=ref.plane.matrix,let surveyed=LocalLandmarkGeometry.matrix(original.siteFromImage),
                  let dimensions=imageDimensions[ref.plane.id],dimensions.x>=64,dimensions.y>=64 else {return false}
            let survey=simd_double4x4(columns:(SIMD4<Double>(surveyed[0]),SIMD4<Double>(surveyed[1]),SIMD4<Double>(surveyed[2]),SIMD4<Double>(surveyed[3])))
            let expected=survey*Self.imageAnchorFromPlane
            let framesAgree=(0..<4).allSatisfy { c in (0..<4).allSatisfy { abs(expected[c][$0]-declared[c][$0]) <= 1e-4 } }
            return framesAgree && original.imageSHA256 == ref.imageSHA256
                && abs(ref.plane.widthMeters-original.physicalWidthMeters) < 1e-6
                && abs(ref.plane.heightMeters-original.physicalWidthMeters*Double(dimensions.y)/Double(dimensions.x)) < 1e-6
        }
    }
}
struct VisualReferenceEnvelope {
    let horizontalMeters: Double
    let verticalMeters: Double
    let headingDegrees: Double
    let maximumDistanceMeters: Double
    let referenceIDs: Set<String>
    let expiresAt: Date
    func supports(_ ids: [String]) -> Bool {
        ids.count == referenceIDs.count && Set(ids) == referenceIDs
    }
}

/// Constructed only after complete immutable evidence validation. Runtime use still checks
/// the proof's dates; LocalLandmarkSession separately retains all live pack/context checks.
struct VisualReferenceEnvelopeCache {
    private let value: VisualReferenceEnvelope
    private let validFrom: Date
    private let expiresAt: Date
    init?(validation: VisualReferenceValidation, manifest: VisualReferenceManifest,
          manifestSHA256: String, pack: LocalLandmarkPack, at now: Date,
          deviceModel: String, imageDimensions: [String: SIMD2<Int>]) {
        guard let value = validation.envelope(manifest: manifest, manifestSHA256: manifestSHA256,
            pack: pack, at: now, deviceModel: deviceModel, imageDimensions: imageDimensions),
            let start = ISO8601DateFormatter().date(from: validation.validatedAt),
            let end = ISO8601DateFormatter().date(from: validation.expiresAt) else { return nil }
        self.value = value; validFrom = start; expiresAt = end
    }
    func current(at now: Date) -> VisualReferenceEnvelope? {
        guard now >= validFrom, now < expiresAt else { return nil }
        return value
    }
}
/// This is an auditable imported evidence contract, not certification that its author surveyed
/// reality. It deliberately cannot inherit ARKit anchor validation and does not accept synthetic evidence.
struct VisualReferenceValidation: Codable {
    struct Checkpoint: Codable {
        let encounterID: String
        let captureSHA256: String
        let capturedAt: String
        let referenceIDs: [String]
        let truthSiteFromCamera: [Double]
        let estimatedSiteFromCamera: [Double]
        let heldOutRegistrationErrorPixels: Double
        let usedForReferenceFitting: Bool
    }
    struct Negative: Codable {
        let encounterID: String
        let captureSHA256: String
        let acceptedReferenceIDs: [String]
        let condition: String
    }
    let schemaVersion: Int
    let evidenceKind: String
    let detectorConfiguration: String
    let referenceManifestSHA256: String
    let referenceSurveySHA256: String
    let siteID: String
    let siteVersion: String
    let calibrationContract: String
    let runtimeOSVersion: String
    let deviceModels: [String]
    let validatedAt: String
    let expiresAt: String
    let attemptedPositiveEncounters: Int
    let surveyErrorMeters: Double
    let maximumDistanceMeters: Double
    let checkpoints: [Checkpoint]
    let negatives: [Negative]
    static func sha256(_ bytes: Data) -> String { SHA256.hash(data:bytes).map{String(format:"%02x",$0)}.joined() }
    static func isHash(_ value:String)->Bool { value.count == 64 && value.allSatisfy { "0123456789abcdef".contains($0) } }
    private static func matrix(_ values:[Double])->simd_double4x4? {
        guard values.count == 16,values.allSatisfy(\.isFinite) else {return nil}
        let m=simd_double4x4(columns:(SIMD4(values[0..<4]),SIMD4(values[4..<8]),SIMD4(values[8..<12]),SIMD4(values[12..<16])))
        return CalibratedPoseGeometry.rigid(m) ? m : nil
    }
    func envelope(manifest: VisualReferenceManifest, manifestSHA256: String, pack: LocalLandmarkPack,
                  at now: Date, deviceModel: String, imageDimensions:[String:SIMD2<Int>]) -> VisualReferenceEnvelope? {
        let iso=ISO8601DateFormatter()
        guard pack.isFieldReady(at:now,deviceModel:deviceModel), schemaVersion == 1, evidenceKind == "independent_field_pixel_checkpoints",
              detectorConfiguration == VisualReferenceMatcher.configurationID,
              manifest.detectorConfiguration == detectorConfiguration, manifest.matches(pack,imageDimensions:imageDimensions),
              Self.isHash(referenceManifestSHA256), referenceManifestSHA256 == manifestSHA256,
              Self.isHash(referenceSurveySHA256), referenceSurveySHA256 == pack.validation?.referenceSurveySHA256,
              siteID == pack.siteID,siteVersion == pack.version,
              calibrationContract == "ARKit_per_frame_intrinsics_raw_sensor_uncropped",
              runtimeOSVersion == ProcessInfo.processInfo.operatingSystemVersionString,
              deviceModels.contains(deviceModel),let validated=iso.date(from:validatedAt),let expiry=iso.date(from:expiresAt),
              validated <= now, now < expiry, expiry > validated, expiry.timeIntervalSince(validated) <= 180*86400,
              checkpoints.count >= 20, checkpoints.count <= 2000,
              attemptedPositiveEncounters >= checkpoints.count, attemptedPositiveEncounters <= 4000,
              Double(checkpoints.count)/Double(attemptedPositiveEncounters) >= 0.5,
              surveyErrorMeters.isFinite,(0.001...0.25).contains(surveyErrorMeters),
              surveyErrorMeters >= pack.landmarkSurveyErrorMeters,
              maximumDistanceMeters.isFinite,(0.1...15).contains(maximumDistanceMeters),
              negatives.count >= 20, negatives.count <= 2000 else { return nil }
        let allIDs=checkpoints.map(\.encounterID)+negatives.map(\.encounterID)
        let hashes=checkpoints.map(\.captureSHA256)+negatives.map(\.captureSHA256)
        guard Set(allIDs).count == allIDs.count,allIDs.allSatisfy({!$0.isEmpty}),
              Set(hashes).count == hashes.count,hashes.allSatisfy(Self.isHash),
              negatives.allSatisfy({$0.acceptedReferenceIDs.isEmpty}),
              Set(negatives.map(\.condition)).isSuperset(of:["mismatched_reference","repeated_texture","blur","occlusion"]) else { return nil }
        let validIDs=Set(manifest.references.map{$0.plane.id})
        var horizontal=0.0,vertical=0.0,angle=0.0,observedMaximumDistance=0.0
        for checkpoint in checkpoints {
            guard !checkpoint.usedForReferenceFitting,let at=iso.date(from:checkpoint.capturedAt),at <= validated,
                  validated.timeIntervalSince(at) <= 180*86400,
                  Set(checkpoint.referenceIDs).count >= 2,
                  Set(checkpoint.referenceIDs).count == checkpoint.referenceIDs.count,
                  Set(checkpoint.referenceIDs) == validIDs,
                  let truth=Self.matrix(checkpoint.truthSiteFromCamera),let estimate=Self.matrix(checkpoint.estimatedSiteFromCamera),
                  checkpoint.heldOutRegistrationErrorPixels.isFinite,(0...8).contains(checkpoint.heldOutRegistrationErrorPixels) else {return nil}
            for id in checkpoint.referenceIDs {
                guard let plane=manifest.references.first(where:{$0.plane.id == id})?.plane.matrix else {return nil}
                for pose in [truth,estimate] {
                    let camera=simd_inverse(plane)*pose[3]
                    let distance=simd_length(SIMD3(camera.x,camera.y,camera.z))
                    guard camera.z>0.05,distance.isFinite,distance>=0.1,distance<=maximumDistanceMeters else {return nil}
                    observedMaximumDistance=max(observedMaximumDistance,distance)
                }
            }
            let delta=estimate[3]-truth[3]
            horizontal=max(horizontal,simd_length(SIMD2(delta.x,delta.y)))
            vertical=max(vertical,abs(delta.z))
            let truthRotation=simd_double3x3(columns:(SIMD3(truth[0].x,truth[0].y,truth[0].z),SIMD3(truth[1].x,truth[1].y,truth[1].z),SIMD3(truth[2].x,truth[2].y,truth[2].z)))
            let estimateRotation=simd_double3x3(columns:(SIMD3(estimate[0].x,estimate[0].y,estimate[0].z),SIMD3(estimate[1].x,estimate[1].y,estimate[1].z),SIMD3(estimate[2].x,estimate[2].y,estimate[2].z)))
            let rotation=simd_transpose(truthRotation)*estimateRotation
            angle=max(angle,acos(max(-1,min(1,(rotation[0].x+rotation[1].y+rotation[2].z-1)/2)))*180 / .pi)
        }
        horizontal += surveyErrorMeters;vertical += surveyErrorMeters
        guard horizontal <= min(1,pack.measuredErrorBound), vertical <= min(0.5,pack.measuredVerticalErrorBound),
              angle <= min(3,pack.validation?.maximumHeadingError ?? 0) else {return nil}
        return .init(horizontalMeters:max(0.01,horizontal),verticalMeters:max(0.01,vertical),
                     headingDegrees:max(0.1,angle),maximumDistanceMeters:min(maximumDistanceMeters,observedMaximumDistance+surveyErrorMeters),
                     referenceIDs: validIDs, expiresAt: expiry)
    }
}
