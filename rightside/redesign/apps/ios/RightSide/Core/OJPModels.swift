import Foundation
import CryptoKit

public enum JourneyPlanningSource: String, CaseIterable, Sendable { case communityJSON, occurrenceOJP }

enum OJPIdentity {
    static let provider = "https://transport.opendata.ch/ojp20"
    static func digest(_ raw: JSONValue) -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return SHA256.hash(data: (try? encoder.encode(raw)) ?? Data()).map { String(format: "%02x", $0) }.joined()
    }
    static func stop(_ ref: String) -> Bool {
        ref.utf8.count <= 120 && ref.range(of: "^ch:1:sloid:[0-9]+(?::[0-9]+){0,2}$", options: .regularExpression) != nil
    }
    static func day(_ value: String) -> Bool {
        let format = DateFormatter(); format.locale = Locale(identifier: "en_US_POSIX")
        format.calendar = Calendar(identifier: .gregorian); format.timeZone = TimeZone(secondsFromGMT: 0)
        format.dateFormat = "yyyy-MM-dd"; format.isLenient = false
        return value.count == 10 && format.date(from: value).map { format.string(from: $0) == value } == true
    }
    /// Whole-second UTC avoids a reproduced provider bug with fractional offset requests.
    static func requestTime(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }
    static func date(_ text: String?) throws -> Date? {
        guard let text else { return nil }
        guard text.count <= 40, text.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$", options: .regularExpression) != nil,
              day(String(text.prefix(10))), let value = WireClock.date(text) else { throw OJPError.invalid("Malformed source time") }
        let parts = Array(text); let hour = Int(String(parts[11...12])) ?? 99, minute = Int(String(parts[14...15])) ?? 99, second = Int(String(parts[17...18])) ?? 99
        guard hour < 24, minute < 60, second < 60 else { throw OJPError.invalid("Malformed source clock") }
        if text.last != "Z" {
            let zone = Array(text.suffix(6))
            let hours = Int(String(zone[1...2])) ?? 99, minutes = Int(String(zone[4...5])) ?? 99
            guard hours <= 14, minutes < 60, hours < 14 || minutes == 0 else { throw OJPError.invalid("Invalid UTC offset") }
        }
        return value
    }
}

public struct OJPOccurrence: Codable, Equatable, Hashable, Sendable {
    public let provider: String
    public let journeyRef: String
    public let operatingDay: String
    var valid: Bool { provider == OJPIdentity.provider && !journeyRef.isEmpty && journeyRef.utf8.count <= 512 && !journeyRef.contains("\n") && OJPIdentity.day(operatingDay) }
    var key: String { OJPIdentity.digest(.array([.string(provider), .string(journeyRef), .string(operatingDay)])) }
    static func from(_ leg: Leg) -> Self? {
        let trip = leg.raw["trip"]
        guard let provider = trip["provider"].string, let ref = trip["sourceTripId"].string, let day = trip["operatingDate"].string else { return nil }
        let result = Self(provider: provider, journeyRef: ref, operatingDay: day)
        return result.valid ? result : nil
    }
    var wire: JSONValue { .object(["provider": .string(provider), "feedVersion": .null, "sourceTripId": .string(journeyRef),
        "sjyid": .null, "operatingDate": .string(operatingDay), "tripStartOffsetSeconds": .null, "timezone": .string("Europe/Zurich"), "frequencyWindow": .null]) }
}

public struct OJPSource: Codable, Equatable, Sendable {
    public let acquiredAt: Date
    public let responseTimestamp: Date
    public let httpDate: String?
    public let sha256: String
    public func recent(at now: Date) -> Bool {
        (0...90).contains(now.timeIntervalSince(responseTimestamp)) && (0...90).contains(now.timeIntervalSince(acquiredAt)) && responseTimestamp <= acquiredAt
    }
    var raw: JSONValue { .object(["provider": .string(OJPIdentity.provider), "acquiredAt": .string(WireClock.string(acquiredAt)),
        "responseTimestamp": .string(WireClock.string(responseTimestamp)), "httpDate": .optional(httpDate), "sha256": .string(sha256), "observationTime": .null]) }
    func evidence(predicted: Bool = false) -> JSONValue {
        .array([.object(["source": .string(OJPIdentity.provider), "sourceVersion": .string(sha256),
            "fetchedAt": .string(WireClock.string(acquiredAt)), "validUntil": .string(WireClock.string(responseTimestamp.addingTimeInterval(90))),
            "kind": .string(predicted ? "predicted" : "scheduled"), "quality": .string("supported")])])
    }
    static func make(_ delivery: OJPXML.Node, data: Data, acquiredAt: Date, httpDate: String?) throws -> Self {
        guard let stamp = try OJPIdentity.date(delivery.required("ResponseTimestamp", ns: OJPXML.siri)) else { throw OJPError.invalid("Missing response timestamp") }
        let value = Self(acquiredAt: acquiredAt, responseTimestamp: stamp, httpDate: httpDate,
            sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined())
        guard value.recent(at: acquiredAt) else { throw OJPError.invalid("Future or stale response timestamp") }
        return value
    }
}

public struct OJPServiceCall: Codable, Equatable, Identifiable, Sendable {
    public let order: Int
    public let stopPointRef: String
    public let parentRef: String?
    public let name: String
    public let coordinate: [Double]?
    public let plannedArrival: Date?
    public let plannedDeparture: Date?
    public let expectedArrival: Date?
    public let expectedDeparture: Date?
    public let plannedQuay: String?
    public let estimatedQuay: String?
    public let notServiced: Bool?
    public let noBoarding: Bool?
    public let noAlighting: Bool?
    public var id: Int { order }
    var time: Date? { plannedArrival ?? plannedDeparture }
    func place(source: OJPSource) -> Place {
        Place(raw: .object(["id": .string("\(OJPIdentity.provider):\(stopPointRef)"), "name": .string(name), "kind": .string("stop"),
            "coordinate": coordinate.map { .array($0.map(JSONValue.number)) } ?? .null,
            "parentId": .optional(parentRef.map { "\(OJPIdentity.provider):\($0)" }),
            "sourceRefs": .array([.object(["provider": .string(OJPIdentity.provider), "id": .string(stopPointRef), "feedVersion": .null])]),
            "evidence": source.evidence()]))
    }
}

public struct OJPServiceSnapshot: Codable, Equatable, Sendable {
    public let occurrence: OJPOccurrence
    public let source: OJPSource
    public let line: String?
    public let destination: String?
    public let direction: String?
    public let cancelled: Bool?
    public let calls: [OJPServiceCall]
}
