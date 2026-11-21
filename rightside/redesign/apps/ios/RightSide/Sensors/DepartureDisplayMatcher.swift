import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// One service that can plausibly arrive at this stop soon: the selected ride, or another row
/// of the stop's departure board. Only line and destination are compared with the display.
struct DisplayCandidate: Equatable {
    let line: String
    let destination: String
    /// Intermediate calls a display may show instead of, or before, the final destination.
    var vias: [String] = []
    var isExpected = false

    var lineKey: String { DisplayText.lineKey(line) }
    var identity: String { lineKey + "|" + DisplayText.canonical(destination) }
}

/// How the observed route numeral relates to a candidate's line.
enum DisplayLineEvidence: String, Equatable {
    /// The display shows this line, as read.
    case exact
    /// Equal only after mapping glyphs OCR commonly confuses on LED displays (O/0, I/1, S/5, B/8, Z/2, G/6).
    case confusable
    /// No route numeral was read.
    case unseen
    /// A route numeral was read and it is a different line.
    case contradicted
}

struct DisplayCandidateScore: Equatable {
    let candidate: DisplayCandidate
    /// 0...1, character similarity of the best matching display row (or row window).
    let destination: Double
    let line: DisplayLineEvidence
    /// Observed text that produced `destination`.
    let observed: String
    /// OCR confidence of that text (lowest fragment score of the row), 0…1.
    var ocrScore = 1.0
    /// 0…1 likelihood from live vehicle positions, GPS and compass (VehiclePositionEvidence); 0 when unknown.
    var position = 0.0
    /// Position evidence can tip a near-tie (tram 9 vs 20 to the same stop) but is capped below the
    /// display-text terms, so it never outweighs a readable, different display.
    static let positionWeight = 0.3
    var total: Double {
        let lineTerm: Double
        switch line {
        case .exact: lineTerm = 0.6
        case .confusable: lineTerm = 0.45
        case .unseen: lineTerm = 0
        case .contradicted: lineTerm = -0.6
        }
        return destination + lineTerm + position * Self.positionWeight
    }
}

/// Result of comparing one frame's display text with every candidate service.
struct DisplayBoardMatch: Equatable {
    enum Outcome: String, Equatable {
        /// One candidate explains the display clearly better than every other service.
        case matched
        /// Destination text is readable and fits a candidate, but another service fits almost as well.
        case ambiguous
        /// Readable destination-like text that fits no listed service (another direction, a diversion,
        /// or a service missing from the board). Never treated as the selected ride.
        case unlisted
        /// Too little text to compare.
        case unreadable
    }
    let outcome: Outcome
    let best: DisplayCandidateScore?
    let runnerUp: DisplayCandidateScore?
    var margin: Double { (best?.total ?? 0) - (runnerUp?.total ?? 0) }

    /// How much this one frame's reading can be trusted, 0…1: destination fit × route-numeral evidence ×
    /// margin over the next service × the OCR engine's own score. The segmentation quality of the frame
    /// (detector score, vehicle size) is applied by the caller, which knows the detection.
    var confidence: Double {
        guard outcome != .unreadable, let best else { return 0 }
        let line: Double
        switch best.line {
        case .exact: line = 1
        case .confusable: line = 0.85
        case .unseen: line = 0.7
        case .contradicted: line = 0.3
        }
        let marginFactor = 0.5 + 0.5 * min(1, max(0, margin) / 0.5)
        return min(1, best.destination) * line * marginFactor * (0.6 + 0.4 * min(1, max(0, best.ocrScore)))
    }
}

/// Closed-set reading: the display is compared with the services that can actually stop here,
/// instead of trusting an exact free-text spelling. OCR output is never rewritten; a candidate only
/// wins when it explains the observed glyphs clearly better than every other listed service.
enum DepartureDisplayMatcher {
    /// Minimum similarity of the destination text on its own.
    static let destinationAccept = 0.8
    /// Lower destination similarity is enough when the route numeral agrees.
    static let destinationAcceptWithLine = 0.7
    /// Best must beat the best *different* service by this much (score units; line exact = 0.6).
    static let marginAccept = 0.25
    /// Readable text this unlike every candidate is reported as an unlisted display.
    static let unlistedBelow = 0.5

