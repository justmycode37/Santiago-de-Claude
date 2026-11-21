import XCTest
@testable import RightSide

@MainActor private final class DeferredDepartureOutcome {
    var pending: CheckedContinuation<DeparturePlanOutcome, Never>?
    func run() async -> DeparturePlanOutcome { await withCheckedContinuation { pending = $0 } }
    func finish(_ value: DeparturePlanOutcome) { pending?.resume(returning: value); pending = nil }
}
private actor DepartureHeldTransport: TransitTransport {
    var pending: CheckedContinuation<JSONValue, Error>?
    func places(_ query: String) async throws -> JSONValue { .null }
    func connections(origin: Place, destination: Place, departure: Date, arriveBy: Bool) async throws -> JSONValue {
        try await withCheckedThrowingContinuation { pending = $0 }
    }
    func started() -> Bool { pending != nil }
    func finish(_ value: JSONValue) { pending?.resume(returning: value); pending = nil }
}
final class DeparturePresentationTests: XCTestCase {
    @MainActor private func until(_ predicate: () -> Bool) async throws {
        let end = ContinuousClock.now.advanced(by: .seconds(5))
        while !predicate() {
            guard ContinuousClock.now < end else { throw NativeCoreError.message("Presentation did not settle") }
            await Task.yield()
        }
    }
    @MainActor func testDraftInitializationOccursOnceAcrossDetailReturn() {
        let state = DeparturePresentation()
        var destination = "initial", selectedStop = "A", offline = false
        if state.activate() { destination = "active destination" }
        selectedStop = "B"; destination = "reported call C"; offline = true
        state.deactivate()
        if state.activate() { selectedStop = "A"; destination = "active destination"; offline = false }
        XCTAssertEqual(selectedStop, "B"); XCTAssertEqual(destination, "reported call C"); XCTAssertTrue(offline)
        XCTAssertTrue(DeparturePresentation().activate(), "A genuinely new presentation initializes")
    }
    @MainActor func testDismissedCancellationIgnoringCompletionCannotCloseNewPanel() async throws {
        let state = DeparturePresentation(), held = DeferredDepartureOutcome()
        state.activate(); var panel = "departures"
        state.plan(operation: { await held.run() }, onReady: { panel = "closed" })
        try await until { held.pending != nil }
        state.deactivate(); panel = "language"
        held.finish(.ready)
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(panel, "language"); XCTAssertNil(state.outcome); XCTAssertFalse(state.planning)
    }
    @MainActor func testSupersededFailureCannotReplaceNewSuccess() async throws {
        let state = DeparturePresentation(), old = DeferredDepartureOutcome(), current = DeferredDepartureOutcome()
        state.activate(); var handoffs = 0
        state.plan(operation: { await old.run() }, onReady: { handoffs += 100 })
        try await until { old.pending != nil }
        state.plan(operation: { await current.run() }, onReady: { handoffs += 1 })
        try await until { current.pending != nil }
        current.finish(.ready); try await until { state.outcome == .ready }
        old.finish(.failed("late failure"))
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(handoffs, 1); XCTAssertEqual(state.outcome, .ready)
    }
    @MainActor func testEmptyAndFailedOutcomesRemainEditableAndRetrySucceeds() async throws {
        let state = DeparturePresentation(); state.activate(); var handoffs = 0
        for result in [DeparturePlanOutcome.empty, .failed("offline")] {
            state.plan(operation: { result }, onReady: { handoffs += 1 })
            try await until { !state.planning }
            XCTAssertEqual(state.outcome, result); XCTAssertEqual(handoffs, 0)
        }
        state.plan(operation: { .ready }, onReady: { handoffs += 1 })
        try await until { !state.planning }
        XCTAssertEqual(state.outcome, .ready); XCTAssertEqual(handoffs, 1)
    }
    @MainActor func testDismissedActualStoreRequestCannotPublishPreview() async throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("R8-\(UUID()).json")
        defer { try? FileManager.default.removeItem(at: path) }
        let transport = DepartureHeldTransport(), store = JourneyStore(cacheURL: path, transport: transport)
        store.loadDemo(); store.start(try XCTUnwrap(store.selected))
        let navigation = try XCTUnwrap(store.navigation), session = store.navigationSessionID
        let saved = try Data(contentsOf: path)
        var stopRaw = navigation.journey.origin.raw
        stopRaw["kind"] = .string("stop")
        stopRaw["sourceRefs"] = .array([.object(["provider": .string(DepartureStop.provider), "id": .string("8576646"), "feedVersion": .string("test")])])
        let stop = Place(raw: stopRaw)
        let state = DeparturePresentation(); state.activate(); var callbacks = 0; var returned = false
        state.plan(operation: {
            await store.planFromStop(stop, to: navigation.journey.destination, departure: Date())
            returned = true; return .ready
        }, onReady: { callbacks += 1 })
        let end = ContinuousClock.now.advanced(by: .seconds(5))
        while !(await transport.started()) {
            guard ContinuousClock.now < end else { XCTFail(store.error ?? "Request missing"); return }
            await Task.yield()
        }
        state.deactivate()
        let response = try JSONValue(json: #"{"connections":[{"sections":[{"departure":{"station":{"id":"8576646","name":"Bern, Bahnhof"},"departure":"2026-11-21T10:00:00Z"},"arrival":{"station":{"id":"8507001","name":"Bern test destination"},"arrival":"2026-11-21T10:10:00Z"}}]}]}"#)
        await transport.finish(response); try await until { returned }
        XCTAssertEqual(callbacks, 0); XCTAssertFalse(store.previewing); XCTAssertTrue(store.alternatives.isEmpty)
        XCTAssertEqual(store.navigation, navigation); XCTAssertEqual(store.navigationSessionID, session)
        XCTAssertEqual(try Data(contentsOf: path), saved)
    }
    func testSwissClockDistinguishesMidnightAndRepeatedDSTTimes() throws {
        let formatter = ISO8601DateFormatter()
        let first = try XCTUnwrap(formatter.date(from: "2026-10-25T00:30:00Z"))
        let second = try XCTUnwrap(formatter.date(from: "2026-10-25T01:30:00Z"))
        let midnight = try XCTUnwrap(formatter.date(from: "2026-11-21T23:10:00Z"))
        for language in JourneyLanguage.allCases {
            let a = DepartureServiceClock.label(first, language: language), b = DepartureServiceClock.label(second, language: language)
            XCTAssertTrue(a.contains("02:30 +02:00")); XCTAssertTrue(b.contains("02:30 +01:00")); XCTAssertNotEqual(a, b)
            let label = DepartureServiceClock.label(midnight, language: language)
            XCTAssertTrue(label.hasPrefix("22 ")); XCTAssertTrue(label.contains("00:10 +01:00"))
        }
    }
    func testDepartureCataloguePreservesTokensAndPhysicalNames() {
        let tokens = try! NSRegularExpression(pattern: #"\{[0-9]+\}"#)
        func placeholders(_ value: String) -> [String] {
            tokens.matches(in: value, range: NSRange(value.startIndex..., in: value)).map { String(value[Range($0.range, in: value)!]) }.sorted()
        }
        XCTAssertEqual(JourneyLanguage.departureCatalogue.count, 78)
        for (key, alternatives) in JourneyLanguage.departureCatalogue {
            XCTAssertEqual(alternatives.count, 2)
            for text in alternatives { XCTAssertFalse(text.isEmpty); XCTAssertEqual(placeholders(key), placeholders(text), key) }
        }
        for language in JourneyLanguage.allCases {
            let physical = "Bern, Bahnhof {0} / 12 → Brünnen Westside Bhf"
            XCTAssertTrue(language.departure("Explored: {0}", physical).contains(physical))
            for key in ["Stop departures", "Planning failed. Your request is kept; try again.", "Current prediction unavailable", "Use saved departures offline"] {
                if language != .en { XCTAssertNotEqual(language.departure(key), key) }
            }
        }
    }
    @MainActor func testInactivePresentationDoesNotDispatch() async {
        let state = DeparturePresentation(); var calls = 0
        state.plan(operation: { calls += 1; return .ready }, onReady: { calls += 100 })
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(calls, 0); XCTAssertFalse(state.planning)
    }
}
