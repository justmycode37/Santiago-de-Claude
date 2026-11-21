import Foundation
import Combine

/// Bundled-source resolution has no network or position dependency. Active
/// persistence and displayed alternatives are intentionally separate contexts.
@MainActor final class TransitGeometryController: ObservableObject {
    @Published private(set) var displayed: TransitJourneyGeometry?
    @Published private(set) var status: String?
    private var active: TransitJourneyGeometry?
    private var session: UUID?
    private let cacheURL: URL?
    init(cacheURL: URL? = nil) {
        self.cacheURL = cacheURL ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent("RightSide/transit-corridors-v1.json")
    }
    func update(active journey: Journey?, displayed requested: Journey?, session: UUID,
                repository: TransitGeometryRepository?, now: Date = Date()) {
        if active?.journey != journey || self.session != session || (repository != nil && active?.sourceDigest != repository?.digest) {
            self.session = session; active = nil; status = nil
            if let journey {
                if let saved = read(), saved.journey == journey,
                   repository.map({ $0.digest == saved.sourceDigest }) ?? true { active = saved }
                if let repository {
                    let next = TransitGeometryResolver(corridors: repository.corridors).resolve(journey, sourceDigest: repository.digest, at: now)
                    // Always re-evaluate source date/identity; acquisition dates
                    // belong to immutable source bytes and are never set here.
                    let unchanged = active == next
                    active = next
                    // Revalidation still runs on a new session. An equal decoded snapshot
                    // needs no rewrite: preserve its exact bytes during preview/restore.
                    if !unchanged { save(next) }
                }
            }
        }
        if requested == active?.journey { displayed = active }
        else if let requested, let repository {
            displayed = TransitGeometryResolver(corridors: repository.corridors).resolve(requested, sourceDigest: repository.digest, at: now)
        } else { displayed = nil }
    }
    func resolution(for journey: Journey, leg: Leg, at now: Date = Date()) -> TransitLegGeometry? {
        displayed?.resolution(for: journey, leg: leg, at: now)
    }
    private func read() -> TransitJourneyGeometry? {
        guard let cacheURL, let size = try? cacheURL.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 4_000_000,
              let data = try? Data(contentsOf: cacheURL), data.count <= 4_000_000,
              let value = try? JSONDecoder().decode(TransitJourneyGeometry.self, from: data), value.valid else { return nil }
        return value
    }
    private func save(_ snapshot: TransitJourneyGeometry) {
        guard snapshot.valid, let cacheURL else { status = "Mapped corridor cache unavailable; schematic journey remains available."; return }
        do {
            let data = try JSONEncoder().encode(snapshot)
            guard data.count <= 4_000_000 else { throw TransitGeometryError.invalidPack }
            try FileManager.default.createDirectory(at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: cacheURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch { status = "Could not save mapped corridors. Previously saved bytes remain; journey guidance is unchanged." }
    }
}
