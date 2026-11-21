import Foundation
import CoreImage
import CoreVideo
import simd

/// Snapshot values belong to the exact retained sensor buffer, never the completion-time camera.
struct VisualReferenceFrameContext: @unchecked Sendable {
    let epoch: UUID
    let calibration: SpatialCameraCalibration
    let worldFromCamera: simd_float4x4
    let capturedAt: Date
    let uptime: TimeInterval
    let orientation: String
    var worldUp: SIMD3<Float>? = nil
    var gravityReliable: Bool = false
    let crop: [Double] // normalized x,y,width,height. Only a full, uncropped raw buffer is supported.
    var validWorldUp:Bool {
        guard let up=worldUp else{return false}
        return up.x.isFinite && up.y.isFinite && up.z.isFinite && abs(simd_length(up)-1)<0.01
    }
    func usable(epoch expected: UUID, now: Date, uptime current: TimeInterval,
                trackingNormal: Bool, thermalAcceptable: Bool) -> Bool {
        epoch == expected && calibration.isValid && orientation == "raw_sensor" && crop == [0,0,1,1]
        && trackingNormal && thermalAcceptable && gravityReliable && validWorldUp && now >= capturedAt && now.timeIntervalSince(capturedAt) < 0.5
        && uptime.isFinite && current.isFinite && current >= uptime && current-uptime < 0.5
        && LocalLandmarkGeometry.matrix((0..<4).flatMap { c in (0..<4).map { worldFromCamera[c][$0] } }) != nil
    }
}
struct VisualReferenceImage: @unchecked Sendable {
    let plane: VisualReferencePlane
    let image: CGImage
}
struct VisualReferenceFrameResult: @unchecked Sendable {
    let context: VisualReferenceFrameContext
    let matches: [VisualReferenceMatch]
    let reason: String
    var estimates: [LocalPoseReferenceEstimate] {
        matches.map { match in
            let p=match.pose.siteFromCamera
            let camera=simd_float4x4(columns:(SIMD4<Float>(p[0]),SIMD4<Float>(p[1]),SIMD4<Float>(p[2]),SIMD4<Float>(p[3])))
            return .init(landmarkID:match.id,siteFromWorld:camera * simd_inverse(context.worldFromCamera))
        }
    }
}

