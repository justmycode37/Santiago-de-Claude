// Replays recorded OCR evidence through the app's own decision code (VehicleTextRules, VehicleServiceMatcher,
// DepartureDisplayMatcher) and compares three strategies on labelled vehicle passes:
//   A  baseline: the snapshot's exact-text rules (no low-confidence evidence, no departure board)
//   B  closed-set matching against the selected ride only (no board)
//   C  closed-set matching against the selected ride and the stop's departure board
// Build/run: ./run-eval.sh  (see README.md). Inputs are in data/.
import Foundation

struct OCRText: Decodable { let text: String; let score: Float; let box: [Double] }
struct OCRVehicle: Decodable { let kind: String; let score: Double; let box: [Double]; let texts: [OCRText] }
struct OCRFrame: Decodable { let image: String; let vehicles: [OCRVehicle] }
struct OCRFile: Decodable { let frames: [OCRFrame] }
struct Event: Decodable { let id: Int; let frames: [String] }
struct Events: Decodable { let events: [Event] }
struct Label: Decodable { let event: Int; let line: String; let destination: String }
struct Labels: Decodable { let labels: [Label] }
struct BoardRow: Decodable { let line: String; let destination: String; let category: String }
struct Board: Decodable { let candidates: [BoardRow] }

func load<T: Decodable>(_ type: T.Type, _ path: String) -> T {
    let data = try! Data(contentsOf: URL(fileURLWithPath: path))
    return try! JSONDecoder().decode(T.self, from: data)
}
let args = CommandLine.arguments
let dataDir = args.count > 1 ? args[1] : "data"
let ocr = load(OCRFile.self, dataDir + "/bern-video-ocr.json")
let events = load(Events.self, dataDir + "/bern-video-events.json").events
let labels = load(Labels.self, dataDir + "/bern-video-labels.json").labels
let board = load(Board.self, dataDir + "/bern-board.json").candidates.map { DisplayCandidate(line: $0.line, destination: $0.destination) }
let frames = Dictionary(uniqueKeysWithValues: ocr.frames.map { ($0.image, $0) })
let eventsByID = Dictionary(uniqueKeysWithValues: events.map { ($0.id, $0) })

func rect(_ b: [Double]) -> CGRect { CGRect(x: b[0], y: b[1], width: b[2], height: b[3]) }
let t0 = Date(timeIntervalSince1970: 1_800_000_000)
let step = 0.5 // frames are 1 s apart in the video; replayed 0.5 s apart (the app samples every 0.4 s)

/// Readings of the largest vehicle in each frame of a pass, exactly as the app builds them.
func readings(_ event: Event, keepObserved: Bool) -> (VehicleTrack, [Date]) {
    var result: [DisplayReading] = []
    var times: [Date] = []
    var detection: VehicleDetection?
    for (index, name) in event.frames.enumerated() {
        guard let frame = frames[name], let vehicle = frame.vehicles.max(by: { $0.box[3] < $1.box[3] }) else { continue }
        let kind: TransportClass = vehicle.kind == "tram" ? .tram : vehicle.kind == "train" ? .train : .bus
        let d = VehicleDetection(kind: kind, box: rect(vehicle.box), score: Float(vehicle.score),
                                 mask: VehicleMask(width: 4, height: 4, pixels: [UInt8](repeating: 1, count: 16)))
        let others = frame.vehicles.filter { $0.box != vehicle.box }.map { rect($0.box) }
        let texts = vehicle.texts.map { VehicleText(text: $0.text, box: rect($0.box), score: $0.score) }
        let at = t0.addingTimeInterval(Double(index) * step)
        var reading = VehicleTextRules.read(texts, detection: d, otherBoxes: others, at: at, frameID: UUID(), layout: .eitherSide)
        if !keepObserved { reading.observed = [] }
        result.append(reading); times.append(at); detection = d
    }
    let track = VehicleTrack(id: UUID(), detection: detection ?? VehicleDetection(kind: .bus, box: .zero, score: 0, mask: VehicleMask(width: 0, height: 0, pixels: [])),
                             lastSeen: times.last ?? t0, readings: [])
    var full = track
    full.readings = result
    return (full, times)
}

