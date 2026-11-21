import Foundation
import MapKit
import CryptoKit
import Combine

struct PlaceSuggestion: Identifiable {
    let place: Place
    let subtitle: String
    var id: String { place.id }
}

@MainActor enum MapPlaceSearch {
    static func search(_ query: String, near: CLLocationCoordinate2D?) async throws -> [PlaceSuggestion] {
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = String(query.prefix(200))
        request.resultTypes = [.address, .pointOfInterest]
        if let near { request.region = MKCoordinateRegion(center: near, latitudinalMeters: 40_000, longitudinalMeters: 40_000) }
        let search = MapSearchOperation(request: request)
        let response = try await withTaskCancellationHandler(operation: { try await search.run() }, onCancel: {
            Task { @MainActor in search.cancel() }
        })
        try Task.checkCancellation()
        return response.mapItems.compactMap { suggestion($0) }
    }

    static func suggestion(_ item: MKMapItem, now: Date = Date()) -> PlaceSuggestion? {
        let point = item.placemark.coordinate
        guard CLLocationCoordinate2DIsValid(point), point.latitude.isFinite, point.longitude.isFinite else { return nil }
        let title = item.name ?? item.placemark.title ?? "Selected location"
        let address = [item.placemark.thoroughfare, item.placemark.subThoroughfare,
                       item.placemark.postalCode, item.placemark.locality, item.placemark.country]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        let identity = "\(title)|\(point.latitude)|\(point.longitude)"
        let digest = SHA256.hash(data: Data(identity.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
        let raw: JSONValue = .object([
            "id": .string("apple.maps:\(digest)"), "name": .string(title),
            "kind": .string(item.pointOfInterestCategory == nil ? "address" : "poi"),
            "coordinate": .array([.number(point.longitude), .number(point.latitude)]),
            "parentId": .null, "sourceRefs": .array([]),
            "evidence": .array([.object(["source": .string("apple.maps"),
                "fetchedAt": .string(WireClock.string(now)), "kind": .string("derived"), "quality": .string("supported")])])])
        return PlaceSuggestion(place: Place(raw: raw), subtitle: address.isEmpty ? "Apple Maps place" : address)
    }
}

/// Walking geometry never changes passenger progress. Foreground inspection and
/// the active journey's offline bundle have separate lifetimes.
@MainActor final class WalkingRouteController: ObservableObject {
    @Published private(set) var route: MKRoute?
    @Published private(set) var legID: String?
    @Published private(set) var snapshot: WalkingRouteSnapshot?
    @Published private(set) var usingSavedRoute = false
    @Published private(set) var refreshID = UUID()
    @Published private(set) var status: String?
    @Published private(set) var bundle: WalkingBundle?
    @Published private(set) var isSaving = false
    @Published private(set) var saveStatus: String?
    private let legacyURL: URL?
    private let storage: any WalkingBundleStorage
    private let routing: any WalkingRouting
    private var identity: WalkingBundleIdentity?
    private var displayedIdentity: WalkingBundleIdentity?
    private var session: UUID?
    private var offline = false
    private var generation = UUID()
    private var displayGeneration = UUID()
    private var saveGeneration = UUID()
    private var displayTask: Task<WalkingRouteResult, Error>?
    private var saveTask: Task<Void, Never>?

    init(cacheURL: URL? = nil, storage: (any WalkingBundleStorage)? = nil, routing: (any WalkingRouting)? = nil) {
        let legacy = cacheURL ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent("RightSide/walk-detail-v1.json")
        legacyURL = legacy
        self.storage = storage ?? FileWalkingBundleStorage(url: legacy?.appendingPathExtension("bundle-v2.json"))
        self.routing = routing ?? MapKitWalkingRouting()
    }
    func retry() { refreshID = UUID() }
    /// Views can render a new journey before their asynchronous load task runs.
    /// Require the complete displayed context here, not just a reusable leg ID.
    func displayedSnapshot(for journey: Journey?, leg: Leg? = nil, at now: Date = Date()) -> WalkingRouteSnapshot? {
        guard let journey, displayedIdentity == WalkingBundleIdentity(journey),
              let snapshot, journey.legs.contains(snapshot.leg),
              leg.map({ $0 == snapshot.leg }) ?? true,
              snapshot.usable(for: snapshot.leg, now: now) else { return nil }
        return snapshot
    }
    var polyline: MKPolyline? {
        guard let snapshot, snapshot.usable(for: snapshot.leg) else { return nil }
        return route?.polyline ?? snapshot.polyline
    }
    func assessment(fix: CLLocation?, now: Date = Date()) -> WalkingAssessment {
        let usable = snapshot.flatMap { $0.usable(for: $0.leg, now: now) ? $0 : nil }
        return WalkingAssessment.assess(points: usable?.points ?? [], steps: usable?.steps ?? [], fix: fix, now: now)
    }
    /// Call for the actual active navigation, even while previewing alternatives.
    /// Session replacement cancels operations; restart can read the same identity.
    func configure(journey: Journey?, session: UUID, offline: Bool) {
        let next = journey.map(WalkingBundleIdentity.init)
        if identity != next || self.session != session {
            cancelSaving(); displayTask?.cancel(); displayGeneration = UUID()
            generation = UUID(); identity = next; self.session = session
            route = nil; snapshot = nil; displayedIdentity = nil; bundle = nil; usingSavedRoute = false; saveStatus = nil
            if let next {
                var hasBundleFile = false
                do {
                    if let data = try storage.read() {
                        hasBundleFile = true
                        guard data.count <= WalkingBundle.maximumBytes else { throw NativeCoreError.message("Saved walking file exceeds its size limit.") }
                        let saved = try JSONDecoder().decode(WalkingBundle.self, from: data)
                        if saved.valid && saved.identity == next { bundle = saved }
                        else { saveStatus = "Saved paths do not match this journey revision. Save walking guidance again." }
                    }
                } catch {
                    hasBundleFile = true // A corrupt existing bundle must not silently revive legacy data.
                    saveStatus = "Saved walking file unavailable. Stop names and journey progress are retained."
                }
                // Only adopt a legacy route when its entire leg DTO matches. Never
                // change its timestamp, or claim it covers the other journey legs.
                if !hasBundleFile, bundle == nil, let saved = legacyRoute(), next.walks.contains(saved.leg), saved.usable(for: saved.leg) {
                    _ = retain(saved, identity: next)
                }
            }
        }
        if offline && !self.offline { cancelSaving(); displayTask?.cancel(); displayGeneration = UUID() }
        self.offline = offline
    }
    func rows(at now: Date = Date()) -> [WalkingSaveRow] {
        (identity?.walks ?? []).enumerated().map { index, leg in
            let saved = bundle?.routes.first { $0.leg == leg }
            let state: WalkingSaveRow.Status
            if let saved {
                if !saved.structurallyValid || saved.fetchedAt > now { state = .invalid }
                else if saved.usable(for: leg, now: now) { state = .saved }
                else { state = .expired }
            } else if MapGeometry.coordinate(leg.from.coordinate) == nil || MapGeometry.coordinate(leg.to.coordinate) == nil { state = .unsupported }
            else if index >= WalkingBundle.maximumLegs { state = .limit }
            else { state = .unavailable }
            return WalkingSaveRow(leg: leg, status: state, fetchedAt: saved?.fetchedAt)
        }
    }
    func cancelSaving() {
        saveTask?.cancel(); saveTask = nil; saveGeneration = UUID()
        if isSaving { saveStatus = "Save cancelled. Previously saved walking legs remain available." }
        isSaving = false
    }
    /// At most 12 requests, sequentially, each adapter request bounded at 20s.
    /// A simultaneous foreground inspection can add at most one extra request.
    func saveForOffline() async {
        guard !isSaving, !offline, let identity else { return }
        let token = UUID(); saveGeneration = token
        let context = generation
        isSaving = true; saveStatus = "Saving walking guidance…"
        let task = Task { [weak self] in
            guard let self else { return }
            for leg in identity.walks.prefix(WalkingBundle.maximumLegs) {
                guard !Task.isCancelled, context == self.generation, token == self.saveGeneration else { return }
                if self.bundle?.route(for: leg, at: Date()) != nil { continue }
                guard MapGeometry.coordinate(leg.from.coordinate) != nil, MapGeometry.coordinate(leg.to.coordinate) != nil else { continue }
                do {
                    let result = try await self.routing.fetch(leg: leg, from: nil)
                    guard !Task.isCancelled, context == self.generation, token == self.saveGeneration else { return }
                    guard result.snapshot.usable(for: leg) else {
                        self.saveStatus = "Some walking geometry is unavailable or invalid. Saved legs are retained."
                        continue
                    }
                    guard self.retain(result.snapshot, identity: identity) else { continue }
                    // Update only the matching active display. Do not trigger a
                    // fresh request for an unrelated alternative being inspected.
                    if self.displayedIdentity == identity, self.legID == leg.id, self.snapshot == nil {
                        self.snapshot = result.snapshot; self.usingSavedRoute = true
                        self.status = "Saved walking detail · check closures and local signs."
                    }
                } catch {
                    guard !Task.isCancelled, context == self.generation, token == self.saveGeneration else { return }
                    self.saveStatus = "Some walking legs could not be fetched. Saved legs are retained; retry when connected."
                }
            }
        }
        saveTask = task
        await withTaskCancellationHandler(operation: { await task.value }, onCancel: { task.cancel() })
        guard context == generation, token == saveGeneration else { return }
        saveTask = nil; isSaving = false
        let count = rows().filter { $0.status == .saved }.count
        if saveStatus == "Saving walking guidance…" {
            saveStatus = "\(count) of \(identity.walks.count) walking legs saved. Map tiles and live disruptions are not included."
        }
    }
    @discardableResult private func retain(_ detail: WalkingRouteSnapshot, identity: WalkingBundleIdentity) -> Bool {
        guard self.identity == identity, identity.walks.contains(detail.leg), detail.usable(for: detail.leg) else { return false }
        var next = bundle ?? WalkingBundle(identity: identity)
        next.routes.removeAll { $0.leg.id == detail.leg.id }; next.routes.append(detail)
        do {
            guard next.valid else { throw NativeCoreError.message("Walking bundle exceeds its route or point limit.") }
            let data = try JSONEncoder().encode(next)
            guard data.count <= WalkingBundle.maximumBytes else { throw NativeCoreError.message("Walking bundle exceeds its byte limit.") }
            try storage.write(data)
            bundle = next
            return true
        } catch {
            saveStatus = "Could not save this walking leg. Previously saved legs remain available."
            return false
        }
    }
    private func legacyRoute() -> WalkingRouteSnapshot? {
        guard let legacyURL, let size = try? legacyURL.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 2_000_000,
              let data = try? Data(contentsOf: legacyURL) else { return nil }
        return try? JSONDecoder().decode(WalkingRouteSnapshot.self, from: data)
    }
    func load(_ leg: Leg?, simulated: Bool, offline: Bool = false, from current: CLLocationCoordinate2D? = nil,
              journey: Journey? = nil) async {
        displayTask?.cancel(); displayGeneration = UUID()
        let token = displayGeneration, context = generation
        route = nil; snapshot = nil; usingSavedRoute = false; legID = leg?.id; status = nil
        guard !simulated, let leg, leg.kind == "walk" || leg.kind == "transfer",
              MapGeometry.coordinate(leg.from.coordinate) != nil, MapGeometry.coordinate(leg.to.coordinate) != nil else { return }
        displayedIdentity = journey.map(WalkingBundleIdentity.init)
        let matchesActive = journey.map { WalkingBundleIdentity($0) == identity } ?? (identity?.walks.contains(leg) ?? false)
        if matchesActive { snapshot = bundle?.route(for: leg, at: Date()) }
        // Compatibility for the original standalone last-leg restore API.
        if identity == nil, journey == nil, let saved = legacyRoute(), saved.usable(for: leg) { snapshot = saved }
        usingSavedRoute = snapshot != nil
        if offline {
            status = snapshot == nil ? "Offline · walking detail unavailable. Use saved stop names and local signs." : "Saved walking detail · check closures and local signs. Map tiles may be unavailable offline."
            return
        }
        // A valid saved planned path is reused; retry or explicit current-location
        // rerouting is separate from filling the journey's missing walking legs.
        if snapshot != nil && current == nil { status = "Saved walking detail · check closures and local signs."; return }
        let provider = routing
        let task = Task { try await provider.fetch(leg: leg, from: current) }; displayTask = task
        status = "Loading walking detail…"
        do {
            let result = try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
            guard token == displayGeneration, context == generation, !Task.isCancelled else { return }
            guard result.snapshot.usable(for: leg) else { throw NativeCoreError.message("Walking geometry unavailable or invalid.") }
            route = result.route; snapshot = result.snapshot; usingSavedRoute = false; status = nil
            // A route from the passenger's current position must never overwrite
            // the planned endpoint-to-endpoint path needed by a future restart.
            if matchesActive, current == nil, let identity { _ = retain(result.snapshot, identity: identity) }
        } catch {
            guard token == displayGeneration, context == generation, !Task.isCancelled else { return }
            status = snapshot == nil ? "Walking detail unavailable. Follow local signs." : "Saved walking detail · live route unavailable. Check closures and local signs."
        }
    }
}

@MainActor final class MapKitWalkingRouting: WalkingRouting {
    func fetch(leg: Leg, from current: CLLocationCoordinate2D?) async throws -> WalkingRouteResult {
        guard let from = current ?? MapGeometry.coordinate(leg.from.coordinate), let to = MapGeometry.coordinate(leg.to.coordinate) else {
            throw NativeCoreError.message("Planned walking endpoints unavailable.")
        }
        let query = MKDirections.Request()
        query.source = MKMapItem(placemark: MKPlacemark(coordinate: from))
        query.destination = MKMapItem(placemark: MKPlacemark(coordinate: to))
        query.transportType = .walking; query.requestsAlternateRoutes = false
        let operation = WalkingDirectionsOperation(request: query)
        let response = try await withTaskCancellationHandler(operation: { try await operation.run() }, onCancel: {
            Task { @MainActor in operation.cancel() }
        })
        try Task.checkCancellation()
        guard let route = response.routes.first, route.polyline.pointCount <= 4_000, route.steps.count <= 256 else {
            throw NativeCoreError.message("Walking path unavailable within offline storage limits.")
        }
        var accumulated = 0.0
        let steps = route.steps.enumerated().compactMap { index, step -> WalkingStep? in
            accumulated += step.distance
            return step.instructions.isEmpty ? nil : WalkingStep(id: index, instruction: step.instructions, distance: step.distance, endDistance: accumulated)
        }
        let snapshot = WalkingRouteSnapshot(leg: leg, coordinates: MapGeometry.coordinates(route.polyline).map { [$0.longitude, $0.latitude] },
            steps: steps, distance: route.distance, expectedSeconds: route.expectedTravelTime, fetchedAt: Date())
        return WalkingRouteResult(snapshot: snapshot, route: route)
    }
}

enum MapGeometry {
    static func coordinate(_ values: [Double]?) -> CLLocationCoordinate2D? {
        guard let values, values.count == 2, values.allSatisfy({ $0.isFinite }),
              abs(values[0]) <= 180, abs(values[1]) <= 90 else { return nil }
        return CLLocationCoordinate2D(latitude: values[1], longitude: values[0])
    }
    static func coordinates(_ line: MKPolyline) -> [CLLocationCoordinate2D] {
        var values = [CLLocationCoordinate2D](repeating: CLLocationCoordinate2D(), count: line.pointCount)
        line.getCoordinates(&values, range: NSRange(location: 0, length: line.pointCount))
        return values
    }
    /// Only a nearby, recent fix can choose a forward point on a mapped walk.
    /// Ambiguous parallel/return segments are rejected, not silently snapped.
    static func lookAhead(on points: [CLLocationCoordinate2D], from fix: CLLocation, now: Date = Date()) -> CLLocationCoordinate2D? {
        guard points.count > 1, fix.horizontalAccuracy >= 0, fix.horizontalAccuracy <= 25,
              !SensorFixFreshness.isStale(timestamp: fix.timestamp, now: now) else { return nil }
        let origin = MKMapPoint(fix.coordinate)
        var candidates: [(index: Int, distance: Double, point: MKMapPoint, progress: Double)] = []
        var progress = 0.0
        for i in 0..<(points.count - 1) {
            let a = MKMapPoint(points[i]), b = MKMapPoint(points[i + 1])
            let dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy
            guard length > 0 else { continue }
            let t = min(1, max(0, ((origin.x - a.x) * dx + (origin.y - a.y) * dy) / length))
            let p = MKMapPoint(x: a.x + t * dx, y: a.y + t * dy)
            candidates.append((i, origin.distance(to: p), p, progress + a.distance(to: p)))
            progress += a.distance(to: b)
        }
        guard let nearest = candidates.min(by: { $0.distance < $1.distance }), nearest.distance <= max(15, fix.horizontalAccuracy) else { return nil }
        if candidates.contains(where: { abs($0.progress - nearest.progress) > max(40, fix.horizontalAccuracy * 3) && $0.distance <= nearest.distance + max(5, fix.horizontalAccuracy) }) { return nil }
        var remaining = 25.0, previous = nearest.point
        for i in (nearest.index + 1)..<points.count {
            let next = MKMapPoint(points[i]), distance = previous.distance(to: next)
            if distance >= remaining, distance > 0 {
                let fraction = remaining / distance
                return MKMapPoint(x: previous.x + fraction * (next.x - previous.x), y: previous.y + fraction * (next.y - previous.y)).coordinate
            }
            remaining -= distance; previous = next
        }
        return points.last
    }
}

// MapKit documents completion delivery on the main queue. Framework responses
// stay on that actor; only Void crosses the continuation. Cancellation resumes
// the caller even if the SDK suppresses a cancelled request's callback.
@MainActor private final class MapSearchOperation {
    private let search: MKLocalSearch
    private var response: MKLocalSearch.Response?
    private var continuation: CheckedContinuation<Void, Error>?
    private var cancelled = false
    private var timeout: Task<Void, Never>?
    init(request: MKLocalSearch.Request) { search = MKLocalSearch(request: request) }
    func cancel() { cancelled = true; finish(CancellationError()); search.cancel() }
    private func finish(_ error: Error? = nil) {
        timeout?.cancel(); timeout = nil
        guard let pending = continuation else { return }
        continuation = nil
        if let error { pending.resume(throwing: error) } else { pending.resume() }
    }
    func run() async throws -> MKLocalSearch.Response {
        try Task.checkCancellation()
        guard !cancelled else { throw CancellationError() }
        try await withCheckedThrowingContinuation { (pending: CheckedContinuation<Void, Error>) in
            continuation = pending
            timeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(20)) } catch { return }
                self?.finish(NativeCoreError.message("Place search timed out. Try again.")); self?.search.cancel()
            }
            search.start { [self] response, error in
                MainActor.assumeIsolated {
                    guard continuation != nil else { return }
                    if let response { self.response = response; finish() }
                    else { finish(error ?? NativeCoreError.message("Place search unavailable.")) }
                }
            }
        }
        guard let response else { throw NativeCoreError.message("Place search unavailable.") }
        return response
    }
}
@MainActor private final class WalkingDirectionsOperation {
    private let directions: MKDirections
    private var response: MKDirections.Response?
    private var continuation: CheckedContinuation<Void, Error>?
    private var cancelled = false
    private var timeout: Task<Void, Never>?
    init(request: MKDirections.Request) { directions = MKDirections(request: request) }
    func cancel() { cancelled = true; finish(CancellationError()); directions.cancel() }
    private func finish(_ error: Error? = nil) {
        timeout?.cancel(); timeout = nil
        guard let pending = continuation else { return }
        continuation = nil
        if let error { pending.resume(throwing: error) } else { pending.resume() }
    }
    func run() async throws -> MKDirections.Response {
        try Task.checkCancellation()
        guard !cancelled else { throw CancellationError() }
        try await withCheckedThrowingContinuation { (pending: CheckedContinuation<Void, Error>) in
            continuation = pending
            timeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(20)) } catch { return }
                self?.finish(NativeCoreError.message("Walking directions timed out.")); self?.directions.cancel()
            }
            directions.calculate { [self] response, error in
                let result = DirectionsResult(response: response)
                MainActor.assumeIsolated {
                    guard continuation != nil else { return }
                    if let response = result.response { self.response = response; finish() }
                    else { finish(error ?? NativeCoreError.message("Walking route unavailable.")) }
                }
            }
        }
        guard let response else { throw NativeCoreError.message("Walking route unavailable.") }
        return response
    }
}
// MKDirections.Response is read-only and delivered on the main thread. This
// box expresses that legacy SDK guarantee across assumeIsolated's boundary.
private struct DirectionsResult: @unchecked Sendable { let response: MKDirections.Response? }

