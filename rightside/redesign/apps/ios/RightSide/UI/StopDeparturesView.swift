import SwiftUI
import MapKit

/// Stop exploration is independent of passenger state. Only the ordinary Start action replaces guidance.
struct StopDeparturesView: View {
    @ObservedObject var store: JourneyStore
    @ObservedObject var controller: StopDepartureController
    let initialStop: Place?
    let initiallyOffline: Bool
    let onPlanned: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var picker: PickerKind?
    @State private var destination: Place?
    @State private var departure = Date()
    @State private var leaveNow = true
    @State private var arriveBy = false
    @State private var serviceContext: String?
    @StateObject private var presentation = DeparturePresentation()
    @AppStorage(JourneyLanguage.preferenceKey, store: JourneyLanguage.preferences) private var languageCode = "en"
    private var language: JourneyLanguage { JourneyLanguage.resolve(languageCode) }
    private func L(_ key: String, _ values: String...) -> String { language.departureRender(key, values: values) }
    private func time(_ date: Date) -> String { DepartureServiceClock.label(date, language: language) }
    private enum PickerKind: String, Identifiable { case stop, destination; var id: String { rawValue } }

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 15)) { context in
                List {
                    stopSection.disabled(presentation.planning)
                    if let snapshot = controller.snapshot, snapshot.valid(at: context.date) {
                        Section {
                            sourceStatus(snapshot, at: context.date)
                            if snapshot.rows.isEmpty { Text(L("No departures returned. Try another stop or refresh later.")) }
                            ForEach(snapshot.rows) { row in
                                NavigationLink {
                                    DepartureServiceDetails(row: row, snapshot: snapshot, language: language) { place in
                                            destination = place; serviceContext = "\(row.title) → \(row.destination ?? L("destination not supplied"))"
                                        }
                                } label: { departureRow(row, at: context.date) }
                                .accessibilityIdentifier("departure-row-\(row.id)").disabled(presentation.planning)
                            }
                        } header: { Text(L("Departures")) } footer: {
                            Text(L("Check station displays before boarding. Cancellation status and exact trip binding are not supplied. Platforms are source labels, not verified waiting areas."))
                        }
                    } else if !controller.loading {
                        Section {
                            Text(controller.offline ? L("No saved departures for this stop within the last 24 hours.") : L("Choose a stop or refresh to load departures."))
                        }
                    }
                    if let error = controller.error { Section { JourneyNotice(text: language.departureMessage(error), warning: true).accessibilityIdentifier("departure-error") } }
                    if let warning = controller.cacheWarning { Text(language.departureMessage(warning)).font(.caption) }
                    if controller.stop != nil { planningSection.disabled(presentation.planning) }
                }
            }
            .navigationTitle(controller.stop?.name ?? L("Stop departures")).navigationBarTitleDisplayMode(.large)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("Done")) { dismiss() }.accessibilityIdentifier("close-departures") } }
            .sheet(item: $picker) { kind in
                switch kind {
                case .stop:
                    if controller.offline {
                        NavigationStack {
                            List {
                                if controller.recentStops.isEmpty { Text(L("No saved stops from the last 24 hours. Reconnect to search for a transit stop.")) }
                                ForEach(controller.recentStops) { place in
                                    Button(place.name) {
                                        serviceContext = nil; picker = nil
                                        Task { await controller.select(place, offline: true) }
                                    }
                                }
                            }.navigationTitle(L("Saved stops"))
                                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("Done")) { picker = nil }.accessibilityIdentifier("close-saved-stops") } }
                        }
                    } else {
                        PlaceSearchView(store: store, title: L("Choose a transit stop"), transitStopsOnly: true) { place in
                            serviceContext = nil
                            Task { await controller.select(place, offline: controller.offline) }
                        }
                    }
                case .destination:
                    PlaceSearchView(store: store, title: L("Plan to a destination")) { destination = $0 }
                }
            }
            .task {
                guard presentation.activate() else { return }
                destination = store.navigation?.journey.destination ?? store.destination
                if let initialStop { await controller.select(initialStop, offline: initiallyOffline) }
                else { await controller.setOffline(initiallyOffline) }
            }
            .onDisappear { presentation.deactivate(); controller.cancel() }
        }
    }
    private var stopSection: some View {
        Section {
            Button { picker = .stop } label: {
                Label(controller.stop?.name ?? L("Search for a transit stop"), systemImage: "magnifyingglass")
                    .font(.headline)
            }.accessibilityIdentifier("departure-choose-stop")
            if let coordinate = MapGeometry.coordinate(controller.stop?.coordinate), let stop = controller.stop {
                Map(initialPosition: .region(MKCoordinateRegion(center: coordinate, latitudinalMeters: 600, longitudinalMeters: 600))) {
                    Marker(stop.name, coordinate: coordinate)
                }.id(stop.id).frame(height: 160).accessibilityLabel(L("Map reference for {0}, not your location", stop.name))
            }
            if controller.stop == nil, !controller.recentStops.isEmpty {
                ForEach(controller.recentStops) { stop in
                    Button(L("Saved: {0}", stop.name)) { Task { await controller.select(stop, offline: controller.offline) } }
                }
            }
            Toggle(L("Use saved departures offline"), isOn: Binding(get: { controller.offline }, set: { value in
                Task { await controller.setOffline(value) }
            })).accessibilityIdentifier("departure-offline")
            HStack {
                Button(L("Refresh departures"), systemImage: "arrow.clockwise") { Task { await controller.refresh() } }
                    .disabled(controller.offline || controller.stop == nil || controller.loading)
                    .accessibilityIdentifier("departure-refresh")
                if controller.loading {
                    ProgressView()
                    Button(L("Cancel")) { controller.cancel() }.accessibilityIdentifier("departure-cancel")
                }
            }
        }
    }
    private var planningSection: some View {
        Section(L("Plan a fresh journey from this stop")) {
            Button { picker = .destination } label: {
                Label(destination?.name ?? L("Choose destination"), systemImage: "flag.checkered")
            }.disabled(controller.offline).accessibilityIdentifier("departure-destination")
            if let context = serviceContext { Text(L("Explored: {0}", context)).font(.caption) }
            if let active = store.navigation {
                Button(L("Use current journey destination: {0}", active.journey.destination.name)) { destination = active.journey.destination }
                Button(L("Plan back to: {0}", active.journey.origin.name)) { destination = active.journey.origin }
            }
            Text(L("All times are Swiss time (Europe/Zurich); UTC offsets are shown.")).font(.caption)
            Toggle(L("Leave now"), isOn: $leaveNow)
            if !leaveNow {
                Toggle(L("Arrive by this time"), isOn: $arriveBy)
                DatePicker(L("Planning time"), selection: $departure, displayedComponents: [.date, .hourAndMinute]).environment(\.timeZone, DepartureServiceClock.zone).environment(\.locale, language.locale)
            }
            Text(L("A new full search may propose another service. Your active journey stays in place until you choose an alternative and tap Start.")).font(.caption).foregroundStyle(.secondary)
            Button {
                guard let stop = controller.stop, let destination else { return }
                let requestedTime = leaveNow ? Date() : departure
                let requestedArrival = leaveNow ? false : arriveBy
                presentation.plan {
                    await store.planFromStop(stop, to: destination, departure: requestedTime, arriveBy: requestedArrival)
                    if let error = store.error { return .failed(error) }
                    return store.previewing && !store.alternatives.isEmpty ? .ready : .empty
                } onReady: { onPlanned(); dismiss() }
            } label: {
                if presentation.planning { ProgressView(L("Planning…")) }
                else { Label(L("Find fresh journeys"), systemImage: "arrow.triangle.turn.up.right.diamond.fill") }
            }.disabled(presentation.planning || destination == nil || controller.offline || controller.stop.flatMap { DepartureStop.id(for: $0) } == nil)
                .accessibilityIdentifier("departure-plan")
            if let outcome = presentation.outcome {
                switch outcome {
                case .empty: Text(L("No journeys found. Change the destination or time and try again. Your current journey is unchanged.")).accessibilityIdentifier("departure-plan-empty")
                case .failed(let message):
                    Text(L("Planning failed. Your request is kept; try again.")).accessibilityIdentifier("departure-plan-failed")
                    Text(language.departureMessage(message)).font(.caption)
                case .ready: EmptyView()
                }
            }
            if controller.offline { Text(L("Reconnect to request a fresh journey. Saved departure times cannot plan or refresh a trip.")).font(.caption) }
        }
    }
    private func sourceStatus(_ snapshot: DepartureSnapshot, at now: Date) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(controller.mayShowPrediction(at: now) ? L("Recently requested departures") : L("Saved departures · may be out of date")).font(.headline)
            Text(L("Retrieved {0}", time(snapshot.acquiredAt))).font(.caption)
            Text(L("transport.opendata.ch · provider observation time unavailable")).font(.caption).foregroundStyle(.secondary)
            if snapshot.omittedRows > 0 { Text(L("{0} additional or invalid rows omitted.", String(snapshot.omittedRows))).font(.caption) }
            DisclosureGroup(L("Source details")) {
                Text(L("Stop ID {0} · upcoming departures", snapshot.stopID)).font(.caption)
                Text(L("HTTP response date: {0}", snapshot.responseDate ?? L("not supplied"))).font(.caption)
                Text(L("Response date is not an observation time. Predictions shown only for a successful request from this session within 90 seconds. Saved boards expire after 24 hours.")).font(.caption)
                Text(snapshot.sourceSHA256).font(.caption2).textSelection(.enabled)
            }
        }
    }
    private func departureRow(_ row: StopDeparture, at now: Date) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                RouteBadge(line: row.title == "Service" ? L("Service") : row.title)
                Text(row.destination ?? L("Destination not supplied")).font(.headline)
                Spacer(minLength: 4)
            }
            Text(L("Scheduled {0}", time(row.scheduled))).font(.title3.bold()).monospacedDigit()
            if controller.mayShowPrediction(at: now), let prediction = row.predicted {
                Text(L("Reported prediction {0}", time(prediction))).font(.subheadline)
            } else { Text(L("Current prediction unavailable")).font(.caption).foregroundStyle(.secondary) }
            Text(L("Timetable platform {0} · check signs", row.platform ?? L("not supplied"))).font(.caption)
            if controller.mayShowPrediction(at: now), let platform = row.predictedPlatform {
                Text(L("Reported platform prediction {0}", platform)).font(.caption)
            }
            if row.scheduled < now { Text(L("Scheduled time has passed")).font(.caption).foregroundStyle(.secondary) }
        }.padding(.vertical, 12).accessibilityElement(children: .combine)
    }
}

