import XCTest
import CoreGraphics
import SceneKit
import CoreLocation
import JavaScriptCore
import CoreVideo
import CoreImage
#if canImport(RightSide)
@testable import RightSide
#endif

/// Synthetic event ordering and display policy tests, not camera accuracy/performance validation.
final class CameraEvidenceLifecycleTests: XCTestCase {
    func testUnavailableAlternateEngineHasActionableGuidanceAndNoOldPositive() {
        for issue in [DisplayRecognitionIssue.missingModel, .missingDictionary, .initializationFailed] {
            var state = seeded()
            let unknown = overlay(.unknown, reason: "unreadable_display")
            XCTAssertTrue(state.publish(vehicles: [unknown], matches: [], token: state.epoch,
                capturedAt: t.addingTimeInterval(0.1), now: t.addingTimeInterval(0.1), displayIssues: [unknown.id: issue]))
            XCTAssertNil(state.candidateID)
            XCTAssertTrue(state.recognition.contains("unavailable"))
            XCTAssertTrue(state.recognition.contains("departure list"))
            XCTAssertFalse(state.recognition.contains("Hold steady"))
            XCTAssertFalse(state.recognition.contains("Display matches"))
        }
    }
    func testSamplingFailureReframesInsteadOfDeclaringModelUnavailable() {
        var state = CameraEvidenceLifecycle(); state.start(at: t)
        let unknown = overlay(.unknown, reason: "unreadable_display")
        XCTAssertTrue(state.publish(vehicles: [unknown], matches: [], token: state.epoch,
            capturedAt: t, now: t, displayIssues: [unknown.id: .samplingFailed]))
        XCTAssertTrue(state.recognition.contains("Reframe")); XCTAssertFalse(state.recognition.contains("unavailable"))
        XCTAssertNil(state.candidateID)
    }
    func testUsableVisionOrAlternativeRemainsCandidateDespiteOtherInstanceFailure() {
        for issue in [DisplayRecognitionIssue.missingModel, .samplingFailed] {
            var state = CameraEvidenceLifecycle(); state.start(at: t)
            let positive = overlay(), unknown = overlay(.unknown)
            XCTAssertTrue(state.publish(vehicles: [positive, unknown], matches: [], token: state.epoch,
                capturedAt: t, now: t, displayIssues: [unknown.id: issue]))
            XCTAssertEqual(state.candidateID, positive.id)
            XCTAssertTrue(state.recognition.contains("matches"))
            XCTAssertFalse(state.vehicles.contains { $0.decision.state == .verifiedService })
        }
    }
    func testUnavailableMessageExpiresAndDoesNotOverrideSafetyConflict() {
        var state = CameraEvidenceLifecycle(); state.start(at: t)
        let conflict = overlay(.conflicting, reason: "out_of_service")
        XCTAssertTrue(state.publish(vehicles: [conflict], matches: [], token: state.epoch,
            capturedAt: t, now: t, displayIssues: [conflict.id: .missingModel]))
        XCTAssertTrue(state.recognition.contains("Do not board"))
        _ = state.expire(state.feedbackID!, at: t.addingTimeInterval(0.6))
        XCTAssertNil(state.candidateID); XCTAssertFalse(state.recognition.contains("Display matches"))
    }

    func testActualPixelPipelineReportsMissingAndRejectedResourcesAcrossFrames() throws {
        guard let bundlePath = ProcessInfo.processInfo.environment["R9_MODEL_BUNDLE"],
              let imagesPath = ProcessInfo.processInfo.environment["R9_IMAGES"] else { throw XCTSkip("Bounded recorded-input resources not supplied") }
        let bundle = URL(fileURLWithPath: bundlePath), images = URL(fileURLWithPath: imagesPath)
        let detector = bundle.appendingPathComponent("TransportSegmenter.mlmodelc")
        let recognizer = bundle.appendingPathComponent("VehicleDisplayRecognizer.mlmodelc")
        let dictionary = bundle.appendingPathComponent("display-characters.json")
        let badDictionary = FileManager.default.temporaryDirectory.appendingPathComponent("R9-invalid-\(UUID()).json")
        try Data("[]".utf8).write(to: badDictionary)
        defer { try? FileManager.default.removeItem(at: badDictionary) }
        let original = try XCTUnwrap(CIImage(contentsOf: images.appendingPathComponent("tram.jpg")))
        let scale = 1280 / max(original.extent.width, original.extent.height)
        let image = original.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let variants: [(URL?, URL?, DisplayRecognitionIssue)] = [(nil, dictionary, .missingModel),
            (recognizer, nil, .missingDictionary), (recognizer, badDictionary, .initializationFailed)]
        for (model, characters, issue) in variants {
            let pipeline = LocalVehiclePipeline(modelURL: detector, displayModelURL: model, displayCharactersURL: characters)
            let epoch = UUID()
            for offset in [0.0, 0.4, 0.85] {
                let date = t.addingTimeInterval(offset)
                let result = try pipeline.process(upright: image, at: date, epoch: epoch)
                XCTAssertFalse(result.displayIssues.isEmpty, "Actual tram proposal must exercise resource failure")
                XCTAssertTrue(result.displayIssues.values.allSatisfy { $0 == issue })
                let decisions = result.tracks.map { VehicleServiceMatcher.decide($0,
                    expected: VehicleServiceExpectation(line: "8", destination: "Brünnen Westside Bhf"), now: date) }
                XCTAssertFalse(decisions.contains { $0.state == .verifiedService || $0.state == .visualCandidate })
                let overlays = zip(result.tracks, decisions).map { track, decision in
                    CameraVehicleOverlay(id: track.id, box: track.detection.box, maskRuns: [], title: "Tram", decision: decision,
                        displayText: track.readings.last?.displayText, capturedAt: track.readings.last?.at)
                }
                var presentation = CameraEvidenceLifecycle(); presentation.start(at: date)
                XCTAssertTrue(presentation.publish(vehicles: overlays, matches: [], token: presentation.epoch,
                    capturedAt: date, now: date, displayIssues: result.displayIssues))
                XCTAssertTrue(presentation.recognition.contains("unavailable"), presentation.recognition)
                XCTAssertFalse(presentation.recognition.contains("Hold steady"))
            }
        }
        // Complete native Vision reading remains usable without trying the optional model.
        let bus = try XCTUnwrap(CIImage(contentsOf: images.appendingPathComponent("bus.jpg")))
        let busScale = 1280 / max(bus.extent.width, bus.extent.height)
        let visionOnly = LocalVehiclePipeline(modelURL: detector, displayModelURL: nil, displayCharactersURL: nil)
        let result = try visionOnly.process(upright: bus.transformed(by: CGAffineTransform(scaleX: busScale, y: busScale)), at: t, epoch: UUID())
        XCTAssertTrue(result.tracks.contains { $0.readings.last?.line == "12" && $0.readings.last?.destination == VehicleTextRules.normalize("Bern Bahnhof") })
        XCTAssertTrue(result.displayIssues.isEmpty)
    }

