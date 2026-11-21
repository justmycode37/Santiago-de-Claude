import Foundation
import MapKit
@testable import RightSide

@MainActor private final class ProcessRecordingRoutes: WalkingRouting {
    var calls = 0
    let forbidden: Bool
    init(forbidden: Bool) { self.forbidden = forbidden }
    func fetch(leg: Leg, from: CLLocationCoordinate2D?) async throws -> WalkingRouteResult {
        calls += 1
        if forbidden { throw NativeCoreError.message("Networking disabled in restart process") }
        return WalkingRouteResult(snapshot: WalkingRouteSnapshot(leg: leg,
            coordinates: [leg.from.coordinate!, leg.to.coordinate!],
            steps: [WalkingStep(id: 0, instruction: "Recording fixture: follow original sign \(leg.id)", distance: 76, endDistance: 76)],
            distance: 76, expectedSeconds: 90, fetchedAt: Date().addingTimeInterval(-300)), route: nil)
    }
}
@main struct OfflineProcessCheck {
    @MainActor static func main() async throws {
        let stage = CommandLine.arguments[1], file = URL(fileURLWithPath: CommandLine.arguments[2])
        if stage.hasPrefix("journey-") { try await fullJourney(stage: stage, file: file); return }
        let legs = ["access", "transfer", "final"].enumerated().map { index, id in
            let lon = 7.44 + Double(index) * 0.01
            return Leg(raw: .object(["id": .string(id), "kind": .string(id == "transfer" ? "transfer" : "walk"),
                "from": .object(["name": .string("Original sign \(id)"), "coordinate": .array([.number(lon), .number(46.95)])]),
                "to": .object(["name": .string("Original entrance \(id)"), "coordinate": .array([.number(lon + 0.001), .number(46.95)])])]))
        }
        let trip = Journey(raw: .object(["id": .string("recording-three-walk-process-test"), "revision": .number(3), "legs": .array(legs.map(\.raw))]))
        let provider = ProcessRecordingRoutes(forbidden: stage != "save")
        let sut = WalkingRouteController(storage: FileWalkingBundleStorage(url: file), routing: provider)
        sut.configure(journey: trip, session: UUID(), offline: stage != "save")
        if stage == "save" {
            await sut.saveForOffline()
            precondition(provider.calls == 3 && sut.bundle?.routes.count == 3)
            print("PASS process\(ProcessInfo.processInfo.processIdentifier) saved3 recording-provider paths; no actual network.")
        } else {
            let original = try Data(contentsOf: file)
            let saved = try JSONDecoder().decode(WalkingBundle.self, from: original)
            for leg in legs {
                await sut.load(leg, simulated: false, offline: true, journey: trip)
                precondition(sut.snapshot == saved.routes.first { $0.leg == leg } && sut.usingSavedRoute)
                print("PASS new process offline \(leg.id): unchanged geometry, instructions, identity, source date.")
            }
            await sut.saveForOffline()
            let after = try Data(contentsOf: file)
            precondition(provider.calls == 0 && after == original)
            print("PASS process\(ProcessInfo.processInfo.processIdentifier) restart:3/3, network calls0, cache unchanged.")
        }
    }
    @MainActor static func fullJourney(stage: String, file: URL) async throws {
        let saving = stage == "journey-save"
        let store = JourneyStore(cacheURL: file.appendingPathExtension("navigation.json"))
        if saving {
            store.loadDemo()
            var raw = store.selected!.raw; raw["id"] = .string("recording-full-journey-restart")
            store.start(Journey(raw: raw))
        } else { store.restore() }
        guard let trip = store.navigation?.journey else { throw NativeCoreError.message("Fixture navigation unavailable") }
        let provider = ProcessRecordingRoutes(forbidden: !saving)
        let walking = WalkingRouteController(storage: FileWalkingBundleStorage(url: file), routing: provider)
        walking.configure(journey: trip, session: store.navigationSessionID, offline: !saving)
        if saving {
            await walking.saveForOffline(); precondition(provider.calls == 3)
            store.setOffline(true)
            await walking.load(store.currentLeg, simulated: false, offline: true, journey: trip)
            precondition(walking.snapshot?.leg.id == "out-walk-1")
            for action in ["arrived", "at_waiting_area", "boarded", "alighted"] { store.confirm(action) }
            store.prepareRecovery(.missedConnection)
            precondition(store.navigation?.phase == "transfer" && store.planningDraft != nil)
            walking.configure(journey: store.navigation?.journey, session: store.navigationSessionID, offline: true)
            await walking.load(store.currentLeg, simulated: false, offline: true, journey: store.navigation?.journey)
            precondition(walking.snapshot?.leg.id == "out-transfer")
            print("PASS recording full journey: saved3 paths, explicitly confirmed walk/board/ride/alight to transfer, retained offline recovery draft.")
        } else {
            precondition(store.navigation?.phase == "transfer" && store.navigation?.overlays.offline == true)
            precondition(store.planningDraft?.reason == .missedConnection)
            let draft = store.planningDraft, saved = walking.bundle
            await walking.load(store.currentLeg, simulated: false, offline: true, journey: trip)
            precondition(walking.snapshot?.leg.id == "out-transfer" && walking.usingSavedRoute)
            for action in ["arrived", "at_waiting_area", "boarded", "alighted"] { store.confirm(action) }
            walking.configure(journey: store.navigation?.journey, session: store.navigationSessionID, offline: true)
            await walking.load(store.currentLeg, simulated: false, offline: true, journey: store.navigation?.journey)
            precondition(walking.snapshot?.leg.id == "out-walk-2" && walking.usingSavedRoute)
            precondition(walking.bundle == saved && store.planningDraft == draft && provider.calls == 0)
            store.confirm("arrived"); precondition(store.navigation?.phase == "arrived")
            print("PASS separate-process full Store restore: transfer/final paths, recovery draft and source identity unchanged; manual progression to arrival, routing calls0. Synthetic passenger confirmations, not actual travel.")
        }
    }

}
