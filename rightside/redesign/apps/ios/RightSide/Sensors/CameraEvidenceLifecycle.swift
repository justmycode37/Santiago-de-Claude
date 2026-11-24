import Foundation
import CoreGraphics
import SceneKit
import simd

struct CameraVehicleOverlay: Identifiable {
    let id: UUID
    let box: CGRect
    let maskRuns: [CGRect]
    let title: String
    let decision: VehicleDecision
    var displayText: String? = nil
    var capturedAt: Date? = nil

    var symbol: String {
        switch decision.state {
        case .visualCandidate: return "text.viewfinder"
        case .verifiedService: return "checkmark.circle"
        case .conflicting: return "xmark.octagon.fill"
        case .unknown: return "questionmark.circle"
        }
    }
    var badge: String {
        switch decision.state {
        case .visualCandidate: return "Display matches · trip unverified"
        case .verifiedService: return "Service evidence matches"
        case .conflicting:
            switch decision.reason {
            case "out_of_service": return "Out of service · do not board"
            case "display_short_turn_before_alighting": return "Ends before your stop"
            default: return "Different line or destination"
            }
        case .unknown:
            switch decision.reason {
            case "selected_boarding_unavailable": return "Departure unavailable"
            case "selected_alighting_unavailable": return "Your arrival stop is unavailable"
            case "multiple_matching_vehicles": return "Multiple matches · choose one"
            case "route_context_stale": return "Journey needs refresh"
            case "route_calls_incomplete", "ambiguous_alighting_call": return "Destination stop unconfirmed"
            default: return "Cannot confirm yet"
            }
        }
    }
}

/// Main-actor-owned display state. Every invalidation rejects queued publication and clears
/// feedback. Display timeout and a small camera movement alone preserve bounded tracker history
/// (the tracker moves old boxes by the camera's turn), allowing throttled fresh frames to
/// accumulate evidence; a big turn or a context/scene interruption resets that history as well.
struct CameraEvidenceLifecycle {
    enum Invalidation: CaseIterable {
        case restarted, contextChanged, trackingLost, stopped, thermal, failed, moved, turned, expired

        var instruction: String {
            switch self {
            case .restarted: return "Point at the full vehicle and its destination display."
            case .contextChanged: return "Journey changed. Read the line and destination on the vehicle again."
            case .trackingLost: return "Camera tracking interrupted. Hold steady and scan the vehicle again."
            case .stopped: return "Camera stopped. Use the map or reopen the camera to check the display."
            case .thermal: return "Camera recognition paused while the phone cools. Check the line and destination on the vehicle."
            case .failed: return "Vehicle recognition unavailable. Check the line and destination, or use a photo."
            case .moved, .turned: return "Hold steady with the full vehicle and destination display in view."
            case .expired: return "View changed or expired. Read the vehicle's line and destination again."
            }
        }
    }

    private(set) var epoch = UUID()
    private(set) var trackingEpoch = UUID()
    private var generationStartedAt = Date.distantFuture
    private(set) var active = false
    private(set) var vehicles: [CameraVehicleOverlay] = []
    private(set) var matches: [CameraTextMatch] = []
    private(set) var recognition = Invalidation.restarted.instruction
    private(set) var feedbackID: UUID?
    private(set) var expiresAt: Date?

    static func contextChanged(_ old: CameraJourneyContext?, _ new: CameraJourneyContext) -> Bool {
        guard let old else { return true }
        return old.id != new.id || old.line != new.line || old.destination != new.destination
            || old.stop != new.stop || old.boardingStopID != new.boardingStopID
            || old.boardingPointID != new.boardingPointID || old.simulated != new.simulated
            || old.serviceExpectation != new.serviceExpectation
    }

    mutating func start(at now: Date = Date()) {
        active = true
        invalidate(.restarted, at: now)
    }

    mutating func invalidate(_ reason: Invalidation, at now: Date = Date()) {
        epoch = UUID()
        // An expired overlay or a small movement keeps the tracks (the pan reset of the plan's step 1)
        if reason != .expired && reason != .moved { trackingEpoch = UUID() }
        generationStartedAt = now
        vehicles = []; matches = []; feedbackID = nil; expiresAt = nil
        recognition = reason.instruction
        if reason == .stopped { active = false }
    }

    func feedbackExpired(at now: Date) -> Bool {
        expiresAt.map { now >= $0 } ?? false
    }

