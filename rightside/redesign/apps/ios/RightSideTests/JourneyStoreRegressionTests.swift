import XCTest
@testable import RightSide

private struct StubTransit: TransitTransport {
    var fails = false
    func places(_ query: String) async throws -> JSONValue {
        throw NativeCoreError.message("Place search unavailable")
    }
    func connections(origin: Place, destination: Place, departure: Date, arriveBy: Bool) async throws -> JSONValue {
        if fails { throw NativeCoreError.message("Search unavailable") }
        return .object(["connections": .array([])])
    }
}

final class JourneyStoreRegressionTests: XCTestCase {
    @MainActor private func makeStore(transport: any TransitTransport = StubTransit()) throws -> (JourneyStore, URL) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".json")
        let store = JourneyStore(cacheURL: url, transport: transport)
        store.loadDemo(); store.start(try XCTUnwrap(store.selected))
        return (store, url)
    }
    @MainActor func testDemoToNewJourneyResetsClockOfflineAndHistory() throws {
        let (store, url) = try makeStore()
        defer { try? FileManager.default.removeItem(at: url) }
        store.confirm("arrived"); store.setOffline(true)
        var replacement = try XCTUnwrap(store.selected).raw
        replacement["id"] = .string("test:new-live-selection")
        store.select(Journey(raw: replacement)); store.start(try XCTUnwrap(store.selected))
        XCTAssertFalse(store.isDemo)
        XCTAssertFalse(try XCTUnwrap(store.navigation).overlays.offline)
        XCTAssertEqual(store.navigation?.legIndex, 0)
        XCTAssertLessThan(abs(try XCTUnwrap(WireClock.date(store.navigation?.now ?? "")).timeIntervalSinceNow), 5)
        XCTAssertTrue(store.alternatives.isEmpty)
        XCTAssertFalse(store.canStepScenario)
        XCTAssertNil(store.error)
    }
    @MainActor func testEmptySearchPreservesActiveProgressAndResumeIsExplicit() async throws {
        let (store, url) = try makeStore()
        defer { try? FileManager.default.removeItem(at: url) }
        store.confirm("arrived"); store.confirm("at_waiting_area")
        let before = store.navigation?.raw
        await store.search()
        XCTAssertFalse(store.previewing)
        XCTAssertEqual(store.navigation?.raw, before)
        XCTAssertEqual(store.selected?.id, store.navigation?.journey.id)
        XCTAssertTrue(store.alternatives.isEmpty)
        XCTAssertNil(store.error)
    }
    @MainActor func testFailedSearchClearsOldPreviewWithoutChangingGuidance() async throws {
        let (store, url) = try makeStore(transport: StubTransit(fails: true))
        defer { try? FileManager.default.removeItem(at: url) }
        store.confirm("arrived")
        let before = store.navigation?.raw
        store.loadDemo()
        XCTAssertTrue(store.previewing)
        await store.search()
        XCTAssertEqual(store.navigation?.raw, before)
        XCTAssertFalse(store.previewing)
        XCTAssertTrue(store.alternatives.isEmpty)
        XCTAssertNotNil(store.error)
        _ = await store.searchPlaces("Bern")
        XCTAssertEqual(store.error, "Search unavailable")
        XCTAssertEqual(store.placeError, "Place search unavailable")
    }
    @MainActor func testManualProgressDisablesScriptedSequenceAndReturnEnds() async throws {
        let (store, url) = try makeStore()
        defer { try? FileManager.default.removeItem(at: url) }
        let actions = ["arrived", "at_waiting_area", "boarded", "alighted", "arrived", "at_waiting_area", "boarded", "alighted", "arrived"]
        store.confirm(actions[0])
        let before = store.navigation?.raw
        XCTAssertFalse(store.canStepScenario)
        store.nextScenario()
        XCTAssertEqual(store.navigation?.raw, before)
        for action in actions.dropFirst() { store.confirm(action) }
        XCTAssertTrue(store.canReturn)
        await store.returnJourney()
        for action in actions { store.confirm(action) }
        XCTAssertEqual(store.navigation?.phase, "arrived")
        XCTAssertFalse(store.canReturn)
        XCTAssertNil(store.error)
    }
}

