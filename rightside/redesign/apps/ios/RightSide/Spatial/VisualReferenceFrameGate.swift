import Foundation
import simd

/// Survey up is ENU +Z, not the image-plane normal. AR gravity-up belongs to the captured
/// world frame and must be transformed alongside that frame during any rebase.
enum VisualReferenceFrameGate {
    static func agrees(siteFromCamera:simd_double4x4,context:VisualReferenceFrameContext,
                       maximumDegrees:Double=3)->Bool {
        guard context.gravityReliable,let up=context.worldUp,
              up.x.isFinite,up.y.isFinite,up.z.isFinite,
              abs(simd_length(up)-1)<0.01,maximumDegrees.isFinite,(0.1...3).contains(maximumDegrees),
              CalibratedPoseGeometry.rigid(siteFromCamera) else{return false}
        let world=context.worldFromCamera
        let worldFromCamera=simd_double4x4(columns:(SIMD4<Double>(world[0]),SIMD4<Double>(world[1]),SIMD4<Double>(world[2]),SIMD4<Double>(world[3])))
        guard CalibratedPoseGeometry.rigid(worldFromCamera) else{return false}
        let siteFromWorld=siteFromCamera*simd_inverse(worldFromCamera)
        let transformed=siteFromWorld*SIMD4(Double(up.x),Double(up.y),Double(up.z),0)
        let direction=simd_normalize(SIMD3(transformed.x,transformed.y,transformed.z))
        let degrees=acos(max(-1,min(1,direction.z)))*180 / .pi
        return degrees.isFinite && degrees<=maximumDegrees
    }
}
