import Foundation
import CoreImage
import Vision
let args=CommandLine.arguments
let report=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:args[2]))) as! [String:Any]
let frames=report["frames"] as! [[String:Any]]
let box=((frames.first { $0["sample"] as? String == "bus" }!["tracks"] as! [[String:Any]])[0]["box"] as! [Double])
let original=CIImage(contentsOf:URL(fileURLWithPath:args[1]))!
let context=CIContext(options:[.cacheIntermediates:false])
for longest in [1280.0,2560.0] {
 let scale=min(1,longest/max(original.extent.width,original.extent.height))
 let image=original.transformed(by:CGAffineTransform(scaleX:scale,y:scale))
 let bs=min(1,1280/max(image.extent.width,image.extent.height))
 let body=image.transformed(by:CGAffineTransform(scaleX:bs,y:bs))
 let crop=CGRect(x:box[0]*body.extent.width,y:(1-box[1]-box[3])*body.extent.height,width:box[2]*body.extent.width,height:box[3]*body.extent.height).integral
 let request=VNRecognizeTextRequest();request.recognitionLevel = .accurate;request.usesLanguageCorrection=false
 request.recognitionLanguages=["de-DE","fr-FR","en-US"];request.minimumTextHeight=0.025
 try VNImageRequestHandler(cgImage:context.createCGImage(body,from:crop)!).perform([request])
 print("BODY",longest,crop)
 for item in request.results ?? [] {print(item.boundingBox,item.topCandidates(1).map { ($0.string,$0.confidence) })}
 for row in (request.results ?? []).filter({$0.boundingBox.midY>0.35 && $0.topCandidates(1).first!.string.range(of:#"^[A-Za-z]{0,2}\s?\d{1,3}$"#,options:.regularExpression) != nil}).prefix(2) {
  let r=row.boundingBox
  let actual=CGRect(x:crop.minX/body.extent.width,y:1-crop.maxY/body.extent.height,width:crop.width/body.extent.width,height:crop.height/body.extent.height)
  let text=CGRect(x:actual.minX+r.minX*actual.width,y:actual.minY+(1-r.maxY)*actual.height,width:r.width*actual.width,height:r.height*actual.height)
  let region=text.insetBy(dx:-text.height*0.2,dy:-text.height*0.25).intersection(CGRect(x:box[0],y:box[1],width:box[2],height:box[3]))
  for (kind,input) in [("native",image),("canonical",body)] {
   let pixels=CGRect(x:region.minX*input.extent.width,y:(1-region.maxY)*input.extent.height,width:region.width*input.extent.width,height:region.height*input.extent.height).integral.intersection(input.extent)
   let factor=min(2,384/max(pixels.width,pixels.height))
   let prepared=input.cropped(to:pixels).transformed(by:CGAffineTransform(scaleX:factor,y:factor)).applyingFilter("CIColorControls",parameters:[kCIInputSaturationKey:0,kCIInputContrastKey:1.4])
   let req=VNRecognizeTextRequest();req.recognitionLevel = .accurate;req.usesLanguageCorrection=false
   req.recognitionLanguages=["de-DE","fr-FR","en-US"];req.minimumTextHeight=0.05
   try VNImageRequestHandler(cgImage:context.createCGImage(prepared,from:prepared.extent)!).perform([req])
   print("EXACT REFINE",kind,pixels,(req.results ?? []).map{$0.topCandidates(1).map{($0.string,$0.confidence)}})
  }
 }
}
