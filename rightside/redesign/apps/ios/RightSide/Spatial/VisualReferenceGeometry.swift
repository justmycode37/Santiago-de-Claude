import Foundation
import simd

/// Reference pixels are upright, top-left origin. The physical plane is centered XY,
/// X right, Y up, +Z out of the printed face. Pose is siteFromCamera, ARKit right/up/back.
/// This explicit surveyed plane frame is NOT inferred from an AR image-anchor transform.
struct VisualReferencePlane: Codable, Sendable {
    let id: String
    let widthMeters: Double
    let heightMeters: Double
    let siteFromPlane: [Double]
    var matrix: simd_double4x4? {
        guard !id.isEmpty, widthMeters.isFinite, heightMeters.isFinite,
              (0.05...20).contains(widthMeters), (0.05...20).contains(heightMeters),
              siteFromPlane.count == 16, siteFromPlane.allSatisfy(\.isFinite) else { return nil }
        let m = simd_double4x4(columns: (SIMD4(siteFromPlane[0..<4]), SIMD4(siteFromPlane[4..<8]),
                                       SIMD4(siteFromPlane[8..<12]), SIMD4(siteFromPlane[12..<16])))
        return CalibratedPoseGeometry.rigid(m) ? m : nil
    }
}

struct VisualReferencePose {
    let siteFromCamera: simd_double4x4
    let referenceToCameraPixels: simd_double3x3
    let metricResidualPixels: Double
    let planeDistanceMeters: Double
    let obliquityDegrees: Double
}

enum VisualReferenceGeometry {
    static func point(_ h: simd_double3x3, _ p: SIMD2<Double>) -> SIMD2<Double>? {
        let q = h * SIMD3(p.x, p.y, 1)
        guard q.x.isFinite, q.y.isFinite, q.z.isFinite, abs(q.z) > 1e-9 else { return nil }
        return SIMD2(q.x / q.z, q.y / q.z)
    }
    /// Recover pose from a measured homography, calibrated K and physical plane. No pose seed.
    /// Orthogonality/equal-scale/cheirality checks reject nonmetric fits; sign is fixed by positive depth.
    static func pose(h: simd_double3x3, referenceWidth: Int, referenceHeight: Int,
                     calibration k: SpatialCameraCalibration, plane: VisualReferencePlane) -> VisualReferencePose? {
        guard k.isValid, referenceWidth >= 64, referenceHeight >= 64, let site = plane.matrix,
              abs(simd_determinant(h)) > 1e-12 else { return nil }
        let pixelFromPlane = simd_double3x3(columns: (
            SIMD3(Double(referenceWidth) / plane.widthMeters, 0, 0),
            SIMD3(0, -Double(referenceHeight) / plane.heightMeters, 0),
            SIMD3(Double(referenceWidth) / 2, Double(referenceHeight) / 2, 1)))
        let intrinsics = simd_double3x3(columns: (SIMD3(k.fx, 0, 0), SIMD3(0, k.fy, 0), SIMD3(k.cx, k.cy, 1)))
        let b = simd_inverse(intrinsics) * h * pixelFromPlane
        let n1 = simd_length(b[0]), n2 = simd_length(b[1])
        guard n1.isFinite, n2.isFinite, min(n1, n2) > 1e-9,
              abs(n1 - n2) / max(n1, n2) < 0.08,
              abs(simd_dot(b[0], b[1]) / (n1 * n2)) < 0.08 else { return nil }
        let scale = (b[2].z >= 0 ? 1.0 : -1.0) * 2 / (n1 + n2)
        let r1 = simd_normalize(b[0] * scale)
        let provisional = b[1] * scale
        let r2 = simd_normalize(provisional - r1 * simd_dot(r1, provisional))
        let r3 = simd_cross(r1, r2), t = b[2] * scale
        let cvFromPlane = simd_double4x4(columns: (SIMD4(r1, 0), SIMD4(r2, 0), SIMD4(r3, 0), SIMD4(t, 1)))
        let cvFromAR = simd_double4x4(diagonal: SIMD4(1, -1, -1, 1))
        let planeFromCamera = simd_inverse(cvFromPlane) * cvFromAR
        let camera = SIMD3(planeFromCamera[3].x, planeFromCamera[3].y, planeFromCamera[3].z)
        let distance = simd_length(camera)
        guard CalibratedPoseGeometry.rigid(planeFromCamera), camera.z > 0.05,
              distance <= 20, distance >= 0.1 else { return nil }
        let obliquity = acos(min(1, max(-1, camera.z / distance))) * 180 / .pi
        guard obliquity < 65 else { return nil }
        var residual = 0.0
        for y in [0.0, 0.5, 1.0] { for x in [0.0, 0.5, 1.0] {
            let p = SIMD3((x - 0.5) * plane.widthMeters, (0.5 - y) * plane.heightMeters, 0)
            let q = cvFromPlane * SIMD4(p, 1)
            guard q.z > 0.05, let expected = point(h, SIMD2(x * Double(referenceWidth), y * Double(referenceHeight))) else { return nil }
            let actual = SIMD2(k.fx * q.x / q.z + k.cx, k.fy * q.y / q.z + k.cy)
            residual = max(residual, simd_distance(actual, expected))
        } }
        guard residual.isFinite, residual <= 3 else { return nil }
        return .init(siteFromCamera: site * planeFromCamera, referenceToCameraPixels: h,
                     metricResidualPixels: residual, planeDistanceMeters: distance, obliquityDegrees: obliquity)
    }
}
