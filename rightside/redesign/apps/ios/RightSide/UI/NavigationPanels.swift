import SwiftUI
import MapKit

struct WalkingInstructionCard: View {
    @ObservedObject var walking: WalkingRouteController
    @ObservedObject var location: LocationController
    let journey: Journey?
    let leg: Leg
    let offline: Bool
    let onRecover: () -> Void
    let onReroute: () -> Void
    @State private var showAll = false
    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { time in
            let detail = walking.displayedSnapshot(for: journey, leg: leg, at: time.date)
            let assessment = WalkingAssessment.assess(points: detail?.points ?? [], steps: detail?.steps ?? [],
                fix: location.latestLocation, now: time.date)
            VStack(alignment: .leading, spacing: 10) {
                Label("Walking directions", systemImage: "figure.walk").font(.headline)
                if let detail {
                    if walking.usingSavedRoute { Text("Saved route · \(detail.fetchedAt.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(Color.rightSideWarning) }
                    if assessment.status == .offRoute {
                        Label("You may be away from the mapped path", systemImage: "arrow.triangle.branch").foregroundStyle(Color.rightSideWarning)
                        Text("Your reported location is about \(Int(assessment.distanceFromRoute ?? 0)) m from the path. Check your surroundings before changing route.").font(.caption)
                        Button("Find a route from where I am", action: onReroute).disabled(offline)
                        Button("Choose my current place", action: onRecover)
                    } else if assessment.status == .uncertain || assessment.status == .unavailable {
                        Text("Position is uncertain. Use the instructions and local signs; no route position is assumed.").font(.caption).foregroundStyle(.secondary)
                    }
                    if let index = assessment.stepIndex, detail.steps.indices.contains(index) {
                        Label(detail.steps[index].instruction, systemImage: "arrow.turn.up.right").font(.body.bold())
                        if let meters = assessment.remainingMeters { Text("About \(Int(meters.rounded())) m along the mapped path").font(.caption) }
                    } else if let first = detail.steps.first { Text(first.instruction).font(.body.bold()) }
                    DisclosureGroup("All \(detail.steps.count) walking instructions", isExpanded: $showAll) {
                        ForEach(detail.steps) { step in
                            HStack(alignment: .top) {
                                Text("\(step.id + 1)").font(.caption.monospacedDigit())
                                Text(step.instruction).frame(maxWidth: .infinity, alignment: .leading)
                                Text("\(Int(step.distance)) m").font(.caption)
                            }.padding(.vertical, 4)
                        }
                    }
                    Text("Apple Maps walking estimate · \(Int(ceil(detail.expectedSeconds / 60))) min. Paths, crossings, levels and accessible entrances are not independently verified.").font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Matching walking detail is unavailable or expired. Retry when connected; follow the saved stop names and local signs.").font(.subheadline)
                    Button("Retry walking directions") { walking.retry() }.disabled(offline)
                }
            }.padding().background(.background, in: RoundedRectangle(cornerRadius: 18))
        }.accessibilityIdentifier("walking-instructions")
    }
}

struct JourneyPlanningPanel: View {
    @ObservedObject var store: JourneyStore
    let onResults: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var choosingOrigin = false
    @State private var choosingDestination = false
    var body: some View {
        NavigationStack {
            Form {
                if let draft = store.planningDraft {
                    Section {
                        Text(draft.kind == .returnTrip ? "Confirm your return start and time before searching for current services." : "Confirm where you are now. Your original journey stays available until you start a replacement.")
                        if let reason = draft.reason { Text(reason.title).font(.headline) }
                    }
                    Section("Plan from here") {
                        Button { choosingOrigin = true } label: { LabeledContent("Starting from", value: draft.origin.name) }.accessibilityIdentifier("draft-origin")
                        Button { choosingDestination = true } label: { LabeledContent("Going to", value: draft.destination.name) }.accessibilityIdentifier("draft-destination")
                        DatePicker(draft.arriveBy ? "Arrive by" : "Depart at", selection: Binding(get: { store.planningDraft?.departure ?? Date() }, set: { store.planningDraft?.departure = $0 }), displayedComponents: [.date, .hourAndMinute])
                            .accessibilityIdentifier("draft-time")
                        Toggle("Arrive by this time", isOn: Binding(get: { store.planningDraft?.arriveBy ?? false }, set: { store.planningDraft?.arriveBy = $0 }))
                        Text("Times shown in Europe/Zurich").font(.caption)
                    }
                    if store.navigation?.overlays.offline == true { Text("Saved guidance is offline. Finding a fresh return or replacement needs a network connection. Your request is saved if the search fails.").foregroundStyle(Color.rightSideWarning) }
                    if let error = store.error { Text(error).foregroundStyle(Color.rightSideWarning) }
                    if store.busy { ProgressView("Finding current services…") }
                    Button("Find current journeys") {
                        Task {
                            await store.searchPlanningDraft()
                            if store.previewing { dismiss(); onResults() }
                        }
                    }.buttonStyle(TravelButtonStyle()).disabled(store.busy).accessibilityIdentifier("search-draft")
                    Text("The return is freshly planned; outbound legs are never reversed into an invented timetable. Map and service availability depend on their providers.").font(.caption)
                }
            }
            .environment(\.timeZone, TimeZone(identifier: "Europe/Zurich")!)
            .navigationTitle(store.planningDraft?.kind == .returnTrip ? "Plan return" : "Recover journey")
            .navigationBarTitleDisplayMode(.large)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Keep current journey") { store.cancelSearch(); dismiss() }.accessibilityIdentifier("cancel-draft") } }
            .sheet(isPresented: $choosingOrigin) {
                PlaceSearchView(store: store, title: "Where are you starting?", allowsCurrentLocation: true) { store.planningDraft?.origin = $0 }
            }
            .sheet(isPresented: $choosingDestination) {
                PlaceSearchView(store: store, title: "Where are you going?") { store.planningDraft?.destination = $0 }
            }
        }
    }
}

struct RideStopsCard: View {
    let leg: Leg
    let now: Date
    let offline: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Stops on this service", systemImage: "tram.fill").font(.headline)
            ForEach(leg.calls) { call in
                HStack(alignment: .top) {
                    Image(systemName: call.id == leg.raw["alightingCallId"].string ? "arrow.down.circle.fill" : "circle")
                    VStack(alignment: .leading, spacing: 3) {
                        Text(call.place.name).font(call.id == leg.raw["alightingCallId"].string ? .body.bold() : .body)
                        if ["cancelled", "skipped"].contains(call.status) { Text(call.status.capitalized).foregroundStyle(Color.rightSideWarning) }
                    }
                    Spacer()
                    Text(journeyTime(call.plannedArrival ?? call.plannedDeparture)).font(.caption.monospacedDigit())
                }
            }
            Text("Timetable stop order · no live vehicle position. Confirm your actual stop before getting off.").font(.caption).foregroundStyle(.secondary)
            if offline { Text("Offline snapshot · times may have changed").font(.caption).foregroundStyle(Color.rightSideWarning) }
        }.padding().background(.background, in: RoundedRectangle(cornerRadius: 18)).accessibilityIdentifier("ride-stops")
    }
}


