import XCTest
import JavaScriptCore
@testable import RightSide

final class DomainBridgeTests: XCTestCase {
    @MainActor func testCompleteReplayAndReturnInAppleJavaScriptCore() throws {
        let bridge = try DomainBridge(), fixture = try bridge.fixture()
        var replay = try bridge.call("createReplay", .object(["fixture": fixture]))
        var processed = 0, sawMatch = false, sawLoss = false
        for _ in 0..<30 {
            let state = replay["navigation"]
            if state["phase"].string == "arrived" && replay["direction"].string == "outbound" {
                replay = try bridge.call("returnReplay", .object(["replay": replay]))
            }
            let before = Int(replay["cursor"].double ?? 0)
            if before == 26 { break }
            replay = try bridge.call("nextReplay", .object(["replay": replay]))
            let after = Int(replay["cursor"].double ?? 0)
            XCTAssertGreaterThan(after, before)
            processed += after - before
            sawMatch = sawMatch || replay["navigation"]["serviceMatch"]["status"].string == "matching"
            sawLoss = sawLoss || (!replay["navigation"]["lostTrackIds"].array.isEmpty && replay["navigation"]["serviceMatch"] == .null)
        }
        XCTAssertEqual(processed, 26)
        XCTAssertEqual(replay["navigation"]["phase"].string, "arrived")
        XCTAssertEqual(replay["direction"].string, "return")
        XCTAssertTrue(sawMatch); XCTAssertTrue(sawLoss)
    }

    @MainActor func testLosslessStorageAndInvalidStateRejection() throws {
        let bridge = try DomainBridge(), fixture = try bridge.fixture()
        let state = try bridge.call("create", .object(["journey": fixture["journey"], "now": fixture["clockStart"]]))
        let serialized = try bridge.call("serialize", .object(["state": state]))
        let restored = try bridge.call("restore", .object(["json": serialized]))
        XCTAssertEqual(restored["journey"], state["journey"])
        XCTAssertEqual(restored["processedEventIds"], state["processedEventIds"])
        var broken = restored; broken["legIndex"] = .number(999)
        XCTAssertThrowsError(try bridge.call("restore", .object(["json": .string(try broken.encoded())])))
        let dto = NavigationSnapshot(raw: state)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(dto)), state)
    }

    @MainActor func testJavaScriptCoreLocaleAndStrictDates() throws {
        let context = try XCTUnwrap(JSContext())
        XCTAssertEqual(context.evaluateScript("'KÖNIZ'.normalize('NFKC').toLocaleLowerCase('de-CH')")?.toString(), "köniz")
        XCTAssertEqual(context.evaluateScript("Date.parse('2026-10-25T02:30:00+02:00') !== Date.parse('2026-10-25T02:30:00+01:00')")?.toBool(), true)
        let bridge = try DomainBridge(), fixture = try bridge.fixture()
        var journey = fixture["journey"]
        var legs = journey["legs"].array
        legs[0]["plannedStart"] = .string("2026-02-30T09:00:00Z")
        journey["legs"] = .array(legs)
        XCTAssertThrowsError(try bridge.call("validateJourney", .object(["journey": journey])))
    }

    @MainActor func testNativeStoreManualJourneyAndSavedReload() throws {
        let cacheURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".json")
        defer { try? FileManager.default.removeItem(at: cacheURL) }
        let store = JourneyStore(cacheURL: cacheURL)
        store.loadDemo()
        XCTAssertNil(store.error)
        let journey = try XCTUnwrap(store.selected)
        store.start(journey)
        for action in ["arrived", "at_waiting_area", "boarded", "alighted", "arrived", "at_waiting_area", "boarded", "alighted", "arrived"] { store.confirm(action) }
        XCTAssertEqual(store.navigation?.phase, "arrived")
        XCTAssertNil(store.error)
        let reopened = JourneyStore(cacheURL: cacheURL); reopened.restore()
        XCTAssertEqual(reopened.navigation?.journey.id, journey.id)
        XCTAssertEqual(reopened.navigation?.phase, "arrived")
        XCTAssertEqual(reopened.isDemo, true)
        XCTAssertFalse(reopened.canStepScenario)
        let restored = reopened.navigation?.raw
        reopened.nextScenario()
        XCTAssertEqual(reopened.navigation?.raw, restored)
        reopened.loadDemo(); reopened.start(try XCTUnwrap(reopened.selected))
        XCTAssertTrue(reopened.canStepScenario)
    }
}
