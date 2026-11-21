import XCTest
import UIKit
@testable import RightSide

final class SensorTests: XCTestCase {
    func testCachedClockRetainsFractionalAndWholeSecondFormats() throws {
        let fractional = "2026-11-21T10:00:00.125Z"
        let whole = "2026-11-21T10:00:00Z"
        for _ in 0..<50 {
            let a = try XCTUnwrap(WireClock.date(fractional))
            let b = try XCTUnwrap(WireClock.date(whole))
            XCTAssertEqual(a.timeIntervalSince(b), 0.125, accuracy: 0.00001)
            XCTAssertEqual(WireClock.string(a), fractional)
            XCTAssertNil(WireClock.date("not a date"))
        }
    }

    func testAspectFitPreservesPortraitAndLandscapeLetterboxing() {
        XCTAssertEqual(SensorGeometry.aspectFit(image: CGSize(width: 400, height: 200),
            container: CGSize(width: 300, height: 300)), CGRect(x: 0, y: 75, width: 300, height: 150))
        XCTAssertEqual(SensorGeometry.aspectFit(image: CGSize(width: 100, height: 200),
            container: CGSize(width: 300, height: 300)), CGRect(x: 75, y: 0, width: 150, height: 300))
        XCTAssertEqual(SensorGeometry.aspectFit(image: .zero, container: CGSize(width: 300, height: 300)), .zero)
    }

    func testCropClipsToRasterAndRejectsInvalidRegions() {
        let size = CGSize(width: 400, height: 200)
        XCTAssertEqual(SensorGeometry.pixelCrop(normalized: CGRect(x: -0.2, y: 0.25, width: 0.7, height: 1),
            image: size), CGRect(x: 0, y: 50, width: 200, height: 150))
        XCTAssertEqual(SensorGeometry.pixelCrop(normalized: CGRect(x: 2, y: 2, width: 1, height: 1), image: size), .zero)
        XCTAssertEqual(SensorGeometry.pixelCrop(normalized: CGRect(x: 0, y: 0, width: CGFloat.infinity, height: 1), image: size), .zero)
    }

    func testVisionBottomLeftCoordinatesMapIntoTopLeftSourceCrop() {
        let crop = CGRect(x: 60, y: 50, width: 280, height: 100)
        let result = SensorGeometry.visionBox(CGRect(x: 0.25, y: 0.6, width: 0.5, height: 0.2), crop: crop)
        XCTAssertEqual(result.minX, 130, accuracy: 0.0001)
        XCTAssertEqual(result.minY, 70, accuracy: 0.0001)
        XCTAssertEqual(result.width, 140, accuracy: 0.0001)
        XCTAssertEqual(result.height, 20, accuracy: 0.0001)
    }

    func testInvalidationRejectsLateWorkAcrossMultipleChanges() {
        var epoch = SensorResultEpoch()
        let beforeImageChange = epoch.token
        XCTAssertTrue(epoch.accepts(beforeImageChange))
        epoch.invalidate()
        let beforeSelectionChange = epoch.token
        epoch.invalidate()
        XCTAssertFalse(epoch.accepts(beforeImageChange))
        XCTAssertFalse(epoch.accepts(beforeSelectionChange))
        XCTAssertTrue(epoch.accepts(epoch.token))
    }

    func testWirePayloadPreservesRawFixAndExplicitNulls() throws {
        let observed = Date(timeIntervalSince1970: 1_700_000_000)
        let payload = try XCTUnwrap(SensorPositionPayload(longitude: 7.439, latitude: 46.948,
            accuracy: 65, timestamp: observed, receivedAt: observed.addingTimeInterval(60), floor: -1))
        let data = try JSONEncoder().encode(payload)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["rawCoordinate"] as? [Double], [7.439, 46.948])
        XCTAssertEqual(json["horizontalAccuracyMeters"] as? Double, 65)
        XCTAssertTrue(json["filteredCoordinate"] is NSNull)
        XCTAssertTrue(json["mapMatchedCoordinate"] is NSNull)
        XCTAssertEqual(json["floorCandidates"] as? [String], ["-1"])
        XCTAssertEqual(json["confidence"] as? String, "uncertain")
        XCTAssertEqual(json["mode"] as? String, "unknown")
        let evidence = try XCTUnwrap((json["evidence"] as? [[String: Any]])?.first)
        XCTAssertEqual(evidence["observedAt"] as? String, json["capturedAt"] as? String)
        XCTAssertNotEqual(evidence["fetchedAt"] as? String, json["capturedAt"] as? String)
        XCTAssertEqual(evidence["quality"] as? String, "unknown")
    }

    func testWirePayloadRejectsInvalidSensorValues() {
        let now = Date()
        XCTAssertNil(SensorPositionPayload(longitude: .nan, latitude: 46, accuracy: 1, timestamp: now, receivedAt: now, floor: nil))
        XCTAssertNil(SensorPositionPayload(longitude: 7, latitude: 91, accuracy: 1, timestamp: now, receivedAt: now, floor: nil))
        XCTAssertNil(SensorPositionPayload(longitude: 7, latitude: 46, accuracy: -1, timestamp: now, receivedAt: now, floor: nil))
    }

    func testFreshnessExpiresEvenWithoutAnotherLocationCallback() {
        let fix = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertFalse(SensorFixFreshness.isStale(timestamp: fix, now: fix.addingTimeInterval(10)))
        XCTAssertTrue(SensorFixFreshness.isStale(timestamp: fix, now: fix.addingTimeInterval(10.001)))
        XCTAssertTrue(SensorFixFreshness.isStale(timestamp: fix, now: fix.addingTimeInterval(-0.001)))
        XCTAssertTrue(SensorFixFreshness.isStale(timestamp: nil, now: fix))
    }

    @MainActor func testCameraRasterIsUprightAndBounded() throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let original = UIGraphicsImageRenderer(size: CGSize(width: 3000, height: 1000), format: format).image { context in
            UIColor.red.setFill(); context.fill(CGRect(x: 0, y: 0, width: 3000, height: 1000))
        }
        let rotated = UIImage(cgImage: try XCTUnwrap(original.cgImage), scale: 1, orientation: .right)
        let result = try SensorImagePreparation.camera(rotated)
        XCTAssertLessThanOrEqual(max(result.width, result.height), 2048)
        XCTAssertGreaterThan(result.height, result.width)
        XCTAssertEqual(UIImage(cgImage: result).imageOrientation, .up)
    }

    func testImportRejectsNonImageData() {
        XCTAssertThrowsError(try SensorImagePreparation.imported(Data("not an image".utf8)))
    }
}
