import Foundation

/// One platform or stop edge (ATLAS traffic point) from the web app's platforms.js, via stop-edges.json.
struct StopEdge: Equatable {
    let uic: String
    /// Letter or number on the sign ("A", "7"); empty when ATLAS has none.
    let ref: String
    let point: GeoPoint
    /// Compass direction the vehicles stopping here travel in, degrees; nil when unknown.
    let bearing: Double?
    /// OpenStreetMap floor level when not at street level.
    let level: Double?
}

/// Every bus, tram and train stop edge in Switzerland (`Resources/TransportPacks/stop-edges.json`,
/// built by `rightside/tools/build-edge-packs.py` from platforms.js).
struct StopEdgePack {
    let date: String?
    private let raw: [String: Any]

    init(data: Data) throws {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any], root["version"] as? Int == 1,
              let stops = root["stops"] as? [String: Any] else { throw CocoaError(.fileReadCorruptFile) }
        date = root["date"] as? String
        raw = stops
    }

    /// Parsed on demand: the pack has ~50,000 edges, a journey needs one stop's.
    func edges(uic: String) -> [StopEdge] {
        guard let stop = raw[uic] as? [Any], stop.count == 2, let rows = stop[1] as? [[Any]] else { return [] }
        return rows.compactMap { row in
            guard row.count >= 2, let x = (row[0] as? NSNumber)?.doubleValue, let y = (row[1] as? NSNumber)?.doubleValue else { return nil }
            let ref = row.count > 2 ? (row[2] as? String ?? "") : ""
            let bearing = row.count > 3 ? (row[3] as? NSNumber)?.doubleValue : nil
            let level = row.count > 4 ? (row[4] as? NSNumber)?.doubleValue : nil
            return StopEdge(uic: uic, ref: ref, point: GeoPoint(latitude: y / 1e5, longitude: x / 1e5), bearing: bearing, level: level)
        }
    }

    /// "Kante B", "Gleis 7", "B" → "b"; "7A" stays "7a". Used to compare refs from different sources.
    static func normalizedRef(_ value: String?) -> String? {
        guard let value else { return nil }
        let words = DisplayText.words(value).filter { !["kante", "gleis", "quai", "voie", "binario", "steig", "platform", "bay", "edge", "gl"].contains($0) }
        let joined = words.joined()
        return joined.isEmpty ? nil : joined
    }

    /// The boarding edge of `uic`: by its ref when one is known (Kante `/api/due` quayLabel, or the journey's
    /// planned platform); else, by the direction the vehicle leaves in (`/api/due` departBearing), the one edge
    /// whose travel direction agrees within 45°. Nil when that is not unique, never a guess.
    func boardingEdge(uic: String, ref: String?, departBearing: Double? = nil) -> StopEdge? {
        let edges = edges(uic: uic)
        if let wanted = Self.normalizedRef(ref) {
            let byRef = edges.filter { Self.normalizedRef($0.ref) == wanted }
            if byRef.count == 1 { return byRef[0] }
            if byRef.count > 1 { return nil }
        }
        if let departBearing {
            let agreeing = edges.filter { $0.bearing.map { Self.angle($0, departBearing) <= 45 } ?? false }
            if agreeing.count == 1 { return agreeing[0] }
        }
        return nil
    }

    static func angle(_ a: Double, _ b: Double) -> Double { abs(((a - b) + 540).truncatingRemainder(dividingBy: 360) - 180) }
}

/// Which side of the street the rider is on, relative to the boarding edge.
/// Switzerland drives on the right and boards on the right: the waiting area is to the right of the direction
/// the vehicles travel at the edge. The edge point lies on the kerb or platform edge.
struct KerbAssessment: Equatable {
    enum Side: String { case boarding, opposite, unknown }
    let side: Side
    /// Metres to the right (+) or left (−) of the vehicles' line of travel through the edge.
    let lateral: Double
    /// Metres along the direction of travel from the edge (+ ahead of it).
    let along: Double
    /// Another edge of the same stop that is clearly nearer and serves the other direction, if any.
    let nearerOppositeEdge: StopEdge?

    func message(edgeName: String) -> String? {
        switch side {
        case .boarding:
            return nearerOppositeEdge == nil ? "You are on the boarding side for \(edgeName)." : nil
        case .opposite:
            if let other = nearerOppositeEdge, !other.ref.isEmpty {
                return "You seem to be at \(other.ref), the other direction. \(edgeName) is across the street."
            }
            return "\(edgeName) seems to be across the street. Cross safely before your vehicle arrives."
        case .unknown:
            return nil
        }
    }
}

enum KerbSide {
    /// The road's middle is assumed 3 m to the left of the edge point (half a lane plus kerb).
    static let roadMiddle = -3.0
    /// The answer must hold with this many standard deviations of the fix's reported accuracy.
    static let sigmas = 1.0

