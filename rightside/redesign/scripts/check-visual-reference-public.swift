import Foundation
import ImageIO
import simd
@main struct PublicPixelReplay {
    static func load(_ url:URL)throws->CGImage {
        guard let source=CGImageSourceCreateWithURL(url as CFURL,nil),let image=CGImageSourceCreateImageAtIndex(source,0,nil) else {throw NSError(domain:"public-image",code:1)}
        return image
    }
    static func main()throws {
        let directory=URL(fileURLWithPath:CommandLine.arguments[1])
        let image=try load(directory.appendingPathComponent("1.png"))
        let reference=VisualReferenceRaster(image:image,width:640,height:480)!
        let ids=CommandLine.arguments.count>2 ? CommandLine.arguments[2].split(separator:",").map(String.init) : ["2","6"]
        for id in ids {
            let start=Date(),cameraImage=try load(directory.appendingPathComponent(id+".png"))
            let decodedAt=Date();let camera=VisualReferenceRaster(image:cameraImage,width:640,height:480)!
            let normalizedAt=Date()
            let registered=try VisualReferenceMatcher.register(reference:reference,camera:camera)
            let finished=Date()
            var row:[String:Any]=["id":id,"accepted":registered != nil,"cameraOriginalSize":[cameraImage.width,cameraImage.height],"referenceOriginalSize":[image.width,image.height],"normalizedSize":[640,480],"decodeMilliseconds":decodedAt.timeIntervalSince(start)*1000,"normalizeMilliseconds":normalizedAt.timeIntervalSince(decodedAt)*1000,"registrationMilliseconds":finished.timeIntervalSince(normalizedAt)*1000,"totalMilliseconds":finished.timeIntervalSince(start)*1000,"metricPoseAvailable":false]
            if let registered {
                row["H"]=(0..<3).flatMap{c in (0..<3).map{registered.homography[c][$0]}}
                row["correlation"]=registered.correlation;row["validFraction"]=registered.validFraction;row["alignedPatchFraction"]=registered.alignedPatchFraction
            }
            // Separate diagnostic replays of stages; do not add these to the production-path total.
            let proposalStart=Date();let rectangles=(try? VisualReferenceProposals.rectangles(camera:camera)) ?? []
            row["diagnosticRectangleMilliseconds"]=Date().timeIntervalSince(proposalStart)*1000;row["rectangleCount"]=rectangles.count
            let seedStart=Date()
            if let raw=try? VisualReferenceMatcher.rawHomography(reference:reference,camera:camera) {
                row["diagnosticVisionSeedMilliseconds"]=Date().timeIntervalSince(seedStart)*1000
                row["rawH"]=(0..<3).flatMap{c in (0..<3).map{raw[c][$0]}}
                let flip=simd_double3x3(columns:(SIMD3(1,0,0),SIMD3(0,-1,0),SIMD3(0,480,1)))
                let refineStart=Date();let refined=VisualReferenceRefinement.refine(seed:flip*raw*flip,reference:reference,camera:camera)
                row["diagnosticVisionSeedRefinementMilliseconds"]=Date().timeIntervalSince(refineStart)*1000
                if let refined {row["refinedH"]=(0..<3).flatMap{c in (0..<3).map{refined[c][$0]}}}
            }
            print(String(data:try JSONSerialization.data(withJSONObject:row,options:[.sortedKeys]),encoding:.utf8)!)
        }
    }
}
