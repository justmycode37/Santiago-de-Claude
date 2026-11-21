import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// One bus or tram as the Kante engine (`/api/vehicles`) reports it: the stretch between two stops it is on now,
/// with departure/arrival times corrected by live delays when `live == "observed"`. Its position is estimated by
/// interpolating along that stretch; it is not the vehicle's own GPS.
struct KanteVehicle: Decodable, Equatable {
    struct Line: Decodable, Equatable { let name: String; let category: String?; let mode: String }
    let tripId: String
    let line: Line
    let headsign: String
    let from: [Double]   // [lon, lat]
    let to: [Double]     // [lon, lat]
    let dep: Double      // unix seconds, leaving `from`
    let arr: Double      // unix seconds, reaching `to`
    let nextStop: String?
    let live: String?

    var isRoadVehicle: Bool { ["bus", "tram", "trolleybus"].contains(line.mode) }
    /// Linear estimate along the stretch at `date`, clamped to its ends (waiting at a stop = at that stop).
    func position(at date: Date) -> GeoPoint? {
        guard from.count == 2, to.count == 2, [from[0], from[1], to[0], to[1]].allSatisfy(\.isFinite) else { return nil }
        let t = date.timeIntervalSince1970
        let f = arr > dep ? max(0, min(1, (t - dep) / (arr - dep))) : (t < dep ? 0 : 1)
        return GeoPoint(latitude: from[1] + (to[1] - from[1]) * f, longitude: from[0] + (to[0] - from[0]) * f)
    }
}
struct KanteVehiclesResponse: Decodable { let t: Double?; let vehicles: [KanteVehicle] }

/// Fetches live vehicles around a point from a Kante engine. Network only; no location is stored.
struct KanteVehicleFeed {
    var base = URL(string: "https://kante.omniroute.app")!
    /// About ±700 m around the point: vehicles that can reach the stop within a couple of minutes.
    func request(around point: GeoPoint, radius: Double = 700) -> URLRequest {
        let dLat = radius / 111_320, dLon = radius / (111_320 * cos(point.latitude * .pi / 180))
        var components = URLComponents(url: base.appendingPathComponent("api/vehicles"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "bbox", value: String(format: "%.5f,%.5f,%.5f,%.5f",
            point.longitude - dLon, point.latitude - dLat, point.longitude + dLon, point.latitude + dLat))]
        var request = URLRequest(url: components.url!, timeoutInterval: 8)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }
    static func decode(_ data: Data) throws -> [KanteVehicle] {
        guard data.count <= 3_000_000 else { throw URLError(.dataLengthExceedsMaximum) }
        return try JSONDecoder().decode(KanteVehiclesResponse.self, from: data).vehicles.filter(\.isRoadVehicle)
    }
}

/// Where the rider is and where the camera points, at one moment.
struct CameraPose {
    let user: GeoPoint
    /// Reported horizontal accuracy, metres.
    let userAccuracy: Double
    /// True heading of the camera's optical axis, degrees clockwise from north; nil when unknown.
    let heading: Double?
    /// One-sigma heading error, degrees.
    let headingAccuracy: Double
    /// Horizontal field of view of the upright image, radians.
    let horizontalFOV: Double
    let at: Date
}

/// Turns live vehicle positions plus GPS and compass into a per-service likelihood for one detected vehicle:
/// "a tram of line 9 to Wankdorf is about where the camera sees this tram". This is supporting evidence only;
/// it is added to the display-text score and can break a tie, but never identifies a vehicle by itself.
enum VehiclePositionEvidence {
    /// Interpolating timetable stretches with live delays is coarse: assume ~60 m along-track error.
    static let interpolationError = 60.0
    /// Vehicles further than this from the rider cannot be the one in front of the camera.
    static let maximumDistance = 400.0

    static func bearing(from a: GeoPoint, to b: GeoPoint) -> (degrees: Double, metres: Double) {
        let v = LocalTangentPlane(origin: a).enu(b)
        return ((atan2(v.x, v.y) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360), v.length)
    }

