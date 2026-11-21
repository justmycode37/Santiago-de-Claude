// Portable checks for RightSide logic that does not need UIKit/ARKit/CoreML.
// Build and run with ./run.sh (Linux/WSL with a Swift toolchain, or macOS command-line tools).
import Foundation

var failures = 0, checks = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String, line: Int = #line) {
    checks += 1
    if !condition() { failures += 1; print("FAIL line \(line): \(message)") }
}

// MARK: - Text normalisation

check(DisplayText.words("Bern, Bümpliz") == ["bern", "bumpliz"], "accents folded")
check(DisplayText.words("Weißenbühl") == ["weissenbuhl"], "ß becomes ss")
check(DisplayText.canonical("Köniz Bhf.") == "koniz bahnhof", "Bhf expanded")
check(DisplayText.lineKey("Bus 10") == "10" && DisplayText.lineKey("T 9") == "9" && DisplayText.lineKey("M18") == "m18", "line keys")
check(DisplayText.isRouteToken("10") && DisplayText.isRouteToken("m18") && DisplayText.isRouteToken("10e") && !DisplayText.isRouteToken("2026x1"), "route tokens")
check(DisplayText.similarity("ostermundigen", "0stermundigen") == 1, "O/0 confusion is free inside words")
check(DisplayText.similarity("wabern", "wabem") >= 0.66, "rn/m misread stays similar")
check(DisplayText.variants("Bern, Wankdorf Bahnhof").contains(["wankdorf", "bahnhof"]), "locality prefix optional")

// MARK: - Closed-set display matching

let t0 = Date(timeIntervalSince1970: 1_800_000_000)
func text(_ s: String, x: Double = 0.2, y: Double = 0.15, w: Double = 0.3, h: Double = 0.05, score: Float = 0.9) -> VehicleText {
    VehicleText(text: s, box: CGRect(x: x, y: y, width: w, height: h), score: score)
}
let bern: [DisplayCandidate] = [
    .init(line: "10", destination: "Ostermundigen, Rüti"), .init(line: "10", destination: "Bern, Bahnhof"),
    .init(line: "10", destination: "Schliern, Bus-Endstation"), .init(line: "19", destination: "Spiegel, Blinzern"),
    .init(line: "19", destination: "Bern, Elfenau"), .init(line: "20", destination: "Bern Wankdorf, Bahnhof"),
    .init(line: "20", destination: "Bern, Länggasse"), .init(line: "17", destination: "Köniz, Weiermatt"),
    .init(line: "7", destination: "Bern, Bümpliz"), .init(line: "7", destination: "Bern, Ostring"),
    .init(line: "8", destination: "Bern, Saali"), .init(line: "8", destination: "Bern Brünnen Westside, Bahnhof"),
    .init(line: "9", destination: "Wabern, Tram-Endstation"), .init(line: "9", destination: "Bern Wankdorf, Bahnhof"),
    .init(line: "6", destination: "Worb Dorf"), .init(line: "6", destination: "Bern, Fischermätteli"),
]
do {
    let m = DepartureDisplayMatcher.match([text("10", x: 0.1, w: 0.05), text("Ostermundigen Rüti", x: 0.17)], candidates: bern)
    check(m.outcome == .matched && m.best?.candidate.destination == "Ostermundigen, Rüti" && m.best?.line == .exact, "clean display matched")
}
do {
    // Typical LED misreads: O→0, ü→u, i→1, route numeral with a confusable glyph.
    let m = DepartureDisplayMatcher.match([text("1O", x: 0.1, w: 0.05, score: 0.5), text("0stermundigen Rut1", x: 0.17, score: 0.55)], candidates: bern)
    check(m.outcome == .matched && m.best?.candidate.line == "10" && m.best?.candidate.destination == "Ostermundigen, Rüti", "misread display still matched")
}
do {
    let m = DepartureDisplayMatcher.match([text("Bümpliz")], candidates: bern)
    check(m.outcome == .matched && m.best?.candidate.line == "7", "unique destination without numeral matched")
    check(m.best?.line == .unseen, "numeral reported as unseen")
}
do {
    // "Bahnhof" alone: lines 10 and 20 and others go there; the numeral is needed.
    let candidates = bern + [.init(line: "20", destination: "Bern, Bahnhof")]
    let m = DepartureDisplayMatcher.match([text("Bahnhof")], candidates: candidates)
    check(m.outcome == .ambiguous, "shared destination without numeral stays ambiguous, got \(m.outcome)")
    // Line 10 has one "Bahnhof" destination; line 20 has two (Bern, Bahnhof and Bern Wankdorf, Bahnhof), so
    // "20 Bahnhof" rightly stays ambiguous between those.
    let n = DepartureDisplayMatcher.match([text("10", x: 0.1, w: 0.05), text("Bahnhof", x: 0.17)], candidates: candidates)
    check(n.outcome == .matched && n.best?.candidate.destination == "Bern, Bahnhof", "numeral resolves shared destination")
    let twenty = DepartureDisplayMatcher.match([text("20", x: 0.1, w: 0.05), text("Bahnhof", x: 0.17)], candidates: candidates)
    check(twenty.outcome != .matched, "20 Bahnhof: two line-20 Bahnhof destinations, no pick")
}
do {
    let m = DepartureDisplayMatcher.match([text("19", x: 0.1, w: 0.05), text("Ostermundigen", x: 0.17)], candidates: bern)
    check(m.outcome != .matched, "numeral contradicting the only fitting destination is not a match, got \(m.outcome)")
}
do {
    let m = DepartureDisplayMatcher.match([text("Extrafahrt Gurten")], candidates: bern)
    check(m.outcome == .unlisted, "unlisted readable display reported as unlisted, got \(m.outcome)")
    let u = DepartureDisplayMatcher.match([text("ab", score: 0.4)], candidates: bern)
    check(u.outcome == .unreadable, "fragments are unreadable")
}
do {
    // Two rows: destination and a via line ("via Bahnhof"), both on the same vehicle.
    let m = DepartureDisplayMatcher.match([text("9", x: 0.1, w: 0.04), text("Wabern", x: 0.16), text("via Bahnhof", x: 0.16, y: 0.21, h: 0.035)], candidates: bern)
    check(m.outcome == .matched && m.best?.candidate.destination == "Wabern, Tram-Endstation", "short display name of terminus matched")
}