    private let t = Date(timeIntervalSince1970: 1_800_000_000)
    private var sign: CameraTextMatch {
        CameraTextMatch(box: CGRect(x: 0.1, y: 0.1, width: 0.2, height: 0.1), text: "Bern", label: "Stop text · check sign")
    }
    private func overlay(_ state: VehicleMatchState = .visualCandidate, reason: String = "test", id: UUID = UUID()) -> CameraVehicleOverlay {
        CameraVehicleOverlay(id: id, box: CGRect(x: 0.1, y: 0.1, width: 0.3, height: 0.5),
            maskRuns: [CGRect(x: 0.1, y: 0.1, width: 0.1, height: 0.1)], title: "Bus",
            decision: VehicleDecision(state: state, reason: reason), capturedAt: t)
    }
    private func context(id: String = "leg", line: String = "6", destination: String = "Fischermätteli",
                         stop: String = "Bern", board: String = "Bern", point: String = "A", simulated: Bool = false) -> CameraJourneyContext {
        CameraJourneyContext(id: id, title: "Journey", line: line, destination: destination, stop: stop,
            target: nil, targetLabel: "Bern", simulated: simulated, boardingStopID: board, boardingPointID: point)
    }
    private func seeded(_ vehicles: [CameraVehicleOverlay]? = nil) -> CameraEvidenceLifecycle {
        var state = CameraEvidenceLifecycle()
        state.start(at: t)
        XCTAssertTrue(state.publish(vehicles: vehicles ?? [overlay()], matches: [], token: state.epoch, capturedAt: t, now: t))
        return state
    }
    private func assertCleared(_ state: CameraEvidenceLifecycle, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(state.vehicles.isEmpty, file: file, line: line)
        XCTAssertTrue(state.matches.isEmpty, file: file, line: line)
        XCTAssertNil(state.candidateID, file: file, line: line)
        XCTAssertNil(state.feedbackID, file: file, line: line)
        XCTAssertFalse(state.recognition.contains("Display matches"), file: file, line: line)
    }

    func testGeometryRefreshCannotRenewPositiveOCREvidence() throws {
        var state = CameraEvidenceLifecycle(); state.start(at: t)
        var vehicle = overlay(); vehicle.capturedAt = t.addingTimeInterval(1)
        XCTAssertTrue(state.publish(vehicles: [vehicle], matches: [], token: state.epoch,
            capturedAt: t.addingTimeInterval(1.4), now: t.addingTimeInterval(1.6)))
        XCTAssertEqual(try XCTUnwrap(state.expiresAt).timeIntervalSince(t), 1.8, accuracy: 0.00001)
        XCTAssertTrue(state.feedbackExpired(at: t.addingTimeInterval(1.85)))
        XCTAssertTrue(state.expire(try XCTUnwrap(state.feedbackID), at: t.addingTimeInterval(1.8)))
        assertCleared(state)
        vehicle.capturedAt = t.addingTimeInterval(1.9)
        XCTAssertTrue(state.publish(vehicles: [vehicle], matches: [], token: state.epoch,
            capturedAt: t.addingTimeInterval(1.9), now: t.addingTimeInterval(2)))
        XCTAssertNotNil(state.candidateID)
    }
    func testMissingFutureOrExpiredPositiveTextCannotPublish() {
        for textTime in [nil, t.addingTimeInterval(1), t.addingTimeInterval(-1)] as [Date?] {
            var state = CameraEvidenceLifecycle(); state.start(at: t)
            var vehicle = overlay(); vehicle.capturedAt = textTime
            XCTAssertFalse(state.publish(vehicles: [vehicle], matches: [], token: state.epoch, capturedAt: t, now: t))
            assertCleared(state)
        }
    }

    func testEveryContextIdentityChangeInvalidatesButIdenticalContextDoesNot() {
        let original = context()
        XCTAssertFalse(CameraEvidenceLifecycle.contextChanged(original, context()))
        for changed in [context(id: "next-leg"), context(line: "7"), context(destination: "Worb Dorf"),
                        context(stop: "Other sign"), context(board: "other-stop"), context(point: "B"), context(simulated: true)] {
            XCTAssertTrue(CameraEvidenceLifecycle.contextChanged(original, changed))
        }
        XCTAssertTrue(CameraEvidenceLifecycle.contextChanged(nil, original))
    }

    func testEveryInvalidationClearsPositiveAndRejectsPendingPublication() {
        for event in CameraEvidenceLifecycle.Invalidation.allCases {
            var state = seeded()
            let pending = state.epoch
            let history = state.trackingEpoch
            state.invalidate(event, at: t.addingTimeInterval(0.1))
            assertCleared(state)
            XCTAssertNotEqual(state.epoch, pending)
            XCTAssertEqual(state.trackingEpoch == history, event == .expired || event == .moved) // a small move keeps the tracks
            XCTAssertFalse(state.publish(vehicles: [overlay()], matches: [sign], token: pending,
                                         capturedAt: t, now: t.addingTimeInterval(0.2)))
            assertCleared(state)
        }
    }

    func testEveryInvalidationAlsoClearsSignOnlyFeedback() {
        for event in CameraEvidenceLifecycle.Invalidation.allCases {
            var state = seeded([])
            XCTAssertTrue(state.publish(vehicles: [], matches: [sign], token: state.epoch, capturedAt: t, now: t))
            XCTAssertEqual(state.matches.count, 1)
            state.invalidate(event, at: t.addingTimeInterval(0.1))
            assertCleared(state)
            XCTAssertFalse(state.recognition.contains("Stop text"))
        }
    }

    func testStopRejectsEvenCurrentTokenUntilRestartAndRestartRejectsOldWork() {
        var state = seeded()
        let old = state.epoch
        state.invalidate(.stopped, at: t.addingTimeInterval(0.1))
        XCTAssertFalse(state.publish(vehicles: [overlay()], matches: [], token: state.epoch, capturedAt: t, now: t))
        state.start(at: t.addingTimeInterval(0.2))
        XCTAssertFalse(state.publish(vehicles: [overlay()], matches: [], token: old, capturedAt: t, now: t.addingTimeInterval(0.3)))
        XCTAssertTrue(state.publish(vehicles: [overlay()], matches: [], token: state.epoch,
                                   capturedAt: t.addingTimeInterval(0.3), now: t.addingTimeInterval(0.3)))
        XCTAssertNotNil(state.candidateID)
    }

    func testExpiryRejectsInFlightWorkEvenBeforeTimerRuns() {
        var state = seeded()
        let pending = state.epoch
        XCTAssertFalse(state.publish(vehicles: [overlay()], matches: [], token: pending,
                                     capturedAt: t.addingTimeInterval(0.4), now: t.addingTimeInterval(0.5)))
        assertCleared(state)
        XCTAssertNotEqual(state.epoch, pending)
    }

    func testExpiryTimerIsBoundToPublishedFrameAndInvalidatesPendingWork() throws {
        var state = seeded()
        let first = try XCTUnwrap(state.feedbackID)
        let pending = state.epoch
        XCTAssertTrue(state.publish(vehicles: [overlay()], matches: [], token: pending,
                                   capturedAt: t.addingTimeInterval(0.4), now: t.addingTimeInterval(0.4)))
        XCTAssertFalse(state.expire(first, at: t.addingTimeInterval(0.5)))
        XCTAssertNotNil(state.candidateID)
        let second = try XCTUnwrap(state.feedbackID)
        XCTAssertTrue(state.expire(second, at: t.addingTimeInterval(0.9)))
        XCTAssertFalse(state.publish(vehicles: [overlay()], matches: [], token: pending,
                                    capturedAt: t.addingTimeInterval(0.8), now: t.addingTimeInterval(0.9)))
        assertCleared(state)
    }

    func testLateFutureAndPreInvalidationFramesCannotPublish() {
        for (capture, delivery) in [(0.0, 0.7), (0.1, 0.0), (-0.01, 0.1)] {
            var state = CameraEvidenceLifecycle(); state.start(at: t)
            XCTAssertFalse(state.publish(vehicles: [overlay()], matches: [sign], token: state.epoch,
                                         capturedAt: t.addingTimeInterval(capture), now: t.addingTimeInterval(delivery)))
            assertCleared(state)
        }
    }

