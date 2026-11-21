import Foundation

/// Geometry precision is independent of itinerary/call precision. A mapped
/// corridor never confirms the current trip, passenger pose or boarding area.
struct TransitGeometrySource: Codable, Equatable, Sendable {
    let file: String
    let url: String
    let sha256: String
    let acquiredAt: String
    let responseDate: String
    let responseDateBasis: String
    let attribution: String
    let licenceURL: String
    var acquiredDate: Date? { WireClock.date(acquiredAt) }
    func fresh(at now: Date, boarding: Date) -> Bool {
        guard sha256.count == 64, sha256.allSatisfy({ $0.isHexDigit }),
              let acquired = acquiredDate, let dataset = WireClock.date(responseDate) else { return false }
        let limit = 30.0 * 86_400
        return (0...limit).contains(now.timeIntervalSince(acquired)) &&
            (0...limit).contains(now.timeIntervalSince(dataset)) &&
            abs(boarding.timeIntervalSince(dataset)) <= limit
    }
}
struct TransitCorridorStop: Codable, Equatable, Sendable {
    let nodeID: Int64
    let name: String
    let uicName: String?
    let uicRef: String?
    let coordinate: [Double]?
}
struct TransitCorridorPath: Codable, Equatable, Sendable {
    let nodes: [Int64]
    let coordinates: [[Double]]
    var valid: Bool {
        (2...20_000).contains(nodes.count) && nodes.count == coordinates.count && coordinates.allSatisfy(TransitGeometryMath.valid)
    }
}
struct TransitCorridor: Codable, Equatable, Sendable {
    let relationID: Int64
    let version: Int
    let modifiedAt: String
    let tags: [String: String]
    let stops: [TransitCorridorStop]
    let paths: [TransitCorridorPath]
    let brokenWays: Int
    let source: TransitGeometrySource
    var line: String { tags["ref"] ?? "" }
    var mode: String { tags["route"] == "trolleybus" ? "bus" : tags["route"] ?? "unknown" }
    var name: String { tags["name"] ?? "Mapped transit relation" }
}
struct TransitGeometrySegment: Codable, Equatable, Sendable, Identifiable {
    let fromCallID: String
    let toCallID: String
    let coordinates: [[Double]]
    var id: String { fromCallID + "→" + toCallID }
    var valid: Bool { (2...20_000).contains(coordinates.count) && coordinates.allSatisfy(TransitGeometryMath.valid) }
}
struct TransitLegGeometry: Codable, Equatable, Sendable {
    enum Precision: String, Codable, Sendable { case mappedCorridor, partialCorridor, schematic, ambiguous, stale, unavailable }
    let leg: Leg
    let precision: Precision
    let segments: [TransitGeometrySegment]
    let relationID: Int64?
    let relationName: String?
    let relationModifiedAt: String?
    let source: TransitGeometrySource?
    let reasons: [String]
    var label: String {
        switch precision {
        case .mappedCorridor: return "Mapped corridor · trip path unverified"
        case .partialCorridor: return "Partial mapped corridor · gaps remain"
        case .schematic: return "Schematic stop connections"
        case .ambiguous: return "Route alignment ambiguous · schematic only"
        case .stale: return "Mapped source expired or date unsupported · schematic only"
        case .unavailable: return "Mapped corridor unavailable"
        }
    }
    func usable(at now: Date) -> Bool {
        guard !segments.isEmpty, segments.allSatisfy(\.valid),
              let start = WireClock.date(leg.plannedStart), let source else { return false }
        return source.fresh(at: now, boarding: start)
    }
}
struct TransitJourneyGeometry: Codable, Equatable, Sendable {
    // Version 1 allowed independently matched intervals with inconsistent path occurrences.
    static let currentVersion = 2
    let version: Int
    let journey: Journey
    let sourceDigest: String
    let legs: [TransitLegGeometry]
    var valid: Bool {
        version == Self.currentVersion && sourceDigest.count == 64 && sourceDigest.allSatisfy({ $0.isHexDigit }) && journey.legs.count <= 100 && legs.count <= 40 &&
        Set(legs.map { $0.leg.id }).count == legs.count &&
        legs.allSatisfy { journey.legs.contains($0.leg) && $0.leg.kind == "ride" && $0.segments.allSatisfy(\.valid) } &&
        legs.reduce(0, { $0 + $1.segments.reduce(0, { $0 + $1.coordinates.count }) }) <= 60_000
    }
    func resolution(for requestedJourney: Journey, leg: Leg, at now: Date) -> TransitLegGeometry? {
        guard valid, journey == requestedJourney, journey.legs.contains(leg),
              let match = legs.first(where: { $0.leg == leg }) else { return nil }
        if !match.segments.isEmpty && !match.usable(at: now) {
            return TransitLegGeometry(leg: leg, precision: .stale, segments: [], relationID: match.relationID,
                relationName: match.relationName, relationModifiedAt: match.relationModifiedAt,
                source: match.source, reasons: ["The source snapshot is expired, future-dated or outside this boarding date."])
        }
        return match
    }
}

