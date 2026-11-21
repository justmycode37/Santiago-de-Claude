import XCTest
@testable import RightSide

private actor ControlledDepartures: StopDepartureTransport {
    var requests: [(String, CheckedContinuation<DepartureSnapshot, Error>)] = []
    func departures(stopID: String) async throws -> DepartureSnapshot {
        try await withCheckedThrowingContinuation { requests.append((stopID, $0)) }
    }
    func wait(_ count: Int) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while requests.count < count {
            guard ContinuousClock.now < deadline else { throw NativeCoreError.message("Missing departure request") }
            await Task.yield()
        }
    }
    func finish(_ index: Int, _ value: DepartureSnapshot) { requests[index].1.resume(returning: value) }
    func fail(_ index: Int) { requests[index].1.resume(throwing: NativeCoreError.message("Test network failure")) }
}
private struct ImmediateDepartures: StopDepartureTransport {
    let snapshot: DepartureSnapshot
    func departures(stopID: String) async throws -> DepartureSnapshot { snapshot }
}
private actor PlanningTransit: TransitTransport {
    var request: (Place, Place, Date, Bool)?
    var fail = false
    let response: JSONValue
    init(response: JSONValue = .object(["connections": .array([])])) { self.response = response }
    func places(_ query: String) async throws -> JSONValue { .null }
    func connections(origin: Place, destination: Place, departure: Date, arriveBy: Bool) async throws -> JSONValue {
        request = (origin, destination, departure, arriveBy)
        if fail { throw NativeCoreError.message("Test planner offline") }
        return response
    }
    func failing() { fail = true }
}

private actor DeferredPlanningTransit: TransitTransport {
    var continuation: CheckedContinuation<JSONValue, Error>?
    func places(_ query: String) async throws -> JSONValue { .null }
    func connections(origin: Place, destination: Place, departure: Date, arriveBy: Bool) async throws -> JSONValue {
        try await withCheckedThrowingContinuation { continuation = $0 }
    }
    func wait() async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while continuation == nil {
            guard ContinuousClock.now < deadline else { throw NativeCoreError.message("Missing planning request") }
            await Task.yield()
        }
    }
    func finish(_ value: JSONValue) { continuation?.resume(returning: value); continuation = nil }
}

