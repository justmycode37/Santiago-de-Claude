import Foundation
import Combine
import CoreLocation
import SwiftUI
import UIKit

@MainActor
final class LocationController: NSObject, ObservableObject, @preconcurrency CLLocationManagerDelegate {
    @Published private(set) var authorizationStatus: CLAuthorizationStatus
    @Published private(set) var accuracyAuthorization: CLAccuracyAuthorization
    @Published private(set) var status = "Choose your starting point or use your location."
    @Published private(set) var isRequesting = false
    @Published private(set) var isTracking = false
    @Published private(set) var latestLocation: CLLocation?
    @Published private(set) var heading: CLHeading?
    @Published private(set) var positionJSON: [String: Any]?
    @Published private(set) var positionJSONData: Data?
    private let manager: CLLocationManager
    private var wantsFix = false
    private var continuous = false
    private var updatesStarted = false
    private var requestGeneration = UUID()
    private var timeoutTask: Task<Void, Never>?
    private var backgroundObserver: AnyCancellable?

    override init() {
        manager = CLLocationManager()
        authorizationStatus = manager.authorizationStatus
        accuracyAuthorization = manager.accuracyAuthorization
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = 2
        manager.headingFilter = 3
        manager.activityType = .otherNavigation
        manager.pausesLocationUpdatesAutomatically = false
        backgroundObserver = NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification).sink { [weak self] _ in
            Task { @MainActor [weak self] in self?.stop() }
        }
    }
    deinit { timeoutTask?.cancel() }

    func requestLocation() { begin(continuous: false) }
    func startTracking() {
        guard !isTracking else { return }
        begin(continuous: true)
    }
    private func begin(continuous: Bool) {
        guard UIApplication.shared.applicationState == .active else { return }
        stop()
        refreshAuthorization()
        self.continuous = continuous; wantsFix = true; isRequesting = true
        status = "Finding your location…"
        let generation = requestGeneration
        // The deadline includes the permission prompt, not only GPS acquisition.
        timeoutTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(12)) } catch { return }
            guard let self, self.requestGeneration == generation, self.isRequesting else { return }
            self.stop()
            self.status = "No reliable location yet. Choose a starting point manually or try again outdoors."
        }
        switch authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse: startUpdates()
        case .denied, .restricted: stop(); refreshAuthorization()
        @unknown default: stop(); status = "Location authorization unavailable."
        }
    }
    private func startUpdates() {
        guard wantsFix, !updatesStarted else { return }
        updatesStarted = true
        manager.desiredAccuracy = continuous ? kCLLocationAccuracyBestForNavigation : kCLLocationAccuracyNearestTenMeters
        isTracking = continuous
        if continuous {
            manager.startUpdatingLocation()
            if CLLocationManager.headingAvailable() { manager.startUpdatingHeading() }
        } else { manager.requestLocation() }
    }

    func requestPreciseLocation() {
        guard accuracyAuthorization == .reducedAccuracy else { return }
        manager.requestTemporaryFullAccuracyAuthorization(withPurposeKey: "JourneyNavigation") { [weak self] _ in
            Task { @MainActor in self?.refreshAuthorization() }
        }
    }
    func refreshAuthorization() {
        authorizationStatus = manager.authorizationStatus
        accuracyAuthorization = manager.accuracyAuthorization
        if authorizationStatus == .denied { status = "Location denied. Choose a place or enable access in Settings." }
        if authorizationStatus == .restricted { status = "Location is restricted by device settings." }
    }
    func stop() {
        requestGeneration = UUID(); updatesStarted = false
        wantsFix = false; continuous = false; isTracking = false; isRequesting = false
        status = "Choose your starting point or try your location again."
        timeoutTask?.cancel(); timeoutTask = nil
        manager.stopUpdatingLocation(); manager.stopUpdatingHeading(); heading = nil
    }
    func fixAge(at now: Date = Date()) -> TimeInterval? { latestLocation.map { now.timeIntervalSince($0.timestamp) } }
    func isStale(at now: Date = Date()) -> Bool { SensorFixFreshness.isStale(timestamp: latestLocation?.timestamp, now: now) }
    func usableHeading(at now: Date = Date()) -> Double? {
        guard let heading, heading.trueHeading.isFinite, heading.trueHeading >= 0, heading.trueHeading < 360, heading.headingAccuracy >= 0, heading.headingAccuracy <= 25,
              !SensorFixFreshness.isStale(timestamp: heading.timestamp, now: now) else { return nil }
        return heading.trueHeading
    }
    func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
    }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        refreshAuthorization()
        switch authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse: if wantsFix { startUpdates() }
        case .denied, .restricted: stop(); refreshAuthorization()
        default: break
        }
    }
    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        heading = newHeading
        if let orientation = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState == .foregroundActive })?.interfaceOrientation {
            let value: CLDeviceOrientation
            switch orientation {
            case .landscapeLeft: value = .landscapeLeft
            case .landscapeRight: value = .landscapeRight
            case .portraitUpsideDown: value = .portraitUpsideDown
            default: value = .portrait
            }
            if manager.headingOrientation != value { manager.headingOrientation = value; heading = nil }
        }
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard wantsFix else { return }
        let receivedAt = Date()
        guard let fix = locations.filter({
            CLLocationCoordinate2DIsValid($0.coordinate) && $0.horizontalAccuracy.isFinite && $0.horizontalAccuracy >= 0 && $0.horizontalAccuracy <= 20_000_000 &&
            !SensorFixFreshness.isStale(timestamp: $0.timestamp, now: receivedAt)
        }).max(by: { $0.timestamp < $1.timestamp }),
        latestLocation == nil || fix.timestamp >= latestLocation!.timestamp,
        let payload = SensorPositionPayload(longitude: fix.coordinate.longitude, latitude: fix.coordinate.latitude,
            accuracy: fix.horizontalAccuracy, timestamp: fix.timestamp, receivedAt: receivedAt, floor: fix.floor?.level),
        let data = try? JSONEncoder().encode(payload),
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        // A very broad fix cannot choose a useful journey origin. Keep the bounded request alive.
        guard continuous || fix.horizontalAccuracy <= 250 else {
            status = "Location is too approximate (±\(Int(fix.horizontalAccuracy)) m). Choose a place or try outdoors."
            return
        }
        latestLocation = fix; positionJSONData = data; positionJSON = json
        timeoutTask?.cancel(); isRequesting = false
        if !continuous { stop() }
        status = accuracyAuthorization == .reducedAccuracy ? "Approximate location. Enable precise location for better guidance." : "Location updated · accuracy ±\(Int(fix.horizontalAccuracy.rounded())) m"
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard wantsFix else { return }
        if (error as? CLError)?.code == .locationUnknown {
            status = "Location temporarily unavailable. Waiting for a fresh fix…"; return
        }
        stop(); refreshAuthorization()
        status = "Location unavailable. Check Settings or choose a place manually."
    }
}