    /// Same as `match`, memoised per camera frame: the live matcher re-evaluates each recent frame
    /// several times while it stays in the 2 s decision window.
    static func match(_ vehicleTexts: [VehicleText], candidates: [DisplayCandidate], frameID: UUID,
                      positions: [String: Double] = [:]) -> DisplayBoardMatch {
        // Several vehicles share a frame: the key includes this vehicle's own text and boxes, not just the frame.
        var parts: [String] = [frameID.uuidString]
        for t in vehicleTexts {
            let box = [t.box.minX, t.box.minY, t.box.width, t.box.height].map { String(Int(Double($0) * 10_000)) }.joined(separator: ",")
            parts.append(t.text + "@" + box + "," + String(Int(t.score * 1000)))
        }
        parts.append(candidates.map(\.identity).joined(separator: ";"))
        for (identity, value) in positions.sorted(by: { $0.key < $1.key }) { parts.append(identity + "=" + String(Int(value * 100))) }
        let key = parts.joined(separator: "|")
        if let cached = cache.value(key) { return cached }
        let result = match(vehicleTexts, candidates: candidates, positions: positions)
        cache.store(key, result)
        return result
    }
    private static let cache = MatchCache()

    /// `positions`: optional per-identity likelihoods from VehiclePositionEvidence for this detection.
    static func match(_ texts: [VehicleText], candidates: [DisplayCandidate], positions: [String: Double] = [:]) -> DisplayBoardMatch {
        let rows = DisplayRows.make(texts)
        let routeTokens = rows.flatMap(\.routeTokens)
        guard !candidates.isEmpty, rows.contains(where: { $0.letterCount >= 3 }) || !routeTokens.isEmpty else {
            return DisplayBoardMatch(outcome: .unreadable, best: nil, runnerUp: nil)
        }
        // Services with the same line and destination are one display identity.
        var byIdentity: [String: DisplayCandidate] = [:]
        var order: [String] = []
        for candidate in candidates where !candidate.line.isEmpty && !candidate.destination.isEmpty {
            let key = candidate.identity
            if let existing = byIdentity[key] {
                if candidate.isExpected && !existing.isExpected { byIdentity[key] = candidate }
            } else { byIdentity[key] = candidate; order.append(key) }
        }
        let frameWindows = windows(rows)
        let scores = order.compactMap { byIdentity[$0] }.map { candidate -> DisplayCandidateScore in
            var s = score(candidate, windows: frameWindows, routeTokens: routeTokens)
            s.position = positions[candidate.identity] ?? 0
            return s
        }
            .sorted { $0.total > $1.total }
        guard let best = scores.first else { return DisplayBoardMatch(outcome: .unreadable, best: nil, runnerUp: nil) }
        // The runner-up is the best service that would show a *different* display.
        let runnerUp = scores.dropFirst().first { !sameDisplay($0.candidate, best.candidate) }
        let readableDestination = rows.contains { $0.letterCount >= 4 }
        let accepted = best.destination >= destinationAccept
            || (best.destination >= destinationAcceptWithLine && [.exact, .confusable].contains(best.line))
        if accepted && best.line != .contradicted {
            let margin = best.total - (runnerUp?.total ?? 0)
            return DisplayBoardMatch(outcome: margin >= marginAccept ? .matched : .ambiguous, best: best, runnerUp: runnerUp)
        }
        if readableDestination && best.destination < unlistedBelow {
            return DisplayBoardMatch(outcome: .unlisted, best: best, runnerUp: runnerUp)
        }
        return DisplayBoardMatch(outcome: readableDestination ? .ambiguous : .unreadable, best: best, runnerUp: runnerUp)
    }

    static func sameDisplay(_ a: DisplayCandidate, _ b: DisplayCandidate) -> Bool {
        a.lineKey == b.lineKey && sameDestination(a.destination, b.destination)
    }

    /// Whether two names are the same destination. Only full renderings count (weight 1 variants), so a shared
    /// generic part ("Bahnhof" of "Bern, Bahnhof" and "Bern Wankdorf, Bahnhof") or a shared locality alone
    /// ("Wabern" of two Wabern stops) never makes two destinations one.
    static func sameDestination(_ a: String, _ b: String, threshold: Double = 0.9) -> Bool {
        let x = DisplayText.weightedVariants(a).filter { $0.weight >= 1 }, y = DisplayText.weightedVariants(b).filter { $0.weight >= 1 }
        for u in x { for v in y where DisplayText.similarity(u.words.joined(), v.words.joined()) >= threshold { return true } }
        return false
    }

