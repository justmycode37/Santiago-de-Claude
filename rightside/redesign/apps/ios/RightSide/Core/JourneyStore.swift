import Foundation
import Combine

@MainActor public final class JourneyStore: NSObject, ObservableObject {
    @Published public private(set) var selected: Journey?
    @Published public private(set) var navigation: NavigationSnapshot?
    @Published public private(set) var navigationSessionID = UUID()
    @Published public private(set) var alternatives: [Journey] = []
    @Published public var origin: Place?
    @Published public var destination: Place?
    @Published public var departure = Date()
    @Published public var arriveBy = false
    @Published public var stepFree = false
    @Published public var planningSource: JourneyPlanningSource = .communityJSON
    @Published public private(set) var updatingServices = false
    @Published public private(set) var serviceUpdateError: String?
    @Published public private(set) var serviceFailureAt: Date?
    public var serviceReport: OJPServiceReport? {
        guard let navigation, let report = OJPServiceReport.decode(navigation.raw["ojpServiceReport"]), report.journeyID == navigation.journey.id else { return nil }
        return report
    }
    public var supportsServiceUpdates: Bool { navigation.map { (try? OJPServiceUpdate.occurrences(in: $0.journey)) != nil } ?? false }
    /// This only admits provider context to the independent camera evidence gate.
    /// It never establishes a vehicle match or passenger position.
    public func boardingServiceEligible(for ride: Leg?, at now: Date = Date()) -> Bool {
        guard let navigation, !previewing, !isDemo, !navigation.overlays.offline,
              !navigation.overlays.disrupted, !navigation.overlays.replanning,
              let ride, navigation.journey.legs.contains(ride), !ride.boardingUnavailable else { return false }
        guard OJPOccurrence.from(ride) != nil else { return true }
        let raw = ride.raw["ojpSource"]
        guard raw["provider"].string == OJPIdentity.provider,
              let acquired = try? OJPIdentity.date(raw["acquiredAt"].string),
              let response = try? OJPIdentity.date(raw["responseTimestamp"].string),
              let sha = raw["sha256"].string, sha.count == 64 else { return false }
        return OJPSource(acquiredAt: acquired, responseTimestamp: response, httpDate: nil, sha256: sha).recent(at: now)
    }
    @Published public private(set) var busy = false
    @Published public private(set) var error: String?
    @Published public private(set) var notice: String?
    @Published public private(set) var isDemo = false
    @Published public private(set) var previewing = false
    @Published public private(set) var placeResults: [Place] = []
    @Published public private(set) var placeError: String?
    @Published public private(set) var locationPlace: Place?
    @Published public var planningDraft: JourneyPlanningDraft? { didSet { savePlanningDraft() } }

    private var bridge: DomainBridge?
    private var cache: JourneyCache?
    private let transport: any TransitTransport
    private let ojpTransport: any OJPTransport
    private var serviceTask: Task<[OJPServiceSnapshot], Error>?
    private var serviceGeneration = UUID()
    let locationController = LocationController()
    private var locationJourneyID: String?
    private var locationContextStartedAt = Date.distantPast
    private var locationOrigin: Place?
    private var locationForPlanning = false
    private var manualDemoProgress = false
    private var fixture: JSONValue?
    private var replay: JSONValue?
    private var searchTask: Task<JSONValue, Error>?
    private var placeTask: Task<JSONValue, Error>?
    private var searchGeneration = UUID()
    private var placeGeneration = UUID()
    private var returnPreview = false
    private var subscriptions = Set<AnyCancellable>()

    public var currentLeg: Leg? { navigation?.currentLeg }
    public var canReturn: Bool { navigation?.phase == "arrived" && replay?["direction"].string != "return" }
    public var canStepScenario: Bool { replay != nil && !manualDemoProgress }

