// The original snapshot's vehicle decision rules (VehicleEvidence.swift from the import commit), replayed on
// exactly the same trials as main.swift exports. Built by ../run-baseline.sh; nothing here ships in the app.
import Foundation

struct OCRText: Decodable { let text: String; let score: Float; let box: [Double] }
struct OCRVehicle: Decodable { let kind: String; let score: Double; let box: [Double]; let texts: [OCRText] }
struct OCRFrame: Decodable { let image: String; let vehicles: [OCRVehicle] }
struct OCRFile: Decodable { let frames: [OCRFrame] }
struct Event: Decodable { let id: Int; let frames: [String] }
struct Events: Decodable { let events: [Event] }
struct Trial: Decodable { let event: Int; let line: String; let destination: String; let positive: Bool }
func load<T: Decodable>(_ type: T.Type, _ path: String) -> T { try! JSONDecoder().decode(T.self, from: Data(contentsOf: URL(fileURLWithPath: path))) }
let dataDir = CommandLine.arguments[1], trials = load([Trial].self, CommandLine.arguments[2])
let frames = Dictionary(uniqueKeysWithValues: load(OCRFile.self, dataDir + "/bern-video-ocr.json").frames.map { ($0.image, $0) })
let events = Dictionary(uniqueKeysWithValues: load(Events.self, dataDir + "/bern-video-events.json").events.map { ($0.id, $0) })
func rect(_ b: [Double]) -> CGRect { CGRect(x: b[0], y: b[1], width: b[2], height: b[3]) }
let t0 = Date(timeIntervalSince1970: 1_800_000_000)
var tallies = [true: [0, 0, 0], false: [0, 0, 0]] // accepted, conflicting, unknown
for trial in trials {
    guard let event = events[trial.event] else { continue }
    var readings: [DisplayReading] = [], times: [Date] = []
    var detection: VehicleDetection?
    for (i, name) in event.frames.enumerated() {
        guard let f = frames[name], let v = f.vehicles.max(by: { $0.box[3] < $1.box[3] }) else { continue }
        let d = VehicleDetection(kind: v.kind == "tram" ? .tram : .bus, box: rect(v.box), score: Float(v.score),
                                 mask: VehicleMask(width: 4, height: 4, pixels: [UInt8](repeating: 1, count: 16)))
        let at = t0.addingTimeInterval(Double(i) * 0.5)
        readings.append(VehicleTextRules.read(v.texts.map { VehicleText(text: $0.text, box: rect($0.box), score: $0.score) }, detection: d,
            otherBoxes: f.vehicles.filter { $0.box != v.box }.map { rect($0.box) }, at: at, frameID: UUID(), layout: .eitherSide))
        times.append(at); detection = d
    }
    guard let detection else { tallies[trial.positive]![2] += 1; continue }
    var outcome = 2
    for (i, now) in times.enumerated() {
        let window = VehicleTrack(id: UUID(), detection: detection, lastSeen: now, readings: Array(readings.prefix(i + 1)).filter { now.timeIntervalSince($0.at) <= 2 })
        let state = VehicleServiceMatcher.decide(window, expected: VehicleServiceExpectation(line: trial.line, destination: trial.destination), now: now).state
        if state == .visualCandidate { outcome = 0; break }
        if state == .conflicting { outcome = 1 }
    }
    tallies[trial.positive]![outcome] += 1
}
func pct(_ a: Int, _ n: Int) -> String { String(format: "%5.1f%%", Double(a) * 100 / Double(max(n, 1))) }
for positive in [true, false] {
    let t = tallies[positive]!, n = t.reduce(0, +)
    print("Original snapshot rules, \(positive ? "positive" : "negative") trials (n=\(n)): accepted \(pct(t[0], n))  conflicting \(pct(t[1], n))  unknown \(pct(t[2], n))")
}