    func testElapsedTimerStillClearsFeedbackAfterWallClockMovesBackwards() throws {
        var state = seeded()
        let pending = state.epoch
        XCTAssertTrue(state.expire(try XCTUnwrap(state.feedbackID), at: t.addingTimeInterval(-60)))
        assertCleared(state)
        XCTAssertFalse(state.publish(vehicles: [overlay()], matches: [], token: pending,
                                     capturedAt: t, now: t.addingTimeInterval(-60)))
    }

    func testSlowFreshResultCannotExtendFeedbackPastCaptureExpiry() throws {
        var state = CameraEvidenceLifecycle(); state.start(at: t)
        XCTAssertTrue(state.publish(vehicles: [overlay()], matches: [], token: state.epoch,
                                   capturedAt: t, now: t.addingTimeInterval(0.6)))
        XCTAssertEqual(try XCTUnwrap(state.expiresAt).timeIntervalSince(t), 0.8, accuracy: 0.00001)
        XCTAssertTrue(state.expire(try XCTUnwrap(state.feedbackID), at: t.addingTimeInterval(0.8)))
        assertCleared(state)
    }

    func testLowPowerCadenceReacquiresUsingFreshFramesWithoutRetainingExpiredHighlight() throws {
        var state = CameraEvidenceLifecycle(); state.start(at: t)
        var tracker = VehicleTracker()
        let history = state.trackingEpoch
        let detection = track(at: t).detection
        for offset in [0.0, 0.8, 1.6] {
            let captured = t.addingTimeInterval(offset)
            tracker.update([detection], at: captured)
            let id = try XCTUnwrap(tracker.tracks.first?.id)
            tracker.record(try XCTUnwrap(track(at: captured).readings.last), trackID: id)
            let tracked = try XCTUnwrap(tracker.tracks.first)
            let decision = VehicleServiceMatcher.decide(tracked, expected: .init(line: "6", destination: "Fischermätteli"), now: captured)
            XCTAssertEqual(decision.state, offset < 1.6 ? .unknown : .visualCandidate)
            XCTAssertEqual(state.trackingEpoch, history)
            XCTAssertTrue(state.publish(vehicles: [CameraVehicleOverlay(id: id, box: detection.box, maskRuns: [], title: "Bus", decision: decision, capturedAt: captured)],
                                       matches: [], token: state.epoch, capturedAt: captured, now: captured))
            if offset < 1.6 {
                let pending = state.epoch
                XCTAssertTrue(state.expire(try XCTUnwrap(state.feedbackID), at: captured.addingTimeInterval(0.5)))
                assertCleared(state)
                XCTAssertFalse(state.publish(vehicles: [overlay()], matches: [], token: pending,
                                             capturedAt: captured, now: captured.addingTimeInterval(0.6)))
            } else { XCTAssertEqual(state.candidateID, id) }
        }
    }

    func testWrongDirectionShortTurnAndOutOfServiceBeatGenericSign() {
        for reason in ["wrong_line_destination_or_short_working", "trip_cancelled_pickup_forbidden_or_short_working", "out_of_service"] {
            var state = seeded([])
            XCTAssertTrue(state.publish(vehicles: [overlay(.conflicting, reason: reason)], matches: [sign], token: state.epoch, capturedAt: t, now: t))
            XCTAssertNil(state.candidateID)
            XCTAssertTrue(state.matches.isEmpty)
            XCTAssertTrue(state.recognition.contains("Do not"))
            XCTAssertFalse(state.recognition.contains("Stop text"))
        }
    }

    func testOneCorrectAndOneWrongRemainInstanceSpecificInEitherOrder() {
        let correct = overlay(), wrong = overlay(.conflicting)
        for incoming in [[correct, wrong], [wrong, correct]] {
            let state = seeded(incoming)
            XCTAssertEqual(state.candidateID, correct.id)
            XCTAssertEqual(state.vehicles.first(where: { $0.id == wrong.id })?.decision.state, .conflicting)
            XCTAssertTrue(state.recognition.contains("highlighted vehicle"))
        }
    }

    func testMultipleMatchingVehiclesAbstainIncludingVerifiedState() {
        for second in [VehicleMatchState.visualCandidate, .verifiedService] {
            let state = seeded([overlay(), overlay(second), overlay(.conflicting)])
            XCTAssertNil(state.candidateID)
            XCTAssertEqual(state.vehicles.map(\.decision.state), [.unknown, .unknown, .conflicting])
            XCTAssertTrue(state.recognition.contains("Point at one vehicle"))
        }
    }

    func testUnknownVehicleCannotBorrowGenericSignAndLossClearsCandidate() {
        var state = seeded()
        XCTAssertTrue(state.publish(vehicles: [overlay(.unknown)], matches: [sign], token: state.epoch,
                                   capturedAt: t.addingTimeInterval(0.2), now: t.addingTimeInterval(0.2)))
        XCTAssertNil(state.candidateID)
        XCTAssertTrue(state.matches.isEmpty)
        XCTAssertTrue(state.recognition.contains("Cannot confirm"))
        XCTAssertTrue(state.publish(vehicles: [], matches: [], token: state.epoch,
                                   capturedAt: t.addingTimeInterval(0.4), now: t.addingTimeInterval(0.4)))
        XCTAssertTrue(state.vehicles.isEmpty)
        XCTAssertTrue(state.recognition.contains("Point at the full vehicle"))
    }

    func testOtherBusDisplayRowCannotSupplyIdentityToPartialDisplay() {
        let mask = VehicleMask(width: 100, height: 100, pixels: Array(repeating: 1, count: 10000))
        let a = VehicleDetection(kind: .bus, box: CGRect(x: 0.05, y: 0.1, width: 0.35, height: 0.6), score: 0.9, mask: mask)
        let b = CGRect(x: 0.5, y: 0.1, width: 0.4, height: 0.6)
        let texts = [VehicleText(text: "6", box: CGRect(x: 0.1, y: 0.15, width: 0.05, height: 0.06), score: 0.9),
                     VehicleText(text: "Fischermätteli", box: CGRect(x: 0.55, y: 0.15, width: 0.3, height: 0.06), score: 0.9)]
        let readings = [0.0, 0.4, 0.8].map { offset in
            VehicleTextRules.read(texts, detection: a, otherBoxes: [b], at: t.addingTimeInterval(offset), frameID: UUID())
        }
        XCTAssertTrue(readings.allSatisfy { $0.line == nil && $0.destination == nil && !$0.raw.contains("Fischermätteli") })
        let track = VehicleTrack(id: UUID(), detection: a, lastSeen: t.addingTimeInterval(0.8), readings: readings)
        XCTAssertEqual(VehicleServiceMatcher.decide(track, expected: .init(line: "6", destination: "Fischermätteli"), now: track.lastSeen).state, .unknown)
    }

    private func track(at time: Date) -> VehicleTrack {
        let display = overlay()
        return VehicleTrack(id: display.id, detection: VehicleDetection(kind: .bus, box: display.box, score: 0.9,
            mask: VehicleMask(width: 1, height: 1, pixels: [1])), lastSeen: time,
            readings: [DisplayReading(frameID: UUID(), at: time, line: "6", destination: "fischermatteli",
                                      outOfService: false, ambiguous: false, raw: ["6 Fischermätteli"])])
    }

    func testWireAdapterDoesNotRedateOldOCRWhenOnlyBoxWasRefreshed() {
        var oldText = track(at: t)
        oldText.lastSeen = t.addingTimeInterval(0.4)
        XCTAssertNil(VehicleWireAdapter.observation(oldText, at: oldText.lastSeen, imageSize: CGSize(width: 1000, height: 1000)))
        XCTAssertNil(VehicleWireAdapter.observation(track(at: t), at: t.addingTimeInterval(0.1), imageSize: CGSize(width: 1000, height: 1000)))
    }

