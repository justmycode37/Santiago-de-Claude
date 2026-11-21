import Foundation
import CoreGraphics

enum TransportClass: String, Codable, CaseIterable { case bus, tram, train }

/// Every rectangle/mask uses upright image coordinates, top-left origin, in [0, 1].
struct VehicleDetection {
    let kind: TransportClass
    let box: CGRect
    let score: Float // Raw model score, never a service confidence or calibrated probability.
    let mask: VehicleMask
}

struct VehicleMask {
    let width: Int
    let height: Int
    let pixels: [UInt8]
    func contains(_ point: CGPoint) -> Bool {
        guard width > 0, height > 0, pixels.count == width * height,
              point.x >= 0, point.y >= 0, point.x < 1, point.y < 1 else { return false }
        return pixels[Int(point.y * Double(height)) * width + Int(point.x * Double(width))] != 0
    }
    var runs: [CGRect] {
        guard width > 0, height > 0, pixels.count == width * height else { return [] }
        var result: [CGRect] = []
        for y in 0..<height {
            var x = 0
            while x < width {
                if pixels[y * width + x] == 0 { x += 1; continue }
                let start = x
                while x < width && pixels[y * width + x] != 0 { x += 1 }
                result.append(CGRect(x: Double(start) / Double(width), y: Double(y) / Double(height),
                                     width: Double(x - start) / Double(width), height: 1 / Double(height)))
            }
        }
        return result
    }
}

struct VehicleText {
    let text: String
    let box: CGRect
    let score: Float
}

struct DisplayReading {
    let frameID: UUID
    let at: Date
    let line: String?
    let destination: String?
    let outOfService: Bool
    let ambiguous: Bool
    let raw: [String]

    /// The badge uses observed spelling where available, never the expected itinerary words.
    var displayText: String? {
        guard !ambiguous, let line, let destination else { return nil }
        let pair = VehicleTextRules.normalize(line + " " + destination)
        if let row = raw.first(where: { VehicleTextRules.normalize($0) == pair }) { return row }
        let lineText = raw.first { VehicleTextRules.normalize($0).replacingOccurrences(of: " ", with: "") == line } ?? line
        let destinationText = raw.first { VehicleTextRules.normalize($0) == destination } ?? destination
        return lineText + " " + destinationText
    }
}

/// Experimental layout support is opt-in until the physical-phone replay is accepted.
enum VehicleDisplayLayout { case routeFirst, eitherSide }

