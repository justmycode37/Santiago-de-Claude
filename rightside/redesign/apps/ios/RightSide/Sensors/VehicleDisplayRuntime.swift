import Foundation
import CoreML
import CoreImage
import CryptoKit

/// Pinned local CoreML display recognizer; confidence remains engine-specific observation.
/// The camera's serial worker owns this model and its buffers; no parallel inference.
final class VehicleDisplayRecognizer {
    enum Failure: Error { case incompatibleModel, invalidPixels, invalidOutput }
    private let model: MLModel
    private let dictionary: [String]
    private let context = CIContext(options:[.cacheIntermediates:false])

    init(modelURL: URL, charactersURL: URL) throws {
        let data = try Data(contentsOf:charactersURL)
        let digest = SHA256.hash(data:data).map { String(format:"%02x",$0) }.joined()
        guard digest == "736f1593b68e36ffc935e557b1452a2cd43267808eb49ee705a90fb0be8d22c0" else { throw Failure.incompatibleModel }
        dictionary = try JSONDecoder().decode([String].self,from:data)
        let config = MLModelConfiguration();config.computeUnits = .cpuOnly
        model = try MLModel(contentsOf:modelURL,configuration:config)
        guard let metadata = model.modelDescription.metadata[.creatorDefinedKey] as? [String:String],
              metadata["sourceONNXSHA256"] == VehicleDisplayRecognitionPolicy.modelID,
              metadata["configID"] == VehicleDisplayRecognitionPolicy.configID,
              metadata["dictionarySHA256"] == digest,
              dictionary.count == 838, dictionary.first == "",
              model.modelDescription.inputDescriptionsByName["input"]?.multiArrayConstraint?.shape.map(\.intValue) == [1,3,48,320],
              model.modelDescription.outputDescriptionsByName["scores"] != nil else { throw Failure.incompatibleModel }
    }

    func recognize(image: CIImage, proposal: VehicleDisplayRecognitionPolicy.Proposal,
                   trackID: UUID, frameID: UUID, capturedAt: Date, samplingID: String = "native") throws -> AlternativeDisplayObservation? {
        try recognize(image: image, region: proposal.region, trackID: trackID, frameID: frameID, capturedAt: capturedAt, samplingID: samplingID)
    }

    func recognize(image: CIImage, region: CGRect, trackID: UUID, frameID: UUID,
                   capturedAt: Date, samplingID: String) throws -> AlternativeDisplayObservation? {
        let input = try makeInput(image:image,region:region)
        let values = try scores(input:input)
        guard let result = VehicleDisplayCTC.decode(values.values,steps:values.steps,dictionary:dictionary) else { return nil }
        return AlternativeDisplayObservation(engineID:VehicleDisplayRecognitionPolicy.engineID,
            modelID:VehicleDisplayRecognitionPolicy.modelID,configID:VehicleDisplayRecognitionPolicy.configID,
            frameID:frameID,capturedAt:capturedAt,trackID:trackID,text:result.text,
            characterScores:result.characterScores,region:region,samplingID:samplingID)
    }

    /// Exposed to the native parity harness: no image/model answer is supplied here.
    func scores(input: MLMultiArray) throws -> (values:[Float],steps:Int) {
        guard input.shape.map(\.intValue) == [1,3,48,320],input.dataType == .float32 else { throw Failure.invalidPixels }
        let output = try model.prediction(from:MLDictionaryFeatureProvider(dictionary:["input":MLFeatureValue(multiArray:input)]))
        guard let array = output.featureValue(for:"scores")?.multiArrayValue,
              array.shape.count == 3, array.shape[0].intValue == 1, array.shape[2].intValue == dictionary.count,
              array.shape[1].intValue>0, array.shape[1].intValue<=1024 else { throw Failure.invalidOutput }
        let steps = array.shape[1].intValue
        if array.dataType == .float32, array.strides.map(\.intValue) == [steps*dictionary.count,dictionary.count,1] {
            return (Array(UnsafeBufferPointer(start:array.dataPointer.assumingMemoryBound(to:Float.self),count:array.count)),steps)
        }
        var values:[Float] = [];values.reserveCapacity(array.count)
        // Unusual noncontiguous layouts retain a correct bounded fallback.
        for t in 0..<array.shape[1].intValue { for c in 0..<dictionary.count {
            values.append(array[[0,NSNumber(value:t),NSNumber(value:c)]].floatValue)
        } }
        return (values,array.shape[1].intValue)
    }

    /// Pinned BGR, unpadded observed crop, bilinear8-bit resize,48px height,zero tensor
    /// padding to320 columns, then pixel/127.5-1. No language/route-conditioned transform.
    func makeInput(image: CIImage, region: CGRect) throws -> MLMultiArray {
        guard [region.minX,region.minY,region.width,region.height].allSatisfy(\.isFinite),
              !region.isEmpty, CGRect(x:0,y:0,width:1,height:1).contains(region) else { throw Failure.invalidPixels }
        let pixels = CGRect(x:image.extent.minX+region.minX*image.extent.width,
            y:image.extent.minY+(1-region.maxY)*image.extent.height,
            width:region.width*image.extent.width,height:region.height*image.extent.height).integral.intersection(image.extent)
        guard pixels.width>=4,pixels.height>=4,pixels.width<=4096,pixels.height<=1024,pixels.width*pixels.height<=1_048_576,
              let cg = context.createCGImage(image,from:pixels,format:.RGBA8,colorSpace:CGColorSpace(name:CGColorSpace.sRGB)),
              cg.bitsPerComponent == 8,cg.bitsPerPixel == 32,cg.bytesPerRow>=cg.width*4,
              let data = cg.dataProvider?.data,CFDataGetLength(data)>=cg.bytesPerRow*cg.height,
              let rgba = CFDataGetBytePtr(data) else { throw Failure.invalidPixels }
        var bgr = [UInt8](repeating:0,count:cg.width*cg.height*3)
        for y in 0..<cg.height { for x in 0..<cg.width { for c in 0..<3 {
            bgr[(y*cg.width+x)*3+c] = rgba[y*cg.bytesPerRow+x*4+2-c]
        } } }
        return try makeInput(bgr:bgr,width:cg.width,height:cg.height)
    }