    func testWireAdapterOnlySendsObservationAndDomainCannotConfirmOrMovePhone() throws {
        let js = try XCTUnwrap(JSContext())
        let url = try XCTUnwrap(Bundle.main.url(forResource: "domain", withExtension: "js"))
        js.evaluateScript(try String(contentsOf: url, encoding: .utf8))
        let api = try XCTUnwrap(js.objectForKeyedSubscript("RightSideBridge"))
        func call(_ method: String, _ payload: JSONValue) throws -> JSONValue {
            let response = try XCTUnwrap(api.invokeMethod("call", withArguments: [method, try payload.encoded()])?.toString())
            let envelope = try JSONValue(json: response)
            XCTAssertEqual(envelope["ok"], .bool(true), response)
            return envelope["value"]
        }
        let fixtureURL = try XCTUnwrap(Bundle.main.url(forResource: "bern-demo", withExtension: "json"))
        let fixture = try JSONValue(json: String(contentsOf: fixtureURL, encoding: .utf8))
        let journey = fixture["journey"]
        let ride = try XCTUnwrap(journey["legs"].array.first { $0["kind"].string == "ride" })
        let expectedLine = try XCTUnwrap(ride["line"].string)
        let expectedDestination = try XCTUnwrap(ride["headsign"].string)
        let start = try XCTUnwrap(WireClock.date(journey["legs"].array[0]["plannedStart"].string!))
        var state = try call("create", .object(["journey": journey, "now": .string(WireClock.string(start))]))
        state = try call("confirm", .object(["state": state, "action": .string("at_waiting_area"), "now": .string(WireClock.string(start))]))
        XCTAssertEqual(state["phase"], .string("waiting"))
        let before = state
        let identity = track(at: start).id
        for offset in [0.0, 0.4, 0.8] {
            let captured = start.addingTimeInterval(offset)
            let sample = track(at: captured)
            let reading = DisplayReading(frameID: UUID(), at: captured, line: expectedLine, destination: expectedDestination,
                                         outOfService: false, ambiguous: false, raw: [expectedLine + " " + expectedDestination])
            let sameTrack = VehicleTrack(id: identity, detection: sample.detection, lastSeen: captured, readings: [reading])
            let observation = try XCTUnwrap(VehicleWireAdapter.observation(sameTrack, at: captured, imageSize: CGSize(width: 1000, height: 1000)))
            XCTAssertEqual(observation["candidates"], .array([]))
            XCTAssertEqual(observation["capturedAt"], .string(PackClock.string(captured)))
            XCTAssertEqual(observation["evidence"].array.first?["kind"], .string("observed"))
            XCTAssertEqual(observation["rawCoordinate"], .null)
            state = try call("vision", .object(["state": state, "observation": observation, "now": .string(WireClock.string(captured))]))
            XCTAssertNotEqual(state["serviceMatch"]["status"], .string("matching"))
            XCTAssertEqual(state["position"], before["position"])
            XCTAssertEqual(state["phase"], before["phase"])
        }
        XCTAssertTrue(state["serviceMatch"]["reasonCodes"].strings.contains("no_compatible_service"))
    }

