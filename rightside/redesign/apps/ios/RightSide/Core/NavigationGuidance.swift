import Foundation

// Native semantics inspired by Kante stand.tsx / journey.ts at
// 48937e8db210fd3ed9a0d956d9717319f4ab2eae. Independently implemented;
// no clock-derived passenger progress, inferred curb or default floor.
struct BoardingSummary: Equatable {
    let sign: String?
    let plannedSign: String?
    let nextStop: String?
    let level: String?
    let unavailable: Bool
    let precision: String
    var changed: Bool { sign != nil && plannedSign != nil && sign != plannedSign }

    init(_ leg: Leg) {
        let call = leg.calls.first { $0.id == leg.raw["boardingCallId"].string }
        sign = leg.boardingTarget?.assignment.label
        plannedSign = call?.raw["plannedAssignment"]["label"].string
        if let index = leg.calls.firstIndex(where: { $0.id == leg.raw["boardingCallId"].string }), index + 1 < leg.calls.count {
            nextStop = leg.calls[index + 1].place.name
        } else { nextStop = nil }
        level = leg.boardingTarget?.raw["level"].string
        unavailable = leg.boardingUnavailable
        precision = leg.boardingTarget?.pedestrianTargetStatus == "verified_area" ? "Source identifies a pedestrian area; check local signs." : "Stop reference only · exact waiting area unverified"
    }
}

struct SourceSnapshotAge: Equatable {
    let observedAt: Date?
    let freshPrediction: Bool
    init(_ journey: Journey, offline: Bool, now: Date) {
        let dates = journey.evidence.compactMap { WireClock.date($0.observedAt ?? $0.fetchedAt) }
        // Oldest contributing evidence is conservative. Rendering never refreshes it.
        observedAt = dates.min()
        freshPrediction = !offline && !journey.evidence.isEmpty && dates.count == journey.evidence.count && dates.allSatisfy { (0...90).contains(now.timeIntervalSince($0)) }
    }
}

struct ServiceTimeAssessment: Equatable {
    enum Basis: String { case timetable, prediction }
    let instant: String
    let basis: Basis
    static func forLeg(_ leg: Leg, arrival: Bool = false, offline: Bool, now: Date) -> Self {
        let callID = leg.raw[arrival ? "alightingCallId" : "boardingCallId"].string
        let call = leg.calls.first { $0.id == callID }
        let callPrediction = arrival ? call?.expectedArrival : call?.expectedDeparture
        let predicted = callPrediction ?? (arrival ? leg.expectedEnd : leg.expectedStart)
        let evidence = callPrediction != nil ? (call?.raw["evidence"].array.map(Evidence.init(raw:)) ?? []) : leg.evidence
        let fresh = !offline && !evidence.isEmpty && evidence.contains(where: { $0.kind == "predicted" }) && evidence.allSatisfy { item in
            guard let date = WireClock.date(item.observedAt ?? item.fetchedAt), (0...90).contains(now.timeIntervalSince(date)) else { return false }
            if let expiry = item.raw["validUntil"].string { return WireClock.date(expiry).map { $0 >= now } == true }
            return true
        }
        if fresh, let predicted, WireClock.date(predicted) != nil { return Self(instant: predicted, basis: .prediction) }
        return Self(instant: arrival ? leg.plannedEnd : leg.plannedStart, basis: .timetable)
    }
}

struct TransferAssessment: Equatable {
    enum Status: String { case unknown, available, tight, insufficient, unavailable }
    let status: Status
    let availableSeconds: Double?
    let walkSeconds: Double?
    let spareSeconds: Double?
    let usesPrediction: Bool
    let explanation: String

