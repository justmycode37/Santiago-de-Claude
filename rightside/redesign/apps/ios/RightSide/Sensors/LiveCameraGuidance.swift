import SwiftUI
import ARKit
import SceneKit
import Vision
import AVFoundation
import Combine
import MapKit
import UniformTypeIdentifiers

// Retains one ARKit-owned image for read-only Vision use on the serial queue.
// No consumer mutates or locks this pixel buffer for writing.
private struct CapturedPixelBuffer: @unchecked Sendable { let value: CVPixelBuffer }
private final class VisionWorkGate: @unchecked Sendable {
    private let lock = NSLock()
    private var busy = false
    func acquire() -> Bool { lock.lock(); defer { lock.unlock() }; if busy { return false }; busy = true; return true }
    func release() { lock.lock(); busy = false; lock.unlock() }
}

/// One ARKit camera owner. OCR does not change position, service identity or progress.
@MainActor final class LiveCameraController: NSObject, ObservableObject, @preconcurrency ARSessionDelegate, @preconcurrency ARSCNViewDelegate {
    @Published private(set) var status = "Opening camera…"
    @Published private var cameraEvidence = CameraEvidenceLifecycle()
    var matches: [CameraTextMatch] { cameraEvidence.matches }
    @Published private(set) var permissionDenied = false
    @Published private(set) var localized = false
    @Published private(set) var cameraReady = false
    var vehicles: [CameraVehicleOverlay] { cameraEvidence.vehicles }
    var recognition: String { cameraEvidence.recognition }
    @Published private(set) var diagnostics = "Local model starting…"
    @Published private(set) var boardingReferences: [BoardingPointPack.Point] = []
    /// World-tracked route guidance (compass + GPS + walked path), independent of Apple's geographic AR.
    @Published private(set) var routePlan: ARRouteGuidance.Plan?
    private let routeGuide = ARRouteGuide()
    /// Live "what is about to stop here" from the Kante engine (/api/due), or vehicle positions as a fallback.
    private let kante = KanteVehicleFeed()
    private var kanteDue: [KanteDue] = []
    /// When the current `/api/due` answer was received; evidence older than a minute is not used.
    private var kanteDueAt: Date?
    private var kanteVehiclesAt: Date?
    private var kanteVehicles: [KanteVehicle] = []
    private var kanteSupportsDue: Bool?
    private var kanteTask: Task<Void, Never>?
    /// Exact boarding edge (platforms.js) and its floor (stations3d/), and which side of the street the rider is on.
    /// Loaded once, off the main thread (stop-edges.json is ~2 MB); nil until then.
    private var edgePack: StopEdgePack?
    private var levelPack: StationLevelPack?
    private var packLoad: Task<Void, Never>?
    /// The resolved boarding target, recomputed at most once a second or when the context or Kante answer changes.
    private var boarding: (edge: StopEdge, floor: StationLevelPack.Floor?, label: String)?
    private var boardingKey = ""
    private var lastBoardingCheck = 0.0
    @Published private(set) var boardingEdgeDescription: String?
    @Published private(set) var kerbMessage: String?
    private var lastKerbCheck = 0.0
    private var kantePollKey: String?
    var onObservation: ((JSONValue) -> Void)?
    let view = ARSCNView(frame: .zero)
    private let worker = DispatchQueue(label: "rightside.live-ocr", qos: .userInitiated)
    // Bounded layout profile accepted by the physical-phone comparison on2026-11-21.
    // Higher-detail/numeral-engine experiment remains opt-in in the indoor lab.
    private let pipeline = LocalVehiclePipeline(sceneDetail: .standard, displayLayout: .eitherSide, routeReread: false)
    private let workGate = VisionWorkGate()
    private var renderedPose: simd_float4x4?
    /// The camera of the last frame handed to the vehicle tracker: the next frame's boxes are matched to its boxes
    /// moved by the turn in between (trackerShift), and a big turn resets the tracks (.turned).
    private var trackedCamera: ARCamera?
    private let fleet = BundledTransportPacks.load("bern-fleet", as: FleetPack.self)
    private let boardingPack = BundledTransportPacks.load("bern-boarding", as: BoardingPointPack.self)
    private var localSite: LocalLandmarkSession?
    @Published private var localEvidence = LocalCameraEvidenceLifecycle()
    private var localExpiry: Task<Void, Never>?
    private var lastLocalFrame = 0.0
    private lazy var localPoseBridge = try? DomainBridge()
    var localSiteStatus: String { localEvidence.status }
    var localSiteMetadata: String { localEvidence.installedPackDescription }
    @Published private(set) var localSiteImportError: String?
    @Published private(set) var offlineCameraOnly = true
    private var context: CameraJourneyContext?
    private weak var location: LocationController?
    private weak var visual: VisualLocationStore?
    private var epoch = UUID()
    private var running = false
    private var processing = false
    private var lastOCR = 0.0
    private var lastPose = 0.0
    private var geo = false
    private var targetAnchor: ARGeoAnchor?
    private var expiry: Task<Void, Never>?
    private var startup: Task<Void, Never>?
    private var geoTimeout: Task<Void, Never>?
    private var geoAvailabilityID: UUID?