@MainActor
struct LocationStatusView: View {
    @ObservedObject var controller: LocationController
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(controller.status).font(.body)
            if controller.accuracyAuthorization == .reducedAccuracy {
                Text("Approximate permission is enabled. You can always choose your starting point manually.").font(.subheadline).foregroundStyle(.secondary)
            }
            if let fix = controller.latestLocation {
                Text(controller.isStale() ? "Your last location is out of date." : "Reported accuracy: ±\(Int(fix.horizontalAccuracy)) m")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            Button(controller.isRequesting ? "Requesting location…" : "Get location once") { controller.requestLocation() }
                .disabled(controller.isRequesting)
            if controller.isRequesting || controller.isTracking { Button("Stop location") { controller.stop() } }
            if controller.accuracyAuthorization == .reducedAccuracy { Button("Use precise location") { controller.requestPreciseLocation() } }
            if controller.authorizationStatus == .denied || controller.authorizationStatus == .restricted {
                Button("Open Settings") { controller.openSettings() }
            }
            Text("No background tracking. Reported accuracy is not a guarantee of the correct pavement or boarding area.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { controller.refreshAuthorization() }
            else if phase == .background { controller.stop() }
        }
        
    }
}

@MainActor
struct LocationRequestFeedback: View {
    @ObservedObject var controller: LocationController
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(controller.status).font(.caption).foregroundStyle(.secondary)
            if controller.isRequesting {
                ProgressView("Requesting location…")
                Button("Cancel location request") { controller.stop() }
            }
            if controller.authorizationStatus == .denied || controller.authorizationStatus == .restricted {
                Button("Location settings") { controller.openSettings() }
            }
        }
    }
}
