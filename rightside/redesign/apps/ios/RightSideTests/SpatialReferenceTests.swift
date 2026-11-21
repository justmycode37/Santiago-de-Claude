import XCTest
import simd
#if !SPATIAL_HARNESS
@testable import RightSide
#endif

final class SpatialReferenceTests: XCTestCase {
    let time=SpatialTime.date("2026-11-21T04:00:00Z")!
    let digest=String(repeating:"a",count:64)
    func source(_ fetched:String="2026-11-21T03:00:00Z",_ expiry:String="2026-11-22T03:00:00Z") -> SpatialSource {
        SpatialSource(id:"atlas",url:"https://example.test/atlas",sha256:digest,fetchedAt:fetched,expiresAt:expiry,license:"test",attribution:"synthetic test")
    }
    func call(revision:String="1",sequence:Int=2,day:String="2026-11-21") -> SpatialCallIdentity {
        SpatialCallIdentity(provider:"test-provider",tripID:"trip-7",serviceDay:day,stopID:"8507000",stopSequence:sequence,assignmentRevision:revision,sourceSnapshotID:digest)
    }
    func repository(_ source:SpatialSource?=nil) throws -> SpatialRepository {
        let a=SpatialFeature(id:"west",kind:.boardingReference,name:"Bern",sourceID:"atlas",geometry:[SpatialCoordinate(latitude:46.948,longitude:7.44)],precision:.boardingReference,parentStopID:"ch:1:sloid:7000",parentStopAliases:["8507000"],signLabel:"5",validFrom:"2026-01-01",validUntil:"2026-12-31")
        let b=SpatialFeature(id:"east",kind:.boardingReference,name:"Bern",sourceID:"atlas",geometry:[SpatialCoordinate(latitude:46.948,longitude:7.441)],precision:.boardingReference,parentStopID:"ch:1:sloid:7000",parentStopAliases:["8507000"],signLabel:"5",validFrom:"2026-01-01",validUntil:"2026-12-31")
        return try SpatialRepository(pack:SpatialPack(schemaVersion:1,id:"test",version:"1",bbox:[7.4,46.9,7.5,47],sources:[source ?? self.source()],features:[a,b],referenceCatalogues:[]))
    }
    func request(_ call:SpatialCallIdentity?=nil, assignmentCall:SpatialCallIdentity?=nil) -> SpatialRequest {
        let c=call ?? self.call()
        let provider=SpatialSource(id:"assignment",url:"https://example.test/calls",sha256:digest,fetchedAt:"2026-11-21T03:59:00Z",expiresAt:"2026-11-21T04:04:00Z",license:"test",attribution:"synthetic call",provider:"test-provider")
        let assignment=SpatialBoardingAssignment(call:assignmentCall ?? c,boardingPointID:"west",sourceID:"assignment",observedAt:"2026-11-21T03:59:00Z",validUntil:"2026-11-21T04:04:00Z",evidenceReference:"fixture:exact-call-row-2")
        return SpatialRequest(stopID:"8507000",signLabel:"5",call:c,assignment:assignment,assignmentSource:provider)
    }
    func testParentAndDuplicateLabelNeverResolveSideOrFloor() throws {
        let r=try repository().resolve(request:SpatialRequest(stopID:"8507000",signLabel:"5"),at:time)
        XCTAssertEqual(r.status,.candidate);XCTAssertEqual(r.candidates.count,2);XCTAssertNil(r.boardingPointID)
        XCTAssertFalse(r.confirmsWaitingArea);XCTAssertTrue(r.candidates.allSatisfy { $0.level == nil })
    }
    func testExactOccurrenceResolvesReferenceOnly() throws {
        let r=try repository().resolve(request:request(),at:time)
        XCTAssertEqual(r.status,.resolved);XCTAssertEqual(r.boardingPointID,"west");XCTAssertEqual(r.precision,.boardingReference)
        XCTAssertFalse(r.confirmsWaitingArea);XCTAssertNil(r.boardingPoint?.level)
        XCTAssertEqual(r.sources.count,2)
        // A map/camera both receiving this immutable result see identical identity/precision.
        let same=try repository().resolve(request:request(),at:time)
        XCTAssertEqual(same.boardingPointID,r.boardingPointID);XCTAssertEqual(same.coordinate,r.coordinate)
    }
    func testRepeatedCallRevisionDaySnapshotAndLabelConflictsClearIdentity() throws {
        let repo=try repository()
        for changed in [call(revision:"2"),call(sequence:7),call(day:"2026-11-20")] {
            XCTAssertNil(repo.resolve(request:request(changed,assignmentCall:call()),at:time).boardingPointID)
        }
        var label=request();label.signLabel="7"
        XCTAssertNil(repo.resolve(request:label,at:time).boardingPointID)
        var snapshot=request();snapshot.assignmentSource=SpatialSource(id:"assignment",url:"https://example.test",sha256:String(repeating:"b",count:64),fetchedAt:"2026-11-21T03:59:00Z",expiresAt:"2026-11-21T04:04:00Z",license:"test",attribution:"test",provider:"test-provider")
        XCTAssertNil(repo.resolve(request:snapshot,at:time).boardingPointID)
    }
    func testExpiredFutureMalformedAndOldAssignmentsAbstain() throws {
        for s in [source("2026-11-19T03:00:00Z","2026-11-20T03:00:00Z"),source("2026-11-22T03:00:00Z","2026-11-23T03:00:00Z"),source("not-date","invalid")] {
            XCTAssertNil(try repository(s).resolve(request:request(),at:time).boardingPointID)
        }
        XCTAssertNil(try repository().resolve(request:request(),at:time.addingTimeInterval(301)).boardingPointID)
        var staleBase=source();staleBase.contentTimestamp="2025-01-01T00:00:00Z";XCTAssertEqual(staleBase.freshness(at:time),.stale)
        var malformedBase=source();malformedBase.contentTimestamp="118625";XCTAssertEqual(malformedBase.freshness(at:time),.invalid)
    }
    func testSwissCalendarRolloverAndMalformedCivilDays() {
        XCTAssertEqual(SpatialTime.swissDay(SpatialTime.date("2026-11-20T23:30:00Z")!),"2026-11-21")
        XCTAssertEqual(SpatialTime.swissDay(SpatialTime.date("2026-06-20T22:30:00Z")!),"2026-06-21")
        XCTAssertTrue(SpatialTime.isDay("2028-02-29"));XCTAssertFalse(SpatialTime.isDay("2026-02-29"))
        XCTAssertFalse(SpatialTime.isDay("2026-2-01"));XCTAssertFalse(SpatialTime.isDay("0000-01-01"))
        XCTAssertFalse(call(day:"2026-02-29").isValid)
    }
    func testReferenceValidityUsesBoardingCivilDayNotServiceDay() throws {
        let repo=try repository()
        var nextYear=request(call(day:"2026-12-31"))
        nextYear.boardingAt=SpatialTime.date("2026-12-31T23:30:00Z") // Swiss Jan 1; service-day Dec 31.
        XCTAssertEqual(repo.resolve(request:nextYear,at:time).status,.unknown)
        var overnight=request(call(day:"2025-12-31"))
        overnight.boardingAt=SpatialTime.date("2025-12-31T23:30:00Z") // Swiss Jan 1; reference has become valid.
        XCTAssertEqual(repo.resolve(request:overnight,at:time).status,.resolved)
    }
    func testRealPackAndBundleReaderKeepOriginalIdentitiesAndCandidateCoverage() throws {
        let repo:SpatialRepository
        if let path=ProcessInfo.processInfo.environment["SPATIAL_PACK_PATH"] { repo=try .load(url:URL(fileURLWithPath:path)) }
        else { repo=try XCTUnwrap(SpatialRepository.bundled()) }
        XCTAssertGreaterThan(repo.pack.features.filter { $0.kind == .boardingReference }.count,601)
        XCTAssertGreaterThan(repo.pack.features.filter { $0.kind == .entrance }.count,100)
        XCTAssertGreaterThan(repo.pack.features.filter { $0.kind == .pedestrianPath }.count,100)
        let bern=repo.resolve(request:SpatialRequest(stopID:"8507000",signLabel:"5"),at:time)
        XCTAssertGreaterThan(bern.candidates.count,1);XCTAssertNil(bern.boardingPointID)
        XCTAssertTrue(bern.candidates.allSatisfy { $0.name == "Bern" && $0.signLabel == "5" && $0.level == nil })
        XCTAssertFalse(repo.nearbyFeatures(to:SpatialCoordinate(latitude:46.948,longitude:7.44)).isEmpty)
        if let path=ProcessInfo.processInfo.environment["SPATIAL_BUNDLE_PATH"] {
            let bundle=try XCTUnwrap(Bundle(url:URL(fileURLWithPath:path)))
            XCTAssertEqual(try XCTUnwrap(SpatialRepository.bundled(bundle:bundle)).pack.version,repo.pack.version)
        }
    }
    func testConsensusNeedsIndependentReferencesAndFreshFrames() {
        var tracker=LocalPoseConsensus();let pose=matrix_identity_float4x4
        let refs=[LocalPoseReferenceEstimate(landmarkID:"A",siteFromWorld:pose),LocalPoseReferenceEstimate(landmarkID:"B",siteFromWorld:pose)]
        func step(_ seconds:Double)->LocalPoseAssessment { let t=time.addingTimeInterval(seconds);return tracker.update(estimates:refs,worldFromCamera:pose,at:t,now:t,trackingNormal:true,errorBoundMeters:0.3,headingBoundDegrees:2, verticalErrorBoundMeters: 0.3) }
        XCTAssertEqual(step(0).status,.candidate);XCTAssertNil(step(0.2).siteFromWorld);XCTAssertEqual(step(0.4).status,.reliable)
        let loss=tracker.invalidate(at:time.addingTimeInterval(0.5),reason:"tracking_lost");XCTAssertEqual(loss.status,.relocalizing);XCTAssertNil(loss.siteFromCamera)
        XCTAssertEqual(step(0.6).status,.relocalizing);_ = step(0.8);XCTAssertEqual(step(1).status,.reliable)
        let stale=tracker.update(estimates:refs,worldFromCamera:pose,at:time,now:time.addingTimeInterval(5),trackingNormal:true,errorBoundMeters:0.3,headingBoundDegrees:2, verticalErrorBoundMeters: 0.3)
        XCTAssertNil(stale.siteFromWorld)
    }
    func testConsensusRejectsDuplicateMirroredDisagreeingAndDriftingReferences() {
        let identity=matrix_identity_float4x4
        var shifted=identity;shifted[3].x=5
        var mirrored=identity;mirrored[0].x = -1
        for refs in [[LocalPoseReferenceEstimate(landmarkID:"A",siteFromWorld:identity),LocalPoseReferenceEstimate(landmarkID:"A",siteFromWorld:identity)],
                     [LocalPoseReferenceEstimate(landmarkID:"A",siteFromWorld:identity),LocalPoseReferenceEstimate(landmarkID:"B",siteFromWorld:shifted)],
                     [LocalPoseReferenceEstimate(landmarkID:"A",siteFromWorld:mirrored),LocalPoseReferenceEstimate(landmarkID:"B",siteFromWorld:mirrored)]] {
            var tracker=LocalPoseConsensus()
            let r=tracker.update(estimates:refs,worldFromCamera:identity,at:time,now:time,trackingNormal:true,errorBoundMeters:0.3,headingBoundDegrees:2, verticalErrorBoundMeters: 0.3)
            XCTAssertNil(r.siteFromWorld);XCTAssertNotEqual(r.status,.reliable)
        }
        var tracker=LocalPoseConsensus()
        for (i,matrix) in [identity,identity,identity,shifted].enumerated() {
            let t=time.addingTimeInterval(Double(i)*0.2)
            let r=tracker.update(estimates:[.init(landmarkID:"A",siteFromWorld:matrix),.init(landmarkID:"B",siteFromWorld:matrix)],worldFromCamera:identity,at:t,now:t,trackingNormal:true,errorBoundMeters:0.3,headingBoundDegrees:2, verticalErrorBoundMeters: 0.3)
            if i==3 { XCTAssertNil(r.siteFromWorld);XCTAssertEqual(r.status,.relocalizing) }
        }
    }
    func testCalibrationAndDegenerateGeometryAbstain() {
        let k=SpatialCameraCalibration(width:1280,height:960,fx:900,fy:900,cx:640,cy:480,imageOrientation:"raw_sensor")
        XCTAssertTrue(k.isValid)
        let o=(0..<12).map { SpatialImageCorrespondence(landmarkID:$0<6 ? "a":"b",sitePoint:SIMD3(Double($0),0,-3),pixel:SIMD2(640,480)) }
        XCTAssertNil(CalibratedPoseGeometry.refine(initial:matrix_identity_double4x4,observations:o,calibration:k))
        let wrong=SpatialCameraCalibration(width:1280,height:960,fx:0,fy:900,cx:640,cy:480,imageOrientation:"display_portrait")
        XCTAssertFalse(wrong.isValid)
        XCTAssertNil(CalibratedPoseGeometry.project(SIMD3(0,0,3),siteFromCamera:matrix_identity_double4x4,calibration:k))
    }
    func testSyntheticReferencePackCannotActivateFieldGuidance() throws {
        guard let path=ProcessInfo.processInfo.environment["SPATIAL_SYNTHETIC_SITE"] else {
            let invalid=LocalLandmarkValidation(evidenceKind:"synthetic_known_geometry",checkpointDatasetSHA256:digest,referenceSurveySHA256:String(repeating:"b",count:64),independentCheckpointCount:20,headingErrorsDegrees:Array(repeating:0.5,count:20),registrationErrorsPixels:Array(repeating:1,count:20),referenceFrame:"ENU_meters_camera_right_up_back",cameraCalibration:"ARKit_per_frame_intrinsics")
            XCTAssertFalse(invalid.isFieldEvidence);return
        }
        let pack=try JSONDecoder().decode(LocalLandmarkPack.self,from:Data(contentsOf:URL(fileURLWithPath:path)))
        let recordsURL=URL(fileURLWithPath:path).deletingLastPathComponent().appendingPathComponent("checkpoint-provenance.json")
        let bytes=try Data(contentsOf:recordsURL)
        let records=try JSONDecoder().decode(LocalLandmarkCheckpointEvidence.self,from:bytes)
        XCTAssertTrue(records.validates(pack))
        let surveyURL=URL(fileURLWithPath:path).deletingLastPathComponent().appendingPathComponent("survey-provenance.json")
        let surveyBytes=try Data(contentsOf:surveyURL)
        XCTAssertTrue(try JSONDecoder().decode(LocalLandmarkSurveyEvidence.self,from:surveyBytes).validates(pack))
        var moved=try XCTUnwrap(JSONSerialization.jsonObject(with:surveyBytes) as? [String:Any])
        moved["originLongitude"]=7.45
        XCTAssertFalse(try JSONDecoder().decode(LocalLandmarkSurveyEvidence.self,from:JSONSerialization.data(withJSONObject:moved)).validates(pack))
        var forged=try XCTUnwrap(JSONSerialization.jsonObject(with:bytes) as? [String:Any])
        forged["usedForReferenceFitting"]=true
        let invalid=try JSONDecoder().decode(LocalLandmarkCheckpointEvidence.self,from:JSONSerialization.data(withJSONObject:forged))
        XCTAssertFalse(invalid.validates(pack))
        XCTAssertTrue(pack.isValid(at:time,deviceModel:"synthetic-hardware-only"))
        XCTAssertFalse(pack.isFieldReady(at:time,deviceModel:"synthetic-hardware-only"))
        XCTAssertFalse(pack.isFieldReady(at:time,deviceModel:"iPhone99,1"))
    }
}
