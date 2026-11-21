import Foundation

struct SpatialRepository {
    let pack: SpatialPack
    init(pack: SpatialPack) throws {
        guard pack.schemaVersion == 1, !pack.id.isEmpty, !pack.version.isEmpty,
              pack.bbox.count == 4, pack.bbox.allSatisfy(\.isFinite), pack.bbox[0] < pack.bbox[2], pack.bbox[1] < pack.bbox[3],
              pack.features.count <= 30_000, pack.sources.count <= 30,
              Set(pack.sources.map(\.id)).count == pack.sources.count,
              Set(pack.features.map(\.id)).count == pack.features.count else { throw SpatialReadError.invalidPack }
        let sources = Set(pack.sources.map(\.id))
        guard pack.sources.allSatisfy({ !$0.id.isEmpty && !$0.license.isEmpty && !$0.attribution.isEmpty && $0.sha256.count == 64 }),
              pack.features.allSatisfy({ feature in
                  !feature.id.isEmpty && sources.contains(feature.sourceID) && !feature.geometry.isEmpty && feature.geometry.count <= 10_000
                  && feature.geometry.allSatisfy(\.isValid)
                  && (feature.level == nil || !feature.level!.isEmpty)
                  && (feature.accuracyMeters == nil || (feature.accuracyMeters!.isFinite && feature.accuracyMeters! > 0))
                  // This pack carries reference/candidate geometry; surveyed activation belongs to a validated local site pack.
                  && feature.precision != .surveyedPedestrianArea
              }) else { throw SpatialReadError.invalidPack }
        self.pack = pack
    }
    static func load(url: URL) throws -> Self {
        guard let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 8_000_000 else { throw SpatialReadError.oversized }
        return try Self(pack: JSONDecoder().decode(SpatialPack.self, from: Data(contentsOf: url)))
    }
    static func bundled(bundle: Bundle = .main) -> Self? {
        guard let url = bundle.url(forResource: "bern-spatial", withExtension: "json", subdirectory: "SpatialPacks")
            ?? bundle.url(forResource: "bern-spatial", withExtension: "json") else { return nil }
        return try? load(url: url)
    }
    /// Keep 5 MB JSON decoding off the main actor during the initial map load.
    static func loadBundled() async -> Self? {
        await Task.detached(priority: .utility) { Self.bundled() }.value
    }
    func resolve(request: SpatialRequest, at now: Date) -> SpatialResolution {
        let day = SpatialTime.swissDay(request.boardingAt ?? now)
        let parent = pack.features.filter { $0.kind == .boardingReference && $0.matches(stopID: request.stopID) && $0.valid(on: day) }
        // Label narrowing is useful to inspect candidates, never sufficient for identity resolution.
        let candidates = request.signLabel.map { label in parent.filter { $0.signLabel == label } } ?? parent
        let sourceIDs = Set(parent.map(\.sourceID))
        let sources = pack.sources.filter { sourceIDs.contains($0.id) }
        let states = sources.map { $0.freshness(at: now) }
        var freshness: SpatialFreshness = states.contains(.invalid) ? .invalid : states.contains(.future) ? .future : states.contains(.stale) ? .stale : .current
        if sources.isEmpty { freshness = .invalid }
        func result(_ status: SpatialResolutionStatus, _ reason: String, point: SpatialFeature? = nil, extraSources: [SpatialSource] = []) -> SpatialResolution {
            let all = sources + extraSources.filter { !sourceIDs.contains($0.id) }
            return SpatialResolution(status: status, precision: point?.precision ?? (candidates.isEmpty ? .unknown : .stationReference),
                requestedStopID: request.stopID, call: request.call, boardingPoint: point, candidates: candidates,
                sources: all, freshness: freshness, maximumSourceAgeSeconds: all.compactMap { $0.age(at: now) }.max(), reasons: [reason])
        }
        guard !request.stopID.isEmpty, !candidates.isEmpty else { return result(.unknown, "no_current_stop_reference") }
        guard freshness == .current else { return result(.candidate, "reference_snapshot_" + freshness.rawValue) }
        guard let call = request.call, call.isValid, call.stopID == request.stopID,
              let assignment = request.assignment else { return result(.candidate, candidates.count > 1 ? "ambiguous_candidates_no_occurrence_assignment" : "reference_only_no_occurrence_assignment") }
        guard assignment.call == call else { return result(.candidate, "assignment_occurrence_or_revision_mismatch") }
        guard !assignment.evidenceReference.isEmpty, let source = request.assignmentSource ?? pack.sources.first(where: { $0.id == assignment.sourceID }),
              source.id == assignment.sourceID, source.provider == call.provider, source.sha256 == call.sourceSnapshotID,
              pack.sources.first(where: { $0.id == source.id }).map({ $0 == source }) ?? true,
              source.freshness(at: now) == .current else { return result(.candidate, "assignment_source_unavailable_or_stale") }
        guard let observed = SpatialTime.date(assignment.observedAt), let expiry = SpatialTime.date(assignment.validUntil),
              observed <= now, expiry >= now, expiry > observed,
              now.timeIntervalSince(observed) <= 300 else { return result(.candidate, "assignment_observation_stale_or_future") }
        let matches = candidates.filter { $0.referenceID == assignment.boardingPointID }
        guard matches.count == 1, let point = matches.first else { return result(.candidate, "assignment_point_or_label_conflict") }
        return result(.resolved, "explicit_current_occurrence_assignment_reference_only", point: point, extraSources: [source])
    }
    /// Candidate map context, not a routed/safe path and not a floor association.
    func nearbyFeatures(to coordinate: SpatialCoordinate, radiusMeters: Double = 120, limit: Int = 150) -> [SpatialFeature] {
        guard coordinate.isValid, radiusMeters.isFinite, (0...1000).contains(radiusMeters), limit > 0 else { return [] }
        return Array(pack.features.filter { feature in feature.geometry.contains { coordinate.distance(to: $0) <= radiusMeters } }
            .sorted { ($0.coordinate?.distance(to: coordinate) ?? .infinity) < ($1.coordinate?.distance(to: coordinate) ?? .infinity) }.prefix(min(limit, 500)))
    }
}
enum SpatialReadError: Error { case invalidPack, oversized }