    override init() {
        super.init()
        view.session.delegate = self
        view.session.delegateQueue = .main
        view.delegate = self
        view.automaticallyUpdatesLighting = true
        view.scene = SCNScene()
        view.scene.rootNode.addChildNode(routeGuide.root)
    }
    func start(context: CameraJourneyContext, location: LocationController, visual: VisualLocationStore) {
        stop()
        self.context = context; self.location = location; self.visual = visual
        let token = epoch
        running = true; permissionDenied = false; status = "Opening camera…"
        cameraEvidence.start()
        invalidateLocalCameraEvidence(.restarted)
        startKante(context: context, token: token)
        loadPacks()
        boardingReferences = location.latestLocation.map { boardingPack?.nearby($0, at: Date()) ?? [] } ?? []
        startup = Task { [weak self] in
            let allowed: Bool
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: allowed = true
            case .notDetermined: allowed = await AVCaptureDevice.requestAccess(for: .video)
            default: allowed = false
            }
            guard let self, self.running, self.epoch == token, !Task.isCancelled else { return }
            guard allowed else { self.permissionDenied = true; self.status = "Camera access is off. You can continue with the map or enable it in Settings."; return }
            guard ARWorldTrackingConfiguration.isSupported else { self.status = "Live camera guidance is unavailable on this device. Use the map or photo reader."; return }
            self.runWorldCamera()
            if self.localSite != nil {
                self.status = "Scan a surveyed reference at this stop. Local landmark mode uses no VPS."
                return
            }
            guard !self.offlineCameraOnly else { self.status = "Local camera mode. Geographic AR services are off."; return }
            guard !context.simulated, ARGeoTrackingConfiguration.isSupported else {
                self.status = context.simulated ? "Demo · geographic guidance is disabled." : "Geographic AR is unsupported. Sign text is still available."; return
            }
            guard location.accuracyAuthorization == .fullAccuracy, !location.isStale(), let fix = location.latestLocation else {
                self.status = "Sign reader ready. A fresh precise location is needed for geographic AR. Get location below, then retry alignment."; return
            }
            let checkID = UUID()
            self.geoAvailabilityID = checkID
            self.status = "Checking geographic AR coverage…"
            self.geoTimeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(12)) } catch { return }
                guard let self, self.running, self.epoch == token, self.geoAvailabilityID == checkID else { return }
                self.geoAvailabilityID = nil
                self.status = "Coverage check timed out. Local camera remains available; retry when connected."
            }
            ARGeoTrackingConfiguration.checkAvailability(at: fix.coordinate) { [weak self] available, _ in
                Task { @MainActor [weak self] in
                    guard let self, self.running, self.epoch == token, self.geoAvailabilityID == checkID, self.localSite == nil, !self.offlineCameraOnly else { return }
                    self.geoAvailabilityID = nil; self.geoTimeout?.cancel()
                    guard available else { self.status = "No geographic AR coverage here. Sign reader remains available."; return }
                    self.invalidateCameraEvidence(.restarted)
                    self.geo = true
                    self.view.session.run(ARGeoTrackingConfiguration(), options: [.resetTracking, .removeExistingAnchors])
                    self.status = "Slowly scan nearby buildings to align the map. Stay in a safe place."
                    self.geoTimeout = Task { [weak self] in
                        do { try await Task.sleep(for: .seconds(30)) } catch { return }
                        guard let self, self.running, self.epoch == token, !self.localized else { return }
                        self.runWorldCamera()
                        self.status = "Could not align this view. Sign reader is available; use the map for directions."
                    }
                }
            }
        }
    }
    /// Polls the Kante engine every 15 s while the camera runs. The boarding stop id is sent when known;
    /// otherwise the current position (150 m radius). Nothing is sent offline or for simulated journeys.
    private func startKante(context: CameraJourneyContext, token: UUID) {
        kanteTask?.cancel(); kanteDue = []; kanteVehicles = []; kanteDueAt = nil; kanteVehiclesAt = nil
        kantePollKey = KanteVehicleFeed.pollKey(station: context.boardingStationID, line: context.line, destination: context.destination,
                                                offline: context.offline, simulated: context.simulated)
        guard kantePollKey != nil else { return }
        /// Body only when the server answered 2xx: URLSession does not throw on 404/502/503 (e.g. during a redeploy).
        func fetch(_ request: URLRequest) async -> (Data, Int)? {
            guard let (data, response) = try? await URLSession.shared.data(for: request) else { return nil }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            return (data, status)
        }
        let feed = kante
        kanteTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.running, self.epoch == token else { return }
                let fix = self.location?.latestLocation.map { GeoPoint(latitude: $0.coordinate.latitude, longitude: $0.coordinate.longitude) }
                if self.kanteSupportsDue == nil,
                   let meta = await fetch(URLRequest(url: feed.base.appendingPathComponent("api/meta"), timeoutInterval: 8)) {
                    // Latch only on a readable answer; an error page leaves it undecided for the next poll.
                    self.kanteSupportsDue = KanteVehicleFeed.supportsDue(meta.0, status: meta.1)
                }
                if self.kanteSupportsDue == true, let request = feed.dueRequest(station: context.boardingStationID, around: fix),
                   let response = await fetch(request), (200..<300).contains(response.1), let due = try? KanteVehicleFeed.decodeDue(response.0) {
                    if self.running, self.epoch == token { self.kanteDue = due; self.kanteDueAt = Date() }
                } else if self.kanteSupportsDue == false, let fix,
                          let response = await fetch(feed.request(around: fix)), (200..<300).contains(response.1),
                          let vehicles = try? KanteVehicleFeed.decode(response.0) {
                    if self.running, self.epoch == token { self.kanteVehicles = vehicles; self.kanteVehiclesAt = Date() }
                }
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
            }
        }
    }

    private func loadPacks() {
        guard edgePack == nil, packLoad == nil else { return }
        packLoad = Task { [weak self] in
            let packs = await Task.detached(priority: .utility) { () -> (StopEdgePack?, StationLevelPack?) in
                func data(_ name: String) -> Data? {
                    Bundle.main.url(forResource: name, withExtension: "json", subdirectory: "TransportPacks").flatMap { try? Data(contentsOf: $0) }
                }
                return (data("stop-edges").flatMap { try? StopEdgePack(data: $0) },
                        data("station-levels").flatMap { try? JSONDecoder().decode(StationLevelPack.self, from: $0) })
            }.value
            self?.edgePack = packs.0; self?.levelPack = packs.1; self?.boardingKey = ""
        }
    }

    /// The boarding edge: its ref from Kante /api/due (the trip's quay label) or the journey's planned platform;
    /// else the edge whose travel direction matches the trip's departure bearing. Nil when not unique.
    private func boardingTarget(_ context: CameraJourneyContext) -> (edge: StopEdge, floor: StationLevelPack.Floor?, label: String)? {
        guard let uic = context.boardingStationID, let pack = edgePack else { return nil }
        // The rider's own trip (by planned departure), never just the first trip of the same line; an empty
        // Kante label counts as no label, so the journey's planned platform is used instead.
        let fresh = kanteDueAt.map { Date().timeIntervalSince($0) <= VehiclePositionEvidence.dueMaximumAge } == true ? kanteDue : []
        let due = VehiclePositionEvidence.dueItem(line: context.line, destination: context.destination,
                                                  plannedDeparture: context.boardingDeparture, in: fresh, now: Date())
        let ref = due?.label ?? context.boardingQuayLabel
        guard let edge = pack.boardingEdge(uic: uic, ref: ref, departBearing: due?.departBearing) else { return nil }
        let floor = levelPack?.floor(uic: uic, ref: edge.ref)
        var label = edge.ref.isEmpty ? (context.stop ?? "Boarding point") : "Kante \(edge.ref)"
        if let floor, abs(floor.z) >= 1 { label += " · \(floor.name)" }
        return (edge, floor, label)
    }

    /// GPS fix, camera heading (fused alignment when available, else the compass) and horizontal field of view.
    private func cameraPose(_ frame: ARFrame, portrait: Bool) -> CameraPose? {
        guard let location, let fix = location.latestLocation, fix.horizontalAccuracy > 0, !location.isStale() else { return nil }
        let intrinsics = frame.camera.intrinsics, resolution = frame.camera.imageResolution
        // The sensor is landscape: in portrait the upright image's width is the sensor's height.
        let fov = portrait ? 2 * atan(Double(resolution.height) / (2 * Double(intrinsics[1][1])))
                           : 2 * atan(Double(resolution.width) / (2 * Double(intrinsics[0][0])))
        var heading: Double?, accuracy = 30.0
        if let fused = routeGuide.cameraTrueHeading(frame: frame) { heading = fused.degrees; accuracy = fused.sigma }
        else if let compass = location.heading, compass.headingAccuracy >= 0, compass.headingAccuracy <= 30,
                Date().timeIntervalSince(compass.timestamp) < 2 {
            heading = compass.trueHeading; accuracy = max(10, compass.headingAccuracy)
        }
        return CameraPose(user: GeoPoint(latitude: fix.coordinate.latitude, longitude: fix.coordinate.longitude),
                          userAccuracy: fix.horizontalAccuracy, heading: heading, headingAccuracy: accuracy,
                          horizontalFOV: fov, at: Date())
    }

    func updateContext(_ context: CameraJourneyContext) {
        guard running else { return }
        // Another boarding stop or ride, or offline toggled: poll for the new one (or stop polling).
        if KanteVehicleFeed.pollKey(station: context.boardingStationID, line: context.line, destination: context.destination,
                                    offline: context.offline, simulated: context.simulated) != kantePollKey {
            startKante(context: context, token: epoch)
        }
        if CameraEvidenceLifecycle.contextChanged(self.context, context) {
            invalidateCameraEvidence(.contextChanged)
            invalidateLocalCameraEvidence(.contextChanged)
        }
        let previous = targetAnchor?.coordinate
        let previousContext = self.context
        self.context = context
        let changed: Bool
        if let old = previous, let new = context.target {
            changed = MKMapPoint(old).distance(to: MKMapPoint(new)) > 0.1 || previousContext?.targetLabel != context.targetLabel
        } else { changed = (previous == nil) != (context.target == nil) }
        // A changed boarding context must never keep a nearby old target/label simply because
        // its replacement is within the former8m distance threshold.
        guard changed || CameraEvidenceLifecycle.contextChanged(previousContext, context) else { return }
        if let targetAnchor { view.session.remove(anchor: targetAnchor); self.targetAnchor = nil }
        if localized, let target = context.target {
            let anchor = ARGeoAnchor(name: context.targetLabel, coordinate: target)
            targetAnchor = anchor; view.session.add(anchor: anchor)
        }
    }
    private func runWorldCamera() {
        guard running else { return }
        invalidateCameraEvidence(.restarted)
        invalidateLocalCameraEvidence(.restarted)
        cameraReady = true
        routeGuide.reset(); routePlan = nil
        geo = false; localized = false; targetAnchor = nil
        visual?.observation = nil
        let configuration = ARWorldTrackingConfiguration()
        // Horizontal planes give the real floor under the rider for the AR arrows (instead of a fixed 1.4 m).
        configuration.planeDetection = [.horizontal]
        if let localSite, !((context?.simulated) ?? true) {
            configuration.detectionImages = localSite.references
            configuration.maximumNumberOfTrackedImages = min(4, localSite.references.count)
            localSite.reset()
        }
        view.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
    }
    func importLocalSite(_ url: URL) {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        do {
            localSite = try LocalLandmarkSession(directory: url)
            localEvidence.installedPackDescription = "Installed \(localSite!.pack.siteID) · \(localSite!.pack.version)."
            localSiteImportError = nil
            geoTimeout?.cancel()
            runWorldCamera()
        } catch {
            invalidateLocalCameraEvidence(.failed)
            localSiteImportError = error.localizedDescription
        }
    }
    func setGeographicAR(_ enabled: Bool) {
        offlineCameraOnly = !enabled
        guard let context, let location, let visual else { return }
        start(context: context, location: location, visual: visual)
    }
    /// `at`: when the new generation starts. A frame that itself shows the movement passes its own capture time, so
    /// its result (taken at the new pose) is not rejected as older than the generation it started.
    private func invalidateCameraEvidence(_ reason: CameraEvidenceLifecycle.Invalidation, at: Date = Date()) {
        cameraEvidence.invalidate(reason, at: at)
        expiry?.cancel(); expiry = nil
        renderedPose = nil
        if reason != .moved && reason != .expired { trackedCamera = nil }
    }
    /// How far the camera went from `a` to `b`: metres, and degrees between the directions it looks in.
    static func movement(from a: simd_float4x4, to b: simd_float4x4) -> (metres: Float, degrees: Float) {
        let za = simd_normalize(SIMD3(a.columns.2.x, a.columns.2.y, a.columns.2.z))
        let zb = simd_normalize(SIMD3(b.columns.2.x, b.columns.2.y, b.columns.2.z))
        return (simd_distance(a.columns.3, b.columns.3), acos(max(-1, min(1, simd_dot(za, zb)))) * 180 / .pi)
    }
    /// Where the centre of the previous tracked picture lies in this one, as a fraction of the upright portrait
    /// picture (top-left origin): a point 20 m ahead of the previous camera, projected by both cameras. ARKit's own
    /// projection takes care of axes and signs. Zero outside portrait (the tracker then matches unshifted boxes).
    static func trackerShift(from previous: ARCamera?, to camera: ARCamera, upright: CGSize) -> CGPoint {
        guard let previous, upright.width > 0, upright.height > 0 else { return .zero }
        let t = previous.transform
        let ahead = SIMD3(t.columns.3.x, t.columns.3.y, t.columns.3.z) - 20 * SIMD3(t.columns.2.x, t.columns.2.y, t.columns.2.z)
        let was = previous.projectPoint(ahead, orientation: .portrait, viewportSize: upright)
        let now = camera.projectPoint(ahead, orientation: .portrait, viewportSize: upright)
        let shift = CGPoint(x: (now.x - was.x) / upright.width, y: (now.y - was.y) / upright.height)
        return shift.x.isFinite && shift.y.isFinite ? shift : .zero
    }
    private func invalidateLocalCameraEvidence(_ reason: CameraEvidenceLifecycle.Invalidation, resetAlignment: Bool = true) {
        localExpiry?.cancel(); localExpiry = nil
        let site = localSite
        let target = localSite == nil ? nil : visual
        if reason == .restarted {
            lastLocalFrame = 0
            localEvidence.start(session: epoch, at: Date(), visual: target) { site?.reset() }
        } else {
            localEvidence.invalidate(reason, at: Date(), visual: target) { if resetAlignment { site?.reset() } }
        }
    }
    private func scheduleLocalExpiry() {
        localExpiry?.cancel()
        guard let ticket = localEvidence.ticket else { return }
        let delay = max(0, min(LocalCameraEvidenceLifecycle.maximumAge, ticket.expiresAt.timeIntervalSinceNow))
        localExpiry = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self else { return }
            _ = self.localEvidence.expire(ticket, session: self.epoch, at: Date(), visual: self.visual, resetAlignment: {})
        }
    }
    func stop() {
        epoch = UUID(); running = false; processing = false
        routeGuide.reset(); routePlan = nil
        kanteTask?.cancel(); kanteTask = nil; kanteDue = []; kanteVehicles = []; kanteDueAt = nil; kanteVehiclesAt = nil; kantePollKey = nil
        boarding = nil; boardingKey = ""; kerbMessage = nil; boardingEdgeDescription = nil
        cameraReady = false
        invalidateCameraEvidence(.stopped)
        invalidateLocalCameraEvidence(.stopped)
        startup?.cancel(); expiry?.cancel(); geoTimeout?.cancel(); geoAvailabilityID = nil
        view.session.pause(); localized = false; targetAnchor = nil
        status = recognition
        // A converted camera position retains its real timestamp and expires on the map.
    }
    func session(_ session: ARSession, didChange geoTrackingStatus: ARGeoTrackingStatus) {
        guard running, geo else { return }
        localized = geoTrackingStatus.state == .localized && geoTrackingStatus.accuracy == .high && location?.accuracyAuthorization == .fullAccuracy
        if localized {
            geoTimeout?.cancel()
            status = "Camera aligned · geographic reference, not an exact pavement or platform."
            if targetAnchor == nil, let context, let target = context.target {
                let anchor = ARGeoAnchor(name: context.targetLabel, coordinate: target)
                targetAnchor = anchor; session.add(anchor: anchor)
            }
        } else {
            visual?.observation = nil
            if let targetAnchor { session.remove(anchor: targetAnchor); self.targetAnchor = nil }
            status = geoTrackingStatus.state == .notAvailable
                ? "Geographic alignment unavailable. Use the map; sign reading remains available."
                : "Aligning with nearby buildings… Geographic markers are hidden until tracking is reliable."
        }
    }
    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        guard running else { return }
        if case .normal = camera.trackingState { return }
        localized = false; visual?.observation = nil
        invalidateCameraEvidence(.trackingLost)
        invalidateLocalCameraEvidence(.trackingLost)
        if let targetAnchor { session.remove(anchor: targetAnchor); self.targetAnchor = nil }
        status = "Camera tracking interrupted. Hold steady and scan nearby buildings."
    }
    func sessionWasInterrupted(_ session: ARSession) { stop(); status = "Camera interrupted. Close and reopen Camera addition." }
    func session(_ session: ARSession, didFailWithError error: Error) {
        guard running else { return }
        stop(); visual?.observation = nil
        status = "Camera guidance stopped. Close and reopen it, or continue with the map."
    }
    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard running, cameraReady, let context else { return }
        let token = epoch
        if ProcessInfo.processInfo.thermalState == .critical {
            invalidateLocalCameraEvidence(.thermal)
            invalidateCameraEvidence(.thermal)
            return
        }
        // Route arrows in plain world tracking. With Apple geographic AR active its anchor is used instead;
        // a simulated journey has no real position to align with.
        if !geo, !context.simulated {
            let key = context.id + "|" + (kanteDueAt.map { String($0.timeIntervalSince1970) } ?? "-") + "|" + (edgePack == nil ? "0" : "1")
            if key != boardingKey || frame.timestamp - lastBoardingCheck >= 1 {
                boardingKey = key; lastBoardingCheck = frame.timestamp
                boarding = boardingTarget(context)
            }
            let boarding = self.boarding
            let target = boarding.map { CLLocationCoordinate2D(latitude: $0.edge.point.latitude, longitude: $0.edge.point.longitude) }
            routeGuide.update(frame: frame, location: location, route: context.route, target: target ?? context.routeEnd ?? context.target,
                              targetLabel: boarding?.label ?? context.stop ?? context.targetLabel, contextID: context.id,
                              targetZ: boarding?.floor?.z)
            if boardingEdgeDescription != boarding?.label { boardingEdgeDescription = boarding?.label }
            if frame.timestamp - lastKerbCheck >= 1 {
                lastKerbCheck = frame.timestamp
                var message: String?
                if let boarding,
                   KerbSide.applies(to: boarding.edge, floor: boarding.floor, stationModelled: levelPack?.station(uic: boarding.edge.uic) != nil),
                   let fix = location?.latestLocation, fix.horizontalAccuracy > 0, location?.isStale() == false {
                    let user = GeoPoint(latitude: fix.coordinate.latitude, longitude: fix.coordinate.longitude)
                    let siblings = edgePack?.edges(uic: boarding.edge.uic) ?? []
                    message = KerbSide.assess(user: user, accuracy: fix.horizontalAccuracy, edge: boarding.edge, siblings: siblings)
                        .message(edgeName: boarding.edge.ref.isEmpty ? "your stop" : "Kante \(boarding.edge.ref)")
                }
                if kerbMessage != message { kerbMessage = message }
            }
            if routePlan != routeGuide.plan { routePlan = routeGuide.plan }
        }
        if let localSite, !context.simulated, frame.timestamp - lastLocalFrame >= 0.2 {
            lastLocalFrame = frame.timestamp
            updateLocalPresentation(frame: frame, site: localSite, context: context)
        }
        if geo, let state = frame.geoTrackingStatus {
            let normal: Bool
            if case .normal = frame.camera.trackingState { normal = true } else { normal = false }
            let reliable = state.state == .localized && state.accuracy == .high && normal && location?.accuracyAuthorization == .fullAccuracy
            if reliable && !localized { self.session(session, didChange: state) }
            if !reliable && localized {
                status = "Geographic alignment is uncertain. Use the map or local signs."
                localized = false; visual?.observation = nil
                if let targetAnchor { session.remove(anchor: targetAnchor); self.targetAnchor = nil }
            }
        }
        if localized, frame.timestamp - lastPose >= 1, case .normal = frame.camera.trackingState {
            lastPose = frame.timestamp
            let p = frame.camera.transform.columns.3
            let capturedAt = Date()
            session.getGeoLocation(forPoint: SIMD3(p.x, p.y, p.z)) { [weak self] coordinate, _, error in
                Task { @MainActor [weak self] in
                    guard let self, self.running, self.epoch == token, self.localized, error == nil,
                          CLLocationCoordinate2DIsValid(coordinate),
                          !SensorFixFreshness.isStale(timestamp: capturedAt),
                          let location = self.location, !location.isStale(), let fix = location.latestLocation,
                          CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude).distance(from: fix) <= max(50, 2 * fix.horizontalAccuracy) else { return }
                    self.visual?.observation = VisualLocation(coordinate: coordinate, capturedAt: capturedAt)
                }
            }
        }
        // When this frame was taken (a little before now), less a margin for the two clock readings
        let frameTaken = Date().addingTimeInterval(-max(0, ProcessInfo.processInfo.systemUptime - frame.timestamp) - 0.01)
        // The overlay was drawn for a pose: a small movement clears it (the tracks stay), a big turn resets the tracks.
        if let renderedPose {
            let m = Self.movement(from: renderedPose, to: frame.camera.transform)
            if m.metres > 0.5 || m.degrees > 15 { invalidateCameraEvidence(.turned, at: frameTaken) }
            else if m.metres > 0.05 || m.degrees > 3.6 { invalidateCameraEvidence(.moved, at: frameTaken) }
        }
        guard case .normal = frame.camera.trackingState else {
            invalidateCameraEvidence(.trackingLost)
            return
        }
        if cameraEvidence.feedbackExpired(at: Date()) { invalidateCameraEvidence(.expired, at: frameTaken) }
        let thermal = ProcessInfo.processInfo.thermalState
        guard thermal != .critical else {
            invalidateCameraEvidence(.thermal); return
        }
        let interval = thermal == .serious ? 1.2 : ProcessInfo.processInfo.isLowPowerModeEnabled ? 0.8 : 0.4
        let frameAge = ProcessInfo.processInfo.systemUptime - frame.timestamp
        guard frameAge >= 0, frameAge < 0.15,
              !processing, frame.timestamp - lastOCR >= interval, view.bounds.width > 0, workGate.acquire() else { return }
        processing = true; lastOCR = frame.timestamp
        let orientation = view.window?.windowScene?.interfaceOrientation ?? .portrait
        // Tracks follow the camera between processed frames; a turn too big to follow starts them afresh.
        if let tracked = trackedCamera {
            let m = Self.movement(from: tracked.transform, to: frame.camera.transform)
            if m.metres > 0.5 || m.degrees > 15 { invalidateCameraEvidence(.turned, at: frameTaken) }
        }
        let upright = CGSize(width: CVPixelBufferGetHeight(frame.capturedImage), height: CVPixelBufferGetWidth(frame.capturedImage))
        let trackShift = orientation == .portrait ? Self.trackerShift(from: trackedCamera, to: frame.camera, upright: upright) : .zero
        trackedCamera = frame.camera
        let imageOrientation: CGImagePropertyOrientation = orientation == .portrait ? .right : orientation == .portraitUpsideDown ? .left : orientation == .landscapeRight ? .down : .up
        let transform = frame.displayTransform(for: orientation, viewportSize: view.bounds.size)
        let buffer = CapturedPixelBuffer(value: frame.capturedImage), pose = frame.camera.transform, capturedAt = Date().addingTimeInterval(-frameAge)
        let cameraPose = self.cameraPose(frame, portrait: orientation == .portrait || orientation == .portraitUpsideDown)
        let visionToken = cameraEvidence.epoch, trackingToken = cameraEvidence.trackingEpoch
        let pipeline = self.pipeline, workGate = self.workGate
        worker.async { [weak self] in
            defer { workGate.release() }
            let outcome: Result<VehicleFrameResult, Error> = autoreleasepool {
                Result { try pipeline.process(buffer: buffer.value, orientation: imageOrientation, at: capturedAt, epoch: trackingToken,
                                              shift: trackShift, trackGap: 2.5 * interval) }
            }
            Task { @MainActor [weak self] in
                guard let self, self.running, self.epoch == token else { return }
                self.processing = false
                guard self.cameraEvidence.epoch == visionToken else { return }
                guard ProcessInfo.processInfo.thermalState != .critical else {
                    self.invalidateCameraEvidence(.thermal); return
                }
                guard case let .success(result) = outcome else {
                    self.invalidateCameraEvidence(.failed)
                    if case let .failure(error) = outcome { self.diagnostics = error.localizedDescription }
                    return
                }
                self.diagnostics = "Local pipeline \(Int(result.latencyMS)) ms · \(result.tracks.count) tracks · \(thermal == .nominal ? "normal" : "reduced") processing"
                guard let current = self.view.session.currentFrame,
                      case .normal = current.camera.trackingState,
                      simd_distance(current.camera.transform.columns.3, pose.columns.3) < 0.05,
                      simd_dot(current.camera.transform.columns.2, pose.columns.2) > 0.998 else {
                    self.invalidateCameraEvidence(.moved); return
                }
                var expected = context.serviceExpectation
                    ?? context.line.flatMap { line in context.destination.map {
                        VehicleServiceExpectation(line: line, destination: $0, requiresRouteContext: true)
                    } }
                // Services Kante says are about to stop here join the departure-board candidates (fresh answers only).
                let freshDue = self.kanteDueAt.map { Date().timeIntervalSince($0) <= VehiclePositionEvidence.dueMaximumAge } == true ? self.kanteDue : []
                let dueCandidates = VehiclePositionEvidence.candidates(from: freshDue)
                if var e = expected, !dueCandidates.isEmpty {
                    for c in dueCandidates where !e.boardAlternatives.contains(where: { $0.identity == c.identity }) { e.boardAlternatives.append(c) }
                    expected = e
                }
                let candidates = expected.map { [DisplayCandidate(line: $0.line, destination: $0.destination, isExpected: true)] + $0.boardAlternatives } ?? []
                let now = Date()
                let decisions = result.tracks.map { track -> VehicleDecision in
                    let positions = !freshDue.isEmpty
                        ? VehiclePositionEvidence.dueLikelihoods(for: track.detection.box, pose: cameraPose, due: freshDue, candidates: candidates,
                                                                 now: now, fetchedAt: self.kanteDueAt)
                        : VehiclePositionEvidence.likelihoods(for: track.detection.box, pose: cameraPose,
                              vehicles: self.kanteVehiclesAt.map { Date().timeIntervalSince($0) <= VehiclePositionEvidence.dueMaximumAge } == true ? self.kanteVehicles : [],
                              candidates: candidates)
                    return VehicleServiceMatcher.decide(track, expected: expected, now: now, positions: positions,
                                                        freshness: 0.4 + interval, window: max(2, 2.5 * interval))
                }
                func viewBox(_ upright: CGRect) -> CGRect {
                    CameraImageGeometry.rawBox(CGRect(x: upright.minX, y: 1 - upright.maxY, width: upright.width, height: upright.height), orientation: imageOrientation).applying(transform)
                }
                let signs: [CameraTextMatch] = result.signTexts.compactMap { text in
                    guard let label = context.match(text.text) else { return nil }
                    return CameraTextMatch(box: viewBox(text.box), text: text.text, label: label)
                }
                let overlays = zip(result.tracks, decisions).map { track, decision in
                    CameraVehicleOverlay(id: track.id, box: viewBox(track.detection.box),
                        maskRuns: track.detection.mask.runs.map(viewBox), title: track.detection.caption, decision: decision,
                        displayText: track.readings.last?.displayText, capturedAt: track.readings.last?.at)
                }
                guard self.cameraEvidence.publish(vehicles: overlays, matches: signs, token: visionToken,
                                                  capturedAt: capturedAt, now: Date(), routeValidUntil: expected?.validUntil,
                                                  displayIssues: result.displayIssues, cadence: interval) else {
                    self.renderedPose = nil
                    return
                }
                self.renderedPose = pose
                if let id = self.cameraEvidence.candidateID, let track = result.tracks.first(where: { $0.id == id }) {
                    if let identity = self.fleet?.supportingIdentity(for: track, now: Date()) { self.diagnostics += "\n" + identity }
                    if !context.simulated, let observation = VehicleWireAdapter.observation(track, at: capturedAt, imageSize: result.imageSize) {
                        self.onObservation?(observation)
                    }
                }
                self.expiry?.cancel()
                if let feedbackID = self.cameraEvidence.feedbackID, let deadline = self.cameraEvidence.expiresAt {
                    self.expiry = Task { [weak self] in
                        do { try await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow))) } catch { return }
                        guard let self, self.cameraEvidence.expire(feedbackID, at: Date()) else { return }
                        self.renderedPose = nil
                    }
                }
            }
        }
    }
    private func updateLocalPresentation(frame: ARFrame, site: LocalLandmarkSession, context: CameraJourneyContext) {
        let generation = localEvidence.generation
        let acquisitionEpoch = site.acquisitionEpoch
        let result = site.update(frame: frame, now: Date(), stopID: context.boardingPointID, coarseFix: location?.latestLocation)
        guard acquisitionEpoch == site.acquisitionEpoch else {
            invalidateLocalCameraEvidence(.trackingLost)
            return
        }
        guard let assessment = site.assessment, assessment.status == .reliable,
              let pose = assessment.siteFromCamera, let siteFromWorld = site.siteFromWorld,
              let validityDeadline = site.selectedValidUntil else {
            // Candidate frames must retain C's accumulating consensus, while old displayed
            // evidence is removed immediately. Resetting consensus here would prevent relocalization.
            localExpiry?.cancel(); localExpiry = nil
            localEvidence.clearPresentation(visual: visual)
            return
        }
        let at = assessment.at
        let payload = LocalLandmarkWire.observation(pack: site.pack, pose: pose, sessionID: epoch, at: at)
        guard let bridge = localPoseBridge,
              (try? bridge.call("validateVisualPose", .object(["observation": payload]))) != nil,
              let coordinate = LocalLandmarkWire.coordinate(pack: site.pack, pose: pose) else {
            invalidateLocalCameraEvidence(.failed)
            return
        }
        var area: (label: String, node: SCNNode)?
        if let result {
            let worldFromSite = simd_inverse(siteFromWorld)
            var points = result.area.polygon.map { point -> SCNVector3 in
                let p = worldFromSite * SIMD4(Float(point.x), Float(point.y), Float(result.area.floorHeightMeters + 0.05), 1)
                return SCNVector3(p.x, p.y, p.z)
            }
            if let first = points.first { points.append(first) }
            let source = SCNGeometrySource(vertices: points)
            var indices: [Int32] = []
            for i in 0..<(points.count - 1) { indices.append(Int32(i)); indices.append(Int32(i + 1)) }
            let geometry = SCNGeometry(sources: [source], elements: [SCNGeometryElement(indices: indices, primitiveType: .line)])
            geometry.firstMaterial?.diffuse.contents = UIColor.systemTeal
            area = (result.area.label, SCNNode(geometry: geometry))
        }
        let accepted = localEvidence.publish(pose: pose,
            location: VisualLocation(coordinate: coordinate, capturedAt: at, maximumAge: LocalCameraEvidenceLifecycle.maximumAge),
            area: area, root: view.scene.rootNode, session: epoch, generation: generation, capturedAt: at,
            now: Date(), validUntil: validityDeadline, areaIdentity: result?.area.id,
            evaluationFrameTime: frame.timestamp, visual: visual) { site.reset() }
        if accepted { scheduleLocalExpiry() }
    }
    nonisolated func renderer(_ renderer: SCNSceneRenderer, nodeFor anchor: ARAnchor) -> SCNNode? {
        guard let anchor = anchor as? ARGeoAnchor else { return nil }
        // Broad geographic reference, never a precise ground arrow.
        return JourneyReferenceMarker.make(label: anchor.name ?? "Journey reference")
    }
}

