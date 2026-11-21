import Foundation
import CoreGraphics

/// Reuses the shared domain's vision contract; native visual matches cannot supply trip candidates.
enum VehicleWireAdapter {
    static func observation(_ track: VehicleTrack, at: Date, imageSize: CGSize) -> JSONValue? {
        // A tracked box can be refreshed without OCR (only three tracks are read per frame).
        // Never re-date that track's previous text as a new frame observation.
        guard let reading = track.readings.last, reading.at == at, track.lastSeen == at,
              !reading.ambiguous, !reading.outOfService,
              let line = reading.line, !line.isEmpty,
              let destination = reading.destination, !destination.isEmpty else { return nil }
        let stamp = PackClock.string(reading.at)
        let box = track.detection.box
        return .object([
            "id": .string(UUID().uuidString), "frameId": .string(reading.frameID.uuidString),
            "trackId": .string(track.id.uuidString), "capturedAt": .string(stamp),
            "expiresAt": .string(PackClock.string(at.addingTimeInterval(0.8))),
            "imageWidth": .number(imageSize.width), "imageHeight": .number(imageSize.height),
            "box": .object(["x": .number(box.minX * imageSize.width), "y": .number(box.minY * imageSize.height),
                            "width": .number(box.width * imageSize.width), "height": .number(box.height * imageSize.height)]),
            "rawText": .array(reading.raw.map(JSONValue.string)),
            "lineCandidates": .array([.string(line)]),
            "destinationCandidates": .array([.string(destination)]),
            "candidates": .array([]), // No live trip/vehicle feed is configured. Never copy the selected journey here.
            "association": .string("matched"),
            "evidence": .array([.object(["source": .string("rightside.local-vehicle-vision"), "sourceVersion": .string("1"),
                "fetchedAt": .string(stamp), "observedAt": .string(stamp), "kind": .string("observed"), "quality": .string("supported")])])
        ])
    }
}
