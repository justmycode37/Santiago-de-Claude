import Foundation
import simd

/// Survey coordinates: east, north, up in metres; camera axes: right, up, back.
/// A reference-image detector supplies the 2D–3D planar pose; this composes it into the surveyed site.
enum LocalLandmarkGeometry {
    static func matrix(_ values: [Float]) -> simd_float4x4? {
        guard values.count == 16, values.allSatisfy(\.isFinite) else { return nil }
        let m = simd_float4x4(columns: (SIMD4(values[0], values[1], values[2], values[3]),
                                      SIMD4(values[4], values[5], values[6], values[7]),
                                      SIMD4(values[8], values[9], values[10], values[11]),
                                      SIMD4(values[12], values[13], values[14], values[15])))
        let x = SIMD3(m.columns.0.x, m.columns.0.y, m.columns.0.z)
        let y = SIMD3(m.columns.1.x, m.columns.1.y, m.columns.1.z)
        let z = SIMD3(m.columns.2.x, m.columns.2.y, m.columns.2.z)
        guard abs(simd_length(x) - 1) < 0.001, abs(simd_length(y) - 1) < 0.001, abs(simd_length(z) - 1) < 0.001,
              abs(simd_dot(x, y)) < 0.001, abs(simd_dot(x, z)) < 0.001, abs(simd_dot(y, z)) < 0.001,
              simd_dot(simd_cross(x, y), z) > 0.999,
              abs(m.columns.0.w) < 0.0001, abs(m.columns.1.w) < 0.0001, abs(m.columns.2.w) < 0.0001,
              abs(m.columns.3.w - 1) < 0.0001 else { return nil }
        return m
    }
    static func cameraPose(siteFromImage: simd_float4x4, worldFromImage: simd_float4x4, worldFromCamera: simd_float4x4) -> simd_float4x4 {
        siteFromImage * simd_inverse(worldFromImage) * worldFromCamera
    }
    static func translation(_ m: simd_float4x4) -> SIMD3<Float> { SIMD3(m.columns.3.x, m.columns.3.y, m.columns.3.z) }
    static func orientationsAgree(_ a: simd_float4x4, _ b: simd_float4x4) -> Bool {
        // Check all axes: agreement of the normal alone misses rotation around that normal.
        (0..<3).allSatisfy { simd_dot(a[$0], b[$0]) > 0.999 }
    }
    static func boundaryDistance(_ p: SIMD2<Double>, polygon: [SIMD2<Double>]) -> Double {
        guard polygon.count >= 3 else { return 0 }
        return polygon.indices.map { i in
            let a = polygon[i], b = polygon[(i + 1) % polygon.count], v = b - a
            let t = max(0, min(1, simd_dot(p - a, v) / max(1e-12, simd_length_squared(v))))
            return simd_distance(p, a + t * v)
        }.min() ?? 0
    }
    static func contains(_ point: SIMD2<Double>, polygon: [SIMD2<Double>]) -> Bool {
        guard polygon.count >= 3 else { return false }
        var inside = false
        for i in polygon.indices {
            let a = polygon[i], b = polygon[(i + 1) % polygon.count]
            if (a.y > point.y) != (b.y > point.y), point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x { inside.toggle() }
        }
        return inside
    }
    static func isStrictlyConvex(_ polygon: [SIMD2<Double>]) -> Bool {
        guard polygon.count >= 3 else { return false }
        var signs = Set<Int>()
        for i in polygon.indices {
            let a = polygon[i], b = polygon[(i + 1) % polygon.count]
            guard simd_distance(a, b) > 0.01 else { return false }
            // Every other vertex must be strictly on the same side of every edge.
            for j in polygon.indices where j != i && j != (i + 1) % polygon.count {
                let c = polygon[j], cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
                guard cross.isFinite, abs(cross) > 0.0001 else { return false }
                signs.insert(cross > 0 ? 1 : -1)
            }
        }
        return signs.count == 1
    }
    static func uniqueArea(point: SIMD2<Double>, uncertainty: Double, areas: [[SIMD2<Double>]], margin: Double = 0.75) -> Int? {
        guard point.x.isFinite, point.y.isFinite, uncertainty.isFinite, uncertainty > 0, uncertainty <= 1,
              margin.isFinite, margin >= 0 else { return nil }
        // Any competing area intersecting the uncertainty disk invalidates the selection.
        let possible = areas.indices.filter { contains(point, polygon: areas[$0]) || boundaryDistance(point, polygon: areas[$0]) <= uncertainty }
        guard possible.count == 1, let index = possible.first, contains(point, polygon: areas[index]),
              boundaryDistance(point, polygon: areas[index]) > uncertainty + margin else { return nil }
        return index
    }
    static func boardingArea(camera: SIMD3<Double>, horizontalBound: Double, verticalBound: Double,
                             areas: [LocalLandmarkPack.Area], stopID: String?) -> Int? {
        guard camera.z.isFinite, verticalBound.isFinite, verticalBound > 0, verticalBound <= 0.5,
              let stopID, !stopID.isEmpty,
              let index = uniqueArea(point: SIMD2(camera.x, camera.y), uncertainty: horizontalBound,
                                     areas: areas.map(\.polygon)),
              areas[index].stopID == stopID,
              camera.z - areas[index].floorHeightMeters - verticalBound >= 0.4,
              camera.z - areas[index].floorHeightMeters + verticalBound <= 2.5 else { return nil }
        return index
    }
}