enum TransitGeometryMath {
    static func valid(_ point: [Double]) -> Bool {
        point.count == 2 && point.allSatisfy(\.isFinite) && abs(point[0]) <= 180 && abs(point[1]) <= 90
    }
    static func name(_ text: String) -> String {
        text.precomposedStringWithCanonicalMapping.lowercased().unicodeScalars
            .filter { CharacterSet.alphanumerics.contains($0) }.map(String.init).joined()
    }
    static func distance(_ a: [Double], _ b: [Double]) -> Double {
        guard valid(a), valid(b) else { return .infinity }
        let radians = Double.pi / 180, lat1 = a[1] * radians, lat2 = b[1] * radians
        let dlat = lat2 - lat1, dlon = (b[0] - a[0]) * radians
        let h = pow(sin(dlat / 2), 2) + cos(lat1) * cos(lat2) * pow(sin(dlon / 2), 2)
        return 6_371_000 * 2 * asin(sqrt(min(1, max(0, h))))
    }
    static func day(_ date: Date) -> String {
        let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(identifier: "Europe/Zurich")
        formatter.dateFormat = "yyyy-MM-dd"; return formatter.string(from: date)
    }
    static func validDay(_ text: String) -> Bool {
        guard text.count == 10, let date = WireClock.date(text + "T12:00:00+01:00") else { return false }
        return day(date) == text
    }
}

