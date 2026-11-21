import Foundation

/// Plain 2-D vector in metres. Kept free of simd/CoreLocation so the alignment maths is portable and testable.
struct Vec2: Equatable {
    var x: Double
    var y: Double
    static let zero = Vec2(x: 0, y: 0)
    static func + (a: Vec2, b: Vec2) -> Vec2 { Vec2(x: a.x + b.x, y: a.y + b.y) }
    static func - (a: Vec2, b: Vec2) -> Vec2 { Vec2(x: a.x - b.x, y: a.y - b.y) }
    static func * (a: Vec2, s: Double) -> Vec2 { Vec2(x: a.x * s, y: a.y * s) }
    var length: Double { (x * x + y * y).squareRoot() }
    func rotated(by angle: Double) -> Vec2 {
        let c = cos(angle), s = sin(angle)
        return Vec2(x: c * x - s * y, y: s * x + c * y)
    }
    var angle: Double { atan2(y, x) }
}

struct GeoPoint: Equatable {
    let latitude: Double
    let longitude: Double
}

/// Local east/north tangent plane around an origin. Accurate to centimetres within a few kilometres.
struct LocalTangentPlane {
    let origin: GeoPoint
    private static let earthRadius = 6_378_137.0
    func enu(_ point: GeoPoint) -> Vec2 {
        let lat0 = origin.latitude * .pi / 180
        let dLat = (point.latitude - origin.latitude) * .pi / 180
        let dLon = (point.longitude - origin.longitude) * .pi / 180
        return Vec2(x: dLon * cos(lat0) * Self.earthRadius, y: dLat * Self.earthRadius)
    }
    func geo(_ point: Vec2) -> GeoPoint {
        let lat0 = origin.latitude * .pi / 180
        return GeoPoint(latitude: origin.latitude + point.y / Self.earthRadius * 180 / .pi,
                        longitude: origin.longitude + point.x / (Self.earthRadius * cos(lat0)) * 180 / .pi)
    }
}

/// Aligns ARKit's gravity-aligned world (visual-inertial odometry, metres, arbitrary yaw and origin)
/// with the geographic east/north plane, from three independent sources:
///   - compass headings paired with the camera's AR heading (absolute yaw, but biased near steel/cars),
///   - GPS fixes paired with the camera's AR position (absolute position, metres of noise),
///   - the shape of the walked path: once the user has moved, GPS displacement against AR displacement
///     gives yaw without the compass.
/// The AR horizontal plane is (x, -z) of ARKit world space, so that "north-up" maps naturally.
/// Every solution carries an honest one-sigma yaw and position uncertainty; callers decide what to draw.
struct GeoARAlignment {
    struct HeadingSample {
        let at: Date
        /// Camera viewing direction in the AR horizontal plane, radians from +x towards +y (counter-clockwise).
        let arDirection: Double
        /// True heading in degrees clockwise from north, of the same viewing direction.
        let trueHeading: Double
        /// Core Location's reported heading accuracy in degrees (one sigma, roughly).
        let accuracy: Double
    }
    struct PositionSample {
        let at: Date
        let ar: Vec2
        let enu: Vec2
        /// Reported horizontal accuracy in metres.
        let accuracy: Double
    }
    enum Source: String { case compass, path, combined }
    struct Solution: Equatable {
        /// AR = R(yaw) · ENU + translation.
        let yaw: Double
        let translation: Vec2
        let yawSigma: Double
        let positionSigma: Double
        let source: String
        let positionSamples: Int
        let pathSpan: Double
        func ar(_ enu: Vec2) -> Vec2 { enu.rotated(by: yaw) + translation }
        func enu(_ ar: Vec2) -> Vec2 { (ar - translation).rotated(by: -yaw) }
        var yawSigmaDegrees: Double { yawSigma * 180 / .pi }
        /// One-sigma horizontal error of a point `distance` metres from the user.
        func pointSigma(atDistance distance: Double) -> Double {
            (positionSigma * positionSigma + (distance * yawSigma) * (distance * yawSigma)).squareRoot()
        }
    }

    static let maximumFixAccuracy = 35.0
    static let positionWindow: TimeInterval = 120
    static let headingWindow: TimeInterval = 20
    static let minimumPathSpan = 8.0

