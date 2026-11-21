import Foundation

private final class TransportRedirectPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(request.url?.scheme == "https" && request.url?.host == "transport.opendata.ch" ? request : nil)
    }
}

/// Direct public HTTPS source. It does not depend on the Windows API or sign IDs.
public protocol TransitTransport: Sendable {
    func places(_ query: String) async throws -> JSONValue
    func connections(origin: Place, destination: Place, departure: Date, arriveBy: Bool) async throws -> JSONValue
}

public actor CommunityTransport: TransitTransport {
    private let session: URLSession
    private var retryAfter: Date?
    public init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 25
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        session = URLSession(configuration: configuration, delegate: TransportRedirectPolicy(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }

    public func places(_ query: String) async throws -> JSONValue {
        try await request("locations", [URLQueryItem(name: "query", value: query), URLQueryItem(name: "type", value: "all")])
    }

    public func connections(origin: Place, destination: Place, departure: Date, arriveBy: Bool) async throws -> JSONValue {
        let date = DateFormatter()
        date.locale = Locale(identifier: "en_US_POSIX")
        date.calendar = Calendar(identifier: .gregorian)
        date.timeZone = TimeZone(identifier: "Europe/Zurich")
        date.dateFormat = "yyyy-MM-dd"
        let day = date.string(from: departure)
        date.dateFormat = "HH:mm"
        return try await request("connections", [
            URLQueryItem(name: "from", value: Self.placeQuery(origin)),
            URLQueryItem(name: "to", value: Self.placeQuery(destination)),
            URLQueryItem(name: "date", value: day),
            URLQueryItem(name: "time", value: date.string(from: departure)),
            URLQueryItem(name: "isArrivalTime", value: arriveBy ? "1" : "0"),
            URLQueryItem(name: "limit", value: "4")
        ])
    }
    public static func placeQuery(_ place: Place) -> String {
        if let ref = place.raw["sourceRefs"].array.first(where: { $0["provider"].string == "transport.opendata.ch" }), let id = ref["id"].string { return id }
        if let coordinate = place.coordinate { return "\(coordinate[1]),\(coordinate[0])" }
        return place.name
    }
    private func request(_ path: String, _ query: [URLQueryItem]) async throws -> JSONValue {
        if let retryAfter, retryAfter > Date() { throw NativeCoreError.message("Transit source requested a pause. Try again in \(Int(ceil(retryAfter.timeIntervalSinceNow))) seconds.") }
        var components = URLComponents()
        components.scheme = "https"; components.host = "transport.opendata.ch"; components.path = "/v1/\(path)"; components.queryItems = query
        guard let url = components.url else { throw NativeCoreError.message("Invalid transit request") }
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await session.bytes(for: request)
        try Task.checkCancellation()
        if let http = response as? HTTPURLResponse, http.statusCode == 429 || http.statusCode == 503 {
            let header = http.value(forHTTPHeaderField: "Retry-After") ?? "30"
            let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss z"
            let delay = Double(header) ?? formatter.date(from: header)?.timeIntervalSinceNow ?? 30
            retryAfter = Date().addingTimeInterval(min(3600, max(1, delay.isFinite ? delay : 30)))
            throw NativeCoreError.message("Transit source is busy. Try again after its requested pause.")
        }
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { throw NativeCoreError.message("Transit source unavailable. Try again later or use the saved journey.") }
        guard response.expectedContentLength <= 8_000_000 else { throw NativeCoreError.message("Transit response exceeded the local limit.") }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 8_000_000 else { throw NativeCoreError.message("Transit response exceeded the local limit.") }
            data.append(byte)
            if data.count % 65_536 == 0 { try Task.checkCancellation() }
        }
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }
}