    /// Called after the controller's monotonic sleep. Wall-clock changes cannot prolong a
    /// highlight; the frame identity prevents an old timer from erasing newer feedback.
    @discardableResult mutating func expire(_ id: UUID, at now: Date) -> Bool {
        guard feedbackID == id else { return false }
        invalidate(.expired, at: now)
        return true
    }

    var candidateID: UUID? {
        let candidates = vehicles.filter { Self.isCandidate($0.decision) }
        return candidates.count == 1 ? candidates.first?.id : nil
    }

    /// How old a picture, its display text and the overlay drawn from them may get, from the processing cadence
    /// (seconds between processed frames). At the normal 0.4 s: 0.7 s, 0.8 s and a 0.5 s lease, as always; throttled
    /// (0.8 s, 1.2 s) they grow with it, so a hot phone's overlay does not lapse before the next frame can renew it.
    static func limits(cadence: TimeInterval) -> (capture: TimeInterval, text: TimeInterval, lease: TimeInterval) {
        let c = min(1.2, max(0.4, cadence.isFinite ? cadence : 0.4))
        return (0.3 + c, 0.4 + c, 0.1 + c)
    }

    /// Only fresh work from the current active generation can publish. Expiry also rejects work
    /// that completed before its queued timer ran; that work must not resurrect a lost highlight.
    @discardableResult mutating func publish(vehicles incoming: [CameraVehicleOverlay], matches signs: [CameraTextMatch],
                                             token: UUID, capturedAt: Date, now: Date, routeValidUntil: Date? = nil,
                                             displayIssues: [UUID: DisplayRecognitionIssue] = [:],
                                             cadence: TimeInterval = 0.4) -> Bool {
        guard active, token == epoch else { return false }
        let limit = Self.limits(cadence: cadence)
        guard now.timeIntervalSince1970.isFinite, capturedAt.timeIntervalSince1970.isFinite,
              capturedAt >= generationStartedAt, now >= capturedAt,
              now.timeIntervalSince(capturedAt) < limit.capture, !feedbackExpired(at: now) else {
            invalidate(.expired, at: now)
            return false
        }
        let candidates = incoming.filter { Self.isCandidate($0.decision) }
        let textDates = candidates.compactMap(\.capturedAt)
        guard textDates.count == candidates.count,
              textDates.allSatisfy({ $0.timeIntervalSince1970.isFinite && $0 <= capturedAt && now.timeIntervalSince($0) < limit.text }) else {
            invalidate(.expired, at: now)
            return false
        }
        if !candidates.isEmpty, let routeValidUntil, now >= routeValidUntil {
            invalidate(.expired, at: now)
            return false
        }
        vehicles = incoming.map { vehicle in
            guard candidates.count > 1, Self.isCandidate(vehicle.decision) else { return vehicle }
            return CameraVehicleOverlay(id: vehicle.id, box: vehicle.box, maskRuns: vehicle.maskRuns, title: vehicle.title,
                decision: VehicleDecision(state: .unknown, reason: "multiple_matching_vehicles"),
                displayText: vehicle.displayText, capturedAt: vehicle.capturedAt)
        }
        // Text unrelated to an instance cannot visually compete with a vehicle decision.
        matches = incoming.isEmpty ? signs : []
        if candidates.count == 1 {
            recognition = incoming.count > 1
                ? "One vehicle display matches. Check the highlighted vehicle's line and destination before boarding."
                : "Display matches. Check the line, destination and boarding area before boarding."
        } else if candidates.count > 1 {
            recognition = "More than one display matches. Point at one vehicle and check which service is boarding."
        } else if let conflict = incoming.first(where: { $0.decision.state == .conflicting }) {
            switch conflict.decision.reason {
            case "out_of_service": recognition = "Vehicle is out of service. Do not board; look for another service."
            case "display_short_turn_before_alighting": recognition = "This vehicle's display ends before your stop. Do not board; check another service."
            default: recognition = "Different line or destination. Do not use this vehicle match; check another vehicle's full display."
            }
        } else if incoming.contains(where: { $0.decision.reason == "selected_boarding_unavailable" }) {
            recognition = "This departure is unavailable for boarding. Check another departure or replan."
        } else if incoming.contains(where: { $0.decision.reason == "selected_alighting_unavailable" }) {
            recognition = "This service cannot currently take you to your selected stop. Check another departure or replan."
        } else if incoming.contains(where: { $0.decision.reason == "route_context_stale" }) {
            recognition = "Journey information is out of date. Check current departures before comparing this vehicle."
        } else if incoming.contains(where: { ["route_calls_incomplete", "ambiguous_alighting_call"].contains($0.decision.reason) }) {
            recognition = "Cannot check that this service reaches your stop. Check the departure list or ask staff."
        } else if let issue = incoming.lazy.filter({ $0.decision.state == .unknown }).compactMap({ displayIssues[$0.id] }).first {
            recognition = issue.instruction
        } else if !incoming.isEmpty {
            recognition = "Cannot confirm this vehicle. Hold steady to read its full line and destination."
        } else if let sign = signs.first {
            recognition = "\(sign.label): \(sign.text). Check the vehicle's full line and destination."
        } else {
            recognition = Invalidation.restarted.instruction
        }
        feedbackID = UUID()
        expiresAt = min(now.addingTimeInterval(limit.lease), capturedAt.addingTimeInterval(limit.text))
        if let oldestText = textDates.min() { expiresAt = min(expiresAt!, oldestText.addingTimeInterval(limit.text)) }
        if !candidates.isEmpty, let routeValidUntil { expiresAt = min(expiresAt!, routeValidUntil) }
        return true
    }

