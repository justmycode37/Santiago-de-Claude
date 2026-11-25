import XCTest
import CoreGraphics
import CoreLocation
import simd
#if canImport(RightSide)
@testable import RightSide
#endif

final class VehicleEvidenceTests: XCTestCase {
    private func boardingPack(from: String, until: String, at: Date) -> BoardingPointPack {
        BoardingPointPack(schemaVersion: 1, id: "calendar-test", version: "1",
            fetchedAt: PackClock.string(at.addingTimeInterval(-3600)),
            expiresAt: PackClock.string(at.addingTimeInterval(3600)), attribution: "Synthetic test",
            boardingPoints: [.init(id: "point", stopID: "stop", name: "Bern", label: "A",
                latitude: 46.95, longitude: 7.44, directionDegrees: nil, validFrom: from, validUntil: until)])
    }
    private func nearbyCount(from: String, until: String, instant: String) -> Int {
        let now = PackClock.date(instant)!
        let fix = CLLocation(coordinate: .init(latitude: 46.95, longitude: 7.44), altitude: 0,
            horizontalAccuracy: 5, verticalAccuracy: -1, timestamp: now)
        return boardingPack(from: from, until: until, at: now).nearby(fix, at: now).count
    }
    func testBoardingValidityUsesSwissCivilDayAtWinterAndSummerMidnight() {
        for instant in ["2026-01-01T23:30:00Z", "2026-07-01T22:30:00Z"] {
            let day = instant.contains("01-01") ? "2026-01-02" : "2026-07-02"
            let previous = instant.contains("01-01") ? "2026-01-01" : "2026-07-01"
            XCTAssertEqual(nearbyCount(from: day, until: day, instant: instant), 1)
            XCTAssertEqual(nearbyCount(from: previous, until: previous, instant: instant), 0)
        }
    }
    func testBoardingValidityHandlesSwissDSTTransitionsAndInclusiveEnd() {
        for instant in ["2026-03-28T23:30:00Z", "2026-03-29T01:30:00Z", "2026-03-29T21:59:59Z"] {
            XCTAssertEqual(nearbyCount(from: "2026-03-29", until: "2026-03-29", instant: instant), 1)
        }
        XCTAssertEqual(nearbyCount(from: "2026-03-29", until: "2026-03-29", instant: "2026-03-29T22:00:00Z"), 0)
        for instant in ["2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z", "2026-10-25T22:59:59Z"] {
            XCTAssertEqual(nearbyCount(from: "2026-10-25", until: "2026-10-25", instant: instant), 1)
        }
    }
    func testBoardingValidityRejectsMalformedCalendarRanges() {
        for range in [("", "9999-12-31"), ("2026-02-30", "9999-12-31"),
                      ("2026-2-01", "9999-12-31"), ("0000-01-01", "9999-12-31"),
                      ("2026-07-03", "2026-07-01")] {
            XCTAssertEqual(nearbyCount(from: range.0, until: range.1, instant: "2026-07-02T12:00:00Z"), 0)
        }
        XCTAssertEqual(nearbyCount(from: "2024-02-29", until: "9999-12-31", instant: "2026-07-02T12:00:00Z"), 1)
    }
    let t = Date(timeIntervalSince1970: 1_800_000_000)
    func detection(_ x: Double = 0.1, kind: TransportClass = .bus) -> VehicleDetection {
        VehicleDetection(kind: kind, box: CGRect(x: x, y: 0.1, width: 0.3, height: 0.6), score: 0.9,
            mask: VehicleMask(width: 100, height: 100, pixels: [UInt8](repeating: 1, count: 10000)))
    }
    func reading(_ text: String, at: Date, detection: VehicleDetection? = nil, others: [CGRect] = [], score: Float = 0.95) -> DisplayReading {
        VehicleTextRules.read([VehicleText(text: text, box: CGRect(x: 0.12, y: 0.14, width: 0.24, height: 0.06), score: score)],
            detection: detection ?? self.detection(), otherBoxes: others, at: at, frameID: UUID())
    }
    var expected: VehicleServiceExpectation { VehicleServiceExpectation(line: "6", destination: "Fischermätteli") }
    func stable(_ text: String = "6 Fischermätteli") -> VehicleTrack {
        VehicleTrack(id: UUID(), detection: detection(), lastSeen: t.addingTimeInterval(1),
                     readings: [0.0,0.5,1.0].map { reading(text, at: t.addingTimeInterval($0)) })
    }
    func testCompleteDisplayIsOnlyAVisualCandidate() {
        let decision = VehicleServiceMatcher.decide(stable(), expected: expected, now: t.addingTimeInterval(1))
        XCTAssertEqual(decision.state, .visualCandidate)
        XCTAssertEqual(decision.reason, "no_fresh_authoritative_vehicle_trip_binding")
    }
    func testWrongRouteAndShortWorkingConflict() {
        for text in ["16 Fischermätteli", "60 Fischermätteli", "6 Worb Dorf", "6 Bahnhof"] {
            XCTAssertEqual(VehicleServiceMatcher.decide(stable(text), expected: expected, now: t.addingTimeInterval(1)).state, .conflicting)
        }
    }
    func testUnreadableAndFlickeringDisplayCannotReuseLastMatch() {
        var track = stable(); track.lastSeen = t.addingTimeInterval(1.4)
        track.readings.append(reading("6", at: track.lastSeen))
        XCTAssertEqual(VehicleServiceMatcher.decide(track, expected: expected, now: track.lastSeen).state, .unknown)
        track.readings[3] = reading("6 Fischermätteli", at: track.lastSeen, score: 0.4)
        XCTAssertEqual(VehicleServiceMatcher.decide(track, expected: expected, now: track.lastSeen).state, .unknown)
    }
    func testOutOfServiceOverridesMatchingText() {
        var track = stable(); track.readings.append(reading("Nicht einsteigen", at: track.lastSeen))
        XCTAssertEqual(VehicleServiceMatcher.decide(track, expected: expected, now: track.lastSeen).state, .conflicting)
    }
    func testTextBehindAnotherVehicleIsNotAssociated() {
        let observation = reading("6 Fischermätteli", at: t, others: [CGRect(x: 0.2, y: 0.1, width: 0.3, height: 0.5)])
        XCTAssertNil(observation.line); XCTAssertTrue(observation.raw.isEmpty)
    }
    func testOutsideMaskIsNotAssociated() {
        let d = VehicleDetection(kind: .bus, box: detection().box, score: 0.9,
                                 mask: VehicleMask(width: 4, height: 4, pixels: [UInt8](repeating: 0, count: 16)))
        XCTAssertNil(reading("6 Fischermätteli", at: t, detection: d).line)
    }
    func testSeparateRowsCannotManufactureDisplay() {
        let texts = [VehicleText(text: "6", box: CGRect(x: 0.12,y: 0.14,width: 0.05,height: 0.06),score: 0.9),
                     VehicleText(text: "Fischermätteli", box: CGRect(x: 0.18,y: 0.3,width: 0.18,height: 0.06),score: 0.9)]
        let r = VehicleTextRules.read(texts, detection: detection(), otherBoxes: [], at: t, frameID: UUID())
        XCTAssertNil(r.line); XCTAssertNil(r.destination)
    }
    func testCollinearSameVehicleDisplayFragmentsCanJoin() {
        let texts = [VehicleText(text: "6", box: CGRect(x: 0.12,y: 0.14,width: 0.05,height: 0.06),score: 0.9),
                     VehicleText(text: "Fischermätteli", box: CGRect(x: 0.18,y: 0.14,width: 0.18,height: 0.06),score: 0.9)]
        let r = VehicleTextRules.read(texts, detection: detection(), otherBoxes: [], at: t, frameID: UUID())
        XCTAssertEqual(r.line, "6"); XCTAssertEqual(r.destination, "fischermatteli")
    }
    func testStaleFutureAndDuplicateReadingsAbstain() {
        XCTAssertEqual(VehicleServiceMatcher.decide(stable(), expected: expected, now: t.addingTimeInterval(3)).state, .unknown)
        XCTAssertEqual(VehicleServiceMatcher.decide(stable(), expected: expected, now: t).state, .unknown)
        var track = stable(); track.readings = Array(repeating: track.readings.last!, count: 3)
        XCTAssertEqual(VehicleServiceMatcher.decide(track, expected: expected, now: track.lastSeen).state, .unknown)
    }
    func testSimultaneousVehiclesKeepSeparateHistory() throws {
        var tracker = VehicleTracker(); tracker.update([detection(), detection(0.6)], at: t)
        let ids = tracker.tracks.map(\.id)
        tracker.record(reading("6 Fischermätteli", at: t), trackID: ids[0])
        tracker.update([detection(0.11), detection(0.61)], at: t.addingTimeInterval(0.4))
        XCTAssertEqual(tracker.tracks.map(\.id), ids)
        XCTAssertEqual(tracker.tracks[0].readings.count, 1)
        XCTAssertTrue(tracker.tracks[1].readings.isEmpty)
    }
    func testCrossingAndOcclusionInvalidateTrackIdentity() {
        var tracker = VehicleTracker(); tracker.update([detection(0.1), detection(0.3)], at: t)
        let ids = Set(tracker.tracks.map(\.id))
        tracker.update([detection(0.2)], at: t.addingTimeInterval(0.4))
        XCTAssertTrue(ids.isDisjoint(with: tracker.tracks.map(\.id)))
        XCTAssertEqual(Set(tracker.lost), ids)
        let old = tracker.tracks[0].id
        tracker.update([], at: t.addingTimeInterval(0.5))
        tracker.update([detection(0.2)], at: t.addingTimeInterval(0.6))
        XCTAssertNotEqual(tracker.tracks[0].id, old)
    }
    func testLongGapClockReversalAndResetInvalidateHistory() {
        var tracker = VehicleTracker(); tracker.update([detection()], at: t)
        let old = tracker.tracks[0].id
        tracker.update([detection()], at: t.addingTimeInterval(1))
        XCTAssertNotEqual(tracker.tracks[0].id, old)
        tracker.update([detection()], at: t)
        XCTAssertTrue(tracker.tracks.isEmpty)
        tracker.update([detection()], at: t.addingTimeInterval(2)); tracker.reset()
        XCTAssertTrue(tracker.tracks.isEmpty)
    }
    func testBusAndRailDoNotShareTrackIdentityTramAndTrainDo() {
        // YOLOE flickers between tram and train on the same Bern tram (docs/ar-recognition-plan.md, step 5).
        var tracker = VehicleTracker()
        tracker.update([detection(kind: .bus)], at: t)
        let bus = tracker.tracks.first?.id
        tracker.update([detection(kind: .tram)], at: t.addingTimeInterval(0.4))
        let tram = tracker.tracks.first?.id
        XCTAssertNotEqual(tram, bus)
        tracker.update([detection(kind: .train)], at: t.addingTimeInterval(0.8))
        XCTAssertEqual(tracker.tracks.first?.id, tram)
        XCTAssertEqual(tracker.tracks.first?.detection.kind, .train)
    }
    func testBoundedTracksAndHistory() {
        var tracker = VehicleTracker(); tracker.update((0..<100).map { detection(Double($0) / 100) }, at: t)
        XCTAssertLessThanOrEqual(tracker.tracks.count, 6)
        let id = tracker.tracks[0].id
        for _ in 0..<100 { tracker.record(reading("6 Fischermätteli", at: t), trackID: id) }
        XCTAssertEqual(tracker.tracks[0].readings.count, 6)
    }
    func binding(_ track: VehicleTrack, observed: Date? = nil, downstream: [String] = ["alight"], direction: String = "out", cancelled: Bool = false) -> AuthoritativeVehicleBinding {
        AuthoritativeVehicleBinding(trackID: track.id, observedAt: observed ?? t, validUntil: t.addingTimeInterval(30),
            tripID: "trip", boardingStopID: "board", directionID: direction, line: "6", destination: "Fischermätteli",
            downstreamStopIDs: downstream, cancelled: cancelled, pickupAllowed: true, associationVerified: true)
    }
    var boundExpected: VehicleServiceExpectation {
        VehicleServiceExpectation(line: "6", destination: "Fischermätteli", tripID: "trip", boardingStopID: "board",
                                  alightingStopID: "alight", directionID: "out", validUntil: t.addingTimeInterval(30))
    }
    func testStrongMatchRequiresFreshIndependentBinding() {
        let track = stable(), now = track.lastSeen
        XCTAssertEqual(VehicleServiceMatcher.decide(track, expected: boundExpected, now: now, binding: binding(track)).state, .verifiedService)
        XCTAssertEqual(VehicleServiceMatcher.decide(track, expected: boundExpected, now: now, binding: binding(track, observed: t.addingTimeInterval(-31))).state, .visualCandidate)
        XCTAssertEqual(VehicleServiceMatcher.decide(track, expected: boundExpected, now: now, binding: binding(stable())).state, .visualCandidate)
        XCTAssertEqual(VehicleServiceMatcher.decide(track, expected: boundExpected, now: now, binding: binding(track, direction: "opposite")).state, .conflicting)
        XCTAssertEqual(VehicleServiceMatcher.decide(track, expected: boundExpected, now: now, binding: binding(track, downstream: [])).state, .conflicting)
        XCTAssertEqual(VehicleServiceMatcher.decide(track, expected: boundExpected, now: now, binding: binding(track, cancelled: true)).state, .conflicting)
    }
    func testPoseCompositionUsesSurveyTransformNotGPS() {
        var siteFromImage = matrix_identity_float4x4; siteFromImage.columns.3 = SIMD4(10,20,2,1)
        var worldFromImage = matrix_identity_float4x4; worldFromImage.columns.3 = SIMD4(2,3,4,1)
        var camera = matrix_identity_float4x4; camera.columns.3 = SIMD4(5,8,9,1)
        let pose = LocalLandmarkGeometry.cameraPose(siteFromImage: siteFromImage, worldFromImage: worldFromImage, worldFromCamera: camera)
        XCTAssertEqual(LocalLandmarkGeometry.translation(pose), SIMD3(13,25,7))
    }
    func testInvalidRigidTransformsRejected() {
        var values: [Float] = [1,0,0,0, 0,1,0,0, 0,0,1,0, 1,2,3,1]
        XCTAssertNotNil(LocalLandmarkGeometry.matrix(values))
        values[0] = -1; XCTAssertNil(LocalLandmarkGeometry.matrix(values))
        values[0] = 2; XCTAssertNil(LocalLandmarkGeometry.matrix(values))
        values[0] = .nan; XCTAssertNil(LocalLandmarkGeometry.matrix(values))
        let identity = matrix_identity_float4x4
        let aroundNormal = simd_float4x4(simd_quatf(angle: .pi / 2, axis: SIMD3(0,0,1)))
        XCTAssertTrue(LocalLandmarkGeometry.orientationsAgree(identity, identity))
        XCTAssertFalse(LocalLandmarkGeometry.orientationsAgree(identity, aroundNormal))
    }
    func testAmbiguousSidewalksAndCurbUncertaintyAbstain() {
        let left = [SIMD2(0.0,0), SIMD2(5.0,0), SIMD2(5.0,10), SIMD2(0.0,10)]
        let right = left.map { $0 + SIMD2(6,0) }
        XCTAssertEqual(LocalLandmarkGeometry.uniqueArea(point: SIMD2(2.5,5), uncertainty: 0.3, areas: [left,right]), 0)
        XCTAssertNil(LocalLandmarkGeometry.uniqueArea(point: SIMD2(4.8,5), uncertainty: 0.3, areas: [left,right]))
        XCTAssertNil(LocalLandmarkGeometry.uniqueArea(point: SIMD2(5.5,5), uncertainty: 1, areas: [left,right]))
        XCTAssertNil(LocalLandmarkGeometry.uniqueArea(point: SIMD2(2.5,5), uncertainty: 0.3, areas: [left,left]))
        XCTAssertNil(LocalLandmarkGeometry.uniqueArea(point: SIMD2(2.5,5), uncertainty: 5, areas: [left,right]))
        XCTAssertFalse(LocalLandmarkGeometry.isStrictlyConvex([left[0],left[2],left[1],left[3]]))
    }
    func testSitePackNeedsActualCheckpointEnvelopeAndExactHardware() throws {
        // Synthetic metadata fixture, deliberately validated only for a nonexistent test hardware ID.
        let identity: [Float] = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
        let references = (0..<2).map { LocalLandmarkPack.Landmark(id: "test-\($0)", imageFile: "test-\($0).jpg", imageSHA256: "not-a-real-hash-\($0)", physicalWidthMeters: 1, siteFromImage: identity, uniqueAtSite: true) }
        let area = LocalLandmarkPack.Area(id: "synthetic-area", stopID: "synthetic-stop", label: "TEST ONLY", level: "0", floorHeightMeters: 0,
            polygonENU: [[0,0],[5,0],[5,10],[0,10]], surveyedClearanceMeters: 1)
        func pack(errors: [Double]) -> LocalLandmarkPack {
            LocalLandmarkPack(schemaVersion: 1, siteID: "SYNTHETIC-NOT-FOR-IMPORT", version: "test", source: "synthetic regression", license: "test",
                surveyedAt: PackClock.string(t), expiresAt: PackClock.string(t.addingTimeInterval(60)), originLatitude: 0, originLongitude: 0,
                landmarkSurveyErrorMeters: 0.1, checkpointErrorsMeters: errors, validationDeviceModels: ["test-hardware"], maximumViewDistanceMeters: 5,
                landmarks: references, areas: [area])
        }
        let valid = pack(errors: Array(repeating: 0.2, count: 20))
        XCTAssertTrue(valid.isValid(at: t, deviceModel: "test-hardware"))
        XCTAssertFalse(valid.isValid(at: t, deviceModel: "different-phone"))
        XCTAssertFalse(valid.isValid(at: t.addingTimeInterval(61), deviceModel: "test-hardware"))
        XCTAssertFalse(valid.isValid(at: t.addingTimeInterval(-1), deviceModel: "test-hardware"))
        XCTAssertFalse(pack(errors: [0.1]).isValid(at: t, deviceModel: "test-hardware"))
        XCTAssertFalse(pack(errors: Array(repeating: 2, count: 20)).isValid(at: t, deviceModel: "test-hardware"))
    }
    func testFleetNumberAloneCannotEstablishManufacturer() {
        let entry = FleetPack.Entry(operatorName: "BERNMOBIL", manufacturer: "Volvo", model: "7900A", kind: .bus, fleetNumbers: ["871"], source: "operator test fixture")
        let pack = FleetPack(schemaVersion: 1, version: "test", expiresAt: PackClock.string(t.addingTimeInterval(10)), entries: [entry])
        var track = stable()
        func read(_ at: Date, words: [String]) -> DisplayReading {
            DisplayReading(frameID: UUID(), at: at, line: nil, destination: nil, outOfService: false, ambiguous: false, raw: words)
        }
        track.readings = [read(t, words: ["871"]), read(track.lastSeen, words: ["871"])]
        XCTAssertNil(pack.supportingIdentity(for: track, now: track.lastSeen))
        track.readings = [read(t, words: ["BERNMOBIL","871"]), read(track.lastSeen, words: ["BERNMOBIL","871"])]
        XCTAssertNotNil(pack.supportingIdentity(for: track, now: track.lastSeen))
        XCTAssertNil(pack.supportingIdentity(for: track, now: track.lastSeen.addingTimeInterval(1)))
        track.readings = Array(repeating: track.readings.last!, count: 3)
        XCTAssertNil(pack.supportingIdentity(for: track, now: track.lastSeen))
    }
    @MainActor static let allTests = [
        ("complete display", testCompleteDisplayIsOnlyAVisualCandidate),
        ("wrong route / short working", testWrongRouteAndShortWorkingConflict),
        ("flicker / low quality", testUnreadableAndFlickeringDisplayCannotReuseLastMatch),
        ("out of service", testOutOfServiceOverridesMatchingText),
        ("overlapping vehicles", testTextBehindAnotherVehicleIsNotAssociated),
        ("outside mask", testOutsideMaskIsNotAssociated),
        ("separate displays", testSeparateRowsCannotManufactureDisplay),
        ("stale future duplicate", testStaleFutureAndDuplicateReadingsAbstain),
        ("distinct history", testSimultaneousVehiclesKeepSeparateHistory),
        ("crossing / occlusion", testCrossingAndOcclusionInvalidateTrackIdentity),
        ("clock / reset", testLongGapClockReversalAndResetInvalidateHistory),
        ("bus tram train taxonomy", testThreeTaxaDoNotShareTrackIdentity),
        ("bounded state", testBoundedTracksAndHistory),
        ("authoritative binding", testStrongMatchRequiresFreshIndependentBinding),
        ("pose composition", testPoseCompositionUsesSurveyTransformNotGPS),
        ("rigid transforms", testInvalidRigidTransformsRejected),
        ("sidewalk ambiguity", testAmbiguousSidewalksAndCurbUncertaintyAbstain)
    ]
}
