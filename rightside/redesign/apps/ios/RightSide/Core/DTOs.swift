import Foundation

// Typed views over validated wire values; preserve all evidence and nullable fields.
public struct Place: WireDTO, Identifiable {
    public let raw: JSONValue
    public init(raw: JSONValue) { self.raw = raw }
    public var id: String { raw["id"].string ?? "" }
    public var name: String { raw["name"].string ?? "" }
    public var kind: String { raw["kind"].string ?? "unknown" }
    public var coordinate: [Double]? { raw["coordinate"].coordinate }
    public var evidence: [Evidence] { raw["evidence"].array.map(Evidence.init(raw:)) }
}

public struct Journey: WireDTO, Identifiable {
    public let raw: JSONValue
    public init(raw: JSONValue) { self.raw = raw }
    public var id: String { raw["id"].string ?? "" }
    public var revision: Int { Int(raw["revision"].double ?? 0) }
    public var origin: Place { Place(raw: raw["origin"]) }
    public var destination: Place { Place(raw: raw["destination"]) }
    public var legs: [Leg] { raw["legs"].array.map(Leg.init(raw:)) }
    public var durationSeconds: Double { raw["durationSeconds"].double ?? 0 }
    public var warnings: [String] { raw["warnings"].strings }
    public var evidence: [Evidence] { raw["evidence"].array.map(Evidence.init(raw:)) }
}

public struct Leg: WireDTO, Identifiable {
    public let raw: JSONValue
    public init(raw: JSONValue) { self.raw = raw }
    public var id: String { raw["id"].string ?? "" }
    public var kind: String { raw["kind"].string ?? "unknown" }
    public var from: Place { Place(raw: raw["from"]) }
    public var to: Place { Place(raw: raw["to"]) }
    public var plannedStart: String { raw["plannedStart"].string ?? "" }
    public var plannedEnd: String { raw["plannedEnd"].string ?? "" }
    public var expectedStart: String? { raw["expectedStart"].string }
    public var expectedEnd: String? { raw["expectedEnd"].string }
    public var line: String? { raw["line"].string }
    public var headsign: String? { raw["headsign"].string }
    public var mode: String? { raw["mode"].string }
    public var instructions: [Instruction] { raw["instructions"].array.map(Instruction.init(raw:)) }
    public var geometry: Geometry? { raw["geometry"] == .null ? nil : Geometry(raw: raw["geometry"]) }
    public var boardingTarget: BoardingTarget? { raw["boardingTarget"] == .null ? nil : BoardingTarget(raw: raw["boardingTarget"]) }
    public var calls: [StopCall] { raw["calls"].array.map(StopCall.init(raw:)) }
    public var evidence: [Evidence] { raw["evidence"].array.map(Evidence.init(raw:)) }
    public var boardingUnavailable: Bool {
        guard kind == "ride", let call = calls.first(where: { $0.id == raw["boardingCallId"].string }) else { return kind == "ride" }
        return ["cancelled", "skipped"].contains(call.status) || call.raw["pickup"].string == "forbidden"
    }
    public var accessibility: String { raw["accessibility"].string ?? "unknown" }
    public var distanceMeters: Double? { raw["distanceMeters"].double }
}

public struct Instruction: WireDTO, Identifiable {
    public let raw: JSONValue
    public init(raw: JSONValue) { self.raw = raw }
    public var id: String { raw["id"].string ?? "" }
    public var text: String { raw["text"].string ?? "" }
    public var kind: String { raw["kind"].string ?? "" }
}

public struct Geometry: WireDTO {
    public let raw: JSONValue
    public init(raw: JSONValue) { self.raw = raw }
    public var coordinates: [[Double]] { raw["coordinates"].array.compactMap(\.coordinate) }
    public var quality: String { raw["quality"].string ?? "unknown" }
}

public struct BoardingAssignment: WireDTO {
    public let raw: JSONValue
    public init(raw: JSONValue) { self.raw = raw }
    public var status: String { raw["status"].string ?? "unavailable" }
    public var label: String? { raw["label"].string }
    public var originalLabel: String? { raw["originalLabel"].string }
}

public struct BoardingTarget: WireDTO, Identifiable {
    public let raw: JSONValue
    public init(raw: JSONValue) { self.raw = raw }
    public var id: String { raw["id"].string ?? "" }
    public var assignment: BoardingAssignment { BoardingAssignment(raw: raw["assignment"]) }
    public var pedestrianTargetStatus: String { raw["pedestrianTargetStatus"].string ?? "unavailable" }
    public var transitCoordinate: [Double]? { raw["transitCoordinate"].coordinate }
}

public struct StopCall: WireDTO, Identifiable {
    public let raw: JSONValue
    public init(raw: JSONValue) { self.raw = raw }
    public var id: String { raw["id"].string ?? "" }
    public var place: Place { Place(raw: raw["place"]) }
    public var plannedDeparture: String? { raw["plannedDeparture"].string }
    public var plannedArrival: String? { raw["plannedArrival"].string }
    public var expectedDeparture: String? { raw["expectedDeparture"].string }
    public var expectedArrival: String? { raw["expectedArrival"].string }
    public var status: String { raw["status"].string ?? "unknown" }
}

public struct Evidence: WireDTO {
    public let raw: JSONValue
    public init(raw: JSONValue) { self.raw = raw }
    public var source: String { raw["source"].string ?? "" }
    public var fetchedAt: String { raw["fetchedAt"].string ?? "" }
    public var kind: String { raw["kind"].string ?? "" }
    public var quality: String { raw["quality"].string ?? "" }
    public var observedAt: String? { raw["observedAt"].string }
}

public struct PositionEstimate: WireDTO {
    public let raw: JSONValue
    public init(raw: JSONValue) { self.raw = raw }
    public var rawCoordinate: [Double]? { raw["rawCoordinate"].coordinate }
    public var horizontalAccuracyMeters: Double? { raw["horizontalAccuracyMeters"].double }
    public var confidence: String { raw["confidence"].string ?? "unavailable" }
}

public struct ServiceMatch: WireDTO {
    public let raw: JSONValue
    public init(raw: JSONValue) { self.raw = raw }
    public var status: String { raw["status"].string ?? "unknown" }
    public var reasonCodes: [String] { raw["reasonCodes"].strings }
}

public struct NavigationOverlays: WireDTO {
    public let raw: JSONValue
    public init(raw: JSONValue) { self.raw = raw }
    public var offline: Bool { raw["offline"].bool ?? false }
    public var disrupted: Bool { raw["disrupted"].bool ?? false }
    public var replanning: Bool { raw["replanning"].bool ?? false }
    public var uncertain: Bool { raw["uncertain"].bool ?? false }
}

public struct NavigationSnapshot: WireDTO {
    public let raw: JSONValue
    public init(raw: JSONValue) { self.raw = raw }
    public var journey: Journey { Journey(raw: raw["journey"]) }
    public var legIndex: Int { Int(raw["legIndex"].double ?? 0) }
    public var phase: String { raw["phase"].string ?? "unknown" }
    public var now: String { raw["now"].string ?? "" }
    public var overlays: NavigationOverlays { NavigationOverlays(raw: raw["overlays"]) }
    public var predictionFresh: Bool { raw["predictionFresh"].bool ?? false }
    public var position: PositionEstimate? { raw["position"] == .null ? nil : PositionEstimate(raw: raw["position"]) }
    public var serviceMatch: ServiceMatch? { raw["serviceMatch"] == .null ? nil : ServiceMatch(raw: raw["serviceMatch"]) }
    public var currentLeg: Leg { journey.legs[legIndex] }
}