struct WalkingStep: Codable, Equatable, Identifiable {
    let id: Int
    let instruction: String
    let distance: Double
    let endDistance: Double
}
struct WalkingRouteSnapshot: Codable, Equatable {
    let leg: Leg
    let coordinates: [[Double]]
    let steps: [WalkingStep]
    let distance: Double
    let expectedSeconds: Double
    let fetchedAt: Date
    var points: [CLLocationCoordinate2D] { coordinates.compactMap(MapGeometry.coordinate) }
    var polyline: MKPolyline { MKPolyline(coordinates: points, count: points.count) }
    var structurallyValid: Bool {
        (2...4_000).contains(coordinates.count) && points.count == coordinates.count &&
        distance.isFinite && distance >= 0 && expectedSeconds.isFinite && expectedSeconds >= 0 &&
        fetchedAt.timeIntervalSince1970.isFinite && steps.count <= 256 && Set(steps.map(\.id)).count == steps.count &&
        steps.allSatisfy { $0.instruction.utf8.count <= 4_096 && $0.distance.isFinite && $0.distance >= 0 && $0.endDistance.isFinite && $0.endDistance >= 0 }
    }
    func usable(for leg: Leg, now: Date = Date()) -> Bool {
        self.leg == leg && (0...86_400).contains(now.timeIntervalSince(fetchedAt)) && structurallyValid
    }
}