private struct LiveCameraSurface: UIViewRepresentable {
    let controller: LiveCameraController
    let journeyContext: CameraJourneyContext
    func makeCoordinator() -> LiveCameraController { controller }
    func makeUIView(context: Context) -> ARSCNView { controller.view }
    func updateUIView(_ uiView: ARSCNView, context: Context) { controller.updateContext(journeyContext) }
    static func dismantleUIView(_ uiView: ARSCNView, coordinator: LiveCameraController) { coordinator.stop() }
}

/// User-triggered speech only. A changed/expired instruction cancels the old utterance.
@MainActor private final class CameraGuidanceSpeech: ObservableObject {
    private let synthesizer = AVSpeechSynthesizer()
    var available: Bool { AVSpeechSynthesisVoice(language: "en-GB") != nil }
    func read(_ message: String) {
        stop()
        guard let voice = AVSpeechSynthesisVoice(language: "en-GB") else { return }
        let utterance = AVSpeechUtterance(string: message)
        utterance.voice = voice
        synthesizer.speak(utterance)
    }
    func stop() { synthesizer.stopSpeaking(at: .immediate) }
}

private struct CameraVehicleBadge: View {
    let vehicle: CameraVehicleOverlay
    var compact = false
    var color: Color {
        switch vehicle.decision.state {
        case .conflicting: return .red
        case .visualCandidate: return .primary // the display matches, nothing more: neutral, never amber
        case .verifiedService: return .green
        case .unknown: return .secondary
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Label(vehicle.badge, systemImage: vehicle.symbol).font(compact ? .caption.bold() : .subheadline.bold())
            Text(vehicle.displayText ?? "Full display unreadable").font(compact ? .caption : .body)
                .lineLimit(compact ? 2 : nil)
            if !compact { Text("\(vehicle.title) · observed display, not permission to board").font(.caption).foregroundStyle(.secondary) }
        }
        .foregroundStyle(color)
        .padding(compact ? 6 : 10)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
    }
}

