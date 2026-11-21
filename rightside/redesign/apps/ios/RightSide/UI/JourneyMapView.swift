import SwiftUI
import MapKit

struct JourneyMapView: View {
    @AppStorage(JourneyLanguage.preferenceKey, store: JourneyLanguage.preferences) private var languageCode = "en"
    private var departureLanguage: JourneyLanguage { JourneyLanguage.resolve(languageCode) }
    let journey: Journey
    let position: PositionEstimate?
    @ObservedObject var location: LocationController
    @ObservedObject var walking: WalkingRouteController
    @ObservedObject var transit: TransitGeometryController
    @ObservedObject var visual: VisualLocationStore
    let simulated: Bool
    @State private var camera: MapCameraPosition = .automatic
    @Binding var is3D: Bool
    let overviewRequest: UUID
    let focusedLegID: String?
    var onSelectLeg: (String) -> Void = { _ in }
    var onSelectStop: (Place) -> Void = { _ in }
    var spatialResolution: SpatialResolution? = nil
    var spatialFeatures: [SpatialFeature] = []
    @State private var showReferences = false
    @State private var showingWholeJourney = false
    @State private var visibleCamera: MapCamera?
    @State private var mapSelection: String?
    @State private var followLocation = false
    @State private var orientToHeading = false
    private var focusedLeg: Leg? { journey.legs.first { $0.id == focusedLegID } }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { context in
            map(at: context.date)
        }
    }
    private func map(at now: Date) -> some View {
        let walkingDetail = walking.displayedSnapshot(for: journey, at: now)
        let freshVisual = simulated ? nil : visual.fresh(at: now)
        let fix = simulated ? nil : location.latestLocation
        let fresh = !location.isStale(at: now)
        return Map(position: $camera, selection: $mapSelection) {
            if showReferences {
                ForEach(spatialFeatures) { feature in
                    if feature.kind == .pedestrianPath, feature.geometry.count > 1 {
                        MapPolyline(coordinates: feature.geometry.map { CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude) })
                            .stroke(Color.orange.opacity(0.55), style: StrokeStyle(lineWidth: 2, dash: [3, 4]))
                    } else if let point = feature.coordinate {
                        Annotation("\(feature.name) · mapped reference", coordinate: CLLocationCoordinate2D(latitude: point.latitude, longitude: point.longitude)) {
                            Image(systemName: feature.kind == .entrance ? "door.left.hand.open" : "mappin.circle")
                                .font(.caption).foregroundStyle(Color.rightSideWarning).padding(3).background(.background, in: Circle())
                        }
                    }
                }
            }
            ForEach(journey.legs) { leg in
                let alignment = transit.resolution(for: journey, leg: leg, at: now)
                if let alignment, !alignment.segments.isEmpty {
                    ForEach(alignment.segments) { segment in
                        MapPolyline(coordinates: segment.coordinates.compactMap(MapGeometry.coordinate))
                            .stroke(leg.id == focusedLegID ? routeColor(leg.mode) : routeColor(leg.mode).opacity(0.45),
                                style: StrokeStyle(lineWidth: leg.id == focusedLegID ? 6 : 3, dash: [2, 3]))
                    }
                } else if let geometry = leg.geometry, walkingDetail?.leg != leg {
                    let points = geometry.coordinates.compactMap(MapGeometry.coordinate)
                    if points.count > 1 {
                        MapPolyline(coordinates: points).stroke(leg.id == focusedLegID ? Color.rightSideTeal : Color.gray.opacity(0.55),
                            style: StrokeStyle(lineWidth: leg.id == focusedLegID ? 6 : 3, dash: geometry.quality == "schematic" || geometry.quality == "unknown" ? [7, 6] : []))
                    }
                }
                if let point = MapGeometry.coordinate(leg.from.coordinate) {
                    Annotation(leg.from.name, coordinate: point) {
                        Image(systemName: legSymbol(leg)).font(.caption.bold()).padding(8)
                            .foregroundStyle(leg.id == focusedLegID ? .white : Color.rightSideTeal)
                            .background(leg.id == focusedLegID ? Color.rightSideTeal : Color(uiColor: .systemBackground), in: Circle())
                    }.tag(leg.id)
                }
            }
            if let detail = walkingDetail { MapPolyline(detail.polyline).stroke(Color.rightSideTeal, lineWidth: 6) }
            if let focusedLeg, focusedLeg.kind == "ride" {
                ForEach(focusedLeg.calls) { call in
                    if let point = MapGeometry.coordinate(call.place.coordinate) {
                        Annotation(call.place.name, coordinate: point) {
                            Button { onSelectStop(call.place) } label: {
                                Image(systemName: call.id == focusedLeg.raw["alightingCallId"].string ? "arrow.down.circle.fill" : "circle.fill")
                                    .foregroundStyle(Color.rightSideTeal).font(.caption).padding(6).background(.background, in: Circle())
                            }.buttonStyle(.plain).disabled(DepartureStop.id(for: call.place) == nil)
                                .accessibilityLabel("Departures at \(call.place.name)")
                        }
                    }
                }
            }
            if let point = MapGeometry.coordinate(journey.destination.coordinate) {
                Marker(journey.destination.name, systemImage: "flag.checkered", coordinate: point).tint(Color.rightSideTeal)
            }
            if let fix, fix.horizontalAccuracy >= 0 {
                MapCircle(center: fix.coordinate, radius: min(fix.horizontalAccuracy, 20_000_000))
                    .foregroundStyle((fresh ? Color.blue : Color.gray).opacity(0.14))
                Annotation(freshVisual == nil ? (fresh ? "You" : "Last known location") : "Sensor location", coordinate: fix.coordinate) {
                    ZStack {
                        if fresh, let heading = location.usableHeading(at: now) {
                            Image(systemName: "location.north.fill").font(.system(size: 30)).foregroundStyle(.blue.opacity(0.5))
                                .offset(y: -10).rotationEffect(.degrees(heading - (visibleCamera?.heading ?? 0)))
                        }
                        Circle().fill(fresh ? .blue : .gray).frame(width: 14, height: 14).overlay(Circle().stroke(.white, lineWidth: 3))
                    }.accessibilityLabel(fresh ? "Your reported location, accuracy plus or minus \(Int(fix.horizontalAccuracy)) meters" : "Old location")
                }
            } else if let point = MapGeometry.coordinate(position?.rawCoordinate) {
                Annotation(simulated ? "Simulated passenger" : "Saved location", coordinate: point) {
                    Circle().fill(.gray).frame(width: 12, height: 12).overlay(Circle().stroke(.white, lineWidth: 2))
                }
            }
            if let visual = freshVisual {
                Annotation("Camera-localized position", coordinate: visual.coordinate) {
                    Image(systemName: "viewfinder.circle.fill").font(.title).foregroundStyle(.purple).background(.white, in: Circle())
                }
            }
        }
        .mapStyle(.standard(elevation: is3D ? .realistic : .flat, emphasis: .muted, pointsOfInterest: .all, showsTraffic: false))
        .mapControls { MapCompass(); MapScaleView() }
        .onMapCameraChange(frequency: .onEnd) { visibleCamera = $0.camera }
        .onChange(of: mapSelection) { _, id in if let id { if journey.legs.contains(where: { $0.id == id }) { onSelectLeg(id) }; showingWholeJourney = false; followLocation = false } }
        .onChange(of: location.latestLocation) { _, _ in if followLocation { recenter(at: Date()) } }
        .overlay(alignment: .bottomTrailing) {
            VStack(spacing: 8) {
                Button { followLocation = true; showingWholeJourney = false; recenter(at: Date()) } label: { Image(systemName: followLocation ? "location.fill" : "location") }
                    .accessibilityLabel("Follow my reported location").accessibilityIdentifier("map-recenter")
                Button { orientToHeading.toggle(); if followLocation { recenter(at: Date()) } } label: { Image(systemName: orientToHeading ? "location.north.line.fill" : "location.north.line") }
                    .accessibilityLabel(orientToHeading ? "Use north-up map" : "Orient map to available heading")
                Button { followLocation = false; showingWholeJourney = true; fitJourney() } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }.accessibilityLabel("Fit whole journey")
            }.font(.headline).buttonStyle(.borderedProminent).tint(Color(uiColor: .systemBackground)).foregroundStyle(Color.rightSideTeal).padding(10)
        }
        .overlay(alignment: .bottomLeading) {
            Text("Dashed: schematic · dotted: mapped corridor")
                .font(.caption2).padding(8).background(.regularMaterial, in: Capsule()).padding(10)
        }
        .overlay(alignment: .topLeading) {
            if !simulated {
                Text(freshVisual != nil ? "Camera localized · precision unquantified" : fix.map { fresh ? "You · ±\(Int($0.horizontalAccuracy)) m" : "Location out of date" } ?? "Location not available")
                    .font(.caption.bold()).padding(8).background(.regularMaterial, in: Capsule()).padding(10)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity).accessibilityIdentifier("journey-map")
        .onAppear { fitJourney() }
        .onChange(of: journey.id) { _, _ in showingWholeJourney = true; followLocation = false; fitJourney() }
        .onChange(of: focusedLegID) { _, _ in showingWholeJourney = false; followLocation = false; fitJourney() }
        .onChange(of: transit.displayed) { _, _ in if !followLocation { fitJourney() } }
        .onChange(of: walking.snapshot) { _, _ in if !followLocation { fitJourney() } }
        .onChange(of: overviewRequest) { _, _ in showingWholeJourney = true; followLocation = false; fitJourney() }
        .onChange(of: is3D) { _, _ in
            if let current = visibleCamera { camera = .camera(MapCamera(centerCoordinate: current.centerCoordinate, distance: current.distance, heading: current.heading, pitch: is3D ? 55 : 0)) }
        }
    }
    private func corridorCaption(at now: Date) -> some View {
        let rides = journey.legs.filter { $0.kind == "ride" }
        let covered = rides.filter { transit.resolution(for: journey, leg: $0, at: now)?.segments.isEmpty == false }.count
        return VStack(alignment: .leading, spacing: 5) {
            Text("Mapped transit corridors: \(covered) of \(rides.count) ride legs").font(.caption.bold())
            if let leg = focusedLeg, leg.kind == "ride", let result = transit.resolution(for: journey, leg: leg, at: now) {
                Text(result.label).font(.caption).foregroundStyle(result.segments.isEmpty ? Color.secondary : Color.purple)
                DisclosureGroup("Map data details") {
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(Array(result.reasons.enumerated()), id: \.offset) { _, reason in
                            Text(reason).font(.caption2).foregroundStyle(.secondary)
                        }
                        if let relation = result.relationID {
                            Link(result.relationName ?? "OSM route relation", destination: URL(string: "https://www.openstreetmap.org/relation/\(relation)")!).font(.caption)
                        }
                        if let source = result.source {
                            Text("Source snapshot \(source.acquiredDate?.formatted(date: .abbreviated, time: .shortened) ?? source.acquiredAt)").font(.caption2)
                            Text("Source retrieval date is not a field observation or service-validity date.").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                .font(.caption)
            } else {
                Text("Select a ride to see map coverage. The service may follow a different path.").font(.caption2).foregroundStyle(.secondary)
            }
            if covered > 0 {
                Link("© OpenStreetMap contributors · ODbL 1.0", destination: URL(string: "https://www.openstreetmap.org/copyright")!).font(.caption2)
            }
            if let status = transit.status { Text(status).font(.caption2).foregroundStyle(.secondary) }
        }.accessibilityIdentifier("transit-corridor-coverage")
    }

    private func fitJourney() {
        let legs = showingWholeJourney || focusedLeg == nil ? journey.legs : [focusedLeg!]
        var points = legs.flatMap { leg in [leg.from.coordinate, leg.to.coordinate].compactMap(MapGeometry.coordinate) + (leg.geometry?.coordinates.compactMap(MapGeometry.coordinate) ?? []) }
        for leg in legs {
            if let alignment = transit.resolution(for: journey, leg: leg) {
                points += alignment.segments.flatMap { $0.coordinates.compactMap(MapGeometry.coordinate) }
            }
        }
        if let snapshot = walking.displayedSnapshot(for: journey), legs.contains(snapshot.leg) { points += snapshot.points }
        guard let first = points.first else { camera = .automatic; return }
        var rect = MKMapRect(origin: MKMapPoint(first), size: MKMapSize(width: 1, height: 1))
        for point in points.dropFirst() { rect = rect.union(MKMapRect(origin: MKMapPoint(point), size: MKMapSize(width: 1, height: 1))) }
        let padding = max(250, max(rect.width, rect.height) * 0.15)
        camera = .rect(rect.insetBy(dx: -padding, dy: -padding))
    }
    private func recenter(at now: Date) {
        guard !simulated else { return }
        guard let fix = location.latestLocation, !location.isStale(at: now) else { location.startTracking(); return }
        camera = .camera(MapCamera(centerCoordinate: fix.coordinate, distance: max(350, fix.horizontalAccuracy * 6), heading: orientToHeading ? location.usableHeading(at: now) ?? 0 : 0, pitch: is3D ? 55 : 0))
    }
}

struct ExploreMapView: View {
    let origin: Place?
    let destination: Place?
    @ObservedObject var location: LocationController
    @State private var camera: MapCameraPosition = .region(MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 46.948, longitude: 7.447),
        latitudinalMeters: 3500, longitudinalMeters: 3500))
    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { context in map(at: context.date) }
    }
    private func map(at now: Date) -> some View {
        Map(position: $camera) {
            if let origin, let coordinate = MapGeometry.coordinate(origin.coordinate) {
                Marker(origin.name, systemImage: "circle.circle.fill", coordinate: coordinate).tint(Color.rightSideTeal)
            }
            if let destination, let coordinate = MapGeometry.coordinate(destination.coordinate) {
                Marker(destination.name, systemImage: "flag.checkered", coordinate: coordinate).tint(Color.rightSideTeal)
            }
            if let fix = location.latestLocation, !location.isStale(at: now) {
                MapCircle(center: fix.coordinate, radius: min(fix.horizontalAccuracy, 20_000))
                    .foregroundStyle(.blue.opacity(0.12))
                Annotation("Approximate location", coordinate: fix.coordinate) {
                    Circle().fill(.blue).frame(width: 16, height: 16).overlay(Circle().stroke(.white, lineWidth: 3))
                }
            }
        }
        .mapStyle(.standard(elevation: .flat, emphasis: .muted, pointsOfInterest: .including([.publicTransport])))
        .mapControls { MapCompass(); MapScaleView() }
        .overlay(alignment: .bottomLeading) {
            if origin == nil && destination == nil && location.latestLocation == nil {
                Text("Bern · explore the map").font(.caption.bold()).padding(10)
                    .background(.regularMaterial, in: Capsule()).padding(16)
            }
        }
        .onChange(of: origin) { _, _ in fitPlaces() }
        .onChange(of: destination) { _, _ in fitPlaces() }
        .onAppear { fitPlaces() }
        .accessibilityIdentifier("explore-map")
    }
    private func fitPlaces() {
        let points = [origin, destination].compactMap { MapGeometry.coordinate($0?.coordinate) }
        guard !points.isEmpty else { return }
        var rect = MKMapRect.null
        for point in points { let p = MKMapPoint(point); rect = rect.union(MKMapRect(x: p.x, y: p.y, width: 1, height: 1)) }
        camera = .rect(rect.insetBy(dx: -max(rect.width * 0.3, 4000), dy: -max(rect.height * 0.3, 4000)))
    }
}