struct WalkingAssessment: Equatable {
    enum Status: String { case unavailable, uncertain, nearRoute, offRoute }
    let status: Status
    let distanceFromRoute: Double?
    let remainingMeters: Double?
    let stepIndex: Int?

    static func assess(points: [CLLocationCoordinate2D], steps: [WalkingStep], fix: CLLocation?, now: Date = Date()) -> Self {
        let unknown = Self(status: .unavailable, distanceFromRoute: nil, remainingMeters: nil, stepIndex: nil)
        guard points.count > 1, let fix, CLLocationCoordinate2DIsValid(fix.coordinate),
              fix.horizontalAccuracy.isFinite, fix.horizontalAccuracy >= 0,
              !SensorFixFreshness.isStale(timestamp: fix.timestamp, now: now) else { return unknown }
        guard fix.horizontalAccuracy <= 35 else { return Self(status: .uncertain, distanceFromRoute: nil, remainingMeters: nil, stepIndex: nil) }
        let position = MKMapPoint(fix.coordinate)
        var candidates: [(distance: Double, along: Double)] = [], total = 0.0
        for index in 0..<(points.count - 1) {
            let a = MKMapPoint(points[index]), b = MKMapPoint(points[index + 1])
            let dx = b.x - a.x, dy = b.y - a.y, square = dx * dx + dy * dy
            guard square > 0 else { continue }
            let t = min(1, max(0, ((position.x - a.x) * dx + (position.y - a.y) * dy) / square))
            let projection = MKMapPoint(x: a.x + t * dx, y: a.y + t * dy)
            candidates.append((position.distance(to: projection), total + a.distance(to: projection)))
            total += a.distance(to: b)
        }
        guard let nearest = candidates.min(by: { $0.distance < $1.distance }) else { return unknown }
        if nearest.distance > max(35, fix.horizontalAccuracy * 2) {
            return Self(status: .offRoute, distanceFromRoute: nearest.distance, remainingMeters: nil, stepIndex: nil)
        }
        if nearest.distance > max(15, fix.horizontalAccuracy) || candidates.contains(where: {
            abs($0.along - nearest.along) > max(40, fix.horizontalAccuracy * 3) && $0.distance <= nearest.distance + max(5, fix.horizontalAccuracy)
        }) { return Self(status: .uncertain, distanceFromRoute: nearest.distance, remainingMeters: nil, stepIndex: nil) }
        return Self(status: .nearRoute, distanceFromRoute: nearest.distance, remainingMeters: max(0, total - nearest.along),
                    stepIndex: steps.firstIndex { $0.endDistance >= nearest.along + 5 } ?? steps.indices.last)
    }
}
