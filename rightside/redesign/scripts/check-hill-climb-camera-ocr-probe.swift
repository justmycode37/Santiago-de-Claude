import Foundation
import CoreImage
import Vision

// Development-only hypothesis probe. Input box comes from an actual detector report;
// no expected line/headsign, custom words, or fabricated OCR is supplied to Vision.
let args = CommandLine.arguments
let report = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[2]))) as! [String: Any]
let frames = report["frames"] as! [[String: Any]]
let box = ((frames.first { $0["sample"] as? String == args[3] }!["tracks"] as! [[String: Any]])[0]["box"] as! [Double])
let original = CIImage(contentsOf: URL(fileURLWithPath: args[1]))!
let context = CIContext(options: [.cacheIntermediates: false])
for longest in [1280.0, 2560.0] {
 let s = min(1, longest / max(original.extent.width, original.extent.height))
 let image = original.transformed(by: CGAffineTransform(scaleX: s, y: s))
 let b = CGRect(x: box[0]*image.extent.width, y: (1-box[1]-box[3])*image.extent.height, width: box[2]*image.extent.width, height: box[3]*image.extent.height)
 for (name, fraction, widthFraction) in [("body",1.0,1.0),("upper",0.55,1.0),("upperLeft",0.55,0.5),("upperRight",0.55,0.5)] {
  let crop = CGRect(x:b.minX + (name == "upperRight" ? b.width*0.5 : 0), y:b.maxY-b.height*fraction,width:b.width*widthFraction,height:b.height*fraction).integral.intersection(image.extent)
  for level in [VNRequestTextRecognitionLevel.accurate, .fast] {
   let cg = context.createCGImage(image, from: crop)!
   let request = VNRecognizeTextRequest(); request.recognitionLevel=level
   request.usesLanguageCorrection=false; request.recognitionLanguages=["de-DE","fr-FR","en-US"]; request.minimumTextHeight=0.01
   let start=ProcessInfo.processInfo.systemUptime
   try VNImageRequestHandler(cgImage:cg).perform([request])
   print("INPUT \(longest) \(name) \(level.rawValue) \((ProcessInfo.processInfo.systemUptime-start)*1000)ms")
   for item in request.results ?? [] { print(item.boundingBox, item.topCandidates(3).map { ($0.string,$0.confidence) }) }
  }
 }
}
// Second bounded hypothesis: recover LED glyphs from low-confidence observed number rows.
// Crop proposals are obtained from OCR geometry, never from the expected itinerary.
let s = min(1, 1280 / max(original.extent.width,original.extent.height))
let image = original.transformed(by:CGAffineTransform(scaleX:s,y:s))
let b = CGRect(x:box[0]*image.extent.width,y:(1-box[1]-box[3])*image.extent.height,width:box[2]*image.extent.width,height:box[3]*image.extent.height).integral
let body = VNRecognizeTextRequest(); body.recognitionLevel = .accurate; body.usesLanguageCorrection=false; body.minimumTextHeight=0.025
body.recognitionLanguages=["de-DE","fr-FR","en-US"]
try VNImageRequestHandler(cgImage:context.createCGImage(image,from:b)!).perform([body])
for row in (body.results ?? []).filter({ $0.boundingBox.midY > 0.35 && ($0.topCandidates(1).first?.string.range(of:#"^[A-Za-z]{0,2}\s?\d{1,3}$"#,options:.regularExpression) != nil) }).prefix(2) {
 let r = row.boundingBox
 let region = CGRect(x:b.minX+r.minX*b.width,y:b.minY+r.minY*b.height,width:r.width*b.width,height:r.height*b.height)
 let nearby = CGRect(x:region.minX-region.height*0.2,y:region.minY-region.height*0.25,width:region.width+region.height*0.4,height:region.height*1.5).intersection(b).integral
 for factor in [1.0,2.0,3.0] {
  for blur in [0.0,0.7,1.2] {
   for invert in [false,true] {
    var prepared=image.cropped(to:nearby).transformed(by:CGAffineTransform(scaleX:factor,y:factor))
    if blur>0 {prepared=prepared.applyingFilter("CIGaussianBlur",parameters:[kCIInputRadiusKey:blur*factor]).cropped(to:prepared.extent)}
    prepared=prepared.applyingFilter("CIColorControls",parameters:[kCIInputSaturationKey:0,kCIInputContrastKey:1.4])
    if invert {prepared=prepared.applyingFilter("CIColorInvert")}
    let request=VNRecognizeTextRequest(); request.recognitionLevel = .accurate; request.usesLanguageCorrection=false
    request.recognitionLanguages=["de-DE","en-US"]; request.minimumTextHeight=0.05
    try VNImageRequestHandler(cgImage:context.createCGImage(prepared,from:prepared.extent)!).perform([request])
    print("GLYPH \(factor) blur\(blur) invert\(invert):",(request.results ?? []).map { ($0.boundingBox,$0.topCandidates(3).map { ($0.string,$0.confidence) }) })
   }
  }
 }
}