enum VehicleTextRules {
    static func normalize(_ value: String) -> String {
        value.folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive], locale: Locale(identifier: "de_CH"))
            .components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }.joined(separator: " ")
    }
    /// Low-confidence glyphs only propose a second look at actual pixels. They never enter
    /// a reading until independent crop OCR meets the unchanged acceptance threshold.
    /// Require an adjacent readable headsign on this masked vehicle, above the body/plate zone.
    static func refinementRegion(_ texts: [VehicleText], detection: VehicleDetection, otherBoxes: [CGRect], layout: VehicleDisplayLayout = .routeFirst) -> CGRect? {
        let associated = texts.filter { isAssociated($0, detection: detection, otherBoxes: otherBoxes)
            && $0.box.midY < detection.box.minY + detection.box.height * 0.65 }
        let proposals = associated.filter { route in
            route.score >= 0.3 && route.score < 0.7
                && route.text.range(of: #"^[A-Za-z]{0,2}\s?\d{1,3}$"#, options: .regularExpression) != nil
                && associated.contains { $0.score >= 0.7 && adjacentDestination($0, to: route, layout: layout) }
        }.sorted { $0.box.height > $1.box.height }
        guard let proposal = proposals.first else { return nil }
        return proposal.box.insetBy(dx: -proposal.box.height * 0.2, dy: -proposal.box.height * 0.25)
            .intersection(detection.box)
    }

    private static func isAssociated(_ text: VehicleText, detection: VehicleDetection, otherBoxes: [CGRect]) -> Bool {
        guard !text.box.isEmpty, detection.box.contains(text.box),
              !otherBoxes.contains(where: { $0.intersects(text.box) }) else { return false }
        let points = [CGPoint(x: text.box.midX, y: text.box.midY), CGPoint(x: text.box.minX, y: text.box.midY), CGPoint(x: text.box.maxX, y: text.box.midY)]
        return points.allSatisfy { detection.mask.contains($0) }
    }

    static func adjacentDestination(_ text: VehicleText, to route: VehicleText, layout: VehicleDisplayLayout = .routeFirst) -> Bool {
        let height = max(text.box.height, route.box.height)
        guard height > 0, route.box.height > 0,
              abs(text.box.midY - route.box.midY) <= height * 0.3,
              text.box.height / route.box.height >= 0.5, text.box.height / route.box.height <= 1.8,
              text.text.rangeOfCharacter(from: .letters) != nil else { return false }
        let right = text.box.minX >= route.box.maxX && text.box.minX - route.box.maxX <= height * 2
        let left = text.box.maxX <= route.box.minX && route.box.minX - text.box.maxX <= height * 2
        return right || (layout == .eitherSide && left)
    }

    /// No expected journey words are supplied to OCR or inserted into unreadable fields.
    static func read(_ texts: [VehicleText], detection: VehicleDetection, otherBoxes: [CGRect], at: Date, frameID: UUID, layout: VehicleDisplayLayout = .routeFirst) -> DisplayReading {
        let associated = texts.filter { $0.score >= 0.7 && isAssociated($0, detection: detection, otherBoxes: otherBoxes) }
        let raw = associated.map(\.text)
        let closed = raw.contains { value in
            ["ausser betrieb", "außer betrieb", "nicht einsteigen", "dienstfahrt", "extrafahrt", "out of service", "not in service", "depot", "garage"].contains { normalize(value).contains(normalize($0)) }
        }
        // Merge only collinear adjacent fragments from the SAME masked instance and display row.
        // OCR often separates a route numeral from the headsign; independent rows never supply missing fields.
        var displayRows = associated.filter { $0.box.midY < detection.box.minY + detection.box.height * 0.65 }
        let routePattern = #"^[A-Za-z]{0,2}\s?\d{1,3}$"#
        for route in displayRows where route.text.range(of: routePattern, options: .regularExpression) != nil {
            let candidates = displayRows.filter { adjacentDestination($0, to: route, layout: layout) }
            var neighbors: [VehicleText] = []
            for candidate in candidates where layout == .routeFirst || !neighbors.contains(where: {
                normalize($0.text) == normalize(candidate.text) && VehicleTracker.iou($0.box, candidate.box) > 0.5
            }) { neighbors.append(candidate) }
            if neighbors.count == 1, let neighbor = neighbors.first {
                displayRows.append(VehicleText(text: route.text + " " + neighbor.text, box: route.box.union(neighbor.box), score: min(route.score, neighbor.score)))
            }
        }
        let pattern = #"^\s*([A-Za-z]{0,2}\s?\d{1,3}|[A-Za-z])\s+(.+?)\s*$"#
        let regex = try? NSRegularExpression(pattern: pattern)
        var pairs: [(String, String)] = displayRows.compactMap { item in
            guard item.box.midY < detection.box.minY + detection.box.height * 0.65,
                  let match = regex?.firstMatch(in: item.text, range: NSRange(item.text.startIndex..., in: item.text)),
                  let a = Range(match.range(at: 1), in: item.text), let b = Range(match.range(at: 2), in: item.text) else { return nil }
            let destination = String(item.text[b])
            guard destination.rangeOfCharacter(from: .letters) != nil else { return nil }
            return (normalize(String(item.text[a])).replacingOccurrences(of: " ", with: ""), normalize(destination))
        }
        if layout == .eitherSide, let suffix = try? NSRegularExpression(pattern: #"^\s*(.+?)\s+([A-Za-z]{0,2}\s?\d{1,3})\s*$"#) {
            for item in displayRows {
                // A trailing street/address numeral cannot create a route reading. Suffix
                // parsing only vetoes a row that already has a conflicting prefix reading.
                // Right-hand routes require their own observed, spatially paired numeral box.
                guard regex?.firstMatch(in: item.text, range: NSRange(item.text.startIndex..., in: item.text)) != nil,
                      let match = suffix.firstMatch(in: item.text, range: NSRange(item.text.startIndex..., in: item.text)),
                      let a = Range(match.range(at: 2), in: item.text), let b = Range(match.range(at: 1), in: item.text),
                      String(item.text[b]).rangeOfCharacter(from: .letters) != nil else { continue }
                pairs.append((normalize(String(item.text[a])).replacingOccurrences(of: " ", with: ""), normalize(String(item.text[b]))))
            }
        }
        let unique = Set(pairs.map { $0.0 + "|" + $0.1 })
        return DisplayReading(frameID: frameID, at: at, line: unique.count == 1 ? pairs.first?.0 : nil,
                              destination: unique.count == 1 ? pairs.first?.1 : nil, outOfService: closed,
                              ambiguous: unique.count > 1, raw: raw)
    }
}

struct VehicleTrack: Identifiable {
    let id: UUID
    var detection: VehicleDetection
    var lastSeen: Date
    var readings: [DisplayReading]
}

