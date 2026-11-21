import Foundation

public struct OJPResponseData: Sendable {
    public let data: Data
    public let acquiredAt: Date
    public let httpDate: String?
    public init(data: Data, acquiredAt: Date, httpDate: String? = nil) { self.data = data; self.acquiredAt = acquiredAt; self.httpDate = httpDate }
}
public protocol OJPTransport: Sendable { func send(_ xml: Data) async throws -> OJPResponseData }

private final class OJPRedirectPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // POST payload semantics must not be lost on redirect.
        completionHandler(nil)
    }
}
public actor PublicOJPTransport: OJPTransport {
    private let session: URLSession
    private var retryAfter: Date?
    public init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 25
        config.requestCachePolicy = .reloadIgnoringLocalCacheData; config.urlCache = nil
        session = URLSession(configuration: config, delegate: OJPRedirectPolicy(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
    public func send(_ xml: Data) async throws -> OJPResponseData {
        guard xml.count <= 32_000 else { throw OJPError.invalid("Oversized request") }
        if let retryAfter, retryAfter > Date() { throw OJPError.unavailable("Service source requested a pause. Try again later.") }
        var request = URLRequest(url: URL(string: OJPIdentity.provider)!)
        request.httpMethod = "POST"; request.httpBody = xml
        request.setValue("text/xml; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.setValue("text/xml, application/xml", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await session.bytes(for: request)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse else { throw OJPError.unavailable("Service source unavailable; current guidance is preserved.") }
        if http.statusCode == 429 || http.statusCode == 503 {
            let header = http.value(forHTTPHeaderField: "Retry-After") ?? "30"
            let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss z"
            let seconds = Double(header) ?? formatter.date(from: header)?.timeIntervalSinceNow ?? 30
            retryAfter = Date().addingTimeInterval(min(3600, max(1, seconds.isFinite ? seconds : 30)))
            throw OJPError.unavailable("Service source is busy. Respect its pause, then try again.")
        }
        guard (200...299).contains(http.statusCode) else { throw OJPError.unavailable("Service source returned HTTP \(http.statusCode). Current guidance is preserved; fresh community planning remains available.") }
        guard response.expectedContentLength <= 2_000_000 else { throw OJPError.invalid("Response size limit") }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 2_000_000 else { throw OJPError.invalid("Response size limit") }
            data.append(byte)
            if data.count % 16_384 == 0 { try Task.checkCancellation() }
        }
        try Task.checkCancellation()
        return OJPResponseData(data: data, acquiredAt: Date(), httpDate: http.value(forHTTPHeaderField: "Date"))
    }
}

enum OJPRequest {
    static func envelope(_ operation: String, fields: String, now: Date) -> Data {
        let stamp = OJPIdentity.requestTime(now)
        return Data("<OJP xmlns=\"\(OJPXML.ojp)\" xmlns:siri=\"\(OJPXML.siri)\" version=\"2.0\"><OJPRequest><siri:ServiceRequest><siri:RequestTimestamp>\(stamp)</siri:RequestTimestamp><siri:RequestorRef>rightside-ios</siri:RequestorRef><\(operation)><siri:RequestTimestamp>\(stamp)</siri:RequestTimestamp>\(fields)</\(operation)></siri:ServiceRequest></OJPRequest></OJP>".utf8)
    }
    static func place(_ place: Place) throws -> String {
        guard !place.name.isEmpty, place.name.utf8.count <= 500 else { throw OJPError.invalid("Invalid planning place") }
        let refs = place.raw["sourceRefs"].array.filter { $0["provider"].string == OJPIdentity.provider }
        let location: String
        if !refs.isEmpty {
            let ids = refs.compactMap { $0["id"].string }
            guard ids.count == refs.count, Set(ids).count == 1, let ref = ids.first, OJPIdentity.stop(ref) else { throw OJPError.invalid("Ambiguous OJP stop reference") }
            let parts = ref.split(separator: ":")
            location = parts.count == 4 ? "<StopPlaceRef>\(OJPXML.escape(ref))</StopPlaceRef>" : "<siri:StopPointRef>\(OJPXML.escape(ref))</siri:StopPointRef>"
        } else if let id = DepartureStop.id(for: place) {
            // The endpoint explicitly accepts DiDok IDs; keep that namespace in the request.
            location = "<StopPlaceRef>\(id)</StopPlaceRef>"
        } else if let c = place.coordinate, c.count == 2, c.allSatisfy(\.isFinite), abs(c[0]) <= 180, abs(c[1]) <= 90 {
            location = "<GeoPosition><siri:Longitude>\(c[0])</siri:Longitude><siri:Latitude>\(c[1])</siri:Latitude></GeoPosition>"
        } else { throw OJPError.invalid("No supported stop identity or coordinate") }
        return "<PlaceRef>\(location)<Name><Text>\(OJPXML.escape(place.name))</Text></Name></PlaceRef>"
    }
    static func plan(origin: Place, destination: Place, departure: Date, arriveBy: Bool, now: Date = Date()) throws -> Data {
        guard departure.timeIntervalSince1970.isFinite else { throw OJPError.invalid("Invalid planning time") }
        let time = "<DepArrTime>\(OJPIdentity.requestTime(departure))</DepArrTime>"
        let fields = try "<Origin>\(place(origin))\(arriveBy ? "" : time)</Origin><Destination>\(place(destination))\(arriveBy ? time : "")</Destination><Params><NumberOfResults>4</NumberOfResults><IncludeIntermediateStops>true</IncludeIntermediateStops></Params>"
        return envelope("OJPTripRequest", fields: fields, now: now)
    }
    static func service(_ occurrence: OJPOccurrence, now: Date = Date()) throws -> Data {
        guard occurrence.valid else { throw OJPError.invalid("Unsupported occurrence") }
        return envelope("OJPTripInfoRequest", fields: "<JourneyRef>\(OJPXML.escape(occurrence.journeyRef))</JourneyRef><OperatingDayRef>\(occurrence.operatingDay)</OperatingDayRef><Params><IncludeCalls>true</IncludeCalls><UseRealtimeData>explanatory</UseRealtimeData></Params>", now: now)
    }
}
