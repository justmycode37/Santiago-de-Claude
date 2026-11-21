import SwiftUI

/// One presentation owns its request. Closing it cancels publication, not active guidance.
struct OJPServiceUpdateView: View {
    @ObservedObject var store: JourneyStore
    let language: JourneyLanguage
    let onRecover: () -> Void
    @Environment(\.dismiss) private var dismiss
    @StateObject private var presentation = DeparturePresentation()

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(language.service("Service information is source-reported. Response time is not a vehicle observation, passenger position or verified waiting area."))
                    if store.supportsServiceUpdates {
                        Button(language.service("Update all services")) {
                            presentation.plan(operation: {
                                await store.updateServices()
                                if let error = store.serviceUpdateError { return .failed(error) }
                                return .ready
                            }, onReady: {})
                        }.disabled(store.updatingServices || store.navigation?.overlays.offline == true || store.previewing)
                            .accessibilityIdentifier("update-all-services")
                        if store.updatingServices { ProgressView(language.service("Checking original service references…")) }
                    } else {
                        Text(language.service("This journey has no compatible service references. Plan a new OJP journey to use this feature."))
                    }
                    if store.navigation?.overlays.offline == true {
                        Text(language.service("Offline: saved information only. Source dates are unchanged."))
                    }
                    if let failure = store.serviceUpdateError {
                        Label(language.service("Update failed; guidance preserved"), systemImage: "exclamationmark.triangle")
                        if let date = store.serviceFailureAt { Text(clock(date)).font(.caption) }
                        Text(failure).font(.caption)
                    }
                    Button(language.service("Plan fresh recovery"), action: onRecover)
                        .accessibilityIdentifier("service-fresh-recovery")
                }
                if let report = store.serviceReport {
                    Section(language.service("Last received update")) {
                        Text(clock(report.acquiredAt)).font(.subheadline)
                        if report.requiresRecovery {
                            Label(language.service("Service changed. Replan before boarding."), systemImage: "exclamationmark.triangle.fill")
                        }
                    }
                    ForEach(report.changes) { change in service(change) }
                } else if let journey = store.navigation?.journey {
                    ForEach(journey.legs.filter { $0.kind == "ride" }) { leg in
                        Section([leg.line, leg.headsign].compactMap { $0 }.joined(separator: " · ")) {
                            RouteBadge(line: leg.line ?? language.text(.transit), mode: leg.mode)
                            Text(leg.from.name + " → " + leg.to.name).font(.headline)
                            Text(language.service("No service inspection saved yet."))
                            if let stamp = leg.raw["ojpSource"]["acquiredAt"].string.flatMap(WireClock.date) { Text(clock(stamp)).font(.caption) }
                        }
                    }
                }
            }.navigationTitle(language.service("Service information"))
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(language.text(.done)) { dismiss() } } }
                .onAppear { presentation.activate() }
                .onDisappear { presentation.deactivate() }
        }
    }
    private func clock(_ date: Date) -> String { DepartureServiceClock.label(date, language: language) }
    private func service(_ change: OJPServiceChange) -> some View {
        Section([change.snapshot.line, change.snapshot.destination].compactMap { $0 }.joined(separator: " · ")) {
            Text(language.service(change.status == .requiresRecovery ? "Service changed. Replan before boarding." : "Selected calls matched by stop reference and timetable."))
            Text(language.service(change.snapshot.source.recent(at: Date()) ? "Recent source response" : "Saved response; request a new update"))
            Text(language.service("Response generated") + ": " + clock(change.snapshot.source.responseTimestamp)).font(.caption)
            Text(language.service("Received") + ": " + clock(change.snapshot.source.acquiredAt)).font(.caption)
            Text(language.service(change.snapshot.cancelled == true ? "Provider reports cancellation" : change.snapshot.cancelled == false ? "Provider reports service not cancelled" : "Cancellation status not supplied")).font(.caption)
            DisclosureGroup(language.service("Changes and source details")) {
                ForEach(Array(change.messages.enumerated()), id: \.offset) { _, message in Text(message).font(.caption) }
                Text(change.snapshot.occurrence.provider).font(.caption)
                Text(change.snapshot.occurrence.journeyRef).font(.caption).textSelection(.enabled)
                Text(change.snapshot.occurrence.operatingDay).font(.caption)
                Text(change.snapshot.source.sha256).font(.caption2).textSelection(.enabled)
            }
            DisclosureGroup(language.service("All service calls")) {
                ForEach(change.snapshot.calls) { call in
                    VStack(alignment: .leading, spacing: 4) {
                        Label("\(call.order). \(call.name)", systemImage: change.selectedServiceOrders.contains(call.order) ? "circle.inset.filled" : "circle")
                        if let date = call.plannedDeparture ?? call.plannedArrival { Text(language.service("Timetable") + ": " + clock(date)).font(.caption) }
                        if let date = call.expectedDeparture ?? call.expectedArrival { Text(language.service("Supplied estimate") + ": " + clock(date)).font(.caption) }
                        if let quay = call.estimatedQuay ?? call.plannedQuay { Text(language.service("Platform label") + ": " + quay).font(.caption) }
                        if call.notServiced == true || call.noBoarding == true || call.noAlighting == true {
                            Text(language.service("Stop restriction reported; check service details")).foregroundStyle(Color.rightSideWarning)
                            if call.notServiced == true { Text(language.service("Stop not served")).font(.caption) }
                            if call.noBoarding == true { Text(language.service("Boarding not permitted")).font(.caption) }
                            if call.noAlighting == true { Text(language.service("Alighting not permitted")).font(.caption) }
                        }
                    }
                }
            }
        }
    }
}
