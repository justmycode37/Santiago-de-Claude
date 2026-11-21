import Foundation

extension DisplayCandidate {
    /// Services that may pull in at the boarding stop around `now`, from a departure board snapshot of that
    /// same stop. A stale or foreign snapshot gives no alternatives (the matcher then stays strict).
    static func board(_ snapshot: DepartureSnapshot?, boardingStop: Place?, now: Date,
                      before: TimeInterval = 10 * 60, after: TimeInterval = 45 * 60) -> [DisplayCandidate] {
        guard let snapshot, snapshot.valid(at: now), let boardingStop,
              let id = DepartureStop.id(for: boardingStop), id == snapshot.stopID else { return [] }
        var result: [DisplayCandidate] = []
        for row in snapshot.rows {
            let time = row.predicted ?? row.scheduled
            guard time >= now.addingTimeInterval(-before), time <= now.addingTimeInterval(after),
                  let line = row.line, let destination = row.destination else { continue }
            // Displays sometimes show an important intermediate stop; offer the next few calls as vias.
            let vias = row.calls.dropFirst().prefix(6).map(\.place.name).filter { $0 != destination }
            let candidate = DisplayCandidate(line: line, destination: destination, vias: Array(vias))
            if !result.contains(where: { $0.identity == candidate.identity }) { result.append(candidate) }
        }
        return Array(result.prefix(40))
    }
}

enum DepartureBoardStop {
    /// The departure-board stop for a journey stop. Journey stops from OJP carry a Swiss SLOID
    /// (`ch:1:sloid:2905:0:1`); its number is the stop's DIDOK number, and the board's UIC id is "85"
    /// followed by that number zero-padded to five digits (verified: sloid 2905 → 8502905 Bern, Huberstrasse).
    static func place(for stop: Place?) -> Place? {
        guard let stop else { return nil }
        if DepartureStop.id(for: stop) != nil { return stop }
        let refs = stop.raw["sourceRefs"].array.compactMap { $0["id"].string } + [stop.id]
        for ref in refs {
            guard let match = ref.range(of: #"ch:1:sloid:(\d{1,5})(?::|$)"#, options: .regularExpression) else { continue }
            let digits = ref[match].split(separator: ":")[3]
            guard let number = Int(digits) else { continue }
            let id = "85" + String(format: "%05d", number)
            guard DepartureStop.validID(id) else { continue }
            return Place(raw: .object(["id": .string("transport.opendata.ch:\(id)"), "name": .string(stop.name), "kind": .string("stop"),
                "coordinate": stop.raw["coordinate"], "parentId": .null,
                "sourceRefs": .array([.object(["provider": .string(DepartureStop.provider), "id": .string(id), "feedVersion": .null])]),
                "evidence": stop.raw["evidence"]]))
        }
        return nil
    }
}
