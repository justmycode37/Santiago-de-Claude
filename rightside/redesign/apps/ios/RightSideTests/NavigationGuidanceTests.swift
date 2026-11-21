import XCTest
import MapKit
@testable import RightSide

private struct RecoveryFailureTransport: TransitTransport {
    func places(_ query: String) async throws -> JSONValue { throw NativeCoreError.message("Offline fixture") }
    func connections(origin: Place, destination: Place, departure: Date, arriveBy: Bool) async throws -> JSONValue { throw NativeCoreError.message("Offline fixture") }
}

@MainActor private final class DelayedReminderCenter: JourneyNotificationCenter {
    var authorization: CheckedContinuation<Bool, Error>?
    var delayAuthorization = false
    var delayReconciliation = false
    var reconciliation: CheckedContinuation<[String], Never>?
    func pendingIdentifiers() async -> [String] {
        if delayReconciliation { return await withCheckedContinuation { reconciliation = $0 } }
        return Array(pending.keys)
    }
    var requests: [(String, JourneyReminderPlan, CheckedContinuation<Void, Error>)] = []
    var pending: [String: JourneyReminderPlan] = [:]
    func authorize() async throws -> Bool {
        if delayAuthorization { return try await withCheckedThrowingContinuation { authorization = $0 } }
        return true
    }
    func add(_ plan: JourneyReminderPlan, identifier: String) async throws {
        try await withCheckedThrowingContinuation { requests.append((identifier, plan, $0)) }
        pending[identifier] = plan
    }
    func remove(_ identifiers: [String]) { for id in identifiers { pending.removeValue(forKey: id) } }
    func waitForRequests(_ count: Int) async throws {
        let end = ContinuousClock.now.advanced(by: .seconds(10))
        while requests.count < count {
            guard ContinuousClock.now < end else { throw NativeCoreError.message("Missing delayed notification request") }
            await Task.yield()
        }
    }
}

