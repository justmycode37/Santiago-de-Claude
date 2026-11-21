import Foundation
import MapKit

/// The stored identity includes the complete leg DTOs, including endpoints and
/// boarding assignments. A revision or endpoint change cannot borrow old paths.
struct WalkingBundleIdentity: Codable, Equatable {
    let journeyID: String
    let revision: Int
    let legs: [Leg]
    init(_ journey: Journey) {
        journeyID = journey.id; revision = journey.revision; legs = journey.legs
    }
    var walks: [Leg] { legs.filter { $0.kind == "walk" || $0.kind == "transfer" } }
}
struct WalkingBundle: Codable, Equatable {
    static let version = 2
    static let maximumBytes = 4_000_000
    static let maximumLegs = 12
    static let maximumPoints = 24_000
    let version: Int
    let identity: WalkingBundleIdentity
    var routes: [WalkingRouteSnapshot]
    init(identity: WalkingBundleIdentity, routes: [WalkingRouteSnapshot] = []) {
        version = Self.version; self.identity = identity; self.routes = routes
    }
    var valid: Bool {
        version == Self.version && !identity.journeyID.isEmpty && identity.legs.count <= 100 &&
        Set(identity.legs.map(\.id)).count == identity.legs.count &&
        routes.count <= Self.maximumLegs && Set(routes.map { $0.leg.id }).count == routes.count &&
        routes.reduce(0, { $0 + $1.coordinates.count }) <= Self.maximumPoints &&
        routes.allSatisfy { route in identity.walks.contains(route.leg) && route.structurallyValid }
    }
    func route(for leg: Leg, at now: Date) -> WalkingRouteSnapshot? {
        routes.first { $0.usable(for: leg, now: now) }
    }
}

/// Injected storage keeps write-failure behavior testable. A failed atomic write
/// does not replace either the prior disk bundle or the in-memory saved routes.
@MainActor protocol WalkingBundleStorage {
    func read() throws -> Data?
    func write(_ data: Data) throws
}
@MainActor final class FileWalkingBundleStorage: WalkingBundleStorage {
    let url: URL?
    init(url: URL?) { self.url = url }
    func read() throws -> Data? {
        guard let url, FileManager.default.fileExists(atPath: url.path) else { return nil }
        guard let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size <= WalkingBundle.maximumBytes else { throw NativeCoreError.message("Saved walking file exceeds its size limit.") }
        return try Data(contentsOf: url)
    }
    func write(_ data: Data) throws {
        guard let url, data.count <= WalkingBundle.maximumBytes else { throw NativeCoreError.message("Walking guidance could not be stored within its size limit.") }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
@MainActor struct WalkingRouteResult {
    let snapshot: WalkingRouteSnapshot
    let route: MKRoute?
}
@MainActor protocol WalkingRouting {
    func fetch(leg: Leg, from: CLLocationCoordinate2D?) async throws -> WalkingRouteResult
}

struct WalkingSaveRow: Identifiable {
    enum Status { case saved, expired, invalid, unavailable, unsupported, limit }
    let leg: Leg
    let status: Status
    let fetchedAt: Date?
    var id: String { leg.id }
    var description: String {
        switch status {
        case .saved: return "Saved · usable offline"
        case .expired: return "Expired · save again when connected"
        case .invalid: return "Invalid source time or path · unavailable"
        case .unavailable: return "Not saved · network needed"
        case .unsupported: return "Planned coordinates unavailable · use stop names and local signs"
        case .limit: return "Beyond the 12-leg offline save limit"
        }
    }
}