final class StopDepartureTests: XCTestCase {
    private func station(_ id: String = "8576646") -> JSONValue {
        .object(["id": .string(id), "name": .string("Bern, Bahnhof"), "coordinate": .object(["x": .number(46.948107), "y": .number(7.440207)])])
    }
    private func board(_ id: String = "8576646", at date: Date = Date()) -> JSONValue {
        let stop: JSONValue = .object(["station": station(id), "departure": .string(WireClock.string(date.addingTimeInterval(300))),
            "platform": .string("A"), "prognosis": .object(["departure": .string(WireClock.string(date.addingTimeInterval(360))), "platform": .string("B")])])
        return .object(["station": station(id), "stationboard": .array([.object(["stop": stop, "number": .string("7"), "category": .string("T"),
            "to": .string("Bern, Ostring"), "name": .string("010853"), "passList": .array([stop, stop])])])])
    }
    private func snapshot(_ id: String = "8576646", at now: Date = Date(), raw: JSONValue? = nil) throws -> DepartureSnapshot {
        try DepartureSnapshot.decode(data: JSONEncoder().encode(raw ?? board(id, at: now)), stopID: id, acquiredAt: now, responseDate: "HTTP metadata only", now: now)
    }
    private func file() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("departures-\(UUID()).json") }

    @MainActor func testPositiveParseSeparatesSchedulePredictionPlatformAndOccurrences() throws {
        let now = Date(), value = try snapshot(at: now)
        XCTAssertEqual(value.stopID, "8576646"); XCTAssertEqual(value.stop.coordinate, [7.440207, 46.948107])
        XCTAssertEqual(value.rows[0].predicted!.timeIntervalSince(value.rows[0].scheduled), 60, accuracy: 0.001)
        XCTAssertEqual(value.rows[0].platform, "A"); XCTAssertEqual(value.rows[0].predictedPlatform, "B")
        XCTAssertEqual(value.rows[0].calls.map(\.id), [0,1]); XCTAssertEqual(value.rows[0].calls[0].place, value.rows[0].calls[1].place)
        XCTAssertEqual(value.rows[0].cancellationLabel, "Cancellation status not supplied")
        XCTAssertTrue(value.valid(at: now)); XCTAssertEqual(value.sourceSHA256.count, 64)
        XCTAssertNoThrow(try DomainBridge().call("validatePlace", .object(["place": value.stop.raw])))
    }
    func testAmbiguousMissingAndInvalidStopIdentityFailsClosed() throws {
        let value = try snapshot(); var raw = value.stop.raw
        raw["sourceRefs"] = .array(raw["sourceRefs"].array + [.object(["provider": .string(DepartureStop.provider), "id": .string("8507000")])])
        XCTAssertNil(DepartureStop.id(for: Place(raw: raw)))
        for id in ["", "Bern", "8507000&x=1", "８５０７０００", "1", "0000000000"] { XCTAssertFalse(DepartureStop.validID(id)) }
        raw["sourceRefs"] = .array([]); XCTAssertNil(DepartureStop.id(for: Place(raw: raw)))
    }
    func testDifferentResponseStopOrUnidentifiedRowsReject() throws {
        let now = Date()
        XCTAssertThrowsError(try snapshot("8507000", at: now, raw: board()))
        var raw = board(at: now), rows = raw["stationboard"].array
        rows[0]["stop"]["station"]["id"] = .string("8507000"); raw["stationboard"] = .array(rows)
        XCTAssertThrowsError(try snapshot(at: now, raw: raw))
    }
    func testParentStopIdentityDoesNotBindChildBoardingLocation() throws {
        var raw = board(), rows = raw["stationboard"].array
        rows[0]["stop"]["location"] = station("8587480"); raw["stationboard"] = .array(rows)
        XCTAssertEqual(try snapshot(raw: raw).stopID, "8576646")
    }
    func testMissingPredictionsDirectionAndPlatformStayUnknown() throws {
        var raw = board(), rows = raw["stationboard"].array
        rows[0]["to"] = .null; rows[0]["stop"]["platform"] = .null; rows[0]["stop"]["prognosis"] = .null
        rows[0]["cancelled"] = .bool(true) // Unsupported field is not treated as an established provider contract.
        raw["stationboard"] = .array(rows)
        let value = try snapshot(raw: raw).rows[0]
        XCTAssertNil(value.destination); XCTAssertNil(value.platform); XCTAssertNil(value.predicted)
        XCTAssertEqual(value.cancellationLabel, "Cancellation status not supplied")
    }
    func testRepeatedLineDirectionsRemainSeparateAndBoundsApply() throws {
        var raw = board(), row = raw["stationboard"].array[0]
        row["passList"] = .array(Array(repeating: row["stop"], count: 100))
        var rows = Array(repeating: row, count: 45); rows[1]["to"] = .string("Opposite direction")
        raw["stationboard"] = .array(rows)
        let value = try snapshot(raw: raw)
        XCTAssertEqual(value.rows.count, 40); XCTAssertEqual(Set(value.rows.map(\.id)).count, 40)
        XCTAssertEqual(value.rows[0].calls.count, 80); XCTAssertEqual(value.omittedRows, 5)
        XCTAssertNotEqual(value.rows[0].destination, value.rows[1].destination)
    }
    func testServerExceedingRequestedLimitAndByteLimitAreBoundedBeforeParsing() throws {
        let now = Date(); var raw = board(at: now)
        raw["stationboard"] = .array(Array(repeating: raw["stationboard"].array[0], count: 15))
        let data = try JSONEncoder().encode(raw)
        let value = try DepartureSnapshot.decode(data: data, stopID: "8576646", acquiredAt: now, responseDate: nil, now: now, queryLimit: 12)
        XCTAssertEqual(value.rows.count, 12); XCTAssertEqual(value.omittedRows, 3); XCTAssertTrue(value.queryKey.hasSuffix("|12"))
        XCTAssertThrowsError(try DepartureSnapshot.decode(data: Data(repeating: 32, count: 2_000_001), stopID: "8576646", acquiredAt: now, responseDate: nil, now: now))
        for limit in [-1, 0, 41, Int.max] {
            XCTAssertThrowsError(try DepartureSnapshot.decode(data: data, stopID: "8576646", acquiredAt: now, responseDate: nil, now: now, queryLimit: limit))
        }
    }
    func testFutureExpiredAndMalformedDatesFailClosed() throws {
        let now = Date(), value = try snapshot(at: now)
        XCTAssertFalse(value.valid(at: now.addingTimeInterval(-1))); XCTAssertFalse(value.valid(at: now.addingTimeInterval(86_401)))
        var raw = board(at: now), rows = raw["stationboard"].array
        rows[0]["stop"]["departure"] = .string("not-a-date"); raw["stationboard"] = .array(rows)
        XCTAssertThrowsError(try snapshot(at: now, raw: raw))
        rows[0]["stop"]["departure"] = .string(WireClock.string(now))
        rows[0]["stop"]["prognosis"]["departure"] = .string("2099-01-01T00:00:00Z"); raw["stationboard"] = .array(rows)
        XCTAssertNil(try snapshot(at: now, raw: raw).rows[0].predicted)
    }
    func testDSTAndMidnightRetainOffsetInstants() throws {
        let now = WireClock.date("2026-10-25T00:00:00Z")!
        var raw = board(at: now), rows = raw["stationboard"].array
        rows[0]["stop"]["departure"] = .string("2026-10-25T02:30:00+0200")
        rows[0]["stop"]["prognosis"]["departure"] = .string("2026-10-25T02:30:00+0100")
        raw["stationboard"] = .array(rows)
        let row = try snapshot(at: now, raw: raw).rows[0]
        XCTAssertEqual(row.predicted!.timeIntervalSince(row.scheduled), 3600)
        XCTAssertEqual(row.scheduled, WireClock.date("2026-10-25T00:30:00Z"))
        rows[0]["stop"]["departure"] = .string("2026-10-25T00:05:00+0200"); raw["stationboard"] = .array(rows)
        XCTAssertEqual(try snapshot(at: now, raw: raw).rows[0].scheduled, WireClock.date("2026-10-24T22:05:00Z"))
    }
    @MainActor func testOfflineRestartPreservesAcquisitionAndDisablesPrediction() async throws {
        let path = file(); defer { try? FileManager.default.removeItem(at: path) }
        let value = try snapshot(), controller = StopDepartureController(transport: ImmediateDepartures(snapshot: value), cacheURL: path)
        await controller.select(value.stop, offline: false)
        XCTAssertTrue(controller.mayShowPrediction(at: Date())); XCTAssertFalse(controller.mayShowPrediction(at: value.acquiredAt.addingTimeInterval(91)))
        let restored = StopDepartureController(cacheURL: path)
        await restored.select(value.stop, offline: true)
        XCTAssertEqual(restored.snapshot, value); XCTAssertTrue(restored.fromCache); XCTAssertFalse(restored.mayShowPrediction(at: Date()))
        XCTAssertEqual(restored.snapshot?.acquiredAt, value.acquiredAt)
        let other = try snapshot("8507000"); await restored.select(other.stop, offline: true); XCTAssertNil(restored.snapshot)
    }
    @MainActor func testFailedRefreshRetainsMatchingCacheAndNoLivePrediction() async throws {
        let path = file(); defer { try? FileManager.default.removeItem(at: path) }
        let value = try snapshot(), transport = ControlledDepartures(), controller = StopDepartureController(transport: transport, cacheURL: path)
        let first = Task { await controller.select(value.stop, offline: false) }
        try await transport.wait(1); await transport.finish(0, value); await first.value
        let second = Task { await controller.refresh() }
        try await transport.wait(2); await transport.fail(1); await second.value
        XCTAssertEqual(controller.snapshot, value); XCTAssertNotNil(controller.error); XCTAssertFalse(controller.mayShowPrediction(at: Date()))
        XCTAssertFalse(controller.loading)
    }
    @MainActor func testRapidStopSwitchLateSuccessCannotReplaceDisplayOrCache() async throws {
        let path = file(); defer { try? FileManager.default.removeItem(at: path) }
        let a = try snapshot(), b = try snapshot("8507000"), transport = ControlledDepartures()
        let controller = StopDepartureController(transport: transport, cacheURL: path)
        let first = Task { await controller.select(a.stop, offline: false) }; try await transport.wait(1)
        let second = Task { await controller.select(b.stop, offline: false) }; try await transport.wait(2)
        await transport.finish(1, b); await second.value; await transport.finish(0, a); await first.value
        XCTAssertEqual(controller.snapshot, b)
        let restored = StopDepartureController(cacheURL: path); XCTAssertEqual(restored.recentStops, [b.stop])
    }
    @MainActor func testRepeatedSameStopLateFailureCannotEraseNewerSuccess() async throws {
        let path = file(); defer { try? FileManager.default.removeItem(at: path) }
        let value = try snapshot(), transport = ControlledDepartures(), controller = StopDepartureController(transport: transport, cacheURL: path)
        let first = Task { await controller.select(value.stop, offline: false) }; try await transport.wait(1)
        let second = Task { await controller.refresh() }; try await transport.wait(2)
        await transport.finish(1, value); await second.value; await transport.fail(0); await first.value
        XCTAssertEqual(controller.snapshot, value); XCTAssertNil(controller.error); XCTAssertTrue(controller.mayShowPrediction(at: Date()))
    }
    @MainActor func testOfflineTransitionAndExplicitCancelRejectPendingResults() async throws {
        for offline in [true, false] {
            let path = file(); defer { try? FileManager.default.removeItem(at: path) }
            let value = try snapshot(), transport = ControlledDepartures(), controller = StopDepartureController(transport: transport, cacheURL: path)
            let work = Task { await controller.select(value.stop, offline: false) }; try await transport.wait(1)
            if offline { await controller.setOffline(true) } else { controller.cancel() }
            await transport.finish(0, value); await work.value
            XCTAssertNil(controller.snapshot); XCTAssertFalse(controller.loading); XCTAssertFalse(FileManager.default.fileExists(atPath: path.path))
        }
    }
    @MainActor func testCallerCancellationCleansLoadingAndCannotPersistLateSuccess() async throws {
        let path = file(); defer { try? FileManager.default.removeItem(at: path) }
        let value = try snapshot(), transport = ControlledDepartures(), controller = StopDepartureController(transport: transport, cacheURL: path)
        let work = Task { await controller.select(value.stop, offline: false) }; try await transport.wait(1)
        work.cancel(); await transport.finish(0, value); await work.value
        XCTAssertFalse(controller.loading); XCTAssertNil(controller.snapshot); XCTAssertFalse(FileManager.default.fileExists(atPath: path.path))
    }
    @MainActor func testEmptyBoardIsValidAndWrongTransportStopRejected() async throws {
        let path = file(); defer { try? FileManager.default.removeItem(at: path) }
        var raw = board(); raw["stationboard"] = .array([])
        let empty = try snapshot(raw: raw), controller = StopDepartureController(transport: ImmediateDepartures(snapshot: empty), cacheURL: path)
        await controller.select(empty.stop, offline: false); XCTAssertEqual(controller.snapshot?.rows.count, 0); XCTAssertNil(controller.error)
        let wrong = StopDepartureController(transport: ImmediateDepartures(snapshot: try snapshot("8507000")), cacheURL: file())
        await wrong.select(empty.stop, offline: false); XCTAssertNil(wrong.snapshot); XCTAssertNotNil(wrong.error)
    }
    @MainActor func testBoundedCacheFourStopsAndExpiredRestartDropsEntries() async throws {
        let path = file(); defer { try? FileManager.default.removeItem(at: path) }
        let transport = ControlledDepartures(), controller = StopDepartureController(transport: transport, cacheURL: path)
        for index in 0..<6 {
            let value = try snapshot(String(8507000 + index))
            let work = Task { await controller.select(value.stop, offline: false) }; try await transport.wait(index + 1)
            await transport.finish(index, value); await work.value
        }
        XCTAssertEqual(controller.recentStops.count, 4)
        let restored = StopDepartureController(cacheURL: path); XCTAssertEqual(restored.recentStops.count, 4)
        let expired = StopDepartureController(cacheURL: path, now: Date().addingTimeInterval(86_401)); XCTAssertTrue(expired.recentStops.isEmpty)
    }
    @MainActor func testFreshPlanUsesSelectedStopAndPreservesActiveNavigation() async throws {
        let path = file(); defer { try? FileManager.default.removeItem(at: path) }
        let transport = PlanningTransit(), store = JourneyStore(cacheURL: path, transport: transport)
        store.loadDemo(); store.start(try XCTUnwrap(store.selected)); store.confirm("arrived")
        let before = store.navigation, session = store.navigationSessionID, stop = try snapshot().stop
        let destination = try XCTUnwrap(before?.journey.destination), date = Date().addingTimeInterval(3600)
        await store.planFromStop(stop, to: destination, departure: date, arriveBy: true)
        XCTAssertNil(store.error); XCTAssertEqual(store.navigation, before); XCTAssertEqual(store.navigationSessionID, session)
        let request = await transport.request
        XCTAssertEqual(request?.0, stop); XCTAssertEqual(request?.1, destination); XCTAssertEqual(request?.2, date); XCTAssertEqual(request?.3, true)
        await transport.failing(); await store.planFromStop(stop, to: destination, departure: date)
        XCTAssertNotNil(store.error); XCTAssertEqual(store.navigation, before); XCTAssertEqual(store.navigationSessionID, session)
    }
    @MainActor func testFreshPlanSuccessIsPreviewUntilExplicitStart() async throws {
        let path = file(); defer { try? FileManager.default.removeItem(at: path) }
        let raw = try JSONValue(json: #"{"connections":[{"sections":[{"departure":{"station":{"id":"8576646","name":"Bern, Bahnhof"},"departure":"2026-11-21T10:00:00Z"},"arrival":{"station":{"id":"8507001","name":"Bern test destination"},"arrival":"2026-11-21T10:10:00Z"}}]}]}"#)
        let store = JourneyStore(cacheURL: path, transport: PlanningTransit(response: raw))
        store.loadDemo(); store.start(try XCTUnwrap(store.selected))
        let before = store.navigation, session = store.navigationSessionID
        await store.planFromStop(try snapshot().stop, to: try XCTUnwrap(before?.journey.destination), departure: Date())
        XCTAssertNil(store.error); XCTAssertFalse(store.alternatives.isEmpty); XCTAssertTrue(store.previewing)
        XCTAssertEqual(store.navigation, before); XCTAssertEqual(store.navigationSessionID, session)
        store.start(try XCTUnwrap(store.selected)); XCTAssertNotEqual(store.navigationSessionID, session)
        XCTAssertEqual(store.navigation?.journey.origin.name, "Bern, Bahnhof")
    }
    @MainActor func testMalformedFutureAndWrongQueryCacheCannotBecomeCurrent() async throws {
        let path = file(); defer { try? FileManager.default.removeItem(at: path) }
        let value = try snapshot(), encoded = try JSONEncoder().encode(value)
        var raw = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        for invalid in ["future", "version", "query"] {
            var bad = raw
            if invalid == "future" { bad["acquiredAt"] = Date().addingTimeInterval(3600).timeIntervalSinceReferenceDate }
            if invalid == "version" { bad["version"] = 999 }
            if invalid == "query" { bad["queryLimit"] = 12 }
            try JSONSerialization.data(withJSONObject: ["version": 1, "entries": [bad]]).write(to: path)
            let controller = StopDepartureController(cacheURL: path)
            await controller.select(value.stop, offline: true)
            XCTAssertNil(controller.snapshot, invalid); XCTAssertFalse(controller.mayShowPrediction(at: Date()))
        }
        raw["acquiredAt"] = "malformed"
        try JSONSerialization.data(withJSONObject: ["version": 1, "entries": [raw]]).write(to: path)
        XCTAssertTrue(StopDepartureController(cacheURL: path).recentStops.isEmpty)
    }
    @MainActor func testInvalidFreshPlanDoesNotDispatchOrChangeActiveSession() async throws {
        let path = file(); defer { try? FileManager.default.removeItem(at: path) }
        let transport = PlanningTransit(), store = JourneyStore(cacheURL: path, transport: transport)
        store.loadDemo(); store.start(try XCTUnwrap(store.selected)); let before = store.navigation, session = store.navigationSessionID
        var stop = try snapshot().stop.raw; stop["sourceRefs"] = .array([])
        await store.planFromStop(Place(raw: stop), to: try XCTUnwrap(before?.journey.destination), departure: Date())
        let request = await transport.request
        XCTAssertNil(request); XCTAssertNotNil(store.error); XCTAssertEqual(store.navigation, before); XCTAssertEqual(store.navigationSessionID, session)
    }
    @MainActor func testInvalidReplacementClearsPriorPreviewAndRejectsLateSearch() async throws {
        let response = try JSONValue(json: #"{"connections":[{"sections":[{"departure":{"station":{"id":"8576646","name":"Bern, Bahnhof"},"departure":"2026-11-21T10:00:00Z"},"arrival":{"station":{"id":"8507001","name":"Bern test destination"},"arrival":"2026-11-21T10:10:00Z"}}]}]}"#)
        for invalid in ["stop", "time", "destination"] {
            let path = file(); defer { try? FileManager.default.removeItem(at: path) }
            let store = JourneyStore(cacheURL: path, transport: PlanningTransit(response: response))
            store.loadDemo(); store.start(try XCTUnwrap(store.selected)); store.confirm("arrived")
            let before = store.navigation, session = store.navigationSessionID, saved = try Data(contentsOf: path)
            let stop = try snapshot().stop, destination = try XCTUnwrap(before?.journey.destination)
            await store.planFromStop(stop, to: destination, departure: Date())
            XCTAssertTrue(store.previewing); XCTAssertFalse(store.alternatives.isEmpty)
            var badStop = stop.raw; badStop["sourceRefs"] = .array([])
            await store.planFromStop(invalid == "stop" ? Place(raw: badStop) : stop,
                to: invalid == "destination" ? Place(raw: .null) : destination,
                departure: invalid == "time" ? Date(timeIntervalSince1970: .nan) : Date())
            XCTAssertNotNil(store.error, invalid); XCTAssertFalse(store.previewing, invalid)
            XCTAssertTrue(store.alternatives.isEmpty, invalid); XCTAssertEqual(store.selected, before?.journey, invalid)
            XCTAssertEqual(store.navigation, before, invalid); XCTAssertEqual(store.navigationSessionID, session, invalid)
            XCTAssertEqual(try Data(contentsOf: path), saved, invalid)
        }
        let path = file(); defer { try? FileManager.default.removeItem(at: path) }
        let transport = DeferredPlanningTransit(), store = JourneyStore(cacheURL: path, transport: transport)
        store.loadDemo(); store.start(try XCTUnwrap(store.selected)); let before = store.navigation, session = store.navigationSessionID
        let stop = try snapshot().stop, destination = try XCTUnwrap(before?.journey.destination)
        let pending = Task { await store.planFromStop(stop, to: destination, departure: Date()) }
        try await transport.wait()
        await store.planFromStop(Place(raw: .null), to: destination, departure: Date())
        await transport.finish(response); await pending.value
        XCTAssertFalse(store.previewing); XCTAssertTrue(store.alternatives.isEmpty); XCTAssertEqual(store.selected, before?.journey)
        XCTAssertEqual(store.navigation, before); XCTAssertEqual(store.navigationSessionID, session)
    }
    @MainActor func testRealBoardCallToFreshProviderPlanningPreservesActiveUntilStart() async throws {
        guard let directory = ProcessInfo.processInfo.environment["A4_HANDOFF_FIXTURE"] else { throw XCTSkip("Real handoff artifact supplied by standalone harness") }
        let root = URL(fileURLWithPath: directory), path = file(); defer { try? FileManager.default.removeItem(at: path) }
        func json(_ name: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: root.appendingPathComponent(name + ".json"))) }
        let metadata = try json("board-provenance"), selection = try json("selection")
        let acquired = try XCTUnwrap(WireClock.date(metadata["acquiredAt"].string ?? ""))
        let board = try DepartureSnapshot.decode(data: Data(contentsOf: root.appendingPathComponent("board.json")), stopID: "8576646", acquiredAt: acquired, responseDate: metadata["responseDate"].string, now: acquired)
        let row = try XCTUnwrap(board.rows.first { $0.id == Int(selection["boardRowIndex"].double ?? -1) })
        let destination = try XCTUnwrap(row.calls.first { DepartureStop.id(for: $0.place) == selection["selectedDestination"]["id"].string }?.place)
        let store = JourneyStore(cacheURL: path, transport: PlanningTransit(response: try json("planner")))
        store.loadDemo(); store.start(try XCTUnwrap(store.selected)); let before = store.navigation, session = store.navigationSessionID
        await store.planFromStop(board.stop, to: destination, departure: acquired)
        XCTAssertNil(store.error); XCTAssertEqual(store.alternatives.count, 4); XCTAssertTrue(store.previewing)
        XCTAssertEqual(store.navigation, before); XCTAssertEqual(store.navigationSessionID, session)
        XCTAssertEqual(board.rows.count, 40); XCTAssertEqual(board.omittedRows, 3)
        store.start(try XCTUnwrap(store.selected)); XCTAssertNotEqual(store.navigationSessionID, session)
        XCTAssertEqual(DepartureStop.id(for: store.navigation!.journey.destination), "8571395")
        print("A4 real handoff: Bern, Bahnhof → \(destination.name), \(board.rows.count) displayed rows, \(board.omittedRows) bounded omissions, 4 full planner alternatives; explicit Start changes session only")
    }
    func testActualProviderFixturesRetainStopIdentityAndUsefulCalls() throws {
        guard let directory = ProcessInfo.processInfo.environment["A4_PROVIDER_FIXTURES"] else { throw XCTSkip("Real provider artifacts supplied by standalone harness") }
        for id in ["8576646", "8507000"] {
            let root = URL(fileURLWithPath: directory)
            let metadata = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: root.appendingPathComponent("\(id)-provenance.json")))
            let date = try XCTUnwrap(WireClock.date(metadata["acquiredAt"].string ?? ""))
            let value = try DepartureSnapshot.decode(data: Data(contentsOf: root.appendingPathComponent("\(id).json")), stopID: id,
                acquiredAt: date, responseDate: metadata["responseDate"].string, now: date, queryLimit: 12)
            XCTAssertFalse(value.rows.isEmpty); XCTAssertTrue(value.rows.contains { !$0.calls.isEmpty })
            XCTAssertEqual(value.sourceSHA256, metadata["sha256"].string)
            print("A4 actual provider \(id): \(value.rows.count) rows, \(value.rows.reduce(0) { $0 + $1.calls.count }) identified call occurrences, acquired \(date)")
        }
    }
}
