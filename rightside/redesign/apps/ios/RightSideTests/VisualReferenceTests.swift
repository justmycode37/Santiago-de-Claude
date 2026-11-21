import XCTest
import simd
import CoreVideo
import CoreGraphics
#if !SPATIAL_HARNESS
@testable import RightSide
#endif

final class VisualReferenceTests: XCTestCase {
    private let identity:[Double]=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
    private let now=Date(timeIntervalSince1970:1_800_000_000)
    private func manifestHash(_ manifest:VisualReferenceManifest)throws->String {
        let encoder=JSONEncoder();encoder.outputFormatting=[.sortedKeys]
        return VisualReferenceValidation.sha256(try encoder.encode(manifest))
    }
    private var calibration:SpatialCameraCalibration {.init(width:640,height:480,fx:800,fy:800,cx:320,cy:240,imageOrientation:"raw_sensor")}
    func testSeedFreeMetricRecoveryAndPlaneFrameConversion() throws {
        let plane=VisualReferencePlane(id:"test",widthMeters:2,heightMeters:1.5,
            siteFromPlane:[1,0,0,0,0,0,1,0,0,-1,0,0,4,7,1.5,1])
        let pose=try XCTUnwrap(VisualReferenceGeometry.pose(h:matrix_identity_double3x3,referenceWidth:640,referenceHeight:480,calibration:calibration,plane:plane))
        XCTAssertEqual(pose.siteFromCamera[3].x,4,accuracy:1e-9)
        XCTAssertEqual(pose.siteFromCamera[3].y,4.5,accuracy:1e-9)
        XCTAssertEqual(pose.siteFromCamera[3].z,1.5,accuracy:1e-9)
        XCTAssertEqual(pose.metricResidualPixels,0,accuracy:1e-8)
    }
    func testNonmetricSingularUnknownCalibrationAndBacksideAbstain() {
        let plane=VisualReferencePlane(id:"test",widthMeters:2,heightMeters:1.5,siteFromPlane:identity)
        let invalid=SpatialCameraCalibration(width:640,height:480,fx:0,fy:800,cx:320,cy:240,imageOrientation:"raw_sensor")
        XCTAssertNil(VisualReferenceGeometry.pose(h:matrix_identity_double3x3,referenceWidth:640,referenceHeight:480,calibration:invalid,plane:plane))
        for h in [simd_double3x3(0),simd_double3x3(diagonal:SIMD3(1.2,1,1)),simd_double3x3(diagonal:SIMD3(-1,1,1))] {
            XCTAssertNil(VisualReferenceGeometry.pose(h:h,referenceWidth:640,referenceHeight:480,calibration:calibration,plane:plane))
        }
    }
    func testExactCaptureEpochLayoutFreshnessTrackingAndThermalContract() {
        let epoch=UUID()
        func context(orientation:String="raw_sensor",crop:[Double]=[0,0,1,1])->VisualReferenceFrameContext {
            .init(epoch:epoch,calibration:calibration,worldFromCamera:matrix_identity_float4x4,capturedAt:now,uptime:100,orientation:orientation,worldUp:SIMD3(0,1,0),gravityReliable:true,crop:crop)
        }
        XCTAssertTrue(context().usable(epoch:epoch,now:now.addingTimeInterval(0.2),uptime:100.2,trackingNormal:true,thermalAcceptable:true))
        XCTAssertFalse(context().usable(epoch:UUID(),now:now,uptime:100,trackingNormal:true,thermalAcceptable:true))
        for age in [-0.01,0.5,2] {XCTAssertFalse(context().usable(epoch:epoch,now:now.addingTimeInterval(age),uptime:100+age,trackingNormal:true,thermalAcceptable:true))}
        XCTAssertFalse(context().usable(epoch:epoch,now:now,uptime:100,trackingNormal:false,thermalAcceptable:true))
        XCTAssertFalse(context().usable(epoch:epoch,now:now,uptime:100,trackingNormal:true,thermalAcceptable:false))
        XCTAssertFalse(context(orientation:"right").usable(epoch:epoch,now:now,uptime:100,trackingNormal:true,thermalAcceptable:true))
        XCTAssertFalse(context(crop:[0.1,0,0.9,1]).usable(epoch:epoch,now:now,uptime:100,trackingNormal:true,thermalAcceptable:true))
    }
    func testGravityUsesSurveyUpAndIsInvariantToWorldRebaseAndPhysicalRoll() {
        let siteFromWorld=simd_double4x4(columns:(SIMD4(1,0,0,0),SIMD4(0,0,1,0),SIMD4(0,-1,0,0),SIMD4(4,7,1.5,1)))
        let roll=simd_float4x4(simd_quatf(angle:.pi,axis:SIMD3(0,0,1)))
        let rollDouble=simd_double4x4(columns:(SIMD4<Double>(roll[0]),SIMD4<Double>(roll[1]),SIMD4<Double>(roll[2]),SIMD4<Double>(roll[3])))
        let rolledCamera=siteFromWorld*rollDouble
        func context(_ camera:simd_float4x4,_ up:SIMD3<Float>?,_ reliable:Bool=true)->VisualReferenceFrameContext {
            .init(epoch:UUID(),calibration:calibration,worldFromCamera:camera,capturedAt:now,uptime:100,orientation:"raw_sensor",worldUp:up,gravityReliable:reliable,crop:[0,0,1,1])
        }
        // Correct physical phone roll has matching captured VIO. Reorienting pixels alone does not.
        XCTAssertTrue(VisualReferenceFrameGate.agrees(siteFromCamera:rolledCamera,context:context(roll,SIMD3(0,1,0))))
        XCTAssertFalse(VisualReferenceFrameGate.agrees(siteFromCamera:rolledCamera,context:context(matrix_identity_float4x4,SIMD3(0,1,0))))
        XCTAssertFalse(VisualReferenceFrameGate.agrees(siteFromCamera:siteFromWorld,context:context(matrix_identity_float4x4,nil)))
        XCTAssertFalse(VisualReferenceFrameGate.agrees(siteFromCamera:siteFromWorld,context:context(matrix_identity_float4x4,SIMD3(0,1,0),false)))
        var rebase=simd_float4x4(simd_quatf(angle:0.8,axis:simd_normalize(SIMD3(1,2,3))))
        rebase[3]=SIMD4(100,-40,7,1)
        let transformedUp=rebase*SIMD4<Float>(0,1,0,0)
        XCTAssertTrue(VisualReferenceFrameGate.agrees(siteFromCamera:rolledCamera,
            context:context(rebase*roll,SIMD3(transformedUp.x,transformedUp.y,transformedUp.z))))
        XCTAssertFalse(VisualReferenceFrameGate.agrees(siteFromCamera:rolledCamera,context:context(rebase*roll,SIMD3(0,1,0))))
        // The surveyed image normal is horizontal here; it is deliberately different from site up.
        XCTAssertEqual(siteFromWorld[2].z,0)
    }
    func testDetectedCornerHomographyDoesNotNeedCameraTruth() throws {
        let corners=[SIMD2(100.0,100),SIMD2(450,80),SIMD2(480,350),SIMD2(80,390)]
        let h=try XCTUnwrap(VisualReferenceProposals.homography(corners:corners,width:640,height:480))
        for (p,q) in zip([SIMD2(0.0,0),SIMD2(640,0),SIMD2(640,480),SIMD2(0,480)],corners) {
            XCTAssertLessThan(simd_distance(try XCTUnwrap(VisualReferenceGeometry.point(h,p)),q),1e-8)
        }
    }
    func testOverlappingOrRepeatingAppearancesCannotCountAsIndependentReferences() throws {
        func match(_ id:String,_ offset:Double)->VisualReferenceMatch {
            var h=simd_double3x3(diagonal:SIMD3(0.3,0.3,1));h[2].x=offset
            return .init(id:id,pose:.init(siteFromCamera:matrix_identity_double4x4,referenceToCameraPixels:h,metricResidualPixels:0,planeDistanceMeters:3,obliquityDegrees:0),correlation:1,validFraction:1,alignedPatchFraction:1)
        }
        XCTAssertFalse(VisualReferencePipeline.independentFootprints([match("a",0),match("b",0)],width:640,height:480))
        XCTAssertTrue(VisualReferencePipeline.independentFootprints([match("a",0),match("b",300)],width:640,height:480))
        let context=try XCTUnwrap(CGContext(data:nil,width:640,height:480,bitsPerComponent:8,bytesPerRow:640,
            space:CGColorSpaceCreateDeviceGray(),bitmapInfo:CGImageAlphaInfo.none.rawValue))
        for repeated in [true,false] {
            context.setFillColor(gray:repeated ? 1 : 0.5,alpha:1);context.fill(CGRect(x:0,y:0,width:640,height:480))
            if repeated {
                context.setFillColor(gray:0,alpha:1)
                for y in stride(from:0,to:480,by:20) {for x in stride(from:0,to:640,by:20) where (x/20+y/20)%2==0 {
                    context.fill(CGRect(x:x,y:y,width:20,height:20))
                } }
            }
            let raster=try XCTUnwrap(VisualReferenceRaster(image:try XCTUnwrap(context.makeImage()),width:640,height:480))
            XCTAssertNil(try VisualReferenceMatcher.register(reference:raster,camera:raster),"An identical repeated/flat patch does not establish unique localization.")
        }
    }
    #if SPATIAL_HARNESS
    func testRunningFrameDropsBusySubmissionsAndResetDiscardsLateCompletion() throws {
        let space=CGColorSpaceCreateDeviceRGB()
        let c=try XCTUnwrap(CGContext(data:nil,width:640,height:480,bitsPerComponent:8,bytesPerRow:640*4,space:space,bitmapInfo:CGImageAlphaInfo.noneSkipLast.rawValue))
        let image=try XCTUnwrap(c.makeImage())
        let references=["A","B"].map { VisualReferenceImage(plane:.init(id:$0,widthMeters:2,heightMeters:1.5,siteFromPlane:identity),image:image) }
        let pipeline=VisualReferencePipeline(references:references)
        var buffer:CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault,640,480,kCVPixelFormatType_32BGRA,nil,&buffer),kCVReturnSuccess)
        let pixels=try XCTUnwrap(buffer)
        let started=DispatchSemaphore(value:0),release=DispatchSemaphore(value:0)
        pipeline.testingHold {started.signal();release.wait()}
        XCTAssertEqual(started.wait(timeout:.now()+2),.success)
        let context=VisualReferenceFrameContext(epoch:UUID(),calibration:calibration,worldFromCamera:matrix_identity_float4x4,capturedAt:Date(),uptime:ProcessInfo.processInfo.systemUptime,orientation:"raw_sensor",worldUp:SIMD3(0,1,0),gravityReliable:true,crop:[0,0,1,1])
        XCTAssertTrue(pipeline.submit(buffer:pixels,context:context))
        XCTAssertFalse(pipeline.submit(buffer:pixels,context:context))
        pipeline.reset();release.signal();pipeline.testingDrain()
        XCTAssertNil(pipeline.takeResult())
    }
    #endif
    /// In-memory policy fixture only; no field-labelled pack is exported or imported into the app.
    private func policyFixture() throws -> (LocalLandmarkPack,VisualReferenceManifest,[String:Any]) {
        let hash=String(repeating:"a",count:64),other=String(repeating:"b",count:64)
        let landmarks=["A","B"].enumerated().map { i,id in LocalLandmarkPack.Landmark(id:id,imageFile:id+".png",imageSHA256:i==0 ? hash : other,physicalWidthMeters:2,siteFromImage:[0,1,0,0,-1,0,0,0,0,0,1,0,4,i==0 ? 7 : 10,1.5,1],uniqueAtSite:true) }
        var pack=LocalLandmarkPack(schemaVersion:2,siteID:"IN_MEMORY_POLICY_TEST",version:"1",source:"test",license:"test",surveyedAt:"2026-01-01T00:00:00Z",expiresAt:"2028-01-01T00:00:00Z",originLatitude:0,originLongitude:0,landmarkSurveyErrorMeters:0.05,checkpointErrorsMeters:Array(repeating:0.2,count:20),validationDeviceModels:["TEST_ONLY"],maximumViewDistanceMeters:10,landmarks:landmarks,areas:[])
        pack.validation=LocalLandmarkValidation(evidenceKind:"independent_field_checkpoints",checkpointDatasetSHA256:other,referenceSurveySHA256:hash,independentCheckpointCount:20,headingErrorsDegrees:Array(repeating:2,count:20),registrationErrorsPixels:Array(repeating:3,count:20),referenceFrame:"ENU_meters_camera_right_up_back",cameraCalibration:"ARKit_per_frame_intrinsics",verticalErrorsMeters:Array(repeating:0.2,count:20))
        let refs=landmarks.map {VisualReferenceManifest.Reference(imageSHA256:$0.imageSHA256,plane:.init(id:$0.id,widthMeters:2,heightMeters:1.5,siteFromPlane:[0,1,0,0,0,0,-1,0,-1,0,0,0,4,$0.id=="A" ? 7 : 10,1.5,1]))}
        let manifest=VisualReferenceManifest(schemaVersion:1,siteID:pack.siteID,siteVersion:pack.version,detectorConfiguration:VisualReferenceMatcher.configurationID,planeConvention:"centered_X_right_Y_up_Z_out_meters",references:refs)
        let digest=try manifestHash(manifest)
        let checkpointPose:[Double]=[0,1,0,0,0,0,-1,0,-1,0,0,0,0,8.5,1.5,1]
        let checkpoints:[[String:Any]]=(0..<20).map { i in
            ["encounterID":"TEST_POS_\(i)","captureSHA256":String(format:"%064x",i+1),"capturedAt":"2026-12-01T00:00:00Z","referenceIDs":["A","B"],"truthSiteFromCamera":checkpointPose,"estimatedSiteFromCamera":checkpointPose,"heldOutRegistrationErrorPixels":1.0,"usedForReferenceFitting":false]
        }
        let negatives:[[String:Any]]=(0..<20).map {i in
            ["encounterID":"TEST_NEG_\(i)","captureSHA256":String(format:"%064x",i+101),"acceptedReferenceIDs":[String](),"condition":["mismatched_reference","repeated_texture","blur","occlusion"][i%4]]
        }
        let proof:[String:Any]=["schemaVersion":1,"evidenceKind":"independent_field_pixel_checkpoints","detectorConfiguration":VisualReferenceMatcher.configurationID,"referenceManifestSHA256":digest,"referenceSurveySHA256":hash,"siteID":pack.siteID,"siteVersion":pack.version,"calibrationContract":"ARKit_per_frame_intrinsics_raw_sensor_uncropped","runtimeOSVersion":ProcessInfo.processInfo.operatingSystemVersionString,"deviceModels":["TEST_ONLY"],"validatedAt":"2026-12-02T00:00:00Z","expiresAt":"2027-01-01T00:00:00Z","attemptedPositiveEncounters":20,"surveyErrorMeters":0.05,"maximumDistanceMeters":10.0,"checkpoints":checkpoints,"negatives":negatives]
        return (pack,manifest,proof)
    }
    func testPixelPlaneMustBindToVerifiedSurveyFrameAndDecodedPhysicalAspect() throws {
        let (pack,manifest,proofDictionary)=try policyFixture()
        let dimensions=["A":SIMD2(640,480),"B":SIMD2(640,480)]
        XCTAssertTrue(manifest.matches(pack,imageDimensions:dimensions))
        // Literal noncommuting Rz(90°) survey × Rx(-90°) plane convention, translated in site ENU.
        XCTAssertEqual(manifest.references[0].plane.siteFromPlane,[0,1,0,0,0,0,-1,0,-1,0,0,0,4,7,1.5,1])
        let date=try XCTUnwrap(ISO8601DateFormatter().date(from:"2026-12-03T00:00:00Z"))
        for modification in ["translation","rotation","width","height"] {
            let reference=manifest.references[0]
            var transform=reference.plane.siteFromPlane
            if modification == "translation" {transform[12] += 100}
            if modification == "rotation" {
                // Still a valid rigid frame; it is simply not the surveyed image frame.
                transform=[1,0,0,0,0,0,-1,0,0,1,0,0,4,7,1.5,1]
            }
            let plane=VisualReferencePlane(id:reference.plane.id,widthMeters:modification == "width" ? 2.1 : 2,
                heightMeters:modification == "height" ? 1.6 : 1.5,siteFromPlane:transform)
            let changed=VisualReferenceManifest(schemaVersion:manifest.schemaVersion,siteID:manifest.siteID,siteVersion:manifest.siteVersion,
                detectorConfiguration:manifest.detectorConfiguration,planeConvention:manifest.planeConvention,
                references:[.init(imageSHA256:reference.imageSHA256,plane:plane),manifest.references[1]])
            XCTAssertFalse(changed.matches(pack,imageDimensions:dimensions),modification)
            // Rebinding the digest must not rescue a geometrically unrelated manifest.
            var proof=proofDictionary;proof["referenceManifestSHA256"]=try manifestHash(changed)
            let decoded=try JSONDecoder().decode(VisualReferenceValidation.self,from:JSONSerialization.data(withJSONObject:proof))
            XCTAssertNil(decoded.envelope(manifest:changed,manifestSHA256:try manifestHash(changed),pack:pack,at:date,deviceModel:"TEST_ONLY",imageDimensions:dimensions),modification)
        }
        XCTAssertFalse(manifest.matches(pack,imageDimensions:["A":SIMD2(640,400),"B":SIMD2(640,480)]))
    }
    func testDetectorSpecificFieldPolicyHasUsablePositiveAndRejectsSubstitution() throws {
        let (pack,manifest,original)=try policyFixture()
        let date=try XCTUnwrap(ISO8601DateFormatter().date(from:"2026-12-03T00:00:00Z"))
        func evaluate(_ dictionary:[String:Any],device:String="TEST_ONLY")throws->VisualReferenceEnvelope? {
            let proof=try JSONDecoder().decode(VisualReferenceValidation.self,from:JSONSerialization.data(withJSONObject:dictionary))
            return proof.envelope(manifest:manifest,manifestSHA256:try manifestHash(manifest),pack:pack,at:date,deviceModel:device,imageDimensions:["A":SIMD2(640,480),"B":SIMD2(640,480)])
        }
        XCTAssertNotNil(try evaluate(original));XCTAssertNil(try evaluate(original,device:"REAL_PHONE"))
        for (key,value) in [("runtimeOSVersion","different-operating-system-build"),("evidenceKind","synthetic_projective_pixels"),("detectorConfiguration","vision-rect4-homography-r1-photometric640-v2"),("referenceManifestSHA256",String(repeating:"f",count:64)),("siteVersion","2"),("validatedAt","2027-01-01T00:00:00Z"),("expiresAt","2026-12-02T00:00:00Z"),("validatedAt","malformed") ] {
            var changed=original;changed[key]=value;XCTAssertNil(try evaluate(changed),key)
        }
        var weak=original;weak["attemptedPositiveEncounters"]=100;XCTAssertNil(try evaluate(weak))
        var negatives=try XCTUnwrap(original["negatives"] as? [[String:Any]])
        negatives[0]["acceptedReferenceIDs"]=["A"];weak=original;weak["negatives"]=negatives;XCTAssertNil(try evaluate(weak))
        var checkpoints=try XCTUnwrap(original["checkpoints"] as? [[String:Any]])
        checkpoints[1]["encounterID"]=checkpoints[0]["encounterID"];weak=original;weak["checkpoints"]=checkpoints;XCTAssertNil(try evaluate(weak))
    }
    func testPixelSurveyUncertaintyCannotUndercutBoundSurveyOrAreaMargins() throws {
        let (pack, manifest, original) = try policyFixture()
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-12-03T00:00:00Z"))
        let dimensions = ["A": SIMD2(640,480), "B": SIMD2(640,480)]
        func envelope(_ error: Double) throws -> VisualReferenceEnvelope? {
            var value = original; value["surveyErrorMeters"] = error
            let proof = try JSONDecoder().decode(VisualReferenceValidation.self, from: JSONSerialization.data(withJSONObject: value))
            return proof.envelope(manifest: manifest, manifestSHA256: try manifestHash(manifest), pack: pack,
                at: now, deviceModel: "TEST_ONLY", imageDimensions: dimensions)
        }
        XCTAssertNil(try envelope(0.001))
        let matching = try XCTUnwrap(envelope(0.05)), larger = try XCTUnwrap(envelope(0.08))
        XCTAssertEqual(matching.horizontalMeters, 0.05); XCTAssertEqual(matching.verticalMeters, 0.05)
        XCTAssertEqual(larger.horizontalMeters, 0.08); XCTAssertEqual(larger.verticalMeters, 0.08)
        let area = LocalLandmarkPack.Area(id: "area", stopID: "stop", label: "test", level: "0",
            floorHeightMeters: 0, polygonENU: [[0,0],[10,0],[10,10],[0,10]], surveyedClearanceMeters: 0.75)
        for camera in [SIMD3(0.78,5,1.5), SIMD3(5,5,0.42)] {
            XCTAssertNotNil(LocalLandmarkGeometry.boardingArea(camera: camera, horizontalBound: 0.01,
                verticalBound: 0.01, areas: [area], stopID: "stop"))
            XCTAssertNil(LocalLandmarkGeometry.boardingArea(camera: camera, horizontalBound: matching.horizontalMeters,
                verticalBound: matching.verticalMeters, areas: [area], stopID: "stop"))
        }
    }
    func testPixelProofMustCoverExactRuntimeReferenceConfiguration() throws {
        let (pack, manifest, original) = try policyFixture()
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-12-03T00:00:00Z"))
        let extra = ["C", "D"].enumerated().map { index, id -> LocalLandmarkPack.Landmark in
            var frame = pack.landmarks[index].siteFromImage; frame[13] += 6
            return .init(id: id, imageFile: id+".png", imageSHA256: String(repeating: index == 0 ? "c" : "d", count: 64),
                physicalWidthMeters: 2, siteFromImage: frame, uniqueAtSite: true)
        }
        var extended = LocalLandmarkPack(schemaVersion: pack.schemaVersion, siteID: pack.siteID, version: pack.version,
            source: pack.source, license: pack.license, surveyedAt: pack.surveyedAt, expiresAt: pack.expiresAt,
            originLatitude: pack.originLatitude, originLongitude: pack.originLongitude,
            landmarkSurveyErrorMeters: pack.landmarkSurveyErrorMeters, checkpointErrorsMeters: pack.checkpointErrorsMeters,
            validationDeviceModels: pack.validationDeviceModels, maximumViewDistanceMeters: pack.maximumViewDistanceMeters,
            landmarks: pack.landmarks + extra, areas: pack.areas)
        extended.validation = pack.validation
        let extraRefs = extra.enumerated().map { index, landmark -> VisualReferenceManifest.Reference in
            var frame = manifest.references[index].plane.siteFromPlane; frame[13] += 6
            return .init(imageSHA256: landmark.imageSHA256, plane: .init(id: landmark.id, widthMeters: 2,
                heightMeters: 1.5, siteFromPlane: frame))
        }
        let four = VisualReferenceManifest(schemaVersion: 1, siteID: manifest.siteID, siteVersion: manifest.siteVersion,
            detectorConfiguration: manifest.detectorConfiguration, planeConvention: manifest.planeConvention,
            references: manifest.references + extraRefs)
        var value = original; value["referenceManifestSHA256"] = try manifestHash(four)
        let proof = try JSONDecoder().decode(VisualReferenceValidation.self, from: JSONSerialization.data(withJSONObject: value))
        let dimensions = Dictionary(uniqueKeysWithValues: ["A","B","C","D"].map { ($0, SIMD2(640,480)) })
        XCTAssertTrue(four.matches(extended, imageDimensions: dimensions))
        XCTAssertNil(proof.envelope(manifest: four, manifestSHA256: try manifestHash(four), pack: extended,
            at: now, deviceModel: "TEST_ONLY", imageDimensions: dimensions))
        let valid = try JSONDecoder().decode(VisualReferenceValidation.self, from: JSONSerialization.data(withJSONObject: original))
        let bounds = try XCTUnwrap(valid.envelope(manifest: manifest, manifestSHA256: try manifestHash(manifest),
            pack: pack, at: now, deviceModel: "TEST_ONLY", imageDimensions: dimensions))
        XCTAssertTrue(bounds.supports(["B","A"]))
        for unsupported in [["C","D"], ["A"], ["A","B","C"], ["A","A"]] { XCTAssertFalse(bounds.supports(unsupported)) }
    }
    func testCachedPixelProofRetainsExpiryAndRejectsInvalidImport() throws {
        let (pack, manifest, original) = try policyFixture()
        let iso = ISO8601DateFormatter(), now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-12-03T00:00:00Z"))
        func cache(_ dictionary: [String:Any]) throws -> VisualReferenceEnvelopeCache? {
            let proof = try JSONDecoder().decode(VisualReferenceValidation.self, from: JSONSerialization.data(withJSONObject: dictionary))
            return VisualReferenceEnvelopeCache(validation: proof, manifest: manifest,
                manifestSHA256: try manifestHash(manifest), pack: pack, at: now, deviceModel: "TEST_ONLY",
                imageDimensions: ["A": SIMD2(640,480), "B": SIMD2(640,480)])
        }
        let cached = try XCTUnwrap(cache(original))
        XCTAssertNotNil(cached.current(at: now))
        XCTAssertEqual(cached.current(at: now)?.expiresAt, iso.date(from: "2027-01-01T00:00:00Z"))
        XCTAssertNotNil(cached.current(at: try XCTUnwrap(iso.date(from: "2026-12-31T23:59:59Z"))))
        XCTAssertNil(cached.current(at: try XCTUnwrap(iso.date(from: "2027-01-01T00:00:00Z"))))
        XCTAssertNil(cached.current(at: try XCTUnwrap(iso.date(from: "2026-12-01T23:59:59Z"))))
        var invalid = original; invalid["surveyErrorMeters"] = 0.001
        XCTAssertNil(try cache(invalid))
    }

}