struct LiveCameraGuidanceView: View {
    let context: CameraJourneyContext
    @ObservedObject var location: LocationController
    @ObservedObject var visual: VisualLocationStore
    var onObservation: ((JSONValue) -> Void)? = nil
    @StateObject private var controller = LiveCameraController()
    @StateObject private var speech = CameraGuidanceSpeech()
    @Environment(\.scenePhase) private var scenePhase
    @State private var photoReader = false
    @State private var details = false
    @State private var importingSite = false

    var body: some View {
        ScrollView {
        VStack(spacing: 0) {
            ZStack(alignment: .topLeading) {
                LiveCameraSurface(controller: controller, journeyContext: context)
                GeometryReader { proxy in
                    ForEach(controller.vehicles) { vehicle in
                        // Green only for verified service, red only from the display; a display match alone is neutral (no amber)
                        let color: Color = vehicle.decision.state == .conflicting ? .red : vehicle.decision.state == .verifiedService ? .green : .white
                        Path { path in
                            for run in vehicle.maskRuns {
                                path.addRect(CGRect(x: run.minX * proxy.size.width, y: run.minY * proxy.size.height,
                                                    width: run.width * proxy.size.width, height: run.height * proxy.size.height))
                            }
                        }.fill(color.opacity(0.3))
                        RoundedRectangle(cornerRadius: 6).stroke(color, lineWidth: 2)
                            .frame(width: vehicle.box.width * proxy.size.width, height: vehicle.box.height * proxy.size.height)
                            .offset(x: vehicle.box.minX * proxy.size.width, y: vehicle.box.minY * proxy.size.height)
                        CameraVehicleBadge(vehicle: vehicle, compact: true)
                            .frame(width: min(240, max(120, proxy.size.width - 24)), alignment: .leading)
                            .offset(x: max(8, min(proxy.size.width - min(240, max(120, proxy.size.width - 24)) - 8, vehicle.box.minX * proxy.size.width)),
                                    y: max(8, min(proxy.size.height - 80, vehicle.box.minY * proxy.size.height - 55)))
                            .accessibilityHidden(true)
                    }
                    ForEach(controller.matches) { match in
                        RoundedRectangle(cornerRadius: 5).stroke(.yellow, lineWidth: 3)
                            .frame(width: match.box.width * proxy.size.width, height: match.box.height * proxy.size.height)
                            .offset(x: match.box.minX * proxy.size.width, y: match.box.minY * proxy.size.height)
                    }
                    if let plan = controller.routePlan, plan.mode == .direction, let turn = plan.turn {
                        // Direction only: one arrow, rotated towards the route ahead (positive turn = left).
                        Image(systemName: "arrow.up.circle.fill").font(.system(size: 56)).foregroundStyle(.white, Color.rightSideTeal)
                            .rotationEffect(.radians(-turn)).shadow(radius: 4)
                            .position(x: proxy.size.width / 2, y: proxy.size.height - 60)
                    }
                }.allowsHitTesting(false)
            }.frame(height: 420).clipped().accessibilityLabel("Live camera. Vehicle masks are model estimates; an orange match needs service verification.")
            VStack(alignment: .leading, spacing: 14) {
                Label(controller.status, systemImage: controller.localized ? "location.viewfinder" : "camera.viewfinder")
                    .font(.headline).accessibilityIdentifier("geographic-ar-status")
                if let edge = controller.boardingEdgeDescription {
                    Label("Board at \(edge)", systemImage: "mappin.and.ellipse").font(.subheadline).accessibilityIdentifier("ar-boarding-edge")
                }
                if let kerb = controller.kerbMessage {
                    Label(kerb, systemImage: "road.lanes").font(.subheadline).accessibilityIdentifier("ar-kerb-side")
                }
                if let plan = controller.routePlan {
                    Label(plan.summary, systemImage: plan.mode == .path ? "arrow.triangle.turn.up.right.diamond" : "location.north.line")
                        .font(.subheadline).accessibilityIdentifier("ar-route-status")
                    if let distance = plan.targetDistance {
                        Text("About \(Int(distance.rounded())) m to \(context.stop ?? "the stop") in a straight line").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Toggle("Geographic AR", isOn: Binding(get: { !controller.offlineCameraOnly }, set: { controller.setGeographicAR($0) }))
                    .accessibilityIdentifier("geographic-ar-toggle")
                if !controller.offlineCameraOnly {
                    Text("Uses Apple localization coverage and a fresh precise location. A floating marker is a geographic reference, not an exact curb or walking path.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    HStack {
                        Button(location.isRequesting ? "Finding location…" : "Get location", systemImage: "location") { location.requestLocation() }
                            .disabled(location.isRequesting).frame(minHeight: 44)
                        Button("Retry alignment", systemImage: "arrow.clockwise") { controller.setGeographicAR(true) }
                            .frame(minHeight: 44)
                    }.buttonStyle(.bordered)
                    LocationRequestFeedback(controller: location)
                    if context.target == nil { Text("Choose a journey to place its stop reference in the aligned view. You can test camera alignment without one.").font(.subheadline) }
                }
                if let line = context.line, let destination = context.destination {
                    Text("Compare before boarding").font(.caption).foregroundStyle(.secondary)
                    Text("\(line) → \(destination)").font(.headline)
                    if let expected = context.serviceExpectation,
                       let alighting = expected.downstreamCalls.first(where: { $0.id == expected.alightingCallID }) {
                        Text("Your stop: \(alighting.name)").font(.subheadline)
                    }
                }
                HStack(alignment: .top) {
                    Label(controller.cameraReady ? controller.recognition : controller.status, systemImage: "viewfinder").font(.callout)
                    Spacer()
                    Menu {
                        Button("Recognition details") { details = true }
                        Button("Read a photo") { controller.stop(); photoReader = true }
                        if controller.permissionDenied { Button("Camera settings") { location.openSettings() } }
                        if location.accuracyAuthorization == .reducedAccuracy { Button("Precise location") { location.requestPreciseLocation() } }
                    } label: { Image(systemName: "ellipsis.circle").font(.title2) }.accessibilityLabel("Camera options")
                }
                ForEach(controller.vehicles) { vehicle in
                    CameraVehicleBadge(vehicle: vehicle)
                }
                HStack {
                    Button("Read guidance", systemImage: "speaker.wave.2") {
                        speech.read(controller.cameraReady ? controller.recognition : controller.status)
                    }.disabled(!speech.available)
                    Button("Read a photo", systemImage: "photo") { controller.stop(); photoReader = true }
                }.buttonStyle(.bordered)
                Text("A display match does not confirm a unique trip, your waiting area, or that boarding is safe.")
                    .font(.caption).foregroundStyle(.secondary)
            }.padding(20).background(Color(uiColor: .systemBackground), in: UnevenRoundedRectangle(topLeadingRadius: 24, topTrailingRadius: 24))
        }
        }
        .background(Color(uiColor: .systemBackground))
        .task(id: context.id) {
            controller.onObservation = onObservation
            if scenePhase == .active && !photoReader { controller.start(context: context, location: location, visual: visual) }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active && !photoReader { controller.start(context: context, location: location, visual: visual) }
            else { controller.stop(); speech.stop() }
        }
        .onChange(of: controller.recognition) { _, _ in speech.stop() }
        .onChange(of: controller.status) { _, _ in speech.stop() }
        .onDisappear { controller.stop(); speech.stop() }
        .fileImporter(isPresented: $importingSite, allowedContentTypes: [.folder]) { result in
            if case let .success(url) = result { controller.importLocalSite(url) }
        }
        .sheet(isPresented: $details) {
            NavigationStack {
                List {
                    Section("Current guidance") {
                        Text(context.title)
                        Text(controller.status)
                        Text(controller.localSiteStatus)
                        Text("Colored regions are estimated vehicle masks. Orange means the display repeatedly matches; it does not verify a unique trip or a safe place to board.")
                        Text("No authoritative live vehicle binding is configured. Model appearance and fleet references are supporting evidence only.")
                    }
                    if !controller.boardingReferences.isEmpty {
                        Section("Nearby mapped boarding points") {
                            ForEach(controller.boardingReferences.prefix(6)) { point in
                                VStack(alignment: .leading) {
                                    Text("\(point.name) \(point.label)")
                                    Text(point.id).font(.caption)
                                    if let direction = point.directionDegrees { Text("Travel direction \(Int(direction))° · side unverified").font(.caption) }
                                }
                            }
                            Text("Source: opentransportdata.swiss / atlas. These points are not surveyed safe waiting areas.").font(.caption)
                        }
                    }
                    Section("Installed local references") {
                        Text(controller.localSiteMetadata)
                        if let error = controller.localSiteImportError { Text(error) }
                    }
                    Section("Local processing") {
                        Text("Recognition is experimental. Verify the line and destination on the vehicle before boarding.").font(.body)
                        Text("Camera inference runs on this device. Optional geographic AR uses Apple localization services. No surveyed local landmark pack is included yet.")
                        Text("YOLOE model: Ultralytics AGPL-3.0. See the included model and data notices before distribution.").font(.caption)
                    }
                }.navigationTitle("Camera details")
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { details = false } } }
            }
        }
        .sheet(isPresented: $photoReader, onDismiss: { if scenePhase == .active { controller.start(context: context, location: location, visual: visual) } }) {
            NavigationStack {
                CameraAssistanceView(line: context.line, destination: context.destination)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { photoReader = false } } }
            }
        }
    }
}