struct OfflineWalkingPanel: View {
    @ObservedObject var walking: WalkingRouteController
    let offline: Bool
    let onInspect: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 30)) { time in
                List {
                    Section { introduction }
                    Section("Walking legs") {
                        ForEach(walking.rows(at: time.date)) { row in savedLeg(row) }
                    }
                    Section { saveControls }
                }
            }
            .navigationTitle("Saved walking guidance").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.accessibilityIdentifier("offline-walking-panel")
    }
    private var introduction: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Save access, transfer and final walking paths before losing connectivity. This keeps walking geometry and instructions, not offline map tiles or live service changes.")
            Text("Paths expire 24 hours after acquisition. Closures, crossings, floors and the actual entrance are not independently verified. Follow physical signs.").font(.caption)
        }
    }
    private func savedLeg(_ row: WalkingSaveRow) -> some View {
        Button { onInspect(row.id) } label: {
            VStack(alignment: .leading, spacing: 5) {
                Text("\(row.leg.from.name) → \(row.leg.to.name)").foregroundStyle(.primary)
                Text(row.description).font(.caption).foregroundStyle(row.status == .saved ? Color.secondary : Color.orange)
                if let date = row.fetchedAt {
                    Text("Fetched \(date.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(.secondary)
                }
            }
        }.accessibilityIdentifier("offline-walk-\(row.id)")
    }
    @ViewBuilder private var saveControls: some View {
        if walking.isSaving {
            ProgressView("Saving walking legs…")
            Button("Cancel save") { walking.cancelSaving() }.accessibilityIdentifier("cancel-offline-save")
        } else {
            Button("Save missing or expired walking guidance") { Task { await walking.saveForOffline() } }
                .disabled(offline || walking.rows().isEmpty).accessibilityIdentifier("save-offline-walking")
        }
        if offline { Text("Offline · saved matching paths are used automatically as you progress or inspect each leg.").foregroundStyle(Color.rightSideWarning) }
        if let status = walking.saveStatus { Text(status).font(.caption).accessibilityIdentifier("offline-save-status") }
        Text("Up to 12 walking legs, one at a time. Saving does not request your location or confirm your journey progress.").font(.caption).foregroundStyle(.secondary)
    }
}