// MARK: - Service decision over time

func detection() -> VehicleDetection {
    VehicleDetection(kind: .bus, box: CGRect(x: 0.1, y: 0.1, width: 0.6, height: 0.7), score: 0.9,
                     mask: VehicleMask(width: 10, height: 10, pixels: [UInt8](repeating: 1, count: 100)))
}
func track(_ frames: [[VehicleText]]) -> VehicleTrack {
    let d = detection()
    let readings = frames.enumerated().map { index, texts in
        VehicleTextRules.read(texts, detection: d, otherBoxes: [], at: t0.addingTimeInterval(Double(index) * 0.5), frameID: UUID(), layout: .eitherSide)
    }
    return VehicleTrack(id: UUID(), detection: d, lastSeen: t0.addingTimeInterval(Double(frames.count - 1) * 0.5), readings: readings)
}
// 0.5 s apart: at Date's precision near 1.8e9 s, 0.4 s steps give a 0.79999995 s span.
let now = t0.addingTimeInterval(1.0)
let misread = [[VehicleText]](repeating: [text("1O", x: 0.12, w: 0.05, score: 0.75), text("0stermundigen Rut1", x: 0.19, score: 0.8)], count: 3)
do {
    var expected = VehicleServiceExpectation(line: "10", destination: "Ostermundigen, Rüti")
    let old = VehicleServiceMatcher.decide(track(misread), expected: expected, now: now)
    check(old.state != .visualCandidate, "without a board a misread is never accepted")
    expected.boardAlternatives = bern
    let new = VehicleServiceMatcher.decide(track(misread), expected: expected, now: now)
    check(new.state == .visualCandidate, "with the board a repeated misread of the right display is a visual candidate, got \(new.state) \(new.reason)")
}
do {
    var expected = VehicleServiceExpectation(line: "19", destination: "Spiegel, Blinzern")
    expected.boardAlternatives = bern
    let d = VehicleServiceMatcher.decide(track(misread), expected: expected, now: now)
    check(d.state == .conflicting && d.observedService == "10 Ostermundigen, Rüti", "wrong vehicle is named, got \(d.state) \(d.observedService ?? "-")")
    check(d.label.contains("10 Ostermundigen"), "label names the other service")
}
do {
    // Exact-text behaviour without a board is unchanged.
    let expected = VehicleServiceExpectation(line: "6", destination: "Fischermätteli")
    let right = VehicleServiceMatcher.decide(track([[VehicleText]](repeating: [text("6 Fischermätteli")], count: 3)), expected: expected, now: now)
    check(right.state == .visualCandidate, "exact display still a candidate, got \(right.reason)")
    for wrong in ["16 Fischermätteli", "6 Worb Dorf", "6 Bahnhof"] {
        let d = VehicleServiceMatcher.decide(track([[VehicleText]](repeating: [text(wrong)], count: 3)), expected: expected, now: now)
        check(d.state == .conflicting, "\(wrong) still conflicts without a board")
    }
}
do {
    // Short turn: line 10 to Bern Bahnhof when the rider needs Ostermundigen beyond it... modelled with calls.
    var expected = VehicleServiceExpectation(line: "10", destination: "Ostermundigen, Rüti")
    expected.boardAlternatives = bern
    expected.alightingCallID = "c3"
    expected.downstreamCalls = [.init(id: "c1", stopID: "s1", name: "Bern, Bahnhof"), .init(id: "c2", stopID: "s2", name: "Bern, Zytglogge"),
                                .init(id: "c3", stopID: "s3", name: "Ostermundigen, Rüti")]
    let frames = [[VehicleText]](repeating: [text("10", x: 0.12, w: 0.05), text("Bahnhof", x: 0.19)], count: 3)
    let d = VehicleServiceMatcher.decide(track(frames), expected: expected, now: now)
    check(d.state == .conflicting && d.reason == "display_short_turn_before_alighting", "short working recognised, got \(d.reason)")
}
do {
    // Flicker: one frame clearly another service, others the expected one -> not accepted.
    var expected = VehicleServiceExpectation(line: "10", destination: "Ostermundigen, Rüti")
    expected.boardAlternatives = bern
    let frames = [misread[0], [text("19", x: 0.12, w: 0.05), text("Spiegel Blinzern", x: 0.19)], misread[0]]
    let d = VehicleServiceMatcher.decide(track(frames), expected: expected, now: now)
    check(d.state == .unknown, "frames disagreeing between services stay unknown, got \(d.state) \(d.reason)")
}

// MARK: - Behaviour the snapshot's XCTests pin down (re-stated here; the originals need XCTest/CoreLocation/simd)