// Intentionally ignores cancellation so generation checks face late success AND failure.
private actor DelayedTransit: TransitTransport {
    private var requests: [Int: CheckedContinuation<JSONValue, Error>] = [:]
    private var count = 0
    func places(_ query: String) async throws -> JSONValue { .object(["stations": .array([])]) }
    func connections(origin: Place, destination: Place, departure: Date, arriveBy: Bool) async throws -> JSONValue {
        let index = count; count += 1
        return try await withCheckedThrowingContinuation { requests[index] = $0 }
    }
    func waitForRequests(_ expected: Int) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while ContinuousClock.now < deadline {
            if count >= expected { return }
            try await Task.sleep(for: .milliseconds(1))
        }
        throw NativeCoreError.message("Timed out waiting for controlled transport request")
    }
    func finish(_ index: Int, fails: Bool = false) {
        guard let continuation = requests.removeValue(forKey: index) else { return }
        if fails { continuation.resume(throwing: NativeCoreError.message("Late obsolete failure")) }
        else {
            continuation.resume(returning: try! JSONValue(json: """
            {"connections":[{"sections":[{"departure":{"station":{"id":"8507000","name":"Bern"},"departure":"2026-11-21T10:00:00Z"},"arrival":{"station":{"id":"8507001","name":"Bern test destination"},"arrival":"2026-11-21T10:10:00Z"}}]}]}
            """))
        }
    }
}

private actor DelayedPlaceTransit: TransitTransport {
    private var pending: CheckedContinuation<JSONValue, Error>?
    static var response: JSONValue {
        .object(["stations": .array([.object(["id": .string("8507000"), "name": .string("Bern"),
            "coordinate": .object(["x": .number(46.95), "y": .number(7.44)])])])])
    }
    func places(_ query: String) async throws -> JSONValue {
        try await withCheckedThrowingContinuation { pending = $0 }
    }
    func connections(origin: Place, destination: Place, departure: Date, arriveBy: Bool) async throws -> JSONValue {
        .object(["connections": .array([])])
    }
    func waitUntilRequested() async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while ContinuousClock.now < deadline {
            if pending != nil { return }
            try await Task.sleep(for: .milliseconds(1))
        }
        throw NativeCoreError.message("Place request was not started")
    }
    func finish() { pending?.resume(returning: Self.response); pending = nil }
}

extension JourneyStoreRegressionTests {
    @MainActor func testPlanningCarriesSelectedLanguageWithoutChangingSignNames() async throws {
        let preferences = JourneyLanguage.preferences
        let original = preferences.object(forKey: JourneyLanguage.preferenceKey)
        defer {
            if let original { preferences.set(original, forKey: JourneyLanguage.preferenceKey) }
            else { preferences.removeObject(forKey: JourneyLanguage.preferenceKey) }
        }
        for code in ["de", "fr"] {
            preferences.set(code, forKey: JourneyLanguage.preferenceKey)
            let transport = DelayedTransit()
            let (store, url) = try makeStore(transport: transport)
            defer { try? FileManager.default.removeItem(at: url) }
            let task = Task { await store.search() }
            try await transport.waitForRequests(1)
            await transport.finish(0)
            await task.value
            let journey = try XCTUnwrap(store.alternatives.first)
            XCTAssertEqual(journey.raw["preferences"]["language"].string, code)
            // The normalizer prepends an access walk from the requested origin.
            // Inspect the provider section, not that synthesized first leg.
            let providerSection = try XCTUnwrap(journey.legs.first { $0.to.name == "Bern test destination" })
            XCTAssertEqual(providerSection.from.name, "Bern")
            XCTAssertEqual(providerSection.to.name, "Bern test destination")
            XCTAssertEqual(journey.origin.name, store.origin?.name)
            XCTAssertEqual(journey.destination.name, store.destination?.name)
        }
    }
    @MainActor func testJourneyReplacementRejectsLatePlaceSuggestions() async throws {
        let normalized = try DomainBridge().call("normalizePlaces", .object([
            "raw": DelayedPlaceTransit.response, "fetchedAt": .string(WireClock.string())]))
        XCTAssertEqual(normalized.array.count, 1, "Held-out fixture must otherwise produce a real place")
        for restoring in [false, true] {
            let transport = DelayedPlaceTransit()
            let (store, url) = try makeStore(transport: transport)
            defer { try? FileManager.default.removeItem(at: url) }
            let pending = Task { await store.searchPlaces("Bern") }
            try await transport.waitUntilRequested()
            if restoring { store.restore() }
            else { store.start(try XCTUnwrap(store.selected)) }
            let navigation = store.navigation?.raw, origin = store.origin?.raw
            await transport.finish()
            let suggestions = await pending.value
            XCTAssertTrue(suggestions.isEmpty)
            XCTAssertTrue(store.placeResults.isEmpty)
            XCTAssertNil(store.placeError)
            XCTAssertEqual(store.navigation?.raw, navigation)
            XCTAssertEqual(store.origin?.raw, origin)
        }
    }
    @MainActor private func completeManually(_ store: JourneyStore) {
        for action in ["arrived", "at_waiting_area", "boarded", "alighted", "arrived", "at_waiting_area", "boarded", "alighted", "arrived"] { store.confirm(action) }
    }
    @MainActor private func startLive(_ store: JourneyStore, id: String = "test:live") throws {
        var journey = try XCTUnwrap(store.navigation?.journey).raw
        journey["id"] = .string(id)
        store.start(Journey(raw: journey))
        XCTAssertNil(store.error)
    }