    private static func isCandidate(_ decision: VehicleDecision) -> Bool {
        decision.state == .visualCandidate || decision.state == .verifiedService
    }
}

/// Local alignment has a different lifetime from vehicle OCR. Own its actual SceneKit node,
/// usable pose, map observation and passenger assertion as one main-actor transaction.
/// Installed-pack metadata survives invalidation; it is never evidence of current alignment.
@MainActor struct LocalCameraEvidenceLifecycle {
    struct Ticket: Equatable {
        let session: UUID
        let generation: UUID
        let observation: UUID
        let capturedAt: Date
        let expiresAt: Date
    }
    static let maximumAge: TimeInterval = 0.5
    var installedPackDescription = "No surveyed local landmark pack installed."
    private(set) var status = "Local area unconfirmed. Use the map or current signs."
    private(set) var generation = UUID()
    private(set) var session = UUID()
    private(set) var active = false
    private var generationStartedAt = Date.distantFuture
    private var lastAcceptedAt: Date?
    private var lastEvaluationFrameTime: TimeInterval?
    private var areaIdentity: String?
    private(set) var ticket: Ticket?
    private(set) var pose: simd_float4x4?
    private(set) var areaNode: SCNNode?

    mutating func start(session: UUID, at now: Date, visual: VisualLocationStore?, resetAlignment: () -> Void) {
        self.session = session; active = true
        invalidate(.restarted, at: now, visual: visual, resetAlignment: resetAlignment)
    }

    /// Candidate collection removes assertions, not the acquisition epoch. A fresh asynchronous
    /// result may have been captured before this display-only transition. Hard invalidation below
    /// still rejects every completion captured before a real reset/context/tracking boundary.
    mutating func clearPresentation(visual: VisualLocationStore?) {
        areaNode?.removeFromParentNode(); areaNode = nil
        pose = nil; visual?.observation = nil; ticket = nil
        areaIdentity = nil
        status = "Local area unconfirmed. Keep the surveyed references in view."
    }

    mutating func invalidate(_ reason: CameraEvidenceLifecycle.Invalidation, at now: Date,
                             visual: VisualLocationStore?, resetAlignment: () -> Void) {
        // No suspension point: rendered node, usable pose and affirmative text disappear together.
        areaNode?.removeFromParentNode(); areaNode = nil
        pose = nil; visual?.observation = nil; ticket = nil
        areaIdentity = nil
        resetAlignment()
        generation = UUID(); generationStartedAt = now; lastAcceptedAt = nil; lastEvaluationFrameTime = nil
        if reason == .stopped { active = false }
        switch reason {
        case .stopped: status = "Local camera guidance stopped. Use the map or reopen the camera."
        case .expired: status = "Local alignment expired. Scan the surveyed references again."
        case .contextChanged: status = "Boarding context changed. Confirm the local references again."
        case .failed: status = "Local area unconfirmed. Use the map or current signs."
        case .thermal: status = "Local camera guidance paused while the phone cools. Use the map."
        default: status = "Local area unconfirmed. Keep the surveyed references in view."
        }
    }

