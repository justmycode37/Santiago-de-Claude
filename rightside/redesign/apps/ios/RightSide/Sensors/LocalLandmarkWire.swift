import Foundation
import CoreLocation
import simd

enum LocalLandmarkWire {
    static func observation(pack: LocalLandmarkPack, pose: simd_float4x4, sessionID: UUID, at: Date) -> JSONValue {
        let matrix = (0..<4).flatMap { column in (0..<4).map { Double(pose[column][$0]) } }
        let stamp = PackClock.string(at)
        return .object([
            "siteId": .string(pack.siteID), "mapVersion": .string(pack.version), "sessionId": .string(sessionID.uuidString),
            "frameId": .string(UUID().uuidString), "capturedAt": .string(stamp),
            "transform": .object(["convention": .string("T_site_camera"), "storage": .string("column_major"),
                "units": .string("meters"), "siteAxes": .string("ENU"), "cameraAxes": .string("x_right_y_up_z_back"),
                "matrix": .array(matrix.map(JSONValue.number))]),
            "method": .string("measured_landmark"), "uncertaintyMeters": .number(pack.measuredErrorBound),
            "uncertaintyBasis": .string("independent_checkpoints"), "candidatePlaceIds": .array([]),
            "status": .string("accepted"), "reason": .string("two_surveyed_references_and_device_checkpoint_envelope"),
            "evidence": .array([.object(["source": .string(pack.source), "sourceVersion": .string(pack.version),
                "fetchedAt": .string(pack.surveyedAt), "observedAt": .string(stamp), "validUntil": .string(pack.expiresAt),
                "kind": .string("observed"), "quality": .string("supported")])])
        ])
    }
    /// Short-range WGS84 tangent conversion. Survey error includes the origin/control-point error.
    static func coordinate(pack: LocalLandmarkPack, pose: simd_float4x4) -> CLLocationCoordinate2D? {
        let p = LocalLandmarkGeometry.translation(pose)
        guard abs(p.x) <= 300, abs(p.y) <= 300, abs(pack.originLatitude) < 85 else { return nil }
        let latitude = pack.originLatitude * .pi / 180, eccentricitySquared = 6.69437999014e-3
        let denominator = 1 - eccentricitySquared * pow(sin(latitude),2)
        let n = 6378137 / sqrt(denominator), m = 6378137 * (1-eccentricitySquared) / pow(denominator,1.5)
        let coordinate = CLLocationCoordinate2D(latitude: pack.originLatitude + Double(p.y)/m*180 / .pi,
                                              longitude: pack.originLongitude + Double(p.x)/(n*cos(latitude))*180 / .pi)
        return CLLocationCoordinate2DIsValid(coordinate) ? coordinate : nil
    }
}