    // Held-out ordering: composed only after the basic context/expiry rules were fixed.
    // A timer from session A and completion from B arrive after context C + thermal recovery.
    func testHeldOutRestartContextThermalAndOldTimerOrdering() throws {
        var state = seeded()
        let timerA = try XCTUnwrap(state.feedbackID), workA = state.epoch
        state.invalidate(.stopped, at: t.addingTimeInterval(0.1))
        state.start(at: t.addingTimeInterval(0.2))
        let workB = state.epoch
        state.invalidate(.contextChanged, at: t.addingTimeInterval(0.25))
        state.invalidate(.thermal, at: t.addingTimeInterval(0.3))
        XCTAssertFalse(state.expire(timerA, at: t.addingTimeInterval(0.6)))
        for old in [workA, workB] {
            XCTAssertFalse(state.publish(vehicles: [overlay()], matches: [sign], token: old,
                                         capturedAt: t.addingTimeInterval(0.2), now: t.addingTimeInterval(0.6)))
            assertCleared(state)
        }
        XCTAssertTrue(state.publish(vehicles: [overlay(.conflicting, reason: "out_of_service")], matches: [sign],
                                   token: state.epoch, capturedAt: t.addingTimeInterval(0.6), now: t.addingTimeInterval(0.6)))
        XCTAssertFalse(state.expire(timerA, at: t.addingTimeInterval(0.7)))
        XCTAssertTrue(state.recognition.contains("out of service"))
        XCTAssertNil(state.candidateID)
    }
    @MainActor private static func localSeed() -> (LocalCameraEvidenceLifecycle, VisualLocationStore, SCNNode, SCNNode) {
        let t = Date(timeIntervalSince1970: 1_800_000_000)
        let store = VisualLocationStore(), root = SCNNode(), node = SCNNode()
        var state = LocalCameraEvidenceLifecycle()
        state.installedPackDescription = "Installed reviewed reference pack · v2"
        state.start(session: UUID(), at: t, visual: store, resetAlignment: {})
        XCTAssertTrue(Self.localPublish(&state, at: t, store: store, root: root, node: node))
        XCTAssertTrue(node.parent === root)
        return (state, store, root, node)
    }
    @MainActor private static func localPublish(_ state: inout LocalCameraEvidenceLifecycle, at: Date,
        now: Date? = nil, store: VisualLocationStore, root: SCNNode, node: SCNNode?,
        session: UUID? = nil, generation: UUID? = nil) -> Bool {
        state.publish(pose: matrix_identity_float4x4,
            location: VisualLocation(coordinate: CLLocationCoordinate2D(latitude: 46.9, longitude: 7.4), capturedAt: at, maximumAge: 0.5),
            area: node.map { ("Boarding area A", $0) }, root: root, session: session ?? state.session,
            generation: generation ?? state.generation, capturedAt: at, now: now ?? at, visual: store, resetAlignment: {})
    }
    @MainActor private static func assertLocalCleared(_ state: LocalCameraEvidenceLifecycle, store: VisualLocationStore,
        node: SCNNode, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertNil(state.pose, file: file, line: line)
        XCTAssertNil(state.areaNode, file: file, line: line)
        XCTAssertNil(node.parent, file: file, line: line)
        XCTAssertNil(store.observation, file: file, line: line)
        XCTAssertNil(state.ticket, file: file, line: line)
        XCTAssertFalse(state.status.contains("Within surveyed area"), file: file, line: line)
    }
    func testLocalEveryInvalidationClearsRealNodePoseAndAssertionWithoutAnotherFrame() {
        MainActor.assumeIsolated {
            let t = Date(timeIntervalSince1970: 1_800_000_000)
            for reason in CameraEvidenceLifecycle.Invalidation.allCases {
                var (state, store, _, node) = Self.localSeed()
                var resets = 0
                state.invalidate(reason, at: t.addingTimeInterval(0.1), visual: store) { resets += 1 }
                Self.assertLocalCleared(state, store: store, node: node)
                XCTAssertEqual(resets, 1)
                XCTAssertEqual(state.installedPackDescription, "Installed reviewed reference pack · v2")
            }
        }
    }
    func testLocalObservationDeadlineUsesCaptureTimeNotPublicationTime() throws {
        try MainActor.assumeIsolated {
            let t = Date(timeIntervalSince1970: 1_800_000_000)
            let store = VisualLocationStore(), root = SCNNode(), node = SCNNode()
            var state = LocalCameraEvidenceLifecycle()
            state.start(session: UUID(), at: t, visual: store, resetAlignment: {})
            XCTAssertTrue(Self.localPublish(&state, at: t, now: t.addingTimeInterval(0.31), store: store, root: root, node: node))
            let ticket = try XCTUnwrap(state.ticket)
            XCTAssertEqual(ticket.expiresAt, t.addingTimeInterval(0.5))
            XCTAssertTrue(state.expire(ticket, session: state.session, at: ticket.expiresAt, visual: store, resetAlignment: {}))
            Self.assertLocalCleared(state, store: store, node: node)
        }
    }
    func testLocalOldTimerCannotClearFreshRelocalizedArea() throws {
        try MainActor.assumeIsolated {
            let t = Date(timeIntervalSince1970: 1_800_000_000)
            var (state, store, root, oldNode) = Self.localSeed()
            let old = try XCTUnwrap(state.ticket), oldGeneration = state.generation
            state.invalidate(.trackingLost, at: t.addingTimeInterval(0.1), visual: store, resetAlignment: {})
            Self.assertLocalCleared(state, store: store, node: oldNode)
            let newNode = SCNNode()
            XCTAssertTrue(Self.localPublish(&state, at: t.addingTimeInterval(0.4), store: store, root: root, node: newNode))
            XCTAssertFalse(state.expire(old, session: state.session, at: t.addingTimeInterval(0.5), visual: store, resetAlignment: {}))
            XCTAssertFalse(Self.localPublish(&state, at: t.addingTimeInterval(0.45), store: store, root: root, node: SCNNode(), generation: oldGeneration))
            XCTAssertTrue(newNode.parent === root)
            XCTAssertNotNil(state.pose); XCTAssertNotNil(store.observation)
            XCTAssertTrue(state.status.contains("Within surveyed area"))
        }
    }
    func testLocalStoppedAndOldSessionResultsStayRejectedAfterRestart() throws {
        try MainActor.assumeIsolated {
            let t = Date(timeIntervalSince1970: 1_800_000_000)
            var (state, store, root, node) = Self.localSeed()
            let oldSession = state.session, oldGeneration = state.generation, oldTicket = try XCTUnwrap(state.ticket)
            state.invalidate(.stopped, at: t.addingTimeInterval(0.1), visual: store, resetAlignment: {})
            XCTAssertFalse(Self.localPublish(&state, at: t.addingTimeInterval(0.2), store: store, root: root, node: SCNNode()))
            Self.assertLocalCleared(state, store: store, node: node)
            state.start(session: UUID(), at: t.addingTimeInterval(0.3), visual: store, resetAlignment: {})
            let freshNode = SCNNode()
            XCTAssertTrue(Self.localPublish(&state, at: t.addingTimeInterval(0.4), store: store, root: root, node: freshNode))
            XCTAssertFalse(Self.localPublish(&state, at: t.addingTimeInterval(0.45), store: store, root: root, node: SCNNode(), session: oldSession, generation: oldGeneration))
            XCTAssertFalse(state.expire(oldTicket, session: oldSession, at: t.addingTimeInterval(0.5), visual: store, resetAlignment: {}))
            XCTAssertTrue(freshNode.parent === root)
        }
    }
    func testLocalDuplicateCallbackCannotRenewDeadlineOrReplaceNode() throws {
        try MainActor.assumeIsolated {
            let t = Date(timeIntervalSince1970: 1_800_000_000)
            var (state, store, root, node) = Self.localSeed()
            let ticket = try XCTUnwrap(state.ticket), duplicate = SCNNode()
            XCTAssertFalse(Self.localPublish(&state, at: t, now: t.addingTimeInterval(0.2), store: store, root: root, node: duplicate))
            XCTAssertEqual(state.ticket, ticket); XCTAssertTrue(node.parent === root); XCTAssertNil(duplicate.parent)
        }
    }
    func testLocalStaleFutureAndPreContextObservationsClearInsteadOfConfirming() {
        MainActor.assumeIsolated {
            let t = Date(timeIntervalSince1970: 1_800_000_000)
            for (capture, delivered) in [(t, t.addingTimeInterval(0.5)), (t.addingTimeInterval(1), t),
                                         (t.addingTimeInterval(-0.1), t)] {
                var (state, store, root, node) = Self.localSeed()
                XCTAssertFalse(Self.localPublish(&state, at: capture, now: delivered, store: store, root: root, node: SCNNode()))
                Self.assertLocalCleared(state, store: store, node: node)
            }
        }
    }
    func testLocalPoseWithoutConfirmedAreaRemovesPreviousPolygonAndAssertion() throws {
        try MainActor.assumeIsolated {
            let t = Date(timeIntervalSince1970: 1_800_000_000)
            var (state, store, root, node) = Self.localSeed()
            XCTAssertTrue(Self.localPublish(&state, at: t.addingTimeInterval(0.2), store: store, root: root, node: nil))
            XCTAssertNil(node.parent); XCTAssertNil(state.areaNode)
            XCTAssertNotNil(state.pose); XCTAssertNotNil(store.observation)
            XCTAssertFalse(state.status.contains("Within surveyed area"))
            let timer = try XCTUnwrap(state.ticket)
            XCTAssertTrue(state.expire(timer, session: state.session, at: t.addingTimeInterval(0.7), visual: store, resetAlignment: {}))
            Self.assertLocalCleared(state, store: store, node: node)
        }
    }
    func testLocalMonotonicTimerClearsEvenAfterWallClockReversal() throws {
        try MainActor.assumeIsolated {
            let t = Date(timeIntervalSince1970: 1_800_000_000)
            var (state, store, _, node) = Self.localSeed()
            let ticket = try XCTUnwrap(state.ticket)
            XCTAssertTrue(state.expire(ticket, session: state.session, at: t.addingTimeInterval(-60), visual: store, resetAlignment: {}))
            Self.assertLocalCleared(state, store: store, node: node)
        }
    }
    func testLocalActualConsensusReacquiresAfterLossWithoutCandidateResetLoop() {
        MainActor.assumeIsolated {
            let t = Date(timeIntervalSince1970: 1_800_000_000)
            var state = LocalCameraEvidenceLifecycle(), consensus = LocalPoseConsensus()
            let store = VisualLocationStore(), root = SCNNode()
            let references = [LocalPoseReferenceEstimate(landmarkID: "left", siteFromWorld: matrix_identity_float4x4),
                              LocalPoseReferenceEstimate(landmarkID: "right", siteFromWorld: matrix_identity_float4x4)]
            state.start(session: UUID(), at: t, visual: store) { consensus.reset() }
            for cycle in 0..<2 {
                for frame in 0..<3 {
                    let at = t.addingTimeInterval(Double(cycle) + Double(frame) * 0.2)
                    let assessment = consensus.update(estimates: references, worldFromCamera: matrix_identity_float4x4,
                        at: at, now: at, trackingNormal: true, errorBoundMeters: 0.3,
                        headingBoundDegrees: 3, verticalErrorBoundMeters: 0.1)
                    if assessment.status == .reliable {
                        XCTAssertTrue(Self.localPublish(&state, at: at, store: store, root: root, node: SCNNode()))
                    } else {
                        // Same transaction used by the controller for candidate/relocalizing frames.
                        state.invalidate(.trackingLost, at: at, visual: store, resetAlignment: {})
                        XCTAssertNil(state.pose); XCTAssertTrue(root.childNodes.isEmpty)
                    }
                }
                XCTAssertEqual(consensus.assessment?.status, .reliable)
                XCTAssertTrue(state.status.contains("Within surveyed area"))
                XCTAssertEqual(root.childNodes.count, 1)
                state.invalidate(.trackingLost, at: t.addingTimeInterval(Double(cycle) + 0.5), visual: store) { consensus.reset() }
                XCTAssertNil(consensus.assessment); XCTAssertNil(store.observation)
                XCTAssertTrue(root.childNodes.isEmpty); XCTAssertNil(state.pose)
                XCTAssertFalse(state.status.contains("Within surveyed area"))
            }
        }
    }