    public override convenience init() { self.init(cacheURL: nil) }
    public init(cacheURL: URL?, transport: any TransitTransport = CommunityTransport(), ojpTransport: any OJPTransport = PublicOJPTransport()) {
        let initializationStart = ProcessInfo.processInfo.systemUptime
        defer { NativePerformance.record("journeyStoreInitializationMs", since: initializationStart) }
        self.transport = transport; self.ojpTransport = ojpTransport
        super.init()
        locationController.$positionJSONData.compactMap { $0 }.sink { [weak self] data in
            // Main-actor @Published emissions are synchronous: consume the fix before
            // isRequesting becomes false and clears the request's planning context.
            MainActor.assumeIsolated { self?.acceptLocation(data) }
        }.store(in: &subscriptions)
        locationController.$isRequesting.removeDuplicates().filter { !$0 }.sink { [weak self] _ in
            MainActor.assumeIsolated {
                self?.locationForPlanning = false; self?.locationJourneyID = nil
            }
        }.store(in: &subscriptions)
        do { bridge = try DomainBridge(); cache = try JourneyCache(url: cacheURL); loadPlanningDraft() }
        catch { self.error = error.localizedDescription }
    }

    private func requireBridge() throws -> DomainBridge {
        guard let bridge else { throw NativeCoreError.message("The shared domain engine is unavailable.") }
        return bridge
    }
    private var now: String {
        if isDemo, let navigation { return navigation.now }
        return WireClock.string(max(Date(), navigation.flatMap { WireClock.date($0.now) } ?? .distantPast))
    }
    private func publish(_ value: JSONValue, persist: Bool = true) {
        navigation = NavigationSnapshot(raw: value)
        if !previewing, selected != navigation?.journey { selected = navigation?.journey }
        if replay != nil { replay?["navigation"] = value }
        if persist { save() }
    }
    private func save() {
        guard let bridge, let cache, let navigation else { return }
        do { try cache.save(navigation: navigation.raw, replay: replay, bridge: bridge) }
        catch { self.error = "Guidance is active, but saving failed: \(error.localizedDescription)" }
    }
    private func command(_ method: String, _ fields: [String: JSONValue] = [:], persist: Bool = true) {
        guard let navigation else { return }
        do {
            var payload = fields; payload["state"] = navigation.raw; payload["now"] = .string(now)
            let value = try requireBridge().call(method, .object(payload))
            if method != "tick" { error = nil }
            publish(value, persist: persist)
        } catch { self.error = error.localizedDescription }
    }

    public func searchPlaces(_ query: String) async -> [Place] {
        placeTask?.cancel()
        let generation = UUID(); placeGeneration = generation
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard query.count >= 2 else { placeResults = []; return [] }
        let task = Task { try await transport.places(String(query.prefix(200))) }
        placeTask = task
        do {
            let raw = try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
            guard generation == placeGeneration, !Task.isCancelled else { return [] }
            let result = try requireBridge().call("normalizePlaces", .object(["raw": raw, "fetchedAt": .string(WireClock.string())]))
            placeResults = result.array.map(Place.init(raw:)); placeError = nil
            return placeResults
        } catch {
            if generation == placeGeneration, !task.isCancelled, !Task.isCancelled { self.placeError = error.localizedDescription; placeResults = [] }
            return []
        }
    }