    private(set) var headings: [HeadingSample] = []
    private(set) var positions: [PositionSample] = []

    mutating func reset() { headings = []; positions = [] }

    mutating func add(_ sample: HeadingSample) {
        guard sample.trueHeading.isFinite, sample.arDirection.isFinite, sample.accuracy.isFinite,
              sample.accuracy >= 0, sample.accuracy <= 45 else { return }
        if let last = headings.last, sample.at <= last.at { return }
        headings.append(sample)
        headings.removeAll { sample.at.timeIntervalSince($0.at) > Self.headingWindow }
    }

    mutating func add(_ sample: PositionSample) {
        guard sample.accuracy.isFinite, sample.accuracy > 0, sample.accuracy <= Self.maximumFixAccuracy,
              sample.ar.x.isFinite, sample.ar.y.isFinite, sample.enu.x.isFinite, sample.enu.y.isFinite else { return }
        if let last = positions.last {
            guard sample.at > last.at else { return }
            // A fix that did not move (or a repeated delivery) carries no new geometry; refresh the newest instead.
            if (sample.enu - last.enu).length < 0.01 && (sample.ar - last.ar).length < 0.05 { positions[positions.count - 1] = sample; return }
        }
        positions.append(sample)
        positions.removeAll { sample.at.timeIntervalSince($0.at) > Self.positionWindow }
        if positions.count > 240 { positions.removeFirst(positions.count - 240) }
    }

    /// Yaw from compass samples: circular mean, weighted by reported accuracy. Compass errors are
    /// correlated (local magnetic disturbance), so averaging does not shrink sigma below the median accuracy.
    func compassYaw(at now: Date? = nil) -> (yaw: Double, sigma: Double)? {
        // Samples older than the window are dropped even when no new heading arrives (compass lost).
        let headings = now.map { now in self.headings.filter { now.timeIntervalSince($0.at) <= Self.headingWindow && $0.at <= now } } ?? self.headings
        guard !headings.isEmpty else { return nil }
        var sx = 0.0, sy = 0.0
        for h in headings {
            // ENU direction of the heading: east = sin(h), north = cos(h); its angle from +x is 90° − h.
            let enuAngle = (90 - h.trueHeading) * .pi / 180
            let yaw = h.arDirection - enuAngle
            let w = 1 / max(25, h.accuracy * h.accuracy)
            sx += w * cos(yaw); sy += w * sin(yaw)
        }
        let concentration = (sx * sx + sy * sy).squareRoot() / headings.reduce(0) { $0 + 1 / max(25, $1.accuracy * $1.accuracy) }
        let accuracies = headings.map(\.accuracy).sorted()
        let median = accuracies[accuracies.count / 2]
        // Scatter between samples (low concentration) also widens sigma.
        let scatter = concentration < 1 ? (-2 * log(max(concentration, 1e-9))).squareRoot() : 0
        let sigma = max(max(median, 8) * .pi / 180, scatter)
        return (atan2(sy, sx), sigma)
    }

    /// Yaw and translation from the walked path (weighted 2-D Procrustes without scale).
    func pathFit() -> (yaw: Double, translation: Vec2, sigma: Double, span: Double, rms: Double)? {
        guard positions.count >= 3 else { return nil }
        let weights = positions.map { 1 / ($0.accuracy * $0.accuracy) }
        let total = weights.reduce(0, +)
        var ce = Vec2.zero, ca = Vec2.zero
        for (p, w) in zip(positions, weights) { ce = ce + p.enu * (w / total); ca = ca + p.ar * (w / total) }
        var dot = 0.0, cross = 0.0, span = 0.0, enuSpan = 0.0
        for (p, w) in zip(positions, weights) {
            let e = p.enu - ce, a = p.ar - ca
            dot += w * (e.x * a.x + e.y * a.y)
            cross += w * (e.x * a.y - e.y * a.x)
            span = max(span, a.length)
            enuSpan = max(enuSpan, e.length)
        }
        // The AR path (visual odometry) measures the true spread; GPS noise alone can look like movement. The fixes
        // must have moved too: in an underpass Core Location repeats one fix while the rider walks, and a path of
        // identical fixes has no direction (atan2(0, 0) would claim yaw 0).
        guard span * 2 >= Self.minimumPathSpan, enuSpan * 2 >= Self.minimumPathSpan / 2,
              (dot * dot + cross * cross).squareRoot() > 1e-9 else { return nil }
        let yaw = atan2(cross, dot)
        let translation = ca - ce.rotated(by: yaw)
        var squared = 0.0
        for (p, w) in zip(positions, weights) {
            let r = p.enu.rotated(by: yaw) + translation - p.ar
            squared += w * (r.x * r.x + r.y * r.y)
        }
        let rms = (squared / total).squareRoot()
        let accuracies = positions.map(\.accuracy).sorted()
        let median = accuracies[accuracies.count / 2]
        // GPS error is strongly time-correlated, so use the median accuracy (not /√n) over the path's extent.
        let sigma = min(.pi, max(median, rms) / (span * 2) * 1.5)
        return (yaw, translation, sigma, span * 2, rms)
    }

