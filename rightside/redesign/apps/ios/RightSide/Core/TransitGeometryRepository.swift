import Foundation
import CryptoKit

struct TransitGeometryRepository: Sendable {
    struct Manifest: Codable, Sendable { let version: Int; let sources: [TransitGeometrySource] }
    let corridors: [TransitCorridor]
    let sources: [TransitGeometrySource]
    var digest: String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let metadata = (try? encoder.encode(sources)) ?? Data()
        let policy = Data("transit-corridor-resolver-v\(TransitJourneyGeometry.currentVersion)|".utf8)
        return SHA256.hash(data: policy + metadata).map { String(format: "%02x", $0) }.joined()
    }
    static func loadBundled() async -> Self? {
        await Task.detached(priority: .utility) {
            guard let directory = Bundle.main.resourceURL?.appendingPathComponent("TransitGeometry") else { return nil }
            return try? load(directory: directory)
        }.value
    }
    static func load(directory: URL) throws -> Self {
        let manifestURL = directory.appendingPathComponent("manifest.json")
        let manifest = try JSONDecoder().decode(Manifest.self, from: boundedRead(manifestURL, bytes: 100_000))
        guard manifest.version == 1, (1...8).contains(manifest.sources.count),
              Set(manifest.sources.map(\.file)).count == manifest.sources.count else { throw TransitGeometryError.invalidPack }
        var corridors: [TransitCorridor] = []
        for source in manifest.sources {
            guard source.file == URL(fileURLWithPath: source.file).lastPathComponent,
                  source.file.hasSuffix(".json"), source.sha256.count == 64 else { throw TransitGeometryError.invalidPack }
            let data = try boundedRead(directory.appendingPathComponent(source.file), bytes: 8_000_000)
            let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            guard hash == source.sha256 else { throw TransitGeometryError.hashMismatch }
            corridors += try OSMTransitGeometry.parse(data: data, source: source)
        }
        guard corridors.count <= 40, Set(corridors.map(\.relationID)).count == corridors.count else { throw TransitGeometryError.invalidPack }
        return Self(corridors: corridors, sources: manifest.sources)
    }
    private static func boundedRead(_ url: URL, bytes: Int) throws -> Data {
        guard let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= bytes else { throw TransitGeometryError.invalidPack }
        let data = try Data(contentsOf: url)
        guard data.count <= bytes else { throw TransitGeometryError.invalidPack }
        return data
    }
}
enum TransitGeometryError: Error { case invalidPack, hashMismatch }

/// OSM relation order and shared node identity define continuity. No geometry
/// proximity join, missing-node compaction or fabricated connector is allowed.
enum OSMTransitGeometry {
    struct Root: Decodable { let elements: [Element] }
    struct Element: Decodable {
        let type: String
        let id: Int64
        let lat: Double?
        let lon: Double?
        let version: Int?
        let timestamp: String?
        let tags: [String: String]?
        let nodes: [Int64]?
        let members: [Member]?
    }
    struct Member: Decodable { let type: String; let ref: Int64; let role: String }
    static func parse(data: Data, source: TransitGeometrySource) throws -> [TransitCorridor] {
        guard data.count <= 8_000_000 else { throw TransitGeometryError.invalidPack }
        let root = try JSONDecoder().decode(Root.self, from: data)
        guard root.elements.count <= 100_000 else { throw TransitGeometryError.invalidPack }
        var nodes: [Int64: Element] = [:], ways: [Int64: Element] = [:], relations: [Int64: Element] = [:]
        for item in root.elements {
            switch item.type {
            case "node": guard nodes[item.id] == nil else { throw TransitGeometryError.invalidPack }; nodes[item.id] = item
            case "way": guard ways[item.id] == nil else { throw TransitGeometryError.invalidPack }; ways[item.id] = item
            case "relation": guard relations[item.id] == nil else { throw TransitGeometryError.invalidPack }; relations[item.id] = item
            default: throw TransitGeometryError.invalidPack
            }
        }
        guard relations.count <= 20 else { throw TransitGeometryError.invalidPack }
        return relations.values.sorted { $0.id < $1.id }.compactMap { relation in
            let tags = relation.tags ?? [:]
            guard tags["type"] == "route", tags["public_transport:version"] == "2",
                  ["tram", "bus", "trolleybus"].contains(tags["route"] ?? ""),
                  let members = relation.members, members.count <= 2_000 else { return nil }
            let stops = members.filter { $0.role.hasPrefix("stop") }.map { member -> TransitCorridorStop in
                let node = member.type == "node" ? nodes[member.ref] : nil
                let point: [Double]? = node.flatMap { n in
                    guard let lon = n.lon, let lat = n.lat, TransitGeometryMath.valid([lon, lat]) else { return nil }
                    return [lon, lat]
                }
                return TransitCorridorStop(nodeID: member.ref, name: node?.tags?["name"] ?? "", uicName: node?.tags?["uic_name"], uicRef: node?.tags?["uic_ref"], coordinate: point)
            }
            let routeMembers = members.filter { $0.type == "way" && !$0.role.hasPrefix("platform") }
            let pieces: [[Int64]?] = routeMembers.map { member in
                guard ["", "forward", "backward"].contains(member.role), let ids = ways[member.ref]?.nodes,
                      (2...20_000).contains(ids.count), ids.first != ids.last,
                      ids.allSatisfy({ id in
                          guard let node = nodes[id], let lon = node.lon, let lat = node.lat else { return false }
                          return TransitGeometryMath.valid([lon, lat])
                      }) else { return nil }
                return member.role == "backward" ? Array(ids.reversed()) : ids
            }
            var result: [TransitCorridorPath] = [], current: [Int64] = [], breaks = 0
            func finish() {
                if current.count > 1 {
                    // Every node was validated above. Do not use compactMap.
                    result.append(TransitCorridorPath(nodes: current, coordinates: current.map { [nodes[$0]!.lon!, nodes[$0]!.lat!] }))
                }
                current = []
            }
            for index in pieces.indices {
                guard var ids = pieces[index] else { finish(); breaks += 1; continue }
                let explicit = routeMembers[index].role != ""
                if let tail = current.last {
                    if ids.first == tail { /* already continuous */ }
                    else if !explicit && ids.last == tail { ids.reverse() }
                    else { finish(); breaks += 1 }
                }
                if current.isEmpty && !explicit {
                    // A lone way can be oriented by two unique ordered source
                    // stop nodes. Otherwise require a unique shared endpoint
                    // with the immediately following member; never nearest-way.
                    let positions = stops.compactMap { stop -> Int? in
                        let found = ids.indices.filter { ids[$0] == stop.nodeID }
                        return found.count == 1 ? found[0] : nil
                    }
                    if positions.count >= 2 && positions[0] != positions[1] {
                        if positions[0] > positions[1] { ids.reverse() }
                    } else if index + 1 < pieces.count, let next = pieces[index + 1] {
                        let common = Set([ids.first!, ids.last!]).intersection([next.first!, next.last!])
                        guard common.count == 1, let endpoint = common.first else { breaks += 1; continue }
                        if ids.first == endpoint { ids.reverse() }
                    } else { breaks += 1; continue }
                }
                if current.isEmpty { current = ids } else { current += ids.dropFirst() }
                if current.count > 20_000 { finish(); breaks += 1 }
            }
            finish()
            return TransitCorridor(relationID: relation.id, version: relation.version ?? 0,
                modifiedAt: relation.timestamp ?? "unknown", tags: tags, stops: stops,
                paths: result.filter(\.valid), brokenWays: breaks, source: source)
        }
    }
}