    @discardableResult mutating func publish(pose: simd_float4x4, location: VisualLocation,
        area: (label: String, node: SCNNode)?, root: SCNNode, session: UUID, generation: UUID,
        capturedAt: Date, now: Date, validUntil: Date? = nil, areaIdentity: String? = nil,
        evaluationFrameTime: TimeInterval? = nil,
        visual: VisualLocationStore?, resetAlignment: () -> Void) -> Bool {
        guard active, self.session == session, self.generation == generation else { return false }
        // The consumer evaluates geometry synchronously against this AR frame. Capture time
        // can move backwards when switching from an image anchor to cached pixel evidence;
        // frame time cannot. A delayed callback cannot revoke a newer frame's assertion.
        if let frameTime = evaluationFrameTime {
            guard frameTime.isFinite, lastEvaluationFrameTime.map({ frameTime > $0 }) ?? true else { return false }
            lastEvaluationFrameTime = frameTime
        }
        guard capturedAt.timeIntervalSince1970.isFinite, now.timeIntervalSince1970.isFinite,
              capturedAt >= generationStartedAt, capturedAt <= now,
              location.capturedAt == capturedAt, location.maximumAge == Self.maximumAge,
              (0..<4).allSatisfy({ column in (0..<4).allSatisfy { pose[column][$0].isFinite } }) else {
            invalidate(.expired, at: now, visual: visual, resetAlignment: resetAlignment)
            return false
        }
        guard now.timeIntervalSince(capturedAt) < Self.maximumAge else {
            // Output expiry during bridge/geometry work does not invalidate a newer capture
            // already submitted by the session. Hard tracking/context resets remain separate.
            if evaluationFrameTime != nil || (lastAcceptedAt.map({ capturedAt >= $0 }) ?? true) {
                clearPresentation(visual: visual)
            }
            return false
        }
        let deadline = min(capturedAt.addingTimeInterval(Self.maximumAge), validUntil ?? .distantFuture)
        guard deadline.timeIntervalSince1970.isFinite, deadline > now else {
            if evaluationFrameTime != nil || (lastAcceptedAt.map({ capturedAt >= $0 }) ?? true) {
                clearPresentation(visual: visual)
            }
            return false
        }
        let identity = area.map { areaIdentity ?? $0.label }
        // Same-capture VIO can revoke geometry without becoming a new observation. It may
        // update the propagated pose, but cannot renew the original lease or promote an area.
        if let lastAcceptedAt, capturedAt <= lastAcceptedAt {
            if evaluationFrameTime != nil, identity != self.areaIdentity {
                clearPresentation(visual: visual)
                return false
            }
            if capturedAt == lastAcceptedAt, let ticket {
                if identity != self.areaIdentity || deadline < ticket.expiresAt {
                    clearPresentation(visual: visual)
                } else {
                    self.pose = pose
                    var bounded = location
                    bounded.validUntil = ticket.expiresAt
                    visual?.observation = bounded
                }
            }
            return false
        }
        areaNode?.removeFromParentNode()
        self.pose = pose; areaNode = area?.node
        if let area { root.addChildNode(area.node) }
        self.areaIdentity = identity
        var bounded = location
        bounded.validUntil = deadline
        visual?.observation = bounded
        status = area.map { "Within surveyed area \($0.label). Check current obstacles and signs." }
            ?? "Local references aligned. The exact boarding point or waiting area remains unconfirmed."
        lastAcceptedAt = capturedAt
        ticket = Ticket(session: session, generation: generation, observation: UUID(), capturedAt: capturedAt,
                        expiresAt: deadline)
        return true
    }

    /// Invoked after the controller's monotonic sleep, even if wall time moved backwards.
    /// Both session and observation identity guard against old timers clearing a new alignment.
    @discardableResult mutating func expire(_ expected: Ticket, session: UUID, at now: Date,
        visual: VisualLocationStore?, resetAlignment: () -> Void) -> Bool {
        guard active, self.session == session, ticket == expected else { return false }
        // Expiring a display lease is not a tracking/world/context reset. A newer capture
        // already in flight retains its own generation, age and consensus-gap checks.
        clearPresentation(visual: visual)
        status = "Local alignment expired. Scan the surveyed references again."
        return true
    }
}