struct TransitGeometryResolver: Sendable {
    let corridors: [TransitCorridor]
    func resolve(_ journey: Journey, sourceDigest: String, at now: Date) -> TransitJourneyGeometry {
        var remaining = 60_000
        let legs = journey.legs.filter { $0.kind == "ride" }.prefix(40).map { leg in
            let result = resolve(leg, at: now, maximumOutputPoints: remaining)
            remaining -= result.segments.reduce(0) { $0 + $1.coordinates.count }
            return result
        }
        return TransitJourneyGeometry(version: TransitJourneyGeometry.currentVersion, journey: journey,
            sourceDigest: sourceDigest, legs: legs)
    }
    func resolve(_ leg: Leg, at now: Date, maximumOutputPoints: Int = 60_000) -> TransitLegGeometry {
        func fallback(_ precision: TransitLegGeometry.Precision, _ reason: String) -> TransitLegGeometry {
            TransitLegGeometry(leg: leg, precision: precision, segments: [], relationID: nil, relationName: nil,
                relationModifiedAt: nil, source: nil, reasons: [reason])
        }
        // Preserve existing actual provider paths; do not replace them with a
        // lower-precision OSM candidate. Rendering continues to use that DTO.
        if let geometry = leg.geometry, ["routed", "surveyed"].contains(geometry.quality) {
            return fallback(.unavailable, "The itinerary already carries provider route geometry; retained unchanged.")
        }
        guard leg.kind == "ride", let line = leg.line, !line.isEmpty,
              let headsign = leg.headsign, !headsign.isEmpty,
              let boarding = WireClock.date(leg.plannedStart),
              let serviceDay = leg.raw["trip"]["operatingDate"].string, TransitGeometryMath.validDay(serviceDay),
              leg.raw["trip"]["provider"].string == "transport.opendata.ch" else {
            return fallback(.schematic, "Line, direction, provider or operating date is unavailable.")
        }
        let calls = leg.calls
        guard (2...100).contains(calls.count), calls.first?.id == leg.raw["boardingCallId"].string,
              calls.last?.id == leg.raw["alightingCallId"].string, Set(calls.map(\.id)).count == calls.count else {
            return fallback(.ambiguous, "The intended boarding/alighting call order is not unambiguous.")
        }
        // Repeated station identity can be a loop or a second visit. No local
        // ordinal is promoted into a provider stop occurrence; abstain here.
        let identifiers = calls.map { providerStopID($0.place) ?? TransitGeometryMath.name($0.place.name) }
        guard Set(identifiers).count == identifiers.count else {
            return fallback(.ambiguous, "Repeated stops need occurrence-aware route evidence; corridor withheld.")
        }
        let possible = corridors.filter { corridor in
            corridor.line == line && corridor.mode == leg.mode &&
            TransitGeometryMath.name(corridor.tags["to"] ?? "") == TransitGeometryMath.name(headsign) &&
            corridor.tags["network"] == "Libero" &&
            ["Bernmobil", "BERNMOBIL"].contains(corridor.tags["operator"] ?? "")
        }
        var candidates: [(TransitCorridor, ArraySlice<TransitCorridorStop>)] = []
        for corridor in possible where corridor.stops.count >= calls.count {
            for first in 0...(corridor.stops.count - calls.count) {
                let selected = corridor.stops[first..<(first + calls.count)]
                if zip(calls, selected).allSatisfy({ matches($0.0.place, $0.1) }) { candidates.append((corridor, selected)) }
            }
        }
        guard candidates.count == 1 else {
            return fallback(candidates.isEmpty ? .schematic : .ambiguous,
                candidates.isEmpty ? "No single mapped direction contains all reported calls in order." : "Several relation/stop occurrences fit; no first-match selection was made.")
        }
        let (corridor, slice) = candidates[0]
        guard corridor.source.fresh(at: now, boarding: boarding), validCalendar(corridor, boarding: boarding) else {
            return fallback(.stale, "Mapped data is expired, future-dated or outside its stated calendar validity.")
        }
        let stops = Array(slice)
        guard Set(stops.map(\.nodeID)).count == stops.count else {
            return fallback(.ambiguous, "Repeated mapped stop occurrences need additional binding evidence.")
        }
        // Index each path once. Count occurrence matches before allocating coordinate slices.
        // Budgets apply before traversal/allocation, not only to the persisted envelope.
        let wanted = Set(stops.map(\.nodeID))
        var indexed: [(path: TransitCorridorPath, positions: [Int64: [Int]])] = []
        var nodeBudget = 200_000
        for path in corridor.paths {
            guard path.nodes.count <= nodeBudget else {
                return fallback(.unavailable, "Mapped route exceeds the supported geometry budget.")
            }
            nodeBudget -= path.nodes.count
            guard path.valid else { continue }
            var positions: [Int64: [Int]] = [:]
            for (index, node) in path.nodes.enumerated() where wanted.contains(node) {
                positions[node, default: []].append(index)
            }
            indexed.append((path, positions))
        }
        var selections: [(interval: Int, path: Int, first: Int, last: Int)] = []
        var pointBudget = max(0, min(60_000, maximumOutputPoints))
        for index in 0..<(calls.count - 1) {
            var match: (path: Int, first: Int, last: Int)?
            var count = 0
            for (pathIndex, entry) in indexed.enumerated() {
                let firsts = entry.positions[stops[index].nodeID] ?? []
                let lasts = entry.positions[stops[index + 1].nodeID] ?? []
                for first in firsts {
                    // First strictly later occurrence, in logarithmic time even when none fits.
                    var low = 0, high = lasts.count
                    while low < high {
                        let middle = low + (high - low) / 2
                        if lasts[middle] <= first { low = middle + 1 } else { high = middle }
                    }
                    guard low < lasts.count else { continue }
                    count = min(2, count + lasts.count - low)
                    if count == 2 { break }
                    match = (pathIndex, first, lasts[low])
                }
                if count == 2 { break }
            }
            // Broken topology and multiple traversals are visible gaps. Never
            // bridge by straight line, nearest way or shortest road path.
            if count == 1, let match {
                if let previous = selections.last {
                    guard match.path >= previous.path,
                          match.path != previous.path || match.first >= previous.last,
                          previous.interval + 1 != index || (match.path == previous.path && match.first == previous.last) else {
                        return fallback(.ambiguous, "Mapped intervals do not form a consistent ordered traversal; corridor withheld.")
                    }
                }
                let points = match.last - match.first + 1
                guard points <= pointBudget else {
                    return fallback(.unavailable, "Mapped route exceeds the supported geometry budget.")
                }
                pointBudget -= points
                selections.append((index, match.path, match.first, match.last))
            }
        }
        let segments = selections.map { selected in
            TransitGeometrySegment(fromCallID: calls[selected.interval].id, toCallID: calls[selected.interval + 1].id,
                coordinates: Array(indexed[selected.path].path.coordinates[selected.first...selected.last]))
        }
        let all = segments.count == calls.count - 1
        return TransitLegGeometry(leg: leg, precision: segments.isEmpty ? .unavailable : all ? .mappedCorridor : .partialCorridor,
            segments: segments, relationID: corridor.relationID, relationName: corridor.name,
            relationModifiedAt: corridor.modifiedAt, source: corridor.source,
            reasons: ["Joined by line, mode, destination and the complete ordered stop list; current trip path and service calendar are unverified.",
                "\(segments.count) of \(calls.count - 1) stop intervals have unique continuous mapped geometry. \(corridor.brokenWays) source-way breaks retained."])
    }
    private func providerStopID(_ place: Place) -> String? {
        place.raw["sourceRefs"].array.first { $0["provider"].string == "transport.opendata.ch" }?["id"].string
    }
    private func matches(_ place: Place, _ stop: TransitCorridorStop) -> Bool {
        guard let point = place.coordinate, let mapped = stop.coordinate,
              TransitGeometryMath.distance(point, mapped) <= 300 else { return false }
        if let expected = providerStopID(place), let mapped = stop.uicRef { return expected == mapped }
        // Only exact punctuation/case-normalized full physical names, supported
        // by bounded coordinate agreement. No substring/fuzzy nearest-stop join.
        let expected = TransitGeometryMath.name(place.name)
        return !expected.isEmpty && expected == TransitGeometryMath.name(stop.uicName ?? stop.name)
    }
    private func validCalendar(_ corridor: TransitCorridor, boarding: Date) -> Bool {
        let day = TransitGeometryMath.day(boarding)
        if let first = corridor.tags["start_date"], (!TransitGeometryMath.validDay(first) || day < first) { return false }
        if let last = corridor.tags["end_date"], (!TransitGeometryMath.validDay(last) || day > last) { return false }
        return true
    }
}
