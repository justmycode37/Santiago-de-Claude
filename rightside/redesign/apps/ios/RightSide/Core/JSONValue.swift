import Foundation

/// Lossless wire storage. Schema validation is performed by the shared JS contracts.
public enum JSONValue: Codable, Equatable, Sendable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null

    public init(from decoder: Decoder) throws {
        let box = try decoder.singleValueContainer()
        if box.decodeNil() { self = .null }
        else if let value = try? box.decode(Bool.self) { self = .bool(value) }
        else if let value = try? box.decode(String.self) { self = .string(value) }
        else if let value = try? box.decode(Double.self) { self = .number(value) }
        else if let value = try? box.decode([JSONValue].self) { self = .array(value) }
        else { self = .object(try box.decode([String: JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var box = encoder.singleValueContainer()
        switch self {
        case .object(let v): try box.encode(v)
        case .array(let v): try box.encode(v)
        case .string(let v): try box.encode(v)
        case .number(let v): try box.encode(v)
        case .bool(let v): try box.encode(v)
        case .null: try box.encodeNil()
        }
    }
    public subscript(_ key: String) -> JSONValue {
        get { if case .object(let values) = self { return values[key] ?? .null }; return .null }
        set { if case .object(var values) = self { values[key] = newValue; self = .object(values) } }
    }
    public var string: String? { if case .string(let v) = self { return v }; return nil }
    public var double: Double? { if case .number(let v) = self { return v }; return nil }
    public var bool: Bool? { if case .bool(let v) = self { return v }; return nil }
    public var array: [JSONValue] { if case .array(let v) = self { return v }; return [] }
    public var strings: [String] { array.compactMap(\.string) }
    public var coordinate: [Double]? {
        guard case .array(let values) = self, values.count == 2, values.allSatisfy({ $0.double != nil }) else { return nil }
        return values.compactMap(\.double)
    }
    public static func optional(_ value: String?) -> JSONValue { value.map(JSONValue.string) ?? .null }
    public static func optional(_ value: Double?) -> JSONValue { value.map(JSONValue.number) ?? .null }
    public func encoded() throws -> String { String(decoding: try JSONEncoder().encode(self), as: UTF8.self) }
    public init(json: String) throws { self = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)) }
}

public protocol WireDTO: Codable, Equatable, Sendable {
    var raw: JSONValue { get }
    init(raw: JSONValue)
}
public extension WireDTO {
    init(from decoder: Decoder) throws { self.init(raw: try JSONValue(from: decoder)) }
    func encode(to encoder: Encoder) throws { try raw.encode(to: encoder) }
}

public enum NativeCoreError: LocalizedError {
    case message(String)
    public var errorDescription: String? { if case .message(let message) = self { return message }; return nil }
}

public enum WireClock {
    private static func formatter(fractional: Bool) -> ISO8601DateFormatter {
        let key = fractional ? "org.rightside.clock.fractional" : "org.rightside.clock.seconds"
        if let cached = Thread.current.threadDictionary[key] as? ISO8601DateFormatter { return cached }
        let value = ISO8601DateFormatter()
        value.formatOptions = fractional ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
        Thread.current.threadDictionary[key] = value
        return value
    }
    public static func string(_ date: Date = Date()) -> String { formatter(fractional: true).string(from: date) }
    public static func date(_ string: String) -> Date? {
        formatter(fractional: true).date(from: string) ?? formatter(fractional: false).date(from: string)
    }
}