enum Outcome: String { case accepted, conflicting, unknown }
/// Runs the matcher at every frame of the pass, as the live camera would, with a sliding 2 s window.
func run(_ event: Event, expected: VehicleServiceExpectation, keepObserved: Bool) -> (Outcome, String?) {
    let (track, times) = readings(event, keepObserved: keepObserved)
    var named: String?
    var conflict = false
    for (i, now) in times.enumerated() {
        var window = track
        window.readings = Array(track.readings.prefix(i + 1)).filter { now.timeIntervalSince($0.at) <= 2 }
        window.lastSeen = now
        let decision = VehicleServiceMatcher.decide(window, expected: expected, now: now)
        if decision.state == .visualCandidate { return (.accepted, nil) }
        if decision.state == .conflicting { conflict = true; named = named ?? decision.observedService }
    }
    return (conflict ? .conflicting : .unknown, named)
}

func expectation(_ line: String, _ destination: String, board useBoard: Bool) -> VehicleServiceExpectation {
    var e = VehicleServiceExpectation(line: line, destination: destination)
    if useBoard { e.boardAlternatives = board }
    return e
}

struct Tally { var accepted = 0, conflicting = 0, unknown = 0, namedRight = 0, namedWrong = 0, n = 0
    mutating func add(_ o: Outcome) { n += 1; switch o { case .accepted: accepted += 1; case .conflicting: conflicting += 1; case .unknown: unknown += 1 } }
}
func pct(_ a: Int, _ n: Int) -> String { n == 0 ? "-" : String(format: "%5.1f%%", Double(a) * 100 / Double(n)) }

var positive = ["A": Tally(), "B": Tally(), "C": Tally()]
var negative = ["A": Tally(), "B": Tally(), "C": Tally()]
var perFrame = [String: Int]()
var details: [String] = []
for label in (args.contains("--bench") || args.contains("--why") ? [] : labels) {
    guard let event = eventsByID[label.event] else { continue }
    let truth = DisplayCandidate(line: label.line, destination: label.destination)
    // Per-frame closed-set identification (strategy C's evidence).
    for reading in readings(event, keepObserved: true).0.readings {
        let m = DepartureDisplayMatcher.match(reading.observed, candidates: board)
        let key: String
        switch m.outcome {
        case .matched:
            key = DepartureDisplayMatcher.sameDisplay(m.best!.candidate, truth) ? "matched-correct" : "matched-WRONG"
            if key == "matched-WRONG" && args.contains("--wrong") {
                print("WRONG #\(label.event) truth \(label.line) \(label.destination) → \(m.best!.candidate.line) \(m.best!.candidate.destination) via '\(m.best!.observed)' \(m.best!.line.rawValue); 2nd \(m.runnerUp.map { $0.candidate.line + " " + $0.candidate.destination } ?? "-") texts \(reading.observed.map(\.text))")
            }
        default: key = m.outcome.rawValue
        }
        perFrame[key, default: 0] += 1
    }
    // Positive trial: the rider expects exactly this service.
    for (name, observed, useBoard) in [("A", false, false), ("B", true, false), ("C", true, true)] {
        let (o, _) = run(event, expected: expectation(label.line, label.destination, board: useBoard), keepObserved: observed)
        positive[name]!.add(o)
        if name == "C" { details.append("#\(label.event) \(label.line) \(label.destination): A/B/C positive → \(run(event, expected: expectation(label.line, label.destination, board: false), keepObserved: false).0.rawValue)/\(run(event, expected: expectation(label.line, label.destination, board: false), keepObserved: true).0.rawValue)/\(o.rawValue)") }
    }
    // Negative trials: the rider expects another service. Hard cases first: same line other destination,
    // other line same destination, then the next two board entries.
    let others = board.filter { !DepartureDisplayMatcher.sameDisplay($0, truth) }
    let sameLine = others.filter { $0.lineKey == truth.lineKey }.prefix(1)
    let sameDestination = others.filter { DepartureDisplayMatcher.destinationSimilarity($0.destination, truth.destination) >= 0.9 }.prefix(1)
    let rest = others.filter { o in !sameLine.contains(o) && !sameDestination.contains(o) }
    let offset = label.event % max(1, rest.count)
    let picks = Array(sameLine) + Array(sameDestination) + [rest[offset % rest.count], rest[(offset + 7) % rest.count]]
    for wrong in picks {
        for (name, observed, useBoard) in [("A", false, false), ("B", true, false), ("C", true, true)] {
            var e = expectation(wrong.line, wrong.destination, board: useBoard)
            if useBoard { e.boardAlternatives = board }
            let (o, named) = run(event, expected: e, keepObserved: observed)
            negative[name]!.add(o)
            if let named {
                let parts = named.split(separator: " ", maxSplits: 1).map(String.init)
                if parts.count == 2, DepartureDisplayMatcher.sameDisplay(DisplayCandidate(line: parts[0], destination: parts[1]), truth) { negative[name]!.namedRight += 1 }
                else { negative[name]!.namedWrong += 1 }
            }
        }
    }
}