    func testDelayedPixelProgressPublishesAfterCandidateClearingAndIdleExpiry() throws {
        try MainActor.assumeIsolated {
            let start = Date(timeIntervalSince1970: 1_800_000_000)
            for cadence in [0.2, 0.4] {
                var state = LocalCameraEvidenceLifecycle(), progress = LocalPixelPoseProgress()
                let store = VisualLocationStore(), root = SCNNode()
                let references = ["A", "B"].map { LocalPoseReferenceEstimate(landmarkID: $0, siteFromWorld: matrix_identity_float4x4) }
                state.start(session: UUID(), at: start, visual: store) { progress.reset() }
                let generation = state.generation
                state.clearPresentation(visual: store) // capture0 already submitted, no result yet
                for index in 0..<3 {
                    let capture = start.addingTimeInterval(Double(index) * cadence)
                    let delivery = capture.addingTimeInterval(cadence)
                    progress.receive(estimates: references, worldFromCamera: matrix_identity_float4x4,
                        at: capture, now: delivery, horizontal: 0.3, vertical: 0.1, heading: 3)
                    let result = try XCTUnwrap(progress.fresh(at: delivery))
                    if index < 2 {
                        XCTAssertNotEqual(result.status, .reliable)
                        state.clearPresentation(visual: store)
                        if cadence == 0.4 {
                            // Next controller callback has no completed frame; old output expires,
                            // but this is not a tracking reset of the in-flight frame/history.
                            XCTAssertNil(progress.fresh(at: delivery.addingTimeInterval(0.2)))
                            state.clearPresentation(visual: store)
                        }
                        XCTAssertNil(store.observation); XCTAssertTrue(root.childNodes.isEmpty)
                    } else {
                        XCTAssertEqual(result.status, .reliable)
                        let node = SCNNode()
                        XCTAssertTrue(Self.localPublish(&state, at: result.at, now: delivery,
                            store: store, root: root, node: node, generation: generation))
                        XCTAssertTrue(node.parent === root); XCTAssertNotNil(store.observation)
                        let ticket = try XCTUnwrap(state.ticket)
                        XCTAssertEqual(ticket.expiresAt, capture.addingTimeInterval(0.5))
                        XCTAssertFalse(Self.localPublish(&state, at: result.at, now: delivery,
                            store: store, root: root, node: SCNNode()))
                        XCTAssertEqual(state.ticket, ticket)
                        XCTAssertTrue(state.expire(ticket, session: state.session, at: ticket.expiresAt,
                            visual: store) { progress.reset() })
                        Self.assertLocalCleared(state, store: store, node: node)
                        XCTAssertNil(progress.fresh(at: ticket.expiresAt))
                        XCTAssertFalse(Self.localPublish(&state, at: capture, now: ticket.expiresAt,
                            store: store, root: root, node: SCNNode(), generation: generation))
                    }
                }
            }
        }
    }
    func testPresentationClearingCannotReviveDuplicateOrPreResetCapture() throws {
        try MainActor.assumeIsolated {
            let t = Date(timeIntervalSince1970: 1_800_000_000)
            var (state, store, root, node) = Self.localSeed()
            let oldGeneration = state.generation, oldTicket = try XCTUnwrap(state.ticket)
            state.clearPresentation(visual: store)
            Self.assertLocalCleared(state, store: store, node: node)
            XCTAssertEqual(state.generation, oldGeneration)
            XCTAssertFalse(Self.localPublish(&state, at: t, now: t.addingTimeInterval(0.1), store: store, root: root, node: SCNNode()))
            XCTAssertFalse(state.expire(oldTicket, session: state.session, at: t.addingTimeInterval(0.5), visual: store, resetAlignment: {}))
            state.invalidate(.contextChanged, at: t.addingTimeInterval(0.2), visual: store, resetAlignment: {})
            XCTAssertFalse(Self.localPublish(&state, at: t.addingTimeInterval(0.1), now: t.addingTimeInterval(0.3), store: store, root: root, node: SCNNode()))
            XCTAssertNil(state.pose); XCTAssertNil(store.observation)
        }
    }

