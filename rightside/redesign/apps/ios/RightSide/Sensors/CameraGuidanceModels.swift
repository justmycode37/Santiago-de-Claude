import Foundation
import CoreLocation
import CoreGraphics
import Combine
import ImageIO

struct VisualLocation {
    let coordinate: CLLocationCoordinate2D
    let capturedAt: Date
    var maximumAge: TimeInterval = 10
    var validUntil: Date? = nil
}
@MainActor final class VisualLocationStore: ObservableObject {
    @Published var observation: VisualLocation?
    func fresh(at now: Date = Date()) -> VisualLocation? {
        guard let observation, observation.maximumAge.isFinite, observation.maximumAge > 0,
              observation.validUntil.map({ $0.timeIntervalSince1970.isFinite && now < $0 }) ?? true,
              now.timeIntervalSince(observation.capturedAt) <= observation.maximumAge,
              !SensorFixFreshness.isStale(timestamp: observation.capturedAt, now: now) else { return nil }
        return observation
    }
}

struct CameraJourneyContext {
    let id: String
    let title: String
    let line: String?
    let destination: String?
    let stop: String?
    let target: CLLocationCoordinate2D?
    let targetLabel: String
    let simulated: Bool
    var boardingStopID: String? = nil
    // Specific, resolved boarding-point identity. A station/parent stop is insufficient for roadside selection.
    var boardingPointID: String? = nil
    var serviceExpectation: VehicleServiceExpectation? = nil

    func match(_ text: String) -> String? {
        if let stop, Self.containsPhrase(text, phrase: stop) { return "Stop text · check sign" }
        if let destination, Self.containsPhrase(text, phrase: destination) { return "Destination text · check vehicle" }
        if let line, Self.containsPhrase(text, phrase: line) { return "Line text · service unconfirmed" }
        return nil
    }
    static func containsPhrase(_ text: String, phrase: String) -> Bool {
        func tokens(_ value: String) -> [String] {
            value.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX"))
                .components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
        }
        let haystack = tokens(text), needle = tokens(phrase)
        guard !needle.isEmpty, haystack.count >= needle.count else { return false }
        return (0...(haystack.count - needle.count)).contains { Array(haystack[$0..<($0 + needle.count)]) == needle }
    }
}

struct CameraTextMatch: Identifiable {
    let id = UUID()
    let box: CGRect
    let text: String
    let label: String
}

enum CameraImageGeometry {
    static func rawBox(_ vision: CGRect, orientation: CGImagePropertyOrientation) -> CGRect {
        let top = CGRect(x: vision.minX, y: 1 - vision.maxY, width: vision.width, height: vision.height)
        switch orientation {
        case .right: return CGRect(x: top.minY, y: 1 - top.maxX, width: top.height, height: top.width)
        case .left: return CGRect(x: 1 - top.maxY, y: top.minX, width: top.height, height: top.width)
        case .down: return CGRect(x: 1 - top.maxX, y: 1 - top.maxY, width: top.width, height: top.height)
        default: return top
        }
    }
}

