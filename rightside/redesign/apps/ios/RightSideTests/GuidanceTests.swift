import XCTest
import MapKit
@testable import RightSide

final class GuidanceTests: XCTestCase {
    @MainActor func testMapPlaceIsValidatedAndRoutesByCoordinateRatherThanBusinessName() throws {
        let item = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: 46.948, longitude: 7.447),
            addressDictionary: ["Street": "Marktgasse 1", "City": "Bern", "Country": "Switzerland"]))
        item.name = "Coffee & Co"; item.pointOfInterestCategory = .cafe
        let result = try XCTUnwrap(MapPlaceSearch.suggestion(item))
        let validated = try DomainBridge().call("validatePlace", .object(["place": result.place.raw]))
        XCTAssertEqual(validated["coordinate"].coordinate, [7.447, 46.948])
        XCTAssertEqual(result.place.kind, "poi")
        XCTAssertEqual(CommunityTransport.placeQuery(result.place), "46.948,7.447")
        XCTAssertEqual(result.place.id, MapPlaceSearch.suggestion(item)?.place.id)
        let other = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: 47.37, longitude: 8.54)))
        other.name = item.name
        XCTAssertNotEqual(result.place.id, MapPlaceSearch.suggestion(other)?.place.id)
    }
    func testCoordinatesRejectInvalidAndRespectLongitudeFirstContract() {
        XCTAssertNil(MapGeometry.coordinate([7, .nan]))
        XCTAssertNil(MapGeometry.coordinate([7, 91]))
        XCTAssertNil(MapGeometry.coordinate([7]))
        XCTAssertEqual(MapGeometry.coordinate([7.44, 46.95])?.latitude, 46.95)
    }
    func testLineTextNeverMatchesInsideAnotherLineNumber() {
        XCTAssertFalse(CameraJourneyContext.containsPhrase("Bus 16", phrase: "6"))
        XCTAssertFalse(CameraJourneyContext.containsPhrase("Bus 60", phrase: "6"))
        XCTAssertTrue(CameraJourneyContext.containsPhrase("6 Fischermätteli", phrase: "6"))
        XCTAssertTrue(CameraJourneyContext.containsPhrase("BUS 10 KÖNIZ, SCHLIERN", phrase: "Köniz Schliern"))
        XCTAssertFalse(CameraJourneyContext.containsPhrase("Köniz", phrase: "Köniz Schliern"))
        XCTAssertFalse(CameraJourneyContext.containsPhrase("", phrase: ""))
    }
    func testCameraContextDistinguishesStopDestinationAndUnconfirmedLine() {
        let context = CameraJourneyContext(id: "leg", title: "Walk", line: "10", destination: "Köniz Schliern",
            stop: "Bern Bahnhof", target: nil, targetLabel: "", simulated: false)
        XCTAssertEqual(context.match("10"), "Line text · service unconfirmed")
        XCTAssertEqual(context.match("Bern Bahnhof"), "Stop text · check sign")
        XCTAssertEqual(context.match("10 Köniz Schliern"), "Destination text · check vehicle")
        XCTAssertNil(context.match("101"))
    }
    func testCameraBoxesUndoPortraitAndLandscapeOrientation() {
        let rect = CGRect(x: 0.1, y: 0.2, width: 0.3, height: 0.4)
        let portrait = CameraImageGeometry.rawBox(rect, orientation: .right)
        XCTAssertEqual(portrait.minX, 0.4, accuracy: 0.0001)
        XCTAssertEqual(portrait.minY, 0.6, accuracy: 0.0001)
        XCTAssertEqual(portrait.width, 0.4, accuracy: 0.0001)
        XCTAssertEqual(portrait.height, 0.3, accuracy: 0.0001)
        let landscape = CameraImageGeometry.rawBox(rect, orientation: .down)
        XCTAssertEqual(landscape.minX, 0.6, accuracy: 0.0001)
        XCTAssertEqual(landscape.minY, 0.2, accuracy: 0.0001)
    }
    private let route = [CLLocationCoordinate2D(latitude: 46.95, longitude: 7.44), CLLocationCoordinate2D(latitude: 46.951, longitude: 7.44)]
    private func fix(accuracy: Double = 5, age: Double = 0, longitude: Double = 7.44) -> CLLocation {
        CLLocation(coordinate: CLLocationCoordinate2D(latitude: 46.9501, longitude: longitude), altitude: 0,
            horizontalAccuracy: accuracy, verticalAccuracy: -1, timestamp: Date().addingTimeInterval(-age))
    }
    func testWalkingLookAheadFollowsMappedGeometryAndRejectsUncertainOrOldFixes() throws {
        let point = try XCTUnwrap(MapGeometry.lookAhead(on: route, from: fix()))
        XCTAssertGreaterThan(point.latitude, 46.9501)
        XCTAssertLessThan(point.latitude, 46.951)
        XCTAssertEqual(point.longitude, 7.44, accuracy: 0.00001)
        XCTAssertNil(MapGeometry.lookAhead(on: route, from: fix(accuracy: 100)))
        XCTAssertNil(MapGeometry.lookAhead(on: route, from: fix(age: 11)))
        XCTAssertNil(MapGeometry.lookAhead(on: route, from: fix(longitude: 7.45)))
        XCTAssertNil(MapGeometry.lookAhead(on: route, from: fix(age: -3)))
    }
    func testDenseStraightRouteIsNotMistakenForCompetingPaths() {
        let points = (0...30).map { CLLocationCoordinate2D(latitude: 46.95 + Double($0) * 0.00004, longitude: 7.44) }
        XCTAssertNotNil(MapGeometry.lookAhead(on: points, from: fix()))
    }
    func testAmbiguousReturnPathDoesNotInventForwardDirection() {
        let loop = route + [CLLocationCoordinate2D(latitude: 46.9511, longitude: 7.44001),
            CLLocationCoordinate2D(latitude: 46.951, longitude: 7.44002), CLLocationCoordinate2D(latitude: 46.95, longitude: 7.44002)]
        XCTAssertNil(MapGeometry.lookAhead(on: loop, from: fix()))
    }
    @MainActor func testVisualPositionExpiresWithoutAnotherCameraCallback() {
        let store = VisualLocationStore(), now = Date()
        store.observation = VisualLocation(coordinate: route[0], capturedAt: now)
        XCTAssertNotNil(store.fresh(at: now.addingTimeInterval(10)))
        XCTAssertNil(store.fresh(at: now.addingTimeInterval(10.1)))
        XCTAssertNil(store.fresh(at: now.addingTimeInterval(-1)))
        store.observation = nil
        XCTAssertNil(store.fresh())
    }
}
