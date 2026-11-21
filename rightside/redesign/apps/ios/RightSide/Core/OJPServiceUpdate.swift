import Foundation

public struct OJPServiceChange: Codable, Equatable, Identifiable, Sendable {
    public enum Status: String, Codable, Sendable { case unchanged, updated, requiresRecovery }
    public let legID: String
    public let status: Status
    public let messages: [String]
    public let snapshot: OJPServiceSnapshot
    public let selectedServiceOrders: [Int]
    public var id: String { legID }
}
public struct OJPServiceReport: Codable, Equatable, Sendable {
    public let journeyID: String
    public let baseRevision: Int
    public let acquiredAt: Date
    public let changes: [OJPServiceChange]
    public var requiresRecovery: Bool { changes.contains { $0.status == .requiresRecovery } }
    var raw: JSONValue { (try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(self))) ?? .null }
    static func decode(_ raw: JSONValue) -> Self? { try? JSONDecoder().decode(Self.self, from: JSONEncoder().encode(raw)) }
}
struct OJPUpdateResult {
    let journey: Journey?
    let report: OJPServiceReport
}

enum OJPServiceUpdate {
    static func occurrences(in journey: Journey) throws -> [OJPOccurrence] {
        let rides = journey.legs.filter { $0.kind == "ride" }
        let values = rides.compactMap(OJPOccurrence.from)
        guard !rides.isEmpty, values.count == rides.count else { throw OJPError.unavailable("This journey has no compatible OJP occurrence references. Plan a fresh journey with service updates enabled; existing JSON trips cannot be exact-refreshed.") }
        var seen = Set<OJPOccurrence>(), unique: [OJPOccurrence] = []
        for value in values where seen.insert(value).inserted { unique.append(value) }
        guard unique.count <= 8 else { throw OJPError.unavailable("This journey exceeds the local service-update limit. Fresh planning remains available.") }
        return unique
    }
    private static func matches(_ original: StopCall, _ current: OJPServiceCall) -> Bool {
        guard original.raw["ojp"]["stopPointRef"].string == current.stopPointRef else { return false }
        let arrival = original.raw["plannedArrival"].string.flatMap(WireClock.date)
        let departure = original.raw["plannedDeparture"].string.flatMap(WireClock.date)
        guard arrival != nil || departure != nil else { return false }
        return (arrival == nil || arrival == current.plannedArrival) && (departure == nil || departure == current.plannedDeparture)
    }
    /// Segment orders are local in TripRequest; TripInfo orders span the entire service.
    /// Match a unique contiguous exact stop/time sequence, never an offset guessed from labels.
    static func matchingRange(leg: Leg, snapshot: OJPServiceSnapshot) -> Range<Int>? {
        let old = leg.calls, current = snapshot.calls
        guard (2...160).contains(old.count), current.count <= 160, current.count >= old.count else { return nil }
        var match: Range<Int>?
        for start in 0...(current.count - old.count) {
            guard old.indices.allSatisfy({ matches(old[$0], current[start + $0]) }) else { continue }
            guard match == nil else { return nil }
            match = start..<(start + old.count)
        }
        return match
    }
    static func reconcile(journey: Journey, snapshots: [OJPServiceSnapshot], now: Date) throws -> OJPUpdateResult {
        let expected = try occurrences(in: journey)
        guard snapshots.count == expected.count, Set(snapshots.map(\.occurrence)).count == snapshots.count,
              Set(snapshots.map(\.occurrence)) == Set(expected), snapshots.allSatisfy({ $0.source.recent(at: now) }) else {
            throw OJPError.invalid("Service update set has wrong identities or expired responses")
        }
        for snapshot in snapshots { try OJPDecoder.validateOrder(snapshot.calls) }
        var legs = journey.legs.map(\.raw), changes: [OJPServiceChange] = []
        for index in journey.legs.indices where journey.legs[index].kind == "ride" {
            let old = journey.legs[index]
            guard let occurrence = OJPOccurrence.from(old), let snapshot = snapshots.first(where: { $0.occurrence == occurrence }) else { throw OJPError.invalid("Missing service occurrence") }
            guard let range = matchingRange(leg: old, snapshot: snapshot) else {
                changes.append(OJPServiceChange(legID: old.id, status: .requiresRecovery,
                    messages: ["The selected calls no longer match a unique exact stop-reference and timetable sequence. Stop assignment, route or timetable may have changed. Inspect the full service and plan again."], snapshot: snapshot, selectedServiceOrders: []))
                continue
            }
            let selected = Array(snapshot.calls[range])
            guard snapshot.cancelled != true, selected.first?.notServiced != true, selected.last?.notServiced != true,
                  selected.first?.noBoarding != true, selected.last?.noAlighting != true else {
                changes.append(OJPServiceChange(legID: old.id, status: .requiresRecovery,
                    messages: [snapshot.cancelled == true ? "The provider reports this service occurrence cancelled." : "The provider reports the intended boarding or alighting call unavailable. Fresh planning is required."],
                    snapshot: snapshot, selectedServiceOrders: selected.map(\.order)))
                continue
            }
            var updatedCalls: [JSONValue] = [], messages: [String] = []
            for (offset, value) in selected.enumerated() {
                let original = old.calls[offset]
                var updated = OJPJourneyAdapter.call(value, occurrence: occurrence, id: original.id, source: snapshot.source, cancelled: snapshot.cancelled, serviceOrder: value.order)
                updated["ojp"]["legOrder"] = original.raw["ojp"]["legOrder"]
                if updated["expectedArrival"] != original.raw["expectedArrival"] || updated["expectedDeparture"] != original.raw["expectedDeparture"] {
                    messages.append("\(value.name): reported prediction changed.")
                }
                if updated["currentAssignment"]["label"] != original.raw["currentAssignment"]["label"] {
                    messages.append("\(value.name): platform label \(original.raw["currentAssignment"]["label"].string ?? "unknown") → \(updated["currentAssignment"]["label"].string ?? "unknown"). Check signs; waiting area is unverified.")
                }
                if updated["status"] != original.status.asJSON { messages.append("\(value.name): call status changed.") }
                updatedCalls.append(updated)
            }
            var leg = old.raw
            leg["calls"] = .array(updatedCalls)
            leg["from"] = updatedCalls[0]["place"]; leg["to"] = updatedCalls.last!["place"]
            leg["expectedStart"] = updatedCalls[0]["expectedDeparture"]; leg["expectedEnd"] = updatedCalls.last!["expectedArrival"]
            leg["line"] = .optional(snapshot.line); leg["headsign"] = .optional(snapshot.destination); leg["directionId"] = .optional(snapshot.direction)
            let target = OJPJourneyAdapter.target(call: updatedCalls[0], source: snapshot.source), previous = old.raw["boardingTarget"]
            let assignmentUnchanged = target["id"] == previous["id"] && target["transitCoordinate"] == previous["transitCoordinate"]
            leg["boardingTarget"] = assignmentUnchanged ? previous : target
            leg["evidence"] = snapshot.source.evidence(predicted: leg["expectedStart"] != .null || leg["expectedEnd"] != .null)
            leg["ojpSource"] = snapshot.source.raw
            leg["geometry"] = selected.allSatisfy { $0.coordinate != nil } ? .object([
                "type": .string("LineString"), "quality": .string("schematic"),
                "coordinates": .array(selected.map { .array($0.coordinate!.map(JSONValue.number)) }), "evidence": snapshot.source.evidence()
            ]) : .null
            if leg["line"] != old.raw["line"] || leg["headsign"] != old.raw["headsign"] || leg["directionId"] != old.raw["directionId"] {
                messages.append("Reported service line, direction or destination changed. Recheck the vehicle display.")
            }
            if messages.isEmpty { messages = ["Selected calls still match. No supplied prediction, platform or status change."] }
            changes.append(OJPServiceChange(legID: old.id, status: messages[0].hasPrefix("Selected calls still match") ? .unchanged : .updated,
                messages: messages, snapshot: snapshot, selectedServiceOrders: selected.map(\.order)))
            legs[index] = leg
        }
        let report = OJPServiceReport(journeyID: journey.id, baseRevision: journey.revision,
            acquiredAt: snapshots.map(\.source.acquiredAt).max()!, changes: changes)
        guard !report.requiresRecovery else { return OJPUpdateResult(journey: nil, report: report) }
        var raw = journey.raw
        raw["revision"] = .number(Double(journey.revision + 1)); raw["legs"] = .array(legs)
        raw["evidence"] = .array(legs.flatMap { $0["evidence"].array })
        return OJPUpdateResult(journey: Journey(raw: raw), report: report)
    }
}
private extension String { var asJSON: JSONValue { .string(self) } }
