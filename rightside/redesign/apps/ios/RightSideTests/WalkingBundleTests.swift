import XCTest
import MapKit
@testable import RightSide

@MainActor final class WalkingBundleTests: XCTestCase {
    private func walk(_ id: String, offset: Double = 0) -> Leg {
        func place(_ lon: Double, _ name: String) -> JSONValue {
            .object(["id": .string(name), "name": .string(name), "coordinate": .array([.number(lon), .number(46.95)])])
        }
        return Leg(raw: .object(["id": .string(id), "kind": .string(id == "transfer" ? "transfer" : "walk"),
            "from": place(7.44 + offset, "Original sign"), "to": place(7.441 + offset, "Original entrance")]))
    }
    private func journey(_ id: String = "outbound", revision: Int = 1, walks: [Leg]? = nil) -> Journey {
        Journey(raw: .object(["id": .string(id), "revision": .number(Double(revision)),
            "legs": .array((walks ?? [walk("access"), walk("transfer", offset: 0.01), walk("final", offset: 0.02)]).map(\.raw))]))
    }
    private func controller(_ storage: MemoryWalkingStorage, _ provider: RecordingWalkingRouting) -> WalkingRouteController {
        WalkingRouteController(cacheURL: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString), storage: storage, routing: provider)
    }
    private func waitFor(_ condition: @escaping () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while !condition() && ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(condition()); if !condition() { throw CancellationError() }
    }
    func testThreeWalksSaveProgressAndRestoreOfflineWithoutNetworkOrDateRefresh() async throws {
        let storage = MemoryWalkingStorage(), provider = RecordingWalkingRouting(), trip = journey(), session = UUID()
        let live = controller(storage, provider)
        live.configure(journey: trip, session: session, offline: false)
        await live.saveForOffline()
        XCTAssertEqual(provider.requests.map(\.id), ["access", "transfer", "final"])
        XCTAssertEqual(provider.maximumConcurrent, 1)
        XCTAssertEqual(live.rows().filter { $0.status == .saved }.count, 3)
        let dates = live.bundle?.routes.map(\.fetchedAt)
        let decoded = try JSONDecoder().decode(WalkingBundle.self, from: XCTUnwrap(storage.data))
        XCTAssertTrue(decoded.valid); XCTAssertEqual(decoded.identity, WalkingBundleIdentity(trip))
        if let artifact = ProcessInfo.processInfo.environment["WALK_BUNDLE_ARTIFACT"] {
            try XCTUnwrap(storage.data).write(to: URL(fileURLWithPath: artifact), options: .atomic)
        }
        let forbidden = RecordingWalkingRouting(); forbidden.failAll = true
        let restored = controller(storage, forbidden)
        restored.configure(journey: trip, session: UUID(), offline: true)
        for leg in trip.legs {
            await restored.load(leg, simulated: false, offline: true, journey: trip)
            XCTAssertEqual(restored.snapshot?.leg, leg)
            XCTAssertEqual(restored.snapshot?.coordinates, [leg.from.coordinate!, leg.to.coordinate!])
            XCTAssertTrue(restored.usingSavedRoute); XCTAssertNotNil(restored.polyline)
            XCTAssertEqual(restored.snapshot?.steps.first?.instruction, "Follow physical sign for \(leg.id)")
        }
        XCTAssertEqual(restored.bundle?.routes.map(\.fetchedAt), dates)
        XCTAssertTrue(forbidden.requests.isEmpty)
        let oldFix = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 46.95, longitude: 7.46), altitude: 0,
            horizontalAccuracy: 5, verticalAccuracy: -1, timestamp: Date().addingTimeInterval(-60))
        XCTAssertEqual(restored.assessment(fix: oldFix).status, .unavailable)
        let coarse = CLLocation(coordinate: oldFix.coordinate, altitude: 0, horizontalAccuracy: 90, verticalAccuracy: -1, timestamp: Date())
        XCTAssertEqual(restored.assessment(fix: coarse).status, .uncertain)
        let tomorrow = Date().addingTimeInterval(86_401)
        let futureFix = CLLocation(coordinate: oldFix.coordinate, altitude: 0, horizontalAccuracy: 5, verticalAccuracy: -1, timestamp: tomorrow)
        XCTAssertEqual(restored.assessment(fix: futureFix, now: tomorrow).status, .unavailable)
    }
    func testSameLabelsChangedEndpointOrRevisionCannotUseSavedPath() async {
        let storage = MemoryWalkingStorage(), provider = RecordingWalkingRouting(), trip = journey()
        let sut = controller(storage, provider); sut.configure(journey: trip, session: UUID(), offline: false)
        await sut.saveForOffline(); let original = storage.data
        let changed = journey(walks: [walk("access", offset: 0.5)])
        sut.configure(journey: changed, session: UUID(), offline: true)
        await sut.load(changed.legs[0], simulated: false, offline: true, journey: changed)
        XCTAssertNil(sut.snapshot); XCTAssertNil(sut.bundle); XCTAssertEqual(storage.data, original)
        let revised = journey(revision: 2)
        sut.configure(journey: revised, session: UUID(), offline: true)
        await sut.load(revised.legs[0], simulated: false, offline: true, journey: revised)
        XCTAssertNil(sut.snapshot); XCTAssertEqual(storage.data, original)
    }
    func testLatePriorJourneyCompletionCannotAttachOrWrite() async throws {
        let storage = MemoryWalkingStorage(), provider = RecordingWalkingRouting(); provider.hold = true
        let sut = controller(storage, provider), first = journey(), next = journey("return")
        sut.configure(journey: first, session: UUID(), offline: false)
        let save = Task { await sut.saveForOffline() }
        try await waitFor { provider.requests.count == 1 }
        sut.configure(journey: next, session: UUID(), offline: false)
        provider.release(); await save.value
        XCTAssertNil(storage.data); XCTAssertNil(sut.bundle); XCTAssertFalse(sut.isSaving)
        provider.hold = false; await sut.saveForOffline()
        XCTAssertEqual(sut.bundle?.identity.journeyID, "return"); XCTAssertEqual(sut.bundle?.routes.count, 3)
    }
    func testRevisionChangeAndSameIDRestartCancelInflightSave() async throws {
        for sameRevision in [true, false] {
            let storage = MemoryWalkingStorage(), provider = RecordingWalkingRouting(); provider.hold = true
            let sut = controller(storage, provider); sut.configure(journey: journey(), session: UUID(), offline: false)
            let save = Task { await sut.saveForOffline() }; try await waitFor { provider.requests.count == 1 }
            sut.configure(journey: journey(revision: sameRevision ? 1 : 2), session: UUID(), offline: false)
            provider.release(); await save.value
            XCTAssertNil(storage.data); XCTAssertNil(sut.bundle); XCTAssertFalse(sut.isSaving)
        }
    }
    func testCancelAndGoingOfflineStopObsoleteRequestsRetainingPriorRoutes() async throws {
        for goOffline in [true, false] {
            let storage = MemoryWalkingStorage(), provider = RecordingWalkingRouting(), trip = journey(), session = UUID()
            let sut = controller(storage, provider); sut.configure(journey: trip, session: session, offline: false)
            await sut.load(trip.legs[0], simulated: false, journey: trip)
            let original = storage.data
            provider.hold = true
            let save = Task { await sut.saveForOffline() }; try await waitFor { provider.requests.count == 2 }
            if goOffline { sut.configure(journey: trip, session: session, offline: true) } else { sut.cancelSaving() }
            provider.release(); await save.value
            XCTAssertEqual(storage.data, original); XCTAssertEqual(sut.bundle?.routes.count, 1)
            XCTAssertEqual(provider.requests.count, 2); XCTAssertFalse(sut.isSaving)
        }
    }
    func testPartialFailureRetryFetchesOnlyMissingLegAndKeepsDates() async {
        let storage = MemoryWalkingStorage(), provider = RecordingWalkingRouting(), trip = journey()
        provider.failIDs = ["transfer"]
        let sut = controller(storage, provider); sut.configure(journey: trip, session: UUID(), offline: false)
        await sut.saveForOffline()
        XCTAssertEqual(sut.bundle?.routes.count, 2)
        let accessDate = sut.bundle?.routes.first { $0.leg.id == "access" }?.fetchedAt
        provider.failIDs = []; await sut.saveForOffline()
        XCTAssertEqual(provider.requests.map(\.id), ["access", "transfer", "final", "transfer"])
        XCTAssertEqual(sut.bundle?.routes.count, 3)
        XCTAssertEqual(sut.bundle?.routes.first { $0.leg.id == "access" }?.fetchedAt, accessDate)
    }
    func testAtomicWriteFailurePreservesPreviousBundleAndSavedStatus() async throws {
        let storage = MemoryWalkingStorage(), provider = RecordingWalkingRouting(), trip = journey()
        let sut = controller(storage, provider); sut.configure(journey: trip, session: UUID(), offline: false)
        await sut.load(trip.legs[0], simulated: false, journey: trip)
        let original = storage.data; storage.failWrites = true
        await sut.saveForOffline()
        XCTAssertEqual(storage.data, original); XCTAssertEqual(sut.bundle?.routes.count, 1)
        XCTAssertEqual(sut.rows().filter { $0.status == .saved }.count, 1)
        XCTAssertTrue(sut.saveStatus?.contains("Could not save") == true)
    }
    func testCorruptTruncatedWrongVersionAndOversizedCacheDegradeWithoutNetwork() async throws {
        let trip = journey()
        let valid = try JSONEncoder().encode(WalkingBundle(identity: WalkingBundleIdentity(trip), routes: [RecordingWalkingRouting.detail(trip.legs[0])]))
        var wrong = try XCTUnwrap(JSONSerialization.jsonObject(with: valid) as? [String: Any]); wrong["version"] = 999
        for data in [Data("{".utf8), valid.prefix(valid.count / 2), try JSONSerialization.data(withJSONObject: wrong), Data(repeating: 0, count: WalkingBundle.maximumBytes + 1)] {
            let storage = MemoryWalkingStorage(); storage.data = data
            let provider = RecordingWalkingRouting(); provider.failAll = true
            let sut = controller(storage, provider); sut.configure(journey: trip, session: UUID(), offline: true)
            await sut.load(trip.legs[0], simulated: false, offline: true, journey: trip)
            XCTAssertNil(sut.snapshot); XCTAssertNil(sut.bundle); XCTAssertTrue(provider.requests.isEmpty)
            XCTAssertEqual(storage.data, data)
        }
    }
    func testExpiredAndFutureDatesAreVisibleButNeverUsedOrRefreshedOnRead() async throws {
        let trip = journey(), now = Date(), storage = MemoryWalkingStorage(), provider = RecordingWalkingRouting()
        let old = RecordingWalkingRouting.detail(trip.legs[0], at: now.addingTimeInterval(-86_401))
        let future = RecordingWalkingRouting.detail(trip.legs[1], at: now.addingTimeInterval(3_600))
        storage.data = try JSONEncoder().encode(WalkingBundle(identity: WalkingBundleIdentity(trip), routes: [old, future]))
        let original = storage.data, sut = controller(storage, provider)
        sut.configure(journey: trip, session: UUID(), offline: true)
        XCTAssertEqual(sut.rows(at: now).map(\.status), [.expired, .invalid, .unavailable])
        for leg in trip.legs { await sut.load(leg, simulated: false, offline: true, journey: trip); XCTAssertNil(sut.snapshot) }
        XCTAssertEqual(storage.data, original); XCTAssertTrue(provider.requests.isEmpty)
    }
    func testCurrentPositionRerouteAndPreviewCannotOverwriteActivePlannedBundle() async {
        let trip = journey(), storage = MemoryWalkingStorage(), provider = RecordingWalkingRouting()
        let sut = controller(storage, provider); sut.configure(journey: trip, session: UUID(), offline: false)
        await sut.saveForOffline(); let original = storage.data
        await sut.load(trip.legs[0], simulated: false, from: CLLocationCoordinate2D(latitude: 46.952, longitude: 7.445), journey: trip)
        XCTAssertEqual(storage.data, original); XCTAssertEqual(provider.origins.last??.longitude, 7.445)
        let preview = journey("alternative")
        await sut.load(preview.legs[0], simulated: false, journey: preview)
        XCTAssertEqual(storage.data, original); XCTAssertEqual(sut.bundle?.identity.journeyID, trip.id)
        await sut.load(trip.legs[2], simulated: false, offline: true, journey: trip)
        XCTAssertTrue(sut.usingSavedRoute); XCTAssertEqual(sut.snapshot?.leg.id, "final")
    }
    func testMissingGeometryOversizedPathAndRequestLimits() async {
        let walks = (0..<15).map { walk("walk-\($0)", offset: Double($0) * 0.001) }
        let trip = journey(walks: walks), storage = MemoryWalkingStorage(), provider = RecordingWalkingRouting()
        provider.emptyIDs = ["walk-0"]; provider.oversizedIDs = ["walk-1"]
        let sut = controller(storage, provider); sut.configure(journey: trip, session: UUID(), offline: false)
        await sut.saveForOffline()
        XCTAssertEqual(provider.requests.count, 12); XCTAssertEqual(provider.maximumConcurrent, 1)
        XCTAssertEqual(sut.bundle?.routes.count, 10)
        XCTAssertEqual(sut.rows().suffix(3).map(\.status), [.limit, .limit, .limit])
        XCTAssertNil(sut.bundle?.route(for: walks[0], at: Date())); XCTAssertNil(sut.bundle?.route(for: walks[1], at: Date()))
    }
    func testLateForegroundCompletionCannotReplaceNewRevisionDisplay() async throws {
        let storage = MemoryWalkingStorage(), provider = RecordingWalkingRouting(), trip = journey()
        provider.hold = true
        let sut = controller(storage, provider); sut.configure(journey: trip, session: UUID(), offline: false)
        let request = Task { await sut.load(trip.legs[0], simulated: false, journey: trip) }
        try await waitFor { provider.requests.count == 1 }
        let next = journey(revision: 2)
        sut.configure(journey: next, session: UUID(), offline: false)
        provider.release(); await request.value
        XCTAssertNil(sut.snapshot); XCTAssertNil(storage.data)
        provider.hold = false
        await sut.load(next.legs[2], simulated: false, journey: next)
        XCTAssertEqual(sut.snapshot?.leg.id, "final"); XCTAssertEqual(sut.bundle?.identity.revision, 2)
    }
    func testSavingDuringPreviewNeverReplacesDisplayedAlternativeOrRequestsRefresh() async {
        let storage = MemoryWalkingStorage(), provider = RecordingWalkingRouting(), trip = journey(), preview = journey("preview")
        let sut = controller(storage, provider); sut.configure(journey: trip, session: UUID(), offline: false)
        await sut.load(preview.legs[0], simulated: false, journey: preview)
        let displayed = sut.snapshot, refresh = sut.refreshID
        await sut.saveForOffline()
        XCTAssertEqual(sut.snapshot, displayed); XCTAssertEqual(sut.refreshID, refresh)
        XCTAssertEqual(provider.requests.count, 4); XCTAssertEqual(sut.bundle?.routes.count, 3)
    }
    func testLegacyMigrationOnlyAdoptsExactMatchingLegAndPreservesDate() async throws {
        let trip = journey(), date = Date().addingTimeInterval(-600), storage = MemoryWalkingStorage(), provider = RecordingWalkingRouting()
        let legacy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: legacy) }
        try JSONEncoder().encode(RecordingWalkingRouting.detail(trip.legs[1], at: date)).write(to: legacy)
        let sut = WalkingRouteController(cacheURL: legacy, storage: storage, routing: provider)
        sut.configure(journey: trip, session: UUID(), offline: true)
        XCTAssertEqual(sut.bundle?.routes.count, 1); XCTAssertEqual(sut.bundle?.routes.first?.fetchedAt, date)
        await sut.load(trip.legs[1], simulated: false, offline: true, journey: trip)
        XCTAssertTrue(sut.usingSavedRoute); XCTAssertTrue(provider.requests.isEmpty)
    }
    func testConsumersRejectPreviousContextBeforeAsyncReloadRuns() async {
        let trip = journey(), storage = MemoryWalkingStorage(), provider = RecordingWalkingRouting()
        let sut = controller(storage, provider)
        sut.configure(journey: trip, session: UUID(), offline: false)
        await sut.load(trip.legs[0], simulated: false, journey: trip)
        XCTAssertNotNil(sut.displayedSnapshot(for: trip, leg: trip.legs[0]))
        // These views can render before configure/load for their new context executes.
        for next in [journey("return"), journey(revision: 2), journey(walks: [walk("access", offset: 0.5)])] {
            XCTAssertEqual(sut.legID, next.legs[0].id) // The old ID-only consumer gate admits this.
            XCTAssertNotNil(sut.snapshot)
            XCTAssertNil(sut.displayedSnapshot(for: next))
            XCTAssertNil(sut.displayedSnapshot(for: next, leg: next.legs[0]))
        }
        XCTAssertNil(sut.displayedSnapshot(for: nil))
    }
    func testConsumersRequireExactLegAndFreshSnapshotIncludingTransferDuration() async throws {
        let trip = journey(), storage = MemoryWalkingStorage(), provider = RecordingWalkingRouting()
        let sut = controller(storage, provider)
        sut.configure(journey: trip, session: UUID(), offline: false)
        await sut.load(trip.legs[1], simulated: false, journey: trip)
        let fetched = try XCTUnwrap(sut.snapshot?.fetchedAt)
        XCTAssertNotNil(sut.displayedSnapshot(for: trip, leg: trip.legs[1], at: fetched))
        XCTAssertNil(sut.displayedSnapshot(for: trip, leg: walk("transfer", offset: 0.5), at: fetched))
        XCTAssertNil(sut.displayedSnapshot(for: trip, leg: trip.legs[0], at: fetched))
        for date in [fetched.addingTimeInterval(86_401), fetched.addingTimeInterval(-1)] {
            XCTAssertNil(sut.displayedSnapshot(for: trip, at: date))
            XCTAssertNil(sut.displayedSnapshot(for: trip, leg: trip.legs[1], at: date)?.expectedSeconds)
        }
    }
    func testCorrectPreviewAndCurrentPositionRoutesRemainVisibleOnlyInTheirContext() async {
        let trip = journey(), preview = journey("preview"), storage = MemoryWalkingStorage(), provider = RecordingWalkingRouting()
        let sut = controller(storage, provider)
        sut.configure(journey: trip, session: UUID(), offline: false)
        await sut.load(preview.legs[0], simulated: false, journey: preview)
        XCTAssertNotNil(sut.displayedSnapshot(for: preview, leg: preview.legs[0]))
        XCTAssertNil(sut.displayedSnapshot(for: trip, leg: trip.legs[0]))
        await sut.load(trip.legs[0], simulated: false,
            from: CLLocationCoordinate2D(latitude: 46.952, longitude: 7.445), journey: trip)
        XCTAssertNotNil(sut.displayedSnapshot(for: trip, leg: trip.legs[0]))
        XCTAssertNil(sut.displayedSnapshot(for: preview))
    }
}

