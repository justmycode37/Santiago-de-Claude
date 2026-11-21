import Foundation
import CoreML
import CoreImage

/// Swift/CoreML runtime parity on immutable actual-pixel and negative tensors.
@main struct NativeDisplayParity {
    static func main() throws {
        let a = CommandLine.arguments
        guard a.count == 3 else { exit(2) }
        let input = URL(fileURLWithPath:a[1]),out = URL(fileURLWithPath:a[2])
        let reference = try JSONSerialization.jsonObject(with:Data(contentsOf:input.appendingPathComponent("parity.json"))) as! [String:Any]
        let cases = reference["cases"] as! [[String:Any]]
        guard cases.count == 14 else { exit(2) }
        let dictionary = try JSONDecoder().decode([String].self,from:Data(contentsOf:input.appendingPathComponent("display-characters.json")))
        let started = ProcessInfo.processInfo.systemUptime
        let recognizer = try VehicleDisplayRecognizer(modelURL:input.appendingPathComponent("VehicleDisplayRecognizer.mlmodelc"),charactersURL:input.appendingPathComponent("display-characters.json"))
        let loadMS = (ProcessInfo.processInfo.systemUptime-started)*1000
        var rows:[[String:Any]] = [],failures = 0
        for (i,entry) in cases.enumerated() {
            let tensor = try MLMultiArray(shape:[1,3,48,320],dataType:.float32)
            let bytes = try Data(contentsOf:input.appendingPathComponent("input-\(i).float32"))
            guard bytes.count == tensor.count*4 else { exit(2) }
            _ = bytes.withUnsafeBytes { source in memcpy(tensor.dataPointer,source.baseAddress!,bytes.count) }
            let original = try Data(contentsOf:input.appendingPathComponent("reference-\(i).float32"))
            let referenceValues = original.withUnsafeBytes { Array($0.bindMemory(to:Float.self)) }
            let at = ProcessInfo.processInfo.systemUptime
            let scores = try recognizer.scores(input:tensor)
            let milliseconds = (ProcessInfo.processInfo.systemUptime-at)*1000
            guard scores.values.count == referenceValues.count else { exit(2) }
            let differences = zip(scores.values,referenceValues).map { abs($0-$1) }
            let maxError = differences.max() ?? .infinity,meanError = differences.reduce(0,+)/Float(differences.count)
            let text = VehicleDisplayCTC.decode(scores.values,steps:scores.steps,dictionary:dictionary)?.text
            let passed = maxError<0.001 && meanError<0.0001 && text == (entry["onnxText"] as? String)
            if !passed { failures += 1 }
            rows.append(["name":entry["name"]!,"maxAbsoluteError":maxError,"meanAbsoluteError":meanError,
                "text":text as Any? ?? NSNull(),"passed":passed,"actualMacMS":milliseconds])
            print("\(passed ? "PASS":"FAIL") Swift native parity \(entry["name"]!) \(text ?? "nil")")
        }
        let crops = try JSONSerialization.jsonObject(with:Data(contentsOf:out.appendingPathComponent("crop-manifest.json"))) as! [[String:Int]]
        var pixelRows:[[String:Any]] = []
        for crop in crops {
            let index = crop["index"]!,width = crop["width"]!,height = crop["height"]!
            let bgr = [UInt8](try Data(contentsOf:out.appendingPathComponent("crop-\(index).bgr")))
            let prepared = try recognizer.makeInput(bgr:bgr,width:width,height:height)
            let values = Array(UnsafeBufferPointer(start:prepared.dataPointer.assumingMemoryBound(to:Float.self),count:prepared.count))
            let bytes = try Data(contentsOf:input.appendingPathComponent("input-\(index).float32"))
            let frozen = bytes.withUnsafeBytes { Array($0.bindMemory(to:Float.self)) }
            let inputErrors = zip(values,frozen).map { abs($0-$1) }
            let scores = try recognizer.scores(input:prepared)
            let text = VehicleDisplayCTC.decode(scores.values,steps:scores.steps,dictionary:dictionary)?.text
            let referenceBytes = try Data(contentsOf:input.appendingPathComponent("reference-\(index).float32"))
            let referenceValues = referenceBytes.withUnsafeBytes { Array($0.bindMemory(to:Float.self)) }
            let outputErrors = zip(scores.values,referenceValues).map { abs($0-$1) }
            // Exercise CG/CI row orientation and RGB→BGR conversion on these exact source pixels.
            var rgba = [UInt8](repeating:255,count:width*height*4)
            for i in 0..<(width*height) { for c in 0..<3 { rgba[i*4+c] = bgr[i*3+2-c] } }
            let cg = CGImage(width:width,height:height,bitsPerComponent:8,bitsPerPixel:32,bytesPerRow:width*4,
                space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:CGBitmapInfo(rawValue:CGImageAlphaInfo.last.rawValue),
                provider:CGDataProvider(data:Data(rgba) as CFData)!,decode:nil,shouldInterpolate:false,intent:.defaultIntent)!
            let viaCI = try recognizer.makeInput(image:CIImage(cgImage:cg),region:CGRect(x:0,y:0,width:1,height:1))
            let ciValues = Array(UnsafeBufferPointer(start:viaCI.dataPointer.assumingMemoryBound(to:Float.self),count:viaCI.count))
            let channelError = zip(ciValues,values).map { abs($0-$1) }.max() ?? .infinity
            let maxError = outputErrors.max() ?? .infinity,meanError = outputErrors.reduce(0,+)/Float(outputErrors.count)
            let passed = maxError<0.001 && meanError<0.0001 && text == (cases[index]["onnxText"] as? String) && channelError<0.000001
            if !passed { failures += 1 }
            pixelRows.append(["index":index,"name":cases[index]["name"]!,"inputMaxError":inputErrors.max() ?? 0,
                "inputMeanError":inputErrors.reduce(0,+)/Float(inputErrors.count),"channelOrientationMaxError":channelError,
                "outputMaxError":maxError,"outputMeanError":meanError,"text":text as Any? ?? NSNull(),"passed":passed])
            print("\(passed ? "PASS":"FAIL") Swift pixel preprocessing \(cases[index]["name"]!) maxInput \(inputErrors.max() ?? 0) maxOutput \(maxError) CIerror \(channelError) text \(text ?? "nil")")
        }
        var boundaryRows:[[String:Any]] = []
        for (name,width,height,supported) in [("below-minimum",10,48,false),("minimum-width",11,48,true),
            ("maximum-downscale",960,144,true),("over-downscale",961,144,false)] {
            var accepted = false
            do { _ = try recognizer.makeInput(bgr:Array(repeating:127,count:width*height*3),width:width,height:height);accepted = true }
            catch { accepted = false }
            let passed = accepted == supported
            if !passed { failures += 1 }
            boundaryRows.append(["name":name,"width":width,"height":height,"accepted":accepted,"passed":passed])
            print("\(passed ? "PASS":"FAIL") bounded preprocessing \(name)")
        }
        try JSONSerialization.data(withJSONObject:["checks":cases.count+crops.count+boundaryRows.count,"frozenChecks":cases.count+crops.count,"boundaryChecks":boundaryRows.count,"failures":failures,"coldLoadMS":loadMS,"rows":rows,"pixelRows":pixelRows,"boundaryRows":boundaryRows],options:[.prettyPrinted,.sortedKeys])
            .write(to:out.appendingPathComponent("native-parity.json"))
        exit(failures == 0 ? 0:1)
    }
}