    /// Similarity of two destination names as a display would render them (locality prefix optional). Loose on
    /// purpose: used only to tell a misread or shortened display of the expected destination from a different one.
    static func destinationSimilarity(_ a: String, _ b: String) -> Double {
        var best = 0.0
        for x in DisplayText.variants(a) { for y in DisplayText.variants(b) {
            best = max(best, DisplayText.similarity(x.joined(), y.joined()))
        } }
        return best
    }

    /// A contiguous run of destination words from one display row, as ASCII bytes.
    struct Window { let bytes: [UInt8]; let text: String; let weight: Double; var score: Double = 1 }

    /// Every window of up to six words per row, shared by all candidates of one frame.
    static func windows(_ rows: [DisplayRows.Row]) -> [Window] {
        var result: [Window] = []
        var index: [[UInt8]: Int] = [:]
        for row in rows {
            let words = row.isVia ? Array(row.destinationWords.dropFirst()) : row.destinationWords
            // A via row ("via Bahnhof") is weaker evidence for the destination itself.
            let weight = (row.isVia ? 0.7 : 1.0) * row.weight
            for start in words.indices {
                var bytes: [UInt8] = []
                for end in start..<min(words.count, start + 6) {
                    bytes.append(contentsOf: words[end].utf8)
                    if bytes.count > 48 { break }
                    if let existing = index[bytes] {
                        if result[existing].weight < weight || (result[existing].weight == weight && result[existing].score < row.score) {
                            result[existing] = Window(bytes: bytes, text: words[start...end].joined(separator: " "), weight: weight, score: row.score)
                        }
                    } else {
                        index[bytes] = result.count
                        result.append(Window(bytes: bytes, text: words[start...end].joined(separator: " "), weight: weight, score: row.score))
                    }
                }
            }
        }
        return result
    }

    static func score(_ candidate: DisplayCandidate, rows: [DisplayRows.Row], routeTokens: [String]) -> DisplayCandidateScore {
        score(candidate, windows: windows(rows), routeTokens: routeTokens)
    }

    static func score(_ candidate: DisplayCandidate, windows: [Window], routeTokens: [String]) -> DisplayCandidateScore {
        // A via shown on its own is weaker evidence than the destination.
        let variants = DisplayText.weightedVariants(candidate.destination)
            + candidate.vias.prefix(4).flatMap(DisplayText.weightedVariants).map { (words: $0.words, weight: $0.weight * 0.9) }
        var bestSimilarity = 0.0, bestText = "", bestScore = 1.0
        for variant in variants {
            let target = Array(variant.words.joined().utf8)
            guard !target.isEmpty else { continue }
            // Every window of every row, so extra words (a via, "Linie", an advert fragment) do not hide
            // an otherwise exact destination.
            for window in windows {
                let weight = variant.weight * window.weight
                let (a, b) = (window.bytes.count, target.count)
                if a > b * 2 + 4 { continue }
                // Levenshtein similarity cannot exceed shorter/longer length: skip hopeless windows.
                if Double(min(a, b)) / Double(max(a, b)) * weight <= bestSimilarity { continue }
                let similarity = DisplayText.similarity(bytes: target, window.bytes) * weight
                if similarity > bestSimilarity { bestSimilarity = similarity; bestText = window.text; bestScore = window.score }
            }
        }
        let key = candidate.lineKey
        let line: DisplayLineEvidence
        if routeTokens.isEmpty { line = .unseen }
        else if routeTokens.contains(key) { line = .exact }
        else if routeTokens.contains(where: { DisplayText.confusionKey($0) == DisplayText.confusionKey(key) }) { line = .confusable }
        // "9" read from a "19" display (a dropped digit) neither confirms nor contradicts line 19.
        else if routeTokens.contains(where: { $0.count < key.count && (key.hasSuffix($0) || key.hasPrefix($0)) }) { line = .unseen }
        else { line = .contradicted }
        return DisplayCandidateScore(candidate: candidate, destination: bestSimilarity, line: line, observed: bestText, ocrScore: bestScore)
    }
}