    /// True bearing of a detected vehicle's centre, from the camera heading and its place in the upright image.
    static func detectionBearing(_ box: CGRect, pose: CameraPose) -> Double? {
        guard let heading = pose.heading, pose.horizontalFOV > 0, pose.horizontalFOV < .pi else { return nil }
        let x = Double(box.midX) - 0.5
        let offset = atan(2 * x * tan(pose.horizontalFOV / 2)) * 180 / .pi
        return (heading + offset + 360).truncatingRemainder(dividingBy: 360)
    }

    /// Likelihood 0…1 per candidate identity (`DisplayCandidate.identity`). Empty when nothing can be said
    /// (no fix, no vehicles of any candidate nearby), so the caller falls back to display text alone.
    static func likelihoods(for box: CGRect, pose: CameraPose?, vehicles: [KanteVehicle],
                            candidates: [DisplayCandidate]) -> [String: Double] {
        guard let pose, pose.userAccuracy > 0, pose.userAccuracy <= 50, !vehicles.isEmpty else { return [:] }
        let seen = detectionBearing(box, pose: pose)
        var result: [String: Double] = [:]
        for candidate in candidates {
            var best = 0.0
            for vehicle in vehicles where DisplayText.lineKey(vehicle.line.name) == candidate.lineKey
                && DepartureDisplayMatcher.destinationSimilarity(vehicle.headsign, candidate.destination) >= 0.85 {
                guard let position = vehicle.position(at: pose.at) else { continue }
                let (direction, distance) = bearing(from: pose.user, to: position)
                let slack = pose.userAccuracy + interpolationError
                guard distance <= maximumDistance + slack else { continue }
                // Near: a vehicle of this service is within reach at all.
                let near = distance <= slack ? 1.0 : exp(-(distance - slack) / 150)
                // Direction: only informative when the estimate is far enough away for its bearing to mean something.
                var aligned = 1.0
                if let seen, distance > slack {
                    let geometric = atan(slack / distance) * 180 / .pi
                    let sigma = (pose.headingAccuracy * pose.headingAccuracy + geometric * geometric).squareRoot()
                    let difference = abs(((direction - seen) + 540).truncatingRemainder(dividingBy: 360) - 180)
                    aligned = exp(-difference * difference / (2 * sigma * sigma))
                }
                best = max(best, near * aligned)
            }
            if best > 0.01 { result[candidate.identity] = best }
        }
        return result
    }
}

/// One trip about to stop at the boarding stop, from the Kante engine's `/api/due` (see kante/docs/LIVE-API.md):
/// what its display shows (line, headsign, vias), which boarding point, whether it is approaching / at the
/// stop / departed, its live-corrected times, and the direction it arrives in.
struct KanteDue: Decodable, Equatable {
    struct Line: Decodable, Equatable { let name: String; let category: String?; let mode: String }
    struct LiveInfo: Decodable, Equatable { let state: String?; let inaccurate: Bool? }
    let tripId: String
    let line: Line
    let headsign: String
    let vias: [String]?
    let quayId: String?
    let quayLabel: String?
    let arr: Double?
    let dep: Double?
    let cancelled: Bool?
    /// Direction the vehicle drives in when it arrives (from the stop before), degrees.
    let approachBearing: Double?
    /// Direction it drives in when it leaves (to the next stop), degrees: the travel direction at the boarding edge.
    var departBearing: Double? = nil
    /// "approaching", "at-stop" or "departed".
    let state: String
    let etaS: Double?
    let liveInfo: LiveInfo?

    var candidate: DisplayCandidate { DisplayCandidate(line: line.name, destination: headsign, vias: vias ?? []) }
}
struct KanteDueResponse: Decodable { let t: Double?; let due: [KanteDue] }

