import XCTest
@testable import RightSide

private enum OJPFixtures {
    static var root: URL {
        if let path = ProcessInfo.processInfo.environment["A5_PROVIDER_FIXTURES"] { return URL(fileURLWithPath: path) }
        if let url = Bundle(for: OJPServiceTests.self).url(forResource: "OJP", withExtension: nil) { return url }
        return URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/OJP")
    }
    static func data(_ name: String) throws -> Data { try Data(contentsOf: root.appendingPathComponent(name)) }
    static func response(_ name: String, syntheticNow: Date? = nil) throws -> OJPResponseData {
        let metadata = try JSONDecoder().decode(JSONValue.self, from: data(name + "-provenance.json"))
        var bytes = try data(name + ".xml")
        if let now = syntheticNow {
            // Explicit synthetic response-generation timestamp, never overwrite source artifacts.
            let raw = String(decoding: bytes, as: UTF8.self)
            bytes = Data(raw.replacingOccurrences(of: "(<(?:[A-Za-z]+:)?ResponseTimestamp>)[^<]+", with: "$1" + OJPIdentity.requestTime(now), options: .regularExpression).utf8)
        }
        return OJPResponseData(data: bytes, acquiredAt: syntheticNow ?? WireClock.date(metadata["acquiredAt"].string!)!, httpDate: metadata["responseDate"].string)
    }
    static func place(_ id: String, _ name: String) throws -> Place {
        try XCTUnwrap(DepartureStop.place(.object(["id": .string(id), "name": .string(name), "coordinate": .object(["x": .number(46.95), "y": .number(7.44)])]), acquiredAt: Date(timeIntervalSince1970: 1795243200)))
    }
    static func journey() throws -> Journey {
        try OJPJourneyAdapter.journeys(response("trip"), origin: place("8571359", "Bern, Länggasse"), destination: place("8589002", "Bern, Saali"), departure: WireClock.date("2026-11-21T06:50:18Z")!, arriveBy: false, preferences: .object(["stepFree": .bool(false), "maxWalkMeters": .null, "language": .string("en")]))[0]
    }
    static func services(_ journey: Journey, syntheticNow: Date? = nil) throws -> [OJPServiceSnapshot] {
        try OJPServiceUpdate.occurrences(in: journey).enumerated().map { index, identity in
            let response = try response("service-\(index)", syntheticNow: syntheticNow)
            return try OJPDecoder.service(data: response.data, occurrence: identity, acquiredAt: response.acquiredAt, httpDate: response.httpDate)
        }
    }
    static func changed(_ snapshot: OJPServiceSnapshot, at index: Int, field: String, value: JSONValue) throws -> OJPServiceSnapshot {
        var raw = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(snapshot))
        var calls = raw["calls"].array; calls[index][field] = value; raw["calls"] = .array(calls)
        return try JSONDecoder().decode(OJPServiceSnapshot.self, from: JSONEncoder().encode(raw))
    }
}
private actor TestOJPTransport: OJPTransport {
    let deferred: Bool
    var requests: [Data] = []
    var pending: [Int: CheckedContinuation<OJPResponseData, Error>] = [:]
    var mutation: String?
    init(deferred: Bool = false, mutation: String? = nil) { self.deferred = deferred; self.mutation = mutation }
    func send(_ xml: Data) async throws -> OJPResponseData {
        let index = requests.count; requests.append(xml)
        if deferred { return try await withCheckedThrowingContinuation { pending[index] = $0 } }
        return try response(xml)
    }
    private func response(_ xml: Data) throws -> OJPResponseData {
        let request = String(decoding: xml, as: UTF8.self)
        if request.contains("OJPTripRequest") { return try OJPFixtures.response("trip", syntheticNow: Date()) }
        let index = request.contains("ojp-92-20.1.TA.1071.j26") ? 0 : 1
        var value = try OJPFixtures.response("service-\(index)", syntheticNow: Date())
        if let mutation, index == 0 {
            var xml = String(decoding: value.data, as: UTF8.self)
            if mutation == "platform" {
                xml = xml.replacingOccurrences(of: "<Order>1</Order>", with: "<EstimatedQuay><Text>Changed test label</Text></EstimatedQuay><Order>1</Order>")
            }
            if mutation == "wrongDay" { xml = xml.replacingOccurrences(of: "<OperatingDayRef>2026-11-21</OperatingDayRef>", with: "<OperatingDayRef>2026-11-20</OperatingDayRef>") }
            if mutation == "changedPoint" { xml = xml.replacingOccurrences(of: "ch:1:sloid:71359:0:626", with: "ch:1:sloid:71359:0:999") }
            value = OJPResponseData(data: Data(xml.utf8), acquiredAt: value.acquiredAt)
        }
        return value
    }
    func wait(_ count: Int) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while requests.count < count {
            guard ContinuousClock.now < deadline else { throw OJPError.invalid("Test request missing") }
            await Task.yield()
        }
    }
    func finish(_ index: Int, fail: Bool = false) throws {
        let continuation = pending.removeValue(forKey: index)!
        if fail { continuation.resume(throwing: OJPError.unavailable("Synthetic network failure")) }
        else { continuation.resume(returning: try response(requests[index])) }
    }
}