/// A local, camera-relative scene estimate. Never publishes geographic location,
/// boarding confirmation, obstacle clearance, or journey progress.
@MainActor final class SpatialARController: NSObject, ObservableObject, @preconcurrency ARSessionDelegate, @preconcurrency ARSCNViewDelegate {
    let view = ARSCNView(frame: .zero)
    @Published private(set) var status = "Opening 3D camera…"
    @Published private(set) var tracking = false
    @Published private(set) var sections = 0
    @Published private(set) var permissionDenied = false
    let supportsMesh = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    private var running = false
    private var generation = UUID()
    private var startup: Task<Void, Never>?
    private var lastReport = 0.0
    private var startedAt: Date?
    private var maximumSections = 0
    private var observedTracking = false
    nonisolated private let meshUpdates = SpatialMeshUpdates()
    nonisolated private let renderTiming = SpatialRenderTiming()
    private let reportQueue = DispatchQueue(label: "rightside.ar-reports", qos: .utility)
    private var lastDiagnostic = 0.0
    private var cameraFrames = 0
    private var maximumFrameDeliveryMS = 0.0

    override init() {
        super.init()
        view.session.delegate = self
        view.session.delegateQueue = .main
        view.delegate = self
        view.scene = SCNScene()
        view.preferredFramesPerSecond = 60
        view.antialiasingMode = .none
        view.automaticallyUpdatesLighting = false
    }
    func start() {
        stop()
        let token = generation
        running = true; sections = 0; tracking = false; maximumSections = 0; observedTracking = false
        lastDiagnostic = 0; cameraFrames = 0; maximumFrameDeliveryMS = 0
        meshUpdates.reset(); renderTiming.reset()
        status = "Opening 3D camera…"; permissionDenied = false; startedAt = Date()
        startup = Task { [weak self] in
            let allowed: Bool
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: allowed = true
            case .notDetermined: allowed = await AVCaptureDevice.requestAccess(for: .video)
            default: allowed = false
            }
            guard let self, self.running, self.generation == token, !Task.isCancelled else { return }
            guard allowed else {
                self.permissionDenied = true
                self.status = "Allow camera access in Settings to scan your surroundings."
                return
            }
            guard ARWorldTrackingConfiguration.isSupported else {
                self.status = "3D tracking is unavailable on this device."
                return
            }
            let configuration = ARWorldTrackingConfiguration()
            // Keep camera motion at 60 Hz without selecting a costly high-resolution capture format.
            if let format = ARWorldTrackingConfiguration.supportedVideoFormats.filter({ $0.framesPerSecond == 60 }).min(by: {
                $0.imageResolution.width * $0.imageResolution.height < $1.imageResolution.width * $1.imageResolution.height
            }) { configuration.videoFormat = format }
            if self.supportsMesh { configuration.sceneReconstruction = .mesh }
            else { configuration.planeDetection = [.horizontal, .vertical] }
            self.status = self.supportsMesh ? "Move the camera slowly across nearby surfaces." : "LiDAR is unavailable. Scanning flat surfaces only."
            self.view.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
        }
    }
    func stop() {
        if running { saveSessionReport(ended: true) }
        meshUpdates.reset()
        generation = UUID(); running = false; tracking = false
        startup?.cancel(); startup = nil
        view.session.pause()
        view.session.currentFrame?.anchors.forEach { view.node(for: $0)?.isHidden = true }
    }
    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard running else { return }
        cameraFrames += 1
        if cameraFrames > 120 {
            maximumFrameDeliveryMS = max(maximumFrameDeliveryMS, max(0, ProcessInfo.processInfo.systemUptime - frame.timestamp) * 1000)
        }
        guard frame.timestamp - lastReport >= 0.5 else { return }
        lastReport = frame.timestamp
        if ProcessInfo.processInfo.thermalState == .critical {
            stop(); status = "Scanning paused while the iPhone cools down. Restart when it is ready."
            return
        }
        let normal: Bool
        if case .normal = frame.camera.trackingState { normal = true; observedTracking = true }
        else { normal = false }
        if tracking != normal { tracking = normal }
        let scanned = frame.anchors.filter { $0 is ARMeshAnchor || $0 is ARPlaneAnchor }
        for anchor in scanned { view.node(for: anchor)?.isHidden = !tracking }
        if sections != scanned.count { sections = scanned.count }
        maximumSections = max(maximumSections, sections)
        let message = tracking ? (sections > 0 ? "Tracking your surroundings" : "Tracking ready · slowly scan a nearby surface") : trackingMessage(frame.camera.trackingState)
        if status != message { status = message }
        if frame.timestamp - lastDiagnostic >= 5 {
            lastDiagnostic = frame.timestamp
            saveSessionReport(ended: false)
        }
    }
    private func trackingMessage(_ state: ARCamera.TrackingState) -> String {
        switch state {
        case .normal: return "Tracking your surroundings"
        case .notAvailable: return "Tracking unavailable. Try restarting the scan."
        case .limited(let reason):
            switch reason {
            case .initializing: return "Starting tracking · move the camera slowly"
            case .excessiveMotion: return "Move more slowly to keep surfaces aligned"
            case .insufficientFeatures: return "Point at a textured, well-lit surface"
            case .relocalizing: return "Restoring tracking · return to the area you scanned"
            @unknown default: return "Tracking is limited. Hold the camera steady."
            }
        }
    }
    func sessionWasInterrupted(_ session: ARSession) {
        stop(); status = "Camera interrupted. Tap Restart scan to continue."
    }
    func session(_ session: ARSession, didFailWithError error: Error) {
        stop(); status = "3D tracking stopped. Tap Restart scan to try again."
    }
    private func saveSessionReport(ended: Bool) {
        guard let startedAt, let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return }
        let report: [String: Any] = ["startedAt": WireClock.string(startedAt), "sampledAt": WireClock.string(), "sessionEnded": ended,
            "lidarSupported": supportsMesh, "normalTrackingObserved": observedTracking,
            "maximumObservedSections": maximumSections, "cameraFrames": cameraFrames,
            "maximumCameraFrameDeliveryMSAfterWarmup": maximumFrameDeliveryMS,
            "renderTiming": renderTiming.snapshot(),
            "note": "Local ARKit estimates only. No images or mesh geometry saved. No geographic or walking-safety claim."]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            let destination = directory.appendingPathComponent("ar-session.json")
            reportQueue.async { try? data.write(to: destination, options: .atomic) }
        }
    }
    nonisolated func renderer(_ renderer: SCNSceneRenderer, nodeFor anchor: ARAnchor) -> SCNNode? {
        if let mesh = anchor as? ARMeshAnchor {
            let node = SCNNode()
            node.isHidden = true // Expose only after a normal-tracking frame.
            meshUpdates.enqueue(mesh, node: node)
            return node
        }
        if let plane = anchor as? ARPlaneAnchor, let device = renderer.device,
           let geometry = ARSCNPlaneGeometry(device: device) {
            geometry.update(from: plane.geometry)
            geometry.materials = [Self.surfaceMaterial()]
            let node = SCNNode(geometry: geometry); node.isHidden = true
            return node
        }
        return nil
    }
    nonisolated func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
        if let mesh = anchor as? ARMeshAnchor { meshUpdates.enqueue(mesh, node: node) }
        else if let plane = anchor as? ARPlaneAnchor, let geometry = node.geometry as? ARSCNPlaneGeometry {
            geometry.update(from: plane.geometry)
        }
    }
    nonisolated func renderer(_ renderer: SCNSceneRenderer, didRemove node: SCNNode, for anchor: ARAnchor) {
        meshUpdates.remove(anchor.identifier)
    }
    nonisolated func renderer(_ renderer: SCNSceneRenderer, updateAtTime time: TimeInterval) {
        renderTiming.frame(time)
        // Coalesce repeated anchor updates and apply at most one surface rebuild per render frame.
        if let update = meshUpdates.next(at: time) { update.node.geometry = Self.meshGeometry(update.anchor.geometry) }
    }
    nonisolated private static func surfaceMaterial() -> SCNMaterial {
        let material = SCNMaterial()
        material.diffuse.contents = UIColor(red: 0.25, green: 1, blue: 0.65, alpha: 1)
        material.lightingModel = .constant
        material.fillMode = .lines
        material.isDoubleSided = true
        return material
    }
    nonisolated private static func meshGeometry(_ mesh: ARMeshGeometry) -> SCNGeometry? {
        let vertices = mesh.vertices, faces = mesh.faces
        guard vertices.count > 0, vertices.count <= 100_000, vertices.componentsPerVector == 3,
              faces.count > 0, faces.count <= 200_000, faces.indexCountPerPrimitive == 3,
              [2, 4].contains(faces.bytesPerIndex) else { return nil }
        // Copy buffers so later ARKit mesh refinements cannot mutate a rendered geometry.
        let vertexLength = vertices.offset + vertices.stride * (vertices.count - 1) + 3 * MemoryLayout<Float>.size
        let indexLength = faces.count * faces.indexCountPerPrimitive * faces.bytesPerIndex
        guard vertexLength <= vertices.buffer.length, indexLength <= faces.buffer.length else { return nil }
        let source = SCNGeometrySource(data: Data(bytes: vertices.buffer.contents(), count: vertexLength),
            semantic: .vertex, vectorCount: vertices.count, usesFloatComponents: true,
            componentsPerVector: 3, bytesPerComponent: MemoryLayout<Float>.size,
            dataOffset: vertices.offset, dataStride: vertices.stride)
        let element = SCNGeometryElement(data: Data(bytes: faces.buffer.contents(), count: indexLength),
            primitiveType: .triangles, primitiveCount: faces.count, bytesPerIndex: faces.bytesPerIndex)
        let geometry = SCNGeometry(sources: [source], elements: [element])
        geometry.materials = [surfaceMaterial()]
        return geometry
    }
}