do {
    // VehicleEvidenceTests.testUnreadableAndFlickeringDisplayCannotReuseLastMatch
    let expected = VehicleServiceExpectation(line: "6", destination: "Fischermätteli")
    var t = track([[VehicleText]](repeating: [text("6 Fischermätteli")], count: 3))
    let d = t.detection
    t.lastSeen = t0.addingTimeInterval(1.4)
    t.readings.append(VehicleTextRules.read([text("6")], detection: d, otherBoxes: [], at: t.lastSeen, frameID: UUID()))
    check(VehicleServiceMatcher.decide(t, expected: expected, now: t.lastSeen).state == .unknown, "latest frame unreadable -> unknown")
    t.readings[3] = VehicleTextRules.read([text("6 Fischermätteli", score: 0.4)], detection: d, otherBoxes: [], at: t.lastSeen, frameID: UUID())
    check(VehicleServiceMatcher.decide(t, expected: expected, now: t.lastSeen).state == .unknown, "latest frame low-confidence -> unknown (no board)")
}
do {
    // CameraBoardingTests.testDisplayedShortTurnBeforeRequestedStopHasSpecificWarning (plain readings, no observed text)
    var expected = VehicleServiceExpectation(line: "6", destination: "Fischermätteli")
    expected.alightingCallID = "a"; expected.downstreamCalls = [.init(id: "b", stopID: "s1", name: "Bahnhof"), .init(id: "a", stopID: "s2", name: "Fischermätteli")]
    let readings = [0.0, 0.5, 1.0].map { DisplayReading(frameID: UUID(), at: t0.addingTimeInterval($0), line: "6", destination: "bahnhof", outOfService: false, ambiguous: false, raw: ["6 bahnhof"]) }
    let t = VehicleTrack(id: UUID(), detection: detection(), lastSeen: t0.addingTimeInterval(1), readings: readings)
    let d = VehicleServiceMatcher.decide(t, expected: expected, now: t0.addingTimeInterval(1))
    check(d.state == .conflicting && d.reason == "display_short_turn_before_alighting", "short turn on plain readings, got \(d.reason)")
    // VehicleDisplayRecognitionTests: three distinct frames of another line still conflict; one repeated frame does not decide.
    let other = VehicleServiceExpectation(line: "9", destination: "Brünnen Westside Bhf")
    let eight = [0.0, 0.4, 0.85].map { DisplayReading(frameID: UUID(), at: t0.addingTimeInterval($0), line: "8", destination: "brunnen westside bhf", outOfService: false, ambiguous: false, raw: []) }
    let stable = VehicleTrack(id: UUID(), detection: detection(), lastSeen: t0.addingTimeInterval(0.85), readings: eight)
    check(VehicleServiceMatcher.decide(stable, expected: other, now: stable.lastSeen).state == .conflicting, "line 8 display vs expected 9 conflicts")
    check(VehicleServiceMatcher.decide(stable, expected: .init(line: "8", destination: "Brünnen Westside Bhf"), now: stable.lastSeen).state == .visualCandidate, "line 8 display matches 8")
}
do {
    // New: single-frame junk readings never raise the wrong-vehicle alarm.
    let expected = VehicleServiceExpectation(line: "9", destination: "Wabern, Tram-Endstation")
    for junk in [["e|dach ag"], ["031|35x2"], ["9|wabern"], ["9|wabern", "9|wabern"], ["12|zentrum po"]] {
        let readings = junk.enumerated().map { i, v -> DisplayReading in
            let p = v.split(separator: "|").map(String.init)
            return DisplayReading(frameID: UUID(), at: t0.addingTimeInterval(Double(i) * 0.5), line: p[0], destination: p[1], outOfService: false, ambiguous: false, raw: [])
        }
        let t = VehicleTrack(id: UUID(), detection: detection(), lastSeen: readings.last!.at, readings: readings)
        let e = junk == [["12|zentrum po"]].first! ? VehicleServiceExpectation(line: "12", destination: "Bern, Zentrum Paul Klee") : expected
        check(VehicleServiceMatcher.decide(t, expected: e, now: t.lastSeen).state != .conflicting, "\(junk) must not conflict")
    }
}

// MARK: - Live vehicle evidence (Kante engine), against real responses saved on 21 Nov 2026

let fixtures = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "fixtures"
func fixture(_ name: String) -> Data? { try? Data(contentsOf: URL(fileURLWithPath: fixtures + "/" + name)) }
if let data = fixture("kante-vehicles-bern.json"), let vehicles = try? KanteVehicleFeed.decode(data) {
    check(vehicles.count >= 10 && vehicles.allSatisfy(\.isRoadVehicle), "live /api/vehicles decodes to buses/trams, got \(vehicles.count)")
    let at = Date(timeIntervalSince1970: 1_795_267_910)
    let inBox = vehicles.compactMap { $0.position(at: at) }.filter { (46.93...46.97).contains($0.latitude) && (7.41...7.47).contains($0.longitude) }
    check(inBox.count == vehicles.count, "every interpolated position lies around the requested box")
} else { check(false, "vehicles fixture missing or undecodable") }
if let data = fixture("kante-due-bern-bahnhof.json"), let due = try? KanteVehicleFeed.decodeDue(data),
   let boardData = fixture("stationboard-bern-bahnhof.json"),
   let board = try? JSONSerialization.jsonObject(with: boardData) as? [String: Any], let rows = board["stationboard"] as? [[String: Any]] {
    let dueCandidates = VehiclePositionEvidence.candidates(from: due)
    let boardCandidates = rows.compactMap { r -> DisplayCandidate? in
        guard let n = r["number"] as? String, let to = r["to"] as? String else { return nil }; return DisplayCandidate(line: n, destination: to)
    }
    let roads = dueCandidates.filter { c in due.contains { $0.candidate.identity == c.identity && ["bus", "tram"].contains($0.line.mode) } }
    let onBoard = roads.filter { c in boardCandidates.contains { DepartureDisplayMatcher.sameDisplay($0, c) } }
    print("Kante /api/due at Bern, Bahnhof: \(due.count) trips, \(roads.count) bus/tram display identities, \(onBoard.count) also on the transport.opendata.ch board")
    check(due.count >= 10 && !roads.isEmpty, "live /api/due decodes")
    check(onBoard.count * 10 >= roads.count * 7, "at least 70 % of due bus/tram identities are spelled as on the stationboard")
    check(due.contains { $0.vias?.isEmpty == false }, "vias come through")
} else { check(false, "due fixture missing or undecodable") }
do {
    // Tram 9 approaching from the west (drives east, bearing 70), due in 40 s; tram 20 to the same stop in 7 min.
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func due(_ line: String, _ eta: Double, _ state: String, approach: Double?) -> KanteDue {
        KanteDue(tripId: line, line: .init(name: line, category: "T", mode: "tram"), headsign: "Bern Wankdorf, Bahnhof", vias: [],
                 quayId: "q", quayLabel: "B", arr: now.timeIntervalSince1970 + eta, dep: now.timeIntervalSince1970 + eta + 20,
                 cancelled: false, approachBearing: approach, state: state, etaS: eta, liveInfo: .init(state: "observed", inaccurate: false))
    }
    let items = [due("9", 40, "approaching", approach: 70), due("20", 420, "approaching", approach: 70)]
    let candidates = VehiclePositionEvidence.candidates(from: items)
    let center = CGRect(x: 0.4, y: 0.3, width: 0.2, height: 0.4)
    func pose(_ heading: Double) -> CameraPose {
        CameraPose(user: GeoPoint(latitude: 46.95, longitude: 7.44), userAccuracy: 6, heading: heading, headingAccuracy: 15, horizontalFOV: 1.0, at: now)
    }
    let west = VehiclePositionEvidence.dueLikelihoods(for: center, pose: pose(250), due: items, candidates: candidates, now: now)
    let east = VehiclePositionEvidence.dueLikelihoods(for: center, pose: pose(70), due: items, candidates: candidates, now: now)
    let nine = candidates.first { $0.line == "9" }!.identity, twenty = candidates.first { $0.line == "20" }!.identity
    check((west[nine] ?? 0) > 0.9 && (west[twenty] ?? 0) < 0.15, "camera facing the approach side: 9 likely, 20 not, got \(west)")
    check((east[nine] ?? 0) < 0.5, "camera facing away from the approach side lowers 9, got \(east)")
    // The tie from the recorded video (tram 9 vs 20, numeral unread) is broken by the due list...
    let board9 = [DisplayCandidate(line: "9", destination: "Bern Wankdorf, Bahnhof"), DisplayCandidate(line: "20", destination: "Bern Wankdorf, Bahnhof"),
                  DisplayCandidate(line: "8", destination: "Bern, Saali")]
    let tie = DepartureDisplayMatcher.match([text("Wankdorf Bhf")], candidates: board9)
    let broken = DepartureDisplayMatcher.match([text("Wankdorf Bhf")], candidates: board9, positions: west)
    check(tie.outcome == .ambiguous && broken.outcome == .matched && broken.best?.candidate.line == "9", "position evidence breaks the 9/20 tie")
    // ...but never overrides a readable, different display.
    let clear = DepartureDisplayMatcher.match([text("8", x: 0.1, w: 0.04), text("Saali", x: 0.16)], candidates: board9, positions: west)
    check(clear.outcome == .matched && clear.best?.candidate.line == "8", "a readable display wins over position evidence")
    // A departed vehicle no longer counts.
    let gone = [due("9", -60, "departed", approach: 70)]
    check(VehiclePositionEvidence.dueLikelihoods(for: center, pose: pose(250), due: gone, candidates: candidates, now: now).isEmpty, "departed vehicle ignored")
    // /api/vehicles geometry: a vehicle 120 m north-east is likely only when the camera looks that way.
    let plane = LocalTangentPlane(origin: GeoPoint(latitude: 46.95, longitude: 7.44))
    let p = plane.geo(Vec2(x: 85, y: 85))
    let v = KanteVehicle(tripId: "t", line: .init(name: "9", category: "T", mode: "tram"), headsign: "Bern Wankdorf, Bahnhof",
                         from: [p.longitude, p.latitude], to: [p.longitude, p.latitude], dep: 0, arr: 0, nextStop: nil, live: "observed")
    let toward = VehiclePositionEvidence.likelihoods(for: center, pose: pose(45), vehicles: [v], candidates: candidates)
    let away = VehiclePositionEvidence.likelihoods(for: center, pose: pose(225), vehicles: [v], candidates: candidates)
    check((toward[nine] ?? 0) > 0.3 && (away[nine] ?? 0) < 0.05, "vehicle bearing agrees only when the camera faces it, got \(toward) / \(away)")
}

