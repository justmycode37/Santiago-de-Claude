import Foundation
import CoreLocation

struct BoardingPointPack: Decodable {
    struct Point: Decodable, Identifiable {
        let id: String
        let stopID: String
        let name: String
        let label: String
        let latitude: Double
        let longitude: Double
        let directionDegrees: Double?
        let validFrom: String
        let validUntil: String
        var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: latitude, longitude: longitude) }
    }
    let schemaVersion: Int
    let id: String
    let version: String
    let fetchedAt: String
    let expiresAt: String
    let attribution: String
    let boardingPoints: [Point]
    func nearby(_ fix: CLLocation, at: Date) -> [Point] {
        guard schemaVersion == 1, let fetched = PackClock.date(fetchedAt), let expires = PackClock.date(expiresAt),
              fetched <= at, expires >= at, at.timeIntervalSince(fix.timestamp) >= 0,
              at.timeIntervalSince(fix.timestamp) < 10, fix.horizontalAccuracy >= 0, fix.horizontalAccuracy <= 25,
              let day = PackClock.swissCivilDay(at) else { return [] }
        return boardingPoints.filter {
            PackClock.isCivilDay($0.validFrom) && PackClock.isCivilDay($0.validUntil)
            && $0.validFrom <= day && $0.validUntil >= day && CLLocationCoordinate2DIsValid($0.coordinate)
            && CLLocation(latitude: $0.latitude, longitude: $0.longitude).distance(from: fix) < 120
        }.sorted { CLLocation(latitude: $0.latitude, longitude: $0.longitude).distance(from: fix)
            < CLLocation(latitude: $1.latitude, longitude: $1.longitude).distance(from: fix) }
    }
}

enum PackClock {
    /// Atlas validity dates describe civil days, not UTC instants or timetable service-day offsets.
    /// Use the Swiss calendar even when the passenger's device uses another time zone.
    static func swissCivilDay(_ value: Date) -> String? {
        guard value.timeIntervalSince1970.isFinite, let zone = TimeZone(identifier: "Europe/Zurich") else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let parts = calendar.dateComponents([.year, .month, .day], from: value)
        guard let year = parts.year, (1...9999).contains(year), let month = parts.month, let day = parts.day else { return nil }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }
    static func isCivilDay(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard bytes.count == 10, bytes[4] == 45, bytes[7] == 45,
              bytes.enumerated().allSatisfy({ $0.offset == 4 || $0.offset == 7 || (48...57).contains($0.element) }) else { return false }
        let parts = value.split(separator: "-")
        guard let year = Int(parts[0]), year > 0, let month = Int(parts[1]), (1...12).contains(month),
              let day = Int(parts[2]) else { return false }
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
        let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        return (1...days[month - 1]).contains(day)
    }
    static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    static func string(_ value: Date) -> String {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: value)
    }
}

struct FleetPack: Decodable {
    struct Entry: Decodable {
        let operatorName: String
        let manufacturer: String
        let model: String
        let kind: TransportClass
        let fleetNumbers: [String]
        let source: String
    }
    let schemaVersion: Int
    let version: String
    let expiresAt: String
    let entries: [Entry]
    /// A number alone or red livery alone is not an operator/fleet identity.
    /// Require explicit operator text and a separate exact number, repeated on the same track.
    func supportingIdentity(for track: VehicleTrack, now: Date) -> String? {
        guard schemaVersion == 1, let expiry = PackClock.date(expiresAt), expiry >= now else { return nil }
        guard now >= track.lastSeen, now.timeIntervalSince(track.lastSeen) < 0.8 else { return nil }
        let recent = track.readings.filter { $0.at <= now && now.timeIntervalSince($0.at) < 2 }
        let matches = entries.filter { entry in
            guard entry.kind == track.detection.kind else { return false }
            let supported = recent.filter { reading in
                let words = reading.raw.map(VehicleTextRules.normalize)
                return words.contains(VehicleTextRules.normalize(entry.operatorName))
                    && entry.fleetNumbers.contains(where: { words.contains($0) })
            }
            return Set(supported.map(\.frameID)).count >= 2
                && (supported.last?.at.timeIntervalSince(supported.first?.at ?? .distantFuture) ?? 0) >= 0.4
        }
        guard matches.count == 1, let entry = matches.first else { return nil }
        let numbers = Set(recent.flatMap(\.raw).map(VehicleTextRules.normalize)).intersection(entry.fleetNumbers)
        guard numbers.count == 1, let number = numbers.first else { return nil }
        return "Fleet reference: \(entry.operatorName) \(entry.manufacturer) \(entry.model) #\(number) · supporting only"
    }
}

enum BundledTransportPacks {
    static func load<T: Decodable>(_ name: String, as type: T.Type) -> T? {
        guard let url = Bundle.main.url(forResource: name, withExtension: "json", subdirectory: "TransportPacks"),
              let data = try? Data(contentsOf: url), data.count <= 2_000_000 else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}