    func solution(at now: Date) -> Solution? {
        let compass = compassYaw(at: now)
        let path = pathFit()
        let yaw: Double, yawSigma: Double, source: Source
        switch (compass, path) {
        case let (c?, p?):
            let wc = 1 / (c.sigma * c.sigma), wp = 1 / (p.sigma * p.sigma)
            // Inverse-variance circular combination. A large disagreement means one source is wrong
            // (usually the compass near metal): keep the sigma honest instead of averaging it away.
            let difference = atan2(sin(c.yaw - p.yaw), cos(c.yaw - p.yaw))
            yaw = p.yaw + difference * wc / (wc + wp)
            let combined = (1 / (wc + wp)).squareRoot()
            let disagree = abs(difference) > 3 * (c.sigma * c.sigma + p.sigma * p.sigma).squareRoot()
            yawSigma = disagree ? max(combined, abs(difference) / 2) : combined
            source = .combined
        case let (c?, nil): yaw = c.yaw; yawSigma = c.sigma; source = .compass
        case let (nil, p?): yaw = p.yaw; yawSigma = p.sigma; source = .path
        default: return nil
        }
        // Translation from the most recent fixes, under the chosen yaw.
        let recent = positions.filter { now.timeIntervalSince($0.at) <= 30 && $0.at <= now }
        guard !recent.isEmpty else { return nil }
        var t = Vec2.zero, total = 0.0
        for p in recent {
            let w = 1 / (p.accuracy * p.accuracy)
            t = t + (p.ar - p.enu.rotated(by: yaw)) * w; total += w
        }
        t = t * (1 / total)
        let accuracies = recent.map(\.accuracy).sorted()
        let positionSigma = max(2, accuracies[accuracies.count / 2] * (recent.count >= 5 ? 0.8 : 1))
        return Solution(yaw: yaw, translation: t, yawSigma: yawSigma, positionSigma: positionSigma, source: source.rawValue,
                        positionSamples: positions.count, pathSpan: path?.span ?? 0)
    }
}

/// What the camera may draw for the walking route, given the alignment's uncertainty.
enum ARRouteGuidance {
    enum Mode: Equatable {
        /// Ground arrows along the route: lateral error small enough to tell which side of a street.
        case path
        /// One floating arrow towards the route ahead, with distance; the path itself is too uncertain.
        case direction
        /// Alignment unknown or too poor; use the map.
        case unavailable(String)
    }
    struct Marker: Equatable {
        /// AR horizontal position (x, −z).
        let ar: Vec2
        /// Direction of travel at the marker, radians in the AR horizontal plane.
        let direction: Double
        let distanceAlongRoute: Double
        /// One-sigma horizontal error of this marker.
        let sigma: Double
    }
    struct Plan: Equatable {
        let mode: Mode
        let markers: [Marker]
        /// Boarding point / walk target in AR space, if it is close enough to place.
        let target: Marker?
        /// Straight-line distance to the target, metres.
        let targetDistance: Double?
        /// Bearing from the camera's viewing direction to the next route point, radians (positive = left).
        let turn: Double?
        let summary: String
    }

    static let pathLateralLimit = 3.5
    static let directionLateralLimit = 15.0
    static let spacing = 2.0
    static let lookAhead = 40.0