/// Groups OCR fragments into display rows and separates route numerals from destination words.
enum DisplayRows {
    struct Row {
        let words: [String]
        let routeTokens: [String]
        let destinationWords: [String]
        /// Text height relative to the tallest text on this vehicle: smaller rows (vias, adverts) weigh less.
        var weight = 1.0
        /// Lowest OCR score among the fragments of this row.
        var score = 1.0
        /// "via Bahnhof": an intermediate stop, weaker evidence for the destination itself.
        var isVia: Bool { words.count > 1 && ["via", "uber", "ia", "vla", "vio", "va", "ria", "wia"].contains(words[0]) }
        var letterCount: Int { destinationWords.joined().filter(\.isLetter).count }
    }

    /// Operator brands and vehicle labels that are never a destination.
    static let ignoredWords: Set<String> = ["bernmobil", "hybrid", "postauto", "sbb", "bls", "vbz", "bvb", "tpg", "tl", "rbs", "linie", "line", "ligne"]

    static func make(_ texts: [VehicleText]) -> [Row] {
        let usable = texts.filter { $0.score.isFinite && $0.score >= 0.3 && !$0.box.isEmpty }
            .sorted { $0.box.midY < $1.box.midY }
        // Destination rows are the largest text of a display; compare row heights with the tallest
        // text that contains letters (a lone big route numeral is not the reference).
        let tallest = usable.filter { $0.text.contains(where: \.isLetter) }.map(\.box.height).max() ?? 0
        // Collinear fragments (same display row) are joined left to right; each fragment also stays a row
        // of its own, so a wrong join never removes evidence.
        var groups: [[VehicleText]] = []
        for text in usable {
            if let index = groups.firstIndex(where: { group in
                let reference = group[0]
                let height = max(reference.box.height, text.box.height)
                return abs(reference.box.midY - text.box.midY) <= height * 0.35
                    && text.box.height / max(reference.box.height, 0.000001) <= 2.2
                    && text.box.height / max(reference.box.height, 0.000001) >= 0.45
            }) { groups[index].append(text) } else { groups.append([text]) }
        }
        var rows: [Row] = []
        var seen = Set<String>()
        func add(_ value: String, height: CGFloat, score: Float) {
            let words = DisplayText.words(value).filter { !ignoredWords.contains($0) }
            guard !words.isEmpty, seen.insert(words.joined(separator: " ")).inserted else { return }
            // A numeral starting with 0 ("000", "B00") is a misread: no Swiss line number starts with 0.
            let routes = words.filter { DisplayText.isRouteToken($0) && !$0.drop { $0.isLetter }.hasPrefix("0") }.map(DisplayText.lineKey)
            // Route numerals are excluded from destination comparison; other short digit runs
            // (a platform, a fleet number) stay, because some destinations contain numbers.
            let destination = words.filter { !DisplayText.isRouteToken($0) }
            var row = Row(words: words, routeTokens: routes, destinationWords: destination)
            if tallest > 0 { row.weight = height >= tallest * 0.75 ? 1 : 0.8 }
            row.score = Double(score)
            rows.append(row)
        }
        for group in groups {
            if group.count > 1 {
                add(group.sorted { $0.box.minX < $1.box.minX }.map(\.text).joined(separator: " "),
                    height: group.map(\.box.height).max() ?? 0, score: group.map(\.score).min() ?? 0)
            }
            for text in group { add(text.text, height: text.box.height, score: text.score) }
        }
        return rows
    }
}

/// Text normalisation for display comparison. No dictionary or language model is applied to OCR.
enum DisplayText {
    private static let abbreviations: [String: String] = [
        "bhf": "bahnhof", "bf": "bahnhof", "bahnhf": "bahnhof", "hbf": "hauptbahnhof", "hb": "hauptbahnhof",
        "str": "strasse", "pl": "platz", "stn": "station",
    ]

    /// Lowercased, accent-free alphanumeric words. "ß" becomes "ss"; known abbreviations are expanded.
    static func words(_ value: String) -> [String] {
        if let cached = wordCache.value(value) { return cached }
        let result = computeWords(value)
        wordCache.store(value, result)
        return result
    }
    private static let wordCache = WordCache()