// MARK: - Confidence ranking

do {
    var expected = VehicleServiceExpectation(line: "10", destination: "Ostermundigen, Rüti")
    expected.boardAlternatives = bern
    // One clear frame, then two unreadable ones: no consensus, so the most confident frame decides.
    let frames: [[VehicleText]] = [[text("10", x: 0.12, w: 0.05, score: 0.98), text("Ostermundigen Rüti", x: 0.19, score: 0.97)],
                                   [text("x", score: 0.4)], [text("y", score: 0.4)]]
    let d = VehicleServiceMatcher.decide(track(frames), expected: expected, now: now)
    check(d.state == .visualCandidate && d.basis == "best_single_frame" && (d.confidence ?? 0) >= 0.6,
          "best single frame decides, got \(d.state) \(d.basis ?? "-") \(d.confidence ?? 0)")
    check(d.label.contains("Best reading"), "single-frame decisions are labelled as such")
    // Two weak frames for the right ride and one clear frame for another service: not accepted.
    var expected19 = VehicleServiceExpectation(line: "19", destination: "Spiegel, Blinzern")
    expected19.boardAlternatives = bern
    let mixed: [[VehicleText]] = [[text("19", x: 0.12, w: 0.05, score: 0.5), text("Blinzern", x: 0.19, score: 0.5)],
                                  [text("19", x: 0.12, w: 0.05, score: 0.5), text("Blinzern", x: 0.19, score: 0.5)],
                                  [text("10", x: 0.12, w: 0.05, score: 0.99), text("Ostermundigen Rüti", x: 0.19, score: 0.99)]]
    let m = VehicleServiceMatcher.decide(track(mixed), expected: expected19, now: now)
    check(m.state != .visualCandidate, "a confident contradicting frame blocks acceptance, got \(m.state) \(m.reason)")
}

// MARK: - Stop edges, kerb side and floor heights (packs built from platforms.js and stations3d/)