    @MainActor func testInvalidSearchSupersedesPendingValidSearch() async throws {
        let transport = DelayedTransit()
        let (store, url) = try makeStore(transport: transport)
        defer { try? FileManager.default.removeItem(at: url) }
        let before = store.navigation?.raw
        let pending = Task { await store.search() }
        try await transport.waitForRequests(1)
        store.destination = nil
        await store.search()
        XCTAssertFalse(store.busy)
        await transport.finish(0)
        await pending.value
        XCTAssertTrue(store.navigation?.raw == before, "Navigation changed unexpectedly")
        XCTAssertFalse(store.previewing)
        XCTAssertTrue(store.alternatives.isEmpty)
        XCTAssertEqual(store.selected?.id, store.navigation?.journey.id)
        XCTAssertNotNil(store.error)
    }

    @MainActor func testDemoReturnInvalidatesPendingSearch() async throws {
        let transport = DelayedTransit()
        let (store, url) = try makeStore(transport: transport)
        defer { try? FileManager.default.removeItem(at: url) }
        completeManually(store)
        XCTAssertTrue(store.canReturn)
        let pending = Task { await store.search() }
        try await transport.waitForRequests(1)
        await store.returnJourney()
        let returned = try XCTUnwrap(store.navigation)
        XCTAssertFalse(store.busy)
        await transport.finish(0)
        await pending.value
        XCTAssertEqual(store.navigation?.raw, returned.raw)
        XCTAssertEqual(store.selected?.id, returned.journey.id)
        XCTAssertFalse(store.previewing)
        XCTAssertTrue(store.alternatives.isEmpty)
        XCTAssertEqual(store.origin?.id, returned.journey.origin.id)
        XCTAssertEqual(store.destination?.id, returned.journey.destination.id)
        XCTAssertFalse(store.canStepScenario) // Manual mode stays manual across the return.
    }

    @MainActor func testOverlappingSearchIgnoresOlderSuccessAndFailure() async throws {
        for fails in [false, true] {
            let transport = DelayedTransit()
            let (store, url) = try makeStore(transport: transport)
            defer { try? FileManager.default.removeItem(at: url) }
            let before = store.navigation?.raw
            let first = Task { await store.search() }
            try await transport.waitForRequests(1)
            let second = Task { await store.search() }
            try await transport.waitForRequests(2)
            await transport.finish(1)
            await second.value
            XCTAssertEqual(store.alternatives.count, 1)
            let selected = store.selected?.raw
            await transport.finish(0, fails: fails)
            await first.value
            XCTAssertEqual(store.selected?.raw, selected)
            XCTAssertTrue(store.navigation?.raw == before, "Navigation changed unexpectedly")
            XCTAssertTrue(store.previewing)
            XCTAssertFalse(store.busy)
            XCTAssertNil(store.error)
        }
    }

    @MainActor func testCancelledCallerCannotPublishLateSuccess() async throws {
        let transport = DelayedTransit()
        let (store, url) = try makeStore(transport: transport)
        defer { try? FileManager.default.removeItem(at: url) }
        let before = store.navigation?.raw
        let pending = Task { await store.search() }
        try await transport.waitForRequests(1)
        pending.cancel()
        await transport.finish(0)
        await pending.value
        XCTAssertTrue(store.navigation?.raw == before, "Navigation changed unexpectedly")
        XCTAssertFalse(store.busy)
        XCTAssertFalse(store.previewing)
        XCTAssertTrue(store.alternatives.isEmpty)
        XCTAssertNil(store.error)
    }