    private static func computeWords(_ value: String) -> [String] {
        let folded = value.replacingOccurrences(of: "ß", with: "ss")
            .folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive], locale: Locale(identifier: "de_CH"))
            .lowercased()
        var result: [String] = []
        var current = ""
        for scalar in folded.unicodeScalars {
            if CharacterSet.alphanumerics.contains(scalar) && scalar.isASCII { current.unicodeScalars.append(scalar) }
            else if !current.isEmpty { result.append(current); current = "" }
        }
        if !current.isEmpty { result.append(current) }
        // OCR often glues the route numeral to the destination ("9Wankdorf"): split 1–3 leading digits
        // from three or more letters.
        var split: [String] = []
        for word in result {
            let digits = word.prefix { $0.isASCII && $0.isNumber }
            let rest = word.dropFirst(digits.count)
            if (1...3).contains(digits.count), rest.count >= 3, rest.allSatisfy({ $0.isASCII && $0.isLetter }) {
                split.append(String(digits)); split.append(String(rest))
            } else { split.append(word) }
        }
        var expanded: [String] = []
        for word in split {
            // "BernBhf" → "bern bahnhof" (glued abbreviation).
            if word.count > 4, word.hasSuffix("bhf") { expanded.append(String(word.dropLast(3))); expanded.append("bahnhof"); continue }
            expanded.append(abbreviations[word] ?? word)
        }
        return expanded
    }

    static func canonical(_ value: String) -> String { words(value).joined(separator: " ") }

    /// Route numerals on Swiss displays: 1–3 digits with an optional one- or two-letter prefix
    /// (N1, M15, S7, E, X) or a one-letter suffix (10E).
    static func isRouteToken(_ word: String) -> Bool {
        // ^[a-z]{0,2}\d{1,3}[a-z]?$ without a regular expression (called for every OCR word).
        let scalars = Array(word.unicodeScalars)
        var i = 0, letters = 0, digits = 0
        while i < scalars.count, (97...122).contains(scalars[i].value), letters < 3 { letters += 1; i += 1 }
        while i < scalars.count, (48...57).contains(scalars[i].value) { digits += 1; i += 1 }
        if i < scalars.count, (97...122).contains(scalars[i].value) { i += 1 }
        return letters <= 2 && (1...3).contains(digits) && i == scalars.count
    }

    static func lineKey(_ line: String) -> String {
        let joined = words(line).joined()
        // "Bus 10", "Tram 9", "B 10" all mean line 10 on the display.
        for prefix in ["bus", "tram", "nfb", "nft", "b", "t"] where joined.hasPrefix(prefix) {
            let rest = String(joined.dropFirst(prefix.count))
            if rest.range(of: #"^\d{1,3}[a-z]?$"#, options: .regularExpression) != nil { return rest }
        }
        return joined
    }

    static func confusionKey(_ token: String) -> String {
        let map: [Character: Character] = ["o": "0", "i": "1", "l": "1", "s": "5", "b": "8", "z": "2", "g": "6"]
        return String(token.map { map[$0] ?? $0 })
    }

    /// Display renderings of a destination name. "Bern, Wankdorf Bahnhof" is often shown as
    /// "Wankdorf Bahnhof", and "Bern, Bahnhof" as "Bahnhof" or "Bern Bahnhof".
    static func variants(_ destination: String) -> [[String]] { weightedVariants(destination).map(\.words) }

    /// Stop names after the comma that say little on their own ("Bern, Bahnhof" fits every "<Place>, Bahnhof").
    private static let genericStopWords: Set<String> = ["endstation", "busendstation", "tramendstation", "bahnhof", "post",
                                                        "dorf", "zentrum", "schleife", "station", "gare", "stazione"]
    /// Terminus words a display drops entirely ("Wabern, Tram-Endstation" shows "Wabern"). A station is not
    /// one of them: "Bern" alone is never a destination display, but it is on adverts ("SC Bern", "BERNMOBIL").
    private static let droppedTerminusWords: Set<String> = ["endstation", "busendstation", "tramendstation", "schleife", "post", "dorf"]

    /// Variants with a weight: the locality alone is slightly weaker evidence than a full name.
    static func weightedVariants(_ destination: String) -> [(words: [String], weight: Double)] {
        if let cached = variantCache.value(destination) { return cached }
        let result = computeVariants(destination)
        variantCache.store(destination, result)
        return result
    }
    private static let variantCache = VariantCache()

    private static func computeVariants(_ destination: String) -> [(words: [String], weight: Double)] {
        var result: [(words: [String], weight: Double)] = []
        func add(_ value: [String], _ weight: Double) {
            if !value.isEmpty && !result.contains(where: { $0.words == value }) { result.append((value, weight)) }
        }
        add(words(destination), 1)
        let parts = destination.split(separator: ",", maxSplits: 1).map(String.init)
        if parts.count == 2 {
            let locality = words(parts[0])
            let stop = words(parts[1])
            // "Bern Wankdorf, Bahnhof" is shown as "Wankdorf Bhf": the city word of a two-word locality is optional.
            if locality.count >= 2 { add(Array(locality.dropFirst()) + stop, 1) }
            if genericStopWords.contains(stop.joined()) || stop.allSatisfy({ genericStopWords.contains($0) }) {
                // "Bahnhof" alone fits every "<Place>, Bahnhof"; the locality is the distinctive part.
                if droppedTerminusWords.contains(stop.joined()) || stop.allSatisfy({ droppedTerminusWords.contains($0) }) {
                    add(words(parts[0]), 0.92)
                }
                add(stop, 0.75)
            } else {
                add(stop, 1)
            }
        }
        return result
    }

    /// 1 − Levenshtein distance / longer length, on space-free strings.
    static func similarity(_ a: String, _ b: String) -> Double {
        similarity(bytes: Array(words(a).joined().utf8), Array(words(b).joined().utf8))
    }

    /// Same on normalised ASCII bytes (the hot path).
    static func similarity(bytes x: [UInt8], _ y: [UInt8]) -> Double {
        guard !x.isEmpty || !y.isEmpty else { return 1 }
        guard !x.isEmpty, !y.isEmpty else { return 0 }
        var previous = (0...y.count).map(Double.init)
        var current = [Double](repeating: 0, count: y.count + 1)
        for i in 1...x.count {
            current[0] = Double(i)
            let xi = x[i - 1]
            for j in 1...y.count {
                let yj = y[j - 1]
                let cost = xi == yj || confusableBytes(xi, yj) ? 0 : similarLetters(xi, yj) ? 0.5 : 1
                current[j] = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
            }
            swap(&previous, &current)
        }
        return 1 - previous[y.count] / Double(max(x.count, y.count))
    }

    /// Letters that dot-matrix and LED displays render alike (a/o, c/e, f/t, h/b/n, i/l, u/v/w, m/w): half an edit.
    private static func similarLetters(_ a: UInt8, _ b: UInt8) -> Bool {
        switch (min(a, b), max(a, b)) {
        case (97, 111), (99, 101), (102, 116), (98, 104), (104, 110), (105, 108), (117, 118), (118, 119),
             (117, 119), (109, 119), (109, 110), (101, 111), (99, 111): return true
        default: return false
        }
    }

    /// O/0, I/1, L/1, I/L, S/5, B/8, Z/2, G/6: the same glyph shape on LED matrices.
    private static func confusableBytes(_ a: UInt8, _ b: UInt8) -> Bool {
        switch (a, b) {
        case (111, 48), (48, 111), (105, 49), (49, 105), (108, 49), (49, 108), (105, 108), (108, 105),
             (115, 53), (53, 115), (98, 56), (56, 98), (122, 50), (50, 122), (103, 54), (54, 103): return true
        default: return false
        }
    }

}

