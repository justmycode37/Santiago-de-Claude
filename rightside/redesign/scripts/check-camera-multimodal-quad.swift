import Foundation
import CoreImage
import Vision

/// Diagnostic only: same production proposal, one observed-quad transform, pinned CPU model.
/// No selected service or expected word is accepted by the recognition path.
@main struct ObservedQuadProbe {
    static func main() throws {
        let args = CommandLine.arguments
        guard args.count == 7 else { exit(2) }
        let images = URL(fileURLWithPath:args[2]), out = URL(fileURLWithPath:args[3])
        let fixture = try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:args[4]))) as! [String:Any]
        let preparation = fixture["controlledCompositePreparation"] as! [[String:Any]]
        let context = CIContext(options:[.cacheIntermediates:false])
        let runtime = try VehicleDisplayRecognizer(modelURL:URL(fileURLWithPath:args[5]),charactersURL:URL(fileURLWithPath:args[6]))
        let dictionary = try JSONDecoder().decode([String].self,from:Data(contentsOf:URL(fileURLWithPath:args[6])))
        let pipeline = LocalVehiclePipeline(modelURL:URL(fileURLWithPath:args[1]),displayModelURL:URL(fileURLWithPath:args[5]),displayCharactersURL:URL(fileURLWithPath:args[6]))
        func source(_ name:String,_ maximum:Double) -> CIImage {
            let image = CIImage(contentsOf:images.appendingPathComponent(name+".jpg"))!
            let scale = min(1,maximum/max(image.extent.width,image.extent.height))
            return image.transformed(by:CGAffineTransform(scaleX:scale,y:scale))
        }
        func rectangle(_ values:[Double]) -> CGRect { CGRect(x:values[0],y:values[1],width:values[2],height:values[3]) }
        func composite(_ names:[String]) -> CIImage {
            let bounds = CGRect(x:0,y:0,width:2560,height:1024)
            var canvas = CIImage(color:CIColor(red:0.3,green:0.3,blue:0.3)).cropped(to:bounds)
            let tiles = preparation.filter { ($0["sources"] as? [String]) == names }
            precondition(tiles.count == 2)
            for tile in tiles {
                let crop = rectangle(tile["sourceCropPixels"] as! [Double])
                let target = rectangle(tile["outputRectangle"] as! [Double])
                let image = source(tile["original"] as! String,2560).cropped(to:crop)
                    .transformed(by:CGAffineTransform(translationX:-crop.minX,y:-crop.minY))
                    .transformed(by:CGAffineTransform(scaleX:target.width/crop.width,y:target.height/crop.height))
                    .transformed(by:CGAffineTransform(translationX:target.minX,y:target.minY))
                canvas = image.composited(over:canvas)
            }
            return canvas.cropped(to:bounds)
        }
        let inputs:[(String,CIImage)] = [("bus1280",source("bus",1280)),("bus2560",source("bus",2560)),
            ("tram1280",source("tram",1280)),("tram2560",source("tram",2560)),
            ("bus-tram",composite(["bus","tram"])),("swapped",composite(["tram","bus"]))]
        var rows:[[String:Any]] = [], cases:[[String:Any]] = [], rawRequests:[[String:Any]] = []
        var requests = 0, predictions = 0
        let regex = try NSRegularExpression(pattern:#"^\s*([A-Za-z]{0,2}\s?\d{1,3})\s+(.+?)\s*$"#)
        for (name,image) in inputs {
            let result = try pipeline.process(upright:image,at:Date(timeIntervalSince1970:1_800_000_000),epoch:UUID())
            cases.append(["name":name,"pixels":[image.extent.width,image.extent.height],
                "actualTracks":result.tracks.count,"productionMS":result.latencyMS,
                "tracks":result.tracks.map { track -> [String:Any] in
                    ["id":track.id.uuidString,"kind":track.detection.kind.rawValue,
                     "maskPixels":track.detection.mask.pixels.filter { $0 != 0 }.count,
                     "raw":track.readings.last?.raw ?? [],"display":track.readings.last?.displayText as Any? ?? NSNull()]
                }])
            for diagnostic in result.recognitionDiagnostics {
                guard let proposal = diagnostic.proposal,
                      let track = result.tracks.first(where: { $0.id == diagnostic.trackID }) else { continue }
                let otherBoxes = result.tracks.filter { $0.id != track.id }.map { $0.detection.box }
                let b = track.detection.box
                let crop = CGRect(x:b.minX*image.extent.width,y:(1-b.maxY)*image.extent.height,
                    width:b.width*image.extent.width,height:b.height*image.extent.height).integral.intersection(image.extent)
                let scale = min(1,1280/max(image.extent.width,image.extent.height))
                let bodyImage = image.transformed(by:CGAffineTransform(scaleX:scale,y:scale))
                let bodyCrop = CGRect(x:b.minX*bodyImage.extent.width,y:(1-b.maxY)*bodyImage.extent.height,
                    width:b.width*bodyImage.extent.width,height:b.height*bodyImage.extent.height).integral.intersection(bodyImage.extent)
                let displayCrop = CGRect(x:crop.minX,y:crop.minY+crop.height*0.45,width:crop.width,height:crop.height*0.55).integral.intersection(image.extent)
                let displayScale = min(2,1600/displayCrop.width)
                let displayImage = image.cropped(to:displayCrop).transformed(by:CGAffineTransform(scaleX:displayScale,y:displayScale))
                let sources:[(CIImage,CGRect,CGRect)] = [
                    (bodyImage,bodyCrop,CGRect(x:bodyCrop.minX/bodyImage.extent.width,y:1-bodyCrop.maxY/bodyImage.extent.height,width:bodyCrop.width/bodyImage.extent.width,height:bodyCrop.height/bodyImage.extent.height)),
                    (displayImage,displayImage.extent,CGRect(x:displayCrop.minX/image.extent.width,y:1-displayCrop.maxY/image.extent.height,width:displayCrop.width/image.extent.width,height:displayCrop.height/image.extent.height))]
                var quad:[CGPoint]?
                for (input,pixels,roi) in sources where quad == nil {
                    guard requests<24, let cg = context.createCGImage(input,from:pixels) else { continue }
                    let request = VNRecognizeTextRequest()
                    request.recognitionLevel = .accurate;request.usesLanguageCorrection = false
                    request.recognitionLanguages = ["de-DE","fr-FR","en-US"];request.minimumTextHeight = 0.025
                    try VNImageRequestHandler(cgImage:cg).perform([request]);requests += 1
                    rawRequests.append(["case":name,"trackID":track.id.uuidString,"request":requests,
                        "roi":[roi.minX,roi.minY,roi.width,roi.height],
                        "texts":(request.results ?? []).map { item -> [String:Any] in
                            ["text":item.topCandidates(1).first?.string ?? "",
                             "score":item.topCandidates(1).first?.confidence ?? 0,
                             "quad":[item.topLeft,item.topRight,item.bottomLeft,item.bottomRight].map { [$0.x,$0.y] }]
                        }])
                    func mapped(_ r:CGRect) -> CGRect { CGRect(x:roi.minX+r.minX*roi.width,y:roi.minY+(1-r.maxY)*roi.height,width:r.width*roi.width,height:r.height*roi.height) }
                    func point(_ p:CGPoint) -> CGPoint { CGPoint(x:roi.minX+p.x*roi.width,y:roi.minY+(1-p.y)*roi.height) }
                    for observation in request.results ?? [] {
                        guard let candidate = observation.topCandidates(1).first,
                              VehicleDisplayRecognitionPolicy.associated(mapped(observation.boundingBox),detection:track.detection,otherBoxes:otherBoxes) else { continue }
                        var candidates:[(String,VNRectangleObservation)] = [(candidate.string,observation)]
                        if let match = regex.firstMatch(in:candidate.string,range:NSRange(candidate.string.startIndex...,in:candidate.string)),
                           let range = Range(match.range(at:2),in:candidate.string),let bounds = try? candidate.boundingBox(for:range) {
                            candidates.append((String(candidate.string[range]),bounds))
                        }
                        for (text,bounds) in candidates where text == proposal.headsign.text
                            && VehicleTracker.iou(mapped(bounds.boundingBox),proposal.region)>0.999 {
                            quad = [bounds.topLeft,bounds.topRight,bounds.bottomLeft,bounds.bottomRight].map(point)
                            break
                        }
                        if quad != nil { break }
                    }
                }
                var row:[String:Any] = ["name":name,"trackID":track.id.uuidString,"class":track.detection.kind.rawValue,
                    "observedRoute":proposal.route.text,"observedVisionHeadsign":proposal.headsign.text,
                    "baselineAlternatives":([diagnostic.alternative].compactMap { $0 }+diagnostic.additionalAlternatives).map { o -> [String:Any] in
                        ["text":o.text,"characterScores":o.characterScores,"samplingID":o.samplingID,
                         "frameID":o.frameID.uuidString,"capturedAt":o.capturedAt.timeIntervalSince1970]
                    },
                    "region":[proposal.region.minX,proposal.region.minY,proposal.region.width,proposal.region.height]]
                guard let quad,quad.allSatisfy({ proposal.region.insetBy(dx:-0.000001,dy:-0.000001).contains($0) }),predictions<12 else {
                    row["refusal"]="no_exact_same_proposal_observed_quad";rows.append(row);continue
                }
                func pixel(_ p:CGPoint) -> CIVector { CIVector(x:p.x*image.extent.width,y:(1-p.y)*image.extent.height) }
                let flattened = image.applyingFilter("CIPerspectiveCorrection",parameters:[
                    "inputTopLeft":pixel(quad[0]),"inputTopRight":pixel(quad[1]),
                    "inputBottomLeft":pixel(quad[2]),"inputBottomRight":pixel(quad[3])])
                row["quad"]=quad.map { [$0.x,$0.y] };row["rectifiedPixels"]=[flattened.extent.width,flattened.extent.height]
                do {
                    let tensor = try runtime.makeInput(image:flattened,region:CGRect(x:0,y:0,width:1,height:1))
                    let scores = try runtime.scores(input:tensor);predictions += 1
                    if let decoded = VehicleDisplayCTC.decode(scores.values,steps:scores.steps,dictionary:dictionary) {
                        row["text"]=decoded.text;row["characterScores"]=decoded.characterScores
                        row["rawEngineGate"]=decoded.characterScores.count == decoded.text.count && decoded.text.count>=4
                            && decoded.text.rangeOfCharacter(from:.letters) != nil
                            && decoded.characterScores.allSatisfy { $0>=0.5 }
                            && decoded.characterScores.reduce(0,+)/Float(decoded.characterScores.count)>=0.95
                    } else { row["refusal"]="invalid_output" }
                } catch { row["refusal"]=String(describing:error) }
                rows.append(row)
            }
        }
        let report:[String:Any] = ["schemaVersion":1,"contract":"observed-quad-diagnostic-v1-six-inputs",
            "expectedCases":6,"cases":cases,"rows":rows,"rawVisionRequests":rawRequests,
            "extraVisionRequests":requests,"extraCoreMLPredictions":predictions,
            "maximumExtraPredictions":12,"transform":"one exact observed quadrilateral; no padding/search",
            "scope":"DEVELOPMENT diagnostic only; no publication/identity/physical-device claim; no expected text enters recognizers"]
        try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]).write(to:out.appendingPathComponent("quad-report.json"))
        print("Recorded \(rows.count) proposals, \(requests) extra Vision requests, \(predictions) extra CoreML predictions")
    }
}
