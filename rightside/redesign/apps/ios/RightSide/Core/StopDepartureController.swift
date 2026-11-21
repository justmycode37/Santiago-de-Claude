import Foundation
import Combine

@MainActor public final class StopDepartureController: ObservableObject {
    @Published public private(set) var stop: Place?
    @Published public private(set) var snapshot: DepartureSnapshot?
    @Published public private(set) var loading = false
    @Published public private(set) var offline = false
    @Published public private(set) var error: String?
    @Published public private(set) var cacheWarning: String?
    @Published public private(set) var fromCache = true
    private let transport: any StopDepartureTransport
    private let cacheURL: URL
    private var cache: [DepartureSnapshot] = []
    private var generation = UUID()
    private var task: Task<DepartureSnapshot, Error>?
    private struct Saved: Codable { let version: Int; let entries: [DepartureSnapshot] }

    public init(transport: any StopDepartureTransport = PublicStopDepartureTransport(), cacheURL: URL? = nil, now: Date = Date()) {
        self.transport = transport
        self.cacheURL = cacheURL ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("RightSide/departures-v1.json")
        if let size = try? self.cacheURL.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 2_000_000,
           let data = try? Data(contentsOf: self.cacheURL), let saved = try? JSONDecoder().decode(Saved.self, from: data),
           saved.version == 1, saved.entries.count <= 4,
           Set(saved.entries.map(\.queryKey)).count == saved.entries.count {
            cache = saved.entries.filter { $0.valid(at: now) }
        }
    }
    public var recentStops: [Place] { cache.filter { $0.valid(at: Date()) }.map(\.stop) }
    public func cancel() {
        generation = UUID(); task?.cancel(); task = nil; loading = false
    }
    /// Selection and every refresh invalidate the prior request, including cancellation-ignoring transports.
    public func select(_ place: Place, offline: Bool, now: Date = Date()) async {
        cancel(); self.offline = offline; stop = place; error = nil; fromCache = true
        guard let id = DepartureStop.id(for: place) else {
            snapshot = nil; error = "This place has no unambiguous provider stop ID. Choose a transit stop from search."; return
        }
        snapshot = cache.first { $0.stopID == id && $0.queryLimit == 40 && $0.valid(at: now) }
        guard !offline else { return }
        await refresh(now: now)
    }
    public func setOffline(_ value: Bool, now: Date = Date()) async {
        if let stop { await select(stop, offline: value, now: now) }
        else { cancel(); offline = value }
    }
    public func refresh(now: Date = Date()) async {
        cancel(); error = nil; fromCache = true
        guard !offline, let stop, let id = DepartureStop.id(for: stop) else { return }
        if snapshot?.valid(at: now) != true { snapshot = nil }
        let token = generation
        loading = true
        defer { if token == generation { loading = false; task = nil } }
        let transport = transport
        let work = Task { try await transport.departures(stopID: id) }
        task = work
        do {
            let result = try await withTaskCancellationHandler(operation: { try await work.value }, onCancel: { work.cancel() })
            guard token == generation, !Task.isCancelled, !work.isCancelled, !offline,
                  DepartureStop.id(for: self.stop ?? stop) == id else { return }
            guard result.stopID == id, result.queryLimit == 40, result.valid(at: Date()) else { throw NativeCoreError.message("Departure source returned an invalid or expired snapshot.") }
            snapshot = result; fromCache = false
            cache.removeAll { $0.stopID == id || !$0.valid(at: Date()) }
            cache.insert(result, at: 0); cache = Array(cache.prefix(4)); persist()
        } catch {
            if token == generation, !Task.isCancelled, !work.isCancelled { self.error = error.localizedDescription }
        }
        if token == generation { loading = false; task = nil }
    }
    public func mayShowPrediction(at now: Date) -> Bool {
        !offline && !fromCache && !loading && error == nil && snapshot?.recentlyRetrieved(at: now) == true
    }
    private func persist() {
        do {
            let data = try JSONEncoder().encode(Saved(version: 1, entries: cache))
            guard data.count <= 2_000_000 else { throw NativeCoreError.message("Departure cache exceeds its size limit.") }
            try FileManager.default.createDirectory(at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: cacheURL, options: .atomic); cacheWarning = nil
        } catch { cacheWarning = "Departures loaded, but could not be saved for offline use." }
    }
}