    @MainActor func testExplicitTransitionsInvalidateLateSearch() async throws {
        for transition in ["start", "restore", "resume", "loadDemo", "cancel"] {
            let transport = DelayedTransit()
            let (store, url) = try makeStore(transport: transport)
            defer { try? FileManager.default.removeItem(at: url) }
            let pending = Task { await store.search() }
            try await transport.waitForRequests(1)
            switch transition {
            case "start": try startLive(store)
            case "restore": store.restore()
            case "resume": store.resume()
            case "loadDemo": store.loadDemo()
            default: store.cancelSearch()
            }
            let before = store.navigation?.raw, selected = store.selected?.raw
            let preview = store.previewing, alternatives = store.alternatives
            await transport.finish(0)
            await pending.value
            XCTAssertEqual(store.navigation?.raw, before, transition)
            XCTAssertEqual(store.selected?.raw, selected, transition)
            XCTAssertEqual(store.previewing, preview, transition)
            XCTAssertEqual(store.alternatives, alternatives, transition)
            XCTAssertFalse(store.busy, transition)
            XCTAssertNil(store.error, transition)
        }
    }

    @MainActor func testLiveRestorePreservesSavedIdentityAndEvidenceClock() throws {
        let (store, url) = try makeStore()
        defer { try? FileManager.default.removeItem(at: url) }
        try startLive(store)
        let bridge = try DomainBridge()
        var saved = try XCTUnwrap(store.navigation).raw
        // Future saved clock exercises monotonic recovery (e.g. a wall-clock correction).
        let savedClock = WireClock.string(Date().addingTimeInterval(300))
        saved = try bridge.call("connectivity", .object(["state": saved, "online": .bool(false), "now": .string(savedClock)]))
        try JourneyCache(url: url).save(navigation: saved, replay: nil, bridge: bridge)
        let oldEvidence = saved["journey"]["evidence"], oldContext = saved["contextAt"]
        store.restore()
        XCTAssertNil(store.error)
        XCTAssertFalse(store.isDemo)
        XCTAssertTrue(try XCTUnwrap(store.navigation).overlays.offline)
        XCTAssertEqual(store.navigation?.now, savedClock)
        XCTAssertEqual(store.navigation?.journey.raw, saved["journey"])
        XCTAssertEqual(store.navigation?.raw["contextAt"], oldContext)
        XCTAssertEqual(store.navigation?.raw["journey"]["evidence"], oldEvidence)
        XCTAssertEqual(store.navigation?.legIndex, Int(saved["legIndex"].double!))
        store.start(try XCTUnwrap(store.selected))
        XCTAssertFalse(try XCTUnwrap(store.navigation).overlays.offline)
        XCTAssertLessThan(abs(try XCTUnwrap(WireClock.date(store.navigation?.now ?? "")).timeIntervalSinceNow), 5)
        XCTAssertEqual(store.navigation?.raw["history"].array.count, 1)
    }

    @MainActor func testDemoRestoreKeepsSavedOfflineClockAndManualSafety() throws {
        let (store, url) = try makeStore()
        defer { try? FileManager.default.removeItem(at: url) }
        store.nextScenario(); store.setOffline(true)
        let before = try XCTUnwrap(store.navigation).raw
        store.restore()
        XCTAssertNil(store.error)
        XCTAssertTrue(store.navigation?.raw == before, "Navigation changed unexpectedly")
        XCTAssertTrue(store.isDemo)
        XCTAssertFalse(store.canStepScenario)
        store.nextScenario()
        XCTAssertTrue(store.navigation?.raw == before, "Navigation changed unexpectedly")
    }

    @MainActor func testSessionChangesOnSameIDStartAndRestoreButNotTickOrPreview() throws {
        let (store, url) = try makeStore()
        defer { try? FileManager.default.removeItem(at: url) }
        try startLive(store)
        let journey = try XCTUnwrap(store.selected)
        let initial = store.navigationSessionID
        store.tick(); store.select(journey)
        XCTAssertEqual(store.navigationSessionID, initial)
        store.start(journey)
        let restarted = store.navigationSessionID
        XCTAssertNotEqual(restarted, initial)
        XCTAssertEqual(store.navigation?.journey.id, journey.id)
        store.restore()
        XCTAssertNotEqual(store.navigationSessionID, restarted)
        XCTAssertEqual(store.navigation?.journey.id, journey.id)
        let restored = store.navigationSessionID
        try Data("invalid cache".utf8).write(to: url)
        let before = store.navigation?.raw
        store.restore()
        XCTAssertEqual(store.navigationSessionID, restored)
        XCTAssertTrue(store.navigation?.raw == before)
        XCTAssertNotNil(store.error)
    }

