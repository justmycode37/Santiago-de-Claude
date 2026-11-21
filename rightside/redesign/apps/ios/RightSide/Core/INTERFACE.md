# Native Core interface (iOS 17)

`@MainActor final class JourneyStore: NSObject, ObservableObject` has a nonthrowing `init()`; initialization errors appear in `error`. Tests can use `init(cacheURL: URL?, transport: any TransitTransport = CommunityTransport())` with a unique temporary cache URL and an injected transport, keeping saved user journeys and network access out of tests. Published state:

- `selected: Journey?`, `navigation: NavigationSnapshot?`, `alternatives: [Journey]`
- writable `origin: Place?`, `destination: Place?`; `busy: Bool`, `error: String?`, `notice: String?`, `isDemo: Bool`, `previewing: Bool`, `placeResults: [Place]`, `placeError: String?` (place-search failures are independent of journey `error`)
- writable `departure: Date`, `arriveBy: Bool`, `stepFree: Bool`; read-only `locationPlace: Place?` for explicitly choosing a sensor fix as the replan origin.
- `currentLeg: Leg?`, `canReturn: Bool`, `canStepScenario: Bool` computed. Simulated `canReturn` becomes false after the return journey; `canStepScenario` is false once manual demo progress begins or a saved demo is restored.

Commands: `searchPlaces(_ query: String) async -> [Place]`, `search() async`, `start(_ journey: Journey)`, `confirm(_ action: String)` (arrived/at_waiting_area/boarded/alighted), `prepareAlighting()`, `nextScenario()`, `loadDemo()`, `returnJourney() async`, `replan(from currentPlace: Place) async`, `resume()`, `restore()`, `correct(legId: String, phase: String, reason: String)`, `setOffline(_ offline: Bool)`, `requestLocation()`, `cancelSearch()`, `refresh()` (explicit snapshot-unavailable notice). `tick()` ages live evidence on foreground/timer; demo uses its own clock. Search and replan only preview alternatives; active navigation persists until explicit `start`. Empty or failed searches preserve active guidance. Explicit `start` creates fresh navigation, resetting the clock, offline state and history; starting the demo creates a fresh replay.

`select(_ journey: Journey)` validates and previews an option. `loadDemo()` previews the outbound fixture; call `start` to begin. `isDemo` identifies active guidance, not a preview. Changing search fields does not change guidance. A live return searches reversed endpoints and requires explicit `start` on a result; the simulated return starts immediately after outbound arrival. Manual confirmation, correction or alighting preparation disables scripted stepping. Restoring a saved demo retains progress and remains manual; load and explicitly start the demo again to enable scripted events.

DTOs are lossless Codable JSON wrappers. All have `raw: JSONValue`; `Journey`, `Leg`, `Place`, `Instruction`, `StopCall`, `BoardingTarget` are Identifiable. String phases/kinds match shared TS contracts. Common typed fields:

- Journey: id, revision, origin, destination, legs, durationSeconds, warnings, evidence.
- Place: id, name, kind, coordinate: [Double]?, evidence.
- Leg: id, kind, from, to, plannedStart/End: String, expectedStart/End: String?, line/headsign/mode: String?, instructions: [Instruction], geometry: Geometry?, boardingTarget: BoardingTarget?, calls: [StopCall], accessibility: String, distanceMeters: Double?.
- NavigationSnapshot: journey, legIndex, phase, now, overlays: NavigationOverlays (offline/disrupted/replanning/uncertain), predictionFresh, position: PositionEstimate?, serviceMatch: ServiceMatch?, currentLeg: Leg.
- Geometry: coordinates: [[Double]], quality: String. Instruction: id, text, kind.
- BoardingTarget: id, assignment: BoardingAssignment (label/originalLabel: String?, status: String), pedestrianTargetStatus: String, transitCoordinate: [Double]?. StopCall: id, place, plannedDeparture/Arrival and expectedDeparture/Arrival: String?, status.
- Evidence: source, fetchedAt, observedAt: String?, kind, quality. PositionEstimate: rawCoordinate: [Double]?, horizontalAccuracyMeters: Double?, confidence. ServiceMatch: status, reasonCodes: [String].

Camera integration may submit `observeVision(_ observation: JSONValue)` containing the complete existing VisionObservation contract; reducer recomputes matches. Single-frame OCR must remain unknown and cannot confirm boarding. No camera permission is requested by core. Location is explicitly requested via CoreLocation; sensor callbacks never advance progress.

`store.locationController` exposes the single Sensors `LocationController` for `LocationStatusView(controller:)`. The store consumes main-actor published JSON synchronously before the request-completed notification clears its context; a fresh requested fix updates the search origin, and the active passenger estimate only when the request still belongs to that journey. It never replans automatically. `stopLocation()` delegates cancellation. Sensor UI owns permission, timeout, freshness and background cleanup.

`DomainBridge.routeWalk(_ request: JSONValue)` lazily loads `bern-walking-graph.json` and calls the existing bounded router. Supply existing WalkingRequest fields (`from`, `to`, `now`, optional `stepFree`, `wheelchair`, `closures`). Returned paths remain `pedestrianTargetStatus: unverified`, `currentAccess: unknown`. Include `bern-walking-manifest.json` for attribution/provenance. The store does not replace itinerary gaps with these paths automatically.

Build resources with `node scripts/build-ios-resources.mts`. Include generated `Resources/domain.js`, `Resources/bern-demo.json`, `Resources/bern-walking-graph.json`, and `Resources/bern-walking-manifest.json` as bundle resources. Core imports Foundation, Combine and JavaScriptCore, and uses the Sensors LocationController; no WebView or Windows API dependency. Portable Mac validation is recorded in `apps/ios/README.md`; full iOS compilation and hosted XCTest still require full Xcode. JS tests do not establish native compilation.

## Isolated native redesign

`MapServices.swift` adds `MapPlaceSearch.search(_:near:)` for Apple Maps place suggestions and `WalkingRouteController.load(_:simulated:)` for optional walking detail. The SwiftUI search presents independent transit and map-source results with address disambiguation. Coordinates remain longitude-first in the shared DTO and latitude-first in the community transport query. Framework requests are isolated to the main actor, explicitly cancellable and bounded by a 20-second deadline. Late results cannot replace a new query or walking leg.

Active continuous location observations now update the navigation position without rewriting the selected search origin or saving every sensor frame. They never change journey progress. One-shot planning retains its original request context and unchanged-origin gate. The visual AR position stays separate from the shared position payload because its numeric uncertainty is unavailable.
