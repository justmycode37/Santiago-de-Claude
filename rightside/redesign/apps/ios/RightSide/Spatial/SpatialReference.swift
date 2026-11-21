import Foundation

/// A geographic reference location, never the passenger's observed camera pose.
struct SpatialCoordinate: Codable, Equatable, Hashable {
    let latitude: Double
    let longitude: Double
    var isValid: Bool { latitude.isFinite && longitude.isFinite && abs(latitude) <= 90 && abs(longitude) <= 180 }
    func distance(to other: Self) -> Double {
        let r = Double.pi / 180, dy = (other.latitude - latitude) * r, dx = (other.longitude - longitude) * r
        let a = pow(sin(dy / 2), 2) + cos(latitude * r) * cos(other.latitude * r) * pow(sin(dx / 2), 2)
        return 6_371_008.8 * 2 * atan2(sqrt(max(0, a)), sqrt(max(0, 1 - a)))
    }
}

enum SpatialFreshness: String, Codable { case current, stale, future, invalid }
enum SpatialPrecision: String, Codable { case unknown, stationReference, boardingReference, mappedCandidate, surveyedPedestrianArea }
enum SpatialResolutionStatus: String, Codable { case unknown, candidate, resolved }

struct SpatialSource: Codable, Equatable, Identifiable {
    let id: String
    let url: String
    let sha256: String
    let fetchedAt: String
    let expiresAt: String
    let license: String
    let attribution: String
    var contentTimestamp: String? = nil
    var provider: String? = nil
    func freshness(at now: Date) -> SpatialFreshness {
        guard let fetched = SpatialTime.date(fetchedAt), let expires = SpatialTime.date(expiresAt),
              expires > fetched, now.timeIntervalSince1970.isFinite else { return .invalid }
        guard fetched <= now else { return .future }
        if let stamp = contentTimestamp {
            guard let content = SpatialTime.date(stamp), content <= fetched.addingTimeInterval(300) else { return .invalid }
            // A successful download of an old database must not refresh its validity.
            guard now.timeIntervalSince(content) <= expires.timeIntervalSince(fetched) else { return .stale }
        }
        return now <= expires ? .current : .stale
    }
    func age(at now: Date) -> TimeInterval? { SpatialTime.date(contentTimestamp ?? fetchedAt).map { now.timeIntervalSince($0) } }
}

struct SpatialFeature: Codable, Equatable, Identifiable {
    enum Kind: String, Codable { case boardingReference, pedestrianPath, entrance, platform, crossing, elevator }
    let id: String
    let kind: Kind
    let name: String
    let sourceID: String
    let geometry: [SpatialCoordinate]
    let precision: SpatialPrecision
    var parentStopID: String? = nil
    /// Explicit aliases from official source columns, never constructed from a label.
    var parentStopAliases: [String] = []
    var signLabel: String? = nil
    var level: String? = nil
    var validFrom: String? = nil
    var validUntil: String? = nil
    var directionDegrees: Double? = nil
    var sourceEditedAt: String? = nil
    var tags: [String: String] = [:]
    var accuracyMeters: Double? = nil
    var coordinate: SpatialCoordinate? { geometry.first }
    var referenceID: String { tags["atlas:sloid"] ?? id }
    func matches(stopID: String) -> Bool { parentStopID == stopID || parentStopAliases.contains(stopID) }
    func valid(on day: String) -> Bool {
        guard SpatialTime.isDay(day) else { return false }
        if let from = validFrom, !SpatialTime.isDay(from) || from > day { return false }
        if let until = validUntil, !SpatialTime.isDay(until) || until < day { return false }
        return true
    }
}

/// The whole occurrence key must survive snapshots, reassignment and repeated stop visits.
struct SpatialCallIdentity: Codable, Equatable, Hashable {
    let provider: String
    let tripID: String
    let serviceDay: String
    let stopID: String
    let stopSequence: Int
    let assignmentRevision: String
    let sourceSnapshotID: String
    var isValid: Bool {
        [provider, tripID, stopID, assignmentRevision, sourceSnapshotID].allSatisfy { !$0.isEmpty && $0.utf8.count <= 256 }
        && stopSequence >= 0 && SpatialTime.isDay(serviceDay)
    }
    var key: String {
        [provider, tripID, serviceDay, stopID, String(stopSequence), assignmentRevision, sourceSnapshotID]
            .map { "\($0.utf8.count):\($0)" }.joined()
    }
}

/// Only an adapter with explicit source call-to-SLOID evidence should construct this.
/// A guessed platform label or nearest coordinate is not an assignment.
struct SpatialBoardingAssignment: Codable, Equatable {
    let call: SpatialCallIdentity
    let boardingPointID: String
    let sourceID: String
    let observedAt: String
    let validUntil: String
    let evidenceReference: String
}
struct SpatialRequest {
    let stopID: String
    var signLabel: String? = nil
    var call: SpatialCallIdentity? = nil
    var assignment: SpatialBoardingAssignment? = nil
    var assignmentSource: SpatialSource? = nil
    /// Calendar validity follows the actual boarding instant, not the trip service-day label (>24h trips).
    var boardingAt: Date? = nil
}
struct SpatialResolution {
    let status: SpatialResolutionStatus
    let precision: SpatialPrecision
    let requestedStopID: String
    let call: SpatialCallIdentity?
    let boardingPoint: SpatialFeature?
    let candidates: [SpatialFeature]
    let sources: [SpatialSource]
    let freshness: SpatialFreshness
    let maximumSourceAgeSeconds: TimeInterval?
    let reasons: [String]
    var boardingPointID: String? { status == .resolved ? boardingPoint?.referenceID : nil }
    var coordinate: SpatialCoordinate? { boardingPoint?.coordinate }
    /// Registry and OSM features never assert a safe pedestrian space or camera position.
    var confirmsWaitingArea: Bool { false }
}

struct SpatialPack: Codable {
    let schemaVersion: Int
    let id: String
    let version: String
    let bbox: [Double]
    let sources: [SpatialSource]
    let features: [SpatialFeature]
    let referenceCatalogues: [String]
}

enum SpatialTime {
    static func date(_ value: String) -> Date? {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    static func isDay(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard bytes.count == 10, bytes[4] == 45, bytes[7] == 45,
              bytes.enumerated().allSatisfy({ $0.offset == 4 || $0.offset == 7 || (48...57).contains($0.element) }) else { return false }
        let pieces = value.split(separator: "-").compactMap { Int($0) }
        guard pieces.count == 3, pieces[0] > 0, (1...12).contains(pieces[1]) else { return false }
        let leap = pieces[0] % 4 == 0 && (pieces[0] % 100 != 0 || pieces[0] % 400 == 0)
        return (1...[31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][pieces[1] - 1]).contains(pieces[2])
    }
    static func swissDay(_ date: Date) -> String {
        guard date.timeIntervalSince1970.isFinite else { return "" }
        var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "Europe/Zurich")!
        let p = c.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", p.year!, p.month!, p.day!)
    }
}