    @MainActor func testScriptedReturnKeepsScenarioControlsAndRotatesSession() async throws {
        let (store, url) = try makeStore()
        defer { try? FileManager.default.removeItem(at: url) }
        for _ in 0..<26 where !store.canReturn { store.nextScenario() }
        XCTAssertTrue(store.canReturn)
        let outboundSession = store.navigationSessionID
        await store.returnJourney()
        XCTAssertNotEqual(store.navigationSessionID, outboundSession)
        XCTAssertTrue(store.canStepScenario)
        for _ in 0..<26 where store.navigation?.phase != "arrived" { store.nextScenario() }
        XCTAssertEqual(store.navigation?.phase, "arrived")
        XCTAssertFalse(store.canReturn)
        XCTAssertNil(store.error)
    }

    @MainActor func testFailedLiveReturnPreservesOfflineArrivalAndReturnEndpoints() async throws {
        let (store, url) = try makeStore(transport: StubTransit(fails: true))
        defer { try? FileManager.default.removeItem(at: url) }
        try startLive(store)
        completeManually(store); store.setOffline(true)
        XCTAssertTrue(store.canReturn)
        let arrived = try XCTUnwrap(store.navigation), session = store.navigationSessionID
        await store.returnJourney()
        XCTAssertTrue(store.navigation?.raw == arrived.raw)
        XCTAssertEqual(store.navigationSessionID, session)
        XCTAssertEqual(store.origin?.raw, arrived.journey.destination.raw)
        XCTAssertEqual(store.destination?.raw, arrived.journey.origin.raw)
        XCTAssertFalse(store.arriveBy)
        XCTAssertLessThan(abs(store.departure.timeIntervalSinceNow), 5)
        XCTAssertFalse(store.previewing)
        XCTAssertFalse(store.busy)
        XCTAssertNotNil(store.error)
    }

    #if HILL_CLIMB_RECOVERY_HARNESS
    @MainActor private func position(at date: Date = Date()) throws -> Data {
        try JSONEncoder().encode(XCTUnwrap(SensorPositionPayload(longitude: 7.44, latitude: 46.95, accuracy: 5, timestamp: date, receivedAt: Date(), floor: nil)))
    }

    @MainActor func testRestoreStopsOldSensorsAndDropsLateFix() throws {
        let (store, url) = try makeStore()
        defer { try? FileManager.default.removeItem(at: url) }
        try startLive(store)
        store.requestLocation()
        store.locationController.emit(try position())
        XCTAssertNotNil(store.locationPlace)
        store.locationController.startTracking()
        let stops = store.locationController.stopCount
        store.restore()
        let restored = store.navigation?.raw, origin = store.origin?.raw
        XCTAssertGreaterThan(store.locationController.stopCount, stops)
        XCTAssertFalse(store.locationController.isTracking)
        XCTAssertFalse(store.locationController.isRequesting)
        XCTAssertNil(store.locationPlace)
        store.locationController.emit(try position())
        XCTAssertTrue(store.navigation?.raw == restored, "Restored navigation accepted an obsolete fix")
        XCTAssertEqual(store.origin?.raw, origin)
        XCTAssertNil(store.locationPlace)
    }

    @MainActor func testNewJourneyRejectsRecentFixCapturedInPreviousContext() throws {
        let (store, url) = try makeStore()
        defer { try? FileManager.default.removeItem(at: url) }
        try startLive(store)
        let oldFix = try position(at: Date().addingTimeInterval(-1))
        store.start(try XCTUnwrap(store.selected)) // Same journey ID still means a NEW session.
        let before = store.navigation?.raw
        store.locationController.startTracking()
        store.locationController.emit(oldFix)
        XCTAssertTrue(store.navigation?.raw == before, "Navigation changed unexpectedly")
        XCTAssertNil(store.locationPlace)
    }

    @MainActor func testFreshPlanningFixStillWorksAndManualOriginIsRespected() throws {
        let (store, url) = try makeStore()
        defer { try? FileManager.default.removeItem(at: url) }
        try startLive(store)
        store.requestLocation()
        store.locationController.emit(try position(at: Date().addingTimeInterval(5)))
        // A future fix must be refused; it must not consume the pending request.
        XCTAssertNil(store.locationPlace)
        store.stopLocation()
        store.requestLocation()
        // Ensure encoded millisecond time is later than the journey transition boundary.
        let fix = try position()
        store.locationController.emit(fix)
        XCTAssertNotNil(store.locationPlace)
        XCTAssertEqual(store.origin?.raw, store.locationPlace?.raw)
        XCTAssertNotNil(store.navigation?.position)
        store.requestLocation()
        store.origin = store.destination
        let manualOrigin = store.origin?.raw
        store.locationController.emit(try position())
        XCTAssertEqual(store.origin?.raw, manualOrigin)
    }
    #endif
}
