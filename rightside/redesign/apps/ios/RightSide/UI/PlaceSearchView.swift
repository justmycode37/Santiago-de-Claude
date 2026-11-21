import SwiftUI

struct PlaceSearchView: View {
    @ObservedObject var store: JourneyStore
    @AppStorage(JourneyLanguage.preferenceKey, store: JourneyLanguage.preferences) private var languageCode = "en"
    private var language: JourneyLanguage { JourneyLanguage.resolve(languageCode) }
    let title: String
    var allowsCurrentLocation = false
    var transitStopsOnly = false
    let onSelect: (Place) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var requestedLocation = false
    @State private var query = ""
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    SearchInput(text: $query, prompt: language.text(.searchPrompt), focused: $focused)
                    if allowsCurrentLocation {
                        CurrentLocationChoice(controller: store.locationController, language: language, requested: requestedLocation) {
                            requestedLocation = true
                            focused = false
                            store.requestLocation()
                        }
                    }
                    PlaceSearchResults(store: store, query: query, transitStopsOnly: transitStopsOnly) { place in
                        if store.locationController.isRequesting && !store.locationController.isTracking { store.stopLocation() }
                        requestedLocation = false
                        onSelect(place); dismiss()
                    }
                }.padding(20)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color.rightSidePaper)
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .onAppear { focused = true }
            .onReceive(store.$locationPlace) { place in
                if requestedLocation, let place { requestedLocation = false; onSelect(place); dismiss() }
            }
            .onDisappear { if requestedLocation { store.stopLocation() } }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(language.text(.cancel)) { dismiss() } } }
        }
    }
}

struct SearchInput: View {
    @Binding var text: String
    let prompt: String
    var focused: FocusState<Bool>.Binding
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "magnifyingglass").font(.title3.weight(.bold)).foregroundStyle(Color.rightSideTeal)
            TextField(prompt, text: $text)
                .font(.title3.weight(.semibold)).focused(focused)
                .autocorrectionDisabled().submitLabel(.search)
                .accessibilityIdentifier("visible-place-search")
            if !text.isEmpty {
                Button { text = ""; focused.wrappedValue = true } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary).frame(width: 44, height: 44)
                }.accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 16).frame(minHeight: 60)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.rightSideTeal, lineWidth: focused.wrappedValue ? 3 : 1))
    }
}

struct PlaceSearchResults: View {
    @ObservedObject var store: JourneyStore
    let query: String
    var transitStopsOnly = false
    let onSelect: (Place) -> Void
    @AppStorage(JourneyLanguage.preferenceKey, store: JourneyLanguage.preferences) private var languageCode = "en"
    private var language: JourneyLanguage { JourneyLanguage.resolve(languageCode) }
    @State private var places: [PlaceSuggestion] = []
    @State private var stops: [Place] = []
    @State private var searching = false
    @State private var message: JourneyText?

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            if searching { ProgressView(language.text(.searching)).padding(.vertical, 16) }
            if !stops.isEmpty {
                Text(language.text(.publicTransport)).font(.subheadline.bold()).foregroundStyle(.secondary).padding(.vertical, 12)
                ForEach(stops) { result($0, subtitle: language.text(.swissTransit), symbol: "tram.fill") }
            }
            if !places.isEmpty {
                Text(language.text(.placesAddresses)).font(.subheadline.bold()).foregroundStyle(.secondary).padding(.vertical, 12)
                ForEach(places) { result($0.place, subtitle: $0.subtitle, symbol: "mappin") }
            }
            if !searching && stops.isEmpty && places.isEmpty {
                Text(language.text(query.trimmingCharacters(in: .whitespacesAndNewlines).count < 2 ? .searchHint : .noPlaces))
                    .font(.body).foregroundStyle(.secondary).padding(.vertical, 14)
            }
            if let message { JourneyNotice(text: language.text(message), warning: true).padding(.top, 12) }
        }
        .task(id: query) {
            places = []; stops = []; message = nil
            let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
            guard text.count >= 2 else { searching = false; return }
            searching = true
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            // Publish each source as it finishes, so a slow address lookup never hides stop results.
            await withTaskGroup(of: Void.self) { group in
                group.addTask { @MainActor in
                    let found = await store.searchPlaces(text)
                    guard !Task.isCancelled else { return }
                    stops = transitStopsOnly ? found.filter { DepartureStop.id(for: $0) != nil } : found
                    if store.placeError != nil { message = .stationSearchUnavailable }
                }
                if !transitStopsOnly {
                    group.addTask { @MainActor in
                        do {
                            let found = try await MapPlaceSearch.search(text, near: store.locationController.isStale() ? MapGeometry.coordinate(store.origin?.coordinate) : store.locationController.latestLocation?.coordinate)
                            guard !Task.isCancelled else { return }
                            places = found
                        } catch {
                            guard !Task.isCancelled else { return }
                            message = .placeSearchUnavailable
                        }
                    }
                }
            }
            guard !Task.isCancelled else { return }
            searching = false
        }
    }
    @ViewBuilder private func result(_ place: Place, subtitle: String, symbol: String) -> some View {
        Button { onSelect(place) } label: {
            HStack(spacing: 14) {
                Image(systemName: symbol).font(.title3.bold()).foregroundStyle(Color.rightSideTeal)
                    .frame(width: 44, height: 44).background(Color.rightSideTeal.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
                VStack(alignment: .leading, spacing: 4) {
                    Text(place.name).font(.headline).foregroundStyle(.primary)
                    Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.left").foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, minHeight: 68, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("place-result-\(place.id)")
        Divider()
    }
}

struct CurrentLocationChoice: View {
    @ObservedObject var controller: LocationController
    let language: JourneyLanguage
    let requested: Bool
    let action: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Button(action: action) {
                    Label(controller.isRequesting ? language.text(.findingLocation) : language.text(.useLocation), systemImage: "location.fill")
                        .frame(minHeight: 44)
                }.disabled(controller.isRequesting).accessibilityIdentifier("use-current-location")
                Spacer()
                if controller.isRequesting {
                    Button(language.text(.cancel)) { controller.stop() }.frame(minHeight: 44)
                }
            }
            if requested {
                Text(controller.status).font(.subheadline).foregroundStyle(.secondary)
                if controller.authorizationStatus == .denied { Button(language.text(.openSettings)) { controller.openSettings() }.frame(minHeight: 44) }
            }
        }
    }
}