    func testOlderPixelCaptureCurrentFrameRevokesNewerSynchronousArea() throws {
        try MainActor.assumeIsolated {
            let t = Date(timeIntervalSince1970: 1_800_000_000)
            let area = LocalLandmarkPack.Area(id: "A", stopID: "stop", label: "A", level: "0",
                floorHeightMeters: 0, polygonENU: [[0,0],[10,0],[10,10],[0,10]], surveyedClearanceMeters: 0.75)
            for position in [SIMD3<Double>(0.79,5,1.5), SIMD3<Double>(1.1,5,0.44), SIMD3<Double>(1.1,5,1.5)] {
                var state = LocalCameraEvidenceLifecycle()
                let store = VisualLocationStore(), root = SCNNode(), node = SCNNode()
                state.start(session: UUID(), at: t, visual: store, resetAlignment: {})
                let generation = state.generation
                let synchronous = t.addingTimeInterval(0.609375)
                XCTAssertTrue(state.publish(pose: matrix_identity_float4x4,
                    location: VisualLocation(coordinate: .init(latitude:46.9,longitude:7.4), capturedAt:synchronous, maximumAge:0.5),
                    area:("A",node), root:root, session:state.session, generation:generation,
                    capturedAt:synchronous, now:synchronous, areaIdentity:"A", evaluationFrameTime:0.609375,
                    visual:store, resetAlignment:{}))
                let ticket = try XCTUnwrap(state.ticket)
                let qualifies = LocalLandmarkGeometry.boardingArea(camera:position, horizontalBound:0.05,
                    verticalBound:0.05, areas:[area], stopID:"stop") != nil
                let pixel = t.addingTimeInterval(0.40625), current = t.addingTimeInterval(0.8125)
                var resets = 0
                // The third case changes area identity while retaining the exact same label.
                XCTAssertFalse(state.publish(pose:matrix_identity_float4x4,
                    location:VisualLocation(coordinate:.init(latitude:46.91,longitude:7.41),capturedAt:pixel,maximumAge:0.5),
                    area:qualifies ? ("A",SCNNode()) : nil, root:root, session:state.session, generation:generation,
                    capturedAt:pixel, now:current, areaIdentity:qualifies ? "B" : nil, evaluationFrameTime:0.8125,
                    visual:store, resetAlignment:{ resets += 1 }))
                Self.assertLocalCleared(state,store:store,node:node)
                XCTAssertEqual(resets,0); XCTAssertEqual(state.generation,generation)
                XCTAssertFalse(state.expire(ticket,session:state.session,at:ticket.expiresAt,visual:store,resetAlignment:{}))
            }
        }
    }
    func testOlderFrameCannotRevokeOrOverwriteCurrentSynchronousEvidence() throws {
        try MainActor.assumeIsolated {
            let t = Date(timeIntervalSince1970: 1_800_000_000)
            var state = LocalCameraEvidenceLifecycle()
            let store = VisualLocationStore(), root = SCNNode(), node = SCNNode()
            state.start(session:UUID(),at:t,visual:store,resetAlignment:{})
            let capture = t.addingTimeInterval(0.3)
            XCTAssertTrue(state.publish(pose:matrix_identity_float4x4,
                location:VisualLocation(coordinate:.init(latitude:46.9,longitude:7.4),capturedAt:capture,maximumAge:0.5),
                area:("A",node),root:root,session:state.session,generation:state.generation,
                capturedAt:capture,now:capture,areaIdentity:"A",evaluationFrameTime:10.3,visual:store,resetAlignment:{}))
            let ticket = try XCTUnwrap(state.ticket)
            // Even a later delivered callback with an older AR-frame identity cannot revoke.
            XCTAssertFalse(state.publish(pose:matrix_identity_float4x4,
                location:VisualLocation(coordinate:.init(latitude:0,longitude:0),capturedAt:t,maximumAge:0.5),
                area:nil,root:root,session:state.session,generation:state.generation,
                capturedAt:t,now:t.addingTimeInterval(0.4),evaluationFrameTime:10.2,visual:store,resetAlignment:{}))
            XCTAssertEqual(state.ticket,ticket); XCTAssertTrue(node.parent === root)
            XCTAssertEqual(store.observation?.coordinate.latitude,46.9)
            // A current frame with the older capture and unchanged area cannot renew/overwrite either.
            XCTAssertFalse(state.publish(pose:matrix_identity_float4x4,
                location:VisualLocation(coordinate:.init(latitude:0,longitude:0),capturedAt:t,maximumAge:0.5),
                area:("A",SCNNode()),root:root,session:state.session,generation:state.generation,
                capturedAt:t,now:t.addingTimeInterval(0.4),areaIdentity:"A",evaluationFrameTime:10.4,visual:store,resetAlignment:{}))
            XCTAssertEqual(state.ticket,ticket); XCTAssertEqual(store.observation?.coordinate.latitude,46.9)
        }
    }
    func testPublicationAgingOutPreservesAcquisitionAndRejectsStaleOutput() {
        MainActor.assumeIsolated {
            let t = Date(timeIntervalSince1970:1_800_000_000)
            var state = LocalCameraEvidenceLifecycle(), progress = LocalPixelPoseProgress()
            let store = VisualLocationStore(), root = SCNNode()
            state.start(session:UUID(),at:t,visual:store,resetAlignment:{})
            let generation = state.generation
            let refs = ["A","B"].map {LocalPoseReferenceEstimate(landmarkID:$0,siteFromWorld:matrix_identity_float4x4)}
            for capture in [0.0,0.4,0.8] {
                progress.receive(estimates:refs,worldFromCamera:matrix_identity_float4x4,
                    at:t.addingTimeInterval(capture),now:t.addingTimeInterval(capture+0.49),horizontal:0.3,vertical:0.1,heading:3)
            }
            XCTAssertEqual(progress.fresh(at:t.addingTimeInterval(1.29))?.status,.reliable)
            var resets = 0
            let old = t.addingTimeInterval(0.8)
            XCTAssertFalse(state.publish(pose:matrix_identity_float4x4,
                location:VisualLocation(coordinate:.init(latitude:46.9,longitude:7.4),capturedAt:old,maximumAge:0.5),
                area:("A",SCNNode()),root:root,session:state.session,generation:generation,
                capturedAt:old,now:t.addingTimeInterval(1.31),evaluationFrameTime:1.29,visual:store,
                resetAlignment:{resets += 1;progress.reset()}))
            XCTAssertNil(state.ticket); XCTAssertNil(store.observation); XCTAssertEqual(resets,0)
            XCTAssertEqual(state.generation,generation)
            let newer = t.addingTimeInterval(1.29), delivery = t.addingTimeInterval(1.70)
            progress.receive(estimates:refs,worldFromCamera:matrix_identity_float4x4,at:newer,now:delivery,horizontal:0.3,vertical:0.1,heading:3)
            XCTAssertEqual(progress.fresh(at:delivery)?.status,.reliable)
            XCTAssertTrue(Self.localPublish(&state,at:newer,now:delivery,store:store,root:root,node:SCNNode(),generation:generation))
        }
    }
    #if SPATIAL_HARNESS
    func testPublicationExpiryPreservesActualQueuedWorkerButHardResetRejectsIt() throws {
        try MainActor.assumeIsolated {
            for hardReset in [false,true] {
                let cg = try XCTUnwrap(CGContext(data:nil,width:64,height:64,bitsPerComponent:8,bytesPerRow:256,
                    space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.noneSkipLast.rawValue))
                let image = try XCTUnwrap(cg.makeImage())
                let identity:[Double] = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
                let refs = ["A","B"].map {VisualReferenceImage(plane:.init(id:$0,widthMeters:2,heightMeters:1.5,siteFromPlane:identity),image:image)}
                let pipeline = VisualReferencePipeline(references:refs)
                let entered = DispatchSemaphore(value:0), release = DispatchSemaphore(value:0)
                pipeline.testingHold {entered.signal();release.wait()}
                XCTAssertEqual(entered.wait(timeout:.now()+2),.success)
                var buffer:CVPixelBuffer?
                XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault,64,64,kCVPixelFormatType_32BGRA,nil,&buffer),kCVReturnSuccess)
                let capture = Date(), t = capture.addingTimeInterval(-1.29)
                let context = VisualReferenceFrameContext(epoch:UUID(),calibration:.init(width:64,height:64,fx:80,fy:80,cx:32,cy:32,imageOrientation:"raw_sensor"),worldFromCamera:matrix_identity_float4x4,capturedAt:capture,uptime:ProcessInfo.processInfo.systemUptime,orientation:"raw_sensor",worldUp:SIMD3(0,1,0),gravityReliable:true,crop:[0,0,1,1])
                XCTAssertTrue(pipeline.submit(buffer:try XCTUnwrap(buffer),context:context))
                var state = LocalCameraEvidenceLifecycle()
                let store = VisualLocationStore(), root = SCNNode()
                state.start(session:UUID(),at:t,visual:store,resetAlignment:{})
                let generation = state.generation, old = t.addingTimeInterval(0.8)
                XCTAssertFalse(state.publish(pose:matrix_identity_float4x4,
                    location:VisualLocation(coordinate:.init(latitude:46.9,longitude:7.4),capturedAt:old,maximumAge:0.5),
                    area:nil,root:root,session:state.session,generation:generation,capturedAt:old,
                    now:t.addingTimeInterval(1.31),evaluationFrameTime:1.29,visual:store,resetAlignment:{pipeline.reset()}))
                if hardReset {state.invalidate(.contextChanged,at:t.addingTimeInterval(1.32),visual:store,resetAlignment:{pipeline.reset()})}
                release.signal();pipeline.testingDrain()
                // Blank input cannot establish a pose. Its actual completion still proves
                // the production one-in-flight generation survived only the display expiry.
                let result = pipeline.takeResult()
                if hardReset {XCTAssertNil(result);XCTAssertNotEqual(state.generation,generation)}
                else {XCTAssertEqual(result?.context.epoch,context.epoch);XCTAssertEqual(state.generation,generation)}
                XCTAssertNil(store.observation)
            }
        }
    }
    #endif
    func testSameCaptureGeometryRevocationClearsAreaImmediately() throws {
        try MainActor.assumeIsolated {
            let t = Date(timeIntervalSince1970: 1_800_000_000)
            let area = LocalLandmarkPack.Area(id: "A", stopID: "stop", label: "A", level: "0",
                floorHeightMeters: 0, polygonENU: [[0,0],[10,0],[10,10],[0,10]], surveyedClearanceMeters: 0.75)
            for rejected in [SIMD3<Double>(0.79,5,1.5), SIMD3<Double>(1.1,5,0.44)] {
                var (state, store, root, node) = Self.localSeed()
                let ticket = try XCTUnwrap(state.ticket), generation = state.generation
                XCTAssertEqual(LocalLandmarkGeometry.boardingArea(camera: SIMD3(1.1,5,1.5), horizontalBound: 0.05,
                    verticalBound: 0.05, areas: [area], stopID: "stop"), 0)
                let result = LocalLandmarkGeometry.boardingArea(camera: rejected, horizontalBound: 0.05,
                    verticalBound: 0.05, areas: [area], stopID: "stop")
                XCTAssertNil(result)
                // Same production transaction and capture; current VIO invalidates the old area.
                XCTAssertFalse(Self.localPublish(&state, at: t, now: t.addingTimeInterval(0.4),
                    store: store, root: root, node: result.map { _ in SCNNode() }))
                Self.assertLocalCleared(state, store: store, node: node)
                XCTAssertEqual(state.generation, generation)
                XCTAssertFalse(state.expire(ticket, session: state.session, at: ticket.expiresAt, visual: store, resetAlignment: {}))
            }
        }
    }
    func testSlowWorkerKeepsAcquiringAcrossDisplayExpiry() throws {
        try MainActor.assumeIsolated {
            let start = Date(timeIntervalSince1970: 1_800_000_000), step = 0.40625
            var state = LocalCameraEvidenceLifecycle(), progress = LocalPixelPoseProgress()
            let store = VisualLocationStore(), root = SCNNode()
            let references = ["A","B"].map { LocalPoseReferenceEstimate(landmarkID: $0, siteFromWorld: matrix_identity_float4x4) }
            state.start(session: UUID(), at: start, visual: store) { progress.reset() }
            let generation = state.generation
            var accepted = 0, acquisitionResets = 0
            // Each .31s worker finishes before the next .40625s delivery. The newer capture
            // is already in flight when the previous display expires, with the same epoch.
            for index in 0..<8 {
                let capture = start.addingTimeInterval(Double(index)*step), delivery = capture.addingTimeInterval(step)
                progress.receive(estimates: references, worldFromCamera: matrix_identity_float4x4,
                    at: capture, now: delivery, horizontal: 0.3, vertical: 0.1, heading: 3)
                let result = try XCTUnwrap(progress.fresh(at: delivery))
                if index < 2 { state.clearPresentation(visual: store); continue }
                XCTAssertEqual(result.status, .reliable)
                let node = SCNNode()
                XCTAssertTrue(Self.localPublish(&state, at: capture, now: delivery, store: store, root: root, node: node, generation: generation))
                accepted += 1
                let ticket = try XCTUnwrap(state.ticket)
                XCTAssertEqual(ticket.expiresAt, capture.addingTimeInterval(0.5))
                XCTAssertTrue(state.expire(ticket, session: state.session, at: ticket.expiresAt, visual: store) {
                    acquisitionResets += 1; progress.reset()
                })
                Self.assertLocalCleared(state, store: store, node: node)
                XCTAssertEqual(state.generation, generation)
            }
            XCTAssertEqual(accepted, 6); XCTAssertEqual(acquisitionResets, 0)
            // An actual capture gap still forces consensus reacquisition.
            let capture = start.addingTimeInterval(4)
            progress.receive(estimates: references, worldFromCamera: matrix_identity_float4x4,
                at: capture, now: capture.addingTimeInterval(0.1), horizontal: 0.3, vertical: 0.1, heading: 3)
            XCTAssertNotEqual(progress.fresh(at: capture.addingTimeInterval(0.1))?.status, .reliable)
        }
    }
    func testHardBoundaryStillRejectsNewerInFlightCapture() {
        MainActor.assumeIsolated {
            let t = Date(timeIntervalSince1970: 1_800_000_000)
            for reason in [CameraEvidenceLifecycle.Invalidation.stopped, .contextChanged, .trackingLost] {
                var (state, store, root, node) = Self.localSeed()
                let generation = state.generation
                var resets = 0
                state.invalidate(reason, at: t.addingTimeInterval(0.3), visual: store) { resets += 1 }
                XCTAssertEqual(resets, 1)
                XCTAssertFalse(Self.localPublish(&state, at: t.addingTimeInterval(0.2), now: t.addingTimeInterval(0.4),
                    store: store, root: root, node: SCNNode(), generation: generation))
                Self.assertLocalCleared(state, store: store, node: node)
            }
        }
    }
    func testLocalProofDeadlineBoundsNodeMapAndReplacementTimer() throws {
        try MainActor.assumeIsolated {
            let t = Date(timeIntervalSince1970: 1_800_000_000)
            var state = LocalCameraEvidenceLifecycle()
            let store = VisualLocationStore(), root = SCNNode(), node = SCNNode()
            state.start(session: UUID(), at: t, visual: store, resetAlignment: {})
            let deadline = t.addingTimeInterval(0.21)
            XCTAssertTrue(state.publish(pose: matrix_identity_float4x4,
                location: VisualLocation(coordinate: .init(latitude:46.9,longitude:7.4), capturedAt:t, maximumAge:0.5),
                area:("A",node), root:root, session:state.session, generation:state.generation,
                capturedAt:t, now:t.addingTimeInterval(0.2), validUntil:deadline, visual:store, resetAlignment:{}))
            let ticket = try XCTUnwrap(state.ticket)
            XCTAssertEqual(ticket.expiresAt, deadline)
            XCTAssertNotNil(store.fresh(at:t.addingTimeInterval(0.2)))
            XCTAssertNil(store.fresh(at:deadline)) // map cannot depend on timer scheduling order
            XCTAssertTrue(state.expire(ticket, session:state.session, at:deadline, visual:store, resetAlignment:{}))
            Self.assertLocalCleared(state, store:store, node:node)
            // Independently valid newer synchronous evidence gets its own lease.
            let newer = SCNNode()
            XCTAssertTrue(Self.localPublish(&state, at:t.addingTimeInterval(0.3), store:store, root:root, node:newer))
            XCTAssertFalse(state.expire(ticket, session:state.session, at:t.addingTimeInterval(0.4), visual:store, resetAlignment:{}))
            XCTAssertTrue(newer.parent === root); XCTAssertNotNil(store.observation)
        }
    }
    func testExpiredProofCannotPublishAndSameCaptureCannotSwitchArea() {
        MainActor.assumeIsolated {
            let t = Date(timeIntervalSince1970: 1_800_000_000)
            for expiry in [t, t.addingTimeInterval(-0.1)] {
                var (state, store, root, node) = Self.localSeed()
                XCTAssertFalse(state.publish(pose:matrix_identity_float4x4,
                    location:VisualLocation(coordinate:.init(latitude:46.9,longitude:7.4),capturedAt:t,maximumAge:0.5),
                    area:("A",SCNNode()),root:root,session:state.session,generation:state.generation,
                    capturedAt:t,now:t,validUntil:expiry,visual:store,resetAlignment:{}))
                Self.assertLocalCleared(state,store:store,node:node)
            }
            var (state, store, root, node) = Self.localSeed()
            XCTAssertFalse(state.publish(pose:matrix_identity_float4x4,
                location:VisualLocation(coordinate:.init(latitude:46.9,longitude:7.4),capturedAt:t,maximumAge:0.5),
                area:("Boarding area A",SCNNode()),root:root,session:state.session,generation:state.generation,
                capturedAt:t,now:t.addingTimeInterval(0.1),areaIdentity:"different-area-same-label",visual:store,resetAlignment:{}))
            Self.assertLocalCleared(state,store:store,node:node)
        }
    }
}