    public func search() async {
        returnPreview = false
        await performSearch()
    }
    /// A departure board supplies an origin, never an exact-trip refresh or navigation mutation.
    public func planFromStop(_ stop: Place, to destination: Place, departure: Date, arriveBy: Bool = false) async {
        // A rejected replacement intent must not leave a previous alternative startable.
        // Invalidate pending work before validation, while preserving passenger state/cache.
        cancelServiceUpdates(); cancelSearch(); returnPreview = false; previewing = false
        alternatives = []; selected = navigation?.journey; notice = nil
        do {
            guard DepartureStop.id(for: stop) != nil, departure.timeIntervalSince1970.isFinite else {
                throw NativeCoreError.message("Select an identified transit stop and a valid planning time.")
            }
            let bridge = try requireBridge()
            let checkedOrigin = Place(raw: try bridge.call("validatePlace", .object(["place": stop.raw])))
            let checkedDestination = Place(raw: try bridge.call("validatePlace", .object(["place": destination.raw])))
            origin = checkedOrigin; self.destination = checkedDestination
            self.departure = departure; self.arriveBy = arriveBy
            await search()
        } catch { cancelSearch(); self.error = error.localizedDescription }
    }
    private func performSearch() async {
        cancelServiceUpdates()
        // Even an invalid replacement request supersedes pending work. Clear the old
        // preview before awaiting so cancellation cannot leave an orphaned selection.
        cancelSearch()
        alternatives = []; previewing = false; selected = navigation?.journey
        guard let origin, let destination else {
            returnPreview = false
            error = "Select an origin and destination from the place suggestions."; return
        }
        let generation = UUID(); searchGeneration = generation
        let departure = self.departure, arriveBy = self.arriveBy
        let request = JSONValue.object(["schemaVersion": .number(1), "origin": origin.raw, "destination": destination.raw,
            "time": .string(WireClock.string(departure)), "timeMode": .string(arriveBy ? "arrive_by" : "depart_at"),
            "preferences": .object(["stepFree": .bool(stepFree), "maxWalkMeters": .null, "language": .string(JourneyLanguage.selected.rawValue)])])
        busy = true; error = nil; alternatives = []
        let source = planningSource
        let task = Task { () throws -> JSONValue in
            if source == .occurrenceOJP {
                let xml = try OJPRequest.plan(origin: origin, destination: destination, departure: departure, arriveBy: arriveBy)
                let response = try await ojpTransport.send(xml)
                try Task.checkCancellation()
                let journeys = try OJPJourneyAdapter.journeys(response, origin: origin, destination: destination, departure: departure,
                    arriveBy: arriveBy, preferences: request["preferences"])
                return .object(["journeys": .array(journeys.map(\.raw)), "warnings": .array([])])
            }
            return try await transport.connections(origin: origin, destination: destination, departure: departure, arriveBy: arriveBy)
        }
        searchTask = task
        do {
            let raw = try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
            guard generation == searchGeneration else { return }
            if Task.isCancelled { busy = false; searchTask = nil; return }
            let result: JSONValue
            if source == .occurrenceOJP {
                let bridge = try requireBridge()
                let checked = try raw["journeys"].array.map { try bridge.call("validateJourney", .object(["journey": $0])) }
                result = .object(["journeys": .array(checked), "warnings": raw["warnings"]])
            } else {
                result = try requireBridge().call("normalizeConnections", .object(["raw": raw, "request": request, "fetchedAt": .string(WireClock.string())]))
            }
            alternatives = result["journeys"].array.map(Journey.init(raw:))
            selected = alternatives.first ?? navigation?.journey
            previewing = !alternatives.isEmpty
            if alternatives.isEmpty { returnPreview = false }
            notice = alternatives.isEmpty ? "No validated itineraries returned. Current guidance is preserved." : "Choose an itinerary and start it to replace current guidance. " + result["warnings"].strings.joined(separator: " ")
        } catch {
            if generation == searchGeneration, !task.isCancelled, !Task.isCancelled {
                self.error = error.localizedDescription
                returnPreview = false; previewing = false; selected = navigation?.journey
            }
        }
        if generation == searchGeneration { busy = false; searchTask = nil }
    }
    public func cancelSearch() {
        searchTask?.cancel(); searchTask = nil; searchGeneration = UUID(); busy = false
    }
    public func select(_ journey: Journey) {
        cancelServiceUpdates()
        do {
            selected = Journey(raw: try requireBridge().call("validateJourney", .object(["journey": journey.raw])))
            previewing = true
        } catch { self.error = error.localizedDescription }
    }
    public func start(_ journey: Journey) {
        do {
            let bridge = try requireBridge()
            let checked = try bridge.call("validateJourney", .object(["journey": journey.raw]))
            let demo = fixture?["journey"]["id"].string == journey.id
            let next: JSONValue
            var nextReplay: JSONValue?
            if demo, let fixture {
                nextReplay = try bridge.call("createReplay", .object(["fixture": fixture]))
                next = nextReplay!["navigation"]
            } else {
                // Explicitly starting a new itinerary resets clock, history and offline state.
                // Previewing alternatives never changes the existing guidance.
                next = try bridge.call("create", .object(["journey": checked, "now": .string(WireClock.string())]))
            }
            resetJourneyContext(); planningDraft = nil
            previewing = false; isDemo = demo; replay = nextReplay; returnPreview = false
            alternatives = []; manualDemoProgress = false
            error = nil; notice = demo ? "Simulated Bern scenario. Times, geometry, platforms and events are invented." : "Live source itinerary. Walking paths, waiting areas and exact trip refresh are unverified."
            publish(next)
            planningSource = supportsServiceUpdates ? .occurrenceOJP : .communityJSON
            origin = navigation?.journey.origin; destination = navigation?.journey.destination
            navigationSessionID = UUID()
        } catch { self.error = error.localizedDescription }
    }
    public func loadDemo() {
        cancelServiceUpdates()
        do {
            fixture = try requireBridge().fixture()
            let journey = Journey(raw: fixture!["journey"])
            cancelSearch(); returnPreview = false; origin = journey.origin; destination = journey.destination
            alternatives = [journey]; selected = journey; previewing = true
            notice = "Simulated Bern demo loaded. Start it to begin the labelled scenario."
        } catch { self.error = error.localizedDescription }
    }
    public func confirm(_ action: String) { manualProgress(); command("confirm", ["action": .string(action)]) }
    private func manualProgress() {
        if isDemo { manualDemoProgress = true; notice = "Manual simulated journey. Reload the demo to use scripted events." }
    }
    public func prepareAlighting() { manualProgress(); command("prepareAlighting") }
    public func correct(legId: String, phase: String, reason: String) {
        guard let navigation else { return }
        manualProgress()
        command("correct", ["correction": .object(["legId": .string(legId), "phase": .string(phase), "reason": .string(reason), "revision": .number(Double(navigation.journey.revision))])])
    }
    public func nextScenario() {
        guard canStepScenario, let replay else { return }
        do {
            let next = try requireBridge().call("nextReplay", .object(["replay": replay]))
            self.replay = next; error = nil; publish(next["navigation"])
        } catch { self.error = error.localizedDescription }
    }
    public func returnJourney() async {
        guard canReturn, let navigation else { error = "Complete the current journey before starting a return."; return }
        if let replay {
            do {
                let next = try requireBridge().call("returnReplay", .object(["replay": replay]))
                resetJourneyContext(); planningDraft = nil
                self.replay = next; previewing = false; returnPreview = false; alternatives = []; error = nil
                publish(next["navigation"])
                origin = self.navigation?.journey.origin; destination = self.navigation?.journey.destination
                navigationSessionID = UUID()
            } catch { self.error = error.localizedDescription }
        } else {
            origin = navigation.journey.destination; destination = navigation.journey.origin
            departure = Date(); arriveBy = false; returnPreview = true
            await performSearch()
        }
    }
    public func prepareReturn() {
        cancelServiceUpdates()
        guard canReturn, let navigation, !isDemo else { return }
        cancelSearch()
        planningDraft = JourneyPlanningDraft(kind: .returnTrip, journeyID: navigation.journey.id,
            origin: navigation.journey.destination, destination: navigation.journey.origin,
            departure: Date(), arriveBy: false, reason: nil, createdAt: Date())
    }
    public func prepareRecovery(_ reason: JourneyRecoveryReason) {
        cancelServiceUpdates()
        guard let navigation else { return }
        cancelSearch()
        planningDraft = JourneyPlanningDraft(kind: .recovery, journeyID: navigation.journey.id,
            origin: navigation.currentLeg.from, destination: navigation.journey.destination,
            departure: Date(), arriveBy: false, reason: reason, createdAt: Date())
    }
    public func searchPlanningDraft() async {
        guard let draft = planningDraft, draft.journeyID == navigation?.journey.id else { return }
        origin = draft.origin; destination = draft.destination; departure = draft.departure; arriveBy = draft.arriveBy
        returnPreview = draft.kind == .returnTrip
        await performSearch()
    }
    private var planningDraftURL: URL? { cache?.url.appendingPathExtension("planning.json") }
    private func savePlanningDraft() {
        guard let url = planningDraftURL else { return }
        guard let planningDraft else { try? FileManager.default.removeItem(at: url); return }
        do { try JSONEncoder().encode(planningDraft).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) }
        catch { self.error = "Could not save the planning request: \(error.localizedDescription)" }
    }
    private func loadPlanningDraft() {
        guard let url = planningDraftURL, let data = try? Data(contentsOf: url), data.count <= 100_000,
              let draft = try? JSONDecoder().decode(JourneyPlanningDraft.self, from: data),
              draft.departure.timeIntervalSince1970.isFinite, draft.createdAt.timeIntervalSince1970.isFinite,
              let bridge, (try? bridge.call("validatePlace", .object(["place": draft.origin.raw]))) != nil,
              (try? bridge.call("validatePlace", .object(["place": draft.destination.raw]))) != nil else { return }
        planningDraft = draft
    }
    public func replan(from currentPlace: Place) async {
        guard let navigation else { error = "Start a journey before replanning."; return }
        do {
            origin = Place(raw: try requireBridge().call("validatePlace", .object(["place": currentPlace.raw])))
            destination = navigation.journey.destination; departure = Date(); arriveBy = false; returnPreview = false
            await performSearch()
        } catch { self.error = error.localizedDescription }
    }
    public func resume() {
        guard let navigation else { return }
        cancelSearch(); previewing = false; selected = navigation.journey; returnPreview = false; alternatives = []
        notice = "Resumed current journey."; tick()
    }
    public func restore() {
        do {
            let bridge = try requireBridge()
            guard let saved = try cache?.load(bridge: bridge) else { notice = "No saved journey is available."; return }
            var restored = saved.navigation
            if saved.replay == nil {
                let instant = WireClock.string(max(Date(), WireClock.date(restored["now"].string ?? "") ?? .distantPast))
                restored = try bridge.call("connectivity", .object(["state": restored, "online": .bool(false), "now": .string(instant)]))
            }
            resetJourneyContext()
            replay = saved.replay; isDemo = replay != nil; previewing = false; returnPreview = false
            fixture = replay?["fixture"]; alternatives = []; manualDemoProgress = isDemo; error = nil; publish(restored)
            planningSource = supportsServiceUpdates ? .occurrenceOJP : .communityJSON
            origin = navigation?.journey.origin; destination = navigation?.journey.destination
            if planningDraft?.journeyID != navigation?.journey.id { planningDraft = nil }
            navigationSessionID = UUID()
            notice = isDemo ? "Restored simulated scenario at its saved clock." : "Restored saved guidance offline. Original evidence ages are preserved; search again for current options."
        } catch { self.error = "Could not restore the saved journey: \(error.localizedDescription)" }
    }
    // Called only after the replacement state has validated successfully. A journey
    // ID can be reused on restart/restore, so a timestamp boundary also isolates fixes.
    private func resetJourneyContext() {
        cancelServiceUpdates(); serviceUpdateError = nil; serviceFailureAt = nil
        cancelSearch(); stopLocation()
        locationContextStartedAt = Date(); locationPlace = nil
        placeTask?.cancel(); placeTask = nil; placeGeneration = UUID()
        placeResults = []; placeError = nil
    }
    public func setOffline(_ offline: Bool) { if offline { cancelServiceUpdates() }; command("connectivity", ["online": .bool(!offline)]) }
    public func tick() { if !isDemo { command("tick", persist: false) } }
    public func refresh() { notice = "Exact trip refresh is unavailable: the community source has no authoritative trip occurrence ID. Replan from an explicitly selected current place." }
    public func cancelServiceUpdates() {
        serviceGeneration = UUID(); serviceTask?.cancel(); serviceTask = nil; updatingServices = false
    }
    /// Transactionally inspect every provider-compatible ride; never join an old JSON trip by labels.
    public func updateServices() async {
        cancelServiceUpdates(); serviceUpdateError = nil; serviceFailureAt = nil
        guard let original = navigation, !isDemo, !original.overlays.offline, !previewing else {
            serviceUpdateError = "Resume an online active journey to request service updates."; serviceFailureAt = Date(); return
        }
        let token = serviceGeneration, session = navigationSessionID
        do {
            let occurrences = try OJPServiceUpdate.occurrences(in: original.journey), transport = ojpTransport
            updatingServices = true
            defer { if token == serviceGeneration { updatingServices = false; serviceTask = nil } }
            let work = Task { () throws -> [OJPServiceSnapshot] in
                var snapshots: [OJPServiceSnapshot] = []
                for occurrence in occurrences {
                    try Task.checkCancellation()
                    let response = try await transport.send(OJPRequest.service(occurrence))
                    try Task.checkCancellation()
                    snapshots.append(try OJPDecoder.service(data: response.data, occurrence: occurrence,
                        acquiredAt: response.acquiredAt, httpDate: response.httpDate))
                }
                return snapshots
            }
            serviceTask = work
            let snapshots = try await withTaskCancellationHandler(operation: { try await work.value }, onCancel: { work.cancel() })
            guard token == serviceGeneration, session == navigationSessionID, !Task.isCancelled, !work.isCancelled,
                  let current = navigation, current.journey == original.journey, !current.overlays.offline, !previewing else { return }
            guard current.legIndex == original.legIndex, current.phase == original.phase,
                  current.raw["confirmations"] == original.raw["confirmations"] else {
                throw OJPError.unavailable("Your journey step changed during the request. Current guidance is preserved; request the service update again.")
            }
            let update = try OJPServiceUpdate.reconcile(journey: current.journey, snapshots: snapshots, now: Date())
            let bridge = try requireBridge()
            var next: JSONValue
            if let replacement = update.journey {
                next = try bridge.call("refresh", .object(["state": current.raw, "journey": replacement.raw, "now": .string(now)]))
                guard next["journey"]["revision"].double == Double(replacement.revision) else { throw OJPError.invalid("Domain refused the service revision") }
            } else {
                // Keep the original route and passenger step. Only invalidate now-unsafe
                // boarding/visual confirmations; this is not a claim of a missed connection.
                next = current.raw
                next["now"] = .string(now); next["contextAt"] = .string(now)
                next["overlays"]["disrupted"] = .bool(true); next["overlays"]["replanning"] = .bool(true)
                next["confirmations"] = .object(["waitingTargetId": .null, "boardedLegId": .null])
                next["observations"] = .array([]); next["serviceMatch"] = .null; next["lostTrackIds"] = .array([])
                if current.phase == "waiting" { next["phase"] = .string("approaching") }
            }
            next["ojpServiceReport"] = update.report.raw
            let validated = try bridge.call("restore", .object(["json": .string(try next.encoded())]))
            publish(validated)
            notice = update.report.requiresRecovery ? "Source service changed. Original route retained; inspect the service and plan fresh recovery before boarding." : "Provider-compatible service information updated. Check local signs; source response time is not a vehicle observation."
        } catch {
            if token == serviceGeneration, !Task.isCancelled { serviceUpdateError = error.localizedDescription; serviceFailureAt = Date() }
        }
    }
    public func observeVision(_ observation: JSONValue) {
        guard !isDemo else { notice = "Native camera evidence is separate from the simulated scenario."; return }
        command("vision", ["observation": observation])
    }

    public func requestLocation() {
        guard !locationController.isRequesting else { return }
        locationPlace = nil
        locationController.requestLocation()
        if locationController.isRequesting {
            locationJourneyID = navigation?.journey.id
            locationOrigin = origin; locationForPlanning = true
        }
    }
    public func stopLocation() {
        locationForPlanning = false; locationJourneyID = nil; locationOrigin = nil; locationController.stop()
    }
    private func acceptLocation(_ data: Data) {
        guard locationForPlanning || locationController.isRequesting || locationController.isTracking else { return }
        do {
            let position = try JSONDecoder().decode(JSONValue.self, from: data)
            guard let captured = position["capturedAt"].string, let date = WireClock.date(captured),
                  !SensorFixFreshness.isStale(timestamp: date) else {
                notice = "Received an old or future location. Request again or select your current place manually."; return
            }
            guard date >= locationContextStartedAt else { return }
            let place = JSONValue.object(["id": .string("ios-local:location:\(captured)"), "name": .string("Approximate current location"),
                "kind": .string("coordinate"), "coordinate": position["rawCoordinate"], "parentId": .null,
                "sourceRefs": .array([]), "evidence": position["evidence"]])
            locationPlace = Place(raw: try requireBridge().call("validatePlace", .object(["place": place])))
            let requestedForPlanning = locationForPlanning
            locationForPlanning = false
            if requestedForPlanning, origin?.raw == locationOrigin?.raw {
                origin = locationPlace
                notice = "Approximate location selected as the search origin. No street side, floor or waiting area is confirmed."
            }
            guard !isDemo, navigation != nil,
                  locationController.isTracking || (requestedForPlanning && navigation?.journey.id == locationJourneyID) else { return }
            command("location", ["position": position], persist: false)
        } catch { self.error = error.localizedDescription }
    }
}