/// Conservative one-to-one association. Ambiguous crossings discard history rather than transfer identity.
struct VehicleTracker {
    private(set) var tracks: [VehicleTrack] = []
    private(set) var lost: [UUID] = []
    private var lastFrameAt: Date?
    static let maximumTracks = 6
    mutating func reset() { lost = tracks.map(\.id); tracks = []; lastFrameAt = nil }
    static func iou(_ a: CGRect, _ b: CGRect) -> Double {
        let intersection = a.intersection(b)
        guard !intersection.isNull else { return 0 }
        let area = intersection.width * intersection.height
        return area / max(0.000001, a.width * a.height + b.width * b.height - area)
    }
    mutating func update(_ incoming: [VehicleDetection], at: Date) {
        guard at.timeIntervalSince1970.isFinite else { reset(); return }
        if let lastFrameAt, at <= lastFrameAt { reset(); return }
        let previous = tracks.filter { at.timeIntervalSince($0.lastSeen) <= 0.9 && at >= $0.lastSeen }
        let detections = Array(incoming.filter { $0.box.width > 0 && $0.box.height > 0 }.prefix(Self.maximumTracks))
        let candidates = detections.map { detection in
            previous.indices.filter { previous[$0].detection.kind == detection.kind && Self.iou(previous[$0].detection.box, detection.box) >= 0.3 }
        }
        var result: [VehicleTrack] = []
        for (index, detection) in detections.enumerated() {
            if candidates[index].count == 1, let old = candidates[index].first,
               candidates.filter({ $0.contains(old) }).count == 1 {
                var track = previous[old]
                track.detection = detection; track.lastSeen = at
                track.readings.removeAll { at.timeIntervalSince($0.at) > 2 || $0.at > at }
                result.append(track)
            } else {
                result.append(VehicleTrack(id: UUID(), detection: detection, lastSeen: at, readings: []))
            }
        }
        let kept = Set(result.map(\.id))
        lost = tracks.map(\.id).filter { !kept.contains($0) }
        tracks = result; lastFrameAt = at
    }
    mutating func record(_ reading: DisplayReading, trackID: UUID) {
        guard let index = tracks.firstIndex(where: { $0.id == trackID }), reading.at == tracks[index].lastSeen,
              !tracks[index].readings.contains(where: { $0.frameID == reading.frameID }) else { return }
        tracks[index].readings.append(reading)
        tracks[index].readings = Array(tracks[index].readings.suffix(6))
    }
}

enum VehicleMatchState: String { case unknown, conflicting, visualCandidate, verifiedService }
struct VehicleDecision {
    let state: VehicleMatchState
    let reason: String
    var label: String {
        switch state {
        case .unknown: return "Service unreadable / unverified"
        case .conflicting: return "Display conflicts · do not use this match"
        case .visualCandidate: return "Display matches · verify service"
        case .verifiedService: return "Service evidence matches · check boarding area"
        }
    }
}

/// An external adapter must supply a fresh, independently associated trip/vehicle binding.
/// A selected itinerary or visual appearance is never allowed to manufacture this evidence.
struct AuthoritativeVehicleBinding {
    let trackID: UUID
    let observedAt: Date
    let validUntil: Date
    let tripID: String
    let boardingStopID: String
    let directionID: String
    let line: String
    let destination: String
    let downstreamStopIDs: [String]
    let cancelled: Bool
    let pickupAllowed: Bool
    let associationVerified: Bool
    var tripOccurrenceKey: String? = nil
    var boardingCallID: String? = nil
    var downstreamCallIDs: [String] = []
}
struct VehicleExpectedCall: Equatable {
    let id: String
    let stopID: String
    let name: String
}
struct VehicleServiceExpectation: Equatable {
    let line: String
    let destination: String
    var tripID: String? = nil
    var boardingStopID: String? = nil
    var alightingStopID: String? = nil
    var directionID: String? = nil
    var validUntil: Date? = nil
    // Selected itinerary context, never evidence identifying the observed vehicle.
    var requiresRouteContext = false
    var revision: Int? = nil
    var observedAt: Date? = nil
    var tripOccurrenceKey: String? = nil
    var boardingCallID: String? = nil
    var alightingCallID: String? = nil
    var downstreamCalls: [VehicleExpectedCall] = []
    var boardingUnavailable = false
    // Keep both bounds: the oldest source detects staleness, the newest detects future contributors.
    var latestObservedAt: Date? = nil
    var alightingUnavailable = false

