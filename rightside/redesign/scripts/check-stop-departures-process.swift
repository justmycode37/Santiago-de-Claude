import Foundation
import RightSide

private struct SnapshotTransport: StopDepartureTransport {
    let value: DepartureSnapshot
    func departures(stopID: String) async throws -> DepartureSnapshot { value }
}
@main struct DepartureProcessCheck {
    @MainActor static func main() async throws {
        let args = CommandLine.arguments
        guard args.count == 4 else { fatalError("write|read cache artifact") }
        let cache = URL(fileURLWithPath: args[2]), artifact = URL(fileURLWithPath: args[3])
        if args[1] == "write" {
            let now = Date()
            let station: JSONValue = .object(["id": .string("8576646"), "name": .string("Synthetic restart stop")])
            let raw: JSONValue = .object(["station": station, "stationboard": .array([.object([
                "number": .string("TEST"), "to": .string("Synthetic destination"), "stop": .object(["station": station,
                "departure": .string(WireClock.string(now.addingTimeInterval(600))),
                "prognosis": .object(["departure": .string(WireClock.string(now.addingTimeInterval(660)))])])])])])
            let value = try DepartureSnapshot.decode(data: JSONEncoder().encode(raw), stopID: "8576646", acquiredAt: now, responseDate: nil, now: now)
            let controller = StopDepartureController(transport: SnapshotTransport(value: value), cacheURL: cache)
            await controller.select(value.stop, offline: false)
            guard controller.snapshot == value, controller.mayShowPrediction(at: Date()), controller.cacheWarning == nil else { fatalError("Write failed") }
            try JSONEncoder().encode(value).write(to: artifact, options: .atomic)
            print("PASS synthetic process1: wrote source date and snapshot, 1 departure; recent retrieval only")
        } else {
            let expected = try JSONDecoder().decode(DepartureSnapshot.self, from: Data(contentsOf: artifact))
            let controller = StopDepartureController(cacheURL: cache)
            await controller.select(expected.stop, offline: true)
            guard controller.snapshot == expected, controller.fromCache, !controller.mayShowPrediction(at: Date()),
                  controller.snapshot?.acquiredAt == expected.acquiredAt else { fatalError("Restart changed source identity/date or prediction state") }
            print("PASS synthetic process2: offline restored exact source date/snapshot; current prediction disabled; no provider request")
        }
    }
}
