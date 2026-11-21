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
    let n = DepartureDisplayMatcher.match([text("20", x: 0.1, w: 0.05), text("Bahnhof", x: 0.17)], candidates: candidates)
    check(n.outcome == .matched && n.best?.candidate.line == "20", "numeral resolves shared destination")
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
