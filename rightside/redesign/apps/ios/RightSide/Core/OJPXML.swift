import Foundation

/// Small, bounded, namespace-qualified tree. No external resource or DTD processing.
struct OJPXML {
    static let ojp = "http://www.vdv.de/ojp"
    static let siri = "http://www.siri.org.uk/siri"
    final class Node {
        let name: String
        let namespace: String
        let attributes: [String: String]
        var text = ""
        var children: [Node] = []
        init(_ name: String, _ namespace: String, _ attributes: [String: String]) {
            self.name = name; self.namespace = namespace; self.attributes = attributes
        }
        func all(_ name: String, ns: String = OJPXML.ojp) -> [Node] { children.filter { $0.name == name && $0.namespace == ns } }
        func one(_ name: String, ns: String = OJPXML.ojp) throws -> Node? {
            let values = all(name, ns: ns)
            guard values.count <= 1 else { throw OJPError.invalid("Duplicate \(name)") }
            return values.first
        }
        func value(_ name: String, ns: String = OJPXML.ojp) throws -> String? {
            guard let node = try one(name, ns: ns) else { return nil }
            guard node.children.isEmpty else { throw OJPError.invalid("Non-scalar \(name)") }
            let value = node.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty, value.utf8.count <= 1024 else { throw OJPError.invalid("Invalid \(name)") }
            return value
        }
        func required(_ name: String, ns: String = OJPXML.ojp) throws -> String {
            guard let value = try value(name, ns: ns) else { throw OJPError.invalid("Missing \(name)") }
            return value
        }
        func label(_ name: String) throws -> String? { try one(name)?.value("Text") }
        func flag(_ name: String) throws -> Bool? {
            guard let value = try value(name) else { return nil }
            switch value { case "true", "1": return true; case "false", "0": return false; default: throw OJPError.invalid("Invalid \(name) flag") }
        }
    }
    private final class Reader: NSObject, XMLParserDelegate {
        var root: Node?
        var stack: [Node] = []
        var count = 0
        var textBytes = 0
        var failure: Error?
        func reject(_ parser: XMLParser, _ reason: String) { failure = OJPError.invalid(reason); parser.abortParsing() }
        func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
            count += 1
            guard count <= 30_000, stack.count < 32, attributes.count <= 12,
                  name.utf8.count <= 120, attributes.values.allSatisfy({ $0.utf8.count <= 2048 }) else { reject(parser, "XML structure exceeds local limit"); return }
            let node = Node(name, namespaceURI ?? "", attributes)
            if let parent = stack.last { parent.children.append(node) }
            else if root == nil { root = node }
            else { reject(parser, "Multiple XML roots"); return }
            stack.append(node)
        }
        func parser(_ parser: XMLParser, foundCharacters string: String) {
            if stack.isEmpty && string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return }
            textBytes += string.utf8.count
            guard textBytes <= 1_000_000, let node = stack.last, node.text.utf8.count + string.utf8.count <= 16_384 else {
                reject(parser, "XML text exceeds local limit"); return
            }
            node.text += string
        }
        func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) { if !stack.isEmpty { stack.removeLast() } }
        func parser(_ parser: XMLParser, resolveExternalEntityName name: String, systemID: String?) -> Data? { reject(parser, "External XML entities are unsupported"); return nil }
        func parser(_ parser: XMLParser, foundCDATA CDATABlock: Data) { reject(parser, "CDATA is unsupported in provider fields") }
    }
    static func parse(_ data: Data) throws -> Node {
        guard data.count <= 2_000_000, let text = String(data: data, encoding: .utf8),
              !text.uppercased().contains("<!DOCTYPE"), !text.uppercased().contains("<!ENTITY") else { throw OJPError.invalid("Oversized, non-UTF8 or DTD XML") }
        let reader = Reader(), parser = XMLParser(data: data)
        parser.shouldProcessNamespaces = true; parser.shouldResolveExternalEntities = false; parser.delegate = reader
        guard parser.parse(), reader.failure == nil, let root = reader.root, reader.stack.isEmpty,
              root.name == "OJP", root.namespace == ojp, root.attributes["version"] == "2.0" else {
            throw reader.failure ?? OJPError.invalid("Malformed OJP2 response")
        }
        return root
    }
    static func delivery(_ root: Node, kind: String) throws -> Node {
        guard let response = try root.one("OJPResponse"), let service = try response.one("ServiceDelivery", ns: siri),
              let delivery = try service.one(kind) else { throw OJPError.invalid("Missing \(kind)") }
        guard try delivery.one("ErrorCondition") == nil else { throw OJPError.invalid("Provider returned an OJP error") }
        return delivery
    }
    static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "'", with: "&apos;")
    }
}

enum OJPError: LocalizedError {
    case invalid(String), unavailable(String)
    var errorDescription: String? {
        switch self { case .invalid(let text): return "Service source could not be validated: \(text). Current guidance is preserved."
        case .unavailable(let text): return text }
    }
}
