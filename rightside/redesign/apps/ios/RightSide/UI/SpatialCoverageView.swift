import SwiftUI

/// A presents this component from its map. Selection resolves through the same repository used by camera context.
struct SpatialCoverageView: View {
    let repository: SpatialRepository
    var request: SpatialRequest? = nil
    var now: Date = Date()
    var body: some View {
        List {
            Section("Spatial coverage") {
                LabeledContent("Boarding references", value: String(repository.pack.features.filter { $0.kind == .boardingReference }.count))
                LabeledContent("Mapped paths", value: String(repository.pack.features.filter { $0.kind == .pedestrianPath }.count))
                LabeledContent("Mapped entrances", value: String(repository.pack.features.filter { $0.kind == .entrance }.count))
                LabeledContent("Surveyed waiting areas", value: "0")
                Text("Registry points and mapped paths are references. They do not confirm your pavement, floor or safe waiting space.").font(.caption)
            }
            if let request {
                let resolution = repository.resolve(request: request, at: now)
                Section("Boarding reference") {
                    LabeledContent("Identity", value: resolution.status.passengerLabel)
                    LabeledContent("Precision", value: resolution.precision.passengerLabel)
                    LabeledContent("Snapshot", value: resolution.freshness.passengerLabel)
                    if let point = resolution.boardingPoint { reference(point) }
                    else {
                        Text(resolution.candidates.count > 1 ? "Several possible references. Check the original sign and service assignment." : "No current occurrence-specific boarding assignment. Check local signs.")
                        ForEach(resolution.candidates.prefix(12)) { point in reference(point) }
                    }
                }
            }
            Section("Sources and freshness") {
                ForEach(repository.pack.sources) { source in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(source.attribution).font(.subheadline)
                        Text(source.freshness(at: now).passengerLabel + " · " + source.fetchedAt).font(.caption)
                        if let age = source.age(at: now) { Text("Snapshot age: \(max(0, Int(age / 3600))) h").font(.caption) }
                        if let url = URL(string: source.license) { Link("Source terms", destination: url).font(.caption) }
                    }
                }
            }
        }.navigationTitle("Spatial coverage").accessibilityIdentifier("spatial-coverage")
    }
    private func reference(_ point: SpatialFeature) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(point.name + (point.signLabel.map { " · " + $0 } ?? ""))
            Text("Level: " + (point.level ?? "Unknown")).font(.caption)
        }
    }
}

private extension SpatialResolutionStatus {
    var passengerLabel: String { switch self {
    case .resolved: "Assigned boarding reference"
    case .candidate: "Check possible references"
    case .unknown: "No matching reference"
    } }
}
private extension SpatialPrecision {
    var passengerLabel: String { switch self {
    case .unknown: "Location detail unavailable"
    case .stationReference: "Stop only; boarding area unconfirmed"
    case .boardingReference: "Boarding point; waiting space unverified"
    case .mappedCandidate: "Mapped candidate; not field checked"
    case .surveyedPedestrianArea: "Surveyed pedestrian area"
    } }
}
private extension SpatialFreshness {
    var passengerLabel: String { switch self {
    case .current: "Within source validity"
    case .stale: "Older data; check current signs"
    case .future: "Source time is ahead; cannot verify"
    case .invalid: "Source date unavailable"
    } }
}
