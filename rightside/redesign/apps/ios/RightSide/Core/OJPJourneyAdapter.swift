import Foundation

enum OJPJourneyAdapter {
    static func assignment(label: String?, pointRef: String, source: OJPSource, predicted: Bool) -> JSONValue {
        .object(["status": .string(label == nil ? "stop_only" : "candidates_only"),
            "sourceRef": .object(["provider": .string(OJPIdentity.provider), "id": .string(pointRef), "feedVersion": .null]),
            "originalLabel": .optional(label), "label": .optional(label), "candidates": .array(label.map { [.string($0)] } ?? []),
            "conflictReason": .null, "evidence": source.evidence(predicted: predicted)])
    }
    static func call(_ value: OJPServiceCall, occurrence: OJPOccurrence, id: String, source: OJPSource, cancelled: Bool?, serviceOrder: Int? = nil) -> JSONValue {
        .object(["id": .string(id), "trip": occurrence.wire, "stopSequence": serviceOrder.map { .number(Double($0)) } ?? .null,
            "place": value.place(source: source).raw, "plannedArrival": .optional(value.plannedArrival.map(WireClock.string)),
            "plannedDeparture": .optional(value.plannedDeparture.map(WireClock.string)), "expectedArrival": .optional(value.expectedArrival.map(WireClock.string)),
            "expectedDeparture": .optional(value.expectedDeparture.map(WireClock.string)),
            "plannedAssignment": assignment(label: value.plannedQuay, pointRef: value.stopPointRef, source: source, predicted: false),
            "currentAssignment": assignment(label: value.estimatedQuay ?? value.plannedQuay, pointRef: value.stopPointRef, source: source, predicted: value.estimatedQuay != nil),
            "pickup": .string(value.noBoarding.map { $0 ? "forbidden" : "allowed" } ?? "unknown"),
            "dropoff": .string(value.noAlighting.map { $0 ? "forbidden" : "allowed" } ?? "unknown"),
            "status": .string(cancelled == true ? "cancelled" : value.notServiced == true ? "skipped" : "unknown"),
            "evidence": source.evidence(predicted: value.expectedArrival != nil || value.expectedDeparture != nil),
            "ojp": .object(["stopPointRef": .string(value.stopPointRef), "legOrder": .number(Double(value.order)), "serviceOrder": serviceOrder.map { .number(Double($0)) } ?? .null,
                "source": source.raw])])
    }
    static func target(call: JSONValue, source: OJPSource) -> JSONValue {
        let assignment = call["currentAssignment"]
        let identity: JSONValue = .array([call["id"], assignment["status"], assignment["label"], assignment["sourceRef"]])
        return .object(["id": .string("ojp:target:" + OJPIdentity.digest(identity)), "callId": call["id"], "assignment": assignment,
            "transitCoordinate": call["place"]["coordinate"], "pedestrianArea": .null, "pedestrianTargetStatus": .string("unverified"),
            "approachEntrance": .null, "level": .null, "precisionMeters": .null, "evidence": source.evidence()])
    }
    static func base(id: String, kind: String, from: Place, to: Place, start: Date, end: Date, source: OJPSource) -> JSONValue {
        .object(["id": .string(id), "kind": .string(kind), "from": from.raw, "to": to.raw,
            "plannedStart": .string(WireClock.string(start)), "plannedEnd": .string(WireClock.string(end)),
            "expectedStart": .null, "expectedEnd": .null, "geometry": .null, "accessibility": .string("unknown"),
            "instructions": .array([]), "evidence": source.evidence()])
    }
    static func duration(_ value: String) throws -> TimeInterval {
        let regex = try NSRegularExpression(pattern: "^PT(?:(\\d+)H)?(?:(\\d+)M)?(?:(\\d+(?:\\.\\d+)?)S)?$")
        let range = NSRange(value.startIndex..., in: value)
        guard let match = regex.firstMatch(in: value, range: range), value != "PT" else { throw OJPError.invalid("Unsupported leg duration") }
        var seconds = 0.0
        for (index, factor) in [3600.0,60,1].enumerated() {
            if let range = Range(match.range(at: index + 1), in: value), let number = Double(value[range]) { seconds += number * factor }
        }
        guard seconds.isFinite, (0...86_400).contains(seconds) else { throw OJPError.invalid("Leg duration limit") }
        return seconds
    }
    static func place(_ node: OJPXML.Node, context: [String: OJPPlaceContext], source: OJPSource) throws -> Place {
        if let ref = try node.value("StopPointRef", ns: OJPXML.siri) {
            guard OJPIdentity.stop(ref), let name = try node.label("Name") ?? node.label("StopPointName") ?? context[ref]?.name else { throw OJPError.invalid("Unknown walking endpoint") }
            return OJPServiceCall(order: 1, stopPointRef: ref, parentRef: context[ref]?.parent, name: name, coordinate: context[ref]?.coordinate,
                plannedArrival: nil, plannedDeparture: nil, expectedArrival: nil, expectedDeparture: nil, plannedQuay: nil, estimatedQuay: nil,
                notServiced: nil, noBoarding: nil, noAlighting: nil).place(source: source)
        }
        guard let coordinate = try OJPDecoder.coordinate(node.one("GeoPosition")) else { throw OJPError.invalid("Missing walking endpoint") }
        return Place(raw: .object(["id": .string("ojp:coordinate:" + OJPIdentity.digest(.array(coordinate.map(JSONValue.number)))),
            "name": .string(try node.label("Name") ?? "Source coordinate"), "kind": .string("coordinate"),
            "coordinate": .array(coordinate.map(JSONValue.number)), "parentId": .null, "sourceRefs": .array([]), "evidence": source.evidence()]))
    }
    static func walkingGeometry(_ node: OJPXML.Node, source: OJPSource) throws -> JSONValue {
        let track = try node.one("LegTrack") ?? node.one("PathGuidance")
        guard let track else { return .null }
        var sections = track.all("TrackSection")
        for section in track.all("PathGuidanceSection") { if let part = try section.one("TrackSection") { sections.append(part) } }
        guard sections.count <= 30 else { throw OJPError.invalid("Walking section limit") }
        var points: [[Double]] = []
        for section in sections {
            guard let projection = try section.one("LinkProjection") else { return .null }
            let nodes = projection.all("Position")
            guard points.count + nodes.count <= 10_000 else { throw OJPError.invalid("Walking geometry limit") }
            let part = try nodes.compactMap { try OJPDecoder.coordinate($0) }
            guard part.count >= 2, points.isEmpty || points.last == part.first else { return .null }
            points.append(contentsOf: points.isEmpty ? part : Array(part.dropFirst()))
        }
        guard points.count >= 2 else { return .null }
        return .object(["type": .string("LineString"), "quality": .string("routed"), "coordinates": .array(points.map { .array($0.map(JSONValue.number)) }), "evidence": source.evidence()])
    }
    static func journeys(_ response: OJPResponseData, origin: Place, destination: Place, departure: Date, arriveBy: Bool, preferences: JSONValue) throws -> [Journey] {
        let delivery = try OJPXML.delivery(OJPXML.parse(response.data), kind: "OJPTripDelivery")
        let source = try OJPSource.make(delivery, data: response.data, acquiredAt: response.acquiredAt, httpDate: response.httpDate)
        let context = try OJPDecoder.places(delivery, contextName: "TripResponseContext")
        let results = delivery.all("TripResult")
        var journeys: [Journey] = []
        for result in results.prefix(4) {
            do { journeys.append(try journey(result, context: context, source: source, origin: origin, destination: destination, departure: departure, arriveBy: arriveBy, preferences: preferences)) }
            catch { continue } // An invalid complete alternative is omitted, never partly connected.
        }
        if journeys.isEmpty && !results.isEmpty { throw OJPError.invalid("Returned alternatives do not match requested time, call order or supported leg structure") }
        return journeys
    }
    private static func journey(_ result: OJPXML.Node, context: [String: OJPPlaceContext], source: OJPSource,
                                origin: Place, destination: Place, departure: Date, arriveBy: Bool, preferences: JSONValue) throws -> Journey {
        guard try result.one("ErrorCondition") == nil, let trip = try result.one("Trip"),
              let start = try OJPIdentity.date(trip.required("StartTime")), let end = try OJPIdentity.date(trip.required("EndTime")), end >= start,
              end.timeIntervalSince(start) <= 48 * 3600 else { throw OJPError.invalid("Invalid trip interval") }
        let requestedDifference = arriveBy ? departure.timeIntervalSince(end) : start.timeIntervalSince(departure)
        guard (-60...21_600).contains(requestedDifference) else { throw OJPError.invalid("Planner returned a trip outside the requested time window") }
        let id = "ojp:journey:" + OJPIdentity.digest(.array([.string(origin.id), .string(destination.id), .string(source.sha256), .string(try trip.required("Id"))]))
        let nodes = trip.all("Leg"); guard (1...12).contains(nodes.count) else { throw OJPError.invalid("Unsupported leg count") }
        var legs: [JSONValue] = [], cursor = start
        var warnings = ["Service references belong to transport.opendata.ch/ojp20, not the national planner or a signed vehicle identity.",
            "Response times describe source generation, not measured vehicle observation. Estimates and platform labels require checking local signs.",
            "Walking geometry is mapped; crossings, entrances, levels and waiting areas are unverified. Ride lines remain schematic."]
        func gap(_ from: Place, _ to: Place, _ begin: Date, _ finish: Date, kind: String) -> JSONValue {
            var value = base(id: id + ":gap:\(legs.count)", kind: kind, from: from, to: to, start: begin, end: finish, source: source)
            value["distanceMeters"] = .null
            value["instructions"] = .array([.object(["id": .string(id + ":gap-instruction:\(legs.count)"), "text": .string("Access path and walking time are unknown. Check local signs and allow additional time."), "kind": .string("unknown"), "coordinate": .null])])
            return value
        }
        for (index, node) in nodes.enumerated() {
            let legID = id + ":leg:\(index)"
            let timed = try node.one("TimedLeg"), transfer = try node.one("TransferLeg"), continuous = try node.one("ContinuousLeg")
            guard [timed, transfer, continuous].compactMap({ $0 }).count == 1 else { throw OJPError.invalid("Ambiguous leg type") }
            var leg: JSONValue
            if let timed {
                guard let service = try timed.one("Service"), let board = try timed.one("LegBoard"), let alight = try timed.one("LegAlight") else { throw OJPError.invalid("Missing service endpoints") }
                let occurrence = try OJPDecoder.occurrence(service)
                let cancelled = try service.flag("Cancelled")
                guard cancelled != true else { throw OJPError.invalid("Cancelled itinerary service") }
                let intermediates = timed.all("LegIntermediate")
                guard intermediates.count <= 158 else { throw OJPError.invalid("Ride call limit") }
                let calls = try ([board] + intermediates + [alight]).map { try OJPDecoder.call($0, places: context) }
                try OJPDecoder.validateOrder(calls)
                guard let first = calls.first, let last = calls.last, let begin = first.plannedDeparture, let finish = last.plannedArrival,
                      first.noBoarding != true, last.noAlighting != true, first.notServiced != true, last.notServiced != true else { throw OJPError.invalid("Unusable selected service calls") }
                let wireCalls = calls.map { call($0, occurrence: occurrence, id: "\(legID):call:\($0.order)", source: source, cancelled: cancelled) }
                leg = base(id: legID, kind: "ride", from: first.place(source: source), to: last.place(source: source), start: begin, end: finish, source: source)
                leg["expectedStart"] = .optional(first.expectedDeparture.map(WireClock.string)); leg["expectedEnd"] = .optional(last.expectedArrival.map(WireClock.string))
                let mode = try service.one("Mode")?.value("PtMode") ?? "unknown"
                leg["mode"] = .string(["bus","tram","train","boat","cableway"].contains(mode) ? mode : mode == "rail" ? "train" : mode == "water" ? "boat" : "unknown")
                leg["line"] = .optional(try service.value("PublicCode")); leg["headsign"] = .optional(try service.label("DestinationText"))
                leg["directionId"] = .optional(try service.value("DirectionRef", ns: OJPXML.siri))
                leg["trip"] = occurrence.wire; leg["calls"] = .array(wireCalls)
                leg["boardingCallId"] = wireCalls[0]["id"]; leg["alightingCallId"] = wireCalls.last!["id"]
                leg["boardingTarget"] = target(call: wireCalls[0], source: source)
                leg["ojpSource"] = source.raw
                leg["evidence"] = source.evidence(predicted: first.expectedDeparture != nil || last.expectedArrival != nil)
                if calls.allSatisfy({ $0.coordinate != nil }) {
                    leg["geometry"] = .object(["type": .string("LineString"), "quality": .string("schematic"), "coordinates": .array(calls.map { .array($0.coordinate!.map(JSONValue.number)) }), "evidence": source.evidence()])
                }
                leg["instructions"] = .array([.object(["id": .string(legID + ":board"), "kind": .string("board"), "coordinate": .null,
                    "text": .string("Check the original line, destination and platform signs. Source service identity does not identify the physical vehicle or waiting area.")])])
            } else {
                let walk = transfer ?? continuous!
                if let continuous, let service = try continuous.one("Service"), try service.value("PersonalMode") != "foot" { throw OJPError.invalid("Unsupported continuous mode") }
                guard let fromNode = try walk.one("LegStart"), let toNode = try walk.one("LegEnd") else { throw OJPError.invalid("Missing walk endpoints") }
                var from = try place(fromNode, context: context, source: source), to = try place(toNode, context: context, source: source)
                if index == 0, from.kind == "coordinate", from.coordinate == origin.coordinate { from = origin }
                if index == nodes.count - 1, to.kind == "coordinate", to.coordinate == destination.coordinate { to = destination }
                let seconds = try duration(walk.required("Duration")), finish = cursor.addingTimeInterval(seconds)
                leg = base(id: legID, kind: transfer == nil ? "walk" : "transfer", from: from, to: to, start: cursor, end: finish, source: source)
                leg["distanceMeters"] = .null; leg["geometry"] = try walkingGeometry(walk, source: source)
                leg["instructions"] = .array([.object(["id": .string(legID + ":walk"), "kind": .string("walk"), "coordinate": .null,
                    "text": .string("Follow the mapped walking guidance and local signs. Crossings and step-free access are unverified.")])])
            }
            let from = Place(raw: leg["from"]), begin = try OJPIdentity.date(leg["plannedStart"].string)!
            guard begin >= cursor, let finish = try OJPIdentity.date(leg["plannedEnd"].string), finish <= end else { throw OJPError.invalid("Disconnected journey timing") }
            if legs.isEmpty, origin.id != from.id {
                legs.append(gap(origin, from, begin, begin, kind: "walk")); warnings.append("Origin access duration is unknown and excluded from the timetable.")
            } else if let previous = legs.last, previous["to"]["id"] != leg["from"]["id"] {
                legs.append(gap(Place(raw: previous["to"]), from, cursor, begin, kind: "transfer")); warnings.append("A transfer connection has no verified pedestrian path.")
            }
            legs.append(leg); cursor = finish
        }
        guard cursor == end, let last = legs.last else { throw OJPError.invalid("Trip end differs from final leg") }
        if last["to"]["id"].string != destination.id { legs.append(gap(Place(raw: last["to"]), destination, end, end, kind: "walk")); warnings.append("Destination access duration is unknown and excluded from the timetable.") }
        if preferences["stepFree"].bool == true { warnings.append("Step-free preference cannot be verified by this source.") }
        return Journey(raw: .object(["schemaVersion": .number(1), "id": .string(id), "revision": .number(0), "origin": origin.raw, "destination": destination.raw,
            "preferences": preferences, "legs": .array(legs), "durationSeconds": .number(end.timeIntervalSince(start)), "warnings": .array(warnings.map(JSONValue.string)),
            "evidence": source.evidence(), "ojpSource": source.raw]))
    }
}
