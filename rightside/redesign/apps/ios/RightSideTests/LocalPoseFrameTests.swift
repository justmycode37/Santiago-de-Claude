import XCTest
import simd
#if !SPATIAL_HARNESS
@testable import RightSide
#endif

final class LocalPoseFrameTests: XCTestCase {
    private let time = Date(timeIntervalSince1970: 1_800_000_000)
    private func translated(_ position: SIMD3<Float>) -> simd_float4x4 {
        var result = matrix_identity_float4x4
        result[3] = SIMD4(position, 1)
        return result
    }
    private func rotated(_ degrees: Float) -> simd_float4x4 {
        simd_float4x4(simd_quatf(angle: degrees * .pi / 180, axis: SIMD3(0, 0, 1)))
    }
    private func references(_ poses: [simd_float4x4]) -> [LocalPoseReferenceEstimate] {
        poses.enumerated().map { .init(landmarkID: "reference-\($0.offset)", siteFromWorld: $0.element) }
    }
    private func stable(_ poses: [simd_float4x4], camera: simd_float4x4,
                        rebase: simd_float4x4 = matrix_identity_float4x4) -> LocalPoseAssessment {
        var tracker = LocalPoseConsensus()
        let refs = references(poses.map { $0 * simd_inverse(rebase) })
        var result: LocalPoseAssessment!
        for index in 0..<3 {
            let at = time.addingTimeInterval(Double(index) * 0.2)
            result = tracker.update(estimates: refs, worldFromCamera: rebase * camera,
                at: at, now: at, trackingNormal: true, errorBoundMeters: 0.3, headingBoundDegrees: 3, verticalErrorBoundMeters: 0.3)
        }
        return result
    }

    func testFarWorldOriginCannotHideCameraPositionDisagreement() {
        let camera = translated(SIMD3(100, 0, 0))
        let poses = [matrix_identity_float4x4, rotated(2)]
        let actual = simd_distance(LocalLandmarkGeometry.translation(poses[0] * camera),
                                   LocalLandmarkGeometry.translation(poses[1] * camera))
        XCTAssertGreaterThan(actual, 3.49)
        for rebase in [matrix_identity_float4x4, translated(SIMD3(-100, 0, 0))] {
            let result = stable(poses, camera: camera, rebase: rebase)
            XCTAssertNotEqual(result.status, .reliable)
            XCTAssertNil(result.siteFromWorld)
            XCTAssertEqual(result.reason, "landmark_geometry_disagrees")
        }
    }

    func testValidCameraConsensusAndFusionAreWorldFrameInvariant() throws {
        let center = SIMD3<Float>(100, 2, 3)
        let camera = translated(center)
        var second = rotated(2)
        second[3] = SIMD4(center - LocalLandmarkGeometry.translation(second * camera) + SIMD3(0, 0.1, 0), 1)
        let poses = [matrix_identity_float4x4, second]
        var shiftedRotatedWorld = simd_float4x4(simd_quatf(angle: 0.7, axis: SIMD3(0, 1, 0)))
        shiftedRotatedWorld[3] = SIMD4(-80, 17, 5, 1)
        for rebase in [matrix_identity_float4x4, translated(-center), shiftedRotatedWorld] {
            let result = stable(poses, camera: camera, rebase: rebase)
            XCTAssertEqual(result.status, .reliable)
            XCTAssertEqual(result.maximumTranslationDisagreement, 0.1, accuracy: 0.001)
            let pose = try XCTUnwrap(result.siteFromCamera)
            XCTAssertLessThan(simd_distance(LocalLandmarkGeometry.translation(pose), center + SIMD3(0, 0.05, 0)), 0.001)
            XCTAssertLessThan(LocalPoseConsensus.angle(pose, rotated(1)), 0.05)
        }
    }

    func testTemporalAlignmentDriftIsComparedAtCurrentCamera() {
        var tracker = LocalPoseConsensus()
        let camera = translated(SIMD3(100, 0, 0))
        for index in 0..<4 {
            let at = time.addingTimeInterval(Double(index) * 0.2)
            let alignment = index == 3 ? rotated(2) : matrix_identity_float4x4
            let result = tracker.update(estimates: references([alignment, alignment]), worldFromCamera: camera,
                at: at, now: at, trackingNormal: true, errorBoundMeters: 0.3, headingBoundDegrees: 3, verticalErrorBoundMeters: 0.3)
            if index == 2 { XCTAssertEqual(result.status, .reliable) }
            if index == 3 {
                XCTAssertEqual(result.status, .relocalizing)
                XCTAssertEqual(result.reason, "alignment_drift_or_world_reset")
                XCTAssertNil(result.siteFromCamera)
            }
        }
    }

