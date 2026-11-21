import Foundation
import MapKit
@testable import RightSide

/// Reproduce the accepted baseline's single-file overwrite without network.
/// Each write is the exact legacy JSON persistence format used by load().
@main struct BeforeOfflineWalking {
    @MainActor static func main() async throws {
        let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let url = output.appendingPathComponent("legacy-walk.json")
        let legs = ["access", "transfer", "final"].enumerated().map { index, id in
            let lon = 7.44 + Double(index) * 0.01
            return Leg(raw: .object(["id": .string(id), "kind": .string(id == "transfer" ? "transfer" : "walk"),
                "from": .object(["name": .string(id + " start"), "coordinate": .array([.number(lon), .number(46.95)])]),
                "to": .object(["name": .string(id + " end"), "coordinate": .array([.number(lon + 0.001), .number(46.95)])])]))
        }
        for leg in legs {
            let snapshot = WalkingRouteSnapshot(leg: leg, coordinates: [leg.from.coordinate!, leg.to.coordinate!],
                steps: [WalkingStep(id: 0, instruction: "Walk", distance: 76, endDistance: 76)], distance: 76,
                expectedSeconds: 90, fetchedAt: Date().addingTimeInterval(-300))
            try JSONEncoder().encode(snapshot).write(to: url, options: .atomic)
        }
        let restarted = WalkingRouteController(cacheURL: url)
        var restored = 0
        for leg in legs {
            await restarted.load(leg, simulated: false, offline: true)
            let available = restarted.snapshot != nil
            print("Baseline offline \(leg.id): \(available ? "available" : "MISSING")")
            if available { restored += 1 }
        }
        print("\(restored)/3 restored; acceptance requires 3/3. No network was used.")
        exit(restored == 3 ? 0 : 1)
    }
}
