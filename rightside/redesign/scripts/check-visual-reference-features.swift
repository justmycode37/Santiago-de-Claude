import Foundation
import ImageIO
import simd
struct FeatureFixture:Decodable {
    struct Item:Decodable {let id:String;let image:String;let expectedMatch:Bool}
    let reference:String;let calibration:SpatialCameraCalibration;let plane:VisualReferencePlane;let cases:[Item]
}
@main struct FeaturesReplay {
    static func raster(_ url:URL)throws->(CGImage,VisualReferenceRaster) {
        guard let source=CGImageSourceCreateWithURL(url as CFURL,nil),let image=CGImageSourceCreateImageAtIndex(source,0,nil),let r=VisualReferenceRaster(image:image,width:640,height:480) else {throw NSError(domain:"image",code:1)}
        return (image,r)
    }
    static func main()throws {
        let mode=CommandLine.arguments[1],directory=URL(fileURLWithPath:CommandLine.arguments[2])
        let fixture=mode == "synthetic" ? try JSONDecoder().decode(FeatureFixture.self,from:Data(contentsOf:directory.appendingPathComponent("manifest.json"))) : nil
        let (referenceImage,reference)=try raster(directory.appendingPathComponent(fixture?.reference ?? "1.png"))
        let cases=fixture?.cases ?? [FeatureFixture.Item(id:"2",image:"2.png",expectedMatch:true),.init(id:"6",image:"6.png",expectedMatch:true)]
        for item in cases {
            let (cameraImage,camera)=try raster(directory.appendingPathComponent(item.image))
            let start=Date();let proposal=VisualReferenceFeatures.propose(reference:reference,camera:camera)
            var row:[String:Any]=["id":item.id,"expectedMatch":item.expectedMatch,"proposal":proposal != nil,"featureMilliseconds":Date().timeIntervalSince(start)*1000,"accepted":false,"mode":mode,"cameraOriginalSize":[cameraImage.width,cameraImage.height],"referenceOriginalSize":[referenceImage.width,referenceImage.height],"normalizedSize":[640,480]]
            if let proposal {
                row["referenceFeatures"]=proposal.referenceFeatureCount;row["cameraFeatures"]=proposal.cameraFeatureCount;row["mutualMatches"]=proposal.mutualMatchCount;row["inliers"]=proposal.inlierCount;row["symmetricMedianPixels"]=proposal.medianSymmetricErrorPixels
                row["proposalH"]=(0..<3).flatMap{c in (0..<3).map{proposal.homography[c][$0]}}
                let refineStart=Date()
                let registered=try VisualReferenceMatcher.register(reference:reference,camera:camera,proposals:[proposal.homography])
                row["downstreamMilliseconds"]=Date().timeIntervalSince(refineStart)*1000
                if let registered {
                    row["accepted"]=true;row["H"]=(0..<3).flatMap{c in (0..<3).map{registered.homography[c][$0]}};row["correlation"]=registered.correlation
                    if let fixture {
                        let pose=VisualReferenceGeometry.pose(h:registered.homography,referenceWidth:640,referenceHeight:480,calibration:fixture.calibration,plane:fixture.plane)
                        row["accepted"]=pose != nil
                        if let pose {row["pose"]=(0..<4).flatMap{c in (0..<4).map{pose.siteFromCamera[c][$0]}}}
                    }
                }
            }
            row["seconds"]=Date().timeIntervalSince(start)
            print(String(data:try JSONSerialization.data(withJSONObject:row,options:[.sortedKeys]),encoding:.utf8)!)
        }
    }
}
