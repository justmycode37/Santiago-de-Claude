import Foundation

/// Only validated navigation is saved; a search preview never replaces guidance.
@MainActor public final class JourneyCache {
    let url: URL
    public init(url: URL? = nil) throws {
        if let url { self.url = url }
        else {
            let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let directory = root.appendingPathComponent("RightSide", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var excluded = directory
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            try excluded.setResourceValues(values)
            self.url = directory.appendingPathComponent("navigation-v1.json")
        }
    }
    public func save(navigation: JSONValue, replay: JSONValue?, bridge: DomainBridge) throws {
        let validated = try bridge.call("restore", .object(["json": .string(try navigation.encoded())]))
        let checkedReplay = try replay.map { try bridge.call("restoreReplay", .object(["replay": $0])) }
        if let checkedReplay, checkedReplay["navigation"] != validated { throw NativeCoreError.message("Replay and navigation differ.") }
        let envelope = JSONValue.object(["schemaVersion": .number(1), "navigation": validated, "replay": checkedReplay ?? .null])
        let data = try JSONEncoder().encode(envelope)
        guard data.count <= 8_000_000 else { throw NativeCoreError.message("Saved journey exceeds the local storage limit.") }
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    public func load(bridge: DomainBridge) throws -> (navigation: JSONValue, replay: JSONValue?)? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 8_000_000 else { throw NativeCoreError.message("Saved journey exceeds the local storage limit.") }
        let envelope = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        guard envelope["schemaVersion"].double == 1 else { throw NativeCoreError.message("Unsupported saved journey version.") }
        let navigation = try bridge.call("restore", .object(["json": .string(try envelope["navigation"].encoded())]))
        let replay = envelope["replay"] == .null ? nil : try bridge.call("restoreReplay", .object(["replay": envelope["replay"]]))
        if let replay, replay["navigation"] != navigation { throw NativeCoreError.message("Saved replay and navigation differ.") }
        return (navigation, replay)
    }
}