    /// Same bounded preprocessing seam is exercised on immutable raw pixel fixtures.
    func makeInput(bgr:[UInt8],width sourceWidth:Int,height sourceHeight:Int) throws -> MLMultiArray {
        guard sourceWidth>=4,sourceHeight>=4,sourceWidth<=4096,sourceHeight<=1024,
              sourceWidth*sourceHeight<=1_048_576,bgr.count==sourceWidth*sourceHeight*3 else { throw Failure.invalidPixels }
        let width = min(320,max(1,Int(ceil(48*Double(sourceWidth)/Double(sourceHeight)))))
        let tensor = try MLMultiArray(shape:[1,3,48,320],dataType:.float32)
        guard tensor.strides.map(\.intValue) == [3*48*320,48*320,320,1] else { throw Failure.invalidPixels }
        let destination = tensor.dataPointer.assumingMemoryBound(to:Float.self)
        destination.initialize(repeating:0,count:tensor.count)
        // Pin preprocessing to the validated OpenCV5.1/KleidiCV26.09 arm64 contract.
        // Generic3-channel coordinate arithmetic adapted from Arm's Apache-2.0 source:
        // https://gitlab.arm.com/kleidi/kleidicv/-/blob/26.09/kleidicv/src/resize/resize_linear_generic_u8_neon.h
        // Copyright2026 Arm Limited and/or its affiliates. Modified: scalar Swift, bounded
        // arrays, no SIMD overreads. This does not claim parity with every OpenCV backend.
        guard sourceWidth*3>=32, sourceWidth<=width*3 else { throw Failure.invalidPixels }
        func roundedDivide(_ numerator:Int,_ denominator:Int) -> Int { (numerator+denominator/2)/denominator }
        func aligned(_ coordinate:Int,_ source:Int,_ output:Int) -> Int {
            roundedDivide(((coordinate<<16)+32768)*source,output)-32768+1
        }
        func clamp(_ value:Int,_ maximum:Int) -> Int { min(maximum,max(0,value)) }
        func interpolate(_ a:Int,_ b:Int,_ fraction:Int) -> Int { a+(((b-a)*fraction+16384)>>15) }
        let vectorBytes = width*2>sourceWidth*3 ? 16 : (width>=sourceWidth || Double(sourceWidth)/Double(width)<1.8 ? 32:48)
        let fullVectors = sourceWidth*3>=vectorBytes ? (width*3/32)*2:0
        var coordinates = [Int](repeating:0,count:width*3)
        let initial = roundedDivide(sourceWidth<<31,width)-(1<<31)+(3<<15)
        let step32 = roundedDivide((sourceWidth*16)<<32,width)
        for element in 0..<(fullVectors*16) {
            let group = element/48,localPixel = (element%48)/3
            coordinates[element] = ((initial+group*step32)>>16)+roundedDivide((localPixel*sourceWidth)<<16,width)
        }
        var cursor = fullVectors*16
        let tails = (width*3-cursor+7)/8
        for _ in 0..<tails {
            cursor = min(cursor,width*3-8)
            let pixel = cursor/3,anchor = aligned(pixel,sourceWidth,width)
            let step = roundedDivide(sourceWidth<<16,width)
            for element in cursor..<(cursor+8) { coordinates[element] = anchor+(element/3-pixel)*step }
            cursor += 8
        }
        for y in 0..<48 {
            let qy = aligned(y,sourceHeight,48),fy = (qy&65535)>>1
            let y0 = clamp(qy>>16,sourceHeight-1),y1 = clamp((qy>>16)+1,sourceHeight-1)
            for x in 0..<width { for channel in 0..<3 {
                let qx = coordinates[x*3+channel],fx = (qx&65535)>>1
                let x0 = clamp(qx>>16,sourceWidth-1),x1 = clamp((qx>>16)+1,sourceWidth-1)
                let a = Int(bgr[(y0*sourceWidth+x0)*3+channel]),b = Int(bgr[(y0*sourceWidth+x1)*3+channel])
                let c = Int(bgr[(y1*sourceWidth+x0)*3+channel]),d = Int(bgr[(y1*sourceWidth+x1)*3+channel])
                var pixel = interpolate(interpolate(a,b,fx),interpolate(c,d,fx),fy)
                // The backend dispatches exact half-size in both axes to its area kernel.
                if sourceWidth==width*2 && sourceHeight==96 {
                    let offset = ((y*2)*sourceWidth+x*2)*3+channel
                    pixel = (Int(bgr[offset])+Int(bgr[offset+3])+Int(bgr[offset+sourceWidth*3])+Int(bgr[offset+sourceWidth*3+3])+2)>>2
                }
                destination[channel*48*320+y*320+x] = Float(pixel)/127.5-1
            } }
        }
        return tensor
    }
}
