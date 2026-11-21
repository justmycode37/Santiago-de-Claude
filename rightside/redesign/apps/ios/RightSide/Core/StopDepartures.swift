import Foundation
import CryptoKit

/// Provider stop identity only. A sign label, coordinate, or first search match is insufficient.
public enum DepartureStop {
    public static let provider = "transport.opendata.ch"
    public static func validID(_ id: String) -> Bool {
        (6...9).contains(id.utf8.count) && id.utf8.allSatisfy { (48...57).contains($0) }
    }
    public static func id(for place: Place) -> String? {
        guard place.kind == "stop" else { return nil }
        let refs = place.raw["sourceRefs"].array.filter { $0["provider"].string == provider }
        let ids = refs.compactMap { $0["id"].string }
        guard ids.count == refs.count, Set(ids).count == 1, let id = ids.first, validID(id) else { return nil }
        return id
    }
    public static func place(_ station: JSONValue, acquiredAt: Date) -> Place? {
        guard let id = station["id"].string, validID(id), let name = text(station["name"]) else { return nil }
        let x = station["coordinate"]["x"].double, y = station["coordinate"]["y"].double
        let coordinate: JSONValue
        if let x, let y, x.isFinite, y.isFinite, abs(x) <= 90, abs(y) <= 180 {
            coordinate = .array([.number(y), .number(x)])
        } else { coordinate = .null }
        return Place(raw: .object(["id": .string("transport.opendata.ch:\(id)"), "name": .string(name),
            "kind": .string("stop"), "coordinate": coordinate, "parentId": .null,
            "sourceRefs": .array([.object(["provider": .string(provider), "id": .string(id), "feedVersion": .null])]), "evidence": .array([.object(["source": .string(provider), "fetchedAt": .string(WireClock.string(acquiredAt)), "kind": .string("scheduled"), "quality": .string("supported")])])]))
    }
    static func text(_ value: JSONValue) -> String? {
        guard let value = value.string, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              value.utf8.count <= 300 else { return nil }
        return value
    }
}

public struct DepartureCall: Codable, Equatable, Identifiable, Sendable {
    /// Response-local occurrence index; repeated stop IDs remain distinct.
    public let id: Int
    public let place: Place
    public let scheduledArrival: Date?
    public let scheduledDeparture: Date?
}

public struct StopDeparture: Codable, Equatable, Identifiable, Sendable {
    /// Snapshot-local row index. `serviceName` is NOT an exact trip/occurrence identity.
    public let id: Int
    public let serviceName: String?
    public let category: String?
    public let line: String?
    public let operatorName: String?
    public let destination: String?
    public let scheduled: Date
    public let predicted: Date?
    public let platform: String?
    public let predictedPlatform: String?
    public let calls: [DepartureCall]
    public var title: String { [category, line].compactMap { $0 }.joined(separator: " ").isEmpty ? "Service" : [category, line].compactMap { $0 }.joined(separator: " ") }
    public var cancellationLabel: String { "Cancellation status not supplied" }
}

public struct DepartureSnapshot: Codable, Equatable, Sendable {
    public static let maxAge: TimeInterval = 24 * 3600
    public let version: Int
    public let stopID: String
    public let queryLimit: Int
    public let stop: Place
    public let acquiredAt: Date
    public let responseDate: String?
    public let sourceSHA256: String
    public let rows: [StopDeparture]
    public let omittedRows: Int
    /// Explicit query identity: upcoming departures, limit40, no local-calendar reinterpretation.
    public var queryKey: String { "\(DepartureStop.provider)|stationboard|\(stopID)|departure|upcoming|\(queryLimit)" }

    public func valid(at now: Date) -> Bool {
        let age = now.timeIntervalSince(acquiredAt)
        guard version == 1, (1...40).contains(queryLimit), DepartureStop.validID(stopID), DepartureStop.id(for: stop) == stopID,
              age.isFinite, age >= 0, age <= Self.maxAge, sourceSHA256.count == 64,
              sourceSHA256.allSatisfy({ $0.isHexDigit }), rows.count <= queryLimit, omittedRows >= 0,
              Set(rows.map(\.id)).count == rows.count else { return false }
        return rows.allSatisfy { row in
            row.id >= 0 && abs(row.scheduled.timeIntervalSince(acquiredAt)) <= 3 * 86400 &&
            (row.predicted.map { abs($0.timeIntervalSince(row.scheduled)) <= 12 * 3600 } ?? true) &&
            row.calls.count <= 80 && Set(row.calls.map(\.id)).count == row.calls.count &&
            row.calls.allSatisfy { $0.id >= 0 && DepartureStop.id(for: $0.place) != nil }
        }
    }
    public func recentlyRetrieved(at now: Date) -> Bool { valid(at: now) && now.timeIntervalSince(acquiredAt) <= 90 }

    public static func decode(data: Data, stopID: String, acquiredAt: Date, responseDate: String?, now: Date, queryLimit: Int = 40) throws -> Self {
        guard data.count <= 2_000_000, (1...40).contains(queryLimit), DepartureStop.validID(stopID) else { throw NativeCoreError.message("Invalid stop or oversized departure response.") }
        let raw = try JSONDecoder().decode(JSONValue.self, from: data)
        guard let stop = DepartureStop.place(raw["station"], acquiredAt: acquiredAt), DepartureStop.id(for: stop) == stopID,
              case .array(let board) = raw["stationboard"] else { throw NativeCoreError.message("Departure source returned a different or unidentified stop.") }
        var rows: [StopDeparture] = []
        for (index, item) in board.prefix(queryLimit).enumerated() {
            let checkpoint = item["stop"]
            guard checkpoint["station"]["id"].string == stopID,
                  let scheduled = date(checkpoint["departure"]), abs(scheduled.timeIntervalSince(acquiredAt)) <= 3 * 86400 else { continue }
            let prognosis = checkpoint["prognosis"]
            let prediction = date(prognosis["departure"]).flatMap { abs($0.timeIntervalSince(scheduled)) <= 12 * 3600 ? $0 : nil }
            let calls = item["passList"].array.prefix(80).enumerated().compactMap { offset, call -> DepartureCall? in
                guard let place = DepartureStop.place(call["station"], acquiredAt: acquiredAt) else { return nil }
                return DepartureCall(id: offset, place: place, scheduledArrival: date(call["arrival"]), scheduledDeparture: date(call["departure"]))
            }
            rows.append(StopDeparture(id: index, serviceName: DepartureStop.text(item["name"]), category: DepartureStop.text(item["category"]),
                line: DepartureStop.text(item["number"]), operatorName: DepartureStop.text(item["operator"]), destination: DepartureStop.text(item["to"]),
                scheduled: scheduled, predicted: prediction, platform: DepartureStop.text(checkpoint["platform"]),
                predictedPlatform: DepartureStop.text(prognosis["platform"]), calls: calls))
        }
        let result = Self(version: 1, stopID: stopID, queryLimit: queryLimit, stop: stop, acquiredAt: acquiredAt,
            responseDate: responseDate, sourceSHA256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(),
            rows: rows, omittedRows: board.count - rows.count)
        guard result.valid(at: now) else { throw NativeCoreError.message("Departure snapshot has invalid or expired dates.") }
        if !board.isEmpty && rows.isEmpty { throw NativeCoreError.message("Departure rows have no valid stop or scheduled time.") }
        return result
    }
    private static func date(_ raw: JSONValue) -> Date? {
        guard let text = raw.string, text.count <= 40 else { return nil }
        return WireClock.date(text)
    }
}
