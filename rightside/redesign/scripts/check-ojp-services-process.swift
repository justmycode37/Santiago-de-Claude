import Foundation
@testable import RightSide

private struct FixtureOJP: OJPTransport {
    let directory: URL
    func send(_ request: Data) async throws -> OJPResponseData {
        let index = String(decoding: request, as: UTF8.self).contains("ojp-92-20.1.TA.1071.j26") ? 0 : 1
        let data = try Data(contentsOf: directory.appendingPathComponent("service-\(index).xml"))
        let now = Date(), xml = String(decoding: data, as: UTF8.self)
            .replacingOccurrences(of: "(<(?:[A-Za-z]+:)?ResponseTimestamp>)[^<]+", with: "$1" + OJPIdentity.requestTime(now), options: .regularExpression)
        return OJPResponseData(data: Data(xml.utf8), acquiredAt: now)
    }
}
@main struct OJPProcessCheck {
    @MainActor static func main() async throws {
        let args = CommandLine.arguments
        guard args.count == 5 else { fatalError("write|read fixtures cache expected") }
        let fixtures = URL(fileURLWithPath: args[2]), file = URL(fileURLWithPath: args[3]), expected = URL(fileURLWithPath: args[4])
        if args[1] == "write" {
            let transport = FixtureOJP(directory: fixtures), store = JourneyStore(cacheURL: file, ojpTransport: transport)
            func place(_ id: String, _ name: String) -> Place {
                DepartureStop.place(.object(["id": .string(id), "name": .string(name)]), acquiredAt: Date())!
            }
            let data = try Data(contentsOf: fixtures.appendingPathComponent("trip.xml"))
            let metadata = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: fixtures.appendingPathComponent("trip-provenance.json")))
            let response = OJPResponseData(data: data, acquiredAt: WireClock.date(metadata["acquiredAt"].string!)!)
            let journey = try OJPJourneyAdapter.journeys(response, origin: place("8571359", "Bern, Länggasse"), destination: place("8589002", "Bern, Saali"), departure: WireClock.date("2026-11-21T06:50:18Z")!, arriveBy: false, preferences: .object(["stepFree": .bool(false), "maxWalkMeters": .null, "language": .string("en")]))[0]
            store.start(journey); await store.updateServices()
            guard store.serviceUpdateError == nil, store.navigation?.journey.revision == 1, store.serviceReport?.changes.count == 2 else { fatalError("Service update failed: \(store.serviceUpdateError ?? store.error ?? "missing report")") }
            store.setOffline(true)
            try JSONEncoder().encode(store.navigation!.raw).write(to: expected, options: .atomic)
            print("PASS OJP process1: actual provider itinerary/call fixtures, explicitly synthetic receipt timestamps; full service update saved offline")
        } else {
            let store = JourneyStore(cacheURL: file); store.restore()
            let raw = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: expected))
            guard store.navigation?.journey.raw == raw["journey"], store.navigation?.raw["ojpServiceReport"] == raw["ojpServiceReport"],
                  store.navigation?.raw["legIndex"] == raw["legIndex"], store.navigation?.raw["phase"] == raw["phase"],
                  store.serviceReport?.changes.count == 2, store.planningSource == .occurrenceOJP,
                  store.navigation?.overlays.offline == true else { fatalError("Restart changed service context or dates") }
            let ride = store.navigation?.journey.legs.first { $0.kind == "ride" }
            guard !store.boardingServiceEligible(for: ride) else { fatalError("Offline boarding context revived") }
            print("PASS OJP process2: exact full journey, report, occurrence/day and original source dates restored; offline context suppressed; no network")
        }
    }
}
