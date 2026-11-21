import Foundation
import MapKit

@main struct GuidanceChecks {
    @MainActor static func main() async throws {
        if CommandLine.arguments.contains("--live") {
            for query in ["Zytglogge Bern", "Café Montag Bern", "Migros Bern"] {
                let found = try await MapPlaceSearch.search(query, near: CLLocationCoordinate2D(latitude: 46.949, longitude: 7.439))
                precondition(!found.isEmpty, "No search results for public fixture")
                print("LIVE Apple Maps: \(query) → \(found.count) results; first: \(found[0].place.name), \(found[0].subtitle)")
            }
            let walking = WalkingRouteController()
            let from: JSONValue = .object(["coordinate": .array([.number(7.439), .number(46.949)]), "name": .string("Bern Bahnhof"), "sourceRefs": .array([])])
            let to: JSONValue = .object(["coordinate": .array([.number(7.447), .number(46.948)]), "name": .string("Zytglogge"), "sourceRefs": .array([])])
            await walking.load(Leg(raw: .object(["id": .string("public-walk-fixture"), "kind": .string("walk"), "from": from, "to": to])), simulated: false)
            precondition(walking.route != nil, walking.status ?? "No route")
            print("LIVE Apple Maps walking: \(Int(walking.route!.distance)) m; \(walking.route!.steps.count) steps")
            let transit = try await CommunityTransport().connections(origin: Place(raw: from), destination: Place(raw: to), departure: Date(), arriveBy: false)
            print("LIVE coordinate transit: \(transit["connections"].array.count) connections (availability is time-dependent)")
            return
        }
        let item = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: 46.948, longitude: 7.447)))
        item.name = "Coffee & Co"; item.pointOfInterestCategory = .cafe
        let suggestion = MapPlaceSearch.suggestion(item)!
        precondition(suggestion.place.coordinate == [7.447, 46.948])
        precondition(CommunityTransport.placeQuery(suggestion.place) == "46.948,7.447")
        precondition(MapPlaceSearch.suggestion(item)!.id == suggestion.id)
        let other = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: 47.37, longitude: 8.54)))
        other.name = item.name
        precondition(MapPlaceSearch.suggestion(other)!.id != suggestion.id)
        precondition(MapGeometry.coordinate([7, .nan]) == nil)
        precondition(MapGeometry.coordinate([7, 91]) == nil)
        precondition(!CameraJourneyContext.containsPhrase("16", phrase: "6"))
        precondition(!CameraJourneyContext.containsPhrase("60", phrase: "6"))
        precondition(CameraJourneyContext.containsPhrase("BUS 6 KÖNIZ, SCHLIERN", phrase: "Köniz Schliern"))
        precondition(!CameraJourneyContext.containsPhrase("Köniz", phrase: "Köniz Schliern"))
        let context = CameraJourneyContext(id: "leg", title: "Walk", line: "6", destination: "Köniz Schliern", stop: "Bern Bahnhof", target: nil, targetLabel: "", simulated: false)
        precondition(context.match("6") == "Line text · service unconfirmed")
        precondition(context.match("Bern Bahnhof") == "Stop text · check sign")
        precondition(context.match("16") == nil)
        let portrait = CameraImageGeometry.rawBox(CGRect(x: 0.1, y: 0.2, width: 0.3, height: 0.4), orientation: .right)
        precondition(abs(portrait.minX - 0.4) < 0.0001 && abs(portrait.minY - 0.6) < 0.0001)
        precondition(abs(portrait.width - 0.4) < 0.0001 && abs(portrait.height - 0.3) < 0.0001)
        let now = Date()
        func fix(_ accuracy: Double = 5, _ age: Double = 0, _ longitude: Double = 7.44) -> CLLocation {
            CLLocation(coordinate: CLLocationCoordinate2D(latitude: 46.9501, longitude: longitude), altitude: 0,
                horizontalAccuracy: accuracy, verticalAccuracy: -1, timestamp: now.addingTimeInterval(-age))
        }
        let route = [CLLocationCoordinate2D(latitude: 46.95, longitude: 7.44), CLLocationCoordinate2D(latitude: 46.951, longitude: 7.44)]
        let ahead = MapGeometry.lookAhead(on: route, from: fix(), now: now)!
        precondition(ahead.latitude > 46.9501 && ahead.latitude < 46.951)
        precondition(abs(ahead.longitude - 7.44) < 0.00001)
        precondition(MapGeometry.lookAhead(on: route, from: fix(100), now: now) == nil)
        precondition(MapGeometry.lookAhead(on: route, from: fix(5, 11), now: now) == nil)
        precondition(MapGeometry.lookAhead(on: route, from: fix(5, -3), now: now) == nil)
        precondition(MapGeometry.lookAhead(on: route, from: fix(5, 0, 7.45), now: now) == nil)
        let dense = (0...30).map { CLLocationCoordinate2D(latitude: 46.95 + Double($0) * 0.00004, longitude: 7.44) }
        precondition(MapGeometry.lookAhead(on: dense, from: fix(), now: now) != nil)
        let loop = route + [CLLocationCoordinate2D(latitude: 46.9511, longitude: 7.44001), CLLocationCoordinate2D(latitude: 46.951, longitude: 7.44002), CLLocationCoordinate2D(latitude: 46.95, longitude: 7.44002)]
        precondition(MapGeometry.lookAhead(on: loop, from: fix(), now: now) == nil)
        let visual = VisualLocationStore()
        visual.observation = VisualLocation(coordinate: route[0], capturedAt: now)
        precondition(visual.fresh(at: now.addingTimeInterval(10)) != nil)
        precondition(visual.fresh(at: now.addingTimeInterval(10.01)) == nil)
        precondition(visual.fresh(at: now.addingTimeInterval(-1)) == nil)
        print("PASS native guidance assertions: place coordinates/identity, OCR token boundaries/context, camera transform, walking look-ahead/ambiguity, visual freshness. macOS framework execution; not hardware or hosted iOS tests.")
    }
}
