import XCTest
import CoreML
#if canImport(RightSide)
@testable import RightSide
#endif

final class TransportDecoderTests: XCTestCase {
    func testThreeClassInstanceMasksDecodeSeparatelyAndRespectBoxes() throws {
        let boxes = try MLMultiArray(shape: [1,39,3], dataType: .float32)
        let prototypes = try MLMultiArray(shape: [1,32,128,128], dataType: .float32)
        memset(boxes.dataPointer, 0, boxes.count * 4)
        memset(prototypes.dataPointer, 0, prototypes.count * 4)
        for i in 0..<(128*128) { prototypes[i] = 1 }
        for column in 0..<3 {
            boxes[column] = NSNumber(value: 90 + column * 165)
            boxes[3 + column] = 256
            boxes[6 + column] = 80
            boxes[9 + column] = 200
            boxes[(4 + column) * 3 + column] = 0.9
            boxes[7 * 3 + column] = 1
        }
        let result = TransportSegmenter.decode(boxes: boxes, prototypes: prototypes, imageSize: CGSize(width:512,height:512), scale: 1,padding: .zero)
        XCTAssertEqual(Set(result.map(\.kind)), Set(TransportClass.allCases))
        XCTAssertEqual(result.count, 3)
        for d in result {
            XCTAssertTrue(d.mask.contains(CGPoint(x:d.box.midX,y:d.box.midY)))
            XCTAssertFalse(d.mask.contains(CGPoint(x:0,y:0)))
            XCTAssertLessThan(d.mask.pixels.filter { $0 == 1 }.count, 128 * 128 / 3)
        }
    }
    func testClassAmbiguityIsNotResolvedUsingJourneyMode() throws {
        let boxes = try MLMultiArray(shape: [1,39,1],dataType:.float32)
        let prototypes = try MLMultiArray(shape: [1,32,128,128],dataType:.float32)
        memset(boxes.dataPointer,0,boxes.count*4); memset(prototypes.dataPointer,0,prototypes.count*4)
        boxes[0]=256; boxes[1]=256; boxes[2]=200; boxes[3]=200; boxes[4]=0.8; boxes[5]=0.79; boxes[7]=1
        XCTAssertTrue(TransportSegmenter.decode(boxes:boxes,prototypes:prototypes,imageSize:CGSize(width:512,height:512),scale:1,padding:.zero).isEmpty)
    }
    func testMalformedTensorFailsClosed() throws {
        let invalid = try MLMultiArray(shape:[1,6,1],dataType:.float32)
        XCTAssertTrue(TransportSegmenter.decode(boxes:invalid,prototypes:invalid,imageSize:CGSize(width:512,height:512),scale:1,padding:.zero).isEmpty)
    }
}