    static func assess(user: GeoPoint, accuracy: Double, edge: StopEdge, siblings: [StopEdge]) -> KerbAssessment {
        guard let bearing = edge.bearing, accuracy.isFinite, accuracy > 0 else {
            return KerbAssessment(side: .unknown, lateral: 0, along: 0, nearerOppositeEdge: nil)
        }
        let v = LocalTangentPlane(origin: edge.point).enu(user)
        let b = bearing * .pi / 180
        let travel = Vec2(x: sin(b), y: cos(b)), right = Vec2(x: cos(b), y: -sin(b))
        let lateral = v.x * right.x + v.y * right.y
        let along = v.x * travel.x + v.y * travel.y
        // A sibling edge serving the opposite direction that is much nearer than the boarding edge.
        let distance = v.length
        let nearer = siblings.filter { other in
            other != edge && (other.bearing.map { StopEdgePack.angle($0, bearing) >= 120 } ?? false)
        }.map { ($0, LocalTangentPlane(origin: $0.point).enu(user).length) }
         .filter { distance - $0.1 > 2 * accuracy }
         .min { $0.1 < $1.1 }?.0
        let side: KerbAssessment.Side
        if abs(along) > 80 { side = .unknown }
        else if lateral < roadMiddle - sigmas * accuracy || nearer != nil { side = .opposite }
        else if lateral > roadMiddle + sigmas * accuracy { side = .boarding }
        else { side = .unknown }
        return KerbAssessment(side: side, lateral: lateral, along: along, nearerOppositeEdge: nearer)
    }
}

/// Floor heights of modelled multi-level stations (`station-levels.json`, from the web app's stations3d/).
struct StationLevelPack: Decodable {
    struct Station: Decodable {
        let key: String
        let name: String
        let origin: [Double]
        /// [level id, z metres relative to level 0, name]
        let levels: [[LevelField]]
        /// [uic, ref, level, x, y]
        let stops: [[LevelField]]
    }
    enum LevelField: Decodable {
        case number(Double), text(String)
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let d = try? c.decode(Double.self) { self = .number(d) } else { self = .text(try c.decode(String.self)) }
        }
        var number: Double? { if case let .number(d) = self { return d }; return nil }
        var text: String? { if case let .text(s) = self { return s }; if case let .number(d) = self { return String(Int(d)) }; return nil }
    }
    struct Floor: Equatable { let level: Double; let z: Double; let name: String }
    let version: Int
    let stations: [Station]

    func station(uic: String) -> Station? { stations.first { $0.stops.contains { $0.first?.text == uic } } }

    /// Height of `level` in metres relative to level 0, interpolated between the model's levels
    /// (stairs and sloping streets have fractional levels).
    static func z(_ level: Double, in station: Station) -> Double? {
        let table = station.levels.compactMap { row -> (Double, Double)? in
            guard row.count >= 2, let id = row[0].number, let z = row[1].number else { return nil }
            return (id, z)
        }.sorted { $0.0 < $1.0 }
        guard let first = table.first, let last = table.last else { return nil }
        if level <= first.0 { return first.1 + (level - first.0) * 3.5 }
        if level >= last.0 { return last.1 + (level - last.0) * 3.5 }
        for (a, b) in zip(table, table.dropFirst()) where level >= a.0 && level <= b.0 {
            return a.1 + (b.1 - a.1) * (level - a.0) / max(b.0 - a.0, 1e-9)
        }
        return nil
    }

    /// The floor of a boarding edge, when this station is modelled.
    func floor(uic: String, ref: String?) -> Floor? {
        guard let station = station(uic: uic), let wanted = StopEdgePack.normalizedRef(ref) else { return nil }
        let rows = station.stops.filter { $0.count >= 3 && $0[0].text == uic && StopEdgePack.normalizedRef($0[1].text) == wanted }
        guard rows.count == 1, let level = rows[0][2].number, let z = Self.z(level, in: station) else { return nil }
        let name = station.levels.first { $0.first?.number == level }.flatMap { $0.count > 2 ? $0[2].text : nil } ?? "Level \(Int(level))"
        return Floor(level: level, z: z, name: name)
    }
}

/// Where to draw things vertically in the AR world (metres, ARKit y up).
enum ARFloorHeights {
    /// Typical height of a hand-held phone above the floor, used only until ARKit has found the floor.
    static let fallbackPhoneHeight = 1.4

    /// The floor under the rider now: a detected horizontal plane 0.8–2.2 m below the camera, else the fallback.
    static func floorY(cameraY: Double, detectedPlaneYs: [Double]) -> (y: Double, detected: Bool) {
        let below = detectedPlaneYs.filter { cameraY - $0 >= 0.8 && cameraY - $0 <= 2.2 }
        if let nearest = below.max() { return (nearest, true) }
        return (cameraY - fallbackPhoneHeight, false)
    }

    /// AR height of the boarding target. The rider is assumed to start the camera at street level (level 0 of
    /// the station model, where walks to a station begin); ARKit tracks how far they have since gone up or down.
    /// `startFloorY` is the floor height when the session started at street level.
    static func targetY(startFloorY: Double, targetZ: Double?) -> Double {
        startFloorY + (targetZ ?? 0)
    }
}
