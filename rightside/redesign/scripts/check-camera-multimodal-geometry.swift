import Foundation
import CoreImage
import Vision

/// Bounded geometry/model-revision diagnostic, using native source pixels and observed quads.
@main struct MultimodalGeometryProbe {
    static func main() throws {
        let a = CommandLine.arguments
        guard a.count == 4 else { exit(2) }
        let source = CIImage(contentsOf:URL(fileURLWithPath:a[2]))!
        guard max(source.extent.width,source.extent.height) <= 5500 else { exit(2) }
        let context = CIContext(options:[.cacheIntermediates:false])
        let detector = try TransportSegmenter(url:URL(fileURLWithPath:a[1]))
        var rows:[[String:Any]] = []
        func recognize(_ image:CIImage,_ label:String,revision:Int=VNRecognizeTextRequestRevision3) throws -> [VNRecognizedTextObservation] {
            let request = VNRecognizeTextRequest()
            request.revision = revision;request.recognitionLevel = .accurate;request.usesLanguageCorrection = false
            request.recognitionLanguages = ["de-DE","fr-FR","en-US"];request.minimumTextHeight = 0.025
            let start = ProcessInfo.processInfo.systemUptime
            do { try VNImageRequestHandler(cgImage:context.createCGImage(image,from:image.extent)!).perform([request]) }
            catch { rows.append(["name":label,"error":String(describing:error)]);return [] }
            let observations = request.results ?? []
            let texts:[[String:Any]] = observations.map { o in ["box":[o.boundingBox.minX,o.boundingBox.minY,o.boundingBox.width,o.boundingBox.height],
                "candidates":o.topCandidates(3).map { ["text":$0.string,"confidence":$0.confidence] as [String:Any] }] }
            rows.append(["name":label,"revision":revision,"pixels":[image.extent.width,image.extent.height],"milliseconds":(ProcessInfo.processInfo.systemUptime-start)*1000,"texts":texts])
            print(label,observations.map { $0.topCandidates(3).map { "\($0.string) [\($0.confidence)]" } });fflush(stdout)
            return observations
        }
        for (i,detection) in try detector.detect(source).enumerated() {
            let b = detection.box
            let pixels = CGRect(x:b.minX*source.extent.width,y:(1-b.maxY)*source.extent.height,width:b.width*source.extent.width,height:b.height*source.extent.height).integral.intersection(source.extent)
            let body = source.cropped(to:pixels)
            _ = try recognize(body,"\(i)-native-body")
            let top = CGRect(x:pixels.minX,y:pixels.minY+pixels.height*0.45,width:pixels.width,height:pixels.height*0.55).integral.intersection(source.extent)
            let upper = source.cropped(to:top).transformed(by:CGAffineTransform(translationX:-top.minX,y:-top.minY))
            let observations = try recognize(upper,"\(i)-native-upper")
            for revision in [VNRecognizeTextRequestRevision1,VNRecognizeTextRequestRevision2] where VNRecognizeTextRequest.supportedRevisions.contains(revision) {
                _ = try recognize(upper,"\(i)-native-upper-revision\(revision)",revision:revision)
            }
            let lettering = observations.filter { ($0.topCandidates(1).first?.string.rangeOfCharacter(from:.letters)) != nil }
            for (j,observation) in lettering.prefix(2).enumerated() {
                let r = observation.boundingBox
                let crop = CGRect(x:r.minX*top.width,y:r.minY*top.height,width:r.width*top.width,height:r.height*top.height)
                    .insetBy(dx:-r.height*top.height*0.2,dy:-r.height*top.height*0.3).integral.intersection(upper.extent)
                _ = try recognize(upper.cropped(to:crop),"\(i)-native-row\(j)")
                let center = CGPoint(x:r.midX*top.width,y:r.midY*top.height)
                func point(_ p:CGPoint) -> CIVector {
                    CIVector(x:center.x+(p.x*top.width-center.x)*1.05,y:center.y+(p.y*top.height-center.y)*1.5)
                }
                let flattened = upper.applyingFilter("CIPerspectiveCorrection",parameters:[
                    "inputTopLeft":point(observation.topLeft),"inputTopRight":point(observation.topRight),
                    "inputBottomLeft":point(observation.bottomLeft),"inputBottomRight":point(observation.bottomRight)])
                for revision in [VNRecognizeTextRequestRevision3,VNRecognizeTextRequestRevision2] where VNRecognizeTextRequest.supportedRevisions.contains(revision) {
                    _ = try recognize(flattened,"\(i)-observed-quad\(j)-revision\(revision)",revision:revision)
                }
            }
        }
        try JSONSerialization.data(withJSONObject:rows,options:[.prettyPrinted,.sortedKeys]).write(to:URL(fileURLWithPath:a[3]))
    }
}
