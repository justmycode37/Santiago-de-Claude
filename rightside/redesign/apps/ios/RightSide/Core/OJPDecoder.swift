import Foundation

struct OJPPlaceContext {
    let name: String
    let parent: String?
    let coordinate: [Double]?
}

enum OJPDecoder {
    static func coordinate(_ node: OJPXML.Node?) throws -> [Double]? {
        guard let node else { return nil }
        guard let lon = try node.value("Longitude", ns: OJPXML.siri).flatMap(Double.init),
              let lat = try node.value("Latitude", ns: OJPXML.siri).flatMap(Double.init),
              lon.isFinite, lat.isFinite, abs(lon) <= 180, abs(lat) <= 90 else { throw OJPError.invalid("Invalid coordinate") }
        return [lon, lat]
    }
    static func places(_ delivery: OJPXML.Node, contextName: String) throws -> [String: OJPPlaceContext] {
        guard let context = try delivery.one(contextName), let places = try context.one("Places") else { return [:] }
        let nodes = places.all("Place"); guard nodes.count <= 1000 else { throw OJPError.invalid("Too many source places") }
        var result: [String: OJPPlaceContext] = [:]
        for node in nodes {
            let point = try node.one("StopPoint"), parent = try node.one("StopPlace")
            guard point == nil || parent == nil else { throw OJPError.invalid("Ambiguous source place") }
            let ref = try point?.value("StopPointRef", ns: OJPXML.siri) ?? parent?.value("StopPlaceRef")
            guard let ref else { continue }
            guard OJPIdentity.stop(ref), result[ref] == nil else { throw OJPError.invalid("Duplicate or invalid source place") }
            let parentRef = try point?.value("ParentRef")
            guard parentRef.map(OJPIdentity.stop) ?? true else { throw OJPError.invalid("Invalid parent stop reference") }
            guard let name = try node.label("Name") ?? point?.label("StopPointName") ?? parent?.label("StopPlaceName") else { throw OJPError.invalid("Missing stop name") }
            result[ref] = OJPPlaceContext(name: name, parent: parentRef, coordinate: try coordinate(node.one("GeoPosition")))
        }
        return result
    }
    static func occurrence(_ service: OJPXML.Node) throws -> OJPOccurrence {
        let value = try OJPOccurrence(provider: OJPIdentity.provider, journeyRef: service.required("JourneyRef"), operatingDay: service.required("OperatingDayRef"))
        guard value.valid else { throw OJPError.invalid("Invalid provider-local occurrence") }
        return value
    }
    static func call(_ node: OJPXML.Node, places: [String: OJPPlaceContext]) throws -> OJPServiceCall {
        let ref = try node.required("StopPointRef", ns: OJPXML.siri)
        guard OJPIdentity.stop(ref), let order = Int(try node.required("Order")), (1...100_000).contains(order),
              let name = try node.label("StopPointName") ?? places[ref]?.name else { throw OJPError.invalid("Invalid ordered call") }
        let arrival = try node.one("ServiceArrival"), departure = try node.one("ServiceDeparture")
        let pa = try OJPIdentity.date(arrival?.value("TimetabledTime")), pd = try OJPIdentity.date(departure?.value("TimetabledTime"))
        let ea = try OJPIdentity.date(arrival?.value("EstimatedTime")), ed = try OJPIdentity.date(departure?.value("EstimatedTime"))
        guard pa != nil || pd != nil, !(pa != nil && pd != nil && pa! > pd!), !(ea != nil && ed != nil && ea! > ed!),
              ea.map({ estimate in pa.map { abs(estimate.timeIntervalSince($0)) <= 12 * 3600 } ?? false }) ?? true,
              ed.map({ estimate in pd.map { abs(estimate.timeIntervalSince($0)) <= 12 * 3600 } ?? false }) ?? true else {
            throw OJPError.invalid("Contradictory or implausible call times")
        }
        return try OJPServiceCall(order: order, stopPointRef: ref, parentRef: places[ref]?.parent, name: name,
            coordinate: places[ref]?.coordinate, plannedArrival: pa, plannedDeparture: pd, expectedArrival: ea, expectedDeparture: ed,
            plannedQuay: node.label("PlannedQuay"), estimatedQuay: node.label("EstimatedQuay"),
            notServiced: node.flag("NotServicedStop"), noBoarding: node.flag("NoBoardingAtStop"), noAlighting: node.flag("NoAlightingAtStop"))
    }
    static func validateOrder(_ calls: [OJPServiceCall]) throws {
        guard (2...160).contains(calls.count) else { throw OJPError.invalid("Invalid call count") }
        for index in calls.indices.dropFirst() {
            let old = calls[index - 1], next = calls[index]
            guard next.order > old.order, let end = old.plannedDeparture ?? old.plannedArrival, let start = next.plannedArrival ?? next.plannedDeparture,
                  start >= end else { throw OJPError.invalid("Call order or timetable is inconsistent") }
        }
    }
    static func service(data: Data, occurrence requested: OJPOccurrence, acquiredAt: Date, httpDate: String?) throws -> OJPServiceSnapshot {
        guard requested.valid else { throw OJPError.invalid("Unsupported service occurrence") }
        let delivery = try OJPXML.delivery(OJPXML.parse(data), kind: "OJPTripInfoDelivery")
        let source = try OJPSource.make(delivery, data: data, acquiredAt: acquiredAt, httpDate: httpDate)
        let context = try places(delivery, contextName: "TripInfoResponseContext")
        guard let result = try delivery.one("TripInfoResult"), let service = try result.one("Service"),
              try result.one("ErrorCondition") == nil else { throw OJPError.invalid("Missing service result") }
        let identity = try occurrence(service)
        guard identity == requested else { throw OJPError.invalid("Response belongs to another journey or operating day") }
        // The provider currently emits future calls as PreviousCall. No progress is inferred.
        let nodes = result.children.filter { $0.namespace == OJPXML.ojp && ["PreviousCall", "OnwardCall"].contains($0.name) }
        guard nodes.count <= 160 else { throw OJPError.invalid("Service call limit exceeded") }
        let calls = try nodes.map { try call($0, places: context) }
        try validateOrder(calls)
        return try OJPServiceSnapshot(occurrence: identity, source: source, line: service.value("PublicCode"),
            destination: service.label("DestinationText"), direction: service.value("DirectionRef", ns: OJPXML.siri),
            cancelled: service.flag("Cancelled"), calls: calls)
    }
}
