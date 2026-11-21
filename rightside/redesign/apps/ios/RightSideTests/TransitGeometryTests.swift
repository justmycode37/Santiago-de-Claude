import XCTest
@testable import RightSide

final class TransitGeometryTests: XCTestCase {
    private let now = WireClock.date("2026-11-21T06:00:00Z")!
    private var point: [[Double]] { [[7.44,46.95],[7.441,46.95],[7.442,46.95]] }
    private func source(at time: String = "2026-11-21T05:00:00Z") -> TransitGeometrySource {
        TransitGeometrySource(file: "test.json", url: "https://api.openstreetmap.org/api/0.6/relation/1/full.json",
            sha256: String(repeating: "a", count: 64), acquiredAt: time, responseDate: time,
            responseDateBasis: "Synthetic test source observation", attribution: "Test fixture", licenceURL: "https://www.openstreetmap.org/copyright")
    }
    private func stop(_ index: Int) -> TransitCorridorStop {
        TransitCorridorStop(nodeID: Int64(index + 1), name: ["Bern, A","Bern, B","Bern, C"][index],
            uicName: nil, uicRef: String(8500001 + index), coordinate: point[index])
    }
    private func corridor(id: Int64 = 1, reversed: Bool = false, paths: [TransitCorridorPath]? = nil,
                          stops: [TransitCorridorStop]? = nil, timestamp: String = "2026-11-21T05:00:00Z", dates: [String:String] = [:]) -> TransitCorridor {
        var tags = ["type":"route","public_transport:version":"2","route":"tram","ref":"8","operator":"Bernmobil","network":"Libero","to": reversed ? "Bern, A" : "Bern, C","name":"Mapped test corridor"]
        tags.merge(dates) { _, new in new }
        let base = [stop(0),stop(1),stop(2)]
        return TransitCorridor(relationID: id, version: 4, modifiedAt: "2020-01-01T00:00:00Z", tags: tags,
            stops: stops ?? (reversed ? Array(base.reversed()) : base),
            paths: paths ?? [TransitCorridorPath(nodes: reversed ? [3,2,1] : [1,2,3], coordinates: reversed ? Array(point.reversed()) : point)], brokenWays: 0, source: source(at: timestamp))
    }
    private func leg(order: [Int] = [0,1,2], headsign: String = "Bern, C") -> Leg {
        let calls: [JSONValue] = order.enumerated().map { sequence, index in
            .object(["id":.string("call-\(sequence)"),"place":.object(["id":.string("place-\(index)"),"name":.string(stop(index).name),
                "coordinate":.array(point[index].map(JSONValue.number)),
                "sourceRefs":.array([.object(["provider":.string("transport.opendata.ch"),"id":.string(String(8500001 + index))])])])])
        }
        return Leg(raw: .object(["id":.string("ride"),"kind":.string("ride"),"mode":.string("tram"),"line":.string("8"),"headsign":.string(headsign),
            "plannedStart":.string("2026-11-21T10:00:00+01:00"),"plannedEnd":.string("2026-11-21T10:10:00+01:00"),
            "trip":.object(["provider":.string("transport.opendata.ch"),"operatingDate":.string("2026-11-21")]),
            "from":calls.first!["place"],"to":calls.last!["place"],"calls":.array(calls),
            "boardingCallId":.string("call-0"),"alightingCallId":.string("call-\(calls.count-1)")]))
    }
    private func editCall(_ raw: inout JSONValue, index: Int, edit: (inout JSONValue) -> Void) {
        var calls = raw["calls"].array; edit(&calls[index]); raw["calls"] = .array(calls)
    }
    private func journey(_ leg: Leg, id: String = "journey", revision: Int = 1) -> Journey {
        Journey(raw: .object(["id":.string(id),"revision":.number(Double(revision)),"legs":.array([leg.raw])]))
    }
    func testUniqueFullStopOrderAndOppositeDirection() {
        let resolver = TransitGeometryResolver(corridors: [corridor(),corridor(id:2,reversed:true)])
        let forward = resolver.resolve(leg(),at:now)
        XCTAssertEqual(forward.precision,.mappedCorridor); XCTAssertEqual(forward.relationID,1); XCTAssertEqual(forward.segments.count,2)
        let backward = resolver.resolve(leg(order:[2,1,0],headsign:"Bern, A"),at:now)
        XCTAssertEqual(backward.precision,.mappedCorridor); XCTAssertEqual(backward.relationID,2)
        XCTAssertTrue(resolver.resolve(leg(order:[2,1,0]),at:now).segments.isEmpty)
    }
    func testLineNumberAndEndpointOnlyCannotJoinWrongIntermediateStop() {
        var raw = leg().raw; editCall(&raw,index:1) { $0["place"]["sourceRefs"] = .array([.object(["provider":.string("transport.opendata.ch"),"id":.string("other")])]) }
        let result = TransitGeometryResolver(corridors:[corridor()]).resolve(Leg(raw:raw),at:now)
        XCTAssertEqual(result.precision,.schematic); XCTAssertTrue(result.segments.isEmpty)
    }
    func testDuplicateBranchAndRepeatedStopsAbstain() {
        XCTAssertEqual(TransitGeometryResolver(corridors:[corridor(),corridor(id:2)]).resolve(leg(),at:now).precision,.ambiguous)
        XCTAssertEqual(TransitGeometryResolver(corridors:[corridor()]).resolve(leg(order:[0,1,0],headsign:"Bern, A"),at:now).precision,.ambiguous)
        let ambiguousPath = TransitCorridorPath(nodes:[1,2,1,2,3],coordinates:[point[0],point[1],point[0],point[1],point[2]])
        XCTAssertTrue(TransitGeometryResolver(corridors:[corridor(paths:[ambiguousPath])]).resolve(leg(),at:now).segments.isEmpty)
    }
    func testMissingTopologyProducesGapRatherThanConnector() {
        let broken = corridor(paths:[TransitCorridorPath(nodes:[1,2],coordinates:[point[0],point[1]])])
        let result = TransitGeometryResolver(corridors:[broken]).resolve(leg(),at:now)
        XCTAssertEqual(result.precision,.partialCorridor); XCTAssertEqual(result.segments.count,1)
        XCTAssertEqual(result.segments[0].toCallID,"call-1")
    }
    func testAsymmetricRevisitCannotComposeBackwardOccurrenceIntervals() {
        let path = TransitCorridorPath(nodes: [2,3,1,2], coordinates: [point[1],point[2],point[0],point[1]])
        let result = TransitGeometryResolver(corridors: [corridor(paths: [path])]).resolve(leg(), at: now)
        XCTAssertEqual(result.precision, .ambiguous)
        XCTAssertTrue(result.segments.isEmpty)
        let control = TransitGeometryResolver(corridors: [corridor()]).resolve(leg(), at: now)
        XCTAssertEqual(control.precision, .mappedCorridor)
        XCTAssertEqual(control.segments.count, 2)
    }
    func testRepeatedOccurrenceCombinationsAbstainBeforeCoordinateCopies() {
        let ids: [Int64] = Array(repeating: [Int64(1),Int64(2)], count: 500).flatMap { $0 } + [Int64(3)]
        let coordinates = ids.map { point[Int($0) - 1] }
        let path = TransitCorridorPath(nodes: ids, coordinates: coordinates)
        let result = TransitGeometryResolver(corridors: [corridor(paths: [path])]).resolve(leg(), at: now)
        XCTAssertTrue(result.segments.isEmpty)
        XCTAssertEqual(result.precision, .unavailable)
    }
    func testGeometryTraversalAndOutputBudgetsFailBeforeAllocation() {
        let resolver = TransitGeometryResolver(corridors: [corridor()])
        XCTAssertEqual(resolver.resolve(leg(), at: now, maximumOutputPoints: 3).precision, .unavailable)
        XCTAssertEqual(resolver.resolve(leg(), at: now, maximumOutputPoints: 4).segments.count, 2)
        let path = TransitCorridorPath(nodes: Array(repeating: Int64(1), count: 20_000),
                                       coordinates: Array(repeating: point[0], count: 20_000))
        let oversized = TransitGeometryResolver(corridors: [corridor(paths: Array(repeating: path, count: 11))])
        XCTAssertEqual(oversized.resolve(leg(), at: now).precision, .unavailable)
    }
    @MainActor func testLegacyDerivedCacheCannotSurviveRepositoryArrival() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let trip = journey(leg()), repository = TransitGeometryRepository(corridors: [corridor()], sources: [source()])
        let snapshot = TransitGeometryResolver(corridors: repository.corridors).resolve(trip, sourceDigest: repository.digest, at: now)
        var legacy = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot)) as? [String: Any])
        legacy["version"] = 1
        try JSONSerialization.data(withJSONObject: legacy).write(to: file)
        let restored = TransitGeometryController(cacheURL: file), session = UUID()
        restored.update(active: trip, displayed: trip, session: session, repository: nil, now: now)
        XCTAssertNil(restored.resolution(for: trip, leg: leg(), at: now))
        restored.update(active: trip, displayed: trip, session: session, repository: repository, now: now)
        XCTAssertEqual(restored.resolution(for: trip, leg: leg(), at: now)?.segments.count, 2)
        let offline = TransitGeometryController(cacheURL: file)
        offline.update(active: trip, displayed: trip, session: UUID(), repository: nil, now: now)
        XCTAssertEqual(offline.resolution(for: trip, leg: leg(), at: now)?.segments.count, 2)
    }
    func testRepositoryDigestIncludesSourceMetadataAndResolverPolicy() {
        let first = TransitGeometryRepository(corridors: [corridor()], sources: [source()])
        let changedDate = TransitGeometryRepository(corridors: [corridor()], sources: [source(at: "2026-11-21T05:30:00Z")])
        XCTAssertNotEqual(first.digest, changedDate.digest)
        XCTAssertEqual(TransitJourneyGeometry.currentVersion, 2)
    }
    func testSourceFutureExpiredInvalidAndCalendarDatesFailClosed() {
        for stamp in ["2026-11-21T06:00:01Z","2026-09-01T00:00:00Z","118626"] {
            XCTAssertEqual(TransitGeometryResolver(corridors:[corridor(timestamp:stamp)]).resolve(leg(),at:now).precision,.stale)
        }
        for dates in [["start_date":"2026-12-01"],["end_date":"2026-11-20"],["start_date":"2026-02-30"]] {
            XCTAssertEqual(TransitGeometryResolver(corridors:[corridor(dates:dates)]).resolve(leg(),at:now).precision,.stale)
        }
        var raw=leg().raw;raw["trip"]["operatingDate"] = .string("2026-02-30")
        XCTAssertTrue(TransitGeometryResolver(corridors:[corridor()]).resolve(Leg(raw:raw),at:now).segments.isEmpty)
    }
    func testFreshSnapshotCannotAuthorizeDistantBoardingDate() {
        var raw=leg().raw;raw["plannedStart"] = .string("2027-02-01T10:00:00+01:00");raw["trip"]["operatingDate"] = .string("2027-02-01")
        XCTAssertEqual(TransitGeometryResolver(corridors:[corridor()]).resolve(Leg(raw:raw),at:now).precision,.stale)
    }
    func testCompleteDisplayedJourneyLegRevisionAssignmentGuard() {
        let first=journey(leg()), resolver=TransitGeometryResolver(corridors:[corridor()])
        let snapshot=resolver.resolve(first,sourceDigest:String(repeating:"a",count:64),at:now)
        XCTAssertNotNil(snapshot.resolution(for:first,leg:leg(),at:now))
        XCTAssertNil(snapshot.resolution(for:journey(leg(),id:"another"),leg:leg(),at:now))
        XCTAssertNil(snapshot.resolution(for:journey(leg(),revision:2),leg:leg(),at:now))
        var changed=leg().raw;editCall(&changed,index:0) { $0["currentAssignment"] = .object(["label":.string("K")]) }
        XCTAssertNil(snapshot.resolution(for:journey(Leg(raw:changed)),leg:Leg(raw:changed),at:now))
        XCTAssertEqual(snapshot.resolution(for:first,leg:leg(),at:now.addingTimeInterval(31*86_400))?.precision,.stale)
    }
    @MainActor func testRestartOfflinePreservesSourceDateAndPreviewCannotOverwriteCache() throws {
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:directory) }
        let file=directory.appendingPathComponent("cache.json"), first=journey(leg())
        let repository=TransitGeometryRepository(corridors:[corridor()],sources:[source()])
        let controller=TransitGeometryController(cacheURL:file)
        controller.update(active:first,displayed:first,session:UUID(),repository:repository,now:now)
        let original=try Data(contentsOf:file), date=controller.resolution(for:first,leg:leg(),at:now)?.source?.acquiredAt
        let preview=journey(leg(),id:"preview")
        controller.update(active:first,displayed:preview,session:UUID(),repository:repository,now:now)
        XCTAssertEqual(try Data(contentsOf:file),original)
        XCTAssertNil(controller.resolution(for:first,leg:leg(),at:now))
        let restored=TransitGeometryController(cacheURL:file)
        restored.update(active:first,displayed:first,session:UUID(),repository:nil,now:now)
        XCTAssertEqual(restored.resolution(for:first,leg:leg(),at:now)?.source?.acquiredAt,date)
        XCTAssertEqual(restored.resolution(for:first,leg:leg(),at:now)?.segments.count,2)
        XCTAssertEqual(try Data(contentsOf:file),original)
    }
    @MainActor func testCorruptCacheAndSameLabelsDifferentEndpointDoNotLeak() throws {
        let file=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at:file) }
        try Data("{truncated".utf8).write(to:file)
        let controller=TransitGeometryController(cacheURL:file), first=journey(leg())
        controller.update(active:first,displayed:first,session:UUID(),repository:nil,now:now)
        XCTAssertNil(controller.resolution(for:first,leg:leg(),at:now))
        var raw=leg().raw;editCall(&raw,index:1) { $0["place"]["coordinate"] = .array([.number(8.1),.number(47.1)]) }
        XCTAssertTrue(TransitGeometryResolver(corridors:[corridor()]).resolve(Leg(raw:raw),at:now).segments.isEmpty)
    }
    func testSourceRouteGeometryIsNotOverwrittenByCandidate() {
        var raw=leg().raw;raw["geometry"] = .object(["quality":.string("routed"),"coordinates":.array(point.map { .array($0.map(JSONValue.number)) })])
        let result=TransitGeometryResolver(corridors:[corridor()]).resolve(Leg(raw:raw),at:now)
        XCTAssertTrue(result.segments.isEmpty);XCTAssertTrue(result.reasons.joined().contains("retained unchanged"))
    }
    func testOrderedOSMWaysRejectMissingNodeAndClosedAmbiguousWay() throws {
        func node(_ id:Int,_ longitude:Double)->JSONValue { .object(["type":.string("node"),"id":.number(Double(id)),"lat":.number(46.95),"lon":.number(longitude),"tags":.object(["name":.string("Bern, \(id)")])]) }
        func way(_ id:Int,_ ids:[Int])->JSONValue { .object(["type":.string("way"),"id":.number(Double(id)),"nodes":.array(ids.map { .number(Double($0)) })]) }
        func member(_ type:String,_ id:Int,_ role:String)->JSONValue { .object(["type":.string(type),"ref":.number(Double(id)),"role":.string(role)]) }
        let members=(1...4).map { member("node",$0,"stop") }+[member("way",11,"forward"),member("way",12,"forward"),member("way",13,"forward")]
        let relation:JSONValue = .object(["type":.string("relation"),"id":.number(7),"members":.array(members),"tags":.object(["type":.string("route"),"public_transport:version":.string("2"),"route":.string("tram")])])
        let base=[node(1,7.44),node(2,7.441),node(3,7.442),node(4,7.443),way(11,[1,2]),way(12,[2,99,3]),way(13,[3,4]),relation]
        let routes=try OSMTransitGeometry.parse(data:JSONEncoder().encode(JSONValue.object(["elements":.array(base)])),source:source())
        XCTAssertEqual(routes.first?.paths.map(\.nodes),[[1,2],[3,4]])
        XCTAssertEqual(routes.first?.brokenWays,1)
        var closed=base;closed[5]=way(12,[2,3,2])
        let loops=try OSMTransitGeometry.parse(data:JSONEncoder().encode(JSONValue.object(["elements":.array(closed)])),source:source())
        XCTAssertEqual(loops.first?.paths.map(\.nodes),[[1,2],[3,4]])
        XCTAssertThrowsError(try OSMTransitGeometry.parse(data:JSONEncoder().encode(JSONValue.object(["elements":.array(base+[base[0]])])),source:source()))
    }
    @MainActor func testActualPlannerBernTransferGainsMappedAlignmentAndRestoresOffline() throws {
        let directory=try XCTUnwrap(Bundle.main.resourceURL), pack=directory.appendingPathComponent("TransitGeometry")
        let repository=try TransitGeometryRepository.load(directory:pack)
        XCTAssertEqual(repository.corridors.count,4)
        let raw=try JSONDecoder().decode(JSONValue.self,from:Data(contentsOf:directory.appendingPathComponent("a3-planner.json")))
        let metadata=try JSONDecoder().decode(JSONValue.self,from:Data(contentsOf:directory.appendingPathComponent("a3-planner-provenance.json")))
        let stamp=try XCTUnwrap(metadata["acquiredAt"].string), bridge=try DomainBridge()
        let first=raw["connections"].array[0]
        let places=try bridge.call("normalizePlaces",.object(["raw":.object(["stations":.array([first["from"]["station"],first["to"]["station"]])]),"fetchedAt":.string(stamp)]))
        let request:JSONValue = .object(["schemaVersion":.number(1),"origin":places.array[0],"destination":places.array[1],"time":.string("2026-11-21T10:00:00+01:00"),"timeMode":.string("depart_at"),"preferences":.object(["stepFree":.bool(false),"maxWalkMeters":.null,"language":.string("en")])])
        let result=try bridge.call("normalizeConnections",.object(["raw":raw,"request":request,"fetchedAt":.string(stamp)]))
        let trip=Journey(raw:try XCTUnwrap(result["journeys"].array.first)), rides=trip.legs.filter { $0.kind == "ride" }
        XCTAssertEqual(rides.map(\.line),["20","8"])
        XCTAssertTrue(rides.allSatisfy { $0.geometry?.quality == "schematic" })
        let snapshot=TransitGeometryResolver(corridors:repository.corridors).resolve(trip,sourceDigest:repository.digest,at:now)
        let mapped=snapshot.legs.filter { !$0.segments.isEmpty }
        XCTAssertGreaterThanOrEqual(mapped.count,1,"At least one actual selected ride must gain source-supported alignment")
        XCTAssertGreaterThan(mapped.reduce(0) { $0+$1.segments.reduce(0) { $0+$1.coordinates.count } },rides.reduce(0) { $0+$1.calls.count })
        let cache=directory.appendingPathComponent("a3-transit-cache.json"), controller=TransitGeometryController(cacheURL:cache)
        controller.update(active:trip,displayed:trip,session:UUID(),repository:repository,now:now)
        let saved=try Data(contentsOf:cache), restarted=TransitGeometryController(cacheURL:cache)
        restarted.update(active:trip,displayed:trip,session:UUID(),repository:nil,now:now)
        XCTAssertEqual(restarted.displayed,snapshot);XCTAssertEqual(try Data(contentsOf:cache),saved)
        try JSONEncoder().encode(trip).write(to:directory.appendingPathComponent("a3-selected-journey.json"))
        try JSONEncoder().encode(snapshot).write(to:directory.appendingPathComponent("a3-resolved-geometry.json"))
        let description = mapped.map { "relation\($0.relationID ?? 0):\($0.segments.count)segments" }.joined(separator: ", ")
        print("A3 REAL SOURCE FIXTURE: \(mapped.count)/\(rides.count) ride corridors; \(description); source dates retained; no measured passenger or exact-trip claim.")
    }
}