print("Labelled passes: \(labels.count) (\(Set(labels.map { $0.line + $0.destination }).count) services). Board: \(board.count) line/destination pairs.\n")
print("Per frame, closed-set match of the largest vehicle's display text against the board:")
let frameTotal = perFrame.values.reduce(0, +)
for key in ["matched-correct", "matched-WRONG", "ambiguous", "unlisted", "unreadable"] {
    print("  \(key.padding(toLength: 16, withPad: " ", startingAt: 0)) \(String(format: "%4d", perFrame[key] ?? 0))  \(pct(perFrame[key] ?? 0, frameTotal))")
}
print("\nPositive trials (rider expects the service shown): want 'accepted' (= visual candidate), never 'conflicting'")
print("  strategy  accepted  conflicting(false alarm)  unknown")
for name in ["A", "B", "C"] { let t = positive[name]!; print("  \(name)         \(pct(t.accepted, t.n))   \(pct(t.conflicting, t.n))                  \(pct(t.unknown, t.n))") }
print("\nNegative trials (rider expects a different service): want 'conflicting', never 'accepted'")
print("  strategy  accepted(FALSE ACCEPT)  conflicting  unknown  named the right service")
for name in ["A", "B", "C"] { let t = negative[name]!; print("  \(name)         \(pct(t.accepted, t.n))                \(pct(t.conflicting, t.n))   \(pct(t.unknown, t.n))  \(t.namedRight)/\(t.namedRight + t.namedWrong)") }
if args.contains("--details") { print(""); details.forEach { print($0) } }

if args.contains("--bench") {
    // Cost of one frame's work, on the busiest labelled frames.
    let sample = ocr.frames.filter { !$0.vehicles.isEmpty }.sorted { $0.vehicles[0].texts.count > $1.vehicles[0].texts.count }.prefix(50)
    var readTime = 0.0, matchTime = 0.0, n = 0
    for frame in sample {
        let v = frame.vehicles[0]
        let d = VehicleDetection(kind: .tram, box: rect(v.box), score: 1, mask: VehicleMask(width: 4, height: 4, pixels: [UInt8](repeating: 1, count: 16)))
        let texts = v.texts.map { VehicleText(text: $0.text, box: rect($0.box), score: $0.score) }
        var start = Date()
        let r = VehicleTextRules.read(texts, detection: d, otherBoxes: [], at: t0, frameID: UUID(), layout: .eitherSide)
        readTime += Date().timeIntervalSince(start)
        start = Date()
        _ = DepartureDisplayMatcher.match(r.observed, candidates: board)
        matchTime += Date().timeIntervalSince(start)
        n += 1
    }
    print(String(format: "\nPer frame (busiest %d frames, %d-%d texts): VehicleTextRules.read %.1f ms, board match (%d candidates) %.1f ms",
                 n, sample.last?.vehicles[0].texts.count ?? 0, sample.first?.vehicles[0].texts.count ?? 0, readTime / Double(n) * 1000, board.count, matchTime / Double(n) * 1000))
}

if args.contains("--why") {
    // For each labelled pass that strategy C did not accept, show what each frame's matcher saw.
    for label in labels {
        guard let event = eventsByID[label.event] else { continue }
        let (o, _) = run(event, expected: expectation(label.line, label.destination, board: true), keepObserved: true)
        guard o != .accepted else { continue }
        print("#\(label.event) truth \(label.line) \(label.destination) → \(o.rawValue)")
        for reading in readings(event, keepObserved: true).0.readings {
            let m = DepartureDisplayMatcher.match(reading.observed, candidates: board)
            let b = m.best.map { "\($0.candidate.line) \($0.candidate.destination) d=\(String(format: "%.2f", $0.destination)) \($0.line.rawValue) '\($0.observed)'" } ?? "-"
            let r = m.runnerUp.map { "\($0.candidate.line) \($0.candidate.destination) d=\(String(format: "%.2f", $0.destination))" } ?? "-"
            print("   \(m.outcome.rawValue.padding(toLength: 10, withPad: " ", startingAt: 0)) best[\(b)] 2nd[\(r)] texts=\(reading.observed.map { "\($0.text)(\(String(format: "%.2f", $0.score)))" }.prefix(8))")
        }
    }
}
