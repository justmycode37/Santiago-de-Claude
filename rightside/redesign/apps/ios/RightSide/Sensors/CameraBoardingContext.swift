import Foundation

/// Reads immutable provider evidence. This never creates a vehicle binding or refreshes a
/// provider timestamp when the view redraws. Unknown trip/direction identities stay unknown.
enum CameraBoardingContext {
    static func expectation(journey: Journey?, ride: Leg?) -> VehicleServiceExpectation? {
        guard let journey, let ride, ride.kind == "ride", let line = ride.line, let destination = ride.headsign else { return nil }
        let boardID = ride.raw["boardingCallId"].string, alightID = ride.raw["alightingCallId"].string
        let board = ride.calls.first { $0.id == boardID }
        let alight = ride.calls.first { $0.id == alightID }
        let evidence = ride.raw["evidence"].array.map(Evidence.init(raw:))
            + (board?.raw["evidence"].array.map(Evidence.init(raw:)) ?? [])
            + (alight?.raw["evidence"].array.map(Evidence.init(raw:)) ?? [])
        // Fetched-at is the age of this snapshot, not a promise of live vehicle telemetry.
        let stamps = evidence.compactMap { WireClock.date($0.observedAt ?? $0.fetchedAt) }
        let observed = stamps.count == evidence.count && !stamps.isEmpty ? stamps.min() : nil
        let latestObserved = observed == nil ? nil : stamps.max()
        let declaredExpiries = evidence.filter {
            if case let .object(fields) = $0.raw { return fields.keys.contains("validUntil") }
            return false
        }
        let explicitExpiries = declaredExpiries.compactMap { item -> Date? in
            guard let expiry = item.raw["validUntil"].string.flatMap(WireClock.date),
                  let ownObservation = WireClock.date(item.observedAt ?? item.fetchedAt), expiry > ownObservation else { return nil }
            return expiry
        }
        let until = observed.flatMap { observed -> Date? in
            guard explicitExpiries.count == declaredExpiries.count,
                  explicitExpiries.allSatisfy({ $0 > observed }) else { return nil }
            return min(observed.addingTimeInterval(90), explicitExpiries.min() ?? .distantFuture)
        }
        let trip = ride.raw["trip"]
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let occurrence = trip == .null ? nil : (try? encoder.encode(trip)).map { String(decoding: $0, as: UTF8.self) }
        let downstream = ride.calls.firstIndex(where: { $0.id == boardID }).map { index in
            ride.calls.dropFirst(index + 1).map { VehicleExpectedCall(id: $0.id, stopID: $0.place.id, name: $0.place.name) }
        } ?? []
        return VehicleServiceExpectation(line: line, destination: destination,
            tripID: trip["sjyid"].string ?? trip["sourceTripId"].string,
            boardingStopID: board?.place.id, alightingStopID: alight?.place.id,
            directionID: ride.raw["directionId"].string, validUntil: until,
            requiresRouteContext: true, revision: journey.revision, observedAt: observed,
            tripOccurrenceKey: occurrence, boardingCallID: boardID,
            alightingCallID: alightID, downstreamCalls: downstream, boardingUnavailable: ride.boardingUnavailable,
            latestObservedAt: latestObserved,
            alightingUnavailable: alight.map { ["cancelled", "skipped"].contains($0.status) || $0.raw["dropoff"].string == "forbidden" } ?? false)
    }
    // Boarding-point identity deliberately comes from A's shared SpatialResolution, not from
    // an independently interpreted platform label or arbitrary provider sourceRef.
}
