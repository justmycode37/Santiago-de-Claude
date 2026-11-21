import Foundation
import XCTest
import simd

private struct Benchmark:Decodable {
    struct View:Decodable {
        struct Observation:Decodable { let landmarkID:String;let sitePoint:[Double];let pixel:[Double] }
        let id:String;let truth:[Double];let initial:[Double];let observations:[Observation];let targets:[[Double]];let truthTargetPixels:[[Double]];let hasOutliers:Bool
    }
    let calibration:SpatialCameraCalibration;let views:[View];let evidenceKind:String;let seed:Int
}
@main struct SpatialChecks {
    static func matrix(_ a:[Double])->simd_double4x4 {
        precondition(a.count==16)
        return simd_double4x4(columns:(SIMD4(a[0],a[1],a[2],a[3]),SIMD4(a[4],a[5],a[6],a[7]),SIMD4(a[8],a[9],a[10],a[11]),SIMD4(a[12],a[13],a[14],a[15])))
    }
    static func quantile(_ values:[Double],_ p:Double)->Double {
        let a=values.sorted();return a[min(a.count-1,Int(ceil(Double(a.count)*p))-1)]
    }
    static func main() throws {
        let suite=SpatialReferenceTests.defaultTestSuite;suite.run()
        guard suite.testRun?.hasSucceeded==true,suite.testRun?.executionCount==11 else { exit(1) }
        let args=ProcessInfo.processInfo.arguments
        guard args.count==3 else { fatalError("Provide heldout.json and result.json") }
        let dataset=try JSONDecoder().decode(Benchmark.self,from:Data(contentsOf:URL(fileURLWithPath:args[1])))
        var rows=[[String:Any]](), horizontal=[Double](),heading=[Double](),registration=[Double](),latency=[Double](),reprojection=[Double]()
        var acceptedOutliers=0
        for view in dataset.views {
            let observations=view.observations.map { SpatialImageCorrespondence(landmarkID:$0.landmarkID,sitePoint:SIMD3($0.sitePoint[0],$0.sitePoint[1],$0.sitePoint[2]),pixel:SIMD2($0.pixel[0],$0.pixel[1])) }
            let begin=ProcessInfo.processInfo.systemUptime
            guard let fit=CalibratedPoseGeometry.refine(initial:matrix(view.initial),observations:observations,calibration:dataset.calibration) else {
                rows.append(["id":view.id,"status":"rejected"]);continue
            }
            let elapsed=(ProcessInfo.processInfo.systemUptime-begin)*1000
            let truth=matrix(view.truth),pose=fit.siteFromCamera
            let error=simd_distance(SIMD2(truth[3].x,truth[3].y),SIMD2(pose[3].x,pose[3].y))
            let a=atan2(-truth[2].x,-truth[2].y),b=atan2(-pose[2].x,-pose[2].y)
            let h=abs(atan2(sin(a-b),cos(a-b)))*180 / .pi
            let targetErrors=view.targets.enumerated().compactMap { index,p -> Double? in
                CalibratedPoseGeometry.project(SIMD3(p[0],p[1],p[2]),siteFromCamera:pose,calibration:dataset.calibration).map {
                    simd_distance($0,SIMD2(view.truthTargetPixels[index][0],view.truthTargetPixels[index][1]))
                }
            }
            guard targetErrors.count==view.targets.count else { fatalError("Accepted fit lost held-out registration targets") }
            let reg=targetErrors.max()!
            horizontal.append(error);heading.append(h);registration.append(reg);latency.append(elapsed);reprojection.append(fit.rmsReprojectionPixels)
            if view.hasOutliers { acceptedOutliers+=1 }
            rows.append(["id":view.id,"status":"accepted","horizontalMeters":error,"headingDegrees":h,"heldOutRegistrationPixels":reg,"fitResidualPixels":fit.rmsReprojectionPixels,"solverMilliseconds":elapsed,"inliers":fit.inlierIndices.count])
        }
        guard !horizontal.isEmpty else { fatalError("No accepted benchmark poses") }
        let result:[String:Any]=["evidenceLevel":"automated_synthetic_geometry_only","datasetSeed":dataset.seed,"total":dataset.views.count,"accepted":horizontal.count,"rejected":dataset.views.count-horizontal.count,"acceptedWithOutliers":acceptedOutliers,
            "horizontalMedianMeters":quantile(horizontal,0.5),"horizontalP95Meters":quantile(horizontal,0.95),"headingMedianDegrees":quantile(heading,0.5),"headingP95Degrees":quantile(heading,0.95),"heldOutRegistrationMedianPixels":quantile(registration,0.5),"heldOutRegistrationP95Pixels":quantile(registration,0.95),"solverMedianMilliseconds":quantile(latency,0.5),"solverP95Milliseconds":quantile(latency,0.95),"unitTestsPassed":11,"fieldAccuracyClaim":false,"rows":rows]
        try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]).write(to:URL(fileURLWithPath:args[2]))
        print("SYNTHETIC GEOMETRY: accepted \(horizontal.count)/\(dataset.views.count); horizontal median/p95 \(quantile(horizontal,0.5))/\(quantile(horizontal,0.95)) m; heading median/p95 \(quantile(heading,0.5))/\(quantile(heading,0.95)) deg; held-out registration p95 \(quantile(registration,0.95)) px")
        // Declared synthetic computation gates, independent of field/device readiness.
        guard horizontal.count>=108,quantile(horizontal,0.95)<0.15,quantile(heading,0.95)<1,quantile(registration,0.95)<5 else { exit(2) }
    }
}
