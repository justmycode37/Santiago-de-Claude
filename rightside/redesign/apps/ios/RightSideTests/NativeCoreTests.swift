import XCTest
@testable import RightSide

/// Add to the hosted iOS unit-test target. Actual Apple JavaScriptCore, not Node.
@MainActor final class NativeCoreTests: XCTestCase {
    func testActualJSCReplayAndLosslessRoundTrip() throws {
        let bridge = try DomainBridge()
        let fixture = try bridge.fixture()
        var replay = try bridge.call("createReplay", .object(["fixture": fixture]))
        var applied = 0
        while applied < 26 {
            if replay["navigation"]["phase"].string == "arrived", replay["direction"].string == "outbound" {
                replay = try bridge.call("returnReplay", .object(["replay": replay]))
            }
            let previous = replay["cursor"].double ?? 0
            replay = try bridge.call("nextReplay", .object(["replay": replay]))
            let delta = Int((replay["cursor"].double ?? 0) - previous)
            XCTAssertGreaterThan(delta, 0)
            guard delta > 0 else { return }
            applied += delta
            let snapshot = NavigationSnapshot(raw: replay["navigation"])
            let decoded = try JSONDecoder().decode(NavigationSnapshot.self, from: JSONEncoder().encode(snapshot))
            XCTAssertEqual(decoded.raw, snapshot.raw)
        }
        XCTAssertEqual(replay["navigation"]["phase"].string, "arrived")
        XCTAssertEqual(replay["direction"].string, "return")
    }

    func testAtomicCacheValidationAndEvidenceAge() throws {
        let bridge = try DomainBridge()
        let fixture = try bridge.fixture()
        var replay = try bridge.call("createReplay", .object(["fixture": fixture]))
        for _ in 0..<13 { replay = try bridge.call("nextReplay", .object(["replay": replay])) }
        let state = replay["navigation"]
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = try JourneyCache(url: directory.appendingPathComponent("state.json"))
        try cache.save(navigation: state, replay: replay, bridge: bridge)
        let restored = try XCTUnwrap(cache.load(bridge: bridge))
        XCTAssertEqual(restored.navigation, state)
        let now = try XCTUnwrap(WireClock.date(state["now"].string ?? ""))
        let aged = try bridge.call("tick", .object(["state": restored.navigation, "now": .string(WireClock.string(now.addingTimeInterval(120)))]))
        XCTAssertEqual(aged["predictionFresh"].bool, false)
        XCTAssertEqual(aged["serviceMatch"], .null)
        XCTAssertEqual(aged["journey"]["evidence"], state["journey"]["evidence"])
        var invalid = state; invalid["legIndex"] = .number(999)
        XCTAssertThrowsError(try cache.save(navigation: invalid, replay: nil, bridge: bridge))
        XCTAssertEqual(try cache.load(bridge: bridge)?.navigation, state, "A failed validation cannot overwrite the saved state")
    }

    func testJavaScriptCoreSwissServiceDayAcrossDSTAndMidnight() throws {
        let bridge = try DomainBridge()
        let fixture = try bridge.fixture()
        // Schema-valid JSON must be returned even on devices with another locale/timezone.
        let places = try bridge.call("normalizePlaces", .object(["raw": .object(["stations": .array([
            .object(["id": .string("A"), "name": .string("A")]), .object(["id": .string("B"), "name": .string("B")])
        ])]), "fetchedAt": .string("2026-10-24T22:30:00Z")]))
        for (start, end, date) in [("2026-10-24T22:30:00Z", "2026-10-24T22:45:00Z", "2026-10-25"), ("2026-03-28T23:30:00Z", "2026-03-28T23:45:00Z", "2026-03-29")] {
            let departure: JSONValue = .object(["station": .object(["id": .string("A"), "name": .string("A")]), "departure": .string(start)])
            let arrival: JSONValue = .object(["station": .object(["id": .string("B"), "name": .string("B")]), "arrival": .string(end)])
            let raw: JSONValue = .object(["connections": .array([.object(["sections": .array([.object(["departure": departure, "arrival": arrival, "journey": .object(["number": .string("7"), "to": .string("B"), "categoryCode": .number(6)])])])])])])
            let request: JSONValue = .object(["schemaVersion": .number(1), "origin": places.array[0], "destination": places.array[1], "time": .string(start), "timeMode": .string("depart_at"), "preferences": fixture["journey"]["preferences"]])
            let response = try bridge.call("normalizeConnections", .object(["raw": raw, "request": request, "fetchedAt": .string(start)]))
            let journey = try XCTUnwrap(response["journeys"].array.first)
            let ride = try XCTUnwrap(journey["legs"].array.first)
            XCTAssertEqual(ride["trip"]["operatingDate"].string, date)
            XCTAssertEqual(ride["trip"]["sourceTripId"], .null)
        }
    }
}
