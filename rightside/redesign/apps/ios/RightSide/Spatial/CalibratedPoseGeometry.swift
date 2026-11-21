import Foundation
import simd

/// Upright RAW sensor pixel coordinates: x right, y down. Pose: T_site_camera,
/// site ENU metres, camera x right/y up/z back (ARKit). No image-resize guesses.
struct SpatialCameraCalibration: Codable {
    let width: Int
    let height: Int
    let fx: Double
    let fy: Double
    let cx: Double
    let cy: Double
    let imageOrientation: String
    var isValid: Bool {
        (64...12000).contains(width) && (64...12000).contains(height)
        && [fx, fy, cx, cy].allSatisfy(\.isFinite) && fx > 0 && fy > 0
        && cx >= 0 && cx <= Double(width) && cy >= 0 && cy <= Double(height)
        && imageOrientation == "raw_sensor"
    }
}
struct SpatialImageCorrespondence {
    let landmarkID: String
    let sitePoint: SIMD3<Double>
    let pixel: SIMD2<Double>
}
struct SpatialPoseFit {
    let siteFromCamera: simd_double4x4
    let inlierIndices: [Int]
    let rmsReprojectionPixels: Double
    let maximumReprojectionPixels: Double
    let iterations: Int
}

/// Small calibrated geometric optimizer. Pixel matches must come from measured observations,
/// never projected from the starting pose. ARKit image detection remains the native detector.
enum CalibratedPoseGeometry {
    static func project(_ point: SIMD3<Double>, siteFromCamera: simd_double4x4, calibration k: SpatialCameraCalibration) -> SIMD2<Double>? {
        guard k.isValid else { return nil }
        let camera = simd_inverse(siteFromCamera) * SIMD4(point, 1)
        guard camera.z < -0.05, camera.x.isFinite, camera.y.isFinite, camera.z.isFinite else { return nil }
        return SIMD2(k.fx * camera.x / -camera.z + k.cx, k.cy - k.fy * camera.y / -camera.z)
    }
    static func rigid(_ matrix: simd_double4x4) -> Bool {
        let values = (0..<4).flatMap { c in (0..<4).map { matrix[c][$0] } }
        guard values.allSatisfy(\.isFinite), abs(matrix[0].w) < 1e-8, abs(matrix[1].w) < 1e-8, abs(matrix[2].w) < 1e-8, abs(matrix[3].w - 1) < 1e-8 else { return false }
        let r = simd_double3x3(columns: (SIMD3(matrix[0].x,matrix[0].y,matrix[0].z), SIMD3(matrix[1].x,matrix[1].y,matrix[1].z), SIMD3(matrix[2].x,matrix[2].y,matrix[2].z)))
        return abs(simd_determinant(r) - 1) < 1e-5 && (0..<3).allSatisfy { abs(simd_length(r[$0]) - 1) < 1e-5 }
            && abs(simd_dot(r[0],r[1])) < 1e-5 && abs(simd_dot(r[0],r[2])) < 1e-5 && abs(simd_dot(r[1],r[2])) < 1e-5
    }
    static func perturbed(_ pose: simd_double4x4, delta: [Double]) -> simd_double4x4 {
        let v = SIMD3(delta[3],delta[4],delta[5]), angle = simd_length(v)
        let rotation = angle > 1e-14 ? simd_double3x3(simd_quatd(angle: angle, axis: v / angle)) : matrix_identity_double3x3
        var increment = matrix_identity_double4x4
        for c in 0..<3 { increment[c] = SIMD4(rotation[c],0) }
        increment[3] = SIMD4(delta[0],delta[1],delta[2],1)
        return pose * increment
    }
    static func refine(initial: simd_double4x4, observations: [SpatialImageCorrespondence], calibration k: SpatialCameraCalibration) -> SpatialPoseFit? {
        guard k.isValid, rigid(initial), (8...500).contains(observations.count), Set(observations.map(\.landmarkID)).count >= 2,
              observations.allSatisfy({ !$0.landmarkID.isEmpty && [$0.sitePoint.x,$0.sitePoint.y,$0.sitePoint.z,$0.pixel.x,$0.pixel.y].allSatisfy(\.isFinite)
                  && $0.pixel.x >= 0 && $0.pixel.x < Double(k.width) && $0.pixel.y >= 0 && $0.pixel.y < Double(k.height) }) else { return nil }
        // Reject single-line/near-identical geometry before optimization.
        let center = observations.reduce(SIMD3<Double>.zero) { $0 + $1.sitePoint } / Double(observations.count)
        let spread = observations.map { $0.sitePoint - center }
        guard spread.contains(where: { a in spread.contains { simd_length(simd_cross(a,$0)) > 0.1 } }) else { return nil }
        var pose = initial, usedIterations = 0
        for iteration in 0..<30 {
            var h = Array(repeating: Array(repeating: 0.0,count:6),count:6), g = Array(repeating:0.0,count:6)
            var used = 0
            for o in observations {
                guard let predicted = project(o.sitePoint,siteFromCamera:pose,calibration:k) else { continue }
                let residual = predicted - o.pixel, norm = simd_length(residual)
                // Huber robust loss; gross pixel errors cannot dominate the fit.
                let weight = min(1, 2.0 / max(norm,1e-12))
                var jacobian = [SIMD2<Double>]()
                for axis in 0..<6 {
                    var delta = Array(repeating:0.0,count:6);delta[axis] = 1e-5
                    guard let shifted = project(o.sitePoint,siteFromCamera:perturbed(pose,delta:delta),calibration:k) else { return nil }
                    jacobian.append((shifted - predicted) / 1e-5)
                }
                for a in 0..<6 {
                    g[a] += weight * simd_dot(jacobian[a],residual)
                    for b in 0..<6 { h[a][b] += weight * simd_dot(jacobian[a],jacobian[b]) }
                }
                used += 1
            }
            guard used >= 8, let step = solve(h,g.map { -$0 }), step.allSatisfy(\.isFinite) else { return nil }
            guard simd_length(SIMD3(step[0],step[1],step[2])) < 2, simd_length(SIMD3(step[3],step[4],step[5])) < 0.5 else { return nil }
            pose = perturbed(pose,delta:step);usedIterations = iteration+1
            if step.reduce(0,{ $0 + $1*$1 }) < 1e-14 { break }
        }
        let errors = observations.map { o in project(o.sitePoint,siteFromCamera:pose,calibration:k).map { simd_distance($0,o.pixel) } ?? .infinity }
        let indices = errors.indices.filter { errors[$0] <= 3.0 }
        guard rigid(pose), indices.count >= 8, Double(indices.count)/Double(observations.count) >= 0.7,
              Set(indices.map { observations[$0].landmarkID }).count >= 2 else { return nil }
        let rms = sqrt(indices.reduce(0) { $0 + errors[$1]*errors[$1] } / Double(indices.count))
        guard rms <= 1.5 else { return nil }
        return SpatialPoseFit(siteFromCamera:pose,inlierIndices:indices,rmsReprojectionPixels:rms,maximumReprojectionPixels:indices.map { errors[$0] }.max()!,iterations:usedIterations)
    }
    /// Pivoted Gaussian solve; a rank-deficient geometric system abstains, it is not damped into confidence.
    private static func solve(_ matrix: [[Double]], _ rhs: [Double]) -> [Double]? {
        var a = matrix, b = rhs
        let scale = matrix.flatMap { $0 }.map(abs).max() ?? 0
        guard scale > 0 else { return nil }
        for i in 0..<6 {
            let pivot = (i..<6).max { abs(a[$0][i]) < abs(a[$1][i]) }!
            guard abs(a[pivot][i]) / scale > 1e-10 else { return nil }
            if pivot != i { a.swapAt(i,pivot);b.swapAt(i,pivot) }
            for j in (i+1)..<6 {
                let factor = a[j][i]/a[i][i]
                for k in i..<6 { a[j][k] -= factor*a[i][k] };b[j] -= factor*b[i]
            }
        }
        var x = Array(repeating:0.0,count:6)
        for i in (0..<6).reversed() { x[i] = (b[i] - ((i+1)..<6).reduce(0) { $0 + a[i][$1]*x[$1] }) / a[i][i] }
        return x
    }
}
