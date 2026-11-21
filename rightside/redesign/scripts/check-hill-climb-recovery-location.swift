import Foundation
import Combine

// Host-only substitute for the UIKit/CoreLocation controller. Mirrors synchronous
// @Published delivery and begin/stop ordering; never accesses real sensors.
@MainActor final class LocationController: NSObject, ObservableObject {
    @Published private(set) var positionJSONData: Data?
    @Published private(set) var isRequesting = false
    @Published private(set) var isTracking = false
    private(set) var stopCount = 0
    func requestLocation() { stop(); isRequesting = true }
    func startTracking() { stop(); isRequesting = true; isTracking = true }
    func stop() { stopCount += 1; isTracking = false; isRequesting = false }
    func emit(_ data: Data) { positionJSONData = data; isRequesting = false }
}