extension KanteVehicleFeed {
    /// `/api/due` for a stop. The stop id is sent when known (no rider location leaves the phone); otherwise
    /// the rider's position with a 150 m radius.
    func dueRequest(station: String?, around point: GeoPoint?, after: Int = 900, before: Int = 120) -> URLRequest? {
        var components = URLComponents(url: base.appendingPathComponent("api/due"), resolvingAgainstBaseURL: false)!
        var items = [URLQueryItem(name: "after", value: String(after)), URLQueryItem(name: "before", value: String(before)),
                     URLQueryItem(name: "limit", value: "40")]
        if let station { items.append(URLQueryItem(name: "station", value: station)) }
        else if let point {
            items += [URLQueryItem(name: "lat", value: String(format: "%.5f", point.latitude)),
                      URLQueryItem(name: "lon", value: String(format: "%.5f", point.longitude)), URLQueryItem(name: "radius", value: "150")]
        } else { return nil }
        components.queryItems = items
        var request = URLRequest(url: components.url!, timeoutInterval: 8)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }
    static func decodeDue(_ data: Data) throws -> [KanteDue] {
        guard data.count <= 3_000_000 else { throw URLError(.dataLengthExceedsMaximum) }
        return try JSONDecoder().decode(KanteDueResponse.self, from: data).due.filter { $0.cancelled != true }
    }
    /// The engine says which optional parts it has; `due` may be missing on an older deployment.
    static func supportsDue(_ meta: Data) -> Bool {
        struct Meta: Decodable { let features: [String]? }
        return (try? JSONDecoder().decode(Meta.self, from: meta))?.features?.contains("due") == true
    }
}

extension VehiclePositionEvidence {
    /// Display candidates from `/api/due`, one per line + headsign, with vias.
    static func candidates(from due: [KanteDue]) -> [DisplayCandidate] {
        var result: [DisplayCandidate] = []
        for item in due where !item.line.name.isEmpty && !item.headsign.isEmpty {
            let c = item.candidate
            if !result.contains(where: { $0.identity == c.identity }) { result.append(c) }
        }
        return result
    }

    /// Likelihood 0…1 per candidate identity that the detected vehicle is that service, from `/api/due`:
    /// - timing: standing at the stop or due within a minute → 1; later arrivals fade (0.2 at 5 min); a vehicle
    ///   that left more than 20 s ago does not count. Timetable-only or stale times are flattened (less known).
    /// - direction: for a vehicle still approaching, the camera should see it on the side it comes from
    ///   (opposite its arrival bearing). Needs a camera heading and a fix within 30 m.
    static func dueLikelihoods(for box: CGRect, pose: CameraPose?, due: [KanteDue], candidates: [DisplayCandidate], now: Date) -> [String: Double] {
        let t = now.timeIntervalSince1970
        let seen = pose.flatMap { $0.userAccuracy <= 30 ? detectionBearing(box, pose: $0) : nil }
        var result: [String: Double] = [:]
        for candidate in candidates {
            var best = 0.0
            for item in due where DisplayText.lineKey(item.line.name) == candidate.lineKey
                && DepartureDisplayMatcher.destinationSimilarity(item.headsign, candidate.destination) >= 0.85 {
                guard let reference = item.arr ?? item.dep else { continue }
                if item.state == "departed", (item.dep ?? reference) < t - 20 { continue }
                let eta = reference - t
                var timing = eta <= 60 ? 1 : exp(-(eta - 60) / 150)
                if ["timetable", "stale"].contains(item.liveInfo?.state ?? "timetable") || item.liveInfo?.inaccurate == true {
                    timing = 0.5 + 0.5 * timing
                }
                var aligned = 1.0
                if let seen, let pose, let approach = item.approachBearing, item.state == "approaching", eta > 8 {
                    let from = (approach + 180).truncatingRemainder(dividingBy: 360)
                    let difference = abs(((from - seen) + 540).truncatingRemainder(dividingBy: 360) - 180)
                    // Roads bend before a stop and the rider is not exactly at it: generous 30° on top of the compass.
                    let sigma = (pose.headingAccuracy * pose.headingAccuracy + 900).squareRoot()
                    aligned = 0.4 + 0.6 * exp(-difference * difference / (2 * sigma * sigma))
                }
                best = max(best, timing * aligned)
            }
            if best > 0.01 { result[candidate.identity] = best }
        }
        return result
    }
}
