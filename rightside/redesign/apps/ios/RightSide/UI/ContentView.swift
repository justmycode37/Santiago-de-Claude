import SwiftUI
import Combine
import MapKit

struct ContentView: View {
    @ObservedObject var store: JourneyStore
    @AppStorage(JourneyLanguage.preferenceKey, store: JourneyLanguage.preferences) private var languageCode = "en"
    private var language: JourneyLanguage { JourneyLanguage.resolve(languageCode) }
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var sheet: Panel?
    @State private var destinationQuery = ""
    @FocusState private var destinationFocused: Bool
    @State private var panelExpanded = false
    @State private var requestedHomeLocation = false
    @State private var cachedSpatialFeatures: [SpatialFeature] = []
    @State private var correction: Leg?
    @State private var showDetails = false
    @State private var editingJourney = false
    @State private var leavingNow = true
    @State private var mapIs3D = false
    @State private var mapOverviewRequest = UUID()
    @State private var inspectedLegID: String?
    @State private var spatialRepository: SpatialRepository?
    @State private var transitRepository: TransitGeometryRepository?
    @StateObject private var transitGeometry = TransitGeometryController()
    @State private var departureStop: Place?
    @State private var departurePresentationID = UUID()
    @StateObject private var departures = StopDepartureController()
    @StateObject private var reminders = JourneyReminders()
    @StateObject private var walking = WalkingRouteController()
    @StateObject private var visual = VisualLocationStore()
    private let timer = Timer.publish(every: 5, on: .main, in: .common).autoconnect()
    private enum Panel: String, Identifiable { case origin, destination, replan, camera, settings, details, time, language, planning, coverage, offlineWalking, departures, serviceUpdates; var id: String { rawValue } }
    private var active: NavigationSnapshot? {
        guard !store.previewing, let navigation = store.navigation, navigation.journey.id == store.selected?.id else { return nil }
        return navigation
    }
    private var journey: Journey? { active?.journey ?? store.selected }
    private var simulated: Bool { journey?.evidence.contains(where: { $0.kind == "simulated" || $0.kind == "replay" }) ?? false }
    private var leg: Leg? { active?.currentLeg ?? journey?.legs.first }
    private var mapLeg: Leg? { journey?.legs.first { $0.id == inspectedLegID } ?? leg }
    private var ride: Leg? {
        if leg?.kind == "ride" { return leg }
        return journey?.legs.dropFirst(active?.legIndex ?? 0).first(where: { $0.kind == "ride" })
    }

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                VStack(spacing: 0) {
                    if !destinationFocused {
                        mapSurface
                            .frame(height: geometry.size.height * (!showingJourney || panelExpanded || dynamicTypeSize.isAccessibilitySize ? 0.22 : 0.43))
                            .clipped()
                    }
                    VStack(spacing: 0) {
                        Button {
                            panelExpanded.toggle()
                        } label: {
                            Capsule().fill(Color.secondary.opacity(0.45)).frame(width: 38, height: 5)
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }.buttonStyle(.plain).accessibilityLabel(panelExpanded ? "Show more map" : "Expand journey panel")
                        .gesture(DragGesture(minimumDistance: 16).onEnded { panelExpanded = $0.translation.height < 0 })
                        ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let error = store.error {
                        JourneyNotice(text: language.text(.errorHelp) + "\n" + language.appMessage(error), warning: true).accessibilityIdentifier("journey-error")
                    }
                    if store.busy {
                        HStack { ProgressView(language.text(.findingJourneys)); Spacer(); Button(language.text(.cancel)) { store.cancelSearch() }.frame(minHeight: 44) }
                    }
                    if showingOptions {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(store.destination?.name ?? language.text(.journeys)).font(.title2.bold())
                            Text(language.text(.from, store.origin?.name ?? language.text(.startingPoint))).font(.subheadline).foregroundStyle(.secondary)
                        }
                        alternatives
                    } else if showingJourney, let journey {
                        if simulated {
                            Text(language.text(.demo)).font(.caption).foregroundStyle(Color.rightSideWarning).accessibilityIdentifier("simulated-banner")
                        }
                        if active?.overlays.offline == true {
                            JourneyNotice(text: language.text(.offline), warning: true)
                        }
                        nextAction(journey)
                        legSelector(journey)
                        if let mapLeg, mapLeg.id != leg?.id {
                            Button("Back to active step") { inspectedLegID = nil }
                        }
                        if let mapLeg, mapLeg.kind != "ride", !simulated {
                            WalkingInstructionCard(walking: walking, location: store.locationController,
                                journey: journey, leg: mapLeg,
                                offline: active?.overlays.offline == true,
                                onRecover: { store.prepareRecovery(.offRoute); sheet = .planning },
                                onReroute: { Task {
                                    guard let fix = store.locationController.latestLocation,
                                          !store.locationController.isStale(), fix.horizontalAccuracy <= 35 else { return }
                                    await walking.load(mapLeg, simulated: simulated, offline: active?.overlays.offline == true, from: fix.coordinate, journey: journey)
                                } })
                        }
                        if let leg, leg.kind == "ride" {
                            boarding(leg)
                            if ["riding", "alighting"].contains(active?.phase ?? "") {
                                RideStopsCard(leg: leg, now: Date(), offline: active?.overlays.offline == true)
                            }
                        }
                        if active != nil, !simulated {
                            Button(language.service("Service information")) { sheet = .serviceUpdates }
                                .accessibilityIdentifier("open-service-updates")
                            Button("Saved walking guidance") { sheet = .offlineWalking }
                                .accessibilityIdentifier("open-offline-walking")
                        }
                        if active != nil, active?.phase != "arrived" { recoveryActions }
                        if showingCamera {
                            Button { sheet = .camera } label: {
                                Label(language.text(.camera), systemImage: "camera.viewfinder").frame(maxWidth: .infinity)
                            }.buttonStyle(.bordered).controlSize(.large).accessibilityIdentifier("open-camera")
                        }
                    } else {
                        searchCard
                        if !destinationFocused && destinationQuery.isEmpty {
                            Button { openDepartures(store.origin) } label: {
                                HStack(spacing: 14) {
                                    Image(systemName: "tram.fill").font(.title2).frame(width: 48, height: 48)
                                        .background(Color.rightSideTeal.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
                                    Text(language.departure("Explore stops and departures")).font(.headline)
                                    Spacer(); Image(systemName: "chevron.right")
                                }.foregroundStyle(.primary).padding(16)
                                    .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
                            }.buttonStyle(.plain).accessibilityIdentifier("explore-departures")
                        }
                        if !store.busy, let notice = store.notice, store.alternatives.isEmpty, active == nil {
                            Text(language.appMessage(notice)).font(.subheadline).foregroundStyle(.secondary).accessibilityIdentifier("journey-notice")
                        }
                    }
                }.padding(.horizontal, 20).padding(.bottom, 24)
                        }.scrollDismissesKeyboard(.interactively)
                    }.background(Color.rightSidePaper, in: UnevenRoundedRectangle(topLeadingRadius: 26, topTrailingRadius: 26))
                    .padding(.top, -20)
                }
            }
            .background(Color.rightSidePaper)
            .navigationTitle("RightSide").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if editingJourney && active != nil || store.previewing && store.navigation != nil {
                        Button(language.text(.resume)) { store.resume(); editingJourney = false; showDetails = false }.accessibilityIdentifier("resume-current")
                    } else if showingOptions || showDetails && !store.alternatives.isEmpty {
                        Button(language.text(.back), systemImage: "chevron.left") {
                            if showDetails { showDetails = false }
                            else { editingJourney = true }
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { sheet = .settings } label: { Image(systemName: "gearshape.fill") }
                        .accessibilityLabel(language.text(.settings))
                }
                ToolbarItem(placement: .topBarTrailing) { moreMenu }
            }
            .sheet(item: $sheet) { panel in
                switch panel {
                case .serviceUpdates:
                    OJPServiceUpdateView(store: store, language: language) {
                        store.prepareRecovery(.disruption); sheet = .planning
                    }
                case .departures:
                    let presentationID = departurePresentationID
                    StopDeparturesView(store: store, controller: departures, initialStop: departureStop,
                        initiallyOffline: store.navigation?.overlays.offline == true) {
                            guard sheet == .departures, departurePresentationID == presentationID else { return }
                            showDetails = false; editingJourney = false; inspectedLegID = nil; sheet = nil
                        }.id(presentationID)
                case .origin: PlaceSearchView(store: store, title: language.text(.startingFrom), allowsCurrentLocation: true) { store.origin = $0 }
                case .destination: PlaceSearchView(store: store, title: language.text(.goingTo)) { store.destination = $0 }
                case .replan: PlaceSearchView(store: store, title: language.text(.whereNow), allowsCurrentLocation: true) { place in Task { await store.replan(from: place); showDetails = false; editingJourney = false } }
                case .camera:
                    ARExperienceView(context: cameraContext, location: store.locationController, visual: visual,
                        onObservation: { store.observeVision($0) }, onDone: { sheet = nil })
                        .task(id: ride?.from.id) { await loadBoardingDepartures() }
                case .settings: settings
                case .details: journeyDetails
                case .time: departureSettings
                case .language: languageSettings
                case .planning: JourneyPlanningPanel(store: store) { showDetails = false; editingJourney = false; inspectedLegID = nil }
                case .offlineWalking:
                    OfflineWalkingPanel(walking: walking, offline: store.navigation?.overlays.offline == true,
                        onInspect: { inspectedLegID = $0; sheet = nil })
                case .coverage:
                    NavigationStack {
                        if let repository = spatialRepository { SpatialCoverageView(repository: repository, request: spatialRequest) }
                        else { Text("Spatial reference pack unavailable.") }
                    }
                }
            }
            .task { await NativePerformance.sampleMainActor() }
            .onReceive(timer) { _ in if scenePhase == .active { store.tick() } }
             .onChange(of: scenePhase) { _, phase in
                if phase == .active { store.tick(); updateTracking() }
                else if phase == .background { store.locationController.stop(); visual.observation = nil }
            }
            .onChange(of: sheet) { _, panel in if panel == nil { updateTracking() } }
            .onChange(of: active?.journey.id) { _, _ in updateTracking() }
            .onChange(of: store.navigationSessionID) { _, _ in visual.observation = nil; inspectedLegID = nil; reminders.cancel(); updateTracking() }
            .onChange(of: active?.phase) { _, phase in
                if phase == "arrived" { visual.observation = nil }
                updateTracking()
            }
            .task(id: journey?.id) {
                if journey != nil && spatialRepository == nil { spatialRepository = await SpatialRepository.loadBundled() }
            }
            .task(id: "\(mapLeg?.id ?? "")-\(spatialRepository != nil)") {
                guard let repository = spatialRepository, let coordinate = mapLeg?.to.coordinate, coordinate.count == 2 else { cachedSpatialFeatures = []; return }
                let features = await Task.detached(priority: .utility) {
                    repository.nearbyFeatures(to: SpatialCoordinate(latitude: coordinate[1], longitude: coordinate[0]), radiusMeters: 100, limit: 60)
                }.value
                guard !Task.isCancelled else { return }
                cachedSpatialFeatures = features
            }
            .task(id: journey?.id) { if journey != nil && transitRepository == nil { transitRepository = await TransitGeometryRepository.loadBundled() } }
            .task(id: transitRequest) {
                transitGeometry.update(active: store.isDemo ? nil : store.navigation?.journey,
                    displayed: journey, session: store.navigationSessionID, repository: transitRepository)
            }
            .task(id: walkingRequest) {
                walking.configure(journey: store.isDemo ? nil : store.navigation?.journey,
                    session: store.navigationSessionID, offline: store.navigation?.overlays.offline == true)
                await walking.load(mapLeg, simulated: simulated, offline: store.navigation?.overlays.offline == true, journey: journey)
            }
            .task(id: "\(store.navigationSessionID)-\(store.navigation?.phase ?? "")-\(store.currentLeg?.id ?? "")-\(store.navigation?.journey.revision ?? 0)-\(store.navigation?.overlays.disrupted ?? false)") {
                await reminders.update(navigation: store.isDemo ? nil : store.navigation, session: store.navigationSessionID)
            }
        }.environment(\.locale, language.locale)
    }

    private struct TransitRequest: Equatable {
        let active: Journey?
        let displayed: Journey?
        let session: UUID
        let sourceDigest: String?
    }
    private var transitRequest: TransitRequest {
        TransitRequest(active: store.navigation?.journey, displayed: journey,
            session: store.navigationSessionID, sourceDigest: transitRepository?.digest)
    }

    private struct WalkingRequest: Equatable {
        let active: Journey?
        let displayed: Journey?
        let leg: Leg?
        let session: UUID
        let offline: Bool
        let simulated: Bool
        let refresh: UUID
    }
    private var walkingRequest: WalkingRequest {
        WalkingRequest(active: store.navigation?.journey, displayed: journey, leg: mapLeg,
            session: store.navigationSessionID, offline: store.navigation?.overlays.offline == true,
            simulated: simulated, refresh: walking.refreshID)
    }

    private func updateTracking() {
        if scenePhase == .active && store.navigation != nil && store.navigation?.phase != "arrived" && !store.isDemo { store.locationController.startTracking() }
        else if store.locationController.isTracking { store.locationController.stop() }
    }
    private var cameraContext: CameraJourneyContext {
        let onBoard = ["riding", "alighting"].contains(active?.phase ?? "")
        let eligible = !onBoard && store.boardingServiceEligible(for: ride)
        let stop = leg?.kind == "ride" ? (onBoard ? leg?.to : leg?.from) : leg?.to
        var target = MapGeometry.coordinate(stop?.coordinate)
        // Aim the AR marker at the resolved boarding edge/platform when the journey has one, else the stop.
        let resolvedPoint = eligible && spatialResolution?.boardingPointID != nil ? spatialResolution?.coordinate : nil
        let routeEnd = resolvedPoint.flatMap { $0.isValid ? CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude) : nil } ?? target
        var label = language.text(.referenceLocation, stop?.name ?? language.text(.journeyStop))
        var route: [CLLocationCoordinate2D] = []
        if let leg, leg.kind != "ride", let detail = walking.displayedSnapshot(for: journey, leg: leg) {
            route = detail.points
            if let fix = store.locationController.latestLocation, let point = MapGeometry.lookAhead(on: detail.points, from: fix) {
                target = point; label = language.text(.mappedWalk)
            }
        }
        return CameraJourneyContext(id: "\(store.navigationSessionID)-\(journey?.id ?? "none")-\(journey?.revision ?? 0)-\(leg?.id ?? "none")-\(active?.phase ?? "preview")-\(active?.overlays.offline ?? false)-service-\(eligible)",
            title: nextTitle, line: onBoard ? nil : ride?.line, destination: onBoard ? nil : ride?.headsign,
            stop: stop?.name, target: target, targetLabel: label, simulated: simulated,
            boardingStopID: onBoard ? nil : ride?.from.id,
            boardingPointID: eligible ? spatialResolution?.boardingPointID : nil,
            serviceExpectation: boardingExpectation(eligible: eligible), route: route, routeEnd: routeEnd)
    }
    /// The selected ride plus the other departures listed at its boarding stop, so the camera can tell a
    /// misread of the right display from a different bus or tram, and name the one it sees.
    private func boardingExpectation(eligible: Bool) -> VehicleServiceExpectation? {
        guard eligible, var expectation = CameraBoardingContext.expectation(journey: journey, ride: ride) else { return nil }
        expectation.boardAlternatives = DisplayCandidate.board(departures.snapshot,
            boardingStop: DepartureBoardStop.place(for: ride?.from), now: Date())
        return expectation
    }
    private func loadBoardingDepartures() async {
        guard let stop = DepartureBoardStop.place(for: ride?.from), let id = DepartureStop.id(for: stop) else { return }
        let offline = store.navigation?.overlays.offline == true
        if departures.stop.flatMap(DepartureStop.id(for:)) == id, departures.snapshot?.recentlyRetrieved(at: Date()) == true { return }
        await departures.select(stop, offline: offline)
    }
    private var showingOptions: Bool { active == nil && !editingJourney && !showDetails && !store.alternatives.isEmpty }
    private var showingJourney: Bool { !editingJourney && journey != nil && (active != nil || showDetails) }
    private var showingMap: Bool { showingJourney }
    private var showingCamera: Bool { active != nil && !["riding", "alighting", "arrived"].contains(active?.phase ?? "") }

    private var moreMenu: some View {
        Menu {
            Button("AR & 3D", systemImage: "camera.viewfinder") { sheet = .camera }
            Button(language.departure("Stops and departures"), systemImage: "tram.fill") { openDepartures(mapLeg?.from) }.accessibilityIdentifier("departures-menu")
            if showingJourney {
                Button(language.text(.details), systemImage: "list.bullet") { sheet = .details }.accessibilityIdentifier("journey-details")
                Button(language.text(.changeJourney), systemImage: "magnifyingglass") { editingJourney = true; showDetails = false }
                if showingMap {
                    Button(mapIs3D ? language.text(.map2D) : language.text(.map3D)) { mapIs3D.toggle() }
                        .accessibilityLabel(mapIs3D ? language.text(.switch2D) : language.text(.switch3D)).accessibilityIdentifier("map-dimension")
                    Button(language.text(.wholeMap)) { mapOverviewRequest = UUID() }
                }
                if active != nil && !simulated && active?.phase != "arrived" {
                    Button(language.text(.replan), systemImage: "arrow.triangle.branch") { sheet = .replan }
                }
                if active?.phase == "riding" {
                    Button(language.text(.stopNext)) { store.prepareAlighting() }.accessibilityIdentifier("prepare-alighting")
                }
                if simulated && active != nil && store.canStepScenario {
                    Button(language.text(.nextSimulation)) { store.nextScenario() }.accessibilityIdentifier("next-scenario")
                }
            } else {
                Button(language.text(.savedJourney), systemImage: "bookmark") { store.restore(); editingJourney = false; showDetails = false }.accessibilityIdentifier("restore-journey")
                if store.origin != nil && store.destination != nil {
                    Button(language.text(.swap), systemImage: "arrow.up.arrow.down") { let from = store.origin; store.origin = store.destination; store.destination = from }
                }
                Button(language.text(.tryDemo)) { store.loadDemo(); showDetails = true; editingJourney = false }.accessibilityIdentifier("load-demo")
            }
            if store.planningDraft != nil { Button("Saved return or recovery request") { sheet = .planning }.accessibilityIdentifier("saved-planning-request") }
            Button(language.text(.language), systemImage: "globe") { sheet = .language }.accessibilityIdentifier("choose-language-menu")
            Button(language.text(.settings), systemImage: "gearshape") { sheet = .settings }.accessibilityIdentifier("open-settings")
        } label: { Image(systemName: "ellipsis.circle") }
            .accessibilityLabel(language.text(.more)).accessibilityIdentifier("more-menu")
    }
    private var journeyDetails: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let journey {
                        timeline(journey)
                        if let leg, leg.kind == "ride" { boarding(leg) }
                        if let detail = walking.displayedSnapshot(for: journey, leg: mapLeg) {
                            VStack(alignment: .leading, spacing: 10) {
                                Text(language.text(.walkDirections, String(Int(ceil(detail.expectedSeconds / 60))))).font(.headline)
                                Text("\(detail.leg.from.name) → \(detail.leg.to.name)").font(.caption)
                                ForEach(detail.steps) { step in Text(language.text(.originalMessage, step.instruction)) }
                                Text("Fetched \(detail.fetchedAt.formatted(date: .abbreviated, time: .shortened))").font(.caption)
                                Text(language.text(.appleEstimate)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        if !journey.warnings.isEmpty {
                            ForEach(Array(journey.warnings.enumerated()), id: \.offset) { _, warning in Text(language.text(.originalMessage, warning)).font(.caption).foregroundStyle(.secondary) }
                        }
                        Text(language.text(.mapCaution)).font(.caption).foregroundStyle(.secondary)
                    }
                    if let notice = store.notice { Text(language.appMessage(notice)).font(.caption).foregroundStyle(.secondary) }
                }.padding()
            }
            .navigationTitle(language.text(.details)).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(language.text(.done)) { sheet = nil }.accessibilityIdentifier("close-panel") } }
            .confirmationDialog(language.text(.correctLeg), isPresented: Binding(get: { correction != nil }, set: { if !$0 { correction = nil } }), titleVisibility: .visible) {
                if let correction {
                    if correction.kind == "ride" {
                        correctionButton(language.text(.approachingChoice), phase: "approaching", leg: correction)
                        correctionButton(language.text(.waitingChoice), phase: "waiting", leg: correction)
                        correctionButton(language.text(.ridingChoice), phase: "riding", leg: correction)
                        correctionButton(language.text(.alightingChoice), phase: "alighting", leg: correction)
                    } else {
                        correctionButton(language.text(.walkingChoice), phase: correction.kind == "transfer" ? "transfer" : correction.id == journey?.legs.last?.id ? "final_walk" : "walking", leg: correction)
                    }
                }
            } message: { Text(language.text(.correctionCaution)) }
        }
    }
    private func openDepartures(_ stop: Place?) {
        departurePresentationID = UUID(); departureStop = stop; sheet = .departures
    }
    private var departureSettings: some View {
        NavigationStack {
            Form {
                DatePicker(store.arriveBy ? language.text(.arriveBy) : language.text(.departAt), selection: Binding(get: { store.departure }, set: { leavingNow = false; store.departure = $0 }), displayedComponents: [.date, .hourAndMinute])
                Toggle(language.text(.arriveToggle), isOn: Binding(get: { store.arriveBy }, set: { leavingNow = false; store.arriveBy = $0 }))
                Button(language.text(.leaveNow)) { leavingNow = true; store.departure = Date(); store.arriveBy = false; sheet = nil }
                Text(language.text(.zurichTime)).font(.caption).foregroundStyle(.secondary)
            }
            .environment(\.timeZone, TimeZone(identifier: "Europe/Zurich")!)
            .navigationTitle(language.text(.departure)).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(language.text(.done)) { sheet = nil }.accessibilityIdentifier("close-panel") } }
        }.presentationDetents([.medium, .large])
    }
    private var mapSurface: some View {
        Group {
            if !editingJourney, let journey {
                JourneyMapView(journey: journey, position: active?.position, location: store.locationController,
                    walking: walking, transit: transitGeometry, visual: visual, simulated: simulated, is3D: $mapIs3D,
                    overviewRequest: mapOverviewRequest, focusedLegID: mapLeg?.id,
                    onSelectLeg: { inspectedLegID = $0 }, onSelectStop: { openDepartures($0) },
                    spatialResolution: spatialResolution, spatialFeatures: cachedSpatialFeatures)
            } else {
                ExploreMapView(origin: store.origin, destination: store.destination, location: store.locationController)
            }
        }.padding(.bottom, 20)
    }
    private var searchCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !destinationFocused && destinationQuery.isEmpty {
                Button { sheet = .camera } label: {
                    Label("Open AR & 3D", systemImage: "camera.viewfinder")
                }.buttonStyle(TravelButtonStyle()).accessibilityIdentifier("open-ar-home")
                Text("Scan your surroundings in 3D or test the journey camera.").font(.subheadline).foregroundStyle(.secondary)
            }
            Text(language.text(.whereTo)).font(.largeTitle.weight(.heavy)).foregroundStyle(.primary)
            SearchInput(text: $destinationQuery, prompt: language.text(.searchPrompt), focused: $destinationFocused)
                .accessibilityIdentifier("choose-destination")
            if destinationFocused || !destinationQuery.isEmpty {
                Button(language.text(.cancel)) { destinationQuery = ""; destinationFocused = false }.frame(minHeight: 44)
                PlaceSearchResults(store: store, query: destinationQuery) { place in
                    store.destination = place; destinationQuery = ""; destinationFocused = false
                }
            } else {
                if let destination = store.destination {
                    Button { destinationQuery = destination.name; destinationFocused = true } label: {
                        Label(destination.name, systemImage: "flag.checkered").font(.headline).frame(minHeight: 44)
                    }.foregroundStyle(.primary)
                }
                Button { sheet = .origin } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "circle.circle.fill").foregroundStyle(Color.rightSideTeal)
                        Text(store.origin.map { language.text(.from, $0.name) } ?? language.text(.chooseStart)).font(.headline).foregroundStyle(.primary)
                        Spacer(); Image(systemName: "chevron.right").foregroundStyle(.secondary)
                    }.frame(minHeight: 48).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityIdentifier("choose-origin")
                if store.origin == nil {
                    CurrentLocationChoice(controller: store.locationController, language: language, requested: requestedHomeLocation) {
                        requestedHomeLocation = true; store.requestLocation()
                    }
                }
                HStack {
                    Button { sheet = .time } label: {
                        Label(leavingNow ? language.text(.leaveNow) : language.text(store.arriveBy ? .arriveTime : .departTime, journeyTime(WireClock.string(store.departure))), systemImage: "clock")
                            .frame(minHeight: 44)
                    }.font(.subheadline.bold()).accessibilityIdentifier("departure-settings")
                    Spacer()
                    Button { let from = store.origin; store.origin = store.destination; store.destination = from } label: {
                        Image(systemName: "arrow.up.arrow.down").frame(width: 44, height: 44)
                    }.disabled(store.origin == nil || store.destination == nil).accessibilityLabel(language.text(.swap))
                }
                if store.destination != nil {
                    Button { Task { if leavingNow { store.departure = Date(); store.arriveBy = false }; await store.search(); showDetails = false; editingJourney = false } } label: {
                        Label(language.text(.findJourneys), systemImage: "arrow.right")
                    }.buttonStyle(TravelButtonStyle())
                        .disabled(store.busy || store.origin == nil).accessibilityIdentifier("search-journeys")
                }
            }
        }
    }
    private func placeLabel(_ label: String, value: String?, icon: String) -> some View {
        HStack {
            Image(systemName: icon).frame(width: 24)
            VStack(alignment: .leading, spacing: 3) { Text(label.uppercased()).font(.caption).foregroundStyle(.secondary); Text(value ?? language.text(.address)).foregroundStyle(.primary).multilineTextAlignment(.leading) }
            Spacer(); Image(systemName: "chevron.right").font(.caption)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private var alternatives: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !store.alternatives.isEmpty {
                ForEach(store.alternatives) { option in
                    Button { store.select(option); showDetails = true } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 5) {
                                Text("\(journeyTime(option.legs.first?.plannedStart)) → \(journeyTime(option.legs.last?.plannedEnd))").font(.headline)
                                ViewThatFits(in: .horizontal) {
                                    HStack(spacing: 6) { ForEach(option.legs.filter { $0.kind == "ride" }) { RouteBadge(line: $0.line ?? language.text(.transit), mode: $0.mode) } }
                                    VStack(alignment: .leading) { ForEach(option.legs.filter { $0.kind == "ride" }) { RouteBadge(line: $0.line ?? language.text(.transit), mode: $0.mode) } }
                                }
                                let changes = max(0, option.legs.filter { $0.kind == "ride" }.count - 1)
                                Text(changes == 0 ? language.text(.direct) : changes == 1 ? language.text(.oneChange) : language.text(.changes, String(changes))).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text("\(Int(option.durationSeconds / 60)) min").font(.title2.weight(.heavy)).monospacedDigit()
                            if journey?.id == option.id { Image(systemName: "checkmark.circle.fill") }
                        }.padding().background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
                        .overlay(RoundedRectangle(cornerRadius: 20).stroke(journey?.id == option.id ? Color.rightSideTeal : Color.clear, lineWidth: 2))
                    }.buttonStyle(.plain).accessibilityIdentifier("journey-option-\(option.id)")
                }
            }
        }
    }
    private func nextAction(_ journey: Journey) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(active == nil ? language.text(.overview) : active?.phase == "arrived" ? language.text(.arrivalConfirmed) : language.text(.step, String((active?.legIndex ?? 0) + 1), String(journey.legs.count))).font(.caption.bold())
            if let ride { RouteBadge(line: ride.line ?? language.text(.transit), mode: ride.mode) }
            Text(nextTitle).font(.title.weight(.heavy)).accessibilityIdentifier("journey-next-title")
            Text(guidance.instruction).font(.body).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("journey-instruction")
            if active == nil {
                Text("\(journeyTime(journey.legs.first?.plannedStart)) → \(journeyTime(journey.legs.last?.plannedEnd)) · \(Int(journey.durationSeconds / 60)) min").font(.subheadline)
            } else if let leg, leg.kind == "ride" {
                if !["riding", "alighting"].contains(active?.phase ?? "") {
                    let serviceTime = ServiceTimeAssessment.forLeg(leg, offline: active?.overlays.offline == true, now: Date())
                    Text("\(journeyTime(serviceTime.instant)) · \(serviceTime.basis.rawValue.capitalized) · \(leg.boardingTarget?.assignment.label.map { language.text(.platformValue, $0) } ?? language.text(.checkDepartures))").font(.subheadline)
                    if leg.boardingUnavailable { Text(language.text(.unavailable)).font(.subheadline.bold()) }
                    else if active?.serviceMatch?.status == "conflicting" { Text(language.text(.conflicting)).font(.subheadline.bold()) }
                    else if leg.boardingTarget?.pedestrianTargetStatus != "verified_area" { Text(language.text(.waitingUnverified)).font(.caption) }
                }
            } else if let detail = walking.displayedSnapshot(for: journey, leg: leg) {
                Text(language.text(.walkMinutes, String(Int(ceil(detail.expectedSeconds / 60))))).font(.subheadline)
            } else if !simulated && active?.phase != "arrived" {
                Text(walking.status == nil ? language.text(.followSigns) : language.text(.walkUnavailable)).font(.caption)
            }
            if active?.overlays.replanning == true || active?.overlays.disrupted == true { Text(language.text(.replanWarning)).font(.subheadline.bold()) }
            Button(actionTitle) { performAction(journey) }
                .buttonStyle(TravelButtonStyle())
                .disabled((active?.phase == "waiting" && (active?.overlays.replanning == true || active?.overlays.disrupted == true || leg?.boardingUnavailable == true || active?.serviceMatch?.status == "conflicting")) || (active?.phase == "arrived" && !store.canReturn))
                .accessibilityIdentifier("primary-journey-action")
        }.frame(maxWidth: .infinity, alignment: .leading).padding(20).foregroundStyle(.primary).background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 22))
    }
    private var guidance: JourneyGuidance {
        JourneyGuidance(language: language, phase: JourneyGuidancePhase(active?.phase),
            stop: leg?.from.name ?? language.text(.stopFallback),
            destination: active == nil ? journey?.destination.name ?? language.text(.nextDestination) : leg?.to.name ?? language.text(.stopFallback),
            line: ride?.line ?? language.text(.serviceFallback),
            headsign: ride?.headsign ?? language.text(.destinationFallback), canReturn: store.canReturn)
    }
    private var nextTitle: String { guidance.title }
    private var actionTitle: String { guidance.action }
    private func performAction(_ journey: Journey) {
        if guidance.phase == .unknown { sheet = .details; return }
        guard let active else { store.start(journey); editingJourney = false; showDetails = false; updateTracking(); return }
        if active.phase == "arrived" {
            if store.isDemo { Task { await store.returnJourney() } }
            else { store.prepareReturn(); sheet = .planning }
            return
        }
        if leg?.kind != "ride" { store.confirm("arrived") }
        else if ["riding", "alighting"].contains(active.phase) { store.confirm("alighted") }
        else { store.confirm(active.phase == "waiting" ? "boarded" : "at_waiting_area") }
    }
    private func boarding(_ leg: Leg) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(["riding", "alighting"].contains(active?.phase ?? "") ? language.text(.yourService) : language.text(.beforeBoarding)).font(.headline)
            Text("\(leg.line ?? language.text(.unknownLine)) · \(leg.headsign ?? language.text(.unknownDestination))").font(.subheadline.bold())
            let summary = BoardingSummary(leg)
            LabeledContent(language.text(.platform), value: summary.sign ?? language.text(.notProvided))
            if summary.changed { Label("Platform changed: \(summary.plannedSign ?? "?") → \(summary.sign ?? "?")", systemImage: "exclamationmark.triangle.fill").foregroundStyle(Color.rightSideWarning) }
            if let nextStop = summary.nextStop { LabeledContent("Next stop", value: nextStop) }
            LabeledContent("Level", value: summary.level ?? "Unknown")
            Text(summary.precision).font(.caption).foregroundStyle(.secondary)
            if let age = journey.map({ SourceSnapshotAge($0, offline: active?.overlays.offline == true, now: Date()) }), let date = age.observedAt {
                Text("Source snapshot: \(date.formatted(date: .abbreviated, time: .shortened)) · \(age.freshPrediction ? "recent snapshot" : "check current departure board")").font(.caption)
            }
            LabeledContent(language.text(.waitingArea), value: leg.boardingTarget?.pedestrianTargetStatus == "verified_area" ? language.text(.verifiedArea) : language.text(.notVerified))
            LabeledContent(language.text(.stepFreeAccess), value: leg.accessibility == "yes" ? language.text(.reportedAvailable) : leg.accessibility == "no" ? language.text(.notStepFree) : language.text(.unknown))
            if leg.boardingUnavailable { JourneyNotice(text: language.text(.boardingUnavailable), warning: true) }
            Text(language.text(.stopReference)).font(.caption).foregroundStyle(.secondary)
            if let match = active?.serviceMatch {
                Text(match.status == "matching" ? language.text(.matching) : match.status == "conflicting" ? language.text(.conflicting) : language.text(.vehicleUnknown)).font(.subheadline.bold())
            }
        }.padding().background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
    }
    private func timeline(_ journey: Journey) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(language.text(.wholeJourney)).font(.title3.bold())
            ForEach(Array(journey.legs.enumerated()), id: \.element.id) { index, leg in
                VStack(alignment: .leading, spacing: 8) {
                    HStack { Image(systemName: legSymbol(leg)); Text(leg.kind == "ride" ? "\(leg.line ?? language.text(.transit)) · \(leg.headsign ?? language.text(.checkDestination))" : leg.kind == "transfer" ? language.text(.walkConnection) : language.text(.walk)).font(.headline); Spacer(); Text(journeyTime(leg.plannedStart)).font(.subheadline.monospacedDigit()) }
                    Text("\(leg.from.name) → \(leg.to.name)").font(.subheadline)
                    if leg.kind != "ride" && leg.geometry == nil { Text(language.text(.pathUnverified)).font(.caption).foregroundStyle(.secondary) }
                    let serviceTime = ServiceTimeAssessment.forLeg(leg, offline: active?.overlays.offline == true, now: Date())
                    if serviceTime.basis == .prediction { Text(language.text(.predicted, journeyTime(serviceTime.instant))).font(.caption) }
                    Button("Show this leg on map") { inspectedLegID = leg.id; sheet = nil }.font(.caption).accessibilityIdentifier("inspect-leg-\(index)")
                    if let transfer = transferAssessment(before: index) {
                        Text("Transfer: \(transfer.status.rawValue)" + (transfer.availableSeconds.map { " · \(Int($0 / 60)) min between services" } ?? "")).font(.caption.bold())
                        Text(transfer.explanation).font(.caption).foregroundStyle(.secondary)
                    }
                    if active != nil { Button(language.text(.updateProgress)) { correction = leg }.font(.caption) }
                }.padding().frame(maxWidth: .infinity, alignment: .leading)
                    .background(active?.legIndex == index ? Color.rightSideTeal.opacity(0.1) : Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
            }
        }.accessibilityIdentifier("journey-timeline")
    }
    private func correctionButton(_ title: String, phase: String, leg: Leg) -> some View {
        Button(title) { store.correct(legId: leg.id, phase: phase, reason: "Passenger explicitly corrected progress in native guidance."); correction = nil }
    }
    private var spatialRequest: SpatialRequest? {
        guard let ride, let source = ride.from.raw["sourceRefs"].array.first(where: { $0["provider"].string == "transport.opendata.ch" }), let id = source["id"].string else { return nil }
        // The community planner has no authoritative occurrence assignment/hash.
        // Parent + sign narrows candidates only; no fabricated call identity.
        return SpatialRequest(stopID: id, signLabel: ride.boardingTarget?.assignment.label, boardingAt: WireClock.date(ride.plannedStart))
    }
    private var spatialResolution: SpatialResolution? {
        guard let spatialRequest else { return nil }
        return spatialRepository?.resolve(request: spatialRequest, at: Date())
    }
    private var recoveryActions: some View {
        Menu {
            ForEach(JourneyRecoveryReason.allCases) { reason in
                Button(reason.title) { store.prepareRecovery(reason); sheet = .planning }
            }
            Button("Correct my current step") { sheet = .details }
        } label: { Label("Recover or change route", systemImage: "arrow.triangle.branch").frame(maxWidth: .infinity) }
        .buttonStyle(.bordered).accessibilityIdentifier("recover-journey")
    }
    private func legSelector(_ journey: Journey) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack {
                ForEach(Array(journey.legs.enumerated()), id: \.element.id) { index, leg in
                    Button { inspectedLegID = leg.id } label: {
                        Label("\(index + 1) · \(leg.line ?? (leg.kind == "transfer" ? "Transfer" : "Walk"))", systemImage: legSymbol(leg))
                    }.buttonStyle(.bordered).tint(mapLeg?.id == leg.id ? .rightSideTeal : .secondary)
                        .accessibilityIdentifier("map-leg-\(index)")
                }
            }
        }.accessibilityIdentifier("map-leg-selector")
    }
    private func transferAssessment(before index: Int) -> TransferAssessment? {
        guard let journey, journey.legs.indices.contains(index), journey.legs[index].kind == "ride",
              let previous = journey.legs[..<index].lastIndex(where: { $0.kind == "ride" }) else { return nil }
        let walks = journey.legs[(previous + 1)..<index]
        // A timetable gap is available transfer time, NOT a walking duration.
        let seconds = walks.count == 1 ? walking.displayedSnapshot(for: journey, leg: walks.first)?.expectedSeconds : nil
        return TransferAssessment.assess(incoming: journey.legs[previous], outgoing: journey.legs[index], walkingSeconds: seconds,
            offline: active?.overlays.offline == true, now: Date())
    }
    private var languageChoices: some View {
        ForEach(JourneyLanguage.allCases) { choice in
            Button {
                languageCode = choice.rawValue
            } label: {
                HStack {
                    Text(choice.nativeName)
                    Spacer()
                    if choice == language { Image(systemName: "checkmark") }
                }
            }.accessibilityIdentifier("language-" + choice.rawValue)
                .accessibilityAddTraits(choice == language ? [.isSelected] : [])
        }
    }
    private var languageSettings: some View {
        NavigationStack {
            Form {
                Section(language.text(.language)) { languageChoices }
                Text(language.text(.languageHelp))
                Text(language.text(.translationScope)).font(.caption)
            }
            .navigationTitle(language.text(.language)).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) {
                Button(language.text(.done)) { sheet = nil }.accessibilityIdentifier("close-panel")
            } }
        }
    }
    private var settings: some View {
        NavigationStack {
            Form {
                Section(language.text(.language)) {
                    languageChoices
                    Text(language.text(.languageHelp)).font(.caption)
                    Text(language.text(.translationScope)).font(.caption)
                }
                Section(language.text(.preferences)) {
                    Picker(language.service("Planning source"), selection: $store.planningSource) {
                        Text(language.service("Community planner")).tag(JourneyPlanningSource.communityJSON)
                        Text(language.service("OJP with service information")).tag(JourneyPlanningSource.occurrenceOJP)
                    }.accessibilityIdentifier("planning-source")
                    Toggle(language.text(.preferStepFree), isOn: $store.stepFree)
                    Text(language.text(.accessCaution)).font(.caption)
                }
                Section(language.text(.savedRecovery)) {
                    Toggle(language.text(.useOffline), isOn: Binding(get: { store.navigation?.overlays.offline ?? false }, set: { store.setOffline($0) })).disabled(store.navigation == nil).accessibilityIdentifier("use-offline-guidance")
                    Button(language.text(.openSaved)) { store.restore(); sheet = nil }.accessibilityIdentifier("open-saved-journey")
                    Text(language.text(.savedCaution)).font(.caption)
                }
                Section("Timetable reminders") {
                    Toggle("Remind me about the next service or stop", isOn: Binding(get: { reminders.enabled }, set: { value in
                        Task { await reminders.setEnabled(value, navigation: store.isDemo ? nil : store.navigation, session: store.navigationSessionID) }
                    })).disabled(store.navigation == nil || store.isDemo)
                    Text("Optional local notifications continue when the app is backgrounded. They use scheduled times, do not know where you are, and do not confirm arrival. Background location tracking is off.").font(.caption)
                    if let status = reminders.status { Text(status).font(.caption) }
                }
                Section(language.text(.currentLocation)) {
                    Text(language.text(.locationHelp)).font(.caption)
                    Text(language.text(.translationScope)).font(.caption)
                    LocationStatusView(controller: store.locationController)
                }
                Section(language.text(.about)) {
                    Text(language.text(.attribution))
                    Text(language.text(.cameraCaution)).font(.caption)
                    Link(language.text(.source), destination: URL(string: "https://transport.opendata.ch")!)
                }
            }.navigationTitle(language.text(.settings)).toolbar { ToolbarItem(placement: .confirmationAction) { Button(language.text(.done)) { sheet = nil }.accessibilityIdentifier("close-panel") } }
        }
    }
}