/// Small bounded memo shared by the camera's decision code; thread-safe because decisions may run off the main actor in tests.
final class MatchCache: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: DisplayBoardMatch] = [:]
    private var order: [String] = []
    func value(_ key: String) -> DisplayBoardMatch? { lock.lock(); defer { lock.unlock() }; return values[key] }
    func store(_ key: String, _ value: DisplayBoardMatch) {
        lock.lock(); defer { lock.unlock() }
        if values[key] == nil { order.append(key) }
        values[key] = value
        if order.count > 64 { values[order.removeFirst()] = nil }
    }
}

/// Destination spellings repeat every frame; normalising them once keeps per-frame matching cheap.
final class VariantCache: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: [(words: [String], weight: Double)]] = [:]
    func value(_ key: String) -> [(words: [String], weight: Double)]? { lock.lock(); defer { lock.unlock() }; return values[key] }
    func store(_ key: String, _ value: [(words: [String], weight: Double)]) {
        lock.lock(); defer { lock.unlock() }
        if values.count > 512 { values.removeAll() }
        values[key] = value
    }
}

final class WordCache: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: [String]] = [:]
    func value(_ key: String) -> [String]? { lock.lock(); defer { lock.unlock() }; return values[key] }
    func store(_ key: String, _ value: [String]) {
        lock.lock(); defer { lock.unlock() }
        if values.count > 4096 { values.removeAll() }
        values[key] = value
    }
}
