import Foundation
import MapKit
@testable import RightSide

@main struct OfflineWalkingAdapterCheck {
    @MainActor static func main() async throws {
        let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let from: JSONValue = .object(["id": .string("sample:bern-bahnhof"), "name": .string("Bern Bahnhof"), "coordinate": .array([.number(7.4391), .number(46.9491)])])
        let to: JSONValue = .object(["id": .string("sample:zytglogge"), "name": .string("Zytglogge"), "coordinate": .array([.number(7.4474), .number(46.9480)])])
        let leg = Leg(raw: .object(["id": .string("sample-walk"), "kind": .string("walk"), "from": from, "to": to]))
        let trip = Journey(raw: .object(["id": .string("mapkit-adapter-sample"), "revision": .number(1), "legs": .array([leg.raw])]))
        let storage = FileWalkingBundleStorage(url: output.appendingPathComponent("real-mapkit-bundle.json"))
        let live = WalkingRouteController(storage: storage)
        live.configure(journey: trip, session: UUID(), offline: false)
        await live.saveForOffline() // exactly one actual MapKit request, capped20s
        guard let route = live.bundle?.routes.first else {
            print("SOURCE UNAVAILABLE: \(live.saveStatus ?? "No walking geometry"). No MapKit success claimed.")
            exit(2)
        }
        let restarted = WalkingRouteController(storage: storage)
        restarted.configure(journey: trip, session: UUID(), offline: true)
        await restarted.load(leg, simulated: false, offline: true, journey: trip)
        precondition(restarted.snapshot == route && restarted.usingSavedRoute)
        print("REAL MapKit adapter: \(Int(route.distance))m, \(route.coordinates.count)points, \(route.steps.count)instructions, source acquired \(route.fetchedAt).")
        print("PASS exact saved geometry/instructions/date restored offline. One planned sample, no measured passenger/field/entrance claim.")
    }
}
