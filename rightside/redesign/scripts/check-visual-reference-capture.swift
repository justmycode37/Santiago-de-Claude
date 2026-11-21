import Foundation
import CoreVideo
import CoreGraphics
import ImageIO
import simd
private struct CaptureFixture:Decodable {
    struct Reference:Decodable {let image:String;let plane:VisualReferencePlane}
    let calibration:SpatialCameraCalibration;let references:[Reference]
}
enum VisualReferenceCaptureReplay {
    static func load(_ url:URL)throws->CGImage {
        guard let source=CGImageSourceCreateWithURL(url as CFURL,nil),let image=CGImageSourceCreateImageAtIndex(source,0,nil) else {throw NSError(domain:"image",code:1)}
        return image
    }
    static func buffer(_ image:CGImage)throws->CVPixelBuffer {
        var output:CVPixelBuffer?
        let attributes=[kCVPixelBufferCGImageCompatibilityKey:true,kCVPixelBufferCGBitmapContextCompatibilityKey:true]as CFDictionary
        guard CVPixelBufferCreate(kCFAllocatorDefault,image.width,image.height,kCVPixelFormatType_32BGRA,attributes,&output)==kCVReturnSuccess,let output else {throw NSError(domain:"buffer",code:1)}
        CVPixelBufferLockBaseAddress(output,[]);defer{CVPixelBufferUnlockBaseAddress(output,[])}
        let flags=CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
        guard let context=CGContext(data:CVPixelBufferGetBaseAddress(output),width:image.width,height:image.height,bitsPerComponent:8,bytesPerRow:CVPixelBufferGetBytesPerRow(output),space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:flags) else {throw NSError(domain:"context",code:1)}
        context.draw(image,in:CGRect(x:0,y:0,width:image.width,height:image.height));return output
    }
    static func run(directory:URL)throws->Bool {
        let fixture=try JSONDecoder().decode(CaptureFixture.self,from:Data(contentsOf:directory.appendingPathComponent("scenes.json")))
        let references=try fixture.references.map{VisualReferenceImage(plane:$0.plane,image:try load(directory.appendingPathComponent($0.image)))}
        let pipeline=VisualReferencePipeline(references:references),epoch=UUID()
        let capturedPixels=try buffer(load(directory.appendingPathComponent("two-plane-0.png")))
        var consensus=LocalPoseConsensus(),usable=0,reliable=0
        // Repeated fixture deliveries exercise the live buffer/queue/time path, NOT independent encounters.
        for index in 0..<5 {
            let start=Date(),uptime=ProcessInfo.processInfo.systemUptime
            let context=VisualReferenceFrameContext(epoch:epoch,calibration:fixture.calibration,worldFromCamera:matrix_identity_float4x4,capturedAt:start,uptime:uptime,orientation:"raw_sensor",worldUp:SIMD3(0,1,0),gravityReliable:true,crop:[0,0,1,1])
            let submitted=pipeline.submit(buffer:capturedPixels,context:context)
            pipeline.testingDrain()
            let result=pipeline.takeResult(),now=Date()
            let fresh=result?.context.usable(epoch:epoch,now:now,uptime:ProcessInfo.processInfo.systemUptime,trackingNormal:true,thermalAcceptable:VisualReferencePipeline.thermalAcceptable) == true
            var row:[String:Any]=["capture":true,"attempt":index,"submitted":submitted,"freshAtConsumption":fresh,"seconds":now.timeIntervalSince(start),"referenceIDs":result?.matches.map(\.id) ?? [],"reason":result?.reason ?? "no_completion"]
            if let result,fresh {
                if result.matches.count==2 {usable += 1}
                let assessment=consensus.update(estimates:result.estimates,worldFromCamera:context.worldFromCamera,at:context.capturedAt,now:now,trackingNormal:true,errorBoundMeters:0.3,headingBoundDegrees:3,verticalErrorBoundMeters:0.2)
                row["state"]=assessment.status.rawValue
                if let pose=assessment.siteFromCamera {row["pose"]=(0..<4).flatMap{c in (0..<4).map{pose[c][$0]}}}
                if assessment.status == .reliable {reliable += 1}
            }
            print(String(data:try JSONSerialization.data(withJSONObject:row,options:[.sortedKeys]),encoding:.utf8)!)
        }
        return usable>=3 && reliable>=1
    }
}
