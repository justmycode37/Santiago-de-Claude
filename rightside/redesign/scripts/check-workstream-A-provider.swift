import Foundation
import MapKit
@testable import RightSide

private actor RecordingTransit: TransitTransport {
    let output: URL
    let provider = CommunityTransport()
    private var number = 0
    private var offline = false
    init(output: URL) { self.output = output }
    func setOffline(_ value: Bool) { offline = value }
    func places(_ query: String) async throws -> JSONValue {
        let raw = try await provider.places(query)
        try JSONEncoder().encode(raw).write(to: output.appendingPathComponent("places-\(query.contains("Bern") ? "origin" : "destination").json"))
        return raw
    }
    func connections(origin: Place, destination: Place, departure: Date, arriveBy: Bool) async throws -> JSONValue {
        if offline { throw NativeCoreError.message("Deliberately unavailable network for recovery check") }
        let raw = try await provider.connections(origin: origin, destination: destination, departure: departure, arriveBy: arriveBy)
        number += 1
        let evidence: JSONValue = .object(["source": .string("https://transport.opendata.ch/v1/connections"), "fetchedAt": .string(WireClock.string()), "origin": origin.raw, "destination": destination.raw, "departure": .string(WireClock.string(departure)), "arriveBy": .bool(arriveBy), "response": raw])
        try JSONEncoder().encode(evidence).write(to: output.appendingPathComponent("provider-\(number).json"))
        return raw
    }
}
@main struct LiveNavigationCheck {
    @MainActor static func main() async throws {
        let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let transport = RecordingTransit(output: output)
        let store = JourneyStore(cacheURL: output.appendingPathComponent("provider-navigation.json"), transport: transport)
        let origins = await store.searchPlaces("Bern, Länggasse")
        let destinations = await store.searchPlaces("Luzern, Verkehrshaus")
        guard let origin = origins.first, let destination = destinations.first else { throw NativeCoreError.message("Live provider returned no validated places: \(store.placeError ?? "empty")") }
        store.origin = origin; store.destination = destination; store.departure = Date().addingTimeInterval(3600)
        await store.search()
        guard let journey = store.alternatives.first(where: { $0.legs.filter { $0.kind == "ride" }.count >= 2 }) ?? store.alternatives.first else { throw NativeCoreError.message("Live provider returned no usable itinerary: \(store.error ?? "empty")") }
        try JSONEncoder().encode(journey).write(to: output.appendingPathComponent("provider-journey.json"))
        print("LIVE provider: \(origin.name) → \(destination.name), \(store.alternatives.count) options, chosen \(journey.legs.count) legs / \(journey.legs.filter { $0.kind == "ride" }.count) rides")
        store.start(journey)
        guard store.error == nil else { throw NativeCoreError.message(store.error!) }
        let identity = store.navigation!.journey.raw
        store.setOffline(true); store.restore()
        precondition(store.navigation?.journey.raw == identity && store.navigation?.overlays.offline == true)
        print("PASS live provider journey → explicit start → offline cache restore, original identity/evidence retained")
        var actions: [String] = []
        for _ in 0..<100 {
            guard let state = store.navigation, state.phase != "arrived" else { break }
            if state.currentLeg.kind != "ride" { store.confirm("arrived"); actions.append("walk confirmed") }
            else if state.phase == "approaching" { store.confirm("at_waiting_area"); actions.append("waiting confirmed") }
            else if state.phase == "waiting" {
                guard !state.currentLeg.boardingUnavailable else { throw NativeCoreError.message("Provider cancelled/skipped/forbids this boarding; safely cannot run complete replay") }
                store.confirm("boarded"); actions.append("boarding confirmed")
            } else { store.prepareAlighting(); store.confirm("alighted"); actions.append("alighting confirmed") }
            guard store.error == nil else { throw NativeCoreError.message(store.error!) }
        }
        precondition(store.navigation?.phase == "arrived")
        print("PASS explicit synthetic passenger confirmations across live itinerary: \(actions.count) actions; no claim of physical travel")
        let arrived = store.navigation!.raw
        store.prepareReturn(); store.planningDraft?.departure = Date().addingTimeInterval(7200)
        await store.searchPlanningDraft()
        guard store.previewing, !store.alternatives.isEmpty else { throw NativeCoreError.message("Fresh return unavailable: \(store.error ?? "no validated itineraries")") }
        precondition(store.navigation?.raw == arrived)
        try JSONEncoder().encode(store.alternatives).write(to: output.appendingPathComponent("provider-return-options.json"))
        print("PASS edited fresh return: \(store.alternatives.count) options; outbound arrival preserved until explicit start")
        store.resume(); store.prepareRecovery(.missedConnection)
        let preserved = store.navigation!.raw
        await transport.setOffline(true)
        await store.searchPlanningDraft()
        precondition(store.error != nil && store.navigation?.raw == preserved && store.planningDraft != nil)
        print("PASS controlled unavailable-network recovery using actual provider journey; active state and request retained")
        let walkFrom: JSONValue = .object(["id": .string("check:bern-bahnhof"), "name": .string("Bern Bahnhof"), "coordinate": .array([.number(7.4391), .number(46.9491)])])
        let walkTo: JSONValue = .object(["id": .string("check:zytglogge"), "name": .string("Zytglogge"), "coordinate": .array([.number(7.4474), .number(46.9480)])])
        let walking = WalkingRouteController(cacheURL: output.appendingPathComponent("live-walk.json"))
        await walking.load(Leg(raw: .object(["id": .string("live-mapkit-walk"), "kind": .string("walk"), "from": walkFrom, "to": walkTo])), simulated: false)
        if let detail = walking.snapshot {
            print("LIVE MapKit: \(Int(detail.distance)) m, \(detail.steps.count) instructions, estimated \(Int(detail.expectedSeconds)) seconds. Not surveyed ground truth.")
        } else { print("SOURCE LIMITATION live MapKit unavailable: \(walking.status ?? "unknown"). Cached stop-name fallback remains; no walking-provider pass claimed.") }
    }
}