final class NavigationGuidanceTests: XCTestCase {
    private let instant = Date(timeIntervalSince1970: 1_800_000_000)
    private func leg(id: String, start: Double = 600, end: Double = 1200, expectedStart: Double? = nil, expectedEnd: Double? = nil, age: Double = 0) -> Leg {
        let stamp = WireClock.string(instant.addingTimeInterval(-age))
        let evidence: JSONValue = .array([.object(["source": .string("test"), "kind": .string("predicted"), "quality": .string("supported"), "fetchedAt": .string(stamp)])])
        let calls: JSONValue = .array([.object(["id": .string(id + "-board"), "place": .object(["name": .string("Boarding stop")]), "status": .string("scheduled"), "pickup": .string("allowed"), "evidence": evidence]), .object(["id": .string(id + "-alight"), "place": .object(["name": .string("Next stop")]), "status": .string("scheduled"), "evidence": evidence])])
        return Leg(raw: .object(["id": .string(id), "kind": .string("ride"), "boardingCallId": .string(id + "-board"), "alightingCallId": .string(id + "-alight"), "calls": calls,
            "plannedStart": .string(WireClock.string(instant.addingTimeInterval(start))), "plannedEnd": .string(WireClock.string(instant.addingTimeInterval(end))),
            "expectedStart": expectedStart.map { .string(WireClock.string(instant.addingTimeInterval($0))) } ?? .null,
            "expectedEnd": expectedEnd.map { .string(WireClock.string(instant.addingTimeInterval($0))) } ?? .null, "evidence": evidence]))
    }
    func testTransferSubtractsWalkOnceAndNeverDefaultsUnknownToFeasible() {
        let inbound = leg(id: "in", end: 1200), outbound = leg(id: "out", start: 1800)
        let available = TransferAssessment.assess(incoming: inbound, outgoing: outbound, walkingSeconds: 300, offline: false, now: instant)
        XCTAssertEqual(available.availableSeconds, 600); XCTAssertEqual(available.spareSeconds, 300); XCTAssertEqual(available.status, .available)
        XCTAssertEqual(TransferAssessment.assess(incoming: inbound, outgoing: outbound, walkingSeconds: nil, offline: false, now: instant).status, .unknown)
        XCTAssertEqual(TransferAssessment.assess(incoming: inbound, outgoing: outbound, walkingSeconds: 550, offline: false, now: instant).status, .tight)
        XCTAssertEqual(TransferAssessment.assess(incoming: inbound, outgoing: outbound, walkingSeconds: 700, offline: false, now: instant).status, .insufficient)
    }
    func testPredictionFreshnessIsIndependentForEachTransferSide() {
        for badAge in [120.0, -10.0] {
            let inbound = leg(id: "in", end: 1200, expectedEnd: 1500)
            let staleOutbound = leg(id: "out", start: 1800, expectedStart: 3000, age: badAge)
            let a = TransferAssessment.assess(incoming: inbound, outgoing: staleOutbound, walkingSeconds: 400, offline: false, now: instant)
            XCTAssertEqual(a.availableSeconds, 300); XCTAssertEqual(a.status, .insufficient); XCTAssertTrue(a.explanation.contains("Mixed basis"))
            let staleInbound = leg(id: "in", end: 1200, expectedEnd: 1700, age: badAge)
            let outbound = leg(id: "out", start: 1800, expectedStart: 2100)
            XCTAssertEqual(TransferAssessment.assess(incoming: staleInbound, outgoing: outbound, walkingSeconds: 400, offline: false, now: instant).availableSeconds, 900)
        }
    }
    func testOfflineAndMalformedPredictionUseTimetable() {
        let inbound = leg(id: "in", end: 1200, expectedEnd: 1500), outbound = leg(id: "out", start: 1800, expectedStart: 2100)
        let offline = TransferAssessment.assess(incoming: inbound, outgoing: outbound, walkingSeconds: 100, offline: true, now: instant)
        XCTAssertFalse(offline.usesPrediction); XCTAssertEqual(offline.availableSeconds, 600)
        var bad = outbound.raw; bad["evidence"] = .array([.object(["kind": .string("predicted"), "fetchedAt": .string("bad")])])
        XCTAssertEqual(TransferAssessment.assess(incoming: inbound, outgoing: Leg(raw: bad), walkingSeconds: 100, offline: false, now: instant).availableSeconds, 300)
    }
    func testEndpointPredictionUsesOwnDatedEvidenceAndExpiresOffline() {
        var raw = leg(id: "updated", start: 600, age: 600).raw
        var calls = raw["calls"].array
        let expected = WireClock.string(instant.addingTimeInterval(900))
        calls[0]["expectedDeparture"] = .string(expected)
        calls[0]["evidence"] = .array([.object(["kind": .string("predicted"), "fetchedAt": .string(WireClock.string(instant)), "validUntil": .string(WireClock.string(instant.addingTimeInterval(30)))])])
        raw["calls"] = .array(calls)
        XCTAssertEqual(ServiceTimeAssessment.forLeg(Leg(raw: raw), offline: false, now: instant).instant, expected)
        XCTAssertEqual(ServiceTimeAssessment.forLeg(Leg(raw: raw), offline: false, now: instant.addingTimeInterval(31)).basis, .timetable)
        XCTAssertEqual(ServiceTimeAssessment.forLeg(Leg(raw: raw), offline: true, now: instant).basis, .timetable)
    }
    func testSnapshotMissingOrFutureEvidenceNeverFreshensOnRender() {
        var journey: JSONValue = .object(["evidence": .array([.object(["fetchedAt": .string(WireClock.string(instant))])])])
        XCTAssertTrue(SourceSnapshotAge(Journey(raw: journey), offline: false, now: instant).freshPrediction)
        journey["evidence"] = .array(journey["evidence"].array + [.object([:])])
        XCTAssertFalse(SourceSnapshotAge(Journey(raw: journey), offline: false, now: instant).freshPrediction)
        journey["evidence"] = .array([.object(["fetchedAt": .string(WireClock.string(instant.addingTimeInterval(5)))])])
        XCTAssertFalse(SourceSnapshotAge(Journey(raw: journey), offline: false, now: instant).freshPrediction)
    }
    func testCancelledAndForbiddenBoardingInvalidateTransfer() {
        var outgoing = leg(id: "out", start: 1800).raw
        var calls = outgoing["calls"].array; calls[0]["pickup"] = .string("forbidden"); outgoing["calls"] = .array(calls)
        XCTAssertTrue(BoardingSummary(Leg(raw: outgoing)).unavailable)
        XCTAssertEqual(TransferAssessment.assess(incoming: leg(id: "in"), outgoing: Leg(raw: outgoing), walkingSeconds: 0, offline: false, now: instant).status, .unavailable)
    }
    func testTransferUsesIntendedAlightingOccurrenceNotLastCall() {
        let outbound = leg(id: "out", start: 1800)
        for restriction in ["cancelled", "skipped", "forbidden"] {
            var inbound = leg(id: "in").raw
            var calls = inbound["calls"].array
            var later = calls[1]; later["id"] = .string("later-call")
            if restriction == "forbidden" { calls[1]["dropoff"] = .string(restriction) }
            else { calls[1]["status"] = .string(restriction) }
            calls.append(later); inbound["calls"] = .array(calls)
            XCTAssertEqual(TransferAssessment.assess(incoming: Leg(raw: inbound), outgoing: outbound, walkingSeconds: 100, offline: false, now: instant).status, .unavailable)
        }
        var inbound = leg(id: "in").raw
        var calls = inbound["calls"].array, later = calls[1]
        later["id"] = .string("later-call"); later["status"] = .string("cancelled")
        calls.append(later); inbound["calls"] = .array(calls)
        XCTAssertEqual(TransferAssessment.assess(incoming: Leg(raw: inbound), outgoing: outbound, walkingSeconds: 100, offline: false, now: instant).status, .available)
    }
    func testBoardingSummaryRetainsChangedSignAndUnknownLevel() {
        var raw = leg(id: "ride").raw
        raw["boardingTarget"] = .object(["assignment": .object(["label": .string("K")]), "pedestrianTargetStatus": .string("unavailable"), "level": .null])
        var calls = raw["calls"].array; calls[0]["plannedAssignment"] = .object(["label": .string("H")]); raw["calls"] = .array(calls)
        let summary = BoardingSummary(Leg(raw: raw))
        XCTAssertEqual(summary.sign, "K"); XCTAssertEqual(summary.plannedSign, "H"); XCTAssertTrue(summary.changed)
        XCTAssertNil(summary.level); XCTAssertEqual(summary.nextStop, "Next stop"); XCTAssertTrue(summary.precision.contains("unverified"))
    }
    private var points: [CLLocationCoordinate2D] { [CLLocationCoordinate2D(latitude: 46.95, longitude: 7.44), CLLocationCoordinate2D(latitude: 46.951, longitude: 7.44)] }
    private func fix(longitude: Double = 7.44, accuracy: Double = 5, age: Double = 0) -> CLLocation {
        CLLocation(coordinate: CLLocationCoordinate2D(latitude: 46.9503, longitude: longitude), altitude: 0, horizontalAccuracy: accuracy, verticalAccuracy: -1, timestamp: instant.addingTimeInterval(-age))
    }
    func testWalkingGeometryRejectsStaleCoarseParallelPathsAndFindsDeviation() {
        let steps = [WalkingStep(id: 0, instruction: "Continue", distance: 111, endDistance: 111)]
        let good = WalkingAssessment.assess(points: points, steps: steps, fix: fix(), now: instant)
        XCTAssertEqual(good.status, .nearRoute); XCTAssertEqual(good.stepIndex, 0); XCTAssertGreaterThan(good.remainingMeters ?? 0, 60)
        XCTAssertEqual(WalkingAssessment.assess(points: points, steps: steps, fix: fix(age: 11), now: instant).status, .unavailable)
        XCTAssertEqual(WalkingAssessment.assess(points: points, steps: steps, fix: fix(age: -2), now: instant).status, .unavailable)
        XCTAssertEqual(WalkingAssessment.assess(points: points, steps: steps, fix: fix(accuracy: 80), now: instant).status, .uncertain)
        XCTAssertEqual(WalkingAssessment.assess(points: points, steps: steps, fix: fix(longitude: 7.442), now: instant).status, .offRoute)
        let loop = points + [CLLocationCoordinate2D(latitude: 46.951, longitude: 7.44001), CLLocationCoordinate2D(latitude: 46.95, longitude: 7.44001)]
        XCTAssertEqual(WalkingAssessment.assess(points: loop, steps: steps, fix: fix(), now: instant).status, .uncertain)
    }
    @MainActor func testSavedWalkRetainsAgeOfflineAndRefusesDifferentLegOrOldRoute() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let place: JSONValue = .object(["coordinate": .array([.number(7.44), .number(46.95)])])
        let walk = Leg(raw: .object(["id": .string("walk"), "kind": .string("walk"), "from": place, "to": place]))
        let stamp = Date().addingTimeInterval(-300)
        let saved = WalkingRouteSnapshot(leg: walk, coordinates: points.map { [$0.longitude, $0.latitude] }, steps: [WalkingStep(id: 0, instruction: "Use the mapped path", distance: 111, endDistance: 111)], distance: 111, expectedSeconds: 90, fetchedAt: stamp)
        try JSONEncoder().encode(saved).write(to: url)
        let controller = WalkingRouteController(cacheURL: url)
        await controller.load(walk, simulated: false, offline: true)
        XCTAssertEqual(controller.snapshot?.fetchedAt, stamp); XCTAssertTrue(controller.usingSavedRoute); XCTAssertNotNil(controller.polyline)
        var changed = walk.raw; changed["id"] = .string("another")
        await controller.load(Leg(raw: changed), simulated: false, offline: true)
        XCTAssertNil(controller.snapshot)
        XCTAssertFalse(saved.usable(for: walk, now: stamp.addingTimeInterval(86_401)))
    }
    @MainActor private func liveStore() throws -> (JourneyStore, URL) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".json")
        let store = JourneyStore(cacheURL: url, transport: RecoveryFailureTransport())
        store.loadDemo(); var raw = try XCTUnwrap(store.selected).raw; raw["id"] = .string("live-test")
        store.start(Journey(raw: raw)); XCTAssertNil(store.error)
        return (store, url)
    }
    @MainActor private func cleanup(_ url: URL) { try? FileManager.default.removeItem(at: url); try? FileManager.default.removeItem(at: url.appendingPathExtension("planning.json")) }
    @MainActor func testEditableReturnDraftSurvivesFailureAndRestartWithoutReplacingArrival() async throws {
        let (store, url) = try liveStore(); defer { cleanup(url) }
        for action in ["arrived", "at_waiting_area", "boarded", "alighted", "arrived", "at_waiting_area", "boarded", "alighted", "arrived"] { store.confirm(action) }
        let before = try XCTUnwrap(store.navigation).raw
        store.prepareReturn(); XCTAssertTrue(store.navigation?.raw == before)
        let edited = Date().addingTimeInterval(3600)
        store.planningDraft?.departure = edited; store.planningDraft?.arriveBy = true
        store.planningDraft?.origin = store.navigation!.journey.origin
        let draft = store.planningDraft
        await store.searchPlanningDraft()
        XCTAssertNotNil(store.error); XCTAssertTrue(store.navigation?.raw == before); XCTAssertEqual(store.planningDraft, draft)
        let restored = JourneyStore(cacheURL: url, transport: RecoveryFailureTransport()); restored.restore()
        XCTAssertEqual(restored.planningDraft, draft); XCTAssertEqual(restored.navigation?.phase, "arrived"); XCTAssertTrue(restored.navigation!.overlays.offline)
        XCTAssertEqual(restored.navigation?.journey.raw, before["journey"])
    }
    @MainActor func testAllRecoveryReasonsPreserveConfirmedPassengerStateAndSavedJourney() async throws {
        for reason in JourneyRecoveryReason.allCases {
            let (store, url) = try liveStore(); defer { cleanup(url) }
            store.confirm("arrived"); store.confirm("at_waiting_area"); store.confirm("boarded")
            let before = try XCTUnwrap(store.navigation).raw
            store.prepareRecovery(reason)
            await store.searchPlanningDraft()
            XCTAssertTrue(store.navigation?.raw == before, reason.rawValue)
            XCTAssertEqual(store.planningDraft?.reason, reason); XCTAssertEqual(store.navigation?.phase, "riding")
            store.resume(); XCTAssertEqual(store.navigation?.phase, "riding")
            store.start(try XCTUnwrap(store.selected)); XCTAssertNil(store.planningDraft)
        }
    }
    @MainActor func testTimeAndLocationNeverAutomaticallyBoardOrAlight() throws {
        let bridge = try DomainBridge(), fixture = try bridge.fixture()
        var state = try bridge.call("create", .object(["journey": fixture["journey"], "now": fixture["clockStart"]]))
        let late = WireClock.string(Date().addingTimeInterval(86_400 * 7))
        state = try bridge.call("tick", .object(["state": state, "now": .string(late)]))
        XCTAssertEqual(state["legIndex"].double, 0); XCTAssertEqual(state["phase"].string, "walking")
        let payload = try XCTUnwrap(SensorPositionPayload(longitude: 7.4499, latitude: 46.9415, accuracy: 2, timestamp: WireClock.date(late)!, receivedAt: WireClock.date(late)!, floor: nil))
        state = try bridge.call("location", .object(["state": state, "now": .string(late), "position": try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(payload))]))
        XCTAssertEqual(state["legIndex"].double, 0); XCTAssertEqual(state["phase"].string, "walking")
    }
    @MainActor func testAssignmentChangeInvalidatesWaitingConfirmation() throws {
        let bridge = try DomainBridge(), fixture = try bridge.fixture()
        var state = try bridge.call("create", .object(["journey": fixture["journey"], "now": fixture["clockStart"]]))
        for action in ["arrived", "at_waiting_area"] { state = try bridge.call("confirm", .object(["state": state, "now": state["now"], "action": .string(action)])) }
        let ride = NavigationSnapshot(raw: state).currentLeg
        var target = ride.raw["boardingTarget"]; target["assignment"]["label"] = .string("Changed K")
        let event: JSONValue = .object(["schemaVersion": .number(1), "id": .string("test-reassignment"), "sequence": .number((state["lastSequence"].double ?? 0) + 1), "at": state["now"], "journeyId": state["journey"]["id"], "legId": .string(ride.id), "type": .string("target_changed"), "data": .object(["target": target, "revision": .number(99), "reason": .string("Test reassignment")]), "evidence": fixture["journey"]["evidence"]])
        state = try bridge.call("reduce", .object(["state": state, "event": event]))
        XCTAssertEqual(state["confirmations"]["waitingTargetId"], .null); XCTAssertEqual(state["phase"].string, "approaching")
        XCTAssertEqual(state["journey"]["revision"].double, 99)
    }
    private func reminderNavigation(start: TimeInterval, name: String) -> NavigationSnapshot {
        var raw = leg(id: name).raw
        raw["plannedStart"] = .string(WireClock.string(Date().addingTimeInterval(start)))
        raw["line"] = .string(name); raw["headsign"] = .string("Physical destination")
        return NavigationSnapshot(raw: .object(["phase": .string("waiting"), "legIndex": .number(0), "journey": .object(["legs": .array([raw])]), "overlays": .object([:])]))
    }
    @MainActor func testDelayedOlderReminderCannotReplaceOrDeleteNewerOne() async throws {
        let center = DelayedReminderCenter(), reminders = JourneyReminders(center: center), session = UUID()
        let first = Task { await reminders.setEnabled(true, navigation: reminderNavigation(start: 600, name: "A"), session: session) }
        try await center.waitForRequests(1)
        let second = Task { await reminders.update(navigation: reminderNavigation(start: 1200, name: "B"), session: session) }
        try await center.waitForRequests(2)
        center.requests[1].2.resume(); await second.value
        center.requests[0].2.resume(); await first.value
        XCTAssertEqual(center.pending.count, 1); XCTAssertTrue(reminders.scheduled?.title.contains("B") == true)
        XCTAssertTrue(center.pending.values.first?.title.contains("B") == true)
    }
    @MainActor func testDisableDuringReminderAddCleansOnlyItsOwnRequest() async throws {
        let center = DelayedReminderCenter(), reminders = JourneyReminders(center: center), session = UUID()
        let pending = Task { await reminders.setEnabled(true, navigation: reminderNavigation(start: 600, name: "A"), session: session) }
        try await center.waitForRequests(1)
        await reminders.setEnabled(false, navigation: nil, session: session)
        center.requests[0].2.resume(); await pending.value
        XCTAssertTrue(center.pending.isEmpty); XCTAssertNil(reminders.scheduled); XCTAssertFalse(reminders.enabled)
    }
    @MainActor func testLatePermissionFailureDoesNotOverwriteDisabledStatus() async throws {
        let center = DelayedReminderCenter(); center.delayAuthorization = true
        let reminders = JourneyReminders(center: center), session = UUID()
        let pending = Task { await reminders.setEnabled(true, navigation: nil, session: session) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while center.authorization == nil { guard ContinuousClock.now < deadline else { XCTFail("Missing permission request"); return }; await Task.yield() }
        await reminders.setEnabled(false, navigation: nil, session: session)
        center.authorization?.resume(throwing: NativeCoreError.message("Late permission failure")); await pending.value
        XCTAssertNil(reminders.status); XCTAssertFalse(reminders.enabled)
    }
    @MainActor func testStartupRemovesPriorProcessOwnedAlertsBeforeNewAddsOnly() async throws {
        let center = DelayedReminderCenter(); center.delayReconciliation = true
        let plan = try XCTUnwrap(JourneyReminderPlan.make(navigation: reminderNavigation(start: 600, name: "old"), session: UUID(), now: Date()))
        center.pending = ["rightside.journey-reminder": plan, "rightside.journey-reminder.previous-process": plan, "unrelated-notification": plan]
        let reminders = JourneyReminders(center: center)
        let enable = Task { await reminders.setEnabled(true, navigation: reminderNavigation(start: 1200, name: "new"), session: UUID()) }
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while center.reconciliation == nil { guard ContinuousClock.now < deadline else { XCTFail("Missing startup reconciliation"); return }; await Task.yield() }
        XCTAssertTrue(center.requests.isEmpty, "New adds must wait for prior-session reconciliation")
        center.reconciliation?.resume(returning: Array(center.pending.keys))
        try await center.waitForRequests(1)
        center.requests[0].2.resume(); await enable.value
        XCTAssertEqual(center.pending.count, 2)
        XCTAssertNotNil(center.pending["unrelated-notification"])
        XCTAssertNil(center.pending["rightside.journey-reminder"])
        XCTAssertNil(center.pending["rightside.journey-reminder.previous-process"])
        XCTAssertTrue(reminders.scheduled?.title.contains("new") == true)
        reminders.cancel()
        XCTAssertEqual(Array(center.pending.keys), ["unrelated-notification"])
    }
    func testReminderIsExplicitlyScheduledAndNotAClaimOfLocation() throws {
        let nav = reminderNavigation(start: 600, name: "A")
        let plan = try XCTUnwrap(JourneyReminderPlan.make(navigation: nav, session: UUID(), now: Date()))
        XCTAssertTrue(plan.title.contains("Timetable")); XCTAssertTrue(plan.body.contains("Scheduled")); XCTAssertTrue(plan.body.contains("changed"))
        var arrived = nav.raw; arrived["phase"] = .string("arrived")
        XCTAssertNil(JourneyReminderPlan.make(navigation: NavigationSnapshot(raw: arrived), session: UUID(), now: Date()))
    }
}