    func contextDecision(at now: Date) -> VehicleDecision? {
        guard requiresRouteContext else { return nil }
        guard let observedAt, let validUntil, observedAt <= now, (latestObservedAt ?? observedAt) <= now, now < validUntil,
              now.timeIntervalSince(observedAt) <= 90 else {
            return VehicleDecision(state: .unknown, reason: "route_context_stale")
        }
        if boardingUnavailable { return VehicleDecision(state: .conflicting, reason: "selected_boarding_unavailable") }
        if alightingUnavailable { return VehicleDecision(state: .conflicting, reason: "selected_alighting_unavailable") }
        guard revision != nil, boardingCallID != nil, let alightingCallID,
              let alightingStopID, downstreamCalls.contains(where: { $0.id == alightingCallID && $0.stopID == alightingStopID }) else {
            return VehicleDecision(state: .unknown, reason: "route_calls_incomplete")
        }
        if downstreamCalls.filter({ $0.stopID == alightingStopID }).count != 1 {
            return VehicleDecision(state: .unknown, reason: "ambiguous_alighting_call")
        }
        return nil
    }
}
enum VehicleServiceMatcher {
    static func decide(_ track: VehicleTrack, expected: VehicleServiceExpectation?, now: Date,
                       binding: AuthoritativeVehicleBinding? = nil) -> VehicleDecision {
        func answer(_ state: VehicleMatchState, _ reason: String) -> VehicleDecision { VehicleDecision(state: state, reason: reason) }
        guard let expected, !expected.line.isEmpty, !expected.destination.isEmpty else { return answer(.unknown, "missing_journey_display") }
        if let context = expected.contextDecision(at: now) { return context }
        guard now >= track.lastSeen, now.timeIntervalSince(track.lastSeen) < 0.8 else { return answer(.unknown, "track_stale") }
        let readings = track.readings.filter { $0.at <= now && now.timeIntervalSince($0.at) <= 2 }
        guard let latest = readings.last, now.timeIntervalSince(latest.at) < 0.8 else { return answer(.unknown, "display_stale") }
        if readings.contains(where: \.outOfService) { return answer(.conflicting, "out_of_service") }
        if readings.contains(where: \.ambiguous) { return answer(.unknown, "ambiguous_display") }
        let line = VehicleTextRules.normalize(expected.line).replacingOccurrences(of: " ", with: "")
        let destination = VehicleTextRules.normalize(expected.destination)
        if readings.contains(where: { ($0.line != nil && $0.line != line) || ($0.destination != nil && $0.destination != destination) }) {
            if let alightingIndex = expected.downstreamCalls.firstIndex(where: { $0.id == expected.alightingCallID }),
               readings.contains(where: { reading in
                   reading.line == line && expected.downstreamCalls.prefix(alightingIndex).contains { VehicleTextRules.normalize($0.name) == reading.destination }
               }) { return answer(.conflicting, "display_short_turn_before_alighting") }
            return answer(.conflicting, "wrong_line_destination_or_short_working")
        }
        guard latest.line != nil, latest.destination != nil else { return answer(.unknown, "display_unreadable") }
        let complete = readings.filter { $0.line == line && $0.destination == destination }
        guard Set(complete.map(\.frameID)).count >= 3, let first = complete.first,
              latest.at.timeIntervalSince(first.at) >= 0.8 else { return answer(.unknown, "insufficient_temporal_evidence") }
        guard let binding, binding.trackID == track.id, binding.associationVerified,
              !binding.tripID.isEmpty, binding.observedAt <= now, now.timeIntervalSince(binding.observedAt) <= 30,
              binding.validUntil >= now, let until = expected.validUntil, until >= now,
              expected.tripID != nil, expected.boardingStopID != nil, expected.directionID != nil else {
            return answer(.visualCandidate, "no_fresh_authoritative_vehicle_trip_binding")
        }
        guard expected.tripID == binding.tripID, expected.boardingStopID == binding.boardingStopID,
              expected.directionID == binding.directionID,
              VehicleTextRules.normalize(binding.line).replacingOccurrences(of: " ", with: "") == line,
              VehicleTextRules.normalize(binding.destination) == destination else {
            return answer(.conflicting, "authoritative_trip_stop_or_direction_conflict")
        }
        if expected.requiresRouteContext {
            guard let occurrence = expected.tripOccurrenceKey, occurrence == binding.tripOccurrenceKey,
                  expected.boardingCallID == binding.boardingCallID,
                  let alighting = expected.alightingCallID, binding.downstreamCallIDs.contains(alighting) else {
                return answer(.conflicting, "authoritative_call_or_occurrence_conflict")
            }
        }
        guard binding.pickupAllowed, !binding.cancelled, let alighting = expected.alightingStopID,
              binding.downstreamStopIDs.contains(alighting) else { return answer(.conflicting, "trip_cancelled_pickup_forbidden_or_short_working") }
        return answer(.verifiedService, "stable_display_and_authoritative_trip_binding")
    }
}