/// All mutable queue state is under lock; immutable retained CV buffers/images cross the queue.
/// There is at most one running task and one completion. Busy frames are dropped, never queued.
/// Reset cannot interrupt Apple's synchronous request, but guarantees its result cannot publish.
final class VisualReferencePipeline: @unchecked Sendable {
    private let queue=DispatchQueue(label:"rightside.visual-reference",qos:.utility)
    private let lock=NSLock()
    private var generation=UUID()
    private var busy=false
    private var completed: VisualReferenceFrameResult?
    private let references:[VisualReferenceImage]
    init(references:[VisualReferenceImage]) { self.references=references }
    func reset() { lock.lock(); generation=UUID(); completed=nil; lock.unlock() }
    func takeResult() -> VisualReferenceFrameResult? {
        lock.lock();defer{lock.unlock()};let result=completed;completed=nil;return result
    }
    @discardableResult func submit(buffer:CVPixelBuffer,context:VisualReferenceFrameContext) -> Bool {
        guard context.calibration.width == CVPixelBufferGetWidth(buffer),
              context.calibration.height == CVPixelBufferGetHeight(buffer),
              context.usable(epoch:context.epoch,now:Date(),uptime:ProcessInfo.processInfo.systemUptime,
                             trackingNormal:true,thermalAcceptable:Self.thermalAcceptable),
              (2...8).contains(references.count) else { return false }
        lock.lock()
        guard !busy,completed == nil else {lock.unlock();return false}
        busy=true;let token=generation;lock.unlock()
        let capture=PixelCapture(buffer:buffer,context:context)
        queue.async { [self,capture] in
            let result:VisualReferenceFrameResult=autoreleasepool {
                guard Self.thermalAcceptable else {return .init(context:capture.context,matches:[],reason:"thermal")}
                let ci=CIImage(cvPixelBuffer:capture.buffer)
                let renderer=CIContext(options:[.cacheIntermediates:false])
                guard let image=renderer.createCGImage(ci,from:ci.extent) else {return .init(context:capture.context,matches:[],reason:"pixel_decode")}
                return process(image:image,context:capture.context,isCurrent:{self.current(token) && ProcessInfo.processInfo.systemUptime-capture.context.uptime < 0.45})
            }
            lock.lock();busy=false
            if generation == token {completed=result}
            lock.unlock()
        }
        return true
    }
    private func current(_ token:UUID)->Bool {lock.lock();defer{lock.unlock()};return token == generation}
    static var thermalAcceptable:Bool {
        let state=ProcessInfo.processInfo.thermalState
        return state == .nominal || state == .fair
    }
    /// Same actual-pixel inference is callable by native replay without ARKit or a device session.
    /// Replay supplies a capture context; its evaluation clock is separate from wall-clock live expiry.
    func process(image:CGImage,context:VisualReferenceFrameContext,isCurrent:()->Bool = {true}) -> VisualReferenceFrameResult {
        guard context.calibration.isValid,context.gravityReliable,context.validWorldUp, context.orientation == "raw_sensor",context.crop == [0,0,1,1],
              image.width == context.calibration.width,image.height == context.calibration.height,
              (2...8).contains(references.count),Set(references.map{$0.plane.id}).count == references.count else {
            return .init(context:context,matches:[],reason:"calibration_layout_or_references_invalid")
        }
        let scale=Double(VisualReferenceMatcher.maximumDimension)/Double(max(image.width,image.height))
        let width=max(64,Int((Double(image.width)*min(1,scale)).rounded()))
        let height=max(64,Int((Double(image.height)*min(1,scale)).rounded()))
        guard let camera=VisualReferenceRaster(image:image,width:width,height:height) else {return .init(context:context,matches:[],reason:"pixel_decode")}
        let proposals=(try? VisualReferenceProposals.rectangles(camera:camera)) ?? []
        var matches=[VisualReferenceMatch](),gravityRejections=0
        for reference in references {
            guard isCurrent(),Self.thermalAcceptable else {return .init(context:context,matches:[],reason:"reset_or_thermal")}
            guard let raster=VisualReferenceRaster(image:reference.image,width:width,height:height) else {continue}
            if let match=try? VisualReferenceMatcher.match(reference:raster,camera:camera,originalCalibration:context.calibration,plane:reference.plane,proposals:proposals) {
                if VisualReferenceFrameGate.agrees(siteFromCamera:match.pose.siteFromCamera,context:context) {matches.append(match)}
                else {gravityRejections += 1}
            }
        }
        guard Self.independentFootprints(matches, width:width, height:height) else {
            return .init(context:context,matches:[],reason:"overlapping_reference_appearances")
        }
        return .init(context:context,matches:matches,reason:matches.count >= 2 ? "pixel_reference_hypotheses" : gravityRejections>0 ? "pixel_pose_conflicts_with_captured_gravity" : "two_distinct_pixel_references_required")
    }
    static func independentFootprints(_ matches:[VisualReferenceMatch],width:Int,height:Int)->Bool {
        let corners=[SIMD2(0.0,0.0),SIMD2(Double(width),0),SIMD2(Double(width),Double(height)),SIMD2(0,Double(height))]
        var bounds=[(Double,Double,Double,Double)]()
        for match in matches {
            let points=corners.compactMap{VisualReferenceGeometry.point(match.pose.referenceToCameraPixels,$0)}
            guard points.count == 4 else{return false}
            bounds.append((points.map(\.x).min()!,points.map(\.y).min()!,points.map(\.x).max()!,points.map(\.y).max()!))
        }
        for i in bounds.indices {for j in bounds.indices where j>i {
            let a=bounds[i],b=bounds[j]
            let overlap=max(0,min(a.2,b.2)-max(a.0,b.0))*max(0,min(a.3,b.3)-max(a.1,b.1))
            let smaller=min((a.2-a.0)*(a.3-a.1),(b.2-b.0)*(b.3-b.1))
            guard smaller>0,overlap/smaller<0.25 else{return false}
        } }
        return true
    }
    #if SPATIAL_HARNESS
    func testingHold(_ block:@escaping @Sendable ()->Void) {queue.async(execute:block)}
    func testingDrain() {queue.sync {}}
    #endif
    private struct PixelCapture: @unchecked Sendable {let buffer:CVPixelBuffer;let context:VisualReferenceFrameContext}
}
