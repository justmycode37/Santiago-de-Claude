import Foundation

public protocol StopDepartureTransport: Sendable {
    func departures(stopID: String) async throws -> DepartureSnapshot
}

private final class DepartureRedirectPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(request.url?.scheme == "https" && request.url?.host == "transport.opendata.ch" ? request : nil)
    }
}

public actor PublicStopDepartureTransport: StopDepartureTransport {
    private let session: URLSession
    private var retryAfter: Date?
    public init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 25
        config.urlCache = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: config, delegate: DepartureRedirectPolicy(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
    public func departures(stopID: String) async throws -> DepartureSnapshot {
        guard DepartureStop.validID(stopID) else { throw NativeCoreError.message("Select an identified transit stop.") }
        if let retryAfter, retryAfter > Date() { throw NativeCoreError.message("Departure source requested a pause. Please try later.") }
        var url = URLComponents(string: "https://transport.opendata.ch/v1/stationboard")!
        url.queryItems = [URLQueryItem(name: "id", value: stopID), URLQueryItem(name: "limit", value: "40"), URLQueryItem(name: "type", value: "departure")]
        var request = URLRequest(url: url.url!); request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await session.bytes(for: request)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse else { throw NativeCoreError.message("Departure source unavailable.") }
        if http.statusCode == 429 || http.statusCode == 503 {
            let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss z"
            let header = http.value(forHTTPHeaderField: "Retry-After") ?? "30"
            let seconds = Double(header) ?? formatter.date(from: header)?.timeIntervalSinceNow ?? 30
            retryAfter = Date().addingTimeInterval(min(3600, max(1, seconds.isFinite ? seconds : 30)))
            throw NativeCoreError.message("Departure source is busy. Try again after its requested pause.")
        }
        guard (200...299).contains(http.statusCode) else { throw NativeCoreError.message("Departure source unavailable. Saved times may still be inspected.") }
        guard response.expectedContentLength <= 2_000_000 else { throw NativeCoreError.message("Departure response exceeds the local size limit.") }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 2_000_000 else { throw NativeCoreError.message("Departure response exceeds the local size limit.") }
            data.append(byte)
            if data.count % 16_384 == 0 { try Task.checkCancellation() }
        }
        try Task.checkCancellation()
        let acquired = Date()
        return try DepartureSnapshot.decode(data: data, stopID: stopID, acquiredAt: acquired,
            responseDate: http.value(forHTTPHeaderField: "Date"), now: acquired)
    }
}