let packs = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "packs"
if let data = try? Data(contentsOf: URL(fileURLWithPath: packs + "/stop-edges.json")), let edgePack = try? StopEdgePack(data: data) {
    let bahnhof = edgePack.edges(uic: "8576646") // Bern, Bahnhof (tram/bus)
    check(bahnhof.contains { $0.ref == "B" && $0.bearing != nil }, "Bern, Bahnhof edge B with travel direction")
    let b = edgePack.boardingEdge(uic: "8576646", ref: "Kante B")
    check(b?.ref == "B", "boarding edge by ref, 'Kante B' → B")
    check(edgePack.boardingEdge(uic: "8576646", ref: "X") == nil, "unknown ref resolves to nothing, never a guess")
    // By travel direction alone: only when exactly one edge agrees within 45°.
    let wankdorf = edgePack.edges(uic: "8590129")
    if let a = wankdorf.first(where: { $0.ref == "A" }), let bearing = a.bearing {
        let byDirection = edgePack.boardingEdge(uic: "8590129", ref: nil, departBearing: bearing)
        check(byDirection == nil || byDirection?.ref == "A", "direction-only choice is unique or nothing")
    }
    if let edge = b, let bearing = edge.bearing {
        let plane = LocalTangentPlane(origin: edge.point)
        let r = bearing * .pi / 180
        func at(lateral: Double, along: Double = 0) -> GeoPoint {
            plane.geo(Vec2(x: cos(r) * lateral + sin(r) * along, y: -sin(r) * lateral + cos(r) * along))
        }
        let right = KerbSide.assess(user: at(lateral: 3), accuracy: 4, edge: edge, siblings: [])
        let across = KerbSide.assess(user: at(lateral: -14), accuracy: 4, edge: edge, siblings: [])
        let vague = KerbSide.assess(user: at(lateral: -14), accuracy: 25, edge: edge, siblings: [])
        check(right.side == .boarding && abs(right.lateral - 3) < 0.1, "3 m right of the travel line: boarding side")
        check(across.side == .opposite, "14 m left: across the street")
        check(vague.side == .unknown, "poor fix: no claim")
        check(across.message(edgeName: "Kante B")?.contains("across the street") == true, "opposite-side message")
    }
    // Measured on real geometry: every Bern stop with refs on edges serving opposite directions. The rider waits
    // 2.5 m behind the kerb of one edge, or stands at the same place across a 12 m street; the fix is off by
    // a Gaussian error of σ metres (reported accuracy = σ).
    var rng = Rng(state: 99)
    var pairs: [(StopEdge, [StopEdge])] = []
    for uic in ["8576646", "8507110", "8590129", "8579896", "8507060", "8590020", "8588989", "8580939", "8590048"] {
        let edges = edgePack.edges(uic: uic).filter { !$0.ref.isEmpty && $0.bearing != nil }
        for e in edges where edges.contains(where: { StopEdgePack.angle($0.bearing!, e.bearing!) >= 120 }) { pairs.append((e, edges)) }
    }
    for sigma in [3.0, 5.0, 10.0] {
        var tally = [String: Int]()
        for (edge, siblings) in pairs {
            let plane = LocalTangentPlane(origin: edge.point)
            let r = edge.bearing! * .pi / 180
            for (truth, lateral) in [("boarding", 2.5), ("opposite", -14.5)] {
                for _ in 0..<50 {
                    let l = lateral + rng.gaussian() * sigma, a = rng.gaussian() * sigma
                    let p = plane.geo(Vec2(x: cos(r) * l + sin(r) * a, y: -sin(r) * l + cos(r) * a))
                    let side = KerbSide.assess(user: p, accuracy: sigma, edge: edge, siblings: siblings).side
                    tally[side == .unknown ? "unknown" : side.rawValue == truth ? "right" : "WRONG", default: 0] += 1
                }
            }
        }
        let n = max(1, tally.values.reduce(0, +))
        print(String(format: "Kerb side, %d Bern edges, GPS σ %.0f m: right %.0f%%, wrong %.1f%%, no claim %.0f%%",
                     pairs.count, sigma, Double(tally["right"] ?? 0) * 100 / Double(n), Double(tally["WRONG"] ?? 0) * 100 / Double(n),
                     Double(tally["unknown"] ?? 0) * 100 / Double(n)))
        check(Double(tally["WRONG"] ?? 0) / Double(n) < 0.1, "kerb side wrong < 10 % at σ \(sigma) m")
    }
} else { check(false, "stop-edges.json missing or undecodable") }
if let data = try? Data(contentsOf: URL(fileURLWithPath: packs + "/station-levels.json")),
   let levels = try? JSONDecoder().decode(StationLevelPack.self, from: data) {
    let europaplatz1 = levels.floor(uic: "8507082", ref: "1")
    let europaplatz3 = levels.floor(uic: "8504108", ref: "3")
    let bruennen = levels.floor(uic: "8516154", ref: "Gleis 2")
    check(europaplatz1 == .init(level: -1, z: -6.1, name: "Platforms 1/2"), "Europaplatz platform 1 is 6.1 m below the street, got \(String(describing: europaplatz1))")
    check(europaplatz3?.z == 5.0, "Europaplatz platform 3 is 5 m above the street")
    check(bruennen?.z == 5.0, "Brünnen platform 2 on the 5 m platform level")
    check(levels.floor(uic: "8576646", ref: "X") == nil, "unknown edge: no floor")
    if let bern = levels.stations.first(where: { $0.key == "bern" }) {
        check(StationLevelPack.z(-1.5, in: bern) == -6.75, "half-way between levels interpolates")
    }
    let floor = ARFloorHeights.floorY(cameraY: 1.6, detectedPlaneYs: [0.1, 1.5, -4.9])
    check(floor.detected && floor.y == 0.1, "detected floor under the camera is used")
    check(ARFloorHeights.floorY(cameraY: 1.6, detectedPlaneYs: []).y == 1.6 - 1.4, "fallback phone height without a plane")
    check(abs(ARFloorHeights.targetY(startFloorY: -1.2, targetZ: europaplatz1?.z) - (-7.3)) < 1e-9, "target drawn on its real floor")
} else { check(false, "station-levels.json missing or undecodable") }
// MARK: - Review fixes (#15)