struct LocalLandmarkPack: Decodable {
    struct Landmark: Decodable, Equatable {
        let id: String
        let imageFile: String
        let imageSHA256: String
        let physicalWidthMeters: Double
        let siteFromImage: [Float]
        let uniqueAtSite: Bool
    }
    struct Area: Decodable, Equatable {
        let id: String
        let stopID: String
        let label: String
        let level: String
        let floorHeightMeters: Double
        let polygonENU: [[Double]]
        let surveyedClearanceMeters: Double
        var polygon: [SIMD2<Double>] { polygonENU.filter { $0.count == 2 }.map { SIMD2($0[0], $0[1]) } }
    }
    private static func date(_ value: String) -> Date? {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    let schemaVersion: Int
    let siteID: String
    let version: String
    let source: String
    let license: String
    let surveyedAt: String
    let expiresAt: String
    var validityDeadline: Date? { Self.date(expiresAt) }
    let originLatitude: Double
    let originLongitude: Double
    let landmarkSurveyErrorMeters: Double
    let checkpointErrorsMeters: [Double]
    let validationDeviceModels: [String]
    let maximumViewDistanceMeters: Double
    let landmarks: [Landmark]
    let areas: [Area]
    var validation: LocalLandmarkValidation? = nil
    /// Structural legacy pack checks remain available for migration/tests. Native activation
    /// additionally requires explicit independent field-checkpoint provenance (schema 2).
    func isFieldReady(at: Date, deviceModel: String) -> Bool {
        isValid(at: at, deviceModel: deviceModel) && schemaVersion == 2
        && validation?.isFieldEvidence == true
        && validation?.independentCheckpointCount == checkpointErrorsMeters.count
        && measuredVerticalErrorBound <= 0.5
    }
    var measuredVerticalErrorBound: Double { (validation?.maximumVerticalError ?? .infinity) + landmarkSurveyErrorMeters }
    /// Conservative observed error bound + survey error; NOT a statistical coverage guarantee.
    var measuredErrorBound: Double { (checkpointErrorsMeters.max() ?? .infinity) + landmarkSurveyErrorMeters }
    func isValid(at: Date, deviceModel: String) -> Bool {
        guard (schemaVersion == 1 || schemaVersion == 2), !siteID.isEmpty, !version.isEmpty, !source.isEmpty, !license.isEmpty,
              let surveyed = Self.date(surveyedAt), let expiry = Self.date(expiresAt), surveyed <= at, expiry >= at,
              abs(originLatitude) <= 90, abs(originLongitude) <= 180,
              landmarkSurveyErrorMeters.isFinite, landmarkSurveyErrorMeters > 0,
              checkpointErrorsMeters.count >= 20, checkpointErrorsMeters.allSatisfy({ $0.isFinite && $0 >= 0 }),
              measuredErrorBound <= 1, validationDeviceModels.contains(deviceModel),
              maximumViewDistanceMeters.isFinite, maximumViewDistanceMeters > 0, maximumViewDistanceMeters <= 15,
              (2...8).contains(landmarks.count), (0...30).contains(areas.count),
              Set(landmarks.map(\.id)).count == landmarks.count,
              Set(areas.map(\.id)).count == areas.count else { return false }
        return landmarks.allSatisfy {
            $0.uniqueAtSite && !$0.id.isEmpty && $0.physicalWidthMeters.isFinite && (0.1...5).contains($0.physicalWidthMeters)
            && LocalLandmarkGeometry.matrix($0.siteFromImage) != nil
        } && areas.allSatisfy {
            !$0.stopID.isEmpty && !$0.level.isEmpty && $0.floorHeightMeters.isFinite && $0.surveyedClearanceMeters.isFinite && $0.surveyedClearanceMeters >= 0.75
            && (3...100).contains($0.polygonENU.count)
            && $0.polygonENU.allSatisfy({ $0.count == 2 && $0.allSatisfy({ $0.isFinite && abs($0) <= 300 }) })
            && LocalLandmarkGeometry.isStrictlyConvex($0.polygon)
        }
    }
}


struct LocalLandmarkValidation: Decodable {
    let evidenceKind: String
    let checkpointDatasetSHA256: String
    let referenceSurveySHA256: String
    let independentCheckpointCount: Int
    let headingErrorsDegrees: [Double]
    let registrationErrorsPixels: [Double]
    let referenceFrame: String
    let cameraCalibration: String
    var verticalErrorsMeters: [Double]? = nil
    var maximumVerticalError: Double { verticalErrorsMeters?.max() ?? .infinity }
    var maximumHeadingError: Double { headingErrorsDegrees.max() ?? .infinity }
    private static func isSHA256(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    var isFieldEvidence: Bool {
        evidenceKind == "independent_field_checkpoints" && referenceFrame == "ENU_meters_camera_right_up_back"
        && cameraCalibration == "ARKit_per_frame_intrinsics"
        && Self.isSHA256(checkpointDatasetSHA256) && Self.isSHA256(referenceSurveySHA256)
        && checkpointDatasetSHA256 != referenceSurveySHA256 && independentCheckpointCount >= 20
        && headingErrorsDegrees.count >= independentCheckpointCount && registrationErrorsPixels.count >= independentCheckpointCount
        && headingErrorsDegrees.allSatisfy { $0.isFinite && $0 >= 0 && $0 <= 3 }
        && registrationErrorsPixels.allSatisfy { $0.isFinite && $0 >= 0 && $0 <= 8 }
        && verticalErrorsMeters?.count == independentCheckpointCount
        && verticalErrorsMeters?.allSatisfy { $0.isFinite && $0 >= 0 && $0 <= 0.5 } == true
    }
}


/// Integrity of the actual held-out record file, beyond self-reported aggregate metadata.
struct LocalLandmarkCheckpointEvidence: Decodable {
    struct Checkpoint: Decodable {
        let id: String
        let truthCameraENU: [Double]
        let estimatedCameraENU: [Double]
        let truthHeadingDegrees: Double
        let estimatedHeadingDegrees: Double
        let heldOutRegistrationErrorPixels: Double
    }
    let evidenceKind: String
    let referenceSurveySHA256: String
    let usedForReferenceFitting: Bool
    let checkpoints: [Checkpoint]
    func validates(_ pack: LocalLandmarkPack) -> Bool {
        guard let validation = pack.validation, !usedForReferenceFitting,
              evidenceKind == validation.evidenceKind,
              referenceSurveySHA256 == validation.referenceSurveySHA256,
              checkpoints.count == validation.independentCheckpointCount,
              Set(checkpoints.map(\.id)).count == checkpoints.count,
              pack.checkpointErrorsMeters.count == checkpoints.count,
              validation.headingErrorsDegrees.count == checkpoints.count,
              validation.registrationErrorsPixels.count == checkpoints.count,
              validation.verticalErrorsMeters?.count == checkpoints.count else { return false }
        for (index, point) in checkpoints.enumerated() {
            guard !point.id.isEmpty, point.truthCameraENU.count == 3, point.estimatedCameraENU.count == 3,
                  (point.truthCameraENU + point.estimatedCameraENU + [point.truthHeadingDegrees, point.estimatedHeadingDegrees, point.heldOutRegistrationErrorPixels]).allSatisfy(\.isFinite) else { return false }
            let horizontal = hypot(point.truthCameraENU[0] - point.estimatedCameraENU[0], point.truthCameraENU[1] - point.estimatedCameraENU[1])
            let vertical = abs(point.truthCameraENU[2] - point.estimatedCameraENU[2])
            let difference = (point.truthHeadingDegrees - point.estimatedHeadingDegrees) * .pi / 180
            let heading = abs(atan2(sin(difference), cos(difference))) * 180 / .pi
            guard abs(horizontal - pack.checkpointErrorsMeters[index]) < 1e-6,
                  abs(vertical - validation.verticalErrorsMeters![index]) < 1e-6,
                  abs(heading - validation.headingErrorsDegrees[index]) < 1e-6,
                  point.heldOutRegistrationErrorPixels >= 0,
                  abs(point.heldOutRegistrationErrorPixels - validation.registrationErrorsPixels[index]) < 1e-6 else { return false }
        }
        return true
    }
}


struct LocalLandmarkSurveyEvidence: Decodable {
    let siteID: String; let version: String; let source: String; let license: String
    let surveyedAt: String; let expiresAt: String
    let originLatitude: Double; let originLongitude: Double; let landmarkSurveyErrorMeters: Double
    let validationDeviceModels: [String]; let maximumViewDistanceMeters: Double
    let landmarks: [LocalLandmarkPack.Landmark]; let areas: [LocalLandmarkPack.Area]
    func validates(_ pack: LocalLandmarkPack) -> Bool {
        siteID == pack.siteID && version == pack.version && source == pack.source && license == pack.license
        && surveyedAt == pack.surveyedAt && expiresAt == pack.expiresAt
        && originLatitude == pack.originLatitude && originLongitude == pack.originLongitude
        && landmarkSurveyErrorMeters == pack.landmarkSurveyErrorMeters
        && validationDeviceModels == pack.validationDeviceModels && maximumViewDistanceMeters == pack.maximumViewDistanceMeters
        && landmarks == pack.landmarks && areas == pack.areas
    }
}