    /// `route` and `target` are ENU points (same plane as the alignment); `camera` is the camera's AR
    /// horizontal position and `cameraDirection` its viewing direction in the AR plane.
    static func plan(route: [Vec2], target: Vec2?, alignment: GeoARAlignment.Solution?, camera: Vec2, cameraDirection: Double) -> Plan {
        guard let alignment else {
            return Plan(mode: .unavailable("Waiting for location and compass"), markers: [], target: nil, targetDistance: nil, turn: nil,
                        summary: "Hold the phone up and walk a few steps; the route appears once location and compass agree.")
        }
        let user = alignment.enu(camera)
        let path = route.count >= 2 ? route : (target.map { [user, $0] } ?? [])
        guard path.count >= 2 else {
            return Plan(mode: .unavailable("No walking route"), markers: [], target: nil, targetDistance: nil, turn: nil, summary: "No walking route to show.")
        }
        // Closest point on the route to the user, then resample ahead at fixed spacing.
        var bestDistance = Double.infinity, bestSegment = 0, bestT = 0.0
        for i in 0..<(path.count - 1) {
            let a = path[i], b = path[i + 1], ab = b - a
            let length2 = ab.x * ab.x + ab.y * ab.y
            let t = length2 > 0 ? max(0, min(1, ((user - a).x * ab.x + (user - a).y * ab.y) / length2)) : 0
            let d = (a + ab * t - user).length
            if d < bestDistance { bestDistance = d; bestSegment = i; bestT = t }
        }
        var markers: [Marker] = []
        var travelled = 0.0, nextMark = spacing
        var cursor = path[bestSegment] + (path[bestSegment + 1] - path[bestSegment]) * bestT
        var segment = bestSegment
        while segment < path.count - 1 && travelled < lookAhead {
            let end = path[segment + 1], step = end - cursor, length = step.length
            if length < 1e-6 { segment += 1; continue }
            let direction = step.angle
            if travelled + length >= nextMark {
                let used = nextMark - travelled
                let point = cursor + step * (used / length)
                let distance = (point - user).length
                markers.append(Marker(ar: alignment.ar(point), direction: direction + alignment.yaw,
                                      distanceAlongRoute: nextMark, sigma: alignment.pointSigma(atDistance: distance)))
                travelled = nextMark; cursor = point; nextMark += spacing
                continue
            }
            travelled += length; cursor = end; segment += 1
        }
        let targetDistance = target.map { ($0 - user).length }
        let targetMarker = target.flatMap { point -> Marker? in
            let d = (point - user).length
            guard d <= 150 else { return nil }
            return Marker(ar: alignment.ar(point), direction: 0, distanceAlongRoute: d, sigma: alignment.pointSigma(atDistance: d))
        }
        // Steer towards the route ~8 m ahead (or the end of the route).
        let aim = markers.first { $0.distanceAlongRoute >= 8 } ?? markers.last
        let turn = aim.map { marker -> Double in
            let v = marker.ar - camera
            return atan2(sin(v.angle - cameraDirection), cos(v.angle - cameraDirection))
        }
        let lateral10 = alignment.pointSigma(atDistance: 10)
        let offRoute = bestDistance > max(25, 2 * alignment.positionSigma)
        let mode: Mode
        // Ground arrows only along a real walking route: a straight line to the target may cross a road or tracks.
        let hasRoute = route.count >= 2
        if offRoute { mode = .unavailable("You are away from the walking route") }
        else if lateral10 <= pathLateralLimit && hasRoute { mode = .path }
        else if lateral10 <= directionLateralLimit { mode = .direction }
        else { mode = .unavailable("Location or compass too uncertain") }
        let sigma = Int(lateral10.rounded())
        let summary: String
        switch mode {
        case .path: summary = "Route shown on the ground · about ±\(sigma) m at 10 m. Watch traffic, not the arrows."
        case .direction: summary = "Direction only · location uncertain by about ±\(sigma) m. Follow the arrow and the map."
        case .unavailable(let reason): summary = reason + ". Use the map."
        }
        var placeable = true
        if case .unavailable = mode { placeable = false }
        return Plan(mode: mode, markers: mode == .path ? markers : [], target: placeable ? targetMarker : nil,
                    targetDistance: targetDistance, turn: mode == .direction || mode == .path ? turn : nil, summary: summary)
    }
}