final class OJPServiceTests: XCTestCase {
    private func now(_ snapshots: [OJPServiceSnapshot]) -> Date { snapshots.map(\.source.acquiredAt).max()! }
    @MainActor private func store(_ transport: any OJPTransport = TestOJPTransport()) throws -> (JourneyStore, URL) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ojp-test-\(UUID()).json")
        let store = JourneyStore(cacheURL: url, ojpTransport: transport)
        store.start(try OJPFixtures.journey()); XCTAssertNil(store.error)
        return (store, url)
    }
    @MainActor func testActualProviderTransferItineraryValidatesWithPreservedNames() throws {
        let journey = try OJPFixtures.journey()
        XCTAssertEqual(journey.legs.filter { $0.kind == "ride" }.map(\.line), ["20", "8"])
        XCTAssertTrue(journey.legs.contains { $0.kind == "transfer" })
        XCTAssertNoThrow(try DomainBridge().call("validateJourney", .object(["journey": journey.raw])))
        XCTAssertEqual(journey.origin.name, "Bern, Länggasse")
        XCTAssertTrue(journey.legs.filter { $0.kind == "ride" }.allSatisfy { $0.calls.allSatisfy { $0.raw["stopSequence"] == .null } })
        XCTAssertEqual(journey.raw["ojpSource"]["sha256"].string, "baabc4d73441a5f5590210ebceeff376889bff8a4af7861603d5736e6c7825a0")
    }
    @MainActor func testActualFullServiceOrderOffsetIsNotLegOrder() throws {
        let journey = try OJPFixtures.journey(), services = try OJPFixtures.services(journey)
        XCTAssertEqual(services.map { $0.calls.count }, [15,27])
        let update = try OJPServiceUpdate.reconcile(journey: journey, snapshots: services, now: now(services))
        let updated = try XCTUnwrap(update.journey)
        XCTAssertNoThrow(try DomainBridge().call("validateJourney", .object(["journey": updated.raw])))
        let tram = updated.legs.filter { $0.kind == "ride" }[1]
        XCTAssertEqual(tram.calls.map { Int($0.raw["stopSequence"].double!) }, Array(17...27))
        XCTAssertEqual(tram.calls.map { Int($0.raw["ojp"]["legOrder"].double!) }, Array(1...11))
        XCTAssertEqual(tram.calls.map(\.id), journey.legs.filter { $0.kind == "ride" }[1].calls.map(\.id))
        XCTAssertEqual(updated.revision, 1)
    }
    func testExactOccurrenceDayAndNamespaceRequired() throws {
        let journey = try OJPFixtures.journey(), occurrence = try OJPServiceUpdate.occurrences(in: journey)[0], response = try OJPFixtures.response("service-0")
        for wrong in [OJPOccurrence(provider: occurrence.provider, journeyRef: "other", operatingDay: occurrence.operatingDay), OJPOccurrence(provider: occurrence.provider, journeyRef: occurrence.journeyRef, operatingDay: "2026-11-20"), OJPOccurrence(provider: "national-ojp", journeyRef: occurrence.journeyRef, operatingDay: occurrence.operatingDay)] {
            XCTAssertThrowsError(try OJPDecoder.service(data: response.data, occurrence: wrong, acquiredAt: response.acquiredAt, httpDate: nil))
        }
        let wrongNamespace = Data(String(decoding: response.data, as: UTF8.self).replacingOccurrences(of: OJPXML.siri, with: "http://invalid/siri").utf8)
        XCTAssertThrowsError(try OJPDecoder.service(data: wrongNamespace, occurrence: occurrence, acquiredAt: response.acquiredAt, httpDate: nil))
    }
    func testXMLRejectsDTDEntitiesDepthSizeAndDuplicateFields() throws {
        for xml in ["<!DOCTYPE OJP [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><OJP/>", "<OJP xmlns='\(OJPXML.ojp)' version='2.0'>" + String(repeating: "<x>", count: 40) + String(repeating: "</x>", count: 40) + "</OJP>", String(repeating: "x", count: 2_000_001)] {
            XCTAssertThrowsError(try OJPXML.parse(Data(xml.utf8)))
        }
        let node = try OJPXML.parse(Data("<OJP xmlns='\(OJPXML.ojp)' version='2.0'><JourneyRef>A</JourneyRef><JourneyRef>B</JourneyRef></OJP>".utf8))
        XCTAssertThrowsError(try node.required("JourneyRef"))
    }
    func testSourceDateCannotBeFreshenedByHTTPDateOrAcquisition() throws {
        let response = try OJPFixtures.response("service-0"), journey = try OJPFixtures.journey(), occurrence = try OJPServiceUpdate.occurrences(in: journey)[0]
        for received in [response.acquiredAt.addingTimeInterval(91), response.acquiredAt.addingTimeInterval(-91)] {
            XCTAssertThrowsError(try OJPDecoder.service(data: response.data, occurrence: occurrence, acquiredAt: received, httpDate: "now"))
        }
        let snapshot = try OJPFixtures.services(journey)[0]
        XCTAssertEqual(snapshot.source.raw["observationTime"], .null)
        XCTAssertFalse(snapshot.source.recent(at: snapshot.source.acquiredAt.addingTimeInterval(91)))
    }
    func testStrictCalendarAndRequestNormalization() throws {
        for invalid in ["2026-02-30T01:00:00Z", "2026-11-21T24:00:00Z", "2026-11-21T00:00:00+15:00", "2026-11-21T00:00:00+00:99", "yesterday"] { XCTAssertThrowsError(try OJPIdentity.date(invalid)) }
        let first = try XCTUnwrap(OJPIdentity.date("2026-10-25T02:30:00+02:00")), second = try XCTUnwrap(OJPIdentity.date("2026-10-25T02:30:00+01:00"))
        XCTAssertEqual(second.timeIntervalSince(first), 3600)
        let occurrence = OJPOccurrence(provider: OJPIdentity.provider, journeyRef: "night-service", operatingDay: "2026-10-24")
        let request = String(decoding: try OJPRequest.service(occurrence, now: second), as: UTF8.self)
        XCTAssertTrue(request.contains("<OperatingDayRef>2026-10-24</OperatingDayRef>")); XCTAssertTrue(request.contains("2026-10-25T01:30:00Z"))
    }
    func testHistoricalProviderArrivalBugRejectedAndUTCControlWorks() throws {
        let origin = Place(raw: .object(["id": .string("coordinate-origin"), "name": .string("START"), "kind": .string("coordinate"), "coordinate": .array([.number(7.4263), .number(46.9575)]), "parentId": .null, "sourceRefs": .array([]), "evidence": .array([])]))
        let destination = try OJPFixtures.place("8589002", "Bern, Saali"), preferences: JSONValue = .object(["stepFree": .bool(false), "maxWalkMeters": .null, "language": .string("en")])
        XCTAssertThrowsError(try OJPJourneyAdapter.journeys(OJPFixtures.response("coordinate-arrive"), origin: origin, destination: destination, departure: WireClock.date("2026-11-21T07:45:05Z")!, arriveBy: true, preferences: preferences))
        let journeys = try OJPJourneyAdapter.journeys(OJPFixtures.response("coordinate-arrive-z"), origin: origin, destination: destination, departure: WireClock.date("2026-11-21T07:45:05Z")!, arriveBy: true, preferences: preferences)
        XCTAssertFalse(journeys.isEmpty); XCTAssertEqual(journeys[0].legs[0].geometry?.quality, "routed")
        XCTAssertEqual(journeys[0].origin.id, origin.id)
    }
    func testChangedPointCannotJoinBySameNameOrParent() throws {
        let journey = try OJPFixtures.journey(); var snapshots = try OJPFixtures.services(journey)
        snapshots[0] = try OJPFixtures.changed(snapshots[0], at: 0, field: "stopPointRef", value: .string("ch:1:sloid:71359:0:999"))
        let update = try OJPServiceUpdate.reconcile(journey: journey, snapshots: snapshots, now: now(snapshots))
        XCTAssertNil(update.journey); XCTAssertTrue(update.report.requiresRecovery)
        XCTAssertEqual(update.report.changes[0].selectedServiceOrders, [])
    }
    func testShiftedTimetableCannotJoinByOrder() throws {
        let journey = try OJPFixtures.journey(); var snapshots = try OJPFixtures.services(journey)
        let old = snapshots[0].calls[0].plannedDeparture!
        snapshots[0] = try OJPFixtures.changed(snapshots[0], at: 0, field: "plannedDeparture", value: .number(old.addingTimeInterval(1).timeIntervalSinceReferenceDate))
        XCTAssertNil(try OJPServiceUpdate.reconcile(journey: journey, snapshots: snapshots, now: now(snapshots)).journey)
    }
    func testRepeatedStopAndIdenticalTimeAmbiguityAbstains() throws {
        let journey = try OJPFixtures.journey(), service = try OJPFixtures.services(journey)[0], call = service.calls[0]
        var raw = journey.legs.first { $0.kind == "ride" }!.raw
        let original = raw["calls"].array[0]; raw["calls"] = .array([original, original])
        let repeated = (1...3).map { index in OJPServiceCall(order: index, stopPointRef: call.stopPointRef, parentRef: call.parentRef, name: call.name, coordinate: call.coordinate, plannedArrival: call.plannedArrival, plannedDeparture: call.plannedDeparture, expectedArrival: nil, expectedDeparture: nil, plannedQuay: nil, estimatedQuay: nil, notServiced: nil, noBoarding: nil, noAlighting: nil) }
        let snapshot = OJPServiceSnapshot(occurrence: service.occurrence, source: service.source, line: service.line, destination: service.destination, direction: service.direction, cancelled: nil, calls: repeated)
        XCTAssertNil(OJPServiceUpdate.matchingRange(leg: Leg(raw: raw), snapshot: snapshot))
    }
    func testIntendedAlightingRestrictionRequiresRecoveryButLaterCallDoesNot() throws {
        let journey = try OJPFixtures.journey(), source = try OJPFixtures.services(journey)
        for flag in ["notServiced", "noAlighting"] {
            var snapshots = source; snapshots[0] = try OJPFixtures.changed(source[0], at: 5, field: flag, value: .bool(true))
            XCTAssertTrue(try OJPServiceUpdate.reconcile(journey: journey, snapshots: snapshots, now: now(snapshots)).report.requiresRecovery)
            snapshots[0] = try OJPFixtures.changed(source[0], at: 14, field: flag, value: .bool(true))
            XCTAssertNotNil(try OJPServiceUpdate.reconcile(journey: journey, snapshots: snapshots, now: now(snapshots)).journey)
        }
    }
    func testForbiddenPickupAndCancellationNeverRetainPositive() throws {
        let journey = try OJPFixtures.journey(); var source = try OJPFixtures.services(journey)
        source[0] = try OJPFixtures.changed(source[0], at: 0, field: "noBoarding", value: .bool(true))
        XCTAssertNil(try OJPServiceUpdate.reconcile(journey: journey, snapshots: source, now: now(source)).journey)
        let old = source[1]
        source[1] = OJPServiceSnapshot(occurrence: old.occurrence, source: old.source, line: old.line, destination: old.destination, direction: old.direction, cancelled: true, calls: old.calls)
        XCTAssertTrue(try OJPServiceUpdate.reconcile(journey: journey, snapshots: source, now: now(source)).report.changes[1].status == .requiresRecovery)
    }
    func testIncompleteOrDuplicateSetCannotPartlyRefresh() throws {
        let journey = try OJPFixtures.journey(), source = try OJPFixtures.services(journey)
        for invalid in [[source[0]], [source[0],source[0]]] { XCTAssertThrowsError(try OJPServiceUpdate.reconcile(journey: journey, snapshots: invalid, now: now(source))) }
    }
    @MainActor func testSuccessfulUpdatePreservesSessionAndManualStepAndCachesReport() async throws {
        let (store, file) = try store(); defer { try? FileManager.default.removeItem(at: file) }
        let session = store.navigationSessionID, before = try XCTUnwrap(store.navigation)
        await store.updateServices()
        XCTAssertNil(store.serviceUpdateError); XCTAssertEqual(store.navigation?.journey.revision, 1)
        XCTAssertEqual(store.navigationSessionID, session); XCTAssertEqual(store.navigation?.legIndex, before.legIndex); XCTAssertEqual(store.navigation?.phase, before.phase)
        XCTAssertEqual(store.serviceReport?.changes.count, 2)
        let saved = try JourneyCache(url: file).load(bridge: DomainBridge())
        XCTAssertEqual(saved?.navigation, store.navigation?.raw)
    }
    @MainActor func testChangedAssignmentRetainsRouteClearsWaitingAndSuppressesContext() async throws {
        let (store, file) = try store(TestOJPTransport(mutation: "changedPoint")); defer { try? FileManager.default.removeItem(at: file) }
        let ride = try XCTUnwrap(store.navigation?.journey.legs.first { $0.kind == "ride" })
        store.correct(legId: ride.id, phase: "waiting", reason: "Test manual boarding area")
        let journey = store.navigation?.journey, session = store.navigationSessionID
        await store.updateServices()
        XCTAssertNil(store.serviceUpdateError); XCTAssertEqual(store.navigation?.journey, journey)
        XCTAssertTrue(store.serviceReport?.requiresRecovery == true); XCTAssertTrue(store.navigation?.overlays.disrupted == true)
        XCTAssertEqual(store.navigation?.phase, "approaching"); XCTAssertEqual(store.navigation?.raw["confirmations"]["waitingTargetId"], .null)
        XCTAssertEqual(store.navigationSessionID, session); XCTAssertFalse(store.boardingServiceEligible(for: ride))
    }
    @MainActor func testWrongDayLeavesNavigationAndCacheUnchanged() async throws {
        let (store, file) = try store(TestOJPTransport(mutation: "wrongDay")); defer { try? FileManager.default.removeItem(at: file) }
        let before = store.navigation?.raw, bytes = try Data(contentsOf: file)
        await store.updateServices()
        XCTAssertNotNil(store.serviceUpdateError); XCTAssertNotNil(store.serviceFailureAt)
        XCTAssertEqual(store.navigation?.raw, before); XCTAssertEqual(try Data(contentsOf: file), bytes); XCTAssertNil(store.serviceReport)
    }
    @MainActor func testLateResponseAfterSameIDRestartCannotPublish() async throws {
        let transport = TestOJPTransport(deferred: true), (store, file) = try store(transport); defer { try? FileManager.default.removeItem(at: file) }
        let journey = try XCTUnwrap(store.navigation?.journey), oldSession = store.navigationSessionID
        let work = Task { await store.updateServices() }; try await transport.wait(1)
        store.start(journey); let before = store.navigation?.raw
        try await transport.finish(0); await work.value
        XCTAssertNotEqual(store.navigationSessionID, oldSession); XCTAssertEqual(store.navigation?.raw, before); XCTAssertNil(store.serviceReport)
    }
    @MainActor func testLateResponseAfterRestoreCannotPublish() async throws {
        let transport = TestOJPTransport(deferred: true), (store, file) = try store(transport); defer { try? FileManager.default.removeItem(at: file) }
        let work = Task { await store.updateServices() }; try await transport.wait(1)
        store.restore(); let before = store.navigation?.raw
        try await transport.finish(0); await work.value
        XCTAssertEqual(store.navigation?.raw, before); XCTAssertNil(store.serviceReport)
    }
    @MainActor func testLateResponseAfterOfflineCannotPublish() async throws {
        let transport = TestOJPTransport(deferred: true), (store, file) = try store(transport); defer { try? FileManager.default.removeItem(at: file) }
        let work = Task { await store.updateServices() }; try await transport.wait(1)
        store.setOffline(true); let before = store.navigation?.raw
        try await transport.finish(0); await work.value
        XCTAssertEqual(store.navigation?.raw, before); XCTAssertFalse(store.updatingServices)
    }
    @MainActor func testCancelledPresentationCannotPublishLateResponse() async throws {
        let transport = TestOJPTransport(deferred: true), (store, file) = try store(transport); defer { try? FileManager.default.removeItem(at: file) }
        let before = store.navigation?.raw, work = Task { await store.updateServices() }; try await transport.wait(1)
        work.cancel(); try await transport.finish(0); await work.value
        XCTAssertEqual(store.navigation?.raw, before); XCTAssertNil(store.serviceReport); XCTAssertFalse(store.updatingServices)
    }
    @MainActor func testNewerUpdateWinsOutOfOrderResponses() async throws {
        let transport = TestOJPTransport(deferred: true), (store, file) = try store(transport); defer { try? FileManager.default.removeItem(at: file) }
        let old = Task { await store.updateServices() }; try await transport.wait(1)
        let new = Task { await store.updateServices() }; try await transport.wait(2)
        try await transport.finish(1); try await transport.wait(3); try await transport.finish(2); await new.value
        let before = store.navigation?.raw; XCTAssertEqual(store.navigation?.journey.revision, 1)
        try await transport.finish(0); await old.value
        XCTAssertEqual(store.navigation?.raw, before)
    }
    @MainActor func testPartialNetworkFailureIsAtomic() async throws {
        let transport = TestOJPTransport(deferred: true), (store, file) = try store(transport); defer { try? FileManager.default.removeItem(at: file) }
        let before = store.navigation?.raw, bytes = try Data(contentsOf: file)
        let work = Task { await store.updateServices() }; try await transport.wait(1); try await transport.finish(0)
        try await transport.wait(2); try await transport.finish(1, fail: true); await work.value
        XCTAssertNotNil(store.serviceUpdateError); XCTAssertEqual(store.navigation?.raw, before); XCTAssertEqual(try Data(contentsOf: file), bytes)
    }
    @MainActor func testPreviewCancelsUpdateWithoutMutation() async throws {
        let transport = TestOJPTransport(deferred: true), (store, file) = try store(transport); defer { try? FileManager.default.removeItem(at: file) }
        let work = Task { await store.updateServices() }; try await transport.wait(1)
        var preview = try OJPFixtures.journey().raw; preview["id"] = .string("preview")
        store.select(Journey(raw: preview)); let active = store.navigation?.raw
        try await transport.finish(0); await work.value
        XCTAssertEqual(store.navigation?.raw, active); XCTAssertEqual(store.selected?.id, "preview"); XCTAssertTrue(store.previewing)
    }
    @MainActor func testReturnDraftAndRecoveryKeepOJPSourceAndInvalidateInFlight() async throws {
        let transport = TestOJPTransport(deferred: true), (store, file) = try store(transport); defer { try? FileManager.default.removeItem(at: file) }
        let last = try XCTUnwrap(store.navigation?.journey.legs.last)
        store.correct(legId: last.id, phase: "arrived", reason: "Synthetic explicit arrival")
        XCTAssertTrue(store.canReturn)
        let work = Task { await store.updateServices() }; try await transport.wait(1)
        store.prepareReturn(); let before = store.navigation?.raw
        try await transport.finish(0); await work.value
        XCTAssertEqual(store.navigation?.raw, before); XCTAssertEqual(store.planningSource, .occurrenceOJP)
        XCTAssertEqual(store.planningDraft?.origin.id, store.navigation?.journey.destination.id)
        store.prepareRecovery(.disruption); XCTAssertEqual(store.planningSource, .occurrenceOJP)
    }
    @MainActor func testOfflineRestoreRetainsSourceDatesAndDoesNotReviveEligibility() async throws {
        let (store, file) = try store(); defer { try? FileManager.default.removeItem(at: file) }
        await store.updateServices(); let report = try XCTUnwrap(store.serviceReport)
        store.setOffline(true)
        let restored = JourneyStore(cacheURL: file); restored.restore()
        XCTAssertEqual(restored.serviceReport, report); XCTAssertEqual(restored.planningSource, .occurrenceOJP)
        XCTAssertTrue(restored.navigation?.overlays.offline == true)
        let ride = restored.navigation?.journey.legs.first { $0.kind == "ride" }
        XCTAssertFalse(restored.boardingServiceEligible(for: ride))
        restored.setOffline(false)
        XCTAssertFalse(restored.boardingServiceEligible(for: ride, at: report.acquiredAt.addingTimeInterval(91)))
    }
    @MainActor func testChangedQuayClearsWaitingWithoutInventingCurbOrAdvancingPassenger() async throws {
        let (store, file) = try store(TestOJPTransport(mutation: "platform")); defer { try? FileManager.default.removeItem(at: file) }
        let ride = try XCTUnwrap(store.navigation?.journey.legs.first { $0.kind == "ride" })
        store.correct(legId: ride.id, phase: "waiting", reason: "Synthetic manual confirmation")
        let index = store.navigation?.legIndex
        await store.updateServices()
        XCTAssertNil(store.serviceUpdateError); XCTAssertEqual(store.navigation?.journey.revision, 1)
        XCTAssertEqual(store.navigation?.legIndex, index); XCTAssertEqual(store.navigation?.phase, "approaching")
        XCTAssertEqual(store.navigation?.currentLeg.raw["boardingTarget"]["assignment"]["label"].string, "Changed test label")
        XCTAssertEqual(store.navigation?.currentLeg.raw["boardingTarget"]["pedestrianTargetStatus"].string, "unverified")
        XCTAssertEqual(store.navigation?.raw["confirmations"]["waitingTargetId"], .null)
    }
    @MainActor func testManualProgressDuringRequestRejectsPublication() async throws {
        let transport = TestOJPTransport(deferred: true), (store, file) = try store(transport); defer { try? FileManager.default.removeItem(at: file) }
        let work = Task { await store.updateServices() }; try await transport.wait(1)
        let ride = try XCTUnwrap(store.navigation?.journey.legs.first { $0.kind == "ride" })
        store.correct(legId: ride.id, phase: "riding", reason: "Synthetic explicit boarding")
        let before = store.navigation?.raw
        try await transport.finish(0); try await transport.wait(2); try await transport.finish(1); await work.value
        XCTAssertEqual(store.navigation?.raw, before); XCTAssertNotNil(store.serviceUpdateError)
    }
    @MainActor func testFreshEligibilityUsesActualSourceAndSuppressionFlags() async throws {
        let (store, file) = try store(); defer { try? FileManager.default.removeItem(at: file) }
        await store.updateServices(); XCTAssertNil(store.serviceUpdateError)
        let ride = try XCTUnwrap(store.navigation?.journey.legs.first { $0.kind == "ride" })
        let stamp = try XCTUnwrap(store.serviceReport?.acquiredAt)
        XCTAssertTrue(store.boardingServiceEligible(for: ride, at: stamp))
        XCTAssertFalse(store.boardingServiceEligible(for: ride, at: stamp.addingTimeInterval(91)))
        store.setOffline(true); XCTAssertFalse(store.boardingServiceEligible(for: ride, at: stamp))
    }
    @MainActor func testJSONJourneyNeverGetsGuessedOccurrenceOrNetworkRequest() async throws {
        let transport = TestOJPTransport(), (store, file) = try store(transport); defer { try? FileManager.default.removeItem(at: file) }
        var raw = try OJPFixtures.journey().raw, legs = raw["legs"].array
        for index in legs.indices where legs[index]["kind"].string == "ride" {
            legs[index]["trip"]["provider"] = .string("transport.opendata.ch")
            var calls = legs[index]["calls"].array
            for i in calls.indices { calls[i]["trip"] = legs[index]["trip"] }
            legs[index]["calls"] = .array(calls)
        }
        raw["legs"] = .array(legs); store.start(Journey(raw: raw)); let before = store.navigation?.raw
        XCTAssertEqual(store.planningSource, .communityJSON); await store.updateServices()
        XCTAssertNotNil(store.serviceUpdateError); XCTAssertEqual(store.navigation?.raw, before)
        let requests = await transport.requests; XCTAssertTrue(requests.isEmpty)
    }
    @MainActor func testNewPlanningProducesPreviewWithoutReplacingActiveJourney() async throws {
        let transport = TestOJPTransport(), (store, file) = try store(transport); defer { try? FileManager.default.removeItem(at: file) }
        let before = store.navigation?.raw
        store.origin = try OJPFixtures.place("8571359", "Bern, Länggasse"); store.destination = try OJPFixtures.place("8589002", "Bern, Saali")
        store.departure = WireClock.date("2026-11-21T06:50:18Z")!; store.planningSource = .occurrenceOJP
        await store.search()
        XCTAssertNil(store.error); XCTAssertFalse(store.alternatives.isEmpty); XCTAssertTrue(store.previewing)
        XCTAssertEqual(store.navigation?.raw, before)
    }
}
