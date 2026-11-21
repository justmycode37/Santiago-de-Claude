import XCTest
#if canImport(RightSide)
@testable import RightSide
#endif

final class CameraBoardingTests: XCTestCase {
    let t = Date(timeIntervalSince1970: 1_800_000_000)
    func testOCRBudgetVisitsAllSixInstancesWithoutIncreasingRequests() {
        var schedule = VehicleOCRSchedule()
        let first = schedule.indices(trackCount: 6), second = schedule.indices(trackCount: 6)
        XCTAssertEqual(first.count, 3); XCTAssertEqual(second.count, 3)
        XCTAssertEqual(Set(first + second), Set(0..<6))
        XCTAssertEqual(schedule.indices(trackCount: 1), [0])
        XCTAssertTrue(schedule.indices(trackCount: 0).isEmpty)
        XCTAssertEqual(schedule.indices(trackCount: 6), [0, 1, 2])
    }
    func testGlyphRefinementRequiresSameMaskedRowAndRejectsPlateZone() {
        let detection = VehicleDetection(kind: .bus, box: CGRect(x: 0.1, y: 0.1, width: 0.8, height: 0.8), score: 0.9,
            mask: VehicleMask(width: 1, height: 1, pixels: [1]))
        let route = VehicleText(text: "12", box: CGRect(x: 0.2, y: 0.2, width: 0.05, height: 0.05), score: 0.5)
        let headsign = VehicleText(text: "Bern Bahnhof", box: CGRect(x: 0.28, y: 0.2, width: 0.3, height: 0.05), score: 1)
        XCTAssertNotNil(VehicleTextRules.refinementRegion([route, headsign], detection: detection, otherBoxes: []))
        XCTAssertNil(VehicleTextRules.refinementRegion([route, headsign], detection: detection, otherBoxes: [headsign.box]))
        XCTAssertNil(VehicleTextRules.refinementRegion([route, VehicleText(text: headsign.text,
            box: headsign.box.offsetBy(dx: 0, dy: 0.1), score: 1)], detection: detection, otherBoxes: []))
        let plate = [route, headsign].map { VehicleText(text: $0.text, box: $0.box.offsetBy(dx: 0, dy: 0.5), score: $0.score) }
        XCTAssertNil(VehicleTextRules.refinementRegion(plate, detection: detection, otherBoxes: []))
        XCTAssertNil(VehicleTextRules.read(plate, detection: detection, otherBoxes: [], at: t, frameID: UUID()).line)
        let unmasked = VehicleDetection(kind: .bus, box: detection.box, score: 0.9, mask: VehicleMask(width: 1, height: 1, pixels: [0]))
        XCTAssertNil(VehicleTextRules.refinementRegion([route, headsign], detection: unmasked, otherBoxes: []))
    }
    func testRefinementNeverPromotesProposalOrForcesItsCharacters() {
        let detection = VehicleDetection(kind: .bus, box: CGRect(x: 0.1, y: 0.1, width: 0.8, height: 0.8), score: 0.9,
            mask: VehicleMask(width: 1, height: 1, pixels: [1]))
        let box = CGRect(x: 0.2, y: 0.2, width: 0.05, height: 0.05)
        let initial = [VehicleText(text: "12", box: box, score: 0.5),
                       VehicleText(text: "Bern Bahnhof", box: CGRect(x: 0.28, y: 0.2, width: 0.3, height: 0.05), score: 1)]
        XCTAssertNil(VehicleTextRules.read(initial, detection: detection, otherBoxes: [], at: t, frameID: UUID()).line)
        XCTAssertNil(VehicleTextRules.read(initial + [.init(text: "12", box: box, score: 0.69)],
            detection: detection, otherBoxes: [], at: t, frameID: UUID()).line)
        let different = VehicleTextRules.read(initial + [.init(text: "7", box: box, score: 1)],
            detection: detection, otherBoxes: [], at: t, frameID: UUID())
        XCTAssertEqual(different.line, "7"); XCTAssertEqual(different.destination, "bern bahnhof")
        let conflicting = VehicleTextRules.read(initial + [.init(text: "7", box: box, score: 1), .init(text: "12", box: box, score: 1)],
            detection: detection, otherBoxes: [], at: t, frameID: UUID())
        XCTAssertTrue(conflicting.ambiguous)
    }
    private func expectation() -> VehicleServiceExpectation {
        VehicleServiceExpectation(line: "6", destination: "Fischermätteli", tripID: "trip", boardingStopID: "board",
            alightingStopID: "alight", directionID: "out", validUntil: t.addingTimeInterval(30), requiresRouteContext: true,
            revision: 2, observedAt: t, tripOccurrenceKey: "provider:trip:2026-11-21", boardingCallID: "board-call", alightingCallID: "alight-call",
            downstreamCalls: [.init(id: "mid-call", stopID: "mid", name: "Bahnhof"), .init(id: "alight-call", stopID: "alight", name: "Kocherpark")])
    }
    private func track(_ destination: String = "fischermatteli") -> VehicleTrack {
        let mask = VehicleMask(width: 1, height: 1, pixels: [1])
        return VehicleTrack(id: UUID(), detection: VehicleDetection(kind: .tram, box: CGRect(x: 0.1, y: 0.1, width: 0.8, height: 0.8), score: 0.95, mask: mask),
            lastSeen: t.addingTimeInterval(1), readings: [0.0, 0.5, 1.0].map {
                DisplayReading(frameID: UUID(), at: t.addingTimeInterval($0), line: "6", destination: destination,
                    outOfService: false, ambiguous: false, raw: ["6 " + destination])
            })
    }
    func testStrictFreshContextStillOnlyMakesVisualCandidate() {
        XCTAssertEqual(VehicleServiceMatcher.decide(track(), expected: expectation(), now: t.addingTimeInterval(1)).state, .visualCandidate)
    }
    func testStaleFutureMissingAndExpiredContextNeverMakesCandidate() {
        for (observed, expiry) in [(t.addingTimeInterval(-91), t.addingTimeInterval(30)), (t.addingTimeInterval(5), t.addingTimeInterval(30)), (t, t)] {
            var expected = expectation(); expected.observedAt = observed; expected.validUntil = expiry
            let result = VehicleServiceMatcher.decide(track(), expected: expected, now: t.addingTimeInterval(1))
            XCTAssertEqual(result.state, .unknown); XCTAssertEqual(result.reason, "route_context_stale")
        }
        var missing = expectation(); missing.observedAt = nil
        XCTAssertEqual(VehicleServiceMatcher.decide(track(), expected: missing, now: t.addingTimeInterval(1)).state, .unknown)
    }
    func testMissingDownstreamOrRepeatedAlightingAbstains() {
        var expected = expectation(); expected.downstreamCalls.removeLast()
        XCTAssertEqual(VehicleServiceMatcher.decide(track(), expected: expected, now: t.addingTimeInterval(1)).reason, "route_calls_incomplete")
        expected = expectation(); expected.downstreamCalls.append(.init(id: "later-call", stopID: "alight", name: "Kocherpark"))
        XCTAssertEqual(VehicleServiceMatcher.decide(track(), expected: expected, now: t.addingTimeInterval(1)).reason, "ambiguous_alighting_call")
    }
    func testDisplayedShortTurnBeforeRequestedStopHasSpecificWarning() {
        let result = VehicleServiceMatcher.decide(track("bahnhof"), expected: expectation(), now: t.addingTimeInterval(1))
        XCTAssertEqual(result.state, .conflicting)
        XCTAssertEqual(result.reason, "display_short_turn_before_alighting")
    }
    func testCancelledOrForbiddenSelectedDepartureOverridesMatchingDisplay() {
        var expected = expectation(); expected.boardingUnavailable = true
        XCTAssertEqual(VehicleServiceMatcher.decide(track(), expected: expected, now: t.addingTimeInterval(1)).reason, "selected_boarding_unavailable")
    }
    func testStrictVerifiedBindingNeedsExactOccurrenceAndCalls() {
        let vehicle = track(), expected = expectation()
        var binding = AuthoritativeVehicleBinding(trackID: vehicle.id, observedAt: t, validUntil: t.addingTimeInterval(30),
            tripID: "trip", boardingStopID: "board", directionID: "out", line: "6", destination: "Fischermätteli",
            downstreamStopIDs: ["alight"], cancelled: false, pickupAllowed: true, associationVerified: true)
        XCTAssertEqual(VehicleServiceMatcher.decide(vehicle, expected: expected, now: vehicle.lastSeen, binding: binding).state, .conflicting)
        binding.tripOccurrenceKey = expected.tripOccurrenceKey; binding.boardingCallID = expected.boardingCallID
        binding.downstreamCallIDs = ["alight-call"]
        XCTAssertEqual(VehicleServiceMatcher.decide(vehicle, expected: expected, now: vehicle.lastSeen, binding: binding).state, .verifiedService)
        binding.tripOccurrenceKey = "provider:trip:wrong-operating-day"
        XCTAssertEqual(VehicleServiceMatcher.decide(vehicle, expected: expected, now: vehicle.lastSeen, binding: binding).state, .conflicting)
    }
    func testChangedRevisionCallOrFreshnessInvalidatesCameraContext() {
        let base = CameraJourneyContext(id: "leg", title: "Journey", line: "6", destination: "Fischermätteli", stop: "Bern",
            target: nil, targetLabel: "Bern", simulated: false, serviceExpectation: expectation())
        for expected in [{ () -> VehicleServiceExpectation in var e = expectation(); e.revision = 3; return e }(),
                         { () -> VehicleServiceExpectation in var e = expectation(); e.alightingCallID = "other"; return e }(),
                         { () -> VehicleServiceExpectation in var e = expectation(); e.validUntil = t; return e }()] {
            var changed = base; changed.serviceExpectation = expected
            XCTAssertTrue(CameraEvidenceLifecycle.contextChanged(base, changed))
        }
    }
    func testFactoryPreservesProviderEvidenceWithoutMakingTripOrDirectionIDs() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "bern-demo", withExtension: "json"))
        let fixture = try JSONValue(json: String(contentsOf: url, encoding: .utf8))
        let journey = Journey(raw: fixture["journey"])
        let leg = try XCTUnwrap(journey.legs.first { $0.kind == "ride" })
        let a = try XCTUnwrap(CameraBoardingContext.expectation(journey: journey, ride: leg))
        let b = try XCTUnwrap(CameraBoardingContext.expectation(journey: journey, ride: leg))
        XCTAssertEqual(a, b)
        XCTAssertEqual(a.revision, journey.revision)
        XCTAssertEqual(a.boardingCallID, leg.raw["boardingCallId"].string)
        XCTAssertEqual(a.alightingCallID, leg.raw["alightingCallId"].string)
        XCTAssertEqual(a.observedAt, leg.raw["evidence"].array.first?["fetchedAt"].string.flatMap(WireClock.date))
        XCTAssertEqual(a.validUntil, a.observedAt?.addingTimeInterval(90))
        XCTAssertTrue(a.requiresRouteContext)
        var unknown = leg.raw; unknown["trip"]["sourceTripId"] = .null; unknown["trip"]["sjyid"] = .null
        let unbound = try XCTUnwrap(CameraBoardingContext.expectation(journey: journey, ride: Leg(raw: unknown)))
        XCTAssertNil(unbound.tripID); XCTAssertNil(unbound.directionID)
        unknown["evidence"] = .array([.object(["fetchedAt": .string("invalid")])])
        XCTAssertNil(CameraBoardingContext.expectation(journey: journey, ride: Leg(raw: unknown))?.observedAt)
    }
    func testObservedBadgeNeverCopiesExpectedWords() {
        let vehicle = track("worb dorf")
        let reading = vehicle.readings.last!
        let decision = VehicleServiceMatcher.decide(vehicle, expected: expectation(), now: vehicle.lastSeen)
        let overlay = CameraVehicleOverlay(id: vehicle.id, box: vehicle.detection.box, maskRuns: [], title: "Tram", decision: decision,
            displayText: reading.displayText, capturedAt: reading.at)
        XCTAssertEqual(overlay.displayText, "6 worb dorf")
        XCTAssertFalse(overlay.displayText!.contains("Fischermätteli"))
        XCTAssertEqual(overlay.badge, "Different line or destination")
        XCTAssertEqual(overlay.symbol, "xmark.octagon.fill")
    }
    func testHeldOutExplicitMalformedOrContradictoryExpiryFailsClosed() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "bern-demo", withExtension: "json"))
        let fixture = try JSONValue(json: String(contentsOf: url, encoding: .utf8))
        let journey = Journey(raw: fixture["journey"])
        let leg = try XCTUnwrap(journey.legs.first { $0.kind == "ride" })
        let observed = try XCTUnwrap(CameraBoardingContext.expectation(journey: journey, ride: leg)?.observedAt)
        for invalid in [JSONValue.null, .string("broken-date"), .number(123), .string(WireClock.string(observed.addingTimeInterval(-1)))] {
            var raw = leg.raw
            var evidence = raw["evidence"].array
            evidence[0]["validUntil"] = invalid
            raw["evidence"] = .array(evidence)
            let expected = try XCTUnwrap(CameraBoardingContext.expectation(journey: journey, ride: Leg(raw: raw)))
            XCTAssertNil(expected.validUntil)
            XCTAssertEqual(expected.contextDecision(at: observed)?.state, .unknown)
        }
    }
    func testEachExplicitExpiryMustFollowItsOwnSourceObservation() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "bern-demo", withExtension: "json"))
        let fixture = try JSONValue(json: String(contentsOf: url, encoding: .utf8))
        let journey = Journey(raw: fixture["journey"])
        let leg = try XCTUnwrap(journey.legs.first { $0.kind == "ride" })
        var raw = leg.raw
        raw["evidence"] = .array([
            .object(["fetchedAt": .string(WireClock.string(t))]),
            .object(["fetchedAt": .string(WireClock.string(t.addingTimeInterval(10))),
                     "validUntil": .string(WireClock.string(t.addingTimeInterval(5)))])])
        let expected = try XCTUnwrap(CameraBoardingContext.expectation(journey: journey, ride: Leg(raw: raw)))
        XCTAssertNil(expected.validUntil)
        XCTAssertEqual(expected.contextDecision(at: t.addingTimeInterval(11))?.state, .unknown)
    }
    func testPositiveFeedbackCannotOutliveRouteContext() throws {
        var state = CameraEvidenceLifecycle(); state.start(at: t)
        let vehicle = track(), overlay = CameraVehicleOverlay(id: UUID(), box: .zero, maskRuns: [], title: "Bus", decision: .init(state: .visualCandidate, reason: "test"), capturedAt: t.addingTimeInterval(1))
        XCTAssertTrue(state.publish(vehicles: [overlay], matches: [], token: state.epoch, capturedAt: vehicle.lastSeen,
                                    now: vehicle.lastSeen, routeValidUntil: vehicle.lastSeen.addingTimeInterval(0.1)))
        XCTAssertEqual(try XCTUnwrap(state.expiresAt).timeIntervalSince(vehicle.lastSeen), 0.1, accuracy: 0.0001)
        XCTAssertTrue(state.expire(try XCTUnwrap(state.feedbackID), at: vehicle.lastSeen.addingTimeInterval(0.1)))
        XCTAssertNil(state.candidateID)
    }
    private func freshFactoryInput() throws -> (Journey, JSONValue) {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "bern-demo", withExtension: "json"))
        let fixture = try JSONValue(json: String(contentsOf: url, encoding: .utf8))
        let journey = Journey(raw: fixture["journey"])
        var raw = try XCTUnwrap(journey.legs.first { $0.kind == "ride" }).raw
        let evidence = JSONValue.array([.object(["fetchedAt": .string(WireClock.string(t))])])
        raw["evidence"] = evidence
        raw["calls"] = .array(raw["calls"].array.map { call in var call = call; call["evidence"] = evidence; return call })
        return (journey, raw)
    }
    func testEveryMixedFutureContributorIsRetainedAtDecisionTime() throws {
        for explicitExpiry in [false, true] {
            for target in ["leg", "boarding", "alighting"] {
                for reverse in [false, true] {
                    let (journey, baseline) = try freshFactoryInput()
                    var raw = baseline
                    let fresh = raw["evidence"].array[0]
                    var future = fresh
                    future["fetchedAt"] = .string(WireClock.string(t.addingTimeInterval(3600)))
                    if explicitExpiry { future["validUntil"] = .string(WireClock.string(t.addingTimeInterval(3690))) }
                    let evidence = JSONValue.array(reverse ? [future, fresh] : [fresh, future])
                    if target == "leg" { raw["evidence"] = evidence }
                    else {
                        let id = raw[target == "boarding" ? "boardingCallId" : "alightingCallId"].string
                        var calls = raw["calls"].array
                        let index = try XCTUnwrap(calls.firstIndex { $0["id"].string == id })
                        calls[index]["evidence"] = evidence; raw["calls"] = .array(calls)
                    }
                    let expected = try XCTUnwrap(CameraBoardingContext.expectation(journey: journey, ride: Leg(raw: raw)))
                    XCTAssertEqual(expected.latestObservedAt, t.addingTimeInterval(3600))
                    XCTAssertEqual(expected.contextDecision(at: t.addingTimeInterval(1))?.reason, "route_context_stale")
                }
            }
        }
    }
    func testSelectedAlightingAvailabilityIsKeptButLaterCancellationDoesNotBlockIt() throws {
        let (journey, baseline) = try freshFactoryInput()
        for status in ["cancelled", "skipped"] {
            for selected in [true, false] {
                var raw = baseline, calls = raw["calls"].array
                let index = try XCTUnwrap(calls.firstIndex { $0["id"].string == raw["alightingCallId"].string })
                if selected { calls[index]["status"] = .string(status) }
                else {
                    var later = calls[index]; later["id"] = .string("later-unrelated-call")
                    later["place"]["id"] = .string("later-unrelated-stop"); later["status"] = .string(status)
                    calls.append(later)
                }
                raw["calls"] = .array(calls)
                let expected = try XCTUnwrap(CameraBoardingContext.expectation(journey: journey, ride: Leg(raw: raw)))
                if selected { XCTAssertEqual(expected.contextDecision(at: t)?.reason, "selected_alighting_unavailable") }
                else { XCTAssertNil(expected.contextDecision(at: t)) }
            }
        }
    }
    func testSelectedAlightingStaleMalformedAndExpiredEvidenceAbstains() throws {
        let (journey, baseline) = try freshFactoryInput()
        XCTAssertNil(CameraBoardingContext.expectation(journey: journey, ride: Leg(raw: baseline))?.contextDecision(at: t))
        for evidence: JSONValue in [
            .object(["fetchedAt": .string(WireClock.string(t.addingTimeInterval(-3600)))]),
            .object(["fetchedAt": .string("invalid")]),
            .object(["fetchedAt": .string(WireClock.string(t)), "validUntil": .null]),
            .object(["fetchedAt": .string(WireClock.string(t)), "validUntil": .string(WireClock.string(t))])
        ] {
            var raw = baseline, calls = raw["calls"].array
            let index = try XCTUnwrap(calls.firstIndex { $0["id"].string == raw["alightingCallId"].string })
            calls[index]["evidence"] = .array([evidence]); raw["calls"] = .array(calls)
            XCTAssertEqual(CameraBoardingContext.expectation(journey: journey, ride: Leg(raw: raw))?.contextDecision(at: t)?.state, .unknown)
        }
    }
}
