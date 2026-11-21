import Foundation
import simd

enum LocalPoseStatus: String, Codable { case unknown, candidate, reliable, relocalizing }
struct LocalPoseReferenceEstimate {
    let landmarkID: String
    let siteFromWorld: simd_float4x4
}
struct LocalPoseAssessment {
    let status: LocalPoseStatus
    let reason: String
    let at: Date
    let siteFromWorld: simd_float4x4?
    let siteFromCamera: simd_float4x4?
    let referenceIDs: [String]
    let maximumTranslationDisagreement: Double
    let maximumAngleDisagreementDegrees: Double
}

/// Independent image anchors must agree. Tracking loss discards alignment immediately;
/// relocalization must establish a fresh 3-frame temporal baseline in the new world frame.
struct LocalPoseConsensus {
    private var samples: [(Date, simd_float4x4)] = []
    private var previouslyReliable = false
    private var lastTimestamp: Date?
    private(set) var assessment: LocalPoseAssessment?
    mutating func reset() { samples=[];previouslyReliable=false;lastTimestamp=nil;assessment=nil }
    mutating func invalidate(at: Date, reason: String) -> LocalPoseAssessment {
        samples=[]
        let state: LocalPoseStatus = previouslyReliable ? .relocalizing : .unknown
        let value=LocalPoseAssessment(status:state,reason:reason,at:at,siteFromWorld:nil,siteFromCamera:nil,referenceIDs:[],maximumTranslationDisagreement:0,maximumAngleDisagreementDegrees:0)
        assessment=value;return value
    }
    static func angle(_ a: simd_float4x4, _ b: simd_float4x4) -> Double {
        let aa=simd_float3x3(columns:(SIMD3(a[0].x,a[0].y,a[0].z),SIMD3(a[1].x,a[1].y,a[1].z),SIMD3(a[2].x,a[2].y,a[2].z)))
        let bb=simd_float3x3(columns:(SIMD3(b[0].x,b[0].y,b[0].z),SIMD3(b[1].x,b[1].y,b[1].z),SIMD3(b[2].x,b[2].y,b[2].z)))
        let r=simd_transpose(aa)*bb
        return acos(max(-1,min(1,Double(r[0].x+r[1].y+r[2].z-1)/2))) * 180 / .pi
    }
    mutating func update(estimates:[LocalPoseReferenceEstimate], worldFromCamera:simd_float4x4, at:Date, now:Date,
                         trackingNormal:Bool, errorBoundMeters:Double, headingBoundDegrees:Double,
                         verticalErrorBoundMeters:Double) -> LocalPoseAssessment {
        guard now >= at, now.timeIntervalSince(at) < 0.5, trackingNormal,
              errorBoundMeters.isFinite, (0.01...1).contains(errorBoundMeters),
              verticalErrorBoundMeters.isFinite, (0.01...1).contains(verticalErrorBoundMeters),
              headingBoundDegrees.isFinite, (0.1...3).contains(headingBoundDegrees),
              Self.rigid(worldFromCamera) else { return invalidate(at:now,reason:"tracking_calibration_or_frame_unavailable") }
        if let previous=lastTimestamp, at <= previous { return invalidate(at:now,reason:"nonmonotonic_frame") }
        lastTimestamp=at
        guard (2...8).contains(estimates.count), Set(estimates.map(\.landmarkID)).count == estimates.count,
              estimates.allSatisfy({ !$0.landmarkID.isEmpty && Self.rigid($0.siteFromWorld) }) else { return invalidate(at:at,reason:"two_independent_references_required") }
        // Bound disagreement at the phone, independent of the arbitrary AR world origin.
        // Site coordinates are east/north/up; height has its own measured envelope.
        let cameras = estimates.map { $0.siteFromWorld * worldFromCamera }
        var distance=0.0, horizontal=0.0, vertical=0.0, angle=0.0
        for a in cameras { for b in cameras {
            let delta = LocalLandmarkGeometry.translation(a) - LocalLandmarkGeometry.translation(b)
            distance=max(distance,Double(simd_length(delta)))
            horizontal=max(horizontal,Double(simd_length(SIMD2(delta.x,delta.y))))
            vertical=max(vertical,Double(abs(delta.z)))
            angle=max(angle,Self.angle(a,b))
        } }
        guard horizontal <= errorBoundMeters, vertical <= verticalErrorBoundMeters,
              angle <= headingBoundDegrees else { return invalidate(at:at,reason:"landmark_geometry_disagrees") }
        // Quaternion hemisphere-aligned mean; avoids first-reference bias and antipodal cancellation.
        let first=simd_quatf(cameras[0])
        var q=SIMD4<Float>.zero, t=SIMD3<Float>.zero
        for camera in cameras {
            let rotation=simd_quatf(camera)
            q += simd_dot(first.vector,rotation.vector) < 0 ? -rotation.vector : rotation.vector
            t += LocalLandmarkGeometry.translation(camera)
        }
        guard simd_length(q)>0.001 else { return invalidate(at:at,reason:"rotation_ambiguous") }
        var fusedCamera=simd_float4x4(simd_quatf(vector:simd_normalize(q)));fusedCamera[3]=SIMD4(t/Float(estimates.count),1)
        let fused = fusedCamera * simd_inverse(worldFromCamera)
        if let prior=samples.last {
            // Evaluate both alignments at this frame's camera: passenger movement is not drift.
            let priorCamera = prior.1 * worldFromCamera
            let delta = LocalLandmarkGeometry.translation(fusedCamera) - LocalLandmarkGeometry.translation(priorCamera)
            if at.timeIntervalSince(prior.0)>0.5 {
                _=invalidate(at:at,reason:"frame_gap_relocalizing")
            } else if Double(simd_length(SIMD2(delta.x,delta.y)))>errorBoundMeters
                        || Double(abs(delta.z))>verticalErrorBoundMeters
                        || Self.angle(fusedCamera,priorCamera)>headingBoundDegrees {
                return invalidate(at:at,reason:"alignment_drift_or_world_reset")
            }
        }
        samples.removeAll { at.timeIntervalSince($0.0)>1 }
        if samples.last.map({ at.timeIntervalSince($0.0)>=0.14 }) ?? true { samples.append((at,fused)) }
        let stable=samples.count>=3 && at.timeIntervalSince(samples[0].0)>=0.3
        let state:LocalPoseStatus=stable ? .reliable : previouslyReliable ? .relocalizing : .candidate
        if stable { previouslyReliable=true }
        let value=LocalPoseAssessment(status:state,reason:stable ? "independent_reference_consensus" : "collecting_independent_frames",at:at,
            siteFromWorld:stable ? fused : nil,siteFromCamera:stable ? fusedCamera : nil,
            referenceIDs:estimates.map(\.landmarkID).sorted(),maximumTranslationDisagreement:distance,maximumAngleDisagreementDegrees:angle)
        assessment=value;return value
    }
    private static func rigid(_ m:simd_float4x4)->Bool {
        LocalLandmarkGeometry.matrix((0..<4).flatMap { c in (0..<4).map { m[c][$0] } }) != nil
    }
}

/// A pending asynchronous frame is not tracking loss. Expired output is hidden immediately,
/// while temporal sample history survives only until the next capture's existing gap check.
/// Stop/context/tracking/thermal resets clear both history and output through reset().
struct LocalPixelPoseProgress {
    private var consensus = LocalPoseConsensus()
    mutating func reset() { consensus.reset() }
    mutating func receive(estimates: [LocalPoseReferenceEstimate], worldFromCamera: simd_float4x4,
                          at: Date, now: Date, horizontal: Double, vertical: Double, heading: Double) {
        _ = consensus.update(estimates: estimates, worldFromCamera: worldFromCamera, at: at, now: now,
            trackingNormal: true, errorBoundMeters: horizontal, headingBoundDegrees: heading,
            verticalErrorBoundMeters: vertical)
    }
    func fresh(at now: Date) -> LocalPoseAssessment? {
        guard let value = consensus.assessment, now >= value.at,
              now.timeIntervalSince(value.at) < 0.5 else { return nil }
        return value
    }
}