private struct SpatialARSurface: UIViewRepresentable {
    let controller: SpatialARController
    func makeCoordinator() -> SpatialARController { controller }
    func makeUIView(context: Context) -> ARSCNView { controller.view }
    func updateUIView(_ view: ARSCNView, context: Context) {}
    static func dismantleUIView(_ view: ARSCNView, coordinator: SpatialARController) { coordinator.stop() }
}

private struct SpatialARView: View {
    @StateObject private var controller = SpatialARController()
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    SpatialARSurface(controller: controller)
                        .frame(height: max(260, geometry.size.height * 0.65)).clipped()
                        .overlay(alignment: .topLeading) {
                            Label(controller.tracking ? "Tracking" : "Aligning", systemImage: controller.tracking ? "viewfinder" : "viewfinder.circle")
                                .font(.headline).padding(12).background(.regularMaterial, in: Capsule()).padding()
                        }
                        .accessibilityLabel("Live 3D scan. Green wireframe follows estimated surfaces, not a route.")
                    VStack(alignment: .leading, spacing: 12) {
                        Text(controller.status).font(.title3.bold()).accessibilityIdentifier("spatial-ar-status")
                        Text(controller.supportsMesh ? "LiDAR · \(controller.sections) scanned sections" : "Surface detection · \(controller.sections) planes")
                            .font(.subheadline).foregroundStyle(.secondary)
                        Text("Green lines show the estimated shape of nearby surfaces. No GPS or journey is needed. Gaps and moving objects may be missed; this is not obstacle or safe-path guidance.")
                            .font(.subheadline)
                        Button("Restart scan", systemImage: "arrow.counterclockwise") { controller.start() }
                            .buttonStyle(TravelButtonStyle()).accessibilityIdentifier("restart-spatial-ar")
                        if controller.permissionDenied {
                            Button("Open camera settings") {
                                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                            }.frame(minHeight: 44)
                        }
                    }.padding(.horizontal, 20).padding(.bottom, 24)
                }
            }
        }
        .task { if scenePhase == .active { controller.start() } }
        .onChange(of: scenePhase) { _, phase in if phase == .active { controller.start() } else { controller.stop() } }
        .onDisappear { controller.stop() }
    }
}