@MainActor private final class MemoryWalkingStorage: WalkingBundleStorage {
    var data: Data?
    var failWrites = false
    func read() throws -> Data? { data }
    func write(_ data: Data) throws {
        if failWrites { throw NativeCoreError.message("Controlled disk failure") }
        self.data = data
    }
}
@MainActor private final class RecordingWalkingRouting: WalkingRouting {
    var requests: [Leg] = []
    var origins: [CLLocationCoordinate2D?] = []
    var failIDs = Set<String>(), emptyIDs = Set<String>(), oversizedIDs = Set<String>()
    var failAll = false, hold = false
    var maximumConcurrent = 0
    private var concurrent = 0
    private var pending: CheckedContinuation<Void, Never>?
    func release() { pending?.resume(); pending = nil }
    func fetch(leg: Leg, from: CLLocationCoordinate2D?) async throws -> WalkingRouteResult {
        requests.append(leg); origins.append(from); concurrent += 1; maximumConcurrent = max(maximumConcurrent, concurrent)
        defer { concurrent -= 1 }
        if hold { await withCheckedContinuation { pending = $0 } } // deliberately ignores cancellation to exercise late-result guard
        if failAll || failIDs.contains(leg.id) { throw NativeCoreError.message("Controlled routing failure") }
        let detail = Self.detail(leg, coordinates: emptyIDs.contains(leg.id) ? [] : oversizedIDs.contains(leg.id) ? Array(repeating: [7.44, 46.95], count: 4_001) : nil)
        return WalkingRouteResult(snapshot: detail, route: nil)
    }
    static func detail(_ leg: Leg, at date: Date = Date().addingTimeInterval(-300), coordinates: [[Double]]? = nil) -> WalkingRouteSnapshot {
        WalkingRouteSnapshot(leg: leg, coordinates: coordinates ?? [leg.from.coordinate!, leg.to.coordinate!],
            steps: [WalkingStep(id: 0, instruction: "Follow physical sign for \(leg.id)", distance: 76, endDistance: 76)],
            distance: 76, expectedSeconds: 90, fetchedAt: date)
    }
}
