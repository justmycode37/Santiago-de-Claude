import Foundation
import CoreGraphics

/// Pure transforms in the upright, downsampled image's pixel space, top-left origin.
enum SensorGeometry {
    static func aspectFit(image: CGSize, container: CGSize) -> CGRect {
        guard image.width.isFinite, image.height.isFinite, container.width.isFinite,
              container.height.isFinite, image.width > 0, image.height > 0,
              container.width > 0, container.height > 0 else { return .zero }
        let scale = min(container.width / image.width, container.height / image.height)
        let size = CGSize(width: image.width * scale, height: image.height * scale)
        return CGRect(x: (container.width - size.width) / 2,
                      y: (container.height - size.height) / 2, width: size.width, height: size.height)
    }

    static func pixelCrop(normalized: CGRect, image: CGSize) -> CGRect {
        guard [normalized.minX, normalized.minY, normalized.width, normalized.height,
               image.width, image.height].allSatisfy({ $0.isFinite }),
              normalized.width > 0, normalized.height > 0, image.width > 0, image.height > 0 else { return .zero }
        let clipped = normalized.intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
        guard !clipped.isNull, !clipped.isEmpty else { return .zero }
        return CGRect(x: clipped.minX * image.width, y: clipped.minY * image.height,
                      width: clipped.width * image.width, height: clipped.height * image.height)
            .integral.intersection(CGRect(origin: .zero, size: image))
    }

    /// Vision gives a bottom-left normalized box in the cropped image.
    static func visionBox(_ box: CGRect, crop: CGRect) -> CGRect {
        CGRect(x: crop.minX + box.minX * crop.width,
               y: crop.minY + (1 - box.maxY) * crop.height,
               width: box.width * crop.width, height: box.height * crop.height)
    }
}

struct SensorResultEpoch {
    private(set) var token = UUID()
    mutating func invalidate() { token = UUID() }
    func accepts(_ candidate: UUID) -> Bool { candidate == token }
}

/// Deliberately never derives a service match from single-frame OCR or a line number.
enum CameraEvidencePolicy {
    static let serviceStatus = "Service unconfirmed"
    static let explanation = "Text is an observation only. Line, destination, correct vehicle and downstream stop context have not been verified together."
}

enum SensorFixFreshness {
    static func isStale(timestamp: Date?, now: Date = Date()) -> Bool {
        guard let timestamp else { return true }
        let age = now.timeIntervalSince(timestamp)
        return !age.isFinite || age > 10 || age < 0
    }
}

/// Independent Codable wire adapter; does not duplicate or depend on the Core DTO's name.
struct SensorPositionPayload: Encodable {
    struct Evidence: Encodable {
        let source = "apple.corelocation"
        let fetchedAt: String
        let observedAt: String
        let kind = "observed"
        let quality = "unknown"
    }
    let capturedAt: String
    let rawCoordinate: [Double]
    let horizontalAccuracyMeters: Double
    let floorCandidates: [String]
    let evidence: [Evidence]

    init?(longitude: Double, latitude: Double, accuracy: Double, timestamp: Date, receivedAt: Date, floor: Int?) {
        guard longitude.isFinite, latitude.isFinite, accuracy.isFinite,
              (-180...180).contains(longitude), (-90...90).contains(latitude), accuracy >= 0,
              timestamp.timeIntervalSince1970.isFinite, receivedAt.timeIntervalSince1970.isFinite else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        capturedAt = formatter.string(from: timestamp)
        rawCoordinate = [longitude, latitude]
        horizontalAccuracyMeters = accuracy
        floorCandidates = floor.map { [String($0)] } ?? []
        evidence = [Evidence(fetchedAt: formatter.string(from: receivedAt), observedAt: capturedAt)]
    }

    enum CodingKeys: String, CodingKey {
        case capturedAt, rawCoordinate, filteredCoordinate, horizontalAccuracyMeters, accuracyBasis
        case mapMatchedCoordinate, floorCandidates, mode, confidence, evidence
    }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(capturedAt, forKey: .capturedAt)
        try values.encode(rawCoordinate, forKey: .rawCoordinate)
        try values.encodeNil(forKey: .filteredCoordinate)
        try values.encode(horizontalAccuracyMeters, forKey: .horizontalAccuracyMeters)
        try values.encode("sensor_reported", forKey: .accuracyBasis)
        try values.encodeNil(forKey: .mapMatchedCoordinate)
        try values.encode(floorCandidates, forKey: .floorCandidates)
        // CLLocation may fuse GPS, Wi-Fi and other inputs; do not assert a GPS-only source.
        try values.encode("unknown", forKey: .mode)
        try values.encode("uncertain", forKey: .confidence)
        try values.encode(evidence, forKey: .evidence)
    }
}
