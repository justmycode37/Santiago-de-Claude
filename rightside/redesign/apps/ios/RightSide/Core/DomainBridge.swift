import Foundation
import JavaScriptCore

/// JavaScriptCore is confined to the main actor; only JSON crosses the boundary.
@MainActor public final class DomainBridge {
    private let context: JSContext
    private let api: JSValue
    private var walkingGraph: JSONValue?

    public init(bundle: Bundle = .main) throws {
        let started = ProcessInfo.processInfo.systemUptime
        defer { NativePerformance.record("domainInitializationMs", since: started) }
        guard let url = bundle.url(forResource: "domain", withExtension: "js"),
              let context = JSContext() else { throw NativeCoreError.message("Bundled domain.js or JavaScriptCore is unavailable.") }
        let source = try String(contentsOf: url, encoding: .utf8)
        context.evaluateScript(source, withSourceURL: url)
        guard context.exception == nil,
              let api = context.objectForKeyedSubscript("RightSideBridge"), !api.isUndefined,
              let function = api.objectForKeyedSubscript("call"), !function.isUndefined else {
            throw NativeCoreError.message("Domain bundle failed to initialize: \(context.exception?.toString() ?? "missing entry point")")
        }
        self.context = context
        self.api = api
    }

    public func call(_ method: String, _ payload: JSONValue) throws -> JSONValue {
        let started = ProcessInfo.processInfo.systemUptime
        defer { NativePerformance.record("domainCallMaxMs", since: started, maximum: true) }
        context.exception = nil
        guard let text = api.invokeMethod("call", withArguments: [method, try payload.encoded()])?.toString(), context.exception == nil else {
            throw NativeCoreError.message("Domain call failed: \(context.exception?.toString() ?? method)")
        }
        let envelope = try JSONValue(json: text)
        guard envelope["ok"].bool == true else {
            throw NativeCoreError.message(envelope["error"]["message"].string ?? "Invalid domain response")
        }
        return envelope["value"]
    }

    public func fixture(bundle: Bundle = .main) throws -> JSONValue {
        guard let url = bundle.url(forResource: "bern-demo", withExtension: "json") else { throw NativeCoreError.message("Bundled simulated demo is missing.") }
        return try call("validateFixture", .object(["fixture": JSONValue(json: String(contentsOf: url, encoding: .utf8))]))
    }
    public func routeWalk(_ request: JSONValue, bundle: Bundle = .main) throws -> JSONValue {
        if walkingGraph == nil {
            guard let url = bundle.url(forResource: "bern-walking-graph", withExtension: "json") else { throw NativeCoreError.message("The bounded Bern walking graph is unavailable.") }
            walkingGraph = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
        }
        return try call("routeWalk", .object(["graph": walkingGraph!, "request": request]))
    }
}

/// Diagnostic timings stay in the app cache, never in passenger-facing screens.
/// First content task is not a first-frame or time-to-interactive measurement.
@MainActor enum NativePerformance {
    static var launchStart = ProcessInfo.processInfo.systemUptime
    static var measurements: [String: Double] = [:]
    static var sampled = false
    static func record(_ key: String, since start: TimeInterval, maximum: Bool = false) {
        let elapsed = (ProcessInfo.processInfo.systemUptime - start) * 1000
        measurements[key] = maximum ? max(measurements[key] ?? 0, elapsed) : elapsed
    }
    static func sampleMainActor() async {
        guard !sampled else { return }
        sampled = true
        record("appInitToContentTaskMs", since: launchStart)
        for _ in 0..<24 {
            let start = ProcessInfo.processInfo.systemUptime
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            let lag = max(0, (ProcessInfo.processInfo.systemUptime - start) * 1000 - 250)
            measurements["mainActorSchedulingLagMaxMs"] = max(measurements["mainActorSchedulingLagMaxMs"] ?? 0, lag)
        }
        guard let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return }
        let report: [String: Any] = ["measuredAt": WireClock.string(), "metrics": measurements,
            "note": "In-process startup and 24 foreground scheduling samples; not OS launch duration or interaction latency."]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: directory.appendingPathComponent("ui-performance.json"), options: .atomic)
        }
    }
}
