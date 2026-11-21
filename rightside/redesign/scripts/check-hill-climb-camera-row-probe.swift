import Foundation
import CoreImage
import Vision
// Bounded development probe for low-confidence full display rows at native detail.
let args=CommandLine.arguments
let report=try JSONSerialization.jsonObject(with: Data(contentsOf:URL(fileURLWithPath:args[2]))) as! [String:Any]
let frames=report["frames"] as! [[String:Any]]
let box=((frames.first { $0["sample"] as? String == "bus" }!["tracks"] as! [[String:Any]])[0]["box"] as! [Double])
let original=CIImage(contentsOf:URL(fileURLWithPath:args[1]))!
let context=CIContext(options:[.cacheIntermediates:false])
let s=min(1,2560/max(original.extent.width,original.extent.height))
let image=original.transformed(by:CGAffineTransform(scaleX:s,y:s))
let b=CGRect(x:box[0]*image.extent.width,y:(1-box[1]-box[3])*image.extent.height,width:box[2]*image.extent.width,height:box[3]*image.extent.height).integral
let body=VNRecognizeTextRequest(); body.recognitionLevel = .accurate; body.usesLanguageCorrection=false
body.recognitionLanguages=["de-DE","fr-FR","en-US"]; body.minimumTextHeight=0.025
try VNImageRequestHandler(cgImage:context.createCGImage(image,from:b)!).perform([body])
for row in (body.results ?? []).filter({ $0.boundingBox.midY>0.35 && ($0.topCandidates(1).first?.string.range(of:#"^[A-Za-z]{0,2}\s?\d{1,3}\s+\p{L}"#,options:.regularExpression) != nil) }).prefix(2) {
 let r=row.boundingBox
 let region=CGRect(x:b.minX+r.minX*b.width,y:b.minY+r.minY*b.height,width:r.width*b.width,height:r.height*b.height)
 let crop=region.insetBy(dx:-region.height*0.2,dy:-region.height*0.25).intersection(b).integral
 for maxEdge in [512.0,1024.0,1600.0] {
  let factor=min(2,maxEdge/max(crop.width,crop.height))
  let prepared=image.cropped(to:crop).transformed(by:CGAffineTransform(scaleX:factor,y:factor)).applyingFilter("CIColorControls",parameters:[kCIInputSaturationKey:0,kCIInputContrastKey:1.4])
  let request=VNRecognizeTextRequest(); request.recognitionLevel = .accurate; request.usesLanguageCorrection=false
  request.recognitionLanguages=["de-DE","fr-FR","en-US"]; request.minimumTextHeight=0.05
  try VNImageRequestHandler(cgImage:context.createCGImage(prepared,from:prepared.extent)!).perform([request])
  print("ROW maxEdge\(maxEdge)",(request.results ?? []).map { ($0.boundingBox,$0.topCandidates(3).map { ($0.string,$0.confidence) }) })
 }
}