    func testActualCameraMovementDoesNotBecomeAlignmentDrift() {
        var tracker = LocalPoseConsensus()
        let refs = references([matrix_identity_float4x4, matrix_identity_float4x4])
        for index in 0..<4 {
            let at = time.addingTimeInterval(Double(index) * 0.2)
            let camera = translated(SIMD3(index == 3 ? 102 : 100, 0, 0))
            let result = tracker.update(estimates: refs, worldFromCamera: camera, at: at, now: at,
                trackingNormal: true, errorBoundMeters: 0.3, headingBoundDegrees: 3, verticalErrorBoundMeters: 0.3)
            if index >= 2 {
                XCTAssertEqual(result.status, .reliable)
                XCTAssertEqual(result.siteFromCamera?[3].x, camera[3].x)
            }
        }
    }

    func testIndependentHeightEnvelopeCannotBeAveragedAway() {
        for heights: [Float] in [[0.3, 1.1], [0.7, 0.75]] {
            var tracker = LocalPoseConsensus()
            for index in 0..<3 {
                let at = time.addingTimeInterval(Double(index) * 0.2)
                let result = tracker.update(estimates: references(heights.map { translated(SIMD3(0, 0, $0)) }),
                    worldFromCamera: matrix_identity_float4x4, at: at, now: at,
                    trackingNormal: true, errorBoundMeters: 0.9, headingBoundDegrees: 3,
                    verticalErrorBoundMeters: 0.1)
                if heights[0] == 0.3 {
                    XCTAssertNil(result.siteFromCamera)
                    XCTAssertEqual(result.reason, "landmark_geometry_disagrees")
                } else if index == 2 { XCTAssertEqual(result.status, .reliable) }
            }
        }
    }

    func testTemporalHeightDriftUsesVerticalEnvelope() {
        var tracker = LocalPoseConsensus()
        for index in 0..<4 {
            let at = time.addingTimeInterval(Double(index) * 0.2)
            let pose = translated(SIMD3(0, 0, index == 3 ? 0.9 : 0.7))
            let result = tracker.update(estimates: references([pose, pose]),
                worldFromCamera: matrix_identity_float4x4, at: at, now: at,
                trackingNormal: true, errorBoundMeters: 0.9, headingBoundDegrees: 3,
                verticalErrorBoundMeters: 0.1)
            if index == 2 { XCTAssertEqual(result.status, .reliable) }
            if index == 3 {
                XCTAssertNil(result.siteFromCamera)
                XCTAssertEqual(result.reason, "alignment_drift_or_world_reset")
            }
        }
    }

    func testHorizontalEnvelopeAndInvalidVerticalBoundsRemainStrict() {
        let at = time
        for vertical in [0.1, Double.nan, Double.infinity, 0, -0.1, 1.1] {
            var tracker = LocalPoseConsensus()
            let result = tracker.update(estimates: references([translated(SIMD3(0, 0, 1)), translated(SIMD3(0.91, 0, 1))]),
                worldFromCamera: matrix_identity_float4x4, at: at, now: at,
                trackingNormal: true, errorBoundMeters: 0.9, headingBoundDegrees: 3,
                verticalErrorBoundMeters: vertical)
            XCTAssertNil(result.siteFromCamera)
            XCTAssertEqual(result.reason, vertical == 0.1 ? "landmark_geometry_disagrees" : "tracking_calibration_or_frame_unavailable")
        }
    }

    private func area(floor: Double = 0) -> LocalLandmarkPack.Area {
        .init(id: "synthetic-area-\(floor)", stopID: "synthetic-point", label: "TEST ONLY", level: "test",
              floorHeightMeters: floor, polygonENU: [[0,0],[10,0],[10,10],[0,10]], surveyedClearanceMeters: 1)
    }
    func testAreaUsesFullHeightEnvelopeAndExactBoardingPoint() {
        for height in [0.3, 0.49, 0.51, 2.39, 2.41, Double.nan] {
            let result = LocalLandmarkGeometry.boardingArea(camera: SIMD3(5,5,height), horizontalBound: 0.9,
                verticalBound: 0.1, areas: [area()], stopID: "synthetic-point")
            if height == 0.51 || height == 2.39 { XCTAssertEqual(result, 0) }
            else { XCTAssertNil(result) }
        }
        XCTAssertNil(LocalLandmarkGeometry.boardingArea(camera: SIMD3(5,5,1), horizontalBound: 0.9,
            verticalBound: 0.1, areas: [area()], stopID: "other-point"))
    }
    func testStackedAreasAndWideVerticalUncertaintyCannotSelectFloor() {
        XCTAssertNil(LocalLandmarkGeometry.boardingArea(camera: SIMD3(5,5,1), horizontalBound: 0.9,
            verticalBound: 0.1, areas: [area(), area(floor: 3)], stopID: "synthetic-point"))
        XCTAssertNil(LocalLandmarkGeometry.boardingArea(camera: SIMD3(5,5,1), horizontalBound: 0.9,
            verticalBound: 0.6, areas: [area()], stopID: "synthetic-point"))
    }
}