struct ARExperienceView: View {
    let context: CameraJourneyContext
    @ObservedObject var location: LocationController
    @ObservedObject var visual: VisualLocationStore
    let onObservation: (JSONValue) -> Void
    let onDone: () -> Void
    @State private var mode: Int
    init(context: CameraJourneyContext, location: LocationController, visual: VisualLocationStore,
         onObservation: @escaping (JSONValue) -> Void, onDone: @escaping () -> Void) {
        self.context = context; self.location = location; self.visual = visual
        self.onObservation = onObservation; self.onDone = onDone
        // With a journey, open straight into journey guidance rather than the mesh scanner.
        _mode = State(initialValue: context.line != nil || context.target != nil ? 1 : 0)
    }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Camera mode", selection: $mode) {
                    Text("3D surroundings").tag(0)
                    Text("Journey camera").tag(1)
                    Text("Indoor lab").tag(2)
                }.pickerStyle(.segmented).padding().accessibilityIdentifier("ar-mode")
                if mode == 0 { SpatialARView() }
                else if mode == 1 { LiveCameraGuidanceView(context: context, location: location, visual: visual, onObservation: onObservation) }
                else { IndoorReplayLabView() }
            }
            .navigationTitle("AR & 3D").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done", action: onDone).accessibilityIdentifier("close-panel") } }
        }
    }
}


