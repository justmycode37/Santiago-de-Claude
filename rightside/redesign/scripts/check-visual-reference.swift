import Foundation
import ImageIO
import XCTest
import simd
struct Replay: Decodable {
    struct Case: Decodable { let id:String;let image:String;let expectedMatch:Bool;let truthPose:[Double]?;let homography:[Double]?;let captureWorldFromCamera:[Float] }
    let reference:String;let calibration:SpatialCameraCalibration;let plane:VisualReferencePlane;let cases:[Case]
}
struct SceneReplay: Decodable {
    struct Reference:Decodable {let id:String;let image:String;let plane:VisualReferencePlane}
    struct Scene:Decodable {let id:String;let image:String}
    let calibration:SpatialCameraCalibration;let references:[Reference];let scenes:[Scene]
}
@main struct Check {
    static func image(_ path:URL) throws -> CGImage {
        guard let source=CGImageSourceCreateWithURL(path as CFURL,nil),let image=CGImageSourceCreateImageAtIndex(source,0,nil) else {throw NSError(domain:"decode",code:1)}
        return image
    }
    static func main() throws {
        let suite=XCTestSuite(name:"C2 plus preserved spatial/manager frame regressions")
        suite.addTest(VisualReferenceTests.defaultTestSuite)
        suite.addTest(SpatialReferenceTests.defaultTestSuite)
        suite.addTest(LocalPoseFrameTests.defaultTestSuite)
        suite.run()
        guard suite.testRun?.hasSucceeded == true,suite.testRun?.executionCount == 32 else {exit(1)}
        let directory=URL(fileURLWithPath:CommandLine.arguments[1]);let replay=try JSONDecoder().decode(Replay.self,from:Data(contentsOf:directory.appendingPathComponent("manifest.json")))
        let reference=VisualReferenceRaster(image:try image(directory.appendingPathComponent(replay.reference)),width:640,height:480)!
        var positives=0, falseAccepted=0
        for item in replay.cases {
            let start=Date(); let camera=VisualReferenceRaster(image:try image(directory.appendingPathComponent(item.image)),width:640,height:480)!
            let result=try VisualReferenceMatcher.match(reference:reference,camera:camera,originalCalibration:replay.calibration,plane:replay.plane)
            let values=item.captureWorldFromCamera
            let capturedWorld=simd_float4x4(columns:(SIMD4(values[0..<4]),SIMD4(values[4..<8]),SIMD4(values[8..<12]),SIMD4(values[12..<16])))
            let capturedContext=VisualReferenceFrameContext(epoch:UUID(),calibration:replay.calibration,worldFromCamera:capturedWorld,
                capturedAt:Date(),uptime:ProcessInfo.processInfo.systemUptime,orientation:"raw_sensor",worldUp:SIMD3(0,1,0),gravityReliable:true,crop:[0,0,1,1])
            let frameAccepted=result.map{VisualReferenceFrameGate.agrees(siteFromCamera:$0.pose.siteFromCamera,context:capturedContext)} ?? false
            if frameAccepted {if item.expectedMatch {positives += 1} else {falseAccepted += 1}}
            var record:[String:Any]=["id":item.id,"accepted":frameAccepted,"pixelOnlyAccepted":result != nil,"expectedMatch":item.expectedMatch,"seconds":Date().timeIntervalSince(start)]
            if let raw=try VisualReferenceMatcher.rawHomography(reference:reference,camera:camera) {
                record["rawH"]=(0..<3).flatMap{c in (0..<3).map{raw[c][$0]}}
                record["rawAccepted"]=VisualReferenceMatcher.validate(h:raw,reference:reference,camera:camera) != nil
                let flip=simd_double3x3(columns:(SIMD3(1,0,0),SIMD3(0,-1,0),SIMD3(0,480,1)))
                if let refined=VisualReferenceRefinement.refine(seed:flip*raw*flip,reference:reference,camera:camera) {
                    record["refinedH"]=(0..<3).flatMap{c in (0..<3).map{refined[c][$0]}}
                }
            }
            if let result {record["pose"]=(0..<4).flatMap{c in (0..<4).map{result.pose.siteFromCamera[c][$0]}};record["correlation"]=result.correlation;record["metricResidualPixels"]=result.pose.metricResidualPixels;record["H"]=(0..<3).flatMap{c in (0..<3).map{result.pose.referenceToCameraPixels[c][$0]}}}
            print(String(data:try JSONSerialization.data(withJSONObject:record,options:[.sortedKeys]),encoding:.utf8)!)
        }
        let scenes=try JSONDecoder().decode(SceneReplay.self,from:Data(contentsOf:directory.appendingPathComponent("scenes.json")))
        let references=try scenes.references.map {VisualReferenceImage(plane:$0.plane,image:try image(directory.appendingPathComponent($0.image)))}
        let pipeline=VisualReferencePipeline(references:references)
        let epoch=UUID(),base=Date()
        var consensus=LocalPoseConsensus(),reliable=0
        for (index,scene) in scenes.scenes.enumerated() {
            let at=base.addingTimeInterval(Double(index)*0.2)
            let context=VisualReferenceFrameContext(epoch:epoch,calibration:scenes.calibration,worldFromCamera:matrix_identity_float4x4,capturedAt:at,uptime:Double(index)*0.2,orientation:"raw_sensor",worldUp:SIMD3(0,1,0),gravityReliable:true,crop:[0,0,1,1])
            let start=Date()
            let result=pipeline.process(image:try image(directory.appendingPathComponent(scene.image)),context:context)
            let assessment=consensus.update(estimates:result.estimates,worldFromCamera:context.worldFromCamera,at:at,now:at,trackingNormal:true,errorBoundMeters:0.3,headingBoundDegrees:3,verticalErrorBoundMeters:0.2)
            if assessment.status == .reliable {reliable += 1}
            var record:[String:Any]=["id":scene.id,"scene":true,"referenceIDs":result.matches.map(\.id),"reason":result.reason,"state":assessment.status.rawValue,"seconds":Date().timeIntervalSince(start)]
            record["matches"]=result.matches.map {match -> [String:Any] in
                ["id":match.id,"pose":(0..<4).flatMap{c in (0..<4).map{match.pose.siteFromCamera[c][$0]}},"H":(0..<3).flatMap{c in (0..<3).map{match.pose.referenceToCameraPixels[c][$0]}},"correlation":match.correlation]
            }
            if let pose=assessment.siteFromCamera {record["pose"]=(0..<4).flatMap{c in (0..<4).map{pose[c][$0]}}}
            print(String(data:try JSONSerialization.data(withJSONObject:record,options:[.sortedKeys]),encoding:.utf8)!)
        }
        let capturePassed=try VisualReferenceCaptureReplay.run(directory:directory)
        guard positives >= 2,falseAccepted == 0,reliable >= 1,capturePassed else {exit(2)}
    }
}