    static func assess(incoming: Leg, outgoing: Leg, walkingSeconds: Double?, offline: Bool, now: Date) -> Self {
        guard let alighting = incoming.calls.first(where: { $0.id == incoming.raw["alightingCallId"].string }) else {
            return Self(status: .unknown, availableSeconds: nil, walkSeconds: walkingSeconds, spareSeconds: nil, usesPrediction: false, explanation: "The intended alighting call is unavailable.")
        }
        guard !incoming.boardingUnavailable, !outgoing.boardingUnavailable,
              !["cancelled", "skipped"].contains(alighting.status), alighting.raw["dropoff"].string != "forbidden" else {
            return Self(status: .unavailable, availableSeconds: nil, walkSeconds: walkingSeconds, spareSeconds: nil, usesPrediction: false, explanation: "Service or stop unavailable. Find another connection.")
        }
        let incomingTime = ServiceTimeAssessment.forLeg(incoming, arrival: true, offline: offline, now: now)
        let outgoingTime = ServiceTimeAssessment.forLeg(outgoing, offline: offline, now: now)
        let incomingPrediction = incomingTime.basis == .prediction, outgoingPrediction = outgoingTime.basis == .prediction
        let prediction = incomingPrediction || outgoingPrediction
        let basis = incomingPrediction == outgoingPrediction ? (prediction ? "Predicted times" : "Timetable times") : "Mixed basis: incoming \(incomingTime.basis.rawValue), outgoing \(outgoingTime.basis.rawValue)"
        guard let arrival = WireClock.date(incomingTime.instant), let departure = WireClock.date(outgoingTime.instant) else {
            return Self(status: .unknown, availableSeconds: nil, walkSeconds: walkingSeconds, spareSeconds: nil, usesPrediction: false, explanation: "Transfer times unavailable.")
        }
        let available = departure.timeIntervalSince(arrival)
        guard let walk = walkingSeconds, walk.isFinite, walk >= 0 else {
            return Self(status: available < 0 ? .insufficient : .unknown, availableSeconds: available, walkSeconds: nil, spareSeconds: nil, usesPrediction: prediction, explanation: "\(basis). Walking time unknown. Allow time to find the next platform.")
        }
        let spare = available - walk
        return Self(status: spare < 0 ? .insufficient : spare < 120 ? .tight : .available,
                    availableSeconds: available, walkSeconds: walk, spareSeconds: spare, usesPrediction: prediction,
                    explanation: "\(basis) minus mapped walking estimate. Platform access and minimum interchange time are unverified.")
    }
}

public enum JourneyRecoveryReason: String, Codable, CaseIterable, Identifiable {
    case offRoute, missedConnection, missedAlighting, disruption
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .offRoute: return "I am off the walking route"
        case .missedConnection: return "I missed my connection"
        case .missedAlighting: return "I missed my stop"
        case .disruption: return "Service or platform has changed"
        }
    }
}

public struct JourneyPlanningDraft: Codable, Equatable {
    public enum Kind: String, Codable { case returnTrip, recovery }
    public let kind: Kind
    public let journeyID: String
    public var origin: Place
    public var destination: Place
    public var departure: Date
    public var arriveBy: Bool
    public let reason: JourneyRecoveryReason?
    public let createdAt: Date
}

struct JourneyReminderPlan: Equatable {
    let id: String
    let session: UUID
    let at: Date
    let title: String
    let body: String
    static func make(navigation: NavigationSnapshot, session: UUID, now: Date) -> Self? {
        guard navigation.phase != "arrived", !navigation.overlays.disrupted, !navigation.overlays.replanning else { return nil }
        let leg = navigation.currentLeg
        guard leg.kind == "ride", !leg.boardingUnavailable else { return nil }
        let onBoard = ["riding", "alighting"].contains(navigation.phase)
        // A scheduled reminder is never a location-based alarm or a live prediction.
        guard let time = WireClock.date(onBoard ? leg.plannedEnd : leg.plannedStart) else { return nil }
        let trigger = time.addingTimeInterval(-120)
        guard trigger.timeIntervalSince(now) > 5 else { return nil }
        return Self(id: "rightside.journey-reminder", session: session, at: trigger,
                    title: onBoard ? "Timetable reminder: \(leg.to.name)" : "Timetable reminder: \(leg.line ?? "service")",
                    body: onBoard ? "Scheduled arrival is in about 2 minutes. Check the vehicle display and your actual stop; this alert does not know your location." : "Scheduled departure is in about 2 minutes toward \(leg.headsign ?? leg.to.name). Check the current departure board. Times may have changed.")
    }
}