/// ARKit and SceneKit callbacks can use different queues. This queue only retains
/// immutable anchor snapshots; nodes are changed in SceneKit's render callback.
private final class SpatialMeshUpdates: @unchecked Sendable {
    struct Update { let anchor: ARMeshAnchor; let node: SCNNode }
    private let lock = NSLock()
    private var pending: [UUID: Update] = [:]
    private var order: [UUID] = []
    private var lastApplied: [UUID: TimeInterval] = [:]
    func reset() { lock.lock(); defer { lock.unlock() }; pending.removeAll(); order.removeAll(); lastApplied.removeAll() }
    func enqueue(_ anchor: ARMeshAnchor, node: SCNNode) {
        lock.lock(); defer { lock.unlock() }
        if pending[anchor.identifier] == nil {
            if order.count >= 64 { pending.removeValue(forKey: order.removeFirst()) }
            order.append(anchor.identifier)
        }
        pending[anchor.identifier] = Update(anchor: anchor, node: node)
    }
    func next(at time: TimeInterval) -> Update? {
        lock.lock(); defer { lock.unlock() }
        guard let index = order.firstIndex(where: { time - (lastApplied[$0] ?? -.infinity) >= 0.25 }) else { return nil }
        let id = order.remove(at: index)
        lastApplied[id] = time
        return pending.removeValue(forKey: id)
    }
    func remove(_ id: UUID) {
        lock.lock(); defer { lock.unlock() }
        pending.removeValue(forKey: id); lastApplied.removeValue(forKey: id); order.removeAll { $0 == id }
    }
}

final class SpatialRenderTiming: @unchecked Sendable {
    private let lock = NSLock()
    private var started: TimeInterval?
    private var previous: TimeInterval?
    private var intervals: [Double] = []
    func reset() { lock.lock(); defer { lock.unlock() }; started = nil; previous = nil; intervals.removeAll(keepingCapacity: true) }
    func frame(_ time: TimeInterval) {
        lock.lock(); defer { lock.unlock() }
        if started == nil { started = time }
        defer { previous = time }
        guard let previous, time - (started ?? time) > 2, time > previous, intervals.count < 7200 else { return }
        intervals.append((time - previous) * 1000)
    }
    func snapshot() -> [String: Double] {
        lock.lock(); let samples = intervals; lock.unlock()
        guard !samples.isEmpty else { return ["samples": 0] }
        let sorted = samples.sorted()
        return ["samples": Double(samples.count), "medianCallbackIntervalMS": sorted[sorted.count / 2],
            "p95CallbackIntervalMS": sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))],
            "callbacksOver33MS": Double(samples.filter { $0 > 33.4 }.count)]
    }
}