do {
    // 1. Two vehicles in one frame keep their own identification (cache keyed by vehicle text, not just the frame).
    let frame = UUID()
    let board = [DisplayCandidate(line: "9", destination: "Wabern, Tram-Endstation"), DisplayCandidate(line: "10", destination: "Ostermundigen, Rüti"),
                 DisplayCandidate(line: "8", destination: "Bern, Saali")]
    let a = DepartureDisplayMatcher.match([text("9", x: 0.1, w: 0.04), text("Wabern", x: 0.16)], candidates: board, frameID: frame)
    let b = DepartureDisplayMatcher.match([text("10", x: 0.6, w: 0.05), text("Ostermundigen Rüti", x: 0.67)], candidates: board, frameID: frame)
    check(a.best?.candidate.line == "9" && b.best?.candidate.line == "10", "two vehicles in one frame: 9 and 10, got \(a.best?.candidate.line ?? "-") and \(b.best?.candidate.line ?? "-")")
}
do {
    // 2. A shared generic word does not make two destinations one.
    let bahnhof = DisplayCandidate(line: "20", destination: "Bern, Bahnhof"), wankdorf = DisplayCandidate(line: "20", destination: "Bern Wankdorf, Bahnhof")
    check(!DepartureDisplayMatcher.sameDisplay(bahnhof, wankdorf), "20 Bern, Bahnhof and 20 Bern Wankdorf, Bahnhof are different displays")
    check(DepartureDisplayMatcher.sameDisplay(wankdorf, DisplayCandidate(line: "20", destination: "Bern Wankdorf, Bahnhof")), "identical names stay the same display")
    check(!DepartureDisplayMatcher.sameDestination("Wabern, Tram-Endstation", "Wabern, Kleinwabern"), "a shared locality alone is not the same destination")
    var expected = VehicleServiceExpectation(line: "20", destination: "Bern, Bahnhof")
    expected.boardAlternatives = [wankdorf, DisplayCandidate(line: "9", destination: "Wabern, Tram-Endstation")]
    let frames = [[VehicleText]](repeating: [text("20", x: 0.12, w: 0.05), text("Bern Wankdorf Bahnhof", x: 0.19)], count: 3)
    let d = VehicleServiceMatcher.decide(track(frames), expected: expected, now: now)
    check(d.state != .visualCandidate, "a 20 to Wankdorf is not accepted as the 20 to Bern, Bahnhof, got \(d.state) \(d.reason)")
}
do {
    // 3. No ground arrows without a walking route (a straight line may cross a road or tracks).
    let good = GeoARAlignment.Solution(yaw: 0.4, translation: Vec2(x: 1, y: 2), yawSigma: 3 * .pi / 180, positionSigma: 2.5, source: "combined", positionSamples: 30, pathSpan: 30)
    let plan = ARRouteGuidance.plan(route: [], target: Vec2(x: 0, y: 22), alignment: good, camera: good.ar(Vec2(x: 0, y: 2)), cameraDirection: .pi / 2 + 0.4)
    check(plan.mode != .path && plan.markers.isEmpty, "target without a route: direction only, got \(plan.mode) with \(plan.markers.count) arrows")
    check(plan.targetDistance.map { abs($0 - 20) < 0.5 } ?? false, "distance to the target is still given")
}
do {
    // 6. Kante evidence expires by absolute time and by the age of the answer.
    let t = Date(timeIntervalSince1970: 1_800_000_000)
    let item = KanteDue(tripId: "t", line: .init(name: "9", category: "T", mode: "tram"), headsign: "Bern Wankdorf, Bahnhof", vias: [], quayId: nil, quayLabel: "B",
                        arr: t.timeIntervalSince1970 + 30, dep: t.timeIntervalSince1970 + 50, cancelled: false, approachBearing: nil,
                        state: "approaching", etaS: 30, liveInfo: .init(state: "observed", inaccurate: false))
    let c = VehiclePositionEvidence.candidates(from: [item])
    let box = CGRect(x: 0.4, y: 0.3, width: 0.2, height: 0.4)
    check((VehiclePositionEvidence.dueLikelihoods(for: box, pose: nil, due: [item], candidates: c, now: t, fetchedAt: t)[c[0].identity] ?? 0) > 0.9, "fresh: counts")
    let later = t.addingTimeInterval(180) // the answer still says "approaching", but its departure was 130 s ago
    check(VehiclePositionEvidence.dueLikelihoods(for: box, pose: nil, due: [item], candidates: c, now: later, fetchedAt: later).isEmpty, "past departure: gone, whatever the state said")
    check(VehiclePositionEvidence.dueLikelihoods(for: box, pose: nil, due: [item], candidates: c, now: t.addingTimeInterval(20), fetchedAt: t.addingTimeInterval(-70)).isEmpty, "answer older than 60 s: not used")
}