private struct DepartureServiceDetails: View {
    let row: StopDeparture
    let snapshot: DepartureSnapshot
    let language: JourneyLanguage
    private func L(_ key: String, _ values: String...) -> String { language.departureRender(key, values: values) }
    private func time(_ date: Date) -> String { DepartureServiceClock.label(date, language: language) }
    let onDestination: (Place) -> Void
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        List {
            Section(L("Reported service")) {
                Text(row.destination ?? L("Destination not supplied")).font(.headline)
                Text(L("Scheduled {0}", time(row.scheduled)))
                Text(L("Platform label: {0}", row.platform ?? L("not supplied")))
                Text(L("Operator: {0}", row.operatorName ?? L("not supplied")))
                Text(L("Cancellation status not supplied"))
                Text(L("Service reference: {0}. This is not a verified trip occurrence.", row.serviceName ?? L("not supplied"))).font(.caption)
                Text(L("Retrieved {0}", time(snapshot.acquiredAt))).font(.caption)
            }
            Section(L("Reported calls · choose a planning destination")) {
                if row.calls.isEmpty { Text(L("Call details not supplied. Choose a destination using search.")) }
                ForEach(row.calls) { call in
                    Button { onDestination(call.place); dismiss() } label: {
                        VStack(alignment: .leading) {
                            Text(call.place.name)
                            if let date = call.scheduledArrival ?? call.scheduledDeparture {
                                Text(L("Timetable {0}", time(date))).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }.accessibilityLabel(L("Plan a fresh journey to {0}", call.place.name))
                }
            }
            Text(L("Call order is reported by the source. Selecting a stop starts an editable full-plan request, not a booking or guarantee of this service.")).font(.caption)
        }.navigationTitle(row.title == "Service" ? L("Service") : row.title).navigationBarTitleDisplayMode(.inline)
    }
}
