import Foundation
import CoreML
import CoreImage
import CryptoKit

/// Native runtime candidate. Kept outside the app until original-model parity is accepted.
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
                   trackID: UUID, frameID: UUID, capturedAt: Date) throws -> AlternativeDisplayObservation? {
        let input = try makeInput(image:image,region:proposal.region)
        let values = try scores(input:input)
        guard let result = VehicleDisplayCTC.decode(values.values,steps:values.steps,dictionary:dictionary) else { return nil }
        return AlternativeDisplayObservation(engineID:VehicleDisplayRecognitionPolicy.engineID,
            modelID:VehicleDisplayRecognitionPolicy.modelID,configID:VehicleDisplayRecognitionPolicy.configID,
            frameID:frameID,capturedAt:capturedAt,trackID:trackID,text:result.text,
            characterScores:result.characterScores,region:proposal.region,samplingID:"native")
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
        let width = min(320,max(1,Int(ceil(48*Double(cg.width)/Double(cg.height)))))
        let tensor = try MLMultiArray(shape:[1,3,48,320],dataType:.float32)
        guard tensor.strides.map(\.intValue) == [3*48*320,48*320,320,1] else { throw Failure.invalidPixels }
        let destination = tensor.dataPointer.assumingMemoryBound(to:Float.self)
        destination.initialize(repeating:0,count:tensor.count)
        for y in 0..<48 {
            let sy = min(Double(cg.height-1),max(0,(Double(y)+0.5)*Double(cg.height)/48-0.5))
            let y0 = Int(floor(sy)), y1 = min(cg.height-1,y0+1), fy = sy-Double(y0)
            for x in 0..<width {
                let sx = min(Double(cg.width-1),max(0,(Double(x)+0.5)*Double(cg.width)/Double(width)-0.5))
                let x0 = Int(floor(sx)),x1 = min(cg.width-1,x0+1),fx = sx-Double(x0)
                for channel in 0..<3 {
                    let component = 2-channel
                    let top = Double(rgba[y0*cg.bytesPerRow+x0*4+component])*(1-fx)+Double(rgba[y0*cg.bytesPerRow+x1*4+component])*fx
                    let bottom = Double(rgba[y1*cg.bytesPerRow+x0*4+component])*(1-fx)+Double(rgba[y1*cg.bytesPerRow+x1*4+component])*fx
                    let pixel = Float((top*(1-fy)+bottom*fy).rounded())
                    destination[channel*48*320+y*320+x] = pixel/127.5-1
                }
            }
        }
        return tensor
    }
}