do {
    // 8. An error page during a Kante redeploy does not latch "no due"; the poll restarts on a new stop, ride or offline.
    let meta = Data(#"{"features":["match","due"]}"#.utf8), old = Data(#"{"features":["match"]}"#.utf8)
    check(KanteVehicleFeed.supportsDue(meta) == true && KanteVehicleFeed.supportsDue(old) == false, "meta read when the server answers")
    check(KanteVehicleFeed.supportsDue(Data("<html>502 Bad Gateway</html>".utf8), status: 502) == nil, "502 page: undecided, not 'no due'")
    check(KanteVehicleFeed.supportsDue(meta, status: 503) == nil, "non-2xx status: undecided")
    let base = KanteVehicleFeed.pollKey(station: "8576646", line: "9", destination: "Wabern", offline: false, simulated: false)
    check(base != nil && base != KanteVehicleFeed.pollKey(station: "8507110", line: "9", destination: "Wabern", offline: false, simulated: false), "new boarding stop: new poll")
    check(KanteVehicleFeed.pollKey(station: "8576646", line: "9", destination: "Wabern", offline: true, simulated: false) == nil, "offline: no polling")
}
do {
    // 11. Repeated identical fixes (underpass) give no path yaw; old compass samples drop out.
    let t = Date(timeIntervalSince1970: 1_800_000_000)
    var a = GeoARAlignment()
    for i in 0..<12 { a.add(.init(at: t.addingTimeInterval(Double(i)), ar: Vec2(x: Double(i), y: 0), enu: Vec2(x: 0, y: 0), accuracy: 8)) }
    check(a.pathFit() == nil, "AR moved 11 m but the fix never moved: no path yaw (was atan2(0,0) = 0)")
    var b = GeoARAlignment()
    b.add(.init(at: t, arDirection: 0, trueHeading: 90, accuracy: 10))
    check(b.compassYaw(at: t.addingTimeInterval(5)) != nil && b.compassYaw(at: t.addingTimeInterval(60)) == nil, "heading older than 20 s is dropped")
}

// MARK: - Review fixes (#24)

if let data = try? Data(contentsOf: URL(fileURLWithPath: packs + "/stop-edges.json")), let edgePack = try? StopEdgePack(data: data),
   let b = edgePack.boardingEdge(uic: "8576646", ref: "B"), let bearing = b.bearing {
    // 4. Far sideways is no claim; the test applies to street-level bus/tram edges only.
    let plane = LocalTangentPlane(origin: b.point), r = bearing * .pi / 180
    let far = plane.geo(Vec2(x: cos(r) * -300, y: -sin(r) * -300))
    check(KerbSide.assess(user: far, accuracy: 3, edge: b, siblings: []).side == .unknown, "300 m sideways with a 3 m fix: no claim (was 'cross the street')")
    check(b.mode == "m" && KerbSide.applies(to: b, floor: nil, stationModelled: false), "street tram edge: kerb test applies")
    let rail = edgePack.edges(uic: "8500286").first { $0.ref == "1" }
    check(rail.map { $0.mode == "t" && !KerbSide.applies(to: $0, floor: nil, stationModelled: false) } ?? false, "train platform with a bearing: no kerb test")
    check(!KerbSide.applies(to: b, floor: nil, stationModelled: true), "modelled station, floor of this edge unknown: no kerb test")
    check(KerbSide.applies(to: b, floor: .init(level: 0, z: 0, name: "Street level"), stationModelled: true), "modelled station, street-level edge: applies")
} else { check(false, "edge pack for review checks") }
do {
    // 5 + 9. The rider's own trip by planned departure; an empty Kante label counts as none.
    let t = Date(timeIntervalSince1970: 1_800_000_000) // "now"
    func trip(_ id: String, planned: Double, delay: Double?, quay: String) -> KanteDue {
        var d = KanteDue(tripId: id, line: .init(name: "10", category: "B", mode: "bus"), headsign: "Ostermundigen, Rüti", vias: [], quayId: nil,
                         quayLabel: quay, arr: planned + (delay ?? 0) - 20, dep: planned + (delay ?? 0), cancelled: false, approachBearing: nil,
                         state: "approaching", etaS: nil, liveInfo: nil)
        d.delayS = delay
        return d
    }
    let ten00 = trip("a", planned: t.timeIntervalSince1970 + 60, delay: nil, quay: "A")
    let ten10 = trip("b", planned: t.timeIntervalSince1970 + 660, delay: 180, quay: "B")
    let mine = VehiclePositionEvidence.dueItem(line: "10", destination: "Ostermundigen, Rüti", plannedDeparture: t.addingTimeInterval(660), in: [ten00, ten10], now: t)
    check(mine?.label == "B", "the 10:10 rider is sent to the 10:10's edge (B), even 3 min late, got \(mine?.label ?? "nil")")
    check(VehiclePositionEvidence.dueItem(line: "10", destination: "Ostermundigen, Rüti", plannedDeparture: nil, in: [ten00, ten10], now: t) == nil,
          "no planned departure and two trips: no pick")
    check(trip("c", planned: 0, delay: nil, quay: "").label == nil && trip("c", planned: 0, delay: nil, quay: " ").label == nil, "empty quay label is no label")
}
do {
    // 7. The street baseline is set once; a plane found after going down is not the street.
    var start = ARFloorHeights.updateStart(nil, cameraY: 1.4, floor: (y: 0.0, detected: false))      // fallback at street level
    start = ARFloorHeights.updateStart(start, cameraY: -4.7, floor: (y: -6.1, detected: true))        // 6.1 m down, platform found
    check(start.y == 0.0, "baseline stays at street level after descending, got \(start.y)")
    check(abs(ARFloorHeights.targetY(startFloorY: start.y, targetZ: -6.1) - (-6.1)) < 1e-9, "Europaplatz platform 1 drawn at -6.1 m, not -12.2 m")
    let refined = ARFloorHeights.updateStart(ARFloorHeights.updateStart(nil, cameraY: 1.4, floor: (y: 0.0, detected: false)),
                                             cameraY: 1.5, floor: (y: 0.08, detected: true))
    check(refined.y == 0.08 && refined.detected, "still at the starting height: a detected street floor refines the fallback")
}

// MARK: - Rect containment (float-exact CGRect.contains on Linux)

do {
    let vehicle = CGRect(x: 0.1, y: 0.2, width: 0.30000000000000004, height: 0.5)
    let display = CGRect(x: 0.15, y: 0.25, width: 0.1, height: 0.05)
    check(vehicle.encloses(display), "text box inside a float vehicle box is enclosed")
    check(!vehicle.encloses(CGRect(x: 0.35, y: 0.25, width: 0.1, height: 0.05)), "text box sticking out is not enclosed")
    let d = VehicleDetection(kind: .tram, box: vehicle, score: 0.9, mask: VehicleMask(width: 4, height: 4, pixels: [UInt8](repeating: 1, count: 16)))
    let r = VehicleTextRules.read([VehicleText(text: "9 Wabern", box: display, score: 0.95)], detection: d, otherBoxes: [], at: t0, frameID: UUID())
    check(r.line == "9" && r.destination == "wabern", "reading inside a float box is associated, got \(r.line ?? "-") \(r.destination ?? "-")")
}

// MARK: - Geo/AR alignment

struct Rng { var state: UInt64
    mutating func next() -> Double { state = state &* 6364136223846793005 &+ 1442695040888963407; return Double(state >> 11) / Double(1 << 53) }
    mutating func gaussian() -> Double { let u = max(next(), 1e-12), v = next(); return (-2 * log(u)).squareRoot() * cos(2 * .pi * v) }
}
do {
    let plane = LocalTangentPlane(origin: GeoPoint(latitude: 46.9480, longitude: 7.4474))
    let p = plane.enu(GeoPoint(latitude: 46.9489, longitude: 7.4474))
    check(abs(p.y - 100.1) < 0.5 && abs(p.x) < 1e-6, "0.0009° latitude ≈ 100 m north, got \(p)")
    let back = plane.geo(Vec2(x: 30, y: -40))
    check((plane.enu(back) - Vec2(x: 30, y: -40)).length < 1e-6, "tangent plane round trip")
}
/// Simulated walk: true AR yaw offset, compass bias, GPS noise that wanders (correlated), visual odometry exact.
func simulate(seed: UInt64, compassBias: Double, gpsSigma: Double, walk: Double) -> (yawError: Double, positionError: Double, solution: GeoARAlignment.Solution?) {
    var rng = Rng(state: seed)
    let trueYaw = 1.1, trueT = Vec2(x: 3, y: -7)
    var alignment = GeoARAlignment()
    var gpsError = Vec2(x: rng.gaussian() * gpsSigma, y: rng.gaussian() * gpsSigma)
    var time = t0
    var position = Vec2.zero
    let steps = Int(walk / 1.3)
    for step in 0...max(steps, 10) {
        if step <= steps { position = position + Vec2(x: 1.3 * cos(0.3), y: 1.3 * sin(0.3)) } // ~1.3 m/s, gentle bearing
        time = time.addingTimeInterval(1)
        // Wandering GPS error: AR(1) with a 20 s correlation time.
        gpsError = gpsError * 0.95 + Vec2(x: rng.gaussian(), y: rng.gaussian()) * (gpsSigma * 0.31)
        let ar = position.rotated(by: trueYaw) + trueT
        alignment.add(.init(at: time, ar: ar, enu: position + gpsError, accuracy: gpsSigma * 1.2))
        // Camera looks along the walk with some sway; compass reports that heading plus bias and noise.
        let view = 0.3 + rng.gaussian() * 0.2
        let heading = (90 - view * 180 / .pi) + compassBias + rng.gaussian() * 4
        alignment.add(.init(at: time, arDirection: view + trueYaw, trueHeading: heading, accuracy: 15))
    }
    guard let s = alignment.solution(at: time) else { return (.infinity, .infinity, nil) }
    let yawError = abs(atan2(sin(s.yaw - trueYaw), cos(s.yaw - trueYaw)))
    let positionError = (s.enu(position.rotated(by: trueYaw) + trueT) - position).length
    return (yawError, positionError, s)
}
do {
    var standing: [Double] = [], walked: [Double] = [], standingCovered = 0, walkedCovered = 0, n = 0
    for seed in 1...200 as ClosedRange<UInt64> {
        let bias = (Double(seed % 7) - 3) * 8 // −24°…+24° compass bias
        let a = simulate(seed: seed, compassBias: bias, gpsSigma: 5, walk: 0)
        let b = simulate(seed: seed, compassBias: bias, gpsSigma: 5, walk: 40)
        standing.append(a.yawError * 180 / .pi); walked.append(b.yawError * 180 / .pi); n += 1
        if let s = a.solution, a.yawError <= 2 * s.yawSigma { standingCovered += 1 }
        if let s = b.solution, b.yawError <= 2 * s.yawSigma { walkedCovered += 1 }
    }
    func p(_ v: [Double], _ q: Double) -> Double { let s = v.sorted(); return s[min(s.count - 1, Int(Double(s.count) * q))] }
    print(String(format: "AR alignment, 200 runs, GPS σ≈5 m, compass bias up to ±24°: yaw error median/90%% standing %.1f°/%.1f°, after 40 m walk %.1f°/%.1f°; within 2σ: %d%% / %d%%",
                 p(standing, 0.5), p(standing, 0.9), p(walked, 0.5), p(walked, 0.9), standingCovered * 100 / n, walkedCovered * 100 / n))
    check(p(walked, 0.5) < p(standing, 0.5), "walking improves yaw over a biased compass")
    check(walkedCovered * 100 / n >= 80, "reported sigma covers the true yaw error in ≥80 % of walks (2σ)")
    check(standingCovered * 100 / n >= 60, "standing: compass sigma is honest in most runs")
}
do {
    // Plan: a good alignment draws ground arrows; a poor one only a direction; none -> unavailable.
    let route = [Vec2(x: 0, y: 0), Vec2(x: 0, y: 30), Vec2(x: 20, y: 30)]
    let good = GeoARAlignment.Solution(yaw: 0.4, translation: Vec2(x: 1, y: 2), yawSigma: 3 * .pi / 180, positionSigma: 2.5, source: "combined", positionSamples: 30, pathSpan: 30)
    let camera = good.ar(Vec2(x: 0.5, y: 2))
    let plan = ARRouteGuidance.plan(route: route, target: Vec2(x: 20, y: 30), alignment: good, camera: camera, cameraDirection: .pi / 2 + 0.4)
    check(plan.mode == .path && plan.markers.count >= 15, "good alignment draws the path, got \(plan.mode) \(plan.markers.count)")
    check(plan.markers.allSatisfy { $0.distanceAlongRoute <= ARRouteGuidance.lookAhead }, "markers within look-ahead")
    let first = good.enu(plan.markers[0].ar)
    check(abs(first.x) < 0.01 && abs(first.y - 4) < 0.01, "first marker 2 m ahead on the route, got \(first)")
    let turnMarker = plan.markers.first { $0.distanceAlongRoute == 30 }
    check(turnMarker.map { abs(good.enu($0.ar).x - 2) < 0.01 } ?? false, "markers follow the corner")
    check(plan.turn.map { abs($0) < 0.2 } ?? false, "walking straight towards the route needs no turn")
    let poor = GeoARAlignment.Solution(yaw: 0.4, translation: .zero, yawSigma: 20 * .pi / 180, positionSigma: 8, source: "compass", positionSamples: 2, pathSpan: 0)
    let p2 = ARRouteGuidance.plan(route: route, target: nil, alignment: poor, camera: poor.ar(Vec2(x: 0, y: 1)), cameraDirection: 0)
    check(p2.mode == .direction && p2.markers.isEmpty, "uncertain alignment shows direction only, got \(p2.mode)")
    let bad = GeoARAlignment.Solution(yaw: 0, translation: .zero, yawSigma: 60 * .pi / 180, positionSigma: 30, source: "compass", positionSamples: 1, pathSpan: 0)
    if case .unavailable = ARRouteGuidance.plan(route: route, target: nil, alignment: bad, camera: .zero, cameraDirection: 0).mode {} else { check(false, "very poor alignment hides AR guidance") }
    let far = ARRouteGuidance.plan(route: route, target: nil, alignment: good, camera: good.ar(Vec2(x: 200, y: 0)), cameraDirection: 0)
    if case .unavailable = far.mode {} else { check(false, "far from the route: no AR path") }
}

print("\(checks - failures)/\(checks) checks passed")
exit(failures == 0 ? 0 : 1)
